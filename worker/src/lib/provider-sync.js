/**
 * Shared safety contract for provider API connectors.
 *
 * Provider calls are bounded by an overall deadline and a per-attempt timeout.
 * Only explicitly retryable transport and HTTP failures are retried, and every
 * retry stays inside both the attempt limit and the deadline. Provider cursors
 * are opaque, but they still have to make progress: repeating one is a
 * retryable interruption, never a completed empty page.
 */

import { ingestionOutcome } from "./ingestion-outcome.js";

export const PROVIDER_HTTP_DEFAULTS = Object.freeze({
  deadlineMs: 30_000,
  attemptTimeoutMs: 10_000,
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
  maxResponseBytes: 8 * 1024 * 1024,
});

const RETRYABLE_STATUS = new Set([408, 425, 429]);
const clean = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

function finiteInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function boundedProviderText(value, max = 240) {
  return clean(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[redacted]")
    .slice(0, max);
}

export class ProviderSyncError extends Error {
  constructor(provider, message, {
    kind = "unavailable",
    status = null,
    code = null,
    retryAfterSeconds = null,
    attempts = 1,
    cause,
  } = {}) {
    super(`${provider}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "ProviderSyncError";
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.retry_after_seconds = retryAfterSeconds;
    this.attempts = attempts;
    this.outcome = ingestionOutcome(kind, { reason: message });
  }
}

export function parseRetryAfter(value, {
  nowMs = Date.now(),
  maxMs = PROVIDER_HTTP_DEFAULTS.maxRetryAfterMs,
} = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let milliseconds;
  if (/^\d+(?:\.\d+)?$/.test(raw)) milliseconds = Number(raw) * 1000;
  else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    milliseconds = Math.max(0, at - nowMs);
  }
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.min(Math.floor(milliseconds), finiteInteger(maxMs, PROVIDER_HTTP_DEFAULTS.maxRetryAfterMs));
}

export function providerBackoffDelay(attempt, {
  baseDelayMs = PROVIDER_HTTP_DEFAULTS.baseDelayMs,
  maxDelayMs = PROVIDER_HTTP_DEFAULTS.maxDelayMs,
  retryAfterMs = null,
  randomImpl = Math.random,
} = {}) {
  const base = finiteInteger(baseDelayMs, PROVIDER_HTTP_DEFAULTS.baseDelayMs, { min: 1 });
  const cap = finiteInteger(maxDelayMs, PROVIDER_HTTP_DEFAULTS.maxDelayMs, { min: 1 });
  const exponent = Math.min(30, Math.max(0, finiteInteger(attempt, 1, { min: 1 }) - 1));
  const exponential = Math.min(cap, base * (2 ** exponent));
  const random = Math.min(1, Math.max(0, Number(randomImpl?.()) || 0));
  const jittered = Math.floor(exponential * (0.5 + (random * 0.5)));
  if (retryAfterMs === null || retryAfterMs === undefined) return jittered;
  // Retry-After is a minimum requested by the provider. A small jitter avoids
  // every connector waking on the same millisecond without defeating it.
  return Math.max(0, Math.floor(retryAfterMs)) + Math.floor(jittered * 0.1);
}

function abortError(code) {
  const error = new Error(code === "deadline_exceeded" ? "provider deadline exceeded" : "provider request aborted");
  error.name = "AbortError";
  error.provider_code = code;
  return error;
}

async function defaultSleep(milliseconds, { signal, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (milliseconds <= 0) return;
  await new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, value) => {
      if (timer !== undefined) clearTimeoutImpl(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError("aborted"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeoutImpl(() => finish(resolve), milliseconds);
  });
}

async function fetchAttempt(fetchImpl, url, init, {
  timeoutMs,
  signal,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const onExternalAbort = () => controller.abort(signal?.reason || abortError("aborted"));
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener?.("abort", onExternalAbort, { once: true });

  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(abortError(timedOut ? "deadline_exceeded" : "aborted"));
    }, { once: true });
  });
  timer = setTimeoutImpl(() => {
    timedOut = true;
    controller.abort(abortError("deadline_exceeded"));
  }, timeoutMs);
  timer?.unref?.();

  try {
    return await Promise.race([
      Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal })),
      aborted,
    ]);
  } finally {
    clearTimeoutImpl(timer);
    signal?.removeEventListener?.("abort", onExternalAbort);
  }
}

function retryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

async function readBoundedBytes(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  if (!response.body.getReader) {
    throw new ProviderSyncError("provider", "the provider response was not safely streamable", {
      kind: "retryable", status: response.status, code: "response_not_streamable",
    });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      size += bytes.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ProviderSyncError("provider", "the provider response exceeded the safe byte limit", {
          kind: "retryable", status: response.status, code: "response_too_large",
        });
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readBoundedText(response, maxBytes) {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

function responseFailure(provider, response, raw, attempts, nowMs, maxRetryAfterMs) {
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* bounded text below */ }
  const detail = boundedProviderText(
    data?.error_description || data?.message || data?.error?.message || data?.error || raw || `HTTP ${response.status}`,
  );
  const code = boundedProviderText(
    data?.code || data?.error?.code || data?.error?.status || `http_${response.status}`,
    80,
  );
  const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), {
    nowMs,
    maxMs: maxRetryAfterMs,
  });
  if (retryableStatus(response.status)) {
    return new ProviderSyncError(provider,
      response.status === 429 ? "the provider rate limit was reached" : "the provider is temporarily unavailable", {
        kind: "retryable",
        status: response.status,
        code,
        retryAfterSeconds: retryAfterMs === null ? null : retryAfterMs / 1000,
        attempts,
      });
  }
  if (response.status === 401 || response.status === 403) {
    return new ProviderSyncError(provider, "the connection is missing, expired, or lacks permission", {
      kind: "unavailable", status: response.status, code, attempts,
    });
  }
  return new ProviderSyncError(provider, detail || "the provider refused the request", {
    kind: "refused", status: response.status, code, attempts,
  });
}

/**
 * Fetch one provider response with bounded retries and no automatic redirects.
 *
 * The returned response body has not been consumed. Use this low-level form
 * only for status-only calls; data callers must use providerJson, providerText,
 * or providerBytes so successful bodies also pass a streaming byte bound.
 * Error response bodies are always read through that bound here.
 */
export async function providerRequest(provider, url, {
  fetchImpl = fetch,
  method = "GET",
  accessToken = null,
  headers = {},
  body = undefined,
  signal = null,
  deadlineMs = PROVIDER_HTTP_DEFAULTS.deadlineMs,
  attemptTimeoutMs = PROVIDER_HTTP_DEFAULTS.attemptTimeoutMs,
  maxAttempts = PROVIDER_HTTP_DEFAULTS.maxAttempts,
  baseDelayMs = PROVIDER_HTTP_DEFAULTS.baseDelayMs,
  maxDelayMs = PROVIDER_HTTP_DEFAULTS.maxDelayMs,
  maxRetryAfterMs = PROVIDER_HTTP_DEFAULTS.maxRetryAfterMs,
  maxResponseBytes = PROVIDER_HTTP_DEFAULTS.maxResponseBytes,
  randomImpl = Math.random,
  nowImpl = Date.now,
  sleepImpl = defaultSleep,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const attemptsLimit = finiteInteger(maxAttempts, PROVIDER_HTTP_DEFAULTS.maxAttempts, { min: 1, max: 10 });
  const totalBudget = finiteInteger(deadlineMs, PROVIDER_HTTP_DEFAULTS.deadlineMs, { min: 1 });
  const perAttempt = finiteInteger(attemptTimeoutMs, PROVIDER_HTTP_DEFAULTS.attemptTimeoutMs, { min: 1 });
  const responseLimit = finiteInteger(maxResponseBytes, PROVIDER_HTTP_DEFAULTS.maxResponseBytes, { min: 1 });
  const deadlineAt = nowImpl() + totalBudget;
  const requestBody = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
  const init = {
    method,
    redirect: "manual",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    ...(requestBody === undefined ? {} : { body: requestBody }),
  };

  let lastError = null;
  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    const remaining = deadlineAt - nowImpl();
    if (remaining <= 0 || signal?.aborted) {
      throw new ProviderSyncError(provider, signal?.aborted ? "the provider request was cancelled" : "the provider deadline was exceeded", {
        kind: "retryable", code: signal?.aborted ? "aborted" : "deadline_exceeded", attempts: attempt - 1,
      });
    }

    let response;
    try {
      response = await fetchAttempt(fetchImpl, url, init, {
        timeoutMs: Math.min(perAttempt, remaining),
        signal,
        setTimeoutImpl,
        clearTimeoutImpl,
      });
    } catch (error) {
      const code = error?.provider_code === "deadline_exceeded" || error?.name === "AbortError"
        ? (signal?.aborted ? "aborted" : "timeout")
        : "transport_error";
      lastError = new ProviderSyncError(provider,
        code === "aborted" ? "the provider request was cancelled" : "the provider could not be reached", {
          kind: "retryable", code, attempts: attempt, cause: error,
        });
      if (attempt >= attemptsLimit || signal?.aborted) throw lastError;
    }

    let retryAfterMs = null;
    if (response) {
      if (response.ok) return response;
      let raw = "";
      try {
        raw = await readBoundedText(response, responseLimit);
      } catch (error) {
        if (error instanceof ProviderSyncError) {
          const message = error.code === "response_not_streamable"
            ? "the provider response was not safely streamable"
            : "the provider response exceeded the safe byte limit";
          lastError = new ProviderSyncError(provider, message, {
            kind: error.outcome.kind,
            status: response.status,
            code: error.code,
            attempts: attempt,
            cause: error,
          });
        } else {
          lastError = new ProviderSyncError(provider, "the provider response could not be read", {
            kind: "retryable", status: response.status, code: "response_read_error", attempts: attempt, cause: error,
          });
        }
      }
      if (!lastError || lastError.attempts !== attempt) {
        lastError = responseFailure(provider, response, raw, attempt, nowImpl(), maxRetryAfterMs);
      }
      retryAfterMs = lastError.retry_after_seconds === null ? null : lastError.retry_after_seconds * 1000;
      if (lastError.outcome.kind !== "retryable" || attempt >= attemptsLimit) throw lastError;
    }

    const delay = providerBackoffDelay(attempt, {
      baseDelayMs, maxDelayMs, retryAfterMs, randomImpl,
    });
    if (delay >= deadlineAt - nowImpl()) {
      throw new ProviderSyncError(provider, "the provider deadline was exceeded before another safe retry", {
        kind: "retryable", code: "deadline_exceeded", attempts: attempt, cause: lastError,
      });
    }
    await sleepImpl(delay, { signal, setTimeoutImpl, clearTimeoutImpl });
  }
  throw lastError;
}

export async function providerJson(provider, url, options = {}) {
  const response = await providerRequest(provider, url, options);
  const maxBytes = finiteInteger(
    options.maxResponseBytes,
    PROVIDER_HTTP_DEFAULTS.maxResponseBytes,
    { min: 1 },
  );
  const raw = await readBoundedText(response, maxBytes);
  if (!raw) return { data: {}, response };
  try {
    return { data: JSON.parse(raw), response };
  } catch (error) {
    throw new ProviderSyncError(provider, "the provider returned an unreadable response", {
      kind: "retryable", status: response.status, code: "invalid_json", attempts: 1, cause: error,
    });
  }
}

/** Read a successful provider response through the same byte bound as errors. */
export async function providerText(provider, url, options = {}) {
  const response = await providerRequest(provider, url, options);
  const maxBytes = finiteInteger(
    options.maxResponseBytes,
    PROVIDER_HTTP_DEFAULTS.maxResponseBytes,
    { min: 1 },
  );
  return { data: await readBoundedText(response, maxBytes), response };
}

/** Read a successful binary provider response through a streaming byte bound. */
export async function providerBytes(provider, url, options = {}) {
  const response = await providerRequest(provider, url, options);
  const maxBytes = finiteInteger(
    options.maxResponseBytes,
    PROVIDER_HTTP_DEFAULTS.maxResponseBytes,
    { min: 1 },
  );
  return { data: await readBoundedBytes(response, maxBytes), response };
}

export function providerEnvelope(provider, id, {
  title,
  content,
  occurredAt = null,
  uri = null,
  metadata = {},
} = {}) {
  const sourceId = clean(id);
  const text = clean(content);
  if (!sourceId) throw new TypeError(`${provider} document identity is empty`);
  if (!text) throw new TypeError(`${provider} document ${sourceId} has no content`);
  return {
    source_type: provider,
    source_id: sourceId,
    title: clean(title).slice(0, 200) || `${provider} record`,
    content: text,
    occurred_at: occurredAt || null,
    date_source: occurredAt ? `${provider}:provider_timestamp` : "none",
    date_reliable: Boolean(occurredAt),
    uri: uri || null,
    metadata: { category: provider, provider, ...metadata },
  };
}

export function providerSyncResult({
  provider,
  documents = [],
  deletions = [],
  warnings = [],
  proposedCursor = null,
  deletionAuthority = "authoritative",
  complete = true,
  reason = null,
  outcomeKind = null,
} = {}) {
  const partial = !complete || warnings.length > 0 || deletionAuthority !== "authoritative";
  const kind = outcomeKind || (partial ? "partial" : "completed");
  if (!["completed", "partial", "retryable", "unavailable", "refused"].includes(kind)) {
    throw new TypeError(`unsupported provider outcome ${kind}`);
  }
  const outcome = ingestionOutcome(kind, {
    reason: reason || (kind === "partial" ? warnings[0] || `${provider} deletion authority is ${deletionAuthority}` : null),
  });
  return Object.freeze({
    provider,
    documents,
    deletions,
    warnings,
    deletion_authority: deletionAuthority,
    proposed_cursor: proposedCursor,
    cursor_can_advance: outcome.kind === "completed",
    outcome,
  });
}

export function createPaginationGuard(provider, { maxPages = 10_000 } = {}) {
  const limit = finiteInteger(maxPages, 10_000, { min: 1, max: 100_000 });
  const seen = new Set();
  let pages = 0;
  return Object.freeze({
    visit(cursor) {
      const key = typeof cursor === "string" ? cursor : JSON.stringify(cursor);
      if (!key) throw new ProviderSyncError(provider, "the provider returned an empty pagination cursor", {
        kind: "retryable", code: "empty_cursor",
      });
      if (seen.has(key)) throw new ProviderSyncError(provider, "the provider repeated a pagination cursor", {
        kind: "retryable", code: "pagination_loop",
      });
      if (pages >= limit) throw new ProviderSyncError(provider, "the provider exceeded the bounded page limit", {
        kind: "retryable", code: "page_limit",
      });
      seen.add(key);
      pages++;
      return pages;
    },
    get pages() { return pages; },
  });
}

export async function collectOpaquePages({
  provider,
  initialUrl,
  accessToken,
  fetchImpl,
  nextUrl,
  maxPages = 10_000,
  requestOptions = {},
}) {
  const pages = [];
  const guard = createPaginationGuard(provider, { maxPages });
  let url = initialUrl;
  while (url) {
    guard.visit(url);
    const { data } = await providerJson(provider, url, {
      accessToken,
      fetchImpl,
      ...requestOptions,
    });
    pages.push(data);
    url = nextUrl(data, url) || null;
  }
  return pages;
}

export function renderRecord(label, value) {
  const rows = Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== "");
  return [label, ...rows.map(([key, item]) => `${key.replace(/_/g, " ")}: ${typeof item === "object" ? JSON.stringify(item) : item}`)].join("\n");
}
