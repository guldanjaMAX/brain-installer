# Update and recovery audit

From a maintainer source checkout, the release gate is `npm run audit:updates`.
Audit scripts and fixtures are not installed on client machines.
A green unit suite does not clear
this gate. `docs/update-incidents.json` retains the original F1-F16 and N1-N6
findings and subsequent field incident classes. Each has an explicit fresh,
upgrade or recovery scope, reproduction/acceptance requirement and disposition.
No customer identities, messages, account IDs, credentials or private logs belong
in this repository. Keep the source-message crosswalk in the private work folder.

## Required sequence for every candidate

1. Review newly authorized support evidence, email reports and technician
   messages before changing an incident's status. Record the search date,
   coverage and inaccessible sources privately. A promise of a fix is not a
   recovery receipt. Never contact the client automatically.
2. Reconcile the package digest, actual executable and prefix, manifest version,
   deployed Worker version and D1 product/schema version independently. Preserve
   discrepancies until explained. Match account IDs, not similar display names.
3. Reproduce the incident with synthetic data and actual product entrypoints.
   First demonstrate the failure against the affected code. Do not bypass the
   CLI wrapper. Start from both clean OS-native configuration and migrated
   configuration, without the maintainer's cached credentials or environment.
4. Run `npm test` and `npm run audit:regressions`. The second command runs each
   incident suite independently and retains every exit status, even after an
   earlier failure. CI runs this step even if the main suite fails. A missing,
   timed-out or signalled process is a failure; skipped hardware checks remain
   unproven. Never pipe the command being verified into an output filter.
5. Prove the full lifecycle: bootstrap to actual confirmed batch history, add
   and delete documents, upgrade, delay provider visibility, interrupt, restart,
   contend for the lease, attempt connector writes during pause, then verify
   ingestion and cited retrieval. Cover queued-only and submitted outbox rows,
   exact-generation replacements and delete absence. Small fixtures prove state
   transitions; they do not prove million-row recovery duration.
6. Test the same packaged bytes on Mac and Windows, Node 22 and 24. Record OS
   and architecture separately. Windows x64 CI is not Windows ARM64 proof.
   The Windows ARM64 Node 24 case needs a real packaged launch, DPAPI roundtrip,
   browser login, interruption/resume and clean process exit. Native macOS
   sign-in must work without setting XDG_CONFIG_HOME as a workaround.
7. Complete an authorized disposable recovery rehearsal before a customer
   recovery. D1 holds the documents; Vectorize is derived. A D1 bookmark alone
   is not a tested rollback of both. Never begin with a bookmark restore,
   export a live Brain, clear drain mode manually, or edit applied migrations.
8. Attach a reviewed, sanitized evidence file under `docs/` before changing an
   incident to `verified`. Include tested commit, package SHA-256, platform,
   architecture, source/target versions, fixture shape, actual commands and exit
   codes, interruption point, before/after counts and retrieval result. Reopen
   affected incidents when code or dependencies change. The validator checks
   presence and disposition; the reviewer must verify the evidence itself.
9. Run `npm run audit:updates`. Release publication runs this again on the
   exact tagged checkout, before any release write. Every incident must be
   verified. Full CI, immutable artifacts and owner field gates still apply.

## Dispositions

- `open`: a defect, unresolved report or missing recovery/hardware proof.
- `local-only`: candidate code has regression coverage; field acceptance is
  incomplete. This still blocks public release.
- `verified`: reviewed evidence meets the incident's acceptance criteria.

Deleting a row, broadening an exception, increasing a timeout, or pointing to
unrelated passing CI is not closure. Keep an old report's conclusion separate
from what the present candidate actually proves.

## Current frozen-watermark blocker

Run `node --no-warnings scripts/reproduce-frozen-vector-fence.mjs`. It currently
exits 1: an accepted mutation is overtaken, the provider's last processed time
is only 123.6 seconds later, and twenty cron invocations cannot satisfy the
five-minute skew margin. The provider time is the time of its last mutation,
not a clock that advances merely because the client waits. The old regression
advances it with an external mutation, concealing this idle-index failure.

The next fix should acquire the existing drain lease and submit a bounded,
idempotent ordering probe after a persistently unresolved fence. It must record
the new accepted mutation durably and wait for provider proof before normal
work resumes. Verify no-op probe semantics on a disposable real index first.
Never treat timeout as confirmation, acknowledge rows from counts alone, or
discard the existing fence. Test delayed visibility, invalid receipts, lease
loss, crashes around receipt persistence, repeated overtaking, queued-only and
submitted rows, and unchanged delete/generation safety. Rate-limit probes and
include their D1 work in the invocation budget. This fix is not implemented or
field-proven in this branch.

## Recovery handoff acceptance

Report separately: writes active; source refresh working; queued/submitted/
confirmed/failed counts and their trend; reconciled vector coverage; actual
cited retrieval; versions and account agreement; and remaining warnings.
Do not label an HTTP 200, upload count, package installation or successful
login as a completed update. Never promise a duration without a measurement.
