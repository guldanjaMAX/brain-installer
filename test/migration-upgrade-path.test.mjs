// An installed brain must be able to migrate forward from what it actually has.
//
// Every other migration test starts from an empty database and applies the
// whole set in order. That proves a fresh INSTALL works. It proves nothing
// about an UPGRADE, because the SQL then runs against tables that already
// exist and rows that are already in them.
//
// Clients are on migration 22. This line ships 32. Nobody had ever executed
// that jump anywhere before this test: not on a brain, not in CI. It walks
// the real published prefix, puts representative rows in, applies the rest
// exactly the way cmdMigrate does, and checks the result is a schema the
// worker can actually use.
//
// Add a migration and this test covers it automatically: PUBLISHED_PREFIX is
// the boundary of what is already in the field, and everything after it is
// the upgrade under test.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

// The highest migration any client brain has applied. v0.2.0 and v0.2.3 both
// ship exactly these.
const PUBLISHED_PREFIX = 22;

const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const migrations = readdirSync(dir)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort()
  .map((f) => {
    const sql = readFileSync(join(dir, f), "utf-8");
    return {
      version: parseInt(f.split("_")[0], 10),
      name: f.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  });

const apply = (db, migration) => {
  for (const statement of splitStatements(migration.sql)) db.exec(statement);
  db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)"
  ).run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
};

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);

// --- Stand up a brain exactly as a client has it today ---------------------
const prefix = migrations.filter((m) => m.version <= PUBLISHED_PREFIX);
const rest = migrations.filter((m) => m.version > PUBLISHED_PREFIX);
for (const migration of prefix) apply(db, migration);

check(`a client brain stands up at migration ${PUBLISHED_PREFIX}`,
  db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === PUBLISHED_PREFIX);
check("there is an upgrade to actually test", rest.length > 0, `${rest.length} migrations past the prefix`);

// --- Representative data, so the upgrade runs over rows and not just tables -
db.prepare(
  `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
   VALUES (1, 'upgrade-fixture', '0.2.3', ?, 0, '2026-09-01T00:00:00Z', 'stable')`
).run(PUBLISHED_PREFIX);
db.prepare(
  `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
   VALUES ('drive:doc', 'drive', 'doc', 'A document', ?, 'hash:doc')`
).run(Date.now());
db.prepare(
  `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
   VALUES ('drive:doc#0', 'drive:doc', 0, 'some client text', 'drive', 'drive:doc#0')`
).run();
const rowsBefore = {
  install: db.prepare("SELECT count(*) AS n FROM install_state").get().n,
  documents: db.prepare("SELECT count(*) AS n FROM documents").get().n,
  chunks: db.prepare("SELECT count(*) AS n FROM chunks").get().n,
};

// --- The upgrade itself ----------------------------------------------------
let upgradeError = null;
try {
  for (const migration of rest) apply(db, migration);
} catch (error) {
  upgradeError = error;
}
check(`migrations ${PUBLISHED_PREFIX + 1} to ${migrations.at(-1).version} apply over a populated brain`,
  upgradeError === null, upgradeError && String(upgradeError.message || upgradeError));

check("the ledger reaches the full set",
  db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n === migrations.length);

// --- The client's own data survived ----------------------------------------
check("the client's rows are untouched by the upgrade",
  db.prepare("SELECT count(*) AS n FROM install_state").get().n === rowsBefore.install &&
  db.prepare("SELECT count(*) AS n FROM documents").get().n === rowsBefore.documents &&
  db.prepare("SELECT count(*) AS n FROM chunks").get().n === rowsBefore.chunks);

// --- Every table and column the new migrations promise actually exists ------
const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);
const declared = [];
for (const migration of rest) {
  for (const m of migration.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["'`]?(\w+)["'`]?/gi)) {
    declared.push([migration.name, m[1]]);
  }
}
const missingTables = declared.filter(([, table]) => !tables.has(table));
check(`every table the upgrade declares exists afterwards (${declared.length} checked)`,
  missingTables.length === 0, JSON.stringify(missingTables));

const addedColumns = [];
for (const migration of rest) {
  for (const m of migration.sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+ADD COLUMN\s+["'`]?(\w+)["'`]?/gi)) {
    addedColumns.push([migration.name, m[1], m[2]]);
  }
}
const missingColumns = addedColumns.filter(([, table, column]) => {
  if (!tables.has(table)) return true;
  return !db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
});
check(`every column the upgrade adds exists afterwards (${addedColumns.length} checked)`,
  missingColumns.length === 0, JSON.stringify(missingColumns));

// --- A fresh install and an upgraded brain must end up the same -------------
const fresh = new DatabaseSync(":memory:");
fresh.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
for (const migration of migrations) apply(fresh, migration);

const shapeOf = (handle) => handle.prepare(
  "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);
const upgradedShape = shapeOf(db);
const freshShape = shapeOf(fresh);
const onlyFresh = freshShape.filter((n) => !upgradedShape.includes(n));
const onlyUpgraded = upgradedShape.filter((n) => !freshShape.includes(n));
check("an upgraded brain has the same schema as a fresh install",
  onlyFresh.length === 0 && onlyUpgraded.length === 0,
  `missing after upgrade: ${JSON.stringify(onlyFresh)}; extra: ${JSON.stringify(onlyUpgraded)}`);

for (const table of ["install_state", "chunks", "documents", "vector_outbox"]) {
  const cols = (handle) => handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();
  const a = cols(db).join(","), b = cols(fresh).join(",");
  check(`${table} has identical columns whether upgraded or freshly installed`, a === b,
    `upgraded=${a}\n         fresh=${b}`);
}

console.log(`\nmigration upgrade path (${PUBLISHED_PREFIX} to ${migrations.at(-1).version}): ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
