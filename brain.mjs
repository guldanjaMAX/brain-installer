#!/usr/bin/env node
/**
 * brain — provision and manage a client-owned brain install.
 *
 *   brain verify      <manifest>   check the token and resolve the account
 *   brain provision   <manifest>   create D1 (and R2/KV), write IDs back
 *   brain deploy      <manifest>   upload the worker with its bindings
 *   brain secrets     <manifest>   set secrets and persist ADMIN_KEY rotation
 *   brain health      <manifest>   prove the install actually works
 *
 * DESIGN RULES
 *
 * Everything runs against the CLIENT's Cloudflare account using a scoped token
 * the client issued. We never hold their data and the token is revoked at
 * handoff, so this tool must work from a standing start with nothing but that
 * token and a manifest.
 *
 * The account id is RESOLVED FROM THE TOKEN, never hardcoded and never taken
 * from the manifest as gospel. A token that can see two accounts is ambiguous
 * and must fail loudly rather than provision into the wrong one, because
 * provisioning into the wrong account is the one mistake with no clean undo.
 *
 * Every step is idempotent: re-running finds existing resources by name and
 * adopts them rather than creating duplicates. An installer you are afraid to
 * re-run is an installer you will not use.
 *
 * The token is read from CLOUDFLARE_API_TOKEN for automation or from a hidden,
 * command-scoped terminal prompt for setup/update. It is never written to the
 * manifest, logged, or passed as a command-line argument where `ps` could read it.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { assertIngestionOutcome, ingestionOutcome } from "./ingest/outcome.mjs";
// The ingest pipeline is loaded LAZILY, inside the commands that use it. It
// pulls in the PDF/Office dependencies at import time, so a top-level import
// meant that on a clone without node_modules the very first command, including
// `brain doctor` whose whole job is diagnosing that machine, crashed with
// ERR_MODULE_NOT_FOUND before it could say anything useful.
async function ingestLib() {
  try {
    return await import("./ingest/run.mjs");
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      die(
        "the ingest dependencies are not installed. From the brain-installer folder run:\n" +
          "        npm ci --ignore-scripts\n" +
          "      then re-run this command."
      );
    }
    throw e;
  }
}
/**
 * The OCR policy module, loaded the same lazy way and for the same reason: it
 * imports the PDF format reader for the one constant it shares with it.
 */
async function ingestOcrLib() {
  return await import("./ingest/ocr.mjs");
}
import { authorize, loadTokens, saveTokens, createTokenProvider, tokenStorageDescription, SCOPES, DEFAULT_PORT } from "./connectors/google-auth.mjs";
import {
  redact as redactConfirmedSecrets,
  scanEnvelope as scanEnvelopeSecrets,
  sanitizeEnvelope as sanitizeIngestEnvelope,
  GATE_VERSION as CREDENTIAL_GATE_VERSION,
} from "./worker/src/lib/secret-scan.js";
import { cloudflareCliEnvironment, localToolEnvironment, run } from "./doctor.mjs";
import {
  runAll as doctorRunAll,
  summarize as doctorSummarize,
  checkBankFeedRedirect,
  checkClaudeCode,
  checkWrangler,
  OK as D_OK,
  WARN as D_WARN,
  FAIL as D_FAIL,
  VECTORIZE_REMEDY,
  CF_TOKEN_REJECTED_REMEDY,
  isCredentialRejection,
} from "./doctor.mjs";
import {
  SUPPORT_MAX_AGE_DAYS,
  SUPPORT_MAX_BYTES,
  SUPPORT_MAX_EVENTS,
  SUPPORT_ERROR_CODES,
  clearSupportJournal,
  exportSupportJournal,
  previewSupportJournal,
  productRelativeFingerprint,
  recordSupportEvent,
} from "./support-journal.mjs";
import { renderSupportRecovery, supportRecovery } from "./support-recovery.mjs";
import { readAdminKeyFile, validateAdminKeyValue } from "./operations/admin-key-file.mjs";
import { writeClaudeWorkspaceGuide } from "./operations/claude-workspace.mjs";
import { installClaudeTechnicianSkill } from "./operations/claude-skill.mjs";
import {
  loadStoredCloudflareToken,
  storeCloudflareToken,
  forgetCloudflareToken,
  hasStoredCloudflareToken,
  storedTokenReference,
} from "./operations/cloudflare-token-store.mjs";
import { deriveRagProxyKey } from "./operations/rag-proxy-key.mjs";
import { deriveSessionSigningKey } from "./operations/session-signing-key.mjs";
import {
  renderTechnicianPlan,
  runTechnicianStep,
  technicianPlan,
} from "./operations/technician-setup.mjs";
import { guardBrainAdminFetch } from "./components/brain-http.mjs";
import { confidenceLine } from "./worker/src/lib/confidence.js";
import { retrievalUnavailable, unavailableNotice } from "./worker/src/lib/retrieval-status.js";
import {
  adminKeyPersistencePlan,
  parseAdminKeySecretReference,
  persistAdminKeyDurably,
  readAdminKeyDurably,
  readAdminKeyFromKeychain,
} from "./operations/admin-key-persistence.mjs";
import {
  DRIVE_REMOVAL_MAX_COUNT,
  DRIVE_REMOVAL_MAX_RATIO,
  DriveRemovalReviewRequired,
  assertDriveRemovalPlanSafe,
  buildDriveRemovalPlan,
} from "./operations/drive-removal-plan.mjs";
import {
  discoverInstalledManifest,
  rememberInstalledManifest,
} from "./operations/installed-manifest.mjs";
import { evaluateProfileCoverage, formatProfileFailures } from "./eval/profile.mjs";
import {
  corpusContractReadiness,
  formatCorpusReadinessFailure,
  loadCorpusContract,
} from "./eval/corpus-contract.mjs";
export {
  DRIVE_REMOVAL_MAX_COUNT,
  DRIVE_REMOVAL_MAX_RATIO,
  DriveRemovalReviewRequired,
  assertDriveRemovalPlanSafe,
  buildDriveRemovalPlan,
};

// fileURLToPath, never `new URL(...).pathname`. The latter is percent-encoded,
// so any install path containing a space resolves to a directory that does not
// exist, and on Windows it keeps a leading slash before the drive letter
// (/C:/Users/...), which readdirSync rejects outright. The first client install
// runs on Windows, so this is not hypothetical.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The version of the code actually running, read from package.json.
 *
 * NOT from the client's manifest. The manifest is their file and it records
 * what is INSTALLED; using it as the upgrade target meant shipping 0.2.0 and
 * having the upgrade dutifully record "upgraded to 0.1.0", because their
 * manifest still said so. Version tracking that reports the old number after a
 * successful upgrade is worse than none: it makes support impossible.
 */
const PRODUCT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "package.json"), "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const API = "https://api.cloudflare.com/client/v4";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const ok = (s) => console.log(`${c.green("ok")}    ${s}`);
const info = (s) => console.log(`${c.dim("·")}     ${s}`);
const warn = (s) => console.log(`${c.yellow("warn")}  ${s}`);
/**
 * Fatal error.
 *
 * `die` THROWS rather than calling process.exit, because commands call each
 * other: `upgrade` runs migrate, deploy and health in sequence. An exit inside
 * a sub-command skips the caller's catch entirely, so the failure never
 * reaches the upgrade log and a broken install reads as one that was simply
 * never upgraded. Found by running a real upgrade and watching the failure
 * vanish from the history.
 */
class Fatal extends Error {}

const die = (s) => {
  throw new Fatal(s);
};

const SUPPORT_REMOTE_COMMANDS = new Set([
  "deploy", "diagnose", "drain", "health", "migrate", "provision",
  "reindex", "rollback", "secrets", "update", "upgrade", "verify",
]);
let currentSupportCommand = "";

function supportSourceForCommand(command = "") {
  if (command === "schedule") return "scheduler";
  if (command === "ingest") {
    const index = process.argv.indexOf("--from");
    const remote = index >= 0 ? process.argv[index + 1] : null;
    if (["calendar", "drive", "gmail", "imap", "imessage", "iphone-backup", "whatsapp"].includes(remote)) return remote;
    return "local";
  }
  if (command === "connect" || command === "disconnect") {
    const which = String(process.argv[3] || "").toLowerCase();
    if (which === "imap" || which === "imessage" || which === "whatsapp" || which === "zoom") return which;
    return "installer";
  }
  if (SUPPORT_REMOTE_COMMANDS.has(command)) return "cloudflare";
  return "installer";
}

/** Classify in memory; the raw message is never passed to the journal. */
export function supportErrorCode(error, { command = "", unexpected = false } = {}) {
  if (error instanceof DriveRemovalReviewRequired) return "SAFETY_REVIEW_REQUIRED";
  const typedCode = typeof error?.code === "string" ? error.code.trim().toUpperCase() : "";
  if (SUPPORT_ERROR_CODES.includes(typedCode)) return typedCode;
  const message = String(error?.message || "");
  if (/PDF.*tim(?:e|ed) out/i.test(message)) return "PDF_PROCESS_TIMEOUT";
  if (/PDF.*process/i.test(message)) return "PDF_PROCESS_FAILED";
  if (/timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(message)) return "NETWORK_UNREACHABLE";
  if (/rate.?limit|\b429\b/i.test(message)) return "RATE_LIMITED";
  if (/\b401\b|expired.*(?:auth|token)|reauthori[sz]/i.test(message)) return "AUTH_EXPIRED";
  if (/\b403\b|forbidden|permission denied|not permitted/i.test(message)) return "REMOTE_PERMISSION_DENIED";
  if (/admin key|credential.*(?:missing|required)|token is not set|sign.?in|required.*auth|Keychain.*(?:missing|empty)/i.test(message)) {
    return "AUTH_REQUIRED";
  }
  if (/not found|\b404\b/i.test(message)) return "REMOTE_NOT_FOUND";
  if (/extract/i.test(message)) return "EXTRACTION_FAILED";
  if (/needs --|no such folder|could not read manifest|usage:|must be one of|invalid|does not match/i.test(message)) {
    return "CONFIG_INVALID";
  }
  if (command === "ingest") return "INGEST_FAILED";
  if (command === "health") return "HEALTH_CHECK_FAILED";
  if (command === "drain") return "VECTOR_DRAIN_FAILED";
  if (command === "migrate") return "MIGRATION_FAILED";
  if (command === "upgrade" || command === "update") return "UPGRADE_FAILED";
  if (command === "schedule") {
    return process.argv.includes("--install") ? "SCHEDULE_INSTALL_FAILED" : "SCHEDULE_RUN_FAILED";
  }
  return unexpected ? "INTERNAL_ERROR" : "COMMAND_FAILED";
}

const SUPPORT_STACK_SKIP_FUNCTIONS = new Set(["crash", "die", "recordSupportFailure"]);

function supportStackFrame(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("at ")) return null;
  const body = text.slice(3).trim();
  let functionName = "";
  let location = body;
  if (body.endsWith(")")) {
    const open = body.lastIndexOf(" (");
    if (open > 0) {
      functionName = body.slice(0, open).replace(/^async\s+/, "").replace(/^new\s+/, "").trim();
      location = body.slice(open + 2, -1);
    }
  }
  const match = /^(.*):([1-9]\d{0,5}):\d{1,6}$/.exec(location);
  if (!match || match[1].length > 4096) return null;
  const leafFunction = functionName.split(".").at(-1);
  return { path: match[1], line: Number(match[2]), functionName: leafFunction };
}

/**
 * Find the first useful product frame without persisting or hashing raw stack
 * text. Outside paths and unsupported package files are rejected before the
 * sanitized product-relative location reaches the fingerprint validator.
 */
export function supportProductRelativeLocation(error, options = {}) {
  let stack;
  try { stack = typeof error?.stack === "string" ? error.stack : ""; }
  catch { return null; }
  if (!stack) return null;

  const resolveRealPath = options.realpath ?? realpathSync;
  const inspectFile = options.stat ?? statSync;
  let packageRoot;
  try { packageRoot = resolveRealPath(options.packageRoot ?? HERE); }
  catch { return null; }

  for (const line of stack.split("\n").slice(1, 65)) {
    const frame = supportStackFrame(line);
    if (!frame || SUPPORT_STACK_SKIP_FUNCTIONS.has(frame.functionName)) continue;
    let candidate = frame.path;
    try {
      if (candidate.startsWith("file://")) candidate = fileURLToPath(candidate);
      else if (!isAbsolute(candidate)) continue;
      const realCandidate = resolveRealPath(candidate);
      if (!inspectFile(realCandidate).isFile()) continue;
      const productPath = relative(packageRoot, realCandidate);
      if (!productPath || productPath === ".." || productPath.startsWith(`..${sep}`) || isAbsolute(productPath)) {
        continue;
      }
      const normalized = productPath.split(sep).join("/");
      const location = `${normalized}:${frame.line}`;
      productRelativeFingerprint(location);
      return location;
    } catch {
      // A raw outside path or unsupported package frame is never fingerprinted.
    }
  }
  return null;
}

function recordSupportFailure(error, { unexpected = false } = {}) {
  const command = currentSupportCommand;
  if (!command || command === "support") return null;
  const errorCode = supportErrorCode(error, { command, unexpected });
  try {
    const productRelativeLocation = supportProductRelativeLocation(error);
    const input = {
      command,
      source: supportSourceForCommand(command),
      errorCode,
      ...(productRelativeLocation ? { productRelativeLocation } : {}),
    };
    return { eventId: recordSupportEvent(input).event_id, errorCode };
  } catch {
    // Support capture must never replace or hide the actual command failure.
    return { eventId: null, errorCode };
  }
}

function printSupportReceipt(receipt, write = console.error) {
  if (!receipt?.errorCode) return;
  write(`  Issue code: ${receipt.errorCode}`);
  write(`  What to try next: brain support --explain ${receipt.errorCode}`);
  if (!receipt.eventId) return;
  write(`  Private issue note ${receipt.eventId} was saved locally. The installer did not upload or send this issue note.`);
  write("  Review the exact safe record with: brain support --preview");
}

const cloudflareTokenSession = new AsyncLocalStorage();

function activeCloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const scoped = cloudflareTokenSession.getStore();
  return scoped ? scoped.toString("ascii") : null;
}

export function cloudflareTokenAvailable() {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN || cloudflareTokenSession.getStore());
}

function validateCloudflareTokenBytes(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "ascii");
  if (bytes.length < 20 || bytes.length > 512 || [...bytes].some((byte) => byte < 0x21 || byte > 0x7e)) {
    bytes.fill(0);
    throw new Error("the Cloudflare token must be 20 to 512 printable characters with no spaces");
  }
  return bytes;
}

/**
 * Read one secret from a real terminal with echo disabled.
 *
 * ONE implementation, and every caller goes through it. The parts that are easy
 * to get subtly wrong and impossible to notice when they are wrong live here
 * exactly once: restoring raw mode on every exit path including the throwing
 * ones, removing the listeners, zeroing the buffer, and refusing outright
 * rather than falling back to visible entry. A second copy is how a fix lands
 * in one and not the other, and the one that missed it keeps writing a live
 * credential into somebody's scrollback.
 *
 * What genuinely differs per caller is passed in: the prompt, which bytes may
 * be typed, and what the collected bytes become. Nothing else.
 */
export function readHiddenInput({
  prompt,
  input = process.stdin,
  output = process.stderr,
  maxBytes = 512,
  noun = "secret",
  insecure = "this terminal cannot prompt securely. Rerun from an interactive terminal.",
  accepts = (byte) => byte >= 0x21 && byte <= 0x7e,
  finalize = (bytes) => Buffer.from(bytes),
} = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error(insecure));
  }
  return new Promise((resolveSecret, rejectSecret) => {
    const bytes = Buffer.alloc(maxBytes);
    let length = 0;
    let settled = false;
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      try { input.setRawMode(wasRaw); } catch { /* original result wins */ }
      if (wasPaused && typeof input.pause === "function") input.pause();
      output.write("\n");
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        bytes.fill(0);
        rejectSecret(error);
        return;
      }
      try {
        const result = finalize(bytes.subarray(0, length));
        bytes.fill(0);
        resolveSecret(result);
      } catch (validationError) {
        bytes.fill(0);
        rejectSecret(validationError);
      }
    };
    const onData = (chunk) => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of incoming) {
        if (byte === 0x03) return finish(new Error(`${noun} entry was cancelled`));
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x08 || byte === 0x7f) {
          if (length > 0) bytes[--length] = 0;
          continue;
        }
        if (!accepts(byte) || length >= bytes.length) {
          return finish(new Error(`the ${noun} contains an unsupported character or is too long`));
        }
        bytes[length++] = byte;
      }
    };
    const onEnd = () => finish(new Error(`terminal input ended before a ${noun} was entered`));
    const onError = () => finish(new Error(`terminal input failed while reading the ${noun}`));
    output.write(prompt);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    try {
      input.setRawMode(true);
      input.resume();
    } catch {
      finish(new Error(`this terminal could not disable echo for ${noun} entry`));
    }
  });
}

/** Read a token from a real terminal with echo disabled and restore it on every exit path. */
export function readHiddenCloudflareToken({ input = process.stdin, output = process.stderr } = {}) {
  return readHiddenInput({
    prompt: "  Cloudflare token (hidden): ",
    input,
    output,
    noun: "Cloudflare token",
    insecure:
      "no Cloudflare token is available and this terminal cannot prompt securely. " +
      "Rerun from an interactive terminal for hidden entry. For automation, inject " +
      "CLOUDFLARE_API_TOKEN through an approved secret manager; never paste it into a shell command.",
    // A Cloudflare token is printable ASCII with no spaces, so a space is a
    // paste accident and is caught at the keystroke rather than at the API.
    accepts: (byte) => byte >= 0x21 && byte <= 0x7e,
    finalize: validateCloudflareTokenBytes,
  });
}

export async function withCloudflareToken(action, options = {}) {
  if (cloudflareTokenAvailable()) return action();

  // Durable per-account copy: one paste per machine, ever. Attempted only
  // when the caller names the account — a keyless lookup could hand a
  // neighbouring account's token to the wrong install, and test paths that
  // pass no accountId keep their exact historical behavior.
  if (options.accountId) {
    let stored = null;
    try {
      stored = (options.loadStoredCloudflareToken ?? loadStoredCloudflareToken)(options.accountId);
    } catch (error) {
      // A broken keychain must present as itself, not as an every-run prompt.
      warn(String(error?.message || error));
    }
    if (stored) {
      return cloudflareTokenSession.run(stored, async () => {
        try {
          return await action();
        } finally {
          stored.fill(0);
        }
      });
    }
  }

  const prompt = options.readCloudflareToken ?? readHiddenCloudflareToken;
  const prompted = await prompt();
  let entered;
  try {
    entered = validateCloudflareTokenBytes(prompted);
  } finally {
    if (Buffer.isBuffer(prompted)) prompted.fill(0);
  }

  // Offer to remember it, once, right after a successful manual entry. Gated
  // on a named account, macOS, and a real terminal: automation and tests
  // must never write to a keychain as a side effect.
  if (options.accountId &&
      (options.platform ?? process.platform) === "darwin" &&
      (options.interactive ?? process.stdin.isTTY)) {
    const askFn = options.askFn ?? ask;
    const save = (await askFn(
      `Remember this token for account ${options.accountId} in this Mac's Keychain, so future runs skip the prompt? (y/n)`,
      "y",
    )).toLowerCase();
    if (save === "y") {
      try {
        (options.storeCloudflareToken ?? storeCloudflareToken)(options.accountId, entered);
        ok("token stored. Remove it any time with: brain token <manifest> --forget");
      } catch (error) {
        warn(`could not store the token (${String(error?.message || error)}); continuing without saving`);
      }
    }
  }

  return cloudflareTokenSession.run(entered, async () => {
    try {
      return await action();
    } finally {
      entered.fill(0);
    }
  });
}

/**
 * Use an already available or remembered Cloudflare token without ever
 * prompting. Diagnostics need this distinction: `brain doctor <manifest>`
 * should verify the token setup already stored, but a missing token is itself
 * one of the findings and must not turn a read-only preflight into a ceremony.
 */
export async function withAvailableCloudflareToken(action, options = {}) {
  if (cloudflareTokenAvailable() || !options.accountId) return action();
  let stored = null;
  try {
    stored = (options.loadStoredCloudflareToken ?? loadStoredCloudflareToken)(options.accountId);
  } catch (error) {
    options.onStorageError?.(error);
    return action();
  }
  if (!stored) return action();
  return cloudflareTokenSession.run(stored, async () => {
    try {
      return await action();
    } finally {
      stored.fill(0);
    }
  });
}

function token() {
  const t = activeCloudflareToken();
  if (!t) {
    die(
      "CLOUDFLARE_API_TOKEN is not set.\n" +
        "      Run `brain setup` or `brain update` in an interactive terminal for hidden token entry.\n" +
        "      Low-level automation must inject it through an approved secret manager; never paste it\n" +
        "      into a shell command. It is deliberately not read from the manifest."
    );
  }
  return t;
}

async function cf(path, { method = "GET", body, raw } = {}) {
  const res = await http(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!json.success) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${path} failed (${res.status}): ${errs || text.slice(0, 200)}`);
  }
  return json.result;
}

function loadManifest(path) {
  if (!path) die("usage: brain <command> <manifest.json>");
  try {
    return { path, m: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (e) {
    die(`could not read manifest at ${path}: ${e.message}`);
  }
}

function saveManifest(path, m) {
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
}

/**
 * The shortest path a person can retype, which is not always the relative one.
 *
 * The success screen is the last thing a client reads, and it rendered the
 * manifest as `../../../../../../../private/tmp/...` because the manifest sat
 * outside the working directory (bench, 2026-08-28). Seven levels of `..` in
 * the command they are told to run looks broken. Prefer relative only when it
 * is genuinely shorter and does not climb out of sight.
 */
function displayPath(target) {
  const absolute = resolve(target);
  const rel = relative(process.cwd(), absolute);
  if (!rel) return absolute;
  const climbs = (rel.match(/(^|[/\\])\.\.($|[/\\])/g) || []).length;
  if (climbs > 1 || rel.length >= absolute.length) return absolute;
  return rel;
}

/** Exported only so a test can pin the display rule without a real install. */
export function displayPathForTesting(target, cwd) {
  const absolute = resolve(target);
  const rel = relative(cwd, absolute);
  if (!rel) return absolute;
  const climbs = (rel.match(/(^|[/\\])\.\.($|[/\\])/g) || []).length;
  if (climbs > 1 || rel.length >= absolute.length) return absolute;
  return rel;
}

function commandPath(value) {
  const text = String(value).replace(/[\r\n"]/g, "");
  return /^[a-z0-9_./:\\-]+$/i.test(text) ? text : `"${text}"`;
}

/** Create a new manifest and its private install folder without following a link. */
function createSetupManifest(path, m) {
  const parent = dirname(resolve(path));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentIdentity = lstatSync(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    die("the Brain folder must be a real directory, not a link.");
  }
  let descriptor = null;
  let created = false;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    writeFileSync(descriptor, JSON.stringify(m, null, 2) + "\n");
    fsyncSync(descriptor);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* cleanup below */ }
      descriptor = null;
    }
    if (created) {
      try { unlinkSync(path); } catch { /* preserve the original failure */ }
    }
    if (error?.code === "EEXIST") die("the Brain manifest appeared while setup was starting. Rerun setup to resume it.");
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Resolve the account from the token itself.
 *
 * If the manifest names an account, it must MATCH one the token can see. A
 * mismatch is a hard stop: it usually means the wrong token, and provisioning
 * a brain into someone else's account is the one error with no clean undo.
 */
async function resolveAccount(m) {
  const accounts = await cf("/accounts");
  if (!accounts.length) die("this token cannot see any Cloudflare account.");

  const declared = m.infrastructure?.cloudflare?.account_id;
  if (declared && !declared.startsWith("REQUIRED")) {
    const match = accounts.find((a) => a.id === declared);
    if (!match) {
      die(
        `the manifest declares account ${declared}, but this token can only see:\n` +
          accounts.map((a) => `        ${a.id}  ${a.name}`).join("\n") +
          "\n      Refusing to provision into a different account than the manifest names."
      );
    }
    return match;
  }

  if (accounts.length > 1) {
    die(
      "this token can see more than one account and the manifest does not say which:\n" +
        accounts.map((a) => `        ${a.id}  ${a.name}`).join("\n") +
        "\n      Set infrastructure.cloudflare.account_id in the manifest."
    );
  }
  return accounts[0];
}

/** Pick a fresh install's account from the hidden scoped token, never Wrangler. */
export async function chooseSetupAccount(prompt, options = {}) {
  const listAccounts = options.listAccounts ?? (() => cf("/accounts"));
  const accounts = await listAccounts();
  if (!Array.isArray(accounts) || accounts.some((account) =>
    !account || typeof account.id !== "string" || typeof account.name !== "string")) {
    die("Cloudflare returned an invalid account list. Nothing was created.");
  }
  if (!accounts.length) die("this token cannot see any Cloudflare account.");
  if (accounts.length === 1) return accounts[0];

  console.log(`\n  ${c.yellow("This permission pass can see several Cloudflare accounts.")}`);
  console.log(`  ${c.dim("Pick carefully: this creates real resources in whichever one you name.")}\n`);
  for (const account of accounts) console.log(`    ${account.id}  ${account.name}`);
  console.log("");
  const chosenId = String(await prompt("Cloudflare account id", "")).trim();
  const chosen = accounts.find((account) => account.id === chosenId);
  if (!chosen) {
    closePrompts();
    die("that account id is not one this permission pass can see. Nothing was created.");
  }
  return chosen;
}

/* ------------------------------------------------------------- commands */

/**
 * The bucket this manifest asks for, or null when it asks for none.
 *
 * Verify and provision have to agree about whether R2 is in play, and they did
 * not. A blank name is not a request.
 */
export function r2BucketRequested(cfg) {
  const name = String(cfg?.r2_bucket ?? "").trim();
  return name || null;
}

async function cmdVerify(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  ok(`token valid, account "${acct.name}" (${acct.id})`);

  // R2 needs separate activation and a card on file, even for the free tier.
  // It is the most common mid-install surprise, so it is checked up front, but
  // ONLY when the manifest names a bucket. Provision skipped its R2 step in
  // silence for a manifest with no bucket while verify probed R2 anyway and
  // told the owner to add a payment method for storage this brain never
  // touches (bench, 2026-08-28, F-09). One predicate, read by both.
  const r2Bucket = r2BucketRequested(m.infrastructure?.cloudflare);
  if (!r2Bucket) {
    info("this install does not use R2 file storage, so it is not checked");
  } else try {
    await cf(`/accounts/${acct.id}/r2/buckets`);
    ok("R2 is enabled");
  } catch (e) {
    warn(
      "R2 is not ready (it may be disabled or outside this token's scope). If this install uses R2,\n" +
        "        the owner can enable it in the dashboard; Cloudflare asks for a payment method even on the free tier.\n" +
        `        detail: ${e.message.slice(0, 120)}`
    );
  }

  try {
    await cf(`/accounts/${acct.id}/d1/database`);
    ok("D1 is reachable");
  } catch (e) {
    die(
      "D1 is not reachable, so the required database cannot be verified." + "\n" +
        "      Confirm that the token has D1 access, then re-run `brain verify`." + "\n" +
        `      detail: ${e.message.slice(0, 120)}`
    );
  }

  try {
    await cf(`/accounts/${acct.id}/workers/scripts`);
    ok("Workers is reachable");
  } catch (e) {
    die(`Workers is not reachable, so nothing can be deployed: ${e.message.slice(0, 160)}`);
  }

  // Vectorize is where the meaning lives. Without it the brain still answers,
  // but only by keyword, which means it finds documents that repeat the
  // question's words and misses the ones that answer it in different words.
  // That degradation is quiet, so it is checked up front rather than discovered
  // later as "search feels bad".
  try {
    await cf(`/accounts/${acct.id}/vectorize/v2/indexes`);
    ok("Vectorize is reachable");
  } catch (e) {
    warn(
      "the API token cannot reach Vectorize. The standard token needs Vectorize: Edit." + "\n" +
        "      Provision can use wrangler login as a temporary fallback." + "\n" +
        VECTORIZE_REMEDY + "\n" +
        `      detail: ${e.message.slice(0, 120)}`
    );
  }
  return acct;
}


/**
 * Vectorize through the API token, with wrangler as a compatibility fallback.
 *
 * The earlier tokens failed because they lacked Vectorize Edit. A user-owned,
 * account-scoped token with that permission created the index and all metadata
 * indexes through the API on 2026-08-23. Wrangler's OAuth session remains a
 * fallback so an older install can still be repaired without deleting resources.
 *
 * CLOUDFLARE_API_TOKEN must be cleared for the child process. Wrangler prefers it
 * when set and will silently authenticate as the wrong identity.
 */
function wrangler(args, { accountId } = {}) {
  // Through doctor's runner, which knows that npm CLIs are .cmd shims on
  // Windows and that Node refuses to spawn those without a shell since
  // CVE-2024-27980. The previous raw spawnSync returned ENOENT there, which
  // made provision report "wrangler: not logged in" to a client whose doctor
  // had verified the login moments earlier.
  const env = cloudflareCliEnvironment(accountId);
  const r = run("npx", ["wrangler@4", ...args], {
    timeout: 180_000,
    inheritEnv: false,
    env,
  });
  return { ok: r.ok, out: r.out, status: r.ok ? 0 : 1 };
}

function wranglerAvailable(accountId) {
  const r = wrangler(["whoami"], { accountId });
  return r.ok && /You are logged in|Account Name/i.test(r.out);
}

/**
 * Pick the D1 database name, refusing any name too generic to adopt safely.
 *
 * Pure and exported so this is covered by a real test rather than a source grep.
 * There is deliberately no generic default: a shared name is the one way
 * provision can reach something that is not ours.
 */
/**
 * Every filter that must narrow vector candidates before topK is listed here.
 * Six of Vectorize's ten metadata-index slots are used by the product contract.
 */
export const VECTOR_METADATA_INDEXES = Object.freeze([
  { propertyName: "source", indexType: "string" },
  { propertyName: "client", indexType: "string" },
  { propertyName: "category", indexType: "string" },
  { propertyName: "top_folder", indexType: "string" },
  { propertyName: "platform", indexType: "string" },
  { propertyName: "document_date", indexType: "number" },
]);

/**
 * Create one Vectorize metadata index and refuse to continue until it is active.
 *
 * Fatal on purpose. Measured against Vectorize on 2026-08-18: a vector written
 * BEFORE the metadata index exists is not filterable afterwards, even though it
 * is present in the index and comes back from unfiltered queries. Two vectors
 * with identical metadata, one written before and one after; only the second was
 * returned by a filtered query. So there is no repair short of re-ingesting
 * everything, and a warning here buys a corpus that silently cannot be filtered.
 *
 * The create API returns an asynchronous mutation id, so a successful POST is
 * not proof that the index can filter yet. `exists` polls the list endpoint (or
 * Wrangler) and closes that race before an immediate first ingest.
 *
 * Injectable so retries, activation polling and refusal are covered by a real
 * test.
 */
export async function ensureMetadataIndex({
  propertyName = "source",
  indexType = "string",
  create,
  exists,
  attempts = 3,
  // Cloudflare took just over 30 seconds to expose a newly-created metadata
  // index during the first live shadow provision on 2026-08-23. Ten polls at
  // three seconds stopped one check too early. Allow up to 90 seconds while
  // preserving the fail-closed rule before any vectors are written.
  verifyAttempts = 30,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = ok,
  onFatal = die,
}) {
  let requested = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await create();
      requested = true;
      break;
    } catch (e) {
      const msg = e?.message || String(e);
      if (/already|exists|conflict/i.test(msg)) {
        requested = true;
        break;
      }
      if (attempt === attempts) {
        return onFatal(
          `the ${indexType} metadata index on "${propertyName}" could not be created: ${msg.slice(0, 120)}` + "\n" +
            "  This CANNOT be added later. Vectorize applies a metadata index only to" + "\n" +
            `  vectors written after it exists, so continuing would leave ${propertyName} filtering` + "\n" +
            "  permanently broken for everything ingested from here on." + "\n" +
            "  Nothing has been ingested yet, so re-running `brain provision` costs nothing."
        );
      }
      await sleep(3000);
    }
  }

  if (!requested) return false;
  if (!exists) {
    log(`metadata index on "${propertyName}" requested`);
    return true;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= verifyAttempts; attempt++) {
    try {
      if (await exists()) {
        log(`metadata index on "${propertyName}" active`);
        return true;
      }
      lastError = `not visible after ${attempt} check(s)`;
    } catch (e) {
      lastError = e?.message || String(e);
    }
    if (attempt < verifyAttempts) await sleep(3000);
  }

  return onFatal(
    `the metadata index on "${propertyName}" was requested but never became active: ${String(lastError || "unknown").slice(0, 120)}` + "\n" +
      "  Provision will not ingest into an index whose filters are not ready." + "\n" +
      "  Re-run `brain provision`; no corpus data has been written yet."
  );
}

export function chooseDbName(cfg, slug) {
  const name = cfg?.d1_database_name || (slug ? `${slug}-brain` : null);
  if (!name || name === "brain" || /^REPLACE-WITH/i.test(name)) {
    die(
      `cannot use the D1 database name ${name ? `"${name}"` : "(none set)"}: it is too generic` + "\n" +
        "  to provision safely. If this account already has one, it very likely belongs to" + "\n" +
        "  something else, and provisioning would adopt it rather than create a new one." + "\n" +
        `  Set infrastructure.cloudflare.d1_database_name to "${slug || "<client>"}-brain".`
    );
  }
  return name;
}

/**
 * Decide whether an existing D1 database may be adopted.
 *
 * Adoptable: an empty database (a re-run of provision after it created the
 * database but before migrate), or one whose install_state names this same
 * client (an ordinary re-run).
 *
 * NOT adoptable: a database holding tables that are not ours, or one that is
 * another client's brain. Both die rather than warn, because by the time anyone
 * reads a warning the damage is done: migrate writes into it, and the
 * client_slug upsert relabels another client's brain as this one.
 */
export async function assertAdoptable(acctId, db, dbName, slug, query = d1Query) {
  let names;
  try {
    const res = await query(
      acctId, db.uuid,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    );
    names = (res?.results || []).map((r) => r.name);
  } catch {
    die(
      `D1 "${dbName}" (${db.uuid}) already exists here but could not be inspected, so` + "\n" +
        "  there is no way to tell whether it is ours. Refusing to adopt it." + "\n" +
        "  Set infrastructure.cloudflare.d1_database_name to a name this account does not use."
    );
  }

  if (!names.length) return; // empty: safe, this is a normal provision re-run

  if (!names.includes("install_state")) {
    die(
      `D1 "${dbName}" (${db.uuid}) already exists in this account and is NOT a brain.` + "\n" +
        `  It holds ${names.length} table(s): ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}` + "\n" +
        "  Refusing to adopt someone else's database. Nothing has been changed." + "\n" +
        "  Set infrastructure.cloudflare.d1_database_name to a name this account does not use."
    );
  }

  let owner = null;
  try {
    const res = await query(acctId, db.uuid, "SELECT client_slug FROM install_state WHERE id = 1");
    owner = res?.results?.[0]?.client_slug || null;
  } catch { /* older schema */ }
  if (owner && slug && owner !== slug) {
    die(
      `D1 "${dbName}" (${db.uuid}) is already the brain for "${owner}", not "${slug}".` + "\n" +
        "  Refusing to adopt it: migrating would relabel their install as this one." + "\n" +
        "  Set infrastructure.cloudflare.d1_database_name to a name this account does not use."
    );
  }
}

async function cmdProvision(manifestPath, { nextSteps = true } = {}) {
  const { path, m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  info(`provisioning into "${acct.name}" (${acct.id})`);

  m.infrastructure = m.infrastructure || {};
  m.infrastructure.cloudflare = m.infrastructure.cloudflare || {};
  const cfg = m.infrastructure.cloudflare;
  cfg.account_id = acct.id;

  // D1. Adopt an existing database of the same name rather than failing or
  // creating a second one, so provision is safe to re-run.
  // A name match is NOT proof of ownership: a client account can already hold a
  // production database that happens to share the name, and adopting it would run
  // our migrations into their data and bind a second worker to it.
  const slug = m.client?.slug;
  const dbName = chooseDbName(cfg, slug);
  const existing = await cf(`/accounts/${acct.id}/d1/database`);
  let db = (existing || []).find((d) => d.name === dbName);
  if (db) {
    await assertAdoptable(acct.id, db, dbName, slug);
    ok(`D1 "${dbName}" already exists (${db.uuid}), adopting it`);
  } else {
    db = await cf(`/accounts/${acct.id}/d1/database`, {
      method: "POST",
      body: { name: dbName },
    });
    ok(`D1 "${dbName}" created (${db.uuid})`);
  }
  cfg.d1_database_id = db.uuid;

  // R2, optional. A failure here is not fatal: the brain runs without it.
  // Same predicate verify uses, so the two can never disagree again.
  if (r2BucketRequested(cfg)) {
    try {
      const buckets = await cf(`/accounts/${acct.id}/r2/buckets`);
      const found = (buckets.buckets || []).find((b) => b.name === cfg.r2_bucket);
      if (found) {
        ok(`R2 bucket "${cfg.r2_bucket}" already exists, adopting it`);
      } else {
        await cf(`/accounts/${acct.id}/r2/buckets`, {
          method: "POST",
          body: { name: cfg.r2_bucket },
        });
        ok(`R2 bucket "${cfg.r2_bucket}" created`);
      }
    } catch (e) {
      warn(`R2 step skipped: ${e.message.slice(0, 140)}`);
    }
  }

  // Vectorize, when the manifest asks for the Cloudflare-only storage path.
  if ((cfg.storage || "d1") === "d1") {
    // The template ships `vectorize_index: "filled_in_by_provisioner"`, which
    // reads like a value the provisioner replaces. It does not: this name is
    // the index name. Because the placeholder is a truthy string, it used to
    // sail straight through and create a real Vectorize index literally called
    // "filled_in_by_provisioner" (observed on a clean install, 2026-08-28).
    // Worse, a SECOND install in the same account then adopts that same index
    // and two clients share one vector store. Treat the placeholder as unset.
    const PLACEHOLDER_INDEX_NAME = "filled_in_by_provisioner";
    const configuredIndex =
      cfg.vectorize_index && cfg.vectorize_index !== PLACEHOLDER_INDEX_NAME
        ? cfg.vectorize_index
        : null;
    const idxName = configuredIndex || `${m.client?.slug || "client"}-brain`;
    // 768 and cosine are NOT free choices. They are the output shape of
    // @cf/baai/bge-base-en-v1.5, the model the worker embeds with. An index
    // built at other dimensions rejects every vector, and one built with a
    // different metric silently ranks wrong rather than erroring.
    let list = null;
    let viaApi = true;
    try {
      list = await cf(`/accounts/${acct.id}/vectorize/v2/indexes`);
    } catch (e) {
      // An older token may lack Vectorize Edit. Fall through to wrangler rather
      // than stopping an install that can still complete.
      viaApi = false;
      info("the API token cannot reach Vectorize, trying wrangler's own session");
      if (!wranglerAvailable(acct.id)) {
        die(
          `Vectorize is unreachable both ways, so the install cannot continue.\n` +
            `  API token: ${e.message.slice(0, 100)}\n` +
            "  wrangler:  not logged in.\n\n" +
            VECTORIZE_REMEDY + "\n  Then re-run provision."
        );
      }
      const r = wrangler(["vectorize", "list"], { accountId: acct.id });
      if (!r.ok) die(`wrangler could not list Vectorize indexes: ${r.out.slice(-300)}`);
      // wrangler prints a table; a name match is enough to know it exists.
      list = new RegExp(`\\b${idxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(r.out)
        ? [{ name: idxName, config: {} }]
        : [];
    }

    try {
      const found = (list || []).find((i) => i.name === idxName);
      if (found) {
        const d = found.config?.dimensions;
        const metric = found.config?.metric;
        if (d && d !== 768) {
          die(
            `Vectorize index "${idxName}" has ${d} dimensions, but the embedding model\n` +
              "  produces 768. Adopting it would reject every vector. Delete it or pick\n" +
              "  another name via infrastructure.cloudflare.vectorize_index."
          );
        }
        if (metric && metric !== "cosine") {
          die(`Vectorize index "${idxName}" uses metric "${metric}", not cosine. Ranking would be wrong, not broken, so this refuses rather than adopts.`);
        }
        ok(`Vectorize "${idxName}" already exists, adopting it`);
      } else if (viaApi) {
        await cf(`/accounts/${acct.id}/vectorize/v2/indexes`, {
          method: "POST",
          body: {
            name: idxName,
            description: `retrieval index for ${m.client?.display_name || "brain"}`,
            config: { dimensions: 768, metric: "cosine" },
          },
        });
        ok(`Vectorize "${idxName}" created (768-dim, cosine)`);
      } else {
        // 768 and cosine are the output shape of @cf/baai/bge-base-en-v1.5, the
        // model the worker embeds with. Any other values reject every vector or
        // rank wrongly, so they are not configurable.
        const r = wrangler(
          ["vectorize", "create", idxName, "--dimensions=768", "--metric=cosine"],
          { accountId: acct.id }
        );
        if (!r.ok) die(`wrangler could not create the Vectorize index: ${r.out.slice(-400)}`);
        ok(`Vectorize "${idxName}" created via wrangler (768-dim, cosine)`);
      }

      // Metadata indexes must be ACTIVE before any vector is written; they do
      // not apply retroactively. Provision all public filter dimensions now.
      for (const { propertyName, indexType } of VECTOR_METADATA_INDEXES) {
        await ensureMetadataIndex({
          propertyName,
          indexType,
          create: viaApi
            ? () => cf(`/accounts/${acct.id}/vectorize/v2/indexes/${idxName}/metadata_index/create`, {
                method: "POST",
                body: { propertyName, indexType },
              })
            : async () => {
                const r = wrangler(
                  ["vectorize", "create-metadata-index", idxName, `--property-name=${propertyName}`, `--type=${indexType}`],
                  { accountId: acct.id }
                );
                if (!r.ok && !/already|exists/i.test(r.out)) throw new Error(r.out.slice(-200));
              },
          exists: viaApi
            ? async () => {
                const found = await cf(`/accounts/${acct.id}/vectorize/v2/indexes/${idxName}/metadata_index/list`);
                return (found?.metadataIndexes || []).some(
                  (x) => x.propertyName === propertyName && String(x.indexType).toLowerCase() === indexType
                );
              }
            : async () => {
                const r = wrangler(
                  ["vectorize", "list-metadata-index", idxName, "--json"],
                  { accountId: acct.id }
                );
                if (!r.ok) throw new Error(r.out.slice(-200));
                try {
                  const parsed = JSON.parse(r.out);
                  const rows = parsed?.metadataIndexes || parsed;
                  if (Array.isArray(rows)) {
                    return rows.some((x) =>
                      x.propertyName === propertyName && String(x.indexType || x.type).toLowerCase() === indexType
                    );
                  }
                } catch { /* fall through to the human-readable output */ }
                return new RegExp(`\\b${propertyName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i").test(r.out);
              },
        });
      }

      cfg.vectorize_index = idxName;
    } catch (e) {
      if (e instanceof Fatal) throw e;
      die(
        `Vectorize could not be provisioned: ${e.message.slice(0, 140)}\n` +
          "  This is the storage backend, so the install cannot continue without it.\n" +
          VECTORIZE_REMEDY + "\n" +
          "  Fix Cloudflare access and re-run provision. No corpus has been ingested."
      );
    }
  }

  saveManifest(path, m);
  ok(`manifest updated with the resource IDs (${relative(process.cwd(), path)})`);
  // Order matters and was wrong here. Secrets are set ON a worker script, so on
  // a first install the script must exist first; running secrets before deploy
  // returns a bare 404 "This Worker does not exist on your account". Deploy is
  // safe to run without secrets (it carries keep_bindings, so a later deploy
  // preserves them), which makes deploy-then-secrets the only order that works
  // from nothing.
  // Printed only when a person ran `brain provision` directly. Setup runs this
  // same step and then keeps going, so the hint there is noise mid-install.
  //
  // The order was right and the hint was still a dead end (bench, 2026-08-28).
  // It names four commands and the fourth stops, because nothing in that list
  // creates an admin key: only `brain setup` generates and persists one.
  if (nextSteps) {
    info(
      "next: brain migrate <manifest>, then deploy, then secrets, then health.\n" +
        "        Those four finish only on a brain that already has an admin key. Nothing in\n" +
        "        that list creates one; `brain setup <manifest>` creates it and runs all four."
    );
  }
}

function collectWorkerFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".js")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Whether a failed workers.dev enable call still leaves a usable public route. */
export function workersDevRouteDisposition({ customDomain = null, workersDevEnabled = false } = {}) {
  if (workersDevEnabled) return "ready";
  return customDomain ? "optional" : "required";
}

/** Save the verified workers.dev hostname so routine commands need no API token. */
export async function persistWorkersDevDomain(manifestPath, m, acct, scriptName, options = {}) {
  if (m.brain?.domain) return m.brain.domain;
  const readSubdomain = options.readSubdomain ??
    (() => cf(`/accounts/${acct.id}/workers/subdomain`));
  const sub = await readSubdomain().catch(() => null);
  const label = typeof sub?.subdomain === "string" ? sub.subdomain.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) {
    die(
      "the workers.dev route is enabled, but Cloudflare did not return a usable account subdomain.\n" +
        "  The Worker is deployed, but its token-free URL cannot be saved. Rerun deploy after\n" +
        "  the Workers subdomain is visible in Cloudflare."
    );
  }
  m.brain = { ...(m.brain || {}), domain: `${scriptName}.${label}.workers.dev` };
  saveManifest(manifestPath, m);
  return m.brain.domain;
}

export async function cmdDeploy(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const cfg = m.infrastructure.cloudflare;
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;

  if (!cfg.d1_database_id) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const srcRoot = join(HERE, "worker", "src");
  const files = collectWorkerFiles(srcRoot);
  if (!files.length) die(`no worker source found at ${srcRoot}`);

  const form = new FormData();
  for (const f of files) {
    // Module specifiers are relative to src/, matching the import paths.
    // POSIX separators ALWAYS. A module specifier is a URL, not a filesystem
    // path, and the worker imports "./lib/core.js". On Windows relative()
    // returns "lib\\core.js", so every module uploads under a name the runtime
    // cannot resolve and the worker dies with: No such module "lib/core.js".
    // Found by the first real Windows install; CI could not catch it because
    // deploying needs live Cloudflare credentials.
    const rel = relative(srcRoot, f).split(sep).join("/");
    form.append(
      rel,
      new Blob([readFileSync(f, "utf-8")], { type: "application/javascript+module" }),
      rel
    );
  }

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-01-01",
    bindings: [
      { type: "d1", name: "DB", id: cfg.d1_database_id },
      { type: "ai", name: "AI" },
      // Explicit, never inferred. The worker CAN guess its backend from which
      // bindings are present, but a guess that silently picks the wrong store
      // returns an empty brain rather than an error, so the manifest states it.
      { type: "plain_text", name: "STORAGE", text: cfg.storage || "d1" },
      ...(cfg.vectorize_index
        ? [{ type: "vectorize", name: "VECTORIZE", index_name: cfg.vectorize_index }]
        : []),
      { type: "plain_text", name: "BRAIN_NAME", text: m.client?.slug || "brain" },
      { type: "plain_text", name: "BRAIN_OWNER", text: m.client?.display_name || "the owner" },
      { type: "plain_text", name: "BRAIN_VERSION", text: PRODUCT_VERSION },
      ...(options.pauseVectorDrainForUpgrade === true
        ? [{ type: "plain_text", name: "VECTOR_DRAIN_MODE", text: "paused-for-upgrade" }]
        : []),
      {
        type: "plain_text",
        name: "CHUNK_SIZE",
        text: String(m.retrieval?.chunk_size ?? 1500),
      },
      {
        type: "plain_text",
        name: "CHUNK_OVERLAP",
        text: String(m.retrieval?.chunk_overlap ?? 300),
      },
      {
        type: "plain_text",
        name: "DAILY_LLM_CAP_USD",
        text: String(m.safety?.daily_llm_spend_cap_usd ?? 10),
      },
      {
        type: "plain_text",
        name: "ANSWER_MODEL",
        text: String(m.retrieval?.answer_model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      },
      {
        type: "plain_text",
        name: "CREDENTIAL_SCANNER",
        text: m.safety?.credential_scanner?.enabled === false ? "off" : "on",
      },
      // OFF unless the manifest says otherwise. An upgrade that quietly
      // switched on a per-page charge against the client's own account would
      // be a bill they never agreed to, so the default is the one that spends
      // nothing.
      {
        type: "plain_text",
        name: "OCR_ENABLED",
        text: m.safety?.ocr?.enabled === true ? "1" : "0",
      },
      {
        type: "plain_text",
        name: "OCR_MODEL",
        text: String(m.safety?.ocr?.model || "@cf/google/gemma-4-26b-a4b-it"),
      },
    ],
    // Without this, every secret set by `brain secrets` is wiped on the next
    // deploy. It is the single most destructive omission in a Workers deploy
    // and it fails silently: the worker deploys fine and then 500s on use.
    keep_bindings: ["secret_text"],
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));

  if ((cfg.storage || "d1") === "d1" && !cfg.vectorize_index) {
    die(
      "storage is d1 but the manifest has no vectorize_index. Run `brain provision`\n" +
        "  first. Deploying now would produce a worker that answers by keyword only,\n" +
        "  and would look healthy while doing it."
    );
  }

  info(`uploading ${files.length} module(s) as "${scriptName}"`);
  await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}`, {
    method: "PUT",
    body: form,
    raw: true,
  });
  ok(`deployed "${scriptName}"`);

  // A deploy that is not verified is a belief. Enable the workers.dev route so
  // there is always a URL to prove it against, even before a custom domain.
  const workersDevPath = `/accounts/${acct.id}/workers/scripts/${scriptName}/subdomain`;
  try {
    await cf(workersDevPath, {
      method: "POST",
      body: { enabled: true },
    });
    ok("workers.dev route enabled");
  } catch (e) {
    // A failed write can mean the route was already enabled or that this token
    // lacks only route-edit permission. Read the actual state before deciding
    // whether deploy is incomplete.
    const currentRoute = await cf(workersDevPath).catch(() => null);
    const disposition = workersDevRouteDisposition({
      customDomain: m.brain?.domain,
      workersDevEnabled: currentRoute?.enabled === true,
    });
    if (disposition === "ready") {
      ok("workers.dev route already enabled");
    } else if (disposition === "optional") {
      warn(
        `could not enable the optional workers.dev route: ${e.message.slice(0, 120)}\n` +
          `        The configured route https://${m.brain.domain} remains the install URL.`
      );
    } else {
      die(
        `could not enable or verify a workers.dev route: ${e.message.slice(0, 120)}\n` +
          "  The Worker code was uploaded, but this manifest has no custom domain, so there\n" +
          "  is no usable URL to test or hand to the client. Fix Workers route access and\n" +
          "  re-run `brain deploy`; the upload is safe to repeat."
      );
    }
  }

  // Routine ingest, drain, health, diagnose, and evaluation must keep working
  // after the one-day Cloudflare control token is revoked. Persist the verified
  // workers.dev hostname once, instead of looking it up again on every command.
  if (!m.brain?.domain && options.persistDomain !== false) {
    const domain = await persistWorkersDevDomain(manifestPath, m, acct, scriptName);
    ok(`saved the live address https://${domain}`);
  }

  // The cron that drains the vector outbox. Without it the D1 install writes
  // text that keyword search can find and vector search cannot, forever, and
  // reports itself healthy the whole time because both systems are up.
  if ((cfg.storage || "d1") === "d1") {
    const schedule = cfg.drain_cron || "* * * * *";
    try {
      await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}/schedules`, {
        method: "PUT",
        body: [{ cron: schedule }],
      });
      ok(`vector drain scheduled (${schedule})`);
    } catch (e) {
      die(
        `could not set the drain cron: ${e.message.slice(0, 120)}\n` +
          "  The Worker code was uploaded, but a D1 install without this required schedule\n" +
          "  accumulates text that is keyword-searchable and NOT semantically searchable.\n" +
          "  Fix Worker schedule access and re-run `brain deploy`; the upload is safe to repeat."
      );
    }
  }
  // Same reasoning as provision: suppressed when setup drives the step.
  if (options.nextSteps !== false) {
    info(
      "next: brain secrets <manifest>, then brain health <manifest>.\n" +
        "        `brain secrets` applies this brain's admin key and never creates one. If this\n" +
        "        brain has no key yet, `brain setup <manifest>` creates it and finishes the install."
    );
  }
}

/**
 * Every provider secret this installer MANAGES on a client's worker.
 *
 * Managed means reconciled: a name in this list that is present on the worker
 * and NOT returned by `optionalWorkerSecretNames` for that manifest is DELETED
 * by the next `brain secrets` run. That is the point — it is how a brain
 * switched off Supabase stops carrying a Supabase credential.
 *
 * It is also a loaded gun, and the bank-feed names are the reason to say so
 * out loud. Adding a name here WITHOUT teaching `optionalWorkerSecretNames`
 * to return it when the manifest enables that feature means the next routine
 * `brain secrets` run silently deletes it, and every bank connection on that
 * install stops working with no error anywhere. The two functions are one
 * change and must never be edited apart.
 */
export const WORKER_PROVIDER_SECRET_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BANK_FEED_CLIENT_ID",
  "BANK_FEED_SECRET",
]);

export function optionalWorkerSecretNames(m) {
  // Never harvest unrelated credentials merely because they happen to be in
  // the operator's shell. A standard D1 + Workers AI install needs only its
  // ADMIN_KEY. Supabase credentials are eligible only when the manifest
  // explicitly selects that backend. Anthropic is eligible only when the
  // manifest explicitly selects a non-Cloudflare answer model or reranking.
  const storage = m.infrastructure?.cloudflare?.storage || "d1";
  const answerModel = String(
    m.retrieval?.answer_model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  );
  // The bank feed's two service identifiers are eligible exactly when the
  // manifest turns the feed on. This half is not optional politeness: it is
  // what stops `reconcileWorkerProviderSecrets` from deleting them on the next
  // routine run and disconnecting every bank the client authorised. See the
  // note on WORKER_PROVIDER_SECRET_NAMES above; the two change together.
  const bankFeed = m.corpora?.bank_feed?.enabled === true;
  return Object.freeze([
    ...(storage === "supabase" ? ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] : []),
    ...(m.retrieval?.rerank === true || !answerModel.startsWith("@cf/")
      ? ["ANTHROPIC_API_KEY"]
      : []),
    ...(bankFeed ? ["BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET"] : []),
  ]);
}

async function reconcileWorkerProviderSecrets(m, acct, scriptName, optional) {
  const path = `/accounts/${acct.id}/workers/scripts/${scriptName}/secrets`;
  let current;
  try {
    current = await cf(path);
  } catch {
    die(
      "the Worker's existing secret names could not be inspected, so provider-secret reconciliation stopped.\n" +
        "  Nothing was removed. Fix Workers Scripts access and rerun `brain secrets`."
    );
  }
  if (!Array.isArray(current) || current.some((binding) =>
    !binding || typeof binding !== "object" || typeof binding.name !== "string")) {
    die("Cloudflare returned an invalid Worker secret inventory. Nothing was removed.");
  }
  const allowed = new Set(optional);
  const present = new Set(current.map((binding) => binding.name));
  const unwanted = WORKER_PROVIDER_SECRET_NAMES.filter((name) =>
    present.has(name) && !allowed.has(name));
  if (!unwanted.length) return;

  for (const name of unwanted) {
    try {
      await cf(`${path}/${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch {
      die(
        `the unexpected Worker secret ${name} could not be removed. ` +
          "Rerun `brain secrets`; no unrecognized secret names were touched."
      );
    }
  }

  let verified;
  try {
    verified = await cf(path);
  } catch {
    die(
      "the provider-secret cleanup could not be read back from Cloudflare. " +
        "Rerun `brain secrets` before treating this install as reconciled."
    );
  }
  const remaining = new Set(Array.isArray(verified)
    ? verified.map((binding) => binding?.name).filter((name) => typeof name === "string")
    : []);
  const failed = unwanted.filter((name) => remaining.has(name));
  if (!Array.isArray(verified) || failed.length) {
    die(
      "Cloudflare did not verify removal of every unexpected provider secret. " +
        "Rerun `brain secrets` before treating this install as reconciled."
    );
  }
  for (const name of unwanted) ok(`removed unexpected Worker secret ${name}`);
}

export async function cmdSecrets(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;

  // What a D1 install actually reads. The worker embeds through the AI binding,
  // so there is no database credential to set: the brain's storage is D1 and
  // Vectorize inside the client's own account, reachable only by their worker.
  // RAG_PROXY_KEY is derived from ADMIN_KEY, not read from the shell, so it is
  // "needed" in the same sense: available exactly when the admin key is. Until
  // it is set, any UI proxy has to carry the admin key, which can drain.
  const needed = ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY"];
  const optional = optionalWorkerSecretNames(m);
  const explicitAdminKey = Object.hasOwn(options, "explicitAdminKey")
    ? options.explicitAdminKey
    : (process.env.ADMIN_KEY || null);
  const persistenceOptions = {
    platform: options.platform ?? process.platform,
    username: options.username ?? process.env.USERNAME ?? process.env.USER,
    ...(options.persistenceOptions || {}),
  };

  // The durable copy is desired state. An explicit rotation is persisted and
  // read back first, so a crash or ambiguous remote failure can be retried from
  // that exact value without reconstructing it from a lost shell.
  let adminKeyPlan;
  let adminKey = null;
  let adminReceipt = null;
  try {
    const plan = options.adminKeyPersistencePlan ?? adminKeyPersistencePlan;
    adminKeyPlan = plan(manifestPath, m, persistenceOptions);
    if (adminKeyPlan.backend === "file" && explicitAdminKey) {
      const inspectKeyDir = options.assertKeyDirSafe ?? assertKeyDirSafe;
      inspectKeyDir(dirname(adminKeyPlan.path));
    }
  } catch (error) {
    die(`ADMIN_KEY durable-storage preflight failed: ${String(error?.message || error)}`);
  }

  if (explicitAdminKey) {
    adminKey = explicitAdminKey;
  } else {
    try {
      const readDurable = options.readAdminKeyDurably ?? readAdminKeyDurably;
      adminKey = await readDurable(adminKeyPlan, persistenceOptions);
      if (adminKey) adminReceipt = Object.freeze({ ...adminKeyPlan, verified: true, reused: true });
    } catch {
      die(
        "the durable ADMIN_KEY could not be read and verified. Fix its declared local storage,\n" +
          "  then rerun `brain secrets <manifest>`."
      );
    }
  }

  const provided = [
    ...(adminKey ? needed : []),
    ...optional.filter((name) => process.env[name]),
  ];
  const missing = adminKey ? [] : needed;

  if (!provided.length) {
    die(
      "no ADMIN_KEY was found in durable storage. Run `brain setup <manifest>` to generate,\n" +
        "      persist, and verify one. A deliberate manual replacement must be injected by an\n" +
        "      approved no-history credential launcher before `brain secrets`; never paste the key\n" +
        "      into a shell command."
    );
  }

  const acct = await resolveAccount(m);

  // A crash between staging and replacement can leave the key module's exact
  // temporary or rollback basename behind. Put every private key basename in
  // .gitignore before an adjacent-file write starts, not after it succeeds.
  // Reused legacy files receive the same tracked-file check so an already
  // committed plaintext key is never silently reapplied. The Worker account
  // lookup above is read-only, so an ignore failure cannot follow a mutation.
  if (adminKeyPlan?.backend === "file") {
    try {
      const ignorePrivateKey = options.gitignoreTheKey ?? gitignoreTheKey;
      ignorePrivateKey(dirname(adminKeyPlan.path));
    } catch (error) {
      const remedy = /already tracked by Git/i.test(String(error?.message || ""))
        ? "The adjacent .brain-admin-key is already tracked by Git. Remove it from the Git index, then rerun."
        : "Fix .gitignore permissions or the local Git repository, then rerun.";
      die(
        "refusing to write the adjacent ADMIN_KEY because Git safety could not be verified or the install's .gitignore could not be updated. " +
          `The durable key and Worker secret were not changed. ${remedy}`
      );
    }
  }

  if (explicitAdminKey) {
    try {
      const persist = options.persistAdminKeyDurably ?? persistAdminKeyDurably;
      adminReceipt = await persist(adminKeyPlan, explicitAdminKey, persistenceOptions);
    } catch {
      const destination = adminKeyPlan?.backend === "keychain"
        ? "the manifest-declared macOS Keychain item"
        : "the adjacent protected admin-key file";
      die(
        `ADMIN_KEY was not changed on the remote Worker because ${destination} could not be updated and verified.\n` +
          "  Fix the local storage problem and rerun `brain secrets <manifest>`."
      );
    }
  }

  await reconcileWorkerProviderSecrets(m, acct, scriptName, optional);

  for (const name of provided) {
    const value = name === "ADMIN_KEY"
      ? adminKey
      : name === "RAG_PROXY_KEY"
        ? deriveRagProxyKey(adminKey)
        : name === "SESSION_SIGNING_KEY"
          ? deriveSessionSigningKey(adminKey)
          : process.env[name];
    try {
      await cf(`/accounts/${acct.id}/workers/scripts/${scriptName}/secrets`, {
        method: "PUT",
        body: { name, text: value, type: "secret_text" },
      });
    } catch (e) {
      // A secret is set ON a script, so the script has to exist. The raw 404
      // says "This Worker does not exist on your account", which sends people
      // looking at their account rather than at the order they ran things in.
      if (/does not exist/i.test(e.message) || /\(404\)/.test(e.message)) {
        die(
          `the worker "${scriptName}" has not been deployed yet, so there is nothing to set secrets on.\n` +
            "  Run `brain deploy <manifest>` first, then `brain secrets`. Deploying without\n" +
            "  secrets is safe: the deploy carries keep_bindings, so setting them afterwards\n" +
            "  sticks and later deploys preserve them. The durable ADMIN_KEY was kept for that retry."
        );
      }
      if (name === "RAG_PROXY_KEY") {
        // The brain is fully usable without this key; its absence just means a
        // UI proxy must carry the admin key, which is where every install was
        // before this existed. Failing the whole command here would turn a
        // working install into a broken one over a hardening improvement.
        warn(
          "the read-only RAG_PROXY_KEY could not be set on the Worker. The brain is fine and\n" +
            "        ADMIN_KEY is unaffected. Until this succeeds, any UI proxy must carry the full\n" +
            "        admin key, which can ingest, purge, reindex and drain. Rerun `brain secrets`."
        );
        continue;
      }
      if (name === "SESSION_SIGNING_KEY") {
        // Same non-fatal posture: the brain answers fine without passkey
        // sign-ins; only the /app page is waiting on this secret.
        warn(
          "the SESSION_SIGNING_KEY could not be set on the Worker. ADMIN_KEY is unaffected.\n" +
            "        Until this succeeds, passkey sign-ins on the /app page will not work. Rerun `brain secrets`."
        );
        continue;
      }
      if (name === "ADMIN_KEY") {
        die(
          "the durable ADMIN_KEY is verified, but its Worker update did not complete.\n" +
            "  The durable value was kept as desired state. Rerun `brain secrets <manifest>`;\n" +
            "  No credential re-entry is needed for the retry."
        );
      }
      throw e;
    }
    if (name === "ADMIN_KEY") {
      if (adminReceipt.backend === "file") {
        ok(`secret ADMIN_KEY set from the verified durable copy at ${relative(process.cwd(), adminReceipt.path)}`);
        warn(
          `SECRET: ${relative(process.cwd(), adminReceipt.path)}\n` +
            "        This key reads the entire brain. Commands load it automatically.\n" +
            "        Do not commit it and do not leave it in a synced folder."
        );
      } else {
        ok(
          `secret ADMIN_KEY set from the verified macOS Keychain copy ` +
            `(service ${adminReceipt.service}, account ${adminReceipt.account})`
        );
        info("the declared Keychain item is authoritative; no adjacent .brain-admin-key copy was written");
      }

      // Standalone rotation updates only registrations the owner already chose.
      // Setup performs the full add path later. Imported unit tests stay inert
      // unless they inject this seam, so fixtures can never touch real configs.
      const reconcile = Object.hasOwn(options, "reconcileExistingAgents")
        ? options.reconcileExistingAgents
        : (IS_MAIN ? wireAgents : null);
      if (reconcile) {
        let reconciliation;
        try {
          reconciliation = await reconcile(m, manifestPath, {
            ...(options.agentOptions || {}),
            account: acct,
            existingOnly: true,
          });
        } catch {
          reconciliation = { wired: [], failures: ["agent-reconciliation"] };
        }
        const failures = Array.isArray(reconciliation) ? [] : (reconciliation?.failures || []);
        if (failures.length) {
          die(
            "the durable and Worker admin key were updated, but an existing AI tool registration\n" +
              "  could not be replaced and verified safely. Run `brain setup <manifest>` to repair\n" +
              "  the chosen registration; do not copy the key into a command."
          );
        }
      }
      info(
        "If Claude Desktop has a manual entry for this brain, replace it with the locator-only\n" +
          "        output from `brain mcp-config <manifest>`, then restart Claude Desktop."
      );
      continue;
    }
    if (name === "RAG_PROXY_KEY") {
      ok("secret RAG_PROXY_KEY set, derived from this brain's admin key");
      info(
        "this key answers questions and nothing else. Give it to a UI proxy instead of the\n" +
          "        admin key. Rotating ADMIN_KEY also rotates it."
      );
      continue;
    }
    if (name === "SESSION_SIGNING_KEY") {
      ok("secret SESSION_SIGNING_KEY set, derived from this brain's admin key");
      info(
        "signs the owner's passkey session cookies on the /app page. Rotating ADMIN_KEY\n" +
          "        rotates it too, which signs every device out — correct for a rotation."
      );
      continue;
    }
    ok(`secret ${name} set`);
  }
  // ADMIN_KEY absent means every authenticated route stays shut. Optional
  // Postgres or model secrets may have been written successfully, but that is
  // not a usable install and must not turn the command green.
  if (missing.includes("ADMIN_KEY")) {
    die(
      "ADMIN_KEY remains absent. Any optional secrets above were saved, but every route\n" +
        "  except /health will return 401. Run `brain setup <manifest>` to generate and persist it;\n" +
        "  successfully written optional secrets do not need to be removed first."
    );
  }
  return Object.freeze({ adminKey: adminReceipt });
}

/**
 * Decide what a /health probe means during a deploy.
 *
 * Pulled out and exported because this is the exact logic that failed in the
 * field: a 200 was treated as proof the new build was live, but Cloudflare keeps
 * serving the PREVIOUS worker for a few seconds after a deploy. The probe read
 * 0.1.1, and the tool announced "now at 0.1.2". A genuinely broken deploy would
 * have passed the same check green.
 *
 * Returns "accept" | "retry" | "fail".
 */
export function healthProbeVerdict({
  ok,
  body,
  expectVersion = null,
  expectDrainMode = null,
  attempt = 1,
  attempts = 6,
}) {
  if (ok) {
    if (!expectVersion && !expectDrainMode) return "accept";
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    const versionMatches = !expectVersion || parsed?.version === expectVersion;
    const drainModeMatches = !expectDrainMode || (
      parsed?.vector_writer_protocol === "lease-v1" &&
      parsed?.vector_drain_mode === expectDrainMode
    );
    if (versionMatches && drainModeMatches) return "accept";
    return attempt < attempts ? "retry" : "fail";
  }
  return attempt < attempts ? "retry" : "fail";
}

/**
 * Give count mismatches a direction-aware recovery. Missing provider rows can
 * be rebuilt from D1. Excess provider-only rows cannot: their ids no longer
 * exist in D1, so a reindex has nothing it can enumerate and delete.
 */
function vectorCountMismatchFailure(expected, actual, { prefix = "" } = {}) {
  const header = `${prefix}Vectorize holds ${actual} vector(s), but D1 requires ${expected}.`;
  if (actual < expected) {
    return header + "\n" +
      "      Semantic search is missing vectors. Diagnose and rebuild the missing projection:" + "\n" +
      "      brain diagnose <manifest>" + "\n" +
      "      brain reindex <manifest> --yes";
  }
  if (actual > expected) {
    return header + "\n" +
      "      Vectorize contains provider-only excess vectors that reindex cannot enumerate or remove." + "\n" +
      "      Do not treat this brain as healthy. Use supervised recovery to recreate/rebind a clean" + "\n" +
      "      Vectorize index and every metadata index, then reindex, drain, health-check, and test.";
  }
  return header + "\n" +
    "      The count receipt contradicts its mismatch reason. Run `brain diagnose <manifest>` and keep this brain out of service.";
}

async function cmdHealth(manifestPath, {
  expectVersion = null,
  expectDrainMode = null,
  durableAdminKeyOnly = false,
  reachOnly = false,
} = {}) {
  const { m } = loadManifest(manifestPath);
  // Cloudflare is OPTIONAL here, deliberately. This command talks to the worker
  // over plain HTTPS with the admin key, so it must keep working after our token
  // is revoked at handoff. A command that proves the brain works, but only while
  // we still hold a key to the client's account, proves the wrong thing.
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;

  const sub = acct
    ? await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null)
    : null;
  const base = m.brain?.domain
    ? `https://${m.brain.domain}`
    : sub?.subdomain
      ? `https://${scriptName}.${sub.subdomain}.workers.dev`
      : null;
  if (!base) die("could not determine a URL for this install.");

  info(`probing ${base}`);

  // A freshly deployed worker is not instantly routable: the workers.dev route
  // 404s for a few seconds while it propagates. Failing immediately turns a
  // normal wait into a false alarm, and during an upgrade that false alarm
  // reads as "the release is broken", which is the worst possible wrong
  // conclusion to hand someone mid-deploy. Same lag class as secret
  // propagation, and as a deleted worker still answering 200.
  let res, body;
  const healthAttempts = 6;
  for (let i = 1; i <= healthAttempts; i++) {
    res = await http(`${base}/health?cb=${i}`, {}, { timeoutMs: 20_000, what: "the health check" });
    body = await res.text();
    // A 200 is NOT proof the new build is live. Cloudflare keeps serving the
    // PREVIOUS worker for a few seconds after a deploy, so breaking on the first
    // 200 verifies the build that was just replaced and reports it as success.
    // Found in the field on a real upgrade: the probe read 0.1.1 and the tool
    // said "now at 0.1.2". A genuinely broken deploy would pass this green.
    const verdict = healthProbeVerdict({
      ok: res.ok,
      body,
      expectVersion,
      expectDrainMode,
      attempt: i,
      attempts: healthAttempts,
    });
    if (verdict === "accept") break;

    if (res.ok && (expectVersion || expectDrainMode)) {
      let live = null;
      let liveDrainMode = null;
      try {
        const parsed = JSON.parse(body);
        live = parsed?.version || null;
        liveDrainMode = parsed?.vector_drain_mode || null;
      } catch { /* not JSON */ }
      if (verdict === "retry") {
        const expectation = [
          expectVersion ? `version ${expectVersion}` : null,
          expectDrainMode ? `vector drain mode ${expectDrainMode}` : null,
        ].filter(Boolean).join(" and ");
        info(`/health is still answering ${live || "an unknown version"}/${liveDrainMode || "unknown drain mode"}, waiting for ${expectation}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      die(
        `the deploy is not live. /health still reports ${live || "no version"}/${liveDrainMode || "no drain mode"} after ${healthAttempts} attempts,` + "\n" +
          `  but ${expectVersion || "the expected version"}/${expectDrainMode || "the expected drain mode"} was just deployed.` + "\n" +
          "  The upgrade is NOT verified. Re-run it, and if this repeats the worker is" + "\n" +
          "  not being replaced: check the script name in the manifest against Cloudflare."
      );
    }
    if (verdict === "retry" && (res.status === 404 || res.status >= 500)) {
      info(`${res.status} on attempt ${i}/${healthAttempts}, waiting for the route to propagate`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    break;
  }
  if (!res.ok) die(`/health returned ${res.status} after ${healthAttempts} attempts: ${body.slice(0, 200)}`);
  ok(`/health ${res.status} ${body.slice(0, 160)}`);
  if (reachOnly) return;

  const key = resolveAdminKey(manifestPath, { ignoreEnvironment: durableAdminKeyOnly });
  if (!key) {
    die(
      "no admin key is available, so health cannot prove the authenticated documents endpoint." + "\n" +
        "      Run `brain setup <manifest>` or repair the manifest's declared durable admin-key storage,\n" +
        "      then re-run `brain health`. Do not paste the key into a shell command."
    );
  }

  // Secrets take a few seconds to reach every edge location. Running `secrets`
  // and `health` back to back therefore races, and the failure looks exactly
  // like a wrong key: a flat 401. Retrying turns a confusing false alarm into
  // a short wait. A live shadow install on 2026-08-23 was still returning 401
  // after the old 16-second window, then accepted the same Keychain value. Give
  // Cloudflare up to roughly a minute before calling the value wrong.
  const attempts = 15;
  for (let i = 1; i <= attempts; i++) {
    const docs = await http(`${base}/api/admin/brain/documents`, {
      headers: { "X-Admin-Key": key },
    });
    const dbody = await docs.text();
    if (docs.ok) {
      let inventory;
      try {
        inventory = JSON.parse(dbody);
      } catch {
        die(
          `documents endpoint ${docs.status} did not return JSON, so authenticated access was not proven.` + "\n" +
            "      Re-run `brain health`; if this repeats, the configured domain is not serving this brain."
        );
      }
      if (!inventory || typeof inventory !== "object" ||
          typeof inventory.backend !== "string" || !inventory.backend ||
          !Array.isArray(inventory.rows)) {
        die(
          `documents endpoint ${docs.status} returned an invalid inventory, so authenticated access was not proven.` + "\n" +
            "      Re-run `brain health`; if this repeats, the deployed Worker and installer do not match."
        );
      }
      const actualBackend = inventory.backend.trim().toLowerCase();
      if (!["d1", "supabase"].includes(actualBackend)) {
        die(
          "the authenticated documents endpoint returned an unsupported storage backend." + "\n" +
            "      Health cannot pass because the deployed Worker and installer do not match."
        );
      }
      // D1 is the schema and deploy default. An omitted storage field must not
      // make health accept an old Supabase Worker at the configured URL.
      const expectedBackend = String(m.infrastructure?.cloudflare?.storage || "d1").trim().toLowerCase();
      if (actualBackend !== expectedBackend) {
        die(
          "the authenticated documents endpoint is serving a different storage backend than this manifest." + "\n" +
            "      Health cannot pass because this URL may point at an old or misbound brain."
        );
      }
      ok(`documents endpoint ${docs.status}; authenticated inventory confirmed`);

      // D1 and Vectorize cannot share a transaction. Both systems can be up
      // while semantic search is behind or stale, so the operation backlog is
      // part of health, not an implementation detail. A 200 with an error or
      // malformed backlog is a failed health check, never proof of zero work.
      if (actualBackend === "d1") {
        const backlog = inventory.vector_backlog;
        const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
        if (!backlog || typeof backlog !== "object" || Array.isArray(backlog) ||
            Object.prototype.hasOwnProperty.call(backlog, "error") ||
            !validCount(backlog.pending) || !validCount(backlog.upserts) ||
            !validCount(backlog.deletes) || !validCount(backlog.submitted) ||
            backlog.upserts + backlog.deletes !== backlog.pending ||
            backlog.submitted > backlog.pending) {
          die(
            "the documents endpoint could not prove a valid D1 vector backlog." + "\n" +
              "      Health cannot pass because semantic indexing may be stalled or incomplete."
          );
        }
        const readiness = inventory.vector_readiness;
        if (!readiness || typeof readiness !== "object" || Array.isArray(readiness) ||
            Object.prototype.hasOwnProperty.call(readiness, "error") ||
            typeof readiness.ready !== "boolean" || !validCount(readiness.expected_vectors) ||
            !validCount(readiness.actual_vectors) || !validCount(readiness.pending) ||
            !validCount(readiness.submitted) || readiness.pending !== backlog.pending ||
            readiness.submitted !== backlog.submitted || readiness.submitted > readiness.pending) {
          die(
            "the documents endpoint could not prove Vectorize query readiness." + "\n" +
              "      Health cannot pass from queue depth alone because Vectorize mutations are asynchronous."
          );
        }
        if (backlog.pending > 0) {
          const queuedAt = backlog.oldest_queued_at;
          if (!Number.isSafeInteger(queuedAt) || queuedAt < 0) {
            die(
              "the documents endpoint reported queued vector work without a valid oldest timestamp." + "\n" +
                "      Health cannot determine whether semantic indexing is stalled."
            );
          }
          const oldest = Math.max(0, Math.floor((Date.now() - queuedAt) / 60000));
          if (oldest > 30) {
            die(
              `${backlog.pending} vector operation(s) are stalled` +
                ` (${backlog.upserts} upsert, ${backlog.deletes} delete, ${backlog.submitted} accepted), oldest queued ${oldest} min ago.` + "\n" +
                "      Older than 30 minutes means the drain cron is not keeping up. Upserts are" + "\n" +
                "      keyword-only; deletes leave stale vectors competing. Clear it now with:" + "\n" +
                "      brain drain <manifest>" + "\n" +
                "      If it returns, inspect the Worker schedule in the Cloudflare dashboard."
            );
          }
          die(
            `${backlog.pending} vector operation(s) are not query-visible yet` +
              ` (${backlog.submitted} accepted by Vectorize), oldest queued ${oldest} min ago.` + "\n" +
              "      Provider acceptance is not completion. Finish and confirm visibility with:" + "\n" +
              "      brain drain <manifest>"
          );
        }
        if (!readiness.ready || readiness.actual_vectors !== readiness.expected_vectors) {
          if (readiness.reason === "vector_count_mismatch") {
            die(vectorCountMismatchFailure(
              readiness.expected_vectors,
              readiness.actual_vectors,
            ));
          }
          die(
            "Vectorize has accepted work that is not query-visible yet." + "\n" +
              "      Re-run `brain drain <manifest>`; it waits without paying to re-embed accepted rows."
          );
        }
        ok(`vector index is query-ready (${readiness.actual_vectors} confirmed vector(s))`);
      }
      return;
    }
    if (docs.status === 401 && i < attempts) {
      info(`401 on attempt ${i}/${attempts}, waiting for secret propagation`);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    if (docs.status === 401) {
      die(
        `documents endpoint is still unauthorized after ${attempts} attempts.` + "\n" +
          "      Health cannot pass until the local admin key matches the deployed secret."
      );
    }
    die(
      `documents endpoint ${docs.status}, so authenticated access was not proven.` + "\n" +
        "      Fix the endpoint and re-run `brain health`."
    );
  }

  die("authenticated documents access could not be proven after all health attempts.");
}

/** Ask one private question without requiring Claude Code, Codex, or a token. */
export async function cmdAsk(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const prompt = options.ask ?? ask;
  const question = String(await prompt("What do you want to know?", "")).trim();
  closePrompts();
  if (!question) die("no question entered. Run the command again when you are ready.");

  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = options.adminKey ?? resolveAdminKey(manifestPath);
  if (!adminKey) {
    die("no admin key found: re-run `brain setup` so this Brain can be opened safely.");
  }

  const request = options.http ?? http;
  const response = await request(
    `${base}/api/rag/think`,
    {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: question, limit: 8 }),
    },
    { timeoutMs: 90_000, what: "the answer" },
  );
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { /* validated below */ }
  if (!response.ok || !body || typeof body !== "object") {
    die(`the Brain could not answer (HTTP ${response.status}). Run \`brain support --preview\` for the safe issue note.`);
  }

  // An empty result from a search that could not run is not an absence, and
  // the canonical refusal sentence would state one. The owner reads this line
  // and nothing else, so the distinction has to survive to here.
  const unavailable = retrievalUnavailable(body);
  const answer = typeof body.answer === "string" && body.answer.trim()
    ? body.answer.trim()
    : unavailable
      ? (typeof body.notice === "string" && body.notice.trim()
        ? body.notice.trim()
        : unavailableNotice(body.degraded))
      : "The documents do not answer the question.";
  console.log(`\n${answer}\n`);
  // Trust metadata is a separate line by design: the answer string is a
  // verbatim contract (the refusal scorer reads every clause of it), so the
  // rubric score rides beside it rather than inside it. There is no rubric for
  // an unavailable search: "how sure are we that nothing is recorded" has no
  // answer when nothing was read.
  const trust = unavailable ? null : confidenceLine(body.confidence, {
    refused: /^The documents do not answer/i.test(answer),
  });
  if (trust) console.log(`  ${c.dim(trust)}\n`);
  if (body.answer_error) warn(`answer generation reported: ${String(body.answer_error).slice(0, 160)}`);
  if (body.degraded) warn(`search is degraded: ${String(body.degraded).slice(0, 80)}`);
  const citations = Array.isArray(body.citations) ? body.citations : [];
  if (citations.length) {
    console.log(`  ${c.bold("Sources")}`);
    for (const citation of citations) {
      const number = Number.isInteger(citation?.n) ? `[${citation.n}]` : "[ ]";
      const title = String(citation?.title || "Untitled").replace(/\s+/g, " ").slice(0, 140);
      const source = String(citation?.source || "source").replace(/\s+/g, " ").slice(0, 40);
      console.log(`  ${number} ${title} (${source})`);
    }
    console.log("");
  }
  return body;
}

/* ---------------------------------------------------------- migrations */


async function d1Query(acctId, dbId, sql, params = []) {
  const res = await cf(`/accounts/${acctId}/d1/database/${dbId}/query`, {
    method: "POST",
    body: { sql, params },
  });
  return Array.isArray(res) ? res[0] : res;
}

function loadMigrations() {
  const dir = join(HERE, "migrations", "d1");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf-8");
      return {
        version: parseInt(f.split("_")[0], 10),
        name: f.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    });
}

/**
 * Split a migration file into statements.
 *
 * D1's query endpoint takes one statement at a time, so a migration file has to
 * be split. Two things make that harder than `split(";")`.
 *
 * A semicolon inside a STRING LITERAL is not a statement boundary, so the scan
 * below tracks quote state (including the '' escape).
 *
 * A semicolon inside a TRIGGER BODY is not one either, and this is the case that
 * actually bit. `CREATE TRIGGER ... BEGIN <stmt>; <stmt>; END;` is ONE statement
 * containing several. Splitting naively yields a truncated trigger with no END
 * plus an orphan `END`, and D1 rejects the first with "incomplete input". The
 * migration then aborts partway, which is the worst possible outcome: the tables
 * exist, the triggers do not, and keyword search returns nothing forever while
 * every health probe passes.
 *
 * So fragments opening a CREATE TRIGGER are re-joined until their END arrives.
 * An unterminated one is emitted as-is rather than swallowed, so SQLite reports
 * the real error instead of this function hiding it.
 */
export function splitStatements(sql) {
  const src = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const fragments = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      if (inString && src[i + 1] === "'") {
        buf += "''";
        i++;
        continue;
      }
      inString = !inString;
      buf += c;
      continue;
    }
    if (c === ";" && !inString) {
      fragments.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) fragments.push(buf);

  const endsWithEnd = (t) => /\bEND\s*$/i.test(t.trim());
  const out = [];
  let pending = null;
  for (const frag of fragments) {
    if (pending !== null) {
      pending += ";" + frag;
      if (endsWithEnd(frag)) {
        out.push(pending);
        pending = null;
      }
      continue;
    }
    const t = frag.trim();
    if (!t) continue;
    if (/\bCREATE\s+TRIGGER\b/i.test(t) && !endsWithEnd(t)) {
      pending = frag;
      continue;
    }
    out.push(frag);
  }
  if (pending !== null) out.push(pending);

  return out.map((s) => s.trim()).filter(Boolean);
}

function addedColumnDescriptor(statement) {
  const match = String(statement).match(
    /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/i,
  );
  if (!match) return null;
  const tail = match[4] || "";
  const defaultMatch = tail.match(/\bDEFAULT\s+([^\s,;]+)/i);
  return {
    table: match[1],
    column: match[2],
    type: match[3].toUpperCase(),
    notNull: /\bNOT\s+NULL\b/i.test(tail),
    defaultValue: defaultMatch ? defaultMatch[1] : null,
  };
}

function normalizedSqlDefault(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Apply per-statement D1 migrations so a process restart can safely resume.
 *
 * D1's REST query endpoint commits each statement independently. An ADD COLUMN
 * can therefore succeed even when the command dies before schema_migrations is
 * updated. SQLite has no portable ADD COLUMN IF NOT EXISTS syntax, so the
 * runner proves the existing column's complete declared contract before
 * treating that exact statement as already applied. All other statements in
 * restart-sensitive migrations must themselves be idempotent.
 */
export async function runRestartSafeMigrationStatements(
  statements,
  queryStatement,
  { afterStatement = null } = {},
) {
  if (!Array.isArray(statements) || typeof queryStatement !== "function") {
    throw new Error("migration statement runner received invalid input");
  }
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    const descriptor = addedColumnDescriptor(statement);
    let skipped = false;
    if (descriptor) {
      const inspected = await queryStatement(`PRAGMA table_info(${descriptor.table})`);
      if (!inspected || !Array.isArray(inspected.results)) {
        throw new Error(`migration could not inspect ${descriptor.table}.${descriptor.column}`);
      }
      const existing = inspected.results.find((row) => row?.name === descriptor.column);
      if (existing) {
        const compatible = String(existing.type || "").toUpperCase() === descriptor.type &&
          Number(existing.notnull || 0) === Number(descriptor.notNull) &&
          normalizedSqlDefault(existing.dflt_value) === normalizedSqlDefault(descriptor.defaultValue);
        if (!compatible) {
          throw new Error(
            `migration column ${descriptor.table}.${descriptor.column} already exists with an incompatible schema`,
          );
        }
        skipped = true;
      }
    }
    if (!skipped) await queryStatement(statement);
    if (afterStatement) await afterStatement({ index, statement, skipped });
  }
}

async function appliedVersions(acctId, dbId, queryDatabase = d1Query) {
  try {
    const r = await queryDatabase(acctId, dbId, "SELECT version, checksum, name FROM schema_migrations");
    return r?.results || [];
  } catch {
    return []; // table does not exist yet, so nothing is applied
  }
}

export async function cmdMigrate(manifestPath, options = {}) {
  const { silent = false } = options;
  const resolveMigrateAccount = options.resolveAccount ?? resolveAccount;
  const queryDatabase = options.d1Query ?? d1Query;
  const { m } = loadManifest(manifestPath);
  const acct = await resolveMigrateAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const all = loadMigrations();
  if (!all.length) die("no migrations found.");
  const applied = await appliedVersions(acct.id, dbId, queryDatabase);
  const appliedMap = new Map(applied.map((a) => [a.version, a]));

  // A migration whose content changed after being applied is a hard stop.
  // Editing an applied migration means two installs silently have different
  // schemas under the same version number, which is the worst possible state
  // to debug: everything reports as up to date and nothing matches.
  for (const mig of all) {
    const prev = appliedMap.get(mig.version);
    if (prev && prev.checksum !== mig.checksum) {
      die(
        `migration ${mig.name} was already applied but its content has changed.\n` +
          `      applied checksum ${prev.checksum}, file checksum ${mig.checksum}\n` +
          "      Applied migrations stay as history. Add a new migration for the next change."
      );
    }
  }

  const pending = all.filter((mig) => !appliedMap.has(mig.version));
  if (!pending.length) {
    if (!silent) ok(`schema up to date (${all.length} migration(s) applied)`);
  }

  // 0010-0013 change the protocol used by every Vectorize writer. A public
  // `brain migrate` against an already-running pre-lease Worker would recreate
  // the rolling race that update's paused compatibility deployment prevents.
  // The private option is passed only by the verified setup/update cutover; it
  // is intentionally not a CLI flag.
  if ((m.infrastructure?.cloudflare?.storage || "d1") === "d1" &&
      pending.some((migration) => [10, 11, 12, 13].includes(migration.version)) &&
      options.vectorDrainQuiesced !== true) {
    let installTable;
    try {
      installTable = await queryDatabase(
        acct.id,
        dbId,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'install_state'",
      );
    } catch {
      die("migration could not verify whether this brain is already live. Nothing was migrated.");
    }
    if (!installTable || !Array.isArray(installTable.results) || installTable.results.length > 1) {
      die("migration received an ambiguous install-state inventory. Nothing was migrated.");
    }
    if (installTable.results.length === 1) {
      // Absence of the singleton row is not freshness proof. A legacy or
      // interrupted install can have a live pre-lease Worker and the table but
      // no id=1 seed. Only a database with no install_state table at all is
      // eligible for the direct fresh-install path; every other prefix must use
      // setup/update's paused-worker quiescence protocol.
      die(
        "this existing brain needs the verified vector-writer cutover before migrations 0010-0013.\n" +
          "      Run `brain update` instead; direct migrate was stopped before changing D1.",
      );
    }
    let inventory;
    try {
      inventory = await queryDatabase(
        acct.id,
        dbId,
        `SELECT COUNT(*) AS user_table_count FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'`,
      );
    } catch {
      die("migration could not prove that this database is a fresh empty resource. Nothing was migrated.");
    }
    if (!inventory || !Array.isArray(inventory.results) || inventory.results.length !== 1 ||
        Number(inventory.results[0]?.user_table_count) !== 0) {
      die(
        "this database is not provably fresh, so migrations 0010-0013 require the verified writer cutover.\n" +
          "      Run `brain update` instead; direct migrate was stopped before changing D1.",
      );
    }
  }

  for (const mig of pending) {
    if (!silent) info(`applying ${mig.name}`);
    await runRestartSafeMigrationStatements(
      splitStatements(mig.sql),
      (statement) => queryDatabase(acct.id, dbId, statement),
    );
    await queryDatabase(
      acct.id,
      dbId,
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)",
      [mig.version, mig.name, new Date().toISOString(), mig.checksum]
    );
    if (!silent) ok(`applied ${mig.name}`);
  }

  const schemaVersion = Math.max(...all.map((x) => x.version));

  // Seed or refresh the single install_state row.
  //
  // NOTE: product_version is set on INSERT only, never on UPDATE. Migrating is
  // not the same as shipping: if a later step of the upgrade fails, the
  // database must not already claim the new version. Only `upgrade` advances
  // it, and only after verification passes.
  const now = new Date().toISOString();
  await queryDatabase(
    acct.id,
    dbId,
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring,
        vector_projection_status, vector_projection_bootstrap_epoch,
        vector_projection_bootstrap_cursor, vector_projection_bootstrap_high_water)
     VALUES (
       1,?,?,?,?,?,?,
       CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
       CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 1 ELSE 0 END,
       NULL,
       (SELECT MAX(chunk_uid) FROM chunks)
     )
     ON CONFLICT(id) DO UPDATE SET
       client_slug = excluded.client_slug,
       schema_version = excluded.schema_version,
       gate_version = excluded.gate_version`,
    [
      m.client?.slug || "unknown",
      PRODUCT_VERSION,
      schemaVersion,
      Math.max(Number(m.safety?.credential_scanner?.gate_version || 0), CREDENTIAL_GATE_VERSION),
      now,
      m.brain?.ring || "stable",
    ]
  );
  if (!silent) ok(`schema at version ${schemaVersion}`);
  return { applied: pending.length, schemaVersion };
}

async function cmdStatus(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest.");

  const st = await d1Query(acct.id, dbId, "SELECT * FROM install_state WHERE id = 1").catch(
    () => null
  );
  const row = st?.results?.[0];
  if (!row) {
    warn("no install_state row. This install has never been migrated.");
  } else {
    console.log(`  client          ${row.client_slug}`);
    console.log(`  product version ${row.product_version}`);
    console.log(`  schema version  ${row.schema_version}`);
    console.log(`  gate version    ${row.gate_version}`);
    console.log(`  ring            ${row.ring}`);
    console.log(`  installed       ${row.installed_at}`);
    console.log(`  last upgraded   ${row.last_upgraded_at || "never"}`);
  }

  const runs = await d1Query(
    acct.id,
    dbId,
    "SELECT started_at, from_version, to_version, status FROM upgrade_runs ORDER BY started_at DESC LIMIT 5"
  ).catch(() => null);
  const rows = runs?.results || [];
  if (rows.length) {
    console.log("\n  recent upgrades:");
    for (const r of rows) {
      const mark = r.status === "verified" ? "ok" : r.status === "rolled_back" ? "!!" : "  ";
      console.log(`    ${mark} ${r.started_at.slice(0, 19)}  ${r.from_version || "?"} -> ${r.to_version || "?"}  ${r.status}`);
    }
  }

  const local = loadMigrations();
  const applied = await appliedVersions(acct.id, dbId);
  const pending = local.filter((l) => !applied.some((a) => a.version === l.version));
  console.log(
    `\n  migrations: ${applied.length} applied, ${pending.length} pending${pending.length ? " (" + pending.map((p) => p.name).join(", ") + ")" : ""}`
  );
}

/**
 * Full upgrade: snapshot, migrate, deploy, verify.
 *
 * ROLLBACK IS DELIBERATELY NOT AUTOMATIC.
 *
 * The obvious design restores the D1 bookmark on any failed check. But a
 * restore is itself destructive and irreversible, and running one unattended
 * against a client's only copy of their data trades a broken deploy for
 * potential data loss. So this captures the bookmark, prints it, and stops.
 * A restore stays a reviewed decision because D1 recovery also requires a
 * Vectorize rebuild before semantic retrieval is trustworthy again.
 */
export function commitManifestVersion(manifestPath, version) {
  const pin = pinUpdateManifest(manifestPath);
  const target = pin.target;
  const before = pin.stat;
  const raw = pin.raw;
  const manifest = JSON.parse(raw);
  manifest.brain = { ...(manifest.brain || {}), version };
  const output = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      before.mode & 0o777,
    );
    if (writeSync(fd, output, 0, output.length, 0) !== output.length) {
      throw new Error("the manifest version write was incomplete");
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    revalidateUpdateManifest(pin, "local manifest version commit");
    renameSync(temporary, target);
    const verifiedPin = pinUpdateManifest(target);
    const verified = verifiedPin.manifest;
    if (verified?.brain?.version !== version) {
      throw new Error("the manifest version did not verify after its atomic write");
    }
    return verified;
  } finally {
    output.fill(0);
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function validD1Bookmark(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 1024 &&
    !/[\0-\x1f\x7f]/.test(value);
}

function parseSemver(value) {
  const source = String(value || "");
  if (!source || source.length > 128) throw new Error("not a bounded semantic version");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    source,
  );
  if (!match) throw new Error("not a semantic version");
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new Error("numeric prerelease identifiers cannot have leading zeroes");
    }
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

/** Compare two strict semantic versions without adding a release-time dependency. */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function sameUpgradeManifestStat(left, right) {
  return sameOpenedFile(left, right) &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/**
 * Open, identify, and hash the manifest without following a link.
 *
 * Lifecycle subcommands reopen the manifest, so an update must establish one
 * immutable identity before any Cloudflare mutation and reject any later swap.
 */
export function pinUpdateManifest(manifestPath) {
  if (!manifestPath) throw new Error("an update manifest path is required");
  const lexicalTarget = resolve(manifestPath);
  let descriptor;
  try {
    const lexicalBefore = lstatSync(lexicalTarget);
    if (!lexicalBefore.isFile() || lexicalBefore.isSymbolicLink() || lexicalBefore.nlink !== 1) {
      throw new Error("the update manifest must be one regular file, not a link");
    }
    // Resolve the parent only after refusing a file-level link. Lifecycle
    // subcommands receive this canonical path, so swapping a symlinked parent
    // directory cannot redirect a later stage after its fingerprint check.
    const target = join(realpathSync.native(dirname(lexicalTarget)), basename(lexicalTarget));
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error("the update manifest must be one regular file, not a link");
    }
    if (before.dev !== lexicalBefore.dev || before.ino !== lexicalBefore.ino) {
      throw new Error("the update manifest path changed while its directory was resolved");
    }
    descriptor = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameUpgradeManifestStat(before, opened)) {
      throw new Error("the update manifest changed while it was being opened");
    }
    const raw = readFileSync(descriptor, "utf8");
    const afterRead = fstatSync(descriptor);
    const afterPath = lstatSync(target);
    if (!sameUpgradeManifestStat(opened, afterRead) || !sameUpgradeManifestStat(opened, afterPath)) {
      throw new Error("the update manifest changed while it was being read");
    }
    const manifest = JSON.parse(raw);
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
      throw new Error("the update manifest must contain one JSON object");
    }
    return Object.freeze({
      target,
      raw,
      fingerprint: createHash("sha256").update(raw).digest("hex"),
      stat: opened,
      manifest,
    });
  } catch (error) {
    throw new Error(`update manifest safety check failed: ${String(error?.message || error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function revalidateUpdateManifest(pin, stage) {
  let current;
  try {
    current = pinUpdateManifest(pin.target);
  } catch {
    throw new Error(`the update manifest could not be revalidated during ${stage}`);
  }
  if (
    current.fingerprint !== pin.fingerprint ||
    !sameUpgradeManifestStat(pin.stat, current.stat)
  ) {
    throw new Error(`the update manifest changed during ${stage}; no later stage was run`);
  }
  return current;
}

function removeOwnedExecutionDirectory(path, expectedStat) {
  if (!path || !expectedStat) return;
  try {
    const current = lstatSync(path);
    if (current.isDirectory() && !current.isSymbolicLink() &&
        current.dev === expectedStat.dev && current.ino === expectedStat.ino) {
      // Never recurse. An unexpected/replaced child makes rmdir fail and leaves
      // the directory for review instead of deleting something we do not own.
      rmdirSync(path);
    }
  } catch {
    // Cleanup cannot replace the lifecycle command's real result.
  }
}

function writePinnedExecutionManifest(pin) {
  const keyReference = pin.manifest?.operations?.admin_key_secret;
  const usePrivateDirectory = typeof keyReference === "string" &&
    keyReference.startsWith("keychain://");
  const bytes = Buffer.from(pin.raw, "utf8");
  let path;
  let descriptor;
  let createdStat = null;
  let privateDirectory = null;
  let privateDirectoryStat = null;
  let completed = false;
  try {
    let parent = dirname(pin.target);
    if (usePrivateDirectory) {
      // Apple File Provider can update ctime/mtime on a newly created file in a
      // synced manifest directory. Keep the immutable execution copy outside
      // that provider. The raw manifest contains only the non-secret Keychain
      // locator; this function never reads or copies the Keychain value.
      privateDirectory = mkdtempSync(join(tmpdir(), "financial-brain-update-"));
      chmodSync(privateDirectory, 0o700);
      privateDirectoryStat = lstatSync(privateDirectory);
      if (!privateDirectoryStat.isDirectory() || privateDirectoryStat.isSymbolicLink() ||
          (process.platform !== "win32" && (privateDirectoryStat.mode & 0o077) !== 0)) {
        throw new Error("the private pinned-manifest directory did not verify");
      }
      parent = privateDirectory;
    }
    path = join(
      parent,
      `.${basename(pin.target)}.brain-update-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    createdStat = fstatSync(descriptor);
    if (!createdStat.isFile() || createdStat.nlink !== 1 ||
        (process.platform !== "win32" && (createdStat.mode & 0o077) !== 0)) {
      throw new Error("the private pinned manifest file did not verify");
    }
    if (writeSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw new Error("the pinned execution manifest write was incomplete");
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const executionPin = pinUpdateManifest(path);
    if (executionPin.fingerprint !== pin.fingerprint) {
      throw new Error("the pinned execution manifest did not verify");
    }
    completed = true;
    return Object.freeze({
      ...executionPin,
      cleanupDirectory: privateDirectory,
      cleanupDirectoryStat: privateDirectoryStat,
    });
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
    if (!completed && createdStat && path) {
      try {
        const current = lstatSync(path);
        if (current.dev === createdStat.dev && current.ino === createdStat.ino && current.nlink === 1) {
          unlinkSync(path);
        }
      } catch {
        // The caller's safety failure remains primary, and a replaced random
        // path is never removed as if it were still ours.
      }
    }
    if (!completed) removeOwnedExecutionDirectory(privateDirectory, privateDirectoryStat);
  }
}

function removePinnedExecutionManifest(pin) {
  try {
    const current = lstatSync(pin.target);
    if (current.dev === pin.stat.dev && current.ino === pin.stat.ino && current.nlink === 1) {
      unlinkSync(pin.target);
    }
  } catch {
    // Cleanup cannot replace the update's real result. A replaced path is left
    // untouched rather than deleting something we did not create.
  }
  removeOwnedExecutionDirectory(pin.cleanupDirectory, pin.cleanupDirectoryStat);
}

function cloudflareIdentity(manifest) {
  const cfg = manifest?.infrastructure?.cloudflare;
  const databaseId = cfg?.d1_database_id;
  if (typeof databaseId !== "string" || !databaseId || /^REQUIRED/i.test(databaseId)) {
    throw new Error("no d1_database_id in the manifest. Run `brain provision` first.");
  }
  const declaredAccountId = cfg?.account_id;
  return {
    databaseId,
    declaredAccountId:
      typeof declaredAccountId === "string" && declaredAccountId && !/^REQUIRED/i.test(declaredAccountId)
        ? declaredAccountId
        : null,
  };
}

function installStateRow(response) {
  if (!response || !Array.isArray(response.results)) {
    throw new Error("D1 returned an invalid install-state response");
  }
  if (response.results.length === 0) return null;
  if (response.results.length !== 1 || !response.results[0] || typeof response.results[0] !== "object") {
    throw new Error("D1 returned an ambiguous install-state response");
  }
  return response.results[0];
}

// Twenty minutes is the declared maximum supported old HTTP/cron drain
// invocation. A paused compatibility deployment plus this full grace period is
// the verified boundary after which no pre-lease Worker can still be writing
// Vectorize during the schema cutover. The matching new lease TTL is a drift
// check, not the reason an old Worker is assumed to honor a lease it never had.
export const VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS = 20 * 60 * 1000;

/**
 * Make the deliberately long writer-safety boundary visible to the owner.
 * Field evidence showed that a silent wait looks exactly like a hung process,
 * which caused a correct paused cutover to be interrupted before migration.
 */
export async function waitForVectorDrainCutover(waiter, { nextStep = "database migration" } = {}) {
  const minutes = Math.ceil(VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS / 60_000);
  info(`safety pause: waiting ${minutes} minutes for older database writers to finish`);
  info(`Keep this window open. The Worker is safely paused, but ${nextStep} has not started yet.`);
  await waiter(VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS);
  ok(`safety pause complete; starting ${nextStep}`);
}

// A large legacy corpus can need hundreds of bulk bootstrap requests plus
// visibility polling. Six hours is a safety boundary, not an estimate: every
// accepted page is durable, and the supported recovery is to rerun update and
// resume the same epoch rather than keeping an installer alive indefinitely.
export const ACCELERATED_BOOTSTRAP_MAX_MS = 6 * 60 * 60 * 1000;
export const ACCELERATED_BOOTSTRAP_MAX_ROUNDS = 20_000;
const ACCELERATED_BOOTSTRAP_POLL_MS = 3_000;
const ACCELERATED_BOOTSTRAP_REQUEST_MAX_MS = 180_000;
const BOOTSTRAP_PHASES = new Set(["legacy_drain", "building", "waiting", "complete"]);
const BOOTSTRAP_RECEIPT_FIELDS = Object.freeze([
  "protocol",
  "phase",
  "epoch",
  "total",
  "confirmed",
  "queued",
  "submitted",
  "remaining",
  "in_flight_batches",
  "failed",
  "complete",
  "vector_ready",
  "expected_vectors",
  "actual_vectors",
]);
const BOOTSTRAP_BUSY_FIELDS = Object.freeze([
  "protocol",
  "busy",
  "remaining",
  "retry_after_seconds",
]);
const BOOTSTRAP_COMPLETION_FIELDS = Object.freeze([
  "epoch",
  "total",
  "confirmed",
  "remaining",
  "rounds",
  "complete",
  "vector_ready",
]);

function exactAggregateReceiptFields(body, expected, label) {
  const actual = Object.keys(body).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    // Do not echo unexpected values or field names. This endpoint's privacy
    // contract is aggregate-only, so contract drift must not reach a terminal.
    die(`${label} did not match the aggregate-only response contract. Nothing was declared complete.`);
  }
}

/** Validate and sanitize one aggregate-only paused bootstrap receipt. */
export function validateAcceleratedBootstrapReceipt(body) {
  const label = "the accelerated bootstrap receipt";
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    die("accelerated bootstrap returned HTTP success without a valid aggregate receipt. Nothing was declared complete.");
  }
  exactAggregateReceiptFields(body, BOOTSTRAP_RECEIPT_FIELDS, label);
  if (body.protocol !== "bootstrap-v2" || !BOOTSTRAP_PHASES.has(body.phase)) {
    die(`${label} did not identify the supported protocol and phase. Nothing was declared complete.`);
  }
  const receipt = {
    protocol: body.protocol,
    phase: body.phase,
    epoch: nonNegativeReceiptCount(body, "epoch", label),
    total: nonNegativeReceiptCount(body, "total", label),
    confirmed: nonNegativeReceiptCount(body, "confirmed", label),
    queued: nonNegativeReceiptCount(body, "queued", label),
    submitted: nonNegativeReceiptCount(body, "submitted", label),
    remaining: nonNegativeReceiptCount(body, "remaining", label),
    in_flight_batches: nonNegativeReceiptCount(body, "in_flight_batches", label),
    failed: nonNegativeReceiptCount(body, "failed", label),
    complete: body.complete,
    vector_ready: body.vector_ready,
    expected_vectors: nonNegativeReceiptCount(body, "expected_vectors", label),
    actual_vectors: nonNegativeReceiptCount(body, "actual_vectors", label),
  };
  if (typeof receipt.complete !== "boolean" || typeof receipt.vector_ready !== "boolean") {
    die(`${label} did not include boolean completion and readiness proofs. Nothing was declared complete.`);
  }
  if (receipt.in_flight_batches > 3 || receipt.confirmed > receipt.total ||
      receipt.remaining !== receipt.total - receipt.confirmed ||
      receipt.queued + receipt.submitted > receipt.remaining) {
    die(`${label} counts did not reconcile. Nothing was declared complete.`);
  }
  if ((receipt.phase === "complete") !== receipt.complete) {
    die(`${label} completion phase contradicted its completion flag. Nothing was declared complete.`);
  }
  if (!receipt.complete && receipt.vector_ready) {
    die(`${label} claimed query readiness before the bootstrap completed. Nothing was declared complete.`);
  }
  if (receipt.complete && (
    receipt.remaining !== 0 || receipt.queued !== 0 || receipt.submitted !== 0 ||
    receipt.in_flight_batches !== 0 || receipt.failed !== 0 || !receipt.vector_ready ||
    receipt.expected_vectors !== receipt.actual_vectors ||
    receipt.expected_vectors !== receipt.total
  )) {
    die(`${label} did not prove an empty, query-visible completed projection. Nothing was declared complete.`);
  }
  return Object.freeze(receipt);
}

/** Validate and sanitize the one allowed 409 response without exposing its owner. */
export function validateAcceleratedBootstrapBusyReceipt(body) {
  const label = "the accelerated bootstrap busy receipt";
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    die(`${label} was invalid. Nothing was declared complete.`);
  }
  exactAggregateReceiptFields(body, BOOTSTRAP_BUSY_FIELDS, label);
  if (body.protocol !== "bootstrap-v2" || body.busy !== true) {
    die(`${label} did not identify a supported retry. Nothing was declared complete.`);
  }
  const remaining = nonNegativeReceiptCount(body, "remaining", label);
  const retryAfterSeconds = nonNegativeReceiptCount(body, "retry_after_seconds", label);
  if (retryAfterSeconds < 1 || retryAfterSeconds > 1_200) {
    die(`${label} included an unsafe retry delay. Nothing was declared complete.`);
  }
  return Object.freeze({ remaining, retryAfterSeconds });
}

/**
 * Prove that a resumed bootstrap only advances one durable epoch.
 *
 * Queue and in-flight counts can move between disjoint phases, so confirmed
 * and remaining are the cumulative authority. Once legacy cleanup has ended it
 * can never reappear, and a response calling itself "building" must change at
 * least one aggregate progress signal instead of creating a hot no-op loop.
 */
export function validateAcceleratedBootstrapProgress(previous, current) {
  if (!previous) return current;
  if (current.epoch !== previous.epoch || current.total !== previous.total) {
    die("the accelerated bootstrap changed its durable epoch or total during one update. Re-run `brain update <manifest>`; the Worker remains paused.");
  }
  if (current.confirmed < previous.confirmed || current.remaining > previous.remaining) {
    die("the accelerated bootstrap cumulative progress moved backward. Re-run `brain update <manifest>`; the Worker remains paused.");
  }
  if (previous.phase !== "legacy_drain" && current.phase === "legacy_drain") {
    die("the accelerated bootstrap returned to legacy cleanup after bulk work began. Re-run `brain update <manifest>`; the Worker remains paused.");
  }
  if (current.phase === "building") {
    const changed = [
      "confirmed",
      "remaining",
      "queued",
      "submitted",
      "in_flight_batches",
      "actual_vectors",
    ].some((field) => current[field] !== previous[field]);
    if (!changed) {
      die("the accelerated bootstrap claimed to build without aggregate progress. Re-run `brain update <manifest>`; the Worker remains paused.");
    }
  }
  return current;
}

/** Keep active deployment unreachable unless the loop returned its own exact proof. */
export function validateAcceleratedBootstrapCompletion(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    die("the accelerated bootstrap did not return its exact completion proof. Re-run `brain update <manifest>`; the Worker remains paused.");
  }
  exactAggregateReceiptFields(result, BOOTSTRAP_COMPLETION_FIELDS,
    "the accelerated bootstrap completion proof");
  if (result.complete !== true || result.vector_ready !== true ||
      !Number.isSafeInteger(result.epoch) || result.epoch < 0 ||
      !Number.isSafeInteger(result.total) || result.total < 0 ||
      !Number.isSafeInteger(result.confirmed) || result.confirmed !== result.total ||
      result.remaining !== 0 || !Number.isSafeInteger(result.rounds) || result.rounds < 1) {
    die("the accelerated bootstrap did not return its exact completion proof. Re-run `brain update <manifest>`; the Worker remains paused.");
  }
  return result;
}

/**
 * Drive the authenticated paused bootstrap to one exact completion receipt.
 * Each request is idempotent and durable, so network retries and a later update
 * run resume progress instead of resetting it. The caller supplies pin checks
 * around every HTTP attempt so a long run cannot outlive its reviewed manifest.
 */
export async function runAcceleratedBootstrap({
  request,
  beforeRequest = async () => {},
  afterRequest = async () => {},
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  maxDurationMs = ACCELERATED_BOOTSTRAP_MAX_MS,
  maxRounds = ACCELERATED_BOOTSTRAP_MAX_ROUNDS,
  onProgress = () => {},
} = {}) {
  if (typeof request !== "function" || typeof beforeRequest !== "function" ||
      typeof afterRequest !== "function" || typeof now !== "function" ||
      typeof sleep !== "function" || typeof onProgress !== "function") {
    throw new TypeError("the accelerated bootstrap runner dependencies are invalid");
  }
  const duration = Number.isSafeInteger(maxDurationMs)
    ? Math.min(ACCELERATED_BOOTSTRAP_MAX_MS, Math.max(1_000, maxDurationMs))
    : ACCELERATED_BOOTSTRAP_MAX_MS;
  const roundLimit = Number.isSafeInteger(maxRounds)
    ? Math.min(ACCELERATED_BOOTSTRAP_MAX_ROUNDS, Math.max(1, maxRounds))
    : ACCELERATED_BOOTSTRAP_MAX_ROUNDS;
  const startedAt = Number(now());
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new TypeError("the accelerated bootstrap clock is invalid");
  }
  const deadline = startedAt + duration;
  let previous = null;
  let lastRemaining = null;
  let rounds = 0;

  for (let round = 1; round <= roundLimit; round++) {
    const roundNow = Number(now());
    if (!Number.isFinite(roundNow) || roundNow < startedAt || roundNow >= deadline) break;
    rounds = round;
    const response = await retryTransient(async (attempt) => {
      const attemptNow = Number(now());
      if (!Number.isFinite(attemptNow) || attemptNow < startedAt || attemptNow >= deadline) {
        const error = new Error("the accelerated bootstrap safety deadline was reached");
        error.retryable = false;
        throw error;
      }
      await beforeRequest({ round, attempt });
      let primaryError = null;
      try {
        const result = await request({
          round,
          attempt,
          timeoutMs: Math.max(1_000, Math.min(
            ACCELERATED_BOOTSTRAP_REQUEST_MAX_MS,
            deadline - attemptNow,
          )),
        });
        if (!result || typeof result.status !== "number" ||
            typeof result.ok !== "boolean" || typeof result.text !== "function") {
          throw new Error("the accelerated bootstrap returned an invalid HTTP response");
        }
        let raw;
        try {
          raw = await result.text();
        } catch {
          const error = new Error("the accelerated bootstrap response was interrupted before its durable receipt arrived");
          error.retryable = true;
          throw error;
        }
        if (result.status !== 409 && isRetryableHttpStatus(result.status)) {
          const error = new Error("the accelerated bootstrap received a retryable HTTP response");
          error.retryable = true;
          throw error;
        }
        let body = null;
        try { body = JSON.parse(raw); } catch { /* validated below without echoing bytes */ }
        return { status: result.status, ok: result.ok, body };
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try {
          await afterRequest({ round, attempt });
        } catch (pinError) {
          // A post-attempt pin failure is authoritative after a received
          // receipt. If the transport itself failed, preserve that retryable
          // error; the next preflight repeats the pin check before any POST.
          if (!primaryError) throw pinError;
        }
      }
    }, {
      shouldRetry: (error) => error?.retryable === true,
      sleep,
      onRetry: () => info("the accelerated bootstrap request was interrupted; retrying durable progress"),
    });

    if (response.status === 409) {
      const busy = validateAcceleratedBootstrapBusyReceipt(response.body);
      if (lastRemaining !== null && busy.remaining > lastRemaining) {
        die("the accelerated bootstrap busy receipt moved progress backward. Re-run `brain update <manifest>`; the Worker remains paused.");
      }
      lastRemaining = busy.remaining;
      const remainingMs = Math.max(0, deadline - Number(now()));
      const delayMs = Math.min(
        busy.retryAfterSeconds * 1_000,
        remainingMs,
      );
      if (delayMs <= 0) break;
      info(`accelerated bootstrap is held by another bounded request; ${busy.remaining} aggregate row(s) remain`);
      await sleep(delayMs);
      continue;
    }
    if (!response.ok) {
      die(`accelerated bootstrap failed with HTTP ${response.status}. No response content was printed. Re-run \`brain update <manifest>\`; the Worker remains paused.`);
    }
    const receipt = validateAcceleratedBootstrapReceipt(response.body);
    validateAcceleratedBootstrapProgress(previous, receipt);
    if (lastRemaining !== null && receipt.remaining > lastRemaining) {
      die("the accelerated bootstrap remaining count increased. Re-run `brain update <manifest>`; the Worker remains paused.");
    }
    if (receipt.failed > 0) {
      die(`the accelerated bootstrap reported ${receipt.failed} failed aggregate operation(s). Re-run \`brain update <manifest>\`; the Worker remains paused.`);
    }
    previous = receipt;
    lastRemaining = receipt.remaining;
    onProgress(receipt);
    info(`${receipt.confirmed}/${receipt.total} legacy vector(s) confirmed; ${receipt.remaining} remain`);
    if (receipt.complete) {
      return validateAcceleratedBootstrapCompletion(Object.freeze({
        epoch: receipt.epoch,
        total: receipt.total,
        confirmed: receipt.confirmed,
        remaining: receipt.remaining,
        rounds,
        complete: true,
        vector_ready: true,
      }));
    }
    if (receipt.phase === "waiting" || receipt.phase === "legacy_drain") {
      const delayMs = Math.min(
        ACCELERATED_BOOTSTRAP_POLL_MS,
        Math.max(0, deadline - Number(now())),
      );
      if (delayMs <= 0) break;
      await sleep(delayMs);
    }
  }

  const boundary = Number(now()) >= deadline
    ? `${Math.ceil(duration / 3_600_000)}-hour wall-clock safety limit`
    : `${roundLimit}-round safety limit`;
  die(
    `the accelerated bootstrap reached its ${boundary} with ${lastRemaining ?? "an unknown number of"} aggregate row(s) remaining.\n` +
      "      Completed batches are durable. Re-run `brain update <manifest>` to resume; the Worker remains paused.",
  );
}

/** Run the aggregate-only bootstrap endpoint through the manifest's durable admin key. */
export async function cmdAcceleratedBootstrap(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const resolveBootstrapAccount = options.resolveAccount ?? resolveAccount;
  const resolveBootstrapBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const resolveBootstrapKey = options.resolveAdminKey ?? ((path) =>
    resolveAdminKey(path, { ignoreEnvironment: true }));
  const callHttp = options.http ?? http;
  const acct = m.brain?.domain ? null : await resolveBootstrapAccount(m);
  const base = options.baseUrl ?? await resolveBootstrapBase(m, acct);
  const adminKey = options.adminKey ?? resolveBootstrapKey(manifestPath);
  if (!adminKey) {
    die("no durable admin key was found, so the paused bootstrap could not be authenticated. Repair the declared key store, then re-run `brain update <manifest>`.");
  }
  return runAcceleratedBootstrap({
    ...options,
    request: ({ timeoutMs }) => callHttp(`${base}/api/admin/brain/bootstrap`, {
      method: "POST",
      redirect: "error",
      headers: { "X-Admin-Key": adminKey },
    }, {
      timeoutMs,
      what: "the accelerated legacy vector bootstrap",
    }),
  });
}

export async function cmdUpgrade(manifestPath, options = {}) {
  const resolveUpgradeAccount = options.resolveAccount ?? resolveAccount;
  const queryDatabase = options.d1Query ?? d1Query;
  const callCloudflare = options.cf ?? cf;
  const migrate = options.cmdMigrate ?? cmdMigrate;
  const deploy = options.cmdDeploy ?? cmdDeploy;
  const bootstrapProjection = options.cmdBootstrap ?? cmdAcceleratedBootstrap;
  const reconcileProviders = options.reconcileWorkerProviderSecrets ?? reconcileWorkerProviderSecrets;
  const drainProjection = options.cmdDrain ?? cmdDrain;
  const verifyHealth = options.cmdHealth ?? cmdHealth;
  const verifyAcceptance = options.cmdTest ?? cmdTest;
  const commitVersion = options.commitManifestVersion ?? commitManifestVersion;
  const waitForVectorDrainQuiescence = options.waitForVectorDrainQuiescence ??
    ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let originalPin = pinUpdateManifest(manifestPath);
  const executionPin = writePinnedExecutionManifest(originalPin);
  try {
    const initialManifest = executionPin.manifest;
    const identity = cloudflareIdentity(initialManifest);
    let acct = await resolveUpgradeAccount(initialManifest);
    if (!acct?.id) die("update stopped because the Cloudflare account identity could not be resolved. Nothing was changed.");
    if (identity.declaredAccountId && identity.declaredAccountId !== acct.id) {
      die("update stopped because the token account does not match the pinned manifest. Nothing was changed.");
    }
    revalidateUpdateManifest(originalPin, "account preflight");
    revalidateUpdateManifest(executionPin, "account preflight");

    const accountId = acct.id;
    const dbId = identity.databaseId;
    const assertStageContext = async (stage) => {
      const original = revalidateUpdateManifest(originalPin, stage);
      const execution = revalidateUpdateManifest(executionPin, stage);
      const currentIdentity = cloudflareIdentity(original.manifest);
      const executionIdentity = cloudflareIdentity(execution.manifest);
      if (currentIdentity.databaseId !== dbId || executionIdentity.databaseId !== dbId) {
        throw new Error(`the D1 database identity changed during ${stage}`);
      }
      const currentAccount = await resolveUpgradeAccount(execution.manifest);
      if (!currentAccount?.id || currentAccount.id !== accountId) {
        throw new Error(`the Cloudflare account identity changed during ${stage}`);
      }
      revalidateUpdateManifest(originalPin, stage);
      revalidateUpdateManifest(executionPin, stage);
      acct = currentAccount;
      return { manifest: execution.manifest, account: currentAccount };
    };
    const assertStageFiles = (stage) => {
      revalidateUpdateManifest(originalPin, stage);
      revalidateUpdateManifest(executionPin, stage);
    };

    await assertStageContext("install-state preflight");
    let tableResponse;
    try {
      tableResponse = await queryDatabase(
        accountId,
        dbId,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'install_state'",
      );
    } catch {
      die("update stopped because D1 install state could not be read. Nothing was changed.");
    }
    assertStageFiles("install-state preflight");
    if (!tableResponse || !Array.isArray(tableResponse.results) ||
        tableResponse.results.some((row) => row?.name !== "install_state")) {
      die("update stopped because D1 install state was unreadable or ambiguous. Nothing was changed.");
    }
    let before = null;
    if (tableResponse.results.length > 0) {
      let stateResponse;
      try {
        stateResponse = await queryDatabase(accountId, dbId, "SELECT * FROM install_state WHERE id = 1");
      } catch {
        die("update stopped because D1 install state could not be read. Nothing was changed.");
      }
      assertStageFiles("install-state preflight");
      try {
        before = installStateRow(stateResponse);
      } catch {
        die("update stopped because D1 install state was unreadable or ambiguous. Nothing was changed.");
      }
    }
    if (before && initialManifest.client?.slug && before.client_slug && before.client_slug !== initialManifest.client.slug) {
      die("update stopped because this D1 database belongs to a different brain. Nothing was changed.");
    }

    // The version being upgraded TO is the code in the client's hands right now.
    const toVersion = PRODUCT_VERSION;
    const usesD1VectorOutbox =
      (initialManifest.infrastructure?.cloudflare?.storage || "d1") === "d1";
    const stateVersion = before ? before.product_version : null;
    const manifestVersion = initialManifest.brain?.version || null;
    if (before && (typeof stateVersion !== "string" || !stateVersion)) {
      die("update stopped because D1 install state has no valid product version. Nothing was changed.");
    }
    if (manifestVersion !== null && typeof manifestVersion !== "string") {
      die("update stopped because the manifest product version is invalid. Nothing was changed.");
    }
    const recordedVersions = [...new Set([stateVersion, manifestVersion].filter(Boolean))];
    let newestRecordedVersion = null;
    try {
      parseSemver(toVersion);
      for (const recordedVersion of recordedVersions) {
        parseSemver(recordedVersion);
        if (!newestRecordedVersion || compareSemver(recordedVersion, newestRecordedVersion) > 0) {
          newestRecordedVersion = recordedVersion;
        }
        const direction = compareSemver(recordedVersion, toVersion);
        if (direction > 0) {
          die(
            `update refused to downgrade this brain from ${recordedVersion} to ${toVersion}. Nothing was changed.\n` +
              "      Install that version or a newer release, then run brain update again.",
          );
        }
      }
    } catch (error) {
      if (error instanceof Fatal) throw error;
      die("update stopped because the recorded product version is not valid semantic version data. Nothing was changed.");
    }
    const fromVersion = stateVersion || newestRecordedVersion || "legacy-unrecorded";
    if (!before) info("legacy install_state is absent; migrations will create it after the safety snapshot");

    // Snapshot first. A bookmark taken after a migration is worthless.
    await assertStageContext("D1 bookmark capture");
    let bookmark = null;
    try {
      const bm = await callCloudflare(`/accounts/${accountId}/d1/database/${dbId}/time_travel/bookmark`);
      bookmark = bm?.bookmark;
      if (!validD1Bookmark(bookmark)) throw new Error("Cloudflare returned no valid bookmark");
      assertStageFiles("D1 bookmark capture");
      ok("required D1 restore bookmark captured");
    } catch {
      die("update stopped because a required D1 restore bookmark could not be captured. Nothing was changed.");
    }

    const startedAt = new Date().toISOString();
    const logRun = async (status, detail, { required = false } = {}) => {
      try {
        await queryDatabase(
          accountId,
          dbId,
          `INSERT INTO upgrade_runs (started_at, finished_at, from_version, to_version, status, d1_bookmark, detail)
           VALUES (?,?,?,?,?,?,?)`,
          [startedAt, new Date().toISOString(), fromVersion, toVersion, status, bookmark, detail || null],
        );
        return true;
      } catch (error) {
        if (required) throw new Error("the verified update could not be recorded in upgrade history", { cause: error });
        return false;
      }
    };

    info(`upgrading ${fromVersion} -> ${toVersion}`);
    let stage = "migration";
    // True between the paused deployment and the active one. If the run dies in
    // that window the install stays paused, which is correct (a partially
    // migrated corpus must not meet live writers) but invisible: seven write
    // paths including ingest return 503 and nothing says so. One field install
    // sat like that for eight days and silently accepted no documents.
    let corpusPausedByThisRun = false;
    const runStage = async (name, action) => {
      stage = name;
      const context = await assertStageContext(name);
      const result = await action(context);
      assertStageFiles(name);
      return result;
    };

    try {
      // The execution manifest is fingerprint-pinned across every remote
      // stage. Legacy manifests have no domain, and a normal deploy persists
      // the workers.dev hostname. Suppress that one local write during update:
      // health can resolve the hostname read-only, while the pinned artifact
      // must remain byte-identical until the verified version commit.
      //
      // Deploy the lease-aware code PAUSED before changing the schema. An old
      // Worker ignores the new lease columns, so migration-first would create a
      // rolling window where it can still write Vectorize concurrently. Exact
      // paused-mode health proves the compatibility build has taken over; a
      // full invocation grace then lets every already-started old drain finish.
      if (usesD1VectorOutbox) {
        await runStage("paused vector-drain deployment", () => deploy(executionPin.target, {
          persistDomain: false,
          pauseVectorDrainForUpgrade: true,
        }));
        corpusPausedByThisRun = true;
        await runStage("paused vector-drain health verification", () =>
          verifyHealth(executionPin.target, {
            expectVersion: toVersion,
            expectDrainMode: "paused-for-upgrade",
            reachOnly: true,
          }));
        await runStage("vector-drain quiescence", () =>
          waitForVectorDrainCutover(waitForVectorDrainQuiescence));
        await runStage("migration", () => migrate(executionPin.target, {
          vectorDrainQuiesced: true,
        }));
        // Schema 0013 turns the legacy one-page-at-a-time bootstrap into an
        // authenticated aggregate-only bulk protocol. Keep the Worker paused
        // until its exact completion receipt proves every durable page. A
        // timeout or malformed receipt therefore cannot expose a partially
        // migrated corpus to active writers, and rerunning update resumes the
        // same epoch.
        await runStage("accelerated legacy vector bootstrap", async () => {
          const completion = await bootstrapProjection(executionPin.target, {
            beforeRequest: ({ round, attempt }) => assertStageFiles(
              `accelerated legacy vector bootstrap request ${round}.${attempt} preflight`,
            ),
            afterRequest: ({ round, attempt }) => assertStageFiles(
              `accelerated legacy vector bootstrap request ${round}.${attempt} receipt`,
            ),
          });
          return validateAcceleratedBootstrapCompletion(completion);
        });
        await runStage("active vector-drain deployment", () => deploy(executionPin.target, {
          persistDomain: false,
          pauseVectorDrainForUpgrade: false,
        }));
        corpusPausedByThisRun = false;
        // Cloudflare can keep routing this client to the paused compatibility
        // deployment for a few seconds after the active upload succeeds. Prove
        // the exact active mode is serving before the first corpus mutation;
        // otherwise convergence can fail on the old Worker's intentional 503.
        await runStage("active vector-drain health verification", () =>
          verifyHealth(executionPin.target, {
            expectVersion: toVersion,
            expectDrainMode: "active",
            reachOnly: true,
          }));
      } else {
        await runStage("migration", () => migrate(executionPin.target));
        await runStage("deployment", () => deploy(executionPin.target, { persistDomain: false }));
      }
      await runStage("provider-secret reconciliation", ({ manifest, account }) => {
        const scriptName = manifest.brain?.worker_name || `${manifest.client?.slug || "client"}-brain`;
        return reconcileProviders(manifest, account, scriptName, optionalWorkerSecretNames(manifest));
      });
      if (usesD1VectorOutbox) {
        // The paused bulk bootstrap proves the legacy projection first. The
        // ordinary active leased drain remains mandatory because it closes any
        // steady-state outbox work that arrived before the paused boundary and
        // independently verifies normal post-upgrade operation.
        await runStage("vector projection convergence", () =>
          drainProjection(executionPin.target));
      }
      await runStage("exact-version health verification", () =>
        verifyHealth(executionPin.target, {
          expectVersion: toVersion,
          expectDrainMode: usesD1VectorOutbox ? "active" : null,
        }));
      await runStage("full acceptance test", () =>
        verifyAcceptance(executionPin.target, { expectVersion: toVersion }));
      await runStage("D1 version commit", () => queryDatabase(
        accountId,
        dbId,
        "UPDATE install_state SET last_upgraded_at = ?, product_version = ? WHERE id = 1",
        [new Date().toISOString(), toVersion],
      ));
      const committed = await runStage("D1 version readback", () => queryDatabase(
        accountId,
        dbId,
        "SELECT product_version FROM install_state WHERE id = 1",
      ));
      if (committed?.results?.[0]?.product_version !== toVersion) {
        throw new Error("D1 did not read back the package version that was written");
      }

      stage = "local manifest version commit";
      await assertStageContext(stage);
      const expectedManifest = JSON.parse(originalPin.raw);
      expectedManifest.brain = { ...(expectedManifest.brain || {}), version: toVersion };
      commitVersion(originalPin.target, toVersion);
      const advancedPin = pinUpdateManifest(originalPin.target);
      if (JSON.stringify(advancedPin.manifest) !== JSON.stringify(expectedManifest)) {
        throw new Error("the local manifest changed beyond its verified version field");
      }
      const advancedIdentity = cloudflareIdentity(advancedPin.manifest);
      if (advancedIdentity.databaseId !== dbId) {
        throw new Error("the local manifest database identity changed during version commit");
      }
      originalPin = advancedPin;
      await assertStageContext(stage);

      await runStage("verified history commit", () => logRun("verified", null, { required: true }));
    } catch (error) {
      await logRun("failed", `stage:${stage}`);
      die(
        `update stopped during ${stage}: ${error.message}\n` +
          `      D1 recovery bookmark: ${bookmark}\n` +
          "      Do not restore it as the first response. A D1 restore discards newer writes and\n" +
          "      does not restore Vectorize. A restore requires reviewed clean-index recreation/rebind\n" +
          "      before reindex because provider-only excess vectors cannot be enumerated from D1.\n" +
          "      Safe default: fix the reported issue and run brain update again." +
          (corpusPausedByThisRun
            ? "\n\n" +
              "      THIS BRAIN CANNOT ACCEPT DOCUMENTS RIGHT NOW.\n" +
              "      The update paused its corpus writes before changing the schema and did not\n" +
              "      reach the step that resumes them. Ingest, forget and reindex return 503 until\n" +
              "      it does. Anything added meanwhile is refused, not queued, so do not drop files\n" +
              "      in and assume they landed.\n" +
              "      This pause is deliberate: resuming writes over a half-migrated schema is worse\n" +
              "      than staying paused. Do not clear VECTOR_DRAIN_MODE by hand.\n" +
              "      Confirm the state any time with `brain health <manifest>`; it reports\n" +
              "      accepting_documents false while this lasts."
            : ""),
      );
    }
    ok(`upgrade verified, now at ${toVersion}`);
  } finally {
    removePinnedExecutionManifest(executionPin);
  }
}

function rollbackLocalPreflight(manifestPath, bookmarkArg) {
  const bookmark = bookmarkArg;
  if (!bookmark) die("usage: brain rollback <manifest> <bookmark> [--yes]");
  if (!validD1Bookmark(bookmark)) die("the D1 bookmark is invalid; nothing was changed.");
  const pin = pinUpdateManifest(manifestPath);
  const m = pin.manifest;
  const { databaseId, declaredAccountId } = cloudflareIdentity(m);
  return { bookmark, pin, m, databaseId, declaredAccountId };
}

function printRollbackPreview({ bookmark, databaseId }) {
  warn("rollback preview only: nothing was changed.");
  warn("a D1 restore is DESTRUCTIVE: everything written after this bookmark would be lost.");
  warn("this restores D1 only. It does not restore Vectorize; provider-only excess vectors can require supervised index recreation before reindex.");
  info(`database ${databaseId}, bookmark ${bookmark}`);
  info("After reviewing this recovery, re-run the same command with --yes to perform it.");
  return { confirmed: false, restored: false, databaseId, bookmark };
}

export async function cmdRollback(manifestPath, bookmarkArg, options = {}) {
  const preflight = rollbackLocalPreflight(manifestPath, bookmarkArg);
  if (options.confirmed !== true) return printRollbackPreview(preflight);

  const { bookmark, pin, m, databaseId: dbId, declaredAccountId } = preflight;
  const resolveRollbackAccount = options.resolveAccount ?? resolveAccount;
  const callCloudflare = options.cf ?? cf;
  const queryDatabase = options.d1Query ?? d1Query;
  const deployRollbackWorker = options.cmdDeploy ?? cmdDeploy;
  const verifyRollbackHealth = options.cmdHealth ?? cmdHealth;
  const waitForVectorDrainQuiescence = options.waitForVectorDrainQuiescence ??
    ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const acct = await resolveRollbackAccount(m);
  if (!acct?.id || (declaredAccountId && declaredAccountId !== acct.id)) {
    die("rollback stopped because the token account does not match the pinned manifest.");
  }
  revalidateUpdateManifest(pin, "rollback preflight");

  warn("restoring this D1 bookmark is DESTRUCTIVE: everything written since is lost.");
  warn("this restores D1 only. Vectorize must be rebuilt before semantic retrieval is trustworthy.");
  info(`database ${dbId}, bookmark ${bookmark}`);
  const usesD1VectorOutbox = (m.infrastructure?.cloudflare?.storage || "d1") === "d1";
  if (usesD1VectorOutbox) {
    // Time travel restores the lease and mutation-fence rows too. Quiesce every
    // old writer before restoring them, or an already-started mutation can land
    // after the restore with no surviving receipt. Keep the Worker paused until
    // the restored corpus has been durably marked for a new bootstrap epoch.
    await deployRollbackWorker(pin.target, {
      persistDomain: false,
      pauseVectorDrainForUpgrade: true,
    });
    revalidateUpdateManifest(pin, "rollback paused vector-drain deployment");
    await verifyRollbackHealth(pin.target, {
      expectVersion: PRODUCT_VERSION,
      expectDrainMode: "paused-for-upgrade",
      reachOnly: true,
    });
    revalidateUpdateManifest(pin, "rollback paused vector-drain health verification");
    await waitForVectorDrainCutover(waitForVectorDrainQuiescence, {
      nextStep: "the D1 restore",
    });
    revalidateUpdateManifest(pin, "rollback vector-drain quiescence");
  }
  await callCloudflare(`/accounts/${acct.id}/d1/database/${dbId}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`, {
    method: "POST",
  });
  revalidateUpdateManifest(pin, "rollback restore");
  ok("D1 restored");
  if (usesD1VectorOutbox) {
    try {
      const schemaReceipt = await queryDatabase(
        acct.id,
        dbId,
        "SELECT schema_version FROM install_state WHERE id = 1",
      );
      if (!schemaReceipt || !Array.isArray(schemaReceipt.results) ||
          schemaReceipt.results.length !== 1 ||
          !Number.isSafeInteger(Number(schemaReceipt.results[0]?.schema_version))) {
        throw new Error("restored schema version did not read back");
      }
      const restoredSchemaVersion = Number(schemaReceipt.results[0].schema_version);
      if (restoredSchemaVersion < 12) {
        throw new Error("restored schema predates the supervised vector protocol");
      }
      const hasBulkBootstrap = restoredSchemaVersion >= 13;
      await queryDatabase(
        acct.id,
        dbId,
        `UPDATE install_state
            SET vector_drain_lease_owner = NULL,
                vector_drain_lease_expires_at = NULL,
                vector_projection_status = CASE
                  WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
                vector_projection_bootstrap_epoch = vector_projection_bootstrap_epoch + 1,
                vector_projection_bootstrap_cursor = NULL,
                vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks),
                vector_projection_mutation_id = NULL,
                vector_projection_submitted_at = NULL${hasBulkBootstrap ? `,
                vector_projection_bootstrap_protocol = NULL,
                vector_projection_bootstrap_base_count = 0` : ""}
          WHERE id = 1 AND schema_version >= 12`,
      );
      if (hasBulkBootstrap) {
        // Batch receipts describe one particular provider index and mutation
        // history. A D1 restore cannot make those external receipts true for
        // the clean replacement index, so recovery always restarts them empty.
        await queryDatabase(acct.id, dbId, "DELETE FROM vector_bootstrap_batches");
      }
      await queryDatabase(
        acct.id,
        dbId,
        `UPDATE vector_outbox
            SET submitted_mutation_id = NULL, submitted_at = NULL${hasBulkBootstrap ? `,
                bootstrap_epoch = NULL, bootstrap_batch = NULL` : ""}
          WHERE submitted_mutation_id IS NOT NULL OR submitted_at IS NOT NULL${hasBulkBootstrap ? `
             OR bootstrap_epoch IS NOT NULL OR bootstrap_batch IS NOT NULL` : ""}`,
      );
      const receipt = await queryDatabase(
        acct.id,
        dbId,
        `SELECT vector_projection_status AS status,
                vector_drain_lease_owner AS lease_owner,
                vector_drain_lease_expires_at AS lease_expires_at,
                vector_projection_mutation_id AS mutation_id,
                vector_projection_submitted_at AS mutation_submitted_at,
                vector_projection_bootstrap_cursor AS cursor,
                vector_projection_bootstrap_high_water AS high_water,
                (SELECT MAX(chunk_uid) FROM chunks) AS chunk_high_water,
                (SELECT COUNT(*) FROM vector_outbox
                  WHERE submitted_mutation_id IS NOT NULL OR submitted_at IS NOT NULL) AS submitted_rows${hasBulkBootstrap ? `,
                vector_projection_bootstrap_protocol AS bootstrap_protocol,
                vector_projection_bootstrap_base_count AS bootstrap_base_count,
                (SELECT COUNT(*) FROM vector_bootstrap_batches) AS bootstrap_batch_count,
                (SELECT COUNT(*) FROM vector_outbox
                  WHERE bootstrap_epoch IS NOT NULL OR bootstrap_batch IS NOT NULL) AS tagged_rows` : ""}
           FROM install_state WHERE id = 1`,
      );
      if (!receipt || !Array.isArray(receipt.results) || receipt.results.length !== 1 ||
          !["bootstrap_required", "verified"].includes(receipt.results[0]?.status) ||
          receipt.results[0]?.lease_owner !== null ||
          receipt.results[0]?.lease_expires_at !== null ||
          receipt.results[0]?.mutation_id !== null ||
          receipt.results[0]?.mutation_submitted_at !== null ||
          receipt.results[0]?.cursor !== null ||
          Number(receipt.results[0]?.submitted_rows) !== 0 ||
          receipt.results[0]?.high_water !== receipt.results[0]?.chunk_high_water ||
          (hasBulkBootstrap && (
            receipt.results[0]?.bootstrap_protocol !== null ||
            Number(receipt.results[0]?.bootstrap_base_count) !== 0 ||
            Number(receipt.results[0]?.bootstrap_batch_count) !== 0 ||
            Number(receipt.results[0]?.tagged_rows) !== 0
          ))) {
        throw new Error("projection invalidation did not read back");
      }
    } catch {
      die(
        "D1 was restored, but the semantic projection could not be marked unverified.\n" +
          "      The compatibility Worker remains paused; do not return this brain to use.\n" +
          "      Run `brain update` to forward-migrate the restored schema. Then use supervised recovery\n" +
          "      to recreate/rebind a clean Vectorize index and every metadata index before reindex, drain, health, and test.",
      );
    }
    // D1 time travel cannot enumerate Vectorize ids written after the bookmark.
    // Reindex can upsert current chunks, but it cannot remove those provider-only
    // orphans. Keep the complete corpus-write barrier live until a supervised
    // recovery creates/rebinds a clean index and rebuilds exact readiness.
  }
  // A rolled-back run must never become the baseline for the next upgrade.
  const marked = await queryDatabase(
    acct.id,
    dbId,
    "UPDATE upgrade_runs SET status = 'rolled_back' WHERE id = (SELECT MAX(id) FROM upgrade_runs)",
  ).then(() => true, () => false);
  if (marked) {
    info("the most recent upgrade run is marked rolled_back so it cannot become the next baseline.");
  } else {
    warn("D1 was restored, but its upgrade-history marker could not be updated. Record this recovery manually.");
  }
  warn("the Worker remains paused. Recreate/rebind a clean Vectorize index with every metadata index under supervised recovery, then reindex, drain, health-check, and test before active use.");
  return {
    confirmed: true,
    restored: true,
    databaseId: dbId,
    bookmark,
    requiresVectorizeRecreation: usesD1VectorOutbox,
  };
}

/* ------------------------------------------------------------ acceptance */

/** A report is still a failed acceptance run even when its HTML was preserved. */
export function reportAcceptanceFailure(data = {}) {
  if (data?.acceptanceError) return { kind: "error", failed: Number(data?.acceptance?.counts?.fail || 0) };
  const failed = Number(data?.acceptance?.counts?.fail || 0);
  return failed > 0 ? { kind: "failed", failed } : null;
}

export async function cmdTest(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const key = resolveAdminKey(manifestPath);
  if (!key) die("no admin key found: not in the environment, and no .brain-admin-key file next to the manifest.");

  let base = m.brain?.domain ? `https://${m.brain.domain}` : null;
  let installState = null;

  // Cloudflare is OPTIONAL here, and that is the whole point.
  //
  // The acceptance suite is the artifact the client runs themselves after we
  // are gone, and the kickoff ends by revoking our token live and re-running
  // it to prove custody. Both are impossible if this command demands a
  // Cloudflare token: the moment the token dies, the proof dies with it.
  //
  // So with a domain in the manifest, tiers 1 through 4 run over plain HTTPS
  // with nothing but the admin key. Cloudflare buys exactly one thing, the
  // install_state row behind tier 5, and its absence degrades that tier to
  // skip rather than failing the run.
  const haveCfToken = cloudflareTokenAvailable();
  if (!base || (haveCfToken && m.infrastructure?.cloudflare?.d1_database_id)) {
    if (!base && !haveCfToken) {
      die(
        "no brain.domain in the manifest and no CLOUDFLARE_API_TOKEN to look one up.\n" +
          "      Add the domain to the manifest so this runs without Cloudflare access:\n" +
          '        "brain": { "domain": "brain.yourcompany.com" }'
      );
    }
    const acct = await resolveAccount(m);
    const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
    if (!base) {
      const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
      if (sub?.subdomain) base = `https://${scriptName}.${sub.subdomain}.workers.dev`;
    }
    const dbId = m.infrastructure?.cloudflare?.d1_database_id;
    if (dbId) {
      const st = await d1Query(acct.id, dbId, "SELECT * FROM install_state WHERE id = 1").catch(
        () => null
      );
      installState = st?.results?.[0] || null;
    }
  }
  if (!base) die("could not determine a URL for this install.");
  if (!haveCfToken) {
    info("no Cloudflare token present, so tier 5 will skip. Tiers 1 to 4 are unaffected.");
  }

  // --report writes the single self-contained HTML artifact instead of
  // printing to the terminal. This is the thing a client actually reads, and
  // the thing they can re-run and re-open after the engagement ends.
  const reportFlag = parseFlags(process.argv.slice(4)).report;
  if (reportFlag) {
    const out =
      typeof reportFlag === "string"
        ? reportFlag
        : `brain-report-${m.client?.slug || "install"}-${new Date().toISOString().slice(0, 10)}.html`;
    const { buildHtmlReport } = await import("./report-html.mjs");
    info(`building report against ${base}`);
    const { html, data } = await buildHtmlReport({
      base,
      adminKey: key,
      manifest: m,
      installState,
    });
    writeFileSync(out, html);
    const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
    ok(`report written to ${out} (${kb} kb, opens offline, no external assets)`);
    const acc = data?.acceptance;
    if (acc?.counts) {
      console.log(
        `  ${acc.counts.pass} passed, ${acc.counts.fail} failed, ${acc.counts.warn} warnings`
      );
    }
    const reportFailure = reportAcceptanceFailure(data);
    if (reportFailure?.kind === "error") {
      die("report was written, but the acceptance checks did not complete. The report records where they stopped.");
    }
    if (reportFailure) {
      die(
        `report was written, but acceptance FAILED with ${reportFailure.failed} ` +
          `${reportFailure.failed === 1 ? "check" : "checks"} failing.`
      );
    }
    return;
  }

  const { Acceptance, acceptanceVerdict } = await import("./acceptance.mjs");
  const suite = new Acceptance({
    base,
    adminKey: key,
    manifest: m,
    expectVersion: options.expectVersion || null,
  });
  info(`acceptance suite against ${base}`);
  const out = await suite.run({
    probes: m.testing?.probe_questions || [],
    installState,
  });

  let tier = null;
  for (const r of out.results) {
    if (r.tier !== tier) {
      tier = r.tier;
      console.log(`\n  ${c.bold("tier " + tier)}`);
    }
    const mark =
      r.status === "pass"
        ? c.green("pass")
        : r.status === "fail"
          ? c.red("FAIL")
          : r.status === "warn"
            ? c.yellow("warn")
            : c.dim("skip");
    console.log(`    ${mark}  ${r.name}${r.detail ? c.dim("  — " + r.detail) : ""}`);
  }

  const { pass, fail, warn: w, skip } = out.counts;
  console.log(`\n  ${pass} passed, ${fail} failed, ${w} warnings, ${skip} skipped`);
  if (out.stoppedAtTier) {
    console.log(`  ${c.red(`stopped after tier ${out.stoppedAtTier}: later tiers would be noise`)}`);
  }
  if (!out.passed) {
    throw new Fatal("acceptance suite FAILED");
  }
  // The headline is qualified when a whole capability went untested, because
  // "passed" unqualified is the sentence that reaches the client. Exit
  // semantics are untouched: untested is not failed.
  const verdict = acceptanceVerdict(out);
  for (const line of verdict.warnings) warn(line);
  ok(verdict.headline);
}

/* ----------------------------------------------------------- mcp-config */

/**
 * Print the config a client pastes into their own AI tools.
 *
 * This is an hour of work with the best return on the list. The moment a
 * client's own Claude answers a question from their own brain, in their own
 * terminal, is the highest perceived-value second in the whole engagement.
 * Before that it is a system they were shown; after it, it is a thing they own.
 *
 * The config contains only a URL, display name, executable path, and absolute
 * manifest locator. brain-mcp reads the current key from the same validated
 * durable storage as every installer command, so rotation never requires a
 * credential in terminal output, shell history, argv, or an MCP config file.
 */
export function mcpRegistrationDescriptor(manifest, manifestPath, {
  baseUrl,
  serverPath = join(HERE, "components", "brain-mcp.mjs"),
  nodePath = process.execPath,
} = {}) {
  const name = manifest?.client?.slug || "brain";
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new TypeError("a brain URL is required for MCP registration");
  const absoluteManifest = resolve(manifestPath);
  const absoluteServer = resolve(serverPath);
  const absoluteNode = resolve(nodePath);
  for (const [label, value] of [
    ["name", name],
    ["URL", base],
    ["manifest path", absoluteManifest],
    ["server path", absoluteServer],
    ["Node path", absoluteNode],
  ]) {
    if (typeof value !== "string" || !value || /[\0-\x1f\x7f]/.test(value)) {
      throw new TypeError(`the MCP ${label} contains an unsafe control character`);
    }
  }
  return Object.freeze({
    name,
    type: "stdio",
    // GUI-launched AI tools do not reliably inherit the terminal's PATH. The
    // exact interpreter running setup is a testable executable, not a guess.
    command: absoluteNode,
    args: Object.freeze([absoluteServer]),
    env: Object.freeze({
      BRAIN_URL: base,
      BRAIN_NAME: name,
      BRAIN_MANIFEST: absoluteManifest,
    }),
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export async function cmdMcpConfig(manifestPath) {
  const { m } = loadManifest(manifestPath);

  let base = m.brain?.domain ? `https://${m.brain.domain}` : null;
  if (!base) {
    const acct = await resolveAccount(m);
    const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
    const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
    if (sub?.subdomain) base = `https://${scriptName}.${sub.subdomain}.workers.dev`;
  }
  if (!base) die("could not determine a URL for this install.");

  try {
    const persistenceOptions = {
      platform: process.platform,
      username: process.env.USERNAME ?? process.env.USER,
      environment: process.env,
    };
    const plan = adminKeyPersistencePlan(manifestPath, m, persistenceOptions);
    if (!readAdminKeyDurably(plan, persistenceOptions)) throw new Error("missing durable key");
  } catch {
    die(
      "the durable ADMIN_KEY could not be read and verified, so a working MCP locator cannot be generated.\n" +
        "  Fix its declared local storage, then rerun `brain mcp-config <manifest>`."
    );
  }

  const descriptor = mcpRegistrationDescriptor(m, manifestPath, { baseUrl: base });
  const { name, command, args, env } = descriptor;
  const owner = m.client?.display_name || "the owner";

  const block = {
    mcpServers: {
      [name]: {
        command,
        args,
        env,
      },
    },
  };

  console.log(`\n${c.bold(`Connect ${owner}'s brain to your AI tools`)}\n`);
  console.log(`Your brain lives at ${c.bold(base)}\n`);

  console.log(`${c.bold("Claude Code")}: run this once, then it works in every folder:\n`);
  console.log(
    `  claude mcp add --scope user ${shellQuote(name)} \\\n` +
      Object.entries(env).map(([key, value]) => `    -e ${shellQuote(`${key}=${value}`)} \\\n`).join("") +
      `    -- ${shellQuote(command)} ${args.map(shellQuote).join(" ")}\n`
  );
  console.log(
    "  If this name already exists, run brain setup to reconcile it safely. Do not use\n" +
      "  a config-display command on an older entry because it may print the retired key.\n"
  );

  console.log(`${c.bold("Claude Desktop")}: add this to your config file:\n`);
  console.log(
    JSON.stringify(block, null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
  console.log(`\n  macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json`);
  console.log(`  Windows: %APPDATA%\\Claude\\claude_desktop_config.json`);
  console.log(`\n  Restart Claude Desktop after saving.\n`);

  // Codex. Verified against `codex mcp add --help` on 2026-08-17: the form is
  // `codex mcp add <NAME> --env K=V -- <COMMAND>...`, and the `--` separator is
  // REQUIRED or the launch command is parsed as codex's own flags.
  console.log(`${c.bold("Codex")}: run this once:\n`);
  console.log(
    `  codex mcp add ${shellQuote(name)} \\\n` +
      Object.entries(env).map(([key, value]) => `    --env ${shellQuote(`${key}=${value}`)} \\\n`).join("") +
      `    -- ${shellQuote(command)} ${args.map(shellQuote).join(" ")}\n`
  );
  console.log(`  Confirm with: codex mcp get ${shellQuote(name)}\n`);
  console.log(`  Or write it into ~/.codex/config.toml by hand:\n`);
  console.log(
    `  [mcp_servers.${name}]\n` +
      `  command = ${JSON.stringify(command)}\n` +
      `  args = [${args.map(JSON.stringify).join(", ")}]\n\n` +
      `  [mcp_servers.${name}.env]\n` +
      Object.entries(env).map(([key, value]) => `  ${key} = ${JSON.stringify(value)}\n`).join("")
  );

  console.log(
    `${c.bold("Claude app (phone + claude.ai) and ChatGPT")}: the brain is also a remote\n` +
      "  connector — no software on the device at all.\n\n" +
      `    Connector URL:  ${base}/mcp\n\n` +
      "  Claude: Settings -> Connectors -> Add custom connector -> paste the URL.\n" +
      "  ChatGPT: Settings -> Connectors (or Apps & Connectors) -> Create -> paste the URL.\n" +
      "  Either way the browser opens this brain's own approval page; the owner\n" +
      "  approves with their passkey. Connectors are read-only and die with\n" +
      "  Sign out everywhere.\n"
  );

  console.log(
    `${c.bold("After an admin-key rotation")}: replace any older manual MCP entry with this\n` +
      "  locator-only version and restart the AI tool. Setup refreshes Claude Code and\n" +
      "  Codex registrations automatically. Claude Desktop remains a manual config update.\n"
  );

  console.log(`${c.bold("Then try asking it")}:\n`);
  const probes = m.testing?.probe_questions || [];
  if (probes.length) {
    // Their own intake questions, not a generic demo. This is the difference
    // between "impressive technology" and "it knows my business".
    for (const q of probes.slice(0, 3)) console.log(`  "${q}"`);
  } else {
    console.log(`  "what did we decide about ..."`);
    console.log(`  "what is still outstanding from ..."`);
  }
  console.log("");

}

/* ----------------------------------------------------------- sources */

/**
 * Named ingest sources.
 *
 * A first import a client cannot roll back is one they will hesitate to
 * authorise at full size, which means the hesitation lands on the import that
 * would prove the most. Naming every ingest and giving it its own undo is what
 * removes that: a bad import becomes one command instead of hand-written SQL
 * against their only copy of their data.
 *
 * The name is the scope key, not a label. Documents from a source carry the
 * source name as their `source_type` in the store, so removal is one equality
 * match rather than a prefix or a LIKE. On the single operation that cannot be
 * undone, the matching rule should be the one with nothing subtle in it.
 */

// Mirrors the CHECK in migration 0003. Validated twice on purpose: the database
// is the guarantee, this is the one that produces a sentence instead of
// "CHECK constraint failed" when someone types a capital letter.
const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function assertSourceName(name) {
  if (!name || typeof name !== "string") die("a source name is required.");
  if (name.length > 64) die(`source name "${name}" is longer than 64 characters.`);
  if (!SOURCE_NAME_RE.test(name)) {
    die(
      `"${name}" is not a usable source name.\n` +
        "      Lowercase letters, digits, hyphen and underscore only, starting with a letter\n" +
        "      or digit. The name is used verbatim as the scope key for deletion, so a name\n" +
        "      carrying a quote or a wildcard could reach outside its own scope."
    );
  }
  return name;
}

/**
 * Flags that mean nothing without a value. Given bare, they used to parse to
 * boolean `true`, which is truthy, so the good error message was skipped and the
 * value flowed on: `--path` reached existsSync(true) and reported "no such
 * folder: true", and `--limit` silently ingested nothing at all.
 *
 * `--report` is deliberately absent: a bare --report means "use the generated
 * filename", which is intended.
 */
export const VALUE_FLAGS = new Set([
  "path", "source", "limit", "from", "manifest", "scopes", "port", "host", "user", "run", "confirm-host", "kind", "add", "bookmark", "export", "explain", "backup",
  "golden", "profile", "k", "repeat", "baseline", "save", "artifacts",
  "corpus-contract", "approve-removals", "only", "skip",
  // brain import bank. `--file` with no value must die saying so rather than
  // being read as a boolean and then reported as "needs --file".
  "file", "format", "account", "account-kind", "institution", "currency", "entity", "entity-label",
]);

/** Read an exact Drive-id exclusion list from either its portable shape or a migration receipt. */
export function driveExclusionIdsOf(raw) {
  const values = Array.isArray(raw)
    ? raw
    : raw?.exclude_file_ids ||
      raw?.excluded_drive_file_ids ||
      raw?.lanes?.drive?.migration_policy?.excluded_drive_file_ids ||
      [];
  if (!Array.isArray(values)) throw new Error("the Drive exclusion file does not contain an array of file ids");
  return [...new Set(values.map((x) => String(x || "").trim()).filter(Boolean))].sort();
}

/**
 * The connector policy is install-owned manifest data. A large migration can
 * use an ignored receipt file because thousands of opaque Drive ids do not
 * belong in a public product manifest; new installs normally need no such file.
 */
export function driveConnectorConfig(m, manifestPath, read = (path) => readFileSync(path, "utf-8")) {
  const declared = m?.corpora?.google_drive || {};
  let fileIds = driveExclusionIdsOf(declared.exclude_file_ids || []);
  if (declared.exclude_file_ids_file) {
    const filePath = resolve(dirname(resolve(manifestPath)), String(declared.exclude_file_ids_file));
    let parsed;
    try {
      parsed = JSON.parse(read(filePath));
    } catch (error) {
      throw new Error(`could not read Google Drive exclude_file_ids_file ${declared.exclude_file_ids_file}: ${error.message}`);
    }
    fileIds = [...new Set([...fileIds, ...driveExclusionIdsOf(parsed)])].sort();
  }
  return {
    excludeFileIds: fileIds,
    excludePaths: Array.isArray(declared.exclude_paths) ? declared.exclude_paths.map(String) : [],
    excludeNameParts: Array.isArray(declared.exclude_name_parts) ? declared.exclude_name_parts.map(String) : [],
    privatePrefixes: Array.isArray(m?.safety?.private_path_prefixes) ? m.safety.private_path_prefixes.map(String) : [],
  };
}

/** Stable identity for the policy that decides which Drive files may be indexed. */
export function credentialScannerFingerprint(enabled = true, gateVersion = CREDENTIAL_GATE_VERSION) {
  return createHash("sha256").update(JSON.stringify({ enabled: Boolean(enabled), gateVersion })).digest("hex");
}

/**
 * Resume receipts for a scanner-policy migration.
 *
 * The final scanner fingerprint is deliberately committed only after the
 * whole source sweep and its cleanup succeed. Without a separate in-progress
 * receipt, that safety rule makes an interrupted first sweep re-download every
 * document it already checked. Accepted revisions are safe to resume because
 * they are recorded only after the Worker receipt and family reconciliation.
 */
export function ensureCredentialScannerProgress(state, fingerprint) {
  if (!state || typeof state !== "object") throw new Error("credential scanner progress needs source state");
  const value = String(fingerprint || "");
  if (!value) throw new Error("credential scanner progress needs a fingerprint");
  const current = state.credential_scanner_progress;
  if (!current || current.fingerprint !== value || !current.accepted || typeof current.accepted !== "object") {
    state.credential_scanner_progress = { fingerprint: value, accepted: {} };
  }
  return state.credential_scanner_progress;
}

export function recordCredentialScannerProgress(state, fingerprint, stateKey, version) {
  const key = String(stateKey || "");
  if (!key) throw new Error("credential scanner progress needs a document key");
  const progress = ensureCredentialScannerProgress(state, fingerprint);
  progress.accepted[key] = version;
  return state;
}

export function hasCredentialScannerProgress(state, fingerprint, stateKey, version) {
  const progress = state?.credential_scanner_progress;
  const key = String(stateKey || "");
  return Boolean(
    key &&
    progress?.fingerprint === String(fingerprint || "") &&
    progress.accepted &&
    Object.prototype.hasOwnProperty.call(progress.accepted, key) &&
    progress.accepted[key] === version
  );
}

export function commitCredentialScannerProgress(state, fingerprint) {
  if (!state || typeof state !== "object") throw new Error("credential scanner commit needs source state");
  state.credential_scanner_fingerprint = String(fingerprint || "");
  delete state.credential_scanner_progress;
  return state;
}

export function drivePolicyFingerprint(config = {}, scannerEnabled = true, ocrEnabled = false) {
  const normalized = {};
  for (const key of ["excludeFileIds", "excludePaths", "excludeNameParts", "privatePrefixes"]) {
    normalized[key] = [...new Set((config[key] || []).map((value) => String(value)))].sort();
  }
  normalized.credentialScanner = credentialScannerFingerprint(scannerEnabled);
  // Turning OCR on changes what Drive is ALLOWED TO READ, so it belongs in the
  // source policy. Without it, a scanned PDF refused a month ago never
  // reappears: once a change token exists the incremental feed only returns
  // files that CHANGED, and a document sitting untouched in a folder has not.
  // A fingerprint mismatch forces one full comparison, which looks at every
  // file again exactly once.
  //
  // Deliberately NOT added to credentialScannerFingerprint, which looks
  // interchangeable and is not: that flag also arms a refusal when a
  // previously indexed file is missing, a refusal on --limit, and a re-send
  // and re-embed of the whole corpus. Wrong blast radius by a wide margin.
  normalized.ocr = ocrEnabled === true;
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}


/* ------------------------------------------------------------------- ocr */

/**
 * OCR settings from the manifest, with the safe answer as the default.
 *
 * OFF unless the manifest says otherwise. Turning OCR on changes ingest from a
 * free local operation into a metered one that bills the owner's own
 * Cloudflare account once per scanned page, and an upgrade must never quietly
 * start spending on someone's behalf.
 */
export function ocrPolicy(manifest = {}) {
  const cfg = manifest?.safety?.ocr || {};
  return {
    enabled: cfg.enabled === true,
    model: typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : "@cf/google/gemma-4-26b-a4b-it",
    maxPages: Number.isFinite(cfg.max_pages_per_document) && cfg.max_pages_per_document > 0
      ? Math.floor(cfg.max_pages_per_document)
      : 40,
  };
}

/**
 * The callback `extractPdf` calls once per page of a scanned document.
 *
 * It posts to the brain's OWN worker rather than to Cloudflare's REST API, so
 * every page passes the daily spend cap, lands in `llm_call_log` under the
 * label `ocr`, and runs on the client's own AI binding with the admin key the
 * installer already holds. No Cloudflare control-plane token is involved in
 * routine ingest.
 *
 * A cap hit, a provider refusal or a transport failure is marked `fatal` and
 * rethrown, because none of them says anything about the DOCUMENT. Recording
 * "unreadable" for a document that was never looked at writes a permanently
 * wrong reason into resume state, and the source cursor must stay retryable
 * instead.
 */
export function makeOcrCallback({ base, adminKey, model, maxPages, onPage = () => {} , httpImpl = http }) {
  const call = async (image, { page, totalPages } = {}) => {
    const { OCR_SYSTEM_PROMPT } = await ingestOcrLib();
    let res;
    try {
      res = await httpImpl(`${base}/api/admin/brain/ocr`, {
        method: "POST",
        headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: image.png_base64, page, prompt: OCR_SYSTEM_PROMPT }),
      }, { what: "the OCR request" });
    } catch (error) {
      const e = new Error(`OCR could not reach the brain: ${error.message}`);
      e.fatal = true;
      throw e;
    }

    let body = {};
    try { body = await res.json(); } catch { /* handled by status below */ }

    if (res.status === 429 || body?.llm_cap_exceeded) {
      const e = new Error(
        `OCR stopped because the daily spend cap was reached. ${body?.detail || ""}`.trim() +
        " No document was marked unreadable; re-run once the cap resets or raise safety.daily_llm_spend_cap_usd.",
      );
      e.fatal = true;
      e.llm_cap_exceeded = true;
      throw e;
    }
    if (body?.provider_mismatch || res.status === 409) {
      const e = new Error(`OCR refused: ${body?.detail || body?.error || "the brain would not run it"}`);
      e.fatal = true;
      throw e;
    }
    if (!res.ok) {
      // A 5xx from the model is about THIS page, not about the run, so it is a
      // page-level error the assembler can count and report inline.
      return { error: `page ${page}: ${String(body?.detail || body?.error || `HTTP ${res.status}`).slice(0, 160)}` };
    }
    onPage({ page, totalPages });
    return { text: body?.text ?? "" };
  };
  call.model = model;
  call.maxPages = maxPages;
  return call;
}

export const DRIVE_FULL_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Decide whether Drive's fast change feed is enough or a full truth sweep is due. */
export function driveSyncDecision({
  reset = false,
  syncToken = null,
  policyFingerprint = "",
  savedPolicyFingerprint = "",
  lastFullSweepAt = null,
  now = Date.now(),
  maxAgeMs = DRIVE_FULL_SWEEP_MAX_AGE_MS,
} = {}) {
  if (reset) return { incremental: false, reason: "reset requested" };
  if (!syncToken) return { incremental: false, reason: "no saved change token" };
  if (!policyFingerprint || policyFingerprint !== savedPolicyFingerprint) {
    return { incremental: false, reason: "Drive source policy changed" };
  }
  const last = Date.parse(String(lastFullSweepAt || ""));
  if (!Number.isFinite(last) || now - last >= maxAgeMs) {
    return { incremental: false, reason: "the periodic full Drive comparison is due" };
  }
  return { incremental: true, reason: "saved change token is current" };
}

/**
 * Reconciliation identity for one source file that became MANY documents.
 *
 * WHY THIS EXISTS AT ALL. Cleanup addresses a family by ONE uid: forgetFamilies
 * derives the delete scope from `base_doc_uid` alone, and `keep_doc_uids` are
 * the members of that scope this revision is protecting. That contract holds
 * only while the base really does name the family the stored rows belong to.
 *
 * THREE WAYS TO MAKE IT HOLD FOR A MESSAGE EXPORT, and why this one:
 *
 *   1. Rename the documents. Give each conversation session a source_id derived
 *      from the file path so the base is a literal prefix, the way splitOversized
 *      does. Rejected: source_id IS document identity. It is the citation, the
 *      idempotency key, and the same sessionEnvelope feeds the iMessage,
 *      WhatsApp-daemon, iPhone-backup and migration paths, which have no file
 *      path at all. Renaming would duplicate every already-ingested session on
 *      the next sync of every client who has already loaded one.
 *   2. Loosen the worker's guard so the current mismatched plan is accepted.
 *      Rejected, and measured: the delete scope keyed on the file path contains
 *      none of the `message:<id>` rows, so a permissive guard answers 200 and
 *      deletes nothing, orphaning stale sessions forever while reporting
 *      success. It also removes the one signal that says the model is wrong.
 *   3. Make the relationship TRUE instead of assumed. The producer writes the
 *      family uid into each document (`metadata.family_of`, ingest/run.mjs), the
 *      store's delete scope reads it, and the guard checks membership against
 *      that same declaration. Chosen: document identity is untouched, the
 *      guard gets stronger rather than weaker, and one declaration also repairs
 *      applyDriveRemovals, which had the identical wrong-key defect.
 *
 * The base is read back off the SANITIZED envelopes rather than recomputed,
 * so the plan can only ever name the exact string the documents carry.
 */
export function declaredFamilyUid(envelopes, { rel } = {}) {
  const declared = [...new Set((envelopes || []).map(
    (envelope) => String(envelope?.metadata?.family_of || "")
  ))];
  if (declared.length !== 1 || !declared[0]) {
    throw new Error(
      `${rel || "a multi-document file"} produced documents that do not agree on one family. ` +
      "A producer that turns one file into many documents must stamp every envelope with the same " +
      "metadata.family_of, or cleanup cannot address them as a unit. Nothing was sent."
    );
  }
  return declared[0];
}

export function completedDriveFamilyPlans(plans, acceptedCounts) {
  return (plans || []).filter((plan) => acceptedCounts.get(plan.stateKey) === plan.expectedParts);
}

/**
 * A streamed split document can cross a request boundary. It is settled only
 * after every part has been sent, and complete only when every part has an
 * accepted receipt. Callers may then save the version (and, for Drive, remove
 * obsolete family members) without retaining the extracted corpus in memory.
 */
export function remoteFamilyOutcomes(plans, sentCounts, acceptedCounts) {
  const settled = [...(plans || [])].filter(
    (plan) => Number(sentCounts.get(plan.stateKey) || 0) >= plan.expectedParts
  );
  return {
    completed: settled.filter(
      (plan) => Number(acceptedCounts.get(plan.stateKey) || 0) === plan.expectedParts
    ),
    incomplete: settled.filter(
      (plan) => Number(acceptedCounts.get(plan.stateKey) || 0) !== plan.expectedParts
    ),
  };
}

/**
 * Decide what may happen after every part of a remote logical document has a
 * receipt. Only a fully accepted replacement may remove obsolete family
 * members immediately. A permanent refusal becomes a later source-removal
 * candidate; a storage failure preserves the prior family and its retry.
 */
export function remoteFamilySettlement(outcome, rejectedFamilyParts = new Map()) {
  const completed = [...(outcome?.completed || [])];
  const incomplete = [...(outcome?.incomplete || [])].map((plan) => {
    const statuses = [...new Set(rejectedFamilyParts.get(plan.stateKey) || ["failed"])];
    return { plan, statuses };
  });
  return {
    reconciliations: completed.map(({ base_doc_uid, keep_doc_uids }) => ({
      base_doc_uid,
      keep_doc_uids,
    })),
    incomplete,
    intentionalRemovalUids: incomplete
      .filter(({ statuses }) => statuses.length > 0 && statuses.every((status) => status === "refused"))
      .map(({ plan }) => plan.base_doc_uid),
  };
}

// Load-time snapshot invariant: each WeakMap entry indexes only the legacy
// per-part keys already present when this state object was loaded. Current
// result failures use logical keys rather than synthetic part receipt keys. A
// real local filename may resemble the suffix, but it is protected separately
// and is intentionally not folded into this legacy snapshot during the run.
// Indexing once avoids rescanning thousands of exclusions per accepted document.
const SKIPPED_PART_INDEX = new WeakMap();

function skippedPartIndexOf(state) {
  const existing = SKIPPED_PART_INDEX.get(state);
  if (existing?.source === state.skipped) return existing.byRoot;
  const byRoot = new Map();
  for (const skippedKey of Object.keys(state.skipped || {})) {
    const match = skippedKey.match(/^(.*)#part[1-9]\d*of[1-9]\d*$/);
    if (!match) continue;
    const keys = byRoot.get(match[1]) || [];
    keys.push(skippedKey);
    byRoot.set(match[1], keys);
  }
  SKIPPED_PART_INDEX.set(state, { source: state.skipped, byRoot });
  return byRoot;
}

/**
 * Commit one logical document's accepted revision to resumable state.
 *
 * A refusal or extraction failure is current only until that same logical
 * document is accepted later. Keep the transition here so local folders,
 * Drive and Gmail cannot update `done` while leaving an old reason behind in
 * `skipped`. Split families call this only after every part is accepted and
 * family reconciliation succeeds.
 *
 * `skipKeys` contains exact receipt keys for the current revision. Older builds
 * also wrote per-part failures, whose count may differ from the recovered
 * revision. `legacyPartRoot` clears only the split suffix shape produced by this
 * installer and may include both old platform-native and current POSIX roots.
 * Local callers protect real candidate filenames that happen to use the same
 * shape, so one recovery cannot erase another file's current failure.
 */
export function recordAcceptedDocumentState(state, {
  stateKey, hash, skipKeys = [], legacyPartRoot = null, protectedSkipKeys = [],
} = {}) {
  const key = String(stateKey || "");
  if (!key) throw new Error("accepted document state needs a logical state key");
  if (!state.done || typeof state.done !== "object") state.done = {};
  if (!state.skipped || typeof state.skipped !== "object") state.skipped = {};
  state.done[key] = hash;
  const exactSkipKeys = [key, ...(skipKeys || [])]
    .filter((skipKey) => skipKey !== null && skipKey !== undefined && String(skipKey) !== "")
    .map(String);
  const legacyPartRoots = Array.isArray(legacyPartRoot) ? legacyPartRoot : [legacyPartRoot];
  if (legacyPartRoots.some((root) => root !== null && root !== undefined && String(root) !== "")) {
    const protectedKeys = protectedSkipKeys instanceof Set
      ? protectedSkipKeys
      : new Set([...(protectedSkipKeys || [])].map(String));
    const partIndex = skippedPartIndexOf(state);
    for (const root of legacyPartRoots) {
      if (root === null || root === undefined || String(root) === "") continue;
      for (const skippedKey of partIndex.get(String(root)) || []) {
        if (!protectedKeys.has(skippedKey)) exactSkipKeys.push(skippedKey);
      }
    }
  }
  for (const skipKey of new Set(exactSkipKeys)) {
    delete state.skipped[skipKey];
  }
  return state;
}

/** Add native and POSIX aliases to an existing local-path identity set. */
export function addLocalPathAliases(target, records, field, pathSeparator = sep) {
  if (!(target instanceof Set)) throw new Error("local path aliases need a Set target");
  for (const record of records || []) {
    const value = field ? record?.[field] : record;
    if (value === null || value === undefined || String(value) === "") continue;
    const raw = String(value);
    const normalized = raw.split(pathSeparator).join("/");
    target.add(normalized);
    if (raw !== normalized) target.add(raw);
  }
  return target;
}

/** Record the current local skip under one portable key, retiring its old alias. */
export function recordLocalSkippedDocumentState(state, { stateKey, nativePath, reason } = {}) {
  const key = String(stateKey || "");
  if (!key) throw new Error("skipped document state needs a logical state key");
  if (!state.skipped || typeof state.skipped !== "object") state.skipped = {};
  state.skipped[key] = String(reason || "skipped without a reason");
  const alias = nativePath === null || nativePath === undefined ? "" : String(nativePath);
  if (alias && alias !== key) delete state.skipped[alias];
  return state;
}

export const sourceCursorCanAdvance = (tally) => Number(tally?.failed || 0) === 0;

/**
 * Turn a durable per-document failure receipt into a machine-visible failure.
 *
 * Callers invoke this only after saving resume state and closing the source
 * receipt. Refusals and reasoned skips are deliberately not failures: they are
 * accepted source-policy outcomes. A store result of `failed` is different. If
 * it returned exit 0, launchd recorded a green scheduled run even though the
 * source was left in error and its cursor was withheld for retry.
 */
export function assertNoIngestFailures(tally, { noun = "stored part" } = {}) {
  const failed = Math.max(0, Math.trunc(Number(tally?.failed || 0)));
  if (!failed) return true;
  const label = failed === 1 ? noun : `${noun}s`;
  die(
    `${failed} ${label} failed, so this ingest is incomplete.\n` +
      "      Progress was saved. Re-run the same command to retry only what did not finish."
  );
}

/**
 * Attach the common ingestion outcome to a message-capture command result.
 *
 * The capture libraries count documents submitted to the Worker. The Worker
 * may still refuse one at its credential boundary. Preserve both numbers so a
 * sweep cannot turn "submitted" into "accepted", and expose that refusal as a
 * partial outcome even though it is an intentional security-policy result.
 */
export function messageIngestionResult(result, tally) {
  const created = Math.max(0, Math.trunc(Number(tally?.created || 0)));
  const updated = Math.max(0, Math.trunc(Number(tally?.updated || 0)));
  const unchanged = Math.max(0, Math.trunc(Number(tally?.unchanged || 0)));
  const refused = Math.max(0, Math.trunc(Number(tally?.refused || 0)));
  const partial = refused > 0 || !!result?.truncated || !!result?.bounded;
  const reasons = [
    refused ? `${refused} conversation document(s) were refused` : null,
    result?.truncated || result?.bounded ? "the source was bounded before its full history was read" : null,
  ].filter(Boolean).join("; ");
  return {
    ...result,
    created,
    updated,
    unchanged,
    refused,
    documents_accepted: created + updated + unchanged,
    outcome: ingestionOutcome(partial ? "partial" : "completed", {
      reason: partial ? reasons : null,
    }),
  };
}

const INGEST_RESULT_STATUSES = new Set(["created", "updated", "unchanged", "refused", "failed"]);

/**
 * Require one acknowledged result for every document sent in a batch.
 *
 * The top-level counters are informational. Cursor safety depends on the
 * per-document receipt because a truncated response can otherwise say
 * `failed: 0` while silently omitting a document that was never stored.
 */
export function validateBatchReceipt(body, group) {
  if (!body || !Array.isArray(body.results)) {
    throw new Error("the response has no per-document results array");
  }
  const expected = new Map();
  for (const item of group || []) {
    const sourceId = String(item?.envelope?.source_id || "");
    if (!sourceId) throw new Error("a sent document has no source_id");
    if (expected.has(sourceId)) throw new Error(`the request contains duplicate source_id ${sourceId}`);
    expected.set(sourceId, item);
  }

  const received = new Set();
  for (const result of body.results) {
    const sourceId = String(result?.source_id || "");
    if (!expected.has(sourceId)) throw new Error(`the response acknowledged an unknown source_id ${sourceId || "(empty)"}`);
    if (received.has(sourceId)) throw new Error(`the response acknowledged source_id ${sourceId} more than once`);
    if (!INGEST_RESULT_STATUSES.has(String(result?.status || ""))) {
      throw new Error(`the response used an unknown status for source_id ${sourceId}`);
    }
    received.add(sourceId);
  }
  const missing = [...expected.keys()].filter((sourceId) => !received.has(sourceId));
  if (missing.length) {
    throw new Error(`${missing.length} sent document(s) were not acknowledged, including ${missing[0]}`);
  }
  return body.results;
}

/** Refuse a complete logical document before any size-based splitting. */
export function credentialRefusalOf(envelope, enabled = true) {
  if (!enabled || typeof envelope?.content !== "string") return null;
  const result = scanEnvelopeSecrets(envelope);
  if (!result.shouldRefuse) return null;
  return {
    reason: `refused: carries ${result.labels.join(", ")}`,
    labels: result.labels,
  };
}

/** A refusal label can be printed and journaled, so it must be safe itself. */
export function safeIngestDisplay(...candidates) {
  const value = candidates.find((candidate) =>
    candidate !== undefined && candidate !== null && String(candidate).trim()
  );
  const sanitized = sanitizeIngestEnvelope({ display: String(value ?? "unnamed document") }).display;
  return redactConfirmedSecrets(sanitized);
}

/**
 * Refuse to write a secret somewhere it will be published or lost.
 *
 * The key lands next to the manifest, which is wherever the operator happened to
 * be standing. In the field test that was C:\\Windows\\system32, the default
 * directory of an elevated PowerShell. A sync root is worse: it uploads the key
 * to a third party without anyone doing anything they would call careless.
 */
export function assertKeyDirSafe(dir) {
  const sys = [
    /^[a-z]:[\\/](windows|program files( \(x86\))?)([\\/]|$)/i,
    /^\/(usr|bin|sbin|etc|var|System|Library)(\/|$)/,
  ];
  if (sys.some((re) => re.test(dir))) {
    die(
      `refusing to write the admin key into a system directory:` + "\n" +
        `    ${dir}` + "\n" +
        "  Run this from a folder you own, for example:" + "\n" +
        "    cd ~/brain    (or  cd %USERPROFILE%\\brain  on Windows)"
    );
  }
  const synced = [/OneDrive/i, /Dropbox/i, /Google ?Drive/i, /CloudStorage/i, /Mobile Documents/i, /[\\/]Box[\\/]/i];
  if (synced.some((re) => re.test(dir))) {
    warn(
      `${dir}` + "\n" +
        "        looks like a synced folder. The admin key is about to be written there," + "\n" +
        "        which uploads it to a third party. Moving the install elsewhere is safer."
    );
  }
}

/** Basenames used by the durable key writer, including its crash residue. */
export const ADMIN_KEY_GITIGNORE_RULES = Object.freeze([
  ".brain-admin-key",
  "..brain-admin-key.[0-9]*.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].tmp",
  "..brain-admin-key.[0-9]*.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].bak",
]);

/** Defuse the likeliest accident: committing the key or crash residue. */
function gitignoreTheKey(dir) {
  let d = resolve(dir);
  while (true) {
    if (existsSync(join(d, ".git"))) {
      const keyPath = relative(d, join(dir, ".brain-admin-key")).split(sep).join("/");
      if (!keyPath || keyPath === ".." || keyPath.startsWith("../")) {
        throw new Error("the adjacent admin-key path is outside the detected Git repository");
      }
      const tracked = spawnSync(
        "git",
        ["-C", d, "ls-files", "--error-unmatch", "--", keyPath],
        {
          encoding: "utf8",
          env: localToolEnvironment(process.env),
          timeout: 5_000,
          windowsHide: true,
        },
      );
      if (tracked.error || (tracked.status !== 0 && tracked.status !== 1)) {
        throw new Error("the install's Git index could not be checked before writing the admin key");
      }
      if (tracked.status === 0) {
        throw new Error(
          "the adjacent .brain-admin-key is already tracked by Git; remove it from the index before rotating",
        );
      }
      const gi = join(dir, ".gitignore");
      const inspect = () => {
        let identity;
        try { identity = lstatSync(gi); }
        catch (error) {
          if (error?.code === "ENOENT") return null;
          throw error;
        }
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
            identity.size > 16 * 1024 * 1024 ||
            (typeof process.getuid === "function" && identity.uid !== process.getuid())) {
          throw new Error("the install .gitignore is not a safe owner-controlled regular file");
        }
        return identity;
      };
      let identity = inspect();
      let fd;
      let cur = "";
      let missing;
      let addition;
      try {
        if (identity) {
          fd = openSync(
            gi,
            fsConstants.O_RDWR | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0),
          );
          const opened = fstatSync(fd);
          if (opened.dev !== identity.dev || opened.ino !== identity.ino ||
              opened.size !== identity.size || opened.nlink !== 1) {
            throw new Error("the install .gitignore changed while it was being inspected");
          }
          cur = readFileSync(fd, "utf8");
        }
        const lines = new Set(cur.split(/\r?\n/));
        missing = ADMIN_KEY_GITIGNORE_RULES.filter((rule) => !lines.has(rule));
        if (missing.length) {
          addition = Buffer.from(
            `${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
            "utf8",
          );
          if (!identity) {
            fd = openSync(
              gi,
              fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
                (fsConstants.O_NOFOLLOW || 0),
              0o644,
            );
            identity = fstatSync(fd);
          }
          let offset = 0;
          while (offset < addition.length) {
            const written = writeSync(fd, addition, offset, addition.length - offset);
            if (written <= 0) throw new Error("the install .gitignore append made no progress");
            offset += written;
          }
          fsyncSync(fd);
        }
      } finally {
        if (addition) addition.fill(0);
        if (fd !== undefined) closeSync(fd);
      }
      if (missing.length) {
        const current = inspect();
        if (!current || !identity || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new Error("the install .gitignore changed before its key rules were verified");
        }
        let verifyFd;
        let verified;
        try {
          verifyFd = openSync(gi, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
          const opened = fstatSync(verifyFd);
          if (opened.dev !== current.dev || opened.ino !== current.ino || opened.nlink !== 1) {
            throw new Error("the install .gitignore changed during key-rule verification");
          }
          verified = readFileSync(verifyFd, "utf8").split(/\r?\n/);
        } finally {
          if (verifyFd !== undefined) closeSync(verifyFd);
        }
        if (missing.some((rule) => !verified.includes(rule))) {
          throw new Error("the install .gitignore key rules did not verify exactly");
        }
        warn("the admin key is inside a git repository. Added its private basenames to the install's .gitignore.");
      }
      return;
    }
    const up = dirname(d);
    if (up === d) return;
    d = up;
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else if (VALUE_FLAGS.has(key)) {
      die(`--${key} needs a value, for example: --${key} <value>`);
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** Levenshtein distance, so a typo gets a suggestion rather than a shrug. */
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Refuse a flag the command does not know, instead of running as if it were
 * never typed.
 *
 * parseFlags is deliberately permissive: it turns any `--word` into a key so
 * that every command can read whatever it likes without registering anything.
 * The cost is that a flag nobody reads is indistinguishable from a flag that
 * worked. That is tolerable for a flag that only adds output. It is not
 * tolerable for a recovery flag: a real install ran
 * `brain doctor <manifest> --repair-checksum` against a release that did not
 * contain it, got ordinary doctor output and exit 0, and reasonably concluded
 * the repair had run and found nothing to fix. Nothing had run at all.
 *
 * So a command that can change data validates its own flags and exits nonzero
 * on one it does not recognise.
 */
export function assertKnownFlags(flags, known, command) {
  const allowed = new Set(known);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;

  const listed = [...allowed].sort().map((f) => `--${f}`).join(", ");
  const lines = unknown.map((key) => {
    const near = [...allowed]
      .map((candidate) => [candidate, editDistance(key, candidate)])
      .filter(([, distance]) => distance <= 3)
      .sort((a, b) => a[1] - b[1])[0];
    return near ? `unknown option --${key} for \`${command}\`. Did you mean --${near[0]}?` : `unknown option --${key} for \`${command}\`.`;
  });

  die(
    `${lines.join("\n")}\n` +
      `\n  This exits nonzero rather than continuing, because a flag that is silently\n` +
      `  ignored looks exactly like a flag that ran and had nothing to do.\n` +
      `\n  Options ${command} accepts: ${listed}`,
  );
}

async function resolveBase(m, acct) {
  if (m.brain?.domain) return `https://${m.brain.domain}`;
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
  return sub?.subdomain ? `https://${scriptName}.${sub.subdomain}.workers.dev` : null;
}

/**
 * What the document store actually holds, per source.
 *
 * The registry's own document_count is a receipt from the last ingest, not the
 * truth. Reading the store is what turns "the brain has 1,204 documents from
 * this source" from a claim into an observation, and the gap between the two
 * numbers is the cheapest signal available that an ingest died halfway.
 *
 * Returns null rather than throwing: a listing that works without the admin key
 * is more useful than one that refuses to print anything.
 */
async function liveSourceCounts(base, adminKey) {
  if (!base || !adminKey) return null;
  try {
    const res = await http(`${base}/api/admin/brain/documents`, {
      headers: { "X-Admin-Key": adminKey },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const map = new Map();
    for (const r of body.rows || []) map.set(r.source_type, r);
    return map;
  } catch {
    return null;
  }
}

async function readSources(acctId, dbId) {
  const r = await d1Query(acctId, dbId, "SELECT * FROM sources ORDER BY name").catch(() => null);
  if (!r) {
    die(
      "no `sources` table in this install.\n" +
        "      Run `brain migrate <manifest>` to apply migration 0003, then try again."
    );
  }
  return r.results || [];
}

const num = (n) => Number(n || 0).toLocaleString("en-US");

/** The documents endpoint also exposes `total` for legacy chunk-oriented clients. */
export function documentCountOf(row) {
  if (!row) return undefined;
  const value = row.documents ?? row.total;
  const count = Number(value);
  return Number.isFinite(count) ? count : undefined;
}

/**
 * Print how CURRENT each source is, as distinct from how big it is.
 *
 * Deliberately says "manual" rather than "stale" for a source we cannot refresh
 * on our own, like a folder on the client's laptop. Calling that stale would be
 * blaming them for a limit of the architecture, and a warning that fires every
 * day for something nobody can fix is how clients learn to ignore warnings.
 */
async function reportFreshness(m, acct, manifestPath) {
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) return;
  const res = await http(`${base}/api/admin/brain/freshness`, { headers: { "X-Admin-Key": adminKey } },
    { timeoutMs: 30_000, what: "the freshness check" });
  if (!res.ok) return;
  const { sources } = await res.json();
  if (!sources?.length) return;

  const LABEL = {
    ok: () => c.green("current"),
    stale: (s) => c.red(`STALE, ${s.days_since_ingest}d since last read`),
    broken: (s) => c.red(`BROKEN: ${s.reason || "the last sync failed"}`),
    indexing: (s) => c.yellow(`indexing, ${s.hours_indexing ?? 0}h elapsed`),
    never_synced: () => c.red("never synced"),
    unscheduled: () => c.yellow("no refresh scheduled"),
    manual: (s) => c.dim(`manual, ${s.days_since_ingest ?? "?"}d since last load`),
  };
  console.log(`\n  ${c.bold("freshness")}`);
  for (const s of sources) {
    console.log(`    ${s.name.padEnd(16)} ${(LABEL[s.state] || (() => s.state))(s)}`);
  }
  const bad = sources.filter((s) => s.state === "stale" || s.state === "broken" || s.state === "never_synced");
  const unsched = sources.filter((s) => s.state === "unscheduled");
  const manual = sources.filter((s) => s.state === "manual");
  if (bad.length) {
    warn(
      `${bad.length} source(s) are not current. The brain will say so in its answers` + "\n" +
        "        rather than answering as if nothing were missing."
    );
  }
  if (unsched.length) {
    info(
      `${unsched.length} source(s) could refresh on their own but have no schedule set.` + "\n" +
        "        Until one is set, no staleness claim is made about them either way."
    );
  }
  if (manual.length) {
    info(
      `${manual.length} source(s) are loaded by hand from a machine we cannot reach,` + "\n" +
        "        so they are never reported as stale. Re-run `brain ingest` to refresh one."
    );
  }
}

async function cmdSources(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const flags = parseFlags(process.argv.slice(4));

  // Registering by hand exists because the connectors are still being written.
  // When an ingest driver lands it registers its own source on first run and
  // this stays as the escape hatch for a corpus that has no connector.
  if (flags.add) {
    const name = assertSourceName(flags.add === true ? null : flags.add);
    const kind =
      (flags.kind !== true && flags.kind) ||
      Object.keys(m.corpora || {}).find((k) => k.replace(/_/g, "-") === name) ||
      "upload";
    const now = new Date().toISOString();
    const res = await d1Query(
      acct.id,
      dbId,
      "INSERT INTO sources (name, kind, status, created_at) VALUES (?,?,'pending',?) ON CONFLICT(name) DO NOTHING",
      [name, String(kind), now]
    );
    if (res?.meta?.changes) {
      await d1Query(
        acct.id,
        dbId,
        "INSERT INTO source_events (source_name, event, at, detail) VALUES (?,'registered',?,?)",
        [name, now, `kind=${kind}`]
      );
      ok(`registered source "${name}" (kind ${kind})`);
    } else {
      info(`source "${name}" is already registered, leaving it alone`);
    }
  }

  // Set (or clear) how often a source is EXPECTED to refresh. Without this
  // nothing ever has an expectation, so no staleness claim is ever made and the
  // whole freshness signal stays silent, which is worse than not having it.
  if (flags.refresh !== undefined) {
    const name = assertSourceName(flags.source === true ? null : flags.source);
    const spec = String(flags.refresh === true ? "" : flags.refresh).toLowerCase();
    const SECONDS = { hourly: 3600, daily: 86400, weekly: 604800, monthly: 2592000, never: null, off: null };
    if (!(spec in SECONDS)) {
      die(
        `--refresh needs one of: hourly, daily, weekly, monthly, never.` + "\n" +
          `  "never" clears the expectation, and a source with no expectation is never` + "\n" +
          "  reported as stale, which is the right default for a one-off folder load."
      );
    }
    await d1Query(acct.id, dbId, "UPDATE sources SET expected_refresh_seconds = ? WHERE name = ?", [SECONDS[spec], name]);
    if (SECONDS[spec] === null) ok(`"${name}" will no longer be reported as stale`);
    else ok(`"${name}" is expected to refresh ${spec}; it will be reported stale past 1.5x that`);
  }

  const rows = await readSources(acct.id, dbId);
  const base = await resolveBase(m, acct);
  const live = await liveSourceCounts(base, resolveAdminKey(manifestPath));

  if (!rows.length) {
    warn("no named sources registered in this install.");
    info(`register one with: brain sources ${manifestPath} --add <name> --kind <drive|gmail|imap|calendar|upload>`);
  } else {
    const w = (key, min) => Math.max(min, ...rows.map((r) => String(r[key] || "").length));
    const wName = w("name", 4);
    const wKind = w("kind", 4);
    const wStat = w("status", 6);
    console.log(
      `\n  ${"name".padEnd(wName)}  ${"kind".padEnd(wKind)}  ${"status".padEnd(wStat)}  ${"documents".padStart(11)}  last ingest`
    );
    for (const r of rows) {
      // Compare DOCUMENTS to documents. The store also reports a chunk count,
      // which is always larger, and comparing against that showed drift on every
      // healthy install.
      const liveRow = live?.get(r.name);
      const shown = documentCountOf(liveRow);
      const drift =
        shown !== undefined && Number(shown) !== Number(r.document_count)
          ? c.yellow(`  (store says ${num(shown)})`)
          : "";
      const chunks = liveRow?.chunks !== undefined ? c.dim(`  ${num(liveRow.chunks)} chunks`) : "";
      console.log(
        `  ${r.name.padEnd(wName)}  ${String(r.kind).padEnd(wKind)}  ${String(r.status).padEnd(wStat)}  ${num(r.document_count).padStart(11)}  ${r.last_ingest_at ? r.last_ingest_at.slice(0, 19) : c.dim("never")}${drift}${chunks}`
      );
    }
  }

  // Freshness, stated per source. This is the half that was invisible: a source
  // nobody re-reads looks exactly like a source with nothing new in it.
  await reportFreshness(m, acct, manifestPath).catch(() => {});

  if (!live) {
    console.log(
      `\n  ${c.dim("counts above are the registry's own last receipt. Repair the manifest's durable")}`
    );
    console.log(`  ${c.dim("admin-key storage to cross-check them against what the brain actually holds.")}`);
  } else {
    // Everything ingested before this feature existed, or by a path that never
    // registered itself, lands here. It is the honest version of the listing:
    // these documents exist, and `brain forget` cannot take them back out.
    const orphans = [...live.entries()].filter(([k]) => !rows.some((r) => r.name === k));
    if (orphans.length) {
      console.log(`\n  ${c.yellow("in the store but not registered")}, so \`brain forget\` cannot remove them:`);
      for (const [k, v] of orphans) console.log(`    ${k.padEnd(16)} ${num(documentCountOf(v)).padStart(9)} documents`);
    }
  }

  const events = await d1Query(
    acct.id,
    dbId,
    "SELECT source_name, event, at, documents FROM source_events ORDER BY at DESC LIMIT 5"
  ).catch(() => null);
  const evs = events?.results || [];
  if (evs.length) {
    console.log("\n  recent source events:");
    for (const e of evs) {
      const n = e.documents === null || e.documents === undefined ? "" : `  ${num(e.documents)} documents`;
      const mark = e.event === "forget" ? c.yellow("forget") : e.event;
      console.log(`    ${e.at.slice(0, 19)}  ${String(mark).padEnd(18)} ${e.source_name}${n}`);
    }
  }
  console.log("");
}

/**
 * Remove every document belonging to one named source.
 *
 * Two channels, deliberately in this order.
 *
 * The worker route is the correct one: the client's worker already holds the
 * service-role credential, so the deletion happens where the data lives and the
 * CLI never needs a second god-mode key. The direct PostgREST path is the
 * fallback for installs whose worker predates that route.
 *
 * If NEITHER channel is available this refuses and changes nothing. Deleting
 * the registry row on its own would be worse than doing nothing: the documents
 * would survive, unreachable by name, and the next `brain sources` would report
 * them as unregistered with no way left to remove them. A rollback that half
 * works is the specific failure this whole feature exists to prevent.
 */
async function purgeDocuments(base, adminKey, name) {
  const warnings = [];

  if (!base || !adminKey) {
    warnings.push(
      "the worker could not be addressed (no URL or no ADMIN_KEY), so the store was edited directly"
    );
  } else {
    const res = await http(`${base}/api/admin/brain/forget`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      // confirm:true is REQUIRED. The route dry-runs by default, so omitting it
      // returns a perfectly well-formed receipt having deleted nothing, which is
      // exactly the "reported success, removed nothing" failure this function
      // spends fifty lines guarding against everywhere else.
      body: JSON.stringify({ source: name, confirm: true }),
    }).catch((e) => ({ ok: false, status: 0, netError: e.message }));

    if (res.ok) {
      // A 200 is NOT proof of removal. Cloudflare Access interstitials, SSO
      // login pages and misrouted requests all answer 200 with HTML, and the
      // previous version parsed that into {} and reported a successful purge.
      // Only a well-formed receipt naming how many rows went counts as done.
      const raw = await res.text().catch(() => "");
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* handled below */
      }
      // The D1 route reports `documents`; the older Supabase-era route reported
      // `removed`. Accept either, but never invent one.
      const removed =
        body && typeof body.documents === "number"
          ? body.documents
          : body && typeof body.removed === "number"
            ? body.removed
            : null;
      // A route that dry-ran deleted nothing, whatever else it said.
      if (body && body.dry_run === true) {
        die(
          "the worker ran a DRY RUN and removed nothing. This build of brain.mjs is older than\n" +
            "      the worker it is talking to. Update the installer, then rerun the same\n" +
            "      `brain forget` command. The raw credential-header workaround is intentionally disabled."
        );
      }
      if (removed === null) {
        const looksLikeHtml = /^\s*</.test(raw);
        die(
          `the worker returned 200 but not a removal receipt, so nothing is confirmed removed.\n` +
            (looksLikeHtml
              ? "      The response is HTML, which usually means an Access or SSO interstitial\n" +
                "      answered instead of the worker. Check that the route is not behind Access.\n"
              : `      Expected JSON with a numeric "removed". Got: ${raw.slice(0, 120)}\n`) +
            "      The source has been left registered so it can be removed once this is fixed."
        );
      }
      const queued = Number(body?.vector_cleanup_queued || 0);
      if (queued > 0) {
        warnings.push(
          `${num(queued)} physical vector deletion(s) remain queued. The documents are unreachable, ` +
          `but run \`brain drain <manifest>\` to reclaim the vector slots.`
        );
      }
      if (body?.vector_error) warnings.push(`vector cleanup reported: ${String(body.vector_error).slice(0, 180)}`);
      return { channel: "worker route", removed, warnings };
    }
    // 404/405 means this worker has no such route, which is expected on an
    // older install and is the one case worth falling through on. Anything
    // else is a real failure and must not be downgraded into a weaker path:
    // a 500 from the worker says the removal was attempted and went wrong,
    // and retrying it through a different door is how you delete twice.
    if (res.status && res.status !== 404 && res.status !== 405) {
      const detail = await res.text().catch(() => "");
      die(
        `the worker's forget route returned ${res.status}: ${String(detail).slice(0, 200)}\n` +
          "      Nothing was removed."
      );
    }
    warnings.push(
      res.netError
        ? `the worker at ${base} could not be reached (${res.netError}), so the store was edited directly`
        : "this worker has no /api/admin/brain/forget route, so the store was edited directly"
    );
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    die(
      `no way to reach the document store, so nothing was removed.\n` +
        `      Deploy a worker that serves POST /api/admin/brain/forget. The legacy direct fallback\n` +
        `      requires a Supabase service-role key supplied by an approved secret manager; this CLI\n` +
        `      will not show a pasteable shell command for that high-privilege credential.\n` +
        `      The registry row was left in place on purpose: removing it while the documents\n` +
        `      survive would leave them in the brain with no name left to remove them by.`
    );
  }

  const root = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const filter = `source_type=eq.${encodeURIComponent(name)}`;

  const countRows = async (profile) => {
    const res = await http(`${root}/rest/v1/${profile.table}?${filter}&select=source_type&limit=1`, {
      headers: { ...headers, Prefer: "count=exact", ...(profile.schema ? { "Accept-Profile": profile.schema } : {}) },
    });
    if (!res.ok) return null;
    const range = res.headers.get("content-range") || "";
    const n = Number(range.split("/")[1]);
    return Number.isFinite(n) ? n : null;
  };

  const del = async (profile) => {
    const res = await http(`${root}/rest/v1/${profile.table}?${filter}`, {
      method: "DELETE",
      headers: {
        ...headers,
        Prefer: "return=minimal",
        ...(profile.schema ? { "Content-Profile": profile.schema } : {}),
      },
    });
    return res;
  };

  // The searchable mirror. This is the one that decides whether the source is
  // still findable, so it is the one that must succeed.
  const before = await countRows({ table: "notes_rag_documents" });
  const res = await del({ table: "notes_rag_documents" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`the store refused the removal (${res.status}): ${body.slice(0, 200)}\n      Nothing was removed.`);
  }

  // Verify rather than assume. A DELETE that reports success and leaves rows
  // behind is exactly the shape of failure a rollback promise cannot survive,
  // and the check costs one request.
  const after = await countRows({ table: "notes_rag_documents" });
  if (after !== null && after > 0) {
    die(
      `removal reported success but ${num(after)} document(s) for "${name}" are still in the store.\n` +
        "      Do not treat this source as removed."
    );
  }

  // The canonical table lives in the `brain` schema, which PostgREST only
  // exposes if the client's project was configured to. When it is not, say so
  // and hand over the exact statement rather than reporting a clean removal
  // that left the source's spine in place.
  const canonical = await del({ table: "documents", schema: "brain" });
  if (!canonical.ok) {
    warnings.push(
      `the canonical rows in brain.documents were NOT removed (PostgREST returned ${canonical.status} for the brain schema).\n` +
        `        The source is gone from retrieval, but finish the job in the SQL editor:\n` +
        `          DELETE FROM brain.documents WHERE source_type = '${name}';`
    );
  }

  return { channel: "direct store access", removed: before, warnings };
}

async function cmdForget(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  if (!flags.source || flags.source === true) {
    die("usage: brain forget <manifest> --source <name> [--yes]");
  }
  const name = assertSourceName(flags.source);

  const acct = await resolveAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest. Run `brain provision` first.");

  const rows = await readSources(acct.id, dbId);
  const row = rows.find((r) => r.name === name);

  // A typo must never look like a success. Silently reporting "removed" for a
  // source that was never there teaches the client that forget works, right up
  // until the day they check and the documents are all still present.
  if (!row) {
    const names = rows.map((r) => r.name);
    const near = names
      .map((n) => [n, editDistance(n, name)])
      .filter(([, d]) => d <= 3)
      .sort((a, b) => a[1] - b[1])[0];
    die(
      `no source named "${name}" in this install.\n` +
        (names.length
          ? `      registered: ${names.join(", ")}\n`
          : "      no sources are registered at all.\n") +
        (near ? `      did you mean "${near[0]}"?\n` : "") +
        "      Nothing was removed."
    );
  }

  const base = await resolveBase(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  const live = await liveSourceCounts(base, adminKey);
  const liveCount = documentCountOf(live?.get(name));

  // Print the damage BEFORE anything happens, every time, --yes or not.
  console.log(`\n  ${c.bold(`forget "${name}"`)} from ${m.client?.display_name || m.client?.slug || "this install"}\n`);
  console.log("  this removes:");
  if (liveCount !== undefined) {
    console.log(`    ${num(liveCount).padStart(9)}  documents in the brain (source_type = "${name}")`);
  } else {
    console.log(`    ${num(row.document_count).padStart(9)}  documents, per the registry's last receipt`);
    console.log(`    ${c.dim("           the live count could not be read, so this number may be stale")}`);
  }
  console.log(`    ${"1".padStart(9)}  registry row in sources`);
  if (row.sync_cursor) {
    console.log(`    ${"1".padStart(9)}  sync cursor (a later ingest of "${name}" starts from the beginning)`);
  }
  console.log(`\n  kind ${row.kind}, status ${row.status}, registered ${String(row.created_at).slice(0, 19)}`);
  if (row.scope) console.log(`  scope ${String(row.scope).slice(0, 160)}`);
  if (row.status === "indexing") {
    warn(
      `"${name}" is mid-ingest. Stop the ingest first, or it will keep writing\n` +
        "        documents back in under the same name after this finishes."
    );
  }

  if (!flags.yes) {
    console.log(`\n  ${c.bold("Nothing has been removed.")} Re-run with --yes to actually do it:\n`);
    console.log(`    node brain.mjs forget ${manifestPath} --source ${name} --yes\n`);
    return;
  }

  console.log("");
  const out = await purgeDocuments(base, adminKey, name);

  // Never substitute an expectation for an observation.
  //
  // This previously fell back to the count we HOPED to remove when the channel
  // could not confirm one, so an unconfirmed purge printed "removed 412
  // documents" having removed nothing. The number a destructive command reports
  // must be something it watched happen.
  if (out.removed === null || out.removed === undefined) {
    die(
      `the removal channel (${out.channel}) did not report how many documents went,\n` +
        "      so this cannot be called done. The registry row was left in place,\n" +
        `      so "${name}" is still addressable and you can retry once the channel\n` +
        "      reports a count."
    );
  }
  const removed = out.removed;
  ok(`removed ${num(removed)} document(s) via ${out.channel}`);

  // Confirm against the live brain before freeing the name. Freeing it while
  // documents survive is the one outcome with no recovery: they stay in the
  // index with no name left to address them by, which is precisely what this
  // feature exists to prevent.
  const post = await liveSourceCounts(base, adminKey);
  const stillThere = documentCountOf(post?.get(name));
  if (stillThere) {
    die(
      `${num(stillThere)} document(s) for "${name}" are STILL in the brain after the purge.\n` +
        "      The registry row was left in place. Do not treat this source as removed."
    );
  }
  if (post === null || post === undefined) {
    warn(
      "the live count could not be re-read, so removal is reported but not independently\n" +
        "        confirmed. Run `brain sources` once the worker is reachable."
    );
  }

  // The event is written BEFORE the registry row is deleted, so a failure
  // between the two leaves the source visible and retryable rather than
  // silently gone. Same reason upgrade_runs records the failures.
  await d1Query(
    acct.id,
    dbId,
    "INSERT INTO source_events (source_name, event, at, documents, detail) VALUES (?,'forget',?,?,?)",
    [name, new Date().toISOString(), removed, `channel=${out.channel}`]
  ).catch(() => {});

  await d1Query(acct.id, dbId, "DELETE FROM sources WHERE name = ?", [name]);
  ok(`registry row for "${name}" removed, the name is free to reuse`);

  for (const wmsg of out.warnings) warn(wmsg);
  console.log("");
}


/**
 * brain ingest — load a folder into the brain.
 *
 * The command the product did not have. Everything before it could stand up an
 * empty brain and prove it was healthy.
 *
 * Resumable by design: state is keyed by content hash and written after every
 * batch, so re-running is how a large import finishes rather than a recovery
 * step. Nothing is ever skipped silently; the run ends with a breakdown by
 * reason, and those reasons are kept in the state file.
 */
async function cmdIngest(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  // Remote sources reuse everything below the envelope: splitting, batching,
  // the credential gate, resume state and the skip report. Only the producer
  // differs. Calendar is the one exception: its connector already carries
  // its own complete sync-then-send pipeline, so it has its own command
  // rather than being forced through machinery built for files.
  if (String(flags.from).toLowerCase() === "calendar") return cmdIngestCalendar(m, manifestPath, flags);
  if (String(flags.from).toLowerCase() === "imessage") return cmdIngestImessage(m, manifestPath, flags);
  if (String(flags.from).toLowerCase() === "whatsapp") return cmdIngestWhatsapp(m, manifestPath, flags);
  // The one-time iPhone backup load: a snapshot producer with no cursor and
  // no live half, so it owns its own command rather than joining the remote
  // connectors that all resume from one.
  if (["iphone-backup", "iphone"].includes(String(flags.from).toLowerCase())) {
    return cmdIngestIphoneBackup(m, manifestPath, flags);
  }
  if (flags.from) return cmdIngestRemote(m, manifestPath, flags);
  return cmdIngestLocal(m, manifestPath, flags);
}

/**
 * The local-folder half of `brain ingest`, lifted out of cmdIngest unchanged.
 *
 * It was extracted for one reason: `brain load` sweeps every source this
 * manifest declares, and a folder on disk is one of those sources. Reaching it
 * used to mean going back through cmdIngest, which reads process.argv, so the
 * only way to drive it from another command was to forge argv. Taking the
 * manifest, path and flags as arguments makes it callable the same way every
 * other per-source ingest already is, and keeps `brain load` running the SAME
 * walker an operator runs by hand rather than a second copy that could drift.
 */
export async function cmdIngestLocal(m, manifestPath, flags) {
  // A local folder now reconciles its own deletions, so it has the same
  // approval gate Drive does. It stays invalid on every OTHER remote source,
  // which is checked in cmdIngestRemote.
  const localRemovalApproval = flags["approve-removals"] === undefined
    ? undefined
    : String(flags["approve-removals"] || "").trim().toLowerCase();
  if (localRemovalApproval !== undefined && !/^[0-9a-f]{64}$/.test(localRemovalApproval)) {
    die("--approve-removals needs the exact 64-character fingerprint the refusal printed.");
  }

  const root = flags.path;
  if (!root) {
    die(
      "brain ingest needs --path <folder>.\n" +
        "  Optional: --source <name> (default \"upload\"), --limit <n>, --dry-run,\n" +
        "            --reset to ignore previous progress and re-send everything."
    );
  }
  if (!existsSync(root)) die(`no such folder: ${root}`);
  const { walk, prepare, batchStream, splitOversized, loadState, saveState, removedSinceLastRun } = await ingestLib();

  const sourceName = assertSourceName(flags.source === true ? null : flags.source || "upload");
  // A dry run sends nothing, so it must not demand credentials it will never
  // use. Requiring a Cloudflare token to preview what WOULD be loaded turns the
  // safest command in the tool into one of the hardest to reach.
  const dry = !!flags["dry-run"];
  const acct = dry ? null : m.brain?.domain ? null : await resolveAccount(m);
  const base = dry ? null : await resolveBaseUrl(m, acct);
  const adminKey = dry ? null : resolveAdminKey(manifestPath);
  if (!adminKey && !flags["dry-run"]) {
    die(
      "no durable admin key was found. Re-run `brain setup <manifest>` to generate and persist one; " +
        "do not paste the key into a shell command."
    );
  }

  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);
  const savedState = loadState(statePath);
  const state = flags.reset
    ? { version: 1, done: {}, skipped: {}, ...(savedState.removed ? { removed: savedState.removed } : {}) }
    : savedState;
  const previouslyKnownKeys = new Set(Object.keys(savedState.done || {}));
  const scannerOn = m.safety?.credential_scanner?.enabled !== false;
  const scannerFingerprint = credentialScannerFingerprint(scannerOn);
  const scannerPolicyChanged = state.credential_scanner_fingerprint !== scannerFingerprint;
  const alreadyDone = Object.keys(state.done).length;
  if (alreadyDone && !flags.reset) info(`resuming: ${alreadyDone} file(s) already loaded`);


  // OCR, and what it will cost, decided ONCE per run and stated out loud
  // before the first page is sent. The estimate lands while the owner can
  // still say no; a bill that appears afterwards is not a choice they were
  // offered. A dry run never gets a callback, so the safest command in the
  // tool stays the cheapest one.
  const ocrCfg = ocrPolicy(m);
  let ocrPages = 0;
  const ocrCallback = dry || !ocrCfg.enabled ? null : makeOcrCallback({
    base, adminKey, model: ocrCfg.model, maxPages: ocrCfg.maxPages,
    onPage: ({ page, totalPages }) => {
      ocrPages++;
      // Per PAGE, not per file. A forty-page scan is forty model calls and
      // over a minute of waiting; without this the run looks hung and the
      // first client to see it kills it.
      info(`  OCR page ${page}${totalPages ? ` of ${totalPages}` : ""} (${ocrPages} page(s) read so far this run)`);
    },
  });
  if (ocrCfg.enabled && !dry) {
    const { estimateOcrCost, describeOcrCost } = await ingestOcrLib();
    info(`OCR is ON, model ${ocrCfg.model}, up to ${ocrCfg.maxPages} page(s) per document.`);
    info(`  cost per 100 scanned pages: ${describeOcrCost(estimateOcrCost(100))}`);
  } else if (ocrCfg.enabled && dry) {
    info("OCR is ON, but a dry run never sends a page to a model and never spends anything.");
  }

  const privatePrefixes = m.safety?.private_path_prefixes || [];
  info(`walking ${root}`);
  const { files, skipped: walkSkips, complete: walkComplete } = walk(root, { privatePrefixes });
  info(`${files.length} candidate file(s), ${walkSkips.length} skipped during the walk`);
  if (privatePrefixes.length) {
    info(`private prefixes enforced: ${privatePrefixes.join(", ")}`);
  }
  if (!walkComplete) {
    await reportSkips(walkSkips);
    die(
      "the folder could not be read completely, so nothing was sent and no prior document was removed.\n" +
        "      Fix the reported permission or filesystem error, then re-run the same command."
    );
  }

  const limited = flags.limit ? files.slice(0, parseInt(flags.limit, 10)) : files;
  if (flags.limit) warn(`--limit ${flags.limit}: only the first ${limited.length} file(s) will be considered`);

  const skips = [...walkSkips];
  const notes = [];
  const intentionalRemovalKeys = new Set();
  const normalizedPrivatePaths = walkSkips
    .filter((skip) => skip.reason === "matched a private path prefix from the manifest")
    .map((skip) => String(skip.path).split(sep).join("/").replace(/^\.\//, "").replace(/\/$/, ""));
  const privateRemovalKeys = [...previouslyKnownKeys].filter((key) => normalizedPrivatePaths.some(
    (path) => key === path || key.startsWith(`${path}/`)
  ));
  const privateRemovalSet = new Set(privateRemovalKeys);
  const candidateLocalKeys = new Set(files.map((file) => String(file.rel).split(sep).join("/")));
  const missingScannerKeys = [...previouslyKnownKeys].filter(
    (key) => !candidateLocalKeys.has(key) && !privateRemovalSet.has(key)
  );
  if (!dry && scannerPolicyChanged && missingScannerKeys.length) {
    die(
      `${missingScannerKeys.length} previously-indexed file(s) are not present under this folder, so the current scanner cannot recheck them safely.\n` +
        "      Nothing was removed. Use the original source folder, or forget this source explicitly before replacing it."
    );
  }
  const limitedLocalKeys = new Set(limited.map((file) => String(file.rel).split(sep).join("/")));
  const limitedMissesPrior = [...previouslyKnownKeys].some(
    (key) => candidateLocalKeys.has(key) && !privateRemovalSet.has(key) && !limitedLocalKeys.has(key)
  );
  if (!dry && scannerPolicyChanged && limitedMissesPrior) {
    die(
      "--limit cannot be used while previously-indexed files need a credential-scanner recheck.\n" +
      "      Run without --limit so every prior document is rechecked before the new scanner is marked complete."
    );
  }
  // Scanner safety above needs only eligible, normalized candidates. After its
  // decisions are fixed, reuse that same Set for recovery protection by adding
  // native aliases and walk-skipped paths. A real file named like a split part
  // must not lose its current skip when another document family recovers.
  for (const file of files) {
    const raw = String(file.rel);
    const normalized = raw.split(sep).join("/");
    if (raw !== normalized) candidateLocalKeys.add(raw);
  }
  addLocalPathAliases(candidateLocalKeys, walkSkips, "path");
  const protectedLocalSkipKeys = candidateLocalKeys;
  // Files this source loaded before and can no longer find.
  //
  // Only computed for a whole, complete walk. Under --limit the run has
  // deliberately not looked at most of the folder, and an unexamined file is
  // not a deleted one; a walk that could not be read completely already
  // stopped the run above. Getting this wrong in the other direction is what
  // an unattended lane must never do: a folder that mounted empty would
  // otherwise read as "the client deleted everything".
  const vanishedRemovalKeys = flags.limit
    ? []
    : removedSinceLastRun(previouslyKnownKeys, protectedLocalSkipKeys)
      .filter((key) => !privateRemovalSet.has(key));
  const scannerRescanSkips = [];
  let unchanged = 0;
  let split = 0;
  let scanned = 0;

  // One file at a time, sent as each batch fills. Building the whole corpus
  // first cost 584MB of live strings for 250 files, so a real folder OOMs with
  // a raw V8 abort no handler can catch, and an interrupt during that silent
  // phase threw away every minute of extraction. Peak memory here is one batch.
  const prepareOne = async (f) => {
    const r = await prepare(f, { sourceName, ocr: ocrCallback });
    if (r.note) notes.push({ path: f.rel, note: r.note });

    // A multi-document producer (a WhatsApp export, an SMS Backup & Restore
    // .xml, a Google Voice Takeout page, each sessionized into many
    // conversation documents from one file) has no single envelope identity to
    // key state on, so the file's own path is the state key. Every other branch
    // below is unchanged from the single-envelope path; this only widens what
    // "one prepared unit" is allowed to mean.
    if (r.envelopes) {
      const key = String(f.rel).split(sep).join("/");
      if (!scannerPolicyChanged && r.hash && state.done[key] === r.hash) {
        recordAcceptedDocumentState(state, {
          stateKey: key,
          hash: r.hash,
          skipKeys: [f.rel, ...r.envelopes.map((e) => e.source_id)],
          legacyPartRoot: f.rel,
          protectedSkipKeys: protectedLocalSkipKeys,
        });
        unchanged++;
        return { unchanged: true };
      }
      const sanitized = r.envelopes.map((e) => sanitizeIngestEnvelope(e));
      // One refused document is treated as a whole-file refusal rather than
      // partially loading the rest. This is the same conservative posture as
      // every other credential-gate refusal in this tool: nothing half-loads
      // from a source that just tripped the scanner.
      for (const envelope of sanitized) {
        const refusal = credentialRefusalOf(envelope, scannerOn);
        if (refusal) {
          const skip = { path: safeIngestDisplay(envelope.title, f.rel), reason: refusal.reason };
          recordLocalSkippedDocumentState(state, {
            stateKey: key, nativePath: f.rel, reason: refusal.reason,
          });
          intentionalRemovalKeys.add(key);
          return { skip };
        }
      }
      return {
        hash: r.hash,
        envelopes: sanitized,
        rel: f.rel,
        stateKey: key,
        deferState: true,
        familyPlan: {
          stateKey: key,
          hash: r.hash,
          expectedParts: sanitized.length,
          // The family uid the documents themselves declare, and the doc_uids
          // the brain will actually store. Both used to be built from
          // `sourceName` and the file path, which is neither the namespace nor
          // the identity a session document is stored under, so a fully
          // successful ingest ended in a rejected cleanup. See
          // declaredFamilyUid above for the options and the reasoning.
          base_doc_uid: declaredFamilyUid(sanitized, { rel: f.rel }),
          keep_doc_uids: sanitized.map((envelope) => `${envelope.source_type}:${envelope.source_id}`),
          skipKeys: [key, f.rel, ...sanitized.map((envelope) => envelope.source_id)],
          legacyPartRoot: [key, f.rel],
        },
      };
    }

    const key = r.envelope ? r.envelope.source_id : String(f.rel).split(sep).join("/");
    if (!scannerPolicyChanged && r.hash && state.done[key] === r.hash) {
      recordAcceptedDocumentState(state, {
        stateKey: key,
        hash: r.hash,
        skipKeys: [r.envelope?.source_id, f.rel],
        legacyPartRoot: [r.envelope?.source_id, f.rel],
        protectedSkipKeys: protectedLocalSkipKeys,
      });
      unchanged++;
      return { unchanged: true };
    }
    if (r.skip) {
      recordLocalSkippedDocumentState(state, {
        stateKey: key, nativePath: f.rel, reason: r.skip.reason,
      });
      if (scannerPolicyChanged && previouslyKnownKeys.has(key)) scannerRescanSkips.push(r.skip);
      return { skip: r.skip };
    }
    const envelope = sanitizeIngestEnvelope(r.envelope);
    const refusal = credentialRefusalOf(envelope, scannerOn);
    if (refusal) {
      const skip = { path: safeIngestDisplay(envelope.title, f.rel), reason: refusal.reason };
      recordLocalSkippedDocumentState(state, {
        stateKey: key, nativePath: f.rel, reason: refusal.reason,
      });
      intentionalRemovalKeys.add(key);
      return { skip };
    }
    const envelopes = splitOversized(envelope);
    return {
      hash: r.hash,
      envelopes,
      rel: f.rel,
      stateKey: key,
      deferState: true,
      familyPlan: {
        stateKey: key,
        hash: r.hash,
        expectedParts: envelopes.length,
        base_doc_uid: `${sourceName}:${key}`,
        keep_doc_uids: envelopes.map((envelope) => `${sourceName}:${envelope.source_id}`),
        skipKeys: [key, f.rel, ...envelopes.map((envelope) => envelope.source_id)],
        legacyPartRoot: [key, f.rel],
      },
    };
  };

  if (flags["dry-run"]) {
    // A dry run streams too, so it exercises the same code path rather than a
    // parallel one that could quietly diverge.
    const preview = [];
    for await (const group of batchStream(limited, prepareOne, {
      onSkip: (sk) => skips.push(sk),
      onProgress: (n) => { if (n % 250 === 0) process.stdout.write(`\r  scanned ${n}/${limited.length}...   `); },
    })) {
      for (const item of group) if (preview.length < 5) preview.push(item);
      scanned += group.length;
    }
    process.stdout.write("\r");
    await applyDriveRemovals({
      uids: [...new Set([...privateRemovalKeys, ...intentionalRemovalKeys])].map((key) => `${sourceName}:${key}`),
      base, adminKey, state, dryRun: true, label: "local source truth",
    });
    await applyDriveRemovals({
      uids: vanishedRemovalKeys.map((key) => `${sourceName}:${key}`),
      base, adminKey, state, dryRun: true, label: "Drive deletion",
    });
    info(`${scanned} document(s) would be sent; ${unchanged} unchanged; ${skips.length} skipped`);
    reportNotes(notes);
    console.log("");
    ok("dry run, nothing was sent");
    await reportSkips(skips);
    if (preview.length) {
      console.log(`\n  first few that WOULD be sent:`);
      for (const r of preview) {
        const d = r.envelope.occurred_at ? r.envelope.occurred_at.slice(0, 10) : "no date";
        console.log(`    ${r.rel}  (${d}, ${r.envelope.content.length} chars)`);
      }
    }
    // dry_run is stated on the returned shape rather than left to be inferred
    // from a zero, so a sweep reporting this leg can never call a preview a load.
    return { dry_run: true, would_send: scanned, unchanged, skipped: skips.length };
  }

  // Routine ingest is a data-plane operation. Once setup has saved the live
  // Worker URL, recording source health must use the brain admin key instead
  // of silently requiring a standing Cloudflare control-plane token.
  const sourceRunId = `sync_${randomBytes(16).toString("hex")}`;
  const sourceRunStartedAt = new Date().toISOString();
  let sourceRunClosed = false;
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  await postSourceReceipt(base, adminKey, {
    source: sourceName,
    kind: "upload",
    status: "indexing",
    run_id: sourceRunId,
    lane: "manual",
    started_at: sourceRunStartedAt,
    detail: "local folder ingest started",
  });

  try {

  const pendingLocalUids = Object.keys(state.removed || {});
  if (pendingLocalUids.some((uid) => !uid.startsWith(`${sourceName}:`))) {
    throw new Error("the local removal retry state contains a document outside this source");
  }

  const familyPlans = new Map();
  const sentFamilyParts = new Map();
  const acceptedFamilyParts = new Map();
  const rejectedFamilyParts = new Map();
  let batchNo = 0;
  for await (const group of batchStream(limited, prepareOne, {
    onSkip: (sk) => skips.push(sk),
    onProgress: (n) => {
      scanned = n;
      if (n % 100 === 0) process.stdout.write(`\r  scanned ${n}/${limited.length}, sent ${tally.created + tally.updated}   `);
    },
  })) {
    batchNo++;
    for (const item of group) if (item.familyPlan) familyPlans.set(item.familyPlan.stateKey, item.familyPlan);
    let t;
    try {
      t = await sendBatches({
        base, adminKey, groups: [group], state, statePath, skips, quiet: true,
        onResult: (item, result) => {
          const key = item.familyPlan?.stateKey;
          if (!key) return;
          if (["created", "updated", "unchanged"].includes(result.status)) {
            acceptedFamilyParts.set(key, (acceptedFamilyParts.get(key) || 0) + 1);
          } else {
            const statuses = rejectedFamilyParts.get(key) || [];
            statuses.push(result.status);
            rejectedFamilyParts.set(key, statuses);
          }
        },
      });
    } catch (error) {
      // A storage failure PRESERVES the prior family and its retry. This used
      // to send an empty keep list for every family the failed batch touched,
      // which is not a cleanup instruction, it is "delete this whole family".
      // That was inert while a message-export base matched nothing, and became
      // destructive the moment families were keyed correctly: one failed
      // session could take every already-stored conversation from that file
      // with it. remoteFamilySettlement states the correct rule and the remote
      // path follows it; the local path now agrees. The cursor is not advanced
      // on this path, so the retry re-sends and reconciles for real.
      throw error;
    }
    for (const k of Object.keys(tally)) tally[k] += t[k] || 0;
    for (const item of group) {
      const key = item.familyPlan?.stateKey;
      if (key) sentFamilyParts.set(key, (sentFamilyParts.get(key) || 0) + 1);
    }
    const outcome = remoteFamilyOutcomes(familyPlans.values(), sentFamilyParts, acceptedFamilyParts);
    // Only a FULLY ACCEPTED replacement may remove obsolete family members.
    // An incomplete family is a storage failure, not a deletion instruction:
    // emitting an empty keep list for it would delete every part that DID
    // land. Its state key is cleared below, so the next run re-sends it.
    const reconciliation = outcome.completed.map(
      (plan) => ({ base_doc_uid: plan.base_doc_uid, keep_doc_uids: plan.keep_doc_uids }),
    );
    if (reconciliation.length) await reconcileDocumentFamilies({ families: reconciliation, base, adminKey });
    for (const plan of outcome.completed) {
      recordAcceptedDocumentState(state, { ...plan, protectedSkipKeys: protectedLocalSkipKeys });
    }
    for (const plan of outcome.incomplete) {
      delete state.done[plan.stateKey];
      const statuses = [...new Set(rejectedFamilyParts.get(plan.stateKey) || ["failed"])];
      state.skipped[plan.stateKey] = `logical document was not indexed because part status was ${statuses.join(", ")}`;
    }
    for (const plan of [...outcome.completed, ...outcome.incomplete]) {
      familyPlans.delete(plan.stateKey);
      sentFamilyParts.delete(plan.stateKey);
      acceptedFamilyParts.delete(plan.stateKey);
      rejectedFamilyParts.delete(plan.stateKey);
    }
    if (outcome.completed.length || outcome.incomplete.length) saveState(statePath, state);
    process.stdout.write(`\r  batch ${batchNo}  loaded ${tally.created + tally.updated}  refused ${tally.refused}  failed ${tally.failed}   `);
  }
  process.stdout.write("\n");
  reportNotes(notes);

  // ONE decision covering every reason this source has to remove something,
  // through the SAME aggregate guard the Drive lane uses. No removal call is
  // allowed above this assertion.
  //
  // The stored set comes from the authenticated Worker, not this machine's
  // resume file. A restored or copied state file may be stale in either
  // direction; using it as deletion truth can shrink the denominator or hide
  // a family that exists in D1. This matters most for the unattended folder
  // lane, where a missing File Provider mount can otherwise look like the
  // owner deleted everything.
  const storedLocalFamilies = await listStoredSourceFamilies({
    base, adminKey, source: sourceName,
  });
  const localRemovalPlan = buildDriveRemovalPlan({
    storedFamilies: storedLocalFamilies,
    activeFamilies: [...protectedLocalSkipKeys].map((key) => `${sourceName}:${key}`),
    policyCandidates: privateRemovalKeys.map((key) => `${sourceName}:${key}`),
    // A lost deletion response is re-planned against current authenticated
    // truth. Restoration wins for this category, while a still-current policy
    // or intentional refusal is assigned to its earlier, stronger category.
    vanishedCandidates: [
      ...vanishedRemovalKeys.map((key) => `${sourceName}:${key}`),
      ...pendingLocalUids,
    ],
    intentionalCandidates: [...intentionalRemovalKeys].map((key) => `${sourceName}:${key}`),
  });
  assertDriveRemovalPlanSafe(localRemovalPlan, localRemovalApproval);
  if (localRemovalPlan.total) {
    const percent = (localRemovalPlan.ratio * 100).toFixed(1);
    const disposition = localRemovalPlan.tooLarge ? "approved" : "within the unattended safety limits";
    info(`folder cleanup plan ${disposition}: ${localRemovalPlan.total} of ${localRemovalPlan.stored} loaded documents (${percent}%)`);
  }

  // Only the exact targets intersected with authenticated storage and covered
  // by the approval fingerprint may reach the destructive endpoint.
  const localTruthTargets = [
    ...localRemovalPlan.targets.source_policy,
    ...localRemovalPlan.targets.intentional_skip,
  ];
  const localRemoval = await applyDriveRemovals({
    uids: localTruthTargets,
    base, adminKey, state, dryRun: false, label: "local source truth",
  });
  saveState(statePath, state);
  assertNoPendingRemovals(localRemoval, "local source truth removal");

  const vanishedTargets = localRemovalPlan.targets.source_deleted;
  if (vanishedTargets.length) {
    const vanishedRemoval = await applyDriveRemovals({
      uids: vanishedTargets, base, adminKey, state, dryRun: false, label: "Drive deletion",
    });
    saveState(statePath, state);
    assertNoPendingRemovals(vanishedRemoval, "deleted local file removal");
    if (vanishedRemoval.applied) ok(`${vanishedRemoval.applied} document(s) removed because their file is gone from the folder`);
  }

  // An accepted HTTP receipt is necessary but not sufficient deletion proof.
  // Read the authenticated inventory again before advancing local resume state.
  // If a lost or malformed backend write left a family present, preserve a
  // retry marker and fail the run instead of recording a clean source.
  const plannedLocalTargets = [...new Set([...localTruthTargets, ...vanishedTargets])];
  if (plannedLocalTargets.length) {
    const afterLocalRemoval = await listStoredSourceFamilies({
      base, adminKey, source: sourceName,
    });
    const stillStored = plannedLocalTargets.filter((uid) => afterLocalRemoval.has(uid));
    if (stillStored.length) {
      const failedAt = new Date().toISOString();
      state.removed = {
        ...(state.removed || {}),
        ...Object.fromEntries(stillStored.map((uid) => [uid, failedAt])),
      };
      saveState(statePath, state);
      throw new Error(
        `${stillStored.length} planned local folder removal(s) remained after exact source-inventory readback. ` +
          "No completed source state was recorded; re-running will retry them through the same approval gate."
      );
    }
    for (const uid of plannedLocalTargets) {
      delete state.done[uid.slice(sourceName.length + 1)];
      if (state.removed) delete state.removed[uid];
    }
    saveState(statePath, state);
  }

  if (scannerRescanSkips.length) {
    saveState(statePath, state);
    await postSourceReceipt(base, adminKey, {
      source: sourceName,
      kind: "upload",
      status: "error",
      run_id: sourceRunId,
      lane: "manual",
      started_at: sourceRunStartedAt,
      completed_at: new Date().toISOString(),
      walk_complete: false,
      files_seen: scanned,
      docs_added: tally.created,
      docs_updated: tally.updated,
      docs_unchanged: unchanged + tally.unchanged,
      error: `${scannerRescanSkips.length} previously-indexed file(s) could not be rechecked by the current credential scanner`,
      detail: `local folder ingest stopped during credential recheck; skipped=${skips.length}`,
    });
    sourceRunClosed = true;
    die(
      `${scannerRescanSkips.length} previously-indexed file(s) could not be rechecked by the current credential scanner.\n` +
        "      Their prior revision was preserved, and the scanner upgrade was not marked complete. Fix the reported files and re-run."
    );
  }

  state.credential_scanner_fingerprint = scannerFingerprint;
  saveState(statePath, state);

  const finalStatus = tally.failed ? "error" : "ready";
  await postSourceReceipt(base, adminKey, {
    source: sourceName,
    kind: "upload",
    status: finalStatus,
    run_id: sourceRunId,
    lane: "manual",
    started_at: sourceRunStartedAt,
    completed_at: new Date().toISOString(),
    walk_complete: tally.failed === 0,
    files_seen: scanned,
    docs_added: tally.created,
    docs_updated: tally.updated,
    docs_unchanged: unchanged + tally.unchanged,
    detail: `local folder ingest ${finalStatus === "ready" ? "completed" : "completed with document failures"}; skipped=${skips.length}`,
    ...(tally.failed ? { error: `${tally.failed} document(s) failed` } : {}),
  });
  sourceRunClosed = true;

  const summary = `${tally.created} created, ${tally.updated} updated, ${unchanged + tally.unchanged} unchanged`;
  if (tally.failed) info(summary);
  else ok(summary);
  if (tally.refused) warn(`${tally.refused} file(s) refused for carrying live credentials. They were NOT indexed.`);
  await reportSkips(skips);

  info(`progress saved to ${relative(process.cwd(), statePath)}`);
  assertNoIngestFailures(tally);
  await reportBacklog(manifestPath);
  // Returned only so a caller that ran this as one leg of a wider sweep can
  // report a real count instead of "unknown". Reached only after
  // assertNoIngestFailures, so these numbers describe a completed load.
  return {
    created: tally.created,
    updated: tally.updated,
    unchanged: unchanged + tally.unchanged,
    refused: tally.refused,
    scanned,
    skipped: skips.length,
  };
  } catch (error) {
    // Do not leave a source looking perpetually "indexing" when extraction,
    // transport, reconciliation, or the final acceptance check aborts. The
    // original failure remains authoritative even if this best-effort receipt
    // cannot be written.
    if (!sourceRunClosed) {
      try {
        await postSourceReceipt(base, adminKey, {
          source: sourceName,
          kind: "upload",
          status: "error",
          run_id: sourceRunId,
          lane: "manual",
          started_at: sourceRunStartedAt,
          completed_at: new Date().toISOString(),
          walk_complete: false,
          files_seen: scanned,
          docs_added: tally.created,
          docs_updated: tally.updated,
          docs_unchanged: unchanged + tally.unchanged,
          error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 500),
          detail: "local folder ingest aborted before completion",
        });
        sourceRunClosed = true;
      } catch (receiptError) {
        warn(`the ingest failed and its error receipt could not be recorded: ${String(receiptError?.message || receiptError).slice(0, 160)}`);
      }
    }
    throw error;
  }
}

/** A destructive response is trusted only when it proves it is the forget API. */
export function validateForgetReceipt(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("the forget response is not a JSON object");
  }
  if (body.dry_run !== false) throw new Error("the forget response did not confirm a real deletion");
  for (const field of ["documents", "chunks", "vectors"]) {
    if (!Number.isFinite(Number(body[field])) || Number(body[field]) < 0) {
      throw new Error(`the forget response has no valid ${field} count`);
    }
  }
  if (!Array.isArray(body.targets)) throw new Error("the forget response has no targets array");
  return body;
}

async function parseForgetResponse(res) {
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* validated below */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error || raw.slice(0, 160) || "forget failed"}`);
  try {
    return validateForgetReceipt(body);
  } catch (error) {
    throw new Error(`${error.message}; received HTTP ${res.status}`);
  }
}

export function assertNoPendingRemovals(result, label = "source deletion") {
  if (Number(result?.pending || 0) > 0) {
    throw new Error(
      `${result.pending} ${label}(s) could not be confirmed. The source cursor was not advanced; re-run to retry them.`
    );
  }
  return result;
}

/** Read every live logical document uid for one source from the data plane. */
export async function listStoredSourceFamilies({ base, adminKey, source }) {
  const normalizedSource = assertSourceName(source);
  const families = new Set();
  const seenCursors = new Set();
  let cursor = "";
  for (;;) {
    if (seenCursors.has(cursor)) throw new Error("source-family inventory repeated a cursor");
    seenCursors.add(cursor);
    const res = await http(`${base}/api/admin/brain/source-families`, {
      method: "POST",
      redirect: "error",
      headers: {
        "X-Admin-Key": adminKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: normalizedSource,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      }),
    }, { what: "the source-family inventory" });
    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* validated below */ }
    if (!res.ok || !body || body.source !== normalizedSource || !Array.isArray(body.families)) {
      throw new Error(
        `source-family inventory was not accepted (${res.status}): ${body?.error || raw.slice(0, 160) || "invalid response"}`
      );
    }
    if (body.families.length > 1000) {
      throw new Error("source-family inventory exceeded its requested page size");
    }
    let previous = cursor;
    for (const uid of body.families) {
      if (typeof uid !== "string" || !uid.startsWith(`${normalizedSource}:`)) {
        throw new Error("source-family inventory returned an invalid document uid");
      }
      if (uid <= previous) {
        throw new Error("source-family inventory was not strictly ordered");
      }
      families.add(uid);
      previous = uid;
    }
    if (body.next_cursor === null) return families;
    if (typeof body.next_cursor !== "string" || !body.next_cursor.startsWith(`${normalizedSource}:`)) {
      throw new Error("source-family inventory returned an invalid next cursor");
    }
    if (!body.families.length || body.next_cursor !== body.families[body.families.length - 1]) {
      throw new Error("source-family inventory next cursor does not close its returned page");
    }
    cursor = body.next_cursor;
  }
}

/** Apply Drive deletions and policy exclusions in bounded, retryable groups. */
async function applyDriveRemovals({ uids, base, adminKey, state, dryRun, label = "Drive deletion" }) {
  const targets = [...new Set((uids || []).map(String).filter(Boolean))];
  if (!targets.length) return { applied: 0, pending: 0 };
  if (dryRun) {
    const preview = label === "source policy"
      ? "match the exclusion policy and WOULD be removed from the brain"
      : label === "intentional source skip"
        ? "are no longer eligible for indexing and WOULD be removed from the brain"
        : "were removed at the source and WOULD be removed from the brain";
    warn(`${targets.length} file(s) ${preview}`);
    return { applied: 0, pending: 0 };
  }

  let applied = 0;
  let pending = 0;
  // Bound the request and Worker CPU independently from D1's internal batches.
  for (let i = 0; i < targets.length; i += 50) {
    const group = targets.slice(i, i + 50);
    const res = await http(`${base}/api/admin/brain/forget`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      // A Drive file may be stored as one document or as multiple oversized
      // parts. Family deletion reaches both representations.
      body: JSON.stringify({
        families: group.map((baseDocUid) => ({ base_doc_uid: baseDocUid, keep_doc_uids: [] })),
        confirm: true,
      }),
    });
    let out;
    try {
      out = await parseForgetResponse(res);
    } catch {
      state.removed = {
        ...(state.removed || {}),
        ...Object.fromEntries(group.map((uid) => [uid, new Date().toISOString()])),
      };
      pending += group.length;
      continue;
    }
    for (const uid of group) {
      delete state.done[uid];
      if (state.removed) delete state.removed[uid];
    }
    applied += Number(out.documents || 0);
  }
  if (pending) warn(`${pending} ${label}(s) could not be applied and were recorded for the next run`);
  return { applied, pending };
}

/** Remove obsolete oversized parts only after every replacement part landed. */
async function reconcileDocumentFamilies({ families, base, adminKey }) {
  let removed = 0;
  for (let i = 0; i < families.length; i += 50) {
    const group = families.slice(i, i + 50);
    const res = await http(`${base}/api/admin/brain/forget`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ families: group, confirm: true }),
    });
    let out;
    try {
      out = await parseForgetResponse(res);
    } catch (error) {
      die(
        `Drive split-document cleanup failed (${res.status}): ${error.message}. The sync cursor was not advanced.\n` +
        "      Re-running the same ingest is safe and will retry the cleanup."
      );
    }
    removed += Number(out.documents || 0);
  }
  return removed;
}

/**
 * A limited Drive walk cannot save a source cursor safely. A full listing and
 * listChanges() both return a cursor for the COMPLETE result window; slicing
 * that result on the client and saving its cursor permanently skips everything
 * beyond the slice. Previewing is safe because a dry run saves no cursor.
 */
export function assertRemoteLimitSafe({ source = "Drive", limit = Infinity, dryRun = false, incremental = false } = {}) {
  if (Number.isFinite(limit) && !dryRun) {
    die(
      `--limit cannot be used on a real ${incremental ? "incremental" : "full"} ${source} sync. The cursor this saves` + "\n" +
        "      (a Drive sync token, a Gmail history marker, an IMAP UID watermark) covers the complete result window, so" + "\n" +
        "      saving it after a client-side limit would permanently skip every remaining item. Remove --limit for the real" + "\n" +
        "      run. A limited --dry-run is safe."
    );
  }
  return true;
}

export function assertDriveLimitSafe(options = {}) {
  return assertRemoteLimitSafe({ source: "Drive", ...options });
}

/** Post one idempotent connector lifecycle receipt through the installed brain itself. */
export async function postSourceReceipt(base, adminKey, receipt, request = http, {
  attempts = 5,
  delayMs = 2_000,
  maxDelayMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
} = {}) {
  const url = `${base}/api/admin/brain/source-receipt`;
  let res, raw;
  try {
    ({ res, raw } = await retryTransient(async () => {
      let response;
      try {
        response = await request(url, {
          method: "POST",
          headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
          body: JSON.stringify(receipt),
        }, { timeoutMs: 30_000, what: "the source freshness receipt" });
      } catch (error) {
        if (typeof error?.retryable === "boolean") throw error;
        throw translatedHttpFailure(error, url, { timeoutMs: 30_000, what: "the source freshness receipt" });
      }
      let responseRaw;
      try {
        responseRaw = await response.text();
      } catch (error) {
        const translated = translatedHttpFailure(error, url, {
          timeoutMs: 30_000,
          what: "the source freshness receipt response",
        });
        if (!response.ok && !isRetryableHttpStatus(response.status)) translated.retryable = false;
        throw translated;
      }
      const result = { res: response, raw: responseRaw };
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableHttpResponse(result, "the source freshness receipt");
      }
      return result;
    }, {
      attempts,
      delayMs,
      maxDelayMs,
      sleep,
      shouldRetry: (error) => error?.retryable === true,
      onRetry,
    }));
  } catch (error) {
    if (error instanceof RetryableHttpResponse) ({ res, raw } = error.result);
    else throw error;
  }
  let body = null;
  try { body = JSON.parse(raw); } catch { /* checked below */ }
  const identityMatches = body?.source === receipt.source &&
    (!receipt.run_id || body?.run_id === receipt.run_id);
  if (!res.ok || !body || body.status !== receipt.status || !identityMatches) {
    throw new Error(
      `source freshness receipt was not accepted (${res.status}): ${body?.error || raw.slice(0, 160) || "invalid response"}`
    );
  }
  return body;
}

/** Set or clear the freshness expectation owned by an installed scheduler. */
export async function postSourceExpectation(base, adminKey, {
  source,
  kind = "drive",
  expected_refresh_seconds,
}, request = http) {
  const normalizedSource = assertSourceName(source);
  const res = await request(`${base}/api/admin/brain/source-expectation`, {
    method: "POST",
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
    body: JSON.stringify({ source: normalizedSource, kind, expected_refresh_seconds }),
  }, { timeoutMs: 30_000, what: "the source freshness expectation" });
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* checked below */ }
  if (!res.ok || !body || body.source !== normalizedSource ||
      body.expected_refresh_seconds !== expected_refresh_seconds) {
    throw new Error(
      `source freshness expectation was not accepted (${res.status}): ${body?.error || raw.slice(0, 160) || "invalid response"}`
    );
  }
  return body;
}


/**
 * Calendar's local sync-token state, one small JSON object keyed by calendar.
 *
 * Deliberately NOT ingest/run.mjs's loadState/saveState: that pair's loader
 * resets to the local-folder shape ({version, done, skipped}) whenever the
 * loaded object has no `.done` key, which every calendar state file would
 * trip on every single run. A calendar sync token is a different shape
 * entirely (per-calendar {syncToken, paramFingerprint, ...}), so it gets its
 * own tiny, equally atomic reader/writer rather than forcing a shape it does
 * not have through a loader built for a different shape.
 */
function loadCalendarState(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt state file must not abort a sync. Starting over (full resync
    // of every configured calendar) costs time; refusing to run costs the
    // whole load.
    return {};
  }
}

function saveCalendarState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* original error wins */ }
    throw error;
  }
}

/**
 * `brain ingest <manifest> --from calendar`.
 *
 * WHY THIS EXISTS: connectors/google-calendar.mjs was fully built and
 * covered by 223 tests of its own internal functions, but nothing anywhere
 * in this file ever called syncAll() or ingestEnvelopes() — there was no
 * command that could actually run it. `brain connect google --scopes
 * calendar` could request the OAuth scope, but the next step did not exist.
 * Found during the WP-04 matrix truth pass (2026-08-27): the source matrix
 * said "designed, not written", which was ALSO wrong, just in the opposite
 * direction — the code was written and tested, it was simply never wired to
 * a runnable command. Neither status was true; this closes that gap.
 *
 * Deliberately its own function rather than a third branch inside
 * cmdIngestRemote: the calendar connector already carries its own complete
 * sync-then-send pipeline (syncAll returns finished envelopes AND deletions;
 * ingestEnvelopes sends them, one at a time, so a single refused event never
 * aborts the rest). Bolting that onto cmdIngestRemote's batchStream/
 * family-plan machinery, built for a very different shape (files that must
 * be split and batched), would risk the well-tested Drive and Gmail paths
 * for no real gain. Reuse where it fits (postSourceReceipt for `brain
 * sources` visibility, applyDriveRemovals for cancelled-event cleanup);
 * write new code only for what is actually new (the sync-token state file).
 */
export async function cmdIngestCalendar(m, manifestPath, flags, options = {}) {
  const sourceName = assertSourceName(flags.source === true || !flags.source ? "calendar" : flags.source);
  const dry = !!flags["dry-run"];
  const resolveIngestAccount = options.resolveAccount ?? resolveAccount;
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const acct = dry ? null : m.brain?.domain ? null : await resolveIngestAccount(m);
  const base = dry ? null : await resolveBase(m, acct);
  const adminKey = dry ? null : resolveKey(manifestPath);
  if (!adminKey && !dry) {
    die(
      "no durable admin key was found. Re-run `brain setup <manifest>` to generate and persist one; " +
        "do not paste the key into a shell command."
    );
  }

  const { syncAll, ingestEnvelopes } = options.googleCalendar ?? await import("./connectors/google-calendar.mjs");
  const getToken = options.getAccessToken ?? googleAuth("calendar");
  const postReceipt = options.postSourceReceipt ?? postSourceReceipt;
  const removeDocs = options.applyDriveRemovals ?? applyDriveRemovals;
  const loadState = options.loadCalendarState ?? loadCalendarState;
  const saveState = options.saveCalendarState ?? saveCalendarState;
  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);
  const state = flags.reset ? {} : loadState(statePath);

  const config = m.calendar || {};
  const calendarLabel = (config.calendars?.length ? config.calendars : ["primary"])
    .map((c) => (typeof c === "string" ? c : c.id)).join(", ");
  info(`syncing calendar(s): ${calendarLabel}`);

  const result = await syncAll({
    config, state, getAccessToken: getToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  info(
    `${result.summary.events_seen} event(s) seen across ${result.summary.calendars_ok}/${result.calendars.length} calendar(s); ` +
      `${result.documents.length} to upsert, ${result.deletions.length} cancelled, ${result.summary.skipped} skipped`
  );
  for (const cal of result.calendars) {
    if (cal.error) warn(`${cal.calendar_key}: ${cal.error.message}`);
  }
  if (result.summary.needs_reconsent) {
    warn(
      "Google refused the calendar refresh token (it is dead: revoked, expired from six months of " +
        "non-use, or the OAuth app is still in Testing and issued a seven-day token). Reconnect with " +
        "`brain connect google --scopes drive,gmail,calendar` before running this again. " +
        "Calendars synced before the failure were still saved below."
    );
  }

  if (dry) {
    const previewFailures = result.calendars.filter((calendar) => calendar.error);
    const previewSummary = `dry run: ${result.documents.length} event(s) would be sent, ${result.deletions.length} cancellation(s) would be removed`;
    if (previewFailures.length) warn(`Calendar preview incomplete: ${previewSummary}`);
    else ok(previewSummary);
    if (result.documents.length) {
      console.log("\n  first few that WOULD be sent:");
      for (const envelope of result.documents.slice(0, 5)) {
        console.log(`    ${envelope.title}  (${envelope.occurred_at || "no date"})`);
      }
    }
    if (previewFailures.length) {
      die(
        `Calendar preview incomplete: ${previewFailures.length} of ${result.calendars.length} calendar(s) could not be read. ` +
          (result.summary.needs_reconsent
            ? "Reconnect with `brain connect google --scopes drive,gmail,calendar`, then retry the preview."
            : "Fix the calendar errors printed above, then retry the preview."),
      );
    }
    return {
      ...result,
      dry_run: true,
      would_send: result.documents.length,
      unchanged: 0,
      skipped: result.summary.skipped,
    };
  }

  const runId = `sync_${randomBytes(16).toString("hex")}`;
  const startedAt = new Date().toISOString();
  await postReceipt(base, adminKey, {
    source: sourceName, kind: "calendar", status: "indexing",
    run_id: runId, lane: "manual", started_at: startedAt,
    detail: `calendar sync started: ${calendarLabel}`,
  });

  // The connector library uses `calendar_event` when exercised on its own,
  // but the runnable command owns an operator-selectable source namespace.
  // Store rows in that namespace so source receipts, freshness counts,
  // `brain forget --source`, and custom `--source` names all describe the
  // same documents. Gmail, Drive, and the message commands follow this same
  // boundary rule.
  const sourceEnvelopes = result.documents.map((envelope) => ({
    ...envelope,
    source_type: sourceName,
  }));
  const sent = await ingestEnvelopes({ baseUrl: base, adminKey, envelopes: sourceEnvelopes });

  let removed = 0;
  let removalPending = 0;
  if (result.deletions.length) {
    const uids = result.deletions.map((d) => `${sourceName}:${d.source_id}`);
    const removal = await removeDocs({
      uids, base, adminKey, state: { done: {}, removed: {} }, dryRun: false, label: "calendar cancellation",
    });
    removed = removal.applied;
    removalPending = removal.pending;
  }

  // Provider-level partial failure is tracked per calendar in result.state, so
  // successful sibling calendars may keep their progress. A document send,
  // credential refusal, or cancellation-cleanup failure is different: it
  // happened AFTER Google issued the new sync token. Saving that token would
  // permanently skip the unaccepted event or cancellation on the next run.
  // Withhold the whole state update in that case. Replaying the old window is
  // idempotent and is the only safe retry boundary.
  const deliveryIncomplete = sent.errors.length > 0 || sent.refused.length > 0 || removalPending > 0;
  if (deliveryIncomplete) {
    warn("Calendar sync state was not advanced because not every event and cancellation was accepted. Re-running retries the same Google window.");
  } else {
    saveState(statePath, result.state);
  }

  const finalStatus = deliveryIncomplete || result.summary.needs_reconsent ? "error" : "ready";
  const incompleteReason = [
    sent.errors.length ? `${sent.errors.length} event send(s) failed` : null,
    sent.refused.length ? `${sent.refused.length} event(s) were refused` : null,
    removalPending ? `${removalPending} cancellation removal(s) remain pending` : null,
    result.summary.needs_reconsent ? "one or more calendars need Google reconsent" : null,
  ].filter(Boolean).join("; ");
  await postReceipt(base, adminKey, {
    source: sourceName, kind: "calendar", status: finalStatus,
    run_id: runId, lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
    docs_added: sent.created, docs_updated: sent.updated, docs_unchanged: sent.unchanged,
    detail: `calendar sync: ${sent.created} created, ${sent.updated} updated, ${sent.unchanged} unchanged, ` +
      `${sent.refused.length} refused, ${sent.errors.length} failed, ${removed} removed, ${removalPending} removal(s) pending`,
    ...(finalStatus === "error" ? { error: incompleteReason || "calendar sync incomplete" } : {}),
  });

  const calendarSummary = `${sent.created} created, ${sent.updated} updated, ${sent.unchanged} unchanged, ${removed} cancellation(s) removed`;
  if (finalStatus === "ready") ok(calendarSummary);
  else warn(`Calendar sync incomplete: ${calendarSummary}`);
  if (sent.refused.length) {
    warn(`${sent.refused.length} event(s) refused by the credential gate (a live credential was pasted into an event)`);
  }
  if (sent.errors.length) warn(`${sent.errors.length} event(s) failed to send and will be retried on the next run`);
  if (removalPending) warn(`${removalPending} cancellation removal(s) remain pending and will be retried on the next run`);
  return { result, sent, removed, removalPending };
}

/**
 * `brain ingest <manifest> --from imessage`.
 *
 * One incremental capture pass over the Mac's Messages database: read every
 * row after the watermark, sessionize through the same message-session.mjs
 * every other chat platform uses, and push the closed conversation documents
 * through the shared batch endpoint — which means the worker's credential
 * gate runs on every document exactly as it does for Drive and Gmail.
 *
 * This is both the manual command an operator runs for the initial history
 * load AND the child every scheduled LaunchAgent tick spawns, so the two can
 * never drift apart. Mac-only, stated rather than discovered: chat.db exists
 * on macOS and nowhere else.
 *
 * Like calendar, deliberately its own function rather than a branch inside
 * cmdIngestRemote: the capture core carries its own watermark+snapshot
 * resume state (a different shape from the file-hash state the local walker
 * keeps), and forcing it through batchStream's family-plan machinery built
 * for files would risk the proven Drive/Gmail paths for no gain.
 */
export async function cmdIngestImessage(m, manifestPath, flags, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    die(
      "iMessage capture reads ~/Library/Messages/chat.db, which exists only on macOS.\n" +
        "      There is no Windows or Linux path to live iMessage capture; a one-time load\n" +
        "      from an iPhone backup is the planned route for Mac-less installs."
    );
  }
  const imessage = options.imessage ?? await import("./connectors/imessage.mjs");
  const { batches, splitOversized } = await ingestLib();
  const sourceName = assertSourceName(flags.source === true || !flags.source ? "imessage" : flags.source);
  const dry = !!flags["dry-run"];
  const flushOnly = !!flags["flush-sessions"];
  const chatDbPath = flags["chat-db"] && flags["chat-db"] !== true
    ? resolve(String(flags["chat-db"]))
    : imessage.defaultChatDbPath();

  // Verify access BEFORE resolving credentials, so the walkthrough for a
  // denied Full Disk Access grant is the first thing an operator sees, named
  // as itself — never disguised as a credential or network problem. A
  // flush-only pass reads no chat.db and skips the probe.
  if (!flushOnly) {
    const probe = imessage.probeChatDb(chatDbPath);
    if (!probe.ok) {
      if (probe.reason === "full_disk_access_denied") {
        die(`${probe.message}\n      ${imessage.fdaRemediationSteps().join("\n      ")}`);
      }
      die(probe.message);
    }
  }

  const resolveIngestAccount = options.resolveAccount ?? resolveAccount;
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const acct = dry ? null : m.brain?.domain ? null : await resolveIngestAccount(m);
  const base = dry ? null : await resolveBase(m, acct);
  const adminKey = dry ? null : resolveKey(manifestPath);
  if (!adminKey && !dry) {
    die(
      "no durable admin key was found. Re-run `brain setup <manifest>` to generate and persist one; " +
        "do not paste the key into a shell command."
    );
  }

  const postReceipt = options.postSourceReceipt ?? postSourceReceipt;
  const sendBatch = options.requestIngestBatch ?? requestIngestBatch;
  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);

  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  const sendEnvelopes = async (envelopes) => {
    const docs = envelopes
      // The session envelope's generic "message" source_type becomes THIS
      // load's name, so `brain forget --source imessage` scopes to exactly
      // these documents and `brain sources` counts them under their source.
      .map((envelope) => ({ ...envelope, source_type: sourceName }))
      .flatMap((envelope) => splitOversized(envelope))
      .map((envelope) => ({ envelope }));
    for (const group of batches(docs)) {
      const { res, raw } = await sendBatch({ base, adminKey, docs: group.map((g) => g.envelope) });
      let body = null;
      try { body = JSON.parse(raw); } catch { /* validated below */ }
      if (!res.ok || !body) {
        throw new Error(`the ingest batch failed with ${res.status}: ${String(raw).slice(0, 200)}`);
      }
      const results = validateBatchReceipt(body, group);
      for (const r of results) {
        tally[r.status]++;
        if (r.status === "failed") {
          throw new Error(`the brain reported a document failure for ${r.source_id}: ${r.error || "unknown"}`);
        }
      }
    }
  };

  const runId = `sync_${randomBytes(16).toString("hex")}`;
  const startedAt = new Date().toISOString();
  let receiptOpened = false;
  if (!dry) {
    await postReceipt(base, adminKey, {
      source: sourceName, kind: "imessage", status: "indexing",
      run_id: runId, lane: "manual", started_at: startedAt,
      detail: flushOnly ? "iMessage open-session flush started" : "iMessage capture pass started",
    });
    receiptOpened = true;
  }

  let result;
  try {
    result = await imessage.captureOnce({
      chatDbPath,
      statePath,
      sendEnvelopes,
      ownerLabel: m.client?.display_name || "Owner",
      groupingTimezone: m.client?.timezone || "UTC",
      maxRows: flags.limit ? parseInt(flags.limit, 10) : Infinity,
      flushOnly,
      dryRun: dry,
      reset: !!flags.reset,
      onPage: ({ page, rows, watermark }) => {
        process.stdout.write(`\r  page ${page}: ${rows} row(s), watermark ${watermark}   `);
      },
    });
  } catch (error) {
    if (receiptOpened) {
      try {
        await postReceipt(base, adminKey, {
          source: sourceName, kind: "imessage", status: "error", run_id: runId,
          lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
          error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 500),
          detail: "iMessage capture aborted; the watermark stayed at the last durable page",
        });
      } catch (receiptError) {
        warn(`the capture failed and its error receipt could not be recorded: ${String(receiptError?.message || receiptError).slice(0, 160)}`);
      }
    }
    if (error?.reason === "full_disk_access_denied") {
      die(`${error.message}\n      ${imessage.fdaRemediationSteps().join("\n      ")}`);
    }
    if (error?.reason === "chat_db_missing" || error?.reason === "chat_db_unreadable") die(error.message);
    throw error;
  }
  if (result.pages) process.stdout.write("\n");

  const skipped = result.rows_skipped;
  const summary =
    `${result.rows_seen} new row(s) read in ${result.pages} page(s); ${result.rows_pushed} sessionized; ` +
    `${skipped.no_text} without text (tapbacks/attachments), ${skipped.no_timestamp + skipped.no_guid} unusable; ` +
    `${result.documents_sent} conversation document(s) sent; ${result.sessions_open} session(s) still open; ` +
    `watermark ${result.watermark}`;

  if (dry) {
    info(summary);
    ok("dry run, nothing was sent and no state was saved");
    return { ...result, bounded: !!flags.limit, would_send: result.documents_would_send };
  }

  const bounded = !!flags.limit;
  if (bounded) warn(`--limit ${flags.limit} bounded this capture pass, so it is NOT a complete source load`);

  await postReceipt(base, adminKey, {
    source: sourceName, kind: "imessage", status: "ready",
    run_id: runId, lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
    docs_added: tally.created, docs_updated: tally.updated, docs_unchanged: tally.unchanged,
    detail: `iMessage capture: ${summary}; ${tally.refused} refused`,
    ...(tally.refused ? { refusal_reason: `${tally.refused} conversation document(s) refused by the credential gate` } : {}),
  });

  info(summary);
  const acceptedSummary = `${tally.created} created, ${tally.updated} updated, ${tally.unchanged} unchanged`;
  if (tally.refused || bounded) warn(`iMessage load incomplete: ${acceptedSummary}`);
  else ok(acceptedSummary);
  if (tally.refused) {
    warn(`${tally.refused} conversation document(s) refused by the credential gate (a live credential was texted)`);
  }
  info(`progress saved to ${relative(process.cwd(), statePath)}`);
  return messageIngestionResult({ ...result, bounded }, tally);
}

/**
 * `brain ingest <manifest> --from whatsapp`.
 *
 * One drain pass over the capture daemon's local SQLite outbox: read every row
 * after the cursor, sessionize through the same message-session.mjs every other
 * chat platform uses, and push the closed conversation documents through the
 * shared batch endpoint — so the worker's credential gate runs on every
 * document exactly as it does for Drive and Gmail.
 *
 * This is both the manual command an operator runs and the child every
 * scheduled drain tick spawns, so the two can never drift apart. Unlike the
 * iMessage pass it is NOT platform-gated: reading a SQLite file works
 * anywhere, and an operator who copied an outbox onto another machine should
 * be able to load it. What is macOS-only is installing the capture daemon that
 * writes the outbox in the first place, which `brain connect whatsapp` says
 * plainly.
 */
export async function cmdIngestWhatsapp(m, manifestPath, flags, options = {}) {
  const whatsapp = options.whatsapp ?? await import("./connectors/whatsapp.mjs");
  const { batches, splitOversized } = await ingestLib();
  const sourceName = assertSourceName(flags.source === true || !flags.source ? "whatsapp" : flags.source);
  const dry = !!flags["dry-run"];
  const flushOnly = !!flags["flush-sessions"];
  const outboxPath = flags.outbox && flags.outbox !== true
    ? resolve(String(flags.outbox))
    : whatsapp.outboxPathFor(whatsappDataDir(m, options));

  // Verify the outbox exists BEFORE resolving credentials, so "you have not
  // paired yet" is the first thing an operator sees, named as itself rather
  // than disguised as a credential or network problem. A flush-only pass reads
  // no outbox and skips the probe.
  if (!flushOnly) {
    const probe = whatsapp.probeOutbox(outboxPath);
    if (!probe.ok) die(probe.message);
  }

  const resolveIngestAccount = options.resolveAccount ?? resolveAccount;
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const acct = dry ? null : m.brain?.domain ? null : await resolveIngestAccount(m);
  const base = dry ? null : await resolveBase(m, acct);
  const adminKey = dry ? null : resolveKey(manifestPath);
  if (!adminKey && !dry) {
    die(
      "no durable admin key was found. Re-run `brain setup <manifest>` to generate and persist one; " +
        "do not paste the key into a shell command."
    );
  }

  const postReceipt = options.postSourceReceipt ?? postSourceReceipt;
  const sendBatch = options.requestIngestBatch ?? requestIngestBatch;
  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);

  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  const sendEnvelopes = async (envelopes) => {
    const docs = envelopes
      // The session envelope's generic "message" source_type becomes THIS
      // load's name, so `brain forget --source whatsapp` scopes to exactly
      // these documents and `brain sources` counts them under their source.
      .map((envelope) => ({ ...envelope, source_type: sourceName }))
      .flatMap((envelope) => splitOversized(envelope))
      .map((envelope) => ({ envelope }));
    for (const group of batches(docs)) {
      const { res, raw } = await sendBatch({ base, adminKey, docs: group.map((g) => g.envelope) });
      let body = null;
      try { body = JSON.parse(raw); } catch { /* validated below */ }
      if (!res.ok || !body) {
        throw new Error(`the ingest batch failed with ${res.status}: ${String(raw).slice(0, 200)}`);
      }
      const results = validateBatchReceipt(body, group);
      for (const r of results) {
        tally[r.status]++;
        if (r.status === "failed") {
          throw new Error(`the brain reported a document failure for ${r.source_id}: ${r.error || "unknown"}`);
        }
      }
    }
  };

  const runId = `sync_${randomBytes(16).toString("hex")}`;
  const startedAt = new Date().toISOString();
  let receiptOpened = false;
  if (!dry) {
    await postReceipt(base, adminKey, {
      source: sourceName, kind: "whatsapp", status: "indexing",
      run_id: runId, lane: "manual", started_at: startedAt,
      detail: flushOnly ? "WhatsApp open-session flush started" : "WhatsApp outbox drain started",
    });
    receiptOpened = true;
  }

  let result;
  try {
    result = await whatsapp.drainOnce({
      outboxPath,
      statePath,
      sendEnvelopes,
      ownerLabel: m.client?.display_name || "Owner",
      groupingTimezone: m.client?.timezone || "UTC",
      maxRows: flags.limit ? parseInt(flags.limit, 10) : Infinity,
      flushOnly,
      dryRun: dry,
      reset: !!flags.reset,
      onPage: ({ page, rows, watermark }) => {
        process.stdout.write(`\r  page ${page}: ${rows} row(s), cursor ${watermark}   `);
      },
    });
  } catch (error) {
    if (receiptOpened) {
      try {
        await postReceipt(base, adminKey, {
          source: sourceName, kind: "whatsapp", status: "error", run_id: runId,
          lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
          error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 500),
          detail: "WhatsApp drain aborted; the cursor stayed at the last durable page",
        });
      } catch (receiptError) {
        warn(`the drain failed and its error receipt could not be recorded: ${String(receiptError?.message || receiptError).slice(0, 160)}`);
      }
    }
    if (whatsapp.OUTBOX_ACCESS_REASONS.includes(error?.reason)) die(error.message);
    throw error;
  }
  if (result.pages) process.stdout.write("\n");

  const skipped = result.rows_skipped;
  const summary =
    `${result.rows_seen} new row(s) read in ${result.pages} page(s); ${result.rows_pushed} sessionized; ` +
    `${skipped.media_only} media-only (no text to store), ${skipped.no_text + skipped.no_identity + skipped.no_timestamp} unusable; ` +
    `${result.documents_sent} conversation document(s) sent; ${result.sessions_open} session(s) still open; ` +
    `cursor ${result.watermark}`;

  if (dry) {
    info(summary);
    ok("dry run, nothing was sent and no state was saved");
    return { ...result, bounded: !!flags.limit, would_send: result.documents_would_send };
  }

  const bounded = !!flags.limit;
  if (bounded) warn(`--limit ${flags.limit} bounded this drain pass, so it is NOT a complete source load`);

  await postReceipt(base, adminKey, {
    source: sourceName, kind: "whatsapp", status: "ready",
    run_id: runId, lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
    docs_added: tally.created, docs_updated: tally.updated, docs_unchanged: tally.unchanged,
    detail: `WhatsApp drain: ${summary}; ${tally.refused} refused`,
    ...(tally.refused ? { refusal_reason: `${tally.refused} conversation document(s) refused by the credential gate` } : {}),
  });

  info(summary);
  const acceptedSummary = `${tally.created} created, ${tally.updated} updated, ${tally.unchanged} unchanged`;
  if (tally.refused || bounded) warn(`WhatsApp load incomplete: ${acceptedSummary}`);
  else ok(acceptedSummary);
  if (tally.refused) {
    warn(`${tally.refused} conversation document(s) refused by the credential gate (a live credential was messaged)`);
  }
  if (result.rows_out_of_order) {
    // History-sync chunks arrive on concurrent connections, so an older
    // message can carry a newer outbox position. Sorting fixes it inside a
    // page; across a page boundary one conversation-day can become two
    // documents. Nothing is lost or duplicated, and staying quiet about it
    // would make a thinner-looking thread unexplainable.
    info(`${result.rows_out_of_order} row(s) arrived out of time order across page boundaries (history sync); their conversation may be split across two documents`);
  }
  if (result.outbox_writable === false) {
    warn("the outbox could not be opened for writing, so its drained markers were not updated. The load itself is unaffected; the daemon will keep reporting them as pending.");
  }
  info(`progress saved to ${relative(process.cwd(), statePath)}`);
  return messageIngestionResult({ ...result, bounded }, tally);
}

/** Where this install keeps the capture daemon's data, honoring an override. */
function whatsappDataDir(m, options = {}) {
  if (options.dataDir) return resolve(options.dataDir);
  const configured = m?.operations?.whatsapp_data_dir;
  if (configured) return resolve(String(configured));
  const slug = m?.client?.slug;
  if (!slug) die("the manifest needs a client.slug before WhatsApp capture can place its local data directory.");
  return join(options.home || homedir(), ".brain", "whatsapp", String(slug));
}

/**
 * `brain ingest <manifest> --from iphone-backup`.
 *
 * A ONE-TIME history load out of an unencrypted local iPhone backup. This is
 * the only route by which an owner with no Mac gets their iMessage and SMS
 * history into their brain at all, because Apple exposes live message history
 * to a local process on macOS and nowhere else.
 *
 * It is a snapshot and the command says so out loud, twice: nothing arrives
 * after the load, and the newest message it can possibly hold is the one that
 * existed when that backup was taken. Calling it a connector would be the
 * kind of small lie that costs a client relationship in week three.
 *
 * Runs on Windows and macOS alike — no platform gate, no shelled-out tool, no
 * POSIX-shaped path anywhere in the path it walks. The extraction underneath
 * is literally the live Mac connector's own query and row mapping, so a
 * conversation loaded here and the same conversation captured live produce
 * the same document, keyed the same way, and the second one to arrive is
 * recognised as unchanged rather than duplicated.
 */
export async function cmdIngestIphoneBackup(m, manifestPath, flags, options = {}) {
  const backupLib = options.iphoneBackup ?? await import("./connectors/iphone-backup.mjs");
  const { batches, splitOversized } = await ingestLib();
  const sourceName = assertSourceName(
    flags.source === true || !flags.source ? "iphone-backup" : flags.source
  );
  const dry = !!flags["dry-run"];

  // Resolve and inspect BEFORE any credential or network work, so an owner
  // pointing at the wrong folder — or at an encrypted backup — learns that
  // first, named as itself, instead of watching an admin-key error scroll by.
  let located;
  try {
    const resolved = backupLib.resolveBackupDirectory({
      path: flags.backup && flags.backup !== true ? String(flags.backup) : null,
      home: options.home,
      platform: options.platform ?? process.platform,
      env: options.env ?? process.env,
    });
    located = await backupLib.locateSmsDatabase(resolved.directory);
  } catch (error) {
    if (error?.name === "IphoneBackupError") {
      const remediation = Array.isArray(error.detail) && error.reason === "backup_encrypted"
        ? `\n      ${error.detail.join("\n      ")}`
        : "";
      die(`${error.message}${remediation}`);
    }
    throw error;
  }

  const backup = located.backup;
  const device = [backup.device?.name, backup.device?.ios_version ? `iOS ${backup.device.ios_version}` : null]
    .filter(Boolean).join(", ");
  info(`backup ${backup.directory}${device ? ` (${device})` : ""}`);
  if (backup.backup_taken_at) info(`this backup was taken ${backup.backup_taken_at}`);
  for (const warning of backup.warnings || []) warn(warning);
  info(
    "history only: this is a point-in-time snapshot, not a connection. Nothing new arrives " +
    "after this load. To bring history forward, take a fresh backup and run this again."
  );

  const resolveIngestAccount = options.resolveAccount ?? resolveAccount;
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const acct = dry ? null : m.brain?.domain ? null : await resolveIngestAccount(m);
  const base = dry ? null : await resolveBase(m, acct);
  const adminKey = dry ? null : resolveKey(manifestPath);
  if (!adminKey && !dry) {
    die(
      "no durable admin key was found. Re-run `brain setup <manifest>` to generate and persist one; " +
        "do not paste the key into a shell command."
    );
  }

  const postReceipt = options.postSourceReceipt ?? postSourceReceipt;
  const sendBatch = options.requestIngestBatch ?? requestIngestBatch;

  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  const sendEnvelopes = async (envelopes) => {
    const docs = envelopes
      // The session envelope's generic "message" source_type becomes THIS
      // load's name, so `brain forget --source iphone-backup` scopes to
      // exactly these documents and nothing else.
      .map((envelope) => ({ ...envelope, source_type: sourceName }))
      .flatMap((envelope) => splitOversized(envelope))
      .map((envelope) => ({ envelope }));
    for (const group of batches(docs)) {
      const { res, raw } = await sendBatch({ base, adminKey, docs: group.map((g) => g.envelope) });
      let body = null;
      try { body = JSON.parse(raw); } catch { /* validated below */ }
      if (!res.ok || !body) {
        throw new Error(`the ingest batch failed with ${res.status}: ${String(raw).slice(0, 200)}`);
      }
      const results = validateBatchReceipt(body, group);
      for (const r of results) {
        tally[r.status]++;
        if (r.status === "failed") {
          throw new Error(`the brain reported a document failure for ${r.source_id}: ${r.error || "unknown"}`);
        }
      }
    }
  };

  const runId = `sync_${randomBytes(16).toString("hex")}`;
  const startedAt = new Date().toISOString();
  let receiptOpened = false;
  if (!dry) {
    await postReceipt(base, adminKey, {
      source: sourceName, kind: "iphone-backup", status: "indexing",
      run_id: runId, lane: "manual", started_at: startedAt,
      detail: "iPhone backup history load started",
    });
    receiptOpened = true;
  }

  let result;
  try {
    result = await backupLib.loadBackupHistory({
      located,
      sendEnvelopes,
      ownerLabel: m.client?.display_name || "Owner",
      groupingTimezone: m.client?.timezone || "UTC",
      maxRows: flags.limit ? parseInt(flags.limit, 10) : Infinity,
      dryRun: dry,
      onPage: ({ page, rows }) => {
        process.stdout.write(`\r  page ${page}: ${rows} message row(s) read   `);
      },
    });
  } catch (error) {
    if (receiptOpened) {
      try {
        await postReceipt(base, adminKey, {
          source: sourceName, kind: "iphone-backup", status: "error", run_id: runId,
          lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
          error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 500),
          detail: "iPhone backup history load aborted; re-running re-reads the whole backup safely",
        });
      } catch (receiptError) {
        warn(`the load failed and its error receipt could not be recorded: ${String(receiptError?.message || receiptError).slice(0, 160)}`);
      }
    }
    if (error?.name === "IphoneBackupError") die(error.message);
    throw error;
  }
  if (result.pages) process.stdout.write("\n");

  const skipped = result.rows_skipped;
  const span = result.earliest && result.latest
    ? `${result.earliest.slice(0, 10)} to ${result.latest.slice(0, 10)}`
    : "no dated messages";
  const summary =
    `${result.rows_seen} message row(s) read in ${result.pages} page(s); ${result.rows_pushed} sessionized ` +
    `across ${result.threads} conversation thread(s), ${span}; ` +
    `${skipped.no_text} without text (tapbacks/attachments), ${skipped.no_timestamp + skipped.no_guid} unusable; ` +
    `${result.documents_sent} conversation document(s) sent`;

  if (dry) {
    info(summary);
    ok("dry run, nothing was sent");
    return { ...result, bounded: !!flags.limit, would_send: result.documents_would_send };
  }
  const bounded = !!flags.limit || !!result.truncated;
  if (bounded) warn(`--limit stopped or bounded this load; it is NOT a complete history of the backup`);

  await postReceipt(base, adminKey, {
    source: sourceName, kind: "iphone-backup", status: "ready",
    run_id: runId, lane: "manual", started_at: startedAt, completed_at: new Date().toISOString(),
    docs_added: tally.created, docs_updated: tally.updated, docs_unchanged: tally.unchanged,
    detail: `iPhone backup one-time history load (snapshot, not live capture): ${summary}; ${tally.refused} refused`,
    ...(tally.refused ? { refusal_reason: `${tally.refused} conversation document(s) refused by the credential gate` } : {}),
  });

  info(summary);
  const acceptedSummary = `${tally.created} created, ${tally.updated} updated, ${tally.unchanged} unchanged`;
  if (tally.refused || bounded) warn(`iPhone backup load incomplete: ${acceptedSummary}`);
  else ok(acceptedSummary);
  if (tally.refused) {
    warn(`${tally.refused} conversation document(s) refused by the credential gate (a live credential was texted)`);
  }
  info(`remove this load with: brain forget ${manifestPath} --source ${sourceName}`);
  return messageIngestionResult({ ...result, bounded }, tally);
}


/* --------------------------------------------------------------- brain load */

/**
 * `brain load <manifest>` — one command that means "go through everything this
 * client has, and put it in".
 *
 * WHY THIS EXISTS. Install day used to be seven or more separate ingest
 * commands. The operator had to remember which ones applied to THIS client,
 * run them in an order nobody had written down, and then hold seven separate
 * reports in their head to answer the only question the client actually asks:
 * is my stuff in there now. Every one of those steps was a place to quietly
 * miss a source, and a missed source does not announce itself — it shows up
 * three weeks later as an answer the brain should have had.
 *
 * WHAT IT REFUSES TO DO. It does not keep a cursor of its own. Every source
 * already owns durable resume state (a content-hash map, a Google sync token,
 * a chat.db watermark, an outbox sequence), and a second cursor layered on top
 * would eventually disagree with the first — at which point one of them is
 * lying about what is loaded and there is no way to tell which. Re-running
 * this command IS the resume: each leg resumes itself.
 *
 * ONE SOURCE FAILING DOES NOT STOP THE REST. This is the behaviour the whole
 * command is built around. An operator running this is usually standing next
 * to the client. A dead Gmail token must not be the reason Drive and Calendar
 * never loaded. Every leg is caught, recorded, and the sweep continues; the
 * failures are reported together at the end with what to do about each one.
 *
 * THE REPORT IS THE PRODUCT. What is IN the brain and what is NOT has to be
 * readable at a glance, without inference. A skipped source is never counted
 * as loaded, an unknown count is printed as "unknown" and never as zero, and a
 * source that loaded some documents and then failed says so in those words.
 */

/**
 * The order legs run in, and why it is this order.
 *
 * Cheap and fast first, long bulk last, for a reason that is about the person
 * watching rather than about throughput: the first minutes of a first load are
 * when a client decides whether this thing is real. A sweep that opens with
 * forty silent minutes of Drive extraction and only then prints its first
 * success has spent its best moment on the least interesting source.
 *
 *  10 calendar        Smallest payload in the product. Events are a few lines
 *                     each, the sync is incremental through Google's own token,
 *                     and it usually finishes while the operator is still
 *                     talking. It also answers "who did I meet, and when",
 *                     which reads as magic in a way a folder count does not.
 *  20 imessage        Local SQLite read behind a watermark. No remote API, so
 *  30 whatsapp        nothing here can be rate-limited or refused by a third
 *                     party mid-sweep. A steady-state pass is near-instant; a
 *                     first history load is long but cannot block on anything.
 *  40 upload          The folders the operator pointed at. Local disk, bounded
 *                     by what was chosen, and usually the priority slice the
 *                     client already said would be worth it on its own.
 *  50 gmail           First remote bulk source. Incremental after run one, but
 *                     a first mailbox load is thousands of messages over a
 *                     network we do not control.
 *  60 google_drive    The long pole, deliberately: biggest corpus, slowest
 *                     extraction (PDF, Docs, Sheets, Slides), and the one most
 *                     likely to still be running when everything else is done.
 *                     Everything above it has already reported by then.
 *  70 iphone_backup   Dead last, and not because of size. It is the only leg
 *                     with no cursor: it re-reads the whole backup every time.
 *                     An interrupted sweep should never have to redo it before
 *                     it can reach a source that would have resumed cheaply.
 *
 * Zoom has no number because it has no pull. It posts each new transcript to
 * the brain's own webhook, so there is nothing for a sweep to fetch, and this
 * command says that rather than printing a reassuring green line for work it
 * did not do.
 */

/** Canonical corpus key for whatever an operator actually types. */
export function normalizeLoadKey(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");
  const aliases = {
    drive: "google_drive",
    googledrive: "google_drive",
    google_calendar: "calendar",
    gcal: "calendar",
    mail: "gmail",
    email: "gmail",
    local: "upload",
    folder: "upload",
    folders: "upload",
    files: "upload",
    imessages: "imessage",
    messages: "imessage",
    iphone: "iphone_backup",
    iphonebackup: "iphone_backup",
  };
  return aliases[raw] || raw;
}

/** The folders a manifest declares for the local-upload corpus, normalized. */
export function uploadFoldersOf(corpus) {
  const declared = corpus?.folders ?? corpus?.paths ?? (corpus?.path ? [corpus.path] : []);
  if (!Array.isArray(declared)) {
    throw new Error("corpora.upload.folders must be an array of folder paths");
  }
  return declared.map((entry) => (
    typeof entry === "string" ? { path: entry, source: null } : { path: entry?.path, source: entry?.source || null }
  ));
}

/**
 * Read-only probes of whether a source is CONNECTED on this machine.
 *
 * Deliberately separate from "enabled". Enabled is a claim in the manifest
 * about what this client uses; connected is a fact about this machine right
 * now. Reporting them as one status is how "we loaded everything" gets said
 * about a source whose token died last Tuesday.
 */
export function defaultLoadProbes() {
  let googleCache = null;
  const google = () => {
    if (googleCache) return googleCache;
    try {
      const store = loadTokens()?.google;
      googleCache = { present: !!store?.refresh_token, scopes: Array.isArray(store?.scopes) ? store.scopes : [] };
    } catch (error) {
      googleCache = { present: false, scopes: [], error: String(error?.message || error) };
    }
    return googleCache;
  };
  const googleScope = (scope, connectHint) => () => {
    const state = google();
    if (state.error) {
      return { connected: false, reason: `the stored Google connection could not be read: ${state.error}`, fix: connectHint };
    }
    if (!state.present) return { connected: false, reason: "no Google account is connected on this machine", fix: connectHint };
    if (!state.scopes.includes(scope)) {
      return {
        connected: false,
        reason: `the Google connection on this machine has no "${scope}" scope (it has: ${state.scopes.join(", ") || "none"})`,
        fix: connectHint,
      };
    }
    return { connected: true };
  };
  return {
    google_drive: googleScope("drive", "brain connect google --scopes drive,gmail,calendar"),
    gmail: googleScope("gmail", "brain connect google --scopes drive,gmail,calendar"),
    calendar: googleScope("calendar", "brain connect google --scopes drive,gmail,calendar"),
    imessage: async ({ m, platform }) => {
      if (platform !== "darwin") {
        return {
          connected: false,
          reason: "iMessage history lives in chat.db, which exists only on macOS; this machine is not a Mac",
          fix: "load the history from an unencrypted iPhone backup instead: brain ingest <manifest> --from iphone-backup",
        };
      }
      const imessage = await import("./connectors/imessage.mjs");
      const probe = imessage.probeChatDb(imessage.defaultChatDbPath());
      if (probe.ok) return { connected: true };
      return {
        connected: false,
        reason: probe.message,
        fix: probe.reason === "full_disk_access_denied"
          ? "grant Full Disk Access, then: brain connect imessage <manifest>"
          : "brain connect imessage <manifest>",
      };
    },
    whatsapp: async ({ m, options }) => {
      const whatsapp = await import("./connectors/whatsapp.mjs");
      const probe = whatsapp.probeOutbox(whatsapp.outboxPathFor(whatsappDataDir(m, options)));
      if (probe.ok) return { connected: true };
      return { connected: false, reason: probe.message, fix: "brain connect whatsapp <manifest> --accept-risk" };
    },
    iphone_backup: async ({ m }) => {
      const backupLib = await import("./connectors/iphone-backup.mjs");
      try {
        const configured = m?.corpora?.iphone_backup?.backup_path || null;
        const resolved = backupLib.resolveBackupDirectory({ path: configured ? String(configured) : null });
        await backupLib.locateSmsDatabase(resolved.directory);
        return { connected: true };
      } catch (error) {
        return {
          connected: false,
          reason: String(error?.message || error),
          fix: "point at the backup explicitly: brain ingest <manifest> --from iphone-backup --backup <folder>",
        };
      }
    },
  };
}

/**
 * The capability table: which manifest corpus keys this build can actually
 * load, and how.
 *
 * The WORK is never taken from here. It is taken from the manifest, and this
 * is consulted only to answer "is there a loader for what the manifest asked
 * for". A corpus the manifest declares that has no row here is reported as
 * having no loader, out loud, rather than silently vanishing from the sweep —
 * which is exactly the drift a hardcoded source list produces as connectors
 * are added.
 */
export function loadSourceRegistry(commands = {}) {
  // The per-source commands are injectable for ONE reason: without a seam here
  // there is no way to prove that this table forwards --dry-run, --limit and
  // the rest to the command it names. A discrimination pass found exactly that
  // hole — dropping --dry-run on the way into a leg broke nothing that any
  // test could see. Defaults are the real commands, so production behaviour is
  // unchanged and the test drives the real table.
  const ingestCalendar = commands.ingestCalendar || cmdIngestCalendar;
  const ingestImessage = commands.ingestImessage || cmdIngestImessage;
  const ingestWhatsapp = commands.ingestWhatsapp || cmdIngestWhatsapp;
  const ingestLocal = commands.ingestLocal || cmdIngestLocal;
  const ingestRemote = commands.ingestRemote || cmdIngestRemote;
  const ingestIphoneBackup = commands.ingestIphoneBackup || cmdIngestIphoneBackup;
  return {
    calendar: {
      order: 10,
      label: "Google Calendar",
      scope: "meetings, attendees, times and who was in the room",
      legs: ({ m, manifestPath, flags }) => [{
        source: "calendar",
        run: () => ingestCalendar(m, manifestPath, { ...flags, from: "calendar" }),
      }],
    },
    imessage: {
      order: 20,
      label: "iMessage (this Mac)",
      scope: "message history from Messages.app, plus forwarded SMS",
      legs: ({ m, manifestPath, flags }) => [{
        source: "imessage",
        run: () => ingestImessage(m, manifestPath, { ...flags, from: "imessage" }),
      }],
    },
    whatsapp: {
      order: 30,
      label: "WhatsApp (paired device)",
      scope: "conversations the paired linked device has captured so far",
      legs: ({ m, manifestPath, flags }) => [{
        source: "whatsapp",
        run: () => ingestWhatsapp(m, manifestPath, { ...flags, from: "whatsapp" }),
      }],
    },
    upload: {
      order: 40,
      label: "Folders on this machine",
      scope: "every readable document under the folders declared in the manifest",
      legs: ({ m, manifestPath, flags }) => {
        const folders = uploadFoldersOf(m?.corpora?.upload);
        if (!folders.length) {
          return {
            unavailable: {
              reason: "enabled, but the manifest names no folder for it to read",
              fix: 'add  "folders": ["/path/to/folder"]  under corpora.upload, or load one by hand with: '
                + "brain ingest <manifest> --path <folder>",
            },
          };
        }
        const unnamed = folders.filter((folder) => !folder.source);
        if (folders.length > 1 && unnamed.length > 1) {
          return {
            unavailable: {
              reason: `${folders.length} folders are declared and ${unnamed.length} of them have no source name`,
              fix: 'give each folder its own name so a load stays separately reversible: '
                + '"folders": [{"path": "...", "source": "contracts"}, {"path": "...", "source": "transcripts"}]',
            },
          };
        }
        return folders.map((folder) => ({
          source: folder.source || "upload",
          detail: folder.path,
          run: () => ingestLocal(m, manifestPath, {
            ...flags,
            path: String(folder.path),
            source: folder.source || "upload",
          }),
        }));
      },
    },
    gmail: {
      order: 50,
      label: "Gmail",
      scope: "mail threads, excluding bulk mail by default",
      legs: ({ m, manifestPath, flags }) => [{
        source: "gmail",
        run: () => ingestRemote(m, manifestPath, { ...flags, from: "gmail" }),
      }],
    },
    google_drive: {
      order: 60,
      label: "Google Drive",
      scope: "documents, sheets, slides and PDFs with a text layer",
      legs: ({ m, manifestPath, flags }) => [{
        source: "drive",
        run: () => ingestRemote(m, manifestPath, { ...flags, from: "drive" }),
      }],
    },
    iphone_backup: {
      order: 70,
      label: "iPhone backup (one-time snapshot)",
      scope: "iMessage and SMS history inside an unencrypted local backup",
      note: "a point-in-time snapshot, not a connection: nothing new arrives after it",
      legs: ({ m, manifestPath, flags }) => [{
        source: "iphone-backup",
        run: () => ingestIphoneBackup(m, manifestPath, { ...flags, from: "iphone-backup" }),
      }],
    },
    zoom: {
      order: 80,
      label: "Zoom cloud recordings",
      scope: "transcripts of new cloud recordings",
      // Not a gap. Zoom pushes: a finished recording calls the brain's own
      // webhook and the transcript loads itself. There is nothing to pull, so
      // this prints a stated skip instead of a green line for work it did not do.
      pushOnly: "Zoom posts each new transcript to this brain's webhook on its own, so a sweep has "
        + "nothing to pull. Recordings made before you connected are never backfilled.",
    },
  };
}

/**
 * Turn a manifest into an ordered list of legs, with a stated reason for every
 * one that will not run.
 *
 * Derived from `m.corpora`, never from the registry: the manifest is what says
 * which sources this client has. The registry only answers whether a declared
 * source has a loader in this build.
 */
export async function planLoad({ m, manifestPath, flags = {}, registry, probes, platform, commands, options = {} }) {
  const table = registry || loadSourceRegistry(commands);
  const probeTable = { ...defaultLoadProbes(), ...(probes || {}) };
  const declared = Object.keys(m?.corpora || {}).filter((key) => !key.startsWith("_"));
  const only = flags.only ? String(flags.only).split(",").map(normalizeLoadKey).filter(Boolean) : null;
  const skip = flags.skip ? String(flags.skip).split(",").map(normalizeLoadKey).filter(Boolean) : [];

  const known = new Set([...declared.map(normalizeLoadKey), ...Object.keys(table)]);
  for (const [flag, values] of [["--only", only || []], ["--skip", skip]]) {
    for (const value of values) {
      if (!known.has(value)) {
        die(
          `${flag} ${value} is not a source in this manifest.\n` +
            `      Sources declared here: ${declared.join(", ") || "none"}`
        );
      }
    }
  }

  const entries = [];
  for (const key of declared) {
    const canonical = normalizeLoadKey(key);
    const descriptor = table[canonical];
    const entry = {
      key: canonical,
      manifestKey: key,
      label: descriptor?.label || key,
      scope: descriptor?.scope || null,
      note: descriptor?.note || null,
      order: descriptor?.order ?? 900,
      enabled: m.corpora[key]?.enabled === true,
      status: "ready",
      outcome: null,
      reason: null,
      fix: null,
      legs: [],
    };

    if (only && !only.includes(canonical)) {
      entry.status = "skipped";
      entry.reason = "not selected by --only";
    } else if (skip.includes(canonical)) {
      entry.status = "skipped";
      entry.reason = "excluded by --skip";
    } else if (!entry.enabled) {
      // Three different messages, deliberately. "This client does not use it"
      // is a different fact from "it is broken", and collapsing them is how a
      // source nobody ever connected reads as one that merely failed today.
      entry.status = "skipped";
      entry.reason = "not enabled in this manifest, so this client does not use it";
    } else if (!descriptor) {
      entry.status = "unavailable";
      entry.reason = `enabled in this manifest, but brain ${PRODUCT_VERSION} has no loader for it`;
      entry.fix = "nothing was loaded from it; put its documents in a folder and load that instead";
    } else if (descriptor.pushOnly) {
      entry.status = "skipped";
      entry.reason = descriptor.pushOnly;
    } else {
      const probe = probeTable[canonical];
      let verdict = { connected: true };
      if (probe) {
        try {
          verdict = await probe({ m, manifestPath, platform: platform ?? process.platform, options });
        } catch (error) {
          verdict = { connected: false, reason: `the connection check itself failed: ${String(error?.message || error)}` };
        }
      }
      if (!verdict?.connected) {
        entry.status = "unavailable";
        entry.reason = `enabled, but not connected on this machine: ${verdict?.reason || "reason not reported"}`;
        entry.fix = verdict?.fix || null;
      } else {
        // A malformed corpus block (folders declared as a string, say) is a
        // reason to skip THAT source with the problem named, never a reason to
        // abort a sweep the other seven sources were about to be part of.
        let legs;
        try {
          legs = descriptor.legs({ m, manifestPath, flags });
        } catch (error) {
          legs = {
            unavailable: {
              reason: `this manifest's ${key} block could not be read: ${String(error?.message || error)}`,
              fix: `fix corpora.${key} in the manifest, then: brain load <manifest> --only ${canonical}`,
            },
          };
        }
        if (legs?.unavailable) {
          entry.status = "unavailable";
          entry.reason = legs.unavailable.reason;
          entry.fix = legs.unavailable.fix || null;
        } else {
          entry.legs = legs;
        }
      }
    }
    if (entry.status === "unavailable") {
      entry.outcome = ingestionOutcome("unavailable", { reason: entry.reason });
    }
    entries.push(entry);
  }

  entries.sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key));
  return entries;
}

/**
 * Describe what one leg actually did, in the shape its own command returned.
 *
 * Every branch here maps a real return value. The final branch is the one that
 * matters most: a command that reported nothing gets "counts unknown", never a
 * zero, because a zero is a claim and unknown is the truth.
 */
export function describeLoadResult(result) {
  const declaredOutcome = result && typeof result === "object" && result.outcome != null
    ? assertIngestionOutcome(result.outcome)
    : null;
  const outcomeOf = (kind, options) => {
    const derived = ingestionOutcome(kind, options);
    if (declaredOutcome && declaredOutcome.kind !== derived.kind) {
      throw new Error(
        `the connector's explicit ${declaredOutcome.kind} outcome contradicts its ${derived.kind} receipt`,
      );
    }
    return declaredOutcome || derived;
  };
  if (result && typeof result === "object") {
    if (result.dry_run) {
      if (declaredOutcome) {
        throw new Error("a dry run returned an ingestion outcome even though it must not accept work");
      }
      // A connector that does not report would_send has NOT reported zero. The
      // message captures are in exactly that position, and printing their
      // volume as 0 (or as the literal "undefined") would let an operator
      // sizing a job in front of a client under-read what those sources hold.
      // Same rule as the final branch: unknown is the truth, a zero is a claim.
      const wouldSendKnown = Number.isFinite(Number(result.would_send));
      return {
        known: true,
        dryRun: true,
        counts: null,
        wouldSend: wouldSendKnown ? Number(result.would_send) : null,
        volumeUnknown: !wouldSendKnown,
        outcome: null,
        text: wouldSendKnown
          ? `${Number(result.would_send)} document(s) WOULD be sent, ${result.unchanged ?? 0} unchanged`
          : "would be read, but this source does not report a count in advance (unknown, not zero)",
      };
    }
    // calendar: { result, sent, removed }
    if (result.sent && typeof result.sent === "object") {
      const s = result.sent;
      const counts = { created: s.created || 0, updated: s.updated || 0, unchanged: s.unchanged || 0 };
      const extra = [];
      if (result.removed) extra.push(`${result.removed} cancellation(s) removed`);
      if (result.removalPending) extra.push(`${result.removalPending} cancellation removal(s) pending`);
      if (s.refused?.length) extra.push(`${s.refused.length} refused`);
      if (s.errors?.length) extra.push(`${s.errors.length} failed to send`);
      return {
        known: true,
        counts,
        partial: !!(s.errors?.length || s.refused?.length || result.removalPending || result.result?.summary?.needs_reconsent),
        outcome: outcomeOf(
          s.errors?.length || s.refused?.length || result.removalPending || result.result?.summary?.needs_reconsent
            ? "partial"
            : "completed"
        ),
        text: `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`
          + (extra.length ? `, ${extra.join(", ")}` : ""),
      };
    }
    // message captures: documents_sent is what reached the Worker boundary;
    // documents_accepted is what the Worker actually stored or recognised.
    if (Number.isFinite(result.documents_sent)) {
      const refused = Math.max(0, Math.trunc(Number(result.refused || 0)));
      const acceptedKnown = Number.isFinite(result.documents_accepted);
      const accepted = acceptedKnown ? Number(result.documents_accepted) : Number(result.documents_sent);
      const partial = !!result.truncated || !!result.bounded || refused > 0;
      return {
        known: true,
        counts: null,
        documents: accepted,
        partial,
        outcome: outcomeOf(partial ? "partial" : "completed"),
        text: acceptedKnown
          ? `${accepted} conversation document(s) accepted from ${result.documents_sent} submitted and ${result.rows_seen ?? "unknown"} new row(s)`
            + (refused ? `; ${refused} refused, NOT indexed` : "")
            + (result.truncated || result.bounded ? "; --limit bounded it, so this is NOT the full history" : "")
          : `${result.documents_sent} conversation document(s) sent from ${result.rows_seen ?? "unknown"} new row(s)`
            + (refused ? `; ${refused} refused, NOT indexed` : "")
            + (result.truncated || result.bounded ? "; --limit bounded it, so this is NOT the full history" : ""),
      };
    }
    // local folder and remote drive/gmail tallies
    if (Number.isFinite(result.created)) {
      const counts = { created: result.created, updated: result.updated || 0, unchanged: result.unchanged || 0 };
      const extra = [];
      if (result.refused) extra.push(`${result.refused} refused, NOT indexed`);
      if (result.skipped) extra.push(`${result.skipped} skipped`);
      return {
        known: true,
        counts,
        partial: !!result.refused,
        outcome: outcomeOf(result.refused ? "partial" : "completed"),
        text: `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`
          + (extra.length ? `, ${extra.join(", ")}` : ""),
      };
    }
  }
    if (declaredOutcome && ["completed", "partial"].includes(declaredOutcome.kind)) {
      return {
        known: false,
        counts: null,
        partial: declaredOutcome.kind === "partial",
        outcome: declaredOutcome,
        text: `${declaredOutcome.kind}, with counts unknown (not zero)`,
      };
    }
  throw new Error(
    "the connector returned no recognized completion receipt. Whether anything landed is unknown; re-running is safe.",
  );
}

/** Short human duration. A sweep leg that took 41 minutes should not read "2460000ms". */
export function formatLoadElapsed(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const LOAD_STATUS_LABEL = {
  loaded: () => `${c.green("loaded")}`,
  partial: () => `${c.yellow("partly loaded")}`,
  skipped: () => `${c.dim("skipped")}`,
  unavailable: () => `${c.yellow("unavailable")}`,
  failed: () => `${c.red("FAILED")}`,
  review: () => `${c.yellow("STOPPED for review")}`,
};

/**
 * Print the consolidated report.
 *
 * Split into three named lists rather than one status column, because the
 * question a reader has is not "what happened to each source" but "what is in
 * my brain and what is not". A skipped source and a loaded one must never sit
 * on adjacent lines distinguished only by a word in the middle of them.
 */
export function renderLoadReport(entries, { dryRun, totals, log = console.log }) {
  const loaded = entries.filter((e) => e.status === "loaded" || e.status === "partial");
  const skipped = entries.filter((e) => e.status === "skipped");
  const unavailable = entries.filter((e) => e.status === "unavailable");
  const broken = entries.filter((e) => e.status === "failed" || e.status === "review");
  const pad = (s, n) => String(s).padEnd(n);
  const width = Math.max(12, ...entries.map((e) => e.label.length));

  log("");
  log(c.bold(dryRun ? "  load report — DRY RUN, nothing was sent" : "  load report"));
  log("");

  log(`  ${c.bold(dryRun ? `WOULD LOAD (${loaded.length})` : `IN THE BRAIN (${loaded.length})`)}`);
  if (!loaded.length) log(`    ${c.dim("nothing")}`);
  for (const entry of loaded) {
    log(`    ${LOAD_STATUS_LABEL[entry.status]()}  ${pad(entry.label, width)}  ${entry.summary}  ${c.dim(formatLoadElapsed(entry.elapsed_ms))}`);
    for (const line of entry.legLines || []) {
      log(`             ${/NOT loaded/.test(line) ? c.yellow(line) : c.dim(line)}`);
    }
    if (entry.status === "partial") {
      log(`             ${c.yellow(entry.legFailures?.length
        ? `part of this source is NOT in the brain: ${entry.legFailures.length} of ${entry.legs?.length ?? entry.legFailures.length} did not load`
        : "part of this source is NOT in the brain, see the line above")}`);
      log(`             ${c.dim("retry just this one:")} brain load <manifest> --only ${entry.key}`);
    }
  }

  log("");
  log(`  ${c.bold(`NOT LOADED — skipped (${skipped.length})`)}`);
  if (!skipped.length) log(`    ${c.dim("none")}`);
  for (const entry of skipped) {
    log(`    ${c.dim("skipped")}  ${pad(entry.label, width)}  ${entry.reason}`);
    if (entry.fix) log(`             ${c.dim("fix:")} ${entry.fix}`);
  }

  log("");
  log(`  ${c.bold(`NOT LOADED — unavailable (${unavailable.length})`)}`);
  if (!unavailable.length) log(`    ${c.dim("none")}`);
  for (const entry of unavailable) {
    log(`    ${LOAD_STATUS_LABEL.unavailable()}  ${pad(entry.label, width)}  ${entry.reason}`);
    if (entry.fix) log(`             ${c.dim("fix:")} ${entry.fix}`);
  }

  log("");
  log(`  ${c.bold(`NOT LOADED — failed (${broken.length})`)}`);
  if (!broken.length) log(`    ${c.dim("none")}`);
  for (const entry of broken) {
    log(`    ${LOAD_STATUS_LABEL[entry.status]()}  ${pad(entry.label, width)}  ${entry.reason}`);
    if (entry.fix) log(`             ${c.dim("fix:")} ${entry.fix}`);
    log(`             ${c.dim("retry just this one:")} brain load <manifest> --only ${entry.key}`);
  }

  log("");
  log(`  ${totals.line}`);
  log(`  ${totals.documents}`);
  if (totals.warning) log(`  ${c.yellow(totals.warning)}`);
  log("");
}

/**
 * `brain load <manifest>` — sweep every source this manifest has enabled and
 * connected, in one run, and print one honest report.
 */
export async function cmdLoad(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const flags = options.flags || parseFlags(process.argv.slice(4));
  const log = options.log || console.log;

  if (flags.reset) {
    die(
      "brain load will not take --reset.\n" +
        "      A sweep-wide reset would discard every source's resume progress at once, which is\n" +
        "      almost never what is wanted and is not undoable. Reset one source deliberately:\n" +
        "      brain ingest <manifest> --from drive --reset"
    );
  }
  const dryRun = !!flags["dry-run"];
  if (flags.limit) {
    warn(`--limit ${flags.limit} applies to EVERY source in this sweep. Nothing loaded under it is a complete load.`);
  }

  const entries = await planLoad({
    m,
    manifestPath,
    flags,
    registry: options.registry,
    commands: options.commands,
    probes: options.probes,
    platform: options.platform,
    options,
  });

  const runnable = entries.filter((entry) => entry.status === "ready");
  const client = m.client?.display_name || m.client?.slug || "this install";
  log("");
  log(`${c.bold("brain load")}  ${client}`);
  info(`${entries.length} source(s) declared in this manifest; ${runnable.length} will run`);
  log("");
  log(`  ${c.bold(dryRun ? "what WOULD be read" : "what will be read")}`);
  for (const entry of entries) {
    if (entry.status === "ready") {
      log(`    ${c.green("run")}      ${entry.label}${entry.scope ? c.dim(` — ${entry.scope}`) : ""}`);
      for (const leg of entry.legs) {
        if (leg.detail) log(`               ${c.dim(leg.detail)}`);
      }
      if (entry.note) log(`               ${c.dim(entry.note)}`);
    } else {
      log(`    ${c.dim("skip")}     ${entry.label}${c.dim(` — ${entry.reason}`)}`);
    }
  }
  if (dryRun) {
    log("");
    info("dry run: each source below is READ so it can report what it holds. Nothing is sent to the brain, and no resume state is written.");
  }
  log("");

  let index = 0;
  for (const entry of runnable) {
    index++;
    const started = Date.now();
    // Printed BEFORE the work, not after. A long leg that prints only on
    // completion is indistinguishable from a hang to the person watching.
    log(`${c.bold(`── [${index}/${runnable.length}] ${entry.label}`)}  ${c.dim("starting")}`);
    const legLines = [];
    const legResults = [];
    const legFailures = [];
    let review = false;
    // Isolation runs one level deeper than the source. A manifest can declare
    // several folders under one corpus, each its own named, separately
    // reversible load; one unreadable folder is no reason to leave the next
    // one unloaded, for exactly the reason one dead source is no reason to
    // abandon the sweep.
    for (const leg of entry.legs) {
      // Labelled by source name, never by path: the source name is the unit
      // `brain sources` lists and `brain forget` removes, so it is the handle a
      // reader can act on. The path is already in the plan printed above.
      const label = entry.legs.length > 1 ? leg.source : entry.label;
      try {
        const described = describeLoadResult(await leg.run());
        legResults.push(described);
        if (entry.legs.length > 1) legLines.push(`${label}: ${described.text}`);
      } catch (error) {
        if (error instanceof DriveRemovalReviewRequired) review = true;
        const reason = String(error?.message || error).replace(/\s+/g, " ").trim();
        legFailures.push({ label, reason });
        if (entry.legs.length > 1) legLines.push(`${label}: NOT loaded — ${reason}`);
        log(`${review ? c.yellow("review") : c.red("fail")}  ${label}: ${reason.split("\n")[0]}`);
      }
    }

    entry.elapsed_ms = Date.now() - started;
    entry.legFailures = legFailures;
    entry.legLines = legLines;
    entry.counts = legResults.map((r) => r.counts).filter(Boolean);
    entry.countsKnown = legResults.length > 0 && legResults.every((r) => r.known);
    entry.documents = legResults.reduce((n, r) => n + (Number.isFinite(r.documents) ? r.documents : 0), 0);
    entry.wouldSend = legResults.reduce((n, r) => n + (Number.isFinite(r.wouldSend) ? r.wouldSend : 0), 0);
    entry.volumeUnknown = legResults.some((r) => r?.volumeUnknown);

    if (legFailures.length && !legResults.length) {
      entry.status = review ? "review" : "failed";
      entry.reason = legFailures.map((f) => f.reason).join(" | ");
      entry.outcome = ingestionOutcome(review ? "refused" : "retryable", { reason: entry.reason });
      entry.fix = null;
      log(`      ${c.dim("continuing with the remaining sources")}`);
    } else {
      const partial = legFailures.length > 0 || legResults.some((r) => r.partial) || !!flags.limit;
      entry.status = partial ? "partial" : "loaded";
      entry.outcome = dryRun
        ? null
        : ingestionOutcome(partial ? "partial" : "completed", {
          reason: partial ? "one or more source legs or documents did not complete" : null,
        });
      entry.summary = legResults.length === 1 && entry.legs.length === 1
        ? legResults[0].text
        : `${legResults.length} of ${entry.legs.length} folder(s) loaded`;
      if (flags.limit) entry.summary += `; --limit ${flags.limit} was in force, so this is NOT a complete load`;
      if (legFailures.length) {
        log(`${c.yellow("warn")}  ${entry.label}: ${entry.summary}, and ${legFailures.length} did NOT load  ${c.dim(formatLoadElapsed(entry.elapsed_ms))}`);
      } else {
        ok(`${entry.label}: ${entry.summary}  ${c.dim(formatLoadElapsed(entry.elapsed_ms))}`);
      }
    }
    log("");
  }

  const done = entries.filter((e) => e.status === "loaded" || e.status === "partial");
  const skippedCount = entries.filter((e) => e.status === "skipped").length;
  const unavailableCount = entries.filter((e) => e.status === "unavailable").length;
  const failedCount = entries.filter((e) => e.status === "failed" || e.status === "review").length;
  const partialCount = entries.filter((e) => e.status === "partial").length;
  const absentCount = unavailableCount + failedCount;
  const totalsAccumulator = { created: 0, updated: 0, unchanged: 0 };
  let unknownCounts = 0;
  let conversationDocs = 0;
  let wouldSend = 0;
  let unknownVolume = 0;
  for (const entry of done) {
    if (!entry.countsKnown) unknownCounts++;
    if (entry.volumeUnknown) unknownVolume++;
    wouldSend += entry.wouldSend || 0;
    for (const counts of entry.counts || []) {
      totalsAccumulator.created += counts.created;
      totalsAccumulator.updated += counts.updated;
      totalsAccumulator.unchanged += counts.unchanged;
    }
    conversationDocs += entry.documents || 0;
  }

  // Totals never quietly absorb an unknown into a zero. If a source could not
  // report its counts, the totals line says how many did not, so the number
  // beside it is understood as a floor rather than a full accounting.
  // A dry-run total is a FLOOR when any source could not size itself in
  // advance. Saying so is the difference between an operator previewing a job
  // accurately and one who under-reads it while a client watches.
  const documentParts = dryRun
    ? [`at least ${wouldSend} document(s) WOULD be sent`
       + (unknownVolume ? `, plus ${unknownVolume} source(s) that cannot size themselves in advance` : "")]
    : [
      `${totalsAccumulator.created} created`,
      `${totalsAccumulator.updated} updated`,
      `${totalsAccumulator.unchanged} unchanged`,
    ];
  if (!dryRun && conversationDocs) documentParts.push(`${conversationDocs} conversation document(s) sent`);
  const totals = {
    line: `totals: ${done.length} loaded${partialCount ? ` (${partialCount} only partly)` : ""}, `
      + `${skippedCount} skipped, ${unavailableCount} unavailable, ${failedCount} failed, of ${entries.length} declared`,
    documents: unknownCounts
      ? `${documentParts.join(", ")} — plus ${unknownCounts} source(s) whose counts are UNKNOWN, not zero`
      : documentParts.join(", "),
    // "Not in the brain at all" and "in, but incomplete" are counted apart on
    // purpose. Adding them would report a source that half loaded as missing,
    // which is its own kind of dishonesty in the other direction.
    warning: (absentCount || partialCount)
      ? [
        absentCount ? `${absentCount} of ${entries.length} declared source(s) are NOT in the brain` : null,
        partialCount ? `${partialCount} loaded only in part` : null,
      ].filter(Boolean).join(", and ") + ". The lists above say which, and why."
      : null,
  };

  renderLoadReport(entries, { dryRun, totals, log });

  const summary = {
    entries,
    totals,
    dryRun,
    loaded: done.length,
    partial: partialCount,
    skipped: skippedCount,
    unavailable: unavailableCount,
    failed: failedCount,
  };
  if (failedCount) {
    // Non-zero, but only after the whole report has printed. The exit code is
    // for the script; the report above is for the person, and a partial load
    // with an honest list is still worth every line of it.
    die(
      `${failedCount} of ${runnable.length} source(s) ${dryRun ? "could not even be previewed" : "did not load"}`
        + (done.length ? `; the other ${done.length} ${dryRun ? "previewed fine" : "did"}.` : ".") + "\n"
        + "      Fix the reported cause, then re-run just that one: brain load <manifest> --only <source>"
    );
  }
  if (unavailableCount || (!dryRun && partialCount)) {
    const parts = [
      unavailableCount ? `${unavailableCount} unavailable` : null,
      !dryRun && partialCount ? `${partialCount} partial` : null,
    ].filter(Boolean).join(" and ");
    die(
      `${parts} source outcome(s) were not complete, so this load is not a successful sweep.\n` +
        "      The full report is above. Fix or reconnect the named source, then re-run only it with --only <source>."
    );
  }
  return summary;
}

/**
 * Ingest from a connected remote source.
 *
 * Deliberately shares sendBatches() with the local walker, so a Drive document
 * and a folder document are refused, split, batched and reported by identical
 * code. The producers differ; the pipeline does not.
 */
async function cmdIngestRemote(m, manifestPath, flags) {
  const which = String(flags.from).toLowerCase();
  if (!["drive", "gmail", "imap"].includes(which)) {
    die(`--from ${which} is not a source. Available: drive, gmail, imap.`);
  }

  const removalApproval = flags["approve-removals"];
  if (removalApproval !== undefined) {
    if (which !== "drive") die("--approve-removals is only valid with --from drive.");
    if (typeof removalApproval !== "string" || !/^[0-9a-f]{64}$/.test(removalApproval)) {
      die("--approve-removals needs the exact 64-character lowercase fingerprint printed by the stopped Drive sync.");
    }
  }

  const sourceName = assertSourceName(flags.source === true || !flags.source ? which : flags.source);
  const dry = !!flags["dry-run"];
  // A deployed connector talks to the brain's authenticated data-plane route.
  // The Cloudflare control token is an install/deploy credential, not something
  // a daily Drive or Gmail refresh should retain forever. A dry run talks only
  // to Google, so it resolves neither Cloudflare nor the brain's admin secret.
  const acct = dry ? null : m.brain?.domain ? null : await resolveAccount(m);
  const base = dry ? null : await resolveBaseUrl(m, acct);
  const adminKey = dry ? null : resolveAdminKey(manifestPath);
  if (!adminKey && !dry) die("no admin key found: not in the environment, and no .brain-admin-key file next to the manifest.");

  const { batchStream, splitOversized, loadState, saveState } = await ingestLib();
  // IMAP holds its own mailbox credential and never touches the Google store.
  // Resolving googleAuth unconditionally would refuse an IMAP sync on a machine
  // that has deliberately never connected Google, which is most of them.
  const getToken = which === "imap" ? null : googleAuth(which === "gmail" ? "gmail" : "drive");
  // OCR, and what it will cost, decided ONCE per run and stated out loud
  // before the first page is sent. The estimate lands while the owner can
  // still say no; a bill that appears afterwards is not a choice they were
  // offered. A dry run never gets a callback, so the safest command in the
  // tool stays the cheapest one.
  const ocrCfg = ocrPolicy(m);
  let ocrPages = 0;
  const ocrCallback = dry || !ocrCfg.enabled ? null : makeOcrCallback({
    base, adminKey, model: ocrCfg.model, maxPages: ocrCfg.maxPages,
    onPage: ({ page, totalPages }) => {
      ocrPages++;
      // Per PAGE, not per file. A forty-page scan is forty model calls and
      // over a minute of waiting; without this the run looks hung and the
      // first client to see it kills it.
      info(`  OCR page ${page}${totalPages ? ` of ${totalPages}` : ""} (${ocrPages} page(s) read so far this run)`);
    },
  });
  if (ocrCfg.enabled && !dry) {
    const { estimateOcrCost, describeOcrCost } = await ingestOcrLib();
    info(`OCR is ON, model ${ocrCfg.model}, up to ${ocrCfg.maxPages} page(s) per document.`);
    info(`  cost per 100 scanned pages: ${describeOcrCost(estimateOcrCost(100))}`);
  } else if (ocrCfg.enabled && dry) {
    info("OCR is ON, but a dry run never sends a page to a model and never spends anything.");
  }

  const statePath = join(dirname(resolve(manifestPath)), `.brain-ingest-${sourceName}.json`);
  const state = flags.reset ? { version: 1, done: {}, skipped: {} } : loadState(statePath);
  const scannerOn = m.safety?.credential_scanner?.enabled !== false;
  const scannerFingerprint = credentialScannerFingerprint(scannerOn);
  const scannerPolicyChanged = state.credential_scanner_fingerprint !== scannerFingerprint;
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  if (flags.limit && (!Number.isInteger(limit) || limit < 1)) die("--limit must be a positive whole number.");
  let sourcePolicy = null;
  let policyFingerprint = null;
  let driveDecision = null;
  if (which === "drive") {
    try {
      sourcePolicy = driveConnectorConfig(m, manifestPath);
    } catch (error) {
      die(error.message);
    }
    policyFingerprint = drivePolicyFingerprint(sourcePolicy, scannerOn, ocrCfg.enabled);
    driveDecision = driveSyncDecision({
      reset: !!flags.reset,
      syncToken: state.sync_token,
      policyFingerprint,
      savedPolicyFingerprint: state.drive_policy_fingerprint,
      lastFullSweepAt: state.drive_last_full_sweep_at,
    });
  }
  let imapPolicyChanged = false;
  if (which === "imap") {
    // The bulk-mail policy decides WHICH mail is kept, so a change to it has to
    // force a full pass. Applying a new rule only to new mail leaves the old
    // decisions in the index silently disagreeing with the current filter.
    const { imapPolicyFingerprint, BULK_POLICY } = await import("./connectors/imap.mjs");
    policyFingerprint = imapPolicyFingerprint(BULK_POLICY, BULK_POLICY.include_roles);
    imapPolicyChanged = state.imap_policy_fingerprint !== policyFingerprint;
  }
  let incremental = which === "drive"
    ? driveDecision.incremental
    : which === "imap"
      ? !flags.reset && !scannerPolicyChanged && !imapPolicyChanged && !!state.imap_folders
      : !flags.reset && !scannerPolicyChanged && Boolean(state.history_id);
  assertRemoteLimitSafe({
    source: which === "drive" ? "Drive" : which === "imap" ? "IMAP" : "Gmail",
    limit, dryRun: dry, incremental,
  });
  if (!dry && scannerPolicyChanged) {
    ensureCredentialScannerProgress(state, scannerFingerprint);
    saveState(statePath, state);
  } else if (!dry && state.credential_scanner_progress) {
    // A completed fingerprint is authoritative. Any leftover progress receipt
    // is stale bookkeeping from an older build or interrupted cleanup.
    delete state.credential_scanner_progress;
    saveState(statePath, state);
  }
  let lane = incremental ? "incremental" : "sweep";
  const runId = `sync_${randomBytes(16).toString("hex")}`;
  const runStartedAt = new Date().toISOString();
  let runOpened = false;
  let runClosed = false;

  const skips = [];
  let unchanged = 0;
  let scanned = 0;
  let prepared = 0;
  let batchNo = 0;
  // Held back until every batch has been accepted. See the note at its
  // assignment: advancing a sync cursor early loses documents silently.
  let pendingCursor = null;
  const familyPlans = new Map();
  const sentFamilyParts = new Map();
  const acceptedFamilyParts = new Map();
  const rejectedFamilyParts = new Map();
  const intentionalRemovalUids = [];
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };

  const addTally = (part) => {
    for (const key of Object.keys(tally)) tally[key] += Number(part?.[key] || 0);
  };

  const flushIntentionalRemovals = async ({ strict = true } = {}) => {
    const uids = intentionalRemovalUids.splice(0);
    if (!uids.length) return { applied: 0, pending: 0 };
    const result = await applyDriveRemovals({
      uids, base, adminKey, state, dryRun: dry, label: "intentional source skip",
    });
    if (result.applied) ok(`${result.applied} previously-indexed document(s) removed because the source now skips them`);
    if (!dry) saveState(statePath, state);
    if (strict) assertNoPendingRemovals(result, "intentional source skip");
    return result;
  };

  /**
   * Send one bounded group and immediately make every fully accepted source
   * document resumable. A split family may bridge two groups, so only its tiny
   * plan and counters survive a yield; extracted strings do not.
   */
  const consumeGroup = async (group) => {
    prepared += group.length;
    batchNo++;
    if (dry) return;

    for (const item of group) {
      if (item.familyPlan) familyPlans.set(item.familyPlan.stateKey, item.familyPlan);
    }
    const part = await sendBatches({
      base, adminKey, groups: [group], state, statePath, skips, quiet: true,
      onResult: (item, result) => {
        if (!item.familyPlan) return;
        const key = item.familyPlan.stateKey;
        if (["created", "updated", "unchanged"].includes(result.status)) {
          acceptedFamilyParts.set(key, (acceptedFamilyParts.get(key) || 0) + 1);
        } else {
          const statuses = rejectedFamilyParts.get(key) || [];
          statuses.push(result.status);
          rejectedFamilyParts.set(key, statuses);
        }
      },
    });
    addTally(part);
    for (const item of group) {
      if (!item.familyPlan) continue;
      const key = item.familyPlan.stateKey;
      sentFamilyParts.set(key, (sentFamilyParts.get(key) || 0) + 1);
    }

    const outcome = remoteFamilyOutcomes(familyPlans.values(), sentFamilyParts, acceptedFamilyParts);
    const settlement = remoteFamilySettlement(outcome, rejectedFamilyParts);
    if (settlement.reconciliations.length) {
      const staleParts = await reconcileDocumentFamilies({
        families: settlement.reconciliations, base, adminKey,
      });
      if (staleParts) ok(`${staleParts} obsolete split-document part(s) removed`);
    }
    intentionalRemovalUids.push(...settlement.intentionalRemovalUids);
    for (const plan of outcome.completed) {
      recordAcceptedDocumentState(state, plan);
      if (scannerPolicyChanged) {
        recordCredentialScannerProgress(state, scannerFingerprint, plan.stateKey, plan.hash);
      }
    }
    for (const { plan, statuses } of settlement.incomplete) {
      delete state.done[plan.stateKey];
      state.skipped[plan.stateKey] = `logical document was not indexed because part status was ${statuses.join(", ")}`;
    }
    for (const plan of [...outcome.completed, ...outcome.incomplete]) {
      familyPlans.delete(plan.stateKey);
      sentFamilyParts.delete(plan.stateKey);
      acceptedFamilyParts.delete(plan.stateKey);
      rejectedFamilyParts.delete(plan.stateKey);
    }
    if (outcome.completed.length || outcome.incomplete.length) saveState(statePath, state);
    process.stdout.write(
      `\r  batch ${batchNo}  loaded ${tally.created + tally.updated}  refused ${tally.refused}  failed ${tally.failed}   `
    );
  };

  try {
  if (!dry) {
    await postSourceReceipt(base, adminKey, {
      source: sourceName, kind: which, status: "indexing", run_id: runId,
      lane, started_at: runStartedAt, detail: `${which} ${lane} sync started`,
    });
    runOpened = true;

    // Gmail retains the historical immediate-retry path. Drive pending work is
    // deliberately held for the single aggregate plan below, otherwise a
    // failed large cleanup could bypass the new approval gate on its next run.
    const pending = Object.keys(state.removed || {});
    if (which !== "drive" && pending.length) {
      const retried = await applyDriveRemovals({
        uids: pending, base, adminKey, state, dryRun: false, label: "pending source removal",
      });
      if (retried.applied) ok(`${retried.applied} previously-pending removal(s) applied`);
      saveState(statePath, state);
      assertNoPendingRemovals(retried, "pending source removal");
    }
  }

  if (which === "drive") {
    const drive = await import("./connectors/google-drive.mjs");
    const sourceDeletedUids = [];
    if (!incremental && state.sync_token) info(`${driveDecision.reason}; using a full Drive comparison`);
    if (sourcePolicy.excludeFileIds.length) info(`${sourcePolicy.excludeFileIds.length} reviewed Drive file-id exclusion(s) enforced`);
    if (sourcePolicy.excludePaths.length) info(`${sourcePolicy.excludePaths.length} Drive path exclusion(s) enforced`);
    if (sourcePolicy.privatePrefixes.length) info(`private path prefixes enforced in Drive: ${sourcePolicy.privatePrefixes.join(", ")}`);
    // Taken BEFORE the walk. Taken after, anything changed during the walk
    // would be missed forever, because the next run starts from a token that
    // already claims to include it.
    let nextSync = null;
    try {
      nextSync = await drive.startPageToken(getToken);
    } catch (e) {
      warn(`could not get a change token, so the next run will be a full walk: ${e.message.slice(0, 100)}`);
    }

    let files = [];
    if (incremental) {
      info("incremental sync from the saved change token");
      let ch = null;
      try {
        ch = await drive.listChanges(getToken, state.sync_token);
      } catch (error) {
        if (error?.status !== 410) throw error;
        warn("the saved Drive change token is no longer usable, so this run is rebuilding source truth with a full comparison");
        incremental = false;
        lane = "sweep";
      }
      if (ch) {
        files = ch.changed;
        nextSync = ch.nextToken || nextSync;
        // Deletions are collected now and applied only after every reason can
        // be reviewed as one plan. An active changed file wins over a stale
        // removal entry when the change feed contains both.
        if (ch.removed.length) {
          sourceDeletedUids.push(...ch.removed.map((id) => `${sourceName}:${id}`));
        }

        // Drive emits the changed ancestor folder, not synthetic changes for
        // all descendants. Expand now so a move under a private or excluded
        // path cannot leave the subtree searchable until next week.
        if (ch.changed.some((file) => file.mimeType === "application/vnd.google-apps.folder")) {
          warn("a Drive folder changed, so this run is expanding to a full comparison of its descendants");
          incremental = false;
          lane = "sweep";
          files = [];
        }
      }
    }
    if (!incremental) {
      info("full walk of Drive");
      for await (const f of drive.listFiles(getToken)) {
        files.push(f);
        if (files.length >= limit) break;
      }
    }

    // Resolve paths only after the complete page set has been seen. Drive does
    // not return parents before children, and API order must not decide policy.
    state.drive_folders = drive.updateFolderIndex(files, incremental ? (state.drive_folders || {}) : {});
    const pathOf = (file) => drive.folderPathFor(file, state.drive_folders);
    const excludedUids = [];

    const prepareDrive = async (f) => {
      scanned++;
      const key = `${sourceName}:${f.id}`;
      const folder = pathOf(f);
      const excluded = drive.exclusionReason(f, folder, sourcePolicy);
      if (excluded) {
        const displayPath = [folder, f.name].filter(Boolean).join("/");
        const skip = { path: displayPath || f.name || f.id, id: f.id, reason: excluded };
        state.skipped[key] = excluded;
        excludedUids.push(key);
        return { skip };
      }

      // The Drive listing already carries every field in driveVersion(). Check
      // it before downloading or exporting bytes. This turns a periodic full
      // sweep into cheap metadata verification for unchanged files while still
      // noticing a rename or ancestor-folder move through the resolved path.
      const listedVersion = drive.driveVersion(f, folder);
      const scannerResumeAccepted = hasCredentialScannerProgress(
        state, scannerFingerprint, key, listedVersion
      );
      if ((!scannerPolicyChanged || scannerResumeAccepted) && state.done[key] === listedVersion) {
        recordAcceptedDocumentState(state, {
          stateKey: key, hash: listedVersion, skipKeys: [f.id], legacyPartRoot: f.id,
        });
        unchanged++;
        return { unchanged: true };
      }

      const r = await drive.toEnvelope(getToken, f, { sourceName, pathOf, ocr: ocrCallback });
      if (!r) return null;
      if (r.skip) {
        state.skipped[key] = r.skip.reason;
        intentionalRemovalUids.push(key);
        return { skip: r.skip };
      }
      const envelope = sanitizeIngestEnvelope(r.envelope);
      const refusal = credentialRefusalOf(envelope, scannerOn);
      if (refusal) {
        const skip = { path: safeIngestDisplay(envelope.title, f.name, f.id), id: f.id, reason: refusal.reason };
        state.skipped[key] = refusal.reason;
        intentionalRemovalUids.push(key);
        return { skip };
      }
      const envelopes = splitOversized(envelope);
      const familyPlan = {
        stateKey: key,
        hash: r.version,
        expectedParts: envelopes.length,
        base_doc_uid: key,
        keep_doc_uids: envelopes.map((envelope) => `${envelope.source_type}:${envelope.source_id}`),
        skipKeys: [key, ...envelopes.map((envelope) => envelope.source_id)],
        legacyPartRoot: f.id,
      };
      if (scanned % 200 === 0) process.stdout.write(`\r  scanned ${scanned}...   `);
      return {
        hash: r.version, envelopes, rel: f.name, stateKey: key,
        deferState: true, familyPlan,
      };
    };

    for await (const group of batchStream(files.slice(0, limit), prepareDrive, {
      onSkip: (skip) => skips.push(skip),
    })) {
      await consumeGroup(group);
    }

    if (dry) {
      // A preview has no authenticated inventory, but still reports every
      // observed category. It cannot delete or advance a cursor.
      await applyDriveRemovals({
        uids: excludedUids, base, adminKey, state, dryRun: true, label: "source policy",
      });
      await applyDriveRemovals({
        uids: sourceDeletedUids, base, adminKey, state, dryRun: true, label: "Drive deletion",
      });
      await applyDriveRemovals({
        uids: intentionalRemovalUids, base, adminKey, state, dryRun: true, label: "intentional source skip",
      });
      intentionalRemovalUids.length = 0;
    } else {
      // Inventory after every accepted batch, then make one decision covering
      // policy, source deletion, and quality refusal. No planned delete call is
      // allowed above this assertion.
      const seenUids = new Set(files.map((file) => `${sourceName}:${file.id}`));
      const explicitlyDeletedUids = sourceDeletedUids.filter((uid) => !seenUids.has(uid));
      const pendingDriveUids = Object.keys(state.removed || {});
      // A no-change incremental refresh has nothing destructive to decide and
      // should not page through a large corpus merely to prove zero. Full
      // sweeps always inventory because absence itself is a deletion signal.
      const needsStoredInventory = !incremental || excludedUids.length ||
        explicitlyDeletedUids.length || intentionalRemovalUids.length || pendingDriveUids.length;
      const storedUids = needsStoredInventory
        ? await listStoredSourceFamilies({ base, adminKey, source: sourceName })
        : new Set();
      const vanishedUids = incremental
        ? explicitlyDeletedUids
        : [...explicitlyDeletedUids, ...[...storedUids].filter((uid) => !seenUids.has(uid))];

      // A valid prior forget may have reached the Worker even if its response
      // was lost. Inventory is authoritative; clear only local retry markers
      // for families that are already absent so they cannot block re-ingest.
      for (const uid of pendingDriveUids) {
        if (!storedUids.has(uid)) {
          delete state.removed[uid];
          delete state.done[uid];
        }
      }

      const driveRemovalPlan = buildDriveRemovalPlan({
        storedFamilies: storedUids,
        activeFamilies: seenUids,
        policyCandidates: excludedUids,
        vanishedCandidates: [...vanishedUids, ...pendingDriveUids],
        intentionalCandidates: intentionalRemovalUids,
      });
      saveState(statePath, state);
      assertDriveRemovalPlanSafe(driveRemovalPlan, removalApproval);

      const currentlyPlanned = new Set(Object.values(driveRemovalPlan.targets).flat());
      let clearedRestoredPending = false;
      for (const uid of pendingDriveUids) {
        if (storedUids.has(uid) && seenUids.has(uid) && !currentlyPlanned.has(uid)) {
          delete state.removed[uid];
          clearedRestoredPending = true;
        }
      }
      if (clearedRestoredPending) saveState(statePath, state);

      if (driveRemovalPlan.total) {
        const percent = (driveRemovalPlan.ratio * 100).toFixed(1);
        const disposition = driveRemovalPlan.tooLarge ? "approved" : "within the unattended safety limits";
        info(`Drive cleanup plan ${disposition}: ${driveRemovalPlan.total} of ${driveRemovalPlan.stored} stored documents (${percent}%)`);
      }

      const categories = [
        ["source_policy", "source policy", "document(s) removed to enforce the Drive source policy"],
        ["source_deleted", "Drive source deletion", "stale document(s) removed to match Drive source truth"],
        ["intentional_skip", "intentional source skip", "previously-indexed document(s) removed because the source now skips them"],
      ];
      for (const [category, label, success] of categories) {
        const result = await applyDriveRemovals({
          uids: driveRemovalPlan.targets[category], base, adminKey, state, dryRun: false, label,
        });
        if (result.applied) ok(`${result.applied} ${success}`);
        if (driveRemovalPlan.targets[category].length) saveState(statePath, state);
        assertNoPendingRemovals(result, label);
      }
      if (driveRemovalPlan.total) {
        const afterRemoval = await listStoredSourceFamilies({ base, adminKey, source: sourceName });
        const plannedTargets = Object.values(driveRemovalPlan.targets).flat();
        const stillStored = plannedTargets.filter((uid) => afterRemoval.has(uid));
        if (stillStored.length) {
          const failedAt = new Date().toISOString();
          state.removed = {
            ...(state.removed || {}),
            ...Object.fromEntries(stillStored.map((uid) => [uid, failedAt])),
          };
          saveState(statePath, state);
          throw new Error(
            `${stillStored.length} planned Drive removal(s) remained after exact source-inventory readback. ` +
              "The source cursor was not advanced; re-running will retry them through the same approval gate."
          );
        }
      }
      intentionalRemovalUids.length = 0;
    }
    // NOT saved yet. Advancing the cursor before the batches it covers have
    // been accepted means a mid-send failure permanently skips those documents:
    // the next run starts after them and no error is ever raised. It is written
    // only once every batch has landed.
    pendingCursor = {
      key: "sync_token",
      value: nextSync,
      statePatch: !incremental
        ? {
            drive_policy_fingerprint: policyFingerprint,
            drive_last_full_sweep_at: new Date().toISOString(),
            credential_scanner_fingerprint: scannerFingerprint,
          }
        : { credential_scanner_fingerprint: scannerFingerprint },
    };
  } else if (which === "gmail") {
    const gmail = await import("./connectors/gmail.mjs");
    let nextHistory = null;
    try {
      nextHistory = await gmail.currentHistoryId(getToken);
    } catch { /* a full list still works without it */ }

    let ids;
    if (incremental) {
      const h = await gmail.listHistory(getToken, state.history_id);
      if (h.expired) {
        warn("the saved Gmail history id is too old to answer from, so this is a full pass");
        ids = gmail.listMessages(getToken, { max: limit });
      } else {
        info(`incremental: ${h.ids.length} new message(s)`);
        ids = h.ids.slice(0, limit);
      }
    } else {
      ids = gmail.listMessages(getToken, { max: limit });
    }

    const prepareGmail = async (id) => {
      scanned++;
      const key = `${sourceName}:${id}`;
      const r = await gmail.toEnvelope(getToken, id, { sourceName });
      if (r.skip) {
        state.skipped[key] = r.skip.reason;
        intentionalRemovalUids.push(key);
        return { skip: r.skip };
      }
      const scannerResumeAccepted = hasCredentialScannerProgress(
        state, scannerFingerprint, key, r.version
      );
      if ((!scannerPolicyChanged || scannerResumeAccepted) && state.done[key] === r.version) {
        recordAcceptedDocumentState(state, {
          stateKey: key, hash: r.version, skipKeys: [id], legacyPartRoot: id,
        });
        unchanged++;
        return { unchanged: true };
      }
      const envelope = sanitizeIngestEnvelope(r.envelope);
      const refusal = credentialRefusalOf(envelope, scannerOn);
      if (refusal) {
        const skip = { path: safeIngestDisplay(envelope.title, id), id, reason: refusal.reason };
        state.skipped[key] = refusal.reason;
        intentionalRemovalUids.push(key);
        return { skip };
      }
      const envelopes = splitOversized(envelope);
      if (scanned % 200 === 0) process.stdout.write(`\r  fetched ${scanned}...   `);
      return {
        hash: r.version, envelopes, rel: id, stateKey: key, deferState: true,
        familyPlan: {
          stateKey: key,
          hash: r.version,
          expectedParts: envelopes.length,
          base_doc_uid: key,
          keep_doc_uids: envelopes.map((envelope) => `${envelope.source_type}:${envelope.source_id}`),
          skipKeys: [key, ...envelopes.map((envelope) => envelope.source_id)],
          legacyPartRoot: id,
        },
      };
    };
    for await (const group of batchStream(ids, prepareGmail, {
      onSkip: (skip) => skips.push(skip),
    })) {
      await consumeGroup(group);
    }
    pendingCursor = {
      key: "history_id",
      value: nextHistory || state.history_id,
      statePatch: { credential_scanner_fingerprint: scannerFingerprint },
    };
  } else {
    const imap = await import("./connectors/imap.mjs");
    const credentials = imap.loadImapCredentials({ sourceName });
    if (!credentials) {
      die(
        `no mailbox is connected for the source "${sourceName}" on this machine.\n` +
          `      Run: brain connect imap ${manifestPath} --source ${sourceName}`
      );
    }

    const client = new imap.ImapClient({ host: credentials.host, port: credentials.port || imap.DEFAULT_IMAP_PORT });
    const observed = {};
    try {
      await client.connect();
      await client.login(credentials.username, credentials.password);

      const folders = await client.list();
      const { included, skipped: skippedRoles, unlisted, unclassified, containers } = imap.partitionFolders(folders);

      // EVERY folder is reported, read or not, and each one is told the TRUE
      // reason. A folder that was silently never opened produces a brain that is
      // confidently ignorant of it; a folder told the wrong reason sends the
      // operator looking for the wrong problem.
      const mailFolders = folders.length - containers.length;
      info(`${mailFolders} mail folder(s) on this mailbox; reading ${included.length}: ${included.map((f) => f.name).join(", ") || "none"}`);
      if (skippedRoles.length) {
        info(`  not read, by policy: ${skippedRoles.map((f) => `${f.name} (${f.role})`).join(", ")}`);
      }
      if (unlisted.length) {
        // These were identified. Saying they "could not be classified" would be
        // false, and it is the more alarming of the two readings. An Archive
        // folder in particular can hold years of a client's real mail.
        warn(
          `${unlisted.length} folder(s) were identified but are NOT read, because no rule includes them: ` +
            `${unlisted.map((f) => `${f.name} (${f.role})`).join(", ")}\n` +
            "      Only inbox and sent are read by default. If one of these holds mail you need, that needs a rule."
        );
      }
      if (unclassified.length) {
        // Not guessed at. A name table is localized and provider-specific, and
        // guessing "junk" on a folder that is really a client's invoice archive
        // loses it; guessing the other way reads their spam.
        warn(
          `${unclassified.length} folder(s) could not be identified and were NOT read: ${unclassified.map((f) => f.name).join(", ")}\n` +
            "      A folder whose purpose cannot be worked out is left alone rather than guessed at. There is no\n" +
            "      manifest setting that includes one yet: if one of these holds mail you need, that needs a rule."
        );
      }
      if (containers.length) {
        // Not mail folders. Reported so the count above adds up, and NOT as a
        // problem, because they never held a message.
        info(`  ${containers.length} name(s) are folder containers that hold no mail and cannot be opened: ${containers.map((f) => f.name).join(", ")}`);
      }
      if (!included.length) {
        die("no readable folder was found on this mailbox. Nothing was changed.");
      }

      for (const folder of included) {
        const before = await client.examine(folder.name);
        const saved = (state.imap_folders || {})[folder.name] || null;
        const decision = imap.folderSyncDecision({
          storedUidvalidity: saved?.uidvalidity ?? null,
          currentUidvalidity: before.uidvalidity,
          lastUid: saved?.last_uid ?? 0,
          reset: !!flags.reset,
          policyChanged: imapPolicyChanged,
        });
        // Never silent. A resync that just happens is indistinguishable from a
        // bug, and this is the same posture as the Gmail history-expiry warning.
        if (decision.resynced) warn(`${folder.name}: ${decision.reason}`);
        else if (decision.reason) info(`${folder.name}: ${decision.reason}`);

        let highest = decision.resynced ? 0 : (saved?.last_uid ?? 0);
        const prepareImap = async (message) => {
          scanned++;
          if (message.uid > highest) highest = message.uid;
          const r = await imap.toEnvelope(message, { sourceName, host: credentials.host });
          if (r.skip) {
            const key = `${sourceName}:${folder.name}#${message.uid}`;
            state.skipped[key] = r.skip.reason;
            return { skip: r.skip };
          }
          const key = `${sourceName}:${r.envelope.source_id}`;
          const scannerResumeAccepted = hasCredentialScannerProgress(state, scannerFingerprint, key, r.version);
          if ((!scannerPolicyChanged || scannerResumeAccepted) && state.done[key] === r.version) {
            recordAcceptedDocumentState(state, {
              stateKey: key, hash: r.version, skipKeys: [r.envelope.source_id], legacyPartRoot: r.envelope.source_id,
            });
            unchanged++;
            return { unchanged: true };
          }
          const envelope = sanitizeIngestEnvelope(r.envelope);
          const refusal = credentialRefusalOf(envelope, scannerOn);
          if (refusal) {
            // A mailbox is exactly where a person emails themselves their own
            // app password. The gate names the kind and never quotes the value.
            const skip = { path: safeIngestDisplay(envelope.title, key), id: key, reason: refusal.reason };
            state.skipped[key] = refusal.reason;
            intentionalRemovalUids.push(key);
            return { skip };
          }
          const envelopes = splitOversized(envelope);
          if (scanned % 200 === 0) process.stdout.write(`\r  fetched ${scanned}...   `);
          return {
            hash: r.version, envelopes, rel: key, stateKey: key, deferState: true,
            familyPlan: {
              stateKey: key,
              hash: r.version,
              expectedParts: envelopes.length,
              base_doc_uid: key,
              keep_doc_uids: envelopes.map((one) => `${one.source_type}:${one.source_id}`),
              skipKeys: [key, ...envelopes.map((one) => one.source_id)],
              legacyPartRoot: r.envelope.source_id,
            },
          };
        };

        const stream = imap.streamFolder(client, folder.name, {
          criteria: decision.searchCriteria,
          floor: decision.floor,
          uidvalidity: before.uidvalidity,
        });
        for await (const group of batchStream(stream, prepareImap, {
          onSkip: (skip) => skips.push(skip),
        })) {
          await consumeGroup(group);
        }

        // Re-EXAMINE before recording anything. A server may roll UIDVALIDITY
        // during a long folder (maintenance, a migration), and recording a
        // watermark measured under the old numbering against the new value is
        // precisely the silent skip this connector exists not to do.
        const after = await client.examine(folder.name);
        imap.assertUidvalidityStable(folder.name, before.uidvalidity, after.uidvalidity);
        observed[folder.name] = { uidvalidity: before.uidvalidity, last_uid: highest };
      }
    } finally {
      await client.logout().catch(() => {});
    }

    // ONE object, merged connector-side. Per-folder positions cannot be a
    // scalar assign, and the new UIDVALIDITY is never written apart from the
    // watermark it belongs to: a half-finished resync leaves the OLD pair in
    // place, so the next run detects the mismatch again instead of resuming
    // from a number that means nothing.
    pendingCursor = {
      key: "imap_folders",
      value: imap.mergeFolderWatermarks(state.imap_folders, observed),
      statePatch: {
        imap_policy_fingerprint: policyFingerprint,
        credential_scanner_fingerprint: scannerFingerprint,
      },
    };
  }
  process.stdout.write("\r");

  if (which !== "drive") await flushIntentionalRemovals();

  info(`${scanned} scanned; ${prepared} document(s) prepared in ${batchNo} batch(es); ${unchanged} unchanged; ${skips.length} skipped`);

  if (dry) {
    ok("dry run, nothing was sent");
    await reportSkips(skips);
    return { dry_run: true, would_send: prepared, unchanged, skipped: skips.length };
  }

  // Every batch landed, so it is now safe to say "we have everything up to
  // here". sendBatches dies rather than returning on a failure, so reaching
  // this line is the proof.
  if (pendingCursor && sourceCursorCanAdvance(tally)) {
    state[pendingCursor.key] = pendingCursor.value;
    Object.assign(state, pendingCursor.statePatch || {});
    commitCredentialScannerProgress(state, scannerFingerprint);
    saveState(statePath, state);
  } else if (pendingCursor && tally.failed) {
    warn(`${tally.failed} document(s) failed, so the source cursor was NOT advanced; the next run will retry them`);
  }
  const finalStatus = tally.failed ? "error" : "ready";
  await postSourceReceipt(base, adminKey, {
    source: sourceName, kind: which, status: finalStatus, run_id: runId,
    lane, started_at: runStartedAt, completed_at: new Date().toISOString(),
    complete_sweep: which === "drive" && !incremental,
    walk_complete: tally.failed === 0,
    files_seen: scanned,
    docs_added: tally.created,
    docs_updated: tally.updated,
    docs_unchanged: unchanged + tally.unchanged,
    detail: `${which} ${lane} sync ${finalStatus === "ready" ? "completed" : "completed with document failures"}; skipped=${skips.length}`,
    ...(tally.failed ? { error: `${tally.failed} document(s) failed; the source cursor was not advanced` } : {}),
  });
  runClosed = true;

  const summary = `${tally.created} created, ${tally.updated} updated, ${unchanged + tally.unchanged} unchanged`;
  if (tally.failed) info(summary);
  else ok(summary);
  if (tally.refused) warn(`${tally.refused} document(s) refused for carrying live credentials.`);
  await reportSkips(skips);
  info(`progress saved to ${relative(process.cwd(), statePath)}`);
  assertNoIngestFailures(tally);
  await reportBacklog(manifestPath);
  // Returned for the same reason the local walker returns its tally: a sweep
  // that ran this leg can then report real counts rather than "unknown".
  return {
    created: tally.created,
    updated: tally.updated,
    unchanged: unchanged + tally.unchanged,
    refused: tally.refused,
    scanned,
    skipped: skips.length,
  };
  } catch (error) {
    // The cursor is deliberately outside this path: it is written only after
    // every batch and Drive family cleanup succeeds above. A thrown Drive/Gmail
    // fetch therefore stays retryable and is also visible immediately instead
    // of lingering as a green or anonymous `indexing` row.
    if (which !== "drive" && intentionalRemovalUids.length && !dry) {
      try {
        await flushIntentionalRemovals({ strict: false });
      } catch (cleanupError) {
        warn(`the sync failed and source-skip cleanup could not finish: ${String(cleanupError?.message || cleanupError).slice(0, 160)}`);
      }
    }
    if (runOpened && !runClosed) {
      try {
        await postSourceReceipt(base, adminKey, {
          source: sourceName, kind: which, status: "error", run_id: runId,
          lane, started_at: runStartedAt, completed_at: new Date().toISOString(),
          walk_complete: false, files_seen: scanned,
          error: String(error?.message || error).replace(/\s+/g, " ").slice(0, 500),
          detail: `${which} ${lane} sync aborted before its cursor could advance`,
        });
        runClosed = true;
      } catch (receiptError) {
        warn(`the sync failed and its error receipt could not be recorded: ${String(receiptError?.message || receiptError).slice(0, 160)}`);
      }
    }
    throw error;
  }
}

/** POST every batch, recording progress after each so a stop is resumable. */
async function sendBatches({
  base, adminKey, groups, state, statePath, skips, quiet = false,
  onAccepted = null, onResult = null,
}) {
  // Loaded here rather than closed over: sendBatches is top-level and shared by
  // both ingest paths, so it cannot rely on a caller's destructured import.
  const { saveState } = await ingestLib();
  const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  let n = 0;
  for (const group of groups) {
    n++;
    let res, raw;
    try {
      ({ res, raw } = await requestIngestBatch({
        base,
        adminKey,
        docs: group.map((g) => g.envelope),
        onRetry: (_error, attempt, attempts) => info(
          `the ingest batch connection was interrupted. Retrying ${attempt}/${attempts - 1}; ` +
            "an accepted copy is safe and will be reported as unchanged."
        ),
      }));
    } catch (error) {
      saveState(statePath, state);
      die(
        `batch ${n}/${groups.length} could not be confirmed: ${String(error?.message || error)}\n` +
          "      Progress was saved. Re-run the same command to continue."
      );
    }
    // A 200 is NOT proof anything was ingested. Cloudflare Access pages, SSO
    // interstitials and misrouted requests all answer 200 with HTML, and
    // parsing that into {} produced a green "ok  0 created" with exit 0. A load
    // that silently did nothing, reported as success, is the worst outcome this
    // command has, so a real receipt is required before anything is believed.
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch { /* handled immediately below */ }

    if (!res.ok) {
      saveState(statePath, state);
      die(
        `batch ${n}/${groups.length} failed with ${res.status}: ${raw.slice(0, 200)}\n` +
          "      Progress was saved. Fix the cause and re-run the same command to continue."
      );
    }
    if (!body || !Array.isArray(body.results)) {
      saveState(statePath, state);
      die(
        `batch ${n}/${groups.length} returned ${res.status} but not an ingest receipt, so nothing is confirmed loaded.\n` +
          (/^\s*</.test(raw)
            ? "      The response is HTML, which usually means an Access or SSO page answered\n" +
              "      instead of the brain. Check that the worker route is not behind Access.\n"
            : `      Expected JSON with a results array. Got: ${raw.slice(0, 120)}\n`) +
          "      Nothing was marked as loaded."
      );
    }
    let results;
    try {
      results = validateBatchReceipt(body, group);
    } catch (error) {
      saveState(statePath, state);
      die(
        `batch ${n}/${groups.length} returned an incomplete ingest receipt: ${error.message}\n` +
          "      Nothing missing was marked as loaded. Re-run the same command to retry it."
      );
    }
    for (const r of results) {
      tally[r.status]++;
      const item = group.find((g) => String(g.envelope.source_id) === String(r.source_id));
      if (!item) continue;
      if (onResult) onResult(item, r);
      // Remote connectors can keep their progress key namespaced even though
      // the ingest envelope carries the bare source id. That prevents both a
      // double-prefixed document uid and an every-run resend loop.
      const base_id = item.stateKey || item.envelope.metadata?.part_of || r.source_id;
      if (["created", "updated", "unchanged"].includes(r.status)) {
        if (!item.deferState) {
          recordAcceptedDocumentState(state, {
            stateKey: base_id,
            hash: item.hash,
            skipKeys: [r.source_id],
            legacyPartRoot: item.envelope.metadata?.part_of || r.source_id,
          });
        }
        if (onAccepted) onAccepted(item, r);
      }
      else {
        const reason = r.status === "refused" ? `refused: carries ${(r.labels || []).join(", ")}` : `failed: ${r.error || "unknown"}`;
        state.skipped[base_id] = reason;
        skips.push({ path: r.source_id, reason });
      }
    }
    saveState(statePath, state);
    if (!quiet) {
      process.stdout.write(`\r  batch ${n}/${groups.length}  loaded ${tally.created + tally.updated}  refused ${tally.refused}  failed ${tally.failed}   `);
    }
  }
  if (!quiet) process.stdout.write("\n");
  return tally;
}

/** Caveats worth seeing: the file IS indexed, it is just thinner than it looks. */
function reportNotes(notes) {
  if (!notes.length) return;
  const byNote = new Map();
  for (const n of notes) byNote.set(n.note, (byNote.get(n.note) || 0) + 1);
  for (const [note, count] of byNote) warn(`${count} file(s) indexed with a caveat: ${note}`);
}

/** Group skips by reason. A flat list of 40,000 lines tells a client nothing. */
export async function reportSkips(skips) {
  if (!skips.length) return;
  const byReason = new Map();
  for (const s of skips) {
    // Collapse the variable part so counts aggregate meaningfully.
    const key = String(s.reason).replace(/\d+(\.\d+)?/g, "N");
    if (!byReason.has(key)) byReason.set(key, []);
    // Defense in depth for extractor/walk skips that did not pass through the
    // credential-refusal helper above.
    byReason.get(key).push(safeIngestDisplay(s.path));
  }
  console.log(`\n  ${skips.length} file(s) not indexed:`);
  for (const [reason, paths] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${String(paths.length).padStart(6)}  ${reason}`);
    for (const p of paths.slice(0, 2)) console.log(`            e.g. ${p}`);
  }
  try {
    const { supported } = await import("./ingest/extract.mjs");
    console.log(`\n  Supported today: ${supported().join(" ")}`);
  } catch { /* purely informational */ }
}

/** The install's URL, from the manifest or the workers.dev subdomain. */
async function resolveBaseUrl(m, acct) {
  if (m.brain?.domain) return `https://${m.brain.domain}`;
  acct = acct || (await resolveAccount(m));
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  const sub = await cf(`/accounts/${acct.id}/workers/subdomain`).catch(() => null);
  if (!sub?.subdomain) die("could not determine the brain's URL. Set brain.domain in the manifest.");
  return `https://${scriptName}.${sub.subdomain}.workers.dev`;
}


/**
 * brain connect google — the client authorises their OWN Google account.
 *
 * They register the OAuth client in their own Google Cloud project, and the
 * refresh token is stored securely on their machine. We never see any of it. That is
 * not only a custody preference: every Drive and Gmail read scope is RESTRICTED,
 * so one vendor-owned OAuth client serving many customers would require Google
 * verification plus a paid annual CASA security assessment.
 */
async function cmdConnect(target) {
  const flags = parseFlags(process.argv.slice(3));
  const which = (target || "").toLowerCase();
  if (which === "imessage") return cmdConnectImessage(process.argv[4], flags);
  if (which === "whatsapp") return cmdConnectWhatsapp(process.argv[4], flags);
  if (which === "zoom") return cmdConnectZoom(process.argv[4], flags);
  if (which === "imap") return cmdConnectImap(process.argv[4], flags);
  if (which !== "google") {
    die(
      "brain connect supports google, imap, imessage, whatsapp and zoom.\n" +
        "  Usage: brain connect google --scopes drive,gmail,calendar\n" +
        "         brain connect imap <manifest> --host imap.example.com --user you@example.com\n" +
        "         brain connect imessage <manifest>\n" +
        "         brain connect whatsapp <manifest> --accept-risk\n" +
        "         brain connect zoom <manifest>"
    );
  }

  const names = String(flags.scopes === true || !flags.scopes ? "drive" : flags.scopes).split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = names.filter((n) => !SCOPES[n]);
  if (unknown.length) die(`unknown scope(s): ${unknown.join(", ")}. Choose from: ${Object.keys(SCOPES).join(", ")}`);

  // Adding a scope to an EXISTING connection must not demand credentials this
  // machine already holds. The stored connection carries the client id and
  // secret (googleAuth builds its token provider from them), and the scope
  // refusal tells the operator to re-run this command, so requiring the
  // environment variables again made that instruction a dead end: the message
  // named the fix and the fix could not run. Reuse what is stored, and fall
  // back to the environment only for a first connection.
  const priorGoogle = (() => {
    try { return loadTokens().google || null; } catch { return null; }
  })();
  const clientId = process.env.GOOGLE_CLIENT_ID || priorGoogle?.client_id;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || priorGoogle?.client_secret;
  if (clientId && !process.env.GOOGLE_CLIENT_ID) {
    info("reusing the Google client already stored on this machine; no credential was re-entered.");
  }
  if (!clientId) {
    die(
      "GOOGLE_CLIENT_ID is not set.\n\n" +
        "  You create this in YOUR OWN Google Cloud account, and it never leaves your machine:\n" +
        "    1. console.cloud.google.com, create a project\n" +
        "    2. Enable the APIs you want: Google Drive API, Gmail API, Google Calendar API\n" +
        "    3. OAuth consent screen. On Google Workspace choose INTERNAL. On a personal\n" +
        "       gmail.com account choose External and then click PUBLISH APP, because an\n" +
        "       app left in Testing is issued refresh tokens that expire after 7 DAYS.\n" +
        "    4. Credentials, Create credentials, OAuth client ID, type Desktop app\n" +
        "       Desktop apps accept the local loopback callback automatically. Google Cloud\n" +
        "       does not show or require a redirect-URI field for this client type.\n\n" +
        "  Supply the public client ID through your approved local launcher. If Google issued a\n" +
        "  client secret, inject it through an approved secret manager; never paste it into a shell\n" +
        "  command. Then run: brain connect google --scopes drive,gmail"
    );
  }

  const port = flags.port ? parseInt(flags.port, 10) : DEFAULT_PORT;
  info(`requesting: ${names.join(", ")}`);
  const tokens = await authorize({
    clientId,
    clientSecret,
    scopes: names.map((n) => SCOPES[n]),
    port,
  });

  const store = loadTokens();
  store.google = {
    client_id: clientId,
    client_secret: clientSecret || null,
    refresh_token: tokens.refresh_token,
    scopes: names,
    connected_at: new Date().toISOString(),
  };
  saveTokens(store);
  ok(`connected. Token stored in ${tokenStorageDescription()} (on this machine only)`);
  info(`now run: brain ingest <manifest> --from ${names[0]}`);
}

/**
 * brain connect imessage <manifest> — Mac-only live message capture.
 *
 * The order is deliberate: verify Full Disk Access FIRST with a real read
 * attempt (reporting honestly, by name, when it is denied), run the initial
 * history load in the foreground so its counts are seen rather than hidden
 * in a LaunchAgent log, and only then install the every-minute capture
 * agent — so the agent's first tick starts from a caught-up watermark
 * instead of racing a foreground backfill for the same pages.
 */
export async function cmdConnectImessage(manifestPath, flags = {}, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    die(
      "iMessage capture requires a Mac: Apple only exposes message history through\n" +
        "      ~/Library/Messages/chat.db, which exists on macOS and nowhere else."
    );
  }
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain connect imessage <manifest> [--no-initial-load]");
  }
  const { m } = loadManifest(manifestPath);
  if (m.corpora?.imessage?.enabled !== true) {
    die(
      "corpora.imessage.enabled is not true in this manifest.\n" +
        '      Add  "imessage": { "enabled": true }  under "corpora" first, so the install\n' +
        "      record says this machine captures messages before the machinery exists."
    );
  }

  const imessage = options.imessage ?? await import("./connectors/imessage.mjs");
  const scheduler = options.imessageScheduler ?? await import("./operations/imessage-scheduler.mjs");

  // Step 1: the Full Disk Access verification — an actual read, not a guess.
  const chatDbPath = imessage.defaultChatDbPath();
  const probe = imessage.probeChatDb(chatDbPath);
  if (!probe.ok) {
    if (probe.reason === "full_disk_access_denied") {
      console.log("");
      for (const line of imessage.fdaRemediationSteps()) console.log(`  ${line}`);
      console.log("");
      die(
        "Full Disk Access is not granted yet, so nothing was installed. Follow the steps\n" +
          "      above, then re-run this same command — it verifies the grant by reading the\n" +
          "      database for real before anything is scheduled."
      );
    }
    die(probe.message);
  }
  ok(`Full Disk Access verified: ${chatDbPath} is readable`);

  // The scheduled child posts freshness receipts with the admin key it
  // resolves itself, so require the durable key now, exactly like
  // `brain schedule --install` does, rather than installing an agent whose
  // every tick would fail on a missing credential.
  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const adminKey = resolveKey(manifestPath);
  if (!adminKey) {
    die("no admin key found, so iMessage capture cannot be reflected in source freshness. Run `brain setup <manifest>` first.");
  }
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const base = await resolveBase(m, null);

  // Step 2: the initial history load, in the foreground, with counts.
  if (!flags["no-initial-load"]) {
    info("running the initial history load (safe to interrupt; it resumes where it stopped)");
    await cmdIngestImessage(m, manifestPath, {}, options);
  } else {
    info("skipping the initial history load; the first scheduled tick will begin it");
  }

  // Step 3: the every-minute LaunchAgent, plus the freshness expectation that
  // makes `brain sources` honest about whether capture is actually running.
  const installed = scheduler.installImessageScheduler(manifestPath, options.schedulerOptions || {});
  for (const warning of installed.warnings || []) warn(warning);
  const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
  await postExpectation(base, adminKey, {
    source: "imessage", kind: "imessage", expected_refresh_seconds: installed.expectedRefreshSeconds,
  });
  ok(`iMessage capture installed for ${installed.cron} (a new message appears within about a minute)`);
  ok(`freshness expectation set to ${installed.expectedRefreshSeconds} seconds`);
  info(`definition: ${installed.plistPath}`);
  info(`logs: ${installed.stdoutPath} and ${installed.stderrPath}`);
  info(`to stop and remove capture later: brain disconnect imessage ${manifestPath}`);
  return installed;
}

/**
 * brain connect whatsapp <manifest> --accept-risk — live capture via a paired
 * linked device.
 *
 * OPT-IN, TWICE, DELIBERATELY. Decision D-2 (whether live WhatsApp capture is
 * opt-in or default-on, and in what words) is not made yet, so this command
 * refuses to run unless the install record declares the corpus AND the person
 * at the keyboard passes --accept-risk after reading the disclosure printed
 * here. If D-2 later lands on default-on, removing a gate is a one-line change;
 * a capability that shipped on by default and turned out to get an account
 * banned is not recoverable in one line.
 *
 * The order is deliberate. Resolve the binary before printing anything about
 * pairing, so a missing daemon is a clean sentence rather than a stack trace
 * halfway through a wizard. Pair in the FOREGROUND — the QR has to reach a
 * human, and WhatsApp pushes the link-time history exactly once, so the
 * foreground run stays alive until that history stops arriving. Only then
 * install the supervised daemon, because the whatsmeow session store is a
 * single-writer SQLite file and two copies of the daemon would fight over it.
 * Drain last, so the first scheduled tick starts from a caught-up cursor.
 */
export async function cmdConnectWhatsapp(manifestPath, flags = {}, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    die(
      "installing WhatsApp capture needs macOS: the capture daemon is kept alive by a\n" +
        "      per-user LaunchAgent, and no Windows service or Startup-task supervision is\n" +
        "      built in this installer yet. The daemon itself cross-compiles for Windows, so\n" +
        "      this is a missing installer, not a missing capability — but nothing here will\n" +
        "      pretend to install something it cannot keep running."
    );
  }
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain connect whatsapp <manifest> --accept-risk [--daemon <binary>] [--no-initial-load]");
  }
  const { m } = loadManifest(manifestPath);
  if (m.corpora?.whatsapp?.enabled !== true) {
    die(
      "corpora.whatsapp.enabled is not true in this manifest.\n" +
        '      Add  "whatsapp": { "enabled": true }  under "corpora" first, so the install\n' +
        "      record says this machine captures WhatsApp before the machinery exists."
    );
  }

  const whatsapp = options.whatsapp ?? await import("./connectors/whatsapp.mjs");
  const daemonAgent = options.whatsappDaemon ?? await import("./operations/whatsapp-daemon.mjs");
  const drainScheduler = options.whatsappDrainScheduler ?? await import("./operations/whatsapp-drain-scheduler.mjs");

  // Step 1: disclose the account risk before requiring infrastructure. A fresh
  // install has no daemon binary yet; gating this text on a successful binary
  // lookup would make someone build and install tooling before learning that
  // pairing uses an unofficial client and can put the WhatsApp account at risk.
  console.log("");
  for (const line of whatsapp.WHATSAPP_DISCLOSURE) console.log(line ? `  ${line}` : "");
  console.log("");
  if (!flags["accept-risk"]) {
    die(
      "nothing was paired. Live WhatsApp capture is opt-in and stays that way until it is\n" +
        "      decided otherwise. If you have read the two paragraphs above and want it anyway:\n" +
        `        brain connect whatsapp ${manifestPath} --accept-risk`
    );
  }

  // Step 2: resolve the binary before any promise about pairing.
  let binary;
  try {
    binary = whatsapp.resolveDaemonBinary({
      explicit: flags.daemon,
      env: options.env ?? process.env,
      manifest: m,
      platform: options.platform ?? process.platform,
      ...(options.statFile ? { statFile: options.statFile } : {}),
    });
  } catch (error) {
    if (error?.reason === "daemon_binary_missing") die(error.message);
    throw error;
  }

  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const adminKey = resolveKey(manifestPath);
  if (!adminKey) {
    die("no admin key found, so WhatsApp capture cannot be reflected in source freshness. Run `brain setup <manifest>` first.");
  }
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const base = await resolveBase(m, null);

  // Step 3: pairing, in the foreground, holding on until the link-time history
  // has stopped arriving.
  const dataDir = whatsappDataDir(m, options);
  info(`capture data directory: ${dataDir}`);
  info(`capture daemon: ${binary.path} (${binary.source})`);
  info("starting the capture daemon; scan the QR code below with WhatsApp on the phone");
  const paired = await whatsapp.pairDaemon({
    binaryPath: binary.path,
    dataDir,
    env: options.env ?? process.env,
    ...(options.pairOptions || {}),
  });
  if (paired.alreadyPaired) {
    ok("this machine was already paired; the existing linked-device session was reused");
  } else {
    ok("paired");
  }
  info(
    paired.historyChunks
      ? `link-time history: ${paired.historyChunks} chunk(s), ${paired.historyInserted} message(s) captured`
      : "link-time history: none arrived in this window (WhatsApp decides how much a phone transfers, and it can be nothing)"
  );

  // Step 4: the supervised daemon. Installed only after the foreground copy has
  // exited, so the two never hold the session store at once.
  const daemon = daemonAgent.installWhatsappDaemon(manifestPath, {
    ...(options.daemonOptions || {}),
    binaryPath: binary.path,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  });
  ok("capture daemon installed and running under launchd (it restarts itself if it crashes or the network drops)");

  // Step 5: the initial drain, in the foreground, with counts.
  if (!flags["no-initial-load"]) {
    info("draining what the daemon captured (safe to interrupt; it resumes where it stopped)");
    await cmdIngestWhatsapp(m, manifestPath, {}, options);
  } else {
    info("skipping the initial drain; the first scheduled tick will begin it");
  }

  // Step 6: the drain tick, plus the freshness expectation that makes
  // `brain sources` honest about whether capture is actually reaching the brain.
  const installed = drainScheduler.installWhatsappDrainScheduler(manifestPath, options.schedulerOptions || {});
  for (const warning of installed.warnings || []) warn(warning);
  const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
  await postExpectation(base, adminKey, {
    source: "whatsapp", kind: "whatsapp", expected_refresh_seconds: installed.expectedRefreshSeconds,
  });
  ok(`WhatsApp drain installed for ${installed.cron} (a new message appears within about a minute)`);
  ok(`freshness expectation set to ${installed.expectedRefreshSeconds} seconds`);
  info(`daemon definition: ${daemon.plistPath}`);
  info(`daemon logs: ${daemon.stdoutPath} and ${daemon.stderrPath}`);
  info(`drain definition: ${installed.plistPath}`);
  info(`to stop and remove capture later: brain disconnect whatsapp ${manifestPath}`);
  return { daemon, drain: installed, paired };
}

/**
 * brain connect zoom <manifest> — Zoom cloud-recording transcripts.
 *
 * The step ORDER here is the design, not a formality. Saving a webhook URL in
 * the Zoom Marketplace is itself the validation request: Zoom immediately POSTs
 * a challenge to whatever URL was typed and refuses to save an endpoint that
 * answers wrongly. So the client cannot be sent to paste that URL until their
 * worker is deployed, routing the webhook, and holding the Secret Token. Every
 * step below exists to make that true before the last one prints the URL:
 *
 *   1. Credentials from the environment, never argv, or print what to create.
 *   2. Probe Zoom for real. A Basic plan cannot cloud record, so it can never
 *      produce a transcript — that is a refusal here, not a surprise later.
 *   3. Write the four secrets to the CLIENT'S worker.
 *   4. Run Zoom's own handshake against the live worker, holding the same
 *      Secret Token Zoom will hold. This is the check Zoom is about to run.
 *   5. Only now, print the URL and the event to subscribe to.
 */
export async function cmdConnectZoom(manifestPath, flags = {}, options = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain connect zoom <manifest>");
  }
  const { m } = loadManifest(manifestPath);
  if (m.corpora?.zoom?.enabled !== true) {
    die(
      "corpora.zoom.enabled is not true in this manifest.\n" +
        '      Add  "zoom": { "enabled": true }  under "corpora" first, so the install\n' +
        "      record says this brain reads Zoom transcripts before the machinery exists."
    );
  }

  const zoom = options.zoom ?? await import("./connectors/zoom.mjs");
  const env = options.env ?? process.env;

  // Step 1: credentials, from the environment only.
  const { values, missing, complete } = zoom.readZoomCredentialsFromEnv(env);
  if (!complete) {
    console.log("");
    for (const line of zoom.zoomAppCreationSteps()) console.log(`  ${line}`);
    console.log("");
    die(`not set yet: ${missing.join(", ")}. Nothing was created or changed.`);
  }

  // Step 2: prove the credentials against Zoom before writing anything.
  info("checking these credentials against Zoom");
  let probe;
  try {
    probe = await zoom.probeZoomAccount(values, options.probeOptions || {});
  } catch (error) {
    die(`${String(error?.message || error)}\n      Nothing was written.`);
  }
  const verdict = zoom.summarizeZoomProbe(probe);
  for (const note of verdict.notes) info(note);
  if (!verdict.ok) {
    die(verdict.blockers.join("\n      "));
  }
  ok("Zoom credentials verified, and the recording scope is granted");

  // Step 3: the four secrets, onto the client's own worker.
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  const resolveAcct = options.resolveAccount ?? resolveAccount;
  const acct = await resolveAcct(m);
  const putSecret = options.putWorkerSecret ?? ((account, script, name, text) =>
    cf(`/accounts/${account.id}/workers/scripts/${script}/secrets`, {
      method: "PUT",
      body: { name, text, type: "secret_text" },
    }));
  for (const name of zoom.ZOOM_CREDENTIAL_ENV) {
    try {
      await putSecret(acct, scriptName, name, values[name]);
    } catch (e) {
      // A secret is set ON a script, so the script has to exist first. Zoom's
      // own error for this arrives much later and says nothing useful.
      if (/does not exist/i.test(e.message) || /\(404\)/.test(e.message)) {
        die(
          `the worker "${scriptName}" has not been deployed yet, so there is nothing to set secrets on.\n` +
            "      Run `brain deploy <manifest>` first, then rerun this command. Any Zoom secrets\n" +
            "      already written are unchanged and will be overwritten on the retry."
        );
      }
      die(`the Zoom secret ${name} could not be written to the worker: ${e.message}`);
    }
  }
  ok(`four Zoom secrets written to ${scriptName} in the client's own Cloudflare account`);

  // Step 4: run the exact handshake Zoom is about to run.
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const base = await resolveBase(m, acct);
  const webhookUrl = zoom.zoomWebhookUrl(base);
  // A secret written seconds ago does not always reach every running isolate
  // instantly. Checking once would occasionally tell a client their Secret
  // Token is wrong when it is right, which sends them back to Zoom to re-copy
  // a correct value — the worst possible false negative here. A few short
  // retries cost nothing and remove that whole class of confusion.
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, Number(options.verifyAttempts ?? 3));
  let live = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    live = await zoom.verifyLiveWebhookEndpoint(
      webhookUrl, values.ZOOM_WEBHOOK_SECRET_TOKEN, options.verifyOptions || {},
    );
    if (live.ok || attempt === attempts) break;
    info(`the brain has not answered the validation challenge yet; retrying (${attempt} of ${attempts - 1})`);
    await sleep(2000);
  }
  if (!live.ok) {
    die(
      `${live.reason}\n` +
        "      The secrets were written, but do NOT paste the URL into Zoom yet: Zoom validates it\n" +
        "      on save and would refuse it. Fix the above and rerun this command."
    );
  }
  ok("the brain answered Zoom's validation challenge correctly. The URL will save.");

  // Step 5: register the named source, so it is visible and undoable before a
  // single call has happened. No refresh expectation: Zoom pushes when a
  // meeting happens, so a quiet week is not a broken connector.
  try {
    const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
    const adminKey = resolveKey(manifestPath);
    if (!adminKey) throw new Error("no admin key is available");
    const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
    await postExpectation(base, adminKey, {
      source: "zoom", kind: "zoom", expected_refresh_seconds: null,
    });
  } catch (error) {
    warn(
      `Zoom is connected, but the named source could not be registered up front: ${String(error?.message || error).slice(0, 160)}\n` +
        "      Harmless: the first transcript that arrives registers it."
    );
  }

  console.log("");
  for (const line of zoom.zoomEventSubscriptionSteps(webhookUrl)) console.log(`  ${line}`);
  console.log("");
  info(`to remove this later: brain disconnect zoom ${manifestPath}`);
  return { webhookUrl, scriptName, plan: probe.plan };
}

/**
 * brain connect imap <manifest> — any mailbox that speaks IMAP.
 *
 * THE APP PASSWORD NEVER TOUCHES A SHELL. It is not a flag, not an environment
 * variable, and not echoed back. It is read from a real terminal with echo
 * disabled and written straight into the client's own Keychain or DPAPI store,
 * under an item named for IMAP so they can find and revoke exactly this one.
 * A flag would put a live mailbox password into shell history and every process
 * listing on the machine.
 *
 * NOTHING IS STORED UNTIL A REAL READ SUCCEEDS. The probe logs in, lists the
 * folders, EXAMINEs the inbox and reads one message before the credential is
 * written. A connector that installs cleanly and fails on the first unattended
 * sync is worse than one that refuses now, because the failure then arrives
 * when nobody is watching and the client believes their mail is in there.
 */
export async function cmdConnectImap(manifestPath, flags = {}, options = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain connect imap <manifest> --host <imap.host> --user <address> [--port 993] [--source <name>]");
  }
  const { m } = loadManifest(manifestPath);
  if (m.corpora?.imap?.enabled !== true) {
    die(
      "corpora.imap.enabled is not true in this manifest.\n" +
        '      Add  "imap": { "enabled": true }  under "corpora" first, so the install\n' +
        "      record says this brain reads a mailbox before the machinery exists."
    );
  }

  const imap = options.imap ?? await import("./connectors/imap.mjs");
  const sourceName = assertSourceName(flags.source === true || !flags.source ? "imap" : flags.source);
  const host = String(flags.host === true ? "" : flags.host || m.corpora?.imap?.host || "").trim();
  const username = String(flags.user === true ? "" : flags.user || m.corpora?.imap?.username || "").trim();
  const port = flags.port ? Number(flags.port) : (m.corpora?.imap?.port || imap.DEFAULT_IMAP_PORT);
  if (!host || !username) {
    die(
      "both --host and --user are required.\n" +
        "      Example: brain connect imap <manifest> --host imap.mail.yahoo.com --user you@yahoo.com"
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) die("--port must be a whole number between 1 and 65535.");

  for (const line of imap.providerNotes(host)) console.log(`  ${line}`);
  if (imap.providerNotes(host).length) console.log("");

  // Read hidden, normalize, never echo.
  const read = options.readSecret ?? readHiddenSecret;
  const password = imap.normalizeAppPassword(
    await read(`  app password for ${username} (hidden): `)
  );
  if (!password) die("no password was entered. Nothing was stored.");

  info(`checking these credentials against ${host}:${port}`);
  let probe;
  try {
    probe = await imap.probeMailbox({ host, port, username, password, socketFactory: options.socketFactory ?? null });
  } catch (error) {
    die(`${String(error?.message || error).slice(0, 300)}\n      Nothing was stored.`);
  }
  if (!probe.ok) {
    die(`${probe.notes.join("\n      ") || "the mailbox could not be read"}\n      Nothing was stored.`);
  }
  for (const note of probe.notes) warn(note);
  ok(
    `signed in and read the mailbox: ${probe.folders.length} folder(s), inbox UIDVALIDITY ${probe.uidvalidity}, ` +
      `${probe.messages} message(s) in ${probe.inbox}` + (probe.readOne ? ", one read back in full" : "")
  );
  if (probe.unlisted.length) {
    warn(`${probe.unlisted.length} folder(s) were identified but will NOT be read, because only inbox and sent are: ${probe.unlisted.join(", ")}`);
  }
  if (probe.unclassified.length) {
    warn(`${probe.unclassified.length} folder(s) could not be identified and will NOT be read: ${probe.unclassified.join(", ")}`);
  }

  imap.saveImapCredentials({ host, port, username, password }, { sourceName });
  ok(`mailbox credential stored in ${imap.imapCredentialStorageDescription({ sourceName })} (on this machine only)`);

  // Register the source before a single message has landed, so it is visible
  // and undoable immediately rather than only after a successful first sync.
  try {
    const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
    const adminKey = resolveKey(manifestPath);
    if (!adminKey) throw new Error("no admin key is available");
    const resolveAcct = options.resolveAccount ?? resolveAccount;
    const acct = m.brain?.domain ? null : await resolveAcct(m);
    const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
    const base = await resolveBase(m, acct);
    const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
    await postExpectation(base, adminKey, { source: sourceName, kind: "imap", expected_refresh_seconds: null });
  } catch (error) {
    warn(
      `the mailbox is connected, but the named source could not be registered up front: ${String(error?.message || error).slice(0, 160)}\n` +
        "      Harmless: the first sync registers it."
    );
  }

  console.log("");
  info(`now run: brain ingest ${manifestPath} --from imap --source ${sourceName}`);
  info(`to remove this later: brain disconnect imap ${manifestPath} --source ${sourceName}`);
  return { host, port, username, sourceName, folders: probe.folders.length };
}

/**
 * brain disconnect imap <manifest> — forget the mailbox password.
 *
 * Removing the credential is what actually turns this off: the next sync
 * refuses by name rather than quietly doing nothing. Mail already loaded stays
 * in the brain and is removed with `brain forget --source`, which is said out
 * loud because a client who thinks disconnecting deleted their mail, or thinks
 * it did not, is wrong in a way that matters either direction.
 */
export async function cmdDisconnectImap(manifestPath, flags = {}, options = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain disconnect imap <manifest> [--source <name>]");
  }
  const imap = options.imap ?? await import("./connectors/imap.mjs");
  const sourceName = assertSourceName(flags.source === true || !flags.source ? "imap" : flags.source);
  const removed = imap.removeImapCredentials({ sourceName });
  ok(removed
    ? `the mailbox app password for "${sourceName}" was removed from ${imap.imapCredentialStorageDescription({ sourceName })}`
    : `no mailbox credential was stored for "${sourceName}"; nothing to remove`);

  console.log("");
  console.log("  Also revoke it on the provider's side, which is yours and not reachable from here:");
  console.log("    delete the app password in your mail account's security settings.");
  console.log("");
  info(`mail already loaded remains in the brain; remove it with: brain forget ${manifestPath} --source ${sourceName}`);
  return { removed, sourceName };
}

/**
 * Read one mailbox app password, hidden.
 *
 * The same core every other secret prompt uses, with two deliberate
 * differences. A SPACE is accepted, because providers display an app password
 * in groups of four and people paste exactly what they see; the spaces are
 * stripped afterwards by `normalizeAppPassword`. And bytes above ASCII are
 * accepted, because a password on a mailbox somebody's host set up is not
 * required to be ASCII, and refusing one at the keystroke would look, to the
 * person typing, exactly like the provider rejecting them.
 */
export function readHiddenSecret(promptText, { input = process.stdin, output = process.stderr, maxBytes = 512 } = {}) {
  return readHiddenInput({
    prompt: promptText,
    input,
    output,
    maxBytes,
    noun: "password",
    insecure:
      "this terminal cannot prompt securely, and a mailbox password is never accepted as a flag " +
      "or an environment variable. Rerun from an interactive terminal.",
    accepts: (byte) => byte >= 0x20 && byte !== 0x7f,
    finalize: (bytes) => bytes.toString("utf-8"),
  });
}

/**
 * brain disconnect — the first disconnect verb in this CLI.
 *
 * Same posture as removeDriveScheduler: removal must remain reachable even
 * when the manifest's corpus flag is already off or missing, because
 * requiring the operator to first declare the thing they are turning off
 * would strand the already-loaded LaunchAgent.
 */
async function cmdDisconnect(target) {
  const flags = parseFlags(process.argv.slice(3));
  const which = (target || "").toLowerCase();
  if (which === "whatsapp") return cmdDisconnectWhatsapp(process.argv[4], flags);
  if (which === "zoom") return cmdDisconnectZoom(process.argv[4], flags);
  if (which === "imap") return cmdDisconnectImap(process.argv[4], flags);
  if (which !== "imessage") {
    die(
      "brain disconnect supports imap, imessage, whatsapp and zoom.\n" +
        "  Usage: brain disconnect imap <manifest>\n" +
        "         brain disconnect imessage <manifest>\n" +
        "         brain disconnect whatsapp <manifest>\n" +
        "         brain disconnect zoom <manifest>"
    );
  }
  return cmdDisconnectImessage(process.argv[4], flags);
}

export async function cmdDisconnectImessage(manifestPath, flags = {}, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    die("the iMessage capture LaunchAgent only exists on macOS, so there is nothing to disconnect here.");
  }
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain disconnect imessage <manifest>");
  }
  const { m } = loadManifest(manifestPath);
  const scheduler = options.imessageScheduler ?? await import("./operations/imessage-scheduler.mjs");

  // Step 1: stop the agent first, so no tick races the final flush below.
  const removed = scheduler.removeImessageScheduler(manifestPath, options.schedulerOptions || {});
  ok(removed.removed || removed.loaded ? "iMessage capture removed" : "iMessage capture was not installed");
  info(`logs preserved at ${removed.stdoutPath} and ${removed.stderrPath}`);

  // Step 2: flush still-open sessions so the last conversations become
  // searchable instead of sitting in the state snapshot forever. Best-effort:
  // a missing key or unreachable brain must not make removal unreachable.
  try {
    await cmdIngestImessage(m, manifestPath, { "flush-sessions": true }, options);
  } catch (error) {
    warn(
      "capture is stopped, but the final open-session flush did not complete: " +
        `${String(error?.message || error).slice(0, 200)}\n` +
        "      Nothing is lost; re-run `brain ingest " + manifestPath + " --from imessage --flush-sessions` when the brain is reachable."
    );
  }

  // Step 3: clear the freshness expectation, so a deliberately disconnected
  // source is not forever reported as stale. Also best-effort, same reason.
  try {
    const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
    const adminKey = resolveKey(manifestPath);
    if (!adminKey) throw new Error("no admin key is available");
    const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
    const base = await resolveBase(m, null);
    const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
    await postExpectation(base, adminKey, {
      source: "imessage", kind: "imessage", expected_refresh_seconds: null,
    });
    ok("iMessage freshness expectation cleared");
  } catch (error) {
    warn(`capture is removed, but its remote freshness expectation could not be cleared: ${String(error?.message || error).slice(0, 160)}`);
  }
  info("captured conversations remain in the brain; remove them with: brain forget " + manifestPath + " --source imessage");
  return removed;
}

/**
 * brain disconnect whatsapp <manifest> — stop capture and undo the install.
 *
 * Same posture as the iMessage and Drive removals: every step stays reachable
 * when the manifest's corpus flag is already off, when the daemon binary has
 * been deleted, and when the brain is unreachable. Requiring the operator to
 * re-declare the thing they are switching off would strand a loaded
 * LaunchAgent, and a network failure must never be the reason a background
 * process cannot be stopped.
 *
 * Order matters: stop the drain tick first so nothing races the final pass,
 * then stop the daemon so nothing new is captured mid-flush, then drain what
 * the outbox still holds and close the conversations left open. The last steps
 * are best-effort by design.
 *
 * What is deliberately NOT removed: the linked-device session (deleting it
 * un-pairs the account, which the owner may not want) and the outbox itself.
 * The pairing is ended from the phone, under Linked Devices, which is the only
 * place WhatsApp treats as authoritative anyway.
 */
export async function cmdDisconnectWhatsapp(manifestPath, flags = {}, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    die("the WhatsApp capture LaunchAgents only exist on macOS, so there is nothing to disconnect here.");
  }
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain disconnect whatsapp <manifest>");
  }
  const { m } = loadManifest(manifestPath);
  const daemonAgent = options.whatsappDaemon ?? await import("./operations/whatsapp-daemon.mjs");
  const drainScheduler = options.whatsappDrainScheduler ?? await import("./operations/whatsapp-drain-scheduler.mjs");

  // Step 1: the drain tick, so no scheduled pass races the final one below.
  const drainRemoved = drainScheduler.removeWhatsappDrainScheduler(manifestPath, options.schedulerOptions || {});
  ok(drainRemoved.removed || drainRemoved.loaded ? "WhatsApp drain schedule removed" : "the WhatsApp drain schedule was not installed");

  // Step 2: the daemon itself. Nothing new reaches the outbox after this.
  const daemonRemoved = daemonAgent.removeWhatsappDaemon(manifestPath, {
    ...(options.daemonOptions || {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  });
  ok(daemonRemoved.removed || daemonRemoved.wasLoaded ? "capture daemon stopped and removed" : "the capture daemon was not installed");
  info(`daemon logs preserved at ${daemonRemoved.stdoutPath} and ${daemonRemoved.stderrPath}`);

  // Step 3: load whatever the daemon captured but the drain had not reached,
  // then close still-open conversations so dormant threads stay searchable.
  // Best-effort: a missing key or an unreachable brain must not make removal
  // unreachable.
  try {
    await cmdIngestWhatsapp(m, manifestPath, {}, options);
    await cmdIngestWhatsapp(m, manifestPath, { "flush-sessions": true }, options);
  } catch (error) {
    warn(
      "capture is stopped, but the final drain and flush did not complete: " +
        `${String(error?.message || error).slice(0, 200)}\n` +
        "      Nothing is lost; re-run `brain ingest " + manifestPath + " --from whatsapp` when the brain is reachable."
    );
  }

  // Step 4: clear the freshness expectation, so a deliberately disconnected
  // source is not forever reported as stale. Also best-effort, same reason.
  try {
    const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
    const adminKey = resolveKey(manifestPath);
    if (!adminKey) throw new Error("no admin key is available");
    const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
    const base = await resolveBase(m, null);
    const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
    await postExpectation(base, adminKey, {
      source: "whatsapp", kind: "whatsapp", expected_refresh_seconds: null,
    });
    ok("WhatsApp freshness expectation cleared");
  } catch (error) {
    warn(`capture is removed, but its remote freshness expectation could not be cleared: ${String(error?.message || error).slice(0, 160)}`);
  }
  info("the phone is still linked to this machine; end that under WhatsApp, Settings, Linked Devices");
  info("captured conversations remain in the brain; remove them with: brain forget " + manifestPath + " --source whatsapp");
  return { daemon: daemonRemoved, drain: drainRemoved };
}

/**
 * brain disconnect zoom <manifest> — stop reading Zoom transcripts.
 *
 * Deleting ZOOM_WEBHOOK_SECRET_TOKEN is what actually turns this off: the route
 * fails closed without it, so a delivery that arrives after this point is
 * refused rather than quietly ingested. That is why the secret removal is the
 * step that must succeed, and the two housekeeping steps after it are
 * best-effort — a brain that is unreachable right now must never make
 * disconnecting unreachable too.
 *
 * The Event Subscription itself lives in the client's Zoom app and is theirs to
 * remove. We say so plainly rather than pretending this reaches into Zoom.
 */
export async function cmdDisconnectZoom(manifestPath, flags = {}, options = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    die("usage: brain disconnect zoom <manifest>");
  }
  const { m } = loadManifest(manifestPath);
  const zoom = options.zoom ?? await import("./connectors/zoom.mjs");
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  const resolveAcct = options.resolveAccount ?? resolveAccount;
  const acct = await resolveAcct(m);
  const deleteSecret = options.deleteWorkerSecret ?? ((account, script, name) =>
    cf(`/accounts/${account.id}/workers/scripts/${script}/secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }));

  const removed = [];
  const kept = [];
  for (const name of zoom.ZOOM_CREDENTIAL_ENV) {
    try {
      await deleteSecret(acct, scriptName, name);
      removed.push(name);
    } catch (e) {
      // Already gone is the desired state, not a failure.
      if (/does not exist/i.test(e.message) || /\(404\)/.test(e.message)) continue;
      kept.push(`${name} (${e.message.slice(0, 100)})`);
    }
  }
  if (kept.length) {
    die(
      `these Zoom secrets could not be removed from ${scriptName}: ${kept.join(", ")}\n` +
        "      Zoom may still be able to deliver transcripts. Fix Cloudflare access and rerun."
    );
  }
  ok(removed.length
    ? `Zoom secrets removed from ${scriptName}; the webhook now refuses every delivery`
    : "no Zoom secrets were set on this worker; nothing to remove");

  // Best-effort from here. Removal must stay reachable even when the brain is not.
  try {
    const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
    const adminKey = resolveKey(manifestPath);
    if (!adminKey) throw new Error("no admin key is available");
    const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
    const base = await resolveBase(m, acct);
    const postExpectation = options.postSourceExpectation ?? postSourceExpectation;
    await postExpectation(base, adminKey, {
      source: "zoom", kind: "zoom", expected_refresh_seconds: null,
    });
  } catch (error) {
    warn(`Zoom is disconnected, but its source record could not be updated: ${String(error?.message || error).slice(0, 160)}`);
  }

  console.log("");
  console.log("  Also remove it on the Zoom side, which is yours and not reachable from here:");
  console.log("    marketplace.zoom.us > Manage > your Server-to-Server OAuth app > Feature");
  console.log("    Remove the Event Subscription, or deactivate the app entirely.");
  console.log("");
  info("transcripts already loaded remain in the brain; remove them with: brain forget " + manifestPath + " --source zoom");
  return { removed, scriptName };
}

/** The token provider for a stored Google connection, or a clear refusal. */
function googleAuth(needed) {
  const store = loadTokens().google;
  if (!store?.refresh_token) {
    die("no Google connection on this machine. Run `brain connect google --scopes drive,gmail` first.");
  }
  if (needed && !store.scopes?.includes(needed)) {
    die(
      `the stored Google connection does not include the "${needed}" scope (it has: ${(store.scopes || []).join(", ")}).\n` +
        `  Reconnect with: brain connect google --scopes ${[...new Set([...(store.scopes || []), needed])].join(",")}`
    );
  }
  return createTokenProvider({
    clientId: store.client_id,
    clientSecret: store.client_secret,
    refreshToken: store.refresh_token,
  });
}


/**
 * brain doctor — everything that must be true before an install, checked up front.
 *
 * Non-destructive: it creates nothing. Its whole value is finding in advance the
 * problems that otherwise appear live, in front of a client, in the first ten
 * minutes of a session.
 */
/**
 * Read-only probe of whether a DEPLOYED brain is currently paused mid-upgrade.
 *
 * Deliberately tolerant, the same way checkVectorizeApi in doctor.mjs is: this
 * runs as part of `brain doctor <manifest>`, which has always worked without a
 * Cloudflare token. A brain with a custom domain answers /health with no token
 * at all; one without needs an account lookup first, which does need a token.
 * Either way, any failure here is reported back as "not checked", never thrown,
 * so a stuck-upgrade check can never be the reason `brain doctor` itself dies.
 *
 * WHY THIS EXISTS: before this, nothing on the CLI side ever looked at
 * vector_drain_mode. 0.1.19 made /health itself honest (accepting_documents:
 * false while paused), but `brain doctor` — the one command whose whole job is
 * telling an operator what is wrong — never read that field. A brain could sit
 * paused for nine days and a `brain doctor <manifest>` run would report "ready
 * to install" and say nothing about it, because doctor had never been taught to
 * ask a deployed brain about its OWN state, only about the local machine's.
 */
export async function probeUpgradePause(manifestPath, options = {}) {
  let m;
  try {
    ({ m } = (options.loadManifest ?? loadManifest)(manifestPath));
  } catch (error) {
    return { checked: false, reason: `manifest could not be read: ${String(error?.message || error).slice(0, 160)}` };
  }

  let base;
  try {
    const resolveProbeAccount = options.resolveAccount ?? resolveAccount;
    const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
    const acct = m.brain?.domain ? null : await resolveProbeAccount(m);
    base = await resolveBase(m, acct);
  } catch (error) {
    return { checked: false, reason: `could not resolve this install's URL: ${String(error?.message || error).slice(0, 160)}` };
  }
  if (!base) return { checked: false, reason: "could not determine a URL for this install" };

  let res, text;
  try {
    res = await (options.http ?? http)(`${base}/health`, {}, { timeoutMs: 15_000, what: "the health check" });
    text = await res.text();
  } catch (error) {
    return { checked: false, reason: `could not reach ${base}/health: ${String(error?.message || error).slice(0, 160)}` };
  }

  let body = null;
  try { body = JSON.parse(text); } catch { /* raw text is still returned below */ }
  if (!res.ok || !body || typeof body !== "object") {
    return { checked: false, reason: `/health returned ${res.status} with an unreadable body`, base };
  }

  const paused = body.vector_drain_mode === "paused-for-upgrade" || body.accepting_documents === false;
  return { checked: true, paused, body, raw: text, base };
}

/**
 * Everything `brain doctor <manifest> --repair` needs to explain a stuck
 * upgrade precisely instead of vaguely: which stage it died at, since when,
 * and the exact D1 recovery bookmark captured before that migration ran.
 * Read-only; enrichment on top of probeUpgradePause, never a replacement for
 * it, so a D1 lookup failure still reports the pause itself accurately.
 */
export async function diagnoseStuckUpgrade(manifestPath, options = {}) {
  const probe = await (options.probeUpgradePause ?? probeUpgradePause)(manifestPath, options);
  if (!probe.checked || !probe.paused) return probe;

  const { m } = (options.loadManifest ?? loadManifest)(manifestPath);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  const resolveDiagnoseAccount = options.resolveAccount ?? resolveAccount;
  const queryDatabase = options.d1Query ?? d1Query;

  let lastRun = null;
  let installRow = null;
  let detailError = null;
  if (dbId) {
    try {
      const acct = await resolveDiagnoseAccount(m);
      const runs = await queryDatabase(
        acct.id, dbId,
        "SELECT started_at, finished_at, from_version, to_version, status, d1_bookmark, detail FROM upgrade_runs ORDER BY started_at DESC LIMIT 1",
      );
      lastRun = runs?.results?.[0] || null;
      const state = await queryDatabase(acct.id, dbId, "SELECT * FROM install_state WHERE id = 1");
      installRow = state?.results?.[0] || null;
    } catch (error) {
      detailError = String(error?.message || error).slice(0, 160);
    }
  } else {
    detailError = "manifest has no d1_database_id";
  }

  const stage = lastRun?.detail && /^stage:/.test(lastRun.detail)
    ? lastRun.detail.slice("stage:".length)
    : null;
  const pausedSinceMs = lastRun?.started_at ? Date.parse(lastRun.started_at) : null;
  const pausedForMs = Number.isFinite(pausedSinceMs) ? Date.now() - pausedSinceMs : null;

  return { ...probe, lastRun, installRow, stage, pausedSinceMs, pausedForMs, detailError };
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} minute(s)`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour(s)`;
  return `${Math.round(hours / 24)} day(s)`;
}

function printStuckUpgradeDiagnosis(diagnosis) {
  console.log("");
  if (!diagnosis.checked) {
    warn(`could not check this brain's live upgrade state: ${diagnosis.reason}`);
    return;
  }
  if (!diagnosis.paused) {
    ok("this brain is accepting documents; it is not paused for an upgrade.");
    return;
  }
  console.log(`  ${c.red("this brain cannot accept documents right now")}`);
  console.log("  An update paused its corpus writes for a schema migration and did not finish.");
  if (diagnosis.stage) console.log(`    stopped at stage:     ${diagnosis.stage}`);
  if (diagnosis.lastRun?.from_version || diagnosis.lastRun?.to_version) {
    console.log(`    upgrade:              ${diagnosis.lastRun.from_version || "?"} -> ${diagnosis.lastRun.to_version || "?"}`);
  }
  if (diagnosis.lastRun?.started_at) {
    console.log(`    paused since:         ${diagnosis.lastRun.started_at} (${humanDuration(diagnosis.pausedForMs)} ago)`);
  }
  if (diagnosis.lastRun?.d1_bookmark) console.log(`    D1 recovery bookmark: ${diagnosis.lastRun.d1_bookmark}`);
  if (diagnosis.detailError) console.log(`    (could not read the full upgrade_runs detail: ${diagnosis.detailError})`);
  console.log("");
}

/**
 * `brain doctor <manifest> --repair` / `--rollback`.
 *
 * There is exactly one safe way to resume: replay the same verified upgrade
 * path (`brain update`). It is idempotent and restart-safe by construction —
 * see cmdMigrate's per-statement resume and cmdUpgrade's stage-by-stage
 * die()s, both already proven under test — so repair does not reimplement
 * that logic. It gives the stuck case its own named, precise entry point
 * instead of leaving an operator to reconstruct "run brain update again" out
 * of a wall of error text, which is exactly the gap that left a field
 * install paused for nine days with nothing telling the operator what to
 * do about it.
 *
 * Rollback is the other safe path: restore D1 to the exact bookmark this
 * stuck run itself captured before it touched the schema. Previously the
 * operator had to copy that bookmark by hand out of the die() message or the
 * upgrade_runs table before running `brain rollback`; --rollback reads it
 * straight from D1 instead.
 */
export async function cmdDoctorRepair(manifestPath, options = {}) {
  const action = options.action === "rollback" ? "rollback" : "repair";
  const confirmed = options.confirmed === true;
  const diagnose = options.diagnoseStuckUpgrade ?? diagnoseStuckUpgrade;
  const runUpgrade = options.cmdUpgrade ?? cmdUpgrade;
  const runRollback = options.cmdRollback ?? cmdRollback;

  const diagnosis = await diagnose(manifestPath, options.diagnoseOptions || {});
  printStuckUpgradeDiagnosis(diagnosis);

  if (!diagnosis.checked) {
    die(`could not determine this brain's upgrade state: ${diagnosis.reason}`);
  }
  if (!diagnosis.paused) {
    return { paused: false };
  }

  if (action === "rollback") {
    const bookmark = diagnosis.lastRun?.d1_bookmark;
    if (!bookmark) {
      die(
        "this brain is paused, but no D1 restore bookmark could be found in upgrade_runs for the\n" +
          "      failed run, so an automatic rollback has no safe target.\n" +
          "      Resume instead: brain doctor <manifest> --repair --yes\n" +
          "      Or find the bookmark yourself and run: brain rollback <manifest> <bookmark>",
      );
    }
    if (!confirmed) {
      warn("rollback preview only: nothing was changed.");
      info(`Re-run with --yes to restore D1 to bookmark ${bookmark}, captured just before this migration.`);
      info("This restores D1 only; Vectorize needs supervised recreation before reindex, same as `brain rollback`.");
      return { paused: true, previewed: "rollback", bookmark };
    }
    return runRollback(manifestPath, bookmark, { confirmed: true });
  }

  if (!confirmed) {
    warn("repair preview only: nothing was changed.");
    info("Re-run with --yes to resume: this replays the same verified upgrade path (`brain update`),");
    info("which resumes safely from wherever the stuck run stopped.");
    return { paused: true, previewed: "repair" };
  }
  return runUpgrade(manifestPath, options.upgradeOptions || {});
}

/**
 * Everything `brain doctor <manifest> --repair-checksum` needs to reconcile
 * an APPLIED migration whose file content no longer matches what ran.
 *
 * This is a different failure than probeUpgradePause/cmdDoctorRepair above
 * cover, and it needs its own path rather than folding into --repair:
 * cmdMigrate's checksum guard (`checksum !== mig.checksum`, above) fires
 * BEFORE any pending migration is even considered, unconditionally, with no
 * force flag anywhere in the file. Replaying cmdUpgrade (what --repair does)
 * walks straight back into that same die() and re-strands the install — this
 * is not a resume/rollback situation at all. The install is not mid-
 * migration; an already-applied migration's bytes drifted afterward (a
 * line-ending change is the confirmed cause on the one real install stuck
 * this way — see evidence/WP-00-checksum-reconciliation.md), so the fix is
 * neither "run the SQL again" nor "restore a snapshot" — it is "the schema is
 * presumably already in the state this edited file describes; show exactly
 * what changed, and once a human accepts it, update the STORED checksum to
 * match, without touching the schema at all."
 *
 * Read-only; deliberately tolerant of every resolution failure (missing
 * dbId, no Cloudflare token, a D1 outage), same as probeUpgradePause, so this
 * can run unconditionally as part of plain `brain doctor <manifest>` and
 * catch the drift BEFORE an operator ever runs `brain update` and gets
 * stranded by it — which is exactly how this reached a live install with no
 * warning anywhere.
 */
export async function diagnoseChecksumDrift(manifestPath, options = {}) {
  let m;
  try {
    ({ m } = (options.loadManifest ?? loadManifest)(manifestPath));
  } catch (error) {
    return { checked: false, reason: `manifest could not be read: ${String(error?.message || error).slice(0, 160)}` };
  }

  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) return { checked: false, reason: "no d1_database_id in the manifest" };

  let acct;
  try {
    acct = await (options.resolveAccount ?? resolveAccount)(m);
  } catch (error) {
    return {
      checked: false,
      reason: `could not resolve this install's Cloudflare account: ${String(error?.message || error).slice(0, 160)}`,
    };
  }

  // Deliberately NOT reusing the shared appliedVersions() helper here: it
  // swallows every query failure into an empty list ("table does not exist
  // yet, so nothing is applied" — correct for cmdMigrate, which only cares
  // whether it is safe to proceed). This check exists to REPORT drift
  // honestly, so a real query failure must degrade to checked:false, not to
  // a confident "zero drift found" — the exact "degraded state presented as
  // a confident negative" the product's honesty rules forbid. A missing
  // table is the one failure that legitimately does mean zero applied
  // migrations (a brand new install, never yet migrated), so that specific
  // case alone is treated as empty rather than as a check failure.
  const queryDatabase = options.d1Query ?? d1Query;
  let applied;
  try {
    const r = await queryDatabase(acct.id, dbId, "SELECT version, checksum, name FROM schema_migrations");
    applied = r?.results || [];
  } catch (error) {
    const message = String(error?.message || error);
    if (/no such table/i.test(message)) {
      applied = [];
    } else {
      return { checked: false, reason: `could not read schema_migrations: ${message.slice(0, 160)}` };
    }
  }
  const appliedMap = new Map(applied.map((a) => [a.version, a]));

  let migrations;
  try {
    migrations = (options.loadMigrations ?? loadMigrations)();
  } catch (error) {
    return { checked: false, reason: `could not read local migration files: ${String(error?.message || error).slice(0, 160)}` };
  }

  const drift = [];
  for (const mig of migrations) {
    const prev = appliedMap.get(mig.version);
    if (prev && prev.checksum !== mig.checksum) {
      drift.push(describeChecksumDrift(mig, prev));
    }
  }

  return { checked: true, drift, acctId: acct.id, dbId };
}

/**
 * The one thing worth trying to confirm automatically: is this drift EXACTLY
 * a line-ending change and nothing else? The confirmed cause on the one real
 * install stranded by this bug so far, and the only class of drift this tool
 * can positively confirm without the original applied bytes (only their
 * checksum was ever stored, by design — see cmdMigrate's INSERT INTO
 * schema_migrations above). Both directions are checked because either the
 * applied version or today's file could be the CRLF one.
 */
function describeChecksumDrift(mig, prev) {
  const hashOf = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const asLF = mig.sql.replace(/\r\n/g, "\n");
  const asCRLF = asLF.replace(/\n/g, "\r\n");

  let lineEndingExplanation = null;
  if (hashOf(asLF) === prev.checksum) {
    lineEndingExplanation =
      'a pure line-ending change: the applied migration was recorded with LF ("\\n") line endings; ' +
      'the current file uses CRLF ("\\r\\n") instead. Converting this file\'s CRLF to LF reproduces ' +
      `the applied checksum exactly (${prev.checksum}) — the SQL content itself did not change.`;
  } else if (hashOf(asCRLF) === prev.checksum) {
    lineEndingExplanation =
      'a pure line-ending change: the applied migration was recorded with CRLF ("\\r\\n") line endings; ' +
      'the current file uses LF ("\\n") only. Converting this file\'s LF to CRLF reproduces the applied ' +
      `checksum exactly (${prev.checksum}) — the SQL content itself did not change.`;
  }

  return {
    version: mig.version,
    name: mig.name,
    appliedChecksum: prev.checksum,
    appliedAt: prev.applied_at || null,
    fileChecksum: mig.checksum,
    fileBytes: Buffer.byteLength(mig.sql, "utf-8"),
    fileLines: mig.sql.split(/\r\n|\n/).length,
    lineEndingExplanation,
  };
}

function printChecksumDriftDiagnosis(diagnosis) {
  console.log("");
  if (!diagnosis.checked) {
    warn(`could not check applied migrations for checksum drift: ${diagnosis.reason}`);
    return;
  }
  if (!diagnosis.drift.length) {
    ok("every applied migration's checksum matches its file. Nothing to reconcile.");
    return;
  }
  for (const entry of diagnosis.drift) {
    console.log(`  ${c.red(entry.name)}  ${c.dim(`(schema_migrations version ${entry.version})`)}`);
    console.log(`    applied at:        ${entry.appliedAt || "unknown"}`);
    console.log(`    applied checksum:  ${entry.appliedChecksum}`);
    console.log(`    file checksum:     ${entry.fileChecksum}`);
    console.log(`    current file:      ${entry.fileLines} line(s), ${entry.fileBytes} byte(s)`);
    if (entry.lineEndingExplanation) {
      console.log(`    ${c.yellow("likely cause:")} ${entry.lineEndingExplanation}`);
    } else {
      console.log(`    ${c.yellow("likely cause:")} not confirmable as a pure line-ending change.`);
      console.log("      The bytes this migration originally applied were never retained — only their");
      console.log(`      checksum was. Review ${entry.name} by hand (your own version control history for`);
      console.log("      this file, if any, is the fastest way) before confirming reconciliation.");
    }
    console.log("");
  }
}

/**
 * Update `schema_migrations`'s stored checksum(s) to match the CURRENT file,
 * for exactly the drift entries the caller already confirmed. Deliberately
 * does not touch anything else: no migration SQL runs, no other column
 * changes, no row is inserted or deleted. The schema is presumably already
 * in (or close to) the state the edited file describes; replaying its SQL
 * blindly risks a second, different kind of corruption on top of the drift
 * that caused this in the first place — see cmdMigrate's own comment on the
 * checksum guard above for why that guard exists at all.
 */
export async function applyChecksumReconciliation(manifestPath, drift, options = {}) {
  const resolveReconcileAccount = options.resolveAccount ?? resolveAccount;
  const queryDatabase = options.d1Query ?? d1Query;
  const { m } = (options.loadManifest ?? loadManifest)(manifestPath);
  const acct = await resolveReconcileAccount(m);
  const dbId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!dbId) die("no d1_database_id in the manifest.");

  const reconciled = [];
  for (const entry of drift) {
    await queryDatabase(
      acct.id,
      dbId,
      "UPDATE schema_migrations SET checksum = ? WHERE version = ?",
      [entry.fileChecksum, entry.version],
    );
    reconciled.push({ version: entry.version, name: entry.name, checksum: entry.fileChecksum });
  }
  return { reconciled, count: reconciled.length };
}

/**
 * `brain doctor <manifest> --repair-checksum`.
 *
 * Preview by default; acts only on --yes; the diagnosis is always printed in
 * full first, exactly like cmdDoctorRepair, so a confirmation is never given
 * blind. There is no "action" branch here the way cmdDoctorRepair has
 * repair/rollback — there is exactly one thing this command does, on exactly
 * the set of migrations that actually drifted.
 */
export async function cmdRepairChecksum(manifestPath, options = {}) {
  const confirmed = options.confirmed === true;
  const diagnose = options.diagnoseChecksumDrift ?? diagnoseChecksumDrift;
  const applyReconciliation = options.applyChecksumReconciliation ?? applyChecksumReconciliation;

  const diagnosis = await diagnose(manifestPath, options.diagnoseOptions || {});
  printChecksumDriftDiagnosis(diagnosis);

  if (!diagnosis.checked) {
    die(`could not check applied migrations for checksum drift: ${diagnosis.reason}`);
  }
  if (!diagnosis.drift.length) {
    return { drift: [] };
  }

  if (!confirmed) {
    warn("repair-checksum preview only: nothing was changed.");
    info("Re-run with --yes to accept the current file content for the migration(s) above and update");
    info("schema_migrations to match. This does NOT re-run any migration SQL and does not touch the schema.");
    return { drift: diagnosis.drift, previewed: "repair-checksum" };
  }

  const result = await applyReconciliation(manifestPath, diagnosis.drift, options.applyOptions || {});
  for (const entry of result.reconciled) {
    ok(`schema_migrations reconciled: ${entry.name} now recorded as ${entry.checksum}`);
  }
  return { ...result, drift: diagnosis.drift };
}

/** The one extra doctor check that reads a DEPLOYED brain instead of this machine. */
async function buildUpgradePauseCheck(manifestPath, options = {}) {
  let probe;
  try {
    probe = await (options.probeUpgradePause ?? probeUpgradePause)(manifestPath, options);
  } catch (error) {
    probe = { checked: false, reason: String(error?.message || error).slice(0, 160) };
  }
  if (!probe.checked) {
    return { name: "upgrade state", status: D_WARN, detail: `not checked: ${probe.reason}` };
  }
  if (probe.paused) {
    return {
      name: "upgrade state",
      status: D_FAIL,
      detail: "paused for an upgrade; this brain cannot accept documents",
      fix:
        "Diagnose exactly where it stopped: brain doctor <manifest> --repair\n" +
        "  That resumes the same verified upgrade path once you confirm with --yes.\n" +
        "  To restore the pre-migration snapshot instead: brain doctor <manifest> --rollback",
    };
  }
  return { name: "upgrade state", status: D_OK, detail: "accepting documents" };
}

/**
 * The doctor check for plain `brain doctor <manifest>` (no flags): catches an
 * applied migration's checksum drift BEFORE an operator ever runs
 * `brain update` and gets stranded by cmdMigrate's unconditional checksum
 * guard — which is exactly how this reached a live install with zero
 * warning. Independent of buildUpgradePauseCheck above: this drift can exist
 * (and be worth fixing) even on a brain that is not currently paused for an
 * upgrade at all.
 */
async function buildChecksumDriftCheck(manifestPath, options = {}) {
  let diagnosis;
  try {
    diagnosis = await (options.diagnoseChecksumDrift ?? diagnoseChecksumDrift)(manifestPath, options);
  } catch (error) {
    diagnosis = { checked: false, reason: String(error?.message || error).slice(0, 160) };
  }
  if (!diagnosis.checked) {
    return { name: "migration checksums", status: D_WARN, detail: `not checked: ${diagnosis.reason}` };
  }
  if (diagnosis.drift.length) {
    const names = diagnosis.drift.map((d) => d.name).join(", ");
    return {
      name: "migration checksums",
      status: D_FAIL,
      detail: `${diagnosis.drift.length} applied migration(s) no longer match their file: ${names}`,
      fix:
        "An applied migration's file content changed after it ran (often just a line-ending change).\n" +
        "  This is a different problem than a stuck upgrade, and --repair will NOT fix it — it replays\n" +
        "  the same checksum check and fails the same way. Reconcile the stored checksum instead:\n" +
        "  brain doctor <manifest> --repair-checksum          (preview, changes nothing)\n" +
        "  brain doctor <manifest> --repair-checksum --yes    (accept the current file, update schema_migrations)",
    };
  }
  return { name: "migration checksums", status: D_OK, detail: "every applied migration matches its file" };
}

async function cmdDoctor(manifestPath) {
  let accountId;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      accountId = loadManifest(manifestPath).m?.infrastructure?.cloudflare?.account_id;
    } catch { /* doctor must work without a valid manifest */ }
  }

  console.log(`\n  ${c.bold("brain doctor")}${accountId ? c.dim(`  account ${accountId}`) : ""}\n`);
  info("checking your machine. The Cloudflare checks download a tool on first run,");
  info("so the first time can take a couple of minutes. Each line appears as it finishes.\n");

  // Printed as each check completes, not collected and dumped at the end.
  // Otherwise a first run sits silent for minutes while npx fetches wrangler,
  // and silence is indistinguishable from a hang to the person watching.
  const checks = await withAvailableCloudflareToken(
    () => doctorRunAll({
      accountId,
      cloudflareToken: activeCloudflareToken(),
      onResult: (x) => {
        const mark = x.status === D_OK ? c.green("ok  ") : x.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
        console.log(`  ${mark}  ${x.name.padEnd(18)}  ${x.detail}`);
      },
    }),
    {
      accountId,
      onStorageError: (error) => warn(String(error?.message || error)),
    },
  );

  // An install-state check, not a machine-readiness check: only meaningful
  // once a manifest names a real, presumably-deployed brain.
  if (manifestPath && existsSync(manifestPath)) {
    const upgradeCheck = await buildUpgradePauseCheck(manifestPath);
    checks.push(upgradeCheck);
    const mark = upgradeCheck.status === D_OK ? c.green("ok  ") : upgradeCheck.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
    console.log(`  ${mark}  ${upgradeCheck.name.padEnd(18)}  ${upgradeCheck.detail}`);

    const checksumCheck = await buildChecksumDriftCheck(manifestPath);
    checks.push(checksumCheck);
    const checksumMark = checksumCheck.status === D_OK ? c.green("ok  ") : checksumCheck.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
    console.log(`  ${checksumMark}  ${checksumCheck.name.padEnd(18)}  ${checksumCheck.detail}`);

    // Offline and cheap, so it runs here rather than at connect time. The one
    // bank-feed failure that is unrecoverable in front of a client is a return
    // address nobody registered.
    try {
      const feedCheck = checkBankFeedRedirect(loadManifest(manifestPath).m);
      checks.push(feedCheck);
      const feedMark = feedCheck.status === D_OK ? c.green("ok  ") : feedCheck.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
      console.log(`  ${feedMark}  ${feedCheck.name.padEnd(18)}  ${feedCheck.detail}`);
    } catch { /* doctor must work without a valid manifest */ }
  }

  const s = doctorSummarize(checks);
  console.log("");
  const needFix = checks.filter((x) => x.status !== D_OK && x.fix);
  if (needFix.length) {
    console.log(`  ${c.bold("What to do")}\n`);
    for (const x of needFix) {
      console.log(`  ${x.status === D_FAIL ? c.red(x.name) : c.yellow(x.name)}`);
      console.log(`    ${x.fix.split("\n").join("\n    ")}\n`);
    }
  }

  if (s.fatal) {
    // Non-zero exit, so a setup script or a CI step can gate on this.
    die(`${s.fatal} blocking problem(s). Fix those and re-run \`brain doctor\`.`);
  }
  ok(`ready to install${s.warnings ? ` (${s.warnings} optional item(s) not set up)` : ""}`);
}


/**
 * Prompting that works on a terminal AND on piped input.
 *
 * `rl.question` is NOT usable here. With a non-TTY stdin it fires exactly once:
 * the stream is consumed, "close" is emitted, and every subsequent question
 * hangs forever. Node exits 13 with "unsettled top-level await" partway through
 * setup, which reads as a crash on a live call and is worse than an error.
 *
 * Reading lines through the interface's async iterator behaves identically on a
 * terminal and on a pipe, and it gives the one behaviour a non-interactive run
 * needs: when stdin ends, take the default rather than block.
 */
let _rl = null;
let _lines = null;
function prompts() {
  if (!_rl) {
    _rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    _lines = _rl[Symbol.asyncIterator]();
  }
  return _lines;
}
function closePrompts() {
  if (_rl) {
    _rl.close();
    _rl = null;
    _lines = null;
  }
}

/** Ask a question. Returns the trimmed answer, or the default when blank or absent. */
async function ask(question, fallback = "") {
  const lines = prompts();
  process.stdout.write(`  ${question}${fallback ? c.dim(` [${fallback}]`) : ""}: `);
  const { value, done } = await lines.next();
  if (done) {
    // stdin ended. Taking the default is right: an unattended run should
    // complete on defaults rather than hang waiting for a person.
    process.stdout.write(`${c.dim(fallback || "(none)")}\n`);
    return fallback;
  }
  return (String(value || "").trim()) || fallback;
}

/** Deterministic, non-secret Keychain locator for a standard macOS setup. */
export function standardMacAdminKeyReference(manifestPath, manifest) {
  const slug = String(manifest?.client?.slug || "brain")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "brain";
  const accountId = String(manifest?.infrastructure?.cloudflare?.account_id || "").trim();
  const identity = /^[0-9a-f]{32}$/i.test(accountId)
    ? accountId.toLowerCase()
    : createHash("sha256").update(resolve(manifestPath)).digest("hex").slice(0, 16);
  return `keychain://${encodeURIComponent(`${slug}-brain-admin`)}/${encodeURIComponent(`owner-${identity}`)}`;
}

/**
 * Make native secure storage the standard on macOS without silently moving a
 * legacy adjacent key. An explicit locator always wins. Any existing adjacent
 * destination, including an unsafe link, remains on the legacy path so its
 * normal validator can stop rather than routing around it.
 */
export function configureStandardAdminKeyStorage(manifestPath, manifest, options = {}) {
  const platform = options.platform ?? process.platform;
  const current = manifest?.operations?.admin_key_secret;
  if (platform !== "darwin" || (current !== null && current !== undefined)) {
    return Object.freeze({ changed: false, reference: current ?? null });
  }

  const directory = dirname(resolve(manifestPath));
  const adjacent = join(directory, ".brain-admin-key");
  const inspect = options.lstat ?? lstatSync;
  try {
    inspect(adjacent);
    return Object.freeze({ changed: false, reference: null, legacyAdjacent: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("setup could not safely inspect the legacy adjacent admin-key destination");
    }
  }

  // A rollback backup means an interrupted legacy transaction may contain the
  // only working key. Do not route around it into a new Keychain item.
  let names;
  try {
    names = (options.readDirectory ?? readdirSync)(directory);
  } catch {
    throw new Error("setup could not inspect the admin-key directory for legacy recovery state");
  }
  if (names.some((name) => /^\.\.brain-admin-key\.\d+\.[0-9a-f]{16}\.bak$/.test(String(name)))) {
    return Object.freeze({ changed: false, reference: null, legacyRollback: true });
  }

  const reference = standardMacAdminKeyReference(manifestPath, manifest);
  manifest.operations = { ...(manifest.operations || {}), admin_key_secret: reference };
  const save = options.saveManifest ?? saveManifest;
  save(manifestPath, manifest);
  return Object.freeze({ changed: true, reference });
}

/**
 * Resolve setup's ADMIN_KEY before setup performs any Cloudflare write.
 *
 * Null is the durable readers' explicit "not found" result. Every other bad
 * result is treated as unreadable state and stops setup rather than silently
 * inventing a replacement key that would disagree with an earlier install.
 */
export async function prepareSetupAdminKey(manifestPath, manifest, options = {}) {
  const persistenceOptions = {
    platform: options.platform ?? process.platform,
    username: options.username ?? process.env.USERNAME ?? process.env.USER,
    ...(options.persistenceOptions || {}),
  };

  let plan;
  try {
    const makePlan = options.adminKeyPersistencePlan ?? adminKeyPersistencePlan;
    plan = makePlan(manifestPath, manifest, persistenceOptions);
  } catch {
    die(
      "setup could not verify the declared durable ADMIN_KEY storage. " +
        "No Cloudflare changes were made. Fix the local key storage and rerun setup."
    );
  }

  const explicitAdminKey = Object.hasOwn(options, "explicitAdminKey")
    ? options.explicitAdminKey
    : (process.env.ADMIN_KEY || null);
  if (explicitAdminKey !== null) {
    try {
      validateAdminKeyValue(explicitAdminKey);
    } catch {
      die(
        "the ADMIN_KEY in this shell is not a valid HTTP-header-safe key. " +
          "No Cloudflare changes were made. Replace it or unset it, then rerun setup."
      );
    }
    return Object.freeze({ value: explicitAdminKey, source: "environment", plan });
  }

  let durable;
  try {
    const readDurable = options.readAdminKeyDurably ?? readAdminKeyDurably;
    durable = await readDurable(plan, persistenceOptions);
  } catch {
    die(
      "the durable ADMIN_KEY exists but could not be read and verified. " +
        "No Cloudflare changes were made. Fix the local key storage and rerun setup."
    );
  }

  if (durable !== null) {
    try {
      validateAdminKeyValue(durable);
    } catch {
      die(
        "the durable ADMIN_KEY exists but could not be read and verified. " +
          "No Cloudflare changes were made. Fix the local key storage and rerun setup."
      );
    }
    return Object.freeze({ value: durable, source: "durable", plan });
  }

  let generated;
  let generatedCopy;
  try {
    const generate = options.randomBytes ?? randomBytes;
    generated = generate(24);
    if (!(generated instanceof Uint8Array) || generated.byteLength !== 24) {
      throw new Error("invalid secure-random result");
    }
    generatedCopy = Buffer.from(generated);
    const value = generatedCopy.toString("hex");
    validateAdminKeyValue(value);
    return Object.freeze({
      value,
      source: "generated",
      plan,
    });
  } catch {
    die("setup could not generate its ADMIN_KEY. No Cloudflare changes were made; rerun setup.");
  } finally {
    if (generatedCopy) generatedCopy.fill(0);
    if (generated?.fill) generated.fill(0);
  }
}

/** Read whether setup is resuming over an already deployed Worker. */
export async function setupWorkerScriptExists(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const resolveSetupAccount = options.resolveAccount ?? resolveAccount;
  const callCloudflare = options.cf ?? cf;
  const account = await resolveSetupAccount(m);
  const scriptName = m.brain?.worker_name || `${m.client?.slug || "client"}-brain`;
  let scripts;
  try {
    scripts = await callCloudflare(`/accounts/${account.id}/workers/scripts`);
  } catch {
    die("setup could not prove whether an older Worker is still running. Nothing was migrated.");
  }
  if (!Array.isArray(scripts) || scripts.some((row) =>
    !row || typeof row !== "object" || typeof row.id !== "string" || !row.id)) {
    die("setup received an ambiguous Worker inventory. Nothing was migrated.");
  }
  return scripts.some((row) => row.id === scriptName);
}

/** Capture the same required pre-migration recovery point used by update. */
export async function captureSetupD1Bookmark(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  const resolveSetupAccount = options.resolveAccount ?? resolveAccount;
  const callCloudflare = options.cf ?? cf;
  const account = await resolveSetupAccount(m);
  const databaseId = m.infrastructure?.cloudflare?.d1_database_id;
  if (!databaseId) die("setup cannot capture a recovery bookmark without a pinned D1 database id.");
  let bookmark;
  try {
    const response = await callCloudflare(
      `/accounts/${account.id}/d1/database/${databaseId}/time_travel/bookmark`,
    );
    bookmark = response?.bookmark;
  } catch {
    die("setup stopped because the required D1 recovery bookmark could not be captured. Nothing was migrated.");
  }
  if (!validD1Bookmark(bookmark)) {
    die("setup stopped because Cloudflare returned no valid D1 recovery bookmark. Nothing was migrated.");
  }
  return bookmark;
}

/**
 * brain setup — nothing to a working brain, in one command.
 *
 * The step ORDER here is not cosmetic. A clean-room rehearsal established that
 * secrets must come after deploy because a secret is set on an existing worker
 * script. Vectorize uses the scoped API token and only falls back to wrangler's
 * own session for older tokens.
 *
 * Every step is idempotent and the manifest is written after each, so an
 * interrupted setup is resumed by re-running the same command.
 */
export async function cmdSetup(manifestPath, options = {}) {
  const flags = options.flags ?? parseFlags(process.argv.slice(3));
  assertKnownFlags(flags, ["manifest", "path", "no-connect"], "brain setup");
  const skipConnect = shouldSkipSetupConnections(flags, options);
  const prompt = options.ask ?? ask;
  console.log(`\n  ${c.bold("brain setup")}  ${c.dim("nothing to a working brain")}\n`);

  /* --- 1. preflight, because everything below assumes it --- */
  console.log(`  ${c.bold("Step 1 of 6")}  checking this machine\n`);
  const runDoctorChecks = options.doctorRunAll ?? doctorRunAll;
  const checks = await runDoctorChecks({
    accountId: undefined,
    cloudflareToken: activeCloudflareToken(),
    // A setup performed on the owner's machine includes Claude Code as a
    // delivered capability. --no-connect is the explicit technician-machine
    // exception and must not force the client's local assistant onto the
    // technician's laptop.
    requireClaudeCode: !skipConnect,
  });
  for (const x of checks) {
    const mark = x.status === D_OK ? c.green("ok  ") : x.status === D_WARN ? c.yellow("warn") : c.red("FAIL");
    console.log(`    ${mark}  ${x.name}  ${c.dim(x.detail)}`);
  }
  const fatal = checks.filter((x) => x.status === D_FAIL);
  if (fatal.length) {
    console.log("");
    for (const x of fatal) console.log(`  ${c.red(x.name)}\n    ${x.fix.split("\n").join("\n    ")}\n`);
    closePrompts();
    die("setup cannot continue until the blocking items above are fixed. Re-run when they are.");
  }

  /* --- 2. the manifest, asked for once --- */
  const target = manifestPath || flags.manifest || "./brain.manifest.json";
  const shownTarget = commandPath(displayPath(target));
  let m;
  if (existsSync(target)) {
    m = loadManifest(target).m;
    ok(`resuming from ${relative(process.cwd(), target)}`);
  } else {
    console.log(`\n  ${c.bold("Step 2 of 6")}  about this install\n`);
    const display = await prompt("What is this brain for? (a person or a company)", "My Brain");
    const slug = (await prompt(
      "Short name, lowercase, no spaces (names the worker and the database)",
      display.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "brain"
    )).toLowerCase();

    const tmpl = JSON.parse(readFileSync(join(HERE, "templates", "brain.manifest.json"), "utf-8"));
    tmpl.client = { slug, display_name: display, primary_contact: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    tmpl.brain = { version: PRODUCT_VERSION, worker_name: `${slug}-brain` };
    const cf = tmpl.infrastructure.cloudflare;
    for (const k of ["d1_database_id", "vectorize_index", "kv_namespace_id"]) delete cf[k];
    delete cf.r2_bucket; // not wired to anything, so do not provision it
    cf.d1_database_name = `${slug}-brain`;
    cf.storage = "d1";
    delete tmpl.infrastructure.supabase;

    const account = await chooseSetupAccount(prompt, {
      listAccounts: options.listCloudflareAccounts,
    });
    cf.account_id = account.id;
    ok(`Cloudflare account "${account.name}" (${account.id})`);

    createSetupManifest(target, tmpl);
    m = tmpl;
    ok(`wrote ${relative(process.cwd(), target)}`);
  }

  try {
    const configureStorage = options.configureStandardAdminKeyStorage ?? configureStandardAdminKeyStorage;
    const storage = configureStorage(target, m, options);
    if (storage?.changed) ok("admin key will be kept in this Mac's login Keychain");
  } catch {
    closePrompts();
    die(
      "setup could not configure native admin-key storage. No Cloudflare changes were made. " +
        "Fix the manifest directory and rerun setup."
    );
  }

  // Validate an explicit shell key, or resolve an absent one, before any remote
  // step. On a resumed install durable storage is authoritative. Only an exact
  // "missing" result may create a value; invalid or unreadable state stops here.
  const prepareAdminKey = options.prepareSetupAdminKey ?? prepareSetupAdminKey;
  const preparedAdminKey = await prepareAdminKey(target, m, options);

  /* --- 3. the install sequence, in the ONLY order that works --- */
  console.log(`\n  ${c.bold("Step 3 of 6")}  creating the brain in your Cloudflare account\n`);
  await (options.cmdVerify ?? cmdVerify)(target);
  await (options.cmdProvision ?? cmdProvision)(target, { nextSteps: false });
  const migrateSetup = options.cmdMigrate ?? cmdMigrate;
  const deploySetup = options.cmdDeploy ?? cmdDeploy;
  const healthSetup = options.cmdHealth ?? cmdHealth;
  const drainSetup = options.cmdDrain ?? cmdDrain;
  const detectExistingWorker = options.setupWorkerScriptExists ?? setupWorkerScriptExists;
  // Pin the post-provision manifest before asking whether its exact Worker
  // exists. The inventory decision, bookmark, paused Worker, migration, and
  // active Worker must all name one immutable account/database/script tuple.
  // A user edit during the grace window stops before migration instead of
  // pairing one database with another database's recovery bookmark.
  const setupOriginalPin = pinUpdateManifest(target);
  let setupExecutionPin = writePinnedExecutionManifest(setupOriginalPin);
  const runPinnedSetupStage = async (stage, action) => {
    revalidateUpdateManifest(setupOriginalPin, stage);
    revalidateUpdateManifest(setupExecutionPin, stage);
    const result = await action(setupExecutionPin.target);
    revalidateUpdateManifest(setupOriginalPin, stage);
    revalidateUpdateManifest(setupExecutionPin, stage);
    return result;
  };
  let workerAlreadyExisted;
  try {
    workerAlreadyExisted = await runPinnedSetupStage(
      "setup Worker inventory",
      (pinnedPath) => detectExistingWorker(pinnedPath),
    );
    if (workerAlreadyExisted &&
        (setupExecutionPin.manifest.infrastructure?.cloudflare?.storage || "d1") === "d1") {
      // A resumed setup can encounter a Worker deployed by an older package.
      // Quiesce it with the same compatibility protocol as `brain update`
      // before any new lease columns are applied.
      const captureBookmark = options.captureSetupD1Bookmark ?? captureSetupD1Bookmark;
      let bookmark = null;
      try {
        bookmark = await runPinnedSetupStage(
          "setup D1 bookmark capture",
          (pinnedPath) => captureBookmark(pinnedPath),
        );
        await runPinnedSetupStage(
          "setup paused vector-drain deployment",
          (pinnedPath) => deploySetup(pinnedPath, {
            persistDomain: false,
            pauseVectorDrainForUpgrade: true,
          }),
        );
        await runPinnedSetupStage(
          "setup paused vector-drain health verification",
          (pinnedPath) => healthSetup(pinnedPath, {
            expectVersion: PRODUCT_VERSION,
            expectDrainMode: "paused-for-upgrade",
            reachOnly: true,
          }),
        );
        const waitForVectorDrainQuiescence = options.waitForVectorDrainQuiescence ??
          ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
        await runPinnedSetupStage(
          "setup vector-drain quiescence",
          () => waitForVectorDrainCutover(waitForVectorDrainQuiescence),
        );
        await runPinnedSetupStage(
          "setup migration",
          (pinnedPath) => migrateSetup(pinnedPath, { vectorDrainQuiesced: true }),
        );
        await runPinnedSetupStage(
          "setup active vector-drain deployment",
          (pinnedPath) => deploySetup(pinnedPath, {
            persistDomain: false,
            pauseVectorDrainForUpgrade: false,
          }),
        );
        await runPinnedSetupStage(
          "setup active vector-drain health verification",
          (pinnedPath) => healthSetup(pinnedPath, {
            expectVersion: PRODUCT_VERSION,
            expectDrainMode: "active",
            reachOnly: true,
          }),
        );
      } catch (error) {
        const recovery = bookmark ? `\n      D1 recovery bookmark: ${bookmark}` : "";
        die(
          `resumed setup stopped during the verified vector-writer cutover: ${error.message}${recovery}\n` +
            "      Fix the reported issue and rerun setup; do not restore a bookmark as the first response.",
        );
      }
    }
  } finally {
    removePinnedExecutionManifest(setupExecutionPin);
    setupExecutionPin = null;
  }
  if (!workerAlreadyExisted ||
      (setupOriginalPin.manifest.infrastructure?.cloudflare?.storage || "d1") !== "d1") {
    // Do not claim quiescence merely because one manifest script name was not
    // found. A genuinely fresh D1 has no install_state row and migrates normally;
    // a renamed live brain hits cmdMigrate's zero-mutation guard.
    try {
      await migrateSetup(target);
    } catch (error) {
      const message = String(error?.message || error);
      const needsVerifiedCutover =
        (setupOriginalPin.manifest.infrastructure?.cloudflare?.storage || "d1") === "d1" &&
        /verified (?:vector-)?writer cutover|verified vector-writer cutover|not provably fresh/i.test(message);
      if (needsVerifiedCutover) {
        die(
          "setup found D1 state that cannot be proven to be a brand-new empty database. Nothing was migrated.\n" +
            "      This can happen when a first setup stopped after only part of a migration, or when another Worker name still uses this D1.\n" +
            `      Run \`brain update ${shownTarget}\` to establish the verified paused-writer cutover, then rerun \`brain setup ${shownTarget}\`.`,
        );
      }
      throw error;
    }
    await deploySetup(target, { nextSteps: false });
  } else if (!setupOriginalPin.manifest.brain?.domain) {
    // The compatibility deploys use the immutable execution copy and suppress
    // local writes. A rare legacy manifest with no saved route gets one final
    // ordinary active deploy solely to persist its token-free URL.
    revalidateUpdateManifest(setupOriginalPin, "setup domain persistence");
    await deploySetup(target, { pauseVectorDrainForUpgrade: false, nextSteps: false });
  }
  // Provision and deploy write resource IDs and the token-free live address.
  // Everything below must use the committed manifest, not setup's old template.
  m = loadManifest(target).m;

  /* --- 4. secrets, AFTER deploy --- */
  console.log(`\n  ${c.bold("Step 4 of 6")}  keys\n`);
  if (preparedAdminKey?.source === "generated") {
    // Generated, never asked for. It protects this brain and nothing else.
    // randomBytes, not Math.random: this is the only key guarding the corpus.
    ok("generated an admin key for this brain");
  } else if (preparedAdminKey?.source === "durable") {
    ok("reusing this brain's verified durable admin key");
  }
  console.log(
    `\n    Written answers use ${c.bold("Cloudflare Workers AI")} in the client's own account.\n` +
      "    No Anthropic, OpenAI, Gemini, or Supabase credential is required.\n"
  );
  // Setup owns one full reconciliation in Step 5. Suppress cmdSecrets' normal
  // existing-only rotation hook here so a stale entry cannot abort before the
  // full add-or-repair path gets its turn.
  await (options.cmdSecrets ?? cmdSecrets)(target, {
    reconcileExistingAgents: false,
    explicitAdminKey: preparedAdminKey.value,
  });
  if ((m.infrastructure?.cloudflare?.storage || "d1") === "d1") {
    // Schema 0012 deliberately marks an existing Vectorize projection as
    // unverified instead of trusting equal row counts. The durable admin key
    // must exist before this HTTPS-only command can resume the bounded,
    // cursor-backed bootstrap. If setup is interrupted, rerunning it continues
    // from D1 rather than rebuilding an invocation-local queue.
    await drainSetup(target);
  }
  // Prove that Step 4 actually committed durable desired state. A shell key is
  // still preserved for the caller, but setup health must not depend on it.
  await healthSetup(target, {
    durableAdminKeyOnly: true,
    expectVersion: PRODUCT_VERSION,
    expectDrainMode:
      (m.infrastructure?.cloudflare?.storage || "d1") === "d1" ? "active" : null,
  });

  /* --- 5. wire it into the tools people actually use --- */
  //
  // Skippable, because this step edits config files belonging to WHOEVER RAN
  // the command, not to the brain. When the owner installs their own brain that
  // is the whole point. When someone installs on a client's behalf from their
  // own laptop, every install silently leaves an MCP server pointing at that
  // client's brain behind, with no uninstall, which contradicts revoking access
  // at handoff. `--no-connect` is the way to say "not this machine".
  let wiring = { wired: [], failures: [] };
  if (skipConnect) {
    console.log(`\n  ${c.bold("Step 5 of 6")}  connecting it to your AI tools\n`);
    info("skipped (--no-connect). Nothing on this computer was changed.");
    info(`connect a machine later with: brain mcp-config ${shownTarget}`);
  } else {
    console.log(`\n  ${c.bold("Step 5 of 6")}  connecting it to your AI tools\n`);
    const connectAgents = options.wireAgents ?? wireAgents;
    wiring = await connectAgents(m, target, {
      ...(options.agentOptions || {}),
      existingOnly: false,
    });
  }
  const wired = Array.isArray(wiring) ? wiring : (wiring?.wired || []);
  const wiringFailures = Array.isArray(wiring) ? [] : (wiring?.failures || []);
  if (wiringFailures.length) {
    die(
      "setup could not verify the AI tool registration exactly. The brain and durable key are ready,\n" +
        "  but setup will not claim the connection works. Rerun setup or use `brain mcp-config <manifest>`;\n" +
        "  no credential needs to be copied into a command."
    );
  }
  if (wired.includes("Claude Code")) {
    try {
      const writeGuide = options.writeClaudeWorkspaceGuide ?? writeClaudeWorkspaceGuide;
      const guide = writeGuide(target, {
        brainCliPath: options.brainCliPath || fileURLToPath(import.meta.url),
        nodePath: options.nodePath || process.execPath,
      });
      if (guide.status === "written" || guide.status === "verified") {
        ok(`Claude Code owner workspace ready at ${guide.path}`);
      } else {
        warn(`preserved the existing CLAUDE.md at ${guide.path}; add the Financial Brain safety guide manually`);
      }
    } catch {
      closePrompts();
      die(
        "the Brain is connected to Claude Code, but its owner workspace guide could not be written safely. " +
          "No existing CLAUDE.md was replaced. Fix the manifest folder and rerun setup."
      );
    }
  }

  /* --- 6. the first thing worth looking at --- */
  console.log(`\n  ${c.bold("Step 6 of 6")}  loading something in\n`);
  const folder = flags.path || (await prompt("A folder to load now (blank to skip)", ""));
  if (folder && existsSync(folder)) {
    process.argv = [process.argv[0], process.argv[1], "ingest", target, "--path", folder, "--source", "documents"];
    await cmdIngest(target);
  } else if (folder) {
    closePrompts();
    die(`no such folder: ${folder}. Nothing was loaded. Fix the path and re-run setup.`);
  } else {
    info(`load one later with: brain ingest ${shownTarget} --path <dir>`);
  }

  // Setup is the one moment the installer knows the durable manifest location
  // with certainty. Save only that location, never a credential, so a later
  // `brain update` can start from any folder after Terminal is reopened.
  try {
    const rememberManifest = options.rememberInstalledManifest ?? rememberInstalledManifest;
    rememberManifest(target, options.installedManifestOptions || {});
  } catch (error) {
    closePrompts();
    die(
      "this Brain is ready, but this computer could not safely remember where its manifest is. " +
        "No Cloudflare work needs to be undone. Rerun setup with the same manifest path."
    );
  }

  closePrompts();
  const countBacklog = options.backlogCount ?? backlogCount;
  const outstanding = await countBacklog(target).catch(() => 0);
  console.log(`\n  ${c.green(c.bold("Your brain is live."))}\n`);
  if (outstanding > 0) {
    console.log(
      `  ${c.yellow("Keyword search works now.")} ${outstanding} chunk(s) are still embedding, so\n` +
        `  meaning-based search is incomplete until they finish. Run:\n    brain drain ${shownTarget}\n`
    );
  }
  console.log(`  Ask it directly with: brain ask ${shownTarget}`);
  if (wired.length) {
    console.log(`  It is connected to: ${wired.join(", ")}.`);
    console.log(`  ${c.dim("Restart them, then ask a question about your own material.")}\n`);
  } else if (skipConnect) {
    console.log(`  Owner handoff still requires Claude Code connection on the owner's machine:`);
    console.log(`    brain mcp-config ${shownTarget}\n`);
  } else {
    console.log(`  No AI tool registration was reported. Verify Claude Code with \`brain tools\`, then run:`);
    console.log(`    brain mcp-config ${shownTarget}\n`);
  }

  const probeWarning = emptyProbeQuestionsWarning(m, shownTarget);
  if (probeWarning) {
    console.log("");
    for (const line of probeWarning) warn(line);
    console.log("");
  }
}

/**
 * Lines warning that an install carries no probe questions, or null when it
 * has real ones. Without probes the acceptance suite skips its retrieval tier
 * and can pass without anyone asking the brain a single question, so setup —
 * the moment someone is present who can still collect the questions — says so
 * loudly instead of leaving it to be discovered on the report.
 */
export function emptyProbeQuestionsWarning(manifest, manifestPath = "brain.manifest.json") {
  const probes = manifest?.testing?.probe_questions;
  if (Array.isArray(probes) && probes.some((q) => String(q || "").trim())) return null;
  return [
    "testing.probe_questions is EMPTY. The acceptance suite will skip its whole",
    "retrieval tier, so nothing will ever prove this brain answers the owner's",
    "questions — a test run can read green without anyone asking it anything.",
    `Fill testing.probe_questions in ${manifestPath} with the owner's own`,
    `questions from the intake, then run: brain test ${manifestPath}`,
  ];
}

/** Keep install-account custody separate from edits to the operator's machine. */
export function shouldSkipSetupConnections(flags = {}, options = {}) {
  return flags["no-connect"] === true || options.connectAgents === false;
}

const AGENT_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "USER", "USERNAME", "LOGNAME", "SystemRoot", "ComSpec", "PATHEXT",
  "TEMP", "TMP", "TMPDIR", "LANG", "SHELL", "TERM",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME",
]);

/** Only nonsecret process essentials may reach agent configuration CLIs. */
export function agentCliEnvironment(environment = process.env) {
  const clean = {};
  for (const name of AGENT_ENV_ALLOWLIST) {
    const value = environment?.[name];
    if (typeof value === "string" && value) clean[name] = value;
  }
  for (const [name, value] of Object.entries(environment || {})) {
    if (name.startsWith("LC_") && typeof value === "string" && value) clean[name] = value;
  }
  return clean;
}

function runAgentCli(runner, environment, command, args) {
  return runner(command, args, {
    inheritEnv: false,
    env: agentCliEnvironment(environment),
  });
}

function sameStringMap(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function normalizedRegistration(entry, name = null) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const transport = entry.transport && typeof entry.transport === "object"
    ? entry.transport
    : entry;
  return {
    name: entry.name || name,
    enabled: entry.enabled,
    type: transport.type || "stdio",
    command: transport.command,
    args: Array.isArray(transport.args) ? [...transport.args] : [],
    env: transport.env && typeof transport.env === "object" && !Array.isArray(transport.env)
      ? { ...transport.env }
      : {},
    envVars: Array.isArray(transport.env_vars) ? [...transport.env_vars] : [],
    cwd: transport.cwd ?? null,
  };
}

export function mcpRegistrationIsExact(entry, desired) {
  const actual = normalizedRegistration(entry, desired.name);
  return Boolean(actual) &&
    actual.name === desired.name &&
    actual.enabled !== false &&
    actual.type === "stdio" &&
    actual.command === desired.command &&
    actual.args.length === desired.args.length &&
    actual.args.every((value, index) => value === desired.args[index]) &&
    actual.envVars.length === 0 &&
    actual.cwd === null &&
    sameStringMap(actual.env, desired.env) &&
    !Object.hasOwn(actual.env, "BRAIN_KEY") &&
    !Object.hasOwn(actual.env, "ADMIN_KEY");
}

/** Refuse to replace an unrelated MCP server that happens to share the slug. */
export function mcpRegistrationIsInstallerOwned(entry, desired) {
  const actual = normalizedRegistration(entry, desired.name);
  const samePath = (left, right) => {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const a = resolve(left);
    const b = resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  const sameManifest = typeof actual?.env?.BRAIN_MANIFEST === "string" &&
    samePath(actual.env.BRAIN_MANIFEST, desired.env.BRAIN_MANIFEST);
  const transitionName = CLAUDE_LEGACY_KEY_NAMES.find((key) =>
    Object.hasOwn(actual?.env || {}, key));
  const envKeys = Object.keys(actual?.env || {}).sort();
  const safeTransition = transitionName === "BRAIN_KEY" ||
    (transitionName && /^x+$/.test(actual.env[transitionName] || ""));
  const manifestOwned = sameManifest && (
    sameStringMap(actual.env, desired.env) ||
    (safeTransition && sameStringMap(actual.env, {
      ...desired.env,
      [transitionName]: actual.env[transitionName],
    }))
  );
  const exactLegacyTarget = transitionName &&
    !Object.hasOwn(actual?.env || {}, "BRAIN_MANIFEST") &&
    envKeys.length === 3 &&
    envKeys.includes("BRAIN_URL") && envKeys.includes("BRAIN_NAME") && envKeys.includes(transitionName) &&
    actual?.env?.BRAIN_URL === desired.env.BRAIN_URL &&
    actual?.env?.BRAIN_NAME === desired.name &&
    (transitionName === "BRAIN_KEY" || /^x+$/.test(actual.env[transitionName] || ""));
  const installerNode = actual?.command === "node" || samePath(actual?.command, desired.command);
  return Boolean(actual) &&
    actual.name === desired.name &&
    actual.type === "stdio" &&
    installerNode &&
    actual.args.length === 1 &&
    basename(String(actual.args[0])) === "brain-mcp.mjs" &&
    samePath(actual.args[0], desired.args[0]) &&
    actual.envVars.length === 0 &&
    actual.cwd === null &&
    actual.env.BRAIN_NAME === desired.name &&
    actual.env.BRAIN_URL === desired.env.BRAIN_URL &&
    (manifestOwned || exactLegacyTarget);
}

/**
 * Launch the exact locator-only descriptor and complete one offline MCP
 * initialize exchange. This catches a missing Node executable, import failure,
 * broken server syntax, or incompatible stdio framing before setup says wired.
 */
export function verifyMcpRuntime(desired, options = {}) {
  if (!desired || desired.type !== "stdio" || !isAbsolute(desired.command) ||
      !Array.isArray(desired.args) || !desired.args.length) return false;
  const spawn = options.spawn ?? spawnSync;
  const environment = localToolEnvironment(options.environment ?? process.env, desired.env);
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "brain-installer", version: PRODUCT_VERSION } },
  }) + "\n";
  let result;
  try {
    result = spawn(desired.command, desired.args, {
      encoding: "utf8",
      env: environment,
      input: request,
      maxBuffer: 1024 * 1024,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 15_000,
      windowsHide: true,
    });
  } catch {
    return false;
  }
  if (result?.error || result?.status !== 0) return false;
  try {
    const replies = String(result.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const reply = replies.find((value) => value?.id === 1);
    return reply?.jsonrpc === "2.0" && reply?.result?.serverInfo?.name === desired.env.BRAIN_NAME &&
      typeof reply.result.serverInfo.version === "string";
  } catch {
    return false;
  }
}

const CLAUDE_LEGACY_KEY_NAMES = Object.freeze(
  Array.from({ length: "BRAIN_KEY".length + 1 }, (_, length) =>
    "REDACTED_".slice(0, length) + "BRAIN_KEY".slice(length)),
);

function sameOpenedFile(before, opened) {
  return before.isFile() && opened.isFile() && before.dev === opened.dev &&
    before.ino === opened.ino && before.uid === opened.uid && before.gid === opened.gid &&
    before.mode === opened.mode && before.size === opened.size &&
    before.nlink === 1 && opened.nlink === 1;
}

function jsonStringEnd(source, start) {
  if (source[start] !== '"') throw new Error("expected a JSON string");
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  throw new Error("unterminated JSON string");
}

function jsonCompositeEnd(source, start) {
  if (source[start] !== "{" && source[start] !== "[") {
    throw new Error("expected a JSON object or array");
  }
  const stack = [];
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      index = jsonStringEnd(source, index) - 1;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) throw new Error("mismatched JSON container");
      if (!stack.length) return index + 1;
    }
  }
  throw new Error("unterminated JSON container");
}

/** Find object-valued JSON properties without reserializing credential bytes. */
function jsonObjectPropertyRanges(source, propertyName) {
  const ranges = [];
  for (let index = 0; index < source.length;) {
    if (source[index] !== '"') {
      index++;
      continue;
    }
    const tokenEnd = jsonStringEnd(source, index);
    let decoded;
    try { decoded = JSON.parse(source.slice(index, tokenEnd)); }
    catch { throw new Error("invalid JSON string token"); }
    let cursor = tokenEnd;
    while (/\s/.test(source[cursor] || "")) cursor++;
    if (decoded !== propertyName || source[cursor] !== ":") {
      index = tokenEnd;
      continue;
    }
    cursor++;
    while (/\s/.test(source[cursor] || "")) cursor++;
    if (source[cursor] !== "{") {
      index = tokenEnd;
      continue;
    }
    const end = jsonCompositeEnd(source, cursor);
    ranges.push({ start: cursor, end, value: JSON.parse(source.slice(cursor, end)) });
    index = tokenEnd;
  }
  return ranges;
}

/**
 * Remove a retired literal from one exact installer-owned Claude entry before
 * Claude's own writer makes a config backup. The overwrite is same-inode and
 * same-length: value bytes first, then the field name, with an fsync after each
 * phase. Every partial prefix remains valid JSON and is recognized on rerun.
 */
function neutralizeClaudeLegacyKey(desired, before) {
  const entry = normalizedRegistration(before.entry, desired.name);
  const field = CLAUDE_LEGACY_KEY_NAMES.find((name) => Object.hasOwn(entry?.env || {}, name));
  if (!field || field === "REDACTED_") return;
  if (!mcpRegistrationIsInstallerOwned(before.entry, desired)) {
    throw new Error("not an installer-owned Claude registration");
  }
  const value = entry.env[field];
  if (typeof value !== "string" || !value || !/^[\x20-\x7e]+$/.test(value) || /["\\]/.test(value)) {
    throw new Error("the legacy Claude credential is not safe for in-place neutralization");
  }

  const raw = readFileSync(before.path, "utf8");
  const serverRanges = jsonObjectPropertyRanges(raw, "mcpServers");
  if (serverRanges.length !== 1) {
    throw new Error("the Claude MCP configuration location is ambiguous");
  }
  const serverRange = serverRanges[0];
  const targetRanges = jsonObjectPropertyRanges(
    raw.slice(serverRange.start, serverRange.end),
    desired.name,
  );
  if (targetRanges.length !== 1 ||
      JSON.stringify(targetRanges[0].value) !== JSON.stringify(before.entry)) {
    throw new Error("the legacy Claude registration location is ambiguous");
  }
  const targetStart = serverRange.start + targetRanges[0].start;
  const targetRaw = raw.slice(targetStart, serverRange.start + targetRanges[0].end);
  const namesPattern = CLAUDE_LEGACY_KEY_NAMES.join("|");
  const propertyPattern = new RegExp(`"(${namesPattern})"\\s*:\\s*"([^"\\\\]*)"`, "g");
  const matches = [...targetRaw.matchAll(propertyPattern)];
  if (matches.length !== 1 || matches[0][1] !== field || matches[0][2] !== value) {
    throw new Error("the legacy Claude credential location is ambiguous");
  }
  const match = matches[0];
  const fieldCharacterOffset = targetStart + match.index + match[0].indexOf(field);
  const valueToken = `"${value}"`;
  const valueCharacterOffset = targetStart + match.index + match[0].lastIndexOf(valueToken) + 1;
  // RegExp and String offsets count UTF-16 code units, while positional file
  // writes count bytes. A display name or path containing non-ASCII text before
  // this entry would otherwise shift both writes and corrupt Claude's config.
  const fieldOffset = Buffer.byteLength(raw.slice(0, fieldCharacterOffset), "utf8");
  const valueOffset = Buffer.byteLength(raw.slice(0, valueCharacterOffset), "utf8");
  const beforeStat = lstatSync(before.path);
  const flags = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(before.path, flags);
  try {
    const openedStat = fstatSync(fd);
    if (!sameOpenedFile(beforeStat, openedStat) || readFileSync(fd, "utf8") !== raw) {
      throw new Error("Claude configuration changed during reconciliation");
    }
    const neutralValue = Buffer.from("x".repeat(Buffer.byteLength(value)), "ascii");
    if (writeSync(fd, neutralValue, 0, neutralValue.length, valueOffset) !== neutralValue.length) {
      throw new Error("short Claude credential neutralization write");
    }
    fsyncSync(fd);

    const neutralField = Buffer.from("REDACTED_", "ascii");
    if (writeSync(fd, neutralField, 0, neutralField.length, fieldOffset) !== neutralField.length) {
      throw new Error("short Claude credential field neutralization write");
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const verified = JSON.parse(readFileSync(before.path, "utf8"));
  const current = verified?.mcpServers?.[desired.name];
  if (!current || Object.hasOwn(current.env || {}, "BRAIN_KEY") ||
      current.env?.REDACTED_ !== "x".repeat(value.length)) {
    throw new Error("Claude credential neutralization did not verify");
  }
}

function claudeUserConfigPath(environment, explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const root = environment?.CLAUDE_CONFIG_DIR || environment?.HOME ||
    environment?.USERPROFILE || homedir();
  return resolve(root, ".claude.json");
}

function readClaudeRegistration(desired, options) {
  const path = claudeUserConfigPath(options.environment, options.claudeConfigPath);
  if (!existsSync(path)) return { path, entry: null };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) {
      throw new Error("unsafe Claude config");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("foreign Claude config");
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid Claude config");
    }
    const servers = parsed.mcpServers;
    if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
      throw new Error("invalid Claude MCP config");
    }
    return { path, entry: servers?.[desired.name] ?? null };
  } catch {
    throw new Error("Claude Code's user configuration could not be read safely");
  }
}

function claudeAddArgs(desired, { json = false } = {}) {
  if (json) {
    return [
      "mcp", "add-json", "--scope", "user", desired.name,
      JSON.stringify({
        type: "stdio",
        command: desired.command,
        args: desired.args,
        env: desired.env,
      }),
    ];
  }
  const args = ["mcp", "add", "--scope", "user", desired.name];
  for (const [key, value] of Object.entries(desired.env)) args.push("-e", `${key}=${value}`);
  args.push("--", desired.command, ...desired.args);
  return args;
}

function reconcileClaudeRegistration(desired, options) {
  const runner = options.runCommand;
  const before = readClaudeRegistration(desired, options);
  if (!before.entry && options.existingOnly) return { status: "skipped" };
  if (before.entry && mcpRegistrationIsExact(before.entry, desired)) return { status: "verified" };
  if (before.entry && !mcpRegistrationIsInstallerOwned(before.entry, desired)) {
    return { status: "failed", reason: "name-collision" };
  }

  if (before.entry) {
    neutralizeClaudeLegacyKey(desired, before);
    runAgentCli(runner, options.environment, "claude", [
      "mcp", "remove", "--scope", "user", desired.name,
    ]);
    const removed = readClaudeRegistration(desired, options);
    if (removed.entry) return { status: "failed", reason: "remove-failed" };
  }

  runAgentCli(runner, options.environment, "claude", claudeAddArgs(desired));
  let after = readClaudeRegistration(desired, options);
  if (mcpRegistrationIsExact(after.entry, desired)) {
    return { status: before.entry ? "updated" : "added" };
  }

  // A second secret-free CLI path recovers from a version-specific add parser
  // failure. Never reconstruct a removed legacy entry containing a literal key.
  if (after.entry && mcpRegistrationIsInstallerOwned(after.entry, desired)) {
    runAgentCli(runner, options.environment, "claude", [
      "mcp", "remove", "--scope", "user", desired.name,
    ]);
    after = readClaudeRegistration(desired, options);
  }
  if (!after.entry) {
    runAgentCli(runner, options.environment, "claude", claudeAddArgs(desired, { json: true }));
    after = readClaudeRegistration(desired, options);
    if (mcpRegistrationIsExact(after.entry, desired)) {
      return { status: before.entry ? "updated" : "added" };
    }
  }

  // If a partial installer-owned entry was created, remove only that entry.
  // An unrelated concurrent replacement is preserved untouched.
  if (after.entry && mcpRegistrationIsInstallerOwned(after.entry, desired)) {
    runAgentCli(runner, options.environment, "claude", [
      "mcp", "remove", "--scope", "user", desired.name,
    ]);
  }
  const final = readClaudeRegistration(desired, options);
  return {
    status: "failed",
    reason: final.entry ? "verification-mismatch" : "registration-absent",
  };
}

function verifyCodexRegistrationRedacted(desired, options) {
  const result = runAgentCli(options.runCommand, options.environment, "codex", [
    "mcp", "get", desired.name,
  ]);
  if (!result.ok) return false;
  const output = String(result.stdout || result.out || "");
  const envLine = output.match(/^\s*env:\s*(.*?)\s*$/m)?.[1] || "";
  const envNames = envLine === "-" ? [] : envLine.split(/,\s*/).map((item) => {
    const match = item.match(/^([A-Za-z_][A-Za-z0-9_]*)=\*+$/);
    return match?.[1] || null;
  });
  return output.split(/\r?\n/)[0]?.trim() === desired.name &&
    output.includes(`command: ${desired.command}`) &&
    envNames.every(Boolean) &&
    envNames.sort().join("\0") === Object.keys(desired.env).sort().join("\0") &&
    !envNames.includes("BRAIN_KEY") && !envNames.includes("ADMIN_KEY");
}

function codexUserConfigPath(environment, explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const root = environment?.CODEX_HOME || join(
    environment?.HOME || environment?.USERPROFILE || homedir(),
    ".codex",
  );
  return resolve(root, "config.toml");
}

function parseCanonicalTomlValue(source) {
  const raw = String(source).trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Codex writes strings and string arrays using JSON-compatible TOML basic
  // syntax. Unsupported hand-written TOML fails closed as a name collision.
  return JSON.parse(raw);
}

function readCodexRegistration(desired, options) {
  const path = codexUserConfigPath(options.environment, options.codexConfigPath);
  if (!existsSync(path)) return { path, entry: null };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) {
      throw new Error("unsafe Codex config");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("foreign Codex config");
    }
    const mainName = `mcp_servers.${desired.name}`;
    const envName = `${mainName}.env`;
    const main = {};
    const env = {};
    let section = null;
    let foundMain = false;
    let foundEnv = false;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
      if (header) {
        section = header[1];
        if (section === mainName) {
          if (foundMain) throw new Error("duplicate Codex MCP table");
          foundMain = true;
        } else if (section === envName) {
          if (foundEnv) throw new Error("duplicate Codex MCP env table");
          foundEnv = true;
        }
        continue;
      }
      if (section !== mainName && section !== envName) continue;
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/);
      if (!assignment) throw new Error("unsupported Codex MCP TOML");
      const target = section === envName ? env : main;
      if (Object.hasOwn(target, assignment[1])) throw new Error("duplicate Codex MCP value");
      target[assignment[1]] = parseCanonicalTomlValue(assignment[2]);
    }
    if (!foundMain) return { path, entry: null };
    return {
      path,
      entry: {
        name: desired.name,
        enabled: main.enabled,
        type: "stdio",
        command: main.command,
        args: Array.isArray(main.args) ? main.args : [],
        env,
        env_vars: Array.isArray(main.env_vars) ? main.env_vars : [],
        cwd: main.cwd ?? null,
      },
    };
  } catch {
    throw new Error("Codex's user configuration could not be read safely");
  }
}

function codexAddArgs(desired) {
  const args = ["mcp", "add", desired.name];
  for (const [key, value] of Object.entries(desired.env)) args.push("--env", `${key}=${value}`);
  args.push("--", desired.command, ...desired.args);
  return args;
}

function reconcileCodexRegistration(desired, options) {
  const before = readCodexRegistration(desired, options);
  if (!before.entry && options.existingOnly) return { status: "skipped" };
  if (before.entry && mcpRegistrationIsExact(before.entry, desired)) {
    const visible = verifyCodexRegistrationRedacted(desired, options);
    const confirmed = readCodexRegistration(desired, options);
    return visible && mcpRegistrationIsExact(confirmed.entry, desired)
      ? { status: "verified" }
      : { status: "failed", reason: "verification-mismatch" };
  }
  if (before.entry && !mcpRegistrationIsInstallerOwned(before.entry, desired)) {
    return { status: "failed", reason: "name-collision" };
  }

  runAgentCli(options.runCommand, options.environment, "codex", codexAddArgs(desired));
  const localAfter = readCodexRegistration(desired, options);
  if (!mcpRegistrationIsExact(localAfter.entry, desired)) {
    return { status: "failed", reason: "verification-mismatch" };
  }
  // The human readback redacts env values. Exact values come from a second
  // strict read of Codex's source-of-truth config, so no legacy key can enter a
  // child stdout pipe and no name-only output can make this pass.
  const visible = verifyCodexRegistrationRedacted(desired, options);
  const after = readCodexRegistration(desired, options);
  if (visible && mcpRegistrationIsExact(after.entry, desired)) {
    return { status: before.entry ? "updated" : "added" };
  }
  return { status: "failed", reason: "verification-mismatch" };
}

/**
 * Register or reconcile the brain with installed CLI agents.
 *
 * Every success is an exact readback of command, args, and the three nonsecret
 * environment values. No name-only or add-exit-code shortcut is accepted.
 */
export async function wireAgents(m, manifestPath, options = {}) {
  const environment = options.environment ?? process.env;
  const runner = options.runCommand ?? run;
  const existingOnly = options.existingOnly === true;
  const failures = [];
  const wired = [];
  const skipped = [];
  const name = m?.client?.slug || "brain";
  const claudeInstalled = runAgentCli(runner, environment, "claude", ["--version"]).ok;
  const codexInstalled = runAgentCli(runner, environment, "codex", ["--version"]).ok;

  if (!claudeInstalled) {
    info("Claude Code is not installed, skipping");
    skipped.push("Claude Code");
  }
  if (!codexInstalled) {
    info("Codex is not installed, skipping");
    skipped.push("Codex");
  }
  if (!claudeInstalled && !codexInstalled) return { wired, failures, skipped };

  // A standalone rotation must not need another network lookup when the owner
  // has not chosen either registration. Inspect only local state first, and
  // resolve the URL/key only when there is an existing target to reconcile.
  if (existingOnly) {
    let anyExisting = false;
    if (claudeInstalled) {
      try {
        const current = readClaudeRegistration({ name }, {
          environment,
          claudeConfigPath: options.claudeConfigPath,
        });
        anyExisting ||= Boolean(current.entry);
        if (!current.entry) skipped.push("Claude Code");
      } catch {
        failures.push("Claude Code");
      }
    }
    if (codexInstalled) {
      try {
        const current = readCodexRegistration({ name }, {
          environment,
          codexConfigPath: options.codexConfigPath,
        });
        anyExisting ||= Boolean(current.entry);
        if (!current.entry) skipped.push("Codex");
      } catch {
        failures.push("Codex");
      }
    }
    if (failures.length || !anyExisting) return { wired, failures, skipped };
  }

  let base = options.baseUrl || null;
  if (!base) {
    const acct = options.account || await resolveAccount(m).catch(() => null);
    base = await resolveBaseUrl(m, acct).catch(() => null);
  }
  if (!base) {
    warn("could not determine the brain URL, so AI tool registrations were not changed");
    return { wired, failures: ["url"], skipped: [] };
  }

  try {
    const persistenceOptions = {
      platform: options.platform ?? process.platform,
      username: options.username ?? environment.USERNAME ?? environment.USER,
      environment,
      ...(options.persistenceOptions || {}),
    };
    const makePlan = options.adminKeyPersistencePlan ?? adminKeyPersistencePlan;
    const readDurable = options.readAdminKeyDurably ?? readAdminKeyDurably;
    const plan = makePlan(manifestPath, m, persistenceOptions);
    if (!readDurable(plan, persistenceOptions)) throw new Error("missing durable key");
  } catch {
    warn("the durable admin key could not be verified, so AI tool registrations were not changed");
    return { wired, failures: ["durable-key"], skipped: [] };
  }

  const desired = mcpRegistrationDescriptor(m, manifestPath, {
    baseUrl: base,
    serverPath: options.serverPath,
    nodePath: options.nodePath,
  });
  const verifyRuntime = options.verifyMcpRuntime ?? verifyMcpRuntime;
  if (!verifyRuntime(desired, { environment, ...(options.runtimeOptions || {}) })) {
    warn(
      "the MCP server did not complete its local initialize handshake, so no AI tool registration was changed"
    );
    return { wired, failures: ["MCP runtime"], skipped };
  }
  const reconcileOptions = {
    environment,
    existingOnly,
    runCommand: runner,
    claudeConfigPath: options.claudeConfigPath,
    codexConfigPath: options.codexConfigPath,
  };
  if (claudeInstalled) {
    let result;
    try {
      result = reconcileClaudeRegistration(desired, reconcileOptions);
    } catch {
      result = { status: "failed", reason: "unsafe-config" };
    }
    if (["verified", "updated", "added"].includes(result.status)) {
      ok(`Claude Code: "${desired.name}" registered with a durable credential locator`);
      wired.push("Claude Code");
    } else if (result.status === "skipped") {
      skipped.push("Claude Code");
    } else {
      warn(
        `Claude Code's "${desired.name}" registration could not be reconciled safely. ` +
          "No literal credential was written; rerun setup or use brain mcp-config."
      );
      failures.push("Claude Code");
    }
  }

  if (codexInstalled) {
    const result = reconcileCodexRegistration(desired, reconcileOptions);
    if (["verified", "updated", "added"].includes(result.status)) {
      ok(`Codex: "${desired.name}" registered with a durable credential locator`);
      wired.push("Codex");
    } else if (result.status === "skipped") {
      skipped.push("Codex");
    } else {
      warn(
        `Codex's "${desired.name}" registration could not be verified exactly. ` +
          "No literal credential was written; rerun setup or use brain mcp-config."
      );
      failures.push("Codex");
    }
  }

  return { wired, failures, skipped };
}


/**
 * The admin key, from the environment, a declared Keychain item, or the file
 * setup wrote.
 *
 * The env var wins so a rotation can be tested without touching the file. The
 * durable Keychain or owner-only file lookup is what makes tomorrow work: a
 * client who ran `brain setup` never saw the key and should never need to.
 */
export function resolveAdminKey(manifestPath, {
  platform = process.platform,
  read = (path) => readFileSync(path, "utf-8"),
  exists = existsSync,
  readAdminKey = readAdminKeyFile,
  runPowerShell,
  runSecurity,
  runChild,
  environment = process.env,
  ignoreEnvironment = false,
} = {}) {
  if (!ignoreEnvironment && environment?.ADMIN_KEY) return environment.ADMIN_KEY;
  try {
    const manifest = JSON.parse(read(manifestPath));
    const reference = manifest?.operations?.admin_key_secret;
    if (reference) {
      if (platform !== "darwin") return undefined;
      const locator = parseAdminKeySecretReference(reference);
      const child = runChild ?? (runSecurity
        ? (_command, args, childOptions) => runSecurity(args, childOptions)
        : undefined);
      return readAdminKeyFromKeychain(locator, {
        ...(child ? { runChild: child } : {}),
        environment,
      }) || undefined;
    }
    const p = join(dirname(resolve(manifestPath)), ".brain-admin-key");
    if (exists(p)) {
      const k = readAdminKey(p, { platform, runPowerShell });
      if (k) return k;
    }
  } catch { /* fall through to the callers' own error text */ }
  return undefined;
}


/* ------------------------------------------------------- failure handling */

/**
 * Nothing raw ever reaches a client's terminal.
 *
 * Install number one runs live on someone's machine while they watch. A Node
 * stack trace in that moment tells them nothing they can act on and costs more
 * trust than the underlying bug does. This says three things instead: what
 * happened, that it is not their fault, and that re-running is safe, which is
 * true because every command here is idempotent.
 *
 * The stack is still one environment variable away for whoever has to fix it.
 */
function crash(err) {
  const msg = err && err.message ? err.message : String(err);
  const supportEventId = recordSupportFailure(err, { unexpected: true });
  // A refused credential is not a bug in this tool, and saying so is worse than
  // saying nothing: a mistyped or expired token is the single most likely
  // install-day mistake, and "not something you did wrong" is the one sentence
  // that stops the owner from fixing it (bench, 2026-08-28).
  if (isCredentialRejection(err)) {
    console.error(`\n${c.red("fail")}  Cloudflare refused the credential: ${msg}`);
    console.error("  " + CF_TOKEN_REJECTED_REMEDY.split("\n").join("\n  "));
    console.error("\n  Nothing was created or half-written. Re-run once the token is right.");
    printSupportReceipt(supportEventId, (line) => console.error(line));
    process.exit(1);
  }
  console.error(`\n${c.red("unexpected error")}  ${msg}`);
  console.error("  This is a bug in the installer, not something you did wrong.");
  console.error("  Every command here is safe to run again: nothing is left half-written that");
  console.error("  a re-run cannot finish.");
  if (process.env.BRAIN_DEBUG) {
    console.error("\n" + (err && err.stack ? err.stack : String(err)));
  } else {
    console.error(`\n  For the technical detail to send on: ${c.bold("BRAIN_DEBUG=1")} <the same command>`);
  }
  printSupportReceipt(supportEventId, (line) => console.error(line));
  process.exit(1);
}

/**
 * fetch with a deadline, because a hang is worse than a failure.
 *
 * A request with no timeout leaves the client staring at a frozen terminal with
 * no output and no idea whether to wait or interrupt. Every network call here
 * now either answers, fails with a reason, or gives up out loud.
 */
const HTTP_TIMEOUT_MS = 60_000;

/**
 * A response body fit to print to a person.
 *
 * A clean install once ended with a Cloudflare error page pasted into the
 * terminal, opening `<!DOCTYPE html>` and three IE conditional comments
 * (bench, 2026-08-28). The install was fine. Nothing in that output told the
 * owner so, and nothing in it was actionable. A body that is not JSON is not
 * from the brain, so say what it is and keep the bytes for the issue note.
 */
/** How many times a fresh deploy 404 is treated as route warm-up, not failure. */
const DRAIN_ROUTE_WARMUP_ATTEMPTS = 10;
/** Individual warm-up delays stop doubling here, so the wait stays legible. */
const DRAIN_ROUTE_WARMUP_MAX_DELAY_MS = 30_000;

export function summariseResponseBody(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "the response had no body";
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error || parsed?.message || parsed?.errors?.[0]?.message;
    return message ? String(message).slice(0, 200) : text.slice(0, 200);
  } catch { /* not JSON: fall through */ }
  if (/^\s*<(?:!doctype|html|head|body)\b/i.test(text)) {
    return "the reply was a web page, not this brain. That usually means the address " +
      "is not serving the worker yet, or a proxy answered instead of it";
  }
  return text.replace(/\s+/g, " ").slice(0, 160);
}

function translatedHttpFailure(error, url, { timeoutMs = HTTP_TIMEOUT_MS, what = "the request" } = {}) {
  let host = "the server";
  try {
    host = new URL(String(url)).host;
  } catch { /* a relative or odd URL still deserves a real error below */ }
  const name = error?.name || "";
  const code = String(error?.cause?.code || error?.code || "");
  let message;
  let retryable = false;
  if (name === "TimeoutError" || name === "AbortError") {
    retryable = true;
    message =
      `${what} timed out after ${Math.round(timeoutMs / 1000)}s (${host}).\n` +
      "      Nothing is stuck: whatever had already completed is saved, and re-running\n" +
      "      the same command continues from there. Check the connection, a VPN, or a\n" +
      "      corporate proxy, then try again.";
  } else if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    retryable = true;
    message = `${host} could not be resolved (${code}). Check the network connection or a DNS/VPN setting.`;
  } else if (
    ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(code) ||
    /^UND_ERR_.*TIMEOUT$/.test(code)
  ) {
    retryable = true;
    message = `the connection to ${host} failed (${code}). This is usually a network blip; re-running the command is safe.`;
  } else if (/certificate|self-signed|CERT_/i.test(`${code} ${String(error?.message || "")}`)) {
    message =
      `the TLS certificate for ${host} was rejected.\n` +
      "      On a corporate network this usually means an inspecting proxy. Ask IT for the\n" +
      "      root certificate, or run this from a different network.";
  } else {
    message = `${what} failed talking to ${host}: ${error?.message || String(error)}`;
  }
  const translated = new Error(message);
  translated.retryable = retryable;
  return translated;
}

async function http(url, opts = {}, {
  timeoutMs = HTTP_TIMEOUT_MS,
  what = "the request",
  fetchImpl = fetch,
} = {}) {
  try {
    return await guardBrainAdminFetch(fetchImpl, url, {
      ...opts,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw translatedHttpFailure(error, url, { timeoutMs, what });
  }
}

/**
 * Retry an operation that is already safe to repeat.
 *
 * This is deliberately opt-in rather than built into http(): a lost response
 * to an arbitrary POST is not proof that the write did not happen. The vector
 * drain is different. It removes an outbox row only after Vectorize accepts
 * that exact id, and a second drain call simply continues with what remains.
 */
export async function retryTransient(operation, {
  attempts = 3,
  delayMs = 2_000,
  maxDelayMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldRetry = () => true,
  onRetry = () => {},
} = {}) {
  const totalAttempts = Math.max(1, Math.trunc(Number(attempts) || 1));
  const baseDelay = Math.max(0, Number(delayMs) || 0);
  const delayCeiling = Math.max(baseDelay, Number(maxDelayMs) || baseDelay);
  let lastError;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= totalAttempts || !shouldRetry(error, attempt, totalAttempts)) throw error;
      onRetry(error, attempt, totalAttempts);
      await sleep(Math.min(delayCeiling, baseDelay * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429]);

function isRetryableHttpStatus(status) {
  const value = Number(status);
  return RETRYABLE_HTTP_STATUS.has(value) || value >= 500;
}

class RetryableHttpResponse extends Error {
  constructor(result, what) {
    super(`${what} returned temporary HTTP ${result.res.status}`);
    this.name = "RetryableHttpResponse";
    this.retryable = true;
    this.result = result;
  }
}

/**
 * Send one exact ingest batch through a bounded retry boundary.
 *
 * Repeating this POST is safe: document identity plus content hash make an
 * accepted first copy return `unchanged` when its response was lost. Only
 * transport failures and explicitly temporary HTTP statuses enter this path;
 * credential, permission, validation and other 4xx responses return at once
 * for the existing receipt/error handling below.
 */
export async function requestIngestBatch({
  base,
  adminKey,
  docs,
  attempts = 5,
  delayMs = 2_000,
  maxDelayMs = 30_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
} = {}) {
  const url = `${base}/api/admin/brain/ingest/batch`;
  try {
    return await retryTransient(async () => {
      const res = await http(url, {
        method: "POST",
        headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
        body: JSON.stringify({ docs }),
      // A batch is up to 50 documents to chunk, hash and queue, so it is allowed
      // materially longer than a health probe before it is called dead.
      }, { timeoutMs: 180_000, what: "the ingest batch", fetchImpl });
      let raw;
      try {
        // The server can commit a safe write and then lose the response body.
        // Keeping body reads inside the retry boundary makes that case resumable
        // without weakening the exact receipt validation performed by the caller.
        raw = await res.text();
      } catch (error) {
        const translated = translatedHttpFailure(error, url, {
          timeoutMs: 180_000,
          what: "the ingest batch response",
        });
        if (!res.ok && !isRetryableHttpStatus(res.status)) translated.retryable = false;
        throw translated;
      }
      const result = { res, raw };
      if (isRetryableHttpStatus(res.status)) throw new RetryableHttpResponse(result, "the ingest batch");
      return result;
    }, {
      attempts,
      delayMs,
      maxDelayMs,
      sleep,
      shouldRetry: (error) => error?.retryable === true,
      onRetry,
    });
  } catch (error) {
    // After the bounded retry budget, preserve the final HTTP response so the
    // established status/body path emits the same actionable failure as before.
    if (error instanceof RetryableHttpResponse) return error.result;
    throw error;
  }
}


/**
 * brain whatsnew — what changed, in the client's own terminal.
 *
 * A client who receives an upgrade has no way to know what arrived. Telling
 * them in an email works once and is lost by the second release; a changelog
 * the tool itself reads is the version that keeps working. It also shows what
 * they are running against what is installed, because "am I on the new one" is
 * the first question an upgrade raises.
 */
async function cmdWhatsnew(manifestPath) {
  console.log("");
  let installed = null;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const { m } = loadManifest(manifestPath);
      installed = m.brain?.version || null;
    } catch { /* the changelog is worth showing regardless */ }
  }
  if (installed && installed !== PRODUCT_VERSION) {
    warn(
      `this brain is recorded at ${installed}, and you have ${PRODUCT_VERSION} installed.\n` +
        `        Bring it up to date with: brain upgrade ${relative(process.cwd(), manifestPath)}`
    );
    console.log("");
  } else if (installed) {
    ok(`up to date, running ${PRODUCT_VERSION}`);
    console.log("");
  }

  const path = join(HERE, "CHANGELOG.md");
  if (!existsSync(path)) {
    info(`no changelog shipped with this version (${PRODUCT_VERSION}).`);
    return;
  }
  // Printed rather than paged: a client on Windows should not meet a pager.
  console.log(readFileSync(path, "utf-8").trimEnd());
  console.log("");
}

/* ---------------------------------------------------------------- main */

// Only run the CLI when this file IS the program. Without this guard, importing
// brain.mjs to test any of its logic runs the whole command dispatcher and exits
// the process, which is why no test had ever imported it and why a broken SQL
// splitter shipped undetected.
// realpathSync on BOTH sides. npm installs the bin as a SYMLINK, so argv[1] is
// /prefix/bin/brain while import.meta.url is the real file under node_modules.
// Compared without resolving, IS_MAIN is false and the installed CLI runs and
// does NOTHING, exit 0 — the worst possible failure, because it looks like
// success to every script that checks the exit code.
const IS_MAIN = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

const [, , cmd, manifestPath] = process.argv;
currentSupportCommand = String(cmd || "");
/**
 * Drive the vector drain to completion instead of waiting for the cron.
 *
 * The initial load is a one-off bulk event, unlike the steady trickle the cron
 * is sized for. Waiting it out is what makes an install look mediocre: the brain
 * answers keyword queries confidently while most of its own material is
 * semantically invisible, and nothing on screen explains why.
 *
 * The rate printed here is MEASURED from the drain in progress, not assumed.
 */
/**
 * Say what is actually outstanding after an ingest, rather than "a few minutes".
 *
 * A real 2 MB field corpus produced 1,001 chunks and took about 50 minutes after
 * a message had promised minutes. Understating this is a first-impression risk,
 * so the number is read from the install rather than guessed at.
 */
/** Chunks still awaiting embedding, or 0 if it cannot be determined. */
async function backlogCount(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) return 0;
  const res = await http(`${base}/api/admin/brain/documents`, { headers: { "X-Admin-Key": adminKey } },
    { timeoutMs: 30_000, what: "the backlog check" });
  if (!res.ok) return 0;
  return Number((await res.json())?.vector_backlog?.pending || 0);
}

async function reportBacklog(manifestPath) {
  try {
    const { m } = loadManifest(manifestPath);
    const acct = m.brain?.domain ? null : await resolveAccount(m);
    const base = await resolveBaseUrl(m, acct);
    const adminKey = resolveAdminKey(manifestPath);
    if (!adminKey) return;
    const res = await http(`${base}/api/admin/brain/documents`, { headers: { "X-Admin-Key": adminKey } },
      { timeoutMs: 30_000, what: "the backlog check" });
    if (!res.ok) return;
    const body = await res.json();
    const pending = Number(body?.vector_backlog?.pending || 0);
    const readiness = body?.vector_readiness;
    if (!pending && readiness?.ready === true &&
        readiness.actual_vectors === readiness.expected_vectors) {
      ok("the vector index is query-ready: semantic search is live now");
      return;
    }
    const rel = relative(process.cwd(), manifestPath || "./brain.manifest.json");
    if (!pending) {
      warn(
        "Vectorize has not proven the same query-visible corpus as D1." + "\n" +
          `        Verify it now:  brain health ${rel}`
      );
      return;
    }
    warn(
      `${pending} chunk(s) are queued or awaiting visibility. Until confirmed they are findable` + "\n" +
        "        by keyword and INVISIBLE to meaning-based search, and nothing else reports that." + "\n" +
        `        Finish it now instead of waiting for the cron:  brain drain ${rel}`
    );
  } catch {
    // Never fail an ingest because the follow-up report could not be fetched.
    info("the vector index trails the text; check with `brain health`");
  }
}

/**
 * Rebuild the vector index from D1, without the original source files.
 *
 * D1 holds the chunk text, so this is the recovery path for every way the two
 * stores can drift apart: a rollback that restored D1 and left Vectorize where
 * it was, a metadata index created after ingest (verified 2026-08-18: a
 * re-upsert of the same id DOES become filterable, so this repairs it), or a
 * Vectorize index that was lost, since it has no backup or export of its own.
 *
 * Dry runs by default, like forget, and arms with --yes.
 */
/** Render a diagnosis for a human. Exported so it can be exercised without a network. */
export function renderDiagnosis(r) {
  console.log(`\n  ${c.bold("what is in the brain")}`);
  console.log(`    ${num(r.totals.documents).padStart(9)}  documents`);
  console.log(`    ${num(r.totals.chunks).padStart(9)}  chunks`);
  console.log(`    ${num(r.totals.sources).padStart(9)}  sources`);

  const AREAS = [
    ["coverage", "is anything missing"],
    ["integrity", "is it stored correctly"],
    ["efficiency", "is it stored well"],
    ["meta", "checks that could not run"],
  ];
  const MARK = { crit: c.red("!!"), warn: c.yellow(" !"), info: c.dim(" ·"), ok: c.green(" ok") };

  for (const [area, label] of AREAS) {
    const fs = (r.findings || []).filter((f) => f.area === area);
    if (!fs.length) continue;
    console.log(`\n  ${c.bold(label)}`);
    for (const f of fs) {
      console.log(`    ${MARK[f.severity] || "  "}  ${f.title}`);
      if (f.detail) console.log(`         ${c.dim(f.detail)}`);
      for (const sm of (f.samples || []).slice(0, 5)) console.log(`           ${c.dim("- " + String(sm).slice(0, 96))}`);
      if (f.action) console.log(`         ${c.bold("do:")} ${f.action}`);
    }
  }

  const s = r.summary || {};
  console.log("");
  if (r.verdict === "healthy") {
    ok("nothing is missing, nothing is stored wrong, and nothing is being wasted.");
  } else if (r.verdict === "usable_with_gaps") {
    warn(`the brain works, with ${s.warn} thing(s) worth fixing. Nothing here makes an answer wrong.`);
  } else {
    warn(
      `${s.crit} problem(s) that WILL make answers wrong or incomplete, and ${s.warn} worth fixing.` + "\n" +
        "        Each one above says what to do. None of them would show up in `brain health`."
    );
  }
  return r;
}

/**
 * Post-install diagnostic. What is missing, what is stored wrong, what is stored
 * wastefully.
 *
 * Written to be read by the person who paid for the install, not by whoever
 * built it. Every finding says what it means and what to do, because a number
 * without an action just moves the problem.
 */
/**
 * Run the acceptance test for THIS brain, on the owner's own questions.
 *
 * Two things a client could not do before this existed. They could not run the
 * quality test at all, because the harness was a development tool that never
 * shipped. And there was no way to author a question set, so the only one in
 * existence was the author's own, full of his private business.
 *
 * The unanswerable questions are the point. Anyone can demonstrate a brain
 * finding something. A brain that declines a question it genuinely cannot answer
 * is the thing that makes the rest of its answers worth believing.
 */
export function assertEvalSucceeded(result) {
  if (result?.ok) return result;
  die(
    "evaluation did not complete successfully. The detailed output is above.\n" +
      "      Nothing in the question set was changed; fix the reported cause and re-run it."
  );
}

/**
 * Prove the selected suite profile before resolving any account, URL, or key.
 *
 * The user-facing command otherwise has to resolve those remote and credential
 * dependencies before it starts the child evaluator. A release suite that is
 * structurally incapable of passing must stop before either path is touched.
 */
export function assertEvalProfilePreflight(goldenPath, requestedProfile = "smoke", options = {}) {
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  let golden;
  try {
    golden = JSON.parse(String(read(goldenPath)));
  } catch {
    throw new Error("the evaluation set is not valid readable JSON; no credential or network path was used");
  }
  const result = evaluateProfileCoverage(golden, requestedProfile);
  if (result.failures.length > 0) throw new Error(formatProfileFailures(result));
  return result;
}

/** The eval child receives its one required key on stdin and no credentials in its environment. */
export function evalChildEnvironment(environment = process.env) {
  return localToolEnvironment(environment, { BRAIN_ADMIN_KEY_STDIN: "1" });
}

/** Build the evaluator command line with an explicit profile every time. */
export function evalChildArguments(base, goldenPath, requestedProfile, flags = {}, context = {}) {
  const args = [
    join(HERE, "eval", "run.mjs"),
    "--base", base,
    "--golden", goldenPath,
    "--profile", requestedProfile,
  ];
  for (const f of ["limit", "k", "repeat", "baseline", "save", "artifacts"]) {
    if (flags[f] && flags[f] !== true) args.push(`--${f}`, String(flags[f]));
  }
  for (const f of ["rerank", "graph-boost", "no-think", "json"]) {
    if (flags[f]) args.push(`--${f}`);
  }
  if (flags["corpus-contract"] && flags["corpus-contract"] !== true) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(context.installationRef || ""))) {
      throw new Error("a manifest installation reference is required with --corpus-contract");
    }
    args.push("--corpus-contract", String(flags["corpus-contract"]));
    args.push("--installation-ref", String(context.installationRef));
  }
  return args;
}

/** Create the owner's private eval set once, without links or broad file modes. */
export function writePrivateEvalTemplate(destination, options = {}) {
  if (options.force) {
    throw new Error(
      "--force is not supported for private evaluation sets. Rename the existing file first so no questions are overwritten.",
    );
  }
  const path = resolve(destination);
  const parent = dirname(path);
  const parentIdentity = lstatSync(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    throw new Error("the evaluation-set directory must be a real directory, not a link");
  }
  const template = readFileSync(join(HERE, "eval", "golden", "TEMPLATE.golden.json"));
  let descriptor = null;
  let created = false;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    const identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1) {
      throw new Error("the evaluation-set destination is not a private regular file");
    }
    writeFileSync(descriptor, template);
    fsyncSync(descriptor);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort cleanup below */ }
      descriptor = null;
    }
    if (created) {
      try { unlinkSync(path); } catch { /* never hide the original failure */ }
    }
    if (error?.code === "EEXIST") {
      throw new Error("the private evaluation set already exists; rename it before creating another");
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return path;
}

async function cmdEval(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  const { m } = loadManifest(manifestPath);
  const dir = dirname(resolve(manifestPath || "./brain.manifest.json"));
  const goldenPath = flags.golden && flags.golden !== true
    ? resolve(String(flags.golden))
    : join(dir, "brain.golden.json");

  if (flags.init) {
    if (existsSync(goldenPath)) {
      die(
        `${relative(process.cwd(), goldenPath)} already exists.` + "\n" +
          "  It contains private questions, so the evaluator never overwrites it. Rename it first if you want a fresh template."
      );
    }
    try {
      writePrivateEvalTemplate(goldenPath, { force: !!flags.force });
    } catch (error) {
      die(`could not create the private evaluation set safely: ${error.message}`);
    }
    ok(`wrote ${relative(process.cwd(), goldenPath)}`);
    console.log(
      "\n  Fill it in, and do it in this order, because the order is what makes the\n" +
      "  result mean anything:\n\n" +
      `    1. Write the questions FIRST, from memory, without opening your files.\n` +
      `       A question written while reading a document borrows its wording, and\n` +
      `       the brain then finds it by matching words instead of meaning. That\n` +
      `       flatters the score and teaches you nothing.\n\n` +
      `    2. THEN find which document should answer each one and name it.\n\n` +
      `    3. Add 4 or 5 questions you KNOW it cannot answer, marked unanswerable.\n` +
      `       These are the most valuable entries in the file.\n\n` +
      `  Then run:  brain eval ${relative(process.cwd(), manifestPath || "brain.manifest.json")}\n` +
      `  Or build it in a guided session instead:  --golden-20\n`
    );
    return;
  }

  if (flags["golden-20"]) {
    // The guided Golden 20 session: the owner writes questions from memory,
    // the brain's own retrieval locates the evidence, the owner confirms it.
    // Cloudflare is OPTIONAL here for the same reason as scoring: the session
    // talks to the worker over HTTPS with the admin key, so the handoff
    // ritual keeps working after our account token is revoked.
    const sessionAccount = m.brain?.domain ? null : await resolveAccount(m);
    const sessionBase = await resolveBaseUrl(m, sessionAccount);
    const sessionKey = resolveAdminKey(manifestPath);
    if (!sessionKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");
    const { BrainClient } = await import("./eval/brain-client.mjs");
    const { runGolden20Session } = await import("./eval/golden-20.mjs");
    let session;
    try {
      session = await runGolden20Session({
        goldenPath,
        client: new BrainClient({ base: sessionBase, adminKey: sessionKey }),
        askFn: ask,
        log: (line) => console.log(line),
        manifest: m,
        now: () => new Date(),
      });
    } catch (error) {
      die(error?.message || "the Golden 20 session failed");
    }
    if (session.total === 0) {
      console.log("  No questions were written, so there is nothing to score yet.");
      closePrompts();
      return;
    }
    const scoreNow = (await ask("Score it now with the smoke profile? (y/n)", "y")).toLowerCase();
    closePrompts();
    if (scoreNow !== "y") {
      console.log(`  Score later with:  brain eval ${relative(process.cwd(), manifestPath || "brain.manifest.json")}`);
      return;
    }
    // Fall through into normal scoring: build twenty, then watch them score,
    // in one sitting. That first scorecard is the handoff artifact.
  }

  if (!existsSync(goldenPath)) {
    die(
      `no question set at ${relative(process.cwd(), goldenPath)}.` + "\n" +
        `  Create one with:  brain eval ${relative(process.cwd(), manifestPath || "brain.manifest.json")} --init` + "\n" +
        `  Or build it in a guided session:  brain eval ${relative(process.cwd(), manifestPath || "brain.manifest.json")} --golden-20` + "\n" +
        "  It has to be YOUR questions about YOUR documents. A generic test would" + "\n" +
        "  measure nothing about this brain."
    );
  }

  // The top-level command owns this default and always passes it to the child.
  // A locally edited eval.config.json must not let the parent preflight smoke
  // while the child silently selects release after credential resolution.
  const requestedProfile = flags.profile && flags.profile !== true
    ? String(flags.profile)
    : "smoke";

  // This must stay ahead of account/base/admin-key resolution. Besides being
  // faster, that ordering makes the documented pre-credential release gate a
  // real product invariant rather than a property of the child runner alone.
  try {
    const preflight = assertEvalProfilePreflight(goldenPath, requestedProfile);
    if (preflight.profile === "release" && flags["no-think"]) {
      throw new Error(
        "--no-think cannot be used with the release profile because every refusal and declared answer canary must run",
      );
    }
  } catch (error) {
    die(error?.message || "evaluation profile preflight failed");
  }

  let corpusContractPath = null;
  if (flags["corpus-contract"]) {
    if (flags["corpus-contract"] === true) {
      die("--corpus-contract needs the path to a private corpus contract");
    }
    const installationRef = String(m.client?.slug || "");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(installationRef)) {
      die("the manifest needs a valid client.slug before a corpus contract can be bound to this install");
    }
    corpusContractPath = resolve(String(flags["corpus-contract"]));
    try {
      const bundle = await loadCorpusContract(corpusContractPath, {
        installationRef,
      });
      const readiness = corpusContractReadiness(bundle.contract);
      if (readiness.status !== "ready") throw new Error(formatCorpusReadinessFailure(readiness));
    } catch (error) {
      die(error?.message || "corpus contract preflight failed");
    }
  }

  // Cloudflare is OPTIONAL here, deliberately. This command talks to the worker
  // over plain HTTPS with the admin key, so it must keep working after our token
  // is revoked at handoff. A command that proves the brain works, but only while
  // we still hold a key to the client's account, proves the wrong thing.
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");

  const args = evalChildArguments(
    base,
    goldenPath,
    requestedProfile,
    corpusContractPath ? { ...flags, "corpus-contract": corpusContractPath } : flags,
    { installationRef: m.client?.slug || null },
  );

  const keyInput = Buffer.from(`${adminKey}\n`, "utf8");
  let r;
  try {
    r = run(process.execPath, args, {
      env: evalChildEnvironment(),
      inheritEnv: false,
      input: keyInput,
      timeout: 600_000,
    });
  } finally {
    keyInput.fill(0);
  }
  process.stdout.write(r.out || "");
  return assertEvalSucceeded(r);
}

async function cmdDiagnose(manifestPath) {
  const { m } = loadManifest(manifestPath);
  // Cloudflare is OPTIONAL here, deliberately. This command talks to the worker
  // over plain HTTPS with the admin key, so it must keep working after our token
  // is revoked at handoff. A command that proves the brain works, but only while
  // we still hold a key to the client's account, proves the wrong thing.
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");

  const res = await http(`${base}/api/admin/brain/diagnose`, { headers: { "X-Admin-Key": adminKey } },
    { timeoutMs: 120_000, what: "the diagnostic" });
  if (!res.ok) die(`diagnose failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const r = await res.json();

  renderDiagnosis(r);
  return r;
}

function nonNegativeReceiptCount(body, field, label) {
  const value = body?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    die(`${label} did not include a valid non-negative whole-number ${field} count. Nothing was declared complete.`);
  }
  return value;
}

/** Accept only the exact reindex receipt shape the installed Worker promises. */
export function validateReindexReceipt(body, { confirm = false, source = null } = {}) {
  const phase = confirm ? "confirmation" : "preview";
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    die(`reindex returned HTTP success but no valid ${phase} receipt. Nothing was treated as queued.`);
  }
  const chunks = nonNegativeReceiptCount(body, "chunks", `the reindex ${phase} receipt`);
  const queued = nonNegativeReceiptCount(body, "queued", `the reindex ${phase} receipt`);
  const alreadyQueued = nonNegativeReceiptCount(body, "already_queued", `the reindex ${phase} receipt`);
  if (body.dry_run !== !confirm) {
    die(`the reindex ${phase} receipt did not confirm ${confirm ? "a real queue write" : "a dry run"}. Nothing was treated as queued.`);
  }
  if (body.source !== source) {
    die(`the reindex ${phase} receipt did not match the requested source. Nothing was treated as queued.`);
  }
  if (!confirm) {
    if (queued !== 0) {
      die("the reindex preview claimed that it changed the queue. Refusing to treat that response as a safe dry run.");
    }
    return body;
  }

  const pending = nonNegativeReceiptCount(body, "pending", "the reindex confirmation receipt");
  if (pending !== alreadyQueued + queued) {
    die("the reindex confirmation counts do not reconcile. Nothing was treated as fully queued.");
  }
  const bootstrapRequired = body.bootstrap_required === true;
  if (bootstrapRequired && source !== null) {
    die("the reindex confirmation tried to start a whole-corpus bootstrap for one source.");
  }
  if (bootstrapRequired) {
    const epoch = nonNegativeReceiptCount(body, "bootstrap_epoch", "the reindex bootstrap receipt");
    if (epoch < 1) die("the reindex bootstrap receipt did not include a valid durable epoch.");
  }
  if (chunks > 0 && pending === 0 && !bootstrapRequired) {
    die("the reindex confirmation reported chunks to rebuild but no pending vector work. Nothing was treated as fully queued.");
  }
  return body;
}

/** A drain response is success only when both progress counts are explicit. */
export function validateDrainReceipt(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    die("drain returned HTTP success but no valid receipt. The vector index was not declared complete.");
  }
  const drained = nonNegativeReceiptCount(body, "drained", "the drain receipt");
  const submitted = nonNegativeReceiptCount(body, "submitted", "the drain receipt");
  const waiting = nonNegativeReceiptCount(body, "waiting", "the drain receipt");
  const remaining = nonNegativeReceiptCount(body, "remaining", "the drain receipt");
  if (typeof body.vector_ready !== "boolean") {
    die("the drain receipt did not prove Vectorize query readiness. Nothing was declared complete.");
  }
  // submitted and drained are cumulative progress within this HTTP call. A
  // fast provider can accept and confirm the same mutation before the Worker
  // returns, so submitted may legitimately exceed the final queue depth.
  // waiting is the current unconfirmed subset and must reconcile to remaining.
  if (waiting > remaining) {
    die("the drain receipt counts do not reconcile. The vector index was not declared complete.");
  }
  if (remaining === 0 && waiting !== 0) {
    die("the drain receipt claimed waiting work after the queue was empty. The vector index was not declared complete.");
  }
  if (remaining > 0 && body.vector_ready) {
    die("the drain receipt claimed query readiness with vector work still outstanding. Nothing was declared complete.");
  }
  if (remaining === 0 && !body.vector_ready) {
    if (body.readiness_reason === "vector_count_mismatch" &&
        Number.isSafeInteger(body.expected_vectors) && Number.isSafeInteger(body.actual_vectors)) {
      die(vectorCountMismatchFailure(body.expected_vectors, body.actual_vectors, {
        prefix: "the outbox is empty, but ",
      }));
    }
    die(
      "the outbox is empty, but Vectorize has not confirmed query visibility.\n" +
        "      Wait briefly and re-run `brain drain <manifest>`; if it persists, run `brain diagnose <manifest>`."
    );
  }
  if (remaining > 0 && drained === 0 && submitted === 0 && waiting === 0) {
    die(
      `the drain stopped making progress with ${remaining} vector operation(s) still queued.\n` +
        "      The vector index is incomplete. Run `brain diagnose <manifest>` for the exact retry reason."
    );
  }
  return { drained, submitted, waiting, remaining, vector_ready: body.vector_ready };
}

/** Refuse a green exit when the bounded drain loop ends with work outstanding. */
export function assertDrainComplete({ remaining, rounds, maxRounds = 400 }) {
  if (remaining !== 0) {
    die(
      `the drain reached its ${maxRounds}-round safety limit with ${remaining} vector operation(s) still queued.\n` +
        "      Completed chunks are safe, but the vector index is still incomplete. Re-run `brain drain` to continue."
    );
  }
  return { remaining, rounds };
}

async function cmdReindex(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  const { m } = loadManifest(manifestPath);
  // Cloudflare is OPTIONAL here, deliberately. This command talks to the worker
  // over plain HTTPS with the admin key, so it must keep working after our token
  // is revoked at handoff. A command that proves the brain works, but only while
  // we still hold a key to the client's account, proves the wrong thing.
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");
  const source = flags.source && flags.source !== true ? assertSourceName(flags.source) : null;

  const call = async (confirm) => {
    const res = await http(`${base}/api/admin/brain/reindex`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ source, confirm }),
    }, { timeoutMs: 120_000, what: "the reindex" });
    const raw = await res.text();
    if (!res.ok) die(`reindex failed (${res.status}): ${raw.slice(0, 200)}`);
    let body = null;
    try { body = JSON.parse(raw); } catch { /* validated below */ }
    return validateReindexReceipt(body, { confirm, source });
  };

  const plan = await call(false);
  if (!plan.chunks) {
    ok(source ? `nothing to reindex for source "${source}"` : "nothing to reindex: this brain has no chunks yet");
    return plan;
  }

  info(`${plan.chunks} chunk(s) would be re-embedded${source ? ` from source "${source}"` : ""}.`);
  if (!flags.yes) {
    warn(
      "nothing has changed. This was a preview." + "\n" +
        `        Re-run with --yes to rebuild the vector index from D1.` + "\n" +
        "        Your documents are not re-read, so the source folder is not needed."
    );
    return plan;
  }

  const done = await call(true);
  ok(`${done.queued} chunk(s) queued for re-embedding`);
  if (!done.queued) {
    info("everything was already queued; draining what is there.");
  }
  return cmdDrain(manifestPath);
}

export const MANUAL_DRAIN_MAX_MS = 20 * 60 * 1000;

/** Validate the lease-busy retry contract without exposing its owner token. */
export function validateDrainBusyReceipt(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.busy !== true) {
    die("the drain conflict did not include a valid busy receipt. Nothing was declared complete.");
  }
  const remaining = nonNegativeReceiptCount(body, "remaining", "the drain busy receipt");
  const retryAfterSeconds = nonNegativeReceiptCount(
    body,
    "retry_after_seconds",
    "the drain busy receipt",
  );
  if (retryAfterSeconds < 1 || retryAfterSeconds > Math.ceil(MANUAL_DRAIN_MAX_MS / 1_000)) {
    die("the drain busy receipt included an unsafe retry delay. Nothing was declared complete.");
  }
  return { remaining, retryAfterSeconds };
}

async function cmdDrain(manifestPath, options = {}) {
  const { m } = loadManifest(manifestPath);
  // Cloudflare is OPTIONAL here, deliberately. This command talks to the worker
  // over plain HTTPS with the admin key, so it must keep working after our token
  // is revoked at handoff. A command that proves the brain works, but only while
  // we still hold a key to the client's account, proves the wrong thing.
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");

  const now = typeof options.now === "function" ? options.now : Date.now;
  const wait = options.sleep ?? ((milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const callHttp = options.http ?? http;
  const maxDurationMs = Number.isSafeInteger(options.maxDurationMs)
    ? Math.min(MANUAL_DRAIN_MAX_MS, Math.max(1_000, options.maxDurationMs))
    : MANUAL_DRAIN_MAX_MS;
  const started = now();
  const deadline = started + maxDurationMs;
  let drained = 0;
  let routeWarmups = 0;
  let submitted = 0;
  let remaining = null;
  let rounds = 0;
  const maxRounds = 400;
  for (let round = 1; round <= maxRounds; round++) {
    if (now() >= deadline) break;
    rounds = round;
    const res = await retryTransient(() => callHttp(`${base}/api/admin/brain/drain`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey },
    }, {
      timeoutMs: Math.max(1_000, Math.min(180_000, deadline - now())),
      what: "the drain",
    }), {
      shouldRetry: (error) => error?.retryable === true,
      onRetry: (error, attempt, attempts) => info(
        `the drain request hit a network error (${String(error?.message || error).split("\n", 1)[0]}). ` +
        `Retrying ${attempt}/${attempts - 1}; completed chunks are already safe.`
      ),
    });
    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* validated below */ }
    if (res.status === 409) {
      const busy = validateDrainBusyReceipt(body);
      remaining = busy.remaining;
      const delayMs = Math.min(busy.retryAfterSeconds * 1_000, Math.max(0, deadline - now()));
      if (delayMs <= 0) break;
      info(`another vector drain is finishing; retrying in ${Math.ceil(delayMs / 1_000)} second(s)`);
      await wait(delayMs);
      continue;
    }
    // A worker deployed seconds ago can 404 because its workers.dev route is not
    // live yet, which made a completely healthy clean install exit 1 (bench,
    // 2026-08-28). /health returned ok moments later. Give the route a short
    // warm-up before believing a 404, bounded so a genuinely wrong address still
    // fails promptly rather than spinning until the deadline.
    // 404: the workers.dev route is not live yet. 401: the secrets were set
    // seconds ago and this worker instance has not picked them up. Both are a
    // brand-new install being asked a question before it can answer, both were
    // observed ending a perfectly healthy setup with exit 1 (bench, 2026-08-28),
    // and both clear on their own within a minute or two.
    if ((res.status === 404 || res.status === 401) && routeWarmups < DRAIN_ROUTE_WARMUP_ATTEMPTS) {
      const delayMs = Math.min(
        2_000 * 2 ** routeWarmups,
        DRAIN_ROUTE_WARMUP_MAX_DELAY_MS,
        Math.max(0, deadline - now())
      );
      if (delayMs > 0) {
        routeWarmups += 1;
        info(
          (res.status === 401
            ? "the brain is not accepting this key yet (401). Secrets set seconds ago take a moment to reach it. "
            : "the brain's address is not answering yet (404). This is normal just after a deploy. ") +
          `Retrying ${routeWarmups}/${DRAIN_ROUTE_WARMUP_ATTEMPTS} in ` +
          `${Math.ceil(delayMs / 1_000)} second(s).`
        );
        await wait(delayMs);
        continue;
      }
    }
    if (!res.ok) {
      // Everything before drain has already succeeded by this point, so a
      // failure here is "the brain is built but not finished embedding", not
      // "the install failed". Say which, and give the one command that resumes.
      const detail = summariseResponseBody(raw);
      if ((res.status === 404 || res.status === 401) && routeWarmups >= DRAIN_ROUTE_WARMUP_ATTEMPTS) {
        die(
          `the brain is built, but it did not start answering in time (${res.status}).\n` +
          `  Nothing is wrong with what was created: everything up to this point succeeded.\n` +
          `  A new address can take a few minutes to go live. Check it with:\n` +
          `    curl ${base}/health\n` +
          `  then finish the embedding with:\n` +
          `    brain drain <manifest>`
        );
      }
      die(`drain failed (${res.status}): ${detail}`);
    }
    const receipt = validateDrainReceipt(body);
    drained += receipt.drained;
    submitted += receipt.submitted;
    remaining = receipt.remaining;
    const mins = (now() - started) / 60000;
    const rate = mins > 0.05 ? Math.round(drained / mins) : null;
    info(
      `${drained} query-visible, ${submitted} accepted, ${remaining} to go` +
        (rate ? `, ~${rate}/min` : "") +
        (rate && remaining ? `, about ${Math.max(1, Math.ceil(remaining / rate))} min left` : "")
    );
    if (remaining === 0) break;
    if (receipt.waiting > 0) {
      // Vectorize V2 processes changesets asynchronously. Poll slowly enough to
      // remain Free-plan friendly, but keep the existing 400-round/20-minute
      // upper bound so a provider stall never hangs an installer indefinitely.
      const delayMs = Math.min(3_000, Math.max(0, deadline - now()));
      if (delayMs <= 0) break;
      await wait(delayMs);
    }
  }
  if (remaining !== 0 && now() >= deadline) {
    die(
      `the drain reached its ${Math.ceil(maxDurationMs / 60_000)}-minute wall-clock safety limit with ` +
        `${remaining ?? "unknown"} vector operation(s) still queued.\n` +
        "      Completed chunks are safe. Re-run `brain drain` to resume from the durable queue.",
    );
  }
  assertDrainComplete({ remaining, rounds, maxRounds });
  ok(`vector index is query-ready (${drained} confirmed)`);
  return { drained, submitted, remaining };
}

function supportCommandOperation(label, operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Fatal) throw error;
    const explained = ["SUPPORT_JOURNAL_UNSAFE_PATH", "SUPPORT_JOURNAL_EXISTS"].includes(error?.code) ||
      error instanceof TypeError;
    die(explained
      ? `${String(error.message)} The installer did not upload or send anything.`
      : `the private issue journal could not ${label}. The installer did not upload or send anything.`);
  }
}

/** Inspect or export the private local failure journal. No network is used. */
async function cmdSupport() {
  const args = process.argv.slice(3);
  const flags = parseFlags(args);
  assertKnownFlags(flags, new Set(["status", "preview", "export", "clear", "yes", "explain", "json"]), "brain support");
  const positional = args.filter((value, index) =>
    !value.startsWith("--") && !(index > 0 && ["--export", "--explain"].includes(args[index - 1])));
  if (positional.length) {
    die("usage: brain support [--status|--preview|--export <file>|--clear --yes|--explain <issue-code> [--json]]");
  }
  const actions = ["status", "preview", "export", "clear", "explain"].filter((name) => flags[name]);
  if (actions.length > 1) die("choose one support action at a time: preview, export, clear, or explain");
  if (flags.json && !flags.explain) die("--json pairs with --explain <issue-code>");

  if (flags.explain) {
    const recovery = supportRecovery(flags.explain);
    process.stdout.write(flags.json
      ? `${JSON.stringify(recovery, null, 2)}\n`
      : renderSupportRecovery(recovery));
    return recovery;
  }

  if (flags.preview) {
    // These are the exact canonical bytes export writes. Do not add a heading
    // here: a user reviewing the payload must see precisely what could leave.
    process.stdout.write(supportCommandOperation("be read", () => previewSupportJournal()));
    return;
  }

  if (flags.export) {
    const result = supportCommandOperation("be exported", () => exportSupportJournal(flags.export));
    ok(`exported ${result.events} private issue note(s) to ${flags.export}`);
    info("the installer did not upload or send this export; a synced destination may upload it");
    return result;
  }

  if (flags.clear) {
    if (!flags.yes) {
      warn("nothing was cleared. Re-run with --clear --yes after reviewing --preview.");
      return;
    }
    const cleared = supportCommandOperation("be cleared", () => clearSupportJournal());
    ok(cleared ? "private issue journal cleared" : "private issue journal was already empty");
    return;
  }

  const content = supportCommandOperation("be read", () => previewSupportJournal());
  const events = content ? content.split("\n").length - 1 : 0;
  const maxMiB = SUPPORT_MAX_BYTES / (1024 * 1024);
  console.log(`\n  ${c.bold("private installer issue journal")}\n`);
  console.log(`  ${events} recent shareable issue note(s) available to preview or export`);
  console.log(`  Shareable view: last ${SUPPORT_MAX_AGE_DAYS} days, newest ${SUPPORT_MAX_EVENTS} notes, up to ${maxMiB} MiB.`);
  console.log("  Safe expired and overflow notes are cleaned up after writes.");
  console.log("  Fresh or concurrent files may remain until a later safe cleanup.");
  console.log("  Links and special files are refused and require manual review.");
  console.log("  The installer has not uploaded or sent these notes.");
  console.log("  Review exact shareable bytes: brain support --preview");
  console.log("  Export for a private support issue: brain support --export <file>\n");
}

/**
 * Install, inspect, or remove the watched local folder scheduler.
 *
 * Deliberately the same command, the same three actions and the same freshness
 * bookkeeping as the Drive lane. A client should not have to learn a second
 * vocabulary because the folder they are watching happens to live outside
 * Google Drive.
 */
async function cmdScheduleFolder(m, manifestPath, action) {
  const source = String(m?.corpora?.local_folder?.source || "documents");
  let dataPlane = null;
  if (action === "install") {
    const adminKey = resolveAdminKey(manifestPath);
    if (!adminKey) {
      die("no admin key found, so the watched folder schedule cannot be reflected in source freshness.");
    }
    dataPlane = { base: await resolveBaseUrl(m, null), adminKey };
  }
  const {
    installFolderScheduler,
    statusFolderScheduler,
    removeFolderScheduler,
  } = await import("./operations/folder-scheduler.mjs");

  const result = action === "install"
    ? installFolderScheduler(manifestPath)
    : action === "remove"
      ? removeFolderScheduler(manifestPath)
      : statusFolderScheduler(manifestPath);

  for (const warning of result.warnings || []) warn(warning);
  if (action === "install") {
    await postSourceExpectation(dataPlane.base, dataPlane.adminKey, {
      source, kind: "upload", expected_refresh_seconds: result.expectedRefreshSeconds,
    });
    ok(`watched folder refresh installed for ${result.cron}`);
    info(`folder: ${result.folderPath}`);
    info(`loaded under the source name "${source}"`);
    ok(`${source} freshness expectation set to ${result.expectedRefreshSeconds} seconds`);
    info(`definition: ${result.plistPath}`);
    info(`logs: ${result.stdoutPath} and ${result.stderrPath}`);
    return result;
  }
  if (action === "remove") {
    ok(result.removed || result.loaded ? "watched folder refresh removed" : "watched folder refresh was not installed");
    try {
      const adminKey = resolveAdminKey(manifestPath);
      if (!adminKey) throw new Error("no admin key is available");
      const base = await resolveBaseUrl(m, null);
      await postSourceExpectation(base, adminKey, { source, kind: "upload", expected_refresh_seconds: null });
      ok(`${source} freshness expectation cleared`);
    } catch (error) {
      warn(`the local scheduler is removed, but its remote freshness expectation could not be cleared: ${String(error?.message || error).slice(0, 160)}`);
    }
    info(`logs preserved at ${result.stdoutPath} and ${result.stderrPath}`);
    return result;
  }

  if (!result.installed) warn("watched folder refresh is not installed on this Mac");
  else if (!result.loaded) warn("watched folder refresh has a definition but is not loaded by launchd");
  else if (result.definitionDrift) warn("the installed watched folder refresh does not match the current manifest; reinstall it");
  else ok(`watched folder refresh is installed for ${result.cron}`);
  if (result.folderPath) info(`folder: ${result.folderPath}`);
  if (result.running) info(`a folder ingest is running as pid ${result.pid}`);
  else if (result.lastRunSucceeded === false) warn(`the last scheduled run failed with exit code ${result.lastExitCode}`);
  else if (result.lastRunSucceeded === true) ok(`the last scheduled run succeeded (${result.runs ?? 0} run(s) recorded)`);
  if (result.scheduleError) warn(result.scheduleError);
  info(`stdout: ${result.stdoutPath}`);
  info(`stderr: ${result.stderrPath}`);
  return result;
}

/** Install, inspect, or remove the standard per-client Drive scheduler. */
async function cmdSchedule(manifestPath) {
  if (!manifestPath) {
    die("usage: brain schedule <manifest> [--install|--status|--remove] [--folder]");
  }
  const flags = parseFlags(process.argv.slice(4));
  const requested = ["install", "status", "remove"].filter((name) => flags[name]);
  if (requested.length > 1) {
    die("choose only one of --install, --status, or --remove");
  }
  const action = requested[0] || "status";
  const { m } = loadManifest(manifestPath);
  // The watched local folder is a second lane on the same command, because it
  // is the same question ("what refreshes itself on this Mac") asked about a
  // different source.
  if (flags.folder) return cmdScheduleFolder(m, manifestPath, action);
  let dataPlane = null;
  if (action === "install") {
    const adminKey = resolveAdminKey(manifestPath);
    if (!adminKey) {
      die("no admin key found, so the Drive schedule cannot be reflected in source freshness.");
    }
    dataPlane = { base: await resolveBaseUrl(m, null), adminKey };
  }
  const {
    installDriveScheduler,
    statusDriveScheduler,
    removeDriveScheduler,
  } = await import("./operations/drive-scheduler.mjs");

  const result = action === "install"
    ? installDriveScheduler(manifestPath)
    : action === "remove"
      ? removeDriveScheduler(manifestPath)
      : statusDriveScheduler(manifestPath);

  for (const warning of result.warnings || []) warn(warning);
  if (action === "install") {
    await postSourceExpectation(dataPlane.base, dataPlane.adminKey, {
      source: "drive", kind: "drive", expected_refresh_seconds: result.expectedRefreshSeconds,
    });
    ok(`Drive refresh installed for ${result.cron}`);
    ok(`Drive freshness expectation set to ${result.expectedRefreshSeconds} seconds`);
    info(`definition: ${result.plistPath}`);
    info(`logs: ${result.stdoutPath} and ${result.stderrPath}`);
    return result;
  }
  if (action === "remove") {
    ok(result.removed || result.loaded ? "Drive refresh removed" : "Drive refresh was not installed");
    try {
      const adminKey = resolveAdminKey(manifestPath);
      if (!adminKey) throw new Error("no admin key is available");
      const base = await resolveBaseUrl(m, null);
      await postSourceExpectation(base, adminKey, {
        source: "drive", kind: "drive", expected_refresh_seconds: null,
      });
      ok("Drive freshness expectation cleared");
    } catch (error) {
      warn(`the local scheduler is removed, but its remote freshness expectation could not be cleared: ${String(error?.message || error).slice(0, 160)}`);
    }
    info(`logs preserved at ${result.stdoutPath} and ${result.stderrPath}`);
    return result;
  }

  if (!result.installed) warn("Drive refresh is not installed on this Mac");
  else if (!result.loaded) warn("Drive refresh has a definition but is not loaded by launchd");
  else if (result.definitionDrift) warn("the installed Drive refresh does not match the current manifest; reinstall it");
  else ok(`Drive refresh is installed for ${result.cron}`);
  if (result.running) info(`a Drive sync is running as pid ${result.pid}`);
  else if (result.lastRunSucceeded === false) warn(`the last scheduled run failed with exit code ${result.lastExitCode}`);
  else if (result.lastRunSucceeded === true) ok(`the last scheduled run succeeded (${result.runs ?? 0} run(s) recorded)`);
  if (result.scheduleError) warn(result.scheduleError);
  info(`stdout: ${result.stdoutPath}`);
  info(`stderr: ${result.stderrPath}`);
  return result;
}

/** The account this manifest provisions into, for the per-account token store. */
/**
 * The account this manifest provisions into, for the per-account token store.
 *
 * This used to swallow a failed manifest load and return null, on the reasoning
 * that the command's own load would report the real problem. It does not: the
 * token ceremony runs FIRST, so an unreadable manifest surfaced as "no
 * Cloudflare token is available" and sent the operator hunting a credential
 * that was sitting in their keychain the whole time. Found running setup from a
 * git worktree, where instance files legitimately do not exist.
 *
 * Failing here also means a run that cannot possibly work never asks anyone for
 * a credential.
 */
function manifestAccountId(manifestPath) {
  let manifest;
  try {
    manifest = loadManifest(manifestPath).m;
  } catch (error) {
    die(
      `could not read the install manifest at ${manifestPath || "brain.manifest.json"}: ${error?.message || error}\n` +
        "      Every provisioning command needs it, and nothing has been changed.\n" +
        "      If you are working in a git worktree, instance files live only in the main checkout:\n" +
        "      pass the full path to the manifest there."
    );
  }
  return manifest?.infrastructure?.cloudflare?.account_id || null;
}

async function cmdSetupInteractive(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  return withCloudflareToken(
    () => cmdSetup(manifestPath, { flags }),
    { accountId: manifestAccountId(manifestPath) },
  );
}

async function cmdUpgradeInteractive(manifestPath) {
  return withCloudflareToken(() => cmdUpgrade(manifestPath), { accountId: manifestAccountId(manifestPath) });
}

/**
 * Guide one install-day account ceremony at a time without becoming a second
 * credential store. The default is a read-only plan. A selected step launches
 * the existing reviewed command in a short-lived child with an allowlisted
 * environment, so agent shells never need to receive credentials.
 */
export async function cmdTechnician(manifestPath, flags = {}, options = {}) {
  assertKnownFlags(
    flags,
    ["json", "run", "host", "user", "port", "source", "scopes", "confirm-host"],
    "brain technician",
  );
  const plan = technicianPlan(manifestPath, options.manifestDeps || {});
  const step = flags.run ? String(flags.run).trim().toLowerCase() : null;
  if (!step) {
    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(renderTechnicianPlan(plan));
    return plan;
  }
  if (flags.json) die("--json is read-only and cannot be combined with --run");

  const readHidden = options.readHidden || (({ prompt, noun, optional }) => readHiddenInput({
    prompt,
    noun,
    maxBytes: 2048,
    accepts: (byte) => byte >= 0x21 && byte <= 0x7e,
    finalize: (bytes) => {
      if (!optional && bytes.length === 0) throw new Error(`${noun} cannot be empty`);
      return Buffer.from(bytes);
    },
  }));
  try {
    const receipt = await runTechnicianStep({
      step,
      manifestPath,
      flags,
      scriptPath: options.scriptPath || fileURLToPath(import.meta.url),
      readHidden,
      baseEnv: options.baseEnv || process.env,
      spawn: options.spawn || spawnSync,
      nodePath: options.nodePath || process.execPath,
      manifestDeps: options.manifestDeps || {},
    });
    ok(`${step} technician step completed`);
    info("rerun `brain technician <manifest>` to see the full plan; live proof still comes from the final field checklist");
    return receipt;
  } catch (error) {
    die(String(error?.message || error));
  }
}

async function cmdTechnicianInteractive(manifestPath) {
  return cmdTechnician(manifestPath, parseFlags(process.argv.slice(3)));
}

/**
 * Verify the owner-facing local toolchain without touching Cloudflare.
 *
 * Version and sign-in checks are non-interactive and safe to automate.
 * `claude doctor` owns a full-screen terminal UI, so it is run only when the
 * caller really has a TTY. This keeps release tests deterministic while still
 * giving the owner Anthropic's own installation diagnosis on install day.
 */
export async function cmdLocalTools(options = {}) {
  const runCommand = options.runCommand ?? run;
  const claude = checkClaudeCode({ runCommand, required: true });
  const wrangler = checkWrangler(runCommand);
  console.log(`\n  ${c.bold("Financial Brain local tools")}\n`);
  for (const item of [claude, wrangler]) {
    const mark = item.status === D_OK ? c.green("ok  ") : c.red("FAIL");
    console.log(`  ${mark}  ${item.name.padEnd(18)}  ${item.detail}`);
  }
  const failed = [claude, wrangler].filter((item) => item.status === D_FAIL);
  if (failed.length) {
    console.log(`\n  ${c.bold("What to do")}\n`);
    for (const item of failed) {
      console.log(`  ${c.red(item.name)}\n    ${item.fix.split("\n").join("\n    ")}\n`);
    }
    die("the required local tools are not ready. Fix those items and rerun `brain tools`.");
  }

  let technicianSkill;
  try {
    technicianSkill = (options.installClaudeSkill ?? installClaudeTechnicianSkill)(
      options.claudeSkillOptions || { environment: process.env },
    );
  } catch (error) {
    die(
      `Claude Code is ready, but its Financial Brain technician skill could not be installed safely: ${error?.message || error}\n` +
      "      Nothing existing was overwritten. Resolve that path and rerun `brain tools`."
    );
  }
  ok(`Claude Code skill /financial-brain-technician ${technicianSkill.status}`);
  info("Open Claude Code and type `/skills` to see it, or `/financial-brain-technician` to begin the guided plan.");

  const hasTty = options.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!hasTty) {
    warn("Claude Code's full installation doctor needs an interactive terminal and was not run here.");
    info("Run `claude doctor` in Terminal before the owner handoff.");
    return {
      claude: "ready",
      wrangler: "ready",
      technician_skill: technicianSkill.status,
      claude_doctor: "requires_interactive_terminal",
    };
  }

  console.log(`\n  ${c.bold("Claude Code installation doctor")}\n`);
  const runClaudeDoctor = options.runClaudeDoctor ?? (() => spawnSync(
    "claude",
    ["doctor"],
    {
      stdio: "inherit",
      env: localToolEnvironment(),
      shell: process.platform === "win32",
      windowsHide: true,
    },
  ));
  const result = await runClaudeDoctor();
  if (result?.error || result?.status !== 0) {
    die("`claude doctor` did not complete cleanly. Fix its message and rerun `brain tools`.");
  }
  ok("Claude Code, sign-in, technician skill, and Wrangler 4 are ready");
  return {
    claude: "ready",
    wrangler: "ready",
    technician_skill: technicianSkill.status,
    claude_doctor: "passed",
  };
}

/** Mint a one-time passkey enrollment link for the brain's owner. */
async function cmdGrant(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  const displayName = typeof flags.name === "string" ? flags.name.trim() : "";
  const capabilities = typeof flags.can === "string"
    ? flags.can.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (!displayName || !capabilities.length) {
    die(
      "usage: brain grant <manifest> --name \"Their name\" --can ask,file [--zones books,legal] [--until YYYY-MM-DD]\n" +
      "      capabilities: ask, file, diagnose, destroy",
    );
  }
  const zones = typeof flags.zones === "string" && flags.zones.trim()
    ? flags.zones.split(",").map((value) => value.trim()).filter(Boolean)
    : null;
  let expiresAt = null;
  if (typeof flags.until === "string" && flags.until.trim()) {
    expiresAt = Date.parse(`${flags.until.trim()}T23:59:59Z`);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      die(`could not use --until ${flags.until}. Choose a future date in YYYY-MM-DD form.`);
    }
  }
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Run `brain setup <manifest>` first.");
  const response = await http(`${base}/api/admin/auth/grants`, {
    method: "POST",
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: displayName,
      relationship: typeof flags.as === "string" ? flags.as : null,
      capabilities,
      zones,
      expires_at: expiresAt,
    }),
  }, { timeoutMs: 30_000, what: "the access grant" });
  if (!response.ok) die(`grant failed (${response.status}): ${summariseResponseBody(await response.text())}`);
  const grant = await response.json();
  ok(`access granted to ${grant.display_name}: ${grant.capabilities.join(", ")}`);
  console.log(`\n  ${grant.token}\n`);
  console.log(
    "  This token is shown once. Share it over a channel you trust. If it is lost,\n" +
    `  create a replacement and revoke this one with: brain grants ${displayPath(manifestPath)} --revoke ${grant.grant_id}\n`,
  );
  return grant;
}

async function cmdGrants(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Run `brain setup <manifest>` first.");
  if (typeof flags.revoke === "string" && flags.revoke.trim()) {
    const response = await http(`${base}/api/admin/auth/grants/revoke`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ grant_id: flags.revoke.trim() }),
    }, { timeoutMs: 30_000, what: "the access revocation" });
    if (!response.ok) die(`revoke failed (${response.status}): ${summariseResponseBody(await response.text())}`);
    const result = await response.json();
    if (result.revoked) ok(`${result.grant_id} was revoked.`);
    else info(`${result.grant_id} was already inactive or was not found.`);
    return result;
  }
  const response = await http(`${base}/api/admin/auth/grants`, {
    method: "GET", headers: { "X-Admin-Key": adminKey },
  }, { timeoutMs: 30_000, what: "the access list" });
  if (!response.ok) die(`could not read access (${response.status}): ${summariseResponseBody(await response.text())}`);
  const result = await response.json();
  if (!result.grants?.length) info("Nobody but the owner has a named capability grant.");
  for (const grant of result.grants || []) {
    const state = grant.revoked_at ? "revoked" : grant.expires_at && Number(grant.expires_at) <= Date.now() ? "expired" : "active";
    let capabilities = grant.capabilities;
    try { capabilities = JSON.parse(grant.capabilities).join(", "); } catch { /* display stored value */ }
    console.log(`  ${state}  ${grant.display_name}  ${capabilities}  ${grant.grant_id}`);
  }
  return result;
}

async function cmdZone(manifestPath) {
  const { m } = loadManifest(manifestPath);
  const flags = parseFlags(process.argv.slice(4));
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Run `brain setup <manifest>` first.");
  const source = typeof flags.source === "string" ? flags.source.trim() : "";
  const zone = typeof flags.zone === "string" ? flags.zone.trim() : "";
  const response = await http(`${base}/api/admin/brain/zones`, {
    method: source || zone ? "POST" : "GET",
    headers: {
      "X-Admin-Key": adminKey,
      ...(source || zone ? { "Content-Type": "application/json" } : {}),
    },
    ...(source || zone ? { body: JSON.stringify({ source, zone }) } : {}),
  }, { timeoutMs: 60_000, what: "the zone assignment" });
  if (!response.ok) die(`zone command failed (${response.status}): ${summariseResponseBody(await response.text())}`);
  const result = await response.json();
  if (result.zones) {
    if (!result.zones.length) info("Nothing is loaded yet, so there are no zones.");
    for (const row of result.zones) console.log(`  ${row.zone}  ${row.chunks} chunk(s) from ${row.sources} source(s)`);
  } else {
    ok(`"${result.source}" is now in zone "${result.zone}" (${result.documents} document(s), ${result.chunks} chunk(s))`);
  }
  return result;
}

async function cmdInvite(manifestPath) {
  const { m } = loadManifest(manifestPath);
  // Cloudflare is OPTIONAL here, deliberately: inviting a new device must
  // keep working after our account token is revoked at handoff.
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");
  const res = await http(`${base}/api/admin/auth/invite`, {
    method: "POST",
    headers: { "X-Admin-Key": adminKey },
  }, { timeoutMs: 30_000, what: "the enrollment invite" });
  if (!res.ok) die(`invite failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const invite = await res.json();
  ok("one-time enrollment link minted (valid 15 minutes, single use)");
  console.log(`\n  ${invite.url}\n`);
  console.log(
    "  Send it to the owner however you already talk (text it, AirDrop it). They open\n" +
    "  it on THEIR device, tap once, Face ID or fingerprint — that is the whole setup.\n" +
    `  Passkeys bind to ${invite.rp_id} exactly; changing the brain's domain later\n` +
    "  requires re-enrollment, so settle the domain before the first invite.\n"
  );
  return invite;
}

/** List or revoke the owner's enrolled passkeys. */
async function cmdDevices(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  const { m } = loadManifest(manifestPath);
  const acct = m.brain?.domain ? null : await resolveAccount(m);
  const base = await resolveBaseUrl(m, acct);
  const adminKey = resolveAdminKey(manifestPath);
  if (!adminKey) die("no durable admin key was found. Repair it with `brain setup <manifest>` or `brain secrets <manifest>`.");
  if (flags.revoke && flags.revoke !== true) {
    const res = await http(`${base}/api/admin/auth/devices/revoke`, {
      method: "POST",
      headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ credential_id: String(flags.revoke) }),
    }, { timeoutMs: 30_000, what: "the device revocation" });
    const verdict = await res.json();
    if (verdict.removed) ok("passkey revoked");
    else warn(verdict.reason || `revoke failed (${res.status})`);
    return verdict;
  }
  const res = await http(`${base}/api/admin/auth/devices`, {
    headers: { "X-Admin-Key": adminKey },
  }, { timeoutMs: 30_000, what: "the device list" });
  if (!res.ok) die(`device list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { devices } = await res.json();
  if (!devices?.length) {
    info("no passkeys enrolled yet. Mint a link with `brain invite <manifest>`.");
    return { devices: [] };
  }
  console.log("");
  for (const device of devices) {
    const used = device.last_used_at ? `last used ${new Date(device.last_used_at).toISOString().slice(0, 10)}` : "never used";
    console.log(`  ${device.nickname || "unnamed device"}  ·  ${used}  ·  id ${String(device.credential_id).slice(0, 16)}…`);
  }
  console.log("\n  Revoke one with: brain devices <manifest> --revoke <full credential id>\n");
  return { devices };
}

/** Is a Cloudflare token stored on this machine for this install's account? */
async function cmdToken(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  const accountId = manifestAccountId(manifestPath);
  if (!accountId) die("this manifest names no Cloudflare account, so there is no token slot to inspect.");
  if (flags.forget) {
    const removed = forgetCloudflareToken(accountId);
    if (removed) ok(`stored Cloudflare token removed (${storedTokenReference(accountId)})`);
    else info(`nothing stored for this account (${storedTokenReference(accountId)})`);
    return;
  }
  info(hasStoredCloudflareToken(accountId)
    ? `a Cloudflare token is stored for this account: ${storedTokenReference(accountId)}.\n` +
      "      Provisioning runs load it automatically. Remove it with --forget — and always at client handoff:\n" +
      "      revoking the token in Cloudflare does not delete this machine's stored copy."
    : `nothing stored (${storedTokenReference(accountId)}). The next interactive setup or update will prompt once and offer to remember it.`);
}

/** Beginner update path: verify custody first, then run the fully gated upgrade. */
export async function cmdUpdate(manifestPath, options = {}) {
  let installed;
  try {
    const discoverManifest = options.discoverInstalledManifest ?? discoverInstalledManifest;
    installed = discoverManifest(manifestPath, options.installedManifestOptions || {});
  } catch (error) {
    die(
      `${String(error?.message || error)}. ` +
        "Run brain update <full path to brain.manifest.json> once to repair the saved location."
    );
  }
  if (!installed) {
    die(
      "no installed Brain was found. Run brain update <full path to brain.manifest.json> once; " +
        "future updates will work from any folder."
    );
  }
  const pin = pinUpdateManifest(installed.path);
  return withCloudflareToken(async () => {
    revalidateUpdateManifest(pin, "update verification");
    await (options.cmdVerify ?? cmdVerify)(pin.target);
    revalidateUpdateManifest(pin, "update verification");
    const upgradeResult = await (options.cmdUpgrade ?? cmdUpgrade)(
      pin.target,
      options.upgradeOptions || {},
    );
    if (installed.source !== "remembered") {
      try {
        const rememberManifest = options.rememberInstalledManifest ?? rememberInstalledManifest;
        rememberManifest(pin.target, {
          ...(options.installedManifestOptions || {}),
          repairUnsafePointer: installed.source === "explicit",
        });
      } catch (error) {
        die(
          "the Brain update is verified, but this computer could not safely remember the manifest location. " +
            "No update work needs to be undone. Fix the local install folder and rerun the same full-path command."
        );
      }
    }
    return upgradeResult;
  }, { accountId: manifestAccountId(pin.target), ...options });
}

export async function cmdRollbackInteractive(manifestPath, bookmarkArg, options = {}) {
  const preflight = rollbackLocalPreflight(manifestPath, bookmarkArg);
  if (options.confirmed !== true) return printRollbackPreview(preflight);
  return withCloudflareToken(
    () => (options.cmdRollback ?? cmdRollback)(manifestPath, bookmarkArg, {
      ...(options.rollbackOptions || {}),
      confirmed: true,
    }),
    { accountId: manifestAccountId(manifestPath), ...options },
  );
}

async function dispatchRollback(manifestPath) {
  const args = process.argv.slice(4);
  const bookmark = args[0];
  const trailing = args.slice(1);
  const flags = parseFlags(trailing);
  const unknown = Object.keys(flags).filter((name) => name !== "yes");
  if (trailing.some((value) => !value.startsWith("--")) || unknown.length) {
    die("usage: brain rollback <manifest> <bookmark> [--yes]");
  }
  return cmdRollbackInteractive(manifestPath, bookmark, { confirmed: flags.yes === true });
}

/** Every option `brain doctor` reads. Anything else is a typo or a flag from a
 * release this one is not. */
const DOCTOR_FLAGS = ["repair", "rollback", "repair-checksum", "yes"];

/**
 * `brain doctor [manifest]` with no flags stays the existing pure preflight.
 * `brain doctor <manifest> --repair|--rollback [--yes]` is the stuck-upgrade
 * path (resume or restore a mid-migration pause). `brain doctor <manifest>
 * --repair-checksum [--yes]` is the DIFFERENT path for an applied migration
 * whose file content has since changed — see diagnoseChecksumDrift's own
 * comment for why the two must not be conflated. All three need a Cloudflare
 * token (they read D1 and, once confirmed, mutate it) so each is wrapped in
 * withCloudflareToken exactly like `brain update` and `brain setup` already
 * are. Only one of the three may be requested at a time.
 */
async function dispatchDoctor(manifestPath) {
  const flags = parseFlags(process.argv.slice(3));
  assertKnownFlags(flags, DOCTOR_FLAGS, "brain doctor");
  const repairRequested = flags.repair === true;
  const rollbackRequested = flags.rollback === true;
  const repairChecksumRequested = flags["repair-checksum"] === true;
  if ([repairRequested, rollbackRequested, repairChecksumRequested].filter(Boolean).length > 1) {
    die("choose only one of --repair, --rollback, or --repair-checksum");
  }
  if (repairChecksumRequested) {
    if (!manifestPath || manifestPath.startsWith("--") || !existsSync(manifestPath)) {
      die("usage: brain doctor <manifest> --repair-checksum [--yes]");
    }
    return withCloudflareToken(
      () => cmdRepairChecksum(manifestPath, { confirmed: flags.yes === true }),
      { accountId: manifestAccountId(manifestPath) },
    );
  }
  if (repairRequested || rollbackRequested) {
    if (!manifestPath || manifestPath.startsWith("--") || !existsSync(manifestPath)) {
      die("usage: brain doctor <manifest> --repair [--yes]\n      or: brain doctor <manifest> --rollback [--yes]");
    }
    return withCloudflareToken(
      () => cmdDoctorRepair(manifestPath, { action: rollbackRequested ? "rollback" : "repair", confirmed: flags.yes === true }),
      { accountId: manifestAccountId(manifestPath) },
    );
  }
  return cmdDoctor(manifestPath);
}

/* ------------------------------------------------- brain import bank ----- */

/**
 * `brain import bank <manifest> --file <export>` — the operator's way in.
 *
 * WHY A COMMAND OF ITS OWN, AND NOT A FILE EXTENSION
 *
 * `.ofx` and `.qfx` are registered as document formats, which means a bank
 * export dropped into a watched folder is read for its PROSE. That is the right
 * behaviour for a corpus and it is not an import: the figures went nowhere, and
 * until this command existed there was no route by which they could.
 *
 * `.csv` is deliberately NOT registered as a bank export and must not be. Most
 * CSVs are not bank exports, and a registry that guessed would start pulling
 * price lists and mailing lists into a financial ledger. So the operator SAYS
 * so, by naming this command, and the ordinary spreadsheet path is untouched
 * for every other .csv in the folder.
 *
 * WHY IT PARSES HERE AND WRITES THERE
 *
 * The reading — including every refusal — happens on the machine holding the
 * file, so the person who can act on "your CSV has no column that says which
 * way money moved" is the person who sees it. What crosses the wire is figures
 * with an explicit direction, which the brain's own route rechecks for internal
 * consistency before handing them to `importBankExport`, the single ledger
 * write boundary the hosted feed already uses. There is no second writer.
 */
export async function cmdImportBank(m, manifestPath, flags = {}, options = {}) {
  const filePath = flags.file;
  const usage =
    "usage: brain import bank <manifest> --file <statement.ofx|.qfx|.csv>\n" +
    "  Optional: --dry-run to see what WOULD land and send nothing,\n" +
    "            --format ofx|qfx|csv when the file's extension does not say,\n" +
    "            --entity <slug> to file it under a business other than \"primary\",\n" +
    "            --account <slug> --institution <name> --account-kind <checking|savings|card|...>\n" +
    "            --currency <ISO code> for a CSV, which carries none of that itself";
  if (!filePath || filePath === true) die(`brain import bank needs --file <path>.\n      ${usage}`);
  if (!existsSync(filePath)) die(`no such file: ${filePath}`);

  const extension = String(filePath).slice(String(filePath).lastIndexOf(".")).toLowerCase();
  const declared = flags.format === true ? null : (flags.format ? String(flags.format).toLowerCase() : null);
  if (declared && !["ofx", "qfx", "csv"].includes(declared)) {
    die(`--format takes ofx, qfx or csv, not "${String(flags.format).slice(0, 24)}"`);
  }
  const format = declared || ({ ".ofx": "ofx", ".qfx": "qfx", ".csv": "csv", ".tsv": "csv" })[extension] || null;
  if (!format) {
    die(
      `"${basename(filePath)}" does not end in .ofx, .qfx or .csv, so what it is cannot be read from its name.\n` +
      "      Say what it is with --format ofx|qfx|csv, or re-export it with the right extension."
    );
  }

  // A CSV says nothing about which account it belongs to, so the owner does. An
  // account kind nobody stated stays `other`, which the ledger records as
  // holding neither an asset nor a liability — an account is never counted as
  // cash on the strength of a default.
  const accountKind = flags["account-kind"] === true ? null : (flags["account-kind"] || null);
  if (accountKind && !LEDGER_ACCOUNT_KINDS.has(accountKind)) {
    die(`--account-kind takes one of: ${[...LEDGER_ACCOUNT_KINDS].join(", ")}`);
  }
  const accountSlug = flags.account === true ? null : (flags.account || null);
  if (accountSlug && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountSlug)) {
    die("--account takes a short lowercase name: letters, digits, - and _, up to 64 characters");
  }
  const currency = flags.currency === true ? null : (flags.currency ? String(flags.currency).toUpperCase() : null);
  if (currency && !/^[A-Z]{3}$/.test(currency)) die("--currency takes a three-letter code such as USD");
  if (format !== "csv" && (accountSlug || accountKind || flags.institution)) {
    warn("an OFX or QFX file names its own account, so --account, --institution and --account-kind are ignored for it");
  }

  const { readBankExport, formatMinor } = await import("./ingest/bank-export.mjs");
  const envelope = readBankExport(readFileSync(filePath), {
    name: basename(filePath),
    format,
    currency: currency || "USD",
    accountHint: format === "csv" && (accountSlug || accountKind || flags.institution)
      ? {
        accountKey: accountSlug,
        institution: flags.institution === true ? null : (flags.institution || null),
        accountKind: accountKind || "other",
      }
      : null,
  });

  // The refusal is the product here, not an error page. It names what could not
  // be established and what to re-export, and nothing is sent.
  if (!envelope.ok) {
    die(
      `this file was not imported, because ${envelope.refusal}\n\n` +
      `      Nothing was sent and nothing in the ledger changed.`
    );
  }

  const dry = !!flags["dry-run"];
  info(`read ${basename(filePath)}: ${envelope.format.toUpperCase()} bank export`);
  info(`sign convention: ${envelope.signConvention}`);
  let totalReadable = 0;
  let totalUnread = 0;
  for (const account of envelope.accounts) {
    const readable = account.transactions.filter((txn) => !txn.unparsedReason);
    const unread = account.transactions.length - readable.length;
    totalReadable += readable.length;
    totalUnread += unread;
    const sum = (direction) => readable
      .filter((txn) => txn.direction === direction)
      .reduce((total, txn) => total + txn.amountMinor, 0);
    const inflows = readable.filter((txn) => txn.direction === "inflow").length;
    const outflows = readable.length - inflows;
    const named = [
      account.accountKind,
      account.mask ? `ending ${account.mask}` : null,
      account.currency,
    ].filter(Boolean).join(", ");
    console.log(`      ${account.accountKey}  (${named})`);
    if (account.periodStart && account.periodEnd) {
      console.log(`        period ${account.periodStart} to ${account.periodEnd}`);
    }
    console.log(
      `        ${readable.length} line(s) ${dry ? "would land" : "landed"}: ` +
      `${inflows} in ${formatMinor(sum("inflow"), account.currency)}, ` +
      `${outflows} out ${formatMinor(sum("outflow"), account.currency)}`,
    );
    // Said whether it is zero or not, because "0 unread" is information and a
    // silent absence is not.
    console.log(
      unread
        ? `        ${unread} line(s) could not be read and ${dry ? "would land" : "landed"} as unread, each with its reason`
        : `        0 line(s) could not be read`,
    );
    if (account.ledgerBalanceMinor !== null && account.balanceAsOf) {
      console.log(`        statement balance ${formatMinor(account.ledgerBalanceMinor, account.currency)} as of ${account.balanceAsOf}`);
    }
    // NEVER a bare "ok". A direction taken on trust and a direction checked
    // against a balance must not read the same way.
    if (account.directionBasis === "verified") {
      console.log(`        direction: VERIFIED against this statement's own balances`);
    } else if (account.directionBasis === "stated") {
      console.log(`        direction: stated by the file itself, row by row`);
    } else {
      console.log(`        direction: taken ON TRUST from the ${envelope.format.toUpperCase()} specification, not verified`);
      if (account.directionNote) console.log(`                   ${account.directionNote}`);
    }
  }

  if (dry) {
    console.log("");
    ok("dry run, nothing was sent");
    return {
      dry_run: true,
      format: envelope.format,
      accounts: envelope.accounts.length,
      would_import: totalReadable,
      unread_lines: totalUnread,
    };
  }

  const resolveKey = options.resolveAdminKey ?? resolveAdminKey;
  const resolveBase = options.resolveBaseUrl ?? resolveBaseUrl;
  const adminKey = resolveKey(manifestPath);
  if (!adminKey) {
    die(
      "no durable admin key was found. Re-run `brain setup <manifest>` to generate and persist one; " +
        "do not paste the key into a shell command."
    );
  }
  const base = await resolveBase(m, m.brain?.domain ? null : await (options.resolveAccount ?? resolveAccount)(m));
  const { BANK_IMPORT_PATH } = await import("./worker/src/lib/fin-upload.js");
  const res = await http(`${base}${BANK_IMPORT_PATH}`, {
    method: "POST",
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      envelope,
      entity_slug: flags.entity === true ? undefined : flags.entity,
      entity_label: flags["entity-label"] === true ? undefined : flags["entity-label"],
    }),
  }, { fetchImpl: options.fetchImpl ?? fetch, what: "the bank import" });

  let receipt = null;
  try {
    receipt = await res.json();
  } catch {
    die(`the brain answered the import with something that was not JSON (HTTP ${res.status}). Nothing is known to have landed.`);
  }
  if (!res.ok || receipt?.imported !== true) {
    die(
      `the brain refused this import (HTTP ${res.status}): ${receipt?.reason || receipt?.error || "no reason given"}\n` +
      "      Nothing in the ledger changed."
    );
  }

  console.log("");
  ok(`imported into the ledger under entity "${receipt.entity_slug}"`);
  info(
    `${receipt.accounts} account(s) · ${receipt.transactions} transaction(s) · ` +
    `${receipt.unread_lines} unread line(s) · ${receipt.statements} statement(s) · ` +
    `${receipt.balance_snapshots} balance snapshot(s)`
  );
  // The identity property, said out loud, because the alternative is an
  // operator who is afraid to re-run a command that is safe to re-run.
  info("importing this same file again updates those rows in place; it does not add a second copy");
  info(`the searchable copy of this file is a separate job: brain ingest ${manifestPath} --path <folder>`);
  return receipt;
}

/** The account kinds migration 0015 accepts. Kept beside the flag that sets one. */
const LEDGER_ACCOUNT_KINDS = new Set([
  "checking", "savings", "card", "loan", "line_of_credit", "investment",
  "retirement", "merchant", "point_of_sale", "escrow", "other",
]);

async function cmdImport(target) {
  const which = String(target || "").toLowerCase();
  if (which !== "bank") {
    die(
      "brain import supports bank.\n" +
      "  Usage: brain import bank <manifest> --file <statement.ofx|.qfx|.csv> [--dry-run]"
    );
  }
  const manifestPath = process.argv[4];
  if (!manifestPath || manifestPath.startsWith("--")) {
    die("usage: brain import bank <manifest> --file <statement.ofx|.qfx|.csv> [--dry-run]");
  }
  const { m } = loadManifest(manifestPath);
  return cmdImportBank(m, manifestPath, parseFlags(process.argv.slice(4)));
}

const commands = {
  setup: cmdSetupInteractive,
  ask: cmdAsk,
  doctor: dispatchDoctor,
  whatsnew: cmdWhatsnew,
  verify: cmdVerify,
  provision: cmdProvision,
  deploy: cmdDeploy,
  secrets: cmdSecrets,
  health: cmdHealth,
  test: cmdTest,
  "mcp-config": cmdMcpConfig,
  migrate: cmdMigrate,
  ingest: cmdIngest,
  import: cmdImport,
  load: cmdLoad,
  connect: cmdConnect,
  disconnect: cmdDisconnect,
  status: cmdStatus,
  sources: cmdSources,
  forget: cmdForget,
  drain: cmdDrain,
  reindex: cmdReindex,
  diagnose: cmdDiagnose,
  eval: cmdEval,
  grant: cmdGrant,
  grants: cmdGrants,
  zone: cmdZone,
  invite: cmdInvite,
  devices: cmdDevices,
  token: cmdToken,
  update: cmdUpdate,
  upgrade: cmdUpgradeInteractive,
  rollback: dispatchRollback,
  schedule: cmdSchedule,
  support: cmdSupport,
  tools: cmdLocalTools,
  technician: cmdTechnicianInteractive,
};

if (IS_MAIN && (!cmd || !commands[cmd])) {
  console.log(`${c.bold("brain")} — provision and manage a client-owned brain install

  install
    brain setup      [manifest]            nothing to a working brain, one command
    brain setup      [manifest] --no-connect  same, without touching THIS computer's AI tool config
    brain ask        <manifest>            ask a private question in this terminal
    brain doctor     [manifest]            check this machine has everything it needs
    brain tools                            verify Claude Code sign-in and Wrangler 4 locally
    brain verify     <manifest>            check the token and resolve the account
    brain provision  <manifest>            create D1 (and R2), write IDs back
    brain secrets    <manifest>            set secrets and durably rotate ADMIN_KEY
    brain migrate    <manifest>            apply pending schema migrations
    brain deploy     <manifest>            upload the worker with its bindings
    brain health     <manifest>            prove the install actually works
    brain drain      <manifest>            finish the vector embedding now, with a live ETA
    brain reindex    <manifest>            rebuild the vector index from D1, no source files needed
    brain diagnose   <manifest>            what is missing, stored wrong, or stored wastefully
    brain eval       <manifest>            score YOUR questions; add --corpus-contract for source coverage
    brain eval       <manifest> --golden-20  build the 20-question set in a guided session, then score it
    brain token      <manifest>            is a Cloudflare token remembered on this Mac? --forget removes it
    brain technician <manifest>            read-only account setup plan; --run <step> launches one safe ceremony
    brain grant      <manifest> --name "X" --can ask,file   give one person scoped access; prints the token once
    brain grants     <manifest>            who has access; --revoke <id> ends one
    brain zone       <manifest>            what is in which zone; --source X --zone Y to set one
    brain invite     <manifest>            one-tap passkey enrollment link for the owner (Face ID, 15 min)
    brain devices    <manifest>            enrolled passkeys; --revoke <credential id> removes one
    brain test       <manifest>            full acceptance suite (5 tiers)
    brain connect google --scopes drive,gmail,calendar  authorise the client's own Google account
    brain connect imessage <manifest>      verify Full Disk Access, load history, capture live (Mac only)
    brain connect whatsapp <manifest> --accept-risk  pair a linked device and capture live (Mac only, opt-in)
    brain connect zoom     <manifest>      Zoom cloud-recording transcripts (needs a paid Zoom seat)
    brain connect imap     <manifest>      any IMAP mailbox (Yahoo, Fastmail, iCloud, a host): app
                                           password entered hidden, proven by a real read first
    brain load       <manifest>            load EVERYTHING this manifest has: one sweep of every
                                           enabled, connected source, one report at the end
    brain ingest     <manifest> --path <dir>  load a folder into the brain
    brain ingest     <manifest> --from drive  load from a connected remote source
    brain ingest     <manifest> --from calendar  sync Google Calendar (--dry-run to preview)
    brain ingest     <manifest> --from imap  sync a connected IMAP mailbox (--dry-run to preview)
    brain ingest     <manifest> --from imessage  one incremental Messages capture pass (Mac only)
    brain ingest     <manifest> --from whatsapp  one drain of the WhatsApp capture outbox
    brain ingest     <manifest> --from iphone-backup  one-time message history from an unencrypted
                                           local iPhone backup; a snapshot, not live capture (any OS)
    brain import bank <manifest> --file <statement.ofx|.qfx|.csv>  a bank export the owner
                                           downloaded, into the structured ledger (--dry-run previews)
    brain mcp-config <manifest>            config to connect the client's AI tools
    brain schedule   <manifest> --install  install unattended Drive refresh on macOS
    brain schedule   <manifest> --install --folder  install unattended refresh of the watched
                                           local folder declared in corpora.local_folder (macOS)
    brain support    [--preview|--export <file>]  inspect private local issue notes
    brain support    --explain <issue-code>       plain-language recovery for a typed issue

  operate
    brain update     [manifest]            one safe update: snapshot, test, verify
    brain whatsnew   [manifest]            what changed in this version, and are you on it
    brain status     <manifest>            versions, pending migrations, upgrade history
    brain sources    <manifest>            named ingest sources, counts, last ingest
    brain forget     <manifest>            remove one named source (destructive)
    brain upgrade    <manifest>            snapshot, migrate, deploy, verify
    brain doctor     <manifest> --repair   diagnose a brain stuck mid-upgrade (--yes to resume)
    brain doctor     <manifest> --rollback preview restore to the pre-migration bookmark (--yes performs it)
    brain doctor     <manifest> --repair-checksum  reconcile an applied migration whose file changed (--yes to apply)
    brain rollback   <manifest> <bookmark> preview D1-only restore (--yes performs it)
    brain schedule   <manifest>            inspect unattended Drive refresh
    brain schedule   <manifest> --remove   remove it and preserve its logs
    brain schedule   <manifest> --folder   inspect (or --install/--remove) the watched folder lane
    brain disconnect imessage <manifest>   stop live capture, flush open sessions, remove the agent
    brain disconnect whatsapp <manifest>   stop the capture daemon and its drain, flush, remove both agents
    brain disconnect zoom     <manifest>   remove the Zoom secrets so the webhook refuses deliveries
    brain disconnect imap     <manifest>   remove the stored mailbox app password from this machine
    brain support    --clear --yes         clear private local issue notes

  brain ingest takes --source <name>, --limit <n>, --dry-run, and --reset. It is
  resumable: re-run the same command to continue an interrupted load. A large
  Drive cleanup stops first and prints the exact --approve-removals fingerprint.

  brain load is install day in one command. It reads the manifest, runs every
  source that is both enabled AND connected, and skips the rest with a stated
  reason. One source failing never stops the others: failures are collected and
  reported at the end with what to do about each. It keeps NO cursor of its own,
  so re-running it resumes each source through that source's own state, and it
  refuses --reset for the same reason. Takes --dry-run (reads every source and
  sends nothing, so a client can see the scope first), --only <a,b> and
  --skip <a,b> to rerun one source after fixing it, and --limit <n>, which marks
  everything it touches as an incomplete load. Zoom is always skipped: it pushes
  new transcripts to the brain's webhook, so there is nothing for a sweep to pull.

  brain import bank reads the file on THIS machine and sends figures, never the
  file and never a full account number. A .csv is only a bank export when you say
  so with this command; every other .csv stays an ordinary document. It refuses a
  file whose direction of money cannot be established, naming the column or the
  balance that would have settled it, and it says per account whether the
  direction was verified against a balance or taken on trust from the format.
  Re-importing the same file updates the same rows rather than adding a copy.

  brain sources takes --add <name> [--kind <drive|gmail|imap|calendar|upload>] to register one,
  and --source <name> --refresh <hourly|daily|weekly|monthly|never> to say how often it
  should refresh. A source with no expectation is never reported as stale.
  brain forget needs --source <name>, and --yes before it removes anything. Without
  --yes it prints exactly what would go and stops.

  Provisioning and deployment require CLOUDFLARE_API_TOKEN. Routine source
  refresh and health commands use the brain's domain and admin key instead.
`);
  process.exit(cmd ? 1 : 0);
}

if (IS_MAIN) {
  // A throw that escapes the command promise entirely, from a stray listener or
  // a background task, would otherwise print a raw stack trace and exit 1 with
  // no explanation. These two make that impossible.
  process.on("unhandledRejection", (e) => crash(e));
  process.on("uncaughtException", (e) => crash(e));

  commands[cmd](manifestPath).catch((e) => {
    // Fatal is a failure this code ANTICIPATED and already explained: a missing
    // token, a free-tier account, a typo'd source name. A Drive removal review
    // is an intentional safety stop with the same no-crash treatment and a
    // clearer label. Anything else is a bug, and crash() says so.
    const reviewRequired = e instanceof DriveRemovalReviewRequired;
    if (e instanceof Fatal || reviewRequired) {
      // stdout, not stderr. This message is anticipated, already formatted, and
      // addressed to the user; the exit code is the machine-readable part.
      // PowerShell wraps anything on stderr in a NativeCommandError block, which
      // makes a clear explanation look like the tool itself fell over.
      const supportEventId = recordSupportFailure(e);
      const label = reviewRequired ? c.yellow("review required") : c.red("fail");
      console.log(`${label}  ${e.message}`);
      printSupportReceipt(supportEventId, (line) => console.log(line));
      process.exit(1);
    }
    crash(e);
  });
}
