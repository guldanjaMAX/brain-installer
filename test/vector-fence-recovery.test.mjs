// The projection fence must not strand a brain forever.
//
// The fence records the mutation id a drain submitted, then waits for
// Vectorize to report having processed it. It compared the recorded id to the
// provider's watermark for exact equality. That watermark is a moving
// high-water mark, so the moment any mutation the fence did not record
// processed after ours - a crash between the provider accepting a changeset
// and the fence write landing, or any out-of-band mutation - equality became
// unsatisfiable and the drain waited for the rest of time.
//
// Found live on 2026-09-02 on a brain that had answered questions all night
// while its index silently stopped advancing for twelve hours: health green,
// cron firing, backlog growing, vector count frozen.
//
// Real SQLite, because the property is a state transition across submit,
// fence and confirm.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drainOutbox } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 260)));
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
  let processedUpToDatetime = null;
  const pending = [];
  const control = { processedAtMs: null };
  const stamp = () => {
    processedUpToDatetime = control.processedAtMs === null
      ? null : new Date(control.processedAtMs).toISOString();
  };
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    pending.push({ mutationId, apply });
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
    _acceptVectorMutation: accept,
    _processNextVectorMutation: () => {
      const mutation = pending.shift();
      if (!mutation) return null;
      mutation.apply();
      processedUpToMutation = mutation.mutationId;
      stamp();
      return mutation.mutationId;
    },
    // Move the watermark WITHOUT applying, so an unprocessed delete can be
    // proven to stay unconfirmed even when the fence opens.
    _advanceWatermarkWithoutApplying: () => {
      const mutation = pending.shift();
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
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => {
        for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
      }),
      deleteByIds: async (ids) => accept(() => { for (const id of ids) visible.delete(id); }),
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({
        vectorCount: visible.size,
        processedUpToMutation,
        ...(processedUpToDatetime === null ? {} : { processedUpToDatetime }),
      }),
    },
  };
  return { env, db, control, visible };
}

const seed = (db, count) => {
  for (let i = 0; i < count; i++) {
    const doc = `drive:fence-${i}`, uid = `${doc}#0`;
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES (?, 'drive', ?, ?, ?, ?)`
    ).run(doc, doc, doc, Date.now(), `hash:${doc}`);
    db.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
       VALUES (?, ?, 0, ?, 'drive', ?)`
    ).run(uid, doc, `text ${i}`, uid);
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?, ?, 'upsert', ?)`
    ).run(uid, uid, i + 1);
  }
};
const remaining = (db) => db.prepare("SELECT count(*) AS n FROM vector_outbox").get().n;
const embed = async () => [0.1];

// --- The stall, and the recovery -------------------------------------------
{
  const { env, db, control } = makeEnv();
  seed(db, 3);
  const now = () => 1_000_000;

  const first = await drainOutbox(env, { embed, maxBatches: 10, now });
  check("three rows are accepted under one mutation", first.submitted === 3, JSON.stringify(first));

  // Ours processes, then a mutation the fence never recorded processes after it.
  env._processNextVectorMutation();
  env._acceptVectorMutation(() => {});
  env._processNextVectorMutation();

  const fence = db.prepare(
    "SELECT vector_projection_mutation_id AS mid, vector_projection_submitted_at AS at FROM install_state"
  ).get();
  check("the fence holds the drain's own mutation id", fence.mid === "fixture-mutation-1", fence.mid);

  // Inside the skew margin the fence stays closed. Fail-closed is preserved.
  control.processedAtMs = Number(fence.at) + 60_000;
  env._acceptVectorMutation(() => {});
  env._advanceWatermarkWithoutApplying();
  const inside = await drainOutbox(env, { embed, maxBatches: 10, now });
  check("inside the clock-skew margin the fence stays shut",
    inside.drained === 0 && inside.waiting === 3, JSON.stringify(inside));

  // Past the margin the drain recovers on its own. Before this fix it waited
  // forever here, which is the whole defect.
  control.processedAtMs = Number(fence.at) + 6 * 60_000;
  env._acceptVectorMutation(() => {});
  env._advanceWatermarkWithoutApplying();
  const recovered = await drainOutbox(env, { embed, maxBatches: 10, now });
  check("past the margin an overtaken fence recovers", recovered.drained === 3, JSON.stringify(recovered));
  check("the queue empties", remaining(db) === 0, remaining(db));
}

// --- An open fence still proves nothing about a row ------------------------
{
  const { env, db, control, visible } = makeEnv();
  const doc = "drive:pending-delete", uid = `${doc}#0`;
  db.prepare(
    `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES (?, 'drive', ?, ?, ?, ?)`
  ).run(doc, doc, doc, Date.now(), `hash:${doc}`);
  visible.set(uid, { id: uid, values: [0.1] });
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?, ?, 'delete', 1)`
  ).run(uid, uid);
  const now = () => 2_000_000;

  const submitted = await drainOutbox(env, { embed, maxBatches: 10, now });
  check("the delete is submitted", submitted.submitted === 1, JSON.stringify(submitted));

  const fence = db.prepare("SELECT vector_projection_submitted_at AS at FROM install_state").get();
  control.processedAtMs = Number(fence.at) + 6 * 60_000;
  env._advanceWatermarkWithoutApplying();   // watermark moves, delete never applied

  const attempt = await drainOutbox(env, { embed, maxBatches: 10, now });
  check("an unapplied delete is not confirmed by an open fence",
    attempt.drained === 0, JSON.stringify(attempt));
  check("the delete stays queued for a later attempt", remaining(db) === 1, remaining(db));
}

console.log(`\nvector fence recovery: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
