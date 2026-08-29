// The escape hatch that could not open under the one condition anybody reaches
// for it, from a real run against a live brain with a 131,359 operation backlog.
//
// What the operator actually saw:
//
//   · 400 query-visible, 400 accepted, 131359 to go, ~115/min, about 1143 min left
//   · 400 query-visible, 400 accepted, 131359 to go, ~112/min, about 1173 min left
//   · 400 query-visible, 400 accepted, 131359 to go, ~94/min,  about 1398 min left
//   · another vector drain is finishing; retrying in 941 second(s)
//   fail  the drain reached its 20-minute wall-clock safety limit with 131359
//         vector operation(s) still queued.
//
// Two separate defects, and the second is the one that misled a human.
//
//  1. The standoff. A scheduled drain holds the writer lease. The manual drain
//     is handed a retry hint derived from the lease EXPIRY, a twenty minute
//     safety TTL, and sleeps on it until its own twenty minute budget runs out.
//     It drains nothing and tells the operator to re-run, which does the same
//     thing again. A large backlog is exactly what keeps the scheduled drain
//     busy, so the condition that makes someone run this by hand is the
//     condition that guarantees it cannot help.
//
//  2. The reporting. The rate was total-confirmed over total-elapsed, which
//     DECAYS toward zero whenever progress is zero. So the line got gentler and
//     the estimate got longer the longer the run achieved nothing, and a reader
//     reasonably concluded work was proceeding slowly. The remainder never
//     moved once.
//
// Personas and hosts here are invented. This repository is public.

import {
  DRAIN_BUSY_POLL_MAX_MS,
  DRAIN_BUSY_POLL_MIN_MS,
  drainStalledFailure,
  drainYieldNotice,
  renderDrainProgress,
  runDrainLoop,
} from "../brain.mjs";
import {
  DRAIN_BUSY_RETRY_HINT_MAX_MS,
  DRAIN_LEASE_TTL_MS,
  drainOutbox,
} from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

/* ------------------------------------------------------------------ harness */

/** A clock the test drives, so a twenty minute budget costs no real seconds. */
const makeClock = () => {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, Number(ms) || 0); },
    advance: (ms) => { t += ms; },
  };
};

const makeLog = () => {
  const lines = { info: [], warn: [], ok: [] };
  return {
    lines,
    log: {
      info: (s) => lines.info.push(String(s)),
      warn: (s) => lines.warn.push(String(s)),
      ok: (s) => lines.ok.push(String(s)),
    },
    all: () => [...lines.info, ...lines.warn, ...lines.ok].join("\n"),
  };
};

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const busyBody = (remaining, retryAfterSeconds = 941) => ({
  error: "another vector drain is already in progress",
  busy: true,
  remaining,
  retry_after_seconds: retryAfterSeconds,
});

const drainBody = ({ drained, submitted, waiting, remaining }) => ({
  drained, submitted, waiting, remaining,
  vector_ready: remaining === 0,
  failed: 0,
  errors: [],
});

