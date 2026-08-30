/**
 * Unit tests for the scoring logic.
 *
 *   node --test eval/
 *
 * These exist because a scorer with a bug does not crash, it prints a plausible
 * wrong number, and a plausible wrong number is worse than no eval at all: it
 * gets quoted to a client. Every case below is a way the arithmetic could be
 * silently wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  identitiesOf,
  documentKeyOf,
  dedupeByDocument,
  scoreQuestion,
  scoreRefusal,
  scoreDeterministicAnswer,
  looksLikeRefusal,
  aggregate,
  retrievalQuality,
  aggregateQuality,
  diagnoseRetrieval,
  findRegressions,
  findImprovements,
  rankOf,
  jsonReplacer,
} from "./scorer.mjs";

/** Save and reload the way run.mjs does, so the tests exercise the real path. */
const roundTrip = (run) => JSON.parse(JSON.stringify(run, jsonReplacer));

const curated = (key) => ({ source: "curated", ref_key: key, drive_file_id: null, title: "t" });
const drive = (fileId, path = "some/path.md") => ({
  source: "drive",
  ref_key: "918273645", // chunk row id, deliberately not an identity
  drive_file_id: fileId,
  title: path,
});
const message = (id) => ({ source: "message", ref_key: id, drive_file_id: null, title: "" });

/* ------------------------------------------------------------- identities */

test("a curated result is identified by its ref_key", () => {
  assert.deepEqual(identitiesOf(curated("meetings/a.md")), ["curated:meetings/a.md"]);
});

test("a drive result is identified by file id and path, never by the chunk ref_key", () => {
  const ids = identitiesOf(drive("FILE1", "Career/Resume.pdf"));
  assert.deepEqual(ids, ["drive:FILE1", "drive_path:Career/Resume.pdf"]);
  assert.ok(!ids.some((i) => i.includes("918273645")), "chunk row id must not be an identity");
});

test("an unrecognised shape still gets a stable handle", () => {
  assert.deepEqual(identitiesOf({ source: "weird", title: "only a title" }), ["weird:only a title"]);
  assert.deepEqual(identitiesOf(null), []);
  assert.equal(documentKeyOf({}), null);
});

/* ----------------------------------------------------------------- dedupe */

test("dedupe collapses repeat chunks of one file and keeps the best rank", () => {
  const results = [drive("A"), drive("A"), curated("k"), drive("A"), drive("B")];
  const out = dedupeByDocument(results);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(documentKeyOf), ["drive:A", "curated:k", "drive:B"]);
});

test("dedupe drops results with no usable identity rather than counting them", () => {
  assert.equal(dedupeByDocument([{ source: "drive" }, curated("k")]).length, 1);
});

/* --------------------------------------------------------- single and multi */

test("a single slot question scores the rank of its document", () => {
  const q = { expect: [{ doc: "d", any_of: ["curated:target"] }] };
  const s = scoreQuestion(q, [curated("noise"), curated("target"), curated("more")]);
  assert.equal(s.satisfiedAt, 2);
  assert.equal(s.scorable, true);
});

test("any_of means any listed duplicate counts, which is why duplicates are listed", () => {
  const q = { expect: [{ doc: "d", any_of: ["curated:copy-a", "drive:COPY_B"] }] };
  assert.equal(scoreQuestion(q, [drive("COPY_B")]).satisfiedAt, 1);
  assert.equal(scoreQuestion(q, [curated("copy-a")]).satisfiedAt, 1);
});

test("a drive slot can be written as a path instead of a file id", () => {
  const q = { expect: [{ doc: "d", any_of: ["drive_path:Career/Resume.pdf"] }] };
  assert.equal(scoreQuestion(q, [drive("WHATEVER", "Career/Resume.pdf")]).satisfiedAt, 1);
});

test("a slot with no any_of references can match an exact document title", () => {
  const q = { expect: [{ source: "drive", doc: "Career/Resume.pdf" }] };
  assert.equal(scoreQuestion(q, [drive("WHATEVER", "Career/Resume.pdf")]).satisfiedAt, 1);
  assert.equal(scoreQuestion(q, [drive("WHATEVER", "Career/Other.pdf")]).satisfiedAt, Infinity);
});

