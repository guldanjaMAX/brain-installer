import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  agentCliEnvironment,
  cmdMcpConfig,
  cmdSecrets,
  mcpRegistrationDescriptor,
  mcpRegistrationIsExact,
  mcpRegistrationIsInstallerOwned,
  verifyMcpRuntime,
  wireAgents,
} from "../brain.mjs";
import {
  createBrainCredentialResolver,
  fetchWithBrainCredential,
} from "../components/brain-mcp-runtime.mjs";
import {
  adminKeyPersistencePlan,
  persistAdminKeyDurably,
} from "../operations/admin-key-persistence.mjs";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-mcp-rotation-")));
const currentKey = `current-${"a".repeat(40)}`;
const replacementKey = `replacement-${"b".repeat(40)}`;
const retiredKey = `retired-${"c".repeat(40)}`;
const nativeFileOptions = process.platform === "win32"
  ? { username: process.env.USERNAME || process.env.USER }
  : {};
const windowsRuntimeBasics = {
  SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  USERDOMAIN: process.env.USERDOMAIN,
  ComSpec: process.env.ComSpec,
};

function fixtureManifest(operations = { admin_key_secret: null }) {
  const value = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  value.client = { slug: "fixture-brain", display_name: "Fixture Brain", timezone: "UTC" };
  value.brain = { ...value.brain, domain: "fixture.invalid", worker_name: "fixture-brain" };
  value.infrastructure.cloudflare.account_id = "0".repeat(32);
  value.operations = { ...value.operations, ...operations };
  return value;
}

function writeManifest(directory, value = fixtureManifest()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "brain manifest ü.json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function persistFixtureKey(manifestPath, manifest, value) {
  const plan = adminKeyPersistencePlan(manifestPath, manifest, nativeFileOptions);
  persistAdminKeyDurably(plan, value, nativeFileOptions);
  return plan;
}

function legacyEntry(desired, key = retiredKey) {
  return {
    type: "stdio",
    command: desired.command,
    args: [...desired.args],
    env: {
      BRAIN_URL: desired.env.BRAIN_URL,
      BRAIN_NAME: desired.env.BRAIN_NAME,
      BRAIN_KEY: key,
    },
  };
}

function codexEntry(desired, env = desired.env) {
  return {
    name: desired.name,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: desired.command,
      args: [...desired.args],
      env: { ...env },
      env_vars: [],
      cwd: null,
    },
  };
}

