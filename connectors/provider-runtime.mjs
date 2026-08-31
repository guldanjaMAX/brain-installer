/**
 * Common delivery boundary for owner-machine provider connectors.
 *
 * Provider adapters only read and normalize remote data. This runner opens and
 * closes the common source receipt, sends stable documents through the batch
 * ingest route, applies exact tombstones, and commits an opaque provider cursor
 * only after every durable receipt and deletion succeeds.
 */

import { createHash, randomBytes } from "node:crypto";
import { batches, splitOversized } from "../ingest/envelope-batching.mjs";
import { ingestionOutcome } from "../ingest/outcome.mjs";
import { sourceReceiptIssueCode } from "../worker/src/lib/source-receipt.js";

const SAFE_SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESULT_STATUSES = new Set(["created", "updated", "unchanged", "refused", "failed"]);
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export class ProviderDeliveryError extends Error {
  constructor(message, { code = "provider_delivery_failed", tally = null } = {}) {
    super(message);
    this.name = "ProviderDeliveryError";
    this.code = code;
    this.tally = tally;
  }
}

export const providerRunId = () => `sync_${randomBytes(16).toString("hex")}`;
export const providerSnapshotRemovalFingerprint = (source, uids) => createHash("sha256")
  .update(JSON.stringify({ version: 1, source, uids: [...new Set(uids)].sort() }))
  .digest("hex");

const providerRemovalReviewRequired = (removalCount, storedCount) =>
  removalCount > 100 || (storedCount > 0 && removalCount / storedCount > 0.10);

export function normalizeProviderResult(source, result) {
  const sourceName = clean(source).toLowerCase();
  if (!SAFE_SOURCE.test(sourceName)) throw new TypeError("provider delivery needs a safe source name");
  if (!result?.outcome || !Array.isArray(result.documents) || !Array.isArray(result.deletions)) {
    throw new TypeError("provider adapter returned no common sync result");
  }
  const documents = result.documents.map((document) => ({ ...document, source_type: sourceName }));
  const deletions = result.deletions.map((deletion) => ({ ...deletion, source_type: sourceName }));
  const documentIds = documents.map((document) => String(document?.source_id || ""));
  const deletionIds = deletions.map((deletion) => String(deletion?.source_id || ""));
  if (documentIds.some((id) => !id.trim()) || new Set(documentIds).size !== documentIds.length) {
    throw new ProviderDeliveryError("the provider result has an empty or duplicate live source identity", {
      code: "invalid_provider_identity",
    });
  }
  if (deletionIds.some((id) => !id.trim())) {
    throw new ProviderDeliveryError("the provider result has an empty tombstone source identity", {
      code: "invalid_provider_tombstone",
    });
  }
  const live = new Set(documentIds);
  if (deletionIds.some((id) => live.has(id))) {
    // Applying a live row and its tombstone in one accepted provider window is
    // order-dependent data loss. The adapter must resolve the ambiguity or the
    // whole window remains retryable with its cursor withheld.
    throw new ProviderDeliveryError("the provider result marks the same source identity live and deleted", {
      code: "provider_identity_conflict",
    });
  }
  return {
    ...result,
    documents,
    deletions,
  };
}

function receiptBody(value) {
  if (value?.body && typeof value.body === "object") return value.body;
  if (typeof value?.raw === "string") {
    try { return JSON.parse(value.raw); } catch { return null; }
  }
  return value && typeof value === "object" && Array.isArray(value.results) ? value : null;
}

function receiptOkay(value) {
  if (value?.res && value.res.ok !== true) return false;
  return true;
}

function validateResults(body, group) {
  if (!body || !Array.isArray(body.results)) {
    throw new ProviderDeliveryError("the ingest response has no per-document results", { code: "invalid_ingest_receipt" });
  }
  const expected = new Set(group.map((document) => String(document.source_id || "")));
  if (expected.has("") || expected.size !== group.length) {
    throw new ProviderDeliveryError("the provider batch has an empty or duplicate source identity", { code: "invalid_provider_identity" });
  }
  const received = new Set();
  for (const item of body.results) {
    const id = String(item?.source_id || "");
    if (!expected.has(id) || received.has(id) || !RESULT_STATUSES.has(String(item?.status || ""))) {
      throw new ProviderDeliveryError("the ingest response did not exactly acknowledge the provider batch", {
        code: "invalid_ingest_receipt",
      });
    }
    received.add(id);
  }
  if (received.size !== expected.size) {
    throw new ProviderDeliveryError("the ingest response omitted one or more provider documents", {
      code: "invalid_ingest_receipt",
    });
  }
  return body.results;
}

