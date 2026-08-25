import worker from "../src/index.js";
import { filterSql, unsupportedFilters } from "../src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

/* A D1 env that records what SQL it was asked to run, so a filter that never
   reached the database is a visible failure rather than a silent one. */
function mkEnv(rows, { vectorIds = [], vectorThrows = false, countRow = null, extra = {} } = {}) {
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
          first: async () => (/count\(\*\)/i.test(sql)
            ? (countRow || { n: 0, stored_documents: 0, logical_documents: 0 })
            : null),
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
        : String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
          ? ({ response: { supported: true, complete: true, evidence: [1], reason: "direct support" }, usage: { prompt_tokens: 100, completion_tokens: 12 } })
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
const call = (env, path) => {
  const url = new URL("https://b.example" + path);
  const isRag = url.pathname === "/api/rag/unified" || url.pathname === "/api/rag/think";
  const isSourceFamilies = url.pathname === "/api/admin/brain/source-families";
  const init = { headers: { "X-Admin-Key": "k" } };
  if (isRag || isSourceFamilies) {
    const body = Object.fromEntries(url.searchParams);
    if (isSourceFamilies && body.limit !== undefined) body.limit = Number(body.limit);
    url.search = "";
    init.method = "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return worker.fetch(new Request(url, init), env, { waitUntil() {}, passThroughOnException() {} });
};

/* ---- auth still gates everything but health ---- */
{
  const { env } = mkEnv([], { extra: { RAG_PROXY_KEY: "read-only" } });
  const open = await worker.fetch(new Request("https://b.example/health"), env, {});
  check("health is open", open.status === 200);
  const shut = await worker.fetch(new Request("https://b.example/api/rag/unified", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "x" }),
  }), env, {});
  check("unified needs the admin key", shut.status === 401, String(shut.status));
  const querySecret = await worker.fetch(new Request("https://b.example/api/rag/unified?admin_key=k", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "x" }),
  }), env, {});
  check("admin keys in query strings are refused", querySecret.status === 401, String(querySecret.status));
  const readOnly = await worker.fetch(new Request("https://b.example/api/rag/unified", {
    method: "POST",
    headers: { "X-Admin-Key": "read-only", "Content-Type": "application/json" },
    body: JSON.stringify({ q: "x" }),
  }), env, {});
  check("read-only proxy key can query retrieval", readOnly.status === 200, String(readOnly.status));
  check("private retrieval responses cannot be cached",
    /private/.test(readOnly.headers.get("cache-control") || "") && /no-store/.test(readOnly.headers.get("cache-control") || ""),
    readOnly.headers.get("cache-control") || "missing");
  const leakedGet = await worker.fetch(new Request("https://b.example/api/rag/unified?q=private-question", {
    headers: { "X-Admin-Key": "read-only" },
  }), env, {});
  check("question-bearing GET retrieval is refused", leakedGet.status === 405, String(leakedGet.status));
  const readOnlyAdmin = await worker.fetch(new Request("https://b.example/api/admin/brain/documents", { headers: { "X-Admin-Key": "read-only" } }), env, {});
  check("read-only proxy key cannot reach admin routes", readOnlyAdmin.status === 401, String(readOnlyAdmin.status));
}

/* ---- the D1 path answers, with the contract shape ---- */
{
  const { env } = mkEnv([ROW], { vectorIds: ["meeting:123#0"] });
  const r = await call(env, "/api/rag/unified?q=retainer&limit=5");
  const b = await r.json();
  check("unified returns results from D1", r.status === 200 && b.results.length === 1, JSON.stringify(b).slice(0, 200));
  check("private questions are not echoed in retrieval responses", !("query" in b), JSON.stringify(b));
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
          if (String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")) {
            return { response: { supported: true, complete: true, evidence: [1], reason: "direct support" }, usage: {} };
          }
          return { response: "The retainer was deferred [1].", usage: {} };
        },
      },
    },
  });
  await call(env, "/api/rag/think?q=What+is+our+parental+leave+policy");
  const generation = generations.find((input) => /second brain/.test(input?.messages?.[0]?.content || ""));
  const gate = generations.find((input) => /verify a proposed answer/.test(input?.messages?.[0]?.content || ""));
  const system = generation?.messages?.find((message) => message.role === "system")?.content || "";
  check("both evidence gating and answer generation are deterministic", gate?.temperature === 0 && generation?.temperature === 0, JSON.stringify(generations));
  check("the evidence gate verifies exact factual claims and subject", /exact person, company, property/.test(gate?.messages?.[0]?.content || ""), JSON.stringify(gate));
  check("the evidence gate receives the configured owner identity", /configured brain owner/.test(gate?.messages?.[0]?.content || ""), JSON.stringify(gate));
  check("the evidence gate requires every material part", /every material part/.test(gate?.messages?.[0]?.content || ""), JSON.stringify(gate));
  check("the answer contract forbids cross-entity evidence transfer", /different entity or context/.test(system), system);
  check("ambiguous owner context requires an explicit evidence tie", /tie it to the brain owner/.test(system), system);
}

