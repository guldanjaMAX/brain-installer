# WP-00 (continued): checksum reconciliation for a changed applied migration — evidence

Branch: `wave0/wp00-checksum-repair`, worktree `/private/tmp/brain-wp00-checksum-repair`,
branched from `wave0/connector-gaps` at commit `b8b2cad` ("Fix two real
failures the full test chain caught: identity leak, missing allowlist").

**This supersedes the "exact commands for James/Jay" section at the bottom
of `evidence/WP-00.md`.** That section's step 3 (`brain doctor <manifest>
--repair --yes`) is wrong for the actual failure the real install hit — see
"Why the earlier fix doesn't work" below. This file has the correct command.

## What this package is, and how it differs from the earlier WP-00 commit

The plan (`planning/04-connector-gap-execution-PLAN.md`, section "WP-00:
Stranded-upgrade recovery", corrected 2026-08-27) states the root cause
precisely, and it was verified again here against the code before writing
anything: `cmdMigrate` in `brain.mjs` has a checksum guard —

```js
for (const mig of all) {
  const prev = appliedMap.get(mig.version);
  if (prev && prev.checksum !== mig.checksum) {
    die(
      `migration ${mig.name} was already applied but its content has changed.\n` +
        `      applied checksum ${prev.checksum}, file checksum ${mig.checksum}\n` +
        "      Never edit an applied migration. Add a new one instead."
    );
  }
}
```

— that runs BEFORE any pending migration is even considered, unconditionally,
with no force flag, skip flag, or repair path anywhere in `cmdMigrate` itself
(confirmed before writing anything here: `sed -n '/^export async function
cmdMigrate/,/^async function cmdStatus/p' brain.mjs | grep -in force` →
zero matches). A real field install is
stranded on exactly this: a migration file's bytes changed after it was
already applied — the confirmed hypothesis is a line-ending change — and
every subsequent `brain migrate` / `brain update` / `brain upgrade` now
hard-stops before touching anything.

### Why the earlier fix (`--repair`/`--rollback`, commits `18a5a1b`/`32bd0e8`,
already on `wave0/connector-gaps`) does not close this

Those commits are real, tested, and valuable — they gave `brain doctor` a way
to see a DEPLOYED brain's live paused-for-upgrade state and a named entry
point to resume or roll back a migration that died mid-flight. But
`cmdDoctorRepair`'s `repair` action calls `runUpgrade` (`cmdUpgrade` by
default), which calls `cmdMigrate` again, which walks straight back into the
same unconditional checksum `die()`. Confirmed by reading `cmdDoctorRepair`
(`brain.mjs`) end to end: there is no branch anywhere in that path that
treats a checksum mismatch differently from a migration that failed for any
other reason. Retrying resumes nothing here — the install was never
mid-migration to begin with; an already-applied migration's file drifted
afterward. Rollback does not fit either: there is nothing to restore, since
nothing about the actual database is wrong — only the STORED CHECKSUM no
longer matches the current file.

### The actual fix: reconciliation, not resume or rollback

The schema is presumably already in (or close to) the state the edited file
describes. The fix is to show the operator exactly what changed, require
explicit confirmation, and then update the STORED checksum in
`schema_migrations` to match the current file — without running any SQL
again. Re-running migration SQL blindly on top of an already-correct schema
risks a second, different kind of corruption stacked on the first.

## What was built

**Command chosen: `brain doctor <manifest> --repair-checksum [--yes]`.**

Reasoning: `brain doctor <manifest>` already has `--repair` (resume a stuck
migration) and `--rollback` (restore to the pre-migration D1 bookmark). Both
are stuck-*mid*-migration recovery paths. `--repair-checksum` reads clearly
next to them, keeps the reconciliation path under the same discovery surface
(`brain doctor <manifest> --help`-adjacent, same command family, same `--yes`
confirmation convention) rather than inventing a new top-level command, and
its name is self-explanatory about what specifically it repairs — the
checksum, not the migration run itself — which matters because conflating it
with `--repair` is the exact mistake that would re-strand an operator.

What it does, in order:

1. **Detect.** `diagnoseChecksumDrift(manifestPath, options)` — new,
   exported, read-only, tolerant of every resolution failure (missing
   `d1_database_id`, no Cloudflare token, a D1 outage), matching the existing
   `probeUpgradePause` convention exactly, so it can run unconditionally as
   part of PLAIN `brain doctor <manifest>` (no flags) and catch the drift
   BEFORE an operator ever runs `brain update` and gets stranded by it. Reads
   `schema_migrations` directly (SELECT version, checksum, name), loads the
   local migration files, and compares checksums for every version that
   exists in both. A genuine D1 read failure degrades to `checked:false`
   rather than a confident "no drift found" — see "A correctness bug found
   and fixed while writing this" below for why that distinction mattered
   enough to write a dedicated code path for it.
2. **Explain.** For each mismatched migration, `describeChecksumDrift`
   positively confirms whether the drift is EXACTLY a line-ending change and
   nothing else — the one class of drift this tool can prove without the
   original applied bytes (only their checksum was ever stored, by design).
   It converts the current file's content to LF-only and to CRLF-only and
   checks each against the applied checksum; a match in either direction
   names exactly which direction the drift went (applied-LF/file-CRLF or
   applied-CRLF/file-LF) and states the SQL content itself did not change.
   When neither transform matches, it says so honestly — "not confirmable as
   a pure line-ending change" — and tells the operator to review the file by
   hand, rather than fabricating a diff against bytes that were never kept.
   `printChecksumDriftDiagnosis` renders this for every drifted migration:
   applied-at timestamp, both checksums, current file's line/byte counts,
   and the explanation.
3. **Refuse without confirmation.** `cmdRepairChecksum(manifestPath,
   options)` always prints the full diagnosis first. With no `--yes`
   (`confirmed` not `true`), it previews only — `{previewed:
   "repair-checksum", drift: [...]}` — and makes zero D1 calls beyond the
   read. Proven directly in the fixture test by asserting the fake D1 adapter
   received no UPDATE during preview.
4. **Reconcile only the confirmed rows.** With `confirmed: true`,
   `applyChecksumReconciliation(manifestPath, drift, options)` — a separate
   exported function, matching the `cmdRollback`-as-injectable-action pattern
   already used by `cmdDoctorRepair` — issues exactly one `UPDATE
   schema_migrations SET checksum = ? WHERE version = ?` per drifted
   migration and nothing else. No migration SQL runs. No other table or
   column is touched.
5. **`brain doctor <manifest>` (no flags) now also runs this check
   unconditionally** via a new `buildChecksumDriftCheck`, alongside the
   existing upgrade-pause check, so a client sees "N applied migration(s) no
   longer match their file" and the exact fix command as a FAIL line the
   next time they simply run `brain doctor` — not only if they already
   suspect this specific problem. Its `fix:` text explicitly says `--repair`
   will NOT resolve this, to prevent an operator from reaching for the wrong
   flag.

### A correctness bug found and fixed while writing this

The existing shared helper `appliedVersions(acctId, dbId, queryDatabase)`
(used by `cmdMigrate` and `cmdStatus`) swallows ANY query failure into an
empty list — `catch { return []; }` — with the comment "table does not exist
yet, so nothing is applied." That is a reasonable, conservative choice for
`cmdMigrate`'s own purpose (deciding whether it is safe to proceed). It is
the WRONG behavior for a diagnostic whose entire job is to report drift
honestly: reusing it as first written meant a genuine D1 outage during the
read was silently reported as "zero applied migrations, therefore zero
drift" — a confident negative from a degraded state, which is precisely the
honesty-rule violation flagged elsewhere in the same plan (triaged issue #3,
"Zero results from a degraded index are reported as 'nothing on file'"). This
was caught by the fixture test itself (a synthetic D1-outage case initially
failed with `checked:true, drift:[]` instead of the expected
`checked:false`), not by inspection. Fixed by having
`diagnoseChecksumDrift` query `schema_migrations` directly rather than
through `appliedVersions`, treating only a `no such table` error (a
genuinely fresh, never-migrated install) as legitimately empty, and
degrading to `checked:false` for every other failure. See the comment above
that block in `brain.mjs` for the full reasoning kept in the code itself.

### `.gitattributes`

The plan's WP-00 section names this as "also worth doing per his note": pin
migration file line endings so this class of drift cannot recur through a
different git client, editor, or `core.autocrlf` setting. Added
`migrations/d1/*.sql text eol=lf`. Verified none of the 14 existing committed
migration files currently contain a CRLF byte (`grep -cU $'\r'` over each —
zero matches), so this is a forward-looking guard only; nothing needed
renormalizing, and nothing was renormalized.

