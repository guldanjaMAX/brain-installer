import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEnv, seed, embed, remaining } from "./fixtures/vector-fence-env.mjs";
import { drainOutbox, drainBatchQueryUpperBound } from "../worker/src/lib/store-d1.js";
import { VECTOR_FENCE_PROBE_AFTER_MS } from "../worker/src/lib/vector-fence-probe.js";

const fence = db => ({ ...db.prepare("SELECT vector_projection_mutation_id AS mutationId, vector_projection_submitted_at AS submittedAt FROM install_state").get() });
const rows = db => db.prepare("SELECT * FROM vector_outbox ORDER BY chunk_uid").all().map(row => ({ ...row }));
async function stalled(t, { queuedOnly = false, apply = true } = {}) {
  const f = makeEnv();
  t.after(() => f.db.close());
  seed(f.db, 2);
  assert.equal((await drainOutbox(f.env, { embed })).submitted, 2);
  f.original = fence(f.db);
  f.now = f.original.submittedAt + VECTOR_FENCE_PROBE_AFTER_MS;
  f.control.processedAtMs = f.original.submittedAt + 123_600;
  if (apply) f.env._processNextVectorMutation();
  else f.env._advanceWatermarkWithoutApplying();
  f.env._acceptVectorMutation(() => {});
  f.env._processNextVectorMutation();
  if (queuedOnly) f.db.exec("UPDATE vector_outbox SET submitted_mutation_id=NULL, submitted_at=NULL");
  f.probeIds = [];
  const remove = f.env.VECTORIZE.deleteByIds;
  f.env.VECTORIZE.deleteByIds = async ids => { f.probeIds.push(...ids); return remove(ids); };
  f.drain = opts => drainOutbox(f.env, { embed, now: () => f.now, disableBootstrapAdvance: true, ...opts });
  f.process = () => { f.control.processedAtMs = f.now; while (f.env._processNextVectorMutation()) {} };
  return f;
}

for (const queuedOnly of [false, true]) test(`idle ${queuedOnly ? "queued-only" : "submitted"} fence recovers to exact contents`, async t => {
  const f = await stalled(t, { queuedOnly });
  const before = rows(f.db);
  f.now--;
  await f.drain();
  assert.equal(f.probeIds.length, 0);
  f.now++;
  const accepted = await f.drain({ batchSize: 1 });
  assert.equal(accepted.drained, 0);
  assert.deepEqual(rows(f.db), before, "accepting a probe cannot acknowledge or rewrite rows");
  assert.equal(f.probeIds.length, 1);
  assert.match(f.probeIds[0], /^brain-fence:[0-9a-f-]{36}$/);
  assert.ok(Buffer.byteLength(f.probeIds[0]) <= 64);
  const receipt = fence(f.db);
  assert.notEqual(receipt.mutationId, f.original.mutationId);
  // Separate invocations recover only from durable state, with no in-memory receipt.
  for (let i = 0; i < 5; i++) { f.now++; await f.drain(); }
  assert.deepEqual(fence(f.db), receipt);
  assert.equal(f.probeIds.length, 1);
  assert.deepEqual(rows(f.db), before);
  for (let i = 0; i < 5 && remaining(f.db); i++) { f.process(); await f.drain(); }
  assert.equal(remaining(f.db), 0);
  assert.equal(f.visible.size, 2);
  for (const row of before) assert.equal(f.visible.get(row.vector_id)?.metadata.outbox_generation, String(row.generation));
  assert.equal(f.probeIds.length, 1);
});

test("normal pending and exact watermarks do not trigger a probe", async t => {
  const f = makeEnv(); t.after(() => f.db.close()); seed(f.db, 1);
  let deletes = 0; f.env.VECTORIZE.deleteByIds = async () => { deletes++; throw Error("unexpected probe"); };
  await drainOutbox(f.env, { embed });
  const now = () => fence(f.db).submittedAt + 60 * 60_000;
  await drainOutbox(f.env, { embed, now });
  assert.equal(remaining(f.db), 1);
  f.env._processNextVectorMutation();
  await drainOutbox(f.env, { embed, now });
  assert.equal(remaining(f.db), 0); assert.equal(deletes, 0);
});

for (const mode of ["paused", "busy"]) test(`${mode} drain cannot probe`, async t => {
  const f = await stalled(t);
  if (mode === "paused") f.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
  else f.db.prepare("UPDATE install_state SET vector_drain_lease_owner='other-owner', vector_drain_lease_expires_at=?").run(f.now + 60_000);
  await f.drain();
  assert.equal(f.probeIds.length, 0); assert.deepEqual(fence(f.db), f.original);
});

