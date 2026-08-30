/**
 * auth-store — the D1 rows behind passkey access.
 *
 * Three small tables (migration 0014) in the OWNER'S database: enrolled
 * passkeys (public halves only), single-use challenges, and single-use
 * enrollment codes. Secrets are stored hashed: a challenge or enrollment
 * code read out of a stolen database backup opens nothing.
 *
 * Every function takes env and speaks plain SQL, and every function maps a
 * missing-table error to a single clear message, because an older install
 * whose operator has not run `brain setup` yet must say "run setup", not
 * throw SQL noise at an owner's sign-in screen.
 */

import { ownerActivityStatement } from "./owner-activity.js";

const MIGRATION_HINT = "passkey tables are missing; run `brain setup <manifest>` to apply migration 0014";

function guard(error) {
  if (/no such table/i.test(String(error?.message || error))) {
    throw new Error(MIGRATION_HINT);
  }
  throw error;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let ascii = "";
  for (const byte of raw) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* -------------------------------------------------------------- challenges */

export async function issueChallenge(env, purpose, ttlMs = 5 * 60 * 1000) {
  const challenge = randomToken(32);
  try {
    await env.DB.prepare(
      "INSERT INTO auth_challenges (challenge_hash, purpose, expires_at) VALUES (?, ?, ?)",
    ).bind(await sha256Hex(challenge), purpose, Date.now() + ttlMs).run();
  } catch (error) {
    guard(error);
  }
  return challenge;
}

/** Read-only preflight before an expensive cryptographic ceremony. */
export async function peekChallenge(env, challenge, purpose) {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS valid FROM auth_challenges
        WHERE challenge_hash = ? AND purpose = ? AND expires_at > ? AND used_at IS NULL`,
    ).bind(await sha256Hex(challenge), purpose, Date.now()).first();
    return Boolean(row);
  } catch (error) {
    guard(error);
  }
}

/** Single use: the conditional delete is the decision, not a prior read. */
export async function consumeChallenge(env, challenge, purpose) {
  try {
    const hash = await sha256Hex(challenge);
    const result = await env.DB.prepare(
      `DELETE FROM auth_challenges
        WHERE challenge_hash = ? AND purpose = ? AND expires_at > ? AND used_at IS NULL`,
    ).bind(hash, purpose, Date.now()).run();
    return Number(result?.meta?.changes || 0) === 1;
  } catch (error) {
    guard(error);
  }
}

/* -------------------------------------------------------- enrollment codes */

export async function issueEnrollmentCode(env, options = {}) {
  const normalized = typeof options === "number" ? { ttlMs: options } : options || {};
  const ttlMs = normalized.ttlMs ?? 15 * 60 * 1000;
  const grantId = normalized.grantId ?? null;
  const documentGrantId = normalized.documentGrantId ?? null;
  if (grantId !== null && documentGrantId !== null) {
    throw new Error("an enrollment code cannot widen across two grant types");
  }
  const code = normalized.code || randomToken(24);
  try {
    await env.DB.prepare(
      "INSERT INTO enrollment_codes (code_hash, expires_at, grant_id, document_grant_id) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(code), Date.now() + ttlMs, grantId, documentGrantId).run();
  } catch (error) {
    guard(error);
  }
  return code;
}

/** Valid, unexpired, unused — WITHOUT consuming. A mistyped Face ID attempt
 *  must not burn the invite; only a completed verify consumes it. */
export async function peekEnrollmentCode(env, code) {
  try {
    const row = await env.DB.prepare(
      "SELECT expires_at, used_at, grant_id, document_grant_id FROM enrollment_codes WHERE code_hash = ?",
    ).bind(await sha256Hex(code)).first();
    return row && !row.used_at && Number(row.expires_at) > Date.now()
      ? { grantId: row.grant_id ?? null, documentGrantId: row.document_grant_id ?? null }
      : null;
  } catch (error) {
    guard(error);
  }
}

export async function consumeEnrollmentCode(env, code) {
  try {
    const hash = await sha256Hex(code);
    const now = Date.now();
    const row = await env.DB.prepare(
      `UPDATE enrollment_codes SET used_at = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING grant_id, document_grant_id`,
    ).bind(now, hash, now).first();
    if (!row) return false;
    return { grantId: row.grant_id ?? null, documentGrantId: row.document_grant_id ?? null };
  } catch (error) {
    guard(error);
  }
}

/* ---------------------------------------------------------------- passkeys */

export async function storePasskey(env, {
  credentialId, jwk, alg, signCount, nickname, grantId = null, documentGrantId = null,
  securityEvent = null, ownerActivity = null,
}) {
  if (grantId !== null && documentGrantId !== null) {
    throw new Error("a passkey cannot widen across two grant types");
  }
  try {
    const createdAt = Date.now();
    const safeNickname = String(nickname || "").slice(0, 60);
    const insert = env.DB.prepare(
      "INSERT INTO owner_passkeys (credential_id, public_key_jwk, alg, sign_count, nickname, created_at, grant_id, document_grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(credentialId, JSON.stringify(jwk), alg, signCount, safeNickname || null, createdAt, grantId, documentGrantId);
    const statements = [insert];
    if (securityEvent) statements.push(passkeyEventStatement(env, securityEvent));
    if (ownerActivity) {
      const passkeyKey = (await sha256Hex(credentialId)).slice(0, 24);
      statements.push(ownerActivityStatement(env, {
        eventId: `activity:passkey-added:${passkeyKey}`,
        eventType: "passkey_added",
        entitySlug: ownerActivity.entitySlug || null,
        subjectKind: "passkey",
        subjectId: `passkey:${passkeyKey}`,
        displayLabel: safeNickname || ownerActivity.displayLabel || "Passkey device",
        occurredAt: new Date(createdAt).toISOString(),
      }));
    }
    if (statements.length > 1) await env.DB.batch(statements);
    else await insert.run();
  } catch (error) {
    guard(error);
  }
}

/* ------------------------------------------------------- capability grants */

export async function findGrantByCredentialHash(env, tokenHash) {
  try {
    return await env.DB.prepare(
      `SELECT g.grant_id, g.display_name, g.capabilities, g.expires_at, g.revoked_at,
              g.scope_include, g.scope_exclude,
              c.revoked_at AS credential_revoked_at
         FROM grant_credentials c
         JOIN grants g ON g.grant_id = c.grant_id
        WHERE c.token_hash = ?`,
    ).bind(tokenHash).first();
  } catch (error) {
    guard(error);
  }
}

export async function createGrant(env, {
  grantId, displayName, relationship, capabilities, expiresAt, createdBy,
  scopeInclude = '{"all":true}', scopeExclude = "[]",
}) {
  try {
    await env.DB.prepare(
      `INSERT INTO grants (grant_id, display_name, relationship, capabilities, expires_at, created_at, created_by,
                           scope_include, scope_exclude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      grantId, displayName, relationship || null, JSON.stringify(capabilities),
      expiresAt ?? null, Date.now(), createdBy, scopeInclude, scopeExclude,
    ).run();
  } catch (error) {
    guard(error);
  }
}