/* ============================================================================
 * 1. THE DECISIVE ONE: a manual drain started while a lease is held.
 * ==========================================================================*/
{
  const clock = makeClock();
  const captured = makeLog();
  let calls = 0;
  // The scheduled drain owns the lease for the whole run and, on this install,
  // is not moving the queue either. 941 is the exact hint from the live run.
  const result = await runDrainLoop({
    base: "https://brain.example.test",
    adminKey: "test-admin-key",
    now: clock.now,
    sleep: clock.sleep,
    log: captured.log,
    http: async () => { calls++; return response(409, busyBody(131_359, 941)); },
  });

  const elapsed = clock.now() - 1_000_000;
  check("a held lease no longer burns the twenty minute window",
    elapsed < 3 * 60 * 1000, `waited ${Math.round(elapsed / 1000)}s`);
  check("and it stops within the declared busy-yield window",
    elapsed >= 120_000 && elapsed <= 140_000, `waited ${Math.round(elapsed / 1000)}s`);
  check("it did not sleep through the TTL-shaped 941 second hint",
    calls >= 8, `only ${calls} attempt(s) in ${Math.round(elapsed / 1000)}s`);
  check("it slots in repeatedly rather than once, so it can take the gap",
    calls >= Math.floor(elapsed / DRAIN_BUSY_POLL_MAX_MS), `${calls} attempts`);
  check("the outcome is named a yield, not a completion",
    result.outcome === "yielded" && result.drained === 0 && result.submitted === 0 &&
      result.remaining === 131_359, JSON.stringify(result));
  check("it says plainly that it drained nothing and why",
    /nothing was drained by this run/.test(captured.all()) &&
      /holds the writer lease|held the writer lease/.test(captured.all()),
    captured.all().slice(0, 400));
  check("it never claims the vector index is query-ready",
    !/query-ready/.test(captured.all()) && captured.lines.ok.length === 0,
    captured.all().slice(0, 300));
  check("the closing notice is a warning, not a success line",
    captured.lines.warn.length === 1, JSON.stringify(captured.lines.warn));
}

/* A caller that GATES on a complete drain still fails on a held lease. */
{
  const clock = makeClock();
  const captured = makeLog();
  let thrown = null;
  try {
    await runDrainLoop({
      base: "https://brain.example.test",
      adminKey: "test-admin-key",
      now: clock.now,
      sleep: clock.sleep,
      log: captured.log,
      requireComplete: true,
      http: async () => response(409, busyBody(131_359, 941)),
    });
  } catch (error) { thrown = error; }
  check("setup, reindex, refit and upgrade still refuse to pass on a yield",
    thrown !== null && /nothing was drained by this run/.test(String(thrown?.message)),
    String(thrown?.message || "no error thrown"));
}

/* The gap is real: the moment the holder releases, this run takes it. */
{
  const clock = makeClock();
  const captured = makeLog();
  let calls = 0;
  const result = await runDrainLoop({
    base: "https://brain.example.test",
    adminKey: "test-admin-key",
    now: clock.now,
    sleep: clock.sleep,
    log: captured.log,
    http: async () => {
      calls++;
      // Three 409s, then the scheduled invocation ends and the lease frees.
      if (calls <= 3) return response(409, busyBody(900, 941));
      if (calls === 4) return response(200, drainBody({ drained: 500, submitted: 400, waiting: 400, remaining: 400 }));
      return response(200, drainBody({ drained: 400, submitted: 0, waiting: 0, remaining: 0 }));
    },
  });
  check("a manual drain that waits briefly does take the next gap and work",
    result.outcome === "complete" && result.drained === 900 && result.remaining === 0,
    JSON.stringify(result));
  check("and it took that gap in well under a minute of waiting",
    clock.now() - 1_000_000 < 60_000, `${Math.round((clock.now() - 1_000_000) / 1000)}s`);
  check("the poll interval respected the minimum floor",
    clock.now() - 1_000_000 >= 3 * DRAIN_BUSY_POLL_MIN_MS,
    `${clock.now() - 1_000_000}ms`);
}

