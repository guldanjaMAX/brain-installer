import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cmdConnectProvider, cmdLocalTools, cmdTechnician } from "../brain.mjs";

import {
  TECHNICIAN_RUN_STEPS,
  technicianStatusFilePath,
  runTechnicianStep,
  technicianChildEnvironment,
  technicianPlan,
} from "../operations/technician-setup.mjs";
import {
  CLAUDE_WORKSPACE_MARKER,
  writeClaudeWorkspaceGuide,
} from "../operations/claude-workspace.mjs";
import {
  CLAUDE_TECHNICIAN_SKILL_MARKER,
  installClaudeTechnicianSkill,
} from "../operations/claude-skill.mjs";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "brain-technician-test-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const fixtureScriptPath = resolve("/fixture/brain.mjs");
const fixtureNodePath = resolve("/fixture/node");
const safeBrainPath = resolve("/safe/lib/brain.mjs");
const safeNodePath = resolve("/safe/bin/node");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "fixture" },
  brain: { domain: "brain.fixture.test" },
  corpora: {
    google_drive: { enabled: true, root_folder_ids: ["reviewed-root"] },
    gmail: { enabled: true },
    calendar: { enabled: true },
    quickbooks: { enabled: true, environment: "sandbox" },
    zoom: { enabled: true },
    imap: { enabled: true },
    bank_feed: { enabled: true, provider: "plaid" },
  },
}));

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("local tool readiness proves Claude sign-in, pinned Wrangler, and the interactive Claude doctor", async () => {
  const calls = [];
  const skillHome = join(sandbox, "local-tools-home");
  const receipt = await cmdLocalTools({
    isTTY: true,
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "npx") return { ok: true, out: "wrangler 4.127.1" };
      if (args[0] === "--version") return { ok: true, out: "2.1.63 (Claude Code)" };
      if (args.join(" ") === "auth status") return { ok: true, out: "fixture status intentionally hidden" };
      return { ok: false, out: "unexpected fixture command" };
    },
    runClaudeDoctor: async () => ({ status: 0 }),
    claudeSkillOptions: { home: skillHome },
  });
  assert.deepEqual(receipt, {
    claude: "ready",
    wrangler: "ready",
    technician_skill: "installed",
    claude_doctor: "passed",
  });
  assert.ok(calls.some((call) => call.command === "claude" && call.args.join(" ") === "auth status"));
  assert.ok(calls.some((call) => call.command === "npx" && call.args.join(" ") === "wrangler@4.127.1 --version"));
  assert.ok(calls.every((call) => call.options.inheritEnv === false));
});

test("Windows bootstrap repairs PATH, runs the 25-round gate, and launches Claude by exact executable", async () => {
  const workspace = join(sandbox, "windows-bootstrap");
  const home = join(sandbox, "windows-skill-home");
  mkdirSync(workspace, { recursive: true });
  const intendedManifest = join(workspace, "brain.manifest.json");
  const environment = {
    USERPROFILE: "C:\\Users\\fixture-owner",
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32;C:\\Owner\\ExistingBin",
    TEMP: "C:\\Users\\fixture-owner\\AppData\\Local\\Temp",
  };
  const officialClaude = "C:\\Users\\fixture-owner\\.local\\bin\\claude.exe";
  const calls = [];
  let dpapiRounds = 0;
  let launch = null;
  const receipt = await cmdLocalTools({
    platformName: "win32",
    environment,
    manifestPath: intendedManifest,
    brainCliPath: safeBrainPath,
    nodePath: safeNodePath,
    writeStatus: true,
    handoff: true,
    deepDpapi: true,
    isTTY: false,
    existsImpl: (path) => String(path).toLowerCase() === officialClaude.toLowerCase(),
    runPowerShell: () => ({ status: 0, stdout: "", stderr: "" }),
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "npx") return { ok: true, out: "wrangler 4.127.1" };
      if (args[0] === "--version") return { ok: true, out: "2.1.63 (Claude Code)" };
      if (args.join(" ") === "auth status") return { ok: true, out: "signed in" };
      return { ok: false, out: "unexpected fixture command" };
    },
    dpapiProbe: (options) => {
      dpapiRounds = options.rounds;
      return { checked: true, passed: true, rounds: options.rounds, stage: null };
    },
    claudeSkillOptions: { home },
    launchClaude: (command, args, options) => {
      launch = { command, args, options };
      return { status: 0 };
    },
  });
  assert.equal(dpapiRounds, 25);
  assert.equal(receipt.claude_path, "updated");
  assert.match(environment.PATH, /^C:\\Users\\fixture-owner\\\.local\\bin;/i);
  assert.match(environment.PATH, /C:\\Owner\\ExistingBin/i);
  assert.ok(calls.some((call) => call.command === "claude" && call.args.join(" ") === "auth status"));
  assert.equal(launch.command, officialClaude);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.cwd, workspace);
  assert.match(launch.args[0], /financial-brain-technician/);
  assert.doesNotMatch(launch.args[0], /fixture-admin|api[_-]?token|client_secret/i);

  const bootstrap = JSON.parse(readFileSync(receipt.status_file, "utf8"));
  assert.equal(bootstrap.issue_code, "BOOTSTRAP_READY_NO_MANIFEST");
  assert.equal(bootstrap.checks.dpapi_rounds, 25);
  assert.equal(bootstrap.release.external_test_kit_required, false);
  assert.equal(bootstrap.cli.command, safeNodePath);
  assert.deepEqual(bootstrap.cli.args, [safeBrainPath]);
  assert.equal(bootstrap.manifest.path, intendedManifest);
  assert.equal(existsSync(intendedManifest), false);
});

