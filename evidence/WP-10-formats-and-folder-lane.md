# WP-10 evidence — five formats, and a folder that reloads itself

Date: 2026-08-28. Branch `feat/formats-and-folder-lane`, built in an isolated
worktree off `wave0/connector-gaps` at `/private/tmp/brain-formats`. Written to
the tracked `evidence/` directory so it survives a fresh clone.

## Why this was not a feature request

Two sentences in the shipped documentation told a client to do something that
did not work, and said nothing when it did not work.

**`onboarding/07-ingest-source-matrix.md`**, in the Zoom section, immediately
after stating that Zoom has no backfill:

> **The zero-build alternative still works, and is the way to load old calls.**
> Save a recording's transcript (the `.vtt` file, or run Otter) into a Drive
> folder you already ingest, and Drive reads it like any other document

There was no `.vtt` extractor. `ingest/extract.mjs` and `ingest/formats.mjs`
between them registered twenty-one extensions and `.vtt` was not one of them, so
the file was skipped with `no extractor for ".vtt" files` and the client's
entire back catalogue of calls silently never arrived. This was the documented
workaround for a gap the connector itself declines to fill, which makes it the
worst place in the product for a false sentence.

**`README.md`**, under "Honest limits, so none of them are a surprise":

> **Outlook .msg and PST are not supported.** Export to .eml or .mbox and load
> the folder.

`.eml` was real. `.mbox` was not registered at all. Half of a sentence sitting
under a heading promising no surprises.

Neither one errored. Both produced a skip line in a report nobody reads line by
line, under a reason that reads like a limitation of the file rather than a
limitation of the product. That is the difference between a missing feature and
an honesty defect, and it is why this pass exists.

Three more formats were unregistered and equally reachable by the same "drop it
in a folder" advice: `.srt`, `.ics`, `.rtf`.

And the advice itself — "drop it in a folder you already ingest", which appears
five times across the documentation — described something the product did not
do unless the folder happened to be inside Google Drive. Everywhere else,
"already ingest" meant "re-run a command by hand, forever".

## What shipped

**Extractors** (`ingest/extract.mjs` registers the four dependency-free ones,
`ingest/formats.mjs` registers the one that needs the mail parser):

| Format | How it extracts | Refuses when |
|---|---|---|
| `.vtt` | `worker/src/lib/vtt.js`, the SAME function the Zoom connector uses | no timed cues, or cues with no text |
| `.srt` | the same shared cue reader, plus SubRip `{\an8}` positioning | no timed cues |
| `.mbox` | split on the From_ delimiter, each message through the existing `.eml` reader | no separator line, or no message readable |
| `.ics` | iCalendar → the shape `renderEvent` already accepts → rendered by the calendar connector's own renderer | not a VCALENDAR, no events, or every event truncated |
| `.rtf` | `ingest/rtf.mjs`, a control-word state machine, no dependency | no `{\rtf` header, or nothing outside the font/style/picture tables |

**The watched folder lane**: `operations/folder-scheduler.mjs`, the third
consumer of the connector-spec abstraction the iMessage lane introduced, plus
`brain schedule <manifest> --install|--status|--remove --folder`,
`corpora.local_folder` and `operations.folder_ingest_cron`.

**Deletions on the local lane**: `removedSinceLastRun` in `ingest/run.mjs`, put
through the same `buildDriveRemovalPlan` guard, the same 100-document and 10%
limits, and the same `--approve-removals <fingerprint>` acknowledgement Drive
uses.

## Reuse, not reimplementation

Three places where the honest answer was to use what already existed.

**The transcript parser.** `vttToPlainTranscript` already existed inside
`worker/src/lib/zoom.js`, and its own header records four bugs it deliberately
did not inherit from the reference implementation it was ported from. Writing a
second one for the ingest path would have started identical and drifted
invisibly: both keep producing text, one slowly gets worse. It moved to
`worker/src/lib/vtt.js`; `zoom.js` imports and re-exports it so every existing
caller and its 71 tests are untouched:

```
$ node worker/test/zoom.test.mjs | tail -1
zoom: all 71 tests passed
```

`.srt` shares the same cue reader rather than getting its own — SubRip is the
same "cue header, then lines, separated by blanks" shape with a comma in the
timestamp, which the reader already accepted. The test asserts the sharing
directly rather than trusting it:

```
PASS  the Zoom connector and the local ingest path use the SAME function
PASS  and therefore produce identical text for identical bytes
PASS  the SubRip reader shares that machinery rather than duplicating it
```

