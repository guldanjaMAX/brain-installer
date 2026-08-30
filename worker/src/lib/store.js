/**
 * store — one retrieval interface, two backends.
 *
 * The product backend is "d1", which keeps the entire brain inside the single
 * Cloudflare account the client already owns. The Supabase adapter remains only
 * as a migration source, comparison path and temporary rollback while an
 * existing corpus is moved onto the same architecture every client installs.
 *
 * The point of this file is that index.js should never know which. Every
 * difference between the two backends is absorbed here, so migration comparison
 * and temporary rollback do not require a rewrite of the endpoints.
 *
 * SHAPE CONTRACT, honoured by both backends:
 *
 *   search()  -> { results: [{ chunk_uid, source, title, snippet, ts, score }],
 *                  degraded: string|null, degraded_reason: string|null }
 *
 * `degraded` is load-bearing in the same way `ts` is. It is the ONLY field that
 * separates "the corpus holds nothing" from "part of the search never ran", and
 * a zero-result response that drops it lets a consumer state an absence it
 * cannot verify. See worker/src/lib/retrieval-status.js.
 *   ingest()  -> { doc_uid, action: created|unchanged|updated, chunks, queued }
 *   stats()   -> { rows: [{ source_type, total, embedded, last_ingested }] }
 *
 * `ts` is a DOCUMENT date or null, never a file-touch timestamp. A null here
 * is load-bearing: it is what lets the gap engine say "undated" honestly
 * instead of asserting recency it has not earned.
 */

import * as d1 from "./store-d1.js";
import { embedText, supabaseRpc } from "./supabase.js";
import { sanitizeEnvelope, sanitizeSensitiveLinks } from "./secret-scan.js";
import {
  DEFAULT_INGEST_CHUNK_OVERLAP,
  DEFAULT_INGEST_CHUNK_SIZE,
  ingestChunkGeometry,
  ingestContentHash,
} from "./install-smoke.js";

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
// The first large field D1 corpus was long enough to be truncated before embedding.
export const CHUNK_SIZE = DEFAULT_INGEST_CHUNK_SIZE;
export const CHUNK_OVERLAP = DEFAULT_INGEST_CHUNK_OVERLAP;
// Cloudflare's paid Workers limit counts every statement submitted through a
// D1 batch, not merely one service-binding round trip. Leave ten percent of the
// 1,000-query invocation limit for platform/runtime evolution rather than
// discovering the cap after half a request has durable pending revisions.
export const D1_INGEST_STATEMENT_BUDGET = 900;

export function chunkGeometry(env = {}) {
  return ingestChunkGeometry(env);
}

function conservativeChunkCount(content, geometry) {
  const body = String(content || "");
  if (!body.trim()) return 0;
  if (body.length <= geometry.size) return 1;
  return 1 + Math.ceil((body.length - geometry.size) / (geometry.size - geometry.overlap));
}

/**
 * Bound one HTTP batch before its first D1 statement.
 *
 * This intentionally assumes every document changed, every unique-document
 * preflight failed after consuming its reads, every source needs its own stats
 * refresh/readback, and every document needs the larger resumable stage. The
 * estimate is therefore above the normal path (50 one-chunk messages submit
 * 352 statements but reserve 550) while still accepting that replay shape.
 */
