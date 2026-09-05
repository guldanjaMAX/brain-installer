import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  VERIFIED_RECOVERY_STAGES,
  initializeVerifiedRecovery,
  runVerifiedRecovery,
} from "../operations/verified-recovery.mjs";
import {
  BANK_ACCESS_WRAPPING_KEY_SECRET,
  LEGACY_BANK_ACCESS_KEY_VERSION,
  decryptAccessReference,
  encryptAccessReference,
  rewrapBankAccessReferences,
} from "../worker/src/lib/bank-feed.js";

const HASHES = Object.freeze({
  artifact: "a".repeat(64),
  schema: "b".repeat(64),
  aggregate: "c".repeat(64),
  content: "d".repeat(64),
});

function manifest(suffix) {
  const safeSuffix = suffix.replaceAll("_", "-");
  return {
    manifest_version: 1,
    client: { slug: "mutation-fixture", display_name: "Mutation Fixture" },
    brain: {
      version: "0.2.1",
      worker_name: `mutation-${safeSuffix}-worker`,
      domain: `${safeSuffix}.fixture.invalid`,
    },
    infrastructure: {
      cloudflare: {
        storage: "d1",
        account_id: `mutation-${safeSuffix}-account`,
        d1_database_name: `mutation-${safeSuffix}-d1`,
        d1_database_id: `mutation-${safeSuffix}-database-id`,
        vectorize_index: `mutation-${safeSuffix}-vector`,
      },
    },
    retrieval: {
      embed_model: "@cf/baai/bge-base-en-v1.5",
      embed_dimensions: 768,
    },
  };
}

function evidenceFor(stage, context) {
  const snapshot = {
    integrity: "ok",
    schema_fingerprint: HASHES.schema,
    aggregate_fingerprint: HASHES.aggregate,
    content_fingerprint: HASHES.content,
    document_count: 3,
    chunk_count: 5,
    fts_count: 5,
  };
  return {
    export_d1: { artifact_sha256: HASHES.artifact, artifact_bytes: 4096 },
    verify_export: {
      artifact_sha256: HASHES.artifact,
      artifact_bytes: 4096,
      ...snapshot,
    },
    prove_target_clean: {
      target_resource_fingerprint: context.targetResourceFingerprint,
      user_table_count: 0,
      vector_count: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
    },
    restore_d1: { artifact_sha256: HASHES.artifact, import_completed: true },
    verify_d1: snapshot,
    reconcile_security: {
      ...snapshot,
      bank_protected: 1,
      bank_reauthorization_required: 0,
      bank_legacy_rewrap_required: 0,
      bank_unsupported_key_versions: 0,
    },
    rebuild_vectorize: {
      chunk_count: 5,
      vector_count: 5,
      pending_outbox: 0,
      failed_vectors: 0,
    },
    verify_health: { status: "pass", failure_count: 0, vector_backlog: 0 },
    verify_eval: {
      profile: "release",
      status: "pass",
      critical_failures: 0,
      unauthorized_retrievals: 0,
    },
  }[stage];
}

function clock(start) {
  let value = start;
  return () => new Date(value += 1000);
}

const mutatingStages = VERIFIED_RECOVERY_STAGES
  .filter((stage) => stage.effect !== "read_only")
  .map((stage) => stage.id);

