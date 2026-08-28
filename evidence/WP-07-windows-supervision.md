# WP-07 — Windows supervision for WhatsApp capture

Branch `feat/windows-daemon-supervision`, branched from `wave0/connector-gaps` at
`de8853a`. This is the third piece of WP-07: the Go capture daemon shipped first
(`evidence/WP-07-go-daemon.md`), the drain and the CLI verbs second
(`evidence/WP-07-cli.md`), and both of those ended at the same sentence —
capture is kept alive by a macOS LaunchAgent and Windows has nothing. This is the
Windows half.

## In the owner's voice

WhatsApp is one of the heaviest-hitting sources we can put in a client's brain,
and one of them told me flatly that all his partnerships live there. The protocol
work was already done and the binary already cross-compiled to Windows in under
five seconds. What was missing was the boring half: nothing on a Windows PC kept
the process alive. It died at logout or at reboot and nothing started it again,
while the install record still said the corpus was enabled and the brain still
answered as though everything were current. The client would have believed
capture was running when it was not. That is the exact failure this product keeps
getting bitten by, and it is worse on WhatsApp than almost anywhere else, because
the messages that stop arriving are the ones he told us mattered most.

So the daemon is supervised on Windows now, by a Scheduled Task registered for
the client's own account with no administrator anywhere in the picture. The part
I care about more is what happens when Windows will not give us the mechanism we
want. That question could not be answered from here — whether a standard user can
register a task that runs while signed out depends on the machine's group policy,
not on the Windows version — so the installer does not guess. It registers a
throwaway probe, reads what Windows actually said, deletes it, and installs the
best rung that came back. Then it tells the client which rung it got and what
that rung costs them, in the sentence they would want: capture runs while you are
signed in, or a console window belongs to this and closing it stops capture, or —
on a locked-down machine where no task can be registered at all — this is not
supervision, nothing will restart it, and nothing here will report capture as
live.

That last one is the line I would not trade. An unsupervised install posts no
freshness expectation, and a WhatsApp source with no expectation now reads "no
refresh scheduled" instead of "loaded by hand from a machine we cannot reach, so
never reported as stale". The second sentence is the most reassuring thing that
could possibly be said about a connector the client thinks is capturing their
messages right now. It was what we said. It is not what we say any more.

None of the Windows behaviour has run on a real Windows PC. That is stated
everywhere it could be misread, including at the top of the test file.

## Commits

```
7eac41f Prove the Windows definition, the detection branch, and the honest-status path
e07b5cd connect and disconnect whatsapp on Windows, and say which rung was installed
b21bc63 A live-capture source nothing supervises reads unscheduled, not manual
016a344 Keep WhatsApp capture alive on Windows, with the mechanism the machine actually allows
47505f5 Give the daemon what a Windows task can pass it, and an environment it can run in
```

```
 brain.mjs                               |  171 +++-
 connectors/whatsapp.mjs                 |   34 +-
 daemons/whatsapp/main.go                |   96 ++-
 daemons/whatsapp/main_test.go           |   82 ++
 onboarding/07-ingest-source-matrix.md   |   11 +-
 operations/whatsapp-daemon.mjs          |   13 +-
 operations/whatsapp-drain-scheduler.mjs |    3 +-
 operations/windows-supervision.mjs      | 1332 +++++++++++++++++++++++++++++++
 package.json                            |    2 +-
 test/acceptance-freshness.test.mjs      |   23 +
 test/freshness.test.mjs                 |   23 +
 test/package-privacy.test.mjs           |    1 +
 test/whatsapp-daemon.test.mjs           |   18 +-
 test/whatsapp-ingest.test.mjs           |  194 ++++-
 test/windows-supervision.test.mjs       |  783 ++++++++++++++++++
 worker/src/lib/store-d1.js              |   18 +-
 16 files changed, 2746 insertions(+), 58 deletions(-)
```

## The mechanisms supported, and how each degrades

