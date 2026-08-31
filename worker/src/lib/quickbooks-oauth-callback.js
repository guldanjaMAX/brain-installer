/**
 * Restart-safe QuickBooks HTTPS callback handoff.
 *
 * This module never exchanges an Intuit code and never sees a client secret or
 * token. It accepts one provider callback, encrypts its one-time values to the
 * local technician's ephemeral public key, and stores only a short-lived
 * ciphertext. Production remains fail-closed until the deployment explicitly
 * records both route enablement and a Cloudflare request-logging review.
 */

import { jsonResponse, privateNoStore } from "./core.js";
import {
  encryptQuickBooksCallback,
  normalizeQuickBooksCallbackBinding,
  QUICKBOOKS_CALLBACK_AUTHORIZATION_CODE_MAX_CHARS,
  QUICKBOOKS_CALLBACK_ENVELOPE_MAX_CHARS,
  QUICKBOOKS_CALLBACK_REALM_ID_MAX_CHARS,
  QuickBooksCallbackCryptoError,
  sha256Hex,
  validateQuickBooksCallbackPublicJwk,
} from "./quickbooks-callback-crypto.js";

export const QUICKBOOKS_OAUTH_PATH_PREFIX = "/api/oauth/quickbooks";
export const QUICKBOOKS_OAUTH_PATHS = Object.freeze({
  callback: `${QUICKBOOKS_OAUTH_PATH_PREFIX}/callback`,
  result: `${QUICKBOOKS_OAUTH_PATH_PREFIX}/result`,
  start: `${QUICKBOOKS_OAUTH_PATH_PREFIX}/intents/start`,
  claim: `${QUICKBOOKS_OAUTH_PATH_PREFIX}/intents/claim`,
  finalize: `${QUICKBOOKS_OAUTH_PATH_PREFIX}/intents/finalize`,
  status: `${QUICKBOOKS_OAUTH_PATH_PREFIX}/intents/status`,
});
export const QUICKBOOKS_OAUTH_INTENT_TTL_MS = 10 * 60 * 1000;
export const QUICKBOOKS_OAUTH_MAX_BODY_BYTES = 12 * 1024;

const TENANT_ID = "primary";
const HASH = /^[0-9a-f]{64}$/;
const RANDOM_CAPABILITY = /^[A-Za-z0-9_-]{43,128}$/;
const SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NEUTRAL_CALLBACK_HTML = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Return to Financial Brain</title><body><main><h1>Return to Financial Brain to finish.</h1><p>Financial Brain will show whether QuickBooks connected or whether another try is needed.</p></main></body></html>";

class RouteError extends Error {
  constructor(code, status = 400, error = "invalid_request") {
    super("QuickBooks OAuth request was refused");
    this.name = "QuickBooksOAuthRouteError";
    this.code = code;
    this.status = status;
    this.error = error;
  }
}

function routeError(code, status = 400, error = "invalid_request") {
  throw new RouteError(code, status, error);
}

function privateJson(body, status = 200) {
  return privateNoStore(jsonResponse(body, status));
}

function unavailable() {
  return privateJson({
    error: "unavailable",
    code: "quickbooks_oauth_callback_unavailable",
  }, 503);
}

function storeUnavailable() {
  return privateJson({
    error: "unavailable",
    code: "quickbooks_oauth_store_unavailable",
  }, 503);
}

function cryptoUnavailable() {
  return privateJson({
    error: "unavailable",
    code: "quickbooks_oauth_crypto_unavailable",
  }, 503);
}

function callbackResponseHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function callbackResultPage() {
  return new Response(NEUTRAL_CALLBACK_HTML, {
    status: 200,
    headers: {
      ...callbackResponseHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Frame-Options": "DENY",
    },
  });
}

function callbackResultRedirect() {
  // Never leave Intuit's code, state, company id, or error detail in the final
  // address bar. Every outcome uses the same clean page, which asks the local
  // app to report the authoritative received/canceled/unavailable status.
  return new Response(null, {
    status: 303,
    headers: {
      ...callbackResponseHeaders(),
      Location: QUICKBOOKS_OAUTH_PATHS.result,
    },
  });
}

