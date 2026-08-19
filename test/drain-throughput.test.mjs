// Throughput, from Jay's finding 6j: 1,200 chunks/hour while the message said
// "a few minutes". The fix is embedding in groups instead of one call per chunk.
//
// The dangerous part of batching is ALIGNMENT: if a batch call returns fewer
// vectors than texts and the caller does not notice, every chunk after the gap
// gets somebody else's vector. That is silent and permanent, so it is the thing
// most heavily tested here.

import { drainOutbox } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const mkEnv = (rows, upserted, deleted = [], updates = []) => ({
  DB: {
    prepare(q) {
      const shape = (b = []) => ({
        all: async () => ({ results: rows }), first: async () => ({ n: 1 }),
        run: async () => ({}), _q: q, _b: b,
      });
      const o = shape(); o.bind = (...b) => shape(b); return o;
    },
    batch: async (stmts) => {
      for (const s of stmts) {
        if (/DELETE FROM vector_outbox/.test(s._q)) deleted.push(s._b[0]);
        if (/UPDATE vector_outbox/.test(s._q)) updates.push(s._b[0]);
      }
    },
  },
  VECTORIZE: { upsert: async (v) => { upserted.push(...v); } },
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({ chunk_uid: `c${i}#0`, text: `text ${i}`, source: "s", doc_uid: `c${i}` }));

/* ---- the round trips actually collapse ---- */
{
  const up = []; let batchCalls = 0, singleCalls = 0;
  const r = await drainOutbox(mkEnv(rows(100), up), {
    embed: async () => { singleCalls++; return [0.1]; },
    embedBatch: async (texts) => { batchCalls++; return texts.map((_, i) => [i]); },
    embedGroup: 50,
  });
  check("100 chunks embed in 2 calls, not 100", batchCalls === 2 && singleCalls === 0, `batch=${batchCalls} single=${singleCalls}`);
  check("and all 100 are drained", r.drained === 100, JSON.stringify(r));
}

/* ---- alignment: the vector a chunk gets must be ITS OWN ---- */
{
  const up = [];
  await drainOutbox(mkEnv(rows(4), up), {
    embed: async () => [999],
    embedBatch: async (texts) => texts.map((t) => [Number(t.split(" ")[1])]),
    embedGroup: 2,
  });
  check("each chunk keeps the vector made from its own text",
    up.length === 4 && up.every((v, i) => v.values[0] === i), JSON.stringify(up.map((v) => v.values[0])));
}

/* ---- a SHORT batch response must never be accepted ---- */
{
  const up = [];
  const r = await drainOutbox(mkEnv(rows(4), up), {
    embed: async (t) => [Number(t.split(" ")[1])],
    // Returns 1 vector for 4 texts, and a value that is WRONG for every chunk,
    // so a passing test cannot be a coincidence of the right number appearing.
    embedBatch: async () => [[999]],
    embedGroup: 4,
  });
  check("a short batch response is rejected, not misaligned", up.every((v, i) => v.values[0] === i),
    JSON.stringify(up.map((v) => v.values[0])));
  check("and every chunk still drains via the per-item fallback", r.drained === 4, JSON.stringify(r));
}

/* ---- poison isolation survives batching ---- */
{
  const up = [], del = [], upd = [];
  const r = await drainOutbox(mkEnv([
    { chunk_uid: "ok1#0", text: "fine", source: "s", doc_uid: "a" },
    { chunk_uid: "poison#0", text: "BAD", source: "s", doc_uid: "p" },
    { chunk_uid: "ok2#0", text: "also fine", source: "s", doc_uid: "b" },
  ], up, del, upd), {
    embed: async (t) => { if (t === "BAD") throw new Error("no embedding"); return [0.1]; },
    embedBatch: async (texts) => { if (texts.includes("BAD")) throw new Error("group failed"); return texts.map(() => [0.1]); },
    embedGroup: 50,
  });
  check("a failed group does NOT poison its innocent members", r.drained === 2, JSON.stringify(r));
  check("only the genuinely bad chunk is quarantined", r.failed === 1 && upd.includes("poison#0"), JSON.stringify(upd));
  check("and the good ones leave the queue", del.length === 2 && !del.includes("poison#0"), JSON.stringify(del));
}

/* ---- without embedBatch, behaviour is exactly as before ---- */
{
  const up = []; let single = 0;
  const r = await drainOutbox(mkEnv(rows(3), up), { embed: async () => { single++; return [0.1]; } });
  check("a caller that passes no embedBatch still works", r.drained === 3 && single === 3, `single=${single}`);
}

console.log(`\ndrain throughput: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
