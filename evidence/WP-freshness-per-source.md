# Per-source freshness, and three ways a client machine stops syncing quietly

Branch `fix/freshness-per-source`, worktree branched from `wave0/connector-gaps`
at `b15e988`.

## The defect

`acceptance.mjs` computed corpus freshness like this:

```js
const freshest = rows
  .map((r) => (r.last_ingested ? Date.parse(r.last_ingested) : NaN))
  .filter(Number.isFinite)
  .sort((a, b) => b - a)[0];
...
this.record(t, "corpus is fresh", days <= 2 ? PASS : days <= 14 ? WARN : FAIL,
  `newest ingest ${days} day(s) ago`);
```

That is the newest timestamp across **all** sources. Message capture ticks every
minute, so on any install with live capture the maximum is always seconds old and
the check passed forever. It is a corpus-wide claim carried by whichever source
happens to be fastest, and the source it is silent about is the one the client
actually works out of.

This is not a cosmetic check. It is the instrument the client-facing acceptance
checklist is judged against, and that checklist is what a 30-day money-back
guarantee refers to. The product was certifying itself healthy while a corpus
inside it was dead.

Here is the old code's verdict on a fixture install whose Drive corpus has not
been read in six months, run against the real `Acceptance` class:

```
--- BUGGY tier 2 verdict on an install whose Drive corpus has been dead 183 days ---
  PASS  corpus is not empty  —  53400 document(s) across 2 source type(s)
  PASS  embedding backlog is small  —  0 document(s) awaiting embedding
  PASS  storage backend matches manifest  —  expected d1, received d1
  PASS  semantic index is query-ready  —  53400/53400 vector(s), 0 operation(s) pending
  PASS  corpus is fresh  —  newest ingest 0 day(s) ago
  passed: true
```

"newest ingest 0 day(s) ago", on an install whose main corpus is 183 days stale.

## How freshness is judged now

The same fixture, after the fix:

```
  PASS  corpus is not empty  —  53400 document(s) across 2 source type(s)
  PASS  embedding backlog is small  —  0 document(s) awaiting embedding
  PASS  storage backend matches manifest  —  expected d1, received d1
  PASS  semantic index is query-ready  —  53400/53400 vector(s), 0 operation(s) pending
  FAIL  every source expected to refresh is current  —  1 of 2 scheduled source(s) have stopped updating: drive (183d)
  FAIL  freshness: drive  —  STALE — last read 183 day(s) ago but expected to refresh about every 1 day(s); anything added since is not in the brain
  passed: false
```

**The expectation is not reinvented.** `GET /api/admin/brain/freshness` already
owns it (`worker/src/lib/store-d1.js` `freshnessReport`), and acceptance now
reads that surface instead of deriving a second notion of staleness beside it.
That mattered more than it looked: two independent staleness rules would let the
acceptance report and `brain sources` disagree about the same install, and the
client would have no way to tell which one was lying.

What the endpoint already knew, and acceptance now honours:

| Source state | Verdict | Why |
|---|---|---|
| `stale` | **FAIL**, named | It was expected to refresh and stopped |
| `broken` | **FAIL**, named, cause repeated verbatim | The connector reported an error, or a sync has hung |
| `never_synced` | **FAIL**, named | Expected to refresh and never has, so it may be missing entirely |
| `unscheduled` | **WARN**, named | It *could* refresh automatically, but nothing on this install does |
| `manual` | not judged | A one-time load from a machine we cannot reach was finished, not neglected |
| `indexing` | not a failure | A live run under six hours is working; past that the Worker already calls it broken |

Three honesty rules are enforced in `freshnessVerdicts()`, which is exported so
the judgement is testable without a Worker:

- **A check that cannot run says so.** A Worker that 404s the freshness endpoint
  FAILS with "Freshness is UNVERIFIED", it does not pass. So does a Worker that
  returns `unavailable: true`, or a 200 with no per-source list. A non-D1 backend
  is SKIPped and named, because there the instrument genuinely does not apply.
- **No vacuous green.** An install where nothing is expected to refresh reports
  "no source in this install is being kept current" rather than "0 of 0 current".
  A perfect score over an empty set is the same lie in a smaller font.
- **Name the source.** "Something is stale" is not actionable at 9pm, so every
  failing source gets its own line carrying its name, its age, what it was
  supposed to do, and the consequence.

## The three scheduling items

### 1. `RunAtLoad` false with a fixed daily time — FIXED

`operations/drive-scheduler.mjs` rendered `RunAtLoad` `<false/>`, and
`docs/README-developer.md` documented that as deliberate. The documented
reasoning was only half right: launchd *does* coalesce a firing missed while the
Mac is asleep, but a firing missed while the Mac is **powered off or the owner is
logged out** is dropped and never made up. On a laptop that is routinely off at
09:00, a `0 9 * * *` schedule does not run late — it never runs at all, forever,
and the only symptom is a source that stops updating.

`RunAtLoad` is now `<true/>`, with the reasoning written beside the bytes that do
it. Every hardening property is untouched: the `lockf` wrapper still allows one
run at a time, the config-hash guard still refuses a stale agent against an
edited manifest, the child environment is still sanitized, the plist still
carries no credentials, and `ThrottleInterval` still caps the rate.

**Deliberately NOT gated on a "last run" marker.** A coalescing window wide
enough to be worth having is also wide enough to swallow a real firing on an
irregular cron (`0 9,10 * * *` has a 23-hour maximum gap and a one-hour minimum
one), and skipping a scheduled sync to save a little work is the exact failure
this change exists to remove. The cost is one extra run per login — bounded, and
the same run the schedule would have performed anyway. A welcome side effect:
installing a schedule now performs the first sync immediately instead of waiting
for tomorrow.

