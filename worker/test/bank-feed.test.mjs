// worker/test/bank-feed.test.mjs
//
// The ledger write boundary, and the hosted bank feed that shares it.
//
// EVERYTHING HERE DRIVES A REAL SQLITE DATABASE with the real migrations
// applied, because every safety property being claimed is a CHECK constraint or
// a partial unique index, and a test against a hand-built mock proves the mock.
// The provider itself is the only thing scripted, because the point of these
// cases is what this code does around a response, not what the provider does.
//
// THE TWO THINGS MOST WORTH BREAKING, AND THEREFORE MOST WORTH PINNING:
//
//   1. THE SIGN CONVENTIONS. A downloaded file writes a NEGATIVE number when
//      money leaves. This feed writes a POSITIVE one. Both are asserted here
//      against the direction that actually lands in the ledger, so inverting
//      either fails a test by name instead of quietly inverting a P&L.
//   2. THE ACCESS REFERENCE. It is encrypted before storage and redacted out of
//      every message. The database itself refuses a plaintext one.
//
// Every persona, institution and figure here is invented.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../../brain.mjs";
import { readBankExport } from "../../ingest/bank-export.mjs";
import { importBankExport, transactionUid, balanceRoleFor } from "../src/lib/fin-import.js";
import {
  BANK_FEED_SIGN_CONVENTION, REQUESTED_PRODUCTS, FORBIDDEN_PRODUCTS, BACKFILL_DAYS,
  LEGACY_BANK_ACCESS_KEY_VERSION, BANK_ACCESS_WRAPPING_KEY_VERSION,
  BANK_ACCESS_WRAPPING_KEY_SECRET, bankAccessWrappingKeyConfigured,
  directionFor, accountKindFor, tenantReference, redirectUriFor, feedScopeKey,
  bankFeedConfig, bankFeedEnabled, normaliseFeedPage, redactFeedText, safeFeedError,
  classifyItemError, encryptAccessReference, decryptAccessReference,
  rewrapBankAccessReferences,
  createLinkToken, exchangePublicToken, runFeedSlice, syncItemSlice, feedStatus,
  disconnectItem, connectPageHtml, handleBankFeed,
} from "../src/lib/bank-feed.js";
import { ledgerCashPosition, ledgerAccounts } from "../src/lib/fin-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const FIXTURES = join(HERE, "..", "..", "test", "fixtures", "bank");
const NOW = "2026-08-28T00:00:00Z";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) db.exec(statement);
  }
  return db;
}

/** A D1-shaped adapter over real SQLite, the same shape fin-d1.test.mjs uses. */
function d1(db, extra = {}) {
  return {
    DB: {
      prepare(sql) {
        const shape = (params = []) => ({
          bind: (...next) => shape(next),
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          first: async () => db.prepare(sql).get(...params) ?? null,
          run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes || 0) } }),
        });
        return shape();
      },
    },
    SESSION_SIGNING_KEY: "fixture-session-signing-key-0000000000",
    ADMIN_KEY: "fixture-admin-key",
    [BANK_ACCESS_WRAPPING_KEY_SECRET]: `v2.${Buffer.alloc(32, 7).toString("base64url")}`,
    BRAIN_NAME: "fixture-example-brain",
    BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-service-secret",
    BANK_FEED_API_BASE: "https://sandbox.provider.invalid",
    BANK_FEED_LINK_SDK_URL: "https://cdn.provider.invalid/link/v2/link.js",
    BANK_FEED_LINK_GLOBAL: "ProviderLink",
    ...extra,
  };
}

const refuses = (db, sql, params = []) => {
  try { db.prepare(sql).run(...params); return false; } catch { return true; }
};

/* ============ migration 0018: the connector's own schema ============ */
{
  const db = freshDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bank_feed%'")
    .all().map((r) => r.name).sort();
  check("0018 creates the three connector tables and nothing else",
    JSON.stringify(tables) === JSON.stringify(["bank_feed_backfill", "bank_feed_items", "bank_feed_link_sessions"]),
    JSON.stringify(tables));

  const insert = `INSERT INTO bank_feed_items
    (tenant_id, item_ref, access_ciphertext, access_iv, environment, connected_at)
    VALUES ('primary', ?, ?, 'AAAAAAAAAAAAAAAA', 'sandbox', '2026-08-28')`;
  check("THE PLAINTEXT GUARD: a raw access reference is refused by the database itself",
    refuses(db, insert, ["item-a", (["access-p","roductio","n-111111","11-2222-","3333-444","4-555555","555555"].join(""))]),
    "a hyphenated value is not base64 and must not be storable");
  check("a base64 ciphertext is accepted",
    !refuses(db, insert, ["item-b", "c2VhbGVkY2lwaGVydGV4dHZhbHVl"]), "");
  check("an environment the code does not know is refused",
    refuses(db, `INSERT INTO bank_feed_items
      (tenant_id, item_ref, access_ciphertext, access_iv, environment, connected_at)
      VALUES ('primary','item-c','c2VhbGVkY2lwaGVydGV4dA==','AAAAAAAAAAAAAAAA','staging','2026-08-28')`), "");
  check("a status that is not plainly good must say what is wrong",
    refuses(db, `INSERT INTO bank_feed_items
      (tenant_id, item_ref, access_ciphertext, access_iv, environment, status, connected_at)
      VALUES ('primary','item-d','c2VhbGVkY2lwaGVydGV4dA==','AAAAAAAAAAAAAAAA','sandbox','error','2026-08-28')`), "");
  check("a failed history load must record why",
    refuses(db, `INSERT INTO bank_feed_backfill (tenant_id, item_ref, requested_days, state, queued_at)
      VALUES ('primary','item-e',730,'failed','2026-08-28')`), "");
  check("re-authorisation state must name the connection it repairs",
    refuses(db, `INSERT INTO bank_feed_link_sessions
      (tenant_id, session_ref, mode, redirect_uri, created_at, expires_at)
      VALUES ('primary','s1','reauthorise','https://x.invalid/app/connect/bank','a','b')`), "");
}

