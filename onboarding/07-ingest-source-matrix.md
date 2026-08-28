# What your brain can read, and what it cannot

The honest version. If a source is not on the built list below, assume it is **not connected**, and do not let anyone, including me, imply otherwise in a proposal.

I would rather lose a sale to an honest table than win one and spend week three explaining.

---

## Summary

| Source | Status |
|---|---|
| Google Drive | **Built.** In production |
| Direct upload and API push | **Built.** The fallback for anything with no connector |
| Gmail | Built: `brain connect google --scopes gmail`, then `brain ingest --from gmail`. Incremental via historyId; bulk mail excluded by default. Not yet run against a real mailbox |
| Google Calendar | Built and wired: `brain connect google --scopes calendar`, then `brain ingest --from calendar`. Incremental via Google's own sync token; cancelled events are removed, not left behind. Not yet run against a real calendar |
| Meetings (Google Meet) | **Built, with no extra work.** Meet's own Gemini notes land as a transcript document in Drive, which is already read |
| WhatsApp | **Built two ways.** The safe one: your phone's own "Export chat" .txt, dropped in a folder you already ingest, no daemon and no account risk. The other: `brain connect whatsapp --accept-risk`, live capture through a paired linked device, Mac-only, off unless you turn it on, and carrying a real terms-of-service risk described below. **Never yet run against a real WhatsApp account** |
| Text messages (Android, and Google Voice) | **Built, as an export.** SMS Backup & Restore's .xml export, or a Google Voice Takeout, dropped in a folder you already ingest |
| iMessage (Mac) | **Built, Mac-only, live.** `brain connect imessage`: Full Disk Access verified by a real read, full history loaded, then scheduler-tick capture (a new message lands within about a minute, not instantly). **Apple only exposes message history on a Mac; there is no path on Windows** |
| iPhone messages, no Mac (Windows too) | **Built, as a one-time history load.** `brain ingest --from iphone-backup` reads an **unencrypted** local iPhone backup and loads the iMessage and SMS history inside it. A point-in-time snapshot, **not** live capture: nothing new arrives afterwards. Runs on Windows and macOS. Never yet run against a backup Apple wrote |
| Facebook Messenger | Not built as a product |
| Zoom | **Built.** `brain connect zoom`: a webhook on your own worker loads each cloud-recording transcript automatically. **Needs a paid (Licensed) Zoom seat** — the free tier cannot cloud record at all. New recordings only, no backfill. Not yet run against a real Zoom account |
| Slack | Not built. Priced separately when it is |
| Notion | Not built |
| Microsoft 365, Outlook, SharePoint, OneDrive | Not built |
| Dropbox | Not built |
| QuickBooks | Not built |
| HubSpot and other CRMs | Not built |
| Airtable | Not built |

---

## Built

### Google Drive

Connected with **read-only** access. It can look at documents. It cannot change, move, or delete anything, and that is enforced by the permission itself rather than by good behavior.

**What it reads:**

| Type | How |
|---|---|
| Google Docs | Full text |
| Google Sheets | Cell contents as rows |
| Google Slides | Text from the slides |
| PDF | Text layer |
| Word (.docx), PowerPoint (.pptx), Excel (.xlsx) | Full text |
| Plain text, Markdown, JSON, XML, YAML | As written |

**What it does not read, and why:**

| Type | Why not |
|---|---|
| Images, video, audio | No text to read. There is no transcription step |
| Scanned PDFs with no text layer | **There is no text recognition.** A scanned contract is a picture of a contract to this system |
| Code, stylesheets, build output, lockfiles | Matches a lot of questions and answers almost none of them. Left out deliberately, because it crowds real documents out of your results |
| Database dumps and backups | Same reason, larger. One dump can flood an index and make everything else harder to find |
| Anything in a folder whose name starts with `_Private` | Owner-only by convention. Never read, enforced in two independent places |
| Anything you excluded at intake | Excluded at the source. It is never read, not read and filtered |
| Files whose names suggest credentials | Anything looking like a key file, an environment file, or a certificate is refused by name before it is opened |

**How it stays current:** scheduled refreshes are normally incremental. A complete Drive comparison runs at least weekly and whenever source policy or folder changes require it. Re-running is safe: a document that has not changed since last time is skipped rather than duplicated.

