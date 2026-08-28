#!/usr/bin/env node
/**
 * Supervised live adapter for the disposable Cloudflare recovery field gate.
 *
 * This file can export the reviewed source D1 database and write only to an
 * already-provisioned target whose D1, Vectorize, Worker, and hostname all carry
 * one explicit recovery-gate nonce. It cannot create, upload, route, or destroy
 * a resource. Its only deployment mutation promotes one separately reviewed,
 * immutable active version after a paused version has completed the exact
 * Vectorize rebuild. Cloudflare control-plane credentials stay inside an
 * owner-only wrapper such as a macOS Keychain-backed Wrangler launcher. The
 * Brain admin key is read from the target manifest's exact Keychain locator and
 * is used only in request headers or evaluator stdin.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { localToolEnvironment } from "../doctor.mjs";
import { evaluateProfileCoverage } from "../eval/profile.mjs";
import { validateGolden } from "../eval/golden-validation.mjs";
import {
  keychainChildEnvironment,
  parseAdminKeySecretReference,
  readAdminKeyFromKeychain,
} from "./admin-key-persistence.mjs";
import {
  VERIFIED_RECOVERY_STAGES,
  inspectVerifiedRecoveryManifestBindings,
  loadVerifiedRecoveryPlan,
  loadVerifiedRecoveryState,
  runVerifiedRecovery,
  verifiedRecoveryStatus,
  writeVerifiedRecoveryState,
} from "./verified-recovery.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MIGRATIONS_DIRECTORY = join(ROOT, "migrations", "d1");
const EVAL_RUNNER = join(ROOT, "eval", "run.mjs");

const MAX_WRAPPER_BYTES = 1024 * 1024;
const MAX_GOLDEN_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SQLITE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_WRANGLER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVAL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BOOTSTRAP_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_BOOTSTRAP_ROUNDS = 20_000;
const BOOTSTRAP_POLL_MS = 3_000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DISPOSABLE_WORKER_RE = /(?:^|-)recovery-gate-([a-z0-9]{8,24})$/;
const WORKER_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,127}$/;

/**
 * Checkpoint boundaries available to a supervised live drill. Read-only stages
 * are intentionally absent: stopping there adds no recovery evidence, while
 * accepting arbitrary names would make an operator think a drill ran when it
 * did not.
 */
export const RECOVERY_FIELD_GATE_STOP_STAGES = Object.freeze(
  VERIFIED_RECOVERY_STAGES
    .filter((stage) => stage.effect !== "read_only")
    .map((stage) => stage.id),
);
const RECOVERY_FIELD_GATE_STOP_STAGE_SET = new Set(RECOVERY_FIELD_GATE_STOP_STAGES);

/**
 * D1 full export currently refuses FTS5 virtual tables. These are the durable
 * application tables expected in the schema. The checked-in, already-applied
 * migrations recreate that schema and the derived chunks_fts index. A future
 * migration that adds a table must update this reviewed list or the adapter
 * stops before exporting anything.
 */
export const RECOVERY_DURABLE_TABLES = Object.freeze([
  "install_state",
  "schema_migrations",
  "upgrade_runs",
  "llm_call_log",
  "sources",
  "source_events",
  "documents",
  "chunks",
  "vector_outbox",
  "vector_bootstrap_batches",
  "corpus_stats",
  "sync_runs",
  // Schema 14: the owner's enrolled passkeys are durable (losing them on a
  // recovery would lock every device out until a new invite); challenges and
  // enrollment codes are single-use fifteen-minute security state and are
  // deliberately NOT exported below.
  "owner_passkeys",
  "auth_challenges",
  "enrollment_codes",
  // Schema 15: the structured financial ledger. Every one of these is durable
  // and every one is exported. A recovered brain that came back with its
  // documents and without its ledger would answer a question about money from
  // prose alone, silently, which is the exact failure the ledger exists to end.
  "fin_entities",
  "fin_accounts",
  "fin_account_coverage",
  "fin_documents",
  "fin_statements",
  "fin_transactions",
  "fin_balance_snapshots",
  "fin_obligations",
  "fin_deadlines",
  "fin_exceptions",
  "fin_open_items",
  "fin_reconciliations",
  "fin_reconciliation_claims",
  // Schema 16: hosted bank-feed connector state. `bank_feed_items` holds the
  // ENCRYPTED read-only access reference, and a recovered brain that came back
  // without it would look connected and silently read nothing further. The
  // backfill queue comes with it so an interrupted history load resumes rather
  // than restarting from scratch. Link sessions are single-use, minutes-long
  // handoff state and are deliberately NOT exported below, exactly like
  // auth_challenges.
  "bank_feed_items",
  "bank_feed_backfill",
  "bank_feed_link_sessions",
]);

/**
 * The Vectorize queue is derived recovery state. It must be empty on the
 * source snapshot and is intentionally recreated empty before the target is
 * reindexed. Excluding it from the byte fingerprint also makes an interrupted
 * reindex safely resumable without weakening the documents/chunks proof.
 */
export const RECOVERY_EXPORT_TABLES = Object.freeze(
  RECOVERY_DURABLE_TABLES.filter((table) =>
    table !== "vector_outbox" && table !== "vector_bootstrap_batches" &&
      table !== "install_state" &&
      // Live single-use auth material never enters a resumable artifact: a
      // recovered brain re-issues challenges and invites from scratch, and an
      // abandoned bank-authorisation session is the same kind of thing.
      table !== "auth_challenges" && table !== "enrollment_codes" &&
      table !== "bank_feed_link_sessions"),
);

const SAFE_WRANGLER_PREFIXES = Object.freeze([
  ["--version"],
  ["d1", "list"],
  ["d1", "execute"],
  ["d1", "export"],
  ["vectorize", "list"],
  ["vectorize", "info"],
  ["deployments", "status"],
  ["versions", "view"],
]);
const WRANGLER_FAIL_CLOSED_FLAGS = Object.freeze([
  "--experimental-provision=false",
  "--experimental-auto-create=false",
]);

const TABLE_INVENTORY_SQL =
  "SELECT name FROM sqlite_schema " +
  "WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' " +
  "AND name <> 'chunks_fts' AND name NOT LIKE 'chunks_fts_%' ORDER BY name";
const USER_TABLE_COUNT_SQL =
  "SELECT COUNT(*) AS user_table_count FROM sqlite_schema " +
  "WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'";
const MIGRATION_CONTRACT_SQL =
  "SELECT version,name,checksum FROM schema_migrations ORDER BY version";
const LOGICAL_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema " +
  "WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' " +
  "AND name NOT LIKE 'chunks_fts_%' ORDER BY type,name,tbl_name";
const QUICK_CHECK_SQL = "PRAGMA quick_check";
const FTS_INTEGRITY_SQL =
  "INSERT INTO chunks_fts(chunks_fts,rank) VALUES('integrity-check',1)";
const OUTBOX_SQL =
  "SELECT COUNT(*) AS pending_outbox, " +
  "COALESCE(SUM(CASE WHEN attempts > 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS failed_vectors " +
  "FROM vector_outbox";
const INSTALL_STATE_BASE_COLUMNS = Object.freeze([
  "id", "client_slug", "product_version", "schema_version", "gate_version",
  "installed_at", "last_upgraded_at", "ring", "notes",
]);
const INSTALL_STATE_LEASE_COLUMNS = Object.freeze([
  "vector_drain_lease_owner", "vector_drain_lease_expires_at",
]);
const INSTALL_STATE_PROJECTION_COLUMNS = Object.freeze([
  "vector_projection_mutation_id", "vector_projection_submitted_at",
  "vector_projection_status", "vector_projection_bootstrap_epoch",
  "vector_projection_bootstrap_cursor", "vector_projection_bootstrap_high_water",
]);
const INSTALL_STATE_BOOTSTRAP_V2_COLUMNS = Object.freeze([
  "vector_projection_bootstrap_protocol", "vector_projection_bootstrap_base_count",
]);
// Chunk-refit progress. Preserved rather than normalised: it records how far a
// scan of the CHUNK TEXT has got, and the chunk text is exactly what a recovery
// carries over. Resetting it would make a recovered brain re-walk a corpus it
// has already repaired, at the client's expense.
const INSTALL_STATE_REFIT_COLUMNS = Object.freeze([
  "chunk_refit_cursor", "chunk_refit_started_at", "chunk_refit_completed_at",
  "chunk_refit_documents", "chunk_refit_chunks_added",
]);
const INSTALL_STATE_NULL_NORMALIZED_COLUMNS = Object.freeze([
  ...INSTALL_STATE_LEASE_COLUMNS,
  "vector_projection_mutation_id", "vector_projection_submitted_at",
  "vector_projection_bootstrap_cursor",
  "vector_projection_bootstrap_protocol",
]);
const INSTALL_STATE_ZERO_NORMALIZED_COLUMNS = Object.freeze([
  // Queue generations belong to the target's derived Vectorize projection.
  // A resumable bootstrap advances this counter as it creates outbox rows,
  // even though no document or chunk content changed. Reset it alongside the
  // queue itself so corpus fingerprints remain stable across safe retries.
  "outbox_generation",
  "vector_projection_bootstrap_base_count",
  // Owner session state is live coordination, not corpus. A recovered brain
  // restarts at the default generation (zero reads as 1), so session cookies
  // validate only against the recovered value — never resurrected exactly.
  // Owners re-sign-in with their passkey; that is a tap, not a loss.
  "session_generation",
]);
// Schema 15 added the additive financial-ledger tables and 17 added the chunk
// token-fit columns. As with schema 14's owner-passkey tables, the vector
// protocol itself is unchanged, but the recovery contract tracks the EXACT
// current schema by design: a drill against a database one migration behind
// would export a column set that does not match the reviewed list, and refusing
// is the whole point of pinning it.
const RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION = 17;

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw recoveryError("RECOVERY_SCHEMA_CONTRACT_INVALID");
  }
  return `"${value}"`;
}

// Schema 15: the structured financial ledger, added as one additive migration.
// Listed once and consumed twice, by the aggregate projection and by the
// expected-table gate, so the two cannot drift apart.
const SCHEMA_15_TABLES = Object.freeze([
  "fin_entities",
  "fin_accounts",
  "fin_account_coverage",
  "fin_documents",
  "fin_statements",
  "fin_transactions",
  "fin_balance_snapshots",
  "fin_obligations",
  "fin_deadlines",
  "fin_exceptions",
  "fin_open_items",
  "fin_reconciliations",
  "fin_reconciliation_claims",
]);

// Schema 16: the hosted bank-feed connector's own tables, listed for the same
// two reasons and consumed the same two ways.
const SCHEMA_16_TABLES = Object.freeze([
  "bank_feed_items",
  "bank_feed_backfill",
  "bank_feed_link_sessions",
]);

const AGGREGATE_FIELDS = Object.freeze([
  ...RECOVERY_DURABLE_TABLES.map((table) => [
    table,
    // Literal zeros keep older migration prefixes queryable without
    // referencing tables they do not have. Passkey restoration correctness is
    // proven by the export content itself, not by the corpus aggregate.
    // Literal zeros also cover the schema-15 ledger tables, for the same reason
    // the passkey tables take one: this aggregate is queried against databases
    // at several migration prefixes, and a COUNT against a table a prefix does
    // not have fails the whole snapshot. Ledger restoration correctness is
    // proven by the exported content, which these tables are fully part of.
    ["vector_bootstrap_batches", "owner_passkeys", "auth_challenges", "enrollment_codes",
     ...SCHEMA_15_TABLES, ...SCHEMA_16_TABLES].includes(table)
      ? "SELECT 0"
      : `SELECT COUNT(*) FROM ${quoteIdentifier(table)}`,
  ]),
  ["chunks_fts", "SELECT COUNT(*) FROM chunks_fts"],
  ["documents_ingested_max", "SELECT COALESCE(MAX(ingested_at),0) FROM documents"],
  ["documents_text_bytes", "SELECT COALESCE(SUM(length(COALESCE(title,''))+length(COALESCE(uri,''))+length(COALESCE(meta,''))+length(content_hash)),0) FROM documents"],
  ["chunks_id_max", "SELECT COALESCE(MAX(id),0) FROM chunks"],
  ["chunks_text_bytes", "SELECT COALESCE(SUM(length(text)+length(chunk_uid)),0) FROM chunks"],
  // Drain leases and Vectorize mutation fences belong to one live derived
  // index, not the durable corpus. Snapshot comparison always observes their
  // normalized recovery value. Literals also keep older migration prefixes
  // queryable without referencing columns they do not have.
  ["vector_drain_lease_owner_present", "SELECT 0"],
  ["vector_drain_lease_expiry_present", "SELECT 0"],
  ["vector_projection_mutation_present", "SELECT 0"],
  ["vector_projection_submission_present", "SELECT 0"],
]);

