# Message-export document families: a successful ingest ended in a rejected cleanup — evidence

Branch: `fix/family-reconciliation`, worktree `/private/tmp/brain-family-repro`,
branched from `wave0/connector-gaps` at commit `b15e988`. The failing
reproduction is commit `14bfc80` on this same branch; this document is the fix
that turns it green.

## For the owner

A WhatsApp chat export is the one messaging path that works on every platform
today, and it was sold as part of the founding install. Loading one could not
succeed. The documents landed, every one of them, and then the very last step
of the run refused its own cleanup request and exited 1 — so the client saw a
red failure on top of a load that had actually worked, the sync cursor never
advanced, and every re-run repeated the same thing. It applied to all three
message export formats: WhatsApp, SMS Backup & Restore, Google Voice Takeout.

Nobody caught it because the bug was upside down. When the load FAILED, the
cleanup request was empty, which was legal, so it passed. When the load
SUCCEEDED, the request was full, and the full one was the one being refused.
A `--dry-run` never reaches that step at all, so every dry run of these formats
looked perfect. Success failed, failure succeeded, and preview said fine.

The repair is not a loosened check. One file that becomes many conversation
documents now writes down which file each document came from, so the "delete
the stale parts of this file, keep these" instruction refers to something real
instead of to a name nobody stored. The safety check got stronger in the
process, and one line of proof for that is in the discrimination below: with
the check removed, the very same test deletes the entire freshly loaded export.

Nothing is stranded. Because this always failed before the state file was
written, no install can be carrying a half-reconciled export: the next
`brain ingest` re-sends the sessions, stamps the missing link, and settles.

## What was actually wrong

A message export is ONE file that becomes MANY documents, one per conversation
session. `brain.mjs` built that file's reconciliation family as

```
base_doc_uid  = `${sourceName}:${FILE PATH}`
keep_doc_uids = sanitized.map((e) => `${sourceName}:${e.source_id}`)
```

Both halves were wrong, on two different axes:

* **Identity.** A session envelope's `source_id` is `session.first_id`
  (`ingest/message-session.mjs`), a content hash of the session's first
  message. It is not derived from the file path, so it is not a `#part` slice
  of the base.
* **Namespace.** `worker/src/lib/store.js` builds `doc_uid` from the
  ENVELOPE's own `source_type`, and `sessionEnvelope` hardcodes
  `source_type: "message"`. The documents are stored as `message:<first_id>`,
  never as `upload:<first_id>`.

`worker/src/lib/store-d1.js` `forgetFamilies` then refused the plan, because a
keep uid had to equal the base or start with `${base}#part`. Measured values
for `test/fixtures/whatsapp/ios-unambiguous.txt` copied in as
`WhatsApp Chat with Alex Rivera.txt`:

```
base_doc_uid : upload:WhatsApp Chat with Alex Rivera.txt
keep_doc_uid : upload:232ba44cf58b17b4539b4c018d25655e
keep_doc_uid : upload:25644a6ba18aaec6ec68368b302d6414
stored       : message:232ba44cf58b17b4539b4c018d25655e
               message:25644a6ba18aaec6ec68368b302d6414
```

and the CLI's own ending, from the reproduction:

```
fail  Drive split-document cleanup failed (400): HTTP 400: each document family needs a base_doc_uid and any keep_doc_uids must belong to it. The sync cursor was not advanced.
      Re-running the same ingest is safe and will retry the cleanup.
```

## The options, and why option 3

**1. Rename the documents.** Derive each session's `source_id` from the file
path so the base becomes a literal prefix, the way `splitOversized` does.
**Rejected.** `source_id` IS document identity: the citation, the idempotency
key, and the thing a re-sync matches on. The same `sessionEnvelope` also feeds
`cmdIngestImessage`, `cmdIngestWhatsapp`, `cmdIngestIphoneBackup` and the
Supabase migration path, none of which have a file path at all. Renaming would
duplicate every already-ingested session for every client who has loaded any
message history, to fix a bug in one loader.

