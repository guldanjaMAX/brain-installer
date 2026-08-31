# Your own brain

A private brain that answers questions from **your own documents**, with
citations, and that tells you plainly when your documents do not contain the
answer.

It lives entirely inside your own Cloudflare account. Your files, your search
index, your keys. Claude Code is included in the owner setup commitment, and
Codex remains an optional second client. The installer connects the Brain to
whichever supported clients are present without placing a key in their config.

---

## Install it

The guided path is at `financialbrain.ai/install`. It uses one immutable release
asset and installs into a folder owned by your user account, so it needs no Git,
`sudo`, or administrator access.

Mac or Linux:

```bash
npm install --global --ignore-scripts --no-audit --no-fund --prefix "$HOME/.financial-brain" "https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v0.2.1/brain-installer-0.2.1.tgz"
# Optional: makes the shorter `brain` examples work in this Terminal window.
export PATH="$HOME/.financial-brain/bin:$PATH"
```

Windows PowerShell:

```powershell
npm.cmd install --global --ignore-scripts --no-audit --no-fund --prefix "$env:LOCALAPPDATA\FinancialBrain" "https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v0.2.1/brain-installer-0.2.1.tgz"
# Optional: makes the shorter `brain` examples work in this PowerShell window.
$env:Path = "$env:LOCALAPPDATA\FinancialBrain;$env:Path"
```

The full command path below is deliberate. It keeps working after Terminal is
closed, without `sudo`, administrator access, or a shell-profile change.

Setup and updates normally open Cloudflare in the owner's browser. Wrangler
keeps that approval in the computer's OS keyring under a separate, non-secret
profile for this Brain. The Brain CLI uses a short-lived access value only in
memory while the Cloudflare step runs, then clears it. Nothing needs to be
copied into Claude, Codex, a command, a chat, or a configuration file.

An expiring Cloudflare API token remains available for a reviewed legacy,
automation, or recovery workflow. It is a fallback, not the first-install
experience. When that path is genuinely needed, the owner enters it in a
hidden prompt or an approved no-history launcher. That fallback needs Workers
Scripts Edit, D1 Edit, Vectorize Edit, and Workers AI Read for the selected
account. Please keep it out of chat, command arguments, environment files,
screenshots, and support notes.

Mac or Linux:

```bash
"$HOME/.financial-brain/bin/brain" whatsnew
"$HOME/.financial-brain/bin/brain" doctor
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" whatsnew
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" doctor
```

---

## Set it up

Want to see the owner experience before connecting anything? From a source
checkout, run `npm run rehearse:onboarding`. It opens the real owner-workspace
bundle with synthetic data and an unmistakable local-only banner. No account,
credential, manifest, or deployment is used.

For the narrower recovery and bank-custody gate, run
`npm run test:recovery-bank`. It uses a temporary HOME, inherits no credentials,
and interrupts every recovery mutation and bank rewrap boundary with synthetic
fixtures. A pass is offline proof only, not a Cloudflare or bank-provider drill.

Want to see how recovery behaves before install day? Run
`npm run rehearse:hiccups` from the source checkout. It safely interrupts
synthetic setup, folder, connector, migration, search, owner-action, access, and
technician scenarios. The final receipt separates automatic proof from the
remaining live Cloudflare, provider, and physical-device checks.

For an install day, `brain technician <manifest>` prints the read-only plan.
Add `--json` when a local coding agent is guiding the session. The public
first-install path runs `tools`, the owner-terminal `cloudflare` ceremony, one
fixed public `smoke` document, the owner-only `passkey` handoff, and `verify`.
After that core install exists, explicitly configured Sandbox manifests may
also run the owner-terminal Plaid and QuickBooks ceremonies. Those steps record
command-level custody and continuation receipts, not live connector proof.
Google, Zoom, and IMAP ceremonies remain deferred until their secure custody
and real-provider field gates are complete.
The owner still handles login, 2FA, consent, the Cloudflare browser approval,
and the physical passkey gesture. The JSON plan provides exact structured
`owner_only_command` fields for Cloudflare, Plaid Sandbox, QuickBooks Sandbox,
and passkey actions. Claude never runs those commands through its agent shell.
The owner mints a one-time passkey invite only in a terminal they control
directly; invite links never enter agent chat, captured output, or status files.
The complete guide is
[onboarding/09-technician-setup-and-rehearsal.md](onboarding/09-technician-setup-and-rehearsal.md).