| Rung | Survives reboot | Survives sign-out | Restarts a dead process | Visible console | Needs admin | `supervised` | Freshness expectation |
|---|---|---|---|---|---|---|---|
| `task-s4u` | yes | **yes** | yes, within 5 min | no (session 0) | no, but needs the batch-logon right | **true** | posted |
| `task-logon` | yes, at next sign-in | no | yes, within 5 min | **yes** | no | **true** | posted |
| `startup-folder` | yes, at next sign-in | no | **no** | yes | no | **false** | **not posted** |
| `none` | — | — | — | — | — | **false** | not posted, and nothing is installed |

Detection walks the ladder best-first and stops at the first rung that registers.
Each probe is a disabled task whose action is `cmd.exe /c exit`, registered under
the product's own Task Scheduler folder and deleted immediately either way; a
probe that could not be deleted is reported rather than swallowed.

**How each rung degrades, stated the way the client hears it.** `task-s4u` costs
nothing and gets one sentence. `task-logon` costs two: capture stops at sign-out
(locking the screen is fine), and each background process owns a console window
that must be minimised rather than closed. `startup-folder` is not supervision and
says so first: if the process stops — a crash, a Windows update, an antivirus
quarantine — nothing starts it again and the only signal is that new messages stop
arriving. `none` installs nothing and `brain connect whatsapp` refuses, naming
that the pairing survived so nobody re-pairs needlessly.

The rung that would have removed `task-logon`'s console window is a GUI-subsystem
Go supervisor. It is **not built here**. Until it is, the cost is stated at
install time rather than silently accepted, which is the honest version of not
having built it.

**Disqualified, and why.** A true Windows Service needs an administrator to
install and runs under the wrong profile, while the linked-device session lives in
the client's own. A Registry `Run` key cannot restart a dead process and is the
single most antivirus-flagged persistence key there is.

## The daemon versus the drain, and why they got different answers

They are genuinely different shapes, so they get different Task Scheduler
settings rather than one compromise.

**The daemon is resident.** It holds a websocket, so its steady state is running.
Its task gets `ExecutionTimeLimit PT0S` — the schema's "no limit", against a
default of three days that would have killed it — and a five-minute repetition
trigger with `MultipleInstancesPolicy IgnoreNew`. That repetition **is** the
supervision: `RestartOnFailure` only fires on a non-zero exit, so a daemon that
exits cleanly or is killed in Task Manager would never come back on that alone.
IgnoreNew is what makes the repetition a self-heal instead of a fork bomb, and it
is the Windows replacement for the Mac module's single-instance reasoning.

**The drain is run-to-completion, so it needed no supervisor at all.** Task
Scheduler was built for exactly this shape: a one-minute repeating trigger runs
it, and `IgnoreNew` is the single-instance guarantee that `lockf` provides on the
Mac — which is why none of the 1,268-line macOS scheduler had to be ported. It
gets a **real** execution time limit (`PT10M`), unlike the daemon, because a
wedged tick holding the IgnoreNew slot forever would silently block every later
tick; that is worse than a killed one.

What the drain lane does keep from the Mac path is what Task Scheduler cannot
give it. A task hands its child the client's full interactive environment and
cannot redirect its output, so the tick runs through a small wrapper that supplies
a scrubbed Windows child environment and a log the run is appended to and capped
against, and refuses to run at all when the manifest's configuration hash no
longer matches the one baked into the task — the same payload the macOS drain
hashes, so the two platforms can never disagree about the same install.

On the `startup-folder` rung the drain is **not installed**: it has to run every
minute and a Startup-folder launcher runs once. Installing something that cannot
work would be worse than saying so, so it says so and names the one command that
loads the outbox by hand.

## The generated definition, pasted

Rendered by `renderWindowsTaskXml` on this machine. Paths are POSIX-shaped
because this is a Mac; the separator is not what is under test.

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>NORTHWIND\priya</Author>
    <Description>Keeps the WhatsApp capture daemon running. It writes a local outbox on this PC and sends nothing anywhere.</Description>
    <URI>\brain-installer\northwind-brain-whatsapp-daemon</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>NORTHWIND\priya</UserId>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>NORTHWIND\priya</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>/Users/priya/.brain/bin/wa-daemon-windows-amd64.exe</Command>
      <Arguments>--data-dir /Users/priya/.brain/whatsapp/northwind-brain --log-file /Users/priya/.brain/logs/northwind-brain-whatsapp-daemon.log</Arguments>
      <WorkingDirectory>/Users/priya/.brain/whatsapp/northwind-brain</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

