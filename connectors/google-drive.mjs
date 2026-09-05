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
 *    quality. text/plain for Docs, XLSX for Sheets so every worksheet survives
 *    one bounded export, and text/plain for Slides.
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
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: ".txt" },
};

/** Google's export ceiling. Past this it returns 403 exportSizeLimitExceeded. */
export const EXPORT_LIMIT = 10 * 1024 * 1024;
export const DOWNLOAD_LIMIT = 8 * 1024 * 1024;
const GOOGLE_PAGE_TOKEN_MAX_LENGTH = 8_192;

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

const FILE_FIELDS =
  "id, name, mimeType, size, createdTime, modifiedTime, trashed, parents, webViewLink, md5Checksum, driveId, shortcutDetails(targetId,targetMimeType)";
const FIELDS = `nextPageToken, incompleteSearch, files(${FILE_FIELDS})`;

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

function googlePageToken(value, lane, { required = false } = {}) {
  if (value == null && !required) return null;
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || token.length > GOOGLE_PAGE_TOKEN_MAX_LENGTH) {
    throw new DriveError(`Google Drive returned an invalid ${lane} page token`, 200, "invalidPageToken");
  }
  return token;
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

/**
 * Broad account search retained for the exact-name live fixture only.
 *
 * This is not an ingestion boundary. The deployed ingest path must use
 * listRootedFiles(), which proves every returned item's ancestry from one of
 * the manifest-owned roots before any content request is made.
 */
export async function* listFiles(getAccessToken, { pageSize = 1000, query, maxPages = 10_000, opts = {} } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("Drive maxPages must be a positive integer");
  let pageToken;
  let pages = 0;
  const requestedPageTokens = new Set();
  do {
    if (++pages > maxPages) throw new DriveError(`Google Drive listing exceeded ${maxPages} pages`, 200, "pageLimit");
    if (pageToken) {
      if (requestedPageTokens.has(pageToken)) {
        throw new DriveError("Google Drive repeated a file-list page token", 200, "repeatedPageToken");
      }
      requestedPageTokens.add(pageToken);
    }
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
    if (page.files != null && !Array.isArray(page.files)) {
      throw new DriveError("Google Drive returned an invalid file list", 200, "invalidFileList");
    }
    const followingPageToken = googlePageToken(page.nextPageToken, "file-list");
    if (followingPageToken && requestedPageTokens.has(followingPageToken)) {
      throw new DriveError("Google Drive repeated a file-list page token", 200, "repeatedPageToken");
    }
    for (const f of page.files || []) yield f;
    pageToken = followingPageToken;
  } while (pageToken);
}

const driveQueryValue = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function normalizeRootFolderIds(values) {
  if (!Array.isArray(values)) {
    throw new DriveError("corpora.google_drive.root_folder_ids must be a non-empty array", 0, "rootPolicyMissing");
  }
  const roots = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
  if (!roots.length) {
    throw new DriveError(
      "Google Drive is disabled until corpora.google_drive.root_folder_ids names at least one reviewed folder",
      0,
      "rootPolicyMissing",
    );
  }
  return roots;
}

export async function getFileMetadata(getAccessToken, fileId, opts = {}) {
  return api(getAccessToken, `/files/${encodeURIComponent(String(fileId))}`, {
    search: { fields: FILE_FIELDS, supportsAllDrives: true },
    ...opts,
  });
}

/**
 * Traverse only direct children of reviewed roots, including Shared Drives.
 *
 * A shortcut is returned as the shortcut object but never followed. Following
 * it would let a shortcut placed inside an approved folder silently authorize
 * an unrelated target elsewhere in the account. Overlapping roots are safe:
 * Drive ids are deduplicated and their exact authorizing roots are merged.
 */
