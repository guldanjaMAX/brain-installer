/**
 * Durable ADMIN_KEY rotation for the storage declared by a brain manifest.
 *
 * The Worker write is deliberately owned by brain.mjs. This module owns the
 * durable desired-state half that is verified before the state-changing Worker
 * write: an adjacent protected file, or a manifest-declared macOS Keychain item.
 * Keychain values travel only through child stdin and every child receives a
 * small allowlisted environment.
 */

import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  readAdminKeyFile,
  validateAdminKeyValue,
  validateAdminKeyFileDestination,
  writeAdminKeyFile,
} from "./admin-key-file.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPECT_PATH = "/usr/bin/expect";
const DEFAULT_SECURITY_PATH = "/usr/bin/security";
const DEFAULT_EXPECT_SCRIPT_PATH = resolve(HERE, "../connectors/keychain-write.exp");
const MAX_KEYCHAIN_OUTPUT_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const KEYCHAIN_ENV_ALLOWLIST = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
]);

function adminKeyBytes(secret) {
  validateAdminKeyValue(secret);
  return Buffer.from(secret, "utf8");
}

/** Return the only environment macOS Keychain helper children may inherit. */
export function keychainChildEnvironment(environment = process.env) {
  const clean = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of KEYCHAIN_ENV_ALLOWLIST) {
    const value = environment?.[name];
    if (typeof value === "string" && value) clean[name] = value;
  }
  return clean;
}

/** Parse the non-secret Keychain locator allowed in operations.admin_key_secret. */
export function parseAdminKeySecretReference(reference) {
  const text = String(reference ?? "");
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
  const invalid = (value) =>
    !value || value.length > 1024 || /[?#\0-\x1f\x7f]/.test(value);
  if (invalid(service) || invalid(account)) {
    throw new Error(
      "operations.admin_key_secret must name a Keychain service and account without controls, a query, or a fragment",
    );
  }
  return Object.freeze({ backend: "keychain", service, account });
}

/**
 * Resolve and validate the manifest's durable ADMIN_KEY destination without
 * touching it. A declared locator is never silently replaced by a file.
 */
export function adminKeyPersistencePlan(manifestPath, manifest, options = {}) {
  if (typeof manifestPath !== "string" || !manifestPath) {
    throw new TypeError("a manifest path is required to persist the admin key");
  }
  const platform = options.platform ?? process.platform;
  const reference = manifest?.operations?.admin_key_secret;
  if (reference === undefined || reference === null) {
    const path = join(dirname(resolve(manifestPath)), ".brain-admin-key");
    const validate = options.validateAdminKeyDestination ?? validateAdminKeyFileDestination;
    const validation = validate(path, { ...options, platform });
    return Object.freeze({
      backend: "file",
      path,
      platform,
      replaced: validation?.replaced === true,
    });
  }

  const locator = parseAdminKeySecretReference(reference);
  if (platform !== "darwin") {
    throw new Error("keychain:// admin key storage is supported only on macOS");
  }
  return Object.freeze({ ...locator, platform });
}

function childResultBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value), "utf8");
}

