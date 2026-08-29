import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");
const PORT = Number(process.env.BRAIN_VISUAL_PORT || 4177);

const entities = [
  { entity_slug: "household", legal_name: "Rivera Household", label: "Household", kind: "household", status: "active", relationship: "owned", counterparty: false, fixed: true },
  { entity_slug: "mesa-coffee", legal_name: "Mesa Coffee LLC", label: "Mesa Coffee", kind: "business", status: "active", relationship: "owned", counterparty: false, fixed: false },
  { entity_slug: "juniper-rentals", legal_name: "Juniper Rentals LLC", label: "Juniper Rentals", kind: "business", status: "active", relationship: "owned", counterparty: false, fixed: false },
  { entity_slug: "counterparty", legal_name: "Fixture Buyer", label: "Fixture Buyer", kind: "business", status: "active", relationship: "counterparty", counterparty: true, fixed: false },
];

const accounts = [
  { account_slug: "household-checking", entity_slug: "household", institution: "Desert Bank", label: "Joint checking", account_kind: "checking", balance_role: "asset", mask: "1044", currency: "USD", feed_mode: "statement", expected_cadence: "monthly", status: "active", coverage_status: "complete", covered_from: "2026-01-01", covered_to: "2026-07-31", coverage_note: "July statement was read and matched.", coverage_computed_at: "2026-08-02", basis_state: "confirmed" },
  { account_slug: "cafe-checking", entity_slug: "mesa-coffee", institution: "Desert Bank", label: "Operating checking", account_kind: "checking", balance_role: "asset", mask: "2281", currency: "USD", feed_mode: "statement", expected_cadence: "monthly", status: "active", coverage_status: "partial", covered_from: "2026-01-01", covered_to: "2026-06-30", coverage_note: "The July statement is present, but 3 lines could not be read.", coverage_computed_at: "2026-08-02", basis_state: "confirmed" },
  { account_slug: "rental-checking", entity_slug: "juniper-rentals", institution: null, label: "Rental checking", account_kind: "checking", balance_role: "asset", mask: null, currency: "USD", feed_mode: "statement", expected_cadence: "monthly", status: "never_connected", coverage_status: "missing", covered_from: null, covered_to: null, coverage_note: "The property manager keeps these statements.", coverage_computed_at: "2026-08-02", basis_state: "owner_stated" },
];

const documents = [
  { fin_doc_uid: "tax-return", entity_slug: "household", account_slug: null, doc_kind: "tax_return", title: "2025 federal tax return", tax_year: 2025, period_start: "2025-01-01", period_end: "2025-12-31", custody_class: "reference", availability: "have_it", available_from: null, available_within_days: null, filed_at: "2026-04-10", reconciled_through: null, received_from: "your accountant", received_at: "2026-04-10", in_corpus: true, readable: true, unreadable_reason: null, restricted: true, basis_state: "confirmed" },
  { fin_doc_uid: "cafe-july", entity_slug: "mesa-coffee", account_slug: "cafe-checking", doc_kind: "bank_statement", title: "Mesa Coffee checking, July 2026", tax_year: 2026, period_start: "2026-07-01", period_end: "2026-07-31", custody_class: "reconcilable", availability: "have_it", available_from: null, available_within_days: null, filed_at: "2026-08-02", reconciled_through: "2026-07-31", received_from: "you", received_at: "2026-08-02", in_corpus: true, readable: true, unreadable_reason: null, restricted: false, basis_state: "confirmed" },
  { fin_doc_uid: "cafe-scan", entity_slug: "mesa-coffee", account_slug: "cafe-checking", doc_kind: "receipt", title: "Equipment receipt photo", tax_year: 2026, period_start: null, period_end: "2026-07-22", custody_class: "reference", availability: "have_it", available_from: null, available_within_days: null, filed_at: null, reconciled_through: null, received_from: "you", received_at: "2026-08-02", in_corpus: false, readable: false, unreadable_reason: "the photo is too blurry", restricted: false, basis_state: "unparsed" },
  { fin_doc_uid: "rental-policy", entity_slug: "juniper-rentals", account_slug: null, doc_kind: "insurance_policy", title: "Rental property insurance policy", tax_year: 2026, period_start: null, period_end: null, custody_class: "reference", availability: "can_get_it", available_from: "your insurance broker", available_within_days: 2, filed_at: null, reconciled_through: null, received_from: null, received_at: null, in_corpus: false, readable: true, unreadable_reason: null, restricted: false, basis_state: "owner_stated" },
];

