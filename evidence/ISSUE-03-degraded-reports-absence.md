# Issue #3 evidence — a degraded index no longer reports itself as an empty brain

Date: 2026-08-28. Branch `fix/issue3-degraded-reports-absence`, built in an
isolated worktree off `wave0/connector-gaps`. Two new files, eight edited. No
version bump and no CHANGELOG heading: a human is integrating several branches
tonight, so the owner-voice paragraph is at the bottom of this file instead.

## The defect, as reported

On a field install, every query returned zero results with `degraded="vector"`
while the index was still projecting — including the word `the`, against 61
documents and 1,001 chunks. `/api/rag/think` answered:

```json
{"type": "no_results",
 "detail": "The brain has nothing on this query. Say so plainly rather than inferring."}
```

That instruction is honest in form and false in fact. A consumer following it
tells the owner they have nothing on file about their own financial records
while sixty one documents sit in the store. It is a confident false negative
produced by the exact discipline the product is built on, and to the client it
is indistinguishable from a correct answer.

## What was actually wrong, layer by layer

**1. `worker/src/lib/store-d1.js`.** The `degraded` computation was correct and
its comment already named the hazard: a caller that cannot tell the cases apart
"will report a degraded brain as an empty one." What it could not do was say
WHICH fault it saw. `"vector"` covered both "the projection is still building,
which is the normal state of every brain for its first hours" and "the vector
query failed." Those call for different sentences downstream, so the signal was
too coarse to build an honest sentence on.

**2. `worker/src/index.js`, the think route.** The real defect. On zero results
it emitted the `no_results` gap unconditionally. It passed `degraded` through as
a sibling field, but the GAP TEXT is what a consuming model acts on, and that
text asserted absence with no reference to the sibling. Note that the
`vector_unavailable` gap added in v0.1.19 is prepended *after* this early
return, so it never fired on the zero-result path at all.

**3. `components/brain-mcp.mjs`.** Zero occurrences of the word `degraded`. This
is the file `brain setup` wires into the client's Claude Code and Codex, so on
the surface where the client actually asks questions, the one signal that would
have revealed the truth was dropped on the floor. Worse, the tool added its own
absence instruction on top: `"The brain has nothing on this. Report that as the
finding, in those terms."`

Two further consumers of the same path were found by grepping `no_results` and
by reading every reader of an empty `/think` body:

**4. `worker/src/lib/app-page.js`** rendered `"The documents do not answer the
question."` whenever `answer` was null. On `/app` that sentence is the whole
output the owner sees.

**5. `brain.mjs` `cmdAsk`** printed the same sentence, then labelled the
confidence line `"Confidence nothing is recorded: 58% (moderate)"`. It did warn
`search is degraded: vector` two lines later, but the headline had already made
the claim, with a percentage attached to it.

## The design choice: two statuses, not a softened one

The tempting fix is to hedge the refusal so it covers both cases. That was
rejected. The honest "nothing recorded on this" answer is the product working,
it is the hard part, and blurring it to cover a system failure would trade one
dishonesty for another. So the two cases are separated at the source and stay
separate all the way out:

- **Search completed, matched nothing** — unchanged, byte for byte. Same gap,
  same wording, same refusal confidence. `worker/test/degraded-absence.test.mjs`
  pins the exact string.
- **Search did not complete** — a distinct `status: "search_unavailable"`, a gap
  typed `search_unavailable`, and text that never reads as no-evidence.

New module `worker/src/lib/retrieval-status.js` owns that decision so no surface
can pick up half of it. Every layer derives its wording from there.

Two smaller judgements inside it:

**An unrecognised degradation still counts as unavailable.** A future failure
mode this module has never heard of must not fall through to "the brain has
nothing," which is precisely the bug. Unknown values get a generic cause naming
the token.

**No refusal confidence is published when the search did not run.**
`refusalConfidence` answers "how sure are we that nothing is recorded." When
nothing was read, that question has no answer, and a percentage on it would
dress the failure up as a finding. The field is omitted; the notice and the gap
carry the truth. Both client renderers are null-safe already.

## The fix

| Layer | File | Change |
|---|---|---|
| 1 | `worker/src/lib/store-d1.js` | `degraded_reason` alongside `degraded`: `projection-incomplete`, `vector-query-failed`, `embedding-unavailable`. `degraded` keeps its existing values — it is a wire field older clients read. |
| 1 | `worker/src/lib/store.js` | Same field on the legacy adapter, plus `keyword-search-unavailable` for its `fts` case. Shape contract comment now says why `degraded` is load-bearing. |
| 2 | `worker/src/lib/retrieval-status.js` | **New.** Statuses, causes, remedies, the two sentences, and `retrievalUnavailable()` for clients. |
| 2 | `worker/src/index.js` | `/think` zero-result branch routes through `emptyRetrievalDisclosure`. `/unified` gains the same `status` + `notice` on a zero-row degraded search. |
| 2 | `worker/src/lib/confidence.js` | `gapAdjustments` now penalises ANY degradation, not only `"vector"`. `no-embedding` and `fts` were previously pricing in at full confidence. |
| 3 | `components/brain-mcp.mjs` | `degraded` and `search_status` on both `brain_think` and `brain_search`. Notes swapped. Server instructions carry the exception. Tool descriptions say what a zero count with `search_unavailable` means. |
| 4 | `worker/src/lib/app-page.js` | Render logic extracted into three pure functions behind `render-contract` sentinels; a degraded empty result renders the notice. |
| 5 | `brain.mjs` | `cmdAsk` prints the notice and suppresses the confidence-in-absence line. |
| — | `report-html.mjs` | `search_unavailable` gets its own title and `fail` tone, so a client report cannot collapse it into "Nothing matched". |

