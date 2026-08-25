import assert from "node:assert/strict";
import http from "node:http";
import {
  BRAIN_ADMIN_HEADER,
  assertExactBrainResponseOrigin,
  fetchBrainWithAdminKey,
  guardBrainAdminFetch,
  secureBrainRequestUrl,
} from "../components/brain-http.mjs";

assert.equal(secureBrainRequestUrl("https://brain.example.com/a").origin, "https://brain.example.com");
assert.equal(secureBrainRequestUrl("http://localhost:8787/a").hostname, "localhost");
assert.equal(secureBrainRequestUrl("http://127.9.8.7:8787/a").hostname, "127.9.8.7");
assert.equal(secureBrainRequestUrl("http://[::1]:8787/a").hostname, "[::1]");
assert.throws(() => secureBrainRequestUrl("http://brain.example.com/a"), /HTTPS.*loopback/i);
assert.throws(() => secureBrainRequestUrl("ftp://brain.example.com/a"), /HTTPS.*loopback/i);
assert.throws(() => secureBrainRequestUrl("https://user:pass@brain.example.com/a"), /must not contain credentials/i);

let credentialsRead = 0;
let requestsMade = 0;
await assert.rejects(
  fetchBrainWithAdminKey(
    async () => { requestsMade++; },
    "http://brain.example.com/api/admin/brain/documents",
    {},
    () => { credentialsRead++; return "fixture-key"; },
  ),
  /HTTPS.*loopback/i,
);
assert.equal(credentialsRead, 0, "an insecure URL is rejected before durable credential resolution");
assert.equal(requestsMade, 0, "an insecure URL is rejected before transport use");

const directCalls = [];
const direct = await fetchBrainWithAdminKey(async (url, init) => {
  directCalls.push({ url, init });
  return new Response("ready", { status: 200 });
}, "https://brain.example.com/api/admin/brain/documents", {
  headers: { "User-Agent": "fixture" },
}, () => "fixture-key");
assert.equal(direct.status, 200);
assert.equal(directCalls.length, 1);
assert.equal(directCalls[0].init.redirect, "error");
assert.equal(new Headers(directCalls[0].init.headers).get(BRAIN_ADMIN_HEADER), "fixture-key");

await assert.rejects(
  fetchBrainWithAdminKey(async () => ({
    ok: true,
    status: 200,
    redirected: false,
    url: "https://other.example/api/admin/brain/documents",
  }), "https://brain.example.com/api/admin/brain/documents", {}, () => "fixture-key"),
  /different origin/i,
);
assert.throws(
  () => assertExactBrainResponseOrigin(
    { redirected: true, url: "https://brain.example.com/final" },
    new URL("https://brain.example.com/start"),
  ),
  /redirected/i,
);

// This is the behavior that created the bug: Node forwards custom headers on a
// cross-origin redirect. The strict request must fail at the 302, and the second
// origin must never observe the synthetic key.
let leakedHeader = null;
const target = http.createServer((request, response) => {
  leakedHeader = request.headers["x-admin-key"] || null;
  response.end("unexpected");
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
const targetPort = target.address().port;
const source = http.createServer((_request, response) => {
  response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/captured` });
  response.end();
});
await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
const sourcePort = source.address().port;
try {
  await assert.rejects(
    fetchBrainWithAdminKey(
      fetch,
      `http://127.0.0.1:${sourcePort}/start`,
      {},
      () => "synthetic-admin-key",
    ),
  );
  assert.equal(leakedHeader, null, "a cross-origin 302 never receives X-Admin-Key");
} finally {
  await Promise.all([
    new Promise((resolve) => source.close(resolve)),
    new Promise((resolve) => target.close(resolve)),
  ]);
}

const guardedCalls = [];
await guardBrainAdminFetch(async (url, init) => {
  guardedCalls.push({ url, init });
  return new Response("ok");
}, "https://brain.example.com/health", { headers: { "X-Admin-Key": "fixture-key" } });
assert.equal(guardedCalls[0].init.redirect, "error");
assert.equal(new Headers(guardedCalls[0].init.headers).get(BRAIN_ADMIN_HEADER), "fixture-key");

let guardedUnsafeCalls = 0;
await assert.rejects(
  guardBrainAdminFetch(async () => { guardedUnsafeCalls++; }, "http://brain.example.com/private", {
    headers: { "X-Admin-Key": "fixture-key" },
  }),
  /HTTPS.*loopback/i,
);
assert.equal(guardedUnsafeCalls, 0, "the shared CLI guard refuses insecure admin requests before fetch");

console.log("authenticated Brain HTTP: exact-origin redirect protections passed");
