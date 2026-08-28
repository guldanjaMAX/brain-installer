/**
 * Zero results plus a degraded index must never instruct anyone to state an
 * absence.
 *
 * The failure this pins was field-observed on a fresh install: 61 documents and
 * 1,001 chunks in the store, every query returning zero rows with
 * degraded="vector" while the index projected, and /think answering with a gap
 * that read "The brain has nothing on this query. Say so plainly rather than
 * inferring." A consumer that followed that instruction told the owner they had
 * nothing on file about their own records. Honest in form, false in fact, and
 * indistinguishable from a correct answer.
 *
 * Three properties are pinned here, and the third is what makes the first two
 * worth anything:
 *
 *   (a) empty + degraded emits no absence instruction, and names the cause.
 *   (b) empty + healthy still emits the ordinary refusal, byte for byte. The
 *       honest "nothing recorded" answer is the product working, and a fix that
 *       softened it would have traded one dishonesty for another.
 *   (c) the MCP surface — the place the client actually asks — carries the
 *       signal through, proven against a real spawned server, not a stub.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "../src/index.js";
import {
  NO_RESULTS_GAP, SEARCH_UNAVAILABLE, degradedCause, emptyRetrievalDisclosure,
  retrievalUnavailable, unavailableNotice,
} from "../src/lib/retrieval-status.js";
import { search } from "../src/lib/store-d1.js";
import { looksLikeRefusal } from "../../eval/scorer.mjs";
import { cmdAsk } from "../../brain.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + d)); if (!c) fail++; };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/* The exact sentence the honest no-match path is contracted to emit. Spelled
   out rather than imported so a change to the constant cannot quietly rewrite
   what this test claims to be checking. */
const HONEST_REFUSAL_DETAIL =
  "The brain has nothing on this query. Say so plainly rather than inferring.";

/* Phrasings that assert the corpus is empty. An unavailable-search response
   ASSERTING any of these is the bug. */
const ABSENCE_CLAIM =
  /has nothing on|nothing recorded|no record|not recorded|nothing matched|say so plainly rather than inferring/i;

/* A prohibition against the claim is the fix, and it necessarily quotes the
   claim it forbids. Matching the phrase alone would therefore fail the very
   text that closes the defect, so the scan is per sentence and skips any
   sentence that negates. */
const PROHIBITION = /\b(do not|don't|never|rather than|instead of)\b|nothing here means/i;

function assertsAbsence(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => ABSENCE_CLAIM.test(sentence) && !PROHIBITION.test(sentence));
}

/* Everything in a response that a model or a human actually reads as prose. */
const proseOf = (obj) => [
  obj?.note, obj?.notice, obj?.answer,
  ...(Array.isArray(obj?.gaps) ? obj.gaps.map((g) => g?.detail) : []),
].filter((v) => typeof v === "string").join("\n");

/* The helper has to discriminate, or every check built on it is theatre. */
{
  check("SELF-CHECK: the scanner catches a bare absence claim",
    assertsAbsence("The brain has nothing on this query. Say so plainly rather than inferring.") === true);
  check("SELF-CHECK: and does not fire on a prohibition against it",
    assertsAbsence("Do NOT say or imply that the brain has nothing on this question.") === false);
}

/* ------------------------------------------------------------------ */
/* a worker env whose vector projection is not finished                */
/* ------------------------------------------------------------------ */

function mkEnv({ rows = [], vectorIds = [], projectionReady = true, embeds = true } = {}) {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => ({ results: rows }),
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 12,
                // A submitted mutation the index has not processed yet is the
                // ordinary state of a brain in the hours after install.
                mutation_id: projectionReady ? null : "mutation-in-flight",
                mutation_submitted_at: null,
                projection_status: projectionReady ? "verified" : "pending",
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
              return { n: 0, oldest: null, upserts: 0, deletes: 0, submitted: 0 };
            }
            return /count\(\*\)/i.test(sql)
              ? { n: 0, stored_documents: 0, logical_documents: 0 }
              : null;
          },
          run: async () => ({}),
        };
      },
      batch: async () => {},
    },
    VECTORIZE: {
      query: async () => ({ matches: vectorIds.map((id) => ({ id })) }),
      upsert: async () => {},
      describe: async () => ({ vectorCount: vectorIds.length, processedUpToMutation: null }),
    },
    AI: {
      run: async (model) => (model.includes("bge-")
        ? (embeds ? { data: [[0.1, 0.2, 0.3]] } : (() => { throw new Error("embedder down"); })())
        : { response: "unused", usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    },
  };
}

