import { useState } from "react";
import { enroll, signIn, passkeysSupported } from "../lib/passkey";

/**
 * The first screen a client ever sees, usually on a phone, from a text
 * message. It has to answer "what is this and why should I tap" before it
 * asks for anything, which is why the copy leads and the button follows.
 */
export function Gate({ owner, inviteCode, onIn }: {
  owner: string;
  inviteCode: string | null;
  onIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The "cannot sign in" help sits closed for the ordinary visitor, who is
  // almost everyone, and opens by itself the moment a sign-in actually fails,
  // because the person staring at that error is the one it was written for.
  const [helpOpen, setHelpOpen] = useState(false);
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
      setHelpOpen(true);
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

          {!enrolling && (
            <details
              open={helpOpen}
              onToggle={(e) => setHelpOpen((e.currentTarget as HTMLDetailsElement).open)}
              className="mt-6 border-t border-line pt-4"
            >
              <summary className="text-[13.5px] text-ink-soft cursor-pointer list-none
                                  marker:hidden [&::-webkit-details-marker]:hidden">
                Trouble signing in on this device?
              </summary>
              <div className="mt-3 space-y-3 text-[13.5px] leading-relaxed text-ink-soft">
                <p>
                  Your passkey usually travels with you. Apple and Google copy it to your
                  other phones and computers on their own, so the way you signed in before
                  should still work here.
                </p>
                <p>
                  On a computer you have never used, choose the option to use a phone when
                  your browser asks, then scan the QR code it shows with the phone you
                  already sign in with.
                </p>
                <p>
                  If every device you had is gone, the printed recovery card you were given
                  when this was set up is the way back in.{" "}
                  <a href="/app/recover" className="text-accent underline underline-offset-2">
                    Use a recovery code
                  </a>
                </p>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
