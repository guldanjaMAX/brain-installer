# WP: `brain load` — install day in one command

## What this is

Install day used to be seven or more separate ingest commands. The operator had to
remember which ones applied to this client, run them in an order nobody had written
down, and then hold seven separate reports in their head to answer the only question
the client actually asks: is my stuff in there now.

`brain load <manifest>` is that whole day in one line. It reads the manifest, runs
every source that is both switched on and connected right now, skips the rest with a
stated reason, and prints one report.

## Command surface

```
brain load <manifest> [--dry-run] [--only a,b] [--skip a,b] [--limit n]
```

| Flag | Behaviour |
|---|---|
| (none) | Sweep every enabled, connected source in plan order |
| `--dry-run` | Read every source, report what it holds, send NOTHING. No state written |
| `--only a,b` | Run only these. This is the rerun-one-source-after-fixing-it path |
| `--skip a,b` | Run everything except these |
| `--limit n` | Cap every source. Everything it touches is reported as an incomplete load |
| `--reset` | **Refused**, deliberately. See "resume" below |

Selectors are the `corpora` keys in the manifest, with the obvious short forms
resolved: `drive` to `google_drive`, `mail` to `gmail`, `gcal` to `calendar`,
`iphone` to `iphone_backup`. A name that is not in the manifest is refused rather
than quietly sweeping nothing.

Exit code is non-zero when a source failed, but only **after** the whole report has
printed. The exit code is for the script; the report is for the person.

## Source order, and why

Cheap and fast first, long bulk last, for a reason that is about the person watching
rather than about throughput: the first minutes of a first load are when a client
decides whether this thing is real. A sweep that opens with forty silent minutes of
Drive extraction has spent its best moment on the least interesting source.

| # | Source | Why here |
|---|---|---|
| 10 | calendar | Smallest payload in the product, incremental through Google's own sync token, usually finishes while the operator is still talking. Answers "who did I meet, and when", which reads as magic in a way a file count does not |
| 20 | imessage | Local SQLite behind a watermark. No remote API, so nothing here can be rate-limited or refused by a third party mid-sweep |
| 30 | whatsapp | Same shape: a local outbox, drained from a cursor |
| 40 | upload | The folders the operator pointed at. Local disk, bounded by what was chosen, and usually the priority slice the client already said would be worth it on its own |
| 50 | gmail | First remote bulk source. Incremental after run one, but a first mailbox is thousands of messages over a network we do not control |
| 60 | google_drive | The long pole on purpose: biggest corpus, slowest extraction (PDF, Docs, Sheets, Slides). Everything above it has already reported by the time it is still running |
| 70 | iphone_backup | Dead last, and **not** because of size. It is the only leg with no cursor: it re-reads the whole backup every time. An interrupted sweep must never redo it before reaching a source that would have resumed cheaply |
| — | zoom | No number because it has no pull. Zoom posts each new transcript to the brain's own webhook, so a sweep has nothing to fetch. Always skipped, with that sentence |

## How the work is derived

From `m.corpora`, never from a list in the code. The registry in `loadSourceRegistry()`
only answers "does this build have a loader for what the manifest asked for". Three
consequences, all deliberate:

- A source the client does not have never appears as work.
- A source the manifest declares that this build cannot load is reported as exactly
  that, out loud, instead of vanishing from the sweep. That is the drift a hardcoded
  list produces as connectors are added, and it is the failure mode this design exists
  to prevent.
- A `_comment` key inside `corpora` is not a source.

## Failures and skips

**Failure isolation is the single most important behaviour here.** The operator running
this is usually standing next to the client. A dead Gmail token must not be the reason
Drive and Calendar never loaded. Every leg is caught, the sweep continues, and every
failure is reported at the end with the exact command to retry just that one source.

Isolation runs one level deeper than the source, too: a manifest can declare several
folders under `corpora.upload`, each its own named and separately reversible load. One
unreadable folder does not stop the next one.