/* ============================================================================
 * 2. A RUN WITH ZERO PROGRESS SAYS SO, IN THE LINE A PERSON IS WATCHING.
 * ==========================================================================*/
{
  // Exactly the live shape: 400 confirmed, 400 accepted, 131359 never moving.
  const clock = makeClock();
  const captured = makeLog();
  let calls = 0;
  let thrown = null;
  try {
    await runDrainLoop({
      base: "https://brain.example.test",
      adminKey: "test-admin-key",
      now: clock.now,
      sleep: clock.sleep,
      log: captured.log,
      http: async () => {
        calls++;
        clock.advance(4_000);
        if (calls === 1) {
          return response(200, drainBody({ drained: 400, submitted: 400, waiting: 400, remaining: 131_359 }));
        }
        return response(200, drainBody({ drained: 0, submitted: 0, waiting: 400, remaining: 131_359 }));
      },
    });
  } catch (error) { thrown = error; }

  const stalledLines = captured.lines.info.filter((line) => /No progress for/.test(line));
  check("every line after the queue stops moving says NO PROGRESS in words",
    stalledLines.length >= 5 && captured.lines.info.length - stalledLines.length === 1,
    JSON.stringify(captured.lines.info.slice(0, 3)));
  check("the one round that DID move still reads as ordinary progress with a rate",
    /^400 query-visible, 400 accepted, 131359 to go, ~\d+\/min/.test(captured.lines.info[0]) &&
      !/No progress/.test(captured.lines.info[0]), captured.lines.info[0]);
  check("no stalled line offers a rate",
    !stalledLines.some((line) => /\/min/.test(line)), stalledLines[0]);
  check("no stalled line offers a time estimate",
    !stalledLines.some((line) => /min left/.test(line)), stalledLines[0]);
  check("the stalled line still reports the true remainder",
    stalledLines.every((line) => /131359 to go/.test(line)), stalledLines[0]);
  check("a stall stops the run instead of spending the rest of the window",
    clock.now() - 1_000_000 < 20 * 60 * 1000, `${Math.round((clock.now() - 1_000_000) / 1000)}s`);
  check("and the failure names it a stall rather than a wall-clock timeout",
    thrown !== null && /without moving a single operation/.test(String(thrown?.message)) &&
      /stall, not slow/.test(String(thrown?.message)),
    String(thrown?.message || "no error thrown"));
}

/* The decayed-rate lie, reproduced against the pure renderer. */
{
  // The exact numbers from the live run. Under the old rule the rate is
  // drained/elapsed, so it FALLS and the estimate GROWS while nothing happens.
  const oldRate = (elapsedMin) => Math.round(400 / elapsedMin);
  check("the old rule really did decay while the remainder never moved",
    oldRate(3.48) === 115 && oldRate(4.26) === 94 &&
      Math.ceil(131_359 / oldRate(3.48)) === 1143 && Math.ceil(131_359 / oldRate(4.26)) === 1398,
    `${oldRate(3.48)} then ${oldRate(4.26)}`);

  const stalled = renderDrainProgress({
    drained: 400, submitted: 400, remaining: 131_359, progressed: false,
    stalledMs: 47_000, windowMs: 47_000, windowDrained: 0,
  });
  check("the new renderer refuses to show any rate for that same state",
    !/\/min/.test(stalled) && !/min left/.test(stalled) && /No progress for 47s/.test(stalled),
    stalled);
  check("and it names all three frozen numbers",
    /nothing confirmed, nothing accepted, and the queue has not moved/.test(stalled), stalled);

  const moving = renderDrainProgress({
    drained: 800, submitted: 800, remaining: 130_559,
    stalledMs: 0, windowMs: 60_000, windowDrained: 400,
  });
  check("a run that IS moving still gets its rate and estimate",
    /800 query-visible, 800 accepted, 130559 to go, ~400\/min, about 327 min left/.test(moving), moving);

  // Stalled time must not be averaged into the rate. Same work, same wall
  // clock; the difference is only whether the idle stretch is excluded.
  const excluded = renderDrainProgress({
    drained: 400, submitted: 400, remaining: 1_000, windowMs: 60_000, windowDrained: 400,
  });
  check("the rate is measured over working time, not over stalled time",
    /~400\/min/.test(excluded), excluded);

  const emptied = renderDrainProgress({
    drained: 1_000, submitted: 400, remaining: 0, windowMs: 57_000, windowDrained: 1_000,
  });
  check("an emptied queue is never given a time estimate",
    /1000 query-visible, 400 accepted, 0 to go, ~1053\/min$/.test(emptied), emptied);

  const blockedIdle = renderDrainProgress({ remaining: 131_359, blocked: true, stalledMs: 94_000 });
  check("a blocked run says a lease holder is why it has drained nothing",
    /No progress for 94s/.test(blockedIdle) && /this run has drained nothing/.test(blockedIdle) &&
      !/\/min/.test(blockedIdle), blockedIdle);

  const blockedBusy = renderDrainProgress({
    remaining: 130_200, blocked: true, holderDrained: 1_159, stalledMs: 94_000,
  });
  check("a blocked run credits the holder honestly when the holder IS working",
    /is draining it \(1159 fewer in 94s\)/.test(blockedBusy) &&
      /This run has written nothing/.test(blockedBusy), blockedBusy);
}

