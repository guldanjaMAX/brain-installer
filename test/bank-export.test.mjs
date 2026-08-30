// test/bank-export.test.mjs
//
// The bank-export reader: OFX, QFX and CSV.
//
// WHAT THIS FILE IS GUARDING, IN ORDER OF HOW EXPENSIVE IT WOULD BE TO GET WRONG
//
//   1. THE SIGN CONVENTION. A convention read backwards turns income into
//      spending and a profit into a loss, and every citation still resolves, so
//      nothing looks broken. Each format's convention is asserted here against a
//      real fixture, by direction and by amount, not by a comment.
//   2. THE REFUSALS. CSV has no standard shape. A file whose amount column
//      cannot be identified, or whose sign cannot be tied to a direction by
//      something IN THE FILE, must be DECLINED BY NAME. A test that only proved
//      the happy path would let a guess ship.
//   3. NO FLOAT TOUCHES MONEY, and no full account number is ever carried.
//   4. THE REGISTRY. A format that parses beautifully and is not registered is
//      a file silently skipped, which is the failure the whole registry exists
//      to end.
//
// Every fixture is invented. No real person, client, bank, institution or
// account number appears in this file or in anything it reads.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract, canExtract, supported } from "../ingest/extract.mjs";
import {
  parseMinorUnits, formatMinor, currencyExponent, parseOfx, parseSgml, ofxDate,
  detectCsvShape, parseDelimitedRows, parseBankCsv, readBankExport,
  renderBankExportText, accountKeyFor, balanceRoleFor, digest,
  OFX_SIGN_CONVENTION, CSV_SIGN_CONVENTIONS,
} from "../ingest/bank-export.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bank");
const bytes = (name) => readFileSync(join(FIXTURES, name));
const read = (name, options = {}) => readBankExport(bytes(name), { name, ...options });

/* ===================== the registry ===================== */
{
  for (const ext of [".ofx", ".qfx"]) {
    check(`${ext} is registered, so the folder walk and Drive triage stop skipping it`,
      canExtract(`statement${ext}`), supported().join(" "));
  }
  const got = await extract(bytes("checking-july.ofx"), "checking-july.ofx");
  check("an OFX file extracts as a bank export, not as unknown binary",
    got.how === "bank export" && typeof got.text === "string", JSON.stringify(got).slice(0, 200));
  check("the corpus text names the period and the closing balance",
    /Period: 2026-07-01 to 2026-07-31/.test(got.text) && /8,421\.10 USD/.test(got.text), got.text);
  check("a line the reader could not read is reported, not dropped from the text",
    /not read:/.test(got.text) && /could not be read/.test(got.note || ""), `${got.note} :: ${got.text}`);
  check("an unread bank line carries a machine-visible incomplete signal",
    got.incomplete === true, JSON.stringify(got));
  const fullyParsedQfx = await extract(bytes("card-july.qfx"), "card-july.qfx");
  check("folder-ingested bank figures remain partial until the structured ledger import runs",
    fullyParsedQfx.incomplete === true && /not in the ledger/.test(fullyParsedQfx.note || ""),
    JSON.stringify(fullyParsedQfx));
  check("the corpus text never carries a full account number",
    !/000000004821/.test(got.text) && /ending 4821/.test(got.text), got.text);

  const notOfx = await extract(Buffer.from("Dear customer, your statement is attached."), "statement.qfx");
  check("a .qfx that is not OFX at all is REFUSED by name, not indexed as prose",
    notOfx.text === null && /no <OFX> element/.test(notOfx.error || ""), JSON.stringify(notOfx));
  check("and the refusal does not echo the file's contents",
    !/Dear customer/.test(notOfx.error || ""), notOfx.error);
}

