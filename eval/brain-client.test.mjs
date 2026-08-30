import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { BrainClient } from "./brain-client.mjs";

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
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
    assert.equal(call.redirect, "error");
    assert.equal(new URL(call.url).search, "");
    assert.equal(call.headers["Content-Type"], "application/json");
  }
  assert.equal(JSON.parse(calls[0].body).q, "private medical question");
  assert.equal(JSON.parse(calls[1].body).q, "private legal question");
});

test("requested reranking carries an explicit actuation receipt", async () => {
  const replies = [
    { results: [{ ref_key: "a" }, { ref_key: "b" }], reranked: true, rerank_status: "applied", rerank_candidate_count: 30 },
    { results: [{ ref_key: "a" }, { ref_key: "b" }], reranked: false, rerank_status: "fallback", rerank_candidate_count: 30 },
    // A legacy Worker that only says false is not proof that the requested
    // variant ran. The evaluator must call that unobserved, not disabled.
    { results: [{ ref_key: "a" }, { ref_key: "b" }], reranked: false },
    // The old route also said true before calling a reranker that could silently
    // fall back. Without the explicit status, true is not an actuation receipt.
    { results: [{ ref_key: "a" }, { ref_key: "b" }], reranked: true },
  ];
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    fetchImpl: async () => response(replies.shift()),
  });

  const applied = await client.retrieveWithStatus("invented question", { rerank: true });
  const fallback = await client.retrieveWithStatus("invented question", { rerank: true });
  const unobserved = await client.retrieveWithStatus("invented question", { rerank: true });
  const legacyTrue = await client.retrieveWithStatus("invented question", { rerank: true });
  assert.deepEqual(applied.rerank, { requested: true, status: "applied", candidate_count: 30 });
  assert.deepEqual(fallback.rerank, { requested: true, status: "fallback", candidate_count: 30 });
  assert.deepEqual(unobserved.rerank, { requested: true, status: "unobserved", candidate_count: null });
  assert.deepEqual(legacyTrue.rerank, { requested: true, status: "unobserved", candidate_count: null });
});

test("private source-family identities and cursors use an authenticated JSON body", async () => {
  const calls = [];
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      return response({ source: null, families: [], next_cursor: null });
    },
  });

  await client.sourceFamilies({ cursor: "medical:private-record-id", limit: 1000 });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).search, "");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers["X-Admin-Key"], "fixture-key");
  assert.deepEqual(JSON.parse(calls[0].body), {
    cursor: "medical:private-record-id",
    limit: 1000,
  });
});

test("authenticated eval and corpus requests never follow a cross-origin redirect", async () => {
  let leakedHeaders = 0;
  const target = createServer((request, response_) => {
    if (request.headers["x-admin-key"]) leakedHeaders++;
    response_.end("{}");
  });
  const targetPort = await listen(target);
  const redirect = createServer((_request, response_) => {
    response_.statusCode = 302;
    response_.setHeader("Location", `http://127.0.0.1:${targetPort}/capture`);
    response_.end();
  });
  const redirectPort = await listen(redirect);
  try {
    const client = new BrainClient({
      base: `http://127.0.0.1:${redirectPort}`,
      adminKey: "fixture-key-that-must-not-leave-origin",
      retries: 0,
    });
    await assert.rejects(() => client.documents());
    await assert.rejects(() => client.sourceFamilies({
      cursor: "medical:private-record-id",
      limit: 1000,
    }));
    assert.equal(leakedHeaders, 0);
  } finally {
    await Promise.all([
      new Promise((resolve) => redirect.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ]);
  }
});

test("plain HTTP brain URLs are accepted only for loopback fixtures", () => {
  assert.throws(
    () => new BrainClient({ base: "http://brain.example", adminKey: "fixture-key" }),
    /must use HTTPS/,
  );
  assert.doesNotThrow(
    () => new BrainClient({ base: "http://127.0.0.1:8787", adminKey: "fixture-key" }),
  );
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

test("request failures expose typed aggregate diagnostics without response content", async () => {
  const privateResponse = "private-provider-message-that-must-not-leak";
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    retries: 0,
    fetchImpl: async () => response({ error: privateResponse }, 503),
  });

  await assert.rejects(async () => {
    try {
      await client.documents();
    } catch (error) {
      assert.equal(error.httpStatus, 503);
      assert.equal(error.observationKind, "transient");
      assert.doesNotMatch(error.message, new RegExp(privateResponse));
      throw error;
    }
  }, /HTTP 503/);
});

test("HTTP 408 is retried within the configured bounded attempt count", async () => {
  let calls = 0;
  const client = new BrainClient({
    base: "https://brain.example",
    adminKey: "fixture-key",
    retries: 1,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? response({ error: "temporary timeout" }, 408)
        : response({ rows: [] });
    },
  });

  assert.deepEqual(await client.documents(), { rows: [] });
  assert.equal(calls, 2);
});
