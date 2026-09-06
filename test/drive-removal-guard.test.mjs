import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertDriveRemovalPlanSafe,
  buildDriveRemovalPlan,
  credentialScannerFingerprint,
  DRIVE_REMOVAL_MAX_COUNT,
  DRIVE_REMOVAL_MAX_RATIO,
  drivePolicyFingerprint,
  remoteFamilySettlement,
  VALUE_FLAGS,
} from "../brain.mjs";
import { previewSupportJournal } from "../support-journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const DRIVE_GUARD_FETCH = pathToFileURL(join(HERE, "fixtures", "drive-removal-guard-fetch.mjs")).href;
const DRIVE_SCOPE_FETCH = pathToFileURL(join(HERE, "fixtures", "drive-scope-boundary-fetch.mjs")).href;

const CATEGORIES = ["source_policy", "source_deleted", "intentional_skip"];

function ids(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, "0")}`);
}

function errorMessage(plan, approval) {
  try {
    assertDriveRemovalPlanSafe(plan, approval);
    return null;
  } catch (error) {
    return String(error?.message || error);
  }
}

function reportsCount(message, label, count) {
  const between = "[^0-9]{0,32}";
  return new RegExp(`(?:${label}${between}${count}\\b|\\b${count}${between}${label})`, "i").test(message);
}

assert.equal(DRIVE_REMOVAL_MAX_COUNT, 100);
assert.equal(DRIVE_REMOVAL_MAX_RATIO, 0.10);

/* Candidate sets are intersected with live stored families and categorized once. */
const overlapPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:policy", "drive:deleted", "drive:skip", "drive:overlap", "drive:untouched"],
  policyCandidates: ["drive:not-stored-policy", "drive:overlap", "drive:policy", "drive:policy"],
  vanishedCandidates: ["drive:deleted", "drive:overlap", "drive:not-stored-deleted"],
  intentionalCandidates: ["drive:skip", "drive:overlap", "drive:not-stored-skip"],
});
assert.equal(overlapPlan.stored, 5);
assert.equal(overlapPlan.total, 4);
assert.deepEqual(Object.keys(overlapPlan.counts).sort(), [...CATEGORIES].sort());
assert.deepEqual(Object.keys(overlapPlan.targets).sort(), [...CATEGORIES].sort());

const overlapTargets = CATEGORIES.flatMap((category) => {
  assert.equal(overlapPlan.counts[category], overlapPlan.targets[category].length);
  return overlapPlan.targets[category];
});
assert.equal(overlapTargets.length, overlapPlan.total);
assert.equal(new Set(overlapTargets).size, overlapPlan.total);
assert.deepEqual(
  [...overlapTargets].sort(),
  ["drive:deleted", "drive:overlap", "drive:policy", "drive:skip"],
);
assert.equal(CATEGORIES.reduce((sum, category) => sum + overlapPlan.counts[category], 0), overlapPlan.total);

/* A restored active file beats a stale failed-deletion marker on retry. */
const restoredPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:restored"],
  activeFamilies: ["drive:restored"],
  policyCandidates: [],
  vanishedCandidates: ["drive:restored"],
  intentionalCandidates: [],
});
assert.equal(restoredPlan.total, 0);
assert.deepEqual(restoredPlan.targets.source_deleted, []);

const restoredButRefusedPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:restored"],
  activeFamilies: ["drive:restored"],
  policyCandidates: [],
  vanishedCandidates: ["drive:restored"],
  intentionalCandidates: ["drive:restored"],
});
assert.equal(restoredButRefusedPlan.total, 1);
assert.deepEqual(restoredButRefusedPlan.targets.source_deleted, []);
assert.deepEqual(restoredButRefusedPlan.targets.intentional_skip, ["drive:restored"]);

const restoredButExcludedPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:restored"],
  activeFamilies: ["drive:restored"],
  policyCandidates: ["drive:restored"],
  vanishedCandidates: ["drive:restored"],
  intentionalCandidates: [],
});
assert.equal(restoredButExcludedPlan.total, 1);
assert.deepEqual(restoredButExcludedPlan.targets.source_policy, ["drive:restored"]);
assert.deepEqual(restoredButExcludedPlan.targets.source_deleted, []);

/* Worker refusals join the guarded plan; storage failures preserve old data. */
const refusedFamilies = ids("drive:worker-refused", 101).map((uid) => ({
  stateKey: uid,
  base_doc_uid: uid,
  keep_doc_uids: [`${uid}#part1of2`, `${uid}#part2of2`],
}));
const refusedSettlement = remoteFamilySettlement(
  { completed: [], incomplete: refusedFamilies },
  new Map(refusedFamilies.map((plan) => [plan.stateKey, ["refused"]])),
);
assert.deepEqual(refusedSettlement.reconciliations, []);
assert.equal(refusedSettlement.intentionalRemovalUids.length, 101);
const refusedPlan = buildDriveRemovalPlan({
  storedFamilies: refusedFamilies.map((plan) => plan.base_doc_uid),
  activeFamilies: refusedFamilies.map((plan) => plan.base_doc_uid),
  policyCandidates: [],
  vanishedCandidates: [],
  intentionalCandidates: refusedSettlement.intentionalRemovalUids,
});
assert.equal(refusedPlan.total, 101);
assert.equal(refusedPlan.tooLarge, true);
assert.ok(errorMessage(refusedPlan), "101 pre-existing refused families must stop at the aggregate guard");