/* ===================== money, without float ===================== */
{
  const cases = [
    ["1234.56", 123456], ["1,234.56", 123456], ["$1,234.56", 123456],
    ["-42.50", -4250], ["(42.50)", -4250], ["42.50-", -4250], ["+7.00", 700],
    ["1.234,56", 123456], ["0.01", 1], ["8421.10", 842110], ["1234", 123400],
  ];
  for (const [text, expected] of cases) {
    const got = parseMinorUnits(text);
    check(`"${text}" reads as exactly ${expected} minor units`, got.minor === expected, JSON.stringify(got));
  }
  check("0.1 + 0.2 in minor units is exactly 0.3, which float arithmetic is not",
    parseMinorUnits("0.10").minor + parseMinorUnits("0.20").minor === parseMinorUnits("0.30").minor,
    String(0.1 + 0.2));
  check("a third decimal place is REFUSED rather than rounded into a figure nobody wrote",
    /decimal places/.test(parseMinorUnits("10.005").error || ""), JSON.stringify(parseMinorUnits("10.005")));
  check("trailing zeros beyond the currency's places are accepted, because they change nothing",
    parseMinorUnits("10.5000").minor === 1050, JSON.stringify(parseMinorUnits("10.5000")));
  check("a bare comma that could be either separator is REFUSED, not resolved by coin flip",
    /decimal separator cannot be established/.test(parseMinorUnits("1,23").error || ""),
    JSON.stringify(parseMinorUnits("1,23")));
  check("a currency with no minor unit is not given two of them",
    currencyExponent("JPY") === 0 && parseMinorUnits("1200", { exponent: 0 }).minor === 1200, "");
  check("nonsense is an error and never a zero", parseMinorUnits("NOT-A-NUMBER").error !== undefined,
    JSON.stringify(parseMinorUnits("NOT-A-NUMBER")));
  check("an empty cell is an error and never a zero", parseMinorUnits("").error !== undefined, "");
  check("minor units render back to the same figure", formatMinor(842110) === "8,421.10 USD", formatMinor(842110));
}

/* ===================== OFX: the sign convention ===================== */
{
  const envelope = read("checking-july.ofx");
  check("the OFX export reads", envelope.ok, envelope.refusal);
  const account = envelope.accounts[0];
  const byId = Object.fromEntries(account.transactions.map((t) => [t.externalId, t]));

  // THE PINNED CONVENTION. OFX signs TRNAMT against the account's own balance:
  // negative means the balance goes down, which is money leaving.
  check("OFX: the convention is named on the envelope",
    envelope.signConvention === OFX_SIGN_CONVENTION &&
    OFX_SIGN_CONVENTION === "ofx_trnamt_negative_is_outflow", envelope.signConvention);
  check("OFX SIGN: a NEGATIVE TRNAMT is money LEAVING the account",
    byId.TESTFIT0002.direction === "outflow" &&
    byId.TESTFIT0002.rawAmountMinor === -187540 &&
    byId.TESTFIT0002.amountMinor === 187540,
    JSON.stringify(byId.TESTFIT0002));
  check("OFX SIGN: a POSITIVE TRNAMT is money ARRIVING",
    byId.TESTFIT0001.direction === "inflow" &&
    byId.TESTFIT0001.rawAmountMinor === 425000 &&
    byId.TESTFIT0001.amountMinor === 425000,
    JSON.stringify(byId.TESTFIT0001));
  check("OFX SIGN: the month's arithmetic comes out the right way round",
    account.transactions.filter((t) => t.direction === "inflow").reduce((n, t) => n + t.amountMinor, 0) === 545000 &&
    account.transactions.filter((t) => t.direction === "outflow").reduce((n, t) => n + t.amountMinor, 0) === 191790,
    JSON.stringify(account.transactions));
  check("the stored amount is always unsigned; the sign lives in the direction",
    account.transactions.every((t) => t.amountMinor === null || t.amountMinor >= 0), "");
  check("every amount is an integer, so no float ever reaches the ledger",
    account.transactions.every((t) => t.amountMinor === null || Number.isInteger(t.amountMinor)), "");

  check("the period and the closing balance are read from the file",
    account.periodStart === "2026-07-01" && account.periodEnd === "2026-07-31" &&
    account.ledgerBalanceMinor === 842110 && account.availableBalanceMinor === 822110 &&
    account.balanceAsOf === "2026-07-31", JSON.stringify(account).slice(0, 300));
  check("a checking account is recorded as money HELD",
    account.accountKind === "checking" && account.balanceRole === "asset", account.accountKind);
  check("the full account number never leaves the file: only the last four survive",
    account.mask === "4821" && !JSON.stringify(envelope).includes("000000004821"), account.mask);
  check("the account key is a stable digest, not the account number",
    account.accountKey === accountKeyFor("000000000", "000000004821") &&
    !account.accountKey.includes("4821"), account.accountKey);

  const unread = account.transactions.find((t) => t.unparsedReason);
  check("a line whose amount cannot be read is KEPT and marked unread, never dropped",
    Boolean(unread) && unread.amountMinor === null && unread.direction === null &&
    /could not be read/.test(unread.unparsedReason), JSON.stringify(unread));
  check("an unread line still names where in the file it was",
    unread.locator === "BANKTRANLIST/STMTTRN[4]", unread.locator);
}

