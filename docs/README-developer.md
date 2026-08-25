# brain-installer

Provisions a retrieval brain into a **client's own Cloudflare account**. Text and
keyword search live in D1, vectors live in Vectorize, and the Worker fuses them.
Nothing runs on our infrastructure, and nothing but a scoped token is held during
the engagement.

**Status: 0.1.11.** Provisioning, retrieval, resumable folder ingest, deletion,
upgrade rollback, and `brain setup` are verified end to end against real
Cloudflare on macOS. Google Drive OAuth and a bounded real-account ingest have
also been verified. The complete Drive baseline is the remaining production
field gate for this release. Gmail uses the same tested cursor and storage
pipeline but has not completed a real-account production run. The full suite and
packed CLI pass on Windows in CI, but no real-account Windows install has been
completed. See "What is not built" before promising anything to anyone.

---

## Requirements

- Node 22 or newer (uses `node:sqlite` for the migration tests)
- A Cloudflare account **on the Workers Paid plan**, 5 USD a month minimum.
  Vectorize has a Free allowance, but its vector capacity, D1 daily-write limit,
  and Worker CPU limit are prototype-scale. Paid is this product's supported
  production baseline.
- A Cloudflare API token created in the client's own account with: Workers
  Scripts Edit, D1 Edit, Vectorize Edit and Workers AI Read. It drives verify,
  provisioning, migrations, deploy and secrets. Add Workers R2 Storage Edit only
  when the manifest actually sets an R2 bucket.

Vectorize Edit was verified end to end on 2026-08-23: an account-scoped token
created the index and all six metadata indexes through the API. `wrangler login`
remains a compatibility fallback for an older token, not an install requirement.

---

## Install

```bash
node brain.mjs doctor                        # check this machine first
node brain.mjs setup                         # hidden token prompt, then one-command setup
```

`setup` runs everything below in the only order that works, generates the admin
key, and registers the brain with Claude Code and Codex. The steps are also
available individually:

```bash
cp templates/brain.manifest.json ./acme.manifest.json   # then edit it
export CLOUDFLARE_API_TOKEN='...'            # automation only; interactive setup prompts securely

node brain.mjs verify     ./acme.manifest.json   # token, account, every service
node brain.mjs provision  ./acme.manifest.json   # D1 + Vectorize, writes IDs back
node brain.mjs migrate    ./acme.manifest.json   # schema
node brain.mjs deploy     ./acme.manifest.json   # worker, bindings, drain cron

# AFTER deploy, not before: a secret is set ON a worker script, so the script
# has to exist. Deploying without secrets is safe, because the deploy carries
# keep_bindings and later deploys preserve whatever is set here.
#
# `brain setup` generates the admin key itself. `brain secrets` is the one
# durable rotation path for both setup and manual use: after read-only account
# resolution, it updates and exactly verifies either operations.admin_key_secret's
# macOS Keychain item or .brain-admin-key, then applies that desired value to the
# Worker. Standard setup declares a deterministic Keychain locator automatically
# on macOS unless an existing legacy adjacent key must be preserved. On Windows
# the adjacent file contains DPAPI CurrentUser ciphertext, not the plaintext key,
# and the current-user ACL must succeed before that replacement is committed.
# Existing Windows plaintext key files remain readable until the next rotation.
# Setup, secrets, and upgrade list Worker secret names and remove only the known
# Supabase or Anthropic names disallowed by the manifest. Removal is read back;
# every unrecognized secret name is preserved.
# macOS/Linux:   export ADMIN_KEY="$(openssl rand -hex 24)"
# PowerShell:    $env:ADMIN_KEY = -join ((1..48) | %% { '{0:x}' -f (Get-Random -Max 16) })
node brain.mjs secrets    ./acme.manifest.json
# If the remote write failed, rerun the same command with no ADMIN_KEY export.
# The verified durable value is reused until the Worker converges.

node brain.mjs health     ./acme.manifest.json   # prove it, including vector backlog

node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --dry-run
node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --source clientdocs

node brain.mjs test       ./acme.manifest.json   # full acceptance suite
```

The supported beginner update is `brain update [manifest]`. It verifies the
account, requires a pre-change D1 bookmark, migrates, deploys, reconciles
allowed Worker secrets, requires exact-version health plus the full acceptance
suite, commits and reads back D1 version state, then atomically commits and
reads back the local manifest version. The older `brain upgrade` command uses
the same engine and cannot bypass those gates. Neither path restores D1
automatically because that would discard writes made after the bookmark.