function readClaudeConfig(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeClaudeEntry(path, name, entry) {
  const config = readClaudeConfig(path);
  const servers = { ...(config.mcpServers || {}) };
  if (entry === null) delete servers[name];
  else servers[name] = entry;
  writeFileSync(path, JSON.stringify({ ...config, mcpServers: servers }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeCodexEntry(path, entry) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!entry) {
    writeFileSync(path, "", { mode: 0o600 });
    return;
  }
  const value = entry.transport || entry;
  const lines = [
    `[mcp_servers.${entry.name}]`,
    `command = ${JSON.stringify(value.command)}`,
    `args = ${JSON.stringify(value.args || [])}`,
  ];
  if (entry.enabled === false) lines.push("enabled = false");
  if (value.cwd !== undefined && value.cwd !== null) lines.push(`cwd = ${JSON.stringify(value.cwd)}`);
  if (Array.isArray(value.env_vars) && value.env_vars.length) {
    lines.push(`env_vars = ${JSON.stringify(value.env_vars)}`);
  }
  lines.push("", `[mcp_servers.${entry.name}.env]`);
  for (const [key, valueEntry] of Object.entries(value.env || {})) {
    lines.push(`${key} = ${JSON.stringify(valueEntry)}`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function registrationFromArgs(args, envFlag) {
  const separator = args.indexOf("--");
  const env = {};
  for (let i = 0; i < separator; i++) {
    if (args[i] !== envFlag) continue;
    const assignment = String(args[++i]);
    const equals = assignment.indexOf("=");
    env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  return {
    type: "stdio",
    command: args[separator + 1],
    args: args.slice(separator + 2),
    env,
  };
}

function fakeAgentCli({
  environment,
  claudeConfigPath,
  claudeInstalled = true,
  codexInstalled = true,
  codexInitial = null,
  failClaudeAdds = false,
  mismatchClaudeAdds = false,
  failCodexAdd = false,
  mismatchCodexAdd = false,
} = {}) {
  let codex = codexInitial;
  const codexConfigPath = join(
    environment.CODEX_HOME || join(environment.HOME || environment.USERPROFILE, ".codex"),
    "config.toml",
  );
  writeCodexEntry(codexConfigPath, codex);
  const calls = [];
  const safeEnvironment = agentCliEnvironment(environment);
  const result = (ok, stdout = "", stderr = "") => ({
    ok,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
    missing: false,
  });

  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options: { ...options, env: { ...(options.env || {}) } } });
    assert.equal(options.inheritEnv, false, "agent children inherit no ambient environment");
    assert.deepEqual(options.env, safeEnvironment, "agent children receive only the explicit allowlist");
    const metadata = JSON.stringify([args, options.env]);
    for (const secret of [currentKey, replacementKey, retiredKey, "aws-fixture-secret", "openai-fixture-secret"]) {
      assert.equal(metadata.includes(secret), false, "agent child metadata contains no credential value");
    }
    assert.doesNotMatch(metadata, /BRAIN_KEY=|ADMIN_KEY=/, "agent argv contains no literal key assignment");

    if (args[0] === "--version") {
      const installed = command === "claude" ? claudeInstalled : codexInstalled;
      return installed ? result(true, `${command} fixture\n`) : result(false, "", "not installed\n");
    }

    if (command === "claude") {
      const action = args[1];
      if (action === "remove") {
        const backupDir = join(dirname(claudeConfigPath), ".claude", "backups");
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        copyFileSync(claudeConfigPath, join(backupDir, `.claude.json.backup.${calls.length}`));
        writeClaudeEntry(claudeConfigPath, args.at(-1), null);
        return result(true, "removed\n");
      }
      if (action === "add" || action === "add-json") {
        if (failClaudeAdds) return result(false, "", "fixture add failure\n");
        const name = args[4];
        let entry = action === "add-json"
          ? JSON.parse(args[5])
          : registrationFromArgs(args, "-e");
        if (mismatchClaudeAdds) {
          entry = { ...entry, env: { ...entry.env, BRAIN_URL: "https://wrong.invalid" } };
        }
        writeClaudeEntry(claudeConfigPath, name, entry);
        return result(true, "added\n");
      }
    }

    if (command === "codex") {
      const action = args[1];
      if (action === "get") {
        if (!codex) return result(false, "", "No MCP server named fixture-brain found.\n");
        if (args.includes("--json")) {
          return result(true, JSON.stringify(codex), "fixture warning on stderr\n");
        }
        const value = codex.transport || codex;
        const env = Object.keys(value.env || {}).map((key) => `${key}=*****`).join(", ") || "-";
        return result(true,
          `${codex.name}\n  enabled: ${codex.enabled !== false}\n  transport: stdio\n` +
          `  command: ${value.command}\n  args: ${(value.args || []).join(" ")}\n` +
          `  cwd: ${value.cwd || "-"}\n  env: ${env}\n`,
          "fixture warning on stderr\n",
        );
      }
      if (action === "add") {
        if (failCodexAdd) return result(false, "", "fixture add failure\n");
        const desired = registrationFromArgs(args, "--env");
        const env = mismatchCodexAdd
          ? { ...desired.env, BRAIN_URL: "https://wrong.invalid" }
          : desired.env;
        codex = codexEntry({ name: args[2], ...desired }, env);
        writeCodexEntry(codexConfigPath, codex);
        return result(true, "added\n");
      }
    }
    return result(false, "", "unexpected fixture command\n");
  };

  return { runCommand, calls, get codex() { return codex; } };
}

async function captureOutput(operation) {
  const prior = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    const value = await operation();
    return { value, output: lines.join("\n") };
  } finally {
    console.log = prior;
  }
}

function apiResponse(result) {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

try {
  chmodSync(sandbox, 0o700);
  const installDir = join(sandbox, "install with spaces ü");
  const manifest = fixtureManifest();
  const manifestPath = writeManifest(installDir, manifest);
  const plan = persistFixtureKey(manifestPath, manifest, currentKey);
  const descriptor = mcpRegistrationDescriptor(manifest, manifestPath, {
    baseUrl: "https://fixture.invalid",
  });
  assert.equal(descriptor.command, process.execPath);
  assert.equal(descriptor.env.BRAIN_MANIFEST, resolve(manifestPath));
  assert.deepEqual(Object.keys(descriptor.env).sort(), ["BRAIN_MANIFEST", "BRAIN_NAME", "BRAIN_URL"]);
  assert.equal(mcpRegistrationIsInstallerOwned({
    ...legacyEntry(descriptor),
    command: "node",
  }, descriptor), true, "the old PATH-dependent installer entry remains safely migratable");
  assert.equal(mcpRegistrationIsExact({
    ...codexEntry(descriptor),
    transport: { ...codexEntry(descriptor).transport, env_vars: ["BRAIN_KEY"] },
  }, descriptor), false);
  assert.equal(mcpRegistrationIsExact({
    ...codexEntry(descriptor),
    transport: { ...codexEntry(descriptor).transport, cwd: sandbox },
  }, descriptor), false);
  assert.throws(
    () => mcpRegistrationDescriptor(manifest, `${manifestPath}\nunsafe`, { baseUrl: "https://fixture.invalid" }),
    /control character/i,
  );
  assert.equal(verifyMcpRuntime(descriptor, {
    environment: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: sandbox,
      USERNAME: process.env.USERNAME || process.env.USER || "fixture-user",
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ADMIN_KEY: replacementKey,
      CLOUDFLARE_API_TOKEN: "deployment-secret",
      OPENAI_API_KEY: "openai-fixture-secret",
    },
  }), true, "the exact descriptor completes an offline MCP initialize handshake");

  /* Runtime locator wins over a stale legacy value and refreshes on rejection. */
  const runtimeEnvironment = {
    HOME: sandbox,
    ...(process.platform === "win32"
      ? {
          ...windowsRuntimeBasics,
          USERNAME: nativeFileOptions.username,
        }
      : { USER: "fixture-user" }),
    BRAIN_MANIFEST: manifestPath,
    BRAIN_KEY: retiredKey,
  };
  const runtime = createBrainCredentialResolver({ environment: runtimeEnvironment });
  assert.equal(runtime.get(), currentKey, "BRAIN_MANIFEST is authoritative over a legacy key");
  persistAdminKeyDurably(plan, replacementKey, nativeFileOptions);
  const attempted = [];
  const response = await fetchWithBrainCredential(async (_url, options) => {
    assert.equal(options.redirect, "error", "MCP admin requests refuse redirects");
    const key = new Headers(options.headers).get("X-Admin-Key");
    attempted.push(key);
    return attempted.length === 1
      ? new Response("retired", { status: 401 })
      : new Response("ready", { status: 200 });
  }, "https://fixture.invalid/api/admin/brain/documents", {}, runtime);
  assert.equal(response.status, 200);
  assert.deepEqual(attempted, [currentKey, replacementKey], "401 reloads durable desired state once");
  assert.doesNotMatch(runtime.redact(`${currentKey} ${replacementKey}`), new RegExp(`${currentKey}|${replacementKey}`));

  let insecureReads = 0;
  let insecureRequests = 0;
  const insecureResolver = {
    durable: true,
    get() { insecureReads++; return replacementKey; },
    clear() {},
  };
  await assert.rejects(
    fetchWithBrainCredential(
      async () => { insecureRequests++; return new Response("unexpected"); },
      "http://brain.example.invalid/api/admin/brain/documents",
      {},
      insecureResolver,
    ),
    /HTTPS.*loopback/i,
  );
  assert.equal(insecureReads, 0, "an insecure MCP URL is refused before durable-key access");
  assert.equal(insecureRequests, 0, "an insecure MCP URL is refused before fetch");

  /* Shared Keychain reader is used without secret argv or inherited credentials. */
  const keychainDir = join(sandbox, "keychain runtime");
  const keychainManifest = fixtureManifest({
    admin_key_secret: "keychain://fixture-brain-admin/owner",
  });
  const keychainManifestPath = writeManifest(keychainDir, keychainManifest);
  const keychainCalls = [];
  const keychainRuntime = createBrainCredentialResolver({
    environment: {
      HOME: keychainDir,
      USER: "fixture-user",
      BRAIN_MANIFEST: keychainManifestPath,
      ADMIN_KEY: retiredKey,
      AWS_SECRET_ACCESS_KEY: "aws-fixture-secret",
    },
    platform: "darwin",
    durableOptions: {
      runChild(command, args, options) {
        keychainCalls.push({ command, args: [...args], env: { ...options.env } });
        return { status: 0, stdout: Buffer.from(`${replacementKey}\n`), stderr: Buffer.alloc(0) };
      },
    },
  });
  assert.equal(keychainRuntime.get(), replacementKey);
  assert.equal(keychainCalls.length, 1);
  assert.equal(JSON.stringify(keychainCalls).includes(replacementKey), false);
  assert.equal(keychainCalls[0].env.ADMIN_KEY, undefined);
  assert.equal(keychainCalls[0].env.AWS_SECRET_ACCESS_KEY, undefined);

  /* Simulated Windows locator supplies username and decrypts a DPAPI envelope. */
  const windowsDir = join(sandbox, "windows runtime");
  const windowsManifest = fixtureManifest({ admin_key_secret: null });
  const windowsManifestPath = writeManifest(windowsDir, windowsManifest);
  const cipher = Buffer.from("fixture-dpapi-ciphertext");
  writeFileSync(
    join(windowsDir, ".brain-admin-key"),
    `BRAIN-ADMIN-KEY-DPAPI-V1\n${cipher.toString("base64")}\n`,
    { mode: 0o600 },
  );
  const windowsCalls = [];
  const windowsRuntime = createBrainCredentialResolver({
    environment: {
      BRAIN_MANIFEST: windowsManifestPath,
      ...windowsRuntimeBasics,
      USERNAME: process.platform === "win32" ? nativeFileOptions.username : "fixture-user",
    },
    platform: "win32",
    durableOptions: {
      runPowerShell(command, args, options) {
        windowsCalls.push({ command, args: [...args], input: Buffer.from(options.input) });
        return { status: 0, stdout: Buffer.from(replacementKey), stderr: Buffer.alloc(0) };
      },
    },
  });
  assert.equal(windowsRuntime.get(), replacementKey);
  assert.equal(windowsCalls.length, 1);
  assert.equal(JSON.stringify(windowsCalls.map(({ command, args }) => [command, args])).includes(replacementKey), false);

  if (process.platform === "win32") {
    const nativeDir = join(sandbox, "windows native runtime");
    const nativeManifest = fixtureManifest({ admin_key_secret: null });
    const nativeManifestPath = writeManifest(nativeDir, nativeManifest);
    const nativePlan = adminKeyPersistencePlan(nativeManifestPath, nativeManifest, {
      platform: "win32",
      username: process.env.USERNAME || process.env.USER,
    });
    persistAdminKeyDurably(nativePlan, replacementKey, {
      platform: "win32",
      username: process.env.USERNAME || process.env.USER,
    });
    const nativeRuntime = createBrainCredentialResolver({
      environment: {
        ...process.env,
        BRAIN_MANIFEST: nativeManifestPath,
      },
      platform: "win32",
    });
    assert.equal(nativeRuntime.get(), replacementKey);
  }

  /* Generated manual config is locator-only and prints no key value or field. */
  const manual = await captureOutput(() => cmdMcpConfig(manifestPath));
  assert.match(manual.output, /BRAIN_MANIFEST/);
  assert.match(manual.output, /Claude Desktop remains a manual config update/i);
  assert.doesNotMatch(manual.output, /BRAIN_KEY|ADMIN_KEY/);
  for (const secret of [currentKey, replacementKey, retiredKey]) {
    assert.equal(manual.output.includes(secret), false);
  }

  /* Stale Claude registration is replaced exactly through secret-free CLI args. */
  const claudeHome = join(sandbox, "claude home");
  mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  const claudeConfigPath = join(claudeHome, ".claude.json");
  const unicodeSentinel = "José 🧠 東京";
  writeFileSync(
    claudeConfigPath,
    JSON.stringify({ profile_label: unicodeSentinel }, null, 2) + "\n",
    { mode: 0o600 },
  );
  const otherLegacyKey = `other-retired-${"d".repeat(40)}`;
  const otherDescriptor = {
    ...descriptor,
    name: "other-brain",
    env: {
      ...descriptor.env,
      BRAIN_NAME: "other-brain",
      BRAIN_URL: "https://other.invalid",
    },
  };
  writeClaudeEntry(claudeConfigPath, descriptor.name, legacyEntry(descriptor));
  writeClaudeEntry(
    claudeConfigPath,
    otherDescriptor.name,
    legacyEntry(otherDescriptor, otherLegacyKey),
  );
  const legacyClaudeRaw = readFileSync(claudeConfigPath, "utf8");
  const neutralClaudeRaw = legacyClaudeRaw.replace(
    `"BRAIN_KEY": "${retiredKey}"`,
    `"REDACTED_": "${"x".repeat(retiredKey.length)}"`,
  );
  assert.notEqual(neutralClaudeRaw, legacyClaudeRaw, "fixture locates the exact legacy field");
  const childEnvironment = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: claudeHome,
    ...(process.platform === "win32"
      ? { ...windowsRuntimeBasics, USERNAME: nativeFileOptions.username }
      : { USER: "fixture-user" }),
    LANG: "C",
    ADMIN_KEY: replacementKey,
    BRAIN_KEY: retiredKey,
    CLOUDFLARE_API_TOKEN: "deployment-secret",
    SUPABASE_SERVICE_ROLE_KEY: "supabase-fixture-secret",
    ANTHROPIC_API_KEY: "anthropic-fixture-secret",
    AWS_SECRET_ACCESS_KEY: "aws-fixture-secret",
    OPENAI_API_KEY: "openai-fixture-secret",
  };
  const brokenRuntimeCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    codexInstalled: false,
  });
  const brokenRuntime = await captureOutput(() => wireAgents(manifest, manifestPath, {
    baseUrl: descriptor.env.BRAIN_URL,
    environment: childEnvironment,
    claudeConfigPath,
    runCommand: brokenRuntimeCli.runCommand,
    verifyMcpRuntime: () => false,
  }));
  assert.deepEqual(brokenRuntime.value.failures, ["MCP runtime"]);
  assert.equal(
    brokenRuntimeCli.calls.some((call) => ["add", "add-json", "remove"].includes(call.args[1])),
    false,
    "a failed runtime handshake cannot mutate an existing registration",
  );
  assert.deepEqual(readClaudeConfig(claudeConfigPath).mcpServers[descriptor.name], legacyEntry(descriptor));
  assert.deepEqual(
    readClaudeConfig(claudeConfigPath).mcpServers[otherDescriptor.name],
    legacyEntry(otherDescriptor, otherLegacyKey),
  );
  assert.match(brokenRuntime.output, /did not complete its local initialize handshake/i);

  const claudeCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    codexInstalled: false,
  });
  const claudeWiring = await captureOutput(() => wireAgents(manifest, manifestPath, {
    baseUrl: descriptor.env.BRAIN_URL,
    environment: childEnvironment,
    claudeConfigPath,
    runCommand: claudeCli.runCommand,
    verifyMcpRuntime: () => true,
  }));
  assert.deepEqual(claudeWiring.value.failures, []);
  assert.deepEqual(claudeWiring.value.wired, ["Claude Code"]);
  assert.equal(readClaudeConfig(claudeConfigPath).profile_label, unicodeSentinel);
  const finalClaude = readClaudeConfig(claudeConfigPath).mcpServers[descriptor.name];
  assert.equal(mcpRegistrationIsExact(finalClaude, descriptor), true);
  assert.equal(JSON.stringify(finalClaude).includes("BRAIN_KEY"), false);
  assert.deepEqual(
    readClaudeConfig(claudeConfigPath).mcpServers[otherDescriptor.name],
    legacyEntry(otherDescriptor, otherLegacyKey),
    "another brain's legacy entry is preserved while this brain is migrated",
  );
  assert.equal(claudeCli.calls.some((call) => call.command === "claude" && call.args[1] === "get"), false);
  for (const secret of [currentKey, replacementKey, retiredKey]) {
    assert.equal(claudeWiring.output.includes(secret), false);
    assert.equal(JSON.stringify(claudeCli.calls).includes(secret), false);
  }
  const claudeBackups = readdirSync(join(claudeHome, ".claude", "backups"));
  assert.ok(claudeBackups.length > 0, "fake Claude reproduced its config-backup behavior");
  let exactNeutralBackup = false;
  for (const file of claudeBackups) {
    const backup = readFileSync(join(claudeHome, ".claude", "backups", file), "utf8");
    exactNeutralBackup ||= backup === neutralClaudeRaw;
    assert.equal(backup.includes(retiredKey), false, "new Claude backups contain no retired key");
    const parsedBackup = JSON.parse(backup);
    assert.equal(
      Object.hasOwn(parsedBackup.mcpServers[descriptor.name].env, "BRAIN_KEY"),
      false,
      "new Claude backups contain no retired key field for the migrated brain",
    );
    assert.equal(
      parsedBackup.mcpServers[otherDescriptor.name].env.BRAIN_KEY,
      otherLegacyKey,
      "another brain's entry is unchanged in Claude's backup",
    );
    assert.equal(parsedBackup.profile_label, unicodeSentinel, "Unicode content survives neutralization");
  }
  assert.equal(exactNeutralBackup, true, "neutralization changes only the exact same-length key bytes");

  /* Failed Claude re-add is explicit and leaves no partial or unrelated entry. */
  writeClaudeEntry(claudeConfigPath, descriptor.name, legacyEntry(descriptor));
  const failedClaudeCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    codexInstalled: false,
    failClaudeAdds: true,
  });
  const failedClaude = await captureOutput(() => wireAgents(manifest, manifestPath, {
    baseUrl: descriptor.env.BRAIN_URL,
    environment: childEnvironment,
    claudeConfigPath,
    runCommand: failedClaudeCli.runCommand,
    verifyMcpRuntime: () => true,
  }));
  assert.deepEqual(failedClaude.value.failures, ["Claude Code"]);
  assert.equal(readClaudeConfig(claudeConfigPath).mcpServers[descriptor.name], undefined);
  assert.deepEqual(
    readClaudeConfig(claudeConfigPath).mcpServers[otherDescriptor.name],
    legacyEntry(otherDescriptor, otherLegacyKey),
  );
  assert.match(failedClaude.output, /could not be reconciled safely/i);
  assert.equal(failedClaude.output.includes(retiredKey), false);

  /* Codex add failure cannot pass because a stale name remains listed. */
  const staleCodex = codexEntry(descriptor, legacyEntry(descriptor).env);
  const codexCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    claudeInstalled: false,
    codexInitial: staleCodex,
    failCodexAdd: true,
  });
  const codexWiring = await captureOutput(() => wireAgents(manifest, manifestPath, {
    baseUrl: descriptor.env.BRAIN_URL,
    environment: childEnvironment,
    runCommand: codexCli.runCommand,
    verifyMcpRuntime: () => true,
  }));
  assert.deepEqual(codexWiring.value.wired, []);
  assert.deepEqual(codexWiring.value.failures, ["Codex"]);
  assert.deepEqual(codexCli.codex, staleCodex, "failed Codex add preserves the prior entry");
  assert.equal(codexCli.calls.some((call) => call.args[1] === "list"), false, "name-only list is never trusted");
  assert.equal(codexWiring.output.includes(retiredKey), false);
  assert.equal(
    codexCli.calls.some((call) => call.command === "codex" && call.args.includes("--json")),
    false,
    "a legacy Codex entry is never printed as JSON before a successful replacement",
  );

  /* A successful add with an exact mismatch is also rejected. */
  const mismatchCodexCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    claudeInstalled: false,
    codexInitial: staleCodex,
    mismatchCodexAdd: true,
  });
  const mismatchCodex = await captureOutput(() => wireAgents(manifest, manifestPath, {
    baseUrl: descriptor.env.BRAIN_URL,
    environment: childEnvironment,
    runCommand: mismatchCodexCli.runCommand,
    verifyMcpRuntime: () => true,
  }));
  assert.deepEqual(mismatchCodex.value.failures, ["Codex"]);
  assert.equal(mcpRegistrationIsExact(mismatchCodexCli.codex, descriptor), false);

  /* Same-name entries not owned by this installer are preserved untouched. */
  const unrelatedClaude = {
    type: "stdio",
    command: "node",
    args: [join(sandbox, "someone-else", "brain-mcp.mjs")],
    env: {
      BRAIN_URL: "https://someone-else.invalid",
      BRAIN_NAME: descriptor.name,
      BRAIN_MANIFEST: join(sandbox, "someone-else", "manifest.json"),
    },
  };
  writeClaudeEntry(claudeConfigPath, descriptor.name, unrelatedClaude);
  const unrelatedCodex = codexEntry({
    ...descriptor,
    command: "node",
    args: [join(sandbox, "someone-else", "brain-mcp.mjs")],
  }, unrelatedClaude.env);
  const collisionCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    codexInitial: unrelatedCodex,
  });
  const collisions = await captureOutput(() => wireAgents(manifest, manifestPath, {
    baseUrl: descriptor.env.BRAIN_URL,
    environment: childEnvironment,
    claudeConfigPath,
    runCommand: collisionCli.runCommand,
    verifyMcpRuntime: () => true,
  }));
  assert.deepEqual(collisions.value.failures.sort(), ["Claude Code", "Codex"]);
  assert.deepEqual(readClaudeConfig(claudeConfigPath).mcpServers[descriptor.name], unrelatedClaude);
  assert.deepEqual(collisionCli.codex, unrelatedCodex);
  assert.equal(
    collisionCli.calls.some((call) => ["add", "add-json", "remove"].includes(call.args[1])),
    false,
    "colliding registrations are never mutated",
  );

  /* Existing-only reconciliation never adds an unchosen agent registration. */
  writeClaudeEntry(claudeConfigPath, descriptor.name, null);
  const absentCli = fakeAgentCli({
    environment: childEnvironment,
    claudeConfigPath,
    codexInitial: null,
  });
  const absent = await captureOutput(() => wireAgents(manifest, manifestPath, {
    environment: childEnvironment,
    claudeConfigPath,
    runCommand: absentCli.runCommand,
    existingOnly: true,
    adminKeyPersistencePlan() {
      throw new Error("durable preflight must not run when no chosen registration exists");
    },
  }));
  assert.deepEqual(absent.value.failures, []);
  assert.equal(absentCli.calls.some((call) => ["add", "add-json", "remove"].includes(call.args[1])), false);

  /* Windows-style USERPROFILE never falls back to the process owner's config. */
  const profileHome = join(sandbox, "windows user profile");
  mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  const profileEnvironment = {
    PATH: childEnvironment.PATH,
    USERPROFILE: profileHome,
    USERNAME: "fixture-user",
  };
  const profileCli = fakeAgentCli({
    environment: profileEnvironment,
    claudeConfigPath: join(profileHome, ".claude.json"),
    codexInstalled: false,
  });
  const profileAbsent = await captureOutput(() => wireAgents(manifest, manifestPath, {
    environment: profileEnvironment,
    runCommand: profileCli.runCommand,
    existingOnly: true,
  }));
  assert.deepEqual(profileAbsent.value.failures, []);
  assert.equal(profileCli.calls.some((call) => ["add", "add-json", "remove"].includes(call.args[1])), false);

  /* Standalone secrets invokes existing-only reconciliation only after PUT. */
  const secretsDir = join(sandbox, "standalone secrets");
  const secretsManifest = fixtureManifest();
  const secretsManifestPath = writeManifest(secretsDir, secretsManifest);
  const priorFetch = globalThis.fetch;
  const priorAdminKey = process.env.ADMIN_KEY;
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  const reconciliationCalls = [];
  try {
    process.env.ADMIN_KEY = replacementKey;
    process.env.CLOUDFLARE_API_TOKEN = "fixture-token";
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/client/v4/accounts") {
        return apiResponse([{ id: "0".repeat(32), name: "Fixture" }]);
      }
      if (path.endsWith("/workers/scripts/fixture-brain/secrets") &&
          (options.method || "GET") === "GET") {
        return apiResponse([]);
      }
      if (path.endsWith("/workers/scripts/fixture-brain/secrets") && options.method === "PUT") {
        return apiResponse({});
      }
      throw new Error("unexpected offline request");
    };
    const rotated = await captureOutput(() => cmdSecrets(secretsManifestPath, {
      assertKeyDirSafe: () => {},
      reconcileExistingAgents(_manifest, _path, options) {
        reconciliationCalls.push(options);
        return { wired: [], failures: [], skipped: ["Claude Code", "Codex"] };
      },
    }));
    assert.equal(reconciliationCalls.length, 1);
    assert.equal(reconciliationCalls[0].existingOnly, true);
    assert.equal(rotated.output.includes(replacementKey), false);
    assert.match(rotated.output, /Claude Desktop.*locator-only/is);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = priorAdminKey;
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
  }

  console.log("MCP admin-key rotation: all focused offline tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
