import { useState } from "react";
import { api, type Device } from "../lib/api";
import { enroll } from "../lib/passkey";

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "never used";

/** Devices that can open this brain. The list is the honest answer to "who has
 *  access right now", which is the question a client asks once they trust the
 *  thing enough to put real material in it. */
export function Settings({ devices, onChange }: { devices: Device[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 bg-card border border-line rounded-2xl p-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <h2 className="text-[12px] uppercase tracking-wider text-ink-soft font-semibold">
          Settings
        </h2>
        <span className="text-[13px] text-accent">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="mt-4">
          <p className="text-[14px] text-ink-soft leading-relaxed">
            Devices that can open this brain. Your passkey syncs to your own
            devices automatically, so add one here only for a device outside
            that sync.
          </p>

          <ul className="mt-4 divide-y divide-line">
            {devices.map((device) => (
              <li key={device.credential_id} className="py-3 flex items-center justify-between gap-3">
                <span className="text-[14.5px]">
                  {device.nickname || "unnamed device"}
                  <span className="text-ink-soft"> · {when(device.last_used_at)}</span>
                </span>
                <span className="flex gap-1 shrink-0">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const nickname = prompt("Name this device", device.nickname || "");
                      if (nickname !== null) {
                        run(() => api("/api/app/devices/rename", {
                          credential_id: device.credential_id, nickname,
                        }));
                      }
                    }}
                    className="text-[13px] text-ink-soft px-2 py-1 disabled:opacity-50"
                  >
                    rename
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (!confirm("Remove this device's access?")) return;
                      run(async () => {
                        const result = await api<{ removed: boolean; reason?: string }>(
                          "/api/app/devices/revoke", { credential_id: device.credential_id },
                        );
                        // Removing the last passkey is refused by the brain, not
                        // by this button: the reason it gives is worth showing.
                        if (result.reason) setError(result.reason);
                      });
                    }}
                    className="text-[13px] text-red-700 px-2 py-1 disabled:opacity-50"
                  >
                    revoke
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2 mt-4">
            <button
              disabled={busy}
              onClick={() => run(() => enroll())}
              className="text-[13.5px] text-ink-soft px-3 py-2 rounded-lg border border-line disabled:opacity-50"
            >
              + Add this device
            </button>
            <button
              disabled={busy}
              onClick={() => run(async () => { await api("/api/app/signout"); location.reload(); })}
              className="text-[13.5px] text-ink-soft px-3 py-2 rounded-lg border border-line disabled:opacity-50"
            >
              Sign out
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (!confirm("Sign out on every device? Everyone signs back in with their passkey.")) return;
                run(async () => { await api("/api/app/signout-all"); location.reload(); });
              }}
              className="text-[13.5px] text-red-700 px-3 py-2 rounded-lg border border-line disabled:opacity-50"
            >
              Sign out everywhere
            </button>
          </div>

          {error && <p className="mt-3 text-[14px] text-red-700">{error}</p>}
        </div>
      )}
    </section>
  );
}
