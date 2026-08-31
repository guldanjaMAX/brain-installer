# Shared Brain maintainer guide

This is the operating guide for engineers who maintain the shared installer.
It describes the current 0.2.x product line, how to change and release it safely, and
how to update an owner's existing Brain. It is not an instance handoff. Never
put an owner's manifest, resource identifiers, source details, private golden
set, support export, or credentials in this repository.

Repository access and Brain access are intentionally separate. A maintainer can
review, test, and release the installer without access to any owner's
Cloudflare account or corpus.

## Establish current truth first

Do not treat a branch name, local package version, or successful deploy command
as proof that a release is public or an install is current. Start every work
session with read-only checks:

```bash
git remote -v
git status --short --branch
git log --oneline --decorate -12
git fetch --prune
gh release list --limit 10
gh run list --limit 20
```

Then read these files before changing their area:

- `AGENTS.md` for repository rules and the release checklist.
- `CHANGELOG.md` for the owner-visible behavior of the current version.
- `docs/ARCHITECTURE.md` for ownership, storage, ingest, retrieval, and trust
  boundaries.
- `docs/ENGINEERING-STANDARDS.md` for comments, tests, decisions, and the
  definition of done.
- `docs/EVALUATION.md` for retrieval and answer-quality gates.
- `docs/RECOVERY.md` for disaster-recovery boundaries and field drills.
- `onboarding/06-runbook-top-ten-failures.md` for operator remedies.

Preserve a dirty working tree. Identify who owns each existing change before
editing the same file, and never discard unrelated work to make a test pass.

## The current architecture

There is one product and many isolated installs:

```text
owner's sources
      |
      | local extraction, quality checks, and resumable state
      v
shared Brain CLI
      |
      | authenticated HTTPS
      v
owner's Cloudflare Worker
      |                         |
      | durable authority       | derived semantic index
      v                         v
     D1 + FTS5  ---- outbox --> Vectorize
```

- D1 is the durable authority for documents, chunks, source lifecycle,
  migrations, keyword search, and the vector outbox.
- Vectorize is a rebuildable semantic projection. A green Worker is not proof
  that semantic search is complete, and an empty queue alone is not proof that
  an accepted asynchronous mutation is query-visible. Health and release checks
  require exact `vector_readiness`: zero pending/submitted work, a processed
  provider fence, and equal D1/Vectorize counts.
- The Worker fuses Vectorize and D1 FTS candidates and produces cited answers.
- The manifest is the only intended per-install product configuration. Source
  selections, credentials, resume state, private evaluations, and Cloudflare
  resources remain outside the shared product.
- The scoped Cloudflare token is used only for control-plane work. Routine
  retrieval, ingest, health, evaluation, drain, and reindex use the deployed
  Brain and its separately stored admin key.

The current candidate keeps the 0.1.14 current-status and message-replay
guarantees while making exact legacy projection upgrades practical for large
corpora. It replaces a rough trigger-amplified D1 change count with exact
chunk-to-vector mapping readback during accelerated bootstrap. The previous
99-row path remains the conservative active reindex path; the lifecycle-only
accelerated path requires the verified paused boundary.
The 0.1.14 line strengthened current-status retrieval so stale records and
transaction-system evidence cannot silently establish a current client
relationship. It also makes full message replay exact and fail-closed across
high-water snapshots, reconciliation, crash recovery, and target inventory
verification. Version 0.1.13 established the duplicate collapsing, durable
installed-manifest pointer, guarded recovery, and release-safety foundations.
`CHANGELOG.md` is the authoritative owner-facing list.

Four append-only migrations make the D1-to-Vectorize protocol durable:

- `0010` replaces millisecond timestamps as revision identity with a monotonic
  install-state generation. Every cleanup and failure update uses generation,
  operation, and vector identity as its compare-and-swap token.
- `0011` adds the opaque, expiring exclusive drain lease. Cron and manual drain
  cannot overlap, forget is enqueue-only, and only the matching owner can
  release a lease.
- `0012` stores asynchronous Vectorize mutation receipts on both the outbox row
  and a global projection fence. A provider watermark plus exact-generation
  `getByIds` readback must confirm the change before the row leaves the queue.
  Existing corpora start `bootstrap_required`; a durable high-water and 99-row
  cursor rebuild the projection without materializing a corpus-sized queue.
- `0013` adds durable accelerated-bootstrap batch receipts. While the verified
  write barrier is active, disjoint 1,000-row batches may be submitted through
  a bounded in-flight window. Exact-generation `getByIds` readback must confirm
  every row before its batch and outbox receipts can be cleared.

