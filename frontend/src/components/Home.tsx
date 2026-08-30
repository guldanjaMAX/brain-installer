import { useEffect, useMemo, useState } from "react";
import { api, type FinSnapshot, type SystemStatus } from "../lib/api";
import { derivePhase, phraseFor, type BrainPhase } from "../lib/phase";
import {
  accountCoverage, dateLabel, documentOutcome, entityLabel, moneyLabel,
  financialRecordsEmpty, nextDatedDeadline, partyLabel, waitingDetail, waitingMove,
} from "../lib/finance";
import { sourceOutcome } from "../lib/outcome";
import {
  Attention, Chip, Critical, NextStep, Note, Row, Section, TruthNote,
} from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { OwnerActivity } from "./OwnerActivity";

const FIN_SECTIONS = [
  "accounts", "documents", "deadlines", "exceptions", "reconciliations", "obligations", "cash",
];
const FIN_LABELS: Record<string, string> = {
  accounts: "account coverage",
  documents: "financial documents",
  deadlines: "deadlines",
  exceptions: "items needing a decision",
  reconciliations: "record comparisons",
  obligations: "obligations",
  cash: "cash balances",
};

/** The owner's starting point.
 *
 * This page combines the system's real health with the financial ledger's real
 * gaps. It never promotes installer commands into owner actions, and it does
 * not claim a ranked action list because the ledger has no common consequence
 * score, snooze state, or owner model across every collection. */
export function Home() {
  const { scope, entities, activeLabel } = useFinanceScope();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [systemLoaded, setSystemLoaded] = useState(false);
  const [finance, setFinance] = useState<FinSnapshot | null>(null);
  const [financeLoaded, setFinanceLoaded] = useState(false);
  const [financeError, setFinanceError] = useState(false);
  const [financeBusy, setFinanceBusy] = useState(false);

  useEffect(() => {
    let current = true;
    api<SystemStatus>("/api/app/system")
      .then((next) => { if (current) setStatus(next); })
      .catch(() => { if (current) setStatus(null); })
      .finally(() => { if (current) setSystemLoaded(true); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setFinanceBusy(true);
    setFinanceLoaded(false);
    setFinance(null);
    setFinanceError(false);
    api<FinSnapshot>("/api/fin/snapshot", {
      sections: FIN_SECTIONS,
      ...(scope ? { entity_slug: scope } : {}),
    }).then((next) => {
      if (!current) return;
      setFinance(next);
      setFinanceLoaded(true);
    }).catch(() => {
      if (!current) return;
      setFinance(null);
      setFinanceError(true);
      setFinanceLoaded(true);
    }).finally(() => {
      if (current) setFinanceBusy(false);
    });
    return () => { current = false; };
  }, [scope]);

  const phase = derivePhase(status);
  const unavailable = finance?.sections_unavailable || [];
  const financeIsEmpty = Boolean(finance?.ledger_installed && financialRecordsEmpty(finance, FIN_SECTIONS));

  return (
    <div aria-busy={!systemLoaded || financeBusy}>
      <FinanceScopeBar />
      <header className="max-w-3xl">
        <p className="eyebrow">Owner view</p>
        <h1 className="page-title">What deserves your attention</h1>
        <p className="page-intro">
          Current records, visible gaps, and the evidence behind each answer for {activeLabel}.
        </p>
      </header>

      <div className="mt-6 max-w-3xl">
        {systemLoaded ? (
          <PhaseNotice phase={phase} status={status} />
        ) : (
          <TruthNote>Reading the current brain and source status.</TruthNote>
        )}
      </div>

      {financeError && (
        <div className="mt-5 max-w-3xl">
          <Attention>Your financial records could not be reached. Nothing below is being presented as empty or settled.</Attention>
        </div>
      )}
      {finance && !finance.ledger_installed && (
        <div className="mt-5 max-w-3xl">
          <TruthNote>
            No financial records have been loaded into a ledger yet. The brain can still search documents, but it cannot show an owner-ready financial position from them.
          </TruthNote>
        </div>
      )}
      {finance?.ledger_installed && unavailable.length > 0 && (
        <div className="mt-5 max-w-3xl">
          <Attention>
            This read could not reach {joinList(unavailable.map((name) => FIN_LABELS[name] || "one section"))}. Those parts are omitted, not shown as zero.
          </Attention>
        </div>
      )}

      {financeIsEmpty && (
        <div className="mt-5 max-w-3xl">
          <TruthNote>
            No financial record is loaded for {activeLabel}. This is an empty ledger, not a finding that nothing is due, owed, missing, or in conflict.
          </TruthNote>
        </div>
      )}

      <div className="mt-7 max-w-3xl">
        <OwnerActivity />
      </div>

      {finance?.ledger_installed && !financeIsEmpty && (
        <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.85fr)] lg:items-start">
          <div>
            <AttentionList snapshot={finance} entities={entities} scopeName={activeLabel} />
            <BusinessStanding snapshot={finance} entities={entities} scope={scope} />
          </div>
          <div>
            <Glance snapshot={finance} scopeName={activeLabel} />
            <Blindspots snapshot={finance} status={status} scopeName={activeLabel} />
          </div>
        </div>
      )}

      {systemLoaded && (
        <div className="mt-9 grid gap-7 lg:grid-cols-2 lg:items-start">
          <SystemProblems status={status} />
          <SourceCoverage status={status} />
        </div>
      )}

      {!financeLoaded && <p className="sr-only">Reading current financial records.</p>}
    </div>
  );
}

