// Two recovery properties of the vector drain, pinned after the 2026-09-02
// incident on a live brain.
//
// A: the projection fence must not stall forever when the provider watermark
//    moves past the recorded mutation (a crash between provider accept and
//    the fence write, or any out-of-band mutation, makes exact equality
//    unsatisfiable for the rest of time).
// B: rows re-queued for a systemic reason (visibility_mismatch) must not
//    serialize the whole queue to one row per cycle from the head, while a
//    genuine provider-poison row must still prove itself alone.
//
// Real SQLite, same reasoning as vector-delete-outbox.test.mjs: the property
// under test is state composition across submit, confirm, retry and slice.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drainOutbox, vectorRetrySummary } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

function makeEnv({ autoProcessVectorMutations = true, rejectUpsertIds = [] } = {}) {
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

  const upsertBatches = [];
  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  let processedUpToDatetime = null;
  const pendingVectorMutations = [];
  const control = { rejectUpsertIds: new Set(rejectUpsertIds), processedAtMs: null };
  const stamp = () => {
    processedUpToDatetime = control.processedAtMs === null
      ? null
      : new Date(control.processedAtMs).toISOString();
  };
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    if (autoProcessVectorMutations) {
      apply();
      processedUpToMutation = mutationId;
      stamp();
    } else {
      pendingVectorMutations.push({ mutationId, apply });
    }
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
    });
    return shape();
  };
  const env = {
    _db: db,
    _acceptVectorMutation: accept,
    _processNextVectorMutation: () => {
      const mutation = pendingVectorMutations.shift();
      if (!mutation) return null;
      mutation.apply();
      processedUpToMutation = mutation.mutationId;
      stamp();
      return mutation.mutationId;
    },
    // Synthetic misbehaving-provider probe: move the watermark WITHOUT
    // applying the pending mutation. Real Vectorize applies FIFO; this exists
    // to prove the row-level getByIds proof holds even if it did not.
    _advanceWatermarkWithoutApplying: () => {
      const mutation = pendingVectorMutations.shift();
      if (!mutation) return null;
      processedUpToMutation = mutation.mutationId;
      stamp();
      return mutation.mutationId;
    },
    DB: {
      exec: async (sql) => { db.exec(sql); return { count: 1 }; },
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => {
        upsertBatches.push(vectors.map((vector) => vector.id));
        if (vectors.some((vector) => control.rejectUpsertIds.has(vector.id))) {
          throw new Error("synthetic provider rejected one vector");
        }
        return accept(() => {
          for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
        });
      },
      deleteByIds: async (ids) => accept(() => {
        for (const id of ids) visible.delete(id);
      }),
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({
        vectorCount: visible.size,
        processedUpToMutation,
        ...(processedUpToDatetime === null ? {} : { processedUpToDatetime }),
      }),
    },
  };
  return { env, db, upsertBatches, visible, control };
}

const insertDocument = (db, uid) => db.prepare(
  `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
   VALUES (?, 'drive', ?, ?, ?, ?)`
).run(uid, uid, uid, Date.now(), `hash:${uid}`);

const insertChunk = (db, uid, doc, ix, text = `text for ${uid}`) => db.prepare(
  `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
   VALUES (?, ?, ?, ?, 'drive', ?)`
).run(uid, doc, ix, text, uid);

const enqueueUpsert = (db, uid, queuedAt) => db.prepare(
  `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
   VALUES (?, ?, 'upsert', ?)`
).run(uid, uid, queuedAt);

const seedRows = (db, count, { poisonTextAt = null } = {}) => {
  const uids = [];
  for (let i = 0; i < count; i++) {
    const doc = `drive:recovery-${i}`;
    const uid = `${doc}#0`;
    insertDocument(db, doc);
    insertChunk(db, uid, doc, 0, poisonTextAt === i ? "POISON-TEXT" : `text for ${uid}`);
    enqueueUpsert(db, uid, i + 1);
    uids.push(uid);
  }
  return uids;
};

const outboxCount = (db) => db.prepare("SELECT count(*) AS n FROM vector_outbox").get().n;
const embedOk = async (text) => {
  if (String(text).includes("POISON-TEXT")) throw new Error("synthetic unembeddable chunk");
  return [0.1];
};
const embedBatchOk = async (texts) => texts.map((text) => {
  if (String(text).includes("POISON-TEXT")) throw new Error("synthetic unembeddable chunk in group");
  return [0.1];
});

