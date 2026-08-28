# WP-07 — WhatsApp live capture, the CLI and Node half

Branch `wave1/wp07-whatsapp-cli`, branched from `wave0/connector-gaps` at
`cc6602b`. This is the second half of WP-07: the Go capture daemon shipped
earlier (`evidence/WP-07-go-daemon.md`) and is untouched here. This package
is everything that makes it installable — the drain that moves its outbox
into the brain, the three CLI verbs, and the supervision that keeps it
running.

**The Go source was not modified.** `git diff --name-only <merge-base>..HEAD
-- daemons/` returns zero files.

## What shipped

| Piece | File |
|---|---|
| The drain: outbox → sessionizer → batch push, resumable | `connectors/whatsapp.mjs` |
| Resident-daemon supervision (RunAtLoad + KeepAlive) | `operations/whatsapp-daemon.mjs` |
| Tick drain on the shared scheduler | `operations/whatsapp-drain-scheduler.mjs` |
| `brain connect / ingest --from whatsapp / disconnect` | `brain.mjs` |
| Manifest surface + disclosures | `manifest.schema.json`, `templates/brain.manifest.json` |
| Source kind accepted by the worker | `worker/src/index.js` |
| Support journal source | `support-journal.mjs` |
| Matrix truth | `onboarding/07-ingest-source-matrix.md` |
| Tests (132 assertions) | `test/whatsapp-{capture,ingest,daemon}.test.mjs` |

## Commits

```
7aa636a Matrix: describe WhatsApp live capture, including what is unproven
afa77b3 Prove the WhatsApp drain, the CLI verbs and the supervision
5ddcf97 Wire WhatsApp into the CLI: connect, ingest --from whatsapp, disconnect
8a06f20 Supervise WhatsApp capture: a resident daemon plus a tick drain
1100ff5 WhatsApp drain: read the daemon outbox, sessionize, push
```

## The supervision decision, and why

**A sibling module (`operations/whatsapp-daemon.mjs`), not a shape flag on
the generalized tick scheduler.**

The tick scheduler (`operations/drive-scheduler.mjs`, generalized by WP-06 and
reused verbatim by `brain connect imessage`) is a generator for
run-to-completion jobs. Three of the behaviours that make it safe are
actively wrong for a process whose steady state is "running":

1. It refuses to replace a scheduler while its job is running. For a tick
   that means a pass is mid-flight. For a daemon, running IS the normal
   condition, so refusing would make reinstall unreachable — the operator
   would have to stop capture in order to fix capture.
2. It truncates the log in place. Correct once the writer has exited; against
   a resident process holding the file open at its own offset it produces a
   sparse file that is larger, not smaller.
3. Its `lockf` wrapper enforces one instance. Under `KeepAlive` that is
   launchd's job, and a lock the daemon never releases would fight the very
   restarts `KeepAlive` exists to perform.

Threading a "shape" flag through those would turn three invariants into three
conditionals inside the code path that keeps unattended Drive and iMessage
ingest safe. So the tick model and its tests are untouched, and the sibling
owns the persistent shape: `RunAtLoad` + unconditional `KeepAlive`, a 30s
restart throttle, no calendar interval, no lock, and log capping only at the
two moments the process is provably stopped (install, before bootstrap;
remove, after bootout). What IS shared is reused rather than re-typed:
`schedulerIdentity` for labels and paths, `rotateDriveSchedulerLogs`, and the
launchctl environment scrub.

The honest cost, stated in the module rather than hidden: **between install
and removal the daemon's log is not rotated**, because the only mechanism
available cannot be applied truthfully to an open file.

The DRAIN is the opposite shape — a run-to-completion pass — so it needed no
new machinery and goes through the shared generalized scheduler as a spec,
exactly as iMessage does.

A finding recorded while testing: the shared `schedulerIdentity` helper hands
every plan a `lockPath` field, including the daemon's. The daemon module never
reads it, so the resident process genuinely takes no lock — but the field is
vestigial on that plan. The test asserts against the rendered plist and the
program arguments (where the truth is) rather than against the unused field.

## D-2 (opt-in vs default-on) is undecided, so this is opt-in twice

