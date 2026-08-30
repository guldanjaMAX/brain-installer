import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_KEY_GITIGNORE_RULES,
  cmdSecrets,
  cmdSetup,
  configureStandardAdminKeyStorage,
  evalChildEnvironment,
  prepareSetupAdminKey,
  resolveAdminKey,
  standardMacAdminKeyReference,
} from "../brain.mjs";
import { readAdminKeyFile } from "../operations/admin-key-file.mjs";
import {
  adminKeyPersistencePlan,
  keychainChildEnvironment,
  parseAdminKeySecretReference,
  persistAdminKeyDurably,
  writeAdminKeyToKeychain,
} from "../operations/admin-key-persistence.mjs";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-admin-key-rotation-")));
const currentKey = `current-${"a".repeat(40)}`;
const replacementKey = `replacement-$& []{}-key-${"b".repeat(30)}`;
const priorKey = `prior-${"c".repeat(42)}`;
const nativeFileOptions = process.platform === "win32"
  ? { username: process.env.USERNAME || process.env.USER }
  : {};

function manifest(operations = undefined) {
  return {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    ...(operations === undefined ? {} : { operations }),
  };
}

function writeManifest(directory, value) {
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function initGitRepo(directory) {
  const result = spawnSync("git", ["init", "-q"], {
    cwd: directory,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || tmpdir(),
      TMPDIR: process.env.TMPDIR || tmpdir(),
    },
  });
  assert.equal(result.status, 0, result.stderr || "git init failed");
}

function apiResponse(result) {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function apiErrorResponse(message = "fixture remote failure") {
  return new Response(JSON.stringify({
    success: false,
    result: null,
    errors: [{ code: 1000, message }],
  }), { status: 503, headers: { "content-type": "application/json" } });
}

function cloudflareHarness(events, {
  failAdminOnce = false,
  failAccount = false,
  initialSecrets = [],
} = {}) {
  let adminFailed = false;
  const secrets = new Set(initialSecrets);
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    if (url.pathname === "/client/v4/accounts" && method === "GET") {
      events.push("account");
      if (failAccount) return apiErrorResponse("fixture account denial");
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      return apiResponse([...secrets].map((name) => ({ name, type: "secret_text" })));
    }
    const secretPath = url.pathname.match(/\/workers\/scripts\/fixture-brain\/secrets\/([^/]+)$/);
    if (secretPath && method === "DELETE") {
      const name = decodeURIComponent(secretPath[1]);
      events.push(`delete:${name}`);
      secrets.delete(name);
      return apiResponse({});
    }
    if (url.pathname.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      const name = JSON.parse(String(options.body || "{}")).name;
      events.push(`remote:${name}`);
      if (name === "ADMIN_KEY" && failAdminOnce && !adminFailed) {
        adminFailed = true;
        return apiErrorResponse(replacementKey);
      }
      secrets.add(name);
      return apiResponse({});
    }
    throw new Error(`offline fixture has no response for ${method} ${url.pathname}`);
  };
}

