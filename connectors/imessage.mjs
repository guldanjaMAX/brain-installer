/**
 * iMessage capture core — read the Mac's Messages database incrementally and
 * turn new rows into the same bounded conversation sessions every other chat
 * platform produces.
 *
 * WHERE THIS RUNS, AND WHERE IT CANNOT. Apple exposes message history to a
 * local process through ~/Library/Messages/chat.db, which exists on macOS and
 * nowhere else. Everything here is Mac-only by consequence, not by choice.
 * SMS conversations arrive in the same database when the owner's iPhone has
 * Text Message Forwarding on; they are tagged platform "sms" so they stay
 * distinguishable from real iMessage traffic.
 *
 * THE THREE INVARIANTS THIS FILE EXISTS TO KEEP TRUE
 *
 * 1. IDEMPOTENT ON MESSAGE GUID. chat.db's ROWID is only a local scan cursor;
 *    the message GUID is the durable identity, and it flows into the session
 *    document as part of its source_id (a session is keyed by its first
 *    message's GUID). Re-reading rows that were already sent produces
 *    byte-identical documents that the worker acknowledges as "unchanged".
 *    Re-running is therefore always safe, which is what makes every crash
 *    window below survivable.
 *
 * 2. THE WATERMARK ONLY ADVANCES PAST DURABLE WORK. The state file carries
 *    BOTH the highest ROWID processed AND the sessionizer's open-session
 *    snapshot, written atomically together (tmp + rename, owner-only), and
 *    only after the page's closed documents were acknowledged by the brain.
 *    A kill at any point resumes by replaying at most one page into the
 *    previous snapshot, producing the same sessions again — not a split
 *    conversation, not a gap.
 *
 * 3. ACCESS FAILURES ARE NAMED, NOT GUESSED AT. macOS TCC denies chat.db
 *    reads with EPERM unless Full Disk Access was granted to the exact
 *    binary; that case is reported as full_disk_access_denied with the real
 *    remediation, distinctly from "Messages has never been used here"
 *    (ENOENT) and from a locked or malformed database. The reference
 *    implementation logged all three as the same generic exception forever;
 *    this file's probe is the fix.
 */

import {
  closeSync,
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MESSAGE_SESSION_DEFAULTS,
  MessageSessionizer,
  sessionEnvelope,
} from "../ingest/message-session.mjs";

/** One incremental page. Matches the reference implementation's scan unit. */
export const IMESSAGE_PAGE_SIZE = 5000;

/** Mac absolute time epoch (2001-01-01T00:00:00Z) as a Unix timestamp. */
const MAC_EPOCH_UNIX_SECONDS = 978_307_200;

export function defaultChatDbPath(home = homedir()) {
  return join(home, "Library", "Messages", "chat.db");
}

/**
 * iMessage stores timestamps as time since 2001-01-01 UTC — seconds in old
 * databases, nanoseconds in current ones. Values above ~1e12 can only be
 * nanoseconds (1e12 seconds is the year 33,658), so the magnitude decides.
 */
