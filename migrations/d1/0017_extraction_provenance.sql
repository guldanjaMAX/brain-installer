-- 0017_extraction_provenance — how the text got here, promoted to a real column
-- so it can reach a citation.
--
-- WHY A COLUMN AND NOT A `meta` KEY
--
-- `documents.meta` is free-form JSON and is persisted faithfully, so putting
-- `{ ocr: true }` there satisfies the letter of "flag it" and fails the point
-- of it completely. Both retrieval queries in store-d1.js join `documents` and
-- select a FIXED column list, and the citation object is built from that list.
-- A flag in `meta` would sit in D1 and never appear next to the sentence it
-- produced, which is exactly the case that matters: a reader looking at an
-- answer needs to know whether the evidence under it was read from a text
-- layer or guessed at from a picture of a page.
--
-- `date_source` and `date_reliable` are the precedent, and they exist for the
-- same reason: date trust travels with retrieval because trust that does not
-- travel is not trust. This is the same shape for text trust.
--
-- text_source is one of:
--   native      the file carried its own text layer (the default, and what
--               every document written before this migration was)
--   ocr         every page was read from an image by a model
--   ocr_partial some pages were read and some could not be, with the failures
--               named inline in the text rather than dropped
--
-- text_reliable defaults to 1 and is set to 0 for anything OCR'd. That is not
-- a slur on the model; it is the honest default for text that is a machine's
-- reading of a photograph. An answer resting on it says so.
--
-- Backfill is deliberately absolute rather than conditional: every row that
-- exists at this point was extracted before OCR was possible, so `native` is a
-- statement of fact about them, not an assumption.

ALTER TABLE documents ADD COLUMN text_source TEXT DEFAULT 'native';
ALTER TABLE documents ADD COLUMN text_reliable INTEGER DEFAULT 1;

UPDATE documents SET text_source = 'native' WHERE text_source IS NULL;
UPDATE documents SET text_reliable = 1 WHERE text_reliable IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_text_source ON documents (text_source);
