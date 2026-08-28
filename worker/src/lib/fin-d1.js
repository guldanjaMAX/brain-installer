/**
 * fin-d1 — the read path over the structured financial ledger (migration 0015).
 *
 * WHAT THIS MODULE IS FOR
 *
 * The document corpus answers questions by retrieving text. This module answers
 * them by reading rows: what accounts exist, how far their records reach, which
 * periods are matched, which figures disagree, what falls due, and what the
 * ledger could NOT read. Those are the questions the client-facing screens ask,
 * and none of them is answerable from prose.
 *
 * THREE RULES THIS FILE KEEPS, AND WHY
 *
 * 1. THE WIRE NEVER CARRIES A CLIENT WORD. Everything returned here is either a
 *    stored enum value, a date, an integer in minor units, or a count. The
 *    product's five client-facing outcome words are a rendering decision that
 *    belongs to the surface showing them, and the same stored state legitimately
 *    renders differently depending on whether the screen it lands on offers the
 *    control that would fix it. Emitting the word here would freeze that
 *    decision in the wrong repository and make every future disagreement a
 *    deploy. So this file emits facts and the enums the translation layer
 *    already consumes.
 *
 * 2. NO TOTAL WITHOUT ITS COVERAGE. Every aggregate returns what it covered, out
 *    of what, and what it could not read, in the same object. A figure that
 *    quietly spans only the accounts that happened to be readable is the most
 *    expensive kind of wrong: it looks sourced. The shape makes the gap
 *    impossible to drop without deleting a field.
 *
 * 3. ABSENT IS NOT EMPTY. An install that has not run migration 0015 has no
 *    ledger at all; an install that has run it and holds nothing has an empty
 *    one. Those are different answers and a client is entitled to both, so every
 *    entry point reports `ledger_installed` and never conflates a missing table
 *    with a quiet month.
 *
 * FAILURE BEHAVIOUR: a read that throws returns `unavailable: true` with empty
 * rows rather than propagating. A financial screen that cannot reach its records
 * must say so; it must not take down the page, and it must never render as
 * "nothing owed, nothing due".
 *
 * PRIVACY: nothing here reads or returns a credential. Connector access tokens
 * live in connector-owned tables and are never joined into a ledger read.
 */

/** Live-row predicate. A superseded row is history, not current truth. */
const LIVE = "superseded_by_id IS NULL";

const LEDGER_TABLES = [
  "fin_entities",
  "fin_accounts",
  "fin_account_coverage",
  "fin_documents",
  "fin_statements",
  "fin_transactions",
  "fin_balance_snapshots",
  "fin_obligations",
  "fin_deadlines",
  "fin_exceptions",
  "fin_open_items",
  "fin_reconciliations",
  "fin_reconciliation_claims",
];

export const DEFAULT_TENANT = "primary";

/**
 * Accounts whose balance is money HELD. Everything else is money owed or is not
 * a balance at all, and must never enter a cash figure. The account table
 * refuses a card or a loan as an asset by CHECK; this is the read-side half of
 * the same rule, kept next to the query that would otherwise be the place it
 * gets forgotten.
 */
const DEPOSIT_KINDS = ["checking", "savings"];

/**
 * Run a read and never let it break the caller. Returns rows plus an explicit
 * `unavailable` flag, because zero rows and an unreachable database are
 * different facts and a financial surface must be able to tell them apart.
 */
async function safeAll(env, sql, binds = []) {
  try {
    const statement = env.DB.prepare(sql);
    const bound = binds.length ? statement.bind(...binds) : statement;
    const result = await bound.all();
    return { results: result?.results || [], unavailable: false };
  } catch {
    return { results: [], unavailable: true };
  }
}

/**
 * Whether migration 0015 has been applied to this brain.
 *
 * Checked by name against sqlite_master rather than by probing a SELECT, so a
 * partially applied migration (D1 commits per statement) reports the tables it
 * actually has instead of claiming the whole ledger on the strength of the first
 * one.
 */
export async function ledgerInstalled(env) {
  const placeholders = LEDGER_TABLES.map(() => "?").join(", ");
  const { results, unavailable } = await safeAll(
    env,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    LEDGER_TABLES,
  );
  if (unavailable) return { installed: false, unavailable: true, present: [], missing: LEDGER_TABLES };
  const present = new Set(results.map((row) => row.name));
  const missing = LEDGER_TABLES.filter((name) => !present.has(name));
  return {
    installed: missing.length === 0,
    unavailable: false,
    present: [...present],
    missing,
  };
}

