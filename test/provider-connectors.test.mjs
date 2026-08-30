import assert from "node:assert/strict";
import { ProviderSyncError, providerJson } from "../connectors/provider-sync.mjs";
import {
  quickBooksCompanyFingerprint,
  syncQuickBooksOnline,
} from "../connectors/quickbooks-online.mjs";
import { syncSlack } from "../connectors/slack.mjs";
import { NOTION_API_VERSION, syncNotion } from "../connectors/notion.mjs";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { syncDropbox } from "../connectors/dropbox.mjs";
import { syncHubSpot } from "../connectors/hubspot.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});

{
  let error;
  try {
    await providerJson("fixture", "https://provider.invalid/data", {
      fetchImpl: async () => json({ error: "slow_down" }, 429, { "retry-after": "7" }),
      maxAttempts: 1,
    });
  } catch (caught) { error = caught; }
  check("shared HTTP contract makes a rate limit retryable",
    error instanceof ProviderSyncError && error.outcome.kind === "retryable" && error.retry_after_seconds === 7);
}

{
  let qboUrl = "";
  const result = await syncQuickBooksOnline({
    realmId: "realm-fixture", accessToken: "token", entities: ["Invoice"],
    fetchImpl: async (url) => {
      qboUrl = String(url);
      return json({ QueryResponse: { Invoice: [{
        Id: "17", DocNumber: "INV-17", TxnDate: "2026-08-01",
        MetaData: { LastUpdatedTime: "2026-08-02T00:00:00Z" }, TotalAmt: 125,
      }], maxResults: 1 } });
    },
  });
  check("QuickBooks query is company-scoped and paginated",
    qboUrl.includes("/v3/company/realm-fixture/query") && new URL(qboUrl).searchParams.get("query").includes("MAXRESULTS 1000"));
  const companyFingerprint = quickBooksCompanyFingerprint("realm-fixture");
  check("QuickBooks emits stable provenance envelopes",
    result.documents[0].source_id === "invoice:17" &&
    result.documents[0].metadata.entity_type === "Invoice" &&
    result.documents[0].metadata.qbo_company_fingerprint === companyFingerprint &&
    result.qbo_company_fingerprint === companyFingerprint &&
    !JSON.stringify(result).includes("realm-fixture"));
  check("QuickBooks snapshot withholds cursor because deletion truth is unavailable",
    result.outcome.kind === "partial" && result.cursor_can_advance === false && result.deletion_authority === "unavailable");
}

{
  const collect = (realmId, expectedCompanyFingerprint = null) => syncQuickBooksOnline({
    realmId,
    expectedCompanyFingerprint,
    accessToken: "token",
    entities: ["Invoice"],
    fetchImpl: async () => json({ QueryResponse: { Invoice: [{ Id: "17", DocNumber: "INV-17" }], maxResults: 1 } }),
  });
  const first = await collect("company-one");
  const same = await collect("company-one", quickBooksCompanyFingerprint("company-one"));
  const second = await collect("company-two");
  check("QuickBooks provider record identity stays backward-compatible while company custody remains distinct",
    first.documents[0].source_id === same.documents[0].source_id &&
    first.documents[0].source_id === second.documents[0].source_id &&
    first.qbo_company_fingerprint !== second.qbo_company_fingerprint &&
    `quickbooks:${first.documents[0].source_id}` !==
      `quickbooks_company_two:${second.documents[0].source_id}`);
  await assert.rejects(
    collect("company-two", quickBooksCompanyFingerprint("company-one")),
    /does not match the authorized source binding/,
  );
  check("QuickBooks refuses a wrong-company adapter call before it can ingest", true);
}

{
  const result = await syncQuickBooksOnline({
    realmId: "realm-fixture", accessToken: "token", entities: ["Purchase"],
    fetchImpl: async () => json({ QueryResponse: { Purchase: [{
      Id: "expense-1", TxnDate: "2026-07-10", TotalAmt: "260.00",
      AccountRef: { value: "qbo-bank-35" }, CurrencyRef: { value: "USD" },
    }], maxResults: 1 } }),
  });
  const line = result.documents[0].metadata.reconciliation_lines[0];
  check("QuickBooks emits deterministic company-bound bank-impact evidence with exact source fields",
    line.line_uid === "purchase:expense-1" && line.qbo_account_id === "qbo-bank-35" &&
    line.amount_minor === 26000 && line.direction === "outflow" &&
    line.qbo_company_fingerprint === quickBooksCompanyFingerprint("realm-fixture") &&
    /TxnDate, TotalAmt, AccountRef/.test(line.source_locator));
  check("QuickBooks bank evidence excludes the company identity and OAuth custody",
    !JSON.stringify(line).includes("realm-fixture") && !JSON.stringify(line).includes("token"));
}

