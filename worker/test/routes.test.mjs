import worker from "../src/index.js";
import { filterSql, unsupportedFilters } from "../src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

/* A D1 env that records what SQL it was asked to run, so a filter that never
   reached the database is a visible failure rather than a silent one. */
function mkEnv(rows, { vectorIds = [], vectorThrows = false, extra = {} } = {}) {
  const seen = { sql: [], binds: [], vectorQueries: [] };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      prepare(sql) {
        seen.sql.push(sql);
        return {
          bind(...b) { seen.binds.push(b); return this; },
          all: async () => ({ results: rows }),
          first: async () => (/count\(\*\)/.test(sql) ? { n: 0 } : null),
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
    VECTORIZE: {
      query: async (_embedding, options) => {
        seen.vectorQueries.push(options);
        if (vectorThrows) throw new Error("no metadata index");
        return { matches: vectorIds.map((id) => ({ id })) };
      },
      upsert: async () => {},
    },
    AI: {
      run: async (model, input) => model.includes("bge-")
        ? ({ data: [[0.1, 0.2, 0.3]] })
        : String(input?.messages?.[0]?.content || "").includes("strict evidence gate")
          ? ({ response: '{"supported":true,"evidence":[1],"reason":"direct support"}', usage: { prompt_tokens: 100, completion_tokens: 12 } })
          : ({ response: "The Cloudflare answer is grounded in the result [1].", usage: { prompt_tokens: 100, completion_tokens: 12 } }),
    },
    ...extra,
  };
  return { env, seen };
}

const ROW = {
  chunk_uid: "meeting:123#0", doc_uid: "meeting:123", text: "We agreed to defer the retainer.",
  source: "meeting", source_id: "123", uri: "meeting://123", title: "Q3 sync", document_date: 1750000000000, client: "Acme", category: "meeting",
  top_folder: "Clients", platform: "imessage",
};
const call = (env, path) => worker.fetch(new Request("https://b.example" + path, { headers: { "X-Admin-Key": "k" } }), env, { waitUntil() {}, passThroughOnException() {} });

/* ---- auth still gates everything but health ---- */
{
  const { env } = mkEnv([]);
  const open = await worker.fetch(new Request("https://b.example/health"), env, {});
  check("health is open", open.status === 200);
  const shut = await worker.fetch(new Request("https://b.example/api/rag/unified?q=x"), env, {});
  check("unified needs the admin key", shut.status === 401, String(shut.status));
  const querySecret = await worker.fetch(new Request("https://b.example/api/rag/unified?q=x&admin_key=k"), env, {});
  check("admin keys in query strings are refused", querySecret.status === 401, String(querySecret.status));
}

/* ---- the D1 path answers, with the contract shape ---- */
{
  const { env } = mkEnv([ROW], { vectorIds: ["meeting:123#0"] });
  const r = await call(env, "/api/rag/unified?q=retainer&limit=5");
  const b = await r.json();
  check("unified returns results from D1", r.status === 200 && b.results.length === 1, JSON.stringify(b).slice(0, 200));
  check("a hit carries its document date", b.results[0].ts === new Date(1750000000000).toISOString());
  check("and its client", b.results[0].client === "Acme");
  check("a hit exposes stable document identity, not its chunk id", b.results[0].ref_key === "123" && b.results[0].chunk_uid === "meeting:123#0", JSON.stringify(b.results[0]));
}

/* Multiple matching chunks from one document consume one public result slot. */
{
  const second = { ...ROW, chunk_uid: "meeting:123#1", text: "The follow-up said the same thing." };
  const { env } = mkEnv([ROW, second], { vectorIds: ["meeting:123#0", "meeting:123#1"] });
  const b = await (await call(env, "/api/rag/unified?q=retainer&limit=5")).json();
  check("one document cannot crowd out the result page with repeat chunks", b.results.length === 1, JSON.stringify(b.results));
}

/* ---- a filter must reach the database, not be dropped on the floor ---- */
{
  const { env, seen } = mkEnv([ROW], { vectorIds: [] });
  await call(env, "/api/rag/unified?q=retainer&client=Acme&from=2025-01-01");
  const kw = seen.sql.find((s) => /chunks_fts MATCH/.test(s));
  check("client filter is in the SQL", /c\.client = \?/.test(kw), kw);
  check("date filter is in the SQL", /c\.document_date >= \?/.test(kw), kw);
  const bind = seen.binds.find((b) => b.includes("Acme"));
  check("and its value is bound", !!bind && bind.includes(Date.parse("2025-01-01")), JSON.stringify(bind));
}

/* ---- every public filter must narrow BOTH Vectorize and exact D1 hydration ---- */
{
  const { env, seen } = mkEnv([ROW], { vectorIds: ["meeting:123#0"] });
  const path = "/api/rag/unified?q=x&platform=imessage&top_folder=Clients&category=meeting&to=2025-12-31";
  const b = await (await call(env, path)).json();
  check("the D1 backend honors every public filter", (b.ignored_filters || []).length === 0, JSON.stringify(b.ignored_filters));
  const query = seen.vectorQueries[0];
  check("platform reaches Vectorize before topK", query.filter.platform.$eq === "imessage", JSON.stringify(query));
  check("top_folder reaches Vectorize before topK", query.filter.top_folder.$eq === "Clients", JSON.stringify(query));
  check("category reaches Vectorize before topK", query.filter.category.$eq === "meeting", JSON.stringify(query));
  check("date reaches Vectorize as a numeric range", query.filter.document_date.$lte === Date.parse("2025-12-31"), JSON.stringify(query));

  const hydration = seen.sql.find((s) => /FROM chunks c JOIN documents d/.test(s) && /c\.chunk_uid IN/.test(s));
  check("platform is re-applied in D1 hydration", /c\.platform = \?/.test(hydration), hydration);
  check("top_folder is re-applied in D1 hydration", /c\.top_folder = \?/.test(hydration), hydration);

  const t = await (await call(env, "/api/rag/think?q=x&platform=imessage")).json();
  const g = (t.gaps || []).find((x) => x.type === "filter_not_applied");
  check("think does not claim a supported platform filter was ignored", !g, JSON.stringify(t.gaps));
}
{
  const { env } = mkEnv([ROW]);
  check("supported filters are never flagged", unsupportedFilters({ client: "A", top_folder: "Clients", platform: "imessage", from: "2025-01-01" }).length === 0);
}

/* ---- vector down is a degraded answer, not an empty corpus ---- */
{
  const { env } = mkEnv([ROW], { vectorIds: [] });
  const t = await (await call(env, "/api/rag/think?q=retainer")).json();
  check("vector outage surfaces as a gap", (t.gaps || []).some((g) => g.type === "vector_unavailable"), JSON.stringify(t.gaps));
  check("and results still come back", (t.results || []).length === 1);
  check("Workers AI writes the cited answer without a vendor key", /Cloudflare answer/.test(t.answer || ""), JSON.stringify(t));
  check("and reports the Cloudflare model", String(t.model || "").startsWith("@cf/"), String(t.model));
}

{
  const generations = [];
  const { env } = mkEnv([ROW], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          generations.push(input);
          if (String(input?.messages?.[0]?.content || "").includes("strict evidence gate")) {
            return { response: '{"supported":true,"evidence":[1],"reason":"direct support"}', usage: {} };
          }
          return { response: "The documents do not actually answer the question.", usage: {} };
        },
      },
    },
  });
  await call(env, "/api/rag/think?q=What+is+our+parental+leave+policy");
  const generation = generations.find((input) => /second brain/.test(input?.messages?.[0]?.content || ""));
  const gate = generations.find((input) => /strict evidence gate/.test(input?.messages?.[0]?.content || ""));
  const system = generation?.messages?.find((message) => message.role === "system")?.content || "";
  check("both evidence gating and answer generation are deterministic", gate?.temperature === 0 && generation?.temperature === 0, JSON.stringify(generations));
  check("the evidence gate requires every material part and exact subject", /every material part/.test(gate?.messages?.[0]?.content || ""), JSON.stringify(gate));
  check("the answer contract forbids cross-entity evidence transfer", /different entity or context/.test(system), system);
  check("ambiguous owner context requires an explicit evidence tie", /tie it to the brain owner/.test(system), system);
}

