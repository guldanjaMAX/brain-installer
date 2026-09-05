import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  cloudflareOAuthInstallIdentity,
  cmdConnect,
  cmdDoctor,
  cmdDisconnect,
  withCloudflareControlCredential,
} from "../brain.mjs";

import {
  CLOUDFLARE_OAUTH_CALLBACK_HOST,
  CLOUDFLARE_OAUTH_CALLBACK_PORT,
  CLOUDFLARE_OAUTH_SCOPES,
  CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
  CloudflareOAuthSessionError,
  captureCloudflareOAuthToken,
  cloudflareOAuthChildEnvironment,
  cloudflareOAuthProfileName,
  createCloudflareOAuthProfile,
  enableCloudflareOAuthKeyring,
  listCloudflareOAuthAccounts,
  parseWranglerOAuthTokenJson,
  preflightCloudflareOAuthAccount,
  selectCloudflareOAuthAccount,
  withCloudflareOAuthSession,
} from "../operations/cloudflare-oauth-session.mjs";

const INSTALL_ID = "019d00ef-6b02-7a10-a68a-11aa22bb33cc";
const OTHER_INSTALL_ID = "019d00ef-6b02-7a10-a68a-44dd55ee66ff";
const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);
const ACCOUNT_C = "c".repeat(32);
const TOKEN = "fixture-oauth-access-token-0123456789abcdef";
const AMBIENT_SECRET = "ambient-secret-must-not-cross-child-boundary";

function tokenOutput(token = TOKEN) {
  return Buffer.from(JSON.stringify({ type: "oauth", token }, null, 2) + "\n", "utf8");
}

function okProcessResult({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0) } = {}) {
  return { status: 0, signal: null, error: null, stdout, stderr };
}

function processRecorder(handler = () => okProcessResult()) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } } });
    return handler({ command, args, options, index: calls.length - 1 });
  };
  runner.calls = calls;
  return runner;
}

function envelope(result, extra = {}) {
  return { success: true, errors: [], messages: [], result, ...extra };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorCode(code) {
  return (error) => error instanceof CloudflareOAuthSessionError && error.code === code;
}

test("profile names are stable, per-install, non-identifying, and never default", () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  assert.match(profile, /^financial-brain-[a-f0-9]{24}$/);
  assert.equal(profile, cloudflareOAuthProfileName(INSTALL_ID));
  assert.notEqual(profile, cloudflareOAuthProfileName(OTHER_INSTALL_ID));
  assert.ok(!profile.includes(INSTALL_ID));
  assert.notEqual(profile, "default");
  assert.throws(
    () => cloudflareOAuthProfileName("short"),
    errorCode("CLOUDFLARE_OAUTH_INSTALL_IDENTITY_INVALID"),
  );
});

test("the manifest schema and OAuth runtime agree on exact Cloudflare account ids", () => {
  const schema = JSON.parse(readFileSync(resolve("manifest.schema.json"), "utf8"));
  const accountSchema = schema.properties.infrastructure.properties.cloudflare.properties.account_id;
  const schemaPattern = new RegExp(accountSchema.pattern);
  for (const accountId of [ACCOUNT_A, ACCOUNT_B.toUpperCase()]) {
    assert.equal(schemaPattern.test(accountId), true);
    assert.doesNotThrow(() => cloudflareOAuthChildEnvironment({ accountId }));
  }
  for (const accountId of ["short-account", "g".repeat(32), `${ACCOUNT_A}00`]) {
    assert.equal(schemaPattern.test(accountId), false);
    assert.throws(
      () => cloudflareOAuthChildEnvironment({ accountId }),
      (error) => error?.code === "CLOUDFLARE_ACCOUNT_ID_INVALID",
    );
  }
  assert.equal(schemaPattern.test("REQUIRED_client_account_id"), true);
  assert.throws(
    () => cloudflareOAuthChildEnvironment({ accountId: "REQUIRED_client_account_id" }),
    (error) => error?.code === "CLOUDFLARE_ACCOUNT_ID_INVALID",
  );
});

test("a saved exact profile survives a moved manifest while an asserted mismatched identity fails closed", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const tokenStdout = tokenOutput();
  const runner = processRecorder(({ args }) => args.includes("token")
    ? okProcessResult({ stdout: tokenStdout })
    : okProcessResult());
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([{ id: ACCOUNT_A, name: "Bound" }], {
        result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 },
      }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Bound" }));
    }
    return jsonResponse(envelope([]));
  };
  const session = await withCloudflareOAuthSession({
    profile,
    expectedAccountId: ACCOUNT_A,
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    fetchImpl,
  });
  assert.equal(session.profile, profile);
  assert.equal(session.account.id, ACCOUNT_A);
  assert.equal(runner.calls.at(-1).args[runner.calls.at(-1).args.indexOf("--profile") + 1], profile);
  await assert.rejects(
    withCloudflareOAuthSession({ profile, installIdentity: OTHER_INSTALL_ID }),
    errorCode("CLOUDFLARE_OAUTH_PROFILE_MISMATCH"),
  );
});

