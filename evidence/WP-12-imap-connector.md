# WP-12: a mailbox door for everyone who is not on Gmail

## What this is, in the owner's voice

Until tonight this product could read one kind of mailbox: Gmail. Everybody
else got nothing, and "nothing" is a strange thing to sell to somebody whose
invoices, contracts and every promise they made this year live in email. So
there is now a second door. `brain connect imap` reads any mailbox that speaks
IMAP, which is nearly all of them: Yahoo, Fastmail, iCloud, whatever the web
host set up years ago. You type the app password once, hidden, it goes into
your own Mac Keychain or Windows credential store under an item with IMAP's
name on it, and it never appears in a command, a log or a process list.

It opens every folder read-only, which is one keyword in the protocol and the
difference between reading your mail and marking three thousand unread messages
as read while you watch. It reads Inbox and Sent, because half of what you
promised anybody is in Sent. It skips Junk, Trash and Drafts, and on Yahoo it
knows the spam folder is called "Bulk Mail" rather than Junk, which is the
single easiest way to accidentally ingest the highest-volume garbage in an
account. A folder whose purpose it cannot work out is reported to you and left
alone rather than guessed at.

Three things you should know before you rely on it, because you will find them
out anyway and it is better to hear them from me. Bulk-mail filtering is
genuinely weaker here than on Gmail, and it works differently: Gmail asks
Google's own classifier server-side and never downloads the newsletter, while
this has to download everything and then decide from the message headers. It
needs two independent signals before it drops anything, so your supplier's
overdue-invoice thread survives even though their billing system sets an
unsubscribe header. Some newsletters Gmail would have caught will get through,
and every one it did drop is listed at the end of the run with the reason.
Second, mail you delete in your mailbox stays in your brain until a full
re-read; Gmail's connector has the same gap, Drive does not. Third, and this is
the one that matters most: **this has never been run against a real mailbox.**
Not Yahoo, not anywhere. It passes 78 checks against a scripted IMAP server
that answers the way the specification says a server should. A real one may not.
Everything in this file that is provider-specific is written from the spec and
from documented behavior, and is marked as such.

What to verify when a real mailbox is available: that Yahoo accepts the login
with an app password, that its folder list contains "Bulk Mail" spelled that
way, that `UID SEARCH` on a large folder returns in reasonable time, and that
`INTERNALDATE` on old mail matches the `Date:` header rather than a migration
date. Those are the four things a live run would settle that a scripted one
cannot.

---

## The five decisions the brief left open, and how each was decided

### 1. UIDVALIDITY: what happens when the server invalidates its own numbering

`UIDVALIDITY` is the server saying every UID you hold means nothing now. It
changes on mailbox recreation, some migrations and some provider maintenance.
The decision is in one pure function, `folderSyncDecision`, so it can be read
and tested without a server, and it has three parts that are each load-bearing:

1. **The folder is re-searched with `ALL`, from UID 1.** Not from `last_uid+1`.
   Resuming is the silent skip: under the new numbering `last_uid` is an
   arbitrary point in an unrelated sequence, so every message below it is never
   looked at again while the run reports success. The test proves the failure
   directly rather than the fix abstractly — see the discrimination section.
