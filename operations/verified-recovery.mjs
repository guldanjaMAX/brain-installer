#!/usr/bin/env node
/**
 * Verified recovery contract for a Cloudflare-native Brain.
 *
 * D1 is the durable record and Vectorize is derived. Recovery therefore builds
 * one authenticated encrypted D1 artifact, opens its SQL only for bounded
 * verification or import into a separately identified empty target, rebuilds
 * every vector from D1, and requires health plus
 * release-eval gates before the target can be called usable.
 *
 * `runVerifiedRecovery` remains provider-neutral. The separately reviewed
 * Cloudflare field-gate adapter closes over credentials and private locators;
 * none of those values may enter this plan, state, adapter context, or command
 * output.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFIED_RECOVERY_PLAN_VERSION = 1;
export const VERIFIED_RECOVERY_STATE_VERSION = 1;

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_SINGLE_D1_IMPORT_BYTES = 5 * 1024 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export const VERIFIED_RECOVERY_STAGES = Object.freeze([
  Object.freeze({ id: "export_d1", effect: "local_sensitive_write" }),
  Object.freeze({ id: "verify_export", effect: "read_only" }),
  Object.freeze({ id: "prove_target_clean", effect: "read_only" }),
  Object.freeze({ id: "restore_d1", effect: "isolated_target_write" }),
  Object.freeze({ id: "verify_d1", effect: "read_only" }),
  Object.freeze({ id: "reconcile_security", effect: "isolated_target_write" }),
  Object.freeze({ id: "rebuild_vectorize", effect: "isolated_target_write" }),
  Object.freeze({ id: "verify_health", effect: "read_only" }),
  Object.freeze({ id: "verify_eval", effect: "read_only" }),
]);

const STAGE_IDS = Object.freeze(VERIFIED_RECOVERY_STAGES.map((stage) => stage.id));
const STAGE_SET = new Set(STAGE_IDS);
const PLAN_KEYS = new Set([
  "schema_version", "created_at", "plan_fingerprint",
  "source_manifest_fingerprint", "target_manifest_fingerprint",
  "source_resource_fingerprint", "target_resource_fingerprint",
  "runtime_contract_fingerprint", "artifact", "isolation", "gates", "stages",
]);
const STATE_KEYS = new Set([
  "schema_version", "plan_fingerprint", "status", "current_stage",
  "stage_status", "attempt", "completed", "failure", "created_at", "updated_at",
]);
const COMPLETED_KEYS = new Set(["id", "completed_at", "evidence"]);
const FAILURE_KEYS = new Set(["stage", "code", "at"]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function isoTimestamp(value, label) {
  const text = String(value ?? "");
  const date = new Date(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
      !Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    fail(`${label} must be an exact ISO timestamp`);
  }
  return text;
}

function nowIso(options = {}) {
  const value = options.now instanceof Date
    ? options.now
    : new Date(options.now ?? Date.now());
  return isoTimestamp(value.toISOString(), "recovery clock");
}

function hashValue(value, label) {
  const text = String(value ?? "");
  if (!SHA256_RE.test(text)) fail(`${label} must be a SHA-256 fingerprint`);
  return text;
}

function boundedResource(value, label) {
  const text = String(value ?? "");
  if (!RESOURCE_RE.test(text) || /^REQUIRED|^filled_in|^REPLACE-WITH/i.test(text)) {
    fail(`${label} must name one provisioned resource`);
  }
  return text;
}

function boundedIdentity(value, label) {
  const text = String(value ?? "");
  if (!text || text.length > 1024 || CONTROL_RE.test(text) ||
      /^REQUIRED|^filled_in|^REPLACE-WITH/i.test(text)) {
    fail(`${label} must contain one provisioned identity`);
  }
  return text;
}

function safeDomain(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).toLowerCase();
  if (text.length > 253 || CONTROL_RE.test(text) || text.includes(":") ||
      text.includes("/") || !/^[a-z0-9.-]+$/.test(text)) {
    fail(`${label} is invalid`);
  }
  return text;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Read one manifest through a stable no-follow descriptor without echoing it. */
