/**
 * brain worker — the client-installable retrieval brain.
 *
 * Extracted from a single-tenant brain and genericized. Five routes:
 *
 *   GET  /health                        open
 *   GET  /api/rag/unified?q=            ranked excerpts
 *   GET  /api/rag/think?q=              cited answer + explicit gaps
 *   POST /api/admin/brain/ingest        write path, credential-gated
 *   GET  /api/admin/brain/documents     per-source counts and freshness
 *
 * Everything except /health requires X-Admin-Key.
 *
 * WHAT WAS DELIBERATELY LEFT OUT of v1: the CRM, pipeline, email tracking,
 * meeting filing, GHL sync, Stripe webhooks, OAuth sessions, and the knowledge
 * graph boost. None of that is the product. Admin-key-only auth removes the
 * entire users/sessions stack, which is the single largest simplification.
 */

import { jsonResponse, cachedJson, validateAdminKey, callLLM } from "./lib/core.js";
import { scan as scanSecrets } from "./lib/secret-scan.js";
import { storeFor, backendOf, D1 } from "./lib/store.js";
import { drainOutbox, outboxDepth, forget, reindex, coverageGaps, freshnessReport } from "./lib/store-d1.js";
import { embedText, embedTexts } from "./lib/supabase.js";

/* ------------------------------------------------------------ retrieval */

/**
 * Pull the filters out of the query string once, so both routes and both
 * storage backends see the same object.
 */
function filtersFrom(url) {
  const f = {};
  for (const k of ["source", "client", "category", "from", "to", "top_folder", "platform"]) {
    const v = url.searchParams.get(k);
    if (v) f[k] = v;
  }
  return f;
}

async function unifiedRetrieve(env, url, { matchCount, ftsCount }) {
  const q = url.searchParams.get("q");
  const rrfK = Math.min(Math.max(parseInt(url.searchParams.get("rrf_k")) || 60, 1), 1e3);

  // Which store answers is a manifest decision, not a code path the routes know
  // about. D1 plus Vectorize for a client's own Cloudflare account; Postgres
  // once a corpus outgrows the candidate depth Vectorize can offer.
  const r = await storeFor(env).search(env, {
    query: q,
    limit: matchCount,
    rrfK,
    filters: filtersFrom(url),
    weights: {
      curated: parseFloat(url.searchParams.get("weight_curated") || "1.0") || 1.0,
      drive: parseFloat(url.searchParams.get("weight_drive") || "1.0") || 1.0,
      message: parseFloat(url.searchParams.get("weight_message") || "1.0") || 1.0,
    },
  });

  return {
    matches: r.results || [],
    degraded: r.degraded,
    // A filter the backend cannot apply is surfaced, never dropped. Silently
    // ignoring `client=` returns every client's documents while looking narrowed,
    // which is a confidently wrong answer rather than a missing one.
    ignoredFilters: r.ignored_filters || [],
  };
}

// Config files, lockfiles and logs match a lot of queries and answer almost
// none of them. Demote, never drop.
//
// Each field is tested SEPARATELY on purpose: concatenating title and ref_key
// defeats the `$` end-anchor, which was the actual bug that let CLAUDE.md hold
// the number one slot in the original.
const SCAFFOLDING_RE =
  /(^|\/)(CLAUDE|AGENTS|README|CHANGELOG|CONTRIBUTING)\.md$|(^|\/)(package(-lock)?|tsconfig|composer)\.json$|\.(log|lock)$/i;

export function demoteScaffolding(results) {
  if (!Array.isArray(results) || results.length < 2) return results;
  const substantive = [];
  const scaffolding = [];
  for (const r of results) {
    const hit = SCAFFOLDING_RE.test(r.title || "") || SCAFFOLDING_RE.test(r.ref_key || "");
    (hit ? scaffolding : substantive).push(r);
  }
  return scaffolding.length ? [...substantive, ...scaffolding] : results;
}

/**
 * Reorder candidates by actual relevance.
 *
 * Falls back to the original ranking on ANY error, so search never breaks
 * because the reranker had a bad day.
 */
