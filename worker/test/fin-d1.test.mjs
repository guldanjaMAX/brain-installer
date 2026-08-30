/**
 * The financial ledger: schema guarantees and the read path, against a REAL
 * SQLite database.
 *
 * Mocks cannot prove a CHECK constraint, and every safety property this schema
 * claims is a CHECK constraint. So this file applies the actual migration files
 * in order to an in-memory SQLite database and then drives the exported query
 * functions through a thin D1-shaped adapter over the same database. A test that
 * asserts against a hand-built `{DB:{prepare}}` mock proves the mock.
 *
 * Every fixture person and business here is invented. No real client, bank,
 * account, or figure appears in this file.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../../brain.mjs";
import {
  DEFAULT_TENANT, ledgerAccounts, ledgerCashPosition, ledgerDeadlines, ledgerDocuments,
  ledgerEntities, ledgerExceptions, ledgerInstalled, ledgerObligations, ledgerOpenItems,
  ledgerReconciliations, ledgerSnapshot, ledgerUnsortedSpending, __testing,
} from "../src/lib/fin-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const LEDGER_MIGRATION = "0017_financial_ledger.sql";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const statementsFor = (file) => splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"));

function freshDb({ throughLedger = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = throughLedger
    ? migrationFiles
    : migrationFiles.filter((file) => file < LEDGER_MIGRATION);
  for (const file of files) {
    for (const statement of statementsFor(file)) db.exec(statement);
  }
  return db;
}

/**
 * A D1-shaped adapter over real SQLite. `all()` returns `{results}` the way the
 * Worker binding does, so the query functions under test run their real SQL.
 */
function d1(db, { failEverything = false } = {}) {
  return {
    DB: {
      prepare(sql) {
        const shape = (params = []) => ({
          bind: (...next) => shape(next),
          all: async () => {
            if (failEverything) throw new Error("database unreachable");
            return { results: db.prepare(sql).all(...params) };
          },
          first: async () => {
            if (failEverything) throw new Error("database unreachable");
            return db.prepare(sql).get(...params) ?? null;
          },
          run: async () => {
            if (failEverything) throw new Error("database unreachable");
            const result = db.prepare(sql).run(...params);
            return { meta: { changes: Number(result.changes || 0) } };
          },
        });
        return shape();
      },
    },
  };
}

/** Attempt an insert and report whether the database refused it. */
function refuses(db, sql, params = []) {
  try {
    db.prepare(sql).run(...params);
    return false;
  } catch {
    return true;
  }
}

const NOW = "2026-08-28T00:00:00Z";

/* ------------------------------------------------- the migration itself --- */
{
  const db = freshDb();
  const objects = new Set(db.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
  for (const table of __testing.LEDGER_TABLES) {
    check(`${table} exists`, objects.has(table), [...objects].filter((n) => n.startsWith("fin_")).join(", "));
  }

  // Every table carries the tenant column from the first migration, even though
  // one brain per client does not need it. This is the property that keeps the
  // account-model decision reversible without a migration on a live ledger.
  let everyTableTenanted = true;
  let tenantDetail = "";
  for (const table of __testing.LEDGER_TABLES) {
    const column = db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === "tenant_id");
    if (!column || Number(column.notnull) !== 1) {
      everyTableTenanted = false;
      tenantDetail = `${table}: ${JSON.stringify(column)}`;
    }
  }
  check("every ledger table carries a NOT NULL tenant column", everyTableTenanted, tenantDetail);

  // Every fact-bearing table carries provenance, and it is NOT NULL. A financial
  // figure whose origin cannot be named is not evidence.
  let everyTableHasProvenance = true;
  let provenanceDetail = "";
  const factTables = __testing.LEDGER_TABLES.filter((t) => t !== "fin_reconciliations");
  for (const table of factTables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const provenance = columns.find((c) => c.name === "provenance");
    const basis = columns.find((c) => c.name === "basis_state");
    if (!provenance || Number(provenance.notnull) !== 1 || !basis || Number(basis.notnull) !== 1) {
      everyTableHasProvenance = false;
      provenanceDetail = `${table}`;
    }
  }
  check("every fact table carries NOT NULL provenance and basis_state",
    everyTableHasProvenance, provenanceDetail);

  for (const index of ["ux_fin_entities_live", "ux_fin_accounts_live", "ux_fin_documents_live",
                       "ux_fin_transactions_live", "ux_fin_reconciliations_scope",
                       "idx_fin_transactions_unsorted"]) {
    check(`${index} exists`, objects.has(index), "a ledger read would otherwise scan");
  }
  db.close();
}

