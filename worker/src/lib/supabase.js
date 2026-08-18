// lib/supabase.js — Supabase PostgREST RPC client and the embedding helper.

async function embedText(env, text) {
  const input = (text || "").slice(0, 8e3);
  // One retry with a short backoff. Workers AI embedding failures are almost
  // always transient (cold start / occasional 5xx); a single retry turns most
  // of them into a success instead of bubbling a hard error to search/ingest.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: input });
      if (result && result.data && result.data[0]) return result.data[0];
      lastErr = new Error("Workers AI returned no embedding");
    } catch (e) {
      lastErr = e;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
  }
  throw lastErr || new Error("Workers AI returned no embedding");
}

async function supabaseRpc(env, fnName, args, opts) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${fnName}`;
  // Bound every RPC so a hung Supabase connection can't stall the worker until
  // the platform kills the whole invocation. Default is deliberately generous
  // (catches true hangs, not slow-but-working calls); override per call site
  // with opts.timeoutMs, or globally with env.SUPABASE_RPC_TIMEOUT_MS.
  const timeoutMs = (opts && opts.timeoutMs) || Number(env.SUPABASE_RPC_TIMEOUT_MS) || 20000;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args || {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`Supabase RPC ${fnName} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase RPC ${fnName} failed: ${res.status} ${text}`);
  }
  // PostgREST returns no body for RETURNS VOID functions. Don't choke on it —
  // return null so callers that don't need the result don't have to wrap the
  // call in try/catch just for a parse error.
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch (_) { return null; }
}

export {
  embedText,
  supabaseRpc
};