const deadlines = [
  { deadline_uid: "sales-tax", entity_slug: "mesa-coffee", item: "File July sales tax", due_date: "2026-09-15", owner_party: "you", status: "open", urgency: "asap", consequence: "A late filing can create a penalty.", waiting_on: null, basis_note: "State filing calendar", basis_state: "confirmed" },
  { deadline_uid: "policy-renewal", entity_slug: "juniper-rentals", item: "Review property policy renewal", due_date: "2026-10-01", owner_party: "you", status: "open", urgency: "dated", consequence: null, waiting_on: "Insurance broker: renewal quote", basis_note: "The brain proposed this from the prior policy term", basis_state: "proposed" },
];

const exceptions = [
  { exception_uid: "transfer", entity_slug: "mesa-coffee", issue: "Transfer has no matching destination", detail: null, amount_minor: 294000, currency: "USD", first_seen: "2026-08-03", waiting_on: "you: identify the destination account", proposal: "This may be an owner distribution", proposal_confidence_bp: 6200, basis_state: "proposed" },
  { exception_uid: "quote", entity_slug: "juniper-rentals", issue: "Renewal quote is still missing", detail: null, amount_minor: null, currency: "USD", first_seen: "2026-08-10", waiting_on: "Insurance broker: send the quote", proposal: null, proposal_confidence_bp: null, basis_state: "confirmed" },
];

const obligations = [
  { obligation_uid: "lease", entity_slug: "mesa-coffee", kind: "lease", counterparty: "Fixture Landlord", label: "Cafe lease", balance_minor: null, balance_as_of: null, currency: "USD", renews_on: "2027-02-01", personal_guarantee: true, personal_guarantee_state: "confirmed" },
  { obligation_uid: "loan", entity_slug: "juniper-rentals", kind: "loan", counterparty: "Desert Bank", label: "Property loan", balance_minor: 18420000, balance_as_of: "2026-07-31", currency: "USD", renews_on: null, personal_guarantee: false, personal_guarantee_state: "not_examined" },
];

const statements = [
  { statement_uid: "household-july", account_slug: "household-checking", period_start: "2026-07-01", period_end: "2026-07-31", opening_balance_minor: 7900000, closing_balance_minor: 8421000, currency: "USD", line_count_stated: 37, parse_state: "parsed", received_at: "2026-08-02", parsed_at: "2026-08-02", basis_state: "confirmed" },
  { statement_uid: "cafe-july", account_slug: "cafe-checking", period_start: "2026-07-01", period_end: "2026-07-31", opening_balance_minor: null, closing_balance_minor: null, currency: "USD", line_count_stated: 52, parse_state: "unparsed", received_at: "2026-08-02", parsed_at: null, basis_state: "unparsed" },
];

const reconciliations = [
  { reconciliation_uid: "sales-conflict", entity_slug: "mesa-coffee", account_slug: "cafe-checking", period_start: "2026-07-01", period_end: "2026-07-31", measure: "july_sales", state: "mismatched", delta_minor: 41000, tolerance_minor: 0, currency: "USD", ruled_claim_uid: null, ruled_at: null, ruled_by_party: null, ruling_note: null, ruling_consumed: false, claims: [
    { claim_uid: "books", label: "Books", amount_minor: 2630000, currency: "USD", as_of: "2026-07-31", basis_state: "confirmed" },
    { claim_uid: "processor", label: "Processor report", amount_minor: 2589000, currency: "USD", as_of: "2026-07-31", basis_state: "confirmed" },
  ] },
];

const openItems = [
  { code: "tax-question", entity_slug: "mesa-coffee", question: "Should the new oven be expensed or capitalized?", routed_role: "tax professional", routed_name: "your CPA", status: "draft", due_date: "2026-09-10", citations: ["receipt", "policy"], not_included: ["installation invoice"], answer: null, answered_at: null, basis_state: "confirmed" },
];

const unsorted = [
  { account_slug: "cafe-checking", currency: "USD", outflow_minor: 294000, counted_lines: 3, unreadable_lines: 2 },
];

