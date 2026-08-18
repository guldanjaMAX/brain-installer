-- 0003_sources: named, independently reversible ingest scopes.
--
-- A first import a client cannot roll back is one they will hesitate to
-- authorise at full size, so the import that matters most is the one they are
-- least willing to run. Naming every ingest and giving it its own undo removes
-- that hesitation: a bad import becomes a command instead of a support call and
-- a hand-written DELETE against their only copy of their data.
--
-- The name is not a label, it is the SCOPE KEY. Every document written under a
-- source carries the source name as its `source_type` in the store, which is
-- what makes removal exact: one equality match, no LIKE, no prefix arithmetic,
-- nothing to get subtly wrong on the one operation that cannot be undone.
--
-- That is also why `name` is constrained rather than free text. A name
-- containing a quote or a wildcard would be a scope key that can reach outside
-- its own scope, and the blast radius of that lands on a delete.

CREATE TABLE IF NOT EXISTS sources (
  name              TEXT PRIMARY KEY,
  -- The connector that fills it: drive | gmail | calendar | slack | notion |
  -- upload. Distinct from `name` on purpose. Two Drive sources with different
  -- scopes ("drive-priority" and "drive-backfill") must be separately
  -- reversible, so the connector cannot be the identity.
  kind              TEXT NOT NULL,
  -- pending | indexing | ready | error. The install is not ready because the
  -- worker answers; it is ready when each source says so, and a client watching
  -- one line per source can see a stall without being able to read a log.
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TEXT NOT NULL,
  last_ingest_at    TEXT,
  -- The last receipt, NOT the authority. The document store is the authority.
  -- Keeping a local number that can drift is deliberate: `brain sources` prints
  -- both and names the gap, and a drift of thousands is the cheapest available
  -- signal that an ingest died halfway.
  document_count    INTEGER NOT NULL DEFAULT 0,
  -- Connector resume state, opaque here on purpose: a Gmail historyId, a
  -- Calendar syncToken, a Drive pageToken and a file-modified watermark are all
  -- the same thing to this table and none of them should force a migration.
  sync_cursor       TEXT,
  cursor_updated_at TEXT,
  -- JSON: what this source actually pulled (folder ids, a since date, a label).
  -- It duplicates the manifest and that is the point. The manifest is edited
  -- between runs; this records what the ingest that produced these documents
  -- was actually told to cover, which is the only version that explains the
  -- contents later.
  scope             TEXT,
  notes             TEXT,
  -- Read as: starts with a letter or digit, and contains NOTHING outside
  -- [a-z0-9_-]. Two things here were wrong on the first try and both were found
  -- by running them rather than reading them, which is why they are written
  -- down: GLOB is filename globbing and not a regex, so the obvious
  -- '[a-z0-9][a-z0-9_-]*' means "two allowed characters then ANYTHING" and
  -- cheerfully accepts 'drive%'; and GLOB negates a character class with
  -- '[^...]', where '[!...]' silently reads the '!' as a literal member and
  -- inverts the meaning of the whole constraint.
  CHECK (name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9_-]*' AND length(name) BETWEEN 1 AND 64),
  CHECK (status IN ('pending', 'indexing', 'ready', 'error'))
);

-- What happened to each source, including the removals.
--
-- Same reasoning as upgrade_runs in 0001: the destructive operation is exactly
-- the one whose history has to survive it. A client asking "what happened to
-- the 4,000 documents that used to be here" deserves a row that says a named
-- source was forgotten, when, and how many went with it.
--
-- Deliberately NO foreign key to sources. `brain forget` deletes the sources
-- row so the name is free to reuse and the listing stays truthful, and a
-- cascade would take the receipt with it.
CREATE TABLE IF NOT EXISTS source_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name  TEXT NOT NULL,
  -- registered | ingest | forget | error
  event        TEXT NOT NULL,
  at           TEXT NOT NULL,
  -- Documents involved: added by an ingest, removed by a forget.
  documents    INTEGER,
  detail       TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_events_source ON source_events(source_name, at DESC);
