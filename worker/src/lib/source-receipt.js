/**
 * Privacy-safe failure contract for connector source receipts.
 *
 * Provider errors can contain filenames, account names, remote identifiers,
 * request URLs, or source content. They are useful in the private local
 * terminal, but they are not safe durable metadata. The Worker therefore
 * accepts only one of these closed issue codes for an error receipt and treats
 * every missing or unknown value as the generic INGEST_FAILED code.
 */
export const SOURCE_RECEIPT_ISSUE_CODES = Object.freeze([
  "AUTH_DENIED",
  "AUTH_EXPIRED",
  "AUTH_REQUIRED",
  "COMMAND_FAILED",
  "CONFIG_INVALID",
  "EXTRACTION_FAILED",
  "FORMAT_UNSUPPORTED",
  "HEALTH_CHECK_FAILED",
  "INDEX_WRITE_FAILED",
  "INGEST_FAILED",
  "INPUT_REFUSED",
  "INTERNAL_ERROR",
  "MIGRATION_FAILED",
  "NETWORK_UNREACHABLE",
  "PDF_PROCESS_FAILED",
  "PDF_PROCESS_TIMEOUT",
  "RATE_LIMITED",
  "REMOTE_NOT_FOUND",
  "REMOTE_PERMISSION_DENIED",
  "REMOTE_UNAVAILABLE",
  "SAFETY_REVIEW_REQUIRED",
  "SCHEDULE_INSTALL_FAILED",
  "SCHEDULE_RUN_FAILED",
  "UPGRADE_FAILED",
  "VECTOR_DRAIN_FAILED",
]);

const ISSUE_CODES = new Set(SOURCE_RECEIPT_ISSUE_CODES);
export const DEFAULT_SOURCE_RECEIPT_ISSUE_CODE = "INGEST_FAILED";

/** Normalize an untrusted receipt value against the server-owned allowlist. */
export function normalizeSourceReceiptIssueCode(value) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ISSUE_CODES.has(candidate) ? candidate : DEFAULT_SOURCE_RECEIPT_ISSUE_CODE;
}

/**
 * Classify a local connector failure without returning or retaining its text.
 * The message is inspected only in memory as a compatibility path for errors
 * that do not yet expose a typed code.
 */
export function sourceReceiptIssueCode(error, fallback = DEFAULT_SOURCE_RECEIPT_ISSUE_CODE) {
  const typed = [error?.code, error?.payload?.error_code, error?.payload?.issue_code]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toUpperCase());
  const safetySignals = [error, error?.payload]
    .filter((value) => value && typeof value === "object");
  if (safetySignals.some((value) =>
    value.uncertain === true || value.outcome_unknown === true || value.retry_safe === false
  ) || typed.some((value) => [
    "OAUTH_RESPONSE_UNCERTAIN",
    "REFRESH_OUTCOME_UNKNOWN",
    "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
    "PLAID_REMOVE_OUTCOME_UNKNOWN",
    "PROVIDER_DELETION_NOT_CONFIRMED",
    "PROVIDER_REMOVAL_REVIEW_REQUIRED",
    "PROVIDER_SNAPSHOT_REMOVAL_REVIEW_REQUIRED",
  ].includes(value))) return "SAFETY_REVIEW_REQUIRED";

  const stable = typed.find((value) => ISSUE_CODES.has(value));
  if (stable) return stable;
  if (typed.some((value) => ["ACCESS_DENIED", "OWNER_CANCELED"].includes(value))) return "AUTH_DENIED";
  if (typed.includes("REFRESH_EXPIRED")) return "AUTH_EXPIRED";
  if (typed.some((value) => [
    "MISSING_REFRESH_TOKEN",
    "NOT_CONNECTED",
    "SOURCE_BINDING_MISSING",
  ].includes(value))) return "AUTH_REQUIRED";
  if (typed.some((value) => [
    "SOURCE_BINDING_CORRUPT",
    "SOURCE_BINDING_REQUIRED",
    "UNEXPECTED_COMPANY",
    "WRONG_ENVIRONMENT",
    "WRONG_REALM",
    "PROVIDER_IDENTITY_CONFLICT",
  ].includes(value))) return "SAFETY_REVIEW_REQUIRED";
  if (typed.some((value) => [
    "INVALID_PROVIDER_IDENTITY",
    "INVALID_PROVIDER_TOMBSTONE",
    "INVALID_INGEST_RECEIPT",
  ].includes(value))) return "CONFIG_INVALID";

  const message = String(error?.message || "");
  if (/PDF.*tim(?:e|ed) out/i.test(message)) return "PDF_PROCESS_TIMEOUT";
  if (/PDF.*process/i.test(message)) return "PDF_PROCESS_FAILED";
  if (/timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(message)) return "NETWORK_UNREACHABLE";
  if (/rate.?limit|\b429\b/i.test(message)) return "RATE_LIMITED";
  if (/\b401\b|expired.*(?:auth|token)|reauthori[sz]/i.test(message)) return "AUTH_EXPIRED";
  if (/\b403\b|forbidden|permission denied|not permitted/i.test(message)) return "REMOTE_PERMISSION_DENIED";
  if (/admin key|credential.*(?:missing|required)|token is not set|sign.?in|required.*auth/i.test(message)) {
    return "AUTH_REQUIRED";
  }
  if (/not found|\b404\b/i.test(message)) return "REMOTE_NOT_FOUND";
  if (/extract/i.test(message)) return "EXTRACTION_FAILED";
  return normalizeSourceReceiptIssueCode(fallback);
}

const OWNER_MESSAGES = Object.freeze({
  AUTH_DENIED: "The connection was not authorized. Your installer can help reconnect it.",
  AUTH_EXPIRED: "The connection needs to be refreshed. Your installer can help reconnect it.",
  AUTH_REQUIRED: "This source needs to be connected before it can update.",
  CONFIG_INVALID: "This source needs a setup adjustment before it can update.",
  EXTRACTION_FAILED: "Some source material could not be prepared. Your installer can help review it and try again.",
  FORMAT_UNSUPPORTED: "Some source material uses a format that is not supported yet.",
  INDEX_WRITE_FAILED: "The latest update reached the brain but could not finish indexing. Your installer can safely retry it.",
  INGEST_FAILED: "The latest update did not finish. Your installer can safely retry it.",
  INPUT_REFUSED: "Some source material was held for review before it could be added.",
  NETWORK_UNREACHABLE: "The source could not be reached. It is safe to try again when the connection is available.",
  PDF_PROCESS_FAILED: "A PDF could not be prepared. Your installer can help review it and try again.",
  PDF_PROCESS_TIMEOUT: "A PDF took too long to prepare. Your installer can safely retry it.",
  RATE_LIMITED: "The source asked the brain to wait. It is safe to try again later.",
  REMOTE_NOT_FOUND: "The connected source could not be found. Your installer can help review the connection.",
  REMOTE_PERMISSION_DENIED: "The source did not allow this update. Your installer can help review its access.",
  REMOTE_UNAVAILABLE: "The source is temporarily unavailable. It is safe to try again later.",
  SAFETY_REVIEW_REQUIRED: "The latest update paused for a safety review. Your installer can help confirm the next step.",
  VECTOR_DRAIN_FAILED: "The latest update is stored, but search indexing still needs attention from your installer.",
});

/** Render only reviewed owner-facing copy, never a caller-supplied reason. */
export function sourceReceiptOwnerMessage(issueCode) {
  const code = normalizeSourceReceiptIssueCode(issueCode);
  return OWNER_MESSAGES[code] || OWNER_MESSAGES[DEFAULT_SOURCE_RECEIPT_ISSUE_CODE];
}
