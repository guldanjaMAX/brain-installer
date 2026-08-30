// core.js — HTTP helpers, auth, and the LLM call with its spend budget.
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
export function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Prevent browser, proxy, and edge caches from retaining private answers.
 *
 *  Lives here rather than in index.js because lib modules serve private data
 *  too, and a second copy is how two cache policies drift apart. */
export function privateNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  // Session-authenticated routes vary on the cookie as well. The no-store
  // above already settles it; this keeps the header honest for any
  // intermediary that heeds Vary and ignores Cache-Control.
  headers.set("Vary", "X-Admin-Key, Cookie");
  return new Response(response.body, { status: response.status, headers });
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

let guardState = { degraded: false, reason: null, since: null };

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

function markDegraded(reason) {
  if (!guardState.degraded || guardState.reason !== reason) {
    console.warn(`[spend-budget] UNAVAILABLE: ${reason}. Provider call refused before spend.`);
    guardState = { degraded: true, reason, since: new Date().toISOString() };
  }
}

function markHealthy() {
  if (guardState.degraded) {
    console.warn("[spend-budget] recovered: atomic reservations are available again.");
    guardState = { degraded: false, reason: null, since: null };
  }
}

/** Read-only view of the guard, for health reporting and tests. */
export function spendGuardStatus() {
  return {
    mode: "atomic-estimated-spend-reservation",
    degraded: guardState.degraded,
    reason: guardState.reason,
    since: guardState.since,
  };
}

async function ensureLogTable(env) {
  if (!env.DB) throw new Error("no D1 binding is available for atomic spend reservation");
  await env.DB.exec(CAP_TABLE.replace(/\s+/g, " "));
}

async function reserveSpend(env, { label, model, micros }) {
  const now = new Date().toISOString();
  try {
    await ensureLogTable(env);
    const capMicros = Math.floor(capUsdFor(env) * 1_000_000);
    const row = await env.DB.prepare(
      `INSERT INTO llm_call_log
         (ts, day, label, model, status, est_cost_usd_micros)
       SELECT ?, ?, ?, ?, 'reserved', ?
       WHERE ? <= ?
         AND COALESCE((
           SELECT SUM(est_cost_usd_micros)
           FROM llm_call_log
           WHERE day = ? AND status != 'blocked'
         ), 0) + ? <= ?
       RETURNING id`,
      )
      .bind(
        now, now.slice(0, 10), label || null, model || null, micros,
        micros, capMicros, now.slice(0, 10), micros, capMicros,
      )
      .first();
    markHealthy();
    if (!row?.id) {
      const error = new Error(
        `daily estimated LLM spend budget of $${capUsdFor(env)} cannot reserve this request`,
      );
      error.llm_cap_exceeded = true;
      error.llm_budget_exceeded = true;
      throw error;
    }
    return Number(row.id);
  } catch (error) {
    if (error?.llm_budget_exceeded) throw error;
    const reason = `atomic spend reservation failed: ${error?.message || error}`;
    markDegraded(reason);
    const refused = new Error(`${reason}. Refusing to call the provider without a reservation.`);
    refused.spend_guard_unavailable = true;
    throw refused;
  }
}

async function settleSpend(env, reservationId, { status, micros }) {
  try {
    const result = await env.DB.prepare(
      `UPDATE llm_call_log
       SET status = ?, est_cost_usd_micros = ?
       WHERE id = ? AND status = 'reserved'`,
    ).bind(status, micros, reservationId).run();
    const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
    if (changes === 0) throw new Error("reservation row was not updated");
  } catch (error) {
    // The original conservative reservation remains counted. Never release
    // budget merely because the receipt write failed.
    markDegraded(`spend reservation settlement failed: ${error?.message || error}`);
  }
}

