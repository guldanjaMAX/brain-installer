const GOLDEN_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateAnswerExpectation(question, path, slotIds) {
  const expectation = question.answer_expect;
  if (expectation === undefined) return;
  if (question.kind === "unanswerable") {
    throw new Error(`${path}: ${question.id} is unanswerable and cannot declare answer_expect`);
  }
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) {
    throw new Error(`${path}: ${question.id} answer_expect must be an object`);
  }
  const extraExpectationFields = Object.keys(expectation)
    .filter((field) => !new Set(["claim_boundary", "claims"]).has(field));
  if (extraExpectationFields.length > 0) {
    throw new Error(`${path}: ${question.id} answer_expect has unknown fields`);
  }
  if (expectation.claim_boundary !== "sentence") {
    throw new Error(`${path}: ${question.id} answer_expect.claim_boundary must be sentence`);
  }
  if (!Array.isArray(expectation.claims) || expectation.claims.length === 0) {
    throw new Error(`${path}: ${question.id} answer_expect.claims must contain at least one required claim`);
  }

  const claimIds = new Set();
  for (const claim of expectation.claims) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      throw new Error(`${path}: ${question.id} answer claims must be objects`);
    }
    const extraClaimFields = Object.keys(claim).filter((field) =>
      !new Set(["claim_id", "contains_any", "exact_value", "evidence_slot_ids"]).has(field));
    if (extraClaimFields.length > 0) {
      throw new Error(`${path}: ${question.id} answer claim has unknown fields`);
    }
    if (!GOLDEN_LABEL.test(String(claim.claim_id || "")) || claimIds.has(claim.claim_id)) {
      throw new Error(`${path}: ${question.id} answer claim_id values must be unique lowercase labels`);
    }
    claimIds.add(claim.claim_id);
    if (!Array.isArray(claim.evidence_slot_ids) || claim.evidence_slot_ids.length === 0 ||
        new Set(claim.evidence_slot_ids).size !== claim.evidence_slot_ids.length ||
        claim.evidence_slot_ids.some((id) => !slotIds.has(id))) {
      throw new Error(`${path}: ${question.id} claim ${claim.claim_id} must name unique existing evidence_slot_ids`);
    }

    const hasPhrases = claim.contains_any !== undefined;
    const hasExactValue = claim.exact_value !== undefined;
    if (hasPhrases === hasExactValue) {
      throw new Error(`${path}: ${question.id} claim ${claim.claim_id} must declare exactly one of contains_any or exact_value`);
    }
    if (hasPhrases) {
      if (!Array.isArray(claim.contains_any) || claim.contains_any.length === 0 ||
          claim.contains_any.length > 10 ||
          claim.contains_any.some((phrase) => typeof phrase !== "string" || !phrase.trim() ||
            phrase.length > 500 || /\[\d+\]/.test(phrase))) {
        throw new Error(`${path}: ${question.id} claim ${claim.claim_id} contains_any must be 1 to 10 citation-free phrases`);
      }
      continue;
    }

    const exact = claim.exact_value;
    if (!exact || typeof exact !== "object" || Array.isArray(exact)) {
      throw new Error(`${path}: ${question.id} claim ${claim.claim_id} exact_value must be an object`);
    }
    const exactFields = Object.keys(exact);
    if (exactFields.some((field) => !new Set(["type", "canonical", "normalization", "tolerance"]).has(field)) ||
        !["type", "canonical", "normalization", "tolerance"].every((field) => exactFields.includes(field))) {
      throw new Error(`${path}: ${question.id} claim ${claim.claim_id} exact_value fields are invalid`);
    }
    if (exact.type === "number") {
      if (exact.normalization !== "numeric" || typeof exact.canonical !== "number" ||
          !Number.isFinite(exact.canonical) || typeof exact.tolerance !== "number" ||
          !Number.isFinite(exact.tolerance) || exact.tolerance < 0) {
        throw new Error(`${path}: ${question.id} numeric exact_value requires a finite canonical, numeric normalization, and non-negative tolerance`);
      }
    } else if (exact.type === "string") {
      if (!["none", "casefold_whitespace"].includes(exact.normalization) ||
          typeof exact.canonical !== "string" || !exact.canonical || exact.tolerance !== null) {
        throw new Error(`${path}: ${question.id} string exact_value requires a string canonical, supported normalization, and null tolerance`);
      }
    } else if (exact.type === "date") {
      const parsedDate = Date.parse(`${exact.canonical}T00:00:00Z`);
      if (exact.normalization !== "iso_date" || typeof exact.canonical !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(exact.canonical) || exact.tolerance !== null ||
          !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== exact.canonical) {
        throw new Error(`${path}: ${question.id} date exact_value requires a valid ISO date and null tolerance`);
      }
    } else {
      throw new Error(`${path}: ${question.id} exact_value type must be string, number, or date in the deterministic v1 scorer`);
    }
  }
}

