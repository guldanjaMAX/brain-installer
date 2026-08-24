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
import worker from "../worker/src/index.js";

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

for (const table of ["documents", "chunks"]) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const column of ["client", "category", "top_folder", "platform", "document_date"]) {
    check(`${table}.${column} exists for the retrieval filter contract`, columns.has(column), [...columns].join(", "));
  }
}
for (const index of ["idx_chunks_category", "idx_chunks_top_folder", "idx_chunks_platform"]) {
  check(`${index} exists`, names.has(index), "filtered hydration would otherwise scan the chunk table");
}
check("vector_outbox retains vector_id after a chunk row is gone",
  new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name)).has("vector_id"));

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

/* ---- source lifecycle SQL is executed, not merely inspected by a mock ---- */
{
  const d1 = {
    prepare(sql) {
      const statement = (params = []) => ({
        bind: (...next) => statement(next),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => db.prepare(sql).run(...params),
      });
      return statement();
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = { STORAGE: "d1", ADMIN_KEY: "k", DB: d1 };
  const post = (body) => worker.fetch(new Request("https://brain.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, {});

  const insertDoc = db.prepare(
    `INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta)
     VALUES (?,?,?,?,?,?,?)`
  );
  insertDoc.run("drive:big#part1of2", "drive", "big#part1of2", "Big 1", 1, "h1", JSON.stringify({ part_of: "big" }));
  insertDoc.run("drive:big#part2of2", "drive", "big#part2of2", "Big 2", 1, "h2", JSON.stringify({ part_of: "big" }));
  insertDoc.run("drive:small", "drive", "small", "Small", 1, "h3", "{}");

  const oldStart = new Date(Date.now() - 7 * 3600000).toISOString();
  const opened = await (await post({
    source: "drive", kind: "drive", status: "indexing", run_id: "real_run_1",
    lane: "sweep", started_at: oldStart,
  })).json();
  check("real SQLite accepts an indexing source receipt", opened.status === "indexing", JSON.stringify(opened));

  const stuck = await (await worker.fetch(new Request("https://brain.example/api/admin/brain/freshness", {
    headers: { "X-Admin-Key": "k" },
  }), env, {})).json();
  check("the real sync_runs join detects a seven-hour stuck run",
    stuck.sources?.[0]?.state === "broken" && /7 hour/.test(stuck.sources[0].reason || ""), JSON.stringify(stuck));

  const ready = await (await post({
    source: "drive", kind: "drive", status: "ready", run_id: "real_run_1",
    lane: "sweep", started_at: oldStart, complete_sweep: true,
  })).json();
  check("a real completion counts one split family as one logical document",
    ready.documents === 2 && ready.stored_documents === 3, JSON.stringify(ready));
  const successfulAt = db.prepare("SELECT last_ingest_at FROM sources WHERE name='drive'").get().last_ingest_at;

  await post({ source: "drive", kind: "drive", status: "indexing", run_id: "real_run_2", lane: "incremental" });
  const failed = await (await post({
    source: "drive", kind: "drive", status: "error", run_id: "real_run_2",
    lane: "incremental", error: "Drive API unavailable",
  })).json();
  const failedSource = db.prepare("SELECT status,last_ingest_at,stale_reason,document_count FROM sources WHERE name='drive'").get();
  check("a real failed receipt is stored as an error without advancing last success",
    failed.status === "error" && failedSource.status === "error" && failedSource.last_ingest_at === successfulAt,
    JSON.stringify({ failed, failedSource, successfulAt }));
  check("the real source registry keeps the logical count and failure reason",
    failedSource.document_count === 2 && /Drive API unavailable/.test(failedSource.stale_reason || ""), JSON.stringify(failedSource));
}

console.log(fail ? `\n${fail} FAILURES` : `\nmigrations: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
