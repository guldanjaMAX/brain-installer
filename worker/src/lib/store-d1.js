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
 * throws cross-system magnitudes away and uses rank position only, which makes
 * the incomparability disappear. FTS magnitude is consulted only within its
 * own result list to recognize a clearly isolated lexical champion; it is never
 * blended with cosine similarity. Same arithmetic the Postgres version used;
 * the only difference is gathering the lists over two calls instead of one
 * query.
 */

import { currentEvidenceCandidates } from "./query-intent.js";

const RRF_K = 60;
const LEXICAL_CHAMPION_RATIO = 4;
const LEXICAL_CHAMPION_TARGET_RANK = 5;
const CURRENT_INTENT_RRF_WEIGHT = 1.25;
// The answer route reads at most 900 characters from a retrieved snippet. Keep
// both modalities inside that window when their best chunks differ, rather than
// letting either a keyword-heavy header or a semantically similar preamble erase
// the other chunk's evidence.
const COMPOSED_EVIDENCE_PART_MAX_CHARS = 400;

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
export const D1_QUERY_BIND_LIMIT = 100;
// Keep one transaction reviewable and bounded independently of the documented
// 1,000-query invocation limit. This is our conservative internal slice, not a
// claimed D1 per-batch platform ceiling. Each chunk needs two statements.
export const D1_TRANSACTION_SLICE_STATEMENTS = 100;
// Ranking prefixes must not change because one route asked for 8 results and
// another asked for 12. Both retrieval systems always contribute the same
// bounded candidate depth; `limit` is applied only after fusion.
export const RETRIEVAL_CANDIDATE_DEPTH = VECTOR_TOPK_MAX;

/**
 * Reciprocal rank fusion.
 *
 * score(d) = sum over lists of  weight / (k + rank(d))
 *
 * A document absent from a list contributes nothing rather than a penalty,
 * which is what lets a strong keyword hit with no vector match still surface.
 */
export function fuseRRF(lists, { k = RRF_K, keyOf = (item) => item?.chunk_uid } = {}) {
  const scores = new Map();
  const seen = new Map();
  let sequence = 0;
  for (const { items, weight = 1.0, itemWeight = () => 1.0 } of lists) {
    items.forEach((item, i) => {
      const uid = keyOf(item);
      if (!uid) return;
      const multiplier = Number(itemWeight(item));
      const contribution = Number(weight) * (Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1) / (k + i + 1);
      if (!Number.isFinite(contribution) || contribution <= 0) return;
      scores.set(uid, (scores.get(uid) || 0) + contribution);
      const prior = seen.get(uid);
      if (!prior || contribution > prior.contribution) {
        seen.set(uid, { item, contribution, sequence: prior?.sequence ?? sequence++ });
      }
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || seen.get(a[0]).sequence - seen.get(b[0]).sequence)
    .map(([uid, score]) => ({ ...seen.get(uid).item, rrf_score: score }));
}

/** Public retrieval is document-ranked even though both indexes store chunks. */
export function retrievalDocumentKey(row) {
  return row?.content_hash
    ? `${row.source || ""}|${row.content_hash}|${row.document_date ?? "undated"}`
    : row?.doc_uid || `${row?.source || ""}|${row?.source_id || row?.title || row?.chunk_uid}`;
}

export function collapseRankedDocuments(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = retrievalDocumentKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function exactTermPositions(text, term) {
  const positions = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(term, cursor);
    if (index < 0) break;
    const before = index === 0 ? "" : text[index - 1];
    const afterIndex = index + term.length;
    const after = afterIndex >= text.length ? "" : text[afterIndex];
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) positions.push(index);
    cursor = index + Math.max(1, term.length);
  }
  return positions;
}

function boundedEvidencePart(value, query) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= COMPOSED_EVIDENCE_PART_MAX_CHARS) return text;

  const lower = text.toLowerCase();
  const terms = [...new Set(String(query || "").toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((term) => term.length >= 2 && !FTS_STOPWORDS.has(term))
    .map((term, order) => ({ term, order, positions: exactTermPositions(lower, term) }))
    .filter((entry) => entry.positions.length > 0)
    .sort((a, b) =>
      a.positions.length - b.positions.length || b.term.length - a.term.length || a.order - b.order
    );

  let anchor = 0;
  if (terms.length) {
    // Anchor on the rarest matching query term. For repeated occurrences, use
    // the window containing the most other query terms. This keeps an exact
    // fact near the end of a long chunk instead of returning only its preamble.
    let bestCoverage = -1;
    for (const position of terms[0].positions) {
      const start = Math.max(0, Math.min(
        text.length - COMPOSED_EVIDENCE_PART_MAX_CHARS,
        position - Math.floor(COMPOSED_EVIDENCE_PART_MAX_CHARS / 2),
      ));
      const window = lower.slice(start, start + COMPOSED_EVIDENCE_PART_MAX_CHARS);
      const coverage = terms.reduce((count, entry) => count + (window.includes(entry.term) ? 1 : 0), 0);
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        anchor = position;
      }
    }
  }

  const start = Math.max(0, Math.min(
    text.length - COMPOSED_EVIDENCE_PART_MAX_CHARS,
    anchor - Math.floor(COMPOSED_EVIDENCE_PART_MAX_CHARS / 2),
  ));
  const end = start + COMPOSED_EVIDENCE_PART_MAX_CHARS;
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = `…${excerpt.slice(1)}`;
  if (end < text.length) excerpt = `${excerpt.slice(0, -1).trimEnd()}…`;
  return excerpt;
}

/**
 * One document can match keywords in one chunk and semantics in another. RRF
 * ranks the document, so its public evidence must preserve both independent
 * reasons it ranked. The bounded composition fits in /think's prompt window and
 * remains deterministic; identical chunks are emitted only once.
 */
function composeDocumentEvidence(vectorRow, keywordRow, query) {
  if (!keywordRow) return vectorRow;
  if (!vectorRow) return keywordRow;

  const keywordText = boundedEvidencePart(keywordRow.text, query);
  const vectorText = boundedEvidencePart(vectorRow.text, query);
  if (!keywordText) return { ...keywordRow, text: vectorText };
  if (!vectorText || keywordRow.chunk_uid === vectorRow.chunk_uid || keywordText === vectorText) {
    return { ...keywordRow, text: keywordText };
  }
  return {
    ...keywordRow,
    text: `Keyword-matched excerpt:\n${keywordText}\n\nSemantic excerpt from the same document:\n${vectorText}`,
  };
}

/**
 * Translate the supported filters into a SQL fragment.
 *
 * All public filters have real D1 columns. Dropping a filter is worse than
 * rejecting it: the answer comes back looking narrowed when it never was.
 */
export const D1_FILTERS = ["source", "entity_slug", "client", "category", "top_folder", "platform", "from", "to"];
export const D1_UNSUPPORTED = [];

