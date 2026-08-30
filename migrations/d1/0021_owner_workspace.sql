-- Owner workspace writes and the one human-readable "What changed" history.
--
-- This migration deliberately does not add a second security audit stream.
-- Low-level authentication and authorization telemetry belongs in the security
-- tables introduced by the security workstream. The rows below are the bounded,
-- owner-facing record of successful product changes only.

-- Business scope is a document authority, not an inference from a legacy
-- client label. Existing rows stay NULL and therefore owner-only until an
-- explicit migration maps them. Retrieval joins chunks to this authoritative
-- document row, so a second denormalized chunks.entity_slug is unnecessary.
ALTER TABLE documents ADD COLUMN entity_slug TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_entity_slug ON documents (entity_slug);

-- One existing corpus row may be mapped only when the structured ledger has a
-- single live document row that names it. A free-form legacy `client` label is
-- never promoted to authority. Ambiguous and unmapped rows remain NULL.
UPDATE documents
   SET entity_slug = (
     SELECT MIN(fd.entity_slug)
       FROM fin_documents fd
      WHERE fd.corpus_doc_uid = documents.doc_uid
        AND fd.superseded_by_id IS NULL
        AND fd.entity_slug IS NOT NULL
   )
 WHERE entity_slug IS NULL
   AND doc_uid IN (
     SELECT corpus_doc_uid
       FROM fin_documents
      WHERE superseded_by_id IS NULL
        AND corpus_doc_uid IS NOT NULL
        AND entity_slug IS NOT NULL
      GROUP BY corpus_doc_uid
     HAVING COUNT(DISTINCT entity_slug) = 1
   );

CREATE TABLE IF NOT EXISTS owner_action_requests (
  tenant_id       TEXT NOT NULL DEFAULT 'primary',
  request_id      TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_json   TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id),
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128),
  CHECK (length(action_type) BETWEEN 1 AND 80),
  CHECK (length(request_hash) = 64),
  CHECK (response_status BETWEEN 200 AND 299)
);

CREATE TABLE IF NOT EXISTS owner_activity_events (
  event_id        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'primary',
  request_id      TEXT,
  event_type      TEXT NOT NULL,
  entity_slug     TEXT,
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  display_label   TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (request_id IS NULL OR (request_id GLOB '[A-Za-z0-9_-]*' AND request_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(request_id) BETWEEN 1 AND 128)),
  CHECK (event_type GLOB '[a-z0-9_]*' AND event_type NOT GLOB '*[^a-z0-9_]*' AND length(event_type) BETWEEN 1 AND 80),
  CHECK (entity_slug IS NULL OR (entity_slug GLOB '[a-z0-9]*' AND entity_slug NOT GLOB '*[^a-z0-9_-]*' AND length(entity_slug) BETWEEN 1 AND 64)),
  CHECK (length(subject_kind) BETWEEN 1 AND 80),
  CHECK (length(subject_id) BETWEEN 1 AND 180),
  CHECK (length(display_label) BETWEEN 1 AND 160)
);

