-- 0014_owner_passkeys — passkey access for the brain's owner.
--
-- The owner's everyday credential becomes a passkey (Face ID / fingerprint
-- on their own device). Only PUBLIC halves are stored, in the owner's own
-- database; challenges and enrollment codes are stored hashed and single-use,
-- so nothing in a leaked backup opens anything.

CREATE TABLE IF NOT EXISTS owner_passkeys (
  credential_id TEXT PRIMARY KEY,
  public_key_jwk TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  nickname TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Sign-out-everywhere: bumping the generation invalidates every session
-- cookie ever minted, with no per-session tracking.
ALTER TABLE install_state
  ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 1;