type AttentionItem = {
  id: string;
  title: string;
  detail: string;
  state: "NEEDS" | "PROBLEM" | "WORKING";
  move?: "yours" | "waiting";
  waitingOn?: string | null;
  consequence?: string | null;
};

function AttentionList({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: Parameters<typeof entityLabel>[0];
  scopeName: string;
}) {
  const items = useMemo<AttentionItem[]>(() => {
    const rows: AttentionItem[] = [];
    snapshot.deadlines?.forEach((deadline) => {
      const recordedMove = waitingMove(deadline.waiting_on);
      const move = recordedMove || (!deadline.waiting_on
        ? /^(owner|you)$/i.test(deadline.owner_party) ? "yours" : "waiting"
        : undefined);
      rows.push({
        id: `deadline:${deadline.deadline_uid}`,
        title: deadline.item,
        detail: `${entityLabel(entities, deadline.entity_slug)} · ${deadline.due_date ? dateLabel(deadline.due_date) : "No date recorded"} · Whose it is: ${partyLabel(deadline.owner_party)}`,
        state: deadline.urgency === "asap"
          ? "PROBLEM"
          : move === "waiting" || !move || deadline.basis_state === "proposed" ? "WORKING" : "NEEDS",
        move,
        waitingOn: waitingDetail(deadline.waiting_on),
        consequence: deadline.consequence,
      });
    });
    snapshot.exceptions?.forEach((item) => {
      const move = item.waiting_on ? waitingMove(item.waiting_on) : "yours";
      rows.push({
        id: `exception:${item.exception_uid}`,
        title: item.issue,
        detail: `${entityLabel(entities, item.entity_slug)}${item.amount_minor !== null ? ` · ${moneyLabel(item.amount_minor, item.currency) || "amount recorded"}` : ""}`,
        state: move === "yours" ? "NEEDS" : "WORKING",
        move,
        waitingOn: waitingDetail(item.waiting_on),
      });
    });
    snapshot.documents?.filter((document) => documentOutcome(document) === "PROBLEM").forEach((document) => {
      rows.push({
        id: `document:${document.fin_doc_uid}`,
        title: document.title,
        detail: `${entityLabel(entities, document.entity_slug)} · This copy could not be read${document.unreadable_reason ? `: ${document.unreadable_reason}` : ""}.`,
        state: "PROBLEM",
        move: "yours",
      });
    });
    snapshot.reconciliations?.filter((item) => item.state === "mismatched").forEach((item) => {
      rows.push({
        id: `conflict:${item.reconciliation_uid}`,
        title: `${humanize(item.measure)} has conflicting figures`,
        detail: `${entityLabel(entities, item.entity_slug)} · ${item.claims.length} dated claims are being kept separately.`,
        state: item.ruled_claim_uid ? "WORKING" : "NEEDS",
        move: item.ruled_claim_uid ? undefined : "yours",
      });
    });
    return rows;
  }, [entities, snapshot]);

  const completeRead = ["deadlines", "exceptions", "documents", "reconciliations"]
    .every((key) => key in snapshot);
  const shown = items.slice(0, 7);

  return (
    <Section
      title="What needs attention"
      blurb="Grouped from the records, not scored against one another. A common consequence ranking does not exist yet."
    >
      {!completeRead && <Note>Part of the attention read was unavailable. The rows below may be incomplete.</Note>}
      {items.length === 0 && completeRead ? (
        <Note>
          No deadline, exception, unreadable document, or record conflict was found for {scopeName} in the sections that were read. That is not a claim that every possible issue has been checked.
        </Note>
      ) : shown.map((item) => (
        <Row key={item.id}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{item.title}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">{item.detail}</span>
            {item.consequence && <NextStep>{item.consequence}</NextStep>}
            {item.waitingOn ? (
              <NextStep owner={item.move}>{item.waitingOn}</NextStep>
            ) : item.move ? (
              <NextStep owner={item.move}>{item.move === "yours" ? "This is waiting for you." : "A person or custodian outside the brain has the next move."}</NextStep>
            ) : null}
          </span>
          <Chip state={item.state} />
        </Row>
      ))}
      {items.length > shown.length && (
        <Note>{items.length - shown.length} more items are recorded in This Year and Add &amp; Review.</Note>
      )}
    </Section>
  );
}

