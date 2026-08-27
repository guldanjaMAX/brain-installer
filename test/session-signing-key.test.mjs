import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSessionSigningKey } from "../operations/session-signing-key.mjs";
import { deriveRagProxyKey } from "../operations/rag-proxy-key.mjs";

test("the session signing key is deterministic, distinct, and never the admin key", () => {
  const adminKey = "fixture-admin-key-0123456789abcdef";
  const first = deriveSessionSigningKey(adminKey);
  assert.equal(first, deriveSessionSigningKey(adminKey), "same admin key, same signing key");
  assert.match(first, /^[0-9a-f]{64}$/, "64 hex chars: header- and HMAC-safe by construction");
  assert.notEqual(first, deriveRagProxyKey(adminKey), "each derived credential has its own HKDF info");
  assert.ok(!first.includes(adminKey), "one-way: the signing key never embeds its source");
  assert.notEqual(first, deriveSessionSigningKey(adminKey + "x"), "rotating ADMIN_KEY rotates it");
  assert.throws(() => deriveSessionSigningKey(""), TypeError);
});

console.log("session signing key: all focused tests passed");
