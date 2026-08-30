#!/usr/bin/env node
/**
 * Offline customer-hiccup rehearsal.
 *
 * This is a source-checkout QA lane. It runs curated, synthetic tests through
 * the same migration, cursor, deletion, authorization, queue, and recovery
 * modules used by the product. It does not read a manifest, credential store,
 * customer folder, or live account.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const scenario = (id, title, customerHiccup, proof, remainingFieldGate, tests) => Object.freeze({
  id,
  title,
  customer_hiccup: customerHiccup,
  automated_proof: proof,
  remaining_field_gate: remainingFieldGate,
  tests: Object.freeze(tests),
});

export const HICCUP_SCENARIOS = Object.freeze([
  scenario(
    "first-customer-machine",
    "The first customer machine is unlike the developer's",
    "The install path contains spaces or Unicode, the profile is enterprise-qualified, no interactive terminal is attached, or the network never finishes a health response.",
    "The packed tarball runs from hostile customer paths, private Windows files keep the exact current-user boundary, non-interactive handoff stays human-required, and evaluation health requests time out and retry without credentials.",
    "A clean physical Windows 11 customer profile still needs the supervised Node 22 and 24 install with its real enterprise identity, security software, proxy, interactive Claude doctor, and passkey gesture.",
    ["test/packed-fresh-setup.test.mjs", "test/bootstrap-status.test.mjs", "test/google-auth-storage.test.mjs", "test/whatsapp-capture.test.mjs", "eval/brain-client.test.mjs"],
  ),
  scenario(
    "messy-customer-folder",
    "The customer's real folder is messy, partial, or changes while it is read",
    "The folder contains links, cloud placeholders, files that move or grow during the scan, deep or oversized structured files, unsupported formats, stale resume state, or two configured folders that claim the same source identity.",
    "The local ingest path binds reads to the approved root and file identity, bounds bytes and extraction work, reports unsupported or knowingly incomplete material, refuses colliding source identities, and reconciles resume state against authoritative stored families before claiming completion.",
    "A physical Windows customer folder with reparse points and a real on-demand cloud or network volume still needs a supervised read, interruption, hydration, and resume cycle.",
    ["test/ingest-run.test.mjs", "test/quality.test.mjs", "test/formats-extra.test.mjs", "test/ingestion-contract.test.mjs", "test/load-all.test.mjs"],
  ),
  scenario(
    "setup-retry",
    "An install or update is interrupted",
    "The terminal closes, the network drops, or an update stops between stages.",
    "Setup adoption, verified recovery, repair, rollback preview, and resume boundaries are exercised.",
    "A real Cloudflare install still needs one deliberate interruption and resume on disposable resources.",
    ["test/setup-clean-path.test.mjs", "test/upgrade-repair.test.mjs", "test/verified-recovery.test.mjs"],
  ),
  scenario(
    "folder-safety",
    "A watched folder or drive disappears",
    "An external drive is unplugged, a sync folder moves, or a large removal appears unexpectedly.",
    "Missing mounts cannot become mass deletions, removal plans stop at review limits, and schedules retain resumable state.",
    "The owner should unplug or rename one approved test folder and confirm the installed schedule reports the gap without deleting indexed documents.",
    ["test/drive-removal-guard.test.mjs", "test/folder-scheduler.test.mjs"],
  ),
  scenario(
    "source-gaps",
    "A connector is partial, stale, or temporarily unavailable",
    "One source fails while other sources are healthy, or a provider returns an incomplete page.",
    "Common ingestion outcomes, cursor withholding, explicit partial states, and unavailable-versus-empty responses are exercised.",
    "Each real provider still needs its named add, edit, delete or cancel, refuse, and resume acceptance event.",
    ["test/ingestion-contract.test.mjs", "test/connector-rehearsal.test.mjs", "worker/test/health-honesty.test.mjs", "worker/test/degraded-absence.test.mjs"],
  ),
  scenario(
    "lost-response",
    "A save succeeds but the response is lost",
    "The owner clicks again after a timeout or refreshes immediately after a write.",
    "Stable request IDs replay the original receipt with one domain change and one human activity event.",
    "The installed browser should be tried once with an intentionally interrupted response while observing the real activity view.",
    ["worker/test/owner-actions.test.mjs", "worker/test/owner-actions-contract.test.mjs"],
  ),
  scenario(
    "migration-resume",
    "A database migration stops halfway",
    "Cloudflare or the installer becomes unavailable between schema statements.",
    "The real restart-safe adapter resumes compatible changes, preserves completed statements, and stops at incompatible schema.",
    "A disposable Cloudflare database still needs one controlled interrupted migration and recovery receipt.",
    ["test/migration-hardening.test.mjs", "test/migrations.test.mjs", "worker/test/product-migration-contract.test.mjs"],
  ),
  scenario(
    "search-queue",
    "Meaning search falls behind",
    "Vector indexing is delayed, a drain is interrupted, or a stale generation remains queued.",
    "Durable queue generations, retry, exact deletion outbox behavior, visibility receipts, and explicit degraded results are exercised.",
    "A disposable live index still needs a forced backlog, resumed drain, and query-visibility check.",
    ["test/drain-throughput.test.mjs", "test/vector-delete-outbox.test.mjs", "worker/test/business-scope-contract.test.mjs"],
  ),
  scenario(
    "access-boundaries",
    "A passkey or shared-document request is wrong, stale, or out of scope",
    "A ceremony is retried, a grant is revoked, or higher-ranked unauthorized documents crowd out an allowed result.",
    "Passkey privacy, exact-document authorization, revoke behavior, entity scope, and explicit scoped-vector degradation are exercised.",
    "The final hostname still needs physical passkey enrollment, sign-out and sign-in, second-device revoke, and a real lower-ranked granted-document search.",
    ["worker/test/webauthn.test.mjs", "worker/test/owner-auth.test.mjs", "worker/test/document-access.test.mjs", "worker/test/security-contract.test.mjs"],
  ),
  scenario(
    "technician-recovery",
    "The owner needs help without sharing a credential",
    "A setup value is missing, a child step fails, or support needs a stable issue identity.",
    "Technician ordering, stop-on-fail behavior, ambient-secret scrubbing, private issue notes, and recovery guidance are exercised.",
    "Provider login, 2FA, consent, billing, and physical-device prompts remain owner ceremonies.",
    ["test/technician-setup.test.mjs", "test/support-journal.test.mjs", "test/support-recovery.test.mjs"],
  ),
]);

const SAFE_ENV = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  "LOCALAPPDATA", "APPDATA", "USERPROFILE",
]);

export function hiccupLabEnvironment(environment = process.env) {
  const clean = { BRAIN_HICCUP_LAB: "1", CI: "1", NO_COLOR: "1" };
  for (const name of SAFE_ENV) {
    if (typeof environment[name] === "string" && environment[name]) clean[name] = environment[name];
  }
  return clean;
}

export function hiccupLabPlan({ only = null } = {}) {
  const selected = only
    ? HICCUP_SCENARIOS.filter((item) => item.id === only)
    : [...HICCUP_SCENARIOS];
  if (!selected.length) throw new Error(`unknown hiccup scenario ${only}`);
  return Object.freeze({
    schema_version: 1,
    mode: "offline_synthetic_rehearsal",
    live_accounts_contacted: false,
    customer_data_read: false,
    scenarios: selected,
  });
}

function finalOutput(text, limit = 6000) {
  const value = String(text || "").trim();
  return value.length > limit ? value.slice(-limit) : value;
}

export function runHiccupLab({
  only = null,
  root = ROOT,
  spawn = spawnSync,
  environment = process.env,
  write = (line) => console.log(line),
} = {}) {
  const plan = hiccupLabPlan({ only });
  const results = [];
  write("");
  write("Financial Brain customer hiccup lab");
  write("Synthetic data only. No manifest, customer folder, credential store, or live account is used.");
  write("");

  for (const item of plan.scenarios) {
    write(`Trying: ${item.title}`);
    let passed = true;
    let diagnostic = "";
    for (const relativeTest of item.tests) {
      const result = spawn(process.execPath, [join(root, relativeTest)], {
        cwd: root,
        env: hiccupLabEnvironment(environment),
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
      });
      if (result?.error || result?.status !== 0) {
        passed = false;
        diagnostic = finalOutput(result?.error?.message || `${result?.stdout || ""}\n${result?.stderr || ""}`);
        break;
      }
    }
    results.push(Object.freeze({
      id: item.id,
      title: item.title,
      passed,
      automated_proof: item.automated_proof,
      remaining_field_gate: item.remaining_field_gate,
      ...(diagnostic ? { diagnostic } : {}),
    }));
    write(`${passed ? "PASS" : "NEEDS ATTENTION"}: ${item.title}`);
    write(`Live proof still needed: ${item.remaining_field_gate}`);
    if (!passed) write(diagnostic);
  }

  const passed = results.filter((item) => item.passed).length;
  const receipt = Object.freeze({
    schema_version: 1,
    mode: plan.mode,
    passed,
    total: results.length,
    ok: passed === results.length,
    results: Object.freeze(results),
  });
  write("");
  write(receipt.ok
    ? `All ${receipt.total} offline hiccup rehearsals passed. The field gates above remain real-world checks.`
    : `${receipt.total - receipt.passed} of ${receipt.total} hiccup rehearsals need attention before field testing.`);
  return receipt;
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
  if (onlyIndex >= 0 && (!only || only.startsWith("--"))) {
    console.error("--only needs a scenario name. Use --list to see them.");
    process.exit(1);
  }
  const known = new Set(["--list", "--json", "--only", ...(only ? [only] : [])]);
  const unknown = args.filter((value) => !known.has(value));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(", ")}. Use --list to see the available rehearsal names.`);
    process.exit(1);
  }
  if (args.includes("--list")) {
    const plan = hiccupLabPlan({ only });
    if (args.includes("--json")) console.log(JSON.stringify(plan, null, 2));
    else for (const item of plan.scenarios) console.log(`${item.id}: ${item.title}`);
    process.exit(0);
  }
  const lines = [];
  const receipt = runHiccupLab({ only, write: args.includes("--json") ? (line) => lines.push(line) : undefined });
  if (args.includes("--json")) console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.ok ? 0 : 1);
}