/* ============ a downloaded file, into the ledger ============ */
{
  const db = freshDb();
  const env = d1(db);
  const envelope = readBankExport(readFileSync(join(FIXTURES, "checking-july.ofx")), { name: "checking-july.ofx" });
  const receipt = await importBankExport(env, envelope, { now: NOW, entitySlug: "primary" });

  check("the receipt counts what landed and what could not be read, separately",
    receipt.transactions === 4 && receipt.unread_lines === 1 && receipt.accounts === 1 && receipt.statements === 1,
    JSON.stringify(receipt));

  const rows = db.prepare("SELECT * FROM fin_transactions ORDER BY posted_on").all();
  check("every row names the document it was read from and where inside it",
    rows.every((r) => r.provenance === "extracted" && r.source_doc_uid?.startsWith("bankexport:") &&
      r.source_locator?.startsWith("checking-july.ofx#")), JSON.stringify(rows[0]));
  check("a figure with no traceable source is not storable: provenance and the document are both required",
    refuses(db, `INSERT INTO fin_transactions
      (tenant_id, txn_uid, account_slug, posted_on, amount_minor, direction, provenance, basis_state, recorded_at)
      VALUES ('primary','orphan','a','2026-07-01',100,'inflow','extracted','confirmed','${NOW}')`),
    "an extracted row with no source document must be refused");

  check("FILE SIGN CONVENTION lands in the ledger: a negative source figure is an outflow",
    rows.find((r) => r.txn_uid.endsWith("TESTFIT0002")).direction === "outflow" &&
    rows.find((r) => r.txn_uid.endsWith("TESTFIT0002")).raw_amount_minor === -187540 &&
    rows.find((r) => r.txn_uid.endsWith("TESTFIT0002")).amount_minor === 187540, "");
  check("and the convention that produced it is stored on the row, so a disagreement is diagnosable",
    rows.every((r) => r.basis_state === "unparsed" || r.raw_sign_convention === "ofx_trnamt_negative_is_outflow"),
    JSON.stringify(rows.map((r) => r.raw_sign_convention)));
  check("the line that could not be read landed as UNREAD, carrying no figure",
    rows.some((r) => r.basis_state === "unparsed" && r.amount_minor === null && r.direction === null &&
      r.unparsed_reason?.length > 0), JSON.stringify(rows.filter((r) => r.basis_state === "unparsed")));
  check("every amount on the wire is an integer in minor units",
    rows.every((r) => r.amount_minor === null || Number.isInteger(r.amount_minor)), "");

  const before = db.prepare("SELECT count(*) c FROM fin_transactions").get().c;
  await importBankExport(env, envelope, { now: "2026-08-29T00:00:00Z", entitySlug: "primary" });
  const after = db.prepare("SELECT count(*) c FROM fin_transactions").get().c;
  check("IMPORTING THE SAME FILE TWICE DOES NOT DOUBLE THE LEDGER",
    before === 5 && after === 5, `${before} then ${after}`);
  check("nor does it double the accounts, statements, coverage or balance snapshots",
    db.prepare("SELECT count(*) c FROM fin_accounts").get().c === 1 &&
    db.prepare("SELECT count(*) c FROM fin_statements").get().c === 1 &&
    db.prepare("SELECT count(*) c FROM fin_account_coverage").get().c === 1 &&
    db.prepare("SELECT count(*) c FROM fin_balance_snapshots").get().c === 1, "");

  const coverage = db.prepare("SELECT * FROM fin_account_coverage").get();
  check("coverage claims only the days the export actually proves",
    coverage.coverage_status === "partial" && coverage.covered_to === "2026-07-31" &&
    /could not be read/.test(coverage.basis_note), JSON.stringify(coverage));

  const cash = await ledgerCashPosition(env, { asOf: "2026-07-31" });
  check("the read path answers arithmetically from what was imported",
    cash.total_minor === 842110 && cash.as_of === "2026-07-31", JSON.stringify(cash).slice(0, 300));
}

