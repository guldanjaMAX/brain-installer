// test/bank-import-path.test.mjs
//
// THE PRODUCTION PATH FROM A DOWNLOADED BANK FILE TO A LEDGER ROW.
//
// The previous wave built a bank-export reader with 79 tests of its own and a
// ledger writer with 132, and shipped no way to get from one to the other. The
// parser tests all passed while `fin_transactions` stayed empty in every
// install, because nothing production ever called the parser for its FIGURES.
// That is the specific hole this file exists to make impossible to reopen, so
// almost nothing here is a unit test:
//
//   * a REAL fixture file on disk,
//   * through the REAL CLI command an operator types,
//   * over the REAL worker entry point, dispatched by the REAL router in
//     worker/src/index.js so a handler that exists but is not mounted fails,
//   * into a REAL SQLite database built from the REAL migration files,
//   * asserted by reading rows back out of it.
//
// The four properties underneath it, in the order they would cost money:
//
//   1. AN INVERTED OFX IS CAUGHT, NOT TRUSTED. The format's sign convention
//      used to be believed without ever being checked. A statement that states
//      its own opening balance now has to close, or nothing is imported.
//   2. A SECOND IMPORT OF THE SAME FILE DOES NOT DOUBLE THE LEDGER.
//   3. A FILE WHOSE DIRECTION CANNOT BE ESTABLISHED IS REFUSED BY NAME, and a
//      dry run sends nothing at all.
//   4. WHAT WAS NOT VERIFIED SAYS SO, in the ledger and not only on a terminal
//      that scrolled away.
//
// Every fixture, person and figure here is invented. No real person, client,
// institution or account number appears in this file or in anything it reads.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { splitStatements, cmdImportBank } from "../brain.mjs";
import { validateBankEnvelope, BANK_IMPORT_PATH } from "../worker/src/lib/fin-upload.js";
import { readBankExport } from "../ingest/bank-export.mjs";
import { extract } from "../ingest/extract.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations", "d1");
const FIXTURES = join(HERE, "fixtures", "bank");
const fixture = (name) => join(FIXTURES, name);

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

/** A real database, built from the real migration files, exactly as an install is. */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of migrationFiles) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) db.exec(statement);
  }
  return db;
}

/**
 * A D1-shaped binding over real SQLite, including `batch`, because the import
 * takes the batch path in production and a harness without one would prove the
 * path nobody runs.
 */
function d1(db) {
  return {
    prepare(sql) {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes || 0) } }),
      });
      return shape();
    },
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
}

const ADMIN_KEY = "fixture-admin-key";
const sandbox = mkdtempSync(join(tmpdir(), "brain-bank-import-"));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = { client: { slug: "fixture-client" }, brain: { domain: "fixture.invalid" } };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

/** One live brain: a real router over a real database, plus a call counter. */
function brain() {
  const db = freshDb();
  const env = { STORAGE: "d1", ADMIN_KEY, BRAIN_VERSION: "fixture-version", DB: d1(db) };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    return worker.fetch(new Request(url, init), env, { waitUntil() {}, passThroughOnException() {} });
  };
  const options = {
    fetchImpl,
    resolveAdminKey: () => ADMIN_KEY,
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAccount: async () => ({ id: "fixture-account" }),
  };
  const count = (table) => db.prepare(`SELECT count(*) c FROM ${table}`).get().c;
  return { db, env, calls, options, count };
}

/** Run a command with its console output captured, so the receipt can be asserted. */
async function captured(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const value = await run();
    return { value, out: lines.join("\n"), error: null };
  } catch (error) {
    return { value: null, out: lines.join("\n"), error };
  } finally {
    console.log = original;
  }
}

const runImport = (b, flags) => captured(() => cmdImportBank(manifest, manifestPath, flags, b.options));

