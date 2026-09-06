/** Offline Gmail incremental-policy and Worker fixture. Invented data only. */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const evidencePath = String(process.env.BRAIN_GMAIL_POLICY_EVIDENCE || "");
const userRoot = String(process.env.BRAIN_GMAIL_POLICY_USER_ROOT || "");
const mode = String(process.env.BRAIN_GMAIL_POLICY_MODE || "");
const MODES = [
  "mixed",
  "unclassified",
  "credential-refusal",
  "sweep-query-evidence",
  "policy-change-sweep",
  "sweep-marker-missing",
  "scanner-v5",
  "scanner-v5-omitted",
  "scanner-v5-retained-untracked",
  "scanner-v5-progress-missing",
  "scanner-v5-mass-refusal",
  "scanner-v5-dilution-guard",
  "deleted",
  "relabeled",
  "pending-restored",
  "pending-retained",
  "pending-absent-unreadable",
  "pending-readback-failure",
  "readback-stale",
  "resume-progress",
];
if (!evidencePath || !userRoot || !MODES.includes(mode)) {
  throw new Error("the Gmail policy fixture is not configured");
}

const lateEligibleIds = Array.from({ length: 51 }, (_, i) => `eligible-${String(i + 1).padStart(2, "0")}`);
const massRefusalIds = Array.from({ length: 101 }, (_, i) => `mass-sensitive-${String(i + 1).padStart(3, "0")}`);
const dilutionNewIds = Array.from({ length: 901 }, (_, i) => `new-safe-${String(i + 1).padStart(3, "0")}`);
const dilutionOldIds = Array.from({ length: 100 }, (_, i) => `old-absent-${String(i + 1).padStart(3, "0")}`);
const SYNTHETIC_OPENAI_KEY = `sk-proj-${"A7".repeat(16)}`;
const SYNTHETIC_ADMIN_KEY = "01234567".repeat(8);

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
const requireDefaultFilteredQuery = (url) => {
  const query = String(url.searchParams.get("q") || "");
  for (const exclusion of ["-category:promotions", "-category:social", "-category:forums", "-in:spam", "-in:trash"]) {
    if (!query.includes(exclusion)) throw new Error(`default Gmail query omitted ${exclusion}`);
  }
};

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return json({ access_token: "fixture-access", expires_in: 3600 });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/profile") {
    if (mode === "sweep-marker-missing") return json({ error: { message: "profile marker unavailable" } }, 404);
    return json({ historyId: "history-current" });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/history") {
    if (["pending-retained", "pending-absent-unreadable"].includes(mode) &&
        url.searchParams.get("startHistoryId") === "history-current") {
      return json({ historyId: "history-current" });
    }
    if (["deleted", "readback-stale"].includes(mode)) {
      return json({
        historyId: "history-current",
        history: [{ id: "history-current", messagesDeleted: [{ message: { id: "gone" } }] }],
      });
    }
    if (mode === "pending-readback-failure") {
      return json({ historyId: "history-current", history: [] });
    }
    if (mode === "relabeled") {
      return json({
        historyId: "history-current",
        history: [{ id: "history-current", labelsAdded: [{ message: { id: "relabelled" } }] }],
      });
    }
    const idsByMode = {
      mixed: ["promotion", "inbox"],
      unclassified: [...lateEligibleIds, "unclassified"],
      "credential-refusal": ["credential-refused", "credential-clean"],
      "scanner-v5": ["migration-safe", "migration-sensitive"],
      "pending-restored": ["pending-restored"],
      "pending-retained": ["pending-retained"],
      "pending-absent-unreadable": ["pending-absent-unreadable"],
    };
    const ids = idsByMode[mode];
    if (!ids) throw new Error("the full-sweep fixture must use Gmail messages.list");
    return json({
      historyId: "history-current",
      history: [{
        id: "history-current",
        messagesAdded: ids.map((id) => ({ message: { id } })),
        ...(mode === "unclassified"
          ? { messagesDeleted: [{ message: { id: "pending-removal" } }] }
          : {}),
      }],
    });
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname === "/gmail/v1/users/me/messages") {
    if (mode === "resume-progress") {
      return json({
        messages: [
          ...Array.from({ length: 100 }, (_, i) => ({ id: `resume-accepted-${i}` })),
          ...Array.from({ length: 100 }, (_, i) => ({ id: `resume-skipped-${i}` })),
        ],
      });
    }
    if (["sweep-query-evidence", "policy-change-sweep", "sweep-marker-missing"].includes(mode)) {
      requireDefaultFilteredQuery(url);
      return json({ messages: [{ id: "sweep-inbox" }] });
    }
    if (["scanner-v5", "scanner-v5-retained-untracked", "scanner-v5-progress-missing"].includes(mode)) {
      requireDefaultFilteredQuery(url);
      return json({ messages: mode === "scanner-v5"
        ? [{ id: "migration-safe" }, { id: "migration-sensitive" }]
        : mode === "scanner-v5-retained-untracked"
          ? [{ id: "migration-safe" }, { id: "migration-unreadable" }]
          : [{ id: "migration-safe" }] });
    }
    if (mode === "scanner-v5-omitted") {
      requireDefaultFilteredQuery(url);
      return json({ messages: [{ id: "migration-safe" }] });
    }
    if (mode === "scanner-v5-mass-refusal") {
      requireDefaultFilteredQuery(url);
      return json({ messages: massRefusalIds.map((id) => ({ id })) });
    }
    if (mode === "scanner-v5-dilution-guard") {
      requireDefaultFilteredQuery(url);
      return json({ messages: dilutionNewIds.map((id) => ({ id })) });
    }
    throw new Error("the incremental fixture must use Gmail history");
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
    const id = url.pathname.split("/").at(-1);
    if (id.startsWith("eligible-")) {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Eligible incremental mail", `This invented ordinary inbox message ${id} belongs to the late-gap atomicity fixture and is safe to index.`),
      });
    }
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
    if (id === "credential-refused") {
      return json({
        id, historyId: "credential-current-v2", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Invented credential", `This synthetic message contains an intentionally fake test value. admin_key: ${SYNTHETIC_OPENAI_KEY}`),
      });
    }
    if (id === "credential-clean") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Clean inbox mail", "This invented clean inbox message confirms the reviewed project owner, agreed scope, timing, price, and next milestone."),
      });
    }
    if (id === "sweep-inbox") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000",
        raw: rawMail("Query-proven inbox mail", "This invented message came from the connector's default filtered Gmail query and its raw response intentionally omits label identifiers."),
      });
    }
    if (id === "migration-safe") {
      return json({
        id, historyId: "migration-safe-v1", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Previously accepted safe mail", "This invented safe message was accepted under scanner version four and must be posted again during the scanner version five migration."),
      });
    }
    if (id === "migration-sensitive") {
      return json({
        id, historyId: "migration-sensitive-v1", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Newly detected synthetic secret", `This invented migration message contains only synthetic fixture data. admin_key: ${SYNTHETIC_ADMIN_KEY}`),
      });
    }
    if (id === "migration-unreadable") {
      return json({
        id, historyId: "migration-unreadable-v1", internalDate: "1788030000000", labelIds: ["INBOX"],
      });
    }
    if (id === "relabelled") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000", labelIds: ["CATEGORY_PROMOTIONS"],
        raw: rawMail("Moved promotion", "This invented prior message is now excluded by the Gmail policy."),
      });
    }
    if (id === "pending-restored") {
      return json({
        id, historyId: "history-current", internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Restored message", "This invented message is active and eligible again, so its pending removal must be cancelled."),
      });
    }
    if (id === "pending-retained") {
      return json({
        id, historyId: "pending-retained-v1", internalDate: "1788030000000", labelIds: ["INBOX"],
      });
    }
    if (id === "pending-absent-unreadable") {
      return json({
        id, historyId: "pending-absent-unreadable-v1", internalDate: "1788030000000", labelIds: ["INBOX"],
      });
    }
    if (massRefusalIds.includes(id)) {
      return json({
        id, historyId: `mass-v1-${id}`, internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("Synthetic scanner refusal", `This fixture contains an invented test value. admin_key: ${SYNTHETIC_ADMIN_KEY}`),
      });
    }
    if (dilutionNewIds.includes(id)) {
      return json({
        id, historyId: `new-v1-${id}`, internalDate: "1788030000000", labelIds: ["INBOX"],
        raw: rawMail("New account mail", `This invented clean message ${id} must not dilute cleanup review for the prior corpus.`),
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
    const families = Array.isArray(request.families) ? request.families : [];
    const removals = families.length > 0 && families.every((family) =>
      Array.isArray(family?.keep_doc_uids) && family.keep_doc_uids.length === 0
    );
    const reconciliations = families.length > 0 && families.every((family) =>
      Array.isArray(family?.keep_doc_uids) && family.keep_doc_uids.length > 0
    );
    if (!removals && !reconciliations) throw new Error("fixture received a mixed or invalid forget request");
    if (reconciliations) {
      return json({ dry_run: false, documents: 0, chunks: 0, vectors: 0, targets: [] });
    }
    const targets = families.map((item) => item.base_doc_uid);
    evidence.forget_targets.push(...targets);
    saveEvidence(evidence);
    return json({
      dry_run: false, documents: targets.length, chunks: targets.length, vectors: targets.length,
      targets,
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
  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/source-families") {
    const request = bodyOf(options);
    const storedByMode = {
      "scanner-v5": ["gmail:migration-safe", "gmail:migration-sensitive"],
      "scanner-v5-omitted": ["gmail:migration-omitted", "gmail:migration-safe"],
      "scanner-v5-retained-untracked": ["gmail:migration-safe", "gmail:migration-unreadable"],
      "scanner-v5-progress-missing": [],
      "scanner-v5-mass-refusal": massRefusalIds.map((id) => `gmail:${id}`),
      "scanner-v5-dilution-guard": dilutionOldIds.map((id) => `gmail:${id}`),
      "credential-refusal": ["gmail:credential-refused"],
      deleted: ["gmail:gone"],
      relabeled: ["gmail:relabelled"],
      "pending-restored": ["gmail:pending-restored"],
      "pending-retained": ["gmail:pending-retained"],
      "pending-absent-unreadable": [],
      "pending-readback-failure": [
        "gmail:pending-readback",
        ...Array.from({ length: 9 }, (_, index) => `gmail:readback-decoy-${index + 1}`),
      ],
      "readback-stale": ["gmail:gone"],
      unclassified: ["gmail:pending-removal", "gmail:unclassified"],
    };
    const evidence = readEvidence();
    const pendingReadbackAttempts = evidence.forget_targets.filter(
      (uid) => uid === "gmail:pending-readback"
    ).length;
    if (mode === "pending-readback-failure" && pendingReadbackAttempts === 1 &&
        evidence.receipts.indexing === 1) {
      const error = new TypeError("fixture source-family readback connection reset");
      error.code = "ECONNRESET";
      throw error;
    }
    const stored = new Set([
      ...(storedByMode[mode] || []),
      ...evidence.ingested_ids.map((id) => `gmail:${id}`),
    ]);
    if (mode === "pending-readback-failure") {
      // The first success-shaped forget is deliberately ineffective. The retry
      // succeeds, proving the pending marker survived the failed readback.
      if (pendingReadbackAttempts >= 2) stored.delete("gmail:pending-readback");
    } else if (mode !== "readback-stale") {
      for (const uid of evidence.forget_targets) stored.delete(uid);
    }
    const ordered = [...stored].sort();
    const limit = Math.max(1, Math.min(1000, Number(request.limit) || 1000));
    const start = request.cursor
      ? ordered.findIndex((uid) => uid > request.cursor)
      : 0;
    const page = start < 0 ? [] : ordered.slice(start, start + limit);
    const nextCursor = start >= 0 && start + page.length < ordered.length
      ? page.at(-1)
      : null;
    return json({ source: "gmail", families: page, next_cursor: nextCursor });
  }
  if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 } });
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
