# Port stage 2: the shared files

Stage 1 (commit b62c26b) put the field line's 118 backend files, their tests
and migrations 0023 to 0032 onto the 0.3.6 tip, wired every ported test into
the chain, and privacy-reviewed and allowlisted every file. It deliberately
merged none of the SHARED files, so the new subsystems are present and not yet
reachable.

**The worklist is not a guess. It is the 23 ported tests that fail**, and each
one names what it cannot find. Run it any time:

```bash
for t in $(git diff --name-only e782830 HEAD | grep -E "test/.*\.test\.mjs$"); do
  node --no-warnings "$t" >/dev/null 2>&1 || echo "FAIL $t"
done
```

## What the 23 failures actually ask for

Six missing exports across five shared files. That is the whole reachability
gap; everything else already imports cleanly.

| File | Exports the ported tests need |
|---|---|
| `brain.mjs` | `cmdConnectBank`, `cmdReconcileQuickBooks`, `cmdReconcileTaxQuickBooks` |
| `worker/src/lib/store-d1.js` | `vectorRetrySummary` |
| `worker/src/lib/zoom.js` | `ZOOM_RECORDING_EVENT` |
| `worker/src/lib/bank-feed.js` | `BANK_ACCESS_WRAPPING_KEY_SECRET` |
| `worker/src/lib/fin-import.js` | `prepareBankExportImport` |

Plus the integration surface, which no test names because it is wiring:

- CLI commands absent from the release dispatcher: `connectors`, `reconcile`
- Worker routes absent: `/api/admin/brain/reliability-alerts`,
  `/api/admin/brain/vector-retry`, `/api/support/`, `/api/webhooks/plaid`

## One test that should NOT be made to pass

`test/cloudflare-oauth-session.test.mjs` wants
`cloudflareOAuthInstallIdentity` from `brain.mjs`. That is the field line's
account-first Cloudflare OAuth installer, and the decision on this port is to
keep the release's browser sign-in instead: it is the ceremony a client was
asked to perform and the one the owner asked to be rid of.

So this test fails for a reason, not from an omission. Drop the test with that
reason recorded, do not port the feature to satisfy it, and do not delete it
quietly. Every other failing test is a real gap.

## How hard each shared file actually is, measured

Lines the RELEASE line has that the field line does not. That is the content a
wholesale copy would destroy, so it is the real difficulty of each merge:

| File | Ours-only lines | Verdict |
|---|---|---|
| `worker/src/lib/fin-import.js` | 4 | **Done.** The field's version was strictly ahead: a clean split of `importBankExport` into a pure planner plus a thin wrapper. Taken wholesale, both the new and the existing tests pass. |
| `worker/src/lib/bank-feed.js` | 50 | Real merge |
| `worker/src/index.js` | 102 | Real merge, and it carries the four missing routes |
| `worker/src/lib/zoom.js` | 116 | Real merge |
| `worker/src/lib/store-d1.js` | 123 | Real merge; ours is the 0.3.x bootstrap and drain work |
| `brain.mjs` | 623 | Real merge, the slowest |

A file with zero ours-only lines can be taken wholesale after checking the
reverse diff. A file with any is a three-way merge with no common ancestor,
which is why these six are the whole job and the other 62 shared files are not.

## Order of work

1. ~~fin-import.js~~ done. The remaining three worker libs next: bank-feed,
   zoom, store-d1. Each has a ported test that goes green when its export
   exists. Note `owner-bank-import.test.mjs` now fails on a 404 rather than a
   missing import, which is the route, not the module: modules first, wiring
   second, and the failure text tells you which you are looking at.
2. `store-d1.js` next: 352 added lines against 124 removed, and the removals
   are where the 0.3.x bootstrap and drain work lives. Merge, do not overwrite.
3. `brain.mjs` last and slowest: 4,026 added against 623 removed. Everything
   the release line gained since 0.2.3 lives in those 623.
4. Then the wiring: two commands, four routes.
5. Then the schema-32 rehearsal leg, which is the acceptance for the whole
   port and is already built and waiting.

## The rule this port is held to

A file copy can silently drop any change that lives inside a shared file and
has no test. That is why the field's own tests came across: they are the only
thing that refuses to let it happen quietly. **A ported test that cannot pass
gets a written reason, not a deletion.**


## Four pre-existing tests the port breaks, and why (measured 2026-09-03 22:30)

Stage 1's commit message reported the 23 failing PORTED tests. It did not
report that the port also breaks four tests that were passing, because the npm
chain short-circuits at the first failure and never reached them. Corrected
here.

