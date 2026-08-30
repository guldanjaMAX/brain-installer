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

const supportSystemStatus = {
  status: "ready",
  observed_at: Date.now(),
  unavailable: [],
  access: {
    kind: "support",
    technician_label: "Support technician",
    expires_at: Date.now() + 60 * 60_000,
    remaining_seconds: 3600,
    read_only: true,
    can_fix: false,
  },
  privacy: {
    mode: "aggregate_only",
    content_visible: false,
    search_available: false,
    raw_errors_visible: false,
    credentials_visible: false,
    account_identifiers_visible: false,
  },
  brain: {
    product_version: "0.2.0",
    schema_version: 23,
    status: "ok",
    accepting_documents: true,
    drain_mode: "active",
  },
  corpus: { documents: 241, chunks: 2180 },
  vectors: { ready: true, expected: 2180, visible: 2180, pending: 0, percent_visible: 100 },
  problem_counts: { crit: 0, warn: 1, info: 0 },
  problems: [{ code: "source_registration_issue", area: "coverage", severity: "warn", count: 1, repairability: "guidance_only" }],
  sources: [
    { label: "Google Drive", kind: "drive", state: "ok", documents: 202, days_since_ingest: 0, automatable: true },
    { label: "Email", kind: "email", state: "stale", documents: 39, days_since_ingest: 12, automatable: false },
  ],
};

const ownerActivity = [
  { event_id: "event-support", event_type: "support_access_created", entity_slug: null, subject_kind: "support_access", subject_id: "support", display_label: "Support technician", occurred_at: "2026-08-30T06:30:00Z" },
  { event_id: "event-access", event_type: "document_grant_created", entity_slug: "mesa-coffee", subject_kind: "document_grant", subject_id: "grant", display_label: "External reviewer document access", occurred_at: "2026-08-29T17:00:00Z" },
  { event_id: "event-target", event_type: "target_set", entity_slug: "mesa-coffee", subject_kind: "target", subject_id: "monthly-revenue", display_label: "Monthly revenue target", occurred_at: "2026-08-29T16:00:00Z" },
  { event_id: "event-upload", event_type: "upload_completed", entity_slug: "mesa-coffee", subject_kind: "document", subject_id: "document", display_label: "July close notes", occurred_at: "2026-08-28T12:00:00Z" },
  { event_id: "event-close", event_type: "period_close_accepted", entity_slug: "household", subject_kind: "period_close", subject_id: "close", display_label: "July 2026 close", occurred_at: "2026-08-27T12:00:00Z" },
];

