/**
 * Windows-only release gate for the exact production DPAPI path.
 *
 * The production probe creates fresh random bytes for every round, exercises
 * the shipped compile/protect/unprotect/cleanup bridge, compares exact
 * readback, and wipes every buffer. This wrapper prints only stable diagnostic
 * fields. It never handles or emits a credential.
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
const passed = result.checked === true && result.passed === true && result.rounds === REQUIRED_ROUNDS;

if (!passed) {
  console.error(
    `windows-dpapi-release-gate result=fail issue_code=${issueCode} stage=${stage} rounds_completed=${Number(result.rounds || 0)}`,
  );
  process.exit(1);
}

console.log(`windows-dpapi-release-gate result=pass rounds_completed=${REQUIRED_ROUNDS}`);
