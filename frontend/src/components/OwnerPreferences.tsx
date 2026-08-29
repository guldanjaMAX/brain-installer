import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, ownerError, type OwnerPreference, type OwnerPreferencesResponse, type OwnerWriteReceipt,
} from "../lib/api";
import { Attention, Note, Section } from "./ui";
import { useFinanceScope } from "./FinanceScope";
import { useActionRequests } from "./useActionRequests";
import { confirmedOwnerWrite } from "../lib/owner";

export function OwnerPreferences() {
  const { entities } = useFinanceScope();
  const owned = useMemo(() => entities.filter((entity) => !entity.counterparty && entity.status === "active"), [entities]);
  const [preferences, setPreferences] = useState<OwnerPreference[] | null>(null);
  const [activityDays, setActivityDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requests = useActionRequests("preference");

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await api<OwnerPreferencesResponse>("/api/owner/preferences/read", {});
      if (!Array.isArray(body.preferences)) throw new Error("Preferences are unavailable.");
      setPreferences(body.preferences);
      const windowDays = body.preferences.find((item) => item.preference_key === "activity_window_days" && !item.entity_slug);
      if (windowDays) setActivityDays(String(windowDays.value));
    } catch (next) {
      setPreferences(null);
      setError(ownerError(next).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setPreference(preferenceKey: "default_entity" | "activity_window_days", value: string | number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const actionKey = `${preferenceKey}:${String(value)}`;
    const id = requests.forAction(actionKey);
    try {
      const receipt = await api<OwnerWriteReceipt>("/api/owner/preferences/set", {
        request_id: id, preference_key: preferenceKey, value,
      });
      if (!receipt.preference || !confirmedOwnerWrite(receipt, id, null)) throw new Error("The preference was not confirmed by a saved preference and activity receipt.");
      requests.confirmed(actionKey);
      setMessage(receipt.replayed
        ? "This exact preference request was already processed."
        : receipt.changed ? "Preference saved and added to the change history." : "The preference already matched. No new change-history event was added.");
      await load();
    } catch (next) {
      setError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  const defaultEntity = String(preferences?.find((item) => item.preference_key === "default_entity" && !item.entity_slug)?.value || "");
  return (
    <Section title="Owner preferences" blurb="Choose the business this workspace opens on and how many days of saved owner activity Home shows.">
      {error && <Attention>{error}</Attention>}
      {message && <Note>{message}</Note>}
      {!preferences && !error && <Note>Reading owner preferences.</Note>}
      <div className="p-4 grid gap-4 sm:grid-cols-2">
        <label className="text-[12.5px] text-ink-soft">Open on this business
          <select
            className="field mt-1"
            value={defaultEntity}
            onChange={(event) => event.target.value && setPreference("default_entity", event.target.value)}
            disabled={busy || owned.length === 0}
          >
            <option value="">No saved default</option>
            {owned.map((item) => <option key={item.entity_slug} value={item.entity_slug}>{item.label}</option>)}
          </select>
        </label>
        <label className="text-[12.5px] text-ink-soft">Show owner activity from the last
          <span className="flex gap-2 mt-1">
            <input className="field" type="number" min="1" max="365" value={activityDays} onChange={(event) => setActivityDays(event.target.value)} />
            <span className="self-center text-[13px] text-ink-soft">days</span>
            <button
              className="rounded-lg bg-accent text-white px-3 text-[13px] disabled:opacity-50"
              disabled={busy || Number(activityDays) < 1 || Number(activityDays) > 365 || !Number.isInteger(Number(activityDays))}
              onClick={() => setPreference("activity_window_days", Number(activityDays))}
            >Save</button>
          </span>
        </label>
      </div>
      <Note>Display-currency conversion and fiscal-year grouping are not offered here because this frontend does not apply them yet.</Note>
    </Section>
  );
}
