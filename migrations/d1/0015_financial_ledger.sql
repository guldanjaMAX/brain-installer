-- 0015_financial_ledger — the structured financial layer, in the client's own D1.
--
-- WHY THIS EXISTS
--
-- Fourteen migrations built a document corpus: text, chunks, keyword search,
-- source receipts, vector projection. A financial document ingested through
-- that path becomes searchable prose and nothing else. Prose cannot be added
-- up, cannot be compared against a bank feed, and cannot say which of two
-- disagreeing figures is which. So a client-facing screen that shows "what you
-- hold", "what is still missing for the month", or "these two sources disagree"
-- has nothing to read, and a clean install on a new household completes
-- successfully and opens an empty product. Nothing errors. There is simply
-- nothing in it.
--
-- These tables are the missing half. They hold financial FACTS, each one
-- traceable to the document or feed it came from.
--
-- THE SHAPE IS DERIVED, NOT INVENTED
--
-- Every table and nearly every enum here answers to a screen that already
-- exists in the client UI, and to the translation layer that already reads a
-- snapshot: the account coverage vocabulary, the deadline status and urgency
-- vocabularies, the exception fields, the open-item fields and the per-document
-- custody facts are the names that layer already consumes. Where this schema
-- adds a value the UI does not yet have (`unparsed`), it is because the UI has
-- no way to say "I could not read this", and inventing a number instead is the
-- single worst thing a financial system can do.
--
-- FIVE PROPERTIES THIS SCHEMA IS BUILT TO GUARANTEE
--
-- 1. TENANT ON EVERY TABLE, FROM THE FIRST MIGRATION. The recommended
--    deployment is one brain per client, which needs no tenant column at all.
--    It is here anyway, and every read filters on it, because the alternative
--    is a migration on a live financial ledger later. It costs nothing now.
--    Today every row carries 'primary'.
--
-- 2. PROVENANCE ON EVERY FACT. A figure whose origin cannot be named is not
--    evidence, it is a rumour with a dollar sign. Four origins are allowed and
--    two of them are constrained by the database rather than by convention: an
--    `extracted` row cannot exist without the document it was read from, and a
--    `feed` row cannot exist without naming the feed. The feed name doubles as
--    the scope key, so one equality match removes everything a connector wrote,
--    the same property `sources.name` gives the corpus.
--
-- 3. AN EXPLICIT UNPARSED STATE. `basis_state = 'unparsed'` means the extractor
--    could not read it. The CHECK constraints make that state incompatible with
--    carrying a figure: you cannot store a number you could not read. This is
--    the whole difference between a system that says "I could not read this"
--    and one that guesses.
--
-- 4. INTEGER MINOR UNITS, NEVER FLOATS, WITH THE CURRENCY. Every amount column
--    ends in `_minor` and every table that holds one names its currency. A
--    binary float cannot represent a cent, and a ledger that rounds is a ledger
--    that disagrees with a bank.
--
-- 5. RECONCILIATION AS A STATE, NOT A WINNER. The same account, the same
--    period, from two sources, is two rows and one comparison. The comparison
--    has its own state and can rest at `mismatched`. Nothing collapses to one
--    side, and an owner's ruling is recorded beside both figures rather than
--    overwriting either.
--
-- SUPERSESSION, NOT UPDATE
--
-- An owner-stated fact from the pre-install interview ("three business accounts,
-- opened around 2019") is useful and it is not evidence. When the real document
-- arrives it does not overwrite that row, it supersedes it: the new row is
-- written and the old one records who replaced it. `superseded_by_id IS NULL`
-- is the live-row predicate everywhere, enforced by a partial unique index on
-- each table's stable key. The chain is walkable backwards from the new row, so
-- the correction keeps its why.
--
-- NO FOREIGN KEYS ACROSS THESE TABLES, DELIBERATELY
--
-- Cross-table links use the stable text key (an entity slug, an account slug, a
-- document uid), not the integer rowid, because a superseding row is a NEW rowid
-- and every reference to the old one would dangle. SQLite cannot express
-- "references the live row of this key", so the join predicate lives in the read
-- path where it can be tested. `ON DELETE CASCADE` is additionally unwanted here:
-- financial history is tombstoned, never deleted.
--
-- DATES ARE CALENDAR TEXT, NOT EPOCH INTEGERS
--
-- The corpus stores instants as epoch milliseconds. A statement period boundary
-- is not an instant, it is a calendar fact, and folding one into a timezone-bearing
-- integer is how a July statement becomes a June one for anybody east of UTC. Every
-- date here is ISO-8601 TEXT, constrained in shape, and lexicographic comparison is
-- therefore chronological comparison.
--
-- EVERY STATEMENT IN THIS FILE IS INDEPENDENTLY IDEMPOTENT. D1's REST endpoint
-- commits per statement, so a crash mid-file must leave a resumable database.
-- CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS only; no ALTER, and
-- no triggers, whose bodies are the one shape the statement splitter has
-- historically shredded.

-- ---------------------------------------------------------------- entities --
--
-- The entity map. Every other table hangs off a slug from here, because nearly
-- every financial category repeats per entity: one household with a business and
-- a rental already needs it, and an owner with sixteen locations across company
-- owned and franchised cannot be expressed without it at all. Adding this later
-- is a rewrite, so it is here first.
--
-- `relationship` exists because a counterparty is in the ledger for a reason
-- that is not ownership: the buyer of a sold business who still owes on the
-- note belongs in the records and does not belong in a list headed "your
-- businesses".
CREATE TABLE IF NOT EXISTS fin_entities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  -- The scope key. Constrained the same way `sources.name` is, and for the same
  -- reason: it is matched by equality in deletes and filters, so a value with a
  -- quote or a wildcard in it could reach outside its own scope.
  entity_slug       TEXT NOT NULL,
  legal_name        TEXT NOT NULL,
  -- What the owner calls it. Kept apart from the legal name because a screen
  -- showing "Maple Street Holdings LLC" where the owner says "the cafe" is a
  -- screen they have to translate.
  display_label     TEXT,
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  relationship      TEXT NOT NULL DEFAULT 'owned',
  -- One sentence saying why this entity is in the brain at all.
  holds             TEXT,
  parent_entity_slug TEXT,
  -- Basis points, so a half percent is 50 and nothing is ever a float. NULL is
  -- "nobody has stated it", which is different from zero.
  ownership_bp      INTEGER,
  tax_class         TEXT,
  -- The scopes every client has and cannot remove.
  fixed_scope       INTEGER NOT NULL DEFAULT 0,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (entity_slug GLOB '[a-z0-9]*' AND entity_slug NOT GLOB '*[^a-z0-9_-]*' AND length(entity_slug) BETWEEN 1 AND 64),
  CHECK (kind IN ('person', 'household', 'trust', 'business', 'property', 'investment')),
  CHECK (status IN ('active', 'sold', 'dissolved', 'closed')),
  CHECK (relationship IN ('owned', 'counterparty')),
  CHECK (fixed_scope IN (0, 1)),
  CHECK (ownership_bp IS NULL OR ownership_bp BETWEEN 0 AND 10000),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_entities_live
  ON fin_entities (tenant_id, entity_slug) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_entities_replaced ON fin_entities (superseded_by_id);

-- ---------------------------------------------------------------- accounts --
--
-- `balance_role` is the column that stops the product inflating a client's net
-- worth by the size of their debts. A card and a loan arrive from a bank feed
-- through the same call as a checking account, and their balance is money owed,
-- not money held. It is NOT NULL so the writer has to state it, and a card or a
-- loan is refused as an asset by CHECK rather than by a code path somebody can
-- forget. The client-facing consequence is already written into the product's
-- own answer copy: cards are money you owe, not money you hold, and they are
-- never in a cash figure.
--
-- `mask` is the last four digits at most. Full account and routing numbers are
-- not stored, because the connector product that returns them is deliberately
-- never requested; a ledger holding them is a materially different thing to
-- lose.
CREATE TABLE IF NOT EXISTS fin_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  account_slug      TEXT NOT NULL,
  entity_slug       TEXT NOT NULL,
  institution       TEXT,
  label             TEXT,
  account_kind      TEXT NOT NULL,
  balance_role      TEXT NOT NULL,
  mask              TEXT,
  currency          TEXT NOT NULL DEFAULT 'USD',
  -- How records arrive. `none` is honest and common: an account nobody has
  -- connected and nobody loads by hand.
  feed_mode         TEXT NOT NULL DEFAULT 'manual',
  -- NULL means no refresh expectation has been set, and therefore NO staleness
  -- claim is made about this account either way. That is the honest default and
  -- it is deliberately not an enum value, matching how the corpus treats a
  -- one-off upload.
  expected_cadence  TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  opened_on         TEXT,
  closed_on         TEXT,
  -- The connector's own identifier for this account. An id, never a credential;
  -- access tokens live in connector-owned tables and never here.
  external_ref      TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (account_slug GLOB '[a-z0-9]*' AND account_slug NOT GLOB '*[^a-z0-9_-]*' AND length(account_slug) BETWEEN 1 AND 64),
  CHECK (account_kind IN ('checking', 'savings', 'card', 'loan', 'line_of_credit',
                          'investment', 'retirement', 'merchant', 'point_of_sale',
                          'escrow', 'other')),
  CHECK (balance_role IN ('asset', 'liability', 'neither')),
  -- Money owed cannot be recorded as money held.
  CHECK (account_kind NOT IN ('card', 'loan', 'line_of_credit') OR balance_role = 'liability'),
  CHECK (mask IS NULL OR (length(mask) <= 4 AND mask NOT GLOB '*[^0-9X*x]*')),
  CHECK (feed_mode IN ('live', 'manual', 'none')),
  CHECK (expected_cadence IS NULL OR expected_cadence IN ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  CHECK (status IN ('open', 'closed', 'never_connected')),
  CHECK (opened_on IS NULL OR opened_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (closed_on IS NULL OR closed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_accounts_live
  ON fin_accounts (tenant_id, account_slug) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_accounts_entity ON fin_accounts (tenant_id, entity_slug);
CREATE INDEX IF NOT EXISTS idx_fin_accounts_feed ON fin_accounts (tenant_id, source_feed);

-- ------------------------------------------------------- account coverage --
--
-- How much of an account's history the brain actually holds, which is a
-- different question from how recently anything was read. Two of the six states
-- are declarations rather than derivations and that is exactly why this is a
-- table: `indirect` (this account is covered through another account's records,
-- not its own) and `not_applicable` (there is nothing to collect here) cannot be
-- computed from what has arrived, because they are statements about what will
-- never arrive.
--
-- The `covered_to` date is required whenever coverage is claimed to be complete
-- or partial. A coverage claim with no date is the exact shape of an
-- overclaim: it reads as currency and proves nothing.
CREATE TABLE IF NOT EXISTS fin_account_coverage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  account_slug      TEXT NOT NULL,
  coverage_status   TEXT NOT NULL,
  covered_from      TEXT,
  covered_to        TEXT,
  -- Required when `indirect`: which account's records do the covering.
  covered_via_account_slug TEXT,
  -- Plain sentence for the client, saying what is missing and why. Never an
  -- internal state token.
  basis_note        TEXT,
  computed_at       TEXT NOT NULL,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (coverage_status IN ('complete', 'indirect', 'partial', 'missing', 'not_applicable', 'closed')),
  CHECK (coverage_status <> 'indirect' OR covered_via_account_slug IS NOT NULL),
  CHECK (coverage_status NOT IN ('complete', 'partial') OR covered_to IS NOT NULL),
  CHECK (covered_from IS NULL OR covered_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (covered_to IS NULL OR covered_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (covered_from IS NULL OR covered_to IS NULL OR covered_to >= covered_from),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_account_coverage_live
  ON fin_account_coverage (tenant_id, account_slug) WHERE superseded_by_id IS NULL;

-- --------------------------------------------------------------- documents --
--
-- The financial-document index. This is NOT a second copy of the corpus
-- `documents` table: that one holds text to search, this one holds what a
-- document PROVES. `corpus_doc_uid` is the join between them and is nullable,
-- because a document can be known to exist without its text being in the brain,
-- and a client is better served by "the 2024 return is with your accountant and
-- takes about a week to get" than by silence.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: a client-facing status word. The
-- product's finished states, "Filed" and "Current", are two different finished
-- states and both are derivations over stored facts, not columns a connector
-- writes. Writing the word would make a script's success look like a custody
-- guarantee. So the FACTS behind the words live here (`custody_class`,
-- `filed_at`, `reconciled_through`, `readable`) and the word is computed at read
-- time, where the derivation can be tested.
--
-- `availability` is the owner's own vocabulary from the pre-install interview,
-- which happens before any file does: have it, can get it, do not have it. "Do
-- not have it" is a real and useful answer, not a failure.
CREATE TABLE IF NOT EXISTS fin_documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  fin_doc_uid       TEXT NOT NULL,
  entity_slug       TEXT,
  account_slug      TEXT,
  doc_kind          TEXT NOT NULL,
  title             TEXT NOT NULL,
  tax_year          INTEGER,
  period_start      TEXT,
  period_end        TEXT,
  custody_class     TEXT NOT NULL,
  availability      TEXT NOT NULL,
  -- Only meaningful for `can_get_it`: where from, and roughly how long.
  available_from    TEXT,
  available_within_days INTEGER,
  -- When custody was established. The fact behind "stored and findable".
  filed_at          TEXT,
  -- Only meaningful for `reconcilable`: the date through which this document has
  -- been matched against the books. The fact behind "Current", and the reason
  -- that word can never be rendered without a date.
  reconciled_through TEXT,
  -- A role or a channel ("the owner", "the accountant", "photographed"), never a
  -- person's name in shipped fixtures.
  received_from     TEXT,
  received_at       TEXT,
  corpus_doc_uid    TEXT,
  content_hash      TEXT,
  -- A document that arrived and cannot be read is not a document that is missing
  -- and not one that is filed. It is its own state, and the only fix is one only
  -- the owner can perform, so the reason has to survive.
  readable          INTEGER NOT NULL DEFAULT 1,
  unreadable_reason TEXT,
  -- Marked at intake as something the owner restricted. Carried so a screen can
  -- say the restriction exists without opening the record.
  restricted        INTEGER NOT NULL DEFAULT 0,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  -- The taxonomy is lifted from two real pre-install interviews rather than
  -- invented: identity and structure, taxes, books, money movement, obligations,
  -- credit, and the rest of the picture.
  CHECK (doc_kind IN (
    'statement', 'merchant_statement', 'tax_return', 'k1', 'tax_transcript',
    'tax_notice', 'estimated_payment_receipt', 'profit_and_loss', 'balance_sheet',
    'general_ledger', 'trial_balance', 'chart_of_accounts', 'invoice', 'receipt',
    'check_image', 'deposit_slip', 'lease', 'loan_agreement', 'promissory_note',
    'personal_guarantee', 'merchant_agreement', 'insurance_policy',
    'formation_document', 'ein_letter', 'operating_agreement', 'buy_sell_agreement',
    'franchise_agreement', 'credit_report', 'will', 'trust', 'beneficiary_designation',
    'investment_statement', 'other')),
  CHECK (custody_class IN ('reference', 'reconcilable')),
  CHECK (availability IN ('have_it', 'can_get_it', 'do_not_have_it')),
  -- Custody is a date or it is not custody.
  CHECK (availability <> 'have_it' OR filed_at IS NOT NULL),
  CHECK (availability <> 'can_get_it' OR available_from IS NOT NULL),
  CHECK (availability = 'have_it' OR corpus_doc_uid IS NULL),
  CHECK (custody_class = 'reconcilable' OR reconciled_through IS NULL),
  CHECK (readable IN (0, 1)),
  CHECK (readable = 1 OR unreadable_reason IS NOT NULL),
  CHECK (restricted IN (0, 1)),
  CHECK (period_start IS NULL OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end IS NULL OR period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CHECK (filed_at IS NULL OR filed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (reconciled_through IS NULL OR reconciled_through GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (tax_year IS NULL OR tax_year BETWEEN 1900 AND 2200),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_documents_live
  ON fin_documents (tenant_id, fin_doc_uid) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_documents_entity ON fin_documents (tenant_id, entity_slug);
CREATE INDEX IF NOT EXISTS idx_fin_documents_account ON fin_documents (tenant_id, account_slug, period_end);
CREATE INDEX IF NOT EXISTS idx_fin_documents_corpus ON fin_documents (corpus_doc_uid);
CREATE INDEX IF NOT EXISTS idx_fin_documents_replaced ON fin_documents (superseded_by_id);

-- -------------------------------------------------------------- statements --
--
-- One period of one account, as claimed by one source. Deliberately NOT unique
-- on (account, period): the same month arriving from a parsed statement and from
-- a bank feed is two rows, both kept, and their comparison lives in
-- fin_reconciliations. Collapsing them here would resolve a disagreement by
-- accident of write order.
--
-- `parse_state` and reconciliation are two different questions and are kept in
-- two different places on purpose. A statement that has ARRIVED has not been
-- READ, and a statement that has been read has not been MATCHED against the
-- books. The product's own close checklist depends on that distinction: a step
-- does not tick because a file landed.
CREATE TABLE IF NOT EXISTS fin_statements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  statement_uid     TEXT NOT NULL,
  account_slug      TEXT NOT NULL,
  period_start      TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  opening_balance_minor INTEGER,
  closing_balance_minor INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  -- What the document itself says its line count is, when it says. Used to catch
  -- an extraction that quietly dropped a page.
  line_count_stated INTEGER,
  parse_state       TEXT NOT NULL DEFAULT 'received',
  received_at       TEXT,
  parsed_at         TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end >= period_start),
  CHECK (parse_state IN ('received', 'parsing', 'parsed', 'unparsed')),
  -- A parsed statement has a closing balance. Anything else is not parsed.
  CHECK (parse_state <> 'parsed' OR closing_balance_minor IS NOT NULL),
  -- The rule that makes "I could not read it" real: no figure may be stored
  -- alongside an admission that it could not be read.
  CHECK (basis_state <> 'unparsed' OR (opening_balance_minor IS NULL AND closing_balance_minor IS NULL)),
  CHECK (basis_state <> 'unparsed' OR parse_state = 'unparsed'),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_statements_live
  ON fin_statements (tenant_id, statement_uid) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_statements_period
  ON fin_statements (tenant_id, account_slug, period_end DESC);

-- ------------------------------------------------------------ transactions --
--
-- THE SIGN CONVENTION, NORMALISED ONCE.
--
-- Bank feeds and paper statements disagree about what a positive number means:
-- one common feed convention is that a positive amount is money going OUT, which
-- is backwards from every accounting intuition and from most other sources. So
-- `amount_minor` is a MAGNITUDE, always non-negative, and `direction` carries
-- the meaning. The provider's number is kept verbatim in `raw_amount_minor`
-- beside the name of the convention it was written under, so a disagreement is
-- diagnosable instead of being an argument about which side is upside down. Get
-- this wrong and every figure the product produces is wrong with a confident
-- face on it.
--
-- `category IS NULL` is a real state, not missing data: it is spending nobody
-- has sorted yet, and it is one of the things a client is most often asked to
-- resolve. It has its own partial index for exactly that reason.
--
-- Removal is a tombstone, never a DELETE. A feed can withdraw a transaction it
-- previously reported, and hard-deleting it makes "why did last month's total
-- change" permanently unanswerable and is unrecoverable. The corpus already
-- takes this position for documents; a ledger has less excuse than a corpus.
CREATE TABLE IF NOT EXISTS fin_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  txn_uid           TEXT NOT NULL,
  account_slug      TEXT NOT NULL,
  posted_on         TEXT,
  amount_minor      INTEGER,
  direction         TEXT,
  raw_amount_minor  INTEGER,
  raw_sign_convention TEXT,
  currency          TEXT NOT NULL DEFAULT 'USD',
  description       TEXT,
  payee             TEXT,
  category          TEXT,
  -- Whether the category is the owner's answer or the brain's reading. A
  -- proposed category is never presented as a fact.
  category_basis_state TEXT,
  -- A pending line is later withdrawn and re-reported under a different id and
  -- often a different amount. Counting it alongside settled activity double
  -- counts. Excluded at the ledger boundary, not at each caller.
  pending           INTEGER NOT NULL DEFAULT 0,
  statement_uid     TEXT,
  -- The provider's own id, kept so a re-sync can recognise its own rows.
  external_id       TEXT,
  removed_at        TEXT,
  removal_reason    TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (posted_on IS NULL OR posted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (direction IS NULL OR direction IN ('inflow', 'outflow')),
  CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CHECK (pending IN (0, 1)),
  CHECK (category_basis_state IS NULL OR category_basis_state IN ('confirmed', 'proposed')),
  CHECK (removed_at IS NULL OR removal_reason IS NOT NULL),
  -- Unreadable means no figure, in both directions. A row that admits it could
  -- not be read may not carry an amount, and a row that is not unparsed must.
  CHECK (basis_state <> 'unparsed' OR (amount_minor IS NULL AND direction IS NULL)),
  CHECK (basis_state = 'unparsed' OR (amount_minor IS NOT NULL AND direction IS NOT NULL)),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_transactions_live
  ON fin_transactions (tenant_id, txn_uid) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_transactions_account
  ON fin_transactions (tenant_id, account_slug, posted_on DESC);
CREATE INDEX IF NOT EXISTS idx_fin_transactions_statement
  ON fin_transactions (tenant_id, statement_uid);
CREATE INDEX IF NOT EXISTS idx_fin_transactions_feed
  ON fin_transactions (tenant_id, source_feed);
-- The unsorted-spending question, answerable without scanning the ledger.
CREATE INDEX IF NOT EXISTS idx_fin_transactions_unsorted
  ON fin_transactions (tenant_id, account_slug, posted_on)
  WHERE category IS NULL AND removed_at IS NULL AND superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_transactions_replaced
  ON fin_transactions (superseded_by_id);

-- -------------------------------------------------------- balance snapshots --
--
-- A dated observation of what an account held. Distinct from a statement's
-- closing balance because a live feed produces balances on days no statement
-- covers, and because the two are the pair a reconciliation compares.
--
-- One row per account per day per origin. Without that constraint a manual
-- re-sync writes another row every time it is pressed and the table grows
-- without bound while telling nobody anything new. A same-day re-read replaces
-- the day's observation; history here is per day, not per read.
CREATE TABLE IF NOT EXISTS fin_balance_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  account_slug      TEXT NOT NULL,
  as_of_date        TEXT NOT NULL,
  current_minor     INTEGER,
  available_minor   INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (basis_state <> 'unparsed' OR (current_minor IS NULL AND available_minor IS NULL)),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_balance_snapshots_day
  ON fin_balance_snapshots (tenant_id, account_slug, as_of_date, provenance);
CREATE INDEX IF NOT EXISTS idx_fin_balance_snapshots_recent
  ON fin_balance_snapshots (tenant_id, account_slug, as_of_date DESC);

-- ------------------------------------------------------------- obligations --
--
-- Recurring commitments: loans, leases, notes receivable, merchant processing
-- agreements, insurance policies. Anything with a counterparty, a schedule, and
-- a renewal or maturity the owner has to meet.
--
-- THE PERSONAL GUARANTEE IS A FIRST-CLASS COLUMN, NOT A DOCUMENT TYPE, because
-- it is typically the largest single personal exposure an owner carries and it
-- is buried inside a loan or a lease rather than filed under its own name.
-- Finding it is the extraction pass's job on every loan and lease.
--
-- `personal_guarantee_state` defaults to `not_examined`, and that default is the
-- point. A zero in `personal_guarantee` with nobody having looked means "nobody
-- has looked", not "there is no guarantee", and no screen may render the second
-- from the first. A claim that a guarantee EXISTS requires the document it was
-- found in, by CHECK.
CREATE TABLE IF NOT EXISTS fin_obligations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  obligation_uid    TEXT NOT NULL,
  entity_slug       TEXT NOT NULL,
  kind              TEXT NOT NULL,
  -- The institution or lessor. An organisation, never a private individual's
  -- name in shipped fixtures.
  counterparty      TEXT,
  label             TEXT,
  account_slug      TEXT,
  principal_minor   INTEGER,
  balance_minor     INTEGER,
  balance_as_of     TEXT,
  payment_minor     INTEGER,
  payment_cadence   TEXT,
  rate_bp           INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  start_on          TEXT,
  end_on            TEXT,
  renews_on         TEXT,
  personal_guarantee INTEGER NOT NULL DEFAULT 0,
  personal_guarantee_state TEXT NOT NULL DEFAULT 'not_examined',
  personal_guarantee_source_doc_uid TEXT,
  personal_guarantee_locator TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (kind IN ('loan', 'line_of_credit', 'lease', 'note_receivable', 'note_payable',
                  'merchant_agreement', 'insurance_policy', 'guarantee', 'other')),
  CHECK (payment_cadence IS NULL OR payment_cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'on_demand')),
  CHECK (balance_minor IS NULL OR balance_as_of IS NOT NULL),
  CHECK (balance_as_of IS NULL OR balance_as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (end_on IS NULL OR end_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (renews_on IS NULL OR renews_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (rate_bp IS NULL OR rate_bp >= 0),
  CHECK (personal_guarantee IN (0, 1)),
  CHECK (personal_guarantee_state IN ('not_examined', 'none_found', 'found', 'unreadable')),
  CHECK (personal_guarantee_state <> 'found' OR personal_guarantee = 1),
  CHECK (personal_guarantee = 0 OR personal_guarantee_source_doc_uid IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR (principal_minor IS NULL AND balance_minor IS NULL AND payment_minor IS NULL)),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_obligations_live
  ON fin_obligations (tenant_id, obligation_uid) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_obligations_entity
  ON fin_obligations (tenant_id, entity_slug, kind);
CREATE INDEX IF NOT EXISTS idx_fin_obligations_renewal
  ON fin_obligations (tenant_id, renews_on) WHERE superseded_by_id IS NULL;

-- --------------------------------------------------------------- deadlines --
--
-- The obligations register as the owner meets it: what falls due, whose it is,
-- and what it rests on.
--
-- `basis_state` is load-bearing here rather than decorative. A date the brain
-- inferred from a filing calendar and a date read off a policy document are not
-- the same claim, and a deadline whose support is missing or ambiguous must not
-- display as verified. A `confirmed` deadline is required by CHECK to say what
-- it rests on.
--
-- `waiting_on` holds one of two different things, and they must not be
-- conflated: a party and what is wanted ("Bookkeeper: the June export"), or a
-- bare disposition ("review at next close"). The convention is that a colon
-- names the party before it. A disposition means nobody is blocking this.
CREATE TABLE IF NOT EXISTS fin_deadlines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  deadline_uid      TEXT NOT NULL,
  entity_slug       TEXT,
  item              TEXT NOT NULL,
  due_date          TEXT,
  -- 'owner' or a named party. The read path never decides on a client's behalf
  -- who counts as them; the installation declares the owner's names.
  owner_party       TEXT NOT NULL DEFAULT 'owner',
  status            TEXT NOT NULL DEFAULT 'open',
  -- An ordering signal, never a label. Urgency is how a list is sorted, not a
  -- word shown to anyone.
  urgency           TEXT NOT NULL DEFAULT 'dated',
  consequence       TEXT,
  waiting_on        TEXT,
  obligation_uid    TEXT,
  basis_note        TEXT,
  closed_at         TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_by_id  INTEGER,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (status IN ('open', 'blocking', 'parked', 'closed')),
  CHECK (urgency IN ('asap', 'soon', 'dated', 'parked')),
  CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (closed_at IS NULL OR closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL),
  -- A date cannot be confirmed without saying what confirms it.
  CHECK (basis_state <> 'confirmed' OR basis_note IS NOT NULL),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_deadlines_live
  ON fin_deadlines (tenant_id, deadline_uid) WHERE superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_fin_deadlines_due
  ON fin_deadlines (tenant_id, status, due_date);

-- -------------------------------------------------------------- exceptions --
--
-- The exception inbox: money that does not tie out, a cost that moved, a payment
-- that might be a duplicate. Every row carries who holds it, how long it has sat,
-- and, where the brain has a reading, that reading LABELLED AS A PROPOSAL.
--
-- Two rules are enforced by the database rather than left to a caller.
--
-- One: a proposal can never be recorded as confirmed. If `proposal` is present,
-- `basis_state` must be `proposed`. The brain's reading of why three transfers
-- look like owner draws is a pattern, not a fact, and how they are recorded is a
-- professional's call.
--
-- Two: resolving an exception NEVER overwrites a source record. The resolution
-- is written here, on the exception, and the transaction it concerns is
-- untouched. That is why this table has no supersession chain: an exception is
-- resolved, not replaced, and the row it points at keeps its own history.
CREATE TABLE IF NOT EXISTS fin_exceptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  exception_uid     TEXT NOT NULL,
  entity_slug       TEXT,
  kind              TEXT NOT NULL,
  issue             TEXT NOT NULL,
  detail            TEXT,
  amount_minor      INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  txn_uid           TEXT,
  txn_date          TEXT,
  txn_account_slug  TEXT,
  first_seen        TEXT NOT NULL,
  waiting_on        TEXT,
  proposal          TEXT,
  proposal_confidence_bp INTEGER,
  resolved_at       TEXT,
  resolution        TEXT,
  resolved_by_party TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (kind IN ('unmatched_transfer', 'uncategorized', 'possible_duplicate',
                  'cost_change', 'balance_mismatch', 'unidentified_inflow',
                  'missing_statement', 'unreadable_document', 'other')),
  CHECK (first_seen GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (txn_date IS NULL OR txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (resolved_at IS NULL OR resolved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (resolved_at IS NULL OR resolution IS NOT NULL),
  CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CHECK (proposal_confidence_bp IS NULL OR proposal_confidence_bp BETWEEN 0 AND 10000),
  -- The brain's reading is a proposal or it is not recorded.
  CHECK (proposal IS NULL OR basis_state = 'proposed'),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_exceptions_uid
  ON fin_exceptions (tenant_id, exception_uid);
CREATE INDEX IF NOT EXISTS idx_fin_exceptions_open
  ON fin_exceptions (tenant_id, entity_slug, first_seen) WHERE resolved_at IS NULL;

-- -------------------------------------------------------------- open items --
--
-- A question prepared for a professional, with its citations and, just as
-- importantly, what is NOT included and why. The product writes the question and
-- names its sources; a person sends it and a person answers it. Nothing here
-- sends anything, and `status` records what the OWNER said they did, never what
-- the system observed, because the system observes nothing about an email it did
-- not send.
--
-- `citations` and `not_included` are JSON because they are read whole and
-- rendered whole, and never queried element by element. Giving them their own
-- table would buy a join and no capability.
CREATE TABLE IF NOT EXISTS fin_open_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  open_item_code    TEXT NOT NULL,
  entity_slug       TEXT,
  question          TEXT NOT NULL,
  -- The role first, the name second. A role is renderable when a name is absent,
  -- and most of these are addressed to a role.
  routed_role       TEXT,
  routed_name       TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  due_date          TEXT,
  citations         TEXT,
  not_included      TEXT,
  answer            TEXT,
  answered_at       TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (status IN ('draft', 'sent', 'answered', 'closed')),
  CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (answered_at IS NULL OR answered_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (status <> 'answered' OR (answer IS NOT NULL AND answered_at IS NOT NULL)),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_open_items_code
  ON fin_open_items (tenant_id, open_item_code);
CREATE INDEX IF NOT EXISTS idx_fin_open_items_status
  ON fin_open_items (tenant_id, status, due_date);

-- --------------------------------------------------------- reconciliations --
--
-- The comparison, and its state. One row per (account, period, measure): the
-- closing balance of one account for one month, the receipts on one property for
-- one month, and so on. Its claims are the child table below.
--
-- WHY THIS IS A STATE AND NOT AN ANSWER. Two sources for one figure is the
-- normal condition of financial records, not an error: a parsed statement and a
-- bank feed for the same month should agree to the penny, and when they do not,
-- the difference is the finding. `mismatched` is a resting state. Nothing here
-- picks a winner, and the read path deliberately does not resolve a mismatch
-- into a single number, because a total assembled from whichever side happened
-- to be written last is a wrong answer wearing the clothes of a sourced one.
--
-- An owner CAN rule which source they trust, and the ruling is recorded here
-- beside both figures. Both claims survive the ruling. `ruling_consumed` records
-- whether anything actually uses the ruled side, and it ships at 0: recording a
-- decision and acting on it are two different things, and a screen that implies
-- the second while only the first is true is exactly the overclaim this table
-- exists to prevent.
CREATE TABLE IF NOT EXISTS fin_reconciliations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  reconciliation_uid TEXT NOT NULL,
  entity_slug       TEXT,
  account_slug      TEXT,
  period_start      TEXT,
  period_end        TEXT,
  -- What is being compared. Two sources for the closing balance is the common
  -- case; the same machinery holds two sources for a month's receipts.
  measure           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'open',
  -- The difference between exactly two figured claims, in minor units. NULL when
  -- fewer than two claims carry a figure, which is `insufficient_evidence`, not
  -- agreement.
  delta_minor       INTEGER,
  -- Zero means to the penny, which is the default and should stay the default.
  tolerance_minor   INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  ruled_claim_uid   TEXT,
  ruled_at          TEXT,
  ruled_by_party    TEXT,
  ruling_note       TEXT,
  ruling_consumed   INTEGER NOT NULL DEFAULT 0,
  computed_at       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (measure IN ('closing_balance', 'opening_balance', 'net_activity',
                     'period_receipts', 'period_disbursements', 'line_count')),
  CHECK (state IN ('open', 'matched', 'mismatched', 'insufficient_evidence')),
  CHECK (tolerance_minor >= 0),
  CHECK (period_start IS NULL OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_end IS NULL OR period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  CHECK (ruled_at IS NULL OR ruled_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (ruled_claim_uid IS NULL OR ruled_at IS NOT NULL),
  CHECK (ruling_consumed IN (0, 1)),
  -- Agreement is arithmetic, not a label somebody may set by hand.
  CHECK (state <> 'matched' OR (delta_minor IS NOT NULL AND abs(delta_minor) <= tolerance_minor)),
  CHECK (state <> 'mismatched' OR (delta_minor IS NOT NULL AND abs(delta_minor) > tolerance_minor)),
  CHECK (state <> 'insufficient_evidence' OR delta_minor IS NULL)
);

-- The scope key of a reconciliation. Expression index because an entity-level
-- measure has no account and a point-in-time measure has no period, and SQLite
-- treats NULLs in a unique index as distinct, which would let duplicates in
-- through exactly those holes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_reconciliations_scope
  ON fin_reconciliations (tenant_id, COALESCE(account_slug, ''), COALESCE(entity_slug, ''),
                          COALESCE(period_start, ''), COALESCE(period_end, ''), measure);
CREATE INDEX IF NOT EXISTS idx_fin_reconciliations_state
  ON fin_reconciliations (tenant_id, state, period_end DESC);

-- A competing claim about one measure. Both are kept, both are dated, and
-- nothing is overwritten.
--
-- `as_of` is NOT NULL because two undated figures cannot be adjudicated: without
-- a date there is no way to tell a disagreement from an update. That is the same
-- rule the product applies on screen, where a claim is always shown with the day
-- it was made.
--
-- `claim_ref_table` / `claim_ref_uid` point at the row a claim came from when one
-- exists. They are nullable on purpose: a figure the owner gave from memory has
-- no backing row anywhere, and refusing to record it would make the disagreement
-- invisible rather than making it go away.
CREATE TABLE IF NOT EXISTS fin_reconciliation_claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL DEFAULT 'primary',
  claim_uid         TEXT NOT NULL,
  reconciliation_uid TEXT NOT NULL,
  -- How the client would name this source in a sentence: "the property manager
  -- statement", "the figure you gave us".
  label             TEXT NOT NULL,
  amount_minor      INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  as_of             TEXT NOT NULL,
  claim_ref_table   TEXT,
  claim_ref_uid     TEXT,
  provenance        TEXT NOT NULL,
  source_doc_uid    TEXT,
  source_locator    TEXT,
  source_feed       TEXT,
  confidence_bp     INTEGER,
  basis_state       TEXT NOT NULL,
  unparsed_reason   TEXT,
  recorded_at       TEXT NOT NULL,
  CHECK (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*' AND length(tenant_id) BETWEEN 1 AND 64),
  CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (claim_ref_table IS NULL OR claim_ref_table IN ('fin_statements', 'fin_balance_snapshots',
                                                        'fin_transactions', 'fin_documents')),
  CHECK (claim_ref_table IS NULL OR claim_ref_uid IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR amount_minor IS NULL),
  CHECK (provenance IN ('owner_stated', 'extracted', 'feed', 'derived')),
  CHECK (basis_state IN ('confirmed', 'proposed', 'unparsed')),
  CHECK (confidence_bp IS NULL OR confidence_bp BETWEEN 0 AND 10000),
  CHECK (provenance <> 'extracted' OR source_doc_uid IS NOT NULL),
  CHECK (provenance <> 'feed' OR source_feed IS NOT NULL),
  CHECK (basis_state <> 'unparsed' OR unparsed_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_reconciliation_claims_uid
  ON fin_reconciliation_claims (tenant_id, claim_uid);
CREATE INDEX IF NOT EXISTS idx_fin_reconciliation_claims_parent
  ON fin_reconciliation_claims (tenant_id, reconciliation_uid);
