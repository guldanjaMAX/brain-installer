/**
 * store — one retrieval interface, two backends.
 *
 * The product backend is "d1", which keeps the entire brain inside the single
 * Cloudflare account the client already owns. The Supabase adapter remains only
 * as a migration source, comparison path and temporary rollback while James's
 * existing corpus is moved onto the same architecture every client installs.
 *
 * The point of this file is that index.js should never know which. Every
 * difference between the two backends is absorbed here, so migration comparison
 * and temporary rollback do not require a rewrite of the endpoints.
 *
 * SHAPE CONTRACT, honoured by both backends:
 *
 *   search()  -> { results: [{ chunk_uid, source, title, snippet, ts, score }],
 *                  degraded: string|null }
 *   ingest()  -> { doc_uid, action: created|unchanged|updated, chunks, queued }
 *   stats()   -> { rows: [{ source_type, total, embedded, last_ingested }] }
 *
 * `ts` is a DOCUMENT date or null, never a file-touch timestamp. A null here
 * is load-bearing: it is what lets the gap engine say "undated" honestly
 * instead of asserting recency it has not earned.
 */

import * as d1 from "./store-d1.js";
import { embedText, supabaseRpc } from "./supabase.js";

export const D1 = "d1";
export const SUPABASE = "supabase";

export function backendOf(env) {
  const declared = (env.STORAGE || "").toLowerCase();
  if (declared === D1 || declared === SUPABASE) return declared;
  // Infer rather than guess wrong. A worker with a Vectorize binding and no
  // Supabase credentials can only be a D1 install.
  if (env.VECTORIZE && !env.SUPABASE_URL) return D1;
  return SUPABASE;
}

/* ------------------------------------------------------------------ chunking */

// Keep the body below the embedding model's effective 512-token window even
// after the title header is added. The previous 2000/500 geometry made 93% of
// James's first real D1 corpus long enough to be truncated before embedding.
export const CHUNK_SIZE = 1500;
export const CHUNK_OVERLAP = 300;

export function chunkGeometry(env = {}) {
  const rawSize = Number.parseInt(env.CHUNK_SIZE, 10);
  const rawOverlap = Number.parseInt(env.CHUNK_OVERLAP, 10);
  const size = Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 256), 1800) : CHUNK_SIZE;
  const overlap = Number.isFinite(rawOverlap) ? Math.min(Math.max(rawOverlap, 0), size - 1) : CHUNK_OVERLAP;
  return { size, overlap };
}

/**
 * Sliding window, same geometry as the Drive indexer so a document chunked by
 * either path lands the same way and a citation means the same thing.
 *
 * The document's identity is prepended to every chunk BEFORE embedding, so a
 * fragment that says only "we agreed to defer it" still carries what "it" was
 * about. Cheap, and it is the difference between a retrievable chunk and a
 * floating sentence.
 */
export function chunkText(text, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, header = "" } = {}) {
  const body = String(text || "");
  if (!body.trim()) return [];
  const out = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < body.length; start += step) {
    const piece = body.slice(start, start + size).trim();
    if (piece) out.push(header ? `${header}\n\n${piece}` : piece);
    if (start + size >= body.length) break;
  }
  return out;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------------------------------------------------------- D1 backend */

