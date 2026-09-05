-- Short-lived owner bank-import previews and their single-use commit claims.
--
-- Raw OFX, QFX, and CSV bytes never enter D1. A preview keeps only an opaque
-- identifier plus a SHA-256 binding over the exact bytes, entity, file
-- declaration, and account mapping. The separate commit row makes one preview
-- single-use under D1's transaction boundary, while owner_action_requests
-- remains the durable response-loss replay receipt.

CREATE TABLE IF NOT EXISTS owner_bank_import_previews (
  preview_id       TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL DEFAULT 'primary',
  preview_hash     TEXT NOT NULL,
  content_sha256   TEXT NOT NULL,
  content_bytes    INTEGER NOT NULL,
  entity_slug      TEXT NOT NULL,
  source_doc_uid   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  CHECK (preview_id GLOB 'bank_preview_[A-Za-z0-9_-]*' AND preview_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(preview_id) BETWEEN 14 AND 180),
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (length(preview_hash) = 64 AND preview_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (content_bytes BETWEEN 1 AND 8388608),
  CHECK (entity_slug GLOB '[a-z0-9]*' AND entity_slug NOT GLOB '*[^a-z0-9_-]*' AND length(entity_slug) BETWEEN 1 AND 64),
  CHECK (length(source_doc_uid) BETWEEN 1 AND 180),
  CHECK (created_at < expires_at)
);

CREATE INDEX IF NOT EXISTS idx_owner_bank_import_previews_expiry
  ON owner_bank_import_previews (tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS owner_bank_import_commits (
  tenant_id    TEXT NOT NULL DEFAULT 'primary',
  preview_id   TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, preview_id),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (preview_id) REFERENCES owner_bank_import_previews(preview_id),
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128)
);
