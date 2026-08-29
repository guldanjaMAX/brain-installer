-- 0016_zones — which documents a person may read, not just what they may do.
--
-- Schema 15 answered "the CPA may read but not delete". It could not answer
-- "the bookkeeper may see the books but not the medical files", because every
-- reader saw the whole corpus. This adds the missing half.
--
-- A ZONE is a coarse sensitivity bucket: books, medical, legal, personal.
-- Nobody labels documents. A document inherits its zone from the SOURCE it was
-- ingested under, and 0003 already established that a source is one named
-- ingest pass rather than one connector: its own comment says two Drive
-- sources with different scopes "must be separately reversible, so the
-- connector cannot be the identity". So one Google Drive can supply a `books`
-- source and a `medical` source, and the boundary is chosen by whoever runs
-- the install, once, at the moment they already choose what to load.
--
-- The cost of that choice is real and belongs in the install procedure, not
-- hidden here: a client whose whole corpus arrives as one unnamed pass has one
-- zone, and zones then buy them nothing. That is a true statement about their
-- install, not a silent failure of this schema.
--
-- zone is denormalised onto chunks exactly as 0007 did for top_folder, and for
-- the same reason: the authority is the row the text is read from, and a join
-- away is a join that some future query forgets to make.

CREATE TABLE IF NOT EXISTS zones (
  zone TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE sources   ADD COLUMN zone TEXT;
ALTER TABLE documents ADD COLUMN zone TEXT;
ALTER TABLE chunks    ADD COLUMN zone TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_zone ON documents (zone);
CREATE INDEX IF NOT EXISTS idx_chunks_zone    ON chunks (zone);

-- What a grant may read.
--
-- scope_include is either {"all":true} or {"zones":[...]}. scope_exclude is a
-- list of zones that wins over include, so "everything except medical" is one
-- row rather than a list that has to be edited every time a zone is added.
--
-- Existing grants get {"all":true}, which is exactly what they had yesterday:
-- schema 15 shipped capabilities without scope, so widening nothing is the
-- only migration that does not silently change what a live grant can see.
ALTER TABLE grants ADD COLUMN scope_include TEXT NOT NULL DEFAULT '{"all":true}';
ALTER TABLE grants ADD COLUMN scope_exclude TEXT NOT NULL DEFAULT '[]';