{
  let modelCalls = 0;
  const { env } = mkEnv([ROW], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          modelCalls++;
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: '{"supported":false,"complete":false,"evidence":[],"reason":"different company"}', usage: {} }
            : { response: "The policy provides 24 weeks of leave [1].", usage: {} };
        },
      },
    },
  });
  const body = await (await call(env, "/api/rag/think?q=What+is+our+parental+leave+policy")).json();
  check("unsupported evidence replaces the generated draft with a refusal", modelCalls === 2 && body.answer === "The documents do not answer the question.", JSON.stringify(body));
  check("unsupported candidates are not exposed as answer citations", body.citations?.length === 0, JSON.stringify(body.citations));
  check("the refusal exposes its short support decision", body.evidence_gate?.supported === false && /different company/.test(body.evidence_gate?.reason || ""), JSON.stringify(body.evidence_gate));
}

/* ---- a positive verdict must cover every citation in the draft ---- */
{
  const second = { ...ROW, chunk_uid: "meeting:456#0", doc_uid: "meeting:456", source_id: "456", title: "Other record", text: "An unrelated extra claim." };
  const { env } = mkEnv([ROW, second], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1], reason: "only the first citation is supported" }, usage: {} }
            : { response: "The retainer was deferred [1]. An extra claim came from elsewhere [2].", usage: {} };
        },
      },
    },
  });
  const body = await (await call(env, "/api/rag/think?q=What+happened+to+the+retainer%3F")).json();
  check("a partial evidence approval fails closed", body.answer === "The documents do not answer the question." && body.evidence_gate?.supported === false, JSON.stringify(body));
  check("the partial approval identifies the citation mismatch", /every citation/.test(body.evidence_gate?.reason || ""), JSON.stringify(body.evidence_gate));
}

/* ---- every material part must be answered or explicitly called unknown ---- */
{
  const { env } = mkEnv([ROW], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: false, evidence: [1], reason: "the deadline was silently omitted" }, usage: {} }
            : { response: "The amount was $5,000 [1].", usage: {} };
        },
      },
    },
  });
  const body = await (await call(env, "/api/rag/think?q=What+were+the+amount+and+the+deadline%3F")).json();
  check("an incomplete multi-part answer fails closed", body.answer === "The documents do not answer the question." && body.evidence_gate?.complete === false, JSON.stringify(body));
  check("the completeness refusal preserves the verifier reason", /deadline was silently omitted/.test(body.evidence_gate?.reason || ""), JSON.stringify(body.evidence_gate));
}

/* ---- ambiguous high-risk facts require a deterministic owner link ---- */
{
  const newsletter = { ...ROW, chunk_uid: "newsletter#0", doc_uid: "newsletter", source_id: "newsletter", source: "message", title: "Open Source CEO", text: "A third-party startup raised a Series A at a $150M valuation." };
  const answerEnv = (inputRows) => {
    const rows = Array.isArray(inputRows) ? inputRows : [inputRows];
    const evidence = rows.map((_, index) => index + 1);
    return mkEnv(rows, {
    vectorIds: [],
    extra: {
      BRAIN_OWNER: "James Guldan",
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence, reason: "the valuation appears in the documents" }, usage: {} }
            : { response: `The Series A valuation was $150M ${evidence.map((n) => `[${n}]`).join("")}.`, usage: {} };
        },
      },
    },
  }).env;
  };
  const unrelated = await (await call(answerEnv(newsletter), "/api/rag/think?q=What+valuation+was+on+the+Series+A+term+sheet%3F")).json();
  check("an unrelated newsletter cannot answer an unnamed term sheet question", unrelated.answer === "The documents do not answer the question." && unrelated.evidence_gate?.supported === false, JSON.stringify(unrelated));
  check("the owner-link refusal states the structural reason", /no explicit link/.test(unrelated.evidence_gate?.reason || ""), JSON.stringify(unrelated.evidence_gate));

  const ownerOnly = { ...newsletter, chunk_uid: "owner-profile#0", doc_uid: "owner-profile", source_id: "owner-profile", title: "James Guldan profile", text: "James Guldan owns this brain. No financing terms appear here." };
  const split = await (await call(answerEnv([newsletter, ownerOnly]), "/api/rag/think?q=What+valuation+was+on+the+Series+A+term+sheet%3F")).json();
  check("owner identity and the high-risk fact cannot come from different documents", split.answer === "The documents do not answer the question." && split.evidence_gate?.supported === false, JSON.stringify(split));

  const owned = { ...newsletter, chunk_uid: "owned-term-sheet#0", doc_uid: "owned-term-sheet", source_id: "owned-term-sheet", title: "James's Series A Term Sheet", text: "James's Series A term sheet states a $150M valuation." };
  const linked = await (await call(answerEnv(owned), "/api/rag/think?q=What+valuation+was+on+the+Series+A+term+sheet%3F")).json();
  check("an explicitly owner-linked term sheet can still answer", linked.answer === "The Series A valuation was $150M [1]." && linked.evidence_gate?.supported === true, JSON.stringify(linked));
}

