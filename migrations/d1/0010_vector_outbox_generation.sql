-- 0010_vector_outbox_generation — queued_at is age, not revision identity.
--
-- Two writes in one millisecond can legitimately share queued_at. A drain that
-- selected the first write could therefore delete the second write's outbox
-- row after landing a stale vector, leaving backlog zero. Keep time for queue
-- ordering, but give every enqueue a database-owned monotonic generation that
-- survives deletion and recreation of an individual outbox row.

ALTER TABLE install_state
  ADD COLUMN outbox_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vector_outbox
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- Existing queued work receives stable nonzero generations before the triggers
-- begin assigning new values. The install row already exists on every deployed
-- brain; a missing row makes later trigger writes fail closed instead of issuing
-- an unversioned queue receipt.
UPDATE vector_outbox SET generation = rowid WHERE generation = 0;

UPDATE install_state
   SET outbox_generation = MAX(
     outbox_generation,
     COALESCE((SELECT MAX(generation) FROM vector_outbox), 0)
   )
 WHERE id = 1;

CREATE INDEX IF NOT EXISTS idx_vector_outbox_generation
  ON vector_outbox (generation);

CREATE TRIGGER IF NOT EXISTS vector_outbox_generation_ai
AFTER INSERT ON vector_outbox
BEGIN
  UPDATE install_state
     SET outbox_generation = MAX(
       outbox_generation,
       COALESCE((SELECT MAX(generation) FROM vector_outbox), 0)
     ) + 1
   WHERE id = 1;
  UPDATE vector_outbox
     SET generation = (SELECT outbox_generation FROM install_state WHERE id = 1)
   WHERE chunk_uid = NEW.chunk_uid;
END;

-- Enqueue upserts always name at least one of these columns. Retry bookkeeping
-- updates only attempts/last_error and therefore retains the observed token.
CREATE TRIGGER IF NOT EXISTS vector_outbox_generation_au
AFTER UPDATE OF vector_id, op, queued_at ON vector_outbox
BEGIN
  UPDATE install_state
     SET outbox_generation = MAX(
       outbox_generation,
       COALESCE((SELECT MAX(generation) FROM vector_outbox), 0)
     ) + 1
   WHERE id = 1;
  UPDATE vector_outbox
     SET generation = (SELECT outbox_generation FROM install_state WHERE id = 1)
   WHERE chunk_uid = NEW.chunk_uid;
END;
