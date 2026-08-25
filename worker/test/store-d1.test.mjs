import { forget, fuseRRF, search, upsertChunks, replaceDocumentChunks, metadataTokenFor, vectorFilterFor } from "../src/lib/store-d1.js";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

/* ---- RRF: the arithmetic, and the property that matters ---- */
{
  const vec = [{ chunk_uid: "a" }, { chunk_uid: "b" }, { chunk_uid: "c" }];
  const kw  = [{ chunk_uid: "c" }, { chunk_uid: "d" }];
  const out = fuseRRF([{ items: vec }, { items: kw }]);
  // c is rank 3 in vectors and rank 1 in keywords: 1/63 + 1/61 beats a's 1/61.
  check("appearing in both lists wins", out[0].chunk_uid === "c", out[0].chunk_uid);
  check("union of both lists", out.length === 4, String(out.length));
  check("absence is not a penalty", out.some(r => r.chunk_uid === "d"));
  const exp = 1 / 63 + 1 / 61;
  check("score is the RRF sum", Math.abs(out[0].rrf_score - exp) < 1e-9, `${out[0].rrf_score} vs ${exp}`);

  // Weighting a list must actually move the order.
  const wOut = fuseRRF([{ items: vec, weight: 5 }, { items: kw, weight: 0.1 }]);
  check("weights change the ranking", wOut[0].chunk_uid === "a", wOut[0].chunk_uid);
  check("empty input does not throw", fuseRRF([]).length === 0);
  check("a list of nothing is ignored", fuseRRF([{ items: [] }, { items: vec }])[0].chunk_uid === "a");
  // A malformed item without a uid must not become an "undefined" bucket.
  check("items without a uid are skipped", fuseRRF([{ items: [{}, { chunk_uid: "z" }] }]).length === 1);
}

/* ---- Vectorize metadata must be exact and use the same encoding at query time ---- */
{
  const shared = "A".repeat(64);
  const a = await metadataTokenFor(shared + " first");
  const b = await metadataTokenFor(shared + " second");
  check("long metadata values are hashed instead of truncated", a.startsWith("h:") && b.startsWith("h:"));
  check("long values sharing 64 bytes remain distinguishable", a !== b, `${a} ${b}`);
  check("metadata tokens fit Vectorize's 64-byte indexed limit", new TextEncoder().encode(a).length <= 64);

  const f = await vectorFilterFor({
    source: "drive", client: shared + " first", category: "medical",
    top_folder: "Provider Records", platform: "drive", from: "2025-01-01", to: "2025-12-31",
  });
  check("the query hashes a long value with the same token", f.client.$eq === a, JSON.stringify(f));
  check("all exact filter dimensions reach Vectorize", ["source", "client", "category", "top_folder", "platform"].every((k) => f[k]?.$eq), JSON.stringify(f));
  check("both date bounds reach Vectorize", f.document_date.$gte === Date.parse("2025-01-01") && f.document_date.$lte === Date.parse("2025-12-31"), JSON.stringify(f));
}

/* ---- degraded detection: one system down is NOT an empty corpus ---- */
{
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ chunk_uid: "k1", text: "t", source: "s" }] }) }) }) },
    VECTORIZE: { query: async () => { throw new Error("vectorize down"); } },
  };
  const r = await search(env, { query: "hello", embedding: [0.1], limit: 5 });
  check("keyword survives a vector outage", r.results.length === 1, String(r.results.length));
  check("outage is reported as degraded", r.degraded === "vector", String(r.degraded));
  check("counts show which side answered", r.counts.keyword === 1 && r.counts.vector === 0, JSON.stringify(r.counts));
}

/* ---- genuinely empty is distinguishable from degraded ---- */
{
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    VECTORIZE: { query: async () => ({ matches: [] }) },
  };
  const r = await search(env, { query: "nothing", embedding: [0.1], limit: 5 });
  check("empty corpus is not marked degraded", r.degraded === null, String(r.degraded));
  check("empty returns no results", r.results.length === 0);
}

/* ---- document dedupe happens before the public result limit ---- */
{
  const repeated = Array.from({ length: 10 }, (_, i) => ({
    chunk_uid: `d1#${i}`, doc_uid: "d1", source_id: "d1", text: `repeat ${i}`, source: "drive",
  }));
  const distinct = { chunk_uid: "d2#0", doc_uid: "d2", source_id: "d2", text: "different", source: "drive" };
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [...repeated, distinct] }) }) }) },
  };
  const r = await search(env, { query: "hello", embedding: null, limit: 2 });
  check("repeat chunks cannot evict a different document before the limit", r.results.map((x) => x.doc_uid).join(",") === "d1,d2", JSON.stringify(r.results));
}

