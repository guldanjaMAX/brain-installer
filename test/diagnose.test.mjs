// The post-install diagnostic, tested against a REAL SQLite database with each
// defect deliberately seeded.
//
// This runs the actual SQL rather than a fake, because the whole value of this
// command is in the queries. A mocked DB would happily return whatever the test
// wanted and prove only that the JavaScript around it runs.
//
// Every failure this product has had was silent, and this is the command whose
// job is to end that. So each case below seeds one real defect and asserts it is
// both CAUGHT and explained.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

const MIG = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const RELIABILITY_MIG = fileURLToPath(
  new URL("../migrations/pending/operational_reliability_v021.sql", import.meta.url),
);

// A D1-shaped facade over real SQLite, so diagnose() runs unmodified.
function makeEnv({ vectorCount = null } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIG, f), "utf-8"));
  }
  // This branch deliberately keeps its schema unnumbered until 0023-0028
  // freeze. Load that exact pending schema for the feature-level diagnostic.
  db.exec(readFileSync(RELIABILITY_MIG, "utf-8"));
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 11, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();
  const env = {
    _db: db,
    DB: {
      prepare(sql) {
        const mk = (params = []) => ({
          bind: (...p) => mk(p),
          first: async () => db.prepare(sql).get(...params) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          run: async () => db.prepare(sql).run(...params),
        });
        return mk();
      },
    },
  };
  if (vectorCount !== null) env.VECTORIZE = { describe: async () => ({ vectorCount }) };
  return env;
}

const doc = (db, id, opts = {}) =>
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, uri, document_date, ingested_at, content_hash)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, opts.source ?? "documents", id, opts.title ?? `Doc ${id}`, opts.uri ?? `/${id}.md`,
        opts.date === undefined ? Date.now() : opts.date, Date.now(), opts.hash ?? `h-${id}`);

let _ix = 0;
const chunk = (db, uid, docUid, text = "some text", ix = null) =>
  db.prepare(`INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source) VALUES (?,?,?,?,?)`)
    .run(uid, docUid, ix === null ? _ix++ : ix, text, "documents");

const source = (db, name) =>
  db.prepare(`INSERT INTO sources (name, kind, status, created_at) VALUES (?,?,?,?)`)
    .run(name, "upload", "ready", new Date().toISOString());

const find = (r, id) => (r.findings || []).find((f) => f.id === id);

/* ---- OCR coverage is reported, because the reader deserves to know how much
       of the corpus a machine read off a picture ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents");
  for (const i of [1, 2, 3]) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  env._db.prepare("UPDATE documents SET text_source='ocr', text_reliable=0 WHERE doc_uid='d1'").run();
  env._db.prepare("UPDATE documents SET text_source='ocr_partial', text_reliable=0 WHERE doc_uid='d2'").run();
  const r = await diagnose(env);
  const f = find(r, "ocr_coverage");
  check("OCR-read documents are counted and reported", f?.count === 2, JSON.stringify(f));
  check("and a half-read one is called out separately",
    /pages that could not be read/.test(f?.detail || ""), f?.detail);
  check("it is information, not a defect, so a scanned corpus is not called unhealthy",
    f?.severity === "info" && r.verdict === "healthy", `${f?.severity} / ${r.verdict}`);
}

/* ---- a clean install reports clean ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents");
  for (const i of [1, 2, 3]) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const r = await diagnose(env);
  check("a healthy corpus returns verdict healthy", r.verdict === "healthy", JSON.stringify(r.summary) + " " + JSON.stringify((r.findings||[]).map(f=>f.id)));
  check("and reports the right totals", r.totals.documents === 3 && r.totals.chunks === 3, JSON.stringify(r.totals));
  check("and says the two stores agree", find(r, "store_agreement")?.severity === "ok");
}

/* ---- THE ONE THAT WOULD HAVE CAUGHT THE FIELD STALL ---- */
{
  const env = makeEnv({ vectorCount: 100 });   // Vectorize holds 100
  source(env._db, "documents");
  for (let i = 0; i < 1001; i++) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const r = await diagnose(env);               // D1 holds 1001, nothing queued
  const f = find(r, "store_agreement");
  check("1001 chunks against 100 vectors is CAUGHT", f?.severity === "crit", JSON.stringify(f));
  check("and the drift is stated exactly", f?.count === 901, JSON.stringify(f?.count));
  check("and it says the missing ones are invisible to meaning search", /invisible to meaning/i.test(f?.detail || ""), f?.detail);
  check("and it names the command that repairs it", /brain reindex/.test(f?.action || ""), f?.action);
  check("the overall verdict is problems", r.verdict === "problems", r.verdict);
}

