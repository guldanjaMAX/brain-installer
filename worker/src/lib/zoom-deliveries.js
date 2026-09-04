/**
 * Durable Zoom webhook debt and missed-webhook reconciliation state.
 *
 * The webhook route must write one of these rows before it returns HTTP 2xx.
 * Processing uses short compare-and-swap leases, so a Worker crash leaves debt
 * that another scheduled invocation can safely retry. Document ingestion is
 * independently idempotent on the recording UUID.
 */

import { ingestionOutcome } from "./ingestion-outcome.js";

export const ZOOM_DELIVERY_MIGRATION = "0025_zoom_deliveries.sql";
export const ZOOM_DELIVERY_LEASE_MS = 10 * 60 * 1000;
export const ZOOM_RECONCILE_LEASE_MS = 10 * 60 * 1000;
export const ZOOM_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

const ACTIVE_DELIVERY_STATES = new Set(["pending", "processing", "retryable"]);
const FINAL_DELIVERY_STATES = new Set(["completed", "refused", "unavailable"]);

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function safeNow(value = Date.now()) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("Zoom delivery time is invalid");
  return number;
}

function safeUuid(value) {
  const uuid = String(value || "").trim();
  if (!uuid || uuid.length > 512 || /[\u0000-\u001f\u007f]/.test(uuid)) {
    throw new TypeError("Zoom recording UUID is invalid");
  }
  return uuid;
}

function safeOwner(value = crypto.randomUUID()) {
  const owner = String(value || "").trim();
  if (!owner || owner.length > 200 || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw new TypeError("Zoom delivery lease owner is invalid");
  }
  return owner;
}

function safeEvent(value) {
  const event = String(value || "unknown").trim().slice(0, 100);
  return event || "unknown";
}

function safeCode(value) {
  return String(value || "unspecified").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 100) || "unspecified";
}

function requireDatabase(env) {
  if (!env?.DB?.prepare) throw new Error(`Zoom delivery storage requires ${ZOOM_DELIVERY_MIGRATION}`);
  return env.DB;
}

export function zoomDeliveryRetryDelay(attempt, {
  baseDelayMs = 15_000,
  maxDelayMs = 60 * 60 * 1000,
  randomImpl = Math.random,
} = {}) {
  const sequence = Math.min(20, Math.max(0, boundedInteger(attempt, 1, { min: 1 }) - 1));
  const base = boundedInteger(baseDelayMs, 15_000, { min: 1 });
  const cap = boundedInteger(maxDelayMs, 60 * 60 * 1000, { min: 1 });
  const random = Math.min(1, Math.max(0, Number(randomImpl?.()) || 0));
  return Math.floor(Math.min(cap, base * (2 ** sequence)) * (0.5 + (random * 0.5)));
}

/** Persist the named recording before acknowledging its webhook. */
export async function persistZoomDelivery(env, {
  uuid,
  eventType,
  meetingId = null,
  receivedAtMs = Date.now(),
} = {}) {
  const db = requireDatabase(env);
  const recordingUuid = safeUuid(uuid);
  const event = safeEvent(eventType);
  const meeting = meetingId === null || meetingId === undefined ? null : String(meetingId).trim().slice(0, 100) || null;
  const now = safeNow(receivedAtMs);
  await db.prepare(
    `INSERT INTO zoom_deliveries
       (recording_uuid,event_type,received_at_ms,status,attempts,next_attempt_at_ms,
        lease_owner,lease_expires_at_ms,last_error_code,created_at_ms,updated_at_ms,completed_at_ms,meeting_id)
     VALUES (?1,?2,?3,'pending',0,?3,NULL,NULL,NULL,?3,?3,NULL,?4)
     ON CONFLICT(recording_uuid) DO UPDATE SET
       event_type = CASE
         WHEN excluded.event_type = 'recording.transcript_completed' THEN excluded.event_type
         ELSE zoom_deliveries.event_type
       END,
       received_at_ms = MAX(zoom_deliveries.received_at_ms, excluded.received_at_ms),
       meeting_id = COALESCE(excluded.meeting_id, zoom_deliveries.meeting_id),
       status = CASE
         WHEN zoom_deliveries.status IN ('completed','refused') THEN zoom_deliveries.status
         WHEN zoom_deliveries.status = 'processing'
              AND zoom_deliveries.lease_expires_at_ms > excluded.received_at_ms THEN 'processing'
         ELSE 'pending'
       END,
       next_attempt_at_ms = CASE
         WHEN zoom_deliveries.status IN ('completed','refused') THEN zoom_deliveries.next_attempt_at_ms
         WHEN zoom_deliveries.status = 'processing'
              AND zoom_deliveries.lease_expires_at_ms > excluded.received_at_ms
           THEN zoom_deliveries.next_attempt_at_ms
         ELSE MIN(zoom_deliveries.next_attempt_at_ms, excluded.next_attempt_at_ms)
       END,
       lease_owner = CASE
         WHEN zoom_deliveries.status = 'processing'
              AND zoom_deliveries.lease_expires_at_ms > excluded.received_at_ms
           THEN zoom_deliveries.lease_owner
         ELSE NULL
       END,
       lease_expires_at_ms = CASE
         WHEN zoom_deliveries.status = 'processing'
              AND zoom_deliveries.lease_expires_at_ms > excluded.received_at_ms
           THEN zoom_deliveries.lease_expires_at_ms
         ELSE NULL
       END,
       last_error_code = CASE
         WHEN zoom_deliveries.status IN ('completed','refused') THEN zoom_deliveries.last_error_code
         ELSE NULL
       END,
       updated_at_ms = excluded.updated_at_ms`
  ).bind(recordingUuid, event, now, meeting).run();
  const row = await db.prepare(
    `SELECT recording_uuid,event_type,meeting_id,status,attempts,next_attempt_at_ms,
            lease_expires_at_ms,last_error_code
       FROM zoom_deliveries WHERE recording_uuid=?1`
  ).bind(recordingUuid).first();
  if (!row) throw new Error("Zoom delivery debt could not be verified after persistence");
  return row;
}

