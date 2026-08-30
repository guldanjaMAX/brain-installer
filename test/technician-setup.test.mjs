import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cmdConnectProvider, cmdInvite, cmdLocalTools, cmdTechnician, runPublicInstallSmoke, verifyTechnicianHandoff } from "../brain.mjs";

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
    runPowerShell: () => ({ status: 0, stdout: "BRAIN_CLAUDE_PATH_OK", stderr: "" }),
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
    claudeWorkspaceRoot: join(sandbox, "windows-dedicated-workspace"),
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
  assert.notEqual(launch.options.cwd, workspace);
  assert.ok(readFileSync(join(launch.options.cwd, "CLAUDE.md"), "utf8").startsWith(CLAUDE_WORKSPACE_MARKER));
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
    workspaceRoot: join(sandbox, "claude-workspace-root"),
  });
  const content = readFileSync(first.path, "utf8");
  assert.equal(first.status, "written");
  assert.ok(content.startsWith(CLAUDE_WORKSPACE_MARKER));
  assert.match(content, new RegExp(`Brain CLI invocation:.*${safeNodePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
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
      workspaceRoot: join(sandbox, "claude-workspace-root"),
    }).status,
    "verified",
  );
});

test("an unrelated manifest-directory guide is preserved and excluded from the dedicated handoff workspace", () => {
  const workspace = join(sandbox, "existing-claude-workspace");
  mkdirSync(workspace);
  const manifest = join(workspace, "brain.manifest.json");
  const target = join(workspace, "CLAUDE.md");
  writeFileSync(manifest, "{}");
  writeFileSync(target, "owner instructions\n");
  const result = writeClaudeWorkspaceGuide(manifest, {
    brainCliPath: "/safe/bin/brain",
    workspaceRoot: join(sandbox, "existing-guide-dedicated-root"),
  });
  assert.equal(result.status, "written");
  assert.notEqual(result.workspace, workspace);
  assert.equal(readFileSync(target, "utf8"), "owner instructions\n");
  assert.ok(readFileSync(result.path, "utf8").startsWith(CLAUDE_WORKSPACE_MARKER));
});

test("copyable commands quote spaces, dollar expansion, and apostrophes without changing structured argv", () => {
  const hostileRoot = join(sandbox, "command $(must-not-run) owner's folder");
  mkdirSync(hostileRoot, { recursive: true });
  const manifest = join(hostileRoot, "brain manifest.json");
  writeFileSync(manifest, "{}");
  const hostileNode = join(hostileRoot, "node $HOME owner's binary");
  const hostileBrain = join(hostileRoot, "brain $(touch never) owner's.mjs");
  const plan = technicianPlan(manifest, {
    cli: { command: hostileNode, args: [hostileBrain] },
  });
  assert.deepEqual(plan.refresh, {
    command: resolve(hostileNode),
    args: [resolve(hostileBrain), "technician", resolve(manifest), "--json"],
    mutates_external_state: false,
  });
  for (const command of plan.steps.map((step) => step.command).filter(Boolean)) {
    if (process.platform === "win32") {
      assert.match(command, /^& '/);
      assert.match(command, /\$\(must-not-run\)/);
      assert.match(command, /owner''s/);
    } else {
      assert.match(command, /^'/);
      assert.match(command, /\$\(must-not-run\)/);
      assert.match(command, /owner'"'"'s/);
    }
  }
  const guide = writeClaudeWorkspaceGuide(manifest, {
    brainCliPath: hostileBrain,
    nodePath: hostileNode,
    workspaceRoot: join(sandbox, "hostile-command-dedicated-root"),
  });
  const content = readFileSync(guide.path, "utf8");
  assert.match(content, /\$\(touch never\)/);
  assert.match(content, /brain manifest\.json' '--json|brain manifest\.json'/);
});

test("an unrelated instruction file inside the dedicated workspace blocks handoff", () => {
  const workspaceRoot = join(sandbox, "colliding-dedicated-root");
  const manifest = join(sandbox, "collision-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, { workspaceRoot });
  writeFileSync(first.path, "untrusted workspace instructions\n");
  const blocked = writeClaudeWorkspaceGuide(manifest, { workspaceRoot });
  assert.equal(blocked.status, "preserved_unrelated_existing_file");
  assert.equal(readFileSync(first.path, "utf8"), "untrusted workspace instructions\n");
});

test("a pre-existing symlink at the deterministic Claude workspace is rejected before mutation", () => {
  const workspaceRoot = join(sandbox, "symlink-dedicated-root");
  const manifest = join(sandbox, "symlink-manifest", "brain.manifest.json");
  const outside = join(sandbox, "symlink-outside");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, { workspaceRoot });
  rmSync(first.workspace, { recursive: true, force: true });
  symlinkSync(outside, first.workspace, "dir");
  assert.throws(
    () => writeClaudeWorkspaceGuide(manifest, { workspaceRoot }),
    /symlink or non-directory component/i,
  );
  assert.equal(existsSync(join(outside, "CLAUDE.md")), false);
});

test("a group or world-writable Claude workspace parent is rejected on POSIX", { skip: process.platform === "win32" }, () => {
  const hostileParent = join(sandbox, "writable-workspace-parent");
  const manifest = join(sandbox, "writable-parent-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  mkdirSync(hostileParent, { recursive: true });
  chmodSync(hostileParent, 0o777);
  writeFileSync(manifest, "{}");
  assert.throws(
    () => writeClaudeWorkspaceGuide(manifest, { workspaceRoot: join(hostileParent, "managed-root") }),
    /not private to the current owner/i,
  );
  assert.equal(existsSync(join(hostileParent, "managed-root")), false);
});

test("the Claude workspace revalidates its trusted parent on every rerun", { skip: process.platform === "win32" }, () => {
  const workspaceRoot = join(sandbox, "revalidated-dedicated-root");
  const manifest = join(sandbox, "revalidated-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, { workspaceRoot });
  chmodSync(workspaceRoot, 0o777);
  try {
    assert.throws(
      () => writeClaudeWorkspaceGuide(manifest, { workspaceRoot }),
      /not private to the current owner/i,
    );
    assert.equal(readFileSync(first.path, "utf8").startsWith(CLAUDE_WORKSPACE_MARKER), true);
  } finally {
    chmodSync(workspaceRoot, 0o700);
  }
});

test("the Claude workspace revalidates its full parent chain immediately before publication", { skip: process.platform === "win32" }, () => {
  const workspaceRoot = join(sandbox, "rename-revalidated-root");
  const manifest = join(sandbox, "rename-revalidated-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, { workspaceRoot, brainCliPath: safeBrainPath });
  const original = readFileSync(first.path, "utf8");
  try {
    assert.throws(
      () => writeClaudeWorkspaceGuide(manifest, {
        workspaceRoot,
        brainCliPath: join(sandbox, "replacement-brain.mjs"),
        beforeWorkspaceRename: () => chmodSync(workspaceRoot, 0o777),
      }),
      /not private to the current owner/i,
    );
    assert.equal(readFileSync(first.path, "utf8"), original);
  } finally {
    chmodSync(workspaceRoot, 0o700);
  }
});

test("a pre-existing deterministic Claude guide temporary is never deleted", () => {
  const workspaceRoot = join(sandbox, "preexisting-temp-root");
  const manifest = join(sandbox, "preexisting-temp-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, { workspaceRoot });
  rmSync(first.path);
  const temporary = `${first.path}.${process.pid}.tmp`;
  writeFileSync(temporary, "unrelated owner temporary\n");
  assert.throws(() => writeClaudeWorkspaceGuide(manifest, { workspaceRoot }), /EEXIST/);
  assert.equal(readFileSync(temporary, "utf8"), "unrelated owner temporary\n");
  assert.equal(existsSync(first.path), false);
});

test("a Claude guide created during publication is preserved by atomic no-replace", () => {
  const workspaceRoot = join(sandbox, "publish-race-root");
  const manifest = join(sandbox, "publish-race-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  const initial = writeClaudeWorkspaceGuide(manifest, { workspaceRoot });
  rmSync(initial.path);
  assert.throws(
    () => writeClaudeWorkspaceGuide(manifest, {
      workspaceRoot,
      beforeWorkspaceRename: () => writeFileSync(initial.path, "unrelated owner file\n"),
    }),
    /EEXIST/,
  );
  assert.equal(readFileSync(initial.path, "utf8"), "unrelated owner file\n");
  assert.equal(existsSync(`${initial.path}.${process.pid}.tmp`), false);
});

test("a legitimate managed-guide change rotates to a new deterministic workspace", () => {
  const workspaceRoot = join(sandbox, "managed-guide-rotation-root");
  const manifest = join(sandbox, "managed-guide-rotation-manifest", "brain.manifest.json");
  mkdirSync(resolve(manifest, ".."), { recursive: true });
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, {
    workspaceRoot,
    brainCliPath: safeBrainPath,
  });
  const original = readFileSync(first.path, "utf8");
  const second = writeClaudeWorkspaceGuide(manifest, {
    workspaceRoot,
    brainCliPath: join(sandbox, "upgraded-brain.mjs"),
  });
  assert.equal(second.status, "written");
  assert.notEqual(second.workspace, first.workspace);
  assert.equal(readFileSync(first.path, "utf8"), original);
  assert.match(readFileSync(second.path, "utf8"), /upgraded-brain\.mjs/);
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
  assert.ok(plan.steps.filter((step) => step.command).every((step) => step.command.includes("<brain-cli>")));
  assert.ok(plan.coverage.not_guided_in_this_release.some((name) => /Google connector/i.test(name)));
  assert.ok(plan.steps.filter((step) => ["plaid", "google", "quickbooks", "zoom", "imap"].includes(step.id))
    .every((step) => step.command === null && step.state === "deferred_from_public_first_install"));
  const passkey = plan.steps.find((step) => step.id === "passkey");
  assert.equal(passkey.command, null);
  assert.deepEqual(passkey.owner_only_command, {
    command: "<brain-cli>",
    args: ["invite", resolve(missing)],
    execution_boundary: "owner_direct_terminal",
    mutates_external_state: true,
    must_run_in_direct_owner_terminal: true,
    reveals_one_time_link: true,
  });
  assert.deepEqual(passkey.continuation.args, ["technician", resolve(missing), "--run", "verify"]);
  const cloudflare = plan.steps.find((step) => step.id === "cloudflare");
  assert.equal(cloudflare.command, null);
  assert.deepEqual(cloudflare.owner_only_command, {
    command: "<brain-cli>",
    args: ["technician", resolve(missing), "--run", "cloudflare"],
    execution_boundary: "owner_direct_terminal",
    mutates_external_state: true,
    must_run_in_direct_owner_terminal: true,
    reveals_one_time_link: false,
  });
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
  assert.ok(plan.steps.filter((step) => step.command).every((step) => step.command.includes(safeNodePath)));
  assert.ok(plan.steps.filter((step) => step.command).every((step) => !step.command.includes('"' + safeNodePath + '"')));
  assert.match(plan.next_action, /explicit owner approval/i);
  const passkey = plan.steps.find((step) => step.id === "passkey");
  assert.deepEqual(passkey.owner_only_command.args, [safeBrainPath, "invite", missing]);
  assert.deepEqual(passkey.continuation.args, [safeBrainPath, "technician", missing, "--run", "verify"]);
  const cloudflare = plan.steps.find((step) => step.id === "cloudflare");
  assert.deepEqual(cloudflare.owner_only_command.args, [safeBrainPath, "technician", missing, "--run", "cloudflare"]);
  assert.equal(cloudflare.owner_only_command.execution_boundary, "owner_direct_terminal");
});

test("the Cloudflare ceremony refuses an agent shell without a TTY and records the exact owner action", async () => {
  const workspace = join(sandbox, "cloudflare-no-tty");
  mkdirSync(workspace, { recursive: true });
  const manifest = join(workspace, "brain.manifest.json");
  let children = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      cmdTechnician(manifest, { run: "cloudflare" }, {
        scriptPath: fixtureScriptPath,
        nodePath: fixtureNodePath,
        isTTY: false,
        spawn: () => { children++; return { status: 0 }; },
      }),
      /real owner-controlled terminal/i,
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(children, 0);
  const status = JSON.parse(readFileSync(technicianStatusFilePath(manifest), "utf8"));
  assert.equal(status.status, "action_required");
  assert.equal(status.issue_code, "OWNER_DIRECT_TERMINAL_REQUIRED");
  assert.equal(status.retry_safe, true);
  assert.deepEqual(status.owner_action, {
    command: fixtureNodePath,
    args: [fixtureScriptPath, "technician", manifest, "--run", "cloudflare"],
    execution_boundary: "owner_direct_terminal",
    mutates_external_state: true,
  });
  assert.match(status.next_action, /owner_action\.command with exactly owner_action\.args/i);
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
  assert.equal(refreshed.steps.find((step) => step.id === "tools").state, "status_refresh_required");
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

  writeFileSync(manifest, "{}", "utf8");
  const refreshed = technicianPlan(manifest, {
    cli: { command: fixtureNodePath, args: [fixtureScriptPath] },
  });
  assert.equal(refreshed.status, "action_required");
  assert.equal(refreshed.issue_code, "TECHNICIAN_STEP_FAILED");
  assert.equal(refreshed.steps.find((step) => step.id === "tools").state, "action_required");
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

test("the public first-install path defers every connector before prompts, children, or provider calls", async () => {
  let prompts = 0;
  let children = 0;
  let providers = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const step of ["plaid", "google", "quickbooks", "zoom", "imap"]) {
      await assert.rejects(cmdTechnician(manifestPath, { run: step }, {
        readHidden: async () => { prompts++; return Buffer.from("must-not-be-read"); },
        spawn: () => { children++; return { status: 0 }; },
        connectProvider: async () => { providers++; },
      }), /deferred from the public first-install path/);
    }
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual({ prompts, children, providers }, { prompts: 0, children: 0, providers: 0 });
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
    "deferred_from_public_first_install",
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
    "deferred_from_public_first_install",
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
  assert.equal(payload.error_code, "connector_deferred_from_public_install");
  assert.match(payload.recovery, /deferred from the public first-install path/);
  assert.equal(payload.financial_authority, false);
  assert.equal(typeof payload.status_file, "string");
  const status = JSON.parse(readFileSync(payload.status_file, "utf8"));
  assert.equal(status.status, "action_required");
  assert.equal(status.issue_code, "CONNECTOR_DEFERRED_FROM_PUBLIC_INSTALL");
  assert.equal(status.retry_safe, false);
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
      allowDeferredConnectorTest: true,
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
    assert.deepEqual(receipt.verification, [
      {
        purpose: "dry_run",
        command: process.execPath,
        args: [resolve("brain.mjs"), "ingest", resolve(manifestPath), "--from", "quickbooks", "--dry-run"],
        mutates_external_state: false,
      },
      {
        purpose: "first_ingest_after_owner_review",
        command: process.execPath,
        args: [resolve("brain.mjs"), "ingest", resolve(manifestPath), "--from", "quickbooks"],
        mutates_external_state: true,
      },
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

test("passkey enrollment requires the exact host and never mints an invite in an agent-captured child", async () => {
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
  await assert.rejects(
    runTechnicianStep({ ...common, flags: { "confirm-host": "BRAIN.FIXTURE.TEST" } }),
    (error) => error.code === "passkey_human_terminal_required" && /owner-only/i.test(error.message),
  );
  assert.equal(calls, 0);
});

test("brain invite itself refuses a non-TTY before manifest or network access", async () => {
  let manifestReads = 0;
  let networkCalls = 0;
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(" "));
  try {
    await assert.rejects(
      cmdInvite(join(sandbox, "missing.manifest.json"), {
        isTTY: false,
        loadManifest: () => { manifestReads++; throw new Error("must not read manifest"); },
        request: async () => { networkCalls++; throw new Error("must not call network"); },
      }),
      (error) => error.code === "OWNER_DIRECT_TERMINAL_REQUIRED" &&
        /No enrollment invite was created/.test(error.message),
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(manifestReads, 0);
  assert.equal(networkCalls, 0);
  assert.doesNotMatch(output.join("\n"), /#enroll=|https?:\/\//);
});

test("brain invite keeps its exact interactive owner-terminal path", async () => {
  let networkCalls = 0;
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.map(String).join(" "));
  try {
    const invite = await cmdInvite(manifestPath, {
      isTTY: true,
      loadManifest: () => ({ m: { brain: { domain: "brain.fixture.test" } } }),
      resolveBaseUrl: async () => "https://brain.fixture.test",
      resolveAdminKey: () => "fixture-admin-key",
      request: async (url, request) => {
        networkCalls++;
        assert.equal(url, "https://brain.fixture.test/api/admin/auth/invite");
        assert.equal(request.method, "POST");
        return new Response(JSON.stringify({
          url: "https://brain.fixture.test/app#enroll=synthetic-code",
          rp_id: "brain.fixture.test",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(invite.rp_id, "brain.fixture.test");
  } finally {
    console.log = originalLog;
  }
  assert.equal(networkCalls, 1);
  assert.match(output.join("\n"), /synthetic-code/);
});

test("the first-install smoke uses one fixed public document and is idempotent after a lost response", async () => {
  let postedReceipt = null;
  let drained = 0;
  let requestBody = null;
  const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const common = {
    resolveAdminKey: () => "fixture-admin-key",
    postReceipt: async (receipt) => { postedReceipt = receipt; },
    drain: async (path) => { drained++; assert.equal(path, manifestPath); return { remaining: 0 }; },
  };

  let receiptCalls = 0;
  await assert.rejects(
    runPublicInstallSmoke(manifestPath, {
      ...common,
      request: async (_url, request) => {
        requestBody = JSON.parse(request.body);
        return new Response("not-json", { status: 200 });
      },
      postReceipt: async () => { receiptCalls++; },
      drain: async () => { throw new Error("must not drain without an exact ingest receipt"); },
    }),
    (error) => error.code === "INSTALL_SMOKE_INGEST_UNCONFIRMED",
  );
  assert.equal(receiptCalls, 0);
  assert.equal(requestBody.docs.length, 1);
  assert.equal(requestBody.docs[0].source_type, "install-smoke");
  assert.equal(requestBody.docs[0].source_id, "public-first-install-v1");
  assert.equal(requestBody.docs[0].metadata.contains_customer_data, false);

  for (const result of [
    { source_id: "public-first-install-v1", status: "created" },
    {
      source_id: "public-first-install-v1", source_type: "wrong-source",
      doc_uid: "wrong:doc", status: "created",
    },
  ]) {
    await assert.rejects(
      runPublicInstallSmoke(manifestPath, {
        ...common,
        request: async () => response({ results: [result] }),
        postReceipt: async () => { receiptCalls++; },
        drain: async () => { throw new Error("must not drain without the exact document identity"); },
      }),
      (error) => error.code === "INSTALL_SMOKE_INGEST_UNCONFIRMED",
    );
  }
  assert.equal(receiptCalls, 0);

  await assert.rejects(
    runPublicInstallSmoke(manifestPath, {
      ...common,
      request: async () => response({ results: [{
        source_id: "public-first-install-v1", source_type: "install-smoke",
        doc_uid: "install-smoke:public-first-install-v1", status: "created",
      }] }),
      postReceipt: async () => { throw new Error("fixture lost source-receipt response"); },
      drain: async () => { throw new Error("must not drain after an unconfirmed source receipt"); },
    }),
    /lost source-receipt response/i,
  );

  const proof = await runPublicInstallSmoke(manifestPath, {
    ...common,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    request: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return response({ results: [{
        source_id: "public-first-install-v1", source_type: "install-smoke",
        doc_uid: "install-smoke:public-first-install-v1", status: "unchanged",
      }] });
    },
  });
  assert.equal(proof.document_status, "unchanged");
  assert.equal(proof.contains_customer_data, false);
  assert.equal(proof.stored_identifiers, false);
  assert.equal(postedReceipt.source, "install-smoke");
  assert.equal(postedReceipt.status, "ready");
  assert.equal(postedReceipt.docs_unchanged, 1);
  assert.equal(drained, 1);
});

test("a live smoke step records live proof and the refreshed plan preserves it", async () => {
  const workspace = join(sandbox, "adaptive-live-smoke");
  mkdirSync(workspace, { recursive: true });
  const manifest = join(workspace, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ brain: { domain: "brain.fixture.test" } }));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await cmdTechnician(manifest, { run: "smoke" }, {
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      runInstallSmoke: async () => ({
        install_smoke_documents: 1,
        checked_via: "deployed_authenticated_ingest",
        stored_identifiers: false,
      }),
    });
  } finally {
    console.log = originalLog;
  }
  const status = JSON.parse(readFileSync(technicianStatusFilePath(manifest), "utf8"));
  assert.equal(status.status, "live_proof_recorded");
  assert.equal(status.issue_code, "TECHNICIAN_LIVE_PROOF_RECORDED");
  assert.equal(status.proof_level, "live_data_plane_postconditions");
  const refreshed = technicianPlan(manifest, {
    cli: { command: fixtureNodePath, args: [fixtureScriptPath] },
  });
  assert.equal(refreshed.last_step.status, "live_proof_recorded");
  assert.equal(refreshed.steps.find((step) => step.id === "smoke").state, "live_proof_recorded");
});

test("successful live final verification produces a terminal handoff state", async () => {
  const workspace = join(sandbox, "adaptive-live-verify");
  mkdirSync(workspace, { recursive: true });
  const manifest = join(workspace, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ brain: { domain: "brain.fixture.test" } }));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await cmdTechnician(manifest, { run: "verify" }, {
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      verifyInstallation: async () => ({
        source_count: 1,
        source_states: { manual: 1 },
        install_smoke_documents: 1,
        enrolled_device_count: 1,
        checked_via: "deployed_admin_data_plane",
        stored_identifiers: false,
      }),
    });
  } finally {
    console.log = originalLog;
  }
  const refreshed = technicianPlan(manifest, {
    cli: { command: fixtureNodePath, args: [fixtureScriptPath] },
  });
  assert.equal(refreshed.status, "handoff_complete");
  assert.equal(refreshed.proof_level, "live_data_plane_postconditions");
  assert.equal(refreshed.retry_safe, false);
  assert.equal(refreshed.requires_human, false);
  assert.match(refreshed.next_action, /No further installer mutation is requested/i);
  assert.equal(refreshed.steps.find((step) => step.id === "verify").state, "live_proof_recorded");
});

test("verification requires an in-process live postcondition probe and stores aggregate proof", async () => {
  await assert.rejects(runTechnicianStep({
    step: "verify",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
  }), (error) => error.code === "handoff_verifier_unavailable");

  let checked = 0;
  const receipt = await runTechnicianStep({
    step: "verify",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    spawn: () => { throw new Error("verification must not rely on a child exit code"); },
    verifyInstallation: async ({ manifestPath: checkedPath }) => {
      checked++;
      assert.equal(checkedPath, manifestPath);
      return {
        source_count: 2,
        source_states: { ok: 2 },
        enrolled_device_count: 1,
        checked_via: "deployed_admin_data_plane",
        stored_identifiers: false,
      };
    },
  });
  assert.equal(checked, 1);
  assert.equal(receipt.commands_run, 0);
  assert.equal(receipt.proof_level, "live_data_plane_postconditions");
  assert.equal(receipt.proof.enrolled_device_count, 1);
});

test("the deployed handoff verifier refuses empty/unavailable state and returns no identifiers", async () => {
  const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const options = {
    resolveAdminKey: () => "fixture-admin-key",
    fetchImpl: async (input) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (path === "/api/admin/brain/freshness") {
        return response({ sources: [
          {
            name: "install-smoke", kind: "upload", state: "manual",
            source_status: "ready", documents: 1, fixed_public_smoke: true,
          },
          { name: "private-source", state: "ok", source_status: "ready", documents: 2 },
        ] });
      }
      if (path === "/api/admin/auth/devices") {
        return response({ devices: [{ credential_id: "private-device-id" }] });
      }
      return response({ error: "unexpected" }, 404);
    },
  };
  const proof = await verifyTechnicianHandoff(manifestPath, options);
  assert.deepEqual(proof, {
    source_count: 2,
    source_states: { manual: 1, ok: 1 },
    install_smoke_documents: 1,
    enrolled_device_count: 1,
    checked_via: "deployed_admin_data_plane",
    stored_identifiers: false,
  });
  assert.doesNotMatch(JSON.stringify(proof), /private-source|private-device-id/);

  await assert.rejects(
    verifyTechnicianHandoff(manifestPath, {
      ...options,
      fetchImpl: async (input) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        return path.endsWith("freshness") ? response({ sources: [] }) : response({ devices: [] });
      },
    }),
    (error) => error.code === "HANDOFF_NO_CONFIGURED_SOURCES",
  );

  for (const sources of [
    [{ name: "other", state: "manual", source_status: "ready", documents: 1 }],
    [{ name: "install-smoke", state: "manual", source_status: "pending", documents: 1 }],
    [{ name: "install-smoke", state: "manual", source_status: "ready", documents: 0 }],
    [{ name: "install-smoke", kind: "drive", state: "manual", source_status: "ready", documents: 1, fixed_public_smoke: true }],
    [{ name: "install-smoke", kind: "upload", state: "manual", source_status: "ready", documents: 1, fixed_public_smoke: false }],
  ]) {
    await assert.rejects(
      verifyTechnicianHandoff(manifestPath, {
        ...options,
        fetchImpl: async (input) => {
          const path = new URL(typeof input === "string" ? input : input.url).pathname;
          return path.endsWith("freshness") ? response({ sources }) : response({ devices: [{ credential_id: "private" }] });
        },
      }),
      (error) => error.code === "HANDOFF_INSTALL_SMOKE_UNPROVEN",
    );
  }

  await assert.rejects(
    verifyTechnicianHandoff(manifestPath, {
      ...options,
      fetchImpl: async (input) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        return path.endsWith("freshness")
          ? response({ unavailable: true, sources: [{ name: "install-smoke", state: "manual", source_status: "ready", documents: 1 }] })
          : response({ devices: [{ credential_id: "private" }] });
      },
    }),
    (error) => error.code === "HANDOFF_SOURCE_FRESHNESS_UNAVAILABLE",
  );
});
