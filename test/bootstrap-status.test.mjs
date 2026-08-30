import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_STATUS_BASENAME,
  bootstrapManifestObservation,
  bootstrapStatusFilePath,
  buildBootstrapStatus,
  writeBootstrapStatusFile,
} from "../operations/bootstrap-status.mjs";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "brain-bootstrap-status-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const cli = { command: process.execPath, args: [resolve("brain.mjs")] };

const okChecks = {
  node: { status: "ok" },
  claude: { status: "ok" },
  claude_path: { status: "not_applicable" },
  wrangler: { status: "ok" },
  dpapi: { status: "not_applicable", rounds: 0 },
};

function manifest(state = "not_created", recordedVersion = null) {
  return { path: manifestPath, state, recorded_version: recordedVersion };
}

function status(overrides = {}) {
  return buildBootstrapStatus({
    productVersion: "0.2.1",
    manifest: manifest(),
    cli,
    checks: okChecks,
    skill: { status: "installed" },
    claudeDoctor: "passed",
    ...overrides,
  });
}

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("a clean machine needs no manifest or external test kit to reach the reviewed setup boundary", () => {
  const result = status();
  assert.equal(result.status, "ready_for_setup");
  assert.equal(result.issue_code, "BOOTSTRAP_READY_NO_MANIFEST");
  assert.equal(result.release.external_test_kit_required, false);
  assert.equal(result.manifest.state, "not_created");
  assert.equal(result.cli.command, resolve(process.execPath));
  assert.equal(result.cli.args[0], resolve("brain.mjs"));
  assert.match(result.next_action, /manifest-creating setup command/i);
});