### Files changed

- `brain.mjs` — `diagnoseChecksumDrift`, `describeChecksumDrift` (internal),
  `printChecksumDriftDiagnosis` (internal), `applyChecksumReconciliation`,
  `cmdRepairChecksum` (all new, placed directly after the existing
  `cmdDoctorRepair`), `buildChecksumDriftCheck` (new, placed directly after
  the existing `buildUpgradePauseCheck`, wired into `cmdDoctor`),
  `dispatchDoctor` (new `--repair-checksum` flag, mutual exclusivity with
  `--repair`/`--rollback`), help banner updated.
- `.gitattributes` — new, pins `migrations/d1/*.sql` to LF.
- `test/checksum-reconciliation.test.mjs` — new, 33 assertions.
- `package.json` — added the new test file to the `test` script chain
  (right after `upgrade-repair.test.mjs`); version bump 0.1.20 → 0.1.21.
- `package-lock.json`, `templates/brain.manifest.json`, `README.md` (2
  release-link occurrences) — version bump, kept in lockstep per
  `test/current-version.test.mjs`.
- `CHANGELOG.md` — new `## 0.1.21` entry, written for the brain's owner, in
  the existing voice (matches the 0.1.19/0.1.20 entries' register).

### `onboarding/07-ingest-source-matrix.md` — deliberately NOT touched

Checked plan section 0, rule 3 ("every capability change updates
`onboarding/07-ingest-source-matrix.md` in the same change") before writing
anything, as instructed. That file documents ingestible SOURCES (Drive,
Gmail, Calendar, WhatsApp exports, SMS backups, etc.) — `grep -n -i
"repair\|rollback\|doctor\|checksum\|migration"
onboarding/07-ingest-source-matrix.md` returns nothing at all, confirming it
never covered `brain doctor`'s repair/rollback capabilities either. The
precedent commit that added `--repair`/`--rollback` (`18a5a1b`) did not touch
this file (per `evidence/WP-00.md`'s own "Files:" list). `brain doctor
--repair-checksum` is a CLI-diagnostics capability, not an ingest source, so
this file is the wrong place for it; the authoritative capability documents
for this class of change are the CLI's own `--help` banner (updated) and
`CHANGELOG.md` (updated), matching the existing precedent exactly. Also
checked `README.md`'s "If something goes wrong" section and `docs/MAINTAINER.md`
for a more detailed `brain doctor` capability listing that might need a
matching update — neither lists `--repair`/`--rollback` individually either
(both just say `brain doctor`), so neither needed a change for the same
reason.

## Test run (real, verbatim, no color codes)

```
$ node test/checksum-reconciliation.test.mjs
PASS  the fixture actually reproduces a checksum change from line endings alone
PASS  checked successfully
PASS  exactly one drifted migration found
PASS  reports the applied checksum
PASS  reports the current file checksum
PASS  reports when it was applied
PASS  positively confirms this as a line-ending change (LF applied, file now CRLF)

  0001_test_table  (schema_migrations version 1)
    applied at:        2026-08-01T00:00:00.000Z
    applied checksum:  001cdc136ff1cb38
    file checksum:     c298895ddd32c57e
    current file:      3 line(s), 74 byte(s)
    likely cause: a pure line-ending change: the applied migration was recorded with LF ("\n") line endings; the current file uses CRLF ("\r\n") instead. Converting this file's CRLF to LF reproduces the applied checksum exactly (001cdc136ff1cb38) — the SQL content itself did not change.

warn  repair-checksum preview only: nothing was changed.
·     Re-run with --yes to accept the current file content for the migration(s) above and update
·     schema_migrations to match. This does NOT re-run any migration SQL and does not touch the schema.
PASS  preview reports the drift without acting
PASS  no D1 write happened during preview
PASS  the stored checksum in the fake DB is still the old one

  0001_test_table  (schema_migrations version 1)
    applied at:        2026-08-01T00:00:00.000Z
    applied checksum:  001cdc136ff1cb38
    file checksum:     c298895ddd32c57e
    current file:      3 line(s), 74 byte(s)
    likely cause: a pure line-ending change: the applied migration was recorded with LF ("\n") line endings; the current file uses CRLF ("\r\n") instead. Converting this file's CRLF to LF reproduces the applied checksum exactly (001cdc136ff1cb38) — the SQL content itself did not change.

ok    schema_migrations reconciled: 0001_test_table now recorded as c298895ddd32c57e
PASS  reconciliation reports exactly one row reconciled
PASS  reconciled entry carries the new checksum
PASS  schema_migrations now stores the current file's checksum
PASS  exactly one UPDATE was issued, targeting the right version and checksum
PASS  zero re-execution of the migration's own SQL (the fake DB would have thrown otherwise)
PASS  zero data loss: the rest of the corpus is untouched
PASS  re-diagnosing after reconciliation finds no drift
PASS  a genuine content change is still detected as drift
PASS  but is NOT falsely explained as a line-ending change

  0001_test_table  (schema_migrations version 1)
    applied at:        2026-08-01T00:00:00.000Z
    applied checksum:  56a571427df1a7e4
    file checksum:     3c7ba3c7ba5f53e8
    current file:      2 line(s), 64 byte(s)
    likely cause: not confirmable as a pure line-ending change.
      The bytes this migration originally applied were never retained — only their
      checksum was. Review 0001_test_table by hand (your own version control history for
      this file, if any, is the fastest way) before confirming reconciliation.

ok    schema_migrations reconciled: 0001_test_table now recorded as 3c7ba3c7ba5f53e8
PASS  confirmed reconciliation still succeeds on an unexplained drift
PASS  a healthy install reports zero drift

ok    every applied migration's checksum matches its file. Nothing to reconcile.
PASS  cmdRepairChecksum is a no-op on a healthy install even with --yes
PASS  a missing manifest is reported as not-checked, never thrown
PASS  no d1_database_id degrades to not-checked, not a crash
PASS  no Cloudflare token degrades to not-checked, not a crash
PASS  a D1 outage degrades to not-checked, not a crash — NOT a confident 'zero drift'
PASS  a genuinely fresh install (no schema_migrations table yet) is checked:true with zero drift, not degraded

warn  could not check applied migrations for checksum drift: could not resolve this install's Cloudflare account: synthetic outage
PASS  an undiagnosable brain refuses to act blind rather than silently doing nothing
PASS  both drifted migrations are found in one pass

  0001_a  (schema_migrations version 1)
    applied at:        2026-08-01T00:00:00.000Z
    applied checksum:  1a135f3506e1e509
    file checksum:     80f0a78de548232b
    current file:      2 line(s), 42 byte(s)
    likely cause: a pure line-ending change: the applied migration was recorded with LF ("\n") line endings; the current file uses CRLF ("\r\n") instead. Converting this file's CRLF to LF reproduces the applied checksum exactly (1a135f3506e1e509) — the SQL content itself did not change.

  0002_b  (schema_migrations version 2)
    applied at:        2026-08-02T00:00:00.000Z
    applied checksum:  bb7d1ae674cb4089
    file checksum:     cc4c209cfc414e54
    current file:      2 line(s), 53 byte(s)
    likely cause: not confirmable as a pure line-ending change.
      The bytes this migration originally applied were never retained — only their
      checksum was. Review 0002_b by hand (your own version control history for
      this file, if any, is the fastest way) before confirming reconciliation.

ok    schema_migrations reconciled: 0001_a now recorded as 80f0a78de548232b
ok    schema_migrations reconciled: 0002_b now recorded as cc4c209cfc414e54
PASS  both are reconciled
PASS  each reconciled to its own correct new checksum
PASS  exactly two UPDATEs, no more
PASS  applyChecksumReconciliation itself updates exactly the entries it is given

checksum-reconciliation: all 33 tests passed
$ echo $?
0
```

Also re-ran, unmodified, to prove no regression:

```
$ node test/upgrade-repair.test.mjs | tail -1
upgrade-repair: all 26 tests passed

$ node test/migrations.test.mjs | tail -1
migrations: all 76 checks passed

$ node test/current-version.test.mjs
current version alignment: package, lockfile, template, changelog, and 2 install links all use 0.1.21

$ node test/package-privacy.test.mjs
PASS  published package contains 331 reviewed files and no client-private paths
```

### Full chain

```
$ npm test > /tmp/npm-test-full-output.txt 2>&1; echo $? > /tmp/npm-test-exit-code.txt
$ cat /tmp/npm-test-exit-code.txt
0
$ grep -c "^PASS" /tmp/npm-test-full-output.txt
1990
$ grep -c "^FAIL" /tmp/npm-test-full-output.txt
0
$ tail -3 /tmp/npm-test-full-output.txt
PASS  capability-link safety advances the durable gate version

secret-scan v4 (js): all tests passed
```

Every individual suite's own final summary line in that run reported a clean
pass (`grep -cE "all [0-9]+ (tests|checks) passed|passed$"
/tmp/npm-test-full-output.txt` → 53, no failures), including
`checksum-reconciliation: all 33
tests passed` in its correct position in the chain (right after
`upgrade-repair`, per the `package.json` edit) and the pre-existing
`upgrade-repair: all 26 tests passed` unchanged.

Note: this worktree needed its own `npm install` before `package-privacy` or
the full chain could run — `node_modules/` is gitignored and a fresh `git
worktree add` does not create it. That is expected worktree behavior, not a
project change; `npm install` added the same 4 already-reviewed bundled
dependencies (`@e965/xlsx`, `fflate`, `postal-mime`, `unpdf`) that
`package-privacy.test.mjs` already expects.

## Acceptance criterion, checked against the plan's own wording

"a fixture test proves detection (mismatched checksum reported clearly, with
what changed), proves the tool refuses to act without explicit confirmation,
and proves reconciliation succeeds and `schema_migrations` reflects the new
checksum afterward with no data loss":

- **Detection, reported clearly:** covered by the first block in
  `test/checksum-reconciliation.test.mjs`. The fixture seeds a fake D1 with
  one already-applied migration recorded under an LF-only checksum, then
  supplies the SAME migration's content with every `\n` rewritten to `\r\n`
  as "the current file" — the exact bug (a line-ending change), reproduced
  directly rather than merely described. `diagnoseChecksumDrift` finds it,
  reports both checksums, the applied-at timestamp, and — this is the part
  that goes beyond "detected a mismatch" — POSITIVELY CONFIRMS it as a pure
  line-ending change with the specific direction (applied-LF, file-CRLF)
  named in plain language, matching the real install's own stated
  hypothesis (see Jay's issue #2, referenced in the plan). A second block
  proves a genuine content change (a real column added, not just line
  endings) is still detected as drift but is honestly NOT claimed as an
  explained line-ending change — the tool never fabricates a diff it cannot
  back up.
- **Refuses without confirmation:** `cmdRepairChecksum` without `confirmed:
  true` returns `{previewed: "repair-checksum", ...}` and is proven, via the
  fake D1 adapter throwing on any statement it does not expect, to have
  issued the read-only diagnostic query and NOTHING else — no UPDATE call
  reaches the database.
- **Reconciliation succeeds, checksum reflects the new file, zero data
  loss, zero re-execution:** the confirmed-`--yes` path is proven to issue
  exactly one `UPDATE schema_migrations SET checksum = ? WHERE version = ?`
  per drifted migration (asserted directly against the call log), to leave
  the fake database's stand-in "rest of the corpus" counter completely
  unmoved, and — this is the strongest form of the "zero re-execution"
  claim available without inference — the fake D1 adapter is written to
  THROW on receiving anything other than the one read and the one write this
  command is allowed to make, including any `CREATE TABLE` or `INSERT INTO`
  from the migration's own SQL. If reconciliation ever replayed migration
  SQL, this fixture would fail with a thrown error, not silently pass. A
  final re-diagnosis after reconciliation confirms zero drift remains. A
  third block repeats the whole flow with two migrations drifted at once
  (one line-ending, one genuine content change) to prove the command handles
  more than a single drifted row correctly and independently.

"`health`/`brain doctor` reporting is proven honest under this specific
failure mode": `buildChecksumDriftCheck` makes plain `brain doctor
<manifest>` (no flags at all) surface this proactively — before an operator
ever runs `brain update` and gets stranded — with a `fix:` line that
explicitly states `--repair` will NOT resolve it, specifically to prevent
the mistake the earlier `18a5a1b` commit's advice would otherwise invite.
This builder is not unit-tested directly, matching the existing convention:
its sibling `buildUpgradePauseCheck` (from the earlier WP-00 commit) is also
untested directly, relying on its underlying diagnostic function
(`diagnoseChecksumDrift`, thoroughly tested above) for coverage.

## This never touched, and did not attempt to touch, a real/live/deployed brain

Every test in `test/checksum-reconciliation.test.mjs` runs against an
in-process fake D1 adapter (a `Map` standing in for the `schema_migrations`
table) and a fixture manifest written to a temp directory
(`mkdtempSync(tmpdir())`), with `resolveAccount` and `d1Query` both injected.
No network call to Cloudflare's API, no real account id, no real database id,
and no credential of any kind was used or needed anywhere in this package.
`diagnoseChecksumDrift`, `applyChecksumReconciliation`, and
`cmdRepairChecksum` never call Cloudflare's API (`cf()`) directly anywhere —
the only way any of them reach a network at all is through the injected
`resolveAccount` and `d1Query` parameters, and every test in
`test/checksum-reconciliation.test.mjs` supplies a fixture for both, so no
test in this package makes a real network call. The real stranded install was not
connected to, queried, or mutated in any way by this session — its manifest
and Cloudflare token are not present on this machine (same finding as
`evidence/WP-00.md`), and per the plan's explicit instruction, nothing
should be run against it without James's and the affected operator's
explicit go-ahead in the moment regardless.

## The exact live-repair command, for James (or the affected operator) to run themselves

Once this branch is merged and `npm install`/`npx wrangler` picks it up (or
directly against this worktree with `node brain.mjs ...`), against the real
manifest and a Cloudflare token scoped to that account:

```bash
# 1. Diagnose precisely — read-only, safe to run any time, changes nothing.
node brain.mjs doctor <path-to-the-stranded-brain.manifest.json>

# This alone should now show a FAIL line for "migration checksums" (in
# addition to whatever "upgrade state" already shows) naming the exact
# migration(s) that no longer match their file, with a fix pointing at
# --repair-checksum specifically (NOT --repair, which was tried before and
# does not fix this).

# 2. Preview the reconciliation (still nothing changes) — this prints both
#    checksums, when it was applied, and whether the change is confirmed as
#    pure line-ending drift or needs manual review:
node brain.mjs doctor <path-to-the-stranded-brain.manifest.json> --repair-checksum

# 3. Once the preview looks right, confirm it:
node brain.mjs doctor <path-to-the-stranded-brain.manifest.json> --repair-checksum --yes

# 4. Confirm schema_migrations now matches, and that ordinary migrate/upgrade
#    work again:
node brain.mjs status <path-to-the-stranded-brain.manifest.json>
node brain.mjs migrate <path-to-the-stranded-brain.manifest.json>
```

If step 1 also still shows a FAIL for "upgrade state" (the brain is ALSO
currently paused-for-upgrade, on top of the checksum drift — plausible, since
the plan's root-cause note says `cmdUpgrade` deploys the paused worker BEFORE
running migration, so the checksum die() during that same run would leave it
paused too), run `--repair-checksum --yes` FIRST, then follow up with `brain
doctor <manifest> --repair --yes` (or `brain update <manifest>`) to complete
the deploy/verify steps of the upgrade the checksum guard had been blocking.
Reconciling the checksum first is required either way — `--repair` alone
will keep hitting the same `die()` until the checksum is reconciled.

## Anything not fully resolved

- **Not verified against the real stranded install**, by design and by
  explicit instruction — see "This never touched... a real/live/deployed
  brain" above. The command above is prepared and proven against fixtures
  only; it has not been run live. This mirrors exactly how `evidence/WP-00.md`
  reported its own repair/rollback path: built and tested, not yet
  field-verified, because this machine holds no credential for that
  install and mutating a real client's production D1 without their and
  James's presence is exactly the class of action these rules reserve for a
  human.
- **`buildChecksumDriftCheck` (the plain `brain doctor` health-check line)
  is not unit-tested directly** — see the acceptance section above for why
  this matches existing convention (its sibling `buildUpgradePauseCheck` is
  also untested directly) rather than an oversight. Its underlying
  diagnostic (`diagnoseChecksumDrift`) is exhaustively tested; the thin
  status/fix-text wrapper around it is not separately exercised.
- **`.gitattributes` was added but no repo-wide renormalization pass was
  run.** Confirmed all 14 currently-committed migration files are already
  LF-only, so this has no effect on current content and needed none; it is
  a forward-looking guard against a NEW drift being introduced, not a fix
  for a past one. If a future migration file is ever committed with mixed or
  CRLF line endings before this attribute takes effect on someone's working
  copy, `--repair-checksum` remains the correct recovery path regardless.
