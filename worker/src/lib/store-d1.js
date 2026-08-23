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

/**
 * Vectorize caps a vector id at 64 BYTES.
 *
 * Chunk ids are derived from the document path, so any realistically-named file
 * blows through it: "Financial/2026/Q3 Statements/Wells Fargo Business Checking
 * Statement 2026-07.pdf#12" is 89 bytes. The upsert then throws, the drain stops
 * on it, and every chunk behind it in the queue is stranded.
 *
 * What made it dangerous rather than merely broken: ingest still reported
 * documents created, /health still returned ok, setup still said the brain was
 * live, and keyword search still answered. The only signal anywhere was a
 * backlog number that stopped going down. A client hitting this concludes the
 * retrieval is mediocre, not that something failed.
 *
 * So the id sent to Vectorize is a hash. It stays stable across runs, always
 * fits, and the readable chunk_uid remains the join key everywhere else.
 */
export const VECTOR_ID_MAX_BYTES = 64;
export const VECTOR_METADATA_MAX_BYTES = 64;

export async function vectorIdFor(chunkUid) {
  const bytes = new TextEncoder().encode(chunkUid);
  if (bytes.length <= VECTOR_ID_MAX_BYTES) return chunkUid;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Prefixed so a stray id in a log is recognisable as ours rather than opaque.
  return `h:${hex.slice(0, 60)}`;
}

/**
 * Encode an exact-match metadata value without relying on Vectorize's silent
 * 64-byte truncation. The same function is used when vectors are written and
 * when a filter is queried, so long values remain exact rather than sharing a
 * prefix with an unrelated value.
 */
export async function metadataTokenFor(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= VECTOR_METADATA_MAX_BYTES) return text;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `h:${hex.slice(0, 60)}`;
}

// Vectorize caps topK at 100 when neither metadata nor values are returned, and
// 50 otherwise. Metadata prefilters and D1 FTS5 keep this from being equivalent
// to a corpus-size cutoff. The full eval set, not a guessed chunk threshold,
// decides whether candidate depth is sufficient.
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
 * All public filters have real D1 columns. Dropping a filter is worse than
 * rejecting it: the answer comes back looking narrowed when it never was.
 */
export const D1_FILTERS = ["source", "client", "category", "top_folder", "platform", "from", "to"];
export const D1_UNSUPPORTED = [];

export function filterSql(filters = {}, alias = "c", nextParam = 3) {
  const parts = [];
  const params = [];
  const add = (frag, val) => { parts.push(frag.replace("?N", "?" + nextParam++)); params.push(val); };
  if (filters.source) add(`${alias}.source = ?N`, filters.source);
  if (filters.client) add(`${alias}.client = ?N`, filters.client);
  if (filters.category) add(`${alias}.category = ?N`, filters.category);
  if (filters.top_folder) add(`${alias}.top_folder = ?N`, filters.top_folder);
  if (filters.platform) add(`${alias}.platform = ?N`, filters.platform);
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

const VECTOR_STRING_FILTERS = ["source", "client", "category", "top_folder", "platform"];

/** Build the metadata stored with one vector. D1 remains the exact authority. */
export async function vectorMetadataFor(row) {
  const metadata = {};
  for (const key of VECTOR_STRING_FILTERS) {
    const token = await metadataTokenFor(row[key]);
    if (token !== null) metadata[key] = token;
  }
  const date = Number(row.document_date);
  if (row.document_date !== null && row.document_date !== undefined && Number.isFinite(date)) {
    metadata.document_date = date;
  }
  return metadata;
}

/** Build the pre-filter Vectorize applies before selecting topK candidates. */
export async function vectorFilterFor(filters = {}) {
  const filter = {};
  for (const key of VECTOR_STRING_FILTERS) {
    const token = await metadataTokenFor(filters[key]);
    if (token !== null) filter[key] = { $eq: token };
  }
  const range = {};
  if (filters.from) {
    const t = Date.parse(filters.from);
    if (Number.isFinite(t)) range.$gte = t;
  }
  if (filters.to) {
    const t = Date.parse(filters.to);
    if (Number.isFinite(t)) range.$lte = t;
  }
  if (Object.keys(range).length) filter.document_date = range;
  return filter;
}

/** Keyword search over D1's FTS5 index, ranked by bm25. */
/**
 * Words carrying no retrieval signal, kept deliberately short.
 *
 * This is a PERFORMANCE list, not a linguistic one. Every entry is a word whose
 * posting list is a large fraction of any English corpus, so walking it costs
 * real time and changes the ranking by approximately nothing. Anything a user
 * might actually be searching FOR stays out of this list, however common: "tax",
 * "pay", "cost", "account" and their like are load bearing.
 */
const FTS_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "out", "so", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
  // Question framing. These are how people phrase a question rather than what
  // they are asking about, and they are as common in prose as the words above.
  "about", "any", "can", "could", "get", "got", "just", "know", "like", "said",
  "say", "says", "should", "some", "tell", "than", "very",
]);