CREATE INDEX IF NOT EXISTS idx_owner_activity_events_time
  ON owner_activity_events (tenant_id, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_owner_activity_events_entity_time
  ON owner_activity_events (tenant_id, entity_slug, occurred_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS owner_approvals (
  approval_id        TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL DEFAULT 'primary',
  request_id         TEXT NOT NULL,
  approval_type      TEXT NOT NULL,
  entity_slug        TEXT NOT NULL,
  subject_uid        TEXT NOT NULL,
  selected_claim_uid TEXT,
  resolution         TEXT,
  note               TEXT,
  recorded_at        TEXT NOT NULL,
  UNIQUE (tenant_id, request_id),
  CHECK (approval_type IN ('reconciliation_ruling', 'exception_resolution')),
  CHECK (length(subject_uid) BETWEEN 1 AND 180),
  CHECK (selected_claim_uid IS NULL OR length(selected_claim_uid) BETWEEN 1 AND 180),
  CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 500),
  CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_owner_approvals_subject
  ON owner_approvals (tenant_id, entity_slug, subject_uid, recorded_at DESC);

CREATE TABLE IF NOT EXISTS fin_period_closes (
  close_id                TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL DEFAULT 'primary',
  entity_slug             TEXT NOT NULL,
  period_start            TEXT NOT NULL,
  period_end              TEXT NOT NULL,
  status                  TEXT NOT NULL,
  evidence_state          TEXT NOT NULL,
  acknowledged_incomplete INTEGER NOT NULL DEFAULT 0,
  evidence_json           TEXT NOT NULL,
  note                    TEXT,
  accepted_at             TEXT,
  reopened_at             TEXT,
  updated_at              TEXT NOT NULL,
  UNIQUE (tenant_id, entity_slug, period_start, period_end),
  CHECK (status IN ('accepted', 'reopened')),
  CHECK (evidence_state IN ('complete', 'owner_acknowledged_incomplete')),
  CHECK (acknowledged_incomplete IN (0, 1)),
  CHECK (period_start GLOB '????-??-??' AND period_end GLOB '????-??-??' AND period_start <= period_end),
  CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_fin_period_closes_entity_period
  ON fin_period_closes (tenant_id, entity_slug, period_end DESC, period_start DESC);

CREATE TABLE IF NOT EXISTS owner_targets (
  target_row_id  TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL DEFAULT 'primary',
  entity_slug    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  label          TEXT NOT NULL,
  metric         TEXT NOT NULL,
  target_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  period_start   TEXT,
  period_end     TEXT,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT,
  UNIQUE (tenant_id, entity_slug, target_id),
  CHECK (target_id GLOB '[A-Za-z0-9_-]*' AND target_id NOT GLOB '*[^A-Za-z0-9_-]*' AND length(target_id) BETWEEN 1 AND 128),
  CHECK (length(label) BETWEEN 1 AND 160),
  CHECK (metric IN ('revenue', 'cash_reserve', 'spending_limit', 'debt_reduction', 'other')),
  CHECK (target_minor BETWEEN -9007199254740991 AND 9007199254740991),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  CHECK (period_start IS NULL OR period_start GLOB '????-??-??'),
  CHECK (period_end IS NULL OR period_end GLOB '????-??-??'),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
  CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  CHECK (status IN ('active', 'archived')),
  CHECK ((status = 'archived' AND archived_at IS NOT NULL) OR (status = 'active' AND archived_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_owner_targets_entity
  ON owner_targets (tenant_id, entity_slug, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS owner_preferences (
  preference_row_id TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  scope_key         TEXT NOT NULL,
  entity_slug       TEXT,
  preference_key    TEXT NOT NULL,
  value_json        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, scope_key, preference_key),
  CHECK ((entity_slug IS NULL AND scope_key = 'global') OR (entity_slug IS NOT NULL AND scope_key = entity_slug)),
  CHECK (preference_key IN ('default_entity', 'display_currency', 'fiscal_year_start_month', 'activity_window_days'))
);

CREATE INDEX IF NOT EXISTS idx_owner_preferences_scope
  ON owner_preferences (tenant_id, scope_key, preference_key);

-- The human history and approvals are evidence. Corrections append a new row;
-- no application path may rewrite or erase what the owner previously did.
CREATE TRIGGER IF NOT EXISTS owner_activity_events_no_update
BEFORE UPDATE ON owner_activity_events
BEGIN
  SELECT RAISE(ABORT, 'owner_activity_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS owner_activity_events_no_delete
BEFORE DELETE ON owner_activity_events
BEGIN
  SELECT RAISE(ABORT, 'owner_activity_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS owner_approvals_no_update
BEFORE UPDATE ON owner_approvals
BEGIN
  SELECT RAISE(ABORT, 'owner_approvals are append-only');
END;

CREATE TRIGGER IF NOT EXISTS owner_approvals_no_delete
BEFORE DELETE ON owner_approvals
BEGIN
  SELECT RAISE(ABORT, 'owner_approvals are append-only');
END;