export async function deliverProviderDocuments(documents, {
  sendBatch,
  base,
  adminKey,
} = {}) {
  if (typeof sendBatch !== "function") throw new TypeError("provider delivery needs sendBatch");
  const expanded = documents.flatMap((document) => splitOversized(document));
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0, sent: expanded.length };
  for (const group of batches(expanded.map((envelope) => ({ envelope })))) {
    const sent = await sendBatch({ base, adminKey, docs: group.map((item) => item.envelope) });
    const body = receiptBody(sent);
    if (!receiptOkay(sent) || !body) {
      throw new ProviderDeliveryError(`the ingest batch was not accepted${sent?.res?.status ? ` (HTTP ${sent.res.status})` : ""}`, {
        code: "ingest_batch_failed", tally,
      });
    }
    for (const item of validateResults(body, group.map((entry) => entry.envelope))) {
      tally[item.status]++;
    }
  }
  return tally;
}

export async function applyProviderDeletions(source, deletions, {
  removeDocuments,
  base,
  adminKey,
} = {}) {
  if (!deletions.length) return { applied: 0, pending: 0 };
  if (typeof removeDocuments !== "function") throw new TypeError("provider deletion needs removeDocuments");
  const uids = [...new Set(deletions.map((item) => `${source}:${String(item.source_id || "")}`))];
  if (uids.some((uid) => uid === `${source}:`)) {
    throw new ProviderDeliveryError("a provider tombstone has no source identity", { code: "invalid_provider_tombstone" });
  }
  const result = await removeDocuments({
    uids, base, adminKey,
    state: { done: {}, removed: {} },
    dryRun: false,
    label: `${source} deletion`,
  });
  const applied = Math.max(0, Math.trunc(Number(result?.applied || 0)));
  const pending = Math.max(0, Math.trunc(Number(result?.pending || 0)));
  return { applied, pending };
}

function resultDetail(result, tally, removal, cursorAdvanced) {
  const prefix = result.outcome.kind === "completed"
    ? "provider sync completed"
    : `provider sync ${result.outcome.kind}: ${clean(result.outcome.reason || result.warnings?.[0] || "explicit provider limitation")}`;
  return [
    prefix,
    `${tally.created} created`, `${tally.updated} updated`, `${tally.unchanged} unchanged`,
    `${tally.refused} refused`, `${tally.failed} failed`, `${removal.applied} removed`,
    `${removal.pending} removal pending`, cursorAdvanced ? "cursor advanced" : "cursor withheld",
  ].join("; ").slice(0, 500);
}

/**
 * Run one provider window. Permanent provider limitations preserve accepted
 * documents, but close the source as error and never advance its cursor.
 * Delivery failures also close the source as error and throw so a scheduler
 * cannot record success.
 */