/**
 * Per-model Workers AI rates, in dollars per million tokens.
 *
 * A single hard-coded pair used to price every Workers AI call at the answer
 * model's rate. That is wrong in both directions, and for OCR it is wrong in
 * the direction that matters: gemma-4 costs $0.10/$0.30 against llama's
 * $0.293/$2.25, so charging OCR at llama rates overstates its spend roughly 3x
 * on input and 7.5x on output. The cap would then stop a run that had spent a
 * fraction of the budget, and the owner would be told they had hit a limit
 * they were nowhere near.
 *
 * Prefix-matched, longest first, so a family rate covers its variants. Read
 * from the published Workers AI model pages on 2026-08-28.
 */
const WORKERS_AI_RATES = [
  ["@cf/google/gemma-4", { in: 0.1, out: 0.3 }],
  ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", { in: 0.293, out: 2.25 }],
];

// The default is the most expensive rate we know, not the cheapest. An unknown
// model priced optimistically would let the cap fail quiet.
const WORKERS_AI_FALLBACK_RATE = { in: 0.293, out: 2.25 };

export function workersAiRate(model) {
  const id = String(model || "");
  let best = null;
  for (const [prefix, rate] of WORKERS_AI_RATES) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, rate };
  }
  return best ? best.rate : WORKERS_AI_FALLBACK_RATE;
}

const ANTHROPIC_ESTIMATED_RATE = { in: 3, out: 15 };

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || "")).byteLength;
}

/**
 * Conservative pre-call reservation, in estimated USD micros.
 *
 * UTF-8 bytes are an upper bound on ordinary text token count. The serialized
 * image is base64, so counting its bytes is conservative too. Provider prices
 * can change outside this repository, therefore this is deliberately named an
 * estimated-spend budget rather than advertised as an invoice-exact ceiling.
 */
export function estimateLlmReservationMicros({ provider, model, system, messages, image, maxTokens }) {
  const inputBytes = utf8Bytes(JSON.stringify({ system: system || "", messages: messages || [], image: image || "" }));
  const outputTokens = Math.max(1, Math.floor(Number(maxTokens) || 1000));
  const rate = provider === "anthropic" ? ANTHROPIC_ESTIMATED_RATE : workersAiRate(model);
  return Math.max(1, Math.ceil(inputBytes * rate.in + outputTokens * rate.out));
}

/**
 * How an image is attached to a Workers AI chat request.
 *
 * STATED PLAINLY: this shape is NOT verified against a live account in this
 * build. Cloudflare's model page for the OCR model lists Vision as a
 * capability and publishes its prices, but its usage examples are text-only
 * and it does not document the image field. Two shapes exist in the wild — the
 * OpenAI-compatible content array with `image_url`, which is what an
 * instruction-tuned chat model reached through `messages` accepts, and the
 * older top-level `image` field used by llama-3.2-vision.
 *
 * Rather than guess once and fail silently, the shape is a named switch. The
 * default is the content array; `OCR_IMAGE_FORMAT=image_field` selects the
 * other. The OCR route reports which shape it sent and returns the provider's
 * own error verbatim, so a wrong guess costs one call and one variable rather
 * than a debugging session.
 */
export function visionMessages(system, messages, image, env = {}) {
  const dataUrl = `data:image/png;base64,${image}`;
  const text = (messages || []).map((m) => m?.content).filter((c) => typeof c === "string").join("\n\n");

  if (env.OCR_IMAGE_FORMAT === "image_field") {
    return [
      { role: "system", content: system },
      { role: "user", content: text, image: dataUrl },
    ];
  }
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
}

