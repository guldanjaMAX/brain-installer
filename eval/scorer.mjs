/**
 * scorer — turn a list of retrieved results into recall@k and MRR.
 *
 * Pure functions only. Nothing here touches the network, the filesystem or the
 * clock, which is what makes the numbers reproducible and the unit tests worth
 * running. Everything that talks to a brain lives in brain-client.mjs.
 *
 * THE MEASUREMENT, stated plainly so nobody has to reverse engineer it from a
 * number on a report:
 *
 *   A question is SATISFIED at rank r when every document the question needs has
 *   appeared somewhere in the first r results. For a single document question
 *   that is just the rank of that document. For a two document question it is
 *   the rank of the second one to show up, because an answer assembled from one
 *   half of the evidence is not an answer.
 *
 *   question pass@k is the share of questions satisfied at rank k or better.
 *   MRR is the mean reciprocal rank of the first relevant result. Complete
 *   evidence remains a separate metric so an early partial hit cannot hide a
 *   missing second source.
 *
 * Duplicates are the reason two sets of numbers come out of one run. This corpus
 * returns several chunks of the same file in one page of results, so a top 5 can
 * really be a top 2 in terms of distinct documents. RAW counts what the caller
 * actually received, which is the honest measure of a fixed result budget. BY
 * DOCUMENT collapses repeats first, which is what a reader perceives. Reporting
 * only the second one flatters the system; reporting only the first hides a real
 * regression when a change starts wasting slots on repeats. So both are printed.
 */

/**
 * Every identity string a single result can legitimately answer to.
 *
 * A Drive result's `ref_key` is the id of a CHUNK row and is reassigned on every
 * re-index, so it is deliberately not an identity. Matching Drive on
 * drive_file_id (stable) or on path (human readable) is what keeps a golden set
 * usable a month after it was written.
 */
export function identitiesOf(result) {
  if (!result || typeof result !== "object") return [];
  const source = result.source || "unknown";
  const ids = [];

  if (source === "drive") {
    if (result.drive_file_id) ids.push(`drive:${result.drive_file_id}`);
    if (result.title) ids.push(`drive_path:${result.title}`);
  } else if (result.ref_key) {
    ids.push(`${source}:${result.ref_key}`);
  }

  // Last resort so an unrecognised shape still gets a stable handle rather than
  // silently matching nothing and reading as a retrieval failure.
  if (ids.length === 0) {
    const fallback = result.ref_key || result.drive_file_id || result.title;
    if (fallback) ids.push(`${source}:${fallback}`);
  }
  return ids;
}

/** The one identity used for dedupe and for display. */
export function documentKeyOf(result) {
  return identitiesOf(result)[0] || null;
}

