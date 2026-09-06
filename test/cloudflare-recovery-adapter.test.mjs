import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
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
import { cmdSecrets, withCloudflareToken, workerBindings } from "../brain.mjs";
import worker from "../worker/src/index.js";

import {
  CloudflareRecoveryAdapterError,
  RECOVERY_DURABLE_TABLES,
  RECOVERY_EXPORT_TABLES,
  RECOVERY_FIELD_GATE_STOP_STAGES,
  createCloudflareRecoveryFieldGateAdapters,
  normalizedInstallStateExport,
  parseCloudflareRecoveryCliArguments,
  previewCloudflareRecoveryFieldGate,
  runCloudflareRecoveryFieldGate,
  verifyRecoverySqlArtifact,
} from "../operations/cloudflare-recovery-adapter.mjs";
import {
  initializeVerifiedRecovery,
  loadVerifiedRecoveryState,
} from "../operations/verified-recovery.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-cloudflare-recovery-adapter-"));
if (process.platform !== "win32") chmodSync(sandbox, 0o700);

const sourceManifestPath = join(sandbox, "source.manifest.json");
const targetManifestPath = join(sandbox, "target.manifest.json");
const planPath = join(sandbox, ".brain-recovery-plan.json");
const statePath = join(sandbox, ".brain-recovery-state.json");
const artifactDirectory = join(sandbox, "private-artifacts");
const wrapperPath = join(sandbox, "wrangler-owner-wrapper");
const goldenPath = join(sandbox, "brain.golden.json");
const privateSentinel = "fixture-private-question-and-provider-output";
const fixtureAdminKey = "fixture-private-admin-key-value";
const wrapperScript = "#!/bin/sh\nexec wrangler \"$@\"\n";
const sourceWorkerVersionId = "fixture-source-version-id";
const pausedWorkerVersionId = "fixture-paused-version-id";
const activeWorkerVersionId = "fixture-active-version-id";
const workerScriptEtag = "a".repeat(64);
const sourceWorkerScriptEtag = "b".repeat(64);
let sourceSecretNames = [];

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
      account_id: "fixture-account-source",
      d1_database_name: "fixture-source-d1",
      d1_database_id: "fixture-source-database-id",
      vectorize_index: "fixture-source-vector",
    },
  },
  retrieval: {
    embed_model: "@cf/baai/bge-base-en-v1.5",
    embed_dimensions: 768,
  },
};

const targetManifest = {
  ...structuredClone(sourceManifest),
  brain: {
    ...sourceManifest.brain,
    worker_name: "fixture-brain-recovery-gate-deadbeef",
    domain: "fixture-brain-recovery-gate-deadbeef.fixture-account.workers.dev",
  },
  infrastructure: {
    cloudflare: {
      ...sourceManifest.infrastructure.cloudflare,
      account_id: "fixture-account-target",
      d1_database_name: "fixture-d1-recovery-gate-deadbeef",
      d1_database_id: "fixture-target-database-id",
      vectorize_index: "fixture-vector-recovery-gate-deadbeef",
    },
  },
  operations: {
    admin_key_secret: "keychain://fixture-brain-recovery/owner",
    recovery_field_gate: {
      paused_worker_version_id: pausedWorkerVersionId,
      active_worker_version_id: activeWorkerVersionId,
      worker_script_etag: workerScriptEtag,
      routes: [],
      custom_domains: [],
      reviewed_at: "2026-08-25T11:55:00.000Z",
    },
  },
};

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

function migrationRows() {
  return readdirSync(join(process.cwd(), "migrations", "d1"))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8");
      return {
        version: Number(name.split("_")[0]),
        name: name.replace(/\.sql$/, ""),
        checksum: hash(sql).slice(0, 16),
      };
    });
}

const appliedMigrations = migrationRows();
const installStateColumns = Object.freeze([
  ["id", "INTEGER"],
  ["client_slug", "TEXT"],
  ["product_version", "TEXT"],
  ["schema_version", "INTEGER"],
  ["gate_version", "INTEGER"],
  ["installed_at", "TEXT"],
  ["last_upgraded_at", "TEXT"],
  ["ring", "TEXT"],
  ["notes", "TEXT"],
  ["outbox_generation", "INTEGER"],
  ["vector_drain_lease_owner", "TEXT"],
  ["vector_drain_lease_expires_at", "INTEGER"],
  ["vector_projection_mutation_id", "TEXT"],
  ["vector_projection_submitted_at", "INTEGER"],
  ["vector_projection_status", "TEXT"],
  ["vector_projection_bootstrap_epoch", "INTEGER"],
  ["vector_projection_bootstrap_cursor", "TEXT"],
  ["vector_projection_bootstrap_high_water", "TEXT"],
  ["vector_projection_bootstrap_protocol", "TEXT"],
  ["vector_projection_bootstrap_base_count", "INTEGER"],
  ["session_generation", "INTEGER"],
]);
const fixtureInstallState = Object.freeze({
  id: 1,
  client_slug: "fixture-brain",
  product_version: "0.1.12",
  schema_version: 13,
  gate_version: 4,
  installed_at: "2026-08-25T12:00:00.000Z",
  last_upgraded_at: null,
  ring: "stable",
  notes: null,
  outbox_generation: 9,
  vector_drain_lease_owner: null,
  vector_drain_lease_expires_at: null,
  vector_projection_mutation_id: null,
  vector_projection_submitted_at: null,
  vector_projection_status: "bootstrap_required",
  vector_projection_bootstrap_epoch: 1,
  vector_projection_bootstrap_cursor: null,
  vector_projection_bootstrap_high_water: "fixture:chunk#0004",
  // This proof belongs to the source Vectorize index and must never survive a
  // recovery into the target's new index.
  vector_projection_bootstrap_protocol: "bootstrap-v2",
  vector_projection_bootstrap_base_count: 5,
  // Live owner-session coordination; zero-normalized on export like the
  // outbox generation, so a recovery never resurrects old session cookies.
  session_generation: 4,
});
const normalizedInstallStateSql =
  `INSERT INTO "install_state" (${installStateColumns.map(([name]) => `"${name}"`).join(",")}) VALUES (` +
  `1,'fixture-brain','0.1.12',13,4,'2026-08-25T12:00:00.000Z',NULL,'stable',NULL,0,NULL,NULL,NULL,NULL,'bootstrap_required',1,NULL,'fixture:chunk#0004',NULL,0,0);\n`;
const schemaRows = Object.freeze([
  ...RECOVERY_DURABLE_TABLES.map((name) => ({
    type: "table",
    name,
    tbl_name: name,
    sql: `CREATE TABLE ${name} (fixture TEXT)`,
  })),
  {
    type: "table",
    name: "chunks_fts",
    tbl_name: "chunks_fts",
    sql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text)",
  },
].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));

function aggregateFromSql(sql) {
  const aggregate = {};
  for (const match of sql.matchAll(/AS\s+"([a-z0-9_]+)"/g)) aggregate[match[1]] = "0";
  aggregate.documents = "3";
  aggregate.chunks = "5";
  aggregate.chunks_fts = "5";
  aggregate.documents_ingested_max = "20";
  aggregate.documents_text_bytes = "100";
  aggregate.chunks_id_max = "5";
  aggregate.chunks_text_bytes = "500";
  return aggregate;
}

const aggregateTemplate = aggregateFromSql(
  "SELECT " + [
    ...RECOVERY_DURABLE_TABLES,
    "chunks_fts",
    "documents_ingested_max",
    "documents_text_bytes",
    "chunks_id_max",
    "chunks_text_bytes",
    "vector_drain_lease_owner_present",
    "vector_drain_lease_expiry_present",
    "vector_projection_mutation_present",
    "vector_projection_submission_present",
  ].map((name) => `0 AS "${name}"`).join(","),
);
const deterministicDataExport = "-- deterministic data-only fixture\n";
const deterministicDataFingerprint = hash(normalizedInstallStateSql + deterministicDataExport);
const expectedSnapshot = Object.freeze({
  integrity: "ok",
  schema_fingerprint: hash(canonical({ migrations: appliedMigrations, schema: schemaRows })),
  aggregate_fingerprint: hash(canonical(aggregateTemplate)),
  document_count: 3,
  chunk_count: 5,
  fts_count: 5,
  content_fingerprint: deterministicDataFingerprint,
});

function snapshotForChunkCount(chunkCount) {
  const aggregate = {
    ...aggregateTemplate,
    chunks: String(chunkCount),
    chunks_fts: String(chunkCount),
    chunks_id_max: String(chunkCount),
    chunks_text_bytes: String(chunkCount * 100),
  };
  return Object.freeze({
    ...expectedSnapshot,
    aggregate_fingerprint: hash(canonical(aggregate)),
    chunk_count: chunkCount,
    fts_count: chunkCount,
  });
}

