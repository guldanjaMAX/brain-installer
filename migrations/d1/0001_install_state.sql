-- 0001_install_state — version tracking for the install itself.
--
-- Without this table an upgrade cannot know what it is upgrading FROM, which
-- means every improvement has to be applied by hand per client. This one file
-- is what separates a product from twenty bespoke systems.
--
-- Single row, enforced by a CHECK on a constant primary key. There is exactly
-- one install per database and a second row would be a silent ambiguity.

CREATE TABLE IF NOT EXISTS install_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  client_slug       TEXT NOT NULL,
  product_version   TEXT NOT NULL,
  schema_version    INTEGER NOT NULL DEFAULT 0,
  gate_version      INTEGER NOT NULL DEFAULT 0,
  installed_at      TEXT NOT NULL,
  last_upgraded_at  TEXT,
  ring              TEXT NOT NULL DEFAULT 'stable',
  notes             TEXT
);

-- Applied migrations. The runner reads this to decide what is pending, so a
-- re-run is a no-op rather than a second application.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  checksum    TEXT NOT NULL
);

-- Upgrade history, including the failures.
--
-- `status` is one of: started | verified | failed | rolled_back.
--
-- A rolled_back run must NEVER be treated as the baseline for the next
-- upgrade. Promoting a reverted run would launder the anomaly into the new
-- normal and silence the brake permanently, which is the same failure the
-- indexer's tombstone guard exists to prevent.
CREATE TABLE IF NOT EXISTS upgrade_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  from_version    TEXT,
  to_version      TEXT,
  status          TEXT NOT NULL,
  d1_bookmark     TEXT,
  worker_version  TEXT,
  detail          TEXT
);

CREATE INDEX IF NOT EXISTS idx_upgrade_runs_started ON upgrade_runs(started_at DESC);