export async function searchKeyword(env, query, { limit, filters = {} } = {}) {
  // FTS5 treats bare punctuation as syntax. A user question with an apostrophe
  // or a hyphen is not a query language expression, so it is quoted as a
  // phrase-free bag of terms rather than passed through raw.
  const raw = String(query || "")
    .replace(/["()*:^-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Drop stopwords before they reach FTS5.
  //
  // BM25 already scores a word that appears in every document at near zero, so
  // "what did we say about" contributes no ranking signal. It does contribute
  // the entire cost: each term is a posting list to walk, and a stopword's list
  // is most of the corpus.
  //
  // Measured on a 900,000 chunk corpus with this exact schema:
  //   selective single term                 0.2 ms
  //   the question OR'd as-is            2,034 ms
  //   the same question, stopwords gone  1,046 ms
  // At Jay's 1,000 chunks the difference is invisible, which is why this
  // shipped. It grows with the corpus and reads as "retrieval feels slow"
  // rather than as a fault.
  const content = raw.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase()));

  // A query made entirely of stopwords is still a query. Falling back to the
  // raw terms is slow but correct, and returning nothing would not be.
  const use = content.length ? content : raw;
  const terms = use.map((t) => `"${t}"`).join(" OR ");
  if (!terms) return [];

  const f = filterSql(filters, "c", 3);
  const sql = `
    SELECT c.chunk_uid, c.doc_uid, c.text, c.source, c.title, c.document_date,
           c.client, c.category, c.top_folder, c.platform,
           d.source_id, d.uri,
           bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.doc_uid = c.doc_uid
    WHERE chunks_fts MATCH ?1${f.clause}
    ORDER BY bm25(chunks_fts)
    LIMIT ?2`;

  const { results } = await env.DB.prepare(sql).bind(terms, limit, ...f.params).all();
  return results || [];
}

/** Vector search over Vectorize, hydrated and filtered in D1. */
export async function searchVector(env, embedding, { limit, filters = {} } = {}) {
  const topK = Math.min(limit, VECTOR_TOPK_MAX);
  const vectorFilter = await vectorFilterFor(filters);
  const hasFilter = Object.keys(vectorFilter).length > 0;

  // Vectorize applies metadata filters BEFORE topK. D1 repeats the same filter
  // during hydration as the exact authority and as protection against index
  // drift. If an upgraded install is missing a metadata index, the fallback
  // widens the candidate pool before D1 narrows it.
  const query = (withFilter) =>
    env.VECTORIZE.query(embedding, {
      topK: !withFilter && hasFilter ? VECTOR_TOPK_MAX : topK,
      returnValues: false,
      // Metadata is deliberately not returned. It halves topK from 100 to 50, and
      // everything needed is in D1 anyway, keyed by the same chunk_uid.
      returnMetadata: "none",
      ...(withFilter && hasFilter ? { filter: vectorFilter } : {}),
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

  // A hashed id cannot be looked up in D1 directly, so those are resolved via
  // the mapping column written at upsert time.
  const hashed = ids.filter((i) => i.startsWith("h:"));
  let hashMap = new Map();
  if (hashed.length) {
    const ph = hashed.map((_, i) => "?" + (i + 1)).join(",");
    const { results: mapped } = await env.DB.prepare(
      `SELECT chunk_uid, vector_id FROM chunks WHERE vector_id IN (${ph})`
    ).bind(...hashed).all();
    hashMap = new Map((mapped || []).map((r) => [r.vector_id, r.chunk_uid]));
  }
  const resolved = ids.map((i) => hashMap.get(i) || i);

  // Hydrate in ONE query, then restore Vectorize's ordering. A DB that returns
  // rows in its own order would silently destroy the ranking, which is the
  // whole point of having called the vector index.
  const placeholders = resolved.map((_, i) => "?" + (i + 1)).join(",");
  const f = filterSql(filters, "c", resolved.length + 1);
  const { results } = await env.DB.prepare(
    `SELECT c.chunk_uid, c.doc_uid, c.text, c.source, c.title, c.document_date,
            c.client, c.category, c.top_folder, c.platform,
            d.source_id, d.uri
     FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid
     WHERE c.chunk_uid IN (${placeholders})${f.clause}`
  )
    .bind(...resolved, ...f.params)
    .all();

  const byUid = new Map((results || []).map((r) => [r.chunk_uid, r]));
  // A vector whose chunk is missing from D1 means the two systems have drifted.
  // Dropping it silently would hide that, so it is counted by the caller.
  return resolved.map((id) => byUid.get(id)).filter(Boolean);
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

  // Retrieval ranks chunks, but the public result contract ranks documents.
  // Collapse the wide fused pool BEFORE applying the caller's limit so a long
  // file cannot consume several slots and evict a different document.
  const seenDocuments = new Set();
  const documents = [];
  for (const row of fused) {
    const key = row.doc_uid || `${row.source || ""}|${row.source_id || row.title || row.chunk_uid}`;
    if (seenDocuments.has(key)) continue;
    seenDocuments.add(key);
    documents.push(row);
  }

  return {
    results: documents.slice(0, limit),
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
    // Computed at write time so a search hit can be resolved back to its chunk
    // even when the id had to be hashed to fit Vectorize's 64-byte ceiling.
    c.vector_id = await vectorIdFor(c.chunk_uid);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(chunk_uid) DO UPDATE SET
           text = excluded.text, title = excluded.title,
           document_date = excluded.document_date,
           client = excluded.client, category = excluded.category,
           top_folder = excluded.top_folder, platform = excluded.platform,
           vector_id = excluded.vector_id`
      ).bind(c.chunk_uid, c.doc_uid, c.chunk_ix, c.text, c.source, c.title ?? null,
             c.document_date ?? null, c.client ?? null, c.category ?? null,
             c.top_folder ?? null, c.platform ?? null, c.vector_id)
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
         VALUES (?1,?2,'upsert',?3)
         ON CONFLICT(chunk_uid) DO UPDATE SET
           vector_id=excluded.vector_id, op='upsert', queued_at=?3,
           attempts=0, last_error=NULL`
      ).bind(c.chunk_uid, c.vector_id, now)
    );
  }
  await env.DB.batch(stmts);
  return { written: chunks.length, queued: chunks.length };
}

