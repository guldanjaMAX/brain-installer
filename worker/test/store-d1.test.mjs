import {
  D1_QUERY_BIND_LIMIT, RETRIEVAL_CANDIDATE_DEPTH, collapseRankedDocuments, forget,
  fuseRRF, search, searchVector, upsertChunks, replaceDocumentChunks,
  canStageDocumentRevision, stageDocumentRevision, metadataTokenFor, vectorFilterFor,
} from "../src/lib/store-d1.js";
import {
  currentEvidenceCandidates, hasExplicitCurrentIntent, matchesEntityAnchors,
  queryEntityAnchors,
} from "../src/lib/query-intent.js";
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

/* A full 100-id Vectorize page plus exact D1 filters must be hydrated in
   bind-safe statements rather than disappearing behind the search fallback. */
{
  const vectorRows = Array.from({ length: RETRIEVAL_CANDIDATE_DEPTH }, (_, index) => ({
    chunk_uid: `bind-safe-${index}`, doc_uid: `bind-safe-doc-${index}`,
    source_id: `bind-safe-doc-${index}`, source: "message", client: "Taylor",
    category: "message", top_folder: "Clients", platform: "imessage",
    document_date: Date.parse("2026-08-19T00:00:00Z"), date_reliable: 1,
    text: `Taylor evidence ${index}`,
  }));
  const byId = new Map(vectorRows.map((row) => [row.chunk_uid, row]));
  const hydrationBinds = [];
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: async () => {
            if (!/FROM chunks c JOIN documents d/.test(sql)) return { results: [] };
            hydrationBinds.push(values.length);
            return { results: values.map((value) => byId.get(value)).filter(Boolean) };
          },
        }),
      }),
    },
    VECTORIZE: {
      query: async () => ({ matches: vectorRows.map((row) => ({ id: row.chunk_uid })) }),
    },
  };
  const hydrated = await searchVector(env, [0.1], {
    limit: RETRIEVAL_CANDIDATE_DEPTH,
    filters: {
      source: "message", client: "Taylor", category: "message",
      top_folder: "Clients", platform: "imessage",
      from: "2026-01-01", to: "2026-12-31",
    },
  });
  check("100 vector candidates plus filters hydrate without crossing D1's bind ceiling",
    hydrated.length === RETRIEVAL_CANDIDATE_DEPTH && hydrationBinds.length === 2 &&
      hydrationBinds.every((count) => count <= D1_QUERY_BIND_LIMIT),
    JSON.stringify({ hydrated: hydrated.length, hydrationBinds }));
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
    DB: {
      prepare: (sql) => /vector_projection_mutation_id AS mutation_id/.test(sql)
        ? ({ first: async () => ({
          schema_version: 12,
          mutation_id: null,
          mutation_submitted_at: null,
          projection_status: "verified",
          bootstrap_epoch: 0,
          bootstrap_cursor: null,
          bootstrap_high_water: null,
          expected_vectors: 0,
          pending: 0,
          submitted: 0,
          quarantined: 0,
          oldest_queued_at: null,
        }) })
        : ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
    },
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

/* ---- candidate depth and document fusion are route/limit independent ---- */
{
  const keywordLimits = [];
  const vectorLimits = [];
  const env = {
    DB: {
      prepare: () => ({
        bind: (...values) => ({
          all: async () => {
            if (values.length >= 2 && Number.isInteger(values[1])) keywordLimits.push(values[1]);
            return { results: [] };
          },
        }),
      }),
    },
    VECTORIZE: {
      query: async (_embedding, options) => {
        vectorLimits.push(options.topK);
        return { matches: [] };
      },
    },
  };
  await search(env, { query: "Taylor account", embedding: [0.1], limit: 2 });
  await search(env, { query: "Taylor account", embedding: [0.1], limit: 20 });
  check("keyword candidate depth does not change with the public limit",
    keywordLimits.length === 2 && keywordLimits.every((value) => value === RETRIEVAL_CANDIDATE_DEPTH),
    JSON.stringify(keywordLimits));
  check("vector candidate depth does not change with the public limit",
    vectorLimits.length === 2 && vectorLimits.every((value) => value === RETRIEVAL_CANDIDATE_DEPTH),
    JSON.stringify(vectorLimits));
}