/** Collapse repeat chunks of the same document, keeping the best ranked one. */
export function dedupeByDocument(results) {
  const seen = new Set();
  const out = [];
  for (const r of results || []) {
    const key = documentKeyOf(r);
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Rank (1 based) of the first result matching any acceptable reference for a
 * slot, or Infinity when the slot never appears.
 */
export function resultMatchesSlot(slot, result) {
  const raw = slot.any_of || [];
  const accept = new Set(raw);
  const expectedTitle = String(slot.doc || "").trim();

  // Exact title matching is the human-friendly fallback promised by the
  // shipped template, but only inside an explicit source. Titles and bare keys
  // are not globally unique, so accepting either across sources can certify the
  // wrong document as evidence for a critical case.
  if (expectedTitle && slot.source && result?.source === slot.source &&
      String(result?.title || "").trim() === expectedTitle) return true;
  for (const id of identitiesOf(result)) {
    if (accept.has(id)) return true;
  }
  return false;
}

const sharedGroupOf = (slot, index) => {
  const group = String(slot?.shared_result_group || "").trim();
  return group ? `shared:${group}` : `slot:${index}`;
};

/**
 * Assign evidence units to distinct logical documents.
 *
 * Scoring every slot independently lets one broad result satisfy two required
 * documents. Requiring a distinct document per unit closes that loophole while
 * `shared_result_group` remains an explicit escape hatch for the uncommon case
 * where several slots intentionally describe evidence from the same document.
 *
 * This is a maximum bipartite matching, rather than a greedy walk. A broad slot
 * that matches A or B must not consume A when a narrower slot can only match A.
 */
function assignEvidence(question, results) {
  const slots = Array.isArray(question?.expect) ? question.expect : [];
  const ranked = Array.isArray(results) ? results : [];
  const unitsByKey = new Map();
  for (let index = 0; index < slots.length; index++) {
    const key = sharedGroupOf(slots[index], index);
    const unit = unitsByKey.get(key) || { key, slotIndexes: [] };
    unit.slotIndexes.push(index);
    unitsByKey.set(key, unit);
  }
  const units = [...unitsByKey.values()];

  // A shared unit is deliberately stricter than an OR: the one selected
  // document has to match every slot that opted into the group.
  const candidates = units.map((unit) => {
    const firstRankByDocument = new Map();
    for (let index = 0; index < ranked.length; index++) {
      const result = ranked[index];
      const document = documentKeyOf(result);
      if (!document || firstRankByDocument.has(document)) continue;
      if (unit.slotIndexes.every((slotIndex) => resultMatchesSlot(slots[slotIndex], result))) {
        firstRankByDocument.set(document, index + 1);
      }
    }
    return [...firstRankByDocument].map(([document, rank]) => ({ document, rank }))
      .sort((a, b) => a.rank - b.rank || a.document.localeCompare(b.document));
  });

  // Scarce units go first. The augmenting path still makes this a maximum
  // matching, while the ordering makes the chosen ranks stable and intuitive.
  const unitOrder = units.map((_unit, index) => index).sort(
    (a, b) => candidates[a].length - candidates[b].length || a - b,
  );
  const documentToUnit = new Map();
  const unitToCandidate = new Map();

  const augment = (unitIndex, seenDocuments) => {
    for (const candidate of candidates[unitIndex]) {
      if (seenDocuments.has(candidate.document)) continue;
      seenDocuments.add(candidate.document);
      const occupiedBy = documentToUnit.get(candidate.document);
      if (occupiedBy === undefined || augment(occupiedBy, seenDocuments)) {
        documentToUnit.set(candidate.document, unitIndex);
        unitToCandidate.set(unitIndex, candidate);
        return true;
      }
    }
    return false;
  };
  for (const unitIndex of unitOrder) augment(unitIndex, new Set());

  const slotRanks = new Array(slots.length).fill(Infinity);
  const assignments = [];
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const candidate = unitToCandidate.get(unitIndex);
    if (!candidate) continue;
    for (const slotIndex of units[unitIndex].slotIndexes) slotRanks[slotIndex] = candidate.rank;
    assignments.push({
      unit: units[unitIndex].key,
      slotIndexes: [...units[unitIndex].slotIndexes],
      document: candidate.document,
      rank: candidate.rank,
    });
  }
  return { slotRanks, assignments, units };
}

/**
 * Score one question against one ordered result list.
 *
 * Returns the rank at which the question became fully answerable plus the
 * per slot detail, because "recall@5 dropped" is not actionable and "the second
 * document for q14 fell out of the window" is.
 */
export function scoreQuestion(question, results) {
  const ranked = Array.isArray(results) ? results : [];
  let evidence = assignEvidence(question, ranked);
  // Maximum-cardinality matching on the complete list does not promise the
  // smallest bottleneck rank. Find the earliest prefix with complete evidence
  // so satisfiedAt remains the literal depth where the question became usable.
  if (evidence.units.length > 0) {
    for (let depth = 1; depth <= ranked.length; depth++) {
      const atDepth = assignEvidence(question, ranked.slice(0, depth));
      if (atDepth.assignments.length === atDepth.units.length) {
        evidence = atDepth;
        break;
      }
    }
  }
  const slots = (question.expect || []).map((slot, index) => ({
    doc: slot.doc,
    rank: evidence.slotRanks[index],
  }));

  // A question with no expected document cannot be scored on rank. Unanswerable
  // entries take that branch and are handled by scoreRefusal instead.
  if (slots.length === 0) return { slots, satisfiedAt: null, firstRelevantAt: null, scorable: false };

  const satisfiedAt = slots.reduce((worst, s) => Math.max(worst, s.rank), 0);
  const firstRelevantAt = slots.reduce((best, s) => Math.min(best, s.rank), Infinity);
  return { slots, satisfiedAt, firstRelevantAt, scorable: true };
}

/**
 * Does this answer admit it does not know?
 *
 * Kept generous on purpose. The failure this catches is a confident fabrication,
 * and any phrasing that concedes the corpus is silent counts as the right
 * behavior regardless of how it is worded. A brain that produced no answer at
 * all (no LLM key, spend cap reached) is NOT counted as an honest refusal,
 * because that says nothing about whether it would have made something up.
 */
const REFUSAL_RE =
  /\b(do(es)?\s+not\s+(contain|answer|address|include|cover|mention|specify|provide)|no\s+(information|record|records|mention|reference|documents?|evidence|data)\b|nothing\s+(?:(?:was|is)\s+)?(recorded|found|in\s+the)|not\s+(found|present|available|documented)\s+in\b|unable\s+to\s+(find|locate)|i\s+(don'?t|do\s+not)\s+have\b|cannot\s+(find|answer|determine)|silent\s+on\b)/i;

// Helpful next steps are allowed only as complete, bounded clauses. Prefix
// matching here would recreate the original bug by letting a safe opening hide
// an arbitrary factual claim at the end of the same sentence.
const SAFE_REFUSAL_FOLLOWUPS = [
  /^(?:please|you(?:'d| would)? need to)\s+(?:provide|share|upload)\s+[\p{L}\p{N}_' -]{1,120}$/iu,
  /^more\s+(?:information|evidence|context)\s+(?:is|would be)\s+(?:needed|required)(?:\s+to\s+(?:answer|check|verify|determine)\s+(?:it|that|this|the\s+question))?$/i,
  /^(?:if|once|when)\s+you\s+(?:provide|share|upload)\s+[^,.;:]{1,120},?\s+i\s+(?:can|could|would be able to)\s+(?:help|check|review|answer)(?:\s+(?:it|that|this|them|the\s+question))?$/iu,
  /^i\s+(?:can|could|would be able to)\s+(?:help|check|review|answer)(?:\s+(?:it|that|this|them|the\s+question))?\s+(?:if|once|when)\s+you\s+(?:provide|share|upload)\s+[^,.;:]{1,120}$/iu,
];

function refusalAssessment(answer) {
  if (typeof answer !== "string" || !REFUSAL_RE.test(answer)) {
    return { pass: false, mixedClaim: false };
  }

  // A refusal phrase is not a magic substring. Split adversative clauses and
  // sentences so "the corpus is silent, but X happened" cannot pass merely
  // because its first half contains the right words.
  const clauses = answer
    .replace(/\[[^\]]{1,80}\]/g, " ")
    .split(/(?:[.!?;:\n]+|\s+[—–-]\s+|\b(?:and|but|however|although|though|yet|nevertheless|nonetheless|still|whereas|while|so)\b[:,]?)/i)
    .map((clause) => clause.trim().replace(/^[,:\s]+|[,:\s]+$/g, ""))
    .filter(Boolean);
  let sawRefusal = false;
  for (const clause of clauses) {
    if (REFUSAL_RE.test(clause)) {
      sawRefusal = true;
      continue;
    }
    if (SAFE_REFUSAL_FOLLOWUPS.some((pattern) => pattern.test(clause))) continue;
    return { pass: false, mixedClaim: true };
  }
  return { pass: sawRefusal, mixedClaim: false };
}

export function looksLikeRefusal(answer) {
  return refusalAssessment(answer).pass;
}

/**
 * Score an unanswerable question from a /think response.
 *
 * Pass means the brain said it did not know. Gaps alone are not enough: the
 * gap list is advisory and can sit next to a confidently wrong sentence, and it
 * is the sentence a client reads.
 */
export function scoreRefusal(thinkResponse) {
  const answer = thinkResponse?.answer ?? null;
  const gaps = Array.isArray(thinkResponse?.gaps) ? thinkResponse.gaps.length : 0;

  if (answer === null) {
    return {
      pass: false,
      inconclusive: true,
      gaps,
      detail: thinkResponse?.answer_error || "no answer produced",
    };
  }
  const assessment = refusalAssessment(answer);
  const refused = assessment.pass;
  return {
    pass: refused,
    inconclusive: false,
    gaps,
    detail: refused
      ? "stated that the corpus does not answer this"
      : assessment.mixedClaim
        ? "included an affirmative claim alongside refusal language"
      : "answered as though the corpus contains this",
  };
}

/* ------------------------------------------------ deterministic answers */

const CITATION_MARKER_RE = /\[(\d+)\]/g;
const NUMERIC_VALUE_RE = /(?<![\p{L}\p{N}_+\.\-])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}_\.\-])/gu;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Locate a deterministic claim matcher without pretending to understand
 * paraphrases. `contains_any` is case-insensitive and whitespace-flexible;
 * exact values use only the normalization explicitly declared in the suite.
 */