const AGGREGATE_SQL = `SELECT ${AGGREGATE_FIELDS.map(
  ([name, query]) => `CAST((${query}) AS TEXT) AS ${quoteIdentifier(name)}`,
).join(",")}`;

export class CloudflareRecoveryAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "CloudflareRecoveryAdapterError";
    this.code = code;
  }
}

function recoveryError(code) {
  return new CloudflareRecoveryAdapterError(code);
}

function refuse(code) {
  throw recoveryError(code);
}

function normalizeStopAfterStage(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !RECOVERY_FIELD_GATE_STOP_STAGE_SET.has(value)) {
    refuse("RECOVERY_FIELD_GATE_STOP_STAGE_INVALID");
  }
  return value;
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

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(info, code) {
  const uid = currentUid();
  if (uid !== null && info.uid !== uid) refuse(code);
}

function assertOwnerOnly(info, code) {
  assertOwned(info, code);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) refuse(code);
}

function assertPrivateDirectory(path, code = "RECOVERY_PRIVATE_DIRECTORY_UNSAFE") {
  const absolute = resolve(path || "");
  let info;
  try { info = lstatSync(absolute); } catch { refuse(code); }
  if (!info.isDirectory() || info.isSymbolicLink()) refuse(code);
  assertOwnerOnly(info, code);
  let canonicalPath;
  try { canonicalPath = realpathSync(absolute); } catch { refuse(code); }
  // macOS exposes /var through the fixed /private/var system alias. The final
  // component itself was already proven not to be a link; use its canonical
  // locator from here onward so every child and artifact comparison is exact.
  return Object.freeze({ path: canonicalPath, info: statSync(canonicalPath) });
}

function readStablePrivateFile(path, {
  code,
  maxBytes,
  executable = false,
  allowEmpty = false,
} = {}) {
  const absolute = resolve(path || "");
  let descriptor;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (!allowEmpty && before.size < 1) || before.size > maxBytes) refuse(code);
    assertOwnerOnly(before, code);
    if (executable && process.platform !== "win32" && (before.mode & 0o100) === 0) refuse(code);
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse(code);
    const raw = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) refuse(code);
    return Object.freeze({ path: absolute, raw, hash: sha256(raw), info: opened });
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertArtifactFile(path, { maxBytes, allowEmpty = false } = {}) {
  const absolute = resolve(path || "");
  let info;
  try { info = lstatSync(absolute); } catch { refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (!allowEmpty && info.size < 1) || info.size > maxBytes) {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  assertOwned(info, "RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  return Object.freeze({ path: absolute, info });
}

function hashStableArtifact(path, maxBytes) {
  const checked = assertArtifactFile(path, { maxBytes });
  let descriptor;
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    const hasher = createHash("sha256");
    const block = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, block, 0, block.length, null);
      if (!read) break;
      hasher.update(block.subarray(0, read));
      bytes += read;
      if (bytes > maxBytes) refuse("RECOVERY_EXPORT_ARTIFACT_TOO_LARGE");
    }
    block.fill(0);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath) || bytes !== opened.size) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    return Object.freeze({ artifact_sha256: hasher.digest("hex"), artifact_bytes: bytes });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Hash a canonical normalized prefix followed by one stable Wrangler export. */
function hashNormalizedDataExport(prefix, path, maxBytes) {
  if (!Buffer.isBuffer(prefix)) refuse("RECOVERY_EXPORT_ASSEMBLY_FAILED");
  const checked = assertArtifactFile(path, { maxBytes, allowEmpty: true });
  if (prefix.length + checked.info.size > maxBytes) refuse("RECOVERY_EXPORT_ARTIFACT_TOO_LARGE");
  let descriptor;
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    const hasher = createHash("sha256").update(prefix);
    const block = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(descriptor, block, 0, block.length, null);
      if (!read) break;
      hasher.update(block.subarray(0, read));
    }
    block.fill(0);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    return hasher.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function recoveryArtifactDataFingerprint(path, maxBytes) {
  const checked = assertArtifactFile(path, { maxBytes });
  let descriptor;
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    const header = Buffer.alloc(512);
    const count = readSync(descriptor, header, 0, header.length, 0);
    const match = header.subarray(0, count).toString("utf8").match(
      /^-- Financial Brain verified recovery artifact\.\n-- Durable-data-sha256: ([0-9a-f]{64})\n/,
    );
    header.fill(0);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    if (!match) refuse("RECOVERY_EXPORT_ARTIFACT_INVALID");
    return match[1];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertDisposableTarget(binding) {
  const workerMatch = String(binding.workerName || "").match(DISPOSABLE_WORKER_RE);
  if (!workerMatch) refuse("RECOVERY_TARGET_NOT_DISPOSABLE");
  const suffix = `recovery-gate-${workerMatch[1]}`;
  const names = [binding.databaseName, binding.vectorizeIndex];
  if (names.some((name) => !(String(name) === suffix || String(name).endsWith(`-${suffix}`)))) {
    refuse("RECOVERY_TARGET_NOT_DISPOSABLE");
  }
  const labels = String(binding.domain || "").split(".");
  if (!binding.domain || labels[0] !== binding.workerName ||
      labels.length < 4 || labels.slice(-2).join(".") !== "workers.dev") {
    refuse("RECOVERY_TARGET_NOT_DISPOSABLE");
  }
  return Object.freeze({ nonce: workerMatch[1], suffix });
}

function inspectRecoveryIsolationClaim(binding, targetResourceFingerprint) {
  const claim = binding.recoveryFieldGate;
  const keys = claim && typeof claim === "object" && !Array.isArray(claim)
    ? Object.keys(claim).sort()
    : [];
  if (canonical(keys) !== canonical([
    "active_worker_version_id", "custom_domains", "paused_worker_version_id",
    "reviewed_at", "routes", "worker_script_etag",
  ])) {
    refuse("RECOVERY_TARGET_EXECUTION_UNREVIEWED");
  }
  const pausedWorkerVersionId = exactString(
    claim.paused_worker_version_id,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const activeWorkerVersionId = exactString(
    claim.active_worker_version_id,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const workerScriptEtag = exactString(
    claim.worker_script_etag,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const reviewedAt = new Date(claim.reviewed_at);
  if (!Array.isArray(claim.routes) || claim.routes.length !== 0 ||
      !Array.isArray(claim.custom_domains) || claim.custom_domains.length !== 0 ||
      !WORKER_VERSION_RE.test(pausedWorkerVersionId) ||
      !WORKER_VERSION_RE.test(activeWorkerVersionId) ||
      pausedWorkerVersionId === activeWorkerVersionId ||
      !SHA256_RE.test(workerScriptEtag) ||
      typeof claim.reviewed_at !== "string" ||
      !Number.isFinite(reviewedAt.getTime()) || reviewedAt.toISOString() !== claim.reviewed_at) {
    refuse("RECOVERY_TARGET_EXECUTION_UNREVIEWED");
  }
  return Object.freeze({
    pausedWorkerVersionId,
    activeWorkerVersionId,
    workerScriptEtag,
    approvalFingerprint: sha256(canonical({
      target_resource_fingerprint: targetResourceFingerprint,
      paused_worker_version_id: pausedWorkerVersionId,
      active_worker_version_id: activeWorkerVersionId,
      worker_script_etag: workerScriptEtag,
      reviewed_at: claim.reviewed_at,
      routes: [],
      custom_domains: [],
    })),
  });
}

function inspectGolden(path) {
  const loaded = readStablePrivateFile(path, {
    code: "RECOVERY_RELEASE_EVAL_UNSAFE",
    maxBytes: MAX_GOLDEN_BYTES,
  });
  let parsed;
  try { parsed = JSON.parse(loaded.raw.toString("utf8")); } catch {
    refuse("RECOVERY_RELEASE_EVAL_INVALID");
  }
  let coverage;
  try {
    validateGolden(parsed, "private release golden");
    coverage = evaluateProfileCoverage(parsed, "release");
  } catch {
    refuse("RECOVERY_RELEASE_EVAL_INVALID");
  }
  if (coverage.failures.length > 0) refuse("RECOVERY_RELEASE_EVAL_INCOMPLETE");
  return Object.freeze({ path: loaded.path, hash: loaded.hash, info: loaded.info });
}

function inspectWrapper(path) {
  const parentPath = dirname(resolve(path || ""));
  let parent;
  try { parent = lstatSync(parentPath); } catch {
    refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (process.platform !== "win32" && (parent.mode & 0o022) !== 0)) {
    refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  }
  assertOwned(parent, "RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  const loaded = readStablePrivateFile(path, {
    code: "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
    maxBytes: MAX_WRAPPER_BYTES,
    executable: true,
  });
  return Object.freeze({
    path: loaded.path,
    hash: loaded.hash,
    info: loaded.info,
    raw: Buffer.from(loaded.raw),
    parent: Object.freeze({
      path: parentPath,
      dev: parent.dev,
      ino: parent.ino,
      mode: parent.mode,
      uid: parent.uid,
    }),
  });
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeKnownPartial(path, artifactDirectory) {
  const absolute = resolve(path);
  if (dirname(absolute) !== artifactDirectory || !basename(absolute).startsWith(".brain-recovery-export.sql.tmp-")) {
    refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
  }
  if (!existsSync(absolute)) return;
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
  }
  assertOwned(info, "RECOVERY_EXPORT_PARTIAL_UNSAFE");
  unlinkSync(absolute);
  syncDirectory(artifactDirectory);
}

function reconcileExportResidue(artifactPath, dataPartial, combinedPartial, artifactDirectory, maxBytes) {
  if (!existsSync(artifactPath)) {
    removeKnownPartial(dataPartial, artifactDirectory);
    removeKnownPartial(combinedPartial, artifactDirectory);
    return false;
  }
  let finalInfo;
  try { finalInfo = lstatSync(artifactPath); } catch {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  assertOwnerOnly(finalInfo, "RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  if (existsSync(combinedPartial)) {
    const partialInfo = lstatSync(combinedPartial);
    if (!partialInfo.isFile() || partialInfo.isSymbolicLink()) {
      refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
    }
    assertOwned(partialInfo, "RECOVERY_EXPORT_PARTIAL_UNSAFE");
    if (partialInfo.dev === finalInfo.dev && partialInfo.ino === finalInfo.ino) {
      if (partialInfo.nlink !== 2 || finalInfo.nlink !== 2) {
        refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
      }
      unlinkSync(combinedPartial);
      syncDirectory(artifactDirectory);
    } else {
      removeKnownPartial(combinedPartial, artifactDirectory);
    }
  }
  removeKnownPartial(dataPartial, artifactDirectory);
  assertArtifactFile(artifactPath, { maxBytes });
  return true;
}

function wrapperEnvironment(accountId, callDirectory, environment = process.env) {
  const keychain = keychainChildEnvironment(environment);
  return Object.freeze({
    ...keychain,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    CLOUDFLARE_ACCOUNT_ID: String(accountId),
    // Wrangler 4 suppresses command stdout, including --json and --version,
    // when WRANGLER_LOG is "none" or "error". "log" preserves the machine
    // response while WRANGLER_LOG_SANITIZE and the owner-only temp directory
    // keep diagnostic material bounded and private.
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: join(callDirectory, "logs"),
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  });
}

function isAllowedWranglerCommand(args, approvedMutation = null) {
  if (SAFE_WRANGLER_PREFIXES.some((prefix) =>
    prefix.length <= args.length && prefix.every((part, index) => args[index] === part))) {
    return true;
  }
  // The only state-changing Wrangler command in this adapter promotes one
  // already-uploaded version to 100 percent. A shape check is insufficient:
  // bind the version and Worker to the separately approved execution claim.
  return Array.isArray(approvedMutation) &&
    canonical(args) === canonical(approvedMutation);
}

function normalizedChildResult(result) {
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal || null,
    error: result?.error || null,
    stdout: Buffer.isBuffer(result?.stdout)
      ? result.stdout
      : Buffer.from(String(result?.stdout ?? ""), "utf8"),
    stderr: Buffer.isBuffer(result?.stderr)
      ? result.stderr
      : Buffer.from(String(result?.stderr ?? ""), "utf8"),
  };
}

function defaultRunWrangler({ command, args, env, cwd, timeoutMs }) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: null,
    maxBuffer: MAX_PROVIDER_JSON_BYTES,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function parseProviderJson(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_PROVIDER_JSON_BYTES) {
    refuse("RECOVERY_CLOUDFLARE_RESPONSE_INVALID");
  }
  try { return JSON.parse(buffer.toString("utf8")); } catch {
    refuse("RECOVERY_CLOUDFLARE_RESPONSE_INVALID");
  }
}

function d1ResultRows(payload) {
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length !== 1 || !envelopes[0] || typeof envelopes[0] !== "object" ||
      envelopes[0].success === false || !Array.isArray(envelopes[0].results)) {
    refuse("RECOVERY_D1_RESPONSE_INVALID");
  }
  return envelopes[0].results;
}

function nonNegativeInteger(value, code = "RECOVERY_AGGREGATE_INVALID") {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) refuse(code);
  return number;
}

