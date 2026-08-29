# WP-11 evidence — a scanned PDF can now be read, and says that it was

Date: 2026-08-28. Branch `feat/ocr-for-scans`, built in an isolated worktree off
`wave0/connector-gaps`. Six new files, twenty edited. No version bump and no
CHANGELOG heading: a human is integrating several branches, so the owner-voice
paragraph is at the bottom of this file instead.

Seventeen percent of the data sources named in the customer research are paper
or scans. One owner's accountant drives over to collect a box of documents every
month. Another writes cheques by hand. Until this branch, a scanned PDF was
refused outright, which meant deposit slips, old tax filings and handwritten
registers — the actual substance of those businesses — were invisible to the
brain.

---

## 1. The day-zero question, settled before anything else was written

**Can a PDF page be rasterised to an image in Node with no native module?**

**Yes, for the population that matters, and by a route that is not the obvious
one.** Measured in this worktree, Node v24.13.1, unpdf 1.8.1, against synthetic
image-only PDFs built byte by byte.

**The obvious route is closed.** `unpdf`'s `renderPageAsImage` requires
`@napi-rs/canvas`, an optional native peer dependency that is not installed:

```
renderPageAsImage: Parameter "canvasImport" is required in Node.js environment.
```

Taking it would mean shipping per-platform native binaries inside a
`bundleDependencies` tarball, against the design law stated at the top of
`ingest/extract.mjs`: this runs on the client's own machine during a live
install, and every package is one more thing that can fail on their Windows box
while someone watches. That was not done, and no dependency was added.

**The second route works, and `unpdf`'s `extractImages` is not it either.** A
scanned page IS one big image object; there is nothing to rasterise, only
something to fetch. But `extractImages` filters on
`data.length / (width * height)` being exactly 1, 3 or 4
(`node_modules/unpdf/dist/index.mjs:237-242`), and measured here:

| Fixture | PDF.js `kind` | ratio | `extractImages` |
|---|---|---|---|
| 8-bit DeviceRGB scan | 2 (RGB_24BPP) | 3.000 | keeps |
| 8-bit DeviceGray scan | 2 (RGB_24BPP) | 3.000 | keeps |
| **1-bit fax / photocopier scan** | **1 (GRAYSCALE_1BPP)** | **0.125** | **DROPS** |

One bit per pixel is eight pixels to the byte, so the ratio is 0.125 and the
image is silently skipped. That is exactly the fax and photocopier population
this feature exists for: older bank statements, county records, anything that
went through a fax machine. Using `extractImages` would have shipped a feature
that worked on the easy scans and quietly failed on the valuable ones.

So `ingest/page-image.mjs` goes one level down to the same PDF.js surface unpdf
uses (`getDocumentProxy` + `getResolvedPDFJS`, both already exported by the
already-bundled unpdf), expands packed 1-bit rows itself, composites RGBA onto
white, box-averages down to 1600px, and encodes an 8-bit greyscale PNG using
`fflate`'s deflate — also already bundled. **Zero new dependencies. Zero native
modules.**

Verified byte-correct, not merely non-empty: the PNG was decoded back and the
ink landed on exactly the rows the fixture painted, for both the 8-bit and the
1-bit source.

```
depth=8 160x100 bitdepth=8 colourtype=0 filter0=true darkPixels=2720 inkRows=20..39 (fixture painted rows 20..39)
depth=1 160x100 bitdepth=8 colourtype=0 filter0=true darkPixels=2720 inkRows=20..39 (fixture painted rows 20..39)
```

Greyscale is deliberate. Colour carries nothing a transcription needs and
triples both the upload the client pays for and the image tokens they pay the
model to read.

**The brief's other named trap was confirmed and avoided.** `env.AI.toMarkdown()`
is not used anywhere in this branch. Its PDF path does no OCR, and its image
path runs a *captioning* prompt — a statement page through it comes back as
prose about a document rather than the document. Indexing that as content would
be the exact fabrication this product exists to refuse. The reasoning is written
into `worker/src/lib/ocr.js` so the next person does not have to rediscover it.

---

## 2. What was built

**The refusal is now an attempt, and the refusal is still the last word.**
`ingest/formats.mjs:extractPdf` used to return one sentence when a PDF had no
text layer. It now tries OCR first and falls back to that same sentence, byte
identical in its opening phrase, whenever OCR does not earn a better answer.

The pixels are produced inside the existing disposable child process
(`ingest/pdf-child.mjs`), which already holds the document open and already
exists to keep PDF.js's late promise rejections away from ingest. The parent
asks for images with `--images=<n>` and only when there is an OCR callback to
send them to, so **the 79% of PDFs that read normally pay nothing for this.**