{
  const aChunks = Array.from({ length: 8 }, (_, index) => ({
    chunk_uid: `a#${index}`, doc_uid: "a", source_id: "a", source: "drive",
    text: `Taylor background ${index}`, score: -10 + index,
  }));
  const bKeyword = {
    chunk_uid: "b#0", doc_uid: "b", source_id: "b", source: "message",
    text: "Taylor invoice keyword evidence", score: -1,
  };
  const bVector = { ...bKeyword, chunk_uid: "b#1", text: "Taylor semantic payment evidence" };
  const aVector = { ...aChunks[0], chunk_uid: "a#9", text: "Taylor semantic background" };
  const hydrated = new Map([[bVector.chunk_uid, bVector], [aVector.chunk_uid, aVector]]);
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [...aChunks, bKeyword]
              : ids.map((id) => hydrated.get(id)).filter(Boolean),
          }),
        }),
      }),
    },
    VECTORIZE: { query: async () => ({ matches: [{ id: "b#1" }, { id: "a#9" }] }) },
  };
  const result = await search(env, { query: "Taylor invoice", embedding: [0.1], limit: 5 });
  const b = result.results.find((row) => row.doc_uid === "b");
  const expected = 1 / 61 + 1 / 62;
  check("chunks collapse inside each modality before RRF rank positions are assigned",
    result.results.map((row) => row.doc_uid).join(",") === "b,a", JSON.stringify(result.results));
  check("different chunks from one document combine keyword and semantic evidence",
    b?.chunk_uid === "b#0" && b?.text.includes("Taylor invoice keyword evidence") &&
      b?.text.includes("Taylor semantic payment evidence") &&
      Math.abs(b.rrf_score - expected) < 1e-9,
    JSON.stringify(b));
  check("document fusion keeps both lexical and semantic evidence chunks",
    b?.text.includes("invoice keyword evidence") && b?.text.includes("semantic payment evidence"),
    JSON.stringify(b));
  check("the reusable collapse helper keeps the first ranked chunk per document",
    collapseRankedDocuments([...aChunks, bKeyword]).map((row) => row.doc_uid).join(",") === "a,b");
}

/* The mirror case matters too: a name/header keyword hit must not erase the
   semantically relevant passage, even when vector evidence carries far more
   ranking weight. */
{
  const keywordHeader = {
    chunk_uid: "mirror#header", doc_uid: "mirror", source_id: "mirror", source: "message",
    title: "Taylor client file", text: "Taylor client file contents and billing index.", score: -1,
  };
  const semanticFact = {
    ...keywordHeader, chunk_uid: "mirror#status",
    text: "Taylor confirmed the engagement remains active and work continues this month.",
  };
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [keywordHeader]
              : values.includes(semanticFact.chunk_uid) ? [semanticFact] : [],
          }),
        }),
      }),
    },
    VECTORIZE: { query: async () => ({ matches: [{ id: semanticFact.chunk_uid }] }) },
  };
  const result = await search(env, {
    query: "Taylor engagement", embedding: [0.1], limit: 5,
    weights: { keyword: 0.01, vector: 10 },
  });
  const evidence = result.results[0]?.text || "";
  check("a keyword header cannot erase a stronger semantic evidence chunk",
    evidence.includes("billing index") && evidence.includes("engagement remains active"),
    JSON.stringify(result.results[0]));
  check("composed document evidence remains inside the answer prompt window",
    evidence.length <= 900, String(evidence.length));
}