2. **The operator is told**, in the same voice as the Gmail history-expiry
   warning (`brain.mjs`: "the saved Gmail history id is too old to answer
   from, so this is a full pass"). A silent resync is indistinguishable from a
   bug.
3. **The new UIDVALIDITY is never recorded without the mail it covers.** The
   watermark is written as one object, `{uidvalidity, last_uid}`, through the
   existing `pendingCursor` mechanism, which only commits when every batch has
   been accepted and `sourceCursorCanAdvance(tally)` is true. If a resync dies
   halfway, state still holds the OLD pair, so the next run sees the mismatch
   again and resyncs again. There is no reachable state in which the new
   UIDVALIDITY is stored but its mail was not read.

A fourth guard covers the case the brief flagged and a pure function cannot see:
a roll that happens *during* a run (maintenance, or a reconnect landing on a
different backend). Each folder is re-`EXAMINE`d after streaming, and
`assertUidvalidityStable` throws if it moved. The run fails, the cursor is
withheld, and the folder is read again in full next time. Failing is correct
here; recording a watermark measured under the old numbering is not.

The resync is affordable because of decision 2 below: every message resolves to
`unchanged`, one read each, no re-embedding.

**Cost stated honestly:** a UIDVALIDITY roll re-downloads the folder. IMAP has
no "changed since" for message content, so there is no way to avoid the bytes.
It avoids the embeddings, which is the expensive half.

### 2. Document identity: the message's own, not `<folder>:<uid>`

`source_id` is the normalized `Message-ID`, or a SHA-256 over
`date|from|subject|first 512 chars` when a message has none. Keying on
`<folder>:<uid>` is the obvious choice and the trap: one UIDVALIDITY roll
re-lands every message under a new id, the old family is never removed, and the
client's brain silently holds their mailbox twice.

`version` is a content hash, deliberately not the `uidvalidity:uid:size` the
brief suggested. A UID-derived version would change for every message on a roll
and force a full re-embed, which defeats the entire point of the content-stable
id. The two have to be paired to work.

Two consequences, both stated rather than hidden: a message that exists in two
folders collapses to one document (correct, and it is also what saves you on
Gmail-over-IMAP where All Mail duplicates everything), and two messages sharing
a `Message-ID` (sent mail plus a Bcc self-copy) resolve to one document, losing
a copy rather than corrupting one. That is the safe direction.

### 3. Credentials: a distinct, auditable item, reusing the existing store

`connectors/google-auth.mjs` says the Google Keychain names are deliberately
explicit "so a person can find, audit, or delete this exact credential in
Keychain Access without guessing which generic-password entry belongs to the
brain." A Yahoo app password inside an item labelled "Google OAuth credentials
for Brain Installer" breaks exactly that promise.

So: **no second store, a distinct item.** Service `brain-installer.imap`,
account `imap-<source name>` (one per mailbox, so a client with two can revoke
one), Keychain comment "IMAP mailbox credentials for Brain Installer", file
fallback `~/.brain/imap-credentials.json`, backend selected by
`BRAIN_IMAP_CREDENTIAL_STORE` and **not** by `BRAIN_GOOGLE_TOKEN_STORE`. Two
small seams were added to `google-auth.mjs` to make that possible
(`options.keychainComment`, `options.storeEnv`), both defaulting to today's
Google values so nothing about Google changes; `test/google-auth-storage.test.mjs`
still passes all 55 of its checks. Everything else is reused unchanged: the
96-byte chunking, the generation-based atomic manifest swap, the SHA-256
verification, the `keychain-write.exp` transport that keeps the value out of
argv, and the Windows DPAPI path.

The password is read from a real TTY with echo disabled (`readHiddenSecret`,
modelled on the existing Cloudflare token reader: raw mode restored on every
exit path, buffer zeroed, and a refusal rather than a visible-entry fallback).
It is never a flag and never an environment variable. Yahoo displays app
passwords as four groups of four; the spaces are stripped, because a paste that
fails with "invalid credentials" is undebuggable for the person it happens to.

Connect refuses to store anything until a real read succeeds: login, LIST,
EXAMINE the inbox, and fetch one message back in full. A connector that installs
cleanly and fails on the first unattended sync is worse than one that refuses
now.

### 4. Dependency or hand-rolled: hand-rolled, no fifth dependency

The repo has exactly four dependencies (`@e965/xlsx`, `fflate`, `postal-mime`,
`unpdf`), all of them `bundleDependencies` shipped inside a public npm package,
and `ingest/extract.mjs` states the doctrine with its reason: everything on the
install path needs zero dependencies, because every package is one more thing
that can fail on a client's Windows box while somebody watches. Each of the four
buys something genuinely hard. An IMAP client does not clear that bar, and the
usual library (`imapflow`) brings a transitive tree into a bundled public
package.

The client is about 250 lines on `node:tls`. The read-only subset is small
(`CAPABILITY`, `LOGIN`, `LIST`, `EXAMINE`, `UID SEARCH`, `UID FETCH`, `NOOP`,
`LOGOUT`) and the genuinely hard half of email, MIME, was already paid for:
`parseEmailMessage` in `ingest/formats.mjs` is the same postal-mime reader the
Gmail connector, the mbox splitter and a `.eml` in a folder all use. The test
proves that pays off: for the same RFC 822 bytes, the IMAP envelope's rendered
content is **byte-identical** to the Gmail envelope's.

The response parser is a two-mode reader (CRLF lines; on `{N}` read exactly N
octets and resume), which is what keeps it 250 lines rather than 1500. Commands
are serialized on one connection, which is what the provider notes recommend
and what makes a dropped connection cost one command instead of an ambiguous
half of several.

**The honest cost:** this is our IMAP parser now, and IMAP responses are
fiddlier than they look. It handles what this connector issues and nothing more.
A server that answers in a shape the spec permits but this does not expect will
fail loudly rather than silently, which is the right failure, but it will fail.

### 5. Bulk mail: the same intent, and a plainly different mechanism

`connectors/gmail.mjs` already considered and rejected the obvious answer:
Gmail's category classifier "is better than a List-Unsubscribe check because
plenty of legitimate business senders set that header too." IMAP has no
classifier and no equivalent server-side query. So the mechanism differs, and
the difference is written into the connector header, the manifest schema, the
source matrix and the client-facing docs rather than glossed:

| | Gmail | IMAP |
|---|---|---|
| Where | Server-side, in the search query | Local, on headers, after the fetch |
| What decides | Google's trained category classifier | Two independent header signals |
| Cost | Bulk mail is never downloaded | Everything in the read folders is downloaded |
| Strength | Stronger | Weaker, and will let some newsletters through |

Three layers:

- **Layer 1, folder level, free and server-side.** The provider's own junk
  folder is skipped, along with Trash, Drafts and All Mail. This is the closest
  true analogue to `-category:promotions`, because it *is* the provider's own
  classifier. Yahoo's is named "Bulk Mail" and the name table knows it.
- **Layer 2, header level, two signals required.** `List-Id`,
  `Precedence: bulk|list|junk`, `Auto-Submitted` other than `no`,
  `List-Unsubscribe`, or a campaign header / known ESP `X-Mailer`. Requiring a
  second signal alongside `List-Unsubscribe` is exactly the discrimination the
  Gmail connector says a bare check lacks: a vendor's transactional thread
  carries one, a newsletter carries two. The test proves both directions on the
  same run — a past-due invoice with only `List-Unsubscribe` is kept, a
  newsletter with `List-Id` plus `List-Unsubscribe` is dropped.
- **Layer 3: nothing.** No sender reputation, no frequency heuristics. They
  would be wrong and, worse, unexplainable to a client asking why their
  supplier's mail is missing.

Every drop is a named skip carrying the signals that caused it, so a wrong call
can be judged rather than guessed at. And the policy is fingerprinted the way
Drive's is: change the rule and the next run is a full pass, because a filter
change that applies only to new mail leaves the old decisions sitting in the
index invisibly disagreeing with it.

`UID SEARCH HEADER` was considered as a server-side option and **not** used.
Whether Yahoo implements it correctly or at usable speed could not be
established here, and even if it works, a server-side header search cannot
require two signals, which is the whole discrimination.

### Yahoo specifically, and what would surprise an operator

Printed at connect time by `providerNotes()`, and marked in the source as
documented behavior rather than anything this repository verified:

- **An app password is mandatory.** The normal account password is refused for
  third-party IMAP, and generating one needs two-step verification on first.
  The connect output links to the security page rather than describing a click
  path from memory, because Yahoo has moved that page more than once.
- **The password is displayed as four groups of four.** The spaces are display
  only. Stripped automatically.
- **The spam folder is "Bulk Mail"**, not Junk or Spam. A Gmail-tuned name table
  misses it entirely and ingests the highest-volume bulk source in the account.
  This is the single highest-impact provider trap in the package.
- **Yahoo throttles and drops idle connections.** One serialized connection,
  one folder at a time. Slower, and it survives.
- **`imap.mail.yahoo.com:993`, implicit TLS.** STARTTLS on 143 is not offered at
  all: a failed upgrade is a silent downgrade.
- **Microsoft 365 and Outlook.com are NOT reachable by this connector.**
  Microsoft disabled basic IMAP authentication for those accounts. The source
  matrix says so on the same row, because "we support IMAP" would otherwise
  read as "we support Outlook".

---

## Discrimination: the tests were broken on purpose and they failed

A test that passes against the broken code proves nothing. Each fix was reverted
in turn and the suite re-run. Exact output, pasted.

**Break 1 — the naive UIDVALIDITY handler.** `folderSyncDecision` changed to
resume from `lastUid + 1` on a UIDVALIDITY mismatch instead of resyncing:

```
FAIL  UIDVALIDITY change: the search is ALL, not a resume from the old watermark  {"mode":"incremental","searchCriteria":"UID 5:*","floor":4,"resynced":true,...}
FAIL  UIDVALIDITY change: EVERY message is read again, including the ones below the old watermark  documents=0 skips=0
FAIL  UIDVALIDITY change: the new watermark carries the NEW uidvalidity, never the old one  {"uidvalidity":9001,"last_uid":0}
FAIL  UIDVALIDITY change: the documents keep their identity, so a resync is unchanged rather than a duplicated mailbox  {"before":["mid:engagement-001@northwind-example.test","mid:invoice-2291@harborline-example.test","mid:reply-004@northwind-example.test"],"after":[]}
FAIL  UIDVALIDITY change: a resume from UID 5 under the new numbering would have skipped all four messages, and is refused  {"mode":"incremental","searchCriteria":"UID 5:*","floor":4,"resynced":true,...}
5 FAILURES
```

`documents=0 skips=0` is the finding, and it is exactly the failure the work
package exists to prevent: the broken version reads **nothing at all** after a
UIDVALIDITY roll, reports success, and the mail is gone from the brain forever
with no error anywhere.

**Break 2 — dropping the RFC 3501 6.4.8 client-side floor.** `aboveFloor`
changed to a pass-through:

```
FAIL  second sync with nothing new: RFC 3501 6.4.8 returns the highest UID anyway, and it is filtered out  documents=0 skips=1 log=LOGIN <redacted> | CAPABILITY | EXAMINE "INBOX" | UID SEARCH UID 4:* | UID FETCH 3 (UID INTERNALDATE RFC822.SIZE) | UID FETCH 3 (UID INTERNALDATE RFC822.SIZE BODY.PEEK[]) | LOGOUT
1 FAILURES
```

The wire log is the proof: with the floor gone, an incremental sync with
nothing new still refetches UID 3 on every single run, forever.

**Break 3 — the bare `List-Unsubscribe` check the Gmail connector rejected.**
`BULK_POLICY.min_signals` changed from 2 to 1:

```
FAIL  first sync: the two genuine messages became documents  ["Signed engagement letter"]
FAIL  bulk exclusion: the skip NAMES the signals, so a wrong call can be judged rather than guessed at  bulk mail: list-unsubscribe (1 of the 1 signals this filter requires)
FAIL  bulk exclusion: the past-due invoice carrying ONLY List-Unsubscribe was KEPT  ["Signed engagement letter"]
FAIL  bulk exclusion: the policy fingerprint changes when the rule changes, so old decisions cannot go stale silently  fingerprints matched
4 FAILURES
```

The overdue invoice disappears. That is the failure mode the two-signal rule
exists for, and it is the one a client would notice and be unable to explain.

**Break 4 — the folder partition that called an identified folder unidentified.**
`partitionFolders` reverted to its three-bucket form, which is what shipped in
the first pass of this work package and what the review below caught:

```
FAIL  folder policy: an Archive folder is reported as identified-but-not-read, NOT as unidentified  unlisted=[] unclassified=["Projekte","Archive","[Gmail]","Fwd"]
FAIL  folder policy: a \Noselect container is not counted as a mail folder that went unread  containers=[] unclassified=["Projekte","Archive","[Gmail]","Fwd"]
FAIL  connect probe: an identified-but-unread folder is named at connect, with its role, not at first sync  []
FAIL  connect probe: the \Noselect container is not presented to the operator as an unread mail folder  {"unclassified":["Projekte","Archive","[Gmail]","Fwd"],"unlisted":[]}
4 FAILURES
```

`Archive` and `[Gmail]` in the unclassified list is the whole finding. `Archive`
was identified; telling the operator it "could not be classified" is false, and
it is the more alarming of the two readings. `[Gmail]` is a container that never
held a message and cannot be opened at all.

**Break 5 — provider notes printed as established fact.** The caveat removed
from `providerNotes`:

```
FAIL  provider notes state plainly that they were never verified against a live account  , not Junk or Spam. It is skipped,
1 FAILURES
```

**Break 6 — the app-password charset collapsed onto the Cloudflare one.** After
consolidating the two hidden-entry readers, `accepts` changed to the Cloudflare
predicate, which excludes a space:

```
FAIL  custody: an app password typed WITH the spaces the provider displays is accepted, not refused mid-entry  refused: the password contains an unsupported character or is too long
FAIL  custody: and it normalizes to what the server is actually sent  nothing was entered: the password contains an unsupported character or is too long
2 FAILURES
```

That break is the reason the consolidation has a test at all. Sharing one core
between a token that must not contain a space and a password that routinely
does is exactly where a later tidy-up quietly breaks the second caller, and
Yahoo prints its app passwords in groups of four.

Restoring each fix returns the suite to `imap connector: all 78 checks passed`.

---

## Review of the first pass, and what it got wrong

The connector was written, then read back adversarially before commit. Three
defects survived the first pass, all of the same kind: the code was correct and
the thing it SAID was not.

1. **An identified folder reported as unidentified.** `Archive`, `Flagged` and
   `Important` have roles, are in neither the include nor the skip list, and
   fell into the bucket the operator is told "could not be classified". A
   `\Noselect` container like Gmail's `[Gmail]` landed there too, which
   presents a thing that is not a mail folder as a mail folder that went
   unread. Fixed by splitting into five outcomes, each reported with its own
   true sentence. Break 4.
2. **A comment that promised what the code did not do.** The doc comment on
   `providerNotes` said the connect command states the notes are documented
   rather than verified. It did not; the notes printed as flat fact from a
   connector that has never touched a live mailbox. The caveat is now part of
   the printed output, because a comment is not something an operator reads.
   Break 5.
3. **A second copy of the hidden-entry reader.** `readHiddenSecret` was a
   near-duplicate of `readHiddenCloudflareToken`: fifty lines of raw-mode
   restore, listener cleanup, Ctrl-C handling and buffer zeroing, which is
   exactly the code that is easy to get subtly wrong and impossible to notice
   when it is. Consolidated into one `readHiddenInput` with the prompt, the
   accepted bytes and the finaliser passed in. The pre-existing
   `test/cloudflare-token-prompt.test.mjs` was the safety net and still passes
   unchanged, including its no-echo and raw-mode-restore assertions.

The first two are honesty defects, not correctness defects, and they are the
kind this product cannot afford: the mailbox was read correctly and the report
about it was wrong.

---

## What is NOT proven, and cannot be proven here

- **No live mailbox, anywhere.** Nothing in this work package has connected to
  Yahoo or to any real IMAP server. The scripted server in
  `test/fixtures/imap-server.mjs` answers the way RFC 3501 says a server should.
  Real servers deviate. Every provider-specific statement in the connector, the
  docs and this file is from the specification or documented provider behavior,
  and none of it is observed.
- **No TLS.** Production calls `tls.connect` with Node's default certificate
  verification (deliberately not disabled). The fixture is plain TCP reached
  through the connector's `socketFactory` seam, so TLS negotiation and
  certificate validation are untested.
- **No Keychain write.** Credential custody is asserted on the storage *options*
  the connector produces — which item, which account, which environment
  variable — not by writing to a real macOS Keychain. The underlying write path
  is the one `test/google-auth-storage.test.mjs` already covers.
- **The `brain.mjs` branch composition is only partly covered.** The pure pieces
  it composes are tested directly (`folderSyncDecision`, `partitionFolders`,
  `assertUidvalidityStable`, `mergeFolderWatermarks`, `streamFolder`,
  `toEnvelope`), and the command's refusal path was exercised by hand. The
  end-to-end `brain ingest --from imap` command against the scripted server is
  not automated, because the CLI constructs its own TLS connection and adding a
  socket-injection seam to production code purely for a test would be a
  security seam, not a test improvement.
- **Deletions are not propagated.** A UID watermark cannot see expunges. Mail
  deleted in the mailbox stays in the brain until a full re-read. Gmail's
  connector has the identical gap; Drive does not. Said in the matrix, the
  schema and the client-facing docs rather than left to be discovered.
- **Very short messages are dropped** by the existing `textQuality` floor
  (`MIN_CHARS = 24`). For documents that is right; for correspondence it means
  "approved, go ahead" does not make it in. Noted in the matrix.
- **No unattended scheduler.** Refresh is manual, exactly as with Gmail. The
  scheduler spec object is generalized enough to extend, but that is a decision
  to make deliberately, not to absorb here.

## Out of scope, deliberately, and not absorbed

- **Microsoft 365 / Outlook.com stays a disqualifier.** Basic IMAP auth is
  disabled there. The matrix row now says so explicitly on the same line as the
  IMAP capability, so the new capability cannot be misread as covering it.
- **An mbox splitter** was suggested by the brief as an adjacent fix. It already
  exists (`ingest/mbox.mjs`, registered in `ingest/formats.mjs`), landed by
  other work on this release line. Not touched.
- **`corpora.imap.folders`** does not exist. A folder that is not read is
  reported and left alone; there is no manifest setting that includes one. The
  run message says exactly that rather than pointing at a setting that does
  nothing. This is the limitation most likely to matter in practice, because it
  is what leaves an **Archive** folder unread.
- **Archive folders are identified and still not read.** Including them is a
  behaviour decision, not a bug fix: on Gmail-over-IMAP an All Mail/Archive
  folder duplicates the whole mailbox, and while the content-stable document id
  would collapse the duplicates correctly, the download would not. Left out,
  said out loud, in the matrix and in the run.

## Files

| File | Change |
|---|---|
| `connectors/imap.mjs` | New. Protocol client on `node:tls`, folder classification, bulk policy, UIDVALIDITY/UID sync decision, envelope construction, credential custody, connect probe. |
| `connectors/google-auth.mjs` | Two option seams (`keychainComment`, `storeEnv`), both defaulting to today's Google values. |
| `brain.mjs` | `--from imap` branch in `cmdIngestRemote`; `cmdConnectImap`; `cmdDisconnectImap`; `readHiddenInput` (one hidden-entry core, now also behind `readHiddenCloudflareToken`) and `readHiddenSecret`; honest per-folder run reporting; support-journal and help-text allowlists; `assertRemoteLimitSafe` message generalized past Google. |
| `test/imap-connector.test.mjs` | New. 78 checks. |
| `test/fixtures/imap-server.mjs` | New. Scripted IMAP server on a real socket. |
| `test/package-privacy.test.mjs` | `connectors/imap.mjs` added to the npm allowlist, same commit. |
| `package.json` | Test registered in the chain. |
| `manifest.schema.json` | `corpora.imap`. |
| `templates/brain.manifest.json` | `corpora.imap`, disabled by default. |
| `onboarding/07-ingest-source-matrix.md` | Matrix row, "If you are not on Gmail" section, M365 row corrected. |
| `docs/README-developer.md` | Remote-sources section extended. |
