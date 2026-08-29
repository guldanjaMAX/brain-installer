/** Exact-document authorization for scoped passkey sessions. */

import { randomToken, sha256Hex } from "./auth-store.js";

export const DOCUMENT_GRANT_MAX_DOCUMENTS = 100;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ENTITY_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export class DocumentAccessError extends Error {
  constructor(message, status = 400, code = "invalid_document_access_request") {
    super(message);
    this.name = "DocumentAccessError";
    this.status = status;
    this.code = code;
  }
}

export class DocumentAccessUnavailableError extends DocumentAccessError {
  constructor(message = "document authorization is unavailable") {
    super(message, 503, "document_access_unavailable");
    this.name = "DocumentAccessUnavailableError";
  }
}

function unavailable(error) {
  if (error instanceof DocumentAccessError) throw error;
  throw new DocumentAccessUnavailableError();
}

function canonicalDocuments(value) {
  if (!Array.isArray(value)) {
    throw new DocumentAccessError("document_ids must be an array", 400, "document_ids_required");
  }
  const out = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))].sort();
  if (!out.length) {
    throw new DocumentAccessError("at least one document_id is required", 400, "document_ids_required");
  }
  if (out.length > DOCUMENT_GRANT_MAX_DOCUMENTS) {
    throw new DocumentAccessError(
      `at most ${DOCUMENT_GRANT_MAX_DOCUMENTS} document_ids may be granted at once`,
      413,
      "document_grant_too_large",
    );
  }
  if (out.some((id) => id.length > 512)) {
    throw new DocumentAccessError("a document_id is too long", 400, "invalid_document_id");
  }
  return out;
}

function normalizedCreate(input) {
  const requestId = String(input?.request_id || "").trim();
  const subjectLabel = String(input?.subject_label || "").trim();
  const entitySlug = String(input?.entity_slug || "").trim().toLowerCase();
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new DocumentAccessError("request_id must be 8-128 stable characters", 400, "invalid_request_id");
  }
  if (!subjectLabel || subjectLabel.length > 120) {
    throw new DocumentAccessError("subject_label must be 1-120 characters", 400, "invalid_subject_label");
  }
  if (!ENTITY_SLUG_RE.test(entitySlug)) {
    throw new DocumentAccessError("entity_slug is invalid", 400, "invalid_entity_slug");
  }
  const expiresAt = input?.expires_at === undefined || input?.expires_at === null
    ? null
    : Number(input.expires_at);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new DocumentAccessError("expires_at must be a future unix ms timestamp or null", 400, "invalid_expiry");
  }
  return {
    requestId,
    subjectLabel,
    entitySlug,
    documentIds: canonicalDocuments(input?.document_ids),
    expiresAt,
  };
}

async function requestFingerprint(value) {
  return sha256Hex(JSON.stringify(value));
}

function b64u(bytes) {
  let ascii = "";
  for (const byte of bytes) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function enrollmentCode(env, requestId, grantId) {
  if (!env.SESSION_SIGNING_KEY) throw new DocumentAccessUnavailableError("session signing is unavailable");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`document-enrollment\0${requestId}\0${grantId}`),
  );
  return b64u(new Uint8Array(signature)).slice(0, 32);
}

async function inviteReceipt(env, requestId, grantId) {
  const code = await enrollmentCode(env, requestId, grantId);
  const row = await env.DB.prepare(
    "SELECT expires_at, used_at FROM enrollment_codes WHERE code_hash = ? AND document_grant_id = ?",
  ).bind(await sha256Hex(code), grantId).first();
  if (!row) throw new DocumentAccessUnavailableError("the enrollment receipt is missing");
  if (row.used_at) return { invite_state: "consumed", enrollment_code: null };
  if (Number(row.expires_at) <= Date.now()) return { invite_state: "expired", enrollment_code: null };
  return {
    invite_state: "active",
    enrollment_code: code,
    enrollment_expires_at: Number(row.expires_at),
  };
}

