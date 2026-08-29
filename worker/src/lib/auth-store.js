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

/** Single use: consuming a challenge deletes it, atomically by primary key. */
export async function consumeChallenge(env, challenge, purpose) {
  try {
    const hash = await sha256Hex(challenge);
    const row = await env.DB.prepare(
      "SELECT purpose, expires_at FROM auth_challenges WHERE challenge_hash = ?",
    ).bind(hash).first();
    await env.DB.prepare("DELETE FROM auth_challenges WHERE challenge_hash = ?").bind(hash).run();
    return Boolean(row && row.purpose === purpose && Number(row.expires_at) > Date.now());
  } catch (error) {
    guard(error);
  }
}

/* -------------------------------------------------------- enrollment codes */

export async function issueEnrollmentCode(env, options = {}) {
  const normalized = typeof options === "number" ? { ttlMs: options } : options || {};
  const ttlMs = normalized.ttlMs ?? 15 * 60 * 1000;
  const documentGrantId = normalized.documentGrantId ?? null;
  const code = normalized.code || randomToken(24);
  try {
    await env.DB.prepare(
      "INSERT INTO enrollment_codes (code_hash, expires_at, document_grant_id) VALUES (?, ?, ?)",
    ).bind(await sha256Hex(code), Date.now() + ttlMs, documentGrantId).run();
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
      "SELECT expires_at, used_at, document_grant_id FROM enrollment_codes WHERE code_hash = ?",
    ).bind(await sha256Hex(code)).first();
    return row && !row.used_at && Number(row.expires_at) > Date.now()
      ? { documentGrantId: row.document_grant_id ?? null }
      : null;
  } catch (error) {
    guard(error);
  }
}

export async function consumeEnrollmentCode(env, code) {
  try {
    const hash = await sha256Hex(code);
    const row = await env.DB.prepare(
      "SELECT expires_at, used_at, document_grant_id FROM enrollment_codes WHERE code_hash = ?",
    ).bind(hash).first();
    if (!row || row.used_at || Number(row.expires_at) <= Date.now()) return false;
    await env.DB.prepare(
      "UPDATE enrollment_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
    ).bind(Date.now(), hash).run();
    return { documentGrantId: row.document_grant_id ?? null };
  } catch (error) {
    guard(error);
  }
}

/* ---------------------------------------------------------------- passkeys */

export async function storePasskey(env, {
  credentialId, jwk, alg, signCount, nickname, documentGrantId = null, securityEvent = null,
}) {
  try {
    const insert = env.DB.prepare(
      "INSERT INTO owner_passkeys (credential_id, public_key_jwk, alg, sign_count, nickname, created_at, document_grant_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(credentialId, JSON.stringify(jwk), alg, signCount, nickname || null, Date.now(), documentGrantId);
    if (securityEvent) await env.DB.batch([insert, passkeyEventStatement(env, securityEvent)]);
    else await insert.run();
  } catch (error) {
    guard(error);
  }
}

export async function findPasskey(env, credentialId) {
  try {
    const row = await env.DB.prepare(
      "SELECT credential_id, public_key_jwk, alg, sign_count, nickname, document_grant_id FROM owner_passkeys WHERE credential_id = ?",
    ).bind(credentialId).first();
    if (!row) return null;
    return { ...row, jwk: JSON.parse(row.public_key_jwk) };
  } catch (error) {
    guard(error);
  }
}

export async function recordPasskeyUse(env, credentialId, signCount, securityEvent = null) {
  try {
    const update = env.DB.prepare(
      "UPDATE owner_passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
    ).bind(signCount, Date.now(), credentialId);
    if (securityEvent) await env.DB.batch([update, passkeyEventStatement(env, securityEvent)]);
    else await update.run();
  } catch (error) {
    guard(error);
  }
}

export async function listPasskeys(env) {
  try {
    const rows = await env.DB.prepare(
      "SELECT credential_id, alg, nickname, created_at, last_used_at FROM owner_passkeys ORDER BY created_at",
    ).all();
    return rows?.results || [];
  } catch (error) {
    guard(error);
  }
}

export async function renamePasskey(env, credentialId, nickname) {
  try {
    await env.DB.prepare(
      "UPDATE owner_passkeys SET nickname = ? WHERE credential_id = ?",
    ).bind(String(nickname || "").slice(0, 60), credentialId).run();
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
    const count = await env.DB.prepare("SELECT count(*) AS n FROM owner_passkeys").first();
    if (Number(count?.n || 0) <= 1) {
      return { removed: false, reason: "refusing to remove the last passkey; enroll another device or mint a new invite first" };
    }
    await env.DB.prepare("DELETE FROM owner_passkeys WHERE credential_id = ?").bind(credentialId).run();
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
    await env.DB.prepare(
      "UPDATE install_state SET session_generation = COALESCE(session_generation, 1) + 1",
    ).run();
    return sessionGeneration(env);
  } catch (error) {
    guard(error);
  }
}

/* --------------------------------------------------- privacy-safe telemetry */

function passkeyEventStatement(env, {
  rpId, ceremony, stage, outcome, reasonCode, durationMs = null,
  principalKind = "unknown", grantId = null,
}) {
  return env.DB.prepare(
    `INSERT INTO passkey_security_events
     (event_id, occurred_at, rp_id, ceremony, stage, outcome, reason_code, duration_ms,
      principal_kind, grant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `pse_${randomToken(18)}`, Date.now(), String(rpId || "unknown").slice(0, 253),
    ceremony, stage, outcome, String(reasonCode || "unspecified").slice(0, 80),
    durationMs === null ? null : Math.max(0, Math.round(Number(durationMs) || 0)),
    principalKind, grantId,
  );
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
        `SELECT CASE WHEN document_grant_id IS NULL THEN 'owner' ELSE 'grant' END principal_kind,
                count(*) count
         FROM owner_passkeys GROUP BY principal_kind`,
      ).all(),
      env.DB.prepare(
        `SELECT ceremony, stage, outcome, reason_code, rp_id, count(*) count,
                min(duration_ms) min_duration_ms, avg(duration_ms) avg_duration_ms,
                max(duration_ms) max_duration_ms, max(occurred_at) last_at
         FROM passkey_security_events
         GROUP BY ceremony, stage, outcome, reason_code, rp_id
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
        reason_code: event.reason_code,
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