// Exercise the normalization projection against real SQLite, not only the
// provider harness. A live lease and mutation fence are invocation-local and
// never enter the artifact; a nonempty corpus receives its exact binary-order
// high-water so a resumed restore can advance the durable bootstrap cursor.
{
  const source = new DatabaseSync(":memory:");
  const destination = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations", "d1");
  for (const name of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    source.exec(sql);
    destination.exec(sql);
  }
  source.exec(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
        vector_drain_lease_owner,vector_drain_lease_expires_at,
        vector_projection_mutation_id,vector_projection_submitted_at)
     VALUES (1,'fixture-brain','0.1.12',13,4,'2026-08-25T12:00:00.000Z','stable',
             'raw-live-owner-must-not-export',999999,'raw-live-mutation-must-not-export',888888);
     INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash)
     VALUES ('fixture:doc','fixture','doc',1,'hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source)
     VALUES ('fixture:chunk#0004','fixture:doc',0,'restored fixture text','fixture');
     DELETE FROM vector_outbox;
     UPDATE install_state
        SET vector_projection_status='verified',
            vector_projection_bootstrap_epoch=7,
            vector_projection_bootstrap_cursor='fixture:chunk#0004',
            vector_projection_bootstrap_high_water='fixture:chunk#0004',
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=1;
     INSERT INTO vector_bootstrap_batches
       (epoch,batch_no,start_cursor,end_cursor,row_count,status,mutation_id,submitted_at,confirmed_at)
     VALUES (7,1,'','fixture:chunk#0004',1,'confirmed','source-only-mutation',1,2);`,
  );
  const readRows = async (_binding, sql) => source.prepare(sql).all();
  const first = await normalizedInstallStateExport({}, appliedMigrations, readRows);
  source.prepare(
    `UPDATE install_state
        SET outbox_generation=123456,
            vector_drain_lease_owner='different-live-owner',
            vector_drain_lease_expires_at=111111,
            vector_projection_mutation_id='different-live-mutation',
            vector_projection_submitted_at=222222
      WHERE id=1`,
  ).run();
  const retry = await normalizedInstallStateExport({}, appliedMigrations, readRows);
  assert.deepEqual(first, retry);
  const sql = first.toString("utf8");
  assert.equal(sql.includes("raw-live-owner-must-not-export"), false);
  assert.equal(sql.includes("different-live-owner"), false);
  assert.equal(sql.includes("bootstrap-v2"), false);
  assert.equal(sql.includes("source-only-mutation"), false);
  destination.exec(sql);
  assert.deepEqual({ ...destination.prepare(
    `SELECT outbox_generation generation,
            vector_drain_lease_owner owner,
            vector_drain_lease_expires_at expires,
            vector_projection_mutation_id mutation,
            vector_projection_submitted_at submitted,
            vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water,
            vector_projection_bootstrap_protocol protocol,
            vector_projection_bootstrap_base_count base_count,
            (SELECT count(*) FROM vector_bootstrap_batches) batch_count
       FROM install_state WHERE id=1`,
  ).get() }, {
    generation: 0,
    owner: null,
    expires: null,
    mutation: null,
    submitted: null,
    status: "bootstrap_required",
    epoch: 1,
    cursor: null,
    high_water: "fixture:chunk#0004",
    protocol: null,
    base_count: 0,
    batch_count: 0,
  });
  source.close();
  destination.close();
}

// Historical schema-12 artifacts remain inspectable offline. The projection
// must not mention schema-13 columns while still resetting the visibility
// bootstrap for a fresh derived index.
{
  const source = new DatabaseSync(":memory:");
  const destination = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations", "d1");
  const migrationNames = readdirSync(migrationDirectory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .slice(0, 12);
  for (const name of migrationNames) {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    source.exec(sql);
    destination.exec(sql);
  }
  source.exec(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
     VALUES (1,'prefix-brain','0.1.14',12,4,'2026-08-25T12:00:00.000Z','stable');
     INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash)
     VALUES ('prefix:doc','fixture','doc',1,'prefix-hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source)
     VALUES ('prefix:chunk#0001','prefix:doc',0,'prefix fixture text','fixture');`,
  );
  const prefixMigrations = appliedMigrations.slice(0, 12);
  const readRows = async (_binding, sql) => source.prepare(sql).all();
  const normalized = await normalizedInstallStateExport({}, prefixMigrations, readRows);
  const sql = normalized.toString("utf8");
  assert.equal(sql.includes("vector_projection_bootstrap_protocol"), false);
  assert.equal(sql.includes("vector_projection_bootstrap_base_count"), false);
  assert.equal(sql.includes("vector_bootstrap_batches"), false);
  destination.exec(sql);
  assert.deepEqual({ ...destination.prepare(
    `SELECT schema_version,
            vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get() }, {
    schema_version: 12,
    status: "bootstrap_required",
    epoch: 1,
    cursor: null,
    high_water: "prefix:chunk#0001",
  });
  normalized.fill(0);
  source.close();
  destination.close();
}

await assert.rejects(
  normalizedInstallStateExport({}, appliedMigrations, async (_binding, sql) => {
    if (/PRAGMA table_info/.test(sql)) {
      return installStateColumns.map(([name, type], cid) => ({ cid, name, type }));
    }
    if (/FROM install_state ORDER BY id/.test(sql)) return [];
    throw new Error(`unexpected singleton fixture SQL: ${sql}`);
  }),
  (error) => error.code === "RECOVERY_INSTALL_STATE_INVALID",
);

function releaseGolden() {
  const questions = [];
  for (let index = 0; index < 60; index++) {
    const kind = index < 30 ? "answerable" : "unanswerable";
    questions.push({
      id: `fixture-${index + 1}`,
      kind,
      query_kind: kind,
      risk: "critical",
      domains: ["fixture"],
      formats: ["text"],
      question: index === 0 ? privateSentinel : `fixture question ${index + 1}`,
      ...(kind === "answerable"
        ? { expect: [{ doc: "Fixture document", source: "fixture" }] }
        : {}),
    });
  }
  return {
    schema_version: 1,
    release_slices: {
      risk: ["critical"],
      domain: ["fixture"],
      format: ["text"],
      query_kind: ["answerable", "unanswerable"],
    },
    questions,
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function providerHarness({
  ambiguousSourceD1 = false,
  activeScriptEtag = workerScriptEtag,
  activeVersionMode = null,
  bootstrapMutatesCorpus = false,
  bootstrapBusyOnce = false,
  bootstrapPageSize = 3_000,
  bootstrapResidueRetryAfterProgress = false,
  bootstrapReceiptTransform = (receipt) => receipt,
  busyReceiptTransform = (receipt) => receipt,
  deploymentChangesDuringEval = false,
  redirectHealth = false,
  redirectInventory = false,
  extraTargetSecret = false,
  extraTargetBinding = false,
  transformWorkerBindings = (bindings) => bindings,
  failBootstrapOnce = false,
  failBootstrapAfterProgressOnce = false,
  failPromotionAfterApplyOnce = false,
  healthModeOverride = null,
  healthProtocolOverride = null,
  transformHealthReceipt = (receipt) => receipt,
  initialTargetRestored = false,
  initialVectorCount = 0,
  missingVectorCount = false,
  pausedVersionMode = "paused-for-upgrade",
  pausedScriptEtag = workerScriptEtag,
  promotionNoop = false,
  readinessLagAfterBootstrap = false,
  sourceDrainLease = false,
  // Current-protocol installs report whatever the newest real migration is,
  // so a new additive migration never breaks these fixtures (found 13 -> 14).
  sourceMigrationVersion = appliedMigrations.at(-1).version,
  targetChunkCount = 5,
  targetMigrationVersion = appliedMigrations.at(-1).version,
  sourceInstallStateMissing = false,
  splitTargetDeployment = false,
  targetVersionId = pausedWorkerVersionId,
} = {}) {
  let targetRestored = initialTargetRestored;
  let vectorCount = initialVectorCount;
  let outbox = 0;
  let bootstrapRequired = initialTargetRestored && initialVectorCount < targetChunkCount;
  let bootstrapEpoch = 1;
  let bootstrapCursor = null;
  let bootstrapConfirmed = initialVectorCount;
  let currentTargetVersionId = targetVersionId;
  let corpusMutated = false;
  let evalCalls = 0;
  let adminReads = 0;
  let importCalls = 0;
  let bootstrapFailuresRemaining = failBootstrapOnce ? 1 : 0;
  let postProgressBootstrapFailuresRemaining = failBootstrapAfterProgressOnce ? 1 : 0;
  let bootstrapBusyRemaining = bootstrapBusyOnce ? 1 : 0;
  let bootstrapResidueRetryRemaining = bootstrapResidueRetryAfterProgress ? 1 : 0;
  let bootstrapRebaseWaitingRemaining = 0;
  let readinessLagRemaining = readinessLagAfterBootstrap ? 1 : 0;
  let promotionFailuresRemaining = failPromotionAfterApplyOnce ? 1 : 0;
  let bootstrapCalls = 0;
  let promotionCalls = 0;
  let sleepCalls = 0;
  let normalizedLeaseSelections = 0;
  const wranglerCalls = [];
  const fetchCalls = [];
  const sensitiveBuffers = [];

  const bindingForAccount = (accountId) => accountId === sourceManifest.infrastructure.cloudflare.account_id
    ? sourceManifest.infrastructure.cloudflare
    : targetManifest.infrastructure.cloudflare;

  const runWrangler = async ({ command, args, env, cwd }) => {
    wranglerCalls.push({ command, args: [...args], env: { ...env }, cwd });
    assert.equal(Object.hasOwn(env, "CLOUDFLARE_API_TOKEN"), false);
    assert.equal(Object.hasOwn(env, "ADMIN_KEY"), false);
    assert.equal(Object.keys(env).some((name) => /SUPABASE|ANTHROPIC/.test(name)), false);
    assert.equal(env.WRANGLER_LOG_SANITIZE, "true");
    assert.equal(env.WRANGLER_LOG, "log");
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id ||
      env.CLOUDFLARE_ACCOUNT_ID === targetManifest.infrastructure.cloudflare.account_id, true);
    writeFileSync(join(env.WRANGLER_LOG_PATH, "fixture.log"), "aggregate-only fixture log\n", { mode: 0o600 });

    const ok = (payload = "") => {
      const stdout = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
      const stderr = Buffer.from(privateSentinel);
      sensitiveBuffers.push(stderr);
      return { status: 0, stdout, stderr };
    };
    if (args[0] === "--version") return ok("4.99.0\n");
    for (const flag of [
      "--experimental-provision=false",
      "--experimental-auto-create=false",
    ]) assert.equal(args.includes(flag), true);
    // Wrangler 4.73 rejects this obsolete flag before executing even a
    // read-only JSON command. The pinned local wrapper already prevents any
    // package or skill installation path.
    assert.equal(args.includes("--install-skills=false"), false);

    const cloudflare = bindingForAccount(env.CLOUDFLARE_ACCOUNT_ID);
    if (args[0] === "d1" && args[1] === "list") {
      const row = { name: cloudflare.d1_database_name, uuid: cloudflare.d1_database_id };
      return ok(ambiguousSourceD1 && env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id
        ? [row, { ...row }]
        : [row]);
    }
    if (args[0] === "vectorize" && args[1] === "list") {
      return ok([{ name: cloudflare.vectorize_index, config: { dimensions: 768, metric: "cosine" } }]);
    }
    if (args[0] === "vectorize" && args[1] === "info") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      return ok({
        dimensions: 768,
        ...(!isSource && missingVectorCount
          ? {}
          : { vectorCount: isSource ? 5 : vectorCount }),
      });
    }
    if (args[0] === "deployments" && args[1] === "status") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      if (!isSource && splitTargetDeployment) {
        return ok({ versions: [
          { version_id: pausedWorkerVersionId, percentage: 50 },
          { version_id: activeWorkerVersionId, percentage: 50 },
        ] });
      }
      return ok({ versions: [{
        version_id: isSource ? sourceWorkerVersionId : currentTargetVersionId,
        percentage: 100,
      }] });
    }
    if (args[0] === "versions" && args[1] === "view") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      const manifest = isSource ? sourceManifest : targetManifest;
      const requestedVersionId = args[2];
      const targetMode = requestedVersionId === pausedWorkerVersionId
        ? pausedVersionMode
        : requestedVersionId === activeWorkerVersionId
          ? activeVersionMode
          : null;
      const scriptEtag = isSource
        ? sourceWorkerScriptEtag
        : requestedVersionId === pausedWorkerVersionId
          ? pausedScriptEtag
          : activeScriptEtag;
      return ok({
        id: requestedVersionId,
        resources: {
          script: {
            etag: scriptEtag,
            handlers: ["fetch", "scheduled"],
            last_deployed_from: "api",
            named_handlers: [],
          },
          script_runtime: {
            compatibility_date: "2026-01-01",
            usage_model: "standard",
          },
          // Exercise the actual deploy contract instead of a second hand-written
          // allowlist that can silently omit newly emitted bindings.
          bindings: transformWorkerBindings([
            ...workerBindings(manifest, cloudflare).map((entry) => {
              if (entry.type === "d1") return { ...entry, database_id: entry.id };
              if (entry.type === "ai") return { ...entry, project: "<catalog>" };
              // This harness also models exact historical product versions.
              if (entry.name === "BRAIN_VERSION") return { ...entry, text: manifest.brain.version };
              return entry;
            }),
            ...(isSource ? sourceSecretNames : ["ADMIN_KEY"])
              .map((name) => ({ type: "secret_text", name })),
            ...(!isSource && targetMode !== null
              ? [{ type: "plain_text", name: "VECTOR_DRAIN_MODE", text: targetMode }]
              : []),
            ...(!isSource && extraTargetSecret
              ? [{ type: "secret_text", name: "UNREVIEWED_SECRET" }]
              : []),
            ...(!isSource && extraTargetBinding
              ? [{ type: "plain_text", name: "UNREVIEWED_MODE", text: "enabled" }]
              : []),
          ], { role: isSource ? "source" : "target", versionId: requestedVersionId }),
        },
      });
    }
    if (args[0] === "versions" && args[1] === "deploy") {
      assert.deepEqual(args.slice(0, 6), [
        "versions", "deploy", `${activeWorkerVersionId}@100%`,
        "--name", targetManifest.brain.worker_name, "-y",
      ]);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, targetManifest.infrastructure.cloudflare.account_id);
      promotionCalls++;
      if (!promotionNoop) currentTargetVersionId = activeWorkerVersionId;
      if (promotionFailuresRemaining > 0) {
        promotionFailuresRemaining--;
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("synthetic lost promotion response") };
      }
      return ok();
    }
    if (args[0] === "d1" && args[1] === "export") {
      // Wrangler 4.73 removed --skip-confirmation from d1 export. Export has no
      // confirmation option, while restore continues to use d1 execute --yes.
      assert.equal(args.includes("--skip-confirmation"), false);
      const output = args[args.indexOf("--output") + 1];
      const exportedTables = args
        .map((value, index) => value === "--table" ? args[index + 1] : null)
        .filter(Boolean);
      assert.deepEqual(exportedTables, [...RECOVERY_EXPORT_TABLES]);
      assert.equal(exportedTables.includes("vector_outbox"), false);
      assert.equal(exportedTables.includes("vector_bootstrap_batches"), false);
      assert.equal(exportedTables.includes("install_state"), false);
      writeFileSync(
        output,
        corpusMutated ? `${deterministicDataExport}\n-- synthetic corpus mutation\n` : deterministicDataExport,
        { mode: 0o600 },
      );
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--file")) {
      importCalls++;
      targetRestored = true;
      bootstrapRequired = true;
      bootstrapConfirmed = 0;
      vectorCount = 0;
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
      const sql = args[args.indexOf("--command") + 1];
      let rows;
      if (/user_table_count/.test(sql)) {
        rows = [{ user_table_count: targetRestored ? RECOVERY_DURABLE_TABLES.length + 1 : 0 }];
      } else if (/pending_outbox/.test(sql)) {
        rows = [{ pending_outbox: outbox, failed_vectors: 0 }];
      } else if (/integrity-check/.test(sql)) {
        rows = [];
      } else if (/PRAGMA quick_check/.test(sql)) {
        rows = [{ quick_check: "ok" }];
      } else if (/SELECT version,name,checksum/.test(sql)) {
        const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
        const latest = isSource ? sourceMigrationVersion : targetMigrationVersion;
        rows = appliedMigrations.filter((row) => row.version <= latest);
      } else if (/PRAGMA table_info\(install_state\)/.test(sql)) {
        rows = installStateColumns.map(([name, type], cid) => ({ cid, name, type }));
      } else if (/^SELECT[\s\S]+FROM install_state ORDER BY id$/.test(sql)) {
        assert.match(sql, /NULL AS "vector_drain_lease_owner"/);
        assert.match(sql, /NULL AS "vector_drain_lease_expires_at"/);
        assert.match(sql, /0 AS "outbox_generation"/);
        assert.match(sql, /NULL AS "vector_projection_mutation_id"/);
        assert.match(sql, /NULL AS "vector_projection_submitted_at"/);
        assert.match(sql, /CASE WHEN EXISTS \(SELECT 1 FROM chunks\) THEN 'bootstrap_required' ELSE 'verified' END AS "vector_projection_status"/);
        assert.match(sql, /CASE WHEN EXISTS \(SELECT 1 FROM chunks\) THEN 1 ELSE 0 END AS "vector_projection_bootstrap_epoch"/);
        assert.match(sql, /NULL AS "vector_projection_bootstrap_cursor"/);
        assert.match(sql, /\(SELECT MAX\(chunk_uid\) FROM chunks\) AS "vector_projection_bootstrap_high_water"/);
        assert.match(sql, /NULL AS "vector_projection_bootstrap_protocol"/);
        assert.match(sql, /0 AS "vector_projection_bootstrap_base_count"/);
        assert.match(sql, /0 AS "session_generation"/);
        normalizedLeaseSelections++;
        rows = sourceInstallStateMissing ? [] : [{
          ...fixtureInstallState,
          // The source may own a live lease, but the only recovery data query
          // projects both ephemeral columns to NULL before they reach JS.
          vector_drain_lease_owner: null,
          vector_drain_lease_expires_at: null,
          outbox_generation: 0,
          vector_projection_mutation_id: null,
          vector_projection_submitted_at: null,
          vector_projection_status: "bootstrap_required",
          vector_projection_bootstrap_epoch: 1,
          vector_projection_bootstrap_cursor: null,
          vector_projection_bootstrap_high_water: "fixture:chunk#0004",
          vector_projection_bootstrap_protocol: null,
          vector_projection_bootstrap_base_count: 0,
          session_generation: 0,
        }];
      } else if (/SELECT name FROM sqlite_schema/.test(sql)) {
        rows = [...RECOVERY_DURABLE_TABLES].sort().map((name) => ({ name }));
      } else if (/SELECT type,name,tbl_name/.test(sql)) {
        rows = schemaRows;
      } else if (/documents_ingested_max/.test(sql)) {
        assert.match(
          sql,
          /CAST\(\(SELECT 0\) AS TEXT\) AS "vector_bootstrap_batches"/,
        );
        const aggregate = env.CLOUDFLARE_ACCOUNT_ID === targetManifest.infrastructure.cloudflare.account_id &&
            targetRestored
          ? {
              ...aggregateTemplate,
              chunks: String(targetChunkCount),
              chunks_fts: String(targetChunkCount),
              chunks_id_max: String(targetChunkCount),
              chunks_text_bytes: String(targetChunkCount * 100),
              ...(corpusMutated
                ? { chunks_text_bytes: String(targetChunkCount * 100 + 1) }
                : {}),
            }
          : aggregateTemplate;
        rows = [{
          ...aggregate,
          vector_outbox: String(outbox),
          vector_drain_lease_owner_present: "0",
          vector_drain_lease_expiry_present: "0",
          vector_projection_mutation_present: "0",
          vector_projection_submission_present: "0",
        }];
      } else {
        throw new Error(`unhandled aggregate-only SQL fixture: ${sql.slice(0, 80)}`);
      }
      return ok([{ success: true, results: rows }]);
    }
    throw new Error(`unhandled Wrangler fixture: ${args.join(" ")}`);
  };

  const fetchImpl = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options: structuredClone({
      method: options.method,
      redirect: options.redirect,
      cache: options.cache,
      headers: options.headers,
      body: options.body,
    }) });
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers["Cache-Control"], "no-store");
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.protocol, "https:");
    assert.equal(parsedUrl.search, "");
    assert.equal(String(url).includes(fixtureAdminKey), false);
    assert.equal(String(url).includes(privateSentinel), false);
    const path = parsedUrl.pathname;
    if (path === "/health") {
      if (redirectHealth) return response({}, 302, { location: "https://redirected.fixture.invalid/health" });
      const health = await worker.fetch(new Request(String(url)), {
        BRAIN_NAME: targetManifest.client.slug,
        BRAIN_VERSION: targetManifest.brain.version,
        ...(currentTargetVersionId === pausedWorkerVersionId
          ? { VECTOR_DRAIN_MODE: "paused-for-upgrade" }
          : {}),
      }, {});
      const receipt = await health.json();
      return response(transformHealthReceipt({
        ...receipt,
        vector_drain_mode: healthModeOverride ?? receipt.vector_drain_mode,
        vector_writer_protocol: healthProtocolOverride ?? receipt.vector_writer_protocol,
      }));
    }
    if (path === "/api/admin/brain/bootstrap") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      assert.equal(currentTargetVersionId, pausedWorkerVersionId);
      assert.equal(options.body, undefined);
      bootstrapCalls++;
      if (bootstrapFailuresRemaining > 0) {
        bootstrapFailuresRemaining--;
        throw new TypeError("synthetic interrupted bootstrap");
      }
      if (bootstrapBusyRemaining > 0) {
        bootstrapBusyRemaining--;
        return response(busyReceiptTransform({
          protocol: "bootstrap-v2",
          busy: true,
          remaining: targetChunkCount - bootstrapConfirmed,
          retry_after_seconds: 2,
        }), 409);
      }
      if (bootstrapResidueRetryRemaining > 0 && bootstrapConfirmed > 0 &&
          bootstrapConfirmed < targetChunkCount) {
        bootstrapResidueRetryRemaining--;
        const retryReceipt = bootstrapReceiptTransform({
          protocol: "bootstrap-v2",
          phase: "legacy_drain",
          epoch: bootstrapEpoch,
          total: targetChunkCount,
          confirmed: bootstrapConfirmed,
          queued: 1,
          submitted: 0,
          remaining: targetChunkCount - bootstrapConfirmed,
          in_flight_batches: 0,
          failed: 1,
          retrying: 1,
          complete: false,
          vector_ready: false,
          expected_vectors: targetChunkCount,
          actual_vectors: vectorCount,
        });
        // The real coordinator advances to a fresh exact-cut epoch after the
        // residue becomes visible, retaining the earlier batch history under
        // its old epoch. The count can become visible one request after the
        // row receipt, while the verified epoch rebase follows on the next.
        bootstrapRebaseWaitingRemaining = 1;
        return response(retryReceipt);
      }
      if (bootstrapRebaseWaitingRemaining > 0) {
        bootstrapRebaseWaitingRemaining--;
        vectorCount = targetChunkCount;
        const waitingReceipt = bootstrapReceiptTransform({
          protocol: "bootstrap-v2",
          phase: "waiting",
          epoch: bootstrapEpoch,
          total: targetChunkCount,
          confirmed: bootstrapConfirmed,
          queued: 0,
          submitted: 0,
          remaining: targetChunkCount - bootstrapConfirmed,
          in_flight_batches: 0,
          failed: 0,
          complete: false,
          vector_ready: false,
          expected_vectors: targetChunkCount,
          actual_vectors: vectorCount,
        });
        bootstrapEpoch++;
        return response(waitingReceipt);
      }
      if (bootstrapRequired && bootstrapConfirmed < targetChunkCount) {
        bootstrapConfirmed = Math.min(
          targetChunkCount,
          bootstrapConfirmed + bootstrapPageSize,
        );
        vectorCount = bootstrapConfirmed;
        bootstrapCursor = `fixture:chunk#${String(Math.max(0, bootstrapConfirmed - 1)).padStart(8, "0")}`;
      }
      if (postProgressBootstrapFailuresRemaining > 0 && bootstrapConfirmed > 0) {
        postProgressBootstrapFailuresRemaining--;
        throw new TypeError("synthetic interruption after durable bootstrap progress");
      }
      const countComplete = bootstrapConfirmed === targetChunkCount;
      const visibilityLagged = countComplete && readinessLagRemaining > 0;
      if (visibilityLagged) readinessLagRemaining--;
      const complete = countComplete && !visibilityLagged;
      if (complete) bootstrapRequired = false;
      if (complete && bootstrapMutatesCorpus) corpusMutated = true;
      return response(bootstrapReceiptTransform({
        protocol: "bootstrap-v2",
        phase: complete ? "complete" : countComplete ? "waiting" : "building",
        epoch: bootstrapEpoch,
        total: targetChunkCount,
        confirmed: bootstrapConfirmed,
        queued: 0,
        submitted: 0,
        remaining: targetChunkCount - bootstrapConfirmed,
        in_flight_batches: 0,
        failed: 0,
        complete,
        vector_ready: complete,
        expected_vectors: targetChunkCount,
        actual_vectors: visibilityLagged ? Math.max(0, targetChunkCount - 1) : vectorCount,
      }));
    }
    if (path === "/api/admin/brain/documents") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      if (redirectInventory) {
        // Match native fetch with redirect:error: no request is issued to the
        // Location host, so the authenticated header cannot cross origins.
        throw new TypeError("redirect mode is set to error");
      }
      const ready = !bootstrapRequired && outbox === 0 && vectorCount === targetChunkCount;
      return response({
        backend: "d1",
        rows: [],
        vector_backlog: {
          pending: outbox,
          upserts: outbox,
          deletes: 0,
          submitted: 0,
          oldest_queued_at: outbox ? 1_777_000_000_000 : null,
        },
        vector_readiness: {
          ready,
          reason: ready ? null : "accepted_mutation_processing",
          expected_vectors: targetChunkCount,
          actual_vectors: ready ? targetChunkCount : Math.max(0, vectorCount - 1),
          pending: outbox,
          submitted: 0,
          action: ready ? null : "Wait briefly, then run brain drain again.",
        },
      });
    }
    if (path === "/api/rag/unified") return response({ error: "unauthorized" }, 401);
    throw new Error(`unhandled fetch fixture: ${path}`);
  };

  return {
    dependencies: {
      platform: "darwin",
      environment: {
        HOME: sandbox,
        USER: "fixture",
        LOGNAME: "fixture",
        CLOUDFLARE_API_TOKEN: "ambient-cloudflare-secret",
        ADMIN_KEY: "ambient-admin-secret",
        SUPABASE_SERVICE_ROLE_KEY: "ambient-supabase-secret",
      },
      runWrangler,
      fetchImpl,
      readAdminKey: () => {
        adminReads++;
        return fixtureAdminKey;
      },
      verifySqlArtifact: async (path) => {
        const text = readFileSync(path, "utf8");
        assert.match(text, /CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts/);
        assert.equal(text.includes(privateSentinel), false);
        return expectedSnapshot;
      },
      runEval: async ({ args, env, input }) => {
        evalCalls++;
        assert.deepEqual(Buffer.from(input), Buffer.from(`${fixtureAdminKey}\n`));
        assert.equal(Object.hasOwn(env, "CLOUDFLARE_API_TOKEN"), false);
        assert.equal(Object.hasOwn(env, "ADMIN_KEY"), false);
        assert.equal(env.BRAIN_ADMIN_KEY_STDIN, "1");
        assert.equal(args.includes("--profile"), true);
        assert.equal(args[args.indexOf("--profile") + 1], "release");
        if (deploymentChangesDuringEval) currentTargetVersionId = "fixture-unreviewed-version-id";
        return { status: 0 };
      },
      sleep: async () => { sleepCalls++; },
      now: () => Date.parse("2026-08-25T13:00:00.000Z"),
      clock: (() => {
        let value = Date.parse("2026-08-25T13:00:00.000Z");
        return () => new Date(value += 1000);
      })(),
    },
    get adminReads() { return adminReads; },
    get evalCalls() { return evalCalls; },
    get importCalls() { return importCalls; },
    get bootstrapCalls() { return bootstrapCalls; },
    get bootstrapConfirmed() { return bootstrapConfirmed; },
    get currentTargetVersionId() { return currentTargetVersionId; },
    get promotionCalls() { return promotionCalls; },
    get sleepCalls() { return sleepCalls; },
    get wranglerCalls() { return wranglerCalls; },
    get fetchCalls() { return fetchCalls; },
    get sensitiveBuffers() { return sensitiveBuffers; },
    get normalizedLeaseSelections() { return normalizedLeaseSelections; },
    get bootstrapEpoch() { return bootstrapEpoch; },
    get bootstrapCursor() { return bootstrapCursor; },
    get sourceLeaseMarker() { return sourceDrainLease ? "fixture-live-drain-owner" : null; },
  };
}

