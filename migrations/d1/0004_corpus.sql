-- 0004_corpus — the brain's own storage, on Cloudflare alone.
--
-- WHY THIS EXISTS
--
-- The v1 worker called Supabase for retrieval, which forced every client to
-- own a second vendor account. The install model is one Cloudflare account per
-- client, so a Supabase dependency breaks it twice: another account to create,
-- and a free tier that PAUSES after inactivity, which for a brain queried a few
-- times a week means a brain that is asleep exactly when someone needs it.
--
-- So text and keyword search live here in D1, and vectors live in Vectorize,
-- both inside the client's own account.
--
-- SHAPED FOR THE EXIT, DELIBERATELY
--
-- Above roughly 250,000 chunks this design should hand off to Postgres and
-- pgvector. That migration is cheap only if the decision is made now, so these
-- tables use the names, columns and semantics the Postgres schema will use.
-- Moving becomes a data copy rather than a redesign.
--
-- The one rule that makes it work: chunk_uid is the ONLY join key that ever
-- leaves this system. It is the Vectorize vector id, the D1 unique key, the
-- future Postgres primary key, and the id in every citation the brain emits.
-- The integer rowid exists solely because FTS5 external-content mode requires
-- one, and it must never appear in an API response, a log line, or a citation.

CREATE TABLE IF NOT EXISTS documents (
  doc_uid        TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  title          TEXT,
  uri            TEXT,
  -- When the document is FROM, not when the file was touched. Learned the hard
  -- way: storing a file mtime here made 80% of a corpus look like it was
  -- written this year, which silently disabled staleness reporting.
  document_date  INTEGER,
  date_source    TEXT,
  date_reliable  INTEGER DEFAULT 0,
  -- Promoted out of `meta` and given real columns because these two are the
  -- only ones anyone actually FILTERS on. A filter that cannot be applied has
  -- to be refused loudly; the alternative is answering "what did we agree with
  -- this client" from every client's documents while appearing to have
  -- narrowed. Cheap columns are the fix for that.
  client         TEXT,
  category       TEXT,
  ingested_at    INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  meta           TEXT,
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_source    ON documents (source);
CREATE INDEX IF NOT EXISTS idx_documents_date      ON documents (document_date DESC);
CREATE INDEX IF NOT EXISTS idx_documents_ingested  ON documents (ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_client    ON documents (client);

CREATE TABLE IF NOT EXISTS chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_uid  TEXT NOT NULL UNIQUE,
  doc_uid    TEXT NOT NULL REFERENCES documents(doc_uid) ON DELETE CASCADE,
  chunk_ix   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  -- Denormalised from documents on purpose. Retrieval reads these on every hit
  -- and D1 has no cheap join at query time in a Worker's CPU budget.
  source     TEXT NOT NULL,
  title      TEXT,
  document_date INTEGER,
  client     TEXT,
  category   TEXT,
  UNIQUE (doc_uid, chunk_ix)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc     ON chunks (doc_uid);
CREATE INDEX IF NOT EXISTS idx_chunks_source  ON chunks (source);
CREATE INDEX IF NOT EXISTS idx_chunks_client  ON chunks (client);
CREATE INDEX IF NOT EXISTS idx_chunks_date    ON chunks (document_date DESC);

-- FTS5 in external-content mode: the index stores no copy of the text, it
-- points back at `chunks`. Verified working on live D1 on 2026-08-16, including
-- bm25 ranking and the porter tokenizer. Note pragma_module_list is blocked on
-- D1, so the only valid way to test FTS5 support is to actually create one.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  title,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);

-- External-content FTS5 does not self-maintain. Without these the index
-- silently drifts from the table and keyword search rots without erroring.
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, title) VALUES('delete', old.id, old.text, old.title);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, title) VALUES('delete', old.id, old.text, old.title);
  INSERT INTO chunks_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
END;

-- The outbox exists ONLY because there is no transaction across D1 and
-- Vectorize.
--
-- Postgres commits the text and its vector in one statement. Here they are two
-- systems, and Vectorize writes are explicitly asynchronous: a write-ahead log
-- first, the index later. So a crash between the D1 insert and the Vectorize
-- upsert leaves a chunk that keyword search can find and vector search cannot,
-- with nothing to say so.
--
-- Every chunk therefore lands here first and is cleared only once Vectorize has
-- acknowledged it. Anything still pending is a chunk the vector index does not
-- have yet, which makes the gap visible and repairable instead of silent.
--
-- This table is DELETED on the migration to Postgres. It papers over a missing
-- guarantee that Postgres provides natively.
CREATE TABLE IF NOT EXISTS vector_outbox (
  chunk_uid   TEXT PRIMARY KEY,
  op          TEXT NOT NULL,
  queued_at   INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_queued ON vector_outbox (queued_at);

-- Named ingest sources, so a bad import can be removed without touching
-- anything else. Mirrors the sources table from 0003 but scoped to the corpus.
CREATE TABLE IF NOT EXISTS corpus_stats (
  source          TEXT PRIMARY KEY,
  documents       INTEGER NOT NULL DEFAULT 0,
  chunks          INTEGER NOT NULL DEFAULT 0,
  last_ingest_at  INTEGER,
  last_error      TEXT
);
