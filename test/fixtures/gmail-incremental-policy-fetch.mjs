/** Offline Gmail incremental-policy and Worker fixture. Invented data only. */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const evidencePath = String(process.env.BRAIN_GMAIL_POLICY_EVIDENCE || "");
const userRoot = String(process.env.BRAIN_GMAIL_POLICY_USER_ROOT || "");
const mode = String(process.env.BRAIN_GMAIL_POLICY_MODE || "");
if (!evidencePath || !userRoot || !["mixed", "unclassified", "resume-progress"].includes(mode)) {
  throw new Error("the Gmail policy fixture is not configured");
}

os.homedir = () => userRoot;
syncBuiltinESMExports();

const blank = () => ({
  ingested_ids: [],
  forget_targets: [],
  receipts: { indexing: 0, ready: 0, error: 0 },
  final_receipt: null,
});
const readEvidence = () => {
  try { return { ...blank(), ...JSON.parse(readFileSync(evidencePath, "utf8")) }; }
  catch (error) { if (error?.code === "ENOENT") return blank(); throw error; }
};
const saveEvidence = (value) => writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const bodyOf = (options) => JSON.parse(String(options.body || "{}"));
const rawMail = (subject, body) => Buffer.from(
  `From: sender@example.invalid\r\nTo: owner@example.invalid\r\nSubject: ${subject}\r\n` +
  "Date: Sat, 29 Aug 2026 12:00:00 -0700\r\n\r\n" + body,
).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/profile") {
    return json({ historyId: "history-current" });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/history") {
    const ids = mode === "mixed" ? ["promotion", "inbox"] : ["unclassified"];
    return json({
      history: [{ id: "history-current", messagesAdded: ids.map((id) => ({ message: { id } })) }],
    });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/messages") {
    if (mode !== "resume-progress") throw new Error("the incremental fixture must use Gmail history");
    return json({
      messages: [
        ...Array.from({ length: 100 }, (_, i) => ({ id: `resume-accepted-${i}` })),
        ...Array.from({ length: 100 }, (_, i) => ({ id: `resume-skipped-${i}` })),
      ],
    });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
    const id = url.pathname.split("/").at(-1);
    if (id.startsWith("resume-accepted-")) {
      return json({
        id, historyId: "resume-v1", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Previously accepted mail", "This invented message was accepted during an earlier part of the same resumable first pass."),
      });
    }
    if (id.startsWith("resume-skipped-")) {
      return json({
        id, historyId: "resume-v1", internalDate: "1788030000000",
        labelIds: ["CATEGORY_PROMOTIONS"],
        raw: rawMail("Previously skipped promotion", "This invented promotion remains excluded by the Gmail source policy."),
      });
    }
    if (id === "promotion") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000",
        labelIds: ["CATEGORY_PROMOTIONS"],
        raw: rawMail("Invented promotion", "This invented promotion must never enter the customer Brain."),
      });
    }
    if (id === "inbox") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Reviewed agreement", "The reviewed agreement confirms the owner, timing, scope, price, and next milestone."),
      });
    }
    if (id === "unclassified") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000",
        raw: rawMail("Unclassified mail", "This message has useful invented content but no trustworthy Gmail label evidence."),
      });
    }
  }

  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/ingest/batch") {
    const request = bodyOf(options);
    const evidence = readEvidence();
    evidence.ingested_ids.push(...request.docs.map((doc) => doc.source_id));
    saveEvidence(evidence);
    return json({ results: request.docs.map((doc) => ({ source_id: doc.source_id, status: "created" })) });
  }
  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/forget") {
    const request = bodyOf(options);
    const evidence = readEvidence();
    evidence.forget_targets.push(...(request.families || []).map((item) => item.base_doc_uid));
    saveEvidence(evidence);
    return json({
      dry_run: false, documents: 0, chunks: 0, vectors: 0,
      targets: (request.families || []).map((item) => item.base_doc_uid),
    });
  }
  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = bodyOf(options);
    const evidence = readEvidence();
    if (Object.hasOwn(evidence.receipts, receipt.status)) evidence.receipts[receipt.status]++;
    if (receipt.status !== "indexing") evidence.final_receipt = receipt;
    saveEvidence(evidence);
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }
  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 } });
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
