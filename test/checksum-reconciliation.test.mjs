// WP-00 (continued): checksum reconciliation for an applied migration whose
// file content changed after it ran.
//
// This is a DIFFERENT bug than the stuck-mid-upgrade case
// test/upgrade-repair.test.mjs covers. That one is about a migration that
// died partway through and needs to resume or roll back. This one is about
// a migration that finished successfully, was recorded, and then had its
// FILE bytes changed afterward (a line-ending change is the confirmed cause
// on the one real install stranded by this — see
// evidence/WP-00-checksum-reconciliation.md). cmdMigrate's checksum guard
// (`checksum !== mig.checksum`, brain.mjs) then die()s unconditionally,
// before any pending migration is even considered, with no force flag
// anywhere. Critically, `brain doctor <manifest> --repair` (the existing
// stuck-upgrade fix) does NOT resolve this: it replays cmdUpgrade, which
// calls cmdMigrate again, which hits the identical checksum die() and
// re-strands the install. The only correct fix is reconciliation: show the
// operator exactly what differs, require explicit confirmation, then update
// the STORED checksum to match the current file, without re-running any SQL.
//
// This file proves, per the reporter's own ask in issue #2: the tool detects a
// checksum mismatch on an already-applied migration and reports it clearly
// (including a positive line-ending diagnosis when that is exactly and only
// what changed, his own stated hypothesis); it refuses to act without
// explicit confirmation; and confirmed reconciliation updates
// schema_migrations correctly with zero data loss and zero re-execution of
// the migration's SQL — proven not by inference but by a fake D1 adapter
// that throws on any statement other than the one read and the one write
// this command is allowed to make.

import { writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnoseChecksumDrift,
  applyChecksumReconciliation,
  cmdRepairChecksum,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };

const checksumOf = (sql) => createHash("sha256").update(sql).digest("hex").slice(0, 16);

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-checksum-repair-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifestFixture = (overrides = {}) => ({
  client: { slug: "fixture" },
  brain: { worker_name: "fixture-brain", domain: "fixture-brain.example.com", ...overrides.brain },
  infrastructure: {
    cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database", storage: "d1", ...overrides.infrastructure?.cloudflare },
  },
  ...overrides,
});
writeFileSync(manifestPath, JSON.stringify(manifestFixture()));

/**
 * A fake D1 that models exactly one table this command may ever touch:
 * schema_migrations. It records every statement it receives and THROWS on
 * anything that is not the exact read (appliedVersions) or the exact write
 * (the reconciliation UPDATE) this command is allowed to make — including
 * any migration DDL/DML, any INSERT, any row deletion. If reconciliation
 * ever re-ran migration SQL or touched anything else, this fixture would
 * fail loudly rather than silently permitting it.
 */
function fakeDatabase(seedRows = []) {
  const rows = new Map(seedRows.map((r) => [r.version, { ...r }]));
  const callLog = [];
  let corpusRowCount = 1204; // stands in for "everything else in the DB"; must never move
  const d1Query = async (acctId, dbId, sql, params = []) => {
    const text = String(sql).trim();
    callLog.push({ sql: text, params });
    if (text === "SELECT version, checksum, name FROM schema_migrations") {
      return { results: [...rows.values()] };
    }
    if (text === "UPDATE schema_migrations SET checksum = ? WHERE version = ?") {
      const [checksum, version] = params;
      const row = rows.get(version);
      if (!row) throw new Error(`fixture: no schema_migrations row for version ${version}`);
      row.checksum = checksum;
      return { results: [], meta: { changes: 1 } };
    }
    throw new Error(`fixture: unexpected SQL sent to D1 by checksum reconciliation: ${text}`);
  };
  return {
    d1Query,
    callLog,
    rows,
    get corpusRowCount() { return corpusRowCount; },
    updateCalls: () => callLog.filter((c) => c.sql.startsWith("UPDATE")),
  };
}

const resolveAccount = async () => ({ id: "fixture-account" });

