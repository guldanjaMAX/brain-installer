import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Me } from "./lib/api";
import { Gate } from "./components/Gate";
import { Ask } from "./components/Ask";
import { Settings } from "./components/Settings";
import { Home } from "./components/Home";
import { Documents } from "./components/Documents";
import { ThisYear } from "./components/ThisYear";
import { AddReview } from "./components/AddReview";
import { FinanceScopeProvider } from "./components/FinanceScope";

// The invite arrives as /app#enroll=<code>. It lives in the fragment on
// purpose: a fragment is never sent to the server in a request line and never
// lands in an access log or a referrer header.
const inviteCode = (location.hash.match(/enroll=([A-Za-z0-9_-]+)/) || [])[1] || null;

// The owner's name comes from the server-rendered shell, not from /api/app/me.
// A signed-out visitor cannot call that endpoint, and the FIRST screen a client
// ever sees is the one that most needs to greet them by name.
const root = document.getElementById("root");
const shellOwner = root?.dataset.owner || "";

type View = "home" | "year" | "documents" | "ask" | "review" | "access";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("home");
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/app/me"));
    } catch {
      // A 401 is the ordinary signed-out case, not an error worth showing.
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Nothing until the session is known: flashing the sign-in screen at someone
  // who is already signed in reads as being logged out.
  if (!ready) return null;

  if (!me?.signed_in) {
    return <Gate owner={me?.owner || shellOwner} inviteCode={inviteCode} onIn={refresh} />;
  }

  const owner = me.owner || shellOwner;
  const possessive = owner ? (/s$/i.test(owner) ? `${owner}'` : `${owner}'s`) : "Your";

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
              <Tab now={view} go={setView} to="home">Home</Tab>
              <Tab now={view} go={setView} to="year">This Year</Tab>
              <Tab now={view} go={setView} to="documents">Documents</Tab>
              <Tab now={view} go={setView} to="ask">Explore</Tab>
              <Tab now={view} go={setView} to="review">Add &amp; Review</Tab>
              <Tab now={view} go={setView} to="access">Access</Tab>
            </nav>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-7 sm:py-9 pb-24">
          {/* Explore stays mounted across a visit to Access: losing an answer
              because you checked who had access is a small betrayal of a page
              whose whole subject is trust. */}
          {view === "home" && <Home />}
          {view === "year" && <ThisYear />}
          {view === "documents" && <Documents />}
          <div className={view === "ask" ? "" : "hidden"}>
            <Ask />
          </div>
          {view === "review" && <AddReview />}
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