**The event renderer.** `connectors/google-calendar.mjs` already decided, at
length and with reasons written down, how a meeting should read: the "When" line
carrying both the spelled date and the ISO one, rooms separated from people,
declined attendees separated from attendees, an RRULE spelled out in English.
`ingest/ics.mjs` converts iCalendar into the shape that renderer accepts and
then gets out of the way, so an event reads identically whether it arrived
through the connector or as a file. The connector is imported lazily, inside the
extractor, so a folder with no `.ics` in it never loads it.

**The mail reader.** `.mbox` does not parse mail. `ingest/mbox.mjs` splits, and
every message goes through `parseEmailMessage` — the `.eml` path, which already
handles MIME, RFC 2047 encoded subjects and multipart bodies. The `.eml`
registration is now a three-line wrapper over that same function.

## `.mbox` is not one document

An mbox indexed whole is one enormous blob dated by whichever message came
first, whose every citation points at a filename. Split, one archive becomes
many citable documents:

```
PASS  a three-message archive becomes THREE documents, not one
PASS  each document is titled by its own subject
PASS  each document is dated by its own Date header, not the file
PASS  each document has its own citable identity inside the archive
PASS  mbox >From quoting is undone in the body
```

The registry also holds a single-document `.mbox` reader, because the Drive door
cannot express one-file-many-documents. It renders every message through the
same reader and says so in its note: coarser, never different.

One limit moved for this. `MAX_FILE_BYTES` is 8MB, which is right for a single
document and wrong for a mail folder — a real archive is routinely tens of
megabytes, so the very thing the README tells clients to export would have been
skipped for size in the common case. `.mbox` gets `MAX_ARCHIVE_BYTES` (64MB)
instead. It still has a ceiling, because the whole archive is read into memory
to be split.

## Every format refuses rather than ingesting noise

This was the part worth the most care. A registered format that "succeeds" on a
malformed file is a worse defect than an unregistered one, because the skip
report goes quiet and the corpus count goes up.

```
PASS  a .vtt with no cue timings is REFUSED, not indexed as prose
PASS  a .srt with no cues at all is REFUSED
PASS  a file that is not an archive is REFUSED with the reason
PASS  a calendar with no events is REFUSED rather than indexed as its timezone table
PASS  a truncated calendar is REFUSED and says the entries were unreadable
PASS  a plain-text file renamed .rtf is REFUSED, not indexed by accident
PASS  a structurally valid RTF holding only tables and a picture is REFUSED
```

The last one is the interesting case. An RTF is mostly not text: font tables,
colour tables, stylesheets, and often an embedded copy of the document as hex.
Stripping backslashes and printing the remainder yields kilobytes of
`Times New Roman;Arial;Calibri` followed by a megabyte of hex, which clears
every length check and indexes as though it worked. So `ingest/rtf.mjs` walks
the group structure and discards those destinations outright:

```
PASS  the font, colour and style tables are not indexed as text
PASS  an embedded picture's hex payload is not indexed as text
PASS  document metadata destinations stay out of the body
PASS  smart quotes survive the cp1252 escape decoding
```

The same instinct in the calendar reader: a VALARM has its own `DESCRIPTION`,
and reading nested blocks as event properties overwrites the meeting's
description with "Reminder" — a working-looking extractor telling a lie about
the meeting.

```
PASS  a VALARM's own DESCRIPTION does not overwrite the meeting's
PASS  a VTODO is not read as a meeting
PASS  a declined attendee is not reported as an attendee
PASS  a room is a room, not a person
```

## The folder lane is the same mechanism, not a parallel one

`operations/folder-scheduler.mjs` supplies a `SCHEDULER_SPEC` and nothing else.
Atomic plist staging with rollback, the native advisory lock, bounded
symlink-refusing log rotation, the config-hash guard against a stale agent
reading credentials for an edited manifest: all of it is the same code Drive and
iMessage run.

```
PASS  the folder lane is built by the shared buildSchedulerPlan, only its spec differs
PASS  adding it leaves Drive's identity exactly as before
PASS  all three lanes coexist with distinct plists, logs, locks and config hashes
```

The tick runs the ORDINARY local ingest — `brain ingest <manifest> --path
<folder> --source <name>` — rather than a new code path, so it inherits that
command's content-hash resume state exactly. There is no second notion of what
has already been loaded:

```
PASS  a tick invokes lockf around the ordinary local ingest, not a new command
PASS  the first tick loads everything in the folder
PASS  a second tick over an untouched folder sends nothing
PASS  a file dropped in after the first run is picked up on the next tick
PASS  a file whose contents changed is re-sent, and only that file
PASS  a file deleted from the folder is reported as removed, exactly once
PASS  removal is computed from the resume state, not from a second ledger
PASS  an interrupted tick resumes instead of restarting
```