function exactString(value, code) {
  const text = String(value ?? "");
  if (!text || text.length > 1024 || CONTROL_RE.test(text)) refuse(code);
  return text;
}

function migrationFileContract() {
  const files = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  return files.map((name) => {
    const sql = readFileSync(join(MIGRATIONS_DIRECTORY, name), "utf8");
    return Object.freeze({
      version: Number.parseInt(name.split("_")[0], 10),
      name: name.replace(/\.sql$/, ""),
      checksum: sha256(sql).slice(0, 16),
      sql,
    });
  });
}

function validateMigrationContract(rows) {
  if (!Array.isArray(rows) || rows.length < 1) refuse("RECOVERY_MIGRATION_CONTRACT_INVALID");
  const available = migrationFileContract();
  const selected = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const version = nonNegativeInteger(row?.version, "RECOVERY_MIGRATION_CONTRACT_INVALID");
    const name = exactString(row?.name, "RECOVERY_MIGRATION_CONTRACT_INVALID");
    const checksum = String(row?.checksum ?? "");
    const local = available[index];
    if (version !== index + 1 || !local || local.version !== version || local.name !== name ||
        local.checksum !== checksum) {
      refuse("RECOVERY_MIGRATION_CONTRACT_INVALID");
    }
    selected.push(local);
  }
  return Object.freeze(selected);
}

function expectedInstallStateColumns(migrations) {
  const latest = migrations.at(-1)?.version || 0;
  return Object.freeze([
    ...INSTALL_STATE_BASE_COLUMNS,
    ...(latest >= 10 ? ["outbox_generation"] : []),
    ...(latest >= 11 ? INSTALL_STATE_LEASE_COLUMNS : []),
    ...(latest >= 12 ? INSTALL_STATE_PROJECTION_COLUMNS : []),
    ...(latest >= 13 ? INSTALL_STATE_BOOTSTRAP_V2_COLUMNS : []),
    ...(latest >= 14 ? ["session_generation"] : []),
    ...(latest >= 17 ? INSTALL_STATE_REFIT_COLUMNS : []),
  ]);
}

function recoverySqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value.length <= 1024 * 1024 && !value.includes("\0")) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  refuse("RECOVERY_INSTALL_STATE_INVALID");
}

/**
 * Serialize the singleton install row without ever selecting live derived-index
 * coordination state.
 *
 * Wrangler's table export has no column projection. Exporting install_state
 * directly would therefore persist an opaque invocation owner or a source
 * Vectorize changeset in a resumable artifact. Read the reviewed schema first,
 * project ephemeral fields to SQL NULL, and build one bounded INSERT. Older
 * prefix schemas use the same path without referencing absent columns.
 */
export async function normalizedInstallStateExport(binding, migrations, readRows) {
  const expectedColumns = expectedInstallStateColumns(migrations);
  const schema = await readRows(binding, "PRAGMA table_info(install_state)");
  if (!Array.isArray(schema) || schema.length !== expectedColumns.length) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const ordered = [...schema].sort((left, right) => Number(left?.cid) - Number(right?.cid));
  if (ordered.some((column, index) =>
    !column || column.name !== expectedColumns[index] ||
    !["INTEGER", "TEXT"].includes(String(column.type || "").toUpperCase()))) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const recoveryValue = (name, row = null) => {
    if (INSTALL_STATE_NULL_NORMALIZED_COLUMNS.includes(name)) return null;
    if (INSTALL_STATE_ZERO_NORMALIZED_COLUMNS.includes(name)) return 0;
    return row?.[name];
  };
  const projection = expectedColumns.map((name) => {
    if (name === "vector_projection_status") {
      return `CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END AS ${quoteIdentifier(name)}`;
    }
    if (name === "vector_projection_bootstrap_epoch") {
      return `CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 1 ELSE 0 END AS ${quoteIdentifier(name)}`;
    }
    if (name === "vector_projection_bootstrap_high_water") {
      return `(SELECT MAX(chunk_uid) FROM chunks) AS ${quoteIdentifier(name)}`;
    }
    const normalized = recoveryValue(name);
    if (normalized === null) return `NULL AS ${quoteIdentifier(name)}`;
    if (normalized !== undefined) {
      return `${recoverySqlLiteral(normalized)} AS ${quoteIdentifier(name)}`;
    }
    return quoteIdentifier(name);
  });
  const rows = await readRows(
    binding,
    `SELECT ${projection.join(",")} FROM install_state ORDER BY id`,
  );
  if (!Array.isArray(rows) || rows.length !== 1) refuse("RECOVERY_INSTALL_STATE_INVALID");
  const row = rows[0];
  const hasCorpus = row?.vector_projection_bootstrap_high_water !== null;
  if (!row || typeof row !== "object" || Array.isArray(row) || Number(row.id) !== 1 ||
      expectedColumns.some((name) => !Object.hasOwn(row, name)) ||
      expectedColumns.some((name) =>
        recoveryValue(name, row) !== row[name]) ||
      (expectedColumns.includes("vector_projection_status") &&
        (row.vector_projection_status !== (hasCorpus ? "bootstrap_required" : "verified") ||
         Number(row.vector_projection_bootstrap_epoch) !== (hasCorpus ? 1 : 0)))) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const columns = expectedColumns.map(quoteIdentifier).join(",");
  const values = expectedColumns.map((name) =>
    recoverySqlLiteral(recoveryValue(name, row))).join(",");
  return Buffer.from(`INSERT INTO "install_state" (${columns}) VALUES (${values});\n`, "utf8");
}

/**
 * Compare executable SQLite schema rather than provider-specific formatting.
 *
 * D1 removes SQL comments before storing CREATE statements in sqlite_schema,
 * while local SQLite preserves them. Migration checksums still bind the exact
 * reviewed files; this normalization only prevents non-semantic comments and
 * whitespace from making the independently restored schema look different.
 */
function canonicalSchemaSql(value) {
  let output = "";
  let quote = null;
  let pendingSpace = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote) {
        if (next === quote) {
          output += next;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingSpace && output) output += " ";
      pendingSpace = false;
      quote = character;
      output += character;
      continue;
    }
    if (character === "[") {
      if (pendingSpace && output) output += " ";
      pendingSpace = false;
      quote = "]";
      output += character;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index++;
      pendingSpace = true;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index++;
      if (index < value.length) index++;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output) output += " ";
    pendingSpace = false;
    output += character;
  }
  return output.trim();
}

function normalizeSchemaRows(rows) {
  if (!Array.isArray(rows)) refuse("RECOVERY_SCHEMA_CONTRACT_INVALID");
  const normalized = rows.map((row) => {
    // SQLite records implicit auto-indexes with a null SQL definition. DDL can
    // legitimately contain whitespace and exceed an identity field's bound.
    const sql = row?.sql;
    if (sql !== null && (typeof sql !== "string" || !sql || sql.length > 256 * 1024 || sql.includes("\0"))) {
      refuse("RECOVERY_SCHEMA_CONTRACT_INVALID");
    }
    return {
      type: exactString(row?.type, "RECOVERY_SCHEMA_CONTRACT_INVALID"),
      name: exactString(row?.name, "RECOVERY_SCHEMA_CONTRACT_INVALID"),
      tbl_name: exactString(row?.tbl_name, "RECOVERY_SCHEMA_CONTRACT_INVALID"),
      sql: sql === null ? null : canonicalSchemaSql(sql),
    };
  });
  const sorted = [...normalized].sort((a, b) =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.tbl_name.localeCompare(b.tbl_name));
  return Object.freeze(sorted.map(Object.freeze));
}