async function priorRequest(env, requestId, action, fingerprint) {
  const row = await env.DB.prepare(
    "SELECT action, request_fingerprint, response_json FROM document_access_requests WHERE request_id = ?",
  ).bind(requestId).first();
  if (!row) return null;
  if (row.action !== action || row.request_fingerprint !== fingerprint) {
    throw new DocumentAccessError(
      "request_id was already used for a different document access change",
      409,
      "idempotency_conflict",
    );
  }
  try {
    return JSON.parse(row.response_json);
  } catch {
    throw new DocumentAccessUnavailableError();
  }
}

async function requireEntityDocuments(env, entitySlug, documentIds) {
  const columns = await env.DB.prepare("PRAGMA table_info(documents)").all();
  if (!(columns?.results || []).some((column) => column.name === "entity_slug")) {
    throw new DocumentAccessUnavailableError("document entity scope has not been migrated");
  }

  const found = new Map();
  for (let start = 0; start < documentIds.length; start += 50) {
    const batch = documentIds.slice(start, start + 50);
    const placeholders = batch.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT doc_uid, entity_slug FROM documents WHERE doc_uid IN (${placeholders})`,
    ).bind(...batch).all();
    for (const row of rows?.results || []) found.set(row.doc_uid, row.entity_slug);
  }
  const missing = documentIds.filter((id) => !found.has(id));
  if (missing.length) {
    throw new DocumentAccessError("one or more documents do not exist", 404, "document_not_found");
  }
  if (documentIds.some((id) => found.get(id) !== entitySlug)) {
    throw new DocumentAccessError(
      "every document must belong to the selected entity",
      403,
      "cross_entity_document_forbidden",
    );
  }
}

export async function createDocumentGrant(env, input) {
  const normalized = normalizedCreate(input);
  const fingerprint = await requestFingerprint(normalized);
  try {
    const prior = await priorRequest(env, normalized.requestId, "create", fingerprint);
    if (prior) {
      return {
        ...prior,
        ...await inviteReceipt(env, normalized.requestId, prior.grant_id),
        replayed: true,
      };
    }

    await requireEntityDocuments(env, normalized.entitySlug, normalized.documentIds);
    const requestHash = await sha256Hex(normalized.requestId);
    const grantId = `dg_${requestHash.slice(0, 28)}`;
    const code = await enrollmentCode(env, normalized.requestId, grantId);
    const createdAt = Date.now();
    const response = {
      status: "active",
      grant_id: grantId,
      subject_label: normalized.subjectLabel,
      entity_slug: normalized.entitySlug,
      document_ids: normalized.documentIds,
      expires_at: normalized.expiresAt,
      created_at: createdAt,
    };
    const statements = [
      env.DB.prepare(
        `INSERT INTO document_access_grants
         (grant_id, subject_label, entity_slug, expires_at, created_at, created_by, revoked_at,
          create_request_id, request_fingerprint)
         VALUES (?, ?, ?, ?, ?, 'owner', NULL, ?, ?)`,
      ).bind(
        grantId, normalized.subjectLabel, normalized.entitySlug, normalized.expiresAt,
        createdAt, normalized.requestId, fingerprint,
      ),
      env.DB.prepare(
        `INSERT INTO document_access_documents
         (grant_id, document_id, entity_slug, granted_at, revoked_at)
         SELECT ?, value, ?, ?, NULL FROM json_each(?)`,
      ).bind(
        grantId, normalized.entitySlug, createdAt, JSON.stringify(normalized.documentIds),
      ),
      env.DB.prepare(
        "INSERT INTO enrollment_codes (code_hash, expires_at, document_grant_id) VALUES (?, ?, ?)",
      ).bind(await sha256Hex(code), createdAt + 15 * 60 * 1000, grantId),
      env.DB.prepare(
        `INSERT INTO document_access_events
         (event_id, occurred_at, request_id, actor_kind, grant_id, entity_slug, event_type,
          decision, reason_code, document_count)
         VALUES (?, ?, ?, 'owner', ?, ?, 'grant_created', 'allow', 'owner_created_exact_grant', ?)`,
      ).bind(
        `dae_${randomToken(18)}`, createdAt, normalized.requestId, grantId,
        normalized.entitySlug, normalized.documentIds.length,
      ),
      env.DB.prepare(
        `INSERT INTO document_access_requests
         (request_id, action, request_fingerprint, response_json, created_at)
         VALUES (?, 'create', ?, ?, ?)`,
      ).bind(normalized.requestId, fingerprint, JSON.stringify(response), createdAt),
    ];
    await env.DB.batch(statements);
    return {
      ...response,
      invite_state: "active",
      enrollment_code: code,
      enrollment_expires_at: createdAt + 15 * 60 * 1000,
      replayed: false,
    };
  } catch (error) {
    // A concurrent retry can lose the insert race while the winning batch
    // commits. Re-read the idempotency row before classifying the store down.
    try {
      const prior = await priorRequest(env, normalized.requestId, "create", fingerprint);
      if (prior) {
        return {
          ...prior,
          ...await inviteReceipt(env, normalized.requestId, prior.grant_id),
          replayed: true,
        };
      }
    } catch (retryError) {
      if (retryError instanceof DocumentAccessError) throw retryError;
    }
    unavailable(error);
  }
}

export async function reissueDocumentGrantInvite(env, input) {
  const requestId = String(input?.request_id || "").trim();
  const grantId = String(input?.grant_id || "").trim();
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new DocumentAccessError("request_id must be 8-128 stable characters", 400, "invalid_request_id");
  }
  if (!/^dg_[a-f0-9]{28}$/.test(grantId)) {
    throw new DocumentAccessError("grant_id is invalid", 400, "invalid_grant_id");
  }
  const fingerprint = await requestFingerprint({ requestId, grantId });
  try {
    const prior = await priorRequest(env, requestId, "reissue", fingerprint);
    if (prior) return { ...prior, ...await inviteReceipt(env, requestId, grantId), replayed: true };

    const grant = await env.DB.prepare(
      "SELECT entity_slug, revoked_at, expires_at FROM document_access_grants WHERE grant_id = ?",
    ).bind(grantId).first();
    if (!grant) throw new DocumentAccessError("grant not found", 404, "grant_not_found");
    if (grant.revoked_at || (grant.expires_at && Number(grant.expires_at) <= Date.now())) {
      throw new DocumentAccessError("grant is not active", 403, "document_grant_inactive");
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + 15 * 60 * 1000;
    const code = await enrollmentCode(env, requestId, grantId);
    const response = {
      status: "active",
      grant_id: grantId,
      invite_state: "active",
      enrollment_expires_at: expiresAt,
    };
    await env.DB.batch([
      // End every still-usable prior invite for this grant. Used/expired rows
      // remain as history; no code is deleted or silently repurposed.
      env.DB.prepare(
        `UPDATE enrollment_codes SET used_at = ?
         WHERE document_grant_id = ? AND used_at IS NULL AND expires_at > ?`,
      ).bind(issuedAt, grantId, issuedAt),
      env.DB.prepare(
        "INSERT INTO enrollment_codes (code_hash, expires_at, document_grant_id) VALUES (?, ?, ?)",
      ).bind(await sha256Hex(code), expiresAt, grantId),
      env.DB.prepare(
        `INSERT INTO document_access_events
         (event_id, occurred_at, request_id, actor_kind, grant_id, entity_slug, event_type,
          decision, reason_code, document_count)
         SELECT ?, ?, ?, 'owner', g.grant_id, g.entity_slug, 'invite_reissued', 'allow',
                'owner_reissued_scoped_invite', count(d.document_id)
         FROM document_access_grants g
         LEFT JOIN document_access_documents d ON d.grant_id = g.grant_id
         WHERE g.grant_id = ? GROUP BY g.grant_id, g.entity_slug`,
      ).bind(`dae_${randomToken(18)}`, issuedAt, requestId, grantId),
      env.DB.prepare(
        `INSERT INTO document_access_requests
         (request_id, action, request_fingerprint, response_json, created_at)
         VALUES (?, 'reissue', ?, ?, ?)`,
      ).bind(requestId, fingerprint, JSON.stringify(response), issuedAt),
    ]);
    return { ...response, enrollment_code: code, replayed: false };
  } catch (error) {
    if (error instanceof DocumentAccessError) throw error;
    unavailable(error);
  }
}

export async function revokeDocumentGrant(env, input) {
  const requestId = String(input?.request_id || "").trim();
  const grantId = String(input?.grant_id || "").trim();
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new DocumentAccessError("request_id must be 8-128 stable characters", 400, "invalid_request_id");
  }
  if (!/^dg_[a-f0-9]{28}$/.test(grantId)) {
    throw new DocumentAccessError("grant_id is invalid", 400, "invalid_grant_id");
  }
  const fingerprint = await requestFingerprint({ requestId, grantId });
  try {
    const prior = await priorRequest(env, requestId, "revoke", fingerprint);
    if (prior) return { ...prior, replayed: true };
    const grant = await env.DB.prepare(
      "SELECT grant_id, entity_slug, revoked_at FROM document_access_grants WHERE grant_id = ?",
    ).bind(grantId).first();
    if (!grant) throw new DocumentAccessError("grant not found", 404, "grant_not_found");
    const revokedAt = Number(grant.revoked_at || 0) || Date.now();
    const changed = !grant.revoked_at;
    const response = { status: "revoked", grant_id: grantId, revoked_at: revokedAt, changed };
    if (!changed) {
      await env.DB.prepare(
        `INSERT INTO document_access_requests
         (request_id, action, request_fingerprint, response_json, created_at)
         VALUES (?, 'revoke', ?, ?, ?)`,
      ).bind(requestId, fingerprint, JSON.stringify(response), Date.now()).run();
      return { ...response, replayed: false };
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE document_access_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
      ).bind(revokedAt, grantId),
      env.DB.prepare(
        "UPDATE document_access_documents SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
      ).bind(revokedAt, grantId),
      env.DB.prepare(
        `INSERT INTO document_access_events
         (event_id, occurred_at, request_id, actor_kind, grant_id, entity_slug, event_type,
          decision, reason_code, document_count)
         SELECT ?, ?, ?, 'owner', g.grant_id, g.entity_slug, 'grant_revoked', 'allow',
                'owner_revoked_grant', count(d.document_id)
         FROM document_access_grants g
         LEFT JOIN document_access_documents d ON d.grant_id = g.grant_id
         WHERE g.grant_id = ? GROUP BY g.grant_id, g.entity_slug`,
      ).bind(`dae_${randomToken(18)}`, revokedAt, requestId, grantId),
      env.DB.prepare(
        `INSERT INTO document_access_requests
         (request_id, action, request_fingerprint, response_json, created_at)
         VALUES (?, 'revoke', ?, ?, ?)`,
      ).bind(requestId, fingerprint, JSON.stringify(response), revokedAt),
    ]);
    return { ...response, replayed: false };
  } catch (error) {
    if (error instanceof DocumentAccessError) throw error;
    unavailable(error);
  }
}

export async function listDocumentGrants(env) {
  try {
    const [grantRows, documentRows] = await Promise.all([
      env.DB.prepare(
        `SELECT grant_id, subject_label, entity_slug, expires_at, created_at, revoked_at
         FROM document_access_grants ORDER BY created_at DESC`,
      ).all(),
      env.DB.prepare(
        `SELECT grant_id, document_id, entity_slug, granted_at, revoked_at
         FROM document_access_documents ORDER BY grant_id, document_id`,
      ).all(),
    ]);
    const documents = new Map();
    for (const row of documentRows?.results || []) {
      const list = documents.get(row.grant_id) || [];
      list.push({
        document_id: row.document_id,
        entity_slug: row.entity_slug,
        granted_at: Number(row.granted_at),
        revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
      });
      documents.set(row.grant_id, list);
    }
    return {
      status: "ready",
      scope_rule: "exact_document_ids_only",
      default_access: "owner_only",
      grants: (grantRows?.results || []).map((row) => ({
        grant_id: row.grant_id,
        subject_label: row.subject_label,
        entity_slug: row.entity_slug,
        state: row.revoked_at ? "revoked" : (row.expires_at && Number(row.expires_at) <= Date.now() ? "expired" : "active"),
        expires_at: row.expires_at === null ? null : Number(row.expires_at),
        created_at: Number(row.created_at),
        revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
        documents: documents.get(row.grant_id) || [],
      })),
    };
  } catch (error) {
    unavailable(error);
  }
}

export async function listGrantedDocuments(env, principal) {
  if (!principal || principal.kind !== "grant" || principal.denied) {
    throw new DocumentAccessError("a live document grant is required", 403, "document_grant_required");
  }
  try {
    const rows = await env.DB.prepare(
      `SELECT d.doc_uid document_id, d.title, d.source, d.document_date,
              d.date_source, d.date_reliable, d.text_source, d.text_reliable
       FROM document_access_documents a
       JOIN documents d ON d.doc_uid = a.document_id AND d.entity_slug = a.entity_slug
       WHERE a.grant_id = ? AND a.entity_slug = ? AND a.revoked_at IS NULL
       ORDER BY COALESCE(d.document_date, 0) DESC, d.doc_uid`,
    ).bind(principal.grantId, principal.entitySlug).all();
    return {
      status: "ready",
      principal: {
        kind: "grant",
        grant_id: principal.grantId,
        entity_slug: principal.entitySlug,
      },
      scope_rule: "exact_document_ids_only",
      documents: (rows?.results || []).map((row) => ({
        document_id: row.document_id,
        title: row.title || "Untitled document",
        source: row.source,
        document_date: row.document_date === null ? null : Number(row.document_date),
        date_source: row.date_source || null,
        date_reliable: row.date_reliable === 1 || row.date_reliable === true,
        text_source: row.text_source || "native",
        text_reliable: row.text_reliable !== 0 && row.text_reliable !== false,
      })),
    };
  } catch (error) {
    unavailable(error);
  }
}

export async function documentGrantPrincipal(env, grantId) {
  try {
    const grant = await env.DB.prepare(
      `SELECT grant_id, entity_slug, expires_at, revoked_at
       FROM document_access_grants WHERE grant_id = ?`,
    ).bind(grantId).first();
    if (!grant || grant.revoked_at || (grant.expires_at && Number(grant.expires_at) <= Date.now())) {
      return { denied: true, code: "document_grant_inactive" };
    }
    const count = await env.DB.prepare(
      `SELECT count(*) count
       FROM document_access_documents a
       JOIN documents d ON d.doc_uid = a.document_id AND d.entity_slug = a.entity_slug
       WHERE a.grant_id = ? AND a.revoked_at IS NULL AND a.entity_slug = ?
      `,
    ).bind(grantId, grant.entity_slug).first();
    const documentCount = Number(count?.count || 0);
    if (!documentCount) return { denied: true, code: "document_grant_empty" };
    return {
      kind: "grant",
      grantId: grant.grant_id,
      entitySlug: grant.entity_slug,
      documentCount,
    };
  } catch (error) {
    unavailable(error);
  }
}

export async function recordDocumentAccessDecision(env, principal, {
  route, decision, reasonCode, documentId = null, documentCount = 0,
}) {
  try {
    await env.DB.prepare(
      `INSERT INTO document_access_events
       (event_id, occurred_at, actor_kind, grant_id, entity_slug, document_id, route,
        event_type, decision, reason_code, document_count)
       VALUES (?, ?, 'grant', ?, ?, ?, ?, 'document_read', ?, ?, ?)`,
    ).bind(
      `dae_${randomToken(18)}`, Date.now(), principal?.grantId || null,
      principal?.entitySlug || null, documentId, route, decision, reasonCode,
      Number(documentCount || 0),
    ).run();
  } catch (error) {
    unavailable(error);
  }
}
