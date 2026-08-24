#!/usr/bin/env node
/**
 * Unattended Google Drive ingest for macOS.
 *
 * A LaunchAgent is machine-local product infrastructure, not a James-specific
 * artifact. Its label and paths are derived from the client slug, while the
 * schedule comes from operations.ingest_cron in that client's manifest.
 *
 * The plist deliberately contains no credentials. The child uses the normal
 * Google token store and brain's normal resolveAdminKey behavior. Cloudflare
 * deployment credentials are removed from the child environment because an
 * ingest against a configured brain.domain does not need them.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { recordSupportEvent } from "../support-journal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BRAIN_PATH = resolve(HERE, "..", "brain.mjs");
const DEFAULT_SCHEDULER_PATH = fileURLToPath(import.meta.url);
const MAX_CALENDAR_INTERVALS = 512;
const LOCKF_PATH = "/usr/bin/lockf";
const LOCK_BUSY_EXIT = 75; // EX_TEMPFAIL from sysexits(3)

/**
 * Launchd appends to StandardOutPath and StandardErrorPath forever. Five MiB is
 * enough to retain a long failure without allowing an unattended install to
 * consume the owner's disk. Two exact history files keep a useful audit trail
 * while making the upper bound obvious: after each retention pass, at most
 * 15 MiB per stream, and normally less because the active file is truncated
 * after a large run.
 */
export const DRIVE_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DRIVE_LOG_HISTORY_FILES = 2;

export const CLOUDFLARE_CREDENTIAL_ENV = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_USER_SERVICE_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "WRANGLER_R2_SQL_AUTH_TOKEN",
]);

const CRON_FIELDS = Object.freeze([
  { name: "minute", launchd: "Minute", min: 0, max: 59 },
  { name: "hour", launchd: "Hour", min: 0, max: 23 },
  { name: "day of month", launchd: "Day", min: 1, max: 31 },
  { name: "month", launchd: "Month", min: 1, max: 12 },
  { name: "weekday", launchd: "Weekday", min: 0, max: 7, normalize: (n) => n === 7 ? 0 : n, cardinality: 7 },
]);

function integer(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`invalid ${label} "${value}" in ingest cron`);
  return Number(value);
}

function expandCronField(text, spec) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error(`missing ${spec.name} in ingest cron`);
  const values = new Set();

  for (const segment of raw.split(",")) {
    const pieces = segment.split("/");
    if (pieces.length > 2) throw new Error(`invalid ${spec.name} "${segment}" in ingest cron`);
    const base = pieces[0];
    const step = pieces.length === 2 ? integer(pieces[1], `${spec.name} step`) : 1;
    if (step < 1) throw new Error(`${spec.name} step must be at least 1 in ingest cron`);

    let start;
    let end;
    if (base === "*") {
      start = spec.min;
      end = spec.max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error(`invalid ${spec.name} range "${base}" in ingest cron`);
      start = integer(range[0], spec.name);
      end = integer(range[1], spec.name);
    } else {
      start = integer(base, spec.name);
      end = pieces.length === 2 ? spec.max : start;
    }

    if (start < spec.min || start > spec.max || end < spec.min || end > spec.max || start > end) {
      throw new Error(`${spec.name} "${base}" is outside ${spec.min}-${spec.max} in ingest cron`);
    }
    for (let n = start; n <= end; n += step) values.add(spec.normalize ? spec.normalize(n) : n);
  }

  const ordered = [...values].sort((a, b) => a - b);
  const cardinality = spec.cardinality || spec.max - spec.min + 1;
  return {
    ...spec,
    // Cron's day-of-month/weekday OR rule depends on whether the field was
    // written as a star, not merely whether its expansion covers every value.
    cronWildcard: raw.startsWith("*"),
    fullDomain: ordered.length === cardinality,
    values: ordered,
  };
}

function cartesianCalendar(fields) {
  let intervals = [{}];
  for (const field of fields) {
    if (field.fullDomain) continue;
    if (intervals.length * field.values.length > MAX_CALENDAR_INTERVALS) {
      throw new Error(
        `ingest cron expands to more than ${MAX_CALENDAR_INTERVALS} launchd calendar entries; use a simpler schedule`
      );
    }
    intervals = intervals.flatMap((entry) => field.values.map((value) => ({ ...entry, [field.launchd]: value })));
  }
  return intervals;
}

/**
 * Translate a five-field cron expression into launchd StartCalendarInterval
 * dictionaries. Lists, ranges and steps are supported. Cron's special OR rule
 * for restricted day-of-month plus weekday is preserved by emitting a union.
 */
