/**
 * Windows-only release gate for the exact production DPAPI path.
 *
 * The production probe creates fresh random bytes for every round, compiles one
 * private process-scoped helper, exercises the shipped protect/unprotect bridge,
 * compares exact readback, wipes every buffer, and requires clean helper
 * disposal. This wrapper prints only stable diagnostic fields. It never handles
 * or emits a credential.
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

const REQUIRED_ROUNDS = 25;

if (process.platform !== "win32") {
  console.error("windows-dpapi-release-gate result=fail issue_code=WINDOWS_REQUIRED rounds_completed=0");
  process.exit(1);
}

const result = probeWindowsDpapi({ rounds: REQUIRED_ROUNDS });
const stage = /^[a-z_]+$/.test(String(result.stage || "")) ? result.stage : "none";
const issueCode = /^WINDOWS_DPAPI_[A-Z_]+$/.test(String(result.issue_code || ""))
  ? result.issue_code
  : "WINDOWS_DPAPI_UNKNOWN";
const passed = result.checked === true && result.passed === true &&
  result.rounds === REQUIRED_ROUNDS && result.cleanup_status === "clean" &&
  result.compile_count === 1 && result.helper_invocations === REQUIRED_ROUNDS * 2;

if (!passed) {
  console.error(
    `windows-dpapi-release-gate result=fail issue_code=${issueCode} stage=${stage} rounds_completed=${Number(result.rounds || 0)}`,
  );
  process.exit(1);
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-packed-dpapi-")));
const destination = join(sandbox, ".brain-admin-key");
const first = `packed-create-${randomBytes(32).toString("hex")}`;
const replacement = `packed-rotate-${randomBytes(32).toString("hex")}`;
const username = process.env.USERNAME || process.env.USER;
let adminCleanup = { status: "cleanup_deferred" };
try {
  const options = { username };
  writeAdminKeyFile(destination, first, options);
  const firstStored = readFileSync(destination);
  if (firstStored.includes(Buffer.from(first)) ||
      firstStored.includes(Buffer.from(first).toString("base64"))) {
    throw new Error("packed admin-key create stored an unsafe payload");
  }
  if (readAdminKeyFile(destination, options) !== first) {
    throw new Error("packed admin-key create did not read back exactly");
  }
  writeAdminKeyFile(destination, replacement, options);
  const replacementStored = readFileSync(destination);
  if (replacementStored.includes(Buffer.from(first)) || replacementStored.includes(Buffer.from(replacement)) ||
      replacementStored.includes(Buffer.from(first).toString("base64")) ||
      replacementStored.includes(Buffer.from(replacement).toString("base64"))) {
    throw new Error("packed admin-key rotation stored an unsafe payload");
  }
  if (readAdminKeyFile(destination, options) !== replacement) {
    throw new Error("packed admin-key rotation did not read back exactly");
  }
  adminCleanup = disposeWindowsDpapiSession();
  if (adminCleanup.status !== "clean") throw new Error("packed admin-key helper cleanup was deferred");
} catch {
  console.error("windows-dpapi-release-gate result=fail issue_code=WINDOWS_DPAPI_PACKED_ADMIN_KEY stage=admin_key rounds_completed=25");
  process.exitCode = 1;
} finally {
  if (adminCleanup.status !== "clean") disposeWindowsDpapiSession();
  rmSync(sandbox, { recursive: true, force: true });
}

if (!process.exitCode) {
  const finalMetrics = readWindowsDpapiSessionMetrics();
  console.log(
    `windows-dpapi-release-gate result=pass cleanup_status=clean rounds_completed=${REQUIRED_ROUNDS} ` +
    `compile_count=${result.compile_count} helper_invocations=${result.helper_invocations} ` +
    `admin_key_create_read_rotate=pass ciphertext_scan=pass total_compile_count=${finalMetrics.compile_count}`,
  );
}
