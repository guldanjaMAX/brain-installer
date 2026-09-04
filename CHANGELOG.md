# What's new

Read by `brain whatsnew`, so a client sees this in their terminal rather than
having to be told. Newest first. Each entry is written for the person who OWNS
the brain, not for whoever built it: what changed for them, and what to check.

## 0.3.6 (unreleased)

- An update refuses a brain whose database schema is ahead of the release,
  naming both numbers. The version guard compared version strings only, and a
  brain built from a working branch records a lower string while running a
  higher schema, so the one number that mattered was the one nothing looked at.
- An answer the verifier judged supported but incomplete no longer collapses to
  "The documents do not answer the question." The sentences whose citations were
  approved are kept, one line names what the documents did not cover, and the
  answer is marked partial and scored ten points lower. A refusal that is still
  a refusal is unchanged, word for word. Three of the four confidently wrong or
  missing answers found in the 2026-09-03 triage were this shape.
- A refusal now says why. `brain ask` prints the verifier's reason under the
  trust line, and the MCP server carries the confidence, the gate reason and the
  documents it did find, so "I found four documents and could not write a
  supported answer from them" stops reading as "nothing recorded".
- `/health` reports `schema_version`. Whether a brain may take a published
  update is decided by that integer, and until now it could only be read by
  standing at the owner's machine. A fleet is now checkable from one place. The
  field is omitted rather than guessed when the database cannot answer.

## 0.3.5

- The index rebuild during an update no longer gives up two minutes after it
  starts. On a real backlog the first confirmation from the index can take
  longer than that, and the rule that ended the wait only counted
  confirmations. A scale rehearsal (2,544 waiting rows) on 0.3.4 stopped with
  "stayed unconfirmed for 8 consecutive rounds" and left the brain paused.
  Any counter moving now keeps the wait alive, and it ends only after fifteen
  minutes with no movement at all, inside the six-hour limit that already
  bounds the phase. The waiting line prints what is submitted and in flight.
- A brain that loaded a lot before updating no longer spends the update
  pushing its waiting rows through the index one hundred at a time. Queued
  upserts are handed to the bulk rebuild, which re-embeds every chunk in
  provider-sized batches; only deletions still go one by one, first. On a
  brain with 205,791 waiting rows that is about two hours instead of a day,
  and the brain accepts new material again as soon as it finishes.
- One interrupted poll during the rebuild no longer ends the update. The
  request is retried eight times with backoff inside the movement budget.
- An acceptance run that never asked the brain a question no longer reads as a
  plain green. The headline itself says retrieval was not tested, and the
  report says so too, because "passed" is the sentence that gets read aloud.
- `brain connect google` names which Google account actually consented, so a
  client who signs in with the wrong one finds out immediately rather than
  after a load returns somebody else's documents.
- The golden-20 session no longer implies a document is missing while the
  index is still loading. It reads the backlog once at the start, says so, and
  an empty result during a rebuild says "very likely too early" instead of
  "absent". Recognised message exports are named at the end of an ingest.
- Three prompts in the golden-20 session could discard or corrupt the owner's
  just-written work: an unrecognised keystroke fell through to discard, a bare
  Enter on the title did the same, and a free-text source wrote a broken file.
  Each now confirms, defaults to keeping the work, and validates the source.
- A setup or update that cannot read the database now says why, on install day
  as much as on update day: a fresh `brain setup` stopped at the same live-check
  with no reason attached, and the cause was only recoverable by editing the
  installer. The five preflight reads used to report only that they could not verify the brain,
  discarding the provider's message, so an account that had hit Cloudflare's
  daily D1 limit produced a line nobody could act on. The cause is quoted, and
  a quota refusal names whose limit it is, when it resets, and that nothing was
  changed.
- `brain schedule` on Windows or Linux now says plainly that the installer
  does not create the automatic refresh there yet, that everything else
  works, and prints the scheduled-task or cron recipe to use instead. It used
  to stop with "unexpected error, this is a bug in the installer", which one
  Windows owner read as the whole system being Apple-only.

## 0.3.4

**Your brain cannot get quietly stuck any more, and updates stop making you wait.**

- Your brain hands new material to its search index in batches and waits for
  the index to confirm each one. In some cases that confirmation could never
  arrive, so new material kept queueing and stayed only partly searchable while
  every health check said fine. Your brain kept working the whole time and
  nothing was lost. It now recognises that its batch has been processed even
  when the confirmation marker has moved past it, and it says so in its log
  when it is waiting. If your brain was paused this way, this update clears it
  on its own.