function normalizeAggregate(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) refuse("RECOVERY_AGGREGATE_INVALID");
  const normalized = {};
  for (const [name] of AGGREGATE_FIELDS) {
    const value = String(row[name] ?? "");
    if (!/^(?:0|[1-9]\d*)$/.test(value)) refuse("RECOVERY_AGGREGATE_INVALID");
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

function snapshotEvidence({ quickCheck, migrations, schemaRows, aggregate }) {
  if (quickCheck !== "ok") refuse("RECOVERY_D1_INTEGRITY_FAILED");
  const migrationFingerprint = migrations.map(({ version, name, checksum }) => ({ version, name, checksum }));
  const schemaFingerprint = sha256(canonical({ migrations: migrationFingerprint, schema: schemaRows }));
  const aggregateFingerprint = sha256(canonical(aggregate));
  return Object.freeze({
    integrity: "ok",
    schema_fingerprint: schemaFingerprint,
    aggregate_fingerprint: aggregateFingerprint,
    document_count: nonNegativeInteger(aggregate.documents),
    chunk_count: nonNegativeInteger(aggregate.chunks),
    fts_count: nonNegativeInteger(aggregate.chunks_fts),
  });
}

function assertSameSnapshot(left, right, code = "RECOVERY_D1_SNAPSHOT_MISMATCH") {
  const fields = [
    "integrity", "schema_fingerprint", "aggregate_fingerprint",
    "document_count", "chunk_count", "fts_count", "content_fingerprint",
  ];
  if (fields.some((field) => left?.[field] !== right?.[field])) refuse(code);
  return true;
}

function assertSameStructuralSnapshot(left, right, code = "RECOVERY_D1_SNAPSHOT_MISMATCH") {
  const fields = [
    "integrity", "schema_fingerprint", "aggregate_fingerprint",
    "document_count", "chunk_count", "fts_count",
  ];
  if (fields.some((field) => left?.[field] !== right?.[field])) refuse(code);
  return true;
}

function assertSameRecoveryCorpus(left, right, code = "RECOVERY_D1_SNAPSHOT_MISMATCH") {
  const fields = [
    "integrity", "schema_fingerprint", "content_fingerprint",
    "document_count", "chunk_count", "fts_count",
  ];
  if (fields.some((field) => left?.[field] !== right?.[field])) refuse(code);
  return true;
}

const SCHEMA_14_TABLES = Object.freeze(["owner_passkeys", "auth_challenges", "enrollment_codes"]);

function expectedRecoveryTables(migrations) {
  const latest = migrations?.at(-1)?.version || RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION;
  return RECOVERY_DURABLE_TABLES.filter((table) =>
    (latest >= 13 || table !== "vector_bootstrap_batches") &&
    (latest >= 14 || !SCHEMA_14_TABLES.includes(table)) &&
    (latest >= 15 || !SCHEMA_15_TABLES.includes(table)) &&
    (latest >= 16 || !SCHEMA_16_TABLES.includes(table)));
}

function assertExpectedTables(rows, migrations) {
  if (!Array.isArray(rows)) refuse("RECOVERY_TABLE_INVENTORY_INVALID");
  const names = rows.map((row) => exactString(row?.name, "RECOVERY_TABLE_INVENTORY_INVALID"));
  if (canonical(names) !== canonical(expectedRecoveryTables(migrations).sort())) {
    refuse("RECOVERY_TABLE_INVENTORY_INVALID");
  }
  return names;
}

async function writeToChild(stream, value) {
  if (stream.write(value)) return;
  await new Promise((resolvePromise, reject) => {
    stream.once("drain", resolvePromise);
    stream.once("error", reject);
  });
}

/**
 * Execute a recovery SQL artifact in an in-memory sqlite3 process. The SQL is
 * streamed, never copied into another database file, and only aggregate JSON is
 * captured from stdout.
 */
export async function verifyRecoverySqlArtifact(artifactPath, {
  maxBytes = 5 * 1024 * 1024 * 1024,
  sqlitePath = "/usr/bin/sqlite3",
  spawnProcess = spawn,
  timeoutMs = MAX_WRANGLER_TIMEOUT_MS,
} = {}) {
  const checked = assertArtifactFile(artifactPath, { maxBytes });
  let descriptor;
  let child;
  let output = Buffer.alloc(0);
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    child = spawnProcess(sqlitePath, ["-safe", ":memory:", "-batch", "-bail"], {
      env: localToolEnvironment(process.env, {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      }),
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    if (!child?.stdin || !child?.stdout) refuse("RECOVERY_LOCAL_SQLITE_FAILED");
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > MAX_SQLITE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    await writeToChild(child.stdin, Buffer.from(".bail on\n", "utf8"));
    const input = createReadStream("", { fd: descriptor, autoClose: false });
    for await (const chunk of input) await writeToChild(child.stdin, chunk);
    const aggregateJsonPairs = AGGREGATE_FIELDS.map(([name]) =>
      `'${name}',${quoteIdentifier(name)}`).join(",");
    const suffix = Buffer.from(
      `\n${FTS_INTEGRITY_SQL};\n.mode list\n` +
      `SELECT json_object('group','quick','rows',json_group_array(json_object('quick_check',quick_check))) ` +
        `FROM pragma_quick_check;\n` +
      `SELECT json_object('group','migrations','rows',json_group_array(json_object(` +
        `'version',version,'name',name,'checksum',checksum))) FROM (` +
        `SELECT version,name,checksum FROM schema_migrations ORDER BY version);\n` +
      `SELECT json_object('group','tables','rows',json_group_array(json_object('name',name))) FROM (` +
        `SELECT name FROM sqlite_schema WHERE type='table' ` +
        `AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' AND name <> 'chunks_fts' ` +
        `AND name NOT LIKE 'chunks_fts_%' ORDER BY name);\n` +
      `SELECT json_object('group','schema','rows',json_group_array(json_object(` +
        `'type',type,'name',name,'tbl_name',tbl_name,'sql',sql))) FROM (` +
        `SELECT type,name,tbl_name,sql FROM sqlite_schema ` +
        `WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' ` +
        `AND name NOT LIKE 'chunks_fts_%' ORDER BY type,name,tbl_name);\n` +
      `SELECT json_object('group','aggregate','rows',json_array(json_object(${aggregateJsonPairs}))) ` +
        `FROM (${AGGREGATE_SQL});\n`,
      "utf8",
    );
    await writeToChild(child.stdin, suffix);
    child.stdin.end();
    const result = await new Promise((resolvePromise) => {
      child.once("error", () => resolvePromise({ status: null }));
      child.once("close", (status, signal) => resolvePromise({ status, signal }));
    });
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    if (result.status !== 0 || result.signal || output.length > MAX_SQLITE_OUTPUT_BYTES) {
      refuse("RECOVERY_LOCAL_SQLITE_FAILED");
    }
    const groups = output.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { refuse("RECOVERY_LOCAL_SQLITE_RESPONSE_INVALID"); }
    });
    const expectedGroups = ["quick", "migrations", "tables", "schema", "aggregate"];
    if (groups.length !== expectedGroups.length || groups.some((group, index) =>
      !group || group.group !== expectedGroups[index] || !Array.isArray(group.rows))) {
      refuse("RECOVERY_LOCAL_SQLITE_RESPONSE_INVALID");
    }
    const quick = groups[0].rows[0];
    const migrations = validateMigrationContract(groups[1].rows);
    assertExpectedTables(groups[2].rows, migrations);
    const schemaRows = normalizeSchemaRows(groups[3].rows);
    const aggregateRow = groups[4].rows[0];
    if (!aggregateRow) {
      refuse("RECOVERY_LOCAL_SQLITE_RESPONSE_INVALID");
    }
    return snapshotEvidence({
      quickCheck: String(quick?.quick_check || ""),
      migrations,
      schemaRows,
      aggregate: normalizeAggregate(aggregateRow),
    });
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_LOCAL_SQLITE_FAILED");
  } finally {
    output.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function createGateLocalPins(config, plan) {
  const binding = inspectVerifiedRecoveryManifestBindings(
    plan,
    config.sourceManifestPath,
    config.targetManifestPath,
  );
  const disposable = assertDisposableTarget(binding.target);
  const isolation = inspectRecoveryIsolationClaim(
    binding.target,
    plan.target_resource_fingerprint,
  );
  if (config.platform !== "darwin") refuse("RECOVERY_FIELD_GATE_REQUIRES_MACOS_KEYCHAIN");
  if (!binding.target.adminKeySecret) refuse("RECOVERY_TARGET_KEYCHAIN_REQUIRED");
  let targetAdminLocator;
  try { targetAdminLocator = parseAdminKeySecretReference(binding.target.adminKeySecret); } catch {
    refuse("RECOVERY_TARGET_KEYCHAIN_REQUIRED");
  }
  const wrapper = inspectWrapper(config.wranglerWrapperPath);
  const golden = inspectGolden(config.goldenPath);
  const artifacts = assertPrivateDirectory(config.artifactDirectory);
  const artifactPath = join(artifacts.path, plan.artifact.relative_name);
  return Object.freeze({
    binding,
    disposable,
    isolation,
    targetAdminLocator,
    wrapper,
    golden,
    artifacts,
    artifactPath,
  });
}

function assertLocalPinsUnchanged(pins, config, plan) {
  const binding = inspectVerifiedRecoveryManifestBindings(
    plan,
    config.sourceManifestPath,
    config.targetManifestPath,
  );
  if (canonical(binding) !== canonical(pins.binding)) refuse("RECOVERY_LOCAL_BINDING_CHANGED");
  const wrapper = inspectWrapper(config.wranglerWrapperPath);
  const golden = inspectGolden(config.goldenPath);
  const artifacts = assertPrivateDirectory(config.artifactDirectory);
  if (wrapper.hash !== pins.wrapper.hash || !sameFile(wrapper.info, pins.wrapper.info) ||
      canonical(wrapper.parent) !== canonical(pins.wrapper.parent) ||
      golden.hash !== pins.golden.hash || !sameFile(golden.info, pins.golden.info) ||
      artifacts.path !== pins.artifacts.path ||
      artifacts.info.dev !== pins.artifacts.info.dev || artifacts.info.ino !== pins.artifacts.info.ino) {
    refuse("RECOVERY_LOCAL_BINDING_CHANGED");
  }
  return true;
}

function acquireFieldGateLock(artifactDirectory, planFingerprint) {
  const path = join(artifactDirectory, ".brain-recovery-field-gate.lock");
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    const bytes = Buffer.from(`${canonical({ schema_version: 1, plan_fingerprint: planFingerprint })}\n`, "utf8");
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    const info = fstatSync(descriptor);
    syncDirectory(artifactDirectory);
    return Object.freeze({ path, descriptor, info });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "EEXIST") refuse("RECOVERY_FIELD_GATE_LOCKED");
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_LOCK_FAILED");
  }
}

function releaseFieldGateLock(lock, artifactDirectory) {
  if (!lock) return;
  try {
    const current = lstatSync(lock.path);
    const opened = fstatSync(lock.descriptor);
    if (current.dev !== lock.info.dev || current.ino !== lock.info.ino ||
        opened.dev !== lock.info.dev || opened.ino !== lock.info.ino || current.nlink !== 1) {
      refuse("RECOVERY_FIELD_GATE_LOCK_CHANGED");
    }
    closeSync(lock.descriptor);
    unlinkSync(lock.path);
    syncDirectory(artifactDirectory);
  } catch (error) {
    try { closeSync(lock.descriptor); } catch { /* fixed failure below */ }
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_LOCK_RELEASE_FAILED");
  }
}

function dataPlaneBase(binding) {
  if (!binding.domain) refuse("RECOVERY_TARGET_DOMAIN_REQUIRED");
  return `https://${binding.domain}`;
}

function defaultReadAdminKey(locator, environment) {
  const value = readAdminKeyFromKeychain(locator, { environment });
  if (!value) refuse("RECOVERY_TARGET_KEYCHAIN_VALUE_MISSING");
  return value;
}

async function boundedJsonResponse(response) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    refuse("RECOVERY_DATA_PLANE_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_BYTES) {
        await reader.cancel().catch(() => {});
        refuse("RECOVERY_DATA_PLANE_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(value));
    }
    const raw = Buffer.concat(chunks, bytes);
    try { return JSON.parse(raw.toString("utf8")); } catch {
      refuse("RECOVERY_DATA_PLANE_RESPONSE_INVALID");
    } finally {
      raw.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  } finally {
    reader.releaseLock();
  }
}

async function exactFetch(fetchImpl, base, path, options = {}, timeoutMs = 180_000) {
  const baseUrl = new URL(base);
  const target = new URL(path, `${baseUrl.href.replace(/\/$/, "")}/`);
  const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1" ||
    target.hostname === "[::1]";
  if (target.origin !== baseUrl.origin ||
      (target.protocol !== "https:" && !(loopback && target.protocol === "http:")) ||
      target.username || target.password || target.search || target.hash) {
    refuse("RECOVERY_DATA_PLANE_TARGET_INVALID");
  }
  const response = await fetchImpl(target, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "Cache-Control": "no-store",
    },
    cache: "no-store",
    // `error` prevents the runtime from issuing a second request. A manual
    // redirect still exposes response metadata and is easier for a custom
    // fetch implementation to mishandle when X-Admin-Key is present.
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => { refuse("RECOVERY_DATA_PLANE_REQUEST_FAILED"); });
  if (response.redirected === true ||
      (response.url && new URL(response.url).origin !== target.origin)) {
    refuse("RECOVERY_DATA_PLANE_REDIRECT_REFUSED");
  }
  if (response.status >= 300 && response.status < 400) refuse("RECOVERY_DATA_PLANE_REDIRECT_REFUSED");
  return response;
}

const BOOTSTRAP_PHASES = new Set(["legacy_drain", "building", "waiting", "complete"]);
const BOOTSTRAP_RECEIPT_FIELDS = Object.freeze([
  "protocol", "phase", "epoch", "total", "confirmed", "queued", "submitted",
  "remaining", "in_flight_batches", "failed", "complete", "vector_ready",
  "expected_vectors", "actual_vectors",
]);
const BOOTSTRAP_BUSY_FIELDS = Object.freeze([
  "protocol", "busy", "remaining", "retry_after_seconds",
]);

function exactAggregateReceiptFields(body, expected, code) {
  if (!body || typeof body !== "object" || Array.isArray(body)) refuse(code);
  const actual = Object.keys(body).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    // Do not echo fields or values. This endpoint is allowed to return aggregate
    // progress only, so unexpected response material never reaches a terminal.
    refuse(code);
  }
}

function validateBootstrapReceipt(body, expectedTotal) {
  const code = "RECOVERY_BOOTSTRAP_RECEIPT_INVALID";
  exactAggregateReceiptFields(body, BOOTSTRAP_RECEIPT_FIELDS, code);
  if (body.protocol !== "bootstrap-v2" || !BOOTSTRAP_PHASES.has(body.phase) ||
      typeof body.complete !== "boolean" || typeof body.vector_ready !== "boolean") {
    refuse(code);
  }
  const receipt = Object.freeze({
    protocol: body.protocol,
    phase: body.phase,
    epoch: nonNegativeInteger(body.epoch, code),
    total: nonNegativeInteger(body.total, code),
    confirmed: nonNegativeInteger(body.confirmed, code),
    queued: nonNegativeInteger(body.queued, code),
    submitted: nonNegativeInteger(body.submitted, code),
    remaining: nonNegativeInteger(body.remaining, code),
    inFlightBatches: nonNegativeInteger(body.in_flight_batches, code),
    failed: nonNegativeInteger(body.failed, code),
    complete: body.complete,
    vectorReady: body.vector_ready,
    expectedVectors: nonNegativeInteger(body.expected_vectors, code),
    actualVectors: nonNegativeInteger(body.actual_vectors, code),
  });
  if (receipt.total !== expectedTotal || receipt.expectedVectors !== expectedTotal ||
      receipt.actualVectors > expectedTotal || receipt.inFlightBatches > 3 ||
      receipt.confirmed > receipt.total ||
      receipt.remaining !== receipt.total - receipt.confirmed ||
      receipt.queued + receipt.submitted > receipt.remaining || receipt.failed !== 0 ||
      (receipt.phase === "complete") !== receipt.complete ||
      (!receipt.complete && receipt.vectorReady) ||
      (receipt.complete && (
        receipt.remaining !== 0 || receipt.queued !== 0 || receipt.submitted !== 0 ||
        receipt.inFlightBatches !== 0 || !receipt.vectorReady ||
        receipt.actualVectors !== expectedTotal
      ))) {
    refuse(code);
  }
  return receipt;
}