### Version skew is handled deliberately

An MCP server or CLI on the client's machine can be newer than the worker it
points at. A worker deployed before this change sends `degraded` but no
`status`, and its old `no_results` gap still carries the poison text. So
`retrievalUnavailable()` treats "empty body carrying any degradation" as
unavailable whatever the worker called it, and `brain_think` **replaces** rather
than appends to the gap list. An older worker plus a current MCP is safe. This
is pinned by three checks labelled `VERSION SKEW`.

## Evidence

Same fixture, same query, same still-projecting index. Before, from the
unmodified tree (`git stash`, run, `git stash pop`):

```json
{
  "mode": "think",
  "degraded": "vector",
  "answer": null,
  "citations": [],
  "results": [],
  "gaps": [
    {
      "type": "no_results",
      "detail": "The brain has nothing on this query. Say so plainly rather than inferring."
    }
  ],
  "confidence": {
    "percent": 58,
    "band": "moderate",
    "basis": [
      "retrieval found no candidates at all",
      "vector index not fully query-ready"
    ]
  }
}
```

After:

```json
{
  "mode": "think",
  "degraded": "vector",
  "status": "search_unavailable",
  "notice": "The search could not be completed, so this is not an answer about what your brain holds. Cause: the vector index is still building, so the semantic half of this brain was never queried. Nothing here means your brain is empty on this question. Try again once `brain drain` reports the projection complete.",
  "answer": null,
  "citations": [],
  "results": [],
  "gaps": [
    {
      "type": "search_unavailable",
      "degraded": "vector",
      "detail": "The search could not be completed: the vector index is still building, so the semantic half of this brain was never queried. This is a system state, NOT a finding about the corpus. Do NOT say or imply that the brain has nothing on this question, and do not answer from your own knowledge instead. Say that the search could not be completed, name the cause, and offer to retry."
    }
  ]
}
```

## The tests

`worker/test/degraded-absence.test.mjs`, 64 checks, registered in the
`package.json` chain after `worker/test/health-honesty.test.mjs`.

The MCP checks spawn the real `components/brain-mcp.mjs` as a subprocess against
a loopback stub brain and drive it over JSON-RPC on stdio. Not a stub of the
tool surface: the tool surface. The `/app` checks lift the three render
functions out of the served HTML between the `render-contract` sentinels and
execute them.

```
PASS  SELF-CHECK: the scanner catches a bare absence claim
PASS  SELF-CHECK: and does not fire on a prohibition against it
PASS  a still-building projection is degraded even with zero rows on both sides
PASS  and it says WHICH degradation, so the sentence downstream can name it
PASS  a healthy empty corpus is still not degraded
PASS  it reports a distinct unavailable status, not a result
PASS  no no_results gap survives
PASS  THE DEFECT: the gap must not instruct anyone to state an absence
PASS  the gap explicitly forbids concluding the brain has nothing
PASS  no refusal confidence is published for a search that never ran
PASS  a dead embedder also produces an unavailable search, not an absence
PASS  REGRESSION GUARD: the honest no_results gap is untouched
PASS  VERSION SKEW: an old worker's body is still recognised as unavailable
PASS  CLI: an unavailable search does not print the refusal sentence
PASS  THE DEFECT AT THE MCP LAYER: no absence instruction in the note
PASS  VERSION SKEW at the MCP: an old worker's no_results gap is replaced, not relayed
PASS  REGRESSION GUARD at the MCP: a healthy empty answer still says nothing is recorded
PASS  /app: a degraded empty result does NOT render the refusal sentence
PASS  REGRESSION GUARD at /app: a healthy empty result still shows the refusal

degraded absence: 64/64 checks passed
```

### One test-design problem worth recording

The first version of the absence scanner was a flat regex over the whole
response. It failed on the fixed code, because the fix necessarily QUOTES the
claim it forbids: `Do NOT say or imply that the brain has nothing`. The scan is
now per sentence and skips any sentence that negates, and two `SELF-CHECK` cases
prove the scanner discriminates in both directions. A scanner that cannot tell a
claim from a prohibition against it would have blocked the correct fix.

## Discrimination check

Five reverts, one at a time, each restored immediately afterwards. Every layer's
tests bite.

