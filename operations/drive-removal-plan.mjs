import { createHash } from "node:crypto";

// A routine sync may clean up a few ordinary source changes without making an
// unattended scheduler unusable. Crossing either boundary is no longer
// routine: it may indicate a revoked permission, a bad listing, or a policy
// mistake, and therefore needs an exact second look from the owner.
export const DRIVE_REMOVAL_MAX_COUNT = 100;
export const DRIVE_REMOVAL_MAX_RATIO = 0.10;

const CATEGORY_INPUTS = Object.freeze([
  ["source_policy", "policyCandidates"],
  ["source_deleted", "vanishedCandidates"],
  ["intentional_skip", "intentionalCandidates"],
]);

function normalizedSet(values, label) {
  if (values == null) return new Set();
  if (typeof values === "string" || typeof values[Symbol.iterator] !== "function") {
    throw new TypeError(`${label} must be an iterable of document identifiers`);
  }
  return new Set([...values].map((value) => String(value || "").trim()).filter(Boolean));
}

/**
 * Build the one deletion decision for a Drive sync.
 *
 * Candidates that are not currently stored are harmless bookkeeping, not
 * deletion targets. A target appearing in more than one reason is assigned to
 * the first reason below so the aggregate count cannot be inflated or applied
 * twice. Only the opaque digest is shown to the owner.
 */
export function buildDriveRemovalPlan(input = {}, options = {}) {
  const storedFamilies = normalizedSet(input.storedFamilies, "storedFamilies");
  const activeFamilies = normalizedSet(input.activeFamilies, "activeFamilies");
  const assigned = new Set();
  const targets = {};

  for (const [category, inputKey] of CATEGORY_INPUTS) {
    const candidates = normalizedSet(input[inputKey], inputKey);
    targets[category] = [...candidates]
      .filter((uid) =>
        storedFamilies.has(uid) &&
        !assigned.has(uid) &&
        // A pending source-deletion marker can survive a lost response. If the
        // file is active again on retry, restoration wins. Policy and current
        // quality refusals remain independent reasons to remove it.
        (category !== "source_deleted" || !activeFamilies.has(uid))
      )
      .sort();
    for (const uid of targets[category]) assigned.add(uid);
  }

  const stored = storedFamilies.size;
  const counts = Object.fromEntries(
    CATEGORY_INPUTS.map(([category]) => [category, targets[category].length])
  );
  const total = assigned.size;
  const ratio = stored ? total / stored : 0;
  const maxCount = options.maxCount ?? DRIVE_REMOVAL_MAX_COUNT;
  const maxRatio = options.maxRatio ?? DRIVE_REMOVAL_MAX_RATIO;
  if (!Number.isInteger(maxCount) || maxCount < 0) throw new TypeError("maxCount must be a non-negative integer");
  if (!Number.isFinite(maxRatio) || maxRatio < 0 || maxRatio > 1) {
    throw new TypeError("maxRatio must be between zero and one");
  }

  // Version and category assignment are part of the approval. Reclassifying a
  // target or changing the plan invalidates an earlier approval even when the
  // aggregate total happens to stay the same.
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    stored,
    targets: CATEGORY_INPUTS.map(([category]) => [category, targets[category]]),
  })).digest("hex");

  return {
    total,
    stored,
    ratio,
    counts,
    targets,
    fingerprint,
    tooLarge: total > maxCount || ratio > maxRatio,
  };
}

/** Refuse a surprising plan without disclosing any source identifier. */
export function assertDriveRemovalPlanSafe(plan, approval) {
  if (!plan || typeof plan !== "object" || !/^[0-9a-f]{64}$/.test(String(plan.fingerprint || ""))) {
    throw new TypeError("Drive removal plan is invalid");
  }
  if (!plan.tooLarge || approval === plan.fingerprint) return plan;

  const percent = (Number(plan.ratio || 0) * 100).toFixed(1);
  throw new Error(
    `Drive cleanup would remove ${plan.total} of ${plan.stored} stored documents (${percent}%).\n` +
      `      Aggregate reasons: source policy ${plan.counts.source_policy}; source deletion ${plan.counts.source_deleted}; intentional skip ${plan.counts.intentional_skip}.\n` +
      "      Nothing in this removal plan was removed. The source cursor was not advanced.\n" +
      "      Review the source and policy, then approve this exact plan by re-running with:\n" +
      `      --approve-removals ${plan.fingerprint}`
  );
}
