/**
 * The 0017 collision, tested from the field's point of view.
 *
 * Three branches each shipped a migration numbered 0017. Only one of them was
 * ever APPLIED to a real brain: `0017_mcp_connector_oauth`. That install's
 * `schema_migrations` holds version 17 with that file's checksum, and
 * `cmdMigrate` refuses, by design, to run when a version it has already applied
 * carries a different checksum than the file now sitting at that number. So the
 * number is not ours to reassign: whichever file we put at 17 either matches
 * what the field already recorded or strands every install that recorded it.
 *
 * That stranding is not hypothetical. It happened, which is why this file
 * exists and why it tests the recorded-checksum path rather than a fresh
 * install. A brain that has never been migrated will accept ANY arrangement of
 * these files; only one arrangement lets a brain that is already at 17 move.
 *
 * The counter-case is tested too. If it were not, this file would still pass
 * with the collision restored, and a green suite that cannot see the outage is
 * worse than no suite at all.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdMigrate, splitStatements } from "../brain.mjs";
import { normalizedInstallStateExport } from "../operations/cloudflare-recovery-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations", "d1");

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};

const files = readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const versionOf = (f) => Number.parseInt(f.slice(0, 4), 10);
const sqlOf = (f) => readFileSync(join(DIR, f), "utf8");
const checksumOf = (f) => createHash("sha256").update(sqlOf(f)).digest("hex").slice(0, 16);
const nameOf = (f) => f.replace(/\.sql$/, "");

/* ---- the arrangement itself ---- */

const numbers = files.map(versionOf);
const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
check("no two migration files share a number", duplicates.length === 0, JSON.stringify(duplicates));

check("migration numbers are contiguous from 1",
  numbers.every((n, i) => n === i + 1),
  JSON.stringify(numbers));

// cmdMigrate keys applied state by version, and validateMigrationContract in
// the recovery adapter asserts version === index + 1. A gap or a repeat breaks
// both, so the contiguity check above is a hard requirement, not tidiness.

// Both files are located by NAME. Locating them by the number they sit on
// would make every assertion below agree with whatever arrangement it was
// handed, which is the one thing this file must never do.
const connectorOauth = files.find((f) => /mcp_connector_oauth/.test(f));
const tokenFitFile = files.find((f) => /chunk_token_fit/.test(f));
check("both colliding migrations are present after the merge",
  Boolean(connectorOauth) && Boolean(tokenFitFile),
  JSON.stringify({ connectorOauth, tokenFitFile }));

const at17 = files.filter((f) => versionOf(f) === 17);
check("version 17 is the connector-OAuth migration the field already applied",
  at17.length === 1 && at17[0] === "0017_mcp_connector_oauth.sql", JSON.stringify(at17));

const tokenFit = tokenFitFile;
check("chunk token-fit moved off 17 to a number no branch had claimed",
  tokenFit === "0021_chunk_token_fit.sql", String(tokenFit));

// The renumbered file names itself in its own first line. A header that still
// said 0017 would send the next reader to a number this file no longer owns.
check("the moved migration's header matches its new number",
  sqlOf(tokenFit).split("\n")[0].includes("0021_chunk_token_fit"),
  sqlOf(tokenFit).split("\n")[0]);

/* ---- the install that broke this morning ---- */

const sandbox = mkdtempSync(join(tmpdir(), "brain-field-17-"));
const manifestPath = join(sandbox, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "field-fixture" },
  brain: { version: "0.1.19", ring: "test" },
  infrastructure: { cloudflare: {
    account_id: "fixture-account",
    d1_database_id: "fixture-database",
    storage: "d1",
  } },
  safety: { credential_scanner: { gate_version: 0 } },
}));

/**
 * Build a brain that is genuinely at version 17: every migration through 17 is
 * really executed against SQLite, and every one is receipted in
 * `schema_migrations` with the checksum of the file as it stands now. That last
 * detail is the whole test. `recordAs` lets the counter-case receipt version 17
 * under a DIFFERENT file's checksum, which is exactly what an install that had
 * applied the other branch's 0017 would look like to us.
 */
