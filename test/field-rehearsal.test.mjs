// The credentials below are SYNTHETIC fixtures, not real. They exist because
// the gate was accepting a real-shaped admin key while refusing source code
// that merely mentioned one, and both directions need pinning.

import { vectorIdFor, VECTOR_ID_MAX_BYTES, drainOutbox } from "../worker/src/lib/store-d1.js";
import { relative, sep } from "node:path";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

/* ---- field blocker 1: vector ids must fit, always ---- */
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

  // The exact field case was 67 bytes, just over.
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
          all: async () => ({ results: /WHERE op = 'delete'/.test(q) ? [] : rows }),
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

/* ---- field blocker 2: module specifiers are URLs, not paths ---- */
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../brain.mjs", import.meta.url), "utf-8");
  check("deploy normalises separators for module names",
    /relative\(srcRoot, f\)\.split\(sep\)\.join\("\/"\)/.test(src),
    "a Windows deploy uploads lib\\core.js and the worker cannot resolve it");
  const winStyle = "lib\\core.js".split("\\").join("/");
  check("the transform produces what the worker imports", winStyle === "lib/core.js");
}

/* ---- the credential gate was wrong in BOTH directions ----
   Found when a field report quoted a line of our own source and the
   scanner refused the report. Worse than the false positive: it ACCEPTED a real
   hex admin key, because a bare hex value is allowlisted as a probable git SHA
   unless the surrounding text is recognised as secret context, and the list did
   not include the name of the key this product generates for itself. */
{
  const { scan } = await import("../worker/src/lib/secret-scan.js");
  const mustPass = [
    ["  const adminKey = resolveAdminKey(manifestPath);", "our own source"],
    ["const clientSecret = process.env.GOOGLE_CLIENT_SECRET;", "an env reference"],
    ["api_key: opts.apiKey", "a property reference"],
    ["ADMIN_KEY=your-key-here", "a placeholder"],
    ["password: <your password>", "a documented placeholder"],
    ["commit 8f3a2b1c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a", "a git SHA"],
  ];
  for (const [t, d] of mustPass) {
    check(`gate accepts ${d}`, !scan(t).shouldRefuse, JSON.stringify(scan(t).labels));
  }
  const mustRefuse = [
    ["ADMIN_KEY=8f3a2b1c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a", "the admin key this product generates"],
    ["BRAIN_KEY=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", "the same key under its MCP name"],
    ['client_secret: "GOCSPX-8fJ2kL9mN0pQrS3tU4vW5xY6z"', "a real client secret"],
    ["webhook_secret = whsec_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p", "a real webhook secret"],
  ];
  for (const [t, d] of mustRefuse) {
    check(`gate refuses ${d}`, scan(t).shouldRefuse, "PASSED a real credential");
  }
  // A refusal must never quote the value back.
  const r = scan("ADMIN_KEY=8f3a2b1c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a");
  check("and never echoes the secret it refused", !JSON.stringify(r).includes("2b1c9d4e5f6a"), JSON.stringify(r));
}

/* ---- a dry run sends nothing, so it must not demand credentials ---- */
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../brain.mjs", import.meta.url), "utf-8");
  const body = src.slice(src.indexOf("async function cmdIngest(manifestPath)"));
  check("dry-run and a saved domain skip account resolution",
    /const acct = dry \? null : m\.brain\?\.domain \? null : await resolveAccount/.test(body));
  check("dry-run skips the admin key", /const adminKey = dry \? null : resolveAdminKey/.test(body));
}

/* ---- the RECOVERY path, which a fresh install does not represent ----
   Rows queued by an older build drain and embed fine, then stay unreachable by
   meaning unless the id they were actually stored under is written back. A
   fresh install hides this, because ingest writes the column. Only replaying a
   real old install through the upgrade exposes it. */
{
  const stored = [];
  const env = {
    DB: {
      prepare(q) {
        const shape = (b = []) => ({
          all: async () => ({ results: /WHERE op = 'delete'/.test(q) ? [] : [
            // 97 bytes: exactly the shape that must be hashed
            { chunk_uid: "docs:Financial/2026/Q3 Statements/Wells Fargo Business Checking Statement 2026-07 Reconciled.md#0", text: "t", source: "docs", doc_uid: "d" },
          ] }),
          first: async () => ({ n: 0 }),
          run: async () => ({}),
          _q: q, _b: b,
        });
        const o = shape();
        o.bind = (...b) => shape(b);
        return o;
      },
      batch: async (stmts) => {
        for (const st of stmts) {
          if (/UPDATE chunks SET vector_id/.test(st._q)) stored.push(st._b);
        }
      },
    },
    VECTORIZE: { upsert: async (v) => { stored.push(["__upserted__", v[0].id]); } },
  };
  const r = await drainOutbox(env, { embed: async () => [0.1] });
  const upserted = stored.find((x) => x[0] === "__upserted__");
  check("a long chunk_uid is stored under a hashed id", upserted && upserted[1].startsWith("h:"), JSON.stringify(upserted));
  const written = stored.find((x) => x[0] !== "__upserted__" && String(x[1] || "").startsWith("h:"));
  check("and the drain writes that id BACK to the chunk row", !!written,
    "without this the chunk embeds and is then unreachable by meaning, keyword-only and silent");
  check("the drain still reports success", r.drained === 1, JSON.stringify(r));
}

console.log(fail ? `\n${fail} FAILURES` : `\nfield-rehearsal: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