/* ============================================================================
 * 3. A RUN THAT DRAINS REPORTS HONESTLY, AND DIFFERENTLY FROM ONE THAT DOES NOT.
 * ==========================================================================*/
{
  const clock = makeClock();
  const captured = makeLog();
  let calls = 0;
  const result = await runDrainLoop({
    base: "https://brain.example.test",
    adminKey: "test-admin-key",
    now: clock.now,
    sleep: clock.sleep,
    log: captured.log,
    http: async () => {
      calls++;
      clock.advance(10_000);
      if (calls === 1) return response(200, drainBody({ drained: 0, submitted: 600, waiting: 600, remaining: 600 }));
      if (calls === 2) return response(200, drainBody({ drained: 600, submitted: 0, waiting: 0, remaining: 0 }));
      throw new Error("the drain kept calling after the queue emptied");
    },
  });
  check("a real drain completes and reports what it confirmed",
    result.outcome === "complete" && result.drained === 600 &&
      captured.lines.ok.join("") === "vector index is query-ready (600 confirmed)",
    JSON.stringify({ result, ok: captured.lines.ok }));
  check("its progress lines carry a rate because there genuinely is one",
    captured.lines.info.some((line) => /\/min/.test(line)),
    JSON.stringify(captured.lines.info));
}

{
  // Nothing was queued. Query-ready, but this run drained nothing, and it must
  // not read like the run above.
  const clock = makeClock();
  const captured = makeLog();
  const result = await runDrainLoop({
    base: "https://brain.example.test",
    adminKey: "test-admin-key",
    now: clock.now,
    sleep: clock.sleep,
    log: captured.log,
    http: async () => response(200, drainBody({ drained: 0, submitted: 0, waiting: 0, remaining: 0 })),
  });
  const line = captured.lines.ok.join("");
  check("an empty-queue run does not report like one that drained something",
    result.outcome === "complete" && result.drained === 0 &&
      line === "vector index is query-ready; this run had nothing to drain" &&
      !/confirmed/.test(line), JSON.stringify({ result, line }));
}

