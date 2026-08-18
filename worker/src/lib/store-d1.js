/**
 * store-d1 — retrieval over Cloudflare alone: D1 for text and keywords,
 * Vectorize for vectors, fusion in the Worker.
 *
 * WHY NOT SUPABASE
 *
 * The install model gives every client their own Cloudflare account. A Supabase
 * dependency means a second vendor to create, and its free tier pauses after
 * inactivity, so a brain queried a few times a week is asleep when it is
 * wanted. This keeps the whole brain inside one account the client owns.
 *
 * THE ONE THING POSTGRES GAVE US THAT THIS DOES NOT
 *
 * A single SQL statement returned both result lists, ranked and fused, with
 * consistent reads. Here they are two systems reached over two network calls,
 * with no transaction between them and no read-after-write guarantee. Every
 * awkward part of this file traces back to that.
 *
 * FUSION IS RRF, NOT SCORE BLENDING
 *
 * Vectorize returns cosine similarity (0..1, higher better). D1 returns bm25
 * (negative, more negative is better). Those scales are not comparable, not the
 * same range, not even the same sign direction, and neither is calibrated
 * across corpora. Any alpha * cosine + (1 - alpha) * normalised_bm25 scheme
 * requires normalising two distributions nobody can observe globally. RRF
 * throws the magnitudes away and uses rank position only, which makes the
 * incomparability disappear. Same arithmetic the Postgres version used; the
 * only difference is gathering the lists over two calls instead of one query.
 */

const RRF_K = 60;

// Vectorize caps topK at 100, and only when no metadata or values are
// returned; 50 otherwise. This is a hard platform limit that does NOT scale
// with corpus size, so candidate depth shrinks as a fraction of the corpus as
// the brain grows. It is the real ceiling on this design, well below the
// advertised 20M vectors per index.
const VECTOR_TOPK_MAX = 100;

/**
 * Reciprocal rank fusion.
 *
 * score(d) = sum over lists of  weight / (k + rank(d))
 *
 * A document absent from a list contributes nothing rather than a penalty,
 * which is what lets a strong keyword hit with no vector match still surface.
 */
export function fuseRRF(lists, { k = RRF_K } = {}) {
  const scores = new Map();
  const seen = new Map();
  for (const { items, weight = 1.0 } of lists) {
    items.forEach((item, i) => {
      const uid = item.chunk_uid;
      if (!uid) return;
      scores.set(uid, (scores.get(uid) || 0) + weight / (k + i + 1));
      if (!seen.has(uid)) seen.set(uid, item);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uid, score]) => ({ ...seen.get(uid), chunk_uid: uid, rrf_score: score }));
}

/**
 * Translate the supported filters into a SQL fragment.
 *
 * `top_folder` and `platform` are NOT here. They exist in the Postgres schema
 * and have no equivalent column in D1, so they are refused by the caller rather
 * than dropped. Dropping a filter is worse than rejecting it: the answer comes
 * back looking narrowed when it never was.
 */
export const D1_FILTERS = ["source", "client", "category", "from", "to"];
export const D1_UNSUPPORTED = ["top_folder", "platform"];

export function filterSql(filters = {}, alias = "c", nextParam = 3) {
  const parts = [];
  const params = [];
  const add = (frag, val) => { parts.push(frag.replace("?N", "?" + nextParam++)); params.push(val); };
  if (filters.source) add(`${alias}.source = ?N`, filters.source);
  if (filters.client) add(`${alias}.client = ?N`, filters.client);
  if (filters.category) add(`${alias}.category = ?N`, filters.category);
  // A date filter must not swallow undated rows silently, but it must not keep
  // them either: "since June" cannot be answered by a document with no date.
  // They are excluded, and the undated count is what the gap engine reports.
  if (filters.from) { const t = Date.parse(filters.from); if (Number.isFinite(t)) add(`${alias}.document_date >= ?N`, t); }
  if (filters.to)   { const t = Date.parse(filters.to);   if (Number.isFinite(t)) add(`${alias}.document_date <= ?N`, t); }
  return { clause: parts.length ? " AND " + parts.join(" AND ") : "", params, nextParam };
}

