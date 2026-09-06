/** Microsoft Graph delta adapter for Outlook and OneDrive or SharePoint bodies. */

import {
  createPaginationGuard, ProviderSyncError, providerEnvelope, providerJson, providerSyncResult,
} from "./provider-sync.mjs";
import { downloadProviderFile } from "./provider-file.mjs";
import { stripMarkup } from "../ingest/quality.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAIL_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';

function cursorExpired(error) {
  if (error instanceof ProviderSyncError && error.status === 410) {
    return new ProviderSyncError("microsoft", "the saved Graph delta cursor expired; run an explicit reset so the full inventory can be reconciled", {
      kind: "retryable", status: 410, code: "cursor_expired",
    });
  }
  return error;
}

async function deltaCollection({ provider = "microsoft", initialUrl, accessToken, fetchImpl, headers = {} }) {
  const items = [];
  const deletions = [];
  const guard = createPaginationGuard(provider);
  let url = initialUrl;
  let deltaLink = null;
  while (url) {
    guard.visit(url);
    let data;
    try {
      ({ data } = await providerJson(provider, url, { accessToken, fetchImpl, headers }));
    } catch (error) {
      throw cursorExpired(error);
    }
    for (const item of data.value || []) {
      if (item?.["@removed"] || item?.deleted) deletions.push(item);
      else items.push(item);
    }
    deltaLink = data["@odata.deltaLink"] || deltaLink;
    url = data["@odata.nextLink"] || null;
  }
  if (!deltaLink) {
    throw new ProviderSyncError(provider, "Graph did not return a terminal delta cursor", {
      kind: "retryable", code: "missing_delta_link",
    });
  }
  return { items, deletions, deltaLink };
}

async function pagedGraphValues(url, auth) {
  const values = [];
  const guard = createPaginationGuard("microsoft");
  let next = url;
  while (next) {
    guard.visit(next);
    const { data } = await providerJson("microsoft", next, auth);
    values.push(...(data.value || []));
    next = data["@odata.nextLink"] || null;
  }
  return values;
}

async function configuredDriveIds({ driveIds, siteIds, includePersonalDrive, accessToken, fetchImpl }) {
  const ids = new Set((driveIds || []).map(String).filter(Boolean));
  const auth = { accessToken, fetchImpl };
  if (includePersonalDrive) {
    const { data } = await providerJson("microsoft", `${GRAPH}/me/drive?$select=id`, auth);
    if (data?.id) ids.add(String(data.id));
  }
  for (const siteId of siteIds || []) {
    const drives = await pagedGraphValues(`${GRAPH}/sites/${encodeURIComponent(siteId)}/drives?$select=id`, auth);
    for (const drive of drives) if (drive?.id) ids.add(String(drive.id));
  }
  return [...ids].sort();
}

function mailContent(message, folderId) {
  const from = message?.from?.emailAddress;
  const to = (message?.toRecipients || []).map((recipient) => recipient?.emailAddress?.address).filter(Boolean);
  const rawBody = String(message?.body?.content || message?.bodyPreview || "");
  const body = message?.body?.contentType === "html" || /<[^>]+>/.test(rawBody)
    ? stripMarkup(rawBody).trim()
    : rawBody.trim();
  return [
    `Outlook folder: ${folderId}`,
    message.subject ? `Subject: ${message.subject}` : null,
    from?.address ? `From: ${from.name || ""} <${from.address}>`.trim() : null,
    to.length ? `To: ${to.join(", ")}` : null,
    message.receivedDateTime ? `Received: ${message.receivedDateTime}` : null,
    "",
    body,
  ].filter((value) => value !== null).join("\n").trim();
}

function safeDownloadUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const allowed = [".sharepoint.com", ".1drv.com", ".onedrive.com", ".office.net", ".windows.net"];
  return allowed.some((suffix) => host.endsWith(suffix)) ? url.toString() : null;
}

async function driveItemDownloadUrl(driveId, item, auth) {
  const supplied = safeDownloadUrl(item?.["@microsoft.graph.downloadUrl"]);
  if (supplied) return supplied;
  const url = new URL(`${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}`);
  url.searchParams.set("$select", "id,name,@microsoft.graph.downloadUrl");
  const { data } = await providerJson("microsoft", url, auth);
  const resolved = safeDownloadUrl(data?.["@microsoft.graph.downloadUrl"]);
  if (!resolved) {
    throw new ProviderSyncError("microsoft", "Graph did not return a bounded HTTPS file download URL", {
      kind: "retryable", code: "download_url_unavailable",
    });
  }
  return resolved;
}

function resultWithSafePartialCursor(options, cursorSafe, extras = {}) {
  const result = providerSyncResult(options);
  return Object.freeze({
    ...result,
    ...extras,
    cursor_can_advance: Boolean(result.cursor_can_advance && cursorSafe && options.proposedCursor),
  });
}

