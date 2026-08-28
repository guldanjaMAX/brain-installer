/**
 * Privacy-safe, local support journal for brain-installer.
 *
 * This module deliberately does not accept diagnostic text. A support event is
 * a small classification, not a log record: no messages, stacks, arguments,
 * environment, paths, URLs, remote identifiers, or indexed content can enter
 * the stored schema. The only optional correlation value is derived from a
 * validated product-relative source location.
 *
 * Each event is an immutable private file. Writers never rewrite, lock, or
 * rename another writer's event. After a successful write, best-effort
 * retention may remove only complete, private, older event files while fresh
 * and concurrently written files are left alone.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const SUPPORT_SCHEMA_VERSION = 1;
export const SUPPORT_MAX_EVENTS = 200;
export const SUPPORT_MAX_AGE_DAYS = 30;
export const SUPPORT_MAX_BYTES = 2 * 1024 * 1024;
export const SUPPORT_RETENTION_GRACE_MS = 10 * 60 * 1000;

export const SUPPORT_COMMANDS = Object.freeze([
  "ask",
  "auth",
  "connect",
  "diagnose",
  "deploy",
  "disconnect",
  "doctor",
  "drain",
  "eval",
  "forget",
  "health",
  "ingest",
  "install",
  "mcp-config",
  "migrate",
  "provision",
  "reindex",
  "rollback",
  "schedule",
  "secrets",
  "setup",
  "sources",
  "status",
  "support",
  "test",
  "update",
  "upgrade",
  "verify",
  "whatsnew",
]);

export const SUPPORT_SOURCES = Object.freeze([
  "calendar",
  "cloudflare",
  "drive",
  "gmail",
  "imessage",
  "installer",
  "iphone-backup",
  "local",
  "obsidian",
  "scheduler",
  "supabase",
  "zoom",
  "whatsapp",
]);

export const SUPPORT_ERROR_CODES = Object.freeze([
  "AUTH_DENIED",
  "AUTH_EXPIRED",
  "AUTH_REQUIRED",
  "COMMAND_FAILED",
  "CONFIG_INVALID",
  "EXTRACTION_FAILED",
  "FORMAT_UNSUPPORTED",
  "HEALTH_CHECK_FAILED",
  "INDEX_WRITE_FAILED",
  "INGEST_FAILED",
  "INPUT_REFUSED",
  "INTERNAL_ERROR",
  "MIGRATION_FAILED",
  "NETWORK_UNREACHABLE",
  "PDF_PROCESS_FAILED",
  "PDF_PROCESS_TIMEOUT",
  "RATE_LIMITED",
  "REMOTE_NOT_FOUND",
  "REMOTE_PERMISSION_DENIED",
  "REMOTE_UNAVAILABLE",
  "SAFETY_REVIEW_REQUIRED",
  "SCHEDULE_INSTALL_FAILED",
  "SCHEDULE_RUN_FAILED",
  "UPGRADE_FAILED",
  "VECTOR_DRAIN_FAILED",
]);

const COMMANDS = new Set(SUPPORT_COMMANDS);
const SOURCES = new Set(SUPPORT_SOURCES);
const ERROR_CODES = new Set(SUPPORT_ERROR_CODES);
const REQUIRED_KEYS = Object.freeze([
  "schema_version",
  "event_id",
  "timestamp",
  "product_version",
  "platform",
  "arch",
  "node_major",
  "command",
  "source",
  "error_code",
]);
const OPTIONAL_KEYS = new Set(["fingerprint"]);
const EVENT_ID_RE = /^evt_[0-9a-f]{32}$/;
const EVENT_FILE_RE = /^(evt_[0-9a-f]{32})\.json$/;
const FINGERPRINT_RE = /^loc_[0-9a-f]{24}$/;
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "unknown"]);
const ARCHES = new Set(["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64", "unknown"]);
const MAX_CANONICAL_LINE_BYTES = 1024;
const AGE_MS = SUPPORT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

let packageVersion;

function currentProductVersion() {
  if (packageVersion) return packageVersion;
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    packageVersion = VERSION_RE.test(parsed.version) ? parsed.version : "0.0.0";
  } catch {
    packageVersion = "0.0.0";
  }
  return packageVersion;
}

function supportError(message, code = "SUPPORT_JOURNAL_UNSAFE_PATH") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nowDate(options = {}) {
  const supplied = typeof options.now === "function" ? options.now() : options.now;
  const date = supplied === undefined ? new Date() : new Date(supplied);
  if (!Number.isFinite(date.getTime())) throw new TypeError("support journal now must be a valid date");
  return date;
}

function safeEnum(label, value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} must be one of the exported support journal values`);
  }
  return value;
}

function safeRuntime(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : "unknown";
}

function nodeMajor(value = process.versions.node) {
  const major = Number.parseInt(String(value).split(".")[0], 10);
  return Number.isSafeInteger(major) && major >= 1 && major <= 999 ? major : 0;
}

function eventId(options = {}) {
  const bytes = typeof options.randomBytes === "function" ? options.randomBytes(16) : randomBytes(16);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("support journal randomBytes must return bytes");
  }
  const hex = Buffer.from(bytes).subarray(0, 16).toString("hex");
  if (hex.length !== 32) throw new TypeError("support journal randomBytes must return at least 16 bytes");
  return `evt_${hex}`;
}

/**
 * Create a stable correlation value from a location in this product's source.
 * Arbitrary strings are rejected before hashing, so this can never become a
 * raw-message hash or a disguised path/URL/customer identifier.
 */