export function filterSql(filters = {}, alias = "c", nextParam = 3) {
  const parts = [];
  const params = [];
  const add = (frag, val) => { parts.push(frag.replace("?N", "?" + nextParam++)); params.push(val); };
  if (filters.source) add(`${alias}.source = ?N`, filters.source);
  // Business scope lives on documents. Both retrieval paths hydrate chunks
  // through D1, so this exact predicate is the authority even when Vectorize
  // was queried with the equivalent client pre-filter for candidate recall.
  if (filters.entity_slug) {
    add(`EXISTS (SELECT 1 FROM documents scope_d WHERE scope_d.doc_uid = ${alias}.doc_uid AND scope_d.entity_slug = ?N)`, filters.entity_slug);
  }
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

/** Exact D1 authority for a scoped principal. */
export function documentAccessSql(access, chunkAlias = "c", documentAlias = "d", nextParam = 3) {
  if (!access || access.kind !== "grant") return { clause: "", params: [], nextParam };
  if (!access.grantId || !access.entitySlug) {
    // An unreadable or empty grant is never interpreted as an unscoped read.
    return { clause: " AND 1 = 0", params: [], nextParam };
  }
  const grantParameter = `?${nextParam++}`;
  const entityParameter = `?${nextParam++}`;
  return {
    clause:
      ` AND ${documentAlias}.entity_slug = ${entityParameter}` +
      ` AND EXISTS (` +
      `SELECT 1 FROM document_access_documents access_doc ` +
      `WHERE access_doc.grant_id = ${grantParameter} ` +
      `AND access_doc.document_id = ${chunkAlias}.doc_uid ` +
      `AND access_doc.entity_slug = ${documentAlias}.entity_slug ` +
      `AND access_doc.revoked_at IS NULL)`,
    params: [access.grantId, access.entitySlug],
    nextParam,
  };
}

/** A coarse capability grant's zone boundary, applied where chunk text is read. */
export function scopeSql(scope, alias = "c", nextParam = 1) {
  if (!scope || scope.all === true) return { clause: "", params: [], nextParam };
  const include = Array.isArray(scope.zones) ? scope.zones.filter(Boolean) : [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.filter(Boolean) : [];
  if (!include.length) return { clause: " AND 1 = 0", params: [], nextParam };
  const params = [];
  const inList = include.map(() => `?${nextParam++}`).join(",");
  params.push(...include);
  let clause = ` AND ${alias}.source IN (SELECT name FROM sources WHERE zone IN (${inList}))`;
  if (exclude.length) {
    const outList = exclude.map(() => `?${nextParam++}`).join(",");
    params.push(...exclude);
    clause += ` AND ${alias}.source NOT IN (SELECT name FROM sources WHERE zone IN (${outList}))`;
  }
  return { clause, params, nextParam };
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
  // Not indexed and never used as a public filter. This is the durable receipt
  // that distinguishes an old vector with the same id from the exact outbox
  // generation just accepted by Vectorize's asynchronous mutation API.
  const generation = Number(row.generation);
  if (Number.isSafeInteger(generation) && generation > 0) {
    metadata.outbox_generation = String(generation);
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
  // Entity scope is authoritative only in D1 today. `vector_client` is a
  // private candidate hint, never a D1 predicate and never accepted from the
  // public request body. Scoped search remains explicitly degraded until a
  // canonical entity metadata index is built and reprojected.
  if (filters.vector_client && !filters.client) {
    const token = await metadataTokenFor(filters.vector_client);
    if (token !== null) filter.client = { $eq: token };
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

export async function searchKeyword(env, query, { limit, filters = {}, access = null, scope = null } = {}) {
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
  // At roughly 1,000 chunks the difference is invisible, which is why this
  // shipped. It grows with the corpus and reads as "retrieval feels slow"
  // rather than as a fault.
  const content = raw.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase()));

  // A query made entirely of stopwords is still a query. Falling back to the
  // raw terms is slow but correct, and returning nothing would not be.
  const use = content.length ? content : raw;
  const terms = use.map((t) => `"${t}"`).join(" OR ");
  if (!terms) return [];

  const f = filterSql(filters, "c", 3);
  const sc = scopeSql(scope, "c", f.nextParam);
  const a = documentAccessSql(access, "c", "d", sc.nextParam);
  const sql = `
    SELECT c.chunk_uid, c.doc_uid, c.text, c.source, c.title, c.document_date,
           c.client, c.category, c.top_folder, c.platform,
           d.source_id, d.uri, d.entity_slug, d.content_hash, d.date_source, d.date_reliable,
           d.text_source, d.text_reliable,
           bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.doc_uid = c.doc_uid
    WHERE chunks_fts MATCH ?1${f.clause}${sc.clause}${a.clause}
    ORDER BY bm25(chunks_fts)
    LIMIT ?2`;

  const { results } = await env.DB.prepare(sql).bind(
    terms, limit, ...f.params, ...sc.params, ...a.params,
  ).all();
  return results || [];
}

/** Vector search over Vectorize, hydrated and filtered in D1. */
export async function searchVector(env, embedding, { limit, filters = {}, scope = null } = {}) {
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

  // D1 permits 100 bound values per statement. A full Vectorize page already
  // contains 100 ids, so adding even one exact-authority filter used to make
  // hydration fail and search silently degrade to keyword-only. Partition ids
  // after reserving bind slots for every filter, then restore Vectorize order.
  const f0 = filterSql(filters, "c", 1);
  const filterParameterCount = f0.params.length + scopeSql(scope, "c", f0.nextParam).params.length;
  const hydrationBatchSize = Math.max(1, D1_QUERY_BIND_LIMIT - filterParameterCount);
  const results = [];
  for (let start = 0; start < resolved.length; start += hydrationBatchSize) {
    const batch = resolved.slice(start, start + hydrationBatchSize);
    const placeholders = batch.map((_, i) => "?" + (i + 1)).join(",");
    const f = filterSql(filters, "c", batch.length + 1);
    const sc = scopeSql(scope, "c", f.nextParam);
    const { results: hydrated } = await env.DB.prepare(
      `SELECT c.chunk_uid, c.doc_uid, c.text, c.source, c.title, c.document_date,
              c.client, c.category, c.top_folder, c.platform,
              d.source_id, d.uri, d.entity_slug, d.content_hash, d.date_source, d.date_reliable,
              d.text_source, d.text_reliable
       FROM chunks c JOIN documents d ON d.doc_uid = c.doc_uid
       WHERE c.chunk_uid IN (${placeholders})${f.clause}${sc.clause}`
    )
      .bind(...batch, ...f.params, ...sc.params)
      .all();
    results.push(...(hydrated || []));
  }

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
export async function search(env, {
  query, embedding, limit = 10, filters = {}, weights = {}, rrfK = RRF_K, access = null, scope = null,
}) {
  const pool = RETRIEVAL_CANDIDATE_DEPTH;
  const fusionK = Math.min(Math.max(Number(rrfK) || RRF_K, 1), 1e3);

  const [kw, vec, projection] = await Promise.all([
    searchKeyword(env, query, { limit: pool, filters, access, scope }).catch(() => []),
    embedding && access?.kind !== "grant" && (!scope || scope.all === true)
      ? searchVector(env, embedding, { limit: pool, filters, scope }).catch(() => [])
      : Promise.resolve([]),
    // Vectorize may return some old/current candidates while a newer accepted
    // changeset is still processing. Non-empty semantic results therefore do
    // not prove the complete D1 corpus is query-visible. Reuse the exact
    // readiness contract that gates health and acceptance so every answer
    // advertises partial projection instead of looking fully healthy.
    embedding && access?.kind !== "grant" && (!scope || scope.all === true)
      ? vectorReadiness(env).catch(() => ({ ready: false }))
      : Promise.resolve(null),
  ]);

  // Both empty is a real answer (nothing matched). Only ONE empty when both
  // were attempted means a subsystem is down, and a caller that cannot tell
  // those apart will report a degraded brain as an empty one.
  //
  // The first branch fires on every freshly installed brain while its index is
  // still projecting, which is exactly when the owner asks their first
  // questions, so this is the ordinary state of a new install rather than a
  // rare fault. `degraded_reason` names WHICH of the two it was, because "still
  // building, ask again shortly" and "the vector query failed" call for
  // different sentences downstream. `degraded` keeps its existing values: it is
  // a wire field older clients already read.
  let degraded = null;
  let degradedReason = null;
  if (access?.kind === "grant") {
    degraded = "scoped-vector";
    degradedReason = "document-scope-keyword-only";
  } else if (scope && scope.all !== true) {
    degraded = "scoped-vector";
    degradedReason = "zone-scope-keyword-only";
  } else if (embedding && projection?.ready !== true) {
    degraded = "vector";
    degradedReason = "projection-incomplete";
  } else if (embedding && vec.length === 0 && kw.length > 0) {
    degraded = "vector";
    degradedReason = "vector-query-failed";
  } else if (!embedding) {
    degraded = "no-embedding";
    degradedReason = "embedding-unavailable";
  }
  if (filters.entity_slug && access?.kind !== "grant" && (!scope || scope.all === true)) {
    degraded = "vector";
    degradedReason = "entity-vector-authority-unindexed";
  }

  // Collapse BEFORE assigning rank positions. Otherwise ten chunks from one
  // file consume ten ranks, and keyword evidence in one chunk cannot combine
  // with semantic evidence from another chunk in the same document.
  const kwDocuments = collapseRankedDocuments(kw);
  const vecDocuments = collapseRankedDocuments(vec);

  const boundedWeight = (value, fallback = 1) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, 0), 10) : fallback;
  };
  const sourceWeight = (row) => Object.prototype.hasOwnProperty.call(weights, row?.source)
    ? boundedWeight(weights[row.source])
    : 1;

  // FTS5's score ratio is meaningful inside one query even though its absolute
  // magnitude is not comparable across corpora or with Vectorize similarity.
  // A bounded third rank list can retain a clearly isolated lexical document
  // without blending those incompatible scores.
  const vectorWeight = boundedWeight(weights.vector);
  const lexicalWeight = boundedWeight(weights.keyword);
  const firstKeyword = kwDocuments[0] || null;
  const firstKeywordMagnitude = Math.abs(Number(firstKeyword?.score));
  const firstKeywordKey = firstKeyword ? retrievalDocumentKey(firstKeyword) : null;
  const nextKeywordDocument = firstKeywordKey === null
    ? null
    : kwDocuments.find((row) => retrievalDocumentKey(row) !== firstKeywordKey) || null;
  const nextKeywordMagnitude = Math.abs(Number(nextKeywordDocument?.score));
  const hasSelectiveKeywordChampion =
    limit >= LEXICAL_CHAMPION_TARGET_RANK &&
    lexicalWeight > 0 &&
    sourceWeight(firstKeyword) > 0 &&
    Number.isFinite(firstKeywordMagnitude) &&
    nextKeywordDocument !== null &&
    Number.isFinite(nextKeywordMagnitude) &&
    nextKeywordMagnitude > 0 &&
    firstKeywordMagnitude >= nextKeywordMagnitude * LEXICAL_CHAMPION_RATIO;

  const rankLists = [
    { items: vecDocuments, weight: vectorWeight, itemWeight: sourceWeight },
    { items: kwDocuments, weight: lexicalWeight, itemWeight: sourceWeight },
  ];
  const currentInputs = [
    ...(vectorWeight > 0 ? vecDocuments : []),
    ...(lexicalWeight > 0 ? kwDocuments : []),
  ];
  const currentDocuments = collapseRankedDocuments(
    currentEvidenceCandidates(query, currentInputs, { filters, owner: env.BRAIN_OWNER }),
  );
  if (currentDocuments.length) {
    rankLists.push({ items: currentDocuments, weight: CURRENT_INTENT_RRF_WEIGHT, itemWeight: sourceWeight });
  }
  let fused = fuseRRF(rankLists, { k: fusionK, keyOf: retrievalDocumentKey });
  if (hasSelectiveKeywordChampion) {
    const rankedDocuments = fused;
    const championDocumentRank = rankedDocuments.findIndex(
      (row) => retrievalDocumentKey(row) === firstKeywordKey,
    );
    if (championDocumentRank >= LEXICAL_CHAMPION_TARGET_RANK) {
      const championChunk = fused.find((row) => retrievalDocumentKey(row) === firstKeywordKey);
      const cutoff = rankedDocuments[LEXICAL_CHAMPION_TARGET_RANK - 1];
      const requiredContribution = Number(cutoff?.rrf_score) - Number(championChunk?.rrf_score) + 1e-12;
      const championSourceWeight = sourceWeight(firstKeyword) || 1;
      const championBoostWeight = Math.min(
        lexicalWeight,
        Math.max(0, requiredContribution * (fusionK + 1) / championSourceWeight),
      );
      if (Number.isFinite(championBoostWeight) && championBoostWeight > 0) {
        fused = fuseRRF([
          ...rankLists,
          { items: [firstKeyword], weight: championBoostWeight, itemWeight: sourceWeight },
        ], { k: fusionK, keyOf: retrievalDocumentKey });
      }
    }
  }

  // RRF combines document scores, but an answer still needs concrete evidence.
  // Preserve both best chunks when the modalities found different passages in
  // the same document. Choosing either one unconditionally fixes one failure by
  // creating its mirror: a name-only keyword header can erase the semantic fact,
  // just as a generic vector chunk can erase an exact billing statement.
  const vectorRepresentatives = new Map();
  if (vectorWeight > 0) {
    for (const row of vecDocuments) {
      const key = retrievalDocumentKey(row);
      if (!vectorRepresentatives.has(key)) vectorRepresentatives.set(key, row);
    }
  }
  const keywordRepresentatives = new Map();
  if (lexicalWeight > 0) {
    for (const row of kwDocuments) {
      const key = retrievalDocumentKey(row);
      if (!keywordRepresentatives.has(key)) keywordRepresentatives.set(key, row);
    }
  }
  fused = fused.map((row) => {
    const key = retrievalDocumentKey(row);
    const representative = composeDocumentEvidence(
      vectorRepresentatives.get(key), keywordRepresentatives.get(key), query,
    );
    return representative
      ? { ...row, ...representative, rrf_score: row.rrf_score }
      : row;
  });

  const documents = [];
  for (const row of fused) {
    // content_hash is an internal dedupe key, not part of the authenticated
    // search response contract or a stable source identifier for clients.
    const { content_hash: _internalContentHash, ...publicRow } = row;
    documents.push(publicRow);
  }

  return {
    results: documents.slice(0, limit),
    degraded,
    degraded_reason: degradedReason,
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
export async function upsertChunks(env, chunks, { expectedContentHash = null } = {}) {
  if (!chunks.length) return { written: 0, queued: 0 };
  const now = Date.now();
  const guarded = typeof expectedContentHash === "string" && expectedContentHash.length > 0;

  const stmts = [];
  for (const c of chunks) {
    // Computed at write time so a search hit can be resolved back to its chunk
    // even when the id had to be hashed to fit Vectorize's 64-byte ceiling.
    c.vector_id = await vectorIdFor(c.chunk_uid);
    const chunkStatement = env.DB.prepare(
      guarded
        ? `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12
           WHERE EXISTS (
             SELECT 1 FROM documents WHERE doc_uid = ?2 AND content_hash = ?13
           )
           ON CONFLICT(chunk_uid) DO UPDATE SET
             text = excluded.text, title = excluded.title,
             document_date = excluded.document_date,
             client = excluded.client, category = excluded.category,
             top_folder = excluded.top_folder, platform = excluded.platform,
             vector_id = excluded.vector_id`
        : `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
           ON CONFLICT(chunk_uid) DO UPDATE SET
             text = excluded.text, title = excluded.title,
             document_date = excluded.document_date,
             client = excluded.client, category = excluded.category,
             top_folder = excluded.top_folder, platform = excluded.platform,
             vector_id = excluded.vector_id`
    ).bind(
      c.chunk_uid, c.doc_uid, c.chunk_ix, c.text, c.source, c.title ?? null,
      c.document_date ?? null, c.client ?? null, c.category ?? null,
      c.top_folder ?? null, c.platform ?? null, c.vector_id,
      ...(guarded ? [expectedContentHash] : [])
    );
    stmts.push(chunkStatement);

    const outboxStatement = env.DB.prepare(
      guarded
        ? `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
           SELECT ?1,?2,'upsert',?3
           WHERE EXISTS (
             SELECT 1 FROM documents WHERE doc_uid = ?4 AND content_hash = ?5
           )
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='upsert', queued_at=?3,
             attempts=0, last_error=NULL`
        : `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
           VALUES (?1,?2,'upsert',?3)
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='upsert', queued_at=?3,
             attempts=0, last_error=NULL`
    ).bind(
      c.chunk_uid, c.vector_id, now,
      ...(guarded ? [c.doc_uid, expectedContentHash] : [])
    );
    stmts.push(outboxStatement);
  }
  // A split document can still contain more than 50 chunks. Keep each internal
  // transaction in a conservative 100-statement slice; the pending marker makes
  // an interrupted later slice recoverable on ordinary retry.
  for (let start = 0; start < stmts.length; start += D1_TRANSACTION_SLICE_STATEMENTS) {
    await env.DB.batch(stmts.slice(start, start + D1_TRANSACTION_SLICE_STATEMENTS));
  }
  return { written: chunks.length, queued: chunks.length };
}

/**
 * A small changed document can stage its complete pending revision in one D1
 * transaction instead of four service-binding round trips. The three fixed
 * statements are the document upsert plus the old-vector queue and chunk
 * delete; every new chunk adds its durable row and outbox row.
 *
 * Larger documents stay on the original resumable path. The 100-statement
 * boundary is our conservative internal transaction slice, distinct from
 * Cloudflare's documented 1,000-query invocation limit. Keeping the fallback
 * means an installer never rejects a valid document merely to gain throughput.
 */
export function canStageDocumentRevision(chunkCount) {
  return Number.isSafeInteger(chunkCount) &&
    chunkCount >= 0 &&
    3 + (chunkCount * 2) <= D1_TRANSACTION_SLICE_STATEMENTS;
}

const hasVerifiedWrite = (result) =>
  Number.isSafeInteger(result?.meta?.changes) && result.meta.changes > 0;

/**
 * Atomically stage one document revision under its unique pending marker.
 *
 * The caller deliberately invokes this once per document. Combining multiple
 * documents into one transaction would save more round trips, but one poison
 * row would then roll back unrelated documents and destroy the batch route's
 * per-document failure-isolation contract.
 */
export async function stageDocumentRevision(env, {
  documentStatement,
  docUid,
  chunks,
  expectedContentHash,
}) {
  if (!documentStatement || typeof docUid !== "string" || !docUid ||
      typeof expectedContentHash !== "string" || !expectedContentHash ||
      !Array.isArray(chunks) || !canStageDocumentRevision(chunks.length)) {
    throw new Error("document revision is not eligible for atomic D1 staging");
  }

  const queuedAt = Date.now();
  const statements = [
    documentStatement,
    env.DB.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
       FROM chunks
       WHERE doc_uid = ?1
         AND EXISTS (
           SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?3
         )
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).bind(docUid, queuedAt, expectedContentHash),
    env.DB.prepare(
      `DELETE FROM chunks WHERE doc_uid = ?1
       AND EXISTS (
         SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?2
       )`
    ).bind(docUid, expectedContentHash),
  ];

  const requiredWriteIndexes = [0];
  for (const chunk of chunks) {
    chunk.vector_id = await vectorIdFor(chunk.chunk_uid);
    requiredWriteIndexes.push(statements.length);
    statements.push(env.DB.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client, category, top_folder, platform, vector_id)
       SELECT ?1,?2,?3,?4,?5,?6,?7,
              documents.client, documents.category, documents.top_folder, documents.platform, ?8
       FROM documents
       WHERE documents.doc_uid = ?2 AND documents.content_hash = ?9
       ON CONFLICT(chunk_uid) DO UPDATE SET
         text = excluded.text, title = excluded.title,
         document_date = excluded.document_date,
         client = excluded.client, category = excluded.category,
         top_folder = excluded.top_folder, platform = excluded.platform,
         vector_id = excluded.vector_id`
    ).bind(
      chunk.chunk_uid, chunk.doc_uid, chunk.chunk_ix, chunk.text, chunk.source,
      chunk.title ?? null, chunk.document_date ?? null, chunk.vector_id,
      expectedContentHash
    ));

    requiredWriteIndexes.push(statements.length);
    statements.push(env.DB.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
       SELECT ?1,?2,'upsert',?3
       WHERE EXISTS (
         SELECT 1 FROM documents WHERE doc_uid = ?4 AND content_hash = ?5
       )
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='upsert', queued_at=?3,
         attempts=0, last_error=NULL`
    ).bind(chunk.chunk_uid, chunk.vector_id, queuedAt, chunk.doc_uid, expectedContentHash));
  }

  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length) {
    throw new Error("atomic D1 staging returned an incomplete result set");
  }
  if (requiredWriteIndexes.some((index) => !hasVerifiedWrite(results[index]))) {
    // D1 includes trigger effects in meta.changes, so a successful guarded
    // write may report more than one row. Zero or a malformed count still means
    // ownership was not proven and must never receive a successful receipt.
    throw new Error("atomic D1 staging could not verify revision ownership");
  }

  return { written: chunks.length, queued: chunks.length };
}

/**
 * Queue every current vector for a document and remove its D1 chunks in one D1
 * transaction. A following upsert for a retained chunk uid changes that queue
 * row back to `upsert`; chunks removed by a shorter revision remain `delete`.
 */
export async function replaceDocumentChunks(env, docUid, { expectedContentHash = null } = {}) {
  const now = Date.now();
  const guarded = typeof expectedContentHash === "string" && expectedContentHash.length > 0;
  await env.DB.batch([
    env.DB.prepare(
      guarded
        ? `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
           SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
           FROM chunks
           WHERE doc_uid = ?1
             AND EXISTS (
               SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?3
             )
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
             attempts=0, last_error=NULL`
        : `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
           SELECT chunk_uid, COALESCE(vector_id, chunk_uid), 'delete', ?2, 0, NULL
           FROM chunks WHERE doc_uid = ?1
           ON CONFLICT(chunk_uid) DO UPDATE SET
             vector_id=excluded.vector_id, op='delete', queued_at=excluded.queued_at,
             attempts=0, last_error=NULL`
    ).bind(docUid, now, ...(guarded ? [expectedContentHash] : [])),
    env.DB.prepare(
      guarded
        ? `DELETE FROM chunks WHERE doc_uid = ?1
           AND EXISTS (
             SELECT 1 FROM documents WHERE doc_uid = ?1 AND content_hash = ?2
           )`
        : "DELETE FROM chunks WHERE doc_uid = ?1"
    ).bind(docUid, ...(guarded ? [expectedContentHash] : [])),
  ]);
}

