-- Short-lived, single-use receipts for destructive agent proposals.
--
-- An automation may prepare a deletion preview, but it can never execute one.
-- The opaque receipt binds the requesting principal, exact owner entity,
-- sorted document ids, row count, current content digest and expiry. Execution
-- additionally requires a fresh owner passkey assertion whose challenge names
-- this receipt and digest. Completed rows retain only bounded proof needed for
-- an exact response-loss retry; they are live authority state, not backups.

CREATE TABLE IF NOT EXISTS agent_action_receipts (
  receipt_hash       TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'primary',
  action_type        TEXT NOT NULL DEFAULT 'corpus_deletion',
  principal_kind     TEXT NOT NULL,
  principal_id_hash  TEXT NOT NULL,
  agent_profile      TEXT NOT NULL,
  entity_slug        TEXT NOT NULL,
  document_ids_json  TEXT NOT NULL,
  document_count     INTEGER NOT NULL,
  chunk_count        INTEGER NOT NULL,
  selection_digest   TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  state              TEXT NOT NULL DEFAULT 'previewed',
  request_id         TEXT,
  request_hash       TEXT,
  confirmed_at       INTEGER,
  executing_at       INTEGER,
  completed_at       INTEGER,
  response_json      TEXT,
  response_status    INTEGER,
  created_at         INTEGER NOT NULL,
  CHECK (tenant_id = 'primary'),
  CHECK (action_type = 'corpus_deletion'),
  CHECK (principal_kind IN ('owner', 'oauth_connector')),
  CHECK (length(principal_id_hash) = 64),
  CHECK (agent_profile IN ('owner', 'librarian', 'structured-contributor', 'technician', 'break-glass')),
  CHECK (entity_slug GLOB '[a-z0-9]*' AND entity_slug NOT GLOB '*[^a-z0-9_-]*' AND length(entity_slug) BETWEEN 1 AND 64),
  CHECK (json_valid(document_ids_json) AND json_type(document_ids_json) = 'array'),
  CHECK (document_count BETWEEN 1 AND 50),
  CHECK (chunk_count >= 0),
  CHECK (length(selection_digest) = 64),
  CHECK (expires_at > created_at),
  CHECK (state IN ('previewed', 'confirmed', 'executing', 'completed', 'invalidated')),
  CHECK (request_id IS NULL OR (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128)),
  CHECK (request_hash IS NULL OR length(request_hash) = 64),
  CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 299),
  CHECK ((state = 'previewed' AND request_id IS NULL AND request_hash IS NULL AND confirmed_at IS NULL AND executing_at IS NULL AND completed_at IS NULL AND response_json IS NULL AND response_status IS NULL)
      OR (state = 'confirmed' AND request_id IS NOT NULL AND request_hash IS NOT NULL AND confirmed_at IS NOT NULL AND executing_at IS NULL AND completed_at IS NULL AND response_json IS NULL AND response_status IS NULL)
      OR (state = 'executing' AND request_id IS NOT NULL AND request_hash IS NOT NULL AND confirmed_at IS NOT NULL AND executing_at IS NOT NULL AND completed_at IS NULL AND response_json IS NULL AND response_status IS NULL)
      OR (state = 'completed' AND request_id IS NOT NULL AND request_hash IS NOT NULL AND confirmed_at IS NOT NULL AND executing_at IS NOT NULL AND completed_at IS NOT NULL AND response_json IS NOT NULL AND response_status IS NOT NULL)
      OR state = 'invalidated')
);

CREATE INDEX IF NOT EXISTS idx_agent_action_receipts_expiry
  ON agent_action_receipts (tenant_id, state, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_action_receipts_request
  ON agent_action_receipts (tenant_id, request_id)
  WHERE request_id IS NOT NULL;
