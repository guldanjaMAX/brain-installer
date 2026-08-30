# Evaluation v2

Evaluation v2 is the contract for proving that a brain contains the intended
sources, retrieves the complete evidence, answers from that evidence, cites it,
refuses unsupported questions, and does not cross an ownership boundary. It is
designed for one shared installer and many isolated, private installations.

This document contains both the shipped v1 behavior and the v2 specification.
The current `eval/run.mjs` harness implements retrieval and refusal checks,
opt-in deterministic answer canaries, an optional deterministic corpus
inventory reconciliation, and three named profiles: diagnostic `smoke`, an
owner-onboarding `onboarding` gate, and a deterministic `release` suite
coverage gate. The answer canary
proves only a literal atomic phrase or typed value inside one sentence, plus an
inline citation that resolves to an allowed v1 evidence slot. It is not a
semantic judge. The corpus reconciliation proves only logical source-family
presence and expected policy absence against the authenticated D1 inventory.
The v2 schemas do not by themselves enable the remaining commands, metrics,
content-version readback, answer judging, or reports described here. Each
rollout step below must be implemented and tested before its corresponding
claim is made.

## Product and instance boundary

The shared package may contain:

- deterministic scorers and report generators;
- the schemas in `eval/schema/`;
- synthetic fixtures using fictional records and reserved invalid domains;
- a blank suite template and documented defaults.

The shared package must not contain:

- an owner's questions, expected answers, claims, filenames, paths, source IDs,
  corpus contract, baselines, reports, or feedback;
- document text, extracted spans, prompts, answers, citations, or trace content;
- account, database, index, Worker, Drive, Gmail, or installation identifiers;
- credentials, credential locators copied from an instance, or raw errors.

Private suites, corpus contracts, run artifacts, baselines, and detailed reports
are owner-local instance material. They remain outside Git and outside the npm
package. A run may refer to sources through opaque stable IDs, page numbers, and
span hashes. A private explain view resolves an opaque source ID through the
owner's corpus contract when it needs to show where evidence should be found.

Trace content capture is off by default. Standard traces may contain only
opaque IDs, ranks, scores, timings, model identifiers, configuration hashes,
and token or cost totals. The support journal remains a separate, stricter
contract and receives only sanitized category and count metadata. Evaluation
artifacts are never uploaded automatically.

The operator admin key still has whole-install authority, but the owner app now
has enforceable passkey sessions, exact owned-entity scope, and exact-document
grants for scoped people. `actor`, `owner_scope`, and forbidden-owner fields are
therefore both evaluation labels and security regression inputs. New documents
are owner-only by default. Scoped retrieval must use D1 authority before ranking
and report explicit vector degradation instead of filtering an unauthorized
top-K list into a healthy empty answer.

The current installer has built-in scanned-PDF OCR, off by default. The v2
schema can describe `ocr_text` and `ocr_table` cases, but schema coverage and
fixture tests are not field proof. Release evidence must still distinguish
typed scans, one-bit fax or photocopy pages, handwriting, low-confidence text,
and refusal, with exact page and citation provenance.

## The four contracts

### Evaluation suite

`eval/schema/eval-suite-v2.schema.json` defines questions and expected behavior.
Every case has:

- lifecycle state: `candidate`, `reviewed`, or `gold`;
- risk: `critical`, `high`, or `normal`;
- domain, source format, and query-kind labels;
- a principal, tenant, authorized owner labels, and requested scopes;
- expected mode: answer, abstain, or clarify;
- atomic required claims and optional exact typed values;
- one or more evidence slots, each with acceptable stable source references;
- forbidden sources, entities, owners, or hashed canaries;
- citation requirements and human-review provenance.

An answerable v2 case always has at least one claim and one non-empty evidence
slot. This is an executable invariant, not a suggestion in a template. A
synthetic case stays `candidate` until a human checks the question, expected
claim, evidence, identity assumptions, and time assumptions. Only reviewed or
gold cases can block a release.

### Corpus contract

`eval/schema/corpus-contract-v1.schema.json` is the independent list of sources
that should exist. It records a private canonical locator, connector, expected
policy state, content hash, source version, domain, owner scope, sensitivity,
format, extraction mode, effective dates, and priority.

The corpus contract is essential. Search can show that indexed evidence is
missing from a result, but it cannot discover a file that never reached the
source inventory. If the connector snapshot is incomplete, the evaluator must
say that source completeness is not observable. It must not turn an incomplete
inventory into a passing coverage percentage.