export async function runProviderConnector({
  provider,
  source = provider,
  kind = provider,
  configurationFingerprint = null,
  sync,
  resolveAccess,
  loadState = () => ({}),
  saveState = () => {},
  sendBatch,
  removeDocuments,
  listStoredFamilies,
  postReceipt,
  base,
  adminKey,
  lane = "manual",
  now = () => new Date(),
  runId = providerRunId(),
  reset = false,
  approvedSnapshotFingerprint = null,
} = {}) {
  const sourceName = clean(source).toLowerCase();
  if (!SAFE_SOURCE.test(sourceName)) throw new TypeError("provider runner needs a safe source name");
  if (typeof sync !== "function" || typeof resolveAccess !== "function" || typeof postReceipt !== "function") {
    throw new TypeError("provider runner is missing sync, resolveAccess, or postReceipt");
  }
  const startedAt = now().toISOString();
  let opened = false;
  await postReceipt(base, adminKey, {
    source: sourceName, kind, status: "indexing", run_id: runId,
    lane, started_at: startedAt, detail: `${provider} sync started`,
  });
  opened = true;

  try {
    const stored = await loadState();
    const cursor = reset || (configurationFingerprint && stored?.configuration_fingerprint !== configurationFingerprint)
      ? null
      : stored?.cursor ?? null;
    const access = await resolveAccess();
    let normalized = normalizeProviderResult(sourceName, await sync({
      accessToken: access.accessToken,
      connection: access.connection,
      cursor,
    }));
    let storedFamiliesBefore = null;
    let snapshotNeedsRemovalReview = false;
    if (normalized.authoritative_snapshot === true) {
      if (typeof listStoredFamilies !== "function") {
        throw new ProviderDeliveryError("an authoritative provider snapshot needs stored-family reconciliation", {
          code: "provider_snapshot_reconciliation_unavailable",
        });
      }
      const storedFamilies = await listStoredFamilies({ base, adminKey, source: sourceName });
      storedFamiliesBefore = storedFamilies;
      const seen = new Set((normalized.snapshot_source_ids || normalized.documents.map((item) => item.source_id))
        .map((id) => `${sourceName}:${String(id || "")}`));
      if (seen.has(`${sourceName}:`)) {
        throw new ProviderDeliveryError("the provider snapshot contains an empty source identity", {
          code: "invalid_provider_identity",
        });
      }
      const stale = [...storedFamilies].filter((uid) => !seen.has(uid)).map((uid) => ({
        source_type: sourceName,
        source_id: uid.slice(sourceName.length + 1),
      }));
      snapshotNeedsRemovalReview = stale.length > 0;
      normalized = {
        ...normalized,
        deletions: [...normalized.deletions, ...stale].filter((item, index, all) =>
          all.findIndex((other) => other.source_id === item.source_id) === index),
        snapshot_reconciled: true,
      };
    }
    if (normalized.deletions.length) {
      if (typeof listStoredFamilies !== "function") {
        throw new ProviderDeliveryError("provider tombstones need authenticated stored-family inventory before deletion", {
          code: "provider_deletion_inventory_unavailable",
        });
      }
      storedFamiliesBefore ||= await listStoredFamilies({ base, adminKey, source: sourceName });
      const planned = normalized.deletions.filter((item) =>
        storedFamiliesBefore.has(`${sourceName}:${String(item.source_id || "")}`));
      const plannedUids = planned.map((item) => `${sourceName}:${item.source_id}`);
      const fingerprint = providerSnapshotRemovalFingerprint(sourceName, plannedUids);
      if ((snapshotNeedsRemovalReview || providerRemovalReviewRequired(planned.length, storedFamiliesBefore.size)) &&
          approvedSnapshotFingerprint !== fingerprint) {
        throw new ProviderDeliveryError(
          `${planned.length} provider document family or families are planned for removal from ` +
          `${storedFamiliesBefore.size} stored families; review the aggregate scope and re-run with ` +
          `--approve-removals ${fingerprint}`,
          { code: "provider_removal_review_required" },
        );
      }
      normalized = { ...normalized, deletions: planned };
    }
    const tally = await deliverProviderDocuments(normalized.documents, { sendBatch, base, adminKey });
    const removal = await applyProviderDeletions(sourceName, normalized.deletions, {
      removeDocuments, base, adminKey,
    });
    let deletionReadbackVerified = normalized.deletions.length === 0;
    if (normalized.deletions.length && removal.pending === 0) {
      if (typeof listStoredFamilies !== "function") {
        throw new ProviderDeliveryError("provider tombstones need exact source-family readback before cursor advancement", {
          code: "provider_deletion_readback_unavailable",
        });
      }
      const afterRemoval = await listStoredFamilies({ base, adminKey, source: sourceName });
      const deletedUids = [...new Set(normalized.deletions.map((item) => `${sourceName}:${String(item.source_id || "")}`))];
      const stillStored = deletedUids.filter((uid) => afterRemoval.has(uid));
      if (stillStored.length) {
        throw new ProviderDeliveryError(
          `${stillStored.length} provider tombstone family or families remained after exact source-inventory readback`,
          { code: "provider_deletion_not_confirmed" },
        );
      }
      deletionReadbackVerified = true;
    }
    const deliveryComplete = tally.failed === 0 && tally.refused === 0 && removal.pending === 0 && deletionReadbackVerified;
    const sourceComplete = normalized.outcome.kind === "completed";
    // The common runner, not an individual adapter, owns cursor and health
    // truth. An inconsistent adapter must not turn an explicit partial result
    // into a skipped provider window or a healthy source receipt.
    const cursorAdvanced = deliveryComplete && sourceComplete &&
      normalized.cursor_can_advance && normalized.proposed_cursor !== null;
    const completedAt = now().toISOString();
    if (cursorAdvanced) {
      await saveState({
        cursor: normalized.proposed_cursor,
        configuration_fingerprint: configurationFingerprint,
        completed_at: completedAt,
      });
    }
    const detail = resultDetail(normalized, tally, removal, cursorAdvanced);
    if (!deliveryComplete) {
      throw new ProviderDeliveryError(detail, { code: "provider_delivery_incomplete", tally });
    }
    await postReceipt(base, adminKey, {
      source: sourceName, kind, status: sourceComplete ? "ready" : "error", run_id: runId, lane,
      started_at: startedAt, completed_at: completedAt,
      docs_added: tally.created, docs_updated: tally.updated, docs_unchanged: tally.unchanged,
      walk_complete: sourceComplete,
      outcome_kind: normalized.outcome.kind,
      deletion_authority: normalized.deletion_authority,
      ...(sourceComplete ? { detail } : { issue_code: "INGEST_FAILED" }),
    });
    return {
      ...normalized,
      tally,
      removed: removal.applied,
      removal_pending: removal.pending,
      deletion_readback_verified: deletionReadbackVerified,
      cursor_advanced: cursorAdvanced,
    };
  } catch (error) {
    if (opened) {
      try {
        await postReceipt(base, adminKey, {
          source: sourceName, kind, status: "error", run_id: runId, lane,
          started_at: startedAt, completed_at: now().toISOString(),
          issue_code: sourceReceiptIssueCode(error),
        });
      } catch { /* the original failure remains authoritative */ }
    }
    throw error;
  }
}

export function providerPartialOutcome(reason) {
  return ingestionOutcome("partial", { reason });
}