export function cronToCalendarIntervals(expression) {
  const pieces = String(expression || "").trim().split(/\s+/).filter(Boolean);
  if (pieces.length !== 5) {
    throw new Error(`operations.ingest_cron must be a five-field cron expression, received "${expression || ""}"`);
  }
  const fields = pieces.map((part, index) => expandCronField(part, CRON_FIELDS[index]));
  const [minute, hour, day, month, weekday] = fields;

  let intervals;
  if (!day.cronWildcard && !weekday.cronWildcard) {
    // Traditional cron fires when EITHER syntactically restricted day field
    // matches. Expressing the two branches separately avoids a day-by-weekday
    // cartesian expansion while preserving that OR behavior.
    intervals = [
      ...cartesianCalendar([minute, hour, day, month]),
      ...cartesianCalendar([minute, hour, month, weekday]),
    ];
  } else {
    intervals = cartesianCalendar(fields);
  }

  const seen = new Set();
  const unique = intervals.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > MAX_CALENDAR_INTERVALS) {
    throw new Error(
      `ingest cron expands to more than ${MAX_CALENDAR_INTERVALS} launchd calendar entries; use a simpler schedule`
    );
  }
  return unique;
}

/**
 * Return the longest nominal gap between firings of a five-field cron.
 *
 * Freshness must not use the shortest or average interval. A weekday-only job,
 * for example, has a three-day Friday-to-Monday gap that is still on schedule.
 * We evaluate one complete 400-year Gregorian cycle, whose dates and weekdays
 * repeat exactly, so month lengths, leap years and cron's day-of-month/weekday
 * OR rule are all represented without guessing.
 *
 * The value is expressed in nominal calendar seconds. DST can move a local
 * firing by one hour, which is already inside freshness's separate 1.5x grace.
 */
export function expectedRefreshSecondsForCron(expression) {
  // Keep the freshness calculator inside the same accepted cron contract as
  // the LaunchAgent renderer, including its expansion-size safety limit.
  cronToCalendarIntervals(expression);
  const pieces = String(expression || "").trim().split(/\s+/).filter(Boolean);
  const [minute, hour, day, month, weekday] = pieces.map((part, index) =>
    expandCronField(part, CRON_FIELDS[index])
  );

  const minuteValues = new Set(minute.values);
  const hourValues = new Set(hour.values);
  const dayValues = new Set(day.values);
  const monthValues = new Set(month.values);
  const weekdayValues = new Set(weekday.values);
  const times = [];
  for (let h = 0; h < 24; h++) {
    if (!hourValues.has(h)) continue;
    for (let m = 0; m < 60; m++) {
      if (minuteValues.has(m)) times.push((h * 60 + m) * 60);
    }
  }

  const DAY_SECONDS = 86_400;
  const CYCLE_DAYS = 146_097; // 400 Gregorian years, exactly divisible by 7.
  const cycleStart = Date.UTC(2000, 0, 1);
  const firstTime = times[0];
  const lastTime = times[times.length - 1];
  let firstOccurrence = null;
  let previousLast = null;
  let lastOccurrence = null;
  let maximum = 0;

  for (let i = 1; i < times.length; i++) {
    maximum = Math.max(maximum, times[i] - times[i - 1]);
  }

  for (let dayIndex = 0; dayIndex < CYCLE_DAYS; dayIndex++) {
    const date = new Date(cycleStart + dayIndex * DAY_SECONDS * 1000);
    if (!monthValues.has(date.getUTCMonth() + 1)) continue;
    const domMatches = dayValues.has(date.getUTCDate());
    const dowMatches = weekdayValues.has(date.getUTCDay());
    const calendarDayMatches = !day.cronWildcard && !weekday.cronWildcard
      ? domMatches || dowMatches
      : domMatches && dowMatches;
    if (!calendarDayMatches) continue;

    const dayFirst = dayIndex * DAY_SECONDS + firstTime;
    const dayLast = dayIndex * DAY_SECONDS + lastTime;
    if (firstOccurrence === null) firstOccurrence = dayFirst;
    if (previousLast !== null) maximum = Math.max(maximum, dayFirst - previousLast);
    previousLast = dayLast;
    lastOccurrence = dayLast;
  }

  if (firstOccurrence === null || lastOccurrence === null) {
    throw new Error(`operations.ingest_cron "${expression || ""}" has no valid calendar firing`);
  }
  maximum = Math.max(maximum, CYCLE_DAYS * DAY_SECONDS + firstOccurrence - lastOccurrence);
  return maximum;
}

function readManifest(manifestPath, read = readFileSync) {
  const path = resolve(manifestPath || "");
  let manifest;
  try {
    manifest = JSON.parse(read(path, "utf-8"));
  } catch (error) {
    throw new Error(`could not read manifest at ${path}: ${error.message}`);
  }
  return { path, manifest };
}

function clientSlugOf(manifest) {
  const slug = String(manifest?.client?.slug || "");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    throw new Error("the manifest needs a valid client.slug before a Drive scheduler can be installed");
  }
  return slug;
}

function assertMac(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error(
      `unattended Drive scheduling is currently implemented with macOS LaunchAgents; this machine reports ${platform}`
    );
  }
}