Each expected source reconciles to exactly one observed state:

`indexed | excluded | quarantined | failed | tombstoned`

An index row with no matching expected source is `unknown`. Every exclusion,
quarantine, failure, and tombstone retains a typed reason.

The executable v1 subset is opt-in:

```bash
brain eval ./brain.manifest.json \
  --corpus-contract ./brain.corpus-contract.json
```

The contract file is private instance material. On POSIX it must be an
owner-owned, single-link regular file with mode `0600` or stricter. The parent
CLI and child evaluator both validate it before the admin key is read or a
network path is opened. Validation rejects unknown fields, duplicate stable
source labels, duplicate index-family mappings, missing connector snapshots,
incomplete proof hashes, future capture times, and an `installation_ref` that
does not equal the manifest's `client.slug`.

For each contract source, `index_source_id` names the private bare identity used
by the Brain index. Older v1 contracts without that optional field use
`canonical_locator`, preserving the original schema behavior. The evaluator
prefixes that value with `connector` when needed, then reconciles it against the
authenticated, paginated `/api/admin/brain/source-families` observation. The
read-only endpoint accepts only JSON POST bodies, refuses redirects in the eval
client, and returns private no-store responses. Family identities and page
cursors never enter request URLs. Its global inventory derives source labels
from live D1 document rows rather than denormalized corpus statistics. An
`eligible` source must be present. An `excluded`, `quarantined`, or `tombstoned`
source must be absent. Every observed family not in the complete independent
contract is unknown.

The gate reports aggregate counts for connector, domain, priority, MIME format,
extraction mode, sensitivity, and expected policy state. Its typed failures are:

| Stage | Failure code |
|---|---|
| Contract preflight | `CORPUS_INVENTORY_INCOMPLETE` |
| Connector snapshot | `CONNECTOR_SNAPSHOT_INCOMPLETE` |
| Source inventory | `SOURCE_NOT_INDEXED`, `UNKNOWN_INDEX_SOURCE`, `SOURCE_INVENTORY_INVALID`, `SOURCE_INVENTORY_NOT_OBSERVABLE`, `SOURCE_INVENTORY_SUMMARY_DRIFT` |
| Policy state | `EXCLUDED_SOURCE_INDEXED`, `QUARANTINED_SOURCE_INDEXED`, `TOMBSTONED_SOURCE_INDEXED` |

Supplying the contract makes every one of those failures blocking in both smoke
and release profiles. Omitting it preserves v1 retrieval behavior. Shareable
artifacts contain only counts, declared slice labels, hashes, and these typed
codes. They never contain the canonical locator, index source identity, stable
source ID, source version, filename, path, document title, or content.

The claim boundary is deliberate. The existing read-only family endpoint proves
logical presence and expected absence. It does not return content hashes,
connector failure receipts, extraction output, or tombstone history. Therefore
content-version equality remains `not_observable` even though the private
contract records `content_hash` and `source_version`. A green reconciliation is
not OCR quality, extraction accuracy, or answer accuracy certification. It also
depends on the owner or connector producing a truthful, complete independent
contract; the evaluator does not discover missing source systems by itself.

### Gate policy

`eval/schema/gate-policy-v1.schema.json` separates policy from measurement. It
contains fixed cutoffs, statistical rules, per-slice sample requirements,
regression tolerances, and blocking or warning metric gates. Changing a gate is
a versioned policy change, not an unrecorded command-line choice.

### Run artifact

`eval/schema/run-artifact-v2.schema.json` is the machine-readable result. It
records suite, policy, code, Worker, corpus, model and configuration provenance;
aggregate and sliced metrics; confidence intervals; gate outcomes; case-level
opaque evidence references; diagnoses; timing; and cost.

Unavailable evidence is recorded as `not_observable` with a reason code. A null
field must never imply that provenance was successfully collected.
Corpus fingerprint failures also retain only a sanitized observation stage,
error kind, and optional HTTP status. Response bodies, family identities, and
private locators never enter the report. If observability changes across the
before-and-after bracket, the run stops and names those aggregate diagnostics.

## Evaluation profiles and future tiers

### `brain eval <manifest> --profile smoke`