function validateBootstrapBusyReceipt(body, previousRemaining) {
  const code = "RECOVERY_BOOTSTRAP_BUSY_RECEIPT_INVALID";
  exactAggregateReceiptFields(body, BOOTSTRAP_BUSY_FIELDS, code);
  if (body.protocol !== "bootstrap-v2" || body.busy !== true) refuse(code);
  const remaining = nonNegativeInteger(body.remaining, code);
  const retryAfterSeconds = nonNegativeInteger(body.retry_after_seconds, code);
  if (retryAfterSeconds < 1 || retryAfterSeconds > 1_200 ||
      (previousRemaining !== null && remaining > previousRemaining)) {
    refuse(code);
  }
  return Object.freeze({ remaining, retryAfterSeconds });
}

function validateBootstrapProgress(previous, current) {
  if (!previous) return current;
  if (current.epoch !== previous.epoch || current.total !== previous.total ||
      current.confirmed < previous.confirmed || current.remaining > previous.remaining ||
      (previous.phase !== "legacy_drain" && current.phase === "legacy_drain")) {
    refuse("RECOVERY_BOOTSTRAP_PROGRESS_INVALID");
  }
  if (current.phase === "building" && [
    "confirmed", "remaining", "queued", "submitted", "inFlightBatches", "actualVectors",
  ].every((field) => current[field] === previous[field])) {
    refuse("RECOVERY_BOOTSTRAP_STALLED");
  }
  return current;
}

function validateExactVectorInventory(inventory, expectedVectors, code = "RECOVERY_HEALTH_FAILED") {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory) ||
      inventory.backend !== "d1" || !Array.isArray(inventory.rows)) refuse(code);
  const backlog = inventory.vector_backlog;
  const readiness = inventory.vector_readiness;
  if (!backlog || typeof backlog !== "object" || Array.isArray(backlog) ||
      !readiness || typeof readiness !== "object" || Array.isArray(readiness) ||
      Object.hasOwn(backlog, "error") || Object.hasOwn(readiness, "error")) refuse(code);
  const pending = nonNegativeInteger(backlog.pending, code);
  const submitted = nonNegativeInteger(backlog.submitted, code);
  const readinessPending = nonNegativeInteger(readiness.pending, code);
  const readinessSubmitted = nonNegativeInteger(readiness.submitted, code);
  const expected = nonNegativeInteger(readiness.expected_vectors, code);
  const actual = nonNegativeInteger(readiness.actual_vectors, code);
  if (readiness.ready !== true || pending !== 0 || submitted !== 0 ||
      readinessPending !== 0 || readinessSubmitted !== 0 ||
      pending !== readinessPending || submitted !== readinessSubmitted ||
      expected !== expectedVectors || actual !== expectedVectors) refuse(code);
  return Object.freeze({ expectedVectors: expected, actualVectors: actual });
}

function evalChildEnvironment(environment = process.env) {
  return localToolEnvironment(environment, {
    PATH: "/usr/bin:/bin:/usr/local/bin",
    LANG: "C",
    LC_ALL: "C",
    BRAIN_ADMIN_KEY_STDIN: "1",
    CLOUDFLARE_ACCOUNT_ID: undefined,
  });
}