Owners have not decided the default posture. Live capture therefore requires
BOTH `corpora.whatsapp.enabled: true` in the manifest AND `--accept-risk` on
the command. The disclosure prints every time, not only the first, and a run
without `--accept-risk` installs nothing. Both required disclosures are
carried in the product's voice, in the CLI, the manifest template, the schema
and the matrix: the terms-of-service gray area with its real if small ban
risk, and history depth at link time being only what the phone transfers.

## Full test suite

Run from a clean `npm ci --ignore-scripts` in this worktree. Exit code was
captured to its own file and read back from there, because piping to `tail`
masks it.

```
$ npm test > /tmp/wp07-fullsuite.txt 2>&1; echo $? > /tmp/wp07-exitcode.txt
$ cat /tmp/wp07-exitcode.txt
0
$ grep -cE "^PASS" /tmp/wp07-fullsuite.txt
2265
$ grep -cE "^FAIL" /tmp/wp07-fullsuite.txt
0
```

**Exit code 0. 2265 PASS, 0 FAIL.** The branch point was 2133 passing; the
132 added assertions are exactly this package's three files:

```
whatsapp capture: all 50 tests passed
whatsapp CLI: all 36 tests passed
whatsapp daemon supervision: all 46 tests passed
```

## The three suites, verbatim