export async function addGrantCredential(env, { tokenHash, grantId }) {
  try {
    await env.DB.prepare(
      "INSERT INTO grant_credentials (token_hash, grant_id, created_at) VALUES (?, ?, ?)",
    ).bind(tokenHash, grantId, Date.now()).run();
  } catch (error) {
    guard(error);
  }
}

export async function listGrants(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT grant_id, display_name, relationship, capabilities, expires_at,
              created_at, revoked_at, last_used_at
         FROM grants ORDER BY created_at DESC`,
    ).all();
    return results || [];
  } catch (error) {
    guard(error);
  }
}

export async function revokeGrant(env, grantId) {
  try {
    const result = await env.DB.prepare(
      "UPDATE grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
    ).bind(Date.now(), grantId).run();
    return Boolean(result?.meta?.changes);
  } catch (error) {
    guard(error);
  }
}

export async function findGrantById(env, grantId) {
  try {
    return await env.DB.prepare(
      `SELECT grant_id, display_name, capabilities, expires_at, revoked_at,
              scope_include, scope_exclude
         FROM grants WHERE grant_id = ?`,
    ).bind(grantId).first();
  } catch (error) {
    guard(error);
  }
}

export async function findPasskey(env, credentialId) {
  try {
    const row = await env.DB.prepare(
      "SELECT credential_id, public_key_jwk, alg, sign_count, nickname, grant_id, document_grant_id FROM owner_passkeys WHERE credential_id = ?",
    ).bind(credentialId).first();
    if (!row) return null;
    return { ...row, jwk: JSON.parse(row.public_key_jwk) };
  } catch (error) {
    guard(error);
  }
}

export async function recordPasskeyUse(
  env, credentialId, previousSignCount, signCount, securityEvent = null,
) {
  try {
    const lastUsedAt = Date.now();
    const update = env.DB.prepare(
      `UPDATE owner_passkeys SET sign_count = ?, last_used_at = ?
        WHERE credential_id = ? AND sign_count = ?`,
    ).bind(signCount, lastUsedAt, credentialId, previousSignCount);
    const statements = [update];
    if (securityEvent) {
      statements.push(env.DB.prepare(
        `INSERT INTO passkey_security_events
         (event_id, occurred_at, rp_id, ceremony, stage, outcome, reason_code, duration_ms,
          principal_kind, grant_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM owner_passkeys
          WHERE credential_id = ? AND sign_count = ? AND last_used_at = ?`,
      ).bind(
        ...passkeyEventBindings(securityEvent), credentialId, signCount, lastUsedAt,
      ));
    }
    const results = await env.DB.batch(statements);
    return Number(results?.[0]?.meta?.changes || 0) === 1;
  } catch (error) {
    guard(error);
  }
}

export async function listPasskeys(env) {
  try {
    const rows = await env.DB.prepare(
      "SELECT credential_id, alg, nickname, grant_id, document_grant_id, created_at, last_used_at FROM owner_passkeys ORDER BY created_at",
    ).all();
    return rows?.results || [];
  } catch (error) {
    guard(error);
  }
}

export async function renamePasskey(env, credentialId, nickname) {
  try {
    const row = await env.DB.prepare(
      "SELECT credential_id, nickname FROM owner_passkeys WHERE credential_id = ?",
    ).bind(credentialId).first();
    if (!row) return { renamed: false, changed: false };
    const nextNickname = String(nickname || "").slice(0, 60);
    if (String(row.nickname || "") === nextNickname) return { renamed: true, changed: false };
    const passkeyKey = (await sha256Hex(credentialId)).slice(0, 24);
    const nicknameKey = (await sha256Hex(nextNickname)).slice(0, 16);
    const occurredAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE owner_passkeys SET nickname = ? WHERE credential_id = ?",
      ).bind(nextNickname, credentialId),
      ownerActivityStatement(env, {
        eventId: `activity:passkey-renamed:${passkeyKey}:${nicknameKey}`,
        eventType: "passkey_renamed",
        subjectKind: "passkey",
        subjectId: `passkey:${passkeyKey}`,
        displayLabel: nextNickname || "Passkey device",
        occurredAt,
      }),
    ]);
    return { renamed: true, changed: true };
  } catch (error) {
    guard(error);
  }
}

/**
 * Deleting the LAST passkey is refused: it would lock the owner out until a
 * new invite, and "the system quietly made me unreachable" is exactly the
 * failure custody is supposed to prevent. Mint a new invite first.
 */
export async function revokePasskey(env, credentialId) {
  try {
    const row = await env.DB.prepare(
      "SELECT credential_id, nickname, grant_id, document_grant_id FROM owner_passkeys WHERE credential_id = ?",
    ).bind(credentialId).first();
    if (!row) return { removed: false, reason: "passkey not found" };
    const passkeyKey = (await sha256Hex(credentialId)).slice(0, 24);
    const occurredAt = new Date().toISOString();
    // A scoped credential is never an owner lockout safeguard. For an owner
    // credential, this predicate requires a different unrestricted owner
    // credential to exist in the same atomic transaction. Two concurrent
    // revocations can therefore remove at most one of the final two owners.
    const safePredicate = `(
      p.grant_id IS NOT NULL OR p.document_grant_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM owner_passkeys other
         WHERE other.credential_id <> p.credential_id
           AND other.grant_id IS NULL AND other.document_grant_id IS NULL
      )
    )`;
    const activity = env.DB.prepare(
      `INSERT OR IGNORE INTO owner_activity_events
         (event_id, tenant_id, request_id, event_type, entity_slug,
          subject_kind, subject_id, display_label, occurred_at)
       SELECT ?, 'primary', NULL, 'passkey_revoked', NULL,
              'passkey', ?,
              COALESCE(NULLIF(p.nickname, ''),
                CASE WHEN p.grant_id IS NOT NULL OR p.document_grant_id IS NOT NULL
                     THEN 'Shared access passkey' ELSE 'Passkey device' END), ?
         FROM owner_passkeys p
        WHERE p.credential_id = ? AND ${safePredicate}`,
    ).bind(
      `activity:passkey-revoked:${passkeyKey}`, `passkey:${passkeyKey}`,
      occurredAt, credentialId,
    );
    const removal = env.DB.prepare(
      `DELETE FROM owner_passkeys
        WHERE credential_id = ? AND (
          grant_id IS NOT NULL OR document_grant_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM owner_passkeys other
             WHERE other.credential_id <> owner_passkeys.credential_id
               AND other.grant_id IS NULL AND other.document_grant_id IS NULL
          )
        )`,
    ).bind(credentialId);
    const results = await env.DB.batch([activity, removal]);
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) {
      return {
        removed: false,
        reason: "refusing to remove the last owner passkey; enroll another owner device or mint a new invite first",
      };
    }
    return { removed: true };
  } catch (error) {
    guard(error);
  }
}

/* ------------------------------------------------------ session generation */

export async function sessionGeneration(env) {
  try {
    const row = await env.DB.prepare("SELECT session_generation FROM install_state LIMIT 1").first();
    return Number(row?.session_generation || 1);
  } catch (error) {
    if (/no such column|no such table/i.test(String(error?.message || error))) return 1;
    throw error;
  }
}

export async function bumpSessionGeneration(env) {
  try {
    const nextGeneration = (await sessionGeneration(env)) + 1;
    const occurredAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE install_state SET session_generation = COALESCE(session_generation, 1) + 1",
      ),
      ownerActivityStatement(env, {
        eventId: `activity:sessions-revoked:${nextGeneration}`,
        eventType: "sessions_revoked",
        subjectKind: "sessions",
        subjectId: `generation:${nextGeneration}`,
        displayLabel: "Signed out everywhere",
        occurredAt,
      }),
    ]);
    return nextGeneration;
  } catch (error) {
    guard(error);
  }
}

/* --------------------------------------------------- privacy-safe telemetry */

function passkeyEventBindings({
  rpId, ceremony, stage, outcome, reasonCode, durationMs = null,
  principalKind = "unknown", grantId = null,
}) {
  return [
    `pse_${randomToken(18)}`, Date.now(), String(rpId || "unknown").slice(0, 253),
    ceremony, stage, outcome, String(reasonCode || "unspecified").slice(0, 80),
    durationMs === null ? null : Math.max(0, Math.round(Number(durationMs) || 0)),
    principalKind, grantId,
  ];
}

function passkeyEventStatement(env, event) {
  return env.DB.prepare(
    `INSERT INTO passkey_security_events
     (event_id, occurred_at, rp_id, ceremony, stage, outcome, reason_code, duration_ms,
      principal_kind, grant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(...passkeyEventBindings(event));
}