{
  // Real progress, but a backlog no twenty minute run can finish. That is the
  // expected shape of this command on a large install, not a fault.
  const clock = makeClock();
  const captured = makeLog();
  const result = await runDrainLoop({
    base: "https://brain.example.test",
    adminKey: "test-admin-key",
    now: clock.now,
    sleep: clock.sleep,
    log: captured.log,
    maxDurationMs: 60_000,
    http: async () => {
      clock.advance(5_000);
      return response(200, drainBody({ drained: 100, submitted: 100, waiting: 100, remaining: 50_000 }));
    },
  });
  check("a partial run that really moved the queue is reported as unfinished, not failed",
    result.outcome === "partial" && result.drained > 0 &&
      /not finished/.test(captured.lines.warn.join("")) &&
      /Re-run `brain drain/.test(captured.lines.warn.join("")),
    JSON.stringify({ result, warn: captured.lines.warn }));
}
{
  const clock = makeClock();
  let thrown = null;
  try {
    await runDrainLoop({
      base: "https://brain.example.test",
      adminKey: "test-admin-key",
      now: clock.now,
      sleep: clock.sleep,
      log: makeLog().log,
      maxDurationMs: 60_000,
      requireComplete: true,
      http: async () => {
        clock.advance(5_000);
        return response(200, drainBody({ drained: 100, submitted: 100, waiting: 100, remaining: 50_000 }));
      },
    });
  } catch (error) { thrown = error; }
  check("a gating caller fails on a partial drain exactly as before",
    thrown !== null && /wall-clock safety limit/.test(String(thrown?.message)),
    String(thrown?.message || "no error thrown"));
}

/* The two closing notices are distinguishable in words, not only in a field. */
{
  const yielded = drainYieldNotice({ remaining: 131_359, waitedMs: 120_000, holderDrained: 0 });
  const stalledText = drainStalledFailure({ drained: 400, submitted: 400, remaining: 131_359, stalledMs: 300_000 });
  check("the yield notice tells the operator nothing changed and what to do",
    /nothing was drained by this run/.test(yielded) &&
      /Nothing was changed here/.test(yielded) &&
      /131359 vector operation\(s\) are still queued and are safe/.test(yielded), yielded);
  check("the yield notice credits a working holder when there is one",
    /1159 fewer operation\(s\) queued/.test(
      drainYieldNotice({ remaining: 130_200, waitedMs: 120_000, holderDrained: 1_159 })),
    drainYieldNotice({ remaining: 130_200, waitedMs: 120_000, holderDrained: 1_159 }));
  check("the stall failure is worded as a fault and points at diagnose",
    /This is a stall, not slow/.test(stalledText) && /brain diagnose/.test(stalledText), stalledText);
  check("the two endings cannot be mistaken for each other",
    yielded !== stalledText && !/stall/.test(yielded) && !/nothing was drained by this run/.test(stalledText));
}

/* ============================================================================
 * 4. THE INVARIANT THIS WHOLE THING EXISTS TO PROTECT: never two writers.
 *
 * Polling more often can only produce more 409s. What admits a writer is a
 * successful compare-and-swap on the single install_state lease row, and none
 * of the changes above touch it. This models that row honestly and races two
 * drains through it.
 * ==========================================================================*/

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  chunk_uid: `c${i}#0`, text: `text ${i}`, source: "s", doc_uid: `c${i}`,
  client: "Northwind Studio", category: "note", top_folder: "Clients",
  platform: "drive", document_date: 1750000000000, generation: i + 1,
}));

/** A D1 stand-in whose install_state lease row obeys the real CAS predicate. */
const makeLeaseEnv = (outboxRows, upserted, leaseLog) => {
  const state = { owner: null, expires: null, schemaVersion: 12 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    state,
    env: {
      DB: {
        prepare(sql) {
          const shape = (bound = []) => ({
            _q: sql,
            _b: bound,
            bind: (...b) => shape(b),
            all: async () => ({
              results: /submitted_mutation_id IS NOT NULL/.test(sql) || /WHERE op = 'delete'/.test(sql)
                ? [] : outboxRows,
            }),
            first: async () => {
              if (/count\(\*\) AS n FROM vector_outbox/.test(sql)) return { n: outboxRows.length };
              if (/vector_drain_lease_owner IS NULL THEN 0/.test(sql)) {
                return {
                  held: state.owner ? 1 : 0,
                  schema_ready: state.schemaVersion >= 12 ? 1 : 0,
                  expires_at: state.expires,
                };
              }
              return { n: 1 };
            },
            run: async () => {
              if (!/UPDATE install_state/.test(sql)) return {};
              // Yield first, so the two racing drains genuinely interleave
              // around the predicate rather than running to completion in turn.
              await tick();
              const now = Date.now();
              if (/SET vector_drain_lease_owner = NULL/.test(sql)) {
                if (state.owner !== bound[0]) return { meta: { changes: 0 } };
                state.owner = null; state.expires = null;
                leaseLog.push(`release:${String(bound[0]).slice(0, 8)}`);
                return { meta: { changes: 1 } };
              }
              if (/SET vector_drain_lease_expires_at = \?3/.test(sql)) {
                if (state.owner !== bound[0] || !(state.expires > bound[1])) {
                  return { meta: { changes: 0 } };
                }
                state.expires = bound[2];
                return { meta: { changes: 1 } };
              }
              if (/SET vector_drain_lease_owner = \?1/.test(sql)) {
                const free = state.owner === null || state.expires === null || state.expires <= bound[2];
                if (state.schemaVersion < 12 || !free) return { meta: { changes: 0 } };
                state.owner = bound[0]; state.expires = bound[1];
                leaseLog.push(`acquire:${String(bound[0]).slice(0, 8)}`);
                return { meta: { changes: 1 } };
              }
              void now;
              return { meta: { changes: 1 } };
            },
          });
          return shape();
        },
        batch: async (statements) => statements.map(() => ({ meta: { changes: 1 } })),
      },
      VECTORIZE: {
        upsert: async (vectors) => {
          upserted.push(...vectors.map((v) => v.id ?? v.chunk_uid ?? JSON.stringify(v).slice(0, 40)));
          return { mutationId: "fixture-lease-race" };
        },
      },
    },
  };
};