/* ---- vectors left behind by deletions ---- */
{
  const env = makeEnv({ vectorCount: 500 });
  source(env._db, "documents");
  for (let i = 0; i < 10; i++) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const f = find(await diagnose(env), "store_agreement");
  check("MORE vectors than chunks is also caught", f?.severity === "crit", JSON.stringify(f));
  check("and is described as leftovers competing for slots", /compete for retrieval slots/i.test(f?.detail || ""), f?.detail);
}

/* ---- a scanned PDF that indexed as nothing ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents");
  doc(env._db, "good"); chunk(env._db, "good#0", "good");
  doc(env._db, "scan", { title: "Bank statement scan.pdf" });   // no chunks
  const r = await diagnose(env);
  const f = find(r, "empty_documents");
  check("a document with no text is caught", f?.severity === "crit" && f.count === 1, JSON.stringify(f));
  check("and it is named, so the client can go look at it", (f?.samples || []).some((s) => /Bank statement/.test(s)), JSON.stringify(f?.samples));
  check("and the explanation is the one that matters", /can never answer from them/i.test(f?.detail || ""), f?.detail);
}

/* ---- documents nothing owns, which forget cannot remove ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  doc(env._db, "orph", { source: "mystery" }); chunk(env._db, "orph#0", "orph");
  const f = find(await diagnose(env), "unregistered_source");
  check("documents under an unregistered source are caught", f?.severity === "warn", JSON.stringify(f));
  check("and it says forget cannot remove them", /forget` cannot remove/i.test(f?.detail || ""), f?.detail);
}

/* ---- a source that promises coverage it does not have ---- */
{
  const env = makeEnv({ vectorCount: 0 });
  source(env._db, "gmail");
  const f = find(await diagnose(env), "empty_source");
  check("a registered source holding nothing is caught", f?.severity === "warn", JSON.stringify(f));
}

/* ---- chunks whose document is gone ---- */
{
  // The schema has a real foreign key here, so this state cannot be reached
  // through the normal path. That is worth knowing and worth asserting. The
  // check stays because a future writer that bypasses the constraint, or a
  // restore that lands the two tables out of step, would produce exactly this.
  const guard = makeEnv({ vectorCount: 1 });
  source(guard._db, "documents");
  let blocked = null;
  try { chunk(guard._db, "ghost#0", "no-such-doc"); } catch (e) { blocked = e.message; }
  check("the schema PREVENTS an orphan chunk in the first place", /FOREIGN KEY/i.test(blocked || ""), blocked);

  const env = makeEnv({ vectorCount: 1 });
  env._db.exec("PRAGMA foreign_keys = OFF");
  source(env._db, "documents");
  chunk(env._db, "ghost#0", "no-such-doc");
  const f = find(await diagnose(env), "orphan_chunks");
  check("and if one ever does appear, it is caught", f?.severity === "crit" && f.count === 1, JSON.stringify(f));
}

/* ---- the same folder loaded twice ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents"); source(env._db, "documents-again");
  doc(env._db, "a", { hash: "same" }); chunk(env._db, "a#0", "a");
  doc(env._db, "b", { hash: "same", source: "documents-again" }); chunk(env._db, "b#0", "b");
  doc(env._db, "c", { hash: "other" }); chunk(env._db, "c#0", "c");
  const f = find(await diagnose(env), "duplicate_documents");
  check("the same content stored twice is caught", f?.count === 1, JSON.stringify(f));
}

/* ---- duplicate document totals must never be capped by the sample limit ---- */
{
  const env = makeEnv({ vectorCount: 30 });
  source(env._db, "documents");
  for (let group = 0; group < 15; group++) {
    for (let copy = 0; copy < 2; copy++) {
      const id = `g${group}-copy${copy}`;
      doc(env._db, id, { hash: `shared-${group}` });
      chunk(env._db, `${id}#0`, id);
    }
  }
  const f = find(await diagnose(env, { sampleLimit: 3 }), "duplicate_documents");
  check("duplicate document count covers every group even with a small sample limit",
    f?.count === 15 && /15 exact-content group/.test(f?.detail || ""), JSON.stringify(f));
}