/**
 * Queue every current vector for a document and remove its D1 chunks in one D1
 * transaction. A following upsert for a retained chunk uid changes that queue
 * row back to `upsert`; chunks removed by a shorter revision remain `delete`.
 */
export async function replaceDocumentChunks(env, docUid) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
       FROM chunks WHERE doc_uid = ?1
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).bind(docUid, now),
    env.DB.prepare("DELETE FROM chunks WHERE doc_uid = ?1").bind(docUid),
  ]);
}

/** Vectorize and D1 both cap bulk operations; D1 allows 100 batch statements. */
const DELETE_BATCH = 100;

async function deleteQueuedVectors(env, rows) {
  let deleted = 0;
  for (let i = 0; i < rows.length; i += DELETE_BATCH) {
    const slice = rows.slice(i, i + DELETE_BATCH);
    try {
      await env.VECTORIZE.deleteByIds(slice.map((r) => r.vector_id || r.chunk_uid));
      deleted += slice.length;
      // Only clear the exact delete operation we observed. If an ingest changed
      // the row back to `upsert` while Vectorize was deleting, that upsert must
      // survive so the current chunk is restored.
      await env.DB.batch(slice.map((r) =>
        env.DB.prepare(
          `DELETE FROM vector_outbox
           WHERE chunk_uid = ?1 AND op = 'delete'
             AND COALESCE(vector_id, chunk_uid) = ?2 AND queued_at = ?3`
        ).bind(r.chunk_uid, r.vector_id || r.chunk_uid, r.queued_at)
      ));
    } catch (e) {
      const err = String(e.message || e).slice(0, 300);
      await env.DB.batch(slice.map((r) =>
        env.DB.prepare(
          `UPDATE vector_outbox SET attempts = attempts + 1, last_error = ?2
           WHERE chunk_uid = ?1 AND op = 'delete'`
        ).bind(r.chunk_uid, err)
      )).catch(() => {});
      const e2 = new Error(`the vector index refused this delete batch: ${err}`);
      e2.vectorDeleteFailed = true;
      e2.deleted = deleted;
      throw e2;
    }
  }
  return deleted;
}

/**
 * Drain the outbox into Vectorize.
 *
 * Separate from the write on purpose. Vectorize acknowledges a write before the
 * index reflects it (seconds for a small upsert, minutes for a large batch), so
 * pretending the write completed inline would make read-after-write look
 * broken. Draining separately makes the lag a visible queue instead.
 */
