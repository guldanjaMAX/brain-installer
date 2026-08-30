/**
 * Windows-only packed release gate for the exact shared DPAPI session.
 *
 * One private compiled helper serves 25 protect/unprotect probe rounds, an
 * admin-key create/read/rotate/read transaction, and a synthetic Google token
 * save/load. The gate disposes that helper exactly once and prints only stable
 * counts and stage codes, never a credential or child-process output.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeWindowsDpapi,
  readAdminKeyFile,
  writeAdminKeyFile,
} from "../operations/admin-key-file.mjs";
import {
  disposeWindowsDpapiSession,
  readWindowsDpapiSessionMetrics,
} from "../operations/windows-dpapi-session.mjs";
import { loadTokens, saveTokens } from "../connectors/google-auth.mjs";

const REQUIRED_ROUNDS = 25;
const REQUIRED_HELPER_INVOCATIONS = (REQUIRED_ROUNDS * 2) + 11 + 4;

if (process.platform !== "win32") {
  console.error("windows-dpapi-release-gate result=fail issue_code=WINDOWS_REQUIRED stage=platform rounds_completed=0");
  process.exit(1);
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-packed-dpapi-")));
const adminPath = join(sandbox, ".brain-admin-key");
const googlePath = join(sandbox, ".brain", "google-tokens.json");
const first = `packed-create-${randomBytes(32).toString("hex")}`;
const replacement = `packed-rotate-${randomBytes(32).toString("hex")}`;
const googleRecord = Object.freeze({
  client_id: `packed-client-${randomBytes(24).toString("hex")}`,
  client_secret: `packed-secret-${randomBytes(24).toString("hex")}`,
  refresh_token: `packed-refresh-${randomBytes(24).toString("hex")}`,
  access_token: `packed-access-${randomBytes(24).toString("hex")}`,
});
const username = process.env.USERNAME || process.env.USER;
let stage = "probe";
let roundsCompleted = 0;
let cleanup = { status: "cleanup_deferred" };
let cleanupAttempted = false;

function containsUnsafePayload(bytes, values) {
  return values.some((value) =>
    bytes.includes(Buffer.from(value)) ||
    bytes.includes(Buffer.from(value).toString("base64"))
  );
}

function cleanupSharedSessionOnce() {
  if (cleanupAttempted) return cleanup;
  cleanupAttempted = true;
  cleanup = disposeWindowsDpapiSession();
  return cleanup;
}

try {
  const result = probeWindowsDpapi({ rounds: REQUIRED_ROUNDS, retainSession: true });
  roundsCompleted = Number(result.rounds || 0);
  if (result.checked !== true || result.passed !== true ||
      result.rounds !== REQUIRED_ROUNDS || result.cleanup_status !== "retained" ||
      result.compile_count !== 1 || result.helper_invocations !== REQUIRED_ROUNDS * 2) {
    throw new Error("probe contract failed");
  }

  stage = "admin_key";
  const adminOptions = { username };
  writeAdminKeyFile(adminPath, first, adminOptions);
  if (containsUnsafePayload(readFileSync(adminPath), [first]) ||
      readAdminKeyFile(adminPath, adminOptions) !== first) {
    throw new Error("admin create/read failed");
  }
  writeAdminKeyFile(adminPath, replacement, adminOptions);
  if (containsUnsafePayload(readFileSync(adminPath), [first, replacement]) ||
      readAdminKeyFile(adminPath, adminOptions) !== replacement) {
    throw new Error("admin rotate/read failed");
  }

  stage = "google_storage";
  const googleOptions = {
    backend: "file",
    platform: "win32",
    path: googlePath,
    username,
  };
  saveTokens(googleRecord, googleOptions);
  const loadedGoogle = loadTokens(googleOptions);
  if (containsUnsafePayload(readFileSync(googlePath), Object.values(googleRecord)) ||
      Object.entries(googleRecord).some(([key, value]) => loadedGoogle?.[key] !== value) ||
      Object.keys(loadedGoogle || {}).length !== Object.keys(googleRecord).length) {
    throw new Error("Google save/load failed");
  }

  stage = "metrics";
  const metrics = readWindowsDpapiSessionMetrics();
  if (metrics.compile_count !== 1 || metrics.helper_invocations !== REQUIRED_HELPER_INVOCATIONS) {
    throw new Error("shared-session metrics failed");
  }
  cleanup = cleanupSharedSessionOnce();
  if (cleanup.status !== "clean") throw new Error("cleanup failed");

  console.log(
    `windows-dpapi-release-gate result=pass cleanup_status=clean rounds_completed=${REQUIRED_ROUNDS} ` +
    `compile_count=1 helper_invocations=${REQUIRED_HELPER_INVOCATIONS} ` +
    "admin_key_create_read_rotate=pass google_storage_save_load=pass ciphertext_scan=pass",
  );
} catch {
  cleanupSharedSessionOnce();
  const safeStage = /^[a-z_]+$/.test(stage) ? stage : "unknown";
  console.error(
    `windows-dpapi-release-gate result=fail issue_code=WINDOWS_DPAPI_PACKED_GATE ` +
    `stage=${safeStage} rounds_completed=${roundsCompleted} cleanup_status=${cleanup.status === "clean" ? "clean" : "cleanup_deferred"}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