const d1Backend = {
  async search(env, { query, limit, filters = {}, weights = {} }) {
    let embedding = null;
    try {
      embedding = await embedText(env, query);
    } catch {
      // Degrade to keyword rather than fail. store-d1 reports which side answered.
    }
    const r = await d1.search(env, { query, embedding, limit, filters, weights });
    return {
      results: r.results.map((x) => {
        const sourceId = x.source_id || (
          x.doc_uid && x.source && x.doc_uid.startsWith(`${x.source}:`)
            ? x.doc_uid.slice(x.source.length + 1)
            : x.doc_uid || x.chunk_uid
        );
        return {
        chunk_uid: x.chunk_uid,
        doc_uid: x.doc_uid || null,
        source_id: sourceId,
        // Public identity is document-level. A chunk id changes when geometry
        // changes and used to let one document consume most of a result page.
        ref_key: sourceId,
        drive_file_id: x.source === "drive" ? sourceId : null,
        source: x.source,
        title: x.title,
        snippet: x.text,
        uri: x.uri || null,
        client: x.client ?? null,
        category: x.category ?? null,
        top_folder: x.top_folder ?? null,
        platform: x.platform ?? null,
        ts: x.document_date ? new Date(Number(x.document_date)).toISOString() : null,
        score: x.rrf_score,
      };
      }),
      degraded: r.degraded,
      ignored_filters: r.ignored_filters,
      counts: r.counts,
    };
  },

  async ingest(env, envelope) {
    const { source_type, source_id, content, title } = envelope;
    const docUid = `${source_type}:${source_id}`;
    const md = envelope.metadata || {};
    const owns = (key) => Object.prototype.hasOwnProperty.call(md, key);
    const hasClient = owns("client_name") || owns("client");
    const hasCategory = owns("category");
    const hasTopFolder = owns("top_folder");
    const hasPlatform = owns("platform");
    const incomingClient = md.client_name || md.client || null;
    const incomingCategory = md.category || null;
    const incomingTopFolder = md.top_folder || null;
    const incomingPlatform = md.platform || null;
    const docDate = envelope.occurred_at ? Date.parse(envelope.occurred_at) : null;
    const geometry = chunkGeometry(env);
    // Geometry is part of storage identity. A deploy that corrects chunk size
    // must re-chunk unchanged documents on their next ingest instead of taking
    // the content-only no-op path forever.
    const hash = await sha256Hex(`chunk-v1:${geometry.size}:${geometry.overlap}\0${content}`);

    const prior = await env.DB.prepare(
      `SELECT content_hash, title, document_date, date_reliable, client, category, top_folder, platform
       FROM documents WHERE doc_uid = ?1`
    )
      .bind(docUid)
      .first();
    // Identical content AND filter identity is a no-op. Folder moves and title
    // changes still have to rewrite chunks because both the embedded header and
    // Vectorize metadata changed. Missing incoming metadata is not a request to
    // erase a richer migration record.
    const metadataChanged = prior && (
      (title != null && title !== prior.title) ||
      (envelope.date_reliable && Number.isFinite(docDate) && docDate !== prior.document_date) ||
      (hasClient && incomingClient !== prior.client) ||
      (hasCategory && incomingCategory !== prior.category) ||
      (hasTopFolder && incomingTopFolder !== prior.top_folder) ||
      (hasPlatform && incomingPlatform !== prior.platform)
    );
    if (prior && prior.content_hash === hash && !metadataChanged) {
      return { doc_uid: docUid, action: "unchanged", chunks: 0, queued: 0 };
    }

    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, uri, document_date,
                              date_source, date_reliable, client, category,
                              top_folder, platform, ingested_at, content_hash, meta)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
       ON CONFLICT(doc_uid) DO UPDATE SET
         title=COALESCE(excluded.title, documents.title),
         uri=COALESCE(excluded.uri, documents.uri),
         document_date=CASE
           WHEN excluded.date_reliable = 1 OR documents.document_date IS NULL THEN excluded.document_date
           ELSE documents.document_date END,
         date_source=CASE
           WHEN excluded.date_reliable = 1 OR documents.document_date IS NULL THEN excluded.date_source
           ELSE documents.date_source END,
         date_reliable=MAX(COALESCE(documents.date_reliable, 0), COALESCE(excluded.date_reliable, 0)),
         client=CASE WHEN ?16 = 1 THEN excluded.client ELSE documents.client END,
         category=CASE WHEN ?17 = 1 THEN excluded.category ELSE documents.category END,
         top_folder=CASE WHEN ?18 = 1 THEN excluded.top_folder ELSE documents.top_folder END,
         platform=CASE WHEN ?19 = 1 THEN excluded.platform ELSE documents.platform END,
         ingested_at=excluded.ingested_at, content_hash=excluded.content_hash,
         meta=json_patch(COALESCE(documents.meta, '{}'), excluded.meta)`
    )
      .bind(
        docUid, source_type, String(source_id), title ?? null, envelope.uri ?? null,
        Number.isFinite(docDate) ? docDate : null,
        envelope.date_source ?? (docDate ? "provided" : null),
        envelope.date_reliable ? 1 : 0,
        incomingClient, incomingCategory, incomingTopFolder, incomingPlatform,
        now, hash, JSON.stringify(md),
        hasClient ? 1 : 0, hasCategory ? 1 : 0, hasTopFolder ? 1 : 0, hasPlatform ? 1 : 0
      )
      .run();

    // Replace rather than merge. A shorter revision must not leave the tail of
    // the previous version behind, answering questions from text that is gone.
    await d1.replaceDocumentChunks(env, docUid);

    // Use the merged document row for chunks too. Otherwise the document would
    // preserve a migrated `medical` category while its replacement vectors
    // silently lost that filter.
    const merged = await env.DB.prepare(
      "SELECT client, category, top_folder, platform FROM documents WHERE doc_uid = ?1"
    ).bind(docUid).first();
    const client = merged?.client || null;
    const category = merged?.category || null;
    const topFolder = merged?.top_folder || null;
    const platform = merged?.platform || null;
    const header = title ? `[${title}]` : "";
    const pieces = chunkText(content, { header, ...geometry });
    const chunks = pieces.map((text, i) => ({
      chunk_uid: `${docUid}#${i}`,
      doc_uid: docUid,
      chunk_ix: i,
      text,
      source: source_type,
      title: title ?? null,
      document_date: Number.isFinite(docDate) ? docDate : null,
      client,
      category,
      top_folder: topFolder,
      platform,
    }));

    const w = await d1.upsertChunks(env, chunks);

    // DERIVED, not incremented. The previous version added the new chunk count
    // to the running total, but a re-ingest DELETEs the old chunks first, so
    // every update inflated the number. This is the one figure a client is told
    // to trust, so it is recomputed from the rows that actually exist rather
    // than accumulated and hoped for.
    await env.DB.prepare(
      `INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
       SELECT ?1, COUNT(DISTINCT doc_uid), COUNT(*), ?2 FROM chunks WHERE source = ?1
       ON CONFLICT(source) DO UPDATE SET
         documents = excluded.documents,
         chunks = excluded.chunks,
         last_ingest_at = excluded.last_ingest_at`
    )
      .bind(source_type, now)
      .run();

    return {
      doc_uid: docUid,
      action: prior ? "updated" : "created",
      chunks: chunks.length,
      queued: w.queued,
    };
  },

  async stats(env) {
    const { results } = await env.DB.prepare(
      `SELECT s.source AS source_type, s.documents, s.chunks AS total,
              s.last_ingest_at,
              s.chunks - COALESCE(o.pending, 0) AS embedded
       FROM corpus_stats s
       LEFT JOIN (SELECT c.source, count(*) AS pending
                    FROM vector_outbox v JOIN chunks c ON c.chunk_uid = v.chunk_uid
                   GROUP BY c.source) o ON o.source = s.source`
    ).all();
    return {
      rows: (results || []).map((r) => ({
        source_type: r.source_type,
        // BOTH, separately. `total` is a CHUNK count, and a caller comparing it
        // to a document count sees permanent drift that is not real. A warning
        // that always fires is worse than no warning: it teaches people to
        // ignore the one time it means something.
        documents: Number(r.documents || 0),
        chunks: Number(r.total || 0),
        total: Number(r.total || 0),
        embedded: Number(r.embedded || 0),
        last_ingested: r.last_ingest_at ? new Date(Number(r.last_ingest_at)).toISOString() : null,
      })),
    };
  },
};