/* ===================== QFX and the liability rule ===================== */
{
  const envelope = read("card-july.qfx");
  check("a QFX credit-card export reads through the same parser", envelope.ok && envelope.format === "qfx",
    envelope.refusal);
  const card = envelope.accounts[0];
  check("QFX SIGN: a purchase on a card is a negative TRNAMT and reads as money leaving",
    card.transactions[0].direction === "outflow" && card.transactions[0].rawAmountMinor === -9635,
    JSON.stringify(card.transactions[0]));
  check("QFX SIGN: a payment to the card is positive and reads as money arriving",
    card.transactions[1].direction === "inflow" && card.transactions[1].rawAmountMinor === 50000,
    JSON.stringify(card.transactions[1]));
  check("a credit card is money OWED and can never be recorded as an asset",
    card.accountKind === "card" && card.balanceRole === "liability" && balanceRoleFor("card") === "liability",
    card.balanceRole);
  check("an account kind nobody stated is `neither`, so it is never counted as cash by default",
    balanceRoleFor("other") === "neither", balanceRoleFor("other"));
}

/* ===================== OFX parsing mechanics ===================== */
{
  const tree = parseSgml("<A><B>one<C>two</A>");
  check("an unclosed SGML leaf is closed implicitly, the way the format means",
    tree.children[0].children.map((n) => `${n.tag}=${n.value}`).join(",") === "B=one,C=two",
    JSON.stringify(tree));
  check("an OFX timestamp keeps only the day, never an implied time",
    ofxDate("20260703120000[-7:MST]") === "2026-07-03" && ofxDate("20260703") === "2026-07-03",
    ofxDate("20260703120000[-7:MST]"));
  check("a nonsense date is null rather than a plausible wrong day", ofxDate("99999999") === null, "");
  const empty = parseOfx("<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>");
  check("an OFX file with no statement in it is REFUSED, not reported as a successful import of nothing",
    !empty.ok && /no bank or credit-card statement/.test(empty.refusal), JSON.stringify(empty));
}