**When a file disappears from Drive**, the matching material is removed from your index. That removal is guarded: if the run could not see all of your Drive (a permissions blip or a network failure mid-walk), it cannot complete the comparison. If one cleanup plan is more than 100 documents or more than 10% of the stored Drive corpus, it stops before deleting anything or advancing its cursor. The owner sees aggregate reasons and an opaque plan fingerprint, never file names or IDs, and must approve that exact plan on the rerun. A stale document costs nothing. A wrongly emptied index costs everything.

**One honest note about how this runs.** Drive is a standard, packaged connector inside the installer, not a private script. You connect your own Google account once, load it with the normal ingest command, and on macOS the installer can schedule unattended refreshes. The Google sign-in still requires the account owner, and the packaged unattended scheduler is not built for Windows or Linux yet.

### Gmail and email

Built as a connector. Connect your Google account with the Gmail scope, then run the normal Gmail ingest command. Later runs are incremental through Gmail's history cursor, and bulk mail is excluded by default.

**The honest production boundary:** the connector has passed the product test suite but has not yet completed a real-mailbox production run. The packaged unattended scheduler currently covers Drive and iMessage, not Gmail, so Gmail refresh is manual until it is extended. Treat Gmail as built but not yet production-proven.

Shared mailboxes and group threads contain messages from people who never agreed to be indexed. Your material stays in your own accounts throughout, which handles most of the exposure, but a business indexing a shared inbox should have a written note about it. Cheap to write now, expensive to retrofit after an employee asks.

### Direct upload and API push

Anything you can turn into text can be put into your brain directly, one document at a time or in bulk. This is the fallback for every source with no connector, and it always works.

Everything arriving this way passes the **credential gate**: if a document contains a live password or API key, it is refused, the kind of credential is named, and its value is never quoted back. Nothing is written. That gate runs on every door into your index, because a gate on one door is not a gate.

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

Later runs are incremental through Google's own sync token, same idea as Gmail's historyId. A cancelled meeting is removed from your index, not left behind as a stale document. By default it reads your primary calendar; more than one calendar, or a shared one, is a manifest setting.

**The honest production boundary, same shape as Gmail's:** the connector and the command that runs it have both passed the product test suite (223 tests on the connector's own logic, 15 more on the command that drives it against a scripted fake calendar), but neither has completed a real-calendar production run yet. Treat it as built but not yet production-proven.

Same publishing consideration as the rest of your Google connection: on Workspace it registers inside your own organization and simply works. On a personal gmail.com address the app must be published, or access is revoked every seven days.

### Meetings (Google Meet)

**No connector needed, because Google already writes the transcript where your brain already looks.** Turn on Gemini notes for a Meet call (or take notes yourself and save them), and the transcript lands as a document in your Drive. Drive ingest reads it like anything else. Nothing to connect, nothing to authorize beyond what Drive already has.

If your meetings are on Zoom instead, there is a connector for that — see the Zoom entry below. It needs a paid Zoom seat and about ten minutes of setup, and the same zero-build pattern (save the transcript into Drive) works there too if you would rather not set anything up.

### WhatsApp

**Built, as an export — not a live connection.** WhatsApp's own per-chat "Export chat" produces a `.txt` file (choose "without media"). Drop it in a folder you already ingest with `brain ingest <manifest> --path <folder>`; it is detected automatically by its content, not by asking you to say what it is, and loaded as sessionized conversation documents rather than one giant wall of text.

**Also built, and deliberately hard to turn on: live capture.** `brain connect whatsapp <manifest> --accept-risk` pairs this machine with your WhatsApp account as a linked device, the same way WhatsApp Web does, and from then on captures new messages continuously into the brain. It is off unless you ask for it twice: the manifest has to declare `corpora.whatsapp.enabled`, and the command needs `--accept-risk` on top of that. Leave both alone and nothing about your install changes.

**Read this before you turn it on, because it is the part that can cost you something.** Pairing works by joining your account with a reimplementation of WhatsApp's own protocol rather than an official API. WhatsApp's terms do not bless unofficial clients, and accounts using them carry a real, if historically small, risk of being warned or banned. Nobody can quantify that risk for you, and anyone who tells you it is zero is selling something. If losing this WhatsApp account would hurt, use the export path above instead. Separately: the history you get at pairing time is only the window your phone chooses to transfer, typically weeks to a few months, never your full archive. There is no setting that asks for more. The export path is how you get the full history of a chat that matters.

