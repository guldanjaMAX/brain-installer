# brain-installer

Provisions a retrieval brain into a **client's own Cloudflare account**. Text and
keyword search live in D1, vectors live in Vectorize, and the Worker fuses them.
Nothing runs on our infrastructure, and nothing but a scoped token is held during
the engagement.

**Status: 0.2.0 release candidate.** Provisioning, retrieval, resumable ingest,
guarded deletion, owner actions, exact entity scope, document grants, passkey
observability, financial imports, and restart-safe migrations are covered by
the complete local product and contract suites. Earlier releases have real
Cloudflare synthetic-service proof, and Google Drive has partial real-data
proof. A fresh 0.2.0 Cloudflare field gate, the physical passkey ceremony on the
final domain, the named connector lifecycle tests, and a real-account Windows
install are still outside proof. See "What is not built" and
`CONNECTOR-BACKLOG.md` before promising anything to anyone.

Engineering changes follow [the code, test, documentation, and tracking
standard](./ENGINEERING-STANDARDS.md). Architecturally significant choices are
recorded in [append-only decision records](./decisions/README.md), beginning
with the [Cloudflare-native install decision](./decisions/001-cloudflare-native-standard.md).
The [maintainer guide](./MAINTAINER.md) gives the exact safe change, package,
release, owner-update, rollback, credential, and issue-evidence workflow.

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
# Low-level automation must inject the scoped Cloudflare token through an
# approved secret-manager-backed launcher. Never paste it into a shell command.

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
# Beginner installs use `brain setup`, which generates and persists this key.
# A deliberate operator rotation must inject the replacement through an
# approved no-history credential launcher.
node brain.mjs secrets    ./acme.manifest.json
# If the remote write failed, rerun the same command with no credential entry.
# The verified durable value is reused until the Worker converges.

node brain.mjs health     ./acme.manifest.json   # prove it, including vector backlog

node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --dry-run
node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --source clientdocs

