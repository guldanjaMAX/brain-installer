# Your own brain

A private brain that answers questions from **your own documents**, with
citations, and that tells you plainly when your documents do not contain the
answer.

It lives entirely inside your own Cloudflare account. Your files, your search
index, your keys. It connects itself to Claude Code and Codex so you can ask it
questions from any folder on your machine.

---

## Install it

```bash
npm install -g github:guldanjaMAX/brain-installer
```

That is the whole install. To update later, run the same command again.

```bash
brain whatsnew     # what this version does, and whether you are on it
brain doctor       # check your machine has everything it needs
```

---

## Set it up

You need two things first. `brain doctor` checks all of them and tells you
exactly what to do about anything missing.

1. **A Cloudflare account on the Workers Paid plan.** 5 USD a month. The
   meaning-based search index cannot be created on the free tier at all, and
   this is the one requirement with no workaround.
2. **A Cloudflare API token**, created in your own account, with exactly four
   permissions: Workers Scripts Edit, D1 Edit, Vectorize Edit and Workers AI
   Read. The token can be limited to your account and given an expiry.

Written answers use Cloudflare Workers AI through the same account. There is no
second AI-provider account or API key to create.

Then:

```bash
brain setup
```

It asks three short questions and does everything else itself: creates the
database and search index in your account, deploys the worker, generates and
saves your key, checks it is alive, and connects the brain to your Claude Code
and Codex. On macOS a standard setup declares and verifies a login-Keychain
item before generating the key. Windows stores only DPAPI CurrentUser
ciphertext; Linux uses an owner-only adjacent file. An existing legacy Mac
`.brain-admin-key` remains authoritative instead of being silently moved.

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

Restart Claude Code, then ask it something only your documents could answer.
Then ask it something they definitely do not cover, and watch it say so. The
second answer matters as much as the first.

---

## What it reads

PDF, Word, Excel, PowerPoint, email, CSV, HTML, Markdown, JSON and plain text.

**Scanned PDFs are refused, not faked.** A scan is a picture of a page with no
text in it. Rather than index an empty document and let your brain claim it
knows something it cannot read, it tells you the file needs OCR first. In a real
corpus that is roughly one PDF in seven.

---

## Undo

```bash
brain forget ./brain.manifest.json --source documents
```

Shows you exactly what would be removed. Nothing goes until you add `--yes`.

---

## Honest limits, so none of them are a surprise

- **No OCR yet**, so scanned PDFs are reported rather than read.
- **Outlook .msg and PST are not supported.** Export to .eml or .mbox and load
  the folder.
- **Google Drive sync has passed a real-account field test.** Gmail is covered
  by the same OAuth and cursor-safety test harness but has not yet completed a
  real-account production run. Each client registers their own Google OAuth app,
  which takes about fifteen minutes.
- **Google Drive can refresh itself on macOS.** Its schedule is declared in the
  manifest and installed as a per-user LaunchAgent. Windows and Linux still
  require manually re-running the Drive refresh.
- **One key, all access.** Anyone with the admin key can ask anything. There are
  no per-person permissions yet.
- **Slack, Notion and meeting transcripts** do not exist as connectors.

---

## If something goes wrong

Every command is safe to run again. Nothing is left half-written that re-running
cannot finish.

```bash
brain doctor                          # what is wrong with this machine
brain health ./brain.manifest.json    # what is wrong with the brain
brain secrets ./brain.manifest.json   # exact durable ADMIN_KEY rotation command
```

For an admin-key rotation, export the replacement as `ADMIN_KEY` and run
`brain secrets`. After a read-only Cloudflare account check, it updates and
verifies the manifest's declared Keychain item or adjacent protected file, then
applies that durable desired value to the Worker. If the remote write fails,
rerun the same command with no `ADMIN_KEY` export; the verified durable copy is
reused. Standard macOS setup creates the non-secret Keychain locator
automatically; it is not a credential and is safe to keep in the manifest.
Setup, secrets, and upgrade also remove only the known Supabase or Anthropic
Worker secrets that the manifest does not allow. Other secret names are left
untouched, and every removal is read back from Cloudflare.

For technical detail on any error, put `BRAIN_DEBUG=1` in front of the same
command.

Recognized command failures attempt to leave a private, sanitized issue note on
this machine whenever its local journal is writable. A note contains the
installer version, command, platform, and a typed failure code. It never
contains document text, filenames, paths, account IDs, URLs, questions, answers,
logs, stack traces, or credentials. The installer never uploads or sends these
notes. An export written to a synced destination may be uploaded by that sync
service.

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
