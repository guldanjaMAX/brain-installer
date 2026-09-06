/** Credential-free connector build and proof ledger. */

const row = (value) => Object.freeze({ real_boundary: "not_run", acceptance: "pending", ...value });

export const CONNECTOR_EXPANSION_CATALOG = Object.freeze([
  row({
    id: "quickbooks", label: "QuickBooks Online", build: "sandbox_ready_runner",
    automated_proof: "offline_scripted_provider_io", rehearsal_available: true, installed_connection: true,
    current_boundary: "Sandbox localhost OAuth, canonical company binding, rotating refresh, paginated read-only accounting snapshots, common receipts, scheduling, retry, and revoke-before-disconnect are wired. Intuit's Accounting consent is broader than runtime use. Production callback and query deletion truth remain unavailable.",
    next_acceptance: "Use an Intuit sandbox company to prove consent, returned company identity, same-company reconnect, wrong-company refusal, refresh rotation, pagination, changed records, outage recovery, disconnect retention, retrieval, and a separate forget preview.",
  }),
  row({
    id: "plaid", label: "Plaid bank aggregation", build: "owner_link_and_account_scope_ready",
    automated_proof: "sqlite_and_scripted_provider_io", rehearsal_available: false, installed_connection: true,
    current_boundary: "The owner-only browser Link page, lost-response replay, signed webhooks, staged sync, masked per-account entity assignment, automatic resume, and provider-confirmed disconnect are wired. No Plaid credential, Sandbox Item, bank login, or real transaction has crossed this build.",
    next_acceptance: "Use an approved Plaid Sandbox account to drive Link through the deployed Brain, assign every masked account, prove D1 promotion and cursor resume, trigger webhook and fallback paths, disconnect, and confirm provider removal. Then separately approve one real read-only Item.",
  }),
  row({
    id: "slack", label: "Slack", build: "sandbox_ready_runner",
    automated_proof: "offline_scripted_provider_io", rehearsal_available: true, installed_connection: true,
    current_boundary: "OAuth rotation, channels, direct conversations, per-message threads, surfaced tombstones, common receipts, scheduling, and disconnect are wired. Complete deletion truth is unavailable.",
    next_acceptance: "Use a test workspace to prove consent, refresh rotation, pagination, rate limits, edits, threads, exclusions, disconnect, and retrieval.",
  }),
  row({
    id: "notion", label: "Notion", build: "sandbox_ready_runner",
    automated_proof: "offline_scripted_provider_io", rehearsal_available: true, installed_connection: true,
    current_boundary: "OAuth refresh, current-version page search, properties, recursive blocks, surfaced trash, common receipts, scheduling, and disconnect are wired. Complete removal truth is unavailable.",
    next_acceptance: "Use a test workspace to prove shared and unshared pages, recursive blocks, edits, trash, refresh, retry, disconnect, and retrieval.",
  }),
  row({
    id: "linkedin-export", label: "LinkedIn Download Your Data", build: "export_connector",
    automated_proof: "bounded_archive_fixture_and_common_folder_ingestion", rehearsal_available: false, installed_connection: true,
    current_boundary: "The account-owner ZIP is safety-validated and read through ordinary folder ingestion. This is not a live LinkedIn API or scraper.",
    next_acceptance: "Load one current reviewed export, verify recognized and skipped CSV counts, rerun unchanged, and prove family deletion.",
  }),
  row({
    id: "microsoft", label: "Microsoft 365", build: "sandbox_ready_runner",
    automated_proof: "offline_scripted_provider_io", rehearsal_available: true, installed_connection: true,
    current_boundary: "OAuth refresh, Outlook immutable-ID delta, OneDrive and SharePoint body extraction, tombstones, baseline reconciliation, scheduling, and disconnect are wired.",
    next_acceptance: "Use a test Entra tenant to prove consent, refresh, Outlook delta, file downloads, cursor expiry reset, deletions, disconnect, and retrieval.",
  }),
  row({
    id: "dropbox", label: "Dropbox", build: "sandbox_ready_runner",
    automated_proof: "offline_scripted_provider_io", rehearsal_available: true, installed_connection: true,
    current_boundary: "OAuth refresh, bounded file-body extraction, opaque cursors, tombstones, baseline reconciliation, scheduling, and disconnect are wired.",
    next_acceptance: "Use a test account to prove consent, refresh, body extraction, cursor resume and reset, edits, deletions, disconnect, and retrieval.",
  }),
  row({
    id: "hubspot", label: "HubSpot CRM", build: "sandbox_ready_runner",
    automated_proof: "offline_scripted_provider_io", rehearsal_available: true, installed_connection: true,
    current_boundary: "OAuth refresh, contacts, companies, deals, archived tombstones, common receipts, scheduling, and disconnect are wired. Permanent deletion truth is unavailable.",
    next_acceptance: "Use a test portal to prove consent, refresh, pagination, edits, archives, disconnect, retry, and retrieval.",
  }),
  row({
    id: "zoom", label: "Zoom transcript delivery", build: "built",
    automated_proof: "in_process_and_scripted_provider_io", rehearsal_available: false, installed_connection: true,
    current_boundary: "Verified webhooks become durable delivery debt before acknowledgement, and a bounded recent reconciliation covers missed events. The connector reads Zoom's transcript file and does not transcribe audio.",
    next_acceptance: "On an approved paid test seat, prove one transcript webhook, missed-event reconciliation, retry identity, ingest, retrieval, and disconnect.",
  }),
  row({
    id: "browser-document-upload", label: "Browser document and image OCR upload", build: "sandbox_ready_browser_path",
    automated_proof: "extractor_fixture_and_in_process_worker", rehearsal_available: false, installed_connection: true,
    current_boundary: "Text, PDF text layers, Office, email, PNG, and JPEG share owner scope, credential scanning, extraction provenance, common receipts, and crash recovery. Scanned PDF page OCR is absent.",
    next_acceptance: "On a disposable Worker, upload every supported format and prove private OCR, retry recovery, retrieval, and deletion.",
  }),
  ...[
    ["salesforce", "Salesforce"], ["quickbooks-desktop", "QuickBooks Desktop"],
    ["linkedin-live", "Live LinkedIn"], ["facebook-official", "Official Facebook"],
    ["whatsapp-official", "Official WhatsApp"],
  ].map(([id, label]) => row({
    id, label, build: "absent", automated_proof: "none", rehearsal_available: false, installed_connection: false,
    current_boundary: `${label} is intentionally absent from this release slice. No connection or proof is implied.`,
    next_acceptance: `Define a supported, policy-compliant product boundary and a sandbox acceptance plan before building ${label}.`,
  })),
]);