/* ---- planning notes do not establish binding legal obligations ---- */
{
  const rows = [{
    chunk_uid: "legal-planning",
    document_uid: "legal-planning-doc",
    source_type: "drive",
    source_id: "legal-planning-doc",
    title: "Operating Agreement, Decisions So Far",
    text: "Planning notes say a right of first refusal and drag along should both be included.",
    occurred_at: null,
    metadata_json: "{}",
    ref_key: "legal-planning-doc",
  }];
  const { env } = mkEnv(rows, {
    vectorIds: [],
    extra: {
      BRAIN_OWNER: "James Guldan",
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1], reason: "the planning note says so" }, usage: {} }
            : { response: "You are bound by a right of first refusal and drag along [1].", usage: {} };
        },
      },
    },
  });
  const body = await (await call(env, "/api/rag/think?q=What+am+I+actually+bound+by+under+the+ownership+agreement%3F")).json();
  check("non-final planning notes cannot establish binding legal obligations", body.answer === "The documents do not answer the question." && body.evidence_gate?.supported === false, JSON.stringify(body));
  check("the legal refusal says why it failed closed", /non-final planning material/.test(body.evidence_gate?.reason || ""), JSON.stringify(body.evidence_gate));
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

{
  const { env } = mkEnv([]);
  const secret = `sk-proj-${"A7".repeat(16)}`;
  const titleResponse = await worker.fetch(new Request("https://b.example/api/admin/brain/ingest", {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source_type: "note", source_id: "title-only", title: `Credentials ${secret}`, content: "ordinary prose" }),
  }), env, {});
  const titleBody = await titleResponse.text();
  check("worker ingest refuses a credential in an embedded title",
    titleResponse.status === 422 && !titleBody.includes(secret), `${titleResponse.status} ${titleBody}`);

  const pathResponse = await worker.fetch(new Request("https://b.example/api/admin/brain/ingest", {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source_type: "note", source_id: "path-only", content: "ordinary prose", metadata: { folder: `Imports/${secret}/Notes` } }),
  }), env, {});
  const pathBody = await pathResponse.text();
  check("worker ingest refuses a credential in connector path metadata",
    pathResponse.status === 422 && !pathBody.includes(secret), `${pathResponse.status} ${pathBody}`);
}

/* ---- bulk imports close with a truthful source receipt ---- */
{
  const { env, seen } = mkEnv([]);
  const response = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "drive", kind: "drive", complete_sweep: true, detail: "migration complete" }),
  }), env, {});
  const body = await response.json();
  check("a bulk importer can record its source receipt", response.status === 200 && body.source === "drive" && body.status === "ready", JSON.stringify(body));
  check("the receipt derives both logical files and stored split parts",
    seen.sql.some((sql) => /COUNT\(DISTINCT[\s\S]*part_of[\s\S]*FROM documents WHERE source/i.test(sql)), JSON.stringify(seen.sql));
  check("the receipt updates freshness and leaves an audit event", seen.sql.some((sql) => /INSERT INTO sources/.test(sql)) && seen.sql.some((sql) => /INSERT INTO source_events/.test(sql)), JSON.stringify(seen.sql));

  const bad = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "Drive %" }),
  }), env, {});
  check("an unsafe source receipt name is refused", bad.status === 400, String(bad.status));
}

/* ---- connector receipts expose start, success, and failure without a CF token ---- */
{
  const { env, seen } = mkEnv([]);
  const started = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({
      source: "drive", kind: "drive", status: "indexing", run_id: "run_drive_1",
      lane: "incremental", started_at: "2026-08-23T01:00:00.000Z",
    }),
  }), env, {});
  const startBody = await started.json();
  check("a connector can open an authenticated sync run",
    started.status === 200 && startBody.status === "indexing" && startBody.run_id === "run_drive_1", JSON.stringify(startBody));
  check("opening a run marks its source indexing",
    seen.sql.some((sql) => /INSERT INTO sources[\s\S]*'indexing'/.test(sql)), JSON.stringify(seen.sql));
  check("opening a run records its exact start in sync_runs",
    seen.sql.some((sql) => /INSERT INTO sync_runs[\s\S]*started_at/.test(sql)), JSON.stringify(seen.sql));

  const failed = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({
      source: "drive", kind: "drive", status: "error", run_id: "run_drive_1",
      lane: "incremental", error: "Drive API unavailable",
    }),
  }), env, {});
  const failedBody = await failed.json();
  check("a connector can close its run as failed",
    failed.status === 200 && failedBody.status === "error" && /Drive API unavailable/.test(failedBody.error || ""), JSON.stringify(failedBody));
  const errorSourceSql = seen.sql.find((sql) => /INSERT INTO sources[\s\S]*'error'/.test(sql));
  check("a failed receipt does not advance last_ingest_at",
    !!errorSourceSql && !/last_ingest_at/.test(errorSourceSql), errorSourceSql || JSON.stringify(seen.sql));
  check("a failed receipt closes the sync run with its error",
    seen.sql.some((sql) => /INSERT INTO sync_runs[\s\S]*finished_at[\s\S]*error/.test(sql)), JSON.stringify(seen.sql));

  const generated = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "gmail", kind: "gmail", status: "indexing", lane: "sweep" }),
  }), env, {});
  const generatedBody = await generated.json();
  check("the Worker generates a safe run id when a connector omits one",
    generated.status === 200 && /^[A-Za-z0-9_-]+$/.test(generatedBody.run_id || ""), JSON.stringify(generatedBody));

  const invalid = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "drive", status: "finished" }),
  }), env, {});
  check("an unknown connector lifecycle status is refused", invalid.status === 400, String(invalid.status));
}