export async function* listRootedFiles(getAccessToken, {
  rootFolderIds,
  pageSize = 1000,
  maxFiles = 250_000,
  maxFolders = 100_000,
  maxPages = 100_000,
  opts = {},
} = {}) {
  const roots = normalizeRootFolderIds(rootFolderIds);
  const found = new Map();
  let pages = 0;
  let folders = 0;

  for (const rootId of roots) {
    let root;
    try {
      root = await getFileMetadata(getAccessToken, rootId, opts);
    } catch (error) {
      if (error instanceof DriveError && (error.status === 403 || error.status === 404)) {
        throw new DriveError(
          `reviewed Drive root ${rootId} is unavailable; existing indexed content was preserved`,
          error.status,
          "rootUnavailable",
          { cause: error },
        );
      }
      throw error;
    }
    if (root?.trashed === true || root?.mimeType !== FOLDER_MIME) {
      throw new DriveError(
        `reviewed Drive root ${rootId} is not an active folder; existing indexed content was preserved`,
        0,
        "rootUnavailable",
      );
    }

    const queue = [root];
    const visitedFolders = new Set();
    while (queue.length) {
      const folder = queue.shift();
      const folderId = String(folder.id || "");
      if (!folderId || visitedFolders.has(folderId)) continue;
      visitedFolders.add(folderId);
      folders++;
      if (folders > maxFolders) {
        throw new DriveError(`root-scoped Drive walk exceeded ${maxFolders} folders`, 0, "folderLimit");
      }

      const priorRoot = found.get(folderId);
      found.set(folderId, {
        ...(priorRoot || folder),
        scope_root_ids: [...new Set([...(priorRoot?.scope_root_ids || []), rootId])].sort(),
      });

      let pageToken;
      const seenPageTokens = new Set();
      do {
        if (pageToken && seenPageTokens.has(pageToken)) {
          throw new DriveError(
            `Google Drive repeated a page token while reading reviewed root ${rootId}`,
            200,
            "repeatedPageToken",
          );
        }
        if (pageToken) seenPageTokens.add(pageToken);
        pages++;
        if (pages > maxPages) {
          throw new DriveError(`root-scoped Drive walk exceeded ${maxPages} pages`, 0, "pageLimit");
        }
        const page = await api(getAccessToken, "/files", {
          search: {
            pageSize,
            pageToken,
            fields: FIELDS,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: "allDrives",
            q: `'${driveQueryValue(folderId)}' in parents and trashed = false`,
            orderBy: "name",
          },
          ...opts,
        });
        if (page.incompleteSearch === true) {
          throw new DriveError(
            `Google Drive reported an incomplete search under reviewed root ${rootId}; existing indexed content was preserved`,
            200,
            "incompleteSearch",
          );
        }
        for (const file of page.files || []) {
          if (!file?.id || file.trashed === true) continue;
          const id = String(file.id);
          const prior = found.get(id);
          found.set(id, {
            ...(prior || file),
            scope_root_ids: [...new Set([...(prior?.scope_root_ids || []), rootId])].sort(),
          });
          if (found.size > maxFiles) {
            throw new DriveError(`root-scoped Drive walk exceeded ${maxFiles} files`, 0, "fileLimit");
          }
          if (file.mimeType === FOLDER_MIME) queue.push(file);
        }
        pageToken = page.nextPageToken || null;
      } while (pageToken);
    }
  }

  for (const file of found.values()) yield file;
}

/**
 * Explain why a formerly indexed item is absent from a complete rooted walk.
 *
 * A 404 can mean hard deletion or permission loss. Drive does not distinguish
 * those cases for this credential, so it is deliberately unresolved and must
 * never become a tombstone. Visible trash and a visible move outside the
 * approved folder set are authoritative removal evidence.
 */
