import { useEffect, useState } from "react";
import {
  api, type FinDeadline, type FinEntity, type FinSnapshot,
} from "../lib/api";
import {
  accountCoverage, accountLabel, dateLabel, entityLabel, financialRecordsEmpty,
  moneyLabel, nextDatedDeadline, partyLabel, waitingDetail, waitingMove,
} from "../lib/finance";
import { Attention, Badge, Chip, NextStep, Note, Row, Section, TruthNote } from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { OwnerTargets } from "./OwnerTargets";
import { OwnerPeriodClose } from "./OwnerPeriodClose";

const SECTIONS = [
  "accounts", "deadlines", "exceptions", "obligations", "cash",
  "statements", "open_items", "reconciliations", "unsorted_spending",
];
const SECTION_LABELS: Record<string, string> = {
  accounts: "account coverage",
  deadlines: "deadlines",
  exceptions: "items needing a decision",
  obligations: "obligations",
  cash: "cash balances",
  statements: "statement processing",
  open_items: "questions for your professionals",
  reconciliations: "record comparisons",
  unsorted_spending: "uncategorized spending",
};

/** What the financial ledger can say about the current year.
 *
 * Every collection branches on presence before emptiness. If one read fails,
 * its key is absent and this screen names the gap instead of drawing a quiet
 * empty section. */
export function ThisYear() {
  const { scope, entities, activeLabel: scopeName } = useFinanceScope();
  const [snapshot, setSnapshot] = useState<FinSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setLoaded(false);
    setSnapshot(null);
    setError(null);
    api<FinSnapshot>("/api/fin/snapshot", {
      sections: SECTIONS,
      ...(scope ? { entity_slug: scope } : {}),
    }).then((next) => {
      if (!current) return;
      setSnapshot(next);
      setLoaded(true);
    }).catch(() => {
      if (!current) return;
      setSnapshot(null);
      setError("Your financial records could not be reached just now. Nothing below is being presented as empty.");
      setLoaded(true);
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [scope]);

  const unavailable = snapshot?.sections_unavailable || [];

  return (
    <div aria-busy={busy}>
      <FinanceScopeBar />
      <p className="eyebrow">Dated financial work</p>
      <h1 className="page-title">This Year</h1>
      <p className="page-intro max-w-2xl">
        Deadlines, decisions, obligations, and dated balances from records your brain has actually read.
      </p>

      {!loaded && <p className="sr-only">Reading your financial records.</p>}
      {error && <div className="mt-5"><Attention>{error}</Attention></div>}

      {snapshot && !snapshot.ledger_installed && (
        <div className="mt-5">
          <TruthNote>
            No financial records have been loaded yet. This screen will fill in after the financial ledger is set up and records arrive.
          </TruthNote>
        </div>
      )}

      {snapshot?.ledger_installed && unavailable.length > 0 && (
        <div className="mt-5">
          <Attention>
            This read could not reach {joinList(unavailable.map((name) => SECTION_LABELS[name] || "one section"))}. Those parts are omitted, not shown as empty.
          </Attention>
        </div>
      )}

      {snapshot?.ledger_installed && financialRecordsEmpty(snapshot, SECTIONS) ? (
        <div className="mt-5">
          <EmptyState scopeName={scopeName} />
        </div>
      ) : snapshot?.ledger_installed ? (
        <YearContents snapshot={snapshot} entities={entities} scopeName={scopeName} scope={scope} />
      ) : null}
    </div>
  );
}

function YearContents({ snapshot, entities, scopeName, scope }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
  scopeName: string;
  scope: string | null;
}) {
  const deadlines = snapshot.deadlines;
  const next = deadlines ? nextDatedDeadline(deadlines) : null;

  return (
    <div className="mt-6">
      {deadlines && deadlines.length > 0 && !next && (
        <TruthNote>
          Nothing is dated for {scopeName}. {deadlines.length} {deadlines.length === 1 ? "item is" : "items are"} recorded, but none carries a due date, so nothing can honestly be called next.
        </TruthNote>
      )}
      {next && <DeadlineHero deadline={next} entities={entities} count={deadlines!.length} />}

      <CashSection snapshot={snapshot} />
      <OwnerTargets />
      <DecisionSection snapshot={snapshot} entities={entities} scopeName={scopeName} />
      <ConflictSection snapshot={snapshot} entities={entities} />
      <ObligationSection snapshot={snapshot} entities={entities} scopeName={scopeName} />
      <DeadlineSection snapshot={snapshot} entities={entities} scopeName={scopeName} />
      <CoverageSection snapshot={snapshot} entities={entities} scopeName={scopeName} />
      <CloseSection snapshot={snapshot} scope={scope} />
      <ProfessionalSection snapshot={snapshot} entities={entities} scopeName={scopeName} />
    </div>
  );
}

