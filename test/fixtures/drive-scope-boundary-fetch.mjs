/** Offline Drive fixture for rooted-change and absence-classification safety. */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_DRIVE_SCOPE_USER_ROOT || "");
const evidencePath = String(process.env.BRAIN_DRIVE_SCOPE_EVIDENCE || "");
const mode = String(process.env.BRAIN_DRIVE_SCOPE_MODE || "");
const MODES = new Set([
  "changed-outside",
  "full-unresolved",
  "incremental-unresolved",
  "incremental-trash",
  "incremental-left-scope",
]);
if (!userRoot) throw new Error("BRAIN_DRIVE_SCOPE_USER_ROOT is required");
if (!evidencePath) throw new Error("BRAIN_DRIVE_SCOPE_EVIDENCE is required");
if (!MODES.has(mode)) throw new Error("BRAIN_DRIVE_SCOPE_MODE is invalid");

os.homedir = () => userRoot;
syncBuiltinESMExports();

const ROOT_ID = "root-fixture";
const MISSING_ID = "missing-sensitive";
const MISSING_UID = `drive:${MISSING_ID}`;
const RETAINED_UIDS = Array.from({ length: 10 }, (_, index) =>
  `drive:retained-${String(index).padStart(2, "0")}`
);

const blankEvidence = () => ({
  changesReads: 0,
  rootedWalks: 0,
  absenceMetadataReads: 0,
  outsideContentReads: 0,
  inventoryReads: 0,
  ingestBatchWrites: 0,
  forgetRequests: 0,
  removedFamilies: 0,
  receipts: { indexing: 0, error: 0, ready: 0 },
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
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function requestBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

function storedFamilies(evidence) {
  if (mode === "changed-outside") return [];
  if (["full-unresolved", "incremental-unresolved"].includes(mode)) return [MISSING_UID];
  return evidence.removedFamilies ? RETAINED_UIDS : [MISSING_UID, ...RETAINED_UIDS].sort();
}

function changedOutsideFile() {
  return {
    id: "outside-file",
    name: "Outside reviewed roots.txt",
    mimeType: "text/plain",
    size: "240",
    createdTime: "2026-01-01T00:00:00Z",
    modifiedTime: "2026-09-01T00:00:00Z",
    md5Checksum: "outside-version",
    trashed: false,
    parents: ["outside-folder"],
  };
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: `fixture-prewalk-${mode}` });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes") {
    const evidence = readEvidence();
    evidence.changesReads++;
    saveEvidence(evidence);
    if (mode === "changed-outside") {
      return json({
        changes: [{ fileId: "outside-file", file: changedOutsideFile() }],
        newStartPageToken: "fixture-next-changed-outside",
      });
    }
    if (mode.startsWith("incremental-")) {
      return json({
        changes: [{ fileId: MISSING_ID, removed: true }],
        newStartPageToken: `fixture-next-${mode}`,
      });
    }
    throw new Error("a forced full-sweep fixture reached the changes feed");
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${ROOT_ID}`) {
    return json({
      id: ROOT_ID,
      name: "Reviewed Root",
      mimeType: "application/vnd.google-apps.folder",
      trashed: false,
      parents: [],
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    const query = String(url.searchParams.get("q") || "");
    if (!query.includes(`'${ROOT_ID}' in parents`)) {
      throw new Error("Drive ingest attempted an unscoped account-wide listing");
    }
    const evidence = readEvidence();
    evidence.rootedWalks++;
    saveEvidence(evidence);
    return json({ files: [], nextPageToken: null, incompleteSearch: false });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === `/drive/v3/files/${MISSING_ID}`) {
    const evidence = readEvidence();
    evidence.absenceMetadataReads++;
    saveEvidence(evidence);
    if (mode === "full-unresolved" || mode === "incremental-unresolved") {
      return json({ error: { message: "not found" } }, 404);
    }
    if (mode === "incremental-trash") {
      return json({
        id: MISSING_ID,
        name: "Removed fixture.txt",
        mimeType: "text/plain",
        trashed: true,
        parents: [ROOT_ID],
      });
    }
    if (mode === "incremental-left-scope") {
      return json({
        id: MISSING_ID,
        name: "Moved fixture.txt",
        mimeType: "text/plain",
        trashed: false,
        parents: ["outside-folder"],
      });
    }
    throw new Error("an unrelated changed item reached absence classification");
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/outside-file") {
    const evidence = readEvidence();
    evidence.outsideContentReads++;
    saveEvidence(evidence);
    throw new Error("an out-of-root changed file reached the content boundary");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = requestBody(options);
    if (request.source !== "drive") throw new Error("fixture received the wrong source inventory request");
    const evidence = readEvidence();
    evidence.inventoryReads++;
    saveEvidence(evidence);
    return json({ source: "drive", families: storedFamilies(evidence), next_cursor: null });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = requestBody(options);
    const families = Array.isArray(request.families) ? request.families : [];
    const evidence = readEvidence();
    evidence.forgetRequests++;
    if (!["incremental-trash", "incremental-left-scope"].includes(mode) ||
        request.confirm !== true || families.length !== 1 ||
        families[0]?.base_doc_uid !== MISSING_UID ||
        !Array.isArray(families[0]?.keep_doc_uids) || families[0].keep_doc_uids.length !== 0) {
      saveEvidence(evidence);
      throw new Error("fixture received an unsafe absence removal");
    }
    evidence.removedFamilies = 1;
    saveEvidence(evidence);
    return json({
      dry_run: false,
      documents: 1,
      chunks: 1,
      vectors: 1,
      targets: [MISSING_UID],
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const evidence = readEvidence();
    evidence.ingestBatchWrites++;
    saveEvidence(evidence);
    throw new Error("scope-boundary fixture must not send an ingest batch");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = requestBody(options);
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
