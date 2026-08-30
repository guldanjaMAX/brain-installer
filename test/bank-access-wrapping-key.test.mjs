import assert from "node:assert/strict";
import test from "node:test";

import {
  BANK_ACCESS_WRAPPING_KEY_PREFIX,
  BANK_ACCESS_WRAPPING_KEY_SECRET,
  BANK_ACCESS_WRAPPING_KEY_VERSION,
  generateBankAccessWrappingKey,
  validateBankAccessWrappingKey,
} from "../operations/bank-access-wrapping-key.mjs";

test("the bank access wrapping key has one explicit versioned contract", () => {
  assert.equal(BANK_ACCESS_WRAPPING_KEY_VERSION, 2);
  assert.equal(BANK_ACCESS_WRAPPING_KEY_SECRET, "BANK_FEED_WRAPPING_KEY_V2");
  assert.equal(BANK_ACCESS_WRAPPING_KEY_PREFIX, "v2.");
  const value = generateBankAccessWrappingKey((length) => Buffer.alloc(length, 17));
  assert.equal(validateBankAccessWrappingKey(value), value);
  assert.match(value, /^v2\.[A-Za-z0-9_-]{43}$/);
});
test("generation requires a full independent 256-bit random value", () => {
  assert.throws(() => generateBankAccessWrappingKey(() => Buffer.alloc(31)), /exactly 32 bytes/);
  assert.throws(() => generateBankAccessWrappingKey(() => "not bytes"), /exactly 32 bytes/);
  assert.throws(() => validateBankAccessWrappingKey("fixture-admin-key"), /version-2/);
  assert.throws(() => validateBankAccessWrappingKey("v1." + "A".repeat(43)), /version-2/);
});