This is the shipped default. It runs the current deterministic retrieval and
refusal harness against any non-empty valid v1 suite. Answerable cases with an
`answer_expect` contract also call `/think` and run the deterministic answer
canary. Cases without that optional field remain retrieval-only, preserving v1
cost and baseline behavior. Use smoke while writing a suite and after setup,
ingest, sync, or a retrieval change. A smoke pass is a diagnostic result. It is
not release certification, even when every small-set case passes.

### `brain eval <manifest> --profile onboarding`

This is the first-owner proof gate. It refuses to contact the brain unless the
private suite has at least twenty reviewed questions with this minimum mix:

- six single-document facts;
- three multi-document syntheses;
- three questions about facts that changed;
- three questions that distinguish people; and
- five questions the corpus genuinely cannot answer.

Every safety question must produce a clean refusal. A missing answer, timeout,
or unavailable answer route is inconclusive and blocks the gate. Every declared
deterministic answer canary must also run and pass. Across answerable questions,
complete evidence at five must be at least 80%, evidence-slot recall at five
must be at least 90%, and duplicate waste at five must be no more than 10%.
Transport errors block the run. These checks are aggregate-only in shareable
artifacts and run after the structural preflight.

The onboarding profile is stricter than smoke but is not release certification.
It answers one practical question: can this owner already get reliable value
from the smallest reviewed set of questions that matters to them? Retrieval,
answer, and refusal latency are reported separately so first-value speed can be
improved without hiding a slow safety path. Latency is measured here, not yet a
hard gate. `--no-think` is not allowed with this profile.

The default ranking remains deterministic. Multi-part questions may add one
bounded clause-coverage list to reciprocal-rank fusion, but that list is built
only from candidates that already passed the request's D1 access, entity, and
filter predicates. It makes no additional database, Vectorize, or model call.

`--rerank` is an explicit experimental variant. A requested rerank is valid
only when the Worker returns `rerank_status: applied`; `disabled`, `fallback`,
or an older response with no actuation status blocks the run whenever there was
more than one candidate to reorder. The sanitized case artifact retains only
that status and the aggregate candidate count. This prevents an unavailable or
failed reranker from being recorded under a successful variant name. Reranking
is never enabled merely because a provider credential exists.

### `brain eval <manifest> --profile release`

This shipped v1 profile refuses to contact the brain unless the private suite
meets all of these structural floors:

- at least 60 cases;
- an explicit `release_slices` contract for `risk`, `domain`, `format`, and
  `query_kind`;
- an explicit label in every dimension on every case;
- at least five cases in every named required slice;
- a named `critical` risk slice; and
- named `unanswerable` plus at least one answerable query-kind slice.

Every label used by a case must be declared in `release_slices`. The gate emits
aggregate counts only and runs before the admin key is read or a network call is
made. Query-kind coverage is derived from the executable `kind`; when a legacy
`query_kind` label is present it must match `kind`. After the floor passes, the
existing v1 retrieval, provenance, regression, and critical-case gates run
normally. Every release-profile unanswerable case must also run and pass its
refusal check regardless of risk. Every declared deterministic answer canary in
a release case must also run and pass. `--no-think` is therefore smoke-only. In
smoke, skipping a critical refusal or deterministic answer canary still blocks
a green result.

This is v1 retrieval-suite release qualification, not full v2 certification.
Without a supplied corpus contract it does not prove that the declared slices
cover every real corpus region. With a supplied complete contract, logical
source-family presence and policy absence become blocking, but content-version
and extraction equality remain not observable. The release profile does not
require answer-canary coverage across the suite. The shipped canary does not
judge paraphrases, additional produced claims, semantic support, faithfulness,
or citation support at the span level. Document-level authorization, confidence
bounds, latency budgets, and cost also remain outside this gate. Those claims
remain blocked until their executable v2 contracts ship.

### Future: `brain eval deep`

Runs nightly or weekly. It audits source and extraction coverage, tested corpus
regions, OCR and table canaries, adversarial cases, updates, tombstones, access
changes, stale and conflicting sources, and rank stability. It may generate
synthetic candidate questions for uncovered strata, but generated candidates
do not affect a release until reviewed.

### Future: `brain eval monitor`

Samples owner-local production outcomes and explicit feedback. A thumbs-up is
useful evidence, not ground truth. Reviewed failures and corrections can be
promoted into candidate, reviewed, and finally gold cases. Questions, answers,
and retrieved text remain local.

