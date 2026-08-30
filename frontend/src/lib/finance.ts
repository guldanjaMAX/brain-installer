import type {
  FinAccount, FinDeadline, FinDocument, FinEntity, FinSnapshot,
} from "./api";
import type { OutcomeKey } from "./outcome";
import { unmappedWords } from "./words";

const ENDED_STATUSES = new Set(["sold", "dissolved", "closed"]);

/** Counterparties are real ledger entities, but they are not one of the
 *  owner's scopes. Fixed scopes lead, then active scopes, then ended ones. */
export function orderedScopes(entities: FinEntity[]): FinEntity[] {
  return entities
    .filter((entity) => !entity.counterparty)
    .slice()
    .sort((a, b) => {
      const fixed = Number(b.fixed) - Number(a.fixed);
      if (fixed) return fixed;
      const ended = Number(ENDED_STATUSES.has(a.status)) - Number(ENDED_STATUSES.has(b.status));
      if (ended) return ended;
      return a.label.localeCompare(b.label);
    });
}

/** Searching changes which choices are visible, never which scope is active.
 *  Fixed choices and the active choice stay visible through the search. */
export function visibleScopes(
  entities: FinEntity[], query: string, active: string | null,
): FinEntity[] {
  const ordered = orderedScopes(entities);
  const q = query.trim().toLocaleLowerCase();
  if (!q) return ordered;
  return ordered.filter((entity) =>
    entity.fixed || entity.entity_slug === active || entity.label.toLocaleLowerCase().includes(q));
}

/** A transport identity is never owner-facing copy. Unknown identities are
 *  recorded for repair and described without printing the slug. */
export function entityLabel(entities: FinEntity[], slug: string | null | undefined): string {
  if (!slug) return "Shared";
  const entity = entities.find((candidate) => candidate.entity_slug === slug);
  if (entity) return entity.label;
  unmappedWords.add("entity:" + slug);
  return "Another part of your finances";
}

export function activeScopeLabel(entities: FinEntity[], slug: string | null): string {
  return slug ? entityLabel(entities, slug) : "everything";
}

/** Account identities are transport-only for the same reason entity identities
 *  are. A statement can outlive the account row it referred to, so unknown
 *  identities are expected and must still never reach visible copy. */
export function accountLabel(accounts: FinAccount[], slug: string | null | undefined): string {
  if (!slug) return "An account";
  const account = accounts.find((candidate) => candidate.account_slug === slug);
  if (account) return account.label;
  unmappedWords.add("account:" + slug);
  return "Another account";
}

export function accountCoverage(accounts: FinAccount[]) {
  const open = accounts.filter((account) => account.status !== "closed");
  const currentStates = new Set(["complete", "indirect", "not_applicable"]);
  return {
    total: open.length,
    current: open.filter((account) => currentStates.has(account.coverage_status || "")).length,
    partial: open.filter((account) => account.coverage_status === "partial").length,
    missing: open.filter((account) => account.coverage_status === "missing"
      || account.status === "never_connected").length,
    unassessed: open.filter((account) => account.coverage_status === null).length,
  };
}

/** The custody outcome is derived only from dated facts. A connector writing a
 *  document is not enough to call it filed or current. */
export function documentOutcome(document: FinDocument): OutcomeKey {
  if (!document.readable) return "PROBLEM";
  if (document.availability !== "have_it") return "NEEDS";
  if (document.custody_class === "reconcilable" && document.reconciled_through) return "CURRENT";
  if (document.in_corpus && document.filed_at) return "FILED";
  if (document.in_corpus) return "WORKING";
  return "NEEDS";
}

