#!/usr/bin/env node
/**
 * brain-mcp — puts a client's brain in the tool menu of every AI coding
 * session on their machine, in every directory.
 *
 * Generalized from a single-tenant version built for one person's own brain.
 * Nothing here is specific to one install: endpoint, credential, and display
 * name all come from configuration.
 *
 * CONFIGURATION, in resolution order:
 *
 *   1. BRAIN_URL, BRAIN_NAME, and an absolute BRAIN_MANIFEST locator. The
 *      current key is read from that manifest's validated durable storage.
 *   2. Legacy BRAIN_KEY or JSON config values, only when BRAIN_MANIFEST is
 *      absent. New installer output never writes a literal key into MCP config.
 *   3. A JSON config file at BRAIN_CONFIG, or ~/.brain/config.json:
 *        { "url": "https://brain.acme.com", "name": "acme",
 *          "key_env": "ACME_BRAIN_KEY",
 *          "key_keychain": { "account": "acme-brain", "service": "admin-key" } }
 *   4. macOS Keychain, when legacy key_keychain is configured.
 *
 * Cross-platform matters: the first client install runs on Windows, where
 * there is no `security` binary. The Keychain path is a macOS convenience,
 * never a requirement, and the server fails with an instruction rather than a
 * stack trace when no credential resolves.
 *
 * Zero dependencies. Node 22+ (matches the installer runtime requirement).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAdminKeyFromKeychain } from "../operations/admin-key-persistence.mjs";
import {
  createBrainCredentialResolver,
  fetchWithBrainCredential,
} from "./brain-mcp-runtime.mjs";
import {
  retrievalUnavailable, unavailableGap, unavailableNotice,
} from "../worker/src/lib/retrieval-status.js";
import { describeFailures, responseIncomplete } from "../worker/src/lib/failure.js";

const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 120_000;
// One inventory call walks at most this much of the corpus. 500 is the worker's own
// default page size for source families; ten pages keeps a chat-latency ceiling on
// a corpus of any size, and anything past it is reported as a floor, never a total.
const INVENTORY_PAGE_LIMIT = 500;
const INVENTORY_MAX_PAGES = 10;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

function loadConfig() {
  const explicit = process.env.BRAIN_CONFIG;
  const fallback = join(homedir(), ".brain", "config.json");
  for (const p of [explicit, fallback]) {
    if (!p) continue;
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      /* keep looking */
    }
  }
  return {};
}

const CFG = loadConfig();
const BASE = (process.env.BRAIN_URL || CFG.url || "").replace(/\/+$/, "");
const NAME = process.env.BRAIN_NAME || CFG.name || "brain";
const OWNER = CFG.owner || CFG.display_name || "the owner";

if (!BASE) {
  process.stderr.write(
    "brain-mcp: no endpoint configured. Set BRAIN_URL, or create ~/.brain/config.json with a \"url\" field.\n"
  );
  process.exit(1);
}

function legacyCredential() {
  // Legacy only. A BRAIN_MANIFEST resolver always wins before this function is
  // called, even if an old registration temporarily contains both forms.
  const direct = process.env.BRAIN_KEY;
  if (direct) return direct;

  if (CFG.key_env && process.env[CFG.key_env]) {
    return process.env[CFG.key_env];
  }

  if (CFG.key_keychain && process.platform === "darwin") {
    const { account, service } = CFG.key_keychain;
    const value = readAdminKeyFromKeychain(
      { backend: "keychain", account, service },
      { environment: process.env },
    );
    if (value) return value;
  }

  return null;
}

const CREDENTIALS = createBrainCredentialResolver({
  environment: process.env,
  legacyCredential,
});

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

