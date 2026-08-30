/** Offline fixture for version-aware active Drive skip handling. */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_DRIVE_SKIP_USER_ROOT || "");
const evidencePath = String(process.env.BRAIN_DRIVE_SKIP_EVIDENCE || "");
if (!userRoot) throw new Error("BRAIN_DRIVE_SKIP_USER_ROOT is required");
if (!evidencePath) throw new Error("BRAIN_DRIVE_SKIP_EVIDENCE is required");

os.homedir = () => userRoot;
syncBuiltinESMExports();

const MIGRATED = "drive:active-migrated";
const STALE = "drive:active-stale";
const SENSITIVE = "drive:active-sensitive";
const MISSING = "drive:source-missing";
const ALLOWED_REMOVALS = new Set([STALE, SENSITIVE, MISSING]);

const initialEvidence = () => ({
  forgetRequests: 0,
  removedFamilies: 0,
  inventoryReads: 0,
  ingestBatchWrites: 0,
  retainedFamilyReachedForget: false,
  receipts: { indexing: 0, error: 0, ready: 0 },
});

function readEvidence() {
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    return { ...initialEvidence(), ...parsed, receipts: { ...initialEvidence().receipts, ...(parsed.receipts || {}) } };
  } catch (error) {
    if (error?.code === "ENOENT") return initialEvidence();
    throw error;
  }
}

function saveEvidence(evidence) {
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function raw(body) {
  return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function parseBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

function files() {
  return [
    {
      id: "active-migrated", name: "migrated.bin", mimeType: "application/octet-stream", size: "200",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-20T00:00:00Z", md5Checksum: "migrated-current",
    },
    {
      id: "active-stale", name: "changed.bin", mimeType: "application/octet-stream", size: "200",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-21T00:00:00Z", md5Checksum: "stale-current",
    },
    {
      id: "active-sensitive", name: "sensitive.txt", mimeType: "text/plain", size: "300",
      createdTime: "2025-01-01T00:00:00Z", modifiedTime: "2026-08-22T00:00:00Z", md5Checksum: "sensitive-current",
    },
  ];
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: "fixture-skip-next-cursor" });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes") {
    return json({ changes: [], newStartPageToken: "fixture-skip-no-change-cursor" });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    return json({ files: files(), nextPageToken: null, incompleteSearch: false });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/active-sensitive") {
    // Invented test-only credential shape. The fixture never writes it to its
    // evidence file or returns it from the connector.
    return raw(`Operations note with enough ordinary prose to pass quality. Temporary access key: AKIA${"Z".repeat(16)}.`);
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const evidence = readEvidence();
    evidence.inventoryReads++;
    saveEvidence(evidence);
    const families = evidence.removedFamilies
      ? [MIGRATED]
      : [MIGRATED, STALE, SENSITIVE, MISSING].sort();
    return json({ source: parseBody(options).source, families, next_cursor: null });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = parseBody(options);
    const families = (request.families || []).map((family) => String(family?.base_doc_uid || ""));
    const evidence = readEvidence();
    evidence.forgetRequests++;
    if (families.includes(MIGRATED)) evidence.retainedFamilyReachedForget = true;
    if (!families.length || request.confirm !== true || families.some((uid) => !ALLOWED_REMOVALS.has(uid))) {
      saveEvidence(evidence);
      throw new Error("fixture received an unsafe active-skip removal");
    }
    evidence.removedFamilies += families.length;
    saveEvidence(evidence);
    return json({
      dry_run: false,
      documents: families.length,
      chunks: families.length,
      vectors: families.length,
      targets: families,
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const evidence = readEvidence();
    evidence.ingestBatchWrites++;
    saveEvidence(evidence);
    throw new Error("active skip fixture must not send an ingest batch");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = parseBody(options);
    const evidence = readEvidence();
    if (Object.hasOwn(evidence.receipts, receipt.status)) evidence.receipts[receipt.status]++;
    saveEvidence(evidence);
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0 } });
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