export function documentDetail(document: FinDocument): string {
  if (!document.readable) {
    return document.unreadable_reason
      ? `This copy could not be read: ${document.unreadable_reason}.`
      : "This copy could not be read.";
  }
  if (document.availability === "can_get_it") {
    const timing = document.available_within_days === null
      ? ""
      : `, usually within ${document.available_within_days} ${document.available_within_days === 1 ? "day" : "days"}`;
    return document.available_from
      ? `Available from ${document.available_from}${timing}.`
      : `Recorded as available on request${timing}.`;
  }
  if (document.availability === "do_not_have") return "This record is known about, but no copy is available.";
  if (!document.in_corpus) return "The record is listed, but its contents are not searchable.";
  if (document.custody_class === "reconcilable" && document.reconciled_through) {
    return `Matched against the books through ${dateLabel(document.reconciled_through) || "a date that could not be read"}.`;
  }
  if (document.filed_at) return `Stored and findable since ${dateLabel(document.filed_at) || "a date that could not be read"}.`;
  return "Stored and searchable. Its filing state has not been recorded.";
}

/** A hero needs a date. Urgent but undated work remains in the register below. */
export function nextDatedDeadline(deadlines: FinDeadline[]): FinDeadline | null {
  return deadlines
    .filter((deadline) => deadline.due_date)
    .slice()
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0] || null;
}

const RECORD_COLLECTIONS = [
  "accounts", "documents", "statements", "deadlines", "exceptions", "open_items",
  "reconciliations", "obligations", "unsorted_spending",
] as const;

/** Only a complete, successful read of every section the screen asked for may
 *  say the ledger is empty. An absent section is an unavailable read, never an
 *  empty one. A dated zero-dollar position is still a real financial record. */
export function financialRecordsEmpty(
  snapshot: FinSnapshot,
  requiredSections: readonly string[] = ["deadlines", "exceptions", "obligations", "cash"],
): boolean {
  for (const section of requiredSections) {
    if (section === "cash") {
      if (!snapshot.cash) return false;
    } else if (RECORD_COLLECTIONS.includes(section as typeof RECORD_COLLECTIONS[number])) {
      const rows = snapshot[section as typeof RECORD_COLLECTIONS[number]];
      if (!Array.isArray(rows)) return false;
    }
  }

  const hasRows = RECORD_COLLECTIONS.some((section) => {
    const rows = snapshot[section];
    return Array.isArray(rows) && rows.length > 0;
  });
  if (hasRows) return false;

  const cash = snapshot.cash;
  if (cash && (
    cash.total_minor !== null
    || cash.as_of !== null
    || cash.covered.length > 0
    || cash.missing.length > 0
    || cash.excluded.length > 0
  )) return false;

  const exposure = snapshot.obligation_exposure;
  if (exposure && (exposure.balance_minor !== null || exposure.obligations_total > 0)) return false;
  return true;
}

export function dateLabel(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime())
      || date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day) return null;
  const sameYear = year === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function moneyLabel(minor: number | null | undefined, currency: string | null | undefined) {
  if (!Number.isInteger(minor) || !currency) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2,
    }).format(Number(minor) / 100);
  } catch {
    return null;
  }
}

export function partyLabel(party: string | null | undefined): string {
  if (!party) return "not recorded";
  return /^(owner|you)$/i.test(party.trim()) ? "you" : party;
}

export function waitingMove(waitingOn: string | null | undefined): "yours" | "waiting" | undefined {
  if (!waitingOn) return undefined;
  const value = waitingOn.trim();
  if (/^(owner|you)(?::|$)/i.test(value)) return "yours";
  // A colon names a human or organization holding the next move. A bare value
  // is a disposition such as "review at next close", not a custodian.
  return /^[^:]+:/.test(value) ? "waiting" : undefined;
}

/** When the state label already says "Your move", do not repeat a transport
 *  convention such as "you:" in the human instruction beside it. */
export function waitingDetail(waitingOn: string | null | undefined): string | null {
  if (!waitingOn) return null;
  const value = waitingOn.trim();
  if (waitingMove(value) !== "yours") return value || null;
  return value.replace(/^(owner|you)(?:\s*:\s*)?/i, "").trim() || null;
}