**2. Relax the prefix check so the current plan is accepted.** **Rejected, and
measured.** The delete scope comes from `base_doc_uid` alone
(`store-d1.js` selects `doc_uid = base OR doc_uid` prefixed by `base#part`).
Keyed on the file path, that scope contained NONE of the `message:<id>` rows.
The reproduction measured it directly:

```
delete scope for base upload:WhatsApp Chat with Alex Rivera.txt: []
```

So a permissive guard would answer 200 and delete nothing: stale sessions from
a previous revision of the same export would be orphaned in the brain forever
while the CLI reported success, and the one signal saying "your family model is
wrong" would be gone.

**3. Make the relationship genuinely true.** **Chosen.** The producer declares
it, the store reads the declaration, and the guard checks membership against
that same declaration:

* `ingest/run.mjs` stamps every document a multi-document file produces with
  `metadata.family_of`, holding the FULLY QUALIFIED uid of the file it came
  from. All three producers (`prepareWhatsAppExport`, `prepareSmsBackupXml`,
  `prepareGoogleVoiceTakeout`) go through one `declareFamily` helper.
* `brain.mjs` reads that declaration back off the SANITIZED envelopes
  (`declaredFamilyUid`) instead of recomputing the key, so the plan can only
  ever name the exact string the documents carry, and builds keep uids as
  `${envelope.source_type}:${envelope.source_id}` — what the store actually
  keys on, and what the Drive and Gmail sites already did.
* `worker/src/lib/store-d1.js` `forgetFamilies` adds a third membership arm to
  the delete scope, an equality on `meta.family_of`, and validates against
  measured membership.

Document identity is untouched. No migration. And the same declaration repairs
a companion defect the reproduction found: `applyDriveRemovals` retracts a
message export by `${sourceName}:${stateKey}` (a private-path-prefix removal,
or a credential-scanner refusal on a re-run), which matched nothing and
retracted none of the session documents. It works now, for free, because the
declaration is what it was missing too.

**Why `family_of` and not the existing `part_of`.** `part_of` means "this row
is one slice of a single logical document". Storage counts a `part_of` family
as ONE logical document (`worker/src/lib/store.js` `stats`,
`worker/src/index.js` source receipts) and collapses it into one inventory slot
(`listSourceFamilies`). Two conversation sessions from one export are two
logical documents with two separate citations, so borrowing `part_of` would
have quietly mis-counted every message export. `family_of` adds the missing
"same origin file" edge without changing what a document is. It is also fully
qualified on purpose: `listSourceFamilies` has to re-derive a source prefix for
the older bare `part_of` values, and that guess is exactly the kind of thing
this bug was made of.

## The invariant that now protects against wrong deletion

