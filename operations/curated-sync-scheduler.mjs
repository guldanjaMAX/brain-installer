#!/usr/bin/env node
/**
 * Private unattended wrapper for one exact curated dual-sync plan.
 *
 * Launchd receives only file locators and a configuration hash. The wrapper
 * starts a second copy under macOS lockf, strips ambient credentials, and lets
 * the curated operation resolve both admin keys from the target manifests at
 * execution time. A success receipt and support event contain aggregates only.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordSupportEvent } from "../support-journal.mjs";
import {
  cronToCalendarIntervals,
  expectedRefreshSecondsForCron,
  renderLaunchAgentPlist,
  rotateDriveSchedulerLogs,
  safeIngestEnvironment,
} from "./drive-scheduler.mjs";
import {
  inspectCuratedTargetContracts,
  loadCuratedSyncPlan,
  runCuratedDualSync,
} from "./curated-dual-sync.mjs";

const DEFAULT_SCHEDULER_PATH = fileURLToPath(import.meta.url);
const LOCKF_PATH = "/usr/bin/lockf";
const LSOF_PATH = "/usr/sbin/lsof";
const PS_PATH = "/bin/ps";
const SH_PATH = "/bin/sh";
const TRUE_PATH = "/usr/bin/true";
const LOCK_BUSY_EXIT = 75;
const LOCKF_ABNORMAL_CHILD_EXIT = 70;
const LOCK_CHILD_FD = 3;
const CHILD_FAILURE_JOURNALED_EXIT = 65;
const CHILD_FAILURE_UNJOURNALED_EXIT = 66;
const INTERNAL_EXECUTE_COMMAND = "__execute-held-lock";
const LOCK_BOOTSTRAP = 'exec 3<"$1" || exit 66; shift; exec "$@"';
const LOCK_BOOTSTRAP_NAME = "brain-curated-lock-bootstrap";
const FRESHNESS_SCHEMA_VERSION = 1;
const MAX_FRESHNESS_BYTES = 64 * 1024;
const STALE_GRACE = 1.5;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const SAFE_LOCALE_ENV = new Set([
  "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
]);
const FRESHNESS_KEYS = new Set([
  "schema_version", "completed_at", "config_hash", "corpus_fingerprint", "documents",
  "target_coverage", "historical_raw_drive",
]);
const TARGET_COVERAGE_KEYS = new Set(["cloudflare", "legacy"]);
const HISTORICAL_RAW_DRIVE_KEYS = new Set([
  "checksum_matches", "presence_unverified", "checksum_mismatches", "deletion_eligible",
]);

function fail(message) {
  throw new Error(message);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(info, label) {
  const uid = currentUid();
  if (uid !== null && info.uid !== uid) fail(`${label} is not owned by the current user`);
}

function exactObjectKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("curated scheduler runtime path is not a private directory");
  assertOwned(info, "curated scheduler runtime directory");
  chmodSync(path, 0o700);
}

function preparePrivateLock(path) {
  ensurePrivateDirectory(dirname(path));
  if (existsSync(path)) {
    const prior = lstatSync(path);
    if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1) {
      fail("curated scheduler lock is not a private regular file");
    }
    assertOwned(prior, "curated scheduler lock");
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) fail("curated scheduler lock is not a private regular file");
    assertOwned(info, "curated scheduler lock");
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if (error?.message?.startsWith("curated scheduler")) throw error;
    fail("curated scheduler lock could not be prepared safely");
  }
}

function assertSafeFreshnessDestination(path) {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail("curated scheduler freshness destination is not a private regular file");
  }
  assertOwned(info, "curated scheduler freshness destination");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    fail("curated scheduler freshness destination is not owner-only");
  }
  if (info.size < 2 || info.size > MAX_FRESHNESS_BYTES) {
    fail("curated scheduler freshness destination has an invalid size");
  }
}

function writePrivateFreshness(path, receipt, options = {}) {
  ensurePrivateDirectory(dirname(path));
  assertSafeFreshnessDestination(path);
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  if (bytes.length > MAX_FRESHNESS_BYTES) fail("curated scheduler freshness receipt is too large");
  const suffix = (options.randomBytes ?? randomBytes)(8).toString("hex");
  const temporary = `${path}.tmp-${suffix}`;
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
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const readback = readFileSync(path);
    if (!readback.equals(bytes)) fail("curated scheduler freshness receipt did not read back exactly");
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      fail("curated scheduler freshness receipt is not owner-only");
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
    if (error?.message?.startsWith("curated scheduler")) throw error;
    fail("curated scheduler freshness receipt could not be replaced safely");
  } finally {
    bytes.fill(0);
  }
}

function configurationHash(planPath, plan, schedulerPath, targetManifestFingerprints) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    plan_path: planPath,
    scheduler_path: schedulerPath,
    plan,
    target_manifest_fingerprints: targetManifestFingerprints,
  })).digest("hex");
}

/** Build a token-free, exact LaunchAgent definition from the private plan. */
export function buildCuratedSchedulerPlan(planPath, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    fail("curated sync scheduling is currently implemented with macOS LaunchAgents");
  }
  const absolutePlan = resolve(planPath || "");
  const loaded = loadCuratedSyncPlan(absolutePlan, options);
  const scheduler = loaded.plan.scheduler;
  if (!scheduler) fail("curated sync plan needs a scheduler declaration before unattended use");
  const uid = options.uid ?? currentUid();
  if (!Number.isInteger(uid) || uid < 0) fail("could not determine the macOS user id for curated scheduling");
  const home = resolve(options.home ?? homedir());
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const schedulerPath = resolve(options.schedulerPath ?? DEFAULT_SCHEDULER_PATH);
  const targetContracts = inspectCuratedTargetContracts(loaded.plan, {
    ...options,
    planDirectory: loaded.planDirectory,
  });
  const targetManifestFingerprints = Object.freeze({
    legacy: targetContracts.legacy.manifestFingerprint,
    cloudflare: targetContracts.cloudflare.manifestFingerprint,
  });
  const label = `com.brain-installer.${scheduler.slug}.curated-sync`;
  const runtimeDir = join(home, ".brain");
  const logsDir = join(runtimeDir, "logs");
  const stateDir = join(runtimeDir, "state");
  const locksDir = join(runtimeDir, "locks");
  const intervals = cronToCalendarIntervals(scheduler.cron);
  const expectedRefreshSeconds = expectedRefreshSecondsForCron(scheduler.cron);
  const configHash = configurationHash(
    absolutePlan,
    loaded.plan,
    schedulerPath,
    targetManifestFingerprints,
  );
  const localTimeZone = options.localTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  const warnings = scheduler.timezone && localTimeZone && scheduler.timezone !== localTimeZone
    ? [`LaunchAgent calendar times use this Mac's ${localTimeZone} timezone while the plan says ${scheduler.timezone}`]
    : [];
  const plan = {
    path: absolutePlan,
    curatedPlan: loaded.plan,
    planDirectory: loaded.planDirectory,
    slug: scheduler.slug,
    cron: scheduler.cron,
    timeZone: scheduler.timezone,
    localTimeZone,
    warnings,
    uid,
    home,
    label,
    domain: `gui/${uid}`,
    service: `gui/${uid}/${label}`,
    nodePath,
    schedulerPath,
    intervals,
    expectedRefreshSeconds,
    configHash,
    targetManifestFingerprints,
    logsDir,
    stdoutPath: join(logsDir, `${scheduler.slug}-curated-sync.out.log`),
    stderrPath: join(logsDir, `${scheduler.slug}-curated-sync.err.log`),
    locksDir,
    lockPath: join(locksDir, `${scheduler.slug}-curated-sync.lock`),
    stateDir,
    freshnessPath: join(stateDir, `${scheduler.slug}-curated-sync-success.json`),
  };
  plan.programArguments = [
    nodePath,
    schedulerPath,
    "run",
    absolutePlan,
    "--config-hash",
    configHash,
  ];
  return Object.freeze(plan);
}