test("Wrangler OAuth environment is allowlisted and admits only mandatory keyring plus an exact selected account", () => {
  const environment = {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    SystemRoot: "C:\\Windows",
    TEMP: "/fixture/tmp",
    LC_ALL: "C",
    ADMIN_KEY: AMBIENT_SECRET,
    CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
    CLOUDFLARE_API_KEY: AMBIENT_SECRET,
    CLOUDFLARE_EMAIL: "owner@example.test",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_C,
    CF_API_TOKEN: AMBIENT_SECRET,
    WRANGLER_PROFILE: "default",
    WRANGLER_AUTH_URL: "https://attacker.invalid/oauth",
    AWS_SECRET_ACCESS_KEY: AMBIENT_SECRET,
    GITHUB_TOKEN: AMBIENT_SECRET,
    NPM_TOKEN: AMBIENT_SECRET,
    NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
    HTTPS_PROXY: "https://name:password@proxy.invalid",
    CI: "true",
  };
  const clean = cloudflareOAuthChildEnvironment({ environment, accountId: ACCOUNT_A.toUpperCase() });
  assert.deepEqual(clean, {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    SystemRoot: "C:\\Windows",
    TEMP: "/fixture/tmp",
    LC_ALL: "C",
    CLOUDFLARE_AUTH_USE_KEYRING: "true",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_A,
  });
  assert.equal(JSON.stringify(clean).includes(AMBIENT_SECRET), false);

  const beforeSelection = cloudflareOAuthChildEnvironment({ environment });
  assert.equal(beforeSelection.CLOUDFLARE_AUTH_USE_KEYRING, "true");
  assert.equal(Object.hasOwn(beforeSelection, "CLOUDFLARE_ACCOUNT_ID"), false);
});