The deterministic owner handoff starts with `brain tools <manifest> --handoff`.
Every Windows tools preflight now requires 25 fresh credential-protection round
trips through one private process-scoped helper, followed by clean helper
disposal; `--deep-dpapi` remains an accepted compatibility spelling but no longer
weakens or strengthens that gate. The command writes a private package-local bootstrap status beside
the intended manifest and opens Claude with those exact paths. Every selected
technician step then writes `.financial-brain-technician-status.json` with a
stable status, issue code, retry boundary, exact manifest, and exact
package-local refresh launcher. Claude must run that credential-free refresh
before continuing. The smoke and final verification steps record live deployed
proof; ordinary child exit codes and a static manifest do not.

The optional Plaid profile is read-only, disabled by default, and still requires
a client-owned Plaid account plus the account holder's own Link ceremony. The
Sandbox-only `brain technician <manifest> --run plaid` step refuses an
unregistered return address or a Production manifest before prompting. It keeps
the three values inside one hidden owner-terminal handoff, clears them before
opening or printing the reviewed Link page, and records no value or page URL in
its status receipt. Each
masked account remains staged until the signed-in owner assigns it to one active
owned entity; an institution connection never defaults every account to one
business scope. After configuration, `brain connect bank <manifest>` performs
an offline redirect-readiness check, prints the exact owner page, and opens it
without reading a Plaid or Cloudflare credential. Its
offline rehearsal, opt-in live Sandbox runner, custody rules, and remaining
field gate are in [docs/PLAID.md](docs/PLAID.md).

You need three things first. `brain doctor` checks the technical access and tells
you what to do about anything missing. Cloudflare does not expose the account's
plan through the installer sign-in, so confirm **Workers and Pages,
Plans: Paid** in the dashboard yourself before a production install.

1. **Claude Code and a current paid Anthropic plan that includes Claude Code.**
   Anthropic controls plan eligibility, regional availability, and pricing, so
   confirm the current terms on Anthropic's official site before the session.
   Financial Brain does not include or purchase that third-party subscription.
   Install the current native CLI from Anthropic, sign in with
   `claude auth login`, then run `brain tools`.
   The command proves the version, sign-in, Anthropic installation doctor, and
   pinned Wrangler 4. It also installs and reads back the personal
   `/financial-brain-technician` skill. Open Claude Code, type `/skills` to
   confirm it appears, then type `/financial-brain-technician` whenever you want
   the reviewed install, connector, recovery, or handoff guide. Claude Code's
   normal approval prompts stay enabled.
2. **A Cloudflare account on the Workers Paid plan.** If this is your first
   Cloudflare account, the installer starts with Cloudflare's official sign-up
   page and waits while you create it, verify your email, and complete
   Cloudflare's own sign-in protection. If you already have an account, choose
   that option and sign in normally. The installer then shows every account the
   approval can reach and asks you to confirm the exact one before anything is
   created. Workers Paid is 5 USD a month minimum. Cloudflare now lets Free
   accounts create the meaning-search index, but Free has prototype-scale
   vector, daily database-write, and Worker CPU limits. Paid is the supported
   production baseline so a real corpus does not hard-stop.
3. **A browser and this computer's protected credential store.** Setup opens
   Cloudflare's browser approval for one named Wrangler profile and requires
   the macOS Keychain or Windows credential store. One Cloudflare account may
   hold several Brains. Each Brain still receives its own Worker, D1 database,
   Vectorize index, secrets, hostname, and saved resource identities. You do
   not need another Cloudflare account for another Brain unless you want
   separate billing or administrators.

