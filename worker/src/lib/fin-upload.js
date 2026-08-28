/**
 * fin-upload — the way a downloaded bank export actually reaches the ledger.
 *
 * WHY THIS EXISTS
 *
 * The file reader (`ingest/bank-export.mjs`) and the ledger writer
 * (`fin-import.js`) were both built and tested, and between them there was
 * nothing. A client who dropped an OFX file into their folder got a paragraph
 * of prose in their document corpus and not one row in `fin_transactions`, and
 * a CSV was not treated as a bank export at all. Parsed figures went nowhere.
 *
 * This module is the seam: one operator-only route that takes an ALREADY
 * NORMALISED envelope and hands it to `importBankExport`, the single write
 * boundary the hosted feed already uses. It writes no ledger rows of its own,
 * because a second writer is how two sources start disagreeing about what a
 * negative number means.
 *
 * WHY THE FILE IS PARSED ON THE OPERATOR'S MACHINE AND NOT HERE
 *
 * The reader is a zero-dependency Node module that lives with the installer, is
 * pinned by 79 of its own tests, and — most importantly — is where the refusals
 * are written for the person holding the file. Shipping a copy of it into the
 * worker would put the sign conventions in two places, which the one-boundary
 * design exists to prevent. So the CLI reads the file, and what crosses the
 * wire is figures with an explicit direction, never a credential and never the
 * full account number, which the reader has already thrown away.
 *
 * WHAT THIS MODULE STILL REFUSES TO TAKE ON TRUST
 *
 * An envelope arriving over HTTP is a claim, not a reading. Everything that can
 * be rechecked from the envelope alone is rechecked here: the named sign
 * convention has to be one this codebase actually defines, `amount_minor` has
 * to be the magnitude of the signed source figure, a row with no figure has to
 * carry a reason, and the "money you hold" rule is RECOMPUTED from the account
 * kind rather than believed. What cannot be rechecked without the file is not
 * pretended to be: this route can prove an envelope is self-consistent, and it
 * cannot prove it describes the file it claims to.
 */

import { jsonResponse } from "./core.js";
import { importBankExport, balanceRoleFor, DEFAULT_TENANT } from "./fin-import.js";
import { ledgerInstalled } from "./fin-d1.js";

/** Operator-only. Mounted behind the admin-key gate in `index.js`. */
export const BANK_IMPORT_PATH = "/api/admin/fin/import-bank-export";

/**
 * Every sign convention this codebase defines, and whether a row's direction
 * can be rechecked from the sign of its own source figure.
 *
 * `signed` conventions always write a negative source figure for money leaving,
 * so direction and sign must agree and a disagreement is a corrupted envelope.
 * `per_file` is the balance-verified CSV shape, where which sign means outflow
 * was ESTABLISHED PER FILE against that file's running balance — a positive
 * outflow is legitimate there, and asserting otherwise would refuse correctly
 * read files.
 */
export const KNOWN_SIGN_CONVENTIONS = Object.freeze({
  ofx_trnamt_negative_is_outflow: "signed",
  csv_paired_debit_and_credit_columns: "signed",
  csv_signed_amount_with_type_column: "signed",
  csv_signed_amount_verified_against_running_balance: "per_file",
});

const ACCOUNT_KINDS = new Set([
  "checking", "savings", "card", "loan", "line_of_credit", "investment",
  "retirement", "merchant", "point_of_sale", "escrow", "other",
]);

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One import, bounded. A two-year export is a few thousand rows; twenty
 * thousand is far past any statement and into "something built this file", and
 * a bounded refusal that names the limit is better than a request that dies on
 * the clock halfway through writing a month.
 */
export const MAX_TRANSACTIONS_PER_IMPORT = 20_000;
const MAX_ACCOUNTS_PER_IMPORT = 64;

const isMinor = (value) => Number.isSafeInteger(value);

function badEnvelope(error) {
  return { ok: false, error };
}

/**
 * Check an envelope is internally consistent and safe to write.
 *
 * Returns `{ ok: true, envelope }` with the account rules RECOMPUTED, or
 * `{ ok: false, error }` naming the first thing that was wrong. It is a
 * validator, not a repairer: nothing here quietly corrects a figure, because a
 * silently corrected figure is indistinguishable from a correct one.
 */
