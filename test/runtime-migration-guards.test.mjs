/**
 * Runtime migration guards, tested from the client machine's point of view.
 *
 * The repo pins migration numbers unique and contiguous in
 * test/migration-field-collision.test.mjs, but a CLIENT MACHINE runs whatever
 * tarball it was handed and never runs the repo's tests. Each of the three
 * branches that shipped a 0017 passed its own tests in isolation; only the
 * merged tree could ever have failed the pin. So the same invariants must be
 * enforced by loadMigrations itself, at runtime, refusing BEFORE any D1
 * statement and naming the files, because "which two files collided" is the
 * entire repair.
 *
 * The second guard is appliedVersions. Its old catch collapsed EVERY failure
 * into "zero applied migrations", making a transient D1 outage look exactly
 * like a brand-new database: status printed a confident wrong answer and the
 * applied-checksum guard was silently bypassed. Same one-direction lie as the
 * spend cap's own-query-error reading as "nothing spent". The fixed version
 * treats a missing schema_migrations table — the one failure that genuinely
 * means nothing is applied — as empty, and propagates everything else.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMigrate, loadMigrations } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 500)));
  if (!c) fail++;
};

const sandbox = mkdtempSync(join(tmpdir(), "brain-runtime-migration-guards-"));

/* ---- fixture migration sets ---- */

