import type {
  SupportAccessReceipt, SupportAccessSession, SupportAccessStatus,
  SupportDurationMinutes, SupportMe, SupportPrincipal, SupportSystemStatus,
  SupportWorkspace,
} from "./api";

export const SUPPORT_DURATION_CHOICES: readonly SupportDurationMinutes[] = [15, 30, 60, 120];
export const DEFAULT_SUPPORT_DURATION: SupportDurationMinutes = 30;

export const SUPPORT_WORKSPACE: SupportWorkspace = {
  support: true,
  home: false,
  documents: false,
  ask: false,
  add_review: false,
  access: false,
  bank: false,
  targets: false,
  preferences: false,
  connections: false,
};

export const SUPPORT_SHARED = [
  "Product and database versions",
  "Aggregate document, chunk, and vector counts",
  "Generic connection types and last-refresh age",
  "Reviewed issue codes and severity counts",
] as const;

export const SUPPORT_NOT_SHARED = [
  "Documents, email, messages, filenames, or titles",
  "Searches, questions, answers, snippets, or financial values",
  "Account names, source identities, paths, links, or raw errors",
  "Passwords, credentials, tokens, passkeys, or device details",
] as const;

const SUPPORT_UNAVAILABLE = new Set(["health", "diagnose", "freshness", "vectors", "install_state"]);
const SUPPORT_PROBLEM_CODES = new Set([
  "empty_corpus", "undated_documents", "source_registration_issue", "empty_source",
  "index_consistency_issue", "vector_backlog", "vector_failures", "orphan_chunks",
  "blank_chunks", "duplicate_documents", "chunk_outliers", "oversized_chunks",
  "duplicate_chunks", "diagnostic_issue",
]);
const SUPPORT_PROBLEM_AREAS = new Set(["meta", "coverage", "integrity", "efficiency", "diagnostics"]);
const SUPPORT_SOURCE_KINDS = new Set(["upload", "drive", "message", "email", "calendar", "other"]);
const SUPPORT_SOURCE_LABELS = new Set([
  "Files you uploaded", "Google Drive", "Messages", "Email", "Calendar",
  "Meeting recordings", "Another source",
]);
const SUPPORT_SOURCE_STATES = new Set(["ok", "never_synced", "stale", "broken", "indexing", "unknown"]);

export function supportWorkspaceConfirmed(workspace: SupportWorkspace | undefined): boolean {
  if (!workspace) return false;
  return exactKeys(workspace, Object.keys(SUPPORT_WORKSPACE))
    && (Object.keys(SUPPORT_WORKSPACE) as Array<keyof SupportWorkspace>)
    .every((key) => workspace[key] === SUPPORT_WORKSPACE[key]);
}

export function supportMeConfirmed(body: SupportMe): boolean {
  const principal = body?.principal;
  return exactKeys(body, ["signed_in", "principal", "workspace", "can_fix", "repair_mode"])
    && body?.signed_in === true
    && supportPrincipalConfirmed(principal)
    && supportWorkspaceConfirmed(body.workspace)
    && body.can_fix === false
    && body.repair_mode === "owner_approval_required_future";
}

export function supportPrincipalConfirmed(principal: SupportPrincipal | undefined): boolean {
  return exactKeys(principal, ["kind", "support_session_id", "technician_label", "technician_identity_verified", "expires_at", "idle_expires_at", "read_only"])
    && principal?.kind === "support"
    && typeof principal.support_session_id === "string"
    && /^ss_[A-Za-z0-9_-]+$/.test(principal.support_session_id)
    && typeof principal.technician_label === "string"
    && principal.technician_label.length > 0
    && principal.technician_label.length <= 80
    && principal.technician_identity_verified === false
    && finiteFutureTime(principal.expires_at)
    && finiteFutureTime(principal.idle_expires_at)
    && principal.idle_expires_at <= principal.expires_at
    && principal.read_only === true;
}