/** Keep Vectorize deletion and its D1 CAS cleanup in conservative 100-row slices. */
const DELETE_BATCH = 100;

// The HTTP drain has a 180-second client deadline and both HTTP and cron paths
// are capped at ten 100-row batches. Twenty minutes is deliberately longer
// than one supported invocation while still making an abruptly terminated
// owner self-heal without operator access. This is a safety lease, not a lock
// that can remain held forever.
export const DRAIN_LEASE_TTL_MS = 20 * 60 * 1000;

// Cloudflare counts every statement submitted through D1, including each
// statement inside DB.batch(), toward the documented 1,000-query Worker
// invocation limit. Keep the drain below a stricter internal budget so its
// compare-and-swap lease release always has reserved headroom.
export const DRAIN_D1_QUERY_BUDGET = 900;
const DRAIN_LEASE_ACQUIRE_QUERIES = 1;
const DRAIN_LEASE_RELEASE_QUERIES = 1;
const DRAIN_PROJECTION_VERIFY_QUERIES = 1;
const DRAIN_INITIAL_DEPTH_QUERIES = 1;
const DRAIN_BATCH_SIZE_MAX = 100;

// One two-phase slice either submits or confirms. The largest path is an upsert
// submission: queue/fence/delete/upsert reads plus the durable fence, final
// depth, one submission receipt per row, and one legacy hashed-id remap per row.
// Confirmation needs only one CAS statement per row. Reserving this bound before
// provider work keeps the lease release inside the invocation budget.
export function drainBatchQueryUpperBound(batchSize = DRAIN_BATCH_SIZE_MAX) {
  const bounded = Number.isInteger(batchSize)
    ? Math.min(DRAIN_BATCH_SIZE_MAX, Math.max(1, batchSize))
    : DRAIN_BATCH_SIZE_MAX;
  // +1 renews and re-proves the owner immediately before the one possible
  // provider mutation in this slice. Five more cover the bounded legacy
  // bootstrap status/page/transaction/depth path when a confirmation empties
  // the current page.
  return 12 + (2 * bounded);
}

const drainLeaseChanges = (result) => Number(
  result?.meta?.changes ?? result?.changes ?? 0
);

/**
 * Atomically claim the one Vectorize-writer lease for this brain.
 *
 * The opaque owner is returned only to the in-memory caller so release can use
 * compare-and-swap. Busy receipts deliberately contain only aggregate timing;
 * neither an API response nor a log ever needs the owner token.
 */
export async function acquireDrainLease(env, {
  ownerToken = crypto.randomUUID(),
  now = Date.now(),
  ttlMs = DRAIN_LEASE_TTL_MS,
} = {}) {
  if (typeof ownerToken !== "string" || !ownerToken || ownerToken.length > 200) {
    throw new Error("vector drain lease owner is invalid");
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 ||
      ttlMs > DRAIN_LEASE_TTL_MS) {
    throw new Error("vector drain lease timing is invalid");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("vector drain lease expiry is invalid");
  }

  let claimed;
  try {
    claimed = await env.DB.prepare(
      `UPDATE install_state
       SET vector_drain_lease_owner = ?1,
           vector_drain_lease_expires_at = ?2
       WHERE id = 1
         AND schema_version >= 12
         AND (vector_drain_lease_owner IS NULL
              OR vector_drain_lease_expires_at IS NULL
              OR vector_drain_lease_expires_at <= ?3)`
    ).bind(ownerToken, expiresAt, now).run();
  } catch {
    throw new Error("vector drain lease could not be acquired");
  }
  if (drainLeaseChanges(claimed) === 1) {
    return { acquired: true, ownerToken, expiresAt };
  }

  // Do not read or return the current owner's token. The aggregate held/expiry
  // state is enough to distinguish a legitimate busy lease from a missing or
  // malformed install row, which must fail closed rather than start a drain.
  let state;
  try {
    state = await env.DB.prepare(
      `SELECT CASE WHEN vector_drain_lease_owner IS NULL THEN 0 ELSE 1 END AS held,
              CASE WHEN schema_version >= 12 THEN 1 ELSE 0 END AS schema_ready,
              vector_drain_lease_expires_at AS expires_at
       FROM install_state WHERE id = 1`
    ).first();
  } catch {
    throw new Error("vector drain lease state could not be verified");
  }
  if (!state || Number(state.schema_ready) !== 1 || Number(state.held) !== 1) {
    throw new Error("vector drain lease state is unavailable");
  }
  const observedExpiry = Number(state.expires_at);
  const retryAfterMs = Number.isSafeInteger(observedExpiry)
    ? Math.max(1_000, Math.min(DRAIN_LEASE_TTL_MS, observedExpiry - now))
    : DRAIN_LEASE_TTL_MS;
  return {
    acquired: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
  };
}

/** Release only the lease still owned by this invocation. */
export async function releaseDrainLease(env, ownerToken) {
  if (typeof ownerToken !== "string" || !ownerToken) return false;
  let released;
  try {
    released = await env.DB.prepare(
      `UPDATE install_state
       SET vector_drain_lease_owner = NULL,
           vector_drain_lease_expires_at = NULL
       WHERE id = 1 AND vector_drain_lease_owner = ?1`
    ).bind(ownerToken).run();
  } catch {
    throw new Error("vector drain lease could not be released; it will expire automatically");
  }
  return drainLeaseChanges(released) === 1;
}

/** Renew and prove the same lease immediately before a Vectorize mutation. */
export async function renewDrainLease(env, ownerToken, {
  now = Date.now(),
  ttlMs = DRAIN_LEASE_TTL_MS,
} = {}) {
  if (typeof ownerToken !== "string" || !ownerToken || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > DRAIN_LEASE_TTL_MS) {
    throw new Error("vector drain lease renewal input is invalid");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("vector drain lease renewal expiry is invalid");
  let renewed;
  try {
    renewed = await env.DB.prepare(
      `UPDATE install_state
          SET vector_drain_lease_expires_at = ?3
        WHERE id = 1 AND schema_version >= 12
          AND vector_drain_lease_owner = ?1
          AND vector_drain_lease_expires_at > ?2`
    ).bind(ownerToken, now, expiresAt).run();
  } catch {
    throw new Error("vector drain lease could not be renewed before provider write");
  }
  if (drainLeaseChanges(renewed) !== 1) {
    throw new Error("vector drain lease ownership or expiry was lost before provider write");
  }
  return { expiresAt };
}

const VECTOR_MUTATION_ID_MAX_CHARS = 200;

function acceptedMutationId(receipt) {
  const id = receipt?.mutationId;
  if (typeof id !== "string" || !id || id.length > VECTOR_MUTATION_ID_MAX_CHARS ||
      /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("Vectorize did not return a valid asynchronous mutation receipt");
  }
  return id;
}

/** Store the provider receipt before any affected outbox row can be confirmed. */
async function recordSubmittedMutation(env, rows, op, receipt, submittedAt = Date.now()) {
  const mutationId = acceptedMutationId(receipt);
  if (!Number.isSafeInteger(submittedAt) || submittedAt < 0) {
    throw new Error("the vector mutation submission time is invalid");
  }
  const fence = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_mutation_id = ?1,
            vector_projection_submitted_at = ?2
      WHERE id = 1 AND schema_version >= 12`
  ).bind(mutationId, submittedAt).run();
  if (drainLeaseChanges(fence) !== 1) {
    throw new Error("the vector mutation receipt could not be recorded durably");
  }

  if (rows.length) {
    if (op === "upsert") {
      // Do this for every accepted upsert, including a legacy short id whose
      // chunks.vector_id is NULL. The receipt below is conditional on this
      // exact durable hydration mapping.
      const remaps = rows;
      if (remaps.length) {
        // Persist the actual hashed provider id before the accepted row receipt.
        // If this batch fails, the global fence remains durable and the outbox
        // generation stays unsubmitted/retryable; it can never false-green.
        const remapChanges = await env.DB.batch(remaps.map((row) => env.DB.prepare(
          `UPDATE chunks SET vector_id = ?2
            WHERE chunk_uid = ?1
              AND EXISTS (
                SELECT 1 FROM vector_outbox
                 WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?3
              )`
        ).bind(row.chunk_uid, row.vector_id, row.generation)));
        if (!Array.isArray(remapChanges) || remapChanges.length !== remaps.length) {
          throw new Error("the accepted vector id remap could not be recorded");
        }
      }
    }
    const statements = rows.map((row) => op === "delete"
      ? env.DB.prepare(
        `UPDATE vector_outbox
              SET submitted_mutation_id = ?4, submitted_at = ?5, last_error = NULL
            WHERE chunk_uid = ?1 AND op = 'delete'
              AND COALESCE(vector_id, chunk_uid) = ?2 AND generation = ?3`
      ).bind(row.chunk_uid, row.vector_id || row.chunk_uid, row.generation, mutationId, submittedAt)
      : env.DB.prepare(
          `UPDATE vector_outbox
              SET submitted_mutation_id = ?3, submitted_at = ?4, last_error = NULL
            WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?2
              AND EXISTS (
                SELECT 1 FROM chunks
                 WHERE chunk_uid = ?1 AND vector_id = ?5
              )`
        ).bind(row.chunk_uid, row.generation, mutationId, submittedAt, row.vector_id));
    const changes = await env.DB.batch(statements);
    if (!Array.isArray(changes) || changes.length !== rows.length) {
      throw new Error("the vector mutation row receipts were ambiguous");
    }
    return {
      mutationId,
      submitted: changes.reduce((total, result) =>
        total + Number(drainLeaseChanges(result) === 1), 0),
    };
  }
  return { mutationId, submitted: 0 };
}

async function projectionFenceState(env) {
  const state = await env.DB.prepare(
    `SELECT vector_projection_mutation_id AS mutation_id,
            vector_projection_submitted_at AS submitted_at
       FROM install_state WHERE id = 1 AND schema_version >= 12`
  ).first();
  if (!state) throw new Error("vector visibility receipt state is unavailable");
  if (state.mutation_id === null || state.mutation_id === undefined || state.mutation_id === "") {
    return { mutationId: null, submittedAt: null };
  }
  const mutationId = String(state.mutation_id);
  const submittedAt = Number(state.submitted_at);
  if (!mutationId || mutationId.length > VECTOR_MUTATION_ID_MAX_CHARS ||
      /[\u0000-\u001f\u007f]/.test(mutationId) || !Number.isSafeInteger(submittedAt) || submittedAt < 0) {
    throw new Error("vector visibility receipt state is invalid");
  }
  return { mutationId, submittedAt };
}

async function projectionFenceProcessed(env, fence) {
  if (!fence?.mutationId) return true;
  const info = await env.VECTORIZE.describe();
  const processed = info?.processedUpToMutation;
  // A brand-new index legitimately reports no processed watermark while its
  // first accepted changeset is still pending. That is "not yet", not a
  // malformed response. Other shapes still fail closed.
  if (processed === null || processed === undefined || processed === "") return false;
  if (typeof processed !== "string" && typeof processed !== "number") {
    throw new Error("Vectorize did not expose its processed mutation watermark");
  }
  return String(processed) === fence.mutationId;
}

/** Mark the full projection verified only across one exact, empty-queue cut. */
async function markProjectionVerifiedIfExact(env) {
  const description = await env.VECTORIZE.describe();
  const vectorCount = Number(
    description?.vectorCount ?? description?.vectorsCount ?? description?.count,
  );
  if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) return false;
  const fence = await projectionFenceState(env);
  const processed = fence.mutationId === null
    ? true
    : String(description?.processedUpToMutation ?? "") === fence.mutationId;
  if (!processed) return false;
  const result = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_status = 'verified'
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status = 'pending'
        AND (vector_projection_bootstrap_high_water IS NULL OR
             vector_projection_bootstrap_cursor = vector_projection_bootstrap_high_water)
        AND COALESCE(vector_projection_mutation_id, '') = ?1
        AND NOT EXISTS (SELECT 1 FROM vector_outbox)
        AND (SELECT count(*) FROM chunks) = ?2`
  ).bind(fence.mutationId || "", vectorCount).run();
  return drainLeaseChanges(result) === 1;
}

/**
 * Confirm provider-visible effects for one previously accepted changeset.
 *
 * The processed watermark is an ordering fence for deletes and for generations
 * replaced while an older mutation was in flight. getByIds then proves the
 * exact upsert generation, rather than accepting an old vector with the same id.
 */
const VECTOR_GET_BY_IDS_LIMIT = 20;