Four things the scheduler refuses at install, each because the failure mode is
silence rather than an error:

```
PASS  a relative folder path is refused, because launchd's cwd is not the client's shell
PASS  a folder that is not on this machine is refused instead of scheduled
PASS  an unsafe source name is refused, since the name is the deletion scope
PASS  repointing the folder after install stops the tick before any child runs
```

## Deletions, and the one behaviour change worth naming explicitly

Before this pass, a local folder ingest never removed a document whose file was
gone. That is fine when a human runs the command and watches it; it is not fine
for an unattended lane, where the brain would drift from the folder forever
while answering confidently from what it kept.

So the local lane now reconciles deletions — through the same aggregate removal
plan, the same limits, and the same approval fingerprint the Drive lane uses.
**This changes existing behaviour for local ingest**: a run whose removals cross
100 documents or 10% of what that source loaded now STOPS and asks, where before
it removed silently. That is deliberate. A cloud folder that failed to
materialize, an unmounted external drive, and an owner deleting everything are
indistinguishable from the outside, and the difference is worth one deliberate
confirmation. `onboarding/06-runbook-top-ten-failures.md` now names the folder
case first, because it will be the common one.

Two guards on the deletion set itself:

- Suppressed entirely under `--limit`. An unexamined file is not a deleted file.
- Computed against paths the walk SAW, including paths it SKIPPED. A file
  skipped this run for being empty, oversized or private has not vanished, and
  removing its document because a skip reason changed is a different decision
  with a different name.

```
PASS  deletions are refused under --limit, where an unseen file is not a deleted one
PASS  a file merely SKIPPED this run does not count as deleted
PASS  every removal reason goes into one plan
PASS  and the plan is approved BEFORE anything is removed
```

## Documentation corrected

Every sentence changed because it was false, or because it was true only until
this pass and would now mislead in the other direction:

| File | What it said | What it says now |
|---|---|---|
| `onboarding/07` | save the `.vtt` into a Drive folder and Drive reads it | it does now, `.vtt`/`.srt`/Otter, in any ingested folder — and the paragraph states plainly that it did not before |
| `README.md` | export to `.eml` or `.mbox` and load the folder | both are read, `.mbox` split per message — and it states that half that sentence was false |
| `README.md` | the format list, ten formats | rich text, mail archives, transcripts, subtitles and calendar exports added, with the split and speaker-preservation behaviour stated |
| `README.md` | "Slack, Notion and meeting transcripts do not exist as connectors" | Zoom exists and transcripts are read from a folder; corrected, with "nothing here transcribes audio" kept explicit |
| `README.md` | Drive can refresh itself on macOS | plus the watched folder, hourly, macOS-only schedule |
| `README.md` | the Drive removal plan | the same plan and limits now cover a local folder, and why |
| `onboarding/07` | "dropped in a folder you already ingest" ×3 | "a folder that is ingested", pointing at the watched folder |
| `onboarding/07` | — | new summary row and a full section for the watched folder, with its five honest limits |
| `onboarding/06` | "Drive cleanup says review required" | source-neutral, and names the not-mounted-folder case first |
| `docs/README-developer.md` | the 21-extension format list | 26, with why `.vtt`, `.ics` and `.mbox` reuse rather than reimplement |
| `docs/README-developer.md` | flags, and private-prefix enforcement | local deletions and the shared approval flag |
| `docs/README-developer.md` | — | new section for the watched-folder scheduler |
| `docs/ARCHITECTURE.md` | "macOS Drive scheduler", `operations/` responsibility, the change map | all three lanes named as one mechanism |

Nothing in the documentation now claims a capability that does not exist. The
claims that remain honestly negative — no OCR, no speech recognition, no Slack,
no Notion, Windows and Linux have no unattended scheduler — were re-read and are
still true.

## Proving the tests discriminate

A test that passes whether or not the code works is decoration. Both new suites
were checked by breaking the thing they exist to protect.

**Unregistering `.vtt`** (removing one line from the registration loop in
`ingest/extract.mjs`):