Always `--dry-run` first. It walks, extracts and judges every file without
sending anything, and prints what would be skipped and why. On a real corpus
that list is the useful part: it is where you find out that 12,000 PDFs are not
supported yet, before rather than after.

`verify`, `provision` and `migrate` are all safe to re-run. Provision adopts
existing resources rather than duplicating them, and **refuses** to adopt a
Vectorize index with the wrong dimensions or metric rather than silently writing
vectors that would be rejected or mis-ranked.

Run `node brain.mjs` with no arguments for the full command list.

---

## Two things about how this stores data

**There is no relevance floor.** Hybrid search always returns the
least-irrelevant documents, however far away they are. A query on a topic the
brain holds nothing about still returns rows. `/api/rag/think` is the only guard,
and it holds. Never show raw `/api/rag/unified` output as proof the brain "found
something".

**A chunk is keyword-searchable before it is semantically searchable.** There is
no transaction across D1 and Vectorize, so ingest writes the text and queues the
vector; a cron drains it every five minutes. Until it drains, both systems are
up and every probe passes while semantic search answers from a subset. This is
the most likely failure this design has and the least visible.

```bash
node brain.mjs health <manifest>                     # reads the backlog
curl -X POST "$BRAIN/api/admin/brain/drain" -H "X-Admin-Key: $ADMIN_KEY"
```

An oldest-queued timestamp over 30 minutes means the cron is not running.

---

## Loading material

`brain ingest` walks a folder, extracts text, and sends it in batches.

**Resumable by design.** Progress is keyed by content hash and saved after every
batch, so re-running the same command continues an interrupted load rather than
restarting it. That is the normal way a large import finishes, not a recovery
procedure. A file whose contents have not changed is never re-sent.

**Nothing is skipped silently.** Every file that does not make it in is recorded
with a reason, grouped at the end of the run and kept in the state file. A brain
that quietly omits 12,000 documents is confidently ignorant of them, which is
the exact failure this product exists to avoid.

**Formats today:** `.pdf .docx .xlsx .xlsm .xls .pptx .eml .csv .tsv .json .txt
.md .markdown .text .log .rst .adoc .html .htm .xhtml .xml`

Four dependencies carry the binary formats: `unpdf`, `fflate`, `@e965/xlsx` and
`postal-mime`. 11 MB total, pure JavaScript, no node-gyp, no postinstall scripts,
zero advisories. That matters because this installs on the client's own machine
during a live session, and a native build failing on their Windows box is not a
problem you want to debug in front of them. Install with `npm ci --ignore-scripts`.

There is deliberately **no optional dependency tier**. An optional extractor
fails *silently correct*: the run reports 61,000 files ingested and every
contract is missing because a flag nobody set was not passed.

**Scanned PDFs are detected and refused, not indexed empty.** A scan has no text
layer, so every extractor "succeeds" on one and returns nothing. Indexed as-is,
the brain holds a document it can say nothing about while counting it in the
corpus total. Measured on a random sample of 70 PDFs from a real 4,458-file
corpus: 79% had a usable text layer, 7% were thin (under 100 characters per
page, flagged and indexed anyway), and 14% had zero text and are refused with a
message saying they need OCR. **OCR is not in v1** — that is a decision, not an
omission: every pure-JS OCR option drags in the native dependency the rest of
this design exists to avoid.

CSV and TSV are rendered row-wise as `Header: value` rather than as a bare grid,
because `15234.11` on its own is unretrievable while `Balance: 15234.11` answers
a question about a balance.

**`safety.private_path_prefixes` is enforced on local-folder and Google Drive
ingest**, per path segment. Drive also enforces `corpora.google_drive` exact
file-id, path-prefix and filename-part exclusions before downloading content.
An excluded document already present in the brain is removed rather than left
stranded. Gmail has no folder path and does not use these rules.

Flags: `--dry-run`, `--source <name>`, `--limit <n>`, `--reset`, and the
exact-plan acknowledgement `--approve-removals <fingerprint>` when a Drive
cleanup exceeds its routine safety limits.

---

## Using it: Claude Code and Codex

The brain has no web interface, deliberately. It is used through the tools people
already work in, over MCP.

```bash
node brain.mjs mcp-config ./acme.manifest.json
```

The generated registration carries only the URL, display name, executable path,
and absolute manifest locator. The MCP process reads the current admin key from
the manifest's validated durable Keychain or protected-file backend at runtime.
`brain setup` reconciles installer-owned Claude Code and Codex registrations and
accepts them only after an exact local readback. It never relies on a name-only
listing or prints a stored legacy credential. Claude Desktop remains a manual
config update; replace its entry with the locator-only JSON from `mcp-config`
and restart it after a rotation.