async function confirmSubmittedVectors(env, rows) {
  if (!rows.length) return { confirmed: 0, confirmedDeletes: 0, confirmedUpserts: 0, retrying: 0, waiting: 0 };
  const fence = await projectionFenceState(env);
  if (!await projectionFenceProcessed(env, fence)) {
    return { confirmed: 0, confirmedDeletes: 0, confirmedUpserts: 0, retrying: 0, waiting: rows.length };
  }

  // A legacy/bootstrap outbox row may still carry the long chunk_uid even
  // though this Worker deterministically hashed it for Vectorize. Do not trust
  // that stale upsert field for visibility or CAS. Deletes must keep using the
  // exact historical stored id because their chunk row may already be gone.
  rows = await Promise.all(rows.map(async (row) => ({
    ...row,
    provider_vector_id: row.op === "upsert"
      ? await vectorIdFor(row.chunk_uid)
      : row.vector_id || row.chunk_uid,
  })));
  const ids = [...new Set(rows.map((row) => row.provider_vector_id))];
  const visible = [];
  for (let start = 0; start < ids.length; start += VECTOR_GET_BY_IDS_LIMIT) {
    let page;
    try {
      page = await env.VECTORIZE.getByIds(ids.slice(start, start + VECTOR_GET_BY_IDS_LIMIT));
    } catch (error) {
      throw new Error(`the vector index could not verify accepted changes: ${String(error?.message || error).slice(0, 240)}`);
    }
    if (!Array.isArray(page)) {
      // Do not acknowledge an earlier page until every requested id has an
      // unambiguous readback receipt.
      throw new Error("the vector index returned an invalid visibility receipt");
    }
    visible.push(...page);
  }
  const byId = new Map(visible.map((vector) => [vector?.id, vector]));
  let confirmed = [];
  let retrying = [];
  for (const row of rows) {
    const vectorId = row.provider_vector_id;
    const vector = byId.get(vectorId);
    const exactGeneration = String(vector?.metadata?.outbox_generation ?? "") === String(row.generation);
    if ((row.op === "delete" && !vector) || (row.op === "upsert" && exactGeneration)) {
      confirmed.push(row);
    } else {
      retrying.push(row);
    }
  }

  if (confirmed.length) {
    const changes = await env.DB.batch(confirmed.map((row) => row.op === "delete"
      ? env.DB.prepare(
        `DELETE FROM vector_outbox
          WHERE chunk_uid = ?1 AND op = 'delete'
            AND COALESCE(vector_id, chunk_uid) = ?2 AND generation = ?3
            AND submitted_mutation_id = ?4`
      ).bind(row.chunk_uid, row.provider_vector_id, row.generation, row.submitted_mutation_id)
      : env.DB.prepare(
        `DELETE FROM vector_outbox
          WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?2
            AND submitted_mutation_id = ?3`
      ).bind(row.chunk_uid, row.generation, row.submitted_mutation_id)));
    if (!Array.isArray(changes) || changes.length !== confirmed.length) {
      throw new Error("the vector confirmation receipts were ambiguous");
    }
    confirmed = confirmed.filter((_, index) => drainLeaseChanges(changes[index]) === 1);
  }
  if (retrying.length) {
    const detail = "accepted Vectorize mutation was processed but the exact vector state was not query-visible; retrying";
    const changes = await env.DB.batch(retrying.map((row) => row.op === "delete"
      ? env.DB.prepare(
        `UPDATE vector_outbox
            SET submitted_mutation_id = NULL, submitted_at = NULL,
                attempts = attempts + 1, last_error = ?5
          WHERE chunk_uid = ?1 AND op = 'delete'
            AND COALESCE(vector_id, chunk_uid) = ?2 AND generation = ?3
            AND submitted_mutation_id = ?4`
      ).bind(row.chunk_uid, row.provider_vector_id, row.generation, row.submitted_mutation_id, detail)
      : env.DB.prepare(
        `UPDATE vector_outbox
            SET submitted_mutation_id = NULL, submitted_at = NULL,
                attempts = attempts + 1, last_error = ?4
          WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?2
            AND submitted_mutation_id = ?3`
      ).bind(row.chunk_uid, row.generation, row.submitted_mutation_id, detail)));
    if (!Array.isArray(changes) || changes.length !== retrying.length) {
      throw new Error("the vector retry receipts were ambiguous");
    }
    retrying = retrying.filter((_, index) => drainLeaseChanges(changes[index]) === 1);
  }
  return {
    confirmed: confirmed.length,
    confirmedDeletes: confirmed.filter((row) => row.op === "delete").length,
    confirmedUpserts: confirmed.filter((row) => row.op === "upsert").length,
    retrying: retrying.length,
    waiting: 0,
  };
}

async function submitQueuedDeletes(env, rows, lease) {
  if (!rows.length) return 0;
  try {
    await renewDrainLease(env, lease.ownerToken, { now: lease.now() });
    const receipt = await env.VECTORIZE.deleteByIds(rows.map((row) => row.vector_id || row.chunk_uid));
    return (await recordSubmittedMutation(env, rows, "delete", receipt)).submitted;
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 300);
    await env.DB.batch(rows.map((row) => env.DB.prepare(
      `UPDATE vector_outbox SET attempts = attempts + 1, last_error = ?2
        WHERE chunk_uid = ?1 AND op = 'delete'
          AND COALESCE(vector_id, chunk_uid) = ?3 AND generation = ?4`
    ).bind(row.chunk_uid, detail, row.vector_id || row.chunk_uid, row.generation))).catch(() => {});
    const wrapped = new Error(`the vector index could not durably accept this delete batch: ${detail}`);
    wrapped.vectorDeleteFailed = true;
    throw wrapped;
  }
}

/**
 * Drain the outbox into Vectorize.
 *
 * Separate from the write on purpose. Vectorize acknowledges a write before the
 * index reflects it (seconds for a small upsert, minutes for a large batch), so
 * pretending the write completed inline would make read-after-write look
 * broken. Draining separately makes the lag a visible queue instead.
 */
async function drainOutboxBatch(env, {
  embed,
  embedBatch,
  batchSize = 100,
  embedGroup = 50,
  lease,
} = {}) {
  // First finish the second phase of accepted asynchronous mutations. A newer
  // enqueue clears its submitted receipt through the generation trigger, so a
  // stale confirmation can never acknowledge the newer operation.
  const { results: submittedRows } = await env.DB.prepare(
    `SELECT o.chunk_uid, COALESCE(o.vector_id, c.vector_id, o.chunk_uid) AS vector_id,
            o.op, o.queued_at, o.generation, o.submitted_mutation_id, o.submitted_at
       FROM vector_outbox o LEFT JOIN chunks c ON c.chunk_uid = o.chunk_uid
      WHERE o.submitted_mutation_id IS NOT NULL
      ORDER BY o.queued_at LIMIT ?1`
  ).bind(batchSize).all();
  if (submittedRows?.length) {
    const confirmed = await confirmSubmittedVectors(env, submittedRows);
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: confirmed.confirmed,
      deleted: confirmed.confirmedDeletes,
      upserted: confirmed.confirmedUpserts,
      submitted: 0,
      waiting: confirmed.waiting,
      failed: confirmed.retrying,
      remaining: Number(rest?.n || 0),
      errors: confirmed.retrying ? ["accepted vector state was not visible and was re-queued"] : [],
    };
  }

  // An accepted mutation can lose its per-row marker if a newer ingest replaces
  // every affected generation. The global fence must still process before any
  // newer provider write is accepted, or the older result could land last.
  const fence = await projectionFenceState(env);
  if (!await projectionFenceProcessed(env, fence)) {
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    const remaining = Number(rest?.n || 0);
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0,
      waiting: remaining, failed: 0, remaining, errors: [],
    };
  }

  // Delete first. Orphans still consume Vectorize candidate slots even though
  // D1 hydration makes them unreachable, so leaving them behind damages recall.
  const { results: deletePending } = await env.DB.prepare(
    `SELECT chunk_uid, COALESCE(vector_id, chunk_uid) AS vector_id, queued_at, generation
       FROM vector_outbox
      WHERE op = 'delete' AND submitted_mutation_id IS NULL
      ORDER BY queued_at LIMIT ?1`
  ).bind(batchSize).all();
  if (deletePending?.length) {
    const submitted = await submitQueuedDeletes(env, deletePending, lease);
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: 0, deleted: 0, upserted: 0, submitted, waiting: submitted,
      failed: 0, remaining: Number(rest?.n || 0), errors: [],
    };
  }

  const { results: pending } = await env.DB.prepare(
    `SELECT o.chunk_uid, o.queued_at, o.generation,
            c.text, c.source, c.doc_uid, c.document_date,
            c.client, c.category, c.top_folder, c.platform
     FROM vector_outbox o JOIN chunks c ON c.chunk_uid = o.chunk_uid
     WHERE o.op = 'upsert' AND o.submitted_mutation_id IS NULL
     ORDER BY o.queued_at LIMIT ?1`
  )
    .bind(batchSize)
    .all();

  if (!pending?.length) {
    const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0,
      failed: 0, remaining: Number(rest?.n || 0), errors: [],
    };
  }

  const vectors = [];
  const idToChunk = new Map();
  // Capture every selected token before embedding starts. A poison row can
  // fail before it becomes a vector, but its failure receipt still needs the
  // exact generation CAS. Building this map only after a successful embed
  // would silently leave those rows at attempts=0 forever.
  const chunkGeneration = new Map(
    pending.map((row) => [row.chunk_uid, row.generation])
  );
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
    vectors.push({
      id: vid,
      values,
      metadata: await vectorMetadataFor(row),
    });
  }

  let submitted = 0;
  if (vectors.length) {
    try {
      await renewDrainLease(env, lease.ownerToken, { now: lease.now() });
      const receipt = await env.VECTORIZE.upsert(vectors);
      const submittedRows = vectors.map((vector) => ({
        chunk_uid: idToChunk.get(vector.id),
        generation: chunkGeneration.get(idToChunk.get(vector.id)),
        vector_id: vector.id,
      }));
      submitted = (await recordSubmittedMutation(env, submittedRows, "upsert", receipt)).submitted;
    } catch (e) {
      // Acceptance and its D1 receipt are one phase. If either fails, leave the
      // row queued so a later idempotent upsert creates a newer ordering fence.
      const err = String(e.message || e).slice(0, 300);
      await env.DB.batch(
        vectors.map((v) =>
          env.DB.prepare(
            `UPDATE vector_outbox SET attempts = attempts + 1, last_error = ?2
             WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?3`
          ).bind(idToChunk.get(v.id), err, chunkGeneration.get(idToChunk.get(v.id)))
        )
      ).catch(() => {});
      const e2 = new Error(`the vector index could not durably accept this batch: ${err}`);
      e2.vectorUpsertFailed = true;
      throw e2;
    }
  }

  // A poisoned row never entered the accepted mutation and stays fresh in the
  // queue. Accepted rows also stay queued, now in submitted state, until a later
  // invocation observes the exact generation through getByIds().
  if (poisoned.length) {
    await env.DB.batch(
      poisoned.map((p) =>
        env.DB.prepare(
          `UPDATE vector_outbox SET attempts = attempts + 1, last_error = ?2
           WHERE chunk_uid = ?1 AND op = 'upsert' AND generation = ?3`
        ).bind(p.chunk_uid, p.error, chunkGeneration.get(p.chunk_uid))
      )
    ).catch(() => {});
  }

  const rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  return {
    drained: 0,
    deleted: 0,
    upserted: 0,
    submitted,
    waiting: submitted,
    failed: poisoned.length,
    remaining: Number(rest?.n || 0),
    errors: poisoned.slice(0, 3).map((p) => p.error),
  };
}

/**
 * Drain one bounded invocation under an exclusive D1-backed Vectorize lease.
 *
 * HTTP and cron entrypoints may request up to ten batches, but maxBatches is a
 * latency preference only: the internal query budget can stop the invocation
 * sooner. The lease spans every batch actually attempted, so another cron or
 * manual request can neither read nor write Vectorize until this owner releases
 * it. If the owner disappears, the migration's timestamp makes the lease
 * reclaimable without deleting or acknowledging any outbox row.
 */
