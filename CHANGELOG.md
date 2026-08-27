# What's new

Read by `brain whatsnew`, so a client sees this in their terminal rather than
having to be told. Newest first. Each entry is written for the person who OWNS
the brain, not for whoever built it: what changed for them, and what to check.

## 0.1.17

**`brain eval --golden-20` builds your acceptance question set with you, live
against your brain, in one sitting.**

- Twenty slots with a fixed mix: six single-document facts, three answers that
  need several documents together, three things that changed over time, three
  who-said-what questions, and five questions the brain must refuse because the
  right answer does not exist anywhere in your documents.
- You write every question from memory, BEFORE retrieval runs, so the wording
  cannot borrow from the document that will answer it and flatter the score.
- After each question, the brain's own retrieval shows what it found and you
  confirm which documents are the right evidence — no hand-editing JSON, no
  hunting for references. Drive evidence is recorded by stable file identity,
  so the set keeps working after a re-index.
- Each unanswerable question is checked live on the spot: the session tells you
  whether the brain refuses it today or invents an answer, which is exactly
  what you want to see before trusting it with something that matters.
- The file saves after every question. An interrupted session loses nothing;
  run `--golden-20` again to fill the remaining slots.
- The session ends by offering to score the set immediately. That first
  scorecard — your brain, judged on your questions — is the handoff artifact.

After updating, run `brain eval <manifest> --golden-20` sitting next to the
person who owns the brain. Existing golden sets and scoring are unchanged.

## 0.1.16

**Large Cloudflare upgrades now trust exact vector identity readback instead of
a rough database change counter, so already-committed batches resume cleanly.**

- D1 change metadata can include the full-text-search trigger work caused by a
  chunk update. That makes it useful for diagnostics, but not an exact receipt
  for how many vector identities reached their desired values.
- The paused upgrade now reads back every chunk-to-vector mapping in each
  1,000-row batch before accepting it. The guarded install-state, outbox, and
  batch transitions keep their strict ownership receipts.
- An interrupted request rechecks the stored mapping before provider visibility
  can confirm the batch. A real partial mapping stays submitted and blocks
  completion instead of becoming a false success.
- Existing schema-13 progress is retained. Re-running the update resumes its
  durable batches without deleting source documents or starting the corpus
  projection over.
- The required 20-minute writer safety pause now says exactly what it is doing,
  tells the owner to keep the window open, and confirms when migration starts.
  A safe paused update no longer looks like a hung installer.

After updating, run `brain status <manifest>`, `brain health <manifest>`, and
`brain test <manifest>`. Status must report schema 13. Health and test must pass
with zero pending or submitted vector work, exact expected and actual vector
counts, and a query-ready semantic index before you rely on Brain answers.

## 0.1.15

**Large existing brains can complete an exact Cloudflare upgrade in hours
instead of spending days on serialized 99-vector mutations.**

- Legacy vectors are rebuilt in durable 1,000-row batches while the Worker is
  in its verified paused mode. Several disjoint batches may be in flight, but
  no batch is acknowledged until every vector reads back with the exact D1
  generation that produced it.
- Batch identity, provider mutation receipt, submitted count, and confirmed
  count are stored in D1. An interrupted update resumes those receipts instead
  of repeating completed vectors or trusting a local progress file.
- The ordinary cron and manual drain keep their stricter one-writer path for
  overlapping updates and deletes. The faster protocol exists only inside the
  paused, quiesced whole-corpus upgrade boundary.
- The scale gate came from a large field upgrade: the previous exact path was
  safe but moved only about 120 to 180 vectors per minute. This release
  keeps the exact readback proof and removes that serialization bottleneck for
  every install.

After updating, run `brain health <manifest>` and `brain test <manifest>`.
Both must report schema 13, zero pending or submitted vector work, exact
expected and actual vector counts, and a query-ready semantic index before you
rely on Brain answers.

## 0.1.14

**Current-status answers now fail closed on stale or wrong-authority evidence,
and complete message replays prove the exact source and target before they can
report success.**

- Explicit current questions rank the newest reliable evidence for the named
  subject without allowing another named person, the brain owner, or an
  unverified file date to take its place. Historically bounded questions stay
  historical even when they contain words such as “latest” or “current.”
