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
import { looksDisposable, protectedListMissing, teardownDecision } from "../scripts/teardown-test-brain.mjs";

// Disposable, by an anchored prefix only.
for (const name of ["brain-test-run-1", "brain-test-jay-ui", "test-scratch", "TEST-UPPER", "brain-test"]) {
  assert.equal(looksDisposable(name), true, `${name} should be deletable`);
}

// The regression: "test" in the middle of a word is not a test resource.
for (const name of [
  "my-production-testbed",
  "latest-greatest",             // "latest" contains test
  "brain-latest",                // and so does the name of a safety copy
  "james-latest-backup",         // the backup made before a risky operation
  "protest-archive",
  "fastest-brain",
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

// A decision must carry its evidence. "would delete" looked the same whether
// one guard passed or three did, which is how a thin guard passes for a strong
// one; the same shape as a database error that said only "could not verify".
{
  const prefixes = [/^lvc-brain/i, /^james-brain-shadow/i];
  const opts = { protectedPrefixes: prefixes, protectedRaw: "lvc-brain,james-brain-shadow" };

  const allowed = teardownDecision("brain-test-run-1", opts);
  assert.equal(allowed.allowed, true);
  assert.match(allowed.reason, /disposable prefix/, "an allow says which rule let it through");
  assert.match(allowed.reason, /protected list of 2/, "an allow says how many names it was checked against");

  const onList = teardownDecision("lvc-brain", opts);
  assert.equal(onList.allowed, false);
  assert.match(onList.reason, /protected list \(\^lvc-brain\)/, "a refusal names the pattern that stopped it");

  const wrongShape = teardownDecision("latest-greatest", opts);
  assert.equal(wrongShape.allowed, false);
  assert.match(wrongShape.reason, /does not start with/, "a refusal names the rule, not just the verdict");

  const noLock = teardownDecision("brain-test-run-1", { protectedPrefixes: [], protectedRaw: "" });
  assert.equal(noLock.allowed, false);
  assert.match(noLock.reason, /BRAIN_TEARDOWN_PROTECTED/, "the missing lock is named so it can be set");

  assert.equal(teardownDecision("", opts).allowed, false, "no name is not a decision to delete");
  for (const d of [allowed, onList, wrongShape, noLock]) {
    assert.ok(d.reason && d.reason.length > 10, "every decision carries a readable reason");
  }
}

console.log("teardown guards: only an anchored test prefix is deletable, the live-name lock must be set, and every decision says which rule decided it");
