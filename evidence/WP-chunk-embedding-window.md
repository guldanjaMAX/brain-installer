# The ceiling on every answer: chunks longer than the embedding window

Closes issue #12. Branch `fix/issue12-truncation`, worktree branched from
`wave0/connector-gaps` at `e132615`.

## What the issue claimed, and what is actually true

The issue reports that `/diagnose` on a field install found 951 of 1,001 chunks
"long enough to be cut before embedding", past roughly 1,800 characters, and
asks for three things: chunking that fits the window, a re-embed path for
existing corpora, and an owner-visible figure.

Two of those three are exactly as reported. The first is partly stale and, more
importantly, **the measurement behind the number is the wrong unit**, which
changes what the fix has to be.

**Stale:** commit `4f8f1fc` had already moved the chunker from 2000/500 to
1500/300 characters, so a corpus loaded after it cannot produce a chunk past
1,800 characters and the diagnostic can no longer fire at all. The 951/1,001
reading came from a corpus loaded under the older geometry.

**Not stale, and worse than reported:** the model's ceiling is counted in
TOKENS, and nothing anywhere in this product counted tokens. `grep -n token`
across `store.js`, `store-d1.js` and `supabase.js` found one comment and one
character threshold. The diagnostic compared `length(text)` to 1,800; the
chunker sliced at 1,500 characters; `embedText` sliced at 8,000 characters and
handed the result to `@cf/baai/bge-base-en-v1.5`, a BERT-base encoder with 512
positions, which reads the first 510 content tokens and silently drops the rest.

Characters and tokens agree only on English prose. Measured on the real chunker
before this change, with a lower bound that is provable rather than estimated
(BERT's BasicTokenizer splits on whitespace and isolates punctuation and CJK;
WordPiece only ever expands those pieces further, so the count below can never
exceed the true one):

```
geometry: size=1500 overlap=300  model window=510 content tokens
the old diagnostic threshold was: length(text) > 1800 CHARACTERS

material         chars/chunk  chars/chunk  PROVEN tok    PROVEN tok   old char
                 (old cut)    (new cut)    (old cut)     (new cut)    diagnostic
----------------------------------------------------------------------------------------
meeting prose    1521         1463         292           281          reads clean
ledger rows      1520         842          505           280          reads clean
json log         1521         623          823 CUT       332          reads clean
japanese notes   1521         413          1505 CUT      397          reads clean
```

Read the `json log` row: a 1,521-character chunk whose minimum possible token
count is 823 against a 510-token ceiling. The model read roughly the first
sixty percent of it. The Japanese row is worse: about a third. And the
right-hand column is what the product said about all four — **reads clean**.

So the honest summary of the state before this change is: the character fix
narrowed the damage on prose and made the instrument that was supposed to
measure the damage permanently silent, on exactly the dense material — ledgers,
logs, transcripts with identifiers, anything not in a Latin script — where the
damage was worst.

Two smaller mechanisms found on the way:

- **The header was spent outside the budget.** `chunkText` sliced 1,500
  characters and then prepended `[Title]\n\n`, so a "1,500 character" chunk was
  embedded as 1,521 characters. Visible in the table above.
- **`reindex` cannot repair this.** It re-queues existing `chunk_uid`s and
  embeds the SAME text (`INSERT INTO vector_outbox ... SELECT c.chunk_uid ...
  FROM chunks c`). Running it on a truncated corpus re-embeds the same truncated
  heads. There was no path that re-cut stored text.

## 1. Chunking that fits the window

`worker/src/lib/chunking.js` is new and has no imports at all. It holds the
geometry, the token measurement, and the window generator.

A window now ends at whichever comes first: the character cap, the token budget,
or the end of the document — and the budget is charged for the header too. The
step is a proportion of the window rather than a fixed character count, so a
window that shrank to fit dense text does not also collapse its step and emit
ninety percent redundant chunks.

The measurement is deliberately split into two functions, because they are not
equally certain and pretending otherwise would be the same defect in a new
place:

- `basicTokenFloor()` is a **proven lower bound**. When it clears 510 the chunk
  IS cut, and the product says so in those words.