function locateClaimMatch(answer, claim) {
  if (Array.isArray(claim?.contains_any)) {
    for (const phrase of claim.contains_any) {
      const pattern = String(phrase).trim().split(/\s+/).map(escapeRegex).join("\\s+");
      const match = new RegExp(pattern, "iu").exec(answer);
      if (match) return { start: match.index, end: match.index + match[0].length };
    }
    return null;
  }

  const exact = claim?.exact_value;
  if (!exact) return null;
  if (exact.normalization === "numeric") {
    const expected = Number(exact.canonical);
    const tolerance = Number(exact.tolerance ?? 0);
    for (const match of answer.matchAll(NUMERIC_VALUE_RE)) {
      const observed = Number(match[0].replaceAll(",", ""));
      if (Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance) {
        return { start: match.index, end: match.index + match[0].length };
      }
    }
    return null;
  }

  const canonical = String(exact.canonical);
  if (exact.normalization === "casefold_whitespace") {
    const pattern = canonical.trim().split(/\s+/).map(escapeRegex).join("\\s+");
    const match = new RegExp(pattern, "iu").exec(answer);
    return match ? { start: match.index, end: match.index + match[0].length } : null;
  }
  if (exact.normalization === "iso_date") {
    const match = new RegExp(`(?<!\\d)${escapeRegex(canonical)}(?!\\d)`, "u").exec(answer);
    return match ? { start: match.index, end: match.index + match[0].length } : null;
  }
  const index = answer.indexOf(canonical);
  return index >= 0 ? { start: index, end: index + canonical.length } : null;
}

