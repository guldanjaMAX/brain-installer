/**
 * oauth — the authorization server remote connectors sign in through.
 *
 * The Claude app and ChatGPT reach a brain as remote MCP connectors, and the
 * MCP spec's auth story is OAuth 2.1: dynamic client registration, an
 * authorize step, PKCE (S256 only), and bearer tokens on the endpoint. All
 * of it lives HERE, in the owner's worker — no third-party identity service,
 * which is the same custody stance as everything else.
 *
 * The authorize step IS the passkey page: a connector's consent screen is
 * gated by the owner's session cookie, which only a Face ID / fingerprint
 * ceremony can mint. A connector therefore cannot be approved by anyone but
 * the person whose face opens the brain.
 *
 * Codes and tokens are stored hashed and are live security state:
 *   - codes are single-use with a five-minute TTL;
 *   - tokens are opaque 32-byte values, individually revocable, 30-day
 *     expiry, and BORN INTO the current session generation — the owner's
 *     "Sign out everywhere" bumps the generation and every connector token
 *     dies with the cookies. One revocation story, no special cases.
 *
 * Tokens grant exactly the read-only privilege class. A leaked connector
 * token can ask questions until revoked or expired, and nothing else.
 */

import { jsonResponse } from "./core.js";
import { randomToken, sessionGeneration } from "./auth-store.js";
import { validateOwnerSession } from "./owner-auth.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIGRATION_HINT = "connector tables are missing; run `brain setup <manifest>` to apply migration 0015";

function guard(error) {
  if (/no such table/i.test(String(error?.message || error))) throw new Error(MIGRATION_HINT);
  throw error;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function b64uSha256Bytes(bytes) {
  let ascii = "";
  for (const byte of bytes) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256: base64url(sha256(verifier)) must equal the stored challenge. */
async function pkceMatches(verifier, challenge) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return b64uSha256Bytes(digest) === String(challenge);
}

function validRedirectUri(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  // Connectors are hosted services; loopback is allowed for local MCP tooling.
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.hash;
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------- discovery */

export function handleOAuthMetadata(url) {
  // RFC 8414 + RFC 9728: both documents point at this same origin. MCP
  // clients read one or both to find the authorize and token endpoints.
  return jsonResponse({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/oauth/authorize`,
    token_endpoint: `${url.origin}/oauth/token`,
    registration_endpoint: `${url.origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read"],
  });
}

export function handleProtectedResourceMetadata(url) {
  return jsonResponse({
    resource: `${url.origin}/mcp`,
    authorization_servers: [url.origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read"],
  });
}

/* ---------------------------------------------------------- registration */

export async function handleRegister(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_client_metadata" }, 400);
  }
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
    return jsonResponse({ error: "invalid_redirect_uri" }, 400);
  }
  const clientId = randomToken(16);
  try {
    await env.DB.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
    ).bind(clientId, String(body.client_name || "").slice(0, 120) || null, JSON.stringify(redirectUris), Date.now()).run();
  } catch (error) {
    guard(error);
  }
  return jsonResponse({
    client_id: clientId,
    client_name: body.client_name || undefined,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  }, 201);
}

/* ------------------------------------------------------------- authorize */

async function loadClient(env, clientId) {
  try {
    const row = await env.DB.prepare(
      "SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?",
    ).bind(String(clientId || "")).first();
    if (!row) return null;
    return { ...row, redirect_uris: JSON.parse(row.redirect_uris) };
  } catch (error) {
    guard(error);
  }
}

function authorizeParams(url) {
  const p = url.searchParams;
  return {
    client_id: p.get("client_id") || "",
    redirect_uri: p.get("redirect_uri") || "",
    state: p.get("state") || "",
    scope: p.get("scope") || "read",
    code_challenge: p.get("code_challenge") || "",
    code_challenge_method: p.get("code_challenge_method") || "",
    response_type: p.get("response_type") || "",
  };
}

/**
 * GET /oauth/authorize — the consent screen. Invalid client/redirect fails
 * HERE and never redirects (an open redirect is the classic OAuth wound);
 * every later error returns to the validated redirect_uri per spec.
 */
export async function handleAuthorizePage(env, url) {
  const params = authorizeParams(url);
  const client = await loadClient(env, params.client_id);
  if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
    return jsonResponse({ error: "unknown client or redirect_uri" }, 400);
  }
  const back = (error) => Response.redirect(
    `${params.redirect_uri}${params.redirect_uri.includes("?") ? "&" : "?"}error=${error}` +
    (params.state ? `&state=${encodeURIComponent(params.state)}` : ""), 302);
  if (params.response_type !== "code") return back("unsupported_response_type");
  if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) {
    return back("invalid_request");
  }

  const name = esc(client.client_name || "A connector");
  const brain = esc(env.BRAIN_NAME || "your brain");
  const query = esc(url.search.slice(1));
  const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to ${brain}</title>
