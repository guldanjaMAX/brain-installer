// cloudflare-token-store — remember the Cloudflare token per machine, per
// account, so provisioning prompts for it once rather than every run.
//
// The admin key already earned this treatment (admin-key-persistence.mjs);
// the Cloudflare token was the last credential still typed on every setup and
// upgrade. Same rules apply here, learned there:
//
//   The secret NEVER appears in argv. Reads capture `security`'s stdout in
//   memory and zero every intermediate buffer; writes go through
//   connectors/keychain-write.exp, which feeds the value to `security` on a
//   private pseudo-tty precisely so `ps` and shell history never see it.
//
//   Storage is per Cloudflare ACCOUNT, not global. One operator machine can
//   hold tokens for several accounts (the owner's own, plus engagements), and
//   an install must never provision with a neighbouring account's token.
//
//   macOS only, deliberately. Elsewhere this module reports unsupported and
//   the existing paths (CLOUDFLARE_API_TOKEN from a secret manager, or the
//   hidden prompt) continue unchanged.
//
// Multi-machine is BY DESIGN one paste per machine: keychains are not
// transferred, and the better practice is a fresh token per machine so any
// single computer can be revoked alone. Handoff revocation has a local half —
// `brain token <manifest> --forget` — because a revoked token lingering in a
// keychain is clutter pretending to be capability.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { keychainChildEnvironment } from "./admin-key-persistence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SECURITY_PATH = "/usr/bin/security";
const DEFAULT_EXPECT_PATH = "/usr/bin/expect";
const DEFAULT_EXPECT_SCRIPT = join(HERE, "..", "connectors", "keychain-write.exp");
const SERVICE = "brain-cloudflare-token";
const MAX_OUTPUT_BYTES = 4096;

function runner(options) {
  return options.processRunner ?? ((command, args, runOptions) => spawnSync(command, args, runOptions));
}

function supported(options) {
  return (options.platform ?? process.platform) === "darwin";
}

function accountLabel(accountId) {
  const label = String(accountId || "").trim().toLowerCase();
  return /^[a-f0-9]{16,64}$/.test(label) ? label : "default";
}

/** Non-secret description of where a token would live, for status output. */
export function storedTokenReference(accountId) {
  return `macOS Keychain, service ${SERVICE}, account ${accountLabel(accountId)}`;
}

function toBuffer(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
}

/**
 * Load a stored token. Returns a Buffer the CALLER must zero after use, or
 * null when nothing is stored (or the platform has no keychain). A keychain
 * failure other than not-found throws: silently degrading to a prompt would
 * hide a broken keychain behind an every-time prompt, the exact symptom this
 * module exists to remove.
 */
export function loadStoredCloudflareToken(accountId, options = {}) {
  if (!supported(options)) return null;
  const result = runner(options)(
    options.securityPath ?? DEFAULT_SECURITY_PATH,
    ["find-generic-password", "-s", SERVICE, "-a", accountLabel(accountId), "-w"],
    { env: keychainChildEnvironment(options.environment), timeout: options.timeoutMs ?? 15_000 },
  );
  const stdout = toBuffer(result?.stdout);
  const stderr = toBuffer(result?.stderr);
  try {
    if (result?.status !== 0 || result?.error) {
      const text = stderr.toString("utf8");
      if (/could not be found|SecKeychainSearchCopyNext/i.test(text) || result?.status === 44) return null;
      throw new Error("the macOS Keychain could not read the stored Cloudflare token");
    }
    if (!stdout.length || stdout.length > MAX_OUTPUT_BYTES) {
      throw new Error("the stored Cloudflare token item is empty or oversized");
    }
    let end = stdout.length;
    if (end > 0 && stdout[end - 1] === 0x0a) end--;
    if (end > 0 && stdout[end - 1] === 0x0d) end--;
    return Buffer.from(stdout.subarray(0, end));
  } finally {
    stdout.fill(0);
    stderr.fill(0);
    if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
    if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
  }
}

/**
 * Store a token for an account. The value travels on the helper's stdin —
 * never argv — exactly like the admin key write. `-U` updates in place so
 * re-storing a rotated token needs no forget first.
 */
export function storeCloudflareToken(accountId, token, options = {}) {
  if (!supported(options)) {
    throw new Error("storing the Cloudflare token is supported only in the macOS Keychain");
  }
  // Always a private copy: the caller keeps ownership of its buffer (it still
  // needs the token for the provisioning run this store rides along with).
  const secret = Buffer.from(toBuffer(token));
  try {
    if (!secret.length) throw new Error("an empty Cloudflare token cannot be stored");
    const result = runner(options)(
      options.expectPath ?? DEFAULT_EXPECT_PATH,
      [
        options.expectScriptPath ?? DEFAULT_EXPECT_SCRIPT,
        options.securityPath ?? DEFAULT_SECURITY_PATH,
        "add-generic-password", "-U",
        "-s", SERVICE,
        "-a", accountLabel(accountId),
        "-D", "application password",
        "-j", "Brain Installer Cloudflare token",
        "-w",
      ],
      {
        env: keychainChildEnvironment(options.environment),
        input: Buffer.concat([secret, Buffer.from("\n")]),
        timeout: options.timeoutMs ?? 20_000,
      },
    );
    if (result?.status !== 0 || result?.error) {
      throw new Error("the macOS Keychain refused to store the Cloudflare token");
    }
  } finally {
    secret.fill(0);
  }
}

/** Delete a stored token. Returns true when something was removed. */
export function forgetCloudflareToken(accountId, options = {}) {
  if (!supported(options)) return false;
  const result = runner(options)(
    options.securityPath ?? DEFAULT_SECURITY_PATH,
    ["delete-generic-password", "-s", SERVICE, "-a", accountLabel(accountId)],
    { env: keychainChildEnvironment(options.environment), timeout: options.timeoutMs ?? 15_000 },
  );
  if (result?.status === 0) return true;
  const text = toBuffer(result?.stderr).toString("utf8");
  if (/could not be found|SecKeychainSearchCopyNext/i.test(text) || result?.status === 44) return false;
  throw new Error("the macOS Keychain could not delete the stored Cloudflare token");
}

/** True when a token is stored for this account, without exposing the value. */
export function hasStoredCloudflareToken(accountId, options = {}) {
  const value = loadStoredCloudflareToken(accountId, options);
  if (value === null) return false;
  value.fill(0);
  return true;
}
