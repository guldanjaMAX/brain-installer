import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdReconcileTaxQuickBooks, splitStatements } from "../../brain.mjs";
import { handleFinApi } from "../src/lib/fin-api.js";
import {
  TaxQuickBooksReconciliationError,
  runTaxQuickBooksReconciliation,
} from "../src/lib/tax-qbo-reconciliation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const NOW = "2026-08-30T12:00:00Z";
const COMPANY = "c".repeat(64);

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

function seedEvidence(db, { reportFingerprint = COMPANY, reportSource = "quickbooks" } = {}) {
  db.prepare(`INSERT INTO fin_entities
    (tenant_id, entity_slug, legal_name, kind, provenance, basis_state, recorded_at)
    VALUES ('primary','fixture-cafe','Fixture Cafe LLC','business','owner_stated','confirmed',?)`).run(NOW);
  const docs = [
    ["tax:return:2025", "local", "tax-return-2025", "Fixture tax return", {}],
    ["books:pnl:2025", reportSource, "qbo-pnl-2025", "Fixture QuickBooks report",
      reportFingerprint ? { qbo_company_fingerprint: reportFingerprint } : {}],
    ["quickbooks:purchase:company-anchor", "quickbooks", "purchase:company-anchor", "Fixture QBO anchor",
      { qbo_company_fingerprint: COMPANY }],
  ];
  for (const [uid, source, sourceId, title, meta] of docs) {
    db.prepare(`INSERT INTO documents
      (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
      VALUES (?, ?, ?, ?, 1, ?, ?)`).run(uid, source, sourceId, title, `hash-${sourceId}`, JSON.stringify(meta));
  }
  db.prepare(`INSERT INTO fin_documents
    (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, tax_year, period_start, period_end,
     custody_class, availability, filed_at, corpus_doc_uid, readable, provenance, basis_state, recorded_at)
    VALUES ('primary','fin-tax-2025','fixture-cafe','tax_return','Fixture filed return',2025,
            '2025-01-01','2025-12-31','reference','have_it','2026-03-10',
            'tax:return:2025',1,'owner_stated','confirmed',?)`).run(NOW);
  db.prepare(`INSERT INTO fin_documents
    (tenant_id, fin_doc_uid, entity_slug, doc_kind, title, period_start, period_end,
     custody_class, availability, filed_at, corpus_doc_uid, readable, provenance, basis_state, recorded_at)
    VALUES ('primary','fin-pnl-2025','fixture-cafe','profit_and_loss','Fixture QBO P&L',
            '2025-01-01','2025-12-31','reference','have_it','2026-03-10',
            'books:pnl:2025',1,'owner_stated','confirmed',?)`).run(NOW);
}

const claim = {
  schema_version: 1,
  confirmation: "owner_confirmed_from_document",
  scope_kind: "single_entity",
  entity_slug: "fixture-cafe",
  legal_entity: "Fixture Cafe LLC",
  tax_year: 2025,
  period_start: "2025-01-01",
  period_end: "2025-12-31",
  currency: "USD",
  tax_accounting_method: "cash",
  tax_document: {
    doc_uid: "tax:return:2025",
    form_name: "Form 1120-S",
    form_version: "2025",
    page: 1,
    line_label: "Line 1a Gross receipts or sales",
    measure: "gross_receipts",
    amount_minor: 10_000_000,
    source_locator: "Form 1120-S (2025), page 1, line 1a",
  },
  quickbooks_report: {
    doc_uid: "books:pnl:2025",
    company_evidence_doc_uid: "quickbooks:purchase:company-anchor",
    report_name: "Profit and Loss",
    total_label: "Total Income",
    measure: "gross_receipts",
    period_start: "2025-01-01",
    period_end: "2025-12-31",
    accounting_basis: "cash",
    currency: "USD",
    amount_minor: 9_999_000,
    source_locator: "Profit and Loss, 2025-01-01 through 2025-12-31, Total Income",
    coverage: "complete_exact_report",
  },
};

async function rejectedWithoutWrite(db, candidate, code) {
  await assert.rejects(
    runTaxQuickBooksReconciliation(d1(db), candidate, { now: NOW }),
    (error) => error instanceof TaxQuickBooksReconciliationError && error.code === code,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 0);
}

