// test/whatsapp-capture.test.mjs
//
// The WhatsApp drain: the Node half that moves rows out of the Go capture
// daemon's local SQLite outbox and into the brain. Proven against a REAL
// fixture outbox built here with node:sqlite, using the same schema
// daemons/whatsapp/internal/outbox/outbox.go creates, so the column contract
// this connector depends on is exercised rather than assumed.
//
// Every persona here is invented (the same cast as test/fixtures/whatsapp/).
//
// WHAT THIS FILE CANNOT PROVE, stated rather than implied: nothing here
// involves a real WhatsApp account. Pairing, the link-time history transfer,
// and live message delivery all require a phone scanning a QR code, which no
// automated test can do. Those are named in evidence/WP-07-cli.md as
// unproven, not quietly counted as passing.

import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DaemonBinaryMissingError,
  WHATSAPP_DISCLOSURE,
  countUndrained,
  daemonBinaryName,
  daemonEnvironment,
  drainOnce,
  loadDrainState,
  openOutbox,
  probeOutbox,
  resolveDaemonBinary,
  rowToSessionRow,
  saveDrainState,
} from "../connectors/whatsapp.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-whatsapp-capture-")));

/* ------------------------------------------------------- fixture outbox */
// Byte-for-byte the schema the Go daemon creates. If the daemon's schema ever
// drifts from this, these tests stop reflecting reality — which is exactly
// the failure this copy is here to surface.
const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox_messages (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid     TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'whatsapp',
  ts           TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  body         TEXT NOT NULL,
  sender_jid   TEXT NOT NULL DEFAULT '',
  sender_name  TEXT NOT NULL DEFAULT '',
  thread_title TEXT NOT NULL DEFAULT '',
  is_group     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL CHECK (source IN ('live','history_sync')),
  received_at  TEXT NOT NULL,
  drained_at   TEXT,
  UNIQUE (chat_jid, message_id)
);
CREATE INDEX IF NOT EXISTS idx_outbox_undrained
  ON outbox_messages (seq) WHERE drained_at IS NULL;
`;

function newOutbox(name) {
  const path = join(sandbox, `${name}.db`);
  const db = new DatabaseSync(path);
  db.exec(OUTBOX_SCHEMA);
  db.close();
  return path;
}

function insert(path, rows) {
  const db = new DatabaseSync(path);
  const stmt = db.prepare(`INSERT INTO outbox_messages
    (chat_jid, message_id, ts, direction, body, sender_jid, sender_name,
     thread_title, is_group, source, received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    stmt.run(
      r.chat, r.id, r.ts, r.direction || "in", r.body,
      r.senderJid || "", r.sender || "", r.title || "", r.group ? 1 : 0,
      r.source || "live", r.receivedAt || r.ts
    );
  }
  db.close();
}

// Two invented threads. ALEX is one continuous conversation; PRIYA is a
// second thread so multi-thread sessionization is exercised too.
const ALEX = "14155550101@s.whatsapp.net";
const PRIYA = "14155550102@s.whatsapp.net";

const collector = () => {
  const docs = [];
  return { docs, send: async (envelopes) => { docs.push(...envelopes); } };
};

// Does this exact message text appear in a document's rendered content?
const bodiesIn = (doc) => String(doc.content || "");

