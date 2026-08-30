/**
 * Offline Google Drive + Worker fixture for command-level incomplete coverage.
 *
 * The `incomplete` mode exports one invented multi-tab Google Sheet as XLSX;
 * one tab exceeds the reviewed per-sheet row limit. The `policy` mode exposes
 * only one exact file-id exclusion. No request may leave these synthetic hosts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import * as XLSX from "@e965/xlsx";

const evidencePath = String(process.env.BRAIN_DRIVE_INCOMPLETE_EVIDENCE || "");
const userRoot = String(process.env.BRAIN_DRIVE_INCOMPLETE_USER_ROOT || "");
const mode = String(process.env.BRAIN_DRIVE_INCOMPLETE_MODE || "");
if (!evidencePath) throw new Error("BRAIN_DRIVE_INCOMPLETE_EVIDENCE is required");
if (!userRoot) throw new Error("BRAIN_DRIVE_INCOMPLETE_USER_ROOT is required");
if (!["incomplete", "policy"].includes(mode)) throw new Error("BRAIN_DRIVE_INCOMPLETE_MODE is invalid");

os.homedir = () => userRoot;
syncBuiltinESMExports();

const ROOT_ID = "fixture-root";
const SHEET_ID = "incomplete-sheet";
const POLICY_ID = "policy-file";

const blankEvidence = () => ({
  stored_families: [],
  exports: 0,
  ingest_batches: 0,
  ingested_documents: 0,
  incomplete_envelopes: 0,
  inventory_reads: 0,
  reconciliation_requests: 0,
  unexpected_content_fetches: 0,
  receipts: { indexing: 0, error: 0, ready: 0 },
  last_final_receipt: null,
});

function readEvidence() {
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    return {
      ...blankEvidence(),
      ...parsed,
      receipts: { ...blankEvidence().receipts, ...(parsed.receipts || {}) },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return blankEvidence();
    throw error;
  }
}

function saveEvidence(evidence) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function raw(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function requestBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

function root() {
  return {
    id: ROOT_ID,
    name: "Reviewed Root",
    mimeType: "application/vnd.google-apps.folder",
    trashed: false,
    parents: [],
  };
}

function files() {
  if (mode === "policy") {
    return [{
      id: POLICY_ID,
      name: "Excluded by owner policy.txt",
      mimeType: "text/plain",
      size: "240",
      createdTime: "2026-01-01T00:00:00Z",
      modifiedTime: "2026-08-01T00:00:00Z",
      md5Checksum: "fixture-policy-version",
      trashed: false,
      parents: [ROOT_ID],
    }];
  }
  return [{
    id: SHEET_ID,
    name: "Customer history",
    mimeType: "application/vnd.google-apps.spreadsheet",
    size: "180000",
    createdTime: "2026-01-01T00:00:00Z",
    modifiedTime: "2026-08-02T00:00:00Z",
    trashed: false,
    parents: [ROOT_ID],
    webViewLink: "https://docs.google.invalid/spreadsheets/fixture",
  }];
}

function oversizedSheetWorkbook() {
  const rows = [["date", "customer", "amount", "summary"]];
  for (let index = 0; index < 5_002; index++) {
    const day = String((index % 28) + 1).padStart(2, "0");
    rows.push([`2026-07-${day}`, `Customer ${index}`, 100 + index, `Completed reviewed service milestone ${index}`]);
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,
    XLSX.utils.aoa_to_sheet([["Owner", "Status"], ["Fixture owner", "Reviewed"]]), "Summary");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Records");
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: mode === "policy" ? "fixture-policy-next-cursor" : "fixture-incomplete-next-cursor" });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${ROOT_ID}`) {
    return json(root());
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    const query = String(url.searchParams.get("q") || "");
    if (!query.includes(`'${ROOT_ID}' in parents`)) {
      throw new Error("Drive ingest attempted an unscoped account-wide listing");
    }
    return json({ files: files(), nextPageToken: null, incompleteSearch: false });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${SHEET_ID}/export`) {
    const spreadsheetMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (mode !== "incomplete" || url.searchParams.get("mimeType") !== spreadsheetMime) {
      throw new Error("the fixture received an unexpected Drive export");
    }
    const evidence = readEvidence();
    evidence.exports++;
    saveEvidence(evidence);
    return raw(oversizedSheetWorkbook(), spreadsheetMime);
  }

  if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
    const evidence = readEvidence();
    evidence.unexpected_content_fetches++;
    saveEvidence(evidence);
    throw new Error("a policy-excluded Drive file reached the content boundary");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const request = requestBody(options);
    if (mode !== "incomplete" || !Array.isArray(request.docs) || !request.docs.length) {
      throw new Error("the fixture received an unexpected ingest batch");
    }
    const evidence = readEvidence();
    evidence.ingest_batches++;
    evidence.ingested_documents += request.docs.length;
    evidence.incomplete_envelopes += request.docs.filter((doc) => doc?.metadata?.extraction_incomplete === true).length;
    if (evidence.incomplete_envelopes !== evidence.ingested_documents) {
      throw new Error("an incomplete Drive extraction lost its envelope marker");
    }
    evidence.stored_families = [`drive:${SHEET_ID}`];
    saveEvidence(evidence);
    return json({
      results: request.docs.map((doc) => ({ source_id: doc.source_id, status: "created" })),
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = requestBody(options);
    if (request.source !== "drive") throw new Error("the fixture received the wrong source inventory request");
    const evidence = readEvidence();
    evidence.inventory_reads++;
    saveEvidence(evidence);
    return json({ source: "drive", families: evidence.stored_families, next_cursor: null });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = requestBody(options);
    const evidence = readEvidence();
    evidence.reconciliation_requests++;
    saveEvidence(evidence);
    return json({
      dry_run: false,
      documents: 0,
      chunks: 0,
      vectors: 0,
      targets: (request.families || []).map((family) => family.base_doc_uid),
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = requestBody(options);
    const evidence = readEvidence();
    if (Object.hasOwn(evidence.receipts, receipt.status)) evidence.receipts[receipt.status]++;
    if (receipt.status !== "indexing") {
      evidence.last_final_receipt = {
        status: receipt.status,
        walk_complete: receipt.walk_complete,
        error: receipt.error || null,
        detail: receipt.detail || null,
      };
    }
    saveEvidence(evidence);
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
    const count = readEvidence().stored_families.length;
    return json({
      backend: "d1",
      rows: count ? [{ source_type: "drive", documents: count, chunks: count }] : [],
      vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
      vector_readiness: {
        ready: true,
        pending: 0,
        submitted: 0,
        expected_vectors: count,
        actual_vectors: count,
      },
    });
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
