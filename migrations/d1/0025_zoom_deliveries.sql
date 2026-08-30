-- 0025_zoom_deliveries
--
-- A Zoom webhook is not acknowledged until its occurrence UUID is here. The
-- payload and transcript are deliberately absent: this table is durable work
-- debt, not a second corpus. Short compare-and-swap leases make a Worker crash
-- retryable, while the document store remains independently idempotent on the
-- recording UUID.

CREATE TABLE IF NOT EXISTS zoom_deliveries (
  recording_uuid TEXT PRIMARY KEY
    CHECK (length(recording_uuid) BETWEEN 1 AND 512),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('recording.completed', 'recording.transcript_completed')),
  meeting_id TEXT CHECK (meeting_id IS NULL OR length(meeting_id) BETWEEN 1 AND 100),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'processing', 'retryable', 'completed', 'refused', 'unavailable')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    OR
    (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
  ),
  CHECK (status <> 'completed' OR completed_at_ms IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_zoom_deliveries_due
  ON zoom_deliveries (next_attempt_at_ms, received_at_ms)
  WHERE status IN ('pending', 'retryable');

CREATE INDEX IF NOT EXISTS idx_zoom_deliveries_expired_lease
  ON zoom_deliveries (lease_expires_at_ms)
  WHERE status = 'processing';

-- The singleton cursor is checkpointed only after every recording UUID on the
-- page has been inserted above. A two-day overlap after a complete window makes
-- late transcripts and missed webhooks visible without an unbounded sweep.
CREATE TABLE IF NOT EXISTS zoom_reconciliation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL
    CHECK (status IN ('idle', 'processing', 'retryable', 'unavailable', 'refused')),
  window_from TEXT NOT NULL
    CHECK (window_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  next_page_token TEXT CHECK (next_page_token IS NULL OR length(next_page_token) BETWEEN 1 AND 2000),
  next_run_at_ms INTEGER NOT NULL CHECK (next_run_at_ms >= 0),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    OR
    (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
  )
);

INSERT INTO zoom_reconciliation
  (id,status,window_from,next_page_token,next_run_at_ms,lease_owner,
   lease_expires_at_ms,last_error_code,updated_at_ms,completed_at_ms)
VALUES
  (1,'idle',date('now','-30 day'),NULL,0,NULL,NULL,NULL,unixepoch('now') * 1000,NULL)
ON CONFLICT(id) DO NOTHING;