export async function drainOutbox(env, options = {}) {
  // Upgrade cutovers deploy this exact code in a paused mode before changing
  // the lease schema. Return before even acquiring D1 state so the paused
  // Worker is a provable zero-writer compatibility bridge for old installs.
  if (env?.VECTOR_DRAIN_MODE === "paused-for-upgrade" &&
      options.allowPausedBootstrap !== true) {
    return {
      drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0, failed: 0,
      remaining: 0, errors: [], busy: false, paused: true,
    };
  }
  const rawMaxBatches = Number(options.maxBatches ?? 1);
  const maxBatches = Number.isInteger(rawMaxBatches)
    ? Math.min(10, Math.max(1, rawMaxBatches))
    : 1;
  const rawBatchSize = Number(options.batchSize ?? DRAIN_BATCH_SIZE_MAX);
  const batchSize = Number.isInteger(rawBatchSize)
    ? Math.min(DRAIN_BATCH_SIZE_MAX, Math.max(1, rawBatchSize))
    : DRAIN_BATCH_SIZE_MAX;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const maxInvocationMs = Number.isSafeInteger(options.maxInvocationMs)
    ? Math.min(DRAIN_LEASE_TTL_MS - 60_000, Math.max(1_000, options.maxInvocationMs))
    : 10 * 60 * 1_000;
  const startedAt = now();
  const lease = await acquireDrainLease(env, { now: startedAt });
  if (!lease.acquired) {
    let rest;
    try {
      rest = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    } catch {
      throw new Error("vector drain is busy and its remaining backlog could not be verified");
    }
    return {
      drained: 0,
      deleted: 0,
      upserted: 0,
      submitted: 0,
      waiting: 0,
      failed: 0,
      remaining: Number(rest?.n || 0),
      errors: [],
      busy: true,
      retry_after_seconds: lease.retryAfterSeconds,
    };
  }

  const initialDepth = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const initialRemaining = Number(initialDepth?.n);
  if (!Number.isSafeInteger(initialRemaining) || initialRemaining < 0) {
    try { await releaseDrainLease(env, lease.ownerToken); } catch { /* expiry remains the fallback */ }
    throw new Error("vector drain initial backlog is invalid");
  }
  let result = {
    drained: 0, deleted: 0, upserted: 0, submitted: 0, waiting: 0, failed: 0,
    remaining: initialRemaining, errors: [], busy: false,
  };
  let operationError = null;
  let reservedQueries = DRAIN_LEASE_ACQUIRE_QUERIES + DRAIN_LEASE_RELEASE_QUERIES +
    DRAIN_PROJECTION_VERIFY_QUERIES + DRAIN_INITIAL_DEPTH_QUERIES;
  const batchQueryUpperBound = drainBatchQueryUpperBound(batchSize);
  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      if (now() - startedAt >= maxInvocationMs) break;
      // Never begin provider work unless every possible D1 receipt/remap for
      // that batch fits alongside the already-reserved lease release. This
      // prevents a Vectorize write from landing only to hit D1's invocation
      // query limit before its durable acknowledgement can be recorded.
      if (reservedQueries + batchQueryUpperBound > DRAIN_D1_QUERY_BUDGET) break;
      reservedQueries += batchQueryUpperBound;
      const part = await drainOutboxBatch(env, {
        ...options,
        batchSize,
        lease: { ownerToken: lease.ownerToken, now },
      });
      result.drained += Number(part.drained || 0);
      result.deleted += Number(part.deleted || 0);
      result.upserted += Number(part.upserted || 0);
      result.submitted += Number(part.submitted || 0);
      result.waiting = Number(part.waiting || 0);
      result.failed += Number(part.failed || 0);
      result.remaining = Number(part.remaining || 0);
      result.errors.push(...(part.errors || []).slice(0, Math.max(0, 3 - result.errors.length)));
      if (result.remaining === 0 && options.disableBootstrapAdvance !== true) {
        const bootstrap = await bootstrapVectorProjectionPage(env, { now: now() });
        result.remaining = bootstrap.pending;
        if (bootstrap.pending > 0) {
          result.waiting = 0;
          continue;
        }
      }
      // One immediate confirmation check is useful when a small changeset has
      // already become visible. Once that check reports waiting, stop rather
      // than spinning inside one Worker invocation. A later manual/cron call
      // confirms it without another embedding bill.
      if (!result.remaining) break;
      if (part.waiting && !part.submitted) break;
      if (!part.drained && !part.submitted) break;
    }
  } catch (error) {
    operationError = error;
  }

  if (!operationError && result.remaining === 0) {
    try {
      result.projection_verified = await markProjectionVerifiedIfExact(env);
    } catch (error) {
      operationError = error;
    }
  }

  let released = false;
  let releaseError = null;
  try {
    released = await releaseDrainLease(env, lease.ownerToken);
    if (!released) {
      releaseError = new Error("vector drain lease ownership was lost before release");
    }
  } catch (error) {
    releaseError = error;
  }

  if (operationError) {
    if (releaseError && operationError && typeof operationError === "object") {
      operationError.leaseReleaseFailed = true;
    }
    throw operationError;
  }
  if (releaseError) throw releaseError;
  return result;
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
export async function diagnose(env, {
  sampleLimit = 10,
  duplicateChunkScanLimit = 100_000,
} = {}) {
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
      action: "If OCR is off, turn it on (safety.ocr.enabled) and re-ingest; these are the documents it exists for. If it is already on, these were refused for a stated reason, so read the ingest report and remove them rather than leaving the document count overstating what the brain knows." });
  });

  // How much of this corpus was read by a machine off a picture. An owner
  // reading an answer deserves to know the shape of the evidence underneath it,
  // and this is the only place that number is visible in aggregate.
  await safe("ocr_coverage", async () => {
    const row = await q1(env,
      // Aliased ocr_full, not full: FULL is a reserved word in SQLite (FULL
      // OUTER JOIN) and the bare alias is a syntax error.
      `SELECT SUM(CASE WHEN text_source = 'ocr' THEN 1 ELSE 0 END) ocr_full,
              SUM(CASE WHEN text_source = 'ocr_partial' THEN 1 ELSE 0 END) ocr_partial
         FROM documents WHERE deleted_at IS NULL`);
    const full = Number(row?.ocr_full || 0);
    const partial = Number(row?.ocr_partial || 0);
    if (!full && !partial) return;
    add({ id: "ocr_coverage", area: "coverage", severity: "info", count: full + partial,
      title: `${full + partial} document(s) were read by OCR rather than from a text layer`,
      detail: partial
        ? `${partial} of them had pages that could not be read; those pages are marked inline in the text rather than dropped. Answers resting on any of these are marked and score lower.`
        : "Answers resting on these are marked as OCR-sourced and score lower, because a machine read them off a picture.",
      action: "Nothing to fix. Spot-check a few figures against the original paper if the ledger will rely on them." });
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
        : "Reindex cannot enumerate unknown provider-only IDs. Use a reviewed recovery to recreate and rebind this brain's Vectorize index with all metadata indexes, then run `brain reindex <manifest> --yes` and verify exact readiness." });
  });

  await safe("backlog", async () => {
    const row = await q1(env,
      `SELECT count(*) n, min(queued_at) oldest, max(queued_at) newest,
              sum(CASE WHEN op = 'upsert' THEN 1 ELSE 0 END) upserts,
              sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) deletes
       FROM vector_outbox`);
    const n = Number(row?.n || 0);
    if (!n) return;
    const now = Date.now();
    const mins = row?.oldest ? Math.floor((now - Number(row.oldest)) / 60000) : null;

    // An old queue head alone cannot tell a STALLED drain from one that is
    // merely BEHIND, and the difference decides what the reader should do.
    // Found in the field on a bulk backfill: the drain was running on its
    // five-minute trigger the whole time, and this check told the operator it
    // was not running. Two pieces of evidence separate the cases:
    //
    //   every drain pass takes the lease, so the lease expiry dates the last
    //   pass (a lease taken at T expires at T + DRAIN_LEASE_TTL_MS);
    //
    //   a queue whose NEWEST row is seconds old still has a producer feeding
    //   it, which is what outruns a periodic drain during a backfill.
    const lease = await q1(env,
      "SELECT vector_drain_lease_expires_at expires FROM install_state WHERE id = 1");
    const lastPassAt = lease?.expires ? Number(lease.expires) - DRAIN_LEASE_TTL_MS : null;
    const minsSincePass = lastPassAt === null ? null : Math.floor((now - lastPassAt) / 60000);
    const draining = minsSincePass !== null && minsSincePass <= 30;
    const arriving = row?.newest ? (now - Number(row.newest)) <= 15 * 60 * 1000 : false;
    const stalled = mins !== null && mins > 30 && !draining;
    const passAge = minsSincePass === null
      ? "no recorded drain pass"
      : `last pass ${minsSincePass} min ago`;

    add({ id: "backlog", area: "integrity", severity: stalled ? "crit" : "warn", count: n,
      title: `${n} vector operation(s) are waiting (${Number(row?.upserts || 0)} upsert, ${Number(row?.deletes || 0)} delete)${mins !== null ? `, oldest ${mins} min ago` : ""}`,
      detail: stalled
        ? `The drain is NOT running: ${passAge}, and the queue head is ${mins} min old. Upserts remain keyword-only; deletes leave stale vectors competing for candidates.`
        : draining && arriving
          ? `The drain IS running (${passAge}) and documents are still arriving, so the queue is behind rather than stalled. What is queued stays keyword-only until it clears.`
          : draining
            ? `The drain IS running (${passAge}) and is working through this backlog. What is queued stays keyword-only until it clears.`
            : "Normal right after a load.",
      action: stalled
        ? "Clear it now with `brain drain <manifest>`. If it fills again with no pass, the scheduled trigger is not firing: check this Worker's cron trigger."
        : arriving
          ? "Let the load finish, then clear the remainder with `brain drain <manifest>`."
          : "Clear it now with `brain drain <manifest>`." });
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
    // Sampling the largest groups made the displayed count look exact while it
    // silently omitted every duplicate group below the sample limit. Aggregate
    // the complete grouped result, and keep private identities out of the
    // finding. This stays cheap because documents stores one content hash per
    // document rather than full chunk bodies.
    const summary = await q1(env,
      `SELECT count(*) groups, COALESCE(sum(n - 1), 0) extra
       FROM (
         SELECT content_hash, count(*) n FROM documents
         WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash != ''
         GROUP BY content_hash HAVING count(*) > 1
       )`);
    const extra = Number(summary?.extra || 0);
    if (extra) add({ id: "duplicate_documents", area: "integrity", severity: "warn", count: extra,
      title: `${extra} duplicate document(s) are stored more than once`,
      detail: `${Number(summary?.groups || 0)} exact-content group(s) contain redundant documents under different identities. Each copy competes for the same retrieval slots, so one can push out a different and better source.`,
      action: "Do not delete them blindly. Review their source and path aliases first. Retrieval collapses safe same-source, same-date copies, but physical cleanup needs to preserve update, deletion, and citation identity." });
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
    // Exact GROUP BY over every full chunk body exceeds D1's query budget on a
    // large corpus. A timed-out diagnostic used to become a generic warning,
    // which made a healthy large install look broken while proving nothing
    // about duplicates. Stay explicit about the unavailable measurement until
    // chunk text hashes make the check bounded and indexable.
    if (totals.chunks > duplicateChunkScanLimit) {
      add({ id: "duplicate_chunks", area: "efficiency", severity: "info",
        observable: false,
        title: "exact duplicate chunk measurement is not observable at this scale",
        detail: `The exact full-text grouping check is bounded to ${duplicateChunkScanLimit} chunks, and this corpus has ${totals.chunks}. Running it here could exhaust D1's query budget without returning evidence.`,
        action: "Use the duplicate-document result today. A future chunk text-hash migration will make this exact check scale safely." });
      return;
    }
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
const INDEXING_STUCK_MS = 6 * 60 * 60 * 1000;

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * The source row says what the connector last reported; sync_runs says whether
 * an `indexing` report still belongs to a live attempt. Keeping this separate
 * from schedule staleness matters: a failed hourly sync is broken immediately,
 * not only after its freshness window expires, while a healthy six-minute run
 * must not flash red just because it is currently in progress.
 */
function operationalFreshness(s, now) {
  const status = String(s.status || "").toLowerCase();
  const started = timestampMs(s.indexing_started_at);
  const indexingMs = Number.isFinite(started) ? Math.max(0, now - started) : null;

  if (s.stale_reason) {
    return { state: "broken", reason: String(s.stale_reason), indexingMs };
  }
  if (status === "error") {
    return { state: "broken", reason: "the last sync reported an error", indexingMs };
  }
  if (status !== "indexing") return { state: null, reason: null, indexingMs };

  // New connector runs always open sync_runs through source-receipt. An
  // indexing row without one is therefore an interrupted legacy/control-plane
  // run, not evidence that work is still alive.
  if (!Number.isFinite(started)) {
    return {
      state: "broken",
      reason: "indexing is marked active but has no open sync run",
      indexingMs: null,
    };
  }
  if (indexingMs > INDEXING_STUCK_MS) {
    const hours = Math.floor(indexingMs / 3600000);
    return {
      state: "broken",
      reason: `indexing has not completed for ${hours} hour(s)`,
      indexingMs,
    };
  }
  return { state: "indexing", reason: null, indexingMs };
}

const sourceFreshnessSql = ({ ordered = false } = {}) => `
  SELECT s.name, s.kind, s.status, s.last_ingest_at, s.last_complete_sweep_at,
         s.expected_refresh_seconds, s.stale_reason, s.document_count,
         (SELECT MIN(sr.started_at)
            FROM sync_runs sr
           WHERE sr.source = s.name AND sr.finished_at IS NULL) AS indexing_started_at
    FROM sources s${ordered ? " ORDER BY s.name" : ""}`;

export async function coverageGaps(env, { now = Date.now() } = {}) {
  let rows;
  try {
    const r = await env.DB.prepare(sourceFreshnessSql()).all();
    rows = r?.results || [];
  } catch {
    return []; // never fail an answer because the freshness check could not run
  }

  const gaps = [];
  for (const s of rows) {
    const last = s.last_ingest_at ? Date.parse(s.last_ingest_at) : NaN;
    const ageSec = Number.isFinite(last) ? Math.floor((now - last) / 1000) : null;
    const days = ageSec === null ? null : Math.floor(ageSec / 86400);
    const operational = operationalFreshness(s, now);

    if (operational.state === "broken") {
      gaps.push({
        type: "sync_broken",
        source: s.name,
        days_since_ingest: days,
        detail: `The "${s.name}" source stopped updating${days === null ? "" : ` ${days} day(s) ago`}: ${operational.reason}. Anything added since is not in the brain.`,
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
    const r = await env.DB.prepare(sourceFreshnessSql({ ordered: true })).all();
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
      const operational = operationalFreshness(s, now);
      let state = "ok";
      let reason = operational.reason;
      if (operational.state) state = operational.state;
      else if (!expected) state = automatable ? "unscheduled" : "manual";
      else if (!Number.isFinite(last)) state = "never_synced";
      else if ((now - last) / 1000 > expected * 1.5) state = "stale";
      return {
        name: s.name, kind: s.kind, state,
        source_status: String(s.status || "") || null,
        documents: Number(s.document_count || 0),
        days_since_ingest: days,
        expected_every_days: expected ? Math.max(1, Math.round(expected / 86400)) : null,
        last_complete_sweep_at: s.last_complete_sweep_at || null,
        indexing_started_at: Number.isFinite(timestampMs(s.indexing_started_at))
          ? new Date(timestampMs(s.indexing_started_at)).toISOString()
          : null,
        hours_indexing: operational.indexingMs === null
          ? null
          : Math.floor(operational.indexingMs / 3600000),
        reason,
        automatable,
      };
    }),
  };
}

// Ninety-nine ids plus the queued_at value exactly fit the installer's shared
// 100-bind D1 ceiling. Keep this independent from the drain's 100-row batch.
export const VECTOR_BOOTSTRAP_PAGE_SIZE = 99;

/**
 * Advance one crash-resumable legacy projection page.
 *
 * The migration only records a high-water mark. Each call enqueues at most 99
 * rows in one INSERT..SELECT and advances the epoch-bound cursor in the same
 * D1 transaction. Callers must drain the current page to exact visibility
 * before asking for another, which caps bootstrap queue growth and makes a
 * 736k-chunk upgrade resumable without one trigger-amplified migration.
 */
export async function bootstrapVectorProjectionPage(env, {
  pageSize = VECTOR_BOOTSTRAP_PAGE_SIZE,
  now = Date.now(),
} = {}) {
  const limit = Number.isInteger(pageSize)
    ? Math.min(VECTOR_BOOTSTRAP_PAGE_SIZE, Math.max(1, pageSize))
    : VECTOR_BOOTSTRAP_PAGE_SIZE;
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("vector bootstrap time is invalid");

  const state = await env.DB.prepare(
    `SELECT vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_cursor AS cursor,
            vector_projection_bootstrap_high_water AS high_water,
            (SELECT count(*) FROM chunks) AS chunks,
            (SELECT count(*) FROM vector_outbox) AS pending
       FROM install_state WHERE id = 1 AND schema_version >= 12`
  ).first();
  if (!state || !["verified", "pending", "bootstrap_required"].includes(String(state.status))) {
    throw new Error("vector bootstrap state is unavailable");
  }
  const epoch = Number(state.epoch);
  const chunks = Number(state.chunks);
  const pending = Number(state.pending);
  if (![epoch, chunks, pending].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("vector bootstrap counts are invalid");
  }
  if (state.status !== "bootstrap_required") {
    return {
      bootstrap: true,
      complete: true,
      chunks,
      page_chunks: 0,
      queued: 0,
      already_queued: pending,
      pending,
      epoch,
    };
  }
  if (pending > 0) {
    return {
      bootstrap: true,
      complete: false,
      blocked_on_drain: true,
      chunks,
      page_chunks: 0,
      queued: 0,
      already_queued: pending,
      pending,
      epoch,
    };
  }

  const cursor = state.cursor === null || state.cursor === undefined ? "" : String(state.cursor);
  const highWater = state.high_water === null || state.high_water === undefined
    ? ""
    : String(state.high_water);
  if (chunks > 0 && !highWater) {
    throw new Error("vector bootstrap cursor is invalid");
  }
  const { results: candidates } = await env.DB.prepare(
    `SELECT chunk_uid FROM chunks
      WHERE chunk_uid > ?1 AND chunk_uid <= ?2
      ORDER BY chunk_uid LIMIT ?3`
  ).bind(cursor, highWater, limit + 1).all();
  if (!Array.isArray(candidates)) throw new Error("vector bootstrap page is invalid");
  const page = candidates.slice(0, limit);
  const hasMore = candidates.length > limit;
  const nextCursor = hasMore ? String(page.at(-1)?.chunk_uid || "") : highWater;
  if (page.length && !nextCursor) throw new Error("vector bootstrap page cursor is invalid");
  const nextStatus = hasMore ? "bootstrap_required" : "pending";

  const statements = [];
  if (page.length) {
    const pageIds = page.map((row) => String(row?.chunk_uid || ""));
    if (pageIds.some((id) => !id)) {
      throw new Error("vector bootstrap page identity is invalid");
    }
    const placeholders = pageIds.map((_, index) => `?${index + 1}`).join(",");
    statements.push(env.DB.prepare(
      `INSERT INTO vector_outbox
         (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       SELECT c.chunk_uid, COALESCE(c.vector_id, c.chunk_uid), 'upsert', ?${pageIds.length + 1}, 0, NULL
         FROM chunks c
        WHERE c.chunk_uid IN (${placeholders})
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op='upsert', queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).bind(...pageIds, now));
  }
  statements.push(env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_status = ?5,
            vector_projection_bootstrap_cursor = ?4
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status = 'bootstrap_required'
        AND vector_projection_bootstrap_epoch = ?1
        AND COALESCE(vector_projection_bootstrap_cursor, '') = ?2
        AND COALESCE(vector_projection_bootstrap_high_water, '') = ?3`
  ).bind(epoch, cursor, highWater, nextCursor, nextStatus));
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      drainLeaseChanges(results.at(-1)) !== 1) {
    throw new Error("vector bootstrap epoch changed; retry from durable state");
  }
  const after = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  const afterPending = Number(after?.n);
  if (!Number.isSafeInteger(afterPending) || afterPending < 0) {
    throw new Error("vector bootstrap outbox receipt is invalid");
  }
  return {
    bootstrap: true,
    complete: !hasMore,
    blocked_on_drain: false,
    chunks,
    page_chunks: page.length,
    queued: afterPending,
    already_queued: 0,
    pending: afterPending,
    epoch,
  };
}

export const ACCELERATED_BOOTSTRAP_PAGE_SIZE = 1000;
export const ACCELERATED_BOOTSTRAP_WINDOW = 3;
const ACCELERATED_BOOTSTRAP_CONCURRENCY = 6;
const ACCELERATED_BOOTSTRAP_PROTOCOL = "bootstrap-v2";

async function mapBounded(values, limit, operation) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function bootstrapStateV2(env) {
  const state = await env.DB.prepare(
    `SELECT schema_version, vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_cursor AS cursor,
            vector_projection_bootstrap_high_water AS high_water,
            vector_projection_bootstrap_protocol AS protocol,
            vector_projection_bootstrap_base_count AS base_count
       FROM install_state WHERE id = 1`
  ).first();
  if (!state || Number(state.schema_version) < 13) {
    throw new Error("the accelerated vector bootstrap schema is not active");
  }
  const epoch = Number(state.epoch);
  const baseCount = Number(state.base_count);
  if (!Number.isSafeInteger(epoch) || epoch < 0 ||
      !Number.isSafeInteger(baseCount) || baseCount < 0) {
    throw new Error("the accelerated vector bootstrap state is invalid");
  }
  return {
    ...state,
    epoch,
    baseCount,
    cursor: state.cursor === null || state.cursor === undefined ? "" : String(state.cursor),
    highWater: state.high_water === null || state.high_water === undefined ? "" : String(state.high_water),
  };
}

async function acceleratedBootstrapReceipt(env, phase) {
  const state = await bootstrapStateV2(env);
  const [counts, queue, batches, readiness] = await Promise.all([
    env.DB.prepare("SELECT count(*) AS n FROM chunks").first(),
    env.DB.prepare(
      `SELECT count(*) AS n,
              sum(CASE WHEN submitted_mutation_id IS NULL THEN 1 ELSE 0 END) AS queued,
              sum(CASE WHEN submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END) AS submitted,
              sum(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS failed
         FROM vector_outbox`
    ).first(),
    env.DB.prepare(
      `SELECT COALESCE(sum(CASE WHEN status='confirmed' THEN row_count ELSE 0 END),0) AS confirmed,
              sum(CASE WHEN status IN ('queued','submitted') THEN 1 ELSE 0 END) AS in_flight
         FROM vector_bootstrap_batches WHERE epoch=?1`
    ).bind(state.epoch).first(),
    vectorReadiness(env),
  ]);
  const total = Number(counts?.n);
  const confirmed = state.baseCount + Number(batches?.confirmed || 0);
  const queued = Number(queue?.queued || 0);
  const submitted = Number(queue?.submitted || 0);
  const failed = Number(queue?.failed || 0);
  const inFlight = Number(batches?.in_flight || 0);
  if (![total, confirmed, queued, submitted, failed, inFlight].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) || confirmed > total || inFlight > ACCELERATED_BOOTSTRAP_WINDOW) {
    throw new Error("the accelerated vector bootstrap receipt is invalid");
  }
  const complete = state.status === "verified" && confirmed === total &&
    queued === 0 && submitted === 0 && inFlight === 0 && failed === 0 &&
    readiness.ready === true && readiness.expected_vectors === total &&
    readiness.actual_vectors === total;
  return {
    protocol: ACCELERATED_BOOTSTRAP_PROTOCOL,
    phase: complete ? "complete" : phase,
    epoch: state.epoch,
    total,
    confirmed,
    queued,
    submitted,
    remaining: total - confirmed,
    in_flight_batches: inFlight,
    failed,
    complete,
    vector_ready: readiness.ready === true,
    expected_vectors: readiness.expected_vectors,
    actual_vectors: readiness.actual_vectors,
  };
}

async function activateAcceleratedBootstrap(env, state) {
  if (state.protocol === ACCELERATED_BOOTSTRAP_PROTOCOL) return state;
  if (state.protocol !== null && state.protocol !== undefined && state.protocol !== "") {
    throw new Error("the vector bootstrap protocol is not supported by this Worker");
  }
  const pending = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
  if (Number(pending?.n || 0) !== 0) return null;
  const result = await env.DB.prepare(
    `UPDATE install_state
        SET vector_projection_bootstrap_protocol=?2,
            vector_projection_bootstrap_base_count=(
              SELECT count(*) FROM chunks
               WHERE chunk_uid <= COALESCE(vector_projection_bootstrap_cursor,'')
            ),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks)
      WHERE id=1 AND schema_version>=13
        AND vector_projection_bootstrap_epoch=?1
        AND vector_projection_status='bootstrap_required'
        AND vector_projection_bootstrap_protocol IS NULL
        AND NOT EXISTS (SELECT 1 FROM vector_outbox)`
  ).bind(state.epoch, ACCELERATED_BOOTSTRAP_PROTOCOL).run();
  if (drainLeaseChanges(result) !== 1) {
    throw new Error("the accelerated vector bootstrap could not establish its durable boundary");
  }
  return bootstrapStateV2(env);
}

async function queueAcceleratedBootstrapBatch(env, state, now) {
  const { results: candidates } = await env.DB.prepare(
    `SELECT chunk_uid FROM chunks
      WHERE chunk_uid>?1 AND chunk_uid<=?2
      ORDER BY chunk_uid LIMIT ?3`
  ).bind(state.cursor, state.highWater, ACCELERATED_BOOTSTRAP_PAGE_SIZE + 1).all();
  if (!Array.isArray(candidates)) throw new Error("the accelerated bootstrap page is invalid");
  const page = candidates.slice(0, ACCELERATED_BOOTSTRAP_PAGE_SIZE);
  if (!page.length) return false;
  const endCursor = String(page.at(-1)?.chunk_uid || "");
  if (!endCursor) throw new Error("the accelerated bootstrap cursor is invalid");
  const sequence = await env.DB.prepare(
    "SELECT COALESCE(max(batch_no),0)+1 AS n FROM vector_bootstrap_batches WHERE epoch=?1"
  ).bind(state.epoch).first();
  const batchNo = Number(sequence?.n);
  if (!Number.isSafeInteger(batchNo) || batchNo < 1) {
    throw new Error("the accelerated bootstrap batch identity is invalid");
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vector_bootstrap_batches
         (epoch,batch_no,start_cursor,end_cursor,row_count,status)
       VALUES (?1,?2,?3,?4,?5,'queued')`
    ).bind(state.epoch, batchNo, state.cursor, endCursor, page.length),
    env.DB.prepare(
      `INSERT INTO vector_outbox
         (chunk_uid,vector_id,op,queued_at,attempts,last_error)
       SELECT chunk_uid,COALESCE(vector_id,chunk_uid),'upsert',?3,0,NULL
         FROM chunks WHERE chunk_uid>?1 AND chunk_uid<=?2
         ORDER BY chunk_uid`
    ).bind(state.cursor, endCursor, now),
    // Generation assignment clears old bootstrap tags. Attach the exact fresh
    // generations only after every insert trigger has run.
    env.DB.prepare(
      `UPDATE vector_outbox SET bootstrap_epoch=?3,bootstrap_batch=?4
        WHERE chunk_uid>?1 AND chunk_uid<=?2 AND submitted_mutation_id IS NULL`
    ).bind(state.cursor, endCursor, state.epoch, batchNo),
    env.DB.prepare(
      `UPDATE install_state SET vector_projection_bootstrap_cursor=?3
        WHERE id=1 AND schema_version>=13
          AND vector_projection_status='bootstrap_required'
          AND vector_projection_bootstrap_epoch=?1
          AND COALESCE(vector_projection_bootstrap_cursor,'')=?2`
    ).bind(state.epoch, state.cursor, endCursor),
  ]);
  if (!Array.isArray(results) || results.length !== 4 ||
      drainLeaseChanges(results[0]) !== 1 ||
      drainLeaseChanges(results[2]) !== page.length ||
      drainLeaseChanges(results[3]) !== 1) {
    throw new Error("the accelerated bootstrap batch receipt was ambiguous");
  }
  return true;
}

async function embedAcceleratedBatch(rows, { embed, embedBatch, embedGroup = 50 }) {
  if (!Number.isInteger(embedGroup) || embedGroup < 1 || embedGroup > 100) {
    throw new Error("the accelerated bootstrap embedding group is invalid");
  }
  const groups = [];
  for (let start = 0; start < rows.length; start += embedGroup) {
    groups.push({ start, rows: rows.slice(start, start + embedGroup) });
  }
  const embeddedGroups = await mapBounded(
    groups,
    ACCELERATED_BOOTSTRAP_CONCURRENCY,
    async (group) => {
      try {
        const output = await embedBatch(group.rows.map((row) => row.text));
        if (!Array.isArray(output) || output.length !== group.rows.length) {
          throw new Error("Workers AI returned an incomplete embedding batch");
        }
        return output;
      } catch {
        const output = [];
        for (const row of group.rows) output.push(await embed(row.text));
        return output;
      }
    },
  );
  return embeddedGroups.flat();
}

async function submitAcceleratedBootstrapBatch(env, batch, lease, options) {
  const { results: rows } = await env.DB.prepare(
    `SELECT o.chunk_uid,o.generation,c.text,c.source,c.doc_uid,c.document_date,
            c.client,c.category,c.top_folder,c.platform
       FROM vector_outbox o JOIN chunks c ON c.chunk_uid=o.chunk_uid
      WHERE o.bootstrap_epoch=?1 AND o.bootstrap_batch=?2
        AND o.op='upsert' AND o.submitted_mutation_id IS NULL
      ORDER BY o.chunk_uid`
  ).bind(batch.epoch, batch.batch_no).all();
  if (!Array.isArray(rows) || rows.length !== Number(batch.row_count)) {
    throw new Error("the accelerated bootstrap queued batch is incomplete");
  }
  const values = await embedAcceleratedBatch(rows, options);
  if (values.length !== rows.length) throw new Error("the accelerated bootstrap embeddings are incomplete");
  const vectors = [];
  const mapping = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const vectorId = await vectorIdFor(row.chunk_uid);
    mapping.push({ u: row.chunk_uid, v: vectorId, g: row.generation });
    vectors.push({ id: vectorId, values: values[index], metadata: await vectorMetadataFor(row) });
  }
  if (new Set(mapping.map((row) => row.v)).size !== mapping.length) {
    throw new Error("the accelerated bootstrap vector identities are not unique");
  }
  const mappingJson = JSON.stringify(mapping);
  if (new TextEncoder().encode(mappingJson).length > 1_800_000) {
    throw new Error("the accelerated bootstrap identity receipt is too large");
  }
  await renewDrainLease(env, lease.ownerToken, { now: lease.now() });
  const providerReceipt = await env.VECTORIZE.upsert(vectors);
  const mutationId = acceptedMutationId(providerReceipt);
  const submittedAt = lease.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE install_state
          SET vector_projection_mutation_id=?1,vector_projection_submitted_at=?2
        WHERE id=1 AND schema_version>=13`
    ).bind(mutationId, submittedAt),
    env.DB.prepare(
      `UPDATE chunks AS c SET vector_id=(
         SELECT json_extract(value,'$.v') FROM json_each(?1)
          WHERE json_extract(value,'$.u')=c.chunk_uid
       ) WHERE EXISTS (
         SELECT 1 FROM json_each(?1) m JOIN vector_outbox o
           ON o.chunk_uid=json_extract(m.value,'$.u')
          AND o.generation=json_extract(m.value,'$.g')
          AND o.bootstrap_epoch=?2 AND o.bootstrap_batch=?3
          WHERE o.chunk_uid=c.chunk_uid
       )`
    ).bind(mappingJson, batch.epoch, batch.batch_no),
    env.DB.prepare(
      `UPDATE vector_outbox
          SET submitted_mutation_id=?3,submitted_at=?4,last_error=NULL
        WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2
          AND op='upsert' AND submitted_mutation_id IS NULL`
    ).bind(batch.epoch, batch.batch_no, mutationId, submittedAt),
    env.DB.prepare(
      `UPDATE vector_bootstrap_batches
          SET status='submitted',mutation_id=?3,submitted_at=?4
        WHERE epoch=?1 AND batch_no=?2 AND status='queued'
          AND (SELECT count(*) FROM vector_outbox
                WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2
                  AND submitted_mutation_id=?3)=row_count`
    ).bind(batch.epoch, batch.batch_no, mutationId, submittedAt),
  ]);
  if (!Array.isArray(results) || results.length !== 4 ||
      drainLeaseChanges(results[0]) !== 1 ||
      drainLeaseChanges(results[2]) !== rows.length ||
      drainLeaseChanges(results[3]) !== 1) {
    throw new Error("the accelerated bootstrap mutation receipt was ambiguous");
  }
  // D1 derives its rough meta.changes indication from sqlite3_total_changes(),
  // and chunks_au also rewrites the external FTS row for every chunks UPDATE.
  // It therefore cannot prove how many vector_id values reached desired state.
  // Read back the complete mapping instead. The install fence, outbox
  // transition, and batch transition remain exact ownership receipts above
  // because each changes one guarded row set with no triggers.
  const mappingReceipt = await env.DB.prepare(
    `SELECT count(*) AS n
       FROM json_each(?1) m JOIN chunks c
         ON c.chunk_uid=json_extract(m.value,'$.u')
      WHERE c.vector_id=json_extract(m.value,'$.v')`
  ).bind(mappingJson).first();
  const mapped = Number(mappingReceipt?.n);
  if (!Number.isSafeInteger(mapped) || mapped !== rows.length) {
    throw new Error("the accelerated bootstrap mutation receipt was ambiguous");
  }
  return rows.length;
}