/* Each composed passage must keep the part that caused its own modality to
   match, even when that fact appears after the old head-only cutoff. */
{
  const preamble = "archive filler without a relevant fact ".repeat(16);
  const keywordFact = {
    chunk_uid: "late-keyword#fact", doc_uid: "late-keyword", source_id: "late-keyword", source: "message",
    title: "Taylor archive", text: `${preamble}Taylor invoice is overdue and needs review.`, score: -1,
  };
  const semanticSummary = {
    ...keywordFact, chunk_uid: "late-keyword#summary",
    text: "Taylor billing summary from the same document.",
  };
  const keywordEnv = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [keywordFact]
              : values.includes(semanticSummary.chunk_uid) ? [semanticSummary] : [],
          }),
        }),
      }),
    },
    VECTORIZE: { query: async () => ({ matches: [{ id: semanticSummary.chunk_uid }] }) },
  };
  const keywordResult = await search(keywordEnv, {
    query: "Taylor overdue invoice", embedding: [0.1], limit: 5,
  });
  const keywordEvidence = keywordResult.results[0]?.text || "";
  check("a late exact keyword fact survives bounded document composition",
    keywordFact.text.indexOf("invoice is overdue") > 451 &&
      keywordEvidence.includes("invoice is overdue") && keywordEvidence.length <= 900,
    JSON.stringify({ sourceIndex: keywordFact.text.indexOf("invoice is overdue"), keywordEvidence }));

  const keywordHeader = {
    chunk_uid: "late-semantic#header", doc_uid: "late-semantic", source_id: "late-semantic", source: "message",
    title: "Taylor relationship archive", text: "Taylor relationship archive index.", score: -1,
  };
  const semanticFact = {
    ...keywordHeader, chunk_uid: "late-semantic#fact",
    text: `${preamble}Taylor engagement continues through the current month.`,
  };
  const semanticEnv = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [keywordHeader]
              : values.includes(semanticFact.chunk_uid) ? [semanticFact] : [],
          }),
        }),
      }),
    },
    VECTORIZE: { query: async () => ({ matches: [{ id: semanticFact.chunk_uid }] }) },
  };
  const semanticResult = await search(semanticEnv, {
    query: "Taylor engagement continues", embedding: [0.1], limit: 5,
  });
  const semanticEvidence = semanticResult.results[0]?.text || "";
  check("a late semantic fact survives the mirror bounded composition path",
    semanticFact.text.indexOf("engagement continues") > 451 &&
      semanticEvidence.includes("engagement continues") && semanticEvidence.length <= 900,
    JSON.stringify({ sourceIndex: semanticFact.text.indexOf("engagement continues"), semanticEvidence }));
}

