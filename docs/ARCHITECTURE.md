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
| Provider safety | `worker/src/lib/provider-sync.js`, `connectors/provider-sync.mjs`, `ingest/archive.mjs` | Provider deadlines, bounded retries, typed outcomes, cursor progress, streamed response limits, and ZIP expansion limits |
| Provider expansion | `connectors/provider-oauth.mjs`, `provider-runtime.mjs`, provider adapters, `operations/provider-scheduler.mjs` | Isolated OAuth custody, refresh rotation, normalization, exact delivery and deletion readback, opaque cursors, and macOS schedules for six sandbox-ready providers |
| Owner document upload | `worker/src/lib/owner-actions.js`, `upload-extract.js`, owner frontend modules | Owner-scoped text and binary upload, bounded extraction, private image OCR, stable payload idempotency, provenance, and lost-response recovery |
| Google sources | `connectors/google-auth.mjs`, `google-drive.mjs`, `gmail.mjs`, `google-calendar.mjs` | OAuth storage and source-specific listing, cursor, export, and envelope logic |
| Local operations | `operations/` | Admin-key persistence, Claude owner-workspace guidance, and macOS unattended scheduling for Drive, provider refresh, iMessage capture, and watched folders |
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

1. Run local preflight checks, including a signed-in Claude Code CLI for an
   owner-machine install and profile-capable pinned Wrangler 4.127.1. A deliberate `--no-connect`
   technician-machine install keeps Claude advisory on that machine.
2. Create or resume the manifest, declare durable admin-key storage, and
   prepare the exact desired key before remote changes.
3. Verify the scoped token and account, then provision D1 and Vectorize. A new
   install with no existing Worker can migrate and deploy directly. A resumed
   D1 install with an existing Worker first captures a required bookmark,
   deploys and verifies the paused compatibility Worker, waits the declared
   20-minute old-invocation window, migrates, and deploys active mode.
4. Persist and read back the admin key, set Worker secrets, and verify health.
5. Register locator-only MCP entries for supported AI tools. When Claude Code
   is connected, write an owner-only `CLAUDE.md` beside the manifest with exact
   locators and safe approved-folder rules. Preserve an unrelated existing file.
6. Optionally ingest the first folder and report the vector backlog.

Deploy must happen before Worker secrets because Cloudflare attaches secrets to
an existing script. Health after deploy must observe the expected package
version, not merely any HTTP 200, because the previous Worker can remain visible
briefly during propagation.

Provisioning adopts only resources whose identity and stored install state prove
they belong to this client. Migrations are checksum-protected, append-only, and
restart-safe after every independently committed statement. A D1 upgrade
captures a required bookmark, deploys and verifies the paused compatibility
Worker, waits the same old-invocation window, migrates, deploys active mode,
reconciles allowed provider secrets, waits for the new version, and records
success. Schema 13 changes that ordering only for an existing legacy
projection: after migration, the verified write barrier stays active while the
Worker rebuilds durable 1,000-row batches. A bounded number of disjoint provider
mutations may be accepted concurrently. Every row carries its D1 generation,
and exact `getByIds` readback must match that generation before the batch
receipt can be cleared. Only a fully verified projection permits the active
deployment. Direct `brain migrate` refuses a live D1 install that needs the writer
protocol migrations because it cannot prove that older Worker invocations are
quiescent. Rollback is explicit and does not pretend Vectorize is
transactionally restored with D1. It leaves the Worker paused until supervised
recovery recreates/rebinds a clean Vectorize index, because reindex cannot
enumerate provider-only post-bookmark ids.

