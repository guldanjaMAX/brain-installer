import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { supportErrorCode } from "../brain.mjs";
import { SUPPORT_ERROR_CODES } from "../support-journal.mjs";
import {
  SUPPORT_RECOVERY_CATALOG,
  renderSupportRecovery,
  supportRecovery,
} from "../support-recovery.mjs";
import {
  HICCUP_SCENARIOS,
  hiccupLabEnvironment,
  hiccupLabPlan,
  runHiccupLab,
} from "../scripts/customer-hiccup-lab.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function safeCliEnvironment() {
  return hiccupLabEnvironment(process.env);
}

test("every stored issue code has one complete human recovery guide", () => {
  assert.deepEqual(Object.keys(SUPPORT_RECOVERY_CATALOG).sort(), [...SUPPORT_ERROR_CODES].sort());
  for (const code of SUPPORT_ERROR_CODES) {
    const recovery = supportRecovery(code.toLowerCase());
    assert.equal(recovery.code, code);
    assert.ok(recovery.title.length >= 8);
    assert.ok(recovery.what_happened.length >= 20);
    assert.ok(recovery.protection.length >= 20);
    assert.ok(["safe_now", "safe_after_step", "review_first"].includes(recovery.retry));
    assert.ok(recovery.next_steps.length >= 2);
    assert.ok(recovery.technician_when.length >= 20);
    const rendered = renderSupportRecovery(recovery);
    for (const label of ["What happened:", "What stayed protected:", "Safe to retry:", "Next step:", "A technician can help when:"]) {
      assert.match(rendered, new RegExp(label));
    }
    assert.doesNotMatch(rendered, /\b(?:never|do not|don't|must)\b/i, `${code} uses command-like public language`);
  }
});

test("a typed product issue code wins over mutable error wording", () => {
  const error = new Error("provider wording that may change tomorrow");
  error.code = "RATE_LIMITED";
  assert.equal(supportErrorCode(error, { command: "ingest", unexpected: true }), "RATE_LIMITED");
  error.code = "not-a-public-code";
  assert.equal(supportErrorCode(error, { command: "health" }), "HEALTH_CHECK_FAILED");
});

test("the installed CLI explains a code in calm text or agent-readable JSON", () => {
  const text = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "support", "--explain", "AUTH_REQUIRED"], {
    cwd: ROOT,
    env: safeCliEnvironment(),
    encoding: "utf8",
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /AUTH_REQUIRED · A sign-in or credential is still needed/);
  assert.match(text.stdout, /Safe to retry:/);
  assert.doesNotMatch(text.stdout, /\b(?:never|do not|don't|must)\b/i);

  const json = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "support", "--explain", "rate_limited", "--json"], {
    cwd: ROOT,
    env: safeCliEnvironment(),
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.code, "RATE_LIMITED");
  assert.equal(parsed.retry, "safe_now");
  assert.equal(Object.hasOwn(parsed, "message"), false);
});

test("an ordinary command failure shows its stable code and recovery command", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "brain-recovery-cli-"));
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "brain.mjs"), "status", join(isolatedHome, "missing.json")], {
      cwd: ROOT,
      env: { ...safeCliEnvironment(), HOME: isolatedHome, USERPROFILE: isolatedHome },
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 1);
    assert.match(output, /Issue code: CONFIG_INVALID/);
    assert.match(output, /brain support --explain CONFIG_INVALID/);
    assert.doesNotMatch(output, /\bat .*\.mjs:\d+/);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("the hiccup lab is offline, credential-scrubbed, and names every remaining field gate", () => {
  const plan = hiccupLabPlan();
  assert.equal(plan.mode, "offline_synthetic_rehearsal");
  assert.equal(plan.live_accounts_contacted, false);
  assert.equal(plan.customer_data_read, false);
  assert.deepEqual(plan.scenarios.map((item) => item.id), HICCUP_SCENARIOS.map((item) => item.id));
  assert.ok(plan.scenarios.length >= 9);
  const firstMachine = plan.scenarios.find((item) => item.id === "first-customer-machine");
  assert.ok(firstMachine);
  assert.match(firstMachine.customer_hiccup, /spaces or Unicode/i);
  assert.match(firstMachine.automated_proof, /packed tarball/i);
  assert.match(firstMachine.remaining_field_gate, /physical Windows 11/i);
  const messyFolder = plan.scenarios.find((item) => item.id === "messy-customer-folder");
  assert.ok(messyFolder);
  assert.match(messyFolder.customer_hiccup, /cloud placeholders/i);
  assert.match(messyFolder.automated_proof, /authoritative stored families/i);
  assert.match(messyFolder.remaining_field_gate, /on-demand cloud or network volume/i);
  for (const item of plan.scenarios) {
    assert.ok(item.tests.length >= 2);
    assert.ok(item.remaining_field_gate.length >= 40);
    for (const relativeTest of item.tests) assert.equal(existsSync(join(ROOT, relativeTest)), true, relativeTest);
  }

  const clean = hiccupLabEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    CLOUDFLARE_API_TOKEN: "fixture-secret",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    ZOOM_CLIENT_SECRET: "fixture-secret",
    ANTHROPIC_API_KEY: "fixture-secret",
  });
  assert.deepEqual(clean, {
    BRAIN_HICCUP_LAB: "1",
    CI: "1",
    NO_COLOR: "1",
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
  });
  assert.doesNotMatch(JSON.stringify(clean), /fixture-secret|TOKEN|CLIENT_SECRET|API_KEY/);
});

test("the hiccup runner reports a clean pass and a useful isolated failure", () => {
  const calls = [];
  const output = [];
  const passed = runHiccupLab({
    only: "folder-safety",
    spawn: (node, args, options) => {
      calls.push({ node, args, options });
      return { status: 0, stdout: "synthetic pass", stderr: "" };
    },
    environment: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    write: (line) => output.push(line),
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.passed, 1);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.options.env.CLOUDFLARE_API_TOKEN === undefined));
  assert.match(output.join("\n"), /All 1 offline hiccup rehearsals passed/);
  assert.match(output.join("\n"), /The owner should unplug or rename one approved test folder/);

  const failed = runHiccupLab({
    only: "setup-retry",
    spawn: () => ({ status: 1, stdout: "fixture assertion failed", stderr: "" }),
    write: () => {},
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].diagnostic, "fixture assertion failed");
  assert.match(failed.results[0].remaining_field_gate, /real Cloudflare/i);
});
