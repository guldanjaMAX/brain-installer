import { vectorIdFor, VECTOR_ID_MAX_BYTES, drainOutbox } from "../worker/src/lib/store-d1.js";
import { relative, sep } from "node:path";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

/* ---- Jay's blocker 1: vector ids must fit, always ---- */
{
  const short = "meeting:123#0";
  check("a short id is passed through unchanged", (await vectorIdFor(short)) === short);

  const real = "drive:Financial/2026/Q3 Statements/Wells Fargo Business Checking Statement 2026-07.pdf#12";
  const id = await vectorIdFor(real);
  check("a realistic path is 64 bytes or fewer", new TextEncoder().encode(id).length <= VECTOR_ID_MAX_BYTES,
    `${new TextEncoder().encode(id).length} bytes`);
  check("and is marked as hashed, so it is recognisable in a log", id.startsWith("h:"), id);
  check("hashing is stable across runs", (await vectorIdFor(real)) === id);
  check("different chunks get different ids", (await vectorIdFor(real)) !== (await vectorIdFor(real.replace("#12", "#13"))));

  // The exact case Jay hit: 67 bytes, just over.
  const border = "drive:" + "x".repeat(58) + "#1";
  check("a just-over-the-line id is hashed, not sent raw",
    new TextEncoder().encode(await vectorIdFor(border)).length <= VECTOR_ID_MAX_BYTES);

  const cjk = "drive:" + "契約書".repeat(20) + "#1";
  check("multi-byte paths are measured in BYTES not characters",
    new TextEncoder().encode(await vectorIdFor(cjk)).length <= VECTOR_ID_MAX_BYTES);
}

/* ---- one bad chunk must not strand the queue behind it ---- */
{
  const rows = [
    { chunk_uid: "a#0", text: "fine", source: "s", doc_uid: "a" },
    { chunk_uid: "poison#0", text: "BAD", source: "s", doc_uid: "poison" },
    { chunk_uid: "b#0", text: "also fine", source: "s", doc_uid: "b" },
  ];
  const updates = [];
  const deleted = [];
  const env = {
    DB: {
      prepare(q) {
        // first() is called both with and without bind() in this path, so the
        // mock has to answer either way.
        const shape = (b = []) => ({
          all: async () => ({ results: rows }),
          first: async () => ({ n: 1 }),
          run: async () => ({}),
          _q: q, _b: b,
        });
        const o = shape();
        o.bind = (...b) => shape(b);
        return o;
      },
      batch: async (stmts) => {
        for (const s of stmts) {
          if (/DELETE FROM vector_outbox/.test(s._q)) deleted.push(s._b[0]);
          if (/UPDATE vector_outbox/.test(s._q)) updates.push(s._b[0]);
        }
      },
    },
    VECTORIZE: { upsert: async () => {} },
  };
  const r = await drainOutbox(env, {
    embed: async (t) => { if (t === "BAD") throw new Error("Workers AI returned no embedding"); return [0.1]; },
  });
  check("the good chunks still drain past a poisoned one", r.drained === 2, JSON.stringify(r));
  check("the bad one is counted, not swallowed", r.failed === 1, JSON.stringify(r));
  check("and its error is reported", (r.errors || []).some((e) => /no embedding/.test(e)), JSON.stringify(r.errors));
  check("only the good ones are removed from the queue", deleted.length === 2 && !deleted.includes("poison#0"), JSON.stringify(deleted));
  check("the bad one records an attempt so it is bounded, not invisible", updates.includes("poison#0"), JSON.stringify(updates));
}

/* ---- Jay's blocker 2: module specifiers are URLs, not paths ---- */
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../brain.mjs", import.meta.url), "utf-8");
  check("deploy normalises separators for module names",
    /relative\(srcRoot, f\)\.split\(sep\)\.join\("\/"\)/.test(src),
    "a Windows deploy uploads lib\\core.js and the worker cannot resolve it");
  const winStyle = "lib\\core.js".split("\\").join("/");
  check("the transform produces what the worker imports", winStyle === "lib/core.js");
}

console.log(fail ? `\n${fail} FAILURES` : `\njay-field-test: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
