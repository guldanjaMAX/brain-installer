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
  looksLikeRefusal,
  aggregate,
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