test("profile authorization pins Wrangler 4.127.1, keyring, scopes, browser callback, and exact profile", () => {
  const runner = processRecorder();
  const profile = createCloudflareOAuthProfile({
    installIdentity: INSTALL_ID,
    processRunner: runner,
    platformName: "darwin",
    environment: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
      ADMIN_KEY: AMBIENT_SECRET,
    },
  });
  assert.equal(profile, cloudflareOAuthProfileName(INSTALL_ID));
  assert.equal(runner.calls.length, 2);

  const [keyring, authorize] = runner.calls;
  assert.equal(keyring.command, "npx");
  assert.deepEqual(keyring.args.slice(0, -1), [
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "keyring", "enable",
  ]);
  assert.equal(keyring.args.at(-1), "--env-file=/dev/null");
  assert.deepEqual(keyring.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(keyring.options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");

  assert.deepEqual(authorize.args.slice(0, -1), [
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "create", profile,
    "--scopes", ...CLOUDFLARE_OAUTH_SCOPES,
    "--browser",
    "--callback-host", CLOUDFLARE_OAUTH_CALLBACK_HOST,
    "--callback-port", String(CLOUDFLARE_OAUTH_CALLBACK_PORT),
  ]);
  assert.equal(authorize.options.stdio, "inherit");
  assert.equal(authorize.options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");
  assert.equal(Object.hasOwn(authorize.options.env, "CLOUDFLARE_ACCOUNT_ID"), false);
  assert.equal(JSON.stringify(runner.calls).includes(AMBIENT_SECRET), false);
  assert.equal(authorize.args.includes("--profile"), false, "auth create takes the named profile positionally");
  assert.equal(authorize.args.includes("default"), false);
});

test("keyring failure is a generic hard stop and captured output is wiped", () => {
  const stdout = Buffer.from(AMBIENT_SECRET);
  const stderr = Buffer.from(AMBIENT_SECRET);
  assert.throws(
    () => enableCloudflareOAuthKeyring({
      processRunner: () => ({ status: 1, stdout, stderr }),
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    }),
    (error) => {
      assert.equal(error.code, "CLOUDFLARE_KEYRING_UNAVAILABLE");
      assert.equal(error.message.includes(AMBIENT_SECRET), false);
      return true;
    },
  );
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(stderr.every((byte) => byte === 0));
});

test("strict token JSON parsing returns a caller-owned zeroable Buffer without accepting other auth types", () => {
  const source = Buffer.from(` { "token": "${TOKEN}", "type": "oauth" }\n`, "utf8");
  const token = parseWranglerOAuthTokenJson(source);
  assert.ok(Buffer.isBuffer(token));
  assert.equal(token.toString("utf8"), TOKEN);
  assert.notEqual(token.buffer, source.buffer, "the token uses an unpooled allocation separate from captured stdout");
  const tokenBeforeSourceWipe = Buffer.from(token);
  source.fill(0);
  assert.ok(token.equals(tokenBeforeSourceWipe), "the token is a copy, even when Node allocates both Buffers from one slab");
  tokenBeforeSourceWipe.fill(0);
  token.fill(0);
  assert.ok(token.every((byte) => byte === 0));

  const invalid = [
    JSON.stringify({ type: "api_token", token: TOKEN }),
    JSON.stringify({ type: "api_key", key: TOKEN, email: "owner@example.test" }),
    JSON.stringify({ type: "oauth", token: TOKEN, extra: true }),
    `{ "type": "oauth", "type": "oauth", "token": "${TOKEN}" }`,
    `{ "type": "oauth", "token": "fixture\\u002doauth-token-0123456789abcdef" }`,
    `{ "type": "oauth", "token": "short" }`,
    `{ "type": "oauth" }`,
    `not-json-${TOKEN}`,
  ];
  for (const text of invalid) {
    assert.throws(
      () => parseWranglerOAuthTokenJson(Buffer.from(text)),
      errorCode("CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID"),
      text.slice(0, 40),
    );
  }
  assert.throws(
    () => parseWranglerOAuthTokenJson(Buffer.alloc(16 * 1024 + 1, 0x20)),
    errorCode("CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID"),
  );
  assert.throws(
    () => parseWranglerOAuthTokenJson(String(tokenOutput())),
    errorCode("CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID"),
  );
});

test("token capture uses only exact named-profile JSON output, never argv/stdout disclosure, and wipes child buffers", () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const stdout = tokenOutput();
  const stderr = Buffer.from("non-secret diagnostic");
  const runner = processRecorder(() => okProcessResult({ stdout, stderr }));
  const token = captureCloudflareOAuthToken({
    profile,
    accountId: ACCOUNT_A,
    processRunner: runner,
    platformName: "win32",
    environment: {
      Path: "C:\\fixture\\bin",
      USERPROFILE: "C:\\Users\\fixture",
      CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
    },
  });
  assert.equal(token.toString("utf8"), TOKEN);
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(stderr.every((byte) => byte === 0));

  const [call] = runner.calls;
  assert.deepEqual(call.args.slice(0, -1), [
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "token", "--json",
    "--profile", profile,
  ]);
  assert.equal(call.options.shell, true);
  assert.equal(call.options.stdio[1], "pipe");
  assert.equal(call.options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");
  assert.equal(call.options.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_A);
  assert.equal(call.args.at(-1), "--env-file=NUL");
  assert.equal(JSON.stringify({ command: call.command, args: call.args, env: call.options.env }).includes(TOKEN), false);
  assert.equal(JSON.stringify(call.options.env).includes(AMBIENT_SECRET), false);
  assert.equal(call.args.includes("default"), false);
  token.fill(0);
});

test("failed token capture wipes any child output and never copies it into the error", () => {
  const stdout = tokenOutput();
  const stderr = Buffer.from(TOKEN);
  assert.throws(
    () => captureCloudflareOAuthToken({
      profile: cloudflareOAuthProfileName(INSTALL_ID),
      processRunner: () => ({ status: 1, stdout, stderr }),
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    }),
    (error) => {
      assert.equal(error.code, "CLOUDFLARE_OAUTH_REAUTH_REQUIRED");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(stderr.every((byte) => byte === 0));
});

test("account listing reads every page, validates exact identities, and refuses redirects", async () => {
  const token = Buffer.from(TOKEN);
  const calls = [];
  const pages = [
    envelope([
      { id: ACCOUNT_A.toUpperCase(), name: "Personal account" },
      { id: ACCOUNT_B, name: "Existing business" },
    ], { result_info: { page: 1, count: 2, total_count: 3, total_pages: 2 } }),
    envelope([
      { id: ACCOUNT_C, name: "Another account" },
    ], { result_info: { page: 2, count: 1, total_count: 3, total_pages: 2 } }),
  ];
  const accounts = await listCloudflareOAuthAccounts(token, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(pages[calls.length - 1]);
    },
  });
  assert.deepEqual(accounts, [
    { id: ACCOUNT_A, name: "Personal account" },
    { id: ACCOUNT_B, name: "Existing business" },
    { id: ACCOUNT_C, name: "Another account" },
  ]);
  assert.ok(Object.isFrozen(accounts));
  assert.ok(accounts.every(Object.isFrozen));
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/client\/v4\/accounts\?page=1&per_page=50$/);
  assert.match(calls[1].url, /\/client\/v4\/accounts\?page=2&per_page=50$/);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://api.cloudflare.com");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
  token.fill(0);
});

test("account listing fails closed on duplicate, malformed, or incomplete account pages", async () => {
  const token = Buffer.from(TOKEN);
  const cases = [
    envelope([
      { id: ACCOUNT_A, name: "One" },
      { id: ACCOUNT_A, name: "Duplicate" },
    ], { result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } }),
    envelope([
      { id: "not-an-account", name: "Bad" },
    ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }),
    envelope([
      { id: ACCOUNT_A, name: "One" },
    ], { result_info: { page: 1, count: 1, total_count: 2, total_pages: 1 } }),
  ];
  for (const body of cases) {
    await assert.rejects(
      listCloudflareOAuthAccounts(token, { fetchImpl: async () => jsonResponse(body) }),
      errorCode("CLOUDFLARE_ACCOUNT_LIST_INVALID"),
    );
  }
  token.fill(0);
});