---

## Remote sources: Google Drive and Gmail

```bash
node brain.mjs connect google --scopes drive,gmail
node brain.mjs ingest ./acme.manifest.json --from drive --dry-run
node brain.mjs ingest ./acme.manifest.json --from drive
node brain.mjs ingest ./acme.manifest.json --from gmail
```

**The client registers their own Google OAuth client, and we never hold it.**
Not only a custody preference: every Drive and Gmail read scope is *restricted*,
so one vendor-owned OAuth client serving many customers would require Google
verification plus a paid annual CASA security assessment. `brain connect google`
prints the full console walkthrough when `GOOGLE_CLIENT_ID` is unset. The refresh
token is stored in the local macOS login Keychain by default and never
transmitted. The Keychain item is deliberately identifiable as service
`brain-installer.google-oauth`, account `local-google-connection`. Windows uses
an atomically replaced, read-back-verified file at
`~/.brain/google-tokens.json`, encrypted for the current Windows user with
DPAPI. A legacy Windows plaintext file is migrated on its next successful read;
the prior credential is retained or restored if encryption cannot be verified.
Before that migration, `brain doctor` identifies the legacy plaintext state as
pending migration instead of claiming the file is already DPAPI encrypted.
Linux uses the same path as an owner-only mode-0600 file, and macOS can
explicitly select that fallback with `BRAIN_GOOGLE_TOKEN_STORE=file`. A legacy
macOS token file is deleted only after the full credential record has been
written to Keychain and read back exactly. Browser, Keychain, Expect, ACL, and
DPAPI helper processes receive a small allowlisted environment rather than the
Terminal's ambient credentials.

Choose OAuth client type **Desktop app**. Desktop clients accept the local
loopback callback automatically. Google Cloud does not provide, or require, a
field for manually adding `http://127.0.0.1:47811` as an authorised redirect
URI. The connector sends that callback during sign-in and binds its temporary
server to loopback only.

**On a personal gmail.com account the consent screen must be PUBLISHED.** An app
left in "Testing" is issued refresh tokens that expire after **seven days**, and
the failure arrives a week later as an unattended sync that stopped working. A
Google Workspace account should use "Internal" instead and avoids this entirely.

**The second run is incremental.** Drive uses the changes feed, Gmail uses
`historyId`, both saved in the same state file as the content hashes. That makes
a re-sync proportional to what changed rather than to the corpus.

**Drive deletions are applied.** When a file is deleted or trashed in Drive, the
next incremental sync removes it from the brain, chunks and vectors both. The
sync first intersects policy, source-deletion, and intentional-skip candidates
with the authenticated stored-family inventory, deduplicates them, and checks
one aggregate plan. More than 100 removals or more than 10% of the stored Drive
corpus stops before any planned deletion or cursor advancement. The refusal
shows category counts and an opaque SHA-256 fingerprint, never source IDs. Only
the exact `--approve-removals <fingerprint>` value can authorize that exact
plan. A deletion that cannot be applied is kept in the state file and retried
through the same aggregate gate rather than lost. **Gmail does not report
deletions**, so a deleted message stays until the source is re-ingested with
`--reset`.

Oversized Drive documents are reconciled as a family. A revision that changes
from one document to several parts, changes its part count, or becomes small
again removes only the obsolete representation after every replacement part is
accepted. A document-level failure leaves the Drive cursor unadvanced so the
same change is retried instead of being acknowledged and lost.

A Google Doc is exported as text, a Sheet as CSV, and a Google Form not at all.

`modifiedTime` is deliberately **not** used as a document date. A sync or a
permission change rewrites it, and storing it once made 80% of a corpus look
like it was written this year, silently disabling staleness reporting. Drive's
`createdTime` is the fallback, and a date in the filename beats both.

### Unattended Drive refresh on macOS

`operations.ingest_cron` is the standard source of truth for the Drive refresh
schedule. Use the public `brain schedule` command for install, status and
remove:

```bash
node brain.mjs schedule ./acme.manifest.json --install
node brain.mjs schedule ./acme.manifest.json --status
node brain.mjs schedule ./acme.manifest.json --remove
```

