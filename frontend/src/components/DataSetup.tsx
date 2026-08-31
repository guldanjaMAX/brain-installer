import { useEffect, useMemo, useState } from "react";
import { api, type BankStatus, type FinSnapshot } from "../lib/api";
import { useFinanceScope } from "./FinanceScope";
import { Chip, Confirm, Empty, Note, Row, Section } from "./ui";

const PLAN_KEY = "financial-brain-expected-accounts-v1";
const ACCOUNT_TYPES = ["Checking", "Savings", "Credit card", "Loan", "Investment", "Other"] as const;
const METHODS = ["Bank export at setup", "Ongoing bank feed", "Statements only", "Decide later"] as const;

type PlannedAccount = {
  id: string;
  institution: string;
  nickname: string;
  lastFour: string;
  type: typeof ACCOUNT_TYPES[number];
  entity: string;
  method: typeof METHODS[number];
};

function readPlan(): PlannedAccount[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAN_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 100).flatMap((row, index) => {
      if (!row || typeof row !== "object") return [];
      const institution = String(row.institution || "").trim().slice(0, 80);
      const nickname = String(row.nickname || "").trim().slice(0, 80);
      if (!institution && !nickname) return [];
      return [{
        id: String(row.id || `planned-${index}`).slice(0, 100),
        institution,
        nickname,
        lastFour: /^\d{4}$/.test(String(row.lastFour || "")) ? String(row.lastFour) : "",
        type: ACCOUNT_TYPES.includes(row.type) ? row.type : "Other",
        entity: String(row.entity || "").slice(0, 100),
        method: METHODS.includes(row.method) ? row.method : "Decide later",
      } as PlannedAccount];
    });
  } catch {
    return [];
  }
}

