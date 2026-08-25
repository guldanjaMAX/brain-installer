-- 0011_vector_drain_lease — serialize derived-index writers.
--
-- Vectorize does not offer a conditional upsert. Generation-CAS protects the
-- D1 receipt, but two drain invocations could still land their vector writes
-- out of order. Keep one expiring owner in the durable install row so cron and
-- manual drains cannot write Vectorize concurrently. A crashed owner is
-- recoverable after the bounded expiry; release always compares the owner.

ALTER TABLE install_state
  ADD COLUMN vector_drain_lease_owner TEXT;

ALTER TABLE install_state
  ADD COLUMN vector_drain_lease_expires_at INTEGER;

-- SQLite backfills both nullable columns as NULL. No UPDATE is needed here:
-- omitting it also makes a restart after either ALTER safe without clearing a
-- lease that a newly deployed Worker may already own.
