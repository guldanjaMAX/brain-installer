#!/usr/bin/env node

/**
 * Temporary Supabase-to-product importer.
 *
 * Supabase is read-only here. Every target write goes through the same
 * /api/admin/brain/ingest/batch document contract used by product connectors.
 * The state file contains checkpoints and receipts, never credentials.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBrainWithAdminKey } from "../components/brain-http.mjs";
import { batches, splitOversized } from "../ingest/envelope-batching.mjs";
import { readProtectedStateJson, saveProtectedStateJson } from "./state-file.mjs";

const SOURCE_API = "https://api.supabase.com/v1";
const LANES = new Set(["curated", "drive", "messages"]);
const DRIVE_ID = /^[A-Za-z0-9_-]{8,200}$/;
export const SOURCE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const TARGET_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");
const sqlText = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;
const safeLimit = (value, fallback) => Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), 500);

export function isDirectExecution(argvPath, moduleUrl, {
  toNativePath = fileURLToPath,
  resolvePath = resolve,
} = {}) {
  return Boolean(argvPath && moduleUrl) && resolvePath(argvPath) === resolvePath(toNativePath(moduleUrl));
}

export function isSupabaseMigrationDirectExecution(argvPath, options) {
  return isDirectExecution(argvPath, import.meta.url, options);
}

const normalizeDriveIds = (values, label = "Drive exclusion") => {
  const ids = [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
  for (const id of ids) if (!DRIVE_ID.test(id)) throw new Error(`${label} has an invalid Drive file id: ${id.slice(0, 80)}`);
  return ids;
};

const driveExclusionSql = (ids) => {
  const normalized = normalizeDriveIds(ids);
  return normalized.length ? ` AND drive_file_id NOT IN (${normalized.map(sqlText).join(", ")})` : "";
};

/** Read a non-secret, per-install migration policy. */
export function loadDrivePolicy(path) {
  if (!path) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(resolve(path), "utf-8")); }
  catch (error) { throw new Error(`could not read Drive migration policy ${path}: ${error?.message || error}`); }
  if (!raw || raw.version !== 1) throw new Error("Drive migration policy must have version 1");
  const explicit = Array.isArray(raw.exclude_drive_files) ? raw.exclude_drive_files : [];
  const seen = new Set();
  const explicitExclusions = explicit.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Drive migration policy exclusion ${index + 1} must be an object`);
    const id = String(entry.id || "").trim();
    if (!id) throw new Error(`Drive migration policy exclusion ${index + 1} needs a Drive file id`);
    normalizeDriveIds([id], `Drive migration policy exclusion ${index + 1}`);
    if (seen.has(id)) throw new Error(`Drive migration policy repeats file id ${id}`);
    seen.add(id);
    const reason = String(entry.reason || "").trim();
    if (!reason) throw new Error(`Drive migration policy exclusion ${id} needs a reason`);
    return { id, reason };
  });
  const dedupeExactContent = raw.dedupe_exact_content === true;
  const configHash = sha256(JSON.stringify({
    version: 1,
    dedupe_exact_content: dedupeExactContent,
    exclude_drive_file_ids: explicitExclusions.map((entry) => entry.id).sort(),
  }));
  return { version: 1, config_hash: configHash, dedupe_exact_content: dedupeExactContent, explicit_exclusions: explicitExclusions };
}

/**
 * Exact-copy discovery is source-side and read-only. A repeated [path] header
 * is removed before hashing so a copied file does not become "different" only
 * because Drive exposes it under another folder. The shortest non-unzipped
 * path is retained as the canonical citation.
 */
export function driveExactDuplicateSql(explicitExcludedIds = []) {
  const exclusion = driveExclusionSql(explicitExcludedIds);
  return `WITH eligible AS (
            SELECT drive_file_id, min(drive_file_path) AS drive_file_path,
                   count(*)::int AS source_chunks,
                   md5(string_agg(
                     CASE
                       WHEN left(chunk_text, 1) = '[' AND split_part(chunk_text, chr(10), 1) LIKE '[%]'
                         THEN substring(chunk_text FROM length(split_part(chunk_text, chr(10), 1)) + 2)
                       ELSE chunk_text
                     END,
                     chr(30) ORDER BY coalesce(chunk_index, 0), id
                   )) AS content_hash
            FROM cocoindex.notes_rag_drive
            WHERE true${exclusion}
            GROUP BY drive_file_id
            HAVING NOT bool_or(flagged)
          ), ranked AS (
            SELECT *,
                   row_number() OVER (
                     PARTITION BY content_hash
                     ORDER BY CASE WHEN drive_file_path ILIKE '%/unzipped/%' THEN 1 ELSE 0 END,
                              length(drive_file_path), drive_file_path, drive_file_id
                   ) AS duplicate_rank,
                   first_value(drive_file_id) OVER (
                     PARTITION BY content_hash
                     ORDER BY CASE WHEN drive_file_path ILIKE '%/unzipped/%' THEN 1 ELSE 0 END,
                              length(drive_file_path), drive_file_path, drive_file_id
                   ) AS canonical_drive_file_id
            FROM eligible
          )
          SELECT drive_file_id, drive_file_path, source_chunks, content_hash, canonical_drive_file_id
          FROM ranked WHERE duplicate_rank > 1
          ORDER BY content_hash, drive_file_id`;
}

/** Resolve a stable effective policy once, then persist it in migration state. */
export async function resolveDrivePolicy({ policy, queryFn, existing = null }) {
  if (!policy) {
    if (existing) throw new Error("this Drive migration state was created with a policy; pass the same --drive-policy file to resume");
    return null;
  }
  if (existing) {
    if (existing.config_hash !== policy.config_hash) {
      throw new Error("Drive migration policy changed after the lane started; reset the lane or restore the original policy");
    }
    normalizeDriveIds(existing.excluded_drive_file_ids, "saved Drive migration policy");
    return existing;
  }

  const explicitIds = normalizeDriveIds(policy.explicit_exclusions.map((entry) => entry.id));
  const duplicateRows = policy.dedupe_exact_content ? await queryFn(driveExactDuplicateSql(explicitIds)) : [];
  const duplicateIds = normalizeDriveIds(duplicateRows.map((row) => row.drive_file_id), "exact-duplicate query");
  const effective = normalizeDriveIds([...explicitIds, ...duplicateIds]);
  return {
    version: 1,
    config_hash: policy.config_hash,
    excluded_drive_file_ids: effective,
    summary: {
      explicit: explicitIds.length,
      exact_duplicates: duplicateIds.length,
      total_excluded_files: effective.length,
    },
    resolved_at: new Date().toISOString(),
  };
}

export function laneConfig(lane, { excludedDriveFileIds = [] } = {}) {
  if (!LANES.has(lane)) throw new Error(`unknown lane "${lane}"; use curated, drive or messages`);

  if (lane === "curated") return {
    defaultPageSize: 100,
    highWaterSql: `SELECT max(id)::text AS high_water FROM public.notes_rag_documents WHERE NOT flagged`,
    pageSql(cursor, highWater, limit) {
      return `SELECT id::text AS cursor_id, d1_key, category, title, content,
                     client_name, meeting_date::text, source_type, source_id
              FROM public.notes_rag_documents
              WHERE NOT flagged AND id > ${Number(cursor || 0)} AND id <= ${Number(highWater)}
              ORDER BY id LIMIT ${safeLimit(limit, 100)}`;
    },
  };

  if (lane === "drive") {
    const exclusion = driveExclusionSql(excludedDriveFileIds);
    return {
    defaultPageSize: 10,
    // A file with even one flagged chunk is excluded as a whole. Reconstructing
    // it without that chunk would create a document that never existed.
    highWaterSql: `SELECT max(drive_file_id) AS high_water FROM (
                     SELECT drive_file_id FROM cocoindex.notes_rag_drive WHERE true${exclusion}
                     GROUP BY drive_file_id HAVING NOT bool_or(flagged)
                   ) eligible`,
    pageSql(cursor, highWater, limit) {
      return `SELECT drive_file_id AS cursor_id, drive_file_id, min(drive_file_path) AS drive_file_path,
                     min(top_folder) AS top_folder, min(subject) AS subject,
                     min(category) AS category, min(client_id) AS client_id,
                     min(document_date)::text AS document_date,
                     bool_and(coalesce(document_date_reliable, false)) AS document_date_reliable,
                     min(document_date_source) AS document_date_source,
                     count(*)::int AS source_chunks,
                     json_agg(json_build_object('id', id, 'chunk_index', coalesce(chunk_index, 0), 'text', chunk_text)
                              ORDER BY coalesce(chunk_index, 0), id) AS chunks
              FROM cocoindex.notes_rag_drive
              WHERE drive_file_id > ${sqlText(cursor)} AND drive_file_id <= ${sqlText(highWater)}${exclusion}
              GROUP BY drive_file_id
              HAVING NOT bool_or(flagged)
              ORDER BY drive_file_id LIMIT ${safeLimit(limit, 10)}`;
    },
    };
  }

  return {
    defaultPageSize: 100,
    highWaterSql: `SELECT max(id::text) AS high_water FROM rag.notes_rag_messages`,
    pageSql(cursor, highWater, limit) {
      return `SELECT id::text AS cursor_id, coalesce(message_id::text, id::text) AS source_id,
                     thread_id::text, platform, category, subcategory, client_id,
                     ts::text, content, person_ids::text[] AS person_ids, tags
              FROM rag.notes_rag_messages
              WHERE id::text > ${sqlText(cursor)} AND id::text <= ${sqlText(highWater)}
              ORDER BY id::text LIMIT ${safeLimit(limit, 100)}`;
    },
  };
}

/** Remove a repeated [path] header, then remove exact sliding-window overlap. */
export function joinOverlappingChunks(chunks, { maxOverlap = 1200, minOverlap = 32 } = {}) {
  const ordered = [...(chunks || [])]
    .sort((a, b) => Number(a.chunk_index || 0) - Number(b.chunk_index || 0) || Number(a.id || 0) - Number(b.id || 0))
    .map((x) => String(x.text || "").replace(/\r\n/g, "\n").trim())
    .filter(Boolean);
  if (!ordered.length) return "";

  const firstLines = ordered.map((text) => text.split("\n", 1)[0].trim());
  const commonHeader = firstLines.every((line) => line === firstLines[0]) && /^\[[^\n]{1,2000}\]$/.test(firstLines[0])
    ? firstLines[0]
    : null;
  const bodies = commonHeader
    ? ordered.map((text) => text.slice(text.indexOf("\n") + 1).trim())
    : ordered;

  let out = bodies[0] || "";
  for (const next of bodies.slice(1)) {
    const max = Math.min(maxOverlap, out.length, next.length);
    let overlap = 0;
    for (let size = max; size >= minOverlap; size--) {
      if (out.endsWith(next.slice(0, size))) { overlap = size; break; }
    }
    out += overlap ? next.slice(overlap) : `\n\n${next}`;
  }
  return out.trim();
}

const occurredAt = (value) => {
  if (!value) return null;
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function rowToEnvelope(lane, row) {
  if (lane === "curated") {
    const legacyId = String(row.d1_key || row.source_id || row.cursor_id);
    // Some legacy rows stored the source namespace inside d1_key. The product
    // adds the namespace when it creates doc_uid, so keeping both would produce
    // citations such as curated:curated:meetings/... and break stable identity.
    const sourceId = legacyId.startsWith("curated:") ? legacyId.slice("curated:".length) : legacyId;
    return {
      source_type: "curated",
      source_id: sourceId,
      title: row.title || row.d1_key || "Curated record",
      content: String(row.content || ""),
      occurred_at: occurredAt(row.meeting_date),
      date_source: row.meeting_date ? "migration:meeting_date" : null,
      date_reliable: !!row.meeting_date,
      uri: row.d1_key || null,
      metadata: {
        category: row.category || row.source_type || "curated",
        client_name: row.client_name || null,
        migrated_from: "public.notes_rag_documents",
        legacy_source_type: row.source_type || null,
        legacy_source_id: row.source_id || null,
      },
    };
  }

  if (lane === "drive") {
    const path = String(row.drive_file_path || row.drive_file_id || "Drive file");
    const title = path.split("/").filter(Boolean).at(-1) || path;
    return {
      source_type: "drive",
      source_id: String(row.drive_file_id || row.cursor_id),
      title,
      content: joinOverlappingChunks(row.chunks),
      occurred_at: occurredAt(row.document_date),
      date_source: row.document_date_source ? `migration:${row.document_date_source}` : null,
      date_reliable: !!row.document_date_reliable,
      uri: path,
      metadata: {
        category: row.category || "drive",
        client: row.client_id || null,
        top_folder: row.top_folder || null,
        platform: "drive",
        subject: row.subject || null,
        migrated_from: "cocoindex.notes_rag_drive",
        migration_source_chunks: Number(row.source_chunks || row.chunks?.length || 0),
      },
    };
  }

  return {
    source_type: "message",
    source_id: String(row.source_id || row.cursor_id),
    title: row.ts ? `Message ${String(row.ts).slice(0, 10)}` : "Message",
    content: String(row.content || ""),
    occurred_at: occurredAt(row.ts),
    date_source: row.ts ? "migration:message_timestamp" : null,
    date_reliable: !!row.ts,
    uri: row.thread_id ? `message-thread:${row.thread_id}` : null,
    metadata: {
      category: row.category || "message",
      subcategory: row.subcategory || null,
      client: row.client_id || null,
      platform: row.platform || null,
      thread_id: row.thread_id || null,
      person_ids: row.person_ids || [],
      tags: row.tags || [],
      migrated_from: "rag.notes_rag_messages",
    },
  };
}

const assertExactResponseUrl = (response, expected, label) => {
  if (response?.redirected) throw new Error(`${label} redirected; refusing to forward credentials`);
  if (!response?.url) return; // Injected test responses may not expose a final URL.
  let final;
  try { final = new URL(response.url); }
  catch { throw new Error(`${label} returned an invalid final URL`); }
  if (final.href !== expected.href) throw new Error(`${label} changed origin or path`);
};

export async function readBoundedResponseText(response, {
  maxBytes,
  label = "migration response",
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`${label} has an invalid size limit`);
  const declared = Number.parseInt(response?.headers?.get?.("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} exceeds its size limit`);

  if (!response?.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} exceeds its size limit`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength || 0;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* the size refusal is primary */ }
        throw new Error(`${label} exceeds its size limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function assertTargetReceiptIdentity(items, body) {
  if (!Array.isArray(body?.results) || body.results.length !== items.length) {
    throw new Error(`target receipt has ${body?.results?.length ?? 0} slots for ${items.length} documents`);
  }
  for (let index = 0; index < items.length; index++) {
    const envelope = items[index]?.envelope;
    const slot = body.results[index];
    if (String(slot?.source_id ?? "") !== String(envelope?.source_id ?? "") ||
        String(slot?.source_type ?? "") !== String(envelope?.source_type ?? "")) {
      throw new Error(`target receipt identity mismatch at slot ${index + 1}`);
    }
  }
  return body;
}

