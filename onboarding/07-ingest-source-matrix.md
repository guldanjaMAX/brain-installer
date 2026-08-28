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
| WhatsApp | **Built, as an export.** Your phone's own "Export chat" .txt, dropped in a folder you already ingest. No live capture, no daemon, no third-party app risk |
| Text messages (Android, and Google Voice) | **Built, as an export.** SMS Backup & Restore's .xml export, or a Google Voice Takeout, dropped in a folder you already ingest |
| iMessage (Mac) | Not built yet. **Apple only exposes message history on a Mac; there is no path on Windows.** Sprint 1 |
| Facebook Messenger | Not built as a product |
| Zoom | Not built as a connector. **Zero-build v0 available today**, see below |
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

**The honest production boundary:** the connector has passed the product test suite but has not yet completed a real-mailbox production run. The packaged unattended scheduler is currently Drive-only, so Gmail refresh is manual until that scheduler is extended. Treat Gmail as built but not yet production-proven.

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

If your meetings are on Zoom instead, see the Zoom entry below — the same zero-build pattern (transcript into Drive) works there too, it just takes one setting change on your account rather than being automatic.

### WhatsApp

**Built, as an export — not a live connection.** WhatsApp's own per-chat "Export chat" produces a `.txt` file (choose "without media"). Drop it in a folder you already ingest with `brain ingest <manifest> --path <folder>`; it is detected automatically by its content, not by asking you to say what it is, and loaded as sessionized conversation documents rather than one giant wall of text.

**What it does not do:** there is no live capture installed for you today. A new message sent after you exported does not appear until you export again. The capture daemon half of a live connection now exists in this codebase (`daemons/whatsapp/`, built and tested), but the installer wiring that would actually set it up on your machine does not yet, so nothing about your install changes. Worth knowing before you ever ask for it: pairing as a linked device sits in a WhatsApp terms-of-service gray area with a real (if small) account-ban risk, and the history it captures at link time is only whatever window your phone chooses to transfer — typically weeks to months, never your full archive (the export path above is how you get that). If continuous capture matters enough to be worth the risk, ask, and we can talk about it explicitly, disclosure included, rather than it happening by default.

**The one real gotcha, handled rather than ignored:** WhatsApp writes its export date in whatever order your phone's regional setting uses, with no marker saying which. "3/4/26" is March 4th on a US phone and April 3rd on nearly every other phone in the world. This is resolved automatically from the fact that a chat is chronological — every date in the file is checked for a reading that stays in order start to finish — and on the rare export too short or too regular to tell, it is refused rather than guessed, so you never end up with a chat silently misdated by weeks. You would see that refusal named in the ingest skip report if it happens.

### Text messages (Android, and Google Voice)

**Built, as an export, same posture as WhatsApp above.** Two sources:

- **Android:** the SMS Backup & Restore app (free, on the Play Store) exports your whole message history as one `.xml` file, covering every conversation, not just one.
- **Google Voice:** a standard Google Takeout export of your Voice data includes one page per conversation.

Either one, dropped in a folder you already ingest, is detected automatically and loaded the same sessionized way WhatsApp is. Unlike WhatsApp, neither format has a locale-dependent date to get wrong: both write an exact, unambiguous timestamp, so there is no disambiguation step here, only correct reading of it.

**iPhone note:** this Android path does not apply to you if you carry an iPhone. Your texts arrive through the iMessage connector instead, once it exists (see below) — turn on Text Message Forwarding and SMS rides in for free alongside iMessage. There is no live SMS-only path for an iPhone without a Mac in the loop.

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

### iMessage, and Facebook Messenger

**Not built as an installed product yet.** WhatsApp and SMS both have a built export path today (see Built, above); iMessage and Messenger do not.

**iMessage live capture requires a Mac in the loop, and there is no way around that.** Apple only exposes your message history to a local app through `chat.db`, which exists on macOS and nowhere else. If your business runs entirely on Windows, this connector, when it exists, will not help you directly — it needs a Mac physically present to run on, even if the rest of your install is elsewhere. A one-time history load from an encrypted iPhone backup (no Mac needed for that specific path) is planned separately for exactly this reason. Personal messaging capture of this kind exists in my own brain today; it is not yet part of what is installed for a client, and I am not going to pretend otherwise because it works on my machine.

Facebook Messenger has no export or capture path built at all yet, live or otherwise.

### Zoom

**Not built as a connector, but there is a zero-build path that works today.** Turn on cloud recording with an audio transcript for your Zoom account, and save the transcript (the `.vtt` file, or run Otter) into a Drive folder you already ingest. Drive reads it like any other document, exactly the way Google Meet's own Gemini notes already do with no setup at all. This covers "what did we discuss on that call" from day one.

The real connector — a webhook on your own Cloudflare worker that fetches each transcript automatically the moment a recording finishes, no manual save — is planned and requires your Zoom account to be on a paid plan with cloud recording. Until then, the manual save above is the honest v0.

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