/* ============ a CSV with no ids, imported twice ============ */
{
  const db = freshDb();
  const env = d1(db);
  const envelope = readBankExport(readFileSync(join(FIXTURES, "paired-columns.csv")), { name: "paired-columns.csv" });
  await importBankExport(env, envelope, { now: NOW });
  const first = db.prepare("SELECT count(*) c FROM fin_transactions").get().c;
  await importBankExport(env, envelope, { now: NOW });
  check("a CSV with no transaction ids still does not duplicate on re-import",
    first === 5 && db.prepare("SELECT count(*) c FROM fin_transactions").get().c === 5, String(first));

  const twins = readBankExport(
    "Date,Description,Debit,Credit\n2026-07-02,COFFEE,4.50,\n2026-07-02,COFFEE,4.50,\n2026-07-03,RENT,900.00,\n",
    { name: "twins.csv" });
  const receipt = await importBankExport(env, twins, { now: NOW });
  check("two genuinely identical transactions on the same day BOTH survive",
    receipt.transactions === 3, JSON.stringify(receipt));
  check("ordinals make that work: the same shape gets a different uid per occurrence",
    transactionUid("acct", { postedOn: "2026-07-02", rawAmountMinor: -450, description: "COFFEE" }, 0) !==
    transactionUid("acct", { postedOn: "2026-07-02", rawAmountMinor: -450, description: "COFFEE" }, 1), "");
}

/* ============ the feed's sign convention ============ */
{
  check("the feed's convention is named, and it is the OPPOSITE of a downloaded file",
    BANK_FEED_SIGN_CONVENTION === "feed_positive_amount_is_outflow", BANK_FEED_SIGN_CONVENTION);
  check("FEED SIGN: a POSITIVE amount is money LEAVING the account",
    directionFor(42.5) === "outflow" && directionFor(1) === "outflow", directionFor(42.5));
  check("FEED SIGN: a NEGATIVE amount is money ARRIVING",
    directionFor(-42.5) === "inflow" && directionFor(-1) === "inflow", directionFor(-42.5));

  const envelope = normaliseFeedPage({
    itemRef: "item-fixture",
    accounts: [{ account_id: "acct-1", name: "Operating", mask: "0000", type: "depository", subtype: "checking",
      balances: { current: 8421.1, available: 8221.1, iso_currency_code: "USD" } }],
    added: [
      { transaction_id: "t1", account_id: "acct-1", date: "2026-07-03", amount: 1875.4, name: "SUPPLIER INVOICE" },
      { transaction_id: "t2", account_id: "acct-1", date: "2026-07-02", amount: -4250, name: "CLIENT RETAINER" },
      { transaction_id: "t3", account_id: "acct-1", date: "2026-07-04", amount: 12.34, name: "PENDING CARD", pending: true },
      { transaction_id: "t4", account_id: "acct-1", date: "not-a-date", amount: 9.99, name: "UNDATED" },
    ],
    now: NOW,
  });
  const byId = Object.fromEntries(envelope.accounts[0].transactions.map((t) => [t.externalId, t]));
  check("FEED SIGN in the envelope: a positive figure becomes an outflow of the same magnitude",
    byId.t1.direction === "outflow" && byId.t1.amountMinor === 187540 && byId.t1.rawAmountMinor === 187540,
    JSON.stringify(byId.t1));
  check("FEED SIGN in the envelope: a negative figure becomes an inflow",
    byId.t2.direction === "inflow" && byId.t2.amountMinor === 425000 && byId.t2.rawAmountMinor === -425000,
    JSON.stringify(byId.t2));
  check("THE TWO SOURCES AGREE ABOUT THE SAME MONTH despite opposite conventions",
    byId.t1.direction === readBankExport(readFileSync(join(FIXTURES, "checking-july.ofx")), { name: "o.ofx" })
      .accounts[0].transactions[1].direction &&
    byId.t1.amountMinor === 187540, "one file says -1875.40 and one feed says +1875.40; both are an outflow");
  check("a provider figure is converted through its decimal string, never by multiplying a float",
    byId.t3.amountMinor === 1234, JSON.stringify(byId.t3));
  check("a pending line is flagged rather than counted as settled activity",
    byId.t3.pending === true && byId.t1.pending === false, JSON.stringify(byId.t3));
  check("a line with no usable date lands UNREAD rather than being dropped or dated today",
    byId.t4.unparsedReason?.includes("posting date") && byId.t4.amountMinor === null, JSON.stringify(byId.t4));
  check("a checking account from the feed is money held; a card is money owed",
    accountKindFor("depository", "checking") === "checking" &&
    balanceRoleFor(accountKindFor("credit", "credit card")) === "liability" &&
    balanceRoleFor(accountKindFor("loan", "auto")) === "liability", "");
  check("an account type nobody recognises is never counted as cash by default",
    balanceRoleFor(accountKindFor("unheard-of", "thing")) === "neither", "");
}

/* ============ read-only, by what is requested ============ */
{
  check("the ONLY product this brain ever requests is the read-only transactions one",
    JSON.stringify(REQUESTED_PRODUCTS) === JSON.stringify(["transactions"]), JSON.stringify(REQUESTED_PRODUCTS));
  check("nothing that can move money is requestable, and neither is the one that returns routing numbers",
    FORBIDDEN_PRODUCTS.every((p) => !REQUESTED_PRODUCTS.includes(p)) &&
    FORBIDDEN_PRODUCTS.includes("transfer") && FORBIDDEN_PRODUCTS.includes("payment_initiation") &&
    FORBIDDEN_PRODUCTS.includes("auth"), JSON.stringify(FORBIDDEN_PRODUCTS));
}

