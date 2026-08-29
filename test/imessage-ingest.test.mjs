// test/imessage-ingest.test.mjs
//
// The CLI wiring for WP-06, driven the way test/calendar-ingest.test.mjs
// drives calendar: the REAL command functions (cmdIngestImessage,
// cmdConnectImessage, cmdDisconnectImessage) run against a REAL synthetic
// chat.db (built here with node:sqlite, invented personas only), with only
// the outside world faked — the brain's batch-ingest endpoint, the source
// receipts, the freshness expectation, the admin key, and launchd (via a
// fake scheduler module). What this cannot prove: a genuine TCC denial from
// launchd and a live worker's credential gate; both are named in
// evidence/WP-06.md rather than papered over.

import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as imessage from "../connectors/imessage.mjs";
import {
  cmdConnectImessage,
  cmdDisconnectImessage,
  cmdIngestImessage,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 260))); if (!c) fail++; };

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-imessage-ingest-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = {
  manifest_version: 1,
  client: { slug: "acme", display_name: "Chris Vale", timezone: "America/Phoenix" },
  brain: { version: "0.1.21", domain: "brain.acme-example.test", worker_name: "acme-brain" },
  corpora: { imessage: { enabled: true } },
  operations: {},
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

/* ------------------------------------------------- the synthetic chat.db */
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
const macNs = (iso) => (Date.parse(iso) - MAC_EPOCH_MS) * 1e6;
const dbPath = join(sandbox, "chat.db");
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
    date INTEGER, is_from_me INTEGER, handle_id INTEGER
  );
  INSERT INTO handle (ROWID, id, country, service) VALUES
    (1, '+15551234567', 'us', 'iMessage'), (2, '+15559876543', 'us', 'SMS');
  INSERT INTO chat (ROWID, guid, display_name, style) VALUES
    (1, 'iMessage;-;+15551234567', NULL, 45), (2, 'SMS;-;+15559876543', NULL, 45);
  INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1),(2,2);