export function productRelativeFingerprint(location) {
  if (typeof location !== "string" || location.length > 160 || location.includes("..")) {
    throw new TypeError("support fingerprint must be a product-relative source location");
  }
  const modulePattern =
    "(?:brain|doctor|acceptance|report|report-html|support-journal)\\.mjs|" +
    "(?:components|connectors|ingest|migration|operations|worker/src)/[a-z0-9][a-z0-9._/-]*\\.(?:mjs|js)";
  const pattern = new RegExp(`^(?:${modulePattern})(?::[1-9]\\d{0,5}|#[a-z][a-z0-9_-]{0,63})?$`);
  if (!pattern.test(location) || location.includes("//") || location.includes("\\")) {
    throw new TypeError("support fingerprint must be a product-relative source location");
  }
  return `loc_${createHash("sha256").update(`brain-installer-location-v1\0${location}`, "utf8").digest("hex").slice(0, 24)}`;
}

/** Build the exact canonical event that may be stored or exported. */
export function previewSupportEvent(input = {}, options = {}) {
  const command = safeEnum("command", input.command, COMMANDS);
  const source = safeEnum("source", input.source, SOURCES);
  const errorCode = safeEnum("errorCode", input.errorCode, ERROR_CODES);
  const version = options.productVersion ?? currentProductVersion();
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new TypeError("productVersion must be a semantic product version");
  }
  const event = {
    schema_version: SUPPORT_SCHEMA_VERSION,
    event_id: eventId(options),
    timestamp: nowDate(options).toISOString(),
    product_version: version,
    platform: safeRuntime(options.platform ?? process.platform, PLATFORMS),
    arch: safeRuntime(options.arch ?? process.arch, ARCHES),
    node_major: nodeMajor(options.nodeVersion),
    command,
    source,
    error_code: errorCode,
  };
  if (input.productRelativeLocation !== undefined) {
    event.fingerprint = productRelativeFingerprint(input.productRelativeLocation);
  }
  return Object.freeze(event);
}