/* ---- explicit present intent adds a bounded, entity-anchored recency lane ---- */
{
  const day = (value) => Date.parse(`${value}T00:00:00Z`);
  const stale = {
    chunk_uid: "stale#0", doc_uid: "stale", source_id: "stale", source: "message",
    title: "Taylor account summary", text: "Taylor was listed as an active client.",
    document_date: day("2026-05-01"), date_reliable: 1, score: -10,
  };
  const distractors = Array.from({ length: 8 }, (_, index) => ({
    chunk_uid: `d${index}#0`, doc_uid: `d${index}`, source_id: `d${index}`, source: "drive",
    title: `Billing background ${index}`, text: `Generic billing background ${index}`,
    document_date: day(`2026-0${(index % 8) + 1}-01`), date_reliable: 1, score: -9 + index,
  }));
  const current = {
    chunk_uid: "current#0", doc_uid: "current", source_id: "current", source: "message",
    title: "Taylor conversation", text: "Taylor's August invoice payment returned insufficient funds.",
    document_date: day("2026-08-19"), date_reliable: 1, date_source: "message_timestamp", score: -0.5,
  };
  const unrelatedRecent = {
    chunk_uid: "other#0", doc_uid: "other", source_id: "other", source: "message",
    title: "Jordan conversation", text: "Jordan has the newest invoice.",
    document_date: day("2026-08-25"), date_reliable: 1, score: -0.4,
  };
  const unreliableFuture = {
    chunk_uid: "unreliable#0", doc_uid: "unreliable", source_id: "unreliable", source: "drive",
    title: "Taylor file touch", text: "Taylor billing file.",
    document_date: day("2026-08-26"), date_reliable: 0, score: -0.3,
  };
  const rows = [stale, ...distractors, current, unrelatedRecent, unreliableFuture];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
  };
  const currentQuery = "What is going on with billing with Taylor? Are they still a client?";
  const ranked = await search(env, { query: currentQuery, embedding: null, limit: rows.length });
  const currentRank = ranked.results.findIndex((row) => row.doc_uid === "current") + 1;
  const unrelated = ranked.results.find((row) => row.doc_uid === "other");
  const unreliable = ranked.results.find((row) => row.doc_uid === "unreliable");
  check("going-on/still intent promotes the newest reliable entity evidence into the top five",
    currentRank > 0 && currentRank <= 5, JSON.stringify(ranked.results.map((row) => row.doc_uid)));
  check("an unrelated newer document receives no recency contribution",
    Math.abs(unrelated.rrf_score - 1 / 71) < 1e-9, String(unrelated.rrf_score));
  check("an unreliable date receives no currentness credit",
    Math.abs(unreliable.rrf_score - 1 / 72) < 1e-9, String(unreliable.rrf_score));

  const historical = await search(env, {
    query: "Was Taylor still a client in May 2025?", embedding: null, limit: rows.length,
  });
  check("a historically anchored still-question does not activate current recency",
    historical.results.findIndex((row) => row.doc_uid === "current") + 1 === 10,
    JSON.stringify(historical.results.map((row) => row.doc_uid)));

  const unanchored = await search(env, {
    query: "What is the latest billing status?", embedding: null, limit: rows.length,
  });
  check("current intent without a named entity does not trigger a global date sort",
    unanchored.results.map((row) => row.doc_uid).join(",") === rows.map((row) => row.doc_uid).join(","),
    JSON.stringify(unanchored.results.map((row) => row.doc_uid)));
  check("the intent detector recognizes only the explicit current form",
    hasExplicitCurrentIntent(currentQuery) && !hasExplicitCurrentIntent("Was Taylor still a client in May 2025?"));
  check("proper names, not topic words, become entity anchors",
    JSON.stringify(queryEntityAnchors(currentQuery)) === JSON.stringify(["taylor"]),
    JSON.stringify(queryEntityAnchors(currentQuery)));

  const disabledKeyword = await search(env, {
    query: currentQuery, embedding: null, limit: rows.length, weights: { keyword: 0 },
  });
  check("a zero keyword modality cannot return evidence through the current-intent lane",
    disabledKeyword.results.length === 0, JSON.stringify(disabledKeyword.results));

  const firstFive = await search(env, { query: currentQuery, embedding: null, limit: 5 });
  const firstTen = await search(env, { query: currentQuery, embedding: null, limit: 10 });
  check("the ranked prefix is stable across public result limits",
    firstFive.results.map((row) => row.doc_uid).join(",") === firstTen.results.slice(0, 5).map((row) => row.doc_uid).join(","));
}