export function supportStatusConfirmed(body: SupportAccessStatus): boolean {
  return body?.status === "ready"
    && Array.isArray(body.sessions)
    && body.sessions.every(supportSessionConfirmed)
    && body.policy?.access === "read_only_diagnostics"
    && sameNumbers(body.policy.duration_choices_minutes, SUPPORT_DURATION_CHOICES)
    && body.policy.default_duration_minutes === DEFAULT_SUPPORT_DURATION
    && body.policy.max_duration_minutes === 120
    && body.policy.enrollment_link_max_minutes === 10
    && body.policy.can_fix === false
    && body.policy.repair_mode === "owner_approval_required_future";
}

export function supportSessionConfirmed(session: SupportAccessSession): boolean {
  if (!session || typeof session.support_session_id !== "string" || !/^ss_[A-Za-z0-9_-]+$/.test(session.support_session_id)
    || typeof session.technician_label !== "string" || !session.technician_label || session.technician_label.length > 80
    || !finiteTime(session.created_at)) return false;
  if (session.state === "pending") {
    return session.authentication_state === null
      && session.activated_at === null && session.expires_at === null
      && session.idle_expires_at === null && session.last_used_at === null
      && session.revoked_at === null
      && (session.invite_state === "active" || session.invite_state === "expired" || session.invite_state === "consumed")
      && finiteTime(session.enrollment_expires_at)
      && (session.invite_state !== "active" || session.enrollment_expires_at > Date.now());
  }
  if (session.state === "active") {
    return finiteTime(session.activated_at) && finiteFutureTime(session.expires_at)
      && finiteTime(session.idle_expires_at)
      && session.idle_expires_at <= session.expires_at && session.revoked_at === null
      && ((session.authentication_state === "authenticated" && session.idle_expires_at > Date.now())
        || (session.authentication_state === "reauthentication_required" && session.idle_expires_at <= Date.now()));
  }
  if (session.state === "revoked") {
    return session.authentication_state === null && finiteTime(session.revoked_at);
  }
  return session.state === "expired" && session.authentication_state === null && finiteTime(session.expires_at);
}

export function supportCreateReceiptConfirmed(
  receipt: SupportAccessReceipt,
  requestId: string,
  technicianLabel: string,
): boolean {
  return receipt?.status === "pending"
    && receipt.request_id === requestId
    && receipt.technician_label === technicianLabel
    && typeof receipt.support_session_id === "string"
    && Boolean(receipt.support_session_id)
    && receipt.activated_at == null
    && receipt.expires_at == null
    && receipt.idle_expires_at == null
    && receipt.invite_state === "active"
    && supportEnrollmentUrlConfirmed(receipt.enrollment_url)
    && finiteFutureTime(receipt.enrollment_expires_at)
    && typeof receipt.changed === "boolean"
    && typeof receipt.replayed === "boolean";
}

export function supportRevokeReceiptConfirmed(
  receipt: SupportAccessReceipt,
  requestId: string,
  sessionId: string,
): boolean {
  return receipt?.status === "revoked"
    && receipt.request_id === requestId
    && receipt.support_session_id === sessionId
    && finiteTime(receipt.revoked_at)
    && typeof receipt.changed === "boolean"
    && typeof receipt.replayed === "boolean";
}

