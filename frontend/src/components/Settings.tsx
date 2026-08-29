import { useEffect, useState } from "react";
import { api, apiGet, type Device, type Connection, type BankStatus } from "../lib/api";
import { enroll } from "../lib/passkey";
import { Section, Row, Note, Empty, Badge, Chip, Confirm, EditableName, ago, agoISO } from "./ui";

/** Who and what can open this brain.
 *
 *  There are four ways in, and an owner who has just handed over their
 *  documents asks about all four early: a person with a passkey, an AI app
 *  holding a grant, a bank the brain pulls from, and the operator key used to
 *  install it. A page that answers three of them reads as an answer rather
 *  than as three quarters of one, so the fourth is here too — as the honest
 *  statement that this screen cannot see it. */
export function Settings({ devices, connections, onChange }: {
  devices: Device[];
  connections: Connection[];
  onChange: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banks, setBanks] = useState<BankStatus | null>(null);

  // The bank feed is a separate surface with its own auth, so it is fetched
  // here rather than folded into /api/app/me: a brain with no bank configured
  // should not make the whole page fail.
  const loadBanks = () => apiGet<BankStatus>("/api/bank-feed/status").then(setBanks).catch(() => setBanks(null));
  useEffect(() => { loadBanks(); }, []);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
      onChange();
      await loadBanks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const bankRows = banks?.connections || [];
  const attention = new Set((banks?.needs_attention || []).map((b) => b.item_ref));

  return (
    <div>
      <header className="max-w-2xl mb-7">
        <p className="eyebrow">People, devices, and apps</p>
        <h1 className="page-title">Access</h1>
        <p className="page-intro">
          See every owner device and connected app this brain can verify, and remove access in place.
        </p>
      </header>
      {error && (
        <p className="mb-5 text-[14px] text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <Section
        title="Your devices"
        blurb="Passkeys that can open this brain. Yours syncs to your own devices through your password manager, so add one here only for a device outside that sync. The list below is the enforcement itself, not a description of it."
        action={
          <button
            disabled={busy}
            onClick={() => run(() => enroll())}
            className="text-[13.5px] text-accent font-medium disabled:opacity-50 shrink-0"
          >
            + Add this device
          </button>
        }
      >
        {devices.length === 0 ? (
          <Empty>No devices yet.</Empty>
        ) : devices.map((device) => (
          <Row key={device.credential_id}>
            <span className="min-w-0">
              <EditableName
                value={device.nickname || ""}
                placeholder="unnamed device"
                disabled={busy}
                onSave={(nickname) => run(() => api("/api/app/devices/rename", {
                  credential_id: device.credential_id, nickname,
                }))}
              />
              <span className="block text-[13px] text-ink-soft mt-0.5">
                Added {ago(device.created_at)}
                {device.last_used_at ? ` · last used ${ago(device.last_used_at)}` : " · not used yet"}
              </span>
            </span>
            <Confirm
              label="Remove"
              question="Remove this device?"
              disabled={busy}
              onConfirm={() => run(async () => {
                const result = await api<{ removed: boolean; reason?: string }>(
                  "/api/app/devices/revoke", { credential_id: device.credential_id },
                );
                // Removing the last passkey is refused by the brain, not by
                // this button. The reason it gives is the useful part.
                if (result.reason) setError(result.reason);
              })}
            />
          </Row>
        ))}
      </Section>

      <Section
        title="Connected AI"
        blurb="Apps you approved with your passkey. Each one can search everything this brain holds. An app approved for writing can also add to it and correct what it already knows."
      >
        {connections.length === 0 ? (
          <Empty>
            Nothing is connected yet. Add this brain as a connector in Claude or
            ChatGPT to ask it questions from inside them.
          </Empty>
        ) : connections.map((connection) => (
          <Row key={connection.client_id}>
            <span className="min-w-0">
              <span className="text-[14.5px] flex items-center gap-2 flex-wrap">
                {connection.name}
                <Badge tone={connection.can_write ? "accent" : "muted"}>
                  {connection.can_write ? "Reads and writes" : "Reads only"}
                </Badge>
              </span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                Connected {ago(connection.connected_at)}
                {connection.last_used_at
                  ? ` · last used ${ago(connection.last_used_at)}`
                  : " · not used yet"}
              </span>
            </span>
            <Confirm
              label="Disconnect"
              question="Disconnect?"
              disabled={busy}
              onConfirm={() => run(() => api("/api/app/connections/revoke", {
                client_id: connection.client_id,
              }))}
            />
          </Row>
        ))}
      </Section>

      {banks?.configured && (
        <Section
          title="Banks"
          blurb="Accounts this brain reads transactions from. Disconnecting stops it fetching anything new; the history already here stays."
        >
          {bankRows.length === 0 ? (
            <Empty>No bank is linked.</Empty>
          ) : bankRows.map((bank) => (
            <Row key={bank.item_ref}>
              <span className="min-w-0">
                <span className="text-[14.5px] flex items-center gap-2 flex-wrap">
                  {bank.institution_label || "a bank"}
                  {attention.has(bank.item_ref) && <Chip state="PROBLEM" />}
                </span>
                <span className="block text-[13px] text-ink-soft mt-0.5">
                  {bank.last_synced_at ? `Last checked ${agoISO(bank.last_synced_at)}` : "Not checked yet"}
                  {/* When a feed is broken, the consequence is the part that
                      matters: every financial answer is now missing whatever
                      has happened at that bank since it stopped. */}
                  {attention.has(bank.item_ref) && (
                    <span className="block text-amber-800 mt-0.5">
                      {bank.status_detail
                        ? `${bank.status_detail}. `
                        : "This connection stopped working. "}
                      Answers about money are missing anything that has happened
                      here since.
                    </span>
                  )}
                </span>
              </span>
              <Confirm
                label="Disconnect"
                question="Disconnect this bank?"
                disabled={busy}
                onConfirm={() => run(() => api("/api/bank-feed/disconnect", { item_ref: bank.item_ref }))}
              />
            </Row>
          ))}
        </Section>
      )}

      <Section
        title="The key used to set this up"
        blurb="One thing on this page cannot be shown to you, and pretending otherwise would be the wrong kind of reassurance."
      >
        <Note>
          Whoever installed this brain used an operator key. It is a different
          key from every device above, so removing a device does not touch it,
          and neither does signing out everywhere. Anyone holding it can enroll
          a new device here at any time. If that happens, it shows up in your
          device list as one you did not add, and that is the only trace this
          brain can give you.
        </Note>
        <Note>
          Your move, and it is a real one: ask your installer to rotate that key
          and tell you the date they did it. A rotated key makes every old copy
          dead. That is stronger than a promise the key was destroyed, because
          it is something that actually happens to the brain rather than
          something someone says.
        </Note>
      </Section>

      <Section
        title="Signing out"
        blurb="Signing out never deletes anything. You come back in with your passkey."
      >
        <Row>
          <span className="min-w-0">
            <span className="text-[14.5px]">Sign out on this device</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              Your other devices and connected apps keep working.
            </span>
          </span>
          <Confirm
            label="Sign out"
            question="Sign out here?"
            tone="quiet"
            disabled={busy}
            onConfirm={() => run(async () => { await api("/api/app/signout"); location.reload(); })}
          />
        </Row>
        <Row>
          <span className="min-w-0">
            <span className="text-[14.5px]">Sign out everywhere</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              Ends every device's session and every AI connection above, in one
              move. Use this if a device is lost. It does not remove anything
              from your device list, does not disconnect a bank, and does not
              affect the operator key.
            </span>
          </span>
          <Confirm
            label="Sign out everywhere"
            question="Sign out everywhere, including AI?"
            disabled={busy}
            onConfirm={() => run(async () => { await api("/api/app/signout-all"); location.reload(); })}
          />
        </Row>
      </Section>
    </div>
  );
}