function Glance({ snapshot, scopeName }: { snapshot: FinSnapshot; scopeName: string }) {
  const coverage = snapshot.accounts ? accountCoverage(snapshot.accounts) : null;
  const next = snapshot.deadlines ? nextDatedDeadline(snapshot.deadlines) : null;
  const documents = snapshot.documents;
  const readable = documents?.filter((document) => document.readable && document.in_corpus).length;
  const needsCopy = documents?.filter((document) => !document.readable || document.availability !== "have_it").length;
  return (
    <Section title="At a glance" blurb={`A dated summary for ${scopeName}.`}>
      {"cash" in snapshot ? (
        <Row>
          <span>
            <span className="block text-[12px] uppercase tracking-[0.08em] text-ink-soft">Cash in the records</span>
            <span className="block text-[19px] font-semibold mt-1">
              {snapshot.cash!.mixed_currency
                ? "More than one currency"
                : moneyLabel(snapshot.cash!.total_minor, snapshot.cash!.currency) || "No supported total"}
            </span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">
              {snapshot.cash!.as_of ? `As of ${dateLabel(snapshot.cash!.as_of)}` : "No single dated position"}
            </span>
          </span>
          {!snapshot.cash!.complete && <Chip state="PROBLEM" />}
        </Row>
      ) : <Note>Cash balances were unavailable.</Note>}
      {snapshot.deadlines && (
        <Row>
          <span>
            <span className="block text-[12px] uppercase tracking-[0.08em] text-ink-soft">Next dated item</span>
            <span className="block text-[14.5px] font-medium mt-1">{next?.item || "No dated item recorded"}</span>
            {next?.due_date && <span className="block text-[12.5px] text-ink-soft mt-0.5">{dateLabel(next.due_date)}</span>}
          </span>
        </Row>
      )}
      {coverage && (
        <Row>
          <span>
            <span className="block text-[12px] uppercase tracking-[0.08em] text-ink-soft">Account records</span>
            <span className="block text-[14.5px] font-medium mt-1">{coverage.current} of {coverage.total} current or intentionally indirect</span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">
              {coverage.missing} missing · {coverage.partial} partial · {coverage.unassessed} not assessed
            </span>
          </span>
        </Row>
      )}
      {documents && (
        <Row>
          <span>
            <span className="block text-[12px] uppercase tracking-[0.08em] text-ink-soft">Financial documents</span>
            <span className="block text-[14.5px] font-medium mt-1">{readable} stored and searchable</span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">{needsCopy} need a copy or retake</span>
          </span>
        </Row>
      )}
    </Section>
  );
}

