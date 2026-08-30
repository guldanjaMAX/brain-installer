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

## Encrypted off-provider backup policy

The verified D1 SQL artifact is the durable recovery source. After its local
integrity and hash checks pass, encrypt its exact bytes with
`operations/off-provider-backup.mjs` before copying it to storage operated
independently from Cloudflare. The envelope uses AES-256-GCM, authenticates its
creation time, retention class, and plaintext SHA-256, and never contains the
key. The 32-byte key must be held out of band from both Cloudflare and the
backup object. Losing either the artifact or the key must not expose or destroy
the other copy.

Required retention classes are:

- daily: 14 copies, produced at least every 24 hours;
- weekly: 8 copies, promoted from a verified daily artifact;
- monthly: 12 copies, promoted from a verified daily artifact.

Retention is applied only after the independent destination acknowledges the
complete encrypted object and its artifact hash is checked. Do not remove a
local or older independent copy based only on an upload command exit code.
OAuth tokens, passkey challenges, enrollment codes, live sessions, drain
leases, Vectorize receipts, and provider-derived vectors are not backup data.
They are reauthorized, cleared, or rebuilt through the verified recovery flow.

The service objectives are a 24-hour recovery point objective and an 8-hour
recovery time objective. At least once every 90 days, restore one recent
encrypted artifact into an isolated target, rebuild Vectorize, pass exact D1
hash and aggregate comparisons, and run the release evaluation. Persist only
the content-free evidence produced by `buildRestoreEvidence`: artifact hash,
timestamps, duration, schema version, aggregate counts, and evaluation result.
`restoreEvidenceStatus` reports the evidence due on day 91.

This repository defines and tests encryption, retention metadata, objectives,
and evidence expiry. It does not claim that an independent storage account is
configured or that a live recurring restore has passed. Those remain explicit
deployment acceptance gates for each installation.

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

1. Build a complete restorable D1 SQL stream from the reviewed durable tables
   and the exact checked-in migrations already applied on the source, then seal
   it as an authenticated version-1 recovery artifact.
2. Hash the ciphertext, open it only in the owner-only artifact directory,
   restore the plaintext stream locally with SQLite safe mode, run database
   and FTS integrity checks, and record only its schema, aggregate, and exact
   durable-data fingerprints.
3. Prove the remote restore target is the reviewed, empty D1 and Vectorize pair.
4. Import the exact verified SQL artifact into that isolated D1 database.
5. Export the restored durable tables back from D1 and require integrity,
   schema, aggregate counts, and the exact data SHA-256 to match the source
   artifact.
6. Reconcile recovered security state while the target is still paused. The
   target must carry the complete reviewed secret-name set and the independent
   `BANK_FEED_WRAPPING_KEY_V2`. If the source already uses that key, an
   authenticated SHA-256 proof must match the target before import. Legacy bank
   references are compare-and-swap rewrapped to version 2. A reference that
   cannot be opened becomes explicit `reauth_required` state. No legacy or
   unsupported key version may remain connected.
7. While the reviewed compatibility Worker is deployed in
   `paused-for-upgrade` mode, drive the schema-13 `/api/admin/brain/bootstrap`
   contract until every D1 chunk has one query-visible vector, all durable batch
   receipts are confirmed, the outbox and submitted counts are zero, and no
   vector failed. A retry resumes the saved epoch, cursor, and batch history and
   never calls reindex to reset them. After exact inventory and provider-count
   proof, deploy only the pre-reviewed immutable active Worker version and prove
   that exact version and `active` mode before continuing.
8. Run post-restore health with zero failures and exact `vector_readiness`:
   `ready=true`, zero pending/submitted work, and equal D1/Vectorize counts.
9. Run the release evaluation profile with zero critical failures and zero
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

The durable `.brain-recovery-export.sql.fbrenc` artifact is authenticated
AES-256-GCM ciphertext. Its independent version-1 key is resolved only from the
target manifest's `operations.recovery_artifact_key_secret` Keychain locator.
The key never enters a manifest, plan, state, command line, or artifact. A
plaintext SQL file exists only inside the owner-only directory while the local
verifier or Wrangler import callback owns it, and it is removed afterward. Any
stale plaintext or encryption temporary is a hard stop for manual review. The
single-file import contract refuses exports above 5 GiB; a reviewed
split-import procedure is required above that boundary.

## Disposable Cloudflare field gate

