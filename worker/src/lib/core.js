// core.js — HTTP helpers, auth, and the LLM call with its spend cap.
//
// Extracted from a single-tenant worker and genericized. Every
// Instance-specific values are now read from env.

/* ---------------------------------------------------------------- http */

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ---------------------------------------------------------------- auth */

// Constant-time compare. Workers do not expose crypto.timingSafeEqual, so this
// is the standard XOR-over-bytes fallback. Length mismatch returns immediately
// because the length itself is not secret.
function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validateAdminKey(request, env) {
  // Secrets belong in headers. Query-string credentials leak too easily into
  // browser history, proxy/access logs, analytics, screenshots and referrers.
  const key = request.headers.get("X-Admin-Key");
  if (!key || !env.ADMIN_KEY) return false;
  return constantTimeEquals(key, env.ADMIN_KEY);
}

/**
 * Accept the full admin key or the optional read-only proxy key.
 *
 * The proxy key is deliberately valid only on the two retrieval routes. A UI
 * proxy can answer questions without holding a credential that can ingest,
 * purge, reindex, drain, or inspect administrative state.
 */
export function validateReadKey(request, env) {
  const key = request.headers.get("X-Admin-Key");
  if (!key) return false;
  if (env.ADMIN_KEY && constantTimeEquals(key, env.ADMIN_KEY)) return true;
  return !!env.RAG_PROXY_KEY && constantTimeEquals(key, env.RAG_PROXY_KEY);
}

/* ----------------------------------------------------------------- llm */

const CAP_TABLE = `CREATE TABLE IF NOT EXISTS llm_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  label TEXT,
  model TEXT,
  status TEXT,
  est_cost_usd_micros INTEGER DEFAULT 0
)`;

let capCache = { day: null, micros: 0, checkedAt: 0 };

async function ensureLogTable(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(CAP_TABLE.replace(/\s+/g, " "));
  } catch {
    /* table probably exists */
  }
}

/**
 * Per-UTC-day spend guard.
 *
 * Exists because a runaway loop is a billing incident, not a bug you notice
 * next month. The cost of the call in flight is folded into the cache
 * immediately, so a tight loop is caught inside the cache window rather than
 * after it expires.
 *
 * Fails OPEN if the query itself errors: the guard must never be the reason a
 * legitimate call fails. It fails CLOSED only once positively over budget.
 */
async function spentTodayMicros(env) {
  const day = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  if (capCache.day === day && now - capCache.checkedAt < 60_000) return capCache.micros;
  if (!env.DB) return 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COALESCE(SUM(est_cost_usd_micros),0) AS m FROM llm_call_log WHERE day = ? AND status != 'blocked'"
    )
      .bind(day)
      .first();
    capCache = { day, micros: Number(row?.m || 0), checkedAt: now };
    return capCache.micros;
  } catch {
    return 0; // fail open
  }
}

async function logCall(env, { label, model, status, micros }) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO llm_call_log (ts, day, label, model, status, est_cost_usd_micros) VALUES (?,?,?,?,?,?)"
    )
      .bind(now, now.slice(0, 10), label || null, model || null, status, micros || 0)
      .run();
  } catch {
    /* logging must never break the call */
  }
}

export async function callLLM(env, { model, system, messages, max_tokens, label, timeoutMs }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey && !env.AI) {
    const e = new Error("no LLM key configured");
    e.no_key = true;
    throw e;
  }

  await ensureLogTable(env);

  const capUsd = Number(env.DAILY_LLM_CAP_USD || 10);
  const spent = await spentTodayMicros(env);
  if (spent >= capUsd * 1_000_000) {
    await logCall(env, { label, model, status: "blocked", micros: 0 });
    const e = new Error(`daily LLM spend cap of $${capUsd} reached`);
    e.llm_cap_exceeded = true;
    throw e;
  }

  if (!apiKey) {
    const workersModel = String(model || "").startsWith("@cf/")
      ? model
      : env.WORKERS_AI_ANSWER_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    try {
      const data = await env.AI.run(workersModel, {
        messages: [{ role: "system", content: system }, ...(messages || [])],
        max_tokens: max_tokens || 1000,
        temperature: 0,
      });
      const rawResponse = data?.response;
      const text = typeof rawResponse === "string"
        ? rawResponse.trim()
        : rawResponse && typeof rawResponse === "object"
          ? JSON.stringify(rawResponse)
          : "";
      if (!text) throw new Error("Workers AI returned no answer text");
      const inTok = data?.usage?.prompt_tokens || data?.usage?.input_tokens || 0;
      const outTok = data?.usage?.completion_tokens || data?.usage?.output_tokens || 0;
      // llama-3.3-70b-fp8-fast: $0.293/M input and $2.25/M output.
      // Keep the estimate conservative enough for the guard to remain useful.
      const micros = Math.ceil(inTok * 0.293 + outTok * 2.25);
      capCache.micros += micros;
      await logCall(env, { label, model: workersModel, status: "ok", micros });
      return {
        content: [{ type: "text", text }],
        model: workersModel,
        usage: data?.usage || {},
        provider: "cloudflare-workers-ai",
      };
    } catch (error) {
      await logCall(env, { label, model: workersModel, status: "error", micros: 0 });
      throw new Error(`Workers AI: ${error?.message || error}`);
    }
  }

  const anthropicModel = String(model || "").startsWith("@cf/")
    ? env.ANTHROPIC_ANSWER_MODEL || "claude-sonnet-4-5"
    : model;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: anthropicModel, max_tokens: max_tokens || 1000, system, messages }),
    signal: AbortSignal.timeout(timeoutMs || 45_000),
  });

  if (!res.ok) {
    const text = await res.text();
    await logCall(env, { label, model, status: "error", micros: 0 });
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  // Rough cost estimate. Precision is not the point; catching a runaway is.
  const inTok = data?.usage?.input_tokens || 0;
  const outTok = data?.usage?.output_tokens || 0;
  const micros = Math.round(inTok * 3 + outTok * 15);
  capCache.micros += micros;
  await logCall(env, { label, model: data?.model || anthropicModel, status: "ok", micros });
  return data;
}