test("the personal Claude technician skill installs exactly, verifies on rerun, and contains no credential", () => {
  const home = join(sandbox, "skill-home");
  const first = installClaudeTechnicianSkill({ home });
  assert.equal(first.status, "installed");
  const content = readFileSync(first.path, "utf8");
  assert.match(content, new RegExp(CLAUDE_TECHNICIAN_SKILL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, /\/financial-brain-technician/);
  assert.match(content, /brain technician/i);
  assert.doesNotMatch(content, /CLOUDFLARE_API_TOKEN|ADMIN_KEY|client_secret|app_password/);
  if (process.platform === "win32") assert.equal(statSync(first.path).isFile(), true);
  else assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(installClaudeTechnicianSkill({ home }), {
    path: first.path,
    status: "verified",
    changed: false,
  });
});

test("an unrelated personal Claude skill with the same name is preserved byte-for-byte", () => {
  const home = join(sandbox, "skill-collision-home");
  const target = join(home, ".claude", "skills", "financial-brain-technician", "SKILL.md");
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, "owner skill\n");
  assert.throws(() => installClaudeTechnicianSkill({ home }), /different personal skill/);
  assert.equal(readFileSync(target, "utf8"), "owner skill\n");
});

test("setup can create an owner-only Claude workspace guide with locators but no credentials", () => {
  const workspace = join(sandbox, "claude-workspace");
  mkdirSync(workspace);
  const manifest = join(workspace, "brain.manifest.json");
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, {
    brainCliPath: safeBrainPath,
    nodePath: safeNodePath,
  });
  const content = readFileSync(first.path, "utf8");
  assert.equal(first.status, "written");
  assert.ok(content.startsWith(CLAUDE_WORKSPACE_MARKER));
  assert.ok(content.includes(`${JSON.stringify(safeNodePath)} ${JSON.stringify(safeBrainPath)}`));
  assert.match(content, /claude --add-dir <approved-folder>/);
  assert.match(content, /npx wrangler@4/);
  assert.match(content, /normal approval prompts enabled/i);
  assert.doesNotMatch(content, /CLOUDFLARE_API_TOKEN|ADMIN_KEY|client_secret|app_password/);
  // POSIX mode bits can prove the owner-only file mode directly. Windows does
  // not represent its inherited user-profile ACL in stat().mode and reports
  // 0666 even after chmodSync(0600); the guide contains locators and safety
  // rules only, never credentials or source content.
  if (process.platform === "win32") assert.equal(statSync(first.path).isFile(), true);
  else assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(
    writeClaudeWorkspaceGuide(manifest, {
      brainCliPath: safeBrainPath,
      nodePath: safeNodePath,
    }).status,
    "verified",
  );
});

test("an unrelated Claude workspace guide is preserved byte-for-byte", () => {
  const workspace = join(sandbox, "existing-claude-workspace");
  mkdirSync(workspace);
  const manifest = join(workspace, "brain.manifest.json");
  const target = join(workspace, "CLAUDE.md");
  writeFileSync(manifest, "{}");
  writeFileSync(target, "owner instructions\n");
  const result = writeClaudeWorkspaceGuide(manifest, { brainCliPath: "/safe/bin/brain" });
  assert.equal(result.status, "preserved_unrelated_existing_file");
  assert.equal(readFileSync(target, "utf8"), "owner instructions\n");
});