Later append-only migrations extend the product without replacing those
storage rules. `0021` adds authoritative document entity scope plus owner
uploads, approvals, period close, append-only activity, targets, preferences,
and durable request replay. `0022` adds exact-document grants, scoped sessions,
and aggregate passkey timing. Install order is fixed: 0021 must complete before
0022. Recovery preserves schema-22 grants, durable access receipts and events,
passkey telemetry, and owner passkeys, while excluding challenges and one-time
enrollment codes. It writes the source `session_generation` plus one so no old
owner or scoped cookie can survive a restore. `0023` adds temporary support
sessions, but recovery exports only support audit history and recreates every
live support authority empty. The restart-safe migration adapter is the acceptance path for interrupted
column additions; raw statement replay is not a substitute. `0024` adds
single-use receipts for destructive agent actions. Recovery recreates that
table empty and never exports a receipt. D1 Time Travel rollback also purges
the table and requires an exact zero-row readback before the paused barrier can
report success.

`brain update` deploys a paused compatibility Worker and verifies its exact
version/writer mode, waits one complete supported lease window, runs these
migrations, and keeps the barrier active while any schema-13 legacy bootstrap
finishes. It then deploys active mode and verifies that mode again. This closes
the rolling interval in which an older Worker could write without the lease.
The migration runner is restart-safe after every independently committed
statement. Paused mode is a complete corpus-write barrier: ingest, batch
ingest, source receipts/expectations, forget, reindex, manual drain, and cron
drain all stop before D1 or provider access. The accelerated batch loop is also
crash-resumable. Active mode is deployed only after the full projection receipt
is verified; health and acceptance still run afterward.

A setup interrupted after D1 commits an early migration statement can leave an
`install_state` table without its singleton or migration receipt. A rerun with
no exact manifest Worker must not infer quiescence, because a renamed Worker can
still share the D1 binding. Setup makes zero further D1 mutations and directs
the owner through `brain update <manifest>` for the verified paused-writer
cutover, followed by `brain setup <manifest>`. The migration runner resumes the
committed prefix; setup then persists the admin key and completes convergence.

For a manifest with a declared `keychain://` admin-key locator, setup and update
create the immutable execution copy in a fresh owner-only directory under the
OS temporary root. This avoids Apple File Provider changing ctime/mtime on a
new adjacent copy inside a synced manifest folder. The original manifest keeps
the same strict fingerprint, inode, ctime, and mtime revalidation. The copy
contains only manifest bytes and the non-secret Keychain locator, never the
Keychain value, and cleanup removes only the exact inode and empty directory it
created. Legacy adjacent-file credentials retain an adjacent execution copy so
their path-relative key lookup remains correct.

The normal maximum 50-document, one-chunk batch uses 53 D1 binding round trips,
but Cloudflare bills/counts its 352 SQL statements. The Worker reserves a
conservative worst-case statement cost before any write and refuses requests
above its internal 900-query budget, leaving headroom below Cloudflare's
documented 1,000-query invocation limit. The separate 100-statement value in
the store is only our internal transaction slice, not a Cloudflare platform
ceiling.

All-history Supabase message replay is source/operator migration tooling, not an
installed owner command. The `migration/` directory is intentionally absent
from the package allowlist. An authorized operator runs it from a reviewed
source checkout against a protected checkpoint. Its final readback requires
exact D1 document/family counts and `vector_readiness` before it records a
completion receipt.

Do not describe the current candidate as live or recovery-verified merely because these files
or deterministic tests exist. The exact candidate still requires its disposable
provider field gate, recovery drill evidence, six-job CI matrix, immutable
release artifact verification, and each install's private release evaluation.

The code line is not a release merely because `package.json` names a version. A
release exists only when its exact reviewed commit is tagged, all six CI jobs
pass, required live field gates have evidence, GitHub publishes one immutable
asset with the verified digest, and the public install and update pages point
to that exact asset.

## Make a product change safely

1. Write the intended behavior and explicit non-goals.
2. Locate the smallest owning module. Keep new command logic outside
   `brain.mjs` when a focused module is practical.
3. Add the narrow deterministic test first. Include failure, retry, privacy,
   and persistent-state lifecycle cases when they apply.
4. Update every surface in the contract. The table in
   `docs/ARCHITECTURE.md` lists the files that move together for common
   changes.
