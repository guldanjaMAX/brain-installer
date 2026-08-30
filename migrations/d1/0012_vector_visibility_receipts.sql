-- 0012_vector_visibility_receipts — provider acceptance is not visibility.
--
-- Vectorize V2 mutations are asynchronous. Its binding returns a mutation id
-- when a changeset is accepted, before queries or getByIds can observe it. Keep
-- that receipt on every affected outbox row and keep the latest accepted
-- changeset as a global ordering fence. A row leaves the outbox only after the
-- fence is processed and the exact vector generation (or deletion) is visible.

ALTER TABLE install_state
  ADD COLUMN vector_projection_mutation_id TEXT;

ALTER TABLE install_state
  ADD COLUMN vector_projection_submitted_at INTEGER;

-- Count parity is not proof that a legacy index contains the current vectors.
-- Existing corpora enter a resumable, epoch-fenced bootstrap. The migration
-- never materializes the corpus in vector_outbox: the active Worker advances
-- this cursor in bounded pages and drains each page before queuing the next.
-- A fresh install is empty when its later install_state seed receives the
-- verified default; its first enqueue trigger immediately changes it to pending.
ALTER TABLE install_state
  ADD COLUMN vector_projection_status TEXT NOT NULL DEFAULT 'verified';

ALTER TABLE install_state
  ADD COLUMN vector_projection_bootstrap_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE install_state
  ADD COLUMN vector_projection_bootstrap_cursor TEXT;

ALTER TABLE install_state
  ADD COLUMN vector_projection_bootstrap_high_water TEXT;

UPDATE install_state
   SET vector_projection_status = CASE
         WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END,
       vector_projection_bootstrap_epoch = CASE
         WHEN EXISTS (SELECT 1 FROM chunks) THEN 1 ELSE 0 END,
       vector_projection_bootstrap_cursor = NULL,
       vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks)
 WHERE schema_version < 12
   AND vector_projection_bootstrap_epoch = 0
   AND vector_projection_bootstrap_cursor IS NULL;

ALTER TABLE vector_outbox
  ADD COLUMN submitted_mutation_id TEXT;

ALTER TABLE vector_outbox
  ADD COLUMN submitted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_vector_outbox_submitted
  ON vector_outbox (submitted_mutation_id, queued_at);

-- Recreate the generation triggers so every newer enqueue invalidates an older
-- provider receipt. DROP/CREATE is safe here because update deploys a paused
-- writer before migrations, and every statement is restart-safe and idempotent.
DROP TRIGGER IF EXISTS vector_outbox_generation_ai;

CREATE TRIGGER IF NOT EXISTS vector_outbox_generation_ai
AFTER INSERT ON vector_outbox
BEGIN
  UPDATE install_state
     SET outbox_generation = MAX(
       outbox_generation,
       COALESCE((SELECT MAX(generation) FROM vector_outbox), 0)
     ) + 1,
         vector_projection_status = CASE
           WHEN vector_projection_status = 'bootstrap_required'
             THEN 'bootstrap_required' ELSE 'pending' END
   WHERE id = 1;
  UPDATE vector_outbox
     SET generation = (SELECT outbox_generation FROM install_state WHERE id = 1),
         submitted_mutation_id = NULL,
         submitted_at = NULL
   WHERE chunk_uid = NEW.chunk_uid;
END;

DROP TRIGGER IF EXISTS vector_outbox_generation_au;

-- Enqueue upserts always name at least one of these columns. Updates that only
-- record a submission receipt, attempt, or error retain the observed generation.
CREATE TRIGGER IF NOT EXISTS vector_outbox_generation_au
AFTER UPDATE OF vector_id, op, queued_at ON vector_outbox
BEGIN
  UPDATE install_state
     SET outbox_generation = MAX(
       outbox_generation,
       COALESCE((SELECT MAX(generation) FROM vector_outbox), 0)
     ) + 1,
         vector_projection_status = CASE
           WHEN vector_projection_status = 'bootstrap_required'
             THEN 'bootstrap_required' ELSE 'pending' END
   WHERE id = 1;
  UPDATE vector_outbox
     SET generation = (SELECT outbox_generation FROM install_state WHERE id = 1),
         submitted_mutation_id = NULL,
         submitted_at = NULL
   WHERE chunk_uid = NEW.chunk_uid;
END;
