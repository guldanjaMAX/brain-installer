import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VERIFIED_RECOVERY_STAGES,
  assertVerifiedRecoveryManifestBindings,
  buildVerifiedRecoveryPlan,
  initializeVerifiedRecovery,
  loadVerifiedRecoveryPlan,
  loadVerifiedRecoveryState,
  parseVerifiedRecoveryCliArguments,
  runVerifiedRecovery,
  validateVerifiedRecoveryPlan,
  validateVerifiedRecoveryState,
  verifiedRecoveryStatus,
  writeVerifiedRecoveryPlan,
  writeVerifiedRecoveryState,
} from "../operations/verified-recovery.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-verified-recovery-"));
const sourcePath = join(sandbox, "source.manifest.json");
const targetPath = join(sandbox, "target.manifest.json");
const planPath = join(sandbox, ".brain-recovery-plan.json");
const statePath = join(sandbox, ".brain-recovery-state.json");
const sentinel = "fixture-private-value-must-never-escape";

const sourceManifest = {
  manifest_version: 1,
  client: { slug: "fixture-brain", display_name: "Synthetic Fixture" },
  brain: {
    version: "0.1.12",
    worker_name: "fixture-source-worker",
    domain: "source.fixture.invalid",
  },
  infrastructure: {
    cloudflare: {
      storage: "d1",
      account_id: "fixture-account-a",
      d1_database_name: "fixture-source-d1",
      d1_database_id: "fixture-source-database-id",
      vectorize_index: "fixture-source-vector",
    },
  },
  retrieval: {
    embed_model: "@cf/baai/bge-base-en-v1.5",
    embed_dimensions: 768,
  },
  _private_fixture: sentinel,
};

const targetManifest = {
  ...structuredClone(sourceManifest),
  brain: {
    ...sourceManifest.brain,
    worker_name: "fixture-recovery-worker",
    domain: "recovery.fixture.invalid",
  },
  infrastructure: {
    cloudflare: {
      ...sourceManifest.infrastructure.cloudflare,
      d1_database_name: "fixture-recovery-d1",
      d1_database_id: "fixture-recovery-database-id",
      vectorize_index: "fixture-recovery-vector",
    },
  },
};

function writeJson(path, value, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== "win32") chmodSync(path, mode);
}

let variantNumber = 0;
function manifestVariant(base, mutate) {
  const value = structuredClone(base);
  mutate(value);
  const path = join(sandbox, `variant-${++variantNumber}.manifest.json`);
  writeJson(path, value);
  return path;
}

function clock(start = Date.parse("2026-08-25T12:00:00.000Z")) {
  let value = start;
  return () => {
    const result = new Date(value);
    value += 1000;
    return result;
  };
}

const artifactHash = "a".repeat(64);
const schemaHash = "b".repeat(64);
const aggregateHash = "c".repeat(64);
const contentHash = "d".repeat(64);

function evidenceFor(stage, context, override = {}) {
  const values = {
    export_d1: {
      artifact_sha256: artifactHash,
      artifact_bytes: 4096,
    },
    verify_export: {
      artifact_sha256: artifactHash,
      artifact_bytes: 4096,
      integrity: "ok",
      schema_fingerprint: schemaHash,
      aggregate_fingerprint: aggregateHash,
      content_fingerprint: contentHash,
      document_count: 3,
      chunk_count: 5,
      fts_count: 5,
    },
    prove_target_clean: {
      target_resource_fingerprint: context.targetResourceFingerprint,
      user_table_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
    },
    restore_d1: {
      artifact_sha256: artifactHash,
      import_completed: true,
    },
    verify_d1: {
      integrity: "ok",
      schema_fingerprint: schemaHash,
      aggregate_fingerprint: aggregateHash,
      content_fingerprint: contentHash,
      document_count: 3,
      chunk_count: 5,
      fts_count: 5,
    },
    rebuild_vectorize: {
      chunk_count: 5,
      vector_count: 5,
      pending_outbox: 0,
      failed_vectors: 0,
    },
    verify_health: {
      status: "pass",
      failure_count: 0,
      vector_backlog: 0,
    },
    verify_eval: {
      profile: "release",
      status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
    },
  };
  return { ...values[stage], ...override };
}