{
  const db = freshDb();
  seedEvidence(db);
  const documentsBefore = JSON.stringify(db.prepare("SELECT * FROM documents ORDER BY doc_uid").all());
  const finDocumentsBefore = JSON.stringify(db.prepare("SELECT * FROM fin_documents ORDER BY fin_doc_uid").all());
  const result = await runTaxQuickBooksReconciliation(d1(db), claim, { now: NOW });
  assert.equal(result.status, "mismatched");
  assert.equal(result.delta_minor, 1_000);
  assert.equal(result.confirmation, "owner_confirmed_from_document");
  assert.equal(result.financial_authority, false);
  assert.equal(result.ruling_selected, false);
  assert.equal(result.mutated_source_records, false);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 2);
  const storedClaims = db.prepare("SELECT * FROM fin_reconciliation_claims ORDER BY source_feed").all();
  assert.equal(storedClaims.every((row) => row.provenance === "owner_stated" && row.basis_state === "confirmed"), true);
  assert.equal(storedClaims.every((row) => row.label.includes("owner_confirmed_from_document")), true);
  assert.equal(storedClaims.every((row) => JSON.parse(row.source_locator).confirmation === "owner_confirmed_from_document"), true);
  assert.equal(storedClaims.every((row) => JSON.parse(row.source_locator).measure === "gross_receipts"), true);
  assert.equal(JSON.parse(storedClaims.find((row) => row.source_feed === "quickbooks").source_locator).qbo_company_fingerprint, COMPANY);
  assert.doesNotMatch(JSON.stringify(storedClaims), /machine_extracted/);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM documents ORDER BY doc_uid").all()), documentsBefore);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM fin_documents ORDER BY fin_doc_uid").all()), finDocumentsBefore);

  const replay = await runTaxQuickBooksReconciliation(d1(db), claim, { now: NOW });
  assert.equal(replay.reconciliation_uid, result.reconciliation_uid);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 2);
  await assert.rejects(
    runTaxQuickBooksReconciliation(d1(db), {
      ...claim,
      quickbooks_report: { ...claim.quickbooks_report, amount_minor: 10_000_000 },
    }, { now: NOW }),
    (error) => error.code === "tax_qbo_pairing_conflict",
  );

  const request = new Request("https://brain.invalid/api/fin/reconcile/tax-quickbooks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": "fixture-admin-key" },
    body: JSON.stringify(claim),
  });
  const response = await handleFinApi(d1(db), request, new URL(request.url), "/api/fin/reconcile/tax-quickbooks");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "mismatched");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  const equal = await runTaxQuickBooksReconciliation(d1(db), {
    ...claim,
    quickbooks_report: { ...claim.quickbooks_report, amount_minor: claim.tax_document.amount_minor },
  }, { now: NOW });
  assert.equal(equal.status, "matched");
  assert.equal(equal.delta_minor, 0);
  assert.match(equal.recovery, /do not prove/i);
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await rejectedWithoutWrite(db, { ...claim, legal_entity: "Other Entity LLC" }, "tax_qbo_entity_mismatch");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await rejectedWithoutWrite(db, {
    ...claim,
    quickbooks_report: { ...claim.quickbooks_report, accounting_basis: "accrual" },
  }, "tax_qbo_basis_mismatch");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  const partial = await runTaxQuickBooksReconciliation(d1(db), {
    ...claim,
    quickbooks_report: { ...claim.quickbooks_report, coverage: "partial" },
  }, { now: NOW });
  assert.equal(partial.status, "insufficient_evidence");
  assert.equal(partial.wrote_reconciliation, false);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 0);
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await rejectedWithoutWrite(db, {
    ...claim,
    tax_document: { ...claim.tax_document, doc_uid: "tax:return:missing" },
  }, "tax_qbo_document_missing_or_ambiguous");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db, { reportFingerprint: "d".repeat(64) });
  await rejectedWithoutWrite(db, claim, "qbo_company_identity_mismatch");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db, { reportSource: "local" });
  await rejectedWithoutWrite(db, claim, "qbo_company_identity_mismatch");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await rejectedWithoutWrite(db, {
    ...claim,
    quickbooks_report: { ...claim.quickbooks_report, measure: "total_income" },
  }, "tax_qbo_measure_mismatch");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  db.prepare(`INSERT INTO fin_reconciliations
    (tenant_id, reconciliation_uid, entity_slug, period_start, period_end, measure, state,
     delta_minor, tolerance_minor, currency, computed_at, recorded_at)
    VALUES ('primary','foreign-reconciliation','fixture-cafe','2025-01-01','2025-12-31',
            'period_receipts','open',0,0,'USD',?,?)`).run(NOW, NOW);
  await assert.rejects(
    runTaxQuickBooksReconciliation(d1(db), claim, { now: NOW }),
    (error) => error.code === "tax_qbo_pairing_conflict",
  );
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliation_claims").get().n, 0);
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await runTaxQuickBooksReconciliation(d1(db), claim, { now: NOW });
  db.exec("UPDATE fin_reconciliations SET currency='EUR'");
  await assert.rejects(
    runTaxQuickBooksReconciliation(d1(db), claim, { now: NOW }),
    (error) => error.code === "tax_qbo_pairing_conflict",
  );
  db.exec("UPDATE fin_reconciliations SET currency='USD'");
  db.exec("UPDATE fin_reconciliation_claims SET currency='EUR' WHERE source_feed='quickbooks'");
  await assert.rejects(
    runTaxQuickBooksReconciliation(d1(db), claim, { now: NOW }),
    (error) => error.code === "tax_qbo_pairing_conflict",
  );
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await rejectedWithoutWrite(db, { ...claim, scope_kind: "consolidated" }, "tax_qbo_scope_ambiguous");
  db.close();
}