/* ------------------------------------- restart safety: re-applying is safe -- */
{
  // D1 commits each statement independently, so a crash mid-file must leave a
  // database the same migration can be run over again. Every statement in 0017
  // is a CREATE ... IF NOT EXISTS, which this proves by running the whole file a
  // second time and then once more statement by statement from each fault point.
  const db = freshDb();
  let reapplied = true;
  let detail = "";
  try {
    for (const statement of statementsFor(LEDGER_MIGRATION)) db.exec(statement);
  } catch (error) {
    reapplied = false;
    detail = error.message;
  }
  check("0017 re-applies cleanly over itself", reapplied, detail);

  const ledgerStatements = statementsFor(LEDGER_MIGRATION);
  let everyResumePassed = true;
  let resumeDetail = "";
  for (let faultAfter = 0; faultAfter < ledgerStatements.length; faultAfter++) {
    const candidate = freshDb({ throughLedger: false });
    try {
      for (let i = 0; i <= faultAfter; i++) candidate.exec(ledgerStatements[i]);
      // ... process dies here, schema_migrations never updated, migration re-runs
      for (const statement of ledgerStatements) candidate.exec(statement);
      const objects = new Set(candidate.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
      for (const table of __testing.LEDGER_TABLES) {
        if (!objects.has(table)) {
          everyResumePassed = false;
          resumeDetail = `fault ${faultAfter}: ${table} missing after resume`;
        }
      }
    } catch (error) {
      everyResumePassed = false;
      resumeDetail = `fault ${faultAfter}: ${error.message}`;
    }
    candidate.close();
    if (!everyResumePassed) break;
  }
  check(`0017 resumes after every one of its ${ledgerStatements.length} independently committed statements`,
    everyResumePassed, resumeDetail);
  db.close();
}

/* --------------------------------------- the constraints that must bite ---- */
{
  const db = freshDb();
  const insertEntity = (overrides = {}) => {
    const row = {
      slug: "household", name: "Rivera Household", kind: "household",
      provenance: "owner_stated", doc: null, feed: null, basis: "confirmed", reason: null,
      ...overrides,
    };
    return refuses(db,
      `INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, kind, provenance,
         source_doc_uid, source_feed, basis_state, unparsed_reason, recorded_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.slug, row.name, row.kind, row.provenance, row.doc, row.feed, row.basis, row.reason, NOW]);
  };

  check("an entity with clean provenance is accepted", insertEntity() === false);
  check("an extracted row with no source document is refused",
    insertEntity({ slug: "e-extracted", provenance: "extracted" }));
  check("a feed row with no named feed is refused",
    insertEntity({ slug: "e-feed", provenance: "feed" }));
  check("an unparsed row with no reason is refused",
    insertEntity({ slug: "e-unparsed", basis: "unparsed" }));
  check("an invented provenance value is refused",
    insertEntity({ slug: "e-bogus", provenance: "probably" }));
  check("a slug containing a wildcard is refused",
    insertEntity({ slug: "house%" }));

  // Two live rows cannot share a scope key, but supersession is not blocked by
  // that: the old row is marked replaced and the new one takes the key.
  check("a second live row for the same entity slug is refused", insertEntity());
  db.prepare("UPDATE fin_entities SET superseded_by_id = 999 WHERE entity_slug = 'household'").run();
  check("superseding the old row frees the key for the corrected one", insertEntity() === false);

  const insertAccount = (overrides = {}) => {
    const row = {
      slug: "acct-1", entity: "household", kind: "checking", role: "asset", mask: "4471",
      cadence: "monthly", provenance: "owner_stated", basis: "confirmed",
      ...overrides,
    };
    return refuses(db,
      `INSERT INTO fin_accounts (tenant_id, account_slug, entity_slug, account_kind,
         balance_role, mask, expected_cadence, provenance, basis_state, recorded_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.slug, row.entity, row.kind, row.role, row.mask, row.cadence, row.provenance, row.basis, NOW]);
  };
  check("a deposit account is accepted", insertAccount() === false);
  // The single most expensive arithmetic error available to this product: a
  // credit card counted as money held.
  check("a card recorded as an asset is refused",
    insertAccount({ slug: "acct-card", kind: "card", role: "asset" }));
  check("a loan recorded as an asset is refused",
    insertAccount({ slug: "acct-loan", kind: "loan", role: "asset" }));
  check("a card recorded as a liability is accepted",
    insertAccount({ slug: "acct-card2", kind: "card", role: "liability" }) === false);
  check("a full account number in the mask column is refused",
    insertAccount({ slug: "acct-full", mask: "123456789" }));
  check("no expectation set is a legal state, not a missing value",
    insertAccount({ slug: "acct-noexpect", cadence: null }) === false);

  const insertTxn = (overrides = {}) => {
    const row = {
      uid: "t1", account: "acct-1", posted: "2026-07-14", amount: 31000, direction: "outflow",
      provenance: "owner_stated", doc: null, basis: "confirmed", reason: null, ...overrides,
    };
    return refuses(db,
      `INSERT INTO fin_transactions (tenant_id, txn_uid, account_slug, posted_on, amount_minor,
         direction, provenance, source_doc_uid, basis_state, unparsed_reason, recorded_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.uid, row.account, row.posted, row.amount, row.direction, row.provenance,
       row.doc, row.basis, row.reason, NOW]);
  };
  check("a readable transaction is accepted", insertTxn() === false);
  // The property the whole "never guess" discipline rests on: you cannot store a
  // number you could not read.
  check("an unparsed transaction carrying an amount is refused",
    insertTxn({ uid: "t-guess", basis: "unparsed", reason: "the amount column was cut off" }));
  check("an unparsed transaction with no amount is accepted",
    insertTxn({ uid: "t-unparsed", amount: null, direction: null, basis: "unparsed",
                reason: "the amount column was cut off" }) === false);
  check("a readable transaction with no amount is refused",
    insertTxn({ uid: "t-empty", amount: null, direction: null }));
  check("a negative magnitude is refused", insertTxn({ uid: "t-neg", amount: -100 }));
  check("a date that is not a calendar date is refused",
    insertTxn({ uid: "t-date", posted: "July 2026" }));

  check("a statement claiming to be parsed with no closing balance is refused",
    refuses(db,
      `INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start,
         period_end, parse_state, provenance, basis_state, recorded_at)
       VALUES ('primary','s-noclose','acct-1','2026-07-01','2026-07-31','parsed','owner_stated','confirmed',?)`,
      [NOW]));
  check("a statement period that ends before it starts is refused",
    refuses(db,
      `INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start,
         period_end, provenance, basis_state, recorded_at)
       VALUES ('primary','s-backwards','acct-1','2026-07-31','2026-07-01','owner_stated','confirmed',?)`,
      [NOW]));
  check("an unparsed statement carrying balances is refused",
    refuses(db,
      `INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start,
         period_end, closing_balance_minor, parse_state, provenance, basis_state,
         unparsed_reason, recorded_at)
       VALUES ('primary','s-guess','acct-1','2026-07-01','2026-07-31',500,'unparsed','owner_stated',
               'unparsed','the balance line was illegible',?)`,
      [NOW]));

  check("coverage claimed complete with no through date is refused",
    refuses(db,
      `INSERT INTO fin_account_coverage (tenant_id, account_slug, coverage_status, computed_at,
         provenance, basis_state, recorded_at)
       VALUES ('primary','acct-1','complete',?, 'derived','confirmed',?)`, [NOW, NOW]));
  check("indirect coverage that does not name the covering account is refused",
    refuses(db,
      `INSERT INTO fin_account_coverage (tenant_id, account_slug, coverage_status, computed_at,
         provenance, basis_state, recorded_at)
       VALUES ('primary','acct-1','indirect',?, 'derived','confirmed',?)`, [NOW, NOW]));

  check("a document held with no filed date is refused",
    refuses(db,
      `INSERT INTO fin_documents (tenant_id, fin_doc_uid, doc_kind, title, custody_class,
         availability, provenance, basis_state, recorded_at)
       VALUES ('primary','d-nofiled','statement','A statement','reconcilable','have_it','owner_stated','confirmed',?)`,
      [NOW]));
  check("an unreadable document that does not say why is refused",
    refuses(db,
      `INSERT INTO fin_documents (tenant_id, fin_doc_uid, doc_kind, title, custody_class,
         availability, filed_at, readable, provenance, basis_state, recorded_at)
       VALUES ('primary','d-blur','statement','A photograph','reconcilable','have_it','2026-08-12',0,'owner_stated','confirmed',?)`,
      [NOW]));
  check("a reference document cannot claim a reconciled-through date",
    refuses(db,
      `INSERT INTO fin_documents (tenant_id, fin_doc_uid, doc_kind, title, custody_class,
         availability, filed_at, reconciled_through, provenance, basis_state, recorded_at)
       VALUES ('primary','d-deed','formation_document','A deed','reference','have_it','2026-08-02','2026-07-31','owner_stated','confirmed',?)`,
      [NOW]));

  check("a personal guarantee asserted without the document it was found in is refused",
    refuses(db,
      `INSERT INTO fin_obligations (tenant_id, obligation_uid, entity_slug, kind,
         personal_guarantee, personal_guarantee_state, provenance, basis_state, recorded_at)
       VALUES ('primary','o-pg','household','loan',1,'found','owner_stated','confirmed',?)`,
      [NOW]));
  check("a guarantee nobody has looked for is the default and is accepted",
    refuses(db,
      `INSERT INTO fin_obligations (tenant_id, obligation_uid, entity_slug, kind,
         provenance, basis_state, recorded_at)
       VALUES ('primary','o-plain','household','lease','owner_stated','confirmed',?)`,
      [NOW]) === false);

  check("a deadline confirmed without saying what confirms it is refused",
    refuses(db,
      `INSERT INTO fin_deadlines (tenant_id, deadline_uid, item, provenance, basis_state, recorded_at)
       VALUES ('primary','dl-nobasis','Quarterly estimate','derived','confirmed',?)`, [NOW]));
  check("a deadline the brain proposed is accepted without a basis note",
    refuses(db,
      `INSERT INTO fin_deadlines (tenant_id, deadline_uid, item, provenance, basis_state, recorded_at)
       VALUES ('primary','dl-proposed','Sales tax filing','derived','proposed',?)`, [NOW]) === false);

  // The brain's reading of a pattern is a proposal. It cannot be recorded as a
  // finding, by construction rather than by review.
  check("a proposal recorded as a confirmed fact is refused",
    refuses(db,
      `INSERT INTO fin_exceptions (tenant_id, exception_uid, kind, issue, first_seen,
         proposal, provenance, basis_state, recorded_at)
       VALUES ('primary','x-conf','unmatched_transfer','Three transfers have no recorded reason',
               '2026-08-12','These look like owner draws','derived','confirmed',?)`, [NOW]));
  check("the same proposal recorded as a proposal is accepted",
    refuses(db,
      `INSERT INTO fin_exceptions (tenant_id, exception_uid, kind, issue, first_seen,
         proposal, provenance, basis_state, recorded_at)
       VALUES ('primary','x-prop','unmatched_transfer','Three transfers have no recorded reason',
               '2026-08-12','These look like owner draws','derived','proposed',?)`, [NOW]) === false);

  check("a reconciliation cannot be marked matched while the figures differ",
    refuses(db,
      `INSERT INTO fin_reconciliations (tenant_id, reconciliation_uid, account_slug,
         period_start, period_end, measure, state, delta_minor, computed_at, recorded_at)
       VALUES ('primary','r-lie','acct-1','2026-07-01','2026-07-31','closing_balance','matched',15000,?,?)`,
      [NOW, NOW]));
  check("a reconciliation cannot be marked mismatched while the figures agree",
    refuses(db,
      `INSERT INTO fin_reconciliations (tenant_id, reconciliation_uid, account_slug,
         period_start, period_end, measure, state, delta_minor, computed_at, recorded_at)
       VALUES ('primary','r-lie2','acct-1','2026-07-01','2026-07-31','closing_balance','mismatched',0,?,?)`,
      [NOW, NOW]));
  check("insufficient evidence cannot carry a difference",
    refuses(db,
      `INSERT INTO fin_reconciliations (tenant_id, reconciliation_uid, account_slug,
         period_start, period_end, measure, state, delta_minor, computed_at, recorded_at)
       VALUES ('primary','r-lie3','acct-1','2026-07-01','2026-07-31','closing_balance','insufficient_evidence',5,?,?)`,
      [NOW, NOW]));
  db.prepare(
    `INSERT INTO fin_reconciliations (tenant_id, reconciliation_uid, account_slug,
       period_start, period_end, measure, state, delta_minor, computed_at, recorded_at)
     VALUES ('primary','r-real','acct-1','2026-07-01','2026-07-31','closing_balance','mismatched',15000,?,?)`
  ).run(NOW, NOW);
  check("a competing claim with no as-of date is refused",
    refuses(db,
      `INSERT INTO fin_reconciliation_claims (tenant_id, claim_uid, reconciliation_uid, label,
         amount_minor, provenance, basis_state, recorded_at)
       VALUES ('primary','c-undated','r-real','What you told us',230000,'owner_stated','confirmed',?)`,
      [NOW]));
  db.close();
}

/* ------------------------------------------- a populated synthetic ledger -- */

/**
 * One invented household with a business and a rental. Enough shape to exercise
 * every read: a deposit account with a parsed statement, a credit card that must
 * never be counted as cash, an account nobody connected, a document that could
 * not be read, an unparsed transaction, and one figure two sources disagree on.
 */
function seed(db) {
  const run = (sql, params = []) => db.prepare(sql).run(...params);

  run(`INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, display_label, kind,
        fixed_scope, provenance, basis_state, recorded_at)
       VALUES ('primary','household','Rivera Household','Home','household',1,'owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, display_label, kind,
        ownership_bp, provenance, basis_state, recorded_at)
       VALUES ('primary','cafe','Maple Street Cafe LLC','Maple Street Cafe','business',10000,'owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, kind, relationship,
        holds, provenance, basis_state, recorded_at)
       VALUES ('primary','buyer-co','Northgate Holdings','business','counterparty',
               'Owes on the note from the sale','owner_stated','confirmed',?)`, [NOW]);
  // A superseded entity row: the interview said one thing, the formation document said another.
  run(`INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, kind, provenance,
        basis_state, recorded_at, superseded_by_id)
       VALUES ('primary','rental','Two Unit Rental','property','owner_stated','confirmed',?,4242)`, [NOW]);
  run(`INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, kind, provenance,
        source_doc_uid, source_locator, confidence_bp, basis_state, recorded_at)
       VALUES ('primary','rental','Rivera Rental Partners LP','property','extracted',
               'doc-formation','page 1', 9600, 'confirmed',?)`, [NOW]);

  run(`INSERT INTO fin_accounts (tenant_id, account_slug, entity_slug, institution, label,
        account_kind, balance_role, mask, feed_mode, expected_cadence, provenance, basis_state, recorded_at)
       VALUES ('primary','home-checking','household','Northgate Bank','Joint checking','checking',
               'asset','1180','manual','monthly','owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_accounts (tenant_id, account_slug, entity_slug, institution, label,
        account_kind, balance_role, mask, feed_mode, expected_cadence, provenance, basis_state, recorded_at)
       VALUES ('primary','cafe-checking','cafe','Northgate Bank','Cafe checking','checking',
               'asset','4471','manual','monthly','owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_accounts (tenant_id, account_slug, entity_slug, institution, label,
        account_kind, balance_role, mask, feed_mode, expected_cadence, provenance, basis_state, recorded_at)
       VALUES ('primary','cafe-card','cafe','Harbor Credit Union','Cafe card','card',
               'liability','9021','manual','monthly','owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_accounts (tenant_id, account_slug, entity_slug, label, account_kind,
        balance_role, feed_mode, status, provenance, basis_state, recorded_at)
       VALUES ('primary','rental-checking','rental','Rental checking','checking','asset','none',
               'never_connected','owner_stated','confirmed',?)`, [NOW]);

  run(`INSERT INTO fin_account_coverage (tenant_id, account_slug, coverage_status, covered_from,
        covered_to, computed_at, provenance, basis_state, recorded_at)
       VALUES ('primary','home-checking','complete','2026-01-01','2026-07-31',?,'derived','confirmed',?)`, [NOW, NOW]);
  run(`INSERT INTO fin_account_coverage (tenant_id, account_slug, coverage_status, covered_from,
        covered_to, basis_note, computed_at, provenance, basis_state, recorded_at)
       VALUES ('primary','cafe-checking','partial','2026-01-01','2026-06-30',
               'The July statement has not arrived.',?,'derived','confirmed',?)`, [NOW, NOW]);
  run(`INSERT INTO fin_account_coverage (tenant_id, account_slug, coverage_status, computed_at,
        provenance, basis_state, recorded_at)
       VALUES ('primary','rental-checking','missing',?,'derived','confirmed',?)`, [NOW, NOW]);

  run(`INSERT INTO fin_documents (tenant_id, fin_doc_uid, entity_slug, account_slug, doc_kind,
        title, period_start, period_end, custody_class, availability, filed_at, reconciled_through,
        received_from, corpus_doc_uid, provenance, basis_state, recorded_at)
       VALUES ('primary','doc-june','cafe','cafe-checking','statement','Cafe checking, June',
               '2026-06-01','2026-06-30','reconcilable','have_it','2026-08-02','2026-06-30',
               'the owner','corpus:cafe-june','owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_documents (tenant_id, fin_doc_uid, entity_slug, doc_kind, title,
        tax_year, custody_class, availability, available_from, available_within_days,
        provenance, basis_state, recorded_at)
       VALUES ('primary','doc-return','household','tax_return','2024 return, filed copy',2024,
               'reference','can_get_it','the accountant',7,'owner_stated','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_documents (tenant_id, fin_doc_uid, entity_slug, doc_kind, title,
        custody_class, availability, filed_at, readable, unreadable_reason,
        provenance, basis_state, recorded_at)
       VALUES ('primary','doc-photo','cafe','statement','Photograph from 12 August',
               'reconcilable','have_it','2026-08-12',0,'Too blurry to read. It needs taking again.',
               'owner_stated','confirmed',?)`, [NOW]);

  run(`INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start, period_end,
        opening_balance_minor, closing_balance_minor, parse_state, parsed_at, provenance,
        source_doc_uid, source_locator, confidence_bp, basis_state, recorded_at)
       VALUES ('primary','st-home-jul','home-checking','2026-07-01','2026-07-31',7900000,8421000,
               'parsed','2026-08-02','extracted','doc-home-jul','page 1',9900,'confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start, period_end,
        opening_balance_minor, closing_balance_minor, parse_state, parsed_at, provenance,
        source_doc_uid, source_locator, basis_state, recorded_at)
       VALUES ('primary','st-cafe-jun','cafe-checking','2026-06-01','2026-06-30',1200000,1431500,
               'parsed','2026-08-02','extracted','doc-june','page 1','confirmed',?)`, [NOW]);
  // Arrived, not read. A close step must not tick on this.
  run(`INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start, period_end,
        parse_state, received_at, provenance, basis_state, recorded_at)
       VALUES ('primary','st-cafe-jul','cafe-checking','2026-07-01','2026-07-31','received',
               '2026-08-25','owner_stated','confirmed',?)`, [NOW]);

  run(`INSERT INTO fin_balance_snapshots (tenant_id, account_slug, as_of_date, current_minor,
        provenance, source_feed, basis_state, recorded_at)
       VALUES ('primary','cafe-card','2026-07-31',294000,'feed','plaid:item-a','confirmed',?)`, [NOW]);

  const txn = `INSERT INTO fin_transactions (tenant_id, txn_uid, account_slug, posted_on,
      amount_minor, direction, raw_amount_minor, raw_sign_convention, description, category,
      pending, removed_at, removal_reason, provenance, source_doc_uid, source_locator,
      source_feed, basis_state, unparsed_reason, recorded_at, superseded_by_id)
    VALUES ('primary',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  run(txn, ["tx-1", "cafe-card", "2026-07-05", 145000, "outflow", 145000, "provider_positive_is_outflow",
            "Supplier delivery", null, 0, null, null, "feed", null, null, "plaid:item-a", "confirmed", null, NOW, null]);
  run(txn, ["tx-2", "cafe-card", "2026-07-12", 149000, "outflow", 149000, "provider_positive_is_outflow",
            "Supplier delivery", null, 0, null, null, "feed", null, null, "plaid:item-a", "confirmed", null, NOW, null]);
  // Pending: later withdrawn and re-reported. Never counted.
  run(txn, ["tx-3", "cafe-card", "2026-07-30", 90000, "outflow", 90000, "provider_positive_is_outflow",
            "Pending charge", null, 1, null, null, "feed", null, null, "plaid:item-a", "confirmed", null, NOW, null]);
  // Tombstoned, not deleted.
  run(txn, ["tx-4", "cafe-card", "2026-07-15", 62000, "outflow", 62000, "provider_positive_is_outflow",
            "Withdrawn by the bank", null, 0, "2026-08-01", "the feed withdrew it", "feed", null, null,
            "plaid:item-a", "confirmed", null, NOW, null]);
  // Superseded by a corrected row.
  run(txn, ["tx-5", "cafe-card", "2026-07-18", 11100, "outflow", 11100, "provider_positive_is_outflow",
            "Mis-read amount", null, 0, null, null, "extracted", "doc-june", "page 3", null, "confirmed", null, NOW, 4242]);
  run(txn, ["tx-5b", "cafe-card", "2026-07-18", 11000, "outflow", 11000, "provider_positive_is_outflow",
            "Corrected amount", "supplies", 0, null, null, "extracted", "doc-june", "page 3", null, "confirmed", null, NOW, null]);
  // Could not be read. Counted as a gap, never as a figure.
  run(txn, ["tx-6", "cafe-card", null, null, null, null, null, "Illegible line", null, 0, null, null,
            "extracted", "doc-photo", "page 2", null, "unparsed", "the amount column was cut off", NOW, null]);
  run(txn, ["tx-7", "home-checking", "2026-07-20", 418000, "inflow", -418000,
            "provider_positive_is_outflow", "Transfer in", "transfer", 0, null, null,
            "feed", null, null, "plaid:item-b", "confirmed", null, NOW, null]);

  run(`INSERT INTO fin_obligations (tenant_id, obligation_uid, entity_slug, kind, counterparty,
        label, balance_minor, balance_as_of, renews_on, personal_guarantee,
        personal_guarantee_state, personal_guarantee_source_doc_uid, personal_guarantee_locator,
        provenance, source_doc_uid, source_locator, basis_state, recorded_at)
       VALUES ('primary','ob-loan','cafe','loan','Harbor Credit Union','Equipment loan',
               2750000,'2026-07-31',NULL,1,'found','doc-loan','page 9, clause 14',
               'extracted','doc-loan','page 1','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_obligations (tenant_id, obligation_uid, entity_slug, kind, counterparty,
        label, renews_on, provenance, basis_state, recorded_at)
       VALUES ('primary','ob-policy','rental','insurance_policy','Northgate Mutual',
               'Rental insurance policy','2026-09-15','owner_stated','confirmed',?)`, [NOW]);

  run(`INSERT INTO fin_deadlines (tenant_id, deadline_uid, entity_slug, item, due_date, owner_party,
        status, urgency, basis_note, obligation_uid, provenance, source_doc_uid, source_locator,
        basis_state, recorded_at)
       VALUES ('primary','dl-insurance','rental','Rental insurance renewal','2026-09-15','owner',
               'open','dated','Policy document on file, dated 15 September 2025','ob-policy',
               'extracted','doc-policy','page 1','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_deadlines (tenant_id, deadline_uid, entity_slug, item, due_date, owner_party,
        status, urgency, waiting_on, provenance, basis_state, recorded_at)
       VALUES ('primary','dl-salestax','cafe','Cafe sales tax filing','2026-09-20','Bookkeeper',
               'open','dated','Bookkeeper: the June export','derived','proposed',?)`, [NOW]);
  run(`INSERT INTO fin_deadlines (tenant_id, deadline_uid, item, owner_party, status, urgency,
        provenance, basis_state, recorded_at)
       VALUES ('primary','dl-undated','Reconcile the opening balances','owner','open','soon',
               'derived','proposed',?)`, [NOW]);
  run(`INSERT INTO fin_deadlines (tenant_id, deadline_uid, item, owner_party, status, urgency,
        closed_at, provenance, basis_state, recorded_at)
       VALUES ('primary','dl-done','Second quarter estimate','owner','closed','dated','2026-06-15',
               'derived','proposed',?)`, [NOW]);

  run(`INSERT INTO fin_exceptions (tenant_id, exception_uid, entity_slug, kind, issue, amount_minor,
        first_seen, waiting_on, proposal, proposal_confidence_bp, provenance, basis_state, recorded_at)
       VALUES ('primary','x-transfers','cafe','unmatched_transfer',
               'Three transfers between the cafe and the household have no recorded reason',
               418000,'2026-08-12','owner','They look like owner draws moved through the cafe account',
               6200,'derived','proposed',?)`, [NOW]);
  run(`INSERT INTO fin_exceptions (tenant_id, exception_uid, entity_slug, kind, issue, amount_minor,
        first_seen, provenance, basis_state, recorded_at)
       VALUES ('primary','x-dupe','cafe','possible_duplicate',
               'Two identical payments to one supplier three days apart',62000,'2026-08-25',
               'derived','proposed',?)`, [NOW]);

  run(`INSERT INTO fin_open_items (tenant_id, open_item_code, entity_slug, question, routed_role,
        status, citations, not_included, provenance, basis_state, recorded_at)
       VALUES ('primary','oi-transfers','cafe',
               'How should three transfers between the cafe and the household be recorded?',
               'tax professional','draft',
               '[{"kind":"statement","ref":"st-cafe-jun","as_of":"2026-06-30"}]',
               '["The cafe checking statement for July, which has arrived but has not been read"]',
               'derived','proposed',?)`, [NOW]);

  run(`INSERT INTO fin_reconciliations (tenant_id, reconciliation_uid, entity_slug, account_slug,
        period_start, period_end, measure, state, delta_minor, computed_at, recorded_at)
       VALUES ('primary','rec-rent-jul','rental',NULL,'2026-07-01','2026-07-31','period_receipts',
               'mismatched',15000,?,?)`, [NOW, NOW]);
  run(`INSERT INTO fin_reconciliation_claims (tenant_id, claim_uid, reconciliation_uid, label,
        amount_minor, as_of, claim_ref_table, claim_ref_uid, provenance, source_doc_uid,
        source_locator, basis_state, recorded_at)
       VALUES ('primary','claim-pm','rec-rent-jul','The property manager statement',215000,
               '2026-07-31','fin_documents','doc-pm-jul','extracted','doc-pm-jul','page 1','confirmed',?)`, [NOW]);
  run(`INSERT INTO fin_reconciliation_claims (tenant_id, claim_uid, reconciliation_uid, label,
        amount_minor, as_of, provenance, basis_state, recorded_at)
       VALUES ('primary','claim-owner','rec-rent-jul','The figure you gave us',230000,'2026-08-10',
               'owner_stated','confirmed',?)`, [NOW]);
}