Verified recovery keeps orchestration provider-neutral and places all live
Cloudflare access behind a separate disposable-only adapter. The adapter binds
reviewed manifests to exact D1, Vectorize, Worker deployment, runtime values,
and secret names before either source export or target access. Its target
execution approval also binds the immutable Worker version and a manually
reviewed empty route/custom-domain claim. A separate approval binds the exact
private release golden SHA-256 across every supervised stop and resume. D1
remains the durable authority. FTS and Vectorize are rebuilt derived state.
Recovery control files contain
fingerprints and bounded evidence only. The sole durable corpus artifact is an
owner-only authenticated ciphertext file whose independent key is resolved
from a non-secret Keychain locator. Plaintext SQL exists only for a bounded
local verification or import callback, and stale residue stops recovery. The Vectorize drain owner and
expiry are invocation-local coordination, not recoverable state. Recovery
therefore excludes `install_state` from the raw provider export, recreates its
reviewed singleton row with lease and mutation fields forced to SQL `NULL`, a
corpus-derived bootstrap status/epoch, and the exact `MAX(chunk_uid)` high-water,
then resets the derived outbox generation and bulk-bootstrap base to zero,
forces the bootstrap protocol to `NULL`, and excludes provider-specific queue
and batch receipts before hashing the remaining durable data.
The same normalized row advances `session_generation` from the source value by
exactly one, so every pre-recovery owner or scoped cookie fails without deleting
durable passkeys. After a byte-exact D1 restore, a separate paused security
stage proves the target's reviewed secret-name set, verifies the independent
version-2 bank wrapping key when the source already has it, and compare-and-swap
rewraps legacy bank references. Unreadable legacy authority becomes explicit
reauthorization state before Vectorize rebuild starts. Schema 24 destructive
agent-action receipts are live single-use authority, so recovery recreates
their table empty and proves it remains empty on both sides of bank
reconciliation. The immutable owner activity stream remains durable.
Accepted Zoom occurrence UUIDs and the
missed-webhook cursor are durable delivery debt and do survive recovery, but
only through a reviewed projection that converts `processing` to `retryable`,
clears both lease fields, and marks the interrupted attempt explicitly. Raw
Zoom queue tables are excluded from the provider export so a source Worker
identity never enters the recovery artifact.
Plaid webhook receipts, reconciliation debt, exact provider history readiness,
and revocation outcome certainty survive
through their reviewed recovery projections. Public request quota windows and
vector retry bookkeeping are live operational state, so schemas 27 and 28 are
recreated empty on the target.
Exact older migration prefixes remain inspectable by the offline verifier only.
The field recovery runner requires exact current schema 32 on both source and
restored target before it can export or invoke the current drain protocol.
Schema-31 bank-import previews and schema-32 QuickBooks callback intents are
invocation-local coordination state. Recovery recreates those tables empty
instead of copying an interrupted upload or authorization intent into the
restored Brain.

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

`ingest/outcome.mjs` is the shared source-level result contract. Only
`completed` is success-shaped. `partial`, `unavailable`, `retryable`, and
`refused` carry distinct flags, and a dry run carries no ingestion outcome.
`test/ingestion-contract.test.mjs` applies that contract across folders,
Calendar, message capture, source planning, cursor settlement, document
families, and deletion planning. It is an automated conformance gate, not a
real-source acceptance receipt. `brain load` prints the full sweep first, then
returns non-zero when any enabled source is unavailable, retryable, refused, or
partial; disabled and push-only sources remain explicit non-error skips.
The iMessage, WhatsApp, and iPhone-backup command adapters report submitted,
accepted, and refused conversation counts separately. A refused conversation
therefore makes the sweep partial instead of being counted as present. Their
dry runs count the conversation documents they would submit while sending no
request and writing no resume state. An explicit `--limit` is also partial,
whether or not the current source had more records beyond the bound. Refusal
receipts keep a redacted reason for audit without storing the refused content.

Local and remote state is saved adjacent to the manifest as
`.brain-ingest-<source>.json`. Content hashes and source versions make reruns
resumable. Local resume identities are checked against the exact D1 source
families before an unchanged file is trusted. A local folder is inventoried
again immediately before any removal; a changed generation aborts the run and
deletes nothing. An empty first source is refused, while a previously loaded
source can complete only after its reviewed removals are read back as an exact
empty D1 family. Source namespaces are unique across provider and local inputs.
A failure stays retryable. Drive requires reviewed
`root_folder_ids`, then revalidates only those subtrees on every run. Direct
parent queries include Shared Drive support, pagination must make progress, and
shortcuts never expand authority. Visible trash and visible moves out of scope
are removal evidence. Permission loss and hard deletion are indistinguishable
at 403 or 404, so the existing family is preserved and completion is withheld.

Local mbox files are the bounded exception to whole-file extraction. The
approved no-follow descriptor is streamed through a full-file SHA-256 for
resume identity, while only complete messages ending inside the declared scan
window reach the shared email parser. The splitter bounds each message, resumes
at the next From_ delimiter after an oversized one, and reports scan or message
truncation as incomplete. It never accepts a partial message at the window edge.

