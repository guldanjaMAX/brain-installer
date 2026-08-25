#!/usr/bin/env node

/**
 * Resumable migration from the normalized messaging schema.
 *
 * Source reads are globally chronological and use the existing timestamp
 * index. Email remains one document per message. Short-form chat is grouped by
 * the reusable MessageSessionizer into bounded, speaker-labelled sessions.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_DOC_CHARS, batches, splitOversized } from "../ingest/envelope-batching.mjs";
import {
  MESSAGE_CHAT_PLATFORMS, MESSAGE_SESSION_DEFAULTS, MessageSessionizer,
  messageRowDisposition,
} from "../ingest/message-session.mjs";
import { GATE_VERSION, sanitizeEnvelope, scanEnvelope as scanSecrets } from "../worker/src/lib/secret-scan.js";
import {
  assertTargetReceiptIdentity, getTargetInventory, isDirectExecution,
  listTargetSourceFamilies, postSourceReceipt, postTargetBatch, querySupabase,
  reconcileTargetFamilies,
} from "./supabase-import.mjs";
import { readProtectedStateJson, saveProtectedStateJson } from "./state-file.mjs";

export const MESSAGE_STATE_VERSION = 2;
export const MESSAGE_STATE_SCHEMA = "brain-message-migration";
const MESSAGE_ALGORITHM_VERSION = "message-sessions-v3-exact-reconciliation";
const ELIGIBLE = "coalesce(m.flagged, false) = false AND m.ts IS NOT NULL AND m.body IS NOT NULL AND length(trim(m.body)) >= 4";
const cleanUrl = (value) => String(value || "").replace(/\/+$/, "");
const sqlText = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;
const positiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
const bound = (value, label) => {
  if (!value) return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is not a valid date`);
  return date.toISOString();
};
const rangeSql = ({ from = null, to = null } = {}) => [
  from ? `AND m.ts >= ${sqlText(from)}::timestamptz` : "",
  to ? `AND m.ts <= ${sqlText(to)}::timestamptz` : "",
].filter(Boolean).join("\n            ");

export function isMessageMigrationDirectExecution(argvPath, options) {
  return isDirectExecution(argvPath, import.meta.url, options);
}

export function messageHighWaterSql(scope = {}) {
  return `SELECT m.ts::text AS ts, m.id::text AS id,
                  count(*) OVER()::text AS eligible_rows
    FROM messaging.messages m
    WHERE ${ELIGIBLE}
      ${rangeSql(scope)}
    ORDER BY m.ts DESC, m.id DESC LIMIT 1`;
}

export function messagePageSql(cursor, highWater, limit = 1000, scope = {}) {
  if (!highWater?.ts || !highWater?.id) throw new Error("message migration high-water mark is missing");
  const after = cursor?.ts && cursor?.id
    ? `AND (m.ts, m.id::text) > (${sqlText(cursor.ts)}::timestamptz, ${sqlText(cursor.id)})`
    : "";
  return `SELECT m.id::text AS cursor_id, m.id::text AS id, m.thread_id::text AS thread_id,
                 m.platform, m.direction, m.ts::text AS ts, m.body,
                 t.title AS thread_title, t.category,
                 coalesce(p.display_name, h.display_label) AS sender_name
          FROM messaging.messages m
          LEFT JOIN messaging.threads t ON t.id = m.thread_id
          LEFT JOIN messaging.handles h ON h.id = m.sender_handle_id
          LEFT JOIN messaging.people p ON p.id = h.person_id
          WHERE ${ELIGIBLE}
            ${rangeSql(scope)}
            ${after}
            AND (m.ts, m.id::text) <= (${sqlText(highWater.ts)}::timestamptz, ${sqlText(highWater.id)})
          ORDER BY m.ts, m.id
          LIMIT ${positiveInt(limit, 1000, 5000)}`;
}

export function messageExpectedCountSql(highWater, scope = {}) {
  if (!highWater?.ts || !highWater?.id) throw new Error("message migration high-water mark is missing");
  return `SELECT count(*)::text AS eligible_rows
          FROM messaging.messages m
          WHERE ${ELIGIBLE}
            ${rangeSql(scope)}
            AND (m.ts, m.id::text) <= (${sqlText(highWater.ts)}::timestamptz, ${sqlText(highWater.id)})`;
}

export function messageFrozenBoundarySql(highWater, scope = {}) {
  if (!highWater?.ts || !highWater?.id) throw new Error("message migration high-water mark is missing");
  return `SELECT m.ts::text AS ts, m.id::text AS id,
                  count(*) OVER()::text AS eligible_rows
          FROM messaging.messages m
          WHERE ${ELIGIBLE}
            ${rangeSql(scope)}
            AND (m.ts, m.id::text) <= (${sqlText(highWater.ts)}::timestamptz, ${sqlText(highWater.id)})
          ORDER BY m.ts DESC, m.id DESC LIMIT 1`;
}

const freshLane = () => ({
  high_water: null,
  cursor: null,
  active: [],
  complete: false,
  pages: 0,
  source_messages: 0,
  candidate_documents: 0,
  candidate_parts: 0,
  target_documents: 0,
  target_chunks: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  refused: 0,
  failed: 0,
  skipped: 0,
  expected_source_messages: null,
  legacy_unclassified_source_messages: 0,
  legacy_pending_source_messages: 0,
  legacy_candidate_documents: 0,
  legacy_target_documents: 0,
  legacy_refused: 0,
  represented_source_messages: 0,
  skipped_source_messages: 0,
  candidate_source_messages: 0,
  accepted_family_hashes: [],
  reconciled_refused_families: 0,
  reconciled_accepted_families: 0,
  source_boundary: null,
  target_reconciliation: null,
  skipped_by_reason: {},
  refusals: [],
  scope: null,
  config_fingerprint: null,
  accounting: null,
  accounting_verified_at: null,
  completed_at: null,
  receipt_recorded_at: null,
  target_readback: null,
  legacy_defaults_applied: false,
});

const nonNegativeInteger = (value, label, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`message migration ${label} is invalid`);
  return value;
};

const normalizeLane = (lane, { legacy = false } = {}) => {
  const defaults = freshLane();
  for (const [key, value] of Object.entries(defaults)) {
    if (lane[key] === undefined) lane[key] = structuredClone(value);
  }
  if (legacy) {
    lane.legacy_defaults_applied = true;
    lane.legacy_unclassified_source_messages = nonNegativeInteger(
      Number(lane.source_messages || 0), "legacy source count",
    );
    lane.legacy_pending_source_messages = Array.isArray(lane.active)
      ? lane.active.reduce((total, session) => total + Math.max(0, Number(session?.message_count || 0)), 0)
      : 0;
    lane.represented_source_messages = 0;
    lane.skipped_source_messages = 0;
    lane.candidate_source_messages = 0;
    lane.candidate_parts = 0;
    lane.legacy_candidate_documents = nonNegativeInteger(
      Number(lane.candidate_documents || 0), "legacy candidate document count",
    );
    lane.legacy_target_documents = nonNegativeInteger(
      Number(lane.target_documents || 0), "legacy target document count",
    );
    lane.legacy_refused = nonNegativeInteger(Number(lane.refused || 0), "legacy refusal count");
    lane.skipped_by_reason = {};
    lane.accounting = null;
  }
  return lane;
};

// A missing fingerprint is safe only for an untouched lane. Once any source
// boundary, cursor, session, receipt, or accounting value has been persisted,
// stamping today's gate version would falsely claim earlier documents passed
// rules that did not exist when they were written.
const hasUnfingerprintedProgress = (lane) => Boolean(
  lane.complete || lane.high_water || lane.cursor || lane.scope ||
  lane.expected_source_messages !== null || lane.accounting ||
  lane.accounting_verified_at || lane.completed_at || lane.receipt_recorded_at ||
  lane.target_readback || lane.last_checkpoint_at ||
  lane.source_boundary || lane.target_reconciliation ||
  (Array.isArray(lane.active) && lane.active.length) ||
  (Array.isArray(lane.refusals) && lane.refusals.length) ||
  (Array.isArray(lane.accepted_family_hashes) && lane.accepted_family_hashes.length) ||
  (lane.skipped_by_reason && Object.keys(lane.skipped_by_reason).length) ||
  [
    "pages", "source_messages", "candidate_documents", "candidate_parts",
    "target_documents", "target_chunks", "created", "updated", "unchanged",
    "refused", "failed", "skipped", "legacy_unclassified_source_messages",
    "legacy_pending_source_messages", "legacy_candidate_documents",
    "legacy_target_documents", "legacy_refused", "represented_source_messages",
    "skipped_source_messages", "candidate_source_messages", "reconciled_refused_families",
    "reconciled_accepted_families",
  ].some((key) => Number(lane[key] || 0) > 0)
);

function validateMessageState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("message migration state is invalid");
  if (state.version !== MESSAGE_STATE_VERSION || state.schema !== MESSAGE_STATE_SCHEMA) {
    throw new Error("message migration state schema is unsupported");
  }
  const lane = state.message_sessions;
  if (!lane || typeof lane !== "object" || Array.isArray(lane)) throw new Error("message migration lane is invalid");
  for (const key of [
    "pages", "source_messages", "candidate_documents", "candidate_parts", "target_documents", "target_chunks",
    "created", "updated", "unchanged", "refused", "failed", "skipped",
    "legacy_unclassified_source_messages", "legacy_pending_source_messages",
    "legacy_candidate_documents", "legacy_target_documents", "legacy_refused",
    "represented_source_messages", "skipped_source_messages", "candidate_source_messages",
  ]) nonNegativeInteger(lane[key], key);
  nonNegativeInteger(lane.expected_source_messages, "expected source count", { nullable: true });
  if (typeof lane.complete !== "boolean") throw new Error("message migration completion flag is invalid");
  if (typeof lane.legacy_defaults_applied !== "boolean") throw new Error("message migration compatibility marker is invalid");
  if (!Array.isArray(lane.active) || !Array.isArray(lane.refusals) ||
      !Array.isArray(lane.accepted_family_hashes)) {
    throw new Error("message migration collections are invalid");
  }
  if (lane.accepted_family_hashes.some((value) => !/^[a-f0-9]{64}$/.test(String(value))) ||
      lane.accepted_family_hashes.some((value, index, values) => index > 0 && value <= values[index - 1])) {
    throw new Error("message migration accepted-family identity set is invalid");
  }
  nonNegativeInteger(lane.reconciled_refused_families, "reconciled refusal family count");
  nonNegativeInteger(lane.reconciled_accepted_families, "reconciled accepted family count");
  if (lane.source_boundary !== null && (
    !lane.source_boundary ||
    !Number.isSafeInteger(lane.source_boundary.minimum_source_messages) ||
    lane.source_boundary.minimum_source_messages < 0 ||
    !/^[a-f0-9]{64}$/.test(String(lane.source_boundary.high_water_sha256 || ""))
  )) {
    throw new Error("message migration reviewed source boundary is invalid");
  }
  if (lane.target_reconciliation !== null && (
    !lane.target_reconciliation ||
    !Number.isSafeInteger(lane.target_reconciliation.expected_families) ||
    lane.target_reconciliation.expected_families < 0 ||
    !Number.isSafeInteger(lane.target_reconciliation.removed_extra_families) ||
    lane.target_reconciliation.removed_extra_families < 0 ||
    !/^[a-f0-9]{64}$/.test(String(lane.target_reconciliation.identity_sha256 || ""))
  )) {
    throw new Error("message migration target reconciliation is invalid");
  }
  for (const session of lane.active) {
    if (!session || typeof session !== "object" || Array.isArray(session) ||
        !session.first_id || !session.last_id || !session.thread_id || !session.platform ||
        !Number.isFinite(Date.parse(session.first_ts)) || !Number.isFinite(Date.parse(session.last_ts)) ||
        !Number.isSafeInteger(session.message_count) || session.message_count < 1 ||
        !Array.isArray(session.lines) || session.lines.length !== session.message_count ||
        session.lines.some((line) => typeof line !== "string")) {
      throw new Error("message migration has an invalid pending session");
    }
  }
  if (lane.refusals.length > 1000) throw new Error("message migration refusal ledger is too large");
  if (!lane.skipped_by_reason || typeof lane.skipped_by_reason !== "object" || Array.isArray(lane.skipped_by_reason)) {
    throw new Error("message migration skip accounting is invalid");
  }
  for (const value of Object.values(lane.skipped_by_reason)) nonNegativeInteger(value, "skip reason count");
  for (const marker of [lane.high_water, lane.cursor]) {
    if (marker !== null && (!marker || typeof marker.ts !== "string" || typeof marker.id !== "string")) {
      throw new Error("message migration cursor is invalid");
    }
  }
  if (lane.cursor && !lane.high_water) throw new Error("message migration cursor has no high-water mark");
  if (lane.config_fingerprint !== null && !/^[a-f0-9]{64}$/.test(String(lane.config_fingerprint))) {
    throw new Error("message migration config fingerprint is invalid");
  }
  return state;
}

export function loadMessageState(path, { projectRef, targetUrl } = {}) {
  let state = path ? readProtectedStateJson(path, { label: "message migration checkpoint", allowMissing: true }) : null;
  state ||= {
    version: MESSAGE_STATE_VERSION, schema: MESSAGE_STATE_SCHEMA,
    project_ref: projectRef, target_url: cleanUrl(targetUrl), message_sessions: freshLane(),
  };
  if (state.version === 1) {
    state.version = MESSAGE_STATE_VERSION;
    state.schema = MESSAGE_STATE_SCHEMA;
    state.message_sessions = normalizeLane(state.message_sessions || {}, { legacy: true });
  } else if (state.version === MESSAGE_STATE_VERSION && state.schema === MESSAGE_STATE_SCHEMA) {
    state.message_sessions = normalizeLane(state.message_sessions || {});
  } else {
    throw new Error(`unsupported message migration state version ${state.version}`);
  }
  if (state.project_ref && projectRef && state.project_ref !== projectRef) throw new Error("message state belongs to another Supabase project");
  if (state.target_url && targetUrl && state.target_url !== cleanUrl(targetUrl)) throw new Error("message state belongs to another target brain");
  if (!state.project_ref && projectRef) state.project_ref = projectRef;
  if (!state.target_url && targetUrl) state.target_url = cleanUrl(targetUrl);
  return validateMessageState(state);
}

export function saveMessageState(path, state) {
  validateMessageState(state);
  if (state.message_sessions.complete) {
    if (!state.message_sessions.accounting) throw new Error("message migration completion is not accounting-verified");
    verifyMessageAccounting(state.message_sessions);
  }
  saveProtectedStateJson(path, state, { label: "message migration checkpoint" });
}

export function messageMigrationConfigFingerprint(scope, gateVersion = GATE_VERSION, sourceBoundary = null) {
  return createHash("sha256").update(JSON.stringify({
    algorithm: MESSAGE_ALGORITHM_VERSION,
    eligibility: ELIGIBLE,
    order: "timestamp-id-keyset-v1",
    chat_platforms: MESSAGE_CHAT_PLATFORMS,
    sessionizer: MESSAGE_SESSION_DEFAULTS,
    split_max_chars: MAX_DOC_CHARS,
    credential_gate_version: gateVersion,
    scope,
    source_boundary: sourceBoundary,
  })).digest("hex");
}

export function messageHighWaterSha256(marker) {
  const canonical = marker === null ? null : {
    ts: new Date(String(marker?.ts || "")).toISOString(),
    id: String(marker?.id || ""),
  };
  if (canonical && !canonical.id) throw new Error("message migration high-water identity is invalid");
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const normalizeSourceBoundary = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message migration needs a reviewed minimum source count and high-water hash");
  }
  const minimum = Number(value.minimum_source_messages);
  const highWaterSha256 = String(value.high_water_sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(minimum) || minimum < 0 || !/^[a-f0-9]{64}$/.test(highWaterSha256)) {
    throw new Error("message migration reviewed source boundary is invalid");
  }
  return { minimum_source_messages: minimum, high_water_sha256: highWaterSha256 };
};

const messageFamilyUid = (sourceId) => `message:${String(sourceId || "")}`;
const familyIdentityHash = (familyUid) => createHash("sha256").update(String(familyUid)).digest("hex");
const identitySetSha256 = (hashes) => createHash("sha256")
  .update(JSON.stringify([...new Set(hashes)].sort()))
  .digest("hex");

const itemize = (envelopes) => envelopes.flatMap((envelope) =>
  splitOversized(envelope).map((part) => ({
    envelope: part,
    family_uid: messageFamilyUid(envelope.source_id),
  }))
);

const emptyTally = () => ({
  candidate_documents: 0, candidate_parts: 0, candidate_source_messages: 0,
  target_documents: 0, target_chunks: 0,
  created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0,
  accepted_family_hashes: [], refused_family_hashes: [],
  reconciled_refused_families: 0, reconciled_accepted_families: 0,
  refusals: [],
});

const transientTargetError = (value) => /(?:network connection lost|timed? ?out|fetch failed|connection reset|econnreset|eai_again|temporar(?:y|ily)|overloaded|returned (?:429|5\d\d))/i.test(String(value || ""));

export async function sendMessageEnvelopes(envelopes, postFn, {
  reconcileFn,
  attempts = 3,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  if (typeof postFn !== "function" || typeof reconcileFn !== "function") {
    throw new Error("message target ingest and exact family reconciliation are required");
  }
  const tally = emptyTally();
  tally.candidate_documents = envelopes.length;
  tally.candidate_source_messages = envelopes.reduce((total, envelope) =>
    total + nonNegativeInteger(Number(envelope?.metadata?.message_count || 1), "candidate source count"), 0
  );
  const families = new Map();
  const safeItems = [];
  for (const rawEnvelope of envelopes) {
    const envelope = sanitizeEnvelope(rawEnvelope);
    const familyUid = messageFamilyUid(envelope.source_id);
    if (!envelope.source_id || families.has(familyUid)) {
      throw new Error("message migration produced a missing or repeated family identity");
    }
    const scan = scanSecrets(envelope);
    if (scan.shouldRefuse) {
      tally.candidate_parts++;
      families.set(familyUid, {
        familyUid, sourceId: envelope.source_id, parts: [], outcomes: [],
        refused: true, labels: [...new Set(scan.labels || [])],
      });
    } else {
      const parts = itemize([envelope]);
      tally.candidate_parts += parts.length;
      families.set(familyUid, {
        familyUid, sourceId: envelope.source_id, parts, outcomes: [], refused: false, labels: [],
      });
      safeItems.push(...parts);
    }
  }
  for (const group of batches(safeItems)) {
    let receipt;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        receipt = await postFn(group);
        assertTargetReceiptIdentity(group, receipt);
      } catch (error) {
        if (attempt >= attempts || !transientTargetError(error?.message || error)) throw error;
        await sleep(delayMs * attempt);
        continue;
      }
      const transientFailures = receipt?.results?.filter((slot) =>
        slot?.status === "failed" && transientTargetError(slot?.error)
      ) || [];
      if (!transientFailures.length || attempt >= attempts) break;
      // Batch ingest is idempotent. Replaying the whole group is safer than
      // trying to manufacture a partial receipt after D1 accepted some rows.
      await sleep(delayMs * attempt);
    }
    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      const slot = receipt.results[i];
      const status = slot?.status;
      const family = families.get(item.family_uid);
      if (!family) throw new Error("message target receipt has no logical family");
      if (["created", "updated", "unchanged"].includes(status)) {
        const chunks = Number(slot.chunks || 0);
        if (!Number.isSafeInteger(chunks) || chunks < 0) {
          throw new Error(`message target receipt has an invalid chunk count at slot ${i + 1}`);
        }
        family.outcomes.push({ status, chunks });
      } else if (status === "refused") {
        family.refused = true;
        family.labels.push(...(slot.labels || []));
      } else {
        tally.failed++;
        throw new Error(`message target rejected receipt slot ${i + 1}`);
      }
    }
  }

  for (const family of families.values()) {
    if (!family.refused && family.outcomes.length !== family.parts.length) {
      throw new Error("message target receipt did not settle every family part");
    }
  }

  const plans = [...families.values()].map((family) => ({
    base_doc_uid: family.familyUid,
    keep_doc_uids: family.refused
      ? []
      : family.parts.map((item) => messageFamilyUid(item.envelope.source_id)),
  }));
  if (plans.length) {
    let reconciliation;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        reconciliation = await reconcileFn(plans);
      } catch (error) {
        if (attempt >= attempts || !transientTargetError(error?.message || error)) throw error;
        await sleep(delayMs * attempt);
        continue;
      }
      break;
    }
    if (reconciliation?.families !== plans.length) {
      throw new Error("message target family cleanup was not exactly confirmed");
    }
    tally.reconciled_refused_families = plans.filter((plan) => !plan.keep_doc_uids.length).length;
    tally.reconciled_accepted_families = plans.length - tally.reconciled_refused_families;
  }

  for (const family of families.values()) {
    const identityHash = familyIdentityHash(family.familyUid);
    if (family.refused) {
      tally.refused += Math.max(1, family.parts.length);
      tally.refused_family_hashes.push(identityHash);
      if (tally.refusals.length < 1000) tally.refusals.push({
        source_id: family.sourceId,
        labels: [...new Set(family.labels)],
      });
      continue;
    }
    for (const outcome of family.outcomes) {
      tally[outcome.status]++;
      tally.target_documents++;
      tally.target_chunks += outcome.chunks;
    }
    tally.accepted_family_hashes.push(identityHash);
  }
  return tally;
}

const mergeTally = (lane, tally) => {
  for (const key of [
    "candidate_documents", "candidate_parts", "candidate_source_messages",
    "target_documents", "target_chunks", "created", "updated", "unchanged", "refused", "failed",
    "reconciled_refused_families", "reconciled_accepted_families",
  ]) {
    lane[key] += Number(tally[key] || 0);
  }
  const accepted = new Set(lane.accepted_family_hashes || []);
  for (const hash of tally.refused_family_hashes || []) accepted.delete(hash);
  for (const hash of tally.accepted_family_hashes || []) accepted.add(hash);
  lane.accepted_family_hashes = [...accepted].sort();
  lane.target_reconciliation = null;
  if (tally.refusals?.length) {
    lane.refusals.push(...tally.refusals);
    if (lane.refusals.length > 1000) lane.refusals.splice(0, lane.refusals.length - 1000);
  }
};

const parseExpectedCount = (value) => {
  if (!/^\d+$/.test(String(value ?? ""))) throw new Error("message migration source count is invalid");
  return nonNegativeInteger(Number(value), "expected source count");
};

const markerCompare = (left, right) => {
  const leftTime = Date.parse(left?.ts);
  const rightTime = Date.parse(right?.ts);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new Error("message migration marker timestamp is invalid");
  }
  const time = leftTime - rightTime;
  if (time) return time;
  const a = String(left?.id || "");
  const b = String(right?.id || "");
  return a < b ? -1 : a > b ? 1 : 0;
};

const assertMessagePage = (rows, cursor, highWater, limit) => {
  if (!Array.isArray(rows)) throw new Error("message source page is not an array");
  if (rows.length > limit) throw new Error("message source page exceeded its requested limit");
  let prior = cursor;
  for (let index = 0; index < rows.length; index++) {
    const marker = { ts: rows[index]?.ts, id: rows[index]?.id };
    if (!marker.id || !Number.isFinite(Date.parse(marker.ts))) {
      throw new Error(`message source page has an invalid cursor at row ${index + 1}`);
    }
    if (prior && markerCompare(marker, prior) <= 0) {
      throw new Error(`message source page is not strictly ordered at row ${index + 1}`);
    }
    if (markerCompare(marker, highWater) > 0) {
      throw new Error(`message source page crossed the fixed high-water mark at row ${index + 1}`);
    }
    prior = marker;
  }
};

async function verifyReviewedSourceBoundary({ queryFn, scope, boundary, lane }) {
  // The first invocation binds to the reviewed latest row. A resume instead
  // re-reads only the frozen prefix, proving that its saved terminal row still
  // exists and that no earlier eligible row disappeared. Newer messages are
  // deliberately outside this run and cannot strand a long replay.
  const rows = await queryFn(lane.high_water
    ? messageFrozenBoundarySql(lane.high_water, scope)
    : messageHighWaterSql(scope));
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("message migration reviewed source boundary query returned an invalid shape");
  }
  const high = rows[0] || null;
  let marker = null;
  let eligibleRows = 0;
  if (high) {
    if (!high.ts || !high.id || !Number.isFinite(Date.parse(high.ts))) {
      throw new Error("message migration source high-water mark is invalid");
    }
    marker = { ts: high.ts, id: String(high.id) };
    eligibleRows = parseExpectedCount(high.eligible_rows);
    if (eligibleRows < 1) throw new Error("message migration source boundary count is inconsistent");
  }
  if (messageHighWaterSha256(marker) !== boundary.high_water_sha256) {
    throw new Error("message migration source high-water continuity check failed");
  }
  if (eligibleRows < boundary.minimum_source_messages) {
    throw new Error(
      `message migration source count is below the reviewed minimum (${eligibleRows} < ${boundary.minimum_source_messages})`
    );
  }
  if (lane.high_water && (!marker || markerCompare(lane.high_water, marker) !== 0)) {
    throw new Error("message migration source high-water changed after the checkpoint started");
  }
  if (lane.expected_source_messages !== null && lane.expected_source_messages !== eligibleRows) {
    throw new Error("message migration source count changed after the checkpoint started");
  }
  return { marker, eligibleRows };
}

export function verifyMessageAccounting(lane) {
  const expected = nonNegativeInteger(lane.expected_source_messages, "expected source count");
  if (lane.source_messages !== expected) {
    throw new Error(`message migration accounting mismatch: processed ${lane.source_messages} of ${expected} eligible rows`);
  }
  const classified = lane.legacy_unclassified_source_messages +
    lane.represented_source_messages + lane.skipped_source_messages;
  if (classified !== lane.source_messages) {
    throw new Error("message migration accounting mismatch: source classifications do not balance");
  }
  const skipReasons = Object.values(lane.skipped_by_reason)
    .reduce((total, value) => total + nonNegativeInteger(value, "skip reason count"), 0);
  if (skipReasons !== lane.skipped_source_messages) {
    throw new Error("message migration accounting mismatch: skip reasons do not balance");
  }
  const representedCandidates = lane.represented_source_messages + lane.legacy_pending_source_messages;
  if (lane.candidate_source_messages !== representedCandidates) {
    throw new Error("message migration accounting mismatch: represented rows do not balance with candidate documents");
  }
  const acceptedAfterUpgrade = lane.target_documents - lane.legacy_target_documents;
  const refusedAfterUpgrade = lane.refused - lane.legacy_refused;
  if (acceptedAfterUpgrade < 0 || refusedAfterUpgrade < 0 ||
      lane.candidate_parts !== acceptedAfterUpgrade + refusedAfterUpgrade) {
    throw new Error("message migration accounting mismatch: target receipt slots do not balance");
  }
  if (lane.created + lane.updated + lane.unchanged !== lane.target_documents) {
    throw new Error("message migration accounting mismatch: target statuses do not balance");
  }
  if (lane.failed !== 0) throw new Error("message migration cannot complete with failed target documents");
  if (lane.active.length) throw new Error("message migration cannot complete with pending sessions");
  if (expected > 0 && markerCompare(lane.cursor, lane.high_water) !== 0) {
    throw new Error("message migration cannot complete before reaching the fixed high-water mark");
  }
  const acceptedFamilyHashes = [...new Set(lane.accepted_family_hashes || [])].sort();
  if (lane.reconciled_accepted_families !== acceptedFamilyHashes.length) {
    throw new Error("message migration accepted-family cleanup accounting does not balance");
  }
  if (!lane.target_reconciliation ||
      lane.target_reconciliation.expected_families !== acceptedFamilyHashes.length ||
      lane.target_reconciliation.identity_sha256 !== identitySetSha256(acceptedFamilyHashes)) {
    throw new Error("message migration cannot complete without exact target-family reconciliation");
  }
  return {
    expected_source_messages: expected,
    processed_source_messages: lane.source_messages,
    represented_source_messages: lane.represented_source_messages,
    skipped_source_messages: lane.skipped_source_messages,
    legacy_unclassified_source_messages: lane.legacy_unclassified_source_messages,
    candidate_source_messages: lane.candidate_source_messages,
    candidate_parts: lane.candidate_parts,
    accepted_parts_after_upgrade: acceptedAfterUpgrade,
    refused_parts_after_upgrade: refusedAfterUpgrade,
    accepted_families: acceptedFamilyHashes.length,
    reconciled_refused_families: lane.reconciled_refused_families,
    reconciled_accepted_families: lane.reconciled_accepted_families,
  };
}

function verifySavedCompletionAccounting(lane, { receiptRecorded = false } = {}) {
  if (!lane?.complete || !lane?.accounting) {
    throw new Error("message migration saved completion accounting is missing");
  }
  const verified = verifyMessageAccounting(lane);
  if (JSON.stringify(lane.accounting) !== JSON.stringify(verified)) {
    throw new Error("message migration saved completion accounting does not match its counters");
  }
  if (receiptRecorded) {
    const readback = lane.target_readback;
    const readiness = readback?.vector_readiness;
    if (!Number.isFinite(Date.parse(String(lane.receipt_recorded_at || ""))) ||
        !readback || readback.backend !== "d1" || readback.vector_backlog !== 0 ||
        readiness?.ready !== true || readiness.pending !== 0 || readiness.submitted !== 0 ||
        !Number.isSafeInteger(readiness.expected_vectors) || readiness.expected_vectors < 0 ||
        readiness.actual_vectors !== readiness.expected_vectors ||
        readback.stored_documents !== lane.target_documents ||
        readback.logical_documents !== lane.accepted_family_hashes.length ||
        !Number.isFinite(Date.parse(String(readback.verified_at || "")))) {
      throw new Error("message migration recorded completion is not retrieval-ready");
    }
  }
  return verified;
}

export function messageCompletionReceipt(lane, completedAt = new Date().toISOString()) {
  if (!lane?.complete || !lane?.accounting) throw new Error("message migration is not accounting-verified complete");
  const readiness = lane?.target_readback?.vector_readiness;
  if (!lane?.target_readback || lane.target_readback.vector_backlog !== 0 ||
      readiness?.ready !== true || readiness.pending !== 0 || readiness.submitted !== 0 ||
      !Number.isSafeInteger(readiness.expected_vectors) || readiness.expected_vectors < 0 ||
      readiness.actual_vectors !== readiness.expected_vectors) {
    throw new Error("message migration target readback is not retrieval-ready");
  }
  if (!/^[a-f0-9]{64}$/.test(String(lane.config_fingerprint || ""))) {
    throw new Error("message migration has no valid configuration identity");
  }
  const at = new Date(completedAt);
  if (!Number.isFinite(at.getTime())) throw new Error("message migration completion time is invalid");
  const accounting = verifyMessageAccounting(lane);
  const runId = `migration-${createHash("sha256").update(JSON.stringify({
    config_fingerprint: lane.config_fingerprint,
    high_water: lane.high_water,
  })).digest("hex").slice(0, 32)}`;
  return {
    source: "message",
    kind: "upload",
    status: "ready",
    run_id: runId,
    lane: "manual",
    completed_at: at.toISOString(),
    complete_sweep: true,
    detail: [
      "Message migration complete",
      `expected=${accounting.expected_source_messages}`,
      `represented=${accounting.represented_source_messages}`,
      `skipped=${accounting.skipped_source_messages}`,
      `legacy_unclassified=${accounting.legacy_unclassified_source_messages}`,
      `accepted_parts=${accounting.accepted_parts_after_upgrade}`,
      `refused_parts=${accounting.refused_parts_after_upgrade}`,
      `families=${accounting.accepted_families}`,
      `refusal_deletions=${accounting.reconciled_refused_families}`,
      `accepted_family_reconciliations=${accounting.reconciled_accepted_families}`,
    ].join("; "),
  };
}

export function verifyMessageTargetInventory(lane, inventory) {
  if (!lane?.complete || !lane?.accounting) {
    throw new Error("message migration must complete accounting before target readback");
  }
  verifyMessageAccounting(lane);
  if (inventory?.backend !== "d1" || !Array.isArray(inventory?.rows)) {
    throw new Error("message migration target readback is not the expected D1 backend");
  }
  const pending = Number(inventory?.vector_backlog?.pending);
  if (!Number.isSafeInteger(pending) || pending < 0) {
    throw new Error("message migration target readback has no valid vector backlog");
  }
  if (pending > 0) {
    throw new Error(`message migration data is durable but ${pending} vector operations are still pending`);
  }
  const readiness = inventory?.vector_readiness;
  const readinessPending = Number(readiness?.pending);
  const submitted = Number(readiness?.submitted);
  const expectedVectors = Number(readiness?.expected_vectors);
  const actualVectors = Number(readiness?.actual_vectors);
  if (!readiness || !Number.isSafeInteger(readinessPending) || readinessPending < 0 ||
      !Number.isSafeInteger(submitted) || submitted < 0 ||
      !Number.isSafeInteger(expectedVectors) || expectedVectors < 0 ||
      !Number.isSafeInteger(actualVectors) || actualVectors < 0) {
    throw new Error("message migration target readback has no valid exact vector readiness");
  }
  if (readinessPending !== pending) {
    throw new Error("message migration target readback vector backlog and readiness disagree");
  }
  if (readiness.ready !== true || readinessPending !== 0 || submitted !== 0 ||
      actualVectors !== expectedVectors) {
    const reason = typeof readiness.reason === "string" && readiness.reason
      ? ` (${readiness.reason})`
      : "";
    const action = typeof readiness.action === "string" && readiness.action
      ? `; ${readiness.action}`
      : "; run brain drain, then brain diagnose if visibility does not converge";
    throw new Error(`message migration vector index is not query-ready${reason}${action}`);
  }
  const messageRow = inventory.rows.find((row) => row?.source_type === "message");
  if (messageRow && messageRow.document_counts_exact !== true) {
    throw new Error("message migration target readback is not based on exact live document counts");
  }
  if (!messageRow && (lane.target_documents !== 0 || lane.accepted_family_hashes.length !== 0)) {
    throw new Error("message migration target readback is missing the message source");
  }
  const stored = messageRow ? Number(messageRow.stored_documents) : 0;
  const logical = messageRow ? Number(messageRow.logical_documents ?? messageRow.documents) : 0;
  if (!Number.isSafeInteger(stored) || stored < 0) {
    throw new Error("message migration target readback has no valid stored-document count");
  }
  if (stored !== lane.target_documents) {
    throw new Error("message migration target readback does not exactly match accepted physical documents");
  }
  if (!Number.isSafeInteger(logical) || logical !== lane.accepted_family_hashes.length) {
    throw new Error("message migration target readback does not exactly match reconciled logical families");
  }
  return {
    backend: "d1",
    stored_documents: stored,
    logical_documents: logical,
    vector_backlog: 0,
    vector_readiness: {
      ready: true,
      pending: 0,
      submitted: 0,
      expected_vectors: expectedVectors,
      actual_vectors: actualVectors,
    },
    verified_at: new Date().toISOString(),
  };
}

export async function reconcileMessageTargetFamilies(lane, { listFn, deleteFn } = {}) {
  if (typeof listFn !== "function" || typeof deleteFn !== "function") {
    throw new Error("message target exact family reconciliation is required");
  }
  if (lane?.scope?.from || lane?.scope?.to) {
    throw new Error("exact message target reconciliation requires an all-time source scope");
  }
  const expected = [...new Set(lane?.accepted_family_hashes || [])].sort();
  const inspect = async () => {
    const families = await listFn();
    if (!Array.isArray(families)) throw new Error("message target family inventory is not an array");
    const byHash = new Map();
    let previous = "";
    for (const family of families) {
      if (typeof family !== "string" || !family.startsWith("message:") || family <= previous) {
        throw new Error("message target family inventory has an invalid identity order");
      }
      const hash = familyIdentityHash(family);
      if (byHash.has(hash)) throw new Error("message target family inventory has an identity collision");
      byHash.set(hash, family);
      previous = family;
    }
    return byHash;
  };

  let actual = await inspect();
  const expectedSet = new Set(expected);
  const missing = expected.filter((hash) => !actual.has(hash));
  if (missing.length) {
    throw new Error(`message target reconciliation is missing ${missing.length} expected families`);
  }
  const extras = [...actual.entries()]
    .filter(([hash]) => !expectedSet.has(hash))
    .map(([, family]) => family);
  if (extras.length) {
    const deletion = await deleteFn(extras);
    if (deletion?.families !== extras.length) {
      throw new Error("message target reconciliation extra-family deletion was not exactly confirmed");
    }
    actual = await inspect();
  }
  const finalHashes = [...actual.keys()].sort();
  if (JSON.stringify(finalHashes) !== JSON.stringify(expected)) {
    throw new Error("message target reconciliation did not converge to the exact expected identity set");
  }
  return {
    expected_families: expected.length,
    removed_extra_families: extras.length,
    identity_sha256: identitySetSha256(expected),
    verified_at: new Date().toISOString(),
  };
}

export async function runMessageMigration({
  state,
  queryFn,
  postFn,
  reconcileFn,
  listTargetFamiliesFn,
  saveFn = () => {},
  ownerLabel,
  groupingTimezone,
  sourceBoundary,
  pageSize = 1000,
  maxRows = Infinity,
  dryRun = false,
  from,
  to,
} = {}) {
  if (!state || typeof state !== "object") throw new Error("message migration state is required");
  if (typeof queryFn !== "function") throw new Error("message migration source query function is required");
  if (!dryRun && typeof postFn !== "function") throw new Error("message migration target function is required");

  // A dry run can inspect a durable checkpoint, but it must not alter that
  // object in memory. Callers commonly reuse it for the real run.
  const workingState = dryRun ? structuredClone(state) : state;
  const lane = normalizeLane(workingState.message_sessions ||= freshLane());
  if (!lane.config_fingerprint && hasUnfingerprintedProgress(lane)) {
    throw new Error(
      "progressed legacy message migration has no content-safety identity; archive the checkpoint, reset, and reconcile the lane"
    );
  }
  let boundaryChanged = false;
  let scope;
  if (lane.scope) {
    const saved = {
      ...lane.scope,
      owner_label: String(lane.scope.owner_label || "Owner").trim(),
      grouping_timezone: lane.scope.grouping_timezone || "UTC",
    };
    try {
      saved.grouping_timezone = new Intl.DateTimeFormat("en", {
        timeZone: saved.grouping_timezone,
      }).resolvedOptions().timeZone;
    } catch {
      throw new Error("saved message migration grouping timezone is invalid");
    }
    if (JSON.stringify(saved) !== JSON.stringify(lane.scope)) {
      lane.scope = saved;
      lane.legacy_defaults_applied = true;
      boundaryChanged = true;
    }
    const requestedOwner = ownerLabel === undefined ? saved.owner_label : String(ownerLabel || "").trim();
    let requestedTimezone = saved.grouping_timezone;
    if (groupingTimezone !== undefined) {
      try {
        requestedTimezone = new Intl.DateTimeFormat("en", {
          timeZone: groupingTimezone,
        }).resolvedOptions().timeZone;
      } catch {
        throw new Error("--timezone must be a valid IANA timezone");
      }
    }
    scope = {
      from: from === undefined ? saved.from : bound(from, "--from"),
      to: to === undefined ? saved.to : bound(to, "--to"),
      owner_label: requestedOwner,
      grouping_timezone: requestedTimezone,
    };
  } else {
    const requestedOwner = String(ownerLabel || (lane.legacy_defaults_applied ? "Owner" : "")).trim();
    const requestedTimezone = groupingTimezone || (lane.legacy_defaults_applied ? "UTC" : null);
    if (!requestedOwner) throw new Error("--owner-label is required when starting a message migration");
    if (!requestedTimezone) throw new Error("--timezone is required when starting a message migration");
    let canonicalTimezone;
    try {
      canonicalTimezone = new Intl.DateTimeFormat("en", {
        timeZone: requestedTimezone,
      }).resolvedOptions().timeZone;
    } catch {
      throw new Error("--timezone must be a valid IANA timezone");
    }
    scope = {
      from: bound(from, "--from"),
      to: bound(to, "--to"),
      owner_label: requestedOwner,
      grouping_timezone: canonicalTimezone,
    };
  }
  if (scope.from && scope.to && Date.parse(scope.from) > Date.parse(scope.to)) throw new Error("--from must be before --to");
  if (lane.scope && JSON.stringify(lane.scope) !== JSON.stringify(scope)) {
    throw new Error("message migration date bounds, owner label, or timezone changed; use the saved values or reset and reconcile the lane");
  }
  if (!lane.scope) {
    if (lane.source_messages > 0 && (scope.from || scope.to)) {
      throw new Error("date bounds cannot be added to an in-progress unbounded message migration");
    }
    lane.scope = scope;
    boundaryChanged = true;
  }

  const requestedBoundary = sourceBoundary === undefined
    ? lane.source_boundary
    : normalizeSourceBoundary(sourceBoundary);
  if (!requestedBoundary) {
    throw new Error("message migration needs a reviewed minimum source count and high-water hash");
  }
  if (lane.source_boundary && JSON.stringify(lane.source_boundary) !== JSON.stringify(requestedBoundary)) {
    throw new Error("message migration reviewed source boundary changed; reset and reconcile the lane");
  }
  if (!lane.source_boundary) {
    lane.source_boundary = requestedBoundary;
    boundaryChanged = true;
  }

  const fingerprint = messageMigrationConfigFingerprint(lane.scope, GATE_VERSION, lane.source_boundary);
  if (lane.config_fingerprint && lane.config_fingerprint !== fingerprint) {
    throw new Error(
      "message migration configuration changed after the lane started; archive the checkpoint, reset, and reconcile the lane"
    );
  }
  if (!lane.config_fingerprint) {
    lane.config_fingerprint = fingerprint;
    boundaryChanged = true;
  }

  // A recorded source receipt seals this finite high-water replay. Re-entering
  // exact reconciliation later could mistake documents from a newer delta run
  // for extras and delete them. Validate the saved proof, then return without
  // a source query, target inventory call, write, deletion, or checkpoint save.
  if (lane.receipt_recorded_at) {
    verifySavedCompletionAccounting(lane, { receiptRecorded: true });
    return {
      status: dryRun ? "dry_run" : "complete",
      run_rows: 0,
      run_pages: 0,
      sealed_noop: true,
      ...lane,
    };
  }

  // This source-only check runs on every invocation and before any target
  // mutation. It prevents an empty, truncated, or replaced project from using
  // old target rows as evidence that the replay succeeded.
  const reviewedBoundary = await verifyReviewedSourceBoundary({
    queryFn,
    scope: lane.scope,
    boundary: lane.source_boundary,
    lane,
  });
  if (!dryRun && (typeof reconcileFn !== "function" || typeof listTargetFamiliesFn !== "function")) {
    throw new Error("message migration exact target deletion and inventory functions are required");
  }
  const deleteFamiliesFn = dryRun ? null : (families) => reconcileFn(
    families.map((base_doc_uid) => ({ base_doc_uid, keep_doc_uids: [] })),
  );
  if (!lane.high_water && reviewedBoundary.marker) {
    lane.high_water = reviewedBoundary.marker;
    boundaryChanged = true;
  }
  if (lane.expected_source_messages === null) {
    lane.expected_source_messages = reviewedBoundary.eligibleRows;
    boundaryChanged = true;
  }
  if (boundaryChanged && !dryRun) saveFn(workingState);

  if (lane.complete) {
    // Crash recovery may resume after complete=true but before target readback
    // and receipt persistence. Prove the saved accounting before a target
    // listing or exact-reconciliation deletion can occur.
    verifySavedCompletionAccounting(lane);
    if (!dryRun) {
      lane.target_reconciliation = await reconcileMessageTargetFamilies(lane, {
        listFn: listTargetFamiliesFn,
        deleteFn: deleteFamiliesFn,
      });
      // A process can save `complete` and crash before target readback or the
      // source receipt. Reconciliation on that recovery run is another target
      // mutation window, so repeat the frozen-prefix proof before returning a
      // completion result.
      await verifyReviewedSourceBoundary({
        queryFn,
        scope: lane.scope,
        boundary: lane.source_boundary,
        lane,
      });
    }
    lane.accounting = verifyMessageAccounting(lane);
    if (!lane.accounting_verified_at) {
      lane.accounting_verified_at = new Date().toISOString();
    }
    if (!dryRun) saveFn(workingState);
    return { status: "complete", run_rows: 0, run_pages: 0, ...lane };
  }

  if (lane.expected_source_messages === 0) {
    if (dryRun) return { status: "dry_run", run_rows: 0, run_pages: 0, ...lane };
    lane.target_reconciliation = await reconcileMessageTargetFamilies(lane, {
      listFn: listTargetFamiliesFn,
      deleteFn: deleteFamiliesFn,
    });
    lane.accounting = verifyMessageAccounting(lane);
    // Recheck the frozen source prefix after target writes and immediately
    // before certifying completion. A late backfill can sort behind the saved
    // cursor; without this second read, the first snapshot count could remain
    // balanced while a newly eligible historical row was silently omitted.
    await verifyReviewedSourceBoundary({
      queryFn,
      scope: lane.scope,
      boundary: lane.source_boundary,
      lane,
    });
    lane.accounting_verified_at = new Date().toISOString();
    lane.completed_at ||= lane.accounting_verified_at;
    lane.complete = true;
    lane.last_checkpoint_at = new Date().toISOString();
    saveFn(workingState);
    return { status: "complete", run_rows: 0, run_pages: 0, ...lane };
  }

  const sessionizer = new MessageSessionizer({
    ownerLabel: lane.scope.owner_label,
    groupingTimezone: lane.scope.grouping_timezone,
    active: lane.active || [],
  });
  let cursor = lane.cursor;
  let runRows = 0;
  let runPages = 0;
  let dryDocuments = 0;
  let dryParts = 0;
  const preview = [];

  while (runRows < maxRows) {
    const remaining = Number.isFinite(maxRows) ? Math.max(1, Math.min(pageSize, maxRows - runRows)) : pageSize;
    const rows = await queryFn(messagePageSql(cursor, lane.high_water, remaining, scope));
    assertMessagePage(rows, cursor, lane.high_water, remaining);
    if (!rows.length) {
      const finalEnvelopes = sessionizer.finish();
      if (dryRun) {
        dryDocuments += finalEnvelopes.length;
        dryParts += itemize(finalEnvelopes).length;
      } else {
        if (lane.source_messages !== lane.expected_source_messages) {
          throw new Error(`message migration accounting mismatch: processed ${lane.source_messages} of ${lane.expected_source_messages} eligible rows`);
        }
        mergeTally(lane, await sendMessageEnvelopes(finalEnvelopes, postFn, { reconcileFn }));
        lane.active = [];
        lane.target_reconciliation = await reconcileMessageTargetFamilies(lane, {
          listFn: listTargetFamiliesFn,
          deleteFn: deleteFamiliesFn,
        });
        lane.accounting = verifyMessageAccounting(lane);
        // See the empty-source completion branch above. This closes the same
        // backfill race for a non-empty replay after its final target writes.
        await verifyReviewedSourceBoundary({
          queryFn,
          scope: lane.scope,
          boundary: lane.source_boundary,
          lane,
        });
        lane.accounting_verified_at = new Date().toISOString();
        lane.completed_at ||= lane.accounting_verified_at;
        lane.complete = true;
        lane.last_checkpoint_at = new Date().toISOString();
        saveFn(workingState);
      }
      break;
    }

    const envelopes = [];
    let represented = 0;
    let skipped = 0;
    const skippedByReason = {};
    for (const row of rows) {
      const disposition = messageRowDisposition(row);
      if (disposition === "represented") represented++;
      else {
        skipped++;
        skippedByReason[disposition] = (skippedByReason[disposition] || 0) + 1;
      }
      envelopes.push(...sessionizer.push(row));
    }

    if (dryRun) {
      dryDocuments += envelopes.length;
      dryParts += itemize(envelopes).length;
      for (const envelope of envelopes) if (preview.length < 5) preview.push({
        source_id: envelope.source_id,
        title: envelope.title,
        platform: envelope.metadata?.platform,
        messages: envelope.metadata?.message_count || 1,
        chars: envelope.content.length,
      });
    } else {
      const tally = await sendMessageEnvelopes(envelopes, postFn, { reconcileFn });
      mergeTally(lane, tally);
      lane.cursor = { ts: rows.at(-1).ts, id: rows.at(-1).id };
      lane.active = sessionizer.snapshot();
      lane.pages++;
      lane.source_messages += rows.length;
      lane.represented_source_messages += represented;
      lane.skipped_source_messages += skipped;
      lane.skipped += skipped;
      for (const [reason, count] of Object.entries(skippedByReason)) {
        lane.skipped_by_reason[reason] = (lane.skipped_by_reason[reason] || 0) + count;
      }
      lane.accounting = null;
      lane.accounting_verified_at = null;
      lane.last_checkpoint_at = new Date().toISOString();
      saveFn(workingState);
    }

    cursor = { ts: rows.at(-1).ts, id: rows.at(-1).id };

    runRows += rows.length;
    runPages++;
    if (rows.length < remaining) continue;
  }

  return {
    status: dryRun ? "dry_run" : lane.complete ? "complete" : "checkpointed",
    run_rows: runRows,
    run_pages: runPages,
    would_create_documents: dryRun ? dryDocuments : undefined,
    would_create_parts: dryRun ? dryParts : undefined,
    preview: dryRun ? preview : undefined,
    ...lane,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (["dry-run", "reset"].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

const refusalLabelCounts = (refusals) => {
  const counts = {};
  for (const refusal of refusals || []) {
    for (const label of refusal?.labels || []) counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
};

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const projectRef = flags["project-ref"] || process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const targetUrl = flags.target || process.env.BRAIN_URL;
  const adminKey = process.env.ADMIN_KEY;
  const dryRun = !!flags["dry-run"];
  if (!projectRef) throw new Error("pass --project-ref or set SUPABASE_PROJECT_REF");
  if (!accessToken) throw new Error("set SUPABASE_ACCESS_TOKEN; it is read at runtime and never stored");
  if (!dryRun && !targetUrl) throw new Error("pass --target or set BRAIN_URL");
  if (!dryRun && !adminKey) throw new Error("set ADMIN_KEY for the isolated target brain");
  if (!/^\d+$/.test(String(flags["minimum-source-messages"] ?? "")) ||
      !/^[a-f0-9]{64}$/i.test(String(flags["expected-high-water-sha256"] || ""))) {
    throw new Error("pass --minimum-source-messages and --expected-high-water-sha256 from reviewed source evidence");
  }
  const minimumSourceMessages = Number(flags["minimum-source-messages"]);
  if (!Number.isSafeInteger(minimumSourceMessages)) {
    throw new Error("--minimum-source-messages is outside the safe integer range");
  }

  const statePath = resolve(flags.state || ".brain-migration-message-sessions.json");
  if (flags.reset && existsSync(statePath)) throw new Error("--reset requires removing or archiving the existing state file deliberately");
  const state = loadMessageState(statePath, { projectRef, targetUrl });
  const queryFn = (sql) => querySupabase({ projectRef, accessToken, sql });
  const result = await runMessageMigration({
    state,
    queryFn,
    postFn: (items) => postTargetBatch({ targetUrl, adminKey, items }),
    reconcileFn: (plans) => reconcileTargetFamilies({
      targetUrl, adminKey, source: "message", plans,
    }),
    listTargetFamiliesFn: () => listTargetSourceFamilies({
      targetUrl, adminKey, source: "message",
    }),
    saveFn: (next) => saveMessageState(statePath, next),
    ownerLabel: flags["owner-label"],
    groupingTimezone: flags.timezone,
    sourceBoundary: {
      minimum_source_messages: minimumSourceMessages,
      high_water_sha256: String(flags["expected-high-water-sha256"]).toLowerCase(),
    },
    pageSize: positiveInt(flags["page-size"], 1000, 5000),
    maxRows: flags["max-rows"] ? positiveInt(flags["max-rows"], 10000) : dryRun ? 10000 : Infinity,
    dryRun,
    from: flags.from,
    to: flags.to,
  });
  let sourceReceipt = null;
  if (!dryRun && result.status === "complete" && !state.message_sessions.receipt_recorded_at) {
    state.message_sessions.target_readback = verifyMessageTargetInventory(
      state.message_sessions,
      await getTargetInventory({ targetUrl, adminKey }),
    );
    saveMessageState(statePath, state);
    const completedAt = state.message_sessions.completed_at || new Date().toISOString();
    sourceReceipt = await postSourceReceipt({
      targetUrl,
      adminKey,
      receipt: messageCompletionReceipt(state.message_sessions, completedAt),
    });
    state.message_sessions.receipt_recorded_at = new Date().toISOString();
    saveMessageState(statePath, state);
  }
  console.log(JSON.stringify({
    status: result.status,
    run_rows: result.run_rows,
    run_pages: result.run_pages,
    expected_source_messages: result.expected_source_messages,
    processed_source_messages: result.source_messages,
    represented_source_messages: result.represented_source_messages,
    skipped_source_messages: result.skipped_source_messages,
    skipped_by_reason: result.skipped_by_reason,
    candidate_documents: result.candidate_documents,
    candidate_parts: result.candidate_parts,
    accepted_parts: result.target_documents,
    refused_parts: result.refused,
    failed_parts: result.failed,
    accepted_families: result.accepted_family_hashes?.length || 0,
    reconciled_refused_families: result.reconciled_refused_families || 0,
    reconciled_accepted_families: result.reconciled_accepted_families || 0,
    removed_extra_families: result.target_reconciliation?.removed_extra_families || 0,
    active_sessions: result.active?.length || 0,
    would_create_documents: result.would_create_documents,
    would_create_parts: result.would_create_parts,
    refusal_labels: refusalLabelCounts(result.refusals),
    accounting_verified: Boolean(result.accounting),
    retrieval_ready: state.message_sessions.target_readback?.vector_readiness?.ready === true,
    source_receipt: sourceReceipt ? { source: sourceReceipt.source, status: sourceReceipt.status } : null,
  }, null, 2));
}

if (isMessageMigrationDirectExecution(process.argv[1])) {
  main().catch((error) => {
    console.error(`message migration failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
