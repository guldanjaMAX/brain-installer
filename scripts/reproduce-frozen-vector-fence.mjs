// Intentionally exits nonzero until UPDATE-002 is fixed. This is a release
// blocker reproduction, not a passing test that enshrines the broken behavior.
import assert from "node:assert/strict";
import { makeEnv, seed, embed } from "../test/fixtures/vector-fence-env.mjs";
import { drainOutbox } from "../worker/src/lib/store-d1.js";

const failures = [];
for (const queuedOnly of [false, true]) {
const { env, db, control } = makeEnv();
try {
  seed(db, 2);
  assert.equal((await drainOutbox(env, { embed })).submitted, 2);
  const fence = db.prepare("SELECT vector_projection_submitted_at AS at FROM install_state").get();
  control.processedAtMs = Number(fence.at) + 123_600;
  env._processNextVectorMutation();
  env._acceptVectorMutation(() => {});
  env._processNextVectorMutation();
  // Reach the second incident shape: a durable global fence, queued rows,
  // and no submitted row receipts. All previous vector mutations are applied.
  if (queuedOnly) db.prepare("UPDATE vector_outbox SET submitted_mutation_id = NULL, submitted_at = NULL").run();
  let progressed = false;
  for (let minute = 1; minute <= 20; minute++) {
    const result = await drainOutbox(env, { embed, now: () => Number(fence.at) + minute * 60_000 });
    progressed ||= result.submitted > 0 || result.drained > 0;
    // Process any actual product recovery mutations. The fixture does not
    // invent an external nudge or advance an idle provider timestamp.
    control.processedAtMs = Number(fence.at) + minute * 60_000;
    while (env._processNextVectorMutation()) {}
  }
  const shape = queuedOnly ? "queued-only" : "submitted";
  console.log(`${progressed ? "PASS" : "BLOCKED"} UPDATE-002 ${shape}: bounded recovery without an external nudge`);
  if (!progressed) failures.push(shape);
} finally {
  db.close();
}
}
assert.deepEqual(failures, [], "UPDATE-002: twenty cron invocations made zero progress behind an overtaken, frozen watermark");