The authenticated HTTP batch route preserves one receipt per input document.
For D1 it reads prior rows for unique document identities in one batch preflight,
so an unchanged 50-document safety rescan is one database round trip rather than
50 sequential reads. Each changed attempt owns a revision-unique pending marker.
When one document's complete stage fits our conservative 100-statement
transaction slice, its document row, old-vector queue, chunk replacement, and
new outbox rows commit in one
document-isolated transaction. Documents are deliberately not combined, so one
bad row cannot roll back a neighbor. A larger document retains the resumable
multi-call stage, slices derived writes to the same internal bound, and
keeps its pending-marker recovery path.

Binding round trips and paid D1 queries are different units. The normal maximum
50-document, one-chunk message request uses 53 binding round trips but submits
352 SQL statements. Before its first D1 read, the Worker reserves a deliberately
pessimistic statement cost for every eligible document and refuses a request
above 900 statements, leaving margin below Cloudflare's 1,000-query invocation
ceiling. A byte-valid request can therefore still receive a pre-write 413 with
guidance to send fewer or smaller documents; it never discovers that ceiling
after creating partial pending revisions.

Every chunk delete, chunk write, outbox write, and final commit is conditional
on still owning the exact marker. The compare-and-swap and one derived
statistics refresh commit together per touched source, followed by exact
readback. The refresh derives freshness only from markers that still belong to
that transaction, so an all-stale finalizer leaves counts and `last_ingest_at`
unchanged. The same atomic rule covers ordinary one-document ingest. A final
content hash by itself is not proof because same-content revisions can carry
different metadata. Repeated identities in one request deliberately use the
original sequential path because revision order is part of their correctness
contract.

Drive and watched-folder removal candidates from policy, source deletion, and
intentional quality skips are intersected with the current authenticated
stored-family inventory and approved as one deterministic plan. Stored-family
inventory derives declared `family_of` relationships as well as structural
`part_of` families, even when a message row belongs to an upload file's family.
After a deletion receipt, the client reads that inventory again and refuses to
record completion while any exact target remains. Crossing either the
100-document limit or the 10% stored-corpus limit stops before planned deletion
and cursor or source-state completion. Approval binds to an opaque fingerprint
of the exact categorized target set, so a changed plan requires a new decision
without exposing source identifiers.

Drive also separates an active unreadable file from a source deletion. Typed
connector skips become removal candidates only when a trusted prior canonical
Drive version differs from the current one; a credential refusal is removed
regardless of version. A missing, legacy, unchanged, or unknown receipt keeps
the authenticated D1 family under a durable `drive_retained_existing` marker.
That marker removes the ordinary `done` fast path, survives rooted revalidation runs,
and keeps source health incomplete until a replacement is fully accepted or
an exact post-forget inventory proves the family absent.

### Connector status

| Source | Current path |
|---|---|
| Local folders, including an Obsidian vault | Built through `--path`; Obsidian is file ingest, not a separate connector |
| Google Drive | Built, root-bound, resumable, conservatively deletion-aware, and schedulable on macOS; live root and Shared Drive acceptance remains open |
| Gmail | Built with cursor safety; full real-account production validation remains a field gate |
| Google Calendar | Built and wired through `brain ingest --from calendar`; row and receipt namespaces match, and event failure, refusal, or pending cancellation cleanup withholds the Google sync token; real-account validation remains a field gate |
| Local watched folder | Built through the ordinary resumable folder ingest path and schedulable on macOS; multi-cycle field proof remains open |
| iMessage | Built for incremental local capture on macOS; real-user database and long-lived scheduler proof remain field gates |
| WhatsApp | Safe per-chat export ingest is built. Unofficial paired-device live capture is opt-in, violates WhatsApp's Terms of Service, and is not real-account proven. Meta's official WhatsApp Business Platform connector is not built. |
| SMS and Google Voice exports | Built as sessionized file imports; real export samples remain acceptance gates |
| iPhone backup | Built against a synthetic unencrypted backup; an Apple-written backup remains a field gate |
| Zoom | Built as a durable transcript delivery queue with bounded missed-webhook reconciliation; a paid real-account meeting remains a field gate |
| Bank exports and hosted feed | Built into the shared financial ledger; real-statement and real-feed reconciliation remain field gates |
| OCR for scanned PDFs | Built, optional, and provenance-marked; local synthetic scans pass and private real scans remain a field gate |
| QuickBooks Online | Sandbox-ready, company-fingerprint-bound read snapshots with serialized refresh and revoke-before-disconnect; Intuit's consent is broader than runtime reads, the HTTPS callback core is implemented but not field-activated, and query deletion truth plus live sandbox proof remain open |
| Slack and Notion | Sandbox-ready read-only snapshots with explicit incomplete deletion authority; no real workspace has crossed either boundary |
| Microsoft 365 | Sandbox-ready Outlook delta plus OneDrive and SharePoint body extraction; real tenant consent and lifecycle proof remain open |
| Dropbox | Sandbox-ready cursor sync and bounded body extraction; real account lifecycle proof remains open |
| HubSpot | Sandbox-ready contacts, companies, deals, and archived tombstones; permanent-deletion truth and live portal proof remain open |
| LinkedIn | Built as a bounded Download Your Data ZIP path only; live LinkedIn is absent |
| Browser owner upload | Built for text, PDF text layers, Office, email, PNG, and JPEG with extraction provenance and exact retry recovery; scanned PDF page OCR is absent |

