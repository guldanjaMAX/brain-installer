// One row queued in the seconds before an upgrade pause must not strand the
// whole update.
//
// Observed live on 2026-09-04 on a 926,323-chunk brain. `brain update`
// printed "905143/926323 legacy vector(s) confirmed; 21180 remain" on every
// poll, forever, and took four attempts plus hand-editing D1 to finish.
//
// The mechanism is an asymmetry inside acceleratedVectorBootstrap. Its LEGACY
// branch drains outbox residue while paused, under
// drainOutbox(..., { allowPausedBootstrap: true }). Its bootstrap-v2 branch
// did not. So a single chunk queued by ordinary ingest just before the pause
// could never be projected: the outbox never emptied, so
// markProjectionVerifiedIfExact could never take its exact cut, so the status
// never reached 'verified', so the escape hatch that refreshes
// vector_projection_bootstrap_base_count never fired, so convergence compared
// a stale base (905,143, from an earlier epoch) against a chunk count that had
// since grown, and waited for the rest of time.
//
// Real SQLite, same reasoning as vector-delete-outbox.test.mjs: the property
// is a state transition across the outbox, the batch ledger, the install fence
// and the provider watermark, which no hand-written SQL mock can compose.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acceleratedVectorBootstrap } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();

  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    apply();
    processedUpToMutation = mutationId;
    return { mutationId };
  };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: {
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            const result = db.prepare(statement._sql).run(...statement._params);
            return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
          });
          db.exec("COMMIT");
          return results;
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => {
        for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
      }),
      deleteByIds: async (ids) => accept(() => { for (const id of ids) visible.delete(id); }),
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({ vectorCount: visible.size, processedUpToMutation }),
    },
  };
  return { env, db, visible };
}

const addChunk = (db, uid) => {
  const doc = uid.replace(/#\d+$/, "");
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES (?, 'drive', ?, ?, ?, ?)`
  ).run(doc, doc, doc, 1_000, `hash:${doc}`);
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
     VALUES (?, ?, 0, ?, 'drive', ?)`
  ).run(uid, doc, `text for ${uid}`, uid);
};

/**
 * A brain that already finished one accelerated bootstrap, then ingested one
 * more chunk, then was paused for an upgrade with that chunk still queued.
 *
 * base_count is the stale value from the earlier epoch, chunks has grown past
 * it, the batch ledger for the current epoch is empty, and the outbox holds
 * exactly one row.
 */
function seedStrandedBrain(db, visible, { epoch = 7 } = {}) {
  const projected = ["drive:strand-a#0", "drive:strand-b#0", "drive:strand-c#0"];
  for (const uid of projected) {
    addChunk(db, uid);
    visible.set(uid, { id: uid, values: [0.1], metadata: {} });
  }
  db.prepare(
    `UPDATE install_state
        SET schema_version=22,
            vector_projection_status='verified',
            vector_projection_bootstrap_epoch=?1,
            vector_projection_bootstrap_cursor=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_high_water=(SELECT MAX(chunk_uid) FROM chunks),
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=(SELECT count(*) FROM chunks)
      WHERE id=1`
  ).run(epoch);

  // The one chunk ingested after that bootstrap. Its outbox INSERT is what
  // flips the projection status back to 'pending' via the schema trigger.
  const stranded = "drive:strand-new#0";
  addChunk(db, stranded);
  db.prepare(
    "INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?1, ?1, 'upsert', 2000)"
  ).run(stranded);
  return stranded;
}

const snapshot = (db) => db.prepare(
  `SELECT vector_projection_status AS status,
          vector_projection_bootstrap_base_count AS base,
          (SELECT count(*) FROM chunks) AS chunks,
          (SELECT count(*) FROM vector_outbox) AS outbox,
          (SELECT count(*) FROM vector_bootstrap_batches) AS batches
     FROM install_state WHERE id=1`
).get();

// --- The strand, and its recovery ------------------------------------------
{
  const { env, db, visible } = makeEnv();
  const stranded = seedStrandedBrain(db, visible);
  const before = snapshot(db);
  check("the fixture reproduces the live shape: stale base, one queued row, no batches",
    before.status === "pending" && Number(before.base) === 3 && Number(before.chunks) === 4 &&
      Number(before.outbox) === 1 && Number(before.batches) === 0,
    JSON.stringify(before));

  let clock = 100_000;
  const options = {
    now: () => (clock += 60_000),
    embed: async () => [0.1],
    embedBatch: async (texts) => texts.map(() => [0.1]),
  };

  let receipt = null;
  for (let round = 0; round < 8 && !receipt?.complete; round++) {
    receipt = await acceleratedVectorBootstrap(env, options);
  }
  const after = snapshot(db);
  check("the row queued before the pause is projected while the brain stays paused",
    Number(after.outbox) === 0 && visible.has(stranded),
    JSON.stringify({ after, visible: [...visible.keys()] }));
  check("the stale bootstrap base count refreshes to the whole corpus",
    Number(after.base) === 4 && after.status === "verified",
    JSON.stringify(after));
  check("convergence completes instead of waiting forever",
    receipt?.complete === true && receipt.confirmed === 4 && receipt.total === 4 &&
      receipt.remaining === 0,
    JSON.stringify(receipt));
  check("the pause on ordinary corpus writers is never lifted",
    env.VECTOR_DRAIN_MODE === "paused-for-upgrade", env.VECTOR_DRAIN_MODE);
}

// The upstream suite has a seventh check here: a residue row that is entirely
// quarantined must fail with a named cause. It seeds vector_outbox_retry_state,
// which arrives in migration 0028. This line ends at 0022, so no quarantined row
// can exist and the check is not applicable. Restore it with that migration.

console.log(`\n${ran - fail}/${ran} checks passed`);
process.exit(fail ? 1 : 0);