- Billing and subscription systems can establish invoice, account, and
  subscription state, but they cannot establish an ongoing client relationship.
  Mixed claims are checked clause by clause and unsupported relationship claims
  are refused.
- Hybrid retrieval now preserves both the keyword and semantic passages that
  caused a document to rank, including relevant text late in a long chunk.
- Full message replay reconciles exact logical families, removes obsolete split
  parts and refused legacy copies, recounts live physical documents, and checks
  the frozen source again immediately before every completion path. A backfilled
  historical row blocks completion instead of being silently missed.
- A recorded message replay is sealed. Re-running it cannot reconcile away
  newer delta documents, and crash recovery validates saved completion
  accounting before any target cleanup.
- D1 vector work now has a monotonic generation, an exclusive expiring writer
  lease, and durable asynchronous mutation receipts. Cron, manual drain, and
  forget cannot race an older Vectorize write into a newer state.
- Provider acceptance is no longer reported as semantic completion. Drain
  confirms the processed mutation and exact vector generation or deletion
  before clearing its outbox row. Health, acceptance, message replay, and live
  retrieval all disclose or fail on a partial projection, even when Vectorize
  already returns some candidates.
- D1 batch ingest now uses 53 binding round trips for the normal maximum
  50-document, one-chunk request while preserving one receipt and isolated
  failure per document. Its 352 SQL statements are counted separately, and a
  conservative pre-write query budget refuses oversized multi-chunk requests
  before they can create partial no-progress revisions.
- Updates deploy a verified full corpus-write barrier, wait for older
  invocations, apply restart-safe migrations, deploy and verify active mode,
  then resume the bounded legacy-vector bootstrap before exact health and
  acceptance. Recovery exports normalize
  invocation-local lease and projection fields instead of persisting them as
  corpus state.
- A setup interrupted during its first migration now stops before another D1
  write when database freshness cannot be proven. It prints the verified
  paused-writer update and setup-rerun commands instead of guessing that no
  renamed Worker can still use the database.
- Keychain-backed setup and update keep their immutable execution copy in an
  owner-only OS temporary directory, outside synced manifest folders. The
  original manifest remains fingerprint-pinned, no credential value is copied,
  and the temporary file and directory are removed after the lifecycle run.
- A D1 rollback deliberately leaves the Worker paused. Provider-only vectors
  written after the bookmark cannot be enumerated by reindex, so supervised
  recovery must recreate/rebind a clean Vectorize index and all metadata
  indexes before reindex, drain, health, and test can return the Brain to use.

After updating, run `brain health <manifest>` and `brain test <manifest>`. Both
must report the semantic index query-ready with zero pending/submitted vector
work and exact expected/actual vector counts before you rely on Brain answers.

## 0.1.13

**Repeated evidence no longer crowds out real results, migrations resume
safely, recovery drills fail closed, and authenticated Brain requests now
refuse redirects.**

- Exact copies collapse only during retrieval when their source, date, and
  content match. Stored documents remain untouched, so the behavior is
  reversible and source evidence is preserved.
- A strongly isolated keyword result now receives a bounded hybrid-search
  boost, so an exact record number or rare marker cannot disappear beneath
  generic semantic matches. Ordinary keyword noise is not promoted, result
  scores remain ordered, and the D1 backend now honors the documented RRF
  tuning value.
- Resumable message migration freezes its source boundary, records exact batch
  receipts, locks concurrent runs, and refuses an ambiguous owner label or
  timezone before creating a new checkpoint.
- Setup remembers only the owner-private manifest location, so future
  `brain update` runs work after Terminal is reopened and from any folder. An
  older or custom install remembers its location only after a successful
  verified upgrade, and unsafe saved pointers fail closed.
- Private corpus contracts and deterministic answer canaries now test promised
  source-family coverage, literal values, numbers, dates, and inline citations.
  Their sanitized artifacts report coverage without storing questions,
  answers, filenames, paths, or private identifiers.
- Recovery field-drill tooling now orchestrates export, isolated D1 restore,
  Vectorize rebuild, readback, health, and release evaluation behind six
  explicit approvals, including the exact private evaluation suite. A
  disposable real-Cloudflare drill remains required
  before calling production recovery verified.
- Every packaged client that sends the Brain admin key now requires HTTPS
  outside loopback, refuses redirects, and verifies the final origin.