export function macAbsoluteToIso(value) {
  if (value === null || value === undefined || value === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const seconds = n > 1_000_000_000_000 ? n / 1e9 : n;
  const date = new Date((MAC_EPOCH_UNIX_SECONDS + seconds) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * iMessage vs SMS is decided by the conversation partner's handle.service,
 * case-insensitively — not by any per-message column. "iMessage" means
 * iMessage; anything else ("SMS", null, or an unknown value) is SMS carried
 * in by Text Message Forwarding. Applied to outbound rows too, because the
 * joined handle is still the conversation partner's.
 */
export function platformOf(service) {
  return String(service || "").toLowerCase() === "imessage" ? "imessage" : "sms";
}

/**
 * Extract the text of a message whose `text` column is empty because the body
 * was serialized into the attributedBody typedstream BLOB (iOS 16+ / current
 * macOS). After the NSString (or NSMutableString) class marker and a '+'
 * (0x2b) byte comes a length-prefixed UTF-8 run: one plain length byte for
 * short strings, or a marker byte selecting a little-endian length field —
 * 0x81 (2 bytes), 0x82 (4 bytes), 0x83 (6 bytes).
 *
 * The naive printable-scan heuristic this replaces silently dropped every
 * long and emoji message (0/3000 decoded, verified against this parser's
 * 3000/3000 in the reference stack, June 2026). The bail-out below refuses a
 * decode that is more than ten percent replacement characters rather than
 * storing garbage as someone's words.
 */
export function parseAttributedBody(blob) {
  if (!blob || !blob.length) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  let i = buf.indexOf("NSString");
  let markerLength = "NSString".length;
  if (i < 0) {
    i = buf.indexOf("NSMutableString");
    markerLength = "NSMutableString".length;
    if (i < 0) return null;
  }
  const afterMarker = buf.subarray(i + markerLength);
  const plus = afterMarker.indexOf(0x2b);
  if (plus < 0) return null;
  const s = afterMarker.subarray(plus + 1);
  if (!s.length) return null;

  let length = s[0];
  let start = 1;
  if (length === 0x81) {
    if (s.length < 3) return null;
    length = s.readUInt16LE(1);
    start = 3;
  } else if (length === 0x82) {
    if (s.length < 5) return null;
    length = s.readUInt32LE(1);
    start = 5;
  } else if (length === 0x83) {
    if (s.length < 7) return null;
    length = s.readUIntLE(1, 6);
    start = 7;
  }

  const text = s.subarray(start, start + length).toString("utf-8").trim();
  if (!text) return null;
  let bad = 0;
  for (const ch of text) {
    if (ch === "�" || ch.codePointAt(0) < 0x09) bad++;
  }
  if (bad > Math.max(2, text.length * 0.1)) return null;
  return text;
}

/** Every access failure this connector can name. */
export const CHAT_DB_ACCESS_REASONS = Object.freeze([
  "full_disk_access_denied",
  "chat_db_missing",
  "chat_db_unreadable",
]);

export class ChatDbAccessError extends Error {
  constructor(reason, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ChatDbAccessError";
    this.reason = reason;
  }
}

/**
 * The exact walkthrough for a Full Disk Access denial, built around the ONE
 * binary a Node LaunchAgent chain needs (the reference stack needed three,
 * because a shell wrapper and a package launcher each sat in the spawn chain;
 * this connector invokes node directly, so only node itself is TCC-tracked).
 */
export function fdaRemediationSteps(execPath = process.execPath) {
  return [
    "macOS Full Disk Access has not been granted to this Node binary, so the",
    "Messages database cannot be read. To grant it (about 90 seconds):",
    "  1. Open System Settings, then Privacy & Security, then Full Disk Access",
    "  2. Click +, press Cmd+Shift+. to show hidden files, and add exactly:",
    `       ${execPath}`,
    "  3. Make sure its toggle is ON, then re-run this same command to verify.",
    "A grant given to Terminal does not carry over: macOS tracks each binary in",
    "a launchd chain independently. If this Node binary is version-managed (nvm,",
    "asdf), the grant must be repeated after switching Node versions, because",
    "the path above changes.",
  ];
}

/**
 * Attempt a real read of chat.db and name what happened. This is the honest
 * verification `brain connect imessage` runs, and the reason an FDA denial
 * never masquerades as a missing file or a corrupt database.
 */
export function probeChatDb(path, { open = openSync, close = closeSync } = {}) {
  let fd;
  try {
    fd = open(path, fsConstants.O_RDONLY);
    return { ok: true, path };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        reason: "chat_db_missing",
        path,
        message:
          `no Messages database exists at ${path}. Messages.app has never been ` +
          "signed in for this macOS user (or a non-standard --chat-db path was given).",
      };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return {
        ok: false,
        reason: "full_disk_access_denied",
        path,
        message: `macOS refused to open ${path} (${error.code}). ` +
          "This is the Full Disk Access gate, not a missing file.",
      };
    }
    return {
      ok: false,
      reason: "chat_db_unreadable",
      path,
      message: `the Messages database at ${path} could not be opened: ${error?.message || error}`,
    };
  } finally {
    if (fd !== undefined) close(fd);
  }
}

async function sqliteDatabaseSync() {
  // node:sqlite ships with Node 22+, which package.json already requires.
  // Imported lazily so merely loading this module never prints the
  // experimental-feature warning for commands that do not touch chat.db.
  const { DatabaseSync } = await import("node:sqlite");
  return DatabaseSync;
}

/**
 * Open chat.db read-only, falling back to a private snapshot copy when the
 * live database refuses a read-only open (macOS sometimes does while
 * Messages holds it). The fallback classifies its OWN copy errors: the copy
 * reads the same TCC-protected path, so a denied grant surfaces as the same
 * named full_disk_access_denied there, never as an anonymous copy failure.
 * The reference implementation copied into a world-readable /tmp path and
 * left the copy behind; this one uses an owner-only directory and removes it
 * on close().
 */
export async function openChatDbReadOnly(path, {
  DatabaseSync = null,
  snapshotParent = tmpdir(),
} = {}) {
  const probe = probeChatDb(path);
  if (!probe.ok) throw new ChatDbAccessError(probe.reason, probe.message);
  const Database = DatabaseSync || (await sqliteDatabaseSync());

  const openAt = (dbPath) => {
    const db = new Database(dbPath, { readOnly: true });
    db.prepare("SELECT count(*) AS n FROM message").get();
    return db;
  };

  try {
    const db = openAt(path);
    return { db, snapshotDir: null, close: () => db.close() };
  } catch (liveOpenError) {
    let snapshotDir;
    try {
      snapshotDir = mkdtempSync(join(snapshotParent, "brain-imessage-snap-"));
      chmodSync(snapshotDir, 0o700);
      const snap = join(snapshotDir, "chat.db");
      copyFileSync(path, snap);
      chmodSync(snap, 0o600);
      for (const ext of ["-wal", "-shm"]) {
        const side = `${path}${ext}`;
        if (existsSync(side)) {
          copyFileSync(side, `${snap}${ext}`);
          chmodSync(`${snap}${ext}`, 0o600);
        }
      }
      const db = openAt(snap);
      return {
        db,
        snapshotDir,
        close: () => {
          try { db.close(); } finally { rmSync(snapshotDir, { recursive: true, force: true }); }
        },
      };
    } catch (copyError) {
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
      if (copyError?.code === "EPERM" || copyError?.code === "EACCES") {
        throw new ChatDbAccessError(
          "full_disk_access_denied",
          `macOS refused to read ${path} while snapshotting it (${copyError.code}). ` +
            "This is the Full Disk Access gate, not a missing file.",
          { cause: copyError }
        );
      }
      throw new ChatDbAccessError(
        "chat_db_unreadable",
        `the Messages database could not be opened directly (${String(liveOpenError?.message || liveOpenError)}) ` +
          `and its snapshot copy also failed (${String(copyError?.message || copyError)})`,
        { cause: copyError }
      );
    }
  }
}

/**
 * One incremental page, strictly after the watermark, in ROWID order. ROWID
 * is monotically assigned by SQLite, so "everything after the last one seen"
 * is a complete resume with no clock involved.
 */
export function fetchMessagesSince(db, sinceRowid, limit = IMESSAGE_PAGE_SIZE) {
  return db.prepare(
    `SELECT
       m.ROWID          AS rowid,
       m.guid           AS guid,
       m.text           AS text,
       m.attributedBody AS attributed_body,
       -- Cast, deliberately: current chat.db stores nanosecond INTEGERs near
       -- 8e17, past JavaScript's safe-integer range. As a REAL the value
       -- round-trips as a double whose worst-case error (~128ns) is six
       -- orders of magnitude below the millisecond precision kept anyway.
       CAST(m.date AS REAL) AS date_raw,
       m.is_from_me     AS is_from_me,
       h.id             AS handle_identifier,
       h.service        AS handle_service,
       c.guid           AS chat_guid,
       c.display_name   AS chat_display_name,
       (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS chat_n_handles
     FROM message m
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
     LEFT JOIN chat c ON c.ROWID = cmj.chat_id
     WHERE m.ROWID > ?
     ORDER BY m.ROWID ASC
     LIMIT ?`
  ).all(sinceRowid, limit);
}

/** Map one chat.db row to the shape MessageSessionizer.push() consumes. */
export function rowToSessionRow(row) {
  const text = row.text && String(row.text).trim() ? String(row.text) : null;
  const body = text || parseAttributedBody(row.attributed_body) || "";
  return {
    id: String(row.guid || ""),
    ts: macAbsoluteToIso(row.date_raw),
    body,
    platform: platformOf(row.handle_service),
    thread_id: String(row.chat_guid || "unknown"),
    thread_title: String(row.chat_display_name || ""),
    direction: row.is_from_me ? "out" : "in",
    // No contact-name resolution exists in this connector. Inbound speakers
    // appear as their raw handle (a phone number or an email address); the
    // source matrix says so plainly rather than this file pretending.
    sender_name: row.is_from_me ? "" : String(row.handle_identifier || ""),
  };
}

const FRESH_CAPTURE_STATE = () => ({ version: 1, last_rowid: 0, sessionizer: [] });

export function loadCaptureState(path) {
  if (!existsSync(path)) return FRESH_CAPTURE_STATE();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && parsed.version === 1 && Number.isSafeInteger(parsed.last_rowid) &&
        parsed.last_rowid >= 0 && Array.isArray(parsed.sessionizer)) {
      return parsed;
    }
  } catch { /* fall through */ }
  // A corrupt state file must not abort capture. Restarting from ROWID zero
  // costs one long re-scan of already-sent rows (all acknowledged unchanged);
  // refusing to run costs every message from now on.
  return FRESH_CAPTURE_STATE();
}