function EmptyState({ scopeName }: { scopeName: string }) {
  return (
    <div className="bg-card border border-line rounded-2xl px-5 py-8 text-center">
      <p className="text-[15px] font-medium">No financial records have been loaded for {scopeName}.</p>
      <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed max-w-md mx-auto">
        That is an empty ledger, not a finding that nothing is due or owed. Deadlines, decisions, obligations, and balances will appear only after records support them.
      </p>
    </div>
  );
}

function DeadlineHero({ deadline, entities, count }: {
  deadline: FinDeadline;
  entities: FinEntity[];
  count: number;
}) {
  const parts = deadline.due_date!.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  const month = date.toLocaleDateString(undefined, { month: "short" }).toUpperCase();
  return (
    <section className="bg-ink text-white rounded-2xl px-5 py-5 flex items-center gap-5">
      <div className="shrink-0 w-16 h-16 rounded-xl bg-white/10 flex flex-col items-center justify-center" aria-hidden="true">
        <strong className="text-[24px] leading-none">{parts[2]}</strong>
        <span className="text-[11px] tracking-[0.1em] mt-1">{month}</span>
      </div>
      <div className="min-w-0">
        <p className="text-[11.5px] uppercase tracking-[0.1em] text-white/65">
          {deadline.basis_state === "confirmed" ? "Next hard deadline" : "Next proposed date"}
        </p>
        <h2 className="text-[17px] font-semibold mt-1">{deadline.item}</h2>
        <p className="text-[13px] text-white/75 mt-1 leading-relaxed">
          {entityLabel(entities, deadline.entity_slug)}. Whose it is: {partyLabel(deadline.owner_party)}.
          {count > 1 && ` ${count - 1} more ${count - 1 === 1 ? "item is" : "items are"} in the register below.`}
        </p>
      </div>
    </section>
  );
}

function CashSection({ snapshot }: { snapshot: FinSnapshot }) {
  if (!("cash" in snapshot)) return null;
  const cash = snapshot.cash!;
  const total = cash.mixed_currency ? null : moneyLabel(cash.total_minor, cash.currency);
  return (
    <Section title="Cash in the records" blurb="A dated position, never a mix of balances from different days.">
      {total ? (
        <Row>
          <span>
            <span className="block text-[21px] font-semibold tracking-tight">{total}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              As of {dateLabel(cash.as_of) || "a date that could not be read"}. Covers {cash.accounts_covered} of {cash.accounts_considered} cash {cash.accounts_considered === 1 ? "account" : "accounts"}.
            </span>
          </span>
          {!cash.complete && <Chip state="PROBLEM" />}
        </Row>
      ) : cash.mixed_currency ? (
        <Note>These balances use more than one currency, so there is no honest single total to show.</Note>
      ) : cash.accounts_considered === 0 ? (
        <Note>No deposit account with a confirmed balance is recorded here yet.</Note>
      ) : (
        <Note>No single dated cash figure can be supported by the records available.</Note>
      )}
    </Section>
  );
}