{
  const db = freshDb();
  seed(db);
  const env = d1(db);

  /* ---- absent is not empty ---- */
  const bare = freshDb({ throughLedger: false });
  const bareInstall = await ledgerInstalled(d1(bare));
  check("a brain without the ledger migration reports it is not installed",
    bareInstall.installed === false && bareInstall.missing.length === __testing.LEDGER_TABLES.length,
    JSON.stringify(bareInstall).slice(0, 120));
  const bareSnapshot = await ledgerSnapshot(d1(bare));
  check("an un-migrated brain returns ledger_installed false rather than an empty ledger",
    bareSnapshot.ledger_installed === false && bareSnapshot.cash === null);
  bare.close();

  const emptyDb = freshDb();
  const emptySnapshot = await ledgerSnapshot(d1(emptyDb));
  check("a migrated but empty brain is installed and empty, which is a different answer",
    emptySnapshot.ledger_installed === true && emptySnapshot.accounts.length === 0 &&
      emptySnapshot.cash.total_minor === null && emptySnapshot.cash.accounts_considered === 0,
    JSON.stringify(emptySnapshot.cash));
  emptyDb.close();

  /* ---- entities ---- */
  const { entities } = await ledgerEntities(env);
  check("superseded entity rows are not returned", entities.filter((e) => e.entity_slug === "rental").length === 1);
  check("the surviving entity row is the one read from the document",
    entities.find((e) => e.entity_slug === "rental")?.provenance === "extracted");
  check("the superseding row keeps its page reference",
    entities.find((e) => e.entity_slug === "rental")?.source_locator === "page 1");
  check("a counterparty is returned and flagged, not filtered away",
    entities.find((e) => e.entity_slug === "buyer-co")?.counterparty === true);
  check("fixed scopes sort first", entities[0].fixed === true, entities[0].entity_slug);
  check("ownership is an integer in basis points, never a float",
    Number.isInteger(entities.find((e) => e.entity_slug === "cafe").ownership_bp));

  /* ---- accounts and coverage ---- */
  const { accounts } = await ledgerAccounts(env);
  const cafeChecking = accounts.find((a) => a.account_slug === "cafe-checking");
  check("coverage joins onto its account", cafeChecking.coverage_status === "partial");
  check("a partial account carries the date its records reach", cafeChecking.covered_to === "2026-06-30");
  check("an account with no refresh expectation returns null, not a value",
    accounts.find((a) => a.account_slug === "rental-checking").expected_cadence === null);
  check("balance role travels with every account so no caller re-derives it",
    accounts.find((a) => a.account_slug === "cafe-card").balance_role === "liability");
  const scoped = await ledgerAccounts(env, { entitySlug: "cafe" });
  check("an entity scope narrows the account list", scoped.accounts.length === 2,
    scoped.accounts.map((a) => a.account_slug).join(","));

  /* ---- the cash figure, which is the one most able to be confidently wrong ---- */
  const cash = await ledgerCashPosition(env);
  check("only deposit accounts are considered for cash", cash.accounts_considered === 3,
    String(cash.accounts_considered));
  check("the card is excluded and the reason is returned",
    cash.excluded.some((e) => e.account_slug === "cafe-card" && e.reason === "money_owed_not_held"),
    JSON.stringify(cash.excluded));
  check("only the account with a confirmed figure at the position date is covered",
    cash.accounts_covered === 1 && cash.covered[0].account_slug === "home-checking",
    JSON.stringify(cash.covered));
  check("the figure is dated to its own source, not to the last update",
    cash.covered[0].as_of === "2026-07-31" && cash.covered[0].figure_source === "statement");
  check("the position states the one day every summed figure is true of",
    cash.as_of === "2026-07-31", String(cash.as_of));
  check("the total is exactly the covered accounts and nothing else",
    cash.total_minor === 8421000, String(cash.total_minor));
  // The account IS readable, through June. Adding a June balance to a July one
  // makes a figure that was true of no moment that ever existed.
  check("an account whose confirmed figure is a month older is not summed in at its stale value",
    cash.missing.some((m) => m.account_slug === "cafe-checking" &&
      m.reason === "no_confirmed_figure_at_as_of" && m.last_confirmed_as_of === "2026-06-30"),
    JSON.stringify(cash.missing));
  check("the excluded account's stale amount is not in the payload at all",
    !JSON.stringify(cash.missing).includes("1431500"), JSON.stringify(cash.missing));
  check("asking for a period end the records do reach covers that account instead",
    (await ledgerCashPosition(env, { asOf: "2026-06-30" })).covered
      .some((c) => c.account_slug === "cafe-checking"));
  check("a never-connected account is reported as never connected, not as empty",
    cash.missing.some((m) => m.account_slug === "rental-checking" && m.reason === "never_connected"));
  check("the figure says it is not complete", cash.complete === false);

  // A second currency must stop the total rather than add unlike units.
  db.prepare(
    `INSERT INTO fin_accounts (tenant_id, account_slug, entity_slug, label, account_kind,
       balance_role, currency, provenance, basis_state, recorded_at)
     VALUES ('primary','eu-savings','household','Savings abroad','savings','asset','EUR','owner_stated','confirmed',?)`
  ).run(NOW);
  db.prepare(
    `INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start, period_end,
       closing_balance_minor, currency, parse_state, provenance, source_doc_uid, basis_state, recorded_at)
     VALUES ('primary','st-eu','eu-savings','2026-07-01','2026-07-31',500000,'EUR','parsed','extracted','doc-eu','confirmed',?)`
  ).run(NOW);
  const mixed = await ledgerCashPosition(env);
  check("two currencies produce no total rather than a meaningless one",
    mixed.total_minor === null && mixed.mixed_currency === true && mixed.covered.length === 2,
    JSON.stringify({ total: mixed.total_minor, mixed: mixed.mixed_currency }));
  db.prepare("DELETE FROM fin_statements WHERE statement_uid = 'st-eu'").run();
  db.prepare("DELETE FROM fin_accounts WHERE account_slug = 'eu-savings'").run();

  // A figure the extractor was unsure of is not a balance.
  db.prepare(
    `INSERT INTO fin_statements (tenant_id, statement_uid, account_slug, period_start, period_end,
       closing_balance_minor, parse_state, provenance, source_doc_uid, confidence_bp, basis_state, recorded_at)
     VALUES ('primary','st-cafe-jul-guess','cafe-checking','2026-07-01','2026-07-31',9999900,'parsed',
             'extracted','doc-photo',2200,'proposed',?)`
  ).run(NOW);
  const withProposed = await ledgerCashPosition(env);
  check("a proposed figure is never summed into a cash total",
    withProposed.total_minor === 8421000 &&
      withProposed.missing.some((m) => m.account_slug === "cafe-checking"),
    String(withProposed.total_minor));
  db.prepare("DELETE FROM fin_statements WHERE statement_uid = 'st-cafe-jul-guess'").run();

  /* ---- unsorted spending ---- */
  const unsorted = await ledgerUnsortedSpending(env, { accountSlug: "cafe-card" });
  const card = unsorted.by_account.find((r) => r.account_slug === "cafe-card");
  check("unsorted spending counts only settled, live, readable outflows",
    card.outflow_minor === 294000 && card.counted_lines === 2,
    JSON.stringify(card));
  check("the lines it could not read are counted separately, not dropped",
    card.unreadable_lines === 1, JSON.stringify(card));

  /* ---- deadlines ---- */
  const { deadlines } = await ledgerDeadlines(env);
  check("a closed deadline is not returned as outstanding work",
    !deadlines.some((d) => d.deadline_uid === "dl-done"), deadlines.map((d) => d.deadline_uid).join(","));
  check("urgency orders the register and is never itself a label",
    deadlines[0].deadline_uid === "dl-undated", deadlines.map((d) => d.deadline_uid).join(","));
  check("an undated deadline is kept, not dropped",
    deadlines.some((d) => d.due_date === null));
  check("a confirmed deadline names what it rests on",
    deadlines.find((d) => d.deadline_uid === "dl-insurance").basis_note !== null);
  check("a deadline the brain proposed says so",
    deadlines.find((d) => d.deadline_uid === "dl-salestax").basis_state === "proposed");
  check("who is waited on survives to the caller",
    deadlines.find((d) => d.deadline_uid === "dl-salestax").waiting_on === "Bookkeeper: the June export");

  /* ---- exceptions ---- */
  const { exceptions } = await ledgerExceptions(env);
  const transfers = exceptions.find((e) => e.exception_uid === "x-transfers");
  check("an exception carries its amount in minor units and its own first-seen date",
    transfers.amount_minor === 418000 && transfers.first_seen === "2026-08-12");
  check("the brain's reading arrives labelled as a proposal",
    transfers.proposal !== null && transfers.basis_state === "proposed");
  check("the proposal carries its confidence", transfers.proposal_confidence_bp === 6200);

  /* ---- reconciliation: a disagreement is a state, not a winner ---- */
  const { reconciliations } = await ledgerReconciliations(env);
  const rent = reconciliations[0];
  check("a disagreement rests at mismatched", rent.state === "mismatched");
  check("both claims are returned, neither overwritten", rent.claims.length === 2,
    JSON.stringify(rent.claims.map((c) => c.label)));
  check("each claim carries its own as-of date",
    rent.claims.every((c) => typeof c.as_of === "string" && c.as_of.length === 10));
  check("the difference is reported in minor units", rent.delta_minor === 15000);
  check("nothing resolves the mismatch to one side",
    rent.ruled_claim_uid === null && rent.ruling_consumed === false);
  check("a claim from a document names the document it was read from",
    rent.claims.find((c) => c.provenance === "extracted").source_doc_uid === "doc-pm-jul");
  check("a claim the owner gave from memory is kept with no document and says so",
    rent.claims.find((c) => c.provenance === "owner_stated").source_doc_uid === null);

  // An owner ruling is recorded beside both figures and changes neither.
  db.prepare(
    `UPDATE fin_reconciliations SET ruled_claim_uid = 'claim-pm', ruled_at = '2026-08-27',
       ruled_by_party = 'owner' WHERE reconciliation_uid = 'rec-rent-jul'`
  ).run();
  const ruled = await ledgerReconciliations(env);
  check("a ruling is recorded without collapsing the claims",
    ruled.reconciliations[0].ruled_claim_uid === "claim-pm" &&
      ruled.reconciliations[0].claims.length === 2 &&
      ruled.reconciliations[0].state === "mismatched");
  check("nothing claims the ruling is being used yet",
    ruled.reconciliations[0].ruling_consumed === false);

  /* ---- obligations ---- */
  const obligations = await ledgerObligations(env);
  check("a personal guarantee names the document and the place inside it",
    obligations.obligations.find((o) => o.obligation_uid === "ob-loan").personal_guarantee_locator ===
      "page 9, clause 14");
  check("guarantees found are counted", obligations.exposure.guaranteed === 1);
  // The distinction the summary exists to preserve.
  check("obligations nobody has examined are counted apart from those checked and clear",
    obligations.exposure.guarantee_not_examined === 1 && obligations.exposure.guarantee_none_found === 0,
    JSON.stringify(obligations.exposure));
  check("exposure names how many balances it covers",
    obligations.exposure.obligations_with_balance === 1 &&
      obligations.exposure.obligations_total === 2);

  /* ---- documents: facts, no client word ---- */
  const { documents } = await ledgerDocuments(env);
  const photo = documents.find((d) => d.fin_doc_uid === "doc-photo");
  check("a document that could not be read says so and keeps its reason",
    photo.readable === false && photo.unreadable_reason.length > 0);
  check("a document the owner can get names where from and roughly how long",
    documents.find((d) => d.fin_doc_uid === "doc-return").available_from === "the accountant");
  check("custody facts are returned for the caller to derive a word from",
    documents.find((d) => d.fin_doc_uid === "doc-june").reconciled_through === "2026-06-30");
  check("a document not in the corpus says so rather than pretending it is searchable",
    documents.find((d) => d.fin_doc_uid === "doc-return").in_corpus === false);

  /* ---- open items ---- */
  const { open_items: openItems } = await ledgerOpenItems(env);
  check("an open item's citations parse into a list", openItems[0].citations.length === 1);
  check("what a packet leaves out travels with it", openItems[0].not_included.length === 1);
  check("status records what the owner said, and ships as a draft", openItems[0].status === "draft");

  /* ---- the whole snapshot ---- */
  const snapshot = await ledgerSnapshot(env);
  check("the snapshot reports the ledger is installed", snapshot.ledger_installed === true);
  check("the snapshot carries every collection a client surface hydrates from",
    snapshot.entities.length > 0 && snapshot.accounts.length > 0 && snapshot.documents.length > 0 &&
      snapshot.deadlines.length > 0 && snapshot.exceptions.length > 0 &&
      snapshot.reconciliations.length > 0 && snapshot.open_items.length > 0 &&
      snapshot.obligations.length > 0 && snapshot.cash !== null);

  // The wire carries stored enum values, never a word a client reads on a chip.
  // A client word on the wire freezes a rendering decision in the wrong place
  // and makes every later disagreement about it a deploy.
  const wire = JSON.stringify(snapshot);
  const clientWords = ['"FILED"', '"CURRENT"', '"NEEDS"', '"WORKING"', '"PROBLEM"',
                       "Needs you", "Working on it"];
  const leaked = clientWords.filter((w) => wire.includes(w));
  check("no client-facing outcome word appears anywhere on the wire",
    leaked.length === 0, leaked.join(", "));

  // Every amount that crossed the wire is an integer.
  const amounts = [...wire.matchAll(/"[a-z_]*_minor":(-?[0-9.]+)/g)].map((m) => Number(m[1]));
  check(`all ${amounts.length} amounts on the wire are integers in minor units`,
    amounts.every((n) => Number.isInteger(n)), amounts.filter((n) => !Number.isInteger(n)).join(","));

  /* ---- an unreachable database must not read as a zero balance ---- */
  const broken = d1(db, { failEverything: true });
  const brokenCash = await ledgerCashPosition(broken);
  check("an unreachable database returns unavailable, not a total of zero",
    brokenCash.unavailable === true && brokenCash.total_minor === null,
    JSON.stringify(brokenCash).slice(0, 120));
  const brokenDeadlines = await ledgerDeadlines(broken);
  check("an unreachable database returns unavailable, not an empty register",
    brokenDeadlines.unavailable === true && brokenDeadlines.deadlines.length === 0);

  /* ---- tenant isolation is applied on every read, today, at one tenant ---- */
  db.prepare(
    `INSERT INTO fin_entities (tenant_id, entity_slug, legal_name, kind, provenance,
       basis_state, recorded_at)
     VALUES ('second','household','A different household','household','owner_stated','confirmed',?)`
  ).run(NOW);
  const primaryOnly = await ledgerEntities(env);
  check("a second tenant's rows are not returned by a default-tenant read",
    !primaryOnly.entities.some((e) => e.legal_name === "A different household"));
  const secondTenant = await ledgerEntities(env, { tenantId: "second" });
  check("the second tenant sees exactly its own row",
    secondTenant.entities.length === 1 && secondTenant.entities[0].legal_name === "A different household");
  check("the default tenant is the one every single-brain install writes",
    DEFAULT_TENANT === "primary");

  db.close();
}

/* ------------------------------------------------------- small guarantees -- */
{
  check("a non-numeric limit becomes the default rather than reaching SQL as NaN",
    __testing.boundedLimit("abc") === 200 && __testing.boundedLimit("0") === 200 &&
      __testing.boundedLimit("-5") === 200);
  check("a limit is clamped rather than trusted", __testing.boundedLimit("99999") === 1000);
  check("a sane limit survives", __testing.boundedLimit("25") === 25);
  check("malformed stored JSON renders as nothing rather than breaking a page",
    __testing.parseJsonList("{not json") .length === 0 &&
      __testing.parseJsonList('{"a":1}').length === 0 &&
      __testing.parseJsonList('["a"]').length === 1);
}

console.log(fail ? `\n${fail} FAILURES` : `\nfin-d1: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
