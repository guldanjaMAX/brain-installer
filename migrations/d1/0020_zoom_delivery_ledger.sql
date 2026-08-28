-- 0020_zoom_delivery_ledger — a transcript Zoom announced becomes a debt, not a hope.
--
-- WHY THIS EXISTS. Zoom retries a slow or non-2xx webhook and disables an
-- endpoint that keeps failing, so the connector answers 200 fast and does the
-- real work afterwards. Everything expensive lives on the far side of that
-- acknowledgement: the OAuth token exchange, the recording lookup, the
-- transcript download, the credential gate and the store write. Until now a
-- failure there was a `console.warn` and a return. Zoom considers the delivery
-- complete and will never send it again, so the call simply was not in the
-- brain, and the only trace was a log line in a client's Cloudflare account
-- that nobody tails. The owner found out weeks later, if ever.
--
-- One row is written HERE, synchronously, before the 200 goes out. From that
-- moment the transcript is owed. The background attempt settles the row or
-- leaves it owed with its error; the drain cron that already runs every five
-- minutes on every D1 install retries what is still owed; and a debt that
-- outlives its grace window turns the `zoom` source's stale_reason on, which
-- the freshness surface already reports in `brain sources`, in `brain health`,
-- in acceptance, and in the gaps attached to every answer.
--
-- Keyed on the per-occurrence uuid, the same key the document is stored under
-- (`zoom:<uuid>`), so the ledger and the corpus cannot disagree about which
-- recording is which. A recurring meeting reuses one meeting id across every
-- occurrence; the uuid is the only identifier that names this call.
--
-- WHAT THIS TABLE STILL CANNOT SEE, said here rather than implied by silence:
-- it records deliveries Zoom MADE and this worker verified. A recording whose
-- webhook never arrived at all, or arrived while the worker was down and
-- exhausted Zoom's own retries, leaves no row here and no trace anywhere else.
-- Detecting that needs a poll of Zoom's own recordings list to diff against
-- this table, which needs a listing scope this connector does not ask for.
-- This table is the half of that comparison that did not exist before.
CREATE TABLE IF NOT EXISTS zoom_deliveries (
  -- The per-occurrence recording uuid, exactly as Zoom sent it.
  uuid            TEXT PRIMARY KEY,
  meeting_id      TEXT,
  -- Enough of the meeting to NAME it in a warning. "3 transcripts are missing"
  -- is an alarm; "the transcript for a call on 20 Aug is missing" is a thing
  -- the owner can act on.
  topic           TEXT,
  start_time      TEXT,
  host_email      TEXT,
  -- When the webhook was acknowledged. The age of the debt is measured from
  -- here, never from the last attempt, so a row that keeps failing cannot
  -- refresh its own way out of the overdue window.
  received_at     INTEGER NOT NULL,
  --   owed      the transcript is not in the brain and is still being retried
  --   stored    it landed (or the store reported it already had it)
  --   refused   the credential gate refused it: deliberate, terminal, visible
  --   abandoned retries are exhausted, or it can never be fetched now
  state           TEXT NOT NULL DEFAULT 'owed',
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- Earliest time the sweep may claim this row. Set past the inline attempt on
  -- insert so the cron cannot race the attempt that is already running.
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_error      TEXT,
  settled_at      INTEGER,
  CHECK (state IN ('owed', 'stored', 'refused', 'abandoned'))
);

-- The sweep's only query: due, owed work, oldest first.
CREATE INDEX IF NOT EXISTS idx_zoom_deliveries_due
  ON zoom_deliveries (state, next_attempt_at);

-- Retention pruning and the overdue check both read this.
CREATE INDEX IF NOT EXISTS idx_zoom_deliveries_received
  ON zoom_deliveries (received_at);
