/** HubSpot CRM snapshots with explicit archived-object tombstones. */

import {
  createPaginationGuard, providerEnvelope, providerJson, providerSyncResult, renderRecord,
} from "./provider-sync.mjs";

export const HUBSPOT_OBJECTS = Object.freeze({
  contacts: Object.freeze(["firstname", "lastname", "email", "phone", "company", "jobtitle", "lastmodifieddate"]),
  companies: Object.freeze(["name", "domain", "phone", "industry", "city", "state", "country", "hs_lastmodifieddate"]),
  deals: Object.freeze(["dealname", "amount", "dealstage", "pipeline", "closedate", "hs_lastmodifieddate"]),
});

async function objectPages(type, properties, archived, auth) {
  const rows = [];
  const guard = createPaginationGuard("hubspot");
  let after = "__first__";
  while (after) {
    guard.visit(`${type}:${archived ? "archived" : "active"}:${after}`);
    const url = new URL(`https://api.hubapi.com/crm/v3/objects/${type}`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("properties", properties.join(","));
    if (archived) url.searchParams.set("archived", "true");
    if (after !== "__first__") url.searchParams.set("after", after);
    const { data } = await providerJson("hubspot", url, auth);
    rows.push(...(data.results || []));
    after = data?.paging?.next?.after || "";
  }
  return rows;
}

export async function syncHubSpot({
  accessToken,
  fetchImpl = fetch,
  objectTypes = Object.keys(HUBSPOT_OBJECTS),
} = {}) {
  if (!accessToken) throw new TypeError("HubSpot accessToken is required");
  if (!Array.isArray(objectTypes) || !objectTypes.length) throw new TypeError("HubSpot objectTypes must not be empty");
  const documents = [];
  const deletions = [];
  const auth = { accessToken, fetchImpl };
  for (const typeValue of objectTypes) {
    const type = String(typeValue);
    const properties = HUBSPOT_OBJECTS[type];
    if (!properties) throw new TypeError(`unsupported HubSpot object type ${type}`);
    const active = await objectPages(type, properties, false, auth);
    for (const row of active) {
      if (!row?.id) continue;
      const label = row.properties?.name || row.properties?.dealname ||
        [row.properties?.firstname, row.properties?.lastname].filter(Boolean).join(" ") || row.id;
      documents.push(providerEnvelope("hubspot", `${type}:${row.id}`, {
        title: `HubSpot ${type.replace(/s$/, "")}: ${label}`,
        content: renderRecord(`HubSpot ${type.replace(/s$/, "")}`, { id: row.id, ...row.properties }),
        occurredAt: row.updatedAt || row.properties?.lastmodifieddate || row.properties?.hs_lastmodifieddate || null,
        uri: `hubspot://${type}/${encodeURIComponent(row.id)}`,
        metadata: { object_type: type, object_id: row.id, archived: false },
      }));
    }
    const archived = await objectPages(type, properties, true, auth);
    deletions.push(...archived.filter((row) => row?.id).map((row) => ({
      source_type: "hubspot", source_id: `${type}:${row.id}`,
    })));
  }
  return providerSyncResult({
    provider: "hubspot", documents, deletions,
    deletionAuthority: "unavailable",
    warnings: [
      "HubSpot archived objects become exact tombstones, but permanently deleted objects are not exposed by the ordinary CRM object snapshots.",
    ],
    proposedCursor: null,
  });
}