Skips are four distinct messages, never collapsed into one, because "you do not use
this" is not the same fact as "this is broken":

| Situation | What the report says |
|---|---|
| `enabled: false` | `not enabled in this manifest, so this client does not use it` |
| enabled, no credential/device on this machine | `enabled, but not connected on this machine: <the probe's own words>` plus a `fix:` line with the connect command |
| enabled, no loader in this build | `enabled in this manifest, but brain <version> has no loader for it` |
| push-only connector | `Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull` |
| excluded by the operator | `not selected by --only` / `excluded by --skip` |

## Honesty rules, enforced in code

- A skipped source is rendered in the skipped list and never in the loaded list.
- A connector that returns a validated explicit completion but no counts is
  described as `completed, with counts unknown (not zero)`, and the totals line
  says how many sources could not report, so the number beside it reads as a
  floor. Returning nothing is not a completion receipt and fails closed.
- A source that loaded some legs and failed others is `partly loaded`, in yellow, with
  the failing leg named `NOT loaded` beside the one that worked.
- The closing warning counts absent and partial separately. Adding them would report a
  source that half loaded as missing, which is dishonesty in the other direction.
- A dry run reports `document(s) WOULD be sent`, never created/updated/unchanged, which
  are load counters.

## Resume

`brain load` keeps **no cursor of its own**. Every source already owns durable resume
state (a content-hash map, a Google sync token, a chat.db watermark, an outbox
sequence), and a second cursor layered on top would eventually disagree with the first,
at which point one of them is lying about what is loaded and there is no way to tell
which. Re-running the command IS the resume: each leg resumes itself.

`--reset` is refused for the same reason. Reset one source deliberately with
`brain ingest <manifest> --from drive --reset`.

A test asserts that no `.brain-load*` file is ever written next to the manifest.

## Changes to existing code

Three surgical edits, none of which changes existing behaviour:

1. `cmdIngest`'s local-folder half was lifted out unchanged into an exported
   `cmdIngestLocal(m, manifestPath, flags)`. It used to be reachable only through
   `cmdIngest`, which reads `process.argv`, so the only way to drive it from another
   command was to forge argv. The sweep now runs the SAME walker an operator runs by
   hand rather than a second copy that could drift.
2. `cmdIngestLocal` and `cmdIngestRemote` now return their tally (and a `{dry_run:true}`
   shape on the preview path). Nothing consumed their return before. Without this the
   two biggest sources in the product would have to report "unknown" counts.
3. `loadSourceRegistry()` takes an optional map of per-source commands, defaulting to
   the real ones. That seam exists because of a discrimination finding, recorded below.

## Live output

All captures below are real runs against a scratch install with an isolated `HOME`, so
no real account was touched. Personas are invented. Paths were rewritten to
`/Users/operator/Brain`; nothing else was edited.

### Full dry sweep: one source runs, eight skipped for four different reasons