- Credential help uses hidden prompts, durable per-install storage, or an
  approved secret manager. Public instructions no longer teach owners to paste
  administrative keys or Cloudflare tokens into shell commands.
- Private Stripe invoice, Checkout, and Billing Portal links are replaced with
  a fixed marker before storage while the surrounding billing conversation
  remains searchable. Public reusable Payment Links remain intact. The v4
  safety marker forces existing source documents to be checked again, and an
  older message-migration checkpoint requires an explicit reviewed reset.
- An oversized Drive cleanup now says `review required` instead of reporting an
  installer bug. It still removes nothing and withholds the Drive cursor until
  the owner approves the exact aggregate plan.
- Release automation pins third-party GitHub Actions to reviewed commit hashes,
  and package tests inspect the real tarball for private material.

## 0.1.12

**Large imports are faster, concurrent updates fail closed, and release checks
now prove that the private test suite covers the promised risk areas.**

- A 50-document D1 batch now performs one identity preflight and one source
  statistics refresh instead of repeating full source work for every document.
  The same request structure dropped from 350 remote D1 calls to 203 in the
  deterministic integration test, while an unchanged 50-document retry drops
  to one read-only D1 batch.
- Every changed revision owns a unique pending marker. Chunk replacement,
  vector outbox writes, source statistics, and the final content-hash commit
  are bound to that marker, so a stale concurrent request cannot report another
  request's successful write as its own.
- Curated dual-target sync tooling now verifies the complete transformed
  envelope, the unchanged raw source bytes, exact target receipts, target
  readback, and an owner-only coverage ledger before it reports success.
  Historical raw copies are evidence only and are never deletion eligible.
- The curated scheduler uses a single-instance lock, a credential-free child
  environment, configuration fingerprints, aggregate freshness receipts, and
  private local support events. Installing or replacing a live schedule remains
  an explicit supervised operation.
- `brain eval --profile release` now requires at least 60 labeled private cases,
  explicit domain, format, risk, and query-kind coverage, and five cases in each
  declared slice. Every release unanswerable case must run and pass. Small suites
  remain useful under the clearly labeled diagnostic `smoke` profile.

## 0.1.11

**A Drive refresh now stops before an unexpectedly large cleanup can remove
material from the brain.**

- Source policy exclusions, Drive deletions, and files newly refused by quality
  or credential checks are compared with the live stored-document inventory and
  combined into one deterministic removal plan.
- A plan above 100 documents or above 10% of the stored Drive corpus stops
  before planned deletion and before its source cursor advances.
- The stopped run shows only aggregate category counts and an opaque plan
  fingerprint. It never prints filenames or document IDs. Re-running with the
  exact `--approve-removals <fingerprint>` value approves only that exact plan;
  any change requires a new review.
- Failed or interrupted removals return through the same aggregate gate on the
  next run, so a retry cannot bypass the protection.
- Cloudflare prerequisite copy now states the current platform truth: Free can
  create Vectorize, while Workers Paid remains the supported production
  baseline because Free has prototype-scale vector, daily-write, and CPU limits.

## 0.1.10

**Credentials now stay in the storage chosen by each install, and failures
leave private issue notes that can be reviewed without exposing client data.**

- Standard macOS setup declares and verifies a login Keychain location before
  generating the brain admin key. Windows adjacent admin keys and Google OAuth
  records use DPAPI CurrentUser encryption. Linux keeps owner-only local files.
- `brain secrets` treats durable local storage as desired state, verifies it
  before changing the Worker, and can safely retry an interrupted rotation.
  Standard D1 and Workers AI installs ignore unrelated Supabase and Anthropic
  credentials that happen to exist in the operator's shell. Setup, secrets,
  and upgrade remove older provider-secret bindings that the manifest does not
  allow, verify the removal, and leave every unrecognized secret name alone.
- Claude Code and Codex registrations carry only the manifest location. Their
  runtime resolves the current admin key from the install's declared durable
  store, so a key rotation does not leave stale credentials in tool config.
- Required health, verification, drain, reindex, report, deploy-schedule, and
  secret failures now exit nonzero so automation cannot mistake them for a
  successful install.