The drain lane differs where it must, and only there — S4U rung shown, so it
carries the boot trigger the interactive rung cannot have:

```xml
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </BootTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>NORTHWIND\priya</UserId>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  ...
      <LogonType>S4U</LogonType>
  ...
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  ...
      <Command>/opt/node/node.exe</Command>
      <Arguments>/Users/priya/brain-installer/operations/windows-supervision.mjs run <manifest> --brain /Users/priya/brain-installer/brain.mjs --config-hash 505b49b25388154fb38920376ec58c1ec00ed6818da0dd6d031a0b0f8196bb58</Arguments>
```

Four of those settings are there because the Task Scheduler default would have
broken a laptop install: **`DisallowStartIfOnBatteries` and
`StopIfGoingOnBatteries` both default to TRUE** (capture would have refused to
start on battery and stopped the moment the charger came out), `StopOnIdleEnd`
defaults to true (capture would stop when the client came back to the keyboard),
and `ExecutionTimeLimit` defaults to three days.

The last-resort launcher, which says in its own text what it is not:

```
@echo off
rem  Installed by the brain installer as a LAST-RESORT launcher.
rem  It starts capture once, when you sign in. It does NOT restart it if it
rem  stops. Windows Task Scheduler refused to register a task for this
rem  account, which is the only reason this file exists.
rem  Task that would have been used: \brain-installer\northwind-brain-whatsapp-daemon
cd /d "/Users/priya/.brain/whatsapp/northwind-brain"
start "" /b "/Users/priya/.brain/bin/wa-daemon-windows-amd64.exe" --data-dir ... --log-file ...
```

And the disclosure each rung produces, verbatim:

```
--- task-s4u
  Supervision on this PC: a Scheduled Task that runs whether you are signed in or not, restarted automatically if it stops.
--- task-logon
  Supervision on this PC: a Scheduled Task that starts when you sign in, restarted automatically if it stops, and stopped when you sign out.
  Capture runs while you are signed in to this PC. Signing out stops it; signing back in starts it again. Locking the screen is fine, signing out is not.
  A console window belongs to each background process because Windows Task Scheduler cannot start one without a session. Minimise it; closing it stops capture until the next restart.
--- startup-folder
  Supervision on this PC: a Startup-folder launcher that starts capture when you sign in and does NOT restart it if it stops.
  This is NOT supervision. If the capture process stops — a crash, a Windows update, an antivirus quarantine — nothing will start it again, and the only signal will be that new messages stop arriving. Nothing here will report capture as live.
  A console window belongs to each background process because Windows Task Scheduler cannot start one without a session. Minimise it; closing it stops capture until the next restart.
```

## How an unsupervised source reports itself

The chain, using the machinery that already existed rather than a second notion
of staleness beside it:

1. `installWindowsSupervision` returns `supervised: false` and
   `expectedRefreshSeconds: null` for the `startup-folder` rung, and the drain
   lane returns `installed: false` there because it cannot run at all.
2. `cmdConnectWhatsapp` posts the freshness expectation **only** when the drain
   reports one. Otherwise it posts `expected_refresh_seconds: null` — clearing
   rather than leaving whatever a previous install left, so a stale one-minute
   promise cannot make the source read as permanently STALE instead of never
   scheduled — and warns, naming the one command that loads the outbox by hand.
3. `freshnessReport` in `worker/src/lib/store-d1.js` classifies a source with no
   expectation as `unscheduled` when its kind can be kept current by machinery,
   and `manual` otherwise. `whatsapp` and `imessage` were on the `manual` side and
   are now on the `unscheduled` side. `manual`'s sentence is "you load this by
   hand from a machine we cannot reach, so it is never reported as stale", which
   is the wrong thing to say about a live-capture connector.
4. `acceptance.mjs` already renders `unscheduled` as its own WARN line reading
   "NO REFRESH IS SCHEDULED. It can be refreshed automatically but nothing on this
   install does…", and `brain sources` already prints "no refresh scheduled". No
   new surface was invented; the source simply lands in the state that was already
   built for exactly this.