test("source-scoped matching rejects a same-title or same-key result from another source", () => {
  const titleOnly = { expect: [{ source: "drive", doc: "Shared title" }] };
  const stableKey = { expect: [{ doc: "Expected", any_of: ["curated:same-key"] }] };
  assert.equal(
    scoreQuestion(titleOnly, [{ source: "curated", title: "Shared title", ref_key: "x" }]).satisfiedAt,
    Infinity,
  );
  assert.equal(scoreQuestion(stableKey, [{ source: "message", ref_key: "same-key" }]).satisfiedAt, Infinity);
});

test("a two document question is satisfied at the rank of the SECOND one", () => {
  const q = {
    expect: [
      { doc: "first", any_of: ["curated:a"] },
      { doc: "second", any_of: ["curated:b"] },
    ],
  };
  const s = scoreQuestion(q, [curated("a"), curated("x"), curated("b")]);
  assert.equal(s.satisfiedAt, 3, "half the evidence is not an answer");
  assert.deepEqual(s.slots.map((x) => x.rank), [1, 3]);
});

test("one broad result cannot satisfy two required evidence slots", () => {
  const q = {
    expect: [
      { doc: "first", any_of: ["curated:shared", "curated:first-copy"] },
      { doc: "second", any_of: ["curated:shared", "curated:second-copy"] },
    ],
  };
  const oneResult = scoreQuestion(q, [curated("shared")]);
  assert.equal(oneResult.satisfiedAt, Infinity);
  assert.equal(oneResult.slots.filter((slot) => Number.isFinite(slot.rank)).length, 1);

  const twoDocuments = scoreQuestion(q, [curated("shared"), curated("second-copy")]);
  assert.equal(twoDocuments.satisfiedAt, 2);
  assert.deepEqual(twoDocuments.slots.map((slot) => slot.rank), [1, 2]);
});

test("evidence assignment uses maximum matching instead of a greedy false miss", () => {
  const q = {
    expect: [
      { doc: "broad", any_of: ["curated:a", "curated:b"] },
      { doc: "narrow", any_of: ["curated:a"] },
    ],
  };
  const scored = scoreQuestion(q, [curated("a"), curated("b")]);
  assert.equal(scored.satisfiedAt, 2);
  assert.deepEqual(scored.slots.map((slot) => slot.rank), [2, 1]);
});

test("shared_result_group is the explicit way for one document to satisfy several slots", () => {
  const q = {
    expect: [
      { doc: "claim one", any_of: ["curated:shared"], shared_result_group: "same-policy" },
      { doc: "claim two", any_of: ["curated:shared"], shared_result_group: "same-policy" },
    ],
  };
  const scored = scoreQuestion(q, [curated("shared")]);
  assert.equal(scored.satisfiedAt, 1);
  assert.deepEqual(scored.slots.map((slot) => slot.rank), [1, 1]);
  const quality = retrievalQuality(q, [curated("shared")], [1]);
  assert.equal(quality[1].complete_evidence, true);
  assert.equal(quality[1].slot_recall, 1);
  assert.equal(quality[1].precision, 1);
  assert.equal(quality[1].ndcg, 1, "a deliberately shared document is one ideal relevance unit");
});

test("a missing slot makes the whole question unsatisfied even if the other is rank 1", () => {
  const q = {
    expect: [
      { doc: "first", any_of: ["curated:a"] },
      { doc: "second", any_of: ["curated:never"] },
    ],
  };
  assert.equal(scoreQuestion(q, [curated("a")]).satisfiedAt, Infinity);
});

test("a question with no expected documents is not scorable on rank", () => {
  const s = scoreQuestion({ expect: [] }, [curated("a")]);
  assert.equal(s.scorable, false);
  assert.equal(s.satisfiedAt, null);
});

test("empty results are a miss, not a crash", () => {
  assert.equal(scoreQuestion({ expect: [{ doc: "d", any_of: ["curated:a"] }] }, []).satisfiedAt, Infinity);
});

/* ------------------------------------------------------------- aggregation */

test("recall and MRR are computed over scorable questions only", () => {
  const scored = [
    { scorable: true, satisfiedAt: 1 },
    { scorable: true, satisfiedAt: 4 },
    { scorable: true, satisfiedAt: Infinity },
    { scorable: false, satisfiedAt: null },
  ];
  const a = aggregate(scored, [1, 5]);
  assert.equal(a.n, 3, "the unanswerable question must not dilute recall");
  assert.equal(a.recall[1], 1 / 3);
  assert.equal(a.recall[5], 2 / 3);
  assert.ok(Math.abs(a.mrr - (1 + 0.25 + 0) / 3) < 1e-9);
});

