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

import { makeEnv, seed, remaining, embed } from "./fixtures/vector-fence-env.mjs";
import { drainOutbox } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 260)));
  if (!condition) fail++;
};

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