/**
 * Return the sentence-like boundary that owns a matched atomic claim.
 * Citations outside this boundary do not count for the claim. This is a
 * deliberately narrow syntactic rule, not a semantic support judgment.
 */
function claimBoundary(answer, match) {
  const breaks = /[.!?;](?:\s+|$)|\n+/gu;
  let start = 0;
  let end = answer.length;
  for (const boundary of answer.matchAll(breaks)) {
    const boundaryStart = boundary.index;
    const boundaryEnd = boundary.index + boundary[0].length;
    if (boundaryEnd <= match.start) {
      start = boundaryEnd;
      continue;
    }
    if (boundaryStart >= match.end) {
      end = boundaryStart;
      break;
    }
  }
  return answer.slice(start, end);
}

function citationResult(citation) {
  const source = String(citation?.source || "");
  const ref = citation?.ref == null ? null : String(citation.ref);
  return {
    source,
    title: citation?.title == null ? null : String(citation.title),
    ref_key: ref,
    drive_file_id: source === "drive" ? ref : null,
  };
}

/**
 * Score only the deterministic answer contract declared by `answer_expect`.
 *
 * This proves literal atomic-claim or typed exact-value presence plus an inline
 * citation resolving to an allowed evidence slot. It does not score additional
 * generated claims, semantic paraphrases, citation support, or faithfulness.
 * Those remain explicitly outside this judge-free v1 slice.
 */