node brain.mjs test       ./acme.manifest.json   # full acceptance suite
```

The supported beginner update is `brain update [manifest]`. It verifies the
account, requires a pre-change D1 bookmark, deploys and verifies a paused
compatibility Worker, waits the declared 20-minute old-invocation window, and
migrates. While the write barrier remains active, schema 13 rebuilds a legacy
projection through durable 1,000-row batches with a bounded number of disjoint
mutations in flight. Exact `getByIds` generation readback acknowledges each
batch, and D1 receipts make interruption resumable. Update deploys active mode
only after the whole projection is verified, then reconciles allowed Worker
secrets, requires exact-version health plus the full acceptance suite, commits
and reads back D1 version state, and atomically commits and reads back the local
manifest version. Paused mode rejects every corpus and source mutation before
D1 access.
The older `brain upgrade` command uses the same engine and cannot
bypass those gates. Neither path restores D1 automatically because that would
discard writes made after the bookmark. Direct `brain migrate` refuses a live
D1 install when the pending writer-protocol migrations require this cutover.

Always `--dry-run` first. It walks, extracts and judges every file without
sending anything, and prints what would be skipped and why. On a real corpus
that list is the useful part: it is where you find out that 12,000 PDFs are not
supported yet, before rather than after.

`verify` and `provision` are safe to re-run. Migration execution itself is
restart-safe after every independently committed statement, but a live D1
install must use `brain update` whenever the pending migration changes the
Vectorize writer protocol. Provision adopts existing resources rather than
duplicating them, and **refuses** to adopt a Vectorize index with the wrong
dimensions or metric rather than silently writing vectors that would be
rejected or mis-ranked.

If a first setup stopped after creating part of the migration schema but before
its receipt/seed, rerun setup remains fail-closed. With no exact manifest Worker
it cannot distinguish that partial setup from a renamed live writer. It changes
no more D1 state and instructs the owner to run `brain update <manifest>` for
the verified paused-writer cutover, then rerun `brain setup <manifest>`.

Verified recovery uses the provider-neutral state machine in
`operations/verified-recovery.mjs` and the disposable-only Cloudflare adapter in
`operations/cloudflare-recovery-adapter.mjs`. The adapter can export the
reviewed source, restore only an exact empty `recovery-gate-<nonce>` target,
rebuild Vectorize while a reviewed paused Worker is deployed, promote only its
separately reviewed immutable active version to 100 percent, and run health
plus release evaluation. It cannot create, upload, route, delete, or destroy
resources. The two versions must have the same reviewed script hash and exact
bindings except for paused mode. The run requires six previewed approval
fingerprints, including the blocking source-export window, both pinned target
Worker versions and manually reviewed empty routes, and exact Keychain-backed
Wrangler wrapper and private release golden bytes. See
`docs/RECOVERY.md` for the private artifact rules and remaining live field
gate.

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
node brain.mjs drain <manifest>                      # empties it safely now
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

**Formats today:** `.pdf .docx .xlsx .xlsm .xls .pptx .rtf .eml .mbox .vtt .srt
.ics .csv .tsv .json .txt .md .markdown .text .log .rst .adoc .html .htm .xhtml
.xml`

Five of those carry no dependency at all. `.vtt` and `.srt` run through
`worker/src/lib/vtt.js`, the SAME function the Zoom connector uses on the
transcripts Zoom delivers — a second transcript parser would drift from the
first invisibly, both still producing text while one slowly got worse. `.ics`
is converted into the shape `renderEvent` in `connectors/google-calendar.mjs`
already accepts and rendered by it, so an event reads identically whether it
arrived through the calendar connector or as an exported file. `.rtf` is a
hand-written state machine (`ingest/rtf.mjs`) rather than a fifth dependency:
the format is control words and braces, and the hard part is discarding the
font, style and embedded-picture destinations, not parsing.

`.mbox` is the one that is not a document. `ingest/run.mjs` splits it and loads
each message separately, through the same `parseEmailMessage` the `.eml` path
uses, so one archive becomes many citable documents with their own subjects and
Date headers. The registry also holds a single-document `.mbox` reader for
callers that cannot express one-file-many-documents (Drive), rendering every
message through that same reader: coarser, never different.

Four dependencies carry the binary formats: `unpdf`, `fflate`, `@e965/xlsx` and
`postal-mime`. 11 MB total, pure JavaScript, no node-gyp, no postinstall scripts,
zero advisories. That matters because this installs on the client's own machine
during a live session, and a native build failing on their Windows box is not a
problem you want to debug in front of them. Install with `npm ci --ignore-scripts`.

There is deliberately **no optional dependency tier**. An optional extractor
fails *silently correct*: the run reports 61,000 files ingested and every
contract is missing because a flag nobody set was not passed.

**Scanned PDFs are refused unless OCR is explicitly enabled.** A scan has no
text layer, so indexing the empty extraction would create a document the brain
counts but cannot answer from. Measured on a random sample of 70 PDFs from a
real 4,458-file corpus: 79% had a usable text layer, 7% were thin (under 100
characters per page, flagged and indexed anyway), and 14% had zero text.

`safety.ocr.enabled` is off by default. When enabled, the existing PDF child
extracts page images without a native dependency and sends each page through
`POST /api/admin/brain/ocr` to Workers AI in the owner's Cloudflare account.
The daily spend cap applies to every page. A scan is stored only when the
transcription clears the normal quality floor; unreadable pages are named
inline, and a majority-unreadable or descriptive response refuses the whole
document. `documents.text_source` and `text_reliable` carry the OCR provenance
through retrieval and citations. Local synthetic scans prove this contract;
real typed, fax-quality, and handwritten scans remain a private field gate.

CSV and TSV are rendered row-wise as `Header: value` rather than as a bare grid,
because `15234.11` on its own is unretrievable while `Balance: 15234.11` answers
a question about a balance.

A local-folder run also reconciles DELETIONS: a file this source loaded before
and can no longer find is removed, through the same aggregate removal plan and
the same safety limits Drive uses. The plan denominator comes from the
authenticated Worker inventory, not the local resume file, and exact targets
are read back after deletion before completed source state is recorded. Pending
deletions re-enter the current plan rather than bypassing it. Suppressed under
`--limit`, where an unexamined file is not a deleted one.

**`safety.private_path_prefixes` is enforced on local-folder and Google Drive
ingest**, per path segment. Drive also enforces `corpora.google_drive` exact
file-id, path-prefix and filename-part exclusions before downloading content.
An excluded document already present in the brain is removed rather than left
stranded. Gmail has no folder path and does not use these rules.

Flags: `--dry-run`, `--source <name>`, `--limit <n>`, `--reset`, and the
exact-plan acknowledgement `--approve-removals <fingerprint>` when a cleanup —
Drive's, or a local folder's — exceeds its routine safety limits.

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

## Remote sources: Google Drive, Gmail and IMAP

```bash
node brain.mjs connect google --scopes drive,gmail
node brain.mjs ingest ./acme.manifest.json --from drive --dry-run
node brain.mjs ingest ./acme.manifest.json --from drive
node brain.mjs ingest ./acme.manifest.json --from gmail
```

For a mailbox that is not Gmail:

```bash
node brain.mjs connect imap ./acme.manifest.json --host imap.mail.yahoo.com --user owner@example.test
node brain.mjs ingest  ./acme.manifest.json --from imap --dry-run
node brain.mjs ingest  ./acme.manifest.json --from imap
node brain.mjs disconnect imap ./acme.manifest.json
```

`connectors/imap.mjs` speaks the read-only subset of RFC 3501 directly on
`node:tls` and adds no dependency; the doctrine and its reason are in
`ingest/extract.mjs`. It uses `EXAMINE`, never `SELECT`, so it cannot set
`\Seen`. Raw `BODY.PEEK[]` octets go through the same postal-mime `.eml` reader
the Gmail connector and the mbox splitter use, so one message renders
identically whichever door it came through.

Incremental sync is `UIDVALIDITY` plus a per-folder highest-accepted UID, and
the two traps are handled explicitly: `UID SEARCH n:*` always returns the
highest existing UID (RFC 3501 6.4.8) so the result is floored client-side, and
a `UIDVALIDITY` change re-searches the folder with `ALL` rather than resuming
from a number that no longer means anything. The document id is the message's
own `Message-ID` (or a content hash when absent), not `<folder>:<uid>`, so a
`UIDVALIDITY` roll resolves to `unchanged` per message instead of silently
duplicating the mailbox. Per-folder positions are merged, never assigned, and a
new `UIDVALIDITY` is only ever written together with the watermark it covers.

The mailbox app password is entered hidden and stored through the SAME storage
code as the Google record, under its own item: service `brain-installer.imap`,
account `imap-<source name>`, file fallback `~/.brain/imap-credentials.json`,
backend selected by `BRAIN_IMAP_CREDENTIAL_STORE`. It is never a flag and never
an environment variable. Entry goes through `readHiddenInput` in `brain.mjs`,
the single raw-mode reader that `readHiddenCloudflareToken` also uses; the
prompt, the acceptable bytes and the finaliser are the only per-caller
differences, and a space is legal in a mailbox password precisely because
providers display app passwords in groups of four.

Folders are sorted into five outcomes and each is reported with its own true
reason: read, skipped by policy, identified but not read (an `Archive` folder is
the real case), unidentified, and `\Noselect` containers that are not mail
folders at all. Collapsing the middle three into one "could not be classified"
message is a false statement about a folder that was in fact identified.

**The connector has never been run against a real mailbox**;
`test/imap-connector.test.mjs` drives it against a scripted IMAP server on a
plain TCP socket, which does not exercise TLS.

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

Calendar uses the same completion boundary. Its new sync token is saved only
after every event receipt and cancellation removal is accepted. A failed or
refused event, or a pending cancellation cleanup, closes the source receipt as
incomplete and leaves the prior token in place so the same Google window is
retried idempotently.
Its dry run returns the same common preview receipt as every other source. If
any declared calendar cannot be read, the preview reports what it did see and
then exits nonzero with the reconsent or provider fix instead of presenting a
zero-event partial read as a successful preview.

Message command adapters use the same result boundary. `documents_sent` means
the conversation reached the Worker boundary; `documents_accepted` counts only
created, updated, or unchanged receipts. Credential refusals are returned as a
`partial` outcome and are excluded from the accepted total, so `brain load`
cannot promote a submitted-but-refused conversation to completed work. Dry-run
passes for iMessage, WhatsApp, and iPhone backup report `would_send` from the
real sessionizer while resolving no admin key, posting no receipt, sending no
batch, and saving no state. Any explicit `--limit` also makes the command result
`partial`, even when the available fixture happens to fit inside the bound.
Non-dry credential refusals persist a redacted `refusal_reason` in the sync run,
and direct command output stays warning-shaped rather than printing a green
accepted-count line.

A family is addressed by ONE uid, and there are two ways to belong to it.
**Structural**: `splitOversized` names each slice `<base>#part1of3`, so the base
is a literal prefix of every member. **Declared**: one message export (a
WhatsApp `.txt`, an SMS Backup & Restore `.xml`, a Google Voice Takeout page)
becomes many conversation-session documents that keep their own
`message:<first message id>` identity, so nothing in their names points back at
the file they came from. Each one carries `metadata.family_of` holding the
fully qualified uid of that file instead. `forgetFamilies` covers both, and it
refuses any `keep_doc_uids` entry that is neither, because the delete scope
comes from the base alone: a keep list expressed in the wrong identity space
protects nothing while the scope is real, and cleanup would then remove the
revision it was called to reconcile. Any new producer that turns one input into
many documents must stamp `family_of`; leaving it out is a hard refusal at plan
time rather than a silently unreconcilable source.

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

