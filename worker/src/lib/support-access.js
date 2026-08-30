/**
 * Short-lived, read-only technician access.
 *
 * Support authentication is intentionally separate from owner and grant
 * authentication. Its invite, passkey, cookie, and D1 resolver cannot fall
 * back to an owner when a subject is missing or unreadable. Every successful
 * request rechecks the mutable D1 row, so revoke and absolute expiry take
 * effect without waiting for a signed cookie to expire.
 */

import { jsonResponse } from "./core.js";
import { ownerActivityStatement } from "./owner-activity.js";
import { ownerSystemStatus } from "./system-status.js";
import { diagnose, freshnessReport, vectorReadiness } from "./store-d1.js";
import { verifyRegistration, verifyAssertion, b64uDecode } from "./webauthn.js";

export const SUPPORT_COOKIE = "brain_support_session";
export const SUPPORT_HEADER = "X-Brain-Support";
export const SUPPORT_DURATION_OPTIONS = Object.freeze([15, 30, 60, 120]);
export const SUPPORT_DEFAULT_DURATION_MINUTES = 30;
export const SUPPORT_MAX_DURATION_MINUTES = 120;
export const SUPPORT_INVITE_TTL_MS = 10 * 60 * 1000;
export const SUPPORT_IDLE_TTL_MS = 10 * 60 * 1000;
const SUPPORT_CHALLENGE_MAX_ROWS = 500;
const SUPPORT_SYSTEM_MIN_INTERVAL_MS = 15 * 1000;
const SUPPORT_SYSTEM_RETRY_AFTER_SECONDS = Math.ceil(SUPPORT_SYSTEM_MIN_INTERVAL_MS / 1000);

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SUPPORT_ID = /^ss_[A-Za-z0-9_-]{5,61}$/;
const te = new TextEncoder();

export class SupportAccessError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = "SupportAccessError";
    this.status = status;
    this.code = code;
  }
}

function unavailable(error) {
  if (error instanceof SupportAccessError) throw error;
  throw new SupportAccessError(503, "support_access_unavailable");
}

function randomToken(bytes = 18) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let ascii = "";
  for (const byte of raw) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64u(bytes) {
  let ascii = "";
  for (const byte of bytes) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(value)));
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(value) {
  return sha256(canonical(value));
}

function labelOf(value) {
  if (typeof value !== "string") return null;
  const label = value.trim().replace(/\s+/g, " ");
  return label && label.length <= 80 ? label : null;
}

function requireDb(env) {
  if (!env?.DB || !env.SESSION_SIGNING_KEY) {
    throw new SupportAccessError(503, "support_access_unavailable");
  }
}

function errorResponse(error) {
  const status = error instanceof SupportAccessError ? error.status : 503;
  const code = error instanceof SupportAccessError ? error.code : "support_access_unavailable";
  const label = status === 400 ? "invalid_request"
    : status === 401 ? "unauthorized"
      : status === 403 ? "forbidden"
        : status === 404 ? "not_found"
          : status === 409 ? "conflict"
            : status === 429 ? "rate_limited"
            : "unavailable";
  const response = jsonResponse({ error: label, code }, status);
  if (code === "support_system_rate_limited") {
    response.headers.set("Retry-After", String(SUPPORT_SYSTEM_RETRY_AFTER_SECONDS));
  }
  return response;
}

function supportSessionRecovery(code) {
  return code === "support_session_idle_expired"
    ? "Sign in again with the enrolled support passkey to continue."
    : "This support access has ended. Ask the owner for a new invitation to continue.";
}

function supportEventStatement(env, {
  eventId, at, requestId = null, sessionId, eventType, route = null,
  decision = "allow", reasonCode,
}) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO support_access_events
       (event_id,occurred_at,request_id,support_session_id,event_type,decision,reason_code,route)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(eventId, at, requestId, sessionId, eventType, decision, reasonCode, route);
}

async function inviteCode(env, requestId, sessionId) {
  requireDb(env);
  return b64u(await hmac(
    env.SESSION_SIGNING_KEY,
    `financial-brain:support-enrollment:v1:${requestId}:${sessionId}`,
  ));
}

function baseCapabilities() {
  return {
    read_only: true,
    can_fix: false,
    repair_mode: "owner_approval_required_future",
  };
}

function idleAnchor(row) {
  return Math.max(
    Number(row?.last_used_at || 0),
    Number(row?.last_authenticated_at || 0),
  );
}

function idleExpiry(row) {
  return Math.min(Number(row?.expires_at), idleAnchor(row) + SUPPORT_IDLE_TTL_MS);
}

function stateOf(row, now = Date.now()) {
  if (row.revoked_at !== null && row.revoked_at !== undefined) return "revoked";
  if (row.activated_at === null || row.activated_at === undefined) return "pending";
  if (Number(row.expires_at) <= now) return "expired";
  return "active";
}

function inviteStateOf(row, now = Date.now()) {
  if (row.activated_at !== null && row.activated_at !== undefined) return "consumed";
  if (row.invite_used_at !== null && row.invite_used_at !== undefined) return "consumed";
  return Number(row.invite_expires_at) > now ? "active" : "expired";
}

function authenticationStateOf(row, now = Date.now()) {
  if (stateOf(row, now) !== "active") return null;
  return idleExpiry(row) <= now ? "reauthentication_required" : "authenticated";
}