// ---------------------------------------------------------------------------
// T1: a fence overtaken by the watermark must not stall the drain forever.
{
  const { env, db, control } = makeEnv({ autoProcessVectorMutations: false });
  seedRows(db, 3);
  let clock = 1_000_000;
  const now = () => clock;

  const first = await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, now });
  check("T1 submit: three rows accepted under one mutation", first.submitted === 3, JSON.stringify(first));

  // Our mutation processes, then an out-of-band mutation processes after it.
  env._processNextVectorMutation();
  env._acceptVectorMutation(() => {});
  env._processNextVectorMutation();

  const fence = db.prepare(
    "SELECT vector_projection_mutation_id AS mid, vector_projection_submitted_at AS at FROM install_state"
  ).get();
  check("T1 fence records the drain's own mutation", fence.mid === "fixture-mutation-1", fence.mid);

  // Inside the skew margin the fence stays closed: fail-closed is preserved.
  control.processedAtMs = Number(fence.at) + 60_000;
  env._acceptVectorMutation(() => {});
  env._advanceWatermarkWithoutApplying();
  const inside = await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, now });
  check("T1 inside the margin: still waiting, nothing confirmed",
    inside.drained === 0 && inside.waiting === 3, JSON.stringify(inside));

  // Past the margin the drain recovers on its own. The old code waits here
  // for the rest of time - this assertion is the regression lock.
  control.processedAtMs = Number(fence.at) + 6 * 60_000;
  env._acceptVectorMutation(() => {});
  env._advanceWatermarkWithoutApplying();
  const recovered = await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, now });
  check("T1 past the margin: all three rows confirm", recovered.drained === 3, JSON.stringify(recovered));
  check("T1 outbox is empty after recovery", outboxCount(db) === 0, outboxCount(db));
}

