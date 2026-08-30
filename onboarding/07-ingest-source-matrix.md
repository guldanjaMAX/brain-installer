# What your brain can read, and what it cannot

The honest version. If a source is not on the built list below, assume it is **not connected**, and do not let anyone, including me, imply otherwise in a proposal.

I would rather lose a sale to an honest table than win one and spend week three explaining.

---

## Summary

**One command loads all of it:** `node brain.mjs load <manifest>` sweeps every source below that your manifest has switched on and that is connected, in one run, and prints one report saying what went in and what did not. See [One command that loads everything](#one-command-that-loads-everything-brain-load) for exactly what it does and does not do. The per-source commands in the table stay available for loading one thing at a time.

| Source | Status |
|---|---|
| Google Drive | **Built, root-bound, and off by default.** The manifest must name reviewed folder ids. Deterministic tests prove unrelated visible files are excluded. Live root, Shared Drive, move, permission-loss, delete, and scheduler acceptance remains open |
| Direct upload and API push | **Built.** The owner workspace accepts text, PDF text layers, Word, PowerPoint, Excel, `.eml`, PNG, and JPEG. Image OCR stays private to the owner's Worker and is off unless configured. Scanned PDF page OCR is not built. All browser formats have local fixture proof only |
| A watched folder on your own machine | **Built, Mac-only for the schedule.** Name one folder in your manifest and it reloads itself on a schedule: new files load, edited files reload, deleted files are removed. This is what makes "drop it in a folder you already ingest" true for a folder that is not inside Google Drive. On Windows and Linux the same load runs by hand. Real multi-tick sleep, wake, and deletion behavior is not yet field-proven |
| Gmail | Built: `brain connect google --scopes gmail`, then `brain ingest --from gmail`. Incremental via historyId; bulk mail excluded by default. Not yet run against a real mailbox |
| Any other mailbox, over IMAP (Yahoo, Fastmail, iCloud, a host) | Built: `brain connect imap`, then `brain ingest --from imap`. Read-only, so nothing is marked read. Inbox and Sent by default; Junk, Trash and Drafts skipped; **an Archive folder is NOT read**, and a folder whose role cannot be identified is not read either. Every folder is named in the run with the true reason it was or was not read. Incremental via UIDVALIDITY plus a per-folder UID watermark. Bulk mail is filtered locally on headers, which is weaker than Gmail's. **Never yet run against a real mailbox** |
| Google Calendar | Built and wired: `brain connect google --scopes calendar`, then `brain ingest --from calendar`. Incremental via Google's own sync token; cancelled events are removed, not left behind. Not yet run against a real calendar |
| Meetings (Google Meet) | **Built, with no extra work.** Meet's own Gemini notes land as a transcript document in Drive, which is already read |
| WhatsApp | **Built two ways.** The safer one is your phone's own "Export chat" .txt, dropped in a folder that is ingested. The other is `brain connect whatsapp --accept-risk`, live capture through an unofficial paired-device client. It is Mac-only, off unless you turn it on, violates WhatsApp's Terms of Service, and is not proven against a real account. Meta's official WhatsApp Business Platform connector is not built into this Brain yet. |
| Text messages (Android, and Google Voice) | **Built, as an export.** SMS Backup & Restore's .xml export, or a Google Voice Takeout, dropped in a folder that is ingested |
| iMessage (Mac) | **Built, Mac-only live path.** `brain connect imessage` checks Full Disk Access, loads history, then uses scheduler-tick capture. There is no accepted receipt from a real `chat.db` read yet. **Apple only exposes message history on a Mac; there is no path on Windows** |
| iPhone messages, no Mac (Windows too) | **Built, as a one-time history load.** `brain ingest --from iphone-backup` reads an **unencrypted** local iPhone backup and loads the iMessage and SMS history inside it. A point-in-time snapshot, **not** live capture: nothing new arrives afterwards. Runs on Windows and macOS. Never yet run against a backup Apple wrote |
| Facebook Messenger export | **Built as an export.** Select Messages and JSON in Meta's Download Your Information flow, then ingest the exported `message_*.json` files through Drive or the watched folder. Exact epoch timestamps, stable thread/session identity, rerun idempotency, explicit attachment-only/unavailable counts, and family deletion are fixture-tested. No current real export has been accepted yet; there is no live Facebook API connector. |
| Zoom | **Built.** `brain connect zoom`: a webhook on your own worker loads each cloud-recording transcript automatically. The worker stores delivery debt before acknowledging Zoom and checks a bounded recent window for missed webhooks. **Needs a paid (Licensed) Zoom seat** because the free tier cannot cloud record at all. Not yet run against a real Zoom account |
| Plaid bank feed | **Built, read-only, and off by default.** The owner completes Plaid Link. Transactions Sync stages a complete update window before ledger rows and the cursor become visible together, and history stays visibly partial through Plaid's NOT_READY and INITIAL states. Signed webhook receipt and reconciliation debt commit together, scheduled reconciliation remains the fallback, update mode needs a provider health check, and an unclear removal response is checked before another removal attempt. Credential-free fake and real SQLite/D1-compatible tests pass. No Plaid Sandbox, Production, real institution, or primary-bank proof exists yet |
| Slack | **Sandbox-ready, not live-proven.** Public-client PKCE, rotating user tokens, channels, direct conversations, messages, threads, surfaced tombstones, scheduling, and disconnect are wired. Slack does not expose complete deletion truth |
| Notion | **Sandbox-ready, not live-proven.** Pages, properties, recursive blocks, surfaced trash, OAuth refresh, scheduling, and disconnect are wired. Pages not shared with the integration stay invisible, and removal truth is incomplete |
| Microsoft 365, Outlook, SharePoint, OneDrive | **Sandbox-ready, not live-proven.** Outlook immutable-ID delta and OneDrive or SharePoint file bodies share one Microsoft OAuth connection. Cursors stop on body gaps or lost drive visibility instead of skipping data |
| Dropbox | **Sandbox-ready, not live-proven.** Recursive baseline, file bodies, opaque cursor resume, surfaced deletions, scheduling, and disconnect are wired. A body extraction gap withholds the cursor |
| QuickBooks Online | **Sandbox-ready, not live-proven.** Fifteen accounting record types are read as a repeatable company snapshot with provenance. QuickBooks queries do not expose reliable deletion truth, so stale records are not removed automatically |
| HubSpot CRM | **Sandbox-ready, not live-proven.** Contacts, companies, deals, archived tombstones, OAuth refresh, scheduling, and disconnect are wired. Permanently deleted objects are not exposed by ordinary snapshots |
| LinkedIn | **Built as an owner export, not a live connector.** Recognized CSVs in Download Your Data ZIPs use the bounded archive path. There is no cookie capture, scraper, or live LinkedIn API |
| Airtable | Not built |

---

## Built

### Google Drive

Connected with **read-only** access. It can look at documents. It cannot change, move, or delete anything, and that is enforced by the permission itself rather than by good behavior.

It is off by default. Turning it on requires at least one exact folder id under
`corpora.google_drive.root_folder_ids`. Only those folders and their descendants
are traversed. A shortcut inside an approved folder does not authorize its
target elsewhere in Drive.

**What it reads:**

| Type | How |
|---|---|
| Google Docs | Full text |
| Google Sheets | Cell contents as rows |
| Google Slides | Text from the slides |
| PDF | Text layer. A scanned PDF with no text layer can be read by OCR, if you turn OCR on |
| Word (.docx), PowerPoint (.pptx), Excel (.xlsx) | Full text |
| Rich text (.rtf) | Text only; font tables, styles and embedded pictures are dropped |
| Plain text, Markdown, JSON, XML, YAML | As written |
| Meeting transcripts and subtitles (.vtt, .srt) | Speaker-tagged text; cue numbers, timings and positioning removed |
| Mail archives (.mbox) | Split into individual messages, each one its own document with its own date |
| Calendar exports (.ics) | Each event with its date, attendees, location and description |

**What it does not read, and why:**

| Type | Why not |
|---|---|
| Images, video, audio | No text to read. There is no transcription step |
| Scanned PDFs, when OCR is OFF | Off is the default. A scan is a picture of a page, and without OCR this system cannot read it. Turn it on with `safety.ocr.enabled` |
| Scanned PDFs whose reading came back unusable | Reported, never indexed on a guess. If the model described the page instead of transcribing it, repeated itself, or produced too little to be a page, the file is refused with the reason |
| Code, stylesheets, build output, lockfiles | Matches a lot of questions and answers almost none of them. Left out deliberately, because it crowds real documents out of your results |
| Database dumps and backups | Same reason, larger. One dump can flood an index and make everything else harder to find |
| Anything in a folder whose name starts with `_Private` | Owner-only by convention. Never read, enforced in two independent places |
| Anything you excluded at intake | Excluded at the source. It is never read, not read and filtered |
| Files whose names suggest credentials | Anything looking like a key file, an environment file, or a certificate is refused by name before it is opened |

**How it stays current:** every refresh revalidates the reviewed folder trees.
Unchanged files are skipped before downloading their content, so re-running is
safe and does not duplicate documents.

**When a file visibly moves outside an approved root or Drive reports it in
trash**, the matching material is removed from your index. A 403 or 404 could
mean permission loss or hard deletion, so the connector preserves the existing
copy and reports the source incomplete instead of guessing. If one cleanup plan
is more than 100 documents or more than 10% of the stored Drive corpus, it stops
before deleting anything or advancing its cursor. The owner sees aggregate
reasons and an opaque plan fingerprint, never file names or IDs, and must
approve that exact plan on the rerun.

**An active file that this version cannot read is not the same as a deleted file.** The connector records a typed reason. It removes the prior Brain copy only when a trusted earlier Drive receipt proves that the source revision changed, or when the credential scanner says the old copy is unsafe to keep. A migrated document with no trusted local receipt is preserved and marked unverified instead of being guessed stale. Drive stays visibly incomplete until that file is successfully reread or explicitly reviewed; a later no-change sync cannot turn it green by accident.

**One honest note about how this runs.** Drive is a standard, packaged connector inside the installer, not a private script. You connect your own Google account once, load it with the normal ingest command, and on macOS the installer can schedule unattended refreshes. The Google sign-in still requires the account owner, and the packaged unattended scheduler is not built for Windows or Linux yet.

### Gmail and email

Built as a connector. Connect your Google account with the Gmail scope, then run the normal Gmail ingest command. Later runs are incremental through Gmail's history cursor, and bulk mail is excluded by default.

**The honest production boundary:** the connector has passed the product test suite but has not yet completed a real-mailbox production run. The packaged unattended scheduler currently covers Drive and iMessage, not Gmail, so Gmail refresh is manual until it is extended. Treat Gmail as built but not yet production-proven.

#### If you are not on Gmail

Most mailboxes are not Gmail, and email is a financial record for about half the people reading this, so there is a second door. `brain connect imap` reads any mailbox that speaks IMAP: Yahoo, Fastmail, iCloud, a mailbox your web host gave you.

```
node brain.mjs connect imap <manifest> --host imap.mail.yahoo.com --user you@yahoo.com
node brain.mjs ingest  <manifest> --from imap
```

Most providers, Yahoo included, need an **app password** rather than your normal password, and generating one usually requires two-step verification to be switched on first. You type it once, hidden, and it is stored in your own Mac Keychain or Windows credential store under an item named for IMAP. It is never accepted as a command flag and never put in an environment variable.

What it reads, and what it deliberately does not:

- **Inbox and Sent**, because half of what you promised anybody is in Sent.
- **Junk, Trash, Drafts and an "All Mail" folder are skipped.** On Yahoo the spam folder is called "Bulk Mail", which is handled.
- **An Archive folder is not read either.** It is identified, and it is named in the run as identified-but-not-read, because only inbox and sent are read by default. If you archive aggressively, most of your mail is in there and this is the limit that will matter most to you. Including it needs a rule that does not exist yet.
- **A folder whose purpose it cannot identify is reported and left unread**, rather than guessed at. Folder naming is localized and differs per provider, and reading your spam folder because it was named in Spanish is a worse outcome than telling you a folder was skipped.
- **Nothing is marked as read.** It opens every folder read-only at the protocol level, so it cannot change what your unread count says.

Three limits worth knowing before you rely on it:

1. **Bulk mail filtering is weaker here than on Gmail, and the mechanism is different.** Gmail excludes newsletters with a server-side query against Google's own classifier. IMAP has no such thing, so this reads the mail and then filters on message headers, requiring two independent signals before it drops anything. It will keep some newsletters Gmail would have dropped. Everything it did drop is listed at the end of the run with the reason.
2. **Deletions are not propagated.** Mail you delete in your mailbox stays in your brain until a full re-read. Gmail's connector has the same gap. Google Drive does not, and the difference is real.
3. **Very short messages are dropped**, the same floor every document clears. A one-line "approved, go ahead" is usually below it, which matters more for correspondence than for documents.

**The honest production boundary:** this connector has passed the product test suite, driven end to end against a scripted IMAP server. **It has never been run against a real mailbox**, on Yahoo or anywhere else, so provider-specific behavior is documented from the specification rather than observed. The packaged unattended scheduler does not cover it, so refresh is manual, exactly as with Gmail.

Shared mailboxes and group threads contain messages from people who never agreed to be indexed. Your material stays in your own accounts throughout, which handles most of the exposure, but a business indexing a shared inbox should have a written note about it. Cheap to write now, expensive to retrofit after an employee asks.

### Direct upload and API push

Anything you can turn into text can be put into your brain directly, one document at a time or in bulk. The browser accepts plain text, PDF files with text layers, Word, PowerPoint, Excel, `.eml`, PNG, and JPEG. PNG and JPEG use the private OCR route when OCR is enabled. Scanned PDF page OCR is not available, and a scan without a text layer is refused by name. This is the built fallback for every source with no connector. Its extraction and retry proof is local and synthetic; an authorized real-document receipt is still pending.

Everything arriving this way passes the **credential gate**: if a document contains a live password or API key, it is refused, the kind of credential is named, and its value is never quoted back. Nothing is written. That gate runs on every door into your index, because a gate on one door is not a gate.

### One command that loads everything: `brain load`

Install day used to be seven separate commands, run in an order nobody had written down, producing seven separate reports. `brain load` is that whole day in one line:

```
node brain.mjs load <manifest>
```

It reads your manifest, works out which sources you actually have, runs every one of them that is both **switched on** and **connected right now**, and prints one report at the end.

**What it does.**

- **It takes the work from your manifest, not from a list in the code.** If your install does not use WhatsApp, WhatsApp never appears as work. If a new connector is added later and your manifest declares it, it is picked up without anyone editing a list.
- **One source failing does not stop the others.** A dead Gmail token does not prevent Drive and Calendar from loading. The failure is caught, the sweep carries on, and every failure is listed at the end with what to do about it. This is deliberate: a partial load with an honest list beats an aborted run.
- **It tells you what is IN and what is NOT**, in four separate lists: what loaded, what was deliberately skipped and why, what is enabled but unavailable, and what failed while running. A skipped or unavailable source is never counted as loaded. If a count is not available it says *unknown*, never zero. If a source loaded in part it says so in those words.
- **Submitted is not accepted.** For iMessage, WhatsApp, and iPhone-backup loads, the report counts only Worker-accepted conversations as present. A conversation refused by the credential gate is named as not indexed and makes that source partial.
- **It is resumable.** It keeps no progress file of its own. Every source already remembers where it got to, and re-running the command is how an interrupted load finishes. For that same reason it refuses `--reset`: resetting everything at once is almost never what anyone means. Reset one source deliberately with `brain ingest <manifest> --from drive --reset`.
- **It runs cheap sources first.** Calendar, then messages, then your folders, then Gmail, then Drive, with a one-time iPhone backup last. You see something working in the first minute rather than after forty silent ones.

**What it does not do.**

- It does not connect anything. If a source is switched on in your manifest but not yet authorized on this machine, it is skipped with the exact command that would connect it. Connecting is a decision, not something a load should do on your behalf.
- It does not run Zoom from this local sweep. Zoom delivery and the bounded recent reconciliation both run inside your own Worker, where the durable delivery queue lives. The local command says so rather than claiming work it did not perform.
- It does not reach anything your manifest does not name. Folders on your machine are read only if you list them under `corpora.upload.folders`.
- It does not make a source work that is not built. A corpus your manifest declares that this version has no loader for is reported as exactly that, out loud.

**Options.**

| Flag | What it does |
|---|---|
| `--dry-run` | Reads every source and reports what it holds, and **sends nothing**. Nothing is written, no progress is saved. Calendar, iMessage, WhatsApp, and iPhone-backup previews report the exact event or conversation-document count they would submit. Run this in front of the client before the first real sweep: they see the exact scope of what is about to be read, before it is read |
| `--only <a,b>` | Run only these sources. This is how you rerun one source after fixing it, without redoing the whole sweep |
| `--skip <a,b>` | Run everything except these |
| `--limit <n>` | Cap every source. Useful for a fast demo; everything it touches is reported as an incomplete load, because it is |

Source names are the keys under `corpora` in your manifest, and the obvious short forms work too: `drive`, `mail`, `gcal`, `iphone`. A name that is not in your manifest is refused rather than silently sweeping nothing.

**Reading the report.** The bottom of the output is the part that matters:

```
  totals: 4 loaded, 2 skipped, 2 unavailable, 1 failed, of 9 declared
  943 created, 14 updated, 127 unchanged, 7 conversation document(s) sent
  5 of 9 declared source(s) are NOT in the brain. The lists above say which, and why.
```

If an enabled source failed, was unavailable, or loaded only in part, the
command exits non-zero **after** printing the whole report. A script cannot
mistake an incomplete sweep for success, and a person can still read what did
work. Deliberately disabled and push-only sources remain stated skips.

### Every load has a name, and the name is an undo

This applies to all of the above and it is worth knowing before you authorize the first big import.

Every load runs under a name, and the name is how you take it back:

```
node brain.mjs forget <manifest> --source <name>
```

That removes everything that load brought in, and nothing else. Without `--yes` it removes nothing and prints exactly what would go first.

This matters more than it sounds. The import most worth doing is usually the biggest one, and the biggest one is the one people hesitate over, because a first import you cannot reverse is a decision rather than an experiment. It should be an experiment.

`node brain.mjs sources <manifest>` lists every named load with its status and when it last ran.

### Google Calendar

Your brain already holds transcripts and email threads, and until this was built it was **inferring** who works with whom from how often names appear together. Calendar hands that over directly: who met, when, how often, for how long, and with whom.

It rides the Google permission you already grant, so it costs no additional setup on your side beyond a checkbox. Connect it and load it:

```
node brain.mjs connect google --scopes drive,gmail,calendar
node brain.mjs ingest <manifest> --from calendar
```

Later runs are incremental through Google's own sync token, same idea as Gmail's historyId. The token advances only after every event and cancellation is accepted; a failed or refused event is retried from the same Google window rather than silently skipped. A cancelled meeting is removed from your index, not left behind as a stale document. By default it reads your primary calendar; more than one calendar, or a shared one, is a manifest setting.

A Calendar dry run reports the exact event count it could preview. If any declared calendar cannot be read, it prints the partial scope and exits nonzero with the reconsent or provider fix. An unread calendar is never presented as an empty one.

**The honest production boundary, same shape as Gmail's:** the connector and the command that runs it have both passed the product test suite against scripted Google responses, including custom source namespaces, resume state, and cancellation targets. Neither has completed a real-calendar production run yet. Treat it as built but not yet production-proven.

Same publishing consideration as the rest of your Google connection: on Workspace it registers inside your own organization and simply works. On a personal gmail.com address the app must be published, or access is revoked every seven days.

### Meetings (Google Meet)

**No connector needed, because Google already writes the transcript where your brain already looks.** Turn on Gemini notes for a Meet call (or take notes yourself and save them), and the transcript lands as a document in your Drive. Drive ingest reads it like anything else. Nothing to connect, nothing to authorize beyond what Drive already has.

If your meetings are on Zoom instead, there is a connector for that — see the Zoom entry below. It needs a paid Zoom seat and about ten minutes of setup, and the same zero-build pattern (save the transcript into Drive) works there too if you would rather not set anything up.

### WhatsApp

**Built, as an export — not a live connection.** WhatsApp's own per-chat "Export chat" produces a `.txt` file (choose "without media"). Drop it in a folder that is ingested — run `brain ingest <manifest> --path <folder>` yourself, or put it in the watched folder so the next scheduled tick picks it up; it is detected automatically by its content, not by asking you to say what it is, and loaded as sessionized conversation documents rather than one giant wall of text.

**Also built, and deliberately hard to turn on: live capture.** `brain connect whatsapp <manifest> --accept-risk` pairs this machine with your WhatsApp account as a linked device, the same way WhatsApp Web does, and from then on captures new messages continuously into the brain. It is off unless you ask for it twice: the manifest has to declare `corpora.whatsapp.enabled`, and the command needs `--accept-risk` on top of that. Leave both alone and nothing about your install changes.

**Please review this tradeoff before turning it on.** Pairing joins your account through an unofficial reimplementation of WhatsApp's protocol rather than an official API. WhatsApp treats unofficial clients as a Terms of Service violation and may restrict, temporarily ban, or permanently ban an account that uses one. If keeping the account available matters, the export path above is the safer choice. Separately, the history available at pairing time is only the window your phone chooses to transfer, typically weeks to a few months rather than the full archive. The export path is also how you bring in the full history of an important chat.

**A WhatsApp Business App account does not make this unofficial connector compliant.** Business automation should use Meta's official WhatsApp Business Platform Cloud API. That requires a Meta business setup, a WhatsApp Business Account, and a registered business phone number. The official Business Platform connector is not built into this Brain yet.

**What live capture actually needs, stated plainly:** a Mac, and a daemon binary you build yourself. The capture process is kept alive by a per-user LaunchAgent, and no Windows service or Startup-task supervision is built in this installer — the daemon itself compiles for Windows, so that is a missing installer rather than a missing capability, but nothing here will pretend to install something it cannot keep running. There is also no download-on-connect: how a signed binary should reach a client machine is an open decision, so today you either build it from this checkout (`cd daemons/whatsapp && ./build.sh`) or point the command at a binary you already have with `--daemon`. If it is absent, `brain connect whatsapp` says so and installs nothing.

**How it behaves once running:** a resident daemon holds the connection and writes every message to a local file on your own machine; a separate once-a-minute pass moves them into the brain. So a new message is answerable within about a minute, not instantly. Nothing is stored anywhere except your machine and your own brain, and the daemon itself holds no keys of any kind. Voice notes, images and video are captured as markers only, never transcribed, and a marker with no caption never becomes a document. `brain sources` shows the load, `brain forget --source whatsapp` removes it, and `brain disconnect whatsapp` stops both processes, loads whatever was still waiting, and leaves your phone's link in place for you to end from the phone.

**What has NOT been proven, and you should weigh it:** no part of live capture has ever run against a real WhatsApp account. The drain, the resume-after-interruption behaviour, the install and uninstall, and the wizard's reading of the daemon's output are all tested against fixtures, thoroughly. But a genuine pairing, a genuine history transfer, and a genuine live message have not happened — those need a phone scanning a QR code, and that has not been done yet. Treat live capture as first-run software until someone has done it.

**The one real gotcha, handled rather than ignored:** WhatsApp writes its export date in whatever order your phone's regional setting uses, with no marker saying which. "3/4/26" is March 4th on a US phone and April 3rd on nearly every other phone in the world. This is resolved automatically from the fact that a chat is chronological — every date in the file is checked for a reading that stays in order start to finish — and on the rare export too short or too regular to tell, it is refused rather than guessed, so you never end up with a chat silently misdated by weeks. You would see that refusal named in the ingest skip report if it happens.

### Text messages (Android, and Google Voice)

**Built, as an export, same posture as WhatsApp above.** Two sources:

- **Android:** the SMS Backup & Restore app (free, on the Play Store) exports your whole message history as one `.xml` file, covering every conversation, not just one.
- **Google Voice:** a standard Google Takeout export of your Voice data includes one page per conversation.

Either one, dropped in a folder that is ingested, is detected automatically and loaded the same sessionized way WhatsApp is. Unlike WhatsApp, neither format has a locale-dependent date to get wrong: both write an exact, unambiguous timestamp, so there is no disambiguation step here, only correct reading of it.

**iPhone note:** this Android path does not apply to you if you carry an iPhone. With a Mac, your texts arrive through the iMessage connector (see above) — turn on Text Message Forwarding and SMS rides in for free alongside iMessage. Without a Mac, the iPhone backup load below is the way in, and it is history only. There is no live SMS path for an iPhone without a Mac in the loop, and there is not going to be one.

### iMessage (Mac only)

**Built, as live capture on a Mac — and only on a Mac, with no way around that.** Apple only exposes your message history to a local app through `chat.db`, which exists on macOS and nowhere else. If your business runs entirely on Windows, this connector does not help you directly — it needs a Mac physically present and awake to run on, even if the rest of your install is elsewhere. The one thing that does work without a Mac is a **one-time history load from an unencrypted local iPhone backup**, which is a separate thing described below and is a snapshot rather than live capture.

**What `brain connect imessage <manifest>` is designed to do, in order:** verify Full Disk Access by actually reading the database (macOS requires a one-time grant on the exact Node binary; the command prints the precise steps and refuses to install anything until a real read succeeds), run the full history load in the foreground so you see its counts, then install a per-user LaunchAgent that runs a short capture tick about once a minute. The automated suite proves that control flow with fixtures; a reviewed real-database receipt is still pending.

**Capture is scheduler-tick, not instant push.** A new message appears in the brain within about a minute of arriving, when the next tick runs — there is no resident daemon watching the database continuously. A Mac that is asleep or shut does not capture; the next tick after it wakes catches up from exactly where the last one stopped, and `brain sources` reports the staleness honestly in the meantime.

What it captures, and what it does not:

- **Texts, both directions, iMessage and SMS.** SMS conversations arrive in the same database when your iPhone's Text Message Forwarding is on, and are tagged `sms` so they stay distinguishable. Without forwarding, only iMessage traffic exists on the Mac to capture.
- **Conversations are grouped into bounded sessions** (per thread, per day, split on a six-hour quiet gap) — the same shape WhatsApp and SMS exports produce — so a citation points at a conversation, not one floating text.
- **Contact names are not resolved.** People you text appear as their raw phone number or email address, not their Contacts-card name. Your own messages carry your name from the manifest.
- **Tapbacks, reactions and attachment-only messages are skipped and counted** — the run report says how many — so a thread in the brain is thinner than the same thread on your phone, and that difference is stated rather than hidden.

The load is the named source `imessage`: `brain sources` shows its freshness against the once-a-minute expectation, and `brain forget <manifest> --source imessage` removes every captured conversation. `brain disconnect imessage <manifest>` stops and removes the capture agent, flushes still-open conversations so they remain searchable, and leaves already-captured history in the brain unless you forget it explicitly.

### Zoom

**Built, and not yet run against a real Zoom account.** Every part of it is tested — the webhook's signature checks, the transcript parsing, the setup command, and the handshake between the two — but the tests use fixtures, not Zoom. Nobody has yet pointed this at a live paid Zoom account and watched a real meeting become a document. Treat it as built and unproven rather than proven, and expect the first live run to be the one that finds anything the fixtures could not.

**A paid (Licensed) Zoom seat is required, and that is not a soft requirement.** Zoom's free Basic tier has no cloud recording at all. No cloud recording means no transcript, which means there is nothing here to read. `brain connect zoom <manifest>` checks the plan while it runs and refuses to connect a Basic account, so you find out during setup rather than after the first call you wanted read. That check needs one extra read-only permission; if you leave it off, the command says the plan could not be confirmed instead of assuming it is fine.

**How it works.** You create a Server-to-Server OAuth app in **your own** Zoom account and copy four values it shows you. `brain connect zoom` checks them against Zoom for real, writes them as secrets on **your own** Cloudflare worker, then runs Zoom's own validation challenge against your worker to prove the endpoint will pass before you paste its URL into Zoom. After that, Zoom notifies your worker when a cloud recording or transcript is ready. Your worker records that delivery in its own D1 before it acknowledges Zoom, then fetches and stores the transcript under a reclaimable lease. The scheduled path also lists a bounded recent window so a webhook that never arrives does not disappear silently. We hold none of it: not the Zoom app, not the four credentials, not the recordings.

**What lands, and what does not:**

- **Recent reconciliation is recovery, not a complete historical backfill.** The first scheduled check covers at most the previous 30 days, then uses a two-day overlap for missed webhooks and late transcripts. Older calls still need the manual path below.
- **Cloud recording with audio transcript must be on** in your Zoom recording settings, for the meetings you want read. A meeting that was not cloud recorded produces nothing, and a recording with transcription turned off produces nothing.
- **The transcript only.** Not the audio, not the video, not a summary, and no analysis of the call. One meeting becomes one searchable document.
- **Speaker labels come from Zoom**, so people appear under whatever display name they joined with.
- **It arrives when Zoom says it is ready**, which is typically several minutes after the call ends and can be longer for a long meeting. This is Zoom's own transcription lag, not a delay we add.
- **Nothing about who attended.** Participant lists are a different Zoom permission and are not requested.

The load is the named source `zoom`, so `brain sources` shows it and `brain forget <manifest> --source zoom` removes every transcript it loaded. `brain disconnect zoom <manifest>` deletes the four secrets from your worker, which makes the webhook refuse every further delivery; removing the subscription inside your Zoom app is yours to do, and the command tells you where.

**The zero-build alternative is the way to load old calls, and it now actually works.** Save a recording's transcript — the `.vtt` file Zoom writes, an `.srt`, or an Otter export — into any folder that is ingested, and it is read as a speaker-tagged transcript like any other document, exactly the way Google Meet's own Gemini notes already do with no setup at all. That folder can be inside Google Drive, or it can be the watched folder on your own machine described at the end of this document.

Being honest about the history here: until this version there was no `.vtt` reader, so a transcript dropped in a folder was silently skipped for having no extractor, and this paragraph described something that did not happen. It reads them now, through the same converter the live Zoom connector uses.

### iPhone messages without a Mac, from a local backup (Windows or macOS)

**Built, as a one-time history load. It is a snapshot, not a connection.** This reads an **unencrypted** local iPhone backup — the kind Finder on a Mac or the Apple Devices app on Windows makes when you plug the phone in — and loads the iMessage and SMS history that backup contains.

**Say this part out loud before anything else:** nothing new arrives after the load. A message sent one minute after that backup was taken is not in it. Bringing history forward means taking a fresh backup and running the load again. Only the Mac connector above keeps up with an ongoing conversation, and that needs a Mac. This exists so that a business with no Mac still gets its message history in on install day, which is otherwise unreachable.

**How to run it:**

```
brain ingest <manifest> --from iphone-backup                 # find the backup automatically
brain ingest <manifest> --from iphone-backup --backup <path> # or name the folder
brain ingest <manifest> --from iphone-backup --dry-run       # count first, send nothing
```

With no `--backup`, it looks in the usual place for your operating system — `Library/Application Support/MobileSync/Backup` on a Mac; on Windows, classic iTunes' `%APPDATA%\Apple Computer\MobileSync\Backup`, the Apple Devices app's folder under your user profile, and the Microsoft Store build of iTunes' package cache. If it finds two backups it stops and asks which one, rather than picking for you.

**The encrypted-backup catch, which will affect some of you.** If the backup is encrypted, Apple encrypts its file index too, and this loader does not decrypt backups. It detects that and tells you the exact steps to make an unencrypted one, along with the two things worth knowing first: an unencrypted backup is readable by anything else running on that computer (so make it, load it, delete it, and switch encryption back on), and health data and saved passwords only ride along in an encrypted backup.

**What it loads:**

- **iMessage and SMS, both directions**, tagged `imessage` or `sms` from the conversation's own service, exactly as the Mac connector tags them.
- **Conversations grouped into bounded sessions**, per thread, per day, split on a six-hour quiet gap — the same shape WhatsApp, SMS and iMessage produce, so a citation points at a conversation rather than one floating text.
- **The same documents the Mac connector would produce.** The extraction is literally the Mac connector's own code, so loading a conversation from a backup and later capturing it live on a Mac lands as the same document, recognised as unchanged rather than duplicated. Running the same backup twice is safe for the same reason.

**What it does not:**

- **Contact names are not resolved.** People appear as their raw phone number or email address, not their Contacts-card name. Your own messages carry your name from the manifest.
- **Tapbacks, reactions and attachment-only messages are skipped and counted** — the run report says how many — so a thread in the brain is thinner than the same thread on your phone, and that difference is stated rather than hidden.
- **Attachments themselves are not read.** Only message text.
- **It does not decrypt anything**, and it does not read a pre-iOS 10 backup (those index files differently). Both are refused by name rather than failing obscurely.

The load is the named source `iphone-backup` (or whatever you pass to `--source`, if you would rather name it by date). `brain forget <manifest> --source iphone-backup` removes every conversation it loaded and nothing else. `brain sources` lists it as its own kind, so a finished snapshot is never presented as live capture that has gone stale.

**The honest boundary:** this has been proven end to end against a synthetic backup built in the test suite — the file index, the property lists, the write-ahead-log sidecar, the encrypted refusal and the message extraction all have tests. It has **not** yet been run against a backup Apple itself wrote, and it has not been run on a real Windows machine; the Windows path handling is proven by construction rather than by a Windows run. Expect the first real backup to surface something, and tell me what it says rather than working around it.

### A watched folder on your own machine

**Built. The schedule is Mac-only; the load itself runs anywhere.**

Several parts of this document tell you to drop a file into "a folder you already ingest": a WhatsApp export, an SMS backup, a Google Voice takeout, a saved meeting transcript, a mail archive. That sentence used to be true only if the folder happened to live inside Google Drive, because Drive was the only source that refreshed itself. Anywhere else, "already ingest" quietly meant "remember to run a command by hand, forever" — and the day you stop, your brain stops matching your world while still answering confidently from what it has.

So you can now name one folder and have it reload itself:

```json
"corpora": {
  "local_folder": { "enabled": true, "path": "/Users/you/Brain Dropbox", "source": "documents" }
},
"operations": { "folder_ingest_cron": "0 * * * *" }
```

```
brain schedule <manifest> --install --folder    install it (macOS)
brain schedule <manifest> --folder              is it installed, did the last run work
brain schedule <manifest> --remove --folder     remove it, keep its logs
```

**What each run does:**

- **A file you added since last time is loaded.**
- **A file you edited is reloaded**, and only that file. Sameness is judged by the file's contents, not its timestamp, so a sync or a backup restore touching every file does not cause a re-index of everything.
- **A file you did not touch costs one read** and is not sent again.
- **A file you deleted is removed from your brain.** That is what makes the folder a mirror of your intent rather than a pile that only ever grows. Removals are counted and capped: a run that would remove more than 100 documents, or more than a tenth of what that source loaded, stops and asks you first, printing counts and an approval code but never a filename. A cloud folder that failed to sync looks exactly like you deleting everything in it, and that difference is worth one deliberate confirmation.
- **An interrupted run resumes.** Progress is saved continuously, so a closed lid costs one file, not the whole pass.

**The honest limits:**

- **The schedule needs macOS**, because it installs as a per-user LaunchAgent. On Windows and Linux the same load runs, you just start it yourself: `brain ingest <manifest> --path <folder> --source documents`.
- **It is hourly by default**, not instant. It is a place to drop exports, not a live feed.
- **The path must be absolute.** A scheduled job does not run from your shell, so a relative path would point somewhere neither of us intended.
- **The folder must exist when you install the schedule.** Pointing at a folder that is not there would load nothing and report success forever, so it is refused at install time instead.
- **`_Private` prefixes still apply**, exactly as everywhere else.

The load is the named source you chose, so `brain sources` shows it and `brain forget <manifest> --source documents` removes exactly what it loaded.

---

## Additional export path and sandbox-ready providers

Named plainly, with what it would actually take, so you can plan around it rather than wait for it.

### Slack

**Sandbox-ready, not proven against a real workspace.** The owner creates a Slack app with PKCE enabled. The desktop flow requests read-only user scopes and stores rotating tokens on the owner's machine. It reads channels, direct conversations, messages, and bounded thread replies. The API can surface some deletion events but cannot prove every message or inaccessible conversation that disappeared, so Slack stays partial by contract and never removes unseen history by guess. `brain disconnect slack` revokes the current token and removes local custody, then tells the owner to remove the underlying Slack app installation.

### Microsoft 365, Outlook, SharePoint, OneDrive

**Sandbox-ready, not proven against a real Entra tenant.** The public-client PKCE flow requests read-only mail, file, and site access. Outlook uses immutable message IDs and Graph delta links. OneDrive, configured drives, and SharePoint site drives download supported file bodies through bounded extraction. A delta link advances only after every body and deletion receipt succeeds. If a previously known drive becomes invisible, its cursor and stored documents are retained and the source becomes partial. Tenant consent may still require the customer's Microsoft administrator.

### Notion

**Sandbox-ready, not proven against a real workspace.** The connector uses Notion's versioned API, reads shared page properties and recursive blocks, and surfaces archived or trashed pages it can see. Notion only returns pages shared with the integration. Removing access can look like disappearance without a tombstone, so the connector names incomplete removal authority and does not advance a cursor or invent deletions.

### QuickBooks Online

**Sandbox-ready, not proven against an Intuit sandbox or production company.** The OAuth connection is company-bound and refreshable. Each run reads Accounts, Customers, Vendors, Invoices, Payments, Bills, Purchases, Journal Entries, Deposits, Transfers, Credit Memos, Bill Payments, Estimates, Sales Receipts, and Refund Receipts with stable IDs and provider timestamps. The query API does not provide reliable deletion truth, so each run is an explicitly partial present-record snapshot and never removes an old record merely because it was absent.

### HubSpot CRM

**Sandbox-ready, not proven against a real portal.** Contacts, companies, and deals are read in active and archived passes. Archived objects become exact tombstones. Permanent deletions are not exposed by the ordinary object snapshots, so full deletion authority remains unavailable. OAuth uses HubSpot's versioned 2026-03 token and revoke endpoints.

### Dropbox

**Sandbox-ready, not proven against a real account.** Dropbox uses public-client PKCE, offline refresh, recursive list cursors, bounded file-body extraction, surfaced tombstones, and remote token revocation on disconnect. A complete baseline is reconciled against stored families. If any inventoried file body cannot be extracted, the source stays partial and the cursor is withheld so an unchanged file is not skipped forever.

### LinkedIn Download Your Data

**Built as an export only.** Drop the account owner's Download Your Data ZIP into an approved folder. Recognized profile, connection, employment, education, recommendation, message, invitation, skills, project, certification, learning, follow, job, article, comment, and share CSVs become stable documents with archive and row provenance. Every ZIP entry is counted against shared archive safety bounds even when it is not selected. There is no live LinkedIn, browser-cookie, or scraping path.

### Airtable

**Not built.** Airtable needs the meaning of each table mapped explicitly, so it remains configuration work rather than a generic connection.

### Facebook Messenger

**Built as a credential-free export path, not as a live connection.** In Meta's
Download Your Information flow, select Messages and JSON. Drop the exported
`message_*.json` files into the watched folder or an approved Drive root. Each
thread becomes bounded conversation documents through the same sessionizer as
iMessage, SMS, and WhatsApp. Exact epoch-millisecond timestamps are preserved,
newest-first exports are reordered chronologically, duplicate same-time messages
remain distinct, and the export-file family is retained for reconciliation and
deletion.

Attachment-only, unsent/unavailable, malformed, and empty records are counted
separately rather than becoming fake message text. The parser repairs Meta's
known legacy UTF-8 mojibake only when the repair is lossless. It has fixture and
common-ingestion proof, but no current real Facebook export has been accepted.
There is no scraping, cookie capture, developer app, or live Messenger API.

---

## What I will not build

Not "not yet". Not planned.

**Unreviewed permission models.** The product now has exact-document grants and
entity-scoped owner retrieval. New documents are owner-only by default, and a
scoped user sees only explicitly granted documents. That does not authorize an
ad hoc human role hierarchy, folder inheritance, or a connector-specific
permission model. Automation uses a separate fixed profile contract:
librarian, structured-contributor, technician, or break-glass. Those profiles
do not widen a person's document authority, and no automation profile can
execute deletion. Any request beyond the reviewed human or automation
boundaries needs a separate security contract rather than a manifest toggle.

**Developer tools** (issue trackers, support desks, engineering dashboards). Almost nobody in this business segment runs on them, and building for a customer who does not exist is how a product gets slower for the ones who do.

---

## The two options for anything not on the built list

1. **Export it into Drive.** Whatever you can get out as a document, PDF, or spreadsheet gets read like anything else. Unglamorous, immediate, and it covers more cases than people expect.
2. **Push it in directly.** If your system has an export or an API, its contents can be sent straight into your brain. This is a quoted piece of work, and I will tell you the cost before starting rather than after.

---

## How to read this page in six months

I will keep this table current, but status never replaces the proof boundary. If something moves from "not built" to "built", runnable product code and its named automated gate exist. It moves to production-proven only after the exact real-boundary test has a reviewed receipt.

If you are ever unsure whether a source is connected, do not consult this page. Ask your own brain what it holds:

```
node brain.mjs sources <manifest>
```

One line per source: what it is, whether it is pending, loading, ready, or errored, how many documents it holds, and when it last took anything in. It is the only answer that cannot be out of date.

The same command also cross-checks the registry against the authenticated live
document store whenever the install's durable admin key is available:

```
node brain.mjs sources <manifest>
```