export function schedulerIdentity(manifestPath, options = {}) {
  const { path, manifest } = readManifest(manifestPath, options.readFile);
  const slug = clientSlugOf(manifest);
  const home = resolve(options.home || homedir());
  const label = `com.brain-installer.${slug}.drive-ingest`;
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const runtimeDir = join(home, ".brain");
  return {
    path,
    manifest,
    slug,
    home,
    label,
    plistPath: join(launchAgentsDir, `${label}.plist`),
    logsDir: join(runtimeDir, "logs"),
    stdoutPath: join(runtimeDir, "logs", `${slug}-drive-ingest.out.log`),
    stderrPath: join(runtimeDir, "logs", `${slug}-drive-ingest.err.log`),
    locksDir: join(runtimeDir, "locks"),
    lockPath: join(runtimeDir, "locks", `${slug}-drive-ingest.lock`),
  };
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function currentUserId() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertCurrentUserOwner(st, path, description) {
  const uid = currentUserId();
  if (uid !== null && st.uid !== uid) {
    throw new Error(`${description} is not owned by the current user: ${path}`);
  }
}

function assertPrivateDirectory(path) {
  if (!lstatIfPresent(path)) mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`scheduler runtime path is not a private directory: ${path}`);
  }
  assertCurrentUserOwner(st, path, "scheduler runtime directory");
  chmodSync(path, 0o700);
}

function assertHomeDirectory(path) {
  if (!lstatIfPresent(path)) mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`scheduler home path is not a real directory: ${path}`);
  }
  assertCurrentUserOwner(st, path, "scheduler home directory");
}

function noFollowFlag() {
  // O_NOFOLLOW is available on the target platform (macOS). The lstat checks
  // retain the same behavior on test platforms that do not expose the flag.
  return fsConstants.O_NOFOLLOW || 0;
}

function assertRegularLogPath(path, { allowMissing = true } = {}) {
  const st = lstatIfPresent(path);
  if (!st) {
    if (allowMissing) return null;
    throw new Error(`scheduler log does not exist: ${path}`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to follow a symbolic link at scheduler log path: ${path}`);
  }
  if (!st.isFile()) {
    throw new Error(`scheduler log path is not a regular file: ${path}`);
  }
  assertCurrentUserOwner(st, path, "scheduler log file");
  if (currentUserId() !== null && st.nlink !== 1) {
    throw new Error(`refusing a scheduler log path with multiple hard links: ${path}`);
  }
  return st;
}

function assertOpenedRegularLog(fd, path) {
  const st = fstatSync(fd);
  if (!st.isFile()) {
    throw new Error(`scheduler log path is not a regular file: ${path}`);
  }
  assertCurrentUserOwner(st, path, "scheduler log file");
  if (currentUserId() !== null && st.nlink !== 1) {
    throw new Error(`refusing a scheduler log path with multiple hard links: ${path}`);
  }
  return st;
}

function assertRegularLockPath(path, { allowMissing = true } = {}) {
  const st = lstatIfPresent(path);
  if (!st) {
    if (allowMissing) return null;
    throw new Error(`scheduler lock does not exist: ${path}`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to follow a symbolic link at scheduler lock path: ${path}`);
  }
  if (!st.isFile()) {
    throw new Error(`scheduler lock path is not a regular file: ${path}`);
  }
  assertCurrentUserOwner(st, path, "scheduler lock file");
  if (currentUserId() !== null && st.nlink !== 1) {
    throw new Error(`refusing a scheduler lock path with multiple hard links: ${path}`);
  }
  return st;
}