// T1b: an open fence confirms nothing by itself - an unapplied delete stays
// unconfirmed because the vector is still visible.
{
  const { env, db, control } = makeEnv({ autoProcessVectorMutations: false });
  const doc = "drive:unapplied-delete";
  const uid = `${doc}#0`;
  insertDocument(db, doc);
  insertChunk(db, uid, doc, 0);
  env._visible?.set?.(uid, { id: uid });
  const { visible } = { visible: null };
  // Make the vector visible, then queue its delete.
  (await env.VECTORIZE.upsert([{ id: uid, values: [0.1], metadata: {} }]), env._processNextVectorMutation());
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?, ?, 'delete', 1)`
  ).run(uid, uid);
  db.prepare("DELETE FROM chunks WHERE chunk_uid = ?").run(uid);
  let clock = 2_000_000;
  const now = () => clock;

  const submitted = await drainOutbox(env, { embed: embedOk, maxBatches: 10, now });
  check("T1b delete submitted", submitted.submitted === 1, JSON.stringify(submitted));

  const fence = db.prepare(
    "SELECT vector_projection_submitted_at AS at FROM install_state"
  ).get();
  control.processedAtMs = Number(fence.at) + 6 * 60_000;
  env._advanceWatermarkWithoutApplying();

  const attempt = await drainOutbox(env, { embed: embedOk, maxBatches: 10, now });
  check("T1b unapplied delete is not confirmed by an open fence",
    attempt.drained === 0 && attempt.failed === 1, JSON.stringify(attempt));
  check("T1b the delete row is retained for retry", outboxCount(db) === 1, outboxCount(db));
}

// ---------------------------------------------------------------------------
// T2: systemic re-queues at the head must ride in a full batch.
{
  const { env, db, upsertBatches } = makeEnv();
  seedRows(db, 200);
  const oldest = db.prepare(
    "SELECT chunk_uid, generation FROM vector_outbox ORDER BY queued_at LIMIT 20"
  ).all();
  for (const row of oldest) {
    db.prepare(
      `INSERT INTO vector_outbox_retry_state
         (chunk_uid, generation, attempts, next_attempt_at, last_attempt_at, quarantined_at, failure_code, last_error)
       VALUES (?, ?, 1, 0, 1, NULL, 'visibility_mismatch', 'accepted vector state was not visible')`
    ).run(row.chunk_uid, row.generation);
    db.prepare("UPDATE vector_outbox SET attempts = 1 WHERE chunk_uid = ?").run(row.chunk_uid);
  }
  let clock = 3_000_000;
  const now = () => clock;
  let invocations = 0;
  while (outboxCount(db) > 0 && invocations < 8) {
    invocations++;
    await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, batchSize: 100, now });
    clock += 60_000;
  }
  check("T2 first batch carries the full hundred, retried head included",
    upsertBatches[0]?.length === 100, upsertBatches[0]?.length);
  check("T2 two hundred rows clear in a few invocations, not two hundred",
    outboxCount(db) === 0 && invocations <= 4, `invocations=${invocations} remaining=${outboxCount(db)}`);
  const quarantined = db.prepare(
    "SELECT count(*) AS n FROM vector_outbox_retry_state WHERE quarantined_at IS NOT NULL"
  ).get().n;
  check("T2 no healthy row was quarantined on the way", quarantined === 0, quarantined);
}

// ---------------------------------------------------------------------------
// T3a: an unembeddable chunk isolates itself without delaying its batch.
{
  const { env, db } = makeEnv();
  seedRows(db, 5, { poisonTextAt: 0 });
  let clock = 4_000_000;
  const now = () => clock;
  const first = await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, now });
  check("T3a four healthy rows drain on the first invocation", first.drained === 4, JSON.stringify(first));
  // Walk the poison row through its whole backoff ladder.
  for (const step of [61_000, 5 * 60_000 + 1000, 30 * 60_000 + 1000, 2 * 60 * 60_000 + 1000, 2 * 60 * 60_000 + 1000]) {
    clock += step;
    await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, now });
  }
  const summary = await vectorRetrySummary(env);
  check("T3a the poison row quarantines alone", summary.quarantined === 1, JSON.stringify(summary));
  check("T3a nothing else is left queued behind it",
    db.prepare("SELECT count(*) AS n FROM vector_outbox o JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation WHERE s.quarantined_at IS NULL").get().n === 0);
}

// T3b: a provider-rejected row keeps the exclusive head slice - bisection.
{
  const { env, db, upsertBatches } = makeEnv({ rejectUpsertIds: ["drive:recovery-0#0"] });
  seedRows(db, 3);
  let clock = 5_000_000;
  const now = () => clock;
  let invocations = 0;
  let rejectedThrows = 0;
  while (invocations < 12) {
    invocations++;
    try {
      await drainOutbox(env, { embed: embedOk, embedBatch: embedBatchOk, maxBatches: 10, now });
    } catch (error) {
      // A provider rejection schedules its retry state and then rethrows with
      // this flag - the same contract the delete-outbox suite asserts on.
      if (error?.vectorUpsertFailed !== true) throw error;
      rejectedThrows++;
    }
    clock += 3 * 60 * 60_000;
    const left = db.prepare(
      "SELECT count(*) AS n FROM vector_outbox o LEFT JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation WHERE s.quarantined_at IS NULL"
    ).get().n;
    if (left === 0) break;
  }
  check("T3b the first attempt was a full batch of three", upsertBatches[0]?.length === 3, upsertBatches[0]?.length);
  check("T3b every attempt after the rejection is a single row",
    upsertBatches.slice(1).every((batch) => batch.length === 1),
    JSON.stringify(upsertBatches.map((batch) => batch.length)));
  const healthy = db.prepare(
    "SELECT count(*) AS n FROM vector_outbox o LEFT JOIN vector_outbox_retry_state s ON s.chunk_uid=o.chunk_uid AND s.generation=o.generation WHERE s.quarantined_at IS NULL"
  ).get().n;
  const quarantined = db.prepare(
    "SELECT count(*) AS n FROM vector_outbox_retry_state WHERE quarantined_at IS NOT NULL"
  ).get().n;
  check("T3b the two healthy rows confirmed and left the queue", healthy === 0, healthy);
  check("T3b only the rejected row quarantined", quarantined === 1, quarantined);
  check("T3b every rejection surfaced through the flagged throw", rejectedThrows >= 2, rejectedThrows);
}

console.log(`\n${ran} checks, ${fail} failing`);
process.exit(fail ? 1 : 0);
