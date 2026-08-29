import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadStoredCloudflareToken,
  storeCloudflareToken,
  forgetCloudflareToken,
  hasStoredCloudflareToken,
  storedTokenReference,
} from "../operations/cloudflare-token-store.mjs";
import { withCloudflareToken } from "../brain.mjs";

// Synthetic fixtures. The account id keeps Cloudflare's 32-hex-character
// shape so the scoping assertions below still exercise a realistic value; it
// identifies no real Cloudflare account.
const ACCOUNT = "deadbeefdeadbeefdeadbeefdeadbeef";
const TOKEN = "a".repeat(40);

function fakeRunner(result) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    return typeof result === "function" ? result({ command, args, options }) : result;
  };
  fn.calls = calls;
  return fn;
}

test("load reads per-account, trims the trailing newline, and misses cleanly", () => {
  const hit = fakeRunner({ status: 0, stdout: Buffer.from(`${TOKEN}\n`), stderr: Buffer.alloc(0) });
  const value = loadStoredCloudflareToken(ACCOUNT, { platform: "darwin", processRunner: hit });
  assert.equal(value.toString("ascii"), TOKEN);
  value.fill(0);
  const [call] = hit.calls;
  assert.equal(call.args[0], "find-generic-password");
  assert.ok(call.args.includes(ACCOUNT), "the lookup is scoped to the account");

  const miss = fakeRunner({ status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from("could not be found") });
  assert.equal(loadStoredCloudflareToken(ACCOUNT, { platform: "darwin", processRunner: miss }), null);

  const broken = fakeRunner({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("keychain locked") });
  assert.throws(
    () => loadStoredCloudflareToken(ACCOUNT, { platform: "darwin", processRunner: broken }),
    /could not read/,
    "a broken keychain must present as itself, never as silence",
  );
});

test("store sends the secret on stdin, never argv, and the caller keeps its buffer", () => {
  const run = fakeRunner({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const mine = Buffer.from(TOKEN);
  storeCloudflareToken(ACCOUNT, mine, { platform: "darwin", processRunner: run });
  const [call] = run.calls;
  assert.ok(!call.args.some((arg) => String(arg).includes(TOKEN)), "the token must never ride argv");
  assert.ok(call.options.input.toString("ascii").startsWith(TOKEN), "the token travels on stdin");
  assert.equal(mine.toString("ascii"), TOKEN, "the caller's buffer survives: the run still needs it");
  assert.ok(call.args.includes("-U"), "re-storing a rotated token updates in place");
});

test("forget distinguishes removed from never-stored", () => {
  const removed = fakeRunner({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  assert.equal(forgetCloudflareToken(ACCOUNT, { platform: "darwin", processRunner: removed }), true);
  const absent = fakeRunner({ status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from("could not be found") });
  assert.equal(forgetCloudflareToken(ACCOUNT, { platform: "darwin", processRunner: absent }), false);
});

test("everything degrades explicitly off macOS", () => {
  assert.equal(loadStoredCloudflareToken(ACCOUNT, { platform: "linux" }), null);
  assert.equal(forgetCloudflareToken(ACCOUNT, { platform: "linux" }), false);
  assert.throws(() => storeCloudflareToken(ACCOUNT, TOKEN, { platform: "linux" }), /macOS Keychain/);
  assert.match(storedTokenReference(ACCOUNT), new RegExp(ACCOUNT));
  const stored = fakeRunner({ status: 0, stdout: Buffer.from(TOKEN), stderr: Buffer.alloc(0) });
  assert.equal(hasStoredCloudflareToken(ACCOUNT, { platform: "darwin", processRunner: stored }), true);
});

test("withCloudflareToken prefers the stored token and never prompts when it exists", async () => {
  let prompted = false;
  let ran = false;
  await withCloudflareToken(async () => { ran = true; }, {
    accountId: ACCOUNT,
    loadStoredCloudflareToken: () => Buffer.from(TOKEN),
    readCloudflareToken: () => { prompted = true; return Promise.resolve(Buffer.from(TOKEN)); },
  });
  assert.equal(ran, true);
  assert.equal(prompted, false, "a stored token makes provisioning non-interactive");
});

test("after a manual prompt the token is offered for storage, and declining is honored", async () => {
  const outcomes = [];
  const run = async (answer) => {
    const storeCalls = [];
    await withCloudflareToken(async () => {}, {
      accountId: ACCOUNT,
      platform: "darwin",
      interactive: true,
      loadStoredCloudflareToken: () => null,
      readCloudflareToken: () => Promise.resolve(Buffer.from(TOKEN)),
      askFn: async () => answer,
      storeCloudflareToken: (accountId, token) => {
        storeCalls.push({ accountId, token: token.toString("ascii") });
      },
    });
    outcomes.push(storeCalls);
  };
  await run("y");
  await run("n");
  assert.equal(outcomes[0].length, 1, "accepting the offer stores the token");
  assert.equal(outcomes[0][0].accountId, ACCOUNT);
  assert.equal(outcomes[0][0].token, TOKEN);
  assert.equal(outcomes[1].length, 0, "declining stores nothing");
});

test("without a named account the store is never consulted", async () => {
  let loaded = false;
  await withCloudflareToken(async () => {}, {
    loadStoredCloudflareToken: () => { loaded = true; return null; },
    readCloudflareToken: () => Promise.resolve(Buffer.from(TOKEN)),
  });
  assert.equal(loaded, false, "a keyless lookup could hand back the wrong account's token");
});

console.log("cloudflare token store: all focused tests passed");
