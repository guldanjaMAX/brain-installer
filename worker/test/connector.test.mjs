/**
 * Remote connector end-to-end: discovery -> dynamic registration -> passkey-
 * session-gated approval -> PKCE token exchange -> MCP initialize/tools ->
 * revocation via the owner's sign-out-everywhere generation. Driven through
 * the worker's real fetch handler with real PKCE crypto; only D1 is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import worker from "../src/index.js";
import { mintSessionCookie } from "../src/lib/sessions.js";

const ORIGIN = "https://brain.example.com";

function connectorDb() {
  const tables = {
    clients: new Map(), codes: new Map(), tokens: new Map(),
    documents: new Map(), chunks: [],
    state: { session_generation: 1 },
  };
  return {
    tables,
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() {
          if (/FROM oauth_clients/.test(sql)) return tables.clients.get(bound[0]) || null;
          if (/FROM oauth_codes/.test(sql)) return tables.codes.get(bound[0]) || null;
          if (/FROM oauth_tokens/.test(sql)) return tables.tokens.get(bound[0]) || null;
          if (/FROM documents WHERE doc_uid/.test(sql)) return tables.documents.get(bound[0]) || null;
          if (/session_generation FROM install_state/.test(sql)) return { session_generation: tables.state.session_generation };
          return null;
        },
        async all() {
          if (/FROM chunks WHERE doc_uid/.test(sql)) {
            return { results: tables.chunks.filter((c) => c.doc_uid === bound[0]) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO oauth_clients/.test(sql)) {
            tables.clients.set(bound[0], { client_id: bound[0], client_name: bound[1], redirect_uris: bound[2] });
          } else if (/INSERT INTO oauth_codes/.test(sql)) {
            tables.codes.set(bound[0], {
              client_id: bound[1], redirect_uri: bound[2], code_challenge: bound[3],
              scope: bound[4], expires_at: bound[5], used_at: null,
            });
          } else if (/DELETE FROM oauth_codes/.test(sql)) tables.codes.delete(bound[0]);
          else if (/INSERT INTO oauth_tokens/.test(sql)) {
            tables.tokens.set(bound[0], {
              token_hash: bound[0], client_id: bound[1], scope: bound[2],
              session_generation: bound[3], created_at: bound[4], expires_at: bound[5], revoked_at: null,
            });
          } else if (/UPDATE oauth_tokens SET last_used_at/.test(sql)) {
            const row = tables.tokens.get(bound[1]);
            if (row) row.last_used_at = bound[0];
          }
          return {};
        },
      };
      return statement;
    },
    async batch() {},
  };
}

function env(db) {
  return {
    STORAGE: "d1", DB: db, ADMIN_KEY: "admin-key-fixture-value-000",
    SESSION_SIGNING_KEY: "b".repeat(64), BRAIN_NAME: "fixture", BRAIN_VERSION: "0.1.19",
  };
}

const jsonPost = (path, payload, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(payload || {}),
});

const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("the full connector journey, register through revocation", async () => {
  const db = connectorDb();
  const testEnv = env(db);

  // Discovery documents exist without any credential.
  const metadata = await (await worker.fetch(new Request(ORIGIN + "/.well-known/oauth-authorization-server"), testEnv)).json();
  assert.equal(metadata.token_endpoint, ORIGIN + "/oauth/token");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  const resource = await (await worker.fetch(new Request(ORIGIN + "/.well-known/oauth-protected-resource"), testEnv)).json();
  assert.equal(resource.resource, ORIGIN + "/mcp");

  // The endpoint refuses without a bearer AND says where discovery starts.
  const unauthorized = await worker.fetch(jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }), testEnv);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("WWW-Authenticate") || "", /resource_metadata=/);

  // Dynamic registration: hosted redirect only, garbage refused.
  const badRegister = await worker.fetch(jsonPost("/oauth/register", { redirect_uris: ["javascript:alert(1)"] }), testEnv);
  assert.equal(badRegister.status, 400);
  const registered = await (await worker.fetch(jsonPost("/oauth/register", {
    client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  }), testEnv)).json();
  assert.ok(registered.client_id);

  // PKCE pair, real crypto.
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const authorizeQuery = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  // The consent page renders for a valid client; a forged client gets no redirect.
  const page = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?${authorizeQuery}`), testEnv);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy") || "", /connect-src 'self'/);
  const forged = await worker.fetch(new Request(`${ORIGIN}/oauth/authorize?client_id=nope&redirect_uri=https://evil.example.com/cb`), testEnv);
  assert.equal(forged.status, 400);

  // Approval requires the owner's passkey session.
  const denied = await worker.fetch(jsonPost(`/oauth/authorize/decision?${authorizeQuery}`, {}, { "X-Brain-App": "1" }), testEnv);
  assert.equal(denied.status, 401);
  const cookie = (await mintSessionCookie(testEnv, 1)).split(";")[0];
  const approved = await (await worker.fetch(jsonPost(`/oauth/authorize/decision?${authorizeQuery}`, {}, {
    Cookie: cookie, "X-Brain-App": "1",
  }), testEnv)).json();
  assert.match(approved.redirect, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/);
  assert.match(approved.redirect, /state=xyz/);
  const code = new URL(approved.redirect).searchParams.get("code");

  // Token exchange: wrong verifier fails, right verifier succeeds, replay dies.
  const wrongVerifier = await worker.fetch(jsonPost("/oauth/token", {
    grant_type: "authorization_code", code, client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: b64u(randomBytes(48)),
  }), testEnv);
  assert.equal(wrongVerifier.status, 400, "a wrong PKCE verifier must fail and burn the code");
  const secondApproval = await (await worker.fetch(jsonPost(`/oauth/authorize/decision?${authorizeQuery}`, {}, {
    Cookie: cookie, "X-Brain-App": "1",
  }), testEnv)).json();
  const freshCode = new URL(secondApproval.redirect).searchParams.get("code");
  const tokenResponse = await (await worker.fetch(jsonPost("/oauth/token", {
    grant_type: "authorization_code", code: freshCode, client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier,
  }), testEnv)).json();
  assert.equal(tokenResponse.token_type, "Bearer");
  const bearer = { Authorization: `Bearer ${tokenResponse.access_token}` };
  const replay = await worker.fetch(jsonPost("/oauth/token", {
    grant_type: "authorization_code", code: freshCode, client_id: registered.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier,
  }), testEnv);
  assert.equal(replay.status, 400, "an authorization code is single use");

  // MCP: initialize, list, and the deep-research search/fetch pair.
  const initialized = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }, bearer), testEnv)).json();
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.ok(initialized.result.capabilities.tools);

  const tools = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/list",
  }, bearer), testEnv)).json();
  assert.deepEqual(tools.result.tools.map((t) => t.name), ["ask", "search", "fetch"]);

  const searched = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "anything" } },
  }, bearer), testEnv)).json();
  assert.deepEqual(JSON.parse(searched.result.content[0].text), { results: [] });

  db.tables.documents.set("drive:doc-1", { title: "Fixture doc", uri: null });
  db.tables.chunks.push({ doc_uid: "drive:doc-1", text: "the fixture body" });
  const fetched = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fetch", arguments: { id: "drive:doc-1" } },
  }, bearer), testEnv)).json();
  const fetchedBody = JSON.parse(fetched.result.content[0].text);
  assert.equal(fetchedBody.title, "Fixture doc");
  assert.match(fetchedBody.text, /fixture body/);

  // ask flows through the REAL think handler; with no LLM key configured the
  // plumbing still answers deterministically instead of fabricating.
  const asked = await (await worker.fetch(jsonPost("/mcp", {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask", arguments: { question: "hello?" } },
  }, bearer), testEnv)).json();
  assert.ok(asked.result.isError || /do not answer|nothing/i.test(asked.result.content[0].text),
    JSON.stringify(asked.result).slice(0, 200));

  // The owner's sign-out-everywhere kills connector tokens too.
  db.tables.state.session_generation = 2;
  const afterBump = await worker.fetch(jsonPost("/mcp", { jsonrpc: "2.0", id: 6, method: "ping" }, bearer), testEnv);
  assert.equal(afterBump.status, 401, "one revocation story: generation bump ends connectors");
});

test("a connector token can never reach past the read-only class", async () => {
  const db = connectorDb();
  const testEnv = env(db);
  // Forge a stored token directly (hash of a known value) to isolate the check.
  const raw = "t".repeat(43);
  const hash = createHash("sha256").update(raw).digest("hex");
  db.tables.tokens.set(hash, {
    token_hash: hash, client_id: "c", scope: "read",
    session_generation: 1, created_at: Date.now(), expires_at: Date.now() + 60_000, revoked_at: null,
  });
  const bearer = { Authorization: `Bearer ${raw}` };
  const ingest = await worker.fetch(jsonPost("/api/admin/brain/ingest", { docs: [] }, bearer), testEnv);
  assert.equal(ingest.status, 401, "bearer tokens must be worthless on admin routes");
  const read = await worker.fetch(jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, bearer), testEnv);
  assert.equal(read.status, 200);
});