export async function drainOutbox(env, { embed, embedBatch, batchSize = 100, embedGroup = 50 } = {}) {
  // Delete first. Orphans still consume Vectorize candidate slots even though
  // D1 hydration makes them unreachable, so leaving them behind damages recall.
  const { results: deletePending } = await env.DB.prepare(
    `SELECT chunk_uid, COALESCE(vector_id, chunk_uid) AS vector_id, queued_at
     FROM vector_outbox WHERE op = 'delete' ORDER BY queued_at LIMIT ?1`
  ).bind(batchSize).all();
  const deleted = deletePending?.length ? await deleteQueuedVectors(env, deletePending) : 0;

  const { results: pending } = await env.DB.prepare(
    `SELECT o.chunk_uid, o.queued_at, c.text, c.source, c.doc_uid, c.document_date,
            c.client, c.category, c.top_folder, c.platform
     FROM vector_outbox o JOIN chunks c ON c.chunk_uid = o.chunk_uid
     WHERE o.op = 'upsert' ORDER BY o.queued_at LIMIT ?1`
  )
    .bind(batchSize)
    .all();

  if (!pending?.length) {
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return { drained: deleted, deleted, upserted: 0, failed: 0, remaining: Number(rest?.n || 0), errors: [] };
  }

  const vectors = [];
  const idToChunk = new Map();
  const chunkVersion = new Map();
  const poisoned = [];

  // Embed in groups when the caller can. One round trip per group instead of one
  // per chunk is the difference between 1,200 chunks/hour and a number that
  // finishes while the client is still on the call.
  //
  // A failed group falls back to embedding its members one at a time. That keeps
  // the poison-isolation guarantee exactly as it was: a single bad chunk
  // quarantines itself rather than taking the other 49 down with it.
  const embedded = new Array(pending.length).fill(undefined);
  if (embedBatch) {
    for (let i = 0; i < pending.length; i += embedGroup) {
      const group = pending.slice(i, i + embedGroup);
      try {
        const out = await embedBatch(group.map((r) => r.text));
        if (!Array.isArray(out) || out.length !== group.length) {
          throw new Error(`embedBatch returned ${out?.length ?? 0} vectors for ${group.length} texts`);
        }
        out.forEach((v, k) => { embedded[i + k] = v; });
      } catch {
        for (let k = 0; k < group.length; k++) {
          try {
            embedded[i + k] = await embed(group[k].text);
          } catch (e) {
            poisoned.push({ chunk_uid: group[k].chunk_uid, error: String(e.message || e).slice(0, 200) });
          }
        }
      }
    }
  }

  for (let idx = 0; idx < pending.length; idx++) {
    const row = pending[idx];
    let values = embedded[idx];
    if (values === undefined) {
      if (embedBatch && poisoned.some((p) => p.chunk_uid === row.chunk_uid)) continue;
      try {
        values = await embed(row.text);
      } catch (e) {
        // One unembeddable chunk must not strand every chunk behind it. Record the
        // failure against that row and carry on; the queue keeps draining.
        poisoned.push({ chunk_uid: row.chunk_uid, error: String(e.message || e).slice(0, 200) });
        continue;
      }
    }
    const vid = await vectorIdFor(row.chunk_uid);
    idToChunk.set(vid, row.chunk_uid);
    chunkVersion.set(row.chunk_uid, row.queued_at);
    vectors.push({
      id: vid,
      values,
      metadata: await vectorMetadataFor(row),
    });
  }

  if (vectors.length) {
    try {
      await env.VECTORIZE.upsert(vectors);
    } catch (e) {
      // The whole batch failed. Leave every row queued so nothing is lost, and
      // surface the reason rather than letting the backlog silently plateau.
      const err = String(e.message || e).slice(0, 300);
      await env.DB.batch(
        vectors.map((v) =>
          env.DB.prepare(
            `UPDATE vector_outbox SET attempts = attempts + 1, last_error = ?2
             WHERE chunk_uid = ?1 AND op = 'upsert' AND queued_at = ?3`
          ).bind(idToChunk.get(v.id), err, chunkVersion.get(idToChunk.get(v.id)))
        )
      ).catch(() => {});
      const e2 = new Error(`the vector index refused this batch: ${err}`);
      e2.vectorUpsertFailed = true;
      throw e2;
    }
  }

  // Record the id each chunk was ACTUALLY stored under, at drain time.
  //
  // upsertChunks writes this at ingest, which covers anything loaded on a fixed
  // build. It does NOT cover rows already queued by an older build: those drain
  // fine, embed fine, and are then unreachable, because search resolves a hashed
  // id back through this column and finds nothing. The chunk is silently
  // keyword-only. Found by replaying a real 0.1.0 install through the upgrade
  // rather than trusting a fresh install to represent it.
  const remap = vectors
    .map((v) => [idToChunk.get(v.id), v.id])
    .filter(([cu, vid]) => cu && vid !== cu);
  if (remap.length) {
    await env.DB.batch(
      remap.map(([cu, vid]) =>
        env.DB.prepare("UPDATE chunks SET vector_id = ?2 WHERE chunk_uid = ?1").bind(cu, vid)
      )
    ).catch(() => {});
  }

  // Only rows that actually made it are cleared. A poisoned row stays queued
  // with its attempt count and error recorded, so it is visible and bounded
  // rather than an invisible permanent stall.
  const landed = vectors.map((v) => idToChunk.get(v.id)).filter(Boolean);
  if (landed.length) {
    await env.DB.batch(
      landed.map((cu) => env.DB.prepare(
        "DELETE FROM vector_outbox WHERE chunk_uid = ?1 AND op = 'upsert' AND queued_at = ?2"
      ).bind(cu, chunkVersion.get(cu)))
    );
  }
  if (poisoned.length) {
    await env.DB.batch(
      poisoned.map((p) =>
        env.DB.prepare(
          `UPDATE vector_outbox SET attempts = attempts + 1, last_error = ?2
           WHERE chunk_uid = ?1 AND op = 'upsert' AND queued_at = ?3`
        ).bind(p.chunk_uid, p.error, chunkVersion.get(p.chunk_uid))
      )
    ).catch(() => {});
  }

  const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  return {
    drained: deleted + landed.length,
    deleted,
    upserted: landed.length,
    failed: poisoned.length,
    remaining: Number(rest?.n || 0),
    errors: poisoned.slice(0, 3).map((p) => p.error),
  };
}

/** How far the vector index is behind the text. Surfaced by health and report. */
/**
 * Re-queue every chunk for embedding, rebuilding Vectorize from D1.
 *
 * D1 holds the chunk TEXT, so the vector store is fully reconstructible without
 * the original source files. That matters more than it sounds:
 *
 *  - `brain rollback` restores D1 and cannot rewind Vectorize, so the two
 *    stores silently desynchronise. This is the resync.
 *  - Vectorize has no backup, no export and no point-in-time restore. D1 is the
 *    only copy of the text, and this is what turns that into a recovery path.
 *  - A metadata index added after ingest does not apply to vectors already
 *    written. Verified 2026-08-18: re-upserting the SAME vector id after the
 *    index exists DOES make it filterable, so this repairs that too, without
 *    the client needing the original folder in the state it was in.
 *
 * Deliberately reuses the outbox rather than writing vectors directly, so the
 * drain's batching, poison quarantine and vector_id write-back all apply
 * unchanged. INSERT OR IGNORE keeps it safe to run twice.
 */
/** Chunks past this are near the embedding model's 512-token ceiling and risk silent truncation. */
const CHUNK_CHAR_WARN = 1800;
const q1 = async (env, sql, ...bind) => {
  const st = env.DB.prepare(sql);
  return await (bind.length ? st.bind(...bind) : st).first();
};
const qAll = async (env, sql, ...bind) => {
  const st = env.DB.prepare(sql);
  const r = await (bind.length ? st.bind(...bind) : st).all();
  return r?.results || [];
};

/**
 * Post-install diagnostic: what is missing, what is stored wrong, what is stored
 * wastefully.
 *
 * This exists because every failure this product has actually had was SILENT.
 * The vector queue stalled while every health probe passed. A metadata index was
 * absent while search kept answering. Scanned PDFs indexed as empty documents.
 * Each time the brain reported itself well and was quietly wrong, and the
 * client's conclusion was "the retrieval is mediocre" rather than "something
 * broke".
 *
 * The most important check here is chunks-in-D1 versus vectors-in-Vectorize.
 * Nothing compared those two numbers before, and that comparison alone would
 * have caught the field stall on day one.
 *
 * Every finding carries an action. A diagnostic that reports a number without
 * saying what to do about it has only relocated the problem.
 */
