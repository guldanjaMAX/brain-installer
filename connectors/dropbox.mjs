/** Dropbox cursor sync with bounded file-body download and extraction. */

import {
  createPaginationGuard, ProviderSyncError, providerEnvelope, providerJson, providerSyncResult,
} from "./provider-sync.mjs";
import { downloadProviderFile } from "./provider-file.mjs";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

function resultWithSafePartialCursor(options, cursorSafe, extras = {}) {
  const result = providerSyncResult(options);
  return Object.freeze({
    ...result,
    ...extras,
    cursor_can_advance: Boolean(result.cursor_can_advance && cursorSafe && options.proposedCursor),
  });
}

export async function syncDropbox({
  accessToken,
  fetchImpl = fetch,
  cursor = null,
  rootPath = "",
} = {}) {
  if (!accessToken) throw new TypeError("Dropbox accessToken is required");
  const documents = [];
  const deletions = [];
  const snapshotSourceIds = [];
  const gapCounts = new Map();
  const guard = createPaginationGuard("dropbox");
  const authoritativeSnapshot = !cursor;
  let current = cursor;
  let hasMore = true;
  while (hasMore) {
    const marker = current || "__first__";
    guard.visit(marker);
    const method = current ? "files/list_folder/continue" : "files/list_folder";
    let data;
    try {
      ({ data } = await providerJson("dropbox", `${API}/${method}`, {
        accessToken,
        fetchImpl,
        method: "POST",
        body: current
          ? { cursor: current }
          : { path: rootPath, recursive: true, include_deleted: true, include_non_downloadable_files: false },
      }));
    } catch (error) {
      if (current && error instanceof ProviderSyncError && error.status === 409) {
        throw new ProviderSyncError("dropbox", "the saved Dropbox cursor expired; run an explicit reset so the full inventory can be reconciled", {
          kind: "retryable", status: 409, code: "cursor_expired",
        });
      }
      throw error;
    }
    for (const entry of data.entries || []) {
      const path = String(entry?.path_lower || entry?.path_display || "").toLowerCase();
      if (!path) continue;
      const sourceId = `path:${path}`;
      if (entry?.[".tag"] === "deleted") {
        deletions.push({ source_type: "dropbox", source_id: sourceId });
        continue;
      }
      if (entry?.[".tag"] !== "file") continue;
      snapshotSourceIds.push(sourceId);
      const extracted = await downloadProviderFile({
        provider: "dropbox",
        url: `${CONTENT}/files/download`,
        accessToken,
        fetchImpl,
        name: entry.name || path,
        method: "POST",
        headers: { "Dropbox-API-Arg": JSON.stringify({ path: entry.id || entry.path_lower || entry.path_display }) },
      });
      if (!extracted.ok) {
        gapCounts.set(extracted.code, (gapCounts.get(extracted.code) || 0) + 1);
        continue;
      }
      documents.push(providerEnvelope("dropbox", sourceId, {
        title: entry.name || path,
        content: extracted.content,
        occurredAt: entry.server_modified || null,
        uri: `dropbox:${entry.path_display || path}`,
        metadata: {
          path,
          provider_id: entry.id || null,
          revision: entry.rev || null,
          provider_content_hash: entry.content_hash || null,
          size: Number(entry.size || 0),
          ...extracted.provenance,
        },
      }));
    }
    if (!data.cursor) {
      throw new ProviderSyncError("dropbox", "Dropbox did not return a terminal cursor", {
        kind: "retryable", code: "missing_cursor",
      });
    }
    current = data.cursor;
    hasMore = data.has_more === true;
  }

  const warnings = [];
  for (const [code, count] of gapCounts) {
    warnings.push(`${count} Dropbox file(s) were inventoried but not indexed because of ${code}.`);
  }
  return resultWithSafePartialCursor({
    provider: "dropbox", documents, deletions, warnings,
    proposedCursor: current,
    deletionAuthority: "authoritative",
    complete: warnings.length === 0,
  }, true, {
    authoritative_snapshot: authoritativeSnapshot,
    snapshot_source_ids: snapshotSourceIds,
  });
}