/** Resolve the private immutable-event store. No path here is an export file. */
export function supportJournalPaths(options = {}) {
  const requestedRoot = options.root ?? homedir();
  if (typeof requestedRoot !== "string" || !isAbsolute(requestedRoot)) {
    throw new TypeError("support journal root must be an absolute path");
  }
  const userRoot = resolve(requestedRoot);
  const brainRoot = join(userRoot, ".brain");
  const supportRoot = join(brainRoot, "support");
  const eventsDir = join(supportRoot, "events");
  return Object.freeze({ userRoot, brainRoot, supportRoot, eventsDir });
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ownershipUid(options = {}) {
  const getUid = options.getUid ?? process.getuid;
  if (typeof getUid !== "function") return null;
  const uid = getUid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw new TypeError("support journal getUid must return a POSIX uid");
  return uid;
}

function verifyDirectory(path, label, {
  stat = lstatIfPresent(path),
  expectedUid = null,
  privateMode = false,
} = {}) {
  if (!stat) throw supportError(`${label} does not exist`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw supportError(`${label} must be a real directory, not a link or special file`);
  }
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw supportError(`${label} must be owned by the current process user`);
  }
  if (privateMode && process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw supportError(`${label} must have private mode 0700`);
  }
  return stat;
}

function secureDirectory(path, label, expectedUid) {
  const existing = lstatIfPresent(path);
  if (existing) verifyDirectory(path, label, { stat: existing, expectedUid });
  else {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      // Another support writer may have won this exact mkdir race. We trust
      // only the directory after independently checking it below.
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const before = lstatIfPresent(path);
  verifyDirectory(path, label, { stat: before, expectedUid });
  if (process.platform === "win32") {
    // Windows has no POSIX directory modes. The real-directory checks still
    // refuse links and special files before the journal uses this path.
    return before;
  }

  let descriptor;
  let secured;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    verifyDirectory(path, label, { stat: opened, expectedUid });
    if (!sameNodeIdentity(before, opened)) {
      throw supportError(`${label} changed while its permissions were being secured`);
    }
    fchmodSync(descriptor, 0o700);
    secured = fstatSync(descriptor);
    verifyDirectory(path, label, { stat: secured, expectedUid, privateMode: true });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const current = lstatIfPresent(path);
  verifyDirectory(path, label, { stat: current, expectedUid, privateMode: true });
  if (!sameNodeIdentity(secured, current)) {
    throw supportError(`${label} changed while its permissions were being secured`);
  }
  return current;
}

function verifyFile(path, label, {
  stat = lstatIfPresent(path),
  expectedUid = null,
  privateMode = true,
} = {}) {
  if (!stat) throw supportError(`${label} does not exist`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw supportError(`${label} must be a regular file, not a link or special file`);
  }
  if (process.platform !== "win32" && stat.nlink !== 1) {
    throw supportError(`${label} must not have hard links`);
  }
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw supportError(`${label} must be owned by the current process user`);
  }
  if (privateMode && process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw supportError(`${label} must have private mode 0600`);
  }
  return stat;
}

function prepareSupportDirectory(options, expectedUid) {
  const paths = supportJournalPaths(options);
  verifyDirectory(paths.userRoot, "support journal root");
  secureDirectory(paths.brainRoot, "support journal .brain directory", expectedUid);
  secureDirectory(paths.supportRoot, "support journal directory", expectedUid);
  secureDirectory(paths.eventsDir, "support journal events directory", expectedUid);
  return paths;
}

function parseCanonicalEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== REQUIRED_KEYS.length && keys.length !== REQUIRED_KEYS.length + 1) return null;
  for (const key of REQUIRED_KEYS) if (!Object.hasOwn(value, key)) return null;
  for (const key of keys) if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.has(key)) return null;
  if (value.schema_version !== SUPPORT_SCHEMA_VERSION) return null;
  if (!EVENT_ID_RE.test(value.event_id)) return null;
  if (!ISO_RE.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp))) return null;
  if (!VERSION_RE.test(value.product_version)) return null;
  if (!PLATFORMS.has(value.platform) || !ARCHES.has(value.arch)) return null;
  if (!Number.isSafeInteger(value.node_major) || value.node_major < 0 || value.node_major > 999) return null;
  if (!COMMANDS.has(value.command) || !SOURCES.has(value.source) || !ERROR_CODES.has(value.error_code)) return null;
  if (Object.hasOwn(value, "fingerprint") && !FINGERPRINT_RE.test(value.fingerprint)) return null;
  const canonical = {
    schema_version: value.schema_version,
    event_id: value.event_id,
    timestamp: value.timestamp,
    product_version: value.product_version,
    platform: value.platform,
    arch: value.arch,
    node_major: value.node_major,
    command: value.command,
    source: value.source,
    error_code: value.error_code,
  };
  if (value.fingerprint) canonical.fingerprint = value.fingerprint;
  return canonical;
}

