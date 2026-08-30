-- 0002_llm_call_log — spend accounting for the daily cap.
--
-- The worker self-creates this table on first use so a fresh install cannot
-- 500 before its first migration runs. Declaring it here as well is deliberate
-- belt-and-braces: it means the schema is described in one readable place
-- instead of being an implementation detail buried in core.js, and it means a
-- client inspecting their own database can see what is stored about them.
--
-- CREATE TABLE IF NOT EXISTS makes the overlap harmless.

CREATE TABLE IF NOT EXISTS llm_call_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   TEXT NOT NULL,
  day                  TEXT NOT NULL,
  label                TEXT,
  model                TEXT,
  -- ok | error | blocked. `blocked` rows are calls the cap turned away; they
  -- are excluded from the SUM so a blocked call cannot itself push the day
  -- further over budget.
  status               TEXT,
  est_cost_usd_micros  INTEGER DEFAULT 0
);

-- The cap SUMs by day on every call, so this index is not optional.
CREATE INDEX IF NOT EXISTS idx_llm_call_log_day ON llm_call_log(day);
