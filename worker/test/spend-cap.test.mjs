import assert from "node:assert/strict";
import { callLLM, spendGuardStatus } from "../src/lib/core.js";

/* Issue #5. The spend check used to catch its own D1 error and return 0, marked
   "fail open". A database hiccup therefore reported zero spend and the cap
   stopped binding. A cap that fails open is not a cap, it is a hope, and on a
   client-owned install the payment method behind it is the client's.

   The property under test, and the only one that matters: WHEN THE SPEND QUERY
   IS BROKEN, UNBOUNDED SPENDING IS IMPOSSIBLE. The guard degrades to a small
   allowance rather than refusing outright, so a blip does not look like an
   outage, but the allowance still binds and a runaway loop stops.

   Fully offline: a stub AI binding and stub D1, no network, no wall-clock waits.

   Order is load-bearing. core.js keeps the guard's ledger in module scope, and
   the ledger only ever grows within a process, so these blocks run in the one
   sequence that exercises every branch. */

const CF = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

let aiCalls = 0;
// completion tokens are billed at 2.25 micros each by the estimator in core.js
const ai = (completion_tokens = 0) => ({
  run: async () => {
    aiCalls++;
    return { response: "ok", usage: { prompt_tokens: 0, completion_tokens } };
  },
});

/* D1 whose SPEND QUERY throws while writes still work. That is the exact shape
   of the reported defect: the ledger read is broken, nothing else is. */
const brokenReadDb = () => ({
  exec: async () => {},
  prepare: (sql) => ({
    bind: () => ({
      run: async () => ({}),
      first: async () => {
        if (/est_cost_usd_micros/.test(sql) && /SUM/i.test(sql)) {
          throw new Error("D1_ERROR: network connection lost");
        }
        return {};
      },
    }),
  }),
});

/* A healthy D1 that reports no stored spend for today. */
const healthyDb = () => ({
  exec: async () => {},
  prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => ({ m: 0 }) }) }),
});

const call = (env, model = CF) =>
  callLLM(env, { model, system: "s", messages: [], label: "spend-cap-test" });

// Capture the guard's warnings so the test can prove the failure is visible
// rather than silent, and so the suite output stays clean.
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(" "));

try {
  /* ---- 1. a broken ledger degrades the guard, and says so, without an outage */

  // cap $0.01 => 10_000 micros full budget, 1_000 micros while degraded.
  const capped = (db, tokens) => ({ DB: db, AI: ai(tokens), DAILY_LLM_CAP_USD: "0.01" });

  const first = await call(capped(brokenReadDb(), 1000));
  assert.equal(first.provider, "cloudflare-workers-ai",
    "a transient ledger failure must not take the brain offline; the first call still answers");
  assert.equal(aiCalls, 1);

  const degraded = spendGuardStatus();
  assert.equal(degraded.degraded, true, "a failed spend query must put the guard in a degraded state");
  assert.match(degraded.reason, /spend ledger query failed/,
    "the degraded state names its cause instead of hiding it");
  assert.ok(warns.some((w) => /\[spend-guard\] DEGRADED/.test(w)),
    "degradation is announced on the console, not swallowed");

  // The call that just succeeded was charged to the isolate's own ledger, which
  // is what makes the next check possible at all.
  assert.equal(degraded.isolate_spent_micros, 2250,
    "a billed call is recorded in a ledger no database can lose");

  /* ---- 2. THE REGRESSION: with the query still broken, the cap STILL BINDS */

  const callsBeforeBlock = aiCalls;
  await assert.rejects(
    () => call(capped(brokenReadDb(), 1000)),
    (e) => e.llm_cap_exceeded === true && e.spend_guard_degraded === true,
    "past the reduced allowance the guard must refuse, even though the ledger read is broken",
  );
  assert.equal(aiCalls, callsBeforeBlock, "a blocked call must not reach the provider");
  assert.ok(warns.some((w) => /BLOCKED a call while degraded/.test(w)),
    "a block during degradation is announced, so the operator learns the cap is doing work");

  /* ---- 3. THE PROPERTY: a runaway loop cannot spend unbounded money.
     Under the old `return 0 // fail open`, every one of these 40 iterations
     would have been reported as zero spend and would have billed. */

  for (let i = 0; i < 40; i++) {
    await assert.rejects(
      () => call(capped(brokenReadDb(), 1000)),
      (e) => e.llm_cap_exceeded === true,
      `runaway iteration ${i} must be refused while the ledger is unreadable`,
    );
  }
  assert.equal(aiCalls, callsBeforeBlock,
    "40 further attempts against a broken ledger bought exactly zero provider calls");
  assert.equal(spendGuardStatus().isolate_spent_micros, 2250,
    "refusals cost nothing; the ledger did not move");

  /* ---- 4. the degradation is temporary: a working ledger restores the full cap */

  const recovered = await call(capped(healthyDb(), 0));
  assert.equal(recovered.provider, "cloudflare-workers-ai",
    "with the ledger readable again the full cap applies and the same spend is allowed");
  assert.equal(spendGuardStatus().degraded, false, "the guard reports itself healthy again");
  assert.ok(warns.some((w) => /\[spend-guard\] recovered/.test(w)), "recovery is announced too");

  /* ---- 5. a missing D1 binding is the same hole, and is bound the same way */

  await assert.rejects(
    () => call({ AI: ai(0), DAILY_LLM_CAP_USD: "0.01" }),
    (e) => e.llm_cap_exceeded === true && e.spend_guard_degraded === true,
    "with no ledger at all the guard must not assume zero spend",
  );
  assert.match(spendGuardStatus().reason, /no D1 binding/,
    "the no-binding case is reported distinctly from a query failure");

  /* ---- 6. a garbled cap value falls back to the default, never to "no cap".
     `spent >= NaN` is false, so a typo in DAILY_LLM_CAP_USD would otherwise
     remove the cap while looking like a working configuration. */

  // Spend past the $10 default while the ledger is healthy and the cap is high.
  await call({ DB: healthyDb(), AI: ai(5_000_000), DAILY_LLM_CAP_USD: "1000" });
  assert.ok(spendGuardStatus().isolate_spent_micros > 10_000_000,
    "the isolate has now spent more than the $10 default cap");

  await assert.rejects(
    () => call({ DB: healthyDb(), AI: ai(0), DAILY_LLM_CAP_USD: "ten dollars" }),
    (e) => e.llm_cap_exceeded === true && e.spend_guard_degraded === undefined,
    "an unparseable cap falls back to the $10 default and still binds",
  );

  /* ---- 7. the reduced allowance has an absolute ceiling, not just a share.
     The isolate has now spent ~$11.25. A $1000 cap makes the 10% share $100,
     which would wave this through; the $5 ceiling is what actually stops it.
     Routed through the missing-binding path deliberately: that branch degrades
     ahead of the 60s cache window, which a freshly-cached healthy read would
     otherwise skip past. */

  await assert.rejects(
    () => call({ AI: ai(0), DAILY_LLM_CAP_USD: "1000" }),
    (e) => e.llm_cap_exceeded === true && e.spend_guard_degraded === true,
    "a large configured cap must not buy a large allowance while there is no ledger",
  );

  console.log("spend cap: all focused offline tests passed (query failure, runaway loop, recovery, missing binding, garbled cap, degraded ceiling)");
} finally {
  console.warn = origWarn;
}
