/**
 * Windows-only release gate for the exact production DPAPI path.
 *
 * The production probe creates fresh random bytes for every round, compiles one
 * private process-scoped helper, exercises the shipped protect/unprotect bridge,
 * compares exact readback, wipes every buffer, and requires clean helper
 * disposal. This wrapper prints only stable diagnostic fields. It never handles
 * or emits a credential.
 */

import { probeWindowsDpapi } from "../operations/admin-key-file.mjs";

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
  result.rounds === REQUIRED_ROUNDS && result.cleanup_status === "clean";

if (!passed) {
  console.error(
    `windows-dpapi-release-gate result=fail issue_code=${issueCode} stage=${stage} rounds_completed=${Number(result.rounds || 0)}`,
  );
  process.exit(1);
}

console.log(`windows-dpapi-release-gate result=pass cleanup_status=clean rounds_completed=${REQUIRED_ROUNDS}`);
