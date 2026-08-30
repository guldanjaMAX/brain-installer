/**
 * Persist the generated brain admin key without exposing it through argv,
 * logs, or a partially written destination file.
 *
 * POSIX uses a private, fsynced temporary file followed by an atomic rename.
 * Windows first protects the value with DPAPI CurrentUser, then applies the
 * current user's ACL to an empty staging file before writing only ciphertext.
 * An ACL or DPAPI failure therefore leaves any prior working key untouched.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  disposeWindowsDpapiSession,
  prepareWindowsDpapiSession,
} from "./windows-dpapi-session.mjs";

const WINDOWS_DPAPI_HEADER = Buffer.from("BRAIN-ADMIN-KEY-DPAPI-V1\n", "ascii");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_ADMIN_KEY_FILE_BYTES = 64 * 1024;
const DEFAULT_RESIDUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESIDUE_NAME = /^\.\.brain-admin-key\.\d+\.[0-9a-f]{16}\.(tmp|bak)$/;
const WINDOWS_RUNTIME_ENV = Object.freeze([
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
]);
const WINDOWS_DPAPI_HELPER = fileURLToPath(new URL("./windows-dpapi.ps1", import.meta.url));
const WINDOWS_DPAPI_BRIDGE = fileURLToPath(new URL("./windows-dpapi-bridge.mjs", import.meta.url));

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function assertParent(path, expectedUid, platform, options = {}) {
  const parent = dirname(path);
  let realParent;
  try {
    realParent = (options.realpath ?? realpathSync.native)(parent);
  } catch {
    throw new Error("the admin key directory must be a real existing directory");
  }
  const expectedParent = resolve(parent);
  const canonicalParent = resolve(realParent);
  const sameParent = platform === "win32"
    ? canonicalParent.toLowerCase() === expectedParent.toLowerCase()
    : canonicalParent === expectedParent;
  if (!sameParent) {
    throw new Error("the admin key path must not pass through a linked directory");
  }
  const st = lstatIfPresent(parent);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error("the admin key directory must be a real existing directory");
  }
  if (platform !== "win32" && expectedUid !== null && st.uid !== expectedUid) {
    throw new Error("the admin key directory must be owned by the current user");
  }
  if (platform !== "win32" && (st.mode & 0o022) !== 0) {
    throw new Error("the admin key directory must not be writable by other users");
  }
  return st;
}

function assertNoOrphanRollbackBackup(path, expectedUid, platform, options = {}) {
  let names;
  try {
    names = (options.readDirectory ?? readdirSync)(dirname(path));
  } catch {
    throw new Error(
      "the admin key directory could not be inspected for an interrupted rollback backup",
    );
  }
  for (const name of names) {
    const match = String(name).match(RESIDUE_NAME);
    if (match?.[1] !== "bak") continue;
    const candidate = join(dirname(path), String(name));
    const identity = lstatIfPresent(candidate);
    if (!identity) continue;
    const safe = !identity.isSymbolicLink() && identity.isFile() &&
      identity.nlink === 1 && identity.size > 0 &&
      identity.size <= MAX_ADMIN_KEY_FILE_BYTES &&
      (platform === "win32" ||
        (identity.uid === expectedUid && (identity.mode & 0o777) === 0o600));
    throw new Error(
      safe
        ? "an orphan admin key rollback backup exists while .brain-admin-key is missing; recovery must be resolved before continuing"
        : "an unsafe admin key rollback artifact exists while .brain-admin-key is missing; recovery must be resolved before continuing",
    );
  }
}

function assertExistingDestination(path, expectedUid, platform) {
  const st = lstatIfPresent(path);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error("the admin key destination must be a regular file, not a link or special file");
  }
  if (platform !== "win32" && expectedUid !== null && st.uid !== expectedUid) {
    throw new Error("the admin key destination must be owned by the current user");
  }
  if (st.nlink !== 1) {
    throw new Error("the admin key destination must not have hard links");
  }
  if (platform !== "win32" && (st.mode & 0o777) !== 0o600) {
    throw new Error("the admin key destination must be readable only by the current user");
  }
  return st;
}

function removeIfSame(path, identity) {
  const current = lstatIfPresent(path);
  if (!sameFile(current, identity)) return false;
  try {
    unlinkSync(path);
    return lstatIfPresent(path) === null;
  } catch {
    return false;
  }
}

function defaultAcl(args) {
  const { env } = windowsPowerShellRuntime();
  const command = env.SystemRoot
    ? join(env.SystemRoot, "System32", "icacls.exe")
    : "icacls";
  return spawnSync(command, args, {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
}

function assertAdminKeyPath(destination) {
  if (typeof destination !== "string" || !isAbsolute(destination) ||
      basename(destination) !== ".brain-admin-key") {
    throw new TypeError("admin key destination must be an absolute .brain-admin-key path");
  }
  return resolve(destination);
}

export function validateAdminKeyValue(secret) {
  if (typeof secret !== "string" || secret.length < 24 || secret.length > 512 ||
      secret.trim() !== secret || !/^[\x20-\x7e]+$/.test(secret)) {
    throw new TypeError(
      "admin key must be 24 to 512 HTTP-header-safe ASCII characters with no surrounding whitespace",
    );
  }
  return secret;
}

/**
 * Read-only preflight for the exact destination writeAdminKeyFile will use.
 * This catches unsafe parents, links, ownership, and missing Windows identity
 * before a caller changes the remote Worker secret.
 */