| Reverted | Test result |
|---|---|
| `worker/src/index.js`: `emptyRetrievalDisclosure(degraded)` → `(null)` | exit 1, **13 failures**, reproducing the original text verbatim: `THE DEFECT: the gap must not instruct anyone to state an absence  The brain has nothing on this query. Say so plainly rather than inferring.` |
| `components/brain-mcp.mjs`: `retrievalUnavailable(d)` → `false` | exit 1, **5 failures**, incl. `THE DEFECT AT THE MCP LAYER  The brain has nothing on this. Report that as the finding, in those terms.` |
| `brain.mjs`: `retrievalUnavailable(body)` → `false` | exit 1, **2 failures**: `CLI: an unavailable search does not print the refusal sentence` |
| `worker/src/lib/store-d1.js`: `degradedReason = "projection-incomplete"` → `null` | exit 1, **1 failure**: `and it says WHICH degradation, so the sentence downstream can name it  null` |
| `worker/src/lib/app-page.js`: `unavailableSearch()` → `return false` | exit 1, **4 failures**, incl. `/app: a degraded empty result does NOT render the refusal sentence  The documents do not answer the question.` |

**The `/app` probe is the reason this section exists.** On its first run it
returned **exit 0** — the fix was disabled and the tests still passed, because
those three checks grepped the source for a pattern rather than executing it.
The `false &&` I inserted left the grepped text intact. That is a test that
proves nothing, caught only because the probe was run. `app-page.js` was
refactored so the render logic is three pure functions the test can lift out and
call, and the probe then failed as it should.

A second probe on the same file also passed, and that one was the probe's fault
rather than the test's: `false && r.status === X || (...)` disables only the
first clause, and the `degraded` fallback correctly still caught the case. Both
are recorded because the first is a real lesson and the second is a real
property.

One further check passed both ways at first: `/app: the confidence line does not
claim confidence in an absence`, because the fixture carried no `confidence`
field. The fixture now carries the 58% one an older worker would send, which is
also the realistic skew case, and the check now fails on the revert with
`Confidence nothing is recorded: 58% (moderate) — vector index not fully query-ready.`

## Full suite

```
$ npm test > /tmp/issue3-degraded.log 2>&1; echo $? > /tmp/issue3-degraded-exit.txt
$ cat /tmp/issue3-degraded-exit.txt
0
$ grep -c '^PASS' /tmp/issue3-degraded.log
2599
$ grep -c '^FAIL' /tmp/issue3-degraded.log
0
$ grep -E "^ℹ (pass|fail|tests)" /tmp/issue3-degraded.log | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'
tests 140
fail 0
pass 140
```

Exit code read back from the file, not from a pipeline: piping to `tail` reports
the exit status of `tail`.

## Honest limits

**One.** `degraded_reason` is computed and returned by the store but is not yet
on the public wire; the client-facing cause is still keyed off `degraded` alone.
So "the projection is still building" and "the vector query failed" currently
produce the same sentence. The plumbing is in place to split them; the wording
was not, because inventing two sentences before anyone has seen the second
failure in the field is guessing.

**Two.** The `/app` render contract is verified by extracting three functions
from the served HTML and executing them. That is a real behavioural test of the
shipped source, but it is not a browser. A DOM wiring mistake between
`answerText(r)` and `$("answer").textContent` would not be caught here.

**Three.** `acceptance.mjs` already fails a run when a probe comes back degraded,
which is correct and was left alone. It is not, however, a test of the SENTENCE,
so it would have passed throughout this defect's life. It did.

**Four.** This only fixes the case where degradation is DETECTED. A subsystem
that fails silently and returns an empty list without setting `degraded` still
produces an honest-looking absence. `vectorReadiness` is the guard against that
and it throws rather than returning `ready:true` on bad input, but the guarantee
is only as good as that function.

## Changelog paragraph, for whoever integrates this

> Fixed: a brain whose index was still building would tell you it had nothing on
> file about you. Zero search results and a broken search used to produce the
> same sentence, so during the first hours of an install — exactly when you are
> most likely to be asking it things — asking about your own records could come
> back as "the brain has nothing on this," stated plainly and with confidence.
> It now says the search could not be completed, names why, and tells whatever
> is reading it not to conclude anything about what you have on file. The
> genuine "nothing recorded on this" answer is unchanged, because that one is
> the brain doing its job. The distinction now survives to every surface: the
> API, Claude Code and Codex through the MCP tools, the `/app` page, `brain ask`,
> and the client report.

## Not fixed, and why

`report-html.mjs` line 191 contains a real first name in an explanatory comment
(`"<a real first name> does not answer the phone on weekends [4]" is a real
cited answer`). It predates this branch (commit `a5f5f9c`), it is outside this
diff, and the file ships in the public package. It is not covered by
`privateIdentityRules` in `test/package-privacy.test.mjs`, so nothing catches
it. Left for a deliberate decision rather than folded into an unrelated fix,
but it should be changed to an invented persona and the rule list extended.
