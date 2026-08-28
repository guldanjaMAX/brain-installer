# Wave 0 closeout: privacy scrub + the missing connector rehearsal — evidence

Branch: `wave0/connector-gaps`, worktree `/private/tmp/brain-wave0-connector-gaps`.
This is a closeout pass, not a new work package: it fixes two gaps a prior
verify pass found in Wave 0's own evidence trail (a real client name
committed to two files, and the plan's own required end-to-end rehearsal
never having been built).

## Part 1: privacy scrub

### What leaked, and where

`test/sms-backup.test.mjs` (line 4) and `evidence/WP-03.md` (lines 5 and
10, in the original text) named the real pilot client by first name
("Chet") when explaining why WP-03 was built ahead of confirming his phone
OS. Neither file ships inside the npm package — both are outside
`package.json`'s `"files"` array, and `test/package-privacy.test.mjs` only
ever scanned files destined for `npm pack` — so there was no
`npm install`-time exposure. But `guldanjaMAX/brain-installer` is a public
GitHub repo, and this branch had not yet been pushed anywhere, so the real
name was still fixable with zero real-world exposure before anyone pushed
it.

### The fix

Both instances were replaced with "Devon", an invented placeholder in the
same style already used for synthetic people in `test/fixtures/whatsapp/`
and `test/fixtures/sms-backup/` (Alex Rivera, Priya Nair, Sam Osei, Jordan
Lee, Morgan Diaz) — no new naming convention invented. Both files were
re-read in full afterward; no other real name, email, or identifying detail
was found in either. A short in-file note was added at the point of the
scrub in `evidence/WP-03.md` explaining what the placeholder stands in for
and why, so a future reader is not confused by "Devon" appearing with no
context in a client-scoping paragraph.

`test/sms-backup.test.mjs` was re-run after the edit: `sms-backup: all 31
tests passed`, exit 0 — the fix touched only a comment, not code, so this
was a formality, but it was still run rather than assumed.

### Widening the actual defense

`test/package-privacy.test.mjs`'s `privateIdentityRules` list (owner first
name, owner surname, owner organization, owner email, collaborator first
name "Jay", collaborator surname "Bhakta") gained one more entry:
collaborator client first name, `/\bChet(?:'s)?\b/i`. This closes the
specific hole covered by this scrub for any FUTURE file that ends up inside
the npm-shipped `expected` list.

**The scan was NOT widened to cover `test/` or `evidence/`, and here is
exactly why**, verified rather than assumed:

```
$ grep -rlniE "\bjames('s)?\b|\bguldan('s)?\b|\balign( growth)?\b" test/ evidence/ worker/test/
  -> 10 files
$ grep -rniE "\bjay('s)?\b|\bbhakta('s)?\b" test/ evidence/ worker/test/ | wc -l
  -> 33 lines
```

`privateIdentityRules` already matches "Jay" and "Bhakta", and both names
appear intentionally and by design across dozens of already-committed
test/evidence lines — Jay Bhakta co-owns the Financial Brain venture this
installer serves, and his own install is a running example throughout the
suite (`test/errors.test.mjs`, `test/upgrade-repair.test.mjs`,
`test/upgrade-verify.test.mjs`, `evidence/WP-00.md`, `evidence/WP-03.md`,
and more). Applying the SAME denylist to `test/` and `evidence/` mechanically
would fail the whole suite on those pre-existing, accepted mentions — not on
anything this pass introduced. Fixing that correctly needs a real design
decision (a second, narrower denylist scoped to genuinely-private third-party
names, with its own allowlist for legitimate collaborator mentions; or a
per-file human review pass), not a one-line extension of this test's
architecture. That decision is left for a human. In its place:

- A long header comment was added at the top of `test/package-privacy.test.mjs`
  stating plainly what the file covers (the npm-packed `expected` file list
  and its own private-identity scan) and what it does NOT cover (`test/`,
  `evidence/`, `docs/release-evidence/`, `planning/`, or any other
  non-shipped path) — that file previously implied broader coverage than it
  actually has, silently.
- `test/package-privacy.test.mjs` was re-run after both changes:
  `PASS  published package contains 331 reviewed files and no client-private
  paths`, exit 0.