function BusinessStanding({ snapshot, entities, scope }: {
  snapshot: FinSnapshot;
  entities: Parameters<typeof entityLabel>[0];
  scope: string | null;
}) {
  if (scope || entities.filter((entity) => !entity.counterparty).length < 2) return null;
  const complete = ["accounts", "documents", "deadlines", "exceptions"].every((key) => key in snapshot);
  const owned = entities.filter((entity) => !entity.counterparty);
  return (
    <Section title="Where each business stands" blurb="The same records, separated by business rather than blended into one household view.">
      {!complete && <Note>Some financial sections were unavailable, so these business rows may be incomplete.</Note>}
      {owned.map((entity) => {
        const accounts = snapshot.accounts?.filter((row) => row.entity_slug === entity.entity_slug);
        const coverage = accounts ? accountCoverage(accounts) : null;
        const documents = snapshot.documents?.filter((row) => row.entity_slug === entity.entity_slug);
        const decisions = snapshot.exceptions?.filter((row) => row.entity_slug === entity.entity_slug);
        const deadlines = snapshot.deadlines?.filter((row) => row.entity_slug === entity.entity_slug);
        const ownerDecision = decisions?.some((row) => !row.waiting_on || waitingMove(row.waiting_on) === "yours") || false;
        const ownerDeadline = deadlines?.some((row) => {
          const move = waitingMove(row.waiting_on);
          return move === "yours" || (!row.waiting_on && /^(owner|you)$/i.test(row.owner_party));
        }) || false;
        const waiting = decisions?.some((row) => waitingMove(row.waiting_on) === "waiting")
          || deadlines?.some((row) => waitingMove(row.waiting_on) === "waiting")
          || decisions?.some((row) => Boolean(row.waiting_on) && !waitingMove(row.waiting_on))
          || deadlines?.some((row) => Boolean(row.waiting_on) && !waitingMove(row.waiting_on))
          || false;
        const documentProblem = documents?.some((row) => documentOutcome(row) === "PROBLEM") || false;
        const documentNeeds = documents?.some((row) => documentOutcome(row) === "NEEDS") || false;
        const documentWorking = documents?.some((row) => documentOutcome(row) === "WORKING") || false;
        const accountNeeds = Boolean(coverage
          && (coverage.total === 0 || coverage.missing > 0 || coverage.unassessed > 0));
        const outcome = !complete || documentProblem
          ? "PROBLEM"
          : accountNeeds || documents!.length === 0 || documentNeeds || ownerDecision || ownerDeadline
            ? "NEEDS"
            : waiting || documentWorking
              ? "WORKING"
              : "CURRENT";
        const accountSummary = coverage
          ? coverage.total === 0
            ? "No open account record is known"
            : `${coverage.current} of ${coverage.total} account records current or intentionally indirect`
          : "Account coverage unavailable";
        const documentSummary = documents
          ? `${documents.length} known financial ${documents.length === 1 ? "document" : "documents"}`
          : "Document register unavailable";
        const activeItems = (decisions?.length || 0) + (deadlines?.length || 0);
        return (
          <Row key={entity.entity_slug}>
            <span className="min-w-0 flex-1">
              <span className="text-[14.5px] font-medium">{entity.label}</span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                {accountSummary} · {documentSummary}
              </span>
              {activeItems > 0 && (
                <NextStep>
                  {decisions?.length || 0} {(decisions?.length || 0) === 1 ? "decision" : "decisions"} and {deadlines?.length || 0} active {(deadlines?.length || 0) === 1 ? "deadline" : "deadlines"} are recorded.
                </NextStep>
              )}
            </span>
            <Chip state={outcome} />
          </Row>
        );
      })}
    </Section>
  );
}

