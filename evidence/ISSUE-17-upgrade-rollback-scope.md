# Issue 17: UPD-02 requires automatic rollback, and the documented position refuses it

## What the report said, and what I actually found

The report is right that the two positions contradict each other. One detail
about where they live matters, because it changes what "amend UPD-02" can mean.

**The requirement is not in this repository.** UPD-02 appears in no file, on no
branch, in no commit:

```
$ grep -rn "UPD-02" .                                 # nothing
$ git grep -l "UPD-02" $(git rev-list --all)          # nothing
$ grep -roE "\b[A-Z]{2,4}-[0-9]{2}\b" --include=*.md --include=*.mjs --include=*.json . \
    | sort | uniq -c | sort -rn | head
  48 WP-00
  26 WP-07
  21 WP-03
  ...
```

Every identifier of that shape in this tree is a `WP-` work package or an
`AX-17` reference. There is no `UPD-` series at all. So the requirement lives in
the reporter's own register, outside this repository, and half the reason the
two could disagree indefinitely is that a reader of either one never encountered
the other.

**The documented position is here, in three places**, and all three were written
about data while being worded as though they were about rollback in general:

- `brain.mjs`, above `cmdUpgrade`: "ROLLBACK IS DELIBERATELY NOT AUTOMATIC. The
  obvious design restores the D1 bookmark on any failed check. But a restore is
  itself destructive and irreversible..."
- `printRollbackPreview`: previews by default, warns that a restore is
  destructive and that it does not restore Vectorize.
- The `cmdUpgrade` failure message, which printed the D1 bookmark and the
  destructive-restore warning.

**The finding the report did not have.** That third one printed the SAME
paragraph for every failure, at every stage. Read the runner's order: install
state is read, a restore bookmark is captured, the compatibility build is
deployed paused, its paused mode is proved, old drains are given a grace window,
and only then does `migration` run. A failure in any of those first five stages
has altered nothing — no table, no document — and the operator was still handed
a D1 bookmark and told not to restore it.

That is the same defect as the rest of this batch, one level down: the product
was not telling the truth about what it had done. And it is not harmless. The
destructive-restore warning is the one an operator has to take seriously, and a
warning that fires on failures it does not apply to is a warning people learn to
click past. The eight-day stranded install this repository already records
happened in exactly this window.

There was no test covering a pre-migration failure. `test/upgrade-verify.test.mjs`
exercises `migration`, `bootstrap`, `active-deploy`, `active-health` and
`convergence`; the three stages before the migration had no failure case at all.

## Which way I resolved it, and why

**The requirement is wrong as written, and the fix is to the requirement, not to
the refusal.** `docs/decisions/003-upgrade-rollback-scope.md` amends it.

UPD-02 conflates two operations whose blast radii are not comparable:

| Operation | Undo cost | Cost of getting it wrong |
|---|---|---|
| Replace the Worker code | one deploy | old behaviour serves for seconds |
| Restore D1 to a bookmark | none; not undoable | every write since the bookmark destroyed, Vectorize not restored, so the corpus and index disagree while reporting healthy |

Applied to the second row, "roll back automatically" authorises an unattended
destructive restore against a client's only copy. For a product whose whole
proposition is that the client holds the only copy, that is not a strict
requirement, it is the worst available failure. So:

- **UPD-02b (data): never automatic.** A refusal with a reason, not a deferral.
  It does not expire, and the ADR names the one fact that would change it
  (Vectorize gaining a point-in-time restore).
- **UPD-02a (code): permitted to be automatic**, and partly achieved already —
  a failure before the paused deploy aborts with the client's existing Worker
  untouched, which is code rollback by not mutating. The genuinely open half is
  redeploying the *previous* Worker version after the paused deploy succeeded.
  I did not implement it, and the ADR says so with the reason: the installer
  captures no previous-version handle, and an unattended deploy on a failure
  path is itself a deploy that can fail, turning one known state into an
  unverified one. Closing it needs previous-version capture plus a
  disposable-account field gate.
- **Release classes** are recorded (code-only / migration / breaking), with the
  point that the class is not a label anyone assigns in advance: it is decided
  at the moment of failure by what has actually committed.

**Then the satisfiable part is satisfied.** `upgradeFailureScope` classifies
every failure and the guidance matches it. Three messages instead of one:

```
=== code-only ===
update stopped during paused vector-drain health verification: the paused mode never served
      Your brain's stored material did not change. This run stopped before the schema
      migration began: no table was altered, no document was written or removed, and
      the only D1 write was this run's own history row.
      A D1 restore is NOT the repair for this. It would discard writes that have
      nothing to do with this failure, and it would not restore Vectorize.
      Safe default: fix the reported issue and run brain update again.
      Recorded for completeness rather than as an instruction, D1 bookmark: 00000001-...-0001

=== schema-partial ===
update stopped during ...
      The migration may have committed part of its work, so this is the one failure
      where the schema is genuinely in an unknown state.
      First response, which previews and changes nothing until you add --yes:
          brain doctor <manifest> --repair
      Do not restore as the first response. ...
      D1 recovery bookmark: 00000001-...-0001

=== schema-advanced ===
update stopped during ...
      D1 recovery bookmark: 00000001-...-0001
      The schema has already advanced and the corpus may have been written, so this
      failure is the one where the bookmark matters.
      Do not restore it as the first response. ...
```