async function rerank(env, q, results, limit) {
  const candidates = results.slice(0, 30);
  const list = candidates
    .map((r, i) => `[${i}] (${r.source || "?"}) ${(r.title || "untitled").slice(0, 120)}\n${(r.snippet || "").replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n\n");

  const system = [
    "You rank search results by how well they answer a question.",
    "Return ONLY a JSON array like [{\"idx\":0,\"score\":9}], no prose.",
    "Score 0 to 10. A result that merely mentions a word from the question, without answering it, scores low.",
    "A near-miss on a proper noun (a similar but different name) scores 0: it is a different subject, not a weak match.",
  ].join("\n");

  try {
    const data = await callLLM(env, {
      model: env.RERANK_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system,
      label: "rag-rerank",
      timeoutMs: 8000,
      messages: [{ role: "user", content: `Question: ${q}\n\nResults:\n${list}` }],
    });
    const text = data?.content?.[0]?.text || "";
    const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    const scored = parsed
      .filter((p) => candidates[p.idx])
      .sort((a, b) => b.score - a.score)
      .map((p) => candidates[p.idx]);
    return scored.length ? scored.slice(0, limit) : results;
  } catch {
    return results;
  }
}

/**
 * Gap analysis. Zero LLM cost, computed purely from the retrieved rows.
 *
 * This is what makes the brain state what it does NOT know, and it is the
 * highest value per line in the whole system. An answer without its gaps is
 * a confident guess wearing a citation.
 */
export function computeGaps(results) {
  const gaps = [];
  const dated = results
    .map((r) => ({ t: r.ts ? Date.parse(r.ts) : NaN, source: r.source }))
    .filter((x) => Number.isFinite(x.t));

  if (dated.length) {
    const newest = dated.reduce((a, b) => (b.t > a.t ? b : a));
    const days = Math.floor((Date.now() - newest.t) / 864e5);
    if (days > 30) {
      // A Drive row carries file mtime, not content date, so a "fresh" drive
      // hit can be a sync touch rather than new content. Naming the corpus
      // keeps the heads-up honest.
      const qualifier =
        newest.source === "drive"
          ? " (a Drive file mtime, which may just be a sync touch rather than new content)"
          : "";
      gaps.push({
        type: "stale",
        days_since_newest: days,
        newest_source: newest.source || null,
        detail: `Newest source is ${days} days old (${new Date(newest.t).toISOString().slice(0, 10)}, from the ${newest.source || "unknown"} corpus)${qualifier}.`,
      });
    }
  } else {
    gaps.push({
      type: "undated",
      detail: "None of the retrieved sources carry a date, so recency cannot be judged.",
    });
  }

  // Partial undating is the common case and the easy one to miss. The rule
  // above only fires when EVERY result lacks a date, so a set that is half
  // undated reported nothing at all, and the staleness check silently ran on
  // whichever half happened to have dates. That is a confident answer drawn
  // from an unrepresentative sample, which is exactly what this engine exists
  // to prevent.
  const undated = results.length - dated.length;
  if (undated > 0 && dated.length > 0 && undated / results.length >= 0.34) {
    gaps.push({
      type: "partially_undated",
      undated_count: undated,
      total: results.length,
      detail: `${undated} of ${results.length} sources carry no date, so the recency judgement above rests only on the ${dated.length} that do.`,
    });
  }

  if (results.length < 3) {
    gaps.push({
      type: "thin_coverage",
      count: results.length,
      detail: `Only ${results.length} source${results.length === 1 ? "" : "s"} matched. Treat this as a weak signal.`,
    });
  }

  const sources = new Set(results.map((r) => r.source).filter(Boolean));
  if (sources.size === 1) {
    const only = [...sources][0];
    gaps.push({
      type: "single_corpus",
      source: only,
      detail: `Every hit came from the "${only}" corpus. Other channels may hold contradicting context.`,
    });
  }
  return gaps;
}

/* -------------------------------------------------------------- routes */

async function handleUnified(env, request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  if (!q || !q.trim()) return jsonResponse({ error: "Missing q" }, 400);

  const limit = Math.min(parseInt(url.searchParams.get("limit")) || 10, 50);
  const doRerank = url.searchParams.get("rerank") !== "0" && !!env.ANTHROPIC_API_KEY;
  const matchCount = doRerank ? Math.min(limit * 3, 50) : limit;

  const { matches: retrieved, degraded, ignoredFilters } = await unifiedRetrieve(env, url, {
    matchCount,
    ftsCount: limit,
  });
  const ignored = ignoredFilters.length ? { ignored_filters: ignoredFilters } : {};
  if (degraded === "fts") {
    return jsonResponse({ query: q, mode: "unified", degraded, ...ignored, results: retrieved });
  }

  // The drive corpus stores one row per chunk, so one file can occupy several
  // slots. Collapse before ranking, keeping the highest-ranked instance.
  let matches = retrieved;
  if (Array.isArray(matches)) {
    const byKey = new Map();
    for (const r of matches) {
      const k = `${r.source || ""}|${r.ref_key || r.drive_file_id || r.title || ""}`;
      if (!byKey.has(k)) byKey.set(k, r);
    }
    matches = [...byKey.values()];
  }

  if (doRerank && Array.isArray(matches) && matches.length > 1) {
    matches = await rerank(env, q, matches, limit);
  }
  // Last, because the reranker re-sorts by its own scores and would undo it.
  matches = demoteScaffolding(matches);
  if (Array.isArray(matches)) matches = matches.slice(0, limit);

  return jsonResponse({
    query: q, mode: "unified", reranked: doRerank,
    degraded: degraded || undefined, ...ignored, results: matches,
  });
}

async function handleThink(env, request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return jsonResponse({ error: "Missing q" }, 400);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit")) || 8, 1), 20);

  const { matches, degraded, ignoredFilters } = await unifiedRetrieve(env, url, {
    matchCount: Math.min(limit * 3, 40),
    ftsCount: limit,
  });
  const results = Array.isArray(matches) ? matches : [];

  if (results.length === 0) {
    return jsonResponse({
      query: q,
      mode: "think",
      degraded: degraded || undefined,
      answer: null,
      citations: [],
      results: [],
      gaps: [
        {
          type: "no_results",
          detail: "The brain has nothing on this query. Say so plainly rather than inferring.",
        },
      ],
    });
  }

  const gaps = computeGaps(results);

  // Coverage staleness goes in FRONT of the content gaps, because it qualifies
  // all of them. "The newest thing I found is 40 days old" reads very
  // differently once you know the source has not been read since July: the first
  // is a fact about the corpus, the second is a fact about our blind spot.
  try {
    const cov = await coverageGaps(env);
    if (cov.length) gaps.unshift(...cov);
  } catch { /* an answer must never fail because the freshness check did */ }

  // An unapplied filter belongs in the gaps, not in a footnote. The reader is
  // about to trust an answer they believe was scoped to one client.
  if (ignoredFilters.length) {
    gaps.unshift({
      type: "filter_not_applied",
      filters: ignoredFilters,
      detail: `This brain cannot filter by ${ignoredFilters.join(" or ")}, so the results below are NOT narrowed by it.`,
    });
  }
  if (degraded === "vector") {
    gaps.unshift({
      type: "vector_unavailable",
      detail: "The vector index did not answer, so these results are keyword matches only. Anything phrased differently from the question was not found.",
    });
  }
  const docs = results.slice(0, 12).map((r, i) => ({
    n: i + 1,
    title: (r.title || "untitled").slice(0, 140),
    source: r.source || "?",
    client: r.client || null,
    ts: r.ts || null,
    ref: r.ref_key || r.drive_file_id || null,
    snippet: (r.snippet || "").replace(/\s+/g, " ").slice(0, 900),
  }));

  // Owner name is templated per install. This is the line that was hardcoded
  // to "James Guldan" in the original and would otherwise ship to every client.
  const owner = env.BRAIN_OWNER || "the owner";
  const system = [
    `You are ${owner}'s second brain. You answer questions using ONLY the numbered documents provided.`,
    "",
    "Rules:",
    "1. Answer directly. Two to six sentences, or a short list when the answer genuinely is a list.",
    "2. Cite every factual claim inline with its document number in square brackets, like [3].",
    "3. Never invent a name, date, number, commitment, or quote that is not in the documents.",
    "4. If the documents do not actually answer the question, say so plainly in one sentence. Do not pad.",
    "5. Do not restate the question and do not open with filler like \"Based on the documents\".",
    env.BRAIN_STYLE_RULE || "",
  ]
    .filter(Boolean)
    .join("\n");

  const docBlock = docs
    .map((d) => {
      const meta = [d.source, d.client ? `client: ${d.client}` : null, d.ts ? String(d.ts).slice(0, 10) : null]
        .filter(Boolean)
        .join(", ");
      return `[${d.n}] (${meta}) ${d.title}\n${d.snippet}`;
    })
    .join("\n\n");
  const gapBlock = gaps.length ? gaps.map((g) => `- ${g.detail}`).join("\n") : "- none detected";
  const userMsg = `Question: ${q}\n\nDOCUMENTS:\n${docBlock}\n\nKNOWN GAPS (computed from the data, not inferred, do not contradict these):\n${gapBlock}\n\nWrite the answer. Then, only if one of the gaps above materially affects how much the reader should trust that answer, add a final line starting with "Heads up:" naming that one gap in a single sentence. If none do, omit the Heads up line entirely.`;

  let answer = null;
  let answerError = null;
  let model = null;
  try {
    const data = await callLLM(env, {
      model: env.ANSWER_MODEL || "claude-sonnet-4-5",
      max_tokens: 1000,
      system,
      label: "rag-think",
      timeoutMs: 45_000,
      messages: [{ role: "user", content: userMsg }],
    });
    answer = (data?.content?.[0]?.text || "").trim() || null;
    model = data?.model || null;
  } catch (e) {
    answerError = e.no_key
      ? "no LLM key configured"
      : e.llm_cap_exceeded
        ? "daily LLM spend cap reached"
        : e.message;
  }

  return jsonResponse({
    query: q,
    mode: "think",
    degraded: degraded || undefined,
    answer,
    answer_error: answerError || undefined,
    model: model || undefined,
    gaps,
    citations: docs.map((d) => ({ n: d.n, title: d.title, source: d.source, ref: d.ref, ts: d.ts })),
    results: results.slice(0, limit),
  });
}