```
=== capture suite (verbatim, full) ===
PASS  the first drain reports rows seen, rows pushed and the cursor it reached
PASS  both conversations became session documents keyed by their first message id
PASS  every document is tagged platform whatsapp
PASS  the owner's manifest name speaks for outbound messages, not a phone number
PASS  the drain stamps drained_at, so an operator can see the backlog is clear
PASS  a second drain re-reads nothing and sends nothing
PASS  a media marker is counted as skipped rather than silently dropped
PASS  no document contains the bare [audio] marker
PASS  a thread of nothing but media markers produces zero documents
PASS  the rows are still marked drained, so they do not accumulate forever
PASS  a dispatch failure aborts the pass rather than advancing past unsent rows
PASS  the cursor stops at the last page whose documents were acknowledged
PASS  the interrupted rows are still unmarked in the outbox, not lost
PASS  the resumed drain re-reads only the unacknowledged page and finishes
PASS  mid-loop kill: zero gaps, every captured message reached a delivered document
PASS  mid-loop kill: zero duplicates, no message lands under two different document ids
PASS  mid-loop kill: any re-sent document is byte-identical to its first send
PASS  once resumed and caught up, a further drain is a no-op
PASS  a failure flushing quiet conversations also aborts rather than half-reporting
PASS  the cursor is at the end, because every row really was read
PASS  the conversations that had not been flushed are still held in the snapshot
PASS  the resume emits the conversations the interrupted flush never delivered
PASS  final-flush kill: zero gaps, every captured message reached a delivered document
PASS  final-flush kill: zero duplicates, no message lands under two different document ids
PASS  final-flush kill: any re-sent document is byte-identical to its first send
PASS  a conversation that could still grow is held open, not emitted early
PASS  the open conversation rides in the state file alongside the cursor
PASS  the resumed drain emits exactly one document, not one per process run
PASS  that document is keyed by the FIRST message, so the conversation was continued
PASS  all four messages are inside it: the restart did not split the conversation
PASS  a late history chunk with an older timestamp is still drained
PASS  an outbox row maps onto the sessionizer's input shape one-for-one
PASS  an outbound row carries no sender name, so the owner label speaks for it
PASS  the state file is written owner-only: it holds message text
PASS  a corrupt state file restarts the drain instead of refusing to run
PASS  a missing outbox is reported as not-yet-paired, not as a crash
PASS  a missing daemon binary throws a named error, not a stack trace about ENOENT
PASS  the refusal lists every path it looked in
PASS  the refusal hands over the exact build command instead of a vague suggestion
PASS  the refusal says plainly that no download-on-connect exists yet
PASS  it states nothing was paired or installed, so the operator knows the machine is unchanged
PASS  an explicitly supplied binary is used and its source is reported
PASS  the environment override is honored the same way
PASS  the manifest knob is honored, so an install can pin its own binary
PASS  a non-executable file is not accepted as the daemon
PASS  the Windows binary name is the cross-compiled .exe the build script emits
PASS  the daemon's environment is scrubbed to OS basics plus its data directory
PASS  the ToS gray-area and ban risk are stated, not hinted at
PASS  history depth at link time is disclosed as the phone's choice, not the full archive
PASS  an outbox opened for writing reports itself writable and counts its backlog

whatsapp capture: all 50 tests passed

=== CLI suite (PASS/FAIL lines only, verbatim) ===
PASS  the drain reads the fixture outbox and reports counts
PASS  both conversations were sent as session documents
PASS  every document carries source_type whatsapp, so forget --source whatsapp scopes to it
PASS  the owner's manifest display name speaks for outbound messages
PASS  the media-only row never became a document
PASS  an indexing receipt opened and a ready receipt closed the run, kind whatsapp
PASS  drain state landed beside the manifest under the source's name
PASS  a second drain through the CLI is incremental: nothing re-read, nothing re-sent
PASS  draining before pairing says so instead of failing on a missing file
PASS  connect with no daemon binary fails with a readable message, not a stack trace
PASS  that message carries the build command the operator should run
PASS  nothing was installed: no LaunchAgent was touched before the binary check
PASS  no receipt or expectation was posted either
PASS  without --accept-risk nothing is paired and the command says so
PASS  the refusal repeats the exact command that would opt in
PASS  no agent was installed by the refused run
PASS  connect refuses while corpora.whatsapp.enabled is not declared true
PASS  connect on Windows refuses and calls it a missing installer, not a missing capability
PASS  pairing is detected from the daemon's own pair-success line
PASS  the link-time history is counted from the daemon's chunk lines
PASS  the wizard waits for history to go quiet rather than exiting on pairing
PASS  an already-paired machine is recognised as a reconnect, not a fresh pairing
PASS  a daemon that dies before pairing reports why, with its last lines
PASS  a logout during pairing is named and nothing is installed
PASS  an unscanned QR times out with the phone steps, not a hang
PASS  connect pairs, installs the daemon, drains, then installs the drain tick, in that order
PASS  the supervised daemon is installed with the binary that was actually paired
PASS  the initial drain ran and delivered the fixture conversations
PASS  a freshness expectation is registered so brain sources can be honest about staleness
PASS  connect reports the pairing it observed
PASS  disconnect stops the drain tick BEFORE the daemon, so no pass races the final one
PASS  disconnect reports both agents removed
PASS  the freshness expectation is cleared, so a disconnected source is not reported stale forever
PASS  a final drain and an open-session flush both ran during removal
PASS  disconnect works with corpora.whatsapp.enabled already false
PASS  an unreachable brain never blocks stopping the background processes
whatsapp CLI: all 36 tests passed

=== supervision suite (verbatim, full) ===
PASS  the daemon label is client-scoped and distinct from every tick agent
PASS  the LaunchAgent runs the compiled daemon directly, with no node wrapper
PASS  RunAtLoad and KeepAlive are both set: this is a resident process, not a tick
PASS  there is no StartCalendarInterval: a daemon is never scheduled
PASS  a restart throttle keeps a broken install from spinning the battery flat
PASS  the working directory is the daemon's own data directory, never an inherited cwd
PASS  the plist carries WA_DATA_DIR and OS basics only
PASS  no credential material of any kind reaches the resident process
PASS  the daemon's two SQLite files are resolved under one data directory
PASS  operations.whatsapp_data_dir moves the daemon's directory
PASS  the daemon writing one directory while the drain reads another is impossible by construction
PASS  the drain label is distinct from the daemon's
PASS  the drain defaults to every minute, expressed as one empty calendar entry
PASS  an every-minute drain derives a one-minute freshness expectation
PASS  the drain LaunchAgent invokes the shared scheduler runner with a configuration binding
PASS  the child that runner spawns is the real CLI verb, so the credential gate applies to it too
PASS  the manifest cron knob overrides the built-in default
PASS  all four agents have distinct labels, plists and logs
PASS  adding the persistent shape left Drive's identity exactly as it was
PASS  adding the persistent shape left iMessage's identity exactly as it was
PASS  the resident daemon takes no single-instance lock: launchd owns restarts
PASS  the tick drain still routes its child through the shared lockf wrapper
PASS  a non-Mac install refuses and says Windows supervision is not built
PASS  corpora.whatsapp.enabled must be declared before the daemon can be installed
PASS  the reference still resolves with the corpus off, so removal stays reachable
PASS  installing without a daemon binary refuses with the build command, not a stack trace
PASS  install writes the plist and reports itself loaded
PASS  install checks, enables, then bootstraps, in that order
PASS  nothing was booted out, because nothing was loaded to begin with
PASS  the plist on disk is exactly what the plan renders
PASS  the data directory is created private to the owner
PASS  status reports installed, loaded, running, with the pid launchd gave
PASS  status distinguishes a paired session from an empty data directory
PASS  reinstalling while the daemon is running succeeds instead of refusing
PASS  the running daemon is booted out before its definition is replaced
PASS  removal boots the daemon out and deletes its definition
PASS  removal stops the process before deleting the plist
PASS  removing an already-removed daemon is a no-op, not an error
PASS  removal works with corpora.whatsapp.enabled already false
PASS  removal works when the daemon binary has been deleted
PASS  the drain LaunchAgent installs through the shared, already-hardened path
PASS  the drain's plist schedules a tick and carries no credential material
PASS  the drain reports itself installed and loaded with no definition drift
PASS  the drain LaunchAgent is removed and its definition deleted
PASS  the daemon spec names itself as a daemon, not a scheduler
PASS  the module says in its own source that Windows supervision is not built

whatsapp daemon supervision: all 46 tests passed
```

