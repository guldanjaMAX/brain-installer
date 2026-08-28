-- 0016_bank_feed — connector state for the hosted read-only bank feed.
--
-- WHY THIS IS A SEPARATE MIGRATION FROM THE LEDGER
--
-- 0015 holds financial FACTS. This file holds the plumbing that fetches them:
-- which banks the owner connected, where each connection has read up to, and
-- the encrypted reference that lets the worker ask for more. None of that is a
-- financial fact and none of it belongs in `fin_*`.
--
-- The separation is not tidiness. `fin_*` is exported by the recovery adapter,
-- read by the answer path, and mirrored into snapshots. A credential in there
-- would ride along with all three. Keeping the two apart means a table dump of
-- the ledger cannot leak a bank connection, and it means the ledger stays
-- provider-agnostic: the same rows arrive from a downloaded OFX file and from
-- this feed, and nothing downstream can tell or needs to.
--
-- WHAT THE OWNER ACTUALLY AUTHORISES
--
-- The account holder completes the authorisation themselves, in their own
-- browser, on their own bank's website or the aggregator's hosted screen. No
-- password, no one-time code, and no bank credential is ever seen, handled,
-- requested, or stored by the operator, by this worker, or by anyone else. What
-- comes back is a read-only reference for fetching transaction history, and it
-- lives here, in the client's own database, inside the client's own account.
--
-- The reference is stored ENCRYPTED (AES-GCM, key derived from a worker secret
-- the database does not contain). A D1 export, a backup, or a careless admin
-- route therefore cannot hand anyone a working bank connection. The CHECK on
-- `access_ciphertext` is a structural guard on that promise: ciphertext is
-- base64 and base64 has no hyphen, so a value carrying one is a plaintext
-- reference and the database refuses it outright.
--
-- Every statement is independently idempotent: CREATE TABLE IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS only, no ALTER, no triggers. D1's REST endpoint
-- commits per statement, so a crash mid-file must leave a resumable schema.

-- ------------------------------------------------------------------ items --
--
-- One row per connected institution. `item_ref` is the provider's own
-- identifier for the connection: an id, never a credential.
CREATE TABLE IF NOT EXISTS bank_feed_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  item_ref          TEXT NOT NULL,
  institution_ref   TEXT,
  institution_label TEXT,
  -- The read-only access reference, encrypted. Never a plaintext value; never
  -- returned by any route; never written to a log line or an error field.
  access_ciphertext TEXT NOT NULL,
  access_iv         TEXT NOT NULL,
  -- Which derived key encrypted it, so the key can be rotated without a
  -- flag day and without guessing which rows are readable.
  key_version       INTEGER NOT NULL DEFAULT 1,
  -- `sandbox` exists so an install can be rehearsed the same day, before the
  -- client's production approval lands. A sandbox row must never be mistaken
  -- for a real connection, so the environment is stored on the row itself.
  environment       TEXT NOT NULL,
  -- Where the incremental read has got to. Committed after EVERY page, not at
  -- the end of a run: a long first load killed by the clock must resume, not
  -- restart, or it can never finish at all.
  cursor            TEXT,
  cursor_updated_at TEXT,
  -- An item that needs re-authorisation is not a failed sync, it is a brain
  -- that has silently stopped seeing money move. It gets a state of its own so
  -- health and the answer path can say so.
  status            TEXT NOT NULL DEFAULT 'connected',
  status_detail     TEXT,
  consent_expires_at TEXT,
  connected_at      TEXT NOT NULL,
  last_synced_at    TEXT,
  last_error_at     TEXT,
  removed_at        TEXT,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (environment IN ('sandbox', 'production')),
  CHECK (status IN ('connected', 'reauth_required', 'permission_revoked', 'error', 'removed')),
  -- A status that is not plainly good must say what is wrong, in words, or the
  -- state is undiagnosable from the row alone.
  CHECK (status = 'connected' OR status_detail IS NOT NULL),
  CHECK (status <> 'removed' OR removed_at IS NOT NULL),
  -- The plaintext guard. Base64 has no hyphen and no space.
  CHECK (access_ciphertext NOT GLOB '*-*' AND access_ciphertext NOT GLOB '* *'),
  CHECK (length(access_ciphertext) >= 16),
  CHECK (access_iv NOT GLOB '*-*' AND length(access_iv) BETWEEN 8 AND 64),
  CHECK (key_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_feed_items
  ON bank_feed_items (tenant_id, item_ref);
CREATE INDEX IF NOT EXISTS idx_bank_feed_items_live
  ON bank_feed_items (tenant_id, status) WHERE removed_at IS NULL;

-- --------------------------------------------------------------- backfill --
--
-- The first load is two years of history across every account on a connection.
-- Running it inline would hold a browser open on a request that cannot finish
-- inside one invocation, and would then restart from the beginning every time
-- the clock killed it. So it is QUEUED here and drained in bounded slices, and
-- this table is what the operator's progress report reads.
CREATE TABLE IF NOT EXISTS bank_feed_backfill (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  item_ref          TEXT NOT NULL,
  requested_days    INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'queued',
  pages_done        INTEGER NOT NULL DEFAULT 0,
  transactions_seen INTEGER NOT NULL DEFAULT 0,
  unread_lines      INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  queued_at         TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  -- A message safe to show a person: never a credential, never a raw provider
  -- payload, never the request body that produced it.
  last_error        TEXT,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (state IN ('queued', 'running', 'complete', 'failed')),
  CHECK (requested_days BETWEEN 1 AND 2000),
  CHECK (pages_done >= 0 AND transactions_seen >= 0 AND unread_lines >= 0 AND attempts >= 0),
  CHECK (state <> 'complete' OR finished_at IS NOT NULL),
  CHECK (state <> 'failed' OR last_error IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_feed_backfill
  ON bank_feed_backfill (tenant_id, item_ref);
CREATE INDEX IF NOT EXISTS idx_bank_feed_backfill_pending
  ON bank_feed_backfill (tenant_id, state) WHERE state IN ('queued', 'running');

-- ---------------------------------------------------------- link sessions --
--
-- One row per authorisation attempt the owner starts. It exists for exactly two
-- reasons: the redirect leg of a bank's own OAuth flow returns the browser to
-- this brain and the session has to be recognisable when it does, and an
-- abandoned attempt must expire rather than sit around being resumable forever.
--
-- It holds NO token. The short-lived handoff value never touches the database.
CREATE TABLE IF NOT EXISTS bank_feed_link_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  session_ref       TEXT NOT NULL,
  mode              TEXT NOT NULL DEFAULT 'connect',
  -- Set only for a re-authorisation, which reuses the EXISTING connection
  -- rather than creating a second one.
  item_ref          TEXT,
  redirect_uri      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  consumed_at       TEXT,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (mode IN ('connect', 'reauthorise')),
  CHECK (mode <> 'reauthorise' OR item_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_feed_link_sessions
  ON bank_feed_link_sessions (tenant_id, session_ref);
CREATE INDEX IF NOT EXISTS idx_bank_feed_link_sessions_open
  ON bank_feed_link_sessions (tenant_id, expires_at) WHERE consumed_at IS NULL;