/** Shared provenance fields, in one place so every row carries the same shape. */
const PROVENANCE_COLUMNS = `provenance, source_doc_uid, source_locator, source_feed,
  confidence_bp, basis_state, unparsed_reason`;

const provenanceOf = (row) => ({
  provenance: row.provenance,
  source_doc_uid: row.source_doc_uid || null,
  source_locator: row.source_locator || null,
  source_feed: row.source_feed || null,
  confidence_bp: row.confidence_bp === null || row.confidence_bp === undefined
    ? null
    : Number(row.confidence_bp),
  basis_state: row.basis_state,
  unparsed_reason: row.unparsed_reason || null,
});

/**
 * The entity map: every scope the client can narrow to.
 *
 * Counterparties are returned rather than filtered, flagged rather than hidden.
 * A record pointing at the buyer of a sold business is real and findable; the
 * caller decides whether "your businesses" includes them, and it needs the flag
 * to decide.
 */
export async function ledgerEntities(env, { tenantId = DEFAULT_TENANT } = {}) {
  const { results, unavailable } = await safeAll(
    env,
    `SELECT entity_slug, legal_name, display_label, kind, status, relationship,
            holds, parent_entity_slug, ownership_bp, tax_class, fixed_scope,
            ${PROVENANCE_COLUMNS}
       FROM fin_entities
      WHERE tenant_id = ? AND ${LIVE}
      ORDER BY fixed_scope DESC, entity_slug`,
    [tenantId],
  );
  return {
    unavailable,
    entities: results.map((row) => ({
      entity_slug: row.entity_slug,
      legal_name: row.legal_name,
      label: row.display_label || row.legal_name,
      kind: row.kind,
      status: row.status,
      relationship: row.relationship,
      counterparty: row.relationship === "counterparty",
      holds: row.holds || null,
      parent_entity_slug: row.parent_entity_slug || null,
      ownership_bp: row.ownership_bp === null || row.ownership_bp === undefined
        ? null
        : Number(row.ownership_bp),
      tax_class: row.tax_class || null,
      fixed: Number(row.fixed_scope || 0) === 1,
      ...provenanceOf(row),
    })),
  };
}

/**
 * Accounts with their coverage.
 *
 * `coverage_status` and `covered_to` come from the coverage table, not from
 * counting statements, because two of the six coverage values are declarations
 * about what will never arrive rather than derivations from what has. An account
 * with no coverage row returns `coverage_status: null`, which is honestly
 * different from `missing`: nothing has assessed it yet.
 *
 * `balance_role` is returned on every row so no caller has to re-derive from
 * `account_kind` whether a balance is money held or money owed.
 */
export async function ledgerAccounts(env, { tenantId = DEFAULT_TENANT, entitySlug = null } = {}) {
  const binds = [tenantId, tenantId];
  let where = "a.tenant_id = ?";
  if (entitySlug) {
    where += " AND a.entity_slug = ?";
    binds.push(entitySlug);
  }
  const { results, unavailable } = await safeAll(
    env,
    `SELECT a.account_slug, a.entity_slug, a.institution, a.label, a.account_kind,
            a.balance_role, a.mask, a.currency, a.feed_mode, a.expected_cadence,
            a.status, a.opened_on, a.closed_on,
            a.provenance, a.source_doc_uid, a.source_locator, a.source_feed,
            a.confidence_bp, a.basis_state, a.unparsed_reason,
            c.coverage_status, c.covered_from, c.covered_to,
            c.covered_via_account_slug, c.basis_note, c.computed_at
       FROM fin_accounts a
       LEFT JOIN fin_account_coverage c
              ON c.account_slug = a.account_slug
             AND c.tenant_id = ?
             AND c.superseded_by_id IS NULL
      WHERE ${where} AND a.${LIVE}
      ORDER BY a.entity_slug, a.account_slug`,
    binds,
  );
  return {
    unavailable,
    accounts: results.map((row) => ({
      account_slug: row.account_slug,
      entity_slug: row.entity_slug,
      institution: row.institution || null,
      label: row.label || [row.institution, row.account_kind].filter(Boolean).join(" ") || row.account_slug,
      account_kind: row.account_kind,
      balance_role: row.balance_role,
      mask: row.mask || null,
      currency: row.currency,
      feed_mode: row.feed_mode,
      // NULL is not a value to render. It means no refresh expectation has been
      // set and therefore no staleness claim is made about this account.
      expected_cadence: row.expected_cadence || null,
      status: row.status,
      opened_on: row.opened_on || null,
      closed_on: row.closed_on || null,
      coverage_status: row.coverage_status || null,
      covered_from: row.covered_from || null,
      covered_to: row.covered_to || null,
      covered_via_account_slug: row.covered_via_account_slug || null,
      coverage_note: row.basis_note || null,
      coverage_computed_at: row.computed_at || null,
      ...provenanceOf(row),
    })),
  };
}