{
  let modelCalls = 0;
  const { env } = mkEnv([ROW], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          modelCalls++;
          return { response: '{"supported":false,"evidence":[],"reason":"different company"}', usage: {} };
        },
      },
    },
  });
  const body = await (await call(env, "/api/rag/think?q=What+is+our+parental+leave+policy")).json();
  check("unsupported evidence refuses before answer generation", modelCalls === 1 && body.answer === "The documents do not actually answer the question.", JSON.stringify(body));
  check("unsupported candidates are not exposed as answer citations", body.citations?.length === 0, JSON.stringify(body.citations));
}

/* ---- a missing metadata index must not take search down ---- */
{
  const { env } = mkEnv([ROW], { vectorThrows: true });
  const r = await call(env, "/api/rag/unified?q=x&source=meeting");
  check("vectorize filter failure is survivable", r.status === 200, String(r.status));
}

/* ---- placeholder numbering: the bug class that silently misbinds ---- */
{
  const f = filterSql({ source: "meeting", client: "Acme" }, "c", 5);
  check("params are numbered from the offset", f.clause.includes("?5") && f.clause.includes("?6"), f.clause);
  check("and returned in the same order", f.params[0] === "meeting" && f.params[1] === "Acme");
}

/* ---- the credential gate still stands in front of the new write path ---- */
{
  const { env } = mkEnv([]);
  const r = await worker.fetch(new Request("https://b.example/api/admin/brain/ingest", {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source_type: "note", source_id: "1", content: "key sk-ant-api03-" + "A".repeat(95) }),
  }), env, {});
  check("ingest refuses a live credential", r.status === 422, String(r.status));
}