export function scoreDeterministicAnswer(question, thinkResponse) {
  const expectation = question?.answer_expect;
  if (!expectation) return null;
  const answer = typeof thinkResponse?.answer === "string" ? thinkResponse.answer.trim() : "";
  const claims = Array.isArray(expectation.claims) ? expectation.claims : [];
  if (!answer) {
    return {
      pass: false,
      inconclusive: true,
      claim_boundary: "sentence",
      required_claims: claims.length,
      matched_claims: 0,
      cited_claims: 0,
      resolved_claims: 0,
      false_refusal: false,
      failures: ["ANSWER_NOT_PRODUCED"],
      claims: claims.map((claim) => ({
        claim_id: claim.claim_id,
        matched: false,
        citation_present: false,
        citation_resolved: false,
        failure: "ANSWER_NOT_PRODUCED",
      })),
    };
  }

  // Citation numbers are metadata, not answer values. Preserve byte-for-byte
  // positions while hiding the markers from claim matching so an expected
  // numeric value of 1 cannot pass merely because the answer contains `[1]`.
  const answerForMatching = answer.replace(/\[\d+\]/g, (marker) => " ".repeat(marker.length));

  const citationsByNumber = new Map();
  const ambiguousNumbers = new Set();
  for (const citation of Array.isArray(thinkResponse?.citations) ? thinkResponse.citations : []) {
    const number = Number(citation?.n);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    if (citationsByNumber.has(number)) ambiguousNumbers.add(number);
    else citationsByNumber.set(number, citation);
  }
  for (const number of ambiguousNumbers) citationsByNumber.delete(number);

  const slotsById = new Map((question.expect || []).map((slot) => [slot.slot_id, slot]));
  const scoredClaims = claims.map((claim) => {
    const match = locateClaimMatch(answerForMatching, claim);
    if (!match) {
      return {
        claim_id: claim.claim_id,
        matched: false,
        citation_present: false,
        citation_resolved: false,
        failure: "CLAIM_MISSING",
      };
    }
    const boundary = claimBoundary(answer, match);
    const citationNumbers = [...boundary.matchAll(CITATION_MARKER_RE)]
      .map((entry) => Number(entry[1]));
    const expectedSlots = (claim.evidence_slot_ids || []).map((id) => slotsById.get(id)).filter(Boolean);
    const resolved = citationNumbers.some((number) => {
      const citation = citationsByNumber.get(number);
      return citation && expectedSlots.some((slot) => resultMatchesSlot(slot, citationResult(citation)));
    });
    return {
      claim_id: claim.claim_id,
      matched: true,
      citation_present: citationNumbers.length > 0,
      citation_resolved: !!resolved,
      failure: citationNumbers.length === 0
        ? "CITATION_MISSING"
        : resolved
          ? null
          : "CITATION_UNRESOLVABLE",
    };
  });

  const falseRefusal = looksLikeRefusal(answer);
  const failures = [
    ...(falseRefusal ? ["ANSWER_REFUSED"] : []),
    ...scoredClaims.map((claim) => claim.failure).filter(Boolean),
  ].filter((value, index, all) => all.indexOf(value) === index);
  return {
    pass: failures.length === 0,
    inconclusive: false,
    claim_boundary: "sentence",
    required_claims: scoredClaims.length,
    matched_claims: scoredClaims.filter((claim) => claim.matched).length,
    cited_claims: scoredClaims.filter((claim) => claim.citation_present).length,
    resolved_claims: scoredClaims.filter((claim) => claim.citation_resolved).length,
    false_refusal: falseRefusal,
    failures,
    claims: scoredClaims,
  };
}

/** Legacy `recall` field (question pass@k), first-relevant MRR, and pass list. */
export function aggregate(scored, ks = [1, 5]) {
  const scorable = scored.filter((s) => s.scorable);
  const n = scorable.length;
  const recall = {};
  for (const k of ks) {
    recall[k] = n === 0 ? 0 : scorable.filter((s) => rankOf(s) <= k).length / n;
  }
  const mrr =
    n === 0
      ? 0
      : scorable.reduce((sum, s) => {
          const r = Number.isFinite(s.firstRelevantAt) ? s.firstRelevantAt : rankOf(s);
          return sum + (Number.isFinite(r) ? 1 / r : 0);
        }, 0) / n;
  return { n, recall, mrr };
}

/**
 * Deterministic evidence-quality metrics for one ranked result list.
 *
 * These measure retrieval only. They do not pretend that a retrieved document
 * was parsed correctly or that the answer used it. Those are separate stages
 * in the Eval v2 diagnosis so a good retrieval score cannot hide an OCR or
 * generation failure.
 */