- An update used to pause your brain for a fixed twenty minutes while older
  writes finished, even when there were none. It now checks, and on a quiet
  brain the pause ends in under a minute. A busy brain still gets the full
  twenty, and the screen says which.
- An update used to report itself failed when one of your sources had simply
  not refreshed lately, for example a Google connection that lapsed. That is
  about the source, not the update: it now completes, records the new version,
  and tells you which source needs attention.
- Running `brain setup` again on a brain that is already installed used to
  pause it. Setup now checks first: on this release it goes straight to keys
  and health, and on a different release it points you at `brain update`.
- A first install is no longer turned away for not having a manifest yet;
  setup creates it, as it was always meant to.
- The drain schedule is only added if it is missing, and if your Cloudflare
  plan is not Workers Paid the message says so plainly: everything else is
  already in place and upgrading the plan then running the same command again
  finishes it. `brain doctor` now shows a Workers plan line before install.
- `brain deploy`, `provision`, `status` and `sources` use the same sign-in
  your setup and update use, so a message that tells you to run one of them
  no longer sends you somewhere that cannot sign in.
- `brain tools` puts the `brain` command on your PATH for new terminals, so it
  is still there tomorrow. `brain doctor` prints every check it runs, not just
  the first three. `brain test` says when it could not exercise retrieval
  because the manifest has no probe questions yet.

- A brain update no longer stops when the index has accepted a vector it has
  not yet made visible. The update waits for it, within the same time limit it
  already had, and stops only if nothing confirms across eight polls. Two real
  0.2.0 to 0.3.4 updates had ended with "failed aggregate operation(s)" while
  the Worker finished the job on its own a minute later. The receipt now also
  names that count `retrying`.
- The final check "deployed version matches the manifest" now reads the live
  Worker version against the update target instead of comparing two values
  captured before the update, which had certified a stale pair.

- A `wrangler login` session that expires partway through a setup or update
  is renewed once and the interrupted request repeated, instead of stopping
  with "Invalid access token" worded as if the owner had typed a bad token.
  When renewal does not help, the message now says the session expired and
  to run `npx wrangler@4 login` before re-running the same command.

## 0.3.3

**Connect your assistants with one command, instead of copying one.**

```
brain mcp-config <manifest> --apply
```

- It registers your brain with Claude Code and Codex, whichever are installed,
  and checks afterwards that what was written matches exactly. Setup already did
  this at the end of an install; this is the same thing on its own, for a brain
  you already have or an assistant you installed later.
- Without `--apply` it still just prints the commands, unchanged.
- If one assistant cannot be connected it says which, and leaves nothing half
  written.

## 0.3.2

**Setup waits for Cloudflare instead of giving up on it.**

- Creating your search index involves several filters, and how long Cloudflare
  takes to switch each one on is not predictable. The old limit was 90 seconds,
  and on two rehearsals out of three Cloudflare took longer, which stopped a
  perfectly good install at step three of six. It now waits up to five minutes
  and tells you it is still waiting, so a slow minute does not look like a
  freeze.
- The rule underneath has not changed and will not: your brain is never loaded
  into a search index whose filters are not ready yet, because a filter only
  applies to what is added after it exists.

## 0.3.1

**The guide now installs for Codex as well as Claude Code.**

- `brain tools` writes the technician skill into both `~/.claude/skills` and
  `~/.codex/skills`. They use the identical format, so it is one reviewed file
  in two places. Whichever assistant you open, `/financial-brain-technician`
  is there.
- If one of them cannot be written, the other still is, and the one that failed
  is named rather than silently skipped.

## 0.3.0

**Sign in with your browser. No token to create, and nothing to paste.**

- Run `npx wrangler@4 login` once, click Allow, and every command works. No API
  token page, no picking a template, no remembering that the template leaves out
  the database, no Zone Resources, no sixty-character paste into a hidden prompt.
  On the first live install that step took three attempts and about 25 minutes.
- Because nothing has to be typed in secret, setup no longer needs a real
  terminal. It runs anywhere, including inside an assistant session.
- Your brain tells you which sign-in it used, every run. Signing in as the wrong
  person is how work lands in the wrong account, and it is silent when it happens.
- Prefer the narrow four-permission token instead? Nothing changed for you, and
  `BRAIN_NO_WRANGLER_LOGIN=1` turns the browser path off entirely.