function readRecoveryManifest(path, label) {
  const target = resolve(path || "");
  let descriptor;
  try {
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 2 || before.size > MAX_MANIFEST_BYTES) {
      fail(`${label} recovery manifest must be one bounded regular file`);
    }
    descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) fail(`${label} recovery manifest changed while opening`);
    const raw = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(target);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      fail(`${label} recovery manifest changed while reading`);
    }
    let manifest;
    try { manifest = JSON.parse(raw.toString("utf8")); } catch {
      fail(`${label} recovery manifest must contain valid JSON`);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      fail(`${label} recovery manifest must contain one object`);
    }
    return Object.freeze({
      manifest,
      fingerprint: sha256(raw),
    });
  } catch (error) {
    if (String(error?.message || "").startsWith(`${label} recovery manifest`)) throw error;
    fail(`${label} recovery manifest could not be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function recoveryResourceContract(manifest, label) {
  if (manifest.manifest_version !== 1) fail(`${label} recovery manifest version is unsupported`);
  const slug = String(manifest.client?.slug ?? "");
  if (!SLUG_RE.test(slug)) fail(`${label} recovery manifest needs a valid client slug`);
  const version = String(manifest.brain?.version ?? "");
  if (!version || version.length > 128 || CONTROL_RE.test(version)) {
    fail(`${label} recovery manifest needs one bounded product version`);
  }
  const cloudflare = manifest.infrastructure?.cloudflare;
  if (!cloudflare || (cloudflare.storage || "d1") !== "d1") {
    fail(`${label} recovery manifest must use Cloudflare D1 storage`);
  }
  const accountId = boundedIdentity(cloudflare.account_id, `${label} account`);
  const databaseId = boundedIdentity(cloudflare.d1_database_id, `${label} D1 database`);
  const databaseName = boundedResource(cloudflare.d1_database_name, `${label} D1 database name`);
  const vectorizeIndex = boundedResource(cloudflare.vectorize_index, `${label} Vectorize index`);
  const workerName = boundedResource(
    manifest.brain?.worker_name || `${slug}-brain`,
    `${label} Worker`,
  );
  const domain = safeDomain(manifest.brain?.domain, `${label} brain domain`);
  const runtime = Object.freeze({
    client_slug: slug,
    product_version: version,
    embedding_model: String(manifest.retrieval?.embed_model || "@cf/baai/bge-base-en-v1.5"),
    embedding_dimensions: Number(manifest.retrieval?.embed_dimensions ?? 768),
  });
  if (!runtime.embedding_model || runtime.embedding_model.length > 256 ||
      CONTROL_RE.test(runtime.embedding_model) || runtime.embedding_dimensions !== 768) {
    fail(`${label} recovery manifest has an incompatible embedding contract`);
  }
  const identity = Object.freeze({
    accountId, databaseId, databaseName, vectorizeIndex, workerName, domain,
  });
  return Object.freeze({
    slug,
    version,
    runtime,
    identity,
    resourceFingerprint: sha256(canonical(identity)),
    runtimeFingerprint: sha256(canonical(runtime)),
  });
}

function assertIsolatedRecoveryTarget(source, target) {
  if (source.slug !== target.slug || source.version !== target.version ||
      source.runtimeFingerprint !== target.runtimeFingerprint) {
    fail("recovery target must use the source brain's exact runtime contract");
  }
  const s = source.identity;
  const t = target.identity;
  if (s.accountId === t.accountId && s.databaseId === t.databaseId) {
    fail("recovery target D1 database must be distinct from the source");
  }
  if (s.accountId === t.accountId && s.databaseName === t.databaseName) {
    fail("recovery target D1 name must be distinct inside the source account");
  }
  if (s.accountId === t.accountId && s.vectorizeIndex === t.vectorizeIndex) {
    fail("recovery target Vectorize index must be distinct from the source");
  }
  if (s.accountId === t.accountId && s.workerName === t.workerName) {
    fail("recovery target Worker must be distinct from the source");
  }
  if (s.domain && t.domain && s.domain === t.domain) {
    fail("recovery target domain must be distinct from the source");
  }
}

function planWithoutFingerprint(plan) {
  const copy = structuredClone(plan);
  delete copy.plan_fingerprint;
  return copy;
}

/** Build a canonical plan containing hashes and policy, never private locators. */
export function buildVerifiedRecoveryPlan(sourceManifestPath, targetManifestPath, options = {}) {
  const sourceLoaded = readRecoveryManifest(sourceManifestPath, "source");
  const targetLoaded = readRecoveryManifest(targetManifestPath, "target");
  const source = recoveryResourceContract(sourceLoaded.manifest, "source");
  const target = recoveryResourceContract(targetLoaded.manifest, "target");
  assertIsolatedRecoveryTarget(source, target);
  const createdAt = nowIso(options);
  const plan = {
    schema_version: VERIFIED_RECOVERY_PLAN_VERSION,
    created_at: createdAt,
    source_manifest_fingerprint: sourceLoaded.fingerprint,
    target_manifest_fingerprint: targetLoaded.fingerprint,
    source_resource_fingerprint: source.resourceFingerprint,
    target_resource_fingerprint: target.resourceFingerprint,
    runtime_contract_fingerprint: source.runtimeFingerprint,
    artifact: {
      format: "financial_brain_recovery_ciphertext_v1",
      relative_name: ".brain-recovery-export.sql.fbrenc",
      digest: "sha256",
      owner_only: true,
      refuse_existing: true,
      max_single_import_bytes: MAX_SINGLE_D1_IMPORT_BYTES,
    },
    isolation: {
      source_and_target_resources_distinct: true,
      required_initial_user_tables: 0,
      required_initial_vectors: 0,
      vector_dimensions: 768,
      vector_metric: "cosine",
    },
    gates: {
      d1_integrity: "ok",
      d1_schema_and_aggregates_match_export: true,
      vectorize_rebuilt_from: "d1",
      vector_backlog: 0,
      vector_count_matches_chunks: true,
      health: "pass",
      eval_profile: "release",
      eval: "pass",
      critical_eval_failures: 0,
      unauthorized_retrievals: 0,
    },
    stages: VERIFIED_RECOVERY_STAGES.map((stage) => ({ ...stage })),
  };
  plan.plan_fingerprint = sha256(canonical(planWithoutFingerprint(plan)));
  return validateVerifiedRecoveryPlan(plan);
}

/**
 * Re-read both manifests once and return the exact ephemeral provider binding.
 *
 * The returned object must remain ephemeral. Recovery helpers never serialize
 * it. It exists so a provider adapter can use the same stable bytes that were
 * checked against the reviewed plan instead of reopening a path after choosing
 * where a credential or write will go.
 */
export function inspectVerifiedRecoveryManifestBindings(
  planInput,
  sourceManifestPath,
  targetManifestPath,
) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  const sourceLoaded = readRecoveryManifest(sourceManifestPath, "source");
  const targetLoaded = readRecoveryManifest(targetManifestPath, "target");
  const source = recoveryResourceContract(sourceLoaded.manifest, "source");
  const target = recoveryResourceContract(targetLoaded.manifest, "target");
  assertIsolatedRecoveryTarget(source, target);
  if (sourceLoaded.fingerprint !== plan.source_manifest_fingerprint ||
      targetLoaded.fingerprint !== plan.target_manifest_fingerprint ||
      source.resourceFingerprint !== plan.source_resource_fingerprint ||
      target.resourceFingerprint !== plan.target_resource_fingerprint ||
      source.runtimeFingerprint !== plan.runtime_contract_fingerprint ||
      target.runtimeFingerprint !== plan.runtime_contract_fingerprint) {
    fail("verified recovery manifest binding changed after plan review");
  }
  const ephemeral = (loaded, contract) => Object.freeze({
    ...contract.identity,
    clientSlug: contract.slug,
    productVersion: contract.version,
    adminKeySecret: loaded.manifest.operations?.admin_key_secret === undefined
      ? null
      : boundedIdentity(
        loaded.manifest.operations.admin_key_secret,
        "recovery admin-key locator",
      ),
    recoveryArtifactKeySecret:
      loaded.manifest.operations?.recovery_artifact_key_secret === undefined
        ? null
        : boundedIdentity(
          loaded.manifest.operations.recovery_artifact_key_secret,
          "recovery artifact-key locator",
        ),
    recoveryFieldGate: loaded.manifest.operations?.recovery_field_gate === undefined
      ? null
      : structuredClone(loaded.manifest.operations.recovery_field_gate),
  });
  return Object.freeze({
    planFingerprint: plan.plan_fingerprint,
    sourceManifestFingerprint: sourceLoaded.fingerprint,
    targetManifestFingerprint: targetLoaded.fingerprint,
    source: ephemeral(sourceLoaded, source),
    target: ephemeral(targetLoaded, target),
  });
}

/** Re-read both manifests and prove they still bind to the reviewed plan. */
export function assertVerifiedRecoveryManifestBindings(
  planInput,
  sourceManifestPath,
  targetManifestPath,
) {
  inspectVerifiedRecoveryManifestBindings(
    planInput,
    sourceManifestPath,
    targetManifestPath,
  );
  return true;
}

/** Validate exact plan shape so unreviewed fields cannot carry instance data. */
export function validateVerifiedRecoveryPlan(input) {
  if (!exactKeys(input, PLAN_KEYS) || input.schema_version !== VERIFIED_RECOVERY_PLAN_VERSION) {
    fail("verified recovery plan shape is invalid");
  }
  isoTimestamp(input.created_at, "verified recovery plan created_at");
  for (const key of [
    "plan_fingerprint", "source_manifest_fingerprint", "target_manifest_fingerprint",
    "source_resource_fingerprint", "target_resource_fingerprint", "runtime_contract_fingerprint",
  ]) hashValue(input[key], `verified recovery plan ${key}`);
  if (!exactKeys(input.artifact, new Set([
    "format", "relative_name", "digest", "owner_only", "refuse_existing",
    "max_single_import_bytes",
  ])) || input.artifact.format !== "financial_brain_recovery_ciphertext_v1" ||
      input.artifact.relative_name !== ".brain-recovery-export.sql.fbrenc" ||
      input.artifact.digest !== "sha256" ||
      input.artifact.owner_only !== true || input.artifact.refuse_existing !== true ||
      input.artifact.max_single_import_bytes !== MAX_SINGLE_D1_IMPORT_BYTES) {
    fail("verified recovery export policy is invalid");
  }
  if (!exactKeys(input.isolation, new Set([
    "source_and_target_resources_distinct", "required_initial_user_tables",
    "required_initial_vectors", "vector_dimensions", "vector_metric",
  ])) || input.isolation.source_and_target_resources_distinct !== true ||
      input.isolation.required_initial_user_tables !== 0 ||
      input.isolation.required_initial_vectors !== 0 ||
      input.isolation.vector_dimensions !== 768 || input.isolation.vector_metric !== "cosine") {
    fail("verified recovery isolation policy is invalid");
  }
  if (!exactKeys(input.gates, new Set([
    "d1_integrity", "d1_schema_and_aggregates_match_export", "vectorize_rebuilt_from",
    "vector_backlog", "vector_count_matches_chunks", "health", "eval_profile", "eval",
    "critical_eval_failures", "unauthorized_retrievals",
  ])) || input.gates.d1_integrity !== "ok" ||
      input.gates.d1_schema_and_aggregates_match_export !== true ||
      input.gates.vectorize_rebuilt_from !== "d1" || input.gates.vector_backlog !== 0 ||
      input.gates.vector_count_matches_chunks !== true || input.gates.health !== "pass" ||
      input.gates.eval_profile !== "release" || input.gates.eval !== "pass" ||
      input.gates.critical_eval_failures !== 0 || input.gates.unauthorized_retrievals !== 0) {
    fail("verified recovery gate policy is invalid");
  }
  if (!Array.isArray(input.stages) ||
      canonical(input.stages) !== canonical(VERIFIED_RECOVERY_STAGES)) {
    fail("verified recovery stages are invalid");
  }
  const expected = sha256(canonical(planWithoutFingerprint(input)));
  if (input.plan_fingerprint !== expected) fail("verified recovery plan fingerprint is invalid");
  return Object.freeze(structuredClone(input));
}

function initialRecoveryState(plan, options = {}) {
  const timestamp = nowIso(options);
  return Object.freeze({
    schema_version: VERIFIED_RECOVERY_STATE_VERSION,
    plan_fingerprint: plan.plan_fingerprint,
    status: "ready",
    current_stage: STAGE_IDS[0],
    stage_status: "pending",
    attempt: 0,
    completed: [],
    failure: null,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function evidenceKeys(stage) {
  const shapes = {
    export_d1: ["artifact_sha256", "artifact_bytes"],
    verify_export: [
      "artifact_sha256", "artifact_bytes", "integrity", "schema_fingerprint",
      "aggregate_fingerprint", "content_fingerprint", "document_count", "chunk_count", "fts_count",
    ],
    prove_target_clean: [
      "target_resource_fingerprint", "user_table_count", "vector_count",
      "vector_dimensions", "vector_metric",
    ],
    restore_d1: ["artifact_sha256", "import_completed"],
    verify_d1: [
      "integrity", "schema_fingerprint", "aggregate_fingerprint",
      "content_fingerprint", "document_count", "chunk_count", "fts_count",
    ],
    reconcile_security: [
      "integrity", "schema_fingerprint", "aggregate_fingerprint",
      "content_fingerprint", "document_count", "chunk_count", "fts_count",
      "bank_protected", "bank_reauthorization_required",
      "bank_legacy_rewrap_required", "bank_unsupported_key_versions",
    ],
    rebuild_vectorize: ["chunk_count", "vector_count", "pending_outbox", "failed_vectors"],
    verify_health: ["status", "failure_count", "vector_backlog"],
    verify_eval: ["profile", "status", "critical_failures", "unauthorized_retrievals"],
  };
  return new Set(shapes[stage] || []);
}

function completedEvidence(completed, stage) {
  return completed.find((entry) => entry.id === stage)?.evidence ?? null;
}

function validateStageEvidence(stage, input, plan, completed) {
  const expected = evidenceKeys(stage);
  if (!expected.size || !exactKeys(input, expected)) fail(`verified recovery ${stage} evidence is invalid`);
  const evidence = structuredClone(input);
  if (stage === "export_d1") {
    hashValue(evidence.artifact_sha256, "recovery export artifact");
    const bytes = positiveInteger(evidence.artifact_bytes, "recovery export artifact bytes");
    if (bytes > plan.artifact.max_single_import_bytes) {
      fail("recovery export exceeds the verified single-import limit");
    }
  } else if (stage === "verify_export") {
    const exported = completedEvidence(completed, "export_d1");
    hashValue(evidence.artifact_sha256, "verified recovery export artifact");
    hashValue(evidence.schema_fingerprint, "verified recovery export schema");
    hashValue(evidence.aggregate_fingerprint, "verified recovery export aggregates");
    hashValue(evidence.content_fingerprint, "verified recovery export durable data");
    positiveInteger(evidence.artifact_bytes, "verified recovery export bytes");
    nonNegativeInteger(evidence.document_count, "verified recovery export document count");
    nonNegativeInteger(evidence.chunk_count, "verified recovery export chunk count");
    nonNegativeInteger(evidence.fts_count, "verified recovery export FTS count");
    if (evidence.integrity !== "ok" || evidence.chunk_count !== evidence.fts_count ||
        evidence.artifact_sha256 !== exported?.artifact_sha256 ||
        evidence.artifact_bytes !== exported?.artifact_bytes) {
      fail("verified recovery export readback did not match its artifact");
    }
  } else if (stage === "prove_target_clean") {
    hashValue(evidence.target_resource_fingerprint, "verified recovery target resource");
    nonNegativeInteger(evidence.user_table_count, "recovery target user-table count");
    nonNegativeInteger(evidence.vector_count, "recovery target vector count");
    if (evidence.target_resource_fingerprint !== plan.target_resource_fingerprint ||
        evidence.user_table_count !== plan.isolation.required_initial_user_tables ||
        evidence.vector_count !== plan.isolation.required_initial_vectors ||
        evidence.vector_dimensions !== plan.isolation.vector_dimensions ||
        evidence.vector_metric !== plan.isolation.vector_metric) {
      fail("recovery target is not the reviewed clean isolated target");
    }
  } else if (stage === "restore_d1") {
    const exported = completedEvidence(completed, "export_d1");
    hashValue(evidence.artifact_sha256, "restored recovery artifact");
    if (evidence.import_completed !== true || evidence.artifact_sha256 !== exported?.artifact_sha256) {
      fail("recovery target did not confirm the reviewed export import");
    }
  } else if (stage === "verify_d1") {
    const exported = completedEvidence(completed, "verify_export");
    hashValue(evidence.schema_fingerprint, "restored D1 schema");
    hashValue(evidence.aggregate_fingerprint, "restored D1 aggregates");
    hashValue(evidence.content_fingerprint, "restored D1 durable data");
    nonNegativeInteger(evidence.document_count, "restored D1 document count");
    nonNegativeInteger(evidence.chunk_count, "restored D1 chunk count");
    nonNegativeInteger(evidence.fts_count, "restored D1 FTS count");
    if (evidence.integrity !== "ok" || evidence.chunk_count !== evidence.fts_count ||
        evidence.schema_fingerprint !== exported?.schema_fingerprint ||
        evidence.aggregate_fingerprint !== exported?.aggregate_fingerprint ||
        evidence.content_fingerprint !== exported?.content_fingerprint ||
        evidence.document_count !== exported?.document_count ||
        evidence.chunk_count !== exported?.chunk_count || evidence.fts_count !== exported?.fts_count) {
      fail("restored D1 did not match the verified export");
    }
  } else if (stage === "rebuild_vectorize") {
    const restored = completedEvidence(completed, "reconcile_security");
    nonNegativeInteger(evidence.chunk_count, "recovery vector chunk count");
    nonNegativeInteger(evidence.vector_count, "recovery vector count");
    nonNegativeInteger(evidence.pending_outbox, "recovery vector backlog");
    nonNegativeInteger(evidence.failed_vectors, "recovery failed vector count");
    if (evidence.chunk_count !== restored?.chunk_count ||
        evidence.vector_count !== evidence.chunk_count || evidence.pending_outbox !== 0 ||
        evidence.failed_vectors !== 0) {
      fail("Vectorize rebuild did not converge exactly from restored D1 chunks");
    }
  } else if (stage === "reconcile_security") {
    const restored = completedEvidence(completed, "verify_d1");
    hashValue(evidence.schema_fingerprint, "reconciled D1 schema");
    hashValue(evidence.aggregate_fingerprint, "reconciled D1 aggregates");
    hashValue(evidence.content_fingerprint, "reconciled D1 durable data");
    nonNegativeInteger(evidence.document_count, "reconciled D1 document count");
    nonNegativeInteger(evidence.chunk_count, "reconciled D1 chunk count");
    nonNegativeInteger(evidence.fts_count, "reconciled D1 FTS count");
    nonNegativeInteger(evidence.bank_protected, "reconciled protected bank references");
    nonNegativeInteger(
      evidence.bank_reauthorization_required,
      "reconciled bank reauthorization count",
    );
    nonNegativeInteger(
      evidence.bank_legacy_rewrap_required,
      "remaining legacy bank references",
    );
    nonNegativeInteger(
      evidence.bank_unsupported_key_versions,
      "unsupported bank wrapping-key versions",
    );
    if (evidence.integrity !== "ok" || evidence.chunk_count !== evidence.fts_count ||
        evidence.schema_fingerprint !== restored?.schema_fingerprint ||
        evidence.aggregate_fingerprint !== restored?.aggregate_fingerprint ||
        evidence.document_count !== restored?.document_count ||
        evidence.chunk_count !== restored?.chunk_count ||
        evidence.fts_count !== restored?.fts_count ||
        evidence.bank_legacy_rewrap_required !== 0 ||
        evidence.bank_unsupported_key_versions !== 0) {
      fail("recovered security state did not reconcile exactly");
    }
  } else if (stage === "verify_health") {
    nonNegativeInteger(evidence.failure_count, "recovery health failure count");
    nonNegativeInteger(evidence.vector_backlog, "recovery health vector backlog");
    if (evidence.status !== "pass" || evidence.failure_count !== 0 || evidence.vector_backlog !== 0) {
      fail("post-recovery health gate did not pass");
    }
  } else if (stage === "verify_eval") {
    nonNegativeInteger(evidence.critical_failures, "recovery critical eval failures");
    nonNegativeInteger(evidence.unauthorized_retrievals, "recovery unauthorized retrievals");
    if (evidence.profile !== plan.gates.eval_profile || evidence.status !== "pass" ||
        evidence.critical_failures !== 0 || evidence.unauthorized_retrievals !== 0) {
      fail("post-recovery evaluation gate did not pass");
    }
  }
  return Object.freeze(evidence);
}

/** Validate state as a strict prefix of the reviewed stage sequence. */
export function validateVerifiedRecoveryState(input, planInput) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  if (!exactKeys(input, STATE_KEYS) || input.schema_version !== VERIFIED_RECOVERY_STATE_VERSION ||
      input.plan_fingerprint !== plan.plan_fingerprint || !Array.isArray(input.completed)) {
    fail("verified recovery state shape or plan binding is invalid");
  }
  isoTimestamp(input.created_at, "verified recovery state created_at");
  isoTimestamp(input.updated_at, "verified recovery state updated_at");
  const completed = [];
  for (let index = 0; index < input.completed.length; index++) {
    const entry = input.completed[index];
    if (!exactKeys(entry, COMPLETED_KEYS) || entry.id !== STAGE_IDS[index]) {
      fail("verified recovery completed stages are not an exact prefix");
    }
    const completedAt = isoTimestamp(entry.completed_at, "verified recovery completion time");
    const evidence = validateStageEvidence(entry.id, entry.evidence, plan, completed);
    completed.push(Object.freeze({ id: entry.id, completed_at: completedAt, evidence }));
  }
  const next = STAGE_IDS[completed.length] ?? null;
  const status = String(input.status ?? "");
  const stageStatus = input.stage_status;
  const attempt = nonNegativeInteger(input.attempt, "verified recovery attempt");
  if (next === null) {
    if (status !== "complete" || input.current_stage !== null || stageStatus !== null ||
        attempt !== 0 || input.failure !== null) {
      fail("verified recovery completed state is inconsistent");
    }
  } else {
    if (input.current_stage !== next || !new Set(["ready", "running", "failed"]).has(status) ||
        !new Set(["pending", "running", "failed"]).has(stageStatus)) {
      fail("verified recovery current stage is inconsistent");
    }
    if (status === "ready" && (completed.length !== 0 || stageStatus !== "pending" || attempt !== 0)) {
      fail("verified recovery ready state is inconsistent");
    }
    if (status === "running" && !new Set(["pending", "running"]).has(stageStatus)) {
      fail("verified recovery running state is inconsistent");
    }
    if (status === "failed" && stageStatus !== "failed") {
      fail("verified recovery failed state is inconsistent");
    }
    if (status !== "failed" && input.failure !== null) {
      fail("verified recovery nonfailed state contains a failure record");
    }
    if (status === "failed") {
      if (!exactKeys(input.failure, FAILURE_KEYS) || input.failure.stage !== next ||
          input.failure.code !== `RECOVERY_${next.toUpperCase()}_FAILED`) {
        fail("verified recovery failure record is invalid");
      }
      isoTimestamp(input.failure.at, "verified recovery failure time");
    }
  }
  return Object.freeze({
    ...structuredClone(input),
    completed: Object.freeze(completed),
  });
}

function markStageRunning(state, options = {}) {
  const timestamp = nowIso(options);
  return Object.freeze({
    ...structuredClone(state),
    status: "running",
    stage_status: "running",
    attempt: state.attempt + 1,
    failure: null,
    updated_at: timestamp,
  });
}

function markStageFailed(state, options = {}) {
  const timestamp = nowIso(options);
  return Object.freeze({
    ...structuredClone(state),
    status: "failed",
    stage_status: "failed",
    failure: {
      stage: state.current_stage,
      code: `RECOVERY_${state.current_stage.toUpperCase()}_FAILED`,
      at: timestamp,
    },
    updated_at: timestamp,
  });
}

function markStageComplete(state, evidence, plan, options = {}) {
  const timestamp = nowIso(options);
  const checked = validateStageEvidence(state.current_stage, evidence, plan, state.completed);
  const completed = [
    ...state.completed.map((entry) => structuredClone(entry)),
    { id: state.current_stage, completed_at: timestamp, evidence: structuredClone(checked) },
  ];
  const next = STAGE_IDS[completed.length] ?? null;
  return validateVerifiedRecoveryState({
    ...structuredClone(state),
    status: next ? "running" : "complete",
    current_stage: next,
    stage_status: next ? "pending" : null,
    attempt: 0,
    completed,
    failure: null,
    updated_at: timestamp,
  }, plan);
}

/**
 * Execute or resume the exact state machine with injected provider adapters.
 *
 * Each stage is persisted as running before its adapter is called. A crash can
 * therefore only resume the same stage. Mutating adapters must reconcile an
 * already-completed external action and return the same bounded evidence; they
 * must never assume that a missing local completion receipt means no write ran.
 */
export async function runVerifiedRecovery(planInput, stateInput, adapters, options = {}) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  let state = validateVerifiedRecoveryState(stateInput, plan);
  if (state.status === "complete") return Object.freeze({ ok: true, state });
  const pendingStages = STAGE_IDS.slice(state.completed.length);
  if (!adapters || pendingStages.some((stage) => typeof adapters[stage] !== "function")) {
    fail("verified recovery needs one adapter for every remaining stage");
  }
  if (typeof options.revalidateManifests !== "function") {
    fail("verified recovery needs manifest revalidation for every remaining stage");
  }
  if (options.afterStageCheckpoint !== undefined &&
      typeof options.afterStageCheckpoint !== "function") {
    fail("verified recovery after-stage checkpoint hook must be a function");
  }
  if (options.afterStageCheckpoint && typeof options.persistState !== "function") {
    fail("verified recovery after-stage checkpoint hook requires durable state persistence");
  }
  const persist = options.persistState ?? (async () => {});
  const afterStageCheckpoint = options.afterStageCheckpoint ?? null;
  const clock = options.clock ?? (() => new Date());
  while (state.current_stage) {
    const stage = state.current_stage;
    state = validateVerifiedRecoveryState(markStageRunning(state, { now: clock() }), plan);
    await persist(state);
    let evidence;
    try {
      await options.revalidateManifests(plan.plan_fingerprint);
      evidence = await adapters[stage](Object.freeze({
        stage,
        attempt: state.attempt,
        planFingerprint: plan.plan_fingerprint,
        targetResourceFingerprint: plan.target_resource_fingerprint,
        completed: Object.freeze(state.completed.map((entry) => Object.freeze({
          id: entry.id,
          evidence: Object.freeze(structuredClone(entry.evidence)),
        }))),
      }));
      await options.revalidateManifests(plan.plan_fingerprint);
      state = markStageComplete(state, evidence, plan, { now: clock() });
      await persist(state);
    } catch {
      state = validateVerifiedRecoveryState(markStageFailed(state, { now: clock() }), plan);
      await persist(state);
      return Object.freeze({
        ok: false,
        errorCode: state.failure.code,
        state,
      });
    }
    // This hook is deliberately outside the adapter failure boundary. The
    // completed-stage state has already been durably persisted, so a supervised
    // drill can stop here without falsely marking the next untouched stage as
    // failed. Re-running from that checkpoint never repeats `stage`.
    if (afterStageCheckpoint) await afterStageCheckpoint(stage);
  }
  return Object.freeze({ ok: true, state });
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwner(info, label) {
  const uid = currentUid();
  if (uid !== null && info.uid !== uid) fail(`${label} is not owned by the current user`);
}

function ensureControlDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("verified recovery control directory is unsafe");
  assertOwner(info, "verified recovery control directory");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    fail("verified recovery control directory is not owner-only");
  }
}

function assertControlDestination(path, { replace }) {
  if (!existsSync(path)) return null;
  if (!replace) fail("verified recovery control file already exists");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.size < 2 || info.size > MAX_CONTROL_FILE_BYTES) {
    fail("verified recovery control destination is unsafe");
  }
  assertOwner(info, "verified recovery control destination");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    fail("verified recovery control destination is not owner-only");
  }
  return info;
}

function syncParent(path) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writePrivateControl(path, value, { replace = false, random = randomBytes } = {}) {
  const absolute = resolve(path || "");
  ensureControlDirectory(dirname(absolute));
  const prior = assertControlDestination(absolute, { replace });
  const bytes = Buffer.from(`${canonical(value)}\n`, "utf8");
  if (bytes.length > MAX_CONTROL_FILE_BYTES) fail("verified recovery control file is too large");
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${random(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    if (prior) {
      let current;
      try { current = lstatSync(absolute); } catch {
        fail("verified recovery control destination changed before replacement");
      }
      if (!sameFile(prior, current)) {
        fail("verified recovery control destination changed before replacement");
      }
      renameSync(temporary, absolute);
    } else {
      // A check-then-rename would overwrite a file created in the gap. Linking
      // the private staging inode into the final name gives first creation true
      // O_EXCL behavior on every supported local filesystem.
      try { linkSync(temporary, absolute); } catch {
        fail("verified recovery control destination appeared before creation");
      }
      unlinkSync(temporary);
    }
    syncParent(absolute);
    const readback = readFileSync(absolute);
    if (!readback.equals(bytes)) fail("verified recovery control file did not read back exactly");
    const info = statSync(absolute);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      fail("verified recovery control file is not owner-only");
    }
    return Object.freeze({ path: absolute, info });
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
    if (String(error?.message || "").startsWith("verified recovery")) throw error;
    fail("verified recovery control file could not be written safely");
  } finally {
    bytes.fill(0);
  }
}

function loadPrivateControl(path, label) {
  const absolute = resolve(path || "");
  let descriptor;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.size < 2 || before.size > MAX_CONTROL_FILE_BYTES) {
      fail(`${label} must be one bounded regular file`);
    }
    assertOwner(before, label);
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      fail(`${label} must be owner-only mode 0600`);
    }
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) fail(`${label} changed while opening`);
    const raw = readFileSync(descriptor, "utf8");
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      fail(`${label} changed while reading`);
    }
    try { return JSON.parse(raw); } catch { fail(`${label} must contain valid JSON`); }
  } catch (error) {
    if (String(error?.message || "").startsWith(label)) throw error;
    fail(`${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeVerifiedRecoveryPlan(path, planInput, options = {}) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  return writePrivateControl(path, plan, { ...options, replace: false });
}

export function writeVerifiedRecoveryState(path, stateInput, planInput, options = {}) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  const state = validateVerifiedRecoveryState(stateInput, plan);
  return writePrivateControl(path, state, { ...options, replace: existsSync(resolve(path)) });
}

export function loadVerifiedRecoveryPlan(path) {
  return validateVerifiedRecoveryPlan(loadPrivateControl(path, "verified recovery plan"));
}

export function loadVerifiedRecoveryState(path, planInput) {
  return validateVerifiedRecoveryState(
    loadPrivateControl(path, "verified recovery state"),
    planInput,
  );
}

function removeIfSame(path, identity) {
  try {
    const current = lstatSync(path);
    if (current.dev === identity.dev && current.ino === identity.ino && current.nlink === 1) {
      unlinkSync(path);
      syncParent(path);
      return true;
    }
  } catch { /* absent or changed */ }
  return false;
}

/** Create both owner-only control files, rolling back a partial initialization. */
export function initializeVerifiedRecovery(
  sourceManifestPath,
  targetManifestPath,
  planPath,
  statePath,
  options = {},
) {
  const absolutePlan = resolve(planPath || "");
  const absoluteState = resolve(statePath || "");
  if (absolutePlan === absoluteState) fail("verified recovery plan and state must use different files");
  const plan = buildVerifiedRecoveryPlan(sourceManifestPath, targetManifestPath, options);
  const state = initialRecoveryState(plan, options);
  let writtenPlan;
  try {
    writtenPlan = writeVerifiedRecoveryPlan(absolutePlan, plan, options);
    writePrivateControl(absoluteState, state, { ...options, replace: false });
  } catch (error) {
    if (writtenPlan) removeIfSame(absolutePlan, writtenPlan.info);
    throw error;
  }
  return Object.freeze({ plan, state });
}

export function verifiedRecoveryStatus(planInput, stateInput) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  const state = validateVerifiedRecoveryState(stateInput, plan);
  return Object.freeze({
    plan_fingerprint: plan.plan_fingerprint,
    status: state.status,
    current_stage: state.current_stage,
    stage_status: state.stage_status,
    attempt: state.attempt,
    completed_stages: state.completed.length,
    total_stages: STAGE_IDS.length,
    failure_code: state.failure?.code ?? null,
  });
}