/* ---- a failed sweep can never be recorded as a completed walk ---- */
{
  const { env, seen } = mkEnv([]);
  const response = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({
      source: "drive", kind: "drive", status: "error", run_id: "run_failed_sweep",
      lane: "sweep", complete_sweep: true, walk_complete: false, error: "walk aborted",
    }),
  }), env, {});
  const runBind = seen.binds.find((values) => values[0] === "run_failed_sweep" && values.length === 14);
  check("an error receipt cannot turn complete_sweep into walk_complete",
    response.status === 200 && runBind?.[5] === 0, JSON.stringify(runBind));
}

/* ---- source schedules configure freshness without pretending an ingest ran ---- */
{
  const { env, seen } = mkEnv([]);
  const response = await worker.fetch(new Request("https://b.example/api/admin/brain/source-expectation", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "drive", expected_refresh_seconds: 86_400 }),
  }), env, {});
  const body = await response.json();
  check("a schedule can set its source freshness expectation through the data plane",
    response.status === 200 && JSON.stringify(body) === JSON.stringify({
      source: "drive", kind: "drive", expected_refresh_seconds: 86_400,
    }), JSON.stringify(body));
  const upsert = seen.sql.find((sql) => /INSERT INTO sources[\s\S]*expected_refresh_seconds/.test(sql));
  const conflict = upsert?.split(/ON CONFLICT\(name\) DO UPDATE SET/i)[1] || "";
  check("expectation upsert preserves an existing source status and last ingest",
    /expected_refresh_seconds=excluded\.expected_refresh_seconds/.test(conflict) &&
      !/\bstatus\s*=|last_ingest_at\s*=/.test(conflict), upsert);
  check("expectation changes leave a source event",
    seen.sql.some((sql) => /source_events[\s\S]*'schedule'/.test(sql)) &&
      seen.binds.some((binds) => binds.includes("expected_refresh_seconds=86400")),
    JSON.stringify({ sql: seen.sql, binds: seen.binds }));
}
{
  const { env, seen } = mkEnv([]);
  const response = await worker.fetch(new Request("https://b.example/api/admin/brain/source-expectation", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "drive", kind: "drive", expected_refresh_seconds: null }),
  }), env, {});
  const body = await response.json();
  check("removing a schedule clears the expectation explicitly",
    response.status === 200 && body.expected_refresh_seconds === null &&
      seen.binds.some((binds) => binds.includes(null)), JSON.stringify({ body, binds: seen.binds }));
}
{
  const { env } = mkEnv([], { extra: { RAG_PROXY_KEY: "read-only" } });
  const retrievalKey = await worker.fetch(new Request(
    "https://b.example/api/admin/brain/source-expectation",
    {
      method: "POST",
      headers: { "X-Admin-Key": "read-only", "content-type": "application/json" },
      body: JSON.stringify({ source: "drive", expected_refresh_seconds: 86_400 }),
    }
  ), env, {});
  check("the retrieval key cannot change a source expectation", retrievalKey.status === 401, String(retrievalKey.status));
}
{
  const invalidBodies = [
    { source: "drive" },
    { source: "drive", expected_refresh_seconds: 59 },
    { source: "drive", expected_refresh_seconds: 60.5 },
    { source: "drive", expected_refresh_seconds: "86400" },
    { source: "Drive %", expected_refresh_seconds: 86_400 },
    { source: "drive", kind: "supabase", expected_refresh_seconds: 86_400 },
  ];
  const statuses = [];
  for (const body of invalidBodies) {
    const { env } = mkEnv([]);
    const response = await worker.fetch(new Request("https://b.example/api/admin/brain/source-expectation", {
      method: "POST",
      headers: { "X-Admin-Key": "k", "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env, {});
    statuses.push(response.status);
  }
  check("invalid source expectations fail closed", statuses.every((status) => status === 400), JSON.stringify(statuses));

  const supabase = { ...mkEnv([]).env, STORAGE: "supabase" };
  const wrongBackend = await worker.fetch(new Request("https://b.example/api/admin/brain/source-expectation", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "drive", expected_refresh_seconds: 86_400 }),
  }), supabase, {});
  check("source expectation is D1-only", wrongBackend.status === 400, String(wrongBackend.status));
}

/* A split file is one connector document even when it occupies several D1 rows. */
{
  const { env, seen } = mkEnv([], { countRow: { stored_documents: 3, logical_documents: 2 } });
  const response = await worker.fetch(new Request("https://b.example/api/admin/brain/source-receipt", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source: "drive", kind: "drive" }),
  }), env, {});
  const body = await response.json();
  check("a receipt reports logical and physical document counts separately",
    body.documents === 2 && body.logical_documents === 2 && body.stored_documents === 3, JSON.stringify(body));
  const sourceBind = seen.binds.find((bind) => bind[0] === "drive" && bind[1] === "drive" && bind.length === 5);
  check("the source registry stores the logical connector count", sourceBind?.[3] === 2, JSON.stringify(seen.binds));
}

