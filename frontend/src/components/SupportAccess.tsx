import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, ownerError, type SupportAccessReceipt, type SupportAccessSession,
  type SupportAccessStatus, type SupportDurationMinutes,
} from "../lib/api";
import {
  DEFAULT_SUPPORT_DURATION, SUPPORT_DURATION_CHOICES, SUPPORT_NOT_SHARED, SUPPORT_SHARED,
  supportCreateReceiptConfirmed, supportDurationLabel, supportRevokeReceiptConfirmed,
  supportSessionStateLabel, supportStatusConfirmed,
} from "../lib/support";
import { Attention, Badge, Confirm, Empty, Note, Row, Section, TruthNote, ago } from "./ui";
import { useActionRequests } from "./useActionRequests";

export function SupportAccess() {
  const [status, setStatus] = useState<SupportAccessStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [technicianLabel, setTechnicianLabel] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<SupportDurationMinutes>(DEFAULT_SUPPORT_DURATION);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [invite, setInvite] = useState<SupportAccessReceipt | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requests = useActionRequests("support_access");
  const normalizedLabel = technicianLabel.trim();
  const sessions = useMemo(() => status?.sessions || [], [status]);

  const load = useCallback(async () => {
    setStatusError(null);
    try {
      const next = await api<SupportAccessStatus>("/api/app/support-access/status", {});
      if (!supportStatusConfirmed(next)) {
        throw new Error("Support access did not return the enforced read-only policy.");
      }
      setStatus(next);
    } catch (next) {
      setStatus(null);
      setStatusError(ownerError(next).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!invite?.enrollment_expires_at && !sessions.some((session) => session.state === "active")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [invite?.enrollment_expires_at, sessions]);

  const inviteUsable = invite?.status === "pending"
    && invite.invite_state === "active"
    && Boolean(invite.enrollment_url)
    && Number(invite.enrollment_expires_at) > now;

  async function create() {
    if (!normalizedLabel || busy) return;
    const actionKey = `create:${normalizedLabel}:${durationMinutes}`;
    const requestId = requests.forAction(actionKey);
    setBusy(true);
    setActionError(null);
    setMessage(null);
    setInvite(null);
    try {
      const receipt = await api<SupportAccessReceipt>("/api/app/support-access/create", {
        request_id: requestId,
        technician_label: normalizedLabel,
        duration_minutes: durationMinutes,
      });
      if (!supportCreateReceiptConfirmed(receipt, requestId, normalizedLabel)) {
        throw new Error("The brain did not return a confirmed pending support invitation. No link is being presented.");
      }
      requests.confirmed(actionKey);
      setInvite(receipt);
      setNow(Date.now());
      setMessage(receipt.replayed
        ? "The same pending invitation receipt was returned. No additional support access was created."
        : "A read-only support invitation was created. Its access timer starts only after the invited technician completes passkey enrollment.");
      await load();
    } catch (next) {
      setActionError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  async function reissue(session: SupportAccessSession) {
    if (busy) return;
    const actionKey = `reissue:${session.support_session_id}`;
    const requestId = requests.forAction(actionKey);
    setBusy(true);
    setActionError(null);
    setMessage(null);
    setInvite(null);
    try {
      const receipt = await api<SupportAccessReceipt>("/api/app/support-access/reissue", {
        request_id: requestId,
        support_session_id: session.support_session_id,
      });
      if (!supportCreateReceiptConfirmed(receipt, requestId, session.technician_label)
        || receipt.support_session_id !== session.support_session_id) {
        throw new Error("The brain did not confirm a replacement support invitation. No link is being presented.");
      }
      requests.confirmed(actionKey);
      setInvite(receipt);
      setNow(Date.now());
      setMessage(receipt.replayed
        ? "The same replacement invitation receipt was returned. No second session was created."
        : "A replacement one-time invitation is ready. The support session is still pending and its access timer has not started.");
      await load();
    } catch (next) {
      setActionError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(sessionId: string) {
    if (busy) return;
    const actionKey = `revoke:${sessionId}`;
    const requestId = requests.forAction(actionKey);
    setBusy(true);
    setActionError(null);
    setMessage(null);
    setInvite(null);
    try {
      const receipt = await api<SupportAccessReceipt>("/api/app/support-access/revoke", {
        request_id: requestId,
        support_session_id: sessionId,
      });
      if (!supportRevokeReceiptConfirmed(receipt, requestId, sessionId)) {
        throw new Error("The brain did not return a confirmed support revocation receipt.");
      }
      requests.confirmed(actionKey);
      setMessage(receipt.changed
        ? "Support access was revoked immediately. That browser can no longer read diagnostics."
        : "The brain confirmed this support access had already ended.");
      await load();
    } catch (next) {
      setActionError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    if (!inviteUsable || !invite?.enrollment_url) return;
    try {
      await navigator.clipboard.writeText(invite.enrollment_url);
      setMessage("Private support invitation copied. Send it only to the intended technician before it expires.");
    } catch {
      setActionError("The browser could not copy the private invitation. Create or reissue it from a browser that permits clipboard access.");
    }
  }

  return (
    <Section
      title="Get Support"
      blurb="Invite a technician to inspect privacy-safe diagnostics for a short time. This first version cannot make repairs."
    >
      <div className="p-4 border-b border-line">
        <TruthNote>
          A technician can see counts, connection types, and reviewed issue codes. They cannot read documents, email, messages, searches, answers, account names, or credentials, and they cannot make changes.
        </TruthNote>
        <div className="grid gap-4 sm:grid-cols-2">
          <BoundaryList title="Shared" items={SUPPORT_SHARED} />
          <BoundaryList title="Never shared" items={SUPPORT_NOT_SHARED} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_11rem] mt-4">
          <label className="block text-[12.5px] text-ink-soft">
            Invited technician label
            <input
              className="field mt-1"
              value={technicianLabel}
              maxLength={80}
              onChange={(event) => { setTechnicianLabel(event.target.value); setInvite(null); setMessage(null); }}
              placeholder="Support technician"
            />
            <span className="block mt-1">This is your label for the invitation. It does not verify the person’s identity.</span>
          </label>
          <label className="block text-[12.5px] text-ink-soft">
            Access time
            <select
              className="field mt-1"
              value={durationMinutes}
              onChange={(event) => { setDurationMinutes(Number(event.target.value) as SupportDurationMinutes); setInvite(null); setMessage(null); }}
            >
              {SUPPORT_DURATION_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>{supportDurationLabel(minutes)}</option>
              ))}
            </select>
            <span className="block mt-1">Starts after successful passkey enrollment. Two hours is the hard maximum.</span>
          </label>
        </div>
        {actionError && <div className="mt-3"><Attention>{actionError}</Attention></div>}
        {message && <div className="mt-3"><Note>{message}</Note></div>}
        {inviteUsable && (
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <button className="rounded-xl bg-accent px-4 py-2.5 text-white text-[13.5px]" onClick={copyInvite}>
              Copy private support invitation
            </button>
            <span className="text-[12.5px] text-ink-soft">{inviteExpiry(invite?.enrollment_expires_at, now)} The link itself is hidden from the page.</span>
          </div>
        )}
        {invite && !inviteUsable && (
          <div className="mt-3"><Attention>This invitation is no longer valid. No unusable link is being shown. Reissue it from the pending session below.</Attention></div>
        )}
        <button
          className="mt-4 rounded-xl bg-ink px-4 py-2.5 text-white text-[13.5px] disabled:opacity-45"
          onClick={create}
          disabled={busy || !normalizedLabel}
        >
          {busy ? "Saving" : "Create read-only support invitation"}
        </button>
      </div>

      {statusError && <Attention>{statusError}</Attention>}
      {!status && !statusError && <Empty>Reading support access status.</Empty>}
      {status && sessions.length === 0 && <Empty>No support access has been created.</Empty>}
      {sessions.map((session) => {
        const displayed = session.state === "active" && Number(session.expires_at) <= now
          ? { ...session, state: "expired" as const }
          : session;
        return (
          <Row key={session.support_session_id}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 flex-wrap text-[14.5px] font-medium">
                Invited technician: {session.technician_label}
                <Badge tone={displayed.state === "active" ? "accent" : "muted"}>{supportSessionStateLabel(displayed.state)}</Badge>
              </span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                {supportSessionTiming(displayed)}
              </span>
            </span>
            {(displayed.state === "pending" || displayed.state === "active") && (
              <span className="flex items-center gap-2 flex-wrap justify-end">
                {displayed.state === "pending" && (
                  <button disabled={busy} className="text-[13px] text-accent px-2 py-1 disabled:opacity-50" onClick={() => reissue(session)}>
                    {session.invite_state === "active" ? "Replace invitation" : "New invitation"}
                  </button>
                )}
                <Confirm
                  label="Revoke"
                  question="End this read-only support access now?"
                  disabled={busy}
                  onConfirm={() => revoke(session.support_session_id)}
                />
              </span>
            )}
          </Row>
        );
      })}
    </Section>
  );
}

function BoundaryList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="rounded-xl border border-line bg-paper/60 p-3.5">
      <p className="text-[13px] font-semibold">{title}</p>
      <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-soft">
        {items.map((item) => <li key={item} className="flex gap-2"><span aria-hidden="true">•</span><span>{item}</span></li>)}
      </ul>
    </div>
  );
}

function supportSessionTiming(session: SupportAccessSession): string {
  if (session.state === "pending") {
    return session.invite_state === "active"
      ? "Not opened yet. The one-time invitation expires soon; the support access timer has not started."
      : `Not opened. The one-time invitation was ${session.invite_state}; access never started.`;
  }
  if (session.state === "active") {
    const authentication = session.authentication_state === "reauthentication_required"
      ? " · technician must use their support passkey again"
      : "";
    return `Enrolled ${ago(session.activated_at)}${authentication} · ${remainingTime(session.expires_at)} remaining · ends ${endsAt(session.expires_at)}`;
  }
  if (session.state === "revoked") return `Revoked ${ago(session.revoked_at)}`;
  return `Expired ${ago(session.expires_at)}`;
}

function remainingTime(timestamp: number | null): string {
  if (!timestamp) return "time unavailable";
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function endsAt(timestamp: number | null): string {
  if (!timestamp) return "at an unavailable time";
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function inviteExpiry(expiresAt: number | null | undefined, now: number): string {
  if (!expiresAt) return "This invitation expires soon.";
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  return minutes > 0 ? `Expires in about ${minutes} minutes.` : "The invitation has expired.";
}
