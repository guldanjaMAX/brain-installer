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
const call = (env, path) => worker.fetch(new Request("https://b.example" + path, { headers: { "X-Admin-Key": "k" } }), env, { waitUntil() {}, passThroughOnException() {} });

/* ---- auth still gates everything but health ---- */
{
  const { env } = mkEnv([], { extra: { RAG_PROXY_KEY: "read-only" } });
  const open = await worker.fetch(new Request("https://b.example/health"), env, {});
  check("health is open", open.status === 200);
  const shut = await worker.fetch(new Request("https://b.example/api/rag/unified?q=x"), env, {});
  check("unified needs the admin key", shut.status === 401, String(shut.status));
  const querySecret = await worker.fetch(new Request("https://b.example/api/rag/unified?q=x&admin_key=k"), env, {});
  check("admin keys in query strings are refused", querySecret.status === 401, String(querySecret.status));
  const readOnly = await worker.fetch(new Request("https://b.example/api/rag/unified?q=x", { headers: { "X-Admin-Key": "read-only" } }), env, {});
  check("read-only proxy key can query retrieval", readOnly.status === 200, String(readOnly.status));
  const readOnlyAdmin = await worker.fetch(new Request("https://b.example/api/admin/brain/documents", { headers: { "X-Admin-Key": "read-only" } }), env, {});
  check("read-only proxy key cannot reach admin routes", readOnlyAdmin.status === 401, String(readOnlyAdmin.status));
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
                const [source, cursor, limit] = binds;
                const familyUids = documents
                  .filter((row) => row.source === source && row.deleted_at == null)
                  .map((row) => {
                    try {
                      const partOf = JSON.parse(row.meta || "{}")?.part_of;
                      return typeof partOf === "string" && partOf
                        ? (partOf.startsWith(`${source}:`) ? partOf : `${source}:${partOf}`)
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
  check("a full page returns its last logical uid as an opaque continuation cursor",
    first.next_cursor === "drive:b", JSON.stringify(first));

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

  const unauthenticated = await worker.fetch(
    new Request("https://b.example/api/admin/brain/source-families?source=drive"), env, {});
  check("source-family enumeration refuses an unauthenticated caller", unauthenticated.status === 401, String(unauthenticated.status));

  const readOnlyEnv = { ...env, RAG_PROXY_KEY: "read-only" };
  const readOnly = await worker.fetch(new Request(
    "https://b.example/api/admin/brain/source-families?source=drive",
    { headers: { "X-Admin-Key": "read-only" } }
  ), readOnlyEnv, {});
  check("the read-only retrieval credential cannot enumerate source families", readOnly.status === 401, String(readOnly.status));
}

{
  const { env, seen } = mkSourceFamilyEnv([]);
  const responses = await Promise.all([
    call(env, "/api/admin/brain/source-families"),
    call(env, "/api/admin/brain/source-families?source=drive%20%25"),
    call(env, "/api/admin/brain/source-families?source=drive&limit=0"),
    call(env, "/api/admin/brain/source-families?source=drive&limit=1001"),
    call(env, "/api/admin/brain/source-families?source=drive&limit=2.5"),
    call(env, "/api/admin/brain/source-families?source=drive&cursor=gmail%3Aa"),
    call(env, "/api/admin/brain/source-families?source=drive&source=gmail"),
  ]);
  check("source-family reconciliation validates source, limit, cursor and duplicate parameters",
    responses.every((response) => response.status === 400), responses.map((response) => response.status).join(","));

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
  const b = await (await call(env, "/api/admin/brain/documents")).json();
  check("documents names the backend", b.backend === "d1", JSON.stringify(b));
  check("documents separates source files from stored split parts",
    b.rows[0]?.documents === 2 && b.rows[0]?.logical_documents === 2 && b.rows[0]?.stored_documents === 3, JSON.stringify(b.rows[0]));
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