async function confirmAcceleratedBootstrapBatch(env, batch, now) {
  const { results: rows } = await env.DB.prepare(
    `SELECT o.chunk_uid,o.generation,o.submitted_mutation_id,
            c.vector_id AS stored_vector_id
       FROM vector_outbox o JOIN chunks c ON c.chunk_uid=o.chunk_uid
      WHERE o.bootstrap_epoch=?1 AND o.bootstrap_batch=?2
      ORDER BY o.chunk_uid`
  ).bind(batch.epoch, batch.batch_no).all();
  if (!Array.isArray(rows) || rows.length !== Number(batch.row_count) ||
      rows.some((row) => row.submitted_mutation_id !== batch.mutation_id)) {
    throw new Error("the accelerated bootstrap submitted batch is incomplete");
  }
  const expected = await Promise.all(rows.map(async (row) => ({
    ...row,
    vector_id: await vectorIdFor(row.chunk_uid),
  })));
  // A request can be interrupted after the transactional submission but before
  // its mapping readback. Re-prove the D1 mapping on every resume so provider
  // visibility can never acknowledge an unresolvable hashed vector identity.
  if (expected.some((row) => row.stored_vector_id !== row.vector_id)) {
    throw new Error("the accelerated bootstrap submitted batch is incomplete");
  }
  const pages = [];
  for (let start = 0; start < expected.length; start += VECTOR_GET_BY_IDS_LIMIT) {
    pages.push(expected.slice(start, start + VECTOR_GET_BY_IDS_LIMIT));
  }
  const exactPages = await mapBounded(
    pages,
    ACCELERATED_BOOTSTRAP_CONCURRENCY,
    async (page) => {
      const visible = await env.VECTORIZE.getByIds(page.map((row) => row.vector_id));
      if (!Array.isArray(visible)) throw new Error("the vector index returned an invalid bootstrap visibility receipt");
      const byId = new Map(visible.map((vector) => [vector?.id, vector]));
      return page.every((row) =>
        String(byId.get(row.vector_id)?.metadata?.outbox_generation ?? "") === String(row.generation));
    },
  );
  // Retain only one boolean per page. getByIds includes full vector values, so
  // retaining 1,000 responses at once would spend most of a Worker's memory on
  // data whose only purpose is this metadata equality check.
  if (!exactPages.every(Boolean)) return false;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM vector_outbox
        WHERE bootstrap_epoch=?1 AND bootstrap_batch=?2
          AND submitted_mutation_id=?3`
    ).bind(batch.epoch, batch.batch_no, batch.mutation_id),
    env.DB.prepare(
      `UPDATE vector_bootstrap_batches SET status='confirmed',confirmed_at=?4
        WHERE epoch=?1 AND batch_no=?2 AND status='submitted' AND mutation_id=?3`
    ).bind(batch.epoch, batch.batch_no, batch.mutation_id, now),
  ]);
  if (!Array.isArray(results) || results.length !== 2 ||
      drainLeaseChanges(results[0]) !== rows.length || drainLeaseChanges(results[1]) !== 1) {
    throw new Error("the accelerated bootstrap confirmation receipt was ambiguous");
  }
  return true;
}

/**
 * Re-project legacy vectors in provider-sized, disjoint batches while every
 * ordinary corpus writer remains blocked by the upgrade compatibility Worker.
 */
export async function acceleratedVectorBootstrap(env, options = {}) {
  if (env?.VECTOR_DRAIN_MODE !== "paused-for-upgrade") {
    throw new Error("the accelerated vector bootstrap requires the verified upgrade pause");
  }
  let state = await bootstrapStateV2(env);
  if (!["bootstrap_required", "pending", "verified"].includes(String(state.status))) {
    throw new Error("the accelerated vector bootstrap state is unavailable");
  }
  // Finish at most one schema-12 residue page before establishing the bulk-v2
  // boundary. This handles a 0.1.14 update interrupted after queue or submit.
  if (state.protocol !== ACCELERATED_BOOTSTRAP_PROTOCOL) {
    const residue = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    if (Number(residue?.n || 0) > 0) {
      await drainOutbox(env, {
        ...options,
        allowPausedBootstrap: true,
        disableBootstrapAdvance: true,
        maxBatches: 10,
      });
      // A pending schema-12 last page can become fully verified in that drain.
      // Adopt it only when no v2 batch exists, or its rows would be counted
      // once as the base and again by their durable batch receipts.
      await env.DB.prepare(
        `UPDATE install_state
            SET vector_projection_bootstrap_protocol=?1,
                vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
          WHERE id=1 AND schema_version>=13
            AND vector_projection_status='verified'
            AND NOT EXISTS (SELECT 1 FROM vector_outbox)
            AND NOT EXISTS (
              SELECT 1 FROM vector_bootstrap_batches
               WHERE epoch=vector_projection_bootstrap_epoch
            )`
      ).bind(ACCELERATED_BOOTSTRAP_PROTOCOL).run();
      return acceleratedBootstrapReceipt(env, "legacy_drain");
    }
  }

  if (state.status === "pending") {
    await markProjectionVerifiedIfExact(env);
    state = await bootstrapStateV2(env);
  }
  if (state.status === "verified") {
    await env.DB.prepare(
      `UPDATE install_state
          SET vector_projection_bootstrap_protocol=?1,
              vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
        WHERE id=1 AND schema_version>=13
          AND vector_projection_status='verified'
          AND NOT EXISTS (SELECT 1 FROM vector_outbox)
          AND NOT EXISTS (
            SELECT 1 FROM vector_bootstrap_batches
             WHERE epoch=vector_projection_bootstrap_epoch
          )`
    ).bind(ACCELERATED_BOOTSTRAP_PROTOCOL).run();
    return acceleratedBootstrapReceipt(env, "waiting");
  }
  if (state.status !== "bootstrap_required") {
    return acceleratedBootstrapReceipt(env, "waiting");
  }

  const now = typeof options.now === "function" ? options.now : Date.now;
  const lease = await acquireDrainLease(env, { now: now() });
  if (!lease.acquired) {
    const receipt = await acceleratedBootstrapReceipt(env, "waiting");
    return { ...receipt, busy: true, retry_after_seconds: lease.retryAfterSeconds };
  }
  let phase = "waiting";
  let operationError = null;
  try {
    state = await activateAcceleratedBootstrap(env, state);
    if (!state) throw new Error("the accelerated bootstrap boundary changed; retry from durable state");

    const submitted = await env.DB.prepare(
      `SELECT * FROM vector_bootstrap_batches
        WHERE epoch=?1 AND status='submitted' ORDER BY batch_no`
    ).bind(state.epoch).all();
    for (const batch of submitted?.results || []) {
      if (await confirmAcceleratedBootstrapBatch(env, batch, now())) phase = "building";
    }

    let inFlight = await env.DB.prepare(
      `SELECT count(*) AS n FROM vector_bootstrap_batches
        WHERE epoch=?1 AND status IN ('queued','submitted')`
    ).bind(state.epoch).first();
    const durableInFlight = Number(inFlight?.n || 0);
    if (!Number.isSafeInteger(durableInFlight) || durableInFlight < 0 ||
        durableInFlight > ACCELERATED_BOOTSTRAP_WINDOW) {
      throw new Error("the accelerated bootstrap in-flight window is invalid");
    }
    while (Number(inFlight?.n || 0) < ACCELERATED_BOOTSTRAP_WINDOW) {
      state = await bootstrapStateV2(env);
      if (!state.highWater || state.cursor === state.highWater) break;
      if (!await queueAcceleratedBootstrapBatch(env, state, now())) break;
      phase = "building";
      inFlight = { n: Number(inFlight?.n || 0) + 1 };
    }

    const queued = await env.DB.prepare(
      `SELECT * FROM vector_bootstrap_batches
        WHERE epoch=?1 AND status='queued' ORDER BY batch_no`
    ).bind(state.epoch).all();
    for (const batch of queued?.results || []) {
      await submitAcceleratedBootstrapBatch(
        env,
        batch,
        { ownerToken: lease.ownerToken, now },
        {
          embed: options.embed,
          embedBatch: options.embedBatch,
          embedGroup: options.embedGroup || 50,
        },
      );
      phase = "building";
    }

    state = await bootstrapStateV2(env);
    const unfinished = await env.DB.prepare(
      `SELECT count(*) AS n FROM vector_bootstrap_batches
        WHERE epoch=?1 AND status<>'confirmed'`
    ).bind(state.epoch).first();
    const outbox = await env.DB.prepare("SELECT count(*) AS n FROM vector_outbox").first();
    if (state.cursor === state.highWater && Number(unfinished?.n || 0) === 0 &&
        Number(outbox?.n || 0) === 0) {
      await env.DB.prepare(
        `UPDATE install_state SET vector_projection_status='pending'
          WHERE id=1 AND schema_version>=13
            AND vector_projection_status='bootstrap_required'
            AND COALESCE(vector_projection_bootstrap_cursor,'')=
                COALESCE(vector_projection_bootstrap_high_water,'')`
      ).run();
      if (await markProjectionVerifiedIfExact(env)) phase = "complete";
    }
  } catch (error) {
    operationError = error;
  }
  let releaseError = null;
  try {
    if (!await releaseDrainLease(env, lease.ownerToken)) {
      releaseError = new Error("accelerated vector bootstrap lease ownership was lost before release");
    }
  } catch (error) {
    releaseError = error;
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return acceleratedBootstrapReceipt(env, phase);
}

/** Start a whole-corpus bootstrap, or resume the current durable epoch. */
export async function resetVectorProjectionBootstrap(env) {
  const installed = await env.DB.prepare(
    "SELECT schema_version FROM install_state WHERE id=1"
  ).first();
  const schemaVersion = Number(installed?.schema_version);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 12) {
    throw new Error("the vector bootstrap reset schema is unavailable");
  }
  const resetSql = schemaVersion >= 13
    ? `UPDATE install_state
        SET vector_projection_status = CASE
              WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
            vector_projection_bootstrap_epoch = vector_projection_bootstrap_epoch + 1,
            vector_projection_bootstrap_cursor = NULL,
            vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol = NULL,
            vector_projection_bootstrap_base_count = 0
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status <> 'bootstrap_required'`
    : `UPDATE install_state
        SET vector_projection_status = CASE
              WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
            vector_projection_bootstrap_epoch = vector_projection_bootstrap_epoch + 1,
            vector_projection_bootstrap_cursor = NULL,
            vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks)
      WHERE id = 1 AND schema_version >= 12
        AND vector_projection_status <> 'bootstrap_required'`;
  const result = await env.DB.prepare(resetSql).run();
  const reset = drainLeaseChanges(result);
  if (![0, 1].includes(reset)) {
    throw new Error("the vector bootstrap could not be reset durably");
  }
  const state = await env.DB.prepare(
    `SELECT vector_projection_status AS status,
            vector_projection_bootstrap_epoch AS epoch,
            vector_projection_bootstrap_cursor AS cursor,
            vector_projection_bootstrap_high_water AS high_water,
            (SELECT count(*) FROM chunks) AS chunks,
            (SELECT count(*) FROM vector_outbox) AS pending
       FROM install_state WHERE id = 1`
  ).first();
  const chunks = Number(state?.chunks);
  const pending = Number(state?.pending);
  const epoch = Number(state?.epoch);
  if (![chunks, pending, epoch].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !["verified", "bootstrap_required"].includes(String(state?.status)) ||
      (chunks > 0 && state?.status === "bootstrap_required" && state?.high_water === null)) {
    throw new Error("the vector bootstrap reset receipt is invalid");
  }
  return {
    chunks,
    pending,
    epoch,
    bootstrapRequired: state.status === "bootstrap_required",
    resumed: reset === 0,
  };
}

export async function reindex(env, { source = null, dryRun = true, bootstrap = false } = {}) {
  if (bootstrap) {
    if (source || dryRun) throw new Error("vector bootstrap requires a confirmed whole-corpus request");
    return bootstrapVectorProjectionPage(env);
  }
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

  if (!source) {
    const reset = await resetVectorProjectionBootstrap(env);
    return {
      chunks,
      queued: 0,
      already_queued: before,
      pending: reset.pending,
      bootstrap_required: reset.bootstrapRequired,
      bootstrap_epoch: reset.epoch,
      bootstrap_resumed: reset.resumed,
      dry_run: false,
      source,
    };
  }

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
            sum(CASE WHEN op = 'delete' THEN 1 ELSE 0 END) AS deletes,
            sum(CASE WHEN submitted_mutation_id IS NOT NULL THEN 1 ELSE 0 END) AS submitted
     FROM vector_outbox`
  ).first();
  return {
    pending: Number(row?.n || 0),
    upserts: Number(row?.upserts || 0),
    deletes: Number(row?.deletes || 0),
    submitted: Number(row?.submitted || 0),
    oldest_queued_at: row?.oldest ?? null,
  };
}

