import worker from "../src/index.js";
import { filterSql, unsupportedFilters } from "../src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

/* A D1 env that records what SQL it was asked to run, so a filter that never
   reached the database is a visible failure rather than a silent one. */
function mkEnv(rows, {
  vectorIds = [],
  vectorThrows = false,
  countRow = null,
  outboxRow = null,
  readinessRow = null,
  extra = {},
} = {}) {
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
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return readinessRow || {
                schema_version: 12,
                mutation_id: null,
                mutation_submitted_at: null,
                projection_status: "verified",
                bootstrap_epoch: 0,
                bootstrap_cursor: null,
                bootstrap_high_water: null,
                expected_vectors: vectorIds.length,
                pending: 0,
                submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/FROM vector_outbox/.test(sql) && /submitted_mutation_id/.test(sql)) {
              return outboxRow || {
                n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0,
              };
            }
            return /count\(\*\)/i.test(sql)
              ? (countRow || { n: 0, stored_documents: 0, logical_documents: 0 })
              : null;
          },
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
      describe: async () => ({ vectorCount: vectorIds.length, processedUpToMutation: null }),
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
  date_reliable: 1, date_source: "fixture:event_date", top_folder: "Clients", platform: "imessage",
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
  check("a hit exposes whether that date is reliable and where it came from",
    b.results[0].date_reliable === true && b.results[0].date_source === "fixture:event_date", JSON.stringify(b.results[0]));
  check("and its client", b.results[0].client === "Acme");
  check("a hit exposes stable document identity, not its chunk id", b.results[0].ref_key === "123" && b.results[0].chunk_uid === "meeting:123#0", JSON.stringify(b.results[0]));
}

/* The public source-weight contract is live on D1, including an explicit zero. */
{
  const drive = { ...ROW, chunk_uid: "drive-weight#0", doc_uid: "drive-weight", source_id: "drive-weight", source: "drive", title: "Acme drive" };
  const message = { ...ROW, chunk_uid: "message-weight#0", doc_uid: "message-weight", source_id: "message-weight", source: "message", title: "Acme message" };
  const { env } = mkEnv([drive, message], { vectorIds: [] });
  const weighted = await (await call(env, "/api/rag/unified?q=Acme&limit=2&rerank=0&weight_message=5")).json();
  check("D1 source weighting changes the public order", weighted.results[0]?.source === "message", JSON.stringify(weighted.results));
  const disabled = await (await call(env, "/api/rag/unified?q=Acme&limit=2&rerank=0&weight_message=0")).json();
  check("an explicit zero source weight is not rewritten to one",
    disabled.results.length === 1 && disabled.results[0]?.source === "drive", JSON.stringify(disabled.results));
}

/* Multiple matching chunks from one document consume one public result slot. */
{
  const second = { ...ROW, chunk_uid: "meeting:123#1", text: "The follow-up said the same thing." };
  const { env } = mkEnv([ROW, second], { vectorIds: ["meeting:123#0", "meeting:123#1"] });
  const b = await (await call(env, "/api/rag/unified?q=retainer&limit=5")).json();
  check("one document cannot crowd out the result page with repeat chunks", b.results.length === 1, JSON.stringify(b.results));
}

/* Every route and public limit normalizes the same fixed pre-slice window. */
{
  const substantive = (index) => ({
    ...ROW, chunk_uid: `substantive-${index}#0`, doc_uid: `substantive-${index}`,
    source_id: `substantive-${index}`, title: `Substantive record ${index}`,
    text: `Roadmap evidence ${index}`,
  });
  const scaffolding = Array.from({ length: 25 }, (_, index) => ({
    ...ROW, chunk_uid: `scaffold-${index}#0`, doc_uid: `scaffold-${index}`,
    source_id: `scaffold-${index}`, title: index % 2 ? "README.md" : "package-lock.json",
    text: `Roadmap scaffolding ${index}`,
  }));
  const rows = [
    ...Array.from({ length: 5 }, (_, index) => substantive(index)),
    ...scaffolding,
    ...Array.from({ length: 20 }, (_, index) => substantive(index + 5)),
  ];
  const { env } = mkEnv(rows, { vectorIds: [] });
  const small = await (await call(env, "/api/rag/unified?q=roadmap&limit=10&rerank=0")).json();
  const wide = await (await call(env, "/api/rag/unified?q=roadmap&limit=50&rerank=0")).json();
  check("scaffolding demotion has one route-independent ranking prefix",
    small.results.map((row) => row.ref_key).join(",") ===
      wide.results.slice(0, 10).map((row) => row.ref_key).join(",") &&
      small.results.every((row) => !/README|package-lock/.test(row.title || "")),
    JSON.stringify({ small: small.results, wide: wide.results.slice(0, 10) }));
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

/* A partially populated vector index is also degraded. A non-empty semantic
   page can otherwise hide that newly accepted context is still missing. */
{
  const newer = {
    ...ROW,
    chunk_uid: "message:new-context#0",
    doc_uid: "message:new-context",
    source_id: "new-context",
    text: "Newly accepted context not visible in Vectorize yet.",
  };
  const { env } = mkEnv([ROW, newer], {
    vectorIds: ["meeting:123#0"],
    outboxRow: { n: 1, oldest: 100, upserts: 1, deletes: 0, submitted: 1 },
    readinessRow: {
      schema_version: 12,
      mutation_id: "fixture-partial-projection",
      mutation_submitted_at: 100,
      projection_status: "pending",
      bootstrap_epoch: 0,
      bootstrap_cursor: null,
      bootstrap_high_water: null,
      expected_vectors: 2,
      pending: 1,
      submitted: 1,
      oldest_queued_at: 100,
    },
  });
  const unified = await (await call(env, "/api/rag/unified?q=context&limit=5")).json();
  check("non-empty Vectorize results still disclose a partial async projection",
    unified.degraded === "vector" && unified.results.length > 0,
    JSON.stringify(unified));
  const think = await (await call(env, "/api/rag/think?q=context&limit=5")).json();
  check("think warns that partial projection can miss paraphrased current context",
    think.degraded === "vector" && (think.gaps || []).some((gap) =>
      gap.type === "vector_unavailable" && /not fully query-ready/.test(gap.detail || "")),
    JSON.stringify(think.gaps));
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
  check("the answer contract treats older evidence as history for current-status questions",
    /older source establishes history only/.test(system), system);
  check("the temporal contract says billing activity alone cannot establish relationship status",
    /Billing or payment activity alone/.test(system) &&
      /newest cited document must itself explicitly support/i.test(gate?.messages?.[0]?.content || ""),
    JSON.stringify({ system, gate }));
}

/* ---- current-status ranking and citations share one deterministic timeline ---- */
{
  const stale = {
    ...ROW,
    chunk_uid: "taylor-stale#0", doc_uid: "taylor-stale", source_id: "taylor-stale", source: "message",
    title: "Taylor account summary", text: "Taylor was listed as an active client.",
    document_date: Date.parse("2026-05-01T00:00:00Z"), date_reliable: 1, date_source: "fixture:summary_date",
  };
  const current = {
    ...ROW,
    chunk_uid: "taylor-current#0", doc_uid: "taylor-current", source_id: "taylor-current", source: "message",
    title: "Taylor conversation", text: "Taylor confirmed the engagement remains active. The August invoice payment failed for insufficient funds.",
    document_date: Date.parse("2026-08-19T00:00:00Z"), date_reliable: 1, date_source: "fixture:message_timestamp",
  };
  const currentQuestion = "What is going on with billing with Taylor? Are they still a client?";
  const path = `/api/rag/unified?q=${encodeURIComponent(currentQuestion)}&limit=2&rerank=0`;
  const thinkPath = `/api/rag/think?q=${encodeURIComponent(currentQuestion)}&limit=2`;
  const { env } = mkEnv([stale, current], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1], reason: "newest direct evidence" }, usage: {} }
            : { response: "Taylor is still an active client as of 2026-08-19 [1]. The August payment failed for insufficient funds [1].", usage: {} };
        },
      },
    },
  });
  const unified = await (await call(env, path)).json();
  const think = await (await call(env, thinkPath)).json();
  const configuredProvider = await (await call(
    { ...env, ANTHROPIC_API_KEY: "fixture-provider-key" },
    `/api/rag/unified?q=${encodeURIComponent(currentQuestion)}&limit=2`,
  )).json();
  check("explicit current intent places the newest reliable entity evidence first",
    unified.results[0]?.ref_key === "taylor-current", JSON.stringify(unified.results));
  check("unified and think expose the same deterministic result prefix",
    unified.results.map((row) => row.ref_key).join(",") === think.results.map((row) => row.ref_key).join(","),
    JSON.stringify({ unified: unified.results, think: think.results }));
  check("a configured rerank provider does not change ordering unless rerank is explicitly enabled",
    configuredProvider.reranked === false &&
      configuredProvider.results.map((row) => row.ref_key).join(",") === think.results.map((row) => row.ref_key).join(","),
    JSON.stringify(configuredProvider));
  check("the newest current-status citation keeps its date provenance",
    think.answer?.includes("still an active client") && think.citations[0]?.ref === "taylor-current" &&
      think.citations[0]?.date_reliable === true && think.citations[0]?.date_source === "fixture:message_timestamp",
    JSON.stringify(think));
}