<style>
  body{font:16px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f6;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#fff;border:1px solid #e4e0d8;border-radius:12px;padding:26px;max-width:420px;margin:20px}
  h1{font-size:18px;margin:0 0 10px} p{color:#666;font-size:14.5px;margin:0 0 8px}
  button{font:inherit;border:0;border-radius:10px;padding:11px 18px;cursor:pointer;background:#3b5bdb;color:#fff;font-weight:600;margin-top:14px;width:100%}
  button.quiet{background:transparent;color:#666;font-weight:400}
  .error{color:#b03030;font-size:14px;margin-top:10px}
</style>
<div class="card">
  <h1>${name} wants to read ${brain}</h1>
  <p>It will be able to <strong>ask questions and read answers</strong> — nothing else. It can never add, change, or delete anything.</p>
  <p>Approving uses your passkey. Revoke any time from Settings, or with Sign out everywhere.</p>
  <button id="approve">Approve with passkey</button>
  <button id="deny" class="quiet">Cancel</button>
  <p id="err" class="error" hidden></p>
</div>
<script>
(() => {
  "use strict";
  const q = "${query}";
  const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
  const api = (path, payload) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Brain-App": "1" }, body: JSON.stringify(payload || {}) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
  async function signIn() {
    const options = await api("/auth/login/options");
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: b64uToBytes(options.challenge), rpId: options.rp_id, userVerification: "required", allowCredentials: [],
    }});
    await api("/auth/login/verify", {
      credentialId: assertion.id,
      authenticatorData: bytesToB64u(assertion.response.authenticatorData),
      clientDataJSON: bytesToB64u(assertion.response.clientDataJSON),
      signature: bytesToB64u(assertion.response.signature),
    });
  }
  document.getElementById("approve").onclick = async () => {
    document.getElementById("err").hidden = true;
    try {
      let decision = await fetch("/oauth/authorize/decision?" + q, { method: "POST", headers: { "X-Brain-App": "1" } });
      if (decision.status === 401) { await signIn(); decision = await fetch("/oauth/authorize/decision?" + q, { method: "POST", headers: { "X-Brain-App": "1" } }); }
      const body = await decision.json();
      if (!decision.ok || !body.redirect) throw new Error(body.error || ("HTTP " + decision.status));
      location.href = body.redirect;
    } catch (error) {
      const el = document.getElementById("err");
      el.textContent = String(error.message || error);
      el.hidden = false;
    }
  };
  document.getElementById("deny").onclick = () => {
    const p = new URLSearchParams(q);
    const u = p.get("redirect_uri");
    location.href = u + (u.includes("?") ? "&" : "?") + "error=access_denied" + (p.get("state") ? "&state=" + encodeURIComponent(p.get("state")) : "");
  };
})();
</script></html>`;
  return new Response(page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** POST /oauth/authorize/decision — passkey-session-gated approval. */
export async function handleAuthorizeDecision(env, request, url) {
  if (!(await validateOwnerSession(request, env))) return jsonResponse({ error: "unauthorized" }, 401);
  const params = authorizeParams(url);
  const client = await loadClient(env, params.client_id);
  if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
    return jsonResponse({ error: "unknown client or redirect_uri" }, 400);
  }
  if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const code = randomToken(32);
  try {
    await env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(await sha256Hex(code), client.client_id, params.redirect_uri, params.code_challenge, "read", Date.now() + CODE_TTL_MS).run();
  } catch (error) {
    guard(error);
  }
  const redirect = `${params.redirect_uri}${params.redirect_uri.includes("?") ? "&" : "?"}code=${code}` +
    (params.state ? `&state=${encodeURIComponent(params.state)}` : "");
  return jsonResponse({ redirect });
}

/* ----------------------------------------------------------------- token */

export async function handleToken(env, request) {
  let params;
  const contentType = request.headers.get("Content-Type") || "";
  try {
    params = contentType.includes("json")
      ? new Map(Object.entries(await request.json()))
      : new Map(new URLSearchParams(await request.text()));
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  if (params.get("grant_type") !== "authorization_code") {
    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }
  const codeHash = await sha256Hex(String(params.get("code") || ""));
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT client_id, redirect_uri, code_challenge, scope, expires_at, used_at FROM oauth_codes WHERE code_hash = ?",
    ).bind(codeHash).first();
    // Single use, deleted on sight: a replayed code proves interception and
    // must not stay replayable while anyone reasons about it.
    await env.DB.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").bind(codeHash).run();
  } catch (error) {
    guard(error);
  }
  if (!row || row.used_at || Number(row.expires_at) <= Date.now() ||
      String(row.client_id) !== String(params.get("client_id") || "") ||
      String(row.redirect_uri) !== String(params.get("redirect_uri") || "")) {
    return jsonResponse({ error: "invalid_grant" }, 400);
  }
  if (!(await pkceMatches(params.get("code_verifier"), row.code_challenge))) {
    return jsonResponse({ error: "invalid_grant" }, 400);
  }
  const token = randomToken(32);
  const generation = await sessionGeneration(env);
  try {
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (token_hash, client_id, scope, session_generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(await sha256Hex(token), row.client_id, row.scope || "read", generation, Date.now(), Date.now() + TOKEN_TTL_MS).run();
  } catch (error) {
    guard(error);
  }
  return jsonResponse({
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    scope: row.scope || "read",
  });
}

/* ------------------------------------------------------------ validation */

/** Bearer check for /mcp: unexpired, unrevoked, current-generation. */
export async function validateConnectorToken(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!match) return false;
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT token_hash, session_generation, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ?",
    ).bind(await sha256Hex(match[1])).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) return false;
    throw error;
  }
  if (!row || row.revoked_at || Number(row.expires_at) <= Date.now()) return false;
  if (Number(row.session_generation) !== (await sessionGeneration(env))) return false;
  await env.DB.prepare("UPDATE oauth_tokens SET last_used_at = ? WHERE token_hash = ?")
    .bind(Date.now(), row.token_hash).run();
  return true;
}
