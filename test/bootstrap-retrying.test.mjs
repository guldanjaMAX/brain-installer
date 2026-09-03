/**
 * A bootstrap receipt with failed > 0 means "accepted, not yet visible", not
 * "lost". The runner must keep polling within its deadline and complete when
 * the Worker does, and must still give up when nothing ever confirms.
 * Reproduced live 2026-09-03: two aborted 0.2.0 -> 0.3.4 updates, then the
 * same brain updated cleanly once Vectorize caught up.
 */
import assert from "node:assert/strict";
import { runAcceleratedBootstrap, ACCELERATED_BOOTSTRAP_STALL_MS } from "../brain.mjs";

const receipt = (o) => ({
  protocol: "bootstrap-v2", phase: "building", epoch: 0, total: 1, confirmed: 0, queued: 0,
  submitted: 0, remaining: 1, in_flight_batches: 0, failed: 0, complete: false,
  vector_ready: false, expected_vectors: 1, actual_vectors: 0, ...o,
});
const res = (body, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
let clock = 0;
const opts = (maxDurationMs = 600_000) => ({ now: () => clock, sleep: async (ms) => { clock += ms; }, maxDurationMs });

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
    runAcceleratedBootstrap({ ...opts(3_600_000), request: async () => { i++; return res(receipt({ failed: 1 })); } }),
    /has not moved for \d+ minutes|deadline/i,
    "a permanently unconfirmed vector must still stop the update",
  );
  const expectedRounds = Math.ceil(ACCELERATED_BOOTSTRAP_STALL_MS / 15_000);
  assert.ok(i >= expectedRounds && i <= expectedRounds + 3, `gives up after the movement budget, saw ${i} requests for ${expectedRounds} rounds`);
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

// The 2026-09-03 scale shape: 2,544 rows, `failed` falls to 2,444 as a batch is
// re-submitted, then every aggregate sits identical for five minutes while
// Vectorize works on the first confirmation, then confirmations arrive. The
// old rule died at two minutes; this must wait and complete.
{
  clock = 0;
  const big = (o) => receipt({ total: 2544, remaining: 2544, expected_vectors: 2544, ...o });
  const seq = [
    big({ failed: 2544 }),
    big({ failed: 2544 }),
    ...Array.from({ length: 22 }, () => big({ failed: 2444, submitted: 100, in_flight_batches: 1 })),
    big({ failed: 2344, submitted: 100, in_flight_batches: 1, confirmed: 100, remaining: 2444 }),
    big({ phase: "complete", confirmed: 2544, remaining: 0, complete: true, vector_ready: true, actual_vectors: 2544 }),
  ];
  let i = 0;
  const out = await runAcceleratedBootstrap({ ...opts(3_600_000), request: async () => res(seq[Math.min(i++, seq.length - 1)]) });
  assert.equal(out.complete, true, "five quiet minutes with work in flight must not end the update");
  assert.equal(i, seq.length, `polled every receipt, saw ${i}`);
}

// A Worker frozen solid (identical receipts, a batch supposedly in flight,
// nothing confirming) still stops the update once the movement budget is spent.
{
  clock = 0;
  let i = 0;
  await assert.rejects(
    runAcceleratedBootstrap({ ...opts(3_600_000), request: async () => { i++; return res(receipt({ total: 2544, remaining: 2544, expected_vectors: 2544, failed: 2444, submitted: 100, in_flight_batches: 1 })); } }),
    /has not moved for \d+ minutes/,
    "a frozen rebuild must still stop, with the counters in the message",
  );
  assert.ok(i >= 60 && i <= 64, `stopped on the time budget, saw ${i} requests`);
}

console.log("bootstrap: a retrying vector is waited for, a quiet rebuild with work in flight is waited for, a frozen one still stops the update");