function publicSession(row, now = Date.now()) {
  return {
    support_session_id: row.support_session_id,
    technician_label: row.technician_label,
    state: stateOf(row, now),
    authentication_state: authenticationStateOf(row, now),
    duration_minutes: Number(row.duration_minutes),
    created_at: Number(row.created_at),
    invite_state: inviteStateOf(row, now),
    enrollment_expires_at: Number(row.invite_expires_at),
    activated_at: row.activated_at === null ? null : Number(row.activated_at),
    expires_at: row.expires_at === null ? null : Number(row.expires_at),
    first_used_at: row.first_used_at === null ? null : Number(row.first_used_at),
    last_used_at: row.last_used_at === null ? null : Number(row.last_used_at),
    idle_expires_at: row.activated_at === null ? null
      : idleExpiry(row),
    revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
    idle_timeout_minutes: SUPPORT_IDLE_TTL_MS / 60_000,
    ...baseCapabilities(),
  };
}

async function requestReplay(env, { requestId, action, requestFingerprint }) {
  const row = await env.DB.prepare(
    `SELECT action,support_session_id,request_fingerprint,response_json,invite_code_hash
       FROM support_access_requests WHERE request_id=?`,
  ).bind(requestId).first();
  if (!row) return null;
  if (row.action !== action || row.request_fingerprint !== requestFingerprint) {
    throw new SupportAccessError(409, "request_id_conflict");
  }
  let response;
  try {
    response = JSON.parse(row.response_json);
  } catch {
    throw new SupportAccessError(503, "support_receipt_unavailable");
  }
  if (!row.invite_code_hash) {
    if (action === "revoke") {
      const current = await sessionRow(env, row.support_session_id);
      if (!current || current.revoked_at === null) {
        throw new SupportAccessError(503, "support_receipt_unavailable");
      }
      return {
        ...response,
        request_id: requestId,
        support_session_id: row.support_session_id,
        status: "revoked",
        revoked: true,
        changed: current.revoke_request_id === requestId,
        revoked_at: Number(current.revoked_at),
        replayed: true,
      };
    }
    return { ...response, replayed: true };
  }
  const invite = await env.DB.prepare(
    `SELECT c.expires_at,c.used_at,s.activated_at,s.expires_at session_expires_at,
            s.first_used_at,s.last_used_at,s.last_authenticated_at,s.revoked_at
            ,s.current_invite_code_hash=c.code_hash AS is_current
       FROM support_enrollment_codes c
       JOIN support_sessions s ON s.support_session_id=c.support_session_id
      WHERE c.code_hash=?`,
  ).bind(row.invite_code_hash).first();
  if (!invite) throw new SupportAccessError(503, "support_receipt_unavailable");
  const pending = invite.activated_at === null && invite.revoked_at === null;
  const active = pending && Number(invite.is_current) === 1 && invite.used_at === null &&
    Number(invite.expires_at) > Date.now();
  const code = active ? await inviteCode(env, requestId, row.support_session_id) : null;
  return {
    ...response,
    status: invite.revoked_at !== null ? "revoked"
      : invite.activated_at !== null && Number(invite.session_expires_at) <= Date.now() ? "expired"
        : invite.activated_at !== null ? "active" : "pending",
    activated_at: invite.activated_at === null ? null : Number(invite.activated_at),
    expires_at: invite.session_expires_at === null ? null : Number(invite.session_expires_at),
    first_used_at: invite.first_used_at === null ? null : Number(invite.first_used_at),
    last_used_at: invite.last_used_at === null ? null : Number(invite.last_used_at),
    idle_expires_at: invite.activated_at === null ? null
      : idleExpiry({ ...invite, expires_at: invite.session_expires_at }),
    revoked_at: invite.revoked_at === null ? null : Number(invite.revoked_at),
    invite_state: invite.used_at !== null ? "consumed" : active ? "active" : "expired",
    enrollment_url_code: code,
    enrollment_expires_at: active ? Number(invite.expires_at) : null,
    replayed: true,
  };
}

async function sessionRow(env, sessionId) {
  try {
    return await env.DB.prepare(
      `SELECT s.*,
              (SELECT used_at FROM support_enrollment_codes
                WHERE support_session_id=s.support_session_id
                ORDER BY created_at DESC LIMIT 1) invite_used_at
         FROM support_sessions s WHERE support_session_id=?`,
    ).bind(sessionId).first();
  } catch (error) {
    unavailable(error);
  }
}

export async function listSupportSessions(env) {
  requireDb(env);
  try {
    const rows = await env.DB.prepare(
      `SELECT s.*,
              (SELECT used_at FROM support_enrollment_codes
                WHERE support_session_id=s.support_session_id
                ORDER BY created_at DESC LIMIT 1) invite_used_at
         FROM support_sessions s ORDER BY created_at DESC`,
    ).all();
    return {
      status: "ready",
      policy: {
        access: "read_only_diagnostics",
        duration_choices_minutes: [...SUPPORT_DURATION_OPTIONS],
        default_duration_minutes: SUPPORT_DEFAULT_DURATION_MINUTES,
        max_duration_minutes: SUPPORT_MAX_DURATION_MINUTES,
        enrollment_link_max_minutes: SUPPORT_INVITE_TTL_MS / 60_000,
        can_fix: false,
        repair_mode: "owner_approval_required_future",
      },
      sessions: (rows?.results || []).map((row) => publicSession(row)),
    };
  } catch (error) {
    unavailable(error);
  }
}

