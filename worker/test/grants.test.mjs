import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITIES,
  ROUTE_CAPABILITY,
  capabilityForRoute,
  grantIsLive,
  hashToken,
  parseCapabilities,
  parseScope,
  principalMay,
  resolvePrincipal,
  scopeIsRestricted,
} from "../src/lib/grants.js";
import { sourcesInScope } from "../src/lib/auth-store.js";

const ENV = { ADMIN_KEY: "owner-key-value", RAG_PROXY_KEY: "proxy-key-value" };
const req = (key) => ({ headers: { get: (name) => (name === "X-Admin-Key" ? key : null) } });

test("the owner key keeps doing everything it does today", async () => {
  const p = await resolvePrincipal(req(ENV.ADMIN_KEY), ENV);
  assert.equal(p.kind, "owner");
  for (const capability of CAPABILITIES) assert.ok(p.capabilities.has(capability), capability);
});

test("the read-only proxy key answers questions and nothing else", async () => {
  const p = await resolvePrincipal(req(ENV.RAG_PROXY_KEY), ENV);
  assert.equal(p.kind, "proxy");
  assert.ok(principalMay(p, "/api/rag/think"));
  assert.ok(!principalMay(p, "/api/admin/brain/ingest"));
  assert.ok(!principalMay(p, "/api/admin/brain/purge"));
});

test("a header matching nothing resolves to no principal at all", async () => {
  assert.equal(await resolvePrincipal(req("not-a-real-key"), ENV), null);
  assert.equal(await resolvePrincipal(req(""), ENV), null);
  assert.equal(await resolvePrincipal(req(null), ENV), null);
});

/* The property this whole file exists to protect: absence is never authority. */
test("an unclassified route requires the owner, so a new route is never open by default", () => {
  assert.equal(capabilityForRoute("/api/admin/brain/invented-next-year"), "administer");
  assert.equal(capabilityForRoute("/"), "administer");
});

test("every classified route names a capability that actually exists", () => {
  for (const [path, capability] of Object.entries(ROUTE_CAPABILITY)) {
    assert.ok(CAPABILITIES.includes(capability), `${path} wants unknown capability ${capability}`);
  }
});

test("destroying the corpus is its own capability, separate from writing to it", () => {
  assert.equal(capabilityForRoute("/api/admin/brain/forget"), "destroy");
  assert.equal(capabilityForRoute("/api/admin/brain/ingest"), "file");
  // /purge does not exist. It was once classified as `destroy` in advance,
  // which would have handed a grantable unscoped delete to whoever added the
  // route later. It now falls through to owner-only like anything unlisted.
  assert.equal(capabilityForRoute("/api/admin/brain/purge"), "administer");
  // The bookkeeper case, stated as a test: file receipts, never purge.
  const bookkeeper = { kind: "grant", grantId: "g1", capabilities: new Set(["ask", "file"]) };
  assert.ok(principalMay(bookkeeper, "/api/admin/brain/ingest"));
  assert.ok(!principalMay(bookkeeper, "/api/admin/brain/forget"));
  assert.ok(!principalMay(bookkeeper, "/api/admin/brain/purge"));
});

test("a typo in a capability list widens nothing", () => {
  assert.deepEqual(parseCapabilities(["ask", "file"]), ["ask", "file"]);
  assert.deepEqual(parseCapabilities('["ask"]'), ["ask"]);
  assert.equal(parseCapabilities(["ask", "sudo"]), null);
  assert.equal(parseCapabilities(["Ask"]), null, "capabilities are case sensitive");
  assert.equal(parseCapabilities([]), null, "an empty grant is a mistake, not a grant");
  assert.equal(parseCapabilities("not json"), null);
  assert.equal(parseCapabilities(null), null);
});