/**
 * Exact semantic-projection readiness, not provider reachability.
 *
 * Read Vectorize first and D1 second. If ingest or a drain advances D1 between
 * those observations, the newer queue/fence makes this fail closed. A write
 * that starts after the D1 read simply starts after this point-in-time check.
 */
export async function vectorReadiness(env) {
  let description;
  try {
    description = await env.VECTORIZE.describe();
  } catch (error) {
    throw new Error(`the vector index could not report readiness: ${String(error?.message || error).slice(0, 240)}`);
  }
  const vectorCount = Number(
    description?.vectorCount ?? description?.vectorsCount ?? description?.count,
  );
  if (!Number.isSafeInteger(vectorCount) || vectorCount < 0) {
    throw new Error("the vector index returned an invalid vector count");
  }

  const state = await env.DB.prepare(
    `SELECT schema_version,
            vector_projection_mutation_id AS mutation_id,
            vector_projection_submitted_at AS mutation_submitted_at,
            vector_projection_status AS projection_status,
            vector_projection_bootstrap_epoch AS bootstrap_epoch,
            vector_projection_bootstrap_cursor AS bootstrap_cursor,
            vector_projection_bootstrap_high_water AS bootstrap_high_water,
            (SELECT count(*) FROM chunks) AS expected_vectors,
            (SELECT count(*) FROM vector_outbox) AS pending,
            (SELECT count(*) FROM vector_outbox
              WHERE submitted_mutation_id IS NOT NULL) AS submitted,
            (SELECT min(queued_at) FROM vector_outbox) AS oldest_queued_at
       FROM install_state WHERE id = 1`
  ).first();
  if (!state || Number(state.schema_version) < 12) {
    throw new Error("the vector visibility receipt schema is not active");
  }
  const expected = Number(state.expected_vectors);
  const pending = Number(state.pending);
  const submitted = Number(state.submitted);
  if (![expected, pending, submitted].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      submitted > pending) {
    throw new Error("the vector readiness counts are invalid");
  }

  const mutationId = state.mutation_id === null || state.mutation_id === undefined || state.mutation_id === ""
    ? null
    : String(state.mutation_id);
  let mutationProcessed = mutationId === null;
  if (mutationId !== null) {
    const processed = description?.processedUpToMutation;
    if (processed === null || processed === undefined || processed === "") {
      mutationProcessed = false;
    } else if (typeof processed !== "string" && typeof processed !== "number") {
      throw new Error("the vector index did not expose its processed mutation watermark");
    } else {
      mutationProcessed = String(processed) === mutationId;
    }
  }

  const countsMatch = vectorCount === expected;
  const status = String(state.projection_status || "");
  const bootstrapEpoch = Number(state.bootstrap_epoch);
  if (!["verified", "pending", "bootstrap_required"].includes(status) ||
      !Number.isSafeInteger(bootstrapEpoch) || bootstrapEpoch < 0) {
    throw new Error("the vector projection verification state is invalid");
  }
  const ready = pending === 0 && mutationProcessed && countsMatch &&
    (expected === 0 || status === "verified");
  let reason = null;
  let action = null;
  if (!ready) {
    if (status === "bootstrap_required") {
      reason = "projection_bootstrap_required";
      action = "Run `brain update <manifest>` to resume the bounded legacy vector bootstrap.";
    } else if (pending > 0) {
      reason = submitted > 0 && !mutationProcessed
        ? "accepted_mutation_processing"
        : submitted > 0
          ? "accepted_mutation_needs_confirmation"
          : "vector_work_queued";
      action = "Run `brain drain <manifest>`; it confirms provider visibility without re-embedding accepted rows.";
    } else if (!mutationProcessed) {
      reason = "accepted_mutation_processing";
      action = "Wait for Vectorize processing, then run `brain drain <manifest>` again.";
    } else if (!countsMatch) {
      reason = "vector_count_mismatch";
      action = vectorCount < expected
        ? "Run `brain diagnose <manifest>`, then `brain reindex <manifest> --yes` to rebuild missing vectors."
        : "Vectorize has provider-only vectors that reindex cannot enumerate. Use a reviewed recovery to recreate/rebind the index and metadata indexes, then reindex and verify exact readiness.";
    } else {
      reason = "projection_unverified";
      action = "Run `brain drain <manifest>` to finish the exact vector verification receipt.";
    }
  }
  return {
    ready,
    reason,
    expected_vectors: expected,
    actual_vectors: vectorCount,
    pending,
    submitted,
    oldest_queued_at: state.oldest_queued_at ?? null,
    mutation_submitted_at: state.mutation_submitted_at ?? null,
    projection_status: status,
    bootstrap_epoch: bootstrapEpoch,
    action,
  };
}

