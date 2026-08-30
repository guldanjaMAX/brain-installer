/** Installed credential-free rehearsal for provider adapter code. */

import { quickBooksCompanyFingerprint, syncQuickBooksOnline } from "./quickbooks-online.mjs";
import { syncSlack } from "./slack.mjs";
import { syncNotion } from "./notion.mjs";
import { syncMicrosoftGraph } from "./microsoft-graph.mjs";
import { syncDropbox } from "./dropbox.mjs";
import { syncHubSpot } from "./hubspot.mjs";

const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});
const textResponse = (value, mediaType = "text/plain") => new Response(value, {
  headers: { "content-type": mediaType },
});
function expect(value, code) {
  if (!value) throw Object.assign(new Error(`offline rehearsal assertion failed: ${code}`), { code });
}

const SCENARIOS = Object.freeze([
  Object.freeze({
    id: "quickbooks", label: "QuickBooks pagination and provenance",
    run: async () => {
      const result = await syncQuickBooksOnline({
        realmId: "offline-company", accessToken: "offline-token", entities: ["Invoice"],
        snapshotAt: "2026-01-01T00:00:00.000Z",
        fetchImpl: async (url) => {
          expect(new URL(url).pathname.includes("/company/offline-company/query"), "qbo_company_scope");
          return response({ QueryResponse: { Invoice: [{
            Id: "17", DocNumber: "INV-17", TxnDate: "2026-01-01", TotalAmt: 125,
            MetaData: { LastUpdatedTime: "2026-01-02T00:00:00.000Z" },
          }], maxResults: 1 } });
        },
      });
      const companyFingerprint = quickBooksCompanyFingerprint("offline-company");
      expect(
        result.documents[0]?.source_id === `company:${companyFingerprint}:invoice:17` &&
        result.documents[0]?.metadata?.qbo_company_fingerprint === companyFingerprint,
        "qbo_identity",
      );
      expect(result.outcome.kind === "partial" && !result.cursor_can_advance, "qbo_deletion_truth");
    },
  }),
  Object.freeze({
    id: "slack", label: "Slack message and thread identity",
    run: async () => {
      const result = await syncSlack({
        accessToken: "offline-token",
        fetchImpl: async (url) => String(url).includes("conversations.list")
          ? response({ ok: true, channels: [{ id: "C1", name: "offline" }], response_metadata: { next_cursor: "" } })
          : response({ ok: true, messages: [
            { ts: "2.000000", user: "U2", text: "Second invented message" },
            { ts: "1.000000", user: "U1", text: "First invented message" },
          ], response_metadata: { next_cursor: "" } }),
      });
      expect(result.documents.map((item) => item.source_id).join(",") === "message:C1:1.000000,message:C1:2.000000", "slack_identity_order");
      expect(result.outcome.kind === "partial", "slack_deletion_truth");
    },
  }),
  Object.freeze({
    id: "notion", label: "Notion recursive readable blocks",
    run: async () => {
      const result = await syncNotion({
        accessToken: "offline-token",
        fetchImpl: async (url) => String(url).endsWith("/search")
          ? response({ results: [{
            id: "page-1", url: "https://example.invalid/offline-page",
            last_edited_time: "2026-01-03T00:00:00.000Z",
            properties: { Name: { type: "title", title: [{ plain_text: "Invented plan" }] } },
          }], has_more: false })
          : response({ results: [{
            id: "block-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Invented body" }] }, has_children: false,
          }], has_more: false }),
      });
      expect(result.documents[0]?.content.includes("Invented body"), "notion_content");
      expect(result.outcome.kind === "partial", "notion_deletion_truth");
    },
  }),
  Object.freeze({
    id: "microsoft", label: "Microsoft Outlook delta and drive body",
    run: async () => {
      const result = await syncMicrosoftGraph({
        accessToken: "offline-token", includePersonalDrive: false, driveIds: ["D1"],
        fetchImpl: async (url) => {
          const target = String(url);
          if (target.includes("/mailFolders/inbox/messages/delta")) return response({ value: [{
            id: "m1", subject: "Invented mail", body: { contentType: "text", content: "Invented mail body" },
            receivedDateTime: "2026-01-04T00:00:00.000Z",
          }], "@odata.deltaLink": "https://graph.microsoft.com/offline-mail-delta" });
          if (target.includes("/drives/D1/root/delta")) return response({ value: [{
            id: "f1", name: "Plan.txt", file: { mimeType: "text/plain" },
            "@microsoft.graph.downloadUrl": "https://offline.sharepoint.com/download?invented=1",
          }], "@odata.deltaLink": "https://graph.microsoft.com/offline-drive-delta" });
          if (target.startsWith("https://offline.sharepoint.com/")) return textResponse("Invented drive body");
          throw Object.assign(new Error("unexpected Microsoft rehearsal URL"), { code: "microsoft_url" });
        },
      });
      expect(result.documents.some((item) => item.content.includes("Invented drive body")), "microsoft_drive_body");
      expect(result.authoritative_snapshot && result.cursor_can_advance, "microsoft_cursor_truth");
    },
  }),
  Object.freeze({
    id: "dropbox", label: "Dropbox cursor, deletion, and file body",
    run: async () => {
      const result = await syncDropbox({
        accessToken: "offline-token",
        fetchImpl: async (url) => String(url).includes("files/download")
          ? textResponse("Invented Dropbox body")
          : response({ entries: [
            { ".tag": "file", id: "id:plan", name: "Plan.txt", path_lower: "/plan.txt", server_modified: "2026-01-05T00:00:00.000Z" },
            { ".tag": "deleted", path_lower: "/gone.txt" },
          ], cursor: "offline-cursor", has_more: false }),
      });
      expect(result.documents[0]?.content.includes("Invented Dropbox body"), "dropbox_body");
      expect(result.deletions[0]?.source_id === "path:/gone.txt" && result.cursor_can_advance, "dropbox_cursor_truth");
    },
  }),
  Object.freeze({
    id: "hubspot", label: "HubSpot active and archived objects",
    run: async () => {
      const result = await syncHubSpot({
        accessToken: "offline-token", objectTypes: ["contacts"],
        fetchImpl: async (url) => new URL(url).searchParams.get("archived") === "true"
          ? response({ results: [{ id: "gone", archived: true }] })
          : response({ results: [{ id: "1", properties: { firstname: "Invented" }, updatedAt: "2026-01-06T00:00:00.000Z" }] }),
      });
      expect(result.documents[0]?.source_id === "contacts:1" && result.deletions[0]?.source_id === "contacts:gone", "hubspot_identity");
      expect(result.outcome.kind === "partial", "hubspot_deletion_truth");
    },
  }),
]);