function canonicalLine(event) {
  return `${JSON.stringify(event)}\n`;
}

function sameNodeIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(left, right) {
  return sameNodeIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function cleanupFailedExclusiveWrite(path, identity, expectedUid) {
  if (!identity) return;
  const current = lstatIfPresent(path);
  if (!current || !current.isFile() || current.isSymbolicLink()) return;
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  if (process.platform !== "win32" && (current.nlink !== 1 || current.uid !== expectedUid)) return;
  try { unlinkSync(path); } catch { /* Preserve the original write error. */ }
}

/** Create one complete private file without ever replacing an existing path. */
function exclusivePrivateWrite(path, content, label, expectedUid) {
  const parent = dirname(path);
  verifyDirectory(parent, `${label} directory`, { expectedUid });
  const existing = lstatIfPresent(path);
  if (existing) {
    verifyFile(path, label, { stat: existing, expectedUid });
    throw supportError(`${label} already exists; refusing to overwrite it`, "SUPPORT_JOURNAL_EXISTS");
  }
  let descriptor;
  let identity;
  try {
    try {
      descriptor = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw supportError(`${label} already exists; refusing to overwrite it`, "SUPPORT_JOURNAL_EXISTS");
      }
      throw error;
    }
    identity = fstatSync(descriptor);
    if (!identity.isFile() ||
        (process.platform !== "win32" && identity.nlink !== 1) ||
        (expectedUid !== null && identity.uid !== expectedUid)) {
      throw supportError(`${label} was not created as a private regular file`);
    }
    try { fchmodSync(descriptor, 0o600); } catch { /* Windows has no POSIX file modes. */ }
    const afterMode = fstatSync(descriptor);
    if (process.platform !== "win32" && (afterMode.mode & 0o777) !== 0o600) {
      throw supportError(`${label} was not created with private mode 0600`);
    }
    const data = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(descriptor, data, offset, data.length - offset);
      if (written <= 0) throw new Error("support journal write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    verifyFile(path, label, { expectedUid });
    try {
      const parentFd = openSync(parent, fsConstants.O_RDONLY);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } catch { /* Directory fsync is not available on every supported filesystem. */ }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
      descriptor = undefined;
    }
    cleanupFailedExclusiveWrite(path, identity, expectedUid);
    throw error;
  }
}

function readImmutableEvent(path, expectedNameId, expectedUid) {
  const before = lstatIfPresent(path);
  if (!before) return null;
  verifyFile(path, "support journal event", { stat: before, expectedUid });
  if (before.size === 0 || before.size > MAX_CANONICAL_LINE_BYTES) return null;
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    verifyFile(path, "support journal event", { stat: opened, expectedUid });
    if (opened.size === 0 || opened.size > MAX_CANONICAL_LINE_BYTES) return null;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) return null;
    const content = buffer.toString("utf8");
    if (!content.endsWith("\n") || content.slice(0, -1).includes("\n")) return null;
    let parsed;
    try { parsed = parseCanonicalEvent(JSON.parse(content)); } catch { return null; }
    if (!parsed || parsed.event_id !== expectedNameId || canonicalLine(parsed) !== content) return null;
    return parsed;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadEvents(paths, expectedUid) {
  const eventsStat = lstatIfPresent(paths.eventsDir);
  if (!eventsStat) return [];
  verifyDirectory(paths.eventsDir, "support journal events directory", {
    stat: eventsStat,
    expectedUid,
    privateMode: true,
  });
  const events = [];
  for (const name of readdirSync(paths.eventsDir)) {
    const path = join(paths.eventsDir, name);
    const entry = lstatIfPresent(path);
    if (!entry) continue;
    verifyFile(path, "support journal event", { stat: entry, expectedUid });
    const match = EVENT_FILE_RE.exec(name);
    if (!match) continue;
    const event = readImmutableEvent(path, match[1], expectedUid);
    if (event) events.push(event);
  }
  return events;
}

