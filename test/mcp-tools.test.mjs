// WHAT THIS FILE COVERS: the BEHAVIOUR of the brain-mcp tool surface, driven
// the way a host actually drives it — a real `node components/brain-mcp.mjs`
// child process, newline-delimited JSON-RPC over its stdin and stdout, and a
// loopback HTTP server standing in for the client's Worker.
//
// Why a child process rather than importing runTool: brain-mcp.mjs is a
// program, not a module. It reads configuration at import time, writes protocol
// frames to stdout, and exits on stdin end. Calling its functions directly
// would prove that the functions work and nothing about whether the server a
// host talks to works. `test/mcp-rotation.test.mjs` covers registration and
// credential rotation and never touches dispatch; before this file there was no
// behavioural coverage of the tools themselves at all.
//
// Loopback HTTP is a real transport here, not a stub: components/brain-http.mjs
// permits http:// only for loopback, which is exactly the escape hatch this
// harness uses. Redirects, origin equality and credential redaction all run.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "components", "brain-mcp.mjs");
const FIXTURE_KEY = `fixture-key-${"z".repeat(40)}`;
const sandboxHome = mkdtempSync(join(tmpdir(), "brain-mcp-tools-"));

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
};

/* ---------------------------------------------------------------- brain */

/**
 * A loopback stand-in for the client's Worker.
 *
 * `routes` maps "METHOD /path" to a function of the parsed request, returning
 * `{ status, body }`. An unrouted path is a 404 the test will notice, rather
 * than a silent default that lets a tool pass while calling the wrong endpoint.
 */
async function startBrain(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
      requests.push({
        method: req.method,
        path,
        adminKey: req.headers["x-admin-key"] ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        body: parsed,
      });
      const handler = routes[`${req.method} ${path}`];
      const out = handler
        ? handler(parsed, requests.filter((r) => r.path === path).length)
        : { status: 404, body: { error: `no fixture route for ${req.method} ${path}` } };
      const payload = typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? {});
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ------------------------------------------------------------- the host */

const windowsRuntimeBasics = process.platform === "win32"
  ? {
    SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ComSpec: process.env.ComSpec,
  }
  : {};

/**
 * Speak MCP to the real server over stdio and collect the replies.
 *
 * The environment is deliberately narrow, and HOME/USERPROFILE point at an
 * empty sandbox: brain-mcp falls back to ~/.brain/config.json, and a developer
 * machine that happens to have one must not be able to change a test result.
 */
async function speak(brainUrl, calls, { key = FIXTURE_KEY } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...windowsRuntimeBasics,
      PATH: process.env.PATH,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      BRAIN_CONFIG: join(sandboxHome, "absent-config.json"),
      BRAIN_URL: brainUrl,
      BRAIN_NAME: "fixture-brain",
      BRAIN_KEY: key,
    },
  });

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });

  const frames = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    ...calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, ...call })),
  ];
  child.stdin.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  child.stdin.end();

  const code = await new Promise((r) => child.on("close", r));
  const replies = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    replies.set(msg.id, msg);
  }
  return { code, stderr: err, replies, raw: out };
}

/** Decode one tools/call reply into the JSON object the tool returned. */
function toolResult(reply) {
  assert.ok(reply, "expected a reply frame");
  const text = reply.result?.content?.[0]?.text ?? "";
  assert.ok(!reply.result?.isError, `tool errored: ${text}`);
  return JSON.parse(text);
}

/** The raw text of a reply, for error and redaction assertions. */
const toolText = (reply) => reply?.result?.content?.[0]?.text ?? "";

const call = (name, args = {}) => ({ method: "tools/call", params: { name, arguments: args } });

/* ------------------------------------------------------------- fixtures */

const HEALTHY_HEALTH = {
  ok: true,
  status: "ok",
  accepting_documents: true,
  brain: "fixture-brain",
  version: "0.1.22",
  vector_writer_protocol: "lease-v1",
  vector_drain_mode: "active",
  ts: "2026-08-28T00:00:00.000Z",
};

