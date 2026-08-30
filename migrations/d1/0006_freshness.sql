-- Freshness: let the brain know, and say, how current it actually is.
--
-- The gap engine already reports the age of what it RETRIEVED. That is content
-- staleness. It cannot report the thing that matters more: "I have not looked
-- at this source since July, so there may be material I have never seen." That
-- is coverage staleness, and it is invisible to every signal we had, because a
-- source that is never re-read looks identical to one with nothing new in it.
--
-- Additive only. Every column is nullable or defaulted, so this applies cleanly
-- to an install that already holds documents.

-- How often this source is EXPECTED to be refreshed. NULL means no expectation
-- has been set, and no staleness claim is made about it, which is the honest
-- default for a one-off folder upload.
ALTER TABLE sources ADD COLUMN expected_refresh_seconds INTEGER;

-- The last time the source was enumerated IN FULL, as distinct from the last
-- time anything was written. An incremental sync that saw three changed files
-- proves nothing about the other ten thousand, so deletion can only be inferred
-- from a complete sweep. Kept separate from last_ingest_at for exactly that.
ALTER TABLE sources ADD COLUMN last_complete_sweep_at TEXT;

-- Why a source stopped being current, when we know: auth_expired, quota,
-- unreachable, never_scheduled. Shown to the client verbatim, because "sync
-- broken" without a reason is a support ticket.
ALTER TABLE sources ADD COLUMN stale_reason TEXT;

-- Tombstones. A document removed at the source must stop answering questions,
-- and it must be possible to say WHY it went, rather than having it silently
-- vanish. Retrieval filters on deleted_at IS NULL.
ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
ALTER TABLE documents ADD COLUMN removal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_live ON documents (source, deleted_at);

-- One row per sync attempt, so "when did this last work" is answerable and a
-- run that refused to delete leaves a record of what it would have removed.
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id            TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  lane              TEXT NOT NULL,          -- incremental | sweep | manual
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  walk_complete     INTEGER NOT NULL DEFAULT 0,
  files_seen        INTEGER NOT NULL DEFAULT 0,
  docs_added        INTEGER NOT NULL DEFAULT 0,
  docs_updated      INTEGER NOT NULL DEFAULT 0,
  docs_unchanged    INTEGER NOT NULL DEFAULT 0,
  proposed_deletes  INTEGER NOT NULL DEFAULT 0,
  -- applied | refused | forced. A sweep that saw only part of the source must
  -- never delete on that basis, and refusing has to be visible rather than
  -- silent, or it reads as "nothing changed".
  delete_action     TEXT,
  refusal_reason    TEXT,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs (source, started_at);