const failedSettlement = remoteFamilySettlement(
  { completed: [], incomplete: refusedFamilies },
  new Map(refusedFamilies.map((plan) => [plan.stateKey, ["failed"]])),
);
assert.deepEqual(failedSettlement.reconciliations, []);
assert.deepEqual(failedSettlement.intentionalRemovalUids, []);

const acceptedFamily = refusedFamilies[0];
const completedSettlement = remoteFamilySettlement(
  { completed: [acceptedFamily], incomplete: [] },
  new Map(),
);
assert.deepEqual(completedSettlement.reconciliations, [{
  base_doc_uid: acceptedFamily.base_doc_uid,
  keep_doc_uids: acceptedFamily.keep_doc_uids,
}]);

/* The approval identity is canonical, opaque, and binds both target and category. */
const reorderedPlan = buildDriveRemovalPlan({
  storedFamilies: ["drive:untouched", "drive:overlap", "drive:skip", "drive:deleted", "drive:policy"],
  policyCandidates: ["drive:policy", "drive:overlap", "drive:not-stored-policy"],
  vanishedCandidates: ["drive:not-stored-deleted", "drive:overlap", "drive:deleted", "drive:deleted"],
  intentionalCandidates: ["drive:overlap", "drive:skip"],
});
assert.match(overlapPlan.fingerprint, /^[a-f0-9]{64}$/);
assert.equal(reorderedPlan.fingerprint, overlapPlan.fingerprint);

const fingerprintFixture = {
  storedFamilies: ["drive:a", "drive:b", ...ids("drive:retained", 18)],
  policyCandidates: ["drive:a"],
  vanishedCandidates: [],
  intentionalCandidates: [],
};
const targetChanged = buildDriveRemovalPlan({
  ...fingerprintFixture,
  policyCandidates: ["drive:b"],
});
const categoryChanged = buildDriveRemovalPlan({
  ...fingerprintFixture,
  policyCandidates: [],
  vanishedCandidates: ["drive:a"],
});
assert.notEqual(buildDriveRemovalPlan(fingerprintFixture).fingerprint, targetChanged.fingerprint);
assert.notEqual(buildDriveRemovalPlan(fingerprintFixture).fingerprint, categoryChanged.fingerprint);

