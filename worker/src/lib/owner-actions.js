/**
 * Owner workspace writes.
 *
 * These routes use the passkey session as their authority, but only after the
 * session has resolved to the positive owner principal. A future document-
 * scoped session is therefore refused even when it can read the same screen.
 * Every mutation is request-idempotent and every owner-facing history row is
 * appended only after the underlying state change succeeds.
 */

import { jsonResponse, privateNoStore } from "./core.js";
import { ownerSessionPrincipal } from "./owner-auth.js";
import { backendOf, storeFor, D1 } from "./store.js";

export const OWNER_PATH_PREFIX = "/api/owner/";
export const OWNER_TENANT = "primary";
export const OWNER_UPLOAD_MAX_CONTENT_BYTES = 1_000_000;

const OWNER_TABLES = [
  "owner_action_requests",
  "owner_activity_events",
  "owner_approvals",
  "fin_period_closes",
  "owner_targets",
  "owner_preferences",
];
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOGICAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const TARGET_METRICS = new Set([
  "revenue", "cash_reserve", "spending_limit", "debt_reduction", "other",
]);
const ACTIVITY_TYPES = new Set([
  "upload_completed", "approval_recorded", "period_close_accepted",
  "period_close_reopened", "target_set", "target_archived", "preference_set",
  // Shared whole-product vocabulary used by the security workstream.
  "document_grant_created", "document_grant_invite_reissued",
  "document_grant_revoked", "passkey_added",
  "passkey_renamed", "passkey_revoked", "sessions_revoked",
  "support_access_created", "support_access_activated", "support_access_revoked",
]);
const MEDIA_TYPE_EXTENSIONS = Object.freeze({
  "text/plain": Object.freeze([".txt"]),
  "text/markdown": Object.freeze([".md", ".markdown"]),
});
const UPLOAD_CAPABILITIES = Object.freeze({
  supported_media_types: Object.freeze(Object.keys(MEDIA_TYPE_EXTENSIONS)),
  supported_extensions: Object.freeze([".txt", ".md", ".markdown"]),
  media_type_extensions: MEDIA_TYPE_EXTENSIONS,
  max_content_bytes: OWNER_UPLOAD_MAX_CONTENT_BYTES,
  content_encoding: "utf-8",
  empty_media_type_supported: false,
  normalization: "decode UTF-8 strictly, remove one leading UTF-8 BOM if present, preserve all remaining text exactly",
});

const respond = (body, status = 200) => privateNoStore(jsonResponse(body, status));
const invalid = (code, field = undefined) => respond({
  error: "invalid_request", code, ...(field ? { field } : {}),
}, 400);
const conflict = (code) => respond({ error: "conflict", code }, 409);
const unavailable = (code, extra = {}) => respond({ error: "unavailable", code, ...extra }, 503);