export function validateAdminKeyFileDestination(destination, options = {}) {
  const path = assertAdminKeyPath(destination);
  const platform = options.platform ?? process.platform;
  const getUid = options.getUid ?? process.getuid;
  const expectedUid = platform !== "win32" && typeof getUid === "function" ? getUid() : null;
  assertParent(path, expectedUid, platform, options);
  const prior = assertExistingDestination(path, expectedUid, platform);
  if (!prior) assertNoOrphanRollbackBackup(path, expectedUid, platform, options);
  if (platform === "win32") {
    const username = options.username;
    if (typeof username !== "string" || !username.trim()) {
      throw new Error("Windows could not identify the current user, so the admin key was not replaced");
    }
  }
  return Object.freeze({ path, replaced: prior !== null });
}

function windowsPowerShellRuntime(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!systemRoot) {
    // Cross-platform unit tests inject the runner and never execute this name.
    // A real Windows process should always have SystemRoot; refusing to inherit
    // PATH here is safer than forwarding a possibly secret-bearing environment.
    if (process.platform === "win32") {
      throw new Error("Windows could not locate its system runtime directory");
    }
    return { command: "powershell.exe", env: {} };
  }
  const env = { SystemRoot: systemRoot };
  // DPAPI CurrentUser depends on the loaded Windows profile. Keep only the
  // profile/runtime locators the Windows helpers and DPAPI need, never the caller's
  // credential-bearing environment.
  for (const name of WINDOWS_RUNTIME_ENV) {
    if (typeof environment[name] === "string" && environment[name]) env[name] = environment[name];
  }
  return {
    command: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    env,
  };
}