async function handleIngest(env, request) {
  // Checked BEFORE the body is read. The batch route documents exactly this
  // hazard and guards against it; this route, which is the one a client reaches
  // for when testing by hand, had no guard at all. A 40MB document becomes
  // ~27,000 chunks and ~54,000 statements in one D1 batch, the Worker is killed
  // on CPU, and the caller gets Cloudflare's own HTML error page instead of
  // anything this code could explain.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > BATCH_MAX_BYTES) {
    return jsonResponse(
      {
        error: `document too large: ${declared} bytes (max ${BATCH_MAX_BYTES})`,
        max_bytes: BATCH_MAX_BYTES,
        detail: "Split it before sending. The ingest CLI does this automatically.",
      },
      413
    );
  }

  let envelope;
  try {
    envelope = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  // Content-Length can be absent or wrong, so the parsed size is checked too.
  // In BYTES: a CJK corpus is three bytes per character and would clear a
  // length check while being three times over the real limit.
  const actual = new TextEncoder().encode(String(envelope?.content ?? "")).length;
  if (actual > BATCH_MAX_BYTES) {
    return jsonResponse(
      { error: `document too large: ${actual} bytes (max ${BATCH_MAX_BYTES})`, max_bytes: BATCH_MAX_BYTES },
      413
    );
  }

  const { source_type, source_id, content } = envelope || {};
  if (!source_type || !source_id || typeof content !== "string") {
    return jsonResponse({ error: "source_type, source_id and content (string) are required" }, 400);
  }

  // THE GATE. Nothing carrying a live provider credential enters the index,
  // whichever door it arrives through. Named, never quoted: the refusal must
  // be actionable without becoming its own leak.
  if (env.CREDENTIAL_SCANNER !== "off") {
    const secrets = scanSecrets(content);
    if (secrets.shouldRefuse) {
      return jsonResponse(
        {
          error: "refused: content carries live credential(s)",
          labels: secrets.labels,
          detail: "Rotate them, strip them from the source, then re-ingest. Nothing was written.",
        },
        422
      );
    }
  }

  const out = await storeFor(env).ingest(env, envelope);
  if (!out || (!out.doc_uid && !out.brain_doc_id)) {
    return jsonResponse({ error: "ingest returned no row" }, 500);
  }
  return jsonResponse(out);
}