function defaultRunEval({ args, env, input, cwd, timeoutMs }) {
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    input,
    encoding: null,
    maxBuffer: 1024,
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

/**
 * Build the provider adapters after completing only local, pre-credential
 * checks. Each adapter revalidates the exact local pins around its own action.
 */
export function createCloudflareRecoveryFieldGateAdapters(configInput, dependencies = {}) {
  const config = Object.freeze({
    ...configInput,
    platform: dependencies.platform ?? process.platform,
    environment: dependencies.environment ?? process.env,
  });
  const plan = config.plan;
  if (!plan || !SHA256_RE.test(plan.plan_fingerprint || "")) {
    refuse("RECOVERY_FIELD_GATE_PLAN_INVALID");
  }
  const pins = createGateLocalPins(config, plan);
  const runWranglerImpl = dependencies.runWrangler ?? defaultRunWrangler;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = dependencies.now ?? Date.now;
  const verifySqlArtifact = dependencies.verifySqlArtifact ?? verifyRecoverySqlArtifact;
  const readAdminKey = dependencies.readAdminKey ?? ((locator) =>
    defaultReadAdminKey(locator, config.environment));
  const runEval = dependencies.runEval ?? defaultRunEval;
  let wrapperVersionProven = false;
  const operationApproved = config.approvePlan === plan.plan_fingerprint &&
    config.approveDisposableTarget === plan.target_resource_fingerprint &&
    config.approveTargetExecution === pins.isolation.approvalFingerprint &&
    config.approveSourceExportBlocking === plan.source_resource_fingerprint &&
    config.approveWrapper === pins.wrapper.hash &&
    // A valid replacement golden can change the recovery verdict just as much
    // as a different target can. Bind its exact bytes into every invocation so
    // a supervised stop cannot resume under an unreviewed evaluation suite.
    config.approveGolden === pins.golden.hash;

  const revalidate = () => assertLocalPinsUnchanged(pins, config, plan);

  async function wrangler(binding, args, {
    json = false,
    text = false,
    timeoutMs = MAX_WRANGLER_TIMEOUT_MS,
  } = {}) {
    const approvedMutation = binding.accountId === pins.binding.target.accountId &&
        binding.workerName === pins.binding.target.workerName
      ? [
          "versions", "deploy", `${pins.isolation.activeWorkerVersionId}@100%`,
          "--name", pins.binding.target.workerName, "-y",
        ]
      : null;
    if (!isAllowedWranglerCommand(args, approvedMutation)) {
      refuse("RECOVERY_WRANGLER_COMMAND_REFUSED");
    }
    revalidate();
    const callDirectory = mkdtempSync(join(pins.artifacts.path, ".brain-recovery-runtime-"));
    let result;
    try {
      chmodSync(callDirectory, 0o700);
      mkdirSync(join(callDirectory, "logs"), { mode: 0o700 });
      const executionWrapper = join(callDirectory, "wrangler-pinned");
      writeFileSync(executionWrapper, pins.wrapper.raw, { flag: "wx", mode: 0o700 });
      if (process.platform !== "win32") chmodSync(executionWrapper, 0o700);
      const executionPin = readStablePrivateFile(executionWrapper, {
        code: "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
        maxBytes: MAX_WRAPPER_BYTES,
        executable: true,
      });
      if (executionPin.hash !== pins.wrapper.hash) refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
      const env = wrapperEnvironment(binding.accountId, callDirectory, config.environment);
      result = normalizedChildResult(await runWranglerImpl({
        command: executionWrapper,
        args: args[0] === "--version"
          ? [...args]
          : [...args, ...WRANGLER_FAIL_CLOSED_FLAGS],
        env,
        cwd: callDirectory,
        timeoutMs,
      }));
      if (result.status !== 0 || result.signal || result.error) {
        refuse("RECOVERY_WRANGLER_CALL_FAILED");
      }
      if (result.stdout.length > MAX_PROVIDER_JSON_BYTES || result.stderr.length > MAX_PROVIDER_JSON_BYTES) {
        refuse("RECOVERY_CLOUDFLARE_RESPONSE_INVALID");
      }
      if (json) return parseProviderJson(result.stdout);
      if (text) return result.stdout.toString("utf8");
      return null;
    } finally {
      if (result) {
        result.stdout.fill(0);
        result.stderr.fill(0);
      }
      rmSync(callDirectory, { recursive: true, force: true });
      revalidate();
    }
  }

  async function ensureWrapperVersion(binding) {
    if (wrapperVersionProven) return;
    const version = await wrangler(binding, ["--version"], { text: true });
    if (!/(?:^|\s)4\.\d+\.\d+(?:\s|$)/.test(String(version).trim())) {
      refuse("RECOVERY_WRANGLER_VERSION_UNSUPPORTED");
    }
    wrapperVersionProven = true;
  }

  async function wranglerJson(binding, args) {
    await ensureWrapperVersion(binding);
    return wrangler(binding, args, { json: true });
  }

  async function d1Rows(binding, sql) {
    const payload = await wranglerJson(binding, [
      "d1", "execute", binding.databaseName,
      "--remote", "--command", sql, "--json",
    ]);
    return d1ResultRows(payload);
  }

  async function vectorInfo(binding) {
    const info = await wranglerJson(binding, ["vectorize", "info", binding.vectorizeIndex, "--json"]);
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      refuse("RECOVERY_VECTORIZE_RESPONSE_INVALID");
    }
    const rawVectorCount = info.vectorCount ?? info.vector_count;
    if (rawVectorCount === undefined || rawVectorCount === null) {
      refuse("RECOVERY_VECTORIZE_RESPONSE_INVALID");
    }
    const vectorCount = nonNegativeInteger(rawVectorCount, "RECOVERY_VECTORIZE_RESPONSE_INVALID");
    const dimensions = nonNegativeInteger(info.dimensions, "RECOVERY_VECTORIZE_RESPONSE_INVALID");
    return Object.freeze({ vectorCount, dimensions });
  }

  async function inspectWorkerVersion(binding, role, versionId, expectedMode = null) {
    const version = await wranglerJson(binding, [
      "versions", "view", versionId, "--name", binding.workerName, "--json",
    ]);
    if (!version || version.id !== versionId) {
      refuse(role === "target"
        ? "RECOVERY_TARGET_EXECUTION_CHANGED"
        : "RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const resources = version?.resources;
    if (!resources || typeof resources !== "object" || Array.isArray(resources) ||
        canonical(Object.keys(resources).sort()) !==
          canonical(["bindings", "script", "script_runtime"])) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    const script = resources.script;
    const runtime = resources.script_runtime;
    if (!script || typeof script !== "object" || Array.isArray(script) ||
        canonical(Object.keys(script).sort()) !==
          canonical(["etag", "handlers", "last_deployed_from", "named_handlers"]) ||
        !runtime || typeof runtime !== "object" || Array.isArray(runtime) ||
        canonical(Object.keys(runtime).sort()) !==
          canonical(["compatibility_date", "usage_model"])) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    const scriptEtag = exactString(script.etag, "RECOVERY_WORKER_CODE_INVALID");
    if (!SHA256_RE.test(scriptEtag) || script.last_deployed_from !== "api" ||
        !Array.isArray(script.handlers) ||
        canonical([...script.handlers].sort()) !== canonical(["fetch", "scheduled"]) ||
        !Array.isArray(script.named_handlers) ||
        script.named_handlers.some((entry) =>
          !entry || typeof entry !== "object" || Array.isArray(entry)) ||
        runtime.compatibility_date !== "2026-01-01" ||
        runtime.usage_model !== "standard") {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }

    const bindings = resources.bindings;
    if (!Array.isArray(bindings) || bindings.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry))) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const requiredBindingNames = [
      "AI", "ANSWER_MODEL", "BRAIN_NAME", "BRAIN_OWNER", "BRAIN_VERSION",
      "CHUNK_OVERLAP", "CHUNK_SIZE", "CREDENTIAL_SCANNER", "DAILY_LLM_CAP_USD",
      "DB", "STORAGE", "VECTORIZE",
    ];
    const actualNonSecretNames = bindings
      .filter((entry) => entry.type !== "secret_text" && entry.name !== "VECTOR_DRAIN_MODE")
      .map((entry) => exactString(entry.name, "RECOVERY_WORKER_BINDINGS_INVALID"))
      .sort();
    const expectedNonSecretNames = [...requiredBindingNames].sort();
    if (canonical(actualNonSecretNames) !== canonical(expectedNonSecretNames)) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const exactlyOne = (predicate) => bindings.filter(predicate).length === 1;
    if (!exactlyOne((entry) =>
      entry.type === "d1" && entry.name === "DB" && entry.id === binding.databaseId &&
        entry.database_id === binding.databaseId) ||
        !exactlyOne((entry) =>
          entry.type === "vectorize" && entry.name === "VECTORIZE" &&
          entry.index_name === binding.vectorizeIndex) ||
        !exactlyOne((entry) =>
          entry.type === "ai" && entry.name === "AI" && entry.project === "<catalog>") ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "STORAGE" && entry.text === "d1") ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "BRAIN_NAME" &&
          entry.text === binding.clientSlug) ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "BRAIN_VERSION" &&
          entry.text === binding.productVersion)) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const plainText = (name) => {
      const matches = bindings.filter((entry) =>
        entry.type === "plain_text" && entry.name === name);
      if (matches.length !== 1) refuse("RECOVERY_WORKER_BINDINGS_INVALID");
      return exactString(matches[0].text, "RECOVERY_WORKER_BINDINGS_INVALID");
    };
    const chunkSize = plainText("CHUNK_SIZE");
    const chunkOverlap = plainText("CHUNK_OVERLAP");
    const dailyCap = plainText("DAILY_LLM_CAP_USD");
    const chunkSizeNumber = Number(chunkSize);
    const chunkOverlapNumber = Number(chunkOverlap);
    if (!/^\d+$/.test(chunkSize) || !Number.isSafeInteger(chunkSizeNumber) ||
        chunkSizeNumber < 1 || !/^\d+$/.test(chunkOverlap) ||
        !Number.isSafeInteger(chunkOverlapNumber) || chunkOverlapNumber >= chunkSizeNumber ||
        !/^\d+(?:\.\d+)?$/.test(dailyCap) || !Number.isFinite(Number(dailyCap)) ||
        Number(dailyCap) < 0 ||
        !["on", "off"].includes(plainText("CREDENTIAL_SCANNER"))) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    plainText("BRAIN_OWNER");
    plainText("ANSWER_MODEL");
    const secretNames = bindings
      .filter((entry) => entry.type === "secret_text")
      .map((entry) => String(entry.name || ""))
      .sort();
    const allowedSecrets = role === "source"
      ? new Set(["ADMIN_KEY", "RAG_PROXY_KEY"])
      : new Set(["ADMIN_KEY"]);
    if (!secretNames.includes("ADMIN_KEY") ||
        secretNames.some((name) => !allowedSecrets.has(name)) ||
        (role === "target" && canonical(secretNames) !== canonical(["ADMIN_KEY"]))) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    if (role === "target") {
      const modeBindings = bindings.filter((entry) => entry?.name === "VECTOR_DRAIN_MODE");
      const paused = modeBindings.length === 1 &&
        modeBindings[0]?.type === "plain_text" &&
        modeBindings[0]?.text === "paused-for-upgrade";
      const active = modeBindings.length === 0;
      if ((expectedMode === "paused" && !paused) ||
          (expectedMode === "active" && !active) ||
          !["paused", "active"].includes(expectedMode)) {
        refuse("RECOVERY_TARGET_EXECUTION_MODE_INVALID");
      }
    }
    const comparable = bindings
      .filter((entry) => entry.name !== "VECTOR_DRAIN_MODE")
      .map((entry) => structuredClone(entry))
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
    return Object.freeze({
      comparable: Object.freeze(comparable.map(Object.freeze)),
      code: Object.freeze({
        script: structuredClone(script),
        runtime: structuredClone(runtime),
      }),
      scriptEtag,
    });
  }

  async function assertReviewedTargetVersions(binding) {
    const paused = await inspectWorkerVersion(
      binding,
      "target",
      pins.isolation.pausedWorkerVersionId,
      "paused",
    );
    const active = await inspectWorkerVersion(
      binding,
      "target",
      pins.isolation.activeWorkerVersionId,
      "active",
    );
    if (paused.scriptEtag !== pins.isolation.workerScriptEtag ||
        active.scriptEtag !== pins.isolation.workerScriptEtag ||
        canonical(paused.code) !== canonical(active.code)) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    if (canonical(paused.comparable) !== canonical(active.comparable)) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    return true;
  }

  async function assertExactCloudflareResources(binding, role, targetMode = null) {
    if (role !== "source" && role !== "target") {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    if (role === "target" && !["paused", "active", "either"].includes(targetMode)) {
      refuse("RECOVERY_TARGET_EXECUTION_MODE_INVALID");
    }
    const databases = await wranglerJson(binding, ["d1", "list", "--json"]);
    if (!Array.isArray(databases)) refuse("RECOVERY_D1_RESOURCE_AMBIGUOUS");
    const byName = databases.filter((row) => row?.name === binding.databaseName);
    const byId = databases.filter((row) => (row?.uuid ?? row?.id) === binding.databaseId);
    if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0]) {
      refuse("RECOVERY_D1_RESOURCE_AMBIGUOUS");
    }

    const indexes = await wranglerJson(binding, ["vectorize", "list", "--json"]);
    if (!Array.isArray(indexes)) refuse("RECOVERY_VECTORIZE_RESOURCE_AMBIGUOUS");
    const matchingIndexes = indexes.filter((row) => row?.name === binding.vectorizeIndex);
    if (matchingIndexes.length !== 1) refuse("RECOVERY_VECTORIZE_RESOURCE_AMBIGUOUS");
    const indexConfig = matchingIndexes[0]?.config || matchingIndexes[0] || {};
    if (Number(indexConfig.dimensions) !== 768 || String(indexConfig.metric).toLowerCase() !== "cosine") {
      refuse("RECOVERY_VECTORIZE_CONTRACT_MISMATCH");
    }
    const info = await vectorInfo(binding);
    if (info.dimensions !== 768) refuse("RECOVERY_VECTORIZE_CONTRACT_MISMATCH");

    const deployment = await wranglerJson(binding, [
      "deployments", "status", "--name", binding.workerName, "--json",
    ]);
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment) ||
        !Array.isArray(deployment.versions) || deployment.versions.length !== 1 ||
        Number(deployment.versions[0]?.percentage) !== 100) {
      refuse("RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS");
    }
    const versionId = exactString(
      deployment.versions[0]?.version_id,
      "RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS",
    );
    if (role === "source") {
      await inspectWorkerVersion(binding, role, versionId);
      return Object.freeze({ vectorCount: info.vectorCount, workerVersionId: versionId });
    }
    const deployedMode = versionId === pins.isolation.pausedWorkerVersionId
      ? "paused"
      : versionId === pins.isolation.activeWorkerVersionId
        ? "active"
        : null;
    if (!deployedMode || (targetMode !== "either" && targetMode !== deployedMode)) {
      refuse("RECOVERY_TARGET_EXECUTION_CHANGED");
    }
    await assertReviewedTargetVersions(binding);
    return Object.freeze({
      vectorCount: info.vectorCount,
      workerVersionId: versionId,
      targetMode: deployedMode,
    });
  }

  async function remoteMigrationContract(binding) {
    const rows = await d1Rows(binding, MIGRATION_CONTRACT_SQL);
    return validateMigrationContract(rows);
  }

  async function requireCurrentVectorProtocol(
    binding,
    code = "RECOVERY_TARGET_UPGRADE_REQUIRED",
  ) {
    const migrations = await remoteMigrationContract(binding);
    if (migrations.at(-1)?.version !== RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION) {
      // The current Worker requires the schema-13 generation, lease,
      // async-visibility, and durable bulk-bootstrap protocol. A historical
      // exact-prefix artifact remains
      // inspectable offline, but the field runner has no implicit live-upgrade
      // authority and therefore stops before export, restore, or provider I/O.
      refuse(code);
    }
    return migrations;
  }

  async function remoteDatabaseSnapshot(binding, { verifyFtsIntegrity = false } = {}) {
    const quickRows = await d1Rows(binding, QUICK_CHECK_SQL);
    const quick = quickRows?.[0];
    // FTS5 exposes integrity-check through a special INSERT command. Run it on
    // the disposable target only; source inspection remains SELECT-only.
    if (verifyFtsIntegrity) await d1Rows(binding, FTS_INTEGRITY_SQL);
    const migrationRows = await d1Rows(binding, MIGRATION_CONTRACT_SQL);
    const checkedMigrations = validateMigrationContract(migrationRows);
    assertExpectedTables(await d1Rows(binding, TABLE_INVENTORY_SQL), checkedMigrations);
    const schemaRows = normalizeSchemaRows(await d1Rows(binding, LOGICAL_SCHEMA_SQL));
    const aggregateRows = await d1Rows(binding, AGGREGATE_SQL);
    if (aggregateRows.length !== 1) refuse("RECOVERY_AGGREGATE_INVALID");
    return snapshotEvidence({
      quickCheck: String(quick?.quick_check ?? quick?.integrity_check ?? ""),
      migrations: checkedMigrations,
      schemaRows,
      aggregate: normalizeAggregate(aggregateRows[0]),
    });
  }

  async function targetUserTableCount() {
    const rows = await d1Rows(pins.binding.target, USER_TABLE_COUNT_SQL);
    if (rows.length !== 1) refuse("RECOVERY_TARGET_CLEAN_CHECK_INVALID");
    return nonNegativeInteger(rows[0]?.user_table_count, "RECOVERY_TARGET_CLEAN_CHECK_INVALID");
  }

  async function targetOutbox() {
    const rows = await d1Rows(pins.binding.target, OUTBOX_SQL);
    if (rows.length !== 1) refuse("RECOVERY_OUTBOX_RESPONSE_INVALID");
    return Object.freeze({
      pending_outbox: nonNegativeInteger(rows[0]?.pending_outbox, "RECOVERY_OUTBOX_RESPONSE_INVALID"),
      failed_vectors: nonNegativeInteger(rows[0]?.failed_vectors, "RECOVERY_OUTBOX_RESPONSE_INVALID"),
    });
  }

  function artifactEvidence() {
    return hashStableArtifact(pins.artifactPath, plan.artifact.max_single_import_bytes);
  }

  async function remoteDataFingerprint(binding) {
    const path = join(pins.artifacts.path, ".brain-recovery-export.sql.tmp-readback");
    removeKnownPartial(path, pins.artifacts.path);
    let normalizedInstallState = null;
    try {
      const migrations = await remoteMigrationContract(binding);
      normalizedInstallState = await normalizedInstallStateExport(binding, migrations, d1Rows);
      await wrangler(binding, [
        "d1", "export", binding.databaseName,
        "--remote", "--no-schema", "--output", path,
        ...RECOVERY_EXPORT_TABLES.flatMap((table) => ["--table", table]),
      ]);
      if (process.platform !== "win32") chmodSync(path, 0o600);
      return hashNormalizedDataExport(
        normalizedInstallState,
        path,
        plan.artifact.max_single_import_bytes,
      );
    } finally {
      if (normalizedInstallState) normalizedInstallState.fill(0);
      removeKnownPartial(path, pins.artifacts.path);
    }
  }

  async function targetDatabaseSnapshot() {
    const snapshot = await remoteDatabaseSnapshot(pins.binding.target, {
      verifyFtsIntegrity: true,
    });
    return Object.freeze({
      ...snapshot,
      content_fingerprint: await remoteDataFingerprint(pins.binding.target),
    });
  }

  function assertContext(context, stage) {
    if (!operationApproved) refuse("RECOVERY_FIELD_GATE_APPROVAL_MISMATCH");
    if (context?.stage !== stage || context?.planFingerprint !== plan.plan_fingerprint ||
        context?.targetResourceFingerprint !== plan.target_resource_fingerprint) {
      refuse("RECOVERY_ADAPTER_CONTEXT_INVALID");
    }
    return true;
  }

  function completedEvidence(context, stage) {
    return context.completed?.find((entry) => entry.id === stage)?.evidence ?? null;
  }

  function combineExport(
    migrations,
    normalizedInstallState,
    dataPartial,
    combinedPartial,
    dataFingerprint,
  ) {
    let output;
    let input;
    try {
      output = openSync(
        combinedPartial,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      writeSync(output, Buffer.from(
        "-- Financial Brain verified recovery artifact.\n" +
        `-- Durable-data-sha256: ${dataFingerprint}\n` +
        "-- Checked-in applied migrations recreate schema and derived FTS.\n\n",
        "utf8",
      ));
      for (const migration of migrations) {
        const bytes = Buffer.from(`${migration.sql.trim()}\n\n`, "utf8");
        writeSync(output, bytes);
        bytes.fill(0);
      }
      writeSync(output, normalizedInstallState);
      const checkedData = assertArtifactFile(dataPartial, {
        maxBytes: plan.artifact.max_single_import_bytes,
        allowEmpty: true,
      });
      input = openSync(dataPartial, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const openedData = fstatSync(input);
      if (!sameFile(checkedData.info, openedData)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      const copiedDataHash = createHash("sha256").update(normalizedInstallState);
      const block = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = readSync(input, block, 0, block.length, null);
        if (!read) break;
        copiedDataHash.update(block.subarray(0, read));
        writeSync(output, block, 0, read);
      }
      block.fill(0);
      const afterDataDescriptor = fstatSync(input);
      const afterDataPath = lstatSync(dataPartial);
      if (!sameFile(openedData, afterDataDescriptor) || !sameFile(openedData, afterDataPath) ||
          copiedDataHash.digest("hex") !== dataFingerprint) {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      fsyncSync(output);
      fchmodSync(output, 0o600);
    } catch (error) {
      if (error instanceof CloudflareRecoveryAdapterError) throw error;
      refuse("RECOVERY_EXPORT_ASSEMBLY_FAILED");
    } finally {
      if (input !== undefined) closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }

  async function withTargetKey(operation) {
    revalidate();
    const key = readAdminKey(pins.targetAdminLocator);
    if (typeof key !== "string" || !key || key.length > 4096 || /[\r\n\0]/.test(key)) {
      refuse("RECOVERY_TARGET_KEYCHAIN_VALUE_INVALID");
    }
    try { return await operation(key); } finally { revalidate(); }
  }

  async function targetHealth(expectedMode) {
    const response = await exactFetch(
      fetchImpl,
      dataPlaneBase(pins.binding.target),
      "/health",
      { method: "GET" },
      60_000,
    );
    if (!response.ok) refuse("RECOVERY_HEALTH_FAILED");
    const health = await boundedJsonResponse(response);
    if (health?.ok !== true || health?.version !== pins.binding.target.productVersion ||
        health?.brain !== pins.binding.target.clientSlug ||
        health?.vector_writer_protocol !== "lease-v1" ||
        health?.vector_drain_mode !== expectedMode) {
      refuse("RECOVERY_HEALTH_IDENTITY_MISMATCH");
    }
    return health;
  }

  async function targetVectorInventory(key, expectedVectors, code) {
    const response = await exactFetch(
      fetchImpl,
      dataPlaneBase(pins.binding.target),
      "/api/admin/brain/documents",
      { method: "GET", headers: { "X-Admin-Key": key } },
    );
    if (!response.ok) refuse(code);
    return validateExactVectorInventory(
      await boundedJsonResponse(response),
      expectedVectors,
      code,
    );
  }

  async function drivePausedBootstrap(key, expectedTotal) {
    const startedAt = nonNegativeInteger(now(), "RECOVERY_BOOTSTRAP_CLOCK_INVALID");
    let previous = null;
    let previousRemaining = expectedTotal;
    for (let round = 0; round < MAX_BOOTSTRAP_ROUNDS; round++) {
      const currentTime = nonNegativeInteger(now(), "RECOVERY_BOOTSTRAP_CLOCK_INVALID");
      if (currentTime < startedAt || currentTime - startedAt > MAX_BOOTSTRAP_DURATION_MS) {
        refuse("RECOVERY_BOOTSTRAP_LIMIT_REACHED");
      }
      const response = await exactFetch(
        fetchImpl,
        dataPlaneBase(pins.binding.target),
        "/api/admin/brain/bootstrap",
        {
          method: "POST",
          headers: { "X-Admin-Key": key },
        },
      );
      if (response.status === 409) {
        const busy = validateBootstrapBusyReceipt(
          await boundedJsonResponse(response),
          previousRemaining,
        );
        previousRemaining = busy.remaining;
        const waitMs = busy.retryAfterSeconds * 1_000;
        if (currentTime + waitMs - startedAt > MAX_BOOTSTRAP_DURATION_MS) {
          refuse("RECOVERY_BOOTSTRAP_LIMIT_REACHED");
        }
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) refuse("RECOVERY_DATA_PLANE_WRITE_FAILED");
      const receipt = validateBootstrapProgress(
        previous,
        validateBootstrapReceipt(await boundedJsonResponse(response), expectedTotal),
      );
      previous = receipt;
      previousRemaining = receipt.remaining;
      if (receipt.complete) return receipt;
      await sleep(BOOTSTRAP_POLL_MS);
    }
    refuse("RECOVERY_BOOTSTRAP_LIMIT_REACHED");
  }

  async function exactTargetVectorCount(expectedVectors) {
    let count = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      count = (await vectorInfo(pins.binding.target)).vectorCount;
      if (count === expectedVectors) return count;
      if (count > expectedVectors) refuse("RECOVERY_VECTORIZE_COUNT_MISMATCH");
      await sleep(5_000);
    }
    refuse("RECOVERY_VECTORIZE_COUNT_MISMATCH");
  }

  async function promoteReviewedActiveWorker() {
    await wrangler(pins.binding.target, [
      "versions", "deploy", `${pins.isolation.activeWorkerVersionId}@100%`,
      "--name", pins.binding.target.workerName, "-y",
    ]);
  }

  const adapters = {
    export_d1: async (context) => {
      assertContext(context, "export_d1");
      await assertExactCloudflareResources(pins.binding.source, "source");
      const migrations = await requireCurrentVectorProtocol(
        pins.binding.source,
        "RECOVERY_SOURCE_UPGRADE_REQUIRED",
      );
      assertExpectedTables(await d1Rows(pins.binding.source, TABLE_INVENTORY_SQL), migrations);
      const dataPartial = join(pins.artifacts.path, ".brain-recovery-export.sql.tmp-data");
      const combinedPartial = join(pins.artifacts.path, ".brain-recovery-export.sql.tmp-combined");
      if (reconcileExportResidue(
        pins.artifactPath,
        dataPartial,
        combinedPartial,
        pins.artifacts.path,
        plan.artifact.max_single_import_bytes,
      )) return artifactEvidence();
      let normalizedInstallState = null;
      try {
        normalizedInstallState = await normalizedInstallStateExport(
          pins.binding.source,
          migrations,
          d1Rows,
        );
        await wrangler(pins.binding.source, [
          "d1", "export", pins.binding.source.databaseName,
          "--remote", "--no-schema", "--output", dataPartial,
          ...RECOVERY_EXPORT_TABLES.flatMap((table) => ["--table", table]),
        ]);
        if (process.platform !== "win32") chmodSync(dataPartial, 0o600);
        assertArtifactFile(dataPartial, { maxBytes: plan.artifact.max_single_import_bytes, allowEmpty: true });
        const dataFingerprint = hashNormalizedDataExport(
          normalizedInstallState,
          dataPartial,
          plan.artifact.max_single_import_bytes,
        );
        combineExport(
          migrations,
          normalizedInstallState,
          dataPartial,
          combinedPartial,
          dataFingerprint,
        );
        const combined = assertArtifactFile(combinedPartial, {
          maxBytes: plan.artifact.max_single_import_bytes,
        });
        try { linkSync(combined.path, pins.artifactPath); } catch {
          refuse("RECOVERY_EXPORT_ARTIFACT_APPEARED");
        }
        unlinkSync(combinedPartial);
        unlinkSync(dataPartial);
        syncDirectory(pins.artifacts.path);
        return artifactEvidence();
      } catch (error) {
        try { removeKnownPartial(dataPartial, pins.artifacts.path); } catch { /* original fixed failure wins */ }
        try { removeKnownPartial(combinedPartial, pins.artifacts.path); } catch { /* original fixed failure wins */ }
        throw error;
      } finally {
        if (normalizedInstallState) normalizedInstallState.fill(0);
      }
    },

    verify_export: async (context) => {
      assertContext(context, "verify_export");
      const exported = completedEvidence(context, "export_d1");
      const artifact = artifactEvidence();
      if (artifact.artifact_sha256 !== exported?.artifact_sha256 ||
          artifact.artifact_bytes !== exported?.artifact_bytes) {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      await assertExactCloudflareResources(pins.binding.source, "source");
      await remoteMigrationContract(pins.binding.source);
      const local = await verifySqlArtifact(pins.artifactPath, {
        maxBytes: plan.artifact.max_single_import_bytes,
      });
      const remote = await remoteDatabaseSnapshot(pins.binding.source);
      assertSameStructuralSnapshot(local, remote, "RECOVERY_EXPORT_SOURCE_MISMATCH");
      return Object.freeze({
        ...artifact,
        ...local,
        content_fingerprint: recoveryArtifactDataFingerprint(
          pins.artifactPath,
          plan.artifact.max_single_import_bytes,
        ),
      });
    },

    prove_target_clean: async (context) => {
      assertContext(context, "prove_target_clean");
      const resources = await assertExactCloudflareResources(pins.binding.target, "target", "paused");
      await targetHealth("paused-for-upgrade");
      const userTableCount = await targetUserTableCount();
      return Object.freeze({
        target_resource_fingerprint: plan.target_resource_fingerprint,
        user_table_count: userTableCount,
        vector_count: resources.vectorCount,
        vector_dimensions: 768,
        vector_metric: "cosine",
      });
    },

    restore_d1: async (context) => {
      assertContext(context, "restore_d1");
      const artifact = artifactEvidence();
      const exported = completedEvidence(context, "verify_export");
      if (artifact.artifact_sha256 !== exported?.artifact_sha256 ||
          artifact.artifact_bytes !== exported?.artifact_bytes) {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      const resources = await assertExactCloudflareResources(pins.binding.target, "target", "paused");
      await targetHealth("paused-for-upgrade");
      const tables = await targetUserTableCount();
      if (tables > 0) {
        // A populated target is reconcilable only after this exact stage had an
        // ambiguous prior attempt. On attempt one it changed outside the gate.
        if (context.attempt === 1) refuse("RECOVERY_TARGET_IMPORT_AMBIGUOUS");
        const existing = await targetDatabaseSnapshot();
        assertSameSnapshot(existing, exported, "RECOVERY_TARGET_IMPORT_AMBIGUOUS");
        return Object.freeze({ artifact_sha256: artifact.artifact_sha256, import_completed: true });
      }
      if (resources.vectorCount !== 0) refuse("RECOVERY_TARGET_IMPORT_AMBIGUOUS");
      try {
        await wrangler(pins.binding.target, [
          "d1", "execute", pins.binding.target.databaseName,
          "--remote", "--file", pins.artifactPath, "--yes",
        ]);
      } catch (error) {
        try {
          const reconciled = await targetDatabaseSnapshot();
          assertSameSnapshot(reconciled, exported, "RECOVERY_TARGET_IMPORT_AMBIGUOUS");
          return Object.freeze({ artifact_sha256: artifact.artifact_sha256, import_completed: true });
        } catch {
          throw error;
        }
      }
      const restored = await targetDatabaseSnapshot();
      assertSameSnapshot(restored, exported, "RECOVERY_TARGET_IMPORT_MISMATCH");
      return Object.freeze({ artifact_sha256: artifact.artifact_sha256, import_completed: true });
    },

    verify_d1: async (context) => {
      assertContext(context, "verify_d1");
      await assertExactCloudflareResources(pins.binding.target, "target", "paused");
      await targetHealth("paused-for-upgrade");
      await requireCurrentVectorProtocol(pins.binding.target);
      const restored = await targetDatabaseSnapshot();
      return restored;
    },

    rebuild_vectorize: async (context) => {
      assertContext(context, "rebuild_vectorize");
      // Recheck on every resumed rebuild. An old journal checkpoint or an
      // out-of-band target replacement must never route schema-prefix data to
      // the current bulk bootstrap endpoint.
      await requireCurrentVectorProtocol(pins.binding.target);
      const restored = completedEvidence(context, "verify_d1");
      assertSameRecoveryCorpus(
        await targetDatabaseSnapshot(),
        restored,
        "RECOVERY_TARGET_CHANGED_BEFORE_REINDEX",
      );
      const initialOutbox = await targetOutbox();
      if (context.attempt === 1 &&
          (initialOutbox.pending_outbox !== 0 || initialOutbox.failed_vectors !== 0)) {
        refuse("RECOVERY_VECTORIZE_TARGET_AMBIGUOUS");
      }
      const resources = await assertExactCloudflareResources(pins.binding.target, "target", "either");
      if (context.attempt === 1 && resources.targetMode !== "paused") {
        refuse("RECOVERY_TARGET_EXECUTION_CHANGED");
      }
      if (resources.vectorCount > restored.chunk_count) refuse("RECOVERY_VECTORIZE_TARGET_AMBIGUOUS");
      if (context.attempt === 1 && resources.vectorCount !== 0) {
        refuse("RECOVERY_VECTORIZE_TARGET_AMBIGUOUS");
      }

      if (resources.targetMode === "paused") {
        await targetHealth("paused-for-upgrade");
        await withTargetKey(async (key) => {
          // The verified artifact already normalizes a nonempty corpus to one
          // bootstrap epoch with its exact SQL high-water. Never call reindex
          // here: resetting the epoch on a retry would discard durable cursor
          // and provider-receipt progress.
          await drivePausedBootstrap(key, restored.chunk_count);
          await targetVectorInventory(
            key,
            restored.chunk_count,
            "RECOVERY_VECTORIZE_NOT_READY",
          );
        });
        const pausedOutbox = await targetOutbox();
        if (pausedOutbox.pending_outbox !== 0 || pausedOutbox.failed_vectors !== 0) {
          refuse("RECOVERY_VECTORIZE_NOT_READY");
        }
        await exactTargetVectorCount(restored.chunk_count);
        // Bootstrap may only mutate projection receipts and the derived index.
        // Re-prove the restored corpus immediately before active code becomes
        // reachable so a compromised or drifting paused Worker cannot smuggle
        // a D1 content change through a vector-complete receipt.
        assertSameRecoveryCorpus(
          await targetDatabaseSnapshot(),
          restored,
          "RECOVERY_TARGET_CHANGED_DURING_REINDEX",
        );
        await assertExactCloudflareResources(pins.binding.target, "target", "paused");
        await targetHealth("paused-for-upgrade");
        // Both immutable versions and every binding were proven above. This is
        // the only state-changing Worker command the adapter permits. If the
        // command succeeds remotely but its response is lost, the next stage
        // attempt reconciles the already-active version from exact evidence.
        await promoteReviewedActiveWorker();
      }

      await assertExactCloudflareResources(pins.binding.target, "target", "active");
      await targetHealth("active");
      await withTargetKey((key) => targetVectorInventory(
        key,
        restored.chunk_count,
        "RECOVERY_VECTORIZE_NOT_READY",
      ));
      const outbox = await targetOutbox();
      if (outbox.pending_outbox !== 0 || outbox.failed_vectors !== 0) {
        refuse("RECOVERY_VECTORIZE_NOT_READY");
      }
      const vectors = await exactTargetVectorCount(restored.chunk_count);
      assertSameRecoveryCorpus(
        await targetDatabaseSnapshot(),
        restored,
        "RECOVERY_TARGET_CHANGED_DURING_REINDEX",
      );
      return Object.freeze({
        chunk_count: restored.chunk_count,
        vector_count: vectors,
        pending_outbox: outbox.pending_outbox,
        failed_vectors: outbox.failed_vectors,
      });
    },

    verify_health: async (context) => {
      assertContext(context, "verify_health");
      await assertExactCloudflareResources(pins.binding.target, "target", "active");
      const base = dataPlaneBase(pins.binding.target);
      await targetHealth("active");
      const rebuilt = completedEvidence(context, "rebuild_vectorize");
      const expectedVectors = nonNegativeInteger(
        rebuilt?.chunk_count,
        "RECOVERY_HEALTH_FAILED",
      );
      await withTargetKey(async (key) => {
        await targetVectorInventory(key, expectedVectors, "RECOVERY_HEALTH_FAILED");
        const noKey = await exactFetch(fetchImpl, base, "/api/rag/unified", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: "recovery authorization probe", limit: 1 }),
        });
        if (noKey.status !== 401) refuse("RECOVERY_AUTHORIZATION_FAILED");
        const wrongKey = await exactFetch(fetchImpl, base, "/api/rag/unified", {
          method: "POST",
          headers: {
            "X-Admin-Key": "recovery-field-gate-invalid-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: "recovery authorization probe", limit: 1 }),
        });
        if (wrongKey.status !== 401) refuse("RECOVERY_AUTHORIZATION_FAILED");
      });
      return Object.freeze({ status: "pass", failure_count: 0, vector_backlog: 0 });
    },

    verify_eval: async (context) => {
      assertContext(context, "verify_eval");
      revalidate();
      await assertExactCloudflareResources(pins.binding.target, "target", "active");
      await targetHealth("active");
      const key = readAdminKey(pins.targetAdminLocator);
      if (typeof key !== "string" || !key || key.length > 4096 || /[\r\n\0]/.test(key)) {
        refuse("RECOVERY_TARGET_KEYCHAIN_VALUE_INVALID");
      }
      const input = Buffer.from(`${key}\n`, "utf8");
      try {
        const result = await runEval({
          args: [
            EVAL_RUNNER,
            "--base", dataPlaneBase(pins.binding.target),
            "--golden", pins.golden.path,
            "--profile", "release",
          ],
          env: evalChildEnvironment(config.environment),
          input,
          cwd: ROOT,
          timeoutMs: MAX_EVAL_TIMEOUT_MS,
        });
        if (result?.status !== 0 || result?.signal || result?.error) {
          refuse("RECOVERY_RELEASE_EVAL_FAILED");
        }
        // A long private evaluation cannot inherit its success across an
        // out-of-band deployment. Prove the exact active version and protocol
        // again before checkpointing the release result.
        await assertExactCloudflareResources(pins.binding.target, "target", "active");
        await targetHealth("active");
      } finally {
        input.fill(0);
        revalidate();
      }
      return Object.freeze({
        profile: "release",
        status: "pass",
        critical_failures: 0,
        unauthorized_retrievals: 0,
      });
    },
  };

  return Object.freeze({
    adapters: Object.freeze(adapters),
    revalidate,
    targetExecutionApprovalFingerprint: pins.isolation.approvalFingerprint,
    wrapperApprovalFingerprint: pins.wrapper.hash,
    goldenApprovalFingerprint: pins.golden.hash,
    acquireLock: () => acquireFieldGateLock(pins.artifacts.path, plan.plan_fingerprint),
    releaseLock: (lock) => releaseFieldGateLock(lock, pins.artifacts.path),
  });
}

function normalizeFieldGateConfig(input) {
  const required = [
    "sourceManifestPath", "targetManifestPath", "planPath", "statePath",
    "artifactDirectory", "wranglerWrapperPath", "goldenPath",
  ];
  if (!input || required.some((key) => typeof input[key] !== "string" || !input[key])) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  return Object.freeze(Object.fromEntries(required.map((key) => [key, resolve(input[key])])));
}

/** Local-only preview. No wrapper, Keychain, or network operation is invoked. */
export function previewCloudflareRecoveryFieldGate(configInput, dependencies = {}) {
  const config = normalizeFieldGateConfig(configInput);
  const plan = loadVerifiedRecoveryPlan(config.planPath);
  const state = loadVerifiedRecoveryState(config.statePath, plan);
  const gate = createCloudflareRecoveryFieldGateAdapters({ ...config, plan }, {
    ...dependencies,
    platform: dependencies.platform ?? process.platform,
  });
  const status = verifiedRecoveryStatus(plan, state);
  return Object.freeze({
    mode: "disposable_cloudflare_recovery_field_gate",
    ready_for_explicit_approval: true,
    plan_fingerprint: plan.plan_fingerprint,
    target_approval_fingerprint: plan.target_resource_fingerprint,
    target_execution_approval_fingerprint: gate.targetExecutionApprovalFingerprint,
    source_export_blocking_approval_fingerprint: plan.source_resource_fingerprint,
    wrapper_approval_fingerprint: gate.wrapperApprovalFingerprint,
    golden_approval_fingerprint: gate.goldenApprovalFingerprint,
    status: status.status,
    current_stage: status.current_stage,
    completed_stages: status.completed_stages,
    total_stages: status.total_stages,
  });
}

/** Execute or resume the approved disposable field gate. */
export async function runCloudflareRecoveryFieldGate(configInput, dependencies = {}) {
  const config = normalizeFieldGateConfig(configInput);
  const stopAfterStage = normalizeStopAfterStage(configInput.stopAfterStage);
  const plan = loadVerifiedRecoveryPlan(config.planPath);
  const state = loadVerifiedRecoveryState(config.statePath, plan);
  if (configInput.approvePlan !== plan.plan_fingerprint ||
      configInput.approveDisposableTarget !== plan.target_resource_fingerprint ||
      configInput.approveSourceExportBlocking !== plan.source_resource_fingerprint) {
    refuse("RECOVERY_FIELD_GATE_APPROVAL_MISMATCH");
  }
  const gate = createCloudflareRecoveryFieldGateAdapters({
    ...config,
    plan,
    approvePlan: configInput.approvePlan,
    approveDisposableTarget: configInput.approveDisposableTarget,
    approveTargetExecution: configInput.approveTargetExecution,
    approveSourceExportBlocking: configInput.approveSourceExportBlocking,
    approveWrapper: configInput.approveWrapper,
    approveGolden: configInput.approveGolden,
  }, dependencies);
  if (configInput.approveTargetExecution !== gate.targetExecutionApprovalFingerprint ||
      configInput.approveWrapper !== gate.wrapperApprovalFingerprint ||
      configInput.approveGolden !== gate.goldenApprovalFingerprint) {
    refuse("RECOVERY_FIELD_GATE_APPROVAL_MISMATCH");
  }
  const lock = gate.acquireLock();
  let result;
  let releaseError = null;
  try {
    result = await runVerifiedRecovery(plan, state, gate.adapters, {
      revalidateManifests: async (fingerprint) => {
        if (fingerprint !== plan.plan_fingerprint) refuse("RECOVERY_FIELD_GATE_PLAN_CHANGED");
        return gate.revalidate();
      },
      persistState: async (next) => writeVerifiedRecoveryState(config.statePath, next, plan),
      ...(stopAfterStage ? {
        afterStageCheckpoint: async (stage) => {
          if (stage === stopAfterStage) {
            refuse("RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION");
          }
        },
      } : {}),
      ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    });
  } finally {
    try { gate.releaseLock(lock); } catch (error) { releaseError = error; }
  }
  if (releaseError) throw releaseError;
  return Object.freeze({ ...result, status: verifiedRecoveryStatus(plan, result.state) });
}

const CLI_VALUE_FLAGS = Object.freeze(new Set([
  "source-manifest", "target-manifest", "plan", "state", "artifact-directory",
  "wrangler-wrapper", "golden", "approve-plan", "approve-disposable-target",
  "approve-target-execution", "approve-source-export-blocking", "approve-wrapper",
  "approve-golden",
  "stop-after-stage",
]));

export function parseCloudflareRecoveryCliArguments(argv) {
  if (!Array.isArray(argv) || !["preview", "run"].includes(argv[0])) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/.test(flag || "") || !CLI_VALUE_FLAGS.has(flag.slice(2)) ||
        typeof value !== "string" || !value || value.startsWith("--") ||
        Object.hasOwn(values, flag.slice(2))) {
      refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
    }
    values[flag.slice(2)] = value;
  }
  const required = [
    "source-manifest", "target-manifest", "plan", "state", "artifact-directory",
    "wrangler-wrapper", "golden",
    ...(command === "run" ? [
      "approve-plan", "approve-disposable-target", "approve-target-execution",
      "approve-source-export-blocking", "approve-wrapper", "approve-golden",
    ] : []),
  ];
  const allowed = [
    ...required,
    ...(command === "run" ? ["stop-after-stage"] : []),
  ];
  if (argv.length % 2 !== 1 || required.some((key) => !Object.hasOwn(values, key)) ||
      Object.keys(values).some((key) => !allowed.includes(key))) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  const stopAfterStage = command === "run"
    ? normalizeStopAfterStage(values["stop-after-stage"])
    : null;
  return Object.freeze({
    command,
    sourceManifestPath: values["source-manifest"],
    targetManifestPath: values["target-manifest"],
    planPath: values.plan,
    statePath: values.state,
    artifactDirectory: values["artifact-directory"],
    wranglerWrapperPath: values["wrangler-wrapper"],
    goldenPath: values.golden,
    ...(command === "run" ? {
      approvePlan: values["approve-plan"],
      approveDisposableTarget: values["approve-disposable-target"],
      approveTargetExecution: values["approve-target-execution"],
      approveSourceExportBlocking: values["approve-source-export-blocking"],
      approveWrapper: values["approve-wrapper"],
      approveGolden: values["approve-golden"],
      ...(stopAfterStage ? { stopAfterStage } : {}),
    } : {}),
  });
}