### Future: `brain eval explain <case-id>`

Shows the earliest failed stage, later symptoms, expected opaque source, page,
best observed rank, whether evidence entered the prompt, claim and citation
results, and the subsystem to inspect. It resolves any private source location
from the local corpus contract at display time instead of copying paths into a
shareable artifact.

## Deterministic measurements

The metric calculation is deterministic once result order and labels are fixed.
An automated judge may propose atomic claim labels, but it does not change the
formula. Critical exact claims require deterministic normalization or human
review and never rely on a judge alone.

For query `q`, cutoff `k`, rank `i`, and relevance grade `rel(i)` from 0 to 3:

- `slot_hit(s, k) = 1` when at least `min_hits` acceptable references for a
  required evidence slot appear in the first `k`, otherwise `0`.
- `Evidence Slot Recall@k = sum(slot_hit) / required evidence slots`.
- `Complete Evidence@k = 1` only when every required evidence slot is hit.
- `Precision@k = relevant results in the first k / k`. Missing result positions
  count as non-relevant.
- `Recall@k = relevant results in the first k / all judged-relevant results`.
- `MRR = mean(1 / rank of first relevant result)`, with a miss scored as zero.
- `DCG@k = sum((2^rel(i) - 1) / log2(i + 1))` for ranks 1 through `k`.
- `nDCG@k = DCG@k / ideal DCG@k`.
- `Duplicate Waste@k = 1 - unique canonical source IDs in top k / k`.

Multi-source cases report both partial slot recall and complete evidence. A
question that found one half of its required evidence is not counted as fully
answerable.

### Shipped deterministic answer canary

An answerable v1 question may opt in with `answer_expect`. Each expected
evidence slot used by a claim needs a unique `slot_id`. Every declared claim is
required and must choose exactly one deterministic matcher:

- `contains_any`: one of 1 to 10 literal phrases, matched case-insensitively
  with flexible whitespace; or
- `exact_value`: a string, finite number, or ISO date with its declared
  normalization and tolerance.

The fixed `claim_boundary` is `sentence`. A claim passes only when the phrase or
value appears inside a sentence that also contains an inline `[n]` marker, and
the response citation numbered `n` resolves to one of the claim's named v1
evidence slots. Citation numbers by themselves do not pass. Duplicate citation
numbers are unresolved, citations in another sentence do not attach to the
claim, and a missing answer is inconclusive.

```json
{
  "expect": [
    {
      "slot_id": "policy-record",
      "any_of": ["curated:synthetic-policy"]
    }
  ],
  "answer_expect": {
    "claim_boundary": "sentence",
    "claims": [
      {
        "claim_id": "policy-code",
        "contains_any": ["the policy code is AX-17"],
        "evidence_slot_ids": ["policy-record"]
      },
      {
        "claim_id": "approved-limit",
        "exact_value": {
          "type": "number",
          "canonical": 1250,
          "normalization": "numeric",
          "tolerance": 0
        },
        "evidence_slot_ids": ["policy-record"]
      }
    ]
  }
}
```

This is a deterministic canary, not general answer correctness. It does not
inspect extra factual claims, infer semantic paraphrases, see the private prompt
context, or prove that a resolved citation actually supports the sentence.
Those measurements still require trace evidence or reviewed judging. Use this
contract for short, low-ambiguity facts whose literal phrase or typed value is
meaningful. Do not label its pass rate as claim correctness or faithfulness.

For atomic answer claims:

- `Claim Correctness = correct produced claims / produced factual claims`.
- `Claim Completeness = satisfied required claims / required claims`.
- `Claim F1` is the harmonic mean of correctness and completeness.
- `Faithfulness = produced factual claims supported by retrieved context /
  produced factual claims`.
- `Citation Precision = citations that support their mapped claim / citations`.
- `Citation Recall = citation-required claims with a supporting citation /
  citation-required claims`.
- `Citation Resolvability = citations resolving to the expected current source
  version and span / citations`.

For unsupported questions:

- `Abstention Recall = correctly abstained unanswerable cases / unanswerable
  cases`.
- `False Answer Rate = unanswerable cases answered substantively / unanswerable
  cases`.
- `False Refusal Rate = answerable cases refused / answerable cases`.

For freshness and isolation:

- `Stale Exposure Rate = time-sensitive cases retrieving or citing superseded
  evidence / time-sensitive cases`.