try {
  /* ---- detection: a pure line-ending drift is positively confirmed as one ---- */
  {
    const appliedSql = "CREATE TABLE t (id INTEGER PRIMARY KEY);\nINSERT INTO t (id) VALUES (1);\n"; // LF
    const appliedChecksum = checksumOf(appliedSql);
    const currentSql = appliedSql.replace(/\n/g, "\r\n"); // simulates the exact bug: CRLF now
    const currentChecksum = checksumOf(currentSql);
    check("the fixture actually reproduces a checksum change from line endings alone",
      appliedChecksum !== currentChecksum, JSON.stringify({ appliedChecksum, currentChecksum }));

    const db = fakeDatabase([{ version: 1, name: "0001_test_table", applied_at: "2026-08-01T00:00:00.000Z", checksum: appliedChecksum }]);
    const loadMigrations = () => [{ version: 1, name: "0001_test_table", sql: currentSql, checksum: currentChecksum }];
    const diagnoseOptions = { resolveAccount, d1Query: db.d1Query, loadMigrations };

    const diagnosis = await diagnoseChecksumDrift(manifestPath, diagnoseOptions);
    check("checked successfully", diagnosis.checked === true, JSON.stringify(diagnosis));
    check("exactly one drifted migration found", diagnosis.drift?.length === 1, JSON.stringify(diagnosis.drift));
    const entry = diagnosis.drift[0];
    check("reports the applied checksum", entry.appliedChecksum === appliedChecksum, entry.appliedChecksum);
    check("reports the current file checksum", entry.fileChecksum === currentChecksum, entry.fileChecksum);
    check("reports when it was applied", entry.appliedAt === "2026-08-01T00:00:00.000Z", entry.appliedAt);
    check("positively confirms this as a line-ending change (LF applied, file now CRLF)",
      /LF/.test(entry.lineEndingExplanation) && /CRLF/.test(entry.lineEndingExplanation) && new RegExp(appliedChecksum).test(entry.lineEndingExplanation),
      entry.lineEndingExplanation);

    /* ---- refusal: no --yes means nothing changes ---- */
    const preview = await cmdRepairChecksum(manifestPath, { diagnoseOptions, confirmed: false });
    check("preview reports the drift without acting", preview.previewed === "repair-checksum" && preview.drift.length === 1, JSON.stringify(preview));
    check("no D1 write happened during preview", db.updateCalls().length === 0, JSON.stringify(db.callLog));
    check("the stored checksum in the fake DB is still the old one", db.rows.get(1).checksum === appliedChecksum, db.rows.get(1).checksum);

    /* ---- reconciliation: confirmed action updates the checksum, nothing else ---- */
    const preRowCount = db.corpusRowCount;
    const applyOptions = { resolveAccount, d1Query: db.d1Query };
    const result = await cmdRepairChecksum(manifestPath, { diagnoseOptions, applyOptions, confirmed: true });
    check("reconciliation reports exactly one row reconciled", result.reconciled?.length === 1, JSON.stringify(result));
    check("reconciled entry carries the new checksum", result.reconciled[0].checksum === currentChecksum, JSON.stringify(result.reconciled));
    check("schema_migrations now stores the current file's checksum", db.rows.get(1).checksum === currentChecksum, db.rows.get(1).checksum);
    check("exactly one UPDATE was issued, targeting the right version and checksum",
      db.updateCalls().length === 1 &&
        JSON.stringify(db.updateCalls()[0].params) === JSON.stringify([currentChecksum, 1]),
      JSON.stringify(db.updateCalls()));
    check("zero re-execution of the migration's own SQL (the fake DB would have thrown otherwise)",
      !db.callLog.some((c) => /CREATE TABLE|INSERT INTO t\b/.test(c.sql)), JSON.stringify(db.callLog));
    check("zero data loss: the rest of the corpus is untouched", db.corpusRowCount === preRowCount && db.corpusRowCount === 1204);

    /* ---- verification: diagnosing again shows no more drift ---- */
    const after = await diagnoseChecksumDrift(manifestPath, diagnoseOptions);
    check("re-diagnosing after reconciliation finds no drift", after.checked === true && after.drift.length === 0, JSON.stringify(after));
  }

  /* ---- detection: a REAL content change is reported honestly as unconfirmed, not misdiagnosed as a line-ending change ---- */
  {
    const appliedSql = "CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT);\n";
    const appliedChecksum = checksumOf(appliedSql);
    const currentSql = "CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT, extra TEXT);\n"; // a real column added, not a line-ending change
    const currentChecksum = checksumOf(currentSql);

    const db = fakeDatabase([{ version: 1, name: "0001_test_table", applied_at: "2026-08-01T00:00:00.000Z", checksum: appliedChecksum }]);
    const loadMigrations = () => [{ version: 1, name: "0001_test_table", sql: currentSql, checksum: currentChecksum }];
    const diagnoseOptions = { resolveAccount, d1Query: db.d1Query, loadMigrations };

    const diagnosis = await diagnoseChecksumDrift(manifestPath, diagnoseOptions);
    check("a genuine content change is still detected as drift", diagnosis.drift?.length === 1, JSON.stringify(diagnosis.drift));
    check("but is NOT falsely explained as a line-ending change", diagnosis.drift[0].lineEndingExplanation === null, diagnosis.drift[0].lineEndingExplanation);

    // Confirmation still works on operator say-so even without an automatic
    // explanation — the tool's job is to show the truth honestly, not to
    // block reconciliation on cases it cannot self-diagnose.
    const applyOptions = { resolveAccount, d1Query: db.d1Query };
    const result = await cmdRepairChecksum(manifestPath, { diagnoseOptions, applyOptions, confirmed: true });
    check("confirmed reconciliation still succeeds on an unexplained drift", result.reconciled?.[0]?.checksum === currentChecksum, JSON.stringify(result));
  }

  /* ---- no drift: a healthy install is left alone ---- */
  {
    const sql = "CREATE TABLE v (id INTEGER PRIMARY KEY);\n";
    const checksum = checksumOf(sql);
    const db = fakeDatabase([{ version: 1, name: "0001_test_table", applied_at: "2026-08-01T00:00:00.000Z", checksum }]);
    const loadMigrations = () => [{ version: 1, name: "0001_test_table", sql, checksum }];
    const diagnoseOptions = { resolveAccount, d1Query: db.d1Query, loadMigrations };

    const diagnosis = await diagnoseChecksumDrift(manifestPath, diagnoseOptions);
    check("a healthy install reports zero drift", diagnosis.checked === true && diagnosis.drift.length === 0, JSON.stringify(diagnosis));

    const result = await cmdRepairChecksum(manifestPath, { diagnoseOptions, confirmed: true });
    check("cmdRepairChecksum is a no-op on a healthy install even with --yes", result.drift.length === 0 && db.updateCalls().length === 0, JSON.stringify({ result, calls: db.callLog }));
  }

  /* ---- tolerant failure modes: never throw on a resolution problem, only on a confirmed action with none to check ---- */
  {
    const diagnosis = await diagnoseChecksumDrift(join(sandbox, "does-not-exist.json"), {});
    check("a missing manifest is reported as not-checked, never thrown", diagnosis.checked === false && /manifest could not be read/.test(diagnosis.reason), JSON.stringify(diagnosis));
  }
  {
    const noDbManifest = join(sandbox, "no-db.manifest.json");
    writeFileSync(noDbManifest, JSON.stringify(manifestFixture({ infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: undefined } } })));
    const diagnosis = await diagnoseChecksumDrift(noDbManifest, {});
    check("no d1_database_id degrades to not-checked, not a crash", diagnosis.checked === false && /no d1_database_id/.test(diagnosis.reason), JSON.stringify(diagnosis));
  }
  {
    const diagnosis = await diagnoseChecksumDrift(manifestPath, {
      resolveAccount: async () => { throw new Error("CLOUDFLARE_API_TOKEN is not set"); },
    });
    check("no Cloudflare token degrades to not-checked, not a crash", diagnosis.checked === false && /could not resolve this install's Cloudflare account/.test(diagnosis.reason), JSON.stringify(diagnosis));
  }
  {
    const diagnosis = await diagnoseChecksumDrift(manifestPath, {
      resolveAccount,
      d1Query: async () => { throw new Error("synthetic D1 outage"); },
    });
    check("a D1 outage degrades to not-checked, not a crash — NOT a confident 'zero drift'",
      diagnosis.checked === false && /could not read schema_migrations/.test(diagnosis.reason), JSON.stringify(diagnosis));
  }
  {
    // A brand new install that has never run `brain migrate` has no
    // schema_migrations table at all. That is the one query failure that
    // legitimately means "zero applied migrations", not a degraded check.
    const diagnosis = await diagnoseChecksumDrift(manifestPath, {
      resolveAccount,
      d1Query: async () => { throw new Error("D1_ERROR: no such table: schema_migrations"); },
      loadMigrations: () => [{ version: 1, name: "0001_x", sql: "CREATE TABLE x (id INTEGER);\n", checksum: checksumOf("CREATE TABLE x (id INTEGER);\n") }],
    });
    check("a genuinely fresh install (no schema_migrations table yet) is checked:true with zero drift, not degraded",
      diagnosis.checked === true && diagnosis.drift.length === 0, JSON.stringify(diagnosis));
  }
  {
    let error = null;
    try {
      await cmdRepairChecksum(manifestPath, {
        diagnoseOptions: { resolveAccount: async () => { throw new Error("synthetic outage"); } },
      });
    } catch (caught) { error = caught; }
    check("an undiagnosable brain refuses to act blind rather than silently doing nothing",
      /could not check applied migrations for checksum drift/.test(error?.message || ""), error?.message);
  }

  /* ---- multiple drifted migrations in one pass ---- */
  {
    const sqlA = "CREATE TABLE a (id INTEGER PRIMARY KEY);\n";
    const sqlB = "CREATE TABLE b (id INTEGER PRIMARY KEY);\n";
    const appliedA = checksumOf(sqlA);
    const appliedB = checksumOf(sqlB);
    const currentA = sqlA.replace(/\n/g, "\r\n");
    const currentB = "CREATE TABLE b (id INTEGER PRIMARY KEY, extra TEXT);\n";
    const db = fakeDatabase([
      { version: 1, name: "0001_a", applied_at: "2026-08-01T00:00:00.000Z", checksum: appliedA },
      { version: 2, name: "0002_b", applied_at: "2026-08-02T00:00:00.000Z", checksum: appliedB },
    ]);
    const loadMigrations = () => [
      { version: 1, name: "0001_a", sql: currentA, checksum: checksumOf(currentA) },
      { version: 2, name: "0002_b", sql: currentB, checksum: checksumOf(currentB) },
    ];
    const diagnoseOptions = { resolveAccount, d1Query: db.d1Query, loadMigrations };
    const applyOptions = { resolveAccount, d1Query: db.d1Query };

    const diagnosis = await diagnoseChecksumDrift(manifestPath, diagnoseOptions);
    check("both drifted migrations are found in one pass", diagnosis.drift.length === 2, JSON.stringify(diagnosis.drift.map((d) => d.name)));

    const result = await cmdRepairChecksum(manifestPath, { diagnoseOptions, applyOptions, confirmed: true });
    check("both are reconciled", result.reconciled.length === 2, JSON.stringify(result.reconciled));
    check("each reconciled to its own correct new checksum",
      db.rows.get(1).checksum === checksumOf(currentA) && db.rows.get(2).checksum === checksumOf(currentB),
      JSON.stringify([...db.rows.values()]));
    check("exactly two UPDATEs, no more", db.updateCalls().length === 2, JSON.stringify(db.updateCalls()));
  }

  /* ---- applyChecksumReconciliation used directly (the DI seam cmdRepairChecksum's --yes path calls) ---- */
  {
    const sql = "CREATE TABLE w (id INTEGER PRIMARY KEY);\n";
    const applied = checksumOf(sql);
    const current = sql.replace(/\n/g, "\r\n");
    const db = fakeDatabase([{ version: 1, name: "0001_w", applied_at: "2026-08-01T00:00:00.000Z", checksum: applied }]);
    const result = await applyChecksumReconciliation(
      manifestPath,
      [{ version: 1, name: "0001_w", fileChecksum: checksumOf(current) }],
      { resolveAccount, d1Query: db.d1Query },
    );
    check("applyChecksumReconciliation itself updates exactly the entries it is given",
      result.count === 1 && result.reconciled[0].checksum === checksumOf(current) && db.rows.get(1).checksum === checksumOf(current),
      JSON.stringify({ result, row: db.rows.get(1) }));
  }

  console.log(fail ? `\n${fail} FAILURES` : `\nchecksum-reconciliation: all ${ran} tests passed`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
