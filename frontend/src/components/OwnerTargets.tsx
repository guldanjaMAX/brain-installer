import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, ownerError, requestId, type OwnerTarget, type OwnerTargetsResponse, type OwnerWriteReceipt,
} from "../lib/api";
import { majorToMinor, validCurrency } from "../lib/owner";
import { confirmedOwnerWrite } from "../lib/owner";
import { dateLabel, moneyLabel } from "../lib/finance";
import { Attention, Badge, Confirm, Note, Row, Section } from "./ui";
import { useFinanceScope } from "./FinanceScope";
import { useActionRequests } from "./useActionRequests";

type Draft = {
  label: string;
  metric: OwnerTarget["metric"];
  amount: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  note: string;
};

const EMPTY: Draft = {
  label: "", metric: "revenue", amount: "", currency: "USD",
  periodStart: "", periodEnd: "", note: "",
};

export function OwnerTargets() {
  const { scope, activeLabel } = useFinanceScope();
  const [targets, setTargets] = useState<OwnerTarget[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useActionRequests("target");
  const newTargetId = useRef(requestId("goal"));

  const load = useCallback(async () => {
    if (!scope) {
      setTargets(null);
      return;
    }
    setError(null);
    try {
      const body = await api<OwnerTargetsResponse>("/api/owner/targets/read", { entity_slug: scope });
      if (!Array.isArray(body.targets)) throw new Error("Targets are unavailable.");
      setTargets(body.targets);
    } catch (next) {
      setTargets(null);
      setError(ownerError(next).message);
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  function edit(target: OwnerTarget) {
    setEditing(target.target_id);
    setDraft({
      label: target.label,
      metric: target.metric,
      amount: (target.target_minor / 100).toFixed(2),
      currency: target.currency,
      periodStart: target.period_start || "",
      periodEnd: target.period_end || "",
      note: target.note || "",
    });
    setMessage(null);
    setError(null);
  }

  async function save() {
    if (!scope || busy) return;
    const amount = majorToMinor(draft.amount);
    if (!draft.label.trim()) return setError("Name this target before saving it.");
    if (amount === null) return setError("Enter an amount with no more than two decimal places.");
    if (!validCurrency(draft.currency)) return setError("Currency must be a three-letter code such as USD.");
    if (draft.periodStart && draft.periodEnd && draft.periodEnd < draft.periodStart) {
      return setError("The target end date must be on or after its start date.");
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    const targetId = editing || newTargetId.current;
    const body = {
      entity_slug: scope,
      target_id: targetId,
      label: draft.label.trim(),
      metric: draft.metric,
      target_minor: amount,
      currency: draft.currency.trim().toUpperCase(),
      ...(draft.periodStart ? { period_start: draft.periodStart } : {}),
      ...(draft.periodEnd ? { period_end: draft.periodEnd } : {}),
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    };
    const actionKey = JSON.stringify(body);
    const id = requests.forAction(actionKey);
    try {
      const receipt = await api<OwnerWriteReceipt>("/api/owner/targets/upsert", {
        request_id: id,
        ...body,
      });
      if (!receipt.target || !confirmedOwnerWrite(receipt, id, scope)) throw new Error("The target was not confirmed by a saved target and activity receipt.");
      requests.confirmed(actionKey);
      if (!editing) newTargetId.current = requestId("goal");
      setDraft(EMPTY);
      setEditing(null);
      setMessage(receipt.replayed
        ? "This exact target change was already saved."
        : receipt.changed ? "Target saved and added to the change history." : "The saved target already matched. No new change-history event was added.");
      await load();
    } catch (next) {
      setError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  async function archive(target: OwnerTarget) {
    if (!scope || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const actionKey = `archive:${scope}:${target.target_id}`;
    const id = requests.forAction(actionKey);
    try {
      const receipt = await api<OwnerWriteReceipt>("/api/owner/targets/archive", {
        request_id: id, entity_slug: scope, target_id: target.target_id,
      });
      if (!receipt.target || !confirmedOwnerWrite(receipt, id, scope)) throw new Error("The archive was not confirmed by a saved target and activity receipt.");
      requests.confirmed(actionKey);
      setMessage(receipt.replayed
        ? "This target archive request was already processed."
        : receipt.changed ? "Target archived. Its history was kept." : "This target was already archived. No new change-history event was added.");
      await load();
    } catch (next) {
      setError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  if (!scope) {
    return (
      <Section title="Your targets" blurb="Targets belong to one business and never blend figures across entities.">
        <Note>Select one business above to see or set its targets.</Note>
      </Section>
    );
  }

  const active = targets?.filter((target) => !target.archived_at) || [];
  return (
    <Section title="Your targets" blurb={`Owner-set goals for ${activeLabel}. These are preferences, not facts extracted from evidence.`}>
      {error && <Attention>{error}</Attention>}
      {message && <Note>{message}</Note>}
      {targets === null && !error && <Note>Reading saved targets.</Note>}
      {targets && active.length === 0 && <Note>No active target is saved for {activeLabel}.</Note>}
      {active.map((target) => (
        <Row key={target.target_id}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 flex-wrap">
              <span className="text-[14.5px] font-medium">{target.label}</span>
              <Badge tone="muted">Owner target</Badge>
            </span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {moneyLabel(target.target_minor, target.currency) || "Amount unavailable"}
              {target.period_start && ` · from ${dateLabel(target.period_start) || "an unreadable date"}`}
              {target.period_end && ` through ${dateLabel(target.period_end) || "an unreadable date"}`}
            </span>
            {target.note && <span className="block text-[12.5px] text-ink-soft mt-1">{target.note}</span>}
          </span>
          <span className="flex items-center gap-1">
            <button onClick={() => edit(target)} disabled={busy} className="text-[13px] text-accent px-2 py-1 disabled:opacity-50">Edit</button>
            <Confirm label="Archive" question="Archive this target?" disabled={busy} onConfirm={() => archive(target)} />
          </span>
        </Row>
      ))}
      <div className="p-4 border-t border-line first:border-t-0">
        <h3 className="text-[14px] font-medium">{editing ? "Edit target" : "Add a target"}</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-[12.5px] text-ink-soft">Name
            <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} className="field mt-1" placeholder="Monthly revenue" />
          </label>
          <label className="text-[12.5px] text-ink-soft">Measure
            <select value={draft.metric} onChange={(event) => setDraft({ ...draft, metric: event.target.value as Draft["metric"] })} className="field mt-1">
              <option value="revenue">Revenue</option><option value="cash_reserve">Cash reserve</option><option value="spending_limit">Spending limit</option><option value="debt_reduction">Debt reduction</option><option value="other">Other</option>
            </select>
          </label>
          <label className="text-[12.5px] text-ink-soft">Amount
            <input value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} inputMode="decimal" className="field mt-1" placeholder="26300.00" />
          </label>
          <label className="text-[12.5px] text-ink-soft">Currency
            <input value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })} maxLength={3} className="field mt-1 uppercase" />
          </label>
          <label className="text-[12.5px] text-ink-soft">Starts
            <input type="date" value={draft.periodStart} onChange={(event) => setDraft({ ...draft, periodStart: event.target.value })} className="field mt-1" />
          </label>
          <label className="text-[12.5px] text-ink-soft">Ends
            <input type="date" value={draft.periodEnd} onChange={(event) => setDraft({ ...draft, periodEnd: event.target.value })} className="field mt-1" />
          </label>
        </div>
        <label className="block text-[12.5px] text-ink-soft mt-3">Note
          <textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} rows={2} className="field mt-1 resize-y" />
        </label>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={save} disabled={busy} className="rounded-lg bg-accent text-white px-4 py-2 text-[13.5px] font-medium disabled:opacity-50">{busy ? "Saving" : "Save target"}</button>
          {editing && <button onClick={() => { setEditing(null); setDraft(EMPTY); }} className="text-[13px] text-ink-soft px-3 py-2">Cancel</button>}
        </div>
      </div>
    </Section>
  );
}