/**
 * Batch ingest.
 *
 * Exists because the single-document route means one HTTPS round trip per file,
 * and a real corpus is tens of thousands of files. At ~150ms of round trip each,
 * 68,000 documents is close to three hours of pure latency before any work
 * happens. Batching collapses that.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *
 * It is NOT transactional. Documents are written as they are processed, so a
 * failure at document 30 leaves 1..29 committed. That is the correct behaviour
 * for a resumable bulk load: the caller gets a per-document result and restarts
 * from where it stopped, rather than re-sending work that already succeeded.
 *
 * It does NOT fail the batch on one bad document. A single file carrying a
 * credential, or one that throws, is reported in its own slot and the rest
 * proceed. Rejecting 49 good documents because of one is how a bulk load turns
 * into an afternoon.
 *
 * It does NOT accept unbounded input. A Worker has a real CPU and memory budget,
 * and chunking plus hashing a huge payload will be killed mid-batch, which looks
 * exactly like data loss to whoever is watching.
 */
const BATCH_MAX_DOCS = 50;
const BATCH_MAX_BYTES = 1_000_000;

async function handleIngestBatch(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const docs = body && Array.isArray(body.docs) ? body.docs : null;
  if (!docs) return jsonResponse({ error: "body must be { docs: [...] }" }, 400);
  if (!docs.length) return jsonResponse({ error: "docs is empty" }, 400);
  if (docs.length > BATCH_MAX_DOCS) {
    return jsonResponse(
      { error: `too many documents: ${docs.length} (max ${BATCH_MAX_DOCS})`, max_docs: BATCH_MAX_DOCS },
      413
    );
  }

  // BYTES, not characters. String.length undercounts by 3x on CJK and by 2x on
  // accented European text, so a batch could measure under the cap and still be
  // refused by the platform.
  const enc = new TextEncoder();
  const bytes = docs.reduce((n, d) => n + (typeof d?.content === "string" ? enc.encode(d.content).length : 0), 0);
  if (bytes > BATCH_MAX_BYTES) {
    return jsonResponse(
      {
        error: `batch too large: ${bytes} bytes (max ${BATCH_MAX_BYTES})`,
        max_bytes: BATCH_MAX_BYTES,
        detail: "Send fewer documents per call. A single document over this size should be split by the client.",
      },
      413
    );
  }

  const store = storeFor(env);
  const scannerOn = env.CREDENTIAL_SCANNER !== "off";
  const results = [];
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };

  for (const envelope of docs) {
    const ref = envelope && envelope.source_id != null ? String(envelope.source_id) : null;
    const slot = { source_id: ref, source_type: envelope?.source_type ?? null };

    if (!envelope?.source_type || envelope.source_id == null || typeof envelope.content !== "string") {
      tally.failed++;
      results.push({ ...slot, status: "failed", error: "source_type, source_id and content (string) are required" });
      continue;
    }

    if (scannerOn) {
      const secrets = scanSecrets(envelope.content);
      if (secrets.shouldRefuse) {
        tally.refused++;
        // Named, never quoted. The refusal has to be actionable without becoming
        // its own copy of the credential.
        results.push({ ...slot, status: "refused", labels: secrets.labels });
        continue;
      }
    }

    try {
      const out = await store.ingest(env, envelope);
      const action = out.action || "created";
      if (tally[action] !== undefined) tally[action]++;
      results.push({ ...slot, status: action, chunks: out.chunks ?? null, doc_uid: out.doc_uid ?? out.brain_doc_id ?? null });
    } catch (e) {
      tally.failed++;
      results.push({ ...slot, status: "failed", error: String(e.message || e).slice(0, 300) });
    }
  }

  return jsonResponse({ ...tally, total: docs.length, results });
}