{
  const upserted = [];
  const leaseLog = [];
  const { env } = makeLeaseEnv(rows(20), upserted, leaseLog);
  const options = {
    embed: async () => [0.1],
    embedBatch: async (texts) => texts.map(() => [0.1]),
    embedGroup: 20,
    disableBootstrapAdvance: true,
  };
  const [first, second] = await Promise.all([
    drainOutbox(env, options),
    drainOutbox(env, options),
  ]);
  const busy = [first, second].filter((r) => r.busy === true);
  const worked = [first, second].filter((r) => r.busy !== true);
  check("exactly one of two concurrent drains is admitted",
    busy.length === 1 && worked.length === 1,
    JSON.stringify({ first: first.busy, second: second.busy }));
  check("the refused drain writes no vectors at all",
    busy[0].submitted === 0 && busy[0].drained === 0 && busy[0].upserted === 0,
    JSON.stringify(busy[0]));
  check("no vector operation is written twice",
    upserted.length === new Set(upserted).size && upserted.length === 20,
    JSON.stringify({ total: upserted.length, unique: new Set(upserted).size }));
  check("only one owner ever held the lease during the race",
    leaseLog.filter((entry) => entry.startsWith("acquire:")).length === 1, JSON.stringify(leaseLog));
  check("and the busy receipt still reports the true backlog",
    busy[0].remaining === 20, JSON.stringify(busy[0]));
  check("the refused drain is handed a poll-again hint, not the whole lease TTL",
    busy[0].retry_after_seconds <= DRAIN_BUSY_RETRY_HINT_MAX_MS / 1_000 &&
      busy[0].retry_after_seconds >= 1 &&
      DRAIN_BUSY_RETRY_HINT_MAX_MS < DRAIN_LEASE_TTL_MS,
    `retry_after_seconds=${busy[0].retry_after_seconds}`);
  check("the lease is released, so the next run can take the gap",
    leaseLog.filter((entry) => entry.startsWith("release:")).length === 1, JSON.stringify(leaseLog));
}

{
  // A lease is a lease, not a deadlock: once released, the very next attempt
  // is admitted. This is what makes short polling worth doing.
  const upserted = [];
  const leaseLog = [];
  const { env } = makeLeaseEnv(rows(5), upserted, leaseLog);
  const options = {
    embed: async () => [0.1],
    embedBatch: async (texts) => texts.map(() => [0.1]),
    disableBootstrapAdvance: true,
  };
  const blocked = await drainOutbox(env, {
    ...options,
    // Hold the lease under a different owner first.
    now: () => Date.now(),
  });
  check("a drain run against a free lease is admitted immediately",
    blocked.busy !== true && blocked.submitted === 5, JSON.stringify(blocked));
  const again = await drainOutbox(env, options);
  check("and the next sequential run is admitted too, because the lease was released",
    again.busy !== true, JSON.stringify(again));
}

console.log(`\ndrain escape hatch: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