test("all-zone scope preserves exclusions and malformed exclusions fail closed", () => {
  assert.deepEqual(parseScope({
    scope_include: '{"all":true}', scope_exclude: '["private"]',
  }), { all: true, exclude: ["private"] });
  for (const scope_exclude of ["not json", "{}", "null", "[1]", '[""]', '["Private"]']) {
    assert.deepEqual(parseScope({ scope_include: '{"all":true}', scope_exclude }), { zones: [] },
      `malformed exclusion ${scope_exclude} must not turn all-minus into all`);
  }
  for (const scope_include of ["null", "[]", '{}', '{"all":true,"zones":["books"]}',
    '{"zones":[1]}', '{"zones":["Private"]}']) {
    assert.deepEqual(parseScope({ scope_include, scope_exclude: "[]" }), { zones: [] },
      `malformed include ${scope_include} must read nothing`);
  }
  assert.deepEqual(parseScope({
    scope_include: '{"zones":["books","books"]}', scope_exclude: "[]",
  }), { zones: ["books"], exclude: [] });
  assert.equal(scopeIsRestricted({ all: true }), false);
  assert.equal(scopeIsRestricted({ all: true, exclude: ["private"] }), true);
  assert.equal(scopeIsRestricted({ zones: ["books"] }), true);
});

test("source enumeration applies exclusions to all-zone grants", async () => {
  const seen = [];
  const fakeEnv = {
    DB: {
      prepare(sql) {
        let binds = [];
        return {
          bind(...values) { binds = values; return this; },
          async all() {
            seen.push({ sql, binds });
            return { results: [{ name: "books" }] };
          },
        };
      },
    },
  };
  assert.deepEqual(await sourcesInScope(fakeEnv, { all: true, exclude: ["private"] }), ["books"]);
  assert.match(seen[0].sql, /WHERE zone IS NULL OR zone NOT IN \(\?\)/);
  assert.deepEqual(seen[0].binds, ["private"]);
});

test("a grant credential resolves only while the grant is live", async () => {
  const token = "grant-token-abc";
  const row = {
    grant_id: "g1",
    capabilities: '["ask","file"]',
    revoked_at: null,
    expires_at: null,
    credential_revoked_at: null,
  };
  const lookup = async (hash) => (hash === (await hashToken(token)) ? row : null);

  const p = await resolvePrincipal(req(token), ENV, { lookupCredential: lookup });
  assert.equal(p.kind, "grant");
  assert.equal(p.grantId, "g1");
  assert.ok(principalMay(p, "/api/rag/think"));
  assert.ok(!principalMay(p, "/api/admin/brain/purge"));

  const revoked = { ...row, revoked_at: 1 };
  assert.equal(await resolvePrincipal(req(token), ENV, { lookupCredential: async () => revoked }), null);

  const expired = { ...row, expires_at: 1000 };
  assert.equal(
    await resolvePrincipal(req(token), ENV, { lookupCredential: async () => expired }, 2000),
    null,
    "an expired grant is not a grant",
  );

  const credentialRevoked = { ...row, credential_revoked_at: 1 };
  assert.equal(
    await resolvePrincipal(req(token), ENV, { lookupCredential: async () => credentialRevoked }),
    null,
    "revoking one credential must not leave the grant usable through it",
  );

  const corrupt = { ...row, capabilities: '["ask","sudo"]' };
  assert.equal(
    await resolvePrincipal(req(token), ENV, { lookupCredential: async () => corrupt }),
    null,
    "an unreadable capability list fails closed rather than partially",
  );
});

test("expiry is a boundary, not a range", () => {
  assert.ok(grantIsLive({ expires_at: 2000 }, 1999));
  assert.ok(!grantIsLive({ expires_at: 2000 }, 2000), "expiry is inclusive: at the moment it expires, it is gone");
  assert.ok(!grantIsLive(null));
});

test("the token is never stored, only its hash", async () => {
  const hash = await hashToken("grant-token-abc");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, "grant-token-abc");
  assert.equal(hash, await hashToken("grant-token-abc"), "hashing is stable");
  assert.notEqual(hash, await hashToken("grant-token-abd"));
});

test("the route map names no route that does not exist", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  for (const path of Object.keys(ROUTE_CAPABILITY)) {
    assert.ok(source.includes(path),
      `${path} is classified but no route serves it. A capability pinned to a ` +
      `route that does not exist is inherited, unscoped, by whoever adds it later.`);
  }
});