// A minimal but REAL pair of migrations: 0001 creates the tables cmdMigrate's
// own bookkeeping needs (ledger, install_state seed columns, chunks), 0002 is
// an ordinary additive change. Invented content only; personas per repo rule.
const BASE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, checksum TEXT
);
CREATE TABLE IF NOT EXISTS install_state (
  id INTEGER PRIMARY KEY, client_slug TEXT, product_version TEXT, schema_version INTEGER,
  gate_version INTEGER, installed_at TEXT, last_upgraded_at TEXT, ring TEXT, notes TEXT,
  vector_projection_status TEXT, vector_projection_bootstrap_epoch INTEGER,
  vector_projection_bootstrap_cursor TEXT, vector_projection_bootstrap_high_water TEXT
);
CREATE TABLE IF NOT EXISTS chunks (chunk_uid TEXT);
CREATE TABLE IF NOT EXISTS field_notes (id INTEGER PRIMARY KEY, author TEXT, body TEXT);
`;
const OWNER_SQL = "ALTER TABLE field_notes ADD COLUMN reviewed_by TEXT;\n";
const LABELS_SQL = "ALTER TABLE field_notes ADD COLUMN label TEXT;\n";

function migrationDir(name, files) {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, sql] of Object.entries(files)) writeFileSync(join(dir, file), sql);
  return dir;
}

const healthyDir = migrationDir("healthy", {
  "0001_field_notes.sql": BASE_SQL,
  "0002_add_reviewer.sql": OWNER_SQL,
});
const collisionDir = migrationDir("collision", {
  "0001_field_notes.sql": BASE_SQL,
  "0002_add_reviewer.sql": OWNER_SQL,
  "0002_add_labels.sql": LABELS_SQL,
});
const gapDir = migrationDir("gap", {
  "0001_field_notes.sql": BASE_SQL,
  "0002_add_reviewer.sql": OWNER_SQL,
  "0004_add_labels.sql": LABELS_SQL,
});
const zeroDir = migrationDir("zero-start", {
  "0000_field_notes.sql": BASE_SQL,
  "0001_add_reviewer.sql": OWNER_SQL,
});

const refusal = (fn) => {
  try {
    const value = fn();
    return { refused: false, value, message: "" };
  } catch (error) {
    return { refused: true, value: null, message: String(error?.message || error) };
  }
};

/* ---- the arrangement guards, straight against loadMigrations ---- */

{
  const healthy = refusal(() => loadMigrations(healthyDir));
  check("a clean arrangement loads without complaint",
    !healthy.refused && healthy.value.length === 2 &&
      healthy.value.map((m) => m.version).join(",") === "1,2",
    healthy.message);
}

{
  const outcome = refusal(() => loadMigrations(collisionDir));
  check("two files at one number are refused", outcome.refused, "loadMigrations returned normally");
  check("and the refusal names BOTH colliding files, not a position or a count",
    /0002_add_labels\.sql/.test(outcome.message) && /0002_add_reviewer\.sql/.test(outcome.message) &&
      /claim number 2/.test(outcome.message),
    outcome.message);
  check("and it says the refusal happened before any D1 statement",
    /before any D1 statement/.test(outcome.message), outcome.message);
}

{
  const outcome = refusal(() => loadMigrations(gapDir));
  check("a numbering gap is refused", outcome.refused, "loadMigrations returned normally");
  check("and the gap refusal names the file on each side of the hole",
    /expected 3 next/.test(outcome.message) && /after 0002_add_reviewer\.sql/.test(outcome.message) &&
      /0004_add_labels\.sql/.test(outcome.message),
    outcome.message);
}

{
  const outcome = refusal(() => loadMigrations(zeroDir));
  check("numbering that does not start at 1 is refused, naming the offending file",
    outcome.refused && /counting starts at 1/.test(outcome.message) &&
      /0000_field_notes\.sql/.test(outcome.message),
    outcome.message);
}

// The guard must not fire on the package as it actually ships.
{
  const shipped = refusal(() => loadMigrations());
  check("the repo's real migrations still satisfy their own runtime guard",
    !shipped.refused && shipped.value.length >= 22 &&
      shipped.value.every((m, i) => m.version === i + 1),
    shipped.message);
}

/* ---- the same guards through cmdMigrate, proving nothing touched D1 ---- */

const manifestPath = join(sandbox, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "guard-fixture" },
  brain: { version: "0.1.22", ring: "test" },
  infrastructure: { cloudflare: {
    account_id: "fixture-account",
    d1_database_id: "fixture-database",
    storage: "d1",
  } },
  safety: { credential_scanner: { gate_version: 0 } },
}));

const runMigrate = async (dir, d1Query) => {
  try {
    const result = await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query,
      loadMigrations: () => loadMigrations(dir),
    });
    return { ok: true, result, error: "" };
  } catch (error) {
    return { ok: false, result: null, error: String(error?.message || error) };
  }
};

{
  const statements = [];
  const outcome = await runMigrate(collisionDir, async (_a, _d, sql) => {
    statements.push(sql);
    return { results: [] };
  });
  check("cmdMigrate refuses the colliding package outright",
    outcome.ok === false && /claim number 2/.test(outcome.error), outcome.error);
  check("and the collision refusal really ran before ANY D1 statement",
    statements.length === 0, JSON.stringify(statements));
}

/* ---- appliedVersions: an outage is not an empty ledger ---- */

{
  const statements = [];
  const outcome = await runMigrate(healthyDir, async (_a, _d, sql) => {
    statements.push(sql);
    if (/FROM schema_migrations/.test(sql)) {
      throw new Error("D1 is unavailable: connection reset mid-flight");
    }
    return { results: [] };
  });
  check("a D1 outage while reading the ledger stops the migration",
    outcome.ok === false, "cmdMigrate proceeded through an unreadable ledger");
  check("and the refusal says what an empty-ledger lie would have cost",
    /schema_migrations ledger could not be read/.test(outcome.error) &&
      /bypass the applied-checksum guard/.test(outcome.error) &&
      /connection reset mid-flight/.test(outcome.error),
    outcome.error);
  check("and no migration statement ran after the failed read",
    statements.length === 1 && /FROM schema_migrations/.test(statements[0]),
    JSON.stringify(statements));
}

// The counter-case: a database that has GENUINELY never been migrated reports
// "no such table" for the ledger, and that one failure must keep meaning
// empty, or every fresh install dies on its first migrate.
{
  const db = new DatabaseSync(":memory:");
  const adapter = async (_a, _d, sql, params = []) => {
    const text = String(sql).trim();
    if (/^(?:SELECT|PRAGMA)\b/i.test(text)) return { results: db.prepare(sql).all(...params) };
    let result = null;
    if (params.length) result = db.prepare(sql).run(...params);
    else db.exec(sql);
    return { results: [], meta: { changes: Number(result?.changes || 0) } };
  };
  const outcome = await runMigrate(healthyDir, adapter);
  const ledger = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
  check("a genuinely fresh database still migrates from nothing",
    outcome.ok === true && ledger.length === 2 && ledger[1].name === "0002_add_reviewer",
    outcome.error || JSON.stringify(ledger));
  const reviewed = db.prepare("SELECT COUNT(*) n FROM pragma_table_info('field_notes') WHERE name = 'reviewed_by'").get().n;
  check("and its migrations actually executed, not merely receipted", reviewed === 1, String(reviewed));
  db.close();
}

rmSync(sandbox, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILURES` : `\nruntime migration guards: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