| Test | Cause | State |
|---|---|---|
| `test/migrations.test.mjs` | Pinned the literal `22` as the receipt count for a full upgrade. The port makes it 32. | **Fixed.** Follows `LATEST_SCHEMA` now, so it checks that a published schema-16 brain reaches the current schema rather than recording what the tree used to hold. |
| `worker/test/fin-routes.test.mjs` | `freshDb({throughLedger:false})` skips `0017_financial_ledger.sql` to model a brain with no ledger. `0026_plaid_durability.sql` alters the tables 0017 creates, so it fails with "no such table: fin_accounts". | **Open.** Skipping 0026 as well moves the failure to "no such table: plaid_sync_windows", because later ported migrations depend on 0026. The dependency is transitive and a hand-kept skip list will not hold. |
| `worker/test/fin-d1.test.mjs` | Same shape, its own no-ledger helper. | **Open**, same root cause. |
| `test/bank-import-path.test.mjs` | Same shape. | **Open**, same root cause. |

The real finding is one sentence: **the ported migrations assume the financial
ledger exists, and three tests model a brain where it does not.** That is a
genuine product question, not a test problem. Either the ledger stops being
optional at schema 32, or migrations 0026 onward have to tolerate its absence.
Decide that before patching any of the three, because a skip list encodes the
answer silently and the transitive chain will outgrow it.

A note on measuring this: running these three in a loop gave different results
from running them one at a time, twice, which sent me chasing a phantom
"not idempotent" bug for ten minutes. They are deterministic. The loop was
reading a working tree I was concurrently changing. Measure a tree you are not
editing.


## The recovery contract, and where its last failure now sits (2026-09-04 05:30)

`RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION` was 22, and the adapter REFUSES to
export any tree whose last migration is a different number. That is the point
of it: a recovery drill against an unreviewed schema could omit a durable table
without saying so. The port raises the schema, so the pin had to be raised
deliberately, together with the tables.

Done in this branch:

- 23 durable tables from migrations 0023 to 0032 added to
  `RECOVERY_DURABLE_TABLES`, with a `SCHEMA_nn_TABLES` constant and version
  gate for each of the nine migrations that create tables. 0029 creates none.
- The pin raised 22 to 32, with the rule written next to it: never raise this
  without adding the new tables, because a durable table absent from this
  contract is one a recovery export omits silently.
- Verified separately that all 32 migrations replay cleanly through the plain
  `sqlite3` CLI, both as one stream and as the ten applied on top of the
  release's 22. A migration that cannot replay in sqlite would break recovery
  from an export, and none of them do.

**Still failing, and it has moved two stages forward.** The test now gets past
`export_d1` and fails at `RECOVERY_LOCAL_SQLITE_FAILED`, which is the child
`sqlite3` process exiting non-zero while verifying a synthetic artifact the
test builds from the migration set plus 6,000 fixture documents. The migrations
themselves are not the cause, since they replay clean on their own. The next
step is to capture that artifact and run it by hand to see which statement the
CLI rejects, rather than inferring it.

That is one test, and it is a recovery DRILL fixture rather than a product
path, so it does not block the schema-32 rehearsal. It does block calling the
port finished, because the recovery drill is what proves a client could be
restored.


## store-d1.js: the four exports are in, the drain behaviour is not (2026-09-04 06:30)

Appended verbatim from the field tree, with the `install-smoke.js` import they
need: `requireVectorRetryStateTable`, `vectorRetrySummary`,
`retryQuarantinedVectorOps`, `fixedPublicSmokeState`, `fixedPublicSmokeProof`.
Our own `installedSchemaVersion` and the whole 0.3.x bootstrap and drain body
are untouched, and `worker/test/store-d1.test.mjs` still passes.

`test/vector-drain-recovery.test.mjs` has moved from "cannot import
vectorRetrySummary" to 19 checks with 4 failing, which is the real remaining
work in this file and is NOT an append:

    FAIL  T3b every attempt after the rejection is a single row  [3,3,3,3,...]
    FAIL  T3b the two healthy rows confirmed and left the queue
    FAIL  T3b only the rejected row quarantined

The field line changed the drain's behaviour INSIDE the existing functions:
after Vectorize rejects a row, it drops to one row per attempt, confirms the
healthy rows, and quarantines only the offender into `vector_outbox_retry_state`.
Ours still retries the whole batch. That is a genuine three-way merge in the
same functions the 0.3.x work rewrote, and it is the piece to do with a clear
head rather than at the end of a long night.

Appending the exports was still worth doing on its own: it turns an import
error into four specific behavioural assertions, which is a far better
description of what is missing than "the module does not load".


## Where it stands after the ingest and connector merges (2026-09-04)

144 of 153 chain invocations pass, from 130 at the start of this session.
Every step was measured against a tree that was not being edited, and no
regression survived a step.

Nine remain. Four are NOT code gaps:

| Test | Why it fails | Decision |
|---|---|---|
| `cloudflare-oauth-session` | Wants the field's account-first Cloudflare OAuth installer. | Refused BY DESIGN, as stage 1 recorded. The release's browser sign-in stays. |
| `client-experience-packet` | Reads `onboarding/client-experience/README.md`, which stage 1 did not port. | A missing document, not a missing behaviour. |
| `packed-fresh-setup` | Pins the release's no-credential error wording; the merged tree prints the field's. | Wording, and the field's text is the one clients were given. |
| `agent-authority-deletion` | Expects "cannot delete"; the tree says "this connection can only read. Reconnect and approve write access to use forget." | Same refusal, better sentence. |