const cash = {
  as_of: "2026-07-31", total_minor: 10911000, currency: "USD", mixed_currency: false,
  covered: [
    { account_slug: "household-checking", label: "Joint checking", amount_minor: 8421000, currency: "USD", as_of: "2026-07-31" },
    { account_slug: "cafe-checking", label: "Operating checking", amount_minor: 2490000, currency: "USD", as_of: "2026-07-31" },
  ],
  missing: [{ account_slug: "rental-checking", reason: "never_connected", covered_to: null, last_confirmed_as_of: null }],
  excluded: [], accounts_covered: 2, accounts_considered: 3, complete: false,
};

const systemStatus = {
  accepting_documents: true,
  status: "active",
  drain_mode: "cron",
  documents: 241,
  chunks: 2180,
  problems: [{ id: "source-stale", area: "sources", severity: "warn", count: 1, title: "Email has not refreshed", detail: "The last successful read was 12 days ago.", fix_owner: "installer" }],
  problem_counts: { crit: 0, warn: 1, info: 0 },
  sources: [
    { label: "Google Drive", kind: "drive", state: "ok", documents: 202, days_since_ingest: 0, reason: null, automatable: true },
    { label: "Email", kind: "gmail", state: "stale", documents: 39, days_since_ingest: 12, reason: "The connection needs attention.", automatable: false },
  ],
  vectors: { ready: true, expected: 2180, visible: 2180, pending: 0, percent_visible: 100 },
  unavailable: [],
};

function scenarioFor(request) {
  try {
    return new URL(request.headers.referer || `http://127.0.0.1:${PORT}/`).searchParams.get("state") || "populated";
  } catch {
    return "populated";
  }
}