export function connectorCatalog({ provider = null } = {}) {
  const wanted = provider === null ? null : String(provider).trim().toLowerCase();
  const entries = wanted ? CONNECTOR_EXPANSION_CATALOG.filter((entry) => entry.id === wanted) : [...CONNECTOR_EXPANSION_CATALOG];
  if (wanted && entries.length === 0) {
    const error = new Error(`unknown connector ${wanted}`);
    error.code = "CONFIG_INVALID";
    throw error;
  }
  return entries;
}

export function renderConnectorCatalog(entries) {
  const lines = [
    "Connector expansion proof", "",
    "These labels separate installed code from real-account proof. A rehearsal never signs in or reads customer data.", "",
  ];
  for (const entry of entries) {
    lines.push(entry.label);
    lines.push(`  Build: ${entry.build.replaceAll("_", " ")}`);
    lines.push(`  Automated proof: ${entry.automated_proof.replaceAll("_", " ")}`);
    lines.push(`  Real boundary: ${entry.real_boundary.replaceAll("_", " ")}`);
    lines.push(`  Installed connection: ${entry.installed_connection ? "available" : "not available"}`);
    lines.push(`  Current boundary: ${entry.current_boundary}`);
    lines.push(`  Next acceptance: ${entry.next_acceptance}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