5. Record a material architecture decision in a new append-only ADR under
   `docs/decisions/`. Do not rewrite old rationale.
6. Run the focused tests, then the full offline suite and package checks.
7. Use synthetic fixtures. A shared test must never read an installed Brain,
   private golden set, support export, or owner manifest.
8. Run a real field gate only when mocks cannot prove the boundary and the
   account owner has approved that exact live action.

Comments should explain a security invariant, retry rule, concurrency rule,
data-loss boundary, or compatibility constraint. Do not narrate obvious code,
and do not use comments as an issue tracker.

## Verification ladder

Use the smallest relevant check while developing, but do not substitute it for
the full release gate.

| Change area | Focused checks |
|---|---|
| Owner app, installer guidance, and Settings | `npm ci --prefix frontend --ignore-scripts`, `npm --prefix frontend test`, `npm --prefix frontend run build`, then `git diff --exit-code -- worker/src/lib/app-assets.js` |
| CLI failure and issue notes | `node test/errors.test.mjs` and `node test/support-journal.test.mjs` |
| Provisioning and update | `node test/provision-guards.test.mjs` and `node test/upgrade-verify.test.mjs` |
| Credentials | `node test/admin-key-rotation.test.mjs`, `node test/google-auth-storage.test.mjs`, and `node test/mcp-rotation.test.mjs` |
| Ingest and extraction | `node test/ingest-run.test.mjs` and `node test/quality.test.mjs` |
| D1 migrations | `node test/migrations.test.mjs` |
| Recovery | `node test/verified-recovery.test.mjs` and `node test/cloudflare-recovery-adapter.test.mjs` |
| Worker data plane | `node worker/test/routes.test.mjs`, `node worker/test/store.test.mjs`, and `node worker/test/store-d1.test.mjs` |
| Evaluation | `npm run test:eval` |
| Published package privacy | `node test/package-privacy.test.mjs` |

Required offline release checks:

```bash
npm ci --ignore-scripts
npm test
npm run privacy:history
git diff --check
npm audit --offline
npm pack --dry-run --json --ignore-scripts
```

The source-only orchestrator runs those checks together with the synthetic
hiccup, Plaid, local D1 auth, passkey-protocol, package-hash, and installed CLI
gates. It writes an aggregate private receipt and keeps every live action in a
separate human checklist:

```bash
npm run field:prepare -- --expect-sha <reviewed-40-character-git-sha>
```

In a source checkout, see `docs/FIELD-PREPARE.md`. A passing receipt is offline preparation only. It
does not prove a Cloudflare account, physical passkey, Plaid Sandbox,
QuickBooks Sandbox, institution, customer corpus, or CI matrix.

Run `node --check` on every changed JavaScript module. The full GitHub matrix
must pass on Windows, macOS, and Linux with Node 22 and 24. That is six jobs.
Local macOS success does not replace Windows and Linux evidence.

There are three separate claims:

- Offline tests prove shared deterministic behavior.
- Disposable field gates prove real provider behavior without touching an
  owner install.
- An install's private release evaluation proves that install's retrieval and
  refusal behavior against its promised corpus.

Never combine those into a broader claim than the evidence supports.

`npm run privacy:history` proves the exact local candidate history has zero
finding objects. Before any new public tag or release,
`npm run privacy:history:strict` must also prove zero findings across the
server's exact public heads and tags plus the checked-out candidate. A missing
remote object is a hard stop until full history is fetched deliberately. See
`docs/RELEASE-GOVERNANCE.md`.

## Cut an immutable release

### 1. Prepare the candidate

Run `npm run privacy:history:strict` first. Do not prepare, tag, or publish a
candidate while reachable privacy or credential-shaped history remains.

Keep these versions identical:

- `package.json`
- the root version fields in `package-lock.json`
- `templates/brain.manifest.json`
- the newest heading in `CHANGELOG.md`
- both pinned release links in `README.md`
- the expectation in `test/current-version.test.mjs`

Write the changelog for the Brain owner: what changed and what they should
verify. Complete every named real-account field gate, commit only sanitized
aggregate evidence, and confirm that every executable file in the candidate is
the exact code the evidence tested.

### 2. Inspect the exact package

After the required checks above pass:

```bash
RELEASE_VERSION="$(node -p "require('./package.json').version")"
RELEASE_TMP="$(mktemp -d)"
npm pack --json --ignore-scripts --pack-destination "$RELEASE_TMP"
RELEASE_TARBALL="$RELEASE_TMP/brain-installer-$RELEASE_VERSION.tgz"
tar -tzf "$RELEASE_TARBALL"
shasum -a 256 "$RELEASE_TARBALL"
npm install --global --ignore-scripts --no-audit --no-fund \
  --prefix "$RELEASE_TMP/install" "$RELEASE_TARBALL"
"$RELEASE_TMP/install/bin/brain"
```

Inspect the complete tar listing. It must contain only the package allowlist,
with no instance files, private golden sets, baselines, support exports,
credentials, or local receipts. The installed command must print its usage.

### 3. Merge and tag the reviewed commit

Use a reviewed pull request or a fast-forward-only integration. Never force
push a release. After `main` contains the candidate:

```bash
git switch main
git pull --ff-only
git status --short --branch
git tag -a "v$RELEASE_VERSION" -m "Brain Installer $RELEASE_VERSION"
git push origin main
git push origin "v$RELEASE_VERSION"
```

Require the tag, `main`, the tested commit, and the six green CI jobs to name
the same source. If any executable code changes, rebuild the tarball and rerun
every applicable gate.

### 4. Publish and verify once

Create a draft first because a published immutable release cannot be repaired:

```bash
gh release create "v$RELEASE_VERSION" "$RELEASE_TARBALL" \
  --draft --verify-tag --title "Brain Installer $RELEASE_VERSION" \
  --generate-notes
gh release view "v$RELEASE_VERSION" \
  --json tagName,targetCommitish,isDraft,isImmutable,assets,url
```

Confirm there is exactly one asset, its name is
`brain-installer-<version>.tgz`, and its reported SHA-256 matches the local
tarball. Then publish and require GitHub to report the release immutable:

```bash
gh release edit "v$RELEASE_VERSION" --draft=false
gh release view "v$RELEASE_VERSION" \
  --json tagName,targetCommitish,isDraft,isImmutable,assets,url
```

Download the public asset independently, compare its digest again, install it
in a fresh user-owned prefix, and run the installed `brain` command. Only after
that succeeds may `financialbrain.ai/install` and `financialbrain.ai/update`
be changed to the new immutable URL. Verify both pages at desktop and mobile
widths after deployment.

## Update an existing Brain

Updating an install is different from releasing the installer. First install
the exact immutable package named on `financialbrain.ai/update`. Then use the
installed CLI, not a source checkout:

```bash
brain whatsnew
brain doctor
brain status <manifest>
brain update <manifest>
brain health <manifest>
brain status <manifest>
brain sources <manifest>
```

`brain update` obtains a D1 restore bookmark before mutation. For the D1 vector
writer protocol it deploys and verifies paused mode, waits one lease window,
applies pending migrations, deploys and verifies active mode, reconciles only
known obsolete provider secrets, runs exact-version health and the full
acceptance suite, commits version state to D1, reads it back, and only then
advances the local manifest. A failed update does not report or record the new
version as live.

After a successful update, require zero failed health checks and exact vector
readiness, not merely an empty queue. Run the install's private release evaluation for any release that
changes extraction, chunking, indexing, ranking, answer generation, source
lifecycle, or authorization. Keep the private suite and artifacts outside the
repository.

Do not infer an install's live state from Git or GitHub. A release changes no
Worker until that owner-approved update completes and is read back.

## Failure, rollback, and recovery

Prefer fixing forward. The update is idempotent, and its failure output keeps
the pre-change bookmark and safe rerun path.

```bash
brain status <manifest>
brain update <manifest>
```

Use rollback only when fixing forward is unavailable. Preview first:

```bash
brain rollback <manifest> <bookmark>
```

The confirmed restore is destructive. It discards D1 writes after the
bookmark, and it does not restore Vectorize. After reviewing the exact target:

```bash
brain rollback <manifest> <bookmark> --yes
# Worker intentionally remains paused here.
# Recreate and rebind a clean Vectorize index plus every metadata index under
# the supervised recovery procedure before continuing.
brain reindex <manifest> --yes
brain drain <manifest>
brain health <manifest>
brain test <manifest>
```

Do not return the Brain to normal use until D1, FTS, Vectorize, version health,
and the install's required evaluation agree again.

That direct reindex repairs missing/current vectors only. If the restored D1
bookmark predates Vectorize writes, provider-only IDs can remain and reindex
cannot enumerate them. Recreate and rebind the exact Vectorize index under the
reviewed recovery procedure, recreate all metadata indexes, then reindex and
require exact count/readiness before returning the Brain to use.

