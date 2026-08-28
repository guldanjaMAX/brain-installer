/**
 * A refusal that never reached the brain must not read as a broken install.
 *
 * Issue 14: a rule in front of a brain turns away clients that do not look like
 * a browser, and the symptom impersonates bad credentials or an outage. The
 * classifier's job is to be RIGHT, not eager: a genuine 403 from the brain is
 * JSON and must keep its own message, because a confident wrong diagnosis moves
 * the operator from one dead end to another.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RESET_MAY_BE_BOT_PROTECTION,
  cloudflareErrorCode,
  describeBotProtection,
} from "../components/brain-http.mjs";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name} (${String(error?.message || error).slice(0, 300)})`);
  }
};

const edge = (body, extra = {}) => ({
  status: 403,
  headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "8f0a11b2c3d4e5f6-IAD", ...extra },
  body,
  url: "https://brain.example.com/api/rag/think",
});

const BLOCK_PAGE_1010 =
  "<!DOCTYPE html><html><head><title>Access denied</title></head><body>" +
  "<h1>Access denied</h1><p>error code: 1010</p><p>Cloudflare Ray ID: 8f0a11b2c3d4e5f6</p></body></html>";

/* ------------------------------------------------------ it recognises it */

check("the 1010 block page is recognised and its code named", () => {
  const result = describeBotProtection(edge(BLOCK_PAGE_1010));
  assert.ok(result, "the reported signature must be recognised");
  assert.equal(result.kind, "bot-protection");
  assert.equal(result.errorCode, "1010");
});

check("a challenge page carrying no error code is still recognised", () => {
  const result = describeBotProtection(edge(
    "<!DOCTYPE html><html><head><title>Just a moment...</title></head>" +
    "<body><div id=\"cf-wrapper\">Checking your browser</div></body></html>",
    { "cf-mitigated": "challenge" },
  ));
  assert.ok(result, "matching on the error code alone misses every challenge page");
  assert.equal(result.errorCode, null);
});

check("a firewall-rule block (1020) and a rate refusal (429) are recognised", () => {
  assert.ok(describeBotProtection(edge("Sorry, you have been blocked. error code: 1020")));
  assert.ok(describeBotProtection({ ...edge(BLOCK_PAGE_1010), status: 429 }));
  assert.ok(describeBotProtection({ ...edge(BLOCK_PAGE_1010), status: 503 }));
});

/* ---------------------------------------------- and it does NOT overreach */

check("the brain's own 403 keeps its own message", () => {
  const result = describeBotProtection({
    status: 403,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: false, error: "admin key rejected" }),
    url: "https://brain.example.com/api/rag/think",
  });
  assert.equal(result, null, "a JSON refusal from the brain is not the edge refusing the client");
});

check("a 401 is never called bot protection", () => {
  // The edge does not ask for the brain's key. A 401 is the brain, always.
  assert.equal(describeBotProtection({ ...edge(BLOCK_PAGE_1010), status: 401 }), null);
});

check("a 500 with an HTML error page is not called bot protection", () => {
  assert.equal(describeBotProtection({ ...edge("<html>internal error</html>"), status: 500 }), null);
});

check("a 403 with an HTML page and no Cloudflare fingerprint is not claimed", () => {
  const result = describeBotProtection({
    status: 403,
    headers: { "content-type": "text/html" },
    body: "<html><body>Forbidden by the corporate proxy</body></html>",
    url: "https://brain.example.com/health",
  });
  assert.equal(result, null, "a guess would send the operator to a different wrong place");
});

check("the error code reader only matches Cloudflare's 1xxx range", () => {
  assert.equal(cloudflareErrorCode("error code: 1010"), "1010");
  assert.equal(cloudflareErrorCode("error code: 2010"), null);
  assert.equal(cloudflareErrorCode("no code here"), null);
});

/* ------------------------------------- and it says the RIGHT thing to a human */

check("the message says the key was never read, so nobody rotates it", () => {
  const { message } = describeBotProtection(edge(BLOCK_PAGE_1010));
  assert.match(message, /refused BEFORE it reached your brain/);
  assert.match(message, /admin key was never read/);
  assert.match(message, /rotating it will not help/);
});

check("the message carries the no-credential proof, against the real address", () => {
  const { message } = describeBotProtection(edge(BLOCK_PAGE_1010));
  assert.match(message, /curl -sS -i https:\/\/brain\.example\.com\/health/);
  assert.match(message, /-A "Mozilla\/5\.0" https:\/\/brain\.example\.com\/health/);
  assert.equal(message.includes("X-Admin-Key"), false, "the proof must not carry a credential");
});

check("the message names the runbook entry and the workers.dev exception", () => {
  const { message } = describeBotProtection(edge(BLOCK_PAGE_1010));
  assert.match(message, /06-runbook-top-ten-failures\.md/);
  assert.match(message, /workers\.dev/);
});

check("an unusable url degrades to a placeholder rather than throwing", () => {
  const result = describeBotProtection({ ...edge(BLOCK_PAGE_1010), url: "not a url" });
  assert.ok(result);
  assert.match(result.message, /<your brain's address>/);
});

check("a connection reset points at the possibility without asserting it", () => {
  assert.match(RESET_MAY_BE_BOT_PROTECTION, /may not be/);
  assert.match(RESET_MAY_BE_BOT_PROTECTION, /entry 1b/);
  assert.equal(/\bis a bot\b/.test(RESET_MAY_BE_BOT_PROTECTION), false);
});

/* -------------------------------------------- the shipped callers use it */

check("the CLI's health probe and ask path both classify before dying", () => {
  const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf-8");
  const uses = source.match(/describeBotProtection\(/g) || [];
  assert.ok(uses.length >= 2, `expected the health and ask paths to classify, found ${uses.length}`);
  assert.match(source, /the Brain never saw this question/);
  assert.match(source, /RESET_MAY_BE_BOT_PROTECTION/);
});

check("the MCP server shares the one classifier rather than its own substring", () => {
  const source = readFileSync(new URL("../components/brain-mcp.mjs", import.meta.url), "utf-8");
  assert.match(source, /describeBotProtection/);
  assert.equal(/text\.includes\("1010"\)/.test(source), false,
    "the private substring test drifted from the shared classifier and missed challenge pages");
});

check("the runbook entry the messages point at actually exists", () => {
  const runbook = readFileSync(new URL("../onboarding/06-runbook-top-ten-failures.md", import.meta.url), "utf-8");
  assert.match(runbook, /### 1b\. Every command is refused, but the same address opens fine in a browser/);
  assert.match(runbook, /error code: 1010/);
});

check("the user-agent requirement is documented for anyone writing a client", () => {
  const developer = readFileSync(new URL("../docs/README-developer.md", import.meta.url), "utf-8");
  assert.match(developer, /send a browser User-Agent/);
  assert.match(developer, /brain`'s own commands deliberately do NOT|deliberately do NOT/);
});

console.log(failures ? `\n${failures} failure(s)` : "\nall bot protection tests passed");
process.exit(failures ? 1 : 0);
