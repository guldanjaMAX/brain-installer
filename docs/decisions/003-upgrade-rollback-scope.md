# ADR 003: Code rollback and data restore are separate operations, and only one of them may ever be automatic

- Status: Accepted
- Date: 2026-08-28
- Owners: Product and engineering
- Confidence: High on the split and on the refusal of automatic data restore; medium on the pre-schema code-rollback item, which is specified here and not yet implemented
- Supersedes: None
- Decided against: brain-installer 0.1.22

## Problem

A release requirement, tracked externally as UPD-02, states that upgrades must
roll back automatically. `brain.mjs` has carried the opposite position since the
upgrade path was written: rollback is deliberately not automatic, because a
restore is destructive and irreversible and running one unattended against a
client's only copy of their material trades a broken deploy for data loss.

Both were readable at once, and neither cited the other. Whichever a reader
believed, the other was wrong. That is worse than either position on its own,
because a requirement that cannot be satisfied as written eventually gets
waived, and once one gate is waivable every gate reads as advisory.

The requirement text does not exist anywhere in this repository or its history
(`git grep UPD-02` across every ref returns nothing), so this record is where it
is brought in and amended rather than argued with from a distance.

The collision has one cause: "rollback" was being used for two operations with
completely different blast radii.

| Operation | What it costs to undo | What it costs to get wrong |
|---|---|---|
| Replace the Worker code | One deploy | The brain serves the old behaviour for a few seconds |
| Restore D1 to a bookmark | Nothing; it is not undoable | Every write since the bookmark is destroyed, and Vectorize is not restored, so semantic retrieval stays wrong until a reviewed index rebuild |

There is real history behind the second row. A field install sat paused for
eight days silently accepting no documents after an upgrade stopped mid-run, and
the repair path built for that (`brain doctor --repair` / `--rollback`, 0.1.20)
was deliberately preview-first: it prints what it would do and changes nothing
until a human adds `--yes`. That was the right call then and this record does
not reverse it.

## Options considered

1. **Satisfy UPD-02 literally: restore D1 automatically on any failed check.**
   Rejected. This product holds a client's only copy of their material. An
   unattended destructive restore is a worse failure than staying down, and it
   would not even work: D1 restore does not restore Vectorize, so the install
   would come back with a corpus and an index that disagree, reporting healthy.

2. **Keep refusing all rollback and mark UPD-02 as permanently waived.**
   Rejected. It is the outcome the report predicted and named: one waived gate
   turns the whole manifest advisory. It also throws away a true and useful
   half — code really can be rolled back cheaply.

3. **Split the requirement by blast radius.** Accepted, below.

## Decision

UPD-02 as written is amended into two requirements, and the release classes it
applies to are named.

**UPD-02a — code.** Rolling back Worker code is permitted to be automatic. An
upgrade must never leave an install in a state it did not name out loud, and for
any failure that occurs before the schema can have changed, the guidance a
person reads must say that nothing in their material moved. Automatically
redeploying the *previous* Worker version, in the window where the compatibility
build is deployed and paused but the migration has not run, is permitted under
this requirement and is **not implemented**. Two things stand in the way and both
are stated rather than hidden: the installer never captures a previous-version
handle, and an unattended deploy on a failure path is itself a deploy that can
fail, which would replace one known state with an unverified one. Closing it
needs previous-version capture plus a disposable-account field gate, and until
that exists this half is open, not satisfied.

**UPD-02b — data.** Restoring D1 is never automatic. Not on a failed health
check, not on a failed acceptance run, not on a timeout, not behind a flag. The
bookmark is captured before any mutation, printed, and recorded; performing the
restore stays a reviewed human decision, and the tooling that performs it
(`brain rollback`, `brain doctor --rollback`) previews by default and mutates
only on an explicit `--yes`. This is a refusal with a reason, not a deferral,
and it does not expire.

**Release classes.** What an upgrade may do automatically follows from what the
release actually contains, not from how the release was labelled in advance:

| Class | What it contains | What may be automatic |
|---|---|---|
| Code-only | No pending migrations | Code rollback (UPD-02a). Nothing to restore, because nothing was written. |
| Migration | One or more pending migrations | Code rollback only up to the point the migration begins. The data half needs a human, every time. |
| Breaking | A migration that is not backward compatible with the deployed Worker | A human for the data half, and a rehearsal on a copy before the run. |

The class is not a label somebody assigns. It is decided at the moment of
failure by what has actually committed, which is why `upgradeFailureScope`
classifies by stage rather than by anything declared up front.

## Consequences

**Newly required.** Every failure inside `cmdUpgrade` is classified into
`code-only`, `schema-partial` or `schema-advanced`, the guidance is written for
that scope, and the scope is recorded in `upgrade_runs.detail` alongside the
stage so `brain status` shows it afterwards. A stage that is not listed in
`UPGRADE_PRE_SCHEMA_STAGES` classifies as `schema-advanced`, so a stage nobody
remembered to add is misclassified towards "the schema may have moved" rather
than towards "nothing happened".

**Easier.** A run that stopped before touching the schema now says so instead of
printing a destructive-restore warning at somebody whose material never moved.
That warning is the one an operator has to be able to take seriously, and it
loses its force fastest when it appears on failures it does not apply to.

**Explicitly unsupported.** Automatic D1 restore. Any flag, environment variable
or option that would perform one unattended. If a future requirement asks for it
again, this record is the answer.

**Still open.** UPD-02a's previous-version redeploy. It is specified above and
not built, and no part of this repository claims otherwise.

## Verification

- `test/upgrade-rollback-scope.test.mjs` drives the real `cmdUpgrade` to failure
  at each stage with injected provider fakes and asserts the scope, the recorded
  history detail, and that the guidance for a pre-schema failure states that
  nothing changed and does not present the bookmark as the repair.
- The same suite asserts the two mutating rollback paths refuse to act without
  `--yes`, by executing them and counting mutations rather than reading their
  source.
- `test/upgrade-verify.test.mjs` continues to prove that no failure at any stage
  advances the D1 version, the manifest version, or the corpus.
- Not verified: any live provider behaviour. Everything above is deterministic
  and offline. The previous-version redeploy is unimplemented, so there is
  nothing to verify for it.

## Revisit when

- A previous-version handle is captured at deploy time and a disposable-account
  field gate has exercised redeploying it, which is what UPD-02a's open half
  needs.
- Vectorize gains a point-in-time restore, which is the single fact that would
  make an automatic D1 restore less than catastrophic and is the reason
  UPD-02b's refusal is worded around the index rather than the database.