function runWindowsDpapi(input, options, operation, secretForMetadataCheck = null) {
  const { command, env } = windowsPowerShellRuntime(options.environment ?? process.env);
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 64 * 1024) {
    throw new Error("Windows DPAPI received an invalid admin key payload size");
  }
  const powerShellArgs = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_DPAPI_HELPER,
    "-Operation", operation,
    "-ExpectedLength", String(input.length),
  ];
  // Tests inject the legacy PowerShell runner directly. Production asks a
  // fixed Node bridge to compile the fixed C# helper before it reads any secret,
  // then uses an ordinary asynchronous pipe for the exact bytes.
  let session = null;
  if (!options.runPowerShell) {
    try {
      session = (options.prepareWindowsDpapiSession ?? prepareWindowsDpapiSession)({
        environment: options.environment ?? process.env,
        ...(options.dpapiSessionOptions || {}),
      });
    } catch (caught) {
      const stage = /^[a-z_]+$/.test(String(caught?.stage || "")) ? caught.stage : "compile";
      const error = new Error(
        operation === "protect"
          ? `Windows could not protect the admin key with DPAPI at the ${stage} stage; the prior key was left untouched`
          : `Windows could not decrypt the admin key with DPAPI at the ${stage} stage for the current user`,
      );
      error.code = `WINDOWS_DPAPI_${stage.toUpperCase()}`;
      error.stage = stage;
      throw error;
    }
  }
  const runner = options.runPowerShell ?? options.runDpapiBridge ?? spawnSync;
  const runnerCommand = options.runPowerShell ? command : process.execPath;
  const runnerArgs = options.runPowerShell
    ? powerShellArgs
    : [
        WINDOWS_DPAPI_BRIDGE,
        "--helper", session.helper,
        "--sha256", session.sha256,
        "--operation", operation,
        "--length", String(input.length),
        "--max", String(MAX_ADMIN_KEY_FILE_BYTES),
      ];
  if (secretForMetadataCheck) {
    const metadata = [runnerCommand, ...runnerArgs, ...Object.entries(env).flat()].join("\0");
    const encodedSecret = Buffer.from(secretForMetadataCheck, "utf8").toString("base64");
    if (metadata.includes(secretForMetadataCheck) || metadata.includes(encodedSecret)) {
      throw new Error("Windows refused to expose the admin key in DPAPI process metadata");
    }
  }
  const result = runner(runnerCommand, runnerArgs, {
    encoding: null,
    env,
    input,
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0) {
    const stderr = Buffer.isBuffer(result?.stderr)
      ? result.stderr.toString("ascii")
      : String(result?.stderr || "");
    const stage = stderr.match(/(?:^|\n)BRAIN_DPAPI_STAGE:([a-z_]+)(?:\n|$)/)?.[1] || "unknown";
    // Never include stderr or the child error object: either may retain child
    // process data, and the caller only needs the safe recovery boundary.
    if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
    if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
    const error = new Error(
      operation === "protect"
        ? `Windows could not protect the admin key with DPAPI at the ${stage} stage; the prior key was left untouched`
        : `Windows could not decrypt the admin key with DPAPI at the ${stage} stage for the current user`,
    );
    error.code = `WINDOWS_DPAPI_${stage.toUpperCase()}`;
    error.stage = stage;
    throw error;
  }
  const output = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "");
  if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
  if (!output.length || output.length > 64 * 1024) {
    output.fill(0);
    throw new Error(
      operation === "protect"
        ? "Windows DPAPI returned no usable ciphertext; the prior key was left untouched"
        : "Windows DPAPI returned no usable admin key for the current user",
    );
  }
  return output;
}

/**
 * Exercise the exact production DPAPI bridge without persisting a credential.
 * Each round uses fresh random bytes, verifies exact protect/unprotect readback,
 * wipes every buffer, and reuses one private process-scoped compiled helper.
 * The probe passes only after that captured helper is removed cleanly.
 */
