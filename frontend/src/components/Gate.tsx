import { useState } from "react";
import { enroll, signIn, passkeysSupported } from "../lib/passkey";

/**
 * The first screen a client ever sees, usually on a phone, from a text
 * message. It has to answer "what is this and why should I tap" before it
 * asks for anything, which is why the copy leads and the button follows.
 */
export function Gate({ owner, inviteCode, notice, onIn }: {
  owner: string;
  inviteCode: string | null;
  notice?: string | null;
  onIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrolling = Boolean(inviteCode);
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "Your";
  // First name in the greeting: a client opening this is being welcomed, not
  // addressed formally, and "Dana, your brain is ready" reads like a person
  // wrote it where "Dana Okonkwo's brain is ready" reads like a database did.
  const firstName = owner.trim().split(/\s+/)[0] || "";

  async function go() {
    setError(null);
    setBusy(true);
    try {
      if (enrolling) {
        await enroll(inviteCode!);
        history.replaceState(null, "", "/app");
      } else {
        await signIn();
      }
      onIn();
    } catch (e) {
      // Surface the real reason. "Something went wrong" on a security screen
      // is how someone decides the product is broken rather than that they
      // cancelled a Face ID prompt.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-5">
      <div className="w-full max-w-md">
        <div className="mb-6 text-[15px] text-ink-soft">{possessive} brain</div>

        <div className="bg-card border border-line rounded-2xl p-7 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <h1 className="text-[26px] leading-tight tracking-tight font-semibold">
            {enrolling
              ? firstName ? `${firstName}, your brain is ready` : "Your brain is ready"
              : firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          </h1>
          <p className="text-ink-soft mt-3 leading-relaxed">
            {enrolling
              ? "Everything you have written, decided and been told, in one place that belongs to you. Ask it anything and it answers with its sources."
              : "Sign in to ask your brain a question."}
          </p>

          {notice && (
            <p role="status" className="mt-4 text-[14px] text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-3 leading-relaxed">
              {notice}
            </p>
          )}

          {enrolling && (
            <ul className="mt-6 space-y-2.5">
              {[
                "One tap sets up your face or fingerprint as the key",
                "No password to create, remember, or lose",
                "It lives in your own account. Nobody else can read it",
              ].map((line) => (
                <li key={line} className="flex gap-2.5 text-[15px]">
                  <span className="text-accent font-bold leading-6">✓</span>
                  <span className="leading-6">{line}</span>
                </li>
              ))}
            </ul>
          )}

          {passkeysSupported() ? (
            <button
              onClick={go}
              disabled={busy}
              className="mt-7 w-full rounded-xl bg-accent px-5 py-3.5 text-white font-semibold
                         disabled:opacity-55 transition-opacity"
            >
              {busy ? "Waiting for your device…" : enrolling ? "Set up with Face ID" : "Sign in"}
            </button>
          ) : (
            <p className="mt-7 text-sm text-ink-soft">
              This browser cannot use passkeys. Open this link in Safari or Chrome
              on a device with a screen lock.
            </p>
          )}

          {enrolling && (
            <p className="mt-3 text-[13px] text-ink-soft">
              Takes about ten seconds. Works on every device you own.
            </p>
          )}
          {error && <p className="mt-4 text-[14px] text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}
