/**
 * Migrations, against a REAL SQLite database.
 *
 * This file exists because 0004 shipped broken and nothing noticed. The store
 * tests use hand-rolled `{DB:{prepare}}` mocks, so no test had ever executed a
 * migration file, and the splitter shredded the FTS5 triggers into invalid SQL.
 * A mock cannot catch that. Only running the SQL can.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdMigrate, runRestartSafeMigrationStatements, splitStatements } from "../brain.mjs";
import worker from "../worker/src/index.js";
import {
  acquireDrainLease,
  bootstrapVectorProjectionPage,
  releaseDrainLease,
  resetVectorProjectionBootstrap,
  VECTOR_BOOTSTRAP_PAGE_SIZE,
} from "../worker/src/lib/store-d1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations", "d1");
// The terminal schema version is whatever the newest migration file says, so
// adding 00NN never breaks a hardcoded pin here (found at 13 -> 14).
const LATEST_SCHEMA = Math.max(
  ...readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))),
);

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
for (const t of ["documents", "chunks", "chunks_fts", "vector_outbox", "vector_bootstrap_batches", "corpus_stats", "schema_migrations", "install_state"]) {
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
check("idx_documents_live_content_hash exists",
  names.has("idx_documents_live_content_hash"),
  "exact duplicate diagnosis would otherwise group an unindexed document table");
check("idx_vector_outbox_generation exists",
  names.has("idx_vector_outbox_generation"),
  "the durable generation clock must not scan an entire replay backlog per enqueue");
check("vector_outbox retains vector_id after a chunk row is gone",
  new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name)).has("vector_id"));
check("vector_outbox has a durable drain CAS generation",
  new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name)).has("generation"));
{
  const outboxColumns = new Set(db.prepare("PRAGMA table_info(vector_outbox)").all().map((r) => r.name));
  check("vector_outbox retains an accepted async mutation receipt",
    outboxColumns.has("submitted_mutation_id") && outboxColumns.has("submitted_at"));
  check("vector_outbox can join an exact row generation to one bootstrap batch",
    outboxColumns.has("bootstrap_epoch") && outboxColumns.has("bootstrap_batch"));
}
check("install_state owns the monotonic outbox clock",
  new Set(db.prepare("PRAGMA table_info(install_state)").all().map((r) => r.name)).has("outbox_generation"));
{
  const installColumns = new Set(db.prepare("PRAGMA table_info(install_state)").all().map((r) => r.name));
  check("install_state has an exclusive vector drain owner",
    installColumns.has("vector_drain_lease_owner"));
  check("the vector drain owner has a bounded crash expiry",
    installColumns.has("vector_drain_lease_expires_at"));
  check("install_state owns the latest Vectorize processing fence",
    installColumns.has("vector_projection_mutation_id") &&
      installColumns.has("vector_projection_submitted_at"));
  check("install_state owns the accelerated bootstrap protocol and verified base",
    installColumns.has("vector_projection_bootstrap_protocol") &&
      installColumns.has("vector_projection_bootstrap_base_count"));
}
for (const trigger of ["vector_outbox_generation_ai", "vector_outbox_generation_au"]) {
  check(`trigger ${trigger} exists`, names.has(trigger), "outbox generations could reuse a stale drain token");
}

/* ---- 0029 preserves Plaid readiness and destructive outcome certainty ---- */
{
  for (const [table, column] of [
    ["bank_feed_backfill", "provider_history_state"],
    ["plaid_sync_windows", "provider_history_state"],
    ["plaid_revocation_outbox", "outcome_state"],
  ]) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    check(`${table}.${column} exists`, columns.has(column), [...columns].join(", "));
  }

  const legacy = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => name < "0029_")) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) legacy.exec(statement);
  }
  legacy.exec(`
    INSERT INTO bank_feed_backfill
      (tenant_id,item_ref,requested_days,state,queued_at,finished_at)
    VALUES ('primary','legacy-complete',730,'complete','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
    INSERT INTO plaid_revocation_outbox
      (tenant_id,item_ref,state,attempts,next_attempt_at,requested_at,updated_at,confirmed_at)
    VALUES
      ('primary','legacy-confirmed','confirmed',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
      ('primary','legacy-unattempted','pending',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL),
      ('primary','legacy-ambiguous','retryable',2,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',NULL);
  `);
  for (const statement of splitStatements(
    readFileSync(join(DIR, "0029_plaid_provider_outcomes.sql"), "utf-8"),
  )) legacy.exec(statement);

  const legacyBackfill = legacy.prepare(
    "SELECT state,provider_history_state FROM bank_feed_backfill WHERE item_ref='legacy-complete'",
  ).get();
  check("a legacy complete backfill does not invent Plaid historical proof",
    legacyBackfill.state === "complete" &&
      legacyBackfill.provider_history_state === "TRANSACTIONS_UPDATE_STATUS_UNKNOWN",
    JSON.stringify(legacyBackfill));
  const legacyOutcomes = Object.fromEntries(legacy.prepare(
    "SELECT item_ref,outcome_state FROM plaid_revocation_outbox ORDER BY item_ref",
  ).all().map((row) => [row.item_ref, row.outcome_state]));
  check("legacy revocations distinguish confirmed, unattempted, and ambiguous outcomes",
    legacyOutcomes["legacy-confirmed"] === "confirmed" &&
      legacyOutcomes["legacy-unattempted"] === "not_attempted" &&
      legacyOutcomes["legacy-ambiguous"] === "unknown",
    JSON.stringify(legacyOutcomes));

  let invalidHistoryRefused = false;
  let invalidOutcomeRefused = false;
  try {
    legacy.prepare("UPDATE bank_feed_backfill SET provider_history_state='made_up'").run();
  } catch { invalidHistoryRefused = true; }
  try {
    legacy.prepare("UPDATE plaid_revocation_outbox SET outcome_state='maybe'").run();
  } catch { invalidOutcomeRefused = true; }
  check("Plaid provider history accepts only the reviewed readiness states", invalidHistoryRefused);
  check("Plaid removal outcomes accept only the reviewed certainty states", invalidOutcomeRefused);
  legacy.close();
}

