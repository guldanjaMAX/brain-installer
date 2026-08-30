/**
 * Local contract for the Worker secret that protects bank access references.
 *
 * This key is random and independent. It is never derived from ADMIN_KEY,
 * SESSION_SIGNING_KEY, a provider client secret, or a recovery passphrase.
 * The version is present in both the Worker secret name and its value so a
 * future rotation cannot silently reinterpret old ciphertext.
 */
import { randomBytes } from "node:crypto";

export const BANK_ACCESS_WRAPPING_KEY_VERSION = 2;
export const BANK_ACCESS_WRAPPING_KEY_SECRET = "BANK_FEED_WRAPPING_KEY_V2";
export const BANK_ACCESS_WRAPPING_KEY_PREFIX = "v2.";

export function validateBankAccessWrappingKey(value) {
  if (typeof value !== "string" ||
      !/^v2\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} must be a version-2 32-byte base64url key`,
    );
  }
  const decoded = Buffer.from(value.slice(BANK_ACCESS_WRAPPING_KEY_PREFIX.length), "base64url");
  if (decoded.length !== 32) {
    throw new TypeError(`${BANK_ACCESS_WRAPPING_KEY_SECRET} must decode to exactly 32 bytes`);
  }
  return value;
}

export function generateBankAccessWrappingKey(randomBytesImpl = randomBytes) {
  const generated = randomBytesImpl(32);
  if (!Buffer.isBuffer(generated) || generated.length !== 32) {
    throw new TypeError("the wrapping-key random source must return exactly 32 bytes");
  }
  return validateBankAccessWrappingKey(
    `${BANK_ACCESS_WRAPPING_KEY_PREFIX}${generated.toString("base64url")}`,
  );
}
