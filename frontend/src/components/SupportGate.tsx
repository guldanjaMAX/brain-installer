import { useState } from "react";
import { enrollSupport, passkeysSupported, signInSupport } from "../lib/passkey";

export function SupportGate({ inviteCode, notice, onIn }: {
  inviteCode: string | null;
  notice?: string | null;
  onIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrolling = Boolean(inviteCode);

  async function go() {
    setError(null);
    setBusy(true);
    try {
      if (enrolling) await enrollSupport(inviteCode!);
      else await signInSupport();
      // Keep an explicit support mode marker, but remove the one-time secret
      // synchronously before the next request or render can preserve it.
      history.replaceState(null, "", "/app#support");
      onIn();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-5">
      <div className="w-full max-w-md">
        <div className="mb-6 text-[15px] text-ink-soft">Temporary Support Diagnostics</div>
        <div className="bg-card border border-line rounded-2xl p-7 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <p className="eyebrow">Read-only support</p>
          <h1 className="text-[26px] leading-tight tracking-tight font-semibold mt-2">
            {enrolling ? "Accept a support invitation" : "Return to support diagnostics"}
          </h1>
          <p className="text-ink-soft mt-3 leading-relaxed">
            {enrolling
              ? "Create a passkey for this short support session. Its timer begins only after enrollment succeeds."
              : "Use the support passkey created for this Brain. An owner passkey does not open this page."}
          </p>

          {notice && (
            <p role="status" className="mt-4 text-[14px] text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 leading-relaxed">
              {notice}
            </p>
          )}

          <ul className="mt-6 space-y-2.5">
            {[
              "Aggregate counts, connection types, and issue codes only",
              "No documents, email, messages, searches, answers, or credentials",
              "No repair controls, owner workspace, or access to other data",
              "The owner can revoke access immediately",
            ].map((line) => (
              <li key={line} className="flex gap-2.5 text-[15px]">
                <span className="text-accent font-bold leading-6" aria-hidden="true">✓</span>
                <span className="leading-6">{line}</span>
              </li>
            ))}
          </ul>

          {passkeysSupported() ? (
            <button
              onClick={go}
              disabled={busy}
              className="mt-7 w-full rounded-xl bg-accent px-5 py-3.5 text-white font-semibold disabled:opacity-55 transition-opacity"
            >
              {busy ? "Waiting for your device…" : enrolling ? "Create support passkey" : "Sign in to support"}
            </button>
          ) : (
            <p className="mt-7 text-sm text-ink-soft">
              This browser cannot use passkeys. Open the invitation in Safari or Chrome on a device with a screen lock.
            </p>
          )}
          {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
