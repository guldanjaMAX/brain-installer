import assert from "node:assert/strict";
import { deriveRagProxyKey, RAG_PROXY_KEY_INFO } from "../operations/rag-proxy-key.mjs";
import { validateReadKey, validateAdminKey } from "../worker/src/lib/core.js";

const ADMIN = "6f1c2d3e4b5a69788796a5b4c3d2e1f00112233445566778";

/* ---------------- the derivation is pinned, not merely deterministic */

// A known-answer test, and the point of it is not that this number is special.
// If salt, info, length or algorithm ever change, every install's proxy key
// changes with them, silently, and every deployed UI proxy starts returning 401
// with nothing in any log saying why. This test makes that change loud.
assert.equal(
  deriveRagProxyKey(ADMIN),
  "89e386b9237f4fc0d2cc2581391823cc90d99098409a5b57",
  "the derived proxy key changed. Every deployed UI proxy just broke. If this was " +
    "deliberate, bump RAG_PROXY_KEY_INFO and say so in the changelog.",
);
assert.equal(RAG_PROXY_KEY_INFO, "brain-rag-proxy-key-v1");

assert.equal(deriveRagProxyKey(ADMIN), deriveRagProxyKey(ADMIN), "derivation is deterministic");
assert.notEqual(
  deriveRagProxyKey(ADMIN),
  deriveRagProxyKey(ADMIN.replace(/8$/, "9")),
  "a different admin key yields a different proxy key",
);

/* ---------------- the derived key is safe to put in a header */

const derived = deriveRagProxyKey(ADMIN);
assert.match(derived, /^[0-9a-f]{48}$/, "lowercase hex, so it is header-safe by construction");
assert.notEqual(derived, ADMIN, "the proxy key is never the admin key");
assert.equal(derived.includes(ADMIN), false, "the admin key does not appear inside the proxy key");

/* ---------------- input validation */

for (const bad of [undefined, null, "", 0, {}, Buffer.from("x")]) {
  assert.throws(
    () => deriveRagProxyKey(bad),
    /verified admin key string is required/,
    `refuses ${JSON.stringify(String(bad))} rather than deriving from nothing`,
  );
}

/* ---------------- what the worker actually does with it
   This is the property that matters. A read-only key that the worker rejects is
   useless, and one the worker accepts on an admin route is worse than useless. */

const env = { ADMIN_KEY: ADMIN, RAG_PROXY_KEY: derived };
const withKey = (key) => new Request("https://brain.invalid/api/rag/think", {
  method: "POST",
  headers: { "X-Admin-Key": key },
});

assert.equal(validateReadKey(withKey(derived), env), true, "the derived key opens the retrieval routes");
assert.equal(
  validateAdminKey(withKey(derived), env), false,
  "the derived key must NOT open ingest, forget, reindex, bootstrap or drain",
);
assert.equal(validateReadKey(withKey(ADMIN), env), true, "the admin key still reads");
assert.equal(validateAdminKey(withKey(ADMIN), env), true, "the admin key still administers");
assert.equal(validateReadKey(withKey("wrong"), env), false, "an unrelated key opens nothing");
assert.equal(validateReadKey(new Request("https://brain.invalid/"), env), false, "no header, no access");

/* ---------------- a brain with no proxy key configured is unchanged */

const legacy = { ADMIN_KEY: ADMIN };
assert.equal(validateReadKey(withKey(ADMIN), legacy), true, "installs predating this key still work");
assert.equal(
  validateReadKey(withKey(derived), legacy), false,
  "a derived key is worthless against a brain that was never given it",
);

console.log("rag proxy key: all focused offline tests passed");