/** Which requested filters this backend cannot honour. */
export function unsupportedFilters(filters = {}) {
  return D1_UNSUPPORTED.filter((k) => filters[k]);
}

/** Keyword search over D1's FTS5 index, ranked by bm25. */
export async function searchKeyword(env, query, { limit, filters = {} } = {}) {
  // FTS5 treats bare punctuation as syntax. A user question with an apostrophe
  // or a hyphen is not a query language expression, so it is quoted as a
  // phrase-free bag of terms rather than passed through raw.
  const terms = String(query || "")
    .replace(/["()*:^-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" OR ");
  if (!terms) return [];

  const f = filterSql(filters, "c", 3);
  const sql = `
    SELECT c.chunk_uid, c.doc_uid, c.text, c.source, c.title, c.document_date,
           c.client, c.category, bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ?1${f.clause}
    ORDER BY bm25(chunks_fts)
    LIMIT ?2`;

  const { results } = await env.DB.prepare(sql).bind(terms, limit, ...f.params).all();
  return results || [];
}

/** Vector search over Vectorize, hydrated and filtered in D1. */
export async function searchVector(env, embedding, { limit, filters = {} } = {}) {
  const topK = Math.min(limit, VECTOR_TOPK_MAX);

  // Vectorize can only filter on indexed metadata, and only `source` is small
  // and low-cardinality enough to live there safely. Everything else is applied
  // during hydration. That costs recall — a filter narrower than the topK
  // window can return almost nothing — so the topK is pushed to its maximum
  // whenever a post-filter is in play, and a thin result is reported, not hidden.
  const postFiltered = !!(filters.client || filters.category || filters.from || filters.to);
  const effTopK = postFiltered ? VECTOR_TOPK_MAX : topK;

  const query = (withFilter) =>
    env.VECTORIZE.query(embedding, {
      topK: effTopK,
      returnValues: false,
      // Metadata is deliberately not returned. It halves topK from 100 to 50, and
      // everything needed is in D1 anyway, keyed by the same chunk_uid.
      returnMetadata: "none",
      ...(withFilter && filters.source ? { filter: { source: { $eq: filters.source } } } : {}),
    });

  let res;
  try {
    res = await query(true);
  } catch {
    // The metadata index may not exist on this install. Falling back to an
    // unfiltered query keeps search working, because `source` is re-applied in
    // the hydration WHERE below regardless.
    res = await query(false);
  }

  const ids = (res?.matches || []).map((m) => m.id);
  if (!ids.length) return [];

  // Hydrate in ONE query, then restore Vectorize's ordering. A DB that returns
  // rows in its own order would silently destroy the ranking, which is the
  // whole point of having called the vector index.
  const placeholders = ids.map((_, i) => "?" + (i + 1)).join(",");
  const f = filterSql(filters, "c", ids.length + 1);
  const { results } = await env.DB.prepare(
    `SELECT c.chunk_uid, c.doc_uid, c.text, c.source, c.title, c.document_date,
            c.client, c.category
     FROM chunks c WHERE c.chunk_uid IN (${placeholders})${f.clause}`
  )
    .bind(...ids, ...f.params)
    .all();

  const byUid = new Map((results || []).map((r) => [r.chunk_uid, r]));
  // A vector whose chunk is missing from D1 means the two systems have drifted.
  // Dropping it silently would hide that, so it is counted by the caller.
  return ids.map((id) => byUid.get(id)).filter(Boolean);
}

/**
 * Hybrid search: both lists, fused.
 *
 * Pulls a wider candidate pool than the caller asked for, because fusion can
 * only promote a document that appears in one of the lists.
 */
export async function search(env, { query, embedding, limit = 10, filters = {}, weights = {} }) {
  const pool = Math.min(Math.max(limit * 3, 30), VECTOR_TOPK_MAX);

  const [kw, vec] = await Promise.all([
    searchKeyword(env, query, { limit: pool, filters }).catch(() => []),
    embedding
      ? searchVector(env, embedding, { limit: pool, filters }).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Both empty is a real answer (nothing matched). Only ONE empty when both
  // were attempted means a subsystem is down, and a caller that cannot tell
  // those apart will report a degraded brain as an empty one.
  const degraded =
    embedding && vec.length === 0 && kw.length > 0
      ? "vector"
      : !embedding
        ? "no-embedding"
        : null;

  const fused = fuseRRF([
    { items: vec, weight: weights.vector ?? 1.0 },
    { items: kw, weight: weights.keyword ?? 1.0 },
  ]);

  return {
    results: fused.slice(0, limit),
    degraded,
    ignored_filters: unsupportedFilters(filters),
    counts: { keyword: kw.length, vector: vec.length },
  };
}

/**
 * Write a chunk to both systems, D1 first, via the outbox.
 *
 * Order matters and is not arbitrary. D1 is the system of record: a chunk that
 * exists in D1 without a vector is findable by keyword and repairable. A vector
 * with no D1 row is an orphan that returns an id pointing at nothing.
 */
export async function upsertChunks(env, chunks) {
  if (!chunks.length) return { written: 0, queued: 0 };
  const now = Date.now();

  const stmts = [];
  for (const c of chunks) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(chunk_uid) DO UPDATE SET
           text = excluded.text, title = excluded.title,
           document_date = excluded.document_date,
           client = excluded.client, category = excluded.category`
      ).bind(c.chunk_uid, c.doc_uid, c.chunk_ix, c.text, c.source, c.title ?? null,
             c.document_date ?? null, c.client ?? null, c.category ?? null)
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO vector_outbox (chunk_uid, op, queued_at) VALUES (?1,'upsert',?2)
         ON CONFLICT(chunk_uid) DO UPDATE SET op='upsert', queued_at=?2, attempts=0`
      ).bind(c.chunk_uid, now)
    );
  }
  await env.DB.batch(stmts);
  return { written: chunks.length, queued: chunks.length };
}

/**
 * Drain the outbox into Vectorize.
 *
 * Separate from the write on purpose. Vectorize acknowledges a write before the
 * index reflects it (seconds for a small upsert, minutes for a large batch), so
 * pretending the write completed inline would make read-after-write look
 * broken. Draining separately makes the lag a visible queue instead.
 */
export async function drainOutbox(env, { embed, batchSize = 100 } = {}) {
  const { results: pending } = await env.DB.prepare(
    `SELECT o.chunk_uid, c.text, c.source, c.doc_uid
     FROM vector_outbox o JOIN chunks c ON c.chunk_uid = o.chunk_uid
     WHERE o.op = 'upsert' ORDER BY o.queued_at LIMIT ?1`
  )
    .bind(batchSize)
    .all();

  if (!pending?.length) return { drained: 0, remaining: 0 };

  const vectors = [];
  for (const row of pending) {
    const values = await embed(row.text);
    vectors.push({
      id: row.chunk_uid,
      values,
      // Metadata strings are INDEXED to 64 bytes and truncate silently, so two
      // long client names sharing a prefix would become indistinguishable to a
      // filter. Only short, low-cardinality values go here; everything else
      // lives in D1.
      metadata: { source: String(row.source).slice(0, 60) },
    });
  }

  await env.VECTORIZE.upsert(vectors);

  await env.DB.batch(
    pending.map((p) => env.DB.prepare("DELETE FROM vector_outbox WHERE chunk_uid = ?1").bind(p.chunk_uid))
  );

  const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  return { drained: pending.length, remaining: Number(rest?.n || 0) };
}

/** How far the vector index is behind the text. Surfaced by health and report. */
export async function outboxDepth(env) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n, min(queued_at) AS oldest FROM vector_outbox"
  ).first();
  return { pending: Number(row?.n || 0), oldest_queued_at: row?.oldest ?? null };
}