export function probeWindowsDpapi(options = {}) {
  const platform = options.platform ?? process.platform;
  const rounds = options.rounds ?? 3;
  if (platform !== "win32") {
    return Object.freeze({ checked: false, passed: true, rounds: 0, stage: null });
  }
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 32) {
    throw new TypeError("the Windows DPAPI diagnostic needs two to thirty-two rounds");
  }
  const random = options.randomBytes ?? randomBytes;
  let completed = 0;
  let failure = null;
  try {
    for (let index = 0; index < rounds; index++) {
      const plain = random(32);
      if (!Buffer.isBuffer(plain) || plain.length !== 32) {
        if (Buffer.isBuffer(plain)) plain.fill(0);
        throw Object.assign(new Error("the Windows DPAPI diagnostic random source failed"), {
          stage: "diagnostic_input",
          code: "WINDOWS_DPAPI_DIAGNOSTIC_INPUT",
        });
      }
      let protectedBytes;
      let opened;
      try {
        protectedBytes = runWindowsDpapi(plain, options, "protect");
        opened = runWindowsDpapi(protectedBytes, options, "unprotect");
        if (!opened.equals(plain)) {
          throw Object.assign(new Error("the Windows DPAPI diagnostic readback differed"), {
            stage: "readback",
            code: "WINDOWS_DPAPI_READBACK",
          });
        }
        completed++;
      } finally {
        plain.fill(0);
        if (protectedBytes) protectedBytes.fill(0);
        if (opened) opened.fill(0);
      }
    }
  } catch (error) {
    failure = error;
  }
  let cleanup = Object.freeze({ status: "not_applicable" });
  if (!options.runPowerShell) {
    cleanup = (options.disposeWindowsDpapiSession ?? disposeWindowsDpapiSession)(
      options.dpapiDisposeOptions || {},
    );
  }
  if (failure) {
    return Object.freeze({
      checked: true,
      passed: false,
      rounds: completed,
      stage: /^[a-z_]+$/.test(String(failure?.stage || "")) ? failure.stage : "unknown",
      issue_code: /^WINDOWS_DPAPI_[A-Z_]+$/.test(String(failure?.code || ""))
        ? failure.code
        : "WINDOWS_DPAPI_UNKNOWN",
    });
  }
  if (cleanup.status !== "not_applicable" && cleanup.status !== "clean") {
    return Object.freeze({
      checked: true,
      passed: false,
      rounds: completed,
      stage: "cleanup_deferred",
      issue_code: cleanup.issue_code || "WINDOWS_DPAPI_CLEANUP_DEFERRED",
      cleanup_status: cleanup.status,
    });
  }
  return Object.freeze({
    checked: true,
    passed: true,
    rounds: completed,
    stage: null,
    ...(cleanup.status === "clean" ? { cleanup_status: "clean" } : {}),
  });
}

function protectAdminKeyForWindows(secret, options) {
  const plain = Buffer.from(secret, "utf8");
  let protectedBytes;
  try {
    protectedBytes = runWindowsDpapi(plain, options, "protect", secret);
    const encoded = protectedBytes.toString("base64");
    return Buffer.from(`${WINDOWS_DPAPI_HEADER.toString("ascii")}${encoded}\n`, "ascii");
  } finally {
    plain.fill(0);
    if (protectedBytes) protectedBytes.fill(0);
  }
}

function parseWindowsDpapiEnvelope(bytes) {
  const body = bytes.subarray(WINDOWS_DPAPI_HEADER.length).toString("ascii");
  if (!/^[A-Za-z0-9+/]+={0,2}\r?\n?$/.test(body)) {
    throw new Error("the Windows admin key DPAPI envelope is malformed");
  }
  const encoded = body.replace(/\r?\n$/, "");
  if (encoded.length % 4 !== 0) {
    throw new Error("the Windows admin key DPAPI envelope is malformed");
  }
  const protectedBytes = Buffer.from(encoded, "base64");
  if (!protectedBytes.length || protectedBytes.toString("base64") !== encoded) {
    protectedBytes.fill(0);
    throw new Error("the Windows admin key DPAPI envelope is malformed");
  }
  return protectedBytes;
}

