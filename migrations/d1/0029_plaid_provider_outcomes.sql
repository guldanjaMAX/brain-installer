-- 0029_plaid_provider_outcomes
--
-- Preserve Plaid's own historical-readiness evidence instead of inferring a
-- completed backfill from an empty Transactions Sync page. Destructive Item
-- removal also records whether its provider outcome is known before another
-- one-shot call is considered.

ALTER TABLE bank_feed_backfill ADD COLUMN provider_history_state TEXT NOT NULL
  DEFAULT 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN'
  CHECK (provider_history_state IN (
    'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
    'NOT_READY',
    'INITIAL_UPDATE_COMPLETE',
    'HISTORICAL_UPDATE_COMPLETE'
  ));

ALTER TABLE plaid_sync_windows ADD COLUMN provider_history_state TEXT NOT NULL
  DEFAULT 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN'
  CHECK (provider_history_state IN (
    'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
    'NOT_READY',
    'INITIAL_UPDATE_COMPLETE',
    'HISTORICAL_UPDATE_COMPLETE'
  ));

ALTER TABLE plaid_revocation_outbox ADD COLUMN outcome_state TEXT NOT NULL
  DEFAULT 'unknown'
  CHECK (outcome_state IN ('not_attempted','not_removed','unknown','confirmed'));

UPDATE plaid_revocation_outbox
   SET outcome_state=CASE
     WHEN state='confirmed' THEN 'confirmed'
     WHEN attempts=0 THEN 'not_attempted'
     ELSE 'unknown'
   END
 WHERE outcome_state='unknown';