export function validateBankEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return badEnvelope("the import body carried no envelope");
  if (envelope.ok !== true) {
    return badEnvelope(
      envelope.refusal
        ? `the export was refused by the reader and must not be imported: ${String(envelope.refusal).slice(0, 400)}`
        : "this envelope does not say the export was read successfully",
    );
  }
  const convention = String(envelope.signConvention || "");
  if (!Object.hasOwn(KNOWN_SIGN_CONVENTIONS, convention)) {
    return badEnvelope(
      `"${convention.slice(0, 60) || "(none)"}" is not a sign convention this brain defines, so no row from ` +
      "this envelope could honestly record which way its money moved",
    );
  }
  const signIsCheckable = KNOWN_SIGN_CONVENTIONS[convention] === "signed";
  if (!envelope.sourceDocUid || typeof envelope.sourceDocUid !== "string") {
    return badEnvelope("a file import must name the document it was read from, and this envelope names none");
  }
  const accounts = envelope.accounts;
  if (!Array.isArray(accounts) || !accounts.length) return badEnvelope("this envelope holds no accounts");
  if (accounts.length > MAX_ACCOUNTS_PER_IMPORT) {
    return badEnvelope(`this envelope holds ${accounts.length} accounts, past the ${MAX_ACCOUNTS_PER_IMPORT} one import accepts`);
  }

  let transactions = 0;
  const checked = [];
  for (const account of accounts) {
    if (!account || typeof account !== "object") return badEnvelope("one account in this envelope is not an object");
    if (!SLUG.test(String(account.accountKey || ""))) {
      return badEnvelope(`"${String(account.accountKey).slice(0, 70)}" is not a usable account key`);
    }
    if (!ACCOUNT_KINDS.has(account.accountKind)) {
      return badEnvelope(`"${String(account.accountKind).slice(0, 40)}" is not an account kind the ledger records`);
    }
    if (!/^[A-Z]{3}$/.test(String(account.currency || ""))) {
      return badEnvelope(`"${String(account.currency).slice(0, 12)}" is not a three-letter currency code`);
    }
    // The one rule that decides whether a client's debts inflate their net
    // position. Recomputed from the kind, never accepted from the wire.
    const role = balanceRoleFor(account.accountKind);
    if (account.balanceRole && account.balanceRole !== role) {
      return badEnvelope(
        `this envelope calls a ${account.accountKind} account "${account.balanceRole}", and a ${account.accountKind} ` +
        `is ${role}. Money owed cannot be recorded as money held`,
      );
    }
    for (const field of ["periodStart", "periodEnd", "balanceAsOf"]) {
      const value = account[field];
      if (value !== null && value !== undefined && !ISO_DATE.test(String(value))) {
        return badEnvelope(`this envelope's ${field} is not a YYYY-MM-DD date`);
      }
    }
    for (const field of ["ledgerBalanceMinor", "availableBalanceMinor"]) {
      const value = account[field];
      if (value !== null && value !== undefined && !isMinor(value)) {
        return badEnvelope(`this envelope's ${field} is not an exact figure in minor units`);
      }
    }
    if (!Array.isArray(account.transactions)) return badEnvelope("one account in this envelope has no transaction list");

    for (const txn of account.transactions) {
      if (!txn || typeof txn !== "object") return badEnvelope("one transaction in this envelope is not an object");
      transactions++;
      if (txn.unparsedReason) {
        // The ledger refuses by CHECK to store a figure beside an unread line.
        // Refusing here as well means the refusal is a sentence rather than a
        // constraint violation nobody can act on.
        if (txn.amountMinor !== null && txn.amountMinor !== undefined) {
          return badEnvelope("a line marked unread carries a figure, which the ledger refuses to store");
        }
        if (typeof txn.unparsedReason !== "string" || !txn.unparsedReason.trim()) {
          return badEnvelope("a line marked unread carries no reason it could not be read");
        }
        continue;
      }
      if (txn.direction !== "inflow" && txn.direction !== "outflow") {
        return badEnvelope(`"${String(txn.direction).slice(0, 24)}" is not a direction; every readable line must be an inflow or an outflow`);
      }
      if (!isMinor(txn.amountMinor) || txn.amountMinor < 0) {
        return badEnvelope("a readable line carries an amount that is not an exact non-negative figure in minor units");
      }
      if (!isMinor(txn.rawAmountMinor)) {
        return badEnvelope("a readable line carries no exact source figure, so its reading could never be checked against the file");
      }
      if (Math.abs(txn.rawAmountMinor) !== txn.amountMinor) {
        return badEnvelope(
          `a line's amount (${txn.amountMinor}) is not the magnitude of the figure the file carried ` +
          `(${txn.rawAmountMinor}), so this envelope contradicts itself`,
        );
      }
      if (signIsCheckable && txn.rawAmountMinor !== 0) {
        const expected = txn.rawAmountMinor < 0 ? "outflow" : "inflow";
        if (txn.direction !== expected) {
          return badEnvelope(
            `under ${convention} a source figure of ${txn.rawAmountMinor} is an ${expected}, and this envelope ` +
            `calls it an ${txn.direction}. Nothing was imported`,
          );
        }
      }
      if (txn.postedOn !== null && txn.postedOn !== undefined && !ISO_DATE.test(String(txn.postedOn))) {
        return badEnvelope("a readable line carries a posting date that is not YYYY-MM-DD");
      }
    }
    checked.push({ ...account, balanceRole: role });
  }

  if (!transactions) return badEnvelope("this envelope holds no transactions, so importing it would land nothing");
  if (transactions > MAX_TRANSACTIONS_PER_IMPORT) {
    return badEnvelope(
      `this export holds ${transactions} lines, past the ${MAX_TRANSACTIONS_PER_IMPORT} one import accepts. ` +
      "Export a narrower date range and import it in pieces; re-importing an overlap is safe",
    );
  }
  return { ok: true, envelope: { ...envelope, accounts: checked }, transactions };
}

