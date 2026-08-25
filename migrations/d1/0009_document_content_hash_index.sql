-- 0009_document_content_hash_index
--
-- Exact duplicate-document reporting groups live documents by their canonical
-- content hash. Without an index, a large install pays a full unindexed group
-- scan every time an owner runs `brain diagnose`. The partial index excludes
-- tombstones and empty legacy values, matching the diagnostic predicate.

CREATE INDEX IF NOT EXISTS idx_documents_live_content_hash
  ON documents (content_hash)
  WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash != '';