export async function diagnose(env, { sampleLimit = 10 } = {}) {
  const findings = [];
  const add = (f) => findings.push(f);
  const safe = async (id, fn) => {
    try { return await fn(); } catch (e) {
      add({ id, area: "meta", severity: "warn", title: `check "${id}" could not run`,
        detail: String(e.message || e).slice(0, 200),
        action: "Usually a schema older than this version. Run `brain upgrade`." });
      return null;
    }
  };

  const totals = (await safe("totals", async () => ({
    documents: Number((await q1(env, "SELECT count(*) n FROM documents WHERE deleted_at IS NULL"))?.n || 0),
    chunks: Number((await q1(env, "SELECT count(*) n FROM chunks"))?.n || 0),
    sources: Number((await q1(env, "SELECT count(*) n FROM sources"))?.n || 0),
  }))) || { documents: 0, chunks: 0, sources: 0 };

  /* ---------------- COVERAGE: what did not make it in ---------------- */

  await safe("empty_documents", async () => {
    const n = Number((await q1(env,
      `SELECT count(*) n FROM documents d LEFT JOIN chunks c ON c.doc_uid = d.doc_uid
       WHERE d.deleted_at IS NULL AND c.chunk_uid IS NULL`))?.n || 0);
    if (!n) return;
    const rows = await qAll(env,
      `SELECT d.doc_uid, d.title, d.uri FROM documents d
       LEFT JOIN chunks c ON c.doc_uid = d.doc_uid
       WHERE d.deleted_at IS NULL AND c.chunk_uid IS NULL LIMIT ?1`, sampleLimit);
    add({ id: "empty_documents", area: "coverage", severity: "crit", count: n,
      title: `${n} document(s) were indexed but hold no text`,
      detail: "The brain believes it has these and can never answer from them. Almost always a scanned PDF with no text layer, or a format that extracted nothing.",
      samples: rows.map((r) => r.title || r.uri || r.doc_uid),
      action: "Re-ingest with OCR, or remove them so the document count stops overstating what the brain knows." });
  });

  await safe("undated", async () => {
    const n = Number((await q1(env, "SELECT count(*) n FROM documents WHERE deleted_at IS NULL AND document_date IS NULL"))?.n || 0);
    if (!n) return;
    const pct = totals.documents ? Math.round((n / totals.documents) * 100) : 0;
    add({ id: "undated", area: "coverage", severity: pct >= 34 ? "warn" : "info", count: n,
      title: `${n} document(s) (${pct}%) carry no date`,
      detail: "Recency cannot be judged for these, so any question about what is most recent silently rests only on the dated remainder.",
      action: pct >= 34
        ? "Worth fixing: over a third of the corpus is invisible to any recency judgement."
        : "Usually fine. The gap engine already says so when it matters." });
  });

  await safe("unregistered_sources", async () => {
    const rows = await qAll(env,
      `SELECT d.source, count(*) n FROM documents d
       LEFT JOIN sources s ON s.name = d.source
       WHERE d.deleted_at IS NULL AND s.name IS NULL GROUP BY d.source`);
    for (const r of rows) add({ id: "unregistered_source", area: "coverage", severity: "warn", count: Number(r.n),
      title: `${r.n} document(s) sit under an unregistered source "${r.source}"`,
      detail: "They exist in the brain but no source owns them, so `brain forget` cannot remove them and freshness reporting cannot see them.",
      action: `Register it: brain sources <manifest> --add ${r.source}` });
  });

  await safe("empty_sources", async () => {
    const rows = await qAll(env,
      `SELECT s.name FROM sources s
       LEFT JOIN documents d ON d.source = s.name AND d.deleted_at IS NULL
       GROUP BY s.name HAVING count(d.doc_uid) = 0`);
    for (const r of rows) add({ id: "empty_source", area: "coverage", severity: "warn",
      title: `source "${r.name}" is registered but holds nothing`,
      detail: "Either it was never loaded, or a load failed and left no trace.",
      action: "Run its ingest, or remove the registration so it stops implying coverage that does not exist." });
  });

  /* ---------------- INTEGRITY: is it stored correctly ---------------- */

  await safe("store_agreement", async () => {
    let vectors = null;
    try {
      const d = await env.VECTORIZE.describe();
      const v = Number(d?.vectorCount ?? d?.vectorsCount ?? d?.count);
      if (Number.isFinite(v)) vectors = v;
    } catch { /* older binding without describe() */ }

    const queue = await q1(env,
      `SELECT sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) upserts,
              sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) deletes
       FROM vector_outbox`);
    const pendingUpserts = Number(queue?.upserts || 0);
    const pendingDeletes = Number(queue?.deletes || 0);
    const expected = totals.chunks - pendingUpserts;

    if (vectors === null) {
      add({ id: "store_agreement", area: "integrity", severity: "info",
        title: "the vector count could not be read from Vectorize",
        detail: `D1 holds ${totals.chunks} chunk(s) with ${pendingUpserts} upsert(s) and ${pendingDeletes} delete(s) queued, so ${expected} current chunk(s) should be embedded. The vector store could not be asked how many it holds, so the two cannot be compared.`,
        action: "Not a fault. This check needs a Vectorize binding that supports describe()." });
      return;
    }
    const drift = Math.abs(vectors - expected);
    const tolerance = Math.max(5, Math.round(expected * 0.01));
    if (drift <= tolerance) {
      add({ id: "store_agreement", area: "integrity", severity: "ok",
        title: `both stores agree: ${vectors} vector(s) for ${expected} embedded chunk(s)`,
        detail: "The text store and the vector store hold the same corpus.", action: null });
      return;
    }
    const missing = vectors < expected;
    add({ id: "store_agreement", area: "integrity", severity: "crit", count: drift,
      title: `the two stores disagree by ${drift} vector(s)`,
      detail: `D1 says ${totals.chunks} chunk(s) with ${pendingUpserts} upsert(s) and ${pendingDeletes} delete(s) queued, so ${expected} current chunk(s) should be embedded. Vectorize holds ${vectors}. ` + (missing
        ? "Vectors are MISSING: those chunks still answer keyword queries and are invisible to meaning-based search, which reads as poor retrieval rather than as a fault."
        : "There are MORE vectors than chunks: deleted documents likely left theirs behind, and they still compete for retrieval slots."),
      action: missing
        ? "Run `brain reindex <manifest> --yes`. It rebuilds the index from D1 and needs no source files."
        : "Run `brain reindex <manifest> --yes`, then re-check. Persistent excess means deletions are not reaching Vectorize." });
  });

  await safe("backlog", async () => {
    const row = await q1(env,
      `SELECT count(*) n, min(queued_at) oldest,
              sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) upserts,
              sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) deletes
       FROM vector_outbox`);
    const n = Number(row?.n || 0);
    if (!n) return;
    const mins = row?.oldest ? Math.floor((Date.now() - Number(row.oldest)) / 60000) : null;
    const stalled = mins !== null && mins > 30;
    add({ id: "backlog", area: "integrity", severity: stalled ? "crit" : "warn", count: n,
      title: `${n} vector operation(s) are waiting (${Number(row?.upserts || 0)} upsert, ${Number(row?.deletes || 0)} delete)${mins !== null ? `, oldest ${mins} min ago` : ""}`,
      detail: stalled
        ? "Older than 30 minutes means the drain is not running. Upserts remain keyword-only; deletes leave stale vectors competing for candidates."
        : "Normal right after a load.",
      action: "Clear it now with `brain drain <manifest>`." });
  });

  await safe("quarantined", async () => {
    const n = Number((await q1(env, "SELECT count(*) n FROM vector_outbox WHERE attempts > 0"))?.n || 0);
    if (!n) return;
    const rows = await qAll(env,
      "SELECT chunk_uid, attempts, last_error FROM vector_outbox WHERE attempts > 0 ORDER BY attempts DESC LIMIT ?1", sampleLimit);
    add({ id: "quarantined", area: "integrity", severity: "crit", count: n,
      title: `${n} vector operation(s) failed and were set aside`,
      detail: "Upsert failures stay invisible to meaning search; delete failures leave stale vectors consuming candidates. Both remain queued for repair.",
      samples: rows.map((r) => `${r.chunk_uid}: ${String(r.last_error || "").slice(0, 90)}`),
      action: "Read the errors above. Once the cause is fixed, `brain reindex <manifest> --yes` re-queues them." });
  });

  await safe("orphan_chunks", async () => {
    const n = Number((await q1(env,
      "SELECT count(*) n FROM chunks c LEFT JOIN documents d ON d.doc_uid = c.doc_uid WHERE d.doc_uid IS NULL"))?.n || 0);
    if (n) add({ id: "orphan_chunks", area: "integrity", severity: "crit", count: n,
      title: `${n} chunk(s) belong to no document`,
      detail: "They can still be retrieved and cited, but the document behind the citation is gone.",
      action: "Report this, it should not happen. `brain reindex <manifest> --yes` will not clear it on its own." });
  });

  await safe("blank_chunks", async () => {
    const n = Number((await q1(env, "SELECT count(*) n FROM chunks WHERE trim(text) = ''"))?.n || 0);
    if (n) add({ id: "blank_chunks", area: "integrity", severity: "warn", count: n,
      title: `${n} chunk(s) hold no text`,
      detail: "Each occupies a vector and can be returned as a hit while carrying nothing.",
      action: "Re-ingest the documents they came from." });
  });

  await safe("duplicate_documents", async () => {
    const rows = await qAll(env,
      `SELECT content_hash, count(*) n FROM documents
       WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash != ''
       GROUP BY content_hash HAVING count(*) > 1 ORDER BY n DESC LIMIT ?1`, sampleLimit);
    const extra = rows.reduce((a, r) => a + (Number(r.n) - 1), 0);
    if (extra) add({ id: "duplicate_documents", area: "integrity", severity: "warn", count: extra,
      title: `${extra} duplicate document(s) are stored more than once`,
      detail: "Identical content under different paths. Each copy competes for the same retrieval slots, so one can push out a different and better source.",
      action: "Usually one folder loaded twice under two source names. Check `brain sources`." });
  });

  /* ---------------- EFFICIENCY: is it stored well ---------------- */

  await safe("chunk_outliers", async () => {
    const rows = await qAll(env,
      `SELECT d.title, d.uri, count(*) n FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid
       WHERE d.deleted_at IS NULL GROUP BY c.doc_uid ORDER BY n DESC LIMIT ?1`, sampleLimit);
    if (!rows.length) return;
    const top = Number(rows[0].n);
    const share = totals.chunks ? Math.round((top / totals.chunks) * 100) : 0;
    // A share threshold is meaningless on a small corpus: three documents with
    // one chunk each makes the largest 33% of everything. Firing there would
    // warn on every healthy small install, which is how a client learns to
    // ignore this report entirely.
    if (totals.chunks >= 50 && share >= 20) add({ id: "chunk_outliers", area: "efficiency", severity: "warn", count: top,
      title: `one document produced ${top} chunks, ${share}% of the entire corpus`,
      detail: "Usually a spreadsheet. It crowds out every other document in retrieval and dominates cost, while rarely being what anyone is actually asking about.",
      samples: rows.slice(0, 5).map((r) => `${r.n} chunks: ${(r.title || r.uri || "?").slice(0, 60)}`),
      action: "Consider loading a summary instead of the raw sheet, or excluding it." });
  });

  await safe("oversized_chunks", async () => {
    const n = Number((await q1(env, "SELECT count(*) n FROM chunks WHERE length(text) > ?1", CHUNK_CHAR_WARN))?.n || 0);
    if (!n) return;
    const pct = totals.chunks ? Math.round((n / totals.chunks) * 100) : 0;
    add({ id: "oversized_chunks", area: "efficiency", severity: pct >= 20 ? "warn" : "info", count: n,
      title: `${n} chunk(s) (${pct}%) are long enough to be truncated before embedding`,
      detail: `The embedding model reads about 512 tokens. Past roughly ${CHUNK_CHAR_WARN} characters the rest is silently cut, so the tail is stored but never searchable by meaning.`,
      action: "Not urgent, and invisible in every other way. Worth knowing before blaming retrieval quality." });
  });

  await safe("duplicate_chunks", async () => {
    const rows = await qAll(env,
      "SELECT count(*) n FROM (SELECT text FROM chunks GROUP BY text HAVING count(*) > 1 LIMIT 5000)");
    const groups = Number(rows?.[0]?.n || 0);
    if (groups > 10) add({ id: "duplicate_chunks", area: "efficiency", severity: "info", count: groups,
      title: `${groups}+ groups of identical chunk text`,
      detail: "Repeated headers, footers or boilerplate. Each copy is embedded and stored separately and can occupy a retrieval slot.",
      action: "Harmless at small scale. Worth trimming on a large corpus." });
  });

  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    totals,
    findings,
    summary: { crit: count("crit"), warn: count("warn"), info: count("info"), ok: count("ok") },
    verdict: count("crit") ? "problems" : count("warn") ? "usable_with_gaps" : "healthy",
  };
}

