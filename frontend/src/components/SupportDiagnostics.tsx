import { useEffect, useState } from "react";
import { ApiError, supportApi, type SupportPrincipal, type SupportSystemStatus } from "../lib/api";
import { supportSystemConfirmed } from "../lib/support";
import { Attention, Badge, Empty, Note, Row, Section, TruthNote } from "./ui";

export function SupportDiagnostics({ principal, onAccessEnded }: {
  principal: SupportPrincipal;
  onAccessEnded: () => void;
}) {
  const [status, setStatus] = useState<SupportSystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    let retryTimer: number | null = null;
    const load = (attempt: number) => {
      supportApi<SupportSystemStatus>("/api/support/system", {})
        .then((next) => {
        if (!current) return;
        if (!supportSystemConfirmed(next, principal)) {
          setError("The brain did not return the exact read-only diagnostic boundary. No diagnostic values are being shown.");
          return;
        }
        setStatus(next);
        })
        .catch((next) => {
        if (!current) return;
        if (next instanceof ApiError && next.status === 429
          && attempt === 0 && next.retryAfterSeconds !== null) {
          retryTimer = window.setTimeout(() => {
            if (current) load(1);
          }, next.retryAfterSeconds * 1_000);
          return;
        }
        if (next instanceof ApiError && (next.status === 401 || next.status === 403)) {
          setError(typeof next.body.recovery === "string"
            ? next.body.recovery
            : "This support access has ended. Ask the owner for a new invitation if more help is needed.");
          onAccessEnded();
          return;
        }
        setError(next instanceof ApiError && next.status === 503
          ? "Support diagnostics are unavailable. Missing values are not being shown as healthy or empty."
          : next instanceof ApiError && next.status === 429
            ? "Support diagnostics are still finishing the previous read. Wait a few seconds and reopen this support view."
          : "Support diagnostics could not be read. No diagnostic values are being shown.");
        });
    };
    load(0);
    return () => {
      current = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [onAccessEnded, principal]);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await supportApi("/api/support/signout", {});
      onAccessEnded();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SupportDiagnosticsView
      principal={principal}
      status={status}
      error={error}
      busy={busy}
      onSignOut={signOut}
    />
  );
}

export function SupportDiagnosticsView({ principal, status, error, busy = false, onSignOut = () => undefined }: {
  principal: SupportPrincipal;
  status: SupportSystemStatus | null;
  error?: string | null;
  busy?: boolean;
  onSignOut?: () => void;
}) {
  return (
    <div className="min-h-dvh">
      <header className="px-4 sm:px-6 lg:px-8 border-b border-line bg-card/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-4xl mx-auto min-h-16 flex items-center justify-between gap-4 py-3">
          <span className="flex items-center gap-2 text-[14.5px] text-ink-soft min-w-0">
            <span className="w-7 h-7 rounded-lg bg-ink text-white grid place-items-center text-[12px] font-semibold shrink-0" aria-hidden="true">FB</span>
            <span className="truncate">Temporary Support Diagnostics</span>
          </span>
          <button disabled={busy} onClick={onSignOut} className="text-[13px] text-ink-soft px-2 py-1 rounded-lg hover:bg-paper disabled:opacity-50 shrink-0">
            End my support view
          </button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-7 sm:py-9 pb-24">
        <header className="max-w-2xl">
          <p className="eyebrow">Read-only support</p>
          <h1 className="page-title">Support Diagnostics</h1>
          <p className="page-intro">
            You are the invited technician labeled “{principal.technician_label}.” This owner-provided label does not verify your identity.
          </p>
        </header>
        <div className="mt-5 max-w-3xl">
          <TruthNote>
            You can see aggregate counts, generic connection types, and reviewed issue codes until {expiryLabel(principal.expires_at)}. You cannot read or search the owner’s data, see account identifiers or credentials, or make changes.
          </TruthNote>
          {error && <Attention>{error}</Attention>}
          {!status && !error && <Empty>Reading privacy-safe support diagnostics.</Empty>}
        </div>
        {status && <Diagnostics status={status} />}
      </main>
    </div>
  );
}

