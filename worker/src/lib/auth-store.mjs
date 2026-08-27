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

async function sha256Hex(value) {
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

export async function issueEnrollmentCode(env, ttlMs = 15 * 60 * 1000) {
  const code = randomToken(24);
  try {
    await env.DB.prepare(
      "INSERT INTO enrollment_codes (code_hash, expires_at) VALUES (?, ?)",
    ).bind(await sha256Hex(code), Date.now() + ttlMs).run();
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
      "SELECT expires_at, used_at FROM enrollment_codes WHERE code_hash = ?",
    ).bind(await sha256Hex(code)).first();
    return Boolean(row && !row.used_at && Number(row.expires_at) > Date.now());
  } catch (error) {
    guard(error);
  }
}

export async function consumeEnrollmentCode(env, code) {
  try {
    const hash = await sha256Hex(code);
    const row = await env.DB.prepare(
      "SELECT expires_at, used_at FROM enrollment_codes WHERE code_hash = ?",
    ).bind(hash).first();
    if (!row || row.used_at || Number(row.expires_at) <= Date.now()) return false;
    await env.DB.prepare(
      "UPDATE enrollment_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
    ).bind(Date.now(), hash).run();
    return true;
  } catch (error) {
    guard(error);
  }
}

/* ---------------------------------------------------------------- passkeys */

export async function storePasskey(env, { credentialId, jwk, alg, signCount, nickname }) {
  try {
    await env.DB.prepare(
      "INSERT INTO owner_passkeys (credential_id, public_key_jwk, alg, sign_count, nickname, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(credentialId, JSON.stringify(jwk), alg, signCount, nickname || null, Date.now()).run();
  } catch (error) {
    guard(error);
  }
}

export async function findPasskey(env, credentialId) {
  try {
    const row = await env.DB.prepare(
      "SELECT credential_id, public_key_jwk, alg, sign_count, nickname FROM owner_passkeys WHERE credential_id = ?",
    ).bind(credentialId).first();
    if (!row) return null;
    return { ...row, jwk: JSON.parse(row.public_key_jwk) };
  } catch (error) {
    guard(error);
  }
}

export async function recordPasskeyUse(env, credentialId, signCount) {
  try {
    await env.DB.prepare(
      "UPDATE owner_passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
    ).bind(signCount, Date.now(), credentialId).run();
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