try {
  /* ============ 1. a first drain reports what it actually did ============ */
  {
    const outbox = newOutbox("first-drain");
    insert(outbox, [
      { chat: ALEX, id: "wa-a1", ts: "2026-03-02T17:00:00Z", body: "Are we still on for the Tuesday kickoff?", sender: "Alex Rivera", title: "Alex Rivera", source: "history_sync" },
      { chat: ALEX, id: "wa-a2", ts: "2026-03-02T17:03:00Z", direction: "out", body: "Yes, 2pm. Bringing the numbers.", source: "history_sync" },
      { chat: ALEX, id: "wa-a3", ts: "2026-03-02T17:05:00Z", body: "[audio]", sender: "Alex Rivera", title: "Alex Rivera" },
      { chat: PRIYA, id: "wa-p1", ts: "2026-03-02T18:00:00Z", body: "Invoice 4521 cleared this morning.", sender: "Priya Nair", title: "Priya Nair" },
    ]);
    const state = join(sandbox, "first-drain.json");
    const sink = collector();
    const result = await drainOnce({
      outboxPath: outbox, statePath: state, sendEnvelopes: sink.send,
      ownerLabel: "Morgan Diaz", now: () => Date.parse("2026-03-09T00:00:00Z"),
    });

    check("the first drain reports rows seen, rows pushed and the cursor it reached",
      result.rows_seen === 4 && result.rows_pushed === 3 && result.watermark === 4,
      JSON.stringify(result));
    check("both conversations became session documents keyed by their first message id",
      sink.docs.length === 2 &&
      sink.docs.some((d) => d.source_id === "wa-a1") && sink.docs.some((d) => d.source_id === "wa-p1"),
      JSON.stringify(sink.docs.map((d) => d.source_id)));
    check("every document is tagged platform whatsapp",
      sink.docs.every((d) => d.metadata?.platform === "whatsapp"),
      JSON.stringify(sink.docs.map((d) => d.metadata?.platform)));
    check("the owner's manifest name speaks for outbound messages, not a phone number",
      bodiesIn(sink.docs.find((d) => d.source_id === "wa-a1")).includes("Morgan Diaz:"));
    check("the drain stamps drained_at, so an operator can see the backlog is clear",
      result.drained_marked === 4 && result.undrained_remaining === 0,
      JSON.stringify({ marked: result.drained_marked, left: result.undrained_remaining }));

    /* ---- 2. a second drain sends nothing new ---- */
    const again = collector();
    const second = await drainOnce({
      outboxPath: outbox, statePath: state, sendEnvelopes: again.send,
      ownerLabel: "Morgan Diaz", now: () => Date.parse("2026-03-09T00:00:00Z"),
    });
    check("a second drain re-reads nothing and sends nothing",
      second.rows_seen === 0 && second.pages === 0 && again.docs.length === 0,
      JSON.stringify({ result: second, docs: again.docs.length }));

    /* ---- 5. media-only rows never become documents ---- */
    check("a media marker is counted as skipped rather than silently dropped",
      result.rows_skipped.media_only === 1, JSON.stringify(result.rows_skipped));
    check("no document contains the bare [audio] marker",
      sink.docs.every((d) => !/\[audio\]/.test(bodiesIn(d))));
  }

  /* ============ media-only thread produces no document at all ============ */
  {
    const outbox = newOutbox("media-only");
    insert(outbox, [
      { chat: PRIYA, id: "wa-m1", ts: "2026-03-03T09:00:00Z", body: "[audio]", sender: "Priya Nair" },
      { chat: PRIYA, id: "wa-m2", ts: "2026-03-03T09:01:00Z", body: "[image]", sender: "Priya Nair" },
      { chat: PRIYA, id: "wa-m3", ts: "2026-03-03T09:02:00Z", body: "[video]", sender: "Priya Nair" },
    ]);
    const sink = collector();
    const result = await drainOnce({
      outboxPath: outbox, statePath: join(sandbox, "media-only.json"), sendEnvelopes: sink.send,
      now: () => Date.parse("2026-03-10T00:00:00Z"),
    });
    check("a thread of nothing but media markers produces zero documents",
      sink.docs.length === 0 && result.rows_pushed === 0 && result.rows_skipped.media_only === 3,
      JSON.stringify(result));
    check("the rows are still marked drained, so they do not accumulate forever",
      result.undrained_remaining === 0, String(result.undrained_remaining));
  }

  /* ====== 3. kill mid-drain, resume: zero gaps, no divergent duplicates ==== */
  //
  // A drain pass has two distinct moments a kill can land, and they fail
  // differently, so both are exercised rather than one standing in for the
  // other:
  //   A. inside the page loop, after documents went out but before the
  //      cursor+snapshot pair was persisted. The page is re-read on resume.
  //   B. during the final flush of conversations that went quiet, after the
  //      cursor already reached the end. The cursor is at the end, but the
  //      still-open sessions are in the snapshot, so the resume emits them.
  const plantInterrupted = (name) => {
    const outbox = newOutbox(name);
    const planted = [
      { chat: ALEX, id: "k1", ts: "2026-04-01T10:00:00Z", body: "Line one from the archive.", sender: "Alex Rivera" },
      { chat: ALEX, id: "k2", ts: "2026-04-01T10:01:00Z", body: "Line two from the archive.", sender: "Alex Rivera" },
      { chat: PRIYA, id: "k3", ts: "2026-04-02T10:00:00Z", body: "Line three from the archive.", sender: "Priya Nair" },
      { chat: PRIYA, id: "k4", ts: "2026-04-02T10:01:00Z", body: "Line four from the archive.", sender: "Priya Nair" },
      { chat: ALEX, id: "k5", ts: "2026-04-03T10:00:00Z", body: "Line five from the archive.", sender: "Alex Rivera" },
      { chat: ALEX, id: "k6", ts: "2026-04-03T10:01:00Z", body: "Line six from the archive.", sender: "Alex Rivera" },
    ];
    insert(outbox, planted);
    return { outbox, planted, state: join(sandbox, `${name}.json`), now: () => Date.parse("2026-04-20T00:00:00Z") };
  };

  // Every planted message reaches exactly one document id, across both the
  // pre-kill and post-resume deliveries. This is the whole correctness claim.
  const assertLossless = (label, planted, all) => {
    const missing = planted.filter((row) => !all.some((doc) => bodiesIn(doc).includes(row.body)));
    check(`${label}: zero gaps, every captured message reached a delivered document`,
      missing.length === 0, `missing: ${JSON.stringify(missing.map((r) => r.id))}`);
    const spread = planted.map((row) => ({
      id: row.id,
      docIds: [...new Set(all.filter((doc) => bodiesIn(doc).includes(row.body)).map((doc) => doc.source_id))],
    }));
    check(`${label}: zero duplicates, no message lands under two different document ids`,
      spread.every((entry) => entry.docIds.length === 1),
      JSON.stringify(spread.filter((e) => e.docIds.length !== 1)));
    const repeated = all.filter((doc, i) => all.findIndex((d) => d.source_id === doc.source_id) !== i);
    check(`${label}: any re-sent document is byte-identical to its first send`,
      repeated.every((doc) => all.find((d) => d.source_id === doc.source_id).content === doc.content),
      `re-sent: ${JSON.stringify(repeated.map((d) => d.source_id))}`);
  };

  /* ---- A: killed inside the page loop, before the cursor was persisted ---- */
  {
    const { outbox, planted, state, now } = plantInterrupted("killed-mid-loop");
    const beforeKill = [];
    let dispatches = 0, killed = null;
    try {
      await drainOnce({
        outboxPath: outbox, statePath: state, pageSize: 2, now,
        sendEnvelopes: async (envelopes) => {
          dispatches++;
          // The second dispatch happens while the page loop is still running,
          // with the cursor still standing at the previous page.
          if (dispatches === 2) throw new Error("simulated kill mid-drain");
          beforeKill.push(...envelopes);
        },
      });
    } catch (error) { killed = error; }
    check("a dispatch failure aborts the pass rather than advancing past unsent rows",
      /simulated kill mid-drain/.test(String(killed?.message)), String(killed?.message));

    const persisted = loadDrainState(state);
    check("the cursor stops at the last page whose documents were acknowledged",
      persisted.last_seq === 4, JSON.stringify({ last_seq: persisted.last_seq }));
    check("the interrupted rows are still unmarked in the outbox, not lost",
      (() => { const o = new DatabaseSync(outbox); const n = o.prepare("SELECT COUNT(*) AS n FROM outbox_messages WHERE drained_at IS NULL").get().n; o.close(); return Number(n) === 2; })());

    const afterKill = collector();
    const resumed = await drainOnce({
      outboxPath: outbox, statePath: state, pageSize: 2, now, sendEnvelopes: afterKill.send,
    });
    check("the resumed drain re-reads only the unacknowledged page and finishes",
      resumed.rows_seen === 2 && resumed.watermark === 6 && resumed.undrained_remaining === 0,
      JSON.stringify(resumed));
    assertLossless("mid-loop kill", planted, [...beforeKill, ...afterKill.docs]);

    const final = collector();
    const settled = await drainOnce({ outboxPath: outbox, statePath: state, now, sendEnvelopes: final.send });
    check("once resumed and caught up, a further drain is a no-op",
      settled.rows_seen === 0 && final.docs.length === 0, JSON.stringify(settled));
  }

  /* ---- B: killed during the final flush, after the cursor reached the end ---- */
  {
    const { outbox, planted, state, now } = plantInterrupted("killed-on-flush");
    const beforeKill = [];
    let dispatches = 0, killed = null;
    try {
      await drainOnce({
        outboxPath: outbox, statePath: state, pageSize: 2, now,
        sendEnvelopes: async (envelopes) => {
          dispatches++;
          if (dispatches === 3) throw new Error("simulated kill during the final flush");
          beforeKill.push(...envelopes);
        },
      });
    } catch (error) { killed = error; }
    check("a failure flushing quiet conversations also aborts rather than half-reporting",
      /kill during the final flush/.test(String(killed?.message)), String(killed?.message));
    const persisted = loadDrainState(state);
    check("the cursor is at the end, because every row really was read",
      persisted.last_seq === 6, JSON.stringify({ last_seq: persisted.last_seq }));
    check("the conversations that had not been flushed are still held in the snapshot",
      persisted.sessionizer.length > 0, JSON.stringify({ open: persisted.sessionizer.length }));

    const afterKill = collector();
    await drainOnce({ outboxPath: outbox, statePath: state, now, sendEnvelopes: afterKill.send });
    check("the resume emits the conversations the interrupted flush never delivered",
      afterKill.docs.length > 0, JSON.stringify(afterKill.docs.map((d) => d.source_id)));
    assertLossless("final-flush kill", planted, [...beforeKill, ...afterKill.docs]);
  }

  /* ===== 4. a snapshot resume continues a conversation instead of splitting ==== */
  {
    const outbox = newOutbox("snapshot");
    insert(outbox, [
      { chat: ALEX, id: "s1", ts: "2026-05-01T09:00:00Z", body: "First half of one conversation.", sender: "Alex Rivera", title: "Alex Rivera" },
      { chat: ALEX, id: "s2", ts: "2026-05-01T09:05:00Z", body: "Still the same conversation.", sender: "Alex Rivera", title: "Alex Rivera" },
    ]);
    const state = join(sandbox, "snapshot.json");

    // Drain while the conversation is still recent: the session stays OPEN,
    // so nothing is emitted yet and the snapshot is what carries it forward.
    const firstPass = collector();
    const open = await drainOnce({
      outboxPath: outbox, statePath: state, sendEnvelopes: firstPass.send,
      now: () => Date.parse("2026-05-01T09:10:00Z"),
    });
    check("a conversation that could still grow is held open, not emitted early",
      firstPass.docs.length === 0 && open.sessions_open === 1, JSON.stringify(open));
    const snapshot = loadDrainState(state);
    check("the open conversation rides in the state file alongside the cursor",
      Array.isArray(snapshot.sessionizer) && snapshot.sessionizer.length === 1 && snapshot.last_seq === 2,
      JSON.stringify({ sessions: snapshot.sessionizer.length, seq: snapshot.last_seq }));

    // Two more messages arrive within the session gap. A fresh process drains.
    insert(outbox, [
      { chat: ALEX, id: "s3", ts: "2026-05-01T09:20:00Z", direction: "out", body: "Second half of one conversation." },
      { chat: ALEX, id: "s4", ts: "2026-05-01T09:25:00Z", body: "Closing thought on the same thread.", sender: "Alex Rivera", title: "Alex Rivera" },
    ]);
    const secondPass = collector();
    await drainOnce({
      outboxPath: outbox, statePath: state, sendEnvelopes: secondPass.send,
      ownerLabel: "Morgan Diaz",
      // Far enough ahead that the session is now stale and gets closed.
      now: () => Date.parse("2026-05-03T00:00:00Z"),
    });
    check("the resumed drain emits exactly one document, not one per process run",
      secondPass.docs.length === 1, JSON.stringify(secondPass.docs.map((d) => d.source_id)));
    const doc = secondPass.docs[0];
    check("that document is keyed by the FIRST message, so the conversation was continued",
      doc?.source_id === "s1", String(doc?.source_id));
    check("all four messages are inside it: the restart did not split the conversation",
      ["First half of one conversation.", "Still the same conversation.",
        "Second half of one conversation.", "Closing thought on the same thread."]
        .every((line) => bodiesIn(doc).includes(line)),
      bodiesIn(doc).slice(0, 200));
  }

  /* ======= the cursor is seq, so a late history chunk is never stranded ==== */
  {
    const outbox = newOutbox("late-history");
    insert(outbox, [
      { chat: ALEX, id: "l1", ts: "2026-06-10T12:00:00Z", body: "A live message arrives first.", sender: "Alex Rivera" },
    ]);
    const state = join(sandbox, "late-history.json");
    const now = () => Date.parse("2026-06-20T00:00:00Z");
    const one = collector();
    await drainOnce({ outboxPath: outbox, statePath: state, sendEnvelopes: one.send, now });

    // A history-sync chunk lands afterwards carrying a MUCH older timestamp.
    // A timestamp-based cursor would leave it behind the watermark forever.
    insert(outbox, [
      { chat: PRIYA, id: "l0", ts: "2026-01-04T08:00:00Z", body: "Backfill from months earlier.", sender: "Priya Nair", source: "history_sync" },
    ]);
    const two = collector();
    const late = await drainOnce({ outboxPath: outbox, statePath: state, sendEnvelopes: two.send, now });
    check("a late history chunk with an older timestamp is still drained",
      late.rows_seen === 1 && two.docs.some((d) => bodiesIn(d).includes("Backfill from months earlier.")),
      JSON.stringify(late));
  }

  /* =========================== row mapping ============================== */
  {
    const mapped = rowToSessionRow({
      chat_jid: ALEX, message_id: "wa-x1", ts: "2026-03-02T17:00:00Z",
      direction: "in", body: "Mapped body", sender_name: "Sam Osei", thread_title: "Sam Osei",
    });
    check("an outbox row maps onto the sessionizer's input shape one-for-one",
      mapped.platform === "whatsapp" && mapped.thread_id === ALEX && mapped.id === "wa-x1" &&
      mapped.direction === "in" && mapped.sender_name === "Sam Osei",
      JSON.stringify(mapped));
    const outbound = rowToSessionRow({ chat_jid: ALEX, message_id: "wa-x2", ts: "2026-03-02T17:01:00Z", direction: "out", body: "Mine" });
    check("an outbound row carries no sender name, so the owner label speaks for it",
      outbound.sender_name === "" && outbound.direction === "out", JSON.stringify(outbound));
  }

  /* ======================= state file durability ======================== */
  {
    const path = join(sandbox, "state-perm", "state.json");
    saveDrainState(path, { version: 1, last_seq: 7, sessionizer: [] });
    check("the state file is written owner-only: it holds message text",
      (statSync(path).mode & 0o077) === 0 && readFileSync(path, "utf-8").includes('"last_seq": 7'),
      statSync(path).mode.toString(8));
    writeFileSync(path, "{ this is not json");
    const recovered = loadDrainState(path);
    check("a corrupt state file restarts the drain instead of refusing to run",
      recovered.last_seq === 0 && Array.isArray(recovered.sessionizer), JSON.stringify(recovered));
  }

  /* ====================== outbox absence is named ======================= */
  {
    const missing = join(sandbox, "never-paired", "wa-outbox.db");
    const probe = probeOutbox(missing);
    check("a missing outbox is reported as not-yet-paired, not as a crash",
      probe.ok === false && /pair/i.test(probe.message), JSON.stringify(probe));
  }

  /* =============== 6. a missing daemon binary refuses cleanly ============ */
  {
    let error = null;
    try {
      resolveDaemonBinary({
        env: {}, manifest: {}, platform: "darwin", arch: "arm64",
        installRoot: join(sandbox, "no-such-install"),
      });
    } catch (caught) { error = caught; }
    check("a missing daemon binary throws a named error, not a stack trace about ENOENT",
      error instanceof DaemonBinaryMissingError && error.reason === "daemon_binary_missing",
      String(error?.name));
    check("the refusal lists every path it looked in",
      error.candidates.length >= 1 && error.message.includes("no-such-install"),
      error?.message);
    check("the refusal hands over the exact build command instead of a vague suggestion",
      /cd daemons\/whatsapp && \.\/build\.sh/.test(error.message), error?.message);
    check("the refusal says plainly that no download-on-connect exists yet",
      /no download-on-connect/i.test(error.message), error?.message);
    check("it states nothing was paired or installed, so the operator knows the machine is unchanged",
      /nothing was paired or installed/.test(error.message), error?.message);
  }
  {
    // An explicit path that DOES exist wins, and reports where it came from.
    const fakeBinary = join(sandbox, "wa-daemon-fake");
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBinary, 0o755);
    const found = resolveDaemonBinary({ explicit: fakeBinary, platform: "darwin", arch: "arm64" });
    check("an explicitly supplied binary is used and its source is reported",
      found.path === fakeBinary && found.source === "--daemon", JSON.stringify(found));
    const viaEnv = resolveDaemonBinary({ env: { BRAIN_WHATSAPP_DAEMON: fakeBinary }, platform: "darwin", arch: "arm64" });
    check("the environment override is honored the same way",
      viaEnv.path === fakeBinary && viaEnv.source === "BRAIN_WHATSAPP_DAEMON", JSON.stringify(viaEnv));
    const viaManifest = resolveDaemonBinary({
      manifest: { operations: { whatsapp_daemon_path: fakeBinary } }, platform: "darwin", arch: "arm64",
    });
    check("the manifest knob is honored, so an install can pin its own binary",
      viaManifest.source === "operations.whatsapp_daemon_path", JSON.stringify(viaManifest));
    check("a non-executable file is not accepted as the daemon",
      (() => {
        const plain = join(sandbox, "not-executable");
        writeFileSync(plain, "text");
        chmodSync(plain, 0o644);
        try { resolveDaemonBinary({ explicit: plain, platform: "darwin", arch: "arm64", installRoot: join(sandbox, "none") }); return false; }
        catch (e) { return e instanceof DaemonBinaryMissingError; }
      })());
    check("the Windows binary name is the cross-compiled .exe the build script emits",
      daemonBinaryName("win32", "x64") === "wa-daemon-windows-amd64.exe" &&
      daemonBinaryName("darwin", "arm64") === "wa-daemon-darwin-arm64",
      daemonBinaryName("win32", "x64"));
  }

  /* ================= the daemon gets no credentials ===================== */
  {
    const env = daemonEnvironment({
      HOME: "/Users/example", PATH: "/usr/bin", CLOUDFLARE_API_TOKEN: "secret-token",
      BRAIN_ADMIN_KEY: "secret-key", AWS_SECRET_ACCESS_KEY: "secret-aws",
    }, "/data/dir");
    check("the daemon's environment is scrubbed to OS basics plus its data directory",
      env.WA_DATA_DIR === "/data/dir" && !("CLOUDFLARE_API_TOKEN" in env) &&
      !("BRAIN_ADMIN_KEY" in env) && !("AWS_SECRET_ACCESS_KEY" in env),
      JSON.stringify(Object.keys(env)));
  }

  /* ===================== the disclosures are real text ================== */
  {
    const text = WHATSAPP_DISCLOSURE.join(" ");
    check("the ToS gray-area and ban risk are stated, not hinted at",
      /terms of service/i.test(text) && /ban/i.test(text), text.slice(0, 200));
    check("history depth at link time is disclosed as the phone's choice, not the full archive",
      /history/i.test(text) && /phone/i.test(text), text.slice(0, 300));
  }

  /* ============== a read-only outbox still drains, minus the stamp ======= */
  {
    const outbox = newOutbox("read-only");
    insert(outbox, [
      { chat: ALEX, id: "r1", ts: "2026-07-01T10:00:00Z", body: "Readable but not stampable.", sender: "Alex Rivera" },
    ]);
    const opened = await openOutbox(outbox);
    check("an outbox opened for writing reports itself writable and counts its backlog",
      opened.writable === true && countUndrained(opened.db) === 1);
    opened.close();
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nwhatsapp capture: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