/**
 * Remove documents from D1 and durably queue their Vectorize cleanup.
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
 * way to fail. The exclusive leased drain later removes the vectors to reclaim
 * the space.
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
  // read and mutation is partitioned below that separate bind-parameter limit.
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

  // Physical vector deletion is deliberately enqueue-only here. `drainOutbox`
  // is the sole Vectorize writer and owns the exclusive D1 lease; letting
  // forget write Vectorize directly would let a stale in-flight upsert land
  // after this delete. D1 hydration already makes the removed content
  // unreachable, while the durable delete rows make space reclamation
  // retryable after crashes or a busy drain.
  const vectors = 0;

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
    vector_cleanup_queued: chunkUids.length,
    dry_run: false, vector_error: null, targets,
  };
}

/** Count live physical rows and logical families in one derived source namespace. */
export async function sourceFamilyCounts(env, { source } = {}) {
  const normalizedSource = String(source || "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedSource)) {
    throw new TypeError("source family counts need a normalized source name");
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS stored_documents,
            COUNT(DISTINCT family_doc_uid) AS logical_documents
       FROM (
         SELECT CASE
           WHEN json_valid(meta)
            AND json_type(meta,'$.family_of') = 'text'
            AND length(json_extract(meta,'$.family_of')) > 0
             THEN json_extract(meta,'$.family_of')
           WHEN json_valid(meta)
            AND json_type(meta,'$.part_of') = 'text'
            AND length(json_extract(meta,'$.part_of')) > 0
             THEN CASE
               WHEN substr(json_extract(meta,'$.part_of'), 1, length(source) + 1) = source || ':'
                 THEN json_extract(meta,'$.part_of')
               ELSE source || ':' || json_extract(meta,'$.part_of')
             END
           ELSE doc_uid
         END AS family_doc_uid
           FROM documents
          WHERE deleted_at IS NULL
       )
      WHERE substr(family_doc_uid, 1, length(?1) + 1) = ?1 || ':'`
  ).bind(normalizedSource).first();
  return {
    stored_documents: Number(row?.stored_documents || 0),
    logical_documents: Number(row?.logical_documents || 0),
  };
}

/**
 * Return one uid per live logical source family in stable lexical pages.
 * Large connector documents use `meta.part_of`; multi-document exports use a
 * fully qualified `meta.family_of`. The latter can deliberately cross the
 * stored row's source namespace, for example `message:*` rows belonging to an
 * `upload:*` file. Source filtering therefore applies to the derived family
 * uid rather than to the physical row. DISTINCT happens before the cursor and
 * LIMIT so either representation occupies exactly one reconciliation slot.
 */
export async function listSourceFamilies(env, { source = null, cursor = "", limit = 500 } = {}) {
  // With no source filter this query derives the complete source set from live
  // document rows themselves. `corpus_stats` is useful operational metadata,
  // but it is denormalized and therefore cannot be the discovery boundary for
  // a completeness proof. A missing stats row must not hide an indexed family.
  const statement = source
    ? env.DB.prepare(
      `SELECT family_doc_uid
         FROM (
           SELECT DISTINCT CASE
             WHEN json_valid(meta)
              AND json_type(meta,'$.family_of') = 'text'
              AND length(json_extract(meta,'$.family_of')) > 0
               THEN json_extract(meta,'$.family_of')
             WHEN json_valid(meta)
              AND json_type(meta,'$.part_of') = 'text'
              AND length(json_extract(meta,'$.part_of')) > 0
               THEN CASE
                 WHEN substr(json_extract(meta,'$.part_of'), 1, length(source) + 1) = source || ':'
                   THEN json_extract(meta,'$.part_of')
                 ELSE source || ':' || json_extract(meta,'$.part_of')
               END
             ELSE doc_uid
           END AS family_doc_uid
             FROM documents
            WHERE deleted_at IS NULL
         )
        WHERE substr(family_doc_uid, 1, length(?1) + 1) = ?1 || ':'
          AND family_doc_uid > ?2
        ORDER BY family_doc_uid ASC
        LIMIT ?3`
    ).bind(source, cursor, limit + 1)
    : env.DB.prepare(
      `SELECT family_doc_uid
         FROM (
           SELECT DISTINCT CASE
             WHEN json_valid(meta)
              AND json_type(meta,'$.family_of') = 'text'
              AND length(json_extract(meta,'$.family_of')) > 0
               THEN json_extract(meta,'$.family_of')
             WHEN json_valid(meta)
              AND json_type(meta,'$.part_of') = 'text'
              AND length(json_extract(meta,'$.part_of')) > 0
               THEN CASE
                 WHEN substr(json_extract(meta,'$.part_of'), 1, length(source) + 1) = source || ':'
                   THEN json_extract(meta,'$.part_of')
                 ELSE source || ':' || json_extract(meta,'$.part_of')
               END
             ELSE doc_uid
           END AS family_doc_uid
             FROM documents
            WHERE deleted_at IS NULL
         )
        WHERE family_doc_uid > ?1
        ORDER BY family_doc_uid ASC
        LIMIT ?2`
    ).bind(cursor, limit + 1);
  const { results } = await statement.all();

  const page = (results || []).slice(0, limit).map((row) => String(row.family_doc_uid));
  return {
    source,
    families: page,
    next_cursor: (results || []).length > limit ? page[page.length - 1] : null,
  };
}

/** True when `uid` is the base itself or one of its oversized `#part` slices. */
const isStructuralFamilyMember = (uid, base) => uid === base || uid.startsWith(`${base}#part`);

/**
 * Remove stale members of a document family after every replacement part has
 * landed. This covers all three transitions: one-to-many, many-to-one and a
 * changed part count.
 *
 * WHAT A FAMILY IS. Two different producers put many documents under one base:
 *
 *   STRUCTURAL. splitOversized slices one oversized document into
 *   `<base>#part1of3`. The base is a literal prefix of every member, so
 *   membership is readable from the name alone.
 *
 *   DECLARED. A message export (WhatsApp .txt, SMS Backup & Restore .xml,
 *   Google Voice Takeout) is one file that becomes many conversation-session
 *   documents. Those keep their own `message:<first message id>` identity so a
 *   citation still points at the conversation, which means NOTHING in their
 *   names points back at the file. They say so instead: each row carries
 *   `meta.family_of` holding the fully qualified uid of the file it came from.
 *   Fully qualified deliberately, so no source-prefixing rule has to be
 *   re-derived here and mis-derived (`listSourceFamilies` has to guess at that
 *   for the older bare `part_of` values, and this format removes the guess).
 *
 * THE INVARIANT THIS ENFORCES, and why it is at least as strong as the exact
 * `#part` prefix test it replaces:
 *
 *   Every keep_doc_uid must belong to the family named by base_doc_uid, proven
 *   either structurally OR by the stored row's own declaration.
 *
 * The delete set is (everything in the family) minus (the keep list). A keep
 * uid that is not in the family protects nothing, so a caller whose family
 * model is wrong does not merely no-op: its keep list is inert while the scope
 * is real, and cleanup deletes the very revision it was called to reconcile.
 * The old prefix test was a syntactic PROXY for "inside the scope", correct
 * only while every family was structural. It now measures the real thing:
 * anything the old test rejected is still rejected unless the stored document
 * itself declares membership, which is stronger evidence than a matching name.
 *
 * Refusing is also the only honest option, because a wrong family key cannot be
 * repaired here: the scope is derived from the base alone, so an accepted-but
 * wrong base silently reaches no member at all.
 */
export async function forgetFamilies(env, { families = [], dryRun = true } = {}) {
  const normalized = [];
  for (const family of families || []) {
    const base = String(family?.base_doc_uid || "");
    const keep = [...new Set((family?.keep_doc_uids || []).map(String))];
    if (!base) {
      throw new Error("each document family needs a base_doc_uid and any keep_doc_uids must belong to it");
    }
    normalized.push({ base, keep });
  }
  if (!normalized.length) return { documents: 0, chunks: 0, vectors: 0, dry_run: dryRun, targets: [] };

  const stale = [];
  for (let i = 0; i < normalized.length; i += 25) {
    const group = normalized.slice(i, i + 25);
    const clauses = [];
    const binds = [];
    for (const family of group) {
      const n = binds.length;
      // D1 rejects LIKE/GLOB patterns longer than 50 bytes. Drive ids routinely
      // exceed that before the literal "#part" suffix is added, so a pattern
      // query cannot be used here. Comparing the exact leading substring keeps
      // %, _ and \\ literal and cannot include a similarly prefixed base id.
      // The declared arm is a plain equality on a fully qualified uid, so it
      // has neither problem. Neither arm adds a scan the substr did not already
      // force, and json_valid() guards a row whose meta is not JSON.
      clauses.push(
        `(doc_uid = ?${n + 1}` +
        ` OR substr(doc_uid, 1, length(?${n + 1} || '#part')) = ?${n + 1} || '#part'` +
        ` OR (json_valid(meta) AND json_type(meta,'$.family_of') = 'text'` +
        `     AND json_extract(meta,'$.family_of') = ?${n + 1}))`
      );
      binds.push(family.base);
    }
    const { results } = await env.DB.prepare(
      `SELECT doc_uid,
              CASE WHEN json_valid(meta) AND json_type(meta,'$.family_of') = 'text'
                   THEN json_extract(meta,'$.family_of') END AS family_of
         FROM documents WHERE ${clauses.join(" OR ")}`
    ).bind(...binds).all();
    const rows = (results || []).map((row) => ({
      uid: String(row.doc_uid),
      declaredFamily: row.family_of == null ? null : String(row.family_of),
    }));

    // Validate against what the family actually contains, one family at a
    // time, BEFORE anything is deleted. forget() below is the only mutation in
    // this function, so a refusal here leaves every group untouched.
    for (const family of group) {
      const members = new Set(
        rows.filter((row) => row.declaredFamily === family.base).map((row) => row.uid)
      );
      const stray = family.keep.filter(
        (uid) => !isStructuralFamilyMember(uid, family.base) && !members.has(uid)
      );
      if (stray.length) {
        // Deliberately no uid in the message: this reaches an HTTP response,
        // and a doc_uid carries a file path.
        throw new Error("each document family needs a base_doc_uid and any keep_doc_uids must belong to it");
      }
    }

    const keep = new Set(group.flatMap((family) => family.keep));
    stale.push(...rows.map((row) => row.uid).filter((uid) => !keep.has(uid)));
  }
  return forget(env, { docUids: [...new Set(stale)], dryRun });
}