`RunAtLoad` is deliberately true. A calendar firing missed while this Mac is
asleep is coalesced by launchd and runs after wake, but a firing missed while
the Mac is powered off or the user is logged out is dropped and never made up.
On a laptop with a fixed daily time that is not an occasional miss: if the
machine is routinely off at that hour the job never runs at all, and the only
symptom is a source that silently stops updating. Running at load catches that
up. The cost is one extra run per login, bounded by the same `lockf` wrapper,
incremental ingest and `ThrottleInterval` as any other firing. It also means
installing a schedule performs the first sync immediately instead of waiting
for tomorrow's calendar time.

The interpreter in `ProgramArguments[0]` is the absolute path of the Node that
installed the schedule, on purpose: resolving `node` through `PATH` at run time
would let the ambient environment choose the interpreter, which is the
authority the sanitized child environment exists to remove. The cost is that a
version-manager path (`~/.nvm/versions/node/vNN`, `node@NN`, Volta, fnm, asdf)
stops existing after a routine Node upgrade and every scheduled run then fails
to start. That is made detectable rather than silent: install warns when the
interpreter path carries a version, `--status` warns the moment the interpreter
is gone (`interpreter_present: false`), and per-source freshness fails
acceptance once the source stops refreshing. The repair is to reinstall the
schedule.

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

