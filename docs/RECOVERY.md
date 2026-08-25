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

1. Export the complete remote D1 database to a new SQL artifact.
2. Hash the artifact, restore it locally, run SQLite integrity checks, and
   record only its schema and aggregate fingerprints.
3. Prove the remote restore target is the reviewed, empty D1 and Vectorize pair.
4. Import the exact verified SQL artifact into that isolated D1 database.
5. Read the restored D1 back and require its integrity, schema, and aggregate
   counts to match the local export verification.
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

## Provider field gate still required

The module ships the deterministic plan, state machine, retry behavior,
privacy boundary, and adapter contract. It intentionally does not yet ship a
live Cloudflare adapter. Before claiming verified recovery in production, a
disposable real-account gate must prove all of the following:

- `wrangler d1 export <source> --remote --output <new-private-file>` produces a
  restorable full SQL export;
- the export can be imported into a newly created empty D1 target with
  `wrangler d1 execute <target> --remote --file <verified-export>`;
- the target-clean inspection cannot confuse D1's reserved `_cf_KV` table with
  a user table;
- an interrupted export, import, reindex, and drain each resume without
  duplicating or skipping a stage;
- `brain reindex`, `brain drain`, `brain health`, and the release evaluation run
  against the isolated target and satisfy the recorded gates;
- destroying the disposable target leaves the source account resources and
  production routes unchanged.

Cloudflare documents the current export and import commands in
[Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and the complete flags in the
[D1 Wrangler command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
