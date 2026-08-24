/**
 * Google Drive as an ingest source.
 *
 * Produces the SAME envelopes the local folder walker produces, so everything
 * downstream (splitting, batching, the credential gate, resume state) is shared
 * rather than reimplemented.
 *
 * THE THREE THINGS THAT MAKE THIS NON-OBVIOUS
 *
 * 1. A Google Doc has no bytes. files.get?alt=media returns 403 for native
 *    types; they must be exported, and the export format decides retrieval
 *    quality. text/plain for Docs, CSV for Sheets (one request per sheet is not
 *    worth it), text/plain for Slides.
 *
 * 2. modifiedTime is a TRAP as a document date. A sync, a permission change or
 *    a bulk move rewrites it. Storing it made 80% of a real corpus look like it
 *    was written this year, which silently disabled staleness reporting. This
 *    uses createdTime, and lets the shared date ladder override from the
 *    filename when one is present. modifiedTime is used ONLY to decide whether
 *    a file changed, which is what it is actually for.
 *
 * 3. The second run must be cheap or nobody re-runs it. The changes feed makes
 *    it proportional to what changed rather than to the corpus, and it is the
 *    only way deletions are ever learned.
 */

import { extract, canExtract, extensionOf } from "../ingest/extract.mjs";
import "../ingest/formats.mjs";
import { textQuality, isLikelyBinary } from "../ingest/quality.mjs";
import { documentDate } from "../ingest/doc-date.mjs";
import { isBinaryFormat } from "../ingest/extract.mjs";

export const API = "https://www.googleapis.com/drive/v3";
export const SOURCE_TYPE = "drive";

/** Native Google types, and what to ask for instead of bytes. */
export const EXPORTS = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: ".txt" },
};

/** Google's export ceiling. Past this it returns 403 exportSizeLimitExceeded. */
export const EXPORT_LIMIT = 10 * 1024 * 1024;
export const DOWNLOAD_LIMIT = 8 * 1024 * 1024;

const FOLDER_MIME = "application/vnd.google-apps.folder";

const FIELDS =
  "nextPageToken, incompleteSearch, files(id, name, mimeType, size, createdTime, modifiedTime, trashed, parents, webViewLink, md5Checksum)";

/** Never worth fetching: they carry no text and cost a request each. */
const SKIP_MIME = /^(image|video|audio)\//;