/* ===================== CSV: shape A, paired columns ===================== */
{
  const envelope = read("paired-columns.csv");
  check("a debit/credit CSV reads, and says what established its convention",
    envelope.ok && envelope.signConvention === CSV_SIGN_CONVENTIONS.pairedColumns &&
    /name the direction themselves/.test(envelope.establishedBy || ""), JSON.stringify(envelope).slice(0, 200));
  const rows = envelope.accounts[0].transactions;
  check("CSV SIGN (paired): a figure in the DEBIT column is money leaving",
    rows[1].direction === "outflow" && rows[1].amountMinor === 187540 && rows[1].rawAmountMinor === -187540,
    JSON.stringify(rows[1]));
  check("CSV SIGN (paired): a figure in the CREDIT column is money arriving",
    rows[0].direction === "inflow" && rows[0].amountMinor === 425000 && rows[0].rawAmountMinor === 425000,
    JSON.stringify(rows[0]));
  check("CSV SIGN (paired): the month's arithmetic comes out the right way round",
    rows.filter((t) => t.direction === "inflow").reduce((n, t) => n + t.amountMinor, 0) === 545000 &&
    rows.filter((t) => t.direction === "outflow").reduce((n, t) => n + t.amountMinor, 0) === 201425,
    JSON.stringify(rows));
}

/* ===================== CSV: shape C, verified against the balance ===================== */
{
  const envelope = read("signed-with-balance.csv");
  check("a signed-amount CSV reads ONLY because the balance column verified the reading",
    envelope.ok && envelope.signConvention === CSV_SIGN_CONVENTIONS.balanceVerified,
    JSON.stringify(envelope).slice(0, 200));
  check("and it says which reading fitted, and over how many rows",
    /4 consecutive rows/.test(envelope.establishedBy || "") &&
    /negative amount is read as money leaving/.test(envelope.establishedBy || ""), envelope.establishedBy);
  const rows = envelope.accounts[0].transactions;
  check("CSV SIGN (verified): a negative amount is money leaving, because the balance fell by it",
    rows[1].direction === "outflow" && rows[1].rawAmountMinor === -187540, JSON.stringify(rows[1]));
  check("CSV SIGN (verified): a positive amount is money arriving, because the balance rose by it",
    rows[0].direction === "inflow" && rows[0].rawAmountMinor === 425000, JSON.stringify(rows[0]));
  check("the two CSV shapes describing the same month agree, line for line",
    JSON.stringify(read("paired-columns.csv").accounts[0].transactions.map((t) => [t.postedOn, t.direction, t.amountMinor])) ===
    JSON.stringify(rows.map((t) => [t.postedOn, t.direction, t.amountMinor])),
    JSON.stringify(rows.map((t) => [t.postedOn, t.direction, t.amountMinor])));
  check("a US-ordered date column is settled across the whole column, not guessed per row",
    rows[2].postedOn === "2026-07-15", rows[2].postedOn);

  // The reading is only accepted because the OTHER reading fails. Flip the
  // balance column so neither reading fits and the file must be declined.
  const broken = "Posted Date,Details,Amount,Running Balance\n" +
    "07/02/2026,A,4250.00,12671.10\n07/03/2026,B,-1875.40,99999.99\n" +
    "07/15/2026,C,-42.50,12345.67\n07/28/2026,D,1200.00,11111.11\n";
  const verdict = parseBankCsv(broken);
  check("when the balance column agrees with NEITHER reading, the file is declined",
    !verdict.ok && /does not settle which sign means money leaving/.test(verdict.refusal), JSON.stringify(verdict));
}

/* ===================== CSV: shape B, a type column ===================== */
{
  const envelope = read("typed-column.csv");
  check("a CSV whose type column states the direction reads",
    envelope.ok && envelope.signConvention === CSV_SIGN_CONVENTIONS.typeColumn, JSON.stringify(envelope).slice(0, 200));
  const rows = envelope.accounts[0].transactions;
  check("CSV SIGN (typed): DEBIT is money leaving and CREDIT is money arriving, whatever the sign says",
    rows[0].direction === "inflow" && rows[1].direction === "outflow" && rows[2].direction === "outflow",
    JSON.stringify(rows.map((r) => r.direction)));

  const contradictory = read("contradictory-type.csv");
  check("a file whose type column and amount signs CONTRADICT each other is REFUSED",
    !contradictory.ok && /contradicts itself/.test(contradictory.refusal), JSON.stringify(contradictory));
}