/* ---- full-sweep reconciliation pages live logical document families ---- */
function mkSourceFamilyEnv(documents, extra = {}) {
  const seen = { sql: [], binds: [] };
  const env = {
    STORAGE: "d1", ADMIN_KEY: "k",
    DB: {
      prepare(sql) {
        seen.sql.push(sql);
        return {
          bind(...binds) {
            seen.binds.push(binds);
            return {
              all: async () => {
                const sourceScoped = /WHERE source = \?1/.test(sql);
                const [source, cursor, limit] = sourceScoped
                  ? binds
                  : [null, binds[0], binds[1]];
                const familyUids = documents
                  .filter((row) => (source === null || row.source === source) && row.deleted_at == null)
                  .map((row) => {
                    try {
                      const partOf = JSON.parse(row.meta || "{}")?.part_of;
                      return typeof partOf === "string" && partOf
                        ? (partOf.startsWith(`${row.source}:`) ? partOf : `${row.source}:${partOf}`)
                        : row.doc_uid;
                    } catch {
                      return row.doc_uid;
                    }
                  });
                const page = [...new Set(familyUids)]
                  .sort()
                  .filter((uid) => uid > cursor)
                  .slice(0, limit)
                  .map((family_doc_uid) => ({ family_doc_uid }));
                return { results: page };
              },
            };
          },
        };
      },
    },
    ...extra,
  };
  return { env, seen };
}

{
  const docs = [
    { doc_uid: "drive:a", source: "drive", meta: "{}", deleted_at: null },
    { doc_uid: "drive:b#part1of2", source: "drive", meta: '{"part_of":"b"}', deleted_at: null },
    { doc_uid: "drive:b#part2of2", source: "drive", meta: '{"part_of":"b"}', deleted_at: null },
    { doc_uid: "drive:c", source: "drive", meta: "{}", deleted_at: 1750000000000 },
    { doc_uid: "drive:d", source: "drive", meta: "not-json", deleted_at: null },
    { doc_uid: "drive:e#part1of1", source: "drive", meta: '{"part_of":"drive:e"}', deleted_at: null },
    { doc_uid: "gmail:a", source: "gmail", meta: "{}", deleted_at: null },
  ];
  const { env, seen } = mkSourceFamilyEnv(docs);

  const firstResponse = await call(env, "/api/admin/brain/source-families?source=drive&limit=2");
  const first = await firstResponse.json();
  check("source-family reconciliation is an authenticated D1 route",
    firstResponse.status === 200 && first.source === "drive", JSON.stringify(first));
  check("split parts collapse to one live logical family before pagination",
    first.families.join(",") === "drive:a,drive:b", JSON.stringify(first));
  check("a full page returns its last logical uid as a private body continuation cursor",
    first.next_cursor === "drive:b", JSON.stringify(first));
  check("private source-family responses cannot be cached",
    /private/.test(firstResponse.headers.get("cache-control") || "") &&
      /no-store/.test(firstResponse.headers.get("cache-control") || ""),
    firstResponse.headers.get("cache-control") || "missing");

  const secondResponse = await call(env,
    `/api/admin/brain/source-families?source=drive&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`);
  const second = await secondResponse.json();
  check("the next page neither repeats the boundary nor includes deleted or other-source rows",
    secondResponse.status === 200 && second.families.join(",") === "drive:d,drive:e", JSON.stringify(second));
  check("legacy already-prefixed part_of metadata is not prefixed a second time",
    second.families.includes("drive:e") && !second.families.includes("drive:drive:e"), JSON.stringify(second));
  check("the final reconciliation page has no continuation cursor",
    second.next_cursor === null, JSON.stringify(second));

  const sql = seen.sql.find((value) => /SELECT family_doc_uid/.test(value)) || "";
  check("D1 collapses part_of families and excludes soft-deleted rows before the page limit",
    /SELECT DISTINCT/.test(sql) && /part_of/.test(sql) && /deleted_at IS NULL/.test(sql), sql);
  check("D1 applies the lexical cursor before ordering and fetching one lookahead row",
    /family_doc_uid > \?2/.test(sql) && /ORDER BY family_doc_uid ASC/.test(sql) && seen.binds[0]?.[2] === 3,
    `${sql} ${JSON.stringify(seen.binds[0])}`);

  const globalResponse = await call(env, "/api/admin/brain/source-families?limit=1000");
  const global = await globalResponse.json();
  check("the global completeness inventory derives every live source from documents",
    global.source === null &&
      global.families.join(",") === "drive:a,drive:b,drive:d,drive:e,gmail:a",
    JSON.stringify(global));
  const globalSql = seen.sql.at(-1) || "";
  check("the global source inventory cannot skip a family through corpus-stats drift",
    /FROM documents/.test(globalSql) && !/corpus_stats/.test(globalSql) && seen.binds.at(-1)?.[1] === 1001,
    `${globalSql} ${JSON.stringify(seen.binds.at(-1))}`);

  const unauthenticated = await worker.fetch(
    new Request("https://b.example/api/admin/brain/source-families", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "drive" }),
    }), env, {});
  check("source-family enumeration refuses an unauthenticated caller", unauthenticated.status === 401, String(unauthenticated.status));

  const readOnlyEnv = { ...env, RAG_PROXY_KEY: "read-only" };
  const readOnly = await worker.fetch(new Request(
    "https://b.example/api/admin/brain/source-families",
    {
      method: "POST",
      headers: { "X-Admin-Key": "read-only", "Content-Type": "application/json" },
      body: JSON.stringify({ source: "drive" }),
    }
  ), readOnlyEnv, {});
  check("the read-only retrieval credential cannot enumerate source families", readOnly.status === 401, String(readOnly.status));
}