/** Claim a bounded set of due deliveries. Expired processing leases are recoverable. */
export async function claimZoomDeliveries(env, {
  nowMs = Date.now(),
  limit = 10,
  leaseMs = ZOOM_DELIVERY_LEASE_MS,
  ownerToken = crypto.randomUUID(),
} = {}) {
  const db = requireDatabase(env);
  const now = safeNow(nowMs);
  const owner = safeOwner(ownerToken);
  const boundedLimit = boundedInteger(limit, 10, { min: 1, max: 100 });
  const ttl = boundedInteger(leaseMs, ZOOM_DELIVERY_LEASE_MS, { min: 1_000, max: 15 * 60 * 1000 });
  const expires = now + ttl;
  if (!Number.isSafeInteger(expires)) throw new TypeError("Zoom delivery lease expiry is invalid");

  const candidates = await db.prepare(
    `SELECT recording_uuid,event_type,meeting_id,received_at_ms,status,attempts,next_attempt_at_ms
       FROM zoom_deliveries
      WHERE ((status IN ('pending','retryable') AND next_attempt_at_ms <= ?1)
          OR (status = 'processing' AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?1)))
      ORDER BY next_attempt_at_ms ASC, received_at_ms ASC
      LIMIT ?2`
  ).bind(now, boundedLimit).all();

  const claimed = [];
  for (const candidate of candidates?.results || []) {
    const result = await db.prepare(
      `UPDATE zoom_deliveries
          SET status='processing', attempts=attempts+1, lease_owner=?2,
              lease_expires_at_ms=?3, updated_at_ms=?1
        WHERE recording_uuid=?4
          AND ((status IN ('pending','retryable') AND next_attempt_at_ms <= ?1)
            OR (status='processing' AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?1)))`
    ).bind(now, owner, expires, candidate.recording_uuid).run();
    if (changes(result) !== 1) continue;
    claimed.push({ ...candidate, status: "processing", attempts: Number(candidate.attempts || 0) + 1, ownerToken: owner, leaseExpiresAtMs: expires });
  }
  return claimed;
}

/** Complete, refuse, mark unavailable, or reschedule one delivery under its lease. */
export async function finishZoomDelivery(env, delivery, {
  outcome,
  errorCode = null,
  nowMs = Date.now(),
  retryDelayMs = null,
  randomImpl = Math.random,
} = {}) {
  const db = requireDatabase(env);
  const uuid = safeUuid(delivery?.recording_uuid);
  const owner = safeOwner(delivery?.ownerToken);
  const now = safeNow(nowMs);
  const normalized = ingestionOutcome(outcome?.kind, { reason: outcome?.reason });
  if (normalized.kind === "partial") {
    throw new TypeError("a Zoom delivery cannot be finalized as partial; retry the whole recording instead");
  }
  const status = normalized.kind;
  if (!ACTIVE_DELIVERY_STATES.has(status) && !FINAL_DELIVERY_STATES.has(status)) {
    throw new TypeError(`unsupported Zoom delivery outcome ${status}`);
  }
  const retryable = status === "retryable";
  const delay = retryable
    ? boundedInteger(retryDelayMs, zoomDeliveryRetryDelay(delivery.attempts, { randomImpl }), { min: 0, max: 24 * 60 * 60 * 1000 })
    : 0;
  const next = now + delay;
  const result = await db.prepare(
    `UPDATE zoom_deliveries
        SET status=?1, next_attempt_at_ms=?2, lease_owner=NULL, lease_expires_at_ms=NULL,
            last_error_code=?3, updated_at_ms=?4,
            completed_at_ms=CASE WHEN ?1='completed' THEN ?4 ELSE completed_at_ms END
      WHERE recording_uuid=?5 AND status='processing' AND lease_owner=?6`
  ).bind(status, next, errorCode ? safeCode(errorCode) : null, now, uuid, owner).run();
  if (changes(result) !== 1) throw new Error("Zoom delivery lease was lost before its outcome was recorded");
  return { recording_uuid: uuid, status, next_attempt_at_ms: next, outcome: normalized };
}