```
$ node test/formats-extra.test.mjs
FAIL  .vtt is registered, so the walk and Drive triage both stop skipping it  .adoc .csv .docx .eml .htm .html .ics .json .log .markdown .mbox .md .pdf .pptx .rst .rtf .srt .text .tsv .txt .xhtml .xls .xlsm .xlsx .xml
FAIL  a saved meeting transcript reads as speaker-tagged text  {"text":null,"how":null,"unsupported":true,"error":"no extractor for \".vtt\""}
FAIL  a cue wrapped over two lines is joined into one turn  null
FAIL  it is labelled as a transcript, not as plain text  null
FAIL  the WebVTT <v Name> voice span is read as the speaker  null
FAIL  an unattributed cue is still emitted rather than silently dropped  null
FAIL  a .vtt with no cue timings is REFUSED, not indexed as prose  {"text":null,"how":null,"unsupported":true,"error":"no extractor for \".vtt\""}

7 FAILURES
exit=1
```

Seven failures, and the first one reproduces the original defect verbatim:
`no extractor for ".vtt"` — the exact string a client's skip report carried. The
`.srt` cases kept passing, which is the right shape: the break was scoped to one
extension and only that extension's tests noticed. Restored:

```
$ node test/formats-extra.test.mjs | tail -1
formats-extra: all 63 tests passed
```

**Breaking the folder tick** (dropping `--source` from `childArgumentsOf`):

```
$ node test/folder-scheduler.test.mjs
FAIL  a tick invokes lockf around the ordinary local ingest, not a new command
FAIL  the folder lane's tick argv is the documented ingest command

2 FAILURES
exit=1
```

Both the behavioural assertion and the source assertion caught it. Restored:
`folder scheduler: all 42 tests passed`.

## Full suite

Registered in the `package.json` chain: `test/formats-extra.test.mjs` after
`ingest-run`, `test/folder-scheduler.test.mjs` after `imessage-scheduler`.

```
$ npm test > /tmp/formats.log 2>&1; echo $? > /tmp/formats-exit.txt
$ cat /tmp/formats-exit.txt
0
$ grep -c "^PASS" /tmp/formats.log
2704
$ grep -n "formats-extra: all\|folder scheduler: all\|ingest-run: all\|zoom: all\|package contains" /tmp/formats.log
561:PASS  published package contains 345 reviewed files and no client-private paths
2340:ingest-run: all 82 tests passed
2405:formats-extra: all 63 tests passed
2982:folder scheduler: all 42 tests passed
3600:zoom: all 71 tests passed
```

105 new assertions. The five new shipped files carry their
`test/package-privacy.test.mjs` allowlist entries in the same commit, and every
name in every fixture is invented.

## What could NOT be proven here

- **No macOS LaunchAgent was actually loaded.** The scheduler tests use a
  scripted `launchctl` closure and a sandbox home, exactly as the Drive and
  iMessage suites do. The generated plist is checked by `plutil -lint` on
  darwin, so it is valid; that it survives a real `launchctl bootstrap` on a
  client machine over days is a field gate, not a test result.
- **No real client corpus was ingested.** Every format was proven against
  fixtures written for this pass. Real exports are messier: an Outlook-written
  `.mbox`, a `.vtt` from a tool nobody has seen yet, an RTF from a version of
  Word that predates the escapes handled here. Expect the first real corpus to
  surface something, and add a fixture for it rather than widening a regex.
- **The 64MB archive ceiling is untested at scale.** The largest `.mbox` in
  these fixtures is roughly a kilobyte. Splitting a genuinely large archive is
  bounded but not measured, and its peak memory is real.
- **The mboxrd un-quoting choice is a judgement.** `>From ` is unescaped by
  stripping exactly one `>`, which is reversible for mboxrd and lossy for mboxo.
  A genuine reply line that begins with "From " in an mboxo archive loses one
  `>`. That trade is documented in `ingest/mbox.mjs`; it is not free.

## The paragraph that belongs to whoever owns this next

I did not find these two sentences by auditing the code. I found them by reading
the documentation as a client would and then checking whether the product agreed
with it, and the product did not, in two places, one of which was the documented
workaround for a gap we had already admitted to. That is a bad way for a client
to find out, and it is the failure mode this product is supposed to be immune
to, because our whole posture is that we tell people what we cannot do.

The mechanism that let it happen is worth naming: nothing connects a sentence in
`onboarding/` to the extension registry in `ingest/`. A format list in prose and
a `register()` call in code can disagree forever without any test noticing.
`docs/README-developer.md` now carries the accurate list, and
`test/formats-extra.test.mjs` asserts each of the five extensions is genuinely
in the registry, which catches a deletion. Neither catches the case that
actually bit us: someone writes a helpful sentence recommending a format nobody
registered. If a future pass wants one durable improvement here, it is a test
that reads the file-extension tokens out of the shipped documentation and
asserts every one of them either extracts or is named as unsupported in the same
breath. That would have caught both of these on the day they were written.
