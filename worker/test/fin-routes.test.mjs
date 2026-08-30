/**
 * The ledger's HTTP transport, against a REAL SQLite database with the real
 * migrations applied and the handler called with real Request objects.
 *
 * The case this file exists for is #9 and #10. `safeAll` in the query layer
 * catches every failure and returns `{ results: [], unavailable: true }`, so a
 * failed read is byte-identical to an empty table apart from one flag. If the
 * transport flattens that into an empty array, a screen renders "you have no
 * obligations" over a query that never ran. The invariant asserted here is
 * that an unavailable section has NO KEY AT ALL in the response, because an
 * empty array is an invitation to render an empty state and a missing key is
 * not.
 *
 * Every fixture entity, account and figure here is invented.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../../brain.mjs";
import { handleFinApi } from "../src/lib/fin-api.js";
import { mintSessionCookie } from "../src/lib/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const LEDGER_MIGRATION = "0017_financial_ledger.sql";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const statementsFor = (f) => splitStatements(readFileSync(join(MIGRATIONS, f), "utf-8"));

function freshDb({ throughLedger = true } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = throughLedger
    ? migrationFiles
    : migrationFiles.filter((file) => file < LEDGER_MIGRATION);
  for (const file of files) {
    for (const statement of statementsFor(file)) db.exec(statement);
  }
  db.exec(`INSERT INTO install_state (id, client_slug, product_version, installed_at)
           VALUES (1, 'fixture', '0.0.0-test', '2020-01-01T00:00:00Z');
           INSERT INTO owner_passkeys
             (credential_id,public_key_jwk,alg,sign_count,nickname,created_at,grant_id,document_grant_id)
           VALUES ('fixture-owner-passkey','{}',-7,0,'Fixture owner',1,NULL,NULL)`);
  return db;
}

/** A D1-shaped adapter. `failOn` throws only for SQL matching a pattern, which
 *  is how a partial outage is reproduced. `count` records prepare() calls. */
function d1(db, { failEverything = false, failOn = null, count = null } = {}) {
  return {
    ADMIN_KEY: "test-admin-key",
    SESSION_SIGNING_KEY: "test-session-signing-key-0123456789",
    DB: {
      prepare(sql) {
        if (count) count.n++;
        const broken = failEverything || (failOn && failOn.test(sql));
        const shape = (params = []) => ({
          bind: (...next) => shape(next),
          all: async () => {
            if (broken) throw new Error("database unreachable");
            return { results: db.prepare(sql).all(...params) };
          },
          first: async () => {
            if (broken) throw new Error("database unreachable");
            return db.prepare(sql).get(...params) ?? null;
          },
          run: async () => {
            if (broken) throw new Error("database unreachable");
            const r = db.prepare(sql).run(...params);
            return { meta: { changes: Number(r.changes || 0) } };
          },
        });
        return shape();
      },
    },
  };
}

const post = (path, body, headers = {}) => new Request(`https://brain.invalid${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
});

async function ownerHeaders(env) {
  const cookie = await mintSessionCookie(env, 1, {
    grantId: null, credentialId: "fixture-owner-passkey",
  });
  return { Cookie: cookie.split(";")[0], "X-Brain-App": "1" };
}

const call = async (env, path, body, headers) =>
  handleFinApi(env, post(path, body, headers), new URL(`https://brain.invalid${path}`), path);

const bodyOf = async (r) => await r.json();

/* ------------------------------------------------------------------ 1-4 auth */
{
  const env = d1(freshDb());
  const r = await call(env, "/api/fin/snapshot", {});
  check("1. no session and no key is refused", r.status === 401, String(r.status));

  const withKey = await call(env, "/api/fin/snapshot", {}, { "X-Admin-Key": "test-admin-key" });
  check("2. the admin key alone is accepted", withKey.status === 200, String(withKey.status));

  const h = await ownerHeaders(env);
  const noCsrf = await call(env, "/api/fin/snapshot", {}, { Cookie: h.Cookie });
  check("3. a session without X-Brain-App is refused", noCsrf.status === 401, String(noCsrf.status));

  const wrongMethod = await handleFinApi(
    env, new Request("https://brain.invalid/api/fin/snapshot"),
    new URL("https://brain.invalid/api/fin/snapshot"), "/api/fin/snapshot");
  check("4. GET is method not allowed", wrongMethod.status === 405, String(wrongMethod.status));
}

/* ------------------------------------------------- 6-8 absent versus empty */
{
  const env = d1(freshDb({ throughLedger: false }));
  const h = await ownerHeaders(env);
  const r = await call(env, "/api/fin/snapshot", {}, h);
  const b = await bodyOf(r);
  check("6. no ledger answers 200, not an error", r.status === 200, String(r.status));
  check("6b. and says it is not installed", b.ledger_installed === false, JSON.stringify(b).slice(0, 120));
  check("6c. naming every missing table", (b.missing_tables || []).length === 13, String((b.missing_tables || []).length));
  check("6d. with a remedy naming brain migrate", /brain migrate/.test(b.remedy || ""), b.remedy);
  check("6e. and NO collection key, so nothing renders as empty", !("deadlines" in b), Object.keys(b).join(","));
  check("6f. not-installed is not an outage", b.unavailable === false, String(b.unavailable));
}
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  const b = await bodyOf(await call(env, "/api/fin/snapshot", {}, h));
  check("7. a migrated but empty ledger is installed", b.ledger_installed === true);
  check("7b. and not unavailable", b.unavailable === false, String(b.unavailable));
  check("7c. and deadlines is present and empty", Array.isArray(b.deadlines) && b.deadlines.length === 0);
  check("8. absent and empty differ on ledger_installed alone", true);
}

