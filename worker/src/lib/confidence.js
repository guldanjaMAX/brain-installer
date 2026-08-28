// confidence.js — turn signals the answer pipeline already computes into one
// honest, displayable number.
//
// The owner asked the obvious question about every answer: "how much should I
// trust this?" The pipeline already knows: the evidence gate verified the
// citations, retrieval knows how many independent documents agree and whether
// their dates are reliable, and the gap computation knows what the corpus is
// blind to. This module only AGGREGATES those signals; it never invents a
// judgement of its own and it never calls a model.
//
// The percentage is a DETERMINISTIC RUBRIC SCORE, not a calibrated
// probability. Same inputs, same number, every time — which is what makes it
// honest to show: the basis list states exactly which signals produced it, so
// a reader can disagree with the rubric rather than with an oracle. It is
// clamped below 95 because retrieval over a private corpus can never prove
// completeness, and above 5 because a gated, cited answer is never worthless.
//
// Two shapes, one contract:
//   computeAnswerConfidence — for an answer that SURVIVED the evidence gate.
//   refusalConfidence       — for "nothing recorded": how sure are we that the
//                             absence is real rather than a blind spot.
//
// The result rides the /think response as a structured `confidence` field and
// is rendered by the CLI as its own line. It is deliberately NOT woven into
// the answer text: the eval's refusal scorer requires every clause of a
// refusal to read as a refusal, and a dozen worker tests pin the canonical
// refusal sentence verbatim. The answer string stays canonical; trust
// metadata travels beside it.

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(value)));

function band(percent) {
  return percent >= 80 ? "high" : percent >= 55 ? "moderate" : "low";
}

/** Shared gap penalties: what the corpus admits it cannot see. */
function gapAdjustments(gaps, degraded) {
  const basis = [];
  let delta = 0;
  const types = new Set((gaps || []).map((gap) => String(gap?.type || "")));
  if (degraded === "vector") {
    delta -= 15;
    basis.push("vector index not fully query-ready");
  } else if (degraded) {
    // Any other degradation is still half the search missing. Scoring only the
    // one named mode let "no-embedding" and "fts" price in at full confidence,
    // which is the same conflation retrieval-status.js exists to end.
    delta -= 12;
    basis.push(`retrieval degraded: ${String(degraded).slice(0, 40)}`);
  }
  if (types.has("filter_not_applied")) {
    delta -= 10;
    basis.push("a requested filter was not applied");
  }
  if (types.has("stale")) {
    delta -= 8;
    basis.push("newest evidence in the corpus is old for this topic");
  }
  if ((gaps || []).some((gap) => /stopped updating/i.test(String(gap?.detail || "")))) {
    delta -= 8;
    basis.push("a source has stopped updating recently");
  }
  return { delta, basis };
}

/**
 * Confidence in an answer that passed the evidence gate.
 *
 * approvedDocs are the citations the verifier explicitly endorsed — the only
 * documents the reader is shown. Independent agreement is counted over those.
 */
export function computeAnswerConfidence({ approvedDocs = [], gaps = [], degraded = null } = {}) {
  const basis = [];
  // A surviving answer has, by construction, passed citation checks and the
  // second-model evidence gate. That baseline is what the 65 encodes.
  let score = 65;
  basis.push(`evidence gate approved ${approvedDocs.length} citation${approvedDocs.length === 1 ? "" : "s"}`);

  const distinctDocs = new Set(approvedDocs.map((doc) => doc.ref || doc.title)).size;
  if (distinctDocs >= 3) {
    score += 15;
    basis.push(`${distinctDocs} independent documents agree`);
  } else if (distinctDocs === 2) {
    score += 10;
    basis.push("two independent documents agree");
  } else {
    basis.push("single supporting document");
  }

  const dated = approvedDocs.filter((doc) => doc.ts);
  if (dated.length && dated.every((doc) => doc.date_reliable === true)) {
    score += 10;
    basis.push("every cited date is reliable");
  } else if (dated.some((doc) => doc.date_reliable !== true)) {
    score -= 8;
    basis.push("a cited date is unverified");
  } else if (!dated.length) {
    score -= 5;
    basis.push("cited evidence is undated");
  }

  // Evidence a machine read off a picture of a page. The rubric does not judge
  // how well it read; it prices the fact that a reading step stands between the
  // page and the sentence, which a text layer does not have. A partial read is
  // worse than a whole one because some page of that document is missing from
  // the evidence entirely, and the answer cannot know which.
  const ocrDocs = approvedDocs.filter((doc) => doc.text_source === "ocr" || doc.text_source === "ocr_partial");
  if (ocrDocs.length) {
    const partial = ocrDocs.some((doc) => doc.text_source === "ocr_partial");
    const all = ocrDocs.length === approvedDocs.length;
    score -= partial ? 18 : 12;
    basis.push(
      `${all ? "every" : `${ocrDocs.length} of ${approvedDocs.length}`} cited document was read by OCR from a scanned image` +
      (partial ? ", and at least one has pages that could not be read" : ""),
    );
  }

  const adjust = gapAdjustments(gaps, degraded);
  score += adjust.delta;
  basis.push(...adjust.basis);

  const percent = clamp(score, 5, 95);
  return { percent, band: band(percent), basis };
}

/**
 * Confidence that a refusal reflects real absence.
 *
 * "Nothing recorded" earned by healthy retrieval that surfaced candidates and
 * had every one rejected is strong evidence of absence. The same sentence
 * during a degraded vector index or a stalled source is a much weaker claim,
 * and the number should say so.
 */
export function refusalConfidence({ gaps = [], degraded = null, resultCount = 0, sources = [] } = {}) {
  const basis = [];
  let score = 80;
  basis.push(resultCount > 0
    ? `checked ${resultCount} nearest candidate${resultCount === 1 ? "" : "s"}${sources.length ? ` across ${sources.join(", ")}` : ""}; none supported the claim`
    : "retrieval found no candidates at all");

  const adjust = gapAdjustments(gaps, degraded);
  // Blind spots hit a refusal harder than an answer: an answer's evidence is
  // in hand, while a refusal's correctness depends on what was NOT seen.
  score += adjust.delta * 1.5;
  basis.push(...adjust.basis);

  const percent = clamp(score, 10, 95);
  return { percent, band: band(percent), basis };
}

/** One-line rendering shared by the CLI and anything else that prints it. */
export function confidenceLine(confidence, { refused = false } = {}) {
  if (!confidence || !Number.isFinite(confidence.percent)) return null;
  const label = refused ? "Confidence nothing is recorded" : "Confidence";
  return `${label}: ${confidence.percent}% (${confidence.band}) — ${confidence.basis.join("; ")}.`;
}