async function handleDocuments(env) {
  const { rows } = await storeFor(env).stats(env);
  const out = { backend: backendOf(env), rows: rows || [] };
  if (backendOf(env) === D1) {
    // How far the vector index trails the text. A brain whose outbox is not
    // draining still answers keyword queries, which is exactly why the number
    // has to be visible rather than inferred from search feeling worse.
    try {
      out.vector_backlog = await outboxDepth(env);
    } catch (e) {
      out.vector_backlog = { error: e.message };
    }
  }
  return jsonResponse(out);
}

/* -------------------------------------------------------------- router */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return jsonResponse({
        ok: true,
        brain: env.BRAIN_NAME || "brain",
        version: env.BRAIN_VERSION || "0.1.0",
        ts: new Date().toISOString(),
      });
    }

    if (!validateAdminKey(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    try {
      if (path === "/api/rag/unified" && request.method === "GET") {
        return await cachedJson(request, env, ctx, 120, () => handleUnified(env, request));
      }
      if (path === "/api/rag/think" && request.method === "GET") {
        return await cachedJson(request, env, ctx, 300, () => handleThink(env, request));
      }
      if (path === "/api/admin/brain/ingest" && request.method === "POST") {
        return await handleIngest(env, request);
      }
      if (path === "/api/admin/brain/ingest/batch" && request.method === "POST") {
        return await handleIngestBatch(env, request);
      }
      if (path === "/api/admin/brain/documents" && request.method === "GET") {
        return await handleDocuments(env);
      }
      // Per-source freshness. Separate from /documents on purpose: that endpoint
      // answers "how much is in here", this one answers "how much of it is
      // current", and conflating them is how staleness stayed invisible.
      if (path === "/api/admin/brain/freshness" && request.method === "GET") {
        if (backendOf(env) !== D1) return jsonResponse({ error: "freshness applies to the d1 backend only" }, 400);
        return jsonResponse(await freshnessReport(env));
      }
      /**
       * Remove documents. DRY RUN BY DEFAULT.
       *
       * The undo has been promised in four client-facing documents and has never
       * worked on this backend. It also gates the Drive connector, which detects
       * deletions it could not act on, leaving the brain answering from material
       * the client believes they removed.
       */
      if (path === "/api/admin/brain/forget" && request.method === "POST") {
        if (backendOf(env) !== D1) return jsonResponse({ error: "forget applies to the d1 backend only" }, 400);
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "invalid JSON body" }, 400);
        }
        const docUids = Array.isArray(body?.doc_uids) ? body.doc_uids.map(String) : [];
        const source = body?.source ? String(body.source) : null;
        if (!docUids.length && !source) {
          return jsonResponse({ error: "pass doc_uids: [...] or source: \"name\"" }, 400);
        }
        // Destructive and irreversible, so it must be asked for explicitly.
        const confirm = body?.confirm === true;
        const r = await forget(env, { docUids, source, dryRun: !confirm });
        return jsonResponse(r);
      }

      // Force a drain. The cron normally does this, but when the cron is wedged
      // the backlog only clears by hand, and the alternative for whoever is
      // holding the pager is waiting and hoping.
      if (path === "/api/admin/brain/reindex" && request.method === "POST") {
        if (backendOf(env) !== D1) return jsonResponse({ error: "reindex applies to the d1 backend only" }, 400);
        const body = await request.json().catch(() => ({}));
        const r = await reindex(env, { source: body.source || null, dryRun: body.confirm !== true });
        return jsonResponse(r);
      }
      if (path === "/api/admin/brain/drain" && request.method === "POST") {
        if (backendOf(env) !== D1) return jsonResponse({ error: "drain applies to the d1 backend only" }, 400);
        let total = 0;
        let remaining = 0;
        for (let i = 0; i < 10; i++) {
          const r = await drainOutbox(env, { embed: (text) => embedText(env, text), embedBatch: (texts) => embedTexts(env, texts) });
          total += r.drained;
          remaining = r.remaining;
          if (!r.drained || !r.remaining) break;
        }
        return jsonResponse({ drained: total, remaining });
      }
      return jsonResponse({ error: "not found" }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  },

  /**
   * Drain the vector outbox.
   *
   * The write path deliberately does NOT embed inline: Vectorize acknowledges a
   * write before the index reflects it, so doing it in the request would make an
   * ingest look complete while the chunk is still unfindable. Here it is a queue
   * that visibly empties, and a failure leaves the rows in place to retry rather
   * than losing them.
   */
  async scheduled(event, env, ctx) {
    if (backendOf(env) !== D1) return;
    ctx.waitUntil(
      (async () => {
        let total = 0;
        // Bounded, because a Worker invocation has a wall clock and an unbounded
        // loop on a large backfill would be killed mid-batch every time.
        for (let i = 0; i < 10; i++) {
          const r = await drainOutbox(env, { embed: (text) => embedText(env, text), embedBatch: (texts) => embedTexts(env, texts) });
          total += r.drained;
          if (!r.drained || !r.remaining) break;
        }
        if (total) console.log(`vector outbox: drained ${total}`);
      })()
    );
  },
};