/* ---- the spreadsheet that eats the corpus ---- */
{
  const env = makeEnv({ vectorCount: 60 });
  source(env._db, "documents");
  doc(env._db, "sheet", { title: "Transactions 2026.xlsx" });
  for (let i = 0; i < 50; i++) chunk(env._db, `sheet#${i}`, "sheet", "row text", i);
  for (let i = 0; i < 10; i++) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`); }
  const f = find(await diagnose(env), "chunk_outliers");
  check("one document dominating the corpus is caught", f?.severity === "warn" && f.count === 50, JSON.stringify(f));
  check("and the offender is named", (f?.samples || []).some((s) => /Transactions 2026/.test(s)), JSON.stringify(f?.samples));
}

/* ---- text that is silently truncated before embedding ---- */
{
  const env = makeEnv({ vectorCount: 3 });
  source(env._db, "documents");
  for (const i of [1, 2, 3]) { doc(env._db, `d${i}`); chunk(env._db, `d${i}#0`, `d${i}`, "x".repeat(3000)); }
  const f = find(await diagnose(env), "oversized_chunks");
  check("chunks past the embedding ceiling are caught", f?.count === 3, JSON.stringify(f));
  check("and the consequence is stated, not just the count", /never searchable by meaning/i.test(f?.detail || ""), f?.detail);
}

/* ---- duplicate chunk measurement is exact only inside its safe budget ---- */
{
  const env = makeEnv({ vectorCount: 24 });
  source(env._db, "documents");
  for (let i = 0; i < 24; i++) {
    doc(env._db, `d${i}`);
    chunk(env._db, `d${i}#0`, `d${i}`, `repeated-${i % 12}`);
  }
  const measured = find(await diagnose(env), "duplicate_chunks");
  check("duplicate chunk groups are measured inside the safe scan budget",
    measured?.count === 12 && measured?.observable !== false, JSON.stringify(measured));

  const bounded = find(await diagnose(env, { duplicateChunkScanLimit: 10 }), "duplicate_chunks");
  check("large-corpus duplicate chunk checks report not observable instead of a failed warning",
    bounded?.severity === "info" && bounded?.observable === false && bounded?.area === "efficiency",
    JSON.stringify(bounded));
}

/* ---- undated documents: warn only when it distorts recency ---- */
{
  const env = makeEnv({ vectorCount: 2 });
  source(env._db, "documents");
  doc(env._db, "d1", { date: null }); chunk(env._db, "d1#0", "d1");
  doc(env._db, "d2"); chunk(env._db, "d2#0", "d2");
  check("half the corpus undated is a warning", find(await diagnose(env), "undated")?.severity === "warn");

  const env2 = makeEnv({ vectorCount: 10 });
  source(env2._db, "documents");
  doc(env2._db, "u", { date: null }); chunk(env2._db, "u#0", "u");
  for (let i = 0; i < 9; i++) { doc(env2._db, `k${i}`); chunk(env2._db, `k${i}#0`, `k${i}`); }
  check("one in ten undated is only information, not a warning",
    find(await diagnose(env2), "undated")?.severity === "info");
}