**What live capture actually needs, stated plainly:** a Mac, and a daemon binary you build yourself. The capture process is kept alive by a per-user LaunchAgent, and no Windows service or Startup-task supervision is built in this installer — the daemon itself compiles for Windows, so that is a missing installer rather than a missing capability, but nothing here will pretend to install something it cannot keep running. There is also no download-on-connect: how a signed binary should reach a client machine is an open decision, so today you either build it from this checkout (`cd daemons/whatsapp && ./build.sh`) or point the command at a binary you already have with `--daemon`. If it is absent, `brain connect whatsapp` says so and installs nothing.

**How it behaves once running:** a resident daemon holds the connection and writes every message to a local file on your own machine; a separate once-a-minute pass moves them into the brain. So a new message is answerable within about a minute, not instantly. Nothing is stored anywhere except your machine and your own brain, and the daemon itself holds no keys of any kind. Voice notes, images and video are captured as markers only, never transcribed, and a marker with no caption never becomes a document. `brain sources` shows the load, `brain forget --source whatsapp` removes it, and `brain disconnect whatsapp` stops both processes, loads whatever was still waiting, and leaves your phone's link in place for you to end from the phone.

**What has NOT been proven, and you should weigh it:** no part of live capture has ever run against a real WhatsApp account. The drain, the resume-after-interruption behaviour, the install and uninstall, and the wizard's reading of the daemon's output are all tested against fixtures, thoroughly. But a genuine pairing, a genuine history transfer, and a genuine live message have not happened — those need a phone scanning a QR code, and that has not been done yet. Treat live capture as first-run software until someone has done it.

**The one real gotcha, handled rather than ignored:** WhatsApp writes its export date in whatever order your phone's regional setting uses, with no marker saying which. "3/4/26" is March 4th on a US phone and April 3rd on nearly every other phone in the world. This is resolved automatically from the fact that a chat is chronological — every date in the file is checked for a reading that stays in order start to finish — and on the rare export too short or too regular to tell, it is refused rather than guessed, so you never end up with a chat silently misdated by weeks. You would see that refusal named in the ingest skip report if it happens.

### Text messages (Android, and Google Voice)

**Built, as an export, same posture as WhatsApp above.** Two sources:

- **Android:** the SMS Backup & Restore app (free, on the Play Store) exports your whole message history as one `.xml` file, covering every conversation, not just one.
- **Google Voice:** a standard Google Takeout export of your Voice data includes one page per conversation.

Either one, dropped in a folder you already ingest, is detected automatically and loaded the same sessionized way WhatsApp is. Unlike WhatsApp, neither format has a locale-dependent date to get wrong: both write an exact, unambiguous timestamp, so there is no disambiguation step here, only correct reading of it.

**iPhone note:** this Android path does not apply to you if you carry an iPhone. With a Mac, your texts arrive through the iMessage connector (see above) — turn on Text Message Forwarding and SMS rides in for free alongside iMessage. Without a Mac, the iPhone backup load below is the way in, and it is history only. There is no live SMS path for an iPhone without a Mac in the loop, and there is not going to be one.

### iMessage (Mac only)

**Built, as live capture on a Mac — and only on a Mac, with no way around that.** Apple only exposes your message history to a local app through `chat.db`, which exists on macOS and nowhere else. If your business runs entirely on Windows, this connector does not help you directly — it needs a Mac physically present and awake to run on, even if the rest of your install is elsewhere. The one thing that does work without a Mac is a **one-time history load from an unencrypted local iPhone backup**, which is a separate thing described below and is a snapshot rather than live capture.

**What `brain connect imessage <manifest>` does, in order:** verifies Full Disk Access by actually reading the database (macOS requires a one-time grant on the exact Node binary; the command prints the precise steps and refuses to install anything until a real read succeeds — it never guesses), runs the full history load in the foreground so you see its counts, then installs a per-user LaunchAgent that runs a short capture tick about once a minute.

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

**How it works.** You create a Server-to-Server OAuth app in **your own** Zoom account and copy four values it shows you. `brain connect zoom` checks them against Zoom for real, writes them as secrets on **your own** Cloudflare worker, then runs Zoom's own validation challenge against your worker to prove the endpoint will pass before you paste its URL into Zoom. After that, Zoom notifies your worker each time a recording's transcript is ready, and your worker fetches that one transcript and stores it. We hold none of it: not the Zoom app, not the four credentials, not the recordings.