/* Co-citing a newest billing event cannot refresh an older relationship claim. */
{
  const stale = {
    ...ROW,
    chunk_uid: "billing-stale#0", doc_uid: "billing-stale", source_id: "billing-stale", source: "message",
    title: "Taylor old relationship", text: "Taylor was an active client in May.",
    document_date: Date.parse("2026-05-01T00:00:00Z"), date_reliable: 1,
  };
  const billingOnly = {
    ...ROW,
    chunk_uid: "billing-current#0", doc_uid: "billing-current", source_id: "billing-current", source: "message",
    title: "Taylor August invoice", text: "Taylor's August invoice payment failed for insufficient funds.",
    document_date: Date.parse("2026-08-19T00:00:00Z"), date_reliable: 1,
  };
  const { env } = mkEnv([stale, billingOnly], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1, 2], reason: "both records were cited" }, usage: {} }
            : { response: "Taylor is still an active client as of 2026-08-19 [1][2]. The August payment failed for insufficient funds [1].", usage: {} };
        },
      },
    },
  });
  const question = encodeURIComponent("What is going on with billing with Taylor? Are they still a client?");
  const body = await (await call(env, `/api/rag/think?q=${question}&limit=2`)).json();
  check("newest billing-only evidence cannot establish an ongoing client relationship",
    body.answer === "The documents do not answer the question." &&
      /did not itself support/.test(body.evidence_gate?.reason || ""), JSON.stringify(body));
}

/* Authority is claim-scoped. Transaction systems can prove their own account
   state, but a provider's Customer object is not an active client relationship. */
{
  const currentRow = (source, text) => ({
    ...ROW,
    chunk_uid: `${source}-authority#0`, doc_uid: `${source}-authority`, source_id: `${source}-authority`,
    source, title: "Taylor current record", text,
    document_date: Date.parse("2026-08-20T00:00:00Z"), date_reliable: 1,
    date_source: "fixture:provider_snapshot",
  });
  const answerEnv = (row, answer) => mkEnv([row], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1], reason: "fixture approval" }, usage: {} }
            : { response: answer, usage: {} };
        },
      },
    },
  }).env;

  const stripeRelationship = await (await call(
    answerEnv(
      currentRow("stripe", "Customer Taylor. Subscription active. Account open."),
      "Taylor is still a client [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still a client?")}&limit=1`,
  )).json();
  check("a Stripe customer or subscription cannot prove an active client relationship",
    stripeRelationship.answer === "The documents do not answer the question." &&
      /did not itself support/.test(stripeRelationship.evidence_gate?.reason || ""),
    JSON.stringify(stripeRelationship));

  const stripeImpliedRelationship = await (await call(
    answerEnv(
      currentRow("stripe", "Customer Taylor. Subscription active. Account open."),
      "Taylor remains active [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still a client?")}&limit=1`,
  )).json();
  check("an implied relationship claim cannot bypass Stripe's claim scope",
    stripeImpliedRelationship.answer === "The documents do not answer the question." &&
      /did not itself support/.test(stripeImpliedRelationship.evidence_gate?.reason || ""),
    JSON.stringify(stripeImpliedRelationship));

  const stripeMixedRelationship = await (await call(
    answerEnv(
      currentRow("stripe", "Customer Taylor. Subscription active. Account open."),
      "Taylor's account is active, and the relationship remains ongoing [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still a client?")}&limit=1`,
  )).json();
  check("a transaction clause cannot hide an unsupported relationship claim",
    stripeMixedRelationship.answer === "The documents do not answer the question." &&
      /did not itself support/.test(stripeMixedRelationship.evidence_gate?.reason || ""),
    JSON.stringify(stripeMixedRelationship));

  const crmRelationship = await (await call(
    answerEnv(
      currentRow("crm", "Taylor is an active client; the relationship remains active."),
      "Taylor is still an active client [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still a client?")}&limit=1`,
  )).json();
  check("a live CRM relationship record can establish current client status",
    crmRelationship.answer === "Taylor is still an active client [1].",
    JSON.stringify(crmRelationship));

  const oppositeCrmRelationship = await (await call(
    answerEnv(
      currentRow("crm", "Taylor client relationship inactive and closed."),
      "Taylor is still an active client [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still an active client?")}&limit=1`,
  )).json();
  check("an authoritative CRM record must support the claimed status polarity",
    oppositeCrmRelationship.answer === "The documents do not answer the question." &&
      /did not itself support/.test(oppositeCrmRelationship.evidence_gate?.reason || ""),
    JSON.stringify(oppositeCrmRelationship));

  const matchingNegativeCrm = await (await call(
    answerEnv(
      currentRow("crm", "Taylor client relationship inactive and closed."),
      "Taylor is no longer an active client [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still an active client?")}&limit=1`,
  )).json();
  check("a matching negative CRM relationship state remains answerable",
    matchingNegativeCrm.answer === "Taylor is no longer an active client [1].",
    JSON.stringify(matchingNegativeCrm));

  const stripeSubscription = await (await call(
    answerEnv(
      currentRow("stripe", "Taylor subscription active. Account open."),
      "Taylor's subscription is currently active [1].",
    ),
    `/api/rag/think?q=${encodeURIComponent("Is Taylor's subscription currently active?")}&limit=1`,
  )).json();
  check("Stripe remains authoritative for its own subscription status",
    stripeSubscription.answer === "Taylor's subscription is currently active [1].",
    JSON.stringify(stripeSubscription));
}

/* Negative current-status language and missing as-of dates are gated too. */
{
  const stale = {
    ...ROW,
    chunk_uid: "negative-stale#0", doc_uid: "negative-stale", source_id: "negative-stale", source: "message",
    title: "Taylor old relationship", text: "Taylor was an active client.",
    document_date: Date.parse("2026-05-01T00:00:00Z"), date_reliable: 1,
  };
  const current = {
    ...ROW,
    chunk_uid: "negative-current#0", doc_uid: "negative-current", source_id: "negative-current", source: "message",
    title: "Taylor current relationship", text: "Taylor's engagement remains active.",
    document_date: Date.parse("2026-08-19T00:00:00Z"), date_reliable: 1,
  };
  const answerEnv = (answer, evidence) => mkEnv([stale, current], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence, reason: "fixture approval" }, usage: {} }
            : { response: answer, usage: {} };
        },
      },
    },
  }).env;
  const question = encodeURIComponent("What is Taylor's current client status?");
  const negative = await (await call(
    answerEnv("Taylor is no longer a client [2].", [2]),
    `/api/rag/think?q=${question}&limit=2`,
  )).json();
  check("no-longer status language cannot rely on stale evidence",
    negative.answer === "The documents do not answer the question." &&
      /older evidence/.test(negative.evidence_gate?.reason || ""), JSON.stringify(negative));
  const unqualified = await (await call(
    answerEnv("Taylor is still an active client [1].", [1]),
    `/api/rag/think?q=${question}&limit=2`,
  )).json();
  check("a non-authoritative current-status claim requires an exact as-of date",
    unqualified.answer === "The documents do not answer the question." &&
      /exact as-of date/.test(unqualified.evidence_gate?.reason || ""), JSON.stringify(unqualified));
}