function DecisionSection({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
  scopeName: string;
}) {
  if (!("exceptions" in snapshot)) return null;
  const rows = snapshot.exceptions!;
  return (
    <Section title="Needs a decision" blurb="Real records that do not yet have one settled reading.">
      {rows.length === 0 ? (
        <Note>
          Nothing here needs a decision for {scopeName}. That means no unmatched money has been found in what the brain can currently see, not that every record is settled.
        </Note>
      ) : rows.map((item) => {
        const move = waitingMove(item.waiting_on);
        return (
          <Row key={item.exception_uid}>
            <span className="min-w-0 flex-1">
              <span className="text-[14.5px] font-medium">{item.issue}</span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                {entityLabel(entities, item.entity_slug)}
                {item.amount_minor !== null && ` · ${moneyLabel(item.amount_minor, item.currency) || "amount recorded"}`}
                {` · first seen ${dateLabel(item.first_seen) || "on an unreadable date"}`}
              </span>
              {item.proposal && (
                <NextStep>
                  The brain's reading, a proposal and not a fact: {item.proposal}
                </NextStep>
              )}
              {item.waiting_on && (
                <NextStep owner={move}>{waitingDetail(item.waiting_on) || "This is waiting for you."}</NextStep>
              )}
            </span>
          </Row>
        );
      })}
    </Section>
  );
}

