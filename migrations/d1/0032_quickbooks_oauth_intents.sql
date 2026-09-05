-- Short-lived QuickBooks HTTPS callback handoffs.
--
-- The authorization code and raw company id exist only inside a client-keyed
-- encrypted envelope. OAuth state, claim capability, and local intent ids are
-- represented by SHA-256 hashes so a database read cannot replay a ceremony.

CREATE TABLE IF NOT EXISTS quickbooks_oauth_intents (
  tenant_id                       TEXT NOT NULL DEFAULT 'primary',
  intent_hash                     TEXT NOT NULL,
  state_hash                      TEXT NOT NULL,
  claim_hash                      TEXT NOT NULL,
  start_fingerprint               TEXT NOT NULL,
  pkce_challenge_hash             TEXT,
  recipient_public_jwk            TEXT,
  source                          TEXT NOT NULL,
  environment                     TEXT NOT NULL,
  client_id_fingerprint           TEXT NOT NULL,
  expected_company_fingerprint    TEXT,
  status                          TEXT NOT NULL DEFAULT 'pending',
  terminal_reason                 TEXT,
  callback_envelope               TEXT,
  callback_fingerprint            TEXT,
  created_at                      INTEGER NOT NULL,
  expires_at                      INTEGER NOT NULL,
  received_at                     INTEGER,
  claimed_at                      INTEGER,
  finalized_at                    INTEGER,
  finalized_company_fingerprint   TEXT,
  local_credential_fingerprint    TEXT,
  PRIMARY KEY (tenant_id, intent_hash),
  UNIQUE (tenant_id, state_hash),
  UNIQUE (tenant_id, claim_hash),
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(claim_hash) = 64 AND claim_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(start_fingerprint) = 64 AND start_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK (pkce_challenge_hash IS NULL OR (length(pkce_challenge_hash) = 64 AND pkce_challenge_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (recipient_public_jwk IS NULL OR (json_valid(recipient_public_jwk) AND length(recipient_public_jwk) BETWEEN 100 AND 1024)),
  CHECK (source GLOB '[a-z0-9]*' AND source NOT GLOB '*[^a-z0-9_-]*' AND length(source) BETWEEN 1 AND 64),
  CHECK (environment IN ('sandbox','production')),
  CHECK (length(client_id_fingerprint) = 64 AND client_id_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK (expected_company_fingerprint IS NULL OR (length(expected_company_fingerprint) = 64 AND expected_company_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK (status IN ('pending','received','finalized','canceled')),
  CHECK (terminal_reason IS NULL OR terminal_reason IN ('provider_authorization_not_completed','provider_callback_incomplete')),
  CHECK (callback_envelope IS NULL OR (json_valid(callback_envelope) AND length(callback_envelope) BETWEEN 100 AND 8192)),
  CHECK (callback_fingerprint IS NULL OR (length(callback_fingerprint) = 64 AND callback_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK (expires_at > created_at AND expires_at <= created_at + 900000),
  CHECK (received_at IS NULL OR received_at >= created_at),
  CHECK (claimed_at IS NULL OR (received_at IS NOT NULL AND claimed_at >= received_at)),
  CHECK (finalized_at IS NULL OR (received_at IS NOT NULL AND finalized_at >= received_at)),
  CHECK (finalized_company_fingerprint IS NULL OR (length(finalized_company_fingerprint) = 64 AND finalized_company_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK (local_credential_fingerprint IS NULL OR (length(local_credential_fingerprint) = 64 AND local_credential_fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    (status = 'pending' AND terminal_reason IS NULL AND callback_envelope IS NULL AND callback_fingerprint IS NULL AND received_at IS NULL AND finalized_at IS NULL) OR
    (status = 'received' AND terminal_reason IS NULL AND recipient_public_jwk IS NOT NULL AND callback_envelope IS NOT NULL AND callback_fingerprint IS NOT NULL AND received_at IS NOT NULL AND finalized_at IS NULL) OR
    (status = 'finalized' AND terminal_reason IS NULL AND recipient_public_jwk IS NULL AND callback_envelope IS NULL AND callback_fingerprint IS NOT NULL AND received_at IS NOT NULL AND finalized_at IS NOT NULL AND finalized_company_fingerprint IS NOT NULL AND local_credential_fingerprint IS NOT NULL) OR
    (status = 'canceled' AND terminal_reason IS NOT NULL AND recipient_public_jwk IS NULL AND callback_envelope IS NULL AND callback_fingerprint IS NULL AND finalized_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_oauth_intents_expiry
  ON quickbooks_oauth_intents (tenant_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_quickbooks_oauth_intents_status
  ON quickbooks_oauth_intents (tenant_id, status, expires_at);
