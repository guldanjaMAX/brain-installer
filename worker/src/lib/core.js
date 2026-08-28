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

// What THIS isolate has charged today. Written by this process on every billed
// call, so no database can lose it. It is the floor under every budget
// decision, and it is the whole reason a broken ledger cannot mean zero spend.
let isolateLedger = { day: null, micros: 0 };

// Why the guard is degraded, when it is. Kept so the refusal can name its cause
// and so a health route can surface it, rather than leaving a silent hole where
// a cap used to be.
let guardState = { degraded: false, reason: null, since: null };

// The share of the day's budget a degraded guard is still allowed to spend.
// Small on purpose: enough to ride out a D1 blip, nowhere near enough for a
// runaway loop to matter.
const DEGRADED_BUDGET_FRACTION = 0.1;

// ...and never more than this in absolute terms, however large the configured
// cap is. A client running a $500/day cap has the appetite for it; a broken
// ledger is still not a licence to spend at that rate unsupervised.
const DEGRADED_BUDGET_CEILING_USD = 5;

const degradedBudgetUsd = (capUsd) =>
  Math.min(capUsd * DEGRADED_BUDGET_FRACTION, DEGRADED_BUDGET_CEILING_USD);

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The configured cap, in dollars.
 *
 * A garbled value falls back to the default rather than to NaN. `spent >= NaN`
 * is false, so a typo in DAILY_LLM_CAP_USD would otherwise remove the cap
 * entirely and look like a working config while doing so.
 */