test("the plan is read-only, ordered, honest about proof, and agent-readable", () => {
  const missing = join(sandbox, "not-created.json");
  const plan = technicianPlan(missing);
  assert.equal(plan.mode, "read_only_plan");
  assert.equal(plan.proof_level, "workflow_only");
  assert.deepEqual(plan.steps.map((step) => step.id), TECHNICIAN_RUN_STEPS);
  assert.equal(plan.steps[0].state, "ready_to_start");
  assert.equal(plan.steps[1].state, "ready_after_local_tools");
  assert.match(plan.warning, /Live proof arrives/i);
  assert.match(JSON.stringify(plan), /hidden terminal prompts/i);
  assert.ok(plan.steps.every((step) => step.command.startsWith("<brain-cli> ")));
  assert.doesNotMatch(JSON.stringify(plan.steps), /(^|[^<-])\bbrain technician\b/i);
  for (const name of ["Slack", "Notion", "Microsoft 365", "Dropbox", "HubSpot", "watched-folder"]) {
    assert.match(JSON.stringify(plan.coverage), new RegExp(name, "i"));
  }
  assert.doesNotMatch(JSON.stringify(plan), /client_secret|app_password|api_token/i);
});

test("the package-local JSON plan exposes stable course-correction fields and an exact launcher", () => {
  const missing = join(sandbox, "adaptive-plan", "brain.manifest.json");
  mkdirSync(resolve(missing, ".."), { recursive: true });
  const plan = technicianPlan(missing, {
    cli: { command: safeNodePath, args: [safeBrainPath] },
  });
  assert.equal(plan.status, "plan_refreshed");
  assert.equal(plan.issue_code, null);
  assert.equal(plan.retry_safe, true);
  assert.equal(plan.requires_human, false);
  assert.equal(plan.manifest.path, missing);
  assert.deepEqual(plan.cli, { command: safeNodePath, args: [safeBrainPath] });
  assert.deepEqual(plan.refresh, {
    command: safeNodePath,
    args: [safeBrainPath, "technician", missing, "--json"],
    mutates_external_state: false,
  });
  assert.ok(plan.steps.every((step) => step.command.startsWith(JSON.stringify(safeNodePath))));
  assert.match(plan.next_action, /explicit owner approval/i);
});

test("every completed technician step writes a private status that requires an exact read-only refresh", async () => {
  const workspace = join(sandbox, "adaptive-step");
  mkdirSync(workspace, { recursive: true });
  const missing = join(workspace, "brain.manifest.json");
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  let receipt;
  try {
    receipt = await cmdTechnician(missing, { run: "tools" }, {
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      spawn: () => ({ status: 0 }),
    });
  } finally {
    console.log = originalLog;
  }
  const path = technicianStatusFilePath(missing);
  assert.equal(receipt.status_file, path);
  const status = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(status.status, "status_refresh_required");
  assert.equal(status.issue_code, "TECHNICIAN_STATUS_REFRESH_REQUIRED");
  assert.equal(status.retry_safe, false);
  assert.equal(status.requires_human, false);
  assert.equal(status.manifest.path, missing);
  assert.deepEqual(status.cli, { command: fixtureNodePath, args: [fixtureScriptPath] });
  assert.deepEqual(status.refresh, {
    command: fixtureNodePath,
    args: [fixtureScriptPath, "technician", missing, "--json"],
    mutates_external_state: false,
  });
  assert.match(status.next_action, /Do not continue from this receipt alone/);
  assert.match(status.proof_warning, /not inferred from its exit code or the manifest/);
  assert.match(logs.join("\n"), /machine-readable step status/);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

  const refreshed = technicianPlan(missing, {
    cli: { command: fixtureNodePath, args: [fixtureScriptPath] },
  });
  assert.equal(refreshed.last_step.state, "available");
  assert.equal(refreshed.last_step.step, "tools");
  assert.equal(refreshed.last_step.proof_level, "command_return_only");
});