- **A working sign-in is no longer reported as broken.** The check only
  recognised one kind of credential and failed a browser or account-scoped
  sign-in as "Invalid API Token", stopping an install before anything was made.
- When a machine check stops setup, it only suggests `brain init` if you really
  have no manifest yet, instead of sending you to fix something that is fine.

## 0.2.3

**`brain init` asks its questions again.**

- 0.2.2's `brain init` worked when given `--name`, `--slug` and `--account`,
  and stopped with "prompt is not defined" the moment it had to ask you
  anything, which is exactly the fresh install it was written for. It now
  resolves its own asker the way every other command does.
- A typo like `--nmae` is refused and suggests the right flag, instead of being
  ignored while the run continues.
- The test suite now answers the questions rather than only passing the flags,
  because the flags were what hid this.

## 0.2.2

**A stopped install no longer leaves you with nothing.**

- `brain init <path>` writes your manifest and stops. It needs no network, no
  Cloudflare token, and no passing machine checks. Setup runs its checks first
  and exits if one fails, so before this an install that stopped early had no
  manifest at all, and every command afterwards asked for the file that was
  never written. If setup stops on you, run `brain init`, then run setup again
  and it carries on from there.
- `--name`, `--slug` and `--account` make it ask nothing, so your manifest can
  be prepared before the call rather than during it.
- The message setup prints when a machine check fails now tells you this.
- Your bank feed's settings now actually reach your brain. Before this, a brain
  could be set up for a bank connection, pass every check, and still report the
  feed as unconfigured, because the settings were never sent to it.

## 0.2.0

**Your brain now has an owner workspace, scoped sharing, and financial actions,
without weakening the ingestion and deletion rules underneath them.**

- A new `brain technician` guide turns install day into seven reviewed steps for
  Claude Code and Wrangler, Cloudflare, Google, Zoom, IMAP, the first passkey,
  and final verification.
  Its plan is safe for a local coding agent to read, but tokens and secrets stay
  in hidden terminal prompts and the owner still handles login, 2FA, consent,
  billing, and the physical passkey gesture. From a source checkout,
  `npm run rehearse:onboarding` opens the real owner workspace with synthetic
  data so every important screen can be tried before any account is connected.
- Every private installer issue code now has a calm recovery guide through
  `brain support --explain <code>`, with matching JSON for a local coding
  assistant. A new offline `npm run rehearse:hiccups` lane deliberately tries
  interrupted setup, missing folders, partial sources, lost responses,
  migrations, search backlogs, access boundaries, and technician recovery, then
  names the real-world field gate still required.
- Owners can sign in with a passkey, upload a text document, record an approval,
  accept or reopen a period close, review append-only activity, and maintain
  targets and preferences. Retrying the same action after a lost response does
  not duplicate the change or its activity event.
- Explore can be locked to one owned business entity. Invited people can be
  granted up to 100 exact documents, and new documents are owner-only by
  default. Missing or unavailable authorization fails closed rather than
  appearing as an empty answer.
- Bank exports and hosted-feed rows share one normalized ledger boundary, and
  every imported row retains source-document provenance. OCR for scanned PDFs
  is built but remains off by default and explicitly marks low-confidence text.
- A read-only IMAP connector now covers non-Gmail mailboxes using provider app
  passwords stored in the owner's protected credential store. Facebook
  Messenger has a credential-free JSON export parser through the watched-folder
  and Drive paths. Both remain real-account acceptance gates.
- Install-day checks now verify the Cloudflare token instead of trusting that a
  value exists, open the stored Google credential instead of trusting its file
  header, refuse the shared Vectorize placeholder name, skip R2 when it was not
  requested, and tolerate the short route and secret warm-up after a fresh
  deploy. `brain setup --no-connect` leaves the operator's AI-tool settings
  untouched when installing on someone else's behalf.
- Owner installs now require a signed-in Claude Code CLI and a runnable pinned
  Wrangler 4 before Cloudflare work starts. `brain tools` adds Anthropic's
  interactive installation doctor to those automated checks. It also installs
  and reads back a personal `/financial-brain-technician` skill, which turns the
  reviewed release packet and read-only technician plan into a reusable Claude
  prompt without placing a credential in Claude's context. Successful Claude
  wiring also writes an owner-only `CLAUDE.md` beside the manifest with exact
  Brain commands, approved-folder discovery rules, and explicit refusal of
  permission bypass, whole-drive crawling, credential copying, or unapproved
  direct Cloudflare mutations. An unrelated existing `CLAUDE.md` is preserved.