export async function createSupportSession(env, input) {
  requireDb(env);
  const requestId = REQUEST_ID.test(String(input?.request_id || "")) ? String(input.request_id) : null;
  if (!requestId) throw new SupportAccessError(400, "request_id_required");
  const technicianLabel = labelOf(input?.technician_label);
  if (!technicianLabel) throw new SupportAccessError(400, "technician_label_required");
  const durationMinutes = input?.duration_minutes === undefined
    ? SUPPORT_DEFAULT_DURATION_MINUTES
    : Number(input.duration_minutes);
  if (!SUPPORT_DURATION_OPTIONS.includes(durationMinutes)) {
    throw new SupportAccessError(400, "invalid_duration_minutes");
  }
  const requestFingerprint = await fingerprint({
    action: "create", request_id: requestId,
    technician_label: technicianLabel, duration_minutes: durationMinutes,
  });
  try {
    const replay = await requestReplay(env, {
      requestId, action: "create", requestFingerprint,
    });
    if (replay) return replay;
    const now = Date.now();
    const sessionId = `ss_${randomToken(12)}`;
    const code = await inviteCode(env, requestId, sessionId);
    const codeHash = await sha256(code);
    const inviteExpiresAt = now + SUPPORT_INVITE_TTL_MS;
    const response = {
      support_session_id: sessionId,
      request_id: requestId,
      technician_label: technicianLabel,
      status: "pending",
      changed: true,
      duration_minutes: durationMinutes,
      created_at: now,
      invite_state: "active",
      enrollment_expires_at: inviteExpiresAt,
      activated_at: null,
      expires_at: null,
      first_used_at: null,
      last_used_at: null,
      idle_expires_at: null,
      revoked_at: null,
      idle_timeout_minutes: SUPPORT_IDLE_TTL_MS / 60_000,
      ...baseCapabilities(),
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO support_sessions
           (support_session_id,technician_label,duration_minutes,created_at,invite_expires_at,
            activated_at,expires_at,last_authenticated_at,first_used_at,last_used_at,revoked_at,
            create_request_id,request_fingerprint,current_invite_code_hash)
         VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?)`,
      ).bind(
        sessionId, technicianLabel, durationMinutes, now, inviteExpiresAt,
        requestId, requestFingerprint, codeHash,
      ),
      env.DB.prepare(
        `INSERT INTO support_access_requests
           (request_id,action,support_session_id,request_fingerprint,response_json,invite_code_hash,created_at)
         VALUES (?,'create',?,?,?,?,?)`,
      ).bind(requestId, sessionId, requestFingerprint, JSON.stringify(response), codeHash, now),
      env.DB.prepare(
        `INSERT INTO support_enrollment_codes
           (code_hash,support_session_id,request_id,expires_at,used_at,created_at)
         VALUES (?,?,?,?,NULL,?)`,
      ).bind(codeHash, sessionId, requestId, inviteExpiresAt, now),
      supportEventStatement(env, {
        eventId: `support:created:${sessionId}`, at: now, requestId,
        sessionId, eventType: "created", reasonCode: "support_session_created",
      }),
      ownerActivityStatement(env, {
        eventId: `activity:support-session-created:${sessionId}`,
        eventType: "support_access_created", requestId,
        subjectKind: "support_session", subjectId: sessionId,
        displayLabel: technicianLabel, occurredAt: new Date(now).toISOString(),
      }),
    ]);
    return { ...response, enrollment_url_code: code, replayed: false };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      const replay = await requestReplay(env, { requestId, action: "create", requestFingerprint });
      if (replay) return replay;
    }
    unavailable(error);
  }
}

export async function reissueSupportInvite(env, input) {
  requireDb(env);
  const requestId = REQUEST_ID.test(String(input?.request_id || "")) ? String(input.request_id) : null;
  if (!requestId) throw new SupportAccessError(400, "request_id_required");
  const sessionId = SUPPORT_ID.test(String(input?.support_session_id || ""))
    ? String(input.support_session_id) : null;
  if (!sessionId) throw new SupportAccessError(400, "support_session_id_required");
  const requestFingerprint = await fingerprint({ action: "reissue", request_id: requestId, support_session_id: sessionId });
  try {
    const replay = await requestReplay(env, { requestId, action: "reissue", requestFingerprint });
    if (replay) return replay;
    const row = await sessionRow(env, sessionId);
    if (!row) throw new SupportAccessError(404, "support_session_not_found");
    if (row.revoked_at !== null) throw new SupportAccessError(409, "support_session_revoked");
    if (row.activated_at !== null) throw new SupportAccessError(409, "support_session_already_activated");
    const now = Date.now();
    const expiresAt = now + SUPPORT_INVITE_TTL_MS;
    const code = await inviteCode(env, requestId, sessionId);
    const codeHash = await sha256(code);
    const response = {
      ...publicSession({ ...row, invite_expires_at: expiresAt, invite_used_at: null }, now),
      request_id: requestId,
      status: "pending", invite_state: "active", enrollment_expires_at: expiresAt,
      changed: true,
    };
    delete response.state;
    delete response.authentication_state;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO support_access_requests
           (request_id,action,support_session_id,request_fingerprint,response_json,invite_code_hash,created_at)
         SELECT ?,'reissue',support_session_id,?,?,?,?
           FROM support_sessions
          WHERE support_session_id=? AND activated_at IS NULL AND revoked_at IS NULL`,
      ).bind(requestId, requestFingerprint, JSON.stringify(response), codeHash, now, sessionId),
      env.DB.prepare(
        `UPDATE support_enrollment_codes SET used_at=?
          WHERE support_session_id=? AND used_at IS NULL
            AND EXISTS (SELECT 1 FROM support_access_requests
                         WHERE request_id=? AND action='reissue')`,
      ).bind(now, sessionId, requestId),
      env.DB.prepare(
        `INSERT INTO support_enrollment_codes
           (code_hash,support_session_id,request_id,expires_at,used_at,created_at)
         SELECT ?,support_session_id,?,?,NULL,?
           FROM support_sessions
          WHERE support_session_id=? AND activated_at IS NULL AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM support_access_requests WHERE request_id=?)`,
      ).bind(codeHash, requestId, expiresAt, now, sessionId, requestId),
      env.DB.prepare(
        `UPDATE support_sessions SET invite_expires_at=?,current_invite_code_hash=?
          WHERE support_session_id=? AND activated_at IS NULL AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM support_enrollment_codes WHERE code_hash=?)`,
      ).bind(expiresAt, codeHash, sessionId, codeHash),
      env.DB.prepare(
        `INSERT OR IGNORE INTO support_access_events
           (event_id,occurred_at,request_id,support_session_id,event_type,decision,reason_code,route)
         SELECT ?,?,?,support_session_id,'invite_reissued','allow','support_invite_reissued',NULL
           FROM support_sessions
          WHERE support_session_id=? AND activated_at IS NULL AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM support_enrollment_codes WHERE code_hash=?)`,
      ).bind(`support:invite-reissued:${requestId}`, now, requestId, sessionId, codeHash),
    ]);
    const created = await env.DB.prepare(
      `SELECT c.code_hash FROM support_enrollment_codes c
       JOIN support_sessions s ON s.support_session_id=c.support_session_id
       WHERE c.code_hash=? AND c.request_id=? AND c.used_at IS NULL AND c.expires_at>?
         AND s.current_invite_code_hash=c.code_hash
         AND s.activated_at IS NULL AND s.revoked_at IS NULL`,
    ).bind(codeHash, requestId, Date.now()).first();
    if (!created) {
      const racedReceipt = await requestReplay(env, {
        requestId, action: "reissue", requestFingerprint,
      });
      if (racedReceipt) return racedReceipt;
      const current = await sessionRow(env, sessionId);
      throw new SupportAccessError(409,
        current?.revoked_at !== null ? "support_session_revoked" : "support_session_already_activated");
    }
    return { ...response, enrollment_url_code: code, replayed: false };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      const replay = await requestReplay(env, { requestId, action: "reissue", requestFingerprint });
      if (replay) return replay;
    }
    unavailable(error);
  }
}

