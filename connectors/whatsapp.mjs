/**
 * WhatsApp live capture, Node half — drain the capture daemon's local outbox
 * into the brain, and drive the pairing that creates it.
 *
 * THE SPLIT, AND WHY IT IS THIS WAY. `daemons/whatsapp/` is a small Go binary
 * that holds the WhatsApp websocket open and writes one row per message into a
 * local SQLite outbox. It sessionizes nothing, batches nothing, and speaks no
 * HTTP. Everything above that line lives here, in the same JavaScript every
 * other message source already uses: `ingest/message-session.mjs` groups the
 * stream into bounded conversation documents and the shared batch push carries
 * them to the client's own worker, credential gate included. One
 * implementation of the grouping rules, in one language, is the whole point —
 * a second copy in Go would drift the first time the session defaults change.
 *
 * THE FOUR INVARIANTS THIS FILE EXISTS TO KEEP TRUE
 *
 * 1. IDEMPOTENT ON MESSAGE IDENTITY. The daemon's outbox is already unique on
 *    (chat_jid, message_id), so a message delivered twice (reconnect replay, or
 *    once live and again inside a history-sync chunk) is one row. That row's
 *    id becomes part of the session document's source_id, so re-sending a page
 *    produces byte-identical documents the worker acknowledges as "unchanged".
 *    Re-running is therefore always safe.
 *
 * 2. THE CURSOR ONLY ADVANCES PAST DURABLE WORK. State carries BOTH the
 *    highest outbox `seq` consumed AND the sessionizer's open-session snapshot,
 *    written atomically together (tmp + rename, owner-only), and only after the
 *    page's closed documents were acknowledged. A kill at any point replays at
 *    most one page into the previous snapshot: same sessions again, never a
 *    split conversation and never a gap.
 *
 * 3. `drained_at` IS TELEMETRY, THE CURSOR IS TRUTH. The drain stamps
 *    `drained_at` on everything at or below the cursor so the daemon's own
 *    "N undrained" line stays honest, but it never reads that column to decide
 *    what to send. The stamp is a best-effort write into a database another
 *    process owns; if it is busy, read-only, or interrupted, the next drain
 *    stamps the same range again (`WHERE seq <= cursor AND drained_at IS NULL`)
 *    and nothing is lost either way.
 *
 * 4. ARRIVAL ORDER IS NOT TIME ORDER, AND THAT IS HANDLED, NOT IGNORED.
 *    chat.db hands the iMessage connector rows in ROWID order, which is also
 *    chronological. WhatsApp does not: history-sync chunks land on concurrent
 *    goroutines, so an older message can carry a higher `seq` than a newer one.
 *    Each page is therefore sorted by (ts, seq) before it reaches the
 *    sessionizer, which documents itself as consuming a chronological stream.
 *    Across a page boundary the guarantee is weaker and is reported rather than
 *    hidden: `rows_out_of_order` counts rows older than the previous page's
 *    newest, and the only consequence is that one conversation-day may be
 *    represented by two documents instead of one. No message is dropped and
 *    none is duplicated.
 *
 * TERMS OF SERVICE. Pairing joins the owner's WhatsApp account as a linked
 * device through a reimplementation of the multi-device protocol, not an
 * official API. That is a gray area with a real, if historically small, ban
 * risk, and it ships behind an explicit opt-in for exactly that reason. The
 * disclosure below is the product's voice on it and is printed before anything
 * is paired.
 */

import {
  chmodSync,
  constants as fsConstants,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGE_SESSION_DEFAULTS, MessageSessionizer, messageRowDisposition } from "../ingest/message-session.mjs";
// Not a copy, and not a layering accident: the stale-session sweep touches
// only the sessionizer and knows nothing about Messages.app. It was written
// for the first tick-based capture connector and is imported here rather than
// re-typed, because two copies of a session-closing rule is exactly the drift
// this package's architecture exists to avoid.
import { finishStaleSessions } from "./imessage.mjs";

export { finishStaleSessions };

const INSTALLER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every message this connector loads is tagged with this platform. */
export const WHATSAPP_PLATFORM = "whatsapp";