- WhatsApp guidance now separates the safer per-chat export from the unofficial
  paired-device connector, states the account restriction risk clearly, and
  identifies Meta's official Business Platform as a separate connector that is
  not built yet.
- The vector drain now runs every minute by default. It still embeds only after
  the previous batch is confirmed, so extra ticks are no-ops rather than extra
  model work.

The complete offline release suite exercises these contracts on synthetic and
scripted boundaries. It does not prove a real customer corpus, a physical
passkey on the final domain, or any provider connector that has not completed
its named field gate. Run `brain doctor`, then use the weekend acceptance guide
before calling an install production-ready.

## 0.1.23

**A new brain becomes searchable in about a day instead of about four.**

After a first load, chunks live in the database immediately and become
searchable only once they reach the vector index. Until then the brain answers
keyword questions and quietly misses the ones that need meaning, while every
health check passes and nothing on any screen says why.

That drain advances roughly one batch per confirmation from the vector index,
not per scheduled run, so how often it runs sets the ceiling. It was running
every five minutes. On a real install that sustained about 20 items a minute,
which is more than four days for a first load of 125,000 chunks. It now runs
every minute, which measured at about 59.

This does not cost more. A run that arrives before the index has confirmed the
previous batch returns immediately having done nothing, so the extra runs are
free and the work per confirmation is unchanged. What changes is only how long
a new install spends looking empty.

`brain health` reads the remaining backlog if you want to watch it.

## 0.1.22

**Your brain can now read your texts — live, if you have a Mac.**

Until now, messages only entered your brain as exports: WhatsApp's
per-chat .txt, or Android's SMS backup file. This release adds the first
LIVE message connector, for iMessage, and it is worth being precise about
what that means.

- New: `brain connect imessage <manifest>` on a Mac. It first verifies the
  one macOS permission this needs (Full Disk Access for the exact program
  that reads the Messages database) by actually reading the database — if
  the grant is missing it prints the exact steps and installs nothing,
  rather than installing something that fails silently every minute. Then
  it loads your full message history in front of you, with counts, and
  only then schedules ongoing capture.
- Ongoing capture is a short scheduled pass about once a minute, not an
  always-running program. A new text appears in your brain within about a
  minute. A sleeping or closed Mac captures nothing until it wakes, and
  `brain sources` will say so honestly instead of pretending freshness.
- SMS text messages ride in alongside iMessage when your iPhone's Text
  Message Forwarding is on, and are tagged separately so the two stay
  distinguishable.
- Honest limits, stated up front: this requires a Mac, full stop — Apple
  exposes message history nowhere else. People appear as their phone
  number or email, not their Contacts name. Tapbacks and attachment-only
  messages are counted and skipped, so a thread here is thinner than the
  same thread on your phone. Conversations are grouped into bounded
  per-day sessions, the same shape WhatsApp exports produce.
- New: `brain disconnect imessage <manifest>` — the first disconnect
  command in this tool. It stops and removes the capture schedule, saves
  any conversations still in progress so they stay searchable, and leaves
  your already-captured history in the brain. Removing the history too is
  one explicit command: `brain forget <manifest> --source imessage`.
- Everything captured passes the same credential gate as every other
  source: a text containing a live password or API key is refused, named,
  and never stored.

What to check after updating: nothing changes until you run
`brain connect imessage` yourself. If you do, run `brain sources` the next
day and confirm the imessage row is fresh.

## 0.1.21

**A migration whose file changed after it ran can now be reconciled, without
guessing and without touching your schema.**

0.1.20 gave a stuck-mid-upgrade brain a way out with `--repair`/`--rollback`.
That fixes a migration that died partway through. It does NOT fix a
different, rarer problem: an already-applied migration whose FILE bytes
later changed, most commonly from a line-ending change made by a different
git client or editor. `brain migrate` refuses to run anything at all once it
sees that — on purpose, so two installs never silently end up on different
schemas under the same version number — and until now there was no way past
that refusal short of hand-editing the database yourself. Running
`--repair` against this specific problem does not help either: it retries
the same migration step, which hits the identical refusal again.

- New: `brain doctor <manifest>` now also checks every applied migration's
  file against what was recorded when it ran, and fails loudly with the
  exact migration name if any of them no longer match — before you ever run
  `brain update` and get stuck by it.