- Recognized command failures attempt to leave one private, sanitized local
  issue note. `brain support` previews, exports, or clears the bounded journal.
  The installer does not upload it, and the schema cannot store content,
  filenames, paths, account details, raw errors, logs, stack traces, or secrets.
- Existing private installer directories are tightened automatically on POSIX.
  Adjacent key writes refuse unsafe ownership, links, hard links, loose modes,
  and any `.brain-admin-key` file already tracked by Git.
- Google authentication helpers, scheduled Drive refresh, eval, Cloudflare
  probes, and AI-tool registration children receive narrowly allowlisted
  environments instead of inheriting unrelated desktop credentials.
- `brain setup` and the new `brain update` can ask for the scoped Cloudflare
  token in a no-echo terminal prompt. The token exists only for that command.
  It is not written to the environment, arguments, manifest, logs, or issue
  journal.
- `brain update` now requires a D1 restore bookmark before any mutation, checks
  the exact Worker version, runs the full acceptance suite, reads the committed
  D1 version back, and only then atomically advances the local manifest.
- Evaluation now blocks on every repeat of every critical retrieval and
  unsupported-question case. Owner-local artifacts use opaque case IDs,
  owner-only files, provenance hashes, and no raw questions, paths, titles, or
  target URLs.

## 0.1.9

**Google Drive can now stay current on its own on a Mac, using the same setup
for every client.**

- `brain schedule <manifest> --install` installs the per-user Drive refresh
  declared by `operations.ingest_cron`, daily by default. Local status reports
  installation, active runs, definition drift, and the last launchd exit.
  `brain sources` reports Worker-side freshness.
- Routine refresh has no Cloudflare deployment credential. Google OAuth uses
  macOS Keychain by default; the brain admin key uses Keychain when its manifest
  declares a locator, with an owner-only adjacent file as the standard fallback.
  The LaunchAgent definition contains no secrets and receives a minimal environment.
- A first Drive load now streams bounded batches instead of keeping the corpus
  in memory. Successful batches are resumable, and a failed file or API call
  cannot advance the Drive cursor past material that was not safely stored.
- Refresh health now distinguishes a live sync, a failed sync, and a run stuck
  for more than six hours. Failed attempts do not overwrite the last successful
  ingest time.
- Large files remain one logical source document even when stored as several
  physical parts. Edits clean up obsolete parts only after every replacement
  part has landed.
- Exclusions now remove material that was indexed before the rule existed.
  Policy edits force a complete comparison, folder moves are re-evaluated with
  their descendants, and a weekly full sweep catches deleted or inaccessible
  files that no longer appear in the change feed.
- A full Drive comparison refuses to delete from an incomplete Google listing.
  Credential scanning runs on the complete logical file before splitting, and
  a scanner upgrade rechecks unchanged files before it is marked complete.
- An interrupted database write stays retryable until its chunks are complete.
  A document cannot be marked unchanged merely because its row was written
  before a later chunk write failed.
- A successful Mac scheduler install sets the source freshness expectation.
  Removal clears it when the Worker is reachable and warns when that remote
  cleanup remains outstanding.
- Recognized command failures now attempt to leave a private, sanitized local
  issue note when its local journal is writable. Notes can be reviewed or
  exported with `brain support`; nothing is sent automatically, and the journal
  cannot store content, filenames, paths, account details, logs, stack traces,
  or credentials.
- A scheduled ingest now exits as failed when even one stored ingest part has a
  true storage failure, after saving its retry state. Credential refusals remain
  a successful safety outcome.
- Scheduler logs are owner-only and cut back to a 5 MiB tail with two retained
  histories after each lock-owning child exits. A currently running noisy
  process can exceed that cap until it exits, and stale-run monitoring remains
  the guard for a hung run.

On macOS, Google credentials default to the login Keychain. Other platforms
retain the atomic owner-only credential-file fallback. Windows and Linux still
need a platform scheduler before unattended Drive refresh can be installed.

## 0.1.8

**Keyword search gets roughly twice as fast on a large brain, and the gain grows
with the corpus.**

Asking a question in plain English sent every word of it to the search index,
including "what", "did", "we", "say" and "about". Those words appear in almost
every document, so the index had to walk almost the whole corpus for each one,
while contributing nothing to which result ranks first.

Measured on a 900,000 chunk brain:

| | |
|---|---|
| a question as it was searched before | 2,123 ms |
| the same question, filler words dropped | 1,070 ms |

**On a small brain this was invisible**, which is why it went unnoticed. It grows
with your corpus, and it shows up as the brain feeling slow rather than as
anything reporting a problem.

Words you might actually be searching for are never dropped. "Tax", "account",
"pay", "cost", "deposit", "trust" and the like are kept, however common they are.
A question made entirely of filler still searches on the whole thing rather than
returning nothing.

## 0.1.7

**`brain eval <manifest>`** — score your brain on your own questions.

- **`brain eval <manifest> --init`** writes a question-set template. You fill it
  in with questions about your own material. There is deliberately no generic
  test: a score against someone else's questions tells you nothing about your
  brain.
- **Include questions you know it cannot answer.** The template asks for four or
  five, and they are the most valuable entries in the file. Anyone can show a
  brain finding something. A brain that declines a question it genuinely cannot
  answer is what makes the rest of its answers worth believing.
- Write the questions before you look at your files. A question written while
  reading a document borrows that document's wording, and the brain then finds it
  by matching words rather than meaning, which flatters the score.
- `--repeat 3` runs the same test several times and reports how much it varies,
  so you know whether a small change is real.

**These commands no longer need a Cloudflare token when your brain has a
domain:** `eval`, `diagnose`, `drain`, `reindex` and `health`. They talk to your
brain over HTTPS with your own admin key. That matters at handoff: the commands
that prove your brain works have to keep working after our access is revoked, or
they are proving the wrong thing.

## 0.1.6

**`brain diagnose <manifest>`** — run this after a load. It answers three
questions that nothing else answered:

- **Is anything missing?** Documents that were indexed but hold no text, which is
  almost always a scanned PDF. Sources registered but never loaded. Documents
  that no source owns, which means they cannot be removed later.
- **Is it stored correctly?** Above all, it compares the number of chunks in your
  brain against the number actually in the search index. **Nothing compared those
  two numbers before**, and that single comparison would have caught the one
  serious failure this product has had, on the day it happened rather than a week
  later.
- **Is it stored well?** One spreadsheet that has become most of your corpus. Text
  long enough to be silently cut before it is indexed. The same document loaded
  twice under two names.

Every finding says what it means and what to do about it. The point is that all
of these are invisible to an ordinary health check: the brain reports itself well
and is quietly incomplete, and the client concludes the product is mediocre
rather than that something broke.

## 0.1.5

Two fixes from the second field report, and the first one matters.

- **`brain upgrade` was checking the wrong worker.** After deploying, it asked
  the brain whether it was healthy and accepted the first answer it got. But
  Cloudflare keeps serving the previous version for a few seconds, so the check
  was reading the build being replaced and reporting the new one as verified. It
  now waits until the version actually answering is the one it just shipped, and
  says plainly if that never happens. Nothing was ever harmed by this, but a
  broken upgrade could have passed it.
- **The stalled-embedding warning now tells you what to run.** It used to send
  you to the Cloudflare dashboard to read a schedule. It now says
  `brain drain <manifest>`, which is the actual fix, and mentions the dashboard
  only if the problem comes back.

## 0.1.4

The brain now knows how current it is, and says so.

- **Answers tell you when the brain has not looked recently.** There is a
  difference between "the newest thing I found is 40 days old" and "I have not
  read that source since July, so there may be material I have never seen." The
  second one was invisible before, because a source nobody re-reads looks exactly
  like a source with nothing new in it. Now it appears with the answer, next to
  the citations, at the moment it changes what you should believe.
- **`brain sources` shows freshness per source,** and distinguishes three things
  that used to look the same: a source that is genuinely behind, a source that
  could refresh on its own but has no schedule, and a source loaded by hand from
  a machine we cannot reach.
- **Set the expectation with** `brain sources <manifest> --source <name>
  --refresh <hourly|daily|weekly|monthly|never>`. A source with no expectation is
  **never** reported as stale. That is deliberate: a one-off folder load is not
  stale, it is finished, and a warning that fires every day for something nobody
  can act on teaches you to ignore the warning that matters.
- Being late is not being broken. A daily source six hours overdue says nothing.

## 0.1.3

One new command, and it is the one that gets you out of trouble.