const think = async (env, q = "what do my records say") => {
  const res = await worker.fetch(new Request("https://b.example/api/rag/think", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q, limit: 8 }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  return { res, body: await res.json() };
};

const unified = async (env, q = "the") => {
  const res = await worker.fetch(new Request("https://b.example/api/rag/unified", {
    method: "POST",
    headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
    body: JSON.stringify({ q, limit: 8, rerank: 0 }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  return { res, body: await res.json() };
};

/* ---- the store still separates the two cases, and now says which fault ---- */
{
  const env = mkEnv({ projectionReady: false });
  const r = await search(env, { query: "records", embedding: [0.1], limit: 5 });
  check("a still-building projection is degraded even with zero rows on both sides",
    r.results.length === 0 && r.degraded === "vector", JSON.stringify({ n: r.results.length, d: r.degraded }));
  check("and it says WHICH degradation, so the sentence downstream can name it",
    r.degraded_reason === "projection-incomplete", String(r.degraded_reason));

  const healthy = await search(mkEnv({}), { query: "records", embedding: [0.1], limit: 5 });
  check("a healthy empty corpus is still not degraded",
    healthy.results.length === 0 && healthy.degraded === null && healthy.degraded_reason === null,
    JSON.stringify({ d: healthy.degraded, r: healthy.degraded_reason }));
}

/* ---- (a) empty + degraded: no absence instruction, cause named ---- */
{
  const { res, body } = await think(mkEnv({ projectionReady: false }));
  check("the route still answers 200", res.status === 200, String(res.status));
  check("it reports a distinct unavailable status, not a result",
    body.status === SEARCH_UNAVAILABLE, JSON.stringify(body.status));
  check("degraded is still on the wire", body.degraded === "vector", String(body.degraded));

  const gapTypes = (body.gaps || []).map((g) => g.type);
  check("no no_results gap survives", !gapTypes.includes("no_results"), JSON.stringify(gapTypes));
  check("the gap is typed as an unavailable search",
    gapTypes.includes(SEARCH_UNAVAILABLE), JSON.stringify(gapTypes));

  const gapText = (body.gaps || []).map((g) => g.detail).join(" ");
  check("THE DEFECT: the gap must not instruct anyone to state an absence",
    !assertsAbsence(gapText), gapText);
  check("the gap says the search could not be completed",
    /could not be completed/i.test(gapText), gapText);
  check("the gap names the cause: the index is still building",
    /still building/i.test(gapText), gapText);
  check("the gap explicitly forbids concluding the brain has nothing",
    /Do NOT say or imply that the brain has nothing/.test(gapText), gapText);
  check("and forbids answering from the model's own knowledge instead",
    /do not answer from your own knowledge/i.test(gapText), gapText);

  check("a human-readable notice rides along", typeof body.notice === "string" && body.notice.length > 40,
    String(body.notice));
  check("the notice does not assert an absence either",
    !assertsAbsence(body.notice), String(body.notice));
  check("the notice does not read as a refusal to the eval scorer",
    !looksLikeRefusal(body.notice), String(body.notice));
  check("the notice tells the owner what to do next",
    /brain drain/.test(body.notice), String(body.notice));

  check("no refusal confidence is published for a search that never ran",
    body.confidence === undefined, JSON.stringify(body.confidence));
  check("no answer is fabricated", body.answer === null && (body.citations || []).length === 0,
    JSON.stringify({ a: body.answer, c: body.citations }));
}

/* ---- the same protection when the embedder, not the index, is the fault ---- */
{
  const { body } = await think(mkEnv({ embeds: false }));
  check("a dead embedder also produces an unavailable search, not an absence",
    body.status === SEARCH_UNAVAILABLE && body.degraded === "no-embedding",
    JSON.stringify({ s: body.status, d: body.degraded }));
  check("its gap names ITS cause, not the vector index",
    /embedding model did not answer/i.test((body.gaps || []).map((g) => g.detail).join(" ")),
    JSON.stringify(body.gaps));
}

/* ---- (b) empty + healthy: the honest refusal, unchanged ---- */
{
  const { res, body } = await think(mkEnv({}));
  check("a healthy empty search still returns 200", res.status === 200, String(res.status));
  check("REGRESSION GUARD: the honest no_results gap is untouched",
    body.gaps.length === 1 && body.gaps[0].type === "no_results" &&
      body.gaps[0].detail === HONEST_REFUSAL_DETAIL,
    JSON.stringify(body.gaps));
  check("no unavailable status is invented for a search that completed",
    body.status === undefined && body.notice === undefined,
    JSON.stringify({ s: body.status, n: body.notice }));
  check("degraded is absent", body.degraded === undefined, String(body.degraded));
  check("and the refusal confidence is still published",
    body.confidence && body.confidence.percent >= 80, JSON.stringify(body.confidence));
  check("the honest path is not treated as unavailable by clients",
    retrievalUnavailable(body) === false, JSON.stringify(body));
}

/* ---- /unified carries the same distinction on its own shape ---- */
{
  const { body: broken } = await unified(mkEnv({ projectionReady: false }));
  check("unified marks a zero-row degraded search unavailable",
    broken.results.length === 0 && broken.status === SEARCH_UNAVAILABLE, JSON.stringify(broken).slice(0, 200));
  check("unified's notice does not assert an absence",
    typeof broken.notice === "string" && !assertsAbsence(broken.notice), String(broken.notice));

  const { body: healthy } = await unified(mkEnv({}));
  check("a healthy zero-row unified response gains no status",
    healthy.results.length === 0 && healthy.status === undefined && healthy.notice === undefined,
    JSON.stringify(healthy).slice(0, 200));
}

/* ---- the shared rule, including the version-skew defence ---- */
{
  const healthy = emptyRetrievalDisclosure(null);
  check("the disclosure for a healthy empty search is exactly the old gap",
    healthy.unavailable === false && healthy.gaps.length === 1 &&
      healthy.gaps[0].detail === NO_RESULTS_GAP.detail, JSON.stringify(healthy));

  check("an unrecognised degradation still refuses to mean absence",
    emptyRetrievalDisclosure("something-new-in-2027").unavailable === true &&
      !assertsAbsence(unavailableNotice("something-new-in-2027")),
    unavailableNotice("something-new-in-2027"));
  check("and its cause names the unknown subsystem rather than guessing",
    /reported "something-new-in-2027"/.test(degradedCause("something-new-in-2027")),
    String(degradedCause("something-new-in-2027")));

  // A client can be newer than the worker it talks to. A pre-fix worker sends
  // `degraded` and the old gap; the client must still refuse to state absence.
  check("VERSION SKEW: an old worker's body is still recognised as unavailable",
    retrievalUnavailable({ degraded: "vector", answer: null, citations: [], results: [],
      gaps: [NO_RESULTS_GAP] }) === true);
  check("a degraded response that DID return evidence is not unavailable",
    retrievalUnavailable({ degraded: "vector", answer: null, citations: [], results: [{ title: "x" }] }) === false);
  check("an answered degraded response is not unavailable",
    retrievalUnavailable({ degraded: "vector", answer: "Something [1].", citations: [{ n: 1 }], results: [] }) === false);
  check("a malformed body is not unavailable", retrievalUnavailable(null) === false);
}

/* ---- the CLI, the fourth consumer of this path ---- */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-degraded-ask-"));
  try {
    const manifest = join(sandbox, "brain.manifest.json");
    writeFileSync(manifest, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.example", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "not-needed-with-a-domain" } },
    }));
    const printed = [];
    const realLog = console.log;
    console.log = (...a) => printed.push(a.join(" "));
    try {
      await cmdAsk(manifest, {
        ask: async () => "What do my records say?",
        adminKey: `fixture-${"k".repeat(40)}`,
        http: async () => new Response(JSON.stringify({
          mode: "think", degraded: "vector", status: SEARCH_UNAVAILABLE,
          notice: unavailableNotice("vector"),
          answer: null, citations: [], results: [],
          gaps: [{ type: SEARCH_UNAVAILABLE, detail: "x" }],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });
    } finally { console.log = realLog; }
    const out = printed.join("\n");
    check("CLI: an unavailable search does not print the refusal sentence",
      !/The documents do not answer the question/.test(out), out);
    check("CLI: it prints the notice instead", /could not be completed/i.test(out), out);
    check("CLI: it does not print a confidence-in-absence line",
      !/Confidence nothing is recorded/.test(out), out);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* (c) the MCP surface — spawned for real, against a stub brain        */
/* ------------------------------------------------------------------ */

async function mcpCall(responder, toolCalls) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = responder(req.url, raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = spawn(process.execPath, [join(ROOT, "components", "brain-mcp.mjs")], {
    env: {
      ...process.env,
      BRAIN_URL: `http://127.0.0.1:${port}`,
      BRAIN_KEY: `fixture-${"k".repeat(40)}`,
      BRAIN_NAME: "fixture",
      BRAIN_MANIFEST: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
  }) + "\n");
  toolCalls.forEach((tc, i) => {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: i + 2, method: "tools/call", params: tc,
    }) + "\n");
  });
  child.stdin.end();

  await new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => server.close(resolve));
  return lines;
}

const EMPTY_DEGRADED_THINK = {
  mode: "think", degraded: "vector", status: SEARCH_UNAVAILABLE,
  notice: unavailableNotice("vector"),
  answer: null, citations: [], results: [],
  gaps: [{ type: SEARCH_UNAVAILABLE, detail: "the search could not be completed" }],
};

{
  const lines = await mcpCall(
    (url) => (url.includes("/think")
      ? EMPTY_DEGRADED_THINK
      : { mode: "unified", degraded: "vector", status: SEARCH_UNAVAILABLE,
        notice: unavailableNotice("vector"), results: [] }),
    [
      { name: "brain_think", arguments: { q: "what do my records say" } },
      { name: "brain_search", arguments: { q: "records" } },
    ],
  );

  const init = lines.find((l) => l.id === 1);
  check("MCP: the server instructions name the degraded exception",
    /search_unavailable/.test(init?.result?.instructions || "") &&
      /the search did not complete/i.test(init?.result?.instructions || ""),
    String(init?.result?.instructions || "").slice(0, 200));

  const thought = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  check("MCP brain_think: degraded reaches the client's model",
    thought.degraded === "vector", JSON.stringify(thought).slice(0, 200));
  check("MCP brain_think: search_status is carried",
    thought.search_status === "search_unavailable", JSON.stringify(thought.search_status));
  check("THE DEFECT AT THE MCP LAYER: no absence instruction in the note",
    typeof thought.note === "string" && !assertsAbsence(thought.note), String(thought.note));
  check("MCP brain_think: the note tells the model what actually happened",
    /could not be completed/i.test(thought.note), String(thought.note));

  const searched = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  check("MCP brain_search: degraded reaches the client's model",
    searched.degraded === "vector" && searched.search_status === "search_unavailable",
    JSON.stringify(searched).slice(0, 200));
  check("MCP brain_search: zero hits during a degraded search is not 'nothing recorded'",
    typeof searched.note === "string" && !assertsAbsence(searched.note), String(searched.note));
}

/* An MCP pointed at a worker that predates this fix: `degraded` but the old
   gap and no status. The client must still not relay an absence. */
{
  const lines = await mcpCall(
    (url) => (url.includes("/think")
      ? { mode: "think", degraded: "vector", answer: null, citations: [], results: [],
        gaps: [NO_RESULTS_GAP] }
      : { mode: "unified", degraded: "vector", results: [] }),
    [
      { name: "brain_think", arguments: { q: "what do my records say" } },
      { name: "brain_search", arguments: { q: "records" } },
    ],
  );
  const thought = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  check("VERSION SKEW at the MCP: an old worker's no_results gap is replaced, not relayed",
    !thought.gaps.some((g) => g.type === "no_results") &&
      thought.gaps.some((g) => g.type === SEARCH_UNAVAILABLE), JSON.stringify(thought.gaps));
  check("VERSION SKEW at the MCP: and no absence instruction reaches the model",
    !assertsAbsence(proseOf(thought)), proseOf(thought));

  const searched = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  check("VERSION SKEW at the MCP: brain_search is protected the same way",
    !assertsAbsence(proseOf(searched)), proseOf(searched));
}

/* MCP against a HEALTHY brain: the honest refusal must survive intact. */
{
  const lines = await mcpCall(
    (url) => (url.includes("/think")
      ? { mode: "think", answer: null, citations: [], results: [], gaps: [NO_RESULTS_GAP],
        confidence: { percent: 80, band: "high", basis: ["retrieval found no candidates at all"] } }
      : { mode: "unified", results: [] }),
    [
      { name: "brain_think", arguments: { q: "a question about nothing" } },
      { name: "brain_search", arguments: { q: "nothing" } },
    ],
  );
  const thought = JSON.parse(lines.find((l) => l.id === 2).result.content[0].text);
  check("REGRESSION GUARD at the MCP: a healthy empty answer still says nothing is recorded",
    /The brain has nothing on this\./.test(thought.note) &&
      thought.gaps.some((g) => g.type === "no_results"), JSON.stringify(thought));
  check("REGRESSION GUARD at the MCP: no degraded or status is invented",
    thought.degraded === undefined && thought.search_status === undefined, JSON.stringify(thought));

  const searched = JSON.parse(lines.find((l) => l.id === 3).result.content[0].text);
  check("REGRESSION GUARD at the MCP: healthy brain_search keeps its honest note",
    /nothing recorded on this/.test(searched.note), String(searched.note));
}

/* ---- the /app page renders the notice, not the refusal ---- */
/* These call the REAL shipped functions, which is the point: an earlier
   version grepped the source for a pattern and would have passed with the
   branch disabled by `false &&`.

   They used to be lifted out of the served HTML by sentinel comments, because
   the page was hand-written JavaScript inside a template string. The app is now
   a built bundle, so there is no page to lift them from; they live in
   answer-render.js, which the Worker page and the React app both import. The
   assertions below are unchanged, and the mechanism is stricter than before:
   this imports the module the product actually runs rather than re-evaluating
   a copy of it. */
{
  const render = await import("../src/lib/answer-render.js");
  check("/app exposes its render contract to this test",
    typeof render.answerText === "function" && typeof render.confidenceText === "function" &&
      typeof render.unavailableSearch === "function",
    "answer-render.js must export the three render functions");

  const degradedBody = {
    status: SEARCH_UNAVAILABLE, degraded: "vector", notice: unavailableNotice("vector"),
    answer: null, citations: [], results: [],
    // A current worker omits this. An older one sends it, and rendering it
    // would put a percentage on an absence nobody measured, so the page has to
    // suppress it rather than trust the field's presence.
    confidence: { percent: 58, band: "moderate", basis: ["vector index not fully query-ready"] },
  };
  check("/app: a degraded empty result does NOT render the refusal sentence",
    !/The documents do not answer the question/.test(render.answerText(degradedBody)),
    render.answerText(degradedBody));
  check("/app: it renders the notice instead",
    /could not be completed/i.test(render.answerText(degradedBody)), render.answerText(degradedBody));
  check("/app: and asserts no absence",
    !assertsAbsence(render.answerText(degradedBody)), render.answerText(degradedBody));
  check("/app: the confidence line does not claim confidence in an absence",
    !/Confidence nothing is recorded/.test(render.confidenceText(degradedBody)),
    render.confidenceText(degradedBody));

  // Version skew again: a page cached from a newer worker, talking to an older
  // one that sends `degraded` but no status or notice.
  const oldWorkerBody = { degraded: "vector", answer: null, citations: [], results: [] };
  check("/app: an older worker's degraded empty body still avoids the refusal sentence",
    !/The documents do not answer the question/.test(render.answerText(oldWorkerBody)),
    render.answerText(oldWorkerBody));

  const healthyEmpty = {
    answer: null, citations: [], results: [],
    confidence: { percent: 80, band: "high", basis: ["retrieval found no candidates at all"] },
  };
  check("REGRESSION GUARD at /app: a healthy empty result still shows the refusal",
    render.answerText(healthyEmpty) === "The documents do not answer the question.",
    render.answerText(healthyEmpty));
  check("REGRESSION GUARD at /app: and still labels its confidence as absence confidence",
    /^Confidence nothing is recorded: 80%/.test(render.confidenceText(healthyEmpty)),
    render.confidenceText(healthyEmpty));

  const answered = {
    answer: "The retainer was deferred [1].", citations: [{ n: 1 }], results: [{ title: "x" }],
    confidence: { percent: 75, band: "moderate", basis: ["evidence gate approved 1 citation"] },
  };
  check("REGRESSION GUARD at /app: a real answer is untouched",
    render.answerText(answered) === answered.answer &&
      /^Confidence: 75%/.test(render.confidenceText(answered)),
    render.confidenceText(answered));
}

console.log(`\ndegraded absence: ${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