export async function recordPasskeySecurityEvent(env, {
  rpId, ceremony, stage, outcome, reasonCode, durationMs = null,
  principalKind = "unknown", grantId = null,
}) {
  try {
    await passkeyEventStatement(env, {
      rpId, ceremony, stage, outcome, reasonCode, durationMs, principalKind, grantId,
    }).run();
  } catch (error) {
    guard(error);
  }
}

export async function passkeySecurityStatus(env, rpId) {
  try {
    const [deviceRows, eventRows] = await Promise.all([
      env.DB.prepare(
        `SELECT CASE WHEN document_grant_id IS NULL AND grant_id IS NULL THEN 'owner' ELSE 'grant' END principal_kind,
                count(*) count
         FROM owner_passkeys GROUP BY principal_kind`,
      ).all(),
      env.DB.prepare(
        `SELECT ceremony, stage, outcome, rp_id, count(*) count,
                min(duration_ms) min_duration_ms, avg(duration_ms) avg_duration_ms,
                max(duration_ms) max_duration_ms, max(occurred_at) last_at
         FROM passkey_security_events
         GROUP BY ceremony, stage, outcome, rp_id
         ORDER BY last_at DESC LIMIT 100`,
      ).all(),
    ]);
    const devices = { owner: 0, grant: 0 };
    for (const row of deviceRows?.results || []) devices[row.principal_kind] = Number(row.count || 0);
    const events = eventRows?.results || [];
    return {
      status: "ready",
      rp_id: rpId,
      proof: {
        configured: Boolean(env.SESSION_SIGNING_KEY),
        locally_verified: events.some((event) => event.outcome === "succeeded"),
        live_proven: false,
      },
      devices,
      ceremonies: events.map((event) => ({
        ceremony: event.ceremony,
        stage: event.stage,
        outcome: event.outcome,
        rp_id: event.rp_id,
        count: Number(event.count || 0),
        last_at: Number(event.last_at || 0),
        timing_ms: {
          min: event.min_duration_ms === null ? null : Number(event.min_duration_ms),
          average: event.avg_duration_ms === null ? null : Number(Number(event.avg_duration_ms).toFixed(1)),
          max: event.max_duration_ms === null ? null : Number(event.max_duration_ms),
        },
      })),
      privacy: "No credential ids, challenges, assertions, public keys, IP addresses, user agents, questions, answers, or document content are recorded here.",
    };
  } catch (error) {
    guard(error);
  }
}