test("account selection handles zero, one, many, exact binding, cancellation, and invalid IDs", async () => {
  const one = Object.freeze([{ id: ACCOUNT_A, name: "Personal" }]);
  let promptCalls = 0;
  assert.deepEqual(
    await selectCloudflareOAuthAccount(one, { prompt: async () => { promptCalls++; return ACCOUNT_A; } }),
    { id: ACCOUNT_A, name: "Personal" },
  );
  assert.equal(promptCalls, 0);

  await assert.rejects(
    selectCloudflareOAuthAccount([]),
    errorCode("CLOUDFLARE_ACCOUNT_NONE"),
  );

  const many = Object.freeze([
    { id: ACCOUNT_A, name: "Same name" },
    { id: ACCOUNT_B, name: "Same name" },
  ]);
  await assert.rejects(
    selectCloudflareOAuthAccount(many),
    errorCode("CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED"),
  );
  const chosen = await selectCloudflareOAuthAccount(many, {
    prompt: async (request) => {
      assert.equal(request.kind, "cloudflare_account");
      assert.equal(request.answer, "account_id");
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.accounts));
      return ACCOUNT_B.toUpperCase();
    },
  });
  assert.equal(chosen.id, ACCOUNT_B);
  assert.equal((await selectCloudflareOAuthAccount(many, { expectedAccountId: ACCOUNT_A })).id, ACCOUNT_A);
  await assert.rejects(
    selectCloudflareOAuthAccount(many, { expectedAccountId: ACCOUNT_C }),
    errorCode("CLOUDFLARE_ACCOUNT_BINDING_MISMATCH"),
  );
  await assert.rejects(
    selectCloudflareOAuthAccount(many, { prompt: async () => "" }),
    errorCode("CLOUDFLARE_ACCOUNT_SELECTION_CANCELLED"),
  );
  await assert.rejects(
    selectCloudflareOAuthAccount(many, { prompt: async () => ACCOUNT_C }),
    errorCode("CLOUDFLARE_ACCOUNT_SELECTION_INVALID"),
  );
});

test("account preflight proves the exact account plus Workers, D1, Vectorize, and Workers AI read paths", async () => {
  const token = Buffer.from(TOKEN);
  const paths = [];
  const receipt = await preflightCloudflareOAuthAccount(
    token,
    { id: ACCOUNT_A, name: "Selected account" },
    {
      fetchImpl: async (url, init) => {
        paths.push(new URL(url).pathname + new URL(url).search);
        assert.equal(init.redirect, "manual");
        if (new URL(url).pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
          return jsonResponse(envelope({ id: ACCOUNT_A, name: "Selected account" }));
        }
        return jsonResponse(envelope([]));
      },
    },
  );
  assert.deepEqual(receipt, {
    status: "ready",
    account: { id: ACCOUNT_A, name: "Selected account" },
    checks: ["account", "workers", "d1", "vectorize", "workers_ai"],
  });
  assert.deepEqual(paths, [
    `/client/v4/accounts/${ACCOUNT_A}`,
    `/client/v4/accounts/${ACCOUNT_A}/workers/scripts`,
    `/client/v4/accounts/${ACCOUNT_A}/d1/database`,
    `/client/v4/accounts/${ACCOUNT_A}/vectorize/v2/indexes`,
    `/client/v4/accounts/${ACCOUNT_A}/ai/models/search?per_page=1`,
  ]);
  token.fill(0);
});

test("preflight rejects wrong-account readback and missing OAuth scope without response disclosure", async () => {
  const token = Buffer.from(TOKEN);
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
      fetchImpl: async () => jsonResponse(envelope({ id: ACCOUNT_B, name: "Wrong" })),
    }),
    errorCode("CLOUDFLARE_ACCOUNT_BINDING_MISMATCH"),
  );
  await assert.rejects(
    preflightCloudflareOAuthAccount(token, { id: ACCOUNT_A, name: "Selected" }, {
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ code: 10000, message: TOKEN }],
        messages: [],
        result: null,
      }, { status: 403 }),
    }),
    (error) => error.code === "CLOUDFLARE_OAUTH_SCOPE_MISSING" && !error.message.includes(TOKEN),
  );
  token.fill(0);
});