The macOS Drive scheduler installs a per-user LaunchAgent. Its definition has no
credentials. It resolves the declared durable admin key at runtime, uses Google
OAuth from its chosen store, takes an owner-only lock, and rotates owner-only
logs after the lock-holding ingest exits. The iMessage capture lane and the
watched local folder lane are the same machinery with a different connector
spec, so all three share that hardening rather than each re-deriving it.
Windows and Linux do not yet have an equivalent unattended source scheduler.

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

`queued_at` measures backlog age and may legitimately repeat within one
millisecond. It is not a revision identity. D1 assigns every enqueue a strictly
increasing `generation` from the durable install-state clock. Drain cleanup and
failure bookkeeping compare that generation, operation, and vector identity,
so a drain holding an older snapshot cannot clear or mutate a newly requeued
row even when both rows share the same timestamp.

Vectorize itself has no conditional write, so generation-CAS alone cannot make
two simultaneous drains safe: an older invocation could land last after a newer
one. Every manual or scheduled drain therefore claims one opaque, expiring D1
lease for its complete bounded invocation. A second drain receives a busy
response without reading or exposing the owner token and performs no embedding,
Vectorize write, or outbox acknowledgement. Normal completion and exceptions
release only the matching owner; an abruptly terminated Worker recovers when
the bounded lease expires.

The source-forget path is enqueue-only: it deletes authoritative D1 content and
queues vector deletes, but never writes Vectorize directly. This makes the
leased drain the only Vectorize writer. Each drain also maintains a conservative
900-query internal budget, including lease operations, worst-case hashed-ID
remaps, cleanup, failure bookkeeping, and final depth. `maxBatches` is a latency
preference, not permission to cross that budget; a drain stops cleanly with
remaining work queued and always reserves its lease-release query.

Vectorize V2 accepts a mutation before that mutation is query-visible. A drain
therefore has two durable phases. First it records the provider mutation ID on
the exact outbox generation and on the singleton projection fence, leaving the
row queued. A later leased drain waits for the provider's processed watermark,
then uses `getByIds` to prove the exact generation for an upsert or exact absence
for a delete. Only that confirmation deletes the outbox row. A processed receipt
whose vector is missing or stale is requeued with an explicit failure instead
of being counted as embedded.

Readiness is similarly exact: D1 chunk count, outbox depth, submitted depth,
the provider watermark, and Vectorize count must all agree. The documents
inventory exposes this as `vector_readiness`; `brain health`, `brain test`, the
message-migration completion receipt, and every semantic answer fail or mark
degradation until it is true. This prevents a non-empty but partially updated
Vectorize result page from looking like complete semantic retrieval.

This creates a deliberate temporary state:

- keyword search can find a new chunk immediately;
- semantic search cannot find it until its outbox entry is visibility-confirmed;
- the public `/health` route remains a reach/version probe, not a corpus claim;
- `brain health`, `brain test`, message replay, retrieval responses, and backlog
  reporting require or disclose exact projection readiness.

`brain reindex` rebuilds missing/current Vectorize entries from D1 when metadata
indexes or drift make the derived index untrustworthy. It cannot remove unknown
provider-only ids, so rollback/excess recovery first requires a clean supervised
index replacement and rebind. Reindex does not need the original source files.
Ordinary whole-corpus reindex records one durable epoch and advances in
conservative 99-chunk pages while the Brain remains active. A lifecycle upgrade
has a stronger write barrier and a different scale profile: schema 13 tags
durable 1,000-row batches, permits only disjoint batches in its bounded
in-flight window, and confirms the exact generation of every vector before
advancing the verified receipt. Re-running either path resumes its D1 cursor
and provider receipts instead of resetting completed pages.

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
admin key protects ingest and operator administration. The app uses passkey
sessions plus the companion app header, and D1 applies exact owned-entity or
exact-document scope before returning evidence.

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

