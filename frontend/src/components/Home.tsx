import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../lib/api";
import { derivePhase, phraseFor, type BrainPhase } from "../lib/phase";
import { Section, Row, Note, Badge } from "./ui";

/** What state is this brain in, and is anything wrong.
 *
 *  Deliberately NOT here: an actions list, a backlog count, and a "nothing
 *  needs you" quiet state. Nothing computes those yet, and a calm empty screen
 *  is a claim. An absent section is honest; a reassuring one that nothing
 *  produced is not. They arrive when the ledger holds something.
 *
 *  The governing rule for everything that IS here: the page shows the truth of
 *  the system, including incompleteness and failure, and is never used to make
 *  an unstable install feel finished. */
export function Home() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<SystemStatus>("/api/app/system")
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;
  const phase = derivePhase(status);

  return (
    <div>
      <PhaseNotice phase={phase} status={status} />

      {status?.problems && status.problems.length > 0 && (
        <Section
          title="Worth looking at"
          blurb="Your installer owns these. None of them is something you can fix from here, and saying so is more useful than a button that does nothing."
        >
          {status.problems.map((p) => (
            <Row key={p.id}>
              <span className="min-w-0">
                <span className="text-[14.5px] flex items-center gap-2 flex-wrap">
                  {p.title}
                  <Badge tone={p.severity === "crit" ? "warn" : "muted"}>
                    {p.severity === "crit" ? "Problem" : "Worth a look"}
                  </Badge>
                </span>
                {p.detail && (
                  <span className="block text-[13px] text-ink-soft mt-0.5">{p.detail}</span>
                )}
              </span>
            </Row>
          ))}
        </Section>
      )}

      <Section
        title="What it has read"
        blurb="Where your brain's knowledge comes from, and how current each one is."
      >
        {!status?.sources ? (
          <Note>
            The list of sources could not be read, so this screen cannot say what
            your brain has. That is a fault worth reporting, not a sign it is empty.
          </Note>
        ) : status.sources.length === 0 ? (
          <Note>No sources are connected yet.</Note>
        ) : status.sources.map((s) => (
          <Row key={s.label}>
            <span className="min-w-0">
              <span className="text-[14.5px] flex items-center gap-2 flex-wrap">
                {s.label}
                <SourceState state={s.state} />
              </span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                {s.documents.toLocaleString()} document{s.documents === 1 ? "" : "s"}
                {s.days_since_ingest !== null && ` · read ${dayPhrase(s.days_since_ingest)}`}
                {s.reason && <span className="block text-amber-800 mt-0.5">{s.reason}</span>}
              </span>
            </span>
          </Row>
        ))}
      </Section>

      <Section
        title="What it cannot see"
        blurb="The honest edge of your brain's knowledge. It can only answer from what it has been given."
      >
        {"documents" in (status || {}) ? (
          <Note>
            Your brain holds {status!.documents!.toLocaleString()} documents.
            Anything outside them, it does not know, and it will say so rather
            than guess.
          </Note>
        ) : (
          <Note>
            Your brain's contents could not be counted just now, so this screen
            cannot tell you what it holds.
          </Note>
        )}
      </Section>
    </div>
  );
}

/** The phase sentence, rendered identically wherever it appears. */
function PhaseNotice({ phase, status }: { phase: BrainPhase; status: SystemStatus | null }) {
  const loud = phase === "unreachable" || phase === "paused" || phase === "unknown";
  const tone = loud
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-card border-line text-ink-soft";
  const pct = status?.vectors?.percent_visible;

  return (
    <div className={`border rounded-2xl px-4 py-3.5 ${tone}`}>
      <p className="text-[14.5px] leading-relaxed">{phraseFor(phase, status)}</p>
      {phase === "indexing" && pct !== null && pct !== undefined && (
        <div className="mt-3">
          <div className="h-1.5 bg-paper rounded-full overflow-hidden border border-line">
            <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[12.5px] text-ink-soft mt-1.5">
            {status?.vectors?.pending.toLocaleString()} still to work through. You can
            use it now; it just may not have everything yet.
          </p>
        </div>
      )}
    </div>
  );
}

function SourceState({ state }: { state: string }) {
  // Only states that mean something to an owner get a chip. "ok", "manual" and
  // the rest carry none: a chip on every row makes the one that matters
  // invisible.
  if (state === "broken") return <Badge tone="warn">Not working</Badge>;
  if (state === "indexing") return <Badge tone="accent">Reading now</Badge>;
  if (state === "stale") return <Badge tone="muted">Not recent</Badge>;
  return null;
}

const dayPhrase = (d: number) =>
  d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