/** Validate the exact executable v1 evaluation-golden contract. */
export function validateGolden(golden, path = "evaluation golden") {
  const schemaVersion = Number(golden?.schema_version ?? 1);
  if (schemaVersion !== 1) {
    throw new Error(
      `${path} uses evaluation schema v${schemaVersion}. This runner currently executes the v1 ` +
      `question format; v2 contracts are documented in docs/EVALUATION.md but are not yet an execution claim.`,
    );
  }
  if (!Array.isArray(golden?.questions) || golden.questions.length === 0) {
    throw new Error(`${path} has no questions array`);
  }
  const ids = new Set();
  for (const q of golden.questions) {
    if (!q.id) throw new Error(`${path}: a question has no id`);
    if (ids.has(q.id)) throw new Error(`${path}: duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.question) throw new Error(`${path}: ${q.id} has no question text`);
    if (q.risk !== undefined && !new Set(["critical", "high", "normal"]).has(q.risk)) {
      throw new Error(`${path}: ${q.id} risk must be critical, high, or normal`);
    }
    for (const field of ["domains", "formats"]) {
      if (q[field] === undefined) continue;
      if (!Array.isArray(q[field]) || q[field].length === 0 ||
          q[field].some((value) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value)))) {
        throw new Error(`${path}: ${q.id} ${field} must be non-empty lowercase labels`);
      }
    }
    const expect = q.expect || [];
    if (q.kind === "unanswerable") {
      if (expect.length > 0) throw new Error(`${path}: ${q.id} is unanswerable but names expected documents`);
      validateAnswerExpectation(q, path, new Set());
      continue;
    }
    if (expect.length === 0) throw new Error(`${path}: ${q.id} expects nothing and is not marked unanswerable`);
    const sharedGroups = new Map();
    const slotIds = new Set();
    for (const slot of expect) {
      const hasReferences = Array.isArray(slot.any_of) && slot.any_of.length > 0;
      if (!hasReferences && !String(slot.doc || "").trim()) {
        throw new Error(`${path}: ${q.id} has a slot with neither a document title nor any_of references`);
      }
      if (hasReferences && slot.any_of.some((value) =>
        !/^[a-z0-9][a-z0-9_-]{0,63}:.+/.test(String(value)))) {
        throw new Error(`${path}: ${q.id} any_of references must include their source prefix, such as drive: or curated:`);
      }
      if (!hasReferences && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(slot.source || ""))) {
        throw new Error(`${path}: ${q.id} title-only evidence must name its source`);
      }
      if (slot.slot_id !== undefined) {
        if (q.answer_expect !== undefined &&
            (!GOLDEN_LABEL.test(String(slot.slot_id)) || slotIds.has(slot.slot_id))) {
          throw new Error(`${path}: ${q.id} slot_id values must be unique lowercase labels`);
        }
        slotIds.add(slot.slot_id);
      }
      if (slot.shared_result_group !== undefined) {
        const group = String(slot.shared_result_group);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(group)) {
          throw new Error(`${path}: ${q.id} shared_result_group must be a lowercase label`);
        }
        sharedGroups.set(group, (sharedGroups.get(group) || 0) + 1);
      }
    }
    for (const [group, count] of sharedGroups) {
      if (count < 2) {
        throw new Error(`${path}: ${q.id} shared_result_group ${group} must be used by at least two slots`);
      }
    }
    validateAnswerExpectation(q, path, slotIds);
  }
  return golden;
}
