# Runbook fix: recovery steps that work on a client machine — evidence

Branch: `fix/runbook-client-machine-recovery`, worktree
`/private/tmp/brain-runbook-fix`, branched from `wave0/connector-gaps` at
commit `20c1fd1` ("Merge branch 'wave1/wp07-whatsapp-cli' into
wave0/connector-gaps").

Documentation only. No `brain.mjs`, no `worker/src/`, no connector, and no
packaging config was changed. A sibling agent is editing worker files on
another branch; nothing here touches them.

## The three problems, and what each one actually was

### 1. Section 9 prescribed a recovery that cannot run where it is needed

The old text was:

```
**Fix:** restore that file to its original content, then add a **new** file with the next number for whatever change you actually wanted.

```
git checkout migrations/d1/0002_llm_call_log.sql
node brain.mjs migrate <manifest>
```

**Who:** me, or whoever is maintaining the code.
```

A client installs this product as an unpacked release tarball. `README.md`'s
own install instruction is
`npm install --global --ignore-scripts --no-audit --no-fund --prefix "$HOME/.financial-brain" "https://github.com/.../brain-installer-0.1.22.tgz"`,
and the README says in the same paragraph that it "needs no Git". So on the
machine where a stranded brain actually lives there is no repository, no
history for that file, and no `git checkout` to run. The one recovery step
in the document was impossible in exactly the place it was written for.

Rewritten around `brain doctor <manifest> --repair-checksum`, which does work
there. The `git checkout` advice is not deleted, it is scoped: it now sits at
the end of the entry under "If you maintain the source repository", with an
explicit statement that doing it there does not repair an install that has
already stopped.

### 2. The real repair command was documented nowhere a client would look

`brain doctor <manifest> --repair-checksum` shipped in 0.1.21. Before this
change, the only place in the entire package that named it was `CHANGELOG.md`.
It appeared in no onboarding document, no `docs/` page, and not in the runbook
whose whole job is recovery. An operator hitting the checksum stop would read
section 9, find a `git` command they cannot run, and have no path forward.

The new section 9 describes it from its implementation
(`cmdRepairChecksum`, `diagnoseChecksumDrift`, `describeChecksumDrift`,
`applyChecksumReconciliation`, `buildChecksumDriftCheck` in `brain.mjs`) and
from `evidence/WP-00-checksum-reconciliation.md`, not from the changelog
summary. Specifically it now states:

- preview by default, mutates only on `--yes` (`cmdRepairChecksum`'s
  `confirmed` branch);
- what the preview prints: applied-at, both checksums, the current file's
  line and byte counts, and the line-ending verdict
  (`printChecksumDriftDiagnosis`);
- that the line-ending verdict is a proof and not a guess: it converts the
  current file to LF and to CRLF and checks each against the recorded
  checksum (`describeChecksumDrift`);
- that confirming updates the recorded checksum only and runs no migration
  SQL (`applyChecksumReconciliation` issues exactly one
  `UPDATE schema_migrations SET checksum = ? WHERE version = ?` per drifted
  row);
- that `--repair` will NOT fix this and `--rollback` does not fit, which is
  the same warning `buildChecksumDriftCheck`'s own `fix:` text carries;
- that plain `brain doctor <manifest>` now catches the drift before an
  update walks into it.

**The honesty caveat the entry adds.** When the tool prints
`not confirmable as a pure line-ending change`, it is reporting a real limit:
the bytes that originally ran were never retained. Its own message suggests
reviewing the file against version control history, which the client machine
does not have. So the runbook now says plainly that in that case the operator
would be accepting a difference nobody has read, and to send the preview to
`[INSTALLER CONTACT]` before adding `--yes`. A confirmed line-ending drift
needs no such call. Presenting an unreviewable change as routinely safe would
have been the product's own failure mode written into its recovery document.

### 3. Bot protection had no entry anywhere

Nothing in `onboarding/`, `docs/`, or `README.md` mentioned it:
`grep -rni "user-agent|bot protection|browser ua|1010" --include="*.md" onboarding docs README.md`
returned nothing at all. Two places in the shipped code already know about it
and neither is a document a person reads while something is broken:

```
$ grep -rn "Mozilla" components/brain-mcp.mjs eval/brain-client.mjs | cut -c1-90
components/brain-mcp.mjs:43:  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit
eval/brain-client.mjs:22:  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/53
```

`components/brain-mcp.mjs:122` even carries the hint text
`"(a bot-protection rule rejected the request; the User-Agent header is the usual cause)"`,
and `eval/brain-client.mjs`'s header comment states the failure "presents as a
broken install rather than as a blocked client" — which is precisely the
operator experience, recorded in a file no operator opens.

The CLI itself sends no browser agent:

```
$ grep -c "Mozilla" brain.mjs
0
```

Verified what it does send instead, rather than assuming:

```
$ node -e "
const http=require('http');
const s=http.createServer((req,res)=>{console.log('UA seen:',JSON.stringify(req.headers['user-agent']));res.end('{}');s.close();});
s.listen(0,async()=>{const p=s.address().port;await fetch('http://127.0.0.1:'+p+'/health');});
"
UA seen: "node"
```

New entry **1b**, placed immediately after the 401 entry because a 403 from a
bot rule is first mistaken for a bad key, and the entry's job is to say the
refusal happened before the key was ever read.

The triage probe in that entry carries no credential, which matters given the
document's own "Never paste a token or key into a shell command" rule. It uses
`/health`, confirmed unauthenticated in `worker/src/index.js:1412` (the route
returns its JSON body before any auth path), so both `curl` lines are safe to
paste anywhere.

Two honest limits are stated in the entry rather than left implied:

- it only applies when the brain is on a customer-controlled domain. A
  `*.workers.dev` address is not inside a zone the client configures. Both
  forms are real: `brain.mjs:1106` uses `m.brain.domain` when set, and
  `brain.mjs:1118` persists `<script>.<label>.workers.dev` when it is not.
- the "AI tools still work while terminal commands fail" signal is called a
  signal and not a proof, because a rule matching on anything other than the
  user agent refuses both.

## What actually ships to a client, checked rather than assumed

**The runbook does ship.** `package.json`'s `files` allowlist contains
`"onboarding/"` as a directory entry, so all nine onboarding documents are in
the tarball. Confirmed against the real packlist, not against the allowlist:

```
$ npm pack --dry-run --json --ignore-scripts   (non-dependency .md files)
non-dependency files shipped: 113
client-readable docs:
  CHANGELOG.md
  README.md
  docs/ARCHITECTURE.md
  docs/COMPETITIVE-BENCHMARK.md
  docs/decisions/000-template.md
  docs/decisions/001-cloudflare-native-standard.md
  docs/decisions/002-paused-bootstrap-acceleration.md
  docs/decisions/README.md
  docs/ENGINEERING-STANDARDS.md
  docs/EVALUATION.md
  docs/LEGACY-SUPABASE-EXIT.md
  docs/MAINTAINER.md
  docs/README-developer.md
  docs/RECOVERY.md
  onboarding/01-intake-questionnaire.md
  onboarding/01-intake-RUNBOOK.md
  onboarding/02-client-effort-and-timeline.md
  onboarding/03-kickoff-and-checkins.md
  onboarding/04-what-it-can-and-cannot-answer.md
  onboarding/05-handoff-and-revocation.md
  onboarding/06-runbook-top-ten-failures.md
  onboarding/07-ingest-source-matrix.md
  onboarding/08-provisioning-prerequisites.md
```

So **no allowlist change was needed, and none was made.** The delivery problem
was not packaging. It was two other things:

**Nothing pointed at it.** `grep -n "06-runbook|onboarding/|runbook" README.md docs/*.md`
found the runbook referenced only from `docs/MAINTAINER.md:38`, a maintainer
document. `README.md`'s own "If something goes wrong" section listed three
commands and then went straight to support-journal mechanics without ever
mentioning that a full failure runbook was already sitting on the reader's
disk. Fixed with a three-line pointer in that section. That is the smallest
change that closes the gap and it restructures nothing.

**The copy that ships is the unfilled template.** The file opens with
`**TEMPLATE NOTE, delete before sending:**` and carries `[INSTALLER CONTACT]`
and `[WORKER_NAME]` placeholders. Because `onboarding/` ships wholesale, every
client receives that unfilled copy, placeholders and all, whatever a filled-in
copy sent by hand may also say. Rather than pretend otherwise, the template
note now states this and tells a reader who hits a placeholder what it means.
Properly fixing this needs a packaging decision (a filled artifact generated
at install time, or a shipped copy separate from the template), which is a
restructure and deliberately out of scope here.

## Every command written into the runbook, and where it was verified

None of these were written from memory. Each was located in `brain.mjs`
before it went into the document.

| Command in the doc | Verified at |
|---|---|
| `node brain.mjs test <manifest>` | `commands` table, `brain.mjs:10921` (`test: cmdTest`) — pre-existing |
| `node brain.mjs health <manifest>` | `commands` table, `brain.mjs:10920` — pre-existing |
| `node brain.mjs sources <manifest>` | `commands` table, `brain.mjs:10928` — pre-existing |
| `node brain.mjs doctor <manifest>` | `commands` table, `brain.mjs:10914`; `dispatchDoctor` at `brain.mjs:10882`; `cmdDoctor` at `brain.mjs:8274` |
| `node brain.mjs doctor <manifest> --repair-checksum` | flag parsed at `brain.mjs:10886`, dispatched at `brain.mjs:10890`-`10897`; `cmdRepairChecksum` at `brain.mjs:8184` |
| `node brain.mjs doctor <manifest> --repair-checksum --yes` | same; the preview/act split is `cmdRepairChecksum`'s `if (!confirmed)` at `brain.mjs:8199`-`8204`, mutation at `brain.mjs:8206` |
| `node brain.mjs status <manifest>` | `commands` table, `brain.mjs:10927` — pre-existing in entry 10 |
| `node brain.mjs migrate <manifest>` | `commands` table, `brain.mjs:10923` — pre-existing |
| `curl -sS -i https://<address>/health` | not a `brain` command; `/health` route confirmed unauthenticated at `worker/src/index.js:1412` |

The command's existence and its flag guard, run directly:

```
$ node brain.mjs | grep -n "repair-checksum"
46:    brain doctor     <manifest> --repair-checksum  reconcile an applied migration whose file changed (--yes to apply)

$ node brain.mjs doctor --repair-checksum
fail  usage: brain doctor <manifest> --repair-checksum [--yes]
```

The exact string the runbook quotes to the operator is real, from the existing
suite rather than from my description of it:

```
$ node test/checksum-reconciliation.test.mjs | grep -A3 "not confirmable"
    likely cause: not confirmable as a pure line-ending change.
      The bytes this migration originally applied were never retained — only their
      checksum was. Review 0001_test_table by hand (your own version control history for
      this file, if any, is the fastest way) before confirming reconciliation.
```

**One claim I checked and then removed.** A first draft told the operator that
`brain status` and `brain migrate` would ask for the Cloudflare token at a
hidden prompt, the way the `--repair-checksum` commands do. That is false:
only commands wrapped in `withCloudflareToken` (`brain.mjs:425`) prompt, and
the `commands` table wires `status` and `migrate` directly to `cmdStatus` and
`cmdMigrate`. Without a token already present they call `token()`
(`brain.mjs:490`) and die with "CLOUDFLARE_API_TOKEN is not set". The sentence
was cut, and the token note now sits only on `--repair-checksum`, where
`dispatchDoctor` really does wrap it.

**A second claim caught the same way.** A draft opened section 9 with "Every
`migrate`, `update`, and `upgrade` stops there, before touching anything." The
first half is right, the second half is not. Listing `cmdUpgrade`'s stages in
order shows `paused vector-drain deployment` running BEFORE `migration` on the
legacy-bootstrap path:

```
$ awk 'NR>=s && NR<=s+330 && /runStage\(/' brain.mjs      (from `export async function cmdUpgrade`)
        await runStage("paused vector-drain deployment", () => deploy(executionPin.target, {
        await runStage("paused vector-drain health verification", () =>
        await runStage("vector-drain quiescence", () =>
        await runStage("migration", () => migrate(executionPin.target, {
        ...
```

So an update can already have paused the brain when the checksum stop fires.
The phrase was corrected, and the entry now carries a short pointer: if an
update hit this, check `brain health` for `accepting_documents: false` and read
entry 10 as well, reconciling the checksum first because `--repair` keeps
hitting the same stop until you do. That ordering matches
`evidence/WP-00-checksum-reconciliation.md`'s own closing guidance.

**One claim from the task brief I did not write into the document.** The brief
describes the checksum failure as having "stranded an install for over a
week". `evidence/WP-00-checksum-reconciliation.md` confirms a real field
install was stranded on exactly this, but records no duration, and
`evidence/WP-00.md` contains no duration claim either. The eight-day figure
in `worker/src/index.js` belongs to the different paused-upgrade failure. So
the duration is unverified in this repository and appears nowhere in the
runbook. The entry works without it.

## Files changed

- `onboarding/06-runbook-top-ten-failures.md`
  - template note: states that the unfilled copy also ships, and tells a
    reader what the two placeholders mean.
  - "Before anything else": adds `node brain.mjs doctor <manifest>` as the
    third triage command, naming what it reads beyond this machine.
  - **new entry 1b**, bot protection, placed after the 401 entry.
  - **entry 9 rewritten** around `--repair-checksum`; the `git checkout` path
    scoped to the source repository and marked as not a fix for a stopped
    install.
- `README.md` — three-line pointer to the runbook inside "If something goes
  wrong".

Not touched, deliberately: `package.json` (`onboarding/` already ships, so
there was nothing safe to add), `brain.mjs`, `worker/src/`, every connector,
`CHANGELOG.md` (no version heading added, per instruction), and
`onboarding/07-ingest-source-matrix.md` (this changes no ingest source, and
`evidence/WP-00-checksum-reconciliation.md` already established that file is
the wrong home for CLI-diagnostics capabilities).

## Changelog paragraph, owner voice, for whoever integrates the branches

> **The recovery runbook now works on the machine your brain actually runs
> on.** One entry told you to fix a changed migration file with `git checkout`.
> Your install is an unpacked release rather than a checkout, so that command
> had nothing to run against, on the one machine where you would need it. That
> entry is now built around `brain doctor <manifest> --repair-checksum`, which
> previews what changed and changes nothing until you add `--yes`, and it says
> plainly that `--repair` will not fix this and `--rollback` does not fit. It
> also tells you when to stop: if the preview cannot confirm the difference is
> only line endings, nothing on your machine can show you what changed, so
> send that preview on before confirming. New entry as well for the failure
> where every command is refused while the same address opens fine in a
> browser: that is bot protection turning your tools away before your brain
> ever sees them, and there are now two credential-free `curl` lines that tell
> it apart from a broken install in ten seconds. And the README finally points
> at the runbook, which has been sitting inside your install the whole time.

## Full chain

```
$ npm ci --ignore-scripts
added 4 packages, and audited 5 packages in 531ms
found 0 vulnerabilities

$ npm test > /tmp/runbook-fix.log 2>&1; echo $? > /tmp/runbook-fix-exit.txt
$ cat /tmp/runbook-fix-exit.txt
0
$ grep -c "^PASS" /tmp/runbook-fix.log
2535
$ grep -c "^FAIL" /tmp/runbook-fix.log
0
$ grep -cE "^not ok " /tmp/runbook-fix.log
0
$ grep "published package contains" /tmp/runbook-fix.log
PASS  published package contains 339 reviewed files and no client-private paths
$ tail -3 /tmp/runbook-fix.log
secret-scan v4 (js): all tests passed
provider routing: all focused offline tests passed
spend cap: all focused offline tests passed (query failure, runaway loop, recovery, missing binding, garbled cap, degraded ceiling)
```

The exit code above was read back out of `/tmp/runbook-fix-exit.txt`, not from
a pipeline, so a `tail` cannot have masked it.

`node_modules/` is gitignored and a fresh `git worktree add` does not create
it, so this worktree needed `npm ci --ignore-scripts` before
`package-privacy.test.mjs` or the full chain could run. Expected worktree
behavior, not a project change.

## Nothing live was touched

No deployed brain, no Cloudflare account, no D1 database, and no credential
was contacted or used. The only command run against `brain.mjs` was the help
banner and a usage-guard path that exits before any network call. The two
`curl` lines in the new entry are written for an operator to run against their
own brain; they were not run here, because no manifest or address for a real
install exists on this machine.

## Anything not fully resolved

- **The shipped runbook is still the unfilled template.** Named honestly in
  the template note now, not fixed. Fixing it properly means either generating
  a filled copy at install time or shipping a separate non-template file, both
  packaging restructures that were explicitly out of scope.
- **Entry 1b's dashboard steps are described by area, not by exact clicks.**
  "The zone that holds that hostname, then Security, then the bot settings and
  any WAF custom rule that matches on user agent." Cloudflare's dashboard
  labels move, and a precise click path invented today would be wrong within a
  release or two. The `curl` diagnosis above it is the part that does not go
  stale.
- **Entry 1b was written from the code's own account of this failure**
  (`components/brain-mcp.mjs`, `eval/brain-client.mjs`) plus a verified
  measurement of what the CLI sends. It has not been reproduced against a live
  brain sitting behind a bot rule, because doing that means configuring a rule
  on a real account. The symptom description is therefore drawn from what the
  code says it saw, not from a reproduction performed here.
- **No test covers documentation prose**, so nothing in the suite would catch
  this class of regression: the runbook could drift out of step with the CLI
  again and every test would still pass. `test/package-privacy.test.mjs`
  checks only that these files ship and carry no private identity.
