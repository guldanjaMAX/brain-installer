-- 0017_chunk_token_fit — make "is this chunk fully searchable" a stored fact.
--
-- WHY A COLUMN AND NOT A CALCULATION
--
-- The embedding model reads 512 tokens. Everything the product measured before
-- this migration was counted in CHARACTERS, which is a proxy that goes quiet
-- exactly where it matters: 1,500 characters of prose is about 330 tokens and
-- fits, while 1,500 characters of transaction rows or Japanese is 800 to 1,500
-- tokens and is cut in half. A character threshold therefore reads clean on the
-- documents that are being truncated.
--
-- Tokens cannot be counted in SQL. Counting them in the Worker on every health
-- read would mean pulling every chunk body through a request, which on a real
-- corpus is not a report, it is an outage. So the count is written once, when
-- the chunk is written, and the owner-facing figure becomes one indexed
-- aggregate.
--
-- THE NULL IS LOAD-BEARING
--
-- Every chunk that already exists gets NULL, and NULL means NEVER MEASURED. It
-- is deliberately not zero and deliberately not "fine": a corpus loaded before
-- this migration has an unknown amount of unreachable text, and reporting an
-- unknown as a pass is the same defect as a degraded index reporting an
-- absence. `brain refit` fills these in, and the health surface says "not yet
-- measured" until it has.
--
-- Every statement is independently idempotent or guarded by the migration
-- runner's column-existence check, because D1's REST endpoint commits per
-- statement and a crash mid-file must leave a resumable schema.

-- Estimated WordPiece tokens for the exact text that gets embedded, header
-- included. NULL = not yet measured.
ALTER TABLE chunks ADD COLUMN embed_tokens INTEGER;

-- The health aggregate reads only this column, so let it be answered from the
-- index instead of the table.
CREATE INDEX IF NOT EXISTS idx_chunks_embed_tokens ON chunks (embed_tokens);

-- Finding the next document that still needs refitting is "any chunk of this
-- document that is unmeasured or over budget", which is a per-document seek.
CREATE INDEX IF NOT EXISTS idx_chunks_doc_embed_tokens ON chunks (doc_uid, embed_tokens);

-- ---------------------------------------------------------------- refit state
--
-- The refit re-splits chunks that are too long for the embedder and re-queues
-- them. On a large corpus that costs real money and real time, so it must be
-- resumable rather than one long request that either finishes or is lost. The
-- cursor is a doc_uid: every document at or before it has been examined.
ALTER TABLE install_state ADD COLUMN chunk_refit_cursor TEXT;
ALTER TABLE install_state ADD COLUMN chunk_refit_started_at INTEGER;
ALTER TABLE install_state ADD COLUMN chunk_refit_completed_at INTEGER;
ALTER TABLE install_state ADD COLUMN chunk_refit_documents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE install_state ADD COLUMN chunk_refit_chunks_added INTEGER NOT NULL DEFAULT 0;