function preparePrivateLockFile(path) {
  assertRegularLockPath(path);
  let fd;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollowFlag(),
      0o600
    );
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`scheduler lock path is not a regular file: ${path}`);
    }
    assertCurrentUserOwner(st, path, "scheduler lock file");
    if (currentUserId() !== null && st.nlink !== 1) {
      throw new Error(`refusing a scheduler lock path with multiple hard links: ${path}`);
    }
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`refusing to follow a symbolic link at scheduler lock path: ${path}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSchedulerLockDirectory(plan) {
  const runtimeDir = dirname(plan.locksDir);
  if (resolve(runtimeDir) !== resolve(plan.home, ".brain") ||
      resolve(plan.locksDir) !== resolve(runtimeDir, "locks") ||
      resolve(dirname(plan.lockPath)) !== resolve(plan.locksDir)) {
    throw new Error("scheduler lock paths must stay inside the per-user .brain runtime directory");
  }
  assertHomeDirectory(plan.home);
  assertPrivateDirectory(runtimeDir);
  assertPrivateDirectory(plan.locksDir);
}

function openPrivateLog(path, flags) {
  assertRegularLogPath(path);
  let fd;
  try {
    fd = openSync(path, flags | noFollowFlag(), 0o600);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`refusing to follow a symbolic link at scheduler log path: ${path}`);
    }
    throw error;
  }
  try {
    const st = assertOpenedRegularLog(fd, path);
    fchmodSync(fd, 0o600);
    return { fd, st };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function privateHistoryPaths(path, historyFiles) {
  return Array.from({ length: historyFiles }, (_, index) => `${path}.${index + 1}`);
}

function renamePrivateLog(from, to) {
  assertRegularLogPath(from, { allowMissing: false });
  if (assertRegularLogPath(to)) {
    throw new Error(`scheduler log rotation target unexpectedly exists: ${to}`);
  }
  renameSync(from, to);
}

function writePrivateSnapshot(path, bytes) {
  const prior = assertRegularLogPath(path);
  if (prior) unlinkSync(path);
  let fd;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600
    );
    assertOpenedRegularLog(fd, path);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (!count) throw new Error(`scheduler log snapshot could not be written: ${path}`);
      written += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    if (assertRegularLogPath(path)) unlinkSync(path);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function trimPrivateLogTail(path, maxBytes) {
  if (!assertRegularLogPath(path)) return null;
  const opened = openPrivateLog(path, fsConstants.O_RDWR);
  const { fd } = opened;
  if (opened.st.size <= maxBytes) {
    closeSync(fd);
    return opened.st.size;
  }
  const bytes = Buffer.allocUnsafe(maxBytes);
  let read = 0;
  try {
    assertOpenedRegularLog(fd, path);
    while (read < maxBytes) {
      const count = readSync(
        fd,
        bytes,
        read,
        maxBytes - read,
        opened.st.size - maxBytes + read
      );
      if (!count) throw new Error(`scheduler history changed while it was being retained: ${path}`);
      read += count;
    }
    assertOpenedRegularLog(fd, path);
    ftruncateSync(fd, 0);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written);
      if (!count) throw new Error(`scheduler history could not be retained: ${path}`);
      written += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    return maxBytes;
  } finally {
    closeSync(fd);
  }
}

function rotateOneSchedulerLog(path, { maxBytes, historyFiles }) {
  const history = privateHistoryPaths(path, historyFiles);
  for (const historyPath of history) {
    trimPrivateLogTail(historyPath, maxBytes);
  }

  const opened = openPrivateLog(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND
  );
  const { fd } = opened;
  const beforeBytes = opened.st.size;
  if (beforeBytes <= maxBytes) {
    closeSync(fd);
    return { path, rotated: false, beforeBytes, afterBytes: beforeBytes, history };
  }

  const keptBytes = Math.min(beforeBytes, maxBytes);
  const snapshot = Buffer.allocUnsafe(keptBytes);
  const offset = beforeBytes - keptBytes;
  let read = 0;
  try {
    assertOpenedRegularLog(fd, path);
    while (read < keptBytes) {
      const count = readSync(fd, snapshot, read, keptBytes - read, offset + read);
      if (!count) throw new Error(`scheduler log changed while it was being retained: ${path}`);
      read += count;
    }

    // A fixed staging name is deliberate. It prevents a killed rotation from
    // leaving an unbounded family of temp files. Only this exact path is ever
    // removed; no directory scan or glob participates in retention.
    const staged = `${path}.rotate.tmp`;
    writePrivateSnapshot(staged, snapshot);
    try {
      const oldest = history.at(-1);
      if (assertRegularLogPath(oldest)) unlinkSync(oldest);
      for (let index = history.length - 2; index >= 0; index--) {
        if (assertRegularLogPath(history[index])) {
          renamePrivateLog(history[index], history[index + 1]);
        }
      }
      renamePrivateLog(staged, history[0]);
    } catch (error) {
      // The staged path is ours and exact. If it was already renamed, it no
      // longer exists; if history movement failed, remove only this one file.
      if (assertRegularLogPath(staged)) unlinkSync(staged);
      throw error;
    }

    // Launchd opens its log streams in append mode. Truncating the same regular
    // file keeps the already-open descriptor valid, so the current scheduled
    // process and its child continue in the bounded active file.
    assertOpenedRegularLog(fd, path);
    ftruncateSync(fd, 0);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    return { path, rotated: true, beforeBytes, afterBytes: 0, history };
  } finally {
    closeSync(fd);
  }
}

/**
 * Bound both scheduler streams without scanning the directory or following a
 * link. Installation and removal call it while the service is stopped; a
 * lock-owning scheduled run calls it after its ingest child exits.
 */
export function rotateDriveSchedulerLogs(plan, options = {}) {
  const maxBytes = options.logMaxBytes ?? DRIVE_LOG_MAX_BYTES;
  const historyFiles = options.logHistoryFiles ?? DRIVE_LOG_HISTORY_FILES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("scheduler logMaxBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(historyFiles) || historyFiles < 1 || historyFiles > 5) {
    throw new Error("scheduler logHistoryFiles must be an integer from 1 to 5");
  }
  const runtimeDir = dirname(plan.logsDir);
  if (resolve(runtimeDir) !== resolve(plan.home, ".brain") ||
      resolve(plan.logsDir) !== resolve(runtimeDir, "logs") ||
      resolve(dirname(plan.stdoutPath)) !== resolve(plan.logsDir) ||
      resolve(dirname(plan.stderrPath)) !== resolve(plan.logsDir)) {
    throw new Error("scheduler log paths must stay inside the per-user .brain runtime directory");
  }
  assertHomeDirectory(plan.home);
  assertPrivateDirectory(runtimeDir);
  assertPrivateDirectory(plan.logsDir);
  return [plan.stdoutPath, plan.stderrPath].map((path) =>
    rotateOneSchedulerLog(path, { maxBytes, historyFiles })
  );
}

function buildDriveSchedulerReference(manifestPath, options = {}) {
  assertMac(options.platform);
  const identity = schedulerIdentity(manifestPath, options);
  const { manifest } = identity;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isInteger(uid) || uid < 0) throw new Error("could not determine the macOS user id for launchd");

  const nodePath = resolve(options.nodePath || process.execPath);
  const schedulerPath = resolve(options.schedulerPath || DEFAULT_SCHEDULER_PATH);
  const brainPath = resolve(options.brainPath || DEFAULT_BRAIN_PATH);
  const googleTokenStore = String(manifest?.operations?.google_token_store || "auto").toLowerCase();
  const timeZone = manifest?.client?.timezone || null;
  const localTimeZone = options.localTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const warnings = [];
  if (timeZone && localTimeZone && timeZone !== localTimeZone) {
    warnings.push(
      `LaunchAgent calendar times use this Mac's ${localTimeZone} timezone, while the manifest says ${timeZone}`
    );
  }

  return {
    ...identity,
    cron: manifest?.operations?.ingest_cron || null,
    uid,
    domain: `gui/${uid}`,
    service: `gui/${uid}/${identity.label}`,
    nodePath,
    schedulerPath,
    brainPath,
    googleTokenStore,
    timeZone,
    localTimeZone,
    warnings,
  };
}