/* The limits are strict exceedance checks, with count and ratio enforced independently. */
const emptyPlan = buildDriveRemovalPlan({
  storedFamilies: [],
  policyCandidates: [],
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(emptyPlan.total, 0);
assert.equal(emptyPlan.ratio, 0);
assert.equal(emptyPlan.tooLarge, false);
assert.doesNotThrow(() => assertDriveRemovalPlanSafe(emptyPlan));

const smallStored = ids("drive:small", 20);
const smallPlan = buildDriveRemovalPlan({
  storedFamilies: smallStored,
  policyCandidates: [smallStored[0]],
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(smallPlan.ratio, 0.05);
assert.equal(smallPlan.tooLarge, false);
assert.doesNotThrow(() => assertDriveRemovalPlanSafe(smallPlan));

const boundaryStored = ids("drive:boundary", 1_000);
const boundaryPlan = buildDriveRemovalPlan({
  storedFamilies: boundaryStored,
  policyCandidates: boundaryStored.slice(0, 100),
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(boundaryPlan.total, 100);
assert.equal(boundaryPlan.ratio, 0.10);
assert.equal(boundaryPlan.tooLarge, false);
assert.doesNotThrow(() => assertDriveRemovalPlanSafe(boundaryPlan));

const countStored = ids("drive:count", 2_000);
const countLimitedPlan = buildDriveRemovalPlan({
  storedFamilies: countStored,
  policyCandidates: countStored.slice(0, 101),
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(countLimitedPlan.total, 101);
assert.ok(countLimitedPlan.ratio < DRIVE_REMOVAL_MAX_RATIO);
assert.equal(countLimitedPlan.tooLarge, true);

const ratioStored = ids("drive:ratio", 10);
const ratioLimitedPlan = buildDriveRemovalPlan({
  storedFamilies: ratioStored,
  policyCandidates: ratioStored.slice(0, 2),
  vanishedCandidates: [],
  intentionalCandidates: [],
});
assert.equal(ratioLimitedPlan.total, 2);
assert.equal(ratioLimitedPlan.ratio, 0.20);
assert.equal(ratioLimitedPlan.tooLarge, true);

const oneTypedPlan = buildDriveRemovalPlan({
  storedFamilies: ["gmail:one"],
  policyCandidates: [],
  vanishedCandidates: ["gmail:one"],
  intentionalCandidates: [],
}, { ratioFloorCount: 1, fingerprintContext: "gmail-current-typed" });
assert.equal(oneTypedPlan.ratio, 1);
assert.equal(oneTypedPlan.tooLarge, false);
assert.notEqual(oneTypedPlan.fingerprint, buildDriveRemovalPlan({
  storedFamilies: ["gmail:one"],
  policyCandidates: [],
  vanishedCandidates: ["gmail:one"],
  intentionalCandidates: [],
}, { fingerprintContext: "gmail-strict" }).fingerprint);

let gmailRefusal = null;
try {
  assertDriveRemovalPlanSafe(ratioLimitedPlan, null, { sourceLabel: "Gmail" });
} catch (error) {
  gmailRefusal = error.message;
}
assert.match(gmailRefusal || "", /^Gmail cleanup would remove/);

/* A refusal is aggregate-only and tells the operator how to approve this exact plan. */
const rawUids = {
  source_policy: "drive:RAW_POLICY_UID_DO_NOT_PRINT",
  source_deleted: "drive:RAW_DELETED_UID_DO_NOT_PRINT",
  intentional_skip: "drive:RAW_SKIP_UID_DO_NOT_PRINT",
};
const approvalStored = [...Object.values(rawUids), ...ids("drive:approval-retained", 17)];
const approvalPlan = buildDriveRemovalPlan({
  storedFamilies: approvalStored,
  policyCandidates: [rawUids.source_policy],
  vanishedCandidates: [rawUids.source_deleted],
  intentionalCandidates: [rawUids.intentional_skip],
});
assert.equal(approvalPlan.total, 3);
assert.equal(approvalPlan.stored, 20);
assert.equal(approvalPlan.tooLarge, true);

const refusal = errorMessage(approvalPlan);
assert.ok(refusal, "an unusually large plan must be refused without approval");
assert.ok(reportsCount(refusal, "source[_\\s-]*policy", 1), refusal);
assert.ok(reportsCount(refusal, "source[_\\s-]*(?:deleted|deletion)", 1), refusal);
assert.ok(reportsCount(refusal, "intentional[_\\s-]*skip", 1), refusal);
assert.ok(
  (reportsCount(refusal, "total", 3) && reportsCount(refusal, "stored", 20)) ||
    /remove[^0-9]{0,16}3[^0-9]{0,16}of[^0-9]{0,16}20[^0-9]{0,16}stored/i.test(refusal),
  refusal,
);
assert.match(refusal, /nothing[^\n.]{0,80}(?:was |has been )?removed/i);
assert.match(refusal, /cursor (?:was |is )?(?:not advanced|withheld)/i);
assert.ok(refusal.includes(`--approve-removals ${approvalPlan.fingerprint}`), refusal);
for (const uid of Object.values(rawUids)) assert.ok(!refusal.includes(uid), refusal);

assert.doesNotThrow(() => assertDriveRemovalPlanSafe(approvalPlan, approvalPlan.fingerprint));
const wrongFingerprint = `${approvalPlan.fingerprint.slice(0, -1)}${approvalPlan.fingerprint.endsWith("0") ? "1" : "0"}`;
for (const malformed of [undefined, true, "", "not-a-sha256", wrongFingerprint, ` ${approvalPlan.fingerprint}`]) {
  assert.ok(errorMessage(approvalPlan, malformed), `approval ${JSON.stringify(malformed)} must not bypass the guard`);
}

/*
 * The real CLI path must preserve that ordering across process boundaries.
 * This fixture runs a due full sweep against 101 simulated stored families and
 * an empty Drive listing. It also injects one bounded forget failure so the
 * partial-write retry has to build and approve a fresh aggregate plan.
 */
{
  const directory = mkdtempSync(join(tmpdir(), "brain-drive-removal-guard-"));
  const manifestPath = join(directory, "fixture.manifest.json");
  const statePath = join(directory, ".brain-ingest-drive.json");
  const evidencePath = join(directory, "guard-evidence.json");
  const userRoot = join(directory, "isolated-user-root");
  const tokenRoot = join(userRoot, ".brain");
  const priorCursor = "fixture-prior-cursor";
  const priorFullSweep = "2000-01-01T00:00:00.000Z";
  const scannerFingerprint = credentialScannerFingerprint(true);
  const policyFingerprint = drivePolicyFingerprint({
    // Must match the manifest below: reviewed roots are part of the policy
    // identity now, so a fingerprint computed without them is a different one.
    rootFolderIds: ["root-fixture"],
    excludeFileIds: [],
    excludePaths: [],
    excludeNameParts: [],
    privatePrefixes: [],
  }, true);

  const stripAnsi = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
  const safeDiagnostic = (value) => stripAnsi(value)
    .replace(/drive:guard-family-[0-9]+/g, "[redacted-family]")
    .slice(-1_200);
  const assertNoFamilyLeak = (output) => {
    assert.equal(
      String(output).includes("drive:guard-family-"),
      false,
      "Drive guard CLI output exposed a document-family identifier",
    );
  };
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const readEvidence = () => JSON.parse(readFileSync(evidencePath, "utf8"));
  const assertCursorWithheld = () => {
    const state = readState();
    assert.equal(state.sync_token, priorCursor, "a stopped Drive run advanced its sync token");
    assert.equal(state.drive_policy_fingerprint, policyFingerprint, "a stopped Drive run changed its policy fingerprint");
    assert.equal(
      state.credential_scanner_fingerprint,
      scannerFingerprint,
      "a stopped Drive run changed its scanner fingerprint",
    );
    assert.equal(state.drive_last_full_sweep_at, priorFullSweep, "a stopped Drive run completed its full-sweep checkpoint");
    return state;
  };
  const approvalFrom = (output) => {
    const match = /--approve-removals ([0-9a-f]{64})/.exec(output);
    assert.ok(match, `stopped Drive run did not print an approval fingerprint:\n${safeDiagnostic(output)}`);
    return match[1];
  };

  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  Object.assign(environment, {
    NO_COLOR: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    BRAIN_DRIVE_GUARD_USER_ROOT: userRoot,
    BRAIN_DRIVE_GUARD_EVIDENCE: evidencePath,
    ADMIN_KEY: "fixture-admin",
  });

  const run = (extra = []) => {
    const result = spawnSync(process.execPath, [
      "--import", DRIVE_GUARD_FETCH,
      CLI, "ingest", manifestPath, "--from", "drive", ...extra,
    ], { encoding: "utf8", env: environment, timeout: 30_000 });
    assert.equal(result.error, undefined, String(result.error || ""));
    assert.equal(result.signal, null, `Drive guard CLI was terminated by ${result.signal}`);
    return { code: result.status, output: stripAnsi(`${result.stdout || ""}${result.stderr || ""}`) };
  };

  try {
    mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      corpora: { google_drive: { root_folder_ids: ["root-fixture"] } },
    }));
    writeFileSync(join(tokenRoot, "google-tokens.json"), JSON.stringify({
      google: {
        client_id: "fixture-client",
        client_secret: null,
        refresh_token: "fixture-refresh",
        scopes: ["drive"],
      },
    }), { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      done: {},
      skipped: {},
      sync_token: priorCursor,
      drive_policy_fingerprint: policyFingerprint,
      credential_scanner_fingerprint: scannerFingerprint,
      drive_last_full_sweep_at: priorFullSweep,
    }), { mode: 0o600 });

    const stopped = run();
    assert.equal(stopped.code, 1, safeDiagnostic(stopped.output));
    assertNoFamilyLeak(stopped.output);
    assert.match(stopped.output, /review required/i);
    assert.doesNotMatch(stopped.output, /unexpected error|This is a bug in the installer/i);
    const initialApproval = approvalFrom(stopped.output);
    const supportBytes = previewSupportJournal({ root: userRoot });
    const supportEvents = supportBytes.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(supportEvents.length, 1, supportBytes);
    assert.equal(supportEvents[0].command, "ingest");
    assert.equal(supportEvents[0].source, "drive");
    assert.equal(supportEvents[0].error_code, "SAFETY_REVIEW_REQUIRED");
    assert.deepEqual(Object.keys(supportEvents[0]), [
      "schema_version", "event_id", "timestamp", "product_version", "platform",
      "arch", "node_major", "command", "source", "error_code", "fingerprint",
    ]);
    assertNoFamilyLeak(supportBytes);
    assert.equal(supportBytes.includes(initialApproval), false, "support note retained the removal approval fingerprint");
    assertCursorWithheld();
    let evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 0, "an unapproved plan reached the forget route");
    assert.equal(evidence.removalRequests, 0, "an unapproved plan made a removal write");
    assert.equal(evidence.reconciliationRequests, 0, "an unapproved plan made a reconciliation write");
    assert.equal(evidence.ingestBatchWrites, 0, "the empty Drive walk unexpectedly wrote an ingest batch");
    assert.deepEqual(evidence.lastErrorReceipt, {
      issue_code: "SAFETY_REVIEW_REQUIRED",
      has_error: false,
      has_detail: false,
    }, "the real Drive catch did not preserve the safety stop as a private-text-free review receipt");

    const wrongApproval = `${initialApproval.slice(0, -1)}${initialApproval.endsWith("0") ? "1" : "0"}`;
    const wrong = run(["--approve-removals", wrongApproval]);
    assert.equal(wrong.code, 1, safeDiagnostic(wrong.output));
    assertNoFamilyLeak(wrong.output);
    assert.equal(approvalFrom(wrong.output), initialApproval, "a wrong approval changed an otherwise identical plan");
    assertCursorWithheld();
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 0, "a wrong fingerprint reached the forget route");
    assert.equal(evidence.removalRequests, 0, "a wrong fingerprint made a removal write");
    assert.equal(evidence.reconciliationRequests, 0, "a wrong fingerprint made a reconciliation write");

    // The first exact approval is valid, but its first bounded deletion gets a
    // synthetic 503. Later groups succeed, creating the mixed-write state that
    // must remain cursor-safe and retry through the aggregate guard.
    const interrupted = run(["--approve-removals", initialApproval]);
    assert.equal(interrupted.code, 1, safeDiagnostic(interrupted.output));
    assertNoFamilyLeak(interrupted.output);
    assert.match(interrupted.output, /source cursor was not advanced/i);
    const interruptedState = assertCursorWithheld();
    assert.equal(Object.keys(interruptedState.removed || {}).length, 50, "failed removals were not retained for retry");
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 3, "the approved plan did not use bounded removal groups");
    assert.equal(evidence.removalRequests, 3, "approved deletion calls were not classified as removals");
    assert.equal(evidence.reconciliationRequests, 0, "the removal path performed an unrelated reconciliation");
    assert.equal(evidence.successfulRemovalFamilies, 51, "successful partial removals were not preserved");
    assert.equal(evidence.failedRemovalFamilies, 50, "the failed bounded group was not recorded by the fixture");

    const retryStopped = run();
    assert.equal(retryStopped.code, 1, safeDiagnostic(retryStopped.output));
    assertNoFamilyLeak(retryStopped.output);
    const retryApproval = approvalFrom(retryStopped.output);
    assert.notEqual(retryApproval, initialApproval, "partial writes did not produce a fresh exact-plan fingerprint");
    const retryState = assertCursorWithheld();
    assert.equal(Object.keys(retryState.removed || {}).length, 50, "a guarded retry discarded pending removals");
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 3, "a failed removal retry bypassed the approval guard");
    assert.equal(evidence.reconciliationRequests, 0, "a failed removal retry bypassed the guard through reconciliation");

    const completed = run(["--approve-removals", retryApproval]);
    assert.equal(completed.code, 0, safeDiagnostic(completed.output));
    assertNoFamilyLeak(completed.output);
    const completedState = readState();
    assert.equal(completedState.sync_token, "fixture-next-cursor", "exact retry approval did not advance the Drive cursor");
    assert.equal(completedState.drive_policy_fingerprint, policyFingerprint);
    assert.equal(completedState.credential_scanner_fingerprint, scannerFingerprint);
    assert.notEqual(completedState.drive_last_full_sweep_at, priorFullSweep, "successful cleanup did not complete the full sweep");
    assert.ok(Number.isFinite(Date.parse(completedState.drive_last_full_sweep_at)), "full-sweep checkpoint is not an ISO date");
    assert.equal(Object.keys(completedState.removed || {}).length, 0, "successful cleanup left pending removal markers");
    evidence = readEvidence();
    assert.equal(evidence.forgetRequests, 4, "exact retry approval did not perform the remaining bounded deletion");
    assert.equal(evidence.removalRequests, 4);
    assert.equal(evidence.reconciliationRequests, 0);
    assert.equal(evidence.successfulRemovalFamilies, 101, "exact approvals did not delete the complete oversized plan");
    assert.equal(evidence.ingestBatchWrites, 0);
    assert.equal(evidence.receipts.ready, 1, "only the completed run should close as ready");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/*
 * Drive changes are account-wide. Changed files must be re-enumerated through
 * reviewed roots, while removed or omitted stored files need typed metadata
 * evidence before they can enter the deletion plan.
 */
{
  const scannerFingerprint = credentialScannerFingerprint(true);
  const policyFingerprint = drivePolicyFingerprint({
    rootFolderIds: ["root-fixture"],
    excludeFileIds: [],
    excludePaths: [],
    excludeNameParts: [],
    privatePrefixes: [],
  }, true);
  const stripAnsi = (value) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");

  const runScopeScenario = (mode, { full = false } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), `brain-drive-scope-${mode}-`));
    const manifestPath = join(directory, "fixture.manifest.json");
    const statePath = join(directory, ".brain-ingest-drive.json");
    const evidencePath = join(directory, "scope-evidence.json");
    const userRoot = join(directory, "isolated-user-root");
    const tokenRoot = join(userRoot, ".brain");
    const priorCursor = `fixture-prior-${mode}`;
    const priorFullSweep = full ? "2000-01-01T00:00:00.000Z" : new Date().toISOString();
    const environment = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    Object.assign(environment, {
      NO_COLOR: "1",
      BRAIN_GOOGLE_TOKEN_STORE: "file",
      BRAIN_DRIVE_SCOPE_USER_ROOT: userRoot,
      BRAIN_DRIVE_SCOPE_EVIDENCE: evidencePath,
      BRAIN_DRIVE_SCOPE_MODE: mode,
      ADMIN_KEY: "fixture-admin",
    });

    mkdirSync(tokenRoot, { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      corpora: { google_drive: { root_folder_ids: ["root-fixture"] } },
    }));
    writeFileSync(join(tokenRoot, "google-tokens.json"), JSON.stringify({
      google: {
        client_id: "fixture-client",
        client_secret: null,
        refresh_token: "fixture-refresh",
        scopes: ["drive"],
      },
    }), { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      done: {},
      skipped: {},
      sync_token: priorCursor,
      drive_policy_fingerprint: policyFingerprint,
      credential_scanner_fingerprint: scannerFingerprint,
      drive_last_full_sweep_at: priorFullSweep,
      drive_folders: {
        "root-fixture": { name: "Reviewed Root", parents: [] },
      },
    }), { mode: 0o600 });

    const result = spawnSync(process.execPath, [
      "--import", DRIVE_SCOPE_FETCH,
      CLI, "ingest", manifestPath, "--from", "drive",
    ], { encoding: "utf8", env: environment, timeout: 30_000 });
    assert.equal(result.error, undefined, String(result.error || ""));
    assert.equal(result.signal, null, `Drive scope CLI was terminated by ${result.signal}`);
    return {
      code: result.status,
      output: stripAnsi(`${result.stdout || ""}${result.stderr || ""}`),
      priorCursor,
      priorFullSweep,
      state: () => JSON.parse(readFileSync(statePath, "utf8")),
      evidence: () => JSON.parse(readFileSync(evidencePath, "utf8")),
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  };

  const changedOutside = runScopeScenario("changed-outside");
  try {
    assert.equal(changedOutside.code, 0, changedOutside.output);
    assert.match(changedOutside.output, /rooted full comparison before reading content/i);
    const evidence = changedOutside.evidence();
    assert.equal(evidence.changesReads, 1);
    assert.equal(evidence.rootedWalks, 1, "an account-wide changed item did not trigger a rooted walk");
    assert.equal(evidence.outsideContentReads, 0, "an out-of-root changed file reached the content boundary");
    assert.equal(evidence.ingestBatchWrites, 0, "an out-of-root changed file reached ingest");
    assert.equal(evidence.forgetRequests, 0);
    const state = changedOutside.state();
    assert.equal(state.sync_token, "fixture-next-changed-outside");
    assert.notEqual(state.drive_last_full_sweep_at, changedOutside.priorFullSweep);
  } finally {
    changedOutside.cleanup();
  }

  for (const [mode, full] of [["full-unresolved", true], ["incremental-unresolved", false]]) {
    const unresolved = runScopeScenario(mode, { full });
    try {
      assert.equal(unresolved.code, 1, unresolved.output);
      assert.match(unresolved.output, /could not distinguish deletion from permission loss/i);
      assert.equal(unresolved.output.includes("missing-sensitive"), false, "ambiguous Drive id leaked to CLI output");
      const evidence = unresolved.evidence();
      assert.equal(evidence.absenceMetadataReads, 1, `${mode} did not classify the missing stored file`);
      assert.equal(evidence.rootedWalks, full ? 1 : 0);
      assert.equal(evidence.ingestBatchWrites, 0, "ambiguous absence allowed content writes");
      assert.equal(evidence.forgetRequests, 0, "ambiguous absence reached the destructive endpoint");
      assert.equal(evidence.receipts.error, 1, "ambiguous absence did not close its receipt as an error");
      const state = unresolved.state();
      assert.equal(state.sync_token, unresolved.priorCursor, "ambiguous absence advanced the Drive cursor");
      assert.equal(state.drive_last_full_sweep_at, unresolved.priorFullSweep,
        "ambiguous absence completed a full-sweep checkpoint");
    } finally {
      unresolved.cleanup();
    }
  }

  for (const mode of ["incremental-trash", "incremental-left-scope"]) {
    const confirmed = runScopeScenario(mode);
    try {
      assert.equal(confirmed.code, 0, confirmed.output);
      const evidence = confirmed.evidence();
      assert.equal(evidence.absenceMetadataReads, 1, `${mode} did not classify the removed file`);
      assert.equal(evidence.rootedWalks, 0, `${mode} unexpectedly required a full walk`);
      assert.equal(evidence.forgetRequests, 1, `${mode} did not reach the guarded removal plan`);
      assert.equal(evidence.removedFamilies, 1);
      assert.equal(evidence.inventoryReads, 2, "confirmed removal lacked exact inventory readback");
      assert.equal(evidence.ingestBatchWrites, 0);
      const state = confirmed.state();
      assert.equal(state.sync_token, `fixture-next-${mode}`);
      assert.equal(state.drive_last_full_sweep_at, confirmed.priorFullSweep,
        "an incremental classified removal rewrote the full-sweep checkpoint");
    } finally {
      confirmed.cleanup();
    }
  }
}