{
  const result = await syncSlack({
    accessToken: "token",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes("conversations.list")) return json({ ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "" } });
      if (target.includes("conversations.history")) return json({ ok: true, messages: [
        { ts: "2.000000", user: "U2", text: "Second fixture message" },
        { ts: "1.000000", user: "U1", text: "First fixture message", reply_count: 1 },
        { subtype: "message_deleted", deleted_ts: "0.500000" },
      ], response_metadata: { next_cursor: "" } });
      if (target.includes("conversations.replies")) return json({ ok: true, messages: [
        { ts: "1.000000", user: "U1", text: "First fixture message" },
        { ts: "1.500000", thread_ts: "1.000000", user: "U3", text: "Thread reply" },
      ], response_metadata: { next_cursor: "" } });
      throw new Error(`unexpected Slack URL ${target}`);
    },
  });
  check("Slack emits stable per-message and reply documents",
    result.documents.map((item) => item.source_id).join(",") ===
      "message:C1:1.000000,message:C1:1.500000,message:C1:2.000000");
  check("Slack retains surfaced deletion tombstones while naming the broader gap",
    result.deletions[0].source_id === "message:C1:0.500000" && result.outcome.kind === "partial");
}

{
  let notionVersion = null;
  const result = await syncNotion({
    accessToken: "token",
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/search")) {
        notionVersion = options.headers["Notion-Version"];
        return json({ results: [{
          id: "page-1", url: "https://notion.invalid/page-1", last_edited_time: "2026-08-03T00:00:00Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Fixture plan" }] } },
        }, { id: "gone", archived: true, properties: {} }], has_more: false });
      }
      if (String(url).includes("/blocks/page-1/children")) return json({ results: [
        { id: "block-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Plan body" }] }, has_children: false },
      ], has_more: false });
      throw new Error(`unexpected Notion URL ${url}`);
    },
  });
  check("Notion search uses the current versioned API header", notionVersion === NOTION_API_VERSION && NOTION_API_VERSION === "2026-03-11");
  check("Notion recursively materializes page content and surfaced tombstones",
    result.documents[0].content.includes("Plan body") && result.deletions[0].source_id === "page:gone");
  check("Notion exposes its incomplete deletion authority", result.outcome.kind === "partial" && !result.cursor_can_advance);
}

{
  const mailDelta = "https://graph.microsoft.com/delta-mail";
  const driveDelta = "https://graph.microsoft.com/delta-drive";
  let immutableIdHeader = false;
  let downloadUsedBearer = false;
  const result = await syncMicrosoftGraph({
    accessToken: "token",
    mailFolderIds: ["inbox"], driveIds: ["D1"], includePersonalDrive: false,
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.includes("/mailFolders/inbox/messages/delta")) {
        immutableIdHeader = String(options.headers?.Prefer || "").includes("ImmutableId");
        return json({ value: [{
          id: "m1", subject: "Fixture mail", body: { contentType: "text", content: "Mail body" },
          receivedDateTime: "2026-08-04T00:00:00Z",
        }], "@odata.deltaLink": mailDelta });
      }
      if (target.includes("/drives/D1/root/delta")) return json({ value: [{
        id: "f1", name: "Plan.txt", file: { mimeType: "text/plain" }, size: 9,
        lastModifiedDateTime: "2026-08-05T00:00:00Z", webUrl: "https://sharepoint.invalid/plan",
        "@microsoft.graph.downloadUrl": "https://files.fixture.sharepoint.com/download?opaque=fixture",
      }], "@odata.deltaLink": driveDelta });
      if (target.startsWith("https://files.fixture.sharepoint.com/")) {
        downloadUsedBearer = Boolean(options.headers?.Authorization);
        return new Response("Plan body", { headers: { "content-type": "text/plain" } });
      }
      throw new Error(`unexpected Graph URL ${target}`);
    },
  });
  check("Graph mail requests immutable message IDs and saves terminal delta links",
    immutableIdHeader && result.proposed_cursor.mail.inbox === mailDelta && result.proposed_cursor.drives.D1 === driveDelta);
  check("OneDrive and SharePoint file bodies use common extraction without forwarding the bearer to the preauthenticated URL",
    result.documents.some((item) => item.source_id === "drive:item:D1:f1" && item.content === "Plan body") && !downloadUsedBearer);
  check("a full Graph baseline is authoritative and cursor-safe",
    result.authoritative_snapshot === true && result.snapshot_source_ids.length === 2 && result.cursor_can_advance === true);
}

