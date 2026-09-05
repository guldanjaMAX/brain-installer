/**
 * sessions — the cookie a passkey sign-in earns.
 *
 * A session is a signed statement, not a database row. Version 3 binds the
 * cookie to the exact passkey that earned it through an HMAC reference, never
 * the credential id itself. The one shared piece of server state is the
 * GENERATION number in D1: bumping it is "sign out everywhere". Looking up the
 * passkey reference on every use makes deleting one passkey invalidate only
 * that passkey's cookies immediately.
 *
 * An owner session authenticates retrieval, the owner app and device controls,
 * financial views, and guarded owner writes such as document upload. It never
 * bypasses /api/admin routes, and destructive corpus execution also requires a
 * dedicated fresh-passkey ceremony. Treat the cookie as a write-capable owner
 * credential until it expires or its passkey or session is revoked.
 */

const te = new TextEncoder();
export const SESSION_COOKIE = "brain_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64u(bytes) {
  let ascii = "";
  for (const byte of bytes) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(message))));
}

/** A private, stable cookie reference that does not disclose a credential id. */
export async function credentialSessionRef(env, credentialId) {
  if (!env.SESSION_SIGNING_KEY) throw new Error("SESSION_SIGNING_KEY is not set; run `brain secrets`");
  const id = String(credentialId || "");
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(id)) throw new Error("invalid credential id for a session");
  return hmac(env.SESSION_SIGNING_KEY, `passkey:${id}`);
}

export async function credentialMatchesSessionRef(env, credentialId, reference) {
  if (typeof reference !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(reference)) return false;
  return constantTimeEquals(reference, await credentialSessionRef(env, credentialId));
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint the Set-Cookie header value for a fresh session.
 *
 * v3 names the exact grant class and carries an HMAC reference to the passkey.
 * grantId=null is the owner. Older cookie versions are deliberately rejected
 * on read because they cannot be invalidated when one passkey is revoked.
 */
export async function mintSessionCookie(env, generation, options = {}) {
  if (!env.SESSION_SIGNING_KEY) throw new Error("SESSION_SIGNING_KEY is not set; run `brain secrets`");
  const normalized = typeof options === "number" ? { grantId: null, now: options } : options || {};
  const grantId = normalized.grantId ?? null;
  const credentialRef = await credentialSessionRef(env, normalized.credentialId);
  const now = normalized.now ?? Date.now();
  const subject = grantId === null ? "-" : String(grantId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(subject)) throw new Error("invalid grant id for a session");
  const expires = now + SESSION_TTL_MS;
  const payload = `${expires}.${generation}.${subject}.${credentialRef}`;
  const signature = await hmac(env.SESSION_SIGNING_KEY, payload);
  const value = `v3.${payload}.${signature}`;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Read the principal carried by a valid session.
 *
 * v1 and v2 cannot identify the passkey that earned them. Accepting either
 * would let a revoked passkey keep an already-minted session, so an upgrade
 * intentionally signs those sessions out instead of guessing their identity.
 */
export async function readSessionCookie(request, env, currentGeneration, now = Date.now()) {
  if (!env.SESSION_SIGNING_KEY) return null;
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts[0] === "v3") {
    if (parts.length !== 6) return null;
    const [, expires, generation, subject, credentialRef, signature] = parts;
    if (!/^\d+$/.test(expires) || Number(expires) <= now) return null;
    if (String(generation) !== String(currentGeneration)) return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(subject)) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(credentialRef)) return null;
    const expected = await hmac(env.SESSION_SIGNING_KEY, `${expires}.${generation}.${subject}.${credentialRef}`);
    if (!constantTimeEquals(signature, expected)) return null;
    return { grantId: subject === "-" ? null : subject, credentialRef };
  }

  return null;
}

/** True when the request carries a valid, unexpired, current-generation session. */
export async function validateSessionCookie(request, env, currentGeneration, now = Date.now()) {
  return (await readSessionCookie(request, env, currentGeneration, now)) !== null;
}

/** The clearing cookie for sign-out. */
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