The public install command writes a per-user LaunchAgent under
`~/Library/LaunchAgents` and sets the matching Drive freshness expectation on
the Worker. Calling `operations/drive-scheduler.mjs` directly is an internal
operation and neither sets nor clears that remote expectation. A failed remote
expectation write can leave the local LaunchAgent installed; re-running the
public install safely completes both halves. The LaunchAgent runs
`brain ingest <manifest> --from drive`, uses macOS's native per-client advisory
lock to prevent two scheduler-launched syncs from overlapping, and writes
separate stdout and stderr logs under `~/.brain/logs`. Manual `brain ingest`
runs do not participate in this lock. Never start a manual run while the
scheduler is active, or kickstart the scheduler while a manual run is active.
Remove preserves the logs as an audit trail.
LaunchAgent calendar times use the Mac's local timezone; status reports a
mismatch with `client.timezone` instead of silently presenting the wrong
schedule. Cron fields are numeric; month and weekday names are not accepted
today.

`RunAtLoad` is deliberately false. A calendar firing missed while this Mac is
asleep is coalesced by launchd and runs after wake. A firing missed while the
Mac is powered off or the user is logged out is not caught up, so choose a
schedule that overlaps the machine's normal logged-in hours.

The plist contains paths, schedule data and a non-secret configuration hash
only. Google credentials continue to come from the normal token store. Standard
macOS setup declares a deterministic, non-secret Keychain locator for the brain
admin key. A legacy adjacent `.brain-admin-key` is preserved rather than moved
silently. A direct manual run can use `ADMIN_KEY`, but LaunchAgents do not
inherit Terminal exports:

```json
"operations": {
  "ingest_cron": "0 9 * * *",
  "admin_key_secret": "keychain://acme-brain-admin/owner",
  "google_token_store": "auto"
}
```

Only the service and account identifiers are stored. The scheduler reads the
value at run time and places it only in the ingest child process. The installed
configuration hash binds that Keychain locator and `brain.domain`; changing
either in the manifest stops before Keychain access until the scheduler is
reinstalled. The child receives a minimal allowlisted environment, so unrelated
desktop credentials and all Cloudflare deployment credentials are absent.

`google_token_store` persists the connection's storage choice because launchd
does not inherit `BRAIN_GOOGLE_TOKEN_STORE=file` from the Terminal that ran
OAuth. Use `auto` for the normal macOS Keychain default, or `file` only when that
fallback was chosen deliberately. Status compares the installed plist with the
current manifest and code paths, reports definition drift, and surfaces
launchd's run count and last exit code. Windows and Linux schedulers are not
built yet and fail with a platform-specific explanation rather than pretending
the manifest schedule took effect.

Scheduler stdout and stderr remain private mode `0600`. At install, after each
lock-owning ingest child exits, and at removal, each stream is cut back to a
5 MiB tail with two exact retained history files. A lock-contention skip does
not rotate another writer's logs. A currently running noisy or hung process can
exceed that cap until it exits, so stale-run monitoring still matters. Rotation
refuses links, hard links, foreign-owned files, and paths outside the per-user
`.brain` runtime.

### Legacy curated collections during migration

`operations/curated-dual-sync.mjs` is the internal rollback-compatible path for
a small Markdown collection that already has a live legacy ingest target. It is
not part of a fresh install. A private mode-0600 sidecar plan names the exact
expected files, their authoritative, superseded or plain role, their existing
legacy identities, both target manifests, each target's fixed backend contract,
the private coverage-ledger destination, and an optional unattended scheduler
slug, cron, and timezone. The plan and ledger are ignored by Git and never
belong in the package. `legacy_target.backend` must be
`legacy_notes_supabase`; `cloudflare_target.backend` must be `cloudflare_d1`.

The operation has three explicit modes. `--dry-run` reads no credential and
makes no request. `--audit` reads the Cloudflare Drive-family inventory but
writes no document. `--sync` builds every transformed envelope once and sends
the same title, content and metadata independently to the existing endpoint and
to the Cloudflare identity `curated:brain:<legacy source type>:<legacy source
id>`. The legacy write stays in place until retrieval evaluation approves a
cutover.

Enumeration is the first gate. A missing root, an unreadable directory, zero
Markdown files, a count change, an unexpected file, a missing planned file or a
role-count change stops before Keychain access and before either network target.
This matters for unattended macOS jobs because a privacy-denied cloud mount can
look like an empty successful walk. Every final title, metadata value and content
body then passes the same confirmed-credential scanner as Worker ingest. The
entire corpus is rejected as one bounded aggregate if any transformed envelope
fails. Finally, every source is reopened through a no-follow descriptor and its
raw SHA-256 is compared with the first pass. All of these checks finish before
an admin key can be read or a request can be made.

