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

const WINDOWS_DPAPI_HEADER = Buffer.from("BRAIN-ADMIN-KEY-DPAPI-V1\n", "ascii");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_ADMIN_KEY_FILE_BYTES = 64 * 1024;
const DEFAULT_RESIDUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESIDUE_NAME = /^\.\.brain-admin-key\.\d+\.[0-9a-f]{16}\.(tmp|bak)$/;

// The scripts are fixed command-line metadata. The value being protected is
// read as raw bytes from redirected stdin, never interpolated into the script,
// argv, or the child environment. Raw stdout also avoids PowerShell's text
// encoding and newline behavior changing either the ciphertext or plaintext.
// CurrentUser binds portability to this Windows profile; it does not attempt to
// defend against an administrator or malicious code already running as it.
const DPAPI_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[int]$expectedLength = __BRAIN_INPUT_LENGTH__
[byte[]]$plain = $null
[byte[]]$protectedBytes = $null
try {
  if ($expectedLength -lt 1) { throw 'DPAPI input length is invalid' }
  $inputStream = [Console]::OpenStandardInput()
  $plain = New-Object byte[] $expectedLength
  $offset = 0
  while ($offset -lt $expectedLength) {
    $read = $inputStream.Read($plain, $offset, $expectedLength - $offset)
    if ($read -le 0) { throw 'DPAPI input ended before the declared length' }
    $offset += $read
  }
  $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $output = [Console]::OpenStandardOutput()
  $output.Write($protectedBytes, 0, $protectedBytes.Length)
  $output.Flush()
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
}
`;

const DPAPI_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[int]$expectedLength = __BRAIN_INPUT_LENGTH__
[byte[]]$protectedBytes = $null
[byte[]]$plain = $null
try {
  if ($expectedLength -lt 1) { throw 'DPAPI input length is invalid' }
  $inputStream = [Console]::OpenStandardInput()
  $protectedBytes = New-Object byte[] $expectedLength
  $offset = 0
  while ($offset -lt $expectedLength) {
    $read = $inputStream.Read($protectedBytes, $offset, $expectedLength - $offset)
    if ($read -le 0) { throw 'DPAPI input ended before the declared length' }
    $offset += $read
  }
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $output = [Console]::OpenStandardOutput()
  $output.Write($plain, 0, $plain.Length)
  $output.Flush()
} finally {
  if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
}
`;

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

function windowsPowerShellRuntime() {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
  if (!systemRoot) {
    // Cross-platform unit tests inject the runner and never execute this name.
    // A real Windows process should always have SystemRoot; refusing to inherit
    // PATH here is safer than forwarding a possibly secret-bearing environment.
    if (process.platform === "win32") {
      throw new Error("Windows could not locate its system PowerShell executable");
    }
    return { command: "powershell.exe", env: {} };
  }
  const env = { SystemRoot: systemRoot };
  for (const name of ["TEMP", "TMP"]) {
    if (typeof process.env[name] === "string" && process.env[name]) env[name] = process.env[name];
  }
  return {
    command: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    env,
  };
}

function runWindowsDpapi(script, input, options, operation, secretForMetadataCheck = null) {
  const { command, env } = windowsPowerShellRuntime();
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 64 * 1024) {
    throw new Error("Windows DPAPI received an invalid admin key payload size");
  }
  const commandScript = script.replace("__BRAIN_INPUT_LENGTH__", String(input.length));
  if (commandScript === script || commandScript.includes("__BRAIN_INPUT_LENGTH__")) {
    throw new Error("Windows DPAPI input framing could not be prepared safely");
  }
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", commandScript,
  ];
  if (secretForMetadataCheck) {
    const metadata = [command, ...args, ...Object.entries(env).flat()].join("\0");
    const encodedSecret = Buffer.from(secretForMetadataCheck, "utf8").toString("base64");
    if (metadata.includes(secretForMetadataCheck) || metadata.includes(encodedSecret)) {
      throw new Error("Windows refused to expose the admin key in PowerShell process metadata");
    }
  }
  const result = (options.runPowerShell ?? spawnSync)(command, args, {
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
    // Never include stderr or the child error object: either may retain child
    // process data, and the caller only needs the safe recovery boundary.
    if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
    if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
    throw new Error(
      operation === "protect"
        ? "Windows could not protect the admin key with DPAPI; the prior key was left untouched"
        : "Windows could not decrypt the admin key with DPAPI for the current user",
    );
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

function protectAdminKeyForWindows(secret, options) {
  const plain = Buffer.from(secret, "utf8");
  let protectedBytes;
  try {
    protectedBytes = runWindowsDpapi(DPAPI_PROTECT_SCRIPT, plain, options, "protect", secret);
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
      plain = runWindowsDpapi(DPAPI_UNPROTECT_SCRIPT, protectedBytes, options, "unprotect");
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