/* ===================== CSV: the refusals ===================== */
{
  const ambiguous = read("ambiguous-amount.csv");
  check("THE CENTRAL REFUSAL: one signed amount column and nothing to establish its direction is DECLINED",
    !ambiguous.ok, JSON.stringify(ambiguous).slice(0, 200));
  check("and the refusal names the column it could not read",
    /"Value" column/.test(ambiguous.refusal), ambiguous.refusal);
  check("and it says exactly which three things would have settled it",
    /debit\/credit column pair/.test(ambiguous.refusal) &&
    /transaction-type/.test(ambiguous.refusal) &&
    /running balance/.test(ambiguous.refusal), ambiguous.refusal);
  check("and it tells the owner what to do instead",
    /Re-export/.test(ambiguous.refusal) && /OFX\/QFX/.test(ambiguous.refusal), ambiguous.refusal);
  check("a refused file produces NO transactions at all, not a half-read month",
    ambiguous.accounts === undefined, JSON.stringify(ambiguous));

  const undated = read("no-date-column.csv");
  check("a CSV with no date column is refused, naming the columns it did find",
    !undated.ok && /no column is named as a date/.test(undated.refusal) && /"Debit"/.test(undated.refusal),
    undated.refusal);

  const twoAmounts = detectCsvShape(parseDelimitedRows(
    "Date,Details,Amount,Transaction Amount,Balance\n2026-07-02,A,10.00,10.00,100.00\n2026-07-03,B,20.00,20.00,120.00\n"));
  check("two columns that could both be the amount is a refusal, not a preference",
    !twoAmounts.ok && /2 columns could be the amount/.test(twoAmounts.refusal), JSON.stringify(twoAmounts));

  const halfPair = detectCsvShape(parseDelimitedRows(
    "Date,Details,Debit\n2026-07-02,A,10.00\n2026-07-03,B,20.00\n"));
  check("a debit column with no matching credit column is refused, because a missing row is unreadable",
    !halfPair.ok && /no matching opposite column/.test(halfPair.refusal), JSON.stringify(halfPair));

  const headerless = detectCsvShape(parseDelimitedRows("2026-07-02,10.00,100.00\n2026-07-03,20.00,120.00\n"));
  check("a file whose first row is data is refused rather than treated as column names",
    !headerless.ok, JSON.stringify(headerless));

  const bothOrders = detectCsvShape(parseDelimitedRows(
    "Date,Details,Debit,Credit\n01/02/2026,A,10.00,\n03/04/2026,B,,20.00\n05/06/2026,C,30.00,\n"));
  check("a date column readable either day-first or month-first is refused, not settled by locale",
    !bothOrders.ok && /day-first or month-first/.test(bothOrders.refusal), JSON.stringify(bothOrders));

  const empty = detectCsvShape(parseDelimitedRows("Date,Details,Debit,Credit\n"));
  check("a header row with no transactions under it is refused",
    !empty.ok && /no transactions under it/.test(empty.refusal), JSON.stringify(empty));
}

/* ===================== identity and rendering ===================== */
{
  check("the same account in two files gets the same key, so a second import does not double it",
    accountKeyFor("000000000", "000000004821") === accountKeyFor("000000000", "000000004821"), "");
  check("two different accounts get different keys",
    accountKeyFor("000000000", "000000004821") !== accountKeyFor("000000000", "000000009317"), "");
  check("the digest is stable across calls", digest("abc") === digest("abc") && digest("abc") !== digest("abd"), "");
  check("an account key is a legal ledger slug",
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountKeyFor("x", "y")), accountKeyFor("x", "y"));
  const rendered = renderBankExportText(read("card-july.qfx"));
  check("the rendered text says which way money moved in words, not by sign",
    /paid out 96\.35 USD/.test(rendered) && /received 500\.00 USD/.test(rendered), rendered);
}

console.log(`\n${fail ? "FAILURES" : "bank-export"}: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
