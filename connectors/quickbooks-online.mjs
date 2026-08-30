/** Read-only QuickBooks Online accounting snapshots. */

import { createHash } from "node:crypto";

import {
  createPaginationGuard, providerEnvelope, providerJson, providerSyncResult, renderRecord,
} from "./provider-sync.mjs";

export const QBO_DEFAULT_ENTITIES = Object.freeze([
  "Account", "Customer", "Vendor", "Invoice", "Payment", "Bill", "Purchase",
  "JournalEntry", "Deposit", "Transfer", "CreditMemo", "BillPayment", "Estimate",
  "SalesReceipt", "RefundReceipt",
]);
export const QBO_PAGE_SIZE = 1_000;
export const QBO_RECONCILIATION_ENTITIES = Object.freeze([
  "Purchase", "Deposit", "Payment", "BillPayment", "Transfer", "SalesReceipt", "RefundReceipt",
]);
const ENTITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const REALM_ID = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * Normalize Intuit's opaque company identity without ever placing it
 * in a document, receipt, manifest, or URI. The raw realmId remains only in
 * the protected local OAuth record and the provider request path.
 */
export function normalizeQuickBooksRealmId(value) {
  const realmId = String(value ?? "").trim();
  if (!REALM_ID.test(realmId)) {
    throw new TypeError("QuickBooks returned an invalid company identity");
  }
  return realmId;
}

/**
 * Canonical non-disclosing company identity shared with Books Reality Check.
 * Keep this exact algorithm stable because reconciliation claims, OAuth
 * bindings, sync state, and source-namespace custody all rely on it.
 */
export const quickBooksCompanyFingerprint = (realmId) => {
  const company = String(realmId || "").trim();
  if (!company) throw new TypeError("QuickBooks company identity is required");
  return createHash("sha256")
    .update(`quickbooks-company-v1:${company}`)
    .digest("hex");
};

// Compatibility alias for callers that use Intuit's realm terminology.
export const quickBooksRealmFingerprint = quickBooksCompanyFingerprint;

function amountMinor(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function accountValue(value) {
  const id = String(value?.value || "").trim();
  return id && id.length <= 128 ? id : null;
}

/**
 * Deterministic cash-account evidence only. These are the QBO records whose
 * schema names the bank-side account and amount directly. Invoices, bills,
 * journal entries, and reports are deliberately excluded rather than guessed.
 */
export function quickBooksReconciliationLines(entity, row) {
  const id = String(row?.Id || "").trim();
  const postedOn = String(row?.TxnDate || "").trim();
  const minor = amountMinor(row?.TotalAmt);
  const currency = String(row?.CurrencyRef?.value || "USD").trim().toUpperCase();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(postedOn) || minor === null || !/^[A-Z]{3}$/.test(currency)) {
    return [];
  }
  const base = {
    posted_on: postedOn,
    amount_minor: minor,
    currency,
    source_id: `${String(entity).toLowerCase()}:${id}`,
  };
  const one = (account, direction, fields, suffix = "") => account ? [{
    ...base,
    line_uid: `${base.source_id}${suffix}`,
    qbo_account_id: account,
    direction,
    source_locator: `QuickBooks ${entity} ${id}; fields ${fields}`,
  }] : [];

  if (entity === "Purchase") {
    return one(accountValue(row.AccountRef), "outflow", "TxnDate, TotalAmt, AccountRef");
  }
  if (entity === "Deposit") {
    return one(accountValue(row.DepositToAccountRef), "inflow", "TxnDate, TotalAmt, DepositToAccountRef");
  }
  if (entity === "Payment") {
    return one(accountValue(row.DepositToAccountRef), "inflow", "TxnDate, TotalAmt, DepositToAccountRef");
  }
  if (entity === "SalesReceipt") {
    return one(accountValue(row.DepositToAccountRef), "inflow", "TxnDate, TotalAmt, DepositToAccountRef");
  }
  if (entity === "RefundReceipt") {
    return one(accountValue(row.DepositToAccountRef), "outflow", "TxnDate, TotalAmt, DepositToAccountRef");
  }
  if (entity === "BillPayment") {
    return one(accountValue(row?.CheckPayment?.BankAccountRef), "outflow", "TxnDate, TotalAmt, CheckPayment.BankAccountRef");
  }
  if (entity === "Transfer") {
    return [
      ...one(accountValue(row.FromAccountRef), "outflow", "TxnDate, TotalAmt, FromAccountRef", ":from"),
      ...one(accountValue(row.ToAccountRef), "inflow", "TxnDate, TotalAmt, ToAccountRef", ":to"),
    ];
  }
  return [];
}

