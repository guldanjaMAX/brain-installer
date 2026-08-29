// Every call carries X-Brain-App. It is the CSRF companion to the
// SameSite=Strict session cookie: the cookie proves who, this header proves
// the request came from this app rather than from a page that merely sits in
// the same browser.
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-App": "1" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  return data as T;
}

export type Citation = { n: number; title: string; source?: string; ts?: string | null };
export type Confidence = { percent: number; band: string; basis: string[] };
export type Answer = {
  answer: string | null;
  answer_error?: string;
  // Set when the search itself did not complete. Distinct from a genuine
  // no-match, and the difference decides what the page is allowed to say.
  status?: string;
  degraded?: string;
  notice?: string;
  results?: unknown[];
  confidence?: Confidence;
  citations?: Citation[];
};
export type Device = {
  credential_id: string;
  nickname: string | null;
  created_at: number;
  last_used_at: number | null;
};
/** One app holding a live grant. Rows are per app, not per token: a connector
 *  refreshes routinely and an owner is asking about apps. */
export type Connection = {
  client_id: string;
  name: string;
  can_write: boolean;
  connected_at: number | null;
  last_used_at: number | null;
};
/** A bank the owner linked. Timestamps here are ISO strings, not epoch ms. */
export type BankConnection = {
  item_ref: string;
  institution_label: string | null;
  status: string;
  status_detail?: string | null;
  connected_at?: string | null;
  last_synced_at?: string | null;
};
export type BankStatus = {
  configured?: boolean;
  connections?: BankConnection[];
  needs_attention?: BankConnection[];
};
/** One problem the installer owns. `fix_owner` is always "installer" today:
 *  every diagnose remedy is a CLI command the owner cannot run. */
export type Problem = {
  id: string; area: string; severity: "crit" | "warn";
  count: number; title: string; detail?: string; fix_owner: string;
};
export type SourceRow = {
  label: string; kind: string; state: string; documents: number;
  days_since_ingest: number | null; reason: string | null; automatable: boolean;
};
/** Keys are ABSENT when their read failed — never zero, never []. Anything
 *  optional here is optional because its absence is meaningful. */
export type SystemStatus = {
  accepting_documents: boolean | null;
  status: string | null;
  drain_mode: string | null;
  documents?: number;
  chunks?: number;
  problems?: Problem[];
  problem_counts?: { crit: number; warn: number; info: number };
  sources?: SourceRow[];
  vectors?: {
    ready: boolean; expected: number; visible: number;
    pending: number; percent_visible: number | null;
  };
  unavailable: string[];
};

export type Me = {
  signed_in: boolean;
  owner: string;
  brain: string;
  devices: Device[];
  connections: Connection[];
};

/** One financial scope. The slug is a transport identity only. Every visible
 *  surface uses `label`, and a missing label is handled without printing it. */
export type FinEntity = {
  entity_slug: string;
  legal_name: string;
  label: string;
  kind: string;
  status: string;
  relationship: string;
  counterparty: boolean;
  fixed: boolean;
};

export type FinAccount = {
  account_slug: string;
  entity_slug: string;
  institution: string | null;
  label: string;
  account_kind: string;
  balance_role: string;
  mask: string | null;
  currency: string;
  feed_mode: string;
  expected_cadence: string | null;
  status: string;
  coverage_status: string | null;
  covered_from: string | null;
  covered_to: string | null;
  coverage_note: string | null;
  coverage_computed_at: string | null;
  basis_state: string;
};

export type FinDocument = {
  fin_doc_uid: string;
  entity_slug: string | null;
  account_slug: string | null;
  doc_kind: string;
  title: string;
  tax_year: number | null;
  period_start: string | null;
  period_end: string | null;
  custody_class: string;
  availability: string;
  available_from: string | null;
  available_within_days: number | null;
  filed_at: string | null;
  reconciled_through: string | null;
  received_from: string | null;
  received_at: string | null;
  in_corpus: boolean;
  readable: boolean;
  unreadable_reason: string | null;
  restricted: boolean;
  basis_state: string;
};

export type FinStatement = {
  statement_uid: string;
  account_slug: string;
  period_start: string;
  period_end: string;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  currency: string;
  line_count_stated: number | null;
  parse_state: string;
  received_at: string | null;
  parsed_at: string | null;
  basis_state: string;
};

