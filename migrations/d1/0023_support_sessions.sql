-- 0023_support_sessions
--
-- A support session is a short-lived, read-only diagnostic principal. It is
-- deliberately separate from owner and document-grant authentication: no
-- nullable subject column can be misread as an owner, and restoring a database
-- never restores a live technician credential.

CREATE TABLE IF NOT EXISTS support_sessions (
  support_session_id TEXT PRIMARY KEY,
  technician_label TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  invite_expires_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  last_authenticated_at INTEGER,
  first_used_at INTEGER,
  last_used_at INTEGER,
  last_system_at INTEGER,
  revoked_at INTEGER,
  revoke_request_id TEXT,
  create_request_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  current_invite_code_hash TEXT NOT NULL,
  CHECK (support_session_id GLOB 'ss_[A-Za-z0-9_-]*' AND support_session_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(support_session_id) BETWEEN 8 AND 64),
  CHECK (length(technician_label) BETWEEN 1 AND 80),
  CHECK (duration_minutes IN (15, 30, 60, 120)),
  CHECK (length(create_request_id) BETWEEN 1 AND 128),
  CHECK (revoke_request_id IS NULL OR (revoke_request_id GLOB '[A-Za-z0-9_-]*' AND revoke_request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(revoke_request_id) BETWEEN 1 AND 128)),
  CHECK (length(request_fingerprint) = 64),
  CHECK (length(current_invite_code_hash) = 64),
  CHECK ((activated_at IS NULL AND expires_at IS NULL AND last_authenticated_at IS NULL) OR
         (activated_at IS NOT NULL AND expires_at IS NOT NULL AND last_authenticated_at IS NOT NULL)),
  CHECK ((first_used_at IS NULL AND last_used_at IS NULL) OR
         (first_used_at IS NOT NULL AND last_used_at IS NOT NULL)),
  CHECK (first_used_at IS NULL OR activated_at IS NOT NULL),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_state
  ON support_sessions (revoked_at, expires_at, invite_expires_at, created_at DESC);

-- One request id names one immutable create, reissue, or revoke receipt. The
-- receipt never contains an enrollment code or URL; a response-loss replay
-- derives the same code from the install signing key and then checks this
-- hash-only invite row before returning it.
CREATE TABLE IF NOT EXISTS support_access_requests (
  request_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('create', 'reissue', 'revoke')),
  support_session_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  invite_code_hash TEXT,
  created_at INTEGER NOT NULL,
  CHECK (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128),
  CHECK (support_session_id GLOB 'ss_[A-Za-z0-9_-]*' AND support_session_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(support_session_id) BETWEEN 8 AND 64),
  CHECK (length(request_fingerprint) = 64),
  CHECK (invite_code_hash IS NULL OR length(invite_code_hash) = 64)
);

CREATE TABLE IF NOT EXISTS support_enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  support_session_id TEXT NOT NULL REFERENCES support_sessions(support_session_id),
  request_id TEXT NOT NULL REFERENCES support_access_requests(request_id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (length(code_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_support_enrollment_session
  ON support_enrollment_codes (support_session_id, created_at DESC);

-- Support ceremonies do not share the owner's challenge or passkey tables.
-- Only public passkey material is retained; no credential id is ever copied
-- into human activity or the support audit stream.
CREATE TABLE IF NOT EXISTS support_auth_challenges (
  challenge_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_passkeys (
  credential_id TEXT PRIMARY KEY,
  credential_key TEXT NOT NULL UNIQUE,
  support_session_id TEXT NOT NULL UNIQUE REFERENCES support_sessions(support_session_id),
  public_key_jwk TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  CHECK (credential_key GLOB '[a-f0-9]*' AND credential_key NOT GLOB '*[^a-f0-9]*' AND length(credential_key) = 24)
);

-- Low-level support history is immutable, bounded, and intentionally unable
-- to hold request bodies, document identifiers, credentials, errors, network
-- metadata, or user-agent strings.
CREATE TABLE IF NOT EXISTS support_access_events (
  event_id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  request_id TEXT,
  support_session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'invite_reissued', 'activated', 'authenticated', 'read', 'revoked', 'denied', 'expired', 'unavailable')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'unavailable')),
  reason_code TEXT NOT NULL,
  route TEXT,
  CHECK (length(event_id) BETWEEN 1 AND 180),
  CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  CHECK (support_session_id GLOB 'ss_[A-Za-z0-9_-]*' AND support_session_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(support_session_id) BETWEEN 8 AND 64),
  CHECK (reason_code GLOB '[a-z0-9_]*' AND reason_code NOT GLOB '*[^a-z0-9_]*' AND length(reason_code) BETWEEN 1 AND 80),
  CHECK (route IS NULL OR route IN ('me', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_support_access_events_session
  ON support_access_events (support_session_id, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS support_access_events_no_update
BEFORE UPDATE ON support_access_events
BEGIN
  SELECT RAISE(ABORT, 'support_access_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS support_access_events_no_delete
BEFORE DELETE ON support_access_events
BEGIN
  SELECT RAISE(ABORT, 'support_access_events are append-only');
END;
