-- 0020_document_access_passkey_observability
--
-- A document grant names exact logical documents. It never names a source,
-- folder, connector, tag, or coarse zone. New material therefore remains
-- owner-only until the owner grants its doc_uid explicitly.
--
-- Grants are immutable. Ending access stamps revoked_at on the grant and its
-- document rows; neither is deleted, so the historical decision remains
-- auditable. Giving somebody another document means creating a new grant,
-- which prevents a retry or edit from silently widening an existing scope.

CREATE TABLE IF NOT EXISTS document_access_grants (
  grant_id TEXT PRIMARY KEY,
  subject_label TEXT NOT NULL,
  entity_slug TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by = 'owner'),
  revoked_at INTEGER,
  create_request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_access_documents (
  grant_id TEXT NOT NULL REFERENCES document_access_grants(grant_id),
  document_id TEXT NOT NULL,
  entity_slug TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (grant_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_access_documents_document
  ON document_access_documents (document_id, grant_id);
CREATE INDEX IF NOT EXISTS idx_document_access_documents_entity
  ON document_access_documents (entity_slug, grant_id);

-- Persistent idempotency records contain only privacy-safe response metadata.
-- Enrollment secrets are derived again from the request id and the install's
-- session signing key; the plaintext is never stored in D1.
CREATE TABLE IF NOT EXISTS document_access_requests (
  request_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('create', 'revoke', 'reissue')),
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS document_access_events (
  event_id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  request_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'grant', 'system')),
  grant_id TEXT,
  entity_slug TEXT,
  document_id TEXT,
  route TEXT,
  event_type TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'unavailable')),
  reason_code TEXT NOT NULL,
  document_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_document_access_events_grant
  ON document_access_events (grant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_access_events_time
  ON document_access_events (occurred_at DESC);

-- The identity on a passkey and its one-time enrollment link. NULL means the
-- owner because every passkey and link created before this migration belonged
-- to the owner. A scoped session must carry this value all the way to the read
-- gate; a missing or unreadable grant never falls back to owner.
ALTER TABLE owner_passkeys ADD COLUMN document_grant_id TEXT;
ALTER TABLE enrollment_codes ADD COLUMN document_grant_id TEXT;

-- Ceremony/use telemetry deliberately excludes credential ids, challenge
-- material, assertions, public keys, IP addresses and user agents. rp_id is
-- retained because domain binding is the field a later real-domain acceptance
-- test must diagnose.
CREATE TABLE IF NOT EXISTS passkey_security_events (
  event_id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  rp_id TEXT NOT NULL,
  ceremony TEXT NOT NULL CHECK (ceremony IN ('registration', 'authentication', 'session_use')),
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'forbidden', 'unavailable')),
  reason_code TEXT NOT NULL,
  duration_ms INTEGER,
  principal_kind TEXT CHECK (principal_kind IN ('owner', 'grant', 'unknown')),
  grant_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_passkey_security_events_time
  ON passkey_security_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_passkey_security_events_rp
  ON passkey_security_events (rp_id, occurred_at DESC);