The model runs through `POST /api/admin/brain/ocr` on the client's own worker,
using their own `[ai]` binding — never a vendor service and never Cloudflare's
REST API from the CLI. That choice buys three things at once: the daily spend
cap already applies, every call lands in `llm_call_log` under the label `ocr`,
and routine ingest needs no standing Cloudflare control-plane token.

New files: `ingest/page-image.mjs`, `ingest/ocr.mjs`, `worker/src/lib/ocr.js`,
`migrations/d1/0018_extraction_provenance.sql`, `test/ocr.test.mjs`,
`test/fixtures/scan-pdf.mjs`.

---

## 3. The marking, and why it needed a column

`documents.meta` is free-form JSON and is persisted faithfully, so
`{ ocr: true }` there would have satisfied the letter of "flag it" and failed
the point entirely: **both retrieval queries select a fixed column list, and the
citation object is built from that list.** A flag in `meta` sits in D1 and never
reaches the reader.

So migration 0018 promotes two columns onto `documents`, following the
`date_source` / `date_reliable` precedent exactly — date trust travels with
retrieval because trust that does not travel is not trust:

- `text_source` — `native` | `ocr` | `ocr_partial`
- `text_reliable` — defaults to 1, always 0 for OCR

They are threaded end to end: extractor → `extract()` → envelope → `store.js`
upsert → both retrieval SELECTs → the `/think` citation → the confidence rubric.
Three consequences a reader actually sees:

1. **The document body says so.** OCR'd text opens with `[OCR] The text below
   was read from a scanned image by a machine...` and every page carries
   `[[page N | OCR]]`, so the marking is in the chunk itself and cannot be
   separated from the passage by any retrieval path.
2. **The answering model is told.** Evidence read by OCR is labelled
   `READ BY OCR FROM A SCAN, may be misread` in the context it receives, so it
   hedges a figure it was handed rather than repeating it as printed.
3. **Confidence drops and says why.** `-12` for OCR, `-18` when some pages could
   not be read, with a basis line naming it. Measured: 85% → 73% → 67% on the
   same single-document, reliable-date answer.

Provenance is last-write-wins, unlike `client`/`category`. A document
re-extracted from a real text layer stops being marked as a scan — asserted in
the tests, because preserving the old value would keep asserting a reading that
has since been redone.

---

## 4. Garbage, defined, and the thresholds defended

Removing the refusal introduces a failure **worse than an empty document: a
wrong one.** A vision model asked to look at a page defaults to *describing* it.
"This appears to be a bank statement showing several transactions" is fluent
English, passes every existing text-quality check in this repo, and is a
complete fabrication of a document nobody transcribed.

Garbage is a disjunction of named conditions, each individually defensible.

**Page level** (`judgePage`):

| Condition | Why it is garbage | Why the threshold is where it is |
|---|---|---|
| **Narration opener** | The single most dangerous outcome, because it reads as prose and passes everything else | Matched only against the first 160 characters, and only as a *prefix*. A transcription can legitimately contain "the image shows" inside a quoted memo; a narration starts at the top. Asserted both ways. |
| **Immediate repeat loop** | A decoder that lost the page | 8 consecutive identical lines. Deliberately **not** the unique-word ratio used by `quality.mjs`: a real bank statement page is legitimately repetitive (a column of dates, "Debit" over and over) and a ratio test would throw away the document type that matters most. A test pins that a real statement page survives. |
| **Replacement characters > 5%** | The decode went wrong | Same figure `quality.mjs` already uses for extracted text. |
| **Under 12 legible characters** | The page said nothing | Classified `blank`, **not** a failure. A near-empty page (the back of a form, a separator sheet) is ordinary inside a scanned bundle, and blanks leave the denominator so they cannot drag a document into refusal. |

**Digit density is recorded, never a refusal trigger.** The failure mode "the
model skipped the numbers" is real and is the most dangerous silent error for a
financial document, but refusing a page for having no digits would refuse a
cover letter. It lowers confidence and is reported per page instead.

**Document level** (`assembleOcr`), refuse if any:

1. **No page read at all.** A model that narrates does it on every page, so this
   is the branch a fully-wrong document actually takes.
2. **More than 50% of attempted pages unreadable** (`MAX_UNREADABLE_SHARE`).
   Set deliberately in the empty middle of the distribution rather than near
   either end. A working run fails on the odd page (a photograph, a stamp), well
   under a tenth. The dangerous failure fails on essentially *every* page, at or
   near one. **Nothing realistic sits at 0.5**, which is exactly what a
   threshold should be able to say for itself. Below the line, each failed page
   is named inline as `[[page N: could not be read — why]]`, so nothing is
   silently lost; above it the document is refused whole rather than indexed
   half-read and cited as one document.
3. **Under `MIN_CHARS_PER_PAGE` (100) characters per page.** Not a new number:
   it is the product's own existing, measured line between a document and a
   scan, derived from text-PDFs averaging 1,600 to 2,000 characters per page.
   **OCR text clears the same bar a native text layer has to clear.** A scan
   does not get an easier bar, which is what makes "indexed" mean one thing
   rather than two.

Refusals keep the original opening phrase byte for byte —
`no text layer: this is a scanned PDF (N pages of images).` — and append what
was tried, so operator muscle memory and the existing assertion in
`test/ingest-run.test.mjs` both still match.

**A model error is never evidence about the document.** A spend-cap hit, a
provider refusal or a transport failure is marked `fatal` and rethrown, so the
source cursor stays retryable rather than a permanently wrong "unreadable"
reason being written into resume state. A per-page 5xx is different — it *is*
about that page, and is counted and reported inline.

**Confidence is a coverage number and says so.** It is the share of attempted
pages that came back readable, docked for the illegible regions the model itself
flagged, capped. It is explicitly **not** a model self-rating: those are
uncalibrated, and passing one off as confidence would be the same dishonesty
this whole path guards against. Every input is reported in `per_page`, so a
reader can recompute it and disagree with the arithmetic rather than with an
oracle.

---

## 5. The spend guard, and how cost is surfaced

**The cap binds because OCR goes through `callLLM`, not around it.** Asserted
directly: a route call against a ledger already over budget returns 429 with
`llm_cap_exceeded: true`, and the CLI turns that into a fatal error that blames
no document.

**A real pricing bug was fixed on the way.** `callLLM` priced every Workers AI
call at the answer model's rate. The OCR model is $0.10/$0.30 per M tokens
against llama's $0.293/$2.25 — charging OCR at llama rates would overstate its
spend roughly **3x on input and 7.5x on output**, stopping a run that had spent a
fraction of its budget and telling the owner they had hit a limit they were
nowhere near. There is now a per-model rate table, and an unknown model is
priced at the *dearer* rate so the cap cannot fail quiet.

**Cost is surfaced before the run, not after.** `brain ingest` prints the model,
the per-document page ceiling, and a cost-and-time line before the first page is
sent:

```
100 scanned pages: about $0.03 to $0.08 on your own Cloudflare account, and roughly 1.7 to 5 minutes of model time. The estimate is a range because Cloudflare does not publish an image token count for this model.
2000 scanned pages: about $0.64 to $1.52 on your own Cloudflare account, and roughly 33.3 to 100 minutes of model time. ...
20000 scanned pages: about $6.40 to $15.20 on your own Cloudflare account, and roughly 333.3 to 1000 minutes of model time. ...
```

Two honest notes in that output. It is a **range**, because Cloudflare does not
publish an image-token count for this model and this build could not measure one
without a live client account; a single figure would look like knowledge it is
not. And **time is the real cost**, not money — a 2,000-page filing cabinet is
a dollar and change but up to an hour and a half of waiting, which is what the
owner actually feels. Progress is therefore reported **per page**, not per file,
because a forty-page scan under a per-file progress line looks hung and the
first client to see that will kill it.

**OCR is off by default** at three independent layers: the manifest schema
default, the worker route (409 with an explanation when `OCR_ENABLED` is unset),
and the CLI callback (null unless the manifest turns it on, and always null on
`--dry-run`, so the safest command stays the cheapest). An upgrade cannot
quietly start spending on a client's account.

**Turning it on forces one full Drive sweep.** `drivePolicyFingerprint` now
includes the OCR state. Without that, a scanned PDF refused a month ago would
never be looked at again: once a change token exists the incremental feed only
returns files that *changed*, and a document sitting untouched in a folder has
not. It was deliberately **not** added to `credentialScannerFingerprint`, which
looks interchangeable and is not — that flag also arms a refusal on missing
files, a refusal on `--limit`, and a re-send and re-embed of the whole corpus.
Wrong blast radius by a wide margin.

**Custody holds.** A page image may only reach a `@cf/` model on this worker's
own AI binding. `callLLM` refuses before any request leaves if the model is not
Cloudflare's or the binding is absent, and the tests assert that zero requests
reached Anthropic in both cases.

---

## 6. Can a scanned bank statement reach the financial ledger?

**Not today, and the reason is a good one. This was measured, not assumed.**

`ingest/bank-export.mjs` requires a delimited file with a header row, a
detectable date column, and a sign convention **established from something in
the file itself** — it refuses to guess which column is the amount, on the
stated grounds that guessing is "a larger failure wearing a smaller face." OCR
output is prose lines. Fed to it directly:

```
OCR text as .csv:  ok=false
  refusal: no column is named as a date (columns present: "[OCR] The text below was read from a scanned image by a machine", ...)