`operations/cloudflare-recovery-adapter.mjs` is the reviewed live provider
adapter. It can exercise the state machine only against an already-provisioned
disposable target. It cannot create, upload, delete, or destroy a Cloudflare
resource. Its sole Worker mutation is the exact 100-percent deployment of the
active immutable version already named in the reviewed target claim, after the
paused bootstrap has passed exact vector proof. It does not touch Supabase.

A normal full D1 export cannot include an FTS5 virtual table. The adapter never
drops or changes source FTS. It exports data only from the exact reviewed table
allowlist, prepends the exact checked-in migrations recorded on the source, and
recreates the derived FTS index through those migrations and triggers. The
`vector_outbox` queue is recreated empty instead of copied because Vectorize is
rebuilt; source verification therefore also requires that queue to be empty.
Any unknown durable table, migration mismatch, schema mismatch, FTS integrity
failure, aggregate mismatch, or durable-data hash mismatch stops the run.
Migration checksums bind the exact reviewed SQL bytes. Schema comparison then
canonicalizes SQL comments and whitespace because D1 removes non-semantic
comments from `sqlite_schema` while local SQLite preserves them.

Cloudflare's remote D1 export takes a blocking lock. Run the source export only
in an approved maintenance window with source ingest and writes paused. The
`source_export_blocking_approval_fingerprint` is the explicit acknowledgement
for that exact source. It is not a claim that the adapter can detect traffic.

Before preview, prepare all of these locally and out of band:

- reviewed source and target manifests that produced the private recovery plan;
- an empty disposable D1 database, zero-count Vectorize index, and two immutable
  Worker versions in the reviewed Cloudflare account. The paused version must be
  the sole version deployed at 100 percent before the first field-gate stage;
- one shared random nonce in the target Worker, D1, and Vectorize names. The
  Worker name must end in `recovery-gate-<nonce>` and its hostname must be the
  matching `*.workers.dev` hostname. Production-like names are refused;
- exact bindings on both Worker versions to the target D1 and Vectorize
  resources, the reviewed Brain identity and version, the required
  `ADMIN_KEY`, `RAG_PROXY_KEY`, and `SESSION_SIGNING_KEY` secrets, the dedicated
  `BANK_FEED_WRAPPING_KEY_V2`, and only reviewed optional provider secrets.
  The target secret-name set must equal the source set plus the dedicated bank
  wrapping key when the released source does not have it yet. Their bindings
  must be identical except that the paused version has
  exactly `VECTOR_DRAIN_MODE=paused-for-upgrade` and the active version has no
  `VECTOR_DRAIN_MODE` binding;
- a fresh manual Cloudflare review that the target Worker has no routes and no
  custom domains. Record the immutable paused version as
  `paused_worker_version_id`, the immutable active version as
  `active_worker_version_id`, their identical reviewed script hash as
  `worker_script_etag`, the empty route lists, and review timestamp in the target manifest's
  `operations.recovery_field_gate`. The adapter pins and inspects both versions
  on every target stage, but route inventory is a manually reviewed assertion
  because Wrangler does not expose it through this adapter;
- the target manifest's `operations.admin_key_secret` Keychain locator, with
  the disposable target key already stored there;
- the target manifest's `operations.recovery_artifact_key_secret` Keychain
  locator, containing an independent version-1 32-byte recovery artifact key;
- an executable Wrangler wrapper in an owner-controlled, non-writable-by-others
  directory that reads its Cloudflare token from Keychain at execution time;
- an owner-only directory for the encrypted recovery artifact and a complete private release
  evaluation golden set.

The decrypted SQL stream never carries live derived-index coordination. The adapter
exports the reviewed `install_state` row separately from the raw provider tables
and forces the ephemeral drain lease owner/expiry and projection mutation
ID/submission time to `NULL`. It also resets the bulk-bootstrap protocol to
`NULL`, its verified base count to zero, and `outbox_generation` to zero because
the queue counter and those receipts prove only the source Vectorize index. For
a nonempty corpus it records `bootstrap_required`, epoch 1, a null cursor, and
the exact SQL `MAX(chunk_uid)` high-water. The `vector_outbox` and
`vector_bootstrap_batches` tables remain in the restored schema, but their
provider-specific rows are excluded from the export and recreated empty.
The normalized row is then hashed together with the remaining durable table
export, so a retry cannot reuse a recovery artifact poisoned by an
invocation-local lease, mutation fence, or old provider receipt. Older exact
migration prefixes remain offline-inspectable, but the live field runner
requires exact current schema 29 because it cannot safely use the current
lease, visibility, and durable bulk-bootstrap protocol across a schema drift.
Schema 29 also preserves Plaid's exact historical-readiness evidence and whether
a destructive Item-removal response was confirmed, known not to remove, or
unknown. Recovery does not turn an old local `complete` label into provider
historical proof and does not blindly replay an unknown removal.