/* ----------------------------------------------------------- Supabase backend */

const supabaseBackend = {
  async search(env, { query, limit, filters = {}, weights = {}, rrfK = 60 }) {
    let embedding;
    try {
      embedding = await embedText(env, query);
    } catch {
      const rows = await supabaseRpc(env, "notes_fts_documents", {
        query_text: query, match_count: limit,
        filter_category: filters.category || null, filter_client: filters.client || null,
      });
      return {
        results: (rows || []).map((r) => ({
          chunk_uid: r.d1_key, ref_key: r.d1_key, source: "curated",
          title: r.title, snippet: String(r.content || "").slice(0, 900),
          ts: r.meeting_date || null, score: null,
          client: r.client_name || null, category: r.category || null,
          top_folder: r.top_folder || null, platform: r.platform || null,
        })),
        degraded: "fts", ignored_filters: [],
      };
    }
    const matches = await supabaseRpc(env, "notes_unified_hybrid_search", {
      query_text: query, query_embedding: embedding, match_count: limit, rrf_k: rrfK,
      filter_source: filters.source || null, filter_top_folder: filters.top_folder || null,
      filter_category: filters.category || null, filter_client: filters.client || null,
      filter_from: filters.from || null, filter_to: filters.to || null,
      filter_platform: filters.platform || null,
      weight_curated: weights.curated ?? 1.0, weight_drive: weights.drive ?? 1.0,
      weight_message: weights.message ?? 1.0,
    });
    return {
      results: (matches || []).map((r) => ({
        chunk_uid: r.ref_key, ref_key: r.ref_key, source: r.source, title: r.title,
        snippet: r.snippet, ts: r.ts || null, score: r.rrf_score,
        client: r.client || null, category: r.category || null,
        top_folder: r.top_folder || null, platform: r.platform || null,
      })),
      degraded: null, ignored_filters: [],
    };
  },

  async ingest(env, envelope) {
    const rows = await supabaseRpc(env, "notes_brain_ingest", {
      p_source_type: envelope.source_type, p_source_id: String(envelope.source_id),
      p_content: envelope.content, p_source_subtype: envelope.source_subtype || null,
      p_occurred_at: envelope.occurred_at || null, p_title: envelope.title || null,
      p_metadata: envelope.metadata || {}, p_legacy_table: null, p_legacy_id: null,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { doc_uid: row?.id, action: row?.action, chunks: null, queued: 0, needs_embed: row?.needs_embed };
  },

  async stats(env) {
    const rows = await supabaseRpc(env, "notes_brain_documents_summary", {});
    return { rows: rows || [] };
  },
};

/* -------------------------------------------------------------------- facade */

export function storeFor(env) {
  return backendOf(env) === D1 ? d1Backend : supabaseBackend;
}