export function retrievalQuality(question, results, ks = [1, 5, 10]) {
  const slots = Array.isArray(question?.expect) ? question.expect : [];
  const ranked = Array.isArray(results) ? results : [];
  const grades = slots.map((slot) => {
    const value = Number(slot?.relevance_grade ?? 3);
    return Number.isFinite(value) ? Math.min(3, Math.max(0, value)) : 3;
  });
  const out = {};

  for (const rawK of ks) {
    const k = Math.max(1, Number(rawK) || 1);
    const top = ranked.slice(0, k);
    const evidence = assignEvidence(question, top);
    const relevant = evidence.assignments.length;
    const unique = new Set(top.map(documentKeyOf).filter(Boolean)).size;

    // A logical document earns one grade, even when repeated chunks or several
    // explicitly shared slots point at it.
    const gradeByDocument = new Map(evidence.assignments.map((assignment) => [
      assignment.document,
      Math.max(...assignment.slotIndexes.map((slotIndex) => grades[slotIndex])),
    ]));
    const seenDocuments = new Set();
    const observedGrades = top.map((result) => {
      const document = documentKeyOf(result);
      if (!document || seenDocuments.has(document)) return 0;
      seenDocuments.add(document);
      return gradeByDocument.get(document) || 0;
    });
    const dcg = observedGrades.reduce(
      (sum, grade, index) => sum + (Math.pow(2, grade) - 1) / Math.log2(index + 2),
      0,
    );
    const idealGrades = evidence.units.map((unit) => Math.max(
      ...unit.slotIndexes.map((slotIndex) => grades[slotIndex]),
    )).sort((a, b) => b - a).slice(0, k);
    const ideal = idealGrades.reduce(
      (sum, grade, index) => sum + (Math.pow(2, grade) - 1) / Math.log2(index + 2),
      0,
    );

    out[k] = {
      slot_recall: slots.length
        ? evidence.slotRanks.filter((rank) => Number.isFinite(rank) && rank <= k).length / slots.length
        : null,
      complete_evidence: slots.length
        ? evidence.slotRanks.every((rank) => Number.isFinite(rank) && rank <= k)
        : null,
      precision: relevant / k,
      ndcg: ideal > 0 ? dcg / ideal : null,
      duplicate_waste: 1 - unique / k,
    };
  }
  return out;
}

/** Mean deterministic metrics across answerable questions. */
export function aggregateQuality(scored, k = 5) {
  const rows = (scored || []).map((entry) => entry?.quality?.[k]).filter(Boolean);
  if (!rows.length) {
    return {
      n: 0, slot_recall: 0, complete_evidence: 0, precision: 0, ndcg: 0, duplicate_waste: 0,
    };
  }
  const mean = (field) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length;
  return {
    n: rows.length,
    slot_recall: mean("slot_recall"),
    complete_evidence: rows.filter((row) => row.complete_evidence === true).length / rows.length,
    precision: mean("precision"),
    ndcg: mean("ndcg"),
    duplicate_waste: mean("duplicate_waste"),
  };
}

/**
 * The strongest diagnosis available from a retrieval-only run.
 *
 * Earlier corpus, ingest, and extraction stages stay explicit as unobservable
 * until a private corpus contract is supplied. Calling every miss a ranking
 * bug would send maintainers to the wrong subsystem when the file never made
 * it into the brain at all.
 */
export function diagnoseRetrieval(question, scored, k = 5) {
  if (!scored?.scorable || scored.satisfiedAt <= k) return null;
  return {
    primary: "NOT_OBSERVABLE_AT_STAGE",
    stage: "source_inventory",
    confidence: "observed_limit",
    detail: "the evaluator has no complete corpus contract proving that the expected source reached the index",
    missing: (scored.slots || [])
      .filter((slot) => !(Number.isFinite(slot.rank) && slot.rank <= k))
      .map((slot) => ({
        document: slot.doc,
        observed_rank: Number.isFinite(slot.rank) ? slot.rank : Infinity,
      })),
    downstream: [
      {
        diagnosis: "RETRIEVAL_RANK_MISS",
        status: "OBSERVED_SYMPTOM",
        detail: `required evidence was not complete in the first ${k} results`,
      },
    ],
    inspect: "corpus contract, connector receipt, extraction snapshot, then retrieval ranking",
  };
}