{
  const { env, seen } = mkSourceFamilyEnv([]);
  const post = (body) => worker.fetch(new Request(
    "https://b.example/api/admin/brain/source-families",
    {
      method: "POST",
      headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ), env, {});
  const responses = await Promise.all([
    post({ source: "drive %" }),
    post({ source: "drive", limit: 0 }),
    post({ source: "drive", limit: 1001 }),
    post({ source: "drive", limit: 2.5 }),
    post({ source: "drive", cursor: "gmail:a" }),
    post({ source: "drive", unexpected: true }),
  ]);
  check("source-family reconciliation validates source, limit, cursor and unknown fields",
    responses.every((response) => response.status === 400), responses.map((response) => response.status).join(","));

  const legacyGet = await worker.fetch(new Request(
    "https://b.example/api/admin/brain/source-families",
    { headers: { "X-Admin-Key": "k" } },
  ), env, {});
  check("source-family GET is refused before a private cursor can enter a URL",
    legacyGet.status === 405 && /no-store/.test(legacyGet.headers.get("cache-control") || ""),
    `${legacyGet.status} ${legacyGet.headers.get("cache-control") || "missing"}`);

  const failed = await call(mkSourceFamilyEnv([], {
    DB: { prepare() { throw new Error("fixture inventory failure"); } },
  }).env, "/api/admin/brain/source-families?source=drive");
  check("source-family failure responses cannot be cached",
    failed.status === 500 && /no-store/.test(failed.headers.get("cache-control") || ""),
    `${failed.status} ${failed.headers.get("cache-control") || "missing"}`);

  const max = await call(env, "/api/admin/brain/source-families?source=drive&limit=1000");
  check("the documented 1000-family page limit is accepted with one lookahead row",
    max.status === 200 && seen.binds.at(-1)?.[2] === 1001, JSON.stringify(seen.binds.at(-1)));

  const supabase = { ...env, STORAGE: "supabase" };
  const wrongBackend = await call(supabase, "/api/admin/brain/source-families?source=drive");
  check("source-family reconciliation refuses a non-D1 backend", wrongBackend.status === 400, String(wrongBackend.status));
}

/* ---- documents reports the backend and the vector backlog ---- */
{
  const { env } = mkEnv([{
    source_type: "meeting", documents: 3, logical_documents: 2,
    total: 4, embedded: 4, last_ingest_at: 1750000000000,
  }]);
  const documentsResponse = await call(env, "/api/admin/brain/documents");
  const b = await documentsResponse.json();
  check("documents names the backend", b.backend === "d1", JSON.stringify(b));
  check("documents separates source files from stored split parts",
    b.rows[0]?.documents === 2 && b.rows[0]?.logical_documents === 2 && b.rows[0]?.stored_documents === 3, JSON.stringify(b.rows[0]));
  check("and reports vector backlog", b.vector_backlog && "pending" in b.vector_backlog, JSON.stringify(b.vector_backlog));
  check("private aggregate inventory responses cannot be cached",
    /no-store/.test(documentsResponse.headers.get("cache-control") || ""),
    documentsResponse.headers.get("cache-control") || "missing");

  const failedDocuments = await call({
    STORAGE: "d1", ADMIN_KEY: "k",
    DB: { prepare() { throw new Error("fixture documents failure"); } },
  }, "/api/admin/brain/documents");
  check("private aggregate inventory failures cannot be cached",
    failedDocuments.status === 500 && /no-store/.test(failedDocuments.headers.get("cache-control") || ""),
    `${failedDocuments.status} ${failedDocuments.headers.get("cache-control") || "missing"}`);
}

/* ================= batch ingest ================= */

// A batch env whose ingest can be made to explode on a chosen document, so the
// partial-failure path is exercised rather than assumed.
function mkBatchEnv({ explodeOn = null, finalizeFailSource = null, failChunkDocUid = null, preflightFail = false } = {}) {
  const written = [];
  const documents = new Map();
  const calls = { remote: 0, stats_scans: 0, stats_attempts: 0, finalizer_batches: 0 };
  const control = { explodeOn, finalizeFailSource, failChunkDocUid, preflightFail };
  const execute = (sql, b) => {
    let changes = 0;
    if (/INSERT INTO documents/.test(sql)) {
      if (control.explodeOn && String(b[2]) === control.explodeOn) throw new Error("D1 write failed");
      const prior = documents.get(b[0]) || {};
      documents.set(b[0], {
        ...prior,
        doc_uid: b[0], source: b[1], source_id: b[2], title: b[3],
        client: b[8], category: b[9], top_folder: b[10], platform: b[11],
        content_hash: b[13],
      });
      written.push(String(b[2]));
      changes = 1;
    } else if (/UPDATE documents SET content_hash/.test(sql)) {
      const row = documents.get(b[0]);
      if (row && row.content_hash === b[2]) {
        row.content_hash = b[1];
        changes = 1;
      }
    } else if (/INSERT INTO corpus_stats/.test(sql)) {
      calls.stats_scans++;
      const candidates = JSON.parse(b[1] || "[]");
      changes = candidates.some(([docUid, marker]) => {
        const row = documents.get(docUid);
        return row?.source === b[0] && row?.content_hash === marker;
      }) ? 1 : 0;
    }
    return { changes };
  };
  const env = {
    STORAGE: "d1", ADMIN_KEY: "k",
    VECTORIZE: { query: async () => ({ matches: [] }), upsert: async () => {} },
    AI: { run: async () => ({ data: [[0.1]] }) },
    DB: {
      prepare: (sql) => ({
        bind: (...b) => ({
          sql, binds: b,
          all: async () => ({
            results: (() => {
              calls.remote++;
              return /SELECT doc_uid, content_hash FROM documents/.test(sql)
                ? b.map((docUid) => documents.get(docUid)).filter(Boolean)
                : [];
            })(),
          }),
          first: async () => {
            calls.remote++;
            if (/SELECT content_hash, title/.test(sql)) return documents.get(b[0]) || null;
            if (/SELECT client, category/.test(sql)) return documents.get(b[0]) || null;
            return null;
          },
          run: async () => {
            calls.remote++;
            const result = execute(sql, b);
            return { success: true, meta: { changes: result.changes } };
          },
        }),
      }),
      batch: async (statements) => {
        calls.remote++;
        if (statements.every((statement) => /SELECT content_hash, title/.test(statement.sql))) {
          if (control.preflightFail) throw new Error("simulated preflight failure");
          return statements.map((statement) => {
            const row = documents.get(statement.binds[0]);
            return { results: row ? [{ ...row }] : [] };
          });
        }
        const stats = statements.find((statement) => /INSERT INTO corpus_stats/.test(statement.sql));
        if (stats) {
          calls.stats_attempts++;
          calls.finalizer_batches++;
          if (control.finalizeFailSource === stats.binds[0]) throw new Error("simulated source finalization failure");
        }
        if (control.failChunkDocUid && statements.some((statement) =>
          /INSERT INTO chunks/.test(statement.sql) && statement.binds[1] === control.failChunkDocUid
        )) throw new Error("simulated chunk batch failure");
        return statements.map((statement) => {
          const result = execute(statement.sql, statement.binds);
          return { success: true, meta: { changes: result.changes } };
        });
      },
    },
  };
  return { env, written, documents, calls, control };
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

{
  const { env, written } = mkBatchEnv();
  const secret = `sk-proj-${"A7".repeat(16)}`;
  const pathOnly = { ...doc("path-secret"), metadata: { folder: `Imports/${secret}/Notes` } };
  const b = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [doc("safe"), pathOnly] })).json();
  check("batch ingest applies the envelope gate to path metadata",
    b.created === 1 && b.refused === 1 && !written.includes("path-secret"), JSON.stringify(b).slice(0, 250));
  check("batch metadata refusal never echoes the credential",
    !JSON.stringify(b).includes(secret), "SECRET ECHOED IN RESPONSE");
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