export async function revokeSupportSession(env, input) {
  requireDb(env);
  const requestId = REQUEST_ID.test(String(input?.request_id || "")) ? String(input.request_id) : null;
  if (!requestId) throw new SupportAccessError(400, "request_id_required");
  const sessionId = SUPPORT_ID.test(String(input?.support_session_id || ""))
    ? String(input.support_session_id) : null;
  if (!sessionId) throw new SupportAccessError(400, "support_session_id_required");
  const requestFingerprint = await fingerprint({ action: "revoke", request_id: requestId, support_session_id: sessionId });
  try {
    const replay = await requestReplay(env, { requestId, action: "revoke", requestFingerprint });
    if (replay) return replay;
    const row = await sessionRow(env, sessionId);
    if (!row) throw new SupportAccessError(404, "support_session_not_found");
    const now = Date.now();
    const storedResponse = {
      support_session_id: sessionId, request_id: requestId, status: "revoked", revoked: true,
    };
    const statements = [env.DB.prepare(
      `INSERT INTO support_access_requests
         (request_id,action,support_session_id,request_fingerprint,response_json,invite_code_hash,created_at)
       VALUES (?,'revoke',?,?,?,NULL,?)`,
    ).bind(requestId, sessionId, requestFingerprint, JSON.stringify(storedResponse), now)];
    if (row.revoked_at === null) {
      statements.unshift(env.DB.prepare(
        `UPDATE support_sessions SET revoked_at=?,revoke_request_id=?
          WHERE support_session_id=? AND revoked_at IS NULL`,
      ).bind(now, requestId, sessionId));
      statements.push(
        supportEventStatement(env, {
          eventId: `support:revoked:${sessionId}`, at: now, requestId,
          sessionId, eventType: "revoked", reasonCode: "support_session_revoked",
        }),
        ownerActivityStatement(env, {
          eventId: `activity:support-session-revoked:${sessionId}`,
          eventType: "support_access_revoked", requestId,
          subjectKind: "support_session", subjectId: sessionId,
          displayLabel: row.technician_label, occurredAt: new Date(now).toISOString(),
        }),
      );
    }
    await env.DB.batch(statements);
    const revoked = await sessionRow(env, sessionId);
    if (!revoked || revoked.revoked_at === null) {
      throw new SupportAccessError(503, "support_receipt_unavailable");
    }
    return {
      ...storedResponse,
      changed: revoked.revoke_request_id === requestId,
      revoked_at: Number(revoked.revoked_at),
      replayed: false,
    };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      const replay = await requestReplay(env, { requestId, action: "revoke", requestFingerprint });
      if (replay) return replay;
    }
    unavailable(error);
  }
}

async function issueSupportChallenge(env, purpose) {
  const challenge = randomToken(32);
  const now = Date.now();
  const challengeHash = await sha256(challenge);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM support_auth_challenges WHERE expires_at<=?").bind(now),
    env.DB.prepare(
      `INSERT INTO support_auth_challenges (challenge_hash,purpose,expires_at)
       SELECT ?,?,? WHERE (SELECT COUNT(*) FROM support_auth_challenges)<?`,
    ).bind(challengeHash, purpose, now + 5 * 60 * 1000, SUPPORT_CHALLENGE_MAX_ROWS),
  ]);
  const stored = await env.DB.prepare(
    "SELECT challenge_hash FROM support_auth_challenges WHERE challenge_hash=?",
  ).bind(challengeHash).first();
  if (!stored) throw new SupportAccessError(429, "support_challenge_capacity");
  return challenge;
}

async function consumeSupportChallenge(env, challenge, purpose) {
  const hash = await sha256(challenge);
  const row = await env.DB.prepare(
    `DELETE FROM support_auth_challenges
      WHERE challenge_hash=? AND purpose=? AND expires_at>?
      RETURNING challenge_hash`,
  ).bind(hash, purpose, Date.now()).first();
  return Boolean(row?.challenge_hash);
}

function challengeFromClientData(clientDataJSON) {
  try {
    return JSON.parse(new TextDecoder().decode(b64uDecode(clientDataJSON)))?.challenge || null;
  } catch {
    return null;
  }
}