function decodeAdminKeyPayload(bytes, platform, options) {
  if (bytes.subarray(0, WINDOWS_DPAPI_HEADER.length).equals(WINDOWS_DPAPI_HEADER)) {
    if (platform !== "win32") {
      throw new Error("a Windows DPAPI admin key can only be read by its Windows user");
    }
    const protectedBytes = parseWindowsDpapiEnvelope(bytes);
    let plain;
    try {
      plain = runWindowsDpapi(protectedBytes, options, "unprotect");
      return validateAdminKeyValue(UTF8_DECODER.decode(plain));
    } finally {
      protectedBytes.fill(0);
      if (plain) plain.fill(0);
    }
  }

  // This is both the POSIX format and the pre-DPAPI Windows format. Remove only
  // the one line ending written by this module. Broad trimming would silently
  // accept a key with surrounding spaces even though its exact value cannot be
  // used safely and consistently in an HTTP authorization header.
  const decoded = UTF8_DECODER.decode(bytes);
  const legacy = decoded.endsWith("\r\n")
    ? decoded.slice(0, -2)
    : decoded.endsWith("\n")
      ? decoded.slice(0, -1)
      : decoded;
  if (!legacy) throw new Error("the admin key file is empty");
  return validateAdminKeyValue(legacy);
}

/**
 * Read the adjacent admin-key file. Windows DPAPI envelopes are decrypted for
 * the current user; older Windows plaintext files remain readable so an
 * upgrade does not lock out an existing install. POSIX remains plaintext.
 */
export function readAdminKeyFile(destination, options = {}) {
  const path = assertAdminKeyPath(destination);
  const platform = options.platform ?? process.platform;
  const getUid = options.getUid ?? process.getuid;
  const expectedUid = platform !== "win32" && typeof getUid === "function" ? getUid() : null;
  assertParent(path, expectedUid, platform, options);
  const existing = assertExistingDestination(path, expectedUid, platform);
  if (!existing) {
    assertNoOrphanRollbackBackup(path, expectedUid, platform, options);
    throw new Error("the admin key file does not exist");
  }
  if (platform !== "win32" && (existing.mode & 0o777) !== 0o600) {
    throw new Error("the admin key file must be readable only by the current user");
  }

  const loaded = (options.readFile ?? readFileSync)(path);
  const bytes = Buffer.isBuffer(loaded) ? Buffer.from(loaded) : Buffer.from(String(loaded), "utf8");
  try {
    return decodeAdminKeyPayload(bytes, platform, options);
  } finally {
    bytes.fill(0);
  }
}

function assertPrivateIdentity(identity, expectedUid, platform, label) {
  if (!identity?.isFile() || identity.isSymbolicLink?.() || identity.nlink !== 1) {
    throw new Error(`the admin key ${label} must be a private regular file with no hard links`);
  }
  if (platform !== "win32" &&
      (identity.uid !== expectedUid || (identity.mode & 0o777) !== 0o600)) {
    throw new Error(`the admin key ${label} is not private to the current user`);
  }
}

function readIdentityBytes(path, identity, expectedUid, platform, options, phase, requirePrivate = true) {
  let descriptor;
  let loaded;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const current = fstatSync(descriptor);
    if (!sameFile(current, identity)) {
      throw new Error(`the admin key ${phase} identity changed before verification`);
    }
    if (requirePrivate) {
      assertPrivateIdentity(current, expectedUid, platform, phase);
    } else if (!current.isFile() || current.nlink !== 1 ||
        (platform !== "win32" && current.uid !== expectedUid)) {
      throw new Error(`the admin key ${phase} is not a safe regular file`);
    }
    try {
      const readForVerification = options.readFileForVerification ??
        ((_path, fd) => readFileSync(fd));
      loaded = readForVerification(path, descriptor, phase);
    } catch {
      throw new Error(`the admin key ${phase} payload could not be read safely`);
    }
    const bytes = Buffer.isBuffer(loaded)
      ? Buffer.from(loaded)
      : Buffer.from(String(loaded ?? ""), "utf8");
    if (!bytes.length || bytes.length > MAX_ADMIN_KEY_FILE_BYTES) {
      bytes.fill(0);
      throw new Error(`the admin key ${phase} payload has an invalid size`);
    }
    return bytes;
  } finally {
    if (Buffer.isBuffer(loaded)) loaded.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the verification error. */ }
    }
  }
}

