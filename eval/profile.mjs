/**
 * Deterministic evaluation-profile coverage gates.
 *
 * This module inspects suite metadata only. It never reads document content,
 * expected source references, question text, credentials, or a live brain.
 * Keeping the gate pure lets CI prove the release floor before any private
 * query is sent over the network.
 */

export const EVAL_PROFILES = Object.freeze(["smoke", "release"]);

export const RELEASE_PROFILE_MINIMUMS = Object.freeze({
  suite_cases: 60,
  cases_per_required_slice: 5,
});

const RELEASE_DIMENSIONS = Object.freeze(["risk", "domain", "format", "query_kind"]);
const LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function labelsOf(question, dimension) {
  if (dimension === "risk") return question.risk ? [question.risk] : [];
  if (dimension === "domain") return Array.isArray(question.domains) ? question.domains : [];
  if (dimension === "format") return Array.isArray(question.formats) ? question.formats : [];
  const value = question.query_kind || question.kind;
  return value ? [value] : [];
}

function countLabels(questions, dimension) {
  const counts = new Map();
  let unlabeled = 0;
  for (const question of questions) {
    const labels = labelsOf(question, dimension);
    if (labels.length === 0) unlabeled++;
    for (const label of new Set(labels)) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return { counts, unlabeled };
}

function failure(code, fields = {}) {
  return { code, ...fields };
}

/**
 * Return aggregate-only coverage evidence. Failure records deliberately omit
 * case IDs, questions, expected sources, paths, and corpus identifiers.
 */
export function evaluateProfileCoverage(golden, requestedProfile = "smoke") {
  const profile = String(requestedProfile || "smoke").trim().toLowerCase();
  if (!EVAL_PROFILES.includes(profile)) {
    throw new Error(`evaluation profile must be one of: ${EVAL_PROFILES.join(", ")}`);
  }

  const questions = Array.isArray(golden?.questions) ? golden.questions : [];
  if (profile === "smoke") {
    return {
      profile,
      scope: "diagnostic-smoke",
      minimums: { suite_cases: 1 },
      observed: { suite_cases: questions.length },
      required_slices: {},
      failures: [],
    };
  }

  const minimums = RELEASE_PROFILE_MINIMUMS;
  const failures = [];
  if (questions.length < minimums.suite_cases) {
    failures.push(failure("SUITE_BELOW_MINIMUM", {
      observed: questions.length,
      minimum: minimums.suite_cases,
    }));
  }

  const contract = golden?.release_slices;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    failures.push(failure("RELEASE_SLICES_REQUIRED"));
  }

  const requiredSlices = {};
  const observedSlices = {};
  for (const dimension of RELEASE_DIMENSIONS) {
    const required = Array.isArray(contract?.[dimension]) ? contract[dimension] : [];
    requiredSlices[dimension] = [...new Set(required.map(String))].sort();
    const invalid = required.filter((value) => !LABEL.test(String(value)));
    if (required.length === 0) {
      failures.push(failure("REQUIRED_SLICE_DIMENSION_EMPTY", { dimension }));
    } else if (invalid.length > 0 || requiredSlices[dimension].length !== required.length) {
      failures.push(failure("REQUIRED_SLICE_LABELS_INVALID", { dimension }));
    }

    const { counts, unlabeled } = countLabels(questions, dimension);
    observedSlices[dimension] = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
    if (unlabeled > 0) {
      failures.push(failure("CASES_MISSING_SLICE_LABEL", { dimension, observed: unlabeled }));
    }
    const invalidObserved = questions.filter((question) =>
      labelsOf(question, dimension).some((value) => !LABEL.test(String(value))),
    ).length;
    if (invalidObserved > 0) {
      failures.push(failure("CASES_WITH_INVALID_SLICE_LABEL", {
        dimension,
        observed: invalidObserved,
      }));
    }

    const declared = new Set(requiredSlices[dimension]);
    const undeclaredCount = [...counts].reduce(
      (total, [value, count]) => total + (declared.has(value) ? 0 : count),
      0,
    );
    if (undeclaredCount > 0) {
      failures.push(failure("CASES_OUTSIDE_REQUIRED_SLICES", {
        dimension,
        observed: undeclaredCount,
      }));
    }

    for (const value of requiredSlices[dimension]) {
      const observed = counts.get(value) || 0;
      if (observed < minimums.cases_per_required_slice) {
        failures.push(failure("REQUIRED_SLICE_BELOW_MINIMUM", {
          dimension,
          value,
          observed,
          minimum: minimums.cases_per_required_slice,
        }));
      }
    }
  }

  if (!requiredSlices.risk?.includes("critical")) {
    failures.push(failure("CRITICAL_RISK_SLICE_REQUIRED"));
  }
  if (!requiredSlices.query_kind?.includes("unanswerable")) {
    failures.push(failure("UNANSWERABLE_SLICE_REQUIRED"));
  }
  if (!requiredSlices.query_kind?.some((value) => value !== "unanswerable")) {
    failures.push(failure("ANSWERABLE_SLICE_REQUIRED"));
  }

  return {
    profile,
    scope: "v1-retrieval-suite-coverage",
    minimums,
    observed: { suite_cases: questions.length, slices: observedSlices },
    required_slices: requiredSlices,
    failures,
  };
}

export function formatProfileFailures(result) {
  const lines = result.failures.map((entry) => {
    if (entry.code === "SUITE_BELOW_MINIMUM") {
      return `suite has ${entry.observed} cases; release requires at least ${entry.minimum}`;
    }
    if (entry.code === "RELEASE_SLICES_REQUIRED") {
      return "release_slices must declare risk, domain, format, and query_kind coverage";
    }
    if (entry.code === "REQUIRED_SLICE_DIMENSION_EMPTY") {
      return `release_slices.${entry.dimension} must name at least one required slice`;
    }
    if (entry.code === "REQUIRED_SLICE_LABELS_INVALID") {
      return `release_slices.${entry.dimension} must contain unique lowercase labels`;
    }
    if (entry.code === "CASES_MISSING_SLICE_LABEL") {
      return `${entry.observed} cases have no explicit ${entry.dimension} label`;
    }
    if (entry.code === "CASES_WITH_INVALID_SLICE_LABEL") {
      return `${entry.observed} cases have an invalid ${entry.dimension} label`;
    }
    if (entry.code === "CASES_OUTSIDE_REQUIRED_SLICES") {
      return `${entry.observed} ${entry.dimension} assignments are outside release_slices.${entry.dimension}`;
    }
    if (entry.code === "REQUIRED_SLICE_BELOW_MINIMUM") {
      return `${entry.dimension}:${entry.value} has ${entry.observed} cases; release requires at least ${entry.minimum}`;
    }
    if (entry.code === "CRITICAL_RISK_SLICE_REQUIRED") {
      return "release_slices.risk must include critical";
    }
    if (entry.code === "UNANSWERABLE_SLICE_REQUIRED") {
      return "release_slices.query_kind must include unanswerable";
    }
    if (entry.code === "ANSWERABLE_SLICE_REQUIRED") {
      return "release_slices.query_kind must include at least one answerable query kind";
    }
    return entry.code;
  });
  return `release profile coverage gate failed before retrieval:\n  - ${lines.join("\n  - ")}`;
}
