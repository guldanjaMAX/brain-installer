import { test } from "node:test";
import assert from "node:assert/strict";

import { BrainClient } from "./brain-client.mjs";

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("documents reads the authenticated inventory endpoint", async () => {
  const calls = [];
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return response({ rows: [{ documents: 3, chunks: 12, embedded: 10 }] });
    },
  });

  const inventory = await client.documents();
  assert.equal(inventory.rows[0].chunks, 12);
  assert.match(calls[0].url, /\/api\/admin\/brain\/documents/);
  assert.equal(calls[0].headers["X-Admin-Key"], "fixture-key");
});

test("health preserves the deployed Worker identity for eval provenance", async () => {
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    fetchImpl: async () => response({ ok: true, brain: "fixture-brain", version: "0.1.10" }),
  });

  assert.deepEqual(await client.health(), {
    status: 200,
    ok: true,
    version: "0.1.10",
    brain: "fixture-brain",
  });
});

test("private questions use JSON POST bodies and never enter URLs", async () => {
  const calls = [];
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      return response(String(url).endsWith("/api/rag/unified")
        ? { results: [{ source: "curated", ref_key: "fixture" }] }
        : { answer: "Fixture answer." });
    },
  });

  await client.retrieve("private medical question", { limit: 10 });
  await client.think("private legal question", { limit: 8 });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).search, "");
    assert.equal(call.headers["Content-Type"], "application/json");
  }
  assert.equal(JSON.parse(calls[0].body).q, "private medical question");
  assert.equal(JSON.parse(calls[1].body).q, "private legal question");
});

test("non-retryable 401 and 404 responses are attempted once", async () => {
  for (const status of [401, 404]) {
    let calls = 0;
    const client = new BrainClient({
      base: "https://brain.example",
      adminKey: "fixture-key",
      retries: 4,
      fetchImpl: async () => {
        calls++;
        return response({ error: "fixture" }, status);
      },
    });
    await assert.rejects(() => client.documents(), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1, `HTTP ${status}`);
  }
});