export function renderCuratedLaunchAgentPlist(plan) {
  return renderLaunchAgentPlist(plan);
}

export function safeCuratedSchedulerEnvironment(environment = process.env) {
  const clean = safeIngestEnvironment(environment);
  delete clean.BRAIN_DEBUG;
  delete clean.BRAIN_GOOGLE_TOKEN_STORE;
  // The shared Drive scheduler accepts LC_* broadly. This wrapper has a
  // stricter no-ambient-credential contract, so retain only POSIX locale names
  // and refuse secret-shaped custom variables hiding behind that prefix.
  for (const name of Object.keys(clean)) {
    if (name.startsWith("LC_") && !SAFE_LOCALE_ENV.has(name)) delete clean[name];
  }
  return clean;
}

function lockProofEnvironment() {
  return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateLockIdentity(info, label) {
  const bigint = typeof info.nlink === "bigint";
  if (!info.isFile() || info.nlink !== (bigint ? 1n : 1)) {
    fail(`${label} is not a private regular file`);
  }
  const uid = currentUid();
  if (uid !== null && info.uid !== (bigint ? BigInt(uid) : uid)) {
    fail(`${label} is not owned by the current user`);
  }
  const unsafeMode = bigint ? (info.mode & 0o077n) !== 0n : (info.mode & 0o077) !== 0;
  if (process.platform !== "win32" && unsafeMode) {
    fail(`${label} is not owner-only`);
  }
}

function defaultLockParentExecutable(options = {}, expectedLock) {
  const parentPid = options.parentPid ?? process.ppid;
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
    fail("curated scheduler could not verify its lockf parent");
  }
  const result = spawnSync(
    PS_PATH,
    ["-p", String(parentPid), "-o", "comm="],
    {
      encoding: "utf8",
      env: lockProofEnvironment(),
      maxBuffer: 4 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    },
  );
  if (result?.error || result?.status !== 0) {
    fail("curated scheduler could not verify its lockf parent");
  }
  if (String(result.stdout ?? "").trim() !== LOCKF_PATH) {
    return String(result.stdout ?? "").trim();
  }

  // The lockf parent must still hold fd 3 on this exact inode. Asking lsof for
  // field output without `n` avoids reading or retaining any path string.
  const descriptor = spawnSync(
    LSOF_PATH,
    ["-a", "-p", String(parentPid), "-d", String(LOCK_CHILD_FD), "-F", "pftDi"],
    {
      encoding: "utf8",
      env: lockProofEnvironment(),
      maxBuffer: 4 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    },
  );
  const fields = String(descriptor.stdout ?? "").split(/\r?\n/).filter(Boolean);
  const device = fields.find((line) => line.startsWith("D"))?.slice(1);
  const inode = fields.find((line) => line.startsWith("i"))?.slice(1);
  let deviceNumber;
  let inodeNumber;
  try {
    deviceNumber = BigInt(device ?? "");
    inodeNumber = BigInt(inode ?? "");
  } catch {
    fail("curated scheduler could not verify the lockf parent descriptor");
  }
  if (descriptor?.error || descriptor?.status !== 0 ||
      !fields.includes(`p${parentPid}`) || !fields.includes(`f${LOCK_CHILD_FD}`) ||
      !fields.includes("tREG") || deviceNumber !== expectedLock?.dev ||
      inodeNumber !== expectedLock?.ino) {
    fail("curated scheduler could not verify the lockf parent descriptor");
  }
  return LOCKF_PATH;
}