async function enrollmentForCode(env, code) {
  const codeHash = await sha256(code);
  const row = await env.DB.prepare(
    `SELECT c.code_hash,c.expires_at,c.used_at,c.request_id,
            s.support_session_id,s.technician_label,s.duration_minutes,s.created_at,
            s.activated_at,s.expires_at session_expires_at,s.revoked_at
       FROM support_enrollment_codes c
       JOIN support_sessions s ON s.support_session_id=c.support_session_id
      WHERE c.code_hash=? AND s.current_invite_code_hash=c.code_hash`,
  ).bind(codeHash).first();
  if (!row || row.used_at !== null || Number(row.expires_at) <= Date.now() ||
      row.revoked_at !== null || row.activated_at !== null) return null;
  return row;
}

async function activateSupportPasskey(env, enrollment, verified) {
  const now = Date.now();
  const expiresAt = now + Number(enrollment.duration_minutes) * 60_000;
  const credentialKey = (await sha256(verified.credentialId)).slice(0, 24);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO support_passkeys
         (credential_id,credential_key,support_session_id,public_key_jwk,alg,sign_count,created_at,last_used_at)
       SELECT ?,?,?,?,?,?,?,?
        WHERE EXISTS (
          SELECT 1 FROM support_enrollment_codes c
          JOIN support_sessions s ON s.support_session_id=c.support_session_id
          WHERE c.code_hash=? AND c.support_session_id=? AND c.used_at IS NULL
            AND c.expires_at>? AND s.activated_at IS NULL AND s.revoked_at IS NULL
        )`,
    ).bind(
      verified.credentialId, credentialKey, enrollment.support_session_id,
      JSON.stringify(verified.jwk), verified.alg, verified.signCount, now, now,
      enrollment.code_hash, enrollment.support_session_id, now,
    ),
    env.DB.prepare(
      `UPDATE support_enrollment_codes SET used_at=?
        WHERE code_hash=? AND used_at IS NULL
          AND EXISTS (SELECT 1 FROM support_passkeys
                       WHERE credential_id=? AND support_session_id=?)`,
    ).bind(now, enrollment.code_hash, verified.credentialId, enrollment.support_session_id),
    env.DB.prepare(
      `UPDATE support_sessions
          SET activated_at=?,expires_at=?,last_authenticated_at=?
        WHERE support_session_id=? AND activated_at IS NULL AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM support_passkeys
                       WHERE credential_id=? AND support_session_id=?)`,
    ).bind(now, expiresAt, now, enrollment.support_session_id, verified.credentialId, enrollment.support_session_id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO support_access_events
         (event_id,occurred_at,request_id,support_session_id,event_type,decision,reason_code,route)
       SELECT ?,?,NULL,support_session_id,'activated','allow','support_session_activated',NULL
         FROM support_sessions WHERE support_session_id=? AND activated_at=?`,
    ).bind(`support:activated:${enrollment.support_session_id}`, now, enrollment.support_session_id, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO owner_activity_events
         (event_id,tenant_id,request_id,event_type,entity_slug,subject_kind,subject_id,display_label,occurred_at)
       SELECT ?,'primary',NULL,'support_access_activated',NULL,'support_session',
              support_session_id,technician_label,?
         FROM support_sessions WHERE support_session_id=? AND activated_at=?`,
    ).bind(
      `activity:support-session-activated:${enrollment.support_session_id}`,
      new Date(now).toISOString(), enrollment.support_session_id, now,
    ),
  ]);
  const wonActivation = await env.DB.prepare(
    `SELECT s.support_session_id
       FROM support_sessions s
       JOIN support_passkeys p
         ON p.support_session_id=s.support_session_id AND p.credential_id=?
       JOIN support_enrollment_codes c
         ON c.support_session_id=s.support_session_id AND c.code_hash=?
      WHERE s.support_session_id=? AND s.current_invite_code_hash=c.code_hash
        AND c.used_at=? AND s.activated_at=? AND s.expires_at=?`,
  ).bind(
    verified.credentialId, enrollment.code_hash, enrollment.support_session_id,
    now, now, expiresAt,
  ).first();
  if (!wonActivation) {
    throw new SupportAccessError(409, "support_invite_not_activatable");
  }
  const active = await sessionRow(env, enrollment.support_session_id);
  if (!active) throw new SupportAccessError(409, "support_invite_not_activatable");
  return active;
}

async function findSupportPasskey(env, credentialId) {
  const row = await env.DB.prepare(
    `SELECT credential_id,public_key_jwk,alg,sign_count,support_session_id
       FROM support_passkeys WHERE credential_id=?`,
  ).bind(credentialId).first();
  if (!row) return null;
  return { ...row, jwk: JSON.parse(row.public_key_jwk) };
}

async function liveSession(env, sessionId, { allowIdle = false } = {}) {
  const row = await sessionRow(env, sessionId);
  if (!row || row.activated_at === null) {
    return { denied: true, code: "support_session_inactive", supportSessionId: sessionId };
  }
  if (row.revoked_at !== null) {
    return { denied: true, code: "support_session_revoked", supportSessionId: sessionId };
  }
  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    return { denied: true, code: "support_session_expired", supportSessionId: sessionId };
  }
  const anchor = idleAnchor(row);
  if (!allowIdle && anchor + SUPPORT_IDLE_TTL_MS <= now) {
    return { denied: true, code: "support_session_idle_expired", supportSessionId: sessionId };
  }
  return {
    kind: "support", supportSessionId: row.support_session_id,
    technicianLabel: row.technician_label, expiresAt: Number(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    idleAnchorAt: anchor,
  };
}

async function recordSupportDecision(env, {
  sessionId, eventType, decision, reasonCode, route = null,
}) {
  if (!SUPPORT_ID.test(String(sessionId || ""))) return;
  try {
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60_000);
    await supportEventStatement(env, {
      eventId: `support:${eventType}:${sessionId}:${route || "session"}:${minuteBucket}`,
      at: now, sessionId, eventType, decision, reasonCode, route,
    }).run();
  } catch {
    // Audit failure never turns a deny into access. Successful reads use the
    // atomic path below and do fail closed if their audit cannot be written.
  }
}

async function mintSupportCookie(env, principal) {
  const payload = `${principal.expiresAt}.${principal.supportSessionId}`;
  const signature = b64u(await hmac(env.SESSION_SIGNING_KEY, `financial-brain:support-cookie:v1:${payload}`));
  const maxAge = Math.max(0, Math.floor((principal.expiresAt - Date.now()) / 1000));
  return `${SUPPORT_COOKIE}=v1.${payload}.${signature}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSupportCookie() {
  return `${SUPPORT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function readSupportCookie(request, env) {
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SUPPORT_COOKIE}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, expires, sessionId, signature] = parts;
  const expiresAt = Number(expires);
  if (!/^\d+$/.test(expires) || !Number.isSafeInteger(expiresAt) || !SUPPORT_ID.test(sessionId)) return null;
  const expected = b64u(await hmac(
    env.SESSION_SIGNING_KEY,
    `financial-brain:support-cookie:v1:${expires}.${sessionId}`,
  ));
  if (!constantTimeEquals(signature, expected)) return null;
  return { sessionId, expired: expiresAt <= Date.now() };
}

function withCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

async function requestPrincipal(request, env) {
  if (request.headers.get(SUPPORT_HEADER) !== "1") return null;
  const cookie = await readSupportCookie(request, env);
  if (!cookie) return null;
  if (cookie.expired) {
    return {
      denied: true,
      code: "support_session_expired",
      supportSessionId: cookie.sessionId,
    };
  }
  return liveSession(env, cookie.sessionId);
}

async function touchSupportUse(env, principal, route) {
  const now = Date.now();
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  const eventId = `support:read:${principal.supportSessionId}:${route}:${Math.floor(now / 60_000)}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE support_sessions
          SET last_used_at=?,first_used_at=COALESCE(first_used_at,?)
        WHERE support_session_id=? AND revoked_at IS NULL AND expires_at>?
          AND MAX(COALESCE(last_used_at,0),COALESCE(last_authenticated_at,0))>?
          AND (last_used_at IS NULL OR last_used_at<?)`,
    ).bind(
      now, now, principal.supportSessionId, now,
      now - SUPPORT_IDLE_TTL_MS, minuteStart,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO support_access_events
         (event_id,occurred_at,request_id,support_session_id,event_type,decision,reason_code,route)
       SELECT ?,?,NULL,support_session_id,'read','allow','support_read_allowed',?
         FROM support_sessions
        WHERE support_session_id=? AND revoked_at IS NULL AND expires_at>?
          AND MAX(COALESCE(last_used_at,0),COALESCE(last_authenticated_at,0))>?`,
    ).bind(
      eventId, now, route, principal.supportSessionId, now,
      now - SUPPORT_IDLE_TTL_MS,
    ),
  ]);
  const refreshed = await liveSession(env, principal.supportSessionId);
  if (refreshed.denied) throw new SupportAccessError(403, refreshed.code);
  return refreshed;
}