/**
 * The financial document index, with the custody FACTS and no custody word.
 *
 * The product's two finished states mean different things ("stored and findable"
 * versus "matched against your books as of a date") and only one of them is
 * about reconciliation. Both are derivations over the fields returned here:
 * `custody_class`, `availability`, `filed_at`, `reconciled_through`, `readable`.
 * Deriving them in this module would put a client-facing vocabulary on the wire
 * and make a connector's successful write look like a custody guarantee, which
 * is the failure the whole product is organised against. So the caller derives,
 * and it derives from dated facts.
 */
export async function ledgerDocuments(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, limit = 200 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (entitySlug) {
    where += " AND entity_slug = ?";
    binds.push(entitySlug);
  }
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT fin_doc_uid, entity_slug, account_slug, doc_kind, title, tax_year,
            period_start, period_end, custody_class, availability, available_from,
            available_within_days, filed_at, reconciled_through, received_from,
            received_at, corpus_doc_uid, content_hash, readable, unreadable_reason,
            restricted, ${PROVENANCE_COLUMNS}
       FROM fin_documents
      WHERE ${where} AND ${LIVE}
      ORDER BY COALESCE(period_end, filed_at, received_at, '') DESC, fin_doc_uid
      LIMIT ?`,
    binds,
  );
  return {
    unavailable,
    documents: results.map((row) => ({
      fin_doc_uid: row.fin_doc_uid,
      entity_slug: row.entity_slug || null,
      account_slug: row.account_slug || null,
      doc_kind: row.doc_kind,
      title: row.title,
      tax_year: row.tax_year === null || row.tax_year === undefined ? null : Number(row.tax_year),
      period_start: row.period_start || null,
      period_end: row.period_end || null,
      custody_class: row.custody_class,
      availability: row.availability,
      available_from: row.available_from || null,
      available_within_days: row.available_within_days === null || row.available_within_days === undefined
        ? null
        : Number(row.available_within_days),
      filed_at: row.filed_at || null,
      reconciled_through: row.reconciled_through || null,
      received_from: row.received_from || null,
      received_at: row.received_at || null,
      // Present means the text is in the searchable corpus. Absent means the
      // document is recorded but its contents are not retrievable, which is a
      // real and common state, not an error.
      corpus_doc_uid: row.corpus_doc_uid || null,
      in_corpus: Boolean(row.corpus_doc_uid),
      content_hash: row.content_hash || null,
      readable: Number(row.readable || 0) === 1,
      unreadable_reason: row.unreadable_reason || null,
      restricted: Number(row.restricted || 0) === 1,
      ...provenanceOf(row),
    })),
  };
}

/** Statement periods for an account, newest first. */
export async function ledgerStatements(
  env,
  { tenantId = DEFAULT_TENANT, accountSlug = null, from = null, to = null, limit = 200 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (accountSlug) {
    where += " AND account_slug = ?";
    binds.push(accountSlug);
  }
  if (from) {
    where += " AND period_end >= ?";
    binds.push(from);
  }
  if (to) {
    where += " AND period_start <= ?";
    binds.push(to);
  }
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT statement_uid, account_slug, period_start, period_end,
            opening_balance_minor, closing_balance_minor, currency,
            line_count_stated, parse_state, received_at, parsed_at,
            ${PROVENANCE_COLUMNS}
       FROM fin_statements
      WHERE ${where} AND ${LIVE}
      ORDER BY period_end DESC, account_slug
      LIMIT ?`,
    binds,
  );
  return {
    unavailable,
    statements: results.map((row) => ({
      statement_uid: row.statement_uid,
      account_slug: row.account_slug,
      period_start: row.period_start,
      period_end: row.period_end,
      opening_balance_minor: nullableInt(row.opening_balance_minor),
      closing_balance_minor: nullableInt(row.closing_balance_minor),
      currency: row.currency,
      line_count_stated: nullableInt(row.line_count_stated),
      // Arriving is not being read. Both states are returned because a checklist
      // that ticks on arrival is a checklist that lies about proof.
      parse_state: row.parse_state,
      received_at: row.received_at || null,
      parsed_at: row.parsed_at || null,
      ...provenanceOf(row),
    })),
  };
}