/**
 * One drain page. Larger than the iMessage scan unit on purpose: a history
 * sync that lands out of order is fully reordered inside a page, so a page big
 * enough to swallow a typical link-time backfill in one bite is the cheapest
 * way to keep conversation-days whole (invariant 4).
 */
export const WHATSAPP_DRAIN_PAGE_SIZE = 5000;

/** File names the Go daemon uses inside its data directory. */
export const WHATSAPP_SESSION_DB_NAME = "wa-session.db";
export const WHATSAPP_OUTBOX_DB_NAME = "wa-outbox.db";

/**
 * Where this install keeps the daemon's two SQLite files.
 *
 * Per install, not per user: one machine may host more than one brain, and two
 * installs sharing one WhatsApp session store would fight over a single-writer
 * database. The daemon's own standalone default is a per-user application-data
 * directory; the CLI overrides it with WA_DATA_DIR, which its path resolver
 * always honors.
 */
export function defaultDataDir(slug, home = homedir()) {
  if (!slug) throw new Error("a client slug is required to place the WhatsApp data directory");
  return join(home, ".brain", "whatsapp", String(slug));
}

export const outboxPathFor = (dataDir) => join(dataDir, WHATSAPP_OUTBOX_DB_NAME);
export const sessionDbPathFor = (dataDir) => join(dataDir, WHATSAPP_SESSION_DB_NAME);

/**
 * The disclosure, in the product's voice, printed before pairing and repeated
 * in the source matrix. Decision D-2 (opt-in versus default-on) is not made
 * yet, so this capability is opt-in twice over: the manifest must declare the
 * corpus AND the operator must pass the acceptance flag.
 */
export const WHATSAPP_DISCLOSURE = Object.freeze([
  "Before you pair anything, two things you are owed in plain language:",
  "",
  "  Terms of service. This works by joining your WhatsApp account as a linked",
  "  device using a reimplementation of WhatsApp's own protocol, not an official",
  "  API. WhatsApp's terms do not bless unofficial clients, and accounts using",
  "  them carry a real, if historically small, risk of being warned or banned.",
  "  Nobody can quantify that risk for you, and anyone who says it is zero is",
  "  selling something. If losing this WhatsApp account would hurt, do not pair it.",
  "",
  "  History depth is whatever your phone gives. At link time WhatsApp's servers",
  "  push the history window your phone decides to transfer, typically weeks to a",
  "  few months of recent chats, never your whole archive. There is no setting",
  "  here that asks for more. If the full archive is what you need, use the",
  "  per-chat Export chat path instead; that one has no ban risk at all.",
]);

/* ------------------------------------------------------------------ access */

/** Every outbox access failure this connector can name. */
export const OUTBOX_ACCESS_REASONS = Object.freeze([
  "outbox_missing",
  "outbox_denied",
  "outbox_unreadable",
]);

export class OutboxAccessError extends Error {
  constructor(reason, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OutboxAccessError";
    this.reason = reason;
  }
}

/**
 * Attempt a real open and name what happened. A missing outbox is the ordinary
 * "you have not paired yet" case and must never be reported as corruption.
 */
export function probeOutbox(path, { open = openSync, close = closeSync } = {}) {
  let fd;
  try {
    fd = open(path, fsConstants.O_RDONLY);
    return { ok: true, path };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        reason: "outbox_missing",
        path,
        message:
          `no WhatsApp capture outbox exists at ${path}. The capture daemon has not ` +
          "run here yet, so there is nothing to load. Pair it first with `brain connect whatsapp <manifest>`.",
      };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return {
        ok: false,
        reason: "outbox_denied",
        path,
        message: `the operating system refused to open the WhatsApp outbox at ${path} (${error.code}). ` +
          "It belongs to the user the capture daemon runs as; run this command as that user.",
      };
    }
    return {
      ok: false,
      reason: "outbox_unreadable",
      path,
      message: `the WhatsApp outbox at ${path} could not be opened: ${error?.message || error}`,
    };
  } finally {
    if (fd !== undefined) close(fd);
  }
}

async function sqliteDatabaseSync() {
  // node:sqlite ships with Node 22+, which package.json already requires.
  // Imported lazily so merely loading this module never prints the
  // experimental-feature warning for commands that never touch the outbox.
  const { DatabaseSync } = await import("node:sqlite");
  return DatabaseSync;
}

