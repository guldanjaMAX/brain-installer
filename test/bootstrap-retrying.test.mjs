/**
 * A bootstrap receipt with failed > 0 means "accepted, not yet visible", not
 * "lost". The runner must keep polling within its deadline and complete when
 * the Worker does, and must still give up when nothing ever confirms.
 * Reproduced live 2026-09-03: two aborted 0.2.0 -> 0.3.4 updates, then the
 * same brain updated cleanly once Vectorize caught up.
 */
import assert from "node:assert/strict";
import { runAcceleratedBootstrap } from "../brain.mjs";

const receipt = (o) => ({
  protocol: "bootstrap-v2", phase: "building", epoch: 0, total: 1, confirmed: 0, queued: 0,
  submitted: 0, remaining: 1, in_flight_batches: 0, failed: 0, complete: false,
  vector_ready: false, expected_vectors: 1, actual_vectors: 0, ...o,
});
const res = (body, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
let clock = 0;
const opts = () => ({ now: () => clock, sleep: async (ms) => { clock += ms; }, maxDurationMs: 600_000 });

// failed:1, failed:1, then complete -> completes instead of dying.
{
  const seq = [
    receipt({ failed: 1 }),
    receipt({ failed: 1 }),
    receipt({ phase: "complete", confirmed: 1, remaining: 0, complete: true, vector_ready: true, actual_vectors: 1 }),
  ];
  let i = 0;
  const out = await runAcceleratedBootstrap({ ...opts(), request: async () => res(seq[Math.min(i++, seq.length - 1)]) });
  assert.equal(out.complete, true, "must complete once the Worker confirms");
  assert.equal(i, 3, "must have polled through the retrying receipts");
}

// failed:1 forever with no progress -> gives up, does not spin.
{
  let i = 0;
  await assert.rejects(
    runAcceleratedBootstrap({ ...opts(), request: async () => { i++; return res(receipt({ failed: 1 })); } }),
    /stayed unconfirmed|deadline|no progress/i,
    "a permanently unconfirmed vector must still stop the update",
  );
  assert.ok(i >= 3 && i < 60, `bounded polling, saw ${i} requests`);
}

// A 0.3.4 Worker also names the count `retrying`. The aggregate-only contract
// must accept that shape (and an older Worker's shape without it), and the
// runner must read the honest name when both are present.
{
  const seq = [
    receipt({ failed: 1, retrying: 1 }),
    receipt({ phase: "complete", confirmed: 1, remaining: 0, complete: true, vector_ready: true, actual_vectors: 1, retrying: 0 }),
  ];
  let i = 0;
  const out = await runAcceleratedBootstrap({ ...opts(), request: async () => res(seq[Math.min(i++, seq.length - 1)]) });
  assert.equal(out.complete, true, "a receipt carrying `retrying` passes the aggregate-only contract and completes");
  assert.equal(i, 2, "polled the retrying receipt, then the completion");
}

console.log("bootstrap: a retrying vector is waited for, a stuck one still stops the update");
