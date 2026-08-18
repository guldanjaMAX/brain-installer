-- 0005_vector_id — bound the id sent to Vectorize.
--
-- Vectorize caps a vector id at 64 BYTES, and chunk ids are derived from the
-- document path, so any realistically-named file exceeds it. Found on the first
-- real Windows install: one 67-byte id made the upsert throw, and every chunk
-- queued behind it was stranded. Nothing reported a failure. Ingest said
-- documents were created, /health said ok, and keyword search kept answering.
-- The only signal was a backlog that stopped decreasing.
--
-- Long ids are now hashed for Vectorize. chunk_uid stays the readable join key
-- everywhere else; this column records which vector id a chunk was stored under
-- so a search hit can be resolved back.

ALTER TABLE chunks ADD COLUMN vector_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chunks_vector_id ON chunks (vector_id);