test("complete setup session reauthorizes the named profile, selects before preflight, and zeroes token after action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const tokenStdout = tokenOutput();
  const runner = processRecorder(({ args }) => {
    if (args.includes("token")) return okProcessResult({ stdout: tokenStdout, stderr: Buffer.alloc(0) });
    return okProcessResult();
  });
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    fetchCalls.push(parsed.pathname + parsed.search);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "First" },
        { id: ACCOUNT_B, name: "Chosen" },
      ], { result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_B}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_B, name: "Chosen" }));
    }
    return jsonResponse(envelope([]));
  };
  let retainedToken;
  const result = await withCloudflareOAuthSession({
    installIdentity: INSTALL_ID,
    reauthorize: true,
    prompt: async () => ACCOUNT_B,
    action: async (session) => {
      retainedToken = session.token;
      assert.equal(session.token.toString("utf8"), TOKEN);
      assert.equal(session.profile, profile);
      assert.equal(session.account.id, ACCOUNT_B);
      assert.equal(session.preflight.status, "ready");
      return { status: "action_complete", profile: session.profile, account_id: session.account.id };
    },
    processRunner: runner,
    platformName: "darwin",
    environment: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CLOUDFLARE_API_TOKEN: AMBIENT_SECRET,
    },
    fetchImpl,
  });
  assert.deepEqual(result, { status: "action_complete", profile, account_id: ACCOUNT_B });
  assert.ok(retainedToken.every((byte) => byte === 0));
  assert.ok(tokenStdout.every((byte) => byte === 0));
  assert.equal(runner.calls.length, 3, "keyring, browser auth, then exact-profile token capture");
  assert.ok(runner.calls[1].args.includes(profile));
  assert.equal(runner.calls[2].args[runner.calls[2].args.indexOf("--profile") + 1], profile);
  assert.equal(runner.calls.some((call) => call.args.includes("default")), false);
  assert.equal(fetchCalls[0], "/client/v4/accounts?page=1&per_page=50");
  assert.ok(fetchCalls.slice(1).every((path) => path.includes(`/accounts/${ACCOUNT_B}`)));
});

test("routine bound session does not reauthorize or offer account reselection, returns no token, and zeroes on failure", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const tokenOutputs = [];
  const runner = processRecorder(({ args }) => {
    if (args.includes("token")) {
      const stdout = tokenOutput();
      tokenOutputs.push(stdout);
      return okProcessResult({ stdout });
    }
    return okProcessResult();
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Bound" },
        { id: ACCOUNT_B, name: "Other" },
      ], { result_info: { page: 1, count: 2, total_count: 2, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Bound" }));
    }
    return jsonResponse(envelope([]));
  };
  let promptCalled = false;
  const safe = await withCloudflareOAuthSession({
    installIdentity: INSTALL_ID,
    expectedAccountId: ACCOUNT_A,
    prompt: async () => { promptCalled = true; return ACCOUNT_B; },
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    fetchImpl,
  });
  assert.equal(promptCalled, false);
  assert.equal(safe.profile, profile);
  assert.equal(safe.account.id, ACCOUNT_A);
  assert.equal(Object.hasOwn(safe, "token"), false);
  assert.equal(JSON.stringify(safe).includes(TOKEN), false);
  assert.equal(runner.calls.length, 2, "keyring verification and token capture only");
  assert.equal(runner.calls[1].args[runner.calls[1].args.indexOf("--profile") + 1], profile);
  assert.equal(runner.calls[1].options.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_A);

  let retainedToken;
  await assert.rejects(
    withCloudflareOAuthSession({
      installIdentity: INSTALL_ID,
      expectedAccountId: ACCOUNT_A,
      action: async (session) => {
        retainedToken = session.token;
        throw new Error("synthetic action failure");
      },
      processRunner: runner,
      platformName: "darwin",
      environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
      fetchImpl,
    }),
    /synthetic action failure/,
  );
  assert.ok(retainedToken.every((byte) => byte === 0));
  assert.ok(tokenOutputs.every((bytes) => bytes.every((byte) => byte === 0)));
});

test("a read-only existing-profile session does not persist Wrangler's global keyring preference", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const runner = processRecorder(({ args }) => {
    if (args.includes("token")) return okProcessResult({ stdout: tokenOutput() });
    throw new Error(`unexpected mutating Wrangler command: ${args.join(" ")}`);
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/accounts")) {
      return jsonResponse(envelope([
        { id: ACCOUNT_A, name: "Bound" },
      ], { result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }));
    }
    if (parsed.pathname.endsWith(`/accounts/${ACCOUNT_A}`)) {
      return jsonResponse(envelope({ id: ACCOUNT_A, name: "Bound" }));
    }
    return jsonResponse(envelope([]));
  };

  const session = await withCloudflareOAuthSession({
    profile,
    expectedAccountId: ACCOUNT_A,
    readOnlyExistingProfile: true,
    processRunner: runner,
    platformName: "darwin",
    environment: { PATH: "/fixture/bin", HOME: "/fixture/home" },
    fetchImpl,
  });
  assert.equal(session.profile, profile);
  assert.equal(session.account.id, ACCOUNT_A);
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0].args.includes("token"));
  assert.equal(runner.calls[0].args.includes("enable"), false);
  assert.equal(runner.calls[0].args.includes("create"), false);
  assert.equal(runner.calls[0].args.includes("--browser"), false);
});