export function DataSetup({ banks }: { banks: BankStatus | null }) {
  const { entities } = useFinanceScope();
  const owned = useMemo(() => entities.filter((entity) => !entity.counterparty), [entities]);
  const [plan, setPlan] = useState<PlannedAccount[]>(() => readPlan());
  const [adding, setAdding] = useState(false);
  const [snapshot, setSnapshot] = useState<FinSnapshot | null>(null);
  const [draft, setDraft] = useState<Omit<PlannedAccount, "id">>({
    institution: "", nickname: "", lastFour: "", type: "Checking", entity: "", method: "Decide later",
  });

  useEffect(() => {
    let current = true;
    api<FinSnapshot>("/api/fin/snapshot", { sections: ["accounts", "documents"] })
      .then((next) => { if (current) setSnapshot(next); })
      .catch(() => { if (current) setSnapshot(null); });
    return () => { current = false; };
  }, []);

  function save(next: PlannedAccount[]) {
    setPlan(next);
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(next));
    } catch {
      // The inventory is a device-local planning aid, never ledger truth.
    }
  }

  function add() {
    const institution = draft.institution.trim().slice(0, 80);
    const nickname = draft.nickname.trim().slice(0, 80);
    if (!institution || !nickname || !/^\d{4}$/.test(draft.lastFour)) return;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `planned-${Date.now()}`;
    save([...plan, { ...draft, id, institution, nickname }]);
    setDraft({ institution: "", nickname: "", lastFour: "", type: "Checking", entity: "", method: "Decide later" });
    setAdding(false);
  }

  const actualAccounts = snapshot?.accounts || [];
  const documents = snapshot?.documents || [];
  const bankConfigured = banks?.configured === true;
  const matched = plan.filter((planned) => actualAccounts.some((actual) =>
    planned.entity === actual.entity_slug
      && (!planned.lastFour || actual.mask === planned.lastFour)
      && actual.label.toLowerCase().includes(planned.nickname.toLowerCase()))).length;

  return (
    <div id="manage-data-setup" className="scroll-mt-24">
      <Section title="Set up your data" blurb="A checklist of what belongs in the Brain, what has arrived, and what still needs installer help.">
        <SetupRow
          title="Confirm your entities"
          detail={owned.length ? `${owned.length} owned ${owned.length === 1 ? "entity is" : "entities are"} recorded.` : "No owned entity is recorded yet."}
          state={owned.length ? "CURRENT" : "NEEDS"}
        />
        <SetupRow
          title="List every expected account"
          detail={plan.length ? `${plan.length} expected ${plan.length === 1 ? "account is" : "accounts are"} listed on this device. ${matched} match the current ledger.` : "List every bank, card, loan, and investment account before judging completeness."}
          state={plan.length ? (matched === plan.length ? "CURRENT" : "WORKING") : "NEEDS"}
        />
        <SetupRow
          title="Load documents and receipts"
          detail={documents.length ? `${documents.length} ${documents.length === 1 ? "document is" : "documents are"} recorded. A searchable statement is not automatically a ledger import.` : "No document is reported yet."}
          state={documents.length ? "CURRENT" : "WORKING"}
        />
        <SetupRow
          title="Connect ongoing bank feeds"
          detail={bankConfigured ? "A bank-feed service is configured. Confirm every individual account and entity assignment before relying on it." : "Bank feeds are not configured on this Brain. Structured OFX, QFX, or CSV imports remain an installer-assisted step."}
          state={bankConfigured ? "WORKING" : "NEEDS"}
        />
      </Section>

      <Section
        title="Expected accounts"
        blurb="This inventory is for completeness checking only. Use the last four digits, never a full account number or banking credential."
        action={
          <button type="button" onClick={() => setAdding(true)} className="text-[13.5px] text-accent font-medium">
            + Add account
          </button>
        }
      >
        <Note>Saved on this device. It does not connect a bank or load transactions.</Note>
        {adding && (
          <div className="p-4 grid gap-3 sm:grid-cols-2 border-b border-line">
            <Field label="Institution" value={draft.institution} onChange={(value) => setDraft({ ...draft, institution: value })} />
            <Field label="Account nickname" value={draft.nickname} onChange={(value) => setDraft({ ...draft, nickname: value })} />
            <Field label="Last four digits" value={draft.lastFour} onChange={(value) => setDraft({ ...draft, lastFour: value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" />
            <SelectField label="Account type" value={draft.type} values={ACCOUNT_TYPES} onChange={(value) => setDraft({ ...draft, type: value as PlannedAccount["type"] })} />
            <SelectField label="Entity" value={draft.entity} values={owned.map((entity) => entity.entity_slug)} labels={Object.fromEntries(owned.map((entity) => [entity.entity_slug, entity.label]))} onChange={(value) => setDraft({ ...draft, entity: value })} />
            <SelectField label="How records will arrive" value={draft.method} values={METHODS} onChange={(value) => setDraft({ ...draft, method: value as PlannedAccount["method"] })} />
            <div className="sm:col-span-2 flex gap-2">
              <button
                type="button"
                disabled={!draft.institution.trim() || !draft.nickname.trim() || !/^\d{4}$/.test(draft.lastFour) || !draft.entity}
                onClick={add}
                className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-45"
              >
                Save account
              </button>
              <button type="button" onClick={() => setAdding(false)} className="px-3 py-2 text-[13px] text-ink-soft">Cancel</button>
            </div>
          </div>
        )}
        {plan.length === 0 && !adding ? <Empty>No expected account is listed yet.</Empty> : plan.map((account) => (
          <Row key={account.id}>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-medium">{account.nickname} ending in {account.lastFour}</span>
              <span className="block text-[12.5px] text-ink-soft mt-0.5">
                {account.institution} · {account.type} · {owned.find((entity) => entity.entity_slug === account.entity)?.label || "Entity not available"} · {account.method}
              </span>
            </span>
            <Confirm label="Remove" question="Remove this expected account?" onConfirm={() => save(plan.filter((row) => row.id !== account.id))} />
          </Row>
        ))}
      </Section>
    </div>
  );
}

function SetupRow({ title, detail, state }: { title: string; detail: string; state: string }) {
  return (
    <Row>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium">{title}</span>
        <span className="block text-[12.5px] text-ink-soft mt-0.5">{detail}</span>
      </span>
      <Chip state={state} />
    </Row>
  );
}

function Field({ label, value, onChange, inputMode }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "numeric";
}) {
  return (
    <label className="text-[12.5px] text-ink-soft">
      {label}
      <input
        value={value}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-lg border border-line bg-card px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

function SelectField({ label, value, values, labels, onChange }: {
  label: string;
  value: string;
  values: readonly string[];
  labels?: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-[12.5px] text-ink-soft">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-lg border border-line bg-card px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
      >
        <option value="">Choose</option>
        {values.map((item) => <option key={item} value={item}>{labels?.[item] || item}</option>)}
      </select>
    </label>
  );
}
