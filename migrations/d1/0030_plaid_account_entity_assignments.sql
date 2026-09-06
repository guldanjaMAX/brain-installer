-- 0030_plaid_account_entity_assignments
--
-- A Plaid Item can contain household, business, card, loan, and investment
-- accounts at the same institution.  Item-level configuration is therefore
-- not entity authority.  Each provider account must be assigned by an owner
-- before a staged sync window can promote or advance its cursor.
--
-- Provider ids remain internal. `account_ref` is the stable opaque identifier
-- the owner surface may use without disclosing either Plaid's Item id or its
-- account id.  Assignment writes reuse owner_action_requests for durable
-- request-id replay and owner_activity_events for one human-visible event.
--
-- The table is additive and independently restart-safe.

CREATE TABLE IF NOT EXISTS plaid_account_entity_assignments (
  tenant_id          TEXT NOT NULL DEFAULT 'primary',
  item_ref           TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_ref        TEXT NOT NULL,
  entity_slug        TEXT,
  discovered_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  assigned_at        TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (tenant_id, item_ref, provider_account_id),
  UNIQUE (tenant_id, account_ref),
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (account_ref GLOB 'acct_[0-9a-f]*' AND account_ref NOT GLOB '*[^a-z0-9_]*' AND length(account_ref) = 37),
  CHECK (entity_slug IS NULL OR (entity_slug GLOB '[a-z0-9]*' AND entity_slug NOT GLOB '*[^a-z0-9_-]*' AND length(entity_slug) BETWEEN 1 AND 64)),
  CHECK ((entity_slug IS NULL AND assigned_at IS NULL) OR (entity_slug IS NOT NULL AND assigned_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_plaid_account_entity_pending
  ON plaid_account_entity_assignments (tenant_id, item_ref)
  WHERE entity_slug IS NULL;

CREATE INDEX IF NOT EXISTS idx_plaid_account_entity_scope
  ON plaid_account_entity_assignments (tenant_id, entity_slug)
  WHERE entity_slug IS NOT NULL;
