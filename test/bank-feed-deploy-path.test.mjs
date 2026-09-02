/**
 * The bank feed's configuration must reach the WORKER, not just the manifest.
 *
 * doctor.mjs validated corpora.bank_feed while the deploy emitted none of it,
 * so a manifest that passed every check produced a worker reporting the feed
 * unconfigured. This test asserts against the built bindings for that reason:
 * a check that inspects the manifest instead of the artifact is what let the
 * gap exist.
 */
import assert from "node:assert/strict";
import { workerBindings, bankFeedWorkerVars } from "../brain.mjs";

const cfg = { d1_database_id: "db-1", storage: "d1", vectorize_index: "x-brain" };
const base = { client: { slug: "x", display_name: "X" }, infrastructure: { cloudflare: cfg } };
const nameOf = (bindings) => new Set(bindings.map((b) => b.name));
const valueOf = (bindings, name) => bindings.find((b) => b.name === name)?.text;

// A brain that does not use the feed carries no bank configuration at all.
const off = workerBindings({ ...base, corpora: { google_drive: { enabled: true } } }, cfg);
for (const n of [...nameOf(off)]) {
  assert.ok(!n.startsWith("BANK_FEED_"), `a disabled feed must emit no ${n}`);
}
assert.deepEqual(bankFeedWorkerVars({ corpora: {} }), []);

// An enabled feed puts every configured field on the worker.
const on = workerBindings({
  ...base,
  corpora: {
    bank_feed: {
      enabled: true,
      api_base: "https://sandbox.plaid.com",
      environment: "sandbox",
      link_sdk_url: "https://cdn.plaid.com/link/v2/stable/link-initialize.js",
      link_global: "Plaid",
      entity_slug: "store-01",
    },
  },
}, cfg);

// BANK_FEED_API_BASE is the one bankFeedConfig() cannot start without.
assert.equal(valueOf(on, "BANK_FEED_API_BASE"), "https://sandbox.plaid.com",
  "the worker cannot configure the feed without its API base");
assert.equal(valueOf(on, "BANK_FEED_ENV"), "sandbox");
assert.equal(valueOf(on, "BANK_FEED_LINK_SDK_URL"), "https://cdn.plaid.com/link/v2/stable/link-initialize.js");
assert.equal(valueOf(on, "BANK_FEED_LINK_GLOBAL"), "Plaid");
assert.equal(valueOf(on, "BANK_FEED_ENTITY"), "store-01");

// The environment is stated, never inferred, and never silently production.
const implicit = workerBindings({ ...base, corpora: { bank_feed: { enabled: true, api_base: "https://sandbox.plaid.com" } } }, cfg);
assert.equal(valueOf(implicit, "BANK_FEED_ENV"), "sandbox",
  "an unstated environment must default to sandbox, never production");
const prod = workerBindings({ ...base, corpora: { bank_feed: { enabled: true, api_base: "https://production.plaid.com", environment: "production" } } }, cfg);
assert.equal(valueOf(prod, "BANK_FEED_ENV"), "production");

// The rest of the worker is untouched by any of this.
for (const required of ["DB", "AI", "STORAGE", "BRAIN_NAME", "BRAIN_VERSION", "CHUNK_SIZE", "CREDENTIAL_SCANNER"]) {
  assert.ok(nameOf(on).has(required), `${required} must still be deployed`);
}

console.log("bank feed deploy path: the configured feed reaches the worker, a disabled one emits nothing");