async function call(path, { method = "GET", body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchWithBrainCredential(fetch, BASE + path, {
      method,
      headers: {
        "User-Agent": UA,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    }, CREDENTIALS);
    const text = CREDENTIALS.redact(await res.text());
    if (!res.ok) {
      const hint = text.includes("1010")
        ? " (a bot-protection rule rejected the request; the User-Agent header is the usual cause)"
        : res.status === 401 || res.status === 403
          ? " (the credential was rejected; check it has not expired or been rotated)"
          : "";
      throw new Error(`${method} ${path} -> HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* the remember contract                                               */
/* ------------------------------------------------------------------ */

const CONFIDENCE = ["verified", "inferred", "unverified"];
const MIN_BODY = 40;
const OVERGENERALISED =
  /\b(always|every ?time|never fails?|keeps? failing|invariably|in every case|without fail)\b/i;
const VOLATILE =
  /(\$[\d,]+|\b\d[\d,._]*\s*(%|users?|customers?|clients?|leads?|per month|\/mo|per day|\/day)\b)/i;
const DATE_ANCHOR = /\bas of\b|\b\d{4}-\d{2}-\d{2}\b/i;

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
  "lesson";
const today = () => new Date().toISOString().slice(0, 10);

function validateLesson(input) {
  const errors = [];
  const warnings = [];
  const title = String(input?.title ?? "").trim();
  const body = String(input?.body ?? "").trim();
  if (!title) errors.push("title is required");
  if (body.length < MIN_BODY)
    errors.push(
      `body must be at least ${MIN_BODY} characters. A lesson too short to state its own conditions cannot be applied later.`
    );

  let confidence = String(input?.confidence ?? "").trim();
  if (!CONFIDENCE.includes(confidence))
    errors.push(`confidence must be one of: ${CONFIDENCE.join(" | ")}`);

  const verification = input?.verification ? String(input.verification).trim() : null;
  if (confidence === "verified" && !verification)
    errors.push(
      'confidence is "verified" but no verification was given. Say how you know. If you cannot, the honest value is "inferred".'
    );

  if (errors.length) return { ok: false, errors, warnings, value: null };

  const claimed = confidence;
  if (OVERGENERALISED.test(body) && confidence === "verified") {
    confidence = "inferred";
    warnings.push(
      'body generalises over occurrences, and one session sees one occurrence. Confidence capped at "inferred".'
    );
  }
  let volatile = false;
  if (VOLATILE.test(body) && !DATE_ANCHOR.test(body)) {
    volatile = true;
    warnings.push(
      `body states a figure that rots with no date anchor. Tagged volatile and stamped "as of ${today()}".`
    );
  }

  const slug = slugify(input?.slug || title);
  return {
    ok: true,
    errors,
    warnings,
    value: {
      slug,
      source_id: `lesson/${slug}`,
      title,
      body,
      confidence,
      claimed_confidence: claimed === confidence ? null : claimed,
      verification,
      volatile,
      supersedes: input?.supersedes ? String(input.supersedes).trim() : null,
      tags: Array.isArray(input?.tags) ? input.tags.map(String).filter(Boolean) : [],
    },
  };
}

function renderLesson(v) {
  const lines = [`# ${v.title}`, "", v.body, "", "---", `Confidence: ${v.confidence}`];
  if (v.claimed_confidence)
    lines.push(`Claimed confidence: ${v.claimed_confidence} (downgraded at write time)`);
  if (v.verification) lines.push(`Verification: ${v.verification}`);
  if (v.volatile) lines.push(`Volatile: yes, as of ${today()}`);
  if (v.supersedes) lines.push(`Supersedes: ${v.supersedes}`);
  if (v.tags.length) lines.push(`Tags: ${v.tags.join(", ")}`);
  lines.push(`Recorded: ${today()}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

// THE READ-ONLY BOUNDARY. Read this before adding a tool to the list below.
//
// This process resolves the FULL admin key, not a read-scoped one. The Worker
// gates every admin route behind that one credential, and this file calls a
// handful of them. The TOOLS array is therefore not a menu of conveniences: it
// is the only thing standing between the host model and forget, reindex,
// drain, refit, bootstrap, ingest/batch and auth/invite.
//
// The objection to keeping the boundary is fair and still loses. A host agent
// with a shell can read the key off disk and curl those routes itself, so this
// list is not a privilege boundary. What it is, is the APPROVAL surface, and
// two facts make that worth defending:
//
//   1. A shell `curl` to a destructive endpoint reads as a suspicious Bash
//      call the owner can refuse. A tool named for the thing they were just
//      asked to approve does not.
//   2. Prompt injection is live, not theoretical. brain_search returns 900
//      character excerpts of the owner's own documents and mail straight into
//      the host model's context. Give that same model a delete tool and one
//      hostile document becomes a delete primitive. `forget` dry-runs unless
//      confirm:true, and that guard sits in the request BODY, where a tool
//      wrapper can set it and silently defeat it.
//
// So every tool here is READ-ONLY, with the single pre-existing exception of
// brain_remember, which writes one contract-validated lesson and nothing else.
//
// Write and repair tools (ingest a folder, refresh a connector, drain,
// reindex) wait on a credential this process cannot yet resolve: an
// independently rotatable read-only key. operations/rag-proxy-key.mjs names
// the same unfinished work, and until it lands, rotating away from a
// compromised MCP process means rotating the key wired into every MCP config
// on the machine. Until then the honest way to let the model act is to RETURN
// THE COMMAND AS A STRING for the owner to run, the posture cmdMcpConfig
// already takes. brain_forget stays off this list permanently.

const TOOLS = [
  {
    name: "brain_think",
    description:
      "START HERE for any question about this organisation's people, clients, decisions, commitments, projects or history. Searches every connected source and returns a CITED answer plus an explicit list of what the brain is missing. The gaps array is the point: relay it whenever it affects confidence. If search_status is \"search_unavailable\", the search did not run and an empty result proves nothing about the corpus: never report it as the brain having nothing.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "The question, in natural language." },
        limit: { type: "number", description: "Sources to retrieve. Default 8." },
        source: { type: "string", description: "Narrow to one corpus." },
      },
      required: ["q"],
    },
  },
  {
    name: "brain_search",
    description:
      "Raw ranked excerpts instead of a written answer. Use when you want to skim source material yourself, need more hits than an answer would cite, or brain_think returned nothing. A zero count with search_status \"search_unavailable\" means the search did not run, not that the corpus is empty.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        limit: { type: "number" },
        source: { type: "string" },
        category: { type: "string", description: 'Use "lesson" to read only recorded lessons.' },
      },
      required: ["q"],
    },
  },
  {
    name: "brain_remember",
    description:
      "Record a durable lesson so the next session inherits it. Call this the moment a session produces one. Enforces a contract and will refuse or downgrade a weak claim rather than accept it silently: verified requires stated verification, single-observation claims cannot present as patterns, and figures that rot need a date anchor.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line stating the lesson itself, not the topic." },
        body: { type: "string", description: "The lesson with its conditions. Minimum 40 characters." },
        confidence: { type: "string", enum: ["verified", "inferred", "unverified"] },
        verification: { type: "string", description: 'Required when confidence is "verified".' },
        supersedes: { type: "string", description: "source_id of the record this corrects." },
        tags: { type: "array", items: { type: "string" } },
        slug: { type: "string" },
      },
      required: ["title", "body", "confidence"],
    },
  },
  {
    name: "brain_health",
    description:
      "Is the wiring intact and the data fresh? Every failure in this layer looks identical from outside (no results); this tells an empty answer apart from a broken pipe or a stale corpus. It CANNOT see whether the brain is accepting documents: a paused upgrade refuses every write while these counts still read perfectly normally. Call brain_install_state for that.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_install_state",
    description:
      "Can this install do its job right now, and will it accept a document? Call it before reporting an install healthy, before loading anything, and first whenever something is not working. It reports the version and, the reason it exists, whether corpus writes are PAUSED: a half-finished upgrade refuses every ingest with HTTP 503 while brain_health reports normal counts, so this is the only tool that can see that state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_sources",
    description:
      "Every source registered in this brain: what kind it is, how many documents it holds, when it was last read, and whether that is on schedule. This is the starting point for setting up or narrating an install, because it already knows which connectors exist and which are absent, so ask about what is missing instead of asking the owner to describe an install this tool can see. An empty list carrying sources_status \"unavailable\" means the source table could not be read, which is NOT the same finding as nothing being connected.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_diagnose",
    description:
      "What is missing from this brain, or stored wrong, or stored wastefully. Answers \"is what is in here correct and complete\", which health counts cannot: every failure this product has had in the field was silent. Each finding carries the action that fixes it, so read the critical ones out rather than summarising them away.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_inventory",
    description:
      "How many distinct real-world documents are actually in here, counted as families so an oversized file split into parts, or one chat export split into conversations, counts once. Use it to play back what a load produced. Pass a source name from brain_sources for a per-source inventory. When complete is false the number is a floor and not a total: say \"at least N\" and pass next_cursor back to continue.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "One registered source name. Omit to inventory the whole corpus.",
        },
        cursor: {
          type: "string",
          description: "next_cursor from a previous incomplete call, to continue the walk.",
        },
      },
    },
  },
];

async function runTool(name, args = {}) {
  switch (name) {
    case "brain_think": {
      const d = await call("/api/rag/think", {
        method: "POST",
        body: { q: args.q, limit: args.limit ?? 8, source: args.source },
      });
      // A degraded search is the ONLY thing separating "the brain holds
      // nothing" from "the brain was not fully read", so it rides out on every
      // response that has it, answered or not. Without it this tool hands the
      // model an empty result and no way to tell the two apart.
      const unavailable = retrievalUnavailable(d);
      const out = {
        answer: d.answer ?? null,
        answer_error: d.answer_error ?? undefined,
        degraded: d.degraded ?? undefined,
        search_status: unavailable ? "search_unavailable" : undefined,
        gaps: d.gaps ?? [],
        citations: d.citations ?? [],
      };
      if (!d.answer) {
        out.results = (d.results ?? []).map((r) => ({
          title: r.title,
          ts: r.ts,
          snippet: String(r.snippet ?? "").slice(0, 700),
        }));
      }
      if (unavailable) {
        // Deliberately rewritten rather than appended. A brain deployed before
        // the worker learned this distinction still sends the old no_results
        // gap, whose text instructs the model to state an absence — the exact
        // false negative this guards against. Replacing it means an older
        // worker plus a current MCP is safe.
        out.gaps = [
          unavailableGap(d.degraded),
          ...out.gaps.filter((gap) => gap?.type !== "no_results"),
        ];
        out.note = unavailableNotice(d.degraded) +
          " Do NOT report this as the brain having nothing on the question. Report that the search could not be completed, name the cause, and offer to retry.";
      } else if (!out.citations.length && !out.results?.length) {
        out.note =
          "The brain has nothing on this. Report that as the finding, in those terms. Do not substitute inference.";
      }
      return out;
    }
    case "brain_search": {
      const d = await call("/api/rag/unified", {
        method: "POST",
        body: {
          q: args.q,
          limit: args.limit ?? 10,
          source: args.source,
          category: args.category,
        },
      });
      const rows = d.results ?? [];
      // Same hazard on the raw-excerpt tool: zero rows out of a half-run search
      // is not evidence of an empty corpus, and this note is what the model
      // acts on.
      const unavailable = retrievalUnavailable({ ...d, results: rows });
      return {
        count: rows.length,
        degraded: d.degraded ?? undefined,
        search_status: unavailable ? "search_unavailable" : undefined,
        results: rows.map((r) => ({
          source: r.source,
          title: r.title,
          category: r.category,
          ts: r.ts,
          snippet: String(r.snippet ?? "").slice(0, 900),
        })),
        ...(unavailable
          ? {
            note: unavailableNotice(d.degraded) +
              ' Do NOT report "nothing recorded on this". Report that the search could not be completed.',
          }
          : rows.length
            ? {}
            : { note: 'No hits. Report "nothing recorded on this" rather than inferring.' }),
      };
    }
    case "brain_remember": {
      const v = validateLesson(args);
      if (!v.ok) {
        return {
          written: false,
          refused: true,
          errors: v.errors,
          note: "Nothing was written. A memory store that accepts anything degrades into confident-sounding guesses.",
        };
      }
      const L = v.value;
      const res = await call("/api/admin/brain/ingest", {
        method: "POST",
        body: {
          source_type: "curated",
          source_id: L.source_id,
          title: L.title,
          content: renderLesson(L),
          occurred_at: new Date().toISOString(),
          metadata: {
            category: "lesson",
            confidence: L.confidence,
            ...(L.claimed_confidence ? { claimed_confidence: L.claimed_confidence } : {}),
            ...(L.verification ? { verification: L.verification } : {}),
            ...(L.volatile ? { volatile: true, as_of: today() } : {}),
            ...(L.supersedes ? { supersedes: L.supersedes } : {}),
            ...(L.tags.length ? { tags: L.tags } : {}),
          },
        },
      });
      return {
        written: true,
        source_id: L.source_id,
        action: res.action,
        confidence: L.confidence,
        ...(L.claimed_confidence ? { downgraded_from: L.claimed_confidence } : {}),
        ...(v.warnings.length ? { warnings: v.warnings } : {}),
      };
    }
    case "brain_health": {
      // A worker on the response contract answers 503 here when a subsystem it
      // reads could not be queried, and `call` already throws on that, so the
      // model is told rather than misled. A worker deployed BEFORE the contract
      // reports the identical failure as a 200 with the error nested in the
      // body, and this tool would hand the model row counts that read as a
      // healthy brain. The client machine running this server is routinely
      // newer than the brain it points at, so it defends itself.
      const d = await call("/api/admin/brain/documents");
      if (responseIncomplete(d)) {
        return {
          ...d,
          health_status: "incomplete",
          health_note:
            "This brain could not report part of its own state (" +
            (describeFailures(d) || "reason not given") +
            "). The counts above are partial. Do NOT report this brain as healthy, " +
            "and do not treat a low or zero count here as evidence that something " +
            "is absent from the owner's records.",
        };
      }
      return d;
    }
    case "brain_install_state": {
      const d = await call("/health");
      // Three states, not two, because an older Worker predates the field that
      // reports this and answering for it would be inventing the answer.
      const declared = typeof d.accepting_documents === "boolean" ? d.accepting_documents : null;
      const pausedSignal = d.status === "paused-for-upgrade" ||
        d.vector_drain_mode === "paused-for-upgrade" ||
        d.ok === false;
      const paused = declared === false || pausedSignal;
      const out = {
        brain: d.brain ?? null,
        version: d.version ?? null,
        status: d.status ?? null,
        accepting_documents: paused ? false : declared,
        vector_drain_mode: d.vector_drain_mode ?? null,
        checked_at: d.ts ?? new Date().toISOString(),
      };
      if (paused) {
        // THE BLIND SPOT THIS TOOL EXISTS FOR. /api/admin/brain/ingest is one
        // of the paused corpus-mutation paths, so brain_remember and every
        // loader get HTTP 503 here, while brain_health keeps returning the
        // document counts that were already there and looks entirely well. An
        // assistant reading health alone tells the owner their brain is fine
        // while it cannot accept a single document.
        out.writes_paused = true;
        out.note = "This brain is NOT accepting documents. A paused upgrade refuses every " +
          "write with HTTP 503, so anything loaded now is refused rather than stored. Say " +
          "that before loading anything, and do NOT report this install healthy on the " +
          "strength of brain_health: document counts read normally in exactly this state." +
          (d.reason ? " The brain's own reason: " + String(d.reason) : "");
      } else if (declared === null) {
        out.writes_paused = null;
        out.note = "This brain is older than the field that reports whether it is accepting " +
          "documents, so its write state is UNKNOWN. Do not report it either way. Loading " +
          "something and reading the result is the only way to find out from here.";
      } else {
        out.writes_paused = false;
      }
      return out;
    }
    case "brain_sources": {
      const d = await call("/api/admin/brain/freshness");
      // An empty list means two opposite things and the worker distinguishes
      // them, so this must too: `unavailable` is the source table failing to
      // read, and reporting that as "nothing is connected" would be stating an
      // absence we cannot prove.
      if (d.unavailable) {
        return {
          sources_status: "unavailable",
          count: null,
          sources: [],
          note: "The source list could not be read, so this is NOT a finding that nothing " +
            "is connected. Report that the check did not run, and retry.",
        };
      }
      const rows = Array.isArray(d.sources) ? d.sources : [];
      const byState = {};
      for (const s of rows) byState[s.state] = (byState[s.state] || 0) + 1;
      const attention = rows
        .filter((s) => ["broken", "stale", "never_synced"].includes(s.state))
        .map((s) => ({
          name: s.name,
          state: s.state,
          reason: s.reason ?? null,
          days_since_ingest: s.days_since_ingest ?? null,
        }));
      const out = {
        sources_status: "ok",
        count: rows.length,
        by_state: byState,
        sources: rows,
        needs_attention: attention,
      };
      if (!rows.length) {
        out.note = "The source table read cleanly and is empty: nothing has been connected " +
          "to this brain yet. That IS the finding.";
      } else if (attention.length) {
        out.note = `${attention.length} source(s) are not current. A source that stopped ` +
          "being read looks exactly like a source with nothing new in it, so material added " +
          "since then is missing from answers without ever showing up as a missing answer.";
      }
      return out;
    }
    case "brain_diagnose": {
      const d = await call("/api/admin/brain/diagnose");
      const rank = { crit: 0, warn: 1, info: 2, ok: 3 };
      const findings = (Array.isArray(d.findings) ? [...d.findings] : [])
        .sort((a, b) => (rank[a?.severity] ?? 9) - (rank[b?.severity] ?? 9));
      const crit = Number(d.summary?.crit || 0);
      return {
        verdict: d.verdict ?? null,
        totals: d.totals ?? null,
        summary: d.summary ?? null,
        findings,
        note: crit
          ? `${crit} critical finding(s). Every finding carries an action; read the critical ` +
            "ones out in the owner's words rather than summarising them away."
          : "No critical findings. That says what is IN this brain is well formed. It does " +
            "not say the right material was loaded: brain_sources and brain_inventory are " +
            "what answer that.",
      };
    }
    case "brain_inventory": {
      const source = typeof args.source === "string" && args.source ? args.source : null;
      let cursor = typeof args.cursor === "string" ? args.cursor : "";
      let families = 0;
      let pages = 0;
      let next = null;
      const sample = [];
      // Bounded on purpose. A chat surface must not walk an unbounded corpus,
      // and a truncated walk that reported its count as a total would be the
      // exact overclaim this product exists to refuse.
      while (pages < INVENTORY_MAX_PAGES) {
        const d = await call("/api/admin/brain/source-families", {
          method: "POST",
          body: {
            ...(source ? { source } : {}),
            ...(cursor ? { cursor } : {}),
            limit: INVENTORY_PAGE_LIMIT,
          },
        });
        const page = Array.isArray(d.families) ? d.families : [];
        families += page.length;
        pages += 1;
        for (const uid of page) if (sample.length < 20) sample.push(String(uid));
        next = d.next_cursor ?? null;
        if (!next) break;
        cursor = next;
      }
      const complete = !next;
      const out = {
        source,
        families,
        complete,
        pages_walked: pages,
        sample,
        ...(complete ? {} : { next_cursor: next }),
      };
      if (!complete) {
        out.note = `This is a FLOOR, not a total: the walk stopped after ${pages} page(s) ` +
          `with more remaining. Say "at least ${families}" and pass next_cursor back to ` +
          "continue counting.";
      } else if (!families) {
        out.note = source
          ? `Source "${source}" holds no documents. Either it was never loaded, or a load ` +
            "failed and left no trace."
          : "This brain holds no documents at all.";
      }
      return out;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* MCP plumbing                                                        */
/* ------------------------------------------------------------------ */

const INSTRUCTIONS = `This server is ${OWNER}'s private knowledge record: their documents, meetings, correspondence and decisions.

Do NOT state a fact about a named person, client, deal, contract, commitment or figure in their world from your own knowledge. Your training data does not contain any of it, and a plausible reconstruction is indistinguishable from a real answer to the person reading it. Call brain_think first.

When the brain returns nothing, "nothing recorded on this" IS the answer. Say it in those words. Do not fill the gap with inference and do not silently drop the point.

EXCEPT when the response carries search_status "search_unavailable" or a degraded field. Then the search did not complete, nothing is known about the corpus, and "nothing recorded on this" would be a false statement about the owner's own records. Say the search could not be completed, name the cause from the note, and offer to retry. This is common in the first hours of a new brain while its index is still building.

Relay the gaps array from brain_think whenever it affects confidence. A cited answer with its gaps stated is worth more than a confident one without them.

Anchor consultation to the artifact, not the moment: whatever you write before acting should name what came back, including anything that argues against the approach you are taking.

Call brain_remember when a session produces a durable lesson. That is how this record improves instead of merely aging.

Before you tell the owner this install is healthy, and before you load anything into it, call brain_install_state. A half-finished upgrade refuses every write with HTTP 503 while brain_health still returns normal document counts, and that is the one state the health counts cannot see.

When you are setting up, diagnosing or narrating an install, brain_sources is where to start. It already knows which sources are registered and how current each one is, so ask the owner about what is MISSING rather than asking them to describe an install this server can see for itself. brain_diagnose says what is stored wrong and what to do about it, and brain_inventory counts what actually landed.

These tools are read-only by design, so there is a hard limit worth stating plainly rather than working around: this server can diagnose, narrate, configure and verify an install, and it cannot authorise one. Every OAuth consent screen, bank login, QR pairing and system permission dialog needs the owner's own hand. When you reach one, print the exact steps and wait.`;

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    });
  }
  if (id === undefined || id === null) return;
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    try {
      const result = await runTool(params?.name, params?.arguments ?? {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return ok(id, {
        content: [{ type: "text", text: `brain error in ${params?.name}: ${err.message}` }],
        isError: true,
      });
    }
  }
  if (method === "ping") return ok(id, {});
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  return fail(id, -32601, `method not found: ${method}`);
}

let buf = "";
// Requests resolve asynchronously, so stdin closing does not mean the work is
// done. Piped input (every test harness) closes it immediately; exiting on that
// event kills in-flight calls before they reply.
const inFlight = new Set();

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const p = handle(msg)
      .catch((err) => {
        if (msg?.id !== undefined && msg?.id !== null)
          fail(msg.id, -32603, String(err?.message ?? err));
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
});

process.stdin.on("end", async () => {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
  process.exit(0);
});
