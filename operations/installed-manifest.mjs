/**
 * Remember one installed Brain without putting its manifest in the package or
 * relying on the caller's current directory. The pointer is not a credential,
 * but it identifies a private install, so it stays in an owner-only state file.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const POINTER_SCHEMA_VERSION = 1;
const MAX_POINTER_BYTES = 8 * 1024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class InstalledManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InstalledManifestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InstalledManifestError(code, message);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(info, code, label) {
  const uid = currentUid();
  if (uid !== null && info.uid !== uid) fail(code, `${label} is not owned by this user`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function directorySyncUnsupported(error, platform) {
  if (platform !== "win32") return false;
  return new Set([
    "EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM",
  ]).has(error?.code);
}

/**
 * Make the name installed by rename durable, not merely the JSON bytes.
 *
 * POSIX exposes the required directory handle through fs.open. Node may reject
 * directory fsync on Windows, so that one documented portability case flushes
 * the already-renamed destination handle instead. Every other failure stops
 * the caller from reporting that this location was remembered durably.
 */
function syncRenamedPointer(directory, destination, options) {
  const platform = options.platform ?? process.platform;
  let descriptor;
  let failure;
  try {
    if (options.syncStateDirectory) {
      options.syncStateDirectory(directory, "persisted");
    } else {
      const before = lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        fail("INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder is not a real directory");
      }
      assertOwned(before, "INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder");
      if (platform !== "win32" && (before.mode & 0o077) !== 0) {
        fail("INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder is not private");
      }
      descriptor = openSync(
        directory,
        fsConstants.O_RDONLY |
          (platform === "win32" ? 0 : (fsConstants.O_DIRECTORY || 0)) |
          (fsConstants.O_NOFOLLOW || 0),
      );
      const opened = fstatSync(descriptor);
      if (!opened.isDirectory() || !sameIdentity(before, opened)) {
        fail("INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder changed while it was synchronized");
      }
      fsyncSync(descriptor);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (error) { failure ||= error; }
    }
  }
  if (!failure) return;
  if (failure instanceof InstalledManifestError) throw failure;
  if (!directorySyncUnsupported(failure, platform)) {
    fail(
      "INSTALLED_MANIFEST_STATE_DURABILITY",
      "the saved Brain location folder could not be synchronized safely",
    );
  }

  // Node does not guarantee a usable directory fsync handle on Windows. The
  // staged file was flushed before rename; flushing its final identity is the
  // strongest supported post-rename barrier and is never silently skipped.
  let finalDescriptor;
  try {
    const before = validatePointerFile(destination);
    // Windows FlushFileBuffers requires a handle with write access. O_RDWR
    // grants that access without truncating or creating the verified file.
    finalDescriptor = openSync(destination, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(finalDescriptor);
    if (!before || !sameFile(before, opened)) {
      fail("INSTALLED_MANIFEST_POINTER_CHANGED", "the saved Brain location changed while it was synchronized");
    }
    fsyncSync(finalDescriptor);
  } catch (error) {
    if (error instanceof InstalledManifestError) throw error;
    fail(
      "INSTALLED_MANIFEST_STATE_DURABILITY",
      "the saved Brain location could not be synchronized safely",
    );
  } finally {
    if (finalDescriptor !== undefined) {
      try { closeSync(finalDescriptor); } catch {
        fail(
          "INSTALLED_MANIFEST_STATE_DURABILITY",
          "the saved Brain location could not be synchronized safely",
        );
      }
    }
  }
}

export function installedManifestStateDirectory({
  stateDirectory,
  platform = process.platform,
  environment = process.env,
  home = homedir(),
} = {}) {
  if (stateDirectory) return resolve(stateDirectory);
  if (platform === "win32") {
    const local = String(environment?.LOCALAPPDATA || "");
    if (local && isAbsolute(local) && !CONTROL_RE.test(local)) {
      return join(local, "FinancialBrain", "state");
    }
  }
  if (!home || !isAbsolute(home) || CONTROL_RE.test(home)) {
    fail("INSTALLED_MANIFEST_HOME_INVALID", "the user home folder is unavailable");
  }
  return join(home, ".financial-brain", "state");
}

export function installedManifestPointerPath(options = {}) {
  return join(installedManifestStateDirectory(options), "installed-manifest.json");
}

function prepareStateDirectory(options) {
  const directory = installedManifestStateDirectory(options);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder is not a real directory");
  }
  assertOwned(info, "INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    chmodSync(directory, 0o700);
    info = lstatSync(directory);
    if ((info.mode & 0o077) !== 0) {
      fail("INSTALLED_MANIFEST_STATE_UNSAFE", "the saved Brain location folder is not private");
    }
  }
  return directory;
}