### A second, unrelated leak found in passing, NOT fixed here (out of scope, flagged separately)

While building the connector rehearsal below (Part 2), `test/google-drive.test.mjs`
turned out to already contain a REAL client email and the REAL owner email
in a synthetic Gmail test fixture (`"From: Eli <eli@azlawns.com>\r\nTo:
james@jamesguldan.com\r\n..."`, lines ~382-386), present since the repo's
very first commit (`9b28f7e`, 2026-08-18) — long before this branch existed.
`eli@azlawns.com` is James Guldan's real active client (Eli Hall, AZ Lawns /
AMS Landscaping, per the project's own CLAUDE.md). This is exactly the kind
of exposure this scrub exists to prevent, but it is in a file this task did
not name and fixing it correctly means updating that file's own assertions
(which regex-match the email address), which is more than a drive-by edit.
It was NOT touched here. It was flagged as a standalone follow-up task
(`spawn_task`, task id `task_f6b0ece2`, title "Scrub real client email from
google-drive.test.mjs fixture") so a human can pick it up deliberately. My
new content in this session (the connector rehearsal below) uses only
invented `.test`-TLD addresses, specifically to avoid adding a second
instance of the same problem.

## Part 2: the missing end-to-end connector rehearsal

### What was required, and confirmed missing

`planning/04-connector-gap-execution-PLAN.md` section 5, item 4 requires:
a fresh synthetic manifest; connect Drive, Gmail, and Calendar; load the
WhatsApp and SMS fixtures plus one fixture bank statement (native and
scanned); then golden-20-style questions covering each new source, each
returning a cited answer, including at least one answered from the
structured ledger (WP-14) rather than from text retrieval — scripted as
`test/connector-rehearsal.test.mjs` or a documented manual runbook. A prior
verify pass confirmed no such file or runbook existed anywhere in the repo.
Confirmed again at the start of this session: `find . -iname
"*connector-rehearsal*"` returned nothing before this file was written.

### What was built, and what it actually proves

`test/connector-rehearsal.test.mjs` (new). Its own header comment is the
authoritative statement of scope and honesty tradeoffs; this section
summarizes it.

**Scope, stated up front in the file.** Wave 0 shipped Drive, Gmail
(connector code only, never run live), Calendar, the WhatsApp export parser
(WP-02), and the two SMS parsers (WP-03). WP-11 (OCR) and WP-14 (the
structured financial ledger) are Wave 2 and do not exist in this codebase —
no `fin_*` migrations, no extraction pass. The file tests exactly the five
sources that exist and marks the bank-statement step and the
ledger-answered-question requirement as explicit `N/A` with a stated reason,
rather than skipping them silently or faking a pass. There are three such
`N/A` markers in the file's output.

**How each connector is exercised, and why that is honest.** Nothing in
this file performs a live Google OAuth consent flow — that needs a real
browser and a human, per WP-01's own evidence file. Instead:

- **Calendar**: the real, exported `cmdIngestCalendar` runs the real
  `syncAll()` against a scripted Google Calendar API, the identical
  technique `test/calendar-ingest.test.mjs` (WP-04) already uses to prove
  this connector is genuinely wired to a runnable command.
- **Drive** and **Gmail**: `cmdIngestRemote` (the CLI's `--from drive` /
  `--from gmail` path) is not exported for test injection — it resolves
  Google auth and the network directly, unlike `cmdIngestCalendar`. So each
  connector's own real, exported `toEnvelope()` function is exercised
  instead, against a scripted HTTP transport — the exact same technique
  `test/google-drive.test.mjs` already uses for Drive, and for Gmail via
  its own `gm.toEnvelope` block in that same file.
- **WhatsApp** and **SMS** (both parsers): the real parsers
  (`ingest/whatsapp-export.mjs`, `ingest/sms-backup.mjs`) run against this
  package's own existing synthetic fixtures, feeding the real
  `MessageSessionizer` — nothing new invented, the same fixtures
  `test/whatsapp-export.test.mjs` and `test/sms-backup.test.mjs` already
  cover in detail.

**The "cited answer" tier, and its honest limits.** The plan's acceptance
criterion is a real deployed brain on a real Cloudflare account with real
Vectorize embeddings and a real LLM call — unavailable in this environment,
same constraint every other Wave 0 evidence file names. Rather than skip
the requirement, the file drives the REAL worker route handler
(`worker/src/index.js`, in-process, zero network, via `worker.fetch(...)`)
with D1, Vectorize, and Workers AI scripted at the boundary — the exact
class of fakery `worker/test/routes.test.mjs` already uses to test this
same route on every other change to this codebase, extended here to a
custom `mkCorpusEnv()` that holds all six ingested documents from all five
sources at once and genuinely filters D1 hydration by the bound `chunk_uid`
list (routes.test.mjs's own fake does not need to do this because its own
tests never co-load more than one or two rows at a time).

Stated plainly in the file, and repeated here:
- **Proven**: each source's real ingest code turns a realistic input into a
  correctly-shaped, correctly-tagged document; those six documents, loaded
  together into one D1-shaped corpus, are stored and hydrated
  distinguishably — the right content comes back for the right question,
  never a neighboring source's; the real retrieval route (auth, D1
  hydration, evidence gate, citation numbering) operates correctly end to
  end on that corpus and returns a citation that traces back to the real
  ingested content, not a hardcoded fixture string.