/* The large-message path must stay O(documents) in D1 calls and O(sources) in
   full corpus scans. At v0.1.11 the same synthetic request made seven remote D1
   calls per document, including 50 repeated full-source COUNT queries. */
{
  const { env, calls } = mkBatchEnv();
  const docs = Array.from({ length: 50 }, (_, index) => doc(`message-${index}`));
  const first = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  const legacyCalls = docs.length * 7;
  check("a maximum one-source batch keeps every per-document receipt",
    first.created === 50 && first.results.length === 50 && first.results.every((row) => row.doc_uid), JSON.stringify(first).slice(0, 200));
  check("50 small documents recompute source statistics once, not 50 times",
    calls.stats_scans === 1 && calls.finalizer_batches === 1, JSON.stringify(calls));
  check("the batch uses 203 D1 calls instead of the v0.1.11 structure's 350",
    calls.remote === 203 && calls.remote < legacyCalls, `${calls.remote} vs ${legacyCalls}`);

  const beforeRetry = { ...calls };
  const retry = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("a committed batch is idempotent on retry",
    retry.unchanged === 50 && retry.created === 0 && retry.failed === 0, JSON.stringify(retry).slice(0, 200));
  check("unchanged retries perform only identity reads and no corpus scan",
    calls.remote - beforeRetry.remote === 1 && calls.stats_scans === beforeRetry.stats_scans,
    JSON.stringify({ beforeRetry, after: calls }));
}