/* ============ 1. END TO END: a real file becomes real ledger rows ============ */
{
  const b = brain();
  const { value: receipt, error } = await runImport(b, { file: fixture("checking-july.ofx") });

  check("THE ENTRY POINT EXISTS AND RUNS: a downloaded OFX file imports without error",
    error === null && receipt?.imported === true, error?.message || JSON.stringify(receipt));
  check("it went over the wire to the brain's own import route, not around it",
    b.calls.length === 1 && b.calls[0].method === "POST" && b.calls[0].url.endsWith(BANK_IMPORT_PATH),
    JSON.stringify(b.calls));

  const rows = b.db.prepare("SELECT * FROM fin_transactions ORDER BY posted_on").all();
  check("EVERY LINE IN THE FILE LANDED IN THE LEDGER, including the one that could not be read",
    rows.length === 5, `${rows.length} rows: ${JSON.stringify(rows.map((r) => r.txn_uid))}`);
  check("the four readable lines landed as confirmed figures",
    rows.filter((r) => r.basis_state === "confirmed").length === 4,
    JSON.stringify(rows.map((r) => [r.description, r.basis_state])));

  const supplier = rows.find((r) => (r.description || "").includes("SUPPLIER INVOICE"));
  check("A NEGATIVE OFX AMOUNT LANDED AS MONEY LEAVING, with the source figure and convention beside it",
    supplier?.direction === "outflow" && supplier?.amount_minor === 187540 &&
    supplier?.raw_amount_minor === -187540 &&
    supplier?.raw_sign_convention === "ofx_trnamt_negative_is_outflow", JSON.stringify(supplier));
  const retainer = rows.find((r) => (r.description || "").includes("CLIENT RETAINER"));
  check("a positive OFX amount landed as money arriving",
    retainer?.direction === "inflow" && retainer?.amount_minor === 425000, JSON.stringify(retainer));

  const unread = rows.find((r) => r.basis_state === "unparsed");
  check("the unreadable line landed as UNREAD carrying no figure and a stated reason",
    unread && unread.amount_minor === null && unread.direction === null &&
    /could not be read/.test(unread.unparsed_reason || ""), JSON.stringify(unread));
  check("every row names the document it was read from and where inside it",
    rows.every((r) => r.provenance === "extracted" && r.source_doc_uid && /checking-july\.ofx#/.test(r.source_locator || "")),
    JSON.stringify(rows.map((r) => r.source_locator)));

  const account = b.db.prepare("SELECT * FROM fin_accounts").get();
  check("the account landed as a checking account holding money, keyed without its full number",
    account?.account_kind === "checking" && account?.balance_role === "asset" && account?.mask === "4821",
    JSON.stringify(account));
  check("THE FULL ACCOUNT NUMBER IS NOWHERE IN THE DATABASE",
    !JSON.stringify(b.db.prepare("SELECT * FROM fin_accounts").all()).includes("000000004821") &&
    !JSON.stringify(rows).includes("000000004821"), "");

  const snapshot = b.db.prepare("SELECT * FROM fin_balance_snapshots").get();
  check("the statement balance landed as a dated balance snapshot",
    snapshot?.current_minor === 842110 && snapshot?.as_of_date === "2026-07-31", JSON.stringify(snapshot));
  const statement = b.db.prepare("SELECT * FROM fin_statements").get();
  check("the statement period landed as a statement, parsed rather than merely received",
    statement?.period_start === "2026-07-01" && statement?.period_end === "2026-07-31" &&
    statement?.parse_state === "parsed", JSON.stringify(statement));
  const coverage = b.db.prepare("SELECT * FROM fin_account_coverage").get();
  check("coverage claims only the days this one export proves",
    coverage?.coverage_status === "partial" && coverage?.covered_to === "2026-07-31", JSON.stringify(coverage));

  check("the receipt counts what actually landed",
    receipt.accounts === 1 && receipt.transactions === 4 && receipt.unread_lines === 1 &&
    receipt.statements === 1 && receipt.balance_snapshots === 1, JSON.stringify(receipt));

  /* ---- 2. the same file again ---- */
  const before = b.count("fin_transactions");
  const second = await runImport(b, { file: fixture("checking-july.ofx") });
  check("A SECOND IMPORT OF THE SAME FILE DOES NOT DOUBLE THE LEDGER",
    second.error === null && before === 5 && b.count("fin_transactions") === 5,
    `${before} then ${b.count("fin_transactions")}: ${second.error?.message || ""}`);
  check("nor does it double the account, statement, coverage or balance snapshot",
    b.count("fin_accounts") === 1 && b.count("fin_statements") === 1 &&
    b.count("fin_account_coverage") === 1 && b.count("fin_balance_snapshots") === 1,
    [b.count("fin_accounts"), b.count("fin_statements"), b.count("fin_account_coverage"), b.count("fin_balance_snapshots")].join(","));
  check("and the operator is TOLD that re-running is safe, rather than left to guess",
    /does not add a second copy/.test(second.out), second.out);
}

/* ============ 3. an inverted OFX is caught, not trusted ============ */
{
  const b = brain();
  const { error } = await runImport(b, { file: fixture("inverted-signs.ofx") });
  check("AN OFX WHOSE SIGNS ARE INVERTED RELATIVE TO ITS OWN BALANCE IS REFUSED, NOT BELIEVED",
    error !== null && /OPPOSITE way round/.test(error?.message || ""), error?.message);
  check("the refusal shows the arithmetic that did not close, in figures the owner can check",
    /4,889\.00 USD opening/.test(error?.message || "") && /closed at 8,421\.10 USD/.test(error?.message || ""),
    error?.message);
  check("it says what to do about it instead of stopping at a diagnosis",
    /Re-download this statement/.test(error?.message || "") && /running balance column/.test(error?.message || ""),
    error?.message);
  check("nothing was sent and the ledger is untouched",
    b.calls.length === 0 && b.count("fin_transactions") === 0, JSON.stringify(b.calls));

  // The same file with its signs the right way round is imported AND says so.
  const good = brain();
  const { value: receipt, out } = await runImport(good, { file: fixture("reconciled-july.ofx") });
  check("the honest twin of that file imports, and its direction is reported as VERIFIED",
    receipt?.imported === true && /direction: VERIFIED/.test(out), out.slice(0, 400));
  const coverage = good.db.prepare("SELECT * FROM fin_account_coverage").get();
  check("and the ledger itself records that the direction was verified, not just the terminal",
    /verified against the source's own balances/.test(coverage?.basis_note || ""), coverage?.basis_note);
  check("its four transactions land with the right total",
    good.db.prepare("SELECT sum(amount_minor) s FROM fin_transactions WHERE direction='inflow'").get().s === 545000 &&
    good.db.prepare("SELECT sum(amount_minor) s FROM fin_transactions WHERE direction='outflow'").get().s === 191790, "");
}

/* ============ 4. what was NOT verified says so ============ */
{
  const b = brain();
  const { out } = await runImport(b, { file: fixture("checking-july.ofx") });
  check("a statement with no balance to check against is reported as taken ON TRUST",
    /taken ON TRUST from the OFX specification, not verified/.test(out), out.slice(0, 600));
  const coverage = b.db.prepare("SELECT * FROM fin_account_coverage").get();
  check("AND THE LEDGER SAYS SO TOO, so the reader months later is not misled",
    /taken on trust from the format's own specification and was NOT verified/.test(coverage?.basis_note || ""),
    coverage?.basis_note);
  check("the unread line is still counted in the same note rather than replaced by it",
    /could not be read/.test(coverage?.basis_note || ""), coverage?.basis_note);
}

/* ============ 5. a file that cannot say which way money moved ============ */
{
  const b = brain();
  const { error } = await runImport(b, { file: fixture("ambiguous-amount.csv") });
  check("A CSV WITH ONE UNSIGNED AMOUNT COLUMN IS REFUSED BY NAME, not guessed",
    error !== null && /"Value" column/.test(error?.message || ""), error?.message);
  check("the refusal names the three things that would have settled it, and what to re-export",
    /running balance/.test(error?.message || "") && /transaction type/.test(error?.message || "") &&
    /debit\/credit column pair|debit and credit columns/.test(error?.message || ""), error?.message);
  check("nothing was sent and nothing landed",
    b.calls.length === 0 && b.count("fin_transactions") === 0, JSON.stringify(b.calls));
}

/* ============ 6. a dry run sends nothing ============ */
{
  const b = brain();
  const { value, out } = await runImport(b, { file: fixture("checking-july.ofx"), "dry-run": true });
  check("A DRY RUN SENDS NOTHING AT ALL",
    b.calls.length === 0 && b.count("fin_transactions") === 0, JSON.stringify(b.calls));
  check("it says what WOULD land, per account, with the money broken out by direction",
    /4 line\(s\) would land/.test(out) && /2 in 5,450\.00 USD/.test(out) && /2 out 1,917\.90 USD/.test(out),
    out.slice(0, 800));
  check("it says how many lines it could not read",
    /1 line\(s\) could not be read and would land as unread/.test(out), out.slice(0, 800));
  check("it returns a shape that states it was a preview rather than leaving a zero to be misread",
    value?.dry_run === true && value?.would_import === 4 && value?.unread_lines === 1, JSON.stringify(value));
  check("and it needs no admin key, because the safest command must not be the hardest to reach",
    (await captured(() => cmdImportBank(manifest, manifestPath, { file: fixture("checking-july.ofx"), "dry-run": true },
      { ...b.options, resolveAdminKey: () => null }))).error === null, "");
}

/* ============ 7. a CSV is a bank export only when the operator says so ============ */
{
  const b = brain();
  const { value: receipt } = await runImport(b, {
    file: fixture("paired-columns.csv"), account: "fixture-operating", "account-kind": "checking",
    institution: "Fixture Mutual",
  });
  check("a CSV named on the command line imports, under the account the operator named",
    receipt?.imported === true && b.db.prepare("SELECT * FROM fin_accounts").get()?.account_slug === "fixture-operating",
    JSON.stringify(b.db.prepare("SELECT * FROM fin_accounts").get()));
  const debit = b.db.prepare("SELECT * FROM fin_transactions WHERE description LIKE '%SUPPLIER%'").get();
  check("a figure in the debit column landed as money leaving",
    debit?.direction === "outflow" && debit?.amount_minor === 187540, JSON.stringify(debit));

  const table = await extract(readFileSync(fixture("paired-columns.csv")), "paired-columns.csv");
  check("THE ORDINARY .CSV DOCUMENT PATH IS UNTOUCHED: the same file still extracts as a table, not a bank export",
    table.how === "csv" && !/bank export/.test(String(table.how)), JSON.stringify(table.how));
}

/* ============ 8. the route is mounted, gated, and does not take an envelope on trust ============ */
{
  const b = brain();
  const post = (body, headers = {}) => worker.fetch(new Request(`https://fixture.invalid${BANK_IMPORT_PATH}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }), b.env, { waitUntil() {}, passThroughOnException() {} });

  const unauthorised = await post({ envelope: {} });
  check("THE IMPORT ROUTE IS BEHIND THE ADMIN KEY, like every other write",
    unauthorised.status === 401, String(unauthorised.status));

  const envelope = readBankExport(readFileSync(fixture("checking-july.ofx")), { name: "checking-july.ofx" });
  const tampered = structuredClone(envelope);
  tampered.accounts[0].transactions[1].direction = "inflow"; // the -1875.40 line
  const flipped = await post({ envelope: tampered }, { "X-Admin-Key": ADMIN_KEY });
  const flippedBody = await flipped.json();
  check("AN ENVELOPE WHOSE DIRECTION CONTRADICTS ITS OWN SOURCE FIGURE IS REFUSED BY THE BRAIN",
    flipped.status === 400 && /calls it an inflow/.test(flippedBody.reason || ""), JSON.stringify(flippedBody));
  check("and nothing from that envelope reached the ledger",
    b.count("fin_transactions") === 0, "");

  const invented = structuredClone(envelope);
  invented.signConvention = "whatever_the_client_says";
  const unknown = await post({ envelope: invented }, { "X-Admin-Key": ADMIN_KEY });
  check("a sign convention this brain does not define is refused rather than recorded as fact",
    unknown.status === 400 && /not a sign convention this brain defines/.test((await unknown.json()).reason || ""), "");

  const owed = structuredClone(envelope);
  owed.accounts[0].accountKind = "card";
  owed.accounts[0].balanceRole = "asset";
  const lie = await post({ envelope: owed }, { "X-Admin-Key": ADMIN_KEY });
  check("MONEY OWED CANNOT BE IMPORTED AS MONEY HELD, whatever the envelope claims",
    lie.status === 400 && /cannot be recorded as money held/.test((await lie.json()).reason || ""), "");

  const refused = await post({ envelope: { ok: false, refusal: "the reader declined this file" } }, { "X-Admin-Key": ADMIN_KEY });
  check("an envelope the reader already refused cannot be pushed through the back door",
    refused.status === 400 && /refused by the reader/.test((await refused.json()).reason || ""), "");
}

/* ============ 9. the validator's own edges ============ */
{
  const envelope = readBankExport(readFileSync(fixture("signed-with-balance.csv")), { name: "signed-with-balance.csv" });
  check("a balance-verified CSV passes validation with a POSITIVE outflow allowed, because its convention was established per file",
    validateBankEnvelope(envelope).ok === true, JSON.stringify(validateBankEnvelope(envelope).error));
  const empty = validateBankEnvelope({ ok: true, signConvention: "ofx_trnamt_negative_is_outflow", sourceDocUid: "x", accounts: [] });
  check("an envelope with no accounts is refused rather than reported as a successful import of nothing",
    empty.ok === false && /no accounts/.test(empty.error), JSON.stringify(empty));
  const figureOnUnread = structuredClone(envelope);
  figureOnUnread.accounts[0].transactions[0].unparsedReason = "invented";
  check("a line marked unread that still carries a figure is refused before the database has to refuse it",
    validateBankEnvelope(figureOnUnread).ok === false, JSON.stringify(validateBankEnvelope(figureOnUnread)));
}

/* ============ 10. the ledger has to exist first ============ */
{
  const db = new DatabaseSync(":memory:");
  // 0019 intentionally depends on the financial ledger introduced by 0015.
  // This fixture proves the pre-ledger refusal, so omit both migrations.
  for (const file of migrationFiles.filter((f) => !f.startsWith("0015") && !f.startsWith("0019"))) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) db.exec(statement);
  }
  const env = { STORAGE: "d1", ADMIN_KEY, DB: d1(db) };
  const envelope = readBankExport(readFileSync(fixture("checking-july.ofx")), { name: "checking-july.ofx" });
  const res = await worker.fetch(new Request(`https://fixture.invalid${BANK_IMPORT_PATH}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ envelope }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const body = await res.json();
  check("a brain with no financial ledger says which migration is missing and which command runs it",
    res.status === 409 && /brain migrate/.test(body.reason || "") && /fin_transactions/.test(body.reason || ""),
    JSON.stringify(body));
}

console.log(`\n${fail ? "FAILURES" : "bank-import-path"}: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