/**
 * POST /api/admin/fin/import-bank-export
 *
 * Body: `{ envelope, entity_slug?, entity_label? }`. Answers with the receipt
 * `importBankExport` produced, unchanged, so what the operator is told is what
 * the ledger was actually asked to do.
 */
export async function handleBankExportImport(env, request) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ imported: false, refused: true, reason: "the import body was not readable JSON" }, 400);
  }

  const entitySlug = body?.entity_slug === undefined || body?.entity_slug === null
    ? "primary"
    : String(body.entity_slug);
  if (!SLUG.test(entitySlug)) {
    return jsonResponse({
      imported: false, refused: true,
      reason: `"${entitySlug.slice(0, 70)}" is not a usable entity name; use lowercase letters, digits, - and _`,
    }, 400);
  }

  const checked = validateBankEnvelope(body?.envelope);
  if (!checked.ok) return jsonResponse({ imported: false, refused: true, reason: checked.error }, 400);

  // A missing ledger is a migration that has not been run, not a bad request.
  // Saying which tables are absent, and which command creates them, is the
  // difference between a five-second fix and a support thread.
  const install = await ledgerInstalled(env);
  if (!install.installed) {
    return jsonResponse({
      imported: false, refused: true,
      reason: install.unavailable
        ? "this brain's database could not be reached, so nothing was imported"
        : `this brain has no financial ledger yet (missing: ${install.missing.join(", ")}). ` +
          "Run `brain migrate <manifest>` first, then import again",
    }, 409);
  }

  const receipt = await importBankExport(env, checked.envelope, {
    tenantId: DEFAULT_TENANT,
    entitySlug,
    entityLabel: body?.entity_label ? String(body.entity_label).slice(0, 200) : null,
    origin: { provenance: "extracted", sourceDocUid: checked.envelope.sourceDocUid },
  });
  return jsonResponse({
    ...receipt,
    source_label: checked.envelope.sourceLabel || null,
    source_doc_uid: checked.envelope.sourceDocUid,
  });
}