function physicalRetentionOptions(options, event) {
  const maxEvents = options.physicalMaxEvents ?? SUPPORT_MAX_EVENTS;
  const graceMs = options.retentionGraceMs ?? SUPPORT_RETENTION_GRACE_MS;
  const nowMs = options.retentionNowMs ?? Date.parse(event.timestamp);
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > SUPPORT_MAX_EVENTS) {
    throw new TypeError("support journal physicalMaxEvents must be a positive bounded integer");
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > AGE_MS) {
    throw new TypeError("support journal retentionGraceMs must be a bounded nonnegative integer");
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("support journal retentionNowMs must be a finite timestamp");
  }
  return { maxEvents, graceMs, nowMs };
}

/**
 * Remove only old canonical events after a new event is already durable.
 *
 * Cleanup deliberately ignores partial or invalid files. One of those may be
 * a different process that has created its immutable name and is still
 * writing. A freshness grace protects a complete writer that has not yet
 * closed or synced its descriptor. The final identity check avoids unlinking
 * a path that changed after the scan.
 */
function enforcePhysicalRetention(paths, expectedUid, currentEvent, options) {
  const { maxEvents, graceMs, nowMs } = physicalRetentionOptions(options, currentEvent);
  const eventsStat = lstatIfPresent(paths.eventsDir);
  verifyDirectory(paths.eventsDir, "support journal events directory", {
    stat: eventsStat,
    expectedUid,
    privateMode: true,
  });

  const candidates = [];
  for (const name of readdirSync(paths.eventsDir)) {
    const match = EVENT_FILE_RE.exec(name);
    if (!match) continue;
    const path = join(paths.eventsDir, name);
    const before = lstatIfPresent(path);
    if (!before) continue;
    verifyFile(path, "support journal retention event", { stat: before, expectedUid });
    const event = readImmutableEvent(path, match[1], expectedUid);
    if (!event) continue;
    const after = lstatIfPresent(path);
    if (!after) continue;
    verifyFile(path, "support journal retention event", { stat: after, expectedUid });
    if (!sameFileIdentity(before, after)) continue;
    candidates.push({ path, event, identity: after });
  }

  const ordered = candidates.sort((left, right) =>
    left.event.timestamp.localeCompare(right.event.timestamp) ||
    left.event.event_id.localeCompare(right.event.event_id));
  const unexpired = ordered.filter((candidate) =>
    Date.parse(candidate.event.timestamp) >= nowMs - AGE_MS);
  const keepIds = new Set(unexpired.slice(-maxEvents).map((candidate) => candidate.event.event_id));

  for (const candidate of ordered) {
    if (candidate.event.event_id === currentEvent.event_id) continue;
    const expired = Date.parse(candidate.event.timestamp) < nowMs - AGE_MS;
    if (!expired && keepIds.has(candidate.event.event_id)) continue;
    if (candidate.identity.mtimeMs >= nowMs - graceMs) continue;

    const currentEventsDir = lstatIfPresent(paths.eventsDir);
    verifyDirectory(paths.eventsDir, "support journal events directory", {
      stat: currentEventsDir,
      expectedUid,
      privateMode: true,
    });
    if (!sameNodeIdentity(eventsStat, currentEventsDir)) return;
    const current = lstatIfPresent(candidate.path);
    if (!current) continue;
    verifyFile(candidate.path, "support journal retention event", { stat: current, expectedUid });
    if (!sameFileIdentity(candidate.identity, current)) continue;
    unlinkSync(candidate.path);
  }
}