test("manifest inspection distinguishes missing, partial, corrupt, unsafe, and complete local state", () => {
  const missing = join(sandbox, "missing.json");
  assert.equal(bootstrapManifestObservation(missing).state, "not_created");

  const partial = join(sandbox, "partial.json");
  writeFileSync(partial, JSON.stringify({ brain: { version: "0.2.0" } }));
  assert.deepEqual(bootstrapManifestObservation(partial), {
    path: resolve(partial),
    state: "partial",
    recorded_version: "0.2.0",
  });

  const corrupt = join(sandbox, "corrupt.json");
  writeFileSync(corrupt, "{");
  assert.equal(bootstrapManifestObservation(corrupt).state, "corrupt");

  const unsafe = join(sandbox, "unsafe.json");
  assert.equal(bootstrapManifestObservation(unsafe, {
    existsImpl: () => true,
    lstatImpl: () => ({ isFile: () => true, isSymbolicLink: () => true, nlink: 1, size: 2 }),
  }).state, "unsafe");

  const complete = join(sandbox, "complete.json");
  writeFileSync(complete, JSON.stringify({
    client: { slug: "fixture" },
    brain: { worker_name: "fixture-brain", version: "0.2.1" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
  }));
  assert.deepEqual(bootstrapManifestObservation(complete), {
    path: resolve(complete),
    state: "present",
    recorded_version: "0.2.1",
  });
});

test("partial v0.2.0 state and a version difference produce distinct recovery outcomes", () => {
  const partial = status({ manifest: manifest("partial", "0.2.0") });
  assert.equal(partial.issue_code, "INSTALL_RECORD_PARTIAL");
  assert.equal(partial.retry_safe, true);

  const update = status({ manifest: manifest("present", "0.2.0") });
  assert.equal(update.status, "ready_for_update_review");
  assert.equal(update.issue_code, "INSTALLED_VERSION_DIFFERS");

  const same = status({ manifest: manifest("present", "0.2.1") });
  assert.equal(same.status, "ready");
  assert.equal(same.issue_code, null);
});

test("local runtime, Claude sign-in, PATH repair, Wrangler, and skill failures remain named and retryable", () => {
  const cases = [
    [{ checks: { ...okChecks, node: { status: "fail" } } }, "RUNTIME_UNAVAILABLE"],
    [{ checks: { ...okChecks, claude: { status: "fail", detail: "installed but not signed in" } } }, "CLAUDE_SIGN_IN_REQUIRED"],
    [{ checks: { ...okChecks, claude: { status: "fail", detail: "not installed" } } }, "CLAUDE_UNAVAILABLE"],
    [{ checks: { ...okChecks, claude_path: { status: "failed", issue_code: "CLAUDE_PATH_UPDATE_FAILED" } } }, "CLAUDE_PATH_UPDATE_FAILED"],
    [{ checks: { ...okChecks, wrangler: { status: "fail" } } }, "WRANGLER_UNAVAILABLE"],
    [{ skill: { status: "failed" } }, "TECHNICIAN_SKILL_UNAVAILABLE"],
  ];
  for (const [overrides, issueCode] of cases) {
    const result = status(overrides);
    assert.equal(result.issue_code, issueCode);
    assert.equal(result.retry_safe, true);
  }
});

test("fast and deep DPAPI failures preserve their stage code and the 25-round live gate", () => {
  const failedChecks = {
    ...okChecks,
    dpapi: { status: "fail", issue_code: "WINDOWS_DPAPI_PROTECT", rounds: 4 },
  };
  const fast = status({ checks: failedChecks });
  assert.equal(fast.issue_code, "WINDOWS_DPAPI_PROTECT");
  assert.match(fast.next_action, /25-cold-round/i);

  const deep = status({ checks: failedChecks, deepDpapi: true });
  assert.equal(deep.checks.dpapi_rounds, 4);
  assert.match(deep.next_action, /keep the Windows live gate open/i);
});

test("Cloudflare identity and capability failures never become an invalid-token guess", () => {
  const wrong = status({ observations: { cloudflare_token: "wrong_account" } });
  assert.equal(wrong.issue_code, "CLOUDFLARE_ACCOUNT_MISMATCH");
  assert.equal(wrong.retry_safe, false);

  const missing = status({ observations: { cloudflare_token: "missing_permission" } });
  assert.equal(missing.issue_code, "CLOUDFLARE_PERMISSION_MISSING");
  assert.match(missing.recovery, /not an invalid-token verdict/i);

  const reachable = status({
    manifest: manifest("present", "0.2.1"),
    observations: { cloudflare_token: "account_capabilities_reachable" },
  });
  assert.equal(reachable.status, "ready");
});

test("download, deploy, and migration network loss are retry-safe named stages", () => {
  for (const stage of ["download", "deploy", "migration"]) {
    const result = status({ observations: { network_loss_stage: stage } });
    assert.equal(result.issue_code, `NETWORK_${stage.toUpperCase()}_UNAVAILABLE`);
    assert.equal(result.retry_safe, true);
    assert.match(result.next_action, new RegExp(stage, "i"));
  }
});

test("an incompatible migration is a hard stop while compatible and same-version observations are inert", () => {
  const incompatible = status({ observations: { migration: "incompatible" } });
  assert.equal(incompatible.status, "hard_stop");
  assert.equal(incompatible.issue_code, "MIGRATION_INCOMPATIBLE");
  assert.equal(incompatible.retry_safe, false);

  for (const migration of ["compatible", "same_version"]) {
    assert.equal(status({ observations: { migration } }).status, "ready_for_setup");
  }
});

test("missing local credentials require the reviewed hidden ceremony and never enter the status", () => {
  const result = status({ observations: { local_credential: "missing", support_preview: "private" } });
  assert.equal(result.issue_code, "LOCAL_CREDENTIAL_MISSING");
  assert.equal(result.observations.support_preview, "private");
  assert.match(result.next_action, /hidden credential ceremony/i);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|api_token|client_secret/i);
});

test("status writes are private, exact, atomic, and refuse unsafe destinations", { skip: process.platform === "win32" }, () => {
  const workspace = join(sandbox, "safe-workspace");
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, "brain.manifest.json");
  const result = writeBootstrapStatusFile(path, status({ manifest: manifest("not_created") }));
  assert.equal(result.path, join(workspace, BOOTSTRAP_STATUS_BASENAME));
  assert.equal(bootstrapStatusFilePath(path), result.path);
  assert.equal(JSON.parse(readFileSync(result.path, "utf8")).status_file, result.path);
  chmodSync(result.path, 0o600);

  const real = join(sandbox, "real-status-dir");
  const linked = join(sandbox, "linked-status-dir");
  mkdirSync(real);
  symlinkSync(real, linked, "dir");
  assert.throws(
    () => writeBootstrapStatusFile(join(linked, "brain.manifest.json"), status()),
    /must not pass through a linked path/i,
  );
});