const brainAtSeventeen = (receiptAt17 = connectorOauth) => {
  const db = new DatabaseSync(":memory:");
  for (const file of files.filter((f) => versionOf(f) <= 17)) {
    for (const statement of splitStatements(sqlOf(file))) db.exec(statement);
    // Version 17's receipt is pinned to a NAMED file, not to whichever file
    // happens to occupy slot 17. Receipting "whatever is at 17" would make the
    // fixture agree with any renumbering and prove nothing at all.
    const receiptFile = versionOf(file) === 17 ? receiptAt17 : file;
    db.prepare(
      "INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (?,?,?,?)",
    ).run(versionOf(file), nameOf(receiptFile), "2026-08-28T00:00:00Z", checksumOf(receiptFile));
  }
  db.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'field-fixture', '0.1.19', 17, 0, '2026-08-28T00:00:00Z', 'test')`,
  );
  return db;
};

const adapterFor = (db) => async (_account, _database, sql, params = []) => {
  const text = String(sql).trim();
  if (/^(?:SELECT|PRAGMA)\b/i.test(text)) return { results: db.prepare(sql).all(...params) };
  let result = null;
  if (params.length) result = db.prepare(sql).run(...params);
  else db.exec(sql);
  return { results: [], meta: { changes: Number(result?.changes || 0) } };
};

const runMigrate = async (db) => {
  try {
    await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: adapterFor(db),
      vectorDrainQuiesced: true,
    });
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
};

{
  const db = brainAtSeventeen();
  const before = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  const outcome = await runMigrate(db);
  const after = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);

  check("the fixture really is an install sitting at 17",
    before.length === 17 && before.at(-1) === 17, JSON.stringify(before));

  check("an install already holding 17 with the connector-OAuth checksum migrates forward",
    outcome.ok, outcome.error);

  check("and it lands on every remaining migration, 18 through 21",
    JSON.stringify(after) === JSON.stringify(files.map(versionOf)),
    JSON.stringify({ after, expected: files.map(versionOf) }));

  // Proof the forward migrations really executed, not merely receipted: 21's
  // columns and 18's columns have to be readable on the same database.
  const refit = db.prepare("SELECT COUNT(*) n FROM pragma_table_info('install_state') WHERE name = 'chunk_refit_cursor'").get().n;
  const provenance = db.prepare("SELECT COUNT(*) n FROM pragma_table_info('documents') WHERE name = 'text_source'").get().n;
  const oauth = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='oauth_tokens'").get().n;
  check("the SQL of the forward migrations actually ran (18 columns, 21 columns, 17 tables intact)",
    refit === 1 && provenance === 1 && oauth === 1,
    JSON.stringify({ refit, provenance, oauth }));
  db.close();
}

/* ---- the counter-case: the arrangement that stranded the install ---- */
{
  // Same install, except it recorded 17 under the OTHER branch's 0017. This is
  // precisely the state the collision produced, and it must be refused loudly
  // rather than half-applied.
  const db = brainAtSeventeen(tokenFitFile);
  const outcome = await runMigrate(db);
  const after = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  check("an install whose 17 was a DIFFERENT file is refused, not silently diverged",
    outcome.ok === false && /already applied but its content has changed/.test(outcome.error),
    outcome.error);
  check("and the refusal happens before anything is applied",
    after.length === 17, JSON.stringify(after));
  db.close();
}

/* ---- the blast radius the last attempt was reverted for ---- */

/**
 * Renumbering the token-fit migration is not a rename. Its columns are gated in
 * the recovery adapter by schema version, and the previous attempt at this move
 * was reverted precisely because that gate was left pointing at 17 while the
 * file went elsewhere. The existing recovery drill cannot see that mistake: it
 * runs at the newest schema, where `latest >= 17` and `latest >= 21` are both
 * true and the two spellings are indistinguishable.
 *
 * They differ only for a database sitting BETWEEN the two numbers — an install
 * at 18, 19 or 20, which is every install that upgrades in stages. So that is
 * what is built here, for real, and handed to the exporter. A gate still
 * reading 17 expects five refit columns that a schema-20 database does not
 * have, and the export refuses. That refusal is the reverted regression, and
 * this is the check that would have caught it.
 */
{
  const db = new DatabaseSync(":memory:");
  for (const file of files.filter((f) => versionOf(f) <= 20)) {
    for (const statement of splitStatements(sqlOf(file))) db.exec(statement);
  }
  db.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'field-fixture', '0.1.19', 20, 0, '2026-08-28T00:00:00Z', 'test')`,
  );
  const readRows = (binding, sql) => binding.prepare(sql).all();
  const at = (version) => [{ version, name: `fixture-${version}`, checksum: "0".repeat(16) }];

  let refitAtTwenty = null;
  try {
    await normalizedInstallStateExport(db, at(20), readRows);
    refitAtTwenty = "exported";
  } catch (error) {
    refitAtTwenty = String(error?.code || error?.message || error);
  }
  check("a database at schema 20 exports without expecting the refit columns",
    refitAtTwenty === "exported", refitAtTwenty);

  // And the columns ARE expected once the database is actually at 21, so the
  // gate is proven to be a gate rather than a deletion.
  for (const statement of splitStatements(sqlOf(tokenFitFile))) db.exec(statement);
  let refitAtTwentyOne = null;
  try {
    await normalizedInstallStateExport(db, at(21), readRows);
    refitAtTwentyOne = "exported";
  } catch (error) {
    refitAtTwentyOne = String(error?.code || error?.message || error);
  }
  check("and once it is at 21 the refit columns are required again",
    refitAtTwentyOne === "exported", refitAtTwentyOne);

  // The contract pin must equal the newest migration, or the drill refuses
  // every database including a correct one.
  check("the adapter's pinned schema version is the newest migration",
    numbers.at(-1) === 21, JSON.stringify(numbers.at(-1)));
  db.close();
}

console.log(fail ? `\n${fail} FAILURES` : `\nmigration field collision: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