async function reserveSupportSystemRead(env, principal) {
  const now = Date.now();
  const reserved = await env.DB.prepare(
    `UPDATE support_sessions
        SET last_system_at=?
      WHERE support_session_id=? AND revoked_at IS NULL AND expires_at>?
        AND MAX(COALESCE(last_used_at,0),COALESCE(last_authenticated_at,0))>?
        AND (last_system_at IS NULL OR last_system_at<=?)
      RETURNING support_session_id`,
  ).bind(
    now, principal.supportSessionId, now,
    now - SUPPORT_IDLE_TTL_MS, now - SUPPORT_SYSTEM_MIN_INTERVAL_MS,
  ).first();
  if (reserved?.support_session_id) return;
  const refreshed = await liveSession(env, principal.supportSessionId);
  if (refreshed.denied) throw new SupportAccessError(403, refreshed.code);
  await recordSupportDecision(env, {
    sessionId: principal.supportSessionId,
    eventType: "denied",
    decision: "deny",
    reasonCode: "support_system_rate_limited",
    route: "system",
  });
  throw new SupportAccessError(429, "support_system_rate_limited");
}

const DIAGNOSTIC_CODES = Object.freeze({
  empty_documents: "empty_corpus",
  undated: "undated_documents",
  unregistered_source: "source_registration_issue",
  empty_source: "empty_source",
  store_agreement: "index_consistency_issue",
  backlog: "vector_backlog",
  quarantined: "vector_failures",
  orphan_chunks: "orphan_chunks",
  blank_chunks: "blank_chunks",
  duplicate_documents: "duplicate_documents",
  chunk_outliers: "chunk_outliers",
  oversized_chunks: "oversized_chunks",
  duplicate_chunks: "duplicate_chunks",
});

/** A stricter support projection. Raw titles, details, source reasons, ids,
 * samples, paths, URLs, and actions have no field in this output shape. */