function pruneEvents(events, now) {
  const newestAllowed = now.getTime() + 5 * 60 * 1000;
  const oldestAllowed = now.getTime() - AGE_MS;
  const byId = new Map();
  for (const candidate of events) {
    const event = parseCanonicalEvent(candidate);
    if (!event) continue;
    const time = Date.parse(event.timestamp);
    if (time < oldestAllowed || time > newestAllowed) continue;
    byId.set(event.event_id, event);
  }
  const ordered = [...byId.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
  const newest = ordered.slice(-SUPPORT_MAX_EVENTS);
  const kept = [];
  let bytes = 0;
  for (let index = newest.length - 1; index >= 0; index--) {
    const lineBytes = Buffer.byteLength(canonicalLine(newest[index]), "utf8");
    if (lineBytes > SUPPORT_MAX_BYTES - bytes) break;
    kept.push(newest[index]);
    bytes += lineBytes;
  }
  return kept.reverse();
}

function canonicalJournal(events) {
  return events.map(canonicalLine).join("");
}

/** Add one immutable event, then best-effort clean safe expired or overflow events. */
export function recordSupportEvent(input, options = {}) {
  const expectedUid = ownershipUid(options);
  const paths = prepareSupportDirectory(options, expectedUid);
  const event = previewSupportEvent(input, options);
  const path = join(paths.eventsDir, `${event.event_id}.json`);
  exclusivePrivateWrite(path, canonicalLine(event), "support journal event", expectedUid);
  try {
    enforcePhysicalRetention(paths, expectedUid, event, options);
  } catch {
    // The new event and the command's original failure are already durable.
    // Retention is housekeeping and must never hide either one.
  }
  return event;
}

function canonicalSupportJournal(options, expectedUid) {
  const paths = supportJournalPaths(options);
  const userRoot = lstatIfPresent(paths.userRoot);
  if (!userRoot) return "";
  verifyDirectory(paths.userRoot, "support journal root", { stat: userRoot });
  const brain = lstatIfPresent(paths.brainRoot);
  if (!brain) return "";
  secureDirectory(paths.brainRoot, "support journal .brain directory", expectedUid);
  const support = lstatIfPresent(paths.supportRoot);
  if (!support) return "";
  secureDirectory(paths.supportRoot, "support journal directory", expectedUid);
  if (lstatIfPresent(paths.eventsDir)) {
    secureDirectory(paths.eventsDir, "support journal events directory", expectedUid);
  }
  return canonicalJournal(pruneEvents(loadEvents(paths, expectedUid), nowDate(options)));
}

/** Return the exact canonical JSONL bytes that exportSupportJournal will write. */
export function previewSupportJournal(options = {}) {
  return canonicalSupportJournal(options, ownershipUid(options));
}

/** Export only the canonical, pruned schema. Existing destinations are refused. */
export function exportSupportJournal(destination, options = {}) {
  if (typeof destination !== "string" || destination.length === 0) {
    throw new TypeError("support journal export destination is required");
  }
  const path = resolve(destination);
  const expectedUid = ownershipUid(options);
  const content = canonicalSupportJournal(options, expectedUid);
  if (!lstatIfPresent(dirname(path))) throw supportError("support journal export directory does not exist");
  exclusivePrivateWrite(path, content, "support journal export", expectedUid);
  return Object.freeze({
    bytes: Buffer.byteLength(content, "utf8"),
    events: content ? content.split("\n").length - 1 : 0,
  });
}

/** Remove exactly <root>/.brain/support. The parent .brain directory is kept. */
export function clearSupportJournal(options = {}) {
  const expectedUid = ownershipUid(options);
  const paths = supportJournalPaths(options);
  const support = lstatIfPresent(paths.supportRoot);
  if (!support) return false;
  const brain = lstatIfPresent(paths.brainRoot);
  if (!brain) throw supportError("support journal parent does not exist");
  verifyDirectory(paths.brainRoot, "support journal .brain directory", {
    stat: brain,
    expectedUid,
    privateMode: true,
  });
  verifyDirectory(paths.supportRoot, "support journal directory", {
    stat: support,
    expectedUid,
    privateMode: true,
  });
  loadEvents(paths, expectedUid);
  const expected = join(resolve(paths.userRoot), ".brain", "support");
  if (paths.supportRoot !== expected || basename(paths.supportRoot) !== "support" || !paths.supportRoot.endsWith(`${sep}.brain${sep}support`)) {
    throw supportError("refusing to clear anything except the exact support journal directory");
  }
  rmSync(paths.supportRoot, { recursive: true, force: false });
  return true;
}
