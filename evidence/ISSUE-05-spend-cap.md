# Issue #5 evidence — the AI spend cap no longer fails open

> Candidate triage, 2026-08-30: this is historical evidence for the earlier
> per-isolate degraded-allowance repair. It is not the current v0.2.1 candidate
> design. The candidate reserves estimated spend atomically in D1 before a
> provider call and retains a conservative reservation when settlement cannot
> complete. Use the candidate tests and current recovery documentation for the
> release decision.

Date: 2026-08-28. Branch `fix/issue5-spend-cap-fails-open`, built in an isolated
worktree off `wave0/connector-gaps`. Scope was held to three files on purpose:
`worker/src/lib/core.js`, a new `worker/test/spend-cap.test.mjs`, and its
one-line registration in `package.json`. `worker/src/index.js` and `brain.mjs`
were NOT touched — parallel branches own those tonight.

## The defect, as reported

`spentTodayMicros` in `worker/src/lib/core.js` caught its own D1 error and
returned `0`, commented `// fail open`. Zero reported spend means the cap does
not bind, for as long as D1 is unhappy. The reporter's framing is the right one:
a cap that fails open is not a cap, it is a hope, and on a client-owned install
the payment method behind it is the client's.

## The design choice: degrade, do not fail fully closed

The issue deliberately left this open ("Fail closed, or fail to a small
conservative allowance"). This branch degrades.

Failing fully closed was rejected because the guard would then convert a
transient logging-table hiccup into a total refusal to answer. To a client whose
brain is the product, that is indistinguishable from an outage, and it hands the
guard a new way to be the thing that breaks the install. The comment already in
the file said the guard "must never be the reason a legitimate call fails" —
that instinct was right, the implementation of it was not.

So the guard keeps a ledger of what THIS isolate has charged today, written by
the process itself on every billed call, and never replaced by a zero. When the
D1 read fails, the guard holds that ledger against a reduced allowance instead
of the full cap: **10% of the configured daily cap, and never more than $5**.
The absolute ceiling matters because a client running a $500/day cap would
otherwise get a $50 degraded allowance, which is a real amount of money to spend
against a ledger nobody can read. Answers keep flowing through a blip. A runaway
loop — the exact threat the original comment names — burns the reduced allowance
in a few calls and then hard-stops.

Three further holes of the same shape were closed while in the function, because
each one also ended in "nothing binds":

1. **No `DB` binding at all** returned `0` too. No binding means no ledger exists
   to read, which is the same hole as a failing query. It now degrades.
2. **A garbled `DAILY_LLM_CAP_USD`** (`Number("ten dollars")` → `NaN`) made
   `spent >= NaN` false forever, removing the cap while looking like a working
   configuration. It now falls back to the $10 default, never to "no cap".
3. **`logCall` swallows its own write failures**, so the stored SUM can
   under-report. The healthy path now takes `Math.max(storedSum, isolateLedger)`
   so a lost write cannot buy extra budget.

### The honest limits, stated rather than glossed

**One.** The degraded bound is **per isolate, not global**. A runaway loop lives inside
one isolate and is bounded exactly. Broad fan-out across many isolates while D1
is down is bounded only by (isolates × reduced allowance). That is far tighter
than "no cap" and it makes unbounded spend unreachable, but it is not a single
global number, and the code comment says so rather than implying a guarantee the
design does not deliver.

**Two.** The pre-existing 60-second cache window is untouched, so a D1 failure
that begins just after a healthy read is not *noticed* for up to 60 seconds.
Spending is still bounded through that window — the isolate ledger keeps growing
and is still held against the full cap — but the guard is measuring against a
stale reading, not a live one. Shortening that window trades D1 reads for
freshness and was left alone as a separate decision. The test documents the
behaviour rather than hiding it: block 7 deliberately routes through the
missing-binding path, which degrades ahead of the cache, and says why in a
comment.

### Visibility, per the repo's honesty rules

The failure is loud, not silent:

- `console.warn("[spend-guard] DEGRADED: <reason>. ...")` on entry into the
  degraded state, and `[spend-guard] recovered` on exit.
- Every block during degradation logs `[spend-guard] BLOCKED a call while
  degraded: <reason>`, so an operator learns the cap is doing work.
- The thrown error names the cause instead of reusing the ordinary cap wording,
  and carries `e.spend_guard_degraded = true` alongside `e.llm_cap_exceeded`.
- A new export, `spendGuardStatus()`, returns
  `{ degraded, reason, since, isolate_day, isolate_spent_micros }`.

**Named as unproven / follow-up:** `spendGuardStatus()` is exported but not yet
surfaced on `/health`. Wiring it there requires editing `worker/src/index.js`,
which a sibling branch owns tonight, so it was deliberately left out of scope.
A human integrating these branches should add the field to the health payload —
the accessor exists precisely so that is a one-line change.

## The test the issue asked for

`worker/test/spend-cap.test.mjs`, offline in the style of
`worker/test/provider-routing.test.mjs`: stub AI binding, stub D1, no network,
no wall-clock waits. It forces the spend query to throw and asserts the cap
still binds.

The exact property it proves:

> With the spend query throwing on every call, once the isolate's own recorded
> spend reaches the reduced allowance, **every subsequent call is refused and
> the provider is never reached**. 40 consecutive runaway iterations bought
> exactly zero provider calls, and the ledger did not move.

It also covers: the first call through a blip still answers (no outage); the
degraded state names its cause and warns; recovery restores the full cap; a
missing D1 binding is bound the same way; a garbled cap value falls back to the
default rather than to `NaN`; and a large configured cap does not buy a large
degraded allowance, because the $5 ceiling binds before the 10% share does.

**Every assertion was checked for discrimination.** Two branches were reverted
one at a time and the test re-run: with the `fail open` return restored it fails
at line 89 (below), and with the `$5` ceiling removed from `degradedBudgetUsd`
it fails with `Missing expected rejection: a large configured cap must not buy a
large allowance while there is no ledger` (exit 1, read from its own file). No
assertion passes vacuously.

### The test fails against the old code

The catch branch was temporarily reverted to the original `fail open` return,
with everything else unchanged, to confirm the test actually catches the
reported defect rather than merely passing alongside it. Verbatim:

```
$ node worker/test/spend-cap.test.mjs   # with the fail-open branch restored
AssertionError [ERR_ASSERTION]: Missing expected rejection: past the reduced allowance the guard must refuse, even though the ledger read is broken
    at async file:///private/tmp/brain-issue5-spendcap/worker/test/spend-cap.test.mjs:89:3 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: undefined,
  expected: [Function (anonymous)],
  operator: 'rejects',
  diff: 'simple'
}

$ cat failopen.exit
1
```

Exit code read from its own file, not from a pipe. The fix was restored
immediately afterwards.

### The test passes against the fix

```
$ node worker/test/spend-cap.test.mjs
spend cap: all focused offline tests passed (query failure, runaway loop, recovery, missing binding, garbled cap, degraded ceiling)
EXIT=0
```

## Full suite

Registered in the `npm test` chain immediately after
`worker/test/provider-routing.test.mjs` (the other test on this file).

First run exited 1 on `test/drive-removal-guard.test.mjs` — an environment
artifact, not a regression: the fresh worktree had no `node_modules`, and the
harness correctly reported "the ingest dependencies are not installed". After
`npm ci --ignore-scripts` (added 4 packages, 0 vulnerabilities), the suite was
re-run in full.

Output and exit code were captured to separate files, because piping to `tail`
masks the real exit code:

```
$ npm test > fullsuite.out 2>&1; echo $? > fullsuite.exit

$ cat fullsuite.exit
0
```

Counts read back from `fullsuite.out` (3,046 lines):

| Measure | Count |
|---|---|
| Self-reporting harnesses, `^PASS` lines | 2,133 |
| Self-reporting harnesses, `^FAIL` lines | 0 |
| `AssertionError` occurrences | 0 |
| `node --test` runner, `pass` | 140 |
| `node --test` runner, `fail` | 0 |
| Hard failure markers (`^FAIL` or `^not ok`) | 0 |
| **Total passing** | **2,273** |
| **Total failing** | **0** |

The 189 case-insensitive matches for "fail" in the output were checked
individually: all are test names ("unknown profiles fail closed", "a document
failure throws instead of silently advancing the watermark") or fixture text,
none are results.

The new test's line in the full-suite output, at line 2990:

```
spend cap: all focused offline tests passed (query failure, runaway loop, recovery, missing binding, garbled cap, degraded ceiling)
```

## Changelog paragraph

Not written into `CHANGELOG.md` and no version bumped, deliberately — a human is
consolidating several parallel branches. The paragraph for them to place:

> **Fixed — the daily AI spend cap no longer fails open.** When its own spend
> query failed, the guard reported zero spend and stopped binding, so a database
> hiccup removed the cap entirely. It now degrades instead: it falls back to
> what the running instance knows it has spent and holds that against a small
> fraction of the day's budget, so answers keep flowing through a blip while a
> runaway loop still stops within a few calls. A missing database binding and an
> unparseable `DAILY_LLM_CAP_USD` were the same hole and are closed the same
> way, and the reduced allowance is capped in absolute terms as well as
> proportionally, so a large daily budget does not buy a large blind spend.
> Degradation, recovery and every block are announced on the console, the
> refusal names its cause, and `spendGuardStatus()` exposes the state for health
> reporting.

## Files

- `worker/src/lib/core.js` — the guard rewritten.
- `worker/test/spend-cap.test.mjs` — new, 7 blocks.
- `package.json` — one-line test registration. No version change.