function validateDriveSchedulerReference(reference) {
  if (reference.manifest?.corpora?.google_drive?.enabled !== true) {
    throw new Error("corpora.google_drive.enabled must be true before its scheduler can be installed");
  }
  if (typeof reference.cron !== "string" || !reference.cron.trim()) {
    throw new Error("the manifest needs operations.ingest_cron before its Drive scheduler can be installed");
  }
  if (typeof reference.manifest?.brain?.domain !== "string" || !reference.manifest.brain.domain.trim()) {
    throw new Error(
      "brain.domain is required for unattended Drive ingest because the scheduled child intentionally receives no Cloudflare deployment token"
    );
  }
  if (!["auto", "keychain", "file"].includes(reference.googleTokenStore)) {
    throw new Error("operations.google_token_store must be auto, keychain or file");
  }
  const intervals = cronToCalendarIntervals(reference.cron);
  const expectedRefreshSeconds = expectedRefreshSecondsForCron(reference.cron);
  const configHash = createHash("sha256").update(JSON.stringify({
    version: 1,
    slug: reference.slug,
    manifest_path: reference.path,
    brain_path: reference.brainPath,
    domain: reference.manifest.brain.domain,
    ingest_cron: reference.cron,
    admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
    google_token_store: reference.googleTokenStore,
  })).digest("hex");
  return {
    ...reference,
    intervals,
    expectedRefreshSeconds,
    configHash,
    programArguments: [
      reference.nodePath,
      reference.schedulerPath,
      "run",
      reference.path,
      "--brain",
      reference.brainPath,
      "--config-hash",
      configHash,
    ],
  };
}