export async function syncMicrosoftGraph({
  accessToken,
  fetchImpl = fetch,
  mailFolderIds = ["inbox"],
  driveIds = [],
  siteIds = [],
  includePersonalDrive = true,
  cursor = null,
} = {}) {
  if (!accessToken) throw new TypeError("Microsoft Graph accessToken is required");
  const documents = [];
  const deletions = [];
  const proposed = { mail: {}, drives: {} };
  const snapshotSourceIds = [];
  const gapCounts = new Map();
  const warnings = [];
  const auth = { accessToken, fetchImpl };
  const prior = cursor && typeof cursor === "object" ? cursor : {};
  let authoritativeSnapshot = true;

  for (const folderValue of mailFolderIds || []) {
    const folderId = String(folderValue);
    const saved = prior?.mail?.[folderId] || null;
    if (saved) authoritativeSnapshot = false;
    const url = new URL(`${GRAPH}/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`);
    url.searchParams.set("$select", "id,subject,body,bodyPreview,receivedDateTime,webLink,parentFolderId,from,toRecipients");
    const page = await deltaCollection({
      initialUrl: saved || url.toString(), accessToken, fetchImpl,
      headers: { Prefer: MAIL_PREFER },
    });
    for (const message of page.items) {
      if (!message?.id) continue;
      const sourceId = `outlook:message:${message.id}`;
      snapshotSourceIds.push(sourceId);
      documents.push(providerEnvelope("microsoft", sourceId, {
        title: message.subject || "Outlook message",
        content: mailContent(message, folderId),
        occurredAt: message.receivedDateTime || null,
        uri: message.webLink || `outlook://message/${encodeURIComponent(message.id)}`,
        metadata: { workload: "outlook", message_id: message.id, folder_id: folderId },
      }));
    }
    deletions.push(...page.deletions.filter((message) => message?.id).map((message) => ({
      source_type: "microsoft", source_id: `outlook:message:${message.id}`,
    })));
    proposed.mail[folderId] = page.deltaLink;
  }

  const selectedDriveIds = await configuredDriveIds({
    driveIds, siteIds, includePersonalDrive, accessToken, fetchImpl,
  });
  for (const [priorDriveId, priorCursor] of Object.entries(prior?.drives || {})) {
    if (selectedDriveIds.includes(priorDriveId)) continue;
    authoritativeSnapshot = false;
    proposed.drives[priorDriveId] = priorCursor;
    warnings.push(
      `Microsoft drive ${priorDriveId} is not currently visible in the configured drive inventory. ` +
      "Its prior cursor and indexed documents were retained instead of treating lost access as deletion.",
    );
  }
  for (const driveId of selectedDriveIds) {
    const saved = prior?.drives?.[driveId] || null;
    if (saved) authoritativeSnapshot = false;
    const url = new URL(`${GRAPH}/drives/${encodeURIComponent(driveId)}/root/delta`);
    url.searchParams.set("$select", "id,name,file,folder,deleted,lastModifiedDateTime,webUrl,size,parentReference,@microsoft.graph.downloadUrl");
    const page = await deltaCollection({ initialUrl: saved || url.toString(), accessToken, fetchImpl });
    for (const item of page.items) {
      if (!item?.file || !item?.id) continue;
      const sourceId = `drive:item:${driveId}:${item.id}`;
      snapshotSourceIds.push(sourceId);
      const downloadUrl = await driveItemDownloadUrl(driveId, item, auth);
      const extracted = await downloadProviderFile({
        provider: "microsoft", url: downloadUrl, accessToken: null, fetchImpl, name: item.name,
      });
      if (!extracted.ok) {
        gapCounts.set(extracted.code, (gapCounts.get(extracted.code) || 0) + 1);
        continue;
      }
      documents.push(providerEnvelope("microsoft", sourceId, {
        title: item.name || "Microsoft drive item",
        content: extracted.content,
        occurredAt: item.lastModifiedDateTime || null,
        uri: item.webUrl || `microsoft-drive://drive/${encodeURIComponent(driveId)}/item/${encodeURIComponent(item.id)}`,
        metadata: {
          workload: "drive", drive_id: driveId, item_id: item.id,
          mime_type: item.file?.mimeType || extracted.response_media_type || null,
          size: Number(item.size || 0),
          ...extracted.provenance,
        },
      }));
    }
    deletions.push(...page.deletions.filter((item) => item?.id).map((item) => ({
      source_type: "microsoft", source_id: `drive:item:${driveId}:${item.id}`,
    })));
    proposed.drives[driveId] = page.deltaLink;
  }

  for (const [code, count] of gapCounts) {
    warnings.push(`${count} Microsoft drive file(s) were inventoried but not indexed because of ${code}.`);
  }
  const cursorSafe = Object.keys(proposed.mail).length + Object.keys(proposed.drives).length > 0;
  return resultWithSafePartialCursor({
    provider: "microsoft", documents, deletions, warnings,
    proposedCursor: proposed,
    deletionAuthority: "authoritative",
    complete: warnings.length === 0,
  }, cursorSafe, {
    authoritative_snapshot: authoritativeSnapshot,
    snapshot_source_ids: snapshotSourceIds,
  });
}