/**
 * The dated cash position, one account at a time.
 *
 * THIS IS THE QUERY MOST LIKELY TO PRODUCE A CONFIDENT WRONG NUMBER, so it is
 * built to refuse rather than to compose:
 *
 *  - only deposit accounts are considered. A card balance is money owed and
 *    never enters this figure, and the accounts it excludes are RETURNED with
 *    the reason so nothing disappears silently;
 *  - A CASH POSITION IS A POINT IN TIME. Every figure summed here is dated to
 *    the SAME day. An account whose most recent confirmed figure is a month
 *    older is not quietly added in at its stale value; it moves to `missing`
 *    carrying the date its records actually reach. Summing a July balance and a
 *    June one produces a number that is true of no moment that ever existed, and
 *    it is the most plausible-looking way this function could be wrong. The
 *    default as-of is the most recent confirmed figure across the accounts
 *    considered; a caller wanting a period-end position passes that period's end;
 *  - an account with no confirmed figure at all goes to `missing` with why, and
 *    its absence is visible in the covered-of-considered counts;
 *  - a proposed or unparsed figure is never summed. A figure the extractor was
 *    unsure of is not a balance;
 *  - a mix of currencies returns no total at all rather than adding units that
 *    are not the same unit.
 *
 * An excluded account returns its `last_confirmed_as_of` DATE and deliberately
 * not its amount, so there is no stale figure sitting in the payload for a
 * caller to add back in by accident.
 */
export async function ledgerCashPosition(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, asOf = null } = {},
) {
  const { accounts, unavailable } = await ledgerAccounts(env, { tenantId, entitySlug });
  if (unavailable) {
    return {
      unavailable: true,
      as_of: null,
      total_minor: null,
      currency: null,
      covered: [],
      missing: [],
      excluded: [],
      accounts_covered: 0,
      accounts_considered: 0,
    };
  }

  const considered = accounts.filter(
    (a) => a.balance_role === "asset" && DEPOSIT_KINDS.includes(a.account_kind),
  );
  const excluded = accounts
    .filter((a) => !considered.includes(a))
    .map((a) => ({
      account_slug: a.account_slug,
      account_kind: a.account_kind,
      balance_role: a.balance_role,
      reason: a.balance_role === "liability" ? "money_owed_not_held" : "not_a_deposit_account",
    }));

  const figures = new Map();
  for (const account of considered) {
    figures.set(account.account_slug, await confirmedBalanceFor(env, tenantId, account.account_slug));
  }

  // ISO dates sort chronologically as text, which is why every date in this
  // schema is constrained to that shape.
  const dated = [...figures.values()].filter(Boolean).map((f) => f.as_of).sort();
  const positionAsOf = asOf || (dated.length ? dated[dated.length - 1] : null);

  const covered = [];
  const missing = [];
  for (const account of considered) {
    const figure = figures.get(account.account_slug);
    if (!figure) {
      missing.push({
        account_slug: account.account_slug,
        // Distinguishing never-connected from connected-but-unread matters: one
        // is a setup step and the other is a waiting statement.
        reason: account.status === "never_connected"
          ? "never_connected"
          : account.coverage_status === "missing"
            ? "no_records_loaded"
            : "no_confirmed_figure",
        coverage_status: account.coverage_status,
        covered_to: account.covered_to,
        last_confirmed_as_of: null,
      });
      continue;
    }
    if (figure.as_of !== positionAsOf) {
      missing.push({
        account_slug: account.account_slug,
        reason: "no_confirmed_figure_at_as_of",
        coverage_status: account.coverage_status,
        covered_to: account.covered_to,
        // The date its records actually reach. The amount is deliberately absent.
        last_confirmed_as_of: figure.as_of,
      });
      continue;
    }
    covered.push({
      account_slug: account.account_slug,
      label: account.label,
      amount_minor: figure.amount_minor,
      currency: figure.currency,
      as_of: figure.as_of,
      figure_source: figure.figure_source,
      source_doc_uid: figure.source_doc_uid,
      source_feed: figure.source_feed,
    });
  }

  const currencies = new Set(covered.map((c) => c.currency));
  const mixed = currencies.size > 1;
  return {
    unavailable: false,
    // The one day every summed figure is true of. Null when nothing is summed.
    as_of: covered.length ? positionAsOf : null,
    // Null rather than a number whenever a number would mean something false.
    total_minor: mixed || covered.length === 0
      ? null
      : covered.reduce((sum, c) => sum + c.amount_minor, 0),
    currency: mixed || covered.length === 0 ? null : [...currencies][0],
    mixed_currency: mixed,
    covered,
    missing,
    excluded,
    accounts_covered: covered.length,
    accounts_considered: considered.length,
    complete: missing.length === 0 && considered.length > 0,
  };
}