function defaultLockContentionProbe(descriptor) {
  return spawnSync(
    LOCKF_PATH,
    ["-k", "-s", "-t", "0", `/dev/fd/${LOCK_CHILD_FD}`, TRUE_PATH],
    {
      env: lockProofEnvironment(),
      shell: false,
      stdio: ["ignore", "ignore", "ignore", descriptor],
      timeout: 5_000,
    },
  );
}

/**
 * Prove the internal execute child is below native lockf and fd 3 still names
 * the exact reviewed lock. Merely opening the file is insufficient: a second
 * independent descriptor must observe active contention before credentials
 * or a target network call become reachable.
 */
export function assertInheritedCuratedSchedulerLock(plan, options = {}) {
  const descriptor = options.lockDescriptor ?? LOCK_CHILD_FD;
  let inherited;
  let named;
  try {
    inherited = fstatSync(descriptor, { bigint: true });
    named = lstatSync(plan.lockPath, { bigint: true });
  } catch {
    fail("curated scheduler execute requires its inherited lock descriptor");
  }
  assertPrivateLockIdentity(inherited, "curated scheduler inherited lock");
  if (named.isSymbolicLink()) fail("curated scheduler lock path changed before execution");
  assertPrivateLockIdentity(named, "curated scheduler lock path");
  if (!sameFileIdentity(inherited, named)) {
    fail("curated scheduler inherited lock does not match its reviewed path");
  }

  const inspectParent = options.inspectLockParent ?? defaultLockParentExecutable;
  if (inspectParent(options, inherited) !== LOCKF_PATH) {
    fail("curated scheduler execute is not running below the required lockf parent");
  }

  let probeDescriptor;
  let result;
  try {
    probeDescriptor = openSync(
      plan.lockPath,
      fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0),
    );
    const probeInfo = fstatSync(probeDescriptor, { bigint: true });
    if (!sameFileIdentity(inherited, probeInfo)) {
      fail("curated scheduler lock path changed during verification");
    }
    const probe = options.probeLockContention ?? defaultLockContentionProbe;
    result = probe(probeDescriptor, options);
  } catch (error) {
    if (error?.message?.startsWith("curated scheduler")) throw error;
    fail("curated scheduler could not verify its active lock");
  } finally {
    if (probeDescriptor !== undefined) {
      try { closeSync(probeDescriptor); } catch { /* best effort */ }
    }
  }
  if (result?.error || result?.status !== LOCK_BUSY_EXIT || result?.signal) {
    fail("curated scheduler execute does not hold the expected active lock");
  }

  let after;
  try { after = lstatSync(plan.lockPath, { bigint: true }); } catch {
    fail("curated scheduler lock path changed during verification");
  }
  if (after.isSymbolicLink() || !sameFileIdentity(inherited, after)) {
    fail("curated scheduler lock path changed during verification");
  }
  assertPrivateLockIdentity(after, "curated scheduler lock path");
}

