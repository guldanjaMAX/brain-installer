/**
 * fin-import — the ONE write boundary into the structured financial ledger.
 *
 * WHY THERE IS EXACTLY ONE
 *
 * Two sources feed this ledger: a file the owner downloaded from their bank
 * (OFX, QFX, CSV) and a hosted read-only feed. The two disagree about almost
 * everything at the edges, and most sharply about SIGN: one of them writes a
 * negative number when money leaves an account and the other writes a positive
 * one. If each source wrote its own rows, the convention would live in two
 * places, and the day they drifted apart every figure the product shows would
 * be wrong while every citation still resolved.
 *
 * So both sources normalise BEFORE they get here, into one envelope carrying an
 * unsigned `amountMinor` and an explicit `direction`, and this module is the
 * only thing that turns that envelope into rows. The signed source figure and
 * the NAME of the convention it came from travel with it into
 * `raw_amount_minor` / `raw_sign_convention`, so a disagreement is diagnosable
 * rather than merely wrong.
 *
 * THREE PROPERTIES THIS MODULE GUARANTEES
 *
 * 1. NOTHING LANDS WITHOUT PROVENANCE. Every row names the document or the feed
 *    it came from, and where inside it. The schema already refuses an
 *    `extracted` row with no document and a `feed` row with no feed; this module
 *    never tries.
 * 2. WHAT COULD NOT BE READ LANDS AS UNREAD. A line whose amount or date the
 *    parser could not resolve becomes a row with `basis_state = 'unparsed'`, a
 *    reason, and NO figure. It is not dropped, because a dropped line makes the
 *    month look smaller rather than incomplete.
 * 3. THE SAME FILE TWICE IS THE SAME LEDGER. Every identifier written here is
 *    derived from content, not from time or from insert order, so re-importing
 *    a file — or importing next month's export that overlaps last month's —
 *    updates rows in place instead of doubling them.
 *
 * No credential is read, written, or joined here. Access references live in
 * connector-owned tables and never enter the ledger.
 */

/**
 * What counts as money you HOLD.
 *
 * A card, a loan or a line of credit is money OWED, and the ledger schema
 * refuses by CHECK to record one as an asset. A checking or savings account is
 * money held. Everything else is `neither`, which is the honest value for an
 * account whose kind a source did not state: an unknown account must not be
 * counted as cash on the strength of a default. Both readers — the downloaded
 * file and the hosted feed — call this one function, because a second copy of
 * this rule is how a client's debts end up inflating their net position.
 */
export function balanceRoleFor(accountKind) {
  if (["card", "loan", "line_of_credit"].includes(accountKind)) return "liability";
  if (["checking", "savings"].includes(accountKind)) return "asset";
  return "neither";
}

/** Ledger rows written by this module always carry the tenant they belong to. */
export const DEFAULT_TENANT = "primary";

/** D1 caps a batch; anything larger is split so a big first import still lands. */
const MAX_BATCH = 90;

function nowIso(now) {
  return now || new Date().toISOString();
}

/**
 * Run statements as one batch where the binding supports it, sequentially
 * otherwise. The test harness and the Worker take the same path through here.
 */
async function runAll(env, statements) {
  if (!statements.length) return;
  for (let i = 0; i < statements.length; i += MAX_BATCH) {
    const slice = statements.slice(i, i + MAX_BATCH);
    const prepared = slice.map(([sql, binds]) => env.DB.prepare(sql).bind(...binds));
    if (typeof env.DB.batch === "function") await env.DB.batch(prepared);
    else for (const statement of prepared) await statement.run();
  }
}

/**
 * The origin of everything in one import, validated once.
 *
 * `extracted` means a document was read and MUST name it. `feed` means a
 * connector reported it and MUST name the feed, which doubles as the scope key
 * so one equality match removes everything that connector ever wrote — the same
 * property `sources.name` gives the corpus.
 */
export function normaliseOrigin(origin = {}) {
  if (origin.provenance === "feed") {
    if (!origin.sourceFeed) throw new Error("a feed import must name the feed it came from");
    return { provenance: "feed", sourceDocUid: null, sourceFeed: String(origin.sourceFeed) };
  }
  if (!origin.sourceDocUid) throw new Error("a document import must name the document it was read from");
  return { provenance: "extracted", sourceDocUid: String(origin.sourceDocUid), sourceFeed: null };
}