/**
 * The best dated, confirmed figure for one account, or nothing.
 *
 * A parsed statement's closing balance and a feed's balance snapshot are both
 * valid answers; the more recent one wins on date, and the source of the winner
 * is named so the caller can cite it. `proposed` and `unparsed` rows are not
 * eligible: a figure the extractor was unsure of is not a balance.
 */
async function confirmedBalanceFor(env, tenantId, accountSlug) {
  const { results } = await safeAll(
    env,
    `SELECT period_end AS as_of, closing_balance_minor AS amount_minor, currency,
            'statement' AS figure_source, source_doc_uid, source_feed
       FROM fin_statements
      WHERE tenant_id = ? AND account_slug = ? AND ${LIVE}
        AND parse_state = 'parsed' AND basis_state = 'confirmed'
        AND closing_balance_minor IS NOT NULL
      UNION ALL
     SELECT as_of_date AS as_of, current_minor AS amount_minor, currency,
            'balance_snapshot' AS figure_source, source_doc_uid, source_feed
       FROM fin_balance_snapshots
      WHERE tenant_id = ? AND account_slug = ?
        AND basis_state = 'confirmed' AND current_minor IS NOT NULL
      ORDER BY as_of DESC
      LIMIT 1`,
    [tenantId, accountSlug, tenantId, accountSlug],
  );
  const row = results[0];
  if (!row) return null;
  return {
    as_of: row.as_of,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    figure_source: row.figure_source,
    source_doc_uid: row.source_doc_uid || null,
    source_feed: row.source_feed || null,
  };
}

/**
 * Spending nobody has sorted yet.
 *
 * `category IS NULL` is the state, and the total deliberately excludes three
 * classes that would each inflate it in a different direction: pending lines
 * (which are later withdrawn and re-reported), tombstoned lines, and lines the
 * extractor could not read. The unreadable ones are COUNTED and returned, so the
 * figure can be shown next to what it could not see rather than quietly standing
 * in for it.
 */
export async function ledgerUnsortedSpending(
  env,
  { tenantId = DEFAULT_TENANT, accountSlug = null, from = null, to = null } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ? AND category IS NULL AND removed_at IS NULL AND pending = 0";
  if (accountSlug) {
    where += " AND account_slug = ?";
    binds.push(accountSlug);
  }
  if (from) {
    where += " AND posted_on >= ?";
    binds.push(from);
  }
  if (to) {
    where += " AND posted_on <= ?";
    binds.push(to);
  }
  const { results, unavailable } = await safeAll(
    env,
    `SELECT account_slug, currency,
            SUM(CASE WHEN basis_state <> 'unparsed' AND direction = 'outflow'
                     THEN amount_minor ELSE 0 END) AS outflow_minor,
            SUM(CASE WHEN basis_state <> 'unparsed' AND direction = 'outflow'
                     THEN 1 ELSE 0 END) AS counted_lines,
            SUM(CASE WHEN basis_state = 'unparsed' THEN 1 ELSE 0 END) AS unreadable_lines
       FROM fin_transactions
      WHERE ${where} AND ${LIVE}
      GROUP BY account_slug, currency
      ORDER BY account_slug`,
    binds,
  );
  return {
    unavailable,
    by_account: results.map((row) => ({
      account_slug: row.account_slug,
      currency: row.currency,
      outflow_minor: Number(row.outflow_minor || 0),
      counted_lines: Number(row.counted_lines || 0),
      // A total that omits lines it could not read must say how many.
      unreadable_lines: Number(row.unreadable_lines || 0),
    })),
  };
}

/**
 * The exception inbox.
 *
 * `proposal` is returned beside `proposal_confidence_bp` and the row's
 * `basis_state`, which the schema pins to `proposed` whenever a proposal exists.
 * The caller must render it as the brain's reading and not as a finding; the
 * data cannot be made to say otherwise, because a proposal stored as confirmed
 * is refused by the database.
 */
