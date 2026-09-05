/**
 * The browser sign-in path, which exists so nobody has to mint or paste a token.
 *
 * Every assertion here is about a failure that would be silent in the field:
 * reading the wrong config, using an expired token mid-provision, or letting a
 * broken wrangler install become a hard error when it is one credential source
 * among several.
 */
import assert from "node:assert/strict";
import {
  findWranglerConfig,
  findWranglerSessionConfig,
  parseWranglerSession,
  readWranglerOAuthSession,
  readWranglerOAuthToken,
  refreshWranglerSession,
  wranglerConfigCandidates,
  WRANGLER_SESSION_AVAILABLE,
  WRANGLER_SESSION_ENCRYPTED_UNSUPPORTED,
  WRANGLER_SESSION_UNREADABLE,
} from "../operations/wrangler-oauth.mjs";

const HOUR = 3_600_000;
const cfg = (token, expiresAt) =>
  `oauth_token = "${token}"\nrefresh_token = "r"\nexpiration_time = "${new Date(expiresAt).toISOString()}"\n`;

// Windows keeps it somewhere else entirely, and getting this wrong means the
// browser path silently does nothing on the platform that needs it most.
const win = wranglerConfigCandidates({ APPDATA: "C:\\Users\\m\\AppData\\Roaming", USERPROFILE: "C:\\Users\\m" }, "win32");
assert.ok(win.some((p) => p.includes("xdg.config")), "the Windows XDG layout must be searched");
assert.ok(win.length >= 3, "Windows needs several candidate locations");
const posix = wranglerConfigCandidates({ HOME: "/Users/m" }, "darwin");
assert.ok(posix.some((p) => p === "/Users/m/.wrangler/config/default.toml"));
assert.ok(posix.some((p) => p.includes("/.config/")), "the XDG layout must be searched on POSIX too");

// The first existing candidate wins, in order.
assert.equal(
  findWranglerConfig({ env: { HOME: "/h" }, platform: "darwin", existsSync: (p) => p === "/h/.wrangler/config/default.toml" }),
  "/h/.wrangler/config/default.toml",
);
assert.equal(findWranglerConfig({ env: { HOME: "/h" }, platform: "darwin", existsSync: () => false }), null);

// New Wrangler stores its browser session in default.enc. Detect that layout
// without reading the encrypted bytes or reaching into an OS keyring.
let encryptedReads = 0;
const encryptedOnly = {
  env: { HOME: "/fixture-home" },
  platform: "darwin",
  existsSync: (path) => path.endsWith("default.enc"),
  readFileSync: () => { encryptedReads++; throw new Error("encrypted bytes must not be read"); },
};
const encryptedSession = readWranglerOAuthSession(encryptedOnly);
assert.equal(encryptedSession.type, WRANGLER_SESSION_ENCRYPTED_UNSUPPORTED);
assert.equal(encryptedSession.token, null);
assert.equal(encryptedReads, 0, "detecting default.enc must not read or decrypt it");
assert.equal(readWranglerOAuthToken(encryptedOnly), null, "the compatibility token reader still falls through quietly");
assert.equal(encryptedReads, 0, "the token wrapper must not read default.enc either");

// A readable supported session wins when both files exist in one config
// location. This lets a pinned re-login recover without deleting default.enc.
const both = {
  env: { HOME: "/fixture-home" },
  platform: "darwin",
  existsSync: (path) => /default\.(?:toml|enc)$/.test(path),
  readFileSync: () => cfg("supported-session", Date.now() + HOUR),
};
assert.equal(findWranglerSessionConfig(both).format, "toml");
assert.equal(readWranglerOAuthSession(both).type, WRANGLER_SESSION_AVAILABLE);
assert.equal(readWranglerOAuthToken(both), "supported-session");

// A present TOML file that cannot be opened is different from no session and
// different from the encrypted layout. The typed surface preserves that fact.
const unreadable = readWranglerOAuthSession({
  env: { HOME: "/fixture-home" },
  platform: "darwin",
  existsSync: (path) => path.endsWith("default.toml"),
  readFileSync: () => { throw new Error("fixture EACCES"); },
});
assert.equal(unreadable.type, WRANGLER_SESSION_UNREADABLE);
assert.equal(unreadable.reason, "read-failed");