/** Claim the singleton reconciliation cursor if its schedule and lease permit it. */
export async function claimZoomReconciliation(env, {
  nowMs = Date.now(),
  leaseMs = ZOOM_RECONCILE_LEASE_MS,
  ownerToken = crypto.randomUUID(),
} = {}) {
  const db = requireDatabase(env);
  const now = safeNow(nowMs);
  const owner = safeOwner(ownerToken);
  const ttl = boundedInteger(leaseMs, ZOOM_RECONCILE_LEASE_MS, { min: 1_000, max: 15 * 60 * 1000 });
  const expires = now + ttl;
  const result = await db.prepare(
    `UPDATE zoom_reconciliation
        SET status='processing', lease_owner=?1, lease_expires_at_ms=?2, updated_at_ms=?3
      WHERE id=1 AND next_run_at_ms <= ?3
        AND (lease_owner IS NULL OR lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?3)`
  ).bind(owner, expires, now).run();
  if (changes(result) !== 1) return { acquired: false };
  const row = await db.prepare(
    `SELECT window_from,next_page_token,next_run_at_ms
       FROM zoom_reconciliation WHERE id=1 AND lease_owner=?1`
  ).bind(owner).first();
  if (!row) throw new Error("Zoom reconciliation lease could not be verified");
  return { acquired: true, ownerToken: owner, leaseExpiresAtMs: expires, ...row };
}

/** Save a cursor only after every recording on that page is durable. */
export async function checkpointZoomReconciliation(env, lease, {
  nextPageToken = null,
  windowFrom = lease?.window_from,
  nextRunAtMs = Date.now(),
  status = "idle",
  errorCode = null,
  nowMs = Date.now(),
  release = true,
  leaseMs = ZOOM_RECONCILE_LEASE_MS,
} = {}) {
  const db = requireDatabase(env);
  const owner = safeOwner(lease?.ownerToken);
  const now = safeNow(nowMs);
  const nextRun = safeNow(nextRunAtMs);
  const ttl = boundedInteger(leaseMs, ZOOM_RECONCILE_LEASE_MS, { min: 1_000, max: 15 * 60 * 1000 });
  const renewedUntil = now + ttl;
  if (!new Set(["idle", "processing", "retryable", "unavailable", "refused"]).has(status)) {
    throw new TypeError(`unsupported Zoom reconciliation status ${status}`);
  }
  const result = await db.prepare(
    `UPDATE zoom_reconciliation
        SET status=?1, window_from=?2, next_page_token=?3, next_run_at_ms=?4,
            lease_owner=CASE WHEN ?5=1 THEN NULL ELSE lease_owner END,
            lease_expires_at_ms=CASE WHEN ?5=1 THEN NULL ELSE ?9 END,
            last_error_code=?6, updated_at_ms=?7,
            completed_at_ms=CASE WHEN ?1='idle' AND ?3 IS NULL THEN ?7 ELSE completed_at_ms END
      WHERE id=1 AND lease_owner=?8`
  ).bind(
    status,
    String(windowFrom || "").slice(0, 10),
    nextPageToken ? String(nextPageToken).slice(0, 2_000) : null,
    nextRun,
    release ? 1 : 0,
    errorCode ? safeCode(errorCode) : null,
    now,
    owner,
    renewedUntil,
  ).run();
  if (changes(result) !== 1) throw new Error("Zoom reconciliation lease was lost before its cursor was recorded");
  return { status, next_page_token: nextPageToken || null, next_run_at_ms: nextRun };
}

export const zoomDeliveryStore = Object.freeze({
  persist: persistZoomDelivery,
  claim: claimZoomDeliveries,
  finish: finishZoomDelivery,
  claimReconciliation: claimZoomReconciliation,
  checkpointReconciliation: checkpointZoomReconciliation,
});