Five are real, and each is named rather than left as "still failing":

1. `gmail-incremental-policy`, one assertion of three. The receipt now
   separates a deliberate policy skip from a coverage gap
   (`policy_skipped=`, `coverage_gaps=`), and an unintended skip closes the
   run as an error with an `issue_code` instead of a cheerful `detail`. What
   is missing is the stronger contract the field line also holds: when ANY
   message lacks label evidence, the whole run refuses, so a classified
   message sitting beside an unclassified one is not indexed either. That is
   buffer-then-commit, not a counter, and it is the one piece of this file
   left to do.
2. `cloudflare-recovery-adapter`. The stage list now differs, not the
   sqlite failure that blocked it before; the adapter module still needs
   the three-way merge that keeps the schema-32 contract from 5955fa5.
3. ~~`full-history-privacy`~~ **Fixed.** The diagnosis above was wrong: the
   flag was already in `scripts/scan-git-history-privacy.mjs`, and only the
   three package.json entry points were missing.
4. ~~`provider-oauth`, `provider-scheduler`~~ **Both fixed.** See below.

## The three fixed after the acceptance (2026-09-04)

Each was investigated and then adversarially reviewed by a second reader whose
instruction was to refute it and who verified by applying the patch to a copy
of the tree and running all 168 test files in both. All three came back with a
measured zero-regression diff.

- `provider-oauth`: `connectors/google-auth.mjs` migrated a legacy plaintext
  Windows credential on ANY read, including a status check. The migration is a
  write, and a write belongs to the caller holding the shared lock, not to
  every reader that glances at the file. Now gated on `migrateLegacy !== false`.
- `provider-scheduler`: an installed provider job did not name its provider in
  its own argv, so a later run could not tell which connector it belonged to.
  The spread is guarded on `spec.schedulerArgumentsOf`, so the five specs that
  do not define it render byte-identical plists and their config hashes do not
  move. Six scheduled-provider ids restored to `SUPPORT_SOURCES`, because
  `recordProviderSchedulerFailure` swallows its throw and an id missing there
  loses a scheduled failure's issue note in silence.
- `full-history-privacy`: three `privacy:history*` entry points restored to
  package.json. Note this ARMS the CI job that runs them, which is the intent.

## Two whose plans were REJECTED by that review, and must not be applied as drafted

- `gmail-incremental-policy`. The diagnosis is right and the patch is minimal,
  but it would have broken the nightly Drive load. `policySkipped` is only ever
  incremented on the Gmail and IMAP paths, so on Drive every ordinary skipped
  file would count as a coverage gap, and the proposed cursor gate would then
  refuse to advance the Drive cursor at all. A second objection stands too: for
  Gmail and IMAP a single credential-refusal skip could freeze the cursor
  permanently rather than for one run. Whoever picks this up needs a Drive
  policy-skip counter first.
- `cloudflare-recovery-adapter`. The diagnosis was confirmed empirically, but
  the reviewer asked for six changes before it is applied, starting with using
  `scripts/recovery-bank-safety-lab.mjs` as the verification step rather than
  the test alone.

## The acceptance, run 2026-09-04

The kit's own leg 9 cannot run against this old side: it decides the old brain
provisioned by grepping its log for "Your brain is live", and the field 0.2.1
line prints "Core installation is ready. No source has been loaded yet."
instead. The kit is owned by another session and was not edited. The leg was
re-run standalone from a faithful copy that accepts either sentinel, with one
addition: the field 0.2.1 tarball predates `bundleDependencies`, so its ingest
dependencies are installed explicitly, which is setting up a realistic old
brain rather than compensating for anything in the port.

Result: **13 passed, 1 failed.**

    PASS  installed v0.2.1-local (32 migrations in the old tree)
    PASS  30 created at v0.2.1-local
    PASS  the old brain is at schema 32 (32 ledger rows)
    PASS  updated v0.2.1-local -> 0.4.0 in ONE run
    PASS  the CLI that ran was the candidate: announced 0.4.0
    PASS  applied 0 migration(s), expected 0  [schema up to date (32 applied)]
    PASS  the ledger is unchanged: 32 rows before, 32 after
    PASS  updated brain accepts documents ("version":"0.4.0")
    PASS  documents loaded BEFORE the update still answer after it

The one failure is the OLD brain's own drain: its outbox still held 30 rows
after six minutes, so the update ran against an unsettled outbox. That is the
0.2.x drain behaviour this port replaces, and by the kit's own note it means
the update was proven on the LEGACY residue path, which is the harder one.

Proven separately and more cheaply: all 32 migrations in the 0.4.0 package are
byte-identical to the field 0.2.1 tarball's, so the zero-migration result holds
by construction and none of the three fixes above can change it.

None of the five blocks the schema-32 rehearsal, which is the acceptance
for updating a brain already on the field line.
