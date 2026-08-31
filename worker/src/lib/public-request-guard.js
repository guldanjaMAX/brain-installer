import { jsonResponse, privateNoStore } from "./core.js";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const encoder = new TextEncoder();

const POLICY = Object.freeze({
  auth: { bodyBytes: 64 * 1024, windowSeconds: 60, ipLimit: 30, clientLimit: 20 },
  oauth_register: { bodyBytes: 32 * 1024, windowSeconds: 3600, ipLimit: 8, clientLimit: 0 },
  oauth_authorize: { bodyBytes: 32 * 1024, windowSeconds: 60, ipLimit: 30, clientLimit: 20 },
  oauth_token: { bodyBytes: 32 * 1024, windowSeconds: 60, ipLimit: 40, clientLimit: 25 },
  quickbooks_oauth_claim: { bodyBytes: 12 * 1024, windowSeconds: 60, ipLimit: 30, clientLimit: 0 },
});

function routeClass(path) {
  if (path === "/oauth/register") return "oauth_register";
  if (path === "/oauth/token") return "oauth_token";
  if (path.startsWith("/oauth/authorize")) return "oauth_authorize";
  if (path === "/api/oauth/quickbooks/intents/claim") return "quickbooks_oauth_claim";
  if (path.startsWith("/auth/")) return "auth";
  return null;
}

async function boundedBody(request, maxBytes) {
  if (!BODY_METHODS.has(request.method) || !request.body) return { request, bytes: new Uint8Array() };
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("public auth request body exceeded limit").catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
      redirect: request.redirect,
    }),
    bytes,
  };
}

function clientIdFrom(request, url, bytes) {
  const query = url.searchParams.get("client_id");
  if (query) return query.slice(0, 512);
  const header = request.headers.get("x-oauth-client-id");
  if (header) return header.slice(0, 512);
  if (!bytes?.byteLength) return null;
  const type = String(request.headers.get("content-type") || "").toLowerCase();
  const text = new TextDecoder().decode(bytes);
  try {
    if (type.includes("application/x-www-form-urlencoded")) {
      return new URLSearchParams(text).get("client_id")?.slice(0, 512) || null;
    }
    if (type.includes("application/json")) {
      const value = JSON.parse(text)?.client_id;
      return typeof value === "string" ? value.slice(0, 512) : null;
    }
  } catch {
    // The owning auth handler returns the precise malformed-body response.
  }
  return null;
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeQuota(env, { route, dimension, value, policy, now }) {
  const secret = String(env.SESSION_SIGNING_KEY || "");
  if (!secret) throw new Error("SESSION_SIGNING_KEY is required for privacy-safe public quotas");
  if (!env.DB) throw new Error("D1 is required for public request quotas");
  const windowMs = policy.windowSeconds * 1000;
  const windowStarted = Math.floor(now / windowMs) * windowMs;
  const keyHash = await hmacHex(secret, `${dimension}:${value}`);
  const limit = dimension === "ip" ? policy.ipLimit : policy.clientLimit;
  const row = await env.DB.prepare(
    `INSERT INTO public_request_quotas
       (key_hash, route_class, window_started_at, request_count, expires_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(key_hash, route_class, window_started_at) DO UPDATE SET
       request_count = public_request_quotas.request_count + 1
     WHERE public_request_quotas.request_count < ?
     RETURNING request_count`,
  ).bind(keyHash, route, windowStarted, windowStarted + windowMs * 2, limit).first();
  return {
    allowed: Number(row?.request_count || 0) > 0,
    limit,
    retryAfter: Math.max(1, Math.ceil((windowStarted + windowMs - now) / 1000)),
  };
}

function refusal(body, status, headers = {}) {
  const response = jsonResponse(body, status);
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, String(value));
  return privateNoStore(new Response(response.body, { status, headers: merged }));
}

/** Bound and quota unauthenticated auth/OAuth routes before ceremony code runs. */
export async function guardPublicRequest(env, request, url, path, now = Date.now()) {
  const route = routeClass(path);
  if (!route) return { request };
  const policy = POLICY[route];
  const body = await boundedBody(request, policy.bodyBytes);
  if (body.tooLarge) {
    return { response: refusal({ error: "request body too large", code: "body_limit" }, 413) };
  }

  try {
    const ip = String(request.headers.get("cf-connecting-ip") || "unknown").slice(0, 128);
    const ipQuota = await consumeQuota(env, { route, dimension: "ip", value: ip, policy, now });
    if (!ipQuota.allowed) {
      return {
        response: refusal(
          { error: "too many requests", code: "ip_quota" },
          429,
          { "Retry-After": ipQuota.retryAfter, "RateLimit-Limit": ipQuota.limit },
        ),
      };
    }
    const clientId = clientIdFrom(body.request, url, body.bytes);
    if (clientId && policy.clientLimit > 0) {
      const clientQuota = await consumeQuota(env, {
        route, dimension: "client", value: clientId, policy, now,
      });
      if (!clientQuota.allowed) {
        return {
          response: refusal(
            { error: "too many requests", code: "client_quota" },
            429,
            { "Retry-After": clientQuota.retryAfter, "RateLimit-Limit": clientQuota.limit },
          ),
        };
      }
    }
    return { request: body.request };
  } catch (error) {
    return {
      response: refusal({
        error: "public authentication is temporarily unavailable",
        code: "quota_unavailable",
      }, 503),
      error,
    };
  }
}

/** Delete only expired or consumed public auth state, in bounded batches. */
export async function cleanupPublicAuthState(env, { now = Date.now(), limit = 500 } = {}) {
  if (!env.DB) return { skipped: true, reason: "no_d1" };
  const bounded = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const graceHour = now - 60 * 60 * 1000;
  const revokedGrace = now - 7 * 24 * 60 * 60 * 1000;
  const statements = [
    ["quotas", `DELETE FROM public_request_quotas WHERE rowid IN (SELECT rowid FROM public_request_quotas WHERE expires_at < ? LIMIT ?)`, now],
    ["challenges", `DELETE FROM auth_challenges WHERE rowid IN (SELECT rowid FROM auth_challenges WHERE expires_at < ? LIMIT ?)`, graceHour],
    ["enrollment_codes", `DELETE FROM enrollment_codes WHERE rowid IN (SELECT rowid FROM enrollment_codes WHERE expires_at < ? LIMIT ?)`, graceHour],
    ["oauth_codes", `DELETE FROM oauth_codes WHERE rowid IN (SELECT rowid FROM oauth_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?) LIMIT ?)`, graceHour, graceHour],
    ["oauth_tokens", `DELETE FROM oauth_tokens WHERE rowid IN (SELECT rowid FROM oauth_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?) LIMIT ?)`, revokedGrace, revokedGrace],
  ];
  const out = {};
  for (const [name, sql, ...params] of statements) {
    const result = await env.DB.prepare(sql).bind(...params, bounded).run();
    out[name] = Number(result?.meta?.changes ?? result?.changes ?? 0);
  }
  return { cleaned: out };
}