for (const interruptedStage of mutatingStages) {
  test(`recovery reconciles a lost receipt at ${interruptedStage}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-recovery-boundary-"));
    const sourcePath = join(root, "source.json");
    const targetPath = join(root, "target.json");
    const planPath = join(root, "plan.json");
    const statePath = join(root, "state.json");
    try {
      writeFileSync(sourcePath, JSON.stringify(manifest(`${interruptedStage}-source`)), { mode: 0o600 });
      writeFileSync(targetPath, JSON.stringify(manifest(`${interruptedStage}-target`)), { mode: 0o600 });
      const initialized = initializeVerifiedRecovery(
        sourcePath,
        targetPath,
        planPath,
        statePath,
        { now: new Date("2026-08-30T12:00:00.000Z") },
      );
      const effects = new Set();
      const applications = new Map();
      const calls = new Map();
      const adapters = Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [
        id,
        async (context) => {
          calls.set(id, (calls.get(id) || 0) + 1);
          if (id === interruptedStage && !effects.has(id)) {
            effects.add(id);
            applications.set(id, (applications.get(id) || 0) + 1);
            throw new Error("synthetic lost receipt with private fixture value");
          }
          return evidenceFor(id, context);
        },
      ]));
      let persisted = initialized.state;
      const first = await runVerifiedRecovery(initialized.plan, initialized.state, adapters, {
        clock: clock(Date.parse("2026-08-30T12:01:00.000Z")),
        revalidateManifests: async () => true,
        persistState: async (state) => { persisted = state; },
      });
      assert.equal(first.ok, false);
      assert.equal(first.state.current_stage, interruptedStage);
      assert.equal(first.state.attempt, 1);
      assert.equal(JSON.stringify(first).includes("private fixture value"), false);

      const resumed = await runVerifiedRecovery(initialized.plan, persisted, adapters, {
        clock: clock(Date.parse("2026-08-30T12:10:00.000Z")),
        revalidateManifests: async () => true,
        persistState: async (state) => { persisted = state; },
      });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.state.status, "complete");
      assert.equal(applications.get(interruptedStage), 1);
      assert.equal(calls.get(interruptedStage), 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const checkpointStage of mutatingStages) {
  test(`recovery never repeats a durably checkpointed ${checkpointStage}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-recovery-checkpoint-"));
    const sourcePath = join(root, "source.json");
    const targetPath = join(root, "target.json");
    const planPath = join(root, "plan.json");
    const statePath = join(root, "state.json");
    try {
      writeFileSync(sourcePath, JSON.stringify(manifest(`${checkpointStage}-source`)), { mode: 0o600 });
      writeFileSync(targetPath, JSON.stringify(manifest(`${checkpointStage}-target`)), { mode: 0o600 });
      const initialized = initializeVerifiedRecovery(
        sourcePath,
        targetPath,
        planPath,
        statePath,
        { now: new Date("2026-08-30T13:00:00.000Z") },
      );
      const calls = new Map();
      const adapters = Object.fromEntries(VERIFIED_RECOVERY_STAGES.map(({ id }) => [
        id,
        async (context) => {
          calls.set(id, (calls.get(id) || 0) + 1);
          return evidenceFor(id, context);
        },
      ]));
      let persisted = initialized.state;
      await assert.rejects(
        runVerifiedRecovery(initialized.plan, initialized.state, adapters, {
          clock: clock(Date.parse("2026-08-30T13:01:00.000Z")),
          revalidateManifests: async () => true,
          persistState: async (state) => { persisted = state; },
          afterStageCheckpoint: async (stage) => {
            if (stage === checkpointStage) throw new Error("synthetic checkpoint stop");
          },
        }),
        /synthetic checkpoint stop/,
      );
      const callsBeforeResume = calls.get(checkpointStage);
      const resumed = await runVerifiedRecovery(initialized.plan, persisted, adapters, {
        clock: clock(Date.parse("2026-08-30T13:10:00.000Z")),
        revalidateManifests: async () => true,
        persistState: async (state) => { persisted = state; },
      });
      assert.equal(resumed.ok, true);
      assert.equal(calls.get(checkpointStage), callsBeforeResume);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function d1(db, extra = {}) {
  return {
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        let values = [];
        const api = {
          bind(...next) { values = next; return api; },
          async all() { return { results: statement.all(...values) }; },
          async first() { return statement.get(...values) || null; },
          async run() {
            const result = statement.run(...values);
            return { meta: { changes: Number(result.changes) } };
          },
        };
        return api;
      },
    },
    SESSION_SIGNING_KEY: "fixture-legacy-session-signing-key",
    ADMIN_KEY: "fixture-legacy-admin-key",
    [BANK_ACCESS_WRAPPING_KEY_SECRET]: `v2.${Buffer.alloc(32, 29).toString("base64url")}`,
    ...extra,
  };
}

function bankDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/d1/0018_bank_feed.sql", import.meta.url), "utf8"));
  return db;
}

async function legacyBankFixture({ reauthorization = false } = {}) {
  const db = bankDatabase();
  const fullEnv = d1(db);
  const reference = "access-sandbox-boundary-fixture-00000000000000000000";
  const sealed = await encryptAccessReference(fullEnv, reference, {
    keyVersion: LEGACY_BANK_ACCESS_KEY_VERSION,
  });
  db.prepare(`INSERT INTO bank_feed_items
    (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at)
    VALUES ('primary','fixture-item',?,?,?,'sandbox','2026-08-30T12:00:00.000Z')`)
    .run(sealed.ciphertext, sealed.iv, sealed.keyVersion);
  return {
    db,
    reference,
    env: reauthorization
      ? d1(db, { SESSION_SIGNING_KEY: undefined, ADMIN_KEY: undefined })
      : fullEnv,
  };
}

for (const boundary of ["before_rewrap_write", "after_rewrap_write"]) {
  test(`bank rewrap resumes exactly at ${boundary}`, async () => {
    const { db, env, reference } = await legacyBankFixture();
    try {
      await assert.rejects(
        rewrapBankAccessReferences(env, {
          mutationBoundary: ({ stage }) => {
            if (stage === boundary) throw new Error("synthetic bank boundary");
          },
        }),
        /synthetic bank boundary/,
      );
      const resumed = await rewrapBankAccessReferences(env);
      const row = db.prepare(
        "SELECT access_ciphertext,access_iv,key_version,status FROM bank_feed_items",
      ).get();
      assert.equal(row.key_version, 2);
      assert.equal(row.status, "connected");
      assert.equal(await decryptAccessReference(env, {
        ciphertext: row.access_ciphertext,
        iv: row.access_iv,
        keyVersion: row.key_version,
      }), reference);
      assert.equal(resumed.legacy_rewrap_required, 0);
    } finally {
      db.close();
    }
  });
}

for (const boundary of [
  "before_reauthorization_required_write",
  "after_reauthorization_required_write",
]) {
  test(`bank reauthorization state resumes exactly at ${boundary}`, async () => {
    const { db, env } = await legacyBankFixture({ reauthorization: true });
    try {
      await assert.rejects(
        rewrapBankAccessReferences(env, {
          mutationBoundary: ({ stage }) => {
            if (stage === boundary) throw new Error("synthetic bank boundary");
          },
        }),
        /synthetic bank boundary/,
      );
      const resumed = await rewrapBankAccessReferences(env);
      const row = db.prepare("SELECT key_version,status,status_detail FROM bank_feed_items").get();
      assert.equal(row.key_version, 1);
      assert.equal(row.status, "reauth_required");
      assert.match(row.status_detail, /account holder must connect it again/i);
      assert.equal(resumed.legacy_rewrap_required, 0);
      assert.equal(resumed.reauthorization_required_total, 1);
    } finally {
      db.close();
    }
  });
}

test("the mutation matrix covers every declared recovery mutation", () => {
  assert.deepEqual(mutatingStages, [
    "export_d1",
    "restore_d1",
    "reconcile_security",
    "rebuild_vectorize",
  ]);
});