- `Current Evidence@k` is the share of latest-answer cases whose current source
  version appears within `k`.
- `Correct As-Of Rate` is the share of historical cases answered from the
  version valid at the requested time.
- `Unauthorized Retrieval Count` counts cases with any forbidden-owner result.
- `Canary Emission Count` counts outputs containing a forbidden hashed canary.
- `Entity Misattribution Rate = wrong-entity assignments / entity-attribution
  cases`.

Performance includes retrieval and answer p50, p95, and p99 latency; errors and
rate limits; input, output, embedding, reranker, and judge tokens; dollars per
query using a versioned price manifest; and rank flips across identical repeats.

Report every applicable metric globally and by risk, domain, format, query kind,
connector, and owner scope. A required slice below its reviewed sample minimum
is `INSUFFICIENT_COVERAGE`, never `PASS`.

## Earliest-failed-stage diagnosis

Evaluate stages in this order. The first failed observable stage is the primary
diagnosis. Later failures remain secondary symptoms.

| Stage | Diagnosis | What to inspect |
|---|---|---|
| Expected source is not in a complete contract | `SOURCE_ABSENT` | Configured connector, folder, export, or source system from the private locator |
| Source is excluded or quarantined | `POLICY_EXCLUDED` or `QUARANTINED` | Rule and typed reason |
| Eligible source has no indexed version | `INGEST_MISSING` | Connector run, cursor, permissions, receipt, or retry state |
| Indexed document lacks the expected span or value | `EXTRACT_OCR_MISSING` | Original page, extraction output, structured parser, or prior OCR |
| Evidence exists but falls below the cutoff | `RETRIEVAL_RANK_MISS` | Best rank and score, metadata filters, chunking, hybrid fusion, reranker |
| Retrieved evidence was dropped before generation | `CONTEXT_ASSEMBLY_DROP` | Deduplication, ordering, token budget, prompt construction |
| Prompt contained evidence but answer omitted it | `GENERATOR_OMISSION` | Prompt, model, context utilization |
| Output contains a wrong or unsupported claim | `ANSWER_INCORRECT` or `HALLUCINATION` | Claim label and supporting evidence |
| Citation is absent, unsupported, or stale | `CITATION_MISSING`, `CITATION_UNSUPPORTED`, or `CITATION_UNRESOLVABLE` | Claim-to-citation mapping and current source version |
| Superseded or conflicting evidence wins | `TEMPORAL_CONFLICT` | Effective dates, authority, update and tombstone state |
| Wrong owner or entity appears | `ACCESS_ISOLATION_FAILURE` or `ENTITY_MISATTRIBUTION` | Install boundary, filters, metadata, entity assignment |

When a required snapshot or trace does not exist, emit
`NOT_OBSERVABLE_AT_STAGE`. Do not infer a deeper cause from a downstream miss.

The private explanation for a required claim should answer:

1. Was its expected source discovered and eligible?
2. Was the expected version indexed and fully vectorized?
3. Did extraction contain the expected page, span, field, or table cell?
4. What was its best retrieval rank and score?
5. Did it enter the final prompt?
6. Did the answer use the claim and map it to a supporting citation?
7. Was a stale, conflicting, forbidden-owner, or wrong-entity source preferred?

Without a complete corpus contract, the honest answer to "what source is
missing?" is "not knowable from the index alone."

## Initial v2 release gates

These are strong starting targets. An installation may raise them. Lowering a
gate requires a versioned policy decision backed by evidence.

Except for the current v1 critical retrieval and refusal gates and any explicitly
declared deterministic answer canaries, the targets in this section are
specification until their scorers, policies, and tests ship.

Hard gates are not averaged away:

- 100% of priority sources are accounted for as indexed, excluded, quarantined,
  failed, or tombstoned.
- Zero unknown index rows and zero excluded sources still indexed.
- Zero unresolved failure or quarantine for a critical source.
- 100% critical exact-value and structured-cell canaries are correct.
- 100% critical cases achieve Complete Evidence@5.
- 100% critical required claims are correct, supported, and cited.
- Zero critical-case regression against the accepted baseline.
- Zero unauthorized retrievals, forbidden canary emissions, and critical entity
  misattributions.
- Update, tombstone, and authorization-change fixtures pass every step, with
  zero stale result after convergence.

Aggregate gates use the named 95% confidence bound:

| Metric | Initial gate |
|---|---:|
| Evidence Slot Recall@5, lower bound | at least 0.90 |
| Context Precision@5, lower bound | at least 0.75 |
| nDCG@10, lower bound | at least 0.80 |
| Claim correctness, lower bound | at least 0.90 |
| Claim completeness, lower bound | at least 0.90 |
| Faithfulness, lower bound | at least 0.95 |
| Citation precision, lower bound | at least 0.95 |
| Citation recall, lower bound | at least 0.95 |
| False-answer rate, upper bound | at most 0.02 |
| False-refusal rate, upper bound | at most 0.05 |

Latency and cost must remain within explicit policy budgets and may not regress
more than 20% without an accepted policy change. A point estimate passing while
its required confidence bound fails is a failed gate.

Use paired, domain-stratified bootstrap comparison over cases with 10,000
resamples. Use a paired permutation cross-check for close decisions and Holm
correction when comparing multiple variants. Resample cases, not repeated calls
as though they were independent questions. Report uncertainty for every slice.

Critical stochastic cases run at least three times and require three passes.
Zero isolation failures in 300 adversarial cases supports only an approximate
95% upper risk bound below 1%. Report that bound rather than claiming zero risk.

Keep a held-out release suite separate from development and tuning cases.
Automated claim judges need a separate, human-labeled calibration set before
they can block noncritical changes. Roughly 150 or more labels is a practical
starting point. Require high critical-failure recall and approximately 0.85 F1;
even then, a judge is never the sole gate for a critical exact claim.

## Suite coverage and growth

Build coverage in this order:

1. Real questions the owner expects the corpus to answer.
2. Reviewed retrieval, answer, citation, ingest, and exclusion failures.
3. Hard paraphrases, typos, same-name distractors, contradictory versions,
   unanswerable questions, long documents, structured rows, and tables.
4. Synthetic candidates targeted only at uncovered domain, format, query-kind,
   owner, temporal, or semantic strata.

### The Golden 20 session

`brain eval <manifest> --golden-20` is step 1 operationalized as a handoff
ritual: operator and owner fill twenty slots together in one sitting: six
single-document facts, three multi-document syntheses, three temporal
questions about things that changed, three person-distinction questions, and
five unanswerable questions the brain must refuse. The owner writes every
question from memory before retrieval runs, so the wording cannot borrow from
the answering document; the session then runs their question and the owner
confirms which returned documents are the right evidence, which records
scorer-stable identities without any hand-edited JSON. Unanswerable entries
get an on-the-spot live refusal check. A missing live answer is explicitly
inconclusive, never praised as a safe refusal. The file saves after every
question and the session resumes where it stopped, so an interrupted sitting
loses nothing.
The completed session offers to score the onboarding profile immediately. An
incomplete session can still run smoke for diagnosis. Passing onboarding is a
first-owner value gate and a starting point for the growth path above, not a
substitute for the release profile.

A small suite is a smoke test. A first release suite should contain roughly 60
to 80 reviewed cases across its required slices. A stable release suite should
grow toward 120 reviewed cases, and a mature adversarial suite toward 300 or
more. Sample count alone is not quality. Every important domain, format, and
query kind needs explicit reviewed representation.

The shipped v1 release profile enforces the 60-case floor and five cases per
declared slice. The owner still has to review the cases and declare the right
slices. Only an independent corpus contract can reveal an important source or
domain that was omitted from both the suite and its declaration.

Corpus chunk or semantic-cluster coverage can reveal regions no question has
ever exercised. It is structural test adequacy, not proof of answer quality.
Use it to propose candidates, then review those candidates before promotion.

## Reports

The current retrieval harness produces an internal v1 artifact set:

- `run.json`: sanitized retrieval metrics, opaque case IDs, provenance hashes,
  the named profile and aggregate profile-coverage evidence, and hard-gate
  results. Declared answer canaries add aggregate counts and case-level booleans
  and failure codes, never expected phrases, values, answers, or citation
  identities. A supplied corpus contract adds only aggregate reconciliation
  totals, declared slice labels, contract hashes, and typed failure codes;
- `failures.jsonl`: sanitized case failures and diagnosis codes;
- `coverage.csv`: case counts and metrics by slice;
- `corpus-coverage.csv`: written only when a corpus contract is supplied, with
  expected, indexed, accounted, missing, and policy-leak counts by declared
  slice;
