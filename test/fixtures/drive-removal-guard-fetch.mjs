/**
 * Offline network fixture for the command-level Drive removal guard test.
 *
 * Node imports this file before brain.mjs. Every Google and Worker request is
 * therefore answered in-process, while a small aggregate evidence file lets
 * sequential CLI processes observe the same simulated Worker state. Evidence
 * deliberately stores counts only, never document identifiers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const userRoot = String(process.env.BRAIN_DRIVE_GUARD_USER_ROOT || "");
const evidencePath = String(process.env.BRAIN_DRIVE_GUARD_EVIDENCE || "");
if (!userRoot) throw new Error("BRAIN_DRIVE_GUARD_USER_ROOT is required");
if (!evidencePath) throw new Error("BRAIN_DRIVE_GUARD_EVIDENCE is required");

// Keep token storage and support notes inside the disposable test directory.
os.homedir = () => userRoot;
syncBuiltinESMExports();

const FAMILY_COUNT = 101;
const FAMILY_PREFIX = "drive:guard-family-";
const familyUid = (index) => `${FAMILY_PREFIX}${String(index).padStart(4, "0")}`;

const initialEvidence = () => ({
  forgetRequests: 0,
  removalRequests: 0,
  reconciliationRequests: 0,
  successfulRemovalFamilies: 0,
  failedRemovalFamilies: 0,
  failureInjected: false,
  inventoryReads: 0,
  ingestBatchWrites: 0,
  receipts: { indexing: 0, error: 0, ready: 0 },
});

function readEvidence() {
  try {
    return { ...initialEvidence(), ...JSON.parse(readFileSync(evidencePath, "utf8")) };
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

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function parseBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

function familyIndex(uid) {
  const match = /^drive:guard-family-(\d{4})$/.exec(String(uid || ""));
  const index = match ? Number(match[1]) : -1;
  return Number.isInteger(index) && index >= 0 && index < FAMILY_COUNT ? index : -1;
}

function isExactRange(indexes, start, count) {
  return indexes.length === count && indexes.every((value, offset) => value === start + offset);
}

function storedFamilyIndexes(evidence) {
  if (evidence.successfulRemovalFamilies === 0) {
    return Array.from({ length: FAMILY_COUNT }, (_, index) => index);
  }
  // The injected first-group failure leaves 0..49 stored while the following
  // two groups succeed. The retry must inventory those remaining families and
  // pass them through a newly fingerprinted approval plan.
  if (evidence.failureInjected && evidence.successfulRemovalFamilies === 51) {
    return Array.from({ length: 50 }, (_, index) => index);
  }
  if (evidence.successfulRemovalFamilies === FAMILY_COUNT) return [];
  throw new Error("fixture removal state is inconsistent");
}

function acceptedForget(families, evidence) {
  evidence.successfulRemovalFamilies += families.length;
  saveEvidence(evidence);
  return json({
    dry_run: false,
    documents: families.length,
    chunks: families.length,
    vectors: families.length,
    targets: families.map((family) => family.base_doc_uid),
  });
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes/startPageToken") {
    return json({ startPageToken: "fixture-next-cursor" });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/changes") {
    // The configured root disappeared from the change feed. The command must
    // expand this incremental tick to a complete comparison before it may use
    // absence as deletion evidence or advance the cursor.
    return json({
      changes: [{ fileId: "fixture-allowed-root", removed: true }],
      newStartPageToken: "fixture-change-cursor",
    });
  }

  if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
    return json({ files: [], nextPageToken: null, incompleteSearch: false });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = parseBody(options);
    const evidence = readEvidence();
    evidence.inventoryReads++;
    saveEvidence(evidence);
    return json({
      source: request.source,
      families: storedFamilyIndexes(evidence).map(familyUid),
      next_cursor: null,
    });
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = parseBody(options);
    const families = Array.isArray(request.families) ? request.families : [];
    const indexes = families.map((family) => familyIndex(family?.base_doc_uid));
    if (!families.length || indexes.includes(-1) || request.confirm !== true) {
      throw new Error("fixture received an invalid forget request");
    }

    const evidence = readEvidence();
    evidence.forgetRequests++;
    const removals = families.every((family) =>
      Array.isArray(family?.keep_doc_uids) && family.keep_doc_uids.length === 0
    );
    const reconciliations = families.every((family) =>
      Array.isArray(family?.keep_doc_uids) && family.keep_doc_uids.length > 0
    );
    if (!removals && !reconciliations) throw new Error("fixture received a mixed forget request");
    if (reconciliations) {
      evidence.reconciliationRequests++;
      saveEvidence(evidence);
      return acceptedForget(families, evidence);
    }

    evidence.removalRequests++;
    if (!evidence.failureInjected) {
      if (!isExactRange(indexes, 0, 50)) throw new Error("fixture received an unexpected first removal group");
      evidence.failureInjected = true;
      evidence.failedRemovalFamilies += families.length;
      saveEvidence(evidence);
      return json({ error: "synthetic removal failure" }, 503);
    }
    if (evidence.successfulRemovalFamilies === 0) {
      if (!isExactRange(indexes, 50, 50)) throw new Error("fixture received an unexpected second removal group");
      return acceptedForget(families, evidence);
    }
    if (evidence.successfulRemovalFamilies === 50) {
      if (!isExactRange(indexes, 100, 1)) throw new Error("fixture received an unexpected third removal group");
      return acceptedForget(families, evidence);
    }
    if (evidence.successfulRemovalFamilies === 51) {
      if (!isExactRange(indexes, 0, 50)) throw new Error("fixture received an unexpected retry removal group");
      return acceptedForget(families, evidence);
    }
    throw new Error("fixture received a removal after completion");
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const evidence = readEvidence();
    evidence.ingestBatchWrites++;
    saveEvidence(evidence);
    throw new Error("the empty Drive walk must not send an ingest batch");
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
