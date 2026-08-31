import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, supportApi, type Me, type SupportMe } from "./lib/api";
import { Gate } from "./components/Gate";
import { Ask } from "./components/Ask";
import { Settings } from "./components/Settings";
import { Home } from "./components/Home";
import { Documents } from "./components/Documents";
import { ThisYear } from "./components/ThisYear";
import { FinanceScopeProvider } from "./components/FinanceScope";
import { Attention } from "./components/ui";
import { supportMeConfirmed } from "./lib/support";
import { SupportDiagnostics } from "./components/SupportDiagnostics";
import { SupportGate } from "./components/SupportGate";

// The invite arrives as /app#enroll=<code>. It lives in the fragment on
// purpose: a fragment is never sent to the server in a request line and never
// lands in an access log or a referrer header.
const inviteCode = (typeof location === "undefined" ? null : (location.hash.match(/^#enroll=([A-Za-z0-9_-]+)$/) || [])[1]) || null;
export function supportInviteFromHash(hash: string): string | null {
  return (hash.match(/^#support-enroll=([A-Za-z0-9_-]+)$/) || [])[1] || null;
}

export function supportModeFromHash(hash: string): boolean {
  return /^#support(?:$|-enroll=[A-Za-z0-9_-]+$)/.test(hash);
}

const supportInviteCode = typeof location === "undefined" ? null : supportInviteFromHash(location.hash);
// Keep the one-time code only in memory. The support gate still has the value
// it needs for enrollment, while refreshes, screenshots, copied addresses, and
// later browser history expose only the non-secret support-mode marker.
if (supportInviteCode && typeof history !== "undefined") {
  history.replaceState(null, "", "/app#support");
}
const supportMode = typeof location !== "undefined" && supportModeFromHash(location.hash);

// The owner's name comes from the server-rendered shell, not from /api/app/me.
// A signed-out visitor cannot call that endpoint, and the FIRST screen a client
// ever sees is the one that most needs to greet them by name.
const root = typeof document === "undefined" ? null : document.getElementById("root");
const shellOwner = root?.dataset.owner || "";

export type View = "home" | "year" | "documents" | "ask" | "access";
export const OWNER_VIEWS: readonly View[] = ["home", "year", "documents", "ask", "access"];
export const PRIMARY_OWNER_NAV: ReadonlyArray<{ view: View; label: string }> = [
  { view: "home", label: "Home" },
  { view: "year", label: "This Year" },
  { view: "documents", label: "Documents" },
  { view: "access", label: "Manage" },
];

export function visibleView(requested: View): View {
  return OWNER_VIEWS.includes(requested) ? requested : OWNER_VIEWS[0];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [supportMe, setSupportMe] = useState<SupportMe | null>(null);
  const [supportInvitePending, setSupportInvitePending] = useState(Boolean(supportInviteCode));
  const [view, setView] = useState<View>("home");
  const [askSeed, setAskSeed] = useState<{ id: number; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (supportMode) {
      try {
        setSupportMe(await supportApi<SupportMe>("/api/support/me"));
        setMe(null);
        setAuthNotice(null);
      } catch (next) {
        setSupportMe(null);
        setMe(null);
        setAuthNotice(next instanceof ApiError && next.status === 403 && typeof next.body.recovery === "string"
          ? next.body.recovery
          : null);
      } finally {
        setReady(true);
      }
      return;
    }
    try {
      setMe(await api<Me>("/api/app/me"));
      setSupportMe(null);
      setAuthNotice(null);
    } catch (next) {
      // A 401 is the ordinary signed-out case, not an error worth showing.
      setMe(null);
      setAuthNotice(next instanceof ApiError && next.status === 403 && typeof next.body.recovery === "string"
        ? next.body.recovery
        : null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Nothing until the session is known: flashing the sign-in screen at someone
  // who is already signed in reads as being logged out.
  if (!ready) return null;

  if (supportMode) {
    if (supportInvitePending) {
      return (
        <SupportGate
          inviteCode={supportInviteCode}
          notice={authNotice}
          onIn={() => { setSupportInvitePending(false); void refresh(); }}
        />
      );
    }
    if (!supportMe) return <SupportGate inviteCode={null} notice={authNotice} onIn={refresh} />;
    if (!supportMeConfirmed(supportMe)) {
      return <UnavailableSession message="The brain did not return the exact read-only support boundary. No owner or diagnostic surface is being opened." />;
    }
    return <SupportDiagnostics principal={supportMe.principal} onAccessEnded={refresh} />;
  }

  if (!me?.signed_in) {
    return <Gate owner={me?.owner || shellOwner} inviteCode={inviteCode} notice={authNotice} onIn={refresh} />;
  }

  if (me.principal?.kind === "grant") {
    return <UnavailableSession message="This Financial Brain uses owner-only access. Sign in with an owner passkey to open the workspace." />;
  }

  if (me.principal?.kind !== "owner") {
    return <UnavailableSession message="The brain could not prove whether this is an owner or document-only session. No workspace is being opened." />;
  }

  const owner = me.owner || shellOwner;
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "Your";
  const openExplore = (question = "") => {
    if (question) setAskSeed({ id: Date.now(), text: question });
    setView("ask");
  };

  return (
    <FinanceScopeProvider>
      <div className="min-h-dvh">
        <header className="px-4 sm:px-6 lg:px-8 border-b border-line bg-card/90 backdrop-blur sticky top-0 z-20">
          <div className="max-w-6xl mx-auto min-h-16 flex flex-col justify-center gap-2 py-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
            <button
              onClick={() => setView("home")}
              className="flex items-center gap-2 text-[14.5px] text-ink-soft hover:text-ink shrink-0"
            >
              <span className="w-7 h-7 rounded-lg bg-ink text-white grid place-items-center text-[12px] font-semibold" aria-hidden="true">FB</span>
              <span>{possessive} brain</span>
            </button>
            <nav aria-label="Primary" className="flex items-center gap-1 text-[13.5px] w-full overflow-x-auto lg:w-auto pb-0.5 lg:pb-0">
              {PRIMARY_OWNER_NAV.map((item) => (
                <Tab key={item.view} now={view} go={setView} to={item.view}>{item.label}</Tab>
              ))}
            </nav>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-7 sm:py-9 pb-24">
          {/* Explore stays mounted across a visit to Manage so an owner does
              not lose an answer while checking settings or adding a record. */}
          {view === "home" && <Home onExplore={openExplore} />}
          {view === "year" && <ThisYear />}
          {view === "documents" && <Documents />}
          <div className={view === "ask" ? "" : "hidden"}>
            <Ask initialQuestion={askSeed} onManage={() => setView("access")} />
          </div>
          {view === "access" && (
            <Settings
              devices={me.devices || []}
              connections={me.connections || []}
              onChange={refresh}
            />
          )}
        </main>
      </div>
    </FinanceScopeProvider>
  );
}

function UnavailableSession({ message }: { message: string }) {
  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <Attention>{message}</Attention>
    </main>
  );
}

function Tab({ now, to, go, children }: {
  now: View; to: View; go: (v: View) => void; children: ReactNode;
}) {
  const active = now === to;
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) buttonRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  return (
    <button
      ref={buttonRef}
      onClick={() => go(to)}
      aria-current={active ? "page" : undefined}
      className={`px-3 py-2 rounded-lg whitespace-nowrap ${
        active ? "bg-accent-soft text-accent font-medium" : "text-ink-soft hover:bg-paper hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
