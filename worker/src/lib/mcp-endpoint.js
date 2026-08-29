/**
 * mcp-endpoint — the brain as a remote MCP server, so it appears inside the
 * Claude apps and ChatGPT as a connector.
 *
 * Streamable-HTTP transport in its simplest legal form: every JSON-RPC
 * message arrives as a POST and gets a plain application/json reply
 * (the spec permits JSON responses instead of SSE, and both Anthropic and
 * OpenAI clients accept them). The server is stateless — every request is
 * authorized by its bearer token alone (oauth.js), so there is no session
 * header to leak or resume.
 *
 * Three tools, one privilege class:
 *   ask    — the full cited answer with its confidence line, exactly what
 *            `brain ask` prints. The tool most conversations want.
 *   search — ranked document references. Named and shaped for ChatGPT's
 *            deep-research contract (search returns {results:[{id,title,url}]}).
 *   fetch  — one document's text by id, the other half of that contract.
 *
 * All three reach only the read routes' internals. A connector can never
 * ingest, purge, or touch admin state, whatever its token.
 */

import { confidenceLine } from "./confidence.js";
// The same rule the owner's app obeys: a search that did not complete must
// never be reported as an absence. retrieval-status.js names an MCP server as
// a consumer that has to defend itself, and this is the remote one.
import { answerText, confidenceText, unavailableSearch } from "./answer-render.js";
// The same contract the local MCP server enforces. Two surfaces writing to one
// brain under two standards is how a record quietly becomes untrustworthy.
import { validateLesson, renderLesson } from "./remember-contract.js";

const PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_FETCH_CHARS = 60_000;

const rpcResult = (id, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
  headers: { "Content-Type": "application/json" },
});
const rpcError = (id, code, message, status = 200) => new Response(
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
  { status, headers: { "Content-Type": "application/json" } },
);

const TOOLS = [
  {
    name: "ask",
    description: "Ask the brain a question. Returns a cited answer with a confidence percentage and its sources. Use this for anything conversational.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "The question, in natural language." } },
      required: ["question"],
    },
  },
  {
    name: "search",
    description: "Search the brain's documents. Returns ranked references as {results:[{id,title,url}]}. Follow up with fetch to read one.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search terms." } },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: "Fetch one document's full text by the id a search result returned.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "A result id from search." } },
      required: ["id"],
    },
  },
];

/** Tools that change the brain. Offered only when the grant includes write. */
const WRITE_TOOLS = [
  {
    name: "remember",
    description:
      "Record something durable in the brain, or CORRECT something it has wrong. " +
      "Use this the moment the owner tells you the brain is mistaken: pass the id " +
      "being corrected as `supersedes` so the record keeps why it changed instead " +
      "of silently overwriting. State how you know in `verification` whenever you " +
      "claim `verified`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line stating the fact itself, not the topic." },
        body: { type: "string", description: "The fact with its conditions. At least 40 characters." },
        confidence: {
          type: "string", enum: ["verified", "inferred", "unverified"],
          description: "verified = you can say how you know. inferred = reasoned. unverified = reported.",
        },
        verification: { type: "string", description: "Required when confidence is verified. How you know." },
        supersedes: { type: "string", description: "The id this corrects, e.g. lesson/old-slug." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "body", "confidence"],
    },
  },
  {
    name: "forget",
    description:
      "Remove documents from the brain. PREVIEWS by default and returns what would " +
      "go; pass confirm true only after the owner has seen that list and agreed.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Document ids, as search returns them." },
        confirm: { type: "boolean", description: "Omit to preview. True only with the owner's explicit agreement." },
      },
      required: ["ids"],
    },
  },
];

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

function toolError(message) {
  return { content: [{ type: "text", text: String(message) }], isError: true };
}

/** The id scheme pairs search and fetch: "<source>:<source_id>". */
function resultId(result) {
  return `${result.source || "doc"}:${result.ref_key || result.source_id || ""}`;
}

async function runAsk(deps, args) {
  const question = String(args?.question || "").trim();
  if (!question) return toolError("a question is required");
  const thought = await deps.think({ q: question, limit: 12 });
  if (thought.answer === null && thought.answer_error) {
    return toolError(`the brain could not answer: ${thought.answer_error}`);
  }
  // An incomplete search reaching a client's phone as "the documents do not
  // answer the question" is the worst error this product can make: a confident
  // absence claim about their own records. It is likeliest on install day,
  // while the index is still projecting and they are asking their first
  // questions from the Claude app.
  if (unavailableSearch(thought)) {
    return text([answerText(thought), "", confidenceText(thought)].join("\n"));
  }
  const lines = [answerText(thought)];
  const trust = confidenceLine(thought.confidence, {
    refused: /^The documents do not answer/i.test(thought.answer || ""),
  });
  if (trust) lines.push("", trust);
  const citations = Array.isArray(thought.citations) ? thought.citations : [];
  if (citations.length) {
    lines.push("", "Sources:");
    for (const citation of citations) {
      lines.push(`[${citation.n}] ${citation.title}${citation.ts ? ` · ${String(citation.ts).slice(0, 10)}` : ""}`);
    }
  }
  return text(lines.join("\n"));
}

async function runSearch(deps, args, origin) {
  const query = String(args?.query || "").trim();
  if (!query) return toolError("a query is required");
  const found = await deps.search({ q: query, limit: 10 });
  // An empty result list is indistinguishable from "your corpus has nothing"
  // to the model reading it, so an incomplete search has to say so in band
  // rather than return a bare empty array.
  if (unavailableSearch(found)) {
    return text(JSON.stringify({ results: [], note: answerText(found) }));
  }
  const results = (found.results || []).map((r) => ({
    id: resultId(r),
    title: r.title || "untitled",
    url: `${origin}/app`,
  }));
  return text(JSON.stringify({ results }));
}

