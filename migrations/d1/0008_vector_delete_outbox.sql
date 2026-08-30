-- 0008_vector_delete_outbox — deletions must be retryable too.
--
-- D1 is the system of record, so a deleted chunk becomes unreachable as soon
-- as its D1 row is gone. Its Vectorize id must survive that deletion in the
-- outbox, however, or a transient Vectorize failure leaves a permanent orphan
-- competing for one of the limited retrieval candidates.

ALTER TABLE vector_outbox ADD COLUMN vector_id TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_op_queued
  ON vector_outbox (op, queued_at);
