# The escape hatch that could not open — evidence

Branch: `fix/drain-escape-hatch`, worktree `/private/tmp/brain-drain-hatch`,
branched from `wave0/connector-gaps` at commit `c50c57b` ("Evidence: the link,
the 401, and the one thing left for a human").

Found on a real install with a 131,359 operation vector backlog, not in review.

## What the operator saw

```
·     400 query-visible, 400 accepted, 131359 to go, ~115/min, about 1143 min left
·     400 query-visible, 400 accepted, 131359 to go, ~112/min, about 1173 min left
·     400 query-visible, 400 accepted, 131359 to go, ~106/min, about 1239 min left
·     400 query-visible, 400 accepted, 131359 to go, ~100/min, about 1314 min left
·     400 query-visible, 400 accepted, 131359 to go, ~95/min,  about 1383 min left
·     400 query-visible, 400 accepted, 131359 to go, ~94/min,  about 1398 min left
·     another vector drain is finishing; retrying in 941 second(s)
fail  the drain reached its 20-minute wall-clock safety limit with 131359 vector
      operation(s) still queued. Completed chunks are safe. Re-run `brain drain`
      to resume from the durable queue.
```

Exit 1, twenty minutes spent, zero operations drained, and the advice at the
end was to do the same thing again.

## Defect one: the standoff, and the real mechanism behind it

The mechanism is a single-row lease in D1, and it is correct. `acquireDrainLease`
claims `install_state` row 1 with `UPDATE ... WHERE owner IS NULL OR expires_at
<= now`, `renewDrainLease` re-proves the same owner immediately before every
Vectorize mutation, and `releaseDrainLease` clears it by owner token. One
writer, always. That part needed no change and got none.

The failure is in the two numbers around it, which happen to be the same number
for the wrong reason:

| Constant | Value | What it actually is |
|---|---|---|
| `DRAIN_LEASE_TTL_MS` | 20 min | A safety envelope sized for the longest possible invocation, so a dead owner self-heals |
| `MANUAL_DRAIN_MAX_MS` | 20 min | The whole budget of a hand-run drain |
| `maxInvocationMs` (drain default) | 10 min | How long a holder actually works before releasing |

A busy receipt returned `retryAfterSeconds = observedExpiry - now`, clamped to
the TTL. That is the time until the lease would EXPIRE, not the time until the
holder will FINISH. A scheduled drain that took the lease four minutes ago and
will release in seconds still reports 941. The CLI then slept the full 941
seconds, its own twenty minute deadline passed while it slept, and it died.

The trap closes on itself: the condition that makes a human run this by hand,
a large backlog, is exactly the condition that keeps the scheduled drain busy
holding the lease.

### What was chosen, and what was rejected

**Chosen: wait less and work in the gaps, cooperatively.**

A scheduled drain releases the lease at the end of its own bounded invocation.
The cron fires every five minutes and each invocation is seconds to a couple of
minutes, so the queue spends most of its time unowned. The manual run now polls
the lease at 3 to 15 second intervals instead of sleeping on a TTL-shaped hint,
takes the lease the moment the holder releases it, and works the gap. It gives
up after `DRAIN_BUSY_YIELD_MS` (120 seconds, which comfortably covers a normal
scheduled invocation ending) rather than after twenty minutes, and it says so.

The worker's hint is fixed too, capped at `DRAIN_BUSY_RETRY_HINT_MAX_MS`
(15 seconds), so an older CLI, or any other client, also stops sleeping through
the gap. The hint is now a poll-again-in interval instead of a lease-expiry
disclosure, which is what it was always being read as.

Rejected, with reasons:

- **Taking over an idle or expiring lease.** There is no liveness signal to
  decide "idle" with; the lease carries only an expiry. Stealing it would make
  the true owner's next `renewDrainLease` fail, but only AFTER it may already
  have submitted a Vectorize changeset and before it could durably record the
  submission receipt in D1. That is precisely the two-writer window the lease
  exists to prevent. Shortening the TTL has the same defect in slower motion,
  because the TTL must cover the longest legal invocation.
- **Not starting at all, and saying so immediately.** Honest, and strictly
  better than burning twenty minutes, but it helps nobody with 131,359 queued.
  The scheduled drain alone moves roughly 1,000 operations per five minutes,
  about eleven hours for that backlog, which is why the operator reached for
  the hatch. Surrendering on the first 409 throws away every gap.
- **Cooperating by watching and reporting only.** Same problem. It is a better
  message attached to the same non-help. It survives as a component: when the
  holder IS moving the queue while this run waits, the line now credits it
  ("... is draining it (1159 fewer in 94s)") instead of implying this run is.

### How two drains still never write the same operations

Nothing in this change touches acquisition, renewal or release. The manual run
has no new privilege; it only asks more often. What admits a writer is still one
atomic compare-and-swap on `install_state`, and every Vectorize mutation still
sits behind a `renewDrainLease` that re-proves the same owner token immediately
before the write. Polling faster can produce only more 409s, never a second
writer, because politeness was never what kept the second writer out.

That is asserted directly, not argued: `test/drain-escape-hatch.test.mjs`
section 4 races two `drainOutbox` calls through a D1 stand-in whose lease row
evaluates the real CAS predicate, and checks that exactly one is admitted, that
the refused one writes nothing, that no vector id is upserted twice, that only
one acquire is logged, and that the lease is released so the next run gets in.

## Defect two: the reporting, which is the half that misled a human

The rate was `drained / elapsed`, over the whole run. That number decays toward
zero whenever progress is zero, and the projection `remaining / rate` grows to
match. So the display was at its most reassuring exactly when the run was
achieving least: a falling rate reads as slow going, not as a dead stop. A
person watched it and concluded work was proceeding. The remainder had not
moved once.

Two rules replace it:

1. The rate is measured only over the window since progress was last SEEN to
   change. A round that moves nothing re-anchors the window, so stalled time is
   excluded from the rate rather than quietly deflating it into a gentler lie.
2. A round that moved nothing prints the stall in words, with no rate and no
   estimate at all, because there is no rate.

Not moving and not-yet-measurable are kept distinct: an early round with a real
advance but too short a window prints the counts without a rate, not a stall.

A run that holds the lease and moves nothing for `DRAIN_STALL_MS` (5 minutes)
now stops and names it a stall, instead of spending the remaining fifteen
minutes rediscovering the same thing.

Endings are distinguishable in words, not only in a returned field:

| Ending | Line |
|---|---|
| drained something, complete | `ok    vector index is query-ready (600 confirmed)` |
| drained nothing, complete | `ok    vector index is query-ready; this run had nothing to drain` |
| drained nothing, lease held | `warn  nothing was drained by this run. ...` |
| drained something, unfinished | `warn  not finished: N operation(s) confirmed ...` |
| held the lease, moved nothing | `fail  the drain held the writer lease for 5 minute(s) without moving a single operation.` |

## What a person now sees

Real output, colour codes stripped. The clock is driven by the harness so a
twenty minute budget costs no real seconds; every line is produced by the
shipped code paths.

### The reported failure, replayed

```
·     131359 to go. No progress for 1s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 15s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 30s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 45s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 60s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 75s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 90s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 105s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     131359 to go. No progress for 120s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
warn  nothing was drained by this run. Another vector drain held the writer lease for the whole 120s it waited, and only one drain may write vectors at a time.
        That drain moved nothing while this run waited, so it may be finishing a slow batch.
        131359 vector operation(s) are still queued and are safe.
        Nothing was changed here. Re-run `brain drain <manifest>` to take the next gap.

[wall clock spent: 120s]  [outcome: yielded]  [process exit: 0]
```

Two minutes instead of twenty, and the first line already says the thing the
old run never said in twenty minutes: this run has drained nothing.

### The queue stops moving while this run holds the lease

```
·     400 query-visible, 400 accepted, 131359 to go, ~6000/min, about 22 min left
·     400 query-visible, 400 accepted, 131359 to go. No progress for 7s: nothing confirmed, nothing accepted, and the queue has not moved. There is no rate to show.
·     400 query-visible, 400 accepted, 131359 to go. No progress for 14s: nothing confirmed, nothing accepted, and the queue has not moved. There is no rate to show.
      ... (the counter is the moving part; the numbers are not) ...
·     400 query-visible, 400 accepted, 131359 to go. No progress for 301s: nothing confirmed, nothing accepted, and the queue has not moved. There is no rate to show.

fail  the drain held the writer lease for 5 minute(s) without moving a single operation.
      400 confirmed and 400 accepted in total, with 131359 still queued,
      and none of those three numbers changed in that window. This is a stall, not slow
      progress, so the run stopped rather than spend its remaining window discovering the
      same thing. Completed chunks are safe. Run `brain diagnose <manifest>` for the reason.

[wall clock spent: 301s]  [process exit: 1]
```

### The lease frees mid-run and this drain finishes the queue

```
·     1000 to go. No progress for 1s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     1000 to go. No progress for 21s: another vector drain holds the writer lease, so this run has drained nothing. Waiting for a gap.
·     600 query-visible, 400 accepted, 400 to go, ~750/min, about 1 min left
·     1000 query-visible, 400 accepted, 0 to go, ~1053/min
ok    vector index is query-ready (1000 confirmed)

[wall clock spent: 57s]  [outcome: complete]  [process exit: 0]
```

## The exit code

Exit 1 was wrong for that run, and it is now 0, narrowly.

A run that never acquired the lease wrote nothing, claimed nothing and left
nothing unproven. The queue is byte for byte as it was found. Nothing went
wrong; this run simply never got a turn. An escape hatch that exits nonzero for
a normal, expected, harmless condition teaches people to stop reading its exit
code, and then it stops working as an alarm for the conditions that do matter.

The change is deliberately confined to that one case:

- **Never acquired, drained nothing: exit 0**, with `warn`, wording that cannot
  be mistaken for success, and no query-ready claim anywhere in the output.
- **Acquired and worked, but the queue is not empty: unchanged.** For the
  hand-run hatch that is `warn ... not finished`, which is the expected shape on
  a large backlog and not a fault. For any caller that GATES on a query-ready
  index it is still a hard failure.

That last distinction is what makes exit 0 safe. `setup`, `reindex`, `refit` and
the upgrade's vector projection convergence stage now pass
`requireComplete: true`, which turns both a yield and a partial into a `die`.
Their behaviour is bit for bit what it was. Only the command a human types by
hand is allowed to treat a held lease as a non-event, because only that command
has a human reading the sentence next to the exit code.

A stall while HOLDING the lease stays exit 1, and should: queued work that the
provider will not confirm is a genuine fault that needs someone to look.

## Discrimination

Each defect's fix was reverted in turn and the matching test re-run.

### 1. Restore the old busy-wait (sleep on the TTL-shaped hint, no yield)

```
FAIL  a held lease no longer burns the twenty minute window  waited 1200s
FAIL  and it stops within the declared busy-yield window  waited 1200s
FAIL  it did not sleep through the TTL-shaped 941 second hint  only 2 attempt(s) in 1200s
FAIL  it slots in repeatedly rather than once, so it can take the gap  2 attempts
FAIL  a manual drain that waits briefly does take the next gap and work  {"drained":0,"submitted":0,"remaining":900,"rounds":2,"outcome":"yielded"}
FAIL  and it took that gap in well under a minute of waiting  1200s

drain escape hatch: 38/44 passed
```

Exit 1. `waited 1200s` is the twenty minute burn, and `only 2 attempt(s) in
1200s` is the sleep through the 941 second hint. The reported failure, exactly.

### 2. Restore the old rate rule (total drained over total elapsed)

```
FAIL  every line after the queue stops moving says NO PROGRESS in words  ["400 query-visible, 400 accepted, 131359 to go, ~6000/min, about 22 min left","400 query-visible, 400 accepted, 131359 to go, ~2182/min, about 61 min left","400 query-visible, 400 accepted, 131359 to go, ~1333/min, about 99 min left"]
FAIL  the new renderer refuses to show any rate for that same state  400 query-visible, 400 accepted, 131359 to go
FAIL  and it names all three frozen numbers  400 query-visible, 400 accepted, 131359 to go
FAIL  a run that IS moving still gets its rate and estimate  800 query-visible, 800 accepted, 130559 to go
FAIL  the rate is measured over working time, not over stalled time  400 query-visible, 400 accepted, 1000 to go

drain escape hatch: 39/44 passed
```

Exit 1. The captured detail is the pathology itself: the rate falls from
`~6000/min` to `~2182/min` to `~1333/min` and the estimate grows from 22 to 61
to 99 minutes, while `131359` never moves. Same shape as the live
115 → 112 → 106 → 100 → 95 → 94 and 1143 → 1398.

Both reverts were undone and the suite re-run clean before committing.

## Full suite

```
$ npm test > /tmp/drainhatch.log 2>&1; echo $? > /tmp/drainhatch-exit.txt
$ cat /tmp/drainhatch-exit.txt
0
$ grep -c "^FAIL" /tmp/drainhatch.log
0
$ grep "drain escape hatch:" /tmp/drainhatch.log
drain escape hatch: 45/45 passed
```

## Files

| File | Change |
|---|---|
| `brain.mjs` | `DRAIN_BUSY_YIELD_MS`, `DRAIN_BUSY_POLL_MIN_MS`, `DRAIN_BUSY_POLL_MAX_MS`, `DRAIN_STALL_MS`; pure `renderDrainProgress`, `drainYieldNotice`, `drainStalledFailure`; the loop extracted as exported `runDrainLoop` with injected clock, sleep, http and log; `cmdDrain` reduced to a resolver; `requireComplete: true` at the four gating call sites |
| `worker/src/lib/store-d1.js` | `DRAIN_BUSY_RETRY_HINT_MAX_MS`; the busy receipt hands back a poll-again interval instead of the remaining lease TTL |
| `test/drain-escape-hatch.test.mjs` | New. 45 checks across the standoff, the reporting, the endings and the single-writer race |
| `test/vector-delete-outbox.test.mjs` | One expectation updated, 60 to 15, for the capped hint |
| `package.json` | Registered in the test chain after `drain-exit.test.mjs` |

No version bump. No CHANGELOG heading. Personas and hosts in the new test are
invented (`brain.example.test`, `Northwind Studio`); this repository is public.

## A note from the owner of this change

The part of this I would want someone to check hardest is the exit code, because
it is the one place where the fix makes a failing thing pass. I kept it as
narrow as I know how: only a run that never acquired the lease, that wrote
nothing and claimed nothing, and only when a human typed the command. Every
path that gates a deploy on a query-ready index now says `requireComplete` out
loud and fails exactly as it did before. If that boundary turns out to be wrong,
the thing to move is `requireComplete`, not the wording.

The second thing worth saying plainly: the reporting defect was the more
dangerous of the two. The standoff wasted twenty minutes, which is annoying and
visible. The decaying rate cost a person their correct understanding of what was
happening, which is the failure mode where a tool is worse than no tool. Any
progress display computed as total-work over total-elapsed has this bug latent
in it, and it always presents as reassurance.