function objectBody(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function readBody(request) {
  try {
    return objectBody(await request.json());
  } catch {
    return null;
  }
}

function validDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function boundedText(value, max, { required = false } = {}) {
  if (value === undefined || value === null) return required ? undefined : null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if ((!text && required) || text.length > max) return undefined;
  return text || null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestIdOf(body) {
  return typeof body?.request_id === "string" && REQUEST_ID.test(body.request_id)
    ? body.request_id
    : null;
}

function activityId(requestId, eventType) {
  return `evt_${eventType}_${requestId}`;
}

function actionReceiptStatement(env, { requestId, actionType, requestHash, response, status, at }) {
  return env.DB.prepare(
    `INSERT INTO owner_action_requests
       (tenant_id, request_id, action_type, request_hash, response_json, response_status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`
  ).bind(OWNER_TENANT, requestId, actionType, requestHash, JSON.stringify(response), status, at);
}

function finalizeActionReceiptStatement(env, { requestId, actionType, requestHash, response, status }) {
  return env.DB.prepare(
    `UPDATE owner_action_requests
        SET response_json=?1,response_status=?2
      WHERE tenant_id=?3 AND request_id=?4 AND action_type=?5 AND request_hash=?6`
  ).bind(JSON.stringify(response), status, OWNER_TENANT, requestId, actionType, requestHash);
}

function activityStatement(env, {
  eventId, eventType, entitySlug = null, subjectKind, subjectId, displayLabel,
  occurredAt, requestId = null,
}) {
  return env.DB.prepare(
    `INSERT INTO owner_activity_events
       (event_id, tenant_id, request_id, event_type, entity_slug,
        subject_kind, subject_id, display_label, occurred_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
  ).bind(
    eventId, OWNER_TENANT, requestId, eventType, entitySlug,
    subjectKind, subjectId, displayLabel, occurredAt,
  );
}

/**
 * Shared writer for successful human-visible changes made by other modules.
 * It intentionally rejects low-level telemetry and private payloads by shape.
 */
export async function recordOwnerActivity(env, input) {
  const eventType = String(input?.eventType || "");
  const eventId = String(input?.eventId || "");
  const entitySlug = input?.entitySlug === undefined || input?.entitySlug === null
    ? null
    : String(input.entitySlug);
  const subjectKind = boundedText(input?.subjectKind, 80, { required: true });
  const subjectId = boundedText(input?.subjectId, 180, { required: true });
  const displayLabel = boundedText(input?.displayLabel, 160, { required: true });
  const requestId = input?.requestId === undefined || input?.requestId === null
    ? null
    : String(input.requestId);
  if (!ACTIVITY_TYPES.has(eventType)) throw new Error("unsupported owner activity type");
  if (!eventId || eventId.length > 180) throw new Error("invalid owner activity event id");
  if (entitySlug !== null && !SLUG.test(entitySlug)) throw new Error("invalid owner activity entity scope");
  if (!subjectKind || !subjectId || !displayLabel) throw new Error("invalid owner activity subject");
  if (requestId !== null && !REQUEST_ID.test(requestId)) throw new Error("invalid owner activity request id");
  const occurredAt = input?.occurredAt || new Date().toISOString();
  await activityStatement(env, {
    eventId, eventType, entitySlug, subjectKind, subjectId, displayLabel,
    occurredAt, requestId,
  }).run();
  return { event_id: eventId, occurred_at: occurredAt };
}

async function replayFor(env, { requestId, actionType, requestHash }) {
  const row = await env.DB.prepare(
    `SELECT action_type, request_hash, response_json
       FROM owner_action_requests WHERE tenant_id = ?1 AND request_id = ?2`
  ).bind(OWNER_TENANT, requestId).first();
  if (!row) return null;
  if (row.action_type !== actionType || row.request_hash !== requestHash) {
    return conflict("request_id_conflict");
  }
  let stored;
  try {
    stored = JSON.parse(row.response_json);
  } catch {
    return unavailable("owner_receipt_unavailable");
  }
  return respond({ ...stored, replayed: true }, 200);
}

async function ownerWorkspaceInstalled(env) {
  if (backendOf(env) !== D1 || !env.DB) return false;
  const placeholders = OWNER_TABLES.map((_, index) => `?${index + 1}`).join(",");
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`
  ).bind(...OWNER_TABLES).all();
  return new Set(result?.results?.map((row) => row.name) || []).size === OWNER_TABLES.length;
}

export async function validateOwnedEntityScope(env, entitySlug) {
  if (!SLUG.test(String(entitySlug || ""))) {
    return { ok: false, response: invalid("invalid_entity_slug", "entity_slug") };
  }
  if (backendOf(env) !== D1 || !env.DB) {
    return { ok: false, response: unavailable("entity_scope_unavailable") };
  }
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT entity_slug, legal_name, display_label, status, relationship
         FROM fin_entities
        WHERE tenant_id = ?1 AND entity_slug = ?2 AND superseded_by_id IS NULL`
    ).bind(OWNER_TENANT, entitySlug).first();
  } catch {
    return { ok: false, response: unavailable("entity_scope_unavailable") };
  }
  if (!row) {
    return { ok: false, response: respond({ error: "not_found", code: "entity_not_found" }, 404) };
  }
  if (row.relationship !== "owned") {
    return { ok: false, response: respond({ error: "forbidden", code: "entity_not_owned" }, 403) };
  }
  return {
    ok: true,
    entity: {
      entity_slug: row.entity_slug,
      label: row.display_label || row.legal_name || row.entity_slug,
      status: row.status,
    },
  };
}

async function requireOwner(request, env) {
  let principal;
  try {
    principal = await ownerSessionPrincipal(request, env);
  } catch {
    return unavailable("owner_auth_unavailable");
  }
  if (!principal) return respond({ error: "unauthorized", code: "session_required" }, 401);
  if (principal.kind !== "owner" || principal.grantId !== null) {
    return respond({ error: "forbidden", code: "owner_required" }, 403);
  }
  return null;
}

function rowTarget(row) {
  return {
    target_id: row.target_id,
    entity_slug: row.entity_slug,
    label: row.label,
    metric: row.metric,
    target_minor: Number(row.target_minor),
    currency: row.currency,
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    note: row.note || null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at || null,
  };
}

function rowPreference(row) {
  let value;
  try { value = JSON.parse(row.value_json); } catch { value = null; }
  return {
    entity_slug: row.entity_slug || null,
    preference_key: row.preference_key,
    value,
    updated_at: row.updated_at,
  };
}

function rowPeriodClose(row) {
  return {
    period_close_id: row.close_id,
    entity_slug: row.entity_slug,
    period_start: row.period_start,
    period_end: row.period_end,
    status: row.status,
    evidence_state: row.evidence_state,
    acknowledged_incomplete: Number(row.acknowledged_incomplete) === 1,
    note: row.note || null,
    accepted_at: row.accepted_at || null,
    reopened_at: row.reopened_at || null,
    updated_at: row.updated_at,
  };
}

function unsupportedMedia(mediaType, reason) {
  return respond({
    uploaded: false,
    unsupported_media: true,
    media_type: mediaType,
    supported_media_types: UPLOAD_CAPABILITIES.supported_media_types,
    supported_extensions: UPLOAD_CAPABILITIES.supported_extensions,
    max_content_bytes: OWNER_UPLOAD_MAX_CONTENT_BYTES,
    reason,
  }, 415);
}

async function upload(env, body, ingestEnvelope, afterIngest) {
  const requestId = requestIdOf(body);
  if (!requestId) return invalid("invalid_request_id", "request_id");
  const entitySlug = String(body.entity_slug || "");
  if (!SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  const documentId = String(body.document_id || "");
  if (!LOGICAL_ID.test(documentId)) return invalid("invalid_document_id", "document_id");
  const mediaType = typeof body.media_type === "string" ? body.media_type.trim().toLowerCase() : "";
  if (!MEDIA_TYPE_EXTENSIONS[mediaType]) {
    return unsupportedMedia(mediaType, "This media type is not accepted by owner upload.");
  }
  let fileName = null;
  if (body.file_name !== undefined && body.file_name !== null) {
    if (typeof body.file_name !== "string" || !body.file_name.trim() || body.file_name.length > 255 || /[\\/]/.test(body.file_name)) {
      return invalid("invalid_file_name", "file_name");
    }
    fileName = body.file_name.trim();
    const lower = fileName.toLowerCase();
    const extension = UPLOAD_CAPABILITIES.supported_extensions.find((item) => lower.endsWith(item)) || "";
    if (!extension || !MEDIA_TYPE_EXTENSIONS[mediaType].includes(extension)) {
      return unsupportedMedia(mediaType, "The file extension does not match the declared media type.");
    }
  }
  const envelope = objectBody(body.envelope);
  if (!envelope) {
    return invalid("invalid_upload_envelope", "envelope");
  }
  // Storage identity is server-owned. request_id is only the retry receipt and
  // must never turn every new version of one file into a new corpus document.
  if (Object.hasOwn(envelope, "source_type") || Object.hasOwn(envelope, "source_id")) {
    return invalid("server_owned_document_identity", "envelope");
  }
  if (typeof envelope.content !== "string") return invalid("invalid_upload_content", "envelope.content");
  const normalizedContent = envelope.content.startsWith("\uFEFF") ? envelope.content.slice(1) : envelope.content;
  if (!normalizedContent.trim()) return invalid("empty_upload_content", "envelope.content");
  if (new TextEncoder().encode(normalizedContent).length > OWNER_UPLOAD_MAX_CONTENT_BYTES) {
    return respond({
      uploaded: false,
      error: "document too large",
      code: "upload_too_large",
      max_content_bytes: OWNER_UPLOAD_MAX_CONTENT_BYTES,
    }, 413);
  }
  const metadata = objectBody(envelope.metadata) || {};
  for (const key of ["entity_slug", "client", "client_name"]) {
    if (metadata[key] !== undefined && metadata[key] !== entitySlug) {
      return conflict("conflicting_business_scope");
    }
  }
  const normalized = {
    ...envelope,
    source_type: "upload",
    source_id: `owner:${entitySlug}:${documentId}`,
    content: normalizedContent,
    metadata: { ...metadata, entity_slug: entitySlug, client: entitySlug, client_name: entitySlug },
  };
  const requestHash = await sha256({
    ...body, document_id: documentId, media_type: mediaType, file_name: fileName,
    envelope: normalized,
  });
  const scope = await validateOwnedEntityScope(env, entitySlug);
  if (!scope.ok) return scope.response;
  if (typeof ingestEnvelope !== "function") return unavailable("owner_upload_unavailable");

  // The intent is durable before common ingest. It contains no content, only
  // the action hash and the preflight result needed to recover the true action
  // if ingest commits and the Worker dies before audit finalization.
  let intent;
  let resumedIntent = false;
  try {
    const existing = await env.DB.prepare(
      `SELECT action_type,request_hash,response_json
         FROM owner_action_requests WHERE tenant_id=?1 AND request_id=?2`
    ).bind(OWNER_TENANT, requestId).first();
    if (existing) {
      if (existing.action_type !== "upload" || existing.request_hash !== requestHash) {
        return conflict("request_id_conflict");
      }
      const storedReceipt = JSON.parse(existing.response_json);
      if (storedReceipt?.pending !== true) return respond({ ...storedReceipt, replayed: true }, 200);
      intent = storedReceipt;
      resumedIntent = true;
    } else {
      const [preflight] = await storeFor(env).preflightIngestBatch(env, [normalized]);
      if (!preflight?.doc_uid) return unavailable("owner_upload_unavailable");
      intent = {
        pending: true,
        document_id: documentId,
        doc_uid: preflight.doc_uid,
        intended_action: preflight.unchanged
          ? "unchanged"
          : preflight.prepared?.prior ? "updated" : "created",
      };
      await actionReceiptStatement(env, {
        requestId, actionType: "upload", requestHash, response: intent, status: 202,
        at: new Date().toISOString(),
      }).run();
    }
  } catch {
    return unavailable("owner_upload_intent_unavailable");
  }

  let ingestResponse;
  try {
    ingestResponse = await ingestEnvelope(normalized);
  } catch {
    return unavailable("owner_upload_unavailable");
  }
  let stored;
  try { stored = await ingestResponse.json(); } catch { stored = { error: "ingest failed" }; }
  if (!ingestResponse.ok) {
    try {
      await env.DB.prepare(
        `DELETE FROM owner_action_requests
          WHERE tenant_id=?1 AND request_id=?2 AND action_type='upload'
            AND request_hash=?3 AND response_status=202`
      ).bind(OWNER_TENANT, requestId, requestHash).run();
    } catch {
      return unavailable("owner_upload_intent_unavailable");
    }
    return respond({ ...stored, uploaded: false }, ingestResponse.status);
  }
  // Test-only seam: a fixture can throw here to model a committed ingest whose
  // HTTP response and final audit batch were lost. The pending intent remains.
  if (typeof afterIngest === "function") {
    try { await afterIngest({ requestId, documentId, stored }); }
    catch { return unavailable("owner_upload_finalize_unavailable"); }
  }
  const document = {
    doc_uid: intent.doc_uid,
    // On a resumed pending intent common ingest correctly says unchanged. The
    // preflight saved before the first ingest proves whether that first write
    // was created, updated, or already unchanged.
    action: intent.intended_action,
    chunks: Number(stored.chunks || 0),
    queued: Number(stored.queued || 0),
  };
  const changed = document.action !== "unchanged";
  const at = new Date().toISOString();
  const eventId = changed ? activityId(requestId, "upload_completed") : null;
  const response = {
    uploaded: true, request_id: requestId, document_id: documentId,
    entity_scope: { entity_slug: entitySlug }, media_type: mediaType,
    file_name: fileName, document, changed, activity_event_id: eventId, replayed: resumedIntent,
  };
  const status = resumedIntent ? 200 : document.action === "created" ? 201 : 200;
  const statements = [];
  if (changed) {
    statements.push(activityStatement(env, {
      eventId, eventType: "upload_completed", entitySlug, subjectKind: "document",
      subjectId: document.doc_uid, displayLabel: fileName || "Text upload", occurredAt: at,
      requestId,
    }));
  }
  statements.push(finalizeActionReceiptStatement(env, {
    requestId, actionType: "upload", requestHash, response, status,
  }));
  try { await env.DB.batch(statements); } catch { return unavailable("owner_activity_unavailable"); }
  return respond(response, status);
}

async function approval(env, body) {
  const requestId = requestIdOf(body);
  if (!requestId) return invalid("invalid_request_id", "request_id");
  const entitySlug = String(body.entity_slug || "");
  const approvalType = String(body.approval_type || "");
  const subjectUid = boundedText(body.subject_uid, 180, { required: true });
  const note = boundedText(body.note, 1000);
  if (!SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (!subjectUid) return invalid("invalid_subject_uid", "subject_uid");
  if (body.note !== undefined && note === undefined) return invalid("invalid_note", "note");
  if (!new Set(["reconciliation_ruling", "exception_resolution"]).has(approvalType)) {
    return invalid("invalid_approval_type", "approval_type");
  }
  const selectedClaimUid = approvalType === "reconciliation_ruling"
    ? boundedText(body.selected_claim_uid, 180, { required: true })
    : null;
  const resolution = approvalType === "exception_resolution"
    ? boundedText(body.resolution, 500, { required: true })
    : null;
  if (approvalType === "reconciliation_ruling" && !selectedClaimUid) {
    return invalid("invalid_selected_claim_uid", "selected_claim_uid");
  }
  if (approvalType === "exception_resolution" && !resolution) {
    return invalid("invalid_resolution", "resolution");
  }
  const normalized = {
    request_id: requestId, entity_slug: entitySlug, approval_type: approvalType,
    subject_uid: subjectUid, selected_claim_uid: selectedClaimUid, resolution, note,
  };
  const requestHash = await sha256(normalized);
  const replay = await replayFor(env, { requestId, actionType: "approval", requestHash });
  if (replay) return replay;
  const scope = await validateOwnedEntityScope(env, entitySlug);
  if (!scope.ok) return scope.response;

  let mutation;
  try {
    if (approvalType === "reconciliation_ruling") {
      const reconciliation = await env.DB.prepare(
        `SELECT reconciliation_uid FROM fin_reconciliations
          WHERE tenant_id=?1 AND reconciliation_uid=?2 AND entity_slug=?3`
      ).bind(OWNER_TENANT, subjectUid, entitySlug).first();
      if (!reconciliation) return respond({ error: "not_found", code: "subject_not_found" }, 404);
      const claim = await env.DB.prepare(
        `SELECT claim_uid FROM fin_reconciliation_claims
          WHERE tenant_id=?1 AND claim_uid=?2 AND reconciliation_uid=?3`
      ).bind(OWNER_TENANT, selectedClaimUid, subjectUid).first();
      if (!claim) return respond({ error: "not_found", code: "claim_not_found" }, 404);
      mutation = env.DB.prepare(
        `UPDATE fin_reconciliations
            SET ruled_claim_uid=?1, ruled_at=?2, ruled_by_party='owner',
                ruling_note=?3, ruling_consumed=0
          WHERE tenant_id=?4 AND reconciliation_uid=?5 AND entity_slug=?6`
      ).bind(selectedClaimUid, new Date().toISOString().slice(0, 10), note, OWNER_TENANT, subjectUid, entitySlug);
    } else {
      const exception = await env.DB.prepare(
        `SELECT exception_uid, resolved_at FROM fin_exceptions
          WHERE tenant_id=?1 AND exception_uid=?2 AND entity_slug=?3`
      ).bind(OWNER_TENANT, subjectUid, entitySlug).first();
      if (!exception) return respond({ error: "not_found", code: "subject_not_found" }, 404);
      if (exception.resolved_at) return conflict("exception_already_resolved");
      mutation = env.DB.prepare(
        `UPDATE fin_exceptions
            SET resolved_at=?1, resolution=?2, resolved_by_party='owner'
          WHERE tenant_id=?3 AND exception_uid=?4 AND entity_slug=?5 AND resolved_at IS NULL`
      ).bind(new Date().toISOString().slice(0, 10), resolution, OWNER_TENANT, subjectUid, entitySlug);
    }
  } catch {
    return unavailable("approval_state_unavailable");
  }

  const at = new Date().toISOString();
  const approvalId = `approval_${crypto.randomUUID()}`;
  const eventId = activityId(requestId, "approval_recorded");
  const approvalRow = {
    approval_id: approvalId, approval_type: approvalType, entity_slug: entitySlug,
    subject_uid: subjectUid, selected_claim_uid: selectedClaimUid, resolution, note,
    recorded_at: at,
  };
  const response = {
    request_id: requestId,
    entity_scope: { entity_slug: entitySlug },
    approval: approvalRow,
    changed: true,
    activity_event_id: eventId,
    replayed: false,
  };
  try {
    await env.DB.batch([
      mutation,
      env.DB.prepare(
        `INSERT INTO owner_approvals
           (approval_id,tenant_id,request_id,approval_type,entity_slug,subject_uid,
            selected_claim_uid,resolution,note,recorded_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
      ).bind(
        approvalId, OWNER_TENANT, requestId, approvalType, entitySlug, subjectUid,
        selectedClaimUid, resolution, note, at,
      ),
      activityStatement(env, {
        eventId, eventType: "approval_recorded", entitySlug, subjectKind: approvalType,
        subjectId: subjectUid,
        displayLabel: approvalType === "reconciliation_ruling" ? "Reconciliation ruling recorded" : "Exception resolved",
        occurredAt: at, requestId,
      }),
      actionReceiptStatement(env, {
        requestId, actionType: "approval", requestHash, response, status: 201, at,
      }),
    ]);
  } catch {
    return unavailable("approval_write_unavailable");
  }
  return respond(response, 201);
}

