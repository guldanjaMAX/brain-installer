/**
 * Offline Worker, socket, and state-observation fixture for IMAP scanner
 * migration cleanup. Every mailbox identity and credential-shaped value used
 * by the caller is synthetic.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const evidencePath = String(process.env.BRAIN_IMAP_SCANNER_EVIDENCE_PATH || "");
const userRoot = String(process.env.BRAIN_IMAP_SCANNER_USER_ROOT || "");
const statePath = resolve(String(process.env.BRAIN_IMAP_SCANNER_STATE_PATH || ""));
const imapPort = Number(process.env.BRAIN_IMAP_SCANNER_PORT || 0);
const run = Number(process.env.BRAIN_IMAP_SCANNER_RUN || 0);
if (!evidencePath || !userRoot || !statePath || !Number.isInteger(imapPort) || imapPort < 1 || run < 1) {
  throw new Error("the IMAP scanner-removal fixture is not configured");
}

const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);

const blank = () => ({ stored_families: [], ingested_ids: [], forget_targets: [], events: [] });
const readEvidence = () => {
  try { return { ...blank(), ...JSON.parse(originalReadFileSync(evidencePath, "utf8")) }; }
  catch (error) { if (error?.code === "ENOENT") return blank(); throw error; }
};
const saveEvidence = (value) => {
  originalWriteFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
const updateEvidence = (mutate) => {
  const evidence = readEvidence();
  mutate(evidence);
  saveEvidence(evidence);
};
const event = (kind, detail = {}) => updateEvidence((evidence) => {
  evidence.events.push({ run, kind, ...detail });
});

// Production uses implicit TLS. This fixture preserves the production client's
// command path while routing its socket to the local scripted plaintext server.
tls.connect = () => net.connect({ host: "127.0.0.1", port: imapPort });
os.homedir = () => userRoot;

// Observe atomic state replacements. The test can then prove the authenticated
// post-delete inventory read happened before the scanner fingerprint and IMAP
// watermark were committed, rather than merely proving both happened sometime.
fs.renameSync = (from, to) => {
  let snapshot = null;
  if (resolve(String(to)) === statePath) {
    try { snapshot = JSON.parse(originalReadFileSync(from, "utf8")); } catch { /* product write remains authoritative */ }
  }
  const result = originalRenameSync(from, to);
  if (snapshot) {
    event("state_write", {
      scanner_fingerprint: snapshot.credential_scanner_fingerprint || null,
      inbox_last_uid: snapshot.imap_folders?.INBOX?.last_uid ?? null,
      has_removal_baseline: Object.keys(snapshot).some((key) =>
        key.includes("imap") && key.includes("removal") && key.includes("baseline")),
    });
  }
  return result;
};

syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const bodyOf = (options) => JSON.parse(String(options.body || "{}"));
const requestUrl = (input) => new URL(
  typeof input === "string" || input instanceof URL ? String(input) : input.url,
);

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);
  if (url.hostname !== "fixture.invalid") {
    throw new Error(`the IMAP scanner-removal fixture refused an external request to ${url.hostname}`);
  }

  if (url.pathname === "/api/admin/brain/source-families") {
    const request = bodyOf(options);
    const evidence = readEvidence();
    const ordered = [...new Set(evidence.stored_families)].sort();
    const after = String(request.cursor || "");
    const remaining = after ? ordered.filter((uid) => uid > after) : ordered;
    const page = remaining.slice(0, 1000);
    const next = remaining.length > page.length ? page.at(-1) : null;
    event("source_families", { stored: ordered.length });
    return json({ source: request.source, families: page, next_cursor: next });
  }

  if (url.pathname === "/api/admin/brain/ingest/batch") {
    const docs = bodyOf(options).docs || [];
    updateEvidence((evidence) => {
      const stored = new Set(evidence.stored_families);
      for (const doc of docs) {
        const uid = `${doc.source_type}:${doc.source_id}`;
        stored.add(uid);
        evidence.ingested_ids.push(doc.source_id);
      }
      evidence.stored_families = [...stored].sort();
      evidence.events.push({ run, kind: "ingest", count: docs.length });
    });
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
    const families = bodyOf(options).families || [];
    const deletions = families.filter((family) =>
      Array.isArray(family.keep_doc_uids) && family.keep_doc_uids.length === 0);
    const acknowledged = [];
    updateEvidence((evidence) => {
      const stored = new Set(evidence.stored_families);
      for (const family of deletions) {
        if (stored.delete(family.base_doc_uid)) acknowledged.push(family.base_doc_uid);
      }
      evidence.stored_families = [...stored].sort();
      evidence.forget_targets.push(...acknowledged);
      evidence.events.push({
        run,
        kind: deletions.length ? "forget" : "reconcile",
        requested: deletions.length || families.length,
        acknowledged: acknowledged.length,
      });
    });
    return json({
      dry_run: false,
      documents: acknowledged.length,
      chunks: acknowledged.length,
      vectors: acknowledged.length,
      targets: acknowledged,
    });
  }

  if (url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = bodyOf(options);
    event("receipt", {
      status: receipt.status,
      ...(receipt.detail ? { detail: receipt.detail } : {}),
      ...(receipt.issue_code ? { issue_code: receipt.issue_code } : {}),
    });
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0 } });
  }

  throw new Error(`unexpected IMAP scanner-removal request: ${options.method || "GET"} ${url.pathname}`);
};