export async function ledgerExceptions(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, includeResolved = false, limit = 200 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (entitySlug) {
    where += " AND entity_slug = ?";
    binds.push(entitySlug);
  }
  if (!includeResolved) where += " AND resolved_at IS NULL";
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT exception_uid, entity_slug, kind, issue, detail, amount_minor, currency,
            txn_uid, txn_date, txn_account_slug, first_seen, waiting_on,
            proposal, proposal_confidence_bp, resolved_at, resolution,
            resolved_by_party, ${PROVENANCE_COLUMNS}
       FROM fin_exceptions
      WHERE ${where}
      ORDER BY first_seen, exception_uid
      LIMIT ?`,
    binds,
  );
  return {
    unavailable,
    exceptions: results.map((row) => ({
      exception_uid: row.exception_uid,
      entity_slug: row.entity_slug || null,
      kind: row.kind,
      issue: row.issue,
      detail: row.detail || null,
      amount_minor: nullableInt(row.amount_minor),
      currency: row.currency,
      txn_uid: row.txn_uid || null,
      txn_date: row.txn_date || null,
      txn_account_slug: row.txn_account_slug || null,
      first_seen: row.first_seen,
      waiting_on: row.waiting_on || null,
      proposal: row.proposal || null,
      proposal_confidence_bp: nullableInt(row.proposal_confidence_bp),
      resolved_at: row.resolved_at || null,
      resolution: row.resolution || null,
      resolved_by_party: row.resolved_by_party || null,
      ...provenanceOf(row),
    })),
  };
}

/**
 * The obligations register, ordered the way a register is read: soonest dated
 * first, undated last, never dropped.
 *
 * A `closed` deadline is excluded by default rather than shown as outstanding.
 * Filtering for a status value this schema does not use is how sixteen finished
 * items once appeared on a screen as work still to do.
 */
export async function ledgerDeadlines(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, includeClosed = false, limit = 200 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (entitySlug) {
    where += " AND entity_slug = ?";
    binds.push(entitySlug);
  }
  if (!includeClosed) where += " AND status <> 'closed'";
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT deadline_uid, entity_slug, item, due_date, owner_party, status, urgency,
            consequence, waiting_on, obligation_uid, basis_note, closed_at,
            ${PROVENANCE_COLUMNS}
       FROM fin_deadlines
      WHERE ${where} AND ${LIVE}
      ORDER BY CASE urgency WHEN 'asap' THEN 0 WHEN 'soon' THEN 1
                            WHEN 'dated' THEN 2 ELSE 3 END,
               COALESCE(due_date, '9999-12-31'), deadline_uid
      LIMIT ?`,
    binds,
  );
  return {
    unavailable,
    deadlines: results.map((row) => ({
      deadline_uid: row.deadline_uid,
      entity_slug: row.entity_slug || null,
      item: row.item,
      due_date: row.due_date || null,
      owner_party: row.owner_party,
      status: row.status,
      urgency: row.urgency,
      consequence: row.consequence || null,
      waiting_on: row.waiting_on || null,
      obligation_uid: row.obligation_uid || null,
      basis_note: row.basis_note || null,
      closed_at: row.closed_at || null,
      ...provenanceOf(row),
    })),
  };
}

/**
 * Obligations, plus the personal-guarantee exposure across them.
 *
 * `personal_guarantee_state` is returned on every row and the summary counts
 * `not_examined` separately from `none_found`. Nobody having looked is not the
 * same as nothing being there, and collapsing the two would let a screen tell an
 * owner they carry no personal guarantee on the strength of a pass that never
 * ran.
 */
