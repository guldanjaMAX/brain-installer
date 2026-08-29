import { describe, expect, it } from "vitest";
import type { FinDeadline, FinEntity, FinSnapshot } from "./api";
import {
  accountCoverage, accountLabel, dateLabel, documentDetail, documentOutcome, entityLabel,
  financialRecordsEmpty, nextDatedDeadline, orderedScopes, visibleScopes, waitingDetail, waitingMove,
} from "./finance";
import { sourceOutcome, UNTRANSLATED_STATES } from "./outcome";
import { unavailableNotice } from "./retrieval-status.js";

const entity = (overrides: Partial<FinEntity>): FinEntity => ({
  entity_slug: "business", legal_name: "A Business", label: "A Business",
  kind: "business", status: "active", relationship: "owned",
  counterparty: false, fixed: false, ...overrides,
});

describe("financial scope", () => {
  it("keeps counterparties out and orders fixed and active scopes first", () => {
    const scopes = orderedScopes([
      entity({ entity_slug: "ended", label: "Ended", status: "sold" }),
      entity({ entity_slug: "active", label: "Active" }),
      entity({ entity_slug: "home", label: "Home", fixed: true }),
      entity({ entity_slug: "other", label: "Other party", counterparty: true }),
    ]);
    expect(scopes.map((row) => row.entity_slug)).toEqual(["home", "active", "ended"]);
  });

  it("search never hides fixed or currently active scope choices", () => {
    const scopes = visibleScopes([
      entity({ entity_slug: "home", label: "Home", fixed: true }),
      entity({ entity_slug: "cafe", label: "Cafe" }),
      entity({ entity_slug: "rental", label: "Rental" }),
    ], "cafe", "rental");
    expect(scopes.map((row) => row.entity_slug)).toEqual(["home", "cafe", "rental"]);
  });

  it("never prints an unknown entity slug", () => {
    expect(entityLabel([], "private-business-slug")).toBe("Another part of your finances");
  });
});

describe("This year truth boundaries", () => {
  it("chooses the soonest dated deadline and leaves undated work to the register", () => {
    const deadline = (id: string, due: string | null): FinDeadline => ({
      deadline_uid: id, entity_slug: null, item: id, due_date: due,
      owner_party: "owner", status: "open", urgency: "soon", consequence: null,
      waiting_on: null, basis_note: null, basis_state: "proposed",
    });
    expect(nextDatedDeadline([
      deadline("undated", null), deadline("later", "2026-10-01"), deadline("next", "2026-09-01"),
    ])?.deadline_uid).toBe("next");
  });

  it("calls only a complete successful empty read empty", () => {
    const base: FinSnapshot = {
      ledger_installed: true, missing_tables: [], unavailable: false, entity_scope: null,
      deadlines: [], exceptions: [], obligations: [],
      cash: {
        as_of: null, total_minor: null, currency: null, covered: [], missing: [], excluded: [],
        accounts_covered: 0, accounts_considered: 0, complete: false,
      },
    };
    expect(financialRecordsEmpty(base)).toBe(true);
    const { obligations: _omitted, ...partial } = base;
    expect(financialRecordsEmpty(partial)).toBe(false);
  });

  it("keeps zero cash and document-only ledgers distinct from empty", () => {
    const base: FinSnapshot = {
      ledger_installed: true, missing_tables: [], unavailable: false, entity_scope: null,
      accounts: [], documents: [], deadlines: [], exceptions: [], reconciliations: [], obligations: [],
      cash: {
        as_of: null, total_minor: null, currency: null, covered: [], missing: [], excluded: [],
        accounts_covered: 0, accounts_considered: 0, complete: false,
      },
    };
    const homeSections = [
      "accounts", "documents", "deadlines", "exceptions", "reconciliations", "obligations", "cash",
    ];
    expect(financialRecordsEmpty(base, homeSections)).toBe(true);
    expect(financialRecordsEmpty({ ...base, cash: { ...base.cash!, total_minor: 0, as_of: "2026-08-29", currency: "USD" } }, homeSections)).toBe(false);
    expect(financialRecordsEmpty({ ...base, documents: [{ title: "A real record" }] as never }, homeSections)).toBe(false);
    const { documents: _documents, ...partial } = base;
    expect(financialRecordsEmpty(partial, homeSections)).toBe(false);
  });

  it("rejects calendar dates that JavaScript would otherwise roll forward", () => {
    expect(dateLabel("2026-02-31")).toBeNull();
    expect(dateLabel("2026-02-28")).not.toBeNull();
  });
});