> **Every `keep_doc_uid` must belong to the family named by `base_doc_uid`,
> proven either structurally (it IS the base, or one of its `#part` slices) or
> by declaration (its stored row's `meta.family_of` names this exact base).**

Why that is sufficient, and not weaker than the prefix test it replaces:

The delete set is (everything in the family) minus (the keep list). A keep uid
that is not in the family protects nothing. So a caller whose family model is
wrong does not merely no-op — its keep list is inert while the scope is real,
and cleanup deletes the very revision it was called to reconcile. The old
prefix test was a syntactic PROXY for "inside the scope", correct only while
every family was structural. The new test measures the real thing: anything the
old test rejected is still rejected unless the stored document itself declares
membership, which is stronger evidence of belonging than a matching name.
Validation runs before `forget()`, the only mutation in the function, so a
refusal leaves every family untouched.

This mattered MORE after the fix, not less. Before it, the scope for a message
export was empty, so a wrong keep list was merely inert. Now the scope really
does hold every session document, so the guard is the only thing standing
between a wrong keep list and a deleted export. Discrimination C below is that
sentence, executed.

## Test

`test/family-reconciliation-repro.test.mjs` became
`test/family-reconciliation.test.mjs` (`git mv`, so the history follows) and is
registered in the `package.json` `test` chain immediately after
`drive-removal-guard`. 47 checks, up from the reproduction's 15.

It drives the REAL CLI against a scripted brain that runs the REAL
`forgetFamilies` against real `node:sqlite` built from the real
`migrations/d1/*.sql`, wrapped in the same try/catch-to-HTTP-400 as
`worker/src/index.js:1579`. Two fixture changes were needed and both make it
more faithful, not less: it now persists `meta` (the real store does), and the
brain can be file-backed so it OUTLIVES one CLI process, which is what lets a
test re-load the same export into the same brain.

Sections: (1) all five message-export fixtures across all three formats,
(2) the `#part` control, (3) the empty-keep failure-path control,
(4) **protection**, (5-8) end to end including the reload.

Section 4 is the one that must not be weakened. It proves, with real deletes
against real SQLite:

* the freshly-loaded export IS inside its family's delete scope, so the
  refusals below are protecting something real rather than nothing;
* a keep list in the wrong namespace (the exact pre-fix plan) is REFUSED, and
  the revision it would have deleted is still there;
* a keep uid from another family is still refused;
* a document that declares a DIFFERENT family cannot be kept in this one;
* a stale session from a previous revision IS removed while every session of
  the current revision survives;
* retracting the FILE removes every document it produced.

Green, verbatim tail:

```
PASS  the freshly-loaded export IS inside its family's delete scope
PASS  a keep list in the wrong namespace is REFUSED, not silently accepted
PASS  and the revision it would have deleted is still there
PASS  a keep uid from another family is still refused
PASS  and neither document was removed
PASS  a document that declares a DIFFERENT family cannot be kept in this one
PASS  and a document of another family is never in this family's delete scope
PASS  a stale session from a previous revision of the same export IS removed
PASS  and every session of the current revision survived that removal
PASS  retracting the FILE removes every document it produced
...
PASS  re-loading the same export into the same brain exits 0
PASS  re-loading the same export duplicates no documents
PASS  and re-loading deletes none of them either
...
ok  47/47 checks passed
```

## Discrimination

Three reverts. Each one restored afterwards and re-verified.

### A. Revert the whole fix (`brain.mjs`, `ingest/run.mjs`, `store-d1.js`)

`git checkout HEAD -- brain.mjs ingest/run.mjs worker/src/lib/store-d1.js`

```
FAILED  19/47 checks passed
```

exit 1. The message, verbatim, from the store:

```
each document family needs a base_doc_uid and any keep_doc_uids must belong to it
```

and from the CLI, end to end:

```
fail  Drive split-document cleanup failed (400): HTTP 400: each document family needs a base_doc_uid and any keep_doc_uids must belong to it. The sync cursor was not advanced.
      Re-running the same ingest is safe and will retry the cleanup.
```

with the rejected request recorded exactly as the reproduction found it:

```
FAIL  the worker never rejected the reconciliation request  [{"message":"each document family needs a base_doc_uid and any keep_doc_uids must belong to it","families":[{"base_doc_uid":"upload:WhatsApp Chat with Alex Rivera.txt","keep_doc_uids":["upload:232ba44cf58b17b4539b4c018d25655e","upload:25644a6ba18aaec6ec68368b302d6414"]}]}]
```

### B. Revert ONLY the worker (keep the declaration and the plan)

`git checkout HEAD -- worker/src/lib/store-d1.js`

```
FAILED  24/47 checks passed
```

```
FAIL  whatsapp (iOS): the family plan a successful ingest builds is accepted  each document family needs a base_doc_uid and any keep_doc_uids must belong to it
FAIL  whatsapp (iOS): the family reaches every document the brain stored  scope undefined vs stored ["message:232ba44cf58b17b4539b4c018d25655e","message:25644a6ba18aaec6ec68368b302d6414"]
```

Declaring the family is not enough on its own; the delete scope has to read the
declaration or the members are unreachable.

### C. Keep the fix, LOOSEN THE GUARD (delete the validation block, keep the widened scope)

This is the one that matters. It is the shape of the "simplest" wrong fix.

```
FAILED  42/47 checks passed

FAIL  a keep list in the wrong namespace is REFUSED, not silently accepted  it was accepted
FAIL  and the revision it would have deleted is still there  []
FAIL  a keep uid from another family is still refused  it was accepted
FAIL  and neither document was removed  ["drive:F2"]
FAIL  a document that declares a DIFFERENT family cannot be kept in this one  it was accepted
```

Read `and the revision it would have deleted is still there  []` literally: the
live document list is EMPTY. With the guard loosened, the wrong-namespace keep
list is accepted and the entire freshly-loaded export is deleted. In the
`drive:F1` / `drive:F2` case the surviving list is `["drive:F2"]` — the base
document itself was removed while a stranger was kept. This is the exact class
the guard was written to prevent, and the widened scope made it reachable.

### Restored

```
ok  47/47 checks passed
```

## Full suite

```
npm test > /tmp/family.log 2>&1; echo $? > /tmp/family-exit.txt
```

`/tmp/family-exit.txt`:

```
0
```

Zero `FAIL `/`not ok`/`npm error` lines in `/tmp/family.log` (3,683 lines).
The new test runs inside the chain — `/tmp/family.log:625` is
`ok  47/47 checks passed`.

Neighbouring suites re-run individually before the full chain, all passing:
`test/ingest-run`, `test/whatsapp-export`, `test/sms-backup`,
`test/message-session`, `test/drive-removal-guard`, `worker/test/store-d1`,
`worker/test/routes`, `worker/test/store`.

## Scope, and what is deliberately NOT changed

`listSourceFamilies` is untouched. Its only consumers are the Drive completeness
proof (`listStoredSourceFamilies`, called from the Drive sync in `brain.mjs`),
and Drive never writes `family_of` — it splits structurally. Making the source
inventory collapse declared families would change what "one logical document"
means for a source, which is the mis-count `family_of` exists to avoid.

The other three family-plan sites were already correct and are unchanged: the
single-envelope local path, the Drive connector and the Gmail connector all
derive both halves from the same `envelope.source_id` that `splitOversized`
extends, so their bases really are prefixes of their members.

Worth flagging for whoever picks up the connectors: `cmdIngestImessage`,
`cmdIngestWhatsapp` and `cmdIngestIphoneBackup` produce envelopes from the same
`sessionEnvelope` and build NO family plans at all today. The moment anyone adds
reconciliation there, they hit this identical wall, and the answer is the same
one: declare the family, do not loosen the guard.

## Honest limitations

* A document stored before this change carries no `family_of` and therefore
  belongs to no family until it is re-ingested. For message exports this is
  empty in practice: reconciliation always failed, and `die()` fires before
  `recordAcceptedDocumentState`, so `state.done` was never written for one. The
  reproduction confirmed the state file stays `{"version":1,"done":{},"skipped":{}}`
  after a failed run. The next `brain ingest` therefore re-prepares and re-sends
  every session, `d1MetadataChanged` sees the new `meta` and updates the row,
  and the family settles. No migration, no stranded install.
* The scripted brain does not model an `unchanged` ingest result — it re-stores
  and reports `created`. The reload test's claim rests on the DATABASE
  (identical `doc_uid` set before and after, `INSERT OR REPLACE`) and on
  reconciliation reporting `documents: 0`, not on the status string.
* The declared arm of the scope query is a full scan of `documents`. So was the
  existing `substr(doc_uid, ...)` arm, so this adds no scan that was not already
  forced, but neither arm is indexed and a very large corpus will feel it.