try {
  const recoveryFieldGateSchema = JSON.parse(
    readFileSync(join(process.cwd(), "manifest.schema.json"), "utf8"),
  ).properties.operations.properties.recovery_field_gate;
  assert.deepEqual(recoveryFieldGateSchema.required, [
    "paused_worker_version_id", "active_worker_version_id", "worker_script_etag",
    "routes", "custom_domains", "reviewed_at",
  ]);
  assert.equal(recoveryFieldGateSchema.additionalProperties, false);

  writePrivateJson(sourceManifestPath, sourceManifest);
  writePrivateJson(targetManifestPath, targetManifest);
  // Collect names from the real secrets command using only injected local
  // fakes. The source fixture must represent a normal product installation,
  // even when setup adds another derived secret in a later release.
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    console.log = () => {};
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      let result;
      if (path === "/client/v4/accounts" && (!options.method || options.method === "GET")) {
        result = [{ id: sourceManifest.infrastructure.cloudflare.account_id, name: "Synthetic Fixture" }];
      } else if (path === `/client/v4/accounts/${sourceManifest.infrastructure.cloudflare.account_id}/workers/scripts/${sourceManifest.brain.worker_name}/secrets`) {
        if (options.method === "PUT") {
          const body = JSON.parse(options.body);
          assert.equal(body.type, "secret_text");
          sourceSecretNames.push(body.name);
          result = { name: body.name, type: body.type };
        } else {
          assert.equal(options.method === undefined || options.method === "GET", true);
          result = [];
        }
      } else {
        throw new Error("unexpected secrets-contract fixture request");
      }
      return response({ success: true, result });
    };
    await withCloudflareToken(() => cmdSecrets(sourceManifestPath, {
      explicitAdminKey: null,
      adminKeyPersistencePlan: () => ({ backend: "keychain", service: "fixture", account: "fixture" }),
      readAdminKeyDurably: async () => "a".repeat(64),
      reconcileExistingAgents: null,
    }), { readCloudflareToken: async () => Buffer.from("fixture-control-plane-token"), interactive: false });
    assert.equal(sourceSecretNames.includes("SESSION_SIGNING_KEY"), true);
    assert.equal(new Set(sourceSecretNames).size, sourceSecretNames.length);
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
  mkdirSync(artifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(artifactDirectory, 0o700);
  writeFileSync(wrapperPath, wrapperScript, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);
  writePrivateJson(goldenPath, releaseGolden());

  const initialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    planPath,
    statePath,
    { now: new Date("2026-08-25T12:00:00.000Z") },
  );
  const baseConfig = {
    sourceManifestPath,
    targetManifestPath,
    planPath,
    statePath,
    artifactDirectory,
    wranglerWrapperPath: wrapperPath,
    goldenPath,
  };

  const preview = previewCloudflareRecoveryFieldGate(baseConfig, { platform: "darwin" });
  assert.equal(preview.ready_for_explicit_approval, true);
  assert.equal(preview.plan_fingerprint, initialized.plan.plan_fingerprint);
  assert.equal(preview.target_approval_fingerprint, initialized.plan.target_resource_fingerprint);
  assert.match(preview.target_execution_approval_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    preview.source_export_blocking_approval_fingerprint,
    initialized.plan.source_resource_fingerprint,
  );
  assert.match(preview.wrapper_approval_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(preview.golden_approval_fingerprint, hash(readFileSync(goldenPath)));
  assert.deepEqual(RECOVERY_FIELD_GATE_STOP_STAGES, [
    "export_d1", "restore_d1", "rebuild_vectorize",
  ]);
  const approvedAdapterConfig = Object.freeze({
    ...baseConfig,
    plan: initialized.plan,
    approvePlan: initialized.plan.plan_fingerprint,
    approveDisposableTarget: initialized.plan.target_resource_fingerprint,
    approveTargetExecution: preview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
    approveWrapper: preview.wrapper_approval_fingerprint,
    approveGolden: preview.golden_approval_fingerprint,
  });
  const previewText = JSON.stringify(preview);
  for (const forbidden of [privateSentinel, fixtureAdminKey, sourceManifest.brain.domain, wrapperPath]) {
    assert.equal(previewText.includes(forbidden), false);
  }

  assert.deepEqual(parseCloudflareRecoveryCliArguments([
    "preview",
    "--source-manifest", sourceManifestPath,
    "--target-manifest", targetManifestPath,
    "--plan", planPath,
    "--state", statePath,
    "--artifact-directory", artifactDirectory,
    "--wrangler-wrapper", wrapperPath,
    "--golden", goldenPath,
  ]).command, "preview");
  const parsedStop = parseCloudflareRecoveryCliArguments([
    "run",
    "--source-manifest", sourceManifestPath,
    "--target-manifest", targetManifestPath,
    "--plan", planPath,
    "--state", statePath,
    "--artifact-directory", artifactDirectory,
    "--wrangler-wrapper", wrapperPath,
    "--golden", goldenPath,
    "--approve-plan", initialized.plan.plan_fingerprint,
    "--approve-disposable-target", initialized.plan.target_resource_fingerprint,
    "--approve-target-execution", preview.target_execution_approval_fingerprint,
    "--approve-source-export-blocking", preview.source_export_blocking_approval_fingerprint,
    "--approve-wrapper", preview.wrapper_approval_fingerprint,
    "--approve-golden", preview.golden_approval_fingerprint,
    "--stop-after-stage", "restore_d1",
  ]);
  assert.equal(parsedStop.stopAfterStage, "restore_d1");
  assert.equal(parsedStop.approveGolden, preview.golden_approval_fingerprint);
  assert.throws(
    () => parseCloudflareRecoveryCliArguments([
      "preview",
      "--source-manifest", sourceManifestPath,
      "--target-manifest", targetManifestPath,
      "--plan", planPath,
      "--state", statePath,
      "--artifact-directory", artifactDirectory,
      "--wrangler-wrapper", wrapperPath,
      "--golden", goldenPath,
      "--stop-after-stage", "restore_d1",
    ]),
    (error) => error.code === "RECOVERY_FIELD_GATE_ARGUMENTS_INVALID",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments([
      ...[
        "run",
        "--source-manifest", sourceManifestPath,
        "--target-manifest", targetManifestPath,
        "--plan", planPath,
        "--state", statePath,
        "--artifact-directory", artifactDirectory,
        "--wrangler-wrapper", wrapperPath,
        "--golden", goldenPath,
        "--approve-plan", initialized.plan.plan_fingerprint,
        "--approve-disposable-target", initialized.plan.target_resource_fingerprint,
        "--approve-target-execution", preview.target_execution_approval_fingerprint,
        "--approve-source-export-blocking", preview.source_export_blocking_approval_fingerprint,
        "--approve-wrapper", preview.wrapper_approval_fingerprint,
        "--approve-golden", preview.golden_approval_fingerprint,
      ],
      "--stop-after-stage", "verify_health",
    ]),
    (error) => error.code === "RECOVERY_FIELD_GATE_STOP_STAGE_INVALID",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments(["run", "--plan", planPath, "--plan", planPath]),
    /RECOVERY_FIELD_GATE_ARGUMENTS_INVALID/,
  );

  writePrivateJson(goldenPath, { ...releaseGolden(), schema_version: 2 });
  assert.throws(
    () => previewCloudflareRecoveryFieldGate(baseConfig, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_RELEASE_EVAL_INVALID",
  );
  writePrivateJson(goldenPath, releaseGolden());

  writeFileSync(wrapperPath, `${wrapperScript}# reviewed replacement\n`);
  if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);
  const replacedWrapperHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: initialized.plan.plan_fingerprint,
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      approveTargetExecution: preview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
      approveWrapper: preview.wrapper_approval_fingerprint,
      approveGolden: preview.golden_approval_fingerprint,
    }, replacedWrapperHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.equal(replacedWrapperHarness.wranglerCalls.length, 0);
  assert.equal(replacedWrapperHarness.adminReads, 0);
  writeFileSync(wrapperPath, wrapperScript);
  if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);

  const unusedHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: "0".repeat(64),
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      stopAfterStage: "restore_d1",
    }, unusedHarness.dependencies),
    (error) => error instanceof CloudflareRecoveryAdapterError &&
      error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.equal(unusedHarness.wranglerCalls.length, 0);
  assert.equal(unusedHarness.adminReads, 0);

  const directBypassHarness = providerHarness();
  const unapprovedAdapters = createCloudflareRecoveryFieldGateAdapters({
    ...baseConfig,
    plan: initialized.plan,
  }, directBypassHarness.dependencies);
  await assert.rejects(
    unapprovedAdapters.adapters.export_d1({
      stage: "export_d1",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.equal(directBypassHarness.wranglerCalls.length, 0);

  const invalidStopHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: initialized.plan.plan_fingerprint,
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      approveTargetExecution: preview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
      approveWrapper: preview.wrapper_approval_fingerprint,
      approveGolden: preview.golden_approval_fingerprint,
      stopAfterStage: "verify_health",
    }, invalidStopHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_STOP_STAGE_INVALID",
  );
  assert.equal(invalidStopHarness.wranglerCalls.length, 0);
  assert.equal(invalidStopHarness.adminReads, 0);

  const drillPlanPath = join(sandbox, ".brain-recovery-drill-plan.json");
  const drillStatePath = join(sandbox, ".brain-recovery-drill-state.json");
  const drillArtifactDirectory = join(sandbox, "private-drill-artifacts");
  mkdirSync(drillArtifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(drillArtifactDirectory, 0o700);
  const drillInitialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    drillPlanPath,
    drillStatePath,
    { now: new Date("2026-08-25T12:30:00.000Z") },
  );
  const drillConfig = {
    ...baseConfig,
    planPath: drillPlanPath,
    statePath: drillStatePath,
    artifactDirectory: drillArtifactDirectory,
  };
  const drillPreview = previewCloudflareRecoveryFieldGate(drillConfig, { platform: "darwin" });
  const approvedDrillConfig = Object.freeze({
    ...drillConfig,
    approvePlan: drillInitialized.plan.plan_fingerprint,
    approveDisposableTarget: drillInitialized.plan.target_resource_fingerprint,
    approveTargetExecution: drillPreview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: drillPreview.source_export_blocking_approval_fingerprint,
    approveWrapper: drillPreview.wrapper_approval_fingerprint,
    approveGolden: drillPreview.golden_approval_fingerprint,
  });
  const drillHarness = providerHarness();
  const exportCalls = () => drillHarness.wranglerCalls.filter((call) =>
    call.env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id &&
      call.args[0] === "d1" && call.args[1] === "export").length;
  const rebuildCalls = () => drillHarness.fetchCalls.filter((call) =>
    new URL(call.url).pathname === "/api/admin/brain/reindex" &&
      JSON.parse(call.options.body).confirm === true).length;
  const runToCheckpoint = async (stopAfterStage, currentStage, completedStages) => {
    let stopped = null;
    try {
      const unexpected = await runCloudflareRecoveryFieldGate(
        { ...approvedDrillConfig, stopAfterStage },
        drillHarness.dependencies,
      );
      assert.fail(
        `expected intentional checkpoint after ${stopAfterStage}; ` +
        `runner returned ${unexpected?.errorCode || unexpected?.status?.status || "unknown"}`,
      );
    } catch (error) {
      stopped = error;
    }
    if (!(stopped instanceof CloudflareRecoveryAdapterError)) {
      assert.fail(stopped?.message || "checkpoint did not raise the adapter interruption");
    }
    assert.equal(stopped.code, "RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION");
    const checkpoint = loadVerifiedRecoveryState(drillStatePath, drillInitialized.plan);
    assert.equal(checkpoint.status, "running");
    assert.equal(checkpoint.current_stage, currentStage);
    assert.equal(checkpoint.stage_status, "pending");
    assert.equal(checkpoint.failure, null);
    assert.deepEqual(checkpoint.completed.map((entry) => entry.id), completedStages);
    assert.equal(
      existsSync(join(drillArtifactDirectory, ".brain-recovery-field-gate.lock")),
      false,
    );
  };

  await runToCheckpoint("export_d1", "verify_export", ["export_d1"]);
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 0, 0]);

  // A supervised resume must use the exact golden bytes that were previewed.
  // Replacing them with another structurally valid release suite cannot inherit
  // the old approval or reach Cloudflare, Keychain, import, or evaluation.
  const swappedGolden = releaseGolden();
  swappedGolden.questions[0].question = `${privateSentinel} reviewed replacement`;
  writePrivateJson(goldenPath, swappedGolden);
  assert.notEqual(hash(readFileSync(goldenPath)), drillPreview.golden_approval_fingerprint);
  const callsBeforeGoldenSwap = Object.freeze({
    wrangler: drillHarness.wranglerCalls.length,
    adminReads: drillHarness.adminReads,
    imports: drillHarness.importCalls,
    evals: drillHarness.evalCalls,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate(
      { ...approvedDrillConfig, stopAfterStage: "restore_d1" },
      drillHarness.dependencies,
    ),
    (error) => error instanceof CloudflareRecoveryAdapterError &&
      error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.deepEqual({
    wrangler: drillHarness.wranglerCalls.length,
    adminReads: drillHarness.adminReads,
    imports: drillHarness.importCalls,
    evals: drillHarness.evalCalls,
  }, callsBeforeGoldenSwap);
  assert.equal(
    loadVerifiedRecoveryState(drillStatePath, drillInitialized.plan).current_stage,
    "verify_export",
  );
  assert.equal(
    existsSync(join(drillArtifactDirectory, ".brain-recovery-field-gate.lock")),
    false,
  );
  writePrivateJson(goldenPath, releaseGolden());
  assert.equal(hash(readFileSync(goldenPath)), drillPreview.golden_approval_fingerprint);

  await runToCheckpoint("restore_d1", "verify_d1", [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
  ]);
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 0]);

  await runToCheckpoint("rebuild_vectorize", "verify_health", [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
    "verify_d1", "rebuild_vectorize",
  ]);
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 0]);
  assert.equal(drillHarness.bootstrapCalls, 1);
  assert.equal(drillHarness.promotionCalls, 1);
  assert.equal(drillHarness.currentTargetVersionId, activeWorkerVersionId);
  assert.equal(drillHarness.evalCalls, 0);

  // Reusing the last boundary proves a completed rebuild neither re-stops nor replays.
  const resumedDrill = await runCloudflareRecoveryFieldGate(
    { ...approvedDrillConfig, stopAfterStage: "rebuild_vectorize" },
    drillHarness.dependencies,
  );
  assert.equal(resumedDrill.ok, true);
  assert.equal(resumedDrill.status.status, "complete");
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 0]);
  assert.equal(drillHarness.bootstrapCalls, 1);
  assert.equal(drillHarness.promotionCalls, 1);
  assert.equal(drillHarness.evalCalls, 1);
  assert.equal(existsSync(join(drillArtifactDirectory, ".brain-recovery-field-gate.lock")), false);

  const harness = providerHarness();
  const completed = await runCloudflareRecoveryFieldGate({
    ...baseConfig,
    approvePlan: initialized.plan.plan_fingerprint,
    approveDisposableTarget: initialized.plan.target_resource_fingerprint,
    approveTargetExecution: preview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
    approveWrapper: preview.wrapper_approval_fingerprint,
    approveGolden: preview.golden_approval_fingerprint,
  }, harness.dependencies);
  assert.equal(completed.ok, true);
  assert.equal(completed.status.status, "complete");
  assert.equal(completed.status.completed_stages, 8);
  assert.equal(harness.importCalls, 1);
  assert.equal(harness.evalCalls, 1);
  assert.equal(harness.adminReads, 4);
  assert.equal(harness.fetchCalls.every((call) => call.options.redirect === "error"), true);
  assert.equal(harness.fetchCalls.every((call) => call.options.cache === "no-store"), true);
  assert.equal(harness.fetchCalls.every((call) => new URL(call.url).search === ""), true);
  assert.equal(harness.wranglerCalls.every((call) => call.command !== wrapperPath), true);
  const stateChangingWorkerCalls = harness.wranglerCalls.filter((call) =>
    ["create", "delete", "deploy", "rollback", "upload"].includes(call.args[1]) ||
    ["create", "delete", "deploy", "rollback", "upload"].includes(call.args[0]));
  assert.equal(stateChangingWorkerCalls.length, 1);
  assert.deepEqual(stateChangingWorkerCalls[0].args.slice(0, 6), [
    "versions", "deploy", `${activeWorkerVersionId}@100%`,
    "--name", targetManifest.brain.worker_name, "-y",
  ]);
  assert.equal(harness.wranglerCalls.some((call) =>
    call.env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id &&
    call.args.includes("integrity-check")), false);
  assert.equal(harness.sensitiveBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true);

  const artifactPath = join(artifactDirectory, initialized.plan.artifact.relative_name);
  assert.equal(existsSync(artifactPath), true);
  if (process.platform !== "win32") assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
  assert.equal(existsSync(join(artifactDirectory, ".brain-recovery-field-gate.lock")), false);
  assert.equal(readdirSync(artifactDirectory).some((name) => name.startsWith(".brain-recovery-runtime-")), false);
  const stateText = readFileSync(statePath, "utf8");
  for (const forbidden of [privateSentinel, fixtureAdminKey, sourceManifest.brain.domain, wrapperPath, goldenPath]) {
    assert.equal(stateText.includes(forbidden), false);
  }

  const residueData = join(artifactDirectory, ".brain-recovery-export.sql.tmp-data");
  const residueCombined = join(artifactDirectory, ".brain-recovery-export.sql.tmp-combined");
  writeFileSync(residueData, "synthetic interrupted data partial\n", { mode: 0o600 });
  linkSync(artifactPath, residueCombined);
  const residueHarness = providerHarness();
  const residueGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    residueHarness.dependencies,
  );
  const reconciledArtifact = await residueGate.adapters.export_d1({
    stage: "export_d1",
    attempt: 2,
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
    completed: [],
  });
  assert.equal(reconciledArtifact.artifact_sha256, hash(readFileSync(artifactPath)));
  assert.equal(existsSync(residueData), false);
  assert.equal(existsSync(residueCombined), false);
  assert.equal(statSync(artifactPath).nlink, 1);

  const ambiguousHarness = providerHarness({ ambiguousSourceD1: true });
  const ambiguousGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    ambiguousHarness.dependencies,
  );
  await assert.rejects(
    ambiguousGate.adapters.export_d1({
      stage: "export_d1",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_D1_RESOURCE_AMBIGUOUS",
  );

  const prefixSourceHarness = providerHarness({ sourceMigrationVersion: 12 });
  const prefixSourceGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    prefixSourceHarness.dependencies,
  );
  await assert.rejects(
    prefixSourceGate.adapters.export_d1({
      stage: "export_d1",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_SOURCE_UPGRADE_REQUIRED",
  );
  assert.equal(prefixSourceHarness.wranglerCalls.some((call) =>
    call.args[0] === "d1" && call.args[1] === "export"), false);

  const leasePlanPath = join(sandbox, ".brain-recovery-lease-plan.json");
  const leaseStatePath = join(sandbox, ".brain-recovery-lease-state.json");
  const leaseArtifactDirectory = join(sandbox, "private-lease-artifacts");
  mkdirSync(leaseArtifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(leaseArtifactDirectory, 0o700);
  const leaseInitialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    leasePlanPath,
    leaseStatePath,
    { now: new Date("2026-08-25T12:45:00.000Z") },
  );
  const leaseConfig = {
    ...baseConfig,
    planPath: leasePlanPath,
    statePath: leaseStatePath,
    artifactDirectory: leaseArtifactDirectory,
  };
  const leasePreview = previewCloudflareRecoveryFieldGate(leaseConfig, { platform: "darwin" });
  const approvedLeaseConfig = Object.freeze({
    ...leaseConfig,
    plan: leaseInitialized.plan,
    approvePlan: leaseInitialized.plan.plan_fingerprint,
    approveDisposableTarget: leaseInitialized.plan.target_resource_fingerprint,
    approveTargetExecution: leasePreview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: leasePreview.source_export_blocking_approval_fingerprint,
    approveWrapper: leasePreview.wrapper_approval_fingerprint,
    approveGolden: leasePreview.golden_approval_fingerprint,
  });
  const leasedSourceHarness = providerHarness({ sourceDrainLease: true });
  const leasedSourceGate = createCloudflareRecoveryFieldGateAdapters(
    approvedLeaseConfig,
    leasedSourceHarness.dependencies,
  );
  const leaseContext = {
    planFingerprint: leaseInitialized.plan.plan_fingerprint,
    targetResourceFingerprint: leaseInitialized.plan.target_resource_fingerprint,
  };
  const leasedExport = await leasedSourceGate.adapters.export_d1({
    stage: "export_d1",
    attempt: 2,
    ...leaseContext,
    completed: [],
  });
  const leasedArtifactPath = join(
    leaseArtifactDirectory,
    leaseInitialized.plan.artifact.relative_name,
  );
  const leasedArtifactText = readFileSync(leasedArtifactPath, "utf8");
  assert.equal(leasedArtifactText.includes(normalizedInstallStateSql), true);
  assert.equal(leasedArtifactText.includes(leasedSourceHarness.sourceLeaseMarker), false);
  assert.equal(leasedSourceHarness.normalizedLeaseSelections, 1);
  const verifyLeasedExport = () => leasedSourceGate.adapters.verify_export({
    stage: "verify_export",
    ...leaseContext,
    completed: [{ id: "export_d1", evidence: leasedExport }],
  });
  const firstLeasedVerification = await verifyLeasedExport();
  const retriedLeasedVerification = await verifyLeasedExport();
  assert.equal(firstLeasedVerification.aggregate_fingerprint, retriedLeasedVerification.aggregate_fingerprint);

  const redirectHarness = providerHarness({
    redirectHealth: true,
    targetVersionId: activeWorkerVersionId,
  });
  const redirectGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    redirectHarness.dependencies,
  );
  await assert.rejects(
    redirectGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REDIRECT_REFUSED",
  );
  assert.equal(redirectHarness.adminReads, 0);
  assert.equal(redirectHarness.fetchCalls.length, 1);
  assert.equal(redirectHarness.fetchCalls.some((call) =>
    new URL(call.url).hostname === "redirected.fixture.invalid"), false);

  const authenticatedRedirectHarness = providerHarness({
    redirectInventory: true,
    targetVersionId: activeWorkerVersionId,
  });
  const authenticatedRedirectGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    authenticatedRedirectHarness.dependencies,
  );
  await assert.rejects(
    authenticatedRedirectGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "rebuild_vectorize", evidence: { chunk_count: 5 } }],
    }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REQUEST_FAILED",
  );
  assert.equal(authenticatedRedirectHarness.adminReads, 1);
  assert.equal(authenticatedRedirectHarness.fetchCalls.length, 2);
  assert.equal(authenticatedRedirectHarness.fetchCalls.some((call) =>
    new URL(call.url).hostname === "redirected.fixture.invalid"), false);

  const extraSecretHarness = providerHarness({ extraTargetSecret: true });
  const extraSecretGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    extraSecretHarness.dependencies,
  );
  await assert.rejects(
    extraSecretGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
  );

  const extraBindingHarness = providerHarness({ extraTargetBinding: true });
  const extraBindingGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    extraBindingHarness.dependencies,
  );
  await assert.rejects(
    extraBindingGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
  );

  // Equal active/paused settings are insufficient if both differ from the
  // manifest. Reject enablement, model substitution, omission, and duplication
  // before opening the data plane or reading its admin credential.
  for (const changedRole of ["source", "target"]) for (const alter of [
    (bindings) => bindings.map((entry) => entry.name === "OCR_ENABLED" ? { ...entry, text: "1" } : entry),
    (bindings) => bindings.map((entry) => entry.name === "OCR_MODEL" ? { ...entry, text: "@cf/fixture/unreviewed" } : entry),
    (bindings) => bindings.filter((entry) => entry.name !== "OCR_ENABLED"),
    (bindings) => [...bindings, { type: "plain_text", name: "OCR_MODEL", text: "@cf/fixture/duplicate" }],
  ]) {
    const ocrHarness = providerHarness({
      transformWorkerBindings: (bindings, { role }) => role === changedRole ? alter(bindings) : bindings,
    });
    const ocrGate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, ocrHarness.dependencies);
    const stage = changedRole === "source" ? "export_d1" : "prove_target_clean";
    await assert.rejects(ocrGate.adapters[stage]({
      stage,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }), (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID");
    assert.equal(ocrHarness.adminReads, 0);
    assert.equal(ocrHarness.fetchCalls.length, 0);
  }

  for (const changedRole of ["source", "target"]) for (const alter of [
    (bindings) => [...bindings, { type: "secret_text", name: "UNREVIEWED_SECRET" }],
    (bindings) => [...bindings, { type: "secret_text", name: "ADMIN_KEY" }],
    (bindings) => bindings.map((entry) => entry.name === "ADMIN_KEY" ? { ...entry, name: ["ADMIN_KEY"] } : entry),
    (bindings) => bindings.map((entry) => entry.name === "ADMIN_KEY" ? { ...entry, name: "ADMIN_KEY\n" } : entry),
    (bindings) => bindings.filter((entry) => entry.name !== "ADMIN_KEY"),
  ]) {
    const secretHarness = providerHarness({
      transformWorkerBindings: (bindings, { role }) => role === changedRole ? alter(bindings) : bindings,
    });
    const secretGate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, secretHarness.dependencies);
    const stage = changedRole === "source" ? "export_d1" : "prove_target_clean";
    await assert.rejects(secretGate.adapters[stage]({
      stage,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }), (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID");
    assert.equal(secretHarness.adminReads, 0);
    assert.equal(secretHarness.fetchCalls.length, 0);
    assert.equal(secretHarness.wranglerCalls.some((call) => call.args[0] === "secret"), false);
  }

  for (const name of sourceSecretNames.filter((name) => name !== "ADMIN_KEY")) {
    const secretHarness = providerHarness({
      transformWorkerBindings: (bindings, { role }) => role === "target"
        ? [...bindings, { type: "secret_text", name }]
        : bindings,
    });
    const secretGate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, secretHarness.dependencies);
    await assert.rejects(secretGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }), (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID");
  }

  // Explicit opt-in uses the reviewed manifest values, not hard-coded disabled
  // settings. A later manifest edit remains refused by the original plan.
  targetManifest.safety = { ocr: { enabled: true, model: "@cf/fixture/reviewed-model" } };
  writePrivateJson(targetManifestPath, targetManifest);
  try {
    const ocrPlanPath = join(sandbox, ".brain-recovery-ocr-plan.json");
    const ocrStatePath = join(sandbox, ".brain-recovery-ocr-state.json");
    const ocrInitialized = initializeVerifiedRecovery(
      sourceManifestPath, targetManifestPath, ocrPlanPath, ocrStatePath,
      { now: new Date("2026-08-25T12:45:00.000Z") },
    );
    const ocrConfig = { ...baseConfig, planPath: ocrPlanPath, statePath: ocrStatePath };
    const ocrPreview = previewCloudflareRecoveryFieldGate(ocrConfig, { platform: "darwin" });
    const ocrHarness = providerHarness();
    const ocrGate = createCloudflareRecoveryFieldGateAdapters({
      ...ocrConfig,
      plan: ocrInitialized.plan,
      approvePlan: ocrInitialized.plan.plan_fingerprint,
      approveDisposableTarget: ocrPreview.target_approval_fingerprint,
      approveTargetExecution: ocrPreview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: ocrPreview.source_export_blocking_approval_fingerprint,
      approveWrapper: ocrPreview.wrapper_approval_fingerprint,
      approveGolden: ocrPreview.golden_approval_fingerprint,
    }, ocrHarness.dependencies);
    const clean = await ocrGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: ocrInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: ocrInitialized.plan.target_resource_fingerprint,
      completed: [],
    });
    assert.equal(clean.user_table_count, 0);
    assert.equal(clean.vector_count, 0);
    assert.throws(() => createCloudflareRecoveryFieldGateAdapters(
      approvedAdapterConfig, ocrHarness.dependencies,
    ), /verified recovery manifest binding changed after plan review/);
  } finally {
    delete targetManifest.safety;
    writePrivateJson(targetManifestPath, targetManifest);
  }

  const mismatchedCodeHarness = providerHarness({
    activeScriptEtag: "c".repeat(64),
  });
  const mismatchedCodeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    mismatchedCodeHarness.dependencies,
  );
  await assert.rejects(
    mismatchedCodeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_CODE_INVALID",
  );

  const splitDeploymentHarness = providerHarness({ splitTargetDeployment: true });
  const splitDeploymentGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    splitDeploymentHarness.dependencies,
  );
  await assert.rejects(
    splitDeploymentGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS",
  );

  const missingVectorCountHarness = providerHarness({ missingVectorCount: true });
  const missingVectorCountGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    missingVectorCountHarness.dependencies,
  );
  await assert.rejects(
    missingVectorCountGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_VECTORIZE_RESPONSE_INVALID",
  );

  const changedVersionHarness = providerHarness({ targetVersionId: "unreviewed-target-version" });
  const changedVersionGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    changedVersionHarness.dependencies,
  );
  await assert.rejects(
    changedVersionGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );

  const completedEvidence = [{
    id: "verify_export",
    evidence: {
      artifact_sha256: hash(readFileSync(artifactPath)),
      artifact_bytes: statSync(artifactPath).size,
      ...expectedSnapshot,
    },
  }];
  const prepopulatedHarness = providerHarness({ initialTargetRestored: true });
  const prepopulatedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    prepopulatedHarness.dependencies,
  );
  await assert.rejects(
    prepopulatedGate.adapters.restore_d1({
      stage: "restore_d1",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: completedEvidence,
    }),
    (error) => error.code === "RECOVERY_TARGET_IMPORT_AMBIGUOUS",
  );
  const reconciled = await prepopulatedGate.adapters.restore_d1({
    stage: "restore_d1",
    attempt: 2,
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
    completed: completedEvidence,
  });
  assert.equal(reconciled.import_completed, true);
  assert.equal(prepopulatedHarness.importCalls, 0);

  const preindexedHarness = providerHarness({ initialTargetRestored: true, initialVectorCount: 2 });
  const preindexedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    preindexedHarness.dependencies,
  );
  await assert.rejects(
    preindexedGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
    }),
    (error) => error.code === "RECOVERY_VECTORIZE_TARGET_AMBIGUOUS",
  );
  assert.equal(preindexedHarness.adminReads, 0);

  // A resumed journal can carry an old verify_d1 checkpoint. Recheck the live
  // target schema before any current drain or Vectorize call instead of
  // assuming the historical checkpoint has the schema-13 writer protocol.
  const prefixTargetHarness = providerHarness({
    initialTargetRestored: true,
    targetMigrationVersion: 12,
  });
  const prefixTargetGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    prefixTargetHarness.dependencies,
  );
  await assert.rejects(
    prefixTargetGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 2,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
    }),
    (error) => error.code === "RECOVERY_TARGET_UPGRADE_REQUIRED",
  );
  assert.equal(prefixTargetHarness.adminReads, 0);
  assert.equal(prefixTargetHarness.fetchCalls.length, 0);

  const interruptedHarness = providerHarness({
    initialTargetRestored: true,
    failBootstrapOnce: true,
  });
  const interruptedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    interruptedHarness.dependencies,
  );
  const rebuildContext = {
    stage: "rebuild_vectorize",
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
    completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
  };
  await assert.rejects(
    interruptedGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REQUEST_FAILED",
  );
  const resumedRebuild = await interruptedGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.deepEqual(resumedRebuild, {
    chunk_count: 5,
    vector_count: 5,
    pending_outbox: 0,
    failed_vectors: 0,
  });
  assert.equal(interruptedHarness.bootstrapCalls, 2);
  assert.equal(interruptedHarness.sleepCalls, 0);
  assert.equal(interruptedHarness.promotionCalls, 1);

  const progressedHarness = providerHarness({
    initialTargetRestored: true,
    failBootstrapAfterProgressOnce: true,
  });
  const progressedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    progressedHarness.dependencies,
  );
  await assert.rejects(
    progressedGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REQUEST_FAILED",
  );
  assert.equal(progressedHarness.bootstrapEpoch, 1);
  assert.equal(progressedHarness.bootstrapCursor, "fixture:chunk#00000004");
  const resumedProgress = await progressedGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.equal(resumedProgress.vector_count, 5);
  assert.equal(progressedHarness.bootstrapEpoch, 1);
  assert.equal(progressedHarness.bootstrapCursor, "fixture:chunk#00000004");
  assert.equal(progressedHarness.fetchCalls.some((call) =>
    new URL(call.url).pathname === "/api/admin/brain/reindex"), false);

  const laggedVisibilityHarness = providerHarness({
    initialTargetRestored: true,
    readinessLagAfterBootstrap: true,
  });
  const laggedVisibilityGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    laggedVisibilityHarness.dependencies,
  );
  const laggedVisibility = await laggedVisibilityGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 1,
  });
  assert.equal(laggedVisibility.vector_count, 5);
  assert.equal(laggedVisibilityHarness.bootstrapCalls, 2);
  assert.equal(laggedVisibilityHarness.sleepCalls, 1);

  const residueRetryHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapPageSize: 3,
    bootstrapResidueRetryAfterProgress: true,
  });
  const residueRetryGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    residueRetryHarness.dependencies,
  );
  const residueRetry = await residueRetryGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 1,
  });
  assert.equal(residueRetry.vector_count, 5);
  assert.equal(residueRetryHarness.bootstrapCalls, 4,
    "accepted residue, visibility wait, and verified rebase must all be polled");
  assert.equal(residueRetryHarness.sleepCalls, 3);
  assert.equal(residueRetryHarness.promotionCalls, 1);

  const mixedResidueHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapPageSize: 3,
    bootstrapResidueRetryAfterProgress: true,
    bootstrapReceiptTransform: (receipt) => receipt.phase === "legacy_drain"
      ? { ...receipt, queued: 2, submitted: 1 }
      : receipt,
  });
  const mixedResidueGate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, mixedResidueHarness.dependencies);
  const mixedResidue = await mixedResidueGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 });
  assert.equal(mixedResidue.vector_count, 5);
  assert.equal(mixedResidueHarness.bootstrapCalls, 4,
    "legacy deletes are queue operations, not unconfirmed current chunks");
  assert.equal(mixedResidueHarness.promotionCalls, 1);

  for (const chunkCount of [5, 0]) {
    let firstReceipt = true;
    const deleteResidueHarness = providerHarness({
      initialTargetRestored: true,
      targetChunkCount: chunkCount,
      bootstrapReceiptTransform: (receipt) => {
        if (!firstReceipt) return receipt;
        firstReceipt = false;
        return { ...receipt, phase: "legacy_drain", queued: 1, complete: false, vector_ready: false };
      },
    });
    const deleteResidueGate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, deleteResidueHarness.dependencies);
    const deleteResidue = await deleteResidueGate.adapters.rebuild_vectorize({
      ...rebuildContext, attempt: 1,
      completed: [{ id: "verify_d1", evidence: snapshotForChunkCount(chunkCount) }],
    });
    assert.equal(deleteResidue.vector_count, chunkCount);
    assert.equal(deleteResidueHarness.bootstrapCalls, 2,
      "zero remaining chunks does not acknowledge an outstanding delete");
    assert.equal(deleteResidueHarness.bootstrapEpoch, 1, "receipt validation does not reset the durable epoch");
    assert.equal(deleteResidueHarness.promotionCalls, 1);
  }

  for (const phase of ["building", "waiting", "complete"]) {
    const excessQueueHarness = providerHarness({
      initialTargetRestored: true,
      bootstrapReceiptTransform: (receipt) => ({
        ...receipt, phase, queued: receipt.remaining + 1,
        complete: phase === "complete", vector_ready: phase === "complete",
      }),
    });
    const excessQueueGate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, excessQueueHarness.dependencies);
    await assert.rejects(excessQueueGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
      (error) => error.code === "RECOVERY_BOOTSTRAP_RECEIPT_INVALID");
    assert.equal(excessQueueHarness.promotionCalls, 0,
      "only an incomplete legacy drain may report more queue work than remaining chunks");
  }

  // The old active /drain loop could submit at most 79,200 restored rows. The
  // paused schema-13 bootstrap advances its durable provider-receipt cursor
  // until exact completion, with no corpus-sized adapter ceiling.
  const largeChunkCount = 80_001;
  const largeSnapshot = snapshotForChunkCount(largeChunkCount);
  const largeHarness = providerHarness({
    initialTargetRestored: true,
    targetChunkCount: largeChunkCount,
  });
  const largeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    largeHarness.dependencies,
  );
  const largeResult = await largeGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 1,
    completed: [{ id: "verify_d1", evidence: largeSnapshot }],
  });
  assert.deepEqual(largeResult, {
    chunk_count: largeChunkCount,
    vector_count: largeChunkCount,
    pending_outbox: 0,
    failed_vectors: 0,
  });
  assert.equal(largeHarness.bootstrapCalls, Math.ceil(largeChunkCount / 3_000));
  assert.equal(largeHarness.promotionCalls, 1);
  assert.equal(largeHarness.fetchCalls.some((call) =>
    new URL(call.url).pathname === "/api/admin/brain/drain"), false);

  const busyHarness = providerHarness({ initialTargetRestored: true, bootstrapBusyOnce: true });
  const busyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    busyHarness.dependencies,
  );
  const busyResult = await busyGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 });
  assert.equal(busyResult.vector_count, 5);
  assert.equal(busyHarness.bootstrapCalls, 2);
  assert.equal(busyHarness.sleepCalls, 1);

  const malformedReceiptHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapReceiptTransform: (receipt) => ({ ...receipt, unreviewed_detail: "refuse" }),
  });
  const malformedReceiptGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    malformedReceiptHarness.dependencies,
  );
  await assert.rejects(
    malformedReceiptGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_BOOTSTRAP_RECEIPT_INVALID",
  );
  assert.equal(malformedReceiptHarness.promotionCalls, 0);

  const failedCompleteReceiptHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapReceiptTransform: (receipt) => receipt.complete
      ? { ...receipt, failed: 1 }
      : receipt,
  });
  const failedCompleteReceiptGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    failedCompleteReceiptHarness.dependencies,
  );
  await assert.rejects(
    failedCompleteReceiptGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_BOOTSTRAP_RECEIPT_INVALID",
  );
  assert.equal(failedCompleteReceiptHarness.promotionCalls, 0);

  const malformedBusyHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapBusyOnce: true,
    busyReceiptTransform: (receipt) => ({ ...receipt, error: "unreviewed" }),
  });
  const malformedBusyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    malformedBusyHarness.dependencies,
  );
  await assert.rejects(
    malformedBusyGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_BOOTSTRAP_BUSY_RECEIPT_INVALID",
  );
  assert.equal(malformedBusyHarness.promotionCalls, 0);

  for (const active of [false, true]) for (const alter of [
    (receipt) => ({ ...receipt, ok: !active }),
    (receipt) => ({ ...receipt, accepting_documents: !active }),
    (receipt) => ({ ...receipt, status: active ? "paused-for-upgrade" : "ok" }),
    (receipt) => { const changed = { ...receipt }; delete changed.accepting_documents; return changed; },
  ]) {
    const dishonestHealthHarness = providerHarness({
      targetVersionId: active ? activeWorkerVersionId : pausedWorkerVersionId,
      transformHealthReceipt: alter,
    });
    const dishonestHealthGate = createCloudflareRecoveryFieldGateAdapters(
      approvedAdapterConfig, dishonestHealthHarness.dependencies,
    );
    const stage = active ? "verify_health" : "prove_target_clean";
    await assert.rejects(dishonestHealthGate.adapters[stage]({
      stage,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "rebuild_vectorize", evidence: { chunk_count: 5 } }],
    }), (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH");
    assert.equal(dishonestHealthHarness.adminReads, 0);
    assert.equal(dishonestHealthHarness.promotionCalls, 0);
  }

  const mutatedCorpusHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapMutatesCorpus: true,
  });
  const mutatedCorpusGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    mutatedCorpusHarness.dependencies,
  );
  await assert.rejects(
    mutatedCorpusGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_TARGET_CHANGED_DURING_REINDEX",
  );
  assert.equal(mutatedCorpusHarness.promotionCalls, 0);

  const promotionNoopHarness = providerHarness({
    initialTargetRestored: true,
    promotionNoop: true,
  });
  const promotionNoopGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    promotionNoopHarness.dependencies,
  );
  await assert.rejects(
    promotionNoopGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  assert.equal(promotionNoopHarness.promotionCalls, 1);

  const badPausedModeHarness = providerHarness({ pausedVersionMode: "active" });
  const badPausedModeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badPausedModeHarness.dependencies,
  );
  await assert.rejects(
    badPausedModeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_MODE_INVALID",
  );
  assert.equal(badPausedModeHarness.bootstrapCalls, 0);
  assert.equal(badPausedModeHarness.promotionCalls, 0);

  const badActiveModeHarness = providerHarness({ activeVersionMode: "paused-for-upgrade" });
  const badActiveModeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badActiveModeHarness.dependencies,
  );
  await assert.rejects(
    badActiveModeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_MODE_INVALID",
  );
  assert.equal(badActiveModeHarness.bootstrapCalls, 0);
  assert.equal(badActiveModeHarness.promotionCalls, 0);

  const badHealthModeHarness = providerHarness({ healthModeOverride: "active" });
  const badHealthModeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badHealthModeHarness.dependencies,
  );
  await assert.rejects(
    badHealthModeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH",
  );
  assert.equal(badHealthModeHarness.bootstrapCalls, 0);
  assert.equal(badHealthModeHarness.promotionCalls, 0);

  const badHealthProtocolHarness = providerHarness({ healthProtocolOverride: "legacy" });
  const badHealthProtocolGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badHealthProtocolHarness.dependencies,
  );
  await assert.rejects(
    badHealthProtocolGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH",
  );

  const pausedFinalGateHarness = providerHarness();
  const pausedFinalGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    pausedFinalGateHarness.dependencies,
  );
  await assert.rejects(
    pausedFinalGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "rebuild_vectorize", evidence: { chunk_count: 5 } }],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  await assert.rejects(
    pausedFinalGate.adapters.verify_eval({
      stage: "verify_eval",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );

  const changingEvalHarness = providerHarness({
    deploymentChangesDuringEval: true,
    targetVersionId: activeWorkerVersionId,
  });
  const changingEvalGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    changingEvalHarness.dependencies,
  );
  await assert.rejects(
    changingEvalGate.adapters.verify_eval({
      stage: "verify_eval",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  assert.equal(changingEvalHarness.evalCalls, 1);

  const activeFirstAttemptHarness = providerHarness({
    initialTargetRestored: true,
    initialVectorCount: 5,
    targetVersionId: activeWorkerVersionId,
  });
  const activeFirstAttemptGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    activeFirstAttemptHarness.dependencies,
  );
  await assert.rejects(
    activeFirstAttemptGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  assert.equal(activeFirstAttemptHarness.bootstrapCalls, 0);
  assert.equal(activeFirstAttemptHarness.promotionCalls, 0);
  const reconciledActive = await activeFirstAttemptGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.equal(reconciledActive.vector_count, 5);
  assert.equal(activeFirstAttemptHarness.promotionCalls, 0);

  const ambiguousPromotionHarness = providerHarness({
    initialTargetRestored: true,
    failPromotionAfterApplyOnce: true,
  });
  const ambiguousPromotionGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    ambiguousPromotionHarness.dependencies,
  );
  await assert.rejects(
    ambiguousPromotionGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_WRANGLER_CALL_FAILED",
  );
  assert.equal(ambiguousPromotionHarness.currentTargetVersionId, activeWorkerVersionId);
  const reconciledPromotion = await ambiguousPromotionGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.equal(reconciledPromotion.vector_count, 5);
  assert.equal(ambiguousPromotionHarness.bootstrapCalls, 1);
  assert.equal(ambiguousPromotionHarness.promotionCalls, 1);

  const productionTargetPath = join(sandbox, "production-target.manifest.json");
  const productionPlanPath = join(sandbox, ".brain-recovery-production-plan.json");
  const productionStatePath = join(sandbox, ".brain-recovery-production-state.json");
  writePrivateJson(productionTargetPath, {
    ...structuredClone(targetManifest),
    brain: {
      ...targetManifest.brain,
      worker_name: "fixture-production-worker",
      domain: "fixture-production-worker.fixture-account.workers.dev",
    },
  });
  initializeVerifiedRecovery(
    sourceManifestPath,
    productionTargetPath,
    productionPlanPath,
    productionStatePath,
    { now: new Date("2026-08-25T12:00:01.000Z") },
  );
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...baseConfig,
      targetManifestPath: productionTargetPath,
      planPath: productionPlanPath,
      statePath: productionStatePath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_TARGET_NOT_DISPOSABLE",
  );

  const unsafeWrapper = join(sandbox, "unsafe-wrapper-link");
  symlinkSync(wrapperPath, unsafeWrapper);
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({ ...baseConfig, wranglerWrapperPath: unsafeWrapper }, {
      platform: "darwin",
    }),
    (error) => error.code === "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
  );

  if (process.platform !== "win32" && existsSync("/usr/bin/sqlite3")) {
    const localArtifact = join(sandbox, ".brain-recovery-local-verifier.sql");
    const schemaSql = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const receipts = appliedMigrations.map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const largeCorpus =
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6000) " +
      "INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash) " +
      "SELECT 'doc-'||x,'fixture','source-'||x,1700000000000,'hash-'||x FROM n;";
    const sql = `${schemaSql}\n${receipts}\n${largeCorpus}\n`;
    writeFileSync(localArtifact, sql, { mode: 0o600 });
    chmodSync(localArtifact, 0o600);
    const local = await verifyRecoverySqlArtifact(localArtifact);
    assert.equal(local.integrity, "ok");
    assert.equal(local.document_count, 6000);
    assert.equal(local.chunk_count, 0);
    assert.equal(local.fts_count, 0);

    // Confirmed bulk-bootstrap receipts are durable evidence for one provider
    // index, but not part of the recoverable corpus. Even a source retaining
    // that history must produce the same normalized structural aggregate.
    const batchHistoryArtifact = join(sandbox, ".brain-recovery-batch-history-verifier.sql");
    const batchHistory =
      "INSERT INTO vector_bootstrap_batches " +
      "(epoch,batch_no,start_cursor,end_cursor,row_count,status,mutation_id,submitted_at,confirmed_at) " +
      "VALUES (7,1,'fixture:start','fixture:end',1,'confirmed','fixture-mutation',1,2);";
    writeFileSync(batchHistoryArtifact, `${sql}\n${batchHistory}\n`, { mode: 0o600 });
    chmodSync(batchHistoryArtifact, 0o600);
    const withBatchHistory = await verifyRecoverySqlArtifact(batchHistoryArtifact);
    assert.equal(withBatchHistory.schema_fingerprint, local.schema_fingerprint);
    assert.equal(withBatchHistory.aggregate_fingerprint, local.aggregate_fingerprint);
    assert.equal(withBatchHistory.document_count, local.document_count);

    // D1 removes full-line SQL comments from sqlite_schema. The exact migration
    // checksums remain separately pinned, so schema comparison must treat only
    // those non-semantic comments and whitespace as equivalent.
    const commentlessArtifact = join(sandbox, ".brain-recovery-commentless-verifier.sql");
    const commentlessSchema = schemaSql.replace(/^[ \t]*--[^\r\n]*(?:\r?\n|$)/gm, "");
    writeFileSync(commentlessArtifact, `${commentlessSchema}\n${receipts}\n`, { mode: 0o600 });
    chmodSync(commentlessArtifact, 0o600);
    const commentless = await verifyRecoverySqlArtifact(commentlessArtifact);
    assert.equal(commentless.schema_fingerprint, local.schema_fingerprint);

    // Recovery intentionally accepts an exact applied-migration prefix. The
    // normalized aggregate must not reference lease columns before 0011.
    const prefixMigrationNames = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .slice(0, 10);
    const prefixSchema = prefixMigrationNames
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const prefixReceipts = appliedMigrations.slice(0, 10).map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const prefixInstall =
      "INSERT INTO install_state " +
      "(id,client_slug,product_version,schema_version,gate_version,installed_at,ring,outbox_generation) " +
      "VALUES (1,'fixture-brain','0.1.12',10,4,'2026-08-25T12:00:00.000Z','stable',9);";
    const prefixArtifact = join(sandbox, ".brain-recovery-prefix-verifier.sql");
    writeFileSync(prefixArtifact, `${prefixSchema}\n${prefixReceipts}\n${prefixInstall}\n`, { mode: 0o600 });
    chmodSync(prefixArtifact, 0o600);
    const prefix = await verifyRecoverySqlArtifact(prefixArtifact);
    assert.equal(prefix.integrity, "ok");
    assert.equal(prefix.document_count, 0);

    // Schema 12 is the immediate historical prefix. Its exact artifact remains
    // inspectable offline even though live recovery requires schema 13.
    const schema12MigrationNames = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .slice(0, 12);
    const schema12Schema = schema12MigrationNames
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const schema12Receipts = appliedMigrations.slice(0, 12).map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const schema12Artifact = join(sandbox, ".brain-recovery-schema12-prefix-verifier.sql");
    writeFileSync(schema12Artifact, `${schema12Schema}\n${schema12Receipts}\n`, { mode: 0o600 });
    chmodSync(schema12Artifact, 0o600);
    const schema12 = await verifyRecoverySqlArtifact(schema12Artifact);
    assert.equal(schema12.integrity, "ok");
    assert.equal(schema12.document_count, 0);
  }

  console.log("PASS  Cloudflare recovery adapter is disposable-only, credential-safe, redirect-safe, and resumable");
} finally {
  try { unlinkSync(join(artifactDirectory, ".brain-recovery-field-gate.lock")); } catch { /* absent */ }
  rmSync(sandbox, { recursive: true, force: true });
}