/* ============ configuration comes from the environment ============ */
{
  const source = readFileSync(join(HERE, "..", "src", "lib", "bank-feed.js"), "utf-8");
  check("the two service identifiers are read from env and exist nowhere as a constant",
    source.includes("env.BANK_FEED_CLIENT_ID") && source.includes("env.BANK_FEED_SECRET") &&
    !/BANK_FEED_CLIENT_ID\s*=\s*["'`]/.test(source), "");
  check("the feed core carries no provider host and delegates named profiles explicitly",
    !source.includes("https://") && source.includes("bankFeedProfile(env, environment)"), "");
  check("the tenant reference is confined to one function, so the deployment model stays reversible",
    (source.match(/function tenantReference/g) || []).length === 1 &&
    (source.match(/client_user_id/g) || []).length === 1, "");
  check("the tenant reference is derived from the install, never from a person's name",
    tenantReference({ BRAIN_NAME: "Fixture Example Brain" }).endUserRef === "install:fixture-example-brain",
    JSON.stringify(tenantReference({ BRAIN_NAME: "Fixture Example Brain" })));
  check("an unconfigured brain refuses loudly instead of reaching somebody else's endpoint",
    (() => { try { bankFeedConfig({}); return false; } catch (e) { return /not configured/.test(e.message); } })(), "");
  check("a non-https provider host is refused",
    (() => {
      try { bankFeedConfig(d1(freshDb(), { BANK_FEED_API_BASE: "http://x.invalid" })); return false; }
      catch (e) { return /must be https/.test(e.message); }
    })(), "");
  check("SANDBOX IS THE DEFAULT, so an install can be rehearsed the same day",
    bankFeedConfig(d1(freshDb())).environment === "sandbox" &&
    bankFeedConfig(d1(freshDb(), { BANK_FEED_ENV: "production" })).environment === "production", "");
  check("bankFeedEnabled is false on a brain that never turned the feed on", !bankFeedEnabled({}), "");
  check("the current feed contract requires its dedicated versioned wrapping key",
    bankAccessWrappingKeyConfigured(d1(freshDb())) &&
    !bankFeedEnabled({
      BANK_FEED_CLIENT_ID: "a", BANK_FEED_SECRET: "b", BANK_FEED_API_BASE: "https://x.invalid",
    }), "");
  check("the return address is derived from the brain's own hostname",
    redirectUriFor("https://demo.example.workers.dev/anything?x=1") === "https://demo.example.workers.dev/app/connect/bank",
    redirectUriFor("https://demo.example.workers.dev/anything?x=1"));
  check("the feed's scope key is one equality match, so a disconnect can remove exactly its rows",
    feedScopeKey("item-fixture") === "bank-feed:item-fixture", feedScopeKey("item-fixture"));
}

/* ============ custody of the access reference ============ */
{
  const env = d1(freshDb());
  const reference = (["access-s","andbox-1","1111111-","2222-333","3-4444-5","55555555","555"].join(""));
  const sealed = await encryptAccessReference(env, reference);
  check("the stored form is not the reference",
    !sealed.ciphertext.includes(reference) && !sealed.ciphertext.includes("11111111"), sealed.ciphertext);
  check("the stored form is base64, which is what the database's plaintext guard relies on",
    /^[A-Za-z0-9+/=]+$/.test(sealed.ciphertext) && /^[A-Za-z0-9+/=]+$/.test(sealed.iv), sealed.ciphertext);
  check("it round-trips exactly", await decryptAccessReference(env, sealed) === reference, "");
  check("two encryptions of the same value differ, so the ciphertext leaks nothing by comparison",
    (await encryptAccessReference(env, reference)).ciphertext !== sealed.ciphertext, "");
  check("new rows use the dedicated versioned contract",
    sealed.keyVersion === BANK_ACCESS_WRAPPING_KEY_VERSION && sealed.keyVersion === 2,
    String(sealed.keyVersion));
  const rotatedSigning = {
    ...env,
    SESSION_SIGNING_KEY: "a-completely-different-session-signing-key",
    ADMIN_KEY: "a-completely-different-admin-key",
  };
  check("session and admin rotations cannot change the dedicated bank wrapping key",
    await decryptAccessReference(rotatedSigning, sealed) === reference, "");
  let refused = false;
  try {
    await encryptAccessReference({
      DB: env.DB,
      SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY,
      ADMIN_KEY: env.ADMIN_KEY,
    }, reference);
  } catch (e) {
    refused = e?.code === "BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE";
  }
  check("session/admin material is never a fallback for new bank references", refused, "");
}

/* ============ legacy rows: resumable rewrap or explicit reauthorisation ============ */
{
  const db = freshDb();
  const env = d1(db);
  const references = [
    (["access-s","andbox-1","1111111-","1111-111","1-1111-1","11111111","111"].join("")),
    (["access-s","andbox-2","2222222-","2222-222","2-2222-2","22222222","222"].join("")),
  ];
  for (let index = 0; index < references.length; index++) {
    const sealed = await encryptAccessReference(env, references[index], {
      keyVersion: LEGACY_BANK_ACCESS_KEY_VERSION,
    });
    db.prepare(`INSERT INTO bank_feed_items
      (tenant_id, item_ref, access_ciphertext, access_iv, key_version, environment, connected_at)
      VALUES ('primary',?,?,?,?, 'sandbox',?)`)
      .run(`legacy-${index + 1}`, sealed.ciphertext, sealed.iv, sealed.keyVersion, NOW);
  }

  let interrupted = false;
  try {
    await rewrapBankAccessReferences(env, {
      mutationBoundary: ({ stage, ordinal }) => {
        if (stage === "after_rewrap_write" && ordinal === 1) throw new Error("fixture interruption");
      },
    });
  } catch (error) {
    interrupted = /fixture interruption/.test(error.message);
  }
  check("an interruption after the first rewrap leaves one exact committed row",
    interrupted && db.prepare("SELECT count(*) c FROM bank_feed_items WHERE key_version = 2").get().c === 1,
    JSON.stringify(db.prepare("SELECT key_version FROM bank_feed_items ORDER BY id").all()));

  const resumed = await rewrapBankAccessReferences(env);
  const rows = db.prepare(
    "SELECT item_ref, access_ciphertext, access_iv, key_version FROM bank_feed_items ORDER BY id",
  ).all();
  check("rerunning resumes from row state and rewraps only the unfinished row",
    resumed.rewrapped === 1 && rows.every((row) => row.key_version === 2), JSON.stringify(resumed));
  check("every rewrapped row still opens to its exact original reference",
    (await Promise.all(rows.map((row) => decryptAccessReference(env, {
      ciphertext: row.access_ciphertext,
      iv: row.access_iv,
      keyVersion: row.key_version,
    })))).every((value, index) => value === references[index]), "");

  const strandedDb = freshDb();
  const oldEnv = d1(strandedDb);
  const legacy = await encryptAccessReference(oldEnv, references[0], {
    keyVersion: LEGACY_BANK_ACCESS_KEY_VERSION,
  });
  strandedDb.prepare(`INSERT INTO bank_feed_items
    (tenant_id, item_ref, access_ciphertext, access_iv, key_version, environment, connected_at)
    VALUES ('primary','legacy-stranded',?,?,?,'sandbox',?)`)
    .run(legacy.ciphertext, legacy.iv, legacy.keyVersion, NOW);
  const withoutLegacyKey = { ...oldEnv, SESSION_SIGNING_KEY: undefined, ADMIN_KEY: undefined };
  const marked = await rewrapBankAccessReferences(withoutLegacyKey, { now: NOW });
  const stranded = strandedDb.prepare(
    "SELECT status, status_detail, key_version FROM bank_feed_items WHERE item_ref = 'legacy-stranded'",
  ).get();
  check("an unavailable released key becomes explicit reauthorization-required state",
    marked.reauthorization_required === 1 && stranded.status === "reauth_required" &&
    /account holder must connect it again/i.test(stranded.status_detail) && stranded.key_version === 1,
    JSON.stringify({ marked, stranded }));
}

/* ============ nothing leaks into a message ============ */
{
  const reference = (["access-p","roductio","n-999999","99-8888-","7777-666","6-555555","555555"].join(""));
  check("an access reference is redacted out of any text this module emits",
    !redactFeedText(`failed with ${reference}`).includes(reference) &&
    redactFeedText(`failed with ${reference}`).includes("[redacted access reference]"),
    redactFeedText(`failed with ${reference}`));
  check("so is a bare identifier and a long opaque token",
    !redactFeedText("id 11111111-2222-3333-4444-555555555555").includes("2222") &&
    !redactFeedText(`token ${"z".repeat(60)}`).includes("z".repeat(60)), "");
  const error = Object.assign(new Error(`boom ${reference}`), { code: "ITEM_ERROR" });
  check("and the one message a person is ever shown is built from the redacted text",
    !safeFeedError(error).includes(reference) && safeFeedError(error).includes("ITEM_ERROR"), safeFeedError(error));
  check("a connection that needs the owner to sign in again is its own state, not a generic failure",
    classifyItemError("ITEM_LOGIN_REQUIRED").state === "reauth_required" &&
    classifyItemError("USER_PERMISSION_REVOKED").state === "permission_revoked" &&
    classifyItemError("SOMETHING_ELSE").state === "error", "");
}

/* ============ the connect page ============ */
{
  const { html, csp } = connectPageHtml(bankFeedConfig(d1(freshDb())));
  check("the page never asks for, stores, or carries the admin key",
    !html.includes("X-Admin-Key") && !html.includes("admin") && !html.includes("localStorage"), "");
  check("the CSP is widened to exactly the configured SDK and API origins and nothing else",
    csp.includes("script-src 'unsafe-inline' https://cdn.provider.invalid") &&
    csp.includes("connect-src 'self' https://sandbox.provider.invalid https://cdn.provider.invalid") &&
    csp.includes("default-src 'none'") && csp.includes("form-action 'none'") &&
    !csp.includes("*"), csp);
  check("it tells the owner plainly what it cannot see and what the connection cannot do",
    /never sees your bank\s*\npassword/.test(html) && /cannot move money/.test(html), "");
  check("it keeps the redirect return leg, without which every bank with its own login page fails silently",
    html.includes("oauth_state_id") && html.includes("receivedRedirectUri"), "");
  check("it persists a client retry identity before requesting a Link token",
    html.includes("bank_link_request_id") && html.includes("request_id: linkRequestId()"), "");
}

/* ============ authorising, and NOT loading two years inline ============ */
{
  const db = freshDb();
  const env = d1(db);
  const calls = [];
  const provider = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    if (path === "/link/token/create") return json({ link_token: "link-fixture-token", expiration: "2026-08-28T00:30:00Z" });
    if (path === "/item/public_token/exchange") {
      return json({ item_id: "item-fixture", access_token: (["access-s","andbox-1","1111111-","2222-333","3-4444-5","55555555","555"].join("")) });
    }
    throw new Error(`no fixture for ${path}`);
  };
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

  const token = await createLinkToken(env, { url: "https://demo.example.workers.dev/app/connect/bank", fetchImpl: provider });
  const request = calls[0].body;
  check("the authorisation request asks only for the read-only product",
    JSON.stringify(request.products) === JSON.stringify(["transactions"]), JSON.stringify(request.products));
  check("it names the install, never a person",
    request.user.client_user_id === "install:fixture-example-brain", request.user.client_user_id);
  check("it carries the brain's own return address, which is what must be pre-registered",
    request.redirect_uri === "https://demo.example.workers.dev/app/connect/bank", request.redirect_uri);
  check("it asks for two years of history at authorisation time",
    request.transactions.days_requested === BACKFILL_DAYS && BACKFILL_DAYS === 730, JSON.stringify(request.transactions));
  check("the response to the browser carries the short-lived handoff value and no credential",
    token.link_token === "link-fixture-token" && !JSON.stringify(token).includes("fixture-service-secret"),
    JSON.stringify(token));
  check("the authorisation attempt is recorded, and it holds no token",
    db.prepare("SELECT count(*) c FROM bank_feed_link_sessions").get().c === 1 &&
    !JSON.stringify(db.prepare("SELECT * FROM bank_feed_link_sessions").get()).includes("link-fixture-token"), "");

  const exchanged = await exchangePublicToken(env, {
    publicToken: "public-fixture-token", institutionRef: "ins-fixture", institutionLabel: "Fixture Mutual Bank",
    fetchImpl: provider,
  });
  check("the two-year history load is QUEUED, not run inline",
    exchanged.history.state === "queued" && exchanged.history.requested_days === 730 &&
    db.prepare("SELECT state FROM bank_feed_backfill").get().state === "queued", JSON.stringify(exchanged));
  check("no transaction has been fetched yet, so the owner's request returned immediately",
    !calls.some((c) => c.path === "/transactions/sync"), JSON.stringify(calls.map((c) => c.path)));
  const stored = db.prepare("SELECT * FROM bank_feed_items").get();
  check("the stored connection holds an encrypted reference and never a plaintext one",
    !JSON.stringify(stored).includes("access-sandbox") && stored.access_ciphertext.length > 16 &&
    stored.environment === "sandbox", JSON.stringify(stored).slice(0, 200));
  check("nothing the owner is shown contains the reference either",
    !JSON.stringify(exchanged).includes("access-sandbox"), JSON.stringify(exchanged));
}

/* ============ the history load: bounded, resumable, and reported ============ */
{
  const db = freshDb();
  const env = d1(db);
  const sealed = await encryptAccessReference(env, (["access-s","andbox-a","aaaaaaa-","bbbb-ccc","c-dddd-e","eeeeeeee","eee"].join("")));
  db.prepare(`INSERT INTO bank_feed_items
    (tenant_id, item_ref, institution_label, access_ciphertext, access_iv, key_version, environment, connected_at)
    VALUES ('primary','item-fixture','Fixture Mutual Bank',?,?,?,'sandbox',?)`)
    .run(sealed.ciphertext, sealed.iv, sealed.keyVersion, NOW);
  db.prepare(`INSERT INTO bank_feed_backfill (tenant_id, item_ref, requested_days, state, queued_at)
    VALUES ('primary','item-fixture',730,'queued',?)`).run(NOW);

  let page = 0;
  const pages = [
    { added: [{ transaction_id: "p1", account_id: "acct-1", date: "2026-07-02", amount: -4250, name: "CLIENT RETAINER" }],
      modified: [], removed: [], next_cursor: "cursor-1", has_more: true },
    { added: [{ transaction_id: "p2", account_id: "acct-1", date: "2026-07-03", amount: 1875.4, name: "SUPPLIER INVOICE" }],
      modified: [], removed: [], next_cursor: "cursor-2", has_more: true },
    { added: [{ transaction_id: "p3", account_id: "acct-1", date: "2026-07-15", amount: 42.5, name: "UTILITY" }],
      modified: [], removed: [], next_cursor: "cursor-3", has_more: true },
    { added: [], modified: [], removed: [], next_cursor: "cursor-4", has_more: true },
    { added: [], modified: [], removed: [{ transaction_id: "p3" }], next_cursor: "cursor-5", has_more: false },
  ];
  const provider = async (url) => {
    const path = new URL(url).pathname;
    const body = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/accounts/get") {
      return body({ accounts: [{ account_id: "acct-1", name: "Operating", mask: "0000", type: "depository",
        subtype: "checking", balances: { current: 8421.1, available: 8221.1, iso_currency_code: "USD" } }] });
    }
    if (path === "/transactions/sync") return body(pages[page++] || pages[pages.length - 1]);
    if (path === "/accounts/balance/get") throw new Error("the routine sync must not call the live balance endpoint");
    throw new Error(`no fixture for ${path}`);
  };

  const first = await runFeedSlice(env, { fetchImpl: provider, now: NOW });
  check("a slice stops after its page budget instead of running until the clock kills it",
    first.items[0].pages === 4 && first.items[0].has_more === true, JSON.stringify(first.items[0]));
  check("THE CURSOR IS COMMITTED PER PAGE, so an interrupted first load resumes rather than restarting",
    db.prepare("SELECT cursor FROM bank_feed_items").get().cursor === "cursor-4",
    JSON.stringify(db.prepare("SELECT cursor FROM bank_feed_items").get()));
  check("progress is reported while the load is still running, not only at the end",
    db.prepare("SELECT * FROM bank_feed_backfill").get().state === "running" &&
    db.prepare("SELECT * FROM bank_feed_backfill").get().pages_done === 4, "");
  // The fixture THROWS if the live-balance endpoint is called, so a slice that
  // completed is the proof that it was not.
  check("the routine sync never touches the live-balance endpoint, which is the rate-limited one",
    first.items[0].ok === true, JSON.stringify(first.items[0]));

  const second = await runFeedSlice(env, { fetchImpl: provider, now: NOW });
  check("the next slice finishes the load and says so",
    second.items[0].has_more === false &&
    db.prepare("SELECT state FROM bank_feed_backfill").get().state === "complete", JSON.stringify(second.items[0]));

  const rows = db.prepare("SELECT * FROM fin_transactions ORDER BY posted_on").all();
  check("feed rows land in the SAME ledger, named by the feed rather than by a document",
    rows.length === 3 && rows.every((r) => r.provenance === "feed" && r.source_feed === "bank-feed:item-fixture" &&
      r.source_doc_uid === null), JSON.stringify(rows[0]).slice(0, 250));
  check("a feed row must name its feed: the database refuses one that does not",
    refuses(db, `INSERT INTO fin_transactions
      (tenant_id, txn_uid, account_slug, posted_on, amount_minor, direction, provenance, basis_state, recorded_at)
      VALUES ('primary','nofeed','a','2026-07-01',100,'inflow','feed','confirmed','${NOW}')`), "");
  check("FEED SIGN CONVENTION lands in the ledger the right way round",
    rows.find((r) => r.external_id === "p1").direction === "inflow" &&
    rows.find((r) => r.external_id === "p2").direction === "outflow" &&
    rows.find((r) => r.external_id === "p2").amount_minor === 187540, JSON.stringify(rows.map((r) => [r.external_id, r.direction])));
  check("and the row records that it came from the feed's convention, not a file's",
    rows.every((r) => r.raw_sign_convention === "feed_positive_amount_is_outflow"), "");
  const withdrawn = rows.find((r) => r.external_id === "p3");
  check("A WITHDRAWN LINE IS TOMBSTONED, NEVER DELETED, so last month's total stays explainable",
    withdrawn && withdrawn.removed_at === NOW && /withdrew/.test(withdrawn.removal_reason), JSON.stringify(withdrawn));
  check("a feed writes no statement rows: it reports activity and issues no statement",
    db.prepare("SELECT count(*) c FROM fin_statements").get().c === 0, "");

  const accounts = await ledgerAccounts(env);
  check("the account arrived with its coverage, so a screen can say how far the records reach",
    accounts.accounts.length === 1 && accounts.accounts[0].coverage_status === "partial", JSON.stringify(accounts).slice(0, 250));
}