Schema 22 recovery is exact and intentionally asymmetric. Exact-document
grants, grant membership, durable request receipts, document-access audit
events, privacy-safe passkey telemetry, and owner passkeys are durable. One-time
enrollment codes and authentication challenges are not exported. The recovered
`install_state.session_generation` is the source generation plus one, not zero
and not an exact copy. That monotonic increment invalidates every old owner or
scoped cookie while preserving passkeys for a fresh sign-in. Overflow or an
invalid source generation stops export. Schema 23 support audit events are
durable, while support sessions, requests, invitations, challenges, and
passkeys restore empty. Schema 24 destructive agent-action receipts are live
single-use authority and never enter the artifact. The recovered target must
read that table as exactly zero rows before and after bank-key reconciliation.
Time Travel rollback purges the same table and requires an exact zero-row
readback while the Worker remains paused. Immutable owner activity remains
durable. Schema 26 Plaid webhook receipts, reconciliation debt, and revocation
debt survive through reviewed projections. Schema 27 quota windows and schema
28 vector retry bookkeeping are recreated empty because both are live
operational state rather than corpus authority.

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
- `target_execution_approval_fingerprint` binds both pinned Worker versions plus
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
values are `export_d1`, `restore_d1`, `reconcile_security`, and
`rebuild_vectorize`. The field gate
still requires all six approvals and completes all verification leading to the
named stage. It then persists that stage's completed evidence, releases the
field-gate lock, reports only the fixed code
`RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION`, and exits nonzero. Re-run the
identical approved command to continue. Because the named stage is already in
the durable completed prefix, the rerun does not execute its external effect or
stop there again. Omitting the option runs every remaining stage normally.

One disposable target can exercise all four checkpoint boundaries in order:

1. Run with `--stop-after-stage export_d1` and require the intentional nonzero
   exit. Confirm status now names `verify_export`.
2. Re-run with `--stop-after-stage restore_d1`. It resumes after the export,
   completes the verified import, then stops. Confirm status names `verify_d1`.
3. Re-run with `--stop-after-stage reconcile_security`. It resumes after the
   import, reconciles bank custody or explicit reauthorization state, then
   stops. Confirm status names `rebuild_vectorize`.
4. Re-run with `--stop-after-stage rebuild_vectorize`. It resumes after security
   reconciliation, completes the vector rebuild, then stops. Confirm status
   names `verify_health`.
5. Re-run that exact fourth command. The rebuild is already checkpointed, so the
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
enter the plan, state, or command output. The encrypted recovery artifact is
the one necessary durable corpus copy and remains mode `0600` in the owner-only
directory.

Interrupted runs resume from the persisted stage. A retry after import accepts
only an exact completed target or the original empty target. Any partial or
ambiguous target stops for review. The vector rebuild resumes from schema-13
durable bootstrap receipts while the paused version remains deployed. If the
active-version deployment succeeded but its local response was lost, a retry
accepts the already-active target only after exact corpus, vector inventory,
outbox, provider count, immutable version, binding, and active-mode proof. A
first rebuild attempt that finds the active version is refused. A leftover
`.brain-recovery-field-gate.lock` is also fail-closed; inspect the prior process
and private state before removing that lock manually.

The offline interruption and custody matrix is:

```bash
npm run test:recovery-bank
```

It constructs a temporary HOME, inherits no credentials, uses only synthetic
SQLite and Cloudflare fixtures, interrupts every declared recovery mutation
before its receipt and after its durable checkpoint, and interrupts all four
bank row mutation seams. Passing it is scripted proof only.

Passing deterministic tests is not a production recovery claim. The remaining
live release gate is to provision the disposable resources out of band, refresh
the manual no-route/no-custom-domain review and both pinned version claims, pause
source writes for the approved export window, and complete one full run. That
run must exercise the four deterministic post-checkpoint stops above,
followed by independent Cloudflare confirmation that source resources and
production routes did not change. Disposal of the test resources is a separate
operator action; this adapter has no destroy command.

Cloudflare documents the current export and import commands in
[Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and the complete flags in the
[D1 Wrangler command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
Vectorize inspection commands are in the
[Vectorize Wrangler command reference](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/).
