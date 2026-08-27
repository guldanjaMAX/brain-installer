/**
 * The read-only retrieval credential.
 *
 * The Worker has always honoured RAG_PROXY_KEY, and only on the two retrieval
 * routes (see validateReadKey in worker/src/lib/core.js). Nothing ever
 * provisioned it. The key existed in the code and in no field install, so a UI
 * proxy had no choice but to carry ADMIN_KEY, and a compromised proxy could
 * ingest, purge, reindex and drain.
 *
 * This derives the key from ADMIN_KEY rather than storing it, deliberately, and
 * only for this step:
 *
 *   - Every existing install gets a working read-only key on its next
 *     `brain secrets` run. No new prompt, no new file, no migration.
 *   - HKDF is one-way, so a leaked proxy key never yields the admin key it came
 *     from. That direction is the one that matters.
 *
 * The cost is that rotating ADMIN_KEY also rotates this key, silently. That is
 * acceptable only while no UI proxy is deployed, and it is exactly why step two
 * exists: an independently rotatable durable slot, so a compromised proxy can be
 * revoked without rotating the admin key that is wired into every MCP config.
 * Until step two lands, do not tell a client this key is separately revocable.
 */
import { hkdfSync } from "node:crypto";

/** Bumping this rotates every derived proxy key. Treat it as a version pin. */
export const RAG_PROXY_KEY_INFO = "brain-rag-proxy-key-v1";

/** Fixed and non-secret. HKDF needs a salt; it does not need a secret one. */
const RAG_PROXY_KEY_SALT = "brain-durable-key-derivation-v1";

/** 24 bytes, matching the admin key's own generated length. */
const RAG_PROXY_KEY_BYTES = 24;

/**
 * Derive the read-only proxy key from a verified admin key.
 *
 * Returns lowercase hex, which is HTTP-header-safe by construction, so it needs
 * no separate header validation the way a pasted key would.
 */
export function deriveRagProxyKey(adminKey) {
  if (typeof adminKey !== "string" || !adminKey.length) {
    throw new TypeError("a verified admin key string is required to derive the proxy key");
  }
  const derived = hkdfSync(
    "sha256",
    adminKey,
    RAG_PROXY_KEY_SALT,
    RAG_PROXY_KEY_INFO,
    RAG_PROXY_KEY_BYTES,
  );
  return Buffer.from(derived).toString("hex");
}