function printUsage() {
  console.log("usage: node operations/cloudflare-recovery-adapter.mjs preview --source-manifest <file> --target-manifest <file> --plan <file> --state <file> --artifact-directory <private-dir> --wrangler-wrapper <owner-only-wrapper> --golden <private-release-suite>");
  console.log("       node operations/cloudflare-recovery-adapter.mjs run <same flags> --approve-plan <fingerprint> --approve-disposable-target <fingerprint> --approve-target-execution <fingerprint> --approve-source-export-blocking <fingerprint> --approve-wrapper <fingerprint> --approve-golden <fingerprint> [--stop-after-stage <export_d1|restore_d1|rebuild_vectorize>]");
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseCloudflareRecoveryCliArguments(argv); } catch {
    printUsage();
    return 1;
  }
  try {
    const result = parsed.command === "preview"
      ? previewCloudflareRecoveryFieldGate(parsed)
      : await runCloudflareRecoveryFieldGate(parsed);
    const output = parsed.command === "run" ? result.status : result;
    console.log(JSON.stringify(output, null, 2));
    return result?.ok === false ? 1 : 0;
  } catch (error) {
    const code = error instanceof CloudflareRecoveryAdapterError
      ? error.code
      : "RECOVERY_FIELD_GATE_PREFLIGHT_FAILED";
    console.error(`Cloudflare recovery field gate stopped: ${code}`);
    return 1;
  }
}

const IS_MAIN = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Cloudflare recovery field gate stopped: RECOVERY_FIELD_GATE_INTERNAL_FAILURE");
    process.exitCode = 1;
  });
}
