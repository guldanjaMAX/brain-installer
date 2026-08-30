/**
 * The session-signing secret behind passkey sign-ins.
 *
 * The Worker signs owner session cookies (worker/src/lib/sessions.mjs) with
 * SESSION_SIGNING_KEY. Derived from ADMIN_KEY exactly like RAG_PROXY_KEY and
 * for the same reason: every existing install gets a working secret on its
 * next `brain secrets` run, with no new prompt, file, or migration, and HKDF
 * is one-way so a leaked signing key never yields the admin key.
 *
 * Shared consequence, stated where the next person will look: rotating
 * ADMIN_KEY rotates this too, which signs every owner out everywhere. That is
 * the correct behavior for a key rotation, so unlike the proxy key this one
 * has no independent-rotation debt.
 */
import { hkdfSync } from "node:crypto";

/** Bumping this signs every owner out everywhere. Treat it as a version pin. */
export const SESSION_SIGNING_KEY_INFO = "brain-session-signing-key-v1";

const SESSION_SIGNING_KEY_SALT = "brain-durable-key-derivation-v1";
const SESSION_SIGNING_KEY_BYTES = 32;

export function deriveSessionSigningKey(adminKey) {
  if (typeof adminKey !== "string" || !adminKey.length) {
    throw new TypeError("a verified admin key string is required to derive the session signing key");
  }
  const derived = hkdfSync(
    "sha256",
    adminKey,
    SESSION_SIGNING_KEY_SALT,
    SESSION_SIGNING_KEY_INFO,
    SESSION_SIGNING_KEY_BYTES,
  );
  return Buffer.from(derived).toString("hex");
}
