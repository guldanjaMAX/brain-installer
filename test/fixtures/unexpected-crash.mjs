/*
 * Force one real public CLI command through brain.mjs's unexpected-error path.
 * Restore console output before throwing so the guarded crash handler can
 * explain the failure and print its local support receipt.
 */

const originalLog = console.log.bind(console);
let triggered = false;

console.log = (...args) => {
  if (!triggered) {
    triggered = true;
    console.log = originalLog;
    const error = new Error("RAW_UNEXPECTED_CRASH_SENTINEL private diagnostic text");
    if (process.env.BRAIN_TEST_UNCERTAIN_CRASH === "1") {
      error.code = "REFRESH_OUTCOME_UNKNOWN";
      error.retry_safe = false;
      error.outcome_unknown = true;
    }
    throw error;
  }
  return originalLog(...args);
};