```

brain load  Northwind Studio
·     9 source(s) declared in this manifest; 1 will run

  what WOULD be read
    skip     Google Calendar — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     iMessage (this Mac) — enabled, but not connected on this machine: no Messages database exists at /Users/operator/Library/Messages/chat.db. Messages.app has never been signed in for this macOS user (or a non-standard --chat-db path was given).
    skip     WhatsApp (paired device) — not enabled in this manifest, so this client does not use it
    run      Folders on this machine — every readable document under the folders declared in the manifest
               /Users/operator/Brain/client-docs
               /Users/operator/Brain/transcripts
    skip     Gmail — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     Google Drive — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     Zoom cloud recordings — Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull. Recordings made before you connected are never backfilled.
    skip     notion — not enabled in this manifest, so this client does not use it
    skip     slack — enabled in this manifest, but brain 0.1.22 has no loader for it

·     dry run: each source below is READ so it can report what it holds. Nothing is sent to the brain, and no resume state is written.

── [1/1] Folders on this machine  starting
·     walking /Users/operator/Brain/client-docs
·     2 candidate file(s), 0 skipped during the walk
·     private prefixes enforced: _private

·     2 document(s) would be sent; 0 unchanged; 0 skipped

ok    dry run, nothing was sent

  first few that WOULD be sent:
    renewal-terms.md  (no date, 106 chars)
    scope-of-work.md  (no date, 85 chars)
·     walking /Users/operator/Brain/transcripts
·     1 candidate file(s), 0 skipped during the walk
·     private prefixes enforced: _private

·     1 document(s) would be sent; 0 unchanged; 0 skipped

ok    dry run, nothing was sent

  first few that WOULD be sent:
    2026-03-04-kickoff.md  (2026-03-04, 115 chars)
ok    Folders on this machine: 2 of 2 folder(s) loaded  0.1s


  load report — DRY RUN, nothing was sent

  WOULD LOAD (1)
    loaded  Folders on this machine   2 of 2 folder(s) loaded  0.1s
             client-docs: 2 document(s) WOULD be sent, 0 unchanged
             transcripts: 1 document(s) WOULD be sent, 0 unchanged

  NOT LOADED — skipped (8)
    skipped  Google Calendar           enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  iMessage (this Mac)       enabled, but not connected on this machine: no Messages database exists at /Users/operator/Library/Messages/chat.db. Messages.app has never been signed in for this macOS user (or a non-standard --chat-db path was given).
             fix: brain connect imessage <manifest>
    skipped  WhatsApp (paired device)  not enabled in this manifest, so this client does not use it
    skipped  Gmail                     enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  Google Drive              enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  Zoom cloud recordings     Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull. Recordings made before you connected are never backfilled.
    skipped  notion                    not enabled in this manifest, so this client does not use it
    skipped  slack                     enabled in this manifest, but brain 0.1.22 has no loader for it
             fix: nothing was loaded from it; put its documents in a folder and load that instead

  NOT LOADED — failed (0)
    none

  totals: 1 loaded, 8 skipped, 0 failed, of 9 declared
  3 document(s) WOULD be sent
  8 of 9 declared source(s) are NOT in the brain. The lists above say which, and why.
```

Exit code 0.

### One folder was moved away: the other folder in the same source still loads

```

brain load  Northwind Studio
·     9 source(s) declared in this manifest; 1 will run

  what WOULD be read
    skip     Google Calendar — not selected by --only
    skip     iMessage (this Mac) — not selected by --only
    skip     WhatsApp (paired device) — not selected by --only
    run      Folders on this machine — every readable document under the folders declared in the manifest
               /Users/operator/Brain/client-docs
               /Users/operator/Brain/transcripts
    skip     Gmail — not selected by --only
    skip     Google Drive — not selected by --only
    skip     Zoom cloud recordings — not selected by --only
    skip     notion — not selected by --only
    skip     slack — not selected by --only

·     dry run: each source below is READ so it can report what it holds. Nothing is sent to the brain, and no resume state is written.

── [1/1] Folders on this machine  starting
fail  client-docs: no such folder: /Users/operator/Brain/client-docs
·     walking /Users/operator/Brain/transcripts
·     1 candidate file(s), 0 skipped during the walk
·     private prefixes enforced: _private

·     1 document(s) would be sent; 0 unchanged; 0 skipped

ok    dry run, nothing was sent

  first few that WOULD be sent:
    2026-03-04-kickoff.md  (2026-03-04, 115 chars)
warn  Folders on this machine: 1 of 2 folder(s) loaded, and 1 did NOT load  0.1s


  load report — DRY RUN, nothing was sent

  WOULD LOAD (1)
    partly loaded  Folders on this machine   1 of 2 folder(s) loaded  0.1s
             client-docs: NOT loaded — no such folder: /Users/operator/Brain/client-docs
             transcripts: 1 document(s) WOULD be sent, 0 unchanged
             part of this source is NOT in the brain: 1 of 2 did not load
             retry just this one: brain load <manifest> --only upload

  NOT LOADED — skipped (8)
    skipped  Google Calendar           not selected by --only
    skipped  iMessage (this Mac)       not selected by --only
    skipped  WhatsApp (paired device)  not selected by --only
    skipped  Gmail                     not selected by --only
    skipped  Google Drive              not selected by --only
    skipped  Zoom cloud recordings     not selected by --only
    skipped  notion                    not selected by --only
    skipped  slack                     not selected by --only

  NOT LOADED — failed (0)
    none

  totals: 1 loaded (1 only partly), 8 skipped, 0 failed, of 9 declared
  1 document(s) WOULD be sent
  8 of 9 declared source(s) are NOT in the brain, and 1 loaded only in part. The lists above say which, and why.
```

