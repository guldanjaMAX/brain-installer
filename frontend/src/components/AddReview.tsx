import { useEffect, useState } from "react";
import {
  api, ownerError, type FinException, type FinReconciliation, type FinSnapshot, type OwnerWriteReceipt,
} from "../lib/api";
import {
  accountLabel, dateLabel, documentDetail, entityLabel, moneyLabel,
} from "../lib/finance";
import { Attention, Chip, NextStep, Note, Row, Section, TruthNote } from "./ui";
import { FinanceScopeBar, useFinanceScope } from "./FinanceScope";
import { OwnerUpload } from "./OwnerUpload";
import { useActionRequests } from "./useActionRequests";
import { confirmedOwnerWrite } from "../lib/owner";

const SECTIONS = ["accounts", "documents", "statements", "reconciliations", "exceptions", "unsorted_spending"];
const SECTION_LABELS: Record<string, string> = {
  accounts: "accounts",
  documents: "document records",
  statements: "statement processing",
  reconciliations: "record comparisons",
  exceptions: "open decisions",
  unsorted_spending: "uncategorized spending",
};

/** The owner review queue. It is intentionally read-only until an owner-session
 *  write contract exists. A disabled upload control would imply the path is
 *  nearly available; this page says what is true instead. */
export function AddReview() {
  const { scope, entities, activeLabel } = useFinanceScope();
  const [snapshot, setSnapshot] = useState<FinSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

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
      setError("The review queue could not be reached just now. Nothing here is being presented as cleared.");
      setLoaded(true);
    }).finally(() => {
      if (current) setBusy(false);
    });
    return () => { current = false; };
  }, [scope, revision]);

  const unavailable = snapshot?.sections_unavailable || [];

  return (
    <div aria-busy={busy}>
      <FinanceScopeBar />
      <header className="max-w-2xl">
        <p className="eyebrow">Intake and decisions</p>
        <h1 className="page-title">Add &amp; Review</h1>
        <p className="page-intro">
          See records that need a better copy, a human answer, or a decision before they can support a financial answer.
        </p>
      </header>

      <div className="mt-7 max-w-3xl"><OwnerUpload onStored={() => setRevision((value) => value + 1)} /></div>

      {!loaded && <p className="sr-only">Reading the review queue.</p>}
      {error && <div className="mt-5 max-w-3xl"><Attention>{error}</Attention></div>}

      {snapshot && !snapshot.ledger_installed && (
        <div className="mt-5 max-w-3xl">
          <TruthNote>
            No financial ledger is available yet. This is different from a review queue with nothing in it.
          </TruthNote>
        </div>
      )}

      {snapshot?.ledger_installed && unavailable.length > 0 && (
        <div className="mt-5 max-w-3xl">
          <Attention>
            This read could not reach {joinList(unavailable.map((name) => SECTION_LABELS[name] || "one section"))}. Those parts are omitted, not shown as cleared.
          </Attention>
        </div>
      )}

      {snapshot?.ledger_installed && (
        <div className="mt-7 grid gap-7 xl:grid-cols-2 xl:items-start">
          <div>
            <DocumentReview snapshot={snapshot} entities={entities} scopeName={activeLabel} />
            <StatementReview snapshot={snapshot} />
            <UnsortedReview snapshot={snapshot} />
          </div>
          <div>
            <ConflictReview snapshot={snapshot} entities={entities} scope={scope} onSaved={() => setRevision((value) => value + 1)} />
            <DecisionReview snapshot={snapshot} entities={entities} scope={scope} onSaved={() => setRevision((value) => value + 1)} />
            <AccountReview snapshot={snapshot} entities={entities} scopeName={activeLabel} />
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentReview({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: Parameters<typeof entityLabel>[0];
  scopeName: string;
}) {
  if (!("documents" in snapshot)) return null;
  const rows = snapshot.documents!.filter((document) => !document.readable || document.availability !== "have_it");
  return (
    <Section title="Needs a copy or a retake" blurb="Known records that are missing, held by someone else, or unreadable.">
      {rows.length === 0 ? (
        <Note>
          No document in the current register for {scopeName} is marked missing or unreadable. This does not prove the register includes every document that exists.
        </Note>
      ) : rows.map((document) => (
        <Row key={document.fin_doc_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{document.title}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {entityLabel(entities, document.entity_slug)}
              {document.tax_year && ` · ${document.tax_year}`}
            </span>
            <NextStep owner="yours">
              {documentDetail(document)}
            </NextStep>
          </span>
          <Chip state={document.readable ? "NEEDS" : "PROBLEM"} />
        </Row>
      ))}
    </Section>
  );
}

function StatementReview({ snapshot }: { snapshot: FinSnapshot }) {
  if (!("statements" in snapshot)) return null;
  const rows = snapshot.statements!.filter((statement) => statement.parse_state !== "parsed");
  return (
    <Section title="Being read" blurb="A statement arriving is not the same as its figures being read.">
      {rows.length === 0 ? (
        <Note>No received statement is currently recorded as waiting to be read.</Note>
      ) : rows.map((statement) => (
        <Row key={statement.statement_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">
              Statement ending {dateLabel(statement.period_end) || "on an unreadable date"}
            </span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {statement.parse_state === "received" && "Received, but not read yet."}
              {statement.parse_state === "parsing" && "The figures are being read now."}
              {statement.parse_state === "unparsed" && "The figures could not be read from this copy."}
            </span>
          </span>
          <Chip state={statement.parse_state === "unparsed" ? "PROBLEM" : "WORKING"} />
        </Row>
      ))}
    </Section>
  );
}

function ConflictReview({ snapshot, entities, scope, onSaved }: {
  snapshot: FinSnapshot;
  entities: Parameters<typeof entityLabel>[0];
  scope: string | null;
  onSaved: () => void;
}) {
  if (!("reconciliations" in snapshot)) return null;
  const rows = snapshot.reconciliations!.filter((item) => item.state === "mismatched");
  return (
    <Section title="Conflicting records" blurb="Both dated figures stay visible until the conflict is settled.">
      {rows.length === 0 ? (
        <Note>No mismatch was found among the records that were actually compared. Records that have not been compared are not included in that statement.</Note>
      ) : rows.map((item) => (
        <Row key={item.reconciliation_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">
              {humanize(item.measure)} · {entityLabel(entities, item.entity_slug)}
            </span>
            <span className="block mt-2 space-y-1">
              {item.claims.map((claim) => (
                <span key={claim.claim_uid} className="block text-[13px] text-ink-soft">
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
            {scope === item.entity_slug ? (
              <ReconciliationApproval item={item} scope={scope} onSaved={onSaved} />
            ) : (
              <NextStep>Select this business above to record a ruling.</NextStep>
            )}
          </span>
          <Chip state={item.ruled_claim_uid ? "WORKING" : "NEEDS"} />
        </Row>
      ))}
    </Section>
  );
}

function ReconciliationApproval({ item, scope, onSaved }: {
  item: FinReconciliation;
  scope: string;
  onSaved: () => void;
}) {
  const [claim, setClaim] = useState(item.ruled_claim_uid || item.claims[0]?.claim_uid || "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requests = useActionRequests("approval");

  async function save() {
    if (!claim || busy) return;
    const body = {
      entity_slug: scope,
      approval_type: "reconciliation_ruling",
      subject_uid: item.reconciliation_uid,
      selected_claim_uid: claim,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const actionKey = JSON.stringify(body);
    const id = requests.forAction(actionKey);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const receipt = await api<OwnerWriteReceipt>("/api/owner/approvals", {
        request_id: id,
        ...body,
      });
      if (!receipt.approval || !confirmedOwnerWrite(receipt, id, scope)) throw new Error("The ruling was not confirmed by an approval and activity receipt.");
      requests.confirmed(actionKey);
      setMessage(receipt.replayed ? "This exact ruling was already recorded." : "Ruling recorded beside both claims. It is not marked in use yet.");
      onSaved();
    } catch (next) {
      setError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 p-3 rounded-xl border border-line bg-paper/60">
      <label className="text-[12.5px] text-ink-soft">Record the claim you accept
        <select value={claim} onChange={(event) => setClaim(event.target.value)} className="field mt-1" disabled={busy}>
          {item.claims.map((row) => <option key={row.claim_uid} value={row.claim_uid}>{row.label}</option>)}
        </select>
      </label>
      <label className="block text-[12.5px] text-ink-soft mt-2">Note, optional
        <input value={note} onChange={(event) => setNote(event.target.value)} className="field mt-1" />
      </label>
      {error && <div className="mt-2"><Attention>{error}</Attention></div>}
      {message && <p className="mt-2 text-[12.5px] text-ink-soft">{message}</p>}
      <button onClick={save} disabled={busy || !claim} className="mt-2 rounded-lg bg-accent text-white px-3 py-2 text-[13px] disabled:opacity-50">{busy ? "Recording" : item.ruled_claim_uid ? "Record a new ruling" : "Record ruling"}</button>
    </div>
  );
}

function DecisionReview({ snapshot, entities, scope, onSaved }: {
  snapshot: FinSnapshot;
  entities: Parameters<typeof entityLabel>[0];
  scope: string | null;
  onSaved: () => void;
}) {
  if (!("exceptions" in snapshot)) return null;
  const rows = snapshot.exceptions!;
  return (
    <Section title="Open decisions" blurb="Resolve an exception without changing the source transaction behind it.">
      {rows.length === 0 ? (
        <Note>No open exception is recorded in this scope.</Note>
      ) : rows.map((item) => (
        <Row key={item.exception_uid}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{item.issue}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">{entityLabel(entities, item.entity_slug)}</span>
            {scope === item.entity_slug ? (
              <ExceptionApproval item={item} scope={scope} onSaved={onSaved} />
            ) : <NextStep>Select this business above to resolve the exception.</NextStep>}
          </span>
          <Chip state="NEEDS" />
        </Row>
      ))}
    </Section>
  );
}

function ExceptionApproval({ item, scope, onSaved }: {
  item: FinException;
  scope: string;
  onSaved: () => void;
}) {
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useActionRequests("approval");

  async function save() {
    if (!resolution.trim() || busy) return;
    const body = {
      entity_slug: scope,
      approval_type: "exception_resolution",
      subject_uid: item.exception_uid,
      resolution: resolution.trim(),
    };
    const actionKey = JSON.stringify(body);
    const id = requests.forAction(actionKey);
    setBusy(true);
    setError(null);
    try {
      const receipt = await api<OwnerWriteReceipt>("/api/owner/approvals", {
        request_id: id,
        ...body,
      });
      if (!receipt.approval || !confirmedOwnerWrite(receipt, id, scope)) throw new Error("The resolution was not confirmed by an approval and activity receipt.");
      requests.confirmed(actionKey);
      onSaved();
    } catch (next) {
      setError(ownerError(next).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 p-3 rounded-xl border border-line bg-paper/60">
      <label className="text-[12.5px] text-ink-soft">How this was resolved
        <textarea value={resolution} onChange={(event) => setResolution(event.target.value)} rows={2} className="field mt-1 resize-y" />
      </label>
      {error && <div className="mt-2"><Attention>{error}</Attention></div>}
      <button onClick={save} disabled={busy || !resolution.trim()} className="mt-2 rounded-lg bg-accent text-white px-3 py-2 text-[13px] disabled:opacity-50">{busy ? "Recording" : "Record resolution"}</button>
    </div>
  );
}

function AccountReview({ snapshot, entities, scopeName }: {
  snapshot: FinSnapshot;
  entities: Parameters<typeof entityLabel>[0];
  scopeName: string;
}) {
  if (!("accounts" in snapshot)) return null;
  const rows = snapshot.accounts!.filter((account) => account.status === "never_connected"
    || account.coverage_status === "missing"
    || account.coverage_status === "partial"
    || account.coverage_status === null);
  return (
    <Section title="Records still needed" blurb="Accounts whose coverage is missing, partial, or has never been assessed.">
      {rows.length === 0 ? (
        <Note>
          Every open account currently listed for {scopeName} has an assessed coverage state. That does not prove every account has been listed.
        </Note>
      ) : rows.map((account) => (
        <Row key={account.account_slug}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{account.label}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {entityLabel(entities, account.entity_slug)} · {coverageSentence(account.coverage_status, account.status)}
            </span>
            {account.coverage_note && <NextStep>{account.coverage_note}</NextStep>}
          </span>
          <Chip state={account.coverage_status === "partial" ? "WORKING" : "NEEDS"} />
        </Row>
      ))}
    </Section>
  );
}

function UnsortedReview({ snapshot }: { snapshot: FinSnapshot }) {
  if (!("unsorted_spending" in snapshot) || !("accounts" in snapshot)) return null;
  const rows = snapshot.unsorted_spending!.filter((item) => item.counted_lines > 0 || item.unreadable_lines > 0);
  return (
    <Section title="Spending not sorted" blurb="Only readable, posted outflows enter the amount. Unreadable lines stay counted separately.">
      {rows.length === 0 ? (
        <Note>No uncategorized outflow is recorded in the accounts the brain could read.</Note>
      ) : rows.map((item) => (
        <Row key={`${item.account_slug}:${item.currency}`}>
          <span className="min-w-0 flex-1">
            <span className="text-[14.5px] font-medium">{accountLabel(snapshot.accounts!, item.account_slug)}</span>
            <span className="block text-[13px] text-ink-soft mt-0.5">
              {moneyLabel(item.outflow_minor, item.currency) || "Amount unavailable"} across {item.counted_lines} readable {item.counted_lines === 1 ? "line" : "lines"}.
              {item.unreadable_lines > 0 && ` ${item.unreadable_lines} more ${item.unreadable_lines === 1 ? "line could" : "lines could"} not be read.`}
            </span>
          </span>
          <Chip state={item.unreadable_lines > 0 ? "PROBLEM" : "NEEDS"} />
        </Row>
      ))}
    </Section>
  );
}

function coverageSentence(coverage: string | null, status: string) {
  if (status === "never_connected") return "never connected";
  if (coverage === "partial") return "some records are present, but the period is incomplete";
  if (coverage === "missing") return "no usable records are loaded";
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
