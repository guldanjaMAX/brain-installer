# Architecture

`brain-installer` is one shared installer that creates many isolated brains.
The product code stays the same. Each install differs through its manifest,
source selections, credentials, local resume state, and resources inside the
owner's Cloudflare account.

## Deployment model

```text
Source systems and local files
           |
           | local extraction, quality checks, credential refusal
           v
brain CLI on the owner's machine
           |
           | HTTPS with this brain's admin key
           v
Cloudflare Worker in the owner's account
      |                         |
      | durable text/metadata  | derived semantic vectors
      v                         v
     D1  ---- vector outbox -> Vectorize
      |
      +---- FTS5 keyword index
```

The installer uses a scoped Cloudflare token only for control-plane work such
as verification, provisioning, deployment, migration, and Worker secrets.
Routine use goes through the deployed Worker with the brain's own admin key.
At handoff, the control-plane token can be revoked without disabling retrieval,
health, ingest through a configured domain, evaluation, drain, or reindex.

The standard backend is D1 plus Vectorize. Legacy Supabase adapters and
migration tools remain so an existing corpus can be moved or temporarily
compared, but they are not a separate product tier and are never selected from
corpus size alone.

### Shared product versus one install

| Shared installer | Per-install instance |
|---|---|
| CLI, Worker, migrations, connectors, tests | Manifest and Cloudflare resource IDs |
| Manifest schema and public template | D1 database, Vectorize index, Worker, routes |
| Extraction, safety, retrieval, and evaluation logic | Source policy and resumable ingest state |
| Public docs and onboarding | Durable admin key and Google OAuth record |
| Blank eval template | Private golden questions, baselines, reports, receipts |

Instance material never belongs in the published package. A manifest is not a
secret, but it can still identify an owner and infrastructure, so it receives
the same packaging caution as private evaluation data.

## Code map

| Area | Primary files | Responsibility |
|---|---|---|
| CLI lifecycle | `brain.mjs`, `doctor.mjs` | Dispatch, setup, control-plane calls, command UX, health, ingest orchestration |
| Worker data plane | `worker/src/index.js` | Authenticated routes, retrieval, answer generation, admin operations, scheduled drain |
| Storage | `worker/src/lib/store.js`, `store-d1.js`, `supabase.js` | Backend selection, D1 and legacy storage behavior, vector outbox, source lifecycle |
| D1 schema | `migrations/d1/` | Append-only schema and data migrations |
| Extraction | `ingest/` | File walking, format extraction, quality checks, dates, splitting, batching, resume state |
| Google sources | `connectors/google-auth.mjs`, `google-drive.mjs`, `gmail.mjs`, `google-calendar.mjs` | OAuth storage and source-specific listing, cursor, export, and envelope logic |
| Local operations | `operations/` | Admin-key persistence and macOS Drive scheduling |
| MCP | `components/brain-mcp.mjs`, `brain-mcp-runtime.mjs` | Tool surface and runtime resolution of the current durable admin key |
| Acceptance and eval | `acceptance.mjs`, `eval/`, `report*.mjs` | Install checks, retrieval measurement, regression comparison, owner-facing reports |
| Migration | `migration/` | One-time Supabase corpus and message-session import |
| Support evidence | `support-journal.mjs` and CLI failure handling | Privacy-safe local issue classification, retention, preview, and export |
| Product contract | `manifest.schema.json`, `templates/`, `README.md`, `docs/`, `onboarding/` | Configuration shape, current capability claims, and operating instructions |

`brain.mjs` is currently large and contains several command domains. New work
should move toward focused command modules with explicit arguments and injected
dependencies. Preserve behavior with characterization tests before extracting a
live path.

## Install and upgrade lifecycle

`brain setup` is intentionally ordered:

1. Run local preflight checks.
2. Create or resume the manifest, declare durable admin-key storage, and
   prepare the exact desired key before remote changes.
3. Verify the scoped token and account, provision D1 and Vectorize, apply
   migrations, then deploy the Worker.
4. Persist and read back the admin key, set Worker secrets, and verify health.
5. Register locator-only MCP entries for supported AI tools.
6. Optionally ingest the first folder and report the vector backlog.

Deploy must happen before Worker secrets because Cloudflare attaches secrets to
an existing script. Health after deploy must observe the expected package
version, not merely any HTTP 200, because the previous Worker can remain visible
briefly during propagation.

Provisioning adopts only resources whose identity and stored install state prove
they belong to this client. Migrations are checksum-protected and append-only.
Upgrade bookmarks D1, migrates, deploys, reconciles allowed provider secrets,
waits for the new version, and records success. Rollback is explicit and does
not pretend Vectorize is transactionally restored with D1; reindex is the repair
path for a derived index.

## Ingest lifecycle

All producers converge on the same document envelope and batch write path:

```text
list or walk
  -> enforce private paths and source exclusions
  -> extract text
  -> judge format and content quality
  -> scan the complete logical document for credential-like material
  -> split oversized content into one document family
  -> send bounded authenticated batches
  -> validate every per-document receipt
  -> save accepted, skipped, refused, failed, and removal state
  -> advance a remote cursor only after the run is complete
```