export function supportSystemProjection(status) {
  const unavailableAllowlist = new Set(["health", "diagnose", "freshness", "vectors", "install_state"]);
  const stateAllowlist = new Set(["ok", "never_synced", "stale", "broken", "indexing", "unknown"]);
  const kindAllowlist = new Set(["upload", "drive", "message", "email", "calendar"]);
  const out = {
    accepting_documents: status.accepting_documents ?? null,
    status: ["ok", "paused-for-upgrade"].includes(status.status) ? status.status : null,
    drain_mode: ["active", "paused-for-upgrade"].includes(status.drain_mode) ? status.drain_mode : null,
    unavailable: Array.isArray(status.unavailable)
      ? status.unavailable.map(String).filter((value) => unavailableAllowlist.has(value))
      : [],
  };
  if (Number.isFinite(status.documents)) out.documents = Number(status.documents);
  if (Number.isFinite(status.chunks)) out.chunks = Number(status.chunks);
  if (status.problem_counts) {
    out.problem_counts = {
      crit: Number(status.problem_counts.crit || 0),
      warn: Number(status.problem_counts.warn || 0),
      info: Number(status.problem_counts.info || 0),
    };
  }
  if (Array.isArray(status.problems)) {
    out.problems = status.problems
      .filter((problem) => problem.severity === "crit" || problem.severity === "warn")
      .map((problem) => ({
        code: DIAGNOSTIC_CODES[problem.id] || "diagnostic_issue",
        area: ["meta", "coverage", "integrity", "efficiency"].includes(problem.area)
          ? problem.area : "diagnostics",
        severity: problem.severity,
        count: Number(problem.count || 0),
        repairability: "guidance_only",
      }));
  }
  if (Array.isArray(status.sources)) {
    out.sources = status.sources.map((source) => ({
      label: [
        "Files you uploaded", "Google Drive", "Messages", "Email", "Calendar",
        "Meeting recordings", "Another source",
      ].includes(source.label) ? source.label : "Another source",
      kind: kindAllowlist.has(source.kind) ? source.kind : "other",
      state: stateAllowlist.has(source.state) ? source.state : "unknown",
      documents: Number(source.documents || 0),
      days_since_ingest: source.days_since_ingest === null ? null : Number(source.days_since_ingest),
      automatable: Boolean(source.automatable),
    }));
  }
  if (status.vectors) {
    out.vectors = {
      ready: Boolean(status.vectors.ready),
      expected: Number(status.vectors.expected || 0),
      visible: Number(status.vectors.visible || 0),
      pending: Number(status.vectors.pending || 0),
      percent_visible: status.vectors.percent_visible === null ? null : Number(status.vectors.percent_visible),
    };
  }
  return out;
}

async function supportInstallStatus(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT product_version,schema_version FROM install_state ORDER BY id LIMIT 1",
    ).first();
    const productVersion = typeof row?.product_version === "string"
      ? row.product_version.trim() : "";
    const schemaVersion = Number(row?.schema_version);
    return productVersion && productVersion.length <= 40 && Number.isInteger(schemaVersion) && schemaVersion >= 1
      ? { product_version: productVersion, schema_version: schemaVersion }
      : null;
  } catch {
    return null;
  }
}

function principalResponse(env, principal) {
  return {
    signed_in: true,
    principal: {
      kind: "support",
      support_session_id: principal.supportSessionId,
      technician_label: principal.technicianLabel,
      technician_identity_verified: false,
      expires_at: principal.expiresAt,
      idle_expires_at: Math.min(
        principal.expiresAt,
        principal.idleAnchorAt + SUPPORT_IDLE_TTL_MS,
      ),
      read_only: true,
    },
    workspace: {
      support: true,
      home: false,
      documents: false,
      ask: false,
      add_review: false,
      access: false,
      bank: false,
      targets: false,
      preferences: false,
      connections: false,
    },
    can_fix: false,
    repair_mode: "owner_approval_required_future",
  };
}