/* ---- documents reports the backend and the vector backlog ---- */
{
  const { env } = mkEnv([{ source_type: "meeting", total: 4, embedded: 4, last_ingest_at: 1750000000000 }]);
  const b = await (await call(env, "/api/admin/brain/documents")).json();
  check("documents names the backend", b.backend === "d1", JSON.stringify(b));
  check("and reports vector backlog", b.vector_backlog && "pending" in b.vector_backlog, JSON.stringify(b.vector_backlog));
}

/* ================= batch ingest ================= */

// A batch env whose ingest can be made to explode on a chosen document, so the
// partial-failure path is exercised rather than assumed.
function mkBatchEnv({ explodeOn = null } = {}) {
  const written = [];
  const env = {
    STORAGE: "d1", ADMIN_KEY: "k",
    VECTORIZE: { query: async () => ({ matches: [] }), upsert: async () => {} },
    AI: { run: async () => ({ data: [[0.1]] }) },
    DB: {
      prepare: (sql) => ({
        bind: (...b) => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => {
            if (/INSERT INTO documents/.test(sql)) {
              if (explodeOn && String(b[2]) === explodeOn) throw new Error("D1 write failed");
              written.push(String(b[2]));
            }
            return {};
          },
        }),
      }),
      batch: async () => {},
    },
  };
  return { env, written };
}
const post = (env, path, body) =>
  worker.fetch(new Request("https://b.example" + path, {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, { waitUntil() {}, passThroughOnException() {} });

const doc = (id, content = "some ordinary meeting content about the retainer") =>
  ({ source_type: "meeting", source_id: id, title: `T${id}`, content });

{
  const { env } = mkBatchEnv();
  const r = await post(env, "/api/admin/brain/ingest/batch", { docs: [doc("a"), doc("b"), doc("c")] });
  const b = await r.json();
  check("batch ingests every document", b.total === 3 && b.created === 3, JSON.stringify(b).slice(0, 200));
  check("and reports one result slot per document", b.results.length === 3);
  check("each slot names its source_id, so a caller can resume precisely",
    b.results.every((x, i) => x.source_id === ["a", "b", "c"][i]), JSON.stringify(b.results));
}

/* One bad document must not cost the other 49. */
{
  const { env, written } = mkBatchEnv({ explodeOn: "b" });
  const b = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [doc("a"), doc("b"), doc("c")] })).json();
  check("a failing document does not fail the batch", b.created === 2 && b.failed === 1, JSON.stringify(b).slice(0, 250));
  check("the good documents were actually written", written.includes("a") && written.includes("c"), JSON.stringify(written));
  const bad = b.results.find((x) => x.source_id === "b");
  check("the failure is attributed to its own document", bad && bad.status === "failed" && bad.error, JSON.stringify(bad));
}

/* The gate applies per document, and must not leak the value it refused. */
{
  const { env, written } = mkBatchEnv();
  const leak = "key sk-ant-api03-" + "A".repeat(95);
  const b = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [doc("a"), doc("bad", leak), doc("c")] })).json();
  check("a credential refuses only its own document", b.refused === 1 && b.created === 2, JSON.stringify(b).slice(0, 250));
  check("and that document was never written", !written.includes("bad"), JSON.stringify(written));
  const ref = b.results.find((x) => x.source_id === "bad");
  check("the refusal names the credential type", ref && ref.labels && ref.labels.length, JSON.stringify(ref));
  check("but never echoes the secret back", !JSON.stringify(b).includes("A".repeat(20)), "SECRET ECHOED IN RESPONSE");
}

/* Caps: a Worker killed mid-batch looks exactly like data loss. */
{
  const { env } = mkBatchEnv();
  const many = Array.from({ length: 51 }, (_, i) => doc("d" + i));
  const r = await post(env, "/api/admin/brain/ingest/batch", { docs: many });
  check("too many documents is refused up front, not part-way", r.status === 413, String(r.status));

  const huge = [doc("big", "x".repeat(1_000_001))];
  const r2 = await post(env, "/api/admin/brain/ingest/batch", { docs: huge });
  check("an oversized payload is refused with the limit stated", r2.status === 413, String(r2.status));
  check("and the caller is told what to do", (await r2.json()).detail?.includes("split"), "no remediation given");

  check("an empty batch is a 400, not a silent success", (await post(env, "/api/admin/brain/ingest/batch", { docs: [] })).status === 400);
  check("a malformed body is a 400", (await post(env, "/api/admin/brain/ingest/batch", { nope: 1 })).status === 400);
}