export function estimateD1IngestStatements(env, envelopes) {
  const geometry = chunkGeometry(env);
  return (envelopes || []).reduce((total, envelope) => {
    const chunks = conservativeChunkCount(envelope?.content, geometry);
    return total + 9 + (chunks * 2);
  }, 0);
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

async function prepareD1Envelope(env, envelope) {
  const { source_type, source_id, content, title } = envelope;
  const docUid = `${source_type}:${source_id}`;
  const md = envelope.metadata || {};
  const owns = (key) => Object.prototype.hasOwnProperty.call(md, key);
  const hasEntity = owns("entity_slug") && typeof md.entity_slug === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(md.entity_slug);
  const hasClient = owns("client_name") || owns("client");
  const hasCategory = owns("category");
  const hasTopFolder = owns("top_folder");
  const hasPlatform = owns("platform");
  const incomingEntity = hasEntity ? md.entity_slug : null;
  const incomingClient = md.client_name || md.client || null;
  const incomingCategory = md.category || null;
  const incomingTopFolder = md.top_folder || null;
  const incomingPlatform = md.platform || null;
  const docDate = envelope.occurred_at ? Date.parse(envelope.occurred_at) : null;
  // How the text was OBTAINED, as opposed to what it says. Absent means the
  // file carried its own text layer, which is true of every document written
  // before OCR existed and of every non-PDF format now. Last write wins here,
  // unlike client/category: a document that has just been re-extracted from a
  // real text layer must stop being marked as a scan.
  const textSource = TEXT_SOURCES.has(envelope.text_source) ? envelope.text_source : "native";
  const textReliable = textSource === "native"
    ? envelope.text_reliable !== false
    : envelope.text_reliable === true;
  const geometry = chunkGeometry(env);
  // Geometry is part of storage identity. A deploy that corrects chunk size
  // must re-chunk unchanged documents on their next ingest instead of taking
  // the content-only no-op path forever.
  const hash = await ingestContentHash(env, content);
  return {
    envelope,
    source_type,
    source_id,
    content,
    title,
    docUid,
    md,
    hasEntity,
    hasClient,
    hasCategory,
    hasTopFolder,
    hasPlatform,
    incomingEntity,
    incomingClient,
    incomingCategory,
    incomingTopFolder,
    incomingPlatform,
    textSource,
    textReliable,
    docDate,
    geometry,
    hash,
  };
}

/**
 * The only three answers to "where did this text come from".
 * `native` is the default and the state of every pre-OCR document.
 */
export const TEXT_SOURCES = new Set(["native", "ocr", "ocr_partial"]);

function jsonValue(raw, fallback = {}) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// SQLite json_patch follows JSON Merge Patch semantics. Mirror it here only to
// decide whether the persisted row is truly unchanged; D1 remains the writer.
function mergeJsonPatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base = target && typeof target === "object" && !Array.isArray(target)
    ? structuredClone(target)
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      base[key] = mergeJsonPatch(base[key], value);
    } else {
      base[key] = structuredClone(value);
    }
  }
  return base;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const safePriorString = (value) => typeof value === "string" ? sanitizeSensitiveLinks(value) : value;

/**
 * Derive the row D1 will hold after its preserve-when-omitted update rules.
 * Previously the no-op check covered only title and filter columns. A safety
 * transform in URI or arbitrary JSON metadata could therefore be skipped even
 * though the old private URL remained durable and vector-adjacent.
 */
