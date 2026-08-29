/**
 * sessions — the cookie a passkey sign-in earns.
 *
 * A session is a signed statement, not a database row: `v1.<expires>.<gen>.
 * <hmac>` under SESSION_SIGNING_KEY (derived from the admin key the same way
 * RAG_PROXY_KEY is, so every install gets one on its next `brain secrets`
 * run). The one piece of server state is the GENERATION number in D1:
 * bumping it is "sign out everywhere", instantly invalidating every cookie
 * ever minted without tracking any of them.
 *
 * A session carries exactly the read-only privilege class (the two retrieval
 * routes plus the owner's own device screen). It can never ingest, purge,
 * reindex, drain, or reach admin routes — a stolen cookie is a reading
 * credential with an expiry, nothing more.
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

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint the Set-Cookie header value for a fresh session.
 *
 * A v2 cookie names its subject. Until schema 15 every session was the owner,
 * so the cookie only had to prove "a passkey ceremony happened here" and
 * carried no identity at all. Once people other than the owner can sign in,
 * a cookie that does not say who it belongs to is indistinguishable from the
 * owner's, and every route that trusts a session trusts the wrong person.
 *
 * grantId null means the owner, and it has to be passed explicitly.
 */
export async function mintSessionCookie(env, generation, options = {}) {
  if (!env.SESSION_SIGNING_KEY) throw new Error("SESSION_SIGNING_KEY is not set; run `brain secrets`");
  // An options object rather than more positional arguments, because the third
  // parameter used to be `now`. A caller that still passes a timestamp there
  // would otherwise have it silently read as an identity, which is the exact
  // class of mistake this whole change exists to prevent.
  if (options === null || typeof options !== "object") {
    throw new Error("mintSessionCookie takes an options object: { grantId, now }");
  }
  const { grantId, now = Date.now() } = options;
  if (grantId === undefined) {
    throw new Error("mintSessionCookie requires a grant id; pass null to mean the owner");
  }
  const expires = now + SESSION_TTL_MS;
  const subject = grantId === null ? "-" : String(grantId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(subject)) throw new Error("invalid grant id for a session");
  const payload = `${expires}.${generation}.${subject}`;
  const signature = await hmac(env.SESSION_SIGNING_KEY, payload);
  const value = `v2.${payload}.${signature}`;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Read the session, returning WHO it is rather than merely whether it is valid.
 *
 * Returns null for no or invalid session, or { grantId } where null means the
 * owner. v1 cookies are still accepted and read as the owner: every v1 cookie
 * in existence was minted when the owner was the only person who could sign
 * in, so that is a statement of fact rather than a convenience. They age out
 * on their own within the session TTL.
 */
export async function readSessionCookie(request, env, currentGeneration, now = Date.now()) {
  if (!env.SESSION_SIGNING_KEY) return null;
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split(".");

  if (parts[0] === "v1") {
    if (parts.length !== 4) return null;
    const [, expires, generation, signature] = parts;
    if (!/^\d+$/.test(expires) || Number(expires) <= now) return null;
    if (String(generation) !== String(currentGeneration)) return null;
    const expected = await hmac(env.SESSION_SIGNING_KEY, `${expires}.${generation}`);
    return constantTimeEquals(signature, expected) ? { grantId: null } : null;
  }

  if (parts[0] === "v2") {
    if (parts.length !== 5) return null;
    const [, expires, generation, subject, signature] = parts;
    if (!/^\d+$/.test(expires) || Number(expires) <= now) return null;
    if (String(generation) !== String(currentGeneration)) return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(subject)) return null;
    const expected = await hmac(env.SESSION_SIGNING_KEY, `${expires}.${generation}.${subject}`);
    if (!constantTimeEquals(signature, expected)) return null;
    return { grantId: subject === "-" ? null : subject };
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
