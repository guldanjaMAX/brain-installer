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
import { MAX_DOC_CHARS, batches, splitOversized } from "../ingest/run.mjs";
import {
  MESSAGE_CHAT_PLATFORMS, MESSAGE_SESSION_DEFAULTS, MessageSessionizer,
  messageRowDisposition,
} from "../ingest/message-session.mjs";
import { GATE_VERSION, scan as scanSecrets } from "../worker/src/lib/secret-scan.js";
import {
  assertTargetReceiptIdentity, getTargetInventory, isDirectExecution, postSourceReceipt,
  postTargetBatch, querySupabase,
} from "./supabase-import.mjs";
import { readProtectedStateJson, saveProtectedStateJson } from "./state-file.mjs";

export const MESSAGE_STATE_VERSION = 2;
export const MESSAGE_STATE_SCHEMA = "brain-message-migration";
const MESSAGE_ALGORITHM_VERSION = "message-sessions-v2-timezone";
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
  if (!Array.isArray(lane.active) || !Array.isArray(lane.refusals)) throw new Error("message migration collections are invalid");
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

export function messageMigrationConfigFingerprint(scope) {
  return createHash("sha256").update(JSON.stringify({
    algorithm: MESSAGE_ALGORITHM_VERSION,
    eligibility: ELIGIBLE,
    order: "timestamp-id-keyset-v1",
    chat_platforms: MESSAGE_CHAT_PLATFORMS,
    sessionizer: MESSAGE_SESSION_DEFAULTS,
    split_max_chars: MAX_DOC_CHARS,
    credential_gate_version: GATE_VERSION,
    scope,
  })).digest("hex");
}

const itemize = (envelopes) => envelopes.flatMap((envelope) =>
  splitOversized(envelope).map((part) => ({ envelope: part }))
);

const emptyTally = () => ({
  candidate_documents: 0, candidate_parts: 0, candidate_source_messages: 0,
  target_documents: 0, target_chunks: 0,
  created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0,
  refusals: [],
});

const transientTargetError = (value) => /(?:network connection lost|timed? ?out|fetch failed|connection reset|econnreset|eai_again|temporar(?:y|ily)|overloaded|returned (?:429|5\d\d))/i.test(String(value || ""));

export async function sendMessageEnvelopes(envelopes, postFn, {
  attempts = 3,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const tally = emptyTally();
  tally.candidate_documents = envelopes.length;
  tally.candidate_source_messages = envelopes.reduce((total, envelope) =>
    total + nonNegativeInteger(Number(envelope?.metadata?.message_count || 1), "candidate source count"), 0
  );
  const safe = [];
  for (const envelope of envelopes) {
    const scan = scanSecrets(envelope.content);
    if (scan.shouldRefuse) {
      tally.refused++;
      tally.candidate_parts++;
      if (tally.refusals.length < 1000) tally.refusals.push({
        source_id: envelope.source_id,
        labels: scan.labels,
      });
    } else {
      safe.push(envelope);
    }
  }
  const items = itemize(safe);
  tally.candidate_parts += items.length;
  for (const group of batches(items)) {
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
      if (["created", "updated", "unchanged"].includes(status)) {
        const chunks = Number(slot.chunks || 0);
        if (!Number.isSafeInteger(chunks) || chunks < 0) {
          throw new Error(`message target receipt has an invalid chunk count at slot ${i + 1}`);
        }
        tally[status]++;
        tally.target_documents++;
        tally.target_chunks += chunks;
      } else if (status === "refused") {
        tally.refused++;
        if (tally.refusals.length < 1000) tally.refusals.push({
          source_id: item.envelope.source_id,
          labels: slot.labels || [],
        });
      } else {
        tally.failed++;
        throw new Error(`message target rejected receipt slot ${i + 1}`);
      }
    }
  }
  return tally;
}

const mergeTally = (lane, tally) => {
  for (const key of [
    "candidate_documents", "candidate_parts", "candidate_source_messages",
    "target_documents", "target_chunks", "created", "updated", "unchanged", "refused", "failed",
  ]) {
    lane[key] += Number(tally[key] || 0);
  }
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
  };
}

