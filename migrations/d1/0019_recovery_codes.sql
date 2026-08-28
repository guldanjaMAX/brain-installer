-- 0019_recovery_codes — the way back in when every enrolled device is gone.
--
-- WHY THIS EXISTS
--
-- Before this migration, a lost, destroyed or wiped device left exactly one
-- route back into /app: someone holding the ADMIN KEY mints a fresh enrollment
-- invite. That key can also ingest, purge, reindex and drain. So the only
-- escape hatch from "I lost my phone" was the most powerful credential in the
-- install, and at handoff the client rotates it to a value the installer has
-- never seen — meaning the recovery depended on the client both keeping that
-- key and knowing a command line existed. For a non-technical owner that is a
-- lockout with extra steps.
--
-- A recovery code is deliberately WEAKER than the key it replaces in this
-- role. It authorises exactly one thing: one WebAuthn registration, with user
-- verification, on a device the person is holding. It cannot read, cannot
-- ingest, cannot purge, and it does not itself become a session. What the
-- holder ends up with is a passkey, verified by the same unskippable checklist
-- as every other passkey, bound to the same origin.
--
-- WHY HASHED, AND WHY A FAST HASH IS CORRECT HERE
--
-- Only SHA-256 hashes are stored, so a stolen database backup contains nothing
-- usable. A fast hash is the right choice — unlike a human-chosen password, a
-- code here is 20 characters drawn uniformly from a 31-symbol alphabet, about
-- 99 bits. There is no dictionary to run and no rainbow table that reaches it.
-- Key stretching would protect against an attack that cannot happen.

CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  used_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_unused
  ON recovery_codes (used_at) WHERE used_at IS NULL;

-- Throttle state for the recovery route. Live security state, not corpus: it
-- is listed in the recovery contract's table inventory and deliberately NOT
-- exported, exactly like auth_challenges and enrollment_codes. Entropy is what
-- actually stops guessing; this table exists so a grind is also slow, bounded,
-- and VISIBLE to the owner as a count of failed attempts.
CREATE TABLE IF NOT EXISTS recovery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_at
  ON recovery_attempts (attempted_at);