function assertExpectedConfiguration(plan, expected) {
  if (!/^[0-9a-f]{64}$/.test(String(expected ?? ""))) {
    fail("curated scheduling requires its exact prepared configuration hash before credentials may be read");
  }
  if (expected !== plan.configHash) {
    fail("curated sync plan changed after this LaunchAgent was prepared; review and reinstall it before credentials may be read");
  }
}

function successReceipt(plan, report, now = new Date()) {
  return {
    schema_version: FRESHNESS_SCHEMA_VERSION,
    completed_at: now.toISOString(),
    config_hash: plan.configHash,
    corpus_fingerprint: report.corpusFingerprint,
    documents: report.count,
    target_coverage: {
      cloudflare: report.targetCoverage.cloudflare_confirmed.total,
      legacy: report.targetCoverage.legacy_confirmed.total,
    },
    historical_raw_drive: {
      checksum_matches: report.rawDriveHistoricalChecksumMatches.total,
      presence_unverified: report.rawDriveHistoricalPresenceUnverified.total,
      checksum_mismatches: report.rawDriveHistoricalChecksumMismatches.total,
      deletion_eligible: false,
    },
  };
}

function validateFreshnessReceipt(value, now) {
  if (!exactObjectKeys(value, FRESHNESS_KEYS) ||
      value.schema_version !== FRESHNESS_SCHEMA_VERSION ||
      !/^[0-9a-f]{64}$/.test(String(value.config_hash ?? "")) ||
      !/^[0-9a-f]{64}$/.test(String(value.corpus_fingerprint ?? "")) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(value.completed_at ?? "")) ||
      !Number.isSafeInteger(value.documents) || value.documents < 1 ||
      !exactObjectKeys(value.target_coverage, TARGET_COVERAGE_KEYS) ||
      !exactObjectKeys(value.historical_raw_drive, HISTORICAL_RAW_DRIVE_KEYS)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const completed = new Date(value.completed_at);
  if (!Number.isFinite(completed.getTime()) || completed.toISOString() !== value.completed_at) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { ok: false, reason: "invalid_clock" };
  }
  if (completed.getTime() - now.getTime() > MAX_FUTURE_SKEW_SECONDS * 1000) {
    return { ok: false, reason: "future_timestamp" };
  }
  const coverage = value.target_coverage;
  if (!nonNegativeInteger(coverage.cloudflare) || !nonNegativeInteger(coverage.legacy) ||
      coverage.cloudflare !== value.documents || coverage.legacy !== value.documents) {
    return { ok: false, reason: "invalid_coverage" };
  }
  const historical = value.historical_raw_drive;
  if (!nonNegativeInteger(historical.checksum_matches) ||
      !nonNegativeInteger(historical.presence_unverified) ||
      !nonNegativeInteger(historical.checksum_mismatches) ||
      historical.deletion_eligible !== false ||
      historical.checksum_matches + historical.presence_unverified +
        historical.checksum_mismatches > value.documents) {
    return { ok: false, reason: "invalid_historical_aggregate" };
  }
  return {
    ok: true,
    value: Object.freeze({
      schema_version: value.schema_version,
      completed_at: value.completed_at,
      config_hash: value.config_hash,
      corpus_fingerprint: value.corpus_fingerprint,
      documents: value.documents,
      target_coverage: Object.freeze({
        cloudflare: coverage.cloudflare,
        legacy: coverage.legacy,
      }),
      historical_raw_drive: Object.freeze({
        checksum_matches: historical.checksum_matches,
        presence_unverified: historical.presence_unverified,
        checksum_mismatches: historical.checksum_mismatches,
        deletion_eligible: false,
      }),
    }),
  };
}