### Unattended watched-folder refresh on macOS

The third consumer of the same generalized scheduler, after Drive and iMessage.
`operations/folder-scheduler.mjs` supplies only a `SCHEDULER_SPEC`; every piece
of hardening above — atomic plist staging with rollback, the native advisory
lock, bounded symlink-refusing log rotation, the config-hash guard against a
stale agent reading credentials for an edited manifest — is the same code.

```bash
node brain.mjs schedule ./acme.manifest.json --install --folder
node brain.mjs schedule ./acme.manifest.json --folder
node brain.mjs schedule ./acme.manifest.json --remove --folder
```

It reads `corpora.local_folder` (`enabled`, `path`, `source`) and
`operations.folder_ingest_cron`, hourly by default. The tick runs
`brain ingest <manifest> --path <folder> --source <name>` — the ORDINARY local
ingest, not a new code path — so it inherits that command's content-hash resume
state exactly: new file loads, changed file re-sends, unchanged file costs one
read, interrupted run resumes. The folder and source name are bound into the
config hash, so an installed agent cannot be repointed at another tree by
editing the manifest afterwards.

`validateExtras` refuses a relative path (launchd's working directory is not the
client's shell), a folder that does not currently exist (a schedule pointing at
nothing loads nothing and reports success forever), and a source name outside
`^[a-z0-9][a-z0-9_-]*$` (the name is the deletion scope). Status and remove stay
reachable when the folder is later deleted, so a loaded agent is never stranded.

