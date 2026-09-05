// prefetch(): bounded, ORDER-PRESERVING overlap of a remote connector's per-item fetch.
//
// The defect this keeps dead: the Gmail lane awaited one `messages.get` at a
// time inside batchStream, so a 190k-message mailbox took about twenty hours
// (measured 2026-09-05: 158 messages a minute) regardless of how fast the brain
// accepted batches. Eight in flight was seven times faster with no errors.
//
// The property that matters more than speed is ORDER. Resume state and the
// document family plan reason about "everything before this batch has landed";
// an out-of-order yield could record a later item as done while an earlier one
// was still in flight, and an interrupt then would skip the earlier item on
// every future run. So the first block asserts that a slow early item is still
// yielded before a fast later one.
import { prefetch, batchStream } from "../ingest/run.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 240))); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = async (it) => { const out = []; for await (const v of it) out.push(v); return out; };

// 1. Order is preserved even when an early item is the slowest.
{
  const delays = [60, 5, 40, 1, 20, 3];
  const out = await collect(prefetch(delays.map((d, i) => ({ i, d })), async ({ i, d }) => { await sleep(d); return i; }, { concurrency: 4 }));
  check("results come back in source order regardless of completion order", JSON.stringify(out) === JSON.stringify([0, 1, 2, 3, 4, 5]), JSON.stringify(out));
}

// 2. The in-flight count never exceeds the requested width, and does overlap.
{
  let inflight = 0, peak = 0;
  const items = Array.from({ length: 30 }, (_, i) => i);
  await collect(prefetch(items, async (i) => { inflight++; peak = Math.max(peak, inflight); await sleep(8); inflight--; return i; }, { concurrency: 5 }));
  check("never more than `concurrency` items in flight", peak <= 5, `peak=${peak}`);
  check("fetches actually overlap (peak above 1)", peak > 1, `peak=${peak}`);
}

// 3. concurrency 1 is exactly the serial behaviour.
{
  let inflight = 0, peak = 0;
  await collect(prefetch([1, 2, 3, 4], async (i) => { inflight++; peak = Math.max(peak, inflight); await sleep(3); inflight--; return i; }, { concurrency: 1 }));
  check("concurrency 1 keeps a single item in flight", peak === 1, `peak=${peak}`);
}

// 4. Accepts a paginating ASYNC generator (what listMessages is) and closes it early.
{
  let pagesListed = 0, closed = false;
  async function* source() {
    try {
      for (let page = 0; page < 100; page++) { pagesListed++; for (let k = 0; k < 3; k++) yield page * 3 + k; }
    } finally { closed = true; }
  }
  const got = [];
  for await (const v of prefetch(source(), async (v) => v, { concurrency: 4 })) { got.push(v); if (got.length === 5) break; }
  check("async-generator source works and yields in order", JSON.stringify(got) === JSON.stringify([0, 1, 2, 3, 4]), JSON.stringify(got));
  check("consumer break closes the source generator", closed === true);
  check("consumer break stops paging the source", pagesListed < 100, `pagesListed=${pagesListed}`);
}

// 5. A failure surfaces at ITS position, after the good items before it, and
//    nothing further is started. In-flight items settle; none is left dangling.
{
  const started = [];
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on("unhandledRejection", onUnhandled);
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const got = [];
  let thrown = null;
  try {
    for await (const v of prefetch(items, async (i) => { started.push(i); await sleep(i === 3 ? 2 : 10); if (i === 3) throw new Error("boom at 3"); return i; }, { concurrency: 3 })) got.push(v);
  } catch (e) { thrown = e; }
  await sleep(40);
  process.off("unhandledRejection", onUnhandled);
  check("items before the failure are delivered first", JSON.stringify(got) === JSON.stringify([0, 1, 2]), JSON.stringify(got));
  check("the failure is rethrown to the consumer", thrown?.message === "boom at 3", String(thrown));
  check("no item beyond the window was started after the failure", Math.max(...started) <= 3 + 3, `started=${JSON.stringify(started)}`);
  check("no unhandled rejection escapes", unhandled === null, String(unhandled));
}

// 6. Composes with batchStream: the Gmail lane feeds prefetch() output straight
//    into batchStream, so batches must come out identical to the serial path.
{
  const envelope = (i) => ({ source_type: "t", source_id: `m${i}`, title: `m${i}`, content: `body ${i} `.repeat(20), metadata: {} });
  const serial = [], overlapped = [];
  const prepare = async ({ i, fetched }) => ({ hash: `h${i}`, envelopes: [envelope(i)], stateKey: `t:m${i}`, rel: String(i), fetched });
  const ids = Array.from({ length: 12 }, (_, i) => i);
  for await (const g of batchStream(ids.map((i) => ({ i, fetched: `f${i}` })), prepare, { maxDocs: 5 })) serial.push(g.map((x) => x.stateKey));
  for await (const g of batchStream(prefetch(ids, async (i) => { await sleep((12 - i) % 4); return { i, fetched: `f${i}` }; }, { concurrency: 4 }), prepare, { maxDocs: 5 })) overlapped.push(g.map((x) => x.stateKey));
  check("batches through prefetch match the serial batches exactly", JSON.stringify(serial) === JSON.stringify(overlapped), JSON.stringify(overlapped));
}

// 7. Width is sanitised: nonsense widths fall back to 1, never 0 or NaN.
{
  for (const bad of [0, -3, NaN, "x", undefined]) {
    const out = await collect(prefetch([1, 2], async (v) => v, { concurrency: bad }));
    check(`concurrency ${String(bad)} still yields everything`, JSON.stringify(out) === "[1,2]", JSON.stringify(out));
  }
}

console.log(`\n${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