Local and remote state is saved adjacent to the manifest as
`.brain-ingest-<source>.json`. Content hashes and source versions make reruns
resumable. A failure stays retryable. Drive policy changes and periodic full
sweeps compare source truth with stored families so excluded, deleted, moved,
or no-longer-accessible files can be removed safely.

The authenticated HTTP batch route preserves one receipt per input document.
For D1 it reads prior rows for unique document identities in one batch preflight,
so an unchanged 50-document safety rescan is one database round trip rather than
50 sequential reads. Changed documents still enter the normal pending-hash
write path. Each attempt owns a revision-unique marker, and its chunk deletes,
chunk writes, outbox writes, and final commit are conditional on still owning
that marker. The exact compare-and-swap and one derived statistics refresh
commit together per touched source, followed by exact readback. The refresh
derives freshness only from markers that still belong to that transaction, so
an all-stale finalizer leaves counts and `last_ingest_at` unchanged. The same
atomic rule covers ordinary one-document ingest. A final content hash by itself
is not proof because same-content revisions can carry different metadata.
Repeated identities in one request deliberately use the original sequential
path because revision order is part of their correctness contract.

Drive removal candidates from policy, source deletion, and intentional quality
skips are intersected with the current stored-family inventory and approved as
one deterministic plan. Crossing either the 100-document limit or the 10%
stored-corpus limit stops before planned deletion and cursor commit. Approval
binds to an opaque fingerprint of the exact categorized target set, so a
changed plan requires a new decision without exposing source identifiers.

### Connector status

| Source | Current path |
|---|---|
| Local folders, including an Obsidian vault | Built through `--path`; Obsidian is file ingest, not a separate connector |
| Google Drive | Built, resumable, incremental, deletion-aware, and schedulable on macOS |
| Gmail | Built with cursor safety; full real-account production validation remains a field gate |
| Google Calendar | Connector and tests exist, but `brain ingest --from calendar` is not wired as a public source yet |
| Messages | One-time Supabase message-session migration exists; no standard live refresh connector exists yet |
| Slack, Notion, Microsoft 365, QuickBooks, CRM sources | Not built; use an approved export and local ingest when suitable |

The macOS Drive scheduler installs a per-user LaunchAgent. Its definition has no
credentials. It resolves the declared durable admin key at runtime, uses Google
OAuth from its chosen store, takes an owner-only lock, and rotates owner-only
logs after the lock-holding ingest exits. Windows and Linux do not yet have an
equivalent unattended source scheduler.

## D1, FTS5, Vectorize, and the outbox

D1 is authoritative for documents, chunks, source metadata, freshness,
migration state, and operations history. FTS5 is maintained from D1 chunk rows
and provides keyword candidates.

Vectorize is a derived index. There is no transaction spanning D1 and
Vectorize, so ingest does not claim semantic completion at the moment a chunk is
written. The same D1 transaction that stores chunk state queues a vector-outbox
operation. The Worker's cron, or `brain drain`, embeds queued text with the
declared Cloudflare Workers AI model and applies vector upserts or deletes.
Failed work remains queued.

This creates a deliberate temporary state:

- keyword search can find a new chunk immediately;
- semantic search cannot find it until its outbox entry drains;
- `/health` can be green while semantic coverage is incomplete;
- `brain health`, `brain diagnose`, and backlog reporting must therefore expose
  pending and stalled vector work.

`brain reindex` rebuilds Vectorize from D1 when metadata indexes, rollbacks, or
drift make the derived index untrustworthy. It does not need the original source
files.

## Retrieval and answer flow

For a query, the Worker builds two independent candidate sets: semantic matches
from Vectorize and keyword matches from D1 FTS5. Metadata filters are applied as
early as the backend supports. Reciprocal rank fusion combines the rankings.
Optional reranking may reorder a bounded candidate set when explicitly enabled.
Scaffolding files are demoted rather than silently removed.

Retrieval first collapses multiple chunks from one document. It also collapses
same-source, same-date documents with the same canonical content hash before the
public result limit, so copied files cannot occupy several evidence slots. The
source and date remain part of the key because identical text can be a valid
record at a different time or in a different connector. The internal content
hash is removed from the response. This is retrieval protection, not physical
deduplication: source lifecycle rows remain intact until an alias-aware storage
plan can preserve update and deletion semantics.

`/api/rag/unified` returns ranked evidence. It has no universal relevance floor,
so a result list by itself is not proof that the corpus answers the question.
`/api/rag/think` is the owner-facing answer path: it generates an answer from
retrieved evidence, requires citation discipline for claims, and reports gaps
such as thin coverage, staleness, undated sources, or a single-corpus result.
The optional read-only proxy key is accepted only on retrieval routes. The full
admin key protects ingest and every administrative route.

## Local state and privacy boundaries

Durable secrets never belong in the manifest or MCP registration. The manifest
contains only a non-secret locator when Keychain is used. Standard durable
stores are macOS login Keychain, Windows DPAPI CurrentUser-protected files, and
owner-only Linux files. AI-tool registrations carry the manifest locator and
resolve the current key when the MCP process starts, so rotation does not leave
stale copied credentials.