export function quickBooksOAuthCallbackReady(env) {
  return env?.QUICKBOOKS_OAUTH_CALLBACK_MODE === "field-reviewed" &&
    env?.QUICKBOOKS_OAUTH_OBSERVABILITY_REVIEWED === "1" &&
    Boolean(env?.DB);
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

async function boundedJson(request) {
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    routeError("quickbooks_oauth_json_required", 415, "unsupported_media");
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > QUICKBOOKS_OAUTH_MAX_BODY_BYTES) {
    routeError("quickbooks_oauth_body_too_large", 413, "too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) routeError("quickbooks_oauth_body_required");
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > QUICKBOOKS_OAUTH_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      routeError("quickbooks_oauth_body_too_large", 413, "too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    routeError("quickbooks_oauth_json_invalid");
  }
}

function capability(value, field) {
  if (typeof value !== "string" || !RANDOM_CAPABILITY.test(value)) {
    routeError(`quickbooks_oauth_${field}_invalid`);
  }
  return value;
}

function fingerprint(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !HASH.test(value)) {
    routeError(`quickbooks_oauth_${field}_invalid`);
  }
  return value;
}

function bindingFromRow(row) {
  return normalizeQuickBooksCallbackBinding({
    intent_fingerprint: row.intent_hash,
    source: row.source,
    environment: row.environment,
    client_id_fingerprint: row.client_id_fingerprint,
    expected_company_fingerprint: row.expected_company_fingerprint,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
  });
}

function effectiveStatus(row, now) {
  if (!row) return "missing";
  if (["pending", "received"].includes(row.status) && Number(row.expires_at) <= now) return "expired";
  return row.status;
}

function statusCode(status) {
  return `quickbooks_oauth_intent_${status}`;
}

function statusPayload(row, now) {
  const status = effectiveStatus(row, now);
  return {
    intent_fingerprint: row.intent_hash,
    status,
    reason_code: status === "canceled" ? row.terminal_reason : statusCode(status),
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    received_at: row.received_at == null ? null : Number(row.received_at),
    claimed_at: row.claimed_at == null ? null : Number(row.claimed_at),
    finalized_at: row.finalized_at == null ? null : Number(row.finalized_at),
    client_id_fingerprint: row.client_id_fingerprint,
    expected_company_fingerprint: row.expected_company_fingerprint ?? null,
    callback_fingerprint: row.callback_fingerprint ?? null,
    company_fingerprint: row.finalized_company_fingerprint ?? null,
    credential_fingerprint: row.local_credential_fingerprint ?? null,
  };
}

async function intentByIdentity(env, intentId, claimSecret = null) {
  const intentHash = await sha256Hex(intentId);
  const claimHash = claimSecret === null ? null : await sha256Hex(claimSecret);
  const row = await env.DB.prepare(
    `SELECT * FROM quickbooks_oauth_intents
      WHERE tenant_id = ? AND intent_hash = ?${claimHash === null ? "" : " AND claim_hash = ?"}`,
  ).bind(...(claimHash === null
    ? [TENANT_ID, intentHash]
    : [TENANT_ID, intentHash, claimHash])).first();
  return { intentHash, claimHash, row };
}

async function startIntent(env, request, now) {
  const body = await boundedJson(request);
  if (!exactKeys(body, [
    "intent_id", "state", "claim_secret", "source", "environment",
    "client_id_fingerprint", "recipient_public_jwk",
  ], ["expected_company_fingerprint", "pkce_challenge"])) {
    routeError("quickbooks_oauth_start_shape_invalid");
  }
  if (body.pkce_challenge !== undefined && body.pkce_challenge !== null) {
    routeError("quickbooks_oauth_pkce_not_supported", 409, "conflict");
  }
  const intentId = capability(body.intent_id, "intent_id");
  const state = capability(body.state, "state");
  const claimSecret = capability(body.claim_secret, "claim_secret");
  const source = typeof body.source === "string" && SOURCE.test(body.source) ? body.source : null;
  if (!source) routeError("quickbooks_oauth_source_invalid");
  if (!["sandbox", "production"].includes(body.environment)) {
    routeError("quickbooks_oauth_environment_invalid");
  }
  const clientIdFingerprint = fingerprint(body.client_id_fingerprint, "client_id_fingerprint");
  const expectedCompanyFingerprint = fingerprint(
    body.expected_company_fingerprint,
    "expected_company_fingerprint",
    true,
  );
  const publicJwk = await validateQuickBooksCallbackPublicJwk(body.recipient_public_jwk);
  const [intentHash, stateHash, claimHash] = await Promise.all([
    sha256Hex(intentId), sha256Hex(state), sha256Hex(claimSecret),
  ]);
  const createdAt = now;
  const expiresAt = createdAt + QUICKBOOKS_OAUTH_INTENT_TTL_MS;
  const startShape = {
    intent_hash: intentHash,
    state_hash: stateHash,
    claim_hash: claimHash,
    source,
    environment: body.environment,
    client_id_fingerprint: clientIdFingerprint,
    expected_company_fingerprint: expectedCompanyFingerprint,
    recipient_public_jwk: publicJwk,
  };
  const startFingerprint = await sha256Hex(JSON.stringify(startShape));

  const existing = await env.DB.prepare(
    "SELECT * FROM quickbooks_oauth_intents WHERE tenant_id = ? AND intent_hash = ?",
  ).bind(TENANT_ID, intentHash).first();
  const replay = (row) => {
    if (row.start_fingerprint !== startFingerprint) {
      routeError("quickbooks_oauth_intent_conflict", 409, "conflict");
    }
    if (Number(row.expires_at) <= now) {
      routeError("quickbooks_oauth_intent_expired", 410, "expired");
    }
    return {
      intent_fingerprint: row.intent_hash,
      status: effectiveStatus(row, now),
      reason_code: statusCode(effectiveStatus(row, now)),
      callback_path: QUICKBOOKS_OAUTH_PATHS.callback,
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at),
      pkce: "not_supported",
      replayed: true,
    };
  };
  if (existing) {
    return replay(existing);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO quickbooks_oauth_intents
         (tenant_id,intent_hash,state_hash,claim_hash,start_fingerprint,pkce_challenge_hash,
          recipient_public_jwk,source,environment,client_id_fingerprint,
          expected_company_fingerprint,status,created_at,expires_at)
       VALUES (?,?,?,?,?,NULL,?,?,?,?,?,'pending',?,?)`,
    ).bind(
      TENANT_ID, intentHash, stateHash, claimHash, startFingerprint,
      JSON.stringify(publicJwk), source, body.environment, clientIdFingerprint,
      expectedCompanyFingerprint, createdAt, expiresAt,
    ).run();
  } catch (insertError) {
    // A response-loss retry can race the original start on another isolate.
    // Re-read the same hashed intent before classifying the insert failure.
    // A collision on state or claim belonging to another intent is a stable
    // conflict, while an unavailable re-read preserves the original 503 path.
    let raced;
    let capabilityCollision;
    try {
      raced = await env.DB.prepare(
        "SELECT * FROM quickbooks_oauth_intents WHERE tenant_id = ? AND intent_hash = ?",
      ).bind(TENANT_ID, intentHash).first();
      capabilityCollision = raced ? null : await env.DB.prepare(
        `SELECT intent_hash FROM quickbooks_oauth_intents
          WHERE tenant_id = ? AND (state_hash = ? OR claim_hash = ?) LIMIT 1`,
      ).bind(TENANT_ID, stateHash, claimHash).first();
    } catch {
      throw insertError;
    }
    if (raced) return replay(raced);
    if (capabilityCollision) {
      routeError("quickbooks_oauth_capability_conflict", 409, "conflict");
    }
    throw insertError;
  }
  return {
    intent_fingerprint: intentHash,
    status: "pending",
    reason_code: "quickbooks_oauth_intent_pending",
    callback_path: QUICKBOOKS_OAUTH_PATHS.callback,
    created_at: createdAt,
    expires_at: expiresAt,
    pkce: "not_supported",
    replayed: false,
  };
}

async function cancelPending(env, stateHash, now, reason) {
  await env.DB.prepare(
    `UPDATE quickbooks_oauth_intents
        SET status = 'canceled', terminal_reason = ?, recipient_public_jwk = NULL
      WHERE tenant_id = ? AND state_hash = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(reason, TENANT_ID, stateHash, now).run();
}

async function receiveCallback(env, url, now) {
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || !RANDOM_CAPABILITY.test(states[0])) return;
  const stateHash = await sha256Hex(states[0]);
  const row = await env.DB.prepare(
    "SELECT * FROM quickbooks_oauth_intents WHERE tenant_id = ? AND state_hash = ?",
  ).bind(TENANT_ID, stateHash).first();
  if (!row || row.status !== "pending" || Number(row.expires_at) <= now) return;

  const providerErrors = url.searchParams.getAll("error");
  if (providerErrors.length > 0) {
    await cancelPending(env, stateHash, now, "provider_authorization_not_completed");
    return;
  }
  const codes = url.searchParams.getAll("code");
  const realms = url.searchParams.getAll("realmId");
  if (codes.length !== 1 || realms.length !== 1 ||
      !codes[0] || codes[0].length > QUICKBOOKS_CALLBACK_AUTHORIZATION_CODE_MAX_CHARS ||
      /[\u0000-\u001f\u007f]/.test(codes[0]) ||
      !realms[0] || realms[0].length > QUICKBOOKS_CALLBACK_REALM_ID_MAX_CHARS ||
      /[\u0000-\u001f\u007f]/.test(realms[0])) {
    await cancelPending(env, stateHash, now, "provider_callback_incomplete");
    return;
  }
  let publicJwk;
  try {
    publicJwk = JSON.parse(row.recipient_public_jwk);
  } catch {
    return;
  }
  const envelope = await encryptQuickBooksCallback({
    recipientPublicJwk: publicJwk,
    binding: bindingFromRow(row),
    authorizationCode: codes[0],
    realmId: realms[0],
  });
  const envelopeJson = JSON.stringify(envelope);
  if (envelopeJson.length > QUICKBOOKS_CALLBACK_ENVELOPE_MAX_CHARS) {
    // Defense in depth for any future binding-field change. Do not ask D1 to
    // discover a contract mismatch after the provider code has been handled.
    await cancelPending(env, stateHash, now, "provider_callback_incomplete");
    return;
  }
  const envelopeFingerprint = await sha256Hex(envelopeJson);
  await env.DB.prepare(
    `UPDATE quickbooks_oauth_intents
        SET status = 'received', callback_envelope = ?, callback_fingerprint = ?, received_at = ?
      WHERE tenant_id = ? AND state_hash = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(envelopeJson, envelopeFingerprint, now, TENANT_ID, stateHash, now).run();
}

async function claimIntent(env, request, now) {
  const body = await boundedJson(request);
  if (!exactKeys(body, ["intent_id", "claim_secret"])) {
    routeError("quickbooks_oauth_claim_shape_invalid");
  }
  const intentId = capability(body.intent_id, "intent_id");
  const claimSecret = capability(body.claim_secret, "claim_secret");
  let { intentHash, row } = await intentByIdentity(env, intentId, claimSecret);
  if (!row) routeError("quickbooks_oauth_intent_not_found", 404, "not_found");
  const state = effectiveStatus(row, now);
  if (state === "expired") routeError("quickbooks_oauth_intent_expired", 410, "expired");
  if (state !== "received") {
    routeError(statusCode(state), 409, "conflict");
  }

  let replayed = row.claimed_at !== null;
  if (!replayed) {
    const claimed = await env.DB.prepare(
      `UPDATE quickbooks_oauth_intents SET claimed_at = ?
        WHERE tenant_id = ? AND intent_hash = ? AND status = 'received'
          AND claimed_at IS NULL AND expires_at > ?
        RETURNING intent_hash`,
    ).bind(now, TENANT_ID, intentHash, now).first();
    replayed = !claimed;
    ({ row } = await intentByIdentity(env, intentId, claimSecret));
    if (!row || effectiveStatus(row, now) !== "received") {
      routeError("quickbooks_oauth_intent_unavailable", 409, "conflict");
    }
  }
  let envelope;
  try {
    envelope = JSON.parse(row.callback_envelope);
  } catch {
    routeError("quickbooks_oauth_envelope_unavailable", 503, "unavailable");
  }
  return {
    intent_fingerprint: intentHash,
    status: "received",
    reason_code: "quickbooks_oauth_intent_received",
    callback_fingerprint: row.callback_fingerprint,
    expires_at: Number(row.expires_at),
    envelope,
    replayed,
  };
}

async function statusIntent(env, request, now) {
  const body = await boundedJson(request);
  if (!exactKeys(body, ["intent_id", "claim_secret"])) {
    routeError("quickbooks_oauth_status_shape_invalid");
  }
  const intentId = capability(body.intent_id, "intent_id");
  const claimSecret = capability(body.claim_secret, "claim_secret");
  const { row } = await intentByIdentity(env, intentId, claimSecret);
  if (!row) routeError("quickbooks_oauth_intent_not_found", 404, "not_found");
  return statusPayload(row, now);
}

async function finalizeIntent(env, request, now) {
  const body = await boundedJson(request);
  if (!exactKeys(body, [
    "intent_id", "claim_secret", "company_fingerprint", "credential_fingerprint",
  ])) {
    routeError("quickbooks_oauth_finalize_shape_invalid");
  }
  const intentId = capability(body.intent_id, "intent_id");
  const claimSecret = capability(body.claim_secret, "claim_secret");
  const companyFingerprint = fingerprint(body.company_fingerprint, "company_fingerprint");
  const credentialFingerprint = fingerprint(body.credential_fingerprint, "credential_fingerprint");
  let { intentHash, row } = await intentByIdentity(env, intentId, claimSecret);
  if (!row) routeError("quickbooks_oauth_intent_not_found", 404, "not_found");
  const state = effectiveStatus(row, now);
  if (state === "expired") routeError("quickbooks_oauth_intent_expired", 410, "expired");
  if (state === "finalized") {
    if (row.finalized_company_fingerprint !== companyFingerprint ||
        row.local_credential_fingerprint !== credentialFingerprint) {
      routeError("quickbooks_oauth_finalize_conflict", 409, "conflict");
    }
    return { ...statusPayload(row, now), replayed: true };
  }
  if (state !== "received") routeError(statusCode(state), 409, "conflict");
  if (row.claimed_at === null) {
    routeError("quickbooks_oauth_callback_unclaimed", 409, "conflict");
  }
  if (row.expected_company_fingerprint &&
      row.expected_company_fingerprint !== companyFingerprint) {
    routeError("quickbooks_company_binding_mismatch", 409, "conflict");
  }
  const won = await env.DB.prepare(
    `UPDATE quickbooks_oauth_intents
        SET status = 'finalized', recipient_public_jwk = NULL, callback_envelope = NULL,
            finalized_at = ?, finalized_company_fingerprint = ?,
            local_credential_fingerprint = ?
      WHERE tenant_id = ? AND intent_hash = ? AND claim_hash = ?
        AND status = 'received' AND claimed_at IS NOT NULL AND expires_at > ?
      RETURNING intent_hash`,
  ).bind(
    now, companyFingerprint, credentialFingerprint,
    TENANT_ID, intentHash, await sha256Hex(claimSecret), now,
  ).first();
  ({ row } = await intentByIdentity(env, intentId, claimSecret));
  if (!row) routeError("quickbooks_oauth_intent_not_found", 404, "not_found");
  if (!won) {
    if (row.status === "finalized" &&
        row.finalized_company_fingerprint === companyFingerprint &&
        row.local_credential_fingerprint === credentialFingerprint) {
      return { ...statusPayload(row, now), replayed: true };
    }
    routeError("quickbooks_oauth_finalize_conflict", 409, "conflict");
  }
  return { ...statusPayload(row, now), replayed: false };
}

function errorResponse(error) {
  if (error instanceof RouteError) {
    return privateJson({ error: error.error, code: error.code }, error.status);
  }
  if (error instanceof QuickBooksCallbackCryptoError) {
    if (error.code === "quickbooks_callback_public_key_invalid") {
      return privateJson({
        error: "invalid_request",
        code: "quickbooks_oauth_recipient_key_invalid",
      }, 400);
    }
    return cryptoUnavailable();
  }
  return storeUnavailable();
}

/**
 * Route adapter for worker/src/index.js. Callback and claim are capability
 * routes; start, status, and finalize additionally require admin authorization.
 */
export async function handleQuickBooksOAuthRoute(
  env,
  request,
  url,
  path,
  { adminAuthorized = false, now = Date.now(), publicGuardDenied = false } = {},
) {
  const isCallback = path === QUICKBOOKS_OAUTH_PATHS.callback;
  const isResult = path === QUICKBOOKS_OAUTH_PATHS.result;
  if (isResult) {
    // Scrub any manually appended query before rendering the completion page.
    return url.search ? callbackResultRedirect() : callbackResultPage();
  }
  if (!quickBooksOAuthCallbackReady(env)) {
    return isCallback ? callbackResultRedirect() : unavailable();
  }
  if (isCallback) {
    if (!publicGuardDenied && request.method === "GET") {
      try {
        await receiveCallback(env, url, now);
      } catch {
        // The query-free page never claims completion. The local status route
        // is the only diagnostic boundary, and it exposes stable codes only.
      }
    }
    return callbackResultRedirect();
  }
  if (request.method !== "POST") {
    return privateJson({ error: "not_found", code: "quickbooks_oauth_route_not_found" }, 404);
  }
  if (path !== QUICKBOOKS_OAUTH_PATHS.claim && !adminAuthorized) {
    return privateJson({ error: "unauthorized", code: "admin_key_required" }, 401);
  }
  try {
    if (path === QUICKBOOKS_OAUTH_PATHS.start) {
      const result = await startIntent(env, request, now);
      return privateJson(result, result.replayed ? 200 : 201);
    }
    if (path === QUICKBOOKS_OAUTH_PATHS.claim) {
      return privateJson(await claimIntent(env, request, now));
    }
    if (path === QUICKBOOKS_OAUTH_PATHS.status) {
      return privateJson(await statusIntent(env, request, now));
    }
    if (path === QUICKBOOKS_OAUTH_PATHS.finalize) {
      return privateJson(await finalizeIntent(env, request, now));
    }
    return privateJson({ error: "not_found", code: "quickbooks_oauth_route_not_found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete expired public keys and ciphertext in one bounded scheduled slice. */
export async function cleanupQuickBooksOAuthIntents(env, { now = Date.now(), limit = 500 } = {}) {
  if (!env?.DB) return { skipped: true, reason: "no_d1" };
  const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 500), 1), 2000);
  const result = await env.DB.prepare(
    `DELETE FROM quickbooks_oauth_intents WHERE rowid IN (
       SELECT rowid FROM quickbooks_oauth_intents
        WHERE tenant_id = ? AND expires_at <= ?
        ORDER BY expires_at ASC LIMIT ?
     )`,
  ).bind(TENANT_ID, now, bounded).run();
  return { cleaned: Number(result?.meta?.changes ?? result?.changes ?? 0) };
}