Exit code 0. Note `client-docs: NOT loaded` sitting beside `transcripts: 1 document(s)
WOULD be sent`, and the source demoted to `partly loaded`.

### Both folders moved: the source fails outright, and the sweep still reports

```

brain load  Northwind Studio
·     9 source(s) declared in this manifest; 1 will run

  what WOULD be read
    skip     Google Calendar — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     iMessage (this Mac) — enabled, but not connected on this machine: no Messages database exists at /Users/operator/Library/Messages/chat.db. Messages.app has never been signed in for this macOS user (or a non-standard --chat-db path was given).
    skip     WhatsApp (paired device) — not enabled in this manifest, so this client does not use it
    run      Folders on this machine — every readable document under the folders declared in the manifest
               /Users/operator/Brain/client-docs
               /Users/operator/Brain/transcripts
    skip     Gmail — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     Google Drive — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     Zoom cloud recordings — Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull. Recordings made before you connected are never backfilled.
    skip     notion — not enabled in this manifest, so this client does not use it
    skip     slack — enabled in this manifest, but brain 0.1.22 has no loader for it

·     dry run: each source below is READ so it can report what it holds. Nothing is sent to the brain, and no resume state is written.

── [1/1] Folders on this machine  starting
fail  client-docs: no such folder: /Users/operator/Brain/client-docs
fail  transcripts: no such folder: /Users/operator/Brain/transcripts
      continuing with the remaining sources


  load report — DRY RUN, nothing was sent

  WOULD LOAD (0)
    nothing

  NOT LOADED — skipped (8)
    skipped  Google Calendar           enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  iMessage (this Mac)       enabled, but not connected on this machine: no Messages database exists at /Users/operator/Library/Messages/chat.db. Messages.app has never been signed in for this macOS user (or a non-standard --chat-db path was given).
             fix: brain connect imessage <manifest>
    skipped  WhatsApp (paired device)  not enabled in this manifest, so this client does not use it
    skipped  Gmail                     enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  Google Drive              enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  Zoom cloud recordings     Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull. Recordings made before you connected are never backfilled.
    skipped  notion                    not enabled in this manifest, so this client does not use it
    skipped  slack                     enabled in this manifest, but brain 0.1.22 has no loader for it
             fix: nothing was loaded from it; put its documents in a folder and load that instead

  NOT LOADED — failed (1)
    FAILED  Folders on this machine   no such folder: /Users/operator/Brain/client-docs | no such folder: /Users/operator/Brain/transcripts
             retry just this one: brain load <manifest> --only upload

  totals: 0 loaded, 8 skipped, 1 failed, of 9 declared
  0 document(s) WOULD be sent
  9 of 9 declared source(s) are NOT in the brain. The lists above say which, and why.

fail  1 of 1 source(s) could not even be previewed.
      Fix the reported cause, then re-run just that one: brain load <manifest> --only <source>
```

Exit code **1**, printed after the full report.

### `--skip`