### 2. Version-pinned interpreter — VERIFIED TRUE, made DETECTABLE (not "resilient")

`buildSchedulerReference` bakes `resolve(options.nodePath || process.execPath)`
into `ProgramArguments[0]`. Under any version manager that is a version-pinned
path — `~/.nvm/versions/node/v22.5.0/bin/node`, Homebrew's `node@22`, Volta,
fnm, asdf — so a routine `nvm install` deletes the exact binary every scheduled
run depends on, and launchd then fails to spawn forever.

I chose **detectable over resilient**, and the reason is not effort. Making it
resilient means resolving `node` through `PATH` at run time, which hands the
choice of interpreter to whatever ambient environment launchd happens to pass.
That is precisely the ambient authority `safeIngestEnvironment` exists to
remove, and I am not willing to trade a credential-adjacent property for a
convenience. So the absolute pinned path stays, and the breakage is made loud in
three places:

- install warns when the interpreter path carries a version, and says the repair
  is to reinstall the schedule after a Node upgrade;
- `--status` reports `interpreter_present: false` and warns "every scheduled run
  is failing to start" the moment the binary is gone, instead of reporting a
  loaded, drift-free, healthy agent that cannot run;
- and the consequence is caught downstream anyway, because per-source freshness
  now fails acceptance and names the source that stopped.

### 3. Nothing is scheduled on Windows or Linux — made HONEST, not built

No Windows service supervision here; that is a separate package. What is fixed is
the pretending. `buildSchedulerReference` refuses non-macOS before any expectation
is written, so on those platforms the source correctly carries no expectation and
the Worker reports it `unscheduled` — and acceptance now surfaces that as a named
WARN reading "NO REFRESH IS SCHEDULED … it will not update until a schedule is
set", instead of the old check passing it in silence. An unscheduled source is
never also called stale, because no claim was ever made about it.

## Tests

`test/acceptance-freshness.test.mjs`, 29 assertions, registered in the
`npm test` chain after `test/freshness.test.mjs`. The freshness payload each
fixture is judged against is produced by the **Worker's own `freshnessReport`**
from source-table rows, so the test also proves acceptance and `brain sources`
cannot disagree about the same install.

Nine more assertions were added to `test/drive-scheduler.test.mjs` (78 total,
all passing) covering catch-up-at-load, the reason being present in the
generated definition, the version-pinned interpreter warning at install, the
absence of that warning for a stable path, and `--status` reporting a vanished
interpreter.

## The discrimination probe

A test that passes against the buggy code proves nothing. I restored the old
max-across-sources block in `tierData` verbatim, left `freshnessVerdicts`
exported so the probe would measure behaviour rather than a missing import, and
ran the new file:

```
FAIL  a source dead for six months FAILS the run, even beside a source written seconds ago
FAIL  the failure NAMES the stale source, because "something is stale" is not actionable
PASS  and does not blame the source that is actually current
FAIL  the failure says how long it has been dead
FAIL  and says what it was supposed to do, so the claim is checkable
FAIL  the consequence is stated: material added since is invisible, not merely old
PASS  it is a FAIL, not a warning: this is the instrument a guarantee is judged against
FAIL  no check anywhere in the tier calls this corpus fresh
PASS  a source with no refresh expectation is not stale after 400 days
PASS  and the run still passes overall
FAIL  but it is not hidden either: the report says how many are never judged
FAIL  an automatable source with no schedule is reported, not silently green
FAIL  it is a warning, because an absent schedule is not a dead corpus
FAIL  and it says plainly that nothing will refresh it
PASS  no check claims it is fresh
PASS  an unscheduled source is never ALSO called stale, three days after its last read
FAIL  and the headline refuses the vacuous "0 of 0 current" green
PASS  every scheduled source current passes the whole tier
PASS  six hours late on a daily schedule is still current, not a warning
FAIL  the passing line counts the sources it actually judged
PASS  a Worker with no freshness endpoint FAILS rather than passing silently
PASS  and says freshness is unverified rather than implying it is fine
PASS  a Worker that cannot read its own sources table FAILS
PASS  a 200 with no per-source list is not a pass
PASS  an install with no registered sources makes no freshness claim at all
PASS  a backend this instrument does not cover is skipped and named, not failed
FAIL  a broken connector fails and repeats its cause verbatim
FAIL  a source expected to refresh that never has is its own named failure
FAIL  the headline counts both, so the summary line cannot understate the damage

acceptance freshness: 14/29 passed
PROBE EXIT=1
```

15 of 29 assertions collapse against the old logic, including every one that
matters. The 14 that still pass are the pure-function cases, which never touched
`tierData` — worth noticing, because it is the exact shape of a test file that
would have looked green while proving nothing had I written only those.

The fix was then restored and the file returns 29/29.

## Full suite

```
npm test > /tmp/freshness.log 2>&1; echo $? > /tmp/freshness-exit.txt
$ cat /tmp/freshness-exit.txt
0
```

Read from the file, because piping to `tail` reports the exit code of `tail`.

## What I would still like a second opinion on

`RunAtLoad true` means `brain connect drive` starts an ingest the moment the
schedule is bootstrapped. I think that is right — the alternative is an install
that has scheduled nothing observable until tomorrow — but it does mean a second
`--install` run in quick succession can hit the existing "refuses to replace a
scheduler while its job is running" guard. That guard is correct and its message
says exactly what happened, so I left it alone rather than softening a safety
check to smooth over a first-run edge.

The `unscheduled` verdict is a WARN rather than a FAIL. A source nobody has
scheduled is not a dead corpus, and failing the whole acceptance run for a
deliberate manual-sync setup would be the same over-correction in the other
direction. It is named on its own line and it carries the consequence in
capitals, so it cannot pass quietly, which was the requirement.