function ObligationSection({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
  scopeName: string;
}) {
  if (!("obligations" in snapshot)) return null;
  const rows = snapshot.obligations!;
  const exposure = snapshot.obligation_exposure;
  return (
    <Section
      title="Obligations"
      blurb={exposure?.balance_minor !== null && exposure?.balance_minor !== undefined
        ? `${moneyLabel(exposure.balance_minor, exposure.currency) || "A balance"} recorded across ${exposure.obligations_with_balance} of ${exposure.obligations_total} obligations.`
        : "What the records say is owed, renewed, or guaranteed."}
    >
      {rows.length === 0 ? (
        <Note>
          No obligation is recorded for {scopeName}. That means none has been entered or found in a document, not that none exists.
        </Note>
      ) : rows.map((item) => (
        <Row key={item.obligation_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">
              {item.label || item.counterparty || "An obligation"}
            </span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {entityLabel(entities, item.entity_slug)}
              {item.balance_minor !== null && ` · ${moneyLabel(item.balance_minor, item.currency) || "balance recorded"}`}
              {item.balance_as_of && ` as of ${dateLabel(item.balance_as_of) || "an unreadable date"}`}
              {item.renews_on && ` · renews ${dateLabel(item.renews_on) || "on an unreadable date"}`}
            </span>
          </span>
          {item.personal_guarantee && <Badge tone="warn">Personal guarantee found</Badge>}
        </Row>
      ))}
    </Section>
  );
}

function DeadlineSection({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
  scopeName: string;
}) {
  if (!("deadlines" in snapshot)) return null;
  const rows = snapshot.deadlines!;
  return (
    <Section title="Coming up" blurb="Every item has an owner, and every proposed date says so.">
      {rows.length === 0 ? (
        <Note>
          No deadline is recorded for {scopeName}. That means none has been entered or found in a document, not that nothing is due.
        </Note>
      ) : rows.map((item) => (
        <Row key={item.deadline_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{item.item}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {entityLabel(entities, item.entity_slug)} · {item.due_date ? dateLabel(item.due_date) : "No date recorded"} · Whose it is: {partyLabel(item.owner_party)}
            </span>
            {(item.basis_note || item.waiting_on || item.basis_state === "proposed") && (
              <NextStep>
                {item.basis_note && `Rests on: ${item.basis_note}. `}
                {item.basis_state === "proposed" && "The brain proposed this date; nobody has confirmed it yet. "}
                {item.waiting_on && `Waiting on: ${waitingDetail(item.waiting_on) || "you"}.`}
              </NextStep>
            )}
          </span>
        </Row>
      ))}
    </Section>
  );
}

function ConflictSection({ snapshot, entities }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
}) {
  if (!("reconciliations" in snapshot)) return null;
  const rows = snapshot.reconciliations!.filter((item) => item.state === "mismatched");
  if (rows.length === 0) return null;
  return (
    <Section title="Sources that disagree" blurb="Both figures remain dated and visible. The brain does not pick a winner.">
      {rows.map((item) => (
        <Row key={item.reconciliation_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">
              {humanize(item.measure)} · {entityLabel(entities, item.entity_slug)}
            </span>
            <span className="block mt-1.5 space-y-1">
              {item.claims.map((claim) => (
                <span className="block text-[13px] text-ink-soft" key={claim.claim_uid}>
                  {claim.label}: {moneyLabel(claim.amount_minor, claim.currency) || "figure unavailable"} as of {dateLabel(claim.as_of) || "an unreadable date"}
                </span>
              ))}
            </span>
            <NextStep owner={item.ruled_claim_uid ? undefined : "yours"}>
              {item.ruled_claim_uid
                ? item.ruling_consumed
                  ? "Your ruling is recorded and marked as in use."
                  : "Your ruling is recorded beside both figures. Nothing uses it yet."
                : "Answers use neither figure until you rule."}
            </NextStep>
          </span>
          <Chip state={item.ruled_claim_uid ? "WORKING" : "NEEDS"} />
        </Row>
      ))}
    </Section>
  );
}

function CoverageSection({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
  scopeName: string;
}) {
  if (!("accounts" in snapshot)) return null;
  const rows = snapshot.accounts!;
  const coverage = accountCoverage(rows);
  return (
    <Section
      title="Where the records stand"
      blurb={coverage.total > 0
        ? `${coverage.current} of ${coverage.total} open ${coverage.total === 1 ? "account has" : "accounts have"} current or intentionally indirect coverage for ${scopeName}.`
        : `No open account is recorded for ${scopeName}.`}
    >
      {rows.length === 0 ? (
        <Note>
          No account is listed here. That is not proof that no account exists.
        </Note>
      ) : rows.map((account) => {
        const current = ["complete", "indirect", "not_applicable"].includes(account.coverage_status || "");
        return (
          <Row key={account.account_slug}>
            <span className="min-w-0 flex-1">
              <span className="text-[14.5px] font-medium">{account.label}</span>
              <span className="block text-[13px] text-ink-soft mt-0.5">
                {entityLabel(entities, account.entity_slug)} · {coverageLabel(account.coverage_status, account.status, account.covered_to)}
              </span>
              {account.coverage_note && <NextStep>{account.coverage_note}</NextStep>}
            </span>
            <Chip state={current ? "CURRENT" : account.coverage_status === "partial" ? "WORKING" : "NEEDS"} />
          </Row>
        );
      })}
    </Section>
  );
}

function CloseSection({ snapshot, scope }: { snapshot: FinSnapshot; scope: string | null }) {
  if (!("statements" in snapshot) || !("reconciliations" in snapshot)
    || !("unsorted_spending" in snapshot) || !("accounts" in snapshot)) return null;
  const statements = snapshot.statements!;
  const waiting = statements.filter((item) => item.parse_state === "received" || item.parse_state === "parsing");
  const unreadable = statements.filter((item) => item.parse_state === "unparsed");
  const conflicts = snapshot.reconciliations!.filter((item) => item.state === "mismatched");
  const unsorted = snapshot.unsorted_spending!.reduce((sum, item) => sum + item.counted_lines, 0);
  const unreadableLines = snapshot.unsorted_spending!.reduce((sum, item) => sum + item.unreadable_lines, 0);

  return (
    <Section title="Close evidence" blurb="Arrival, reading, matching, and owner acceptance are separate steps.">
      <Row>
        <span className="min-w-0">
          <span className="text-[14.5px]">Statements read</span>
          <span className="block text-[13px] text-ink-soft mt-0.5">
            {statements.length === 0
              ? "No statement period is recorded, so this step cannot be judged."
              : waiting.length || unreadable.length
                ? `${waiting.length} still being read and ${unreadable.length} unreadable.`
                : `${statements.length} recorded ${statements.length === 1 ? "statement is" : "statements are"} parsed.`}
          </span>
        </span>
        <Chip state={statements.length === 0 ? "NEEDS" : unreadable.length ? "PROBLEM" : waiting.length ? "WORKING" : "CURRENT"} />
      </Row>
      <Row>
        <span className="min-w-0">
          <span className="text-[14.5px]">Compared records agree</span>
          <span className="block text-[13px] text-ink-soft mt-0.5">
            {snapshot.reconciliations!.length === 0
              ? "No comparison is recorded, so agreement cannot be claimed."
              : conflicts.length
                ? `${conflicts.length} ${conflicts.length === 1 ? "comparison still disagrees" : "comparisons still disagree"}.`
                : "Every recorded comparison is settled."}
          </span>
        </span>
        <Chip state={snapshot.reconciliations!.length === 0 ? "NEEDS" : conflicts.length ? "NEEDS" : "CURRENT"} />
      </Row>
      <Row>
        <span className="min-w-0">
          <span className="text-[14.5px]">Spending sorted</span>
          <span className="block text-[13px] text-ink-soft mt-0.5">
            {unsorted === 0 && unreadableLines === 0
              ? "No uncategorized outflow is recorded in the accounts the brain could read."
              : `${unsorted} readable ${unsorted === 1 ? "line is" : "lines are"} still uncategorized. ${unreadableLines} ${unreadableLines === 1 ? "line could" : "lines could"} not be read.`}
          </span>
        </span>
        <Chip state={unreadableLines ? "PROBLEM" : unsorted ? "NEEDS" : "CURRENT"} />
      </Row>
      <OwnerPeriodClose scope={scope} statements={statements} />
    </Section>
  );
}

function ProfessionalSection({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: FinEntity[];
  scopeName: string;
}) {
  if (!("open_items" in snapshot)) return null;
  const rows = snapshot.open_items!;
  return (
    <Section title="For your professionals" blurb="Questions prepared with the evidence attached and the gaps still visible.">
      {rows.length === 0 ? (
        <Note>No question for a professional is recorded for {scopeName}.</Note>
      ) : rows.map((item) => (
        <Row key={item.code}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{item.question}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {entityLabel(entities, item.entity_slug)}
              {(item.routed_name || item.routed_role) && ` · For ${item.routed_name || item.routed_role}`}
              {item.due_date && ` · ${dateLabel(item.due_date) || "date unreadable"}`}
            </span>
            <NextStep owner={item.status === "answered" ? undefined : "yours"}>
              {item.citations.length} evidence {item.citations.length === 1 ? "reference is" : "references are"} attached.
              {item.not_included.length > 0 && ` ${item.not_included.length} known ${item.not_included.length === 1 ? "gap is" : "gaps are"} explicitly not included.`}
            </NextStep>
          </span>
          <Chip state={item.status === "answered" ? "FILED" : "NEEDS"} />
        </Row>
      ))}
    </Section>
  );
}

function coverageLabel(coverage: string | null, status: string, coveredTo: string | null) {
  if (status === "never_connected") return "never connected";
  if (coverage === "complete") return coveredTo
    ? `records current through ${dateLabel(coveredTo) || "an unreadable date"}`
    : "records assessed as complete, with no through date returned";
  if (coverage === "indirect") return "covered through another account's records";
  if (coverage === "partial") return coveredTo
    ? `partial records through ${dateLabel(coveredTo) || "an unreadable date"}`
    : "some records are present, but the period is incomplete";
  if (coverage === "missing") return "records are missing";
  if (coverage === "not_applicable") return "no records are expected here";
  if (coverage === "closed") return "closed account";
  return "coverage has not been assessed";
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function joinList(items: string[]): string {
  if (items.length < 2) return items[0] || "one section";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
