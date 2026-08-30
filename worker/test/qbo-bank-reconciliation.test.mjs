import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdReconcileQuickBooks, splitStatements } from "../../brain.mjs";
import {
  QuickBooksReconciliationError,
  quickBooksBankReconciliationStatus,
  runQuickBooksBankReconciliation,
} from "../src/lib/qbo-bank-reconciliation.js";
import { handleFinApi } from "../src/lib/fin-api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const NOW = "2026-08-30T12:00:00Z";
const QBO_COMPANY = "a".repeat(64);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) db.exec(statement);
  }
  db.exec(`INSERT INTO install_state (id, client_slug, product_version, installed_at)
           VALUES (1, 'fixture', '0.0.0-test', '${NOW}')`);
  return db;
}

function d1(db, { fail = false } = {}) {
  const make = (sql, params = []) => ({
    _sql: sql,
    _params: params,
    bind: (...next) => make(sql, next),
    all: async () => {
      if (fail) throw new Error("database unavailable");
      return { results: db.prepare(sql).all(...params) };
    },
    first: async () => {
      if (fail) throw new Error("database unavailable");
      return db.prepare(sql).get(...params) ?? null;
    },
    run: async () => {
      if (fail) throw new Error("database unavailable");
      const result = db.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes || 0) } };
    },
  });
  return {
    ADMIN_KEY: "fixture-admin-key",
    DB: {
      prepare: (sql) => make(sql),
      batch: async (statements) => {
        if (fail) throw new Error("database unavailable");
        db.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => {
            const result = db.prepare(statement._sql).run(...statement._params);
            return { meta: { changes: Number(result.changes || 0) } };
          });
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}

function seedAccount(db, slug, coverage = "complete") {
  db.prepare(`INSERT INTO fin_entities
    (tenant_id, entity_slug, legal_name, kind, provenance, basis_state, recorded_at)
    VALUES ('primary','fixture-entity','Fixture Entity','business','owner_stated','confirmed',?)
    ON CONFLICT DO NOTHING`).run(NOW);
  db.prepare(`INSERT INTO fin_accounts
    (tenant_id, account_slug, entity_slug, account_kind, balance_role, currency,
     feed_mode, provenance, source_feed, basis_state, recorded_at)
    VALUES ('primary',?,'fixture-entity','checking','asset','USD','live','feed','bank-feed:fixture','confirmed',?)`).run(slug, NOW);
  db.prepare(`INSERT INTO fin_account_coverage
    (tenant_id, account_slug, coverage_status, covered_from, covered_to, computed_at,
     provenance, source_feed, basis_state, recorded_at)
    VALUES ('primary',?,?, '2026-07-01','2026-07-31',?,'derived','bank-feed:fixture','confirmed',?)`).run(slug, coverage, NOW, NOW);
}

function bank(db, uid, account, date, amount) {
  db.prepare(`INSERT INTO fin_transactions
    (tenant_id, txn_uid, account_slug, posted_on, amount_minor, direction,
     raw_amount_minor, raw_sign_convention, currency, pending, provenance,
     source_locator, source_feed, basis_state, recorded_at)
    VALUES ('primary',?,?,?,?,'outflow',?,'feed_positive_amount_is_outflow','USD',0,
            'feed',?,'bank-feed:fixture','confirmed',?)`).run(
    uid, account, date, amount, amount, `fin_transactions:${uid}`, NOW,
  );
}

function qbo(db, uid, date, amount, accountId = "qbo-35") {
  const sourceDocUid = `quickbooks:purchase:${uid}`;
  db.prepare(`INSERT OR IGNORE INTO documents
    (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
    VALUES (?, 'quickbooks', ?, 'Fixture QuickBooks purchase', 1, ?, '{}')`).run(
    sourceDocUid, `purchase:${uid}`, `hash-${uid}`,
  );
  db.prepare("UPDATE documents SET meta=? WHERE doc_uid=?").run(
    JSON.stringify({ qbo_company_fingerprint: QBO_COMPANY }), sourceDocUid,
  );
  return {
    line_uid: `purchase:${uid}`,
    qbo_account_id: accountId,
    qbo_company_fingerprint: QBO_COMPANY,
    posted_on: date,
    amount_minor: amount,
    direction: "outflow",
    currency: "USD",
    source_doc_uid: sourceDocUid,
    source_locator: `QuickBooks Purchase ${uid}; fields TxnDate, TotalAmt, AccountRef`,
  };
}

const scope = {
  account_slug: "operating-checking",
  qbo_account_id: "qbo-35",
  qbo_company_fingerprint: QBO_COMPANY,
  period_start: "2026-07-01",
  period_end: "2026-07-31",
  direction: "outflow",
  currency: "USD",
  qbo_coverage: "present_snapshot_partial",
};

{
  const db = freshDb();
  seedAccount(db, scope.account_slug);
  bank(db, "bank-exact", scope.account_slug, "2026-07-05", 10_000);
  bank(db, "bank-error", scope.account_slug, "2026-07-10", 25_000);
  bank(db, "bank-dupe", scope.account_slug, "2026-07-15", 5_000);
  bank(db, "bank-date", scope.account_slug, "2026-07-20", 7_000);
  bank(db, "bank-only", scope.account_slug, "2026-07-28", 8_000);
  const qboLines = [
    qbo(db, "exact", "2026-07-05", 10_000),
    qbo(db, "planted-error", "2026-07-10", 26_000),
    qbo(db, "dupe-a", "2026-07-15", 5_000),
    qbo(db, "dupe-b", "2026-07-15", 5_000),
    qbo(db, "date", "2026-07-21", 7_000),
    qbo(db, "only", "2026-07-25", 9_000),
  ];
  const transactionsBefore = JSON.stringify(db.prepare("SELECT * FROM fin_transactions ORDER BY txn_uid").all());
  const documentsBefore = JSON.stringify(db.prepare("SELECT * FROM documents ORDER BY doc_uid").all());

  const result = await runQuickBooksBankReconciliation(d1(db), { ...scope, qbo_lines: qboLines }, { now: NOW });
  assert.equal(result.status, "mismatched");
  assert.equal(result.financial_authority, false);
  assert.equal(result.mutated_source_records, false);
  assert.deepEqual(new Set(result.classifications.map((item) => item.classification)), new Set([
    "exact_unique", "amount_mismatch", "ambiguous_duplicates", "date_mismatch", "qbo_only", "bank_only",
  ]));
  const planted = result.classifications.find((item) => item.classification === "amount_mismatch");
  assert.equal(planted.delta_minor, 1_000);
  assert.equal(planted.quickbooks[0].source_doc_uid, "quickbooks:purchase:planted-error");
  assert.equal(planted.bank[0].record_uid, "bank-error");
  assert.match(planted.quickbooks[0].locator, /TxnDate, TotalAmt, AccountRef/);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_exceptions").get().n, 5);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM fin_transactions ORDER BY txn_uid").all()), transactionsBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM documents ORDER BY doc_uid").all()), documentsBefore);

  const replay = await runQuickBooksBankReconciliation(d1(db), { ...scope, qbo_lines: qboLines }, { now: NOW });
  assert.equal(replay.reconciliation_uid, result.reconciliation_uid);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_exceptions").get().n, 5);

  const status = await quickBooksBankReconciliationStatus(d1(db), scope);
  assert.equal(status.status, "mismatched");
  assert.equal(status.claims.length, 2);
  assert.equal(status.ruling_consumed, false);
  assert.equal(status.scope.qbo_company_fingerprint, QBO_COMPANY);
  await assert.rejects(
    quickBooksBankReconciliationStatus(d1(db), { ...scope, qbo_account_id: "qbo-wrong-status" }),
    (error) => error instanceof QuickBooksReconciliationError && error.code === "qbo_account_pairing_conflict",
  );

  const statusRequest = new Request("https://brain.invalid/api/fin/reconcile/quickbooks-bank", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": "fixture-admin-key" },
    body: JSON.stringify({ action: "status", ...scope }),
  });
  const statusResponse = await handleFinApi(
    d1(db), statusRequest, new URL(statusRequest.url), "/api/fin/reconcile/quickbooks-bank",
  );
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status, "mismatched");

  await assert.rejects(
    runQuickBooksBankReconciliation(d1(db), {
      ...scope,
      qbo_account_id: "qbo-other",
      qbo_lines: [{ ...qboLines[0], qbo_account_id: "qbo-other" }],
    }, { now: NOW }),
    (error) => error instanceof QuickBooksReconciliationError && error.code === "qbo_account_pairing_conflict",
  );

  const improvedLines = [
    qbo(db, "improved-exact", "2026-07-05", 10_000),
    qbo(db, "improved-error", "2026-07-10", 25_000),
    qbo(db, "improved-dupe", "2026-07-15", 5_000),
    qbo(db, "improved-date", "2026-07-20", 7_000),
    qbo(db, "improved-only", "2026-07-28", 8_000),
  ];
  const improvedTransactionsBefore = JSON.stringify(db.prepare("SELECT * FROM fin_transactions ORDER BY txn_uid").all());
  const improvedDocumentsBefore = JSON.stringify(db.prepare("SELECT * FROM documents ORDER BY doc_uid").all());
  const improved = await runQuickBooksBankReconciliation(
    d1(db), { ...scope, qbo_lines: improvedLines }, { now: "2026-08-31T12:00:00Z" },
  );
  assert.equal(improved.status, "insufficient_evidence");
  assert.equal(improved.acceptance_state, "blocked_incomplete_coverage");
  assert.equal(improved.classifications.every((item) => item.classification === "exact_unique"), true);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_exceptions WHERE resolved_at IS NULL").get().n, 0);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM fin_transactions ORDER BY txn_uid").all()), improvedTransactionsBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM documents ORDER BY doc_uid").all()), improvedDocumentsBefore);
  db.close();
}

