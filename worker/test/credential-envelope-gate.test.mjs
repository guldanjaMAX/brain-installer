import assert from "node:assert/strict";

import worker from "../src/index.js";

const secret = `sk-proj-${"A7".repeat(16)}`;
const env = { STORAGE: "d1", ADMIN_KEY: "fixture-admin" };
const context = { waitUntil() {}, passThroughOnException() {} };

const post = (path, body) => worker.fetch(new Request(`https://brain.invalid${path}`, {
  method: "POST",
  headers: { "X-Admin-Key": "fixture-admin", "content-type": "application/json" },
  body: JSON.stringify(body),
}), env, context);

for (const [name, envelope] of [
  ["title", {
    source_type: "note",
    source_id: "title-only",
    title: `Credentials ${secret}`,
    content: "ordinary prose",
  }],
  ["path metadata", {
    source_type: "note",
    source_id: "path-only",
    content: "ordinary prose",
    metadata: { folder: `Imports/${secret}/Notes` },
  }],
]) {
  const response = await post("/api/admin/brain/ingest", envelope);
  const text = await response.text();
  assert.equal(response.status, 422, `single ingest must refuse a credential in ${name}`);
  assert.doesNotMatch(text, new RegExp(secret), `single-ingest refusal must not echo ${name}`);
}

const batchResponse = await post("/api/admin/brain/ingest/batch", {
  docs: [{
    source_type: "note",
    source_id: "batch-path-only",
    content: "ordinary prose",
    metadata: { folder: `Imports/${secret}/Notes` },
  }],
});
const batchText = await batchResponse.text();
assert.equal(batchResponse.status, 200);
assert.doesNotMatch(batchText, new RegExp(secret), "batch refusal must not echo path metadata");
const batch = JSON.parse(batchText);
assert.equal(batch.refused, 1);
assert.equal(batch.created, 0);
assert.equal(batch.results[0]?.status, "refused");
assert.ok(batch.results[0]?.labels?.includes("openai_api_key"));

console.log("credential envelope gate: focused Worker route tests passed");
