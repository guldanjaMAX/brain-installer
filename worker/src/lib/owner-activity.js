/**
 * Small shared SQL builder for the human-readable owner activity stream.
 *
 * Low-level security telemetry stays in its dedicated audit tables. Callers
 * pass only bounded labels and opaque local ids that are safe to show to the
 * owner. Stable event ids make response-loss retries exactly-once.
 */

const TENANT_ID = "primary";

export function ownerActivityStatement(env, {
  eventId,
  eventType,
  entitySlug = null,
  subjectKind,
  subjectId,
  displayLabel,
  occurredAt,
  requestId = null,
}) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO owner_activity_events
       (event_id, tenant_id, request_id, event_type, entity_slug,
        subject_kind, subject_id, display_label, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    String(eventId).slice(0, 180),
    TENANT_ID,
    requestId === null ? null : String(requestId).slice(0, 128),
    String(eventType).slice(0, 80),
    entitySlug === null ? null : String(entitySlug).slice(0, 64),
    String(subjectKind).slice(0, 80),
    String(subjectId).slice(0, 180),
    String(displayLabel).slice(0, 160),
    occurredAt || new Date().toISOString(),
  );
}