```

brain load  Northwind Studio
·     9 source(s) declared in this manifest; 0 will run

  what WOULD be read
    skip     Google Calendar — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     iMessage (this Mac) — enabled, but not connected on this machine: no Messages database exists at /Users/operator/Library/Messages/chat.db. Messages.app has never been signed in for this macOS user (or a non-standard --chat-db path was given).
    skip     WhatsApp (paired device) — not enabled in this manifest, so this client does not use it
    skip     Folders on this machine — excluded by --skip
    skip     Gmail — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     Google Drive — enabled, but not connected on this machine: no Google account is connected on this machine
    skip     Zoom cloud recordings — Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull. Recordings made before you connected are never backfilled.
    skip     notion — not enabled in this manifest, so this client does not use it
    skip     slack — enabled in this manifest, but brain 0.1.22 has no loader for it

·     dry run: each source below is READ so it can report what it holds. Nothing is sent to the brain, and no resume state is written.


  load report — DRY RUN, nothing was sent

  WOULD LOAD (0)
    nothing

  NOT LOADED — skipped (9)
    skipped  Google Calendar           enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  iMessage (this Mac)       enabled, but not connected on this machine: no Messages database exists at /Users/operator/Library/Messages/chat.db. Messages.app has never been signed in for this macOS user (or a non-standard --chat-db path was given).
             fix: brain connect imessage <manifest>
    skipped  WhatsApp (paired device)  not enabled in this manifest, so this client does not use it
    skipped  Folders on this machine   excluded by --skip
    skipped  Gmail                     enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  Google Drive              enabled, but not connected on this machine: no Google account is connected on this machine
             fix: brain connect google --scopes drive,gmail,calendar
    skipped  Zoom cloud recordings     Zoom posts each new transcript to this brain's webhook on its own, so a sweep has nothing to pull. Recordings made before you connected are never backfilled.
    skipped  notion                    not enabled in this manifest, so this client does not use it
    skipped  slack                     enabled in this manifest, but brain 0.1.22 has no loader for it
             fix: nothing was loaded from it; put its documents in a folder and load that instead

  NOT LOADED — failed (0)
    none

  totals: 0 loaded, 9 skipped, 0 failed, of 9 declared
  0 document(s) WOULD be sent
  9 of 9 declared source(s) are NOT in the brain. The lists above say which, and why.
```

### A typo in a selector is refused, not silently swept

```
fail  --only slak is not a source in this manifest.
      Sources declared here: calendar, imessage, whatsapp, upload, gmail, google_drive, zoom, slack, notion
```

Exit code 1.

### `--reset` is refused

```
fail  brain load will not take --reset.
      A sweep-wide reset would discard every source's resume progress at once, which is
      almost never what is wanted and is not undoable. Reset one source deliberately:
      brain ingest <manifest> --from drive --reset
```

Exit code 1.

## Tests

`test/load-all.test.mjs`, registered in the `npm test` chain between
`test/ingest-run.test.mjs` and `test/drive-live-fixture.test.mjs`. **62 assertions,
all passing.**

