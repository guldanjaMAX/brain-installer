/**
 * The common source-level ingestion outcome contract.
 *
 * These flags are intentionally redundant. Callers should not have to infer
 * completion from a count, an empty error string, or a provider-specific
 * status. In particular, `accepted` means some durable work landed; only
 * `completed` is success-shaped.
 */
export const INGESTION_OUTCOME_KINDS = Object.freeze([
  "completed",
  "partial",
  "unavailable",
  "retryable",
  "refused",
]);

const SHAPES = Object.freeze({
  completed: Object.freeze({ ok: true, accepted: true, complete: true, available: true, retryable: false, refused: false }),
  partial: Object.freeze({ ok: false, accepted: true, complete: false, available: true, retryable: false, refused: false }),
  unavailable: Object.freeze({ ok: false, accepted: false, complete: false, available: false, retryable: false, refused: false }),
  retryable: Object.freeze({ ok: false, accepted: false, complete: false, available: true, retryable: true, refused: false }),
  refused: Object.freeze({ ok: false, accepted: false, complete: false, available: true, retryable: false, refused: true }),
});

export function ingestionOutcome(kind, { reason = null } = {}) {
  const normalized = String(kind || "").trim().toLowerCase();
  const shape = SHAPES[normalized];
  if (!shape) {
    throw new TypeError(`unknown ingestion outcome ${normalized || "(empty)"}`);
  }
  const detail = reason === null || reason === undefined ? null : String(reason).trim() || null;
  return Object.freeze({ kind: normalized, ...shape, reason: detail });
}

export function assertIngestionOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ingestion outcome must be an object");
  }
  const expected = ingestionOutcome(value.kind, { reason: value.reason });
  for (const field of ["ok", "accepted", "complete", "available", "retryable", "refused"]) {
    if (value[field] !== expected[field]) {
      throw new TypeError(`ingestion outcome ${expected.kind} has an invalid ${field} flag`);
    }
  }
  return value;
}
