/**
 * Human-confirmed tax-document versus QuickBooks annual-report claim bridge.
 *
 * This module never extracts a tax value, reads OCR text, or decides which
 * source is correct. It validates two already stored documents and the exact
 * scope a person reviewed, then records two competing owner-stated claims.
 */

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_FINGERPRINT = /^[a-f0-9]{64}$/;
const CONFIRMATION = "owner_confirmed_from_document";
const TAX_DOC_KINDS = new Set(["tax_return"]);
const ACCOUNTING_BASES = new Set(["cash", "accrual"]);
const COMPARISON_MEASURE = "gross_receipts";
const MAX_TEXT = 240;

export class TaxQuickBooksReconciliationError extends Error {
  constructor(code, message, { status = 400, recovery = null } = {}) {
    super(message);
    this.name = "TaxQuickBooksReconciliationError";
    this.code = code;
    this.status = status;
    this.recovery = recovery || message;
  }
}

function fail(code, message, options) {
  throw new TaxQuickBooksReconciliationError(code, message, options);
}

function textValue(value, noun, max = MAX_TEXT) {
  const valueText = String(value || "").trim();
  if (!valueText || valueText.length > max || /[\u0000-\u001f\u007f]/.test(valueText)) {
    fail("invalid_tax_qbo_claim", `${noun} is required and must be bounded plain text`);
  }
  return valueText;
}

function dateValue(value, noun) {
  const text = String(value || "").trim();
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!DATE.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail("invalid_tax_qbo_claim", `${noun} must be an ISO date`);
  }
  return text;
}

function amountValue(value, noun) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("invalid_tax_qbo_claim", `${noun} must be an integer number of minor currency units`);
  }
  return value;
}