- `junit.xml`: release-gate integration for CI.

These files are created in a new owner-only directory, each file is owner-only,
existing paths are never overwritten, and links are not followed. They never
contain raw questions, answers, source titles, source paths, target URLs, Worker
labels, or credentials. They remain private and are never uploaded
automatically.

This v1 `run.json` does not claim conformance with
`eval/schema/run-artifact-v2.schema.json`. The v2 artifact, `summary.html`, and
append-only trend history remain rollout work and must not be advertised as
implemented until their executable schemas and tests ship.

Only a separate, explicit support export may leave the machine. That export
must preview exact bytes and contain typed categories and aggregate counts only,
never a question, answer, claim, filename, path, source ID, URL, document ID,
raw error, stack, trace, prompt, or credential.

## Rollout order

### Batch 1: executable contracts and deterministic retrieval

The v1 runtime now covers the deterministic retrieval metrics, privacy-safe
artifacts, critical-case gates, named structural release-profile floor, the
opt-in deterministic answer canary, and the aggregate logical-family corpus
reconciliation above. It does not validate or execute the complete v2 suite,
policy, content-version corpus, or artifact contracts below.

1. Validate suite, gate-policy, and run-artifact schemas.
2. Preserve v1 scorer behavior with compatibility fixtures.
3. Keep the shipped golden template consistent with runtime validation.
4. Add domain, format, risk, query-kind, and owner-scope slicing.
5. Add Evidence Slot Recall@k, Complete Evidence@k, Precision@k, nDCG@10,
   duplicate waste, and the abstention confusion matrix.
6. Make missing corpus or Worker provenance explicitly `not_observable`.
7. Add blocking critical-case gates plus JSON, JSONL, CSV, and JUnit reports.
8. Use only synthetic fixtures in the repository.

Do not add hosted tracing, LLM judges, or synthetic generation in this batch.
The first gate should be deterministic and incapable of exporting private data.

### Batch 2: source, extraction, context, claim, and citation evidence

1. Extend the shipped read-only logical-family observation with opaque source
   version IDs, policy receipts, content hashes, extraction status, and
   per-family vector-outbox state.
2. Extend the shipped private-contract reconciliation from logical presence and
   expected absence to those richer stage observations.
3. Trace retrieval and context-assembly stages with content capture disabled.
4. Extend the shipped literal/exact-value and citation-identity canary with
   observable context evidence, semantic claim review, citation support, and
   current-version or span resolution.
5. Add earliest-stage diagnosis and the private explain command.

### Batch 3: lifecycle and adversarial validation

1. Add isolated synthetic fixtures for create, update, tombstone, restore, and
   authorization-change convergence.
2. Add stale, conflicting, wrong-entity, wrong-owner, prompt-injection, and
   forbidden-canary cases.
3. Add already-OCRed text and structured-table canaries without claiming a
   built-in OCR capability.
4. Add repeated-run variance, paired statistical comparison, latency, tokens,
   and cost gates.

### Batch 4: coverage growth and local observability

1. Add private human review and feedback promotion.
2. Generate synthetic candidates for uncovered strata and corpus regions.
3. Calibrate any automated judge against the human label set.
4. Optionally send content-free OpenTelemetry/OpenInference traces to a
   self-hosted dashboard. The native v2 artifact remains the release truth.

## Reference foundations

The metric and testing design follows primary papers and official technical
documentation, including [RAGAS](https://arxiv.org/abs/2309.15217),
[RAGChecker](https://arxiv.org/abs/2408.08067),
[ARES](https://aclanthology.org/anthology-files/pdf/naacl/2024.naacl-long.20.pdf),
[NIST trec_eval](https://github.com/usnistgov/trec_eval),
[ALCE citation evaluation](https://arxiv.org/abs/2305.14627),
[Google attribution evaluation](https://research.google/pubs/measuring-attribution-in-natural-language-generation-models/),
[OmniDocBench](https://openaccess.thecvf.com/content/CVPR2025/papers/Ouyang_OmniDocBench_Benchmarking_Diverse_PDF_Document_Parsing_with_Comprehensive_Annotations_CVPR_2025_paper.pdf),
and [OWASP vector database controls](https://github.com/OWASP/AISVS/blob/main/1.0/en/0x10-C08-Memory-Embeddings-and-Vector-Database.md).