This browser-sign-in flow has deterministic local coverage, including exact
account selection, keyring-only custody, permission failures, and clearing the
short-lived access value. It is not yet live-proven on the final Mac and
Windows install machines. The browser callback and the pinned Wrangler
permission set's real Vectorize access are named release gates, so a locally
green test is not yet a promise that this ceremony works in every real account.

Written answers use Cloudflare Workers AI through the same account. There is no
second AI-provider account or API key to create.

Then run the command for your computer. Setup creates the `Financial Brain`
folder if it does not exist and remembers this manifest location for updates.

Mac or Linux:

```bash
"$HOME/.financial-brain/bin/brain" setup "$HOME/Financial Brain/brain.manifest.json"
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" setup "$HOME\Financial Brain\brain.manifest.json"
```

It asks a few short questions and does everything else itself: whether this is
your first Cloudflare account or one you already use, which exact account will
own this Brain, and the Brain's public name. Cloudflare sign-in happens in its
own browser page. Setup then creates the database and search index in the
confirmed account, deploys the worker, generates and saves your key, checks it
is alive, and connects the brain to Claude Code plus an installed Codex client.
Successful Claude wiring writes an owner-only
`CLAUDE.md` beside the manifest. It gives Claude the exact Brain CLI and
manifest paths, but it does not grant whole-disk access, permission bypass, or
unapproved Cloudflare changes. On macOS a standard setup declares and verifies a login-Keychain
item before generating the key. Windows stores only DPAPI CurrentUser
ciphertext; Linux uses an owner-only adjacent file. An existing legacy Mac
`.brain-admin-key` remains authoritative instead of being silently moved.

If a first setup is interrupted after D1 commits only part of a migration, the
next setup does not guess that the database is unused. It stops before another
write and prints two exact commands: run `brain update <manifest>` to establish
the verified paused-writer boundary, then rerun `brain setup <manifest>`. If the
update later stops because setup has not saved its admin key yet, still rerun
setup as instructed; the migration boundary is already safe and resumable.

## Update it

First install the exact release named on `financialbrain.ai/update`. Then run
the update command from any folder. It uses the manifest location saved by
setup, even after Terminal has been closed and reopened.

Mac or Linux:

```bash
"$HOME/.financial-brain/bin/brain" update
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" update
```

If this Brain was installed before manifest remembering existed, name the full
manifest path once. Every later update can use the no-manifest command above:

```bash
"$HOME/.financial-brain/bin/brain" update "$HOME/Financial Brain/brain.manifest.json"
```

On Windows, use:

```powershell
& "$env:LOCALAPPDATA\FinancialBrain\brain.cmd" update "$HOME\Financial Brain\brain.manifest.json"
```

The update verifies the Cloudflare account, requires a D1 restore bookmark,
deploys and verifies a temporary paused Worker, waits for older Worker requests
to finish, and applies migrations. A legacy corpus is then rebuilt in durable
1,000-vector batches while writes remain paused. Several disjoint batches may
be accepted at once, but exact-generation readback is what confirms each vector
before its batch is acknowledged. An interrupted run resumes from D1 instead of
starting over. Only after that proof does update deploy active mode, run
exact-version health and the full acceptance suite, read the committed version
back from D1, and update the local manifest. Paused mode rejects every
corpus/source write, not only vector drain. A failed update keeps the bookmark
and tells you the safe rerun path. It never restores automatically because
restoring would discard newer writes.

After a release containing the update-status feature is installed, the owner
workspace Settings page checks the public release feed. A held or candidate
release is reported explicitly without any installer metadata or executable
handoff. Only a valid stable release offers the reviewed Claude Code handoff,
and it never updates in the background. An unreachable or invalid feed appears
as unavailable, not as proof that the Brain is current. Existing 0.2.0 clients must use this manual
update path once before the Settings check can appear.

---

## Load your documents

```bash
brain ingest ./brain.manifest.json --path "/a/folder/that/matters" --dry-run
```

