import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, api, ownerError, type FinStatement, type OwnerPeriodClose as PeriodClose,
  type OwnerPeriodCloseResponse, type OwnerWriteReceipt,
} from "../lib/api";
import { dateLabel } from "../lib/finance";
import { confirmedOwnerWrite, periodClosePresentation } from "../lib/owner";
import { Attention, Badge, Chip, Note, Row } from "./ui";
import { useActionRequests } from "./useActionRequests";

export function OwnerPeriodClose({ scope, statements }: {
  scope: string | null;
  statements: FinStatement[];
}) {
  const latest = useMemo(() => [...statements].sort((a, b) => b.period_end.localeCompare(a.period_end))[0], [statements]);
  const [periodStart, setPeriodStart] = useState(latest?.period_start || "");
  const [periodEnd, setPeriodEnd] = useState(latest?.period_end || "");
  const [note, setNote] = useState("");
  const [closes, setCloses] = useState<PeriodClose[] | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [needsAcknowledgement, setNeedsAcknowledgement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requests = useActionRequests("period_close");

  useEffect(() => {
    if (!periodStart && latest) setPeriodStart(latest.period_start);
    if (!periodEnd && latest) setPeriodEnd(latest.period_end);
  }, [latest, periodEnd, periodStart]);

  const load = useCallback(async () => {
    if (!scope) {
      setCloses(null);
      return;
    }
    setError(null);
    try {
      const body = await api<OwnerPeriodCloseResponse>("/api/owner/period-closes/read", { entity_slug: scope });
      if (body.entity_scope?.entity_slug !== scope || !Array.isArray(body.period_closes)) throw new Error("Period-close history is unavailable.");
      setCloses(body.period_closes);
    } catch (next) {
      setCloses(null);
      setError(ownerError(next).message);
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  const current = closes?.find((item) => item.period_start === periodStart && item.period_end === periodEnd) || null;

  async function write(mode: "accept" | "reopen") {
    if (!scope || !periodStart || !periodEnd || busy) return;
    if (periodEnd < periodStart) return setError("The close end date must be on or after its start date.");
    const body = {
      entity_slug: scope,
      period_start: periodStart,
      period_end: periodEnd,
      ...(mode === "accept" ? { acknowledge_incomplete: acknowledge } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const actionKey = `${mode}:${JSON.stringify(body)}`;
    const id = requests.forAction(actionKey);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const receipt = await api<OwnerWriteReceipt>(`/api/owner/period-closes/${mode}`, { request_id: id, ...body });
      if (!receipt.period_close || !confirmedOwnerWrite(receipt, id, scope)) {
        throw new Error("The period change was not confirmed by a close and activity receipt.");
      }
      requests.confirmed(actionKey);
      setNeedsAcknowledgement(false);
      setAcknowledge(false);
      setNote("");
      setMessage(receipt.replayed
        ? "The brain confirmed this exact close action was already recorded."
        : mode === "accept" ? "Period accepted and added to the change history." : "Period reopened and added to the change history.");
      await load();
    } catch (next) {
      if (next instanceof ApiError && next.status === 409 && next.body.code === "incomplete_evidence") {
        setNeedsAcknowledgement(true);
        setError("The close evidence is incomplete. Review the gaps above, then explicitly acknowledge them if you still want to accept this period.");
      } else {
        setError(ownerError(next).message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!scope) return <Note>Select one business above before reading or recording a period close.</Note>;

  return (
    <div className="border-t border-line">
      <div className="p-4 grid gap-3 sm:grid-cols-2">
        <label className="text-[12.5px] text-ink-soft">Period starts
          <input type="date" value={periodStart} onChange={(event) => { setPeriodStart(event.target.value); setNeedsAcknowledgement(false); }} className="field mt-1" />
        </label>
        <label className="text-[12.5px] text-ink-soft">Period ends
          <input type="date" value={periodEnd} onChange={(event) => { setPeriodEnd(event.target.value); setNeedsAcknowledgement(false); }} className="field mt-1" />
        </label>
      </div>
      {closes === null && !error && <Note>Reading saved period-close history.</Note>}
      {current && (
        <Row>
          <span className="min-w-0">
            <span className="text-[14px] font-medium">
              {dateLabel(current.period_start) || current.period_start} through {dateLabel(current.period_end) || current.period_end}
            </span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">
              {periodClosePresentation(current).accepted ? "Owner accepted" : "Reopened"}
              {periodClosePresentation(current).incompleteEvidence && " · accepted with incomplete evidence"}
            </span>
          </span>
          <span className="flex gap-2 items-center">
            {periodClosePresentation(current).incompleteEvidence && <Badge tone="warn">Incomplete evidence acknowledged</Badge>}
            <Chip state={periodClosePresentation(current).accepted ? "FILED" : "NEEDS"} />
          </span>
        </Row>
      )}
      {!current && closes && periodStart && periodEnd && <Note>No owner close is recorded for this exact period.</Note>}
      <div className="p-4 border-t border-line">
        <label className="block text-[12.5px] text-ink-soft">Owner note, optional
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="field mt-1 resize-y" />
        </label>
        {needsAcknowledgement && (
          <label className="mt-3 flex gap-2 items-start text-[13px] text-ink-soft">
            <input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} className="mt-0.5" />
            I understand the close evidence is incomplete and still want to accept this period.
          </label>
        )}
        {error && <div className="mt-3"><Attention>{error}</Attention></div>}
        {message && <p className="mt-3 text-[13px] text-ink-soft">{message}</p>}
        <div className="mt-3 flex gap-2 flex-wrap">
          {current?.status === "accepted" ? (
            <button onClick={() => write("reopen")} disabled={busy} className="rounded-lg border border-line px-3.5 py-2 text-[13.5px] text-ink disabled:opacity-50">{busy ? "Saving" : "Reopen period"}</button>
          ) : (
            <button onClick={() => write("accept")} disabled={busy || !periodStart || !periodEnd || (needsAcknowledgement && !acknowledge)} className="rounded-lg bg-accent text-white px-3.5 py-2 text-[13.5px] disabled:opacity-50">{busy ? "Saving" : needsAcknowledgement ? "Accept with incomplete evidence" : "Accept period"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