export async function querySupabase({
  projectRef, accessToken, sql, fetchImpl = fetch, timeoutMs = 120_000,
  maxResponseBytes = SOURCE_RESPONSE_MAX_BYTES,
}) {
  if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) throw new Error("SUPABASE_PROJECT_REF is missing or invalid");
  if (!accessToken) throw new Error("SUPABASE_ACCESS_TOKEN is missing");
  const endpoint = new URL(`${SOURCE_API}/projects/${projectRef}/database/query`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw;
  try {
    response = await fetchImpl(endpoint.href, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: controller.signal,
      redirect: "error",
    });
    assertExactResponseUrl(response, endpoint, "Supabase source query");
    raw = await readBoundedResponseText(response, { maxBytes: maxResponseBytes, label: "Supabase source response" });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Supabase source query timed out after ${timeoutMs}ms`);
    throw new Error(`Supabase source query failed: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Supabase source query returned ${response.status}`);
  let rows;
  try { rows = JSON.parse(raw); } catch { throw new Error("Supabase source query returned non-JSON"); }
  if (!Array.isArray(rows)) throw new Error("Supabase source query did not return rows");
  return rows;
}

export async function postTargetBatch({
  targetUrl, adminKey, items, fetchImpl = fetch, timeoutMs = 180_000,
  maxResponseBytes = TARGET_RESPONSE_MAX_BYTES,
}) {
  if (!targetUrl) throw new Error("BRAIN_URL is missing");
  if (!adminKey) throw new Error("ADMIN_KEY is missing");
  const endpoint = new URL(`${cleanUrl(targetUrl)}/api/admin/brain/ingest/batch`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw;
  try {
    response = await fetchBrainWithAdminKey(fetchImpl, endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: items.map((item) => item.envelope) }),
      signal: controller.signal,
    }, () => adminKey);
    assertExactResponseUrl(response, endpoint, "target ingest");
    raw = await readBoundedResponseText(response, { maxBytes: maxResponseBytes, label: "target ingest response" });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`target ingest timed out after ${timeoutMs}ms`);
    throw new Error(`target ingest failed: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`target ingest returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`target ingest returned ${response.status}`);
  return assertTargetReceiptIdentity(items, body);
}

/** Read the target's aggregate D1 and Vectorize state without mutating it. */
export async function getTargetInventory({
  targetUrl, adminKey, fetchImpl = fetch, timeoutMs = 30_000,
  maxResponseBytes = TARGET_RESPONSE_MAX_BYTES,
}) {
  if (!targetUrl) throw new Error("BRAIN_URL is missing");
  if (!adminKey) throw new Error("ADMIN_KEY is missing");
  const endpoint = new URL(`${cleanUrl(targetUrl)}/api/admin/brain/documents`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw;
  try {
    response = await fetchBrainWithAdminKey(fetchImpl, endpoint.href, {
      method: "GET",
      signal: controller.signal,
    }, () => adminKey);
    assertExactResponseUrl(response, endpoint, "target inventory");
    raw = await readBoundedResponseText(response, { maxBytes: maxResponseBytes, label: "target inventory response" });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`target inventory timed out after ${timeoutMs}ms`);
    throw new Error(`target inventory failed: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`target inventory returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`target inventory returned ${response.status}`);
  if (!body || !Array.isArray(body.rows)) throw new Error("target inventory returned an invalid aggregate shape");
  return body;
}

/** Close a completed migration lane with a source-registry receipt. */
export async function postSourceReceipt({
  targetUrl, adminKey, receipt, fetchImpl = fetch, timeoutMs = 30_000,
  maxResponseBytes = TARGET_RESPONSE_MAX_BYTES,
}) {
  if (!targetUrl) throw new Error("BRAIN_URL is missing");
  if (!adminKey) throw new Error("ADMIN_KEY is missing");
  const endpoint = new URL(`${cleanUrl(targetUrl)}/api/admin/brain/source-receipt`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw;
  try {
    response = await fetchBrainWithAdminKey(fetchImpl, endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
      signal: controller.signal,
    }, () => adminKey);
    assertExactResponseUrl(response, endpoint, "source receipt");
    raw = await readBoundedResponseText(response, { maxBytes: maxResponseBytes, label: "source receipt response" });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`source receipt timed out after ${timeoutMs}ms`);
    throw new Error(`source receipt failed: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`source receipt returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`source receipt returned ${response.status}`);
  if (body?.status !== "ready") throw new Error("source receipt did not mark the source ready");
  if (body?.source !== receipt?.source) throw new Error("source receipt returned the wrong source identity");
  if (receipt?.run_id && body?.run_id !== receipt.run_id) {
    throw new Error("source receipt returned the wrong run identity");
  }
  return body;
}

export function loadMigrationState(path, { projectRef, targetUrl } = {}) {
  let state = path ? readProtectedStateJson(path, { label: "migration checkpoint", allowMissing: true }) : null;
  state ||= { version: 1, project_ref: projectRef, target_url: cleanUrl(targetUrl), lanes: {} };
  if (state.version !== 1) throw new Error(`unsupported migration state version ${state.version}`);
  if (projectRef && state.project_ref && state.project_ref !== projectRef) throw new Error("state belongs to a different Supabase project");
  if (targetUrl && state.target_url && state.target_url !== cleanUrl(targetUrl)) throw new Error("state belongs to a different target brain");
  if (!state.project_ref && projectRef) state.project_ref = projectRef;
  if (!state.target_url && targetUrl) state.target_url = cleanUrl(targetUrl);
  return state;
}

export function saveMigrationState(path, state) {
  saveProtectedStateJson(path, state, { label: "migration checkpoint" });
}

const failure = (laneState, item, status, error) => {
  laneState.failures ||= [];
  laneState.failures.push({
    source_id: item?.envelope?.source_id || item?.source_id || null,
    status,
    error: String(error || "unknown").slice(0, 300),
    at: new Date().toISOString(),
  });
  if (laneState.failures.length > 1000) laneState.failures.splice(0, laneState.failures.length - 1000);
};

const freshLaneState = () => ({
  cursor: "", high_water: null, complete: false, pages: 0,
  source_rows: 0, source_chunks: 0, envelopes: 0, target_chunks: 0,
  created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0,
  done: {}, failures: [],
});

/** Run or resume one bounded migration lane. */
export async function runLane({
  lane,
  state,
  queryFn,
  postFn,
  saveFn = () => {},
  dryRun = false,
  continueOnError = false,
  pageSize,
  maxPages = Infinity,
  maxRows = Infinity,
  maxTargetChunks = Infinity,
  migrationPolicy = null,
}) {
  const config = laneConfig(lane, { excludedDriveFileIds: migrationPolicy?.excluded_drive_file_ids || [] });
  const laneState = state.lanes[lane] ||= freshLaneState();
  if (laneState.migration_policy && !migrationPolicy) {
    throw new Error("this lane was started with a migration policy; the same policy is required to resume");
  }
  if (migrationPolicy && laneState.migration_policy?.config_hash && laneState.migration_policy.config_hash !== migrationPolicy.config_hash) {
    throw new Error("migration policy does not match the policy saved in this lane state");
  }
  if (migrationPolicy && !laneState.migration_policy) laneState.migration_policy = migrationPolicy;
  if (laneState.complete) return { lane, status: "complete", ...laneState };

  if (!laneState.high_water) {
    const rows = await queryFn(config.highWaterSql);
    laneState.high_water = rows?.[0]?.high_water ?? null;
    if (!laneState.high_water) {
      laneState.complete = true;
      if (!dryRun) saveFn(state);
      return { lane, status: "complete", ...laneState };
    }
    if (!dryRun) saveFn(state);
  }

  let runPages = 0;
  let runRows = 0;
  let wouldSend = 0;
  const preview = [];

  while (runPages < maxPages && runRows < maxRows && laneState.target_chunks < maxTargetChunks) {
    const remainingRows = Number.isFinite(maxRows) ? Math.max(1, Math.min(pageSize || config.defaultPageSize, maxRows - runRows)) : (pageSize || config.defaultPageSize);
    const sql = config.pageSql(laneState.cursor, laneState.high_water, remainingRows);
    const rows = await queryFn(sql);
    if (!rows.length) {
      laneState.complete = true;
      if (!dryRun) saveFn(state);
      break;
    }

    const items = [];
    let transformFailed = false;
    for (const row of rows) {
      try {
        const envelope = rowToEnvelope(lane, row);
        if (!envelope.content.trim()) throw new Error("source row produced empty content");
        for (const part of splitOversized(envelope)) {
          const hash = sha256(JSON.stringify(part));
          const key = `${part.source_type}:${part.source_id}`;
          if (laneState.done[key]?.hash === hash) continue;
          items.push({ envelope: part, hash, key, cursor_id: row.cursor_id });
        }
      } catch (error) {
        transformFailed = true;
        laneState.failed++;
        failure(laneState, { source_id: row.cursor_id }, "transform_failed", error?.message || error);
      }
    }

    if (dryRun) {
      wouldSend += items.length;
      for (const item of items) if (preview.length < 5) preview.push({
        source_type: item.envelope.source_type,
        source_id: item.envelope.source_id,
        title: item.envelope.title,
        chars: item.envelope.content.length,
      });
      laneState.cursor = rows.at(-1).cursor_id;
      runPages++;
      runRows += rows.length;
      continue;
    }

    let pageFailed = transformFailed && !continueOnError;
    for (const group of batches(items)) {
      let receipt;
      try {
        receipt = await postFn(group);
        assertTargetReceiptIdentity(group, receipt);
      } catch (error) {
        for (const item of group) failure(laneState, item, "request_failed", error?.message || error);
        laneState.failed += group.length;
        saveFn(state);
        pageFailed = true;
        break;
      }

      for (let i = 0; i < group.length; i++) {
        const item = group[i];
        const slot = receipt.results[i];
        const status = slot?.status;
        if (["created", "updated", "unchanged"].includes(status)) {
          laneState[status]++;
          laneState.target_chunks += Number(slot.chunks || 0);
          laneState.done[item.key] = { hash: item.hash, status, chunks: Number(slot.chunks || 0) };
        } else if (status === "refused") {
          laneState.refused++;
          laneState.done[item.key] = { hash: item.hash, status, labels: slot.labels || [] };
          failure(laneState, item, "refused", (slot.labels || []).join(", ") || "credential scanner refusal");
        } else {
          laneState.failed++;
          failure(laneState, item, "failed", slot?.error || "target returned an unknown status");
          if (continueOnError) laneState.done[item.key] = { hash: item.hash, status: "failed", error: slot?.error || null };
          else pageFailed = true;
        }
      }
      saveFn(state);
      if (pageFailed && !continueOnError) break;
    }

    if (pageFailed && !continueOnError) return { lane, status: "blocked", ...laneState };

    laneState.cursor = rows.at(-1).cursor_id;
    laneState.pages++;
    laneState.source_rows += rows.length;
    laneState.source_chunks += rows.reduce((n, row) => n + Number(row.source_chunks || 1), 0);
    laneState.envelopes += items.length;
    laneState.last_checkpoint_at = new Date().toISOString();
    saveFn(state);
    runPages++;
    runRows += rows.length;
  }

  return {
    lane,
    status: dryRun ? "dry_run" : laneState.complete ? "complete" : "checkpointed",
    would_send: wouldSend,
    preview,
    ...laneState,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (["dry-run", "continue-on-error", "reset-lane"].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const lane = String(flags.lane || "").toLowerCase();
  laneConfig(lane);
  const projectRef = flags["project-ref"] || process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const targetUrl = flags.target || process.env.BRAIN_URL;
  const adminKey = process.env.ADMIN_KEY;
  const dryRun = !!flags["dry-run"];
  if (!projectRef) throw new Error("pass --project-ref or set SUPABASE_PROJECT_REF");
  if (!accessToken) throw new Error("set SUPABASE_ACCESS_TOKEN; it is read at runtime and never stored");
  if (!dryRun && !targetUrl) throw new Error("pass --target or set BRAIN_URL");
  if (!dryRun && !adminKey) throw new Error("set ADMIN_KEY for the isolated target brain");

  const statePath = resolve(flags.state || `.brain-migration-${lane}.json`);
  const state = loadMigrationState(statePath, { projectRef, targetUrl });
  if (flags["reset-lane"]) delete state.lanes[lane];
  if (lane !== "drive" && flags["drive-policy"]) throw new Error("--drive-policy only applies to the drive lane");

  const queryFn = (sql) => querySupabase({ projectRef, accessToken, sql });
  const drivePolicy = lane === "drive" ? loadDrivePolicy(flags["drive-policy"]) : null;
  const migrationPolicy = lane === "drive"
    ? await resolveDrivePolicy({ policy: drivePolicy, queryFn, existing: state.lanes.drive?.migration_policy || null })
    : null;

  const result = await runLane({
    lane,
    state,
    queryFn,
    postFn: (items) => postTargetBatch({ targetUrl, adminKey, items }),
    saveFn: (next) => saveMigrationState(statePath, next),
    dryRun,
    continueOnError: !!flags["continue-on-error"],
    pageSize: flags["page-size"] ? safeLimit(flags["page-size"], 10) : undefined,
    maxPages: flags["max-pages"] ? Math.max(1, Number.parseInt(flags["max-pages"], 10)) : Infinity,
    maxRows: flags["max-rows"] ? Math.max(1, Number.parseInt(flags["max-rows"], 10)) : Infinity,
    maxTargetChunks: flags["max-target-chunks"] ? Math.max(1, Number.parseInt(flags["max-target-chunks"], 10)) : Infinity,
    migrationPolicy,
  });
  let sourceReceipt = null;
  if (!dryRun && result.status === "complete" && !state.lanes[lane]?.receipt_recorded_at) {
    const source = lane === "messages" ? "message" : lane;
    const completedAt = new Date().toISOString();
    sourceReceipt = await postSourceReceipt({
      targetUrl,
      adminKey,
      receipt: {
        source,
        kind: lane === "drive" ? "drive" : "upload",
        completed_at: completedAt,
        complete_sweep: lane === "drive",
        detail: `Supabase migration complete; source_rows=${result.source_rows} refused=${result.refused} failed=${result.failed}`,
      },
    });
    state.lanes[lane].receipt_recorded_at = completedAt;
    saveMigrationState(statePath, state);
  }
  console.log(JSON.stringify({
    ...result,
    source_receipt: sourceReceipt,
    done: undefined,
    migration_policy: undefined,
    policy: result.migration_policy?.summary || null,
    failures: result.failures?.slice(-20),
  }, null, 2));
  if (result.status === "blocked") process.exitCode = 1;
}

if (isSupabaseMigrationDirectExecution(process.argv[1])) {
  main().catch((error) => {
    console.error(`migration failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
