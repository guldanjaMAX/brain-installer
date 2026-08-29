// test/imessage-capture.test.mjs
//
// The iMessage capture core (connectors/imessage.mjs), proven against a
// SYNTHETIC chat.db built right here with node:sqlite — the same schema
// subset the connector's one query touches (message, handle, chat,
// chat_message_join, chat_handle_join), filled with invented personas
// consistent with the other message fixtures (Alex Rivera, Jordan Lee,
// +1555… numbers). No real chat data appears anywhere in this file, and no
// test reads the machine's real ~/Library/Messages.
//
// What a real Mac adds that this file cannot: a genuine TCC/Full Disk Access
// denial from launchd (approximated here with a directory this user cannot
// traverse, which produces the same EACCES/EPERM class the classifier keys
// on), and Messages.app holding the live database (the snapshot-copy
// fallback is exercised through its error path, not through a genuinely
// locked db).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ChatDbAccessError,
  IMESSAGE_PAGE_SIZE,
  captureOnce,
  defaultChatDbPath,
  fdaRemediationSteps,
  fetchMessagesSince,
  finishStaleSessions,
  loadCaptureState,
  macAbsoluteToIso,
  openChatDbReadOnly,
  parseAttributedBody,
  platformOf,
  probeChatDb,
  rowToSessionRow,
  saveCaptureState,
} from "../connectors/imessage.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 260)));
  if (!condition) fail++;
};

const sandbox = mkdtempSync(join(tmpdir(), "brain-imessage-capture-"));

/* ---------------------------------------------------------------- helpers */

// Mac absolute time: nanoseconds since 2001-01-01T00:00:00Z.
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
const macNs = (iso) => (Date.parse(iso) - MAC_EPOCH_MS) * 1e6;

/** A typedstream-shaped attributedBody blob, built by hand. */
function typedstreamBlob(text, { marker = "NSString", prefix = "auto", junkAfterMarker = 2 } = {}) {
  const payload = Buffer.from(text, "utf-8");
  let lengthField;
  if (prefix === "auto") prefix = payload.length < 0x81 ? "byte" : "u16";
  if (prefix === "byte") lengthField = Buffer.from([payload.length]);
  else if (prefix === "u16") {
    lengthField = Buffer.alloc(3);
    lengthField[0] = 0x81;
    lengthField.writeUInt16LE(payload.length, 1);
  } else if (prefix === "u32") {
    lengthField = Buffer.alloc(5);
    lengthField[0] = 0x82;
    lengthField.writeUInt32LE(payload.length, 1);
  } else if (prefix === "u48") {
    lengthField = Buffer.alloc(7);
    lengthField[0] = 0x83;
    lengthField.writeUIntLE(payload.length, 1, 6);
  } else {
    throw new Error(`unknown prefix ${prefix}`);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),            // typedstream preamble junk
    Buffer.from("streamtyped", "ascii"),
    Buffer.from(marker, "ascii"),
    Buffer.from([0x01].concat(Array(junkAfterMarker).fill(0x84))), // class info junk, no 0x2b
    Buffer.from([0x2b]),                   // '+'
    lengthField,
    payload,
    Buffer.from([0x86, 0x84]),             // trailing junk
  ]);
}