export async function handleSupportAccess(env, request, url, path) {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (request.headers.get(SUPPORT_HEADER) !== "1") {
    return jsonResponse({ error: "unauthorized", code: "support_session_required" }, 401);
  }
  if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    return withCookie(
      jsonResponse({ error: "unavailable", code: "support_access_unavailable" }, 503),
      clearSupportCookie(),
    );
  }
  let payload = null;
  try { payload = await request.json(); } catch { payload = null; }
  const rpId = url.hostname;
  const origin = url.origin;
  try {
    requireDb(env);
    if (path === "/api/support/auth/register/options") {
      const code = String(payload?.code || "");
      const enrollment = code ? await enrollmentForCode(env, code) : null;
      if (!enrollment) throw new SupportAccessError(403, "support_enrollment_required");
      const challenge = await issueSupportChallenge(env, "register");
      return jsonResponse({
        challenge,
        rp: { id: rpId, name: env.BRAIN_NAME || "brain" },
        user_name: "Invited technician",
      });
    }

    if (path === "/api/support/auth/register/verify") {
      const code = String(payload?.code || "");
      const enrollment = code ? await enrollmentForCode(env, code) : null;
      if (!enrollment) throw new SupportAccessError(403, "support_enrollment_invalid");
      const challenge = challengeFromClientData(payload?.clientDataJSON);
      if (!challenge || !(await consumeSupportChallenge(env, challenge, "register"))) {
        throw new SupportAccessError(403, "support_challenge_invalid");
      }
      let verified;
      try {
        verified = await verifyRegistration({
          attestationObject: payload.attestationObject,
          clientDataJSON: payload.clientDataJSON,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          rpId,
        });
      } catch {
        throw new SupportAccessError(403, "support_passkey_verification_failed");
      }
      const active = await activateSupportPasskey(env, enrollment, verified);
      const principal = await liveSession(env, active.support_session_id);
      return withCookie(jsonResponse({ enrolled: true }), await mintSupportCookie(env, principal));
    }

    if (path === "/api/support/auth/login/options") {
      return jsonResponse({ challenge: await issueSupportChallenge(env, "login"), rp_id: rpId });
    }

    if (path === "/api/support/auth/login/verify") {
      const challenge = challengeFromClientData(payload?.clientDataJSON);
      if (!challenge || !(await consumeSupportChallenge(env, challenge, "login"))) {
        throw new SupportAccessError(403, "support_challenge_invalid");
      }
      const credential = await findSupportPasskey(env, String(payload?.credentialId || ""));
      if (!credential) throw new SupportAccessError(403, "support_passkey_unknown");
      const principal = await liveSession(env, credential.support_session_id, { allowIdle: true });
      if (principal.denied) throw new SupportAccessError(403, principal.code);
      let verdict;
      try {
        verdict = await verifyAssertion({
          authenticatorData: payload.authenticatorData,
          clientDataJSON: payload.clientDataJSON,
          signature: payload.signature,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          rpId,
          credential,
        });
      } catch {
        throw new SupportAccessError(403, "support_passkey_verification_failed");
      }
      if (verdict.cloneSuspected) throw new SupportAccessError(403, "support_passkey_counter_regressed");
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE support_passkeys SET sign_count=?,last_used_at=? WHERE credential_id=?",
        ).bind(verdict.signCount, now, credential.credential_id),
        supportEventStatement(env, {
          eventId: `support:authenticated:${credential.support_session_id}:${Math.floor(now / 60_000)}`,
          at: now, sessionId: credential.support_session_id,
          eventType: "authenticated", reasonCode: "support_authenticated",
        }),
        env.DB.prepare(
          "UPDATE support_sessions SET last_authenticated_at=? WHERE support_session_id=? AND revoked_at IS NULL AND expires_at>?",
        ).bind(now, credential.support_session_id, now),
      ]);
      const refreshed = await liveSession(env, credential.support_session_id);
      if (refreshed.denied) throw new SupportAccessError(403, refreshed.code);
      return withCookie(jsonResponse({ signed_in: true }), await mintSupportCookie(env, refreshed));
    }

    if (path === "/api/support/signout") {
      return withCookie(jsonResponse({ signed_out: true }), clearSupportCookie());
    }

    const principal = await requestPrincipal(request, env);
    if (!principal) return jsonResponse({ error: "unauthorized", code: "support_session_required" }, 401);
    if (principal.denied) {
      await recordSupportDecision(env, {
        sessionId: principal.supportSessionId,
        eventType: principal.code.includes("expired") ? "expired" : "denied",
        decision: "deny",
        reasonCode: principal.code,
      });
      return withCookie(jsonResponse({
        error: "forbidden", code: principal.code,
        signed_in: false, clear_session: true,
        recovery: supportSessionRecovery(principal.code),
      }, 403), clearSupportCookie());
    }

    if (path === "/api/support/me") {
      const refreshed = await touchSupportUse(env, principal, "me");
      return jsonResponse(principalResponse(env, refreshed));
    }
    if (path === "/api/support/system") {
      const refreshed = await touchSupportUse(env, principal, "system");
      // Reserve the expensive aggregate read atomically. Concurrent or rapid
      // callers still recheck D1 authority, but only one can reach diagnose,
      // freshness, or Vectorize in each bounded interval.
      await reserveSupportSystemRead(env, refreshed);
      const ownerStatus = await ownerSystemStatus(env, {
        health: (currentEnv) => {
          const paused = currentEnv.VECTOR_DRAIN_MODE === "paused-for-upgrade";
          return {
            status: paused ? "paused-for-upgrade" : "ok",
            accepting_documents: !paused,
            vector_drain_mode: paused ? "paused-for-upgrade" : "active",
          };
        },
        diagnose,
        freshness: freshnessReport,
        vectorReadiness,
      });
      const projected = supportSystemProjection(ownerStatus);
      const install = await supportInstallStatus(env);
      if (!install) throw new SupportAccessError(503, "support_access_unavailable");
      // Diagnose/freshness/vector reads may take long enough for the owner to
      // revoke access. Check mutable authority again immediately before any
      // aggregate is serialized.
      const finalPrincipal = await liveSession(env, refreshed.supportSessionId);
      if (finalPrincipal.denied) throw new SupportAccessError(403, finalPrincipal.code);
      const observedAt = Date.now();
      if (projected.unavailable.length) {
        await recordSupportDecision(env, {
          sessionId: refreshed.supportSessionId,
          eventType: "unavailable", decision: "unavailable",
          reasonCode: "support_projection_partial", route: "system",
        });
      }
      return jsonResponse({
        status: projected.unavailable.length ? "partial" : "ready",
        observed_at: observedAt,
        unavailable: projected.unavailable,
        access: {
          kind: "support",
          technician_label: finalPrincipal.technicianLabel,
          expires_at: finalPrincipal.expiresAt,
          remaining_seconds: Math.max(0, Math.floor((finalPrincipal.expiresAt - observedAt) / 1000)),
          read_only: true,
          can_fix: false,
        },
        privacy: {
          mode: "aggregate_only",
          content_visible: false,
          search_available: false,
          raw_errors_visible: false,
          credentials_visible: false,
          account_identifiers_visible: false,
        },
        brain: {
          product_version: install.product_version,
          schema_version: install.schema_version,
          status: projected.status,
          accepting_documents: projected.accepting_documents,
          drain_mode: projected.drain_mode,
        },
        ...(Number.isFinite(projected.documents) && Number.isFinite(projected.chunks)
          ? { corpus: { documents: projected.documents, chunks: projected.chunks } }
          : {}),
        ...(projected.vectors ? { vectors: projected.vectors } : {}),
        ...(projected.problem_counts ? { problem_counts: projected.problem_counts } : {}),
        ...(projected.problems ? { problems: projected.problems } : {}),
        ...(projected.sources ? { sources: projected.sources } : {}),
      });
    }
    return jsonResponse({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof SupportAccessError && error.status === 403 &&
        error.code.startsWith("support_session_")) {
      return withCookie(jsonResponse({
        error: "forbidden", code: error.code,
        signed_in: false, clear_session: true,
        recovery: supportSessionRecovery(error.code),
      }, 403), clearSupportCookie());
    }
    return errorResponse(error);
  }
}