/* CLI wiring keeps the aggregate approval guard ahead of every planned deletion. */
assert.ok(VALUE_FLAGS.has("approve-removals"), "a bare --approve-removals must be rejected as a missing value");
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");
const remoteStart = source.indexOf("async function cmdIngestRemote(");
const remoteEnd = source.indexOf("\nasync function ", remoteStart + 1);
assert.notEqual(remoteStart, -1, "cmdIngestRemote must exist");
const remote = source.slice(remoteStart, remoteEnd === -1 ? source.length : remoteEnd);
const consumeStart = remote.indexOf("const consumeGroup = async (group) => {");
const consumeEnd = remote.indexOf("\n  try {\n  if (!dry)", consumeStart);
assert.ok(consumeStart !== -1 && consumeEnd > consumeStart, "remote group consumer must be inspectable");
const consumeGroup = remote.slice(consumeStart, consumeEnd);
assert.doesNotMatch(
  consumeGroup,
  /outcome\.incomplete[\s\S]{0,240}keep_doc_uids:\s*\[\]/,
  "an incomplete remote family must never be immediately reconciled to empty",
);
assert.doesNotMatch(
  consumeGroup,
  /catch \(error\)[\s\S]{0,500}keep_doc_uids:\s*\[\]/,
  "a thrown remote batch must preserve the prior family for retry",
);