{
  check("explicit historical anchors suppress even strong latest/current language",
    !hasExplicitCurrentIntent("What was Taylor's latest status in May 2025?") &&
      !hasExplicitCurrentIntent("What was Taylor's current status during Q2 2024?") &&
      !hasExplicitCurrentIntent("What was Taylor's latest status before May 2025?") &&
      !hasExplicitCurrentIntent("What was Taylor's latest status through May 2025?") &&
      !hasExplicitCurrentIntent("What was Taylor's latest status by May 2025?") &&
      !hasExplicitCurrentIntent("What was Taylor's latest status prior to May 2025?") &&
      !hasExplicitCurrentIntent("What is the latest status before the end of 2025?") &&
      !hasExplicitCurrentIntent("What is the current status during Q2 of 2024?") &&
      !hasExplicitCurrentIntent("What is the latest status as at May 2025?"));
  check("lowercase names are recognized only in entity-shaped query grammar",
    JSON.stringify(queryEntityAnchors("what is going on with billing with casey?")) === JSON.stringify(["casey"]) &&
      JSON.stringify(queryEntityAnchors("what is the current status of casey?")) === JSON.stringify(["casey"]),
    JSON.stringify(queryEntityAnchors("what is the current status of casey?")));
  check("capitalized question filler cannot become an entity anchor",
    JSON.stringify(queryEntityAnchors("Please Tell Me What Is Going On With Taylor")) === JSON.stringify(["taylor"]) &&
      JSON.stringify(queryEntityAnchors("Please Give Me The Latest On Taylor")) === JSON.stringify(["taylor"]) &&
      JSON.stringify(queryEntityAnchors("Can You Check The Current Status On Taylor")) === JSON.stringify(["taylor"]),
    JSON.stringify(queryEntityAnchors("Please Give Me The Latest On Taylor")));
  check("lowercase context grammar tolerates articles and generic account nouns",
    JSON.stringify(queryEntityAnchors("what is the current status of the taylor account?")) === JSON.stringify(["taylor"]) &&
      JSON.stringify(queryEntityAnchors("what is the latest status for the acme health account?")) === JSON.stringify(["acme health"]),
    JSON.stringify(queryEntityAnchors("what is the latest status for the acme health account?")));
  const multiToken = queryEntityAnchors("What is current for Acme Health?");
  check("a multi-token entity remains one AND anchor rather than token OR matches",
    JSON.stringify(multiToken) === JSON.stringify(["acme health"]) &&
      matchesEntityAnchors({ title: "Acme billing" }, multiToken) === false &&
      matchesEntityAnchors({ title: "Health account" }, multiToken) === false &&
      matchesEntityAnchors({ title: "Acme Health account" }, multiToken) === true,
    JSON.stringify(multiToken));
  const ownerRows = [
    { title: "Casey Morgan account", text: "Casey Morgan remains active", date_reliable: 1, document_date: 2 },
    { title: "Jordan account", text: "Jordan remains active", date_reliable: 1, document_date: 3 },
  ];
  const ownerCurrent = currentEvidenceCandidates(
    "what is my current account status?", ownerRows, { owner: "Casey Morgan" },
  );
  check("owner pronouns activate recency only through the configured owner identity",
    ownerCurrent.length === 1 && ownerCurrent[0] === ownerRows[0] &&
      currentEvidenceCandidates("what is my current account status?", ownerRows).length === 0,
    JSON.stringify(ownerCurrent));

  const ownerAndNamedRows = [
    { title: "Casey Morgan account", text: "Casey Morgan remains active", date_reliable: 1, document_date: 4 },
    { title: "Taylor account", text: "Taylor remains active", date_reliable: 1, document_date: 3 },
  ];
  const ownerAndNamed = currentEvidenceCandidates(
    "what is my current relationship with Taylor?", ownerAndNamedRows, { owner: "Casey Morgan" },
  );
  check("an explicit named entity constrains rather than ORs with the owner pronoun anchor",
    ownerAndNamed.length === 1 && ownerAndNamed[0] === ownerAndNamedRows[1] &&
      JSON.stringify(queryEntityAnchors(
        "what is my current relationship with Taylor?", {}, { owner: "Casey Morgan" },
      )) === JSON.stringify(["taylor"]),
    JSON.stringify(ownerAndNamed));
}

{
  const vectorOnly = {
    chunk_uid: "vector-current#0", doc_uid: "vector-current", source_id: "vector-current",
    source: "message", title: "Taylor status", text: "Taylor engagement remains active",
    document_date: Date.parse("2026-08-19T00:00:00Z"), date_reliable: 1,
  };
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? []
              : values.includes(vectorOnly.chunk_uid) ? [vectorOnly] : [],
          }),
        }),
      }),
    },
    VECTORIZE: { query: async () => ({ matches: [{ id: vectorOnly.chunk_uid }] }) },
  };
  const disabledVector = await search(env, {
    query: "What is Taylor's current status?", embedding: [0.1], limit: 5,
    weights: { vector: 0, keyword: 0 },
  });
  check("a zero vector modality cannot return evidence through the current-intent lane",
    disabledVector.results.length === 0, JSON.stringify(disabledVector.results));
}

/* ---- the public source weights work on D1 rather than being inert ---- */
{
  const drive = { chunk_uid: "drive#0", doc_uid: "drive", source_id: "drive", source: "drive", text: "Acme", score: -2 };
  const message = { chunk_uid: "message#0", doc_uid: "message", source_id: "message", source: "message", text: "Acme", score: -1 };
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [drive, message] }) }) }) } };
  const weighted = await search(env, { query: "Acme", embedding: null, limit: 2, weights: { drive: 1, message: 5 } });
  check("D1 applies the requested per-source weight",
    weighted.results.map((row) => row.doc_uid).join(",") === "message,drive", JSON.stringify(weighted.results));
}

