# Review items 2 and 3 — runtime migration guards, deploy safety over stranded upgrades

Date: 2026-08-28. Branch `fix/review-preinstall`, built in an isolated worktree
off `wave0/connector-gaps` (6ffaab5). Spec: the 2026-08-29 architecture
review's install/updates section and ranked optimizations 2 and 3 (both marked
DO FIRST before the next client install). No version bump and no CHANGELOG
heading; the owner-voice paragraph is at the bottom of this file.

The review's leave-alone list was honoured: the deploy-paused-then-migrate
ordering is untouched, and the checksum guard's refusal behaviour is untouched
(the new guards refuse EARLIER and for different reasons; nothing weakens the
applied-checksum stop).

## Item 2 — runtime migration guards

**Defect.** The repo pins migration numbers unique and contiguous in
`test/migration-field-collision.test.mjs`, but a client machine runs whatever
tarball it was handed; each of the three branches that shipped a 0017 passed
its own tests in isolation, and only the merged tree could have failed the
pin. A package carrying that merge artifact would apply one 17 and die
mid-migration on a live install. Adjacent: `appliedVersions` swallowed every
read failure as "zero applied migrations", so a transient D1 outage read as a
fresh database and silently bypassed the applied-checksum guard — the same
conflation that produced the spend-cap defect (its own query error read as
"nothing spent").

**Change.** `loadMigrations` (brain.mjs) now refuses, before any D1
statement: duplicate numbers, numbering gaps, and numbering that does not
start at 1 — each naming the files. `appliedVersions` treats a missing
`schema_migrations` table (the one failure that genuinely means nothing is
applied) as empty and dies with an explanation on everything else. The stale
comment in `diagnoseChecksumDrift` describing the old swallow was updated.

Exact wording, duplicate:

```
fail  two migration files claim number 2: 0002_b.sql and 0002_c.sql.
      A fresh install would apply both and a live install has receipted exactly one of
      them, so there is no safe way to run this arrangement anywhere. This is the merge
      artifact that stranded a live install mid-migration (three branches, three 0017s).
      Nothing was touched: this refusal happens before any D1 statement. Renumber the
      file the field has NOT applied — schema_migrations on each install records which
      checksum owns the number.
```

Exact wording, gap:

```
fail  migration numbering has a gap: expected 3 next (after 0002_b.sql (2)) but found 0004_d.sql (4).
      Migrations apply strictly in sequence and the recovery contract asserts
      version === position, so a gap means a file this package was built with is
      missing — usually a merge that dropped one line's migration while keeping its
      code. Applying around the hole would receipt a schema no other install has.
      Nothing was touched: this refusal happens before any D1 statement.
```

Exact wording, unreadable ledger:

```
fail  the schema_migrations ledger could not be read: D1 is unavailable: connection reset mid-flight
      A failed read is not an empty ledger. Treating it as one would make a fully
      migrated brain look brand new and silently bypass the applied-checksum guard,
      so nothing proceeds until D1 answers. Nothing was changed; retry when it does.
```

## Item 3 — deploy safety over stranded upgrades

**Defect.** The pause protecting a mid-migration corpus lived only in a
plain_text binding; `keep_bindings` preserves secret_text alone, so any full
deploy rewrote it. A plain `brain deploy` on a stranded install would have
silently resumed corpus writes over a half-migrated schema.

**Change.** Two records, per the review's own prescription (its section 3,
item 4). `cmdDeploy` refuses an active-mode deploy while the newest
`upgrade_runs` row is neither `verified` nor `rolled_back`, pointing at the
repair commands; `--force-active` (CLI) / `forceActive` (option) is the
operator override, and the verified update path passes it internally at the
one stage where its own migration has just completed — the repair path is the
only caller allowed through by default. And migration `0022_durable_drain_pause`
adds three columns to `install_state` so the pause is recorded durably with
the run that set it (the run's `started_at`, since an upgrade's history row
does not exist until the run finishes; `rollback:<bookmark>` for a supervised
restore, re-recorded after the restore rewinds `install_state`). The env
binding stays as the fast per-request gate; it is no longer the record of
truth. Both guard reads fail CLOSED on anything except "this record does not
exist yet" (missing table, or a pre-0022 schema missing the columns —
tolerated so upgrades from old installs still pause before they migrate).

Exact wording, unfinished upgrade:

```
fail  deploy refused: the last update of this brain did not finish (0.1.13 -> 0.1.16, started 2026-08-27T05:00:00Z, status failed at stage:migration scope:schema-partial).
      An active deploy now would rewrite the worker's bindings and silently resume corpus
      writes over a schema that update never verified — the exact path that strands
      installs. Repair it instead:
          brain doctor <manifest> --repair     what is stuck, since when, and the safe resume
          brain update <manifest>              replay the verified upgrade path to completion
      If you are CERTAIN this history row is stale, rerun with --force-active.
```

Exact wording, durable pause (fires even when a hard-killed run left no
history row):