export function saveCaptureState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  // The snapshot carries message text from open conversations, so the file is
  // owner-only, and it is replaced atomically so a kill mid-write can never
  // leave half-written JSON that silently restarts capture from zero.
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

/**
 * Close sessions that can no longer grow. push()'s own eviction only fires
 * when a NEW row arrives, so the last conversation before a quiet spell would
 * stay open — and therefore unsearchable — forever in a tick-based capture.
 * Any future row for these threads would arrive more than maxGapMs after
 * last_ts and would evict them anyway, so closing them now produces exactly
 * the documents the sessionizer would eventually have produced.
 */
export function finishStaleSessions(sessionizer, {
  nowMs = Date.now(),
  maxGapMs = MESSAGE_SESSION_DEFAULTS.maxGapMs,
} = {}) {
  const out = [];
  for (const [key, session] of sessionizer.active) {
    const last = Date.parse(session.last_ts);
    if (Number.isFinite(last) && nowMs - last > maxGapMs) {
      const envelope = sessionEnvelope(session);
      if (envelope) out.push(envelope);
      sessionizer.active.delete(key);
    }
  }
  return out;
}

/**
 * One complete capture pass: read every page strictly after the watermark,
 * sessionize, send closed documents, persist. Returns honest counts so an
 * initial history load can report what it actually did.
 *
 * Unlike the reference daemon, a full page triggers an IMMEDIATE next read
 * rather than a sleep — a first historical load proceeds at disk speed, and
 * only a short or empty page means "caught up".
 */