test("a corrupt manifest still leaves a fail-closed machine-readable step receipt", () => {
  const workspace = join(sandbox, "adaptive-corrupt");
  mkdirSync(workspace, { recursive: true });
  const manifest = join(workspace, "brain.manifest.json");
  writeFileSync(manifest, "{not-json", "utf8");
  const result = spawnSync(process.execPath, [
    resolve("brain.mjs"), "technician", manifest, "--run", "tools",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" } });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /could not read the technician manifest/i);
  const status = JSON.parse(readFileSync(technicianStatusFilePath(manifest), "utf8"));
  assert.equal(status.status, "action_required");
  assert.equal(status.issue_code, "TECHNICIAN_STEP_FAILED");
  assert.equal(status.retry_safe, false);
  assert.equal(status.requires_human, true);
  assert.equal(status.refresh.mutates_external_state, false);
  assert.match(status.proof_warning, /did not complete/i);
});

test("the first technician step verifies local tools before any manifest or account exists", async () => {
  let call;
  const receipt = await runTechnicianStep({
    step: "tools",
    manifestPath: join(sandbox, "not-created.json"),
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    spawn: (node, args, options) => { call = { node, args, options }; return { status: 0 }; },
  });
  assert.deepEqual(receipt, { step: "tools", completed: true, commands_run: 1 });
  assert.deepEqual(call.args, [fixtureScriptPath, "tools", resolve(join(sandbox, "not-created.json"))]);
  assert.equal(call.options.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("the child environment strips ambient credentials and unrelated application state", () => {
  const env = technicianChildEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    CLOUDFLARE_API_TOKEN: "must-not-cross",
    OPENAI_API_KEY: "must-not-cross",
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    GOOGLE_CLIENT_SECRET: "must-not-cross",
    ZOOM_CLIENT_SECRET: "must-not-cross",
    RANDOM_APPLICATION_VALUE: "must-not-cross",
  });
  assert.deepEqual(env, { PATH: "/safe/bin", HOME: "/safe/home", LANG: "en_US.UTF-8" });
  assert.doesNotMatch(JSON.stringify(env), /must-not-cross/);
});

test("Google credentials cross only the child environment, never argv, and input buffers are zeroed", async () => {
  const clientId = Buffer.from("fixture-google-client-id");
  const clientSecret = Buffer.from("fixture-google-client-secret");
  const entered = [clientId, clientSecret];
  const calls = [];
  const receipt = await runTechnicianStep({
    step: "google",
    manifestPath,
    flags: {},
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    readHidden: async () => entered.shift(),
    spawn: (node, args, options) => {
      calls.push({ node, args, options });
      assert.equal(options.env.GOOGLE_CLIENT_ID, "fixture-google-client-id");
      assert.equal(options.env.GOOGLE_CLIENT_SECRET, "fixture-google-client-secret");
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(receipt, { step: "google", completed: true, commands_run: 1 });
  assert.deepEqual(calls[0].args, [fixtureScriptPath, "connect", "google", "--scopes", "drive,gmail,calendar"]);
  assert.doesNotMatch(calls[0].args.join(" "), /fixture-google/);
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_ID, "");
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_SECRET, "");
  assert.ok(clientId.every((byte) => byte === 0));
  assert.ok(clientSecret.every((byte) => byte === 0));
});

test("Plaid credentials cross only the secrets child environment and are zeroed", async () => {
  const clientId = Buffer.from("fixture-plaid-client-id");
  const clientSecret = Buffer.from("fixture-plaid-secret");
  const wrappingKey = Buffer.from(`v2.${"A".repeat(43)}`);
  const entered = [clientId, clientSecret, wrappingKey];
  let call;
  await runTechnicianStep({
    step: "plaid",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", ZOOM_CLIENT_SECRET: "ambient-zoom-secret" },
    readHidden: async () => entered.shift(),
    spawn: (node, args, options) => {
      call = { node, args, options };
      assert.equal(options.env.BANK_FEED_CLIENT_ID, "fixture-plaid-client-id");
      assert.equal(options.env.BANK_FEED_SECRET, "fixture-plaid-secret");
      assert.equal(options.env.BANK_FEED_WRAPPING_KEY_V2, `v2.${"A".repeat(43)}`);
      assert.equal(options.env.ZOOM_CLIENT_SECRET, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(call.args, [fixtureScriptPath, "secrets", manifestPath]);
  assert.doesNotMatch(call.args.join(" "), /fixture-plaid/);
  assert.equal(call.options.env.BANK_FEED_CLIENT_ID, "");
  assert.equal(call.options.env.BANK_FEED_SECRET, "");
  assert.equal(call.options.env.BANK_FEED_WRAPPING_KEY_V2, "");
  assert.ok(clientId.every((byte) => byte === 0));
  assert.ok(clientSecret.every((byte) => byte === 0));
  assert.ok(wrappingKey.every((byte) => byte === 0));
});

test("QuickBooks refuses missing manifests and incomplete configuration before any hidden prompt or OAuth call", async () => {
  let prompts = 0;
  let connects = 0;
  const common = {
    step: "quickbooks",
    scriptPath: fixtureScriptPath,
    readHidden: async () => { prompts++; return Buffer.from("must-not-be-read"); },
    connectProvider: async () => { connects++; },
  };
  await assert.rejects(
    runTechnicianStep({ ...common, manifestPath: join(sandbox, "missing-quickbooks.json") }),
    (error) => error.code === "manifest_not_found",
  );

  const disabled = join(sandbox, "quickbooks-disabled.json");
  writeFileSync(disabled, JSON.stringify({ corpora: { quickbooks: { enabled: false, environment: "sandbox" } } }));
  await assert.rejects(
    runTechnicianStep({ ...common, manifestPath: disabled }),
    (error) => error.code === "quickbooks_not_enabled",
  );

  const noEnvironment = join(sandbox, "quickbooks-no-environment.json");
  writeFileSync(noEnvironment, JSON.stringify({ corpora: { quickbooks: { enabled: true } } }));
  await assert.rejects(
    runTechnicianStep({ ...common, manifestPath: noEnvironment }),
    (error) => error.code === "quickbooks_environment_required",
  );
  const production = join(sandbox, "quickbooks-production.json");
  writeFileSync(production, JSON.stringify({ corpora: { quickbooks: { enabled: true, environment: "production" } } }));
  assert.equal(
    technicianPlan(production).steps.find((step) => step.id === "quickbooks").state,
    "production_callback_unavailable",
  );
  await assert.rejects(
    runTechnicianStep({ ...common, manifestPath: production }),
    (error) => error.code === "quickbooks_production_callback_unavailable",
  );
  const invalidRedirect = join(sandbox, "quickbooks-invalid-redirect.json");
  writeFileSync(invalidRedirect, JSON.stringify({
    corpora: { quickbooks: { enabled: true, environment: "sandbox", redirect_host: "0.0.0.0" } },
  }));
  assert.equal(
    technicianPlan(invalidRedirect).steps.find((step) => step.id === "quickbooks").state,
    "requires_redirect_host_review",
  );
  await assert.rejects(
    runTechnicianStep({ ...common, manifestPath: invalidRedirect }),
    (error) => error.code === "quickbooks_redirect_host_invalid",
  );
  assert.equal(prompts, 0);
  assert.equal(connects, 0);
});

test("QuickBooks technician JSON failures use a stable nonzero exit and recovery envelope", () => {
  const disabled = join(sandbox, "quickbooks-json-disabled.json");
  writeFileSync(disabled, JSON.stringify({ corpora: { quickbooks: { enabled: false, environment: "sandbox" } } }));
  const result = spawnSync(process.execPath, [
    resolve("brain.mjs"), "technician", disabled, "--run", "quickbooks", "--json",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "error");
  assert.equal(payload.error_code, "quickbooks_not_enabled");
  assert.match(payload.recovery, /Enable it before connecting/);
  assert.equal(payload.financial_authority, false);
  assert.equal(typeof payload.status_file, "string");
  const status = JSON.parse(readFileSync(payload.status_file, "utf8"));
  assert.equal(status.status, "action_required");
  assert.equal(status.issue_code, "QUICKBOOKS_NOT_ENABLED");
  assert.equal(status.retry_safe, true);
  assert.equal(status.requires_human, true);
  assert.equal(status.refresh.mutates_external_state, false);
});

test("QuickBooks uses two hidden prompts, existing OAuth custody, privacy-safe JSON, and exact verification commands", async () => {
  const clientId = Buffer.from("fixture-intuit-client-id");
  const clientSecret = Buffer.from("fixture-intuit-client-secret");
  const entered = [clientId, clientSecret];
  const prompts = [];
  let authorizeOptions;
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    const receipt = await cmdTechnician(manifestPath, { run: "quickbooks", json: true }, {
      readHidden: async (request) => {
        prompts.push(request);
        return entered.shift();
      },
      spawn: () => { throw new Error("QuickBooks credentials must never reach a child process"); },
      providerOptions: {
        environment: {
          QUICKBOOKS_CLIENT_ID: "ambient-client-must-not-win",
          QUICKBOOKS_CLIENT_SECRET: "ambient-secret-must-not-win",
        },
        oauth: {
          PROVIDER_DEFAULT_PORT: 47812,
          providerOAuthConfig: () => ({
            provider: "quickbooks", label: "QuickBooks Online", clientSecretRequired: true,
            loopbackRedirectHost: "localhost",
          }),
          providerRedirectUri: (port) => `http://127.0.0.1:${port}`,
          quickBooksSandboxRedirectUri: (port, host) => `http://${host}:${port}/`,
          loadQuickBooksCredentials: async () => null,
          authorizeProvider: async (_provider, options) => {
            authorizeOptions = options;
            return options.prepareConnection({ provider_metadata: { realm_id: "private-company-id" } });
          },
          bindQuickBooksConnection: ({ candidate, source, environment }) => ({
            ...candidate,
            provider_metadata: { ...candidate.provider_metadata, qbo_company_fingerprint: "a".repeat(64) },
            quickbooks_binding: { active_source: source, active_environment: environment },
          }),
          assertQuickBooksSourceBinding: (_connection, { source, environment }) => ({
            source, environment, qbo_company_fingerprint: "a".repeat(64),
          }),
          providerCredentialDescription: () => "the existing fixture provider store",
        },
      },
    });
    assert.equal(receipt.status, "connected");
    assert.equal(receipt.environment, "sandbox");
    assert.equal(receipt.custody, "client_local_provider_store");
    assert.equal(receipt.financial_authority, false);
    assert.equal(receipt.oauth_permission, "broad_accounting_scope_runtime_read_only");
    assert.equal(authorizeOptions.clientId, "fixture-intuit-client-id");
    assert.equal(authorizeOptions.clientSecret, "fixture-intuit-client-secret");
    assert.equal(authorizeOptions.redirectUri, "http://localhost:47812/");
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every((prompt) => /hidden/i.test(prompt.prompt)));
    assert.deepEqual(receipt.verification_commands, [
      `<brain-cli> ingest ${JSON.stringify(resolve(manifestPath))} --from quickbooks --dry-run`,
      `<brain-cli> ingest ${JSON.stringify(resolve(manifestPath))} --from quickbooks`,
    ]);
  } finally {
    console.log = originalLog;
  }
  const rendered = logs.join("\n");
  assert.doesNotMatch(rendered, /fixture-intuit|ambient-|private-company-id/);
  assert.doesNotMatch(JSON.stringify(logs), /client_secret|realm_id/);
  assert.ok(clientId.every((byte) => byte === 0));
  assert.ok(clientSecret.every((byte) => byte === 0));
});

test("QuickBooks owner cancellation and missing company identity never produce a success receipt", async () => {
  const canceledValues = [Buffer.from("cancel-client"), Buffer.from("cancel-secret")];
  await assert.rejects(
    runTechnicianStep({
      step: "quickbooks",
      manifestPath,
      scriptPath: fixtureScriptPath,
      readHidden: async () => canceledValues.shift(),
      connectProvider: async () => {
        const error = new Error("provider refusal fixture");
        error.code = "access_denied";
        throw error;
      },
    }),
    (error) => error.code === "owner_canceled" && /Nothing was marked connected/.test(error.message),
  );

  const missingRealmValues = [Buffer.from("realm-client"), Buffer.from("realm-secret")];
  await assert.rejects(
    runTechnicianStep({
      step: "quickbooks",
      manifestPath,
      scriptPath: fixtureScriptPath,
      readHidden: async () => missingRealmValues.shift(),
      connectProvider: ({ provider, manifestPath: path, flags, credentials }) => cmdConnectProvider(provider, path, flags, {
        credentials,
        quiet: true,
        environment: {},
        oauth: {
          PROVIDER_DEFAULT_PORT: 47812,
          providerOAuthConfig: () => ({
            provider: "quickbooks", label: "QuickBooks Online", clientSecretRequired: true,
            loopbackRedirectHost: "localhost",
          }),
          providerRedirectUri: () => "http://127.0.0.1:47812",
          quickBooksSandboxRedirectUri: () => "http://localhost:47812/",
          loadQuickBooksCredentials: async () => null,
          authorizeProvider: async () => ({ provider_metadata: {} }),
          bindQuickBooksConnection: ({ candidate }) => candidate,
          assertQuickBooksSourceBinding: () => { throw new Error("must not verify a missing company"); },
          providerCredentialDescription: () => "fixture store",
        },
      }),
    }),
    (error) => error.code === "quickbooks_realm_missing",
  );
});

test("QuickBooks response loss records uncertainty and a clean rerun can succeed without a blind token retry", async () => {
  let attempts = 0;
  const connectProvider = async () => {
    attempts++;
    if (attempts === 1) {
      const error = new Error("lost fixture response");
      error.uncertain = true;
      throw error;
    }
  };
  const run = (prefix) => {
    const values = [Buffer.from(`${prefix}-client`), Buffer.from(`${prefix}-secret`)];
    return runTechnicianStep({
      step: "quickbooks",
      manifestPath,
      scriptPath: fixtureScriptPath,
      readHidden: async () => values.shift(),
      connectProvider,
    });
  };
  await assert.rejects(
    run("first"),
    (error) => error.code === "oauth_response_uncertain" && /Rerun this same technician step/.test(error.message),
  );
  const receipt = await run("second");
  assert.equal(receipt.completed, true);
  assert.equal(attempts, 2);
});

test("Zoom collects the exact S2S values, strips ambient secrets, and zeroes every input", async () => {
  const values = [
    Buffer.from("fixture-account"),
    Buffer.from("fixture-client"),
    Buffer.from("fixture-client-secret"),
    Buffer.from("fixture-webhook-secret"),
  ];
  const originals = [...values];
  let call;
  await runTechnicianStep({
    step: "zoom",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", BANK_FEED_SECRET: "ambient-bank-secret" },
    readHidden: async () => values.shift(),
    spawn: (node, args, options) => {
      call = { node, args, options };
      assert.deepEqual(
        Object.keys(options.env).filter((key) => key.startsWith("ZOOM_")).sort(),
        ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"],
      );
      assert.equal(options.env.BANK_FEED_SECRET, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(call.args, [fixtureScriptPath, "connect", "zoom", manifestPath]);
  assert.doesNotMatch(call.args.join(" "), /fixture-account|fixture-client|fixture-webhook/);
  for (const key of ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"]) {
    assert.equal(call.options.env[key], "");
  }
  for (const buffer of originals) assert.ok(buffer.every((byte) => byte === 0));
});

test("IMAP passes only non-secret routing values and leaves app-password prompting to the connector", async () => {
  let call;
  await runTechnicianStep({
    step: "imap",
    manifestPath,
    flags: { host: "imap.example.test", user: "owner@example.test", port: "993", source: "owner-mail" },
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", IMAP_PASSWORD: "ambient-secret" },
    spawn: (node, args, options) => { call = { node, args, options }; return { status: 0 }; },
  });
  assert.deepEqual(call.args, [
    fixtureScriptPath, "connect", "imap", manifestPath,
    "--host", "imap.example.test", "--user", "owner@example.test",
    "--port", "993", "--source", "owner-mail",
  ]);
  assert.equal(call.options.env.IMAP_PASSWORD, undefined);
  assert.doesNotMatch(JSON.stringify(call), /ambient-secret/);
});

test("passkey enrollment refuses before mutation unless the exact final hostname is confirmed", async () => {
  let calls = 0;
  const common = {
    step: "passkey",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    spawn: () => { calls++; return { status: 0 }; },
  };
  await assert.rejects(
    runTechnicianStep({ ...common, flags: { "confirm-host": "other.fixture.test" } }),
    /exactly matches brain\.fixture\.test/,
  );
  assert.equal(calls, 0);
  await runTechnicianStep({ ...common, flags: { "confirm-host": "BRAIN.FIXTURE.TEST" } });
  assert.equal(calls, 1);
});

test("verification is ordered and stops at the first failed proof", async () => {
  const commands = [];
  await assert.rejects(
    runTechnicianStep({
      step: "verify",
      manifestPath,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      spawn: (_node, args) => {
        commands.push(args[1]);
        return { status: args[1] === "health" ? 1 : 0 };
      },
    }),
    /paused before completion/,
  );
  assert.deepEqual(commands, ["doctor", "health"]);
});