// The real shape worker/src/index.js returns while an upgrade is paused.
const PAUSED_HEALTH = {
  ok: false,
  status: "paused-for-upgrade",
  reason: "This brain cannot accept documents right now. An update paused its corpus " +
    "writes and did not finish. Anything added while it is paused is refused rather than stored.",
  accepting_documents: false,
  brain: "fixture-brain",
  version: "0.1.22",
  vector_writer_protocol: "lease-v1",
  vector_drain_mode: "paused-for-upgrade",
  ts: "2026-08-28T00:00:00.000Z",
};

// A corpus summary that looks entirely well. This is the whole point of the
// paused case: these counts are still there and still correct.
const DOCUMENTS = {
  backend: "d1",
  rows: [{ source: "drive", documents: 412, chunks: 5100 }],
  vector_backlog: { pending: 0 },
  vector_readiness: { ready: true },
};

const ok = (body) => () => ({ status: 200, body });

const BASE_ROUTES = {
  "GET /health": ok(HEALTHY_HEALTH),
  "GET /api/admin/brain/documents": ok(DOCUMENTS),
};

/* ------------------------------------------------------------ the tests */

process.stdout.write("brain-mcp tool dispatch, driven over stdio\n");

/* 1. The tool list is the security boundary, so it is pinned exactly. */
{
  const brain = await startBrain(BASE_ROUTES);
  const { replies, code, stderr } = await speak(brain.url, [{ method: "tools/list" }]);
  await brain.close();

  check("the server starts and exits cleanly", () => {
    assert.equal(code, 0, `exit ${code}, stderr: ${stderr}`);
  });

  const tools = replies.get(1)?.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();

  check("tools/list is exactly the reviewed set", () => {
    assert.deepEqual(names, [
      "brain_diagnose",
      "brain_health",
      "brain_install_state",
      "brain_inventory",
      "brain_search",
      "brain_sources",
      "brain_think",
      "brain_remember",
    ].sort());
  });

  // THE READ-ONLY BOUNDARY, asserted rather than merely commented. Adding any
  // of these to TOOLS fails here, in front of a reviewer, with the reason.
  check("no destructive or provisioning tool is exposed", () => {
    const forbidden = [
      "forget", "delete", "purge", "reindex", "drain", "refit", "bootstrap",
      "ingest", "invite", "provision", "deploy", "connect",
    ];
    for (const name of names) {
      for (const word of forbidden) {
        assert.ok(
          !name.includes(word) || name === "brain_remember",
          `tool "${name}" looks like a write/destructive surface. The MCP process holds the ` +
          "FULL admin key; read the boundary comment above TOOLS in components/brain-mcp.mjs.",
        );
      }
    }
  });

  check("every declared tool carries an input schema", () => {
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 40, `${tool.name} has a thin description`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} has no object schema`);
    }
  });

  check("initialize points the host at the install-state tool", () => {
    const instructions = replies.get(0)?.result?.instructions ?? "";
    assert.match(instructions, /brain_install_state/);
    assert.match(instructions, /brain_sources/);
    assert.match(instructions, /cannot authorise/);
  });
}

/* 2. Every declared tool actually dispatches. A name in TOOLS with no case in
 *    runTool would list fine and fail only in a client's session. */
{
  const brain = await startBrain({
    ...BASE_ROUTES,
    "POST /api/rag/think": ok({ answer: "a", citations: [], gaps: [] }),
    "POST /api/rag/unified": ok({ results: [] }),
    "POST /api/admin/brain/ingest": ok({ action: "created" }),
    "GET /api/admin/brain/freshness": ok({ sources: [] }),
    "GET /api/admin/brain/diagnose": ok({ verdict: "healthy", findings: [], summary: {}, totals: {} }),
    "POST /api/admin/brain/source-families": ok({ source: null, families: [], next_cursor: null }),
  });
  const listed = await speak(brain.url, [{ method: "tools/list" }]);
  const names = (listed.replies.get(1)?.result?.tools ?? []).map((t) => t.name);
  const args = {
    brain_think: { q: "x" },
    brain_search: { q: "x" },
    brain_remember: {
      title: "t",
      body: "a lesson body long enough to satisfy the forty character contract",
      confidence: "inferred",
    },
  };
  const { replies } = await speak(brain.url, [
    ...names.map((n) => call(n, args[n] ?? {})),
    // The one destructive route a client's model might try to name anyway.
    call("brain_forget", { source: "drive", confirm: true }),
  ]);
  await brain.close();

  check("no declared tool is missing a dispatch case", () => {
    names.forEach((name, index) => {
      const text = toolText(replies.get(index + 1));
      assert.ok(!/unknown tool/.test(text), `${name} has no case in runTool`);
    });
  });

  check("an undeclared tool name is refused rather than dispatched", () => {
    const reply = replies.get(names.length + 1);
    assert.ok(reply?.result?.isError, "brain_forget should have come back as a tool error");
    assert.match(toolText(reply), /unknown tool: brain_forget/);
    const paths = brain.requests.map((r) => `${r.method} ${r.path}`);
    assert.equal(
      paths.some((p) => p.includes("forget")),
      false,
      "an undeclared tool name reached the Worker",
    );
  });
}

/* 3. THE BLIND SPOT. A paused upgrade refuses every write with 503 while the
 *    document counts read perfectly normally. */
{
  const brain = await startBrain({
    "GET /health": ok(PAUSED_HEALTH),
    "GET /api/admin/brain/documents": ok(DOCUMENTS),
  });
  const { replies } = await speak(brain.url, [
    call("brain_health"),
    call("brain_install_state"),
  ]);
  await brain.close();

  const health = toolResult(replies.get(1));
  const state = toolResult(replies.get(2));

  check("brain_health still looks entirely well while writes are paused", () => {
    // Not a bug to fix here, the FACT that motivates the new tool: nothing in
    // this payload can tell an assistant the brain is refusing documents.
    assert.equal(health.rows[0].documents, 412);
    assert.equal(JSON.stringify(health).includes("paused"), false);
  });

  check("brain_install_state reports the pause honestly", () => {
    assert.equal(state.accepting_documents, false);
    assert.equal(state.writes_paused, true);
    assert.equal(state.status, "paused-for-upgrade");
    assert.equal(state.vector_drain_mode, "paused-for-upgrade");
  });

  check("the pause note names the consequence and the false reassurance", () => {
    assert.match(state.note, /NOT accepting documents/);
    assert.match(state.note, /503/);
    assert.match(state.note, /refused rather than stored/);
    assert.match(state.note, /brain_health/);
  });

  check("brain_install_state reads /health, not the counts route", () => {
    const paths = brain.requests.map((r) => `${r.method} ${r.path}`);
    assert.ok(paths.includes("GET /health"), paths.join(", "));
  });
}

/* 4. The other two states: accepting, and genuinely unknown. */
{
  const brain = await startBrain(BASE_ROUTES);
  const { replies } = await speak(brain.url, [call("brain_install_state")]);
  await brain.close();
  const state = toolResult(replies.get(1));

  check("a healthy install reports writes accepted, with no alarm", () => {
    assert.equal(state.accepting_documents, true);
    assert.equal(state.writes_paused, false);
    assert.equal(state.note, undefined);
    assert.equal(state.version, "0.1.22");
  });
}

{
  // A Worker older than the accepting_documents field. Answering for it would
  // be inventing the answer, which is the failure this product exists to refuse.
  const brain = await startBrain({
    "GET /health": ok({ ok: true, brain: "fixture-brain", version: "0.1.9" }),
  });
  const { replies } = await speak(brain.url, [call("brain_install_state")]);
  await brain.close();
  const state = toolResult(replies.get(1));

  check("an older Worker's write state is reported UNKNOWN, not healthy", () => {
    assert.equal(state.writes_paused, null);
    assert.equal(state.accepting_documents, null);
    assert.match(state.note, /UNKNOWN/);
    assert.match(state.note, /Do not report it either way/);
  });
}

/* 5. brain_sources: the input to a conversational onboarding. */
{
  const brain = await startBrain({
    "GET /api/admin/brain/freshness": ok({
      sources: [
        { name: "drive", kind: "drive", state: "ok", documents: 412, days_since_ingest: 0, reason: null, automatable: true },
        { name: "gmail", kind: "gmail", state: "never_synced", documents: 0, days_since_ingest: null, reason: null, automatable: true },
        { name: "statements", kind: "folder", state: "stale", documents: 12, days_since_ingest: 40, reason: null, automatable: false },
        { name: "imessage", kind: "imessage", state: "broken", documents: 900, days_since_ingest: 3, reason: "the last sync reported an error", automatable: false },
      ],
    }),
  });
  const { replies } = await speak(brain.url, [call("brain_sources")]);
  await brain.close();
  const sources = toolResult(replies.get(1));

  check("brain_sources maps to GET /api/admin/brain/freshness", () => {
    assert.deepEqual(
      brain.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /api/admin/brain/freshness"],
    );
  });

  check("brain_sources summarises state and names what needs attention", () => {
    assert.equal(sources.sources_status, "ok");
    assert.equal(sources.count, 4);
    assert.deepEqual(sources.by_state, { ok: 1, never_synced: 1, stale: 1, broken: 1 });
    assert.deepEqual(
      sources.needs_attention.map((s) => s.name).sort(),
      ["gmail", "imessage", "statements"],
    );
    assert.equal(sources.needs_attention.find((s) => s.name === "imessage").reason,
      "the last sync reported an error");
    assert.match(sources.note, /not current/);
  });
}

{
  // freshnessReport returns { sources: [], unavailable: true } when the source
  // table cannot be read. Reporting that as "nothing is connected" would be
  // stating an absence we cannot prove.
  const brain = await startBrain({
    "GET /api/admin/brain/freshness": ok({ sources: [], unavailable: true }),
  });
  const { replies } = await speak(brain.url, [call("brain_sources")]);
  await brain.close();
  const sources = toolResult(replies.get(1));

  check("an unreadable source table is not reported as an empty install", () => {
    assert.equal(sources.sources_status, "unavailable");
    assert.equal(sources.count, null);
    assert.match(sources.note, /NOT a finding that nothing/);
  });
}

{
  const brain = await startBrain({
    "GET /api/admin/brain/freshness": ok({ sources: [] }),
  });
  const { replies } = await speak(brain.url, [call("brain_sources")]);
  await brain.close();
  const sources = toolResult(replies.get(1));

  check("a readable but empty source table IS the finding", () => {
    assert.equal(sources.sources_status, "ok");
    assert.equal(sources.count, 0);
    assert.match(sources.note, /nothing has been connected/i);
  });
}

/* 6. brain_diagnose. */
{
  const brain = await startBrain({
    "GET /api/admin/brain/diagnose": ok({
      totals: { documents: 412, chunks: 5100, sources: 4 },
      summary: { crit: 1, warn: 1, info: 1, ok: 0 },
      verdict: "problems",
      findings: [
        { id: "undated", area: "coverage", severity: "info", title: "9 documents carry no date", action: "usually fine" },
        { id: "empty_source", area: "coverage", severity: "warn", title: 'source "gmail" holds nothing', action: "run its ingest" },
        { id: "empty_documents", area: "coverage", severity: "crit", title: "3 documents hold no text", action: "turn OCR on and re-ingest" },
      ],
    }),
  });
  const { replies } = await speak(brain.url, [call("brain_diagnose")]);
  await brain.close();
  const diag = toolResult(replies.get(1));

  check("brain_diagnose maps to GET /api/admin/brain/diagnose", () => {
    assert.deepEqual(
      brain.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /api/admin/brain/diagnose"],
    );
  });

  check("findings come back critical-first, with their actions intact", () => {
    assert.equal(diag.verdict, "problems");
    assert.deepEqual(diag.findings.map((f) => f.severity), ["crit", "warn", "info"]);
    assert.equal(diag.findings[0].action, "turn OCR on and re-ingest");
    assert.match(diag.note, /1 critical finding/);
  });
}

{
  const brain = await startBrain({
    "GET /api/admin/brain/diagnose": ok({
      totals: { documents: 412 }, summary: { crit: 0, warn: 0, info: 0, ok: 0 },
      verdict: "healthy", findings: [],
    }),
  });
  const { replies } = await speak(brain.url, [call("brain_diagnose")]);
  await brain.close();
  const diag = toolResult(replies.get(1));

  check("a clean diagnose does not claim the right material was loaded", () => {
    assert.match(diag.note, /does\s+not say the right material was loaded/);
    assert.match(diag.note, /brain_inventory/);
  });
}

/* 7. brain_inventory: a paged count that refuses to overclaim. */
{
  const pages = [
    { families: ["drive:a", "drive:b"], next_cursor: "drive:b" },
    { families: ["drive:c"], next_cursor: null },
  ];
  const brain = await startBrain({
    "POST /api/admin/brain/source-families": (body, n) => ({ status: 200, body: pages[n - 1] }),
  });
  const { replies } = await speak(brain.url, [call("brain_inventory", { source: "drive" })]);
  await brain.close();
  const inv = toolResult(replies.get(1));

  check("brain_inventory POSTs source-families and pages with the cursor", () => {
    assert.equal(brain.requests.length, 2);
    assert.deepEqual(brain.requests[0].body, { source: "drive", limit: 500 });
    assert.deepEqual(brain.requests[1].body, { source: "drive", cursor: "drive:b", limit: 500 });
  });

  check("a completed walk reports an exact count", () => {
    assert.equal(inv.families, 3);
    assert.equal(inv.complete, true);
    assert.equal(inv.pages_walked, 2);
    assert.equal(inv.next_cursor, undefined);
    assert.deepEqual(inv.sample, ["drive:a", "drive:b", "drive:c"]);
    assert.equal(inv.note, undefined);
  });
}

{
  // A corpus larger than the walk budget. The count is a floor and must say so.
  const brain = await startBrain({
    "POST /api/admin/brain/source-families": (body, n) => ({
      status: 200,
      body: { families: [`u${n}a`, `u${n}b`], next_cursor: `u${n}b` },
    }),
  });
  const { replies } = await speak(brain.url, [call("brain_inventory")]);
  await brain.close();
  const inv = toolResult(replies.get(1));

  check("a truncated walk is reported as a floor, never as a total", () => {
    assert.equal(inv.complete, false);
    assert.equal(inv.pages_walked, 10);
    assert.equal(inv.families, 20);
    assert.equal(inv.next_cursor, "u10b");
    assert.match(inv.note, /FLOOR, not a total/);
    assert.match(inv.note, /at least 20/);
  });

  check("the walk is bounded, so a chat surface cannot run away", () => {
    assert.equal(brain.requests.length, 10);
    assert.equal(brain.requests[0].body.source, undefined);
  });
}

{
  const brain = await startBrain({
    "POST /api/admin/brain/source-families": ok({ families: [], next_cursor: null }),
  });
  const { replies } = await speak(brain.url, [call("brain_inventory", { source: "gmail" })]);
  await brain.close();
  const inv = toolResult(replies.get(1));

  check("an empty source is named in the finding", () => {
    assert.equal(inv.families, 0);
    assert.equal(inv.complete, true);
    assert.match(inv.note, /"gmail" holds no documents/);
  });
}

/* 8. Transport contract: the credential goes out, and never comes back. */
{
  const brain = await startBrain({
    "GET /api/admin/brain/freshness": ok({ sources: [] }),
    // A Worker that echoes the request back in an error body. Real ones have
    // done worse; the redactor is what stands between that and the host model.
    "GET /api/admin/brain/diagnose": () => ({
      status: 500,
      body: { error: `upstream rejected key ${FIXTURE_KEY}` },
    }),
  });
  const { replies, raw } = await speak(brain.url, [
    call("brain_sources"),
    call("brain_diagnose"),
  ]);
  await brain.close();

  check("the admin key is sent on the new read routes", () => {
    assert.equal(brain.requests[0].adminKey, FIXTURE_KEY);
    assert.match(brain.requests[0].userAgent || "", /Mozilla/);
  });

  check("an echoed credential is redacted before it reaches the host", () => {
    const text = toolText(replies.get(2));
    assert.ok(replies.get(2).result.isError, "expected the 500 to surface as a tool error");
    assert.match(text, /<credential redacted>/);
    assert.equal(raw.includes(FIXTURE_KEY), false, "the key reached the host model");
  });
}

/* ------------------------------------------------------------- verdict */

rmSync(sandboxHome, { recursive: true, force: true });

if (failures.length) {
  process.stdout.write(`\n${failures.length} failure(s):\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write("\nall mcp tool dispatch checks passed\n");