/* ============ a broken connection says so ============ */
{
  const db = freshDb();
  const env = d1(db);
  const sealed = await encryptAccessReference(env, (["access-s","andbox-a","aaaaaaa-","bbbb-ccc","c-dddd-e","eeeeeeee","eee"].join("")));
  db.prepare(`INSERT INTO bank_feed_items
    (tenant_id, item_ref, institution_label, access_ciphertext, access_iv, key_version, environment, connected_at)
    VALUES ('primary','item-broken','Fixture Mutual Bank',?,?,?,'sandbox',?)`)
    .run(sealed.ciphertext, sealed.iv, sealed.keyVersion, NOW);
  const provider = async (url) => new Response(JSON.stringify({
    error_code: "ITEM_LOGIN_REQUIRED",
    error_message: (["the item"," access-","sandbox-","aaaaaaaa","-bbbb-cc","cc-dddd-","eeeeeeee","eeee nee","ds re-au","thorisat","ion"].join("")),
  }), { status: 400, headers: { "content-type": "application/json" } });

  const result = await syncItemSlice(env, "item-broken", { fetchImpl: provider, now: NOW });
  check("a failed read moves the connection into a state of its own, not a silent retry loop",
    result.ok === false && result.status === "reauth_required" &&
    db.prepare("SELECT status FROM bank_feed_items").get().status === "reauth_required", JSON.stringify(result));
  check("and the stored reason carries no access reference",
    !db.prepare("SELECT status_detail FROM bank_feed_items").get().status_detail.includes("access-sandbox") &&
    !result.reason.includes("access-sandbox"), result.reason);

  const status = await feedStatus(env);
  check("the status surfaces it as needing attention, because every money answer is now stale",
    status.needs_attention.length === 1 && status.needs_attention[0].status === "reauth_required",
    JSON.stringify(status));
  check("and the status never carries a ciphertext or a reference",
    !JSON.stringify(status).includes(sealed.ciphertext), "");

  const removeProvider = async () => new Response(JSON.stringify({ removed: true }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const gone = await disconnectItem(env, "item-broken", { fetchImpl: removeProvider, now: NOW });
  check("disconnecting revokes the connection and destroys the stored reference",
    gone.ok && gone.revoked_at_provider &&
    db.prepare("SELECT access_ciphertext FROM bank_feed_items").get().access_ciphertext !== sealed.ciphertext, JSON.stringify(gone));
  check("but the financial history STAYS: nobody asked to delete their own records",
    gone.history_kept === true, JSON.stringify(gone));
}

/* ============ the routes' authorisation ============ */
{
  const db = freshDb();
  const env = d1(db);
  const url = new URL("https://demo.example.workers.dev/api/bank-feed/link-token");
  const anonymous = new Request(url, { method: "POST", body: "{}" });
  const response = await handleBankFeed(env, anonymous, url, "/api/bank-feed/link-token");
  check("an owner route with no passkey session is refused", response.status === 401, String(response.status));

  const pageUrl = new URL("https://demo.example.workers.dev/app/connect/bank");
  const pageResponse = await handleBankFeed(env, new Request(pageUrl), pageUrl, "/app/connect/bank");
  check("the connect page itself is behind the owner session, not an admin key",
    pageResponse.status === 401 && /Sign in first at \/app/.test(await pageResponse.text()), String(pageResponse.status));

  const syncUrl = new URL("https://demo.example.workers.dev/api/bank-feed/sync");
  const syncResponse = await handleBankFeed(env, new Request(syncUrl, { method: "POST", body: "{}" }), syncUrl, "/api/bank-feed/sync");
  check("an operator route with no admin key is refused", syncResponse.status === 401, String(syncResponse.status));

  const proofUrl = new URL("https://demo.example.workers.dev/api/bank-feed/recovery-key-proof");
  const proofRequest = new Request(proofUrl, {
    method: "POST",
    headers: { "X-Admin-Key": "fixture-admin-key" },
  });
  const proofResponse = await handleBankFeed(
    env, proofRequest, proofUrl, "/api/bank-feed/recovery-key-proof",
  );
  const proof = await proofResponse.json();
  check("the authenticated recovery proof exposes only a version and high-entropy fingerprint",
    proofResponse.status === 200 && proof.configured === true && proof.key_version === 2 &&
    /^[0-9a-f]{64}$/.test(proof.key_fingerprint) &&
    !JSON.stringify(proof).includes(env[BANK_ACCESS_WRAPPING_KEY_SECRET]), JSON.stringify(proof));

  const reconcileUrl = new URL("https://demo.example.workers.dev/api/bank-feed/reconcile-recovery");
  const reconcileRequest = new Request(reconcileUrl, {
    method: "POST",
    headers: { "X-Admin-Key": "fixture-admin-key" },
  });
  const reconcileResponse = await handleBankFeed(
    env, reconcileRequest, reconcileUrl, "/api/bank-feed/reconcile-recovery",
  );
  const reconciliation = await reconcileResponse.json();
  check("the authenticated recovery reconciliation returns aggregate custody counts only",
    reconcileResponse.status === 200 && reconciliation.legacy_rewrap_required === 0 &&
    reconciliation.unsupported_key_versions === 0 &&
    !JSON.stringify(reconciliation).includes("item_ref"), JSON.stringify(reconciliation));

  const unconfigured = { ...d1(freshDb()), BANK_FEED_API_BASE: undefined };
  const statusUrl = new URL("https://demo.example.workers.dev/api/bank-feed/status");
  const withKey = new Request(statusUrl, { headers: { "X-Admin-Key": "fixture-admin-key" } });
  const statusResponse = await handleBankFeed(unconfigured, withKey, statusUrl, "/api/bank-feed/status");
  const statusBody = await statusResponse.json();
  check("an unconfigured brain reports that plainly rather than pretending to have no banks",
    statusBody.configured === false && statusBody.connections.length === 0, JSON.stringify(statusBody));
}

console.log(`\n${fail ? "FAILURES" : "bank-feed"}: ${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