function d1PersistedState(prior, prepared) {
  const current = prior || {};
  const safeTitle = safePriorString(current.title);
  const safeUri = safePriorString(current.uri);
  const safeDateSource = safePriorString(current.date_source);
  const safeEntity = safePriorString(current.entity_slug);
  const safeClient = safePriorString(current.client);
  const safeCategory = safePriorString(current.category);
  const safeTopFolder = safePriorString(current.top_folder);
  const safePlatform = safePriorString(current.platform);

  const priorMeta = jsonValue(current.meta);
  const safePriorMeta = sanitizeEnvelope({ metadata: priorMeta }).metadata || {};
  const targetMeta = mergeJsonPatch(safePriorMeta, prepared.md);
  const priorMetaChangedBySafety = canonicalJson(priorMeta) !== canonicalJson(safePriorMeta);

  const incomingDateSource = prepared.envelope.date_source ?? (prepared.docDate ? "provided" : null);
  const forceDateSourceSafety = safeDateSource !== current.date_source;
  const replaceDate = Boolean(prepared.envelope.date_reliable) || current.document_date == null;
  const targetDateSource = forceDateSourceSafety
    ? safeDateSource
    : replaceDate ? incomingDateSource : current.date_source ?? null;

  const forceEntitySafety = safeEntity !== current.entity_slug;
  const forceClientSafety = safeClient !== current.client;
  const forceCategorySafety = safeCategory !== current.category;
  const forceTopFolderSafety = safeTopFolder !== current.top_folder;
  const forcePlatformSafety = safePlatform !== current.platform;

  return {
    title: prepared.title != null ? prepared.title : safeTitle ?? null,
    uri: prepared.envelope.uri != null ? prepared.envelope.uri : safeUri ?? null,
    document_date: replaceDate
      ? (Number.isFinite(prepared.docDate) ? prepared.docDate : null)
      : current.document_date ?? null,
    date_source: targetDateSource,
    date_reliable: Math.max(Number(current.date_reliable || 0), prepared.envelope.date_reliable ? 1 : 0),
    entity_slug: prepared.hasEntity ? prepared.incomingEntity : safeEntity ?? null,
    client: prepared.hasClient ? prepared.incomingClient : safeClient ?? null,
    category: prepared.hasCategory ? prepared.incomingCategory : safeCategory ?? null,
    top_folder: prepared.hasTopFolder ? prepared.incomingTopFolder : safeTopFolder ?? null,
    platform: prepared.hasPlatform ? prepared.incomingPlatform : safePlatform ?? null,
    text_source: prepared.textSource,
    text_reliable: prepared.textReliable ? 1 : 0,
    meta: targetMeta,
    // Bind a safe prior value only when an omitted incoming field would
    // otherwise preserve an already-stored capability URL.
    writeTitle: prepared.title != null ? prepared.title : safeTitle !== current.title ? safeTitle : null,
    writeUri: prepared.envelope.uri != null ? prepared.envelope.uri : safeUri !== current.uri ? safeUri : null,
    writeDateSource: forceDateSourceSafety ? safeDateSource : incomingDateSource,
    forceDateSourceSafety,
    writeEntity: prepared.hasEntity ? prepared.incomingEntity : safeEntity,
    writeClient: prepared.hasClient ? prepared.incomingClient : safeClient,
    writeCategory: prepared.hasCategory ? prepared.incomingCategory : safeCategory,
    writeTopFolder: prepared.hasTopFolder ? prepared.incomingTopFolder : safeTopFolder,
    writePlatform: prepared.hasPlatform ? prepared.incomingPlatform : safePlatform,
    writeHasEntity: prepared.hasEntity || forceEntitySafety,
    writeHasClient: prepared.hasClient || forceClientSafety,
    writeHasCategory: prepared.hasCategory || forceCategorySafety,
    writeHasTopFolder: prepared.hasTopFolder || forceTopFolderSafety,
    writeHasPlatform: prepared.hasPlatform || forcePlatformSafety,
    writeMeta: priorMetaChangedBySafety ? targetMeta : prepared.md,
    replaceMeta: priorMetaChangedBySafety,
  };
}

function d1MetadataChanged(prior, prepared) {
  if (!prior) return false;
  const target = d1PersistedState(prior, prepared);
  return (
    target.title !== (prior.title ?? null) ||
    target.uri !== (prior.uri ?? null) ||
    target.document_date !== (prior.document_date ?? null) ||
    target.date_source !== (prior.date_source ?? null) ||
    target.date_reliable !== Number(prior.date_reliable || 0) ||
    target.entity_slug !== (prior.entity_slug ?? null) ||
    target.client !== (prior.client ?? null) ||
    target.category !== (prior.category ?? null) ||
    target.top_folder !== (prior.top_folder ?? null) ||
    target.platform !== (prior.platform ?? null) ||
    // A document that was OCR'd and is now readable from a real text layer (or
    // the reverse) must rewrite even when its text happens to hash the same,
    // or the corpus would keep claiming a provenance that is no longer true.
    target.text_source !== (prior.text_source ?? "native") ||
    target.text_reliable !== Number(prior.text_reliable ?? 1) ||
    canonicalJson(target.meta) !== canonicalJson(jsonValue(prior.meta))
  );
}