A supervised Windows install takes the other branch and carries the same
sixty-second expectation the Mac does, so a client who signs out overnight sees
the source go stale — which is honest, because capture genuinely stopped.

## What is genuinely unprovable without a Windows machine

Stated first in `test/windows-supervision.test.mjs` and repeated here because a
passing suite of 101 assertions is easy to misread as more than it is. **None of
the following has been observed. All of it is inference from documentation and
from the shape of the API.**

| Claim | Why it is unproven | How to settle it |
|---|---|---|
| Task Scheduler accepts this XML at all | The element order in `<Settings>` follows the schema's own sequence as Task Scheduler emits it on export, but an out-of-order element is rejected at registration and that rejection has not been observed either way | `schtasks /Create /XML` on any Windows 11 machine |
| A standard, non-administrator user can register the `task-logon` shape | This is the open question the build spec flagged. The detection branch exists precisely because it could not be answered here | Register the probe as a standard user |
| `task-s4u` is available to a standard user | It needs the "log on as a batch job" right, which standard users typically do not hold, but "typically" is policy-dependent | The same probe, first rung |
| A five-minute repetition trigger actually revives a killed daemon | The reasoning (`IgnoreNew` + repetition, since `RestartOnFailure` only fires on non-zero exit) is sound and untested | Kill `wa-daemon-windows-amd64.exe` in Task Manager and wait five minutes |
| An S4U task at boot can read a profile-scoped SQLite session store | S4U obtains a token without the password; whether the user profile is loaded far enough for `%LOCALAPPDATA%` to resolve was not established | Reboot without signing in, then check the log |
| The Node drain can read the outbox while the Go daemon holds it open, under Windows's **mandatory** file locking | WAL plus a busy timeout is exactly the case SQLite is designed for and it works on the Mac, but Windows locking is mandatory rather than advisory | One drain tick on a paired Windows machine |
| The unsigned `.exe` survives SmartScreen and the machine's antivirus | Unsigned, zero prevalence, ~29MB, no version resource, persistent TLS websocket, launched at logon — that profile is a textbook remote-access-trojan signature on grounds unrelated to intent | Run it on a managed corporate laptop |
| **Anything at all about a real pairing** | Inherited from the CLI half: no part of live capture has ever paired with a real WhatsApp account, on any platform. A Windows failure must not be misdiagnosed as a Windows problem when it is a first-pairing problem | Pair once on a Mac first. It costs an afternoon and it is the cheapest risk retirement available |

Two things that were verified here rather than assumed: the Windows binary
cross-compiles from this Mac with no C toolchain
(`CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build` → `PE32+ executable (console)
x86-64, for MS Windows`), and the new Go flags parse and take precedence
correctly (`go test ./...`, all four packages ok).

## Discrimination — every fix broken, the matching test watched to fail

Each fix was reverted in place, the suite run, and the exact failure recorded.
All were restored afterwards and the full chain re-run.

**1. The unsupervised rung claims supervision** (`supervised: false` → `true` on
`startup-folder`):

```
FAIL  and that rung does NOT claim to be supervision  {"name":"startup-folder","rank":1,"supervised":true,...}
FAIL  only the two task rungs are supervision; the launcher and none are not  ["startup-folder","task-logon","task-s4u"]
FAIL  every mechanism that claims supervision also claims to self-heal, and vice versa  [["task-s4u",true,true],["task-logon",true,true],["startup-folder",true,false],["none",false,false]]
FAIL  the launcher's disclosure says in plain words that nothing will restart it
4 FAILURES
```

**2. The battery settings left as Windows ships them** (`false` → `true`):

```
FAIL  a laptop on battery still starts capture
FAIL  unplugging the charger does not stop capture
2 FAILURES
```

**3. The drain given the daemon's unlimited execution time** (`PT10M` → `PT0S`):

```
FAIL  the drain has a real execution time limit, unlike the resident daemon  PT0S
1 FAILURES
```

**4. Removal trusts `schtasks` instead of verifying** (post-delete re-query
removed):

```
FAIL  removal ends the running instance, deletes the task, and verifies it is gone
FAIL  a delete that reports success while the task survives is an error, not a done
2 FAILURES
```