/** The synthetic chat.db: only what the connector's single query reads. */
function createChatDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT UNIQUE,
      text TEXT,
      attributedBody BLOB,
      date INTEGER,
      is_from_me INTEGER,
      handle_id INTEGER
    );
  `);
  return db;
}

function seedBase(db) {
  db.exec(`
    INSERT INTO handle (ROWID, id, country, service) VALUES
      (1, '+15551234567', 'us', 'iMessage'),
      (2, '+15559876543', 'us', 'SMS'),
      (3, 'jordan.lee@example.test', 'us', 'imessage');
    INSERT INTO chat (ROWID, guid, display_name, style) VALUES
      (1, 'iMessage;-;+15551234567', NULL, 45),
      (2, 'SMS;-;+15559876543', NULL, 45),
      (3, 'chat13579', 'Acme deal room', 43);
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1),(2,2),(3,1),(3,3);
  `);
}

let nextRowid = 1;
function insertMessage(db, {
  guid,
  text = null,
  blob = null,
  ts,
  fromMe = 0,
  handle = 1,
  chat = 1,
}) {
  const rowid = nextRowid++;
  db.prepare(
    "INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?,?)"
  ).run(rowid, guid, text, blob, macNs(ts), fromMe, handle);
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(chat, rowid);
  return rowid;
}

/** A sendEnvelopes stub that records everything and can be told to fail. */
function makeSender() {
  const sent = [];
  const sender = async (envelopes) => {
    if (sender.failNow) {
      sender.failNow = false;
      throw new Error("simulated ingest outage");
    }
    sent.push(...envelopes);
    return { created: envelopes.length, updated: 0, unchanged: 0, refused: 0, failed: 0 };
  };
  sender.sent = sent;
  sender.failNow = false;
  return sender;
}

try {
  /* ================= attributedBody typedstream parser ================= */
  {
    const short = typedstreamBlob("Sounds good, see you at 2pm");
    check("a short single-length-byte body decodes exactly",
      parseAttributedBody(short) === "Sounds good, see you at 2pm", JSON.stringify(parseAttributedBody(short)));

    const longText = "Quarterly recap: " + "the pipeline looks strong and the numbers hold up. ".repeat(6) + "🎉🎉🎉";
    const long = typedstreamBlob(longText, { prefix: "u16" });
    check("a long emoji body behind the 0x81 two-byte length decodes exactly",
      parseAttributedBody(long) === longText.trim(), JSON.stringify(parseAttributedBody(long)?.slice(0, 60)));

    const u32Text = "Deal memo v3 attached — full notes to follow. 📎";
    const u32 = typedstreamBlob(u32Text, { prefix: "u32" });
    check("the 0x82 four-byte length branch decodes exactly",
      parseAttributedBody(u32) === u32Text, JSON.stringify(parseAttributedBody(u32)));

    const u48Text = "Six-byte length marker variant";
    const u48 = typedstreamBlob(u48Text, { prefix: "u48" });
    check("the 0x83 six-byte length branch decodes exactly",
      parseAttributedBody(u48) === u48Text, JSON.stringify(parseAttributedBody(u48)));

    const mutable = typedstreamBlob("Edited message body", { marker: "NSMutableString" });
    check("NSMutableString-marked bodies decode too",
      parseAttributedBody(mutable) === "Edited message body");

    // A length that runs into bytes that are not UTF-8 text: the decode is
    // mostly replacement characters, and the parser must refuse it rather
    // than store garbage as someone's words.
    const garbagePayload = Buffer.alloc(40, 0xff);
    const garbage = Buffer.concat([
      Buffer.from("streamtypedNSString"),
      Buffer.from([0x01, 0x2b, garbagePayload.length]),
      garbagePayload,
    ]);
    check("a decode that is mostly replacement characters bails out to null",
      parseAttributedBody(garbage) === null, JSON.stringify(parseAttributedBody(garbage)));

    check("a blob with no NSString marker returns null",
      parseAttributedBody(Buffer.from("streamtyped nothing here")) === null);
    check("a marker with no '+' separator returns null",
      parseAttributedBody(Buffer.from("streamtypedNSString and then nothing")) === null);
    check("empty and missing blobs return null",
      parseAttributedBody(null) === null && parseAttributedBody(Buffer.alloc(0)) === null);
    check("a truncated 0x81 length field returns null instead of throwing",
      parseAttributedBody(Buffer.concat([Buffer.from("NSString"), Buffer.from([0x2b, 0x81, 0x05])])) === null);
  }

  /* ================= time and platform classification ================= */
  {
    const ns = macNs("2026-03-04T17:30:00.000Z");
    check("nanosecond Mac absolute time converts to the exact ISO instant",
      macAbsoluteToIso(ns) === "2026-03-04T17:30:00.000Z", macAbsoluteToIso(ns));
    const seconds = (Date.parse("2013-06-01T08:00:00Z") - MAC_EPOCH_MS) / 1000;
    check("second-precision Mac absolute time (older databases) converts too",
      macAbsoluteToIso(seconds) === "2013-06-01T08:00:00.000Z", macAbsoluteToIso(seconds));
    check("zero and null timestamps are null, never the epoch",
      macAbsoluteToIso(0) === null && macAbsoluteToIso(null) === null && macAbsoluteToIso(undefined) === null);

    check("handle.service iMessage classifies as imessage case-insensitively",
      platformOf("iMessage") === "imessage" && platformOf("imessage") === "imessage" && platformOf("IMESSAGE") === "imessage");
    check("every other service value classifies as sms, including null",
      platformOf("SMS") === "sms" && platformOf(null) === "sms" && platformOf("") === "sms" && platformOf("Jabber") === "sms");
  }

  /* ================= access probe: the three named failures ============ */
  {
    const missing = probeChatDb(join(sandbox, "never-created", "chat.db"));
    check("a missing chat.db is named chat_db_missing, with the path in the message",
      !missing.ok && missing.reason === "chat_db_missing" && /Messages\.app has never been signed in/.test(missing.message),
      JSON.stringify(missing));

    // Keep the fixture present for the restored-access check below even when
    // this host cannot model a POSIX permission denial.
    const lockedDir = join(sandbox, "locked");
    mkdirSync(lockedDir);
    writeFileSync(join(lockedDir, "chat.db"), "not really a db");

    const cannotSimulateDenial =
      (process.getuid && process.getuid() === 0) || process.platform === "win32";
    if (cannotSimulateDenial) {
      const why = process.platform === "win32"
        ? "POSIX mode bits are not enforced on Windows, and iMessage capture is macOS-only"
        : "running as root, EACCES cannot be simulated";
      check(`an unreadable chat.db is named full_disk_access_denied (skipped: ${why})`, true);
    } else {
      chmodSync(lockedDir, 0o000);
      const denied = probeChatDb(join(lockedDir, "chat.db"));
      chmodSync(lockedDir, 0o700);
      check("a permission-denied chat.db is named full_disk_access_denied, distinctly from missing",
        !denied.ok && denied.reason === "full_disk_access_denied" && /Full Disk Access gate/.test(denied.message),
        JSON.stringify(denied));
      let thrown = null;
      chmodSync(lockedDir, 0o000);
      try { await openChatDbReadOnly(join(lockedDir, "chat.db")); } catch (error) { thrown = error; }
      chmodSync(lockedDir, 0o700);
      check("openChatDbReadOnly surfaces the denial as a typed ChatDbAccessError",
        thrown instanceof ChatDbAccessError && thrown.reason === "full_disk_access_denied", thrown?.message);
    }

    const probe = probeChatDb(join(sandbox, "locked", "chat.db"));
    check("after access is restored the same path probes ok", probe.ok === true, JSON.stringify(probe));

    const steps = fdaRemediationSteps("/opt/node/bin/node").join("\n");
    check("the FDA walkthrough names the exact binary and the version-manager fragility",
      steps.includes("/opt/node/bin/node") && /Full Disk Access/.test(steps) && /nvm/.test(steps));
    check("the default chat.db path is the per-user Messages database",
      defaultChatDbPath("/Users/casey").endsWith("/Users/casey/Library/Messages/chat.db") ||
      defaultChatDbPath("/Users/casey").endsWith("\\Users\\casey\\Library\\Messages\\chat.db"));
  }

  /* ================= the synthetic database ================= */
  const dbPath = join(sandbox, "chat.db");
  const db = createChatDb(dbPath);
  seedBase(db);

  // Day one: a DM conversation on iMessage, an SMS thread, and a group chat.
  insertMessage(db, { guid: "GUID-A1", text: "Hey, are we still on for the partnership call Tuesday?", ts: "2026-03-02T17:00:00Z", handle: 1, chat: 1 });
  insertMessage(db, { guid: "GUID-A2", text: "Yes — 2pm works. Bringing the Q1 numbers.", ts: "2026-03-02T17:04:00Z", fromMe: 1, handle: 1, chat: 1 });
  insertMessage(db, {
    guid: "GUID-A3", text: null,
    blob: typedstreamBlob("Perfect. Also sending the revised deck tonight 🎉", { prefix: "u16" }),
    ts: "2026-03-02T17:06:00Z", handle: 1, chat: 1,
  });
  insertMessage(db, { guid: "GUID-B1", text: "Invoice #4521 is overdue", ts: "2026-03-02T18:00:00Z", handle: 2, chat: 2 });
  insertMessage(db, { guid: "GUID-B2", text: "Received, will process today", ts: "2026-03-02T18:05:00Z", fromMe: 1, handle: 2, chat: 2 });
  insertMessage(db, { guid: "GUID-C1", text: "Welcome Jordan to the deal room", ts: "2026-03-02T19:00:00Z", handle: 1, chat: 3 });
  insertMessage(db, { guid: "GUID-C2", text: "Thanks! Reviewing the numbers now", ts: "2026-03-02T19:02:00Z", handle: 3, chat: 3 });
  // A tapback-style row: no text, no parseable body. Counted, never a document.
  insertMessage(db, { guid: "GUID-T1", text: null, blob: null, ts: "2026-03-02T19:03:00Z", handle: 1, chat: 1 });

  /* ================= fetch + row mapping ================= */
  {
    const rows = fetchMessagesSince(db, 0);
    check("fetch returns every row after the watermark in ROWID order",
      rows.length === 8 && Number(rows[0].rowid) === 1 && Number(rows.at(-1).rowid) === 8, rows.length);
    const mapped = rowToSessionRow(rows[0]);
    check("an inbound row maps GUID, ISO time, platform and raw-handle speaker",
      mapped.id === "GUID-A1" && mapped.ts === "2026-03-02T17:00:00.000Z" &&
      mapped.platform === "imessage" && mapped.direction === "in" && mapped.sender_name === "+15551234567",
      JSON.stringify(mapped));
    const outbound = rowToSessionRow(rows[1]);
    check("an outbound row is direction out with no sender name (the owner label speaks)",
      outbound.direction === "out" && outbound.sender_name === "", JSON.stringify(outbound));
    const sms = rowToSessionRow(rows[3]);
    check("an SMS-service handle maps the row to platform sms",
      sms.platform === "sms" && sms.thread_id === "SMS;-;+15559876543", JSON.stringify(sms));
    const fromBlob = rowToSessionRow(rows[2]);
    check("a row with an empty text column decodes its attributedBody instead",
      fromBlob.body === "Perfect. Also sending the revised deck tonight 🎉", JSON.stringify(fromBlob.body));
    const partial = fetchMessagesSince(db, 6);
    check("the watermark excludes already-seen rows exactly",
      partial.length === 2 && Number(partial[0].rowid) === 7, JSON.stringify(partial.map((r) => r.rowid)));
  }

  /* ================= initial load, with counts ================= */
  const statePath = join(sandbox, ".brain-ingest-imessage.json");
  {
    const sender = makeSender();
    const result = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: sender,
      ownerLabel: "Owner",
      now: () => Date.parse("2026-03-03T09:00:00Z"), // next day: everything is stale-closable
    });
    check("the initial load reports honest counts: rows seen, pushed, skipped",
      result.rows_seen === 8 && result.rows_pushed === 7 && result.rows_skipped.no_text === 1 &&
      result.watermark === 8, JSON.stringify(result));
    check("three conversations on the same day become three session documents",
      sender.sent.length === 3 && result.documents_sent === 3,
      JSON.stringify(sender.sent.map((e) => e.source_id)));
    const ids = sender.sent.map((e) => e.source_id).sort();
    check("each session document is keyed by its first message's GUID (the durable id)",
      JSON.stringify(ids) === JSON.stringify(["GUID-A1", "GUID-B1", "GUID-C1"]), JSON.stringify(ids));
    const dm = sender.sent.find((e) => e.source_id === "GUID-A1");
    check("the iMessage DM session carries platform imessage and both speakers",
      dm.metadata.platform === "imessage" && dm.content.includes("Owner:") && dm.content.includes("+15551234567"),
      dm.content.slice(0, 200));
    const smsDoc = sender.sent.find((e) => e.source_id === "GUID-B1");
    check("the SMS thread's session is tagged platform sms end to end",
      smsDoc.metadata.platform === "sms" && /Platform: SMS/.test(smsDoc.content), smsDoc.content.slice(0, 120));
    check("the attributedBody-decoded text is inside the session document",
      dm.content.includes("Perfect. Also sending the revised deck tonight 🎉"));
    check("no session remained open after the stale sweep",
      result.sessions_open === 0);
    const state = loadCaptureState(statePath);
    check("the state file carries the watermark and an empty snapshot, owner-only",
      state.last_rowid === 8 && state.sessionizer.length === 0 &&
      (process.platform === "win32" || ((await import("node:fs")).statSync(statePath).mode & 0o777) === 0o600),
      JSON.stringify(state));
    check("re-listing the tapback row never happens: the watermark passed it",
      fetchMessagesSince(db, state.last_rowid).length === 0);
  }

  /* ================= incremental resume + open-session snapshot ========= */
  {
    // Same-day continuation of a NEW conversation: the first pass sees two
    // messages and holds the session open; the second pass (after more rows
    // arrive) must CONTINUE that session from the snapshot, not split it.
    insertMessage(db, { guid: "GUID-D1", text: "Quick one — can you resend the lease?", ts: "2026-03-05T15:00:00Z", handle: 3, chat: 1 });
    insertMessage(db, { guid: "GUID-D2", text: "Sure, one minute", ts: "2026-03-05T15:01:00Z", fromMe: 1, handle: 3, chat: 1 });

    const senderOne = makeSender();
    const passOne = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: senderOne,
      now: () => Date.parse("2026-03-05T15:02:00Z"),
    });
    check("an incremental pass reads only rows after the watermark",
      passOne.rows_seen === 2 && passOne.watermark === 10, JSON.stringify(passOne));
    check("a conversation still inside its gap window stays open, not sent",
      senderOne.sent.length === 0 && passOne.sessions_open === 1, JSON.stringify(passOne));
    const midState = loadCaptureState(statePath);
    check("the open session rides in the state snapshot with the watermark",
      midState.last_rowid === 10 && midState.sessionizer.length === 1 &&
      midState.sessionizer[0].first_id === "GUID-D1", JSON.stringify(midState.sessionizer));

    insertMessage(db, { guid: "GUID-D3", text: "Got it, thanks. Signing tomorrow.", ts: "2026-03-05T15:10:00Z", handle: 3, chat: 1 });
    const senderTwo = makeSender();
    const passTwo = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: senderTwo,
      now: () => Date.parse("2026-03-06T08:00:00Z"), // past the gap: session closes
    });
    check("the restarted process continues the same session from its snapshot",
      senderTwo.sent.length === 1 && senderTwo.sent[0].source_id === "GUID-D1" &&
      senderTwo.sent[0].metadata.message_count === 3 &&
      senderTwo.sent[0].content.includes("Signing tomorrow"),
      JSON.stringify(senderTwo.sent.map((e) => [e.source_id, e.metadata.message_count])));
    check("nothing was double-read on resume", passTwo.rows_seen === 1, JSON.stringify(passTwo));
  }

  /* ================= kill mid-run: nothing lost, nothing duplicated ===== */
  {
    // Two more days of traffic, paged small so the run spans several pages.
    for (let d = 0; d < 6; d++) {
      insertMessage(db, {
        guid: `GUID-E${d}`, text: `Update ${d}: still tracking ahead of plan`,
        ts: `2026-03-0${7 + (d % 2)}T1${d}:00:00Z`, handle: 1, chat: 1,
      });
    }
    const beforeState = loadCaptureState(statePath);
    const failing = makeSender();
    failing.failNow = false;
    let sends = 0;
    const flaky = async (envelopes) => {
      sends++;
      if (sends === 2) throw new Error("simulated ingest outage");
      return failing(envelopes);
    };
    let interrupted = null;
    try {
      await captureOnce({
        chatDbPath: dbPath, statePath, sendEnvelopes: flaky, pageSize: 2,
        now: () => Date.parse("2026-03-09T12:00:00Z"),
      });
    } catch (error) { interrupted = error; }
    check("a mid-run ingest outage propagates instead of being swallowed",
      /simulated ingest outage/.test(interrupted?.message), interrupted?.message);
    const partialState = loadCaptureState(statePath);
    check("the watermark stopped exactly at the last durable page",
      partialState.last_rowid > beforeState.last_rowid && partialState.last_rowid < 17,
      JSON.stringify({ before: beforeState.last_rowid, after: partialState.last_rowid }));

    const resumed = makeSender();
    const finish = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: resumed, pageSize: 2,
      now: () => Date.parse("2026-03-09T12:00:00Z"),
    });
    const allIds = [...failing.sent, ...resumed.sent].map((e) => e.source_id);
    check("the resumed run finishes the backlog with zero gaps",
      loadCaptureState(statePath).last_rowid === 17 && finish.rows_seen > 0, JSON.stringify(finish));
    const eDocs = [...failing.sent, ...resumed.sent].filter((e) => e.source_id.startsWith("GUID-E"));
    const eMessages = eDocs.reduce((n, e) => n + e.metadata.message_count, 0);
    check("every message row is represented exactly once across the interrupted and resumed runs",
      eMessages === 6, JSON.stringify({ ids: allIds, eMessages }));
    const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
    // A re-sent identical document is allowed (the worker acknowledges it
    // unchanged); what must never happen is the same GUID keying two
    // DIFFERENT documents. Assert identity, not transport-level uniqueness.
    const byId = new Map();
    let conflicting = 0;
    for (const doc of [...failing.sent, ...resumed.sent]) {
      const prior = byId.get(doc.source_id);
      if (prior && prior !== doc.content) conflicting++;
      byId.set(doc.source_id, doc.content);
    }
    check("a GUID never keys two different documents (idempotent by identity)",
      conflicting === 0, JSON.stringify({ dupes, conflicting }));
  }

  /* ================= full-page immediate re-poll ================= */
  {
    // Rebuild from zero with a small page: 17 rows at pageSize 5 must be
    // consumed in ONE captureOnce call (4 pages), not one page per interval.
    rmSync(statePath, { force: true });
    const sender = makeSender();
    const pages = [];
    const result = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: sender, pageSize: 5,
      now: () => Date.parse("2026-03-10T00:00:00Z"),
      onPage: (page) => pages.push(page.rows),
    });
    check("a full page triggers an immediate next read until a short page proves caught-up",
      result.pages === 4 && JSON.stringify(pages) === JSON.stringify([5, 5, 5, 2]) && result.watermark === 17,
      JSON.stringify({ pages, result }));
    check("a rebuild from zero re-derives the identical session identities (GUID idempotency)",
      sender.sent.some((e) => e.source_id === "GUID-A1") &&
      sender.sent.some((e) => e.source_id === "GUID-D1"),
      JSON.stringify(sender.sent.map((e) => e.source_id)));
  }

  /* ================= --limit bounds one pass ================= */
  {
    rmSync(statePath, { force: true });
    const sender = makeSender();
    const bounded = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: sender, pageSize: 4, maxRows: 6,
      now: () => Date.parse("2026-03-10T00:00:00Z"),
    });
    check("maxRows bounds the pass and leaves the watermark resumable",
      bounded.rows_seen === 6 && loadCaptureState(statePath).last_rowid === 6, JSON.stringify(bounded));
  }

  /* ================= dormant threads become searchable ================= */
  {
    rmSync(statePath, { force: true });
    // Load everything with "now" INSIDE the last conversation's gap window:
    // the last session stays open.
    const sender = makeSender();
    const first = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: sender,
      now: () => Date.parse("2026-03-08T15:30:00Z"),
    });
    check("a conversation that just happened stays open at first",
      first.sessions_open >= 1, JSON.stringify(first));
    // A later tick with NO new rows: the periodic stale sweep must close it,
    // or a dormant thread would never become searchable.
    const later = makeSender();
    const sweep = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: later,
      now: () => Date.parse("2026-03-09T23:00:00Z"),
    });
    check("a later tick with no new messages closes and sends the dormant session",
      sweep.rows_seen === 0 && later.sent.length >= 1 && sweep.sessions_open === 0,
      JSON.stringify({ sweep, sent: later.sent.map((e) => e.source_id) }));
  }

  /* ================= flush-only (disconnect) and dry-run ================= */
  {
    rmSync(statePath, { force: true });
    const sender = makeSender();
    await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: sender,
      now: () => Date.parse("2026-03-08T15:30:00Z"),
    });
    const flusher = makeSender();
    const flushed = await captureOnce({
      statePath, sendEnvelopes: flusher, flushOnly: true,
      now: () => Date.parse("2026-03-08T15:31:00Z"),
    });
    check("a flush-only pass closes every open session without touching chat.db",
      flusher.sent.length >= 1 && flushed.sessions_open === 0 &&
      loadCaptureState(statePath).sessionizer.length === 0,
      JSON.stringify(flushed));

    const before = readFileSync(statePath, "utf-8");
    const drySender = makeSender();
    insertMessage(db, { guid: "GUID-F1", text: "One more before the dry run", ts: "2026-03-11T10:00:00Z", handle: 1, chat: 1 });
    const dry = await captureOnce({
      chatDbPath: dbPath, statePath, sendEnvelopes: drySender, dryRun: true,
      now: () => Date.parse("2026-03-12T10:00:00Z"),
    });
    check("a dry run sends nothing and leaves the state file untouched",
      drySender.sent.length === 0 && dry.rows_seen === 1 && dry.documents_would_send === 1 &&
      readFileSync(statePath, "utf-8") === before,
      JSON.stringify(dry));
  }

  /* ================= state-file safety ================= */
  {
    const corruptPath = join(sandbox, "corrupt-state.json");
    writeFileSync(corruptPath, "{ this is not json");
    const recovered = loadCaptureState(corruptPath);
    check("a corrupt state file resets cleanly instead of aborting capture",
      recovered.last_rowid === 0 && Array.isArray(recovered.sessionizer));
    const wrongShape = join(sandbox, "wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ last_rowid: "eight" }));
    check("a wrong-shaped state file also resets cleanly",
      loadCaptureState(wrongShape).last_rowid === 0);
    saveCaptureState(join(sandbox, "nested", "deep", "state.json"), { version: 1, last_rowid: 3, sessionizer: [] });
    check("saveCaptureState creates parent directories and round-trips",
      loadCaptureState(join(sandbox, "nested", "deep", "state.json")).last_rowid === 3);
  }

  /* ================= finishStaleSessions in isolation ================= */
  {
    const sessionizer = new MessageSessionizer({ ownerLabel: "Owner" });
    sessionizer.push({ id: "S1", ts: "2026-04-01T10:00:00Z", body: "hello", platform: "imessage", thread_id: "t1", direction: "in", sender_name: "+15551234567" });
    sessionizer.push({ id: "S2", ts: "2026-04-01T10:05:00Z", body: "fresh", platform: "imessage", thread_id: "t2", direction: "in", sender_name: "+15559876543" });
    const closed = finishStaleSessions(sessionizer, { nowMs: Date.parse("2026-04-01T10:06:00Z") });
    check("a stale sweep inside the gap window closes nothing",
      closed.length === 0 && sessionizer.active.size === 2);
    const late = finishStaleSessions(sessionizer, { nowMs: Date.parse("2026-04-01T17:00:00Z") });
    check("a stale sweep past the gap window closes every dormant session",
      late.length === 2 && sessionizer.active.size === 0, JSON.stringify(late.map((e) => e.source_id)));
  }

  db.close();
  check("the page-size constant matches the reference scan unit", IMESSAGE_PAGE_SIZE === 5000);
  check("openChatDbReadOnly reads the synthetic database directly", await (async () => {
    const opened = await openChatDbReadOnly(dbPath);
    const rows = fetchMessagesSince(opened.db, 0, 3);
    opened.close();
    return rows.length === 3 && !opened.snapshotDir;
  })());
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nimessage capture: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
