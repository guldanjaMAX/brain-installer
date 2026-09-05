/** Owner browser bank-import acceptance against real migrations and SQLite. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { splitStatements } from "../../brain.mjs";
import worker from "../src/index.js";
import { handleOwnerActions } from "../src/lib/owner-actions.js";
import {
  OWNER_BANK_IMPORT_CAPABILITIES_PATH,
  OWNER_BANK_IMPORT_COMMIT_PATH,
  OWNER_BANK_IMPORT_MAX_BYTES,
  OWNER_BANK_IMPORT_PREVIEW_PATH,
} from "../src/lib/owner-bank-import.js";
import { mintSessionCookie } from "../src/lib/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MIGRATIONS = join(ROOT, "migrations", "d1");
const BANK_FIXTURES = join(ROOT, "test", "fixtures", "bank");
const migrationFiles = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) db.exec(statement);
  }
  db.exec(`
    INSERT INTO install_state (id,client_slug,product_version,installed_at)
    VALUES (1,'fixture','0.0.0-test','2026-01-01T00:00:00.000Z');
    INSERT INTO fin_entities
      (tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,
       provenance,basis_state,recorded_at)
    VALUES
      ('primary','acme','Acme Fixture LLC','Acme','business','active','owned',
       'owner_stated','confirmed','2026-01-01T00:00:00.000Z'),
      ('primary','second-co','Second Fixture LLC','Second','business','active','owned',
       'owner_stated','confirmed','2026-01-01T00:00:00.000Z'),
      ('primary','buyer','Buyer Fixture LLC','Buyer','business','active','counterparty',
       'owner_stated','confirmed','2026-01-01T00:00:00.000Z');
    INSERT INTO owner_passkeys
      (credential_id,public_key_jwk,alg,sign_count,nickname,created_at,grant_id,document_grant_id)
    VALUES ('fixture-owner-passkey','{}',-7,0,'Fixture owner',1,NULL,NULL);
  `);
  return db;
}

function d1Environment(db) {
  const control = { failPattern: null };
  const statement = (sql, params = []) => {
    const shaped = {
      __sql: sql,
      __params: params,
      bind: (...next) => statement(sql, next),
      all: async () => {
        if (control.failPattern?.test(sql)) throw new Error("synthetic D1 unavailable");
        return { results: db.prepare(sql).all(...params) };
      },
      first: async () => {
        if (control.failPattern?.test(sql)) throw new Error("synthetic D1 unavailable");
        return db.prepare(sql).get(...params) ?? null;
      },
      run: async () => {
        if (control.failPattern?.test(sql)) throw new Error("synthetic D1 unavailable");
        const result = db.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes || 0) } };
      },
    };
    return shaped;
  };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "fixture-admin-key",
    SESSION_SIGNING_KEY: "fixture-session-signing-key-0123456789",
    CREDENTIAL_SCANNER: "on",
    VECTORIZE: {},
    DB: {
      prepare: (sql) => statement(sql),
      batch: async (statements) => {
        const results = [];
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const item of statements) {
            if (control.failPattern?.test(item.__sql)) throw new Error("synthetic D1 unavailable");
            const prepared = db.prepare(item.__sql);
            if (prepared.columns().length > 0) {
              results.push({ results: prepared.all(...item.__params), meta: { changes: 0 } });
            } else {
              const result = prepared.run(...item.__params);
              results.push({ meta: { changes: Number(result.changes || 0) } });
            }
          }
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  return { env, control };
}

async function fixture() {
  const db = freshDb();
  const { env, control } = d1Environment(db);
  const cookie = await mintSessionCookie(env, 1, {
    grantId: null,
    credentialId: "fixture-owner-passkey",
  });
  const headers = { Cookie: cookie.split(";")[0], "X-Brain-App": "1" };
  const post = (path, body, suppliedHeaders = headers) => worker.fetch(new Request(
    `https://brain.invalid${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...suppliedHeaders },
      body: JSON.stringify(body ?? {}),
    },
  ), env, { waitUntil() {}, passThroughOnException() {} });
  const direct = (path, body, options = {}) => handleOwnerActions(env, new Request(
    `https://brain.invalid${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    },
  ), path, options);
  return { db, env, control, headers, post, direct };
}

const b64 = (value) => Buffer.from(value).toString("base64");
const namedBytes = (name) => readFileSync(join(BANK_FIXTURES, name));
const media = (name) => name.endsWith(".ofx")
  ? "application/x-ofx"
  : name.endsWith(".qfx") ? "application/vnd.intu.qfx" : "text/csv";
function bodyFor(name, overrides = {}) {
  return {
    entity_slug: "acme",
    file_name: name,
    media_type: media(name),
    content_base64: b64(namedBytes(name)),
    ...(name.endsWith(".csv") ? {
      mapping: {
        account_slug: "acme-operating",
        account_kind: "checking",
        account_label: "Operating",
        institution: "Fixture Bank",
        currency: "USD",
      },
    } : { mapping: {} }),
    ...overrides,
  };
}

async function parsed(response) {
  return { response, body: await response.json() };
}

test("owner bank-import capabilities are owner-only and honest about bounds", async () => {
  const f = await fixture();
  const anonymous = await f.post(OWNER_BANK_IMPORT_CAPABILITIES_PATH, {}, {});
  assert.equal(anonymous.status, 401);
  const adminOnly = await f.post(
    OWNER_BANK_IMPORT_CAPABILITIES_PATH,
    {},
    { "X-Admin-Key": f.env.ADMIN_KEY },
  );
  assert.equal(adminOnly.status, 401, "the operator key is not an owner-session fallback");

  const result = await parsed(await f.post(OWNER_BANK_IMPORT_CAPABILITIES_PATH, {}));
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("cache-control") || "", /private/);
  assert.deepEqual(result.body.supported_extensions, [".ofx", ".qfx", ".csv"]);
  assert.equal(result.body.max_file_bytes, OWNER_BANK_IMPORT_MAX_BYTES);
  assert.equal(result.body.max_transactions_per_commit, 70);
  assert.equal(result.body.raw_file_persisted, false);
  assert.equal(result.body.confirmation_required, true);
});

test("OFX, QFX, and mapped CSV preview through the real router without financial mutation", async () => {
  for (const name of ["checking-july.ofx", "card-july.qfx", "paired-columns.csv"]) {
    const f = await fixture();
    const before = f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n;
    const result = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, bodyFor(name)));
    assert.equal(result.response.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.previewed, true);
    assert.equal(result.body.mutated, false);
    assert.equal(result.body.file.format, name.slice(name.lastIndexOf(".") + 1));
    assert.equal(result.body.summary.accounts.length >= 1, true);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n, before);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_activity_events").get().n, 0);
    const intent = f.db.prepare("SELECT * FROM owner_bank_import_previews").get();
    assert.equal(intent.content_sha256, result.body.file.sha256);
    assert.equal(Object.keys(intent).some((key) => /content_base64|raw_bytes|file_name|mapping/.test(key)), false);
    assert.equal(JSON.stringify(intent).includes("000000004821"), false, "the OFX account number was not persisted");
  }
});

test("preview refuses ambiguous CSV, missing mapping, oversized bytes, and an oversized atomic plan", async () => {
  const f = await fixture();
  const missingMapping = await parsed(await f.post(
    OWNER_BANK_IMPORT_PREVIEW_PATH,
    bodyFor("paired-columns.csv", { mapping: {} }),
  ));
  assert.equal(missingMapping.response.status, 400);
  assert.equal(missingMapping.body.code, "invalid_bank_account_slug");

  const ambiguous = await parsed(await f.post(
    OWNER_BANK_IMPORT_PREVIEW_PATH,
    bodyFor("ambiguous-amount.csv"),
  ));
  assert.equal(ambiguous.response.status, 422);
  assert.equal(ambiguous.body.code, "bank_export_refused");

  const oversized = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, {
    ...bodyFor("checking-july.ofx"),
    content_base64: b64(Buffer.alloc(OWNER_BANK_IMPORT_MAX_BYTES + 1, 65)),
  }));
  assert.equal(oversized.response.status, 413, JSON.stringify(oversized.body));
  assert.equal(oversized.body.code, "bank_import_file_too_large");

  const rows = ["Date,Description,Debit,Credit"];
  for (let index = 0; index < 71; index++) rows.push(`2026-07-01,ROW ${index},1.00,`);
  const tooMany = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, {
    ...bodyFor("paired-columns.csv"),
    file_name: "many.csv",
    content_base64: b64(`${rows.join("\n")}\n`),
  }));
  assert.equal(tooMany.response.status, 413);
  assert.equal(tooMany.body.code, "bank_import_atomic_limit");

  const ofx = namedBytes("checking-july.ofx").toString("utf8");
  const statement = ofx.match(/<STMTRS>[\s\S]*?<\/STMTRS>/)?.[0];
  assert.ok(statement);
  const fiveAccounts = Array.from({ length: 5 }, (_, index) =>
    statement.replace("000000004821", `00000000482${index}`)).join("\n");
  const tooManyAccounts = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, {
    ...bodyFor("checking-july.ofx"),
    file_name: "five-accounts.ofx",
    content_base64: b64(ofx.replace(statement, fiveAccounts)),
  }));
  assert.equal(tooManyAccounts.response.status, 413, JSON.stringify(tooManyAccounts.body));
  assert.equal(tooManyAccounts.body.code, "bank_import_atomic_limit");
  assert.equal(tooManyAccounts.body.accounts, 5);
  assert.equal(tooManyAccounts.body.max_accounts_per_commit, 4);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_bank_import_previews").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n, 0);
});

test("confirmed commit survives a lost response with one ledger mutation and one activity event", async () => {
  const f = await fixture();
  const upload = bodyFor("checking-july.ofx");
  const preview = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, upload));
  assert.equal(preview.response.status, 200);
  const commitBody = {
    ...upload,
    preview_id: preview.body.preview_id,
    request_id: "bank_commit_lost_1",
    confirmed: true,
  };

  const lost = await parsed(await f.direct(OWNER_BANK_IMPORT_COMMIT_PATH, commitBody, {
    afterBankImportCommit: async () => { throw new Error("response disappeared"); },
  }));
  assert.equal(lost.response.status, 503);
  assert.equal(lost.body.code, "owner_bank_import_finalize_unavailable");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n, 5);
  assert.equal(f.db.prepare(
    "SELECT count(*) AS n FROM owner_activity_events WHERE event_type='bank_import_completed'",
  ).get().n, 1);
  const durableReceipt = f.db.prepare(
    "SELECT response_json FROM owner_action_requests WHERE request_id='bank_commit_lost_1'",
  ).get().response_json;
  const durableActivity = f.db.prepare(
    "SELECT display_label FROM owner_activity_events WHERE event_type='bank_import_completed'",
  ).get().display_label;
  for (const privateDetail of [
    "checking-july.ofx", "SUPPLIER INVOICE", "000000004821", "8421.10",
  ]) {
    assert.equal(durableReceipt.includes(privateDetail), false);
    assert.equal(durableActivity.includes(privateDetail), false);
  }
  assert.equal(durableActivity, "Imported bank export");
  assert.equal(f.db.prepare(
    "SELECT count(*) AS n FROM owner_action_requests WHERE request_id='bank_commit_lost_1'",
  ).get().n, 1);

  const retry = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, commitBody));
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.changed, true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n, 5);
  assert.equal(f.db.prepare(
    "SELECT count(*) AS n FROM owner_activity_events WHERE event_type='bank_import_completed'",
  ).get().n, 1);

  const alteredBytes = Buffer.from(namedBytes("checking-july.ofx"));
  const needle = Buffer.from("SUPPLIER INVOICE");
  alteredBytes.set(Buffer.from("SUPPLIER BILL   "), alteredBytes.indexOf(needle));
  const changedRetry = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...commitBody,
    content_base64: b64(alteredBytes),
  }));
  assert.equal(changedRetry.response.status, 409);
  assert.equal(changedRetry.body.code, "request_id_conflict");

  const secondRequest = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...commitBody,
    request_id: "bank_commit_other_1",
  }));
  assert.equal(secondRequest.response.status, 409);
  assert.equal(secondRequest.body.code, "bank_import_preview_consumed");
});

test("a failed atomic batch leaves no commit, ledger rows, receipt, or activity and retries safely", async () => {
  const f = await fixture();
  const upload = bodyFor("checking-july.ofx");
  const preview = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, upload));
  assert.equal(preview.response.status, 200);
  const commitBody = {
    ...upload,
    preview_id: preview.body.preview_id,
    request_id: "bank_commit_atomic_retry",
    confirmed: true,
  };

  f.control.failPattern = /INSERT INTO fin_transactions/;
  const failed = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, commitBody));
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.code, "owner_bank_import_commit_unavailable");
  for (const table of [
    "fin_transactions", "owner_bank_import_commits", "owner_action_requests",
    "owner_activity_events",
  ]) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }

  f.control.failPattern = null;
  const retry = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, commitBody));
  assert.equal(retry.response.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n, 5);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_bank_import_commits").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_action_requests").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_activity_events").get().n, 1);
});

test("commit binds exact preview bytes, mapping, confirmation, and expiry before mutation", async () => {
  const f = await fixture();
  const input = bodyFor("paired-columns.csv");
  const preview = await parsed(await f.direct(OWNER_BANK_IMPORT_PREVIEW_PATH, input, {
    bankImportNow: () => "2026-08-30T10:00:00.000Z",
  }));
  assert.equal(preview.response.status, 200);

  const noConfirm = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...input,
    preview_id: preview.body.preview_id,
    request_id: "bank_no_confirm",
  }));
  assert.equal(noConfirm.response.status, 400);
  assert.equal(noConfirm.body.code, "bank_import_confirmation_required");

  const changedMapping = await parsed(await f.direct(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...input,
    mapping: { ...input.mapping, account_slug: "different-account" },
    preview_id: preview.body.preview_id,
    request_id: "bank_mapping_changed",
    confirmed: true,
  }, {
    bankImportNow: () => "2026-08-30T10:01:00.000Z",
  }));
  assert.equal(changedMapping.response.status, 409);
  assert.equal(changedMapping.body.code, "bank_import_preview_mismatch");

  const expired = await parsed(await f.direct(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...input,
    preview_id: preview.body.preview_id,
    request_id: "bank_expired",
    confirmed: true,
  }, {
    bankImportNow: () => "2026-08-30T10:16:00.000Z",
  }));
  assert.equal(expired.response.status, 409);
  assert.equal(expired.body.code, "bank_import_preview_expired");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_action_requests").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_activity_events").get().n, 0);
});

test("account scope fails closed and D1 unavailability is never encoded as empty", async () => {
  const f = await fixture();
  const input = bodyFor("checking-july.ofx");
  const firstPreview = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, input));
  const firstCommit = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...input,
    preview_id: firstPreview.body.preview_id,
    request_id: "bank_scope_seed",
    confirmed: true,
  }));
  assert.equal(firstCommit.response.status, 201);

  const wrongEntity = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, {
    ...input,
    entity_slug: "second-co",
  }));
  assert.equal(wrongEntity.response.status, 409);
  assert.equal(wrongEntity.body.code, "bank_account_entity_conflict");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_activity_events").get().n, 1);

  const counterparty = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, {
    ...bodyFor("card-july.qfx"),
    entity_slug: "buyer",
  }));
  assert.equal(counterparty.response.status, 403);
  assert.equal(counterparty.body.code, "entity_not_owned");

  f.control.failPattern = /sqlite_master/;
  const down = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, bodyFor("card-july.qfx")));
  assert.equal(down.response.status, 503);
  assert.equal(down.body.code, "owner_bank_import_unavailable");
  assert.equal("summary" in down.body, false, "unavailable does not look like a healthy empty preview");
});

test("a second exact file is unchanged and a shorter revision never infers deletion", async () => {
  const f = await fixture();
  const full = bodyFor("paired-columns.csv");
  const previewFull = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, full));
  const committedFull = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...full,
    preview_id: previewFull.body.preview_id,
    request_id: "bank_csv_full",
    confirmed: true,
  }));
  assert.equal(committedFull.response.status, 201);
  const fullCount = f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n;

  const previewSame = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, full));
  const committedSame = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...full,
    preview_id: previewSame.body.preview_id,
    request_id: "bank_csv_same",
    confirmed: true,
  }));
  assert.equal(committedSame.response.status, 200);
  assert.equal(committedSame.body.changed, false);
  assert.equal(committedSame.body.activity_event_id, null);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM owner_activity_events").get().n, 1);

  const lines = readFileSync(join(BANK_FIXTURES, "paired-columns.csv"), "utf8").trimEnd().split(/\r?\n/);
  const shorter = {
    ...full,
    file_name: "shorter.csv",
    content_base64: b64(`${lines.slice(0, -1).join("\n")}\n`),
  };
  const previewShort = await parsed(await f.post(OWNER_BANK_IMPORT_PREVIEW_PATH, shorter));
  assert.equal(previewShort.response.status, 200, JSON.stringify(previewShort.body));
  const committedShort = await parsed(await f.post(OWNER_BANK_IMPORT_COMMIT_PATH, {
    ...shorter,
    preview_id: previewShort.body.preview_id,
    request_id: "bank_csv_shorter",
    confirmed: true,
  }));
  assert.equal(committedShort.response.status, 201, JSON.stringify(committedShort.body));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions").get().n >= fullCount, true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NOT NULL").get().n, 0);
});
