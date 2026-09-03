import { createHash } from "node:crypto";

// A routine sync may clean up a few ordinary source changes without making an
// unattended scheduler unusable. Crossing either boundary is no longer
// routine: it may indicate a revoked permission, a bad listing, or a policy
// mistake, and therefore needs an exact second look from the owner.
export const DRIVE_REMOVAL_MAX_COUNT = 100;
export const DRIVE_REMOVAL_MAX_RATIO = 0.10;

// Only named connector outcomes may turn an active file into a stale-removal
// candidate. A future or untyped skip defaults to retention, because deleting
// a migrated D1 document on the strength of a reason this build does not
// understand is not a fail-closed decision.
const VERSION_AWARE_DRIVE_SKIP_CODES = new Set([
  "unsupported_google_type",
  "non_text_media",
  "unsupported_extension",
  "download_limit",
  "file_unavailable",
  "binary_content",
  "extraction_refused",
  "quality_refused",
]);

/** True only for the current canonical `driveVersion()` receipt shape. */
export function isTrustedDriveVersion(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 5 && parsed.every((part) => typeof part === "string");
  } catch {
    return false;
  }
}

/**
 * Decide what an active Drive skip means for an already stored document.
 *
 * Security refusals always remove the prior copy. Ordinary typed skips remove
 * it only when two trusted Drive receipts prove the source revision changed.
 * Missing migration state, an unchanged revision, and unknown skip codes all
 * preserve the existing D1 family for a later supported reread or an explicit
 * owner decision.
 */
export function classifyActiveDriveSkip({
  code,
  currentVersion,
  priorAcceptedVersion,
  securityRefusal = false,
} = {}) {
  if (securityRefusal) {
    return { disposition: "remove_sensitive", reasonCode: "security_refusal" };
  }

  const normalizedCode = String(code || "").trim().toLowerCase();
  if (!VERSION_AWARE_DRIVE_SKIP_CODES.has(normalizedCode)) {
    return { disposition: "retain_existing", reasonCode: "unknown_skip" };
  }
  if (!isTrustedDriveVersion(priorAcceptedVersion)) {
    return { disposition: "retain_existing", reasonCode: "untrusted_prior_version" };
  }
  if (!isTrustedDriveVersion(currentVersion)) {
    return { disposition: "retain_existing", reasonCode: "untrusted_current_version" };
  }
  if (priorAcceptedVersion !== currentVersion) {
    return { disposition: "remove_stale", reasonCode: "known_changed_revision" };
  }
  return { disposition: "retain_existing", reasonCode: "current_revision_unreadable" };
}

/** A deliberate owner-review boundary, not an installer crash. */
export class DriveRemovalReviewRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "DriveRemovalReviewRequired";
    this.code = "SAFETY_REVIEW_REQUIRED";
  }
}

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
/**
 * Owner-readable description of a removal plan: one row per document, grouped
 * by category, with the display path and the reason the installer recorded.
 * Pure so the review file can be tested without Drive or a worker.
 */
export function describeDriveRemovalPlan(plan, { pathByUid = new Map(), reasonByUid = new Map() } = {}) {
  if (!plan || typeof plan !== "object" || !plan.targets) throw new TypeError("Drive removal plan is invalid");
  const categories = {};
  for (const [category] of CATEGORY_INPUTS) {
    const uids = Array.isArray(plan.targets[category]) ? [...plan.targets[category]].sort() : [];
    categories[category] = uids.map((uid) => ({
      uid,
      path: pathByUid.get(uid) ?? null,
      reason: reasonByUid.get(uid) ?? (category === "source_deleted" ? "no longer listed in the Drive source" : null),
    }));
  }
  return {
    fingerprint: plan.fingerprint,
    total: plan.total,
    stored: plan.stored,
    percent: Number(((plan.ratio || 0) * 100).toFixed(1)),
    categories,
  };
}

export function renderDriveRemovalReview(description) {
  const labels = { source_policy: "Excluded by the Drive source policy", source_deleted: "No longer found in Drive", intentional_skip: "Now skipped on purpose" };
  const lines = [
    "# Drive cleanup review",
    "",
    `${description.total} of ${description.stored} stored documents (${description.percent}%) would be removed from the brain.`,
    "Nothing has been removed. Approve this exact plan with:",
    "",
    `    --approve-removals ${description.fingerprint}`,
    "",
  ];
  for (const [category, rows] of Object.entries(description.categories)) {
    lines.push(`## ${labels[category] || category} (${rows.length})`, "");
    if (!rows.length) lines.push("(none)", "");
    for (const row of rows) lines.push(`- ${row.path || row.uid}${row.reason ? ` — ${row.reason}` : ""}`);
    if (rows.length) lines.push("");
  }
  return lines.join("\n");
}

export function assertDriveRemovalPlanSafe(plan, approval) {
  if (!plan || typeof plan !== "object" || !/^[0-9a-f]{64}$/.test(String(plan.fingerprint || ""))) {
    throw new TypeError("Drive removal plan is invalid");
  }
  if (!plan.tooLarge || approval === plan.fingerprint) return plan;

  const percent = (Number(plan.ratio || 0) * 100).toFixed(1);
  throw new DriveRemovalReviewRequired(
    `Drive cleanup would remove ${plan.total} of ${plan.stored} stored documents (${percent}%).\n` +
      `      Aggregate reasons: source policy ${plan.counts.source_policy}; source deletion ${plan.counts.source_deleted}; intentional skip ${plan.counts.intentional_skip}.\n` +
      "      Nothing in this removal plan was removed. The source cursor was not advanced.\n" +
      "      Review the source and policy, then approve this exact plan by re-running with:\n" +
      `      --approve-removals ${plan.fingerprint}`
  );
}