## How the correctness claims were actually proven

A fixture outbox is built in-test with node:sqlite using the same schema
`daemons/whatsapp/internal/outbox/outbox.go` creates, so the column contract
is exercised rather than assumed.

**First drain reports counts; second sends nothing.** Four planted rows: 4
seen, 3 pushed (one is a media marker), 2 documents, cursor 4, backlog 0. The
second pass reads 0 rows and dispatches nothing.

**Kill mid-drain, in both places a kill can land.** This turned out to matter,
and the first version of the test asserted the wrong thing:

- *Inside the page loop* — documents delivered, cursor not yet persisted. The
  cursor stops at the last acknowledged page (asserted: exactly 4 of 6), the
  two unacknowledged rows remain unmarked in the outbox, and the resume
  re-reads exactly that page and finishes.
- *During the final flush of quiet conversations* — the cursor already reached
  the end (asserted: 6), but the still-open sessions are held in the snapshot,
  and the resume delivers them.

Both are then checked identically: every planted message reaches **exactly one
document id** across the pre-kill and post-resume deliveries (zero gaps AND
zero duplicates in one assertion), and any document re-sent after the
interruption is **byte-identical** to its first send. Re-delivery of an
identical document under the same `source_id` is the designed behaviour — the
brain acknowledges it unchanged — and re-sending is always preferred over
skipping. A message appearing under two different document ids would be a
genuine split, and that is what the assertion forbids.

**Snapshot resume does not split a conversation.** Four messages inside one
session gap, drained by two separate `drainOnce` calls with the outbox growing
in between. Result: ONE document, keyed by the first message, containing all
four bodies. Without the snapshot riding in the state file this would be two
documents and the first two messages would be lost.

**Media-only rows never become documents.** A marker is classified by the
shared `messageRowDisposition` and counted as skipped rather than dropped
silently, so "why is this thread thinner than my phone shows" has an answer. A
thread of nothing but `[audio]`/`[image]`/`[video]` produces zero documents
while still being marked drained, so it cannot accumulate forever.

**Connect fails cleanly with a missing binary.** A named
`DaemonBinaryMissingError`, listing every path it looked in, carrying the
exact build command (`cd daemons/whatsapp && ./build.sh`), stating that no
download-on-connect exists, and stating that nothing was paired or installed.
Asserted at the CLI level too: no LaunchAgent was touched and no receipt or
expectation was posted.

**The cursor is seq, not a timestamp.** Proven directly: a history chunk
inserted after a drain, carrying a timestamp months older than the watermark,
is still drained. A timestamp cursor would strand it permanently.