// Parsing never throws on junk; a missing token is just "no session".
assert.equal(parseWranglerSession("").token, null);
assert.equal(parseWranglerSession("nonsense").token, null);
const parsed = parseWranglerSession(cfg("tok-abc", Date.now() + HOUR));
assert.equal(parsed.token, "tok-abc");
assert.ok(Number.isFinite(parsed.expiresAt));

const base = { env: { HOME: "/h" }, platform: "darwin", existsSync: () => true };
const now = Date.now();

// A comfortably valid token is used as-is, with no refresh: shelling out on
// every command would make a 20-step install noticeably slower.
let refreshed = 0;
assert.equal(
  readWranglerOAuthToken({ ...base, now, readFileSync: () => cfg("fresh", now + HOUR), refresh: () => { refreshed++; return true; } }),
  "fresh",
);
assert.equal(refreshed, 0, "a valid token must not trigger a refresh");

// Inside the margin it refreshes FIRST. A token that expires mid-provision is
// far worse than one refreshed a few minutes early.
let reads = 0;
const token = readWranglerOAuthToken({
  ...base, now,
  readFileSync: () => (++reads === 1 ? cfg("stale", now + 60_000) : cfg("renewed", now + HOUR)),
  refresh: () => true,
});
assert.equal(token, "renewed", "a nearly-expired token must be refreshed before use");

// Every "not available" case is null, never a throw: a missing or broken
// wrangler is an ordinary state when a token may be supplied another way.
assert.equal(readWranglerOAuthToken({ ...base, existsSync: () => false }), null);
assert.equal(readWranglerOAuthToken({ ...base, readFileSync: () => { throw new Error("EACCES"); } }), null);
assert.equal(readWranglerOAuthToken({ ...base, now, readFileSync: () => cfg("stale", now + 60_000), refresh: () => false }), null,
  "a failed refresh must not hand back the expired token");
assert.equal(readWranglerOAuthToken({ ...base, readFileSync: () => 'refresh_token = "r"\n' }), null);

// The refresh child must never inherit an API token: wrangler prefers it and
// would authenticate as the wrong identity, which is how an operator
// provisions into their own account instead of the client's.
let sawEnv = null;
refreshWranglerSession({
  env: { CLOUDFLARE_API_TOKEN: "operator-token", CLOUDFLARE_API_KEY: "k", HOME: "/h" },
  run: (_c, _a, opts) => { sawEnv = opts.env; return { status: 0 }; },
});
assert.equal(sawEnv.CLOUDFLARE_API_TOKEN, undefined, "the refresh child must not inherit CLOUDFLARE_API_TOKEN");
assert.equal(sawEnv.CLOUDFLARE_API_KEY, undefined, "nor a global API key");

console.log("wrangler browser sign-in: config discovery, expiry refresh, quiet absence, and identity isolation");

// The doctor check that stopped a working install at the preflight.
//
// /user/tokens/verify only recognises USER API tokens. A browser sign-in and an
// account-owned token both work for accounts, D1, Workers and Vectorize, and
// both are rejected there as "Invalid API Token". Calling that a failure is how
// a perfectly good credential became a red FAIL before anything was created.
{
  const { checkCfToken } = await import("../doctor.mjs");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => String(url).includes("/user/tokens/verify")
      ? { ok: false, status: 400, json: async () => ({ success: false, errors: [{ message: "Invalid API Token" }] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: "a" }, { id: "b" }] }) };
    const good = await checkCfToken("an-oauth-session-token");
    assert.equal(good.status, "ok", "a credential that can see accounts must not be called invalid");
    assert.match(good.detail, /2 account/);

    // A genuinely bad credential must still fail, or the check means nothing.
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ success: false, errors: [{ message: "Invalid API Token" }] }) });
    const bad = await checkCfToken("a-revoked-token");
    assert.equal(bad.status, "fail", "a credential that can see nothing must still fail");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("doctor: a browser or account-scoped credential passes, a dead one still fails");