function verifySecretPayload(path, identity, secret, expectedUid, platform, options, phase) {
  const bytes = readIdentityBytes(path, identity, expectedUid, platform, options, phase);
  try {
    let decoded;
    try {
      decoded = decodeAdminKeyPayload(bytes, platform, options);
    } catch {
      throw new Error(`the admin key ${phase} payload could not be decoded and verified`);
    }
    if (decoded !== secret) {
      throw new Error(`the admin key ${phase} payload did not read back exactly`);
    }
  } finally {
    bytes.fill(0);
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("the admin key write made no progress");
    offset += written;
  }
}

function createPrivatePayloadFile(path, bytes, expectedUid, platform, username, options, label) {
  let descriptor;
  let identity;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1 ||
        (platform !== "win32" && identity.uid !== expectedUid)) {
      throw new Error(`the admin key ${label} path was not created as a private regular file`);
    }

    // On Windows no payload byte is written until this exact empty identity has
    // a current-user ACL. The payload is DPAPI ciphertext for a new key, and an
    // independently protected ciphertext for a rollback backup.
    chmodSync(path, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    if (platform === "win32") {
      let result;
      try {
        result = (options.runAcl ?? defaultAcl)([
          path, "/inheritance:r", "/grant:r", `${username}:F`,
        ]);
      } catch {
        throw new Error(`Windows could not restrict the admin key ${label} to the current user`);
      }
      if (result?.status !== 0) {
        throw new Error(`Windows could not restrict the admin key ${label} to the current user`);
      }
    }

    descriptor = openSync(path, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0));
    const secured = fstatSync(descriptor);
    if (!sameFile(secured, identity)) {
      throw new Error(`the secured admin key ${label} identity changed before its payload was written`);
    }
    assertPrivateIdentity(secured, expectedUid, platform, label);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return identity;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the persistence error. */ }
    }
    if (identity) removeIfSame(path, identity);
    throw error;
  }
}

function verifyRawCopy(path, identity, expected, expectedUid, platform, options, phase) {
  const actual = readIdentityBytes(path, identity, expectedUid, platform, options, phase);
  try {
    if (!actual.equals(expected)) {
      throw new Error(`the admin key ${phase} did not preserve the prior credential exactly`);
    }
  } finally {
    actual.fill(0);
  }
}

function directorySyncUnsupported(error, platform) {
  const portable = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
  if (portable.has(error?.code)) return true;
  return platform === "win32" &&
    new Set(["EACCES", "EBADF", "EISDIR", "EPERM"]).has(error?.code);
}

function fsyncParent(path, platform, options, phase, required = true) {
  let descriptor;
  let failure;
  try {
    if (options.syncParentDirectory) {
      options.syncParentDirectory(dirname(path), phase);
    } else {
      descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
      fsyncSync(descriptor);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (error) { failure ||= error; }
    }
  }
  if (!failure) return true;
  if (directorySyncUnsupported(failure, platform)) return false;
  if (required) {
    throw new Error(`the admin key ${phase} directory state could not be synchronized safely`);
  }
  return false;
}

/**
 * Remove only old, exact transaction artifacts created by this module. A
 * backup is never removed while the durable destination is absent.
 */
