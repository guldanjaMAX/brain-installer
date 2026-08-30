/**
 * Destructive corpus actions are an owner ceremony, never an agent tool call.
 *
 * Agents and the owner may create a bounded preview receipt. The server stores
 * only its hash and binds it to the exact principal, owner entity, sorted ids,
 * current content digest, count and expiry. Consuming it requires a new
 * receipt-bound owner passkey assertion. A claimed execution is single-writer;
 * an exact retry after response loss observes either all rows present or all
 * rows absent and never performs a second mutation.
 */

import { jsonResponse, privateNoStore } from "./core.js";
import { ownerSessionPrincipal } from "./owner-auth.js";
import { issueChallenge, randomToken, sha256Hex, findPasskey } from "./auth-store.js";
import { verifyAssertion, b64uDecode } from "./webauthn.js";
import { ownerActivityStatement } from "./owner-activity.js";
import { normalizeAgentProfile, profileHas } from "./agent-authority.js";

export const AGENT_DELETION_PATH_PREFIX = "/api/owner/corpus-deletions/";

const TENANT_ID = "primary";
const RECEIPT_TTL_MS = 5 * 60 * 1000;
const EXECUTION_LEASE_MS = 30 * 1000;
const MAX_DOCUMENTS = 50;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ENTITY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const response = (value, status = 200) => privateNoStore(jsonResponse(value, status));
const unavailable = () => response({ error: "unavailable", code: "agent_action_store_unavailable" }, 503);

function exactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

async function requestBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeDocumentIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DOCUMENTS) return null;
  const ids = value.map((item) => String(item || "").trim());
  if (ids.some((id) => !id || id.length > 240)) return null;
  const unique = [...new Set(ids)].sort();
  return unique.length === ids.length ? unique : null;
}

async function ownedEntity(env, entitySlug) {
  return env.DB.prepare(
    `SELECT entity_slug, COALESCE(display_label, legal_name, entity_slug) AS display_label
       FROM fin_entities
      WHERE tenant_id = ? AND entity_slug = ? AND relationship = 'owned'
        AND basis_state = 'confirmed' AND superseded_by_id IS NULL
      ORDER BY id DESC LIMIT 1`,
  ).bind(TENANT_ID, entitySlug).first();
}

async function selectedDocuments(env, entitySlug, documentIds) {
  const marks = documentIds.map((_, index) => `?${index + 2}`).join(",");
  const { results } = await env.DB.prepare(
    `SELECT d.doc_uid, d.content_hash, COUNT(c.chunk_uid) AS chunk_count
       FROM documents d LEFT JOIN chunks c ON c.doc_uid = d.doc_uid
      WHERE d.entity_slug = ?1 AND d.deleted_at IS NULL AND d.doc_uid IN (${marks})
      GROUP BY d.doc_uid, d.content_hash
      ORDER BY d.doc_uid`,
  ).bind(entitySlug, ...documentIds).all();
  return results || [];
}

async function selectionDigest(entitySlug, rows) {
  return sha256Hex(canonical({
    entity_slug: entitySlug,
    documents: rows.map((row) => ({
      doc_uid: String(row.doc_uid),
      content_hash: String(row.content_hash),
      chunk_count: Number(row.chunk_count || 0),
    })),
  }));
}

async function snapshot(env, receipt) {
  const ids = JSON.parse(receipt.document_ids_json);
  const rows = await selectedDocuments(env, receipt.entity_slug, ids);
  if (rows.length === 0) return { state: "absent", rows, ids };
  if (rows.length !== ids.length) return { state: "changed", rows, ids };
  const digest = await selectionDigest(receipt.entity_slug, rows);
  return {
    state: digest === receipt.selection_digest ? "unchanged" : "changed",
    rows,
    ids,
    digest,
  };
}

async function loadReceipt(env, token) {
  if (!RECEIPT_PATTERN.test(String(token || ""))) return null;
  return env.DB.prepare(
    `SELECT receipt_hash, principal_kind, principal_id_hash, agent_profile,
            entity_slug, document_ids_json, document_count, chunk_count,
            selection_digest, expires_at, state, request_id, request_hash,
            confirmed_at, executing_at, completed_at, response_json, response_status
       FROM agent_action_receipts
      WHERE tenant_id = ? AND receipt_hash = ?`,
  ).bind(TENANT_ID, await sha256Hex(token)).first();
}