- `estimateEmbedTokens()` is an **estimate**, and is called one wherever it
  surfaces. Running the real WordPiece tokenizer would mean shipping a
  30k-entry vocabulary into a Worker, and without the vocabulary no useful
  upper bound exists. The estimate is biased to over-count (about 1.2 to 1.4x
  on English prose), a property test pins it above the provable floor on 500
  random adversarial strings, and `EMBED_TOKEN_BUDGET = 400` leaves a further
  110 tokens of margin under the real ceiling.

Two consequences that had to be handled rather than discovered in the field:

- **The pre-write statement estimate is now exact.** It used to be a closed form
  over the character length, which is only safe while every window is the same
  width. Dense text now produces several times the chunks its length suggests,
  and an estimate that reads low is a batch the Worker refuses with a 413 after
  the caller has committed to sending it. `chunkCount()` runs the real window
  generator; `ingest/envelope-batching.mjs` imports it instead of keeping a
  hand-copied mirror, so drift is impossible rather than merely tested for.
- **`splitOversized` splits on statements as well as bytes.** A 400,000
  character part of Japanese estimates at 2,509 statements against an 810
  ceiling and could never be sent. ASCII is unchanged: 1,000,000 characters
  still splits into exactly 3 parts of 677 statements each.

**The chunk content hash was deliberately NOT bumped.** Geometry is part of the
hash, so bumping it would re-chunk and re-embed every document in every install
on its next routine sync — a corpus-sized bill nobody asked for, triggered by an
unrelated command. New and changed documents get the new chunker automatically;
everything else is repaired by the explicit path below.

## 2. `brain refit` — the repair for corpora already loaded

`POST /api/admin/brain/refit`, `refitChunks()` in `store-d1.js`, migration
`0017_chunk_token_fit.sql`.

It works from what D1 already holds and never from the original files, for the
same reason `reindex` does: the source folder may be gone, changed, or was never
on this machine. Each stored chunk body is re-split where it exceeds the budget.
Nothing is merged and no new overlap is introduced, so the union of stored text
is unchanged and only the boundaries inside a chunk move.

How it is bounded:

| Concern | What holds it |
|---|---|
| Cost | Documents whose chunks already fit are **measured, not re-embedded**. A refit of a healthy corpus queues zero embeddings; the test asserts the stored text is byte-for-byte identical afterwards. |
| Spend | `spendBudgetStatus(env)` is consulted **before the first write**. The refit does not call the model itself, it queues work the drain will bill to the client's own account, and queueing against a budget already spent is spending it later. Over cap it refuses with 503 and writes nothing. |
| Resumability | The cursor is a `doc_uid` in `install_state`. One page of documents per call, default 25, hard maximum 200. An interrupted run continues; it does not restart. |
| Accidental firing | Dry run is the default, like `forget`. `--yes` is required, and no other command calls it. |
| Data loss | Splitting only ever produces MORE chunks, so the rewrite is a renumbering that moves text to higher indexes. Rows are written in **descending index order**, so every write's content still exists at its old, not-yet-overwritten index when the write lands. A crash mid-document can leave duplicated text, never missing text, and re-running repairs it. `chunkText({trim: false})` exists for this caller alone: overlapping ingest windows can afford to drop whitespace at a boundary, a refit with no overlap and no source file cannot. |
| Concurrency | Guarded on the document's current `content_hash`. An ingest that lands mid-refit wins outright — its own re-chunk is already correct — and every refit statement becomes a no-op rather than half a fight. |

## 3. What the owner now sees

This is the half the issue calls the honesty half, and it is the reason the
defect survived: a partly-searchable corpus was indistinguishable from a
complete one. Every document counted, every chunk had a vector, every probe
answered, and the answers looked plausible because the head of each chunk did
embed. The only symptom was that retrieval felt mediocre, which reads as an
opinion about quality rather than as a fault.

`chunks.embed_tokens` is written at ingest, so the figure is one indexed
aggregate rather than a scan of every chunk body. It has **three** states, and
the third is the point: NULL means never measured, and a corpus loaded before
this version has an unknown amount of unreachable text. Unknown is never folded
into the good half, so the headline percentage is a FLOOR with the remaining
uncertainty stated beside it.

