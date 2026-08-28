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

/* --------------------------------------------------------- recovery codes */

/**
 * The way back in when every enrolled device is gone (migration 0019).
 *
 * A recovery code is NOT a second sign-in. It authorises exactly one WebAuthn
 * registration, with user verification, on a device the person is holding —
 * so what they end up with is a passkey, checked by the same unskippable
 * checklist as any other. That is why this is not a weaker door: the thing it
 * REPLACES as the only escape hatch is the admin key, which can also ingest,
 * purge, reindex and drain.
 *
 * Excludes I, L, O, 0 and 1 so a code read off paper cannot be mistranscribed
 * into a different valid code. 20 characters over 31 symbols is ~99 bits.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_LENGTH = 20;
export const RECOVERY_CODE_COUNT = 5;
export const RECOVERY_FAIL_LIMIT = 10;
export const RECOVERY_FAIL_WINDOW_MS = 60 * 60 * 1000;

const RECOVERY_MIGRATION_HINT =
  "recovery-code tables are missing; run `brain setup <manifest>` to apply migration 0019";

function recoveryGuard(error) {
  if (/no such table|no such column/i.test(String(error?.message || error))) {
    throw new Error(RECOVERY_MIGRATION_HINT);
  }
  throw error;
}

/** One code, grouped for reading aloud and typing back in. */
export function generateRecoveryCode() {
  let out = "";
  // Rejection sampling: 256 is not a multiple of 31, so `byte % 31` alone
  // would make the first nine symbols measurably likelier than the rest.
  const ceiling = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length;
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte >= ceiling) continue;
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      if (out.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return out.match(/.{1,5}/g).join("-");
}

/**
 * Accept what a human actually types: lowercase, spaces, the printed dashes,
 * a stray tab from a password manager. Characters OUTSIDE the alphabet are
 * dropped rather than mapped onto a neighbour — a silent substitution could
 * turn one person's typo into another person's valid code.
 */
export function normalizeRecoveryCode(input) {
  return String(input || "").toUpperCase().split("")
    .filter((character) => RECOVERY_ALPHABET.includes(character)).join("");
}

const codeKey = (code) => sha256Hex(normalizeRecoveryCode(code));

/**
 * Mint a fresh set. Every UNUSED code is destroyed first, so the card in the
 * owner's safe is always exactly one set: printing new ones is also how you
 * revoke a set you think somebody photographed. Used rows are kept as history.
 */
export async function issueRecoveryCodes(env, count = RECOVERY_CODE_COUNT) {
  const codes = Array.from({ length: count }, generateRecoveryCode);
  try {
    await env.DB.prepare("DELETE FROM recovery_codes WHERE used_at IS NULL").run();
    const now = Date.now();
    for (const code of codes) {
      await env.DB.prepare(
        "INSERT INTO recovery_codes (code_hash, created_at) VALUES (?, ?)",
      ).bind(await codeKey(code), now).run();
    }
  } catch (error) {
    recoveryGuard(error);
  }
  return codes;
}

/**
 * How many are left, for the owner's screen. Never returns a code.
 *
 * This one does NOT throw on a missing table. It is read on every load of the
 * owner's page, and an install whose Worker is newer than its migrations must
 * still be able to sign in and ask questions — it just has no card yet, which
 * is exactly what `available: false` says. Every route that would ACT on a
 * recovery code checks `available` first and refuses loudly.
 */
export async function recoveryCodeStatus(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT count(*) AS total, sum(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS unused FROM recovery_codes",
    ).first();
    return { available: true, total: Number(row?.total || 0), unused: Number(row?.unused || 0) };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || error))) {
      return { available: false, total: 0, unused: 0 };
    }
    throw error;
  }
}

export const RECOVERY_UNAVAILABLE = RECOVERY_MIGRATION_HINT;

/** Valid and unused, WITHOUT spending it — a failed Face ID must not burn one. */
export async function peekRecoveryCode(env, code) {
  try {
    const row = await env.DB.prepare(
      "SELECT used_at FROM recovery_codes WHERE code_hash = ?",
    ).bind(await codeKey(code)).first();
    return Boolean(row && !row.used_at);
  } catch (error) {
    recoveryGuard(error);
  }
}

/**
 * Spend one, exactly once. The guard is in the UPDATE, not in a preceding
 * SELECT: two tabs racing the same code must produce one winner, and D1
 * reports the row count it actually changed. A runtime that does not report
 * one is refused rather than assumed successful — an unproven single-use
 * claim is worse than a failed recovery, because it is invisible.
 */
export async function consumeRecoveryCode(env, code, note) {
  try {
    const result = await env.DB.prepare(
      "UPDATE recovery_codes SET used_at = ?, used_note = ? WHERE code_hash = ? AND used_at IS NULL",
    ).bind(Date.now(), String(note || "").slice(0, 80) || null, await codeKey(code)).run();
    const changes = result?.meta?.changes;
    return typeof changes === "number" && changes === 1;
  } catch (error) {
    recoveryGuard(error);
  }
}

/* ------------------------------------------------- recovery-attempt brake */

/**
 * Entropy is what stops a guess; this brake is what makes a grind slow and
 * VISIBLE. Failures inside the window are counted in the owner's own database,
 * so it holds across Worker isolates rather than only within one.
 */
export async function recoveryThrottle(env, now = Date.now()) {
  try {
    const since = now - RECOVERY_FAIL_WINDOW_MS;
    const row = await env.DB.prepare(
      "SELECT count(*) AS n, COALESCE(min(attempted_at), 0) AS oldest FROM recovery_attempts WHERE attempted_at > ?",
    ).bind(since).first();
    const failures = Number(row?.n || 0);
    return {
      failures,
      locked: failures >= RECOVERY_FAIL_LIMIT,
      retry_after_ms: failures >= RECOVERY_FAIL_LIMIT
        ? Math.max(0, Number(row?.oldest || now) + RECOVERY_FAIL_WINDOW_MS - now)
        : 0,
    };
  } catch (error) {
    recoveryGuard(error);
  }
}

export async function recordRecoveryFailure(env, now = Date.now()) {
  try {
    await env.DB.prepare("INSERT INTO recovery_attempts (attempted_at) VALUES (?)").bind(now).run();
    // Bounded by construction: rows outside the window can never affect a
    // verdict, so they are swept rather than accumulated.
    await env.DB.prepare("DELETE FROM recovery_attempts WHERE attempted_at <= ?")
      .bind(now - RECOVERY_FAIL_WINDOW_MS).run();
  } catch (error) {
    recoveryGuard(error);
  }
}

/** Knowing a live code proves the owner is the owner; the brake resets. */
export async function clearRecoveryFailures(env) {
  try {
    await env.DB.prepare("DELETE FROM recovery_attempts").run();
  } catch (error) {
    recoveryGuard(error);
  }
}
