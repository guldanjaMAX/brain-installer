# Verified Cloudflare recovery

Recovery is complete only when an isolated Brain can be rebuilt from a D1
export and pass retrieval evaluation. A D1 bookmark or SQL file by itself is
not that proof because Vectorize is derived state and cannot be restored with
D1.

## Safety boundary

`operations/verified-recovery.mjs` creates an owner-only plan and state file.
The files contain only configuration fingerprints, fixed policy, aggregate
counts, and bounded status codes. They contain no manifest path, account or
resource identifier, hostname, query, answer, document identity, content, raw
provider response, or credential.

The source and target manifests must describe the same client, product version,
and embedding contract. The target D1 database, Vectorize index, Worker, and any
declared domain must be separate from the source. A provider adapter must then
prove that the target has zero user tables and zero vectors, with the expected
Vectorize dimensions and metric, before the first target write is reachable.

Initialize and inspect the control files with:

```bash
node operations/verified-recovery.mjs init \
  <source-manifest> <isolated-target-manifest> \
  <private-plan> <private-state>

node operations/verified-recovery.mjs status <private-plan> <private-state>
```

Both destinations are created as mode `0600` files and existing files are
refused. Instance plans and state are ignored by Git.

## Required lifecycle

The reviewed order is fixed:

1. Build a complete restorable D1 SQL artifact from the reviewed durable tables
   and the exact checked-in migrations already applied on the source.
2. Hash the artifact, restore it locally with SQLite safe mode, run database
   and FTS integrity checks, and record only its schema, aggregate, and exact
   durable-data fingerprints.
3. Prove the remote restore target is the reviewed, empty D1 and Vectorize pair.
4. Import the exact verified SQL artifact into that isolated D1 database.
5. Export the restored durable tables back from D1 and require integrity,
   schema, aggregate counts, and the exact data SHA-256 to match the source
   artifact.
6. Run the existing full reindex path and drain until every D1 chunk has one
   vector, the outbox is empty, and no vector failed.
7. Run post-restore health with zero failures and zero vector backlog.
8. Run the release evaluation profile with zero critical failures and zero
   unauthorized retrievals.

Every stage is persisted as `running` before its adapter executes. If the
process stops after an external write but before the completion receipt, the
next run retries that same stage. A mutating adapter must reconcile an already
completed write and return the same evidence. It must never infer that a write
did not happen from a missing local completion receipt.

The runner also requires both manifests to be reopened and matched to the plan
before and after every adapter call. A changed resource, runtime setting, or
manifest file therefore leaves the current stage retryable instead of letting a
credential or write cross the reviewed boundary.

The SQL artifact contains the Brain's text and metadata. It must stay in a
private owner-only directory and is never a support artifact. The single-file
import contract refuses exports above 5 GiB; a reviewed split-import procedure
is required above that boundary.

## Disposable Cloudflare field gate

`operations/cloudflare-recovery-adapter.mjs` is the reviewed live provider
adapter. It can exercise the state machine only against an already-provisioned
disposable target. It has no command that creates, deploys, promotes, deletes,
or destroys a Cloudflare resource. It does not touch Supabase.

A normal full D1 export cannot include an FTS5 virtual table. The adapter never
drops or changes source FTS. It exports data only from the exact reviewed table
allowlist, prepends the exact checked-in migrations recorded on the source, and
recreates the derived FTS index through those migrations and triggers. The
`vector_outbox` queue is recreated empty instead of copied because Vectorize is
rebuilt; source verification therefore also requires that queue to be empty.
Any unknown durable table, migration mismatch, schema mismatch, FTS integrity
failure, aggregate mismatch, or durable-data hash mismatch stops the run.

Cloudflare's remote D1 export takes a blocking lock. Run the source export only
in an approved maintenance window with source ingest and writes paused. The
`source_export_blocking_approval_fingerprint` is the explicit acknowledgement
for that exact source. It is not a claim that the adapter can detect traffic.

Before preview, prepare all of these locally and out of band:

- reviewed source and target manifests that produced the private recovery plan;
- an empty disposable D1 database, zero-count Vectorize index, and deployed
  Worker in the reviewed Cloudflare account;
- one shared random nonce in the target Worker, D1, and Vectorize names. The
  Worker name must end in `recovery-gate-<nonce>` and its hostname must be the
  matching `*.workers.dev` hostname. Production-like names are refused;
- exact Worker bindings to the target D1 and Vectorize resources, the reviewed
  Brain identity and version, and only the `ADMIN_KEY` secret;
- a fresh manual Cloudflare review that the target Worker has no routes and no
  custom domains. Record the immutable deployed version ID, empty route lists,
  and review timestamp in the target manifest's
  `operations.recovery_field_gate`. The adapter pins that version on every
  stage, but route inventory is a manually reviewed assertion because Wrangler
  does not expose it through this adapter;
- the target manifest's `operations.admin_key_secret` Keychain locator, with
  the disposable target key already stored there;
- an executable Wrangler wrapper in an owner-controlled, non-writable-by-others
  directory that reads its Cloudflare token from Keychain at execution time;