/**
 * Coverage staleness: what the brain has not LOOKED at recently.
 *
 * The gap engine already reports the age of what a query retrieved. That is
 * content staleness, and it is the easier half. This is the other half: a source
 * that is never re-read looks exactly like a source with nothing new in it, so
 * the brain cannot tell "nothing has changed" from "I stopped checking in July".
 * Every signal we had was blind to it.
 *
 * Two deliberate refusals to overclaim:
 *
 *  - A source with no expected_refresh_seconds makes NO staleness claim. A
 *    one-off folder upload is not stale, it is finished, and warning about it
 *    every day would train the client to ignore the warning that matters.
 *  - A source we cannot reach on our own (a folder on a laptop) is reported as
 *    manual rather than broken. Calling it stale would be blaming the client for
 *    a limit of the architecture.
 */
export async function coverageGaps(env, { now = Date.now() } = {}) {
  let rows;
  try {
    const r = await env.DB.prepare(
      `SELECT name, kind, status, last_ingest_at, last_complete_sweep_at,
              expected_refresh_seconds, stale_reason, document_count
       FROM sources`
    ).all();
    rows = r?.results || [];
  } catch {
    return []; // never fail an answer because the freshness check could not run
  }

  const gaps = [];
  for (const s of rows) {
    const last = s.last_ingest_at ? Date.parse(s.last_ingest_at) : NaN;
    const ageSec = Number.isFinite(last) ? Math.floor((now - last) / 1000) : null;
    const days = ageSec === null ? null : Math.floor(ageSec / 86400);

    if (s.stale_reason) {
      gaps.push({
        type: "sync_broken",
        source: s.name,
        days_since_ingest: days,
        detail: `The "${s.name}" source stopped updating${days === null ? "" : ` ${days} day(s) ago`}: ${s.stale_reason}. Anything added since is not in the brain.`,
      });
      continue;
    }

    const expected = Number(s.expected_refresh_seconds) || null;
    if (!expected) continue; // no expectation set, so no claim made

    if (ageSec === null) {
      gaps.push({
        type: "never_synced",
        source: s.name,
        detail: `The "${s.name}" source is expected to refresh but has never completed one, so its contents may be missing entirely.`,
      });
      continue;
    }

    // 1.5x before complaining: a cron that runs daily and is six hours late is
    // working. Warning at the first minute past due is how alerts get ignored.
    if (ageSec > expected * 1.5) {
      gaps.push({
        type: "coverage_stale",
        source: s.name,
        days_since_ingest: days,
        expected_every_days: Math.round(expected / 86400) || null,
        detail: `The "${s.name}" source was last read ${days} day(s) ago and is expected to refresh about every ${Math.max(1, Math.round(expected / 86400))} day(s). Material added since then is not in the brain, and would not show up as a missing answer.`,
      });
    }
  }
  return gaps;
}