Each target manifest is read once through a stable no-follow descriptor before
Keychain access. The same inspected object supplies the HTTPS origin, backend,
and durable-key locator used by the request path, so a second path read cannot
redirect a credential. HTTPS origins are normalized,
legacy and Cloudflare must use distinct origins and backends, and every
authenticated fetch uses manual redirect handling. A redirect is a target
failure, never an invitation to forward a key. Cloudflare POST receipts must
echo the exact deterministic document identity, then the operation reads the
curated source-family inventory back from the same origin and confirms every
identity. The legacy endpoint has no equivalent exact identity readback, so its
bounded document receipt remains the strongest available proof. After a valid
preflight, failure of one target cannot suppress the other. The command exits
unsuccessfully unless every target receipt is complete, so rerunning is the
recovery path.

The atomically replaced owner-only ledger contains salted logical fingerprints,
content SHA-256 values, canonical target-neutral envelope SHA-256 values, roles,
bounded target receipt states and aggregate raw Drive history findings. The
corpus fingerprint includes the envelope hash, so a title-only or metadata-only
change cannot hide behind unchanged content. The ledger contains no filenames,
paths, source IDs, URLs, document content or credentials. Before replacement,
an existing ledger must parse as a supported schema. The ledger path must not
alias the plan, a corpus source, either target manifest, an adjacent admin-key
sidecar, or the raw Drive state file, including through a real-path or hard-link
collision.

Raw Drive comparison is explicitly historical evidence, not live deletion
proof. A historical checksum match means the local raw MD5 equals the checksum
recorded in the resume state and a family with that historical identity is
currently present. A driveVersion value that is merely a file size, or has no
checksum, is reported as historical unverified presence. A different MD5 is a
historical mismatch. Every ledger sets `raw_drive_evidence.deletion_eligible`
to `false`. Deletion remains forbidden until a server endpoint can bind the
currently stored family to a specific revision and return a content hash for
that revision.

Each Markdown revision is opened with the operating system's no-follow flag,
read from that descriptor, and checked with descriptor metadata before and
after the read. The path must still name the same regular, current-user-owned
file with the same device, inode, size and source modification time. File
Provider change time is not revision identity because hydration can update it
during a read without changing source bytes. The collection is enumerated again
after all reads. A cloud-sync replacement or an inventory change therefore
stops the run before either target is contacted.

`operations/curated-sync-scheduler.mjs` supplies the unattended execution rails
for a reviewed plan. Its LaunchAgent definition contains only the plan locator
and a configuration hash. That hash binds the normalized plan plus both complete
target-manifest fingerprints, including domains and Keychain locators; changing
any of them stops before Keychain access until the service is reviewed and
reinstalled. `run` strips ambient credentials and invokes an
`execute` child through a nonblocking native `lockf`; only that lock holder may
open Keychain-backed target credentials. A complete dual-target confirmation
atomically advances an owner-only aggregate freshness receipt. A normal child
failure records one bounded local support-journal event in the child; an
abnormal signal or pre-child wrapper failure is recorded by the parent. Neither
receipt contains paths, source identities, document names, URLs, content, raw
errors, or credentials.

The scheduler wrapper and plist renderer do not silently install or replace a
LaunchAgent. Production rollout still requires independent review, one
supervised successful sync, a staged rollback-safe service replacement, and a
fresh status read. The existing medical job must remain untouched until those
checks pass; copying the Drive job's plist or command would use the wrong lock
identity and could report false freshness.

---

## Private local issue journal

Each recognized public CLI failure attempts to write one immutable,
metadata-only event under `~/.brain/support/events/` when that private path is
writable. Concurrent commands never rewrite one another's event files. After
each successful write, best-effort retention may remove older complete event
files, but it never changes the event that triggered cleanup.
Unknown commands and failures of the support command itself are not recorded,
and journal failure never replaces the original error. This is local support
evidence, not telemetry: no network call exists in the journal module, and
the installer does not upload or send journal data.

```bash
brain support
brain support --preview
brain support --export brain-support-review.jsonl
brain support --clear --yes
```