/* --------------------------------------------------------------- zones */

export async function assignZone(env, { source, zone }) {
  try {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO zones (zone, label, created_at) VALUES (?, ?, ?) ON CONFLICT(zone) DO NOTHING",
    ).bind(zone, zone, now).run();
    await env.DB.prepare("UPDATE sources SET zone = ? WHERE name = ?").bind(zone, source).run();
    const docs = await env.DB.prepare("UPDATE documents SET zone = ? WHERE source = ?")
      .bind(zone, source).run();
    const chunks = await env.DB.prepare("UPDATE chunks SET zone = ? WHERE source = ?")
      .bind(zone, source).run();
    return {
      source,
      zone,
      documents: docs?.meta?.changes ?? 0,
      chunks: chunks?.meta?.changes ?? 0,
    };
  } catch (error) {
    guard(error);
  }
}

export async function listZones(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT COALESCE(c.zone, '(unzoned)') AS zone, COUNT(*) AS chunks,
              COUNT(DISTINCT c.source) AS sources
         FROM chunks c GROUP BY COALESCE(c.zone, '(unzoned)') ORDER BY chunks DESC`,
    ).all();
    return results || [];
  } catch (error) {
    guard(error);
  }
}

export async function sourcesInScope(env, scope) {
  if (!scope || scope.all === true) {
    try {
      const { results } = await env.DB.prepare("SELECT name FROM sources").all();
      return (results || []).map((row) => row.name);
    } catch (error) {
      guard(error);
    }
  }
  const include = Array.isArray(scope.zones) ? scope.zones.filter(Boolean) : [];
  if (!include.length) return [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.filter(Boolean) : [];
  try {
    const inList = include.map(() => "?").join(",");
    let sql = `SELECT name FROM sources WHERE zone IN (${inList})`;
    const binds = [...include];
    if (exclude.length) {
      sql += ` AND zone NOT IN (${exclude.map(() => "?").join(",")})`;
      binds.push(...exclude);
    }
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return (results || []).map((row) => row.name);
  } catch (error) {
    guard(error);
  }
}