export async function ledgerObligations(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, limit = 200 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (entitySlug) {
    where += " AND entity_slug = ?";
    binds.push(entitySlug);
  }
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT obligation_uid, entity_slug, kind, counterparty, label, account_slug,
            principal_minor, balance_minor, balance_as_of, payment_minor,
            payment_cadence, rate_bp, currency, start_on, end_on, renews_on,
            personal_guarantee, personal_guarantee_state,
            personal_guarantee_source_doc_uid, personal_guarantee_locator,
            ${PROVENANCE_COLUMNS}
       FROM fin_obligations
      WHERE ${where} AND ${LIVE}
      ORDER BY entity_slug, kind, obligation_uid
      LIMIT ?`,
    binds,
  );
  const obligations = results.map((row) => ({
    obligation_uid: row.obligation_uid,
    entity_slug: row.entity_slug,
    kind: row.kind,
    counterparty: row.counterparty || null,
    label: row.label || null,
    account_slug: row.account_slug || null,
    principal_minor: nullableInt(row.principal_minor),
    balance_minor: nullableInt(row.balance_minor),
    balance_as_of: row.balance_as_of || null,
    payment_minor: nullableInt(row.payment_minor),
    payment_cadence: row.payment_cadence || null,
    rate_bp: nullableInt(row.rate_bp),
    currency: row.currency,
    start_on: row.start_on || null,
    end_on: row.end_on || null,
    renews_on: row.renews_on || null,
    personal_guarantee: Number(row.personal_guarantee || 0) === 1,
    personal_guarantee_state: row.personal_guarantee_state,
    personal_guarantee_source_doc_uid: row.personal_guarantee_source_doc_uid || null,
    personal_guarantee_locator: row.personal_guarantee_locator || null,
    ...provenanceOf(row),
  }));

  const withBalance = obligations.filter((o) => o.balance_minor !== null);
  const currencies = new Set(withBalance.map((o) => o.currency));
  return {
    unavailable,
    obligations,
    exposure: {
      // Same refusal as the cash figure: a total across units that are not the
      // same unit is not a total.
      balance_minor: currencies.size === 1 && withBalance.length
        ? withBalance.reduce((sum, o) => sum + o.balance_minor, 0)
        : null,
      currency: currencies.size === 1 && withBalance.length ? [...currencies][0] : null,
      obligations_with_balance: withBalance.length,
      obligations_total: obligations.length,
      guaranteed: obligations.filter((o) => o.personal_guarantee).length,
      guarantee_none_found: obligations.filter((o) => o.personal_guarantee_state === "none_found").length,
      // The honest headline number on this summary. Not zero: unexamined.
      guarantee_not_examined: obligations.filter((o) => o.personal_guarantee_state === "not_examined").length,
      guarantee_unreadable: obligations.filter((o) => o.personal_guarantee_state === "unreadable").length,
    },
  };
}

/** Questions prepared for a professional, with their citations. */
export async function ledgerOpenItems(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, limit = 100 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (entitySlug) {
    where += " AND entity_slug = ?";
    binds.push(entitySlug);
  }
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT open_item_code, entity_slug, question, routed_role, routed_name, status,
            due_date, citations, not_included, answer, answered_at,
            ${PROVENANCE_COLUMNS}
       FROM fin_open_items
      WHERE ${where}
      ORDER BY COALESCE(due_date, '9999-12-31'), open_item_code
      LIMIT ?`,
    binds,
  );
  return {
    unavailable,
    open_items: results.map((row) => ({
      code: row.open_item_code,
      entity_slug: row.entity_slug || null,
      question: row.question,
      routed_role: row.routed_role || null,
      routed_name: row.routed_name || null,
      // What the owner said they did. The product sends nothing and therefore
      // knows nothing about whether it was sent.
      status: row.status,
      due_date: row.due_date || null,
      citations: parseJsonList(row.citations),
      not_included: parseJsonList(row.not_included),
      answer: row.answer || null,
      answered_at: row.answered_at || null,
      ...provenanceOf(row),
    })),
  };
}

/**
 * Reconciliations with every competing claim attached.
 *
 * This function deliberately does NOT resolve a mismatch. It returns the state,
 * the difference, and both claims with their own dates, and where the owner has
 * ruled it returns the ruling beside them rather than instead of them. A caller
 * wanting one number from a `mismatched` scope has to decide to take one, in the
 * open, rather than receiving one by default.
 *
 * `ruling_consumed` is returned so a surface can say truthfully whether anything
 * uses the ruled side. It ships at 0 and a screen must not imply otherwise.
 */
export async function ledgerReconciliations(
  env,
  { tenantId = DEFAULT_TENANT, entitySlug = null, accountSlug = null, state = null, limit = 200 } = {},
) {
  const binds = [tenantId];
  let where = "tenant_id = ?";
  if (entitySlug) {
    where += " AND entity_slug = ?";
    binds.push(entitySlug);
  }
  if (accountSlug) {
    where += " AND account_slug = ?";
    binds.push(accountSlug);
  }
  if (state) {
    where += " AND state = ?";
    binds.push(state);
  }
  binds.push(boundedLimit(limit));
  const { results, unavailable } = await safeAll(
    env,
    `SELECT reconciliation_uid, entity_slug, account_slug, period_start, period_end,
            measure, state, delta_minor, tolerance_minor, currency,
            ruled_claim_uid, ruled_at, ruled_by_party, ruling_note, ruling_consumed,
            computed_at
       FROM fin_reconciliations
      WHERE ${where}
      ORDER BY COALESCE(period_end, ''), account_slug, measure
      LIMIT ?`,
    binds,
  );
  if (unavailable || results.length === 0) {
    return { unavailable, reconciliations: [] };
  }

  const claims = await safeAll(
    env,
    `SELECT claim_uid, reconciliation_uid, label, amount_minor, currency, as_of,
            claim_ref_table, claim_ref_uid, ${PROVENANCE_COLUMNS}
       FROM fin_reconciliation_claims
      WHERE tenant_id = ?
      ORDER BY as_of, claim_uid`,
    [tenantId],
  );
  const byParent = new Map();
  for (const row of claims.results) {
    const list = byParent.get(row.reconciliation_uid) || [];
    list.push({
      claim_uid: row.claim_uid,
      label: row.label,
      amount_minor: nullableInt(row.amount_minor),
      currency: row.currency,
      // Every claim carries its own date. Two undated figures cannot be told
      // apart from one figure that was updated.
      as_of: row.as_of,
      claim_ref_table: row.claim_ref_table || null,
      claim_ref_uid: row.claim_ref_uid || null,
      ...provenanceOf(row),
    });
    byParent.set(row.reconciliation_uid, list);
  }

  return {
    unavailable: unavailable || claims.unavailable,
    reconciliations: results.map((row) => ({
      reconciliation_uid: row.reconciliation_uid,
      entity_slug: row.entity_slug || null,
      account_slug: row.account_slug || null,
      period_start: row.period_start || null,
      period_end: row.period_end || null,
      measure: row.measure,
      state: row.state,
      delta_minor: nullableInt(row.delta_minor),
      tolerance_minor: Number(row.tolerance_minor || 0),
      currency: row.currency,
      ruled_claim_uid: row.ruled_claim_uid || null,
      ruled_at: row.ruled_at || null,
      ruled_by_party: row.ruled_by_party || null,
      ruling_note: row.ruling_note || null,
      ruling_consumed: Number(row.ruling_consumed || 0) === 1,
      computed_at: row.computed_at,
      claims: byParent.get(row.reconciliation_uid) || [],
    })),
  };
}

