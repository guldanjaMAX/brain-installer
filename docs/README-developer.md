# brain-installer

Provisions a retrieval brain into a **client's own Cloudflare account**. Text and
keyword search live in D1, vectors live in Vectorize, and the Worker fuses them.
Nothing runs on our infrastructure, and nothing but a scoped token is held during
the engagement.

**Status: 0.1.9.** Provisioning, retrieval, resumable folder ingest, deletion,
upgrade rollback, and `brain setup` are verified end to end against real
Cloudflare on macOS. Google Drive OAuth and a bounded real-account ingest have
also been verified. The complete Drive baseline is the remaining production
field gate for this release. Gmail uses the same tested cursor and storage
pipeline but has not completed a real-account production run. **Nothing has run
on Windows yet.** See "What is not built" before promising anything to anyone.

---

## Requirements

- Node 22 or newer (uses `node:sqlite` for the migration tests)
- A Cloudflare account **on the Workers Paid plan**, 5 USD a month. Vectorize
  cannot create an index on the free tier at all.
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
node brain.mjs setup                         # nothing to a working brain, one command
```

`setup` runs everything below in the only order that works, generates the admin
key, and registers the brain with Claude Code and Codex. The steps are also
available individually:

```bash
cp templates/brain.manifest.json ./acme.manifest.json   # then edit it
export CLOUDFLARE_API_TOKEN='...'

node brain.mjs verify     ./acme.manifest.json   # token, account, every service
node brain.mjs provision  ./acme.manifest.json   # D1 + Vectorize, writes IDs back
node brain.mjs migrate    ./acme.manifest.json   # schema
node brain.mjs deploy     ./acme.manifest.json   # worker, bindings, drain cron

# AFTER deploy, not before: a secret is set ON a worker script, so the script
# has to exist. Deploying without secrets is safe, because the deploy carries
# keep_bindings and later deploys preserve whatever is set here.
#
# `brain setup` generates the admin key itself and saves it to .brain-admin-key
# next to the manifest; every later command reads it from there. Only the manual
# path below needs to make one by hand.
# macOS/Linux:   export ADMIN_KEY="$(openssl rand -hex 24)"
# PowerShell:    $env:ADMIN_KEY = -join ((1..48) | %% { '{0:x}' -f (Get-Random -Max 16) })
node brain.mjs secrets    ./acme.manifest.json

node brain.mjs health     ./acme.manifest.json   # prove it, including vector backlog

node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --dry-run
node brain.mjs ingest     ./acme.manifest.json --path ~/Documents --source clientdocs

node brain.mjs test       ./acme.manifest.json   # full acceptance suite
```

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

Flags: `--dry-run`, `--source <name>`, `--limit <n>`, `--reset`.

---

## Using it: Claude Code and Codex

The brain has no web interface, deliberately. It is used through the tools people
already work in, over MCP.

```bash
node brain.mjs mcp-config ./acme.manifest.json
```

**Pass credentials with `-e`, never as an environment prefix.** Verified against
Claude Code 2.1.63 on 2026-08-17: `BRAIN_KEY=... claude mcp add ...` registers
the server with an EMPTY environment. It appears in `claude mcp list`, connects,
and then fails on the first question with no credential. `claude mcp get <name>`
is the check that catches it, and `brain setup` runs that check rather than
trusting the exit code.

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
`brain-installer.google-oauth`, account `local-google-connection`. Windows and
Linux use an atomically replaced local file at `~/.brain/google-tokens.json`;
macOS can explicitly select the same mode-0600 fallback with
`BRAIN_GOOGLE_TOKEN_STORE=file`. A legacy macOS token file is deleted only after
the full credential record has been written to Keychain and read back exactly.

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
next incremental sync removes it from the brain, chunks and vectors both. A
deletion that cannot be applied is kept in the state file and retried on the
following run rather than lost. **Gmail does not report deletions**, so a deleted
message stays until the source is re-ingested with `--reset`.

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
schedule. The reusable scheduler supports install, status and remove:

```bash
node operations/drive-scheduler.mjs install ./acme.manifest.json
node operations/drive-scheduler.mjs status  ./acme.manifest.json
node operations/drive-scheduler.mjs remove  ./acme.manifest.json
```

Install writes a per-user LaunchAgent under `~/Library/LaunchAgents`. It runs
`brain ingest <manifest> --from drive`, uses macOS's native per-client advisory lock to prevent
overlapping syncs, and writes separate stdout and stderr logs under
`~/.brain/logs`. Remove preserves those logs as an audit trail. LaunchAgent
calendar times use the Mac's local timezone; status reports a mismatch with
`client.timezone` instead of silently presenting the wrong schedule. Cron fields
are numeric; month and weekday names are not accepted today.

`RunAtLoad` is deliberately false. A calendar firing missed while this Mac is
asleep is coalesced by launchd and runs after wake. A firing missed while the
Mac is powered off or the user is logged out is not caught up, so choose a
schedule that overlaps the machine's normal logged-in hours.

The plist contains paths, schedule data and a non-secret configuration hash
only. Google credentials continue to come from the normal token store. The
brain admin key uses the adjacent `.brain-admin-key` lookup unless the manifest
declares a non-secret macOS Keychain locator. A direct manual run can use
`ADMIN_KEY`, but LaunchAgents do not inherit Terminal exports:

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
```

`test/migrations.test.mjs` applies every migration to a real SQLite database and
asserts the FTS5 triggers actually keep the index in step. It exists because
migration 0004 once shipped broken: the SQL splitter shredded its trigger bodies,
and the store tests use mocks, so no test had ever executed a migration file.

**`eval/` is excluded from the published package on purpose.** It holds a golden
question set built from the author's own brain, naming real clients and real
figures. `package.json` uses an allowlist rather than a denylist so that cannot
be re-included by accident.