raw page as .csv:  ok=false
  refusal: no column is named as a date (columns present: "RIVER ROAD COMMUNITY BANK          Statement period 01 Mar to 31 Mar")
OCR text as .ofx:  ok=false
  refusal: this file has no <OFX> element, so it is not an OFX or QFX bank export
```

That refusal is correct behaviour and it is why nothing was built here to force
it through. **What would be required, stated rather than built:**

1. **A scanned-statement-to-rows extraction pass** that reads transactions from
   prose rather than from columns and lands anything it cannot parse as
   `unparsed` and flagged rather than guessed. The `fin_*` schema and the
   CSV/OFX/QFX importer now exist; this distinct OCR-to-ledger path does not.
2. **Page attribution, which this branch already provides.** Every page carries
   `[[page N | OCR]]` in the text and a per-page record in metadata, so a future
   `fin_transactions.page` reference is reachable without redoing WP-11.
3. **Two provenance vocabularies kept separate.** WP-11's `text_source` answers
   *how the text was obtained*. The ledger's `provenance` answers *where the figure
   came from*. Collapsing them would have to be unpicked; they are already
   distinct.
4. **A numeric confidence a future OCR-to-ledger pass can threshold** — provided, per document, with
   its derivation stated.
5. **Digit fidelity is the real risk.** The reconciliation promise is that an
   OCR'd month and a bank feed agree to the penny. One transposed digit becomes
   a false discrepancy report. This is why `text_reliable` is 0 for every OCR'd
   document by default and why digit density is recorded per page: so a mismatch
   is attributed to the reading, not to the bank.

---

## 7. Tests, and proof they discriminate

`test/ocr.test.mjs` — **96 checks, registered in the `npm test` chain** after
`test/formats-extra.test.mjs`. It covers the three required fixtures and more:

- **A clean scan** is rendered, sent, read, marked, stored, and comes back out
  of retrieval marked.
- **A poor scan** (the model described the page) is refused in the product's own
  voice, with the original opening phrase intact.
- **A text-layer PDF** is asserted to send **zero** pages to the model, to carry
  no OCR provenance, and — separately — that with no OCR callback the child is
  never even asked to render. Needless spend is treated as a defect.
- Custody, the cap, the route gates, the CLI callback contract, the cost model,
  the Drive fingerprint, and the confidence penalty.

The storage half runs against a **real SQLite database with the real
migrations**, not a mock, because the claim being made is about a stored row.

`test/connector-rehearsal.test.mjs` — the placeholder that defined "done" for
this package is now a real assertion. A synthetic scanned bank statement goes
through the shipped extractor and comes out marked. The **native**-statement
placeholder correctly stays `notDone`, with the measured ledger refusal above as
its reason.

`test/diagnose.test.mjs` — three new checks for the OCR-coverage finding.

### A real bug the tests caught that a stub would have hidden

Driving the actual child process, not a stub, surfaced this:

```
"error": "no text layer: this is a scanned PDF (1 page of images). OCR was attempted and its pages could not be rendered (DataCloneError)."
```

**PDF.js detaches the ArrayBuffer it is handed**, so the bytes were gone by the
time the text result came back and the second open failed. It surfaced as "its
pages could not be rendered", which reads as a fact about the client's document
and is not one. Fixed by keeping a copy, and only when images were asked for.

A second real bug: `full` is a reserved word in SQLite (`FULL OUTER JOIN`), so
the new diagnose aggregate was a syntax error. The existing `safe()` wrapper
turned it into a visible warn finding instead of a crash — the design working —
and `test/diagnose.test.mjs` caught it in the full run.

### Discrimination: the marking was disabled and the tests failed

**Mutant 1 — kill the marking at the storage boundary.** In
`worker/src/lib/store.js`, `textSource` forced to `"native"`:

```
FAIL  the OCR mark SURVIVED into the stored document  {"source_id":"scans/statement.pdf","text_source":"native","text_reliable":0}
FAIL  retrieval returns the provenance beside every result  [["notes/plain.md","native"],["scans/statement.pdf","native"]]
94/96 checks passed
```

**Mutant 2 — kill the marking at its source.** In `ingest/ocr.mjs`,
`text_source` forced to `"native"`, `text_reliable` to `true`, and the `[OCR]`
banner removed from the body:

```
FAIL  the text announces itself as OCR  [[page 1 | OCR]]
FAIL  provenance says ocr, not ocr_partial  native
FAIL  and the text is explicitly NOT reliable
FAIL  one bad page in three is indexed as PARTIAL, not as whole
FAIL  the stored text is marked as OCR in the body itself
FAIL  provenance travels out of the extractor  {"text_source":"native","text_reliable":true,...}
FAIL  extract() forwards the provenance instead of dropping it  {"text_source":"native","text_reliable":true,...}
89/96 checks passed
```

The rehearsal test caught the same mutant independently:

```
FAIL  and it is MARKED as OCR, so a citation from it is not mistaken for real text  {"text_source":"native","text_reliable":true,...}
```

Both mutants reverted; both suites back to 96/96 and 38/38, and `git diff --stat`
confirms no mutant text survives.

---

## 8. Named unknowns, not smoothed over

1. **The image input shape for `@cf/google/gemma-4-26b-a4b-it` is NOT verified
   against a live account.** The model page confirms Vision as a capability and
   the $0.10/$0.30 pricing used here, but its usage examples are text-only and
   it does not document the image field. Two shapes exist in the wild. Rather
   than guess once and fail silently, the shape is a **named switch**:
   `visionMessages()` defaults to the OpenAI-compatible content array and
   `OCR_IMAGE_FORMAT=image_field` selects the other. The route reports which
   shape it sent and returns the provider's error **verbatim**, so a wrong guess
   costs one call and one environment variable rather than an afternoon. This is
   the first thing to check on the first real install.
2. **Image tokens per page are bracketed, not measured.** `env.AI.run` already
   returns `usage`, which is logged, so the first real run measures it. The
   estimate is labelled a range everywhere it appears until then.
3. **Real-world accuracy on handwritten cheques, deposit slips and faxed
   statements is unmeasured.** No fixture and no measurement exists. Nothing in
   the README, the matrix or this file makes an accuracy claim. The honest
   outcome for a handwritten courtesy amount may well be "flagged low
   confidence" rather than "read correctly", and the design treats that as a
   pass rather than a failure.
4. **The 7% band was left alone.** PDFs with a sparse text layer (under 100
   chars/page) are still indexed with a caveat rather than re-read by OCR.
   Overwriting working sparse text with worse OCR text is a real regression
   risk, and deciding when OCR should win needs a measurement this build does
   not have.
5. **Brain check.** Queried before building. The brain confirms the
   refuse-rather-than-index decision was deliberate, records the 70-PDF sample
   (14% pure scans), and prices the roadmap item at 1.5 to 3 weeks with
   statement-to-rows parsing as the expensive 60% — consistent with leaving the
   ledger half not-done. Reported gap: no iMessage or email coverage, so
   anything agreed by phone or in person is invisible to it. One brain lesson
   describes `legible_ratio` and `single_char_ratio` signals that **do not exist
   in this tree's `ingest/quality.mjs`**; the code was read rather than trusted.

---

## 9. Full chain

```
npm test > /tmp/ocr-full.log 2>&1; echo $? > /tmp/ocr-full-exit.txt
```

Exit code read back **from the file**, because piping through `tail` masks it:

```
exit code, read back from the file:
0
--- FAIL count:
0
```

---

## For the owner

Your brain can read paper now. Point it at a folder of scans and it will do what
it could not do last week: open the picture of a page, read what is printed on
it, and put that into the same index as everything else. It runs entirely inside
your own Cloudflare account, on your own model, and nothing leaves it.

Three things it will always tell you, because a machine reading a photograph is
not the same as reading a file. Every document it read this way is marked as
read by OCR, and every answer that leans on one says so and is scored lower for
it, so a blurry read never looks like a clean one. Any page it could not read is
named in the text where the page should be, rather than quietly missing. And if
the reading comes back as nonsense, or as a description of your document instead
of the words on it, the file is refused exactly the way it was refused before
any of this existed. It would rather hand you nothing than hand you something it
made up.

It is switched off until you switch it on, because it costs money on your
account, roughly a dollar for two thousand pages, and it will tell you what a
run will cost and how long it will take before it starts. Turn it on with
`safety.ocr.enabled` in your manifest.

One thing it cannot do yet, said plainly: a scanned bank statement becomes
searchable text, but its figures do not land in the financial ledger. Reading
transactions out of a picture of a statement, accurately enough that they can be
added up and reconciled to the penny, is a separate piece of work. Until it
exists, the honest answer is that the statement is findable, not that it is
counted.