Rollback first deploys and verifies the same complete write barrier, waits one
old-invocation window, restores D1, then clears any restored lease/mutation
receipt and records an exact bootstrap high-water. It deliberately does not
return active mode: a clean Vectorize replacement/rebind is required because
provider-only post-bookmark ids cannot be enumerated by reindex. A bookmark from
before schema 12 also fails closed with the Worker paused; forward-migrate the
restored schema as part of the supervised recovery, then recreate/rebind a
clean Vectorize index before reindexing. Forward migration and reindex alone do
not remove provider-only vectors written after the restored bookmark.

A bookmark rollback is not disaster-recovery proof. Full recovery means an
isolated D1 export and restore, FTS recreation, a visibility-confirmed Vectorize
rebuild with exact count agreement, health, and the same private release
evaluation. Follow `docs/RECOVERY.md` and use disposable resources. Never
improvise that drill against a live target.

## Credential boundaries

The standard account-scoped Cloudflare token has exactly these permissions:

- Workers Scripts Edit
- D1 Edit
- Vectorize Edit
- Workers AI Read

Add Workers R2 Storage Edit only if the manifest really provisions R2. Scope
the token to the intended account, give it an expiry, and revoke it when the
control-plane work is finished.

The supported setup and update flows request the token in a hidden terminal
prompt. The token must not be placed in source, a manifest, an argument, shell
history, a support note, a log, or a shared message. Low-level automation must
use an approved secret-manager-backed launcher that resolves the secret only
at execution time and passes a minimal environment to the child process.

The Brain admin key is a different credential. It grants operator access to the
whole Brain and lives only in the install's declared durable store. Routine
commands resolve it at runtime. Owner and scoped-user access instead use
passkey sessions and D1 authorization. Do not copy the admin key into an MCP
configuration, release job, maintainer password manager, or Cloudflare token
store.

Repository permission grants no Cloudflare or corpus permission. A maintainer
needs a fresh, owner-approved scoped token only for a specific live operation.
There is no shared master credential and no support backdoor.

## Issue-note collection and regression tracking

Recognized command failures already create immutable, sanitized local issue
events under the current user's private Brain support directory. This is
automatic local collection, not telemetry. Version 0.1.14 has no automatic
upload and no network path in the journal module.

An event can contain the product version, command, platform, architecture, Node
major, connector class, typed failure code, timestamp, random event ID, and an
optional validated product-code fingerprint. The schema rejects content,
filenames, paths, URLs, account or document identifiers, queries, answers, raw
errors, logs, stacks, arguments, environment values, and credentials.

The owner controls review and export:

```bash
brain support
brain support --preview
brain support --export brain-support-review.jsonl
brain support --clear --yes
```

`--preview` shows the exact shareable bytes. Export includes at most the newest
200 valid events from the last 30 days and is capped at 2 MiB. Nothing is sent
automatically. Choosing a synced export destination may cause that sync service
to upload it, so obtain the owner's approval for the exact destination first.
Never ask an owner to send raw logs, a manifest, source files, a private golden
set, or a credential as a substitute.

Turn a reviewed product failure into a durable fix in this order:

1. Record only the version, platform, command, typed error code, and the exact
   shareable support event approved by the owner.
2. Reproduce the behavior with a synthetic fixture.
3. Add a test that fails for the reproduced contract violation.
4. Fix the owning layer and run its failure, retry, privacy, and lifecycle
   checks.
5. When adding an error category, update the failure classifier,
   `support-journal.mjs` schema, support tests, error-path tests, and the
   troubleshooting runbook together.
6. Describe the owner-visible outcome in `CHANGELOG.md`.

A future central submit flow must remain opt-in, preview exact bytes, and use a
separate write-only support credential. It must never reuse a Brain admin key
or Cloudflare token.

## Maintainer handoff checklist

Before another maintainer takes over, provide repository access and verify it
with a read-only clone or `gh repo view`. Do not send credentials with the
invite. Then point them to this guide and record:

- the exact branch and commit under review;
- whether the working tree is clean and which uncommitted changes belong to
  whom;
- the latest immutable release tag, asset digest, and six-job CI result;
- which live field gates are completed and which remain unverified;
- whether any public install or update page has been deployed and live-tested;
- known risks, open decisions, and the next commands in priority order; and
- every external write already made, such as a tag, release, deployment,
  permission change, token creation, or field-gate resource.

Do not copy an owner's instance state into that handoff. Instance operations
require a separate, owner-approved session and the exact local manifest.