/* ---- a stalled queue, which is the failure that started all of this ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  doc(env._db, "d2"); chunk(env._db, "d2#0", "d2");
  env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?,?,?,?)")
    .run("d2#0", "upsert", Date.now() - 90 * 60000, 0);
  const r = await diagnose(env);
  const f = find(r, "backlog");
  check("a backlog older than 30 minutes is CRITICAL, not informational", f?.severity === "crit", JSON.stringify(f));
  check("and it names brain drain", /brain drain/.test(f?.action || ""), f?.action);
  check("a stalled queue says the drain is NOT running", /NOT running/.test(f?.detail || ""), f?.detail);
}

/* ---- behind is not stalled: the distinction a bulk backfill exposed ----
   The drain ran on its trigger the whole time while this check told the
   operator it was not running. The lease dates the last pass; the newest
   queued row shows whether a producer is still feeding the queue. */
{
  const leaseTakenMinutesAgo = (m) => Date.now() - m * 60000 + 20 * 60 * 1000;
  const seedBacklog = (env, { newestMinutesAgo }) => {
    source(env._db, "documents");
    doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
    doc(env._db, "d2"); chunk(env._db, "d2#0", "d2");
    env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?,?,?,?)")
      .run("d1#0", "upsert", Date.now() - 90 * 60000, 0);
    env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts) VALUES (?,?,?,?)")
      .run("d2#0", "upsert", Date.now() - newestMinutesAgo * 60000, 0);
    env._db.prepare("UPDATE install_state SET vector_drain_lease_expires_at = ? WHERE id = 1")
      .run(leaseTakenMinutesAgo(2));
  };

  const loading = makeEnv({ vectorCount: 1 });
  seedBacklog(loading, { newestMinutesAgo: 1 });
  const whileLoading = find(await diagnose(loading), "backlog");
  check("a running drain with documents still arriving is BEHIND, not stalled",
    whileLoading?.severity === "warn" && /behind rather than stalled/.test(whileLoading?.detail || ""),
    JSON.stringify(whileLoading));
  check("and it never claims the drain is not running",
    !/NOT running/.test(whileLoading?.detail || ""), whileLoading?.detail);
  check("and it says to let the load finish first",
    /Let the load finish/.test(whileLoading?.action || ""), whileLoading?.action);

  const catchingUp = makeEnv({ vectorCount: 1 });
  seedBacklog(catchingUp, { newestMinutesAgo: 45 });
  const afterLoad = find(await diagnose(catchingUp), "backlog");
  check("a running drain with nothing arriving is working through the backlog",
    afterLoad?.severity === "warn" && /working through this backlog/.test(afterLoad?.detail || ""),
    JSON.stringify(afterLoad));
  check("and every one of these reports dates the last drain pass",
    /last pass \d+ min ago/.test(afterLoad?.detail || ""), afterLoad?.detail);
}

/* ---- chunks that failed to embed and were set aside ---- */
{
  const env = makeEnv({ vectorCount: 1 });
  source(env._db, "documents");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  env._db.prepare("INSERT INTO vector_outbox (chunk_uid, op, queued_at, attempts, last_error) VALUES (?,?,?,?,?)")
    .run("d1#0", "upsert", Date.now(), 3, "id too long; max is 64 bytes, got 67 bytes");
  env._db.prepare(
    `INSERT INTO vector_outbox_retry_state
       (chunk_uid,generation,attempts,next_attempt_at,last_attempt_at,quarantined_at,failure_code,last_error)
     SELECT chunk_uid,generation,5,?,?,?,'embedding_failure',?
       FROM vector_outbox WHERE chunk_uid=?`,
  ).run(Date.now(), Date.now(), Date.now(), "id too long; max is 64 bytes, got 67 bytes", "d1#0");
  const f = find(await diagnose(env), "quarantined");
  check("quarantined chunks are caught", f?.severity === "crit" && f.count === 1, JSON.stringify(f));
  check("and the real error is shown verbatim", (f?.samples || []).some((s) => /64 bytes/.test(s)), JSON.stringify(f?.samples));
}

/* ---- it must degrade rather than explode ---- */
{
  const env = makeEnv();               // no VECTORIZE binding at all
  source(env._db, "documents");
  doc(env._db, "d1"); chunk(env._db, "d1#0", "d1");
  let threw = null, r = null;
  try { r = await diagnose(env); } catch (e) { threw = e.message; }
  check("no Vectorize binding does not throw", threw === null, `threw: ${threw}`);
  check("and it says the comparison could not be made rather than passing it",
    find(r, "store_agreement")?.severity === "info", JSON.stringify(find(r, "store_agreement")));
}

console.log(`\ndiagnose: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