Everything the sweep orchestrates is real: the real planner, the real manifest reading,
the real registry (labels, order, Zoom's push-only skip), the real report renderer, and
in two cases the real local-folder walker end to end with `globalThis.fetch` replaced by
a throw, so "sent nothing" is proved rather than asserted. Only the per-source producers
are scripted, because the point of these cases is what the sweep does AROUND a producer.

What it proves:

- a source failing mid-sweep does not stop the sources after it, and IS reported
- every runnable source ran exactly once, in the documented plan order
- a skipped source appears only in the skipped list, for all four skip reasons
- the four skip reasons stay four different messages
- `--dry-run` reaches every leg, sends nothing, and (end to end) touches no network
- `--dry-run` prints the scope BEFORE the sweep, so a client can see it first
- resume continues from each source's own state and redoes nothing
- `brain load` writes no state of its own
- `--only`, `--skip`, alias resolution, and a refused typo
- `--reset` refused
- the totals match what the producers actually reported
- an absent count prints as unknown, never as zero
- a partly loaded source is not counted as missing entirely
- one unreadable folder does not stop the next folder in the same source
- the REAL registry forwards `--dry-run`, `--limit` and the right `--from` to every
  per-source command, and never passes `--reset`
- a malformed corpus block skips that one source with the problem named, rather than
  aborting the sweep the other sources were about to be part of

## Discrimination pass

Six deliberate breaks, each restored immediately. **The first pass found two real gaps
in my own tests, and both are recorded here rather than quietly fixed.**

| # | Break | Result |
|---|---|---|
| 1 | Rethrow instead of continue on a leg failure (isolation removed) | **23 FAILURES**, led by `a source failing mid-sweep does not stop the sources after it` — caught |
| 2 | Render skipped entries in the loaded list | **4 FAILURES**, one per skip reason: `WhatsApp: loaded=true skipped=true` — caught |
| 3 | Drop `--dry-run` on the way into one leg of the real registry | **PASSED — NOT CAUGHT.** Every dry-run case scripted `legs` and never exercised the real table's own wiring |
| 4 | Force `reset: true` onto every leg past cmdLoad's own guard | **PASSED — NOT CAUGHT.** The scripted resume producer ignored `reset`, so it would have processed one unit whatever the sweep did |
| 5 | Report an unknown count as `0 created, 0 updated, 0 unchanged` | **3 FAILURES**, including the totals floor line — caught |
| 6 | Ignore `--only` entirely | **2 FAILURES**: `["calendar","gmail","google_drive"]` instead of `["gmail","google_drive"]` — caught |

Breaks 3 and 4 were real holes, not test noise. Both are now closed:

- **3** added the `commands` injection seam to `loadSourceRegistry()` and six assertions
  that drive the REAL table with spies. Re-run of break 3 after the fix:
  `FAIL  the real registry forwards --dry-run to EVERY source, unaltered  ["calendar"]`
- **4** made the scripted resume producer honour `--reset` the way a real connector
  does, plus an assertion that the same producer, told to reset, redoes all three units,
  so the resume test is a measurement rather than a producer that could not tell the
  difference. Re-run of break 4 after the fix:
  `FAIL  re-running the sweep continues from the source's own state instead of redoing the work  ["a","b","c"]`

A seventh break, deleting `--dry-run` from the flags before the legs are built, failed
6 assertions including the end-to-end network-blocked one, which confirms that
assertion is load-bearing and not decorative.

Every break was restored and the suite verified green again immediately after each one.

## Full chain

```
npm test > /tmp/loadall.log 2>&1; echo $? > /tmp/loadall-exit.txt
```

Exit code read back from `/tmp/loadall-exit.txt`: **0**. 2595 `PASS` lines, zero `FAIL`
lines, `load-all: all 62 tests passed` at line 2404 of the log.

## Docs

`onboarding/07-ingest-source-matrix.md` gained a `One command that loads everything`
section stating what it does, what it does not do, the flags, and how to read the
report, plus a pointer at the top of the summary table. No new file was added under
`onboarding/`, so the package-privacy allowlist needed no new entry; the scan passes
(`published package contains 339 reviewed files and no client-private paths`).

CLI help gained the `brain load` line and a paragraph under the ingest notes.

## Owner voice

I have watched myself do install day the old way and I know exactly where it goes
wrong. It is never the hard part. It is the fifth command, the one for the source this
particular client happens to have, the one I do not run because I am talking. Nobody
notices. Three weeks later they ask something the brain should obviously have known,
and the answer is that I forgot a command in front of them.

So the thing I actually wanted was not a shortcut. It was a report I cannot argue with.
`brain load` runs everything it can and then tells me, in three lists, what is in and
what is not. If a token is dead it says which one and what to type. If a source is not
connected it says so instead of pretending. If a connector cannot tell me how many
documents it moved, it says unknown, because a zero there is a lie I would repeat to a
client without knowing I was lying.

The part I care most about is that one broken thing does not take the rest down with
it. Standing next to a client, a partial load with an honest list is worth far more
than a clean abort. The abort is tidier. The list is the one that keeps the
relationship.