{
  const db = freshDb();
  seedAccount(db, "partial-checking", "partial");
  bank(db, "bank-partial", "partial-checking", "2026-07-05", 10_000);
  const exact = qbo(db, "partial", "2026-07-05", 10_000, "qbo-partial");
  const result = await runQuickBooksBankReconciliation(d1(db), {
    ...scope,
    account_slug: "partial-checking",
    qbo_account_id: "qbo-partial",
    qbo_lines: [exact],
  }, { now: NOW });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.coverage.bank, "partial");
  assert.equal(db.prepare("SELECT state FROM fin_reconciliations").get().state, "insufficient_evidence");
  assert.equal(db.prepare("SELECT delta_minor FROM fin_reconciliations").get().delta_minor, null);
  db.close();
}

{
  const unavailable = await runQuickBooksBankReconciliation(d1(freshDb(), { fail: true }), {
    ...scope, qbo_lines: [],
  }, { now: NOW });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.error_code, "bank_evidence_unavailable");
  assert.deepEqual(unavailable.classifications, []);
}

{
  const db = freshDb();
  seedAccount(db, scope.account_slug);
  bank(db, "bank-missing-doc", scope.account_slug, "2026-07-05", 10_000);
  await assert.rejects(
    runQuickBooksBankReconciliation(d1(db), {
      ...scope,
      qbo_lines: [{
        line_uid: "purchase:missing",
        qbo_account_id: scope.qbo_account_id,
        qbo_company_fingerprint: QBO_COMPANY,
        posted_on: "2026-07-05",
        amount_minor: 10_000,
        direction: "outflow",
        currency: "USD",
        source_doc_uid: "quickbooks:purchase:missing",
        source_locator: "QuickBooks Purchase missing; fields TxnDate, TotalAmt, AccountRef",
      }],
    }, { now: NOW }),
    (error) => error.code === "qbo_source_documents_missing",
  );
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 0);

  const request = new Request("https://brain.invalid/api/fin/reconcile/quickbooks-bank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "status", ...scope }),
  });
  const unauthorized = await handleFinApi(
    d1(db), request, new URL(request.url), "/api/fin/reconcile/quickbooks-bank",
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).code, "admin_key_required");
  db.close();
}

