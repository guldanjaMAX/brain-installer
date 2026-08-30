/**
 * One public, non-customer document used to prove a first installation.
 *
 * These values are shared by the installer, ingestion boundary, receipt, and
 * freshness proof. Keeping one contract prevents a locally valid fixture from
 * drifting away from what the deployed Worker actually accepts and verifies.
 */
export const PUBLIC_INSTALL_SMOKE_SOURCE = "install-smoke";
export const PUBLIC_INSTALL_SMOKE_ID = "public-first-install-v1";
export const PUBLIC_INSTALL_SMOKE_DOC_UID =
  `${PUBLIC_INSTALL_SMOKE_SOURCE}:${PUBLIC_INSTALL_SMOKE_ID}`;
export const PUBLIC_INSTALL_SMOKE_TITLE = "Financial Brain first-install smoke proof";
export const PUBLIC_INSTALL_SMOKE_CONTENT =
  "This public, non-customer document proves that the deployed Financial Brain accepted, stored, and indexed one authenticated installation check.";
export const PUBLIC_INSTALL_SMOKE_METADATA = Object.freeze({
  proof_kind: "public_first_install_smoke",
  contains_customer_data: false,
  schema_version: 1,
});
export const PUBLIC_INSTALL_SMOKE_CHUNK =
  `[${PUBLIC_INSTALL_SMOKE_TITLE}]\n\n${PUBLIC_INSTALL_SMOKE_CONTENT}`;
export const DEFAULT_INGEST_CHUNK_SIZE = 1500;
export const DEFAULT_INGEST_CHUNK_OVERLAP = 300;

const ENVELOPE_KEYS = ["content", "metadata", "source_id", "source_type", "title"];
const METADATA_KEYS = ["contains_customer_data", "proof_kind", "schema_version"];

export function ingestChunkGeometry(env = {}) {
  const rawSize = Number.parseInt(env.CHUNK_SIZE, 10);
  const rawOverlap = Number.parseInt(env.CHUNK_OVERLAP, 10);
  const size = Number.isFinite(rawSize)
    ? Math.min(Math.max(rawSize, 256), 1800)
    : DEFAULT_INGEST_CHUNK_SIZE;
  const overlap = Number.isFinite(rawOverlap)
    ? Math.min(Math.max(rawOverlap, 0), size - 1)
    : DEFAULT_INGEST_CHUNK_OVERLAP;
  return { size, overlap };
}

export async function ingestContentHash(env, content) {
  const geometry = ingestChunkGeometry(env);
  const value = `chunk-v1:${geometry.size}:${geometry.overlap}\0${content}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function publicInstallSmokeContentHash(env) {
  return ingestContentHash(env, PUBLIC_INSTALL_SMOKE_CONTENT);
}

const exactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

export function usesReservedPublicInstallSmokeIdentity(envelope) {
  return envelope?.source_type === PUBLIC_INSTALL_SMOKE_SOURCE ||
    envelope?.source_id === PUBLIC_INSTALL_SMOKE_ID;
}

export function isCanonicalPublicInstallSmokeEnvelope(envelope) {
  return exactKeys(envelope, ENVELOPE_KEYS) &&
    envelope.source_type === PUBLIC_INSTALL_SMOKE_SOURCE &&
    envelope.source_id === PUBLIC_INSTALL_SMOKE_ID &&
    envelope.title === PUBLIC_INSTALL_SMOKE_TITLE &&
    envelope.content === PUBLIC_INSTALL_SMOKE_CONTENT &&
    exactKeys(envelope.metadata, METADATA_KEYS) &&
    envelope.metadata.proof_kind === PUBLIC_INSTALL_SMOKE_METADATA.proof_kind &&
    envelope.metadata.contains_customer_data === PUBLIC_INSTALL_SMOKE_METADATA.contains_customer_data &&
    envelope.metadata.schema_version === PUBLIC_INSTALL_SMOKE_METADATA.schema_version;
}

export function publicInstallSmokeEnvelope() {
  return Object.freeze({
    source_type: PUBLIC_INSTALL_SMOKE_SOURCE,
    source_id: PUBLIC_INSTALL_SMOKE_ID,
    title: PUBLIC_INSTALL_SMOKE_TITLE,
    content: PUBLIC_INSTALL_SMOKE_CONTENT,
    metadata: PUBLIC_INSTALL_SMOKE_METADATA,
  });
}