/** Execute inside the already-held lock and advance freshness only on full dual confirmation. */
export async function executeScheduledCuratedSync(planPath, options = {}) {
  const plan = buildCuratedSchedulerPlan(planPath, options);
  assertExpectedConfiguration(plan, options.expectedConfigHash);
  assertInheritedCuratedSchedulerLock(plan, options);
  const runner = options.runSync ?? runCuratedDualSync;
  const report = await runner(plan.curatedPlan, {
    mode: "sync",
    planDirectory: plan.planDirectory,
    planPath: plan.path,
    expectedTargetFingerprints: plan.targetManifestFingerprints,
  });
  if (!report?.ok) fail("curated scheduled sync did not confirm every required target");
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const receipt = successReceipt(plan, report, now);
  (options.writeFreshness ?? writePrivateFreshness)(plan.freshnessPath, receipt, options);
  return { ...plan, status: "complete", code: 0, receipt };
}

/** Acquire a nonblocking advisory lock without placing any credential in argv or env. */
export function runScheduledCuratedSync(planPath, options = {}) {
  const plan = buildCuratedSchedulerPlan(planPath, options);
  assertExpectedConfiguration(plan, options.expectedConfigHash);
  ensurePrivateDirectory(join(plan.home, ".brain"));
  ensurePrivateDirectory(plan.logsDir);
  const lockDescriptor = preparePrivateLock(plan.lockPath);
  const spawn = options.spawn ?? spawnSync;
  let result;
  try {
    // macOS lockf keeps the advisory lock in its waiting parent and closes
    // extra descriptors before it launches the command. A static shell shim
    // therefore reopens the non-secret lock path read-only as fd 3 before
    // execing Node. The child proves that fd, the current path, and the inode
    // under active contention are still identical before touching credentials.
    result = spawn(
      LOCKF_PATH,
      [
        "-k", "-s", "-t", "0", `/dev/fd/${LOCK_CHILD_FD}`,
        SH_PATH, "-c", LOCK_BOOTSTRAP, LOCK_BOOTSTRAP_NAME,
        plan.lockPath,
        plan.nodePath, plan.schedulerPath, INTERNAL_EXECUTE_COMMAND, plan.path,
        "--config-hash", plan.configHash,
      ],
      {
        cwd: plan.planDirectory,
        env: safeCuratedSchedulerEnvironment(options.env ?? process.env),
        stdio: ["ignore", "inherit", "inherit", lockDescriptor],
      },
    );
  } finally {
    closeSync(lockDescriptor);
  }
  if (result?.error) throw result.error;
  if (result?.status === LOCK_BUSY_EXIT) {
    return { ...plan, status: "skipped", code: 0, reason: "curated sync is already running" };
  }
  (options.rotateLogs ?? rotateDriveSchedulerLogs)(plan, options);
  // macOS lockf does not surface the command's signal through spawnSync. It
  // exits EX_SOFTWARE (70) with result.signal === null when the locked child
  // was signaled or stopped. Preserve that distinction for issue journaling.
  const childAbnormallyTerminated = result?.status === LOCKF_ABNORMAL_CHILD_EXIT;
  const childJournaled = result?.status === CHILD_FAILURE_JOURNALED_EXIT;
  return {
    ...plan,
    status: result?.status === 0 ? "complete" : "failed",
    code: Number.isInteger(result?.status) ? result.status : 1,
    signal: result?.signal ?? null,
    childAbnormallyTerminated,
    childJournaled,
  };
}

