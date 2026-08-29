import { useEffect, useState } from "react";
import { api, type OwnerActivityEvent, type OwnerActivityResponse, type OwnerPreferencesResponse } from "../lib/api";
import { activityEventsInWindow, activitySentence } from "../lib/owner";
import { dateLabel, entityLabel } from "../lib/finance";
import { Attention, Note, Row, Section } from "./ui";
import { useFinanceScope } from "./FinanceScope";

export function OwnerActivity() {
  const { scope, entities, activeLabel } = useFinanceScope();
  const [events, setEvents] = useState<OwnerActivityEvent[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [windowDays, setWindowDays] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setEvents(null);
    setUnavailable(false);
    Promise.all([
      api<OwnerActivityResponse>("/api/owner/activity", {
        ...(scope ? { entity_slug: scope } : {}),
        limit: 100,
      }),
      api<OwnerPreferencesResponse>("/api/owner/preferences/read", {}).catch(() => null),
    ]).then(([body, preferences]) => {
      if (!current) return;
      if (!Array.isArray(body.activity_events)) {
        setUnavailable(true);
        return;
      }
      const savedWindow = preferences?.preferences?.find((item) => item.preference_key === "activity_window_days" && !item.entity_slug);
      const days = Number(savedWindow?.value);
      const activeDays = Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
      setWindowDays(activeDays);
      setEvents(activityEventsInWindow(body.activity_events, activeDays));
      setTruncated(Boolean(body.truncated));
    }).catch(() => {
      if (current) setUnavailable(true);
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [scope]);

  return (
    <Section title="What changed" blurb={`Durable owner actions and decisions for ${activeLabel}${windowDays ? ` from the last ${windowDays} days` : ""}, newest first.`}>
      {busy && <Note>Reading the saved change history.</Note>}
      {!busy && unavailable && (
        <Attention>The saved change history is unavailable. That is not the same as nothing changing.</Attention>
      )}
      {!busy && events?.length === 0 && (
        <Note>No owner action has been recorded for this scope yet.</Note>
      )}
      {!busy && events?.map((event) => (
        <Row key={event.event_id}>
          <span className="min-w-0">
            <span className="text-[14px] font-medium">{activitySentence(event)}</span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">
              {event.entity_slug ? entityLabel(entities, event.entity_slug) : "All finances"}
              {` · ${dateLabel(event.occurred_at) || "time recorded"}`}
            </span>
          </span>
        </Row>
      ))}
      {!busy && truncated && <Note>More saved history exists beyond this first page.</Note>}
    </Section>
  );
}