- **`brain reindex <manifest>`** rebuilds the search index from your own brain,
  without needing the original documents. Your text lives in the brain's
  database, so the index can always be rebuilt from it. That covers every way
  the two can drift apart: a restore that rolled back one and not the other, a
  setting that only applies to documents added after it, or an index that is
  simply lost. It previews first and changes nothing until you add `--yes`, and
  it never deletes anything.

**If your source filtering has ever looked wrong,** this is the fix, and you do
not need the original folder to run it.

## 0.1.2

The rest of the findings from the first Windows install, plus one thing that
turned out to be worse than reported.

- **Provisioning could adopt a database that was not ours.** The default name
  was the generic `brain`, and an existing database of that name was adopted
  rather than refused. On an account that already had one, the install would
  have run its migrations into somebody else's data and relabelled it. It now
  refuses anything it cannot prove is empty or already this client's brain, and
  the generic name is gone entirely.
- **A missing metadata index silently broke source filtering, permanently.**
  Measured against Vectorize on 2026-08-18: a document embedded before that
  index exists can never be filtered by source afterwards, even though it is
  present and answers ordinary searches. Provisioning used to warn and carry on.
  It now retries and then stops, because there is no repair except loading
  everything again.
- **Embedding is far faster.** Chunks were embedded one at a time, roughly 1,200
  an hour, so a small folder took most of an hour to become searchable by
  meaning. They are now embedded in groups.
- **The install stopped saying "a few minutes".** After loading, you get the
  real number of chunks still queued, and `brain drain <manifest>` finishes them
  now with a live estimate instead of leaving it to the schedule. "Your brain is
  live" now says plainly when meaning-based search is still catching up.
- **The admin key is treated as the secret it is.** It is refused into system
  directories, flagged in synced folders like OneDrive or Dropbox, added to
  `.gitignore` inside a repository, permission-restricted on Windows as well as
  Mac and Linux, and announced as a secret rather than as a note.
- **A flag typed without its value now says so.** `--path` with nothing after it
  used to report "no such folder: true", and `--limit` silently loaded nothing.
- **Setup no longer sends you to add a Cloudflare permission that may do
  nothing.** Vectorize is reached through `wrangler login`, and that is now the
  only thing any part of the tool tells you to do.

**Worth checking after you update:** run `brain drain <manifest>` once. If your
backlog had stalled, this clears it and tells you how long it will take.

## 0.1.1

Fixes from the first real Windows install. If you are on 0.1.0, update.

- **The worker deploy failed on every Windows machine.** Module names were built
  with Windows path separators, so the worker could not find its own files.
- **A long filename could silently stop all embedding.** Vector ids are capped
  at 64 bytes and were built from the document path, so one deeply-nested file
  could stall the queue behind it. Everything still reported healthy: the only
  sign was a backlog that stopped going down. Long ids are now shortened
  safely, and one unreadable chunk no longer blocks the rest.
- **`--dry-run` no longer asks for credentials** it never uses. Previewing what
  would load now works with nothing set up.
- **The safety scanner was wrong in both directions.** It refused documents that
  merely mentioned a key name, and let a real key through. Both fixed.

**Worth checking after you update:** run `brain health` and confirm the backlog
reaches zero. If it had stalled, it will now clear on its own.

## 0.1.0

The first install.

- **One command.** `brain setup` creates everything in your own Cloudflare
  account, then connects your brain to Claude Code and Codex.
- **Load a folder.** 21 formats including PDF, Word, Excel, PowerPoint and
  email. Anything it cannot read is reported with a reason rather than silently
  skipped, so you always know what your brain does not have.
- **Answers with citations, and honest gaps.** Every answer says which of your
  documents it came from, and says plainly when your documents do not contain
  the answer.
- **Scanned PDFs are refused, not faked.** A scan has no text in it. Rather than
  index an empty document and pretend, it tells you the file needs OCR.
- **Undo.** `brain forget --source <name>` removes everything a load brought in.
  It shows you what would go before it goes.
- **Nothing of yours leaves your accounts.** Your documents, your search index
  and your keys all live in your own Cloudflare account.

**Worth checking after you install:** ask it something only your own documents
would know, then ask it something they definitely do not cover. The second
answer matters as much as the first.