/* ---- a uniquely selective keyword hit remains visible in hybrid search ---- */
{
  const lexical = {
    chunk_uid: "lexical#0", doc_uid: "lexical", source_id: "lexical",
    text: "the exact rare marker", source: "drive", score: -8,
  };
  const distractors = Array.from({ length: 12 }, (_, i) => ({
    chunk_uid: `semantic-${i}#0`, doc_uid: `semantic-${i}`, source_id: `semantic-${i}`,
    text: `generic semantic result ${i}`, source: "drive", score: -0.0001,
  }));
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [lexical, ...distractors]
              : ids.map((id) => distractors.find((row) => row.chunk_uid === id)).filter(Boolean),
          }),
        }),
      }),
    },
    VECTORIZE: {
      query: async () => ({ matches: distractors.map((row) => ({ id: row.chunk_uid })) }),
    },
  };
  const r = await search(env, { query: "exact rare marker", embedding: [0.1], limit: 10 });
  const pure = fuseRRF([
    { items: distractors },
    { items: [lexical, ...distractors] },
  ]);
  const pureRank = pure.findIndex((row) => row.chunk_uid === lexical.chunk_uid) + 1;
  const lexicalRank = r.results.findIndex((row) => row.chunk_uid === lexical.chunk_uid) + 1;
  check("the fixture proves ordinary RRF buried the selective lexical champion",
    pureRank > 5, String(pureRank));
  check("a selective lexical champion cannot be buried below rank five", lexicalRank > 0 && lexicalRank <= 5, String(lexicalRank));
  check("the selective lexical list does not duplicate the document",
    r.results.filter((row) => row.chunk_uid === lexical.chunk_uid).length === 1,
    JSON.stringify(r.results));
  check("hybrid results remain ordered by their reported RRF score",
    r.results.every((row, index) => index === 0 || r.results[index - 1].rrf_score >= row.rrf_score),
    JSON.stringify(r.results.map((row) => row.rrf_score)));

  const weakKeyword = { ...lexical, score: -0.399 };
  const weakDistractors = distractors.map((row, index) => ({
    ...row,
    score: index === 0 ? -0.1 : row.score,
  }));
  const weakEnv = {
    ...env,
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [weakKeyword, ...weakDistractors]
              : ids.map((id) => weakDistractors.find((row) => row.chunk_uid === id)).filter(Boolean),
          }),
        }),
      }),
    },
  };
  const weak = await search(weakEnv, { query: "generic words", embedding: [0.1], limit: 10 });
  check("a 3.99x keyword leader cannot trigger the lexical boost",
    weak.results[0]?.chunk_uid === distractors[0].chunk_uid,
    JSON.stringify(weak.results));

  const exactBoundary = await search({
    ...weakEnv,
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? [{ ...weakKeyword, score: -0.4 }, ...weakDistractors]
              : ids.map((id) => weakDistractors.find((row) => row.chunk_uid === id)).filter(Boolean),
          }),
        }),
      }),
    },
  }, { query: "exact boundary", embedding: [0.1], limit: 10 });
  check("an observed 4x separation activates the bounded lexical boost",
    exactBoundary.results.findIndex((row) => row.chunk_uid === lexical.chunk_uid) + 1 === 5,
    JSON.stringify(exactBoundary.results));

  const sameDocumentOnly = [
    lexical,
    { ...lexical, chunk_uid: "lexical#1", score: -4 },
    { ...lexical, chunk_uid: "lexical#2", score: -2 },
  ];
  const noRunner = await search({
    ...env,
    DB: {
      prepare: (sql) => ({
        bind: (...ids) => ({
          all: async () => ({
            results: /FROM chunks_fts/.test(sql)
              ? sameDocumentOnly
              : ids.map((id) => distractors.find((row) => row.chunk_uid === id)).filter(Boolean),
          }),
        }),
      }),
    },
  }, { query: "one long document", embedding: [0.1], limit: 10 });
  const noRunnerChampion = noRunner.results.find((row) => row.chunk_uid === lexical.chunk_uid);
  check("a keyword pool monopolized by one document is not treated as selective evidence",
    Math.abs(noRunnerChampion.rrf_score - (1 / 61)) < 1e-9,
    String(noRunnerChampion.rrf_score));

  const tiny = await search(env, { query: "exact rare marker", embedding: [0.1], limit: 4 });
  check("the lexical safety lane does not rewrite result budgets below five",
    !tiny.results.some((row) => row.chunk_uid === lexical.chunk_uid),
    JSON.stringify(tiny.results));

  const disabled = await search(env, {
    query: "exact rare marker", embedding: [0.1], limit: 10, weights: { keyword: 0 },
  });
  check("zero keyword weight disables the lexical champion boost",
    !disabled.results.some((row) => row.chunk_uid === lexical.chunk_uid),
    JSON.stringify(disabled.results));
}

