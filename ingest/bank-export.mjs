/**
 * Bank export files: OFX, QFX and CSV, read into figures rather than prose.
 *
 * WHY THIS EXISTS, AND WHY IT IS FIRST
 *
 * Every bank on earth lets the account holder download their own transactions.
 * No aggregator agreement, no approval queue, no per-account fee, and it works
 * for the small institutions no hosted feed supports. It is the cheapest path
 * to the one capability the research asked for most, and it needs nothing from
 * anybody but the owner and their own browser.
 *
 * Read as text, a bank export is close to worthless. "15234.11" carries no
 * meaning without its column, and a year of them embeds as a wall of digits
 * that answers no question. The ledger (migration 0015) is where these belong:
 * one row per transaction, an integer in minor units, a direction, and a line
 * back to the file it was read from.
 *
 * THREE RULES THIS FILE KEEPS
 *
 * 1. NO FLOAT TOUCHES MONEY. Amounts are parsed from their digits into integer
 *    minor units. `parseFloat("0.1") + parseFloat("0.2")` is the reason; a
 *    ledger that is out by a cent per thousand rows is worse than one that is
 *    obviously broken, because nobody notices.
 *
 * 2. THE SIGN CONVENTION IS ESTABLISHED FROM THE FORMAT, NEVER ASSUMED. Each
 *    format states its own convention below, in a comment, next to the code
 *    that applies it, and each is pinned by a test. A convention read backwards
 *    turns every figure the product shows into a confident lie: income becomes
 *    spending, a profit becomes a loss, and every citation still resolves.
 *
 * 3. WHEN THE SHAPE CANNOT BE ESTABLISHED, REFUSE. CSV has no standard. A file
 *    whose amount column cannot be identified, or whose sign cannot be tied to
 *    a direction by something IN THE FILE, is declined by name. Guessing which
 *    column is the amount is not a smaller failure than declining; it is a
 *    larger one wearing a smaller face.
 *
 * PRIVACY: an OFX file contains the FULL account number. It is never stored.
 * The account is keyed by a stable digest of institution plus account number,
 * and only the last four digits survive, in the column the schema already
 * restricts to four characters.
 */

// The ledger write boundary owns the money rules. See the note beside the
// re-export below; this is the same direction ingest already depends in for
// the transcript reader.
import { balanceRoleFor } from "../worker/src/lib/fin-import.js";

/* ------------------------------------------------------------------ money */

/**
 * Minor-unit exponents for the currencies a bank export realistically names.
 * Anything unlisted is treated as two, which is right for the overwhelming
 * majority and is recorded on the row alongside its currency so a wrong guess
 * is visible rather than silent.
 */
const CURRENCY_EXPONENT = new Map([
  ["JPY", 0], ["KRW", 0], ["CLP", 0], ["ISK", 0], ["VND", 0],
  ["BHD", 3], ["JOD", 3], ["KWD", 3], ["OMR", 3], ["TND", 3],
]);

export function currencyExponent(code) {
  return CURRENCY_EXPONENT.get(String(code || "USD").toUpperCase()) ?? 2;
}

/**
 * A written amount, into integer minor units.
 *
 * Returns `{ minor }` or `{ error }`. It NEVER returns a rounded figure: a
 * value carrying more fractional digits than its currency has is refused
 * unless the extra digits are zeros, because silently dropping half a cent is
 * the same class of mistake as inventing one.
 *
 * Accepted: leading or trailing sign, parentheses for negative (the accounting
 * convention every spreadsheet emits), a currency symbol, and grouping
 * separators. Refused: a bare comma that could be either a decimal separator or
 * a group separator, which is a real ambiguity in exports from mixed locales.
 */
export function parseMinorUnits(raw, { exponent = 2 } = {}) {
  if (raw === null || raw === undefined) return { error: "no value" };
  let text = String(raw).trim();
  if (!text) return { error: "no value" };

  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  // A currency symbol or code may sit on either side. Strip letters and symbols
  // but not digits, separators or signs.
  text = text.replace(/[^\d.,+\-\s]/g, "").trim();
  if (/^[-+]/.test(text)) { if (text[0] === "-") negative = !negative; text = text.slice(1).trim(); }
  if (/[-+]$/.test(text)) { if (text.endsWith("-")) negative = !negative; text = text.slice(0, -1).trim(); }
  text = text.replace(/\s/g, "");
  if (!text) return { error: "no digits" };
  if (/[-+]/.test(text)) return { error: `"${String(raw).slice(0, 24)}" carries more than one sign` };

  const dots = (text.match(/\./g) || []).length;
  const commas = (text.match(/,/g) || []).length;
  let integerPart;
  let fractionPart = "";

  if (dots && commas) {
    // Whichever separator appears last is the decimal one; the other groups.
    const decimal = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    const cut = text.lastIndexOf(decimal);
    integerPart = text.slice(0, cut).split(group).join("");
    fractionPart = text.slice(cut + 1);
    if (integerPart.includes(decimal)) return { error: `"${String(raw).slice(0, 24)}" has more than one decimal separator` };
  } else if (dots > 1 || commas > 1) {
    // Repeated separator can only be grouping.
    integerPart = text.split(dots > 1 ? "." : ",").join("");
  } else if (commas === 1) {
    const after = text.slice(text.indexOf(",") + 1);
    // "1,234" is one thousand two hundred and thirty four everywhere. "1,23"
    // is one and twenty three hundredths in half the world and unwritable in
    // the other half, so it is refused rather than resolved by coin flip.
    if (after.length === 3) integerPart = text.split(",").join("");
    else return {
      error: `"${String(raw).slice(0, 24)}" could be either 1.234,56-style or 1,234.56-style, ` +
        "so its decimal separator cannot be established from the value alone",
    };
  } else if (dots === 1) {
    integerPart = text.slice(0, text.indexOf("."));
    fractionPart = text.slice(text.indexOf(".") + 1);
  } else {
    integerPart = text;
  }

  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fractionPart)) {
    return { error: `"${String(raw).slice(0, 24)}" is not a number` };
  }
  if (!integerPart && !fractionPart) return { error: "no digits" };

  let fraction = fractionPart;
  if (fraction.length > exponent) {
    const extra = fraction.slice(exponent);
    if (/[^0]/.test(extra)) {
      return {
        error: `"${String(raw).slice(0, 24)}" carries ${fraction.length} decimal places where this ` +
          `currency has ${exponent}; rounding it would invent a figure`,
      };
    }
    fraction = fraction.slice(0, exponent);
  }
  fraction = fraction.padEnd(exponent, "0");

  const digits = `${integerPart || "0"}${fraction}`;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return { error: "the amount is larger than this can represent exactly" };
  return { minor: negative ? -minor : minor };
}

