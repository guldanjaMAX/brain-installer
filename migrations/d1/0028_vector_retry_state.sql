-- 0028_vector_retry_state

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