export function messageCompletionReceipt(lane, completedAt = new Date().toISOString()) {
  if (!lane?.complete || !lane?.accounting) throw new Error("message migration is not accounting-verified complete");
  if (!lane?.target_readback || lane.target_readback.vector_backlog !== 0) {
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
    complete_sweep: false,
    detail: [
      "Message migration complete",
      `expected=${accounting.expected_source_messages}`,
      `represented=${accounting.represented_source_messages}`,
      `skipped=${accounting.skipped_source_messages}`,
      `legacy_unclassified=${accounting.legacy_unclassified_source_messages}`,
      `accepted_parts=${accounting.accepted_parts_after_upgrade}`,
      `refused_parts=${accounting.refused_parts_after_upgrade}`,
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
  const messageRow = inventory.rows.find((row) => row?.source_type === "message");
  const stored = messageRow ? Number(messageRow.stored_documents) : 0;
  if (!Number.isSafeInteger(stored) || stored < 0) {
    throw new Error("message migration target readback has no valid stored-document count");
  }
  if (stored < lane.target_documents) {
    throw new Error("message migration target readback contains fewer stored documents than accepted receipts");
  }
  return {
    backend: "d1",
    stored_documents: stored,
    vector_backlog: 0,
    verified_at: new Date().toISOString(),
  };
}

export async function runMessageMigration({
  state,
  queryFn,
  postFn,
  saveFn = () => {},
  ownerLabel,
  groupingTimezone,
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

  const fingerprint = messageMigrationConfigFingerprint(lane.scope);
  if (lane.config_fingerprint && lane.config_fingerprint !== fingerprint) {
    throw new Error("message migration configuration changed after the lane started");
  }
  if (!lane.config_fingerprint) {
    lane.config_fingerprint = fingerprint;
    boundaryChanged = true;
  }

  if (!lane.high_water) {
    const [high] = await queryFn(messageHighWaterSql(scope));
    if (!high?.ts || !high?.id) {
      lane.expected_source_messages = 0;
      if (dryRun) return { status: "dry_run", run_rows: 0, run_pages: 0, ...lane };
      lane.accounting = verifyMessageAccounting(lane);
      lane.accounting_verified_at = new Date().toISOString();
      lane.completed_at ||= lane.accounting_verified_at;
      lane.complete = true;
      saveFn(workingState);
      return { status: "complete", run_rows: 0, run_pages: 0, ...lane };
    }
    if (!Number.isFinite(Date.parse(high.ts)) || !String(high.id).trim()) {
      throw new Error("message migration source high-water mark is invalid");
    }
    lane.high_water = { ts: high.ts, id: high.id };
    if (high.eligible_rows !== undefined) {
      lane.expected_source_messages = parseExpectedCount(high.eligible_rows);
      if (lane.expected_source_messages < 1) {
        throw new Error("message migration source boundary count is inconsistent");
      }
    }
    boundaryChanged = true;
  }
  if (lane.expected_source_messages === null) {
    const [count] = await queryFn(messageExpectedCountSql(lane.high_water, lane.scope));
    lane.expected_source_messages = parseExpectedCount(count?.eligible_rows);
    if (lane.expected_source_messages < lane.source_messages) {
      throw new Error("message migration source count is below the already processed checkpoint");
    }
    boundaryChanged = true;
  }
  if (boundaryChanged && !dryRun) saveFn(workingState);

  if (lane.complete) {
    lane.accounting = verifyMessageAccounting(lane);
    if (!lane.accounting_verified_at) {
      lane.accounting_verified_at = new Date().toISOString();
      if (!dryRun) saveFn(workingState);
    }
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
        mergeTally(lane, await sendMessageEnvelopes(finalEnvelopes, postFn));
        lane.active = [];
        lane.accounting = verifyMessageAccounting(lane);
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
      const tally = await sendMessageEnvelopes(envelopes, postFn);
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

  const statePath = resolve(flags.state || ".brain-migration-message-sessions.json");
  if (flags.reset && existsSync(statePath)) throw new Error("--reset requires removing or archiving the existing state file deliberately");
  const state = loadMessageState(statePath, { projectRef, targetUrl });
  const queryFn = (sql) => querySupabase({ projectRef, accessToken, sql });
  const result = await runMessageMigration({
    state,
    queryFn,
    postFn: (items) => postTargetBatch({ targetUrl, adminKey, items }),
    saveFn: (next) => saveMessageState(statePath, next),
    ownerLabel: flags["owner-label"],
    groupingTimezone: flags.timezone,
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
    active_sessions: result.active?.length || 0,
    would_create_documents: result.would_create_documents,
    would_create_parts: result.would_create_parts,
    refusal_labels: refusalLabelCounts(result.refusals),
    accounting_verified: Boolean(result.accounting),
    retrieval_ready: state.message_sessions.target_readback?.vector_backlog === 0,
    source_receipt: sourceReceipt ? { source: sourceReceipt.source, status: sourceReceipt.status } : null,
  }, null, 2));
}

if (isMessageMigrationDirectExecution(process.argv[1])) {
  main().catch((error) => {
    console.error(`message migration failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