test("the command bridge keeps fresh and saved OAuth authoritative over an ambient token", async () => {
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "fixture-ambient-token-that-must-not-win";
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const modes = [];
  let tokenRunnerCalls = 0;
  const withOAuthSession = async (request) => {
    modes.push({ profile: request.profile || null, reauthorize: request.reauthorize });
    return request.action({
      token: Buffer.from(TOKEN),
      profile,
      account: { id: ACCOUNT_A, name: "Selected" },
      preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
    });
  };
  try {
    const fresh = await withCloudflareControlCredential((session) => session, {
      freshOAuth: true,
      reauthorizeOAuth: true,
      interactive: true,
      manifestPath: "/fixture/new/brain.manifest.json",
      withOAuthSession,
      withToken: async () => { tokenRunnerCalls += 1; throw new Error("token path must not run"); },
    });
    assert.equal(fresh.method, "wrangler_oauth");
    assert.equal(fresh.account.id, ACCOUNT_A);

    const resumed = await withCloudflareControlCredential((session) => session, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      withOAuthSession,
      withToken: async () => { tokenRunnerCalls += 1; throw new Error("token path must not run"); },
    });
    assert.equal(resumed.method, "wrangler_oauth");
    assert.equal(resumed.profile, profile);
    assert.deepEqual(modes, [
      { profile: null, reauthorize: true },
      { profile, reauthorize: false },
    ]);
    assert.equal(tokenRunnerCalls, 0);
  } finally {
    if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = saved;
  }
});

test("OAuth extension options cannot replace the saved profile, account, prompt, mode, or action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const accountPrompt = async () => ACCOUNT_A;
  let suppliedActionCalls = 0;
  let outerActionCalls = 0;
  let observed;
  const result = await withCloudflareControlCredential((session) => {
    outerActionCalls += 1;
    return session.method;
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: true,
    accountPrompt,
    oauthOptions: {
      profile: "attacker-controlled-profile",
      installIdentity: OTHER_INSTALL_ID,
      expectedAccountId: ACCOUNT_B,
      reauthorize: true,
      prompt: async () => ACCOUNT_B,
      action: async () => { suppliedActionCalls += 1; return "wrong action"; },
    },
    withOAuthSession: async (request) => {
      observed = request;
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "wrangler_oauth");
  assert.equal(observed.profile, profile);
  assert.equal(observed.installIdentity, undefined);
  assert.equal(observed.expectedAccountId, ACCOUNT_A);
  assert.equal(observed.reauthorize, false);
  assert.equal(observed.prompt, accountPrompt);
  assert.equal(suppliedActionCalls, 0);
  assert.equal(outerActionCalls, 1);
});

test("a routine saved profile works without a TTY and never opens reauthorization", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const modes = [];
  let prompts = 0;
  const result = await withCloudflareControlCredential((session) => session.method, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: false,
    allowBrowserReauth: false,
    allowTokenRecovery: false,
    askFn: async () => { prompts += 1; return "y"; },
    withOAuthSession: async (request) => {
      modes.push(request.reauthorize);
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "wrangler_oauth");
  assert.deepEqual(modes, [false]);
  assert.equal(prompts, 0);
});

test("a stale non-TTY saved profile fails closed without prompt, browser refresh, token fallback, or action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const modes = [];
  let prompts = 0;
  let tokenCalls = 0;
  let actionCalls = 0;
  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: false,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async () => { prompts += 1; return "y"; },
      withToken: async () => { tokenCalls += 1; },
      withOAuthSession: async (request) => {
        modes.push(request.reauthorize);
        throw new CloudflareOAuthSessionError(
          "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
          "request",
          "fixture expired session",
        );
      },
    }),
    (error) => error?.code === "AUTH_EXPIRED",
  );
  assert.deepEqual(modes, [false]);
  assert.equal(prompts, 0);
  assert.equal(tokenCalls, 0);
  assert.equal(actionCalls, 0);
});