async function periodEvidence(env, entitySlug, periodStart, periodEnd) {
  try {
    const [accounts, statements, reconciliations, exceptions] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM fin_accounts
          WHERE tenant_id=?1 AND entity_slug=?2 AND status='open' AND superseded_by_id IS NULL`
      ).bind(OWNER_TENANT, entitySlug).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT s.account_slug) AS covered
           FROM fin_statements s JOIN fin_accounts a
             ON a.tenant_id=s.tenant_id AND a.account_slug=s.account_slug
          WHERE s.tenant_id=?1 AND a.entity_slug=?2 AND a.status='open'
            AND a.superseded_by_id IS NULL AND s.superseded_by_id IS NULL
            AND s.period_start=?3 AND s.period_end=?4 AND s.parse_state='parsed'`
      ).bind(OWNER_TENANT, entitySlug, periodStart, periodEnd).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN state='matched' THEN 0 ELSE 1 END) AS open_n
           FROM fin_reconciliations
          WHERE tenant_id=?1 AND entity_slug=?2 AND period_start=?3 AND period_end=?4`
      ).bind(OWNER_TENANT, entitySlug, periodStart, periodEnd).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM fin_exceptions
          WHERE tenant_id=?1 AND entity_slug=?2 AND resolved_at IS NULL AND first_seen<=?3`
      ).bind(OWNER_TENANT, entitySlug, periodEnd).first(),
    ]);
    const evidence = {
      account_count: Number(accounts?.n || 0),
      covered_account_count: Number(statements?.covered || 0),
      parsed_statement_count: Number(statements?.n || 0),
      reconciliation_count: Number(reconciliations?.n || 0),
      open_reconciliation_count: Number(reconciliations?.open_n || 0),
      unresolved_exception_count: Number(exceptions?.n || 0),
    };
    evidence.state = evidence.account_count > 0 &&
      evidence.covered_account_count === evidence.account_count &&
      evidence.reconciliation_count > 0 && evidence.open_reconciliation_count === 0 &&
      evidence.unresolved_exception_count === 0 ? "complete" : "incomplete";
    return { ok: true, evidence };
  } catch {
    return { ok: false };
  }
}