The dry run sends nothing. It reports what it **would** load, and more usefully,
what it would skip and why. Read that list. It is where you find out what your
brain will not know.

Then drop `--dry-run` to load it for real. Large loads are resumable: if it is
interrupted, run the same command again and it continues from where it stopped.
Successfully accepted files remain saved when another file is corrupt,
truncated, unreadable, or beyond a safety limit, but the command still exits
non-zero and names the gap. It is safe to repair or split that export and run
the same command again. A partial load never becomes a green setup receipt.

A refresh may discover files that were deleted, newly excluded, or no longer
readable. It combines every removal reason into one plan. Up to 100 documents
and 10% of what that source loaded can be reconciled as routine source changes.
A plan crossing either limit stops before deleting anything or advancing the
source cursor. It prints aggregate counts and an opaque approval fingerprint,
never filenames or document IDs. Review the cause, then add the exact
`--approve-removals <fingerprint>` value only when the plan is expected.

The same plan and the same limits now cover a local folder, because a folder
that failed to mount looks exactly like a client who deleted everything in it.
The folder is inventoried again immediately before any removal. If a sync tool,
cloud placeholder, or another process changes it during the run, the refresh
stops and deletes nothing.

Ask directly in the terminal, even if you do not have Claude Code or Codex:

```bash
brain ask ./brain.manifest.json
```

The command prompts for the question so it does not enter your shell history.
Ask something only your documents could answer, then something they definitely
do not cover. The second answer matters as much as the first.

---

## What it reads

PDF, Word, Excel, PowerPoint, rich text, email, mail archives, meeting
transcripts and subtitles, calendar exports, CSV, HTML, Markdown, JSON, YAML,
and plain text.

**A file with many things in it becomes many documents.** A `.mbox` mail
archive is a mail folder, not a document: indexed whole it would be one
enormous blob dated by whichever message came first, and every citation into it
would point at a filename. It is split, so a citation points at one message.

**Transcripts keep their speakers.** A `.vtt` or `.srt` is read as
`Name: what they said`, because "who agreed to that" is unanswerable from an
undifferentiated wall of sentences. It is the same converter the live Zoom
connector uses, so a call saved by hand and a call delivered by webhook read
identically.

**Scanned PDFs can be read, and are marked when they are.** A scan is a picture
of a page with no text in it, and in a real corpus that is roughly one PDF in
seven. With OCR turned on, each page is sent to a model inside YOUR OWN
Cloudflare account and transcribed. Three things are true about that, and the
product says all three rather than the first one:

- **A machine read it, so it can be wrong.** Every document read this way is
  marked as OCR, and every answer that leans on one says so and scores lower
  for it. A blurry read never looks like a clean one.
- **A page it could not read is named, not skipped.** Unreadable pages appear
  in the text as `[[page N: could not be read]]`. Nothing is quietly missing.
- **A bad reading is still refused.** If the model described the page instead
  of transcribing it, or produced too little to be a page, the file is reported
  exactly as it was before OCR existed. Refusing beats a confident wrong answer.

It is **off by default**, because it spends money on your account, once per
scanned page. Turn it on with `safety.ocr.enabled` in the manifest. Before a run
the installer prints what the pages will cost and how long they will take.

---

## Undo

```bash
brain forget ./brain.manifest.json --source documents
```

Shows you exactly what would be removed. Nothing goes until you add `--yes`.

---

## Honest limits, so none of them are a surprise

- **OCR is optional and off by default.** Local synthetic scans prove the
  extraction, refusal, provenance, spend-cap, and citation paths. A private
  real-scan field gate is still required before calling it production-proven.
- **Outlook .msg and PST are not supported.** Export to .eml or .mbox and load
  the folder. Both of those are read: an `.eml` is one document, and an `.mbox`
  is split into its individual messages, each keeping its own subject, sender
  and date. (Before this version half that sentence was false — there was no
  `.mbox` reader and the archive was silently skipped.) A local `.mbox` larger
  than 64 MiB is no longer rejected wholesale: complete messages ending inside
  the first 64 MiB load through a bounded stream, and the result says explicitly
  that later messages were not indexed. One message over 8 MiB is likewise
  named as omitted rather than exhausting the ingest process. Split a larger
  export into smaller mail archives when the complete history is required.
