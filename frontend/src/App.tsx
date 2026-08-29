import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "./lib/api";
import { Gate } from "./components/Gate";
import { Ask } from "./components/Ask";
import { Settings } from "./components/Settings";

// The invite arrives as /app#enroll=<code>. It lives in the fragment on
// purpose: a fragment is never sent to the server in a request line and never
// lands in an access log or a referrer header.
const inviteCode = (location.hash.match(/enroll=([A-Za-z0-9_-]+)/) || [])[1] || null;

// The owner's name comes from the server-rendered shell, not from /api/app/me.
// A signed-out visitor cannot call that endpoint, and the FIRST screen a client
// ever sees is the one that most needs to greet them by name.
const root = document.getElementById("root");
const shellOwner = root?.dataset.owner || "";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
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
    <div className="min-h-dvh">
      <header className="px-5 lg:px-8 py-4 border-b border-line bg-card/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-2xl mx-auto text-[14.5px] text-ink-soft">
          {possessive} brain
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-5 lg:px-8 py-8 pb-24">
        <Ask />
        <Settings devices={me.devices || []} onChange={refresh} />
      </main>
    </div>
  );
}