function wipeResult(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

function keychainNotFound(result) {
  return result?.status === 44 ||
    /could not be found|item not found/i.test(String(result?.stderr || ""));
}

function processRunner(options) {
  return options.runChild ?? spawnSync;
}

function childOptions(options, input = undefined) {
  return {
    encoding: null,
    env: keychainChildEnvironment(options.environment),
    input,
    maxBuffer: MAX_KEYCHAIN_OUTPUT_BYTES,
    shell: false,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 15_000,
    windowsHide: true,
  };
}

function assertSecretOutsideMetadata(secret, command, args, environment) {
  const metadata = [command, ...args, ...Object.entries(environment).flat()].join("\0");
  if (metadata.includes(secret)) {
    throw new Error("refusing to expose the admin key through child process metadata");
  }
}

/** Read one admin-key Keychain item without printing it. Null means absent. */
export function readAdminKeyFromKeychain(locator, options = {}) {
  if (locator?.backend !== "keychain" || !locator.service || !locator.account) {
    throw new TypeError("a parsed admin-key Keychain locator is required");
  }
  const command = options.securityPath ?? DEFAULT_SECURITY_PATH;
  const args = [
    "find-generic-password",
    "-s", locator.service,
    "-a", locator.account,
    "-w",
  ];
  const runOptions = childOptions(options);
  const result = processRunner(options)(command, args, runOptions);
  let stdout;
  let stderr;
  try {
    stdout = childResultBuffer(result?.stdout);
    stderr = childResultBuffer(result?.stderr);
    if (result?.status !== 0 || result?.error) {
      if (keychainNotFound({ ...result, stderr })) return null;
      if (result?.error?.code === "ETIMEDOUT") {
        const seconds = Math.round((options.timeoutMs ?? 15_000) / 1000);
        throw new Error(`reading the macOS Keychain admin key timed out after ${seconds} seconds`);
      }
      throw new Error("macOS Keychain could not read the declared admin key item");
    }
    if (!stdout.length || stdout.length > MAX_KEYCHAIN_OUTPUT_BYTES) {
      throw new Error("the declared macOS Keychain admin key item is empty or oversized");
    }
    let end = stdout.length;
    if (end > 0 && stdout[end - 1] === 0x0a) end--;
    if (end > 0 && stdout[end - 1] === 0x0d) end--;
    const value = Buffer.from(stdout.subarray(0, end));
    try {
      const decoded = UTF8_DECODER.decode(value);
      if (!decoded || /[\r\n\0]/.test(decoded)) {
        throw new Error("the declared macOS Keychain admin key item is not a single-line value");
      }
      return decoded;
    } finally {
      value.fill(0);
    }
  } finally {
    if (stdout && stdout !== result?.stdout) stdout.fill(0);
    if (stderr && stderr !== result?.stderr) stderr.fill(0);
    wipeResult(result);
  }
}

function writeKeychainValue(locator, secret, options) {
  const command = options.expectPath ?? DEFAULT_EXPECT_PATH;
  const securityPath = options.securityPath ?? DEFAULT_SECURITY_PATH;
  const helper = options.expectScriptPath ?? DEFAULT_EXPECT_SCRIPT_PATH;
  const args = [
    helper,
    securityPath,
    "add-generic-password", "-U",
    "-s", locator.service,
    "-a", locator.account,
    "-D", "application password",
    "-j", "Brain Installer admin key",
    // keychain-write.exp supplies this prompt through its private pseudo-tty.
    "-w",
  ];
  const secretBytes = Buffer.from(secret, "utf8");
  const input = Buffer.alloc(secretBytes.length + 1);
  secretBytes.copy(input);
  input[input.length - 1] = 0x0a;
  secretBytes.fill(0);
  const runOptions = childOptions(options, input);
  assertSecretOutsideMetadata(secret, command, args, runOptions.env);
  let result;
  try {
    result = processRunner(options)(command, args, runOptions);
    if (result?.status !== 0 || result?.error) {
      throw new Error("macOS Keychain could not update the declared admin key item");
    }
  } finally {
    input.fill(0);
    wipeResult(result);
  }
}

function deleteKeychainValue(locator, options) {
  const command = options.securityPath ?? DEFAULT_SECURITY_PATH;
  const args = [
    "delete-generic-password",
    "-s", locator.service,
    "-a", locator.account,
  ];
  const result = processRunner(options)(command, args, childOptions(options));
  try {
    if ((result?.status !== 0 || result?.error) && !keychainNotFound(result)) {
      throw new Error("macOS Keychain could not remove the failed admin key item");
    }
  } finally {
    wipeResult(result);
  }
}

function sameSecret(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function restoreKeychainValue(locator, prior, options) {
  if (prior === null) {
    deleteKeychainValue(locator, options);
    return readAdminKeyFromKeychain(locator, options) === null;
  }
  writeKeychainValue(locator, prior, options);
  const restored = readAdminKeyFromKeychain(locator, options);
  return restored !== null && sameSecret(restored, prior);
}

/**
 * Replace and verify one Keychain item. Any write or verification failure makes
 * a best-effort attempt to restore the exact prior item (or prior absence).
 */
export function writeAdminKeyToKeychain(locator, secret, options = {}) {
  const checked = adminKeyBytes(secret);
  checked.fill(0);
  const prior = readAdminKeyFromKeychain(locator, options);
  try {
    writeKeychainValue(locator, secret, options);
    const verified = readAdminKeyFromKeychain(locator, options);
    if (verified === null || !sameSecret(verified, secret)) {
      throw new Error("macOS Keychain did not read back the updated admin key exactly");
    }
    return Object.freeze({
      backend: "keychain",
      service: locator.service,
      account: locator.account,
      replaced: prior !== null,
      verified: true,
    });
  } catch {
    let restored = false;
    try {
      restored = restoreKeychainValue(locator, prior, options);
    } catch {
      restored = false;
    }
    throw new Error(
      restored
        ? "macOS Keychain could not persist and verify the new admin key; the prior item was restored"
        : "macOS Keychain could not persist and verify the new admin key; rollback could not be verified",
    );
  }
}

/** Read the desired ADMIN_KEY from a validated durable storage plan. */
export function readAdminKeyDurably(plan, options = {}) {
  let value;
  if (plan?.backend === "keychain") {
    value = readAdminKeyFromKeychain(plan, options);
    if (value === null) return null;
  } else if (plan?.backend === "file" && plan.path) {
    const platform = options.platform ?? plan.platform ?? process.platform;
    const exists = options.exists ?? existsSync;
    const validate = options.validateAdminKeyDestination ?? validateAdminKeyFileDestination;
    if (!exists(plan.path)) {
      // A missing destination is clean only after the same preflight proves
      // there is no orphan rollback backup from an interrupted transaction.
      validate(plan.path, { ...options, platform });
      return null;
    }
    const readFile = options.readAdminKey ?? readAdminKeyFile;
    value = readFile(plan.path, {
      ...options,
      platform,
    });
  } else {
    throw new TypeError("a validated durable admin-key storage plan is required");
  }
  const checked = adminKeyBytes(value);
  checked.fill(0);
  return value;
}

/** Persist and read back the exact ADMIN_KEY using a validated storage plan. */
export function persistAdminKeyDurably(plan, secret, options = {}) {
  const checked = adminKeyBytes(secret);
  checked.fill(0);
  if (plan?.backend === "keychain") {
    return writeAdminKeyToKeychain(plan, secret, options);
  }
  if (plan?.backend !== "file" || !plan.path) {
    throw new TypeError("a validated durable admin-key storage plan is required");
  }

  const platform = options.platform ?? plan.platform ?? process.platform;
  const fileOptions = { ...options, platform };
  const writeFile = options.writeAdminKey ?? writeAdminKeyFile;
  const readFile = options.readAdminKey ?? readAdminKeyFile;
  const writeReceipt = writeFile(plan.path, secret, fileOptions);
  const verified = readFile(plan.path, fileOptions);
  if (!sameSecret(verified, secret)) {
    throw new Error("the adjacent admin key file did not read back the updated key exactly");
  }
  return Object.freeze({
    backend: "file",
    path: plan.path,
    replaced: writeReceipt?.replaced === true,
    verified: true,
  });
}