const buildMatch = /const\s+([A-Za-z_$][\w$]*)\s*=\s*buildDriveRemovalPlan\s*\(\s*\{/.exec(remote);
assert.ok(buildMatch, "Drive ingest must build one aggregate removal plan");
const planName = buildMatch[1];
const buildIndex = buildMatch.index;
const assertIndex = remote.indexOf(`assertDriveRemovalPlanSafe(${planName}`, buildIndex);
const firstTargetUseIndex = remote.indexOf(`${planName}.targets`, buildIndex);
const targetUseIndex = remote.indexOf(`${planName}.targets[category]`, assertIndex);
const applicationIndex = remote.lastIndexOf("applyDriveRemovals(", targetUseIndex);
assert.ok(assertIndex > buildIndex, "the aggregate Drive removal plan must be checked");
assert.ok(firstTargetUseIndex > assertIndex, "plan targets must not be read before the guard passes");
assert.ok(
  applicationIndex > assertIndex && applicationIndex < targetUseIndex,
  "only guarded plan targets may reach Drive removal",
);
const readbackIndex = remote.indexOf("const afterRemoval = await listStoredSourceFamilies", targetUseIndex);
const cursorPlanIndex = remote.indexOf("pendingCursor = {", readbackIndex);
assert.ok(
  readbackIndex > targetUseIndex,
  "planned Drive removals must be checked against a fresh stored-family inventory",
);
assert.ok(
  cursorPlanIndex > readbackIndex,
  "the Drive cursor plan must remain withheld until deletion readback succeeds",
);

const buildCall = remote.slice(buildIndex, assertIndex);
for (const field of ["storedFamilies", "activeFamilies", "policyCandidates", "vanishedCandidates", "intentionalCandidates"]) {
  assert.match(buildCall, new RegExp(`\\b${field}\\b`), `aggregate Drive removal plan is missing ${field}`);
}
const approvalCall = remote.slice(assertIndex, targetUseIndex);
assert.match(approvalCall, /(?:flags\["approve-removals"\]|removalApproval)/,
  "the CLI approval value must reach the aggregate guard");
if (/\bremovalApproval\b/.test(approvalCall)) {
  const approvalAssignment = remote.indexOf('const removalApproval = flags["approve-removals"]');
  const approvalValidation = remote.indexOf("typeof removalApproval", approvalAssignment);
  assert.ok(
    approvalAssignment !== -1 && approvalAssignment < approvalValidation && approvalValidation < buildIndex &&
      remote.slice(approvalValidation, buildIndex).includes("/^[0-9a-f]{64}$/"),
    "the approval alias must be the validated lowercase SHA-256 CLI value",
  );
}

const outerCatchIndex = remote.lastIndexOf("} catch (error) {");
assert.notEqual(outerCatchIndex, -1, "cmdIngestRemote must keep its outer failure receipt path");
const outerCatch = remote.slice(outerCatchIndex);
if (/flushIntentionalRemovals/.test(outerCatch)) {
  assert.match(
    outerCatch,
    /if\s*\(\s*which\s*===\s*"imap"[^)]*\)\s*\{[\s\S]*?flushIntentionalRemovals/,
    "Drive and Gmail failure cleanup must not bypass their aggregate guards by deleting intentional skips",
  );
}

/* Watched-folder deletion uses the same authenticated truth and readback. */
const localStart = source.indexOf("export async function cmdIngestLocal(");
const localEnd = source.indexOf("\nexport function validateForgetReceipt", localStart);
assert.notEqual(localStart, -1, "local folder ingest must exist");
assert.ok(localEnd > localStart, "local folder ingest must be inspectable");
const local = source.slice(localStart, localEnd);
const pendingIndex = local.indexOf("const pendingLocalUids");
const localInventoryIndex = local.indexOf("const storedLocalFamilies = await listStoredSourceFamilies", pendingIndex);
const localBuildIndex = local.indexOf("const localRemovalPlan = buildDriveRemovalPlan", localInventoryIndex);
const localGuardIndex = local.indexOf("assertDriveRemovalPlanSafe(localRemovalPlan", localBuildIndex);
const localTargetsIndex = local.indexOf("const localTruthTargets", localGuardIndex);
const localApplyIndex = local.indexOf("uids: localTruthTargets", localTargetsIndex);
const localReadbackIndex = local.indexOf("const afterLocalRemoval = await listStoredSourceFamilies", localApplyIndex);
assert.ok(
  pendingIndex !== -1 && localInventoryIndex > pendingIndex && localBuildIndex > localInventoryIndex,
  "local removal retries must re-enter a plan built from authenticated stored families",
);
assert.doesNotMatch(
  local.slice(pendingIndex, localBuildIndex),
  /applyDriveRemovals\s*\(/,
  "a pending local removal must not bypass the current authenticated plan",
);
assert.match(
  local.slice(localBuildIndex, localGuardIndex),
  /storedFamilies:\s*storedLocalFamilies/,
  "local deletion must not use the resume file as its stored-family denominator",
);
assert.ok(
  localGuardIndex > localBuildIndex && localTargetsIndex > localGuardIndex && localApplyIndex > localTargetsIndex,
  "only guarded local plan targets may reach the destructive endpoint",
);
assert.match(
  local.slice(localTargetsIndex, localApplyIndex),
  /localRemovalPlan\.targets\.source_policy[\s\S]*localRemovalPlan\.targets\.intentional_skip/,
  "local source-truth deletion must use the exact categorized plan targets",
);
assert.ok(
  localReadbackIndex > localApplyIndex,
  "local folder deletion must read authenticated storage back before recording completion",
);
assert.match(
  local.slice(localReadbackIndex),
  /stillStored[\s\S]*state\.removed[\s\S]*throw new Error/,
  "a failed local deletion readback must retain retry state and fail the source run",
);

console.log("drive removal guard: all focused tests passed");