{
  const db = freshDb();
  seedAccount(db, scope.account_slug);
  bank(db, "bank-company-mismatch", scope.account_slug, "2026-07-05", 10_000);
  const line = qbo(db, "company-mismatch", "2026-07-05", 10_000);
  const otherCompany = "b".repeat(64);
  await assert.rejects(
    runQuickBooksBankReconciliation(d1(db), {
      ...scope,
      qbo_company_fingerprint: otherCompany,
      qbo_lines: [{ ...line, qbo_company_fingerprint: otherCompany }],
    }, { now: NOW }),
    (error) => error instanceof QuickBooksReconciliationError &&
      error.code === "qbo_company_identity_mismatch",
  );
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_exceptions").get().n, 0);
  db.close();
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-reconcile-cli-"));
  const manifestPath = join(folder, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    brain: { domain: "brain.fixture.invalid" },
    corpora: {
      quickbooks: {
        enabled: true,
        environment: "sandbox",
        source: "quickbooks",
        entities: ["Purchase"],
      },
    },
  }));
  const flags = {
    account: "operating-checking",
    "qbo-account": "qbo-35",
    from: "2026-07-01",
    to: "2026-07-31",
    direction: "outflow",
    json: true,
  };
  let posted;
  let assertedBinding = null;
  let expectedCompanyFingerprint = null;
  const logs = [];
  const original = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    const result = await cmdReconcileQuickBooks(manifestPath, flags, {
      resolveAdminKey: () => "fixture-admin-secret",
      resolveBaseUrl: async () => "https://brain.fixture.invalid",
      oauth: {
        providerAccessToken: async () => ({
          accessToken: "fixture-oauth-secret",
          connection: { provider_metadata: { realm_id: "private-realm-id" } },
        }),
        assertQuickBooksSourceBinding: (_connection, scope) => {
          assertedBinding = scope;
          return { qbo_company_fingerprint: QBO_COMPANY };
        },
      },
      quickbooks: {
        QBO_DEFAULT_ENTITIES: ["Purchase"],
        QBO_RECONCILIATION_ENTITIES: ["Purchase"],
        quickBooksCompanyFingerprint: () => QBO_COMPANY,
        syncQuickBooksOnline: async (options) => {
          expectedCompanyFingerprint = options.expectedCompanyFingerprint;
          return {
          documents: [{
            source_id: `company:${QBO_COMPANY}:purchase:planted`,
            metadata: { reconciliation_lines: [{
              line_uid: "purchase:planted",
              qbo_account_id: "qbo-35",
              posted_on: "2026-07-10",
              amount_minor: 26_000,
              direction: "outflow",
              currency: "USD",
              source_locator: "QuickBooks Purchase planted; fields TxnDate, TotalAmt, AccountRef",
            }] },
          }],
          };
        },
      },
      postReconciliation: async (request) => {
        posted = request;
        return {
          schema_version: 1,
          command: "reconcile.quickbooks_bank",
          status: "mismatched",
          error_code: null,
          classifications: [{ classification: "amount_mismatch" }],
          financial_authority: false,
          mutated_source_records: false,
          retry_safe: true,
        };
      },
    });
    assert.equal(result.status, "mismatched");
    assert.deepEqual(assertedBinding, { source: "quickbooks", environment: "sandbox" });
    assert.equal(expectedCompanyFingerprint, QBO_COMPANY);
    assert.equal(
      posted.payload.qbo_lines[0].source_doc_uid,
      `quickbooks:company:${QBO_COMPANY}:purchase:planted`,
    );
    assert.equal(posted.payload.qbo_coverage, "present_snapshot_partial");
  } finally {
    console.log = original;
    rmSync(folder, { recursive: true, force: true });
  }
  assert.doesNotMatch(logs.join("\n"), /fixture-admin-secret|fixture-oauth-secret|private-realm-id/);
  assert.equal(JSON.parse(logs.join("\n")).financial_authority, false);
}

console.log("QuickBooks bank reconciliation: planted discrepancy, ambiguity, coverage, custody, retry, and privacy contracts passed");