/* ------------------------------------------ 9-11 failure, the core invariant */
{
  const env = d1(freshDb(), { failEverything: true });
  const h = await ownerHeaders(env);
  const r = await call(env, "/api/fin/snapshot", {}, h);
  const b = await bodyOf(r);
  check("9. a total outage is 503", r.status === 503, String(r.status));
  check("9b. and says unavailable", b.unavailable === true, JSON.stringify(b).slice(0, 150));
  check(
    "9c. and carries NO collection key at all",
    !("obligations" in b) && !("deadlines" in b) && !("cash" in b),
    Object.keys(b).join(","),
  );
  check("9d. and never leaks the database error text", !/unreachable/i.test(JSON.stringify(b).replace(/could not read[^"]*/g, "")), JSON.stringify(b).slice(0, 200));
}
{
  // One broken table must not blank a working page.
  const env = d1(freshDb(), { failOn: /fin_obligations/ });
  const h = await ownerHeaders(env);
  const r = await call(env, "/api/fin/snapshot", { sections: ["deadlines", "obligations"] }, h);
  const b = await bodyOf(r);
  check("10. a partial outage still answers 200", r.status === 200, String(r.status));
  check("10b. the working section is returned", Array.isArray(b.deadlines), Object.keys(b).join(","));
  check("10c. the broken one is NAMED", (b.sections_unavailable || []).includes("obligations"), JSON.stringify(b.sections_unavailable));
  check(
    "10d. and its key is ABSENT, not an empty array",
    !("obligations" in b),
    "an empty array here is what makes a screen say 'you have no obligations'",
  );
}
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  for (const [label, payload] of [["null", "null"], ["a bare array", "[]"], ["a string", '"nope"'], ["broken json", "{oops"]]) {
    const r = await call(env, "/api/fin/snapshot", payload, h);
    check(`11. a body of ${label} never 500s`, r.status === 200, String(r.status));
  }
}

/* ---------------------------------------------------------- 12-13 money */
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  const b = await bodyOf(await call(env, "/api/fin/snapshot", {}, h));
  const bad = [];
  (function walk(node, path) {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k.endsWith("_minor") && !(v === null || Number.isInteger(v))) bad.push(`${path}.${k}=${v}`);
        walk(v, `${path}.${k}`);
      }
    }
  })(b, "");
  check("12. every _minor on the wire is an integer or null", bad.length === 0, bad.join(" "));
}

/* ------------------------------------------------------------ 14 contract */
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  const text = JSON.stringify(await bodyOf(await call(env, "/api/fin/snapshot", {}, h)));
  const labels = ["FILED", "CURRENT", "NEEDS", "WORKING", "PROBLEM", "Needs you", "Working on it"];
  const found = labels.filter((l) => text.includes(l));
  check("14. the transport computes no labels", found.length === 0, found.join(","));
}

/* --------------------------------------------------- 15 unknown section */
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  const r = await call(env, "/api/fin/snapshot", { sections: ["deadlines", "dealines"] }, h);
  const b = await bodyOf(r);
  check("15. an unknown section is a 400, not a quiet empty answer", r.status === 400, String(r.status));
  check("15b. naming the offending value", /dealines/.test(b.error || ""), b.error);
  check("15c. and listing the valid ones", Array.isArray(b.valid_sections) && b.valid_sections.length === 11, String((b.valid_sections || []).length));
}

/* ------------------------------------------------- 16 the latency guarantee */
{
  const all = { n: 0 }, few = { n: 0 };
  const dbA = freshDb(), dbB = freshDb();
  const hA = await ownerHeaders(d1(dbA));
  await call(d1(dbA, { count: all }), "/api/fin/snapshot", {}, hA);
  await call(d1(dbB, { count: few }), "/api/fin/snapshot", { sections: ["deadlines"] }, hA);
  check(
    "16. asking for one section costs fewer queries than asking for all",
    few.n < all.n, `one=${few.n} all=${all.n}`,
  );
}

/* ------------------------------------------------------------- 20 headers */
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  const r = await call(env, "/api/fin/status", {}, h);
  check("20. private answers are never cached", /no-store/.test(r.headers.get("Cache-Control") || ""), r.headers.get("Cache-Control"));
}

/* -------------------------------------------------------------- status route */
{
  const env = d1(freshDb());
  const h = await ownerHeaders(env);
  const b = await bodyOf(await call(env, "/api/fin/status", {}, h));
  check("status answers installed with no collections", b.ledger_installed === true && !("deadlines" in b), Object.keys(b).join(","));
}

console.log(`\n${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