/* ---- exact copied documents collapse without erasing time or source context ---- */
{
  const same = [
    { chunk_uid: "a#0", doc_uid: "a", source_id: "a", source: "drive", document_date: 100, content_hash: "same", text: "copy one" },
    { chunk_uid: "b#0", doc_uid: "b", source_id: "b", source: "drive", document_date: 100, content_hash: "same", text: "copy two" },
    { chunk_uid: "c#0", doc_uid: "c", source_id: "c", source: "drive", document_date: 200, content_hash: "same", text: "later record" },
    { chunk_uid: "d#0", doc_uid: "d", source_id: "d", source: "curated", document_date: 100, content_hash: "same", text: "other connector" },
  ];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: same }) }) }) },
  };
  const r = await search(env, { query: "hello", embedding: null, limit: 10 });
  check("same-source same-date exact copies collapse to one result",
    r.results.filter((x) => x.source === "drive" && x.document_date === 100).length === 1,
    JSON.stringify(r.results));
  check("the same exact content remains distinct across dates and connectors",
    r.results.length === 3 && r.results.some((x) => x.document_date === 200) && r.results.some((x) => x.source === "curated"),
    JSON.stringify(r.results));
  check("the internal content hash never enters the search response",
    r.results.every((x) => !Object.hasOwn(x, "content_hash")), JSON.stringify(r.results));
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

/* ---- large chunk sets preserve recovery across our internal transaction slices ---- */
{
  const batches = [];
  const env = {
    DB: {
      prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }),
      batch: async (statements) => { batches.push(statements); return statements.map(() => ({})); },
    },
  };
  const chunks = Array.from({ length: 51 }, (_, index) => ({
    chunk_uid: `message:large#${index}`, doc_uid: "message:large", chunk_ix: index,
    text: `synthetic ${index}`, source: "message",
  }));
  const out = await upsertChunks(env, chunks, {
    expectedContentHash: `pending:${"a".repeat(64)}:${"b".repeat(32)}`,
  });
  check("a 51-chunk write is sliced into 100 and 2 statements",
    batches.map((batch) => batch.length).join(",") === "100,2", JSON.stringify(batches.map((batch) => batch.length)));
  check("large chunk writes stay inside the internal transaction slice",
    Math.max(...batches.map((batch) => batch.length)) <= 100);
  check("sliced chunk writes preserve exact queue accounting", out.written === 51 && out.queued === 51);
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

