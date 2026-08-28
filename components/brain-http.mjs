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

/* ------------------------------------------------------------------ */
/* refused before it reached the brain                                 */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare bot protection, recognised rather than reported as an outage.
 *
 * A rule in front of a brain decides per request and can turn away a client
 * that does not look like a browser BEFORE the worker sees it. Nothing about
 * that is visible in a status code alone: the operator gets a 403 and starts
 * rotating a key that was never read, or a 503 and starts looking for an
 * outage that never happened. It survives every fix they try, because the
 * thing they are fixing is not the thing that is broken.
 *
 * The signature is specific enough to name: a Cloudflare edge response, in
 * HTML rather than the brain's JSON, usually carrying an `error code: 10xx`.
 * The brain's own refusals are JSON and never match. When it does not match,
 * this returns null and the caller's existing message stands — a classifier
 * that guesses would move the operator to a different wrong path.
 */
const CLOUDFLARE_EDGE_MARKERS = [
  /error code:\s*1\d{3}/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /sorry, you have been blocked/i,
  /__cf_chl|cf-error-details|cf-wrapper|\/cdn-cgi\//i,
  /just a moment\.\.\./i,
];

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) ?? "");
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found ? String(found[1] ?? "") : "";
}

/** The `error code: NNNN` Cloudflare prints, when one is present. */
export function cloudflareErrorCode(body = "") {
  const match = String(body || "").match(/error code:\s*(1\d{3})/i);
  return match ? match[1] : null;
}

/**
 * Null when this is not the bot-protection signature. Otherwise a short
 * description plus the exact two-command proof, which needs no credential
 * because `/health` needs none.
 */
export function describeBotProtection({ status, headers, body, url } = {}) {
  const code = Number(status);
  // 403 is the common refusal; 429 and 503 are what a challenge or a rate rule
  // return. A 401 is never this: the edge does not ask for the brain's key.
  if (![403, 429, 503].includes(code)) return null;
  const text = String(body || "");
  const mitigated = headerValue(headers, "cf-mitigated");
  const contentType = headerValue(headers, "content-type").toLowerCase();
  const looksHtml = contentType.includes("text/html") || /^\s*<(!doctype|html)/i.test(text);
  const marked = CLOUDFLARE_EDGE_MARKERS.some((pattern) => pattern.test(text));
  if (!marked && !mitigated && !(looksHtml && headerValue(headers, "cf-ray"))) return null;

  let origin = "";
  try { origin = new URL(String(url)).origin; } catch { /* the proof lines fall back below */ }
  const address = origin || "https://<your brain's address>";
  const errorCode = cloudflareErrorCode(text);

  return {
    kind: "bot-protection",
    errorCode,
    message:
      "this was refused BEFORE it reached your brain." + "\n" +
      `      A rule in front of it returned Cloudflare's bot-protection response${errorCode ? ` (error code ${errorCode})` : ""}, which\n` +
      "      turns away clients that do not look like a browser. Your admin key was never read,\n" +
      "      so rotating it will not help and the brain itself may be perfectly healthy.\n" +
      "      Prove it in ten seconds. /health needs no key, so neither line carries a credential:\n" +
      `          curl -sS -i ${address}/health\n` +
      `          curl -sS -i -A "Mozilla/5.0" ${address}/health\n` +
      "      An HTML page from the first and JSON from the second is the confirmation.\n" +
      "      Fix it in the zone that holds this hostname: Security > Bots, and any WAF custom\n" +
      "      rule matching on user agent. Full entry: onboarding/06-runbook-top-ten-failures.md,\n" +
      "      \"1b. Every command is refused, but the same address opens fine in a browser\".\n" +
      "      A .workers.dev address sits in no zone of yours, so this is not the cause there.",
  };
}

/**
 * A connection reset can ALSO be a bot rule, and reads as a network blip.
 *
 * This does not claim to know which it is, because from here it is not
 * knowable. It adds the one sentence that stops an operator concluding
 * "transient" after the fifth identical reset.
 */
export const RESET_MAY_BE_BOT_PROTECTION =
  "If this repeats on every command while the same address opens fine in a browser, it may not be\n" +
  "      the network: a bot-protection rule can reset the connection before any response. See\n" +
  "      onboarding/06-runbook-top-ten-failures.md entry 1b for the two-line, no-credential proof.";