export async function syncQuickBooksOnline({
  realmId,
  accessToken,
  fetchImpl = fetch,
  apiBase = "https://quickbooks.api.intuit.com",
  entities = QBO_DEFAULT_ENTITIES,
  minorVersion = null,
  snapshotAt = new Date().toISOString(),
  expectedCompanyFingerprint = null,
  expectedRealmFingerprint = null,
} = {}) {
  if (!String(realmId || "").trim() || !accessToken) {
    throw new TypeError("QuickBooks realmId and accessToken are required");
  }
  const normalizedRealmId = normalizeQuickBooksRealmId(realmId);
  const companyFingerprint = quickBooksCompanyFingerprint(normalizedRealmId);
  const expectedFingerprint = expectedCompanyFingerprint || expectedRealmFingerprint;
  if (expectedFingerprint && expectedFingerprint !== companyFingerprint) {
    throw new TypeError("QuickBooks company identity does not match the authorized source binding");
  }
  if (!Array.isArray(entities) || !entities.length || entities.some((name) => !ENTITY.test(String(name)))) {
    throw new TypeError("QuickBooks entities must be a non-empty list of safe entity names");
  }
  const documents = [];
  for (const entityValue of entities) {
    const entity = String(entityValue);
    const guard = createPaginationGuard("quickbooks", { maxPages: 10_000 });
    let start = 1;
    while (true) {
      guard.visit(`${entity}:${start}`);
      const query = `select * from ${entity} STARTPOSITION ${start} MAXRESULTS ${QBO_PAGE_SIZE}`;
      const url = new URL(`${String(apiBase).replace(/\/$/, "")}/v3/company/${encodeURIComponent(normalizedRealmId)}/query`);
      url.searchParams.set("query", query);
      if (minorVersion) url.searchParams.set("minorversion", String(minorVersion));
      const { data } = await providerJson("quickbooks", url, { accessToken, fetchImpl });
      const response = data?.QueryResponse;
      const rows = Array.isArray(response?.[entity]) ? response[entity] : [];
      for (const row of rows) {
        const id = String(row?.Id || "").trim();
        if (!id) continue;
        const changed = row?.MetaData?.LastUpdatedTime || row?.TxnDate || null;
        const sourceId = `${entity.toLowerCase()}:${id}`;
        const reconciliationLines = quickBooksReconciliationLines(entity, row)
          .map((line) => ({ ...line, qbo_company_fingerprint: companyFingerprint }));
        documents.push(providerEnvelope("quickbooks", sourceId, {
          title: `${entity}: ${row.DisplayName || row.DocNumber || row.CompanyName || id}`,
          content: renderRecord(`QuickBooks ${entity}`, row),
          occurredAt: changed,
          uri: `quickbooks://${entity.toLowerCase()}/${encodeURIComponent(id)}`,
          metadata: {
            qbo_company_fingerprint: companyFingerprint,
            entity_type: entity,
            provider_id: id,
            provider_version: changed,
            snapshot_at: snapshotAt,
            reconciliation_lines: reconciliationLines,
          },
        }));
      }
      const maxResults = Number(response?.maxResults ?? rows.length);
      if (!rows.length || rows.length < QBO_PAGE_SIZE || maxResults < QBO_PAGE_SIZE) break;
      start += rows.length;
    }
  }
  return Object.freeze({
    ...providerSyncResult({
      provider: "quickbooks",
      documents,
      proposedCursor: null,
      deletionAuthority: "unavailable",
      warnings: [
        "QuickBooks query snapshots are idempotent for present records but do not prove which previously loaded records were deleted.",
      ],
    }),
    qbo_company_fingerprint: companyFingerprint,
  });
}