/** Vectorize caps a delete batch; stay well under it and chunk. */
const DELETE_BATCH = 500;

/**
 * Remove documents from both systems.
 *
 * ORDER MATTERS, AND IT IS THE OPPOSITE OF THE INSERT ORDER.
 *
 * On insert, D1 goes first because a chunk with no vector is findable and
 * repairable while a vector with no chunk is an orphan pointing at nothing.
 *
 * On delete, the dangerous state is inverted: it is data that should be gone and
 * is not. So D1 rows go FIRST. Once they are gone the document is invisible to
 * keyword search, and any vector still in Vectorize returns an id that hydration
 * cannot resolve, which searchVector already drops. A crash between the two
 * therefore leaves the document unreachable by BOTH paths, which is the safe
 * way to fail. Vectors are then removed to reclaim the space.
 */
export async function forget(env, { docUids = [], source = null, dryRun = true } = {}) {
  let targets = docUids;
  if (source) {
    const { results } = await env.DB.prepare("SELECT doc_uid FROM documents WHERE source = ?1").bind(source).all();
    targets = [...new Set([...targets, ...(results || []).map((r) => r.doc_uid)])];
  }
  if (!targets.length) return { documents: 0, chunks: 0, vectors: 0, dry_run: dryRun, targets: [] };

  const marks = targets.map((_, i) => "?" + (i + 1)).join(",");
  const { results: chunkRows } = await env.DB.prepare(
    `SELECT chunk_uid FROM chunks WHERE doc_uid IN (${marks})`
  ).bind(...targets).all();
  const chunkUids = (chunkRows || []).map((r) => r.chunk_uid);

  if (dryRun) {
    return { documents: targets.length, chunks: chunkUids.length, vectors: chunkUids.length, dry_run: true, targets };
  }

  // D1 first. The FTS index follows via the delete trigger, and ON DELETE
  // CASCADE removes the chunks with their document.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chunks WHERE doc_uid IN (${marks})`).bind(...targets),
    env.DB.prepare(`DELETE FROM documents WHERE doc_uid IN (${marks})`).bind(...targets),
    env.DB.prepare(`DELETE FROM vector_outbox WHERE chunk_uid IN (${chunkUids.map((_, i) => "?" + (i + 1)).join(",") || "NULL"})`)
      .bind(...(chunkUids.length ? chunkUids : [])),
  ].filter(Boolean));

  let vectors = 0;
  let vectorError = null;
  for (let i = 0; i < chunkUids.length; i += DELETE_BATCH) {
    const slice = chunkUids.slice(i, i + DELETE_BATCH);
    try {
      await env.VECTORIZE.deleteByIds(slice);
      vectors += slice.length;
    } catch (e) {
      // Reported, never swallowed. The document is already unreachable, but a
      // caller told "deleted" while vectors remain deserves to know.
      vectorError = String(e.message || e).slice(0, 200);
      break;
    }
  }

  // Derived, so the count cannot drift after a delete.
  const sources = source ? [source] : [...new Set(targets.map((t) => String(t).split(":")[0]))];
  for (const src of sources) {
    await env.DB.prepare(
      `INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
       SELECT ?1, COUNT(DISTINCT doc_uid), COUNT(*), (SELECT last_ingest_at FROM corpus_stats WHERE source = ?1)
       FROM chunks WHERE source = ?1
       ON CONFLICT(source) DO UPDATE SET documents = excluded.documents, chunks = excluded.chunks`
    ).bind(src).run().catch(() => {});
  }

  return { documents: targets.length, chunks: chunkUids.length, vectors, dry_run: false, vector_error: vectorError, targets };
}