test("an unsatisfied question contributes zero to MRR rather than NaN", () => {
  const a = aggregate([{ scorable: true, satisfiedAt: Infinity }], [1, 5]);
  assert.equal(a.mrr, 0);
  assert.equal(a.recall[5], 0);
});

test("aggregating nothing yields zeros rather than dividing by zero", () => {
  const a = aggregate([], [1, 5]);
  assert.equal(a.n, 0);
  assert.equal(a.mrr, 0);
  assert.equal(a.recall[5], 0);
});

test("retrieval quality reports partial multi-evidence coverage and graded rank", () => {
  const q = {
    expect: [
      { doc: "a", any_of: ["curated:a"], relevance_grade: 3 },
      { doc: "b", any_of: ["curated:b"], relevance_grade: 2 },
    ],
  };
  const quality = retrievalQuality(q, [curated("a"), curated("noise"), curated("a")], [1, 3]);
  assert.equal(quality[1].slot_recall, 0.5);
  assert.equal(quality[1].complete_evidence, false);
  assert.equal(quality[1].precision, 1);
  assert.equal(quality[3].slot_recall, 0.5);
  assert.ok(Math.abs(quality[3].duplicate_waste - 1 / 3) < 1e-12);
  assert.equal(quality[3].precision, 1 / 3, "repeat chunks of one source do not earn relevance twice");
  assert.ok(quality[3].ndcg > 0 && quality[3].ndcg < 1);
});

test("quality aggregation keeps complete evidence separate from average slot recall", () => {
  const summary = aggregateQuality([
    { quality: { 5: { slot_recall: 1, complete_evidence: true, precision: 0.4, ndcg: 1, duplicate_waste: 0 } } },
    { quality: { 5: { slot_recall: 0.5, complete_evidence: false, precision: 0.2, ndcg: 0.5, duplicate_waste: 0.4 } } },
  ], 5);
  assert.equal(summary.slot_recall, 0.75);
  assert.equal(summary.complete_evidence, 0.5);
  assert.ok(Math.abs(summary.precision - 0.3) < 1e-12);
  assert.ok(Math.abs(summary.duplicate_waste - 0.2) < 1e-12);
});

test("a retrieval miss names observable and not-yet-observable stages honestly", () => {
  const scored = scoreQuestion(
    { expect: [{ doc: "expected", any_of: ["curated:expected"] }] },
    [curated("other")],
  );
  const diagnosis = diagnoseRetrieval({}, scored, 5);
  assert.equal(diagnosis.primary, "NOT_OBSERVABLE_AT_STAGE");
  assert.equal(diagnosis.stage, "source_inventory");
  assert.equal(diagnosis.missing[0].document, "expected");
  assert.equal(diagnosis.missing[0].observed_rank, Infinity);
  assert.equal(diagnosis.downstream[0].diagnosis, "RETRIEVAL_RANK_MISS");
});

/* ---------------------------------------------------------------- refusal */

test("common ways of saying I do not know all register as refusals", () => {
  for (const s of [
    "The documents do not contain information about a parental leave policy.",
    "There is no record of a Series A term sheet in these sources.",
    "Nothing recorded on this.",
    "I cannot determine the match percentage from the provided documents.",
    "The retrieved sources are silent on office lease terms.",
    "I was unable to find any mention of this.",
  ]) {
    assert.ok(looksLikeRefusal(s), `should be a refusal: ${s}`);
  }
});

test("a confident fabrication is not mistaken for a refusal", () => {
  for (const s of [
    "The parental leave policy provides twelve weeks at full pay [1].",
    "The Series A closed at a 40 million dollar post money valuation.",
    "We match 4 percent of employee contributions.",
    "There is no doubt the fictional event happened on Tuesday.",
  ]) {
    assert.ok(!looksLikeRefusal(s), `should NOT be a refusal: ${s}`);
  }
});

test("a null answer is inconclusive, never a pass", () => {
  const r = scoreRefusal({ answer: null, answer_error: "daily spend cap reached", gaps: [] });
  assert.equal(r.pass, false);
  assert.equal(r.inconclusive, true, "no answer proves nothing about whether it would fabricate");
});

test("gaps alone do not earn a pass, because the sentence is what a client reads", () => {
  const r = scoreRefusal({ answer: "The policy grants twelve weeks [1].", gaps: [{ type: "thin_coverage" }] });
  assert.equal(r.pass, false);
  assert.equal(r.gaps, 1);
});