{
  const result = await syncMicrosoftGraph({
    accessToken: "token", mailFolderIds: [], driveIds: [], siteIds: [], includePersonalDrive: false,
    cursor: { mail: {}, drives: { missing: "https://graph.microsoft.com/prior-drive-delta" } },
    fetchImpl: async () => { throw new Error("an inaccessible retained drive must not cause a network request"); },
  });
  check("a previously cursored drive that becomes invisible is retained without snapshot deletion or cursor advancement",
    result.authoritative_snapshot === false &&
    result.proposed_cursor.drives.missing === "https://graph.microsoft.com/prior-drive-delta" &&
    result.outcome.kind === "partial" && result.cursor_can_advance === false);
}

{
  let baselineShape = false;
  let contentArg = null;
  const result = await syncDropbox({
    accessToken: "token",
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target.includes("files/list_folder")) {
        const body = JSON.parse(options.body);
        baselineShape = body.recursive === true && body.include_deleted === true;
        return json({ entries: [
          { ".tag": "file", id: "id:plan", name: "Plan.txt", path_lower: "/plan.txt", server_modified: "2026-08-05T00:00:00Z", size: 20, rev: "1" },
          { ".tag": "deleted", path_lower: "/gone.txt" },
        ], cursor: "cursor-1", has_more: false });
      }
      if (target.includes("files/download")) {
        contentArg = JSON.parse(options.headers["Dropbox-API-Arg"]);
        return new Response("Dropbox plan body", { headers: { "content-type": "text/plain" } });
      }
      throw new Error(`unexpected Dropbox URL ${target}`);
    },
  });
  check("Dropbox baseline requests recursive inventory and exact deletions", baselineShape && result.deletions[0].source_id === "path:/gone.txt");
  check("Dropbox downloads and extracts file bodies through the content endpoint",
    contentArg.path === "id:plan" && result.documents[0].content === "Dropbox plan body");
  check("Dropbox baseline retains the terminal cursor and reconciliation inventory",
    result.proposed_cursor === "cursor-1" && result.authoritative_snapshot === true && result.cursor_can_advance === true);
}

{
  const result = await syncDropbox({
    accessToken: "token",
    fetchImpl: async (url) => String(url).includes("files/download")
      ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } })
      : json({ entries: [{
        ".tag": "file", id: "id:binary", name: "archive.bin", path_lower: "/archive.bin",
        server_modified: "2026-08-05T00:00:00Z",
      }], cursor: "cursor-gap", has_more: false }),
  });
  check("a Dropbox body extraction gap withholds its cursor so the unchanged file can be retried",
    result.outcome.kind === "partial" && result.snapshot_source_ids[0] === "path:/archive.bin" &&
    result.cursor_can_advance === false);
}

{
  const result = await syncHubSpot({
    accessToken: "token", objectTypes: ["contacts"],
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.searchParams.get("archived") === "true") {
        return json({ results: [{ id: "gone", archived: true }] });
      }
      return json({ results: [{
        id: "1", properties: { firstname: "Alex", lastname: "Example", email: "alex@example.invalid" },
        updatedAt: "2026-08-06T00:00:00Z",
      }] });
    },
  });
  check("HubSpot emits stable object documents and archived tombstones",
    result.documents[0].source_id === "contacts:1" && result.deletions[0].source_id === "contacts:gone");
  check("HubSpot names permanent-deletion uncertainty", result.outcome.kind === "partial" && result.deletion_authority === "unavailable");
}

console.log(`\nprovider connectors: all ${ran} checks passed`);
