import assert from "node:assert/strict";

import {
  assertDrainComplete,
  validateDrainReceipt,
  validateReindexReceipt,
} from "../brain.mjs";

/* A zero-work receipt is a real, successful drain. */
assert.deepEqual(validateDrainReceipt({ drained: 0, remaining: 0 }), {
  drained: 0,
  remaining: 0,
});
assert.deepEqual(validateDrainReceipt({ drained: 25, remaining: 8 }), {
  drained: 25,
  remaining: 8,
});

/* HTTP 200 without an exact receipt must never become a green exit. */
for (const body of [null, {}, [], { drained: "1", remaining: 0 }, { drained: 1 }, { drained: -1, remaining: 0 }]) {
  assert.throws(() => validateDrainReceipt(body), /valid|receipt/i);
}
assert.throws(
  () => validateDrainReceipt({ drained: 0, remaining: 7 }),
  /stopped making progress.*7 vector operation/s
);

assert.deepEqual(assertDrainComplete({ remaining: 0, rounds: 3 }), {
  remaining: 0,
  rounds: 3,
});
assert.throws(
  () => assertDrainComplete({ remaining: 9, rounds: 400, maxRounds: 400 }),
  /400-round safety limit.*9 vector operation/s
);

/* Preview and confirmation are separate contracts, including source identity. */
const preview = {
  chunks: 12,
  queued: 0,
  already_queued: 3,
  dry_run: true,
  source: null,
};
assert.equal(validateReindexReceipt(preview), preview);

const confirmed = {
  chunks: 12,
  queued: 9,
  already_queued: 3,
  pending: 12,
  dry_run: false,
  source: null,
};
assert.equal(validateReindexReceipt(confirmed, { confirm: true }), confirmed);

for (const body of [
  null,
  {},
  { ...preview, dry_run: false },
  { ...preview, queued: 1 },
  { ...preview, source: "other" },
]) {
  assert.throws(() => validateReindexReceipt(body), /reindex|receipt|source/i);
}

for (const body of [
  { ...confirmed, dry_run: true },
  { ...confirmed, pending: undefined },
  { ...confirmed, pending: 11 },
  { ...confirmed, queued: "9" },
  { ...confirmed, pending: 0, queued: 0, already_queued: 0 },
]) {
  assert.throws(
    () => validateReindexReceipt(body, { confirm: true }),
    /reindex|receipt|counts|pending/i
  );
}

const scoped = { ...confirmed, source: "documents" };
assert.equal(
  validateReindexReceipt(scoped, { confirm: true, source: "documents" }),
  scoped
);

console.log("drain/reindex exit: all focused tests passed");
