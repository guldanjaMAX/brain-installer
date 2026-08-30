-- 0026_plaid_durability
--
-- Plaid Link, Transactions Sync, webhook, reconciliation, and revocation state.
-- Provider payloads and plaintext tokens are deliberately absent. Short-lived
-- Link receipts use the same independent versioned wrapping-key contract as
-- Item access tokens. Transactions remain invisible in staging until one D1
-- batch promotes a complete has_more window and its final cursor together.

ALTER TABLE fin_accounts ADD COLUMN source_iso_currency_code TEXT;
ALTER TABLE fin_accounts ADD COLUMN source_unofficial_currency_code TEXT;

ALTER TABLE fin_transactions ADD COLUMN pending_transaction_id TEXT;
ALTER TABLE fin_transactions ADD COLUMN source_iso_currency_code TEXT;
ALTER TABLE fin_transactions ADD COLUMN source_unofficial_currency_code TEXT;
ALTER TABLE fin_transactions ADD COLUMN source_amount_decimal TEXT;
ALTER TABLE fin_transactions ADD COLUMN source_provider TEXT;
ALTER TABLE fin_transactions ADD COLUMN source_window_ref TEXT;
ALTER TABLE fin_transactions ADD COLUMN source_page_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_fin_transactions_pending_source
  ON fin_transactions (tenant_id, pending_transaction_id)
  WHERE pending_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plaid_link_operations (
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  session_ref TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL,
  item_ref TEXT,
  state TEXT NOT NULL,
  link_ciphertext TEXT,
  link_iv TEXT,
  link_key_version INTEGER,
  link_expires_at TEXT,
  public_token_fingerprint TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, session_ref),
  CHECK (mode IN ('connect', 'reauthorise')),
  CHECK (mode <> 'reauthorise' OR item_ref IS NOT NULL),
  CHECK (state IN ('new','link_create_started','link_ready','link_create_failed','link_completed','exchange_started','completed','manual_recovery')),
  CHECK (link_ciphertext IS NULL OR (link_ciphertext NOT GLOB '*-*' AND link_ciphertext NOT GLOB '* *')),
  CHECK ((link_ciphertext IS NULL) = (link_iv IS NULL)),
  CHECK (link_key_version IS NULL OR link_key_version >= 2),
  CHECK (receipt_json IS NULL OR json_valid(receipt_json))
);

CREATE INDEX IF NOT EXISTS idx_plaid_link_operations_open
  ON plaid_link_operations (tenant_id, updated_at)
  WHERE state NOT IN ('completed','manual_recovery');

CREATE TABLE IF NOT EXISTS plaid_sync_windows (
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  item_ref TEXT NOT NULL,
  window_ref TEXT NOT NULL,
  original_cursor TEXT,
  resume_cursor TEXT,
  next_page_index INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  modified_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  mutation_restarts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  PRIMARY KEY (tenant_id, item_ref),
  UNIQUE (tenant_id, window_ref),
  CHECK (state IN ('staging','ready','promoted','retryable','unavailable','refused')),
  CHECK (next_page_index >= 0 AND added_count >= 0 AND modified_count >= 0 AND removed_count >= 0),
  CHECK (mutation_restarts BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS plaid_sync_stage_accounts (
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  window_ref TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  mask TEXT,
  account_type TEXT NOT NULL,
  account_subtype TEXT,
  current_balance_decimal TEXT,
  available_balance_decimal TEXT,
  current_balance_minor INTEGER,
  available_balance_minor INTEGER,
  account_kind TEXT NOT NULL,
  balance_role TEXT NOT NULL,
  currency TEXT NOT NULL,
  iso_currency_code TEXT,
  unofficial_currency_code TEXT,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, window_ref, provider_account_id),
  CHECK (json_valid(provenance_json))
);

CREATE TABLE IF NOT EXISTS plaid_sync_stage_transactions (
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  window_ref TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  operation TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  pending_transaction_id TEXT,
  provider_account_id TEXT,
  account_slug TEXT,
  amount_decimal TEXT,
  amount_minor INTEGER,
  direction TEXT,
  iso_currency_code TEXT,
  unofficial_currency_code TEXT,
  posted_on TEXT,
  authorized_on TEXT,
  pending INTEGER,
  description TEXT,
  merchant_name TEXT,
  category_primary TEXT,
  category_detailed TEXT,
  provenance_json TEXT,
  PRIMARY KEY (tenant_id, window_ref, operation, provider_transaction_id),
  CHECK (page_index >= 0),
  CHECK (operation IN ('added','modified','removed')),
  CHECK (pending IS NULL OR pending IN (0,1)),
  CHECK (direction IS NULL OR direction IN ('inflow','outflow')),
  CHECK (provenance_json IS NULL OR json_valid(provenance_json))
);

CREATE INDEX IF NOT EXISTS idx_plaid_sync_stage_window
  ON plaid_sync_stage_transactions (tenant_id, window_ref, page_index);

CREATE TABLE IF NOT EXISTS plaid_webhook_events (
  delivery_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  item_ref TEXT,
  webhook_type TEXT,
  webhook_code TEXT,
  key_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK (length(body_sha256) = 64),
  CHECK (state IN ('accepted','replay','out_of_order','ignored'))
);

CREATE INDEX IF NOT EXISTS idx_plaid_webhook_item_time
  ON plaid_webhook_events (tenant_id, item_ref, issued_at DESC);

CREATE TABLE IF NOT EXISTS plaid_webhook_keys (
  key_id TEXT PRIMARY KEY,
  jwk_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (json_valid(jwk_json))
);

CREATE TABLE IF NOT EXISTS plaid_reconciliation (
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  item_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_ref),
  CHECK (state IN ('pending','running','retryable','complete','unavailable','refused')),
  CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_plaid_reconciliation_due
  ON plaid_reconciliation (state, due_at)
  WHERE state IN ('pending','retryable');

CREATE TABLE IF NOT EXISTS plaid_revocation_outbox (
  tenant_id TEXT NOT NULL DEFAULT 'primary',
  item_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY (tenant_id, item_ref),
  CHECK (state IN ('pending','retryable','confirmed','unavailable','refused')),
  CHECK (attempts >= 0),
  CHECK (state <> 'confirmed' OR confirmed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_plaid_revocation_due
  ON plaid_revocation_outbox (state, next_attempt_at)
  WHERE state IN ('pending','retryable');