test("legacy, explicit recovery, and noninteractive automation retain the token lane", async () => {
  let oauthCalls = 0;
  let tokenCalls = 0;
  const withToken = async (action) => {
    tokenCalls += 1;
    return action();
  };
  const withOAuthSession = async () => {
    oauthCalls += 1;
    throw new Error("OAuth lane must not run");
  };
  const legacy = await withCloudflareControlCredential((session) => session.method, {
    interactive: true,
    withToken,
    withOAuthSession,
  });
  const explicit = await withCloudflareControlCredential((session) => session.method, {
    authProfile: cloudflareOAuthProfileName(INSTALL_ID),
    accountId: ACCOUNT_A,
    forceToken: true,
    interactive: true,
    withToken,
    withOAuthSession,
  });
  assert.equal(legacy, "api_token");
  assert.equal(explicit, "api_token");
  assert.equal(tokenCalls, 2);
  assert.equal(oauthCalls, 0);
});

test("a malformed or placeholder account can never select a generic recovery-token slot", async () => {
  let selectedAccountId = "not-observed";
  const result = await withCloudflareControlCredential((session) => session.method, {
    accountId: "REQUIRED_client_account_id",
    interactive: true,
    withToken: async (action, options) => {
      selectedAccountId = options.accountId;
      return action();
    },
  });
  assert.equal(result, "api_token");
  assert.equal(selectedAccountId, null);
});

test("expired or stale-scope OAuth gets one owner-approved refresh before any action", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const attempts = [];
  let actionCalls = 0;
  const result = await withCloudflareControlCredential(() => {
    actionCalls += 1;
    return "completed";
  }, {
    authProfile: profile,
    accountId: ACCOUNT_A,
    interactive: true,
    allowBrowserReauth: true,
    askFn: async () => "y",
    withOAuthSession: async (request) => {
      attempts.push(request.reauthorize);
      if (!request.reauthorize) {
        throw new CloudflareOAuthSessionError(
          "CLOUDFLARE_OAUTH_SCOPE_MISSING",
          "request",
          "fixture stale scope",
        );
      }
      return request.action({
        token: Buffer.from(TOKEN),
        profile,
        account: { id: ACCOUNT_A, name: "Selected" },
        preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
      });
    },
  });
  assert.equal(result, "completed");
  assert.deepEqual(attempts, [false, true]);
  assert.equal(actionCalls, 1);
});

test("an OAuth-backed action failure propagates unchanged and is never retried as authentication", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const actionError = Object.assign(new Error("fixture install action failed after partial progress"), {
    code: "FIXTURE_ACTION_FAILED",
  });
  let actionCalls = 0;
  let oauthCalls = 0;
  let tokenCalls = 0;
  let promptCalls = 0;

  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw actionError;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async () => { promptCalls += 1; return "y"; },
      withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
      withOAuthSession: async (request) => {
        oauthCalls += 1;
        return request.action({
          token: Buffer.from(TOKEN),
          profile,
          account: { id: ACCOUNT_A, name: "Selected" },
          preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
        });
      },
    }),
    (error) => error === actionError && error.code === "FIXTURE_ACTION_FAILED",
  );

  assert.equal(actionCalls, 1);
  assert.equal(oauthCalls, 1);
  assert.equal(tokenCalls, 0);
  assert.equal(promptCalls, 0);
});

test("an action failure after approved OAuth refresh does not fall back or run again", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const actionError = Object.assign(new Error("fixture refreshed action failed"), {
    code: "FIXTURE_REFRESHED_ACTION_FAILED",
  });
  const oauthModes = [];
  let actionCalls = 0;
  let tokenCalls = 0;
  let promptCalls = 0;

  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw actionError;
    }, {
      authProfile: profile,
      accountId: ACCOUNT_A,
      interactive: true,
      allowBrowserReauth: true,
      allowTokenRecovery: true,
      askFn: async () => { promptCalls += 1; return "y"; },
      withToken: async () => { tokenCalls += 1; throw new Error("token lane must not run"); },
      withOAuthSession: async (request) => {
        oauthModes.push(request.reauthorize);
        if (!request.reauthorize) {
          throw new CloudflareOAuthSessionError(
            "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
            "request",
            "fixture expired session",
          );
        }
        return request.action({
          token: Buffer.from(TOKEN),
          profile,
          account: { id: ACCOUNT_A, name: "Selected" },
          preflight: { status: "ready", checks: ["account", "workers", "d1", "vectorize", "workers_ai"] },
        });
      },
    }),
    (error) => error === actionError && error.code === "FIXTURE_REFRESHED_ACTION_FAILED",
  );

  assert.deepEqual(oauthModes, [false, true]);
  assert.equal(actionCalls, 1);
  assert.equal(tokenCalls, 0);
  assert.equal(promptCalls, 1);
});

test("a token-lane action failure also propagates unchanged exactly once", async () => {
  const actionError = Object.assign(new Error("fixture token action failed"), {
    code: "FIXTURE_TOKEN_ACTION_FAILED",
  });
  let actionCalls = 0;
  let tokenCalls = 0;

  await assert.rejects(
    withCloudflareControlCredential(() => {
      actionCalls += 1;
      throw actionError;
    }, {
      interactive: true,
      withToken: async (action) => {
        tokenCalls += 1;
        return action();
      },
    }),
    (error) => error === actionError && error.code === "FIXTURE_TOKEN_ACTION_FAILED",
  );

  assert.equal(actionCalls, 1);
  assert.equal(tokenCalls, 1);
});

