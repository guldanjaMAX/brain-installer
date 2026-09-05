/**
 * Credential-free Worker fixture for local resume-integrity command tests.
 * Durable evidence lets sequential CLI processes simulate D1 being forgotten
 * or restored without contacting an account or retaining source content.
 */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const evidencePath = String(process.env.BRAIN_LOCAL_RESUME_EVIDENCE || "");
const userRoot = String(process.env.BRAIN_LOCAL_RESUME_USER_ROOT || "");
if (!evidencePath) throw new Error("BRAIN_LOCAL_RESUME_EVIDENCE is required");
if (!userRoot) throw new Error("BRAIN_LOCAL_RESUME_USER_ROOT is required");

os.homedir = () => userRoot;
syncBuiltinESMExports();

const blankEvidence = () => ({
  stored_families: [],
  inventory_reads: 0,
  ingest_batches: 0,
  ingested_documents: 0,
  reconciliation_requests: 0,
  source_receipts: 0,
});

function readEvidence() {
  try {
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    return { ...blankEvidence(), ...parsed };
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

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function requestBody(options) {
  return JSON.parse(String(options.body || "{}"));
}

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);
  if (url.hostname !== "fixture.invalid") {
    throw new Error(`unexpected external request: ${url.origin}${url.pathname}`);
  }

  if (url.pathname === "/api/admin/brain/source-families") {
    const request = requestBody(options);
    const evidence = readEvidence();
    evidence.inventory_reads++;
    saveEvidence(evidence);
    const families = [...new Set(evidence.stored_families.map(String))]
      .filter((uid) => uid.startsWith(`${request.source}:`))
      .sort();
    return json({ source: request.source, families, next_cursor: null });
  }

  if (url.pathname === "/api/admin/brain/ingest/batch") {
    const request = requestBody(options);
    if (!Array.isArray(request.docs) || !request.docs.length) {
      throw new Error("the resume fixture received an empty ingest batch");
    }
    const evidence = readEvidence();
    evidence.ingest_batches++;
    evidence.ingested_documents += request.docs.length;
    const stored = new Set(evidence.stored_families.map(String));
    for (const doc of request.docs) {
      const family = String(doc?.metadata?.family_of || doc?.metadata?.part_of ||
        `${doc?.source_type || ""}:${doc?.source_id || ""}`);
      if (!family.includes(":")) throw new Error("the resume fixture received an invalid document identity");
      stored.add(family);
    }
    evidence.stored_families = [...stored].sort();
    saveEvidence(evidence);
    return json({
      results: request.docs.map((doc) => ({ source_id: doc.source_id, status: "created" })),
    });
  }

  if (url.pathname === "/api/admin/brain/forget") {
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

  if (url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = requestBody(options);
    const evidence = readEvidence();
    evidence.source_receipts++;
    saveEvidence(evidence);
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.pathname === "/api/admin/brain/documents") {
    const evidence = readEvidence();
    const count = evidence.stored_families.length;
    return json({
      backend: "d1",
      rows: [{ source_type: "upload", documents: count, chunks: count }],
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

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.pathname}`);
};