export function supportSystemConfirmed(body: SupportSystemStatus, principal: SupportPrincipal): boolean {
  return (body?.status === "ready" || body?.status === "partial")
    && exactKeys(body, ["status", "observed_at", "unavailable", "access", "privacy", "brain", "corpus", "vectors", "problem_counts", "problems", "sources"])
    && finiteTime(body.observed_at)
    && Array.isArray(body.unavailable) && body.unavailable.every((item) => SUPPORT_UNAVAILABLE.has(item))
    && exactKeys(body.access, ["kind", "technician_label", "expires_at", "remaining_seconds", "read_only", "can_fix"])
    && body.access?.kind === "support"
    && body.access.technician_label === principal.technician_label
    && body.access.expires_at === principal.expires_at
    && Number.isInteger(body.access.remaining_seconds)
    && body.access.remaining_seconds >= 0
    && body.access.read_only === true
    && body.access.can_fix === false
    && exactKeys(body.privacy, ["mode", "content_visible", "search_available", "raw_errors_visible", "credentials_visible", "account_identifiers_visible"])
    && body.privacy?.mode === "aggregate_only"
    && body.privacy.content_visible === false
    && body.privacy.search_available === false
    && body.privacy.raw_errors_visible === false
    && body.privacy.credentials_visible === false
    && body.privacy.account_identifiers_visible === false
    && exactKeys(body.brain, ["product_version", "schema_version", "status", "accepting_documents", "drain_mode"])
    && typeof body.brain?.product_version === "string" && body.brain.product_version.length > 0 && body.brain.product_version.length <= 40
    && Number.isInteger(body.brain?.schema_version) && body.brain.schema_version >= 1
    && (body.brain.status === null || body.brain.status === "ok" || body.brain.status === "paused-for-upgrade")
    && (body.brain.accepting_documents === null || typeof body.brain.accepting_documents === "boolean")
    && (body.brain.drain_mode === null || body.brain.drain_mode === "active" || body.brain.drain_mode === "paused-for-upgrade")
    && (!body.corpus || (exactKeys(body.corpus, ["documents", "chunks"])
      && nonnegativeInteger(body.corpus.documents) && nonnegativeInteger(body.corpus.chunks)))
    && (!body.vectors || (exactKeys(body.vectors, ["ready", "expected", "visible", "pending", "percent_visible"])
      && typeof body.vectors.ready === "boolean"
      && nonnegativeInteger(body.vectors.expected) && nonnegativeInteger(body.vectors.visible)
      && nonnegativeInteger(body.vectors.pending)
      && (body.vectors.percent_visible === null || (typeof body.vectors.percent_visible === "number" && Number.isFinite(body.vectors.percent_visible)))))
    && (!body.problem_counts || (exactKeys(body.problem_counts, ["crit", "warn", "info"])
      && nonnegativeInteger(body.problem_counts.crit) && nonnegativeInteger(body.problem_counts.warn)
      && nonnegativeInteger(body.problem_counts.info)))
    && (!body.problems || (Array.isArray(body.problems) && body.problems.every((problem) =>
      exactKeys(problem, ["code", "area", "severity", "count", "repairability"])
      && SUPPORT_PROBLEM_CODES.has(problem.code) && SUPPORT_PROBLEM_AREAS.has(problem.area)
      && (problem.severity === "crit" || problem.severity === "warn")
      && nonnegativeInteger(problem.count) && problem.repairability === "guidance_only")))
    && (!body.sources || (Array.isArray(body.sources) && body.sources.every((source) =>
      exactKeys(source, ["kind", "label", "state", "documents", "days_since_ingest", "automatable"])
      && SUPPORT_SOURCE_KINDS.has(source.kind) && SUPPORT_SOURCE_LABELS.has(source.label) && SUPPORT_SOURCE_STATES.has(source.state)
      && nonnegativeInteger(source.documents)
      && (source.days_since_ingest === null || nonnegativeInteger(source.days_since_ingest))
      && typeof source.automatable === "boolean")));
}

export function supportDurationLabel(minutes: SupportDurationMinutes): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return "1 hour";
  return "2 hours";
}

export function supportSessionStateLabel(state: SupportAccessSession["state"]): string {
  return state === "pending" ? "Not opened"
    : state === "active" ? "Active"
      : state === "expired" ? "Expired"
        : "Revoked";
}

function finiteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteFutureTime(value: unknown): value is number {
  return finiteTime(value) && value > Date.now();
}

function sameNumbers(actual: readonly number[] | undefined, expected: readonly number[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function supportEnrollmentUrlConfirmed(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    if (!/^#support-enroll=[A-Za-z0-9_-]+$/.test(parsed.hash)) return false;
    if (typeof location !== "undefined" && parsed.origin !== location.origin) return false;
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname));
  } catch {
    return false;
  }
}

function exactKeys(value: unknown, allowed: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
