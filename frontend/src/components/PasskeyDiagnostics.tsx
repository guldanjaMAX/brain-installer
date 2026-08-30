import { useEffect, useState } from "react";
import { ApiError, api, type PasskeyStatus } from "../lib/api";
import { humanSecurityCode } from "../lib/security";
import { Attention, Badge, Empty, Note, Row, Section, ago } from "./ui";

export function PasskeyDiagnostics() {
  const [status, setStatus] = useState<PasskeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api<PasskeyStatus>("/api/app/passkeys/status", {})
      .then((next) => {
        if (!current) return;
        if (next.status !== "ready" || !next.proof || !Array.isArray(next.ceremonies)) {
          setError("Passkey diagnostics did not return a complete status receipt.");
          return;
        }
        setStatus(next);
      })
      .catch((next) => {
        if (!current) return;
        setError(next instanceof ApiError && next.status === 503
          ? "Passkey diagnostics are unavailable. Device access still follows the enforced list below."
          : "Passkey diagnostics could not be read.");
      });
    return () => { current = false; };
  }, []);

  return (
    <Section
      title="Passkey readiness"
      blurb="Configuration, local verification, and live production proof are separate. A successful fixture or local ceremony is never presented as live proof."
    >
      {error && <Attention>{error}</Attention>}
      {!status && !error && <Empty>Reading privacy-safe passkey diagnostics.</Empty>}
      {status && (
        <>
          <div className="grid sm:grid-cols-3 border-b border-line">
            <Proof label="Configured" value={status.proof.configured} detail="Checks whether required server configuration is present." />
            <Proof label="Locally verified" value={status.proof.locally_verified} detail="Checks for a privacy-safe record of a successful local ceremony." />
            <Proof label="Live proven" value={status.proof.live_proven} detail="Requires an independently verified production ceremony." />
          </div>
          <Note>
            Relying party: {status.rp_id}. {status.devices.owner} owner {status.devices.owner === 1 ? "passkey" : "passkeys"} and {status.devices.grant} document-access {status.devices.grant === 1 ? "passkey" : "passkeys"} are recorded.
          </Note>
          {status.ceremonies.length === 0 ? (
            <Empty>No privacy-safe ceremony outcome is recorded yet.</Empty>
          ) : status.ceremonies.map((event, index) => (
            <Row key={`${event.ceremony}:${event.stage}:${event.outcome}:${index}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap text-[14px]">
                  {humanSecurityCode(event.ceremony)} · {humanSecurityCode(event.stage)}
                  <Badge tone={event.outcome === "succeeded" ? "accent" : "warn"}>{humanSecurityCode(event.outcome)}</Badge>
                </span>
                <span className="block text-[13px] text-ink-soft mt-0.5">
                  {event.count} recorded {event.count === 1 ? "outcome" : "outcomes"}
                  {event.last_at ? ` · latest ${ago(event.last_at)}` : ""}
                </span>
              </span>
            </Row>
          ))}
          <Note>{status.privacy}</Note>
        </>
      )}
    </Section>
  );
}

function Proof({ label, value, detail }: { label: string; value: boolean; detail: string }) {
  return (
    <div className="p-4 border-b sm:border-b-0 sm:border-r border-line last:border-0">
      <p className="text-[13px] font-medium">{label}</p>
      <p className={`mt-1 text-[13.5px] font-semibold ${value ? "text-emerald-700" : "text-amber-800"}`}>
        {value ? "Confirmed at this level" : "Not confirmed at this level"}
      </p>
      <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">{detail}</p>
    </div>
  );
}