/* ------------------------------------------------------------------ dates */

/** A date the ledger will accept: YYYY-MM-DD, or null. */
function isoDate(y, m, d) {
  const year = Number(y), month = Number(m), day = Number(d);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * An OFX timestamp: YYYYMMDD, optionally HHMMSS and an optional [-7:MST] zone.
 * Only the calendar date is kept; the ledger dates a posting to a day and a
 * time-of-day would imply a precision the statement does not have.
 */
export function ofxDate(raw) {
  const text = String(raw || "").trim();
  const m = text.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? isoDate(m[1], m[2], m[3]) : null;
}

/**
 * A CSV date. Unambiguous forms only, plus the two US/European orders resolved
 * ACROSS THE WHOLE COLUMN rather than per value: a column containing a day
 * above twelve settles the order for every row in it. A column where the order
 * cannot be settled is refused by the caller, never guessed, because a
 * mis-ordered date column silently moves a whole month of activity.
 */
function csvDateCandidates(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) { const iso = isoDate(m[1], m[2], m[3]); return iso ? { unambiguous: iso } : null; }
  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const monthFirst = isoDate(m[3], m[1], m[2]);
    const dayFirst = isoDate(m[3], m[2], m[1]);
    if (!monthFirst && !dayFirst) return null;
    if (monthFirst && !dayFirst) return { unambiguous: monthFirst, settles: "month_first" };
    if (dayFirst && !monthFirst) return { unambiguous: dayFirst, settles: "day_first" };
    return { monthFirst, dayFirst };
  }
  m = text.match(/^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{4})$/);
  if (m) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const idx = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (idx < 0) return null;
    const iso = isoDate(m[3], idx + 1, m[1]);
    return iso ? { unambiguous: iso } : null;
  }
  return null;
}

/* ------------------------------------------------------------- OFX / QFX */

/**
 * OFX 1.x is SGML: leaf elements have an opening tag and a value and usually no
 * closing tag at all. OFX 2.x is well-formed XML. QFX is OFX plus a couple of
 * vendor tags. One tokenizer reads all three, because they are the same
 * grammar with a stricter cousin.
 *
 * Returns a tree of `{ tag, children, value }`. Values are the text between a
 * leaf's opening tag and whatever comes next.
 */