async function isolatedRuntime({ fetchImpl, env }, operation) {
  const priorFetch = globalThis.fetch;
  const names = [
    "CLOUDFLARE_API_TOKEN",
    "ADMIN_KEY",
    "ANTHROPIC_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const output = [];
  const priorLog = console.log;
  try {
    globalThis.fetch = fetchImpl;
    console.log = (...args) => output.push(args.map(String).join(" "));
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(env || {})) process.env[name] = value;
    const value = await operation();
    return { value, output: output.join("\n") };
  } catch (error) {
    error.capturedOutput = output.join("\n");
    throw error;
  } finally {
    globalThis.fetch = priorFetch;
    console.log = priorLog;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
}

function fakeKeychain({ initial = null, corruptFirstVerification = false, failRollback = false } = {}) {
  let stored = initial;
  let reads = 0;
  let writes = 0;
  const calls = [];
  return {
    calls,
    get stored() { return stored; },
    runChild(command, args, options = {}) {
      const input = options.input === undefined ? null : Buffer.from(options.input);
      calls.push({
        command,
        args: [...args],
        env: { ...(options.env || {}) },
        input,
      });
      const securityAction = command.endsWith("/expect")
        ? args[2]
        : args[0];
      if (securityAction === "find-generic-password") {
        reads++;
        if (stored === null) {
          return { status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from("item not found") };
        }
        const visible = corruptFirstVerification && reads === 2
          ? `corrupt-${"z".repeat(40)}`
          : stored;
        return { status: 0, stdout: Buffer.from(`${visible}\n`), stderr: Buffer.alloc(0) };
      }
      if (securityAction === "add-generic-password") {
        writes++;
        if (failRollback && writes === 2) {
          return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(replacementKey) };
        }
        stored = input.subarray(0, input.length - 1).toString("utf8");
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (securityAction === "delete-generic-password") {
        stored = null;
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("unexpected child") };
    },
  };
}

try {
  chmodSync(sandbox, 0o700);

  const sixteenHexClasses = "[0-9a-f]".repeat(16);
  assert.deepEqual(ADMIN_KEY_GITIGNORE_RULES, [
    ".brain-admin-key",
    `..brain-admin-key.[0-9]*.${sixteenHexClasses}.tmp`,
    `..brain-admin-key.[0-9]*.${sixteenHexClasses}.bak`,
  ]);

  /* ---------------- storage planning and adjacent exact verification */
  const adjacentDir = join(sandbox, "adjacent");
  mkdirSync(adjacentDir, { mode: 0o700 });
  const adjacentManifest = writeManifest(adjacentDir, manifest());
  const adjacentPlan = adminKeyPersistencePlan(adjacentManifest, manifest(), nativeFileOptions);
  assert.equal(adjacentPlan.backend, "file");
  const adjacentReceipt = persistAdminKeyDurably(adjacentPlan, currentKey, nativeFileOptions);
  assert.equal(adjacentReceipt.replaced, false);
  assert.equal(readAdminKeyFile(adjacentPlan.path, nativeFileOptions), currentKey);
  assert.equal(persistAdminKeyDurably(adjacentPlan, replacementKey, nativeFileOptions).replaced, true);
  assert.equal(readAdminKeyFile(adjacentPlan.path, nativeFileOptions), replacementKey);

  assert.throws(
    () => adminKeyPersistencePlan(adjacentManifest, manifest({ admin_key_secret: "secret://wrong/value" })),
    /must use keychain:\/\//i,
  );
  assert.throws(
    () => adminKeyPersistencePlan(
      adjacentManifest,
      manifest({ admin_key_secret: "keychain://brain-admin/owner" }),
      { platform: "linux" },
    ),
    /only on macOS/i,
  );
  assert.deepEqual(
    parseAdminKeySecretReference("keychain://brain%20admin/owner%2Fprimary"),
    { backend: "keychain", service: "brain admin", account: "owner/primary" },
  );

  const cleanEnvironment = keychainChildEnvironment({
    HOME: "/Users/fixture",
    USER: "fixture",
    ADMIN_KEY: replacementKey,
    CLOUDFLARE_API_TOKEN: "deployment-secret",
  });
  assert.equal(cleanEnvironment.HOME, "/Users/fixture");
  assert.equal(cleanEnvironment.ADMIN_KEY, undefined);
  assert.equal(cleanEnvironment.CLOUDFLARE_API_TOKEN, undefined);

  const evalEnvironment = evalChildEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/fixture",
    BRAIN_ADMIN_KEY: priorKey,
    ADMIN_KEY: currentKey,
    CLOUDFLARE_API_TOKEN: "deployment-secret",
    OPENAI_API_KEY: "model-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  });
  assert.equal(evalEnvironment.PATH, "/usr/bin");
  assert.equal(evalEnvironment.HOME, "/Users/fixture");
  assert.equal(evalEnvironment.BRAIN_ADMIN_KEY_STDIN, "1");
  assert.equal(evalEnvironment.BRAIN_ADMIN_KEY, undefined);
  assert.equal(evalEnvironment.ADMIN_KEY, undefined);
  assert.equal(evalEnvironment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(evalEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(evalEnvironment.AWS_SECRET_ACCESS_KEY, undefined);

  const evalGoldenPath = join(sandbox, "stdin-transport.golden.json");
  writeFileSync(evalGoldenPath, JSON.stringify({
    install: "stdin-transport-fixture",
    questions: [{
      id: "q1",
      kind: "single",
      question: "Which fixture document should be returned?",
      expect: [{ doc: "Fixture", any_of: ["curated:fixture-document"] }],
    }],
  }));
  const evalInput = Buffer.from(`${replacementKey}\n`, "utf8");
  const evalFixtureResponse = encodeURIComponent(JSON.stringify({
    results: [{
      source: "curated",
      ref_key: "fixture-document",
      title: "Fixture",
    }],
  }));
  const evalServerPortFile = join(sandbox, "eval-loopback-port");
  const evalServer = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const [portFile, encodedResponse] = process.argv.slice(1);
      const response = decodeURIComponent(encodedResponse);
      const server = createServer((request, reply) => {
        request.resume();
        request.on("end", () => {
          reply.writeHead(200, { "content-type": "application/json" });
          reply.end(response);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        writeFileSync(portFile, String(server.address().port), { mode: 0o600 });
      });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `,
    evalServerPortFile,
    evalFixtureResponse,
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  let evalResult;
  try {
    const waitState = new Int32Array(new SharedArrayBuffer(4));
    const evalServerDeadline = Date.now() + 5_000;
    // A port file can become visible between its create and write syscalls.
    // Wait for the complete numeric receipt so a fast filesystem cannot turn
    // this credential test into a flaky request to `127.0.0.1:`.
    let evalServerPort = "";
    while (Date.now() < evalServerDeadline) {
      try { evalServerPort = readFileSync(evalServerPortFile, "utf8").trim(); } catch { /* not ready */ }
      if (/^[1-9]\d{0,4}$/.test(evalServerPort) && Number(evalServerPort) <= 65535) break;
      Atomics.wait(waitState, 0, 0, 10);
    }
    assert.match(evalServerPort, /^[1-9]\d{0,4}$/, "loopback eval fixture did not publish a port");
    evalResult = spawnSync(process.execPath, [
      fileURLToPath(new URL("../eval/run.mjs", import.meta.url)),
      "--base", `http://127.0.0.1:${evalServerPort}`,
      "--golden", evalGoldenPath,
      "--no-think",
    ], {
      encoding: "utf8",
      env: evalEnvironment,
      input: evalInput,
      timeout: 15_000,
      windowsHide: true,
    });
  } finally {
    evalInput.fill(0);
    evalServer.kill("SIGTERM");
  }
  assert.equal(evalResult.status, 0, `${evalResult.stdout}\n${evalResult.stderr}`);
  assert.doesNotMatch(`${evalResult.stdout}${evalResult.stderr}`, new RegExp(replacementKey));

  /* ---------------- Keychain success, metadata privacy, and rollback */
  const locator = {
    ...parseAdminKeySecretReference("keychain://fixture-brain-admin/owner"),
    platform: "darwin",
  };
  const keychain = fakeKeychain({ initial: priorKey });
  const keychainReceipt = writeAdminKeyToKeychain(locator, replacementKey, {
    runChild: keychain.runChild,
    environment: {
      HOME: "/Users/fixture",
      ADMIN_KEY: replacementKey,
      CLOUDFLARE_API_TOKEN: "deployment-secret",
    },
  });
  assert.equal(keychainReceipt.replaced, true);
  assert.equal(keychain.stored, replacementKey);
  const writeCall = keychain.calls.find((call) => call.command.endsWith("/expect"));
  assert.ok(writeCall.args[0].replaceAll("\\", "/").endsWith("/connectors/keychain-write.exp"));
  assert.equal(writeCall.args.at(-1), "-w");
  assert.equal(writeCall.input.toString("utf8"), `${replacementKey}\n`);
  for (const call of keychain.calls) {
    assert.equal(call.args.join("\0").includes(replacementKey), false);
    assert.equal(JSON.stringify(call.env).includes(replacementKey), false);
    assert.equal(call.env.ADMIN_KEY, undefined);
    assert.equal(call.env.CLOUDFLARE_API_TOKEN, undefined);
  }

  const rollback = fakeKeychain({ initial: priorKey, corruptFirstVerification: true });
  let rollbackError;
  try {
    writeAdminKeyToKeychain(locator, replacementKey, { runChild: rollback.runChild });
  } catch (error) {
    rollbackError = error;
  }
  assert.ok(rollbackError);
  assert.match(rollbackError.message, /prior item was restored/i);
  assert.equal(rollback.stored, priorKey);
  assert.equal(rollbackError.message.includes(replacementKey), false);
  assert.equal(rollbackError.message.includes(priorKey), false);

  const failedRollback = fakeKeychain({
    initial: priorKey,
    corruptFirstVerification: true,
    failRollback: true,
  });
  let failedRollbackError;
  try {
    writeAdminKeyToKeychain(locator, replacementKey, { runChild: failedRollback.runChild });
  } catch (error) {
    failedRollbackError = error;
  }
  assert.ok(failedRollbackError);
  assert.match(failedRollbackError.message, /rollback could not be verified/i);
  assert.equal(failedRollbackError.message.includes(replacementKey), false);

  /* ---------------- cmdSecrets order and adjacent rotation */
  const cliAdjacentDir = join(sandbox, "cli-adjacent");
  mkdirSync(cliAdjacentDir, { mode: 0o700 });
  initGitRepo(cliAdjacentDir);
  const cliAdjacentManifest = writeManifest(cliAdjacentDir, manifest());
  const adjacentEvents = [];
  const adjacentRun = await isolatedRuntime({
    fetchImpl: cloudflareHarness(adjacentEvents),
    env: {
      CLOUDFLARE_API_TOKEN: "fixture-token",
      SUPABASE_URL: "https://fixture.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "unrelated-supabase-fixture",
      ANTHROPIC_API_KEY: "unrelated-anthropic-fixture",
    },
  }, () => cmdSecrets(cliAdjacentManifest, {
    explicitAdminKey: replacementKey,
    assertKeyDirSafe: () => {},
    persistAdminKeyDurably(plan, secret, options) {
      const ignored = new Set(readFileSync(join(cliAdjacentDir, ".gitignore"), "utf8").split(/\r?\n/));
      assert.deepEqual(
        ADMIN_KEY_GITIGNORE_RULES.filter((rule) => !ignored.has(rule)),
        [],
        "the final key plus exact temp and backup basenames are ignored before persistence starts",
      );
      adjacentEvents.push("persist:ADMIN_KEY");
      return persistAdminKeyDurably(plan, secret, options);
    },
  }));
  assert.deepEqual(adjacentEvents, [
    "account",
    "persist:ADMIN_KEY",
    "remote:ADMIN_KEY",
    "remote:RAG_PROXY_KEY",
    "remote:SESSION_SIGNING_KEY",
  ]);
  assert.equal(readAdminKeyFile(join(cliAdjacentDir, ".brain-admin-key")), replacementKey);
  assert.equal(adjacentRun.output.includes(replacementKey), false);

  const cleanupDir = join(sandbox, "provider-secret-cleanup");
  mkdirSync(cleanupDir, { mode: 0o700 });
  const cleanupManifest = writeManifest(cleanupDir, manifest());
  const cleanupEvents = [];
  await isolatedRuntime({
    fetchImpl: cloudflareHarness(cleanupEvents, {
      initialSecrets: [
        "ADMIN_KEY",
        "ANTHROPIC_API_KEY",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "UNRELATED_FIXTURE_SECRET",
      ],
    }),
    env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
  }, () => cmdSecrets(cleanupManifest, {
    explicitAdminKey: replacementKey,
    assertKeyDirSafe: () => {},
  }));
  assert.deepEqual(cleanupEvents, [
    "account",
    "delete:ANTHROPIC_API_KEY",
    "delete:SUPABASE_URL",
    "delete:SUPABASE_SERVICE_ROLE_KEY",
    "remote:ADMIN_KEY",
    "remote:RAG_PROXY_KEY",
    "remote:SESSION_SIGNING_KEY",
  ]);
  assert.equal(
    cleanupEvents.includes("delete:UNRELATED_FIXTURE_SECRET"),
    false,
    "provider cleanup never broadens beyond the manifest-gated provider secret names",
  );

  const supabaseDir = join(sandbox, "explicit-supabase");
  mkdirSync(supabaseDir, { mode: 0o700 });
  const supabaseManifest = manifest();
  supabaseManifest.infrastructure.cloudflare.storage = "supabase";
  const supabaseManifestPath = writeManifest(supabaseDir, supabaseManifest);
  const supabaseEvents = [];
  await isolatedRuntime({
    fetchImpl: cloudflareHarness(supabaseEvents),
    env: {
      CLOUDFLARE_API_TOKEN: "fixture-token",
      SUPABASE_URL: "https://fixture.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "explicit-supabase-fixture",
      ANTHROPIC_API_KEY: "unrelated-anthropic-fixture",
    },
  }, () => cmdSecrets(supabaseManifestPath, {
    explicitAdminKey: replacementKey,
    assertKeyDirSafe: () => {},
  }));
  assert.deepEqual(supabaseEvents, [
    "account",
    "remote:ADMIN_KEY",
    "remote:RAG_PROXY_KEY",
    "remote:SESSION_SIGNING_KEY",
    "remote:SUPABASE_URL",
    "remote:SUPABASE_SERVICE_ROLE_KEY",
  ]);

  const anthropicDir = join(sandbox, "explicit-anthropic");
  mkdirSync(anthropicDir, { mode: 0o700 });
  const anthropicManifest = manifest();
  anthropicManifest.retrieval = { answer_model: "claude-fixture" };
  const anthropicManifestPath = writeManifest(anthropicDir, anthropicManifest);
  const anthropicEvents = [];
  await isolatedRuntime({
    fetchImpl: cloudflareHarness(anthropicEvents),
    env: {
      CLOUDFLARE_API_TOKEN: "fixture-token",
      SUPABASE_URL: "https://unrelated.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "unrelated-supabase-fixture",
      ANTHROPIC_API_KEY: "explicit-anthropic-fixture",
    },
  }, () => cmdSecrets(anthropicManifestPath, {
    explicitAdminKey: replacementKey,
    assertKeyDirSafe: () => {},
  }));
  assert.deepEqual(anthropicEvents, [
    "account",
    "remote:ADMIN_KEY",
    "remote:RAG_PROXY_KEY",
    "remote:SESSION_SIGNING_KEY",
    "remote:ANTHROPIC_API_KEY",
  ]);

  const ignoreFailureEvents = [];
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: cloudflareHarness(ignoreFailureEvents),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
    }, () => cmdSecrets(cliAdjacentManifest, {
      assertKeyDirSafe: () => {},
      gitignoreTheKey() {
        ignoreFailureEvents.push("gitignore");
        throw new Error("fixture .gitignore failure");
      },
      persistAdminKeyDurably() {
        ignoreFailureEvents.push("persist:ADMIN_KEY");
        throw new Error("persistence must not start");
      },
    })),
    /refusing to write the adjacent ADMIN_KEY.*durable key and Worker secret were not changed/i,
  );
  assert.deepEqual(ignoreFailureEvents, ["account", "gitignore"]);

  const trackedRepo = join(sandbox, "tracked-adjacent-key");
  mkdirSync(trackedRepo, { mode: 0o700 });
  initGitRepo(trackedRepo);
  const deepParts = Array.from({ length: 12 }, (_, index) => `level-${index + 1}`);
  const trackedDir = join(trackedRepo, ...deepParts);
  mkdirSync(trackedDir, { recursive: true, mode: 0o700 });
  const trackedManifest = writeManifest(trackedDir, manifest());
  const trackedKeyPath = join(trackedDir, ".brain-admin-key");
  const trackedRelativePath = `${deepParts.join("/")}/.brain-admin-key`;
  writeFileSync(trackedKeyPath, currentKey, { mode: 0o600 });
  const trackedAdd = spawnSync("git", ["add", "-f", trackedRelativePath], {
    cwd: trackedRepo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || tmpdir(),
      TMPDIR: process.env.TMPDIR || tmpdir(),
    },
  });
  assert.equal(trackedAdd.status, 0, trackedAdd.stderr || "git add failed");
  const trackedEvents = [];
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: cloudflareHarness(trackedEvents),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(trackedManifest, {
      explicitAdminKey: replacementKey,
      assertKeyDirSafe: () => {},
    })),
    /durable key and Worker secret were not changed.*already tracked by Git/is,
  );
  assert.deepEqual(trackedEvents, ["account"]);
  assert.equal(readFileSync(trackedKeyPath, "utf8"), currentKey);

  const trackedReuseEvents = [];
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: cloudflareHarness(trackedReuseEvents),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
    }, () => cmdSecrets(trackedManifest, { assertKeyDirSafe: () => {} })),
    /durable key and Worker secret were not changed.*already tracked by Git/is,
  );
  assert.deepEqual(trackedReuseEvents, ["account"]);

  /* ---------------- setup resumes the exact durable desired state */
  const setupReuseDir = join(sandbox, "setup-reuse");
  mkdirSync(setupReuseDir, { mode: 0o700 });
  const setupReuseManifest = writeManifest(setupReuseDir, manifest());
  const setupReusePlan = adminKeyPersistencePlan(setupReuseManifest, manifest(), nativeFileOptions);
  persistAdminKeyDurably(setupReusePlan, replacementKey, nativeFileOptions);
  let generatedForReuse = 0;
  const reusedSetupKey = await prepareSetupAdminKey(setupReuseManifest, manifest(), {
    explicitAdminKey: null,
    persistenceOptions: nativeFileOptions,
    randomBytes() {
      generatedForReuse++;
      return Buffer.alloc(24, 0xaa);
    },
  });
  assert.equal(reusedSetupKey.source, "durable");
  assert.equal(reusedSetupKey.value, replacementKey);
  assert.equal(generatedForReuse, 0, "a durable desired key must never be replaced by setup randomness");
  const priorSetupEnvironmentKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = currentKey;
  try {
    assert.equal(resolveAdminKey(setupReuseManifest), currentKey);
    assert.equal(
      resolveAdminKey(setupReuseManifest, { ignoreEnvironment: true }),
      replacementKey,
      "setup health can prove durable state instead of succeeding on a transient shell key",
    );
  } finally {
    if (priorSetupEnvironmentKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = priorSetupEnvironmentKey;
  }

  const setupMissingDir = join(sandbox, "setup-missing");
  mkdirSync(setupMissingDir, { mode: 0o700 });
  const setupMissingManifest = writeManifest(setupMissingDir, manifest());
  const randomMaterial = Buffer.alloc(24, 0x7c);
  const generatedSetupKey = await prepareSetupAdminKey(setupMissingManifest, manifest(), {
    explicitAdminKey: null,
    randomBytes(size) {
      assert.equal(size, 24);
      return randomMaterial;
    },
  });
  assert.equal(generatedSetupKey.source, "generated");
  assert.equal(generatedSetupKey.value, "7c".repeat(24));
  assert.equal(existsSync(join(setupMissingDir, ".brain-admin-key")), false);
  assert.equal(randomMaterial.every((byte) => byte === 0), true, "temporary random bytes are wiped");

  /* ---------------- native standard storage selection */
  const standardMacDir = join(sandbox, "standard-mac-storage");
  mkdirSync(standardMacDir, { mode: 0o700 });
  const standardMacValue = manifest({ admin_key_secret: null });
  standardMacValue.infrastructure.cloudflare.account_id = "d".repeat(32);
  const standardMacManifest = writeManifest(standardMacDir, standardMacValue);
  const expectedMacReference = standardMacAdminKeyReference(standardMacManifest, standardMacValue);
  assert.match(expectedMacReference, /^keychain:\/\/fixture-brain-admin\/owner-[0-9a-f]{32}$/);
  const standardMacStorage = configureStandardAdminKeyStorage(
    standardMacManifest,
    standardMacValue,
    { platform: "darwin" },
  );
  assert.equal(standardMacStorage.changed, true);
  assert.equal(standardMacStorage.reference, expectedMacReference);
  assert.equal(
    JSON.parse(readFileSync(standardMacManifest, "utf8")).operations.admin_key_secret,
    expectedMacReference,
  );
  assert.equal(existsSync(join(standardMacDir, ".brain-admin-key")), false);
  assert.equal(
    configureStandardAdminKeyStorage(standardMacManifest, standardMacValue, { platform: "darwin" }).changed,
    false,
    "a declared standard locator is stable on resume",
  );

  const legacyMacDir = join(sandbox, "legacy-mac-storage");
  mkdirSync(legacyMacDir, { mode: 0o700 });
  const legacyMacValue = manifest({ admin_key_secret: null });
  const legacyMacManifest = writeManifest(legacyMacDir, legacyMacValue);
  writeFileSync(join(legacyMacDir, ".brain-admin-key"), `${priorKey}\n`, { mode: 0o600 });
  const legacyMacStorage = configureStandardAdminKeyStorage(
    legacyMacManifest,
    legacyMacValue,
    { platform: "darwin" },
  );
  assert.equal(legacyMacStorage.changed, false);
  assert.equal(legacyMacStorage.legacyAdjacent, true);
  assert.equal(legacyMacValue.operations.admin_key_secret, null);

  const linuxStandardValue = manifest({ admin_key_secret: null });
  const linuxStandardDir = join(sandbox, "standard-linux-storage");
  mkdirSync(linuxStandardDir, { mode: 0o700 });
  const linuxStandardManifest = writeManifest(linuxStandardDir, linuxStandardValue);
  assert.equal(
    configureStandardAdminKeyStorage(linuxStandardManifest, linuxStandardValue, { platform: "linux" }).changed,
    false,
  );
  assert.equal(linuxStandardValue.operations.admin_key_secret, null);

  const orphanSetupDir = join(sandbox, "setup-orphan-backup");
  mkdirSync(orphanSetupDir, { mode: 0o700 });
  const orphanSetupManifest = writeManifest(orphanSetupDir, manifest());
  const orphanSetupBackup = join(
    orphanSetupDir, "..brain-admin-key.505.5555555555555555.bak",
  );
  writeFileSync(orphanSetupBackup, `${currentKey}\n`, { mode: 0o600 });
  const orphanSetupEvents = [];
  let orphanSetupGenerations = 0;
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: async () => {
        orphanSetupEvents.push("fetch");
        throw new Error("remote fetch");
      },
      env: {},
    }, () => cmdSetup(orphanSetupManifest, {
      doctorRunAll: async () => [],
      cmdVerify: async () => { orphanSetupEvents.push("verify"); },
      cmdProvision: async () => { orphanSetupEvents.push("provision"); },
      cmdMigrate: async () => { orphanSetupEvents.push("migrate"); },
      cmdDeploy: async () => { orphanSetupEvents.push("deploy"); },
      randomBytes() {
        orphanSetupGenerations++;
        return Buffer.alloc(24, 0x5a);
      },
    })),
    /setup could not verify the declared durable ADMIN_KEY storage.*No Cloudflare changes were made/i,
  );
  assert.equal(orphanSetupGenerations, 0, "an orphan rollback backup blocks key generation");
  assert.deepEqual(orphanSetupEvents, [], "an orphan rollback backup blocks every remote mutation");
  assert.equal(readFileSync(orphanSetupBackup, "utf8"), `${currentKey}\n`);

  const setupKeychain = await prepareSetupAdminKey(setupReuseManifest, manifest({
    admin_key_secret: "keychain://fixture-brain-admin/owner",
  }), {
    platform: "darwin",
    explicitAdminKey: null,
    adminKeyPersistencePlan() {
      return Object.freeze({
        backend: "keychain",
        service: "fixture-brain-admin",
        account: "owner",
        platform: "darwin",
      });
    },
    readAdminKeyDurably(plan) {
      assert.equal(plan.backend, "keychain");
      return priorKey;
    },
    randomBytes() {
      throw new Error("Keychain desired state must be reused");
    },
  });
  assert.equal(setupKeychain.source, "durable");
  assert.equal(setupKeychain.value, priorKey);

  const unreadableSetupDir = join(sandbox, "setup-unreadable");
  mkdirSync(unreadableSetupDir, { mode: 0o700 });
  const unreadableSetupManifest = writeManifest(unreadableSetupDir, manifest());
  const unreadableKeyPath = join(unreadableSetupDir, ".brain-admin-key");
  writeFileSync(unreadableKeyPath, "malformed-key");
  chmodSync(unreadableKeyPath, 0o600);
  const forbiddenRemoteEvents = [];
  const forbidRemote = async (name) => {
    forbiddenRemoteEvents.push(name);
    throw new Error(`remote mutation ${name}`);
  };
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: async () => {
        forbiddenRemoteEvents.push("fetch");
        throw new Error("remote fetch");
      },
      env: {},
    }, () => cmdSetup(unreadableSetupManifest, {
      doctorRunAll: async () => [],
      cmdVerify: () => forbidRemote("verify"),
      cmdProvision: () => forbidRemote("provision"),
      cmdMigrate: () => forbidRemote("migrate"),
      cmdDeploy: () => forbidRemote("deploy"),
      randomBytes() {
        throw new Error("unreadable durable state must not generate a replacement");
      },
    })),
    /durable ADMIN_KEY exists but could not be read and verified.*No Cloudflare changes were made/i,
  );
  assert.deepEqual(forbiddenRemoteEvents, []);

  const invalidExplicitEvents = [];
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: async () => {
        invalidExplicitEvents.push("fetch");
        throw new Error("remote fetch");
      },
      env: { ADMIN_KEY: `${"a".repeat(30)}-not-ascii-密` },
    }, () => cmdSetup(setupMissingManifest, {
      doctorRunAll: async () => [],
      cmdVerify: () => {
        invalidExplicitEvents.push("verify");
        throw new Error("remote mutation");
      },
    })),
    /ADMIN_KEY in this shell is not a valid HTTP-header-safe key.*No Cloudflare changes were made/i,
  );
  assert.deepEqual(invalidExplicitEvents, []);

  /* An unsafe existing destination stops before the ADMIN_KEY PUT. */
  if (process.platform !== "win32") {
    const unsafeDir = join(sandbox, "unsafe");
    mkdirSync(unsafeDir, { mode: 0o700 });
    const unsafeManifest = writeManifest(unsafeDir, manifest());
    symlinkSync(join(unsafeDir, "target"), join(unsafeDir, ".brain-admin-key"));
    const unsafeEvents = [];
    await assert.rejects(
      isolatedRuntime({
        fetchImpl: cloudflareHarness(unsafeEvents),
        env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
      }, () => cmdSecrets(unsafeManifest, { assertKeyDirSafe: () => {} })),
      /preflight failed.*regular file/is,
    );
    assert.deepEqual(unsafeEvents, []);

    const linkedIgnoreDir = join(sandbox, "linked-gitignore");
    mkdirSync(linkedIgnoreDir, { mode: 0o700 });
    initGitRepo(linkedIgnoreDir);
    const linkedIgnoreManifest = writeManifest(linkedIgnoreDir, manifest());
    const outsideIgnore = join(sandbox, "outside-ignore-target");
    const outsideIgnoreBytes = "outside file must not be changed\n";
    writeFileSync(outsideIgnore, outsideIgnoreBytes, { mode: 0o600 });
    symlinkSync(outsideIgnore, join(linkedIgnoreDir, ".gitignore"));
    const linkedIgnoreEvents = [];
    await assert.rejects(
      isolatedRuntime({
        fetchImpl: cloudflareHarness(linkedIgnoreEvents),
        env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
      }, () => cmdSecrets(linkedIgnoreManifest, { assertKeyDirSafe: () => {} })),
      /refusing to write the adjacent ADMIN_KEY because Git safety could not be verified/i,
    );
    assert.deepEqual(linkedIgnoreEvents, ["account"]);
    assert.equal(readFileSync(outsideIgnore, "utf8"), outsideIgnoreBytes);
    assert.equal(existsSync(join(linkedIgnoreDir, ".brain-admin-key")), false);
  }

  /* ---------------- cmdSecrets Keychain success without adjacent duplicate */
  const cliKeychainDir = join(sandbox, "cli-keychain");
  mkdirSync(cliKeychainDir, { mode: 0o700 });
  const cliKeychainManifest = writeManifest(
    cliKeychainDir,
    manifest({ admin_key_secret: "keychain://fixture-brain-admin/owner" }),
  );
  const cliKeychain = fakeKeychain({ initial: priorKey });
  assert.equal(resolveAdminKey(cliKeychainManifest, {
    platform: "darwin",
    runChild: cliKeychain.runChild,
    environment: { HOME: "/Users/fixture" },
  }), priorKey, "an ingest child can resolve its manifest-declared Keychain item itself");
  const keychainEvents = [];
  const keychainRun = await isolatedRuntime({
    fetchImpl: cloudflareHarness(keychainEvents),
    env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
  }, () => cmdSecrets(cliKeychainManifest, {
    platform: "darwin",
    persistenceOptions: { runChild: cliKeychain.runChild, environment: { ADMIN_KEY: replacementKey } },
  }));
  assert.deepEqual(keychainEvents, ["account", "remote:ADMIN_KEY", "remote:RAG_PROXY_KEY", "remote:SESSION_SIGNING_KEY"]);
  assert.equal(cliKeychain.stored, replacementKey);
  assert.equal(existsSync(join(cliKeychainDir, ".brain-admin-key")), false);
  assert.equal(keychainRun.output.includes(replacementKey), false);

  /* ---------------- local failure leaves remote untouched */
  const failedEvents = [];
  let localFailure;
  try {
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(failedEvents),
      env: {
        CLOUDFLARE_API_TOKEN: "fixture-token",
        ADMIN_KEY: replacementKey,
        SUPABASE_URL: "https://fixture.invalid",
      },
    }, () => cmdSecrets(cliKeychainManifest, {
      platform: "darwin",
      persistAdminKeyDurably() {
        failedEvents.push("persist:ADMIN_KEY");
        throw new Error(`simulated local failure ${replacementKey}`);
      },
    }));
  } catch (error) {
    localFailure = error;
  }
  assert.ok(localFailure);
  assert.deepEqual(failedEvents, ["account", "persist:ADMIN_KEY"]);
  assert.match(localFailure.message, /was not changed on the remote Worker/i);
  assert.match(localFailure.message, /rerun `brain secrets <manifest>`/i);
  assert.equal(localFailure.message.includes(replacementKey), false);
  assert.equal(localFailure.capturedOutput.includes(replacementKey), false);
  assert.doesNotMatch(localFailure.capturedOutput, /secret ADMIN_KEY set/i);

  /* ---------------- remote failure keeps durable desired state for retry */
  const retryDir = join(sandbox, "retry");
  mkdirSync(retryDir, { mode: 0o700 });
  initGitRepo(retryDir);
  const retryManifest = writeManifest(retryDir, manifest());
  const firstEvents = [];
  let remoteFailure;
  try {
    await isolatedRuntime({
      fetchImpl: cloudflareHarness(firstEvents, { failAdminOnce: true }),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: replacementKey },
    }, () => cmdSecrets(retryManifest, { assertKeyDirSafe: () => {} }));
  } catch (error) {
    remoteFailure = error;
  }
  assert.ok(remoteFailure);
  assert.deepEqual(
    firstEvents,
    ["account", "remote:ADMIN_KEY"],
    "a failed ADMIN_KEY PUT dies before the derived proxy key is attempted",
  );
  assert.equal(readAdminKeyFile(join(retryDir, ".brain-admin-key")), replacementKey);
  assert.match(
    readFileSync(join(retryDir, ".gitignore"), "utf8"),
    /^\.brain-admin-key$/m,
    "a retained desired-state file is ignored even when its first remote PUT fails",
  );
  assert.match(remoteFailure.message, /durable value was kept as desired state/i);
  assert.match(remoteFailure.message, /no credential re-entry is needed/i);
  assert.equal(remoteFailure.message.includes(replacementKey), false);

  const retryEvents = [];
  const retryRun = await isolatedRuntime({
    fetchImpl: cloudflareHarness(retryEvents),
    env: { CLOUDFLARE_API_TOKEN: "fixture-token" },
  }, () => cmdSecrets(retryManifest, {
    assertKeyDirSafe: () => {},
    persistAdminKeyDurably() {
      throw new Error("a no-env retry must not rewrite durable desired state");
    },
  }));
  assert.deepEqual(retryEvents, ["account", "remote:ADMIN_KEY", "remote:RAG_PROXY_KEY", "remote:SESSION_SIGNING_KEY"]);
  assert.equal(retryRun.output.includes(replacementKey), false);

  /* Account resolution is read-only and occurs before local desired state changes. */
  const accountFailureEvents = [];
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: cloudflareHarness(accountFailureEvents, { failAccount: true }),
      env: { CLOUDFLARE_API_TOKEN: "fixture-token", ADMIN_KEY: currentKey },
    }, () => cmdSecrets(retryManifest, { assertKeyDirSafe: () => {} })),
    /fixture account denial/i,
  );
  assert.deepEqual(accountFailureEvents, ["account"]);
  assert.equal(readAdminKeyFile(join(retryDir, ".brain-admin-key")), replacementKey);

  /* A complete standard setup reaches the truthful final receipt offline. */
  const successfulSetupEvents = [];
  let successfulSetupKeyCommitted = false;
  const successfulSetup = await isolatedRuntime({
    fetchImpl: async () => {
      throw new Error("successful setup fixture must remain offline");
    },
    env: {},
  }, () => cmdSetup(setupReuseManifest, {
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async () => false,
    rememberInstalledManifest: () => ({}),
    prepareSetupAdminKey: async () => ({
      source: "durable",
      value: replacementKey,
      plan: setupReusePlan,
    }),
    cmdVerify: async () => { successfulSetupEvents.push("verify"); },
    cmdProvision: async () => { successfulSetupEvents.push("provision"); },
    cmdMigrate: async () => { successfulSetupEvents.push("migrate"); },
    cmdDeploy: async () => { successfulSetupEvents.push("deploy"); },
    cmdSecrets: async (_path, options) => {
      successfulSetupEvents.push("secrets");
      assert.equal(options.reconcileExistingAgents, false);
      assert.equal(options.explicitAdminKey, replacementKey);
      successfulSetupKeyCommitted = true;
    },
    cmdDrain: async (path) => {
      assert.equal(path, setupReuseManifest);
      assert.equal(successfulSetupKeyCommitted, true, "setup must persist its key before authenticated drain");
      assert.equal(process.env.ADMIN_KEY, undefined);
      successfulSetupEvents.push("drain");
    },
    cmdHealth: async (_path, options) => {
      successfulSetupEvents.push("health");
      assert.equal(options.durableAdminKeyOnly, true);
    },
    wireAgents: async (_manifest, _path, options) => {
      successfulSetupEvents.push("wire");
      assert.equal(options.existingOnly, false);
      return { wired: ["Codex"], failures: [], skipped: ["Claude Code"] };
    },
    ask: async (question, fallback) => {
      successfulSetupEvents.push("prompt");
      assert.match(question, /folder to load/i);
      assert.equal(fallback, "");
      return "";
    },
    backlogCount: async () => {
      successfulSetupEvents.push("backlog");
      return 0;
    },
  }));
  assert.deepEqual(successfulSetupEvents, [
    "verify", "provision", "migrate", "deploy", "secrets", "drain", "health", "wire", "prompt", "backlog",
  ]);
  assert.match(successfulSetup.output, /Step 6 of 6[\s\S]*Core installation is ready\. No source has been loaded yet/i);
  assert.match(successfulSetup.output, /technician .*--run smoke/i);
  assert.doesNotMatch(successfulSetup.output, /Your brain is live|ask a question about your own material/i);
  assert.match(successfulSetup.output, /connected to: Codex/i);
  assert.equal(successfulSetup.output.includes(replacementKey), false);
  assert.equal(successfulSetup.output.includes(currentKey), false);

  /* Setup has one full reconciliation owner and stops before source ingest. */
  const setupWiringEvents = [];
  let setupWiringKeyCommitted = false;
  let setupWiringFailure;
  try {
    await isolatedRuntime({
      fetchImpl: async () => {
        throw new Error("setup wiring fixture must remain offline");
      },
      env: {},
    }, () => cmdSetup(setupReuseManifest, {
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => false,
      prepareSetupAdminKey: async () => ({
        source: "durable",
        value: replacementKey,
        plan: setupReusePlan,
      }),
      cmdVerify: async () => {
        assert.equal(process.env.ADMIN_KEY, undefined);
        setupWiringEvents.push("verify");
      },
      cmdProvision: async () => {
        assert.equal(process.env.ADMIN_KEY, undefined);
        setupWiringEvents.push("provision");
      },
      cmdMigrate: async () => {
        assert.equal(process.env.ADMIN_KEY, undefined);
        setupWiringEvents.push("migrate");
      },
      cmdDeploy: async () => {
        assert.equal(process.env.ADMIN_KEY, undefined);
        setupWiringEvents.push("deploy");
      },
      cmdSecrets: async (_path, options) => {
        setupWiringEvents.push("secrets");
        assert.equal(options.reconcileExistingAgents, false);
        assert.equal(options.explicitAdminKey, replacementKey);
        assert.equal(process.env.ADMIN_KEY, undefined);
        setupWiringKeyCommitted = true;
      },
      cmdDrain: async (path) => {
        setupWiringEvents.push("drain");
        assert.equal(path, setupReuseManifest);
        assert.equal(setupWiringKeyCommitted, true, "setup must persist its key before authenticated drain");
        assert.equal(process.env.ADMIN_KEY, undefined);
      },
      cmdHealth: async (_path, options) => {
        setupWiringEvents.push("health");
        assert.equal(options.durableAdminKeyOnly, true);
        assert.equal(process.env.ADMIN_KEY, undefined);
      },
      wireAgents: async (_manifest, _path, options) => {
        setupWiringEvents.push("wire");
        assert.equal(options.existingOnly, false);
        return { wired: [], failures: ["Codex"], skipped: [] };
      },
    }));
  } catch (error) {
    setupWiringFailure = error;
  }
  assert.ok(setupWiringFailure);
  assert.match(setupWiringFailure.message, /could not verify the AI tool registration exactly/i);
  assert.deepEqual(setupWiringEvents, [
    "verify", "provision", "migrate", "deploy", "secrets", "drain", "health", "wire",
  ]);
  assert.doesNotMatch(setupWiringFailure.capturedOutput, /Step 6 of 6|loading something in/i);

  /* A standard Mac setup saves its locator before preparing or generating a key. */
  const standardSetupDir = join(sandbox, "standard-mac-setup");
  mkdirSync(standardSetupDir, { mode: 0o700 });
  const standardSetupValue = manifest({ admin_key_secret: null });
  standardSetupValue.infrastructure.cloudflare.account_id = "e".repeat(32);
  const standardSetupManifest = writeManifest(standardSetupDir, standardSetupValue);
  let standardSetupKeyCommitted = false;
  let standardSetupFailure;
  try {
    await isolatedRuntime({
      fetchImpl: async () => { throw new Error("standard setup fixture must remain offline"); },
      env: {},
    }, () => cmdSetup(standardSetupManifest, {
      platform: "darwin",
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => false,
      prepareSetupAdminKey: async (_path, preparedManifest) => {
        const saved = JSON.parse(readFileSync(standardSetupManifest, "utf8"));
        assert.match(preparedManifest.operations.admin_key_secret, /^keychain:\/\//);
        assert.equal(saved.operations.admin_key_secret, preparedManifest.operations.admin_key_secret);
        assert.equal(existsSync(join(standardSetupDir, ".brain-admin-key")), false);
        return {
          source: "generated",
          value: replacementKey,
          plan: { backend: "keychain" },
        };
      },
      cmdVerify: async () => {},
      cmdProvision: async () => {},
      cmdMigrate: async () => {},
      cmdDeploy: async () => {},
      cmdSecrets: async (_path, options) => {
        assert.equal(options.explicitAdminKey, replacementKey);
        assert.equal(process.env.ADMIN_KEY, undefined);
        standardSetupKeyCommitted = true;
      },
      cmdDrain: async (path) => {
        assert.equal(path, standardSetupManifest);
        assert.equal(standardSetupKeyCommitted, true, "setup must persist its key before authenticated drain");
        assert.equal(process.env.ADMIN_KEY, undefined);
      },
      cmdHealth: async (_path, options) => {
        assert.equal(options.durableAdminKeyOnly, true);
      },
      wireAgents: async () => ({ wired: [], failures: ["fixture"], skipped: [] }),
    }));
  } catch (error) {
    standardSetupFailure = error;
  }
  assert.ok(standardSetupFailure);
  assert.match(standardSetupFailure.message, /could not verify the AI tool registration exactly/i);
  assert.match(
    JSON.parse(readFileSync(standardSetupManifest, "utf8")).operations.admin_key_secret,
    /^keychain:\/\/fixture-brain-admin\/owner-e{32}$/,
  );
  assert.equal(existsSync(join(standardSetupDir, ".brain-admin-key")), false);

  /* Setup never consumes or clears an ADMIN_KEY the user exported. */
  let explicitSetupFailure;
  let explicitSetupKeyCommitted = false;
  try {
    await isolatedRuntime({
      fetchImpl: async () => {
        throw new Error("explicit setup fixture must remain offline");
      },
      env: { ADMIN_KEY: currentKey },
    }, async () => {
      try {
        await cmdSetup(setupReuseManifest, {
          doctorRunAll: async () => [],
          setupWorkerScriptExists: async () => false,
          prepareSetupAdminKey: async () => ({
            source: "environment",
            value: currentKey,
            plan: setupReusePlan,
          }),
          cmdVerify: async () => { assert.equal(process.env.ADMIN_KEY, currentKey); },
          cmdProvision: async () => { assert.equal(process.env.ADMIN_KEY, currentKey); },
          cmdMigrate: async () => { assert.equal(process.env.ADMIN_KEY, currentKey); },
          cmdDeploy: async () => { assert.equal(process.env.ADMIN_KEY, currentKey); },
          cmdSecrets: async (_path, options) => {
            assert.equal(process.env.ADMIN_KEY, currentKey);
            assert.equal(options.explicitAdminKey, currentKey);
            explicitSetupKeyCommitted = true;
          },
          cmdDrain: async (path) => {
            assert.equal(path, setupReuseManifest);
            assert.equal(explicitSetupKeyCommitted, true, "setup must set the Worker key before authenticated drain");
            assert.equal(process.env.ADMIN_KEY, currentKey);
          },
          cmdHealth: async (_path, options) => {
            assert.equal(process.env.ADMIN_KEY, currentKey);
            assert.equal(options.durableAdminKeyOnly, true);
          },
          wireAgents: async () => ({ wired: [], failures: ["fixture"], skipped: [] }),
        });
      } catch (error) {
        assert.equal(process.env.ADMIN_KEY, currentKey);
        throw error;
      }
    });
  } catch (error) {
    explicitSetupFailure = error;
  }
  assert.ok(explicitSetupFailure);
  assert.match(explicitSetupFailure.message, /could not verify the AI tool registration exactly/i);

  console.log("admin key durable rotation: all focused offline tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
