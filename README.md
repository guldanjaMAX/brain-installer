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
npm install --global --ignore-scripts --no-audit --no-fund --prefix "$HOME/.financial-brain" "https://github.com/guldanjaMAX/brain-installer/releases/download/v0.4.0/brain-installer-0.4.0.tgz"
# Optional: makes the shorter `brain` examples work in this Terminal window.
export PATH="$HOME/.financial-brain/bin:$PATH"
```

Windows PowerShell:

```powershell
npm.cmd install --global --ignore-scripts --no-audit --no-fund --prefix "$env:LOCALAPPDATA\FinancialBrain" "https://github.com/guldanjaMAX/brain-installer/releases/download/v0.4.0/brain-installer-0.4.0.tgz"
# Optional: makes the shorter `brain` examples work in this PowerShell window.
$env:Path = "$env:LOCALAPPDATA\FinancialBrain;$env:Path"
```

The full command path below is deliberate. It keeps working after Terminal is
closed, without `sudo`, administrator access, or a shell-profile change.

Setup and updates ask for the scoped Cloudflare token
inside a hidden terminal prompt. The token exists only for that command and is
kept out of files, command arguments, logs, and issue notes.

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

Want to see how recovery behaves before install day? Run
`npm run rehearse:hiccups` from the source checkout. It safely interrupts
synthetic setup, folder, connector, migration, search, owner-action, access, and
technician scenarios. The final receipt separates automatic proof from the
remaining live Cloudflare, provider, and physical-device checks.

For an install day, `brain technician <manifest>` prints the seven-step read-only
plan. Add `--json` when a local coding agent is guiding the session. Run one
reviewed step at a time with `--run tools`, `cloudflare`, `google`, `zoom`,
`imap`, `passkey`, or `verify`. The owner still handles login, 2FA, OAuth consent, and
the physical passkey gesture. Tokens and app secrets go only into hidden
terminal prompts or provider pages. The complete guide is
[onboarding/09-technician-setup-and-rehearsal.md](onboarding/09-technician-setup-and-rehearsal.md).

You need three things first. `brain doctor` checks the technical access and tells
you what to do about anything missing. Cloudflare does not expose the account's
plan through the scoped install token, so confirm **Workers and Pages,
Plans: Paid** in the dashboard yourself before a production install.

1. **Claude Code and an eligible Claude account.** Install the current native
   CLI from Anthropic, sign in with `claude auth login`, then run `brain tools`.
   The command proves the version, sign-in, Anthropic installation doctor, and
   pinned Wrangler 4. It also installs and reads back the personal
   `/financial-brain-technician` skill. Open Claude Code, type `/skills` to
   confirm it appears, then type `/financial-brain-technician` whenever you want
   the reviewed install, connector, recovery, or handoff guide. Claude Code's
   normal approval prompts stay enabled.
2. **A Cloudflare account on the Workers Paid plan.** 5 USD a month minimum.
   Cloudflare now lets Free accounts create the meaning-search index, but Free
   has prototype-scale vector, daily database-write, and Worker CPU limits. Paid
   is the supported production baseline so a real corpus does not hard-stop.
3. **A Cloudflare API token**, created in your own account, with exactly four
   permissions: Workers Scripts Edit, D1 Edit, Vectorize Edit and Workers AI
   Read. The token can be limited to your account and given an expiry.

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

It asks three short questions and does everything else itself: creates the
database and search index in your account, deploys the worker, generates and
saves your key, checks it is alive, and connects the brain to Claude Code plus
an installed Codex client. Successful Claude wiring writes an owner-only
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

A refresh may discover files that were deleted, newly excluded, or no longer
readable. It combines every removal reason into one plan. Up to 100 documents
and 10% of what that source loaded can be reconciled as routine source changes.
A plan crossing either limit stops before deleting anything or advancing the
source cursor. It prints aggregate counts and an opaque approval fingerprint,
never filenames or document IDs. Review the cause, then add the exact
`--approve-removals <fingerprint>` value only when the plan is expected.

The same plan and the same limits now cover a local folder, because a folder
that failed to mount looks exactly like a client who deleted everything in it.

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
transcripts and subtitles, calendar exports, CSV, HTML, Markdown, JSON and
plain text.

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
  `.mbox` reader and the archive was silently skipped.)
- **Google Drive OAuth and resumable partial real-account ingest are verified.**
  A complete no-limit first sweep and the live add, edit, refuse, recover,
  trash, and incremental-refresh cycle remain field gates. Gmail is covered by
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
- **Facebook Messenger has an export path, not a live connector.** Select
  Messages and JSON in Meta's Download Your Information flow, then load the
  exported `message_*.json` files through Drive or the watched folder. The
  parser is fixture-tested and has not yet processed a reviewed real export.
- **Slack and Notion** do not exist as connectors.
- **Meeting transcripts arrive two ways, neither of them a transcription
  service.** Zoom cloud recordings deliver themselves to a webhook on your own
  worker (new recordings only, no backfill, paid Zoom seat required), and a
  transcript you save by hand as `.vtt` or `.srt` is read from any folder that
  is ingested. Nothing here transcribes audio; there is no speech recognition
  in this product.

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

For technical detail on any error, put `BRAIN_DEBUG=1` in front of the same
command.

Recognized command failures attempt to leave a private, sanitized issue note on
this machine whenever its local journal is writable. A note contains the
installer version, command, platform, and a typed failure code. Its fixed schema
has no place for document text, filenames, paths, account IDs, URLs, questions,
answers, logs, stack traces, or credentials. The installer keeps these notes on
this machine. An export written to a synced destination may be uploaded by that
sync service.

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