`);
let rowid = 0;
const addMessage = ({ guid, text, ts, fromMe = 0, handle = 1, chat = 1 }) => {
  rowid++;
  db.prepare("INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?)")
    .run(rowid, guid, text, macNs(ts), fromMe, handle);
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(chat, rowid);
};
addMessage({ guid: "IG-A1", text: "Are we still on for the Henderson kickoff Tuesday?", ts: "2026-03-02T17:00:00Z" });
addMessage({ guid: "IG-A2", text: "Yes, 2pm. Bringing the numbers.", ts: "2026-03-02T17:03:00Z", fromMe: 1 });
addMessage({ guid: "IG-B1", text: "Invoice #4521 cleared this morning", ts: "2026-03-02T18:00:00Z", handle: 2, chat: 2 });

/* ------------------------------------------------------- the fake brain */
function makeBrainFakes({ script = null } = {}) {
  const receipts = [];
  const batches = [];
  let call = 0;
  return {
    receipts,
    batches,
    options: {
      platform: "darwin",
      resolveAdminKey: () => "fixture-admin-key",
      resolveBaseUrl: async () => "https://brain.acme-example.test",
      postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return receipt; },
      requestIngestBatch: async ({ docs }) => {
        call++;
        batches.push(docs);
        const results = docs.map((doc, i) => ({
          source_id: doc.source_id,
          status: script ? script(doc, i, call) : "created",
          ...(script && script(doc, i, call) === "failed" ? { error: "scripted failure" } : {}),
        }));
        return { res: { ok: true, status: 200 }, raw: JSON.stringify({ results }) };
      },
    },
  };
}

try {
  /* ================= one capture pass through the real command ========== */
  {
    const fakes = makeBrainFakes();
    const result = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, fakes.options);
    check("the capture pass reads the synthetic history and reports counts",
      result.rows_seen === 3 && result.rows_pushed === 3 && result.watermark === 3, JSON.stringify(result));
    const sent = fakes.batches.flat();
    check("both conversations were sent as session documents keyed by first GUID",
      sent.length === 2 && sent.some((d) => d.source_id === "IG-A1") && sent.some((d) => d.source_id === "IG-B1"),
      JSON.stringify(sent.map((d) => d.source_id)));
    check("every document carries source_type imessage, so forget --source imessage scopes to it",
      sent.every((d) => d.source_type === "imessage"), JSON.stringify(sent.map((d) => d.source_type)));
    check("the SMS thread stays tagged platform sms inside the imessage source",
      sent.find((d) => d.source_id === "IG-B1").metadata.platform === "sms");
    check("the owner's display name speaks for outbound messages",
      sent.find((d) => d.source_id === "IG-A1").content.includes("Chris Vale:"));
    check("an indexing receipt opened and a ready receipt closed the run, kind imessage",
      fakes.receipts.length === 2 && fakes.receipts[0].status === "indexing" &&
      fakes.receipts[1].status === "ready" && fakes.receipts.every((r) => r.kind === "imessage" && r.source === "imessage"),
      JSON.stringify(fakes.receipts));
    check("the ready receipt carries the document counts",
      fakes.receipts[1].docs_added === 2 && /2 conversation document\(s\) sent/.test(fakes.receipts[1].detail),
      JSON.stringify(fakes.receipts[1]));
    check("capture state landed beside the manifest under the source's name",
      existsSync(join(sandbox, ".brain-ingest-imessage.json")));
  }
  {
    const fakes = makeBrainFakes();
    const again = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, fakes.options);
    check("a second pass is incremental: zero rows re-read, zero documents re-sent",
      again.rows_seen === 0 && fakes.batches.length === 0, JSON.stringify(again));
  }
  {
    const fakes = makeBrainFakes();
    const preview = await cmdIngestImessage(
      manifest, manifestPath,
      { "chat-db": dbPath, source: "imessage-preview", "dry-run": true },
      fakes.options,
    );
    check("an iMessage preview reports would-send volume without a key, receipt, send, or state write",
      preview.dry_run === true && preview.would_send === 2 &&
      fakes.receipts.length === 0 && fakes.batches.length === 0 &&
      !existsSync(join(sandbox, ".brain-ingest-imessage-preview.json")),
      JSON.stringify(preview));
  }

  /* ================= refusals count; failures stop the watermark ======== */
  {
    addMessage({ guid: "IG-C1", text: "Here is that key: sk-fixture-notreal", ts: "2026-03-04T10:00:00Z" });
    const refusing = makeBrainFakes({ script: () => "refused" });
    const result = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, refusing.options);
    check("a credential-gate refusal is explicit and never completion-shaped",
      result.watermark === 4 && result.refused === 1 && result.documents_accepted === 0 &&
      result.outcome?.kind === "partial" && result.outcome?.complete === false &&
      refusing.receipts[1].status === "ready" && /credential gate/.test(refusing.receipts[1].refusal_reason || ""),
      JSON.stringify({ result, receipt: refusing.receipts[1] }));

    addMessage({ guid: "IG-D1", text: "And one more for the failure case", ts: "2026-03-05T10:00:00Z" });
    const failing = makeBrainFakes({ script: () => "failed" });
    let thrown = null;
    try {
      await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, failing.options);
    } catch (error) { thrown = error; }
    check("a document failure throws instead of silently advancing the watermark",
      /scripted failure/.test(thrown?.message), thrown?.message);
    check("the failed run closed its receipt as an error",
      failing.receipts.at(-1).status === "error" && /watermark stayed/.test(failing.receipts.at(-1).detail),
      JSON.stringify(failing.receipts));
    const retry = makeBrainFakes();
    const retried = await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath }, retry.options);
    check("the next run retries exactly the unadvanced rows",
      retried.watermark === 5 && retry.batches.flat().some((d) => d.source_id === "IG-D1"),
      JSON.stringify(retried));
  }

  /* ================= the non-Mac refusal ================= */
  {
    let thrown = null;
    try {
      await cmdIngestImessage(manifest, manifestPath, {}, { platform: "win32" });
    } catch (error) { thrown = error; }
    check("a non-Mac machine gets the honest Mac-only statement, not a file error",
      /exists only on macOS/.test(thrown?.message), thrown?.message);
  }

  /* ================= brain connect imessage ================= */
  {
    // FDA denied: the walkthrough prints, nothing installs.
    const installs = [];
    const deniedModule = {
      ...imessage,
      defaultChatDbPath: () => dbPath,
      probeChatDb: () => ({
        ok: false, reason: "full_disk_access_denied",
        message: "macOS refused to open chat.db (EPERM). This is the Full Disk Access gate, not a missing file.",
      }),
    };
    const fakeScheduler = {
      installImessageScheduler: (path, opts) => {
        installs.push(path);
        return {
          cron: "* * * * *", expectedRefreshSeconds: 60, warnings: [],
          plistPath: "/fixture/plist", stdoutPath: "/fixture/out", stderrPath: "/fixture/err",
        };
      },
      removeImessageScheduler: () => ({ removed: true, loaded: false, stdoutPath: "/fixture/out", stderrPath: "/fixture/err" }),
    };
    let thrown = null;
    try {
      await cmdConnectImessage(manifestPath, {}, {
        platform: "darwin", imessage: deniedModule, imessageScheduler: fakeScheduler,
        resolveAdminKey: () => "fixture-admin-key",
        resolveBaseUrl: async () => "https://brain.acme-example.test",
        postSourceExpectation: async () => ({}),
      });
    } catch (error) { thrown = error; }
    check("connect refuses honestly when Full Disk Access is denied, and installs nothing",
      /Full Disk Access is not granted yet/.test(thrown?.message) && installs.length === 0, thrown?.message);
  }
  {
    // Happy path: probe passes, initial load runs, agent installs, freshness set.
    addMessage({ guid: "IG-E1", text: "Fresh message before connect", ts: "2026-03-06T10:00:00Z" });
    const fakes = makeBrainFakes();
    const expectations = [];
    const installs = [];
    const okModule = { ...imessage, defaultChatDbPath: () => dbPath };
    const fakeScheduler = {
      installImessageScheduler: (path) => {
        installs.push(path);
        return {
          cron: "* * * * *", expectedRefreshSeconds: 60, warnings: [],
          plistPath: "/fixture/plist", stdoutPath: "/fixture/out", stderrPath: "/fixture/err",
        };
      },
    };
    const installed = await cmdConnectImessage(manifestPath, {}, {
      ...fakes.options,
      imessage: okModule,
      imessageScheduler: fakeScheduler,
      postSourceExpectation: async (_base, _key, body) => { expectations.push(body); return body; },
    });
    check("connect runs the initial load before installing the agent",
      fakes.receipts.some((r) => r.status === "ready") && installs.length === 1 && installs[0] === manifestPath,
      JSON.stringify({ receipts: fakes.receipts.length, installs }));
    check("connect sets the every-minute freshness expectation on the brain",
      expectations.length === 1 && expectations[0].source === "imessage" &&
      expectations[0].kind === "imessage" && expectations[0].expected_refresh_seconds === 60,
      JSON.stringify(expectations));
    check("connect returns the installed plan", installed.cron === "* * * * *");
  }
  {
    // The manifest gate: connect refuses when the corpus is not declared.
    const disabledPath = join(sandbox, "disabled.manifest.json");
    writeFileSync(disabledPath, JSON.stringify({ ...manifest, corpora: {} }, null, 2));
    let thrown = null;
    try {
      await cmdConnectImessage(disabledPath, {}, { platform: "darwin" });
    } catch (error) { thrown = error; }
    check("connect requires corpora.imessage.enabled in the install record first",
      /corpora\.imessage\.enabled is not true/.test(thrown?.message), thrown?.message);
  }

  /* ================= brain disconnect imessage ================= */
  {
    // Leave one session open in the state file, then disconnect: the agent is
    // removed, the open session is flushed to the brain, and the freshness
    // expectation is cleared — in that order.
    const statePath = join(sandbox, ".brain-ingest-imessage.json");
    // Build the open-session snapshot through the real capture core: reset
    // state, run with "now" inside the gap so the last conversation stays open.
    rmSync(statePath, { force: true });
    const preload = makeBrainFakes();
    await cmdIngestImessage(manifest, manifestPath, { "chat-db": dbPath, reset: true }, preload.options);
    const openState = imessage.loadCaptureState(statePath);
    // Force an open session deterministically: put one back.
    openState.sessionizer = [{
      platform: "imessage", thread_id: "iMessage;-;+15551234567", thread_title: "",
      category: "message", day: "2026-03-06", first_id: "IG-OPEN-1", last_id: "IG-OPEN-1",
      first_ts: "2026-03-06T10:00:00.000Z", last_ts: "2026-03-06T10:00:00.000Z",
      message_count: 1, content_chars: 20, participants: ["+15551234567"],
      lines: ["[2026-03-06T10:00:00.000Z] +15551234567: still thinking it over"],
    }];
    imessage.saveCaptureState(statePath, openState);

    const fakes = makeBrainFakes();
    const removals = [];
    const expectations = [];
    const fakeScheduler = {
      removeImessageScheduler: (path) => {
        removals.push(path);
        return { removed: true, loaded: false, stdoutPath: "/fixture/out", stderrPath: "/fixture/err" };
      },
    };
    const removed = await cmdDisconnectImessage(manifestPath, {}, {
      ...fakes.options,
      imessageScheduler: fakeScheduler,
      postSourceExpectation: async (_base, _key, body) => { expectations.push(body); return body; },
    });
    check("disconnect removes the LaunchAgent through the scheduler module",
      removed.removed === true && removals.length === 1 && removals[0] === manifestPath, JSON.stringify(removals));
    check("disconnect flushes the open session so the dormant thread becomes searchable",
      fakes.batches.flat().some((d) => d.source_id === "IG-OPEN-1") &&
      imessage.loadCaptureState(statePath).sessionizer.length === 0,
      JSON.stringify(fakes.batches.flat().map((d) => d.source_id)));
    check("the flush is a flush, not a capture: no chat.db rows were re-read",
      fakes.receipts.some((r) => /open-session flush/.test(r.detail || "")), JSON.stringify(fakes.receipts));
    check("disconnect clears the freshness expectation",
      expectations.length === 1 && expectations[0].expected_refresh_seconds === null, JSON.stringify(expectations));
  }
  {
    // Removal stays reachable when the brain is unreachable: the flush and
    // the expectation clear both fail, and removal still succeeds.
    const removals = [];
    const fakeScheduler = {
      removeImessageScheduler: (path) => {
        removals.push(path);
        return { removed: true, loaded: false, stdoutPath: "/fixture/out", stderrPath: "/fixture/err" };
      },
    };
    const removed = await cmdDisconnectImessage(manifestPath, {}, {
      platform: "darwin",
      imessageScheduler: fakeScheduler,
      resolveAdminKey: () => undefined,
      resolveBaseUrl: async () => { throw new Error("no route to brain"); },
      postSourceExpectation: async () => { throw new Error("unreachable"); },
    });
    check("disconnect still removes the agent when the brain is unreachable",
      removed.removed === true && removals.length === 1);
  }

  db.close();
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nimessage ingest wiring: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
