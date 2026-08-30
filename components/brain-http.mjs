/**
 * Fail-closed transport for requests carrying a Brain admin key.
 *
 * The admin key is a custom HTTP header. Node's fetch removes `Authorization`
 * on a cross-origin redirect, but it preserves custom headers. A normal
 * redirect-following request can therefore forward `X-Admin-Key` to an origin
 * that was never reviewed. Every shipped data-plane client uses this module so
 * URL validation finishes before a credential resolver runs, redirects are
 * refused, and a response cannot silently claim a different origin.
 */

import { isIP } from "node:net";

export const BRAIN_ADMIN_HEADER = "X-Admin-Key";

function isLoopbackHost(hostname) {
  const bare = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  return isIP(bare) === 4 && bare.split(".")[0] === "127";
}

/** Parse a Brain URL and require HTTPS, except for an explicit loopback test. */
export function secureBrainRequestUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    throw new Error("the Brain request URL is invalid");
  }
  if (url.username || url.password) {
    throw new Error("the Brain request URL must not contain credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("authenticated Brain requests require HTTPS; HTTP is allowed only for loopback tests");
  }
  return url;
}

/**
 * Refuse evidence from another origin even when an injected transport ignores
 * `redirect: error`. Native fetch responses always carry a URL; the empty URL
 * is accepted only so minimal offline test doubles can model a direct response.
 */
export function assertExactBrainResponseOrigin(response, requestedUrl) {
  if (response?.redirected === true) {
    throw new Error("the authenticated Brain request was redirected");
  }
  const responseUrl = String(response?.url || "");
  if (!responseUrl) return response;
  let observed;
  try {
    observed = new URL(responseUrl);
  } catch {
    throw new Error("the authenticated Brain response URL is invalid");
  }
  if (observed.origin !== requestedUrl.origin) {
    throw new Error("the authenticated Brain response came from a different origin");
  }
  return response;
}

async function fetchValidated(fetchImpl, requestedUrl, init) {
  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");
  const response = await fetchImpl(requestedUrl.href, { ...init, redirect: "error" });
  return assertExactBrainResponseOrigin(response, requestedUrl);
}

/**
 * Resolve and attach one admin key only after the destination is safe.
 * `credential` is intentionally a callback so insecure URLs fail before a
 * Keychain, DPAPI, or protected-file read is reachable.
 */
export async function fetchBrainWithAdminKey(fetchImpl, value, init = {}, credential) {
  const requestedUrl = secureBrainRequestUrl(value);
  const headers = new Headers(init.headers || {});
  if (headers.has(BRAIN_ADMIN_HEADER)) {
    throw new Error("the Brain admin key must be supplied through the credential resolver");
  }
  const key = typeof credential === "function" ? credential() : credential;
  if (typeof key !== "string" || !key) throw new Error("the Brain admin key is missing");
  headers.set(BRAIN_ADMIN_HEADER, key);
  return fetchValidated(fetchImpl, requestedUrl, { ...init, headers });
}

/**
 * Protect legacy call sites whose options already contain `X-Admin-Key`.
 * Unauthenticated and provider-control-plane requests keep their existing
 * redirect behavior; every Brain admin request receives the strict contract.
 */
export async function guardBrainAdminFetch(fetchImpl, value, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has(BRAIN_ADMIN_HEADER)) return fetchImpl(value, init);
  const requestedUrl = secureBrainRequestUrl(value);
  return fetchValidated(fetchImpl, requestedUrl, { ...init, headers });
}
