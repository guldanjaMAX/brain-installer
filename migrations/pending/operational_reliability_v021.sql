-- UNNUMBERED: reserve 0029/0030 only after migrations 0023 through 0028 freeze.
-- This file is intentionally outside migrations/d1 and is not applied by install.

CREATE TABLE IF NOT EXISTS public_request_quotas (
  key_hash          TEXT NOT NULL,
  route_class       TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count     INTEGER NOT NULL DEFAULT 1,
  expires_at        INTEGER NOT NULL,
  PRIMARY KEY (key_hash, route_class, window_started_at),
  CHECK (length(key_hash) = 64),
  CHECK (route_class GLOB '[a-z0-9_]*' AND route_class NOT GLOB '*[^a-z0-9_]*'),
  CHECK (request_count >= 1)
);

CREATE INDEX IF NOT EXISTS idx_public_request_quotas_expiry
  ON public_request_quotas (expires_at);

CREATE TABLE IF NOT EXISTS vector_outbox_retry_state (
  chunk_uid       TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  quarantined_at  INTEGER,
  failure_code    TEXT NOT NULL,
  last_error      TEXT,
  PRIMARY KEY (chunk_uid, generation),
  CHECK (attempts >= 1),
  CHECK (failure_code GLOB '[a-z0-9_]*' AND failure_code NOT GLOB '*[^a-z0-9_]*')
);

CREATE INDEX IF NOT EXISTS idx_vector_outbox_retry_eligible
  ON vector_outbox_retry_state (quarantined_at, next_attempt_at);