Every shipped client request carrying `X-Admin-Key` requires HTTPS, except for
an explicit loopback test URL, and refuses redirects before sending the header.
The client also rejects a response whose final origin differs from the reviewed
request origin. This is a shared transport invariant because Node preserves
custom headers across a cross-origin redirect even though it strips the standard
`Authorization` header.

Google OAuth uses Keychain by default on macOS and a protected file under
`~/.brain/` on other supported paths. Scheduler logs and locks also live under
the private per-user `.brain` directory. These files are runtime evidence, not
repository fixtures.

Source content travels from the owner's source through their machine to their
Worker and storage in their Cloudflare account. The installer operator does not
receive a central corpus copy. Cloudflare Workers AI handles standard embedding
and answer generation inside that account. An external answer or rerank provider
is used only when the manifest explicitly selects it and its Worker secret is
allowed.

One install has one authorization boundary. Folders, source names, categories,
and metadata can narrow retrieval, but they do not create separate permissions.
Anyone holding that install's admin key can reach every corpus in it. Material
that must not share readers needs a separate install until document-level access
control exists.

## Support journal

Recognized CLI failures attempt to write one immutable event under
`~/.brain/support/events/`. An event contains only product version, platform,
architecture, Node major, command, connector class, typed error code, timestamp,
random event ID, and an optional hash derived from validated product source
location.

The journal module has no network path and does not accept raw diagnostic text.
Preview and export use the same bounded canonical bytes. Retention is best
effort and cannot replace the original command result. A future central support
path must remain opt-in, show exact payload bytes, and use a separate write-only
credential rather than the admin key or Cloudflare token.

When adding a failure mode, update the classifier, allowed journal schema,
privacy and CLI tests, and troubleshooting runbook together. Prefer a stable,
typed issue identity over matching mutable human wording.

## Verification layers

| Layer | Question answered |
|---|---|
| `brain doctor` | Can this machine run the installer and its required tools? |
| `brain verify` | Can this scoped credential reach the exact intended account and services? |
| `brain health` | Is the expected Worker version live, authenticated, and operational, including vector backlog? |
| `brain test` | Do reachability, data, retrieval, safety, and operations pass in dependency order? |
| `brain diagnose` | Is the corpus missing text, duplicated, orphaned, truncated, skewed, or out of sync with Vectorize? |
| `brain eval` | Does this install retrieve the required documents, refuse unsupported questions honestly, and avoid regression? |
| `npm test` and CI | Does shared product behavior pass offline on supported operating systems and Node versions? |
| Live field gates | Does the real connector, scale, scheduler, or account lifecycle work outside mocks? |

The eval golden set is per install. It should include answerable single-document
questions, multi-document questions, hard paraphrases, near-miss entities, and
questions the corpus genuinely cannot answer. Retrieval is scored with recall at
fixed depth and MRR, raw and deduplicated by document. Repeated runs measure
variance before a small score change is treated as real.

An optional private corpus contract supplies the independent expected-source
boundary that search cannot infer from itself. Before credential use, the
evaluator validates a stable owner-only file, its complete connector snapshots,
and its binding to the manifest client slug. During the normal read-only corpus
bracket it compares each expected logical family with the authenticated D1
family inventory. The evaluator sends cursors only in JSON POST bodies, refuses
redirected responses, and derives the source set from live documents instead of
denormalized statistics.
Results retain only aggregate counts, declared slice labels,
hashes, and typed stage codes. Private paths, source identities, document names,
versions, and content never enter shareable artifacts. This proves logical
presence and expected policy absence. Content-version and extraction equality
remain not observable until a richer read-only snapshot exists.

## Where to make common changes

| Change | Update together |
|---|---|
| Add or change a CLI command | Command implementation and help, argument tests, exit behavior, support command catalog, README and changelog |
| Add a Worker route | `worker/src/index.js`, auth boundary, route tests, client wrapper if applicable, operational docs |
| Change retrieval or ranking | Worker retrieval/store code, deterministic unit tests, install-specific eval comparison, scale evidence |
| Change D1 data | New numbered migration, store code, SQLite migration tests, rollback and reindex consequences |
| Add a format | `ingest/extract.mjs` or `formats.mjs`, quality behavior, fixture tests, supported-format docs |
| Add a connector | Connector module, OAuth scopes and storage, cursor and deletion rules, ingest dispatcher, source receipts, manifest and source matrix |
| Change manifest fields | Schema, template, setup defaults, every reader, examples, package and contract tests |
| Change credentials | Persistence modules, minimal child environments, rotation/readback tests, handoff and failure runbooks |
| Change scheduling | `operations/drive-scheduler.mjs`, launchd tests, freshness expectations, private log and lock behavior |
| Add an issue category | Support schema, typed classification, privacy tests, error-path test, troubleshooting remedy |
| Cut a release | Package and lock versions, template version, current-version test, changelog, pack inspection, six CI jobs, release tag |