/* ---- bounded atomic staging saves calls without coupling documents ---- */
{
  const batches = [];
  const noOverride = Symbol("no override");
  const missingMeta = Symbol("missing meta");
  let requiredReceiptOverride = noOverride;
  let lastBatchResults = [];
  const env = {
    DB: {
      prepare: (sql) => ({ bind: (...args) => ({ _sql: sql, _args: args }) }),
      batch: async (statements) => {
        batches.push(statements);
        const triggerAmplifiedChanges = new Map([[0, 2], [3, 4], [4, 3]]);
        lastBatchResults = statements.map((_, index) => {
          if (index === 3 && requiredReceiptOverride !== noOverride) {
            return requiredReceiptOverride === missingMeta
              ? {}
              : { meta: { changes: requiredReceiptOverride } };
          }
          return { meta: { changes: triggerAmplifiedChanges.get(index) ?? 0 } };
        });
        return lastBatchResults;
      },
    },
  };
  const marker = `pending:${"c".repeat(64)}:${"d".repeat(32)}`;
  const chunk = {
    chunk_uid: "message:atomic#0", doc_uid: "message:atomic", chunk_ix: 0,
    text: "synthetic", source: "message", title: "Synthetic",
  };
  const staged = await stageDocumentRevision(env, {
    documentStatement: { _sql: "INSERT INTO documents", _args: [] },
    docUid: "message:atomic",
    chunks: [chunk],
    expectedContentHash: marker,
  });
  check("one-chunk atomic staging uses one five-statement D1 transaction",
    batches.length === 1 && batches[0].length === 5, JSON.stringify(batches.map((batch) => batch.length)));
  check("every derived atomic-stage write is marker guarded",
    batches[0].slice(1).every((statement) => statement._sql.includes("content_hash") && statement._args.includes(marker)),
    batches[0].slice(1).map((statement) => statement._sql).join("\n"));
  check("atomic chunks inherit the merged durable filter metadata",
    /documents\.client/.test(batches[0][3]._sql) && /documents\.platform/.test(batches[0][3]._sql), batches[0][3]._sql);
  check("atomic staging reports its exact durable and queued rows", staged.written === 1 && staged.queued === 1);
  check("trigger-amplified positive D1 change counts prove guarded revision ownership",
    [0, 3, 4].map((index) => lastBatchResults[index]?.meta?.changes).join(",") === "2,4,3");
  check("the atomic-stage bound accepts 48 chunks and refuses 49",
    canStageDocumentRevision(48) && !canStageDocumentRevision(49));

  const invalidReceipts = [
    ["zero", 0],
    ["missing", missingMeta],
    ["string", "2"],
    ["fractional", 1.5],
    ["negative", -1],
    ["non-finite", Infinity],
  ];
  for (const [label, receipt] of invalidReceipts) {
    requiredReceiptOverride = receipt;
    let failedClosed = false;
    try {
      await stageDocumentRevision(env, {
        documentStatement: { _sql: "INSERT INTO documents", _args: [] },
        docUid: `message:atomic-unverified-${label}`,
        chunks: [{
          ...chunk,
          chunk_uid: `message:atomic-unverified-${label}#0`,
          doc_uid: `message:atomic-unverified-${label}`,
        }],
        expectedContentHash: marker,
      });
    } catch (error) {
      failedClosed = error?.message === "atomic D1 staging could not verify revision ownership";
    }
    check(`a ${label} guarded-write receipt cannot receive success`, failedClosed);
  }
}

/* ---- source forget must stay below D1's 100-variable statement limit ---- */
{
  const docs = Array.from({ length: 205 }, (_, i) => ({ doc_uid: `drive:${i}` }));
  let maxBinds = 0;
  let maxStatements = 0;
  let vectorDeleteCalls = 0;
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
                  : /FROM vector_outbox/.test(sql)
                    ? args.map((id, index) => ({
                      chunk_uid: id,
                      vector_id: id,
                      generation: index + 1,
                    }))
                  : [],
            }),
            run: async () => ({}),
          };
        },
      }),
      batch: async (statements) => {
        maxStatements = Math.max(maxStatements, statements.length);
        if (statements.length > 100) throw new Error("internal transaction slice exceeded");
        for (const statement of statements) maxBinds = Math.max(maxBinds, statement?._args?.length || 0);
      },
    },
    VECTORIZE: { deleteByIds: async () => { vectorDeleteCalls++; } },
  };
  const removed = await forget(env, { source: "drive", dryRun: false });
  check("forget handles more than 100 documents",
    removed.documents === 205 && removed.vectors === 0 && removed.vector_cleanup_queued === 205,
    JSON.stringify(removed));
  check("forget leaves physical cleanup to the sole leased Vectorize writer", vectorDeleteCalls === 0, String(vectorDeleteCalls));
  check("forget never exceeds D1's bind ceiling", maxBinds <= 100, String(maxBinds));
  check("vector cleanup stays inside the conservative transaction slice", maxStatements <= 100, String(maxStatements));
}

console.log(fail ? `\n${fail} FAILURES` : `\nstore-d1: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
