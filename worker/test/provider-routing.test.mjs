import assert from "node:assert/strict";
import { callLLM } from "../src/lib/core.js";

/* Issue #19. The provider must follow the CONFIGURED MODEL, never whichever key
   happens to exist. Before this, an install with an Anthropic key for reranking
   sent every answer to Anthropic while its manifest still said Cloudflare, so
   client document text reached a provider the manifest did not name. That is a
   custody claim, which is why it gets a test rather than a comment. */

const CF = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const call = (env, model) => callLLM(env, { model, system: "s", messages: [], label: "test" });

// D1 reserves before the provider call; this stub returns a durable reservation
// receipt and a successful settlement while keeping provider routing offline.
const db = () => {
  let id = 0;
  return {
    exec: async () => {},
    prepare: (sql) => ({
      bind: () => ({
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => /RETURNING id/.test(sql) ? ({ id: ++id }) : ({}),
      }),
    }),
  };
};

let aiCalls, fetchCalls;
const aiBinding = () => ({ run: async (m) => { aiCalls.push(m); return { response: "ok", usage: {} }; } });
const origFetch = globalThis.fetch;

function reset() { aiCalls = []; fetchCalls = []; }
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), body: JSON.parse(opts?.body || "{}") });
  return { ok: true, status: 200, json: async () => ({ content: [], usage: {} }), text: async () => "" };
};

try {
  /* THE BUG: Cloudflare model + an Anthropic key present. Must stay on Cloudflare. */
  reset();
  await call({ DB: db(), AI: aiBinding(), ANTHROPIC_API_KEY: "k" }, CF);
  assert.equal(aiCalls.length, 1, "a @cf/ model must be served by Workers AI");
  assert.equal(aiCalls[0], CF, "the configured model is used, not a substitute");
  assert.equal(fetchCalls.length, 0,
    "a @cf/ model must NEVER reach Anthropic just because a key exists");

  /* An explicitly Anthropic model with a key still goes to Anthropic. */
  reset();
  await call({ DB: db(), AI: aiBinding(), ANTHROPIC_API_KEY: "k" }, "claude-sonnet-4-5");
  assert.equal(fetchCalls.length, 1, "a non-@cf model routes to Anthropic");
  assert.match(fetchCalls[0].url, /api\.anthropic\.com/);
  assert.equal(fetchCalls[0].body.model, "claude-sonnet-4-5", "the configured model is passed through");
  assert.equal(aiCalls.length, 0);

  /* No key at all: unchanged behaviour, Workers AI. */
  reset();
  await call({ DB: db(), AI: aiBinding() }, CF);
  assert.equal(aiCalls.length, 1, "no key still uses Workers AI");
  assert.equal(fetchCalls.length, 0);

  /* Cloudflare model configured but no AI binding: refuse, do not silently swap provider. */
  reset();
  await assert.rejects(
    () => call({ DB: db(), ANTHROPIC_API_KEY: "k" }, CF),
    (e) => e.provider_mismatch === true && /Refusing to answer from a different provider/.test(e.message),
    "with no AI binding it must refuse rather than quietly answer from Anthropic",
  );
  assert.equal(fetchCalls.length, 0, "the refusal must not have called Anthropic first");

  console.log("provider routing: all focused offline tests passed");
} finally {
  globalThis.fetch = origFetch;
}
