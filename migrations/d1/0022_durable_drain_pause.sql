-- 0022_durable_drain_pause — the corpus pause becomes a fact the database holds.
--
-- WHY THE PAUSE MOVES INTO INSTALL_STATE
--
-- Until this migration the only record that a brain was paused for an upgrade
-- was a plain_text Worker binding, and a Workers deploy rewrites every
-- non-secret binding with whatever the deployer believed. keep_bindings
-- preserves secret_text ONLY. So the one flag protecting a half-migrated
-- corpus from live writers lived in the single place a routine deploy is
-- guaranteed to overwrite. One field install already had a pause outlive its
-- upgrade and flap; the worse case — a plain `brain deploy` on a stranded
-- install silently resuming writes over a half-migrated schema — was open and
-- simply had not been hit yet.
--
-- These three columns make install_state the record of truth. The binding
-- remains as the fast per-request gate the worker reads without a D1 round
-- trip; `brain deploy` now refuses to deploy active code while this record
-- (or an unfinished upgrade_runs row) says an upgrade is mid-flight.
--
-- THE NULL IS THE NORMAL STATE
--
-- vector_drain_pause is NULL on every healthy install and every fresh one.
-- 'paused-for-upgrade' is written by the paused compatibility deployment and
-- cleared only after an active deploy has actually uploaded. paused_at is the
-- moment the record was written; pause_run identifies what set it — an
-- upgrade run's started_at (the run's own upgrade_runs row does not exist
-- until the run finishes, so its start timestamp is the durable handle), or
-- rollback:<bookmark> for a supervised restore.
--
-- Pure ADD COLUMNs: independently resumable under the migration runner's
-- column-existence proof, because D1 commits per statement and a crash
-- mid-file must leave a schema the rerun can converge.

ALTER TABLE install_state ADD COLUMN vector_drain_pause TEXT;
ALTER TABLE install_state ADD COLUMN vector_drain_paused_at TEXT;
ALTER TABLE install_state ADD COLUMN vector_drain_pause_run TEXT;