/* A missing reliable timeline must engage the deterministic gate rather than
   handing the decision entirely to a permissive semantic verifier. */
{
  const unreliable = {
    ...ROW,
    chunk_uid: "unreliable-current#0", doc_uid: "unreliable-current", source_id: "unreliable-current",
    source: "message", title: "Taylor status note", text: "Taylor remains an active client.",
    document_date: Date.parse("2026-08-20T00:00:00Z"), date_reliable: 0,
    date_source: "fixture:file_mtime",
  };
  const { env } = mkEnv([unreliable], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          return String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")
            ? { response: { supported: true, complete: true, evidence: [1], reason: "fixture approval" }, usage: {} }
            : { response: "Taylor is still an active client [1].", usage: {} };
        },
      },
    },
  });
  const body = await (await call(
    env,
    `/api/rag/think?q=${encodeURIComponent("Is Taylor still a client right now?")}&limit=1`,
  )).json();
  check("a present-status claim fails closed when no reliable-dated evidence exists",
    body.answer === "The documents do not answer the question." &&
      /no reliable-dated evidence/.test(body.evidence_gate?.reason || ""),
    JSON.stringify(body));
}

{
  const stale = {
    ...ROW,
    chunk_uid: "stale-status#0", doc_uid: "stale-status", source_id: "stale-status", source: "message",
    title: "Taylor old status", text: "Taylor was listed as an active client.",
    document_date: Date.parse("2026-05-01T00:00:00Z"), date_reliable: 1,
  };
  const current = {
    ...ROW,
    chunk_uid: "current-status#0", doc_uid: "current-status", source_id: "current-status", source: "message",
    title: "Taylor current status", text: "Taylor confirmed the engagement remains active in the newest conversation.",
    document_date: Date.parse("2026-08-19T00:00:00Z"), date_reliable: 1,
  };
  const gatePrompts = [];
  const { env } = mkEnv([stale, current], {
    vectorIds: [],
    extra: {
      AI: {
        run: async (model, input) => {
          if (model.includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
          if (String(input?.messages?.[0]?.content || "").includes("verify a proposed answer")) {
            gatePrompts.push(input);
            return { response: { supported: true, complete: true, evidence: [2], reason: "stale statement is explicit" }, usage: {} };
          }
          return { response: "Taylor is still an active client [2].", usage: {} };
        },
      },
    },
  });
  const question = encodeURIComponent("What is Taylor's current client status? Are they still active?");
  const body = await (await call(env, `/api/rag/think?q=${question}&limit=2`)).json();
  check("a stale-only citation cannot establish present status when newer direct evidence exists",
    body.answer === "The documents do not answer the question." && body.evidence_gate?.supported === false &&
      /newer direct evidence/.test(body.evidence_gate?.reason || ""), JSON.stringify(body));
  check("the semantic verifier receives the newest direct evidence for comparison",
    /NEWEST RELIABLE-DATED DIRECT EVIDENCE/.test(gatePrompts[0]?.messages?.at(-1)?.content || ""),
    JSON.stringify(gatePrompts));
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
      BRAIN_OWNER: "Morgan Diaz",
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

  const ownerOnly = { ...newsletter, chunk_uid: "owner-profile#0", doc_uid: "owner-profile", source_id: "owner-profile", title: "Morgan Diaz profile", text: "Morgan Diaz owns this brain. No financing terms appear here." };
  const split = await (await call(answerEnv([newsletter, ownerOnly]), "/api/rag/think?q=What+valuation+was+on+the+Series+A+term+sheet%3F")).json();
  check("owner identity and the high-risk fact cannot come from different documents", split.answer === "The documents do not answer the question." && split.evidence_gate?.supported === false, JSON.stringify(split));

  const owned = { ...newsletter, chunk_uid: "owned-term-sheet#0", doc_uid: "owned-term-sheet", source_id: "owned-term-sheet", title: "Morgan's Series A Term Sheet", text: "Morgan's Series A term sheet states a $150M valuation." };
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
      BRAIN_OWNER: "Morgan Diaz",
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
  check("the receipt derives both logical families and stored physical rows",
    seen.sql.some((sql) => /COUNT\(DISTINCT family_doc_uid\)[\s\S]*family_of[\s\S]*part_of[\s\S]*deleted_at IS NULL/i.test(sql)) &&
      seen.sql.some((sql) => /substr\(family_doc_uid, 1, length\(\?1\) \+ 1\)/.test(sql)),
    JSON.stringify(seen.sql));
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
                const sourceScoped = binds.length === 3;
                const [source, cursor, limit] = sourceScoped
                  ? binds
                  : [null, binds[0], binds[1]];
                const familyUids = documents
                  .filter((row) => row.deleted_at == null)
                  .map((row) => {
                    try {
                      const metadata = JSON.parse(row.meta || "{}");
                      const familyOf = metadata?.family_of;
                      const partOf = metadata?.part_of;
                      if (typeof familyOf === "string" && familyOf) return familyOf;
                      return typeof partOf === "string" && partOf
                        ? (partOf.startsWith(`${row.source}:`) ? partOf : `${row.source}:${partOf}`)
                        : row.doc_uid;
                    } catch {
                      return row.doc_uid;
                    }
                  })
                  .filter((uid) => source === null || uid.startsWith(`${source}:`));
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
    { doc_uid: "message:m1", source: "message", meta: '{"family_of":"upload:chat.txt"}', deleted_at: null },
    { doc_uid: "message:m2", source: "message", meta: '{"family_of":"upload:chat.txt"}', deleted_at: null },
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
  check("D1 collapses structural and declared families before the page limit",
    /SELECT DISTINCT/.test(sql) && /part_of/.test(sql) && /family_of/.test(sql) && /deleted_at IS NULL/.test(sql), sql);
  check("D1 filters by the derived family namespace rather than the physical row source",
    /substr\(family_doc_uid, 1, length\(\?1\) \+ 1\) = \?1 \|\| ':'/.test(sql) &&
      !/WHERE source = \?1/.test(sql), sql);
  check("D1 applies the lexical cursor before ordering and fetching one lookahead row",
    /family_doc_uid > \?2/.test(sql) && /ORDER BY family_doc_uid ASC/.test(sql) && seen.binds[0]?.[2] === 3,
    `${sql} ${JSON.stringify(seen.binds[0])}`);

  const globalResponse = await call(env, "/api/admin/brain/source-families?limit=1000");
  const global = await globalResponse.json();
  check("the global completeness inventory derives every live source from documents",
    global.source === null &&
      global.families.join(",") === "drive:a,drive:b,drive:d,drive:e,gmail:a,upload:chat.txt",
    JSON.stringify(global));
  const globalSql = seen.sql.at(-1) || "";
  check("the global source inventory cannot skip a family through corpus-stats drift",
    /FROM documents/.test(globalSql) && !/corpus_stats/.test(globalSql) && seen.binds.at(-1)?.[1] === 1001,
    `${globalSql} ${JSON.stringify(seen.binds.at(-1))}`);

  const uploadResponse = await call(env, "/api/admin/brain/source-families?source=upload&limit=1000");
  const upload = await uploadResponse.json();
  check("declared message families are inventoried under their source file namespace",
    uploadResponse.status === 200 && upload.families.join(",") === "upload:chat.txt",
    JSON.stringify(upload));

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
    source_type: "meeting", stored_documents: 3, logical_documents: 2,
    total: 4, embedded: 4, last_ingest_at: 1750000000000,
  }]);
  const documentsResponse = await call(env, "/api/admin/brain/documents");
  const b = await documentsResponse.json();
  check("documents names the backend", b.backend === "d1", JSON.stringify(b));
  check("documents separates source files from stored split parts",
    b.rows[0]?.documents === 2 && b.rows[0]?.logical_documents === 2 && b.rows[0]?.stored_documents === 3, JSON.stringify(b.rows[0]));
  check("and reports vector backlog", b.vector_backlog && "pending" in b.vector_backlog, JSON.stringify(b.vector_backlog));
  check("and reports exact query-visible vector readiness",
    b.vector_readiness?.ready === true && b.vector_readiness.expected_vectors === 0 &&
      b.vector_readiness.actual_vectors === 0,
    JSON.stringify(b.vector_readiness));
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

