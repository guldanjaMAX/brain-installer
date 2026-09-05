/**
 * The wrangler login session lasts about an hour and wrangler renews it only
 * once it has expired. A run that starts with a few minutes left therefore
 * fails mid-provision with 403 9109. Cloudflare's refusal is the first moment
 * a refresh can work, so the API wrapper renews once and repeats the request;
 * a second refusal, or a refusal on an explicit token, still stops the run and
 * names where the credential came from. Reproduced live 2026-09-02 (20:49 MST).
 */
import assert from "node:assert/strict";
import { withWranglerSessionIfNeeded, cloudflareApiRequest } from "../brain.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const denied = { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null };
const granted = { success: true, errors: [], result: [{ id: "acct" }] };
const savedFetch = globalThis.fetch;
const savedToken = process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CLOUDFLARE_API_TOKEN;

function stubFetch(script) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization ?? null });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } });
  };
  return calls;
}
const session = (renew, read = () => A) => ({ env: {}, argv: ["--json"], readWranglerOAuthToken: read, renewSessionToken: renew });

try {
  // An expired session: renew once, repeat the same request with the new token.
  {
    const calls = stubFetch([{ status: 403, body: denied }, { status: 200, body: granted }]);
    let renewed = 0;
    const out = await withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => { renewed++; return B; }));
    assert.equal(renewed, 1, "renewed exactly once");
    assert.equal(calls.length, 2, "the request was repeated, not abandoned");
    assert.equal(calls[0].auth, `Bearer ${A}`);
    assert.equal(calls[1].auth, `Bearer ${B}`, "the repeat carries the renewed token");
    assert.ok(out, "the repeated request's result is returned");
  }
  // Renewal that yields the same token: one request, one refusal, source named.
  {
    const calls = stubFetch([{ status: 403, body: denied }]);
    await assert.rejects(
      withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => A)),
      (error) => /failed \(403\)/.test(error.message) && error.credentialSource === "wrangler-session",
    );
    assert.equal(calls.length, 1, "no blind retry when nothing changed");
  }
  // A refusal that is not an auth error never triggers a renewal.
  {
    const calls = stubFetch([{ status: 500, body: { success: false, errors: [{ code: 1000, message: "boom" }] } }]);
    let renewed = 0;
    await assert.rejects(withWranglerSessionIfNeeded(() => cloudflareApiRequest("/accounts"), session(() => { renewed++; return B; })));
    assert.equal(renewed, 0); assert.equal(calls.length, 1);
  }
  // An explicit process token has first priority over a local session.
  {
    process.env.CLOUDFLARE_API_TOKEN = "x".repeat(40);
    const calls = stubFetch([{ status: 403, body: denied }]);
    let renewed = 0;
    let sessionReads = 0;
    const logs = [];
    const savedLog = console.log;
    console.log = (...values) => logs.push(values.join(" "));
    try {
      await assert.rejects(
        withWranglerSessionIfNeeded(
          () => cloudflareApiRequest("/accounts"),
          { ...session(() => { renewed++; return B; }, () => { sessionReads++; return A; }), argv: [] },
        ),
        (error) => /failed \(403\)/.test(error.message) && error.credentialSource === undefined,
      );
    } finally {
      console.log = savedLog;
    }
    assert.equal(renewed, 0); assert.equal(calls.length, 1);
    assert.equal(sessionReads, 0, "the explicit process token bypasses local Wrangler discovery");
    assert.ok(logs.some((line) => /CLOUDFLARE_API_TOKEN supplied to this process/.test(line)),
      "the winning credential source is announced before account lookup");
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
} finally {
  globalThis.fetch = savedFetch;
  if (savedToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = savedToken;
}
console.log("wrangler session: an expired login is renewed once and the request repeated; a refusal names its source");
