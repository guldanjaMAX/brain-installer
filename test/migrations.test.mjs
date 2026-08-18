/**
 * Migrations, against a REAL SQLite database.
 *
 * This file exists because 0004 shipped broken and nothing noticed. The store
 * tests use hand-rolled `{DB:{prepare}}` mocks, so no test had ever executed a
 * migration file, and the splitter shredded the FTS5 triggers into invalid SQL.
 * A mock cannot catch that. Only running the SQL can.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations", "d1");

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300))); if (!c) fail++; };

/* ---- the splitter, on the shapes that actually broke ---- */
{
  const one = splitStatements("CREATE TABLE a (x INT); CREATE TABLE b (y INT);");
  check("plain DDL splits into two", one.length === 2, JSON.stringify(one));

  const trig = splitStatements(`
CREATE TRIGGER t AFTER INSERT ON a BEGIN
  INSERT INTO b(y) VALUES (new.x);
  INSERT INTO c(z) VALUES (new.x);
END;
CREATE TABLE d (w INT);`);
  check("a trigger with two body statements stays ONE statement", trig.length === 2, JSON.stringify(trig.map(t => t.slice(0, 40))));
  check("and it keeps its END", /END$/i.test(trig[0].trim()), trig[0]);
  check("the statement after the trigger survives", /CREATE TABLE d/i.test(trig[1]), trig[1]);

  const str = splitStatements("INSERT INTO a VALUES ('semi; colon'); SELECT 1;");
  check("a semicolon inside a string is not a boundary", str.length === 2, JSON.stringify(str));

  const esc = splitStatements("INSERT INTO a VALUES ('it''s; fine'); SELECT 2;");
  check("an escaped quote does not desync the scanner", esc.length === 2, JSON.stringify(esc));

  check("comments are stripped", !splitStatements("-- drop; everything\nSELECT 1;").join("").includes("drop"));

  // An unterminated trigger must surface, not vanish. Swallowing it would make a
  // broken migration look like it applied.
  check("an unterminated trigger is emitted, not dropped",
    splitStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1);").length === 1);
}

/* ---- every migration, applied for real, in order ---- */
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
check("migration files were found", files.length > 0, DIR);

const db = new DatabaseSync(":memory:");
let applied = 0;
for (const f of files) {
  const stmts = splitStatements(readFileSync(join(DIR, f), "utf-8"));
  for (const st of stmts) {
    try { db.exec(st); applied++; }
    catch (e) { check(`${f} applies cleanly`, false, `${e.message} :: ${st.slice(0, 120)}`); }
  }
}
check(`all ${applied} statements across ${files.length} files applied`, true);

/* ---- the objects the worker hard-depends on must exist ---- */
const names = new Set(db.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
for (const t of ["documents", "chunks", "chunks_fts", "vector_outbox", "corpus_stats", "schema_migrations", "install_state"]) {
  check(`${t} exists`, names.has(t), [...names].join(", "));
}
for (const t of ["chunks_ai", "chunks_ad", "chunks_au"]) {
  check(`trigger ${t} exists`, names.has(t), "MISSING — keyword search would silently return nothing forever");
}

/* ---- and the triggers must actually keep the FTS index in step ---- */
{
  db.exec(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
           VALUES ('m:1','meeting','1','T',1,'h')`);
  db.exec(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
           VALUES ('m:1#0','m:1',0,'the retainer was deferred','meeting','T')`);
  const hit = (q) => db.prepare("SELECT c.chunk_uid FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ?").all(q);
  check("insert trigger populates the FTS index", hit('"retainer"').length === 1);
  check("porter stemming is active (defer -> deferred)", hit('"defer"').length === 1);

  db.exec("UPDATE chunks SET text='the retainer was increased' WHERE chunk_uid='m:1#0'");
  check("update trigger leaves no stale ghost", hit('"deferred"').length === 0);
  check("and indexes the new text", hit('"increased"').length === 1);

  db.exec("DELETE FROM chunks WHERE chunk_uid='m:1#0'");
  check("delete trigger removes it from the index", hit('"increased"').length === 0);
}

console.log(fail ? `\n${fail} FAILURES` : `\nmigrations: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