/**
 * A miss is Infinity in memory, and JSON.stringify writes Infinity as null.
 *
 * Read back naively, that null compares as 0 in JavaScript, so every question
 * that missed in the baseline reads as having passed at rank zero and every
 * miss in the new run reads as a fresh regression. The gate then fails on a
 * run that changed nothing. Rank comparisons go through here.
 */
export function rankOf(entry) {
  const r = entry?.satisfiedAt;
  if (typeof r === "number" && Number.isFinite(r)) return r;
  if (r === "Infinity" || r === null || r === undefined) return Infinity;
  return Infinity;
}

/** Replacer and reviver so a saved run survives the round trip through JSON. */
export function jsonReplacer(_key, value) {
  return value === Infinity ? "Infinity" : value;
}

/** Questions that passed before and fail now. This is the release gate. */
export function findRegressions(current, baseline, k = 5) {
  if (!baseline) return [];
  const executionKey = (entry) => `${entry.id}\u0000${Number(entry.repeat || 1)}`;
  const before = new Map((baseline.questions || []).map((q) => [executionKey(q), q]));
  const out = [];
  for (const q of current.questions || []) {
    const was = before.get(executionKey(q));
    if (!was) continue;

    if (q.kind === "unanswerable") {
      if (was.refusal?.pass && q.refusal?.pass !== true) {
        const to = q.skipped
          ? "not evaluated"
          : q.refusal?.inconclusive
            ? "inconclusive"
            : "answered anyway";
        out.push({
          id: q.id, repeat: Number(q.repeat || 1), question: q.question,
          from: "refused", to,
        });
      }
      continue;
    }
    if (!was.scorable || !q.scorable) continue;
    const wasRank = rankOf(was);
    const nowRank = rankOf(q);
    if (wasRank <= k && nowRank > k) {
      out.push({
        id: q.id,
        repeat: Number(q.repeat || 1),
        question: q.question,
        from: `rank ${wasRank}`,
        to: Number.isFinite(nowRank) ? `rank ${nowRank}` : "not in results",
      });
      continue;
    }
    if (was.answer?.pass === true && q.answer?.pass !== true) {
      out.push({
        id: q.id,
        repeat: Number(q.repeat || 1),
        question: q.question,
        from: "deterministic answer passed",
        to: q.answer_skipped
          ? "answer not evaluated"
          : q.answer?.inconclusive
            ? "answer inconclusive"
            : "deterministic answer failed",
      });
    }
  }
  return out;
}

/** Improvements, so a good change gets credit rather than a silent pass. */
export function findImprovements(current, baseline, k = 5) {
  if (!baseline) return [];
  const executionKey = (entry) => `${entry.id}\u0000${Number(entry.repeat || 1)}`;
  const before = new Map((baseline.questions || []).map((q) => [executionKey(q), q]));
  const out = [];
  for (const q of current.questions || []) {
    const was = before.get(executionKey(q));
    if (!was) continue;
    if (q.kind === "unanswerable") {
      if (was.refusal && !was.refusal.pass && q.refusal?.pass) {
        out.push({
          id: q.id, repeat: Number(q.repeat || 1), question: q.question,
          from: "answered anyway", to: "refused",
        });
      }
      continue;
    }
    if (!was.scorable || !q.scorable) continue;
    const wasRank = rankOf(was);
    const nowRank = rankOf(q);
    if (wasRank > k && nowRank <= k) {
      out.push({
        id: q.id,
        repeat: Number(q.repeat || 1),
        question: q.question,
        from: Number.isFinite(wasRank) ? `rank ${wasRank}` : "not in results",
        to: `rank ${nowRank}`,
      });
      continue;
    }
    if (was.answer && was.answer.pass !== true && q.answer?.pass === true) {
      out.push({
        id: q.id,
        repeat: Number(q.repeat || 1),
        question: q.question,
        from: "deterministic answer failed",
        to: "deterministic answer passed",
      });
    }
  }
  return out;
}
