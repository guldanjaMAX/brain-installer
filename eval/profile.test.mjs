import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVAL_PROFILES,
  RELEASE_PROFILE_MINIMUMS,
  evaluateProfileCoverage,
  formatProfileFailures,
} from "./profile.mjs";

function releaseSuite() {
  const questions = Array.from({ length: 60 }, (_, index) => {
    const kind = index < 10 ? "unanswerable" : index < 25 ? "multi" : "single";
    return {
      id: `synthetic-${index + 1}`,
      kind,
      risk: index < 10 ? "critical" : "normal",
      domains: [index < 30 ? "alpha" : "beta"],
      formats: [index % 2 === 0 ? "pdf" : "text"],
      question: `Synthetic question ${index + 1}`,
      expect: kind === "unanswerable" ? [] : [{ source: "curated", doc: "Synthetic fixture" }],
    };
  });
  return {
    schema_version: 1,
    release_slices: {
      risk: ["critical", "normal"],
      domain: ["alpha", "beta"],
      format: ["pdf", "text"],
      query_kind: ["single", "multi", "unanswerable"],
    },
    questions,
  };
}

test("profile names and release thresholds are fixed product policy", () => {
  assert.deepEqual(EVAL_PROFILES, ["smoke", "release"]);
  assert.deepEqual(RELEASE_PROFILE_MINIMUMS, {
    suite_cases: 60,
    cases_per_required_slice: 5,
  });
});

test("smoke remains a diagnostic profile for a small valid suite", () => {
  const result = evaluateProfileCoverage({ questions: [{ id: "one" }] }, "smoke");
  assert.equal(result.profile, "smoke");
  assert.equal(result.scope, "diagnostic-smoke");
  assert.deepEqual(result.failures, []);
});

test("smoke rejects an empty suite in the pre-credential aggregate gate", () => {
  const result = evaluateProfileCoverage({ questions: [] }, "smoke");
  assert.deepEqual(result.failures, [{
    code: "SUITE_BELOW_MINIMUM",
    observed: 0,
    minimum: 1,
  }]);
  assert.match(formatProfileFailures(result), /smoke profile coverage gate failed before retrieval/);
  assert.match(formatProfileFailures(result), /smoke requires at least 1/);
});

test("release accepts the exact suite and required-slice coverage floor", () => {
  const result = evaluateProfileCoverage(releaseSuite(), "release");
  assert.deepEqual(result.failures, []);
  assert.equal(result.scope, "v1-retrieval-suite-coverage");
  assert.equal(result.observed.suite_cases, 60);
  assert.equal(result.observed.slices.query_kind.unanswerable, 10);
  assert.equal(result.observed.slices.domain.alpha, 30);
});

test("release rejects a small suite and an underrepresented named slice", () => {
  const suite = releaseSuite();
  suite.questions.length = 59;
  suite.release_slices.query_kind.push("temporal");
  suite.questions[10].kind = "temporal";

  const result = evaluateProfileCoverage(suite, "release");
  assert.ok(result.failures.some((entry) =>
    entry.code === "SUITE_BELOW_MINIMUM" && entry.observed === 59 && entry.minimum === 60));
  assert.ok(result.failures.some((entry) =>
    entry.code === "REQUIRED_SLICE_BELOW_MINIMUM" && entry.dimension === "query_kind" &&
    entry.value === "temporal" && entry.observed === 1 && entry.minimum === 5));
});

test("release requires an explicit coverage contract and all case labels", () => {
  const noContract = releaseSuite();
  delete noContract.release_slices;
  assert.ok(evaluateProfileCoverage(noContract, "release").failures.some(
    (entry) => entry.code === "RELEASE_SLICES_REQUIRED",
  ));

  const unlabeled = releaseSuite();
  delete unlabeled.questions[0].formats;
  assert.ok(evaluateProfileCoverage(unlabeled, "release").failures.some(
    (entry) => entry.code === "CASES_MISSING_SLICE_LABEL" && entry.dimension === "format",
  ));
});

test("unanswerable coverage is derived from executable kind, not a conflicting query_kind label", () => {
  const suite = releaseSuite();
  for (const question of suite.questions.filter((entry) => entry.kind === "unanswerable")) {
    question.kind = "single";
    question.query_kind = "unanswerable";
    question.expect = [{ source: "curated", doc: "Synthetic fixture" }];
  }

  const result = evaluateProfileCoverage(suite, "release");
  assert.equal(result.observed.slices.query_kind.unanswerable ?? 0, 0);
  assert.ok(result.failures.some((entry) =>
    entry.code === "QUERY_KIND_MUST_MATCH_KIND" && entry.observed === 10));
  assert.ok(result.failures.some((entry) =>
    entry.code === "REQUIRED_SLICE_BELOW_MINIMUM" && entry.dimension === "query_kind" &&
    entry.value === "unanswerable" && entry.observed === 0));
});

test("release coverage failures contain no private case text or source references", () => {
  const suite = releaseSuite();
  suite.questions.length = 1;
  suite.questions[0].question = "PRIVATE owner question that must never reach a gate diagnostic";
  suite.questions[0].expect = [{ any_of: ["drive_path:Private/Owner/File.pdf"] }];

  const result = evaluateProfileCoverage(suite, "release");
  const output = `${JSON.stringify(result)}\n${formatProfileFailures(result)}`;
  assert.doesNotMatch(output, /PRIVATE owner question|Private\/Owner\/File\.pdf|synthetic-1/);
});

test("unknown profiles fail closed", () => {
  assert.throws(
    () => evaluateProfileCoverage(releaseSuite(), "certify-everything"),
    /evaluation profile must be one of: smoke, release/,
  );
});