test("refusal language cannot mask an affirmative claim", () => {
  for (const answer of [
    "The documents do not contain that policy, but employees receive twelve weeks of paid leave.",
    "There is no record of the transaction. It closed for 40 million dollars on Tuesday.",
    "I cannot determine the rate from the sources; the company match is definitely four percent.",
    "The documents do not contain that policy and the benefit lasts twelve weeks.",
    "There is no record of the transaction: it closed on Tuesday.",
    "Nothing was found in the corpus — the payment was 40 million dollars.",
  ]) {
    assert.equal(looksLikeRefusal(answer), false, answer);
    const scored = scoreRefusal({ answer, gaps: [{ type: "missing" }] });
    assert.equal(scored.pass, false, answer);
    assert.match(scored.detail, /affirmative claim/, answer);
  }
});

test("a clean refusal may offer a bounded next step", () => {
  const answer = "The documents do not contain that policy. If you share the agreement, I can check it.";
  assert.equal(looksLikeRefusal(answer), true);
  assert.equal(scoreRefusal({ answer, gaps: [] }).pass, true);
});

/* ------------------------------------------------ deterministic answers */

const answerQuestion = (claim) => ({
  expect: [
    { slot_id: "policy", doc: "Policy", any_of: ["curated:policy-a"] },
    { slot_id: "amount", doc: "Approval", any_of: ["drive:FILE-A"] },
  ],
  answer_expect: {
    claim_boundary: "sentence",
    claims: [claim],
  },
});