describe("owner-facing finance states", () => {
  it("keeps unavailable, empty, and populated collections distinguishable", () => {
    const base: FinSnapshot = {
      ledger_installed: true, missing_tables: [], unavailable: false, entity_scope: null,
    };
    expect("documents" in base).toBe(false);
    expect({ ...base, documents: [] }.documents).toEqual([]);
    expect({ ...base, documents: [{ title: "Statement" }] }.documents).toHaveLength(1);
  });

  it("does not call unassessed or missing account coverage current", () => {
    const account = (coverage_status: string | null, status = "active") => ({
      account_slug: String(coverage_status), entity_slug: "business", institution: null,
      label: "Checking", account_kind: "checking", balance_role: "asset", mask: null,
      currency: "USD", feed_mode: "statement", expected_cadence: null, status,
      coverage_status, covered_from: null, covered_to: null, coverage_note: null,
      coverage_computed_at: null, basis_state: "confirmed",
    });
    expect(accountCoverage([
      account("complete"), account("partial"), account("missing"), account(null), account("complete", "closed"),
    ])).toEqual({ total: 4, current: 1, partial: 1, missing: 1, unassessed: 1 });
  });

  it("derives document outcomes from custody facts and keeps human custodians visible", () => {
    const base = {
      fin_doc_uid: "doc", entity_slug: "business", account_slug: null,
      doc_kind: "bank_statement", title: "Statement", tax_year: 2026,
      period_start: null, period_end: null, custody_class: "reference",
      availability: "have_it", available_from: null, available_within_days: null,
      filed_at: "2026-08-01", reconciled_through: null, received_from: null,
      received_at: null, in_corpus: true, readable: true, unreadable_reason: null,
      restricted: false, basis_state: "confirmed",
    };
    expect(documentOutcome(base)).toBe("FILED");
    const waiting = { ...base, availability: "can_get_it", available_from: "your accountant", filed_at: null, in_corpus: false };
    expect(documentOutcome(waiting)).toBe("NEEDS");
    expect(documentDetail(waiting)).toContain("your accountant");
    expect(documentOutcome({ ...base, readable: false })).toBe("PROBLEM");
  });

  it("never prints an unknown account slug", () => {
    expect(accountLabel([], "private-account-slug")).toBe("Another account");
  });

  it("distinguishes a named custodian from a bare review disposition", () => {
    expect(waitingMove("you: identify the account")).toBe("yours");
    expect(waitingMove("Insurance broker: send the quote")).toBe("waiting");
    expect(waitingMove("review at next close")).toBeUndefined();
    expect(waitingDetail("you: identify the account")).toBe("identify the account");
    expect(waitingDetail("Insurance broker: send the quote")).toBe("Insurance broker: send the quote");
  });

  it("does not mistake a manual cadence for source health", () => {
    expect(sourceOutcome("manual")).toBeNull();
    expect(sourceOutcome("unscheduled")).toBeNull();
    expect(sourceOutcome("ok")).toBe("CURRENT");
    expect(sourceOutcome("indexing")).toBe("WORKING");
    expect(sourceOutcome("never_synced")).toBe("PROBLEM");
  });

  it("fails an unknown source state visibly and records the missing translation", () => {
    UNTRANSLATED_STATES.clear();
    expect(sourceOutcome("new_source_state")).toBe("PROBLEM");
    expect(UNTRANSLATED_STATES.has("source:new_source_state")).toBe(true);
  });

  it("keeps operator commands and internal state tokens out of owner search errors", () => {
    const notice = unavailableNotice("unknown_internal_mode");
    expect(notice).toContain("one part of search did not answer");
    expect(notice).not.toContain("brain health");
    expect(notice).not.toContain("unknown_internal_mode");
    expect(notice).not.toContain("`");
  });
});