test("Zoom connect and disconnect use the manifest's exact saved Cloudflare profile", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const root = mkdtempSync(resolve(tmpdir(), "brain-zoom-oauth-dispatch-"));
  const manifestPath = resolve(root, "brain.manifest.json");
  const manifest = JSON.parse(readFileSync(resolve("templates/brain.manifest.json"), "utf8"));
  manifest.infrastructure.cloudflare.account_id = ACCOUNT_A;
  manifest.infrastructure.cloudflare.auth_profile = profile;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const controlRequests = [];
  const connectorCalls = [];
  const withCloudflareControl = async (action, request) => {
    controlRequests.push({
      manifestPath: request.manifestPath,
      accountId: request.accountId,
      authProfile: request.authProfile,
    });
    return action();
  };
  try {
    const connectResult = await cmdConnect("zoom", {
      argv: ["node", "brain.mjs", "connect", "zoom", manifestPath],
      connectZoom: async (path) => {
        connectorCalls.push(["connect", path]);
        return "connected";
      },
      controlOptions: { interactive: true, withCloudflareControl },
    });
    const disconnectResult = await cmdDisconnect("zoom", {
      argv: ["node", "brain.mjs", "disconnect", "zoom", manifestPath],
      disconnectZoom: async (path) => {
        connectorCalls.push(["disconnect", path]);
        return "disconnected";
      },
      controlOptions: { interactive: true, withCloudflareControl },
    });

    assert.equal(connectResult, "connected");
    assert.equal(disconnectResult, "disconnected");
    assert.deepEqual(connectorCalls, [
      ["connect", manifestPath],
      ["disconnect", manifestPath],
    ]);
    assert.deepEqual(controlRequests, [
      { manifestPath, accountId: ACCOUNT_A, authProfile: profile },
      { manifestPath, accountId: ACCOUNT_A, authProfile: profile },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plain doctor runs deployed migration checks inside the saved browser profile without reauthorization", async () => {
  const profile = cloudflareOAuthProfileName(INSTALL_ID);
  const root = mkdtempSync(resolve(tmpdir(), "brain-doctor-oauth-dispatch-"));
  const manifestPath = resolve(root, "brain.manifest.json");
  const manifest = JSON.parse(readFileSync(resolve("templates/brain.manifest.json"), "utf8"));
  manifest.infrastructure.cloudflare.account_id = ACCOUNT_A;
  manifest.infrastructure.cloudflare.auth_profile = profile;
  manifest.corpora.bank_feed.enabled = false;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  let insideSavedProfile = false;
  let checksumChecks = 0;
  let request = null;
  try {
    await cmdDoctor(manifestPath, {
      doctorRunAll: async () => [],
      withAvailableCloudflareToken: async (action) => action(),
      withCloudflareControl: async (action, received) => {
        request = received;
        insideSavedProfile = true;
        try { return await action(); }
        finally { insideSavedProfile = false; }
      },
      buildUpgradePauseCheck: async () => ({
        name: "upgrade state",
        status: "ok",
        detail: "fixture active",
      }),
      buildChecksumDriftCheck: async () => {
        checksumChecks += 1;
        assert.equal(insideSavedProfile, true);
        return {
          name: "migration checksums",
          status: "ok",
          detail: "fixture checked through D1",
        };
      },
      checkBankFeedRedirect: () => ({
        name: "Bank feed",
        status: "ok",
        detail: "fixture disabled",
      }),
    });

    assert.equal(checksumChecks, 1);
    assert.equal(request.manifestPath, manifestPath);
    assert.equal(request.accountId, ACCOUNT_A);
    assert.equal(request.authProfile, profile);
    assert.equal(request.interactive, false);
    assert.equal(request.allowBrowserReauth, false);
    assert.equal(request.allowTokenRecovery, false);
    assert.equal(request.oauthOptions.readOnlyExistingProfile, true);
    assert.notEqual(request.reauthorizeOAuth, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest-path identity is canonical, bounded, and does not disclose a long local path", () => {
  const longPath = resolve("/tmp", ...Array.from({ length: 80 }, (_, index) => `segment-${index}`), "brain.manifest.json");
  const identity = cloudflareOAuthInstallIdentity(longPath);
  assert.match(identity, /^financial-brain-manifest-v1:[a-f0-9]{64}$/);
  assert.ok(identity.length < 100);
  assert.equal(identity.includes("segment-1"), false);
  assert.equal(identity, cloudflareOAuthInstallIdentity(longPath));
});