- **NOT proven**: real embedding-based semantic relevance (Vectorize's match
  is scripted to return exactly the intended document, not a genuine
  nearest-neighbor search over real embeddings) and real LLM answer quality
  (Workers AI's response is a scripted string). Those two are exactly what
  a live deployed brain would add, and nothing here substitutes for that.
- **Not attempted at all**: a fixture bank statement (native or scanned)
  and a ledger-backed (WP-14) answer — both explicitly `N/A`, both because
  the Wave 2 code they would exercise does not exist yet.

### Test run (real, verbatim, this session)

```
$ node test/connector-rehearsal.test.mjs
[... full output omitted here for length; every check line printed PASS,
three lines printed N/A with their stated reason, zero FAIL lines ...]
connector-rehearsal: all 33 checks passed (3 step(s) explicitly not done -- see N/A lines above and the file header)
$ echo $?
0
```

**A sanity check on the checks themselves** (not part of the committed
file — done once, in place, then reverted, to verify the assertions are not
vacuously true): temporarily forcing each golden question's scripted
Vectorize match to point at the WRONG document (`rows[(index + 1) %
rows.length]` instead of the right one) turned 12 of the 33 checks red
(`SANITY_EXIT=1`), including citation-identity and snippet-identity checks
across every source. The file was restored to its original, correct state
immediately after (confirmed via `git status --short` showing the file
untouched relative to what was about to be committed) before this evidence
was written.

### Wiring into `npm test`

`test/connector-rehearsal.test.mjs` was added to the hardcoded chain in
`package.json`'s `"scripts.test"` (this repo does not auto-discover test
files), placed immediately after `test/calendar-ingest.test.mjs` since it
depends conceptually on WhatsApp, SMS, and Calendar all already being
covered individually.

### Full `npm test` chain, this session

```
$ npm test > /tmp/npm-test-full.log 2>&1; echo $? > /tmp/npm-test-exit.txt
$ cat /tmp/npm-test-exit.txt
0
$ grep -c "^FAIL" /tmp/npm-test-full.log
0
$ grep -c "^PASS" /tmp/npm-test-full.log
1990
$ awk '/^ℹ pass /{p+=$3} /^ℹ fail /{f+=$3} END{print "node:test pass="p" fail="f}' /tmp/npm-test-full.log
node:test pass=140 fail=0
```

58 `node`-invoked test files/suites in the chain (including the new one),
zero `FAIL` lines anywhere, zero `node --test` failures across the four
`--test`-run suites, exit code captured to a file rather than trusted from
a piped command's own status (per this repo's own lesson on that exact
failure mode).

## Commits

Two commits continue this branch's existing history (`b8b2cad` was HEAD at
the start of this session); none of the prior 7 commits were amended or
rewritten.

1. Privacy scrub: `evidence/WP-03.md`, `test/sms-backup.test.mjs`,
   `test/package-privacy.test.mjs`.
2. Connector rehearsal: `test/connector-rehearsal.test.mjs` (new),
   `package.json` (wired into the `npm test` chain), plus this evidence
   file.