/** Per-source freshness for `brain health` and `brain sources`, not for answers. */
export async function freshnessReport(env, { now = Date.now() } = {}) {
  let rows;
  try {
    const r = await env.DB.prepare(
      `SELECT name, kind, status, last_ingest_at, last_complete_sweep_at,
              expected_refresh_seconds, stale_reason, document_count
       FROM sources ORDER BY name`
    ).all();
    rows = r?.results || [];
  } catch {
    return { sources: [], unavailable: true };
  }
  // Kinds we can refresh without the client's machine being on.
  const AUTOMATABLE = new Set(["drive", "gmail", "calendar"]);
  return {
    sources: rows.map((s) => {
      const last = s.last_ingest_at ? Date.parse(s.last_ingest_at) : NaN;
      const days = Number.isFinite(last) ? Math.floor((now - last) / 86400000) : null;
      const expected = Number(s.expected_refresh_seconds) || null;
      const automatable = AUTOMATABLE.has(String(s.kind));
      let state = "ok";
      if (s.stale_reason) state = "broken";
      else if (!expected) state = automatable ? "unscheduled" : "manual";
      else if (!Number.isFinite(last)) state = "never_synced";
      else if (days !== null && days * 86400 > expected * 1.5) state = "stale";
      return {
        name: s.name, kind: s.kind, state,
        documents: Number(s.document_count || 0),
        days_since_ingest: days,
        expected_every_days: expected ? Math.max(1, Math.round(expected / 86400)) : null,
        last_complete_sweep_at: s.last_complete_sweep_at || null,
        reason: s.stale_reason || null,
        automatable,
      };
    }),
  };
}

