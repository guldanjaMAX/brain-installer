import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeAnswerConfidence, refusalConfidence, confidenceLine,
} from "../src/lib/confidence.js";
import { looksLikeRefusal } from "../../eval/scorer.mjs";

const dated = (ref, reliable = true) => ({ ref, title: ref, ts: "2026-07-31T00:00:00Z", date_reliable: reliable });

test("the rubric is deterministic and bounded", () => {
  const input = { approvedDocs: [dated("a"), dated("b")], gaps: [], degraded: null };
  const first = computeAnswerConfidence(input);
  const second = computeAnswerConfidence(input);
  assert.deepEqual(first, second, "same inputs must give the same number");
  assert.ok(first.percent >= 5 && first.percent <= 95, "never certain, never worthless");
  assert.ok(["high", "moderate", "low"].includes(first.band));
  assert.ok(first.basis.length >= 2, "the basis must say where the number came from");
});

test("independent agreement and reliable dates raise confidence; blind spots lower it", () => {
  const single = computeAnswerConfidence({ approvedDocs: [dated("a")] });
  const agreeing = computeAnswerConfidence({ approvedDocs: [dated("a"), dated("b"), dated("c")] });
  assert.ok(agreeing.percent > single.percent, "three agreeing documents beat one");

  const unverified = computeAnswerConfidence({ approvedDocs: [dated("a", false)] });
  assert.ok(unverified.percent < single.percent, "an unverified date costs confidence");

  const degraded = computeAnswerConfidence({
    approvedDocs: [dated("a"), dated("b")],
    degraded: "vector",
    gaps: [{ type: "stale", detail: "newest is 120 days old" }],
  });
  const healthy = computeAnswerConfidence({ approvedDocs: [dated("a"), dated("b")] });
  assert.ok(degraded.percent < healthy.percent, "a degraded index must show in the number");
  assert.ok(degraded.basis.some((entry) => /vector/i.test(entry)), "the basis names the degradation");
});

test("a refusal during healthy retrieval outranks one during a blind spot", () => {
  const healthy = refusalConfidence({ resultCount: 8, sources: ["drive", "message"] });
  const blind = refusalConfidence({
    resultCount: 8,
    sources: ["drive"],
    degraded: "vector",
    gaps: [{ type: "coverage", detail: "the drive source stopped updating 4 days ago" }],
  });
  assert.ok(healthy.percent >= 80, "healthy absence is strong evidence");
  assert.ok(blind.percent <= healthy.percent - 20, "absence during a blind spot is a weak claim");
  assert.ok(healthy.basis[0].includes("8 nearest candidates"), "the basis states the scope checked");
});

test("confidence never leaks into the answer text a refusal scorer reads", () => {
  // The eval requires every clause of a refusal to read as a refusal. The
  // canonical sentence must stay a pass on its own, and the rendered
  // confidence line must live outside it — this test is the tripwire should
  // anyone ever concatenate the two.
  const canonical = "The documents do not answer the question.";
  assert.ok(looksLikeRefusal(canonical), "the canonical refusal must keep passing the scorer");
  const line = confidenceLine(refusalConfidence({ resultCount: 5, sources: ["drive"] }), { refused: true });
  assert.ok(line.startsWith("Confidence nothing is recorded:"), "refusal phrasing names what the number means");
  assert.ok(!looksLikeRefusal(`${canonical} ${line}`),
    "concatenating the confidence line breaks the refusal contract — it must stay a separate field");
});

test("confidenceLine is null-safe for older responses", () => {
  assert.equal(confidenceLine(undefined), null);
  assert.equal(confidenceLine({}), null);
  const line = confidenceLine(computeAnswerConfidence({ approvedDocs: [dated("a")] }));
  assert.match(line, /^Confidence: \d{1,2}% \((high|moderate|low)\) — .+\.$/);
});