- **Google Drive is root-bound and disabled by default.** To enable it, the
  manifest must name at least one reviewed folder id in
  `corpora.google_drive.root_folder_ids`. Ingest traverses only those folders
  and their descendants, including Shared Drives, and never follows a shortcut
  to content outside them. Root confinement, move handling, conservative
  tombstones, and resumability pass deterministic tests. A complete no-limit
  first sweep and the live add, edit, refuse, recover, trash, permission-loss,
  move, Shared Drive, and scheduler cycle remain field gates. Gmail is covered by
  the same OAuth and cursor-safety test harness but has not yet completed a
  real-account production run. Each client registers their own Google OAuth
  app, which takes about fifteen minutes.
- **Google Drive can refresh itself on macOS.** Its schedule is declared in the
  manifest and installed as a per-user LaunchAgent. Windows and Linux still
  require manually re-running the Drive refresh.
- **WhatsApp exports are the safer path.** The separate live paired-device
  connector is unofficial, violates WhatsApp's Terms of Service, and may lead
  to an account restriction or ban. Business automation should use Meta's
  official WhatsApp Business Platform, which is not built into this Brain yet.
- **One local folder can refresh itself too, also macOS only.** Name it in the
  manifest and `brain schedule <manifest> --install --folder` reloads it on a
  schedule: new files load, edited files reload, deleted files are removed. It
  is what makes "export it into this folder and forget about it" true for a
  folder that is not inside Google Drive. Hourly by default, so it is a drop
  box, not a live feed. Elsewhere, run the same load yourself.
- **The admin key is operator-only; people use passkeys.** An owner passkey has
  the owner's full workspace. A scoped person sees only exact documents granted
  to that session, and an unknown or unavailable grant fails closed. These
  contracts pass locally against the real Worker and migration code. A physical
  passkey ceremony on the final customer domain and devices remains a required
  field test before calling this production-proven.
- **MCP is read-only by default.** Local and remote clients start as a
  `librarian`. Structured contribution, diagnostics, and break-glass preview
  require one explicit fixed profile. No agent profile can execute a deletion;
  consuming an exact short-lived preview receipt requires a fresh owner
  passkey ceremony.
- **Facebook Messenger has an export path, not a live connector.** Select
  Messages and JSON in Meta's Download Your Information flow, then load the
  exported `message_*.json` files through Drive or the watched folder. The
  parser is fixture-tested and has not yet processed a reviewed real export.
- **QuickBooks Online, Slack, Notion, Microsoft 365, Dropbox, and HubSpot are
  sandbox-ready, not live-proven.** Each has local OAuth custody, refresh,
  bounded provider I/O, common receipts, scheduling, retry, and disconnect.
  QuickBooks additionally binds credentials and document identities to one
  canonical company fingerprint, discloses Intuit's broad Accounting scope,
  and refuses production until its implemented client-owned HTTPS callback is
  wired into the CLI and passes Cloudflare and Intuit field acceptance.
  QuickBooks, Slack, Notion, and HubSpot name their incomplete deletion truth.
  Microsoft and Dropbox withhold opaque cursors when file bodies or source
  visibility are incomplete. Run `brain connectors --rehearse` for invented
  offline proof; no provider account, credential, or customer record is used.
- **LinkedIn has an export path, not a live connector.** A Download Your Data
  ZIP is safety-checked and its recognized CSVs load through the ordinary
  folder path. There is no cookie capture, scraping, or live LinkedIn API.
- **The owner workspace accepts documents, not only pasted text.** PDF text
  layers, Word, PowerPoint, Excel, `.eml`, PNG, and JPEG use bounded extraction.
  Image OCR runs only inside the owner's Worker when enabled. Scanned PDF page
  OCR is not built.