One sentence, produced by one function (`renderSearchability`), used by
`brain refit`, the acceptance suite and the monthly report, so those three can
never quietly disagree about the same install:

```
--- what the owner is told, on the field corpus shape (951 of 1001 cut) ---
at least 5% of this corpus is fully searchable (50 of 1001 pieces, estimated).
951 piece(s) are longer than the embedding window, so part of what they say can
be found by keyword and never by meaning; 25 of the 25 longest were checked and
every one of those is definitely cut.

--- and on a corpus loaded before this version ---
how much of this corpus is fully searchable is UNKNOWN: it was loaded before
this brain could measure it. Unknown is not the same as fine.

--- after `brain refit` ---
at least 100% of this corpus is fully searchable (2380 of 2380 pieces, estimated).
```

Where it reaches an owner:

- **The monthly report** gets its own section, "How much of it can actually be
  found", with the consequence spelled out in plain language: *"a piece that
  runs past what the search index can read keeps its ending stored but
  unfindable by meaning. You would never see this in an answer: the brain
  replies confidently from the part it did read."*
- **`brain health`** gains a tier-2 check, "the whole of each document is
  searchable" — FAIL when chunks are over the window, WARN when the corpus is
  unmeasured, PASS only when it is measured and whole. It flows into the report's
  checklist and its "What needs you" list for free.
- **`brain diagnose`** — the old `oversized_chunks` finding was filed under
  *efficiency* at *info* level, worded as a note about storing text wastefully.
  Unreachable text is not wasteful storage. It is now `unsearchable_tails`,
  under **coverage**, at **crit**, and it names `brain refit` as the repair.

## Discrimination

The old character-only cut restored into `chunkText`, header appended after the
slice, everything else untouched. `node --no-warnings test/chunk-fit.test.mjs`:

```
FAIL  so the chunker cuts the dense document into more pieces than the prose one  1 vs 1
FAIL  prose: the header is inside the budget, not added on top of it  worst estimate 418 of 400
FAIL  ledger rows: no chunk is past the model's window, provably  worst floor 517 of 510
FAIL  ledger rows: the header is inside the budget, not added on top of it  worst estimate 736 of 400
FAIL  ledger rows: the end of the document lands in a chunk the model can read whole  517
FAIL  japanese: no chunk is past the model's window, provably  worst floor 1453 of 510
FAIL  japanese: the header is inside the budget, not added on top of it  worst estimate 1456 of 400
FAIL  japanese: the end of the document lands in a chunk the model can read whole  1130
FAIL  armed, it repairs the document
FAIL  the repair produced more pieces than it started with  4 rows, added 0
FAIL  every repaired piece is inside the model's window, provably  684
FAIL  and every piece now carries its measurement
FAIL  every repaired piece is queued for embedding  0
FAIL  the owner-visible figure moves from unknown to whole
FAIL  a second run repairs nothing and queues nothing
FAIL  every document was repaired across the three calls
chunk fit: 16 of 57 FAILED
```

Sixteen of fifty-seven, and the three named materials fail separately, so the
tests discriminate on the token measurement rather than on one fixture. Restored
to `chunk fit: all 57 tests passed`.

## Suite

`npm test` — exit code read from its own file, because piping to `tail` masks
it:

```
$ npm test > /tmp/tr-final.log 2>&1; echo $? > /tmp/tr-final-exit.txt
$ cat /tmp/tr-final-exit.txt
0
```

## For the owner, in one paragraph

Your brain stores long documents in pieces, and the search index can only read a
certain amount of each piece. Until now nothing checked whether a piece was
longer than that, so on documents that are dense with numbers, identifiers or
non-English text, the end of each piece was being stored but could never be
found by meaning. You would not have noticed: the brain answers confidently from
the part it did read, and every other health check passes. Your monthly report
now tells you what proportion of your corpus is whole, says plainly when a
number is an estimate, and says "not yet measured" rather than "fine" when it
does not know. If any of it needs repair, `brain refit` fixes it from what is
already stored, without your original files, and skips everything that is
already fine so you are not billed for work that is not needed.