function capUsdFor(env) {
  const raw = env.DAILY_LLM_CAP_USD;
  const n = raw === undefined || raw === null || raw === "" ? 10 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/** Record a billed call against this isolate, resetting on UTC day rollover. */
function chargeIsolate(micros) {
  const day = utcDay();
  if (isolateLedger.day !== day) isolateLedger = { day, micros: 0 };
  isolateLedger.micros += Math.max(0, Number(micros) || 0);
}

function markDegraded(reason) {
  if (!guardState.degraded || guardState.reason !== reason) {
    console.warn(`[spend-guard] DEGRADED: ${reason}. Falling back to a reduced per-instance allowance.`);
    guardState = { degraded: true, reason, since: new Date().toISOString() };
  }
}

function markHealthy() {
  if (guardState.degraded) {
    console.warn("[spend-guard] recovered: the spend ledger is readable again; the full cap is back in force.");
    guardState = { degraded: false, reason: null, since: null };
  }
}

/** Read-only view of the guard, for health reporting and tests. */
export function spendGuardStatus() {
  return {
    degraded: guardState.degraded,
    reason: guardState.reason,
    since: guardState.since,
    isolate_day: isolateLedger.day,
    isolate_spent_micros: isolateLedger.micros,
  };
}

/**
 * Per-UTC-day spend guard.
 *
 * Exists because a runaway loop is a billing incident, not a bug you notice
 * next month. The cost of the call in flight is folded in immediately, so a
 * tight loop is caught inside the cache window rather than after it expires.
 *
 * It does NOT fail open. It used to: the catch returned 0, which reported zero
 * spend and un-bound the cap for as long as D1 was unhappy. A cap that fails
 * open is not a cap. On a client-owned install the payment method behind it is
 * the client's, so the failure mode was somebody else's bill.
 *
 * It does not fail fully closed either. Refusing every answer because a logging
 * table hiccuped is its own kind of broken, and to the client it looks like the
 * brain is down. So the guard degrades: it falls back to what THIS isolate
 * knows it has spent and holds that against a small fraction of the day's
 * budget. Answers keep flowing through a blip; a loop hits the floor fast and
 * stops. Unbounded spend is unreachable in every branch, because the isolate
 * ledger only ever grows and is never replaced by a zero.
 *
 * The honest limit, stated rather than glossed: the degraded bound is per
 * isolate, not global. A runaway loop lives in one isolate and is bounded
 * exactly. Broad fan-out across many isolates while D1 is down is bounded only
 * by (isolates x reduced allowance), which is far tighter than "no cap" but is
 * not a single global number.
 */
async function readSpend(env) {
  const day = utcDay();
  const now = Date.now();
  if (isolateLedger.day !== day) isolateLedger = { day, micros: 0 };
  const floor = isolateLedger.micros;

  if (!env.DB) {
    // No binding means no ledger exists to read, which is the same hole as a
    // failing query: nothing outside this process could ever bind the cap.
    markDegraded("no D1 binding, so no spend ledger exists to read");
    return { micros: floor, degraded: true };
  }

  // While degraded, skip the cache window and retry every call, so the full cap
  // comes back the moment D1 does.
  if (!guardState.degraded && capCache.day === day && now - capCache.checkedAt < 60_000) {
    return { micros: Math.max(capCache.micros, floor), degraded: false };
  }

  try {
    const row = await env.DB.prepare(
      "SELECT COALESCE(SUM(est_cost_usd_micros),0) AS m FROM llm_call_log WHERE day = ? AND status != 'blocked'"
    )
      .bind(day)
      .first();
    capCache = { day, micros: Number(row?.m || 0), checkedAt: now };
    markHealthy();
    // The stored sum can under-report: logCall swallows its own failures. Take
    // whichever ledger is higher so a lost write cannot buy extra budget.
    return { micros: Math.max(capCache.micros, floor), degraded: false };
  } catch (err) {
    markDegraded(`spend ledger query failed: ${err?.message || err}`);
    return { micros: floor, degraded: true };
  }
}

async function ensureLogTable(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(CAP_TABLE.replace(/\s+/g, " "));
  } catch {
    /* table probably exists */
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

/**
 * Where the day's budget stands, for callers that are about to QUEUE billed
 * work rather than perform it.
 *
 * `brain refit` re-splits chunks and queues them for embedding. The embedding
 * happens later, in the drain, and it is billed to the client's own Cloudflare
 * account either way. Enqueueing against a budget that is already spent would
 * route around the cap by deferring it, so the refit asks first.
 *
 * `degraded` is passed through rather than smoothed: when the ledger cannot be
 * read, this is what THIS isolate knows it has spent, and a caller that treats
 * that as authoritative is claiming more than the guard can prove.
 */
export async function spendBudgetStatus(env) {
  const capUsd = capUsdFor(env);
  const { micros, degraded } = await readSpend(env);
  const budgetUsd = degraded ? degradedBudgetUsd(capUsd) : capUsd;
  return {
    cap_usd: capUsd,
    budget_usd: budgetUsd,
    spent_usd: Number((micros / 1e6).toFixed(4)),
    degraded,
    degraded_reason: degraded ? guardState.reason : null,
    over_cap: micros >= budgetUsd * 1e6,
  };
}

export async function callLLM(env, { model, system, messages, max_tokens, label, timeoutMs }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey && !env.AI) {
    const e = new Error("no LLM key configured");
    e.no_key = true;
    throw e;
  }

  await ensureLogTable(env);

  const capUsd = capUsdFor(env);
  const { micros: spent, degraded } = await readSpend(env);
  const budgetUsd = degraded ? degradedBudgetUsd(capUsd) : capUsd;
  if (spent >= budgetUsd * 1_000_000) {
    await logCall(env, { label, model, status: "blocked", micros: 0 });
    const e = new Error(
      degraded
        ? `LLM spend guard is degraded (${guardState.reason}); the reduced ` +
          `allowance of $${budgetUsd} for this instance is already spent. ` +
          `Refusing rather than spending without a working cap.`
        : `daily LLM spend cap of $${capUsd} reached`,
    );
    e.llm_cap_exceeded = true;
    if (degraded) {
      e.spend_guard_degraded = true;
      console.warn(`[spend-guard] BLOCKED a call while degraded: ${guardState.reason}`);
    }
    throw e;
  }

  // Route by the CONFIGURED MODEL, never by which key happens to be present.
  // A manifest that selects a Cloudflare model must reach Cloudflare, even on an
  // install that also carries an Anthropic key for reranking. Branching on the
  // key alone silently promoted Anthropic from "reranking only" to "every
  // answer", so a client's document text reached a provider their own manifest
  // did not name. That is a custody claim, not a preference.
  const modelIsCloudflare = !model || String(model).startsWith("@cf/");
  if (!apiKey || (modelIsCloudflare && env.AI)) {
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
      chargeIsolate(micros);
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

  if (modelIsCloudflare) {
    // A Cloudflare model is configured but this worker has no AI binding to
    // serve it. Quietly answering from Anthropic instead would move client
    // document text to a provider the manifest does not name. Refuse and say so.
    const e = new Error(
      `the configured answer model ${model || "(default)"} is a Cloudflare model, ` +
        "but this worker has no AI binding. Refusing to answer from a different " +
        "provider than the manifest names.",
    );
    e.provider_mismatch = true;
    throw e;
  }
  const anthropicModel = model;
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
  chargeIsolate(micros);
  await logCall(env, { label, model: data?.model || anthropicModel, status: "ok", micros });
  return data;
}