function stableId(prefix, parts) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(parts))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}_${hash.toString(16).padStart(16, "0")}`;
}

function checkedClaim(input = {}) {
  if (input.confirmation !== CONFIRMATION) {
    fail(
      "tax_qbo_human_confirmation_required",
      `confirmation must be exactly ${CONFIRMATION}`,
      { recovery: "Have the owner or technician verify both exact document locations and amounts, then submit the reviewed claim again." },
    );
  }
  if (input.scope_kind !== "single_entity") {
    fail(
      "tax_qbo_scope_ambiguous",
      "only a single legal entity can be compared; consolidated or ambiguous scope is refused",
      { recovery: "Prepare a separate claim for one legal entity and one exact annual period." },
    );
  }
  const entitySlug = String(input.entity_slug || "").trim();
  if (!SAFE_SLUG.test(entitySlug)) fail("invalid_tax_qbo_claim", "entity_slug is not safe");
  const legalEntity = textValue(input.legal_entity, "legal_entity");
  const taxYear = input.tax_year;
  if (typeof taxYear !== "number" || !Number.isSafeInteger(taxYear) || taxYear < 1900 || taxYear > 2200) {
    fail("invalid_tax_qbo_claim", "tax_year must be an exact four-digit year");
  }
  const periodStart = dateValue(input.period_start, "period_start");
  const periodEnd = dateValue(input.period_end, "period_end");
  if (periodEnd < periodStart) fail("invalid_tax_qbo_claim", "period_end must not precede period_start");
  const currency = String(input.currency || "").trim().toUpperCase();
  if (currency !== "USD") {
    fail(
      "tax_qbo_currency_unsupported",
      "this reviewed bridge supports USD claims only",
      { recovery: "Do not convert currencies automatically. Prepare a separately reviewed same-currency comparison." },
    );
  }
  const taxBasis = String(input.tax_accounting_method || "").trim().toLowerCase();
  if (!ACCOUNTING_BASES.has(taxBasis)) {
    fail(
      "tax_accounting_basis_required",
      "the tax accounting method must be known as cash or accrual for this comparison",
      { recovery: "Have the owner or tax professional verify the accounting method shown or applicable to the exact tax claim." },
    );
  }

  const tax = input.tax_document && typeof input.tax_document === "object" ? input.tax_document : {};
  const qbo = input.quickbooks_report && typeof input.quickbooks_report === "object" ? input.quickbooks_report : {};
  if (tax.measure !== COMPARISON_MEASURE || qbo.measure !== COMPARISON_MEASURE) {
    fail(
      "tax_qbo_measure_mismatch",
      `both human-confirmed claims must name the exact supported measure ${COMPARISON_MEASURE}`,
      { recovery: "Do not equate a tax line with a QuickBooks total. Have the accounting or tax professional confirm the same gross-receipts measure on both exact document locations." },
    );
  }
  const qboBasis = String(qbo.accounting_basis || "").trim().toLowerCase();
  if (!ACCOUNTING_BASES.has(qboBasis)) {
    fail(
      "qbo_report_basis_required",
      "the QuickBooks report basis must be known as cash or accrual",
      { recovery: "Regenerate or review the exact report with its accounting basis visible." },
    );
  }
  if (qboBasis !== taxBasis) {
    fail(
      "tax_qbo_basis_mismatch",
      "the tax accounting method and QuickBooks report basis do not match",
      { recovery: "Do not compare these totals. Obtain a report on the matching basis or ask the accounting team for a documented adjustment." },
    );
  }
  const qboCurrency = String(qbo.currency || "").trim().toUpperCase();
  if (qboCurrency !== currency) {
    fail("tax_qbo_currency_mismatch", "the QuickBooks report currency does not match the tax claim currency");
  }
  const qboStart = dateValue(qbo.period_start, "quickbooks_report.period_start");
  const qboEnd = dateValue(qbo.period_end, "quickbooks_report.period_end");
  if (qboStart !== periodStart || qboEnd !== periodEnd) {
    fail(
      "tax_qbo_period_mismatch",
      "the QuickBooks report period does not exactly match the tax claim period",
      { recovery: "Generate and review a QuickBooks report for the exact tax period before comparing." },
    );
  }

  return {
    confirmation: CONFIRMATION,
    scope_kind: "single_entity",
    entity_slug: entitySlug,
    legal_entity: legalEntity,
    tax_year: taxYear,
    period_start: periodStart,
    period_end: periodEnd,
    currency,
    tax_accounting_method: taxBasis,
    tax_document: {
      doc_uid: textValue(tax.doc_uid, "tax_document.doc_uid"),
      form_name: textValue(tax.form_name, "tax_document.form_name"),
      form_version: textValue(tax.form_version, "tax_document.form_version"),
      page: (() => {
        const page = tax.page;
        if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 10_000) {
          fail("invalid_tax_qbo_claim", "tax_document.page must be an exact positive page number");
        }
        return page;
      })(),
      line_label: textValue(tax.line_label, "tax_document.line_label"),
      measure: COMPARISON_MEASURE,
      amount_minor: amountValue(tax.amount_minor, "tax_document.amount_minor"),
      source_locator: textValue(tax.source_locator, "tax_document.source_locator", 500),
    },
    quickbooks_report: {
      doc_uid: textValue(qbo.doc_uid, "quickbooks_report.doc_uid"),
      company_evidence_doc_uid: textValue(qbo.company_evidence_doc_uid, "quickbooks_report.company_evidence_doc_uid"),
      report_name: textValue(qbo.report_name, "quickbooks_report.report_name"),
      total_label: textValue(qbo.total_label, "quickbooks_report.total_label"),
      measure: COMPARISON_MEASURE,
      period_start: qboStart,
      period_end: qboEnd,
      accounting_basis: qboBasis,
      currency: qboCurrency,
      amount_minor: amountValue(qbo.amount_minor, "quickbooks_report.amount_minor"),
      source_locator: textValue(qbo.source_locator, "quickbooks_report.source_locator", 500),
      coverage: String(qbo.coverage || "").trim(),
    },
  };
}

async function all(env, sql, binds) {
  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result?.results || [];
}

async function first(env, sql, binds) {
  return env.DB.prepare(sql).bind(...binds).first();
}

async function storedFinancialDocument(env, docUid) {
  const rows = await all(env,
    `SELECT d.doc_uid, d.source, d.meta, f.fin_doc_uid, f.entity_slug, f.doc_kind,
            f.tax_year, f.period_start, f.period_end, f.availability, f.readable
       FROM documents d
       JOIN fin_documents f ON f.corpus_doc_uid=d.doc_uid
      WHERE d.doc_uid=? AND f.tenant_id='primary' AND f.superseded_by_id IS NULL`,
    [docUid]);
  if (rows.length !== 1) {
    fail(
      "tax_qbo_document_missing_or_ambiguous",
      "each cited source must have exactly one live financial-document record",
      { status: 409, recovery: "Register the exact stored document once in the financial document ledger before retrying." },
    );
  }
  const row = rows[0];
  if (row.availability !== "have_it" || Number(row.readable) !== 1) {
    fail(
      "tax_qbo_document_unavailable",
      "a cited document is not both stored and readable",
      { status: 409, recovery: "Obtain a readable stored copy and update its custody record before comparing." },
    );
  }
  return row;
}

function parsedMeta(value) {
  try {
    const result = JSON.parse(value || "{}");
    return result && typeof result === "object" && !Array.isArray(result) ? result : {};
  } catch {
    return {};
  }
}

function claimLocator(kind, claim, evidence) {
  if (kind === "tax") return JSON.stringify({
    confirmation: CONFIRMATION,
    claim_kind: "tax_document_line",
    legal_entity: claim.legal_entity,
    tax_year: claim.tax_year,
    period_start: claim.period_start,
    period_end: claim.period_end,
    accounting_method: claim.tax_accounting_method,
    currency: claim.currency,
    corpus_doc_uid: claim.tax_document.doc_uid,
    fin_doc_uid: evidence.tax.fin_doc_uid,
    form_name: claim.tax_document.form_name,
    form_version: claim.tax_document.form_version,
    page: claim.tax_document.page,
    line_label: claim.tax_document.line_label,
    measure: claim.tax_document.measure,
    exact_locator: claim.tax_document.source_locator,
  });
  return JSON.stringify({
    confirmation: CONFIRMATION,
    claim_kind: "quickbooks_annual_report_total",
    legal_entity: claim.legal_entity,
    period_start: claim.period_start,
    period_end: claim.period_end,
    accounting_basis: claim.quickbooks_report.accounting_basis,
    currency: claim.currency,
    corpus_doc_uid: claim.quickbooks_report.doc_uid,
    fin_doc_uid: evidence.qbo.fin_doc_uid,
    company_evidence_doc_uid: claim.quickbooks_report.company_evidence_doc_uid,
    qbo_company_fingerprint: evidence.companyFingerprint,
    report_name: claim.quickbooks_report.report_name,
    total_label: claim.quickbooks_report.total_label,
    measure: claim.quickbooks_report.measure,
    exact_locator: claim.quickbooks_report.source_locator,
    coverage: claim.quickbooks_report.coverage,
  });
}

function samePair(existingClaims, expected) {
  if (existingClaims.length !== 2) return false;
  const byFeed = new Map(existingClaims.map((row) => [row.source_feed || "tax-document", row]));
  const tax = byFeed.get("tax-document");
  const qbo = byFeed.get("quickbooks");
  if (!tax || !qbo) return false;
  let taxLocator;
  let qboLocator;
  try {
    taxLocator = JSON.parse(tax.source_locator);
    qboLocator = JSON.parse(qbo.source_locator);
  } catch {
    return false;
  }
  return taxLocator?.confirmation === CONFIRMATION && qboLocator?.confirmation === CONFIRMATION &&
    Number(tax.amount_minor) === expected.taxAmountMinor &&
    Number(qbo.amount_minor) === expected.qboAmountMinor &&
    tax.currency === expected.currency && qbo.currency === expected.currency &&
    taxLocator.corpus_doc_uid === expected.taxDocUid &&
    qboLocator.corpus_doc_uid === expected.qboDocUid &&
    qboLocator.qbo_company_fingerprint === expected.companyFingerprint &&
    taxLocator.legal_entity === expected.legalEntity && qboLocator.legal_entity === expected.legalEntity &&
    taxLocator.tax_year === expected.taxYear &&
    taxLocator.period_start === expected.periodStart && taxLocator.period_end === expected.periodEnd &&
    qboLocator.period_start === expected.periodStart && qboLocator.period_end === expected.periodEnd &&
    taxLocator.form_name === expected.formName &&
    taxLocator.form_version === expected.formVersion &&
    taxLocator.page === expected.page &&
    taxLocator.line_label === expected.lineLabel &&
    qboLocator.report_name === expected.reportName &&
    qboLocator.total_label === expected.totalLabel &&
    taxLocator.measure === expected.measure && qboLocator.measure === expected.measure &&
    taxLocator.exact_locator === expected.taxLocator && qboLocator.exact_locator === expected.qboLocator &&
    qboLocator.coverage === "complete_exact_report" &&
    taxLocator.accounting_method === expected.accountingBasis &&
    qboLocator.accounting_basis === expected.accountingBasis;
}

/** Validate the exact human-reviewed evidence and record two competing claims. */
export async function runTaxQuickBooksReconciliation(env, input = {}, options = {}) {
  const claim = checkedClaim(input);
  const now = String(options.now || new Date().toISOString());
  let entity;
  let taxDoc;
  let qboDoc;
  let companyDoc;
  let companyFingerprint;
  let existing;
  let existingClaims = [];
  try {
    entity = await first(env,
      `SELECT entity_slug, legal_name FROM fin_entities
        WHERE tenant_id='primary' AND entity_slug=? AND superseded_by_id IS NULL`,
      [claim.entity_slug]);
    if (!entity || entity.legal_name !== claim.legal_entity) {
      fail(
        "tax_qbo_entity_mismatch",
        "the confirmed legal entity does not exactly match the live financial-ledger entity",
        { recovery: "Stop and verify the exact legal name and entity scope shown on both documents." },
      );
    }
    taxDoc = await storedFinancialDocument(env, claim.tax_document.doc_uid);
    qboDoc = await storedFinancialDocument(env, claim.quickbooks_report.doc_uid);
    companyDoc = await first(env, "SELECT doc_uid, source, meta FROM documents WHERE doc_uid=?", [
      claim.quickbooks_report.company_evidence_doc_uid,
    ]);
    companyFingerprint = String(parsedMeta(companyDoc?.meta).qbo_company_fingerprint || "").toLowerCase();
    if (!companyDoc || companyDoc.source !== "quickbooks" || !COMPANY_FINGERPRINT.test(companyFingerprint)) {
      fail(
        "qbo_company_evidence_required",
        "the cited QuickBooks company evidence is missing or not company-bound",
        { recovery: "Use a stored QuickBooks connector document from the reviewed company as company evidence." },
      );
    }
    const qboDocFingerprint = String(parsedMeta(qboDoc.meta).qbo_company_fingerprint || "").toLowerCase();
    if (qboDoc.source !== "quickbooks" || qboDocFingerprint !== companyFingerprint) {
      fail(
        "qbo_company_identity_mismatch",
        "the report document is not QuickBooks-sourced and bound to the exact reviewed company",
        { recovery: "Stop and use a stored QuickBooks report document carrying the same company fingerprint as the reviewed company evidence." },
      );
    }
    if (!TAX_DOC_KINDS.has(taxDoc.doc_kind) || taxDoc.entity_slug !== claim.entity_slug ||
        Number(taxDoc.tax_year) !== claim.tax_year ||
        taxDoc.period_start !== claim.period_start || taxDoc.period_end !== claim.period_end) {
      fail(
        "tax_document_scope_mismatch",
        "the stored tax document does not match the confirmed entity, tax year, or period",
        { recovery: "Select the exact tax record for this legal entity and annual period." },
      );
    }
    if (qboDoc.doc_kind !== "profit_and_loss" || qboDoc.entity_slug !== claim.entity_slug ||
        qboDoc.period_start !== claim.period_start || qboDoc.period_end !== claim.period_end) {
      fail(
        "qbo_report_scope_mismatch",
        "the stored QuickBooks report record is not an exact profit-and-loss document for this entity and period",
        { recovery: "Register the exact annual QuickBooks profit-and-loss report before comparing." },
      );
    }
    existing = await first(env,
      `SELECT reconciliation_uid, currency FROM fin_reconciliations
        WHERE tenant_id='primary' AND account_slug IS NULL AND entity_slug=?
          AND period_start=? AND period_end=? AND measure='period_receipts'`,
      [claim.entity_slug, claim.period_start, claim.period_end]);
    if (existing) {
      existingClaims = await all(env,
        `SELECT amount_minor, currency, source_locator, source_feed FROM fin_reconciliation_claims
          WHERE tenant_id='primary' AND reconciliation_uid=? ORDER BY claim_uid`,
        [existing.reconciliation_uid]);
    }
  } catch (error) {
    if (error instanceof TaxQuickBooksReconciliationError) throw error;
    return {
      schema_version: 1,
      command: "reconcile.tax_quickbooks",
      status: "unavailable",
      error_code: "tax_qbo_evidence_unavailable",
      recovery: "Verify the ledger migration and both stored document records, then retry the exact reviewed claim.",
      financial_authority: false,
      wrote_reconciliation: false,
      mutated_source_records: false,
    };
  }

  if (claim.quickbooks_report.coverage !== "complete_exact_report") {
    return {
      schema_version: 1,
      command: "reconcile.tax_quickbooks",
      status: "insufficient_evidence",
      error_code: "qbo_report_coverage_incomplete",
      recovery: "Obtain and review a complete exact-period QuickBooks report. Do not infer missing account coverage.",
      confirmation: CONFIRMATION,
      scope: {
        entity_slug: claim.entity_slug,
        legal_entity: claim.legal_entity,
        tax_year: claim.tax_year,
        period_start: claim.period_start,
        period_end: claim.period_end,
        currency: claim.currency,
        accounting_basis: claim.tax_accounting_method,
        measure: COMPARISON_MEASURE,
        qbo_company_fingerprint: companyFingerprint,
      },
      financial_authority: false,
      wrote_reconciliation: false,
      mutated_source_records: false,
    };
  }

  const expectedPair = {
    taxDocUid: claim.tax_document.doc_uid,
    qboDocUid: claim.quickbooks_report.doc_uid,
    companyFingerprint,
    legalEntity: claim.legal_entity,
    taxYear: claim.tax_year,
    periodStart: claim.period_start,
    periodEnd: claim.period_end,
    formName: claim.tax_document.form_name,
    formVersion: claim.tax_document.form_version,
    page: claim.tax_document.page,
    lineLabel: claim.tax_document.line_label,
    reportName: claim.quickbooks_report.report_name,
    totalLabel: claim.quickbooks_report.total_label,
    measure: COMPARISON_MEASURE,
    taxLocator: claim.tax_document.source_locator,
    qboLocator: claim.quickbooks_report.source_locator,
    accountingBasis: claim.tax_accounting_method,
    currency: claim.currency,
    taxAmountMinor: claim.tax_document.amount_minor,
    qboAmountMinor: claim.quickbooks_report.amount_minor,
  };
  if (existing && (existing.currency !== claim.currency || !samePair(existingClaims, expectedPair))) {
    fail(
      "tax_qbo_pairing_conflict",
      "this entity and period are already bound to different tax or QuickBooks claim evidence",
      { recovery: "Review the existing reconciliation. Do not overwrite its document, company, form, line, report, or basis pairing." },
    );
  }

  const reconciliationUid = existing?.reconciliation_uid || stableId("tax_qbo_reconciliation", [
    claim.entity_slug, claim.period_start, claim.period_end, "period_receipts", claim.currency,
  ]);
  const taxClaimUid = stableId("tax_document_claim", [reconciliationUid]);
  const qboClaimUid = stableId("qbo_report_claim", [reconciliationUid]);
  const taxLocator = claimLocator("tax", claim, { tax: taxDoc });
  const qboLocator = claimLocator("quickbooks", claim, { qbo: qboDoc, companyFingerprint });
  const deltaMinor = claim.tax_document.amount_minor - claim.quickbooks_report.amount_minor;
  const status = deltaMinor === 0 ? "matched" : "mismatched";
  if (typeof env.DB.batch !== "function") {
    fail("tax_qbo_batch_unavailable", "the database cannot commit both claims atomically", { status: 503 });
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO fin_reconciliations
           (tenant_id, reconciliation_uid, entity_slug, account_slug, period_start, period_end,
            measure, state, delta_minor, tolerance_minor, currency, computed_at, recorded_at)
         VALUES ('primary', ?, ?, NULL, ?, ?, 'period_receipts', ?, ?, 0, ?, ?, ?)
         ON CONFLICT DO UPDATE SET reconciliation_uid=excluded.reconciliation_uid,
           state=excluded.state, delta_minor=excluded.delta_minor, currency=excluded.currency,
           computed_at=excluded.computed_at, recorded_at=excluded.recorded_at`,
      ).bind(reconciliationUid, claim.entity_slug, claim.period_start, claim.period_end,
        status, deltaMinor, claim.currency, now, now),
      env.DB.prepare(
        `INSERT INTO fin_reconciliation_claims
           (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency, as_of,
            claim_ref_table, claim_ref_uid, provenance, source_doc_uid, source_locator,
            source_feed, basis_state, recorded_at)
         VALUES ('primary', ?, ?, 'Tax line (${CONFIRMATION})', ?, ?, ?,
                 'fin_documents', ?, 'owner_stated', ?, ?, 'tax-document', 'confirmed', ?)
         ON CONFLICT(tenant_id, claim_uid) DO UPDATE SET recorded_at=excluded.recorded_at`,
      ).bind(taxClaimUid, reconciliationUid, claim.tax_document.amount_minor, claim.currency,
        claim.period_end, taxDoc.fin_doc_uid, claim.tax_document.doc_uid, taxLocator, now),
      env.DB.prepare(
        `INSERT INTO fin_reconciliation_claims
           (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency, as_of,
            claim_ref_table, claim_ref_uid, provenance, source_doc_uid, source_locator,
            source_feed, basis_state, recorded_at)
         VALUES ('primary', ?, ?, 'QuickBooks report total (${CONFIRMATION})', ?, ?, ?,
                 'fin_documents', ?, 'owner_stated', ?, ?, 'quickbooks', 'confirmed', ?)
         ON CONFLICT(tenant_id, claim_uid) DO UPDATE SET recorded_at=excluded.recorded_at`,
      ).bind(qboClaimUid, reconciliationUid, claim.quickbooks_report.amount_minor, claim.currency,
        claim.period_end, qboDoc.fin_doc_uid, claim.quickbooks_report.doc_uid, qboLocator, now),
    ]);
  } catch {
    return {
      schema_version: 1,
      command: "reconcile.tax_quickbooks",
      status: "unavailable",
      error_code: "tax_qbo_write_unavailable",
      recovery: "No complete write receipt was returned. Retry the exact same reviewed claim; stable identities make that safe.",
      financial_authority: false,
      wrote_reconciliation: null,
      write_state: "unknown_without_receipt",
      mutated_source_records: false,
      retry_safe: true,
    };
  }

  return {
    schema_version: 1,
    command: "reconcile.tax_quickbooks",
    status,
    error_code: null,
    confirmation: CONFIRMATION,
    scope: {
      entity_slug: claim.entity_slug,
      legal_entity: claim.legal_entity,
      tax_year: claim.tax_year,
      period_start: claim.period_start,
      period_end: claim.period_end,
      currency: claim.currency,
      accounting_basis: claim.tax_accounting_method,
      measure: COMPARISON_MEASURE,
      qbo_company_fingerprint: companyFingerprint,
    },
    reconciliation_uid: reconciliationUid,
    claim_uids: [taxClaimUid, qboClaimUid],
    tax_amount_minor: claim.tax_document.amount_minor,
    qbo_amount_minor: claim.quickbooks_report.amount_minor,
    delta_minor: deltaMinor,
    claims: [
      { side: "tax_document", confirmation: CONFIRMATION, source_doc_uid: claim.tax_document.doc_uid, source_locator: claim.tax_document.source_locator },
      { side: "quickbooks_report", confirmation: CONFIRMATION, source_doc_uid: claim.quickbooks_report.doc_uid, source_locator: claim.quickbooks_report.source_locator },
    ],
    financial_authority: false,
    ruling_selected: false,
    wrote_reconciliation: true,
    mutated_source_records: false,
    retry_safe: true,
    success_meaning: "Two human-confirmed document claims were stored and compared. This is a review candidate, not a tax finding or correction.",
    recovery: status === "matched"
      ? "Keep both citations with the review. Equal amounts do not prove the tax treatment or books are correct."
      : "Have the owner, accountant, or tax professional review both exact citations and any documented adjustments. No automatic correction is available.",
  };
}

export const __testing = Object.freeze({ checkedClaim, stableId, samePair });