{
  const { env } = mkEnv([], {
    outboxRow: { n: 1, oldest: 100, upserts: 1, deletes: 0, submitted: 1 },
    readinessRow: {
      schema_version: 12,
      mutation_id: "fixture-accepted-not-visible",
      mutation_submitted_at: 100,
      projection_status: "pending",
      bootstrap_epoch: 0,
      bootstrap_cursor: null,
      bootstrap_high_water: null,
      expected_vectors: 1,
      pending: 1,
      submitted: 1,
      oldest_queued_at: 100,
    },
    extra: {
      VECTORIZE: {
        describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
      },
    },
  });
  const body = await (await call(env, "/api/admin/brain/documents")).json();
  check("documents cannot false-green an accepted mutation before query visibility",
    body.vector_backlog?.pending === 1 && body.vector_backlog?.submitted === 1 &&
      body.vector_readiness?.ready === false &&
      body.vector_readiness?.reason === "accepted_mutation_processing" &&
      body.vector_readiness?.expected_vectors === 1 && body.vector_readiness?.actual_vectors === 0,
    JSON.stringify(body));
}

/* ================= batch ingest ================= */

// A batch env whose ingest can be made to explode on a chosen document, so the
// partial-failure path is exercised rather than assumed.
function mkBatchEnv({ explodeOn = null, finalizeFailSource = null, failChunkDocUid = null, preflightFail = false } = {}) {
  const written = [];
  const storedTexts = [];
  const documents = new Map();
  const calls = {
    remote: 0,
    submitted_statements: 0,
    stats_scans: 0,
    stats_attempts: 0,
    finalizer_batches: 0,
  };
  const control = { explodeOn, finalizeFailSource, failChunkDocUid, preflightFail };
  const execute = (sql, b) => {
    let changes = 0;
    if (/INSERT INTO documents/.test(sql)) {
      if (control.explodeOn && String(b[2]) === control.explodeOn) throw new Error("D1 write failed");
      const prior = documents.get(b[0]) || {};
      documents.set(b[0], {
        ...prior,
        doc_uid: b[0], source: b[1], source_id: b[2], title: b[3],
        uri: b[4], document_date: b[5], date_source: b[6], date_reliable: b[7],
        client: b[8], category: b[9], top_folder: b[10], platform: b[11],
        content_hash: b[13], meta: b[14],
      });
      written.push(String(b[2]));
      changes = 1;
    } else if (/INSERT INTO chunks/.test(sql)) {
      storedTexts.push(String(b[3] || ""));
      changes = 1;
    } else if (/INSERT INTO vector_outbox/.test(sql)) {
      // A guarded upsert that follows the document marker inside the same D1
      // transaction must report one changed queue row. Replacement deletes may
      // also use this shape; their count is not part of receipt verification.
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
              calls.submitted_statements++;
              return /SELECT doc_uid, content_hash FROM documents/.test(sql)
                ? b.map((docUid) => documents.get(docUid)).filter(Boolean)
                : [];
            })(),
          }),
          first: async () => {
            calls.remote++;
            calls.submitted_statements++;
            if (/SELECT content_hash, title/.test(sql)) return documents.get(b[0]) || null;
            if (/SELECT client, category/.test(sql)) return documents.get(b[0]) || null;
            return null;
          },
          run: async () => {
            calls.remote++;
            calls.submitted_statements++;
            const result = execute(sql, b);
            return { success: true, meta: { changes: result.changes } };
          },
        }),
      }),
      batch: async (statements) => {
        calls.remote++;
        calls.submitted_statements += statements.length;
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
  return { env, written, storedTexts, documents, calls, control };
}
const post = (env, path, body) =>
  worker.fetch(new Request("https://b.example" + path, {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, { waitUntil() {}, passThroughOnException() {} });

const doc = (id, content = "some ordinary meeting content about the retainer") =>
  ({ source_type: "meeting", source_id: id, title: `T${id}`, content });

{
  const { env, storedTexts, documents } = mkBatchEnv();
  const paymentToken = "Qz8Lm4".repeat(8);
  const capabilityUrl = `https://invoice.stripe.com/i/acct_fixture123/test_${paymentToken}`;
  const response = await worker.fetch(new Request("https://b.example/api/admin/brain/ingest", {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({
      source_type: "message", source_id: "stable-single",
      content: `Billing remains active. https://billing.stripe.com/p/session/live_${paymentToken} Follow up Friday.`,
      uri: capabilityUrl,
      date_source: `billing import ${capabilityUrl}`,
      metadata: {
        [`private lookup ${capabilityUrl}`]: `billing metadata ${capabilityUrl}`,
      },
    }),
  }), env, {});
  const receipt = await response.text();
  const stored = storedTexts.join("\n");
  const durableDocument = JSON.stringify(documents.get("message:stable-single") || {});
  check("single ingest stores useful prose with a fixed capability-link marker",
    response.status === 200 && stored.includes("Billing remains active.") && stored.includes("[REDACTED:sensitive_payment_url]"));
  check("single ingest never stores or echoes the capability URL token",
    !stored.includes(paymentToken) && !durableDocument.includes(paymentToken) && !receipt.includes(paymentToken));
  check("single ingest sanitizes D1 URI, date source, and metadata keys before storage",
    durableDocument.includes("[REDACTED:sensitive_payment_url]") &&
      !durableDocument.includes("invoice.stripe.com"));
}

{
  const paymentToken = "Vr6Ny3".repeat(8);
  const capabilityUrl = `https://invoice.stripe.com/i/acct_fixture123/test_${paymentToken}`;
  const observedLogs = [];
  const rpcCalls = [];
  const originalFetch = globalThis.fetch;
  const original = { log: console.log, warn: console.warn, error: console.error };
  let response;
  try {
    globalThis.fetch = async (url, options = {}) => {
      rpcCalls.push({ url: String(url), body: String(options.body || "") });
      return new Response(JSON.stringify([{ id: "synthetic-row", action: "created" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    console.log = (...args) => observedLogs.push(args.map(String).join(" "));
    console.warn = (...args) => observedLogs.push(args.map(String).join(" "));
    console.error = (...args) => observedLogs.push(args.map(String).join(" "));
    response = await worker.fetch(new Request("https://b.example/api/admin/brain/ingest", {
      method: "POST",
      headers: { "X-Admin-Key": "k", "content-type": "application/json" },
      body: JSON.stringify({
        source_type: "message",
        source_id: "stable-legacy-message",
        source_subtype: `billing thread ${capabilityUrl}`,
        content: "Useful billing context remains searchable.",
        metadata: {
          [`private lookup ${capabilityUrl}`]: `Follow-up context ${capabilityUrl}`,
        },
      }),
    }), {
      STORAGE: "supabase",
      ADMIN_KEY: "k",
      SUPABASE_URL: "https://supabase.example.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role",
    }, {});
  } finally {
    globalThis.fetch = originalFetch;
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const rawReceipt = await response.text();
  const rpcBody = rpcCalls[0]?.body || "";
  const parsedRpc = JSON.parse(rpcBody || "{}");
  check("legacy Supabase source_subtype is sanitized before its RPC storage boundary",
    response.status === 200 &&
      parsedRpc.p_source_subtype.includes("billing thread") &&
      parsedRpc.p_source_subtype.includes("[REDACTED:sensitive_payment_url]"));
  check("legacy Supabase RPC input, receipt, and logs never contain the capability token",
    rpcCalls.length === 1 &&
      !rpcBody.includes(paymentToken) && !rpcBody.includes("invoice.stripe.com") &&
      !rawReceipt.includes(paymentToken) && !observedLogs.join("\n").includes(paymentToken));
  check("legacy Supabase metadata keys and values are sanitized without dropping useful prose",
    rpcBody.includes("private lookup [REDACTED:sensitive_payment_url]") &&
      rpcBody.includes("Follow-up context [REDACTED:sensitive_payment_url]") &&
      parsedRpc.p_content === "Useful billing context remains searchable.");
}

{
  const paymentToken = "Nm9Qw2".repeat(8);
  const capabilityUrl = `https://invoice.stripe.com/i/acct_fixture123/live_${paymentToken}?s=em`;

  const single = mkBatchEnv();
  const singleResponse = await worker.fetch(new Request("https://b.example/api/admin/brain/ingest", {
    method: "POST", headers: { "X-Admin-Key": "k", "content-type": "application/json" },
    body: JSON.stringify({ source_type: "message", source_id: capabilityUrl, content: "Useful billing prose." }),
  }), single.env, {});
  const singleReceipt = await singleResponse.text();
  check("single ingest fails closed when a capability URL is used as source_id",
    singleResponse.status === 422 && single.written.length === 0 && single.storedTexts.length === 0);
  check("unsafe single-ingest identity is never echoed",
    !singleReceipt.includes(paymentToken) && !singleReceipt.includes("invoice.stripe.com"));

  const batch = mkBatchEnv();
  const observedLogs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  let batchResponse;
  try {
    console.log = (...args) => observedLogs.push(args.map(String).join(" "));
    console.warn = (...args) => observedLogs.push(args.map(String).join(" "));
    console.error = (...args) => observedLogs.push(args.map(String).join(" "));
    batchResponse = await post(batch.env, "/api/admin/brain/ingest/batch", {
      docs: [
        { source_type: "message", source_id: capabilityUrl, content: "One" },
        { source_type: capabilityUrl, source_id: "stable-id", content: "Two" },
        { source_type: "message", source_id: { nested: capabilityUrl }, content: "Three" },
      ],
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const rawReceipt = await batchResponse.text();
  const receipt = JSON.parse(rawReceipt);
  check("batch ingest fails closed without echoing an unsafe source identity",
    receipt.refused === 3 && receipt.results.every((slot) =>
      slot.source_id === null && slot.source_type === null && slot.status === "refused"), rawReceipt);
  check("unsafe batch identity reaches no store, vector-bound text, receipt, or log",
    batch.written.length === 0 && batch.storedTexts.length === 0 &&
      !rawReceipt.includes(paymentToken) && !observedLogs.join("\n").includes(paymentToken));
}

{
  const { env } = mkBatchEnv();
  const r = await post(env, "/api/admin/brain/ingest/batch", { docs: [doc("a"), doc("b"), doc("c")] });
  const b = await r.json();
  check("batch ingests every document", b.total === 3 && b.created === 3, JSON.stringify(b).slice(0, 200));
  check("and reports one result slot per document", b.results.length === 3);
  check("each slot names its source_id, so a caller can resume precisely",
    b.results.every((x, i) => x.source_id === ["a", "b", "c"][i]), JSON.stringify(b.results));
}

/* Capability URLs are removed without discarding the billing record. All
   connector and migration source types converge at this exact storage gate. */
{
  const { env, storedTexts } = mkBatchEnv();
  const paymentToken = "Xy7Ab9".repeat(8);
  const billing = `Billing remains active through Friday. https://invoice.stripe.com/i/acct_fixture123/live_${paymentToken}?s=em Follow up next week.`;
  const docs = ["drive", "gmail", "message", "migration"].map((source, index) => ({
    source_type: source,
    source_id: `stable-${index}`,
    title: `Billing ${index}`,
    content: billing,
  }));
  const response = await post(env, "/api/admin/brain/ingest/batch", { docs });
  const rawReceipt = await response.text();
  const receipt = JSON.parse(rawReceipt);
  const stored = storedTexts.join("\n");
  check("Drive, Gmail, messages and migrations keep their stable receipt identity",
    receipt.results.every((slot, index) => slot.source_id === `stable-${index}`), rawReceipt);
  check("capability URLs never reach D1 or vector-bound chunk text",
    !stored.includes(paymentToken) && stored.includes("[REDACTED:sensitive_payment_url]"));
  check("useful billing context survives capability-link sanitization",
    stored.includes("Billing remains active through Friday.") && stored.includes("Follow up next week."));
  check("capability URLs never enter the ingest receipt",
    !rawReceipt.includes(paymentToken) && !rawReceipt.includes("invoice.stripe.com"));
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

/* The byte cap alone is insufficient. At default geometry this 900KB body is
   roughly 750 chunks and would submit well over D1's 1,000-query invocation
   ceiling. It must stop before even the read-only preflight. */
{
  const { env, written, calls } = mkBatchEnv();
  const response = await post(env, "/api/admin/brain/ingest/batch", {
    docs: [doc("over-query-budget", "x".repeat(900_000))],
  });
  const body = await response.json();
  check("a 900KB multi-chunk request is refused by the pre-write D1 budget",
    response.status === 413 && body.estimated_statements > body.max_statements,
    JSON.stringify(body));
  check("the query-budget refusal performs zero D1 calls, statements, or writes",
    calls.remote === 0 && calls.submitted_statements === 0 && written.length === 0,
    JSON.stringify(calls));
  check("the budget refusal gives bounded segmentation guidance",
    body.detail?.includes("fewer or smaller") && body.detail?.includes("Nothing was written"),
    JSON.stringify(body));
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
  check("the atomic per-document stage cuts a 50-document batch to 53 D1 calls",
    calls.remote === 53 && calls.remote < legacyCalls, `${calls.remote} vs ${legacyCalls}`);
  check("the same request submits 352 paid D1 statements, not 53 queries",
    calls.submitted_statements === 352, JSON.stringify(calls));

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

/* A small-document stage is one isolated D1 transaction. A chunk failure rolls
   back that document completely and cannot be hidden by successful neighbors. */
{
  const failedUid = "meeting:middle";
  const { env, documents, control } = mkBatchEnv({ failChunkDocUid: failedUid });
  const docs = [doc("first"), doc("middle"), doc("last")];
  const first = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("a chunk-stage failure keeps its own receipt failed and its neighbors committed",
    first.created === 2 && first.failed === 1 && first.results.find((row) => row.source_id === "middle")?.status === "failed",
    JSON.stringify(first));
  check("the failed atomic stage leaves no partial document revision",
    !documents.has(failedUid), documents.get(failedUid)?.content_hash || "missing");
  check("successful neighbors still commit their exact revision markers",
    /^[a-f0-9]{64}$/.test(documents.get("meeting:first")?.content_hash || "") &&
      /^[a-f0-9]{64}$/.test(documents.get("meeting:last")?.content_hash || ""));

  control.failChunkDocUid = null;
  const retry = await (await post(env, "/api/admin/brain/ingest/batch", { docs })).json();
  check("retry creates the rolled-back revision without rewriting its neighbors",
    retry.created === 1 && retry.unchanged === 2 && retry.failed === 0, JSON.stringify(retry));
}

/* A document just above our 100-statement atomic-stage slice retains the
   proven resumable path. If its chunk batch fails after the marker write, the
   pending revision remains visible and a retry repairs it. */
{
  const failedUid = "meeting:large-interrupted";
  const { env, documents, control } = mkBatchEnv({ failChunkDocUid: failedUid });
  const large = doc("large-interrupted", "x".repeat(58_500)); // 49 chunks: 101 atomic-stage statements.
  const first = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [large] })).json();
  check("an over-slice document remains a retryable per-document failure",
    first.failed === 1 && first.results[0]?.source_id === "large-interrupted", JSON.stringify(first));
  check("the large-document fallback preserves its pending revision",
    String(documents.get(failedUid)?.content_hash).startsWith("pending:"), documents.get(failedUid)?.content_hash || "missing");

  control.failChunkDocUid = null;
  const repaired = await (await post(env, "/api/admin/brain/ingest/batch", { docs: [large] })).json();
  check("retry repairs the fallback revision through its original path",
    repaired.updated === 1 && repaired.failed === 0, JSON.stringify(repaired));
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
                  : /FROM vector_outbox/.test(q)
                    ? b.map((chunkUid, index) => ({
                      chunk_uid: chunkUid, vector_id: chunkUid, generation: index + 1,
                    }))
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
  check("physical vector cleanup is queued for the one leased writer",
    deleted.length === 0 && b.vectors === 0 && b.vector_cleanup_queued === 3,
    JSON.stringify({ body: b, deleted }));
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
  // Provider availability cannot make forget partially execute. Content is
  // already unreachable in D1 and the leased drain owns physical cleanup.
  const { env } = mkForgetEnv({ vectorThrows: true });
  const b = await (await post(env, "/api/admin/brain/forget", { source: "meeting", confirm: true })).json();
  check("enqueue-only forget does not call an unavailable vector provider",
    b.vector_error === null && b.vector_cleanup_queued === 3, JSON.stringify(b));
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

/* A paused compatibility deployment is a complete corpus-write barrier, not
   merely a drain pause. This protects every independently committed migration
   statement and D1 time-travel restore from concurrent request mutations. */
{
  let forbiddenCalls = 0;
  const forbid = () => { forbiddenCalls++; throw new Error("paused drain touched a provider"); };
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    BRAIN_VERSION: "fixture-version",
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: { prepare: forbid, batch: forbid },
    AI: { run: forbid },
    VECTORIZE: { upsert: forbid, deleteByIds: forbid },
  };
  const health = await (await worker.fetch(new Request("https://b.example/health"), env, {})).json();
  check("paused compatibility health proves the leased writer protocol and mode",
    health.version === "fixture-version" && health.vector_writer_protocol === "lease-v1" &&
      health.vector_drain_mode === "paused-for-upgrade", JSON.stringify(health));

  const manual = await post(env, "/api/admin/brain/drain", {});
  const manualBody = await manual.json();
  check("a manual drain fails closed while an upgrade cutover is paused",
    manual.status === 503 && manualBody.paused === true, JSON.stringify(manualBody));

  const pausedMutations = [
    ["/api/admin/brain/ingest", { source_type: "drive", source_id: "one", content: "fixture" }],
    ["/api/admin/brain/ingest/batch", { documents: [] }],
    ["/api/admin/brain/source-receipt", { source: "drive", status: "ready" }],
    ["/api/admin/brain/source-expectation", { source: "drive", expected_interval_hours: 24 }],
    ["/api/admin/brain/forget", { source: "drive", confirm: true }],
    ["/api/admin/brain/reindex", { confirm: true }],
  ];
  let everyMutationPaused = true;
  const pauseDetails = [];
  for (const [path, body] of pausedMutations) {
    const response = await post(env, path, body);
    const receipt = await response.json();
    pauseDetails.push({ path, status: response.status, receipt });
    if (response.status !== 503 || receipt.paused !== true) everyMutationPaused = false;
  }
  check("paused mode rejects every corpus, outbox, and source mutation route",
    everyMutationPaused, JSON.stringify(pauseDetails));

  let readOnlyD1Calls = 0;
  const readOnlyEnv = {
    ...env,
    DB: {
      prepare() {
        const statement = {
          bind: () => statement,
          all: async () => { readOnlyD1Calls++; return { results: [] }; },
        };
        return statement;
      },
    },
  };
  const sourceFamilies = await post(readOnlyEnv, "/api/admin/brain/source-families", {
    source: "drive",
  });
  check("paused mode keeps authenticated read-only source-family inventory available",
    sourceFamilies.status === 200 && readOnlyD1Calls === 1,
    `${sourceFamilies.status}/${readOnlyD1Calls}`);

  let scheduledPromise = null;
  await worker.scheduled({}, env, {
    waitUntil(promise) { scheduledPromise = promise; },
  });
  await scheduledPromise;
  check("paused requests and scheduled drains perform zero mutation D1, AI, or Vectorize calls",
    forbiddenCalls === 0, String(forbiddenCalls));
}

/* The one paused-mode write exception is the authenticated schema-13 bootstrap
   coordinator. Its public contract is aggregate-only and fixed so the CLI can
   fail closed on any incompatible Worker. */
{
  let aiCalls = 0;
  let vectorWrites = 0;
  let d1Writes = 0;
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    VECTOR_DRAIN_MODE: "paused-for-upgrade",
    AI: { run: async () => { aiCalls++; throw new Error("empty bootstrap embedded"); } },
    VECTORIZE: {
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
      upsert: async () => { vectorWrites++; throw new Error("empty bootstrap wrote vectors"); },
    },
    DB: {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          run: async () => {
            d1Writes++;
            return { meta: { changes: 1 } };
          },
          first: async () => {
            if (/SELECT schema_version, vector_projection_status AS status/.test(sql)) {
              return {
                schema_version: 13,
                status: "verified",
                epoch: 0,
                cursor: null,
                high_water: null,
                protocol: "bootstrap-v2",
                base_count: 0,
              };
            }
            if (/^SELECT count\(\*\) AS n FROM chunks/.test(sql.trim())) return { n: 0 };
            if (/sum\(CASE WHEN submitted_mutation_id IS NULL/.test(sql)) {
              return { n: 0, queued: 0, submitted: 0, failed: 0 };
            }
            if (/FROM vector_bootstrap_batches WHERE epoch/.test(sql)) {
              return { confirmed: 0, in_flight: 0 };
            }
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 13,
                mutation_id: null,
                mutation_submitted_at: null,
                projection_status: "verified",
                bootstrap_epoch: 0,
                bootstrap_cursor: null,
                bootstrap_high_water: null,
                expected_vectors: 0,
                pending: 0,
                submitted: 0,
                oldest_queued_at: null,
              };
            }
            throw new Error(`unexpected bootstrap SQL: ${sql}`);
          },
        };
        return statement;
      },
    },
  };
  const response = await post(env, "/api/admin/brain/bootstrap", {});
  const receipt = await response.json();
  check("the paused schema-13 bootstrap route returns the strict aggregate contract",
    response.status === 200 && receipt.protocol === "bootstrap-v2" &&
      receipt.phase === "complete" && receipt.complete === true &&
      JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify([
        "actual_vectors", "complete", "confirmed", "epoch", "expected_vectors", "failed",
        "in_flight_batches", "phase", "protocol", "queued", "remaining", "retrying",
        "submitted", "total", "vector_ready",
      ]),
    JSON.stringify(receipt));
  check("an empty bootstrap performs no embedding or vector write",
    aiCalls === 0 && vectorWrites === 0 && d1Writes === 1,
    JSON.stringify({ aiCalls, vectorWrites, d1Writes }));

  const busyEnv = {
    ...env,
    DB: {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          run: async () => {
            if (/SET vector_drain_lease_owner/.test(sql)) return { meta: { changes: 0 } };
            throw new Error(`unexpected busy bootstrap write: ${sql}`);
          },
          first: async () => {
            if (/SELECT schema_version, vector_projection_status AS status/.test(sql)) {
              return {
                schema_version: 13,
                status: "bootstrap_required",
                epoch: 4,
                cursor: null,
                high_water: null,
                protocol: "bootstrap-v2",
                base_count: 0,
              };
            }
            if (/CASE WHEN vector_drain_lease_owner IS NULL/.test(sql)) {
              return { held: 1, schema_ready: 1, expires_at: Date.now() + 180_000 };
            }
            if (/^SELECT count\(\*\) AS n FROM chunks/.test(sql.trim())) return { n: 0 };
            if (/sum\(CASE WHEN submitted_mutation_id IS NULL/.test(sql)) {
              return { n: 0, queued: 0, submitted: 0, failed: 0 };
            }
            if (/FROM vector_bootstrap_batches WHERE epoch/.test(sql)) {
              return { confirmed: 0, in_flight: 0 };
            }
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 13,
                mutation_id: null,
                mutation_submitted_at: null,
                projection_status: "bootstrap_required",
                bootstrap_epoch: 4,
                bootstrap_cursor: null,
                bootstrap_high_water: null,
                expected_vectors: 0,
                pending: 0,
                submitted: 0,
                oldest_queued_at: null,
              };
            }
            throw new Error(`unexpected busy bootstrap SQL: ${sql}`);
          },
        };
        return statement;
      },
    },
  };
  const busyResponse = await post(busyEnv, "/api/admin/brain/bootstrap", {});
  const busyReceipt = await busyResponse.json();
  check("the bootstrap route returns the CLI's exact lease-busy contract",
    busyResponse.status === 409 && busyReceipt.protocol === "bootstrap-v2" &&
      busyReceipt.busy === true && busyReceipt.remaining === 0 &&
      Number.isInteger(busyReceipt.retry_after_seconds) &&
      JSON.stringify(Object.keys(busyReceipt).sort()) === JSON.stringify([
        "busy", "protocol", "remaining", "retry_after_seconds",
      ]),
    JSON.stringify(busyReceipt));

  let activeProviderCalls = 0;
  const activeEnv = {
    ...env,
    VECTOR_DRAIN_MODE: "active",
    DB: { prepare: () => { activeProviderCalls++; throw new Error("active bootstrap touched D1"); } },
    AI: { run: async () => { activeProviderCalls++; } },
    VECTORIZE: { upsert: async () => { activeProviderCalls++; } },
  };
  const active = await post(activeEnv, "/api/admin/brain/bootstrap", {});
  const activeBody = await active.json();
  check("the bootstrap route refuses active mode before any provider access",
    active.status === 409 && activeBody.paused === false && activeProviderCalls === 0,
    JSON.stringify({ activeBody, activeProviderCalls }));
  const unauthorized = await worker.fetch(new Request(
    "https://b.example/api/admin/brain/bootstrap",
    { method: "POST", body: "{}" },
  ), env, {});
  check("the bootstrap route remains behind the admin key", unauthorized.status === 401,
    String(unauthorized.status));
}

{
  let attemptedOwner = null;
  let vectorWrites = 0;
  let outboxMutations = 0;
  const observedLogs = [];
  const env = {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    AI: { run: async () => { throw new Error("busy drain reached embedding"); } },
    VECTORIZE: { upsert: async () => { vectorWrites++; } },
    DB: {
      prepare(q) {
        const shape = (b = []) => ({
          bind: (...next) => shape(next),
          run: async () => {
            if (/SET vector_drain_lease_owner = \?1/.test(q)) attemptedOwner = b[0];
            return { meta: { changes: 0 } };
          },
          first: async () => {
            if (/CASE WHEN vector_drain_lease_owner IS NULL/.test(q)) {
              return { held: 1, schema_ready: 1, expires_at: Date.now() + 60_000 };
            }
            if (/count\(\*\).*vector_outbox/i.test(q)) return { n: 7 };
            return null;
          },
          all: async () => ({ results: [] }),
        });
        return shape();
      },
      batch: async () => { outboxMutations++; },
    },
  };
  const originalLog = console.log;
  try {
    console.log = (...args) => observedLogs.push(args.map(String).join(" "));
    const response = await post(env, "/api/admin/brain/drain", {});
    const raw = await response.text();
    const body = JSON.parse(raw);
    check("a busy manual drain returns an explicit fail-closed conflict",
      response.status === 409 && body.busy === true && body.remaining === 7,
      raw);
    check("the busy conflict performs no embedding, vector write, or outbox mutation",
      vectorWrites === 0 && outboxMutations === 0, JSON.stringify({ vectorWrites, outboxMutations }));
    check("the busy response and logs never expose either lease owner token",
      typeof attemptedOwner === "string" && !raw.includes(attemptedOwner) &&
        !observedLogs.join("\n").includes(attemptedOwner) &&
        !raw.includes("vector_drain_lease_owner"), raw);
  } finally {
    console.log = originalLog;
  }
}

/* ---------------------------------------------------------------------------
 * A grant credential is a third way in, and it must be exactly as narrow as
 * the grant says. These drive the real worker fetch, so a capability check
 * that never reached the request path fails here rather than passing quietly.
 */
{
  const { hashToken } = await import("../src/lib/grants.js");
  const bookkeeperToken = "bookkeeper-token-value";
  const bookkeeperHash = await hashToken(bookkeeperToken);

  const grantEnv = (row) => ({
    STORAGE: "d1",
    ADMIN_KEY: "owner-key",
    DB: {
      prepare(sql) {
        return {
          bind: (...b) => ({
            async first() {
              if (/FROM grant_credentials/.test(sql)) return b[0] === bookkeeperHash ? row : null;
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 0 } }; },
          }),
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    },
  });

  const liveBookkeeper = {
    grant_id: "g-book", display_name: "Marla", capabilities: '["ask","file"]',
    expires_at: null, revoked_at: null, credential_revoked_at: null,
  };

  const call = (env, path, token) => worker.fetch(new Request(
    `https://b.example${path}`,
    { method: "POST", body: "{}", headers: token ? { "X-Admin-Key": token } : {} },
  ), env, { waitUntil() {} });

  const denied = await call(grantEnv(liveBookkeeper), "/api/admin/brain/forget", bookkeeperToken);
  check("a grant without `destroy` cannot reach a destroy route",
    denied.status === 401, String(denied.status));

  const deniedBody = await denied.json();
  check("refusing on capability is indistinguishable from refusing on identity",
    deniedBody.error === "unauthorized", JSON.stringify(deniedBody));

  const unknown = await call(grantEnv(liveBookkeeper), "/api/admin/brain/forget", "not-a-real-token");
  check("an unrecognised credential is refused the same way",
    unknown.status === 401, String(unknown.status));

  const revoked = await call(
    grantEnv({ ...liveBookkeeper, revoked_at: 1 }), "/api/rag/think", bookkeeperToken);
  check("a revoked grant cannot ask questions either",
    revoked.status === 401, String(revoked.status));

  const unclassified = await call(
    grantEnv(liveBookkeeper), "/api/admin/brain/some-route-invented-later", bookkeeperToken);
  check("a route nobody classified is owner-only, so a grant cannot reach it",
    unclassified.status === 401, String(unclassified.status));

  // Every check above is a refusal, and refusals also pass when the credential
  // was never recognised at all. This one proves the grant genuinely
  // authenticates: the same token, on a route its capabilities DO cover, must
  // get past the gate. Anything other than 401 means it was let through.
  const allowed = await call(grantEnv(liveBookkeeper), "/api/admin/brain/ingest", bookkeeperToken);
  check("a grant WITH `file` is actually let through to a file route",
    allowed.status !== 401,
    `got ${allowed.status}; a 401 here means grants never authenticate and the refusals above prove nothing`);
}


/* ---------------------------------------------------------------------------
 * Zones. The claim being tested is narrow and is the whole feature: the zone
 * predicate must reach the SAME query that reads chunk text, because that is
 * where a snippet comes from. A scope that is merely honoured "somewhere"
 * would still leak through snippets.
 */
{
  const { scopeSql } = await import("../src/lib/store-d1.js");

  const owner = scopeSql(null, "c", 1);
  check("an unscoped principal gets no predicate at all",
    owner.clause === "" && owner.params.length === 0, JSON.stringify(owner));

  const all = scopeSql({ all: true }, "c", 1);
  check("an explicit all-zones scope is also unrestricted",
    all.clause === "" && all.params.length === 0, JSON.stringify(all));

  const books = scopeSql({ zones: ["books"] }, "c", 1);
  check("a scoped principal is restricted through its source's zone",
    /c\.source IN \(SELECT name FROM sources WHERE zone IN \(\?1\)\)/.test(books.clause)
      && books.params[0] === "books", JSON.stringify(books));

  const minusMedical = scopeSql({ zones: ["books", "legal"], exclude: ["medical"] }, "c", 1);
  check("exclusion is expressed as well as inclusion",
    /source IN \(SELECT name FROM sources WHERE zone IN \(\?1,\?2\)\)/.test(minusMedical.clause)
      && /source NOT IN \(SELECT name FROM sources WHERE zone IN \(\?3\)\)/.test(minusMedical.clause),
    minusMedical.clause);

  // The most dangerous possible bug in this function.
  const empty = scopeSql({ zones: [] }, "c", 1);
  check("a scope naming no zones reads NOTHING, rather than everything",
    empty.clause === " AND 1 = 0", JSON.stringify(empty));

  const unknown = scopeSql({ zones: ["books"] }, "c", 1);
  check("a source with no zone falls outside every scope by SQL semantics",
    /zone IN/.test(unknown.clause) && !/IS NULL/.test(unknown.clause),
    "an unzoned source must not match an IN list, and must not be special-cased back in");
}



/* ---- the zone predicate must reach the query that reads the TEXT ---- */
{
  const { search } = await import("../src/lib/store-d1.js");
  const { env, seen } = mkEnv([ROW], { vectorIds: ["meeting:123#0"] });

  const scoped = await search(env, {
    query: "retainer",
    embedding: [0.1, 0.2],
    limit: 5,
    filters: {},
    scope: { zones: ["books"] },
  }).catch(() => {});

  const kw = seen.sql.find((sql) => /chunks_fts MATCH/.test(sql));
  check("a scoped read narrows the keyword query",
    /c\.source IN \(SELECT name FROM sources/.test(kw || ""), String(kw));

  const hydration = seen.sql.find(
    (sql) => /FROM chunks c JOIN documents d/.test(sql) && /c\.chunk_uid IN/.test(sql));
  check("a scoped read never spends top-K on unauthorized vector candidates",
    seen.vectorQueries.length === 0 && hydration === undefined,
    JSON.stringify({ vectorQueries: seen.vectorQueries, hydration }));

  check("the unavailable scoped-vector path is explicit instead of looking healthy",
    scoped?.degraded === "scoped-vector"
      && scoped?.degraded_reason === "zone-scope-keyword-only",
    JSON.stringify(scoped));

  const bound = seen.binds.find((b) => b.includes("books"));
  check("and the zone value is actually bound, not just written into the SQL",
    !!bound, JSON.stringify(seen.binds));

  // The owner must not pay for any of this.
  const { env: ownerEnv, seen: ownerSeen } = mkEnv([ROW], { vectorIds: ["meeting:123#0"] });
  await search(ownerEnv, { query: "retainer", embedding: [0.1], limit: 5, filters: {} }).catch(() => {});
  const ownerKw = ownerSeen.sql.find((sql) => /chunks_fts MATCH/.test(sql));
  check("an unscoped read carries no zone predicate at all",
    !/zone/.test(ownerKw || ""), String(ownerKw));
}


/* ---- end to end: a scoped grant's zone must reach the SQL via the real route ---- */
{
  const { hashToken } = await import("../src/lib/grants.js");
  const token = "scoped-reader-token";
  const hash = await hashToken(token);

  const base = mkEnv([ROW], { vectorIds: ["meeting:123#0"] });
  const seen = base.seen;
  const grantRow = {
    grant_id: "g-books", capabilities: '["ask"]',
    expires_at: null, revoked_at: null, credential_revoked_at: null,
    scope_include: '{"zones":["books"]}', scope_exclude: '[]',
  };
  // Wrap the recording DB so the credential lookup resolves, while every other
  // query still lands in the same `seen` log.
  const env = { ...base.env, DB: {
    prepare(sql) {
      const stmt = base.env.DB.prepare(sql);
      if (!/FROM grant_credentials/.test(sql)) return stmt;
      return { bind: (...b) => ({
        async first() { return b[0] === hash ? grantRow : null; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; },
      }) };
    },
  } };

  globalThis.__ZONE_DEBUG = 1;
  const res = await worker.fetch(new Request("https://b.example/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": token, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "retainer" }),
  }), env, { waitUntil() {} });

  check("a scoped grant is admitted to the ask route", res.status !== 401, String(res.status));

  const kw = seen.sql.find((sql) => /chunks_fts MATCH/.test(sql));
  check("and its zone reaches the keyword SQL through the real request path",
    /c\.source IN \(SELECT name FROM sources/.test(kw || ""), String(kw));

  const bound = seen.binds.find((b) => b.includes("books"));
  check("and the zone from the GRANT ROW is what gets bound",
    !!bound, JSON.stringify(seen.binds));
}


/* ---- scoped WRITES: the two holes an adversarial review found ---- */
{
  const { hashToken } = await import("../src/lib/grants.js");
  const token = "scoped-filer-token";
  const hash = await hashToken(token);
  const grantRow = {
    grant_id: "g-books", capabilities: '["file","destroy"]',
    expires_at: null, revoked_at: null, credential_revoked_at: null,
    scope_include: '{"zones":["books"]}', scope_exclude: '[]',
  };

  // `books` is in the grant's zone; `medical` is not.
  const scopedEnv = () => {
    const base = mkEnv([ROW], { vectorIds: [] });
    return { ...base.env, DB: {
      prepare(sql) {
        if (/FROM grant_credentials/.test(sql)) {
          return { bind: (...b) => ({ async first() { return b[0] === hash ? grantRow : null; },
            async all() { return { results: [] }; }, async run() { return { meta: { changes: 0 } }; } }) };
        }
        if (/FROM sources WHERE zone IN/.test(sql)) {
          return { bind: () => ({ async all() { return { results: [{ name: "books" }] }; },
            async first() { return null; }, async run() { return { meta: { changes: 0 } }; } }) };
        }
        return base.env.DB.prepare(sql);
      },
    } };
  };

  const post = (path, payload) => worker.fetch(new Request(`https://b.example${path}`, {
    method: "POST",
    headers: { "X-Admin-Key": token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }), scopedEnv(), { waitUntil() {} });

  // The reconnaissance hole: forget's DRY RUN is the default and returned the
  // full doc_uid list of any source, which is real file ids and paths.
  const recon = await post("/api/admin/brain/forget", { source: "medical" });
  check("a scoped destroy cannot dry-run another zone's source for its doc_uids",
    recon.status === 403, String(recon.status));

  const reconBody = await recon.json();
  check("and the refusal returns no targets at all",
    !("targets" in reconBody), JSON.stringify(reconBody).slice(0, 200));

  const del = await post("/api/admin/brain/forget", { source: "medical", confirm: true });
  check("nor delete it", del.status === 403, String(del.status));

  const own = await post("/api/admin/brain/forget", { source: "books" });
  check("but its OWN zone is still reachable, so the check is a boundary not a wall",
    own.status !== 403, String(own.status));

  // The write hole: source_type is caller-chosen and decides the zone.
  const plant = await post("/api/admin/brain/ingest",
    { source_type: "medical", source_id: "x", content: "planted" });
  check("a scoped filer cannot write into a source in another zone",
    plant.status === 403, String(plant.status));

  const unknown = await post("/api/admin/brain/ingest",
    { source_type: "brand-new-source", source_id: "x", content: "hello" });
  check("nor invent a new source, whose documents would be born unzoned",
    unknown.status === 403, String(unknown.status));
}


/* ---- the leaks that carry no document text, and still tell you too much ---- */
{
  const { capabilityForRoute } = await import("../src/lib/grants.js");

  check("drain is not grantable: it pushes every zone's text to the embedder",
    capabilityForRoute("/api/admin/brain/drain") === "administer",
    capabilityForRoute("/api/admin/brain/drain"));

  const { hashToken } = await import("../src/lib/grants.js");
  const token = "scoped-diagnoser";
  const hash = await hashToken(token);
  const row = {
    grant_id: "g-books", capabilities: '["ask","diagnose"]',
    expires_at: null, revoked_at: null, credential_revoked_at: null,
    scope_include: '{"zones":["books"]}', scope_exclude: '[]',
  };
  const base = mkEnv([ROW], { vectorIds: [] });
  const env = { ...base.env, DB: {
    prepare(sql) {
      if (/FROM grant_credentials/.test(sql)) {
        return { bind: (...b) => ({ async first() { return b[0] === hash ? row : null; },
          async all() { return { results: [] }; }, async run() { return { meta: { changes: 0 } }; } }) };
      }
      return base.env.DB.prepare(sql);
    },
  } };

  const diag = await worker.fetch(new Request("https://b.example/api/admin/brain/diagnose", {
    method: "GET", headers: { "X-Admin-Key": token },
  }), env, { waitUntil() {} });
  check("a scoped diagnose grant cannot pull the whole-corpus report",
    diag.status === 403, String(diag.status));

  const diagBody = await diag.json();
  check("and the refusal carries no findings, samples or titles",
    !("findings" in diagBody) && !("samples" in diagBody),
    JSON.stringify(diagBody).slice(0, 160));
}

console.log(fail ? `\n${fail} FAILURES` : `\nroutes: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
