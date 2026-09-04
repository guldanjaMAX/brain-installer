import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderSyncError,
  collectOpaquePages,
  parseRetryAfter,
  providerBackoffDelay,
  providerBytes,
  providerJson,
  providerRequest,
  providerSyncResult,
} from "../connectors/provider-sync.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

{
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "worker", "src");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  };
  visit(root);
  const outside = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(path), match[1]);
      if (relative(root, target).startsWith("..")) outside.push(`${relative(root, path)} -> ${match[1]}`);
    }
  }
  check("every Worker module import stays inside cmdDeploy's uploaded source root",
    outside.length === 0, outside.join(", "));
}

{
  const now = Date.parse("2026-08-30T12:00:00Z");
  check("Retry-After accepts numeric seconds", parseRetryAfter("7", { nowMs: now }) === 7_000);
  check("Retry-After accepts an HTTP date",
    parseRetryAfter("Sun, 30 Aug 2026 12:00:09 GMT", { nowMs: now }) === 9_000);
  check("Retry-After rejects malformed values", parseRetryAfter("later", { nowMs: now }) === null);
  check("Retry-After is capped", parseRetryAfter("600", { nowMs: now, maxMs: 30_000 }) === 30_000);
}

{
  const expected = new Uint8Array([0, 1, 2, 250, 255]);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(expected.subarray(0, 2));
      controller.enqueue(expected.subarray(2));
      controller.close();
    },
  });
  const { data } = await providerBytes("fixture", "https://provider.invalid/file", {
    fetchImpl: async () => new Response(stream, { status: 200 }),
    maxResponseBytes: expected.length,
  });
  check("binary provider bodies are returned as bounded Uint8Array data",
    data instanceof Uint8Array && Buffer.from(data).equals(Buffer.from(expected)));

  let error;
  try {
    await providerBytes("fixture", "https://provider.invalid/file", {
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4])),
      maxResponseBytes: 3,
    });
  } catch (caught) { error = caught; }
  check("binary provider downloads fail closed at their streaming byte bound",
    error instanceof ProviderSyncError && error.code === "response_too_large");
}

{
  const first = providerBackoffDelay(1, { baseDelayMs: 100, maxDelayMs: 1_000, randomImpl: () => 0 });
  const fourth = providerBackoffDelay(4, { baseDelayMs: 100, maxDelayMs: 500, randomImpl: () => 1 });
  check("backoff is exponential with deterministic jitter", first === 50 && fourth === 500);
}

{
  let attempts = 0;
  const sleeps = [];
  const { data } = await providerJson("fixture", "https://provider.invalid/data", {
    fetchImpl: async (_url, options) => {
      attempts++;
      check("provider requests refuse automatic redirects", options.redirect === "manual");
      if (attempts < 3) return json({ error: "slow_down" }, 429, { "retry-after": "2" });
      return json({ ok: true });
    },
    randomImpl: () => 0,
    sleepImpl: async (delay) => { sleeps.push(delay); },
  });
  check("rate limits retry inside the attempt bound", attempts === 3 && data.ok === true);
  check("numeric Retry-After is honored with bounded jitter",
    sleeps.length === 2 && sleeps.every((delay) => delay >= 2_000 && delay <= 2_100), JSON.stringify(sleeps));
}

{
  let attempts = 0;
  let slept = false;
  let error;
  try {
    await providerRequest("fixture", "https://provider.invalid/rate-limit", {
      fetchImpl: async () => {
        attempts++;
        return json({ error: "slow_down" }, 429, { "retry-after": "60" });
      },
      deadlineMs: 30_000,
      nowImpl: () => 0,
      randomImpl: () => 0,
      sleepImpl: async () => { slept = true; },
    });
  } catch (caught) { error = caught; }
  check("Retry-After is a true minimum and cannot be shortened past the total deadline",
    attempts === 1 && slept === false && error?.code === "deadline_exceeded");
}

{
  let attempts = 0;
  let error;
  try {
    await providerJson("fixture", "https://provider.invalid/private", {
      fetchImpl: async () => { attempts++; return json({ message: "missing scope" }, 403); },
      sleepImpl: async () => { throw new Error("authorization failures must not sleep"); },
    });
  } catch (caught) { error = caught; }
  check("authorization failures are explicitly unavailable and are not retried",
    error instanceof ProviderSyncError && error.outcome.kind === "unavailable" && attempts === 1);
}

{
  let sawAbort = false;
  let error;
  try {
    await providerRequest("fixture", "https://provider.invalid/hang", {
      maxAttempts: 1,
      attemptTimeoutMs: 50,
      fetchImpl: async (_url, { signal }) => await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          const aborted = new Error("aborted by test clock");
          aborted.name = "AbortError";
          reject(aborted);
        }, { once: true });
      }),
      setTimeoutImpl(callback) {
        queueMicrotask(callback);
        return { unref() {} };
      },
      clearTimeoutImpl() {},
    });
  } catch (caught) { error = caught; }
  check("attempt deadlines abort the in-flight fetch",
    sawAbort && error instanceof ProviderSyncError && error.code === "timeout" && error.outcome.kind === "retryable");
}

{
  let now = 0;
  let error;
  try {
    await providerRequest("fixture", "https://provider.invalid/down", {
      deadlineMs: 100,
      attemptTimeoutMs: 100,
      maxAttempts: 5,
      baseDelayMs: 80,
      maxDelayMs: 1_000,
      randomImpl: () => 0,
      nowImpl: () => now,
      fetchImpl: async () => json({ error: "down" }, 503),
      sleepImpl: async (delay) => { now += delay; },
    });
  } catch (caught) { error = caught; }
  check("the overall deadline prevents another unsafe retry",
    error instanceof ProviderSyncError && error.code === "deadline_exceeded" && error.outcome.kind === "retryable");
}

{
  const tooLarge = "x".repeat(65);
  let error;
  try {
    await providerJson("fixture", "https://provider.invalid/large", {
      fetchImpl: async () => new Response(tooLarge, { status: 200 }),
      maxResponseBytes: 64,
    });
  } catch (caught) { error = caught; }
  check("provider response bodies are byte bounded",
    error instanceof ProviderSyncError && error.code === "response_too_large");
}

{
  let error;
  try {
    await collectOpaquePages({
      provider: "fixture",
      initialUrl: "https://provider.invalid/page?cursor=one",
      fetchImpl: async () => json({ next: "https://provider.invalid/page?cursor=one" }),
      nextUrl: (data) => data.next,
    });
  } catch (caught) { error = caught; }
  check("a repeated opaque cursor is a retryable interruption",
    error instanceof ProviderSyncError && error.code === "pagination_loop" && error.outcome.kind === "retryable");
}

{
  const partial = providerSyncResult({
    provider: "fixture",
    documents: [{ source_id: "one" }],
    deletionAuthority: "unavailable",
  });
  const unavailable = providerSyncResult({
    provider: "fixture",
    complete: false,
    outcomeKind: "unavailable",
    reason: "authorization authority could not be read",
  });
  check("partial provider results cannot advance a cursor",
    partial.outcome.kind === "partial" && partial.cursor_can_advance === false);
  check("unavailable provider results remain distinct from healthy empty",
    unavailable.outcome.kind === "unavailable" && unavailable.cursor_can_advance === false);
}

console.log(`\nprovider sync safety: all ${ran} checks passed`);
