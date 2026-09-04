/**
 * The teardown script deletes a Worker, a D1 database and a Vectorize index.
 * Its two guards both failed open until 2026-09-03.
 *
 * The name check was /^brain-test|test/i, which alternates across the whole
 * pattern: "starts with brain-test, OR contains test anywhere". That made
 * `my-production-testbed` deletable, and `latest-greatest` too, because
 * "latest" contains t-e-s-t. The second lock read a comma-separated list from
 * the environment and, unset, was an empty array that protected nothing and
 * said nothing. Both were found by reading the script before adopting it.
 */
import assert from "node:assert/strict";
import { looksDisposable, protectedListMissing } from "../scripts/teardown-test-brain.mjs";

// Disposable, by an anchored prefix only.
for (const name of ["brain-test-run-1", "brain-test-jay-ui", "test-scratch", "TEST-UPPER", "brain-test"]) {
  assert.equal(looksDisposable(name), true, `${name} should be deletable`);
}

// The regression: "test" in the middle of a word is not a test resource.
for (const name of [
  "my-production-testbed",       // the peer's example
  "latest-greatest",             // "latest" contains test
  "greatest-hits",
  "contest-results",
  "financial-brain-jay-preview-brain",
  "james-brain-shadow",
  "lvc-brain",
  "brain-attestation",
]) {
  assert.equal(looksDisposable(name), false, `${name} must NOT be deletable by name`);
}

// Nothing, and nothing-shaped, is disposable.
for (const bad of ["", null, undefined, "   ", 0]) {
  assert.equal(looksDisposable(bad), false, `${String(bad)} must not be deletable`);
}

// The second lock must exist before anything is deleted.
assert.equal(protectedListMissing(""), true, "an unset list is missing");
assert.equal(protectedListMissing(undefined), true, "an absent list is missing");
assert.equal(protectedListMissing("  , ,, "), true, "a list of separators is still empty");
assert.equal(protectedListMissing("lvc-brain"), false, "one name is a list");
assert.equal(protectedListMissing("lvc-brain,james-brain-shadow"), false, "several names are a list");

console.log("teardown guards: only an anchored test prefix is deletable, and the live-name lock must be set");
