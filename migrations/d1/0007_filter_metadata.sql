-- 0007_filter_metadata — make every public retrieval filter native to D1 and
-- Vectorize.
--
-- These values used to live only inside `documents.meta`, while vector search
-- selected its top candidates before D1 applied most filters. On a large
-- corpus a narrow filter could therefore return few or no vector candidates
-- even when matching chunks existed. Real columns make exact D1 filtering and
-- Vectorize pre-filtering use the same contract.

ALTER TABLE documents ADD COLUMN top_folder TEXT;
ALTER TABLE documents ADD COLUMN platform TEXT;

ALTER TABLE chunks ADD COLUMN top_folder TEXT;
ALTER TABLE chunks ADD COLUMN platform TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_category   ON documents (category);
CREATE INDEX IF NOT EXISTS idx_documents_top_folder ON documents (top_folder);
CREATE INDEX IF NOT EXISTS idx_documents_platform   ON documents (platform);

CREATE INDEX IF NOT EXISTS idx_chunks_category   ON chunks (category);
CREATE INDEX IF NOT EXISTS idx_chunks_top_folder ON chunks (top_folder);
CREATE INDEX IF NOT EXISTS idx_chunks_platform   ON chunks (platform);