export function buildDriveSchedulerPlan(manifestPath, options = {}) {
  return validateDriveSchedulerReference(buildDriveSchedulerReference(manifestPath, options));
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderCalendarEntry(entry) {
  const keys = ["Minute", "Hour", "Day", "Month", "Weekday"];
  const body = keys
    .filter((key) => Object.hasOwn(entry, key))
    .map((key) => `      <key>${key}</key><integer>${entry[key]}</integer>`)
    .join("\n");
  return body ? `    <dict>\n${body}\n    </dict>` : "    <dict/>";
}

export function renderLaunchAgentPlist(plan) {
  const args = plan.programArguments.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  const intervals = plan.intervals.map(renderCalendarEntry).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(dirname(plan.path))}</string>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(plan.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(plan.stderrPath)}</string>
</dict>
</plist>
`;
}

function stageAtomicWrite(path, text) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  let pending = true;
  return {
    commit() {
      if (!pending) return;
      renameSync(temp, path);
      pending = false;
    },
    discard() {
      if (!pending) return;
      pending = false;
      try { unlinkSync(temp); } catch {}
    },
  };
}

function atomicWrite(path, text) {
  const staged = stageAtomicWrite(path, text);
  try { staged.commit(); } finally { staged.discard(); }
}

function defaultLaunchctl(args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf-8" });
}

function defaultSecurity(args) {
  return spawnSync("/usr/bin/security", args, { encoding: "utf-8", timeout: 15_000, killSignal: "SIGKILL" });
}

function launchctlError(action, result) {
  const detail = String(result?.stderr || result?.stdout || "unknown launchctl failure").trim();
  return new Error(`${action} failed: ${detail}`);
}

function restorePreviousScheduler(plan, priorPlist, wasLoaded, launchctl) {
  const failures = [];
  try {
    const current = launchctl(["print", plan.service]);
    if (current?.status === 0) {
      const stopped = launchctl(["bootout", plan.service]);
      if (stopped?.status !== 0) failures.push(launchctlError("unloading the failed replacement", stopped).message);
    }
  } catch (error) {
    failures.push(`checking the failed replacement failed: ${error.message}`);
  }
  try {
    if (priorPlist === null) {
      if (existsSync(plan.plistPath)) unlinkSync(plan.plistPath);
    } else {
      atomicWrite(plan.plistPath, priorPlist);
    }
  } catch (error) {
    failures.push(`restoring the previous plist failed: ${error.message}`);
  }
  if (wasLoaded && priorPlist !== null && failures.length === 0) {
    const restored = launchctl(["bootstrap", plan.domain, plan.plistPath]);
    if (restored?.status !== 0) failures.push(launchctlError("reloading the previous Drive scheduler", restored).message);
  }
  return failures;
}

function failedReplacement(action, result, plan, priorPlist, wasLoaded, launchctl) {
  const primary = launchctlError(action, result);
  const rollbackFailures = restorePreviousScheduler(plan, priorPlist, wasLoaded, launchctl);
  if (rollbackFailures.length) {
    throw new Error(`${primary.message}; rollback also failed: ${rollbackFailures.join("; ")}`);
  }
  throw primary;
}

export function installDriveScheduler(manifestPath, options = {}) {
  const plan = buildDriveSchedulerPlan(manifestPath, options);
  const launchctl = options.launchctl || defaultLaunchctl;
  mkdirSync(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
  assertSchedulerLockDirectory(plan);

  const priorPlist = existsSync(plan.plistPath) ? readFileSync(plan.plistPath, "utf-8") : null;
  // Stage and chmod the complete definition before touching a working service.
  // A disk-full or permissions failure therefore cannot unload the old job.
  const stagePlist = options.stagePlist || stageAtomicWrite;
  const staged = stagePlist(plan.plistPath, renderLaunchAgentPlist(plan));
  let priorStatus;
  try {
    priorStatus = launchctl(["print", plan.service]);
  } catch (error) {
    staged.discard();
    throw error;
  }
  if (priorStatus?.error) {
    staged.discard();
    throw launchctlError("checking the existing Drive scheduler", priorStatus);
  }
  const wasLoaded = priorStatus?.status === 0;
  if (wasLoaded && parseLaunchctlStatus(priorStatus.stdout).running) {
    staged.discard();
    throw new Error("Drive ingest is currently running; wait for it to finish before replacing its scheduler");
  }
  try {
    // Prepare and bound the exact files before launchd can open them. Check only
    // after proving an existing job is idle, so a refused replacement does not
    // truncate the log of a run that is still active.
    rotateDriveSchedulerLogs(plan, options);
  } catch (error) {
    staged.discard();
    throw error;
  }
  if (wasLoaded) {
    const stopped = launchctl(["bootout", plan.service]);
    if (stopped?.status !== 0) {
      staged.discard();
      throw launchctlError("stopping the previous Drive scheduler", stopped);
    }
  }

  try {
    staged.commit();
  } catch (error) {
    staged.discard();
    const rollbackFailures = restorePreviousScheduler(plan, priorPlist, wasLoaded, launchctl);
    if (rollbackFailures.length) {
      throw new Error(`writing the staged Drive scheduler failed: ${error.message}; rollback also failed: ${rollbackFailures.join("; ")}`);
    }
    throw new Error(`writing the staged Drive scheduler failed: ${error.message}`);
  }
  const enabled = launchctl(["enable", plan.service]);
  if (enabled?.status !== 0) {
    failedReplacement("enabling the Drive scheduler", enabled, plan, priorPlist, wasLoaded, launchctl);
  }
  const started = launchctl(["bootstrap", plan.domain, plan.plistPath]);
  if (started?.status !== 0) {
    failedReplacement("loading the Drive scheduler", started, plan, priorPlist, wasLoaded, launchctl);
  }

  return { ...plan, installed: true, loaded: true, replaced: priorPlist !== null };
}

function parseLaunchctlStatus(output) {
  const text = String(output || "");
  const state = text.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() || null;
  const pidText = text.match(/\bpid\s*=\s*(\d+)/)?.[1];
  const runsText = text.match(/\bruns\s*=\s*(\d+)/)?.[1];
  const exitText = text.match(/\blast exit code\s*=\s*(-?\d+)/i)?.[1];
  const lastExitCode = exitText === undefined ? null : Number(exitText);
  return {
    state,
    pid: pidText ? Number(pidText) : null,
    running: state === "running",
    runs: runsText ? Number(runsText) : null,
    lastExitCode,
    lastRunSucceeded: lastExitCode === null ? null : lastExitCode === 0,
  };
}

export function statusDriveScheduler(manifestPath, options = {}) {
  const reference = buildDriveSchedulerReference(manifestPath, options);
  const launchctl = options.launchctl || defaultLaunchctl;
  const result = launchctl(["print", reference.service]);
  const loaded = result?.status === 0;
  let scheduleError = null;
  let plan = reference;
  try { plan = validateDriveSchedulerReference(reference); } catch (error) { scheduleError = error.message; }
  const installed = existsSync(plan.plistPath);
  let definitionMatches = false;
  if (installed && !scheduleError) {
    try { definitionMatches = readFileSync(plan.plistPath, "utf-8") === renderLaunchAgentPlist(plan); } catch {}
  }
  return {
    ...plan,
    installed,
    loaded,
    scheduleError,
    definitionMatches,
    definitionDrift: installed && !definitionMatches,
    ...(loaded ? parseLaunchctlStatus(result.stdout) : {
      state: null, pid: null, running: false, runs: null, lastExitCode: null, lastRunSucceeded: null,
    }),
  };
}

export function removeDriveScheduler(manifestPath, options = {}) {
  // Removal must remain reachable after the operator disables Drive or deletes
  // its schedule. Requiring the declaration that they are trying to turn off
  // would strand the already-loaded LaunchAgent.
  const plan = buildDriveSchedulerReference(manifestPath, options);
  const launchctl = options.launchctl || defaultLaunchctl;
  const probe = launchctl(["print", plan.service]);
  const wasLoaded = probe?.status === 0;
  if (wasLoaded) {
    const stopped = launchctl(["bootout", plan.service]);
    if (stopped?.status !== 0) throw launchctlError("stopping the Drive scheduler", stopped);
  }
  // The service is stopped, so cap its final output before preserving the
  // audit trail. Histories stay beside the active logs and are never globbed.
  const retained = rotateDriveSchedulerLogs(plan, options);
  const removed = existsSync(plan.plistPath);
  if (removed) unlinkSync(plan.plistPath);
  return {
    ...plan,
    installed: false,
    loaded: false,
    removed,
    logsPreserved: retained.flatMap((entry) =>
      [entry.path, ...entry.history].filter((path) => lstatIfPresent(path)?.isFile())
    ),
  };
}

const SAFE_INGEST_ENV = new Set([
  "HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "SHELL",
  "BRAIN_DEBUG", "BRAIN_GOOGLE_TOKEN_STORE",
]);

export function safeIngestEnvironment(environment = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(environment || {})) {
    if ((SAFE_INGEST_ENV.has(name) || name.startsWith("LC_")) && value !== undefined) clean[name] = value;
  }
  if (!clean.PATH) clean.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  return clean;
}

/** Parse a non-secret Keychain locator kept in the client manifest. */
export function parseAdminKeySecretReference(reference) {
  const text = String(reference || "");
  const match = text.match(/^keychain:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error("operations.admin_key_secret must use keychain://<service>/<account>");
  }
  let service;
  let account;
  try {
    service = decodeURIComponent(match[1]);
    account = decodeURIComponent(match[2]);
  } catch {
    throw new Error("operations.admin_key_secret contains invalid percent encoding");
  }
  if (!service || !account || /[?#]/.test(service) || /[?#]/.test(account)) {
    throw new Error("operations.admin_key_secret must name a Keychain service and account without a query or fragment");
  }
  return { backend: "keychain", service, account };
}

/**
 * Resolve an optional scheduled-run admin key without mutating process.env.
 * No reference means brain's normal ADMIN_KEY / adjacent-file fallback remains
 * authoritative. The Keychain value is never included in an error message.
 */
export function resolveScheduledAdminKey(manifest, options = {}) {
  const reference = manifest?.operations?.admin_key_secret;
  if (!reference) return null;
  if ((options.platform || process.platform) !== "darwin") {
    throw new Error("keychain:// admin key references require macOS");
  }
  const { service, account } = parseAdminKeySecretReference(reference);
  const runSecurity = options.runSecurity || defaultSecurity;
  const result = runSecurity(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (result?.status !== 0) {
    if (result?.error?.code === "ETIMEDOUT") {
      throw new Error("reading the scheduled admin key from macOS Keychain timed out after 15 seconds");
    }
    throw new Error(
      `could not read the scheduled admin key from macOS Keychain item ${service}/${account}; it may be missing or inaccessible`
    );
  }
  const key = String(result.stdout || "").replace(/[\r\n]+$/, "");
  if (!key) throw new Error("the scheduled admin key Keychain item is empty");
  return key;
}

export function runDriveIngest(manifestPath, options = {}) {
  const plan = buildDriveSchedulerPlan(manifestPath, options);
  if (options.expectedConfigHash && options.expectedConfigHash !== plan.configHash) {
    throw new Error(
      "the manifest's scheduled Drive configuration changed after this LaunchAgent was installed; reinstall the scheduler before it may read credentials"
    );
  }
  const spawn = options.spawn || spawnSync;
  const startedAt = new Date().toISOString();
  assertSchedulerLockDirectory(plan);
  preparePrivateLockFile(plan.lockPath);
  const adminKey = resolveScheduledAdminKey(plan.manifest, {
    platform: options.platform,
    runSecurity: options.runSecurity,
  });
  const sourceEnvironment = options.env || process.env;
  const childEnvironment = safeIngestEnvironment(sourceEnvironment);
  if (plan.googleTokenStore === "auto") delete childEnvironment.BRAIN_GOOGLE_TOKEN_STORE;
  else childEnvironment.BRAIN_GOOGLE_TOKEN_STORE = plan.googleTokenStore;
  const childAdminKey = adminKey || sourceEnvironment.ADMIN_KEY;
  if (childAdminKey) childEnvironment.ADMIN_KEY = childAdminKey;
  const result = spawn(
    LOCKF_PATH,
    ["-k", "-s", "-t", "0", plan.lockPath, plan.nodePath, plan.brainPath, "ingest", plan.path, "--from", "drive"],
    {
      cwd: dirname(plan.path),
      env: childEnvironment,
      stdio: "inherit",
    }
  );
  if (result?.error) throw result.error;
  if (result?.status === LOCK_BUSY_EXIT) {
    // Another process owns the ingest lock and is still writing these files.
    // Leave its active logs untouched; that owner caps them when it exits.
    return { ...plan, status: "skipped", code: 0, reason: "Drive ingest is already running" };
  }
  // The lock-holding child has exited, so no scheduled ingest is writing now.
  // This catches a single unusually noisy parser or network failure immediately.
  rotateDriveSchedulerLogs(plan, options);
  const code = Number.isInteger(result?.status) ? result.status : 1;
  return {
    ...plan,
    status: code === 0 ? "complete" : "failed",
    code,
    signal: result?.signal || null,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function cliSummary(result) {
  const summary = {
    label: result.label,
    manifest: result.path,
    cron: result.cron,
    expected_refresh_seconds: result.expectedRefreshSeconds,
    installed: result.installed,
    loaded: result.loaded,
    running: result.running,
    runs: result.runs,
    last_exit_code: result.lastExitCode,
    last_run_succeeded: result.lastRunSucceeded,
    schedule_error: result.scheduleError,
    definition_matches_manifest: result.definitionMatches,
    definition_drift: result.definitionDrift,
    plist: result.plistPath,
    stdout_log: result.stdoutPath,
    stderr_log: result.stderrPath,
    lock: result.lockPath,
  };
  for (const [key, value] of Object.entries(summary)) if (value === undefined) delete summary[key];
  return summary;
}

/** Record wrapper failures that happen before the child brain CLI can run. */
export function recordDriveSchedulerFailure(_error, { action = "run", journalOptions = {} } = {}) {
  try {
    const event = recordSupportEvent({
      command: "schedule",
      source: "scheduler",
      errorCode: action === "install" ? "SCHEDULE_INSTALL_FAILED" : "SCHEDULE_RUN_FAILED",
      productRelativeLocation: "operations/drive-scheduler.mjs#main",
    }, journalOptions);
    return event.event_id;
  } catch {
    // The journal must never hide or replace the scheduler's actual failure.
    return null;
  }
}

export function recordDriveSchedulerResult(result, options = {}) {
  if (Number(result?.code || 0) === 0 && !result?.signal) return null;
  return recordDriveSchedulerFailure(null, { action: "run", ...options });
}

function printDriveSchedulerSupportReceipt(eventId) {
  if (!eventId) return;
  console.error(`Private issue note ${eventId} was saved locally. Nothing was sent.`);
  console.error("Review the exact safe record with: brain support --preview");
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath] = argv;
  if (!command || !manifestPath || !["install", "status", "remove", "run"].includes(command)) {
    console.log("usage: node operations/drive-scheduler.mjs <install|status|remove|run> <manifest> [--brain <brain.mjs>]");
    return 1;
  }
  const brainPath = optionValue(argv, "--brain") || undefined;
  const expectedConfigHash = optionValue(argv, "--config-hash") || undefined;
  const options = { brainPath, expectedConfigHash };
  if (command === "run") {
    const result = runDriveIngest(manifestPath, options);
    const message = result.reason || `Drive ingest ${result.status}`;
    console.log(`[${new Date().toISOString()}] ${message}`);
    printDriveSchedulerSupportReceipt(recordDriveSchedulerResult(result));
    return result.code;
  }
  const result = command === "install"
    ? installDriveScheduler(manifestPath, options)
    : command === "status"
      ? statusDriveScheduler(manifestPath, options)
      : removeDriveScheduler(manifestPath, options);
  console.log(JSON.stringify(cliSummary(result), null, 2));
  for (const warning of result.warnings || []) console.log(`warning: ${warning}`);
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === DEFAULT_SCHEDULER_PATH;
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Drive scheduler failed: ${error.message}`);
    const eventId = recordDriveSchedulerFailure(error, { action: process.argv[2] });
    printDriveSchedulerSupportReceipt(eventId);
    process.exitCode = 1;
  });
}
