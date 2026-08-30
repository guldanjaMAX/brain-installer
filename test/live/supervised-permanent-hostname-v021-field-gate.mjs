#!/usr/bin/env node
/**
 * Receipt template and validator for the supervised permanent-hostname gate.
 *
 * This script does not open a browser, request credentials, connect providers,
 * import data, or call the permanent Brain. Those actions require an owner to
 * be present and to approve the exact field run. The receipt contains only
 * booleans, aggregate counters, timestamps, and hashes.
 */
import assert from "node:assert/strict";
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const GATE_IDS = [
  "owner_physical_passkey",
  "support_physical_passkey_and_revoke",
  "google_drive_low_sensitivity_lifecycle",
  "gmail_low_sensitivity_ingest",
  "google_calendar_low_sensitivity_ingest",
  "imap_low_sensitivity_ingest",
  "bank_csv_export_import",
  "bank_pdf_export_import",
  "zoom_low_sensitivity_delivery",
  "plaid_sandbox_link_sync_webhook_revoke",
];
const BLOCKED_IDS = ["real_bank_connection", "sensitive_owner_corpus", "write_capable_agents"];
const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.log(`Usage:
  node test/live/supervised-permanent-hostname-v021-field-gate.mjs --plan
  node test/live/supervised-permanent-hostname-v021-field-gate.mjs --template /private/path/receipt.json
  node test/live/supervised-permanent-hostname-v021-field-gate.mjs --verify /private/path/receipt.json

Template creation is local and non-live. Verification reads only the supplied
receipt. The script never contacts a provider or the permanent hostname.`);
  process.exit(args.includes("--help") ? 0 : 2);
}

const plan = {
  gate: "supervised_permanent_hostname_v021",
  execution: "owner_present_and_separately_approved",
  allowed_data: "owner-selected low-sensitivity fixtures and provider sandbox data only",
  checks: GATE_IDS,
  blocked_pending_separate_approval: BLOCKED_IDS,
  forbidden_receipt_content: [
    "hostnames", "account names", "email addresses", "filenames", "document titles",
    "queries", "answers", "raw errors", "credentials", "tokens", "passkey identifiers",
  ],
};

if (args.includes("--plan")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const pathAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) throw new Error(`missing path after ${flag}`);
  return resolve(args[index + 1]);
};

const emptyCheck = (id) => ({
  id,
  status: "pending",
  observed_at: null,
  operator_present: false,
  steps_passed: 0,
  aggregate_items_observed: 0,
  evidence_sha256: null,
});

if (args.includes("--template")) {
  const receiptPath = pathAfter("--template");
  assert.equal(lstatSync(dirname(receiptPath)).isDirectory(), true, "receipt parent must exist");
  const template = {
    schema_version: 1,
    gate: "supervised_permanent_hostname_v021",
    status: "pending",
    candidate_commit: null,
    hostname_sha256: null,
    data_class: "owner_selected_low_sensitivity_and_sandbox_only",
    approvals: {
      permanent_field_run: false,
      named_provider_connections: false,
      low_sensitivity_imports: false,
    },
    checks: GATE_IDS.map(emptyCheck),
    blocked: BLOCKED_IDS.map((id) => ({ id, status: "blocked_pending_separate_approval" })),
    proof_boundary: "No real bank connection, sensitive corpus, or write-capable agent is authorized by this receipt.",
  };
  const descriptor = openSync(receiptPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  console.log(JSON.stringify({ status: "template_created", receipt: receiptPath }, null, 2));
  process.exit(0);
}

const receiptPath = pathAfter("--verify");
const receiptStat = lstatSync(receiptPath);
assert.equal(receiptStat.isFile(), true, "receipt must be a regular file");
assert.equal(receiptStat.isSymbolicLink(), false, "receipt symlinks are refused");
assert.equal(receiptStat.nlink, 1, "hard-linked receipts are refused");
assert.equal(receiptStat.mode & 0o077, 0, "receipt must not be readable by group or others");

const receiptText = readFileSync(receiptPath, "utf8");
const receipt = JSON.parse(receiptText);
assert.deepEqual(Object.keys(receipt).sort(), [
  "approvals", "blocked", "candidate_commit", "checks", "data_class", "gate",
  "hostname_sha256", "proof_boundary", "schema_version", "status",
].sort());
assert.equal(receipt.schema_version, 1);
assert.equal(receipt.gate, "supervised_permanent_hostname_v021");
assert.equal(receipt.status, "passed");
assert.match(receipt.candidate_commit, /^[a-f0-9]{40}$/);
assert.match(receipt.hostname_sha256, /^[a-f0-9]{64}$/);
assert.equal(receipt.data_class, "owner_selected_low_sensitivity_and_sandbox_only");
assert.deepEqual(receipt.approvals, {
  permanent_field_run: true,
  named_provider_connections: true,
  low_sensitivity_imports: true,
});

assert.deepEqual(receipt.checks.map((entry) => entry.id), GATE_IDS);
for (const entry of receipt.checks) {
  assert.deepEqual(Object.keys(entry).sort(), [
    "aggregate_items_observed", "evidence_sha256", "id", "observed_at",
    "operator_present", "status", "steps_passed",
  ].sort());
  assert.equal(entry.status, "passed", `${entry.id} is not passed`);
  assert.equal(entry.operator_present, true, `${entry.id} lacks owner-presence confirmation`);
  assert.equal(Number.isSafeInteger(entry.steps_passed) && entry.steps_passed > 0, true);
  assert.equal(Number.isSafeInteger(entry.aggregate_items_observed) && entry.aggregate_items_observed >= 0, true);
  assert.match(entry.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  assert.match(entry.evidence_sha256, /^[a-f0-9]{64}$/);
}

assert.deepEqual(receipt.blocked, BLOCKED_IDS.map((id) => ({
  id, status: "blocked_pending_separate_approval",
})));
assert.equal(receipt.proof_boundary,
  "No real bank connection, sensitive corpus, or write-capable agent is authorized by this receipt.");

const forbiddenPatterns = [
  /https?:\/\//i,
  /@[a-z0-9.-]+\.[a-z]{2,}/i,
  /(?:token|secret|password|credential|authorization)[=:][^,}\s]+/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
];
for (const pattern of forbiddenPatterns) assert.equal(pattern.test(receiptText), false,
  "receipt contains a forbidden raw identifier or credential-shaped value");

console.log(JSON.stringify({
  status: "passed",
  gate: receipt.gate,
  checks_passed: receipt.checks.length,
  blocked_actions: receipt.blocked.length,
}, null, 2));