async function runFetch(env, args, origin) {
  const id = String(args?.id || "");
  const separator = id.indexOf(":");
  if (separator < 1) return toolError("id must look like source:source_id, as returned by search");
  const docUid = id;
  let doc;
  let chunks;
  try {
    doc = await env.DB.prepare(
      "SELECT title, uri FROM documents WHERE doc_uid = ?",
    ).bind(docUid).first();
    chunks = await env.DB.prepare(
      "SELECT text FROM chunks WHERE doc_uid = ? ORDER BY chunk_ix",
    ).bind(docUid).all();
  } catch (error) {
    return toolError(`fetch failed: ${String(error?.message || error).slice(0, 120)}`);
  }
  const rows = chunks?.results || [];
  if (!doc && !rows.length) return toolError("no document with that id");
  // Chunks overlap by design; joined text repeats a little at the seams.
  // Complete and slightly redundant beats trimmed and possibly wrong.
  let body = rows.map((row) => row.text).join("\n\n");
  if (body.length > MAX_FETCH_CHARS) body = `${body.slice(0, MAX_FETCH_CHARS)}\n\n[truncated]`;
  return text(JSON.stringify({
    id,
    title: doc?.title || "untitled",
    text: body,
    url: doc?.uri || `${origin}/app`,
    metadata: { chunks: rows.length },
  }));
}

async function runRemember(deps, args) {
  const checked = validateLesson(args);
  if (!checked.ok) {
    // Return the refusals as guidance rather than a bare error: the model can
    // usually satisfy them on a second try, and the contract exists to make
    // the record better rather than to make writing hard.
    return toolError(`this cannot be recorded yet:\n- ${checked.errors.join("\n- ")}`);
  }
  const v = checked.value;
  const result = await deps.write({
    source_type: "curated",
    source_id: v.source_id,
    title: v.title,
    content: renderLesson(v),
    // Provenance: everything written through a connector says so, so a later
    // answer can show where a claim came from and the owner can review a run
    // of them rather than finding them mixed into their own material.
    metadata: {
      category: "lesson",
      written_by: "connector",
      confidence: v.confidence,
      ...(v.supersedes ? { supersedes: v.supersedes } : {}),
      ...(v.tags.length ? { tags: v.tags } : {}),
    },
  });
  if (result?.error) return toolError(`the brain refused this: ${result.error}`);
  const lines = [`Recorded as ${v.source_id}.`];
  if (v.supersedes) lines.push(`It supersedes ${v.supersedes}, which stays readable as history.`);
  // Surface a downgrade rather than hiding it: the owner should know the brain
  // recorded something weaker than was claimed.
  for (const warning of checked.warnings) lines.push(`Note: ${warning}`);
  return text(lines.join("\n"));
}

async function runForget(deps, args) {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return toolError("ids is required: pass the document ids you mean to remove");
  const confirm = args?.confirm === true;
  const result = await deps.forget({ docUids: ids, confirm });
  const count = result?.documents ?? result?.removed ?? ids.length;
  if (!confirm) {
    return text(
      `Nothing has been removed. This WOULD remove ${count} document(s):\n` +
      ids.map((i) => `- ${i}`).join("\n") +
      "\n\nShow this list to the owner and call forget again with confirm true " +
      "only if they agree.");
  }
  return text(`Removed ${count} document(s).`);
}

/**
 * Handle one MCP request. `deps.think` and `deps.search` are injected by the
 * router so this module never imports the route handlers (no cycle) and a
 * test can drive it with fakes or the real thing alike.
 */
export async function handleMcp(env, request, url, deps) {
  if (request.method !== "POST") {
    return rpcError(null, -32600, "POST JSON-RPC messages to this endpoint", 405);
  }
  let message;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "request body was not JSON", 400);
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, "batched JSON-RPC is not supported; send one message per request", 400);
  }
  const { id, method, params } = message || {};

  if (method === "initialize") {
    const requested = String(params?.protocolVersion || "");
    return rpcResult(id, {
      protocolVersion: PROTOCOLS.has(requested) ? requested : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: env.BRAIN_NAME || "brain", version: env.BRAIN_VERSION || "0.0.0" },
      instructions:
        "This is the owner's private brain. ask returns cited answers with a confidence percentage; " +
        "search and fetch read the underlying documents. Everything is read-only.",
    });
  }
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    // A read-only grant is never shown the write tools. Advertising a tool the
    // token cannot use teaches the model to try and fail in front of the owner.
    return rpcResult(id, { tools: deps.grant?.canWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS });
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    const args = params?.arguments || {};
    try {
      if (name === "ask") return rpcResult(id, await runAsk(deps, args));
      if (name === "search") return rpcResult(id, await runSearch(deps, args, url.origin));
      if (name === "fetch") return rpcResult(id, await runFetch(env, args, url.origin));
      if (name === "remember" || name === "forget") {
        if (!deps.grant?.canWrite) {
          return rpcResult(id, toolError(
            `this connection can only read. Reconnect and approve write access to use ${name}.`));
        }
        if (name === "remember") return rpcResult(id, await runRemember(deps, args));
        return rpcResult(id, await runForget(deps, args));
      }
    } catch (error) {
      return rpcResult(id, toolError(String(error?.message || error).slice(0, 200)));
    }
    return rpcError(id, -32602, `unknown tool "${name}"`);
  }
  return rpcError(id, -32601, `unknown method "${method}"`);
}