export async function classifyScopedAbsence(getAccessToken, fileId, {
  scopedFolderIds = new Set(),
  opts = {},
} = {}) {
  let file;
  try {
    file = await getFileMetadata(getAccessToken, fileId, opts);
  } catch (error) {
    if (error instanceof DriveError && (error.status === 403 || error.status === 404)) {
      return {
        kind: "unresolved",
        reason: "permission loss and hard deletion are indistinguishable",
        retryable: true,
      };
    }
    throw error;
  }
  if (file?.trashed === true) {
    return { kind: "source_deleted", reason: "Drive reports the file is in trash", retryable: false };
  }
  const parents = Array.isArray(file?.parents) ? file.parents.map(String) : [];
  if (parents.some((parent) => scopedFolderIds.has(parent))) {
    return {
      kind: "unresolved",
      reason: "Drive still places the file under a reviewed folder but omitted it from the completed traversal",
      retryable: true,
    };
  }
  return { kind: "left_scope", reason: "the visible file moved outside every reviewed root", retryable: false };
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
 * Returns { changed, removed, nextToken }. `removed` covers deletion, trashing,
 * and a file that merely left this credential's view. The caller must classify
 * a stored removed id with classifyScopedAbsence() before treating it as source
 * deletion, because 403/404 cannot distinguish hard deletion from access loss.
 */
export async function listChanges(getAccessToken, pageToken, opts = {}) {
  const changed = [];
  const removed = [];
  let token = googlePageToken(pageToken, "changes", { required: true });
  let nextToken = null;
  let pages = 0;
  const maxPages = opts.maxPages ?? 10_000;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("Drive maxPages must be a positive integer");
  const apiOpts = { ...opts };
  delete apiOpts.maxPages;
  const requestedPageTokens = new Set();

  while (token) {
    token = googlePageToken(token, "changes", { required: true });
    if (requestedPageTokens.has(token)) {
      throw new DriveError("Google Drive repeated a changes page token", 200, "repeatedPageToken");
    }
    requestedPageTokens.add(token);
    if (++pages > maxPages) throw new DriveError(`Google Drive changes exceeded ${maxPages} pages`, 200, "pageLimit");
    const page = await api(getAccessToken, "/changes", {
      search: {
        pageToken: token,
        pageSize: 1000,
        fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${FIELDS.replace(/^nextPageToken, files\(|\)$/g, "")}))`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        includeRemoved: true,
      },
      ...apiOpts,
    });
    if (page.changes != null && !Array.isArray(page.changes)) {
      throw new DriveError("Google Drive returned an invalid changes list", 200, "invalidChangeList");
    }
    for (const c of page.changes || []) {
      if (c.removed || c.file?.trashed) removed.push(c.fileId);
      else if (c.file) changed.push(c.file);
    }
    if (page.newStartPageToken != null) {
      nextToken = googlePageToken(page.newStartPageToken, "terminal changes", { required: true });
      break;
    }
    if (page.nextPageToken == null) {
      throw new DriveError(
        "Google Drive ended a changes window without a terminal start page token",
        200,
        "incompleteChangeFeed",
      );
    }
    token = googlePageToken(page.nextPageToken, "changes", { required: true });
  }
  if (!nextToken) {
    throw new DriveError("Google Drive returned no terminal changes token", 200, "incompleteChangeFeed");
  }
  return { changed, removed, nextToken };
}

/** Should this file be fetched at all? Decided before spending a request. */
export function triage(file) {
  if (file.trashed) return { skip: "the file is in the trash", skipCode: "source_deleted" };
  if (file.mimeType === FOLDER_MIME) return { skip: null, folder: true };
  if (file.mimeType === SHORTCUT_MIME) {
    return {
      skip: "Drive shortcuts are not followed across the reviewed folder boundary",
      skipCode: "shortcut_not_followed",
    };
  }
  if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
    const e = EXPORTS[file.mimeType];
    if (!e) {
      return {
        skip: `Google ${file.mimeType.split(".").pop()} files cannot be exported as text`,
        skipCode: "unsupported_google_type",
      };
    }
    return { export: e };
  }
  if (SKIP_MIME.test(file.mimeType || "")) {
    return { skip: `${file.mimeType} carries no text`, skipCode: "non_text_media" };
  }
  if (!canExtract(file.name)) {
    return {
      skip: `no extractor for "${extensionOf(file.name) || "(no extension)"}" files`,
      skipCode: "unsupported_extension",
    };
  }
  if (Number(file.size) > DOWNLOAD_LIMIT) {
    return {
      skip: `${(Number(file.size) / 1048576).toFixed(1)}MB, over the ${DOWNLOAD_LIMIT / 1048576}MB limit`,
      skipCode: "download_limit",
    };
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
export async function toEnvelope(getAccessToken, file, { sourceName = SOURCE_TYPE, pathOf = () => "", ocr = null } = {}, opts = {}) {
  const plan = triage(file);
  if (plan.folder) return null;
  if (plan.skip) {
    return { skip: { path: file.name, id: file.id, reason: plan.skip, code: plan.skipCode || "unknown" } };
  }

  let buf;
  try {
    buf = await fetchContent(getAccessToken, file, plan, opts);
  } catch (e) {
    // Only a file-specific permanent condition is safe to forget. Network,
    // server and auth failures must escape to the sync runner so it can record
    // a failure and withhold the source cursor for a retry.
    if (!isPermanentFileFailure(e)) throw e;
    return {
      skip: {
        path: file.name,
        id: file.id,
        reason: `could not be fetched: ${e.message.slice(0, 120)}`,
        code: "file_unavailable",
      },
    };
  }

  const name = plan.export ? file.name + plan.export.ext : file.name;
  if (!isBinaryFormat(name) && isLikelyBinary(buf)) {
    return {
      skip: { path: file.name, id: file.id, reason: "the file is binary, not text", code: "binary_content" },
    };
  }

  // Extractor options were never passed on this path, so a Drive PDF has been
  // judged by different rules than a local one despite the comment above
  // promising otherwise. OCR is threaded through explicitly here, because
  // Drive is where a client's scanned filing cabinet actually lives.
  const got = await extract(buf, name, ocr ? { ocr } : {});
  if (got.error || got.text == null) {
    return {
      skip: {
        path: file.name,
        id: file.id,
        reason: got.error || "extraction produced nothing",
        code: "extraction_refused",
      },
    };
  }
  const q = textQuality(got.text);
  if (!q.ok) {
    return {
      skip: { path: file.name, id: file.id, reason: q.reason, metrics: q.metrics, code: "quality_refused" },
    };
  }

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
      ...(got.provenance
        ? { text_source: got.provenance.text_source, text_reliable: got.provenance.text_reliable }
        : {}),
      metadata: {
        extracted_as: got.how,
        drive_id: file.id,
        root_folder_ids: Array.isArray(file.scope_root_ids) ? [...file.scope_root_ids].sort() : [],
        drive_id_kind: file.mimeType === SHORTCUT_MIME ? "shortcut" : "file",
        mime: file.mimeType,
        platform: "drive",
        // Null is deliberate for a root-level file: it clears a stale folder
        // filter when a file is moved out of a subfolder.
        top_folder: pathSegments(folder)[0] || null,
        folder: folder || null,
        ...(got.note ? { extraction_note: got.note } : {}),
        ...(got.incomplete === true ? { extraction_incomplete: true } : {}),
        ...(got.provenance ? { ocr: got.provenance } : {}),
      },
    },
    // Drive's own change signal. Cheaper than hashing content we already have,
    // and it is what the changes feed reports against.
    version: driveVersion(file, folder),
    note: got.note || null,
    incomplete: got.incomplete === true,
  };
}