/**
 * A transaction's stable identity.
 *
 * When the source gives one (an OFX FITID, a feed's own row id) it is used
 * directly, scoped to the account, because that is what the source guarantees
 * unique. When it does not — a CSV has no ids — the identity is the row's own
 * content plus its ordinal among identical rows in the same file, so two
 * genuinely identical transactions on the same day both survive while the same
 * file imported twice does not double.
 */
export function transactionUid(accountKey, txn, ordinal) {
  if (txn.externalId) return `${accountKey}:id:${txn.externalId}`.slice(0, 190);
  const shape = [txn.postedOn || "undated", txn.rawAmountMinor ?? "unread", txn.description || "", txn.locator || ""].join("|");
  return `${accountKey}:line:${fnv(shape)}:${ordinal}`;
}

/** Identity for a statement period read out of one specific document. */
export function statementUid(accountKey, account, origin) {
  const scope = origin.sourceDocUid || origin.sourceFeed || "unknown";
  return `${accountKey}:${account.periodStart || "open"}:${account.periodEnd || "open"}:${fnv(scope)}`;
}

/** Small stable digest, for identity only. Mirrors ingest/bank-export.mjs. */
function fnv(text) {
  let hi = 0x811c9dc5, lo = 0x9dc5811c;
  const bytes = new TextEncoder().encode(String(text));
  for (const byte of bytes) {
    hi = Math.imul(hi ^ byte, 0x01000193) >>> 0;
    lo = Math.imul(lo + byte + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * A locator a person can act on: which file, and where inside it.
 * Never a credential, never an absolute path from the operator's machine.
 */
function locatorFor(envelope, part) {
  const label = envelope.sourceLabel ? String(envelope.sourceLabel).split(/[\\/]/).pop() : "bank export";
  return `${label}#${part}`.slice(0, 300);
}

/**
 * Import one normalised bank-export envelope into the ledger.
 *
 * Returns a receipt naming what landed and what could not be read. It never
 * throws for a bad row: a row the parser could not read is a row, not an error.
 */
export async function importBankExport(env, envelope, {
  tenantId = DEFAULT_TENANT,
  entitySlug = "primary",
  entityLabel = null,
  now = null,
  origin = null,
} = {}) {
  if (!envelope?.ok) {
    return { imported: false, refused: true, reason: envelope?.refusal || "the export could not be read" };
  }
  const stamp = nowIso(now);
  const source = normaliseOrigin(origin || {
    provenance: "extracted",
    sourceDocUid: envelope.sourceDocUid,
  });
  const statements = [];
  const receipt = {
    imported: true,
    refused: false,
    tenant_id: tenantId,
    entity_slug: entitySlug,
    sign_convention: envelope.signConvention,
    established_by: envelope.establishedBy || null,
    accounts: 0,
    statements: 0,
    transactions: 0,
    unread_lines: 0,
    balance_snapshots: 0,
  };

  statements.push(entityStatement(tenantId, entitySlug, entityLabel, source, stamp));

  for (const account of envelope.accounts) {
    const accountKey = account.accountKey;
    receipt.accounts++;
    statements.push(accountStatement(tenantId, entitySlug, account, source, envelope, stamp));

    // A statement is a DOCUMENT covering a period. A feed reports activity and
    // issues no statement, so a feed import writes none: inventing one per sync
    // page would fill the close checklist with statements nobody ever received.
    if (source.provenance !== "feed" && account.periodStart && account.periodEnd) {
      statements.push(statementRow(tenantId, account, source, envelope, stamp));
      receipt.statements++;
    }
    if (account.ledgerBalanceMinor !== null && account.ledgerBalanceMinor !== undefined && account.balanceAsOf) {
      statements.push(balanceSnapshot(tenantId, account, source, envelope, stamp));
      receipt.balance_snapshots++;
    }
    if (account.periodEnd) {
      statements.push(coverageStatement(tenantId, account, source, envelope, stamp));
    }

    // Ordinals are per identical-content group, so two real transactions that
    // look the same on the same day both survive and the same file twice does
    // not double.
    const seen = new Map();
    const statementRef = source.provenance !== "feed" && account.periodStart && account.periodEnd
      ? statementUid(accountKey, account, source)
      : null;
    for (const txn of account.transactions) {
      const shapeKey = [txn.postedOn, txn.rawAmountMinor, txn.description, txn.externalId].join("|");
      const ordinal = (seen.get(shapeKey) || 0);
      seen.set(shapeKey, ordinal + 1);
      const uid = transactionUid(accountKey, txn, ordinal);
      if (txn.unparsedReason) receipt.unread_lines++;
      else receipt.transactions++;
      statements.push(transactionRow(tenantId, accountKey, uid, txn, statementRef, source, envelope, stamp));
    }
  }

  await runAll(env, statements);
  return receipt;
}

/* ------------------------------------------------------------ row builders */

function entityStatement(tenantId, entitySlug, entityLabel, source, stamp) {
  // The scope is the owner's choice of where these records belong, not a figure
  // read out of the file, so it is recorded as owner_stated. Inserted only when
  // absent: an import must never rewrite a scope the owner already named.
  return [
    `INSERT INTO fin_entities
       (tenant_id, entity_slug, legal_name, display_label, kind, provenance, basis_state, recorded_at)
     SELECT ?, ?, ?, ?, 'business', 'owner_stated', 'confirmed', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM fin_entities WHERE tenant_id = ? AND entity_slug = ? AND superseded_by_id IS NULL
     )`,
    [tenantId, entitySlug, entityLabel || entitySlug, entityLabel, stamp, tenantId, entitySlug],
  ];
}

function accountStatement(tenantId, entitySlug, account, source, envelope, stamp) {
  return [
    `INSERT INTO fin_accounts
       (tenant_id, account_slug, entity_slug, institution, label, account_kind, balance_role, mask,
        currency, feed_mode, status, external_ref, provenance, source_doc_uid, source_locator,
        source_feed, basis_state, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,'confirmed',?)
     ON CONFLICT (tenant_id, account_slug) WHERE superseded_by_id IS NULL DO UPDATE SET
       institution = COALESCE(excluded.institution, fin_accounts.institution),
       label = COALESCE(excluded.label, fin_accounts.label),
       account_kind = excluded.account_kind,
       balance_role = excluded.balance_role,
       mask = COALESCE(excluded.mask, fin_accounts.mask),
       currency = excluded.currency,
       source_doc_uid = excluded.source_doc_uid,
       source_locator = excluded.source_locator,
       source_feed = excluded.source_feed,
       recorded_at = excluded.recorded_at`,
    [
      tenantId, account.accountKey, entitySlug, account.institution || null,
      account.label || (account.mask ? `account ending ${account.mask}` : null),
      account.accountKind, account.balanceRole, account.mask || null,
      account.currency || "USD",
      source.provenance === "feed" ? "live" : "manual",
      account.externalRef || null,
      source.provenance, source.sourceDocUid, locatorFor(envelope, "account"),
      source.sourceFeed, stamp,
    ],
  ];
}

function statementRow(tenantId, account, source, envelope, stamp) {
  const uid = statementUid(account.accountKey, account, source);
  // parse_state is `parsed` only because a closing balance was actually read.
  // Received is not read and read is not reconciled; the schema keeps those
  // three apart and this is the one place they could be conflated.
  const parsed = account.ledgerBalanceMinor !== null && account.ledgerBalanceMinor !== undefined;
  return [
    `INSERT INTO fin_statements
       (tenant_id, statement_uid, account_slug, period_start, period_end, opening_balance_minor,
        closing_balance_minor, currency, line_count_stated, parse_state, received_at, parsed_at,
        provenance, source_doc_uid, source_locator, source_feed, basis_state, recorded_at)
     VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,'confirmed',?)
     ON CONFLICT (tenant_id, statement_uid) WHERE superseded_by_id IS NULL DO UPDATE SET
       closing_balance_minor = excluded.closing_balance_minor,
       line_count_stated = excluded.line_count_stated,
       parse_state = excluded.parse_state,
       parsed_at = excluded.parsed_at,
       recorded_at = excluded.recorded_at`,
    [
      tenantId, uid, account.accountKey, account.periodStart, account.periodEnd,
      parsed ? account.ledgerBalanceMinor : null,
      account.currency || "USD",
      account.transactions.length,
      parsed ? "parsed" : "received",
      stamp, parsed ? stamp : null,
      source.provenance, source.sourceDocUid, locatorFor(envelope, "statement"),
      source.sourceFeed, stamp,
    ],
  ];
}

function balanceSnapshot(tenantId, account, source, envelope, stamp) {
  return [
    `INSERT INTO fin_balance_snapshots
       (tenant_id, account_slug, as_of_date, current_minor, available_minor, currency,
        provenance, source_doc_uid, source_locator, source_feed, basis_state, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed',?)
     ON CONFLICT (tenant_id, account_slug, as_of_date, provenance) DO UPDATE SET
       current_minor = excluded.current_minor,
       available_minor = excluded.available_minor,
       source_doc_uid = excluded.source_doc_uid,
       source_locator = excluded.source_locator,
       recorded_at = excluded.recorded_at`,
    [
      tenantId, account.accountKey, account.balanceAsOf,
      account.ledgerBalanceMinor,
      account.availableBalanceMinor ?? null,
      account.currency || "USD",
      source.provenance, source.sourceDocUid, locatorFor(envelope, "balance"),
      source.sourceFeed, stamp,
    ],
  ];
}

function coverageStatement(tenantId, account, source, envelope, stamp) {
  // `partial` and a through-date, never `complete`: one export proves the days
  // it covers and says nothing about the days on either side of it.
  const unread = account.transactions.filter((t) => t.unparsedReason).length;
  const note = unread
    ? `Read from a bank export covering ${account.periodStart || "an unstated start"} to ${account.periodEnd}. ` +
      `${unread} line(s) in it could not be read and are recorded as unread.`
    : `Read from a bank export covering ${account.periodStart || "an unstated start"} to ${account.periodEnd}.`;
  return [
    `INSERT INTO fin_account_coverage
       (tenant_id, account_slug, coverage_status, covered_from, covered_to, basis_note, computed_at,
        provenance, source_doc_uid, source_locator, source_feed, basis_state, recorded_at)
     VALUES (?,?,'partial',?,?,?,?,?,?,?,?,'confirmed',?)
     ON CONFLICT (tenant_id, account_slug) WHERE superseded_by_id IS NULL DO UPDATE SET
       covered_from = MIN(COALESCE(fin_account_coverage.covered_from, excluded.covered_from), excluded.covered_from),
       covered_to = MAX(COALESCE(fin_account_coverage.covered_to, excluded.covered_to), excluded.covered_to),
       basis_note = excluded.basis_note,
       computed_at = excluded.computed_at,
       recorded_at = excluded.recorded_at`,
    [
      tenantId, account.accountKey, account.periodStart || null, account.periodEnd, note, stamp,
      source.provenance === "feed" ? "feed" : "derived",
      source.provenance === "feed" ? null : source.sourceDocUid,
      locatorFor(envelope, "coverage"),
      source.sourceFeed, stamp,
    ],
  ];
}

function transactionRow(tenantId, accountKey, uid, txn, statementRef, source, envelope, stamp) {
  const unread = Boolean(txn.unparsedReason);
  return [
    `INSERT INTO fin_transactions
       (tenant_id, txn_uid, account_slug, posted_on, amount_minor, direction, raw_amount_minor,
        raw_sign_convention, currency, description, payee, pending, statement_uid, external_id,
        provenance, source_doc_uid, source_locator, source_feed, basis_state, unparsed_reason, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id, txn_uid) WHERE superseded_by_id IS NULL DO UPDATE SET
       posted_on = excluded.posted_on,
       amount_minor = excluded.amount_minor,
       direction = excluded.direction,
       raw_amount_minor = excluded.raw_amount_minor,
       raw_sign_convention = excluded.raw_sign_convention,
       description = excluded.description,
       payee = excluded.payee,
       pending = excluded.pending,
       statement_uid = COALESCE(excluded.statement_uid, fin_transactions.statement_uid),
       basis_state = excluded.basis_state,
       unparsed_reason = excluded.unparsed_reason,
       source_locator = excluded.source_locator,
       recorded_at = excluded.recorded_at`,
    [
      tenantId, uid, accountKey,
      txn.postedOn || null,
      unread ? null : txn.amountMinor,
      unread ? null : txn.direction,
      unread ? null : txn.rawAmountMinor,
      unread ? null : envelope.signConvention,
      txn.currency || envelope.currency || accountCurrency(envelope, accountKey),
      txn.description || null,
      txn.payee || null,
      txn.pending ? 1 : 0,
      statementRef,
      txn.externalId || null,
      source.provenance, source.sourceDocUid, locatorFor(envelope, txn.locator || "line"),
      source.sourceFeed,
      unread ? "unparsed" : "confirmed",
      unread ? txn.unparsedReason : null,
      stamp,
    ],
  ];
}

function accountCurrency(envelope, accountKey) {
  return envelope.accounts.find((a) => a.accountKey === accountKey)?.currency || "USD";
}