export function cleanupAdminKeyFileResidue(destination, options = {}) {
  const path = assertAdminKeyPath(destination);
  const platform = options.platform ?? process.platform;
  const getUid = options.getUid ?? process.getuid;
  const expectedUid = platform !== "win32" && typeof getUid === "function" ? getUid() : null;
  assertParent(path, expectedUid, platform, options);
  const durable = assertExistingDestination(path, expectedUid, platform);
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.residueMaxAgeMs ?? DEFAULT_RESIDUE_MAX_AGE_MS;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return Object.freeze([]);
  }

  // Node does not expose a portable current-owner/current-user-ACL identity
  // check for Windows files. Leaving these rare, gitignored artifacts in place
  // is safer than deleting a matching name that this process cannot prove it
  // owns. Normal Windows transactions still remove their exact live artifacts.
  if (platform === "win32") return Object.freeze([]);

  let names;
  try {
    names = (options.readDirectory ?? readdirSync)(dirname(path));
  } catch {
    return Object.freeze([]);
  }
  const hasBackupCandidate = names.some((name) => {
    const match = String(name).match(RESIDUE_NAME);
    return match?.[1] === "bak";
  });
  let durableVerified = false;
  if (durable && hasBackupCandidate) {
    let durableBytes;
    try {
      durableBytes = readIdentityBytes(
        path, durable, expectedUid, platform, options, "durable residue guard",
      );
      decodeAdminKeyPayload(durableBytes, platform, options);
      durableVerified = true;
    } catch {
      durableVerified = false;
    } finally {
      if (durableBytes) durableBytes.fill(0);
    }
  }
  const removed = [];
  for (const name of names) {
    const match = String(name).match(RESIDUE_NAME);
    if (!match || (match[1] === "bak" && !durableVerified)) continue;
    const candidate = join(dirname(path), String(name));
    const identity = lstatIfPresent(candidate);
    if (!identity || identity.isSymbolicLink() || !identity.isFile() ||
        identity.nlink !== 1 || identity.size > MAX_ADMIN_KEY_FILE_BYTES ||
        !Number.isFinite(identity.mtimeMs) || nowMs - identity.mtimeMs < maxAgeMs) {
      continue;
    }
    if (platform !== "win32" &&
        (identity.uid !== expectedUid || (identity.mode & 0o777) !== 0o600)) {
      continue;
    }
    if (removeIfSame(candidate, identity)) removed.push(candidate);
  }
  return Object.freeze(removed);
}