export class DriveError extends Error {
  constructor(message, status, reason, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DriveError";
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

const retryDelay = (attempt) => Math.min(2 ** attempt * 1000, 32_000) + Math.random() * 1000;

const errorMessage = (error) => {
  const message = String(error?.message || error || "unknown error").trim();
  return message || "unknown error";
};

/**
 * Fetch failures that are about one particular file, rather than the health of
 * the connector. These may be recorded as skips without making a completed
 * changes page retry forever.
 *
 * Keep this list explicit. A broad `403 => skip` would turn a revoked token,
 * disabled API or account-level policy failure into apparent success and let
 * the changes cursor move past every affected file.
 */
const PERMANENT_FILE_REASONS = new Set([
  "appNotAuthorizedToFile",
  "cannotDownloadFile",
  "cannotExportFile",
  "exportSizeLimitExceeded",
  "fileNotDownloadable",
  "insufficientFilePermissions",
]);

export function isPermanentFileFailure(error) {
  if (!(error instanceof DriveError)) return false;
  if (error.status === 404) return true;
  return PERMANENT_FILE_REASONS.has(String(error.reason || ""));
}

/**
 * One API call with the retry policy Google actually requires.
 *
 * 403 rateLimitExceeded and 429 are RETRYABLE and common on a large walk; 403
 * for any other reason is a permission problem and must fail fast rather than
 * being retried into a long silence.
 */
export async function api(getAccessToken, path, {
  search,
  raw = false,
  attempts = 5,
  requestTimeoutMs = 60_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastErr;
  let forceRefresh = false;
  let authRefreshAttempted = false;
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  for (let i = 0; i < totalAttempts; i++) {
    let token;
    try {
      token = await getAccessToken({ force: forceRefresh });
      if (forceRefresh) {
        authRefreshAttempted = true;
        forceRefresh = false;
      }
    } catch (error) {
      // invalid_grant and its equivalents require a person to reconnect. They
      // are fatal immediately, while a transport/provider outage is retried and
      // remains fatal after the retry budget. Neither is a document skip.
      if (error?.needsReauth) throw error;
      lastErr = new DriveError(
        `access token could not be obtained: ${errorMessage(error)}`,
        0,
        "tokenRefreshError",
        { retryable: true, cause: error },
      );
      if (i + 1 >= totalAttempts) throw lastErr;
      await sleep(retryDelay(i));
      continue;
    }

    const url = new URL(path.startsWith("http") ? path : API + path);
    for (const [k, v] of Object.entries(search || {})) if (v != null) url.searchParams.set(k, String(v));

    let res;
    try {
      const signal = Number(requestTimeoutMs) > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(Number(requestTimeoutMs))
        : undefined;
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
      if (res.ok) {
        // Reading a response body can fail or hang independently of receiving
        // its headers. Keep it inside the same retry boundary as fetch itself.
        return raw ? new Uint8Array(await res.arrayBuffer()) : await res.json();
      }
    } catch (error) {
      lastErr = new DriveError(
        `Google API request or response failed: ${errorMessage(error)}`,
        0,
        "networkError",
        { retryable: true, cause: error },
      );
      if (i + 1 >= totalAttempts) throw lastErr;
      await sleep(retryDelay(i));
      continue;
    }

    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
    // One 401 gets a forced access-token refresh. A second 401 is not a file
    // quality problem; it is a broken connection and must abort the sync.
    const retryAuth = res.status === 401 && !authRefreshAttempted;
    const retryable =
      retryAuth ||
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && /rateLimit|userRateLimit|quotaExceeded|backendError/i.test(reason));

    lastErr = new DriveError(body?.error?.message || `HTTP ${res.status}`, res.status, reason, { retryable });
    if (!retryable) throw lastErr;
    if (retryAuth) forceRefresh = true;
    if (i + 1 >= totalAttempts) throw lastErr;
    // Exponential with jitter. Google's own guidance, and without the jitter a
    // large parallel walk re-collides on every retry.
    await sleep(retryDelay(i));
  }
  throw lastErr;
}

/** Walk every file the token can see, including shared drives. */
export async function* listFiles(getAccessToken, { pageSize = 1000, query, opts = {} } = {}) {
  let pageToken;
  do {
    const page = await api(getAccessToken, "/files", {
      search: {
        pageSize,
        pageToken,
        fields: FIELDS,
        // Without all three of these, files on Shared Drives are invisible and
        // the walk silently returns only My Drive.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
        q: query || "trashed = false",
        orderBy: "modifiedTime desc",
      },
      ...opts,
    });
    // With corpora=allDrives Google can answer 200 while explicitly admitting
    // that some corpora were not searched. A full sweep uses absence as proof
    // for deletion, so an incomplete page must abort before yielding even one
    // file. The caller then withholds cleanup and its source cursor.
    if (page.incompleteSearch === true) {
      throw new DriveError(
        "Google Drive reported an incomplete all-drives search; no full-sweep deletion was attempted",
        200,
        "incompleteSearch"
      );
    }
    for (const f of page.files || []) yield f;
    pageToken = page.nextPageToken;
  } while (pageToken);
}

/** The token that makes the NEXT run incremental. Fetch before the first walk. */
export async function startPageToken(getAccessToken, opts = {}) {
  const r = await api(getAccessToken, "/changes/startPageToken", {
    search: { supportsAllDrives: true },
    ...opts,
  });
  return r.startPageToken;
}

/**
 * Everything that changed since a saved token.
 *
 * Returns { changed, removed, nextToken }. `removed` covers both deletion and
 * trashing, and also a file that merely left the token's view. All three mean
 * the same thing to a brain: stop answering from it.
 */
export async function listChanges(getAccessToken, pageToken, opts = {}) {
  const changed = [];
  const removed = [];
  let token = pageToken;
  let nextToken = null;

  while (token) {
    const page = await api(getAccessToken, "/changes", {
      search: {
        pageToken: token,
        pageSize: 1000,
        fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${FIELDS.replace(/^nextPageToken, files\(|\)$/g, "")}))`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        includeRemoved: true,
      },
      ...opts,
    });
    for (const c of page.changes || []) {
      if (c.removed || c.file?.trashed) removed.push(c.fileId);
      else if (c.file) changed.push(c.file);
    }
    if (page.newStartPageToken) {
      nextToken = page.newStartPageToken;
      break;
    }
    token = page.nextPageToken;
  }
  return { changed, removed, nextToken };
}

/** Should this file be fetched at all? Decided before spending a request. */
export function triage(file) {
  if (file.trashed) return { skip: "the file is in the trash" };
  if (file.mimeType === FOLDER_MIME) return { skip: null, folder: true };
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    const e = EXPORTS[file.mimeType];
    if (!e) return { skip: `Google ${file.mimeType.split(".").pop()} files cannot be exported as text` };
    return { export: e };
  }
  if (SKIP_MIME.test(file.mimeType || "")) return { skip: `${file.mimeType} carries no text` };
  if (!canExtract(file.name)) return { skip: `no extractor for "${extensionOf(file.name) || "(no extension)"}" files` };
  if (Number(file.size) > DOWNLOAD_LIMIT) {
    return { skip: `${(Number(file.size) / 1048576).toFixed(1)}MB, over the ${DOWNLOAD_LIMIT / 1048576}MB limit` };
  }
  return { download: true };
}

/**
 * Keep the small amount of folder state needed to turn opaque parent ids into
 * stable, human-readable paths. A full walk supplies every visible folder;
 * incremental runs merge changed folders into the saved snapshot.
 */
export function updateFolderIndex(files, prior = {}) {
  const out = { ...(prior || {}) };
  for (const file of files || []) {
    if (file?.mimeType !== FOLDER_MIME || !file.id) continue;
    if (file.trashed) delete out[file.id];
    else out[file.id] = {
      name: String(file.name || "").trim(),
      parents: Array.isArray(file.parents) ? file.parents.filter(Boolean).map(String) : [],
    };
  }
  return out;
}

/** Folder path only, not the filename. Unknown roots are intentionally absent. */
export function folderPathFor(file, folders = {}) {
  const parts = [];
  const seen = new Set();
  let id = Array.isArray(file?.parents) ? file.parents[0] : null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders[id];
    if (!folder) break;
    if (folder.name) parts.unshift(folder.name);
    id = Array.isArray(folder.parents) ? folder.parents[0] : null;
  }
  return parts.join("/");
}

const pathSegments = (value) => String(value || "").replace(/\\/g, "/").split("/").map((x) => x.trim()).filter(Boolean);
const normalPath = (value) => pathSegments(value).join("/").toLowerCase();

/**
 * Everything that can change the stored document without changing its bytes.
 *
 * A Drive changes feed reports a moved parent folder, but it does not emit a
 * change for every descendant. The periodic full sweep therefore has to notice
 * that a child's resolved path changed even when its own modifiedTime and md5
 * did not. Including the path also refreshes top_folder/private-path metadata
 * after an ancestor rename or move.
 */
export function driveVersion(file, folderPath = "") {
  return JSON.stringify([
    String(file?.modifiedTime || ""),
    String(file?.md5Checksum || file?.size || ""),
    String(file?.name || ""),
    String(file?.mimeType || ""),
    pathSegments(folderPath).join("/"),
  ]);
}

/**
 * Decide source-policy exclusions before downloading file bytes.
 *
 * Exact ids carry reviewed migration/dedupe decisions. Path rules are matched
 * on segment boundaries so excluding `Legal/Sealed` cannot also exclude a
 * sibling named `Legal/Sealed Notes`. Private prefixes match whole segments,
 * the same contract used by local-folder ingest.
 */
export function exclusionReason(file, folderPath = "", {
  excludeFileIds = [], excludePaths = [], excludeNameParts = [], privatePrefixes = [],
} = {}) {
  const ids = excludeFileIds instanceof Set ? excludeFileIds : new Set((excludeFileIds || []).map(String));
  if (ids.has(String(file?.id || ""))) return "excluded by reviewed file-id policy";

  const fullPath = [...pathSegments(folderPath), String(file?.name || "").trim()].filter(Boolean).join("/");
  const normalized = normalPath(fullPath);
  for (const configured of excludePaths || []) {
    const prefix = normalPath(configured);
    if (prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      return `excluded path: ${configured}`;
    }
  }

  const lowerName = String(file?.name || "").toLowerCase();
  for (const part of excludeNameParts || []) {
    if (String(part || "").trim() && lowerName.includes(String(part).toLowerCase())) {
      return `excluded name part: ${part}`;
    }
  }

  const privateSet = [...new Set((privatePrefixes || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const privatePart = pathSegments(fullPath).find((part) =>
    privateSet.some((prefix) => part.toLowerCase().startsWith(prefix))
  );
  if (privatePart) return `private path segment: ${privatePart}`;
  return null;
}

/** Fetch one file's bytes, exporting when it is a native Google type. */
export async function fetchContent(getAccessToken, file, plan, opts = {}) {
  if (plan.export) {
    if (Number(file.size) > EXPORT_LIMIT) {
      throw new DriveError(`Google's export limit is ${EXPORT_LIMIT / 1048576}MB and this file is larger`, 403, "exportSizeLimitExceeded");
    }
    return api(getAccessToken, `/files/${file.id}/export`, {
      search: { mimeType: plan.export.mime, supportsAllDrives: true },
      raw: true,
      ...opts,
    });
  }
  return api(getAccessToken, `/files/${file.id}`, {
    search: { alt: "media", supportsAllDrives: true },
    raw: true,
    ...opts,
  });
}

/**
 * One Drive file to one ingest envelope, or a reasoned skip.
 *
 * Deliberately mirrors ingest/run.mjs prepare() so a Drive document and a local
 * one are judged by exactly the same rules.
 */
export async function toEnvelope(getAccessToken, file, { sourceName = SOURCE_TYPE, pathOf = () => "" } = {}, opts = {}) {
  const plan = triage(file);
  if (plan.folder) return null;
  if (plan.skip) return { skip: { path: file.name, id: file.id, reason: plan.skip } };

  let buf;
  try {
    buf = await fetchContent(getAccessToken, file, plan, opts);
  } catch (e) {
    // Only a file-specific permanent condition is safe to forget. Network,
    // server and auth failures must escape to the sync runner so it can record
    // a failure and withhold the source cursor for a retry.
    if (!isPermanentFileFailure(e)) throw e;
    return { skip: { path: file.name, id: file.id, reason: `could not be fetched: ${e.message.slice(0, 120)}` } };
  }

  const name = plan.export ? file.name + plan.export.ext : file.name;
  if (!isBinaryFormat(name) && isLikelyBinary(buf)) {
    return { skip: { path: file.name, id: file.id, reason: "the file is binary, not text" } };
  }

  const got = await extract(buf, name);
  if (got.error || got.text == null) {
    return { skip: { path: file.name, id: file.id, reason: got.error || "extraction produced nothing" } };
  }
  const q = textQuality(got.text);
  if (!q.ok) return { skip: { path: file.name, id: file.id, reason: q.reason, metrics: q.metrics } };

  // createdTime, never modifiedTime. The filename still wins when it carries a
  // date, because a human naming a file "2026-03 statement" is stating the
  // document's date more reliably than Drive's metadata ever does.
  const folder = pathOf(file);
  const dd = documentDate({ filename: file.name, relPath: folder, contentHead: got.text.slice(0, 1200) });
  const created = file.createdTime ? Date.parse(file.createdTime) : NaN;
  const occurred = dd.value ?? (Number.isFinite(created) ? created : null);

  return {
    // The bare Drive file id, not the name and not `drive:<id>`. The store owns
    // namespacing and constructs `<source_type>:<source_id>` exactly once. This
    // is also the identity used by the Supabase migration, so the first live
    // sync updates that document instead of creating `drive:drive:<id>`.
    envelope: {
      source_type: sourceName,
      source_id: String(file.id),
      title: file.name,
      content: got.text,
      occurred_at: occurred ? new Date(occurred).toISOString() : null,
      date_source: dd.value ? dd.source : Number.isFinite(created) ? "drive_created" : "none",
      date_reliable: dd.value ? dd.reliable : false,
      uri: file.webViewLink || null,
      metadata: {
        extracted_as: got.how,
        drive_id: file.id,
        mime: file.mimeType,
        platform: "drive",
        // Null is deliberate for a root-level file: it clears a stale folder
        // filter when a file is moved out of a subfolder.
        top_folder: pathSegments(folder)[0] || null,
        folder: folder || null,
        ...(got.note ? { extraction_note: got.note } : {}),
      },
    },
    // Drive's own change signal. Cheaper than hashing content we already have,
    // and it is what the changes feed reports against.
    version: driveVersion(file, folder),
    note: got.note || null,
  };
}