function readFreshness(plan, now) {
  if (!existsSync(plan.freshnessPath)) return { status: "missing", stale: true };
  try {
    assertSafeFreshnessDestination(plan.freshnessPath);
    const checked = validateFreshnessReceipt(
      JSON.parse(readFileSync(plan.freshnessPath, "utf8")),
      now,
    );
    if (!checked.ok) {
      return { status: "invalid", stale: true, reason: checked.reason };
    }
    const value = checked.value;
    if (value.config_hash === plan.configHash &&
        value.documents !== plan.curatedPlan.expectedDocuments) {
      return { status: "invalid", stale: true, reason: "document_count_mismatch" };
    }
    return value.config_hash === plan.configHash
      ? { status: "observed", value }
      : { status: "configuration_changed", stale: true, value };
  } catch {
    return { status: "invalid", stale: true };
  }
}

export function statusScheduledCuratedSync(planPath, options = {}) {
  const plan = buildCuratedSchedulerPlan(planPath, options);
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const observed = readFreshness(plan, now);
  if (observed.status !== "observed") return { ...plan, freshness: observed };
  const completed = new Date(observed.value.completed_at);
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - completed.getTime()) / 1000));
  const staleAfterSeconds = Math.ceil(plan.expectedRefreshSeconds * STALE_GRACE);
  return {
    ...plan,
    freshness: {
      status: "observed",
      completedAt: observed.value.completed_at,
      ageSeconds,
      staleAfterSeconds,
      stale: !Number.isFinite(completed.getTime()) || ageSeconds > staleAfterSeconds,
      documents: observed.value.documents,
      targetCoverage: observed.value.target_coverage,
    },
  };
}