export function parseVerifiedRecoveryCliArguments(argv) {
  if (!Array.isArray(argv)) fail("verified recovery arguments are invalid");
  const [command, ...args] = argv;
  if (command === "init" && args.length === 4 && args.every((value) =>
    typeof value === "string" && value && !value.startsWith("--"))) {
    return Object.freeze({
      command,
      sourceManifestPath: args[0],
      targetManifestPath: args[1],
      planPath: args[2],
      statePath: args[3],
    });
  }
  if (command === "status" && args.length === 2 && args.every((value) =>
    typeof value === "string" && value && !value.startsWith("--"))) {
    return Object.freeze({ command, planPath: args[0], statePath: args[1] });
  }
  fail("verified recovery arguments are invalid");
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseVerifiedRecoveryCliArguments(argv); } catch {
    console.log("usage: node operations/verified-recovery.mjs init <source-manifest> <target-manifest> <private-plan> <private-state>");
    console.log("       node operations/verified-recovery.mjs status <private-plan> <private-state>");
    return 1;
  }
  try {
    if (parsed.command === "init") {
      const result = initializeVerifiedRecovery(
        parsed.sourceManifestPath,
        parsed.targetManifestPath,
        parsed.planPath,
        parsed.statePath,
      );
      console.log(JSON.stringify(verifiedRecoveryStatus(result.plan, result.state), null, 2));
      return 0;
    }
    const plan = loadVerifiedRecoveryPlan(parsed.planPath);
    const state = loadVerifiedRecoveryState(parsed.statePath, plan);
    console.log(JSON.stringify(verifiedRecoveryStatus(plan, state), null, 2));
    return 0;
  } catch (error) {
    console.error(`Verified recovery stopped: ${String(error?.message || "unknown safety failure")}`);
    return 1;
  }
}

const IS_MAIN = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Verified recovery stopped: internal safety failure");
    process.exitCode = 1;
  });
}