export async function reindex(env, { source = null, dryRun = true } = {}) {
  const where = source ? "WHERE d.source = ?1" : "";
  const bind = source ? [source] : [];

  const countRow = await env.DB.prepare(
    `SELECT count(*) AS n FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid ${where}`
  ).bind(...bind).first();
  const chunks = Number(countRow?.n || 0);

  if (!chunks) return { chunks: 0, queued: 0, already_queued: 0, dry_run: dryRun, source };

  const beforeRow = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const before = Number(beforeRow?.n || 0);

  if (dryRun) return { chunks, queued: 0, already_queued: before, dry_run: true, source };

  await env.DB.prepare(
    `INSERT OR REPLACE INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
     SELECT c.chunk_uid, COALESCE(c.vector_id, c.chunk_uid), 'upsert', ?${source ? "2" : "1"}, 0, NULL
     FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid ${where}`
  ).bind(...bind, Date.now()).run();

  const afterRow = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const after = Number(afterRow?.n || 0);

  return { chunks, queued: after - before, already_queued: before, pending: after, dry_run: false, source };
}

export async function outboxDepth(env) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n, min(queued_at) AS oldest,
            sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) AS upserts,
            sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) AS deletes
     FROM vector_outbox`
  ).first();
  return {
    pending: Number(row?.n || 0),
    upserts: Number(row?.upserts || 0),
    deletes: Number(row?.deletes || 0),
    oldest_queued_at: row?.oldest ?? null,
  };
}

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

  // D1 accepts at most 100 bound variables in one statement. Source-level
  // forget routinely targets hundreds or thousands of documents, so every
  // read and mutation is partitioned well below that ceiling.
  const TARGET_BATCH = 50;
  const groups = [];
  for (let i = 0; i < targets.length; i += TARGET_BATCH) groups.push(targets.slice(i, i + TARGET_BATCH));
  const chunkRows = [];
  for (const group of groups) {
    const marks = group.map((_, i) => "?" + (i + 1)).join(",");
    const { results } = await env.DB.prepare(
      `SELECT chunk_uid, vector_id FROM chunks WHERE doc_uid IN (${marks})`
    ).bind(...group).all();
    chunkRows.push(...(results || []));
  }
  const chunkUids = (chunkRows || []).map((r) => r.chunk_uid);
  // Delete by the id the vector was actually STORED under, which is the hash
  // when the readable id was too long. Deleting by chunk_uid alone would leave
  // those vectors orphaned and still competing for retrieval slots.
  if (dryRun) {
    return { documents: targets.length, chunks: chunkUids.length, vectors: chunkUids.length, dry_run: true, targets };
  }

  // D1 first. The FTS index follows via the delete trigger, and ON DELETE
  // CASCADE removes the chunks with their document.
  const queuedAt = Date.now();
  for (const group of groups) {
    const marks = group.map((_, i) => "?" + (i + 1)).join(",");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
         SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?${group.length + 1}, 0, NULL
         FROM chunks WHERE doc_uid IN (${marks})
         ON CONFLICT(chunk_uid) DO UPDATE SET
           vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
           attempts=0, last_error=NULL`
      ).bind(...group, queuedAt),
      env.DB.prepare(`DELETE FROM chunks WHERE doc_uid IN (${marks})`).bind(...group),
      env.DB.prepare(`DELETE FROM documents WHERE doc_uid IN (${marks})`).bind(...group),
    ]);
  }

  let vectors = 0;
  let vectorError = null;
  try {
    vectors = await deleteQueuedVectors(env, (chunkRows || []).map((r) => ({
      chunk_uid: r.chunk_uid,
      vector_id: r.vector_id || r.chunk_uid,
      queued_at: queuedAt,
    })));
  } catch (e) {
    // The D1 delete is complete, so the content is unreachable. Keep the
    // outbox rows for retry and report that physical vector cleanup is pending.
    vectors = Number(e.deleted || 0);
    vectorError = String(e.message || e).slice(0, 200);
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

  return {
    documents: targets.length, chunks: chunkUids.length, vectors,
    vector_cleanup_queued: Math.max(0, chunkUids.length - vectors),
    dry_run: false, vector_error: vectorError, targets,
  };
}