- **Meeting transcripts arrive two ways, neither of them a transcription
  service.** Zoom cloud recordings deliver themselves to a webhook on your own
  worker. The worker makes each delivery durable before acknowledging it and
  checks a bounded recent window in case Zoom never delivered the webhook. A
  paid Zoom seat is required. A transcript you save by hand as `.vtt` or `.srt`
  is also read from any folder that is ingested. Nothing here transcribes audio;
  there is no speech recognition in this product.

---

## If something goes wrong

Installer commands are designed to resume or adopt completed work. The typed
recovery guide below says whether the same command is ready now, ready after one
step, or worth reviewing with the technician first.

```bash
brain doctor                          # what is wrong with this machine
brain health ./brain.manifest.json    # what is wrong with the brain
brain secrets ./brain.manifest.json   # exact durable ADMIN_KEY rotation command
```

The failures most likely to hit a working install, each with what you see, why
it happens, and the exact command, are in
[onboarding/06-runbook-top-ten-failures.md](onboarding/06-runbook-top-ten-failures.md).
It ships inside this package, so it is on your machine already and readable with
no network.

For an admin-key rotation, use an approved no-history credential launcher to
provide the replacement only to `brain secrets`, keeping it out of shell
commands and exported environment values. After a read-only Cloudflare account check, the
command updates and verifies the manifest's declared Keychain item or adjacent
protected file, then applies that durable desired value to the Worker. If the
remote write fails, rerun the same command without supplying the replacement
again; the verified durable copy is reused. Standard macOS setup creates the
non-secret Keychain locator
automatically; it is not a credential and is safe to keep in the manifest.
Setup, secrets, and upgrade also remove only the known Supabase or Anthropic
Worker secrets that the manifest does not allow. Other secret names are left
untouched, and every removal is read back from Cloudflare.

For a useful technical receipt, start with the issue code printed by the
command. `brain support --explain <issue-code>` gives the reviewed recovery
steps, and `brain support --preview` shows the exact metadata-only note before
you decide whether to share it. This keeps provider text, private paths, stack
traces, and credentials out of support messages.

Recognized command failures attempt to leave a private, sanitized issue note on
this machine whenever its local journal is writable. A note contains the
installer version, command, platform, and a typed failure code. Its fixed schema
has no place for document text, filenames, paths, account IDs, URLs, questions,
answers, logs, stack traces, or credentials. The installer keeps these notes on
this machine. An export written to a synced destination may be uploaded by that
sync service.

Automatic support email and alert webhooks are not available in this release.
Nothing sends an issue note, log, document, or provider response off this
computer. A future opt-in notification may carry only allowlisted metadata such
as the stable issue code, event ID, product version, and severity. It may not
carry raw errors, source content, paths, account details, or credentials.

Each typed code also has a calm recovery guide. It explains what happened, what
stayed protected, whether retrying is safe, and the next useful step:

```bash
brain support --explain AUTH_REQUIRED
brain support --explain AUTH_REQUIRED --json  # for a local coding assistant
```

Preview and export contain only recent shareable notes: at most the newest 200
valid events from the last 30 days, capped at 2 MiB. After a successful write,
the installer makes a best-effort cleanup of complete private events outside
those retention bounds. Fresh and concurrently written files are protected by
a grace period. Partial or unsafe artifacts are not deleted automatically and
may remain. Confirmed clear removes partial or invalid regular files after
safety checks; links and special files are refused for manual review. Cleanup
failure never replaces the command's original result.

```bash
brain support                                  # recent shareable count and limits
brain support --preview                       # exact bounded shareable bytes
brain support --explain <issue-code>           # plain-language recovery
brain support --export brain-support-review.jsonl  # destination sync may upload
brain support --clear --yes                    # clear the journal after safety checks
```

---

## For developers

Architecture, testing, the storage design and the retrieval measurement gates are in
[docs/README-developer.md](docs/README-developer.md).

```bash
npm ci --ignore-scripts && npm test
```