test("a required literal claim passes only with an inline resolvable citation", () => {
  const question = answerQuestion({
    claim_id: "policy-code",
    contains_any: ["the policy code is AX-17"],
    evidence_slot_ids: ["policy"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: "The policy code is ax-17 [2].",
    citations: [{ n: 2, source: "curated", ref: "policy-a", title: "Policy" }],
  });
  assert.equal(scored.pass, true);
  assert.equal(scored.matched_claims, 1);
  assert.equal(scored.cited_claims, 1);
  assert.equal(scored.resolved_claims, 1);
  assert.equal(scored.claim_boundary, "sentence");
});

test("a citation in another sentence does not attach itself to the claim", () => {
  const question = answerQuestion({
    claim_id: "policy-code",
    contains_any: ["the policy code is AX-17"],
    evidence_slot_ids: ["policy"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: "The policy code is AX-17. A different observation appears here [1].",
    citations: [{ n: 1, source: "curated", ref: "policy-a", title: "Policy" }],
  });
  assert.equal(scored.pass, false);
  assert.deepEqual(scored.failures, ["CITATION_MISSING"]);
});

test("a typed numeric exact value normalizes separators and resolves a Drive reference", () => {
  const question = answerQuestion({
    claim_id: "approved-limit",
    exact_value: {
      type: "number", canonical: 1250, normalization: "numeric", tolerance: 0,
    },
    evidence_slot_ids: ["amount"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: "The approved limit is $1,250.00 [3].",
    citations: [{ n: 3, source: "drive", ref: "FILE-A", title: "Folder/Approval.pdf" }],
  });
  assert.equal(scored.pass, true);
  assert.equal(scored.claims[0].citation_resolved, true);
});

test("typed string and ISO-date exact values use only their declared normalization", () => {
  const stringScore = scoreDeterministicAnswer(answerQuestion({
    claim_id: "record-code",
    exact_value: {
      type: "string", canonical: "AX  17", normalization: "casefold_whitespace", tolerance: null,
    },
    evidence_slot_ids: ["policy"],
  }), {
    answer: "The record code is ax 17 [1].",
    citations: [{ n: 1, source: "curated", ref: "policy-a" }],
  });
  assert.equal(stringScore.pass, true);

  const dateScore = scoreDeterministicAnswer(answerQuestion({
    claim_id: "effective-date",
    exact_value: {
      type: "date", canonical: "2026-08-25", normalization: "iso_date", tolerance: null,
    },
    evidence_slot_ids: ["policy"],
  }), {
    answer: "The effective date is 2026-08-25 [1].",
    citations: [{ n: 1, source: "curated", ref: "policy-a" }],
  });
  assert.equal(dateScore.pass, true);
});

test("a citation number cannot masquerade as the expected numeric value", () => {
  const question = answerQuestion({
    claim_id: "approved-limit",
    exact_value: {
      type: "number", canonical: 1, normalization: "numeric", tolerance: 0,
    },
    evidence_slot_ids: ["amount"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: "The approved limit is not stated [1].",
    citations: [{ n: 1, source: "drive", ref: "FILE-A" }],
  });
  assert.equal(scored.pass, false);
  assert.deepEqual(scored.failures, ["CLAIM_MISSING"]);
});

test("a number embedded in an alphanumeric code is not an exact numeric value", () => {
  const question = answerQuestion({
    claim_id: "approved-limit",
    exact_value: {
      type: "number", canonical: 17, normalization: "numeric", tolerance: 0,
    },
    evidence_slot_ids: ["amount"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: "The record code is AX-17 [1].",
    citations: [{ n: 1, source: "drive", ref: "FILE-A" }],
  });
  assert.equal(scored.pass, false);
  assert.deepEqual(scored.failures, ["CLAIM_MISSING"]);
});

test("a present citation to the wrong source is unresolved, not accepted by number alone", () => {
  const question = answerQuestion({
    claim_id: "policy-code",
    contains_any: ["the policy code is AX-17"],
    evidence_slot_ids: ["policy"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: "The policy code is AX-17 [1].",
    citations: [{ n: 1, source: "curated", ref: "different-policy", title: "Policy" }],
  });
  assert.equal(scored.pass, false);
  assert.equal(scored.claims[0].citation_present, true);
  assert.equal(scored.claims[0].citation_resolved, false);
  assert.deepEqual(scored.failures, ["CITATION_UNRESOLVABLE"]);
});

test("no generated answer is inconclusive and retains no raw response content", () => {
  const question = answerQuestion({
    claim_id: "policy-code",
    contains_any: ["the policy code is AX-17"],
    evidence_slot_ids: ["policy"],
  });
  const scored = scoreDeterministicAnswer(question, {
    answer: null,
    answer_error: "synthetic provider detail that must not be copied",
  });
  assert.equal(scored.pass, false);
  assert.equal(scored.inconclusive, true);
  assert.doesNotMatch(JSON.stringify(scored), /synthetic provider detail/);
});

/* ------------------------------------------------------- baseline diffing */

test("a question falling out of the top k is reported as a regression", () => {
  const baseline = { questions: [{ id: "q1", scorable: true, satisfiedAt: 2 }] };
  const current = {
    questions: [{ id: "q1", question: "?", scorable: true, satisfiedAt: 9 }],
  };
  const regs = findRegressions(current, baseline, 5);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].to, "rank 9");
  assert.equal(findImprovements(current, baseline, 5).length, 0);
});

test("moving within the top k is neither a regression nor an improvement", () => {
  const baseline = { questions: [{ id: "q1", scorable: true, satisfiedAt: 1 }] };
  const current = { questions: [{ id: "q1", question: "?", scorable: true, satisfiedAt: 4 }] };
  assert.equal(findRegressions(current, baseline, 5).length, 0);
  assert.equal(findImprovements(current, baseline, 5).length, 0);
});

test("a question entering the top k is reported as an improvement", () => {
  const baseline = { questions: [{ id: "q1", scorable: true, satisfiedAt: Infinity }] };
  const current = { questions: [{ id: "q1", question: "?", scorable: true, satisfiedAt: 3 }] };
  const imp = findImprovements(current, baseline, 5);
  assert.equal(imp.length, 1);
  assert.equal(imp[0].from, "not in results");
});

test("an unanswerable question that starts answering is a regression", () => {
  const baseline = { questions: [{ id: "u1", kind: "unanswerable", refusal: { pass: true } }] };
  const current = {
    questions: [{ id: "u1", kind: "unanswerable", question: "?", refusal: { pass: false } }],
  };
  const regs = findRegressions(current, baseline, 5);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].to, "answered anyway");
});

test("a deterministic answer that stops passing is a regression", () => {
  const baseline = {
    questions: [{ id: "a1", kind: "single", scorable: true, satisfiedAt: 1, answer: { pass: true } }],
  };
  const current = {
    questions: [{
      id: "a1", kind: "single", question: "?", scorable: true, satisfiedAt: 1,
      answer: { pass: false, failures: ["CLAIM_MISSING"] },
    }],
  };
  const regressions = findRegressions(current, baseline, 5);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].from, "deterministic answer passed");
  assert.equal(regressions[0].to, "deterministic answer failed");
});

test("skipping a previously passing unanswerable repeat is a regression", () => {
  const baseline = {
    questions: [{ id: "u1", repeat: 2, kind: "unanswerable", refusal: { pass: true } }],
  };
  const current = {
    questions: [{
      id: "u1", repeat: 2, kind: "unanswerable", question: "?", refusal: null,
      skipped: "think probe disabled",
    }],
  };
  const regressions = findRegressions(current, baseline, 5);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].repeat, 2);
  assert.equal(regressions[0].to, "not evaluated");
});