**What lands, and what does not:**

- **New recordings only. There is no backfill.** Meetings recorded before you connect stay where they are; nothing sweeps your Zoom account for past recordings. To bring old calls in, use the manual path below.
- **Cloud recording with audio transcript must be on** in your Zoom recording settings, for the meetings you want read. A meeting that was not cloud recorded produces nothing, and a recording with transcription turned off produces nothing.
- **The transcript only.** Not the audio, not the video, not a summary, and no analysis of the call. One meeting becomes one searchable document.
- **Speaker labels come from Zoom**, so people appear under whatever display name they joined with.
- **It arrives when Zoom says it is ready**, which is typically several minutes after the call ends and can be longer for a long meeting. This is Zoom's own transcription lag, not a delay we add.
- **Nothing about who attended.** Participant lists are a different Zoom permission and are not requested.

The load is the named source `zoom`, so `brain sources` shows it and `brain forget <manifest> --source zoom` removes every transcript it loaded. `brain disconnect zoom <manifest>` deletes the four secrets from your worker, which makes the webhook refuse every further delivery; removing the subscription inside your Zoom app is yours to do, and the command tells you where.

**The zero-build alternative still works, and is the way to load old calls.** Save a recording's transcript (the `.vtt` file, or run Otter) into a Drive folder you already ingest, and Drive reads it like any other document — exactly the way Google Meet's own Gemini notes already do with no setup at all.

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

---

## Not built

Named plainly, with what it would actually take, so you can plan around it rather than wait for it.

### Slack

**Not built, and it will be priced separately when it is.**

Not an authentication problem, a rate limit one. Since March 2026, apps outside Slack's marketplace are throttled hard enough that reading a history takes months rather than hours. The workable path is you creating an app inside your own workspace, which keeps normal speed but needs admin rights and a guided walkthrough. That is real work and it gets quoted as real work.

### Microsoft 365, Outlook, SharePoint, OneDrive

**Not built.** This is the biggest gap in the list and the most honest thing on this page.

If your business runs on Microsoft rather than Google, **this product is not ready for you today.** That is a disqualification, not a roadmap promise with a date attached. When it is built, it will also require that the person signing the agreement is the global administrator of your Microsoft tenant, because if your IT is outsourced, consent becomes a support ticket at a company I have no relationship with.

### Notion

**Not built.** The usual reason a Notion connection looks broken is under-sharing: the integration can only see pages explicitly shared with it, so it silently returns a fraction of the workspace. When this is built it will report how many pages it can actually see, so that failure is visible on day one instead of week three.

### QuickBooks

**Not built.** Highest unique value on this list, because it is the only source with ground truth on who paid and what things actually cost. It is also gated behind an Intuit review queue that has to start well before any code is written.

### HubSpot and other CRMs

**Not built.** When it is, it will be built as a shape (contacts, deals, activities, notes) rather than one vendor, because this is the most fragmented category in the list and no two businesses use the same tool.

### Dropbox, Airtable

**Not built.** Both are straightforward when the demand justifies them. Airtable in particular needs the meaning of your tables mapped by hand, so it gets quoted as configuration work rather than a connection.

### Facebook Messenger

**Not built,** as a product, in any form — no export parser, no capture path, live or otherwise.

---

## What I will not build

Not "not yet". Not planned.

**Document-level permissions.** Everyone who can ask your brain a question can reach anything it has read. There is one level of access, and there is no version of this where your bookkeeper sees the invoices but not the HR folder.

This is a genuine change to how the system is built, not a setting. If your situation needs it, this product is wrong for you, and I would rather say so before you pay me than discover it in week three. I asked about this at intake for exactly this reason.

**Developer tools** (issue trackers, support desks, engineering dashboards). Almost nobody in this business segment runs on them, and building for a customer who does not exist is how a product gets slower for the ones who do.

---

## The two options for anything not on the built list

1. **Export it into Drive.** Whatever you can get out as a document, PDF, or spreadsheet gets read like anything else. Unglamorous, immediate, and it covers more cases than people expect.
2. **Push it in directly.** If your system has an export or an API, its contents can be sent straight into your brain. This is a quoted piece of work, and I will tell you the cost before starting rather than after.

---

## How to read this page in six months

I will keep this table current, and the status column is the only thing that matters. If something moves from "not built" to "built", it moved because it was built and tested against real infrastructure, not because it was planned.

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