**5. Registration read-back verification removed** (`verified = true`):

```
FAIL  a task read back with a different action is refused, not trusted
FAIL  and the task it registered is deleted, so nothing unverified is left running
2 FAILURES
```

**6. The POSIX-only daemon environment restored** (the W1 bug):

```
FAIL  the daemon child environment carries WA_DATA_DIR and Windows basics only  ["WA_DATA_DIR"]
FAIL  the daemon environment on Windows carries SystemRoot  ["WA_DATA_DIR"]
2 FAILURES
```

**7. Capture kinds taken back out of `AUTOMATABLE`:**

```
FAIL  an enabled capture connector with nothing scheduling it reads unscheduled, never manual  ["manual","manual"]
FAIL  and is marked automatable, because a supervisor on that machine could keep it current
freshness: 26/28 passed
FAIL  an unsupervised capture source gets its own line rather than vanishing into the headline
FAIL  it warns rather than passing, because nothing on that machine refreshes it
acceptance freshness: 30/32 passed
```

**8. The freshness-expectation guard bypassed** (`if
(installed.expectedRefreshSeconds)` → `if (true)`).

**This one is worth reading, because on the first attempt it proved a hollow
test.** With the guard removed, nothing failed: the request body for "cleared"
and for "set to nothing" is the same request, `{expected_refresh_seconds: null}`,
so no assertion on the posted body could tell them apart. What differs is the
sentence the operator reads. The test now captures stdout, and the break produces:

```
FAIL  and NEVER prints that an expectation was set, because none was  ["ok    freshness expectation set to null seconds"]
FAIL  it says instead that nothing on this PC will load captured messages, and how to do it by hand
2 FAILURES
```

`freshness expectation set to null seconds`, printed to a client's operator over
an install where nothing is scheduled to load anything, is precisely the lie this
whole package exists to prevent. It was one `if` away and no test was watching.

**9. The Go `--data-dir` flag stops beating the environment** (`getenvWith`
returns `base` unchanged):

```
--- FAIL: TestGetenvWith (0.00s)
FAIL	github.com/guldanjaMAX/brain-installer/daemons/whatsapp
```

## Full suite

```
$ npm test > /tmp/win-sup-final.log 2>&1; echo $? > /tmp/win-sup-final-exit.txt
$ cat /tmp/win-sup-final-exit.txt
0
```

3,714 `PASS` lines, zero `FAIL`, zero `FAILURES`. New sub-suites within it:

```
whatsapp CLI: all 52 tests passed
whatsapp daemon supervision: all 46 tests passed
windows supervision: all 101 tests passed
```

Go, separately: `go vet ./...` clean, `CGO_ENABLED=0 go test ./...` ok across all
four packages, and the Windows target cross-compiles to a 29,422,080-byte
`PE32+ executable (console) x86-64, for MS Windows`.

## What a Windows install still needs before a client sees it

In the order they matter, and none of them are in this branch.

1. **Pair once against a real WhatsApp account, on a Mac.** Half a day, no code.
   It retires the largest unknown in the product and stops a first-pairing failure
   from being misdiagnosed as a Windows failure.
2. **Register a probe task on a real Windows PC as a standard user.** Ten minutes.
   It is the only way to know which rung a client actually gets, and it decides
   whether the GUI-subsystem supervisor is worth building.
3. **Binary distribution.** There is still no download-on-connect on either
   platform, so the binary is built from the checkout or supplied with `--daemon`.
   A file fetched by the installer's own HTTP client carries no Mark of the Web
   and so does not trigger the SmartScreen dialog that emailing the `.exe`
   guarantees — which is an argument for building the download path before tester
   zero, not after.
4. **Authenticode signing and a Windows version resource.** The antivirus profile
   is bad on grounds that have nothing to do with intent. On a fleet with
   Defender's prevalence rule enabled this is blocked outright regardless of
   engineering, and the product should say so rather than debug it in the field.
5. **The GUI-subsystem supervisor**, if and only if step 2 says `task-s4u` is
   unavailable. It is the only thing that removes the console window from the
   `task-logon` rung.
