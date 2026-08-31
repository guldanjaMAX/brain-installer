import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertNoLiveCommand,
  buildNpmInvocation,
  buildStepPlan,
  buildWindowsBatchInvocation,
  createCredentialFreeProviderEnvironment,
  createSafeEnvironment,
  parseFieldPrepareArgs,
  renderFieldChecklist,
} from "../scripts/field-prepare.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("the default profile contains every credential-free preparation gate", () => {
  const options = parseFieldPrepareArgs([]);
  const ids = buildStepPlan(options).map((step) => step.id);
  assert.deepEqual(ids, [
    "source-identity", "full-suite", "hiccup-lab", "plaid-fake",
    "d1-auth-atomicity", "passkey-protocol", "package-privacy",
    "history-privacy", "dependency-audit", "package-build", "clean-prefix-smoke",
    "source-identity-final", "private-home-cleanup",
  ]);
});

test("fast and selected profiles cannot become accidental full proof", () => {
  const fast = buildStepPlan(parseFieldPrepareArgs(["--fast"])).map((step) => step.id);
  assert.ok(fast.includes("focused-suite"));
  assert.ok(fast.includes("hiccup-lab-fast"));
  assert.ok(fast.includes("package-privacy-fast"));
  assert.ok(!fast.includes("full-suite"));
  assert.ok(!fast.includes("hiccup-lab"));
  assert.ok(!fast.includes("package-privacy"));

  const selected = buildStepPlan(parseFieldPrepareArgs(["--only", "clean-prefix-smoke"]));
  assert.deepEqual(selected.map((step) => step.id), [
    "source-identity", "package-build", "clean-prefix-smoke", "source-identity-final",
    "private-home-cleanup",
  ]);
  const reversed = buildStepPlan(parseFieldPrepareArgs([
    "--only", "clean-prefix-smoke,package-build",
  ])).map((step) => step.id);
  assert.ok(reversed.indexOf("package-build") < reversed.indexOf("clean-prefix-smoke"));
  assert.throws(() => parseFieldPrepareArgs(["--fast", "--only", "plaid-fake"]), /separate modes/);
  assert.throws(() => parseFieldPrepareArgs(["--only", "cloudflare-live"]), /unknown/);
  assert.throws(() => parseFieldPrepareArgs(["--only", ","]), /at least one/);
});

test("every child environment drops credentials and customer-home access", () => {
  const temporary = mkdtempSync(join(tmpdir(), "brain-field-env-test-"));
  try {
    const safe = createSafeEnvironment({
      PATH: "/fixture/bin",
      HOME: "/private/customer-home",
      CLOUDFLARE_API_TOKEN: "fixture-cloud-token",
      BANK_FEED_SECRET: "fixture-bank-secret",
      QUICKBOOKS_CLIENT_SECRET: "fixture-qbo-secret",
      GOOGLE_CLIENT_SECRET: "fixture-google-secret",
      NODE_OPTIONS: "--import=/private/customer-hook.mjs",
    }, temporary);
    assert.equal(safe.PATH, "/fixture/bin");
    assert.equal(safe.HOME, temporary);
    assert.equal(safe.USERPROFILE, temporary);
    assert.equal(safe.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(safe.BANK_FEED_SECRET, undefined);
    assert.equal(safe.QUICKBOOKS_CLIENT_SECRET, undefined);
    assert.equal(safe.GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(safe.NODE_OPTIONS, undefined);
    assert.equal(safe.NPM_CONFIG_CACHE, join(temporary, "npm-cache"));
    assert.equal(safe.NPM_CONFIG_GLOBALCONFIG, join(temporary, "npm-globalrc"));
    assert.equal(safe.NPM_CONFIG_USERCONFIG, join(temporary, "npmrc"));
    assert.equal(safe.NPM_CONFIG_OFFLINE, "true");
    assert.equal(safe.BRAIN_FIELD_PREPARE, "1");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("npm and Windows wrapper launches avoid ambient shell execution", () => {
  const npm = buildNpmInvocation("C:\\safe tools\\npm-cli.js", ["pack", "a&b"]);
  assert.equal(npm.command, process.execPath);
  assert.deepEqual(npm.args, ["C:\\safe tools\\npm-cli.js", "pack", "a&b"]);
  assert.equal(npm.shell, false);

  const batch = buildWindowsBatchInvocation("cmd.exe", "C:\\safe tools\\brain.cmd");
  assert.equal(batch.command, "cmd.exe");
  assert.equal(batch.shell, false);
  assert.deepEqual(batch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.throws(() => buildWindowsBatchInvocation("cmd.exe", "bad\"path.cmd"), /refused/);
});

test("provider subprocesses drop credentials while keeping telemetry disabled", () => {
  const safe = createCredentialFreeProviderEnvironment({
    PATH: "/fixture/bin",
    CLOUDFLARE_API_TOKEN: "fixture-token",
    CF_ACCOUNT_ID: "fixture-account",
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING: "fixture-connection",
    WRANGLER_SEND_METRICS: "true",
  });
  assert.equal(safe.PATH, "/fixture/bin");
  assert.equal(safe.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(safe.CF_ACCOUNT_ID, undefined);
  assert.equal(safe.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING, undefined);
  assert.equal(safe.WRANGLER_SEND_METRICS, "false");
  assert.equal(safe.DO_NOT_TRACK, "1");
});

test("the command boundary refuses live modes, manifests, and mutating Cloudflare runners", () => {
  const full = buildStepPlan(parseFieldPrepareArgs([]));
  for (const step of full.filter((item) => !item.internal)) assert.equal(assertNoLiveCommand(step), true);
  assert.throws(() => assertNoLiveCommand({ command: "node", args: ["runner.mjs", "--live"] }), /unsafe/);
  assert.throws(() => assertNoLiveCommand({ command: "node", args: ["brain.mjs", "setup"] }), /unsafe/);
  assert.throws(() => assertNoLiveCommand({ command: "node", args: ["x.manifest.json"] }), /unsafe/);
});

test("the generated checklist keeps offline proof separate from human field gates", () => {
  const checklist = renderFieldChecklist({
    generated_at: "2026-08-31T00:00:00.000Z",
    status: "source_preparation_passed",
    source: {
      head_sha: "a".repeat(40), tree_sha: "b".repeat(40),
      package_name: "brain-installer", package_version: "0.2.1",
    },
    package: { filename: "brain-installer-0.2.1.tgz", bytes: 123, sha256: "c".repeat(64) },
  });
  assert.match(checklist, /Clean Windows owner profile/);
  assert.match(checklist, /Disposable Cloudflare Brain/);
  assert.match(checklist, /Plaid Sandbox through the deployed Brain/);
  assert.match(checklist, /QuickBooks Online Sandbox/);
  assert.match(checklist, /does not prove Cloudflare/i);
  assert.doesNotMatch(checklist, /--execute|--live/);
});

test("plan mode is read-only and names no live action", () => {
  const result = spawnSync(process.execPath, ["scripts/field-prepare.mjs", "--plan", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.live_actions, false);
  assert.equal(plan.reads_customer_manifest, false);
  assert.equal(plan.reads_credential_store, false);
  assert.equal(plan.steps[0].id, "source-identity");
  assert.doesNotMatch(result.stdout, /--live|--execute|\.manifest\.json/i);
});