function filterRows(rows, entitySlug) {
  return entitySlug ? rows.filter((row) => row.entity_slug === entitySlug) : rows;
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function emptyCash() {
  return { as_of: null, total_minor: null, currency: null, covered: [], missing: [], excluded: [], accounts_covered: 0, accounts_considered: 0, complete: false };
}

function snapshotFor(sections, entitySlug, scenario) {
  const empty = scenario === "empty";
  const unavailable = scenario === "degraded"
    ? new Set(["obligations", "cash", "reconciliations"])
    : scenario === "partial"
      ? new Set(["obligations"])
      : new Set();
  const values = {
    entities,
    accounts: empty ? [] : filterRows(accounts, entitySlug),
    documents: empty ? [] : filterRows(documents, entitySlug),
    deadlines: empty ? [] : filterRows(deadlines, entitySlug),
    exceptions: empty ? [] : filterRows(exceptions, entitySlug),
    obligations: empty ? [] : filterRows(obligations, entitySlug),
    statements: empty ? [] : statements.filter((row) => !entitySlug || accounts.some((account) => account.account_slug === row.account_slug && account.entity_slug === entitySlug)),
    reconciliations: empty ? [] : filterRows(reconciliations, entitySlug),
    open_items: empty ? [] : filterRows(openItems, entitySlug),
    unsorted_spending: empty ? [] : unsorted.filter((row) => !entitySlug || accounts.some((account) => account.account_slug === row.account_slug && account.entity_slug === entitySlug)),
    cash: empty ? emptyCash() : entitySlug === "household"
      ? { ...cash, total_minor: 8421000, covered: cash.covered.slice(0, 1), missing: [], accounts_covered: 1, accounts_considered: 1, complete: true }
      : entitySlug === "mesa-coffee"
        ? { ...cash, total_minor: 2490000, covered: cash.covered.slice(1), missing: [], accounts_covered: 1, accounts_considered: 1, complete: true }
        : entitySlug === "juniper-rentals"
          ? { ...emptyCash(), missing: cash.missing, accounts_considered: 1 }
          : cash,
  };
  const result = { ledger_installed: true, missing_tables: [], unavailable: unavailable.size > 0, entity_scope: entitySlug || null };
  const returned = [];
  for (const section of sections) {
    if (unavailable.has(section)) continue;
    result[section] = values[section];
    returned.push(section);
    if (section === "obligations") {
      result.obligation_exposure = empty
        ? { balance_minor: null, currency: null, obligations_with_balance: 0, obligations_total: 0, guaranteed: 0, guarantee_none_found: 0, guarantee_not_examined: 0, guarantee_unreadable: 0, covers_all_obligations: true }
        : { balance_minor: 18420000, currency: "USD", obligations_with_balance: 1, obligations_total: values.obligations.length, guaranteed: values.obligations.filter((row) => row.personal_guarantee).length, guarantee_none_found: 0, guarantee_not_examined: values.obligations.filter((row) => row.personal_guarantee_state === "not_examined").length, guarantee_unreadable: 0, covers_all_obligations: true };
    }
  }
  result.sections_returned = returned;
  result.sections_unavailable = [...unavailable].filter((name) => sections.includes(name));
  result.truncated = {};
  return result;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);
  const scenario = scenarioFor(request);
  if (scenario === "loading" && url.pathname.startsWith("/api/")) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }

  if (url.pathname === "/api/app/me") {
    return sendJson(response, {
      signed_in: true, owner: "Owner", brain: "Financial Brain",
      devices: [{ credential_id: "device", nickname: "Primary device", created_at: Date.now() - 86400000 * 20, last_used_at: Date.now() - 60000 }],
      connections: [{ client_id: "app", name: "Claude", can_write: false, connected_at: Date.now() - 86400000 * 4, last_used_at: Date.now() - 3600000 }],
    });
  }
  if (url.pathname === "/api/app/system") {
    if (scenario === "degraded") return sendJson(response, { ...systemStatus, documents: undefined, problems: undefined, sources: undefined, unavailable: ["diagnose", "sources"] });
    if (scenario === "empty") return sendJson(response, { ...systemStatus, documents: 0, chunks: 0, problems: [], problem_counts: { crit: 0, warn: 0, info: 0 }, sources: [], vectors: { ready: true, expected: 0, visible: 0, pending: 0, percent_visible: null } });
    return sendJson(response, systemStatus);
  }
  if (url.pathname === "/api/fin/snapshot") {
    const body = await jsonBody(request);
    return sendJson(response, snapshotFor(Array.isArray(body.sections) ? body.sections : Object.keys({ entities, accounts, documents, deadlines, exceptions, obligations, statements, reconciliations, open_items: 1, unsorted_spending: 1, cash: 1 }), body.entity_slug || null, scenario));
  }
  if (url.pathname === "/api/fin/documents") {
    const body = await jsonBody(request);
    if (scenario === "degraded") return sendJson(response, { unavailable: true, error: "could not read this brain's financial records" }, 503);
    return sendJson(response, { ledger_installed: true, missing_tables: [], unavailable: false, entity_scope: body.entity_slug || null, documents: scenario === "empty" ? [] : filterRows(documents, body.entity_slug || null), truncated: false });
  }
  if (url.pathname === "/api/bank-feed/status") {
    return sendJson(response, { configured: true, connections: [{ item_ref: "bank", institution_label: "Desert Bank", status: "healthy", connected_at: "2026-07-01T00:00:00Z", last_synced_at: "2026-08-29T06:00:00Z" }], needs_attention: [] });
  }
  if (url.pathname === "/api/rag/unified") {
    return sendJson(response, scenario === "degraded"
      ? { status: "unavailable", degraded: "vector" }
      : { results: scenario === "empty" ? [] : [{ doc_uid: "doc", chunk_uid: "chunk", title: "Mesa Coffee checking, July 2026", snippet: "The closing balance was supported by the July statement.", source: "drive", ts: "2026-07-31", date_reliable: true }] });
  }
  if (url.pathname === "/api/rag/think") {
    return sendJson(response, scenario === "degraded"
      ? { answer: null, answer_error: "search unavailable", status: "unavailable", degraded: "vector" }
      : { answer: "Mesa Coffee has one confirmed cash figure as of July 31. [1] The rental account is not included because no confirmed figure is recorded.", confidence: { percent: 86, band: "high", basis: ["One dated statement supports the figure", "One known account is explicitly missing"] }, citations: [{ n: 1, title: "Mesa Coffee checking, July 2026", source: "drive", ts: "2026-07-31" }] });
  }

  const requested = url.pathname === "/" || url.pathname === "/app" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = join(DIST, requested);
  try {
    const bytes = readFileSync(file);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Financial Brain visual server listening on http://127.0.0.1:${PORT}`);
});