export function recordCuratedSchedulerFailure(options = {}) {
  try {
    const event = recordSupportEvent({
      command: "schedule",
      source: "scheduler",
      errorCode: "SCHEDULE_RUN_FAILED",
      productRelativeLocation: "operations/curated-sync-scheduler.mjs#main",
    }, options.journalOptions ?? {});
    return event.event_id;
  } catch {
    return null;
  }
}

/**
 * A caught execute failure exits with a dedicated child-journaled code. Every
 * other failed wrapper result is parent-owned, including command exec failure,
 * runtime startup failure, and abnormal termination before the child journal.
 */
export function recordCuratedSchedulerResult(result, options = {}) {
  if (!result || result.childJournaled) return null;
  if (result.status !== "failed" && !result.signal && !result.childAbnormallyTerminated) return null;
  return recordCuratedSchedulerFailure(options);
}

function printSupportReceipt(eventId) {
  if (!eventId) return;
  console.error(`Private issue note ${eventId} was saved locally. Nothing was uploaded or sent.`);
  console.error("Review the exact safe record with: brain support --preview");
}

export function parseCuratedSchedulerCliArguments(argv) {
  if (!Array.isArray(argv)) fail("curated scheduler arguments are invalid");
  const [rawCommand, planPath, flag, configHash, ...extra] = argv;
  if (!new Set(["run", INTERNAL_EXECUTE_COMMAND, "status"]).has(rawCommand) ||
      typeof planPath !== "string" || !planPath || planPath.startsWith("--") ||
      extra.length) {
    fail("curated scheduler arguments are invalid");
  }
  const command = rawCommand === INTERNAL_EXECUTE_COMMAND ? "execute" : rawCommand;
  if (command === "status") {
    if (argv.length !== 2) fail("curated scheduler arguments are invalid");
    return Object.freeze({ command, planPath, expectedConfigHash: undefined });
  }
  if (argv.length !== 4 || flag !== "--config-hash" ||
      !/^[0-9a-f]{64}$/.test(String(configHash ?? ""))) {
    fail("curated scheduler run and execute require one exact configuration hash");
  }
  return Object.freeze({ command, planPath, expectedConfigHash: configHash });
}

function statusSummary(result) {
  return {
    label: result.label,
    cron: result.cron,
    expected_refresh_seconds: result.expectedRefreshSeconds,
    freshness: result.freshness,
    warnings: result.warnings,
  };
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCuratedSchedulerCliArguments(argv);
  } catch {
    console.log("usage: node operations/curated-sync-scheduler.mjs status <private-plan>");
    console.log("       node operations/curated-sync-scheduler.mjs run <private-plan> --config-hash <sha256>");
    return 1;
  }
  const { command, planPath, expectedConfigHash } = parsed;
  if (command === "execute") {
    try {
      const result = await executeScheduledCuratedSync(planPath, { expectedConfigHash });
      console.log(`[${new Date().toISOString()}] curated sync ${result.status}`);
      return result.code;
    } catch (error) {
      console.error(`Curated scheduler failed: ${String(error?.message || "unknown failure")}`);
      const eventId = recordCuratedSchedulerFailure();
      printSupportReceipt(eventId);
      return eventId ? CHILD_FAILURE_JOURNALED_EXIT : CHILD_FAILURE_UNJOURNALED_EXIT;
    }
  }
  if (command === "run") {
    const result = runScheduledCuratedSync(planPath, { expectedConfigHash });
    console.log(`[${new Date().toISOString()}] ${result.reason ?? `curated sync ${result.status}`}`);
    printSupportReceipt(recordCuratedSchedulerResult(result));
    return result.code;
  }
  console.log(JSON.stringify(statusSummary(statusScheduledCuratedSync(planPath)), null, 2));
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === resolve(DEFAULT_SCHEDULER_PATH);
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Curated scheduler failed: ${String(error?.message || "unknown failure")}`);
    printSupportReceipt(recordCuratedSchedulerFailure());
    process.exitCode = 1;
  });
}