**Deletions.** The local ingest lane now reconciles files that are gone, through
the same `buildDriveRemovalPlan` / `assertDriveRemovalPlanSafe` aggregate guard
the Drive lane uses, with the same 100-document and 10% limits and the same
`--approve-removals <fingerprint>` acknowledgement. `removedSinceLastRun` in
`ingest/run.mjs` computes the candidates from the resume state and the set of
paths the walk saw — including paths it SKIPPED, so a file skipped this run for
being empty, oversized or private is not mistaken for a deleted one. It is
suppressed entirely under `--limit`, where an unexamined file is not a deleted
file, and an incomplete walk already aborts the run before this point. That
matters most unattended: a cloud folder that failed to materialize is
indistinguishable from an owner deleting everything in it.

Candidates are not deletion truth. Before the guard, the lane reads the live
family set through the authenticated Worker route, including `family_of`
families produced by message exports, and intersects candidates with that set.
Only the categorized plan targets reach the forget route. It then inventories
the source again and leaves a retry marker plus an error receipt if any exact
target remains. A pending retry goes back through this current plan and cannot
reuse an earlier denominator or bypass a changed fingerprint.

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
reinstalled. The public `run` command requires that exact 64-character hash and
rejects missing, empty, duplicate, or unknown CLI arguments. Its internal child
command is omitted from public usage and requires the same hash. `run` strips
ambient credentials, opens and validates the owner-only lock without following
links, and passes that already-open descriptor to a nonblocking native `lockf`.
Before Keychain or network access, the child proves fd 3 is the same stable lock
inode, its parent is the native `lockf`, and an independent descriptor observes
active contention. Merely opening the lock or copying the hash cannot bypass
that gate. A complete
dual-target confirmation atomically advances an owner-only aggregate freshness
receipt. A normal child
failure records one bounded local support-journal event and returns a dedicated
handled exit code; every other nonzero result is parent-owned, so a missing
command, runtime startup failure, abnormal signal, or pre-child wrapper failure
still produces one event without duplicating the handled child. macOS
`lockf` translates a signaled or stopped child to exit 70, so the wrapper treats
that exact result as abnormal even though Node receives no signal name. Neither
receipt contains paths, source identities, document names, URLs, content, raw
errors, or credentials. Freshness rejects malformed aggregates and timestamps
more than five minutes ahead of the local clock, and any configuration change is
always stale.

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

- **No owner-facing corpus deletion workflow.** The owner workspace can upload,
  approve, close periods, explore, manage targets and preferences, and use
  document grants. Corpus forget remains an operator-only, preview-first admin
  command until a separate deletion contract is reviewed.
- **The owner workspace is not field-proven by its local suite.** Passkey,
  entity-scope, and document-grant contracts run against the real Worker code
  with an in-memory D1-shaped adapter. The final domain and physical devices
  still need the weekend ceremony and access-control gate.
- **Long-tail provider APIs remain absent.** Slack, Notion, Microsoft 365,
  Dropbox, QuickBooks, Plaid, and CRM APIs are not product connectors. Manual
  exports, a watched folder, or Drive are first-class custody plans, not a
  pretend API integration.
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

### Local owner-onboarding rehearsal

`npm run rehearse:onboarding` builds the current React owner workspace without
rewriting the committed Worker asset module, starts the existing synthetic API
fixture on loopback, and proxies it through a local safety page. The proxy adds
a persistent rehearsal banner and exposes populated, sign-in, empty, partial,
degraded, conflict, replay, owner, and exact-document grant states. It reads no
manifest or credential store and makes no live service call.

`test/onboarding-sandbox.test.mjs` protects the safety labeling, state menu,
scenario routing, and absence of credential fields. This is browser-contract
and layout evidence only. Cloudflare install, provider OAuth, webhook delivery,
mailbox access, and physical WebAuthn remain field gates.

`npm run rehearse:hiccups` is the matching offline failure rehearsal. It runs a
curated set of product tests for interrupted setup, missing mounts and removal
guards, partial connectors, lost-response idempotency, restart-safe migrations,
vector backlog recovery, passkey and document scope, and technician support.
The child environment is allowlisted so ambient provider and API credentials do
not reach the test processes. Its receipt pairs every automatic proof with the
exact real-service or physical-device field gate still outstanding. Use
`-- --list`, `-- --only <scenario>`, or `-- --json` for targeted and agent-led
runs.