/* A document missing required fields is reported, not silently skipped. */
{
  const { env } = mkBatchEnv();
  const b = await (await post(env, "/api/admin/brain/ingest/batch", {
    docs: [doc("a"), { source_type: "meeting", source_id: "x" }, { source_id: "y", content: "hi" }],
  })).json();
  check("invalid documents are counted as failures", b.failed === 2 && b.created === 1, JSON.stringify(b).slice(0, 250));
  check("and every input has a result slot", b.results.length === 3);
}

/* ================= forget ================= */

function mkForgetEnv({ vectorThrows = false } = {}) {
  const sql = [];
  const deleted = [];
  const env = {
    STORAGE: "d1", ADMIN_KEY: "k",
    VECTORIZE: {
      query: async () => ({ matches: [] }),
      deleteByIds: async (ids) => { if (vectorThrows) throw new Error("vectorize down"); deleted.push(...ids); },
    },
    AI: { run: async () => ({ data: [[0.1]] }) },
    DB: {
      prepare(q) {
        return {
          bind: (...b) => ({
            all: async () => ({
              results: /FROM documents WHERE source/.test(q)
                ? [{ doc_uid: "meeting:1" }, { doc_uid: "meeting:2" }]
                : /FROM chunks WHERE doc_uid/.test(q)
                  ? [{ chunk_uid: "meeting:1#0" }, { chunk_uid: "meeting:1#1" }, { chunk_uid: "meeting:2#0" }]
                  : [],
            }),
            first: async () => null,
            run: async () => { sql.push(q); return {}; },
          }),
        };
      },
      batch: async (stmts) => { sql.push("BATCH:" + stmts.length); },
    },
  };
  return { env, sql, deleted };
}

{
  const { env, deleted, sql } = mkForgetEnv();
  const b = await (await post(env, "/api/admin/brain/forget", { source: "meeting" })).json();
  // Irreversible, so it must be asked for explicitly rather than by default.
  check("forget DRY RUNS unless confirmed", b.dry_run === true, JSON.stringify(b));
  check("and reports what it would remove", b.documents === 2 && b.chunks === 3, JSON.stringify(b));
  check("without deleting any vectors", deleted.length === 0);
  check("or touching the database", !sql.some((q) => /BATCH/.test(q)), JSON.stringify(sql));
}
{
  const { env, deleted, sql } = mkForgetEnv();
  const b = await (await post(env, "/api/admin/brain/forget", { source: "meeting", confirm: true })).json();
  check("confirm actually deletes", b.dry_run === false && b.documents === 2, JSON.stringify(b));
  check("every vector is removed too", deleted.length === 3, JSON.stringify(deleted));
  check("and D1 rows go first, so a crash leaves it unreachable rather than half-visible",
    sql.some((q) => /BATCH/.test(q)), JSON.stringify(sql));
}
{
  const { env } = mkForgetEnv();
  const b = await (await post(env, "/api/admin/brain/forget", { doc_uids: ["meeting:1"], confirm: true })).json();
  check("individual documents can be removed by id", b.documents === 1, JSON.stringify(b));
}
{
  // The document is already unreachable at this point; a caller told "deleted"
  // while vectors remain still deserves to know.
  const { env } = mkForgetEnv({ vectorThrows: true });
  const b = await (await post(env, "/api/admin/brain/forget", { source: "meeting", confirm: true })).json();
  check("a vector-delete failure is REPORTED, not swallowed", !!b.vector_error, JSON.stringify(b));
  check("and the D1 delete still counted", b.documents === 2);
}
{
  const { env } = mkForgetEnv();
  check("forget needs a target", (await post(env, "/api/admin/brain/forget", {})).status === 400);
  check("a malformed body is a 400", (await post(env, "/api/admin/brain/forget", null)).status === 400);
  const sup = { ...env, STORAGE: "supabase", SUPABASE_URL: "x" };
  check("and it refuses on a non-D1 backend rather than pretending", (await post(sup, "/api/admin/brain/forget", { source: "a" })).status === 400);
}
{
  const { env } = mkForgetEnv();
  const r = await worker.fetch(new Request("https://b.example/api/admin/brain/forget", { method: "POST", body: "{}" }), env, {});
  check("forget is behind the admin key", r.status === 401, String(r.status));
}

console.log(fail ? `\n${fail} FAILURES` : `\nroutes: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