function canonicalManifestPath(manifestPath) {
  const lexical = resolve(String(manifestPath || ""));
  let info;
  try { info = lstatSync(lexical); } catch {
    fail("INSTALLED_MANIFEST_TARGET_MISSING", "the Brain manifest does not exist");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail("INSTALLED_MANIFEST_TARGET_UNSAFE", "the Brain manifest must be one regular file, not a link");
  }
  assertOwned(info, "INSTALLED_MANIFEST_TARGET_UNSAFE", "the Brain manifest");
  const canonical = join(realpathSync.native(dirname(lexical)), basename(lexical));
  const after = lstatSync(canonical);
  if (!sameFile(info, after)) {
    fail("INSTALLED_MANIFEST_TARGET_UNSAFE", "the Brain manifest changed while it was remembered");
  }
  return canonical;
}

function validatePointerFile(path) {
  let before;
  try { before = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("INSTALLED_MANIFEST_POINTER_UNREADABLE", "the saved Brain location could not be inspected");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 2 || before.size > MAX_POINTER_BYTES) {
    fail("INSTALLED_MANIFEST_POINTER_UNSAFE", "the saved Brain location is not one safe regular file");
  }
  assertOwned(before, "INSTALLED_MANIFEST_POINTER_UNSAFE", "the saved Brain location");
  if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
    fail("INSTALLED_MANIFEST_POINTER_UNSAFE", "the saved Brain location is not private");
  }
  return before;
}

export function readInstalledManifest(options = {}) {
  const path = installedManifestPointerPath(options);
  const before = validatePointerFile(path);
  if (!before) return null;
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) {
      fail("INSTALLED_MANIFEST_POINTER_CHANGED", "the saved Brain location changed while it was opened");
    }
    const raw = readFileSync(descriptor, "utf8");
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      fail("INSTALLED_MANIFEST_POINTER_CHANGED", "the saved Brain location changed while it was read");
    }
    let value;
    try { value = JSON.parse(raw); } catch {
      fail("INSTALLED_MANIFEST_POINTER_INVALID", "the saved Brain location is not valid JSON");
    }
    if (!value || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "manifest_path,schema_version" ||
        value.schema_version !== POINTER_SCHEMA_VERSION ||
        typeof value.manifest_path !== "string" || !isAbsolute(value.manifest_path) ||
        !value.manifest_path || value.manifest_path.length > 4096 || CONTROL_RE.test(value.manifest_path)) {
      fail("INSTALLED_MANIFEST_POINTER_INVALID", "the saved Brain location has an invalid format");
    }
    return value.manifest_path;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function rememberInstalledManifest(manifestPath, options = {}) {
  const canonical = canonicalManifestPath(manifestPath);
  const directory = prepareStateDirectory(options);
  const destination = join(directory, "installed-manifest.json");
  const temporary = join(directory, `.installed-manifest-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let existing;
  try {
    existing = validatePointerFile(destination);
  } catch (error) {
    // An explicit, custody-verified update may repair only the pointer entry.
    // Atomic rename replaces a symlink or hard link without following it or
    // changing its target. A directory is never removed automatically.
    if (!options.repairUnsafePointer ||
        !(error instanceof InstalledManifestError) ||
        !String(error.code).startsWith("INSTALLED_MANIFEST_POINTER_")) {
      throw error;
    }
    try { existing = lstatSync(destination); } catch {
      fail("INSTALLED_MANIFEST_POINTER_UNREADABLE", "the saved Brain location could not be repaired safely");
    }
    if (existing.isDirectory()) {
      fail("INSTALLED_MANIFEST_POINTER_UNSAFE", "the saved Brain location is a directory and needs manual review");
    }
  }
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    writeFileSync(descriptor, `${JSON.stringify({
      schema_version: POINTER_SCHEMA_VERSION,
      manifest_path: canonical,
    }, null, 2)}\n`);
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // The private state directory is owner-only, so this atomic replacement
    // cannot be redirected between the safety check and rename.
    renameSync(temporary, destination);
    created = false;
    syncRenamedPointer(directory, destination, options);
    const readback = readInstalledManifest(options);
    if (readback !== canonical) {
      fail("INSTALLED_MANIFEST_POINTER_INCOMPLETE", "the saved Brain location did not verify after writing");
    }
    return { path: destination, manifestPath: canonical, replaced: Boolean(existing) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    }
  }
}

export function discoverInstalledManifest(explicitPath, {
  cwd = process.cwd(),
  exists = (path) => {
    try { return lstatSync(path).isFile(); } catch { return false; }
  },
  ...options
} = {}) {
  if (explicitPath) return { path: resolve(cwd, explicitPath), source: "explicit" };

  const remembered = readInstalledManifest(options);
  if (remembered) {
    if (!exists(remembered)) {
      fail(
        "INSTALLED_MANIFEST_TARGET_MISSING",
        "the saved Brain location no longer exists; run update once with the full manifest path",
      );
    }
    return { path: remembered, source: "remembered" };
  }

  const home = options.home ?? homedir();
  const standard = join(home, "Financial Brain", "brain.manifest.json");
  if (exists(standard)) return { path: resolve(standard), source: "standard" };

  // Preserve the original pre-registry behavior as the final fallback. Once it
  // succeeds, cmdUpdate records the absolute path and future updates are cwd-free.
  const local = resolve(cwd, "brain.manifest.json");
  if (exists(local)) return { path: local, source: "legacy_local" };
  return null;
}