- New: `brain doctor <manifest> --repair-checksum` shows you precisely what
  changed for each mismatched migration — when it was applied, both
  checksums, and, when the difference really is only line endings, an exact
  confirmation of that (not a guess). It previews with no changes until you
  add `--yes`, at which point it updates only the recorded checksum to match
  your current file. It never re-runs the migration's SQL and never touches
  anything else — the schema is presumably already in the state your file
  describes, and re-running it blindly risks a different kind of damage on
  top of whatever caused the mismatch.
- Migration files are now pinned to LF line endings in `.gitattributes`, so
  this specific cause can't reintroduce itself through git.

## 0.1.20

**A brain stuck mid-upgrade now tells you, and now has a way out.**

- 0.1.19 made a stalled upgrade honest: `/health` reports
  `accepting_documents: false` while paused instead of a false `ok: true`.
  But nothing that reads that field back to a person existed yet — an
  install could sit paused for days with no command saying so. Now
  `brain doctor <manifest>` checks the deployed brain's own live state, not
  only this machine's, and fails loudly with an exact next step if it is
  paused.
- New: `brain doctor <manifest> --repair` diagnoses a stuck upgrade
  precisely — which stage it stopped at, how long ago, and the exact D1
  recovery bookmark captured just before the migration ran — then resumes it
  safely once you add `--yes`. Resuming replays the same verified upgrade
  path (`brain update`), which was already idempotent and restart-safe; this
  just gives the stuck case its own clear entry point instead of leaving you
  to reconstruct "run it again" out of an error message.
- New: `brain doctor <manifest> --rollback` does the same diagnosis, then
  restores D1 to that exact bookmark once you add `--yes` — no more copying
  a bookmark out of a die() message by hand. If no bookmark can be found, it
  refuses rather than guessing.
- Both are previews without `--yes`: they print what they would do and
  change nothing until you confirm.

**Google Calendar is now actually reachable, not just built.** The connector
and its 223 tests have existed since mid-August, but nothing anywhere ever
called it — there was no command to run. Now there is:

```
brain connect google --scopes drive,gmail,calendar
brain ingest <manifest> --from calendar
```

Later runs are incremental through Google's own sync token, and a cancelled
meeting is removed from your index rather than left behind as a stale
document. `--dry-run` previews what would be sent. Same honest boundary as
Gmail: built and tested (223 connector tests, 15 more on the command that
drives it), not yet run against a real calendar.

**WhatsApp and text messages (Android, and Google Voice) are ingestible
now, as exports.** No daemon, no live capture, no third-party app risk:

- WhatsApp's own "Export chat" (`.txt`, choose "without media")
- Android's SMS Backup & Restore app (`.xml`, your whole message history at
  once)
- A Google Voice Takeout (one page per conversation)

Drop any of these in a folder you already `brain ingest --path`; each is
detected automatically by its content and loaded as real conversations, not
one giant wall of text. WhatsApp's export date is written in whatever order
your phone's regional setting uses with no marker saying which ("3/4/26" is
two different days depending on the phone), and that is resolved
automatically from the fact that a chat is chronological — a genuinely
ambiguous export is refused rather than silently mis-dated, and you would
see that refusal named in the skip report. SMS Backup & Restore and Google
Voice both write an exact timestamp, so there is nothing to disambiguate
there, only to read correctly.

Live capture (a message appearing the moment it is sent, not at your next
export) is not part of this. That is real code in my own personal stack for
WhatsApp already, but it carries a ToS gray-area risk worth an explicit
conversation before it is on by default for a client.

The source matrix (`onboarding/07-ingest-source-matrix.md`) and the "update
failed partway through" runbook entry are both updated to match every one
of the above, including an explicit statement that iMessage live capture
requires a Mac in the loop with no way around it, and that Google Meet
transcripts already land in Drive today with no connector needed at all.
**Your brain is now a connector: it appears inside the Claude apps and
ChatGPT, on your phone, with nothing to install.**

- In Claude (Settings, Connectors) or ChatGPT (Settings, Connectors), add a
  custom connector and paste one URL: `https://<your brain's address>/mcp`.
  Your browser opens your brain's own approval page and you approve with
  your passkey — the same face or fingerprint that opens the app.
- What a connector can do is exactly what the app can: ask questions and
  read cited answers with their confidence percentages, search your
  documents, and read one document at a time. It can never add, change, or
  delete anything, whatever happens to its token.
- Connector access is yours to end at any moment: every approval is
  individually revocable, tokens expire on their own after thirty days, and
  Sign out everywhere ends every connector along with every device — one
  revocation story, no special cases.
- No outside login service is involved. The approval flow, the tokens, and
  their storage all live inside your own Cloudflare account, like everything
  else about your brain.
