# What your brain can read, and what it cannot

The honest version. If a source is not on the built list below, assume it is **not connected**, and do not let anyone, including me, imply otherwise in a proposal.

I would rather lose a sale to an honest table than win one and spend week three explaining.

---

## Summary

| Source | Status |
|---|---|
| Google Drive | **Built.** In production |
| Direct upload and API push | **Built.** The fallback for anything with no connector |
| Google Calendar | **Specified, not built.** Next in the queue |
| Gmail | Built: `brain connect google --scopes gmail`, then `brain ingest --from gmail`. Incremental via historyId; bulk mail excluded by default. Not yet run against a real mailbox |
| Slack | Not built. Priced separately when it is |
| Notion | Not built |
| Microsoft 365, Outlook, SharePoint, OneDrive | Not built |
| Dropbox | Not built |
| QuickBooks | Not built |
| HubSpot and other CRMs | Not built |
| Airtable | Not built |
| Text messages, WhatsApp, Messenger | Not built as a product |

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

---

## Specified, not built

### Google Calendar

**Status: designed, not written. One to two days of work, and it is next.**

Why it is next: your brain already holds transcripts and email threads, and it is currently **inferring** who works with whom from how often names appear together. Calendar hands that over directly. Who met, when, how often, for how long, and with whom.

It rides the Google permission you already grant, so it costs no additional setup on your side beyond a checkbox.

Same publishing consideration as the rest of your Google connection: on Workspace it registers inside your own organization and simply works. On a personal gmail.com address the app must be published, or access is revoked every seven days.

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

### Text messages, WhatsApp, Messenger

**Not built as a product.** Personal messaging capture exists in my own brain. It is not part of what I install for you, and I am not going to pretend otherwise because it works on my machine.

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

For the raw numbers straight from the brain, bypassing that registry entirely:

```
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://<your brain>/api/admin/brain/documents
```