export function providerRehearsalScenarios() {
  return SCENARIOS.map(({ id, label }) => ({ id, label }));
}

export async function runProviderRehearsal({ provider = null } = {}) {
  const wanted = provider === null ? null : String(provider).trim().toLowerCase();
  const selected = wanted ? SCENARIOS.filter((scenario) => scenario.id === wanted) : SCENARIOS;
  if (wanted && !selected.length) {
    throw Object.assign(new Error(`connector ${wanted} has no installed offline rehearsal`), { code: "CONFIG_INVALID" });
  }
  const results = [];
  for (const scenario of selected) {
    const started = Date.now();
    try {
      await scenario.run();
      results.push({ id: scenario.id, label: scenario.label, passed: true, duration_ms: Date.now() - started, code: null });
    } catch (error) {
      results.push({
        id: scenario.id, label: scenario.label, passed: false, duration_ms: Date.now() - started,
        code: /^[a-z0-9_]{1,80}$/i.test(String(error?.code || "")) ? String(error.code) : "scenario_failed",
      });
    }
  }
  return Object.freeze({
    proof_level: "offline_invented_data",
    network_used: false, credentials_read: false, customer_data_read: false,
    passed: results.every((result) => result.passed), results, field_gate_still_required: true,
  });
}

export function renderProviderRehearsal(receipt) {
  const lines = receipt.results.map((result) =>
    `${result.passed ? "PASS" : "FAIL"}  ${result.label}${result.passed ? "" : ` (${result.code})`}`);
  lines.push("");
  lines.push(receipt.passed
    ? `All ${receipt.results.length} selected provider rehearsal(s) passed.`
    : `${receipt.results.filter((result) => !result.passed).length} selected provider rehearsal(s) failed.`);
  lines.push("Proof level: invented offline responses only. No provider sign-in, network request, credential store, manifest, state file, or customer document was used.");
  lines.push("Next gate: complete the named real-account acceptance test before describing any provider connection as proven.");
  return lines.join("\n");
}