- Also in this release: large ingests no longer stall against the database
  write budget — batches now pack themselves to fit it, found live when a
  two-day catch-up was refused in one over-full call.

After updating, run `brain setup <manifest>` (applies migration 0017), then
`brain mcp-config <manifest>` to see your connector URL and the exact
click-path for each app.

## 0.1.19

**Your brain now has its own app, and your face is the key.**

- Open `https://<your brain's address>/app` on any device: ask a question,
  read the cited answer with its confidence line, no software to install. On
  a phone, add it to the home screen and it behaves like an app.
- Sign-in is a passkey — Face ID, fingerprint, or your device PIN. No
  password exists to forget, phish, or reuse: your device holds the private
  half, and your brain stores only the public half, in your own database.
- Setup is one tap. Whoever operates the install runs
  `brain invite <manifest>` and sends you the link; you open it on your
  phone, tap once, done. Apple and Google sync the passkey to your other
  devices automatically, and a brand-new computer signs in by pointing your
  phone at the QR your browser shows.
- Settings, in the app: every enrolled device with when it was last used,
  rename, revoke (removing the last one is refused so you can never silently
  lock yourself out), and Sign out everywhere.
- The session a passkey earns can read and ask — nothing else. It cannot add
  documents, delete anything, or reach any admin function; those still
  require the operator's keys. A lost phone is a reading credential with an
  expiry, and one tap of Sign out everywhere ends even that.
- Passkeys bind to your brain's exact domain (your own domain or the default
  workers.dev address — your choice at setup). Settle the domain before the
  first invite; changing it later means enrolling again.
- Operators: `brain devices <manifest>` lists enrolled passkeys and
  `--revoke` removes one; `brain secrets` now also derives the
  session-signing secret, so existing installs get all of this on their next
  setup or update, with nothing new to store.

After updating, run `brain setup <manifest>` (applies migration 0014 and the
new secret), then `brain invite <manifest>` and enroll your own phone first.

## 0.1.18

**Type your Cloudflare token once per computer, not once per command.**

- The first interactive `brain setup` or `brain update` on a machine still
  prompts for the token with hidden entry — and now offers to remember it in
  the macOS Keychain. Say yes once and every later provisioning run on that
  machine loads it automatically. Routine commands (`ask`, `eval`, `health`,
  `test`) never needed it and still don't.
- Storage is per Cloudflare account, so a machine that manages several
  accounts can never provision one install with a neighbour's token. The
  token never appears in a command line, a file, or a log — it moves between
  the prompt and the Keychain the same guarded way the admin key always has.
- `brain token <manifest>` shows whether a token is remembered for that
  install's account; `brain token <manifest> --forget` removes it. Client
  handoff now includes that forget step explicitly: revoking a token in
  Cloudflare does not delete a stored copy, so the handoff ritual does both,
  with the client watching.
- New computer, or this one dies? Nothing is lost: mint a fresh token in the
  Cloudflare dashboard (one minute) and the first run on the new machine
  offers to remember it. Fresh token per machine also means one laptop can be
  revoked without touching the others. `CLOUDFLARE_API_TOKEN` from a secret
  manager still wins for automation, unchanged.

After updating, run `brain setup <manifest>` once interactively, accept the
offer, then run it again and watch it skip the prompt. `brain token
<manifest>` confirms what is stored.

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

**Every answer now tells you how much to trust it.**

- `brain ask` prints a confidence line under each answer: a percentage with
  its band and the exact signals that produced it — how many independent
  documents agree, whether their dates are verified, and whether the brain has
  a known blind spot right now (a stalled source, an incomplete vector index).
- The number is a fixed, documented rubric over signals the answer pipeline
  already verifies — the same inputs always give the same number, and it is
  capped below 95 because retrieval can never prove completeness.
- Refusals get their own version: "Confidence nothing is recorded" is high
  when retrieval was healthy and every candidate was rejected, and drops
  sharply when a blind spot means the absence might be ours, not the record's.
- Answers weave the evidence date into time-sensitive claims ("per the
  2026-07-31 call transcript"), so a claim can be checked instead of trusted.
- API consumers get the same data as a structured `confidence` field on
  `/api/rag/think`; the answer text itself is unchanged, so existing golden
  sets, refusal scoring, and integrations keep working untouched.

After updating, run `brain eval <manifest> --golden-20` sitting next to the
person who owns the brain, then `brain ask` any question and read the new
confidence line. Existing golden sets and scoring are unchanged.

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