**Supervision install/uninstall** is proven with the scripted-launchctl
technique the Drive and iMessage scheduler tests already use — a synthetic
manifest in a sandbox home, a launchctl closure recording every invocation,
fixed node/brain paths. Install checks, enables, then bootstraps, in that
order. Reinstalling over a RUNNING daemon succeeds (where a tick would refuse)
and boots the old one out before bootstrapping the new one. Removal boots out
then deletes, is a no-op the second time, and still works with the corpus flag
off and with the binary deleted. The plist is asserted to contain `RunAtLoad`,
`KeepAlive`, the throttle, no `StartCalendarInterval`, and no credential
material of any kind.

## What is genuinely unprovable here, and what was simply not done

**Unprovable without a live WhatsApp pairing** (needs a phone scanning a QR
with a test account; no automated test on a build machine can do it):

- A real pairing. `pairDaemon` is proven against a scripted process emitting
  the daemon's own log lines, which proves the wizard reads those lines
  correctly and proves nothing about whether a phone can scan the code.
- A real link-time history transfer, its depth, and its chunk cadence. The
  wizard's "wait until history goes quiet" window (45s quiet, 10min cap) is
  a reasoned guess against real server behaviour nobody here has observed.
- A real live message arriving and being cited in a brain.
- Whether WhatsApp warns or bans an account for this. The disclosure says
  nobody can quantify it, which remains true.
- Whether launchd actually restarts the daemon after a crash or a reboot.
  `KeepAlive` is asserted in the plist; launchd honouring it is not exercised.

**Not done, as opposed to unprovable:**

- **Windows supervision is not built at all.** No service, no Scheduled Task,
  no Startup entry. No Windows process-supervision pattern exists anywhere in
  this repo to follow, and inventing one deserves its own design pass rather
  than a guess bolted onto this package. `brain connect whatsapp` refuses on
  Windows and calls it a missing installer rather than a missing capability
  (the daemon itself cross-compiles). The matrix says so plainly. The plan's
  acceptance criterion requiring the Windows binary to be tested on the
  designated tester's own PC is therefore NOT met and is not claimed.
- **Binary distribution is still an open product question.** No
  download-on-connect, no bundling, no signing, no notarization. The path is
  supplied explicitly (`--daemon`, `BRAIN_WHATSAPP_DAEMON`, or
  `operations.whatsapp_daemon_path`), or built locally. The Go evidence file
  recommends a checksummed release download; that decision is not mine to
  make and was not made here.
- **The daemon log is not rotated while it runs.** Explained above and in the
  module. Capping happens at install and removal only.
- **No `brain doctor` integration.** WhatsApp capture does not yet report
  itself in the doctor surface; `brain sources` freshness is wired, which is
  what makes staleness visible.
- **No end-to-end run against a real client install.** Nothing in this package
  has run outside a sandbox.

## Merge notes for the integrator

- **No version bump and no CHANGELOG heading**, deliberately, so three
  parallel branches do not collide on those files. The owner-voice paragraph
  for the release entry is below.
- `package.json` has ONE changed line: the three new test files added to the
  test chain. That line is the expected conflict with the sibling branches.
- `brain.mjs` edits are localized next to the existing iMessage commands;
  nothing else was reordered or reformatted.
- The base branch `wave0/connector-gaps` moved during this work (it gained
  `44ca0a0`, a provider-routing change from another session). This branch does
  not contain it; a normal merge resolves that.

### Owner-voice changelog paragraph, for the integrator to consolidate

> WhatsApp can now capture continuously, if you decide you want it. `brain
> connect whatsapp` pairs this Mac with your account as a linked device,
> scans the code in your terminal, loads whatever history your phone sends,
> and from then on new messages reach the brain within about a minute. It is
> off unless you turn it on twice, on purpose: the manifest has to declare it
> and the command needs `--accept-risk`. That is because pairing this way is
> a WhatsApp terms-of-service gray area with a real, if small, risk to the
> account, and because the history you get at link time is only the window
> your phone chooses to send, never your full archive — the per-chat export
> is still how you get that. Capture runs entirely on your machine, holds no
> keys, and stops completely with `brain disconnect whatsapp`. Two honest
> limits: this needs a Mac, because the Windows service installer does not
> exist yet, and none of it has been run against a real WhatsApp account yet
> — treat it as first-run software.
