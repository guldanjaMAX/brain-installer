/*
 * Credential-free Worker fixture for the IMAP CLI completion boundary.
 *
 * Loaded with `node --import`, this keeps every data-plane request inside the
 * child process and records only aggregate receipts. The scripted IMAP server
 * itself still runs over a real local TLS socket in imap-connector.test.mjs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const evidencePath = String(process.env.BRAIN_IMAP_LOAD_EVIDENCE_PATH || "");
const userRoot = String(process.env.BRAIN_IMAP_LOAD_USER_ROOT || "");
if (!evidencePath || !userRoot) {
  throw new Error("the IMAP load fixture needs isolated evidence and user roots");
}

// Product credential storage calls os.homedir(), not a caller-provided path.
// Redirect that lookup before product modules load so this child cannot inspect
// the developer's real IMAP store or support journal.
os.homedir = () => userRoot;
syncBuiltinESMExports();

const readEvidence = () => {
  try { return JSON.parse(readFileSync(evidencePath, "utf8")); }
  catch { return { receipts: [], ingested: 0, reconciliations: 0 }; }
};
const updateEvidence = (mutate) => {
  const evidence = readEvidence();
  mutate(evidence);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const requestUrl = (input) => new URL(
  typeof input === "string" || input instanceof URL ? String(input) : input.url,
);

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);
  if (url.hostname !== "fixture.invalid") {
    throw new Error(`the IMAP load fixture refused an external request to ${url.hostname}`);
  }

  if (url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = JSON.parse(String(options.body || "{}"));
    updateEvidence((evidence) => evidence.receipts.push(receipt));
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.pathname === "/api/admin/brain/ingest/batch") {
    const docs = JSON.parse(String(options.body || "{}")).docs || [];
    updateEvidence((evidence) => { evidence.ingested += docs.length; });
    return json({
      created: docs.length,
      updated: 0,
      unchanged: 0,
      refused: 0,
      failed: 0,
      results: docs.map((doc) => ({ source_id: doc.source_id, status: "created" })),
    });
  }

  if (url.pathname === "/api/admin/brain/forget") {
    updateEvidence((evidence) => { evidence.reconciliations += 1; });
    return json({ dry_run: false, documents: 0, chunks: 0, vectors: 0, targets: [] });
  }

  // Backlog reporting is deliberately best-effort after a successful ingest.
  // This response is complete enough to keep the CLI on its normal path while
  // the test remains about source health and cursor custody, not Vectorize.
  if (url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0 } });
  }

  throw new Error(`unexpected IMAP load fixture request: ${options.method || "GET"} ${url.pathname}`);
};