The schema accepts only installer version, platform, architecture, Node major,
command, connector class, typed error code, timestamp, random event ID, and an
optional product-code fingerprint. The fingerprint is derived only after an
existing stack frame resolves inside the installed package and its sanitized
product-relative module and line pass the strict location validator. Raw stack
text and outside paths are never stored or hashed. The schema cannot accept raw
errors, stacks, argv, environment values, paths, URLs, manifests, account or
document IDs, filenames, queries, answers, indexed content, request bodies,
response bodies, or logs.
On POSIX, directories are `0700`, files are `0600`, and links, foreign
ownership, and nonregular files are refused. Windows keeps the journal inside
the current user profile and preserves the same schema and no-network boundary,
but this release does not claim equivalent ACL, ownership, or hard-link
enforcement there. Preview and export include only the newest 200 valid events,
at most 30 days and 2 MiB, and they use the same canonical bytes. The default
status reports the count in that recent shareable view, not the total number of
physical event files, and it does not print the user-profile path. A partial or
invalid event file is skipped rather than exported.

Physical retention is automatic and best effort after a new event is durable.
Cleanup considers only canonical event basenames and complete events that still
have the same file identity observed during scanning. It never deletes the
current event. A ten-minute freshness grace protects a process that is still
closing or syncing its event, and partial events are never cleanup candidates.
Concurrent cleaners choose the same oldest events and recheck identity before
unlinking. A rapid burst can temporarily exceed the physical count until a
later write runs after the grace period. Invalid or unsafe artifacts may remain
outside automatic retention. `brain support --clear --yes` removes partial or
invalid regular files only after the entire journal passes safety checks. It
refuses links and special files for manual review. Any cleanup error is
discarded so support housekeeping cannot replace the command's original
failure. Export refuses to overwrite an existing file. The installer does not
upload or send the export; a sync service may upload it when the chosen
destination is in a synced folder.

Cross-install collection is deliberately a later, opt-in feature. If built, it
needs a separate write-only support credential and an exact payload preview. It
must never reuse a brain admin key or a client's Cloudflare token.

---

## What is not built

Read this before scoping an engagement.

- **No interface.** curl plus an admin key. A non-technical owner cannot use it.
- **Some manifest declarations are still inert.** Google Drive source policy
  and the macOS `operations.ingest_cron` scheduler are wired. Other undeveloped
  corpora, health/report/webhook operations, most of `retrieval`,
  `access.authorized_emails`, `kv_namespace` and `r2_bucket` are read by nothing.
  `manifest.schema.json` marks the important boundaries. Do not tell a client an
  unwired declaration takes effect.

---

## Scale is an evaluation gate, not a guessed cutoff

The standard product backend is D1 plus Vectorize inside the client's
Cloudflare account. Vectorize currently caps a query at 100 returned candidates
when values and metadata are omitted. That is a candidate-depth constraint, not
evidence for a 100k or 250k corpus-size cutoff.

The retrieval path reduces the risk in three ways: metadata filters run before
topK, D1 FTS5 supplies an independent keyword candidate list, and reciprocal
rank fusion combines both lists. Full-corpus evaluation decides whether that is
good enough. Do not move a client to another backend based on chunk count alone.
Require a measured failure on the golden set, a diagnosed cause, and an approved
architecture change.

---

## Tests

```bash
npm test
npm run test:eval
```

The eval lane is separate so retrieval metric, provenance, template, and
artifact changes can be exercised quickly. It uses only synthetic fixtures and
starts a local HTTP brain; it never reads an installed brain or private golden
set. See `docs/EVALUATION.md` for the v2 contracts, release gates, and staged
diagnosis model.

`brain eval <manifest>` uses the `smoke` profile by default. It is diagnostic,
not certification. `brain eval <manifest> --profile release` fails before
reading the admin key or contacting the brain unless the private suite has at
least 60 cases, explicit risk, domain, format, and query-kind declarations, and
at least five cases in every declared slice. That is a v1 retrieval-suite
coverage gate. Full answer, citation, corpus-completeness, authorization,
confidence-bound, latency-budget, and cost certification remain v2 work.

`test/migrations.test.mjs` applies every migration to a real SQLite database and
asserts the FTS5 triggers actually keep the index in step. It exists because
migration 0004 once shipped broken: the SQL splitter shredded its trigger bodies,
and the store tests use mocks, so no test had ever executed a migration file.

The published package includes the reviewed eval runtime, configuration, and
blank golden-set template. Private baselines and client golden question files
are excluded. `package.json` uses an allowlist rather than a denylist so private
evaluation data cannot be included by accident.

`brain eval --artifacts <new-directory>` writes a sanitized internal v1 report
set with opaque case IDs. The directory and files are owner-only, are never
overwritten, and are never uploaded. It is intentionally not labeled as the v2
run-artifact schema described in `docs/EVALUATION.md`.