/**
 * One snapshot for a client surface to hydrate from.
 *
 * `ledger_installed` is first in the returned object because it changes the
 * meaning of everything after it: false means this brain has no financial layer
 * and the screens have nothing to show, which is a different sentence from a
 * quiet month and must not be rendered as one.
 *
 * `unavailable` is aggregated across every read, so a surface can say "could not
 * reach your records" instead of drawing an empty, reassuring page.
 */
export async function ledgerSnapshot(env, { tenantId = DEFAULT_TENANT, entitySlug = null } = {}) {
  const install = await ledgerInstalled(env);
  if (!install.installed) {
    return {
      ledger_installed: false,
      missing_tables: install.missing,
      unavailable: install.unavailable,
      tenant_id: tenantId,
      entities: [],
      accounts: [],
      documents: [],
      statements: [],
      exceptions: [],
      deadlines: [],
      open_items: [],
      reconciliations: [],
      obligations: [],
      cash: null,
      unsorted_spending: [],
    };
  }

  const [entities, accounts, documents, statements, exceptions, deadlines, openItems,
         reconciliations, obligations, cash, unsorted] = await Promise.all([
    ledgerEntities(env, { tenantId }),
    ledgerAccounts(env, { tenantId, entitySlug }),
    ledgerDocuments(env, { tenantId, entitySlug }),
    ledgerStatements(env, { tenantId }),
    ledgerExceptions(env, { tenantId, entitySlug }),
    ledgerDeadlines(env, { tenantId, entitySlug }),
    ledgerOpenItems(env, { tenantId, entitySlug }),
    ledgerReconciliations(env, { tenantId, entitySlug }),
    ledgerObligations(env, { tenantId, entitySlug }),
    ledgerCashPosition(env, { tenantId, entitySlug }),
    ledgerUnsortedSpending(env, { tenantId }),
  ]);

  const parts = [entities, accounts, documents, statements, exceptions, deadlines,
                 openItems, reconciliations, obligations, cash, unsorted];
  return {
    ledger_installed: true,
    missing_tables: [],
    unavailable: parts.some((p) => p && p.unavailable),
    tenant_id: tenantId,
    entity_scope: entitySlug,
    entities: entities.entities,
    accounts: accounts.accounts,
    documents: documents.documents,
    statements: statements.statements,
    exceptions: exceptions.exceptions,
    deadlines: deadlines.deadlines,
    open_items: openItems.open_items,
    reconciliations: reconciliations.reconciliations,
    obligations: obligations.obligations,
    obligation_exposure: obligations.exposure,
    cash,
    unsorted_spending: unsorted.by_account,
  };
}

/**
 * Clamp a caller-supplied row limit.
 *
 * A limit arriving as a non-numeric query parameter must not reach SQL as NaN,
 * which is a 500 from a query string rather than a bad request. Anything
 * unparseable becomes the default.
 */
function boundedLimit(value, { fallback = 200, max = 1000 } = {}) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function nullableInt(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse a stored JSON list without letting a malformed value break a page.
 * A citation list that cannot be read comes back empty, which renders as "no
 * citations shown" rather than as a crash or, worse, as an unsourced claim.
 */
function parseJsonList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const __testing = { boundedLimit, parseJsonList, confirmedBalanceFor, LEDGER_TABLES, DEPOSIT_KINDS };