test("a regression in a later repeat is compared instead of being discarded", () => {
  const baseline = {
    questions: [
      { id: "q1", repeat: 1, scorable: true, satisfiedAt: 1 },
      { id: "q1", repeat: 2, scorable: true, satisfiedAt: 2 },
    ],
  };
  const current = {
    questions: [
      { id: "q1", repeat: 1, question: "?", scorable: true, satisfiedAt: 1 },
      { id: "q1", repeat: 2, question: "?", scorable: true, satisfiedAt: Infinity },
    ],
  };
  const regressions = findRegressions(current, baseline, 5);
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].repeat, 2);
});

test("a new question with no baseline entry is not counted either way", () => {
  const baseline = { questions: [] };
  const current = { questions: [{ id: "new", scorable: true, satisfiedAt: Infinity }] };
  assert.equal(findRegressions(current, baseline, 5).length, 0);
});

test("no baseline means no regressions, so a first run never fails the gate", () => {
  assert.deepEqual(findRegressions({ questions: [{ id: "a", scorable: true, satisfiedAt: Infinity }] }, null), []);
});

/* ------------------------------------------------------ dedupe vs raw rank */

test("dedupe can only improve a rank, never worsen it", () => {
  const q = { expect: [{ doc: "d", any_of: ["curated:target"] }] };
  const results = [drive("A"), drive("A"), drive("A"), curated("target")];
  assert.equal(scoreQuestion(q, results).satisfiedAt, 4);
  assert.equal(scoreQuestion(q, dedupeByDocument(results)).satisfiedAt, 2);
});

test("message results are identified by their chunk ref_key", () => {
  assert.deepEqual(identitiesOf(message("uuid-1")), ["message:uuid-1"]);
});

/* ------------------------------------------- the miss survives a JSON round trip */

test("plain JSON.stringify would destroy a miss, which is why jsonReplacer exists", () => {
  assert.equal(JSON.parse(JSON.stringify({ satisfiedAt: Infinity })).satisfiedAt, null);
  assert.ok(null <= 5, "and null compares as zero, so a miss would read as rank 0");
});

test("a saved run reloads with its misses intact", () => {
  const saved = roundTrip({ questions: [{ id: "q1", scorable: true, satisfiedAt: Infinity }] });
  assert.equal(saved.questions[0].satisfiedAt, "Infinity");
  assert.equal(rankOf(saved.questions[0]), Infinity);
});

test("comparing a saved run against itself reports nothing", () => {
  // The bug this pins: a run with misses, saved and reloaded, used to report
  // every one of those misses as a brand new regression against itself.
  const run = {
    questions: [
      { id: "q1", question: "?", scorable: true, satisfiedAt: 2 },
      { id: "q2", question: "?", scorable: true, satisfiedAt: Infinity },
      { id: "q3", question: "?", scorable: true, satisfiedAt: Infinity },
    ],
  };
  const reloaded = roundTrip(run);
  assert.deepEqual(findRegressions(run, reloaded, 5), []);
  assert.deepEqual(findImprovements(run, reloaded, 5), []);
});

test("a real regression is still caught after a round trip", () => {
  const baseline = roundTrip({ questions: [{ id: "q1", scorable: true, satisfiedAt: 2 }] });
  const current = { questions: [{ id: "q1", question: "?", scorable: true, satisfiedAt: Infinity }] };
  const regs = findRegressions(current, baseline, 5);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].from, "rank 2");
  assert.equal(regs[0].to, "not in results");
});

test("a real improvement is still caught after a round trip", () => {
  const baseline = roundTrip({ questions: [{ id: "q1", scorable: true, satisfiedAt: Infinity }] });
  const current = { questions: [{ id: "q1", question: "?", scorable: true, satisfiedAt: 1 }] };
  assert.equal(findImprovements(current, baseline, 5).length, 1);
});

test("aggregate reads a reloaded miss as a miss rather than as rank zero", () => {
  const reloaded = roundTrip([
    { scorable: true, satisfiedAt: 1 },
    { scorable: true, satisfiedAt: Infinity },
  ]);
  const a = aggregate(reloaded, [1, 5]);
  assert.equal(a.recall[5], 0.5);
  assert.equal(a.mrr, 0.5);
});
