import assert from "node:assert/strict";
import { callLLM, estimateLlmReservationMicros, spendGuardStatus } from "../src/lib/core.js";
import { createProductFixture } from "./product-contract-fixture.mjs";

const CF = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const input = { model: CF, system: "s", messages: [], label: "spend-budget-test" };
const reservation = estimateLlmReservationMicros({
  provider: "workers-ai",
  model: CF,
  system: input.system,
  messages: input.messages,
  maxTokens: 1000,
});

assert.ok(reservation > 2250, "reservation includes output allowance and a conservative input bound");

// A missing or failing ledger must stop before the provider. There is no
// per-isolate fallback because it cannot enforce one budget across isolates.
let callsWithoutLedger = 0;
await assert.rejects(
  () => callLLM(
    { AI: { async run() { callsWithoutLedger++; return { response: "not reached" }; } } },
    input,
  ),
  (error) => error.spend_guard_unavailable === true && /no D1 binding/.test(error.message),
);
assert.equal(callsWithoutLedger, 0, "a request without an atomic reservation never reaches AI");
assert.equal(spendGuardStatus().mode, "atomic-estimated-spend-reservation");
assert.equal(spendGuardStatus().degraded, true);

// Two requests can pass a read-then-check race. The single INSERT SELECT below
// is the regression proof: while one provider call holds its reservation, the
// other is refused even though both requests started together.
{
  let release;
  let entered;
  const enteredProvider = new Promise((resolve) => { entered = resolve; });
  const providerGate = new Promise((resolve) => { release = resolve; });
  let providerCalls = 0;
  const fixture = await createProductFixture({
    env: {
      DAILY_LLM_CAP_USD: String((reservation + 100) / 1_000_000),
      AI: {
        async run() {
          providerCalls++;
          entered();
          await providerGate;
          return { response: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  });
  try {
    const first = callLLM(fixture.env, input);
    await enteredProvider;
    await assert.rejects(
      () => callLLM(fixture.env, input),
      (error) => error.llm_budget_exceeded === true && error.llm_cap_exceeded === true,
      "the second concurrent request cannot spend the first request's reserved budget",
    );
    assert.equal(providerCalls, 1);
    assert.equal(fixture.first("SELECT status FROM llm_call_log").status, "reserved");
    release();
    await first;
    const settled = fixture.first("SELECT status, est_cost_usd_micros AS micros FROM llm_call_log");
    assert.equal(settled.status, "ok");
    assert.equal(settled.micros, 3, "the unused reservation is released after a usage receipt");
    assert.equal(spendGuardStatus().degraded, false, "a successful atomic reservation reports recovery");
  } finally {
    release();
    fixture.close();
  }
}

// Provider errors keep the conservative reservation. Releasing it would let a
// retry loop spend repeatedly when the provider billed the failed requests.
{
  let providerCalls = 0;
  const fixture = await createProductFixture({
    env: {
      DAILY_LLM_CAP_USD: String((reservation + 100) / 1_000_000),
      AI: {
        async run() {
          providerCalls++;
          throw new Error("synthetic provider reset");
        },
      },
    },
  });
  try {
    await assert.rejects(() => callLLM(fixture.env, input), /synthetic provider reset/);
    const failed = fixture.first("SELECT status, est_cost_usd_micros AS micros FROM llm_call_log");
    assert.equal(failed.status, "error-reserved");
    assert.equal(failed.micros, reservation);
    await assert.rejects(
      () => callLLM(fixture.env, input),
      (error) => error.llm_budget_exceeded === true,
    );
    assert.equal(providerCalls, 1, "a failed-call retry cannot reuse its conservative reservation");
  } finally {
    fixture.close();
  }
}

// Invalid configuration falls back to the documented default, never to NaN or
// an unbounded budget.
{
  const fixture = await createProductFixture({
    env: {
      DAILY_LLM_CAP_USD: "ten dollars",
      AI: { async run() { return { response: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } }; } },
    },
  });
  try {
    const answer = await callLLM(fixture.env, input);
    assert.equal(answer.provider, "cloudflare-workers-ai");
  } finally {
    fixture.close();
  }
}

console.log("estimated spend budget: atomic concurrency, fail-closed ledger, conservative error, and config tests passed");