export function writeAdminKeyFile(destination, secret, options = {}) {
  validateAdminKeyValue(secret);
  const validation = validateAdminKeyFileDestination(destination, options);
  const path = validation.path;
  const platform = options.platform ?? process.platform;
  const getUid = options.getUid ?? process.getuid;
  const expectedUid = platform !== "win32" && typeof getUid === "function" ? getUid() : null;
  const username = platform === "win32" ? options.username : null;

  // Exact, old transaction artifacts are cleaned only after the destination
  // and parent have passed the same safety checks as this write.
  cleanupAdminKeyFileResidue(path, { ...options, platform });
  const prior = assertExistingDestination(path, expectedUid, platform);

  const entropy = (options.randomBytes ?? randomBytes)(8);
  const suffix = Buffer.from(entropy).toString("hex");
  if (!/^[0-9a-f]{16}$/.test(suffix)) {
    throw new TypeError("admin key staging entropy must contain exactly 8 bytes");
  }
  const temporary = join(dirname(path), `..brain-admin-key.${process.pid}.${suffix}.tmp`);
  const backup = join(dirname(path), `..brain-admin-key.${process.pid}.${suffix}.bak`);
  const bytes = platform === "win32"
    ? protectAdminKeyForWindows(secret, options)
    : Buffer.from(`${secret}\n`, "utf8");
  let stagedIdentity;
  let backupIdentity;
  let priorBytes;
  let backupBytes;
  let priorSecret;
  let committed = false;
  const rename = options.rename ?? renameSync;
  try {
    stagedIdentity = createPrivatePayloadFile(
      temporary, bytes, expectedUid, platform, username, options, "staging",
    );
    verifySecretPayload(
      temporary, stagedIdentity, secret, expectedUid, platform, options, "staged",
    );

    // Refuse a destination swap between validation and commit. The parent is
    // already required to be user-owned and not writable by anyone else on
    // POSIX, but this identity check also makes the invariant explicit.
    const currentPrior = lstatIfPresent(path);
    if ((prior === null) !== (currentPrior === null) ||
        (prior && !sameFile(prior, currentPrior))) {
      throw new Error("the admin key destination changed while it was being prepared");
    }

    // Preserve exact prior bytes in a second private identity before replacing
    // the destination. This backup is never the destination during the normal
    // path, so the state-changing rename remains atomic.
    if (prior) {
      priorBytes = readIdentityBytes(
        path, prior, expectedUid, platform, options, "prior snapshot", false,
      );
      priorSecret = decodeAdminKeyPayload(priorBytes, platform, options);
      backupBytes = platform === "win32"
        ? protectAdminKeyForWindows(priorSecret, options)
        : Buffer.from(priorBytes);
      backupIdentity = createPrivatePayloadFile(
        backup, backupBytes, expectedUid, platform, username, options, "rollback backup",
      );
      if (platform === "win32") {
        verifySecretPayload(
          backup, backupIdentity, priorSecret, expectedUid, platform, options, "rollback backup",
        );
      } else {
        verifyRawCopy(
          backup, backupIdentity, backupBytes, expectedUid, platform, options, "rollback backup",
        );
      }
    }

    const finalPrior = lstatIfPresent(path);
    if ((prior === null) !== (finalPrior === null) ||
        (prior && !sameFile(prior, finalPrior))) {
      throw new Error("the admin key destination changed before replacement");
    }
    // Make the fully written staging entry and, when present, its verified
    // rollback entry durable before the state-changing replacement. Filesystems
    // that do not support directory fsync retain their platform guarantees.
    fsyncParent(path, platform, options, "prepared");
    try {
      rename(temporary, path);
    } catch {
      throw new Error("the admin key replacement could not be committed");
    }
    committed = true;
    verifySecretPayload(
      path, stagedIdentity, secret, expectedUid, platform, options, "persisted",
    );
    fsyncParent(path, platform, options, "persisted");

    if (backupIdentity) {
      if (!removeIfSame(backup, backupIdentity)) {
        throw new Error("the prior admin key rollback backup could not be removed safely");
      }
      backupIdentity = undefined;
      fsyncParent(path, platform, options, "backup cleanup", false);
    }
    return Object.freeze({ path, replaced: prior !== null });
  } catch (error) {
    if (!committed) {
      if (stagedIdentity) removeIfSame(temporary, stagedIdentity);
      if (backupIdentity) removeIfSame(backup, backupIdentity);
      throw error;
    }

    let restored = false;
    if (prior && backupIdentity && priorSecret) {
      try {
        const current = lstatIfPresent(path);
        const saved = lstatIfPresent(backup);
        if (!sameFile(current, stagedIdentity) || !sameFile(saved, backupIdentity)) {
          throw new Error("transaction identities changed");
        }
        rename(backup, path);
        const restoredIdentity = lstatIfPresent(path);
        if (!sameFile(restoredIdentity, backupIdentity)) {
          throw new Error("rollback identity did not become durable");
        }
        verifySecretPayload(
          path, restoredIdentity, priorSecret, expectedUid, platform, options, "rollback",
        );
        backupIdentity = undefined;
        restored = true;
        fsyncParent(path, platform, options, "rollback");
      } catch {
        restored = false;
      }
    } else if (!prior) {
      restored = removeIfSame(path, stagedIdentity) && lstatIfPresent(path) === null;
      if (restored) {
        try {
          fsyncParent(path, platform, options, "absence rollback");
        } catch {
          restored = false;
        }
      }
    }

    if (restored) {
      throw new Error(
        prior
          ? "the replacement admin key was not verified; the prior admin key was restored and verified"
          : "the replacement admin key was not verified; no admin key destination was left behind",
      );
    }
    throw new Error(
      "the replacement admin key was not verified and rollback could not be verified; a protected transaction artifact was retained",
    );
  } finally {
    bytes.fill(0);
    if (priorBytes) priorBytes.fill(0);
    if (backupBytes) backupBytes.fill(0);
  }
}