/* ---- vector hydration must preserve Vectorize's ordering ---- */
{
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          // Return rows in the WRONG order on purpose.
          all: async () => ({ results: [...ids].reverse().map(id => ({ chunk_uid: id, text: id, source: "s" })) }),
        }),
      }),
    },
    VECTORIZE: { query: async () => ({ matches: [{ id: "v1" }, { id: "v2" }, { id: "v3" }] }) },
  };
  const r = await search(env, { query: "", embedding: [0.1], limit: 5 });
  const order = r.results.map(x => x.chunk_uid);
  check("vector rank survives DB row order", order[0] === "v1", JSON.stringify(order));
}

/* ---- writes go to D1 first, and always queue a vector ---- */
{
  const batched = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({ _sql: sql, _args: a }) }), batch: async (s) => { batched.push(...s); } } };
  const out = await upsertChunks(env, [{ chunk_uid: "c1", doc_uid: "d1", chunk_ix: 0, text: "x", source: "drive" }]);
  check("one chunk writes two statements", batched.length === 2, String(batched.length));
  check("chunk row is written", batched[0]._sql.includes("INSERT INTO chunks"));
  check("chunk row carries top_folder and platform", batched[0]._sql.includes("top_folder") && batched[0]._sql.includes("platform"));
  check("and a vector is queued", batched[1]._sql.includes("vector_outbox"));
  check("reports what it queued", out.queued === 1);
  check("empty input writes nothing", (await upsertChunks(env, [])).written === 0);
}

/* ---- stale revisions cannot delete or replace a newer revision's chunks ---- */
{
  const batched = [];
  const env = {
    DB: {
      prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }),
      batch: async (statements) => { batched.push(statements); return statements.map(() => ({})); },
    },
  };
  const marker = `pending:${"a".repeat(64)}:${"b".repeat(32)}`;
  await replaceDocumentChunks(env, "message:guarded", { expectedContentHash: marker });
  await upsertChunks(env, [{
    chunk_uid: "message:guarded#0", doc_uid: "message:guarded", chunk_ix: 0,
    text: "synthetic", source: "message",
  }], { expectedContentHash: marker });
  const statements = batched.flat();
  check("guarded replacement conditions both deletion statements on marker ownership",
    statements.slice(0, 2).every((statement) => /content_hash\s*=/.test(statement.sql) && statement.args.includes(marker)),
    statements.slice(0, 2).map((statement) => statement.sql).join("\n"));
  check("guarded chunk and outbox writes require the same marker",
    statements.slice(2).every((statement) => /content_hash\s*=/.test(statement.sql) && statement.args.includes(marker)),
    statements.slice(2).map((statement) => statement.sql).join("\n"));
}

/* ---- source forget must stay below D1's 100-variable statement limit ---- */
{
  const docs = Array.from({ length: 205 }, (_, i) => ({ doc_uid: `drive:${i}` }));
  let maxBinds = 0;
  let maxStatements = 0;
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => {
          maxBinds = Math.max(maxBinds, args.length);
          if (args.length > 100) throw new Error("D1 variable limit exceeded");
          return {
            _args: args,
            all: async () => ({
              results: /SELECT doc_uid FROM documents/.test(sql)
                ? docs
                : /SELECT chunk_uid, vector_id FROM chunks/.test(sql)
                  ? args.map((id) => ({ chunk_uid: `${id}#0`, vector_id: `${id}#0` }))
                  : [],
            }),
            run: async () => ({}),
          };
        },
      }),
      batch: async (statements) => {
        maxStatements = Math.max(maxStatements, statements.length);
        if (statements.length > 100) throw new Error("D1 batch statement limit exceeded");
        for (const statement of statements) maxBinds = Math.max(maxBinds, statement?._args?.length || 0);
      },
    },
    VECTORIZE: { deleteByIds: async () => {} },
  };
  const removed = await forget(env, { source: "drive", dryRun: false });
  check("forget handles more than 100 documents", removed.documents === 205 && removed.vectors === 205, JSON.stringify(removed));
  check("forget never exceeds D1's bind ceiling", maxBinds <= 100, String(maxBinds));
  check("vector cleanup never exceeds D1's batch-statement ceiling", maxStatements <= 100, String(maxStatements));
}

console.log(fail ? `\n${fail} FAILURES` : `\nstore-d1: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