/** Create a server-bound preview for an owner or a break-glass connector. */
export async function createAgentDeletionPreview(env, {
  entitySlug,
  documentIds,
  principalKind,
  principalIdHash,
  agentProfile,
  now = Date.now(),
} = {}) {
  const normalizedEntity = String(entitySlug || "").trim();
  const ids = normalizeDocumentIds(documentIds);
  const profile = agentProfile === "owner" ? "owner" : normalizeAgentProfile(agentProfile);
  if (!ENTITY_PATTERN.test(normalizedEntity) || !ids) {
    return { ok: false, status: 400, body: { error: "invalid request", code: "deletion_scope_invalid" } };
  }
  if (principalKind === "oauth_connector" && !profileHas(profile, "corpus:delete:preview")) {
    return { ok: false, status: 403, body: { error: "forbidden", code: "break_glass_profile_required" } };
  }
  if (!['owner', 'oauth_connector'].includes(principalKind) || !/^[a-f0-9]{64}$/.test(String(principalIdHash || ""))) {
    return { ok: false, status: 403, body: { error: "forbidden", code: "principal_binding_invalid" } };
  }
  const entity = await ownedEntity(env, normalizedEntity);
  if (!entity) {
    return { ok: false, status: 404, body: { error: "not found", code: "owned_entity_not_found" } };
  }
  const rows = await selectedDocuments(env, normalizedEntity, ids);
  // Missing and cross-entity ids use one response so the preview is not an
  // oracle for documents outside the exact owner scope.
  if (rows.length !== ids.length) {
    return { ok: false, status: 404, body: { error: "not found", code: "deletion_documents_not_found" } };
  }
  const digest = await selectionDigest(normalizedEntity, rows);
  const chunkCount = rows.reduce((sum, row) => sum + Number(row.chunk_count || 0), 0);
  const receipt = randomToken(32);
  const expiresAt = now + RECEIPT_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO agent_action_receipts
       (receipt_hash, tenant_id, action_type, principal_kind, principal_id_hash,
        agent_profile, entity_slug, document_ids_json, document_count, chunk_count,
        selection_digest, expires_at, state, created_at)
     VALUES (?, ?, 'corpus_deletion', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?)`,
  ).bind(
    await sha256Hex(receipt), TENANT_ID, principalKind, principalIdHash, profile,
    normalizedEntity, JSON.stringify(ids), ids.length, chunkCount, digest, expiresAt, now,
  ).run();
  return {
    ok: true,
    status: 200,
    body: {
      destructive: false,
      receipt,
      entity_slug: normalizedEntity,
      entity_label: String(entity.display_label || normalizedEntity).slice(0, 160),
      document_ids: ids,
      document_count: ids.length,
      chunk_count: chunkCount,
      selection_digest: digest,
      expires_at: expiresAt,
      requires: "fresh_owner_passkey",
    },
  };
}

async function requireOwner(request, env) {
  const principal = await ownerSessionPrincipal(request, env);
  return principal?.kind === "owner" && principal.grantId === null ? principal : null;
}

function challengeFromClientData(clientDataJSON) {
  try {
    return JSON.parse(new TextDecoder().decode(b64uDecode(clientDataJSON)))?.challenge || null;
  } catch {
    return null;
  }
}

function challengePurpose(receipt) {
  return `corpus-delete:${receipt.receipt_hash}:${receipt.selection_digest}`;
}

function batchChanged(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

async function completedResponse(receipt) {
  if (!receipt?.response_json || !receipt?.response_status) return null;
  const body = JSON.parse(receipt.response_json);
  return response({ ...body, replayed: true }, Number(receipt.response_status));
}

async function confirmReceipt(env, request, receipt, payload, now) {
  const challenge = challengeFromClientData(payload.clientDataJSON);
  if (!challenge) return { error: response({ error: "forbidden", code: "passkey_challenge_invalid" }, 403) };
  const challengeHash = await sha256Hex(challenge);
  const purpose = challengePurpose(receipt);
  const challengeRow = await env.DB.prepare(
    "SELECT purpose, expires_at FROM auth_challenges WHERE challenge_hash = ?",
  ).bind(challengeHash).first();
  if (!challengeRow || challengeRow.purpose !== purpose || Number(challengeRow.expires_at) <= now) {
    return { error: response({ error: "forbidden", code: "passkey_challenge_invalid" }, 403) };
  }
  const credential = await findPasskey(env, String(payload.credentialId || ""));
  if (!credential || credential.grant_id !== null || credential.document_grant_id !== null) {
    return { error: response({ error: "forbidden", code: "owner_passkey_required" }, 403) };
  }
  const url = new URL(request.url);
  let verdict;
  try {
    verdict = await verifyAssertion({
      authenticatorData: payload.authenticatorData,
      clientDataJSON: payload.clientDataJSON,
      signature: payload.signature,
      expectedChallenge: challenge,
      expectedOrigin: url.origin,
      rpId: env.WEBAUTHN_RP_ID || url.hostname,
      credential,
    });
  } catch {
    return { error: response({ error: "forbidden", code: "passkey_verification_failed" }, 403) };
  }
  if (verdict.cloneSuspected) {
    return { error: response({ error: "forbidden", code: "passkey_counter_regressed" }, 403) };
  }
  const requestHash = await sha256Hex(canonical(payload));
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_action_receipts
          SET state = 'confirmed', request_id = ?, request_hash = ?, confirmed_at = ?
        WHERE receipt_hash = ? AND tenant_id = ? AND state = 'previewed'
          AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM auth_challenges
             WHERE challenge_hash = ? AND purpose = ? AND expires_at > ?
          )`,
    ).bind(payload.request_id, requestHash, now, receipt.receipt_hash, TENANT_ID, now, challengeHash, purpose, now),
    env.DB.prepare(
      `UPDATE owner_passkeys
          SET sign_count = ?, last_used_at = ?
        WHERE credential_id = ? AND sign_count = ?
          AND grant_id IS NULL AND document_grant_id IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_action_receipts
             WHERE receipt_hash = ? AND state = 'confirmed'
               AND request_id = ? AND request_hash = ?
          )
          AND EXISTS (
            SELECT 1 FROM auth_challenges
             WHERE challenge_hash = ? AND purpose = ? AND expires_at > ?
          )`,
    ).bind(
      verdict.signCount, now, credential.credential_id, Number(credential.sign_count || 0),
      receipt.receipt_hash, payload.request_id, requestHash, challengeHash, purpose, now,
    ),
    env.DB.prepare(
      `DELETE FROM auth_challenges
        WHERE challenge_hash = ? AND purpose = ? AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM agent_action_receipts
             WHERE receipt_hash = ? AND state = 'confirmed'
               AND request_id = ? AND request_hash = ?
          )`,
    ).bind(challengeHash, purpose, now, receipt.receipt_hash, payload.request_id, requestHash),
  ]);
  if (results.some((result) => batchChanged(result) !== 1)) {
    return { error: response({ error: "conflict", code: "passkey_confirmation_raced" }, 409) };
  }
  return { requestHash };
}

