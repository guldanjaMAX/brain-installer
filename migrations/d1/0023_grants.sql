-- 0023_grants — named people, with capabilities, instead of one key that does everything.
--
-- Until now a brain had exactly one level of access: whoever held ADMIN_KEY
-- could read every document and delete the corpus, and there was no way to
-- say "the bookkeeper may ask questions and file receipts, but may not purge
-- anything". access.authorized_emails existed in the manifest schema and its
-- own description said it was read by nothing. This is the table that makes
-- it real.
--
-- A GRANT is one named person and what they may do. A CREDENTIAL is an opaque
-- token bound to one grant, stored only as a SHA-256 hash, exactly like
-- enrollment_codes in 0014: a leaked backup of this table opens nothing.
--
-- Scope (which documents a grant may read) is deliberately NOT here. That is
-- the next migration, and it needs a zone on every source, document and
-- chunk. Shipping capabilities first is not a shortcut: it is the half that
-- can be enforced at one chokepoint and proven, and it already answers "read
-- but not delete", which is most of what a household with a bookkeeper asks
-- for.

CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  -- What the owner calls this person. Shown in `brain grants` and on the
  -- Access screen. Never used for authorization.
  display_name TEXT NOT NULL,
  relationship TEXT,
  -- JSON array, a subset of: ask, file, diagnose, administer, destroy.
  -- Stored as text because D1 has no array type and because the set is
  -- validated in one place in the worker rather than by the database.
  capabilities TEXT NOT NULL,
  -- Unix ms. NULL means no expiry, which the owner has to choose explicitly.
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  -- Revocation is a timestamp, never a delete: a revoked grant must stay
  -- readable so "who had access in March" is answerable after the fact.
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS grant_credentials (
  -- sha256 hex of the token. The token itself is shown once, at mint time,
  -- and is not recoverable from this row.
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(grant_id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_grant_credentials_grant ON grant_credentials (grant_id);

-- A passkey now belongs to somebody.
--
-- This column is the fix for a hole that does not exist yet but would the
-- moment grants did. /auth/register accepts an existing SESSION in place of
-- an invite code, so a person who has been given a scoped passkey could
-- enroll a second device with no code. If that device were stored with no
-- owner, a resolver reading "no grant" as "the owner" would hand them the
-- whole corpus in three requests. A device inherits the grant of whatever
-- authorized it, and NULL means the owner only because the owner's own
-- passkeys predate this column.
ALTER TABLE owner_passkeys ADD COLUMN grant_id TEXT;
ALTER TABLE enrollment_codes ADD COLUMN grant_id TEXT;