const ownerTargets = [
  { target_id: "monthly-revenue", entity_slug: "mesa-coffee", label: "Monthly revenue", metric: "revenue", target_minor: 2630000, currency: "USD", period_start: "2026-08-01", period_end: "2026-08-31", note: "Owner-set for August", status: "active", created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-29T16:00:00Z", archived_at: null },
];

const ownerPreferences = [
  { entity_slug: null, preference_key: "activity_window_days", value: 30, updated_at: "2026-08-29T16:00:00Z" },
];

const ownerPeriodCloses = [
  { period_close_id: "close-july", entity_slug: "mesa-coffee", period_start: "2026-07-01", period_end: "2026-07-31", status: "accepted", evidence_state: "owner_acknowledged_incomplete", acknowledged_incomplete: true, note: "Accepted while two lines remained unreadable.", accepted_at: "2026-08-20T00:00:00Z", reopened_at: null, updated_at: "2026-08-20T00:00:00Z" },
];

const uploadCapabilities = {
  supported_media_types: [
    "text/plain", "text/markdown", "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel", "message/rfc822", "image/png", "image/jpeg",
  ],
  text_media_types: ["text/plain", "text/markdown"],
  binary_media_types: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel", "message/rfc822", "image/png", "image/jpeg",
  ],
  supported_extensions: [
    ".txt", ".md", ".markdown", ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".eml", ".png", ".jpg", ".jpeg",
  ],
  media_type_extensions: {
    "text/plain": [".txt"],
    "text/markdown": [".md", ".markdown"],
    "application/pdf": [".pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.ms-excel": [".xls"],
    "message/rfc822": [".eml"],
    "image/png": [".png"],
    "image/jpeg": [".jpg", ".jpeg"],
  },
  max_content_bytes: 1000000,
  max_binary_bytes: 8 * 1024 * 1024,
  max_ocr_image_bytes: 3_000_000,
  media_type_max_bytes: {
    "text/plain": 1_000_000,
    "text/markdown": 1_000_000,
    "application/pdf": 8 * 1024 * 1024,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 8 * 1024 * 1024,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": 8 * 1024 * 1024,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 8 * 1024 * 1024,
    "application/vnd.ms-excel": 8 * 1024 * 1024,
    "message/rfc822": 8 * 1024 * 1024,
    "image/png": 3_000_000,
    "image/jpeg": 3_000_000,
  },
  content_encoding: "utf-8",
  empty_media_type_supported: false,
  normalization: "text is decoded as strict UTF-8; documents use bounded native extraction; PNG and JPEG use private OCR",
  scanned_pdf_ocr_supported: false,
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
    if (scenario === "grant-forbidden" || scenario === "grant-empty") {
      return sendJson(response, { error: "forbidden", code: scenario === "grant-empty" ? "document_grant_empty" : "document_grant_inactive", signed_in: false, clear_session: true, recovery: "Ask the owner to create new document access and send a new enrollment link." }, 403);
    }
    if (scenario.startsWith("grant")) {
      return sendJson(response, {
        signed_in: true,
        brain: "Financial Brain",
        principal: { kind: "grant", grant_id: "dg_fixture", entity_slug: "mesa-coffee", document_count: 2, capabilities: ["documents:read", "ask"] },
        workspace: { home: false, documents: true, ask: true, add_review: false, access: false, bank: false, targets: false, preferences: false },
      });
    }
    return sendJson(response, {
      signed_in: true, owner: "Owner", brain: "Financial Brain",
      principal: { kind: "owner", grant_id: null },
      devices: [{ credential_id: "device", nickname: "Primary device", created_at: Date.now() - 86400000 * 20, last_used_at: Date.now() - 60000 }],
      connections: [{ client_id: "app", name: "Claude", can_write: false, connected_at: Date.now() - 86400000 * 4, last_used_at: Date.now() - 3600000 }],
    });
  }
  if (url.pathname === "/api/support/me") {
    if (scenario !== "support") return sendJson(response, { error: "unauthorized", code: "support_session_required" }, 401);
    return sendJson(response, {
      signed_in: true,
      principal: {
        kind: "support",
        support_session_id: "ss_fixture",
        technician_label: "Support technician",
        technician_identity_verified: false,
        expires_at: supportSystemStatus.access.expires_at,
        idle_expires_at: Date.now() + 15 * 60_000,
        read_only: true,
      },
      workspace: {
        support: true, home: false, documents: false, ask: false, add_review: false,
        access: false, bank: false, targets: false, preferences: false, connections: false,
      },
      can_fix: false,
      repair_mode: "owner_approval_required_future",
    });
  }
  if (url.pathname === "/api/support/system") {
    if (scenario !== "support") return sendJson(response, { error: "unauthorized", code: "support_session_required" }, 401);
    return sendJson(response, supportSystemStatus);
  }
  if (url.pathname === "/api/support/signout") return sendJson(response, { signed_out: true });
  if (url.pathname === "/api/app/support-access/status") {
    return sendJson(response, {
      status: "ready",
      sessions: scenario === "empty" ? [] : [{
        support_session_id: "ss_fixture",
        technician_label: "Support technician",
        state: "active",
        created_at: Date.now() - 45 * 60_000,
        invite_state: "consumed",
        enrollment_expires_at: Date.now() - 35 * 60_000,
        activated_at: Date.now() - 30 * 60_000,
        expires_at: Date.now() + 30 * 60_000,
        idle_expires_at: Date.now() + 15 * 60_000,
        last_used_at: Date.now() - 60_000,
        revoked_at: null,
      }],
      policy: {
        access: "read_only_diagnostics",
        duration_choices_minutes: [15, 30, 60, 120],
        default_duration_minutes: 30,
        max_duration_minutes: 120,
        enrollment_link_max_minutes: 10,
        can_fix: false,
        repair_mode: "owner_approval_required_future",
      },
    });
  }
  if (url.pathname === "/api/app/support-access/create" || url.pathname === "/api/app/support-access/reissue") {
    const body = await jsonBody(request);
    return sendJson(response, {
      status: "pending",
      support_session_id: body.support_session_id || "ss_created",
      technician_label: body.technician_label || "Support technician",
      activated_at: null,
      expires_at: null,
      idle_expires_at: null,
      changed: true,
      replayed: scenario === "idempotent",
      request_id: body.request_id,
      invite_state: "active",
      enrollment_url: "http://127.0.0.1/app#support-enroll=fixture-private",
      enrollment_expires_at: Date.now() + 10 * 60_000,
    });
  }
  if (url.pathname === "/api/app/support-access/revoke") {
    const body = await jsonBody(request);
    return sendJson(response, {
      status: "revoked", support_session_id: body.support_session_id, revoked_at: Date.now(),
      changed: true, replayed: scenario === "idempotent", request_id: body.request_id,
    });
  }
  if (url.pathname === "/api/app/update-status") {
    if (scenario === "degraded") {
      return sendJson(response, {
        status: "unavailable",
        error: "unavailable",
        code: "update_check_unavailable",
        installed_version: "0.2.0",
        latest_version: null,
        checked_at: "2026-08-30T12:00:00.000Z",
        update_url: "https://financialbrain.ai/update",
      }, 503);
    }
    return sendJson(response, {
      status: "update_available",
      installed_version: "0.2.0",
      latest_version: "0.2.1",
      checked_at: "2026-08-30T12:00:00.000Z",
      published_at: "2026-08-30",
      update_url: "https://financialbrain.ai/update",
      claude_prompt: "Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain.",
      changes: ["A synthetic reviewed update is available in this local rehearsal."],
      released_connectors: ["Synthetic connector proof only"],
      installer: {
        url: "https://github.com/guldanjaMAX/brain-installer/releases/download/v0.2.1/brain-installer-0.2.1.tgz",
        sha256: "a".repeat(64),
        bytes: 4_000_000,
      },
    });
  }
  if (url.pathname === "/api/app/document-access/documents") {
    if (scenario === "grant-unavailable") return sendJson(response, { error: "unavailable", code: "document_access_unavailable" }, 503);
    return sendJson(response, {
      status: "ready",
      principal: { kind: "grant", grant_id: "dg_fixture", entity_slug: "mesa-coffee" },
      scope_rule: "exact_document_ids_only",
      documents: [
        { document_id: "private-one", title: "July operating statement", source: "drive", document_date: Date.parse("2026-07-31T00:00:00Z"), date_source: "document", date_reliable: true, text_source: "native", text_reliable: true },
        { document_id: "private-two", title: "Equipment receipt scan", source: "upload", document_date: Date.parse("2026-07-22T00:00:00Z"), date_source: "ocr", date_reliable: false, text_source: "ocr", text_reliable: false },
      ],
    });
  }
  if (url.pathname === "/api/app/document-access/status") {
    if (scenario === "degraded") return sendJson(response, { error: "unavailable", code: "document_access_unavailable" }, 503);
    return sendJson(response, {
      status: "ready", scope_rule: "exact_document_ids_only", default_access: "owner_only",
      grants: scenario === "empty" ? [] : [{
        grant_id: "dg_fixture", subject_label: "External reviewer", entity_slug: "mesa-coffee", state: "active",
        expires_at: null, created_at: Date.now() - 86400000 * 3, revoked_at: null,
        documents: [{ document_id: "private-one", entity_slug: "mesa-coffee", granted_at: Date.now() - 86400000 * 3, revoked_at: null }],
      }],
    });
  }
  if (url.pathname === "/api/app/document-access/create") {
    const body = await jsonBody(request);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "idempotency_conflict", detail: "request id conflict" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, {
      status: "active", grant_id: "dg_created", subject_label: body.subject_label, entity_slug: body.entity_slug,
      document_ids: body.document_ids, expires_at: null, created_at: Date.now(), invite_state: "active",
      enrollment_url: "http://127.0.0.1/app#enroll=fixture-private", enrollment_expires_at: Date.now() + 900000,
      scope_rule: "exact_document_ids_only", replayed: scenario === "idempotent",
    });
  }
  if (url.pathname === "/api/app/document-access/reissue") {
    const body = await jsonBody(request);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "idempotency_conflict" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, { status: "active", grant_id: body.grant_id, invite_state: "active", enrollment_url: "http://127.0.0.1/app#enroll=fixture-reissued", enrollment_expires_at: Date.now() + 900000, replayed: scenario === "idempotent" });
  }
  if (url.pathname === "/api/app/document-access/revoke") {
    const body = await jsonBody(request);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "idempotency_conflict" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, { status: "revoked", grant_id: body.grant_id, revoked_at: Date.now(), changed: true, replayed: scenario === "idempotent" });
  }
  if (url.pathname === "/api/app/passkeys/status") {
    if (scenario === "degraded") return sendJson(response, { error: "unavailable", code: "passkey_observability_unavailable" }, 503);
    return sendJson(response, {
      status: "ready", rp_id: "brain.example.test",
      proof: { configured: true, locally_verified: true, live_proven: false },
      devices: { owner: scenario === "empty" ? 0 : 1, grant: scenario === "empty" ? 0 : 1 },
      ceremonies: scenario === "empty" ? [] : [{ ceremony: "session_use", stage: "verification", outcome: "succeeded", rp_id: "brain.example.test", count: 4, last_at: Date.now() - 60000, timing_ms: { min: 18, average: 23.5, max: 31 } }],
      privacy: "No credential ids, challenges, assertions, public keys, IP addresses, user agents, questions, answers, or document content are recorded here.",
    });
  }
  if (url.pathname === "/api/app/system") {
    if (scenario === "degraded") return sendJson(response, { ...systemStatus, documents: undefined, problems: undefined, sources: undefined, unavailable: ["diagnose", "sources"] });
    if (scenario === "empty") return sendJson(response, { ...systemStatus, documents: 0, chunks: 0, problems: [], problem_counts: { crit: 0, warn: 0, info: 0 }, sources: [], vectors: { ready: true, expected: 0, visible: 0, pending: 0, percent_visible: null } });
    return sendJson(response, systemStatus);
  }
  if (url.pathname === "/api/owner/uploads/capabilities") {
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, uploadCapabilities);
  }
  if (url.pathname === "/api/owner/activity") {
    const body = await jsonBody(request);
    if (scenario === "degraded") return sendJson(response, { error: "unavailable", unavailable: true, sections_unavailable: ["activity_events"] }, 503);
    const rows = scenario === "empty" ? [] : filterRows(ownerActivity, body.entity_slug || null);
    return sendJson(response, { entity_scope: { entity_slug: body.entity_slug || null }, activity_events: rows, truncated: scenario === "partial", next_cursor: scenario === "partial" ? "next" : null, unavailable: false });
  }
  if (url.pathname === "/api/owner/preferences/read") {
    if (scenario === "degraded") return sendJson(response, { error: "unavailable", sections_unavailable: ["preferences"] }, 503);
    return sendJson(response, { entity_scope: { entity_slug: null }, preferences: scenario === "empty" ? [] : ownerPreferences, unavailable: false });
  }
  if (url.pathname === "/api/owner/preferences/set") {
    const body = await jsonBody(request);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "request_id_conflict" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, { request_id: body.request_id, entity_scope: { entity_slug: body.entity_slug || null }, changed: true, preference: { entity_slug: body.entity_slug || null, preference_key: body.preference_key, value: body.value }, activity_event_id: "event-preference", replayed: scenario === "idempotent" });
  }
  if (url.pathname === "/api/owner/targets/read") {
    const body = await jsonBody(request);
    if (scenario === "degraded") return sendJson(response, { error: "unavailable", sections_unavailable: ["targets"] }, 503);
    return sendJson(response, { entity_scope: { entity_slug: body.entity_slug || null }, targets: scenario === "empty" ? [] : filterRows(ownerTargets, body.entity_slug || null), unavailable: false });
  }
  if (url.pathname === "/api/owner/targets/upsert" || url.pathname === "/api/owner/targets/archive") {
    const body = await jsonBody(request);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "request_id_conflict" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, { request_id: body.request_id, entity_scope: { entity_slug: body.entity_slug }, changed: true, target: { ...ownerTargets[0], target_id: body.target_id, entity_slug: body.entity_slug }, activity_event_id: "event-target", replayed: scenario === "idempotent" });
  }
  if (url.pathname === "/api/owner/approvals") {
    const body = await jsonBody(request);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "decision_changed" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, { request_id: body.request_id, entity_scope: { entity_slug: body.entity_slug }, changed: true, approval: { approval_type: body.approval_type, subject_uid: body.subject_uid }, activity_event_id: "event-approval", replayed: scenario === "idempotent" });
  }
  if (url.pathname === "/api/owner/period-closes/read") {
    const body = await jsonBody(request);
    if (scenario === "degraded") return sendJson(response, { error: "unavailable", unavailable: true, sections_unavailable: ["period_closes"] }, 503);
    return sendJson(response, { entity_scope: { entity_slug: body.entity_slug }, period_closes: scenario === "empty" ? [] : filterRows(ownerPeriodCloses, body.entity_slug), unavailable: false });
  }
  if (url.pathname === "/api/owner/period-closes/accept" || url.pathname === "/api/owner/period-closes/reopen") {
    const body = await jsonBody(request);
    if (scenario === "conflict" && !body.acknowledge_incomplete) return sendJson(response, { error: "conflict", code: "incomplete_evidence" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    const accepted = url.pathname.endsWith("/accept");
    return sendJson(response, { request_id: body.request_id, entity_scope: { entity_slug: body.entity_slug }, changed: true, period_close: { period_close_id: "close-fixture", entity_slug: body.entity_slug, period_start: body.period_start, period_end: body.period_end, status: accepted ? "accepted" : "reopened", evidence_state: body.acknowledge_incomplete ? "owner_acknowledged_incomplete" : "complete", acknowledged_incomplete: Boolean(body.acknowledge_incomplete), accepted_at: accepted ? "2026-08-29T00:00:00Z" : null, reopened_at: accepted ? null : "2026-08-29T00:00:00Z" }, activity_event_id: "event-close", replayed: scenario === "idempotent" }, 200);
  }
  if (url.pathname === "/api/owner/uploads") {
    const body = await jsonBody(request);
    if (scenario === "validation") return sendJson(response, { uploaded: false, error: "refused", code: "content_refused" }, 422);
    if (scenario === "conflict") return sendJson(response, { error: "conflict", code: "request_id_conflict" }, 409);
    if (scenario === "forbidden") return sendJson(response, { error: "forbidden", code: "owner_required" }, 403);
    return sendJson(response, { uploaded: true, request_id: body.request_id, document_id: body.document_id, entity_scope: { entity_slug: body.entity_slug }, media_type: body.media_type, file_name: body.file_name, document: { doc_uid: "private", action: scenario === "idempotent" ? "unchanged" : "created", chunks: 1, queued: 1 }, changed: scenario !== "idempotent", activity_event_id: scenario === "idempotent" ? null : "event-upload", replayed: scenario === "idempotent" }, scenario === "idempotent" ? 200 : 201);
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
    const body = await jsonBody(request);
    if (scenario.startsWith("grant")) {
      return sendJson(response, scenario === "grant-unavailable"
        ? { status: "search_unavailable", notice: "Exact-document search is unavailable.", results: [], retrieval_scope: "exact_document_ids", degraded: "scoped-vector", degraded_reason: "document-scope-keyword-only", access: { principal: "grant", grant_id: "dg_fixture", entity_slug: "mesa-coffee", document_count: 2 } }
        : { results: [{ doc_uid: "private-one", chunk_uid: "shared-chunk", title: "July operating statement", snippet: "The closing balance was supported by the July statement.", source: "drive", ts: "2026-07-31", date_reliable: true }], retrieval_scope: "exact_document_ids", degraded: "scoped-vector", degraded_reason: "document-scope-keyword-only", access: { principal: "grant", grant_id: "dg_fixture", entity_slug: "mesa-coffee", document_count: 2 } });
    }
    return sendJson(response, scenario === "degraded"
      ? { status: "unavailable", degraded: "vector" }
      : scenario === "scope-mismatch"
        ? { results: [], entity_scope: { entity_slug: null, applied: false }, filter_not_applied: true }
        : { entity_scope: { entity_slug: body.entity_slug || null, applied: Boolean(body.entity_slug) }, degraded: body.entity_slug ? "vector" : undefined, degraded_reason: body.entity_slug ? "entity-vector-authority-unindexed" : undefined, results: scenario === "empty" ? [] : [{ doc_uid: "doc", chunk_uid: "chunk", title: "Mesa Coffee checking, July 2026", snippet: "The closing balance was supported by the July statement.", source: "drive", ts: "2026-07-31", date_reliable: true }] });
  }
  if (url.pathname === "/api/rag/think") {
    const body = await jsonBody(request);
    if (scenario.startsWith("grant")) {
      const access = { principal: "grant", grant_id: "dg_fixture", entity_slug: "mesa-coffee", document_count: 2 };
      return sendJson(response, scenario === "grant-unavailable"
        ? { answer: null, status: "search_unavailable", notice: "Exact-document search is unavailable. This is not proof that nothing is recorded.", citations: [], results: [], gaps: [{ type: "scoped_vector_unavailable" }], retrieval_scope: "exact_document_ids", degraded: "scoped-vector", degraded_reason: "document-scope-keyword-only", access }
        : { answer: "The shared statement records a July closing balance. [1]", citations: [{ n: 1, title: "July operating statement", source: "drive", ts: "2026-07-31" }], results: [{ doc_uid: "private-one" }], gaps: [{ type: "scoped_vector_unavailable" }], confidence: { percent: 82, band: "high", basis: ["One exact shared document supports the answer"] }, retrieval_scope: "exact_document_ids", degraded: "scoped-vector", degraded_reason: "document-scope-keyword-only", access });
    }
    return sendJson(response, scenario === "degraded"
      ? { answer: null, answer_error: "search unavailable", status: "unavailable", degraded: "vector" }
      : scenario === "scope-mismatch"
        ? { answer: "This answer was not safely narrowed.", entity_scope: { entity_slug: null, applied: false }, filter_not_applied: true }
        : { answer: "Mesa Coffee has one confirmed cash figure as of July 31. [1] The rental account is not included because no confirmed figure is recorded.", entity_scope: { entity_slug: body.entity_slug || null, applied: Boolean(body.entity_slug) }, degraded: body.entity_slug ? "vector" : undefined, degraded_reason: body.entity_slug ? "entity-vector-authority-unindexed" : undefined, confidence: { percent: 86, band: "high", basis: ["One dated statement supports the figure", "One known account is explicitly missing"] }, citations: [{ n: 1, title: "Mesa Coffee checking, July 2026", source: "drive", ts: "2026-07-31" }] });
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
