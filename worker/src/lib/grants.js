/**
 * Who is asking, and what are they allowed to do.
 *
 * Until schema 15 this question had one answer: whoever held ADMIN_KEY could
 * do everything, and everyone else was rejected. That is fine for one person
 * and wrong for a household with a bookkeeper, which is the product.
 *
 * Two rules shape everything here.
 *
 * Fail closed by omission. A route that nobody has classified requires
 * `administer`, so a route added next year is owner-only until somebody
 * decides otherwise. The dangerous default is the permissive one, and it is
 * the one you get for free if you are not deliberate.
 *
 * A missing grant is never the owner. The owner is identified positively, by
 * holding ADMIN_KEY or by a passkey enrolled before grants existed. Anything
 * that merely fails to name a grant resolves to nothing, because the opposite
 * reading turns every gap in the code into a privilege escalation.
 */

import { constantTimeEquals } from "./core.js";

/**
 * The whole vocabulary. Deliberately five, deliberately coarse.
 *
 * A finer set is tempting and is how permission systems become unusable: the
 * owner is a person deciding what their bookkeeper may do, on a video call,
 * once. These five are things that person can hold in their head.
 */
export const CAPABILITIES = Object.freeze([
  "ask",        // read: ask questions, get cited answers
  "file",       // add documents to the corpus
  "diagnose",   // see health, counts, freshness, what is stale
  "administer", // secrets, grants, upgrades, connectors
  "destroy",    // forget a source, purge, delete the corpus
]);

const CAPABILITY_SET = new Set(CAPABILITIES);
const ZONE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Zone ids are shared by the owner API and stored grant parser. */
export function validZoneId(value) {
  return typeof value === "string" && ZONE_ID.test(value);
}

/** The owner, and anyone holding the full admin key, can do all five. */
export const OWNER_CAPABILITIES = Object.freeze([...CAPABILITIES]);

/**
 * What each route requires.
 *
 * Absence is not permission. `capabilityForRoute` returns "administer" for
 * anything not listed, so forgetting to add a route here fails safe: the
 * owner keeps working, everyone else is refused, and the omission shows up as
 * a support question rather than as a leak.
 */
export const ROUTE_CAPABILITY = Object.freeze({
  "/api/rag/unified": "ask",
  "/api/rag/think": "ask",
  "/api/admin/brain/ingest": "file",
  "/api/admin/brain/ingest/batch": "file",
  "/api/admin/brain/freshness": "diagnose",
  "/api/admin/brain/diagnose": "diagnose",
  // Drain is deliberately NOT grantable, despite reading like a filing step.
  //
  // It walks the whole outbox: every queued chunk's text, in every zone, and
  // hands it to the embedding provider. No text returns to the caller, so it
  // is not a read in the ordinary sense, but a person scoped to one zone
  // should not be able to push another zone's documents to a third party on
  // demand. It also holds a single global lease, so a scoped caller could
  // stall embedding for the whole brain.
  //
  // The cron drains on its own, so nobody is blocked by this. It falls through
  // to the owner-only default.
  "/api/admin/brain/reindex": "administer",
  "/api/admin/brain/forget": "destroy",
  // Entries for routes that do not exist were removed rather than left as
  // documentation. "/api/admin/brain/purge" was pre-classified as `destroy`,
  // so whoever added that route would have inherited a grantable, unscoped
  // delete on the day they added it, without ever deciding to. Falling through
  // to the owner-only default is the safer way to be wrong.
});

/** The capability a path requires. Unlisted means owner-only, on purpose. */
export function capabilityForRoute(path) {
  return Object.prototype.hasOwnProperty.call(ROUTE_CAPABILITY, path)
    ? ROUTE_CAPABILITY[path]
    : "administer";
}

/** Reject anything that is not a known capability, so a typo cannot widen a grant. */
export function parseCapabilities(value) {
  let list = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !CAPABILITY_SET.has(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** sha256 hex, the same shape enrollment codes are stored in. */
export async function hashToken(token) {
  const bytes = new TextEncoder().encode(String(token));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Turn the stored scope columns into the shape scopeSql expects.
 *
 * Anything unreadable becomes the empty scope, which reads NOTHING. A corrupt
 * scope must never widen to everything, and "no zones" is the safe reading of
 * "we do not know what this person may see".
 */
export function parseScope(row) {
  let include;
  try {
    include = typeof row?.scope_include === "string" ? JSON.parse(row.scope_include) : row?.scope_include;
  } catch { return { zones: [] }; }
  let rawExclude;
  try {
    rawExclude = typeof row?.scope_exclude === "string" ? JSON.parse(row.scope_exclude) : row?.scope_exclude;
  } catch { return { zones: [] }; }
  if (!Array.isArray(rawExclude) || !rawExclude.every(validZoneId)) return { zones: [] };
  const exclude = [...new Set(rawExclude)];
  if (!include || typeof include !== "object" || Array.isArray(include)) return { zones: [] };
  const keys = Object.keys(include);
  // Exclusions win even when the include side says "all". Returning early for
  // all-zones grants would silently turn "everything except private" into
  // unrestricted access, and a malformed exclusion must fail closed too.
  if (include.all === true && keys.length === 1 && keys[0] === "all") {
    return { all: true, exclude };
  }
  if (keys.length !== 1 || keys[0] !== "zones" || !Array.isArray(include.zones) ||
      !include.zones.every(validZoneId)) return { zones: [] };
  const zones = [...new Set(include.zones)];
  return { zones, exclude };
}

/** True when a grant omits at least one zone and therefore needs filtering. */
export function scopeIsRestricted(scope) {
  if (!scope) return false;
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.filter(Boolean) : [];
  return scope.all !== true || exclude.length > 0;
}

/** A grant row is usable only while it is neither revoked nor expired. */
export function grantIsLive(row, now = Date.now()) {
  if (!row) return false;
  if (row.revoked_at) return false;
  if (row.expires_at && Number(row.expires_at) <= now) return false;
  return true;
}

/**
 * Resolve the caller to a principal, or null.
 *
 * Order matters and is deliberate: the two env-held keys are checked first and
 * with a constant-time compare, so the common path never touches the database
 * and never leaks timing about which key was wrong. Only a header that matches
 * neither is hashed and looked up as a grant credential.
 */
export async function resolvePrincipal(request, env, { lookupCredential } = {}, now = Date.now()) {
  const presented = request.headers.get("X-Admin-Key");

  if (presented && env.ADMIN_KEY && constantTimeEquals(presented, env.ADMIN_KEY)) {
    return { kind: "owner", grantId: null, capabilities: new Set(OWNER_CAPABILITIES), scope: { all: true } };
  }
  if (presented && env.RAG_PROXY_KEY && constantTimeEquals(presented, env.RAG_PROXY_KEY)) {
    // Unchanged from the shipped contract: the proxy key answers questions and
    // does nothing else.
    return { kind: "proxy", grantId: null, capabilities: new Set(["ask"]), scope: { all: true } };
  }
  if (presented && typeof lookupCredential === "function") {
    const row = await lookupCredential(await hashToken(presented));
    if (grantIsLive(row, now) && !row.credential_revoked_at) {
      const capabilities = parseCapabilities(row.capabilities);
      if (capabilities) {
        return {
          kind: "grant",
          grantId: row.grant_id,
          capabilities: new Set(capabilities),
          scope: parseScope(row),
        };
      }
    }
  }
  return null;
}

/** Does this principal hold what the route needs? */
export function principalMay(principal, path) {
  if (!principal) return false;
  return principal.capabilities.has(capabilityForRoute(path));
}
