# What's new

Read by `brain whatsnew`, so a client sees this in their terminal rather than
having to be told. Newest first. Each entry is written for the person who OWNS
the brain, not for whoever built it: what changed for them, and what to check.

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
