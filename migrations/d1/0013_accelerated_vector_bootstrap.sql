-- 0013_accelerated_vector_bootstrap — exact legacy verification at provider scale.
--
-- Schema 0012 deliberately re-projects every legacy chunk, but its 99-row
-- cursor made provider visibility latency the throughput ceiling.  Bulk-v2
-- keeps the same exact-generation proof while allowing three disjoint,
-- durable 1,000-row mutations to be in flight during the paused upgrade.

ALTER TABLE install_state
  ADD COLUMN vector_projection_bootstrap_protocol TEXT;

ALTER TABLE install_state
  ADD COLUMN vector_projection_bootstrap_base_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vector_outbox
  ADD COLUMN bootstrap_epoch INTEGER;

ALTER TABLE vector_outbox
  ADD COLUMN bootstrap_batch INTEGER;

CREATE INDEX IF NOT EXISTS idx_vector_outbox_bootstrap_batch
  ON vector_outbox (bootstrap_epoch, bootstrap_batch, submitted_mutation_id);

CREATE TABLE IF NOT EXISTS vector_bootstrap_batches (
  epoch          INTEGER NOT NULL,
  batch_no       INTEGER NOT NULL,
  start_cursor   TEXT NOT NULL,
  end_cursor     TEXT NOT NULL,
  row_count      INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 1000),
  status         TEXT NOT NULL CHECK (status IN ('queued','submitted','confirmed')),
  mutation_id    TEXT,
  submitted_at   INTEGER,
  confirmed_at   INTEGER,
  PRIMARY KEY (epoch, batch_no),
  UNIQUE (epoch, start_cursor),
  UNIQUE (epoch, end_cursor),
  CHECK (
    (status = 'queued' AND mutation_id IS NULL AND submitted_at IS NULL AND confirmed_at IS NULL) OR
    (status = 'submitted' AND mutation_id IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NULL) OR
    (status = 'confirmed' AND mutation_id IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vector_bootstrap_batches_status
  ON vector_bootstrap_batches (epoch, status, batch_no);

-- A schema-12 projection that was already verified has already paid for the
-- same exact-generation readback this protocol requires. Preserve that proof
-- as the v2 base instead of needlessly re-embedding a healthy corpus. An old
-- pending outbox deliberately leaves the protocol unset so the paused Worker
-- drains and confirms those rows before adopting the verified cut.
UPDATE install_state
   SET vector_projection_bootstrap_protocol = CASE
         WHEN NOT EXISTS (SELECT 1 FROM vector_outbox) THEN 'bootstrap-v2'
         ELSE NULL
       END,
       vector_projection_bootstrap_base_count = (SELECT count(*) FROM chunks)
 WHERE vector_projection_status = 'verified';

-- A post-bootstrap enqueue must detach the row from any old bulk receipt.
-- Bulk-v2 therefore tags a freshly inserted range in a separate statement,
-- after this trigger has assigned its generation.
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
         submitted_at = NULL,
         bootstrap_epoch = NULL,
         bootstrap_batch = NULL
   WHERE chunk_uid = NEW.chunk_uid;
END;

DROP TRIGGER IF EXISTS vector_outbox_generation_au;

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
         submitted_at = NULL,
         bootstrap_epoch = NULL,
         bootstrap_batch = NULL
   WHERE chunk_uid = NEW.chunk_uid;
END;