function Blindspots({ snapshot, status, scopeName }: {
  snapshot: FinSnapshot;
  status: SystemStatus | null;
  scopeName: string;
}) {
  const missingAccounts = snapshot.accounts?.filter((account) => account.status === "never_connected"
    || account.coverage_status === "missing"
    || account.coverage_status === null) || [];
  const missingDocuments = snapshot.documents?.filter((document) => document.availability !== "have_it" || !document.readable) || [];
  const staleSources = status?.sources?.filter((source) => source.state === "stale" || source.state === "broken" || source.state === "never_synced") || [];
  const canJudge = "accounts" in snapshot && "documents" in snapshot && Boolean(status?.sources);
  return (
    <Section title="What the brain cannot see" blurb={`Known gaps for ${scopeName}, including records held by other people.`}>
      {!canJudge && <Note>One or more gap registers could not be read, so this list is incomplete.</Note>}
      {missingAccounts.slice(0, 4).map((account) => (
        <Row key={account.account_slug}>
          <span className="min-w-0">
            <span className="text-[14px] font-medium">{account.label}</span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">
              {account.status === "never_connected" ? "Never connected" : account.coverage_status === null ? "Coverage not assessed" : "Records missing"}
            </span>
            {account.coverage_note && <NextStep>{account.coverage_note}</NextStep>}
          </span>
        </Row>
      ))}
      {missingDocuments.slice(0, 4).map((document) => (
        <Row key={document.fin_doc_uid}>
          <span className="min-w-0">
            <span className="text-[14px] font-medium">{document.title}</span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">
              {!document.readable ? "Copy unreadable" : document.available_from ? `Available from ${document.available_from}` : "Copy not in the brain"}
            </span>
          </span>
        </Row>
      ))}
      {staleSources.slice(0, 3).map((source) => (
        <Row key={source.label}>
          <span className="min-w-0">
            <span className="text-[14px] font-medium">{source.label}</span>
            <span className="block text-[12.5px] text-ink-soft mt-0.5">{source.reason || "This source is not current."}</span>
          </span>
        </Row>
      ))}
      {canJudge && missingAccounts.length === 0 && missingDocuments.length === 0 && staleSources.length === 0 && (
        <Note>No known gap appears in the account, document, or source registers. An unlisted account or record is still outside what this screen can prove.</Note>
      )}
    </Section>
  );
}

function SystemProblems({ status }: { status: SystemStatus | null }) {
  return (
    <Section title="Brain status" blurb="Technical problems stay visible, but they remain your installer's responsibility.">
      {!status?.problems ? (
        <Note>The problem register could not be read. This is not an all-clear.</Note>
      ) : status.problems.length === 0 ? (
        <Note>No technical problem was reported by the checks that ran.</Note>
      ) : status.problems.map((problem) => (
        <Row key={problem.id}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{problem.title}</span>
            {problem.detail && <span className="block text-[13px] text-ink-soft mt-0.5">{problem.detail}</span>}
            <NextStep owner="installer">This is not an owner remedy.</NextStep>
          </span>
          <Chip state="PROBLEM" />
        </Row>
      ))}
    </Section>
  );
}

function SourceCoverage({ status }: { status: SystemStatus | null }) {
  return (
    <Section title="What it has read" blurb="Where the brain's knowledge comes from and how current each source is.">
      {!status?.sources ? (
        <Note>The source list could not be read, so this screen cannot say what the brain has.</Note>
      ) : status.sources.length === 0 ? (
        <Note>No source is connected yet.</Note>
      ) : status.sources.map((source) => (
        <Row key={source.label}>
          <span className="min-w-0">
            <span className="text-[14.5px] font-medium">{source.label}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {source.documents.toLocaleString()} {source.documents === 1 ? "document" : "documents"}
              {source.days_since_ingest !== null && ` · read ${dayPhrase(source.days_since_ingest)}`}
            </span>
            {source.reason && <NextStep>{source.reason}</NextStep>}
          </span>
          <SourceChip state={source.state} />
        </Row>
      ))}
    </Section>
  );
}

function PhaseNotice({ phase, status }: { phase: BrainPhase; status: SystemStatus | null }) {
  const pct = status?.vectors?.percent_visible;
  if (phase === "unreachable" || phase === "paused" || phase === "unknown") {
    return phase === "unreachable"
      ? <Critical>{phraseFor(phase, status)}</Critical>
      : <Attention>{phraseFor(phase, status)}</Attention>;
  }
  return (
    <div className="border border-line rounded-2xl px-4 py-3.5 bg-card">
      <p className="text-[14.5px] text-ink-soft leading-relaxed">{phraseFor(phase, status)}</p>
      {phase === "indexing" && pct !== null && pct !== undefined && (
        <div className="mt-3">
          <div className="h-1.5 bg-paper rounded-full overflow-hidden border border-line">
            <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[12.5px] text-ink-soft mt-1.5">
            {status?.vectors?.pending.toLocaleString()} still to work through. Answers may be incomplete until it finishes.
          </p>
        </div>
      )}
    </div>
  );
}

function SourceChip({ state }: { state: string }) {
  const outcome = sourceOutcome(state);
  return outcome ? <Chip state={outcome} /> : null;
}

const dayPhrase = (days: number) =>
  days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function joinList(items: string[]): string {
  if (items.length < 2) return items[0] || "one section";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