async function finalize(env, receipt, mutation, now, replayed = false) {
  const result = {
    deleted: true,
    entity_slug: receipt.entity_slug,
    document_count: Number(receipt.document_count),
    chunk_count: Number(receipt.chunk_count),
    vector_cleanup_queued: Number(mutation?.vector_cleanup_queued ?? receipt.chunk_count),
    selection_digest: receipt.selection_digest,
    request_id: receipt.request_id,
    replayed,
  };
  const encoded = JSON.stringify(result);
  const eventKey = receipt.receipt_hash.slice(0, 24);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_action_receipts
          SET state = 'completed', completed_at = ?, response_json = ?, response_status = 200
        WHERE receipt_hash = ? AND tenant_id = ? AND state = 'executing'
          AND request_id = ? AND request_hash = ?`,
    ).bind(now, encoded, receipt.receipt_hash, TENANT_ID, receipt.request_id, receipt.request_hash),
    ownerActivityStatement(env, {
      eventId: `activity:corpus-deletion:${eventKey}`,
      eventType: "corpus_deletion_completed",
      entitySlug: receipt.entity_slug,
      subjectKind: "corpus_deletion",
      subjectId: `deletion:${receipt.selection_digest.slice(0, 24)}`,
      displayLabel: `Deleted ${receipt.document_count} document(s) from ${receipt.entity_slug}`,
      occurredAt: new Date(now).toISOString(),
      requestId: receipt.request_id,
    }),
  ]);
  if (batchChanged(results[0]) !== 1) {
    const current = await env.DB.prepare(
      "SELECT response_json, response_status FROM agent_action_receipts WHERE receipt_hash = ?",
    ).bind(receipt.receipt_hash).first();
    const replay = await completedResponse(current);
    if (replay) return replay;
    return response({ error: "conflict", code: "deletion_finalize_conflict" }, 409);
  }
  return response(result);
}

async function executeReceipt(env, request, receipt, payload, deps, now) {
  const requestHash = await sha256Hex(canonical(payload));
  if (receipt.request_id && (receipt.request_id !== payload.request_id || receipt.request_hash !== requestHash)) {
    return response({ error: "conflict", code: "receipt_replayed_or_altered" }, 409);
  }
  if (receipt.state === "completed") return completedResponse(receipt);
  if (receipt.state === "invalidated") return response({ error: "conflict", code: "receipt_invalidated" }, 409);
  if (receipt.state === "previewed") {
    if (Number(receipt.expires_at) <= now) return response({ error: "gone", code: "receipt_expired" }, 410);
    const existingRequest = await env.DB.prepare(
      `SELECT receipt_hash FROM agent_action_receipts
        WHERE tenant_id = ? AND request_id = ? LIMIT 1`,
    ).bind(TENANT_ID, payload.request_id).first();
    if (existingRequest && existingRequest.receipt_hash !== receipt.receipt_hash) {
      return response({ error: "conflict", code: "request_id_conflict" }, 409);
    }
    const confirmed = await confirmReceipt(env, request, receipt, payload, now);
    if (confirmed.error) return confirmed.error;
    receipt = await loadReceipt(env, payload.receipt);
  }
  if (!receipt || receipt.request_id !== payload.request_id || receipt.request_hash !== requestHash) {
    return response({ error: "conflict", code: "receipt_replayed_or_altered" }, 409);
  }

  let claimedHere = false;
  if (receipt.state === "confirmed") {
    const claim = await env.DB.prepare(
      `UPDATE agent_action_receipts SET state = 'executing', executing_at = ?
        WHERE receipt_hash = ? AND tenant_id = ? AND state = 'confirmed'
          AND request_id = ? AND request_hash = ?`,
    ).bind(now, receipt.receipt_hash, TENANT_ID, receipt.request_id, receipt.request_hash).run();
    if (batchChanged(claim) !== 1) receipt = await loadReceipt(env, payload.receipt);
    else {
      claimedHere = true;
      receipt = { ...receipt, state: "executing", executing_at: now };
    }
  }
  if (receipt.state === "completed") return completedResponse(receipt);
  if (receipt.state !== "executing") {
    return response({ error: "conflict", code: "receipt_not_executable" }, 409);
  }

  let current = await snapshot(env, receipt);
  if (current.state === "absent") return finalize(env, receipt, null, now, true);
  if (current.state !== "unchanged") {
    await env.DB.prepare(
      "UPDATE agent_action_receipts SET state = 'invalidated' WHERE receipt_hash = ? AND state = 'executing'",
    ).bind(receipt.receipt_hash).run();
    return response({ error: "conflict", code: "receipt_selection_changed" }, 409);
  }

  // A second concurrent request cannot enter the mutation. A crashed worker
  // can be retried after the short lease; if the first worker deleted rows but
  // lost its response, the absent snapshot above finalizes without deleting.
  if (!claimedHere) {
    if (now - Number(receipt.executing_at || 0) < EXECUTION_LEASE_MS) {
      return response({ error: "conflict", code: "deletion_in_progress" }, 409);
    }
    const reclaim = await env.DB.prepare(
      `UPDATE agent_action_receipts SET executing_at = ?
        WHERE receipt_hash = ? AND state = 'executing' AND executing_at = ?`,
    ).bind(now, receipt.receipt_hash, Number(receipt.executing_at || 0)).run();
    if (batchChanged(reclaim) !== 1) return response({ error: "conflict", code: "deletion_in_progress" }, 409);
    claimedHere = true;
    receipt = { ...receipt, executing_at: now };
  }

  const mutation = await deps.forget(env, { docUids: current.ids, dryRun: false });
  if (typeof deps.afterForget === "function") await deps.afterForget({ receipt, mutation });
  current = await snapshot(env, receipt);
  if (current.state !== "absent") {
    return response({ error: "unavailable", code: "deletion_readback_failed" }, 503);
  }
  return finalize(env, receipt, mutation, now);
}

/** Owner HTTP surface. Kept separate from owner-actions.js to preserve stream ownership. */
export async function handleAgentDeletion(env, request, path, deps = {}) {
  if (request.method !== "POST") return response({ error: "not found" }, 404);
  let owner;
  try {
    owner = await requireOwner(request, env);
  } catch {
    return unavailable();
  }
  if (!owner) return response({ error: "forbidden", code: "owner_required" }, 403);
  const payload = await requestBody(request);
  if (!payload) return response({ error: "invalid body", code: "invalid_json" }, 400);

  try {
    if (path === `${AGENT_DELETION_PATH_PREFIX}preview`) {
      if (!exactObject(payload, ["entity_slug", "document_ids"])) {
        return response({ error: "invalid request", code: "preview_fields_invalid" }, 400);
      }
      const preview = await createAgentDeletionPreview(env, {
        entitySlug: payload.entity_slug,
        documentIds: payload.document_ids,
        principalKind: "owner",
        principalIdHash: await sha256Hex(`${TENANT_ID}:owner`),
        agentProfile: "owner",
      });
      return response(preview.body, preview.status);
    }

    if (path === `${AGENT_DELETION_PATH_PREFIX}passkey/options`) {
      if (!exactObject(payload, ["receipt"])) {
        return response({ error: "invalid request", code: "passkey_option_fields_invalid" }, 400);
      }
      const receipt = await loadReceipt(env, payload.receipt);
      if (!receipt) return response({ error: "not found", code: "receipt_not_found" }, 404);
      if (receipt.state !== "previewed") return response({ error: "conflict", code: "receipt_replayed" }, 409);
      if (Number(receipt.expires_at) <= Date.now()) return response({ error: "gone", code: "receipt_expired" }, 410);
      const snapshotState = await snapshot(env, receipt);
      if (snapshotState.state !== "unchanged") {
        await env.DB.prepare(
          "UPDATE agent_action_receipts SET state = 'invalidated' WHERE receipt_hash = ? AND state = 'previewed'",
        ).bind(receipt.receipt_hash).run();
        return response({ error: "conflict", code: "receipt_selection_changed" }, 409);
      }
      const ttl = Math.min(2 * 60 * 1000, Number(receipt.expires_at) - Date.now());
      const challenge = await issueChallenge(env, challengePurpose(receipt), ttl);
      const { results } = await env.DB.prepare(
        `SELECT credential_id FROM owner_passkeys
          WHERE grant_id IS NULL AND document_grant_id IS NULL
          ORDER BY created_at`,
      ).all();
      return response({
        challenge,
        rp_id: env.WEBAUTHN_RP_ID || new URL(request.url).hostname,
        allow_credentials: (results || []).map((row) => row.credential_id),
        expires_at: Math.min(Number(receipt.expires_at), Date.now() + ttl),
      });
    }

    if (path === `${AGENT_DELETION_PATH_PREFIX}execute`) {
      const fields = [
        "receipt", "request_id", "credentialId", "authenticatorData", "clientDataJSON", "signature",
      ];
      if (!exactObject(payload, fields) || !RECEIPT_PATTERN.test(String(payload.receipt || "")) ||
          !REQUEST_ID_PATTERN.test(String(payload.request_id || ""))) {
        return response({ error: "invalid request", code: "execution_fields_invalid" }, 400);
      }
      const receipt = await loadReceipt(env, payload.receipt);
      if (!receipt) return response({ error: "not found", code: "receipt_not_found" }, 404);
      return await executeReceipt(env, request, receipt, payload, deps, Date.now());
    }
    return response({ error: "not found" }, 404);
  } catch {
    return unavailable();
  }
}