`brain technician <manifest>` is the matching install-day coordinator. Its
default and `--json` forms are read-only. A selected `--run` step launches the
existing command in a child process with an allowlisted environment. Google and
Zoom values are collected by the shared hidden-input primitive, never placed in
argv, and cleared from the coordinator's buffers and child environment object
after the command exits. Tests assert ordering, rerun behavior, ambient-secret
scrubbing, exact hostname confirmation before invite creation, and stop-on-fail
verification.

Current connector proof levels and the ranked acceptance backlog are maintained
in [CONNECTOR-BACKLOG.md](./CONNECTOR-BACKLOG.md). Fixture coverage is never a
substitute for the named real-system field gate.

Every value in `SUPPORT_ERROR_CODES` also has one entry in
`support-recovery.mjs`. `brain support --explain <code>` renders the human form;
`--json` returns the same fixed recovery contract for a local assistant. The
catalog is deliberately separate from private issue events: a stored event
keeps only its durable code, while wording and recovery steps can improve. Tests
require complete catalog coverage, stable typed-error precedence, inviting
language, and absence of secret-bearing fields.

```bash
npm test
npm run test:eval
```

The eval lane is separate so retrieval metric, provenance, template, and
artifact changes can be exercised quickly. It uses only synthetic fixtures and
starts a local HTTP brain; it never reads an installed brain or private golden
set. See `docs/EVALUATION.md` for the v2 contracts, release gates, and staged
diagnosis model.

`test/live/d1-release-field-gate.mjs` is the opt-in real-service release gate.
It is never part of `npm test` because it creates billable Cloudflare resources.
Run it only against a newly provisioned manifest whose name explicitly says
`Synthetic Field Gate`. It exercises changed, unchanged, mixed, concurrent,
high-chunk, embedding, retrieval, diagnosis, and confirmed cleanup behavior,
then prints an aggregate-only receipt. Preserve the sanitized receipt under
`docs/release-evidence/` and delete the exact disposable Worker, D1 database,
Vectorize index, and temporary admin-key item. The harness refuses ordinary
client manifests and never accepts or prints a private corpus.

`brain eval <manifest>` uses the `smoke` profile by default. It is diagnostic,
not certification. `brain eval <manifest> --profile release` fails before
reading the admin key or contacting the brain unless the private suite has at
least 60 cases, explicit risk, domain, format, and query-kind declarations, and
at least five cases in every declared slice. That is a v1 retrieval-suite
coverage gate. Query-kind coverage comes from executable `kind`, and every
release unanswerable case must run and pass even when it is not marked critical.
Answerable v1 cases may opt into a deterministic `/think` canary through
`answer_expect`: a literal phrase or typed value must appear inside one sentence
with an inline citation resolving to an allowed evidence slot. Every declared
release canary and every critical smoke canary must run and pass. Existing v1
cases remain retrieval-only. `--no-think` is smoke-only.

An install may add a private corpus completeness gate:

```bash
brain eval <manifest> --corpus-contract ./brain.corpus-contract.json
```

The mode-0600 contract is validated twice before credential use and is bound to
the manifest `client.slug`. A complete contract and complete per-connector
snapshots reconcile every expected logical source family against the
authenticated read-only D1 family inventory. Private family identities and
cursors travel in JSON POST bodies, never URLs, and the response is private and
no-store. The complete source set is derived from live D1 documents instead of
denormalized corpus statistics. Eligible sources must exist;
excluded, quarantined, and tombstoned sources must not; and unknown indexed
families fail. Aggregate slice counts and stage-specific codes enter the normal
JSON, JSONL, CSV, and JUnit artifacts. Private locators, source identities,
document names, content hashes, versions, and content never do.

This shipped gate proves logical source-family presence and expected policy
absence only. D1's current family observation does not expose content-version,
extraction, connector-failure, or per-family vector evidence, so those stages
remain explicitly not observable. General answer correctness, additional-claim
and faithfulness review, semantic citation support, authorization,
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
overwritten, and are never uploaded. Deterministic answer results contain only
counts, booleans, and typed failure codes, never expected phrases, values,
answers, citation identities, or source titles. It is intentionally not labeled
as the v2 run-artifact schema described in `docs/EVALUATION.md`.