function Diagnostics({ status }: { status: SupportSystemStatus }) {
  const partial = status.status === "partial" || status.unavailable.length > 0;
  return (
    <div className="mt-7 grid gap-7 lg:grid-cols-2 lg:items-start">
      <div>
        {partial && (
          <Attention>
            Some diagnostic sections are unavailable: {status.unavailable.join(", ") || "one or more sections"}. Missing values are omitted, not shown as zero or healthy.
          </Attention>
        )}
        <Section title="System" blurb="Safe product state, not owner content or infrastructure identifiers.">
          <DiagnosticRow label="Product version" value={status.brain.product_version} />
          <DiagnosticRow label="Database schema" value={String(status.brain.schema_version)} />
          <DiagnosticRow label="Brain status" value={status.brain.status || "Unavailable"} />
          <DiagnosticRow label="Accepting documents" value={status.brain.accepting_documents === null ? "Unavailable" : status.brain.accepting_documents ? "Yes" : "No"} />
          <DiagnosticRow label="Vector drain mode" value={status.brain.drain_mode || "Unavailable"} />
        </Section>

        <Section title="Aggregate coverage" blurb="Counts only. No titles, filenames, messages, snippets, or identifiers are available here.">
          {status.corpus ? (
            <>
              <DiagnosticRow label="Documents" value={status.corpus.documents.toLocaleString()} />
              <DiagnosticRow label="Chunks" value={status.corpus.chunks.toLocaleString()} />
            </>
          ) : <Empty>Corpus counts are unavailable and have been omitted.</Empty>}
          {status.vectors ? (
            <>
              <DiagnosticRow label="Semantic projection" value={status.vectors.ready ? "Ready" : "Still catching up"} />
              <DiagnosticRow label="Vectors visible" value={`${status.vectors.visible.toLocaleString()} of ${status.vectors.expected.toLocaleString()}`} />
              <DiagnosticRow label="Pending vector work" value={status.vectors.pending.toLocaleString()} />
            </>
          ) : <Empty>Vector counts are unavailable and have been omitted.</Empty>}
        </Section>
      </div>

      <div>
        <Section title="Reviewed issue codes" blurb="Guidance-only categories. Raw errors, logs, paths, and repair controls are never exposed.">
          {!status.problems && <Empty>Issue diagnostics are unavailable and have been omitted.</Empty>}
          {status.problems?.length === 0 && <Empty>No reviewed issue code was returned. This does not prove every external service is healthy.</Empty>}
          {status.problems?.map((problem) => (
            <Row key={`${problem.area}:${problem.code}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap text-[14px] font-medium">
                  {humanCode(problem.code)}
                  <Badge tone={problem.severity === "crit" ? "warn" : "muted"}>{problem.severity === "crit" ? "Critical" : "Warning"}</Badge>
                </span>
                <span className="block text-[13px] text-ink-soft mt-0.5">{humanCode(problem.area)} · {problem.count} recorded · guidance only</span>
              </span>
            </Row>
          ))}
        </Section>

        <Section title="Connection health" blurb="Generic connection classes and freshness only. Account names, addresses, source IDs, and contents are unavailable.">
          {!status.sources && <Empty>Connection diagnostics are unavailable and have been omitted.</Empty>}
          {status.sources?.length === 0 && <Empty>No generic connection status was returned.</Empty>}
          {status.sources?.map((source, index) => (
            <Row key={`${source.kind}:${index}`}>
              <span className="min-w-0 flex-1">
                <span className="text-[14px] font-medium">{source.label}</span>
                <span className="block text-[13px] text-ink-soft mt-0.5">
                  {humanCode(source.state)} · {source.documents.toLocaleString()} documents
                  {source.days_since_ingest === null ? " · refresh age unavailable" : ` · refreshed ${source.days_since_ingest} days ago`}
                </span>
              </span>
            </Row>
          ))}
          <Note>This page cannot repair anything. Give the owner guidance; any future repair requires a separate owner-approved action.</Note>
        </Section>
      </div>
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <span className="text-[13.5px] text-ink-soft">{label}</span>
      <span className="text-[13.5px] font-medium">{value}</span>
    </Row>
  );
}

function expiryLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
}

function humanCode(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