- an owner-only directory for the SQL artifact and a complete private release
  evaluation golden set.

The preview is local only. It reads and fingerprints those files but does not
invoke Wrangler, read Keychain, or call either Brain:

```bash
node operations/cloudflare-recovery-adapter.mjs preview \
  --source-manifest <source-manifest> \
  --target-manifest <disposable-target-manifest> \
  --plan <private-plan> \
  --state <private-state> \
  --artifact-directory <owner-only-directory> \
  --wrangler-wrapper <owner-only-keychain-wrapper> \
  --golden <private-release-golden>
```

The preview returns six independent approvals:

- `plan_fingerprint` binds the full reviewed recovery policy and both manifests;
- `target_approval_fingerprint` binds the isolated D1, Vectorize, Worker, and
  hostname identity;
- `target_execution_approval_fingerprint` binds the pinned Worker version plus
  the manually reviewed empty route and custom-domain claim;
- `source_export_blocking_approval_fingerprint` binds the source whose D1
  export will take a blocking lock during the approved maintenance window;
- `wrapper_approval_fingerprint` binds the exact Keychain-backed wrapper bytes;
- `golden_approval_fingerprint` is the SHA-256 of the exact private release
  golden bytes that will judge the restored Brain.

Copy all six values from that preview into the run command:

```bash
node operations/cloudflare-recovery-adapter.mjs run \
  --source-manifest <source-manifest> \
  --target-manifest <disposable-target-manifest> \
  --plan <private-plan> \
  --state <private-state> \
  --artifact-directory <owner-only-directory> \
  --wrangler-wrapper <owner-only-keychain-wrapper> \
  --golden <private-release-golden> \
  --approve-plan <plan-fingerprint> \
  --approve-disposable-target <target-resource-fingerprint> \
  --approve-target-execution <target-execution-fingerprint> \
  --approve-source-export-blocking <source-export-fingerprint> \
  --approve-wrapper <wrapper-fingerprint> \
  --approve-golden <golden-fingerprint> \
  --stop-after-stage restore_d1
```

`--stop-after-stage` is an optional supervised drill control. Its only accepted
values are `export_d1`, `restore_d1`, and `rebuild_vectorize`. The field gate
still requires all six approvals and completes all verification leading to the
named stage. It then persists that stage's completed evidence, releases the
field-gate lock, reports only the fixed code
`RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION`, and exits nonzero. Re-run the
identical approved command to continue. Because the named stage is already in
the durable completed prefix, the rerun does not execute its external effect or
stop there again. Omitting the option runs every remaining stage normally.

One disposable target can exercise all three checkpoint boundaries in order:

1. Run with `--stop-after-stage export_d1` and require the intentional nonzero
   exit. Confirm status now names `verify_export`.
2. Re-run with `--stop-after-stage restore_d1`. It resumes after the export,
   completes the verified import, then stops. Confirm status names `verify_d1`.
3. Re-run with `--stop-after-stage rebuild_vectorize`. It resumes after the
   import, completes the vector rebuild, then stops. Confirm status names
   `verify_health`.
4. Re-run that exact third command. The rebuild is already checkpointed, so the
   run continues through health and release evaluation without rebuilding it.

Changing only this stop boundary does not authorize another resource or write.
The same manifests, target execution claim, wrapper, private golden bytes,
plan, and six approval fingerprints remain mandatory on every invocation. A
valid but changed golden set is refused before Cloudflare or Keychain access.

The adapter reopens and fingerprints the wrapper, manifests, golden set, and
artifact directory before and after every stage. Wrangler receives a narrow
child environment and transient private log directory, and runs from a private
copy of the exact approved wrapper. Wrangler logging is sanitized and telemetry
is disabled. Every command explicitly disables experimental provisioning and
automatic resource creation; executing the exact local wrapper avoids package
or skill installation paths. Authenticated HTTPS
requests refuse redirects, contain no private values in URLs, and read the
target admin key from Keychain only after the target identity is proven.
Provider diagnostics, credentials, corpus content, and resource names never
enter the plan, state, or command output. The private SQL artifact is the one
necessary corpus copy and remains mode `0600` in the owner-only directory.

Interrupted runs resume from the persisted stage. A retry after import accepts
only an exact completed target or the original empty target. Any partial or
ambiguous target stops for review. A leftover
`.brain-recovery-field-gate.lock` is also fail-closed; inspect the prior process
and private state before removing that lock manually.

Passing deterministic tests is not a production recovery claim. The remaining
live release gate is to provision the disposable resources out of band, refresh
the manual no-route/no-custom-domain review and pinned version claim, pause
source writes for the approved export window, and complete one full run. That
run must exercise the three deterministic post-checkpoint stops above,
followed by independent Cloudflare confirmation that source resources and
production routes did not change. Disposal of the test resources is a separate
operator action; this adapter has no destroy command.

Cloudflare documents the current export and import commands in
[Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and the complete flags in the
[D1 Wrangler command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
Vectorize inspection commands are in the
[Vectorize Wrangler command reference](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/).