export function parseSgml(text) {
  const root = { tag: "#root", children: [], value: null };
  const stack = [root];
  const tagPattern = /<\s*(\/?)\s*([A-Za-z0-9._:-]+)\s*>/g;
  let match;
  let cursor = 0;
  while ((match = tagPattern.exec(text)) !== null) {
    const between = text.slice(cursor, match.index).trim();
    if (between) {
      const top = stack[stack.length - 1];
      if (top !== root) top.value = (top.value ? `${top.value} ` : "") + between;
    }
    cursor = tagPattern.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2].toUpperCase();
    if (closing) {
      // Close the nearest matching ancestor. An unclosed SGML leaf inside it is
      // closed implicitly, which is exactly what the format means.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    // SGML closes a leaf implicitly. An element that already has text and then
    // meets another opening tag has ended, so it is popped before the new one
    // is pushed. Without this every unclosed OFX leaf nests inside the one
    // before it and the tree is a chain rather than a record.
    while (stack.length > 1 && stack[stack.length - 1].value !== null) stack.pop();
    const node = { tag, children: [], value: null };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

function findAll(node, tag, out = []) {
  for (const child of node.children) {
    if (child.tag === tag) out.push(child);
    findAll(child, tag, out);
  }
  return out;
}

function firstValue(node, tag) {
  for (const child of node.children) {
    if (child.tag === tag) return child.value;
    const nested = firstValue(child, tag);
    if (nested !== null && nested !== undefined) return nested;
  }
  return null;
}

function firstChild(node, tag) {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const nested = firstChild(child, tag);
    if (nested) return nested;
  }
  return null;
}

/**
 * THE OFX SIGN CONVENTION, WRITTEN DOWN ONCE.
 *
 * OFX <TRNAMT> is SIGNED RELATIVE TO THE ACCOUNT'S OWN BALANCE.
 *
 *     TRNAMT is NEGATIVE  ->  the balance goes DOWN  ->  money LEAVES  ->  outflow
 *     TRNAMT is POSITIVE  ->  the balance goes UP    ->  money ARRIVES ->  inflow
 *
 * This is the opposite of the hosted feed in `worker/src/lib/bank-feed.js`,
 * where a positive number means money leaving. Two sources, two conventions,
 * one ledger: both are normalised HERE, at the write boundary, into an unsigned
 * `amount_minor` plus an explicit `direction`, and the signed source figure is
 * kept in `raw_amount_minor` next to the name of the convention it came from,
 * so a disagreement is diagnosable instead of merely wrong.
 *
 * On a credit card statement the same rule holds against the card's balance:
 * a purchase is negative and a payment to the card is positive. The ledger
 * records the card as a liability, which is where "money you owe is not money
 * you hold" is enforced, not here.
 */
export const OFX_SIGN_CONVENTION = "ofx_trnamt_negative_is_outflow";

const OFX_ACCOUNT_KIND = new Map([
  ["CHECKING", "checking"], ["SAVINGS", "savings"], ["MONEYMRKT", "savings"],
  ["CD", "savings"], ["CREDITLINE", "line_of_credit"],
]);

function accountKindFor(acctType, isCard) {
  if (isCard) return "card";
  return OFX_ACCOUNT_KIND.get(String(acctType || "").toUpperCase()) || "other";
}

/**
 * Re-exported from the ledger write boundary, deliberately not redefined here.
 * "What counts as money you hold" is one rule and it has one home; a second
 * copy of it in the file reader is how a card ends up counted as cash.
 */
export { balanceRoleFor };

/**
 * A stable, non-reversible key for an account.
 *
 * The full account number never reaches the database. This digest is what makes
 * a second import of an overlapping export land on the SAME account row instead
 * of creating a second one, and it is deliberately not decodable back into the
 * number it was built from.
 */
export function accountKeyFor(institutionId, accountNumber) {
  return `bank-${digest(`${String(institutionId || "")}|${String(accountNumber || "")}`)}`;
}

/**
 * A small, stable, non-cryptographic digest (FNV-1a, 64 bits, hex).
 *
 * Used for identity, never for secrecy or integrity. It runs identically in
 * Node and in a Worker with no dependency and no async, which matters because
 * the same identifiers have to be derivable on both sides of the install.
 */
export function digest(text) {
  let hi = 0x811c9dc5, lo = 0x9dc5811c;
  const bytes = new TextEncoder().encode(String(text));
  for (const byte of bytes) {
    hi = Math.imul(hi ^ byte, 0x01000193) >>> 0;
    lo = Math.imul(lo + byte + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  return (hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0"));
}

function maskOf(accountNumber) {
  const digits = String(accountNumber || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : (digits || null);
}

/**
 * The opening balance the STATEMENT ITSELF states, or null.
 *
 * OFX has no required opening-balance element, which is why the check below is
 * conditional rather than universal. What it does have is `<BALLIST>`, an
 * optional list of named balances a bank may include, and the one worth reading
 * is the balance the period STARTED at. Only the file's own opening balance is
 * accepted as an anchor: it came off the same statement as the transactions and
 * the closing balance, so if the three disagree the disagreement is about the
 * figures and nothing else. A balance from anywhere else — a previous month's
 * import, a figure the operator typed — can disagree for reasons that have
 * nothing to do with a sign convention (a gap between statements, a pending
 * item, a correction), and a check that refuses good files for the wrong reason
 * teaches the operator to switch it off.
 */
function openingBalanceFrom(node, exponent) {
  const list = firstChild(node, "BALLIST");
  if (!list) return { minor: null, label: null };
  for (const bal of findAll(list, "BAL")) {
    const label = [firstValue(bal, "NAME"), firstValue(bal, "DESC")].filter(Boolean).join(" ").trim();
    if (!/open|begin|previous|prior|start|brought forward/i.test(label)) continue;
    const parsed = parseMinorUnits(firstValue(bal, "VALUE"), { exponent });
    if (parsed.error) continue;
    return { minor: parsed.minor, label: label.slice(0, 60) };
  }
  return { minor: null, label: null };
}

/**
 * DOES THIS STATEMENT'S OWN ARITHMETIC AGREE WITH THE SPEC'S SIGN CONVENTION?
 *
 * The OFX convention above is TRUE BY SPECIFICATION, and until this function
 * existed it was also never checked. A card export that writes a purchase as a
 * positive number — rare, but real — would have landed every purchase as money
 * arriving, every payment as money leaving, and the ledger would have looked
 * entirely plausible with a citation under every figure. That is the exact
 * failure mode the CSV reader already refuses to allow, and there was no reason
 * the OFX reader should get a pass on it just because a document says so.
 *
 * So: where the statement states an opening balance, opening plus the period's
 * activity must equal the closing balance under the convention as written, and
 * must NOT equal it with every sign flipped. Returns one of four states, and
 * `unverifiable` is a first-class answer rather than a quiet success.
 */
export function verifyOfxDirection(account) {
  const opening = account.openingBalanceMinor;
  const closing = account.ledgerBalanceMinor;
  const unread = account.transactions.filter((txn) => txn.unparsedReason).length;
  if (opening === null || opening === undefined || closing === null || closing === undefined) {
    return {
      state: "unverifiable",
      reason: "this statement carries no opening balance to check its transactions against, so the " +
        "direction of every amount is taken on trust from the OFX specification rather than verified",
    };
  }
  if (unread) {
    return {
      state: "unverifiable",
      reason: `${unread} line(s) in this statement could not be read, so its own arithmetic cannot be ` +
        "closed and the direction of every amount is taken on trust from the OFX specification rather than verified",
    };
  }
  const net = account.transactions.reduce((total, txn) => total + (txn.rawAmountMinor || 0), 0);
  const asWritten = opening + net === closing;
  const flipped = opening - net === closing;
  const figures = {
    openingBalanceMinor: opening,
    closingBalanceMinor: closing,
    netMinor: net,
    checked: account.transactions.length,
  };
  if (asWritten && flipped) {
    return {
      state: "unverifiable",
      ...figures,
      reason: "every readable amount in this statement nets to zero, so both readings close it and " +
        "neither one is proved; the direction is taken on trust from the OFX specification",
    };
  }
  if (asWritten) {
    return {
      state: "verified",
      ...figures,
      reason: `${figures.checked} transaction(s) move this statement from its stated opening balance to its ` +
        "stated closing balance exactly, and do not when every sign is read the other way",
    };
  }
  if (flipped) return { state: "inverted", ...figures };
  return { state: "unreconciled", ...figures };
}

/**
 * WHY A FILE THAT ONLY FITS INVERTED IS REFUSED RATHER THAN ADOPTED.
 *
 * When the flipped reading closes the statement and the written one does not,
 * there are at least two explanations and the file does not say which: the bank
 * inverted its amounts, or one of the two balances is wrong (a prior period's
 * closing written into the opening slot is the common one). Adopting the
 * flipped reading picks the flattering explanation on the strength of a single
 * arithmetic identity, and then writes a full month of inverted figures into a
 * ledger that will be summed by code, and read by people, who never see the
 * receipt that said so. Refusing costs the owner one re-export. Adopting costs
 * them a P&L that is exactly backwards with a real citation under every number,
 * which is the failure this product exists to make impossible.
 */
function directionRefusal(account, check) {
  const where = account.mask ? `the account ending ${account.mask}` : "an account in this file";
  const money = (value) => formatMinor(value, account.currency);
  const asWritten = money(check.openingBalanceMinor + check.netMinor);
  if (check.state === "inverted") {
    return `the amounts for ${where} are signed the OPPOSITE way round to the OFX specification. Read as the ` +
      `format defines them, ${money(check.openingBalanceMinor)} opening plus ${money(check.netMinor)} of ` +
      `activity comes to ${asWritten}, and the statement says it closed at ` +
      `${money(check.closingBalanceMinor)}; flip every sign and it closes exactly. Either the export inverted ` +
      "its amounts or one of its two balances is wrong, the file does not say which, so nothing was read from " +
      "it. Re-download this statement from the bank, and if it comes out the same way, export it as CSV " +
      "including a running balance column, which is checked row by row.";
  }
  return `the transactions for ${where} do not close its own statement under either reading: ` +
    `${money(check.openingBalanceMinor)} opening plus ${money(check.netMinor)} of activity comes to ` +
    `${asWritten}, reading every sign the other way comes to ` +
    `${money(check.openingBalanceMinor - check.netMinor)}, and the statement says it closed at ` +
    `${money(check.closingBalanceMinor)}. Either this export is missing transactions from the period it ` +
    "claims to cover, or one of its balances belongs to a different period. Re-export the full statement " +
    "period and try again.";
}

function readOfxStatement(node, { isCard }) {
  const currency = String(firstValue(node, "CURDEF") || "USD").toUpperCase().slice(0, 3) || "USD";
  const exponent = currencyExponent(currency);
  const acctFrom = firstChild(node, isCard ? "CCACCTFROM" : "BANKACCTFROM") || firstChild(node, "CCACCTFROM") || firstChild(node, "BANKACCTFROM");
  const accountNumber = acctFrom ? firstValue(acctFrom, "ACCTID") : null;
  const institutionId = acctFrom ? (firstValue(acctFrom, "BANKID") || firstValue(acctFrom, "ORG") || "") : "";
  const acctType = acctFrom ? firstValue(acctFrom, "ACCTTYPE") : null;
  const accountKind = accountKindFor(acctType, isCard);

  const tranList = firstChild(node, "BANKTRANLIST") || firstChild(node, "CCTRANLIST");
  const periodStart = tranList ? ofxDate(firstValue(tranList, "DTSTART")) : null;
  const periodEnd = tranList ? ofxDate(firstValue(tranList, "DTEND")) : null;

  const ledgerBal = firstChild(node, "LEDGERBAL");
  const availBal = firstChild(node, "AVAILBAL");
  const ledgerAmount = ledgerBal ? parseMinorUnits(firstValue(ledgerBal, "BALAMT"), { exponent }) : { error: "absent" };
  const availAmount = availBal ? parseMinorUnits(firstValue(availBal, "BALAMT"), { exponent }) : { error: "absent" };
  const balanceAsOf = ledgerBal ? ofxDate(firstValue(ledgerBal, "DTASOF")) : null;
  const opening = openingBalanceFrom(node, exponent);

  const transactions = [];
  const rawTransactions = tranList ? findAll(tranList, "STMTTRN") : [];
  rawTransactions.forEach((txn, index) => {
    const postedOn = ofxDate(firstValue(txn, "DTPOSTED"));
    const externalId = (firstValue(txn, "FITID") || "").trim() || null;
    const name = (firstValue(txn, "NAME") || "").trim();
    const memo = (firstValue(txn, "MEMO") || "").trim();
    const description = [name, memo].filter(Boolean).join(" — ") || null;
    const amount = parseMinorUnits(firstValue(txn, "TRNAMT"), { exponent });
    const locator = `BANKTRANLIST/STMTTRN[${index}]`;

    if (amount.error || !postedOn) {
      transactions.push({
        locator,
        externalId,
        postedOn: postedOn || null,
        description,
        payee: name || null,
        rawAmountMinor: null,
        amountMinor: null,
        direction: null,
        // The one state that makes "I could not read this" real. The ledger
        // refuses by CHECK to store a figure alongside it.
        unparsedReason: amount.error
          ? `the amount could not be read: ${amount.error}`
          : "the posting date could not be read",
      });
      return;
    }
    transactions.push({
      locator,
      externalId,
      postedOn,
      description,
      payee: name || null,
      rawAmountMinor: amount.minor,
      amountMinor: Math.abs(amount.minor),
      // THE CONVENTION, APPLIED. See OFX_SIGN_CONVENTION above.
      direction: amount.minor < 0 ? "outflow" : "inflow",
      unparsedReason: null,
    });
  });

  return {
    accountKey: accountKeyFor(institutionId, accountNumber),
    institution: null,
    mask: maskOf(accountNumber),
    accountKind,
    balanceRole: balanceRoleFor(accountKind),
    currency,
    periodStart,
    periodEnd,
    ledgerBalanceMinor: ledgerAmount.error ? null : ledgerAmount.minor,
    availableBalanceMinor: availAmount.error ? null : availAmount.minor,
    openingBalanceMinor: opening.minor,
    openingBalanceLabel: opening.label,
    balanceAsOf,
    transactions,
  };
}

/**
 * Read an OFX or QFX export.
 *
 * Returns `{ ok: true, accounts }` or `{ ok: false, refusal }`. A file that is
 * not OFX at all is refused by name rather than parsed into an empty statement
 * that would report a successful import of nothing.
 */
export function parseOfx(text) {
  const body = String(text || "");
  if (!/<\s*OFX\s*>/i.test(body)) {
    return {
      ok: false,
      refusal: "this file has no <OFX> element, so it is not an OFX or QFX bank export",
    };
  }
  const tree = parseSgml(body);
  const statements = [
    ...findAll(tree, "STMTRS").map((node) => ({ node, isCard: false })),
    ...findAll(tree, "CCSTMTRS").map((node) => ({ node, isCard: true })),
  ];
  if (!statements.length) {
    return {
      ok: false,
      refusal: "this OFX file holds no bank or credit-card statement " +
        "(no <STMTRS> or <CCSTMTRS> element), so there is nothing in it to read",
    };
  }
  const accounts = statements.map(({ node, isCard }) => readOfxStatement(node, { isCard }));
  if (!accounts.some((account) => account.transactions.length)) {
    return {
      ok: false,
      refusal: `this OFX file describes ${accounts.length} account(s) and contains no transactions`,
    };
  }

  // The spec's convention, checked against the statement's own arithmetic
  // wherever the statement gives us something to check it with. One account
  // failing refuses the whole file: a file that is wrong about one account has
  // not earned the benefit of the doubt about the others.
  const refusals = [];
  for (const account of accounts) {
    const check = verifyOfxDirection(account);
    account.directionCheck = check;
    account.directionBasis = check.state === "verified" ? "verified" : "trusted";
    account.directionNote = check.reason || null;
    if (check.state === "inverted" || check.state === "unreconciled") refusals.push(directionRefusal(account, check));
  }
  if (refusals.length) return { ok: false, refusal: refusals.join(" Also: ") };

  return { ok: true, accounts, signConvention: OFX_SIGN_CONVENTION };
}

/* --------------------------------------------------------------- CSV */

/**
 * THE CSV PROBLEM, STATED PLAINLY.
 *
 * CSV has no standard shape. Two banks export the same month as two different
 * files, and neither declares what its columns mean. There are exactly three
 * ways a file can TELL us which way money moved, and this reader accepts only
 * those three:
 *
 *   A. A DEBIT column and a CREDIT column (or withdrawal/deposit, money out /
 *      money in, paid out / paid in). The column NAMES carry the direction.
 *   B. A single signed amount PLUS a type column whose values say debit or
 *      credit. The type carries the direction; the sign is cross-checked
 *      against it and a file that contradicts itself is refused.
 *   C. A single signed amount PLUS a running balance column. The direction is
 *      DERIVED and then VERIFIED: under the correct convention every balance
 *      delta equals its row's amount. One convention must fit every checkable
 *      row and the other must not.
 *
 * A single signed amount column with none of those is REFUSED. It is genuinely
 * unknowable from the file which sign means money leaving, roughly half of real
 * exports use each, and being wrong inverts every figure downstream.
 */
export const CSV_SIGN_CONVENTIONS = Object.freeze({
  pairedColumns: "csv_paired_debit_and_credit_columns",
  typeColumn: "csv_signed_amount_with_type_column",
  balanceVerified: "csv_signed_amount_verified_against_running_balance",
});

export function parseDelimitedRows(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(cell); cell = ""; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (c === "\r") continue;
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((value) => String(value).trim()));
}

const HEADER_PATTERNS = {
  date: /^(transaction\s*)?(posted?\s*|value\s*|effective\s*|booking\s*)?date$|^posted$|^date\s*posted$/i,
  description: /descri|memo|payee|narrative|particular|details?$|^name$|^reference$|^transaction$/i,
  balance: /balance/i,
  type: /^type$|transaction\s*type|^dr\/?cr$|debit\s*\/?\s*credit|^direction$/i,
  debit: /^debit$|^withdrawal[s]?$|^money\s*out$|^paid\s*out$|^amount\s*out$/i,
  credit: /^credit$|^deposit[s]?$|^money\s*in$|^paid\s*in$|^amount\s*in$/i,
  amount: /^amount$|^value$|^transaction\s*amount$|^amt$/i,
};

const DEBIT_WORDS = /^(d|dr|debit|debits|withdrawal|withdrawals|payment|purchase|out|outflow)$/i;
const CREDIT_WORDS = /^(c|cr|credit|credits|deposit|deposits|refund|in|inflow)$/i;

function classifyHeaders(header) {
  const found = { date: [], description: [], balance: [], type: [], debit: [], credit: [], amount: [] };
  header.forEach((raw, index) => {
    const name = String(raw || "").trim();
    if (!name) return;
    for (const [role, pattern] of Object.entries(HEADER_PATTERNS)) {
      if (pattern.test(name)) found[role].push(index);
    }
  });
  // "Date" also matches the loose description pattern in some files; a column
  // is only a description if it is not already a better-named thing.
  found.description = found.description.filter((i) =>
    !found.date.includes(i) && !found.balance.includes(i) &&
    !found.debit.includes(i) && !found.credit.includes(i) && !found.amount.includes(i));
  return found;
}

/**
 * Settle the date column's day/month order across the WHOLE column.
 * Returns `{ order }` or `{ error }`. Never resolved per row.
 */
function settleDateOrder(values) {
  let settled = null;
  let sawAmbiguous = false;
  let parseable = 0;
  for (const value of values) {
    const candidate = csvDateCandidates(value);
    if (!candidate) continue;
    parseable++;
    if (candidate.settles) {
      if (settled && settled !== candidate.settles) {
        return { error: "the date column contains both day-first and month-first values" };
      }
      settled = candidate.settles;
    } else if (!candidate.unambiguous) sawAmbiguous = true;
  }
  if (!parseable) return { error: "no value in the date column reads as a date" };
  if (sawAmbiguous && !settled) {
    return {
      error: "every date in this file could be read either day-first or month-first, " +
        "and nothing in the file settles which",
    };
  }
  return { order: settled || "iso" };
}

function resolveDate(value, order) {
  const candidate = csvDateCandidates(value);
  if (!candidate) return null;
  if (candidate.unambiguous) return candidate.unambiguous;
  return order === "day_first" ? candidate.dayFirst : candidate.monthFirst;
}

function refuse(reason, detail = {}) {
  return { ok: false, refusal: reason, ...detail };
}

/**
 * Work out what this CSV's columns mean, or decline.
 *
 * `rows[0]` must be a header row. Returns `{ ok: true, mapping }` where mapping
 * names the resolved columns and the sign convention that was ESTABLISHED, or
 * `{ ok: false, refusal }` naming what could not be read.
 */
export function detectCsvShape(rows, { currency = "USD" } = {}) {
  if (!rows.length) return refuse("this file is empty");
  const header = rows[0].map((value) => String(value ?? "").trim());
  const body = rows.slice(1);
  if (!body.length) return refuse("this file has a header row and no transactions under it");
  const numericHeaderCells = header.filter((cell) => cell && /^-?[\d.,$()%]+$/.test(cell)).length;
  if (numericHeaderCells > header.length / 2) {
    return refuse("this file's first row is data, not column names, so no column can be identified by name");
  }

  const found = classifyHeaders(header);
  const exponent = currencyExponent(currency);
  const column = (index) => body.map((row) => row[index]);

  /* ---- the date column ---- */
  if (!found.date.length) {
    return refuse(
      `no column is named as a date (columns present: ${header.filter(Boolean).map((h) => `"${h}"`).join(", ")})`,
    );
  }
  let dateIndex = found.date[0];
  if (found.date.length > 1) {
    const exact = found.date.filter((i) => /^(posted?\s*)?date$|^posted$/i.test(header[i]));
    if (exact.length !== 1) {
      return refuse(
        `${found.date.length} columns could be the transaction date ` +
        `(${found.date.map((i) => `"${header[i]}"`).join(", ")}) and nothing distinguishes them`,
      );
    }
    dateIndex = exact[0];
  }
  const order = settleDateOrder(column(dateIndex));
  if (order.error) return refuse(`the "${header[dateIndex]}" column could not be read: ${order.error}`);

  const descriptionIndex = found.description.length ? found.description[0] : null;
  const balanceIndex = found.balance.length === 1 ? found.balance[0] : null;

  /* ---- shape A: paired debit and credit columns ---- */
  if (found.debit.length === 1 && found.credit.length === 1) {
    return {
      ok: true,
      mapping: {
        shape: "paired",
        dateIndex,
        dateOrder: order.order,
        descriptionIndex,
        balanceIndex,
        debitIndex: found.debit[0],
        creditIndex: found.credit[0],
        signConvention: CSV_SIGN_CONVENTIONS.pairedColumns,
        establishedBy: `the columns "${header[found.debit[0]]}" and "${header[found.credit[0]]}" name the direction themselves`,
      },
    };
  }
  if (found.debit.length + found.credit.length === 1) {
    return refuse(
      `this file has a "${header[found.debit[0] ?? found.credit[0]]}" column with no matching opposite column, ` +
      "so a row in the missing direction cannot be told from a row with no amount",
    );
  }

  /* ---- a single amount column is required from here on ---- */
  const amountCandidates = found.amount.filter((i) => i !== balanceIndex);
  if (!amountCandidates.length) {
    return refuse(
      `no column is named as an amount (columns present: ${header.filter(Boolean).map((h) => `"${h}"`).join(", ")})`,
    );
  }
  if (amountCandidates.length > 1) {
    return refuse(
      `${amountCandidates.length} columns could be the amount ` +
      `(${amountCandidates.map((i) => `"${header[i]}"`).join(", ")}) and nothing distinguishes them`,
    );
  }
  const amountIndex = amountCandidates[0];

  /* ---- shape B: a type column carries the direction ---- */
  if (found.type.length === 1) {
    const typeIndex = found.type[0];
    const values = column(typeIndex).map((v) => String(v ?? "").trim());
    const recognised = values.filter((v) => DEBIT_WORDS.test(v) || CREDIT_WORDS.test(v)).length;
    if (recognised === values.filter(Boolean).length && recognised > 0) {
      // Cross-check, but only when the amount column is ACTUALLY SIGNED. A
      // column of unsigned magnitudes carries no direction to disagree with,
      // and treating that as a contradiction would refuse a perfectly readable
      // file — the most common shape a type column appears in.
      let agreeNegativeIsDebit = 0, agreePositiveIsDebit = 0, checked = 0, negatives = 0;
      body.forEach((row) => {
        const parsed = parseMinorUnits(row[amountIndex], { exponent });
        if (parsed.error || parsed.minor === 0) return;
        const type = String(row[typeIndex] ?? "").trim();
        if (!DEBIT_WORDS.test(type) && !CREDIT_WORDS.test(type)) return;
        checked++;
        if (parsed.minor < 0) negatives++;
        const isDebit = DEBIT_WORDS.test(type);
        if ((parsed.minor < 0) === isDebit) agreeNegativeIsDebit++;
        if ((parsed.minor > 0) === isDebit) agreePositiveIsDebit++;
      });
      if (negatives && agreeNegativeIsDebit !== checked && agreePositiveIsDebit !== checked) {
        return refuse(
          `the "${header[typeIndex]}" column and the sign of "${header[amountIndex]}" disagree with each other, ` +
          "so this file contradicts itself about which way money moved",
        );
      }
      return {
        ok: true,
        mapping: {
          shape: "typed",
          dateIndex,
          dateOrder: order.order,
          descriptionIndex,
          balanceIndex,
          amountIndex,
          typeIndex,
          signConvention: CSV_SIGN_CONVENTIONS.typeColumn,
          establishedBy: `the "${header[typeIndex]}" column states the direction of every row`,
        },
      };
    }
  }

  /* ---- shape C: derive the convention from the running balance, then verify ---- */
  if (balanceIndex !== null) {
    const verdict = verifyAgainstBalance(body, { amountIndex, balanceIndex, exponent });
    if (verdict.ok) {
      return {
        ok: true,
        mapping: {
          shape: "signed",
          dateIndex,
          dateOrder: order.order,
          descriptionIndex,
          balanceIndex,
          amountIndex,
          negativeIsOutflow: verdict.negativeIsOutflow,
          signConvention: CSV_SIGN_CONVENTIONS.balanceVerified,
          establishedBy:
            `${verdict.checked} consecutive rows of the "${header[balanceIndex]}" column move by exactly ` +
            `the "${header[amountIndex]}" figure when a ${verdict.negativeIsOutflow ? "negative" : "positive"} ` +
            "amount is read as money leaving, and never when it is read the other way",
        },
      };
    }
    return refuse(
      `the "${header[amountIndex]}" column is signed, and the "${header[balanceIndex]}" column ` +
      `does not settle which sign means money leaving (${verdict.reason})`,
    );
  }

  /* ---- nothing established the direction: decline ---- */
  return refuse(
    `the "${header[amountIndex]}" column is the only amount in this file and nothing in the file says ` +
    "which sign means money leaving the account. There is no debit/credit column pair, no transaction-type " +
    "column, and no running balance to check a reading against. Re-export including a running balance, " +
    "a transaction type, or separate debit and credit columns, or supply the file as OFX/QFX",
  );
}

/**
 * Does one reading of the sign fit the running balance, and the other not?
 *
 * Checks consecutive pairs: balance[n] - balance[n-1] must equal the signed
 * amount of row n. The file may be ordered oldest-first or newest-first, so
 * both directions are tried and the one that fits must fit EVERY checkable
 * pair. Ties, and files where both readings fit, are refused.
 */
function verifyAgainstBalance(body, { amountIndex, balanceIndex, exponent }) {
  const parsed = body.map((row) => ({
    amount: parseMinorUnits(row[amountIndex], { exponent }),
    balance: parseMinorUnits(row[balanceIndex], { exponent }),
  }));
  const usable = parsed.every((row) => !row.amount.error && !row.balance.error);
  if (!usable) return { ok: false, reason: "some rows have an unreadable amount or balance" };
  if (parsed.length < 3) return { ok: false, reason: "fewer than three rows to check" };

  const score = (ascending, flip) => {
    let hits = 0;
    for (let i = 1; i < parsed.length; i++) {
      const previous = parsed[i - 1], current = parsed[i];
      const delta = ascending
        ? current.balance.minor - previous.balance.minor
        : previous.balance.minor - current.balance.minor;
      const applied = flip ? -current.amount.minor : current.amount.minor;
      const moving = ascending ? applied : (flip ? -previous.amount.minor : previous.amount.minor);
      if (delta === moving) hits++;
    }
    return hits;
  };
  const pairs = parsed.length - 1;
  const asIs = Math.max(score(true, false), score(false, false));
  const flipped = Math.max(score(true, true), score(false, true));

  // "Negative is outflow" means the signed figure ADDS to the balance as-is.
  if (asIs === pairs && flipped !== pairs) return { ok: true, negativeIsOutflow: true, checked: pairs };
  if (flipped === pairs && asIs !== pairs) return { ok: true, negativeIsOutflow: false, checked: pairs };
  if (asIs === pairs && flipped === pairs) {
    return { ok: false, reason: "both readings fit the balance column equally, which happens when every amount is zero" };
  }
  return {
    ok: false,
    reason: `neither reading fits: ${asIs} of ${pairs} balance steps match one way and ${flipped} the other`,
  };
}

/**
 * Read a bank CSV once its shape is known.
 *
 * A row whose amount or date cannot be read is kept and marked unparsed rather
 * than dropped, so a partial file reports what it could not read instead of
 * quietly reporting a smaller month.
 */
export function parseBankCsv(text, { currency = "USD", accountHint = null } = {}) {
  const rows = parseDelimitedRows(String(text || ""));
  const shape = detectCsvShape(rows, { currency });
  if (!shape.ok) return shape;
  const { mapping } = shape;
  const exponent = currencyExponent(currency);
  const body = rows.slice(1);
  const transactions = [];

  body.forEach((row, index) => {
    const locator = `row ${index + 2}`;
    const postedOn = resolveDate(row[mapping.dateIndex], mapping.dateOrder);
    const description = mapping.descriptionIndex === null
      ? null
      : (String(row[mapping.descriptionIndex] ?? "").trim() || null);

    let rawAmountMinor = null;
    let direction = null;
    let unparsedReason = null;

    if (mapping.shape === "paired") {
      const debit = parseMinorUnits(row[mapping.debitIndex], { exponent });
      const credit = parseMinorUnits(row[mapping.creditIndex], { exponent });
      const hasDebit = !debit.error && debit.minor !== 0;
      const hasCredit = !credit.error && credit.minor !== 0;
      if (hasDebit && hasCredit) {
        unparsedReason = "this row carries a figure in both the debit and the credit column";
      } else if (hasDebit) {
        rawAmountMinor = -Math.abs(debit.minor);
        direction = "outflow";
      } else if (hasCredit) {
        rawAmountMinor = Math.abs(credit.minor);
        direction = "inflow";
      } else {
        unparsedReason = debit.error && credit.error
          ? `neither the debit nor the credit column could be read: ${debit.error}`
          : "this row has no amount in either the debit or the credit column";
      }
    } else {
      const amount = parseMinorUnits(row[mapping.amountIndex], { exponent });
      if (amount.error) {
        unparsedReason = `the amount could not be read: ${amount.error}`;
      } else if (mapping.shape === "typed") {
        const type = String(row[mapping.typeIndex] ?? "").trim();
        if (DEBIT_WORDS.test(type)) { rawAmountMinor = -Math.abs(amount.minor); direction = "outflow"; }
        else if (CREDIT_WORDS.test(type)) { rawAmountMinor = Math.abs(amount.minor); direction = "inflow"; }
        else unparsedReason = `the transaction type "${type.slice(0, 24)}" is not one this can read as debit or credit`;
      } else {
        // Shape C. `negativeIsOutflow` was VERIFIED against the balance column.
        rawAmountMinor = amount.minor;
        const leaving = mapping.negativeIsOutflow ? amount.minor < 0 : amount.minor > 0;
        direction = leaving ? "outflow" : "inflow";
      }
    }

    if (!postedOn && !unparsedReason) unparsedReason = "the posting date could not be read";

    transactions.push({
      locator,
      externalId: null,
      postedOn: postedOn || null,
      description,
      payee: null,
      rawAmountMinor: unparsedReason ? null : rawAmountMinor,
      amountMinor: unparsedReason ? null : Math.abs(rawAmountMinor),
      direction: unparsedReason ? null : direction,
      unparsedReason,
    });
  });

  const dated = transactions.map((t) => t.postedOn).filter(Boolean).sort();
  const closing = mapping.balanceIndex === null
    ? { error: "absent" }
    : parseMinorUnits(body[body.length - 1]?.[mapping.balanceIndex], { exponent });

  return {
    ok: true,
    signConvention: mapping.signConvention,
    establishedBy: mapping.establishedBy,
    accounts: [{
      accountKey: accountHint?.accountKey || null,
      institution: accountHint?.institution || null,
      mask: accountHint?.mask || null,
      accountKind: accountHint?.accountKind || "other",
      balanceRole: balanceRoleFor(accountHint?.accountKind || "other"),
      currency,
      // `verified` only for shape C, where every balance step was checked. The
      // other two shapes are `stated`: the file names the direction of each row
      // outright, which is a different and equally good thing, and calling both
      // "verified" would flatten a distinction the receipt has to be able to
      // draw. Neither is ever `trusted`, because no CSV shape is accepted on
      // the strength of a convention nobody checked.
      directionBasis: mapping.shape === "signed" ? "verified" : "stated",
      directionNote: mapping.establishedBy,
      periodStart: dated[0] || null,
      periodEnd: dated[dated.length - 1] || null,
      ledgerBalanceMinor: closing.error ? null : closing.minor,
      availableBalanceMinor: null,
      balanceAsOf: closing.error ? null : (dated[dated.length - 1] || null),
      transactions,
    }],
  };
}

/* ----------------------------------------------------------- one entry point */

export const BANK_EXPORT_EXTENSIONS = Object.freeze([".ofx", ".qfx"]);

function decode(bytes) {
  if (typeof bytes === "string") return bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read any supported bank export into ONE envelope shape.
 *
 * `sourceDocUid` is what makes a figure traceable. When the caller has the
 * corpus document id it should pass it; otherwise a content digest of the file
 * itself is used, which still points at a specific file rather than at a
 * mutable path.
 */
export function readBankExport(bytes, {
  name = "",
  format = null,
  currency = "USD",
  sourceDocUid = null,
  accountHint = null,
} = {}) {
  const text = decode(bytes);
  const extension = String(name).slice(String(name).lastIndexOf(".")).toLowerCase();
  const kind = format || (extension === ".csv" || extension === ".tsv" ? "csv" : extension.replace(".", ""));
  const uid = sourceDocUid || `bankexport:${digest(text)}`;

  const parsed = kind === "csv"
    ? parseBankCsv(text, { currency, accountHint })
    : parseOfx(text);

  if (!parsed.ok) {
    return {
      ok: false,
      format: kind,
      sourceDocUid: uid,
      sourceLabel: name || null,
      refusal: parsed.refusal,
    };
  }
  return {
    ok: true,
    format: kind === "qfx" ? "qfx" : kind === "ofx" ? "ofx" : "csv",
    signConvention: parsed.signConvention,
    establishedBy: parsed.establishedBy || "the OFX specification signs every amount against the account balance",
    sourceDocUid: uid,
    sourceLabel: name || null,
    accounts: parsed.accounts.map((account, index) => ({
      ...account,
      accountKey: account.accountKey || `bank-${digest(`${uid}|${index}`)}`,
    })),
  };
}

/**
 * The corpus rendering of a bank export.
 *
 * Deliberately coarse. The searchable text exists so a person asking "did I pay
 * the deposit in March" gets pointed at the right file; the FIGURES live in the
 * ledger, where they can be added up. Rendering every row as prose would
 * produce a wall of digits that embeds badly and answers nothing.
 */
export function renderBankExportText(envelope, { maxRows = 500 } = {}) {
  const lines = [];
  for (const account of envelope.accounts) {
    const label = account.mask ? `account ending ${account.mask}` : "account";
    lines.push(`Bank export: ${account.accountKind} ${label} (${account.currency})`);
    if (account.periodStart && account.periodEnd) lines.push(`Period: ${account.periodStart} to ${account.periodEnd}`);
    if (account.ledgerBalanceMinor !== null && account.balanceAsOf) {
      lines.push(`Statement balance as of ${account.balanceAsOf}: ${formatMinor(account.ledgerBalanceMinor, account.currency)}`);
    }
    // Said in the corpus too, not only in the import receipt. Somebody reading
    // this text months later is entitled to know whether "paid out" below was
    // checked against a balance or taken on trust from a format specification.
    if (account.directionBasis === "trusted") {
      lines.push("Direction of every amount below: taken on trust from the format's own specification, NOT verified against a balance.");
    } else if (account.directionBasis === "verified") {
      lines.push("Direction of every amount below: verified against this statement's own balances.");
    }
    const shown = account.transactions.slice(0, maxRows);
    for (const txn of shown) {
      if (txn.unparsedReason) {
        lines.push(`${txn.postedOn || "undated"} | ${txn.description || "(no description)"} | not read: ${txn.unparsedReason}`);
        continue;
      }
      lines.push(
        `${txn.postedOn} | ${txn.description || "(no description)"} | ` +
        `${txn.direction === "outflow" ? "paid out" : "received"} ${formatMinor(txn.amountMinor, account.currency)}`,
      );
    }
    if (account.transactions.length > shown.length) {
      lines.push(`[${account.transactions.length - shown.length} further rows are in the ledger and not repeated here]`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Minor units back to a readable figure, by string arithmetic only. */
export function formatMinor(minor, currency = "USD") {
  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = exponent ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction} ${currency}`;
}
