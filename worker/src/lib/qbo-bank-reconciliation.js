/**
 * One bounded QuickBooks-versus-bank reality check.
 *
 * QuickBooks is a reference, never financial authority. This module compares
 * one explicitly paired account, period, currency, and direction. It preserves
 * the source documents and bank transactions, writes two competing aggregate
 * claims plus review-only exceptions, and never selects or mutates a winner.
 */

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DIRECTIONS = new Set(["inflow", "outflow"]);
const QBO_COVERAGE = new Set(["complete", "present_snapshot_partial", "unavailable"]);
const COMPANY_FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_LINES = 500;

export class QuickBooksReconciliationError extends Error {
  constructor(code, message, { status = 400, recovery = null } = {}) {
    super(message);
    this.name = "QuickBooksReconciliationError";
    this.code = code;
    this.status = status;
    this.recovery = recovery || message;
  }
}

function fail(code, message, options) {
  throw new QuickBooksReconciliationError(code, message, options);
}

function dateValue(value, noun) {
  const text = String(value || "").trim();
  if (!DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    fail("invalid_reconciliation_scope", `${noun} must be an ISO date`);
  }
  return text;
}

function stableId(prefix, parts) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(parts))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}_${hash.toString(16).padStart(16, "0")}`;
}

function checkedScope(input = {}, { requireCompany = true } = {}) {
  const accountSlug = String(input.account_slug || "").trim();
  const qboAccountId = String(input.qbo_account_id || "").trim();
  const periodStart = dateValue(input.period_start, "period_start");
  const periodEnd = dateValue(input.period_end, "period_end");
  const direction = String(input.direction || "").trim().toLowerCase();
  const currency = String(input.currency || "USD").trim().toUpperCase();
  if (!SAFE_SLUG.test(accountSlug)) fail("invalid_reconciliation_scope", "account_slug is not safe");
  if (!qboAccountId || qboAccountId.length > 128 || /[\u0000-\u001f\u007f]/.test(qboAccountId)) {
    fail("invalid_reconciliation_scope", "qbo_account_id is required and must be a plain provider identifier");
  }
  if (periodEnd < periodStart) fail("invalid_reconciliation_scope", "period_end must not precede period_start");
  if (!DIRECTIONS.has(direction)) fail("invalid_reconciliation_scope", "direction must be inflow or outflow");
  if (!CURRENCY.test(currency)) fail("invalid_reconciliation_scope", "currency must be a three-letter code");
  const qboCoverage = String(input.qbo_coverage || "present_snapshot_partial");
  if (!QBO_COVERAGE.has(qboCoverage)) fail("invalid_reconciliation_scope", "qbo_coverage is not recognized");
  const companyFingerprint = String(input.qbo_company_fingerprint || "").trim().toLowerCase();
  if (requireCompany && !COMPANY_FINGERPRINT.test(companyFingerprint)) {
    fail("qbo_company_identity_required", "the QuickBooks company fingerprint is required for every comparison");
  }
  return {
    account_slug: accountSlug,
    qbo_account_id: qboAccountId,
    period_start: periodStart,
    period_end: periodEnd,
    direction,
    currency,
    qbo_coverage: qboCoverage,
    qbo_company_fingerprint: companyFingerprint || null,
  };
}

function checkedQboLines(lines, scope) {
  if (!Array.isArray(lines) || lines.length > MAX_LINES) {
    fail("invalid_qbo_evidence", `qbo_lines must contain at most ${MAX_LINES} normalized records`);
  }
  const seen = new Set();
  return lines.map((raw) => {
    const line = {
      line_uid: String(raw?.line_uid || "").trim(),
      qbo_account_id: String(raw?.qbo_account_id || "").trim(),
      qbo_company_fingerprint: String(raw?.qbo_company_fingerprint || "").trim().toLowerCase(),
      posted_on: String(raw?.posted_on || "").trim(),
      amount_minor: Number(raw?.amount_minor),
      direction: String(raw?.direction || "").trim(),
      currency: String(raw?.currency || "").trim().toUpperCase(),
      source_doc_uid: String(raw?.source_doc_uid || "").trim(),
      source_locator: String(raw?.source_locator || "").trim(),
    };
    if (!line.line_uid || seen.has(line.line_uid) || line.line_uid.length > 240) {
      fail("invalid_qbo_evidence", "every QuickBooks line needs a unique bounded line_uid");
    }
    seen.add(line.line_uid);
    if (line.qbo_account_id !== scope.qbo_account_id ||
        line.qbo_company_fingerprint !== scope.qbo_company_fingerprint || line.direction !== scope.direction ||
        line.currency !== scope.currency || !DATE.test(line.posted_on) ||
        line.posted_on < scope.period_start || line.posted_on > scope.period_end ||
        !Number.isSafeInteger(line.amount_minor) || line.amount_minor < 0 ||
        !line.source_doc_uid || !line.source_locator) {
      fail("invalid_qbo_evidence", "a QuickBooks line falls outside the exact paired scope or lacks exact provenance");
    }
    return line;
  });
}

const exactKey = (line) => [line.posted_on, line.amount_minor, line.direction, line.currency].join("|");
const dateDistance = (left, right) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;

function citation(kind, line) {
  if (kind === "quickbooks") return {
    source: "quickbooks",
    record_uid: line.line_uid,
    source_doc_uid: line.source_doc_uid,
    qbo_company_fingerprint: line.qbo_company_fingerprint,
    locator: `${line.source_locator}; company fingerprint ${line.qbo_company_fingerprint}`,
    posted_on: line.posted_on,
    amount_minor: line.amount_minor,
  };
  return {
    source: "bank",
    record_uid: line.txn_uid,
    source_feed: line.source_feed || null,
    source_doc_uid: line.source_doc_uid || null,
    locator: line.source_locator || `fin_transactions:${line.txn_uid}`,
    posted_on: line.posted_on,
    amount_minor: line.amount_minor,
  };
}

function classified(classification, qbo, bank, evidenceState, deltaMinor = null) {
  return {
    classification,
    evidence_state: evidenceState,
    delta_minor: deltaMinor,
    quickbooks: qbo.map((line) => citation("quickbooks", line)),
    bank: bank.map((line) => citation("bank", line)),
  };
}

/** Classify present source records without choosing a winner. */
export function classifyQuickBooksBankLines({ qboLines, bankLines, bankCoverage, qboCoverage }) {
  const qboRemaining = new Map(qboLines.map((line) => [line.line_uid, line]));
  const bankRemaining = new Map(bankLines.map((line) => [line.txn_uid, line]));
  const results = [];
  const qboGroups = new Map();
  const bankGroups = new Map();
  for (const line of qboLines) qboGroups.set(exactKey(line), [...(qboGroups.get(exactKey(line)) || []), line]);
  for (const line of bankLines) bankGroups.set(exactKey(line), [...(bankGroups.get(exactKey(line)) || []), line]);

  for (const key of [...qboGroups.keys()].sort()) {
    const qbo = qboGroups.get(key);
    const bank = bankGroups.get(key) || [];
    if (!bank.length) continue;
    if (qbo.length === 1 && bank.length === 1) {
      results.push(classified("exact_unique", qbo, bank, "exact", 0));
    } else {
      results.push(classified("ambiguous_duplicates", qbo, bank, "ambiguous", null));
    }
    for (const line of qbo) qboRemaining.delete(line.line_uid);
    for (const line of bank) bankRemaining.delete(line.txn_uid);
  }

  for (const qbo of [...qboRemaining.values()].sort((a, b) => a.line_uid.localeCompare(b.line_uid))) {
    const sameDate = [...bankRemaining.values()].filter((bank) =>
      bank.posted_on === qbo.posted_on && bank.direction === qbo.direction && bank.currency === qbo.currency);
    if (sameDate.length === 1) {
      const bank = sameDate[0];
      results.push(classified("amount_mismatch", [qbo], [bank], "confirmed_conflict", qbo.amount_minor - bank.amount_minor));
      bankRemaining.delete(bank.txn_uid);
      qboRemaining.delete(qbo.line_uid);
      continue;
    }
    if (sameDate.length > 1) {
      results.push(classified("ambiguous_duplicates", [qbo], sameDate, "ambiguous", null));
      for (const bank of sameDate) bankRemaining.delete(bank.txn_uid);
      qboRemaining.delete(qbo.line_uid);
      continue;
    }
    const nearbyAmount = [...bankRemaining.values()].filter((bank) =>
      bank.amount_minor === qbo.amount_minor && bank.direction === qbo.direction &&
      bank.currency === qbo.currency && dateDistance(bank.posted_on, qbo.posted_on) <= 3);
    if (nearbyAmount.length === 1) {
      const bank = nearbyAmount[0];
      results.push(classified("date_mismatch", [qbo], [bank], "confirmed_conflict", 0));
      bankRemaining.delete(bank.txn_uid);
      qboRemaining.delete(qbo.line_uid);
      continue;
    }
    if (nearbyAmount.length > 1) {
      results.push(classified("ambiguous_duplicates", [qbo], nearbyAmount, "ambiguous", null));
      for (const bank of nearbyAmount) bankRemaining.delete(bank.txn_uid);
      qboRemaining.delete(qbo.line_uid);
    }
  }

  const coverageComplete = bankCoverage === "complete" && qboCoverage === "complete";
  for (const qbo of qboRemaining.values()) {
    results.push(classified("qbo_only", [qbo], [], coverageComplete ? "confirmed_conflict" : "incomplete_coverage"));
  }
  for (const bank of bankRemaining.values()) {
    results.push(classified("bank_only", [], [bank], coverageComplete ? "confirmed_conflict" : "incomplete_coverage"));
  }
  return results.sort((a, b) => {
    const ad = a.quickbooks[0]?.posted_on || a.bank[0]?.posted_on || "";
    const bd = b.quickbooks[0]?.posted_on || b.bank[0]?.posted_on || "";
    return ad.localeCompare(bd) || a.classification.localeCompare(b.classification);
  });
}

async function first(env, sql, binds) {
  return env.DB.prepare(sql).bind(...binds).first();
}

async function all(env, sql, binds) {
  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result?.results || [];
}

function coverageState(row, scope) {
  if (!row) return "missing";
  if (row.coverage_status === "complete" && row.covered_from && row.covered_to &&
      row.covered_from <= scope.period_start && row.covered_to >= scope.period_end) return "complete";
  return row.coverage_status === "missing" ? "missing" : "partial";
}

function exceptionFor(scope, reconciliationUid, item, now) {
  const qbo = item.quickbooks[0] || null;
  const bank = item.bank[0] || null;
  const amount = item.delta_minor === null
    ? qbo?.amount_minor ?? bank?.amount_minor ?? null
    : Math.abs(item.delta_minor);
  const language = {
    amount_mismatch: "QuickBooks and bank amounts differ for one uniquely paired date",
    date_mismatch: "QuickBooks and bank dates differ for one uniquely paired amount",
    ambiguous_duplicates: "More than one source record can satisfy the same match",
    qbo_only: "A QuickBooks record has no unique bank-side partner in the compared evidence",
    bank_only: "A bank record has no unique QuickBooks-side partner in the compared evidence",
  }[item.classification] || "The compared sources need review";
  return {
    exception_uid: stableId(`${reconciliationUid}_exception`, item),
    kind: item.classification === "ambiguous_duplicates" ? "possible_duplicate" : "other",
    issue: `Review candidate: ${language}`,
    detail: JSON.stringify({
      reconciliation_uid: reconciliationUid,
      classification: item.classification,
      evidence_state: item.evidence_state,
      delta_minor: item.delta_minor,
      citations: [...item.quickbooks, ...item.bank],
      authority: "neither source was selected or changed",
    }),
    amount_minor: amount,
    txn_uid: bank?.record_uid || null,
    txn_date: bank?.posted_on || qbo?.posted_on || null,
    source_doc_uid: qbo?.source_doc_uid || bank?.source_doc_uid || null,
    source_locator: qbo?.locator || bank?.locator || null,
    source_feed: bank?.source_feed || null,
    first_seen: now.slice(0, 10),
    account_slug: scope.account_slug,
  };
}

async function persistResult(env, scope, result, entitySlug, now) {
  if (typeof env.DB.batch !== "function") {
    fail("reconciliation_batch_unavailable", "the database cannot commit the reconciliation atomically", { status: 503 });
  }
  const measure = scope.direction === "inflow" ? "period_receipts" : "period_disbursements";
  const reconciliationUid = stableId("qbo_bank_reconciliation", [scope.account_slug, scope.period_start, scope.period_end, measure, scope.currency]);
  const qboTotal = result.qbo_total_minor;
  const bankTotal = result.bank_total_minor;
  const arithmeticDelta = qboTotal - bankTotal;
  const storedState = result.status === "matched"
    ? "matched"
    : result.status === "mismatched" && arithmeticDelta !== 0
      ? "mismatched"
      : result.status === "mismatched"
        ? "open"
        : "insufficient_evidence";
  const storedDelta = storedState === "insufficient_evidence" ? null : arithmeticDelta;
  const qboClaimUid = stableId("qbo_claim", [reconciliationUid]);
  const bankClaimUid = stableId("bank_claim", [reconciliationUid]);
  const exceptions = result.classifications
    .filter((item) => item.classification !== "exact_unique")
    .map((item) => exceptionFor(scope, reconciliationUid, item, now));

  const exceptionPrefix = `${reconciliationUid}_exception_`;
  let previousOpenExceptions;
  try {
    previousOpenExceptions = await all(env,
      `SELECT exception_uid FROM fin_exceptions
        WHERE tenant_id='primary' AND resolved_at IS NULL
          AND substr(exception_uid, 1, ?) = ?`,
      [exceptionPrefix.length, exceptionPrefix]);
  } catch {
    fail("reconciliation_exception_state_unavailable", "the current review-candidate state could not be read", {
      status: 503,
      recovery: "Verify the ledger database and retry the exact same bounded comparison.",
    });
  }
  const currentExceptionUids = new Set(exceptions.map((item) => item.exception_uid));
  const staleExceptionUids = previousOpenExceptions
    .map((item) => String(item.exception_uid || ""))
    .filter((uid) => uid && !currentExceptionUids.has(uid));

  const statements = [
    env.DB.prepare(
      `INSERT INTO fin_reconciliations
         (tenant_id, reconciliation_uid, entity_slug, account_slug, period_start, period_end,
          measure, state, delta_minor, tolerance_minor, currency, computed_at, recorded_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT DO UPDATE SET reconciliation_uid=excluded.reconciliation_uid,
         entity_slug=excluded.entity_slug, state=excluded.state, delta_minor=excluded.delta_minor,
         currency=excluded.currency, computed_at=excluded.computed_at, recorded_at=excluded.recorded_at`,
    ).bind(reconciliationUid, entitySlug, scope.account_slug, scope.period_start, scope.period_end,
      measure, storedState, storedDelta, scope.currency, now, now),
    env.DB.prepare(
      `INSERT INTO fin_reconciliation_claims
         (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency, as_of,
          provenance, source_locator, source_feed, basis_state, recorded_at)
       VALUES ('primary', ?, ?, 'QuickBooks present-record reference', ?, ?, ?,
               'derived', ?, 'quickbooks', 'proposed', ?)
       ON CONFLICT(tenant_id, claim_uid) DO UPDATE SET amount_minor=excluded.amount_minor,
         as_of=excluded.as_of, source_locator=excluded.source_locator, recorded_at=excluded.recorded_at`,
    ).bind(qboClaimUid, reconciliationUid, qboTotal, scope.currency, scope.period_end,
      JSON.stringify({
        qbo_account_id: scope.qbo_account_id,
        qbo_company_fingerprint: scope.qbo_company_fingerprint,
        cited_records: result.qbo_line_count,
        coverage: scope.qbo_coverage,
      }), now),
    env.DB.prepare(
      `INSERT INTO fin_reconciliation_claims
         (tenant_id, claim_uid, reconciliation_uid, label, amount_minor, currency, as_of,
          provenance, source_locator, source_feed, basis_state, recorded_at)
       VALUES ('primary', ?, ?, 'Bank-feed reference', ?, ?, ?,
               'derived', ?, 'bank-feed', 'proposed', ?)
       ON CONFLICT(tenant_id, claim_uid) DO UPDATE SET amount_minor=excluded.amount_minor,
         as_of=excluded.as_of, source_locator=excluded.source_locator, recorded_at=excluded.recorded_at`,
    ).bind(bankClaimUid, reconciliationUid, bankTotal, scope.currency, scope.period_end,
      `${result.bank_line_count} cited bank record(s); coverage ${result.bank_coverage}`, now),
  ];
  // These are generated review projections, not source records or owner
  // rulings. Rebuild their active set on every idempotent run so improved
  // evidence cannot leave a false open candidate behind. Already resolved
  // rows remain as history.
  for (const staleUid of staleExceptionUids) {
    statements.push(env.DB.prepare(
      `DELETE FROM fin_exceptions
        WHERE tenant_id='primary' AND exception_uid=? AND resolved_at IS NULL`,
    ).bind(staleUid));
  }
  for (const item of exceptions) {
    statements.push(env.DB.prepare(
      `INSERT INTO fin_exceptions
         (tenant_id, exception_uid, entity_slug, kind, issue, detail, amount_minor, currency,
          txn_uid, txn_date, txn_account_slug, first_seen, waiting_on, provenance,
          source_doc_uid, source_locator, source_feed, basis_state, recorded_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner or accounting team',
               'derived', ?, ?, ?, 'proposed', ?)
       ON CONFLICT(tenant_id, exception_uid) DO UPDATE SET issue=excluded.issue,
         detail=excluded.detail, amount_minor=excluded.amount_minor,
         waiting_on=excluded.waiting_on, recorded_at=excluded.recorded_at`,
    ).bind(item.exception_uid, entitySlug, item.kind, item.issue, item.detail, item.amount_minor,
      scope.currency, item.txn_uid, item.txn_date, item.account_slug, item.first_seen,
      item.source_doc_uid, item.source_locator, item.source_feed, now));
  }
  await env.DB.batch(statements);
  return {
    reconciliation_uid: reconciliationUid,
    stored_state: storedState,
    claim_uids: [qboClaimUid, bankClaimUid],
    exception_uids: exceptions.map((item) => item.exception_uid),
  };
}

/** Load bank evidence, compare, and atomically persist claims and review candidates. */
export async function runQuickBooksBankReconciliation(env, input = {}, options = {}) {
  const scope = checkedScope(input);
  const qboLines = checkedQboLines(input.qbo_lines, scope);
  const now = String(options.now || new Date().toISOString());
  let account;
  let coverage;
  let bankLines;
  try {
    account = await first(env,
      `SELECT entity_slug FROM fin_accounts
        WHERE tenant_id='primary' AND account_slug=? AND superseded_by_id IS NULL`,
      [scope.account_slug]);
    if (!account) fail("paired_account_not_found", "the explicitly paired ledger account does not exist", { status: 404 });
    coverage = await first(env,
      `SELECT coverage_status, covered_from, covered_to FROM fin_account_coverage
        WHERE tenant_id='primary' AND account_slug=? AND superseded_by_id IS NULL`,
      [scope.account_slug]);
    const existingPair = await first(env,
      `SELECT c.source_locator
         FROM fin_reconciliations r
         JOIN fin_reconciliation_claims c
           ON c.tenant_id=r.tenant_id AND c.reconciliation_uid=r.reconciliation_uid
        WHERE r.tenant_id='primary' AND r.account_slug=? AND r.period_start=? AND r.period_end=?
          AND r.measure=? AND c.source_feed='quickbooks'
        LIMIT 1`,
      [scope.account_slug, scope.period_start, scope.period_end,
        scope.direction === "inflow" ? "period_receipts" : "period_disbursements"]);
    if (existingPair?.source_locator) {
      let paired = null;
      let pairedCompany = null;
      try {
        const locator = JSON.parse(existingPair.source_locator);
        paired = locator?.qbo_account_id || null;
        pairedCompany = locator?.qbo_company_fingerprint || null;
      } catch { /* legacy locator */ }
      if ((paired && paired !== scope.qbo_account_id) ||
          (pairedCompany && pairedCompany !== scope.qbo_company_fingerprint)) {
        fail(
          "qbo_account_pairing_conflict",
          "this ledger account and period are already paired to a different QuickBooks account or company",
          { recovery: "Review the existing pairing. Do not overwrite it with a new provider account or company identity." },
        );
      }
    }
    bankLines = await all(env,
      `SELECT txn_uid, posted_on, amount_minor, direction, currency, source_doc_uid,
              source_locator, source_feed
         FROM fin_transactions
        WHERE tenant_id='primary' AND account_slug=? AND posted_on>=? AND posted_on<=?
          AND direction=? AND currency=? AND pending=0 AND removed_at IS NULL
          AND superseded_by_id IS NULL AND basis_state='confirmed'
        ORDER BY posted_on, txn_uid`,
      [scope.account_slug, scope.period_start, scope.period_end, scope.direction, scope.currency]);
    const docUids = [...new Set(qboLines.map((line) => line.source_doc_uid))];
    if (docUids.length) {
      const placeholders = docUids.map(() => "?").join(",");
      const present = await all(env, `SELECT doc_uid, meta FROM documents WHERE doc_uid IN (${placeholders})`, docUids);
      const found = new Map(present.map((row) => [row.doc_uid, row.meta]));
      if (docUids.some((uid) => !found.has(uid))) {
        fail(
          "qbo_source_documents_missing",
          "one or more cited QuickBooks source documents are not stored in this brain",
          { recovery: "Run the reviewed QuickBooks ingest first, then rerun this exact reconciliation." },
        );
      }
      for (const uid of docUids) {
        let storedFingerprint = null;
        try { storedFingerprint = JSON.parse(found.get(uid))?.qbo_company_fingerprint || null; } catch { /* refused below */ }
        if (storedFingerprint !== scope.qbo_company_fingerprint) {
          fail(
            "qbo_company_identity_mismatch",
            "a cited QuickBooks source document is not bound to the authorized company for this comparison",
            { recovery: "Stop. Verify the Intuit company selection and re-ingest from the intended company before retrying." },
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof QuickBooksReconciliationError) throw error;
    return {
      schema_version: 1,
      command: "reconcile.quickbooks_bank",
      status: "unavailable",
      error_code: "bank_evidence_unavailable",
      recovery: "Verify the ledger migration and bank-feed health, then rerun the exact same bounded command.",
      scope,
      financial_authority: false,
      mutated_source_records: false,
      classifications: [],
    };
  }

  const bankCoverage = coverageState(coverage, scope);
  const classifications = classifyQuickBooksBankLines({
    qboLines,
    bankLines,
    bankCoverage,
    qboCoverage: scope.qbo_coverage,
  });
  const hardConflict = classifications.some((item) => item.evidence_state === "confirmed_conflict");
  const allExact = classifications.length > 0 && classifications.every((item) => item.classification === "exact_unique");
  const bothComplete = bankCoverage === "complete" && scope.qbo_coverage === "complete";
  const status = hardConflict ? "mismatched" : bothComplete && allExact ? "matched" : "insufficient_evidence";
  const result = {
    schema_version: 1,
    command: "reconcile.quickbooks_bank",
    status,
    error_code: null,
    scope,
    coverage: { quickbooks: scope.qbo_coverage, bank: bankCoverage },
    qbo_total_minor: qboLines.reduce((sum, line) => sum + line.amount_minor, 0),
    bank_total_minor: bankLines.reduce((sum, line) => sum + Number(line.amount_minor), 0),
    qbo_line_count: qboLines.length,
    bank_line_count: bankLines.length,
    classifications,
    financial_authority: false,
    authority_note: "QuickBooks and bank data remain competing references. No winner was selected and no source record was changed.",
    success_meaning: "The QuickBooks reference was loaded and compared. This does not mean the books are correct.",
    mutated_source_records: false,
    retry_safe: true,
    acceptance_state: bothComplete ? "bounded_sources_complete" : "blocked_incomplete_coverage",
    recovery: status === "insufficient_evidence"
      ? "Complete the named source coverage or resolve ambiguous pairs, then rerun this exact scope."
      : "Review every non-exact classification with its citations. No automatic correction is available.",
  };
  Object.assign(result, await persistResult(env, scope, result, account.entity_slug || null, now));
  return result;
}

/** Read the stored aggregate state without contacting Intuit or changing data. */
export async function quickBooksBankReconciliationStatus(env, input = {}) {
  const scope = checkedScope(input, { requireCompany: false });
  const measure = scope.direction === "inflow" ? "period_receipts" : "period_disbursements";
  try {
    const row = await first(env,
      `SELECT reconciliation_uid, entity_slug, state, delta_minor, tolerance_minor,
              currency, computed_at, ruled_claim_uid, ruling_consumed
         FROM fin_reconciliations
        WHERE tenant_id='primary' AND account_slug=? AND period_start=? AND period_end=? AND measure=?`,
      [scope.account_slug, scope.period_start, scope.period_end, measure]);
    if (!row) return {
      schema_version: 1,
      command: "reconcile.quickbooks_bank.status",
      status: "not_run",
      error_code: null,
      scope,
      financial_authority: false,
      mutated_source_records: false,
      recovery: "Run the bounded reconciliation after both references are loaded.",
    };
    const claims = await all(env,
      `SELECT claim_uid, label, amount_minor, currency, as_of, source_locator,
              source_feed, basis_state
         FROM fin_reconciliation_claims
        WHERE tenant_id='primary' AND reconciliation_uid=?
        ORDER BY claim_uid`,
      [row.reconciliation_uid]);
    const qboClaim = claims.find((claim) => claim.source_feed === "quickbooks");
    let storedPair = null;
    try { storedPair = JSON.parse(qboClaim?.source_locator || "null"); } catch { /* refused below */ }
    if (!storedPair?.qbo_account_id || !COMPANY_FINGERPRINT.test(String(storedPair?.qbo_company_fingerprint || ""))) {
      fail("qbo_status_pairing_unavailable", "the stored reconciliation is not bound to a readable QuickBooks account and company", {
        status: 409,
        recovery: "Run the bounded QuickBooks comparison again with the reviewed account pairing before trusting status.",
      });
    }
    if (storedPair.qbo_account_id !== scope.qbo_account_id) {
      fail("qbo_account_pairing_conflict", "the requested QuickBooks account does not match the stored reconciliation pairing", {
        recovery: "Use the originally reviewed QuickBooks account ID or choose a different ledger account and period.",
      });
    }
    const boundScope = {
      ...scope,
      qbo_company_fingerprint: storedPair.qbo_company_fingerprint,
    };
    return {
      schema_version: 1,
      command: "reconcile.quickbooks_bank.status",
      status: row.state,
      error_code: null,
      scope: boundScope,
      reconciliation_uid: row.reconciliation_uid,
      delta_minor: row.delta_minor === null ? null : Number(row.delta_minor),
      tolerance_minor: Number(row.tolerance_minor || 0),
      computed_at: row.computed_at,
      ruled_claim_uid: row.ruled_claim_uid || null,
      ruling_consumed: Number(row.ruling_consumed || 0) === 1,
      claims: claims.map((claim) => ({
        ...claim,
        amount_minor: claim.amount_minor === null ? null : Number(claim.amount_minor),
      })),
      financial_authority: false,
      mutated_source_records: false,
      recovery: row.state === "matched" ? null : "Review the preserved claims and exceptions, then rerun the same bounded scope after evidence changes.",
    };
  } catch (error) {
    if (error instanceof QuickBooksReconciliationError) throw error;
    return {
      schema_version: 1,
      command: "reconcile.quickbooks_bank.status",
      status: "unavailable",
      error_code: "reconciliation_status_unavailable",
      scope,
      financial_authority: false,
      mutated_source_records: false,
      recovery: "Verify the ledger migration and retry the same status command.",
    };
  }
}

export const __testing = Object.freeze({ checkedScope, checkedQboLines, stableId });