```
fail  deploy refused: install_state records that corpus writes were paused for an upgrade
      (paused-for-upgrade, since 2026-08-28T06:00:01.000Z, set by run 2026-08-28T06:00:00Z).
      This record survives deploys ON PURPOSE: the binding a deploy rewrites is only the
      fast request gate, and this row is the record of truth. Resuming writes over a
      possibly half-migrated schema is worse than staying paused. Repair it instead:
          brain doctor <manifest> --repair     what is stuck, since when, and the safe resume
          brain update <manifest>              replay the verified upgrade path to completion
      If you are CERTAIN this record is stale, rerun with --force-active.
```

**Readers of the pause, verified still working.** `/health`'s two-tier body
and `accepting_documents:false` (worker unchanged; `worker/test/health-honesty`
green). `probeUpgradePause` / `diagnoseStuckUpgrade` / doctor's recurrence
count (`doctor`, `diagnose`, `upgrade-pause-recurrence` suites green).
`cmdHealth`'s `expectDrainMode` (`upgrade-verify` 155/155). `drainOutbox`'s
zero-writer early return and `acceleratedVectorBootstrap`'s required-pause
check in `store-d1.js` (worker suites green). The rollback flow's fixture in
`upgrade-verify` now also proves the pause is re-recorded on the restored
schema. Shipping 0022 carried the documented recovery-contract obligations:
`RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION` 21 -> 22, the column gate, NULL
normalisation of the pause columns on export (live coordination, like the
lease), and the pinned fixtures in `migration-field-collision` and
`cloudflare-recovery-adapter` tests. 0022 was claimed against
`git log --all`, where 21 is the highest number any branch ever used
(0021_google_connect on a side branch; 0021_chunk_token_fit in this tree).

## New tests, and their discrimination proofs

`test/runtime-migration-guards.test.mjs` (15 checks) and
`test/deploy-stranded-upgrade.test.mjs` (16 checks, real SQLite behind a
mocked Cloudflare API so state persists between deploys), both registered in
the package.json chain.

Probe A — `loadMigrations` guard reverted (early `return migrations;` before
the checks):

```
FAIL  two files at one number are refused  loadMigrations returned normally
FAIL  and the refusal names BOTH colliding files, not a position or a count
FAIL  and it says the refusal happened before any D1 statement
FAIL  a numbering gap is refused  loadMigrations returned normally
FAIL  and the gap refusal names the file on each side of the hole
FAIL  numbering that does not start at 1 is refused, naming the offending file
FAIL  cmdMigrate refuses the colliding package outright
FAIL  and the collision refusal really ran before ANY D1 statement  ["SELECT version, checksum, name FROM schema_migrations","CREATE TABLE IF NOT EXISTS schema_migrations (...
8 FAILURES
```

Probe B — `appliedVersions` catch reverted to `return []` on every error:

```
FAIL  a D1 outage while reading the ledger stops the migration  cmdMigrate proceeded through an unreadable ledger
FAIL  and the refusal says what an empty-ledger lie would have cost
FAIL  and no migration statement ran after the failed read  ["SELECT version, checksum, name FROM schema_migrations","CREATE TABLE IF NOT EXISTS schema_migrations (...
3 FAILURES
```

Probe C — `cmdDeploy` guard disabled (`if (false && ...)`), i.e. the old
behaviour where a deploy just rewrites bindings:

```
FAIL  an active deploy over an unfinished upgrade is refused  the deploy went through
FAIL  and the refusal names the run it found
FAIL  and it points at the repair commands, not just at a wall
FAIL  and nothing was uploaded before the refusal  [...,{"path":"/client/v4/accounts/fixture-account/workers/scripts/fixture-brain","method":"PUT"},...]
FAIL  a plain deploy cannot erase the pause: it is refused on the durable record alone
FAIL  and the refusal explains the record outlives deploys on purpose
FAIL  and no binding rewrite happened: nothing was uploaded  [...worker PUT recorded...]
FAIL  and the durable record is still intact after the refusal  {"vector_drain_pause":null,"vector_drain_paused_at":null,"vector_drain_pause_run":null}
FAIL  a D1 outage during the guard read refuses the deploy instead of assuming clean
FAIL  and the outage refusal uploaded nothing
10 FAILURES
```

That last `{null,null,null}` line is the incident in one row: with the guard
off, the plain deploy went through and erased the pause. Each probe was then
reverted and its suite re-run green (15/15, 16/16).

## Full suite

`npm test` on the converged tree after all changes:

```
$ npm test > /tmp/reviewfix.log 2>&1; echo $? > /tmp/reviewfix-exit.txt
$ cat /tmp/reviewfix-exit.txt
0
```

## Changelog paragraph, for whoever integrates this

> Fixed: two ways an install could quietly end up running code against a
> schema it was never verified with. First, the installer itself now refuses a
> package whose migration files collide or skip a number — naming the exact
> files — before it touches the database, instead of trusting that a test on
> some other machine caught it; and a failed read of the migration ledger now
> stops the command instead of impersonating a brand-new install and slipping
> past the checksum guard. Second, `brain deploy` refuses to put active code
> on a brain whose last update never finished, and the "paused for upgrade"
> state now lives in the database itself, where a deploy cannot erase it by
> rewriting bindings — so the one command anyone reaches for on a confusing
> day can no longer silently resume writes over a half-migrated corpus. Both
> refusals name the repair: `brain doctor --repair`, then `brain update`.
