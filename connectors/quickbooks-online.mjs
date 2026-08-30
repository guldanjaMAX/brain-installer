/** Read-only QuickBooks Online accounting snapshots. */

import {
  createPaginationGuard, providerEnvelope, providerJson, providerSyncResult, renderRecord,
} from "./provider-sync.mjs";

export const QBO_DEFAULT_ENTITIES = Object.freeze([
  "Account", "Customer", "Vendor", "Invoice", "Payment", "Bill", "Purchase",
  "JournalEntry", "Deposit", "Transfer", "CreditMemo", "BillPayment", "Estimate",
  "SalesReceipt", "RefundReceipt",
]);
export const QBO_PAGE_SIZE = 1_000;
const ENTITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export async function syncQuickBooksOnline({
  realmId,
  accessToken,
  fetchImpl = fetch,
  apiBase = "https://quickbooks.api.intuit.com",
  entities = QBO_DEFAULT_ENTITIES,
  minorVersion = null,
  snapshotAt = new Date().toISOString(),
} = {}) {
  if (!String(realmId || "").trim() || !accessToken) {
    throw new TypeError("QuickBooks realmId and accessToken are required");
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
      const url = new URL(`${String(apiBase).replace(/\/$/, "")}/v3/company/${encodeURIComponent(realmId)}/query`);
      url.searchParams.set("query", query);
      if (minorVersion) url.searchParams.set("minorversion", String(minorVersion));
      const { data } = await providerJson("quickbooks", url, { accessToken, fetchImpl });
      const response = data?.QueryResponse;
      const rows = Array.isArray(response?.[entity]) ? response[entity] : [];
      for (const row of rows) {
        const id = String(row?.Id || "").trim();
        if (!id) continue;
        const changed = row?.MetaData?.LastUpdatedTime || row?.TxnDate || null;
        documents.push(providerEnvelope("quickbooks", `${entity.toLowerCase()}:${id}`, {
          title: `${entity}: ${row.DisplayName || row.DocNumber || row.CompanyName || id}`,
          content: renderRecord(`QuickBooks ${entity}`, row),
          occurredAt: changed,
          uri: `quickbooks://${entity.toLowerCase()}/${encodeURIComponent(id)}`,
          metadata: {
            entity_type: entity,
            provider_id: id,
            provider_version: changed,
            snapshot_at: snapshotAt,
          },
        }));
      }
      const maxResults = Number(response?.maxResults ?? rows.length);
      if (!rows.length || rows.length < QBO_PAGE_SIZE || maxResults < QBO_PAGE_SIZE) break;
      start += rows.length;
    }
  }
  return providerSyncResult({
    provider: "quickbooks",
    documents,
    proposedCursor: null,
    deletionAuthority: "unavailable",
    warnings: [
      "QuickBooks query snapshots are idempotent for present records but do not prove which previously loaded records were deleted.",
    ],
  });
}