/* queued_at is allowed to collide; the database-owned generation is not. */
{
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('race#0', 'race#0', 'upsert', 1000)`
  ).run();
  const firstGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'race#0'"
  ).get().generation;
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('race#0', 'race#0', 'upsert', 1000)
     ON CONFLICT(chunk_uid) DO UPDATE SET
       vector_id=excluded.vector_id, op=excluded.op, queued_at=excluded.queued_at`
  ).run();
  const secondGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'race#0'"
  ).get().generation;
  check("same-millisecond requeues receive a strictly newer generation",
    secondGeneration > firstGeneration, `${firstGeneration} -> ${secondGeneration}`);
  const staleDelete = db.prepare(
    "DELETE FROM vector_outbox WHERE chunk_uid = 'race#0' AND generation = ?"
  ).run(firstGeneration);
  check("a stale generation cannot clear the newly queued row",
    staleDelete.changes === 0 && db.prepare("SELECT count(*) n FROM vector_outbox WHERE chunk_uid = 'race#0'").get().n === 1);
  db.prepare("DELETE FROM vector_outbox WHERE chunk_uid = 'race#0'").run();
}

/* ---- real upgrade path: an existing backlog crosses 0009 -> 0012 ---- */
{
  const upgraded = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => name < "0010_")) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
      upgraded.exec(statement);
    }
  }
  upgraded.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'upgrade-fixture', '0.1.14', 9, 0, '2026-01-01T00:00:00Z', 'test');
     INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
     VALUES ('legacy#0', 'legacy#0', 'upsert', 1234, 2, 'retry me');`
  );
  for (const file of [
    "0010_vector_outbox_generation.sql",
    "0011_vector_drain_lease.sql",
    "0012_vector_visibility_receipts.sql",
  ]) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
      upgraded.exec(statement);
    }
  }
  upgraded.prepare("UPDATE install_state SET schema_version = 12 WHERE id = 1").run();

  const oldQueue = upgraded.prepare(
    `SELECT generation, attempts, last_error, submitted_mutation_id, submitted_at
       FROM vector_outbox WHERE chunk_uid = 'legacy#0'`
  ).get();
  const upgradedState = upgraded.prepare(
    `SELECT schema_version, outbox_generation,
            vector_drain_lease_owner owner, vector_drain_lease_expires_at expires,
            vector_projection_mutation_id mutation_id,
            vector_projection_submitted_at mutation_submitted_at
     FROM install_state WHERE id = 1`
  ).get();
  check("the real upgrade backfills a stable generation without losing retry state",
    oldQueue.generation > 0 && oldQueue.attempts === 2 && oldQueue.last_error === "retry me" &&
      oldQueue.submitted_mutation_id === null && oldQueue.submitted_at === null,
    JSON.stringify(oldQueue));
  check("the real upgrade starts with an unlocked lease and aligned generation clock",
    upgradedState.schema_version === 12 && upgradedState.outbox_generation >= oldQueue.generation &&
      upgradedState.owner === null && upgradedState.expires === null &&
      upgradedState.mutation_id === null && upgradedState.mutation_submitted_at === null,
    JSON.stringify(upgradedState));

  const upgradedEnv = {
    DB: {
      prepare(sql) {
        const shape = (params = []) => ({
          bind: (...next) => shape(next),
          run: async () => {
            const result = upgraded.prepare(sql).run(...params);
            return { meta: { changes: Number(result.changes || 0) } };
          },
          first: async () => upgraded.prepare(sql).get(...params) ?? null,
        });
        return shape();
      },
    },
  };
  const lease = await acquireDrainLease(upgradedEnv, {
    ownerToken: "upgraded-worker", now: 50_000, ttlMs: 5_000,
  });
  check("the deployed lease code operates against the actually upgraded schema",
    lease.acquired === true && await releaseDrainLease(upgradedEnv, "upgraded-worker") === true);
}

/* ---- 0010-0013 resume after every independently committed statement ---- */
{
  const restartStatements = [
    ...splitStatements(readFileSync(join(DIR, "0010_vector_outbox_generation.sql"), "utf-8")),
    ...splitStatements(readFileSync(join(DIR, "0011_vector_drain_lease.sql"), "utf-8")),
    ...splitStatements(readFileSync(join(DIR, "0012_vector_visibility_receipts.sql"), "utf-8")),
    ...splitStatements(readFileSync(join(DIR, "0013_accelerated_vector_bootstrap.sql"), "utf-8")),
  ];
  const makeLegacy = () => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0010_")) {
      for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
        candidate.exec(statement);
      }
    }
    candidate.exec(
      `INSERT INTO install_state
         (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
       VALUES (1, 'restart-fixture', '0.1.14', 9, 0, '2026-01-01T00:00:00Z', 'test');
       INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       VALUES ('restart#0', 'restart#0', 'upsert', 1234, 3, 'preserve me');`,
    );
    return candidate;
  };
  const queryFor = (candidate) => async (sql) => {
    if (/^PRAGMA\s+table_info/i.test(sql)) {
      return { results: candidate.prepare(sql).all() };
    }
    candidate.exec(sql);
    return { results: [] };
  };

  let everyResumePassed = true;
  let resumeDetail = "";
  for (let faultAfter = 0; faultAfter < restartStatements.length; faultAfter++) {
    const candidate = makeLegacy();
    const query = queryFor(candidate);
    try {
      await runRestartSafeMigrationStatements(restartStatements, query, {
        afterStatement: ({ index }) => {
          if (index === faultAfter) throw new Error(`synthetic crash after ${index}`);
        },
      });
    } catch (error) {
      if (!/synthetic crash/.test(error.message)) {
        everyResumePassed = false;
        resumeDetail = `fault ${faultAfter}: ${error.message}`;
      }
    }
    try {
      await runRestartSafeMigrationStatements(restartStatements, query);
      const state = candidate.prepare(
        `SELECT outbox_generation,
                vector_drain_lease_owner owner,
                vector_drain_lease_expires_at expires,
                vector_projection_mutation_id mutation_id,
                vector_projection_submitted_at mutation_submitted_at,
                vector_projection_bootstrap_protocol bootstrap_protocol,
                vector_projection_bootstrap_base_count bootstrap_base_count
         FROM install_state WHERE id = 1`,
      ).get();
      const queue = candidate.prepare(
        `SELECT generation, attempts, last_error, submitted_mutation_id, submitted_at,
                bootstrap_epoch, bootstrap_batch FROM vector_outbox
         WHERE chunk_uid = 'restart#0'`,
      ).get();
      const objects = new Set(candidate.prepare("SELECT name FROM sqlite_master").all().map((row) => row.name));
      if (!(queue.generation > 0 && queue.attempts === 3 && queue.last_error === "preserve me" &&
            state.outbox_generation >= queue.generation && state.owner === null && state.expires === null &&
            state.mutation_id === null && state.mutation_submitted_at === null &&
            state.bootstrap_protocol === null && state.bootstrap_base_count === 0 &&
            queue.submitted_mutation_id === null && queue.submitted_at === null &&
            queue.bootstrap_epoch === null && queue.bootstrap_batch === null &&
            objects.has("vector_bootstrap_batches") &&
            objects.has("vector_outbox_generation_ai") && objects.has("vector_outbox_generation_au"))) {
        everyResumePassed = false;
        resumeDetail = `fault ${faultAfter}: ${JSON.stringify({ state, queue, objects: [...objects] })}`;
      }
    } catch (error) {
      everyResumePassed = false;
      resumeDetail = `fault ${faultAfter} resume: ${error.message}`;
    }
    candidate.close();
    if (!everyResumePassed) break;
  }
  check("0010-0013 resume safely after every independently committed statement",
    everyResumePassed, resumeDetail);

  const incompatible = makeLegacy();
  incompatible.exec("ALTER TABLE install_state ADD COLUMN vector_drain_lease_owner INTEGER");
  let refused = null;
  try {
    await runRestartSafeMigrationStatements(restartStatements, queryFor(incompatible));
  } catch (error) { refused = error; }
check("restart guard refuses an existing migration column with the wrong contract",
    /incompatible schema/.test(refused?.message || ""), refused?.message);
  incompatible.close();
}

/* ---- 0013 adopts only a quiescent schema-12 verified cut ---- */
{
  const makeVerified12 = ({ pending = false } = {}) => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0013_")) {
      for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
        candidate.exec(statement);
      }
    }
    candidate.exec(
      `INSERT INTO install_state
         (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
          vector_projection_status,vector_projection_bootstrap_epoch,
          vector_projection_bootstrap_cursor,vector_projection_bootstrap_high_water)
       VALUES (1,'verified-12','0.1.14',12,0,'2026-01-01T00:00:00Z','test',
               'verified',1,'legacy:verified#0','legacy:verified#0');
       INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
       VALUES ('legacy:verified','legacy','verified','Verified',1,'verified-hash');
       INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,vector_id)
       VALUES ('legacy:verified#0','legacy:verified',0,'verified text','legacy','Verified','legacy:verified#0');`,
    );
    if (pending) {
      candidate.exec(
        `INSERT INTO vector_outbox (chunk_uid,vector_id,op,queued_at)
         VALUES ('legacy:pending-delete','legacy:pending-delete','delete',2);
         UPDATE install_state SET vector_projection_status='verified' WHERE id=1;`,
      );
    }
    for (const statement of splitStatements(
      readFileSync(join(DIR, "0013_accelerated_vector_bootstrap.sql"), "utf-8"),
    )) candidate.exec(statement);
    candidate.prepare("UPDATE install_state SET schema_version=13 WHERE id=1").run();
    return candidate;
  };

  const quiescent = makeVerified12();
  const adopted = quiescent.prepare(
    `SELECT vector_projection_bootstrap_protocol protocol,
            vector_projection_bootstrap_base_count base_count
       FROM install_state WHERE id=1`,
  ).get();
  check("0013 adopts an already exact schema-12 projection without re-embedding",
    adopted.protocol === "bootstrap-v2" && adopted.base_count === 1,
    JSON.stringify(adopted));
  quiescent.close();

  const pending = makeVerified12({ pending: true });
  const deferred = pending.prepare(
    `SELECT vector_projection_bootstrap_protocol protocol,
            vector_projection_bootstrap_base_count base_count,
            (SELECT count(*) FROM vector_outbox) pending
       FROM install_state WHERE id=1`,
  ).get();
  check("0013 defers adoption while an older outbox receipt still needs confirmation",
    deferred.protocol === null && deferred.base_count === 1 && deferred.pending === 1,
    JSON.stringify(deferred));
  pending.close();
}

/* ---- 0012 bootstraps large legacy corpora in bounded resumable pages ---- */
{
  const candidate = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => name < "0012_")) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) {
      candidate.exec(statement);
    }
  }
  candidate.exec(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'bootstrap-fixture', '0.1.14', 11, 0, '2026-01-01T00:00:00Z', 'test');
     INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
     VALUES ('legacy:bootstrap','legacy','bootstrap','Bootstrap',1,'legacy-bootstrap-hash');`,
  );
  const insertChunk = candidate.prepare(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let index = 0; index < 201; index++) {
    const uid = `legacy:bootstrap#${String(index).padStart(4, "0")}`;
    insertChunk.run(uid, "legacy:bootstrap", index, `legacy text ${index}`, "legacy", "Bootstrap");
  }
  const migration12 = splitStatements(
    readFileSync(join(DIR, "0012_vector_visibility_receipts.sql"), "utf-8"),
  );
  for (const statement of migration12) candidate.exec(statement);
  candidate.prepare("UPDATE install_state SET schema_version=12 WHERE id=1").run();
  const migrated = candidate.prepare(
    `SELECT vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water,
            (SELECT count(*) FROM vector_outbox) pending
       FROM install_state WHERE id=1`,
  ).get();
  check("0012 marks a legacy corpus unverified without materializing its queue",
    migrated.status === "bootstrap_required" && migrated.epoch === 1 &&
      migrated.cursor === null && migrated.high_water === "legacy:bootstrap#0200" &&
      migrated.pending === 0,
    JSON.stringify(migrated));
  check("0012 migration has no trigger-amplified corpus INSERT",
    migration12.every((statement) =>
      !/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+vector_outbox/i.test(statement)),
    migration12.join("\n"));

  const observed = { maxBinds: 0, batchWidths: [] };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: candidate.prepare(sql).all(...params) }),
      first: async () => candidate.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = candidate.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    DB: {
      prepare,
      batch: async (statements) => {
        observed.batchWidths.push(statements.length);
        observed.maxBinds = Math.max(observed.maxBinds,
          ...statements.map((statement) => statement._params.length));
        candidate.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            const result = candidate.prepare(statement._sql).run(...statement._params);
            return { meta: { changes: Number(result.changes || 0) } };
          });
          candidate.exec("COMMIT");
          return results;
        } catch (error) {
          candidate.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const pages = [];
  let durableResume = null;
  for (;;) {
    const page = await bootstrapVectorProjectionPage(env, { now: 1_000 + pages.length });
    pages.push(page.page_chunks);
    if (pages.length === 1) {
      const beforeResume = candidate.prepare(
        `SELECT vector_projection_bootstrap_epoch epoch,
                vector_projection_bootstrap_cursor cursor
           FROM install_state WHERE id=1`,
      ).get();
      const receipt = await resetVectorProjectionBootstrap(env);
      const afterResume = candidate.prepare(
        `SELECT vector_projection_bootstrap_epoch epoch,
                vector_projection_bootstrap_cursor cursor
           FROM install_state WHERE id=1`,
      ).get();
      durableResume = { beforeResume, receipt, afterResume };
    }
    const queued = candidate.prepare("SELECT count(*) n FROM vector_outbox").get().n;
    if (queued > VECTOR_BOOTSTRAP_PAGE_SIZE) throw new Error(`bootstrap queue exceeded cap: ${queued}`);
    candidate.prepare("DELETE FROM vector_outbox").run();
    if (page.complete) break;
  }
  const finished = candidate.prepare(
    `SELECT vector_projection_status status,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get();
  check("201 legacy chunks resume as exact 99/99/3 pages with no transient full queue",
    JSON.stringify(pages) === JSON.stringify([99, 99, 3]) &&
      finished.status === "pending" && finished.cursor === finished.high_water,
    JSON.stringify({ pages, finished }));
  check("re-running whole-corpus reindex preserves a progressed bootstrap epoch and cursor",
    durableResume?.receipt?.resumed === true &&
      durableResume.beforeResume.epoch === durableResume.afterResume.epoch &&
      durableResume.beforeResume.cursor === durableResume.afterResume.cursor,
    JSON.stringify(durableResume));
  check("a full bootstrap page respects the shared 100-bind D1 ceiling",
    observed.maxBinds === 100 && observed.batchWidths.every((width) => width <= 2),
    JSON.stringify(observed));
  check("a synthetic million-chunk projection has a finite resumable page plan",
    Math.ceil(1_000_000 / VECTOR_BOOTSTRAP_PAGE_SIZE) === 10_102,
    String(Math.ceil(1_000_000 / VECTOR_BOOTSTRAP_PAGE_SIZE)));
  candidate.close();
}

/* ---- the actual command resumes SQL, receipts, and final install-state seed ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-migrate-restart-"));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "restart-fixture" },
    brain: { version: "0.1.14", ring: "test" },
    infrastructure: { cloudflare: {
      account_id: "fixture-account",
      d1_database_id: "fixture-database",
      storage: "d1",
    } },
    safety: { credential_scanner: { gate_version: 0 } },
  }));

  const makeCommandLegacy = () => {
    const candidate = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0010_")) {
      const sql = readFileSync(join(DIR, file), "utf8");
      for (const statement of splitStatements(sql)) candidate.exec(statement);
      candidate.prepare(
        `INSERT INTO schema_migrations (version,name,applied_at,checksum)
         VALUES (?,?,?,?)`,
      ).run(
        Number.parseInt(file.split("_")[0], 10),
        file.replace(/\.sql$/, ""),
        "2026-01-01T00:00:00Z",
        createHash("sha256").update(sql).digest("hex").slice(0, 16),
      );
    }
    candidate.exec(
      `INSERT INTO install_state
         (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
       VALUES (1, 'restart-fixture', '0.1.14', 9, 0, '2026-01-01T00:00:00Z', 'test');
       INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at, attempts, last_error)
       VALUES ('command-legacy#0', 'command-legacy#0', 'upsert', 1234, 4, 'keep retry');`,
    );
    return candidate;
  };

  const adapterFor = (candidate, fault = { after: null, mutations: 0 }) =>
    async (_account, _database, sql, params = []) => {
      const text = String(sql).trim();
      if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
        return { results: candidate.prepare(sql).all(...params) };
      }
      let result = null;
      if (params.length) result = candidate.prepare(sql).run(...params);
      else candidate.exec(sql);
      fault.mutations++;
      if (fault.after === fault.mutations) {
        throw new Error(`synthetic committed migration crash ${fault.after}`);
      }
      return { results: [], meta: { changes: Number(result?.changes || 0) } };
    };

  // Count the exact mutating boundaries exercised by cmdMigrate: both SQL
  // files, both schema_migrations receipts, and the final install_state seed.
  const probe = makeCommandLegacy();
  const probeFault = { after: null, mutations: 0 };
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(probe, probeFault),
    vectorDrainQuiesced: true,
  });
  const commandMutationCount = probeFault.mutations;
  probe.close();

  let commandResumePassed = commandMutationCount > 0;
  let commandResumeDetail = `mutations=${commandMutationCount}`;
  for (let faultAfter = 1; faultAfter <= commandMutationCount && commandResumePassed; faultAfter++) {
    const candidate = makeCommandLegacy();
    const fault = { after: faultAfter, mutations: 0 };
    try {
      await cmdMigrate(manifestPath, {
        silent: true,
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: adapterFor(candidate, fault),
        vectorDrainQuiesced: true,
      });
      commandResumePassed = false;
      commandResumeDetail = `fault ${faultAfter} did not interrupt`;
    } catch (error) {
      if (!/synthetic committed migration crash/.test(error.message)) {
        commandResumePassed = false;
        commandResumeDetail = `fault ${faultAfter}: ${error.message}`;
      }
    }

    let interveningGeneration = null;
    const generationTrigger = candidate.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='vector_outbox_generation_ai'",
    ).get();
    if (generationTrigger) {
      candidate.prepare(
        `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
         VALUES ('intervening#0', 'intervening#0', 'upsert', 9999)`,
      ).run();
      interveningGeneration = candidate.prepare(
        "SELECT generation FROM vector_outbox WHERE chunk_uid='intervening#0'",
      ).get().generation;
    }

    try {
      await cmdMigrate(manifestPath, {
        silent: true,
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: adapterFor(candidate),
        vectorDrainQuiesced: true,
      });
      const state = candidate.prepare(
        `SELECT schema_version, outbox_generation,
                vector_drain_lease_owner owner,
                vector_drain_lease_expires_at expires,
                vector_projection_mutation_id mutation_id,
                vector_projection_submitted_at mutation_submitted_at
         FROM install_state WHERE id=1`,
      ).get();
      const queue = candidate.prepare(
        `SELECT generation, attempts, last_error, submitted_mutation_id, submitted_at
           FROM vector_outbox WHERE chunk_uid='command-legacy#0'`,
      ).get();
      const receipts = candidate.prepare(
        "SELECT version,checksum FROM schema_migrations WHERE version IN (10,11,12,13) ORDER BY version",
      ).all();
      const interveningAfter = interveningGeneration === null ? null : candidate.prepare(
        "SELECT generation FROM vector_outbox WHERE chunk_uid='intervening#0'",
      ).get().generation;
      const objects = new Set(candidate.prepare("SELECT name FROM sqlite_master").all().map((row) => row.name));
      if (!(receipts.length === 4 && state.schema_version === LATEST_SCHEMA &&
            state.outbox_generation >= queue.generation && state.owner === null && state.expires === null &&
            state.mutation_id === null && state.mutation_submitted_at === null &&
            queue.submitted_mutation_id === null && queue.submitted_at === null &&
            queue.generation > 0 && queue.attempts === 4 && queue.last_error === "keep retry" &&
            (interveningGeneration === null || interveningAfter === interveningGeneration) &&
            objects.has("idx_vector_outbox_generation") &&
            objects.has("vector_outbox_generation_ai") && objects.has("vector_outbox_generation_au"))) {
        commandResumePassed = false;
        commandResumeDetail = `fault ${faultAfter}: ${JSON.stringify({ state, queue, receipts, interveningGeneration, interveningAfter })}`;
      }
    } catch (error) {
      commandResumePassed = false;
      commandResumeDetail = `fault ${faultAfter} rerun: ${error.message}`;
    }
    candidate.close();
  }
  check("cmdMigrate resumes after every committed SQL, receipt, and seed boundary",
    commandResumePassed, commandResumeDetail);

  // v0.1.23 publicly shipped grants and zones as schema 15 and 16. The 0.2.0
  // product tables must therefore begin at 17: changing an already-receipted
  // migration in place would turn a routine update into a checksum conflict.
  const publishedSchema16 = new DatabaseSync(":memory:");
  for (const file of files.filter((name) => Number.parseInt(name, 10) <= 16)) {
    const sql = readFileSync(join(DIR, file), "utf8");
    for (const statement of splitStatements(sql)) publishedSchema16.exec(statement);
    publishedSchema16.prepare(
      `INSERT INTO schema_migrations (version,name,applied_at,checksum)
       VALUES (?,?,?,?)`,
    ).run(
      Number.parseInt(file, 10),
      file.replace(/\.sql$/, ""),
      "2026-01-01T00:00:00Z",
      createHash("sha256").update(sql).digest("hex").slice(0, 16),
    );
  }
  publishedSchema16.prepare(
    "UPDATE install_state SET schema_version=16 WHERE id=1",
  ).run();
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(publishedSchema16),
    vectorDrainQuiesced: true,
  });
  const publishedUpgrade = publishedSchema16.prepare(
    `SELECT
       (SELECT schema_version FROM install_state WHERE id=1) schema_version,
       (SELECT count(*) FROM schema_migrations) receipts,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='grants') grants_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='fin_transactions') ledger_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='document_access_grants') document_grants_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='support_sessions') support_sessions_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='zoom_deliveries') zoom_deliveries_table,
       (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='zoom_reconciliation') zoom_reconciliation_table`,
  ).get();
  check(`the published schema-16 access release upgrades cleanly through product schema ${LATEST_SCHEMA}`,
    publishedUpgrade?.schema_version === LATEST_SCHEMA &&
      publishedUpgrade.receipts === files.length &&
      publishedUpgrade.grants_table === 1 &&
      publishedUpgrade.ledger_table === 1 &&
      publishedUpgrade.document_grants_table === 1 &&
      publishedUpgrade.support_sessions_table === 1 &&
      publishedUpgrade.zoom_deliveries_table === 1 &&
      publishedUpgrade.zoom_reconciliation_table === 1,
    JSON.stringify(publishedUpgrade));
  publishedSchema16.close();

  const direct = makeCommandLegacy();
  const directFault = { after: null, mutations: 0 };
  let directError = null;
  try {
    await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: adapterFor(direct, directFault),
    });
  } catch (error) { directError = error; }
  check("direct migrate refuses a live pre-lease brain before every mutation",
    /run `brain update` instead/i.test(directError?.message || "") && directFault.mutations === 0,
    `${directError?.message}; mutations=${directFault.mutations}`);
  direct.close();

  const noStateTable = new DatabaseSync(":memory:");
  noStateTable.exec("CREATE TABLE legacy_live_corpus (id INTEGER PRIMARY KEY, body TEXT)");
  const noStateFault = { after: null, mutations: 0 };
  let noStateError = null;
  try {
    await cmdMigrate(manifestPath, {
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: adapterFor(noStateTable, noStateFault),
    });
  } catch (error) { noStateError = error; }
  check("absence of install_state cannot bypass cutover on a nonempty legacy database",
    /not provably fresh.*brain update/is.test(noStateError?.message || "") &&
      noStateFault.mutations === 0,
    `${noStateError?.message}; mutations=${noStateFault.mutations}`);
  noStateTable.close();

  const missingSingleton = makeCommandLegacy();
  missingSingleton.exec(
    `DELETE FROM vector_outbox;
     DELETE FROM install_state;
     INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash)
     VALUES ('legacy:missing-row','legacy','missing-row','Missing row',1,'missing-row-hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title)
     VALUES ('legacy:missing-row#0','legacy:missing-row',0,'legacy text','legacy','Missing row');`,
  );
  await cmdMigrate(manifestPath, {
    silent: true,
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: adapterFor(missingSingleton),
    vectorDrainQuiesced: true,
  });
  const seededSingleton = missingSingleton.prepare(
    `SELECT schema_version,
            vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get();
  check("migration seeds a missing singleton as an unverified nonempty projection",
    seededSingleton?.schema_version === LATEST_SCHEMA &&
      seededSingleton.status === "bootstrap_required" && seededSingleton.epoch === 1 &&
      seededSingleton.cursor === null && seededSingleton.high_water === "legacy:missing-row#0",
    JSON.stringify(seededSingleton));
  missingSingleton.close();
  rmSync(sandbox, { recursive: true, force: true });
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

/* ---- source lifecycle SQL is executed, not merely inspected by a mock ---- */
{
  const d1 = {
    prepare(sql) {
      const statement = (params = []) => ({
        bind: (...next) => statement(next),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => {
          const result = db.prepare(sql).run(...params);
          return { ...result, meta: { changes: Number(result.changes) } };
        },
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

  const smokeEnvelope = {
    source_type: "install-smoke",
    source_id: "public-first-install-v1",
    title: "Financial Brain first-install smoke proof",
    content: "This public, non-customer document proves one authenticated installation check.",
    metadata: { proof_kind: "public_first_install_smoke", contains_customer_data: false, schema_version: 1 },
  };
  const ingestSmoke = () => worker.fetch(new Request("https://brain.example/api/admin/brain/ingest/batch", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ docs: [smokeEnvelope] }),
  }), env, {});
  const smokeReceipt = (completedAt) => post({
    source: "install-smoke", kind: "upload", status: "ready",
    run_id: "public_install_smoke_v1", lane: "manual",
    started_at: completedAt, completed_at: completedAt,
    docs_added: 1, detail: "fixed public first-install smoke document accepted",
  });

  const committedIngest = await (await ingestSmoke()).json();
  const lostResponseAt = "2026-08-30T19:00:00.000Z";
  await smokeReceipt(lostResponseAt); // The mutation committed; the caller lost this response.
  const resumedIngest = await (await ingestSmoke()).json();
  const resumedReceipt = await (await smokeReceipt("2026-08-30T19:05:00.000Z")).json();
  const smokeDocumentCount = db.prepare(
    "SELECT count(*) AS n FROM documents WHERE doc_uid='install-smoke:public-first-install-v1'"
  ).get().n;
  const smokeRunCount = db.prepare(
    "SELECT count(*) AS n FROM sync_runs WHERE run_id='public_install_smoke_v1'"
  ).get().n;
  const smokeEventCount = db.prepare(
    "SELECT count(*) AS n FROM source_events WHERE id=-2021001 AND source_name='install-smoke'"
  ).get().n;
  const smokeSource = db.prepare(
    "SELECT last_ingest_at,document_count,status FROM sources WHERE name='install-smoke'"
  ).get();
  check("the fixed smoke ingest resumes as one unchanged public document after a lost response",
    committedIngest.results?.[0]?.status === "created" &&
      resumedIngest.results?.[0]?.status === "unchanged" && smokeDocumentCount === 1,
    JSON.stringify({ committedIngest, resumedIngest, smokeDocumentCount }));
  check("the fixed smoke receipt is exactly once across committed-response loss and retry",
    smokeRunCount === 1 && smokeEventCount === 1 &&
      smokeSource.status === "ready" && smokeSource.document_count === 1 &&
      smokeSource.last_ingest_at === lostResponseAt && resumedReceipt.completed_at === lostResponseAt,
    JSON.stringify({ smokeRunCount, smokeEventCount, smokeSource, resumedReceipt }));
}

console.log(fail ? `\n${fail} FAILURES` : `\nmigrations: all ${ran} checks passed`);
process.exit(fail ? 1 : 0);