function goodAdapters(calls = [], overrides = {}) {
  return Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [
    id,
    async (context) => {
      calls.push(id);
      if (overrides[id] instanceof Error) throw overrides[id];
      return evidenceFor(id, context, overrides[id] || {});
    },
  ]));
}

try {
  writeJson(sourcePath, sourceManifest);
  writeJson(targetPath, targetManifest);

  const createdAt = new Date("2026-08-25T11:00:00.000Z");
  const plan = buildVerifiedRecoveryPlan(sourcePath, targetPath, { now: createdAt });
  assert.equal(plan.created_at, createdAt.toISOString());
  assert.match(plan.plan_fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.stages, VERIFIED_RECOVERY_STAGES);
  assert.equal(plan.artifact.format, "cloudflare_d1_full_sql");
  assert.equal(plan.artifact.relative_name, ".brain-recovery-export.sql");
  assert.equal(plan.artifact.owner_only, true);
  assert.equal(plan.isolation.required_initial_user_tables, 0);
  assert.equal(plan.isolation.required_initial_vectors, 0);
  assert.equal(plan.gates.vectorize_rebuilt_from, "d1");
  assert.equal(plan.gates.eval_profile, "release");
  assert.equal(
    assertVerifiedRecoveryManifestBindings(plan, sourcePath, targetPath),
    true,
  );

  const planText = JSON.stringify(plan);
  for (const forbidden of [
    sentinel,
    sourceManifest.infrastructure.cloudflare.account_id,
    sourceManifest.infrastructure.cloudflare.d1_database_id,
    sourceManifest.infrastructure.cloudflare.vectorize_index,
    sourceManifest.brain.domain,
    targetManifest.infrastructure.cloudflare.d1_database_id,
    targetManifest.brain.domain,
    sourcePath,
    targetPath,
  ]) assert.equal(planText.includes(forbidden), false, `plan omitted ${forbidden}`);

  const rebuilt = buildVerifiedRecoveryPlan(sourcePath, targetPath, { now: createdAt });
  assert.equal(rebuilt.plan_fingerprint, plan.plan_fingerprint);
  assert.throws(
    () => validateVerifiedRecoveryPlan({ ...plan, created_at: "2026-08-25T11:00:01.000Z" }),
    /fingerprint is invalid/,
  );

  const bindingTarget = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.d1_database_name = "fixture-binding-d1";
    value.infrastructure.cloudflare.d1_database_id = "fixture-binding-database-id";
    value.infrastructure.cloudflare.vectorize_index = "fixture-binding-vector";
    value.brain.worker_name = "fixture-binding-worker";
    value.brain.domain = "binding.fixture.invalid";
  });
  const bindingPlan = buildVerifiedRecoveryPlan(sourcePath, bindingTarget, { now: createdAt });
  writeJson(bindingTarget, {
    ...JSON.parse(readFileSync(bindingTarget, "utf8")),
    _post_review_change: true,
  });
  assert.throws(
    () => assertVerifiedRecoveryManifestBindings(bindingPlan, sourcePath, bindingTarget),
    /binding changed after plan review/,
  );

  const sameDatabase = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.d1_database_name = sourceManifest.infrastructure.cloudflare.d1_database_name;
    value.infrastructure.cloudflare.d1_database_id = sourceManifest.infrastructure.cloudflare.d1_database_id;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameDatabase), /D1 database must be distinct/);

  const sameVector = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.vectorize_index = sourceManifest.infrastructure.cloudflare.vectorize_index;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameVector), /Vectorize index must be distinct/);

  const sameWorker = manifestVariant(targetManifest, (value) => {
    value.brain.worker_name = sourceManifest.brain.worker_name;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameWorker), /Worker must be distinct/);

  const sameDomain = manifestVariant(targetManifest, (value) => {
    value.brain.domain = sourceManifest.brain.domain;
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, sameDomain), /domain must be distinct/);

  const differentRuntime = manifestVariant(targetManifest, (value) => {
    value.brain.version = "0.1.13";
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, differentRuntime), /exact runtime contract/);

  const wrongBackend = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.storage = "supabase";
  });
  assert.throws(() => buildVerifiedRecoveryPlan(sourcePath, wrongBackend), /must use Cloudflare D1/);

  const initialized = initializeVerifiedRecovery(
    sourcePath,
    targetPath,
    planPath,
    statePath,
    { now: createdAt },
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(planPath).mode & 0o777, 0o600);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  }
  assert.deepEqual(loadVerifiedRecoveryPlan(planPath), initialized.plan);
  assert.deepEqual(loadVerifiedRecoveryState(statePath, initialized.plan), initialized.state);
  assert.deepEqual(
    parseVerifiedRecoveryCliArguments(["status", planPath, statePath]),
    { command: "status", planPath, statePath },
  );
  assert.throws(
    () => parseVerifiedRecoveryCliArguments(["status", planPath, statePath, "--extra"]),
    /arguments are invalid/,
  );

  const initialState = initialized.state;
  let unvalidatedAdapterCalls = 0;
  const unvalidatedAdapters = goodAdapters([]);
  unvalidatedAdapters.export_d1 = async () => {
    unvalidatedAdapterCalls++;
    return evidenceFor("export_d1", { targetResourceFingerprint: plan.target_resource_fingerprint });
  };
  await assert.rejects(
    runVerifiedRecovery(initialized.plan, initialState, unvalidatedAdapters),
    /needs manifest revalidation/,
  );
  assert.equal(unvalidatedAdapterCalls, 0);

  const checkpointCalls = [];
  const checkpointHooks = [];
  let checkpointedState = initialState;
  const stopAfterRestore = async (stage) => {
    checkpointHooks.push(stage);
    if (stage === "restore_d1") {
      assert.equal(checkpointedState.completed.at(-1)?.id, "restore_d1");
      assert.equal(checkpointedState.current_stage, "verify_d1");
      assert.equal(checkpointedState.stage_status, "pending");
      throw new Error("intentional fixture checkpoint");
    }
  };
  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters(checkpointCalls),
      {
        clock: clock(Date.parse("2026-08-25T11:30:00.000Z")),
        revalidateManifests: async () => true,
        persistState: async (state) => { checkpointedState = state; },
        afterStageCheckpoint: stopAfterRestore,
      },
    ),
    /intentional fixture checkpoint/,
  );
  assert.deepEqual(checkpointCalls, [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
  ]);
  assert.deepEqual(checkpointHooks, checkpointCalls);
  assert.equal(checkpointedState.status, "running");
  assert.equal(checkpointedState.current_stage, "verify_d1");
  assert.equal(checkpointedState.stage_status, "pending");
  assert.equal(checkpointedState.failure, null);
  assert.deepEqual(
    checkpointedState.completed.map((entry) => entry.id),
    checkpointCalls,
  );

  const checkpointResumeCalls = [];
  const checkpointResumed = await runVerifiedRecovery(
    initialized.plan,
    checkpointedState,
    goodAdapters(checkpointResumeCalls),
    {
      clock: clock(Date.parse("2026-08-25T11:45:00.000Z")),
      revalidateManifests: async () => true,
      persistState: async (state) => { checkpointedState = state; },
      // Keeping the identical hook proves an already-checkpointed stage cannot
      // trigger again or repeat its external effect.
      afterStageCheckpoint: stopAfterRestore,
    },
  );
  assert.equal(checkpointResumed.ok, true);
  assert.deepEqual(checkpointResumeCalls, [
    "verify_d1", "rebuild_vectorize", "verify_health", "verify_eval",
  ]);
  assert.equal(checkpointedState.status, "complete");

  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters([]),
      { revalidateManifests: async () => true, afterStageCheckpoint: "restore_d1" },
    ),
    /after-stage checkpoint hook must be a function/,
  );
  await assert.rejects(
    runVerifiedRecovery(
      initialized.plan,
      initialState,
      goodAdapters([]),
      { revalidateManifests: async () => true, afterStageCheckpoint: async () => {} },
    ),
    /after-stage checkpoint hook requires durable state persistence/,
  );

  const calls = [];
  let lastPersisted = initialState;
  const completed = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    goodAdapters(calls),
    {
      clock: clock(),
      revalidateManifests: async () =>
        assertVerifiedRecoveryManifestBindings(initialized.plan, sourcePath, targetPath),
      persistState: async (state) => {
        lastPersisted = state;
        writeVerifiedRecoveryState(statePath, state, initialized.plan);
      },
    },
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.state.status, "complete");
  assert.equal(completed.state.completed.length, VERIFIED_RECOVERY_STAGES.length);
  assert.deepEqual(calls, VERIFIED_RECOVERY_STAGES.map(({ id }) => id));
  assert.equal(lastPersisted.status, "complete");
  assert.equal(loadVerifiedRecoveryState(statePath, initialized.plan).status, "complete");
  assert.equal(readdirSync(sandbox).some((name) => name.includes(".tmp")), false);

  let completedCalls = 0;
  const idempotent = await runVerifiedRecovery(initialized.plan, completed.state, new Proxy({}, {
    get() { completedCalls++; return async () => ({}); },
  }));
  assert.equal(idempotent.ok, true);
  assert.equal(completedCalls, 0);

  const failedCalls = [];
  const rawError = new Error(`provider failed with ${sentinel}`);
  const failed = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    goodAdapters(failedCalls, { restore_d1: rawError }),
    {
      clock: clock(Date.parse("2026-08-25T13:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, "RECOVERY_RESTORE_D1_FAILED");
  assert.equal(failed.state.status, "failed");
  assert.equal(failed.state.current_stage, "restore_d1");
  assert.deepEqual(failedCalls, ["export_d1", "verify_export", "prove_target_clean", "restore_d1"]);
  assert.equal(JSON.stringify(failed).includes(sentinel), false);

  const resumedCalls = [];
  const resumed = await runVerifiedRecovery(
    initialized.plan,
    failed.state,
    goodAdapters(resumedCalls),
    {
      clock: clock(Date.parse("2026-08-25T14:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumedCalls, [
    "restore_d1", "verify_d1", "rebuild_vectorize", "verify_health", "verify_eval",
  ]);

  let restoreCalls = 0;
  const dirtyTargetAdapters = goodAdapters([], {
    prove_target_clean: { user_table_count: 1 },
  });
  dirtyTargetAdapters.restore_d1 = async () => {
    restoreCalls++;
    return evidenceFor("restore_d1", { targetResourceFingerprint: plan.target_resource_fingerprint });
  };
  const dirtyTarget = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    dirtyTargetAdapters,
    {
      clock: clock(Date.parse("2026-08-25T15:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(dirtyTarget.ok, false);
  assert.equal(dirtyTarget.errorCode, "RECOVERY_PROVE_TARGET_CLEAN_FAILED");
  assert.equal(restoreCalls, 0);

  const vectorMismatch = await runVerifiedRecovery(
    initialized.plan,
    initialState,
    goodAdapters([], { rebuild_vectorize: { vector_count: 4 } }),
    {
      clock: clock(Date.parse("2026-08-25T16:00:00.000Z")),
      revalidateManifests: async () => true,
    },
  );
  assert.equal(vectorMismatch.ok, false);
  assert.equal(vectorMismatch.errorCode, "RECOVERY_REBUILD_VECTORIZE_FAILED");
  assert.equal(vectorMismatch.state.completed.some((entry) => entry.id === "verify_health"), false);

  assert.throws(
    () => validateVerifiedRecoveryState({
      ...structuredClone(initialState),
      current_stage: "restore_d1",
    }, initialized.plan),
    /current stage is inconsistent/,
  );

  const secondTarget = manifestVariant(targetManifest, (value) => {
    value.infrastructure.cloudflare.d1_database_name = "fixture-second-recovery-d1";
    value.infrastructure.cloudflare.d1_database_id = "fixture-second-recovery-id";
    value.infrastructure.cloudflare.vectorize_index = "fixture-second-recovery-vector";
    value.brain.worker_name = "fixture-second-recovery-worker";
    value.brain.domain = "second-recovery.fixture.invalid";
  });
  const driftedPlan = buildVerifiedRecoveryPlan(sourcePath, secondTarget, { now: createdAt });
  assert.throws(
    () => validateVerifiedRecoveryState(initialState, driftedPlan),
    /plan binding is invalid/,
  );

  const status = verifiedRecoveryStatus(initialized.plan, failed.state);
  assert.deepEqual(status, {
    plan_fingerprint: initialized.plan.plan_fingerprint,
    status: "failed",
    current_stage: "restore_d1",
    stage_status: "failed",
    attempt: 1,
    completed_stages: 3,
    total_stages: 8,
    failure_code: "RECOVERY_RESTORE_D1_FAILED",
  });
  const statusText = JSON.stringify(status);
  for (const forbidden of [sentinel, sourcePath, targetPath, sourceManifest.brain.domain]) {
    assert.equal(statusText.includes(forbidden), false);
  }

  const cli = spawnSync(
    process.execPath,
    [join(process.cwd(), "operations", "verified-recovery.mjs"), "status", planPath, statePath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.includes("\"status\": \"complete\""), true);
  for (const forbidden of [sentinel, sourcePath, targetPath, sourceManifest.brain.domain]) {
    assert.equal(`${cli.stdout}${cli.stderr}`.includes(forbidden), false);
  }

  assert.throws(() => writeVerifiedRecoveryPlan(planPath, initialized.plan), /already exists/);

  if (process.platform !== "win32") {
    const openDirectory = join(sandbox, "open-control-directory");
    mkdirSync(openDirectory, { mode: 0o755 });
    chmodSync(openDirectory, 0o755);
    assert.throws(
      () => writeVerifiedRecoveryPlan(join(openDirectory, "plan.json"), initialized.plan),
      /control directory is not owner-only/,
    );

    const unsafeState = join(sandbox, "unsafe-state.json");
    writeJson(unsafeState, initialState, 0o644);
    assert.throws(
      () => loadVerifiedRecoveryState(unsafeState, initialized.plan),
      /owner-only mode 0600/,
    );

    const linkTarget = join(sandbox, "link-target.json");
    writeJson(linkTarget, initialState);
    const symbolicState = join(sandbox, "symbolic-state.json");
    symlinkSync(linkTarget, symbolicState);
    assert.throws(
      () => loadVerifiedRecoveryState(symbolicState, initialized.plan),
      /bounded regular file/,
    );
    const hardState = join(sandbox, "hard-state.json");
    linkSync(linkTarget, hardState);
    assert.throws(
      () => loadVerifiedRecoveryState(hardState, initialized.plan),
      /bounded regular file/,
    );
  }

  const occupiedState = join(sandbox, "occupied-state.json");
  const partialPlan = join(sandbox, "partial-plan.json");
  writeFileSync(occupiedState, "preserve me\n", { mode: 0o600 });
  assert.throws(
    () => initializeVerifiedRecovery(
      sourcePath,
      targetPath,
      partialPlan,
      occupiedState,
      { now: createdAt },
    ),
    /already exists/,
  );
  assert.equal(existsSync(partialPlan), false);
  assert.equal(readFileSync(occupiedState, "utf8"), "preserve me\n");

  console.log("PASS  verified recovery is isolated, resumable, privacy-safe, and fully gated");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
