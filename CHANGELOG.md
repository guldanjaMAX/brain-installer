# What's new

Read by `brain whatsnew`, so a client sees this in their terminal rather than
having to be told. Newest first. Each entry is written for the person who OWNS
the brain, not for whoever built it: what changed for them, and what to check.

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