export async function callLLM(env, { model, system, messages, max_tokens, label, timeoutMs, image }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey && !env.AI) {
    const e = new Error("no LLM key configured");
    e.no_key = true;
    throw e;
  }

  // An image is a page of the client's own scanned document. It has exactly one
  // legal destination: the Workers AI binding inside their own Cloudflare
  // account. There is no Anthropic branch for it and there is no default-model
  // fallback, because either would move a picture of their bank statement to a
  // provider their manifest does not name. This is a custody claim, so it
  // refuses rather than degrades.
  if (image !== undefined) {
    if (!String(model || "").startsWith("@cf/")) {
      const e = new Error(
        `OCR must run on a Cloudflare model inside this account; ${model || "(no model)"} is not one. ` +
        "Refusing to send a page of a scanned document anywhere else.",
      );
      e.provider_mismatch = true;
      throw e;
    }
    if (!env.AI) {
      const e = new Error(
        "OCR needs this worker's own Workers AI binding, and there is none. " +
        "Refusing to send a page of a scanned document to another provider.",
      );
      e.provider_mismatch = true;
      throw e;
    }
  }

  // Route by the CONFIGURED MODEL, never by which key happens to be present.
  // A manifest that selects a Cloudflare model must reach Cloudflare, even on an
  // install that also carries an Anthropic key for reranking. Branching on the
  // key alone silently promoted Anthropic from "reranking only" to "every
  // answer", so a client's document text reached a provider their own manifest
  // did not name. That is a custody claim, not a preference.
  const modelIsCloudflare = !model || String(model).startsWith("@cf/");
  if (modelIsCloudflare && !env.AI) {
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

  const useWorkers = !apiKey || modelIsCloudflare;
  const maxTokens = Math.max(1, Math.floor(Number(max_tokens) || 1000));
  const workersModel = String(model || "").startsWith("@cf/")
    ? model
    : env.WORKERS_AI_ANSWER_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const billedModel = useWorkers ? workersModel : model;
  const provider = useWorkers ? "cloudflare-workers-ai" : "anthropic";
  const reservedMicros = estimateLlmReservationMicros({
    provider: useWorkers ? "workers-ai" : "anthropic",
    model: billedModel,
    system,
    messages,
    image,
    maxTokens,
  });
  const reservationId = await reserveSpend(env, { label, model: billedModel, micros: reservedMicros });

  if (useWorkers) {
    try {
      const data = await env.AI.run(workersModel, {
        messages: image === undefined
          ? [{ role: "system", content: system }, ...(messages || [])]
          : visionMessages(system, messages, image, env),
        max_tokens: maxTokens,
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
      // Priced by the model actually called, per WORKERS_AI_RATES. Keep the
      // estimate conservative enough for the guard to remain useful.
      const rate = workersAiRate(workersModel);
      const hasUsage = Number.isFinite(Number(inTok)) && Number.isFinite(Number(outTok)) && (inTok > 0 || outTok > 0);
      const micros = hasUsage ? Math.ceil(inTok * rate.in + outTok * rate.out) : reservedMicros;
      if (micros > reservedMicros) {
        console.warn(`[spend-budget] provider usage estimate ${micros} exceeded reservation ${reservedMicros}`);
      }
      await settleSpend(env, reservationId, { status: hasUsage ? "ok" : "ok-reserved", micros });
      return {
        content: [{ type: "text", text }],
        model: workersModel,
        usage: data?.usage || {},
        provider: "cloudflare-workers-ai",
      };
    } catch (error) {
      await settleSpend(env, reservationId, { status: "error-reserved", micros: reservedMicros });
      throw new Error(`Workers AI: ${error?.message || error}`);
    }
  }

  const anthropicModel = model;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: anthropicModel, max_tokens: maxTokens, system, messages }),
      signal: AbortSignal.timeout(timeoutMs || 45_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const inTok = data?.usage?.input_tokens || 0;
    const outTok = data?.usage?.output_tokens || 0;
    const hasUsage = Number.isFinite(Number(inTok)) && Number.isFinite(Number(outTok)) && (inTok > 0 || outTok > 0);
    const micros = hasUsage ? Math.round(inTok * 3 + outTok * 15) : reservedMicros;
    if (micros > reservedMicros) {
      console.warn(`[spend-budget] provider usage estimate ${micros} exceeded reservation ${reservedMicros}`);
    }
    await settleSpend(env, reservationId, { status: hasUsage ? "ok" : "ok-reserved", micros });
    return data;
  } catch (error) {
    await settleSpend(env, reservationId, { status: "error-reserved", micros: reservedMicros });
    throw error;
  }
}