{
  const db = freshDb();
  seedEvidence(db);
  await rejectedWithoutWrite(db, {
    ...claim,
    currency: "EUR",
    quickbooks_report: { ...claim.quickbooks_report, currency: "EUR" },
  }, "tax_qbo_currency_unsupported");
  db.close();
}

{
  const unavailable = await runTaxQuickBooksReconciliation(d1(freshDb(), { fail: true }), claim, { now: NOW });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.wrote_reconciliation, false);
}

{
  const db = freshDb();
  seedEvidence(db);
  const request = new Request("https://brain.invalid/api/fin/reconcile/tax-quickbooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  });
  const response = await handleFinApi(d1(db), request, new URL(request.url), "/api/fin/reconcile/tax-quickbooks");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "admin_key_required");
  assert.equal(db.prepare("SELECT count(*) n FROM fin_reconciliations").get().n, 0);
  db.close();
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-tax-qbo-cli-"));
  const manifestPath = join(folder, "brain.manifest.json");
  const claimPath = join(folder, "reviewed-tax-claim.json");
  writeFileSync(manifestPath, JSON.stringify({
    brain: { domain: "brain.fixture.invalid" },
    corpora: { quickbooks: { enabled: true, environment: "sandbox" } },
  }));
  writeFileSync(claimPath, JSON.stringify(claim), { mode: 0o600 });
  chmodSync(claimPath, 0o600);
  let posted;
  const logs = [];
  const original = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    await cmdReconcileTaxQuickBooks(manifestPath, {
      "claim-file": claimPath,
      "confirm-reviewed-claims": true,
      json: true,
    }, {
      resolveAdminKey: () => "fixture-admin-secret",
      resolveBaseUrl: async () => "https://brain.fixture.invalid",
      postReconciliation: async (request) => {
        posted = request;
        return {
          schema_version: 1,
          command: "reconcile.tax_quickbooks",
          status: "mismatched",
          confirmation: "owner_confirmed_from_document",
          financial_authority: false,
          wrote_reconciliation: true,
          mutated_source_records: false,
          scope: { legal_entity: "Fixture Cafe LLC" },
          tax_amount_minor: 10_000_000,
          qbo_amount_minor: 9_999_000,
          claims: [{ source_doc_uid: "tax:return:2025", source_locator: "private locator" }],
        };
      },
    });
  } finally {
    console.log = original;
    rmSync(folder, { recursive: true, force: true });
  }
  assert.equal(posted.payload.tax_document.amount_minor, 10_000_000);
  assert.equal(posted.payload.confirmation, "owner_confirmed_from_document");
  assert.doesNotMatch(logs.join("\n"), /fixture-admin-secret|Fixture Cafe LLC|10000000|9999000|tax:return:2025|private locator/);
  assert.equal(JSON.parse(logs.join("\n")).financial_authority, false);
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-tax-qbo-private-file-"));
  const manifestPath = join(folder, "brain.manifest.json");
  const claimPath = join(folder, "reviewed-tax-claim.json");
  writeFileSync(manifestPath, JSON.stringify({
    brain: { domain: "brain.fixture.invalid" },
    corpora: { quickbooks: { enabled: true, environment: "sandbox" } },
  }));
  writeFileSync(claimPath, JSON.stringify(claim), { mode: 0o600 });
  chmodSync(claimPath, 0o644);
  try {
    await assert.rejects(
      cmdReconcileTaxQuickBooks(manifestPath, {
        "claim-file": claimPath,
        "confirm-reviewed-claims": true,
        json: true,
      }),
      (error) => process.platform === "win32" || error?.payload?.error_code === "tax_claim_file_not_owner_only",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-tax-qbo-confirm-"));
  const manifestPath = join(folder, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    brain: { domain: "brain.fixture.invalid" },
    corpora: { quickbooks: { enabled: true, environment: "sandbox" } },
  }));
  await assert.rejects(
    cmdReconcileTaxQuickBooks(manifestPath, { "claim-file": "unused", json: true }, { claim }),
    (error) => error?.payload?.error_code === "tax_qbo_human_confirmation_required",
  );
  rmSync(folder, { recursive: true, force: true });
}

console.log("Tax and QuickBooks human-confirmed claims: planted mismatch, equality, scope, basis, coverage, custody, and privacy contracts passed");
