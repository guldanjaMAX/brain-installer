// test/whatsapp-ingest.test.mjs
//
// The CLI wiring for WP-07, driven the way test/imessage-ingest.test.mjs
// drives iMessage: the REAL command functions (cmdIngestWhatsapp,
// cmdConnectWhatsapp, cmdDisconnectWhatsapp) run against a REAL fixture
// outbox database, with only the outside world faked — the brain's
// batch-ingest endpoint, the source receipts, the freshness expectation, the
// admin key, launchd (via fake agent modules) and the daemon process itself.
//
// Every persona is invented, matching test/fixtures/whatsapp/.
//
// WHAT THIS CANNOT PROVE: a real pairing. `pairDaemon` is exercised here
// against a scripted stand-in process that emits the daemon's own log lines,
// which proves the wizard reads those lines correctly — it does NOT prove
// that a phone can scan the QR or that WhatsApp transfers any history. That
// needs a real account and is named as unproven in evidence/WP-07-cli.md.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";

import {
  cmdConnectWhatsapp,
  cmdDisconnectWhatsapp,
  cmdIngestWhatsapp,
} from "../brain.mjs";
import { pairDaemon, PairingError } from "../connectors/whatsapp.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-whatsapp-ingest-")));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = {
  manifest_version: 1,
  client: { slug: "acme", display_name: "Morgan Diaz", timezone: "America/Phoenix" },
  brain: { version: "0.1.22", domain: "brain.acme-example.test", worker_name: "acme-brain" },
  corpora: { whatsapp: { enabled: true } },
  operations: {},
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

/* ------------------------------------------------- the fixture outbox */
const dataDir = join(sandbox, "wa-data");
const outboxPath = join(dataDir, "wa-outbox.db");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(outboxPath);
db.exec(`
CREATE TABLE outbox_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL, message_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'whatsapp', ts TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')), body TEXT NOT NULL,
  sender_jid TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '',
  thread_title TEXT NOT NULL DEFAULT '', is_group INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('live','history_sync')),
  received_at TEXT NOT NULL, drained_at TEXT, UNIQUE (chat_jid, message_id));`);
const insert = db.prepare(`INSERT INTO outbox_messages
  (chat_jid,message_id,ts,direction,body,sender_jid,sender_name,thread_title,is_group,source,received_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const SAM = "14155550111@s.whatsapp.net";
const JORDAN = "14155550112@s.whatsapp.net";
insert.run(SAM, "wi-1", "2026-03-02T17:00:00Z", "in", "Can you send the signed lease back today?", SAM, "Sam Osei", "Sam Osei", 0, "history_sync", "2026-03-02T17:00:01Z");
insert.run(SAM, "wi-2", "2026-03-02T17:04:00Z", "out", "Signing it now, over in ten minutes.", "", "", "Sam Osei", 0, "history_sync", "2026-03-02T17:04:01Z");
insert.run(JORDAN, "wi-3", "2026-03-03T09:00:00Z", "in", "Deposit posted, statement attached.", JORDAN, "Jordan Lee", "Jordan Lee", 0, "live", "2026-03-03T09:00:01Z");
insert.run(JORDAN, "wi-4", "2026-03-03T09:01:00Z", "in", "[image]", JORDAN, "Jordan Lee", "Jordan Lee", 0, "live", "2026-03-03T09:01:01Z");
db.close();

/* ------------------------------------------------------- the fake brain */
function makeBrainFakes() {
  const receipts = [], batches = [], expectations = [];
  return {
    receipts, batches, expectations,
    options: {
      platform: "darwin",
      dataDir,
      resolveAdminKey: () => "fixture-admin-key",
      resolveBaseUrl: async () => "https://brain.acme-example.test",
      postSourceReceipt: async (_b, _k, receipt) => { receipts.push(receipt); return receipt; },
      postSourceExpectation: async (_b, _k, exp) => { expectations.push(exp); return exp; },
      requestIngestBatch: async ({ docs }) => {
        batches.push(docs);
        return {
          res: { ok: true, status: 200 },
          raw: JSON.stringify({ results: docs.map((d) => ({ source_id: d.source_id, status: "created" })) }),
        };
      },
    },
  };
}

// The manifest knob is what points both halves at the fixture directory.
const manifestWithDataDir = { ...manifest, operations: { ...manifest.operations, whatsapp_data_dir: dataDir } };
const manifestPathWithDataDir = join(sandbox, "brain.manifest.datadir.json");
writeFileSync(manifestPathWithDataDir, JSON.stringify(manifestWithDataDir, null, 2));

/* --------------------------------------- fake launchd-facing agent modules */
function fakeAgents() {
  const events = [];
  return {
    events,
    whatsappDaemon: {
      installWhatsappDaemon: (path, opts) => {
        events.push(["daemon:install", opts?.binaryPath || null]);
        return { plistPath: "/fake/daemon.plist", stdoutPath: "/fake/out.log", stderrPath: "/fake/err.log", installed: true, loaded: true };
      },
      removeWhatsappDaemon: () => {
        events.push(["daemon:remove"]);
        return { removed: true, wasLoaded: true, stdoutPath: "/fake/out.log", stderrPath: "/fake/err.log" };
      },
    },
    whatsappDrainScheduler: {
      installWhatsappDrainScheduler: () => {
        events.push(["drain:install"]);
        return { plistPath: "/fake/drain.plist", cron: "* * * * *", expectedRefreshSeconds: 60, warnings: [] };
      },
      removeWhatsappDrainScheduler: () => {
        events.push(["drain:remove"]);
        return { removed: true, loaded: true };
      },
    },
  };
}

/* ------------ a scripted stand-in for the daemon process, for pairing ----- */
function scriptedDaemon(lines, { exitAfter = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      for (const line of lines) child.stderr.emit("data", line + "\n");
      if (exitAfter) child.emit("exit", 1, null);
    });
    return child;
  };
}

try {
  /* ============== one drain through the real CLI command ================= */
  {
    const fakes = makeBrainFakes();
    const result = await cmdIngestWhatsapp(manifestWithDataDir, manifestPathWithDataDir, {}, fakes.options);
    check("the drain reads the fixture outbox and reports counts",
      result.rows_seen === 4 && result.rows_pushed === 3 && result.watermark === 4,
      JSON.stringify(result));
    const sent = fakes.batches.flat();
    check("both conversations were sent as session documents",
      sent.length === 2 && sent.some((d) => d.source_id === "wi-1") && sent.some((d) => d.source_id === "wi-3"),
      JSON.stringify(sent.map((d) => d.source_id)));
    check("every document carries source_type whatsapp, so forget --source whatsapp scopes to it",
      sent.every((d) => d.source_type === "whatsapp"), JSON.stringify(sent.map((d) => d.source_type)));
    check("the owner's manifest display name speaks for outbound messages",
      sent.find((d) => d.source_id === "wi-1").content.includes("Morgan Diaz:"));
    check("the media-only row never became a document",
      !sent.some((d) => /\[image\]/.test(d.content)) && result.rows_skipped.media_only === 1,
      JSON.stringify(result.rows_skipped));
    check("an indexing receipt opened and a ready receipt closed the run, kind whatsapp",
      fakes.receipts.length === 2 && fakes.receipts[0].status === "indexing" &&
      fakes.receipts[1].status === "ready" &&
      fakes.receipts.every((r) => r.kind === "whatsapp" && r.source === "whatsapp"),
      JSON.stringify(fakes.receipts.map((r) => r.status)));
    check("drain state landed beside the manifest under the source's name",
      existsSync(join(sandbox, ".brain-ingest-whatsapp.json")));
  }
  {
    const fakes = makeBrainFakes();
    const again = await cmdIngestWhatsapp(manifestWithDataDir, manifestPathWithDataDir, {}, fakes.options);
    check("a second drain through the CLI is incremental: nothing re-read, nothing re-sent",
      again.rows_seen === 0 && fakes.batches.length === 0, JSON.stringify(again));
  }

  /* ============== an unpaired machine is named, not crashed ============== */
  {
    const bare = join(sandbox, "unpaired.manifest.json");
    writeFileSync(bare, JSON.stringify({
      ...manifest, operations: { whatsapp_data_dir: join(sandbox, "never-paired") },
    }, null, 2));
    // No options.dataDir here on purpose: this proves the manifest knob is
    // what points the drain at a directory that was never paired.
    const { dataDir: _ignored, ...noOverride } = makeBrainFakes().options;
    let error = null;
    try {
      await cmdIngestWhatsapp(JSON.parse(readFileSync(bare, "utf-8")), bare, {}, noOverride);
    } catch (caught) { error = caught; }
    check("draining before pairing says so instead of failing on a missing file",
      /pair/i.test(String(error?.message)), String(error?.message));
  }

  /* ======= connect refuses cleanly when the daemon binary is absent ======= */
  {
    const fakes = makeBrainFakes();
    const agents = fakeAgents();
    let error = null;
    try {
      await cmdConnectWhatsapp(manifestPathWithDataDir, { "accept-risk": true }, {
        ...fakes.options, ...agents, env: {},
        // An install root with no dist/ directory, so no candidate resolves.
        whatsapp: { ...await import("../connectors/whatsapp.mjs") },
      });
    } catch (caught) { error = caught; }
    check("connect with no daemon binary fails with a readable message, not a stack trace",
      error && /capture daemon binary was not found/.test(String(error.message)), String(error?.message));
    check("that message carries the build command the operator should run",
      /cd daemons\/whatsapp && \.\/build\.sh/.test(String(error?.message)), String(error?.message));
    check("nothing was installed: no LaunchAgent was touched before the binary check",
      agents.events.length === 0, JSON.stringify(agents.events));
    check("no receipt or expectation was posted either",
      fakes.receipts.length === 0 && fakes.expectations.length === 0);
  }

  /* ============ D-2: live capture is opt-in and refuses to assume ========= */
  {
    const binary = join(sandbox, "wa-daemon-darwin-arm64");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    const fakes = makeBrainFakes();
    const agents = fakeAgents();
    let error = null;
    try {
      await cmdConnectWhatsapp(manifestPathWithDataDir, { daemon: binary }, { ...fakes.options, ...agents, env: {} });
    } catch (caught) { error = caught; }
    check("without --accept-risk nothing is paired and the command says so",
      /nothing was paired/i.test(String(error?.message)), String(error?.message));
    check("the refusal repeats the exact command that would opt in",
      /--accept-risk/.test(String(error?.message)), String(error?.message));
    check("no agent was installed by the refused run",
      agents.events.length === 0, JSON.stringify(agents.events));
  }
  {
    // The corpus flag is the second half of the opt-in.
    const off = join(sandbox, "corpus-off.manifest.json");
    writeFileSync(off, JSON.stringify({ ...manifest, corpora: {} }, null, 2));
    let error = null;
    try { await cmdConnectWhatsapp(off, { "accept-risk": true }, { ...makeBrainFakes().options, ...fakeAgents() }); }
    catch (caught) { error = caught; }
    check("connect refuses while corpora.whatsapp.enabled is not declared true",
      /corpora\.whatsapp\.enabled is not true/.test(String(error?.message)), String(error?.message));
  }
  {
    let error = null;
    try {
      await cmdConnectWhatsapp(manifestPathWithDataDir, { "accept-risk": true },
        { ...makeBrainFakes().options, platform: "win32" });
    } catch (caught) { error = caught; }
    check("connect on Windows refuses and calls it a missing installer, not a missing capability",
      /needs macOS/.test(String(error?.message)) &&
      /missing installer, not a missing capability/.test(String(error?.message)),
      String(error?.message));
  }

  /* =============== the pairing wizard reads the daemon's own lines ======== */
  {
    const paired = await pairDaemon({
      binaryPath: "/fake/wa-daemon", dataDir: join(sandbox, "pair-a"),
      spawn: scriptedDaemon([
        "[wa-daemon] session store: /x/wa-session.db",
        "[wa-daemon] paired with 14155550100:1@s.whatsapp.net",
        "[wa-daemon] history chunk INITIAL_BOOTSTRAP: convs=4 inserted=37 duplicate=0 skipped=1",
        "[wa-daemon] history chunk RECENT: convs=2 inserted=5 duplicate=3 skipped=0",
      ]),
      historyQuietMs: 5, historyMaxMs: 500, pairTimeoutMs: 500,
    });
    check("pairing is detected from the daemon's own pair-success line",
      paired.paired === true && paired.alreadyPaired === false, JSON.stringify(paired));
    check("the link-time history is counted from the daemon's chunk lines",
      paired.historyChunks === 2 && paired.historyInserted === 42, JSON.stringify(paired));
    check("the wizard waits for history to go quiet rather than exiting on pairing",
      paired.reason === "history_quiet", paired.reason);
  }
  {
    const reconnected = await pairDaemon({
      binaryPath: "/fake/wa-daemon", dataDir: join(sandbox, "pair-b"),
      spawn: scriptedDaemon(["[wa-daemon] connected as 14155550100:1@s.whatsapp.net"]),
      historyQuietMs: 5, historyMaxMs: 500, pairTimeoutMs: 500,
    });
    check("an already-paired machine is recognised as a reconnect, not a fresh pairing",
      reconnected.paired === true && reconnected.alreadyPaired === true, JSON.stringify(reconnected));
  }
  {
    let error = null;
    try {
      await pairDaemon({
        binaryPath: "/fake/wa-daemon", dataDir: join(sandbox, "pair-c"),
        spawn: scriptedDaemon(["[wa-daemon] outbox: /x/wa-outbox.db"], { exitAfter: true }),
        historyQuietMs: 5, historyMaxMs: 500, pairTimeoutMs: 500,
      });
    } catch (caught) { error = caught; }
    check("a daemon that dies before pairing reports why, with its last lines",
      error instanceof PairingError && error.reason === "daemon_exited", String(error?.message));
  }
  {
    let error = null;
    try {
      await pairDaemon({
        binaryPath: "/fake/wa-daemon", dataDir: join(sandbox, "pair-d"),
        spawn: scriptedDaemon(["[wa-daemon] logged out by the phone or by WhatsApp; delete the session store"]),
        historyQuietMs: 5, historyMaxMs: 500, pairTimeoutMs: 500,
      });
    } catch (caught) { error = caught; }
    check("a logout during pairing is named and nothing is installed",
      error instanceof PairingError && error.reason === "logged_out" &&
      /Nothing was installed/.test(error.message), String(error?.message));
  }
  {
    let error = null;
    try {
      await pairDaemon({
        binaryPath: "/fake/wa-daemon", dataDir: join(sandbox, "pair-e"),
        spawn: scriptedDaemon([]), pairTimeoutMs: 5, historyQuietMs: 5, historyMaxMs: 50,
      });
    } catch (caught) { error = caught; }
    check("an unscanned QR times out with the phone steps, not a hang",
      error instanceof PairingError && error.reason === "pair_timeout" &&
      /Linked Devices/.test(error.message), String(error?.message));
  }

  /* ================= connect end to end, with the world faked ============= */
  {
    const binary = join(sandbox, "wa-daemon-darwin-arm64");
    const fakes = makeBrainFakes();
    const agents = fakeAgents();
    // Reset the drain state so the connect run has something to load.
    rmSync(join(sandbox, ".brain-ingest-whatsapp.json"), { force: true });
    const result = await cmdConnectWhatsapp(manifestPathWithDataDir, { daemon: binary, "accept-risk": true }, {
      ...fakes.options, ...agents, env: {},
      pairOptions: {
        spawn: scriptedDaemon([
          "[wa-daemon] paired with 14155550100:1@s.whatsapp.net",
          "[wa-daemon] history chunk INITIAL_BOOTSTRAP: convs=2 inserted=4 duplicate=0 skipped=0",
        ]),
        historyQuietMs: 5, historyMaxMs: 500, pairTimeoutMs: 500,
      },
    });
    check("connect pairs, installs the daemon, drains, then installs the drain tick, in that order",
      JSON.stringify(agents.events.map((e) => e[0])) ===
      JSON.stringify(["daemon:install", "drain:install"]),
      JSON.stringify(agents.events));
    check("the supervised daemon is installed with the binary that was actually paired",
      agents.events[0][1] === binary, String(agents.events[0][1]));
    check("the initial drain ran and delivered the fixture conversations",
      fakes.batches.flat().length === 2, JSON.stringify(fakes.batches.flat().map((d) => d.source_id)));
    check("a freshness expectation is registered so brain sources can be honest about staleness",
      fakes.expectations.length === 1 && fakes.expectations[0].source === "whatsapp" &&
      fakes.expectations[0].expected_refresh_seconds === 60,
      JSON.stringify(fakes.expectations));
    check("connect reports the pairing it observed",
      result.paired.paired === true && result.paired.historyInserted === 4, JSON.stringify(result.paired));
  }

  /* ============================= disconnect ============================== */
  {
    const fakes = makeBrainFakes();
    const agents = fakeAgents();
    const result = await cmdDisconnectWhatsapp(manifestPathWithDataDir, {}, { ...fakes.options, ...agents });
    check("disconnect stops the drain tick BEFORE the daemon, so no pass races the final one",
      JSON.stringify(agents.events.map((e) => e[0])) === JSON.stringify(["drain:remove", "daemon:remove"]),
      JSON.stringify(agents.events));
    check("disconnect reports both agents removed",
      result.daemon.removed === true && result.drain.removed === true, JSON.stringify(result));
    check("the freshness expectation is cleared, so a disconnected source is not reported stale forever",
      fakes.expectations.length === 1 && fakes.expectations[0].expected_refresh_seconds === null,
      JSON.stringify(fakes.expectations));
    check("a final drain and an open-session flush both ran during removal",
      fakes.receipts.some((r) => /flush/i.test(String(r.detail || ""))), JSON.stringify(fakes.receipts.map((r) => r.detail)));
  }
  {
    // The Drive and iMessage precedent: removal must stay reachable when the
    // corpus flag is already off.
    const off = join(sandbox, "disconnect-corpus-off.manifest.json");
    writeFileSync(off, JSON.stringify({
      ...manifest, corpora: {}, operations: { whatsapp_data_dir: dataDir },
    }, null, 2));
    const agents = fakeAgents();
    const result = await cmdDisconnectWhatsapp(off, {}, { ...makeBrainFakes().options, ...agents });
    check("disconnect works with corpora.whatsapp.enabled already false",
      result.daemon.removed === true && agents.events.length === 2, JSON.stringify(agents.events));
  }
  {
    // An unreachable brain must not make removal unreachable.
    const agents = fakeAgents();
    const broken = makeBrainFakes();
    broken.options.requestIngestBatch = async () => { throw new Error("network is down"); };
    broken.options.postSourceExpectation = async () => { throw new Error("network is down"); };
    // Give the drain something to send so the failing batch is actually hit.
    const db2 = new DatabaseSync(outboxPath);
    db2.prepare(`INSERT INTO outbox_messages
      (chat_jid,message_id,ts,direction,body,sender_jid,sender_name,thread_title,is_group,source,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(SAM, "wi-9", "2026-03-09T10:00:00Z", "in", "One more before we disconnect.", SAM, "Sam Osei", "Sam Osei", 0, "live", "2026-03-09T10:00:01Z");
    db2.close();
    const result = await cmdDisconnectWhatsapp(manifestPathWithDataDir, {}, { ...broken.options, ...agents });
    check("an unreachable brain never blocks stopping the background processes",
      result.daemon.removed === true && result.drain.removed === true &&
      agents.events.length === 2, JSON.stringify(agents.events));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nwhatsapp CLI: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