for (const mode of ["collision", "malformed lookup", "lookup error", "delete error", "invalid receipt", "lost lease before", "lost lease after", "receipt persistence error"]) {
  test(`${mode} preserves pending work and its durable fence`, async t => {
    const f = await stalled(t); const before = rows(f.db);
    const get = f.env.VECTORIZE.getByIds;
    const remove = f.env.VECTORIZE.deleteByIds;
    const steal = () => f.db.prepare("UPDATE install_state SET vector_drain_lease_owner='replacement-owner', vector_drain_lease_expires_at=?").run(f.now + 60_000);
    if (mode === "collision") f.env.VECTORIZE.getByIds = async ids => [{ id: ids[0] }];
    if (mode === "malformed lookup") f.env.VECTORIZE.getByIds = async () => null;
    if (mode === "lookup error") f.env.VECTORIZE.getByIds = async () => { throw Error("fixture lookup failure"); };
    if (mode === "delete error") f.env.VECTORIZE.deleteByIds = async () => { throw Error("fixture delete failure"); };
    if (mode === "invalid receipt") f.env.VECTORIZE.deleteByIds = async ids => { await remove(ids); return { mutationId: "invalid\nreceipt" }; };
    if (mode === "lost lease before") f.env.VECTORIZE.getByIds = async ids => { const result = await get(ids); steal(); return result; };
    if (mode === "lost lease after") f.env.VECTORIZE.deleteByIds = async ids => { const result = await remove(ids); steal(); return result; };
    if (mode === "receipt persistence error") f.db.exec("CREATE TRIGGER fail_probe BEFORE UPDATE OF vector_projection_mutation_id ON install_state BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END");
    await assert.rejects(f.drain());
    assert.deepEqual(rows(f.db), before); assert.deepEqual(fence(f.db), f.original);
    if (["collision", "malformed lookup", "lookup error", "lost lease before"].includes(mode)) assert.equal(f.probeIds.length, 0);
    if (mode.startsWith("lost lease")) assert.equal(f.db.prepare("SELECT vector_drain_lease_owner AS owner FROM install_state").get().owner, "replacement-owner");
    if (mode === "receipt persistence error") {
      f.db.exec("DROP TRIGGER fail_probe");
      // Provider accepted the unrecorded probe, then this process died. Resuming
      // still reaches exact rows without manufacturing a processed timestamp.
      f.process();
      for (let i = 0; i < 5 && remaining(f.db); i++) { await f.drain(); f.process(); }
      assert.equal(remaining(f.db), 0);
    }
  });
}

test("a processed probe cannot confirm missing upserts", async t => {
  const f = await stalled(t, { apply: false });
  await f.drain(); f.process();
  const result = await f.drain();
  assert.equal(result.drained, 0); assert.equal(remaining(f.db), 2);
});

test("a processed probe cannot confirm an unapplied delete", async t => {
  const f = await stalled(t);
  f.db.exec("UPDATE vector_outbox SET op='delete', submitted_mutation_id=NULL, submitted_at=NULL");
  await f.drain(); f.process();
  await f.drain();
  // Report the delete as processed but leave its vectors visible.
  f.env._advanceWatermarkWithoutApplying();
  const result = await f.drain();
  assert.equal(result.drained, 0); assert.equal(remaining(f.db), 2); assert.equal(f.visible.size, 2);
});

test("a repeatedly overtaken probe is rate limited and can recover", async t => {
  const f = await stalled(t);
  await f.drain(); f.process();
  f.env._acceptVectorMutation(() => {}); f.env._processNextVectorMutation();
  f.now += VECTOR_FENCE_PROBE_AFTER_MS - 1;
  await f.drain(); assert.equal(f.probeIds.length, 1); assert.equal(remaining(f.db), 2);
  f.now++; await f.drain(); assert.equal(f.probeIds.length, 2);
  f.process(); await f.drain(); assert.equal(remaining(f.db), 0);
});

test("probe D1 work fits the existing smallest-batch reservation", async t => {
  const f = await stalled(t); let queries = 0;
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => { queries++; return prepare(sql); };
  await f.drain({ batchSize: 1 });
  assert.ok(queries <= drainBatchQueryUpperBound(1), `probe invocation used ${queries} queries`);
  assert.equal(f.probeIds.length, 1);
});
