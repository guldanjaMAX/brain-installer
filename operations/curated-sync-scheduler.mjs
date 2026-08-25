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
const LOCK_BUSY_EXIT = 75;
const LOCKF_ABNORMAL_CHILD_EXIT = 70;
const LOCK_CHILD_FD = 3;
const FRESHNESS_SCHEMA_VERSION = 1;
const MAX_FRESHNESS_BYTES = 64 * 1024;
const STALE_GRACE = 1.5;
const SAFE_LOCALE_ENV = new Set([
  "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
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

/** Execute inside the already-held lock and advance freshness only on full dual confirmation. */
export async function executeScheduledCuratedSync(planPath, options = {}) {
  const plan = buildCuratedSchedulerPlan(planPath, options);
  assertExpectedConfiguration(plan, options.expectedConfigHash);
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
    // lockf accepts /dev/fd/N and locks that already-open descriptor. Passing
    // the validated owner-only file as fd 3 removes the path reopen between
    // our no-follow checks and lock acquisition.
    result = spawn(
      LOCKF_PATH,
      [
        "-k", "-s", "-t", "0", `/dev/fd/${LOCK_CHILD_FD}`,
        plan.nodePath, plan.schedulerPath, "execute", plan.path,
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
  return {
    ...plan,
    status: result?.status === 0 ? "complete" : "failed",
    code: Number.isInteger(result?.status) ? result.status : 1,
    signal: result?.signal ?? null,
    childAbnormallyTerminated,
  };
}

function readFreshness(plan) {
  if (!existsSync(plan.freshnessPath)) return { status: "missing", stale: true };
  try {
    assertSafeFreshnessDestination(plan.freshnessPath);
    const value = JSON.parse(readFileSync(plan.freshnessPath, "utf8"));
    if (value?.schema_version !== FRESHNESS_SCHEMA_VERSION ||
        !/^[0-9a-f]{64}$/.test(String(value?.config_hash ?? "")) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(value?.completed_at ?? ""))) {
      return { status: "invalid", stale: true };
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
  const observed = readFreshness(plan);
  if (observed.status !== "observed") return { ...plan, freshness: observed };
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
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

/** Normal child failures journal themselves; only abnormal termination is ours. */
export function recordCuratedSchedulerResult(result, options = {}) {
  if (!result?.signal && !result?.childAbnormallyTerminated) return null;
  return recordCuratedSchedulerFailure(options);
}

function printSupportReceipt(eventId) {
  if (!eventId) return;
  console.error(`Private issue note ${eventId} was saved locally. Nothing was uploaded or sent.`);
  console.error("Review the exact safe record with: brain support --preview");
}

export function parseCuratedSchedulerCliArguments(argv) {
  if (!Array.isArray(argv)) fail("curated scheduler arguments are invalid");
  const [command, planPath, flag, configHash, ...extra] = argv;
  if (!new Set(["run", "execute", "status"]).has(command) ||
      typeof planPath !== "string" || !planPath || planPath.startsWith("--") ||
      extra.length) {
    fail("curated scheduler arguments are invalid");
  }
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
    console.log("       node operations/curated-sync-scheduler.mjs <run|execute> <private-plan> --config-hash <sha256>");
    return 1;
  }
  const { command, planPath, expectedConfigHash } = parsed;
  if (command === "execute") {
    const result = await executeScheduledCuratedSync(planPath, { expectedConfigHash });
    console.log(`[${new Date().toISOString()}] curated sync ${result.status}`);
    return result.code;
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