/**
 * Open the outbox for reading, preferring read-write so `drained_at` can be
 * stamped, and degrading to read-only rather than failing. The daemon is the
 * writer and may hold the database; busy_timeout lets a stamp wait rather than
 * error, and a stamp that still cannot land is skipped, not retried forever.
 */
export async function openOutbox(path, { DatabaseSync = null, busyTimeoutMs = 10_000 } = {}) {
  const probe = probeOutbox(path);
  if (!probe.ok) throw new OutboxAccessError(probe.reason, probe.message);
  const Database = DatabaseSync || (await sqliteDatabaseSync());

  const prepare = (db) => {
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 0}`);
    db.prepare("SELECT count(*) AS n FROM outbox_messages").get();
    return db;
  };

  try {
    const db = prepare(new Database(path));
    return { db, writable: true, close: () => db.close() };
  } catch (writeOpenError) {
    try {
      const db = prepare(new Database(path, { readOnly: true }));
      return {
        db,
        writable: false,
        readOnlyReason: String(writeOpenError?.message || writeOpenError),
        close: () => db.close(),
      };
    } catch (readOpenError) {
      throw new OutboxAccessError(
        "outbox_unreadable",
        `the WhatsApp outbox at ${path} could not be opened for writing ` +
          `(${String(writeOpenError?.message || writeOpenError)}) or for reading ` +
          `(${String(readOpenError?.message || readOpenError)})`,
        { cause: readOpenError }
      );
    }
  }
}

/**
 * One page, strictly after the cursor, in seq order. `seq` is SQLite's own
 * monotonic AUTOINCREMENT, so "everything after the last one seen" is a
 * complete resume with no clock involved — which is precisely why the cursor
 * is seq and not a timestamp: a late history chunk carries an old ts and would
 * fall behind a ts cursor forever.
 */
export function fetchOutboxSince(db, sinceSeq, limit = WHATSAPP_DRAIN_PAGE_SIZE) {
  return db.prepare(
    `SELECT seq, chat_jid, message_id, ts, direction, body,
            sender_name, thread_title, is_group, source
       FROM outbox_messages
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`
  ).all(sinceSeq, limit);
}

/**
 * Mark everything at or below the cursor as drained. Idempotent by
 * construction, so a stamp missed during a crash is repaired by the next run.
 */
export function markDrained(db, throughSeq, at = new Date().toISOString()) {
  const result = db.prepare(
    "UPDATE outbox_messages SET drained_at = ? WHERE seq <= ? AND drained_at IS NULL"
  ).run(at, throughSeq);
  return Number(result?.changes || 0);
}

/** How many rows the daemon has captured that this drain has not consumed. */
export function countUndrained(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM outbox_messages WHERE drained_at IS NULL").get();
  return Number(row?.n || 0);
}

/** Map one outbox row to the shape MessageSessionizer.push() consumes. */
export function rowToSessionRow(row) {
  const outbound = String(row.direction || "") === "out";
  return {
    id: String(row.message_id || ""),
    ts: row.ts ? String(row.ts) : null,
    body: String(row.body || ""),
    platform: WHATSAPP_PLATFORM,
    thread_id: String(row.chat_jid || "unknown"),
    thread_title: String(row.thread_title || ""),
    direction: outbound ? "out" : "in",
    // The owner speaks under their manifest name; an inbound speaker is
    // whatever push name WhatsApp supplied, which may be a phone number. No
    // contact-book resolution happens anywhere in this connector.
    sender_name: outbound ? "" : String(row.sender_name || ""),
  };
}

/* ------------------------------------------------------------------- state */

const FRESH_DRAIN_STATE = () => ({ version: 1, last_seq: 0, sessionizer: [] });

export function loadDrainState(path) {
  if (!existsSync(path)) return FRESH_DRAIN_STATE();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && parsed.version === 1 && Number.isSafeInteger(parsed.last_seq) &&
        parsed.last_seq >= 0 && Array.isArray(parsed.sessionizer)) {
      return parsed;
    }
  } catch { /* fall through */ }
  // A corrupt state file must not abort the drain. Restarting from seq zero
  // costs one re-read of already-sent rows (all acknowledged unchanged);
  // refusing to run costs every message from now on.
  return FRESH_DRAIN_STATE();
}

export function saveDrainState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  // The snapshot carries message text from open conversations, so the file is
  // owner-only, and it is replaced atomically so a kill mid-write can never
  // leave half-written JSON that silently restarts the drain from zero.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* original error wins */ }
    throw error;
  }
}

/* ------------------------------------------------------------------- drain */

/**
 * One complete drain pass: read every outbox row after the cursor, sessionize,
 * send closed documents, persist, stamp. Returns honest counts so an initial
 * history load can report what it actually did.
 */
export async function drainOnce({
  outboxPath,
  statePath,
  sendEnvelopes,
  ownerLabel = "Owner",
  groupingTimezone = "UTC",
  pageSize = WHATSAPP_DRAIN_PAGE_SIZE,
  maxRows = Infinity,
  maxGapMs = MESSAGE_SESSION_DEFAULTS.maxGapMs,
  now = () => Date.now(),
  openDb = openOutbox,
  flushOnly = false,
  dryRun = false,
  reset = false,
  onPage = () => {},
} = {}) {
  if (!statePath) throw new Error("drainOnce requires a statePath");
  if (typeof sendEnvelopes !== "function") throw new Error("drainOnce requires a sendEnvelopes function");

  const state = reset ? FRESH_DRAIN_STATE() : loadDrainState(statePath);
  const sessionizer = new MessageSessionizer({
    ownerLabel,
    groupingTimezone,
    active: state.sessionizer,
  });

  const counts = {
    pages: 0,
    rows_seen: 0,
    rows_pushed: 0,
    rows_skipped: { media_only: 0, no_text: 0, no_identity: 0, no_timestamp: 0 },
    rows_out_of_order: 0,
    documents_sent: 0,
    sessions_open: 0,
    watermark: state.last_seq,
    drained_marked: 0,
    undrained_remaining: null,
    outbox_writable: null,
    dry_run: dryRun,
  };

  const dispatch = async (envelopes) => {
    if (!envelopes.length || dryRun) return;
    await sendEnvelopes(envelopes);
    counts.documents_sent += envelopes.length;
  };
  const persist = () => {
    if (dryRun) return;
    saveDrainState(statePath, {
      version: 1,
      last_seq: counts.watermark,
      sessionizer: sessionizer.snapshot(),
      updated_at: new Date(now()).toISOString(),
    });
  };

  if (flushOnly) {
    const envelopes = sessionizer.finish();
    await dispatch(envelopes);
    counts.sessions_open = 0;
    persist();
    return counts;
  }

  const opened = await openDb(outboxPath);
  counts.outbox_writable = opened.writable !== false;
  try {
    let remaining = maxRows;
    let newestSeenMs = -Infinity;
    for (;;) {
      const limit = Math.min(pageSize, remaining);
      if (limit <= 0) break;
      const rows = fetchOutboxSince(opened.db, counts.watermark, limit);
      if (!rows.length) break;
      counts.pages++;
      counts.rows_seen += rows.length;
      remaining -= rows.length;

      // The cursor advances by seq; the sessionizer is fed by time. Both are
      // computed from the same page, so the two never disagree about what was
      // consumed (invariant 4).
      let pageMaxSeq = counts.watermark;
      for (const raw of rows) pageMaxSeq = Math.max(pageMaxSeq, Number(raw.seq) || 0);
      const ordered = rows
        .map((raw) => ({ raw, row: rowToSessionRow(raw), at: Date.parse(String(raw.ts || "")) }))
        .sort((a, b) => (a.at - b.at) || (Number(a.raw.seq) - Number(b.raw.seq)));

      const closed = [];
      for (const entry of ordered) {
        if (Number.isFinite(entry.at)) {
          if (entry.at < newestSeenMs) counts.rows_out_of_order++;
          else newestSeenMs = entry.at;
        }
        // Classify before pushing so nothing disappears merely because push()
        // returned no closed document. A media marker is a real message that
        // deliberately produces no document; an unusable row is a defect.
        const disposition = messageRowDisposition(entry.row);
        if (disposition === "media_marker") { counts.rows_skipped.media_only++; continue; }
        if (disposition === "empty_content") { counts.rows_skipped.no_text++; continue; }
        if (disposition === "invalid_identity") { counts.rows_skipped.no_identity++; continue; }
        if (disposition === "invalid_time") { counts.rows_skipped.no_timestamp++; continue; }
        counts.rows_pushed++;
        closed.push(...sessionizer.push(entry.row));
      }

      // Documents first, then the cursor+snapshot pair atomically, then the
      // cosmetic stamp. A kill between the first two re-sends this page's
      // documents (acknowledged unchanged) instead of ever skipping rows.
      await dispatch(closed);
      counts.watermark = pageMaxSeq;
      persist();
      if (!dryRun && opened.writable !== false) {
        try {
          counts.drained_marked += markDrained(opened.db, counts.watermark, new Date(now()).toISOString());
        } catch { /* telemetry only; the cursor already advanced durably */ }
      }
      onPage({ page: counts.pages, rows: rows.length, watermark: counts.watermark });

      // A short page proves the outbox is caught up; a full page means known
      // backlog, so continue immediately rather than sleeping on it.
      if (rows.length < limit) break;
    }

    const stale = finishStaleSessions(sessionizer, { nowMs: now(), maxGapMs });
    await dispatch(stale);
    counts.sessions_open = sessionizer.active.size;
    persist();
    try { counts.undrained_remaining = countUndrained(opened.db); } catch { /* reporting only */ }
    return counts;
  } finally {
    opened.close();
  }
}

/* ------------------------------------------------------------ the daemon */

export class DaemonBinaryMissingError extends Error {
  constructor(message, { candidates = [] } = {}) {
    super(message);
    this.name = "DaemonBinaryMissingError";
    this.reason = "daemon_binary_missing";
    this.candidates = candidates;
  }
}

/** The default file name for a built daemon on this platform and architecture. */
export function daemonBinaryName(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return "wa-daemon-windows-amd64.exe";
  const suffix = arch === "arm64" ? "arm64" : "amd64";
  return `wa-daemon-${platform}-${suffix}`;
}

function executableAt(path, { statFile = statSync, platform = process.platform } = {}) {
  try {
    const st = statFile(path);
    if (!st.isFile()) return false;
    if (platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Find the capture daemon binary, or refuse with something a person can act on.
 *
 * How the binary reaches a client machine is an open product question — the Go
 * package's own evidence recommends a checksummed release download over
 * bundling forty megabytes into a public npm package, and neither is built.
 * Until it is decided, the path is supplied explicitly and this function is
 * honest about that rather than pretending a distribution channel exists.
 */
export function resolveDaemonBinary({
  explicit = null,
  env = process.env,
  manifest = null,
  platform = process.platform,
  arch = process.arch,
  installRoot = INSTALLER_ROOT,
  statFile = statSync,
} = {}) {
  const named = daemonBinaryName(platform, arch);
  const candidates = [
    explicit && String(explicit) !== "true" ? { source: "--daemon", path: resolve(String(explicit)) } : null,
    env?.BRAIN_WHATSAPP_DAEMON ? { source: "BRAIN_WHATSAPP_DAEMON", path: resolve(String(env.BRAIN_WHATSAPP_DAEMON)) } : null,
    manifest?.operations?.whatsapp_daemon_path
      ? { source: "operations.whatsapp_daemon_path", path: resolve(String(manifest.operations.whatsapp_daemon_path)) }
      : null,
    { source: "a local build", path: join(installRoot, "daemons", "whatsapp", "dist", named) },
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (executableAt(candidate.path, { statFile, platform })) {
      return { path: candidate.path, source: candidate.source, candidates };
    }
  }
  throw new DaemonBinaryMissingError(
    "the WhatsApp capture daemon binary was not found, so nothing was paired or installed.\n" +
      daemonBinaryRemediationSteps(candidates, { platform, arch }).map((line) => `      ${line}`).join("\n"),
    { candidates }
  );
}

export function daemonBinaryRemediationSteps(candidates = [], { platform = process.platform, arch = process.arch } = {}) {
  return [
    "Looked in these places, in order, and found no executable file:",
    ...candidates.map((c) => `  ${c.path}   (${c.source})`),
    "",
    "Build it once from this same checkout (Go 1.22+, no C toolchain needed):",
    "  cd daemons/whatsapp && ./build.sh",
    `That writes daemons/whatsapp/dist/${daemonBinaryName(platform, arch)}, which is the last`,
    "path above, so a build alone is enough.",
    "",
    "Or point at a binary you already have:",
    "  brain connect whatsapp <manifest> --daemon /path/to/wa-daemon",
    "There is no download-on-connect yet. How a signed binary reaches a client",
    "machine is an open decision, and this command will not invent one quietly.",
  ];
}

/* ------------------------------------------------------------------ pairing */

export class PairingError extends Error {
  constructor(reason, message, { detail = [] } = {}) {
    super(message);
    this.name = "PairingError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** The daemon's log lines this wizard reads. Sourced from daemons/whatsapp/main.go. */
const PAIRED_LINE = /paired with /;
const CONNECTED_LINE = /connected as /;
const LOGGED_OUT_LINE = /logged out by the phone/;
const HISTORY_CHUNK_LINE = /history chunk .*inserted=(\d+)/;

/**
 * Run the daemon in the foreground until it is paired and its link-time
 * history has stopped arriving, then stop it so the supervised copy can take
 * over the single-writer session store.
 *
 * The QR is not re-rendered here. The daemon already draws it to stdout, which
 * is inherited straight from this terminal, so what the owner scans is the
 * daemon's own output with no re-encoding in between. Only stderr (Go's `log`
 * destination) is piped, because that is where the state lines live.
 *
 * Waiting for history to settle is the point of the foreground run. WhatsApp
 * pushes the link-time backfill once, immediately after pairing; a wizard that
 * exits on "paired with" would throw most of it away with no way to ask again
 * short of pairing a second time.
 */
export async function pairDaemon({
  binaryPath,
  dataDir,
  env = process.env,
  spawn,
  pairTimeoutMs = 180_000,
  historyQuietMs = 45_000,
  historyMaxMs = 10 * 60_000,
  stopSignal = "SIGTERM",
  onLine = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!binaryPath) throw new Error("pairDaemon requires a binaryPath");
  if (!dataDir) throw new Error("pairDaemon requires a dataDir");
  const spawnChild = spawn || (await import("node:child_process")).spawn;

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = spawnChild(binaryPath, [], {
    cwd: dataDir,
    env: daemonEnvironment(env, dataDir),
    // stdout inherited: the QR must reach the terminal unbuffered and
    // unmodified. stderr piped: that is where the daemon states what happened.
    stdio: ["ignore", "inherit", "pipe"],
  });

  const observed = { paired: false, connected: false, loggedOut: false, historyChunks: 0, historyInserted: 0 };
  const tail = [];

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let pairTimer = null;
    let quietTimer = null;
    let hardTimer = null;
    const clearAll = () => {
      for (const timer of [pairTimer, quietTimer, hardTimer]) if (timer) clearTimer(timer);
      pairTimer = quietTimer = hardTimer = null;
    };
    const stopChild = () => { try { child.kill(stopSignal); } catch { /* already gone */ } };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearAll();
      stopChild();
      resolvePromise(value);
    };
    const failWith = (error) => {
      if (settled) return;
      settled = true;
      clearAll();
      stopChild();
      rejectPromise(error);
    };

    const armQuiet = () => {
      if (quietTimer) clearTimer(quietTimer);
      quietTimer = setTimer(() => {
        finish({ ...observed, reason: "history_quiet" });
      }, historyQuietMs);
    };

    pairTimer = setTimer(() => {
      failWith(new PairingError(
        "pair_timeout",
        "the QR code was never scanned, so nothing was paired and nothing was installed.\n" +
          "      On the phone: WhatsApp, then Settings, then Linked Devices, then Link a Device,\n" +
          "      then scan the code this command prints. Re-run the same command to try again.",
        { detail: tail.slice(-10) }
      ));
    }, pairTimeoutMs);

    const onPaired = (alreadyPaired) => {
      if (pairTimer) { clearTimer(pairTimer); pairTimer = null; }
      observed.paired = true;
      observed.alreadyPaired = alreadyPaired;
      hardTimer = setTimer(() => finish({ ...observed, reason: "history_cap" }), historyMaxMs);
      armQuiet();
    };

    let buffer = "";
    child.stderr?.setEncoding?.("utf-8");
    child.stderr?.on?.("data", (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        tail.push(line);
        if (tail.length > 200) tail.shift();
        onLine(line);
        if (LOGGED_OUT_LINE.test(line)) {
          observed.loggedOut = true;
          failWith(new PairingError(
            "logged_out",
            "WhatsApp ended this linked-device session during pairing. Nothing was installed.\n" +
              "      Unlink any stale entry under Linked Devices on the phone, then try again.",
            { detail: tail.slice(-10) }
          ));
          return;
        }
        const chunkMatch = line.match(HISTORY_CHUNK_LINE);
        if (chunkMatch) {
          observed.historyChunks++;
          observed.historyInserted += Number(chunkMatch[1]) || 0;
          if (observed.paired) armQuiet();
          continue;
        }
        if (!observed.paired && PAIRED_LINE.test(line)) { onPaired(false); continue; }
        if (!observed.paired && CONNECTED_LINE.test(line)) {
          // A silent reconnect: the session store already holds a device
          // identity, so this run is a re-verify rather than a first pairing.
          observed.connected = true;
          onPaired(true);
        }
      }
    });

    child.on?.("error", (error) => {
      failWith(new PairingError(
        "spawn_failed",
        `the capture daemon at ${binaryPath} could not be started: ${error?.message || error}`,
        { detail: tail.slice(-10) }
      ));
    });

    child.on?.("exit", (code, signal) => {
      if (settled) return;
      if (observed.paired) {
        // Paired, then the process ended before the quiet window closed. The
        // pairing itself is durable in the session store, so this is a success
        // with less history than a full settle would have collected.
        finish({ ...observed, reason: "child_exited" });
        return;
      }
      failWith(new PairingError(
        "daemon_exited",
        `the capture daemon exited before pairing completed (code ${code}, signal ${signal || "none"}).\n` +
          "      Its last lines were:\n" + tail.slice(-8).map((line) => `        ${line}`).join("\n"),
        { detail: tail.slice(-10) }
      ));
    });
  });
}

/**
 * The environment the daemon runs with, here and under supervision. It needs
 * no credential of any kind: it writes two local SQLite files and talks only to
 * WhatsApp. Anything else in the parent environment is dropped rather than
 * inherited into a long-lived background process.
 *
 * THE ALLOWLIST IS PER-PLATFORM, AND IT USED NOT TO BE. This kept only the
 * POSIX names and defaulted PATH to `/usr/bin:/bin:/usr/sbin:/sbin`. On a Mac
 * that is right and invisible; on Windows it handed the daemon an environment
 * with no SystemRoot and a PATH naming four directories that do not exist,
 * which is not a cosmetic difference — Go needs SystemRoot to load system DLLs
 * and to resolve DNS, so pairing would have failed on Windows before any
 * supervision was even in play. The Windows names below are the same allowlist
 * `operations/admin-key-file.mjs` and the DPAPI bridge already use.
 */
const POSIX_DAEMON_ENV = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG"];
const WINDOWS_DAEMON_ENV = [
  "SystemRoot", "SystemDrive", "windir", "PATH", "PATHEXT", "ComSpec",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
];

export function daemonEnvironment(environment = process.env, dataDir, platform = process.platform) {
  const clean = {};
  const windows = platform === "win32";
  for (const name of windows ? WINDOWS_DAEMON_ENV : POSIX_DAEMON_ENV) {
    if (environment?.[name] !== undefined) clean[name] = environment[name];
  }
  if (windows) {
    // Windows environment lookups are case-insensitive but a spawned child gets
    // exactly the keys handed to it, so accept the casings Windows itself uses.
    if (!clean.SystemRoot) {
      const root = environment?.SYSTEMROOT || environment?.WINDIR || environment?.windir;
      if (root) clean.SystemRoot = root;
    }
    if (!clean.PATH && environment?.Path) clean.PATH = environment.Path;
  } else if (!clean.PATH) {
    clean.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  }
  clean.WA_DATA_DIR = dataDir;
  return clean;
}