async function periodRead(env, body) {
  const entitySlug = String(body.entity_slug || "");
  if (!SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (body.period_start !== undefined && !validDate(body.period_start)) return invalid("invalid_period_start", "period_start");
  if (body.period_end !== undefined && !validDate(body.period_end)) return invalid("invalid_period_end", "period_end");
  const scope = await validateOwnedEntityScope(env, entitySlug);
  if (!scope.ok) return scope.response;
  const where = ["tenant_id=?1", "entity_slug=?2"];
  const binds = [OWNER_TENANT, entitySlug];
  if (body.period_start) { where.push(`period_start=?${binds.length + 1}`); binds.push(body.period_start); }
  if (body.period_end) { where.push(`period_end=?${binds.length + 1}`); binds.push(body.period_end); }
  try {
    const result = await env.DB.prepare(
      `SELECT close_id,entity_slug,period_start,period_end,status,evidence_state,
              acknowledged_incomplete,note,accepted_at,reopened_at,updated_at
         FROM fin_period_closes WHERE ${where.join(" AND ")}
        ORDER BY period_end DESC, period_start DESC`
    ).bind(...binds).all();
    return respond({
      entity_scope: { entity_slug: entitySlug },
      period_closes: (result?.results || []).map(rowPeriodClose),
      unavailable: false,
      sections_unavailable: [],
    });
  } catch {
    return unavailable("period_closes_unavailable", {
      unavailable: true, sections_unavailable: ["period_closes"],
    });
  }
}

async function periodWrite(env, body, mode) {
  const requestId = requestIdOf(body);
  if (!requestId) return invalid("invalid_request_id", "request_id");
  const entitySlug = String(body.entity_slug || "");
  if (!SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (!validDate(body.period_start) || !validDate(body.period_end) || body.period_start > body.period_end) {
    return invalid("invalid_period", "period_start");
  }
  const note = boundedText(body.note, 1000);
  if (body.note !== undefined && note === undefined) return invalid("invalid_note", "note");
  if (body.acknowledge_incomplete !== undefined && typeof body.acknowledge_incomplete !== "boolean") {
    return invalid("invalid_acknowledgement", "acknowledge_incomplete");
  }
  const normalized = {
    request_id: requestId, entity_slug: entitySlug, period_start: body.period_start,
    period_end: body.period_end,
    acknowledge_incomplete: mode === "accept" ? body.acknowledge_incomplete === true : undefined,
    note,
  };
  const actionType = `period_close_${mode}`;
  const requestHash = await sha256(normalized);
  const replay = await replayFor(env, { requestId, actionType, requestHash });
  if (replay) return replay;
  const scope = await validateOwnedEntityScope(env, entitySlug);
  if (!scope.ok) return scope.response;
  const evidenceResult = await periodEvidence(env, entitySlug, body.period_start, body.period_end);
  if (!evidenceResult.ok) return unavailable("period_evidence_unavailable");
  const evidence = evidenceResult.evidence;
  if (mode === "accept" && evidence.state === "incomplete" && body.acknowledge_incomplete !== true) {
    return conflict("incomplete_evidence");
  }
  let prior;
  try {
    prior = await env.DB.prepare(
      `SELECT * FROM fin_period_closes
        WHERE tenant_id=?1 AND entity_slug=?2 AND period_start=?3 AND period_end=?4`
    ).bind(OWNER_TENANT, entitySlug, body.period_start, body.period_end).first();
  } catch {
    return unavailable("period_closes_unavailable");
  }
  if (mode === "accept" && prior?.status === "accepted") return conflict("period_already_accepted");
  if (mode === "reopen" && prior?.status !== "accepted") return conflict("period_not_accepted");
  const at = new Date().toISOString();
  const closeId = prior?.close_id || `close_${crypto.randomUUID()}`;
  const evidenceState = mode === "accept"
    ? evidence.state === "incomplete" ? "owner_acknowledged_incomplete" : "complete"
    : prior?.evidence_state || "complete";
  const acknowledged = evidenceState === "owner_acknowledged_incomplete";
  const row = {
    close_id: closeId, entity_slug: entitySlug, period_start: body.period_start,
    period_end: body.period_end, status: mode === "accept" ? "accepted" : "reopened",
    evidence_state: evidenceState, acknowledged_incomplete: acknowledged, note,
    accepted_at: mode === "accept" ? at : prior.accepted_at,
    reopened_at: mode === "reopen" ? at : null,
    updated_at: at,
  };
  const eventType = mode === "accept" ? "period_close_accepted" : "period_close_reopened";
  const eventId = activityId(requestId, eventType);
  const response = {
    request_id: requestId,
    entity_scope: { entity_slug: entitySlug },
    period_close: rowPeriodClose(row),
    evidence,
    changed: true,
    activity_event_id: eventId,
    replayed: false,
  };
  const write = env.DB.prepare(
    `INSERT INTO fin_period_closes
       (close_id,tenant_id,entity_slug,period_start,period_end,status,evidence_state,
        acknowledged_incomplete,evidence_json,note,accepted_at,reopened_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
     ON CONFLICT(tenant_id,entity_slug,period_start,period_end) DO UPDATE SET
       status=excluded.status,evidence_state=excluded.evidence_state,
       acknowledged_incomplete=excluded.acknowledged_incomplete,
       evidence_json=excluded.evidence_json,note=excluded.note,
       accepted_at=excluded.accepted_at,reopened_at=excluded.reopened_at,
       updated_at=excluded.updated_at`
  ).bind(
    closeId, OWNER_TENANT, entitySlug, body.period_start, body.period_end, row.status,
    evidenceState, acknowledged ? 1 : 0, JSON.stringify(evidence), note,
    row.accepted_at, row.reopened_at, at,
  );
  try {
    await env.DB.batch([
      write,
      activityStatement(env, {
        eventId, eventType, entitySlug, subjectKind: "period_close",
        subjectId: closeId,
        displayLabel: `${body.period_start} through ${body.period_end}`,
        occurredAt: at, requestId,
      }),
      actionReceiptStatement(env, {
        requestId, actionType, requestHash, response, status: prior ? 200 : 201, at,
      }),
    ]);
  } catch {
    return unavailable("period_close_write_unavailable");
  }
  return respond(response, prior ? 200 : 201);
}

function encodeCursor(at, id) {
  return btoa(JSON.stringify([at, id]));
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(atob(cursor));
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function activityRead(env, body) {
  const entitySlug = body.entity_slug === undefined || body.entity_slug === null || body.entity_slug === ""
    ? null
    : String(body.entity_slug);
  if (entitySlug && !SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (entitySlug) {
    const scope = await validateOwnedEntityScope(env, entitySlug);
    if (!scope.ok) return scope.response;
  }
  const limit = body.limit === undefined ? 50 : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return invalid("invalid_limit", "limit");
  const cursor = body.cursor === undefined || body.cursor === null ? null : decodeCursor(body.cursor);
  if (body.cursor !== undefined && body.cursor !== null && !cursor) return invalid("invalid_cursor", "cursor");
  const where = ["tenant_id=?1"];
  const binds = [OWNER_TENANT];
  if (entitySlug) { where.push(`entity_slug=?${binds.length + 1}`); binds.push(entitySlug); }
  if (cursor) {
    const atParam = binds.length + 1;
    const idParam = binds.length + 2;
    where.push(`(occurred_at < ?${atParam} OR (occurred_at = ?${atParam} AND event_id < ?${idParam}))`);
    binds.push(cursor[0], cursor[1]);
  }
  binds.push(limit + 1);
  try {
    const result = await env.DB.prepare(
      `SELECT event_id,event_type,entity_slug,subject_kind,subject_id,display_label,occurred_at
         FROM owner_activity_events WHERE ${where.join(" AND ")}
        ORDER BY occurred_at DESC,event_id DESC LIMIT ?${binds.length}`
    ).bind(...binds).all();
    const all = result?.results || [];
    const truncated = all.length > limit;
    const rows = all.slice(0, limit).map((row) => ({
      event_id: row.event_id,
      event_type: row.event_type,
      entity_slug: row.entity_slug || null,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      display_label: row.display_label,
      occurred_at: row.occurred_at,
    }));
    const last = rows.at(-1);
    return respond({
      entity_scope: { entity_slug: entitySlug },
      activity_events: rows,
      truncated,
      next_cursor: truncated && last ? encodeCursor(last.occurred_at, last.event_id) : null,
      unavailable: false,
      sections_unavailable: [],
    });
  } catch {
    return unavailable("activity_unavailable", {
      unavailable: true, sections_unavailable: ["activity_events"],
    });
  }
}

async function targetsRead(env, body) {
  const entitySlug = String(body.entity_slug || "");
  if (!SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  const scope = await validateOwnedEntityScope(env, entitySlug);
  if (!scope.ok) return scope.response;
  try {
    const result = await env.DB.prepare(
      `SELECT target_id,entity_slug,label,metric,target_minor,currency,period_start,
              period_end,note,status,created_at,updated_at,archived_at
         FROM owner_targets WHERE tenant_id=?1 AND entity_slug=?2
        ORDER BY status,updated_at DESC,target_id`
    ).bind(OWNER_TENANT, entitySlug).all();
    return respond({
      entity_scope: { entity_slug: entitySlug },
      targets: (result?.results || []).map(rowTarget),
      unavailable: false,
      sections_unavailable: [],
    });
  } catch {
    return unavailable("targets_unavailable", {
      unavailable: true, sections_unavailable: ["targets"],
    });
  }
}

async function targetWrite(env, body, mode) {
  const requestId = requestIdOf(body);
  if (!requestId) return invalid("invalid_request_id", "request_id");
  const entitySlug = String(body.entity_slug || "");
  const targetId = String(body.target_id || "");
  if (!SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (!LOGICAL_ID.test(targetId)) return invalid("invalid_target_id", "target_id");
  const scope = await validateOwnedEntityScope(env, entitySlug);
  if (!scope.ok) return scope.response;

  let prior;
  try {
    prior = await env.DB.prepare(
      `SELECT target_row_id,target_id,entity_slug,label,metric,target_minor,currency,
              period_start,period_end,note,status,created_at,updated_at,archived_at
         FROM owner_targets WHERE tenant_id=?1 AND entity_slug=?2 AND target_id=?3`
    ).bind(OWNER_TENANT, entitySlug, targetId).first();
  } catch {
    return unavailable("targets_unavailable");
  }
  if (mode === "archive" && !prior) return respond({ error: "not_found", code: "target_not_found" }, 404);
  const label = mode === "upsert" ? boundedText(body.label, 160, { required: true }) : prior.label;
  const metric = mode === "upsert" ? String(body.metric || "") : prior.metric;
  const targetMinor = mode === "upsert" ? body.target_minor : Number(prior.target_minor);
  const currency = mode === "upsert" ? String(body.currency || "").toUpperCase() : prior.currency;
  const periodStart = mode === "upsert" ? (body.period_start ?? null) : prior.period_start;
  const periodEnd = mode === "upsert" ? (body.period_end ?? null) : prior.period_end;
  const note = mode === "upsert" ? boundedText(body.note, 1000) : prior.note;
  if (!label) return invalid("invalid_target_label", "label");
  if (!TARGET_METRICS.has(metric)) return invalid("invalid_target_metric", "metric");
  if (!Number.isSafeInteger(targetMinor)) return invalid("invalid_target_minor", "target_minor");
  if (!CURRENCY.test(currency)) return invalid("invalid_currency", "currency");
  if (periodStart !== null && !validDate(periodStart)) return invalid("invalid_period_start", "period_start");
  if (periodEnd !== null && !validDate(periodEnd)) return invalid("invalid_period_end", "period_end");
  if (periodStart && periodEnd && periodStart > periodEnd) return invalid("invalid_period", "period_start");
  if (body.note !== undefined && note === undefined) return invalid("invalid_note", "note");
  const normalized = {
    request_id: requestId, entity_slug: entitySlug, target_id: targetId,
    ...(mode === "upsert" ? {
      label, metric, target_minor: targetMinor, currency, period_start: periodStart,
      period_end: periodEnd, note,
    } : {}),
  };
  const actionType = `target_${mode}`;
  const requestHash = await sha256(normalized);
  const replay = await replayFor(env, { requestId, actionType, requestHash });
  if (replay) return replay;
  const at = new Date().toISOString();
  const status = mode === "archive" ? "archived" : "active";
  const targetRowId = prior?.target_row_id || `target_${crypto.randomUUID()}`;
  const target = {
    target_id: targetId, entity_slug: entitySlug, label, metric,
    target_minor: targetMinor, currency, period_start: periodStart,
    period_end: periodEnd, note: note || null, status,
    created_at: prior?.created_at || at, updated_at: at,
    archived_at: mode === "archive" ? at : null,
  };
  const eventType = mode === "archive" ? "target_archived" : "target_set";
  const isUnchanged = mode === "archive"
    ? prior.status === "archived"
    : Boolean(prior) && prior.status === "active" &&
      prior.label === label && prior.metric === metric &&
      Number(prior.target_minor) === targetMinor && prior.currency === currency &&
      (prior.period_start || null) === periodStart && (prior.period_end || null) === periodEnd &&
      (prior.note || null) === (note || null);
  const eventId = isUnchanged ? null : activityId(requestId, eventType);
  if (isUnchanged) {
    const response = {
      request_id: requestId,
      entity_scope: { entity_slug: entitySlug },
      target: rowTarget(prior),
      changed: false,
      activity_event_id: null,
      replayed: false,
    };
    try {
      await actionReceiptStatement(env, {
        requestId, actionType, requestHash, response, status: 200, at,
      }).run();
    } catch {
      return unavailable("target_write_unavailable");
    }
    return respond(response, 200);
  }
  const response = {
    request_id: requestId,
    entity_scope: { entity_slug: entitySlug },
    target,
    changed: true,
    activity_event_id: eventId,
    replayed: false,
  };
  const write = env.DB.prepare(
    `INSERT INTO owner_targets
       (target_row_id,tenant_id,entity_slug,target_id,label,metric,target_minor,currency,
        period_start,period_end,note,status,created_at,updated_at,archived_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
     ON CONFLICT(tenant_id,entity_slug,target_id) DO UPDATE SET
       label=excluded.label,metric=excluded.metric,target_minor=excluded.target_minor,
       currency=excluded.currency,period_start=excluded.period_start,period_end=excluded.period_end,
       note=excluded.note,status=excluded.status,updated_at=excluded.updated_at,
       archived_at=excluded.archived_at`
  ).bind(
    targetRowId, OWNER_TENANT, entitySlug, targetId, label, metric, targetMinor,
    currency, periodStart, periodEnd, note, status, target.created_at, at, target.archived_at,
  );
  const responseStatus = !prior && mode === "upsert" ? 201 : 200;
  try {
    await env.DB.batch([
      write,
      activityStatement(env, {
        eventId, eventType, entitySlug, subjectKind: "target", subjectId: targetId,
        displayLabel: label, occurredAt: at, requestId,
      }),
      actionReceiptStatement(env, {
        requestId, actionType, requestHash, response, status: responseStatus, at,
      }),
    ]);
  } catch {
    return unavailable("target_write_unavailable");
  }
  return respond(response, responseStatus);
}

async function preferencesRead(env, body) {
  const entitySlug = body.entity_slug === undefined || body.entity_slug === null || body.entity_slug === ""
    ? null
    : String(body.entity_slug);
  if (entitySlug && !SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (entitySlug) {
    const scope = await validateOwnedEntityScope(env, entitySlug);
    if (!scope.ok) return scope.response;
  }
  const scopeKey = entitySlug || "global";
  try {
    const result = await env.DB.prepare(
      `SELECT entity_slug,preference_key,value_json,updated_at
         FROM owner_preferences WHERE tenant_id=?1 AND scope_key=?2
        ORDER BY preference_key`
    ).bind(OWNER_TENANT, scopeKey).all();
    return respond({
      entity_scope: { entity_slug: entitySlug },
      preferences: (result?.results || []).map(rowPreference),
      unavailable: false,
      sections_unavailable: [],
    });
  } catch {
    return unavailable("preferences_unavailable", {
      unavailable: true, sections_unavailable: ["preferences"],
    });
  }
}

async function preferenceSet(env, body) {
  const requestId = requestIdOf(body);
  if (!requestId) return invalid("invalid_request_id", "request_id");
  const entitySlug = body.entity_slug === undefined || body.entity_slug === null || body.entity_slug === ""
    ? null
    : String(body.entity_slug);
  if (entitySlug && !SLUG.test(entitySlug)) return invalid("invalid_entity_slug", "entity_slug");
  if (entitySlug) {
    const scope = await validateOwnedEntityScope(env, entitySlug);
    if (!scope.ok) return scope.response;
  }
  const key = String(body.preference_key || "");
  let value = body.value;
  if (key === "default_entity") {
    if (entitySlug !== null || typeof value !== "string") return invalid("invalid_preference_scope", "entity_slug");
    const targetScope = await validateOwnedEntityScope(env, value);
    if (!targetScope.ok) return targetScope.response;
  } else if (key === "display_currency") {
    value = typeof value === "string" ? value.toUpperCase() : value;
    if (!CURRENCY.test(String(value || ""))) return invalid("invalid_currency", "value");
  } else if (key === "fiscal_year_start_month") {
    if (!entitySlug || !Number.isSafeInteger(value) || value < 1 || value > 12) {
      return invalid("invalid_preference_value", "value");
    }
  } else if (key === "activity_window_days") {
    if (entitySlug !== null || !Number.isSafeInteger(value) || value < 1 || value > 365) {
      return invalid("invalid_preference_value", "value");
    }
  } else {
    return invalid("invalid_preference_key", "preference_key");
  }
  const normalized = {
    request_id: requestId, entity_slug: entitySlug, preference_key: key, value,
  };
  const requestHash = await sha256(normalized);
  const replay = await replayFor(env, { requestId, actionType: "preference_set", requestHash });
  if (replay) return replay;
  const scopeKey = entitySlug || "global";
  let prior;
  try {
    prior = await env.DB.prepare(
      `SELECT preference_row_id,created_at,entity_slug,preference_key,value_json,updated_at FROM owner_preferences
        WHERE tenant_id=?1 AND scope_key=?2 AND preference_key=?3`
    ).bind(OWNER_TENANT, scopeKey, key).first();
  } catch {
    return unavailable("preferences_unavailable");
  }
  const at = new Date().toISOString();
  const preference = { entity_slug: entitySlug, preference_key: key, value, updated_at: at };
  let priorValue;
  try { priorValue = prior ? JSON.parse(prior.value_json) : undefined; } catch { priorValue = undefined; }
  const isUnchanged = Boolean(prior) && canonical(priorValue) === canonical(value);
  const eventId = isUnchanged ? null : activityId(requestId, "preference_set");
  if (isUnchanged) {
    const response = {
      request_id: requestId,
      entity_scope: { entity_slug: entitySlug },
      preference: rowPreference(prior),
      changed: false,
      activity_event_id: null,
      replayed: false,
    };
    try {
      await actionReceiptStatement(env, {
        requestId, actionType: "preference_set", requestHash, response, status: 200, at,
      }).run();
    } catch {
      return unavailable("preference_write_unavailable");
    }
    return respond(response, 200);
  }
  const response = {
    request_id: requestId,
    entity_scope: { entity_slug: entitySlug },
    preference,
    changed: true,
    activity_event_id: eventId,
    replayed: false,
  };
  const status = prior ? 200 : 201;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO owner_preferences
           (preference_row_id,tenant_id,scope_key,entity_slug,preference_key,value_json,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(tenant_id,scope_key,preference_key) DO UPDATE SET
           value_json=excluded.value_json,updated_at=excluded.updated_at`
      ).bind(
        prior?.preference_row_id || `preference_${crypto.randomUUID()}`, OWNER_TENANT,
        scopeKey, entitySlug, key, JSON.stringify(value), prior?.created_at || at, at,
      ),
      activityStatement(env, {
        eventId, eventType: "preference_set", entitySlug, subjectKind: "preference",
        subjectId: `${scopeKey}:${key}`, displayLabel: key.replace(/_/g, " "),
        occurredAt: at, requestId,
      }),
      actionReceiptStatement(env, {
        requestId, actionType: "preference_set", requestHash, response, status, at,
      }),
    ]);
  } catch {
    return unavailable("preference_write_unavailable");
  }
  return respond(response, status);
}

/** Route dispatcher mounted before the admin-key gate in index.js. */
export async function handleOwnerActions(env, request, path, { ingestEnvelope, afterIngest } = {}) {
  if (request.method !== "POST") return respond({ error: "method not allowed" }, 405);
  const authFailure = await requireOwner(request, env);
  if (authFailure) return authFailure;
  if (path === "/api/owner/uploads/capabilities") return respond(UPLOAD_CAPABILITIES);

  try {
    if (!(await ownerWorkspaceInstalled(env))) {
      return unavailable("owner_workspace_unavailable");
    }
  } catch {
    return unavailable("owner_workspace_unavailable");
  }
  const body = await readBody(request);
  if (!body) return invalid("invalid_json_body");

  const writesPaused = env.VECTOR_DRAIN_MODE === "paused-for-upgrade";
  const readPaths = new Set([
    "/api/owner/period-closes/read", "/api/owner/activity",
    "/api/owner/targets/read", "/api/owner/preferences/read",
  ]);
  if (writesPaused && !readPaths.has(path)) {
    return unavailable("owner_writes_paused", { paused: true });
  }

  try {
    if (path === "/api/owner/uploads") return await upload(env, body, ingestEnvelope, afterIngest);
    if (path === "/api/owner/approvals") return await approval(env, body);
    if (path === "/api/owner/period-closes/read") return await periodRead(env, body);
    if (path === "/api/owner/period-closes/accept") return await periodWrite(env, body, "accept");
    if (path === "/api/owner/period-closes/reopen") return await periodWrite(env, body, "reopen");
    if (path === "/api/owner/activity") return await activityRead(env, body);
    if (path === "/api/owner/targets/read") return await targetsRead(env, body);
    if (path === "/api/owner/targets/upsert") return await targetWrite(env, body, "upsert");
    if (path === "/api/owner/targets/archive") return await targetWrite(env, body, "archive");
    if (path === "/api/owner/preferences/read") return await preferencesRead(env, body);
    if (path === "/api/owner/preferences/set") return await preferenceSet(env, body);
    return respond({ error: "not found" }, 404);
  } catch {
    return unavailable("owner_workspace_unavailable");
  }
}