One install has one operator boundary and multiple app principals. Anyone
holding the install's admin key has whole-install authority. Owner passkeys can
reach the owned workspace. Scoped sessions can reach only exact documents named
by active grants, and new documents are owner-only until granted. Folder names,
source names, categories, and ordinary metadata can narrow retrieval but never
create permission. If D1 grant or entity authority is unavailable, retrieval
fails closed rather than reporting an empty corpus.

Passkey sessions are signed but remain bound to the exact D1 credential that
earned them through a non-disclosing HMAC reference. The Worker resolves that
reference and its grant class on every request. Deleting a passkey immediately
invalidates its sessions, while the global D1 generation remains the separate
sign-out-everywhere control. Challenges, enrollment codes, and OAuth
authorization codes choose their only winner through conditional D1 mutation.

Agent authority is separate from human grants. MCP OAuth stores one exact named
profile: librarian, structured-contributor, technician, or break-glass. The
default is librarian and legacy additive read/write scopes become librarian.
Structured contributors may add only contract-checked curated lessons;
technicians may read whole-corpus diagnostics. Break-glass may create a bounded
deletion preview receipt but has no deletion execution capability.

Migration 0024 stores only the hash of each short-lived receipt plus its exact
requesting principal, owner entity, sorted document ids, count, current content
digest, and expiry. Execution is a separate owner-only route. It requires a new
WebAuthn assertion over a challenge bound to that receipt and digest, claims one
execution lease, performs D1-first deletion, verifies absence, and appends one
human activity event. Changed, expired, replayed with different input, partial,
or unavailable state fails before a broader delete. An exact retry after lost
response returns the stored result without a second mutation. These receipts
are live single-use authority state and must not be restored as durable backup
data.

## Support journal

Recognized CLI failures attempt to write one immutable event under
`~/.brain/support/events/`. An event contains only product version, platform,
architecture, Node major, command, connector class, typed error code, timestamp,
random event ID, and an optional hash derived from validated product source
location.

The journal module has no network path and does not accept raw diagnostic text.
Preview and export use the same bounded canonical bytes. Retention is best
effort and cannot replace the original command result. `support-recovery.mjs`
maps every stable code to a human title, protection statement, retry state, next
steps, and technician boundary. `brain support --explain` renders it without
reading the journal; its JSON form lets a local assistant follow the same
reviewed contract. A future central support path must remain opt-in, show exact
payload bytes, and use a separate write-only credential rather than the admin
key or Cloudflare token.

When adding a failure mode, update the classifier, allowed journal schema,
recovery catalog, privacy and CLI tests, hiccup rehearsal when applicable, and
troubleshooting runbook together. Prefer a stable, typed issue identity over
matching mutable human wording.

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

The release-status path follows the same evidence boundary. An authenticated
owner asks their own Worker for `/api/app/update-status`. The Worker makes an
empty, redirect-refusing GET to the fixed public Financial Brain manifest,
validates its bounded schema and immutable release receipt, and compares that
release with `BRAIN_VERSION`. The website receives no client identity, installed
version, manifest, source inventory, or corpus data. Missing local version truth
or untrusted remote truth is `unavailable`; neither can become a healthy
up-to-date answer. The route reports and links only. The existing restart-safe
`brain update` command remains the mutation boundary.

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
| Add a format | `ingest/extract.mjs` or `formats.mjs`, shared archive limits where applicable, quality behavior, fixture tests, supported-format docs |
| Add a connector | Connector module, the deployable `worker/src/lib/provider-sync.js` contract, OAuth scopes and storage, cursor and deletion rules, ingest dispatcher, source receipts, manifest and source matrix |
| Change manifest fields | Schema, template, setup defaults, every reader, examples, package and contract tests |
| Change credentials | Persistence modules, minimal child environments, rotation/readback tests, handoff and failure runbooks |
| Change scheduling | `operations/drive-scheduler.mjs` and its connector specs (`imessage-scheduler.mjs`, `folder-scheduler.mjs`), launchd tests, freshness expectations, private log and lock behavior |
| Add an issue category | Support schema, typed classification, privacy tests, error-path test, troubleshooting remedy |
| Cut a release | Package and lock versions, template version, current-version test, changelog, pack inspection, six CI jobs, release tag |