/* One preflight can safely classify no-op, update, and create receipts without
   changing their input order or bypassing finalization for the changed rows. */
{
  const { env, calls } = mkBatchEnv();
  const seed = [doc("steady"), doc("changing")];
  await post(env, "/api/admin/brain/ingest/batch", { docs: seed });
  const scansBefore = calls.stats_scans;
  const body = await (await post(env, "/api/admin/brain/ingest/batch", {
    docs: [seed[0], doc("changing", "a changed but still ordinary document body"), doc("new")],
  })).json();
  check("one batch can mix unchanged, updated, and created receipts in order",
    body.unchanged === 1 && body.updated === 1 && body.created === 1 &&
      body.results.map((row) => row.status).join(",") === "unchanged,updated,created",
    JSON.stringify(body));
  check("a mixed changed/no-op batch still scans its source only once",
    calls.stats_scans - scansBefore === 1, JSON.stringify(calls));
}

/* Preflight is an optimization, not a new availability dependency. */
{
  const { env, calls } = mkBatchEnv({ preflightFail: true });
  const body = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [doc("a"), doc("b")] })).json();
  check("a failed batch preflight falls back to ordinary per-document reads",
    body.created === 2 && body.failed === 0, JSON.stringify(body));
  check("the fallback preserves one source-level finalization",
    calls.stats_scans === 1 && calls.finalizer_batches === 1, JSON.stringify(calls));
}

/* Statistics and commit markers are finalized independently per touched source,
   so one mixed-source failure cannot turn another source into collateral loss. */
{
  const { env, documents, calls, control } = mkBatchEnv({ finalizeFailSource: "meeting" });
  const docs = [
    doc("m1"), doc("m2"),
    { ...doc("e1"), source_type: "email" },
    { ...doc("e2"), source_type: "email" },
  ];
  const first = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("a source-level finalization failure is isolated",
    first.created === 2 && first.failed === 2 && first.results.filter((row) => row.status === "failed").every((row) => row.source_type === "meeting"),
    JSON.stringify(first));
  check("the failed source stays pending while the other source commits",
    String(documents.get("meeting:m1")?.content_hash).startsWith("pending:") &&
      /^[a-f0-9]{64}$/.test(documents.get("email:e1")?.content_hash || ""),
    "revision markers did not preserve the source boundary");
  check("mixed-source batching attempts one statistics refresh per source",
    calls.stats_attempts === 2 && calls.stats_scans === 1, JSON.stringify(calls));

  control.finalizeFailSource = null;
  const retry = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("retry repairs only the pending source and leaves committed documents unchanged",
    retry.updated === 2 && retry.unchanged === 2 && retry.failed === 0, JSON.stringify(retry));
  check("the repaired source receives committed hashes",
    /^[a-f0-9]{64}$/.test(documents.get("meeting:m1")?.content_hash || ""));
}

/* A failure after the pending marker but before chunk completion must not be
   hidden by finalizing another successful document from the same source. */
{
  const failedUid = "meeting:middle";
  const { env, documents, control } = mkBatchEnv({ failChunkDocUid: failedUid });
  const docs = [doc("first"), doc("middle"), doc("last")];
  const first = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("a chunk-stage failure keeps its own receipt failed and its neighbors committed",
    first.created === 2 && first.failed === 1 && first.results.find((row) => row.source_id === "middle")?.status === "failed",
    JSON.stringify(first));
  check("the failed revision's content hash remains pending",
    String(documents.get(failedUid)?.content_hash).startsWith("pending:"), documents.get(failedUid)?.content_hash || "missing");
  check("successful neighbors still commit their exact revision markers",
    /^[a-f0-9]{64}$/.test(documents.get("meeting:first")?.content_hash || "") &&
      /^[a-f0-9]{64}$/.test(documents.get("meeting:last")?.content_hash || ""));

  control.failChunkDocUid = null;
  const retry = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("retry repairs the interrupted revision without rewriting its neighbors",
    retry.updated === 1 && retry.unchanged === 2 && retry.failed === 0, JSON.stringify(retry));
}

/* Duplicate identities deliberately use the original sequential path. */
{
  const { env, documents, calls } = mkBatchEnv();
  const first = doc("same", "first ordinary revision");
  const second = doc("same", "second ordinary revision");
  const body = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [first, second] })).json();
  check("two revisions of one identity preserve sequential created-then-updated receipts",
    body.created === 1 && body.updated === 1 && body.results.map((row) => row.status).join(",") === "created,updated", JSON.stringify(body));
  check("duplicate identities finalize sequentially rather than as one delayed group",
    calls.finalizer_batches === 2 && calls.stats_scans === 2 && calls.remote === 12, JSON.stringify(calls));
  check("the final duplicate revision is committed rather than left pending",
    /^[a-f0-9]{64}$/.test(documents.get("meeting:same")?.content_hash || ""));
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
  const { env } = mkForgetEnv();
  const r = await post(env, "/api/admin/brain/forget", {
    families: [{ base_doc_uid: "drive:F1", keep_doc_uids: ["drive:F1#part1of2", "drive:F1#part2of2"] }],
    confirm: true,
  });
  check("split-document families have an authenticated cleanup route", r.status === 200, String(r.status));
  check("a family keep id outside its base is refused",
    (await post(env, "/api/admin/brain/forget", { families: [{ base_doc_uid: "drive:F1", keep_doc_uids: ["drive:F2"] }] })).status === 400);
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