function pendingRevisionMarker(hash) {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const revision = [...nonce].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pending:${hash}:${revision}`;
}

function validDeferredRevision(revision) {
  const hashIsValid = /^[a-f0-9]{64}$/.test(revision?.hash || "");
  const markerPrefix = hashIsValid ? `pending:${revision.hash}:` : "";
  const sourceIsValid = typeof revision?.source === "string" && revision.source.length > 0;
  const docUidIsValid = typeof revision?.doc_uid === "string" &&
    sourceIsValid &&
    revision.doc_uid.length > revision.source.length + 1 &&
    revision.doc_uid.startsWith(`${revision.source}:`);
  return Boolean(
    docUidIsValid &&
    typeof revision.pending_marker === "string" &&
    revision.pending_marker.startsWith(markerPrefix) &&
    /^[a-f0-9]{32}$/.test(revision.pending_marker.slice(markerPrefix.length)) &&
    Number.isSafeInteger(revision.ingested_at) &&
    revision.ingested_at > 0
  );
}

/**
 * Build the source-statistics half of an atomic revision commit.
 *
 * The JSON array uses one bind regardless of batch size, keeping a maximum
 * 50-document request below D1's per-statement bind ceiling. Only document
 * rows that still own the exact pending marker contribute freshness. With no
 * owners, the aggregate's HAVING clause emits no row and corpus_stats is left
 * byte-for-byte unchanged.
 */
function sourceStatsCommitStatement(env, source, revisions) {
  const candidates = JSON.stringify(revisions.map((revision) => [
    revision.doc_uid,
    revision.pending_marker,
    revision.ingested_at,
  ]));
  return env.DB.prepare(
    `WITH candidates AS (
       SELECT json_extract(value, '$[0]') AS doc_uid,
              json_extract(value, '$[1]') AS pending_marker,
              CAST(json_extract(value, '$[2]') AS INTEGER) AS ingested_at
       FROM json_each(?2)
     ), committing AS (
       SELECT candidates.ingested_at
       FROM candidates
       JOIN documents
         ON documents.doc_uid = candidates.doc_uid
        AND documents.source = ?1
        AND documents.content_hash = candidates.pending_marker
     ), source_counts AS (
       SELECT COUNT(DISTINCT doc_uid) AS documents, COUNT(*) AS chunks
       FROM chunks WHERE source = ?1
     )
     INSERT INTO corpus_stats (source, documents, chunks, last_ingest_at)
     SELECT ?1,
            MAX(source_counts.documents),
            MAX(source_counts.chunks),
            MAX(committing.ingested_at)
     FROM committing CROSS JOIN source_counts
     HAVING COUNT(*) > 0
     ON CONFLICT(source) DO UPDATE SET
       documents = excluded.documents,
       chunks = excluded.chunks,
       last_ingest_at = MAX(COALESCE(corpus_stats.last_ingest_at, 0), excluded.last_ingest_at)`
  ).bind(source, candidates);
}

/* ---------------------------------------------------------------- D1 backend */

const d1Backend = {
  estimateIngestBatchStatements(env, envelopes) {
    return {
      estimated_statements: estimateD1IngestStatements(env, envelopes),
      max_statements: D1_INGEST_STATEMENT_BUDGET,
    };
  },

  async search(env, { query, limit, filters = {}, weights = {}, rrfK = 60, access = null, scope = null }) {
    let embedding = null;
    if (access?.kind !== "grant" && (!scope || scope.all === true)) {
      try {
        embedding = await embedText(env, query);
      } catch {
        // Degrade to keyword rather than fail. store-d1 reports which side answered.
      }
    }
    const r = await d1.search(env, { query, embedding, limit, filters, weights, rrfK, access, scope });
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
          entity_slug: x.entity_slug ?? null,
          client: x.client ?? null,
          category: x.category ?? null,
          top_folder: x.top_folder ?? null,
          platform: x.platform ?? null,
          ts: x.document_date ? new Date(Number(x.document_date)).toISOString() : null,
          date_reliable: x.date_reliable === true || x.date_reliable === 1 || x.date_reliable === "1",
          date_source: x.date_source || null,
          // How this evidence was READ. Travels beside how it was DATED,
          // because a reader weighing an answer needs both.
          text_source: x.text_source || "native",
          text_reliable: x.text_reliable === undefined || x.text_reliable === null
            ? true
            : x.text_reliable === true || x.text_reliable === 1 || x.text_reliable === "1",
          score: x.rrf_score,
        };
      }),
      degraded: r.degraded,
      degraded_reason: r.degraded_reason ?? null,
      ignored_filters: r.ignored_filters,
      counts: r.counts,
    };
  },

  async ingest(env, envelope, { deferFinalize = false, prepared = null } = {}) {
    // A prepared state is accepted only for the same in-memory envelope object.
    // That keeps this internal optimization from becoming a way to pair one
    // document's hash or prior row with another document's content.
    const input = prepared?.envelope === envelope ? prepared : await prepareD1Envelope(env, envelope);
    const {
      source_type, source_id, content, title, docUid, md,
      hasEntity, hasClient, hasCategory, hasTopFolder, hasPlatform,
      incomingEntity, incomingClient, incomingCategory, incomingTopFolder, incomingPlatform,
      docDate, geometry, hash,
    } = input;

    const prior = Object.prototype.hasOwnProperty.call(input, "prior")
      ? input.prior
      : await env.DB.prepare(
        `SELECT content_hash, title, uri, document_date, date_source, date_reliable,
                entity_slug, client, category, top_folder, platform, text_source, text_reliable, meta
         FROM documents WHERE doc_uid = ?1`
      ).bind(docUid).first();
    // Identical content AND filter identity is a no-op. Folder moves and title
    // changes still have to rewrite chunks because both the embedded header and
    // Vectorize metadata changed. Missing incoming metadata is not a request to
    // erase a richer migration record.
    const metadataChanged = d1MetadataChanged(prior, input);
    if (prior && prior.content_hash === hash && !metadataChanged) {
      return { doc_uid: docUid, action: "unchanged", chunks: 0, queued: 0 };
    }

    const now = Date.now();
    const persisted = d1PersistedState(prior, input);

    // `content_hash` is the commit marker for a complete document revision.
    // Move it to a value that can never equal a real SHA-256 before touching the
    // chunks, then commit the real hash only after every required write succeeds.
    // This also covers metadata-only revisions: their content hash is unchanged,
    // but their title/header and filter metadata still require rebuilt chunks.
    // A content-derived pending marker is not enough. Two concurrent requests
    // can carry identical text but different title/filter metadata. If they
    // share `pending:<content-hash>`, both finalizers can claim the same marker
    // even though only one revision's metadata and chunks survived. The random
    // suffix makes ownership of the commit marker revision-specific.
    const pendingHash = pendingRevisionMarker(hash);
    const documentStatement = env.DB.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, uri, document_date,
                              date_source, date_reliable, client, category,
                              top_folder, platform, ingested_at, content_hash, meta,
                              text_source, text_reliable, entity_slug)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?22,?23,?24)
       ON CONFLICT(doc_uid) DO UPDATE SET
         title=COALESCE(excluded.title, documents.title),
         uri=COALESCE(excluded.uri, documents.uri),
         document_date=CASE
           WHEN excluded.date_reliable = 1 OR documents.document_date IS NULL THEN excluded.document_date
           ELSE documents.document_date END,
         date_source=CASE
           WHEN ?20 = 1 THEN excluded.date_source
           WHEN excluded.date_reliable = 1 OR documents.document_date IS NULL THEN excluded.date_source
           ELSE documents.date_source END,
         date_reliable=MAX(COALESCE(documents.date_reliable, 0), COALESCE(excluded.date_reliable, 0)),
         entity_slug=CASE WHEN ?25 = 1 THEN excluded.entity_slug ELSE documents.entity_slug END,
         client=CASE WHEN ?16 = 1 THEN excluded.client ELSE documents.client END,
         category=CASE WHEN ?17 = 1 THEN excluded.category ELSE documents.category END,
         top_folder=CASE WHEN ?18 = 1 THEN excluded.top_folder ELSE documents.top_folder END,
         platform=CASE WHEN ?19 = 1 THEN excluded.platform ELSE documents.platform END,
         ingested_at=excluded.ingested_at, content_hash=excluded.content_hash,
         -- Last write wins, unlike the filter columns above. Provenance
         -- describes THIS extraction, so preserving an older value would keep
         -- asserting a reading that has since been redone.
         text_source=excluded.text_source,
         text_reliable=excluded.text_reliable,
         meta=CASE WHEN ?21 = 1 THEN excluded.meta
                   ELSE json_patch(COALESCE(documents.meta, '{}'), excluded.meta) END`
    )
      .bind(
        docUid, source_type, String(source_id), persisted.writeTitle ?? null, persisted.writeUri ?? null,
        Number.isFinite(docDate) ? docDate : null,
        persisted.writeDateSource ?? null,
        envelope.date_reliable ? 1 : 0,
        persisted.writeClient ?? null, persisted.writeCategory ?? null,
        persisted.writeTopFolder ?? null, persisted.writePlatform ?? null,
        now, pendingHash, JSON.stringify(persisted.writeMeta),
        persisted.writeHasClient ? 1 : 0,
        persisted.writeHasCategory ? 1 : 0,
        persisted.writeHasTopFolder ? 1 : 0,
        persisted.writeHasPlatform ? 1 : 0,
        persisted.forceDateSourceSafety ? 1 : 0,
        persisted.replaceMeta ? 1 : 0,
        persisted.text_source,
        persisted.text_reliable,
        persisted.writeEntity ?? null,
        persisted.writeHasEntity ? 1 : 0
      );

    const header = title ? `[${title}]` : "";
    const pieces = chunkText(content, { header, ...geometry });
    const baseChunks = pieces.map((text, i) => ({
      chunk_uid: `${docUid}#${i}`,
      doc_uid: docUid,
      chunk_ix: i,
      text,
      source: source_type,
      title: title ?? null,
      document_date: Number.isFinite(docDate) ? docDate : null,
    }));

    let chunks = baseChunks;
    let w;
    if (deferFinalize && d1.canStageDocumentRevision(baseChunks.length)) {
      // Small changed documents are the dominant email/message migration case.
      // Stage one document per D1 transaction so a bad row cannot roll back a
      // neighbour. Chunk INSERT ... SELECT statements read the just-merged
      // document metadata inside that transaction, preserving rich migrated
      // filters without the previous extra service-binding read.
      w = await d1.stageDocumentRevision(env, {
        documentStatement,
        docUid,
        chunks: baseChunks,
        expectedContentHash: pendingHash,
      });
    } else {
      // Larger documents cannot fit their chunk and outbox statements under
      // our conservative 100-statement transaction slice. Keep the original
      // resumable sequence rather than couple its fate to another file.
      await documentStatement.run();

      // Replace rather than merge. A shorter revision must not leave the tail
      // of the previous version behind, answering from text that is gone.
      await d1.replaceDocumentChunks(env, docUid, { expectedContentHash: pendingHash });

      // Use the merged document row for chunks too. Otherwise the document
      // could preserve a migrated `medical` category while its replacement
      // vectors silently lost that filter.
      const merged = await env.DB.prepare(
        `SELECT client, category, top_folder, platform FROM documents
         WHERE doc_uid = ?1 AND content_hash = ?2`
      ).bind(docUid, pendingHash).first();
      if (!merged) {
        throw new Error("ingest revision was superseded before chunk write; retry this document");
      }
      chunks = baseChunks.map((chunk) => ({
        ...chunk,
        client: merged.client || null,
        category: merged.category || null,
        top_folder: merged.top_folder || null,
        platform: merged.platform || null,
      }));
      w = await d1.upsertChunks(env, chunks, { expectedContentHash: pendingHash });
    }

    const out = {
      doc_uid: docUid,
      action: prior ? "updated" : "created",
      chunks: chunks.length,
      queued: w.queued,
    };

    if (deferFinalize) {
      // A batch may defer only the two source-wide/final writes. The document
      // remains under its unique `pending:<hash>:<revision>` marker until its
      // source statistics and revision markers commit together. A crash or
      // rejected batch is still retryable through the ordinary ingest path.
      return {
        ...out,
        deferred_revision: {
          doc_uid: docUid,
          source: source_type,
          hash,
          pending_marker: pendingHash,
          ingested_at: now,
        },
      };
    }

    // Recompute derived counts and commit this exact revision in one D1
    // transaction. The stats statement is marker-bound, so a superseded
    // request neither advances freshness nor changes counts. Stats runs first
    // while the marker exists; the following exact CAS is guaranteed to see
    // the same transaction snapshot or the whole batch rolls back.
    const revision = {
      doc_uid: docUid,
      source: source_type,
      hash,
      pending_marker: pendingHash,
      ingested_at: now,
    };
    const finalization = await env.DB.batch([
      sourceStatsCommitStatement(env, source_type, [revision]),
      env.DB.prepare(
        `UPDATE documents SET content_hash = ?2
         WHERE doc_uid = ?1 AND content_hash = ?3`
      ).bind(docUid, hash, pendingHash),
    ]);
    const statsCommitted = Number(finalization?.[0]?.meta?.changes) === 1;
    const revisionCommitted = Number(finalization?.[1]?.meta?.changes) === 1;
    if (!statsCommitted || !revisionCommitted) {
      throw new Error("ingest revision was superseded before commit; retry this document");
    }

    return out;
  },

  /**
   * Read the prior rows for a unique-document HTTP batch in one D1 round trip.
   * Hashing and metadata comparison are byte-for-byte the same helpers used by
   * single ingest. Changed documents carry the prepared prior into `ingest`;
   * unchanged documents need no write at all.
   */
  async preflightIngestBatch(env, envelopes) {
    if (!envelopes.length) return [];
    const prepared = await Promise.all(envelopes.map((envelope) => prepareD1Envelope(env, envelope)));
    const priorResults = await env.DB.batch(prepared.map((input) => env.DB.prepare(
      `SELECT content_hash, title, uri, document_date, date_source, date_reliable,
              entity_slug, client, category, top_folder, platform, text_source, text_reliable, meta
       FROM documents WHERE doc_uid = ?1`
    ).bind(input.docUid)));

    if (!Array.isArray(priorResults) || priorResults.length !== prepared.length) {
      throw new Error("D1 batch preflight returned an incomplete result set");
    }

    return prepared.map((input, index) => {
      const rows = priorResults[index]?.results;
      if (!Array.isArray(rows)) throw new Error("D1 batch preflight returned an invalid row set");
      const prior = rows[0] || null;
      const state = { ...input, prior };
      return {
        unchanged: Boolean(prior && prior.content_hash === input.hash && !d1MetadataChanged(prior, input)),
        doc_uid: input.docUid,
        prepared: state,
      };
    });
  },

  /**
   * Finish changed documents from one HTTP batch with one corpus scan per
   * touched source, rather than one full-source COUNT for every small message.
   *
   * Each source is finalized independently. D1 executes its statistics refresh
   * and revision-marker updates as one transaction. If it fails, those
   * documents keep their pending hashes and are safe to retry, while another
   * source in the same request can still succeed. The exact CAS statement must
   * report one changed row; final-hash readback alone is never proof because a
   * same-content revision can carry different metadata.
   */
  async finalizeIngestBatch(env, revisions) {
    const outcomes = revisions.map(() => ({ ok: false, error: "ingest finalization failed; retry this document" }));
    const bySource = new Map();

    // A repeated marker is not a legitimate second revision and makes its
    // timestamp ambiguous. Exclude every copy rather than guess which supplied
    // freshness value belongs to the marker.
    const markerCounts = new Map();
    for (const revision of revisions) {
      if (!validDeferredRevision(revision)) continue;
      markerCounts.set(revision.pending_marker, (markerCounts.get(revision.pending_marker) || 0) + 1);
    }

    for (let index = 0; index < revisions.length; index++) {
      const revision = revisions[index];
      if (!validDeferredRevision(revision) || markerCounts.get(revision.pending_marker) !== 1) continue;
      const group = bySource.get(revision.source) || [];
      group.push({ ...revision, index });
      bySource.set(revision.source, group);
    }

    for (const [source, group] of bySource) {
      try {
        // One JSON bind carries every marker/timestamp into the statistics CTE.
        // With at most 50 revisions, this is at most 51 D1 statements and each
        // statement remains far below the per-statement bind ceiling.
        const batchResults = await env.DB.batch([
          sourceStatsCommitStatement(env, source, group),
          ...group.map((revision) => env.DB.prepare(
            `UPDATE documents SET content_hash = ?2
             WHERE doc_uid = ?1 AND content_hash = ?3`
          ).bind(revision.doc_uid, revision.hash, revision.pending_marker)),
        ]);
        if (!Array.isArray(batchResults) || batchResults.length !== group.length + 1) {
          throw new Error("D1 batch finalization returned an incomplete result set");
        }

        const placeholders = group.map((_, index) => `?${index + 1}`).join(",");
        const { results } = await env.DB.prepare(
          `SELECT doc_uid, content_hash FROM documents WHERE doc_uid IN (${placeholders})`
        ).bind(...group.map((revision) => revision.doc_uid)).all();
        const committed = new Map((results || []).map((row) => [row.doc_uid, row.content_hash]));
        const statsCommitted = Number(batchResults[0]?.meta?.changes) === 1;
        for (let groupIndex = 0; groupIndex < group.length; groupIndex++) {
          const revision = group[groupIndex];
          const changedThisMarker = Number(batchResults[groupIndex + 1]?.meta?.changes) === 1;
          outcomes[revision.index] = statsCommitted && changedThisMarker && committed.get(revision.doc_uid) === revision.hash
            ? { ok: true }
            : { ok: false, error: "ingest revision could not be verified; retry this document" };
        }
      } catch {
        // Do not quote D1 errors into a per-document receipt. Some platform
        // errors include bound values; the retry instruction is sufficient and
        // keeps source identifiers or content out of the response.
      }
    }

    return outcomes;
  },

  async stats(env) {
    const { results } = await env.DB.prepare(
      `WITH source_names AS (
         SELECT source FROM corpus_stats
         UNION
         SELECT source FROM documents WHERE deleted_at IS NULL
       ), document_counts AS (
         SELECT source,
                COUNT(*) AS stored_documents,
                COUNT(DISTINCT COALESCE(
                  CASE WHEN json_valid(meta) THEN json_extract(meta,'$.part_of') END,
                  source_id
                )) AS logical_documents
           FROM documents
          WHERE deleted_at IS NULL
          GROUP BY source
       )
       SELECT n.source AS source_type,
              COALESCE(d.stored_documents, 0) AS stored_documents,
              COALESCE(d.logical_documents, 0) AS logical_documents,
              COALESCE(s.chunks, 0) AS total,
              s.last_ingest_at,
              COALESCE(s.chunks, 0) - COALESCE(o.pending, 0) AS embedded
       FROM source_names n
       LEFT JOIN corpus_stats s ON s.source = n.source
       LEFT JOIN document_counts d ON d.source = n.source
       LEFT JOIN (SELECT c.source, count(*) AS pending
                    FROM vector_outbox v JOIN chunks c ON c.chunk_uid = v.chunk_uid
                   GROUP BY c.source) o ON o.source = n.source`
    ).all();
    return {
      rows: (results || []).map((r) => ({
        source_type: r.source_type,
        // BOTH, separately. `total` is a CHUNK count, and a caller comparing it
        // to a document count sees permanent drift that is not real. A warning
        // that always fires is worse than no warning: it teaches people to
        // ignore the one time it means something.
        documents: Number(r.logical_documents || 0),
        logical_documents: Number(r.logical_documents || 0),
        // These two counts come from the live documents table, not the
        // denormalized corpus_stats cache. Replay completion uses this marker to
        // reject an older Worker that could falsely confirm a stale count.
        stored_documents: Number(r.stored_documents || 0),
        document_counts_exact: true,
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
  async search(env, { query, limit, filters = {}, weights = {}, rrfK = 60, access = null, scope = null }) {
    if (access?.kind === "grant" || (scope && scope.all !== true)) {
      return {
        results: [],
        degraded: "document-access-unavailable",
        degraded_reason: access?.kind === "grant"
          ? "exact-document-scope-requires-d1"
          : "zone-scope-requires-d1",
        ignored_filters: [],
      };
    }
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
          date_reliable: null, date_source: null,
          client: r.client_name || null, category: r.category || null,
          top_folder: r.top_folder || null, platform: r.platform || null,
        })),
        degraded: "fts", degraded_reason: "keyword-search-unavailable", ignored_filters: [],
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
        date_reliable: null, date_source: null,
        client: r.client || null, category: r.category || null,
        top_folder: r.top_folder || null, platform: r.platform || null,
      })),
      degraded: null, degraded_reason: null, ignored_filters: [],
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
