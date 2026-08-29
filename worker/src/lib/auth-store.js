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

/**
 * Which migration introduced each table this module reads.
 *
 * The hint used to be a single hardcoded sentence naming the passkey tables
 * and migration 0014, for every table in this file. Once grants and zones
 * moved in, a brain missing the GRANTS table was told to apply 0014, which is
 * already applied — sending whoever read it to look in the one place the
 * problem was not. The table name is in D1's own error, so the honest hint is
 * derivable rather than guessed.
 */
const TABLE_MIGRATION = Object.freeze({
  owner_passkeys: "0014", auth_challenges: "0014", enrollment_codes: "0014",
  recovery_codes: "0019", recovery_attempts: "0019",
  grants: "0023", grant_credentials: "0023",
  zones: "0024",
});

function guard(error) {
  const message = String(error?.message || error);
  if (/no such table/i.test(message)) {
    const table = message.match(/no such table:?\s*([A-Za-z0-9_]+)/i)?.[1];
    const migration = table && TABLE_MIGRATION[table];
    throw new Error(
      migration
        ? `the ${table} table is missing; run \`brain setup <manifest>\` to apply migration ${migration}`
        : "a table this brain needs is missing; run `brain setup <manifest>` to apply its migrations",
    );
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
      "SELECT expires_at, used_at, grant_id FROM enrollment_codes WHERE code_hash = ?",
    ).bind(hash).first();
    if (!row || row.used_at || Number(row.expires_at) <= Date.now()) return null;
    await env.DB.prepare(
      "UPDATE enrollment_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
    ).bind(Date.now(), hash).run();
    // Returns the row, not a boolean: the caller needs to know which grant this
    // invite was for, so the enrolled device belongs to that person and not to
    // the owner by default.
    return { grant_id: row.grant_id ?? null };
  } catch (error) {
    guard(error);
  }
}

/* ---------------------------------------------------------------- passkeys */

/**
 * Record an enrolled device, and WHOSE it is.
 *
 * grantId is required rather than optional, and callers must pass null
 * explicitly to mean "the owner". Enrollment can be authorized by an existing
 * session instead of an invite code, so a caller that simply forgot to say who
 * this device belongs to would otherwise mint an owner device for whoever was
 * signed in. Making the argument mandatory turns that mistake into a crash in
 * a test rather than a privilege escalation in the field.
 */
export async function storePasskey(env, { credentialId, jwk, alg, signCount, nickname, grantId }) {
  if (grantId === undefined) {
    throw new Error("storePasskey requires grantId; pass null to mean the owner");
  }
  try {
    await env.DB.prepare(
      "INSERT INTO owner_passkeys (credential_id, public_key_jwk, alg, sign_count, nickname, created_at, grant_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(credentialId, JSON.stringify(jwk), alg, signCount, nickname || null, Date.now(), grantId ?? null).run();
  } catch (error) {
    guard(error);
  }
}

/* ------------------------------------------------------------------ grants */

/**
 * The credential lookup behind a grant token.
 *
 * Returns the joined grant so the caller can decide in one place whether it is
 * live. credential_revoked_at is kept distinct from the grant's own
 * revoked_at: revoking one leaked token must not revoke the person, and
 * revoking the person must not depend on finding every token.
 */
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
  // Defaulting to every zone matches what a grant created before zones existed
  // already had, so this column can never silently narrow an existing person.
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

/** Revoking is a timestamp, never a delete: who had access in March stays answerable. */
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

export async function findPasskey(env, credentialId) {
  try {
    const row = await env.DB.prepare(
      "SELECT credential_id, public_key_jwk, alg, sign_count, nickname, grant_id FROM owner_passkeys WHERE credential_id = ?",
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

/**
 * Put a whole source into a zone, including everything already loaded from it.
 *
 * Retroactive on purpose. Every brain in the field has documents that predate
 * zones, and a scoped reader sees none of them because an unzoned row is
 * outside every scope. If zones could only be set at ingest, the feature would
 * be unusable for exactly the clients who already paid, and the fix would be a
 * re-ingest of their whole corpus.
 *
 * The zone is written to sources, documents and chunks in one pass, because
 * chunks is the row the text is read from and a join away is a join some
 * future query forgets to make.
 */
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

/** Every zone in use, with how much sits in each. */
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

/** One grant by id, for resolving a passkey session's subject. */
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

/** The source names a scope can reach. The one place that mapping is computed. */
export async function sourcesInScope(env, scope) {
  if (!scope || scope.all === true) {
    try {
      const { results } = await env.DB.prepare("SELECT name FROM sources").all();
      return (results || []).map((r) => r.name);
    } catch (error) { guard(error); }
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
    return (results || []).map((r) => r.name);
  } catch (error) { guard(error); }
}