The bookmark survives in all three; what changes is whether it is presented as a
step or as a record. The paused-corpus block still appends to every scope,
because a paused brain is a fact about right now regardless of what changed.

The scope is also written to `upgrade_runs.detail` as `stage:<x> scope:<y>`, so
`brain status`, which lists the last five upgrade runs, carries it to whoever
picks the install up later.

The classifier fails safe. An unrecognised stage classifies as
`schema-advanced`, never `code-only`, so a stage somebody adds next year and
forgets to list is misclassified towards "the schema may have moved".

## What changed

| File | Change |
|---|---|
| `docs/decisions/003-upgrade-rollback-scope.md` | New. The amended requirement: UPD-02a code, UPD-02b data, the three release classes, what is open and what it needs. |
| `docs/decisions/README.md` | Indexed. |
| `brain.mjs` | `UPGRADE_PRE_SCHEMA_STAGES`, `upgradeFailureScope`, `upgradeFailureGuidance`; the `cmdUpgrade` catch uses them and records the scope in upgrade history; the doc comment above `cmdUpgrade` restated as a refusal of automatic DATA restore. |
| `test/upgrade-rollback-scope.test.mjs` | New. 48 checks driving the real `cmdUpgrade` to failure at nine stages. |
| `package.json`, `test/package-privacy.test.mjs` | ADR added to the package allowlist in both places; the new test added to the suite. |

No migration was added, so nothing collides with the highest existing migration
number. No schema changed.

## Discrimination

**1. Collapse the split, which is the behaviour before this change.**

```
$ # upgradeFailureScope() => "schema-advanced" for every stage
$ node test/upgrade-rollback-scope.test.mjs
FAIL  paused-deploy: it is recorded as code-only  [{"status":"failed","detail":"stage:paused vector-drain deployment scope:schema-advanced"}]
FAIL  paused-deploy: the operator is told their material did not change
FAIL  paused-deploy: and is NOT told not to restore, because restoring is not the question
FAIL  paused-deploy: the bookmark is still present, marked as a record rather than a step
FAIL  paused-health: it is recorded as code-only
FAIL  paused-health: the operator is told their material did not change
FAIL  paused-health: and is NOT told not to restore, because restoring is not the question
FAIL  paused-health: the bookmark is still present, marked as a record rather than a step
FAIL  quiescence: it is recorded as code-only
FAIL  quiescence: the operator is told their material did not change
FAIL  quiescence: and is NOT told not to restore, because restoring is not the question
FAIL  quiescence: the bookmark is still present, marked as a record rather than a step
32/48 upgrade rollback-scope checks passed
```

Restored: `48/48`, exit 0.

**2. Drop one stage from the pre-schema list, the drift this will actually
suffer from.**

```
$ # remove "vector-drain quiescence" from UPGRADE_PRE_SCHEMA_STAGES
$ node test/upgrade-rollback-scope.test.mjs
FAIL  quiescence: it is recorded as code-only  [{"status":"failed","detail":"stage:vector-drain quiescence scope:schema-advanced"}]
FAIL  quiescence: the operator is told their material did not change
FAIL  quiescence: and is NOT told not to restore, because restoring is not the question
FAIL  quiescence: the bookmark is still present, marked as a record rather than a step
44/48 upgrade rollback-scope checks passed
```

Restored: `48/48`, exit 0.

The tests execute rather than read. `cmdUpgrade` is driven to a real failure at
each of nine stages with injected provider fakes, and the assertions read the
thrown message and the row the runner wrote to `upgrade_runs`. The two mutating
restore paths are likewise executed and their mutations counted, not grepped:
`cmdRollback` and `cmdRollbackInteractive` both return without touching the
injected account resolver, D1 query, deploy or health functions when `--yes` is
absent.

## In my own words

I expected to be arguing for automatic rollback and found the opposite. The
refusal in this file is correct and I would not weaken it for a gate. What was
wrong is that it was written as a refusal of rollback rather than of restore,
which made a defensible position look like an evasion of a reasonable
requirement, and which let one paragraph of scary advice appear on failures
where nothing was at stake.

The part I want to be explicit about: I did not build automatic code rollback. I
could have written something that redeploys a previous Worker version and it
would have passed a test I also wrote, and neither would have told anyone
whether it works against Cloudflare. Shipping an unverified automatic action on
the failure path of a client's only copy is a worse answer than an open item
with its reason written down, so that is what UPD-02a has: a specification, a
statement that it is not implemented, and the two things needed to close it.

Whoever holds the external register still has to decide whether to accept the
amendment. The gate does not close because I wrote an ADR.