export async function captureOnce({
  chatDbPath = defaultChatDbPath(),
  statePath,
  sendEnvelopes,
  ownerLabel = "Owner",
  groupingTimezone = "UTC",
  pageSize = IMESSAGE_PAGE_SIZE,
  maxRows = Infinity,
  maxGapMs = MESSAGE_SESSION_DEFAULTS.maxGapMs,
  now = () => Date.now(),
  openDb = openChatDbReadOnly,
  flushOnly = false,
  dryRun = false,
  reset = false,
  onPage = () => {},
} = {}) {
  if (!statePath) throw new Error("captureOnce requires a statePath");
  if (typeof sendEnvelopes !== "function") throw new Error("captureOnce requires a sendEnvelopes function");

  const state = reset ? FRESH_CAPTURE_STATE() : loadCaptureState(statePath);
  const sessionizer = new MessageSessionizer({
    ownerLabel,
    groupingTimezone,
    active: state.sessionizer,
  });

  const counts = {
    pages: 0,
    rows_seen: 0,
    rows_pushed: 0,
    rows_skipped: { no_guid: 0, no_timestamp: 0, no_text: 0 },
    documents_sent: 0,
    documents_would_send: 0,
    sessions_open: 0,
    watermark: state.last_rowid,
    dry_run: dryRun,
  };

  const dispatch = async (envelopes) => {
    if (!envelopes.length) return;
    if (dryRun) {
      counts.documents_would_send += envelopes.length;
      return;
    }
    await sendEnvelopes(envelopes);
    counts.documents_sent += envelopes.length;
  };
  const persist = () => {
    if (dryRun) return;
    saveCaptureState(statePath, {
      version: 1,
      last_rowid: counts.watermark,
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

  const opened = await openDb(chatDbPath);
  try {
    let remaining = maxRows;
    for (;;) {
      const limit = Math.min(pageSize, remaining);
      if (limit <= 0) break;
      const rows = fetchMessagesSince(opened.db, counts.watermark, limit);
      if (!rows.length) break;
      counts.pages++;
      counts.rows_seen += rows.length;
      remaining -= rows.length;

      const closed = [];
      let pageMaxRowid = counts.watermark;
      for (const raw of rows) {
        pageMaxRowid = Math.max(pageMaxRowid, Number(raw.rowid) || 0);
        const row = rowToSessionRow(raw);
        if (!row.id) { counts.rows_skipped.no_guid++; continue; }
        if (!row.ts) { counts.rows_skipped.no_timestamp++; continue; }
        if (!row.body) {
          // Tapbacks, attachment-only rows and undecodable bodies land here.
          // They are counted, not silently dropped, so "why is this thread
          // thinner than my phone shows" has an answer.
          counts.rows_skipped.no_text++;
          continue;
        }
        counts.rows_pushed++;
        closed.push(...sessionizer.push(row));
      }

      // Documents first, then the watermark+snapshot pair, atomically. A kill
      // between the two re-sends this page's documents (acknowledged
      // unchanged) instead of ever skipping rows.
      await dispatch(closed);
      counts.watermark = pageMaxRowid;
      persist();
      onPage({ page: counts.pages, rows: rows.length, watermark: counts.watermark });

      // A short page proves the scan is caught up; a full page means known
      // backlog, so continue immediately rather than sleeping on it.
      if (rows.length < limit) break;
    }

    const stale = finishStaleSessions(sessionizer, { nowMs: now(), maxGapMs });
    await dispatch(stale);
    counts.sessions_open = sessionizer.active.size;
    persist();
    return counts;
  } finally {
    opened.close();
  }
}