export type FinReconciliationClaim = {
  claim_uid: string;
  label: string;
  amount_minor: number | null;
  currency: string;
  as_of: string;
  basis_state: string;
};

export type FinReconciliation = {
  reconciliation_uid: string;
  entity_slug: string | null;
  account_slug: string | null;
  period_start: string | null;
  period_end: string | null;
  measure: string;
  state: string;
  delta_minor: number | null;
  tolerance_minor: number;
  currency: string;
  ruled_claim_uid: string | null;
  ruled_at: string | null;
  ruled_by_party: string | null;
  ruling_note: string | null;
  ruling_consumed: boolean;
  claims: FinReconciliationClaim[];
};

export type FinOpenItem = {
  code: string;
  entity_slug: string | null;
  question: string;
  routed_role: string | null;
  routed_name: string | null;
  status: string;
  due_date: string | null;
  citations: string[];
  not_included: string[];
  answer: string | null;
  answered_at: string | null;
  basis_state: string;
};

export type FinUnsortedSpending = {
  account_slug: string;
  currency: string;
  outflow_minor: number;
  counted_lines: number;
  unreadable_lines: number;
};

export type FinDeadline = {
  deadline_uid: string;
  entity_slug: string | null;
  item: string;
  due_date: string | null;
  owner_party: string;
  status: string;
  urgency: string;
  consequence: string | null;
  waiting_on: string | null;
  basis_note: string | null;
  basis_state: string;
};

export type FinException = {
  exception_uid: string;
  entity_slug: string | null;
  issue: string;
  detail: string | null;
  amount_minor: number | null;
  currency: string;
  first_seen: string;
  waiting_on: string | null;
  proposal: string | null;
  proposal_confidence_bp: number | null;
  basis_state: string;
};

export type FinObligation = {
  obligation_uid: string;
  entity_slug: string;
  kind: string;
  counterparty: string | null;
  label: string | null;
  balance_minor: number | null;
  balance_as_of: string | null;
  currency: string;
  renews_on: string | null;
  personal_guarantee: boolean;
  personal_guarantee_state: string;
};

export type FinCash = {
  as_of: string | null;
  total_minor: number | null;
  currency: string | null;
  mixed_currency?: boolean;
  covered: Array<{
    account_slug: string;
    label: string;
    amount_minor: number;
    currency: string;
    as_of: string;
  }>;
  missing: Array<{
    account_slug: string;
    reason: string;
    covered_to: string | null;
    last_confirmed_as_of: string | null;
  }>;
  excluded: Array<{
    account_slug: string;
    reason: string;
  }>;
  accounts_covered: number;
  accounts_considered: number;
  complete: boolean;
};

export type FinSnapshot = {
  ledger_installed: boolean;
  missing_tables: string[];
  unavailable: boolean;
  entity_scope: string | null;
  sections_returned?: string[];
  sections_unavailable?: string[];
  entities?: FinEntity[];
  accounts?: FinAccount[];
  documents?: FinDocument[];
  statements?: FinStatement[];
  deadlines?: FinDeadline[];
  exceptions?: FinException[];
  open_items?: FinOpenItem[];
  reconciliations?: FinReconciliation[];
  obligations?: FinObligation[];
  unsorted_spending?: FinUnsortedSpending[];
  obligation_exposure?: {
    balance_minor: number | null;
    currency: string | null;
    obligations_with_balance: number;
    obligations_total: number;
    guaranteed: number;
    guarantee_none_found: number;
    guarantee_not_examined: number;
    guarantee_unreadable: number;
    covers_all_obligations: boolean;
  };
  cash?: FinCash;
  truncated?: Record<string, boolean>;
};

export type FinDocumentsResponse = {
  ledger_installed: boolean;
  missing_tables: string[];
  unavailable: boolean;
  entity_scope: string | null;
  documents?: FinDocument[];
  truncated?: boolean;
};

/** GET companion to `api`. The bank feed answers status on GET; the same
 *  X-Brain-App header still marks the request as coming from this app. */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { "X-Brain-App": "1" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  return data as T;
}
