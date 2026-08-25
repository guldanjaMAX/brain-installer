import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

import {
  CloudflareRecoveryAdapterError,
  RECOVERY_DURABLE_TABLES,
  RECOVERY_EXPORT_TABLES,
  RECOVERY_FIELD_GATE_STOP_STAGES,
  createCloudflareRecoveryFieldGateAdapters,
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
      worker_version_id: "fixture-version-id",
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
  ].map((name) => `0 AS "${name}"`).join(","),
);
const deterministicDataExport = "-- deterministic data-only fixture\n";
const deterministicDataFingerprint = hash(deterministicDataExport);
const expectedSnapshot = Object.freeze({
  integrity: "ok",
  schema_fingerprint: hash(canonical({ migrations: appliedMigrations, schema: schemaRows })),
  aggregate_fingerprint: hash(canonical(aggregateTemplate)),
  document_count: 3,
  chunk_count: 5,
  fts_count: 5,
  content_fingerprint: deterministicDataFingerprint,
});

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
  redirectHealth = false,
  redirectInventory = false,
  extraTargetSecret = false,
  failDrainOnce = false,
  initialTargetRestored = false,
  initialVectorCount = 0,
  missingVectorCount = false,
  targetVersionId = "fixture-version-id",
} = {}) {
  let targetRestored = initialTargetRestored;
  let vectorCount = initialVectorCount;
  let outbox = 0;
  let evalCalls = 0;
  let adminReads = 0;
  let importCalls = 0;
  let drainFailuresRemaining = failDrainOnce ? 1 : 0;
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
    assert.equal(env.WRANGLER_LOG, "none");
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
      return ok({ versions: [{ version_id: isSource ? "fixture-version-id" : targetVersionId, percentage: 100 }] });
    }
    if (args[0] === "versions" && args[1] === "view") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      const manifest = isSource ? sourceManifest : targetManifest;
      return ok({
        id: "fixture-version-id",
        resources: {
          bindings: [
            { type: "d1", name: "DB", id: cloudflare.d1_database_id },
            { type: "vectorize", name: "VECTORIZE", index_name: cloudflare.vectorize_index },
            { type: "plain_text", name: "STORAGE", text: "d1" },
            { type: "plain_text", name: "BRAIN_NAME", text: manifest.client.slug },
            { type: "plain_text", name: "BRAIN_VERSION", text: manifest.brain.version },
            { type: "secret_text", name: "ADMIN_KEY" },
            ...(!isSource && extraTargetSecret
              ? [{ type: "secret_text", name: "UNREVIEWED_SECRET" }]
              : []),
          ],
        },
      });
    }
    if (args[0] === "d1" && args[1] === "export") {
      const output = args[args.indexOf("--output") + 1];
      const exportedTables = args
        .map((value, index) => value === "--table" ? args[index + 1] : null)
        .filter(Boolean);
      assert.deepEqual(exportedTables, [...RECOVERY_EXPORT_TABLES]);
      assert.equal(exportedTables.includes("vector_outbox"), false);
      writeFileSync(output, deterministicDataExport, { mode: 0o600 });
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--file")) {
      importCalls++;
      targetRestored = true;
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
        rows = appliedMigrations;
      } else if (/SELECT name FROM sqlite_schema/.test(sql)) {
        rows = [...RECOVERY_DURABLE_TABLES].sort().map((name) => ({ name }));
      } else if (/SELECT type,name,tbl_name/.test(sql)) {
        rows = schemaRows;
      } else if (/documents_ingested_max/.test(sql)) {
        rows = [{ ...aggregateTemplate, vector_outbox: String(outbox) }];
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
      return response({ ok: true, brain: "fixture-brain", version: "0.1.12" });
    }
    if (path === "/api/admin/brain/reindex") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      const body = JSON.parse(options.body);
      if (!body.confirm) return response({
        source: null, dry_run: true, chunks: 5, queued: 0, already_queued: 0,
      });
      const alreadyQueued = outbox;
      const queued = Math.max(0, 5 - alreadyQueued);
      outbox = 5;
      return response({
        source: null, dry_run: false, chunks: 5, queued, already_queued: alreadyQueued, pending: 5,
      });
    }
    if (path === "/api/admin/brain/drain") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      if (drainFailuresRemaining > 0) {
        drainFailuresRemaining--;
        throw new TypeError("synthetic interrupted drain");
      }
      vectorCount = 5;
      outbox = 0;
      return response({ drained: 5, remaining: 0 });
    }
    if (path === "/api/admin/brain/documents") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      if (redirectInventory) {
        // Match native fetch with redirect:error: no request is issued to the
        // Location host, so the authenticated header cannot cross origins.
        throw new TypeError("redirect mode is set to error");
      }
      return response({ backend: "d1", rows: [], vector_backlog: { pending: 0, upserts: 0, deletes: 0 } });
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
        return { status: 0 };
      },
      sleep: async () => {},
      clock: (() => {
        let value = Date.parse("2026-08-25T13:00:00.000Z");
        return () => new Date(value += 1000);
      })(),
    },
    get adminReads() { return adminReads; },
    get evalCalls() { return evalCalls; },
    get importCalls() { return importCalls; },
    get wranglerCalls() { return wranglerCalls; },
    get fetchCalls() { return fetchCalls; },
    get sensitiveBuffers() { return sensitiveBuffers; },
  };
}

try {
  writePrivateJson(sourceManifestPath, sourceManifest);
  writePrivateJson(targetManifestPath, targetManifest);
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
    await assert.rejects(
      runCloudflareRecoveryFieldGate(
        { ...approvedDrillConfig, stopAfterStage },
        drillHarness.dependencies,
      ),
      (error) => error instanceof CloudflareRecoveryAdapterError &&
        error.code === "RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION",
    );
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
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 1]);
  assert.equal(drillHarness.evalCalls, 0);

  // Reusing the last boundary proves a completed rebuild neither re-stops nor replays.
  const resumedDrill = await runCloudflareRecoveryFieldGate(
    { ...approvedDrillConfig, stopAfterStage: "rebuild_vectorize" },
    drillHarness.dependencies,
  );
  assert.equal(resumedDrill.ok, true);
  assert.equal(resumedDrill.status.status, "complete");
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 1]);
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
  assert.equal(harness.adminReads, 3);
  assert.equal(harness.fetchCalls.every((call) => call.options.redirect === "error"), true);
  assert.equal(harness.fetchCalls.every((call) => call.options.cache === "no-store"), true);
  assert.equal(harness.fetchCalls.every((call) => new URL(call.url).search === ""), true);
  assert.equal(harness.wranglerCalls.every((call) => call.command !== wrapperPath), true);
  assert.equal(harness.wranglerCalls.some((call) =>
    ["create", "delete", "deploy", "rollback"].includes(call.args[1]) ||
    ["create", "delete", "deploy", "rollback"].includes(call.args[0])), false);
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

  const redirectHarness = providerHarness({ redirectHealth: true });
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

  const authenticatedRedirectHarness = providerHarness({ redirectInventory: true });
  const authenticatedRedirectGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    authenticatedRedirectHarness.dependencies,
  );
  await assert.rejects(
    authenticatedRedirectGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
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

  const interruptedHarness = providerHarness({
    initialTargetRestored: true,
    failDrainOnce: true,
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
  }

  console.log("PASS  Cloudflare recovery adapter is disposable-only, credential-safe, redirect-safe, and resumable");
} finally {
  try { unlinkSync(join(artifactDirectory, ".brain-recovery-field-gate.lock")); } catch { /* absent */ }
  rmSync(sandbox, { recursive: true, force: true });
}
