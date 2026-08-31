// test/iphone-backup.test.mjs
//
// WP-09, the one-time iPhone backup history loader, proven against a
// SYNTHETIC backup built right here: a real Manifest.db (SQLite) whose Files
// table maps HomeDomain/Library/SMS/sms.db to a content-hashed fileID, real
// Info/Manifest/Status property lists in both binary and XML form, and a real
// iOS Messages database with the schema subset the connector's one query
// touches. Invented personas only (Priya Nair, Sam Osei, Morgan Diaz, +1555…
// numbers, example.test addresses), consistent with test/fixtures/whatsapp/.
// No real message data appears anywhere in this file, and nothing here reads
// the machine's real backup folder.
//
// The two claims this file exists to prove:
//
//   1. The loader finds sms.db by ASKING Manifest.db, not by computing the
//      conventional SHA-1 of "HomeDomain-Library/SMS/sms.db". The fixture
//      deliberately stores it under a fileID that is NOT that hash, so an
//      implementation that guessed would fail here and only here.
//   2. A conversation loaded from a backup produces the SAME documents the
//      live Mac connector produces from the same rows — asserted by deep
//      equality against connectors/imessage.mjs driven directly, not by
//      eyeballing that the two look similar.
//
// What this file cannot prove, and evidence/WP-09.md says so rather than
// implying otherwise: a genuine Apple-written backup (every fixture here is
// written by this test), a genuinely encrypted backup (the encrypted cases
// are Apple's own IsEncrypted flag and a non-SQLite Manifest.db, which is
// what encryption looks like from outside), and a real Windows filesystem
// (the Windows path conventions are asserted through node:path's own win32
// composition, on whatever host runs the suite).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, win32 as pathWin32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  BACKUP_REFUSAL_REASONS,
  IphoneBackupError,
  SMS_DB_DOMAIN,
  SMS_DB_RELATIVE_PATH,
  assertSmsSchema,
  defaultBackupRoots,
  encryptedBackupRemediation,
  findBackupFile,
  inspectBackup,
  listBackups,
  loadBackupHistory,
  locateSmsDatabase,
  looksLikeBackupDirectory,
  openBackupSmsDb,
  parsePlist,
  resolveBackupDirectory,
  storedFilePath,
} from "../connectors/iphone-backup.mjs";
import { fetchMessagesSince, rowToSessionRow } from "../connectors/imessage.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";
import { cmdIngestIphoneBackup } from "../brain.mjs";
import { forget } from "../worker/src/lib/store-d1.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 300)));
  if (!condition) fail++;
};

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-iphone-backup-")));
const REPO = fileURLToPath(new URL("..", import.meta.url));

/* ==================================================================== */
/* Fixture builders                                                      */
/* ==================================================================== */

/** Apple absolute time, nanoseconds since 2001-01-01T00:00:00Z. */
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
const macNs = (iso) => (Date.parse(iso) - MAC_EPOCH_MS) * 1e6;
const macSeconds = (iso) => (Date.parse(iso) - MAC_EPOCH_MS) / 1000;

/**
 * A typedstream-shaped attributedBody blob, the same construction
 * test/imessage-capture.test.mjs uses, so the two suites agree on what the
 * bytes look like.
 */
function typedstreamBlob(text) {
  const payload = Buffer.from(text, "utf-8");
  let lengthField;
  if (payload.length < 0x81) {
    lengthField = Buffer.from([payload.length]);
  } else {
    lengthField = Buffer.alloc(3);
    lengthField[0] = 0x81;
    lengthField.writeUInt16LE(payload.length, 1);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from("streamtyped", "ascii"),
    Buffer.from("NSString", "ascii"),
    Buffer.from([0x01, 0x84, 0x84]),
    Buffer.from([0x2b]),
    lengthField,
    payload,
    Buffer.from([0x86, 0x84]),
  ]);
}

/**
 * A minimal binary property list writer for a FLAT dictionary — enough to
 * hand the connector the shape Apple actually writes (modern backups write
 * bplist00, not XML), including the extended length marker that keys longer
 * than fourteen characters and dictionaries with fifteen or more entries
 * both require.
 */
function binaryPlist(dict) {
  const objects = [];
  const sized = (typeNibble, count, body) => {
    if (count < 15) return Buffer.concat([Buffer.from([(typeNibble << 4) | count]), body]);
    return Buffer.concat([
      Buffer.from([(typeNibble << 4) | 0x0f, 0x10, count]), // 0x10 = one-byte int
      body,
    ]);
  };
  const push = (buf) => { objects.push(buf); return objects.length - 1; };

  const entries = Object.entries(dict);
  const dictIndex = push(Buffer.alloc(0)); // placeholder, rewritten below
  const keyRefs = entries.map(([k]) => push(sized(0x5, k.length, Buffer.from(k, "latin1"))));
  const valueRefs = entries.map(([, v]) => {
    if (v === true) return push(Buffer.from([0x09]));
    if (v === false) return push(Buffer.from([0x08]));
    if (v instanceof Date) {
      const body = Buffer.alloc(9);
      body[0] = 0x33;
      body.writeDoubleBE((v.getTime() - MAC_EPOCH_MS) / 1000, 1);
      return push(body);
    }
    if (typeof v === "number") return push(Buffer.from([0x10, v]));
    const s = String(v);
    return push(sized(0x5, s.length, Buffer.from(s, "latin1")));
  });

  const refSize = 1; // fixtures stay well under 256 objects
  objects[dictIndex] = sized(
    0xd, entries.length,
    Buffer.from([...keyRefs, ...valueRefs]),
  );

  const header = Buffer.from("bplist00", "ascii");
  const offsets = [];
  let cursor = header.length;
  for (const object of objects) { offsets.push(cursor); cursor += object.length; }
  const offsetTableOffset = cursor;
  const offsetSize = 4;
  const offsetTable = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((offset, i) => offsetTable.writeUInt32BE(offset, i * offsetSize));

  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(dictIndex), 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
  return Buffer.concat([header, ...objects, offsetTable, trailer]);
}

function xmlPlist(dict) {
  const body = Object.entries(dict).map(([k, v]) => {
    if (v === true || v === false) return `  <key>${k}</key>\n  <${v}/>`;
    if (v instanceof Date) return `  <key>${k}</key>\n  <date>${v.toISOString()}</date>`;
    return `  <key>${k}</key>\n  <string>${v}</string>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

/** The iOS Messages database schema subset the shared query reads. */
const SMS_SCHEMA = `
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT, attributedBody BLOB,
    date INTEGER, is_from_me INTEGER, handle_id INTEGER
  );
`;

/**
 * The conversations every extraction assertion below runs against. Two
 * threads, one iMessage and one SMS; an attributedBody-only message with no
 * `text` column at all; an outbound message; a tapback-shaped row with
 * neither text nor body; and one legacy seconds-epoch timestamp.
 */
function seedMessages(db) {
  db.exec(`
    INSERT INTO handle (ROWID, id, country, service) VALUES
      (1, '+15550142', 'us', 'iMessage'),
      (2, '+15550188', 'us', 'SMS');
    INSERT INTO chat (ROWID, guid, display_name, style) VALUES
      (1, 'iMessage;-;+15550142', NULL, 45),
      (2, 'SMS;-;+15550188', NULL, 45);
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1,1),(2,2);
  `);
  const rows = [
    { guid: "BK-A1", text: "Are we still on for the Northwind kickoff Tuesday?", ts: "2026-03-02T17:00:00Z", chat: 1, handle: 1 },
    { guid: "BK-A2", text: "Yes, 2pm. I will bring the updated numbers.", ts: "2026-03-02T17:03:00Z", chat: 1, handle: 1, fromMe: 1 },
    // Text lives only in the typedstream blob, which is how current iOS
    // writes most message bodies.
    { guid: "BK-A3", blob: typedstreamBlob("Perfect. Priya is joining from the depot 🚚"), ts: "2026-03-02T17:09:00Z", chat: 1, handle: 1 },
    // A tapback: no text, no body. Counted as skipped, never a document.
    { guid: "BK-A4", ts: "2026-03-02T17:10:00Z", chat: 1, handle: 1 },
    { guid: "BK-B1", text: "Invoice 4521 cleared this morning", ts: "2026-03-02T18:00:00Z", chat: 2, handle: 2 },
    // A legacy seconds-since-2001 timestamp, which old backups still carry.
    { guid: "BK-B2", text: "Thanks, closing the file.", tsSeconds: "2026-03-02T18:04:00Z", chat: 2, handle: 2, fromMe: 1 },
  ];
  let rowid = 0;
  for (const r of rows) {
    rowid++;
    db.prepare(
      "INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?,?)"
    ).run(
      rowid, r.guid, r.text ?? null, r.blob ?? null,
      r.tsSeconds ? macSeconds(r.tsSeconds) : macNs(r.ts),
      r.fromMe ? 1 : 0, r.handle,
    );
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(r.chat, rowid);
  }
  return rowid;
}

/**
 * The conventional fileID for the Messages database: SHA-1 of
 * "domain-relativePath". The fixtures deliberately DO NOT use it, so that
 * proving the loader still finds the file proves it read the index.
 */
const CONVENTIONAL_SMS_FILE_ID =
  createHash("sha1").update(`${SMS_DB_DOMAIN}-${SMS_DB_RELATIVE_PATH}`).digest("hex");

/** A fileID that is a valid shape but is emphatically not the convention. */
const DECOY_SMS_FILE_ID = "0fedcba98765432100112233445566778899aabb";

let backupSeq = 0;
/**
 * Build one synthetic backup directory. Everything about it is a knob so the
 * refusal cases below are the same builder with one thing wrong.
 */
function makeBackup({
  name = null,
  root = sandbox,
  fileID = DECOY_SMS_FILE_ID,
  withSmsDb = true,
  storeSmsFile = true,
  flat = false,
  encryptedFlag = false,
  manifestDbBytes = null,      // when set, Manifest.db is these bytes verbatim
  legacyMbdb = false,
  noManifest = false,
  smsSchema = SMS_SCHEMA,
  seed = seedMessages,
  wal = false,
  smsFlags = 1,
  plistFormat = "binary",
  status = "finished",
  isFullBackup = true,
  extraFiles = [],
} = {}) {
  const directory = join(root, name || `00008030-${String(++backupSeq).padStart(18, "0")}`);
  mkdirSync(directory, { recursive: true });

  if (legacyMbdb) {
    writeFileSync(join(directory, "Manifest.mbdb"), Buffer.from("mbdb\x05\x00", "latin1"));
    return { directory };
  }

  // ---- the Messages database, stored under its content-hashed name -------
  let smsStoredAt = null;
  if (withSmsDb && storeSmsFile) {
    const shard = fileID.slice(0, 2);
    const dir = flat ? directory : join(directory, shard);
    mkdirSync(dir, { recursive: true });
    smsStoredAt = join(dir, fileID);
    const build = join(directory, `.build-${fileID}.db`);
    const db = new DatabaseSync(build);
    if (wal) db.exec("PRAGMA journal_mode=WAL");
    db.exec(smsSchema);
    const checkpointAt = seed(db);
    if (wal) {
      // Everything so far is checkpointed into the main file; the newest
      // messages below stay in an uncheckpointed WAL, exactly the state a
      // backup of a live phone captures.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("PRAGMA wal_autocheckpoint=0");
      let rowid = checkpointAt;
      for (const r of [
        { guid: "BK-A5", text: "One more thing, the depot gate code changed to 4417.", ts: "2026-03-02T17:40:00Z", chat: 1, handle: 1 },
        { guid: "BK-A6", text: "Noted, thank you.", ts: "2026-03-02T17:42:00Z", chat: 1, handle: 1, fromMe: 1 },
      ]) {
        rowid++;
        db.prepare(
          "INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?,?,?,?,?,?,?)"
        ).run(rowid, r.guid, r.text, null, macNs(r.ts), r.fromMe ? 1 : 0, r.handle);
        db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?,?)").run(r.chat, rowid);
      }
      // Copy while the handle is still open, so the WAL is not checkpointed
      // away by close(). The sidecar becomes its own indexed backup file.
      copyFileSync(build, smsStoredAt);
      const walShard = flat ? directory : join(directory, "aa");
      mkdirSync(walShard, { recursive: true });
      const walFileID = "aa11223344556677889900aabbccddeeff001122";
      copyFileSync(`${build}-wal`, join(walShard, walFileID));
      extraFiles = [...extraFiles, {
        fileID: walFileID, domain: SMS_DB_DOMAIN, relativePath: `${SMS_DB_RELATIVE_PATH}-wal`, flags: 1,
      }];
      db.close();
    } else {
      db.close();
      copyFileSync(build, smsStoredAt);
    }
    rmSync(build, { force: true });
    rmSync(`${build}-wal`, { force: true });
    rmSync(`${build}-shm`, { force: true });
  }

  // ---- Manifest.db: the index that makes the fileID discoverable ---------
  if (!noManifest) {
    const manifestPath = join(directory, "Manifest.db");
    if (manifestDbBytes) {
      writeFileSync(manifestPath, manifestDbBytes);
    } else {
      const manifest = new DatabaseSync(manifestPath);
      manifest.exec(
        "CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)"
      );
      const insert = manifest.prepare(
        "INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?,?,?,?,NULL)"
      );
      // Decoys first, so a loader that took the first row it saw would fail.
      insert.run("1111111111111111111111111111111111111111", "HomeDomain", "Library/SMS", 2);
      insert.run("2222222222222222222222222222222222222222", "MediaDomain", "Library/SMS/Attachments", 2);
      insert.run("3333333333333333333333333333333333333333", "HomeDomain", "Library/Preferences/com.apple.mobilephone.plist", 1);
      if (withSmsDb) insert.run(fileID, SMS_DB_DOMAIN, SMS_DB_RELATIVE_PATH, smsFlags);
      for (const extra of extraFiles) {
        insert.run(extra.fileID, extra.domain, extra.relativePath, extra.flags);
      }
      manifest.close();
    }
  }

  // ---- the property lists -----------------------------------------------
  const write = plistFormat === "xml"
    ? (p, d) => writeFileSync(p, xmlPlist(d))
    : (p, d) => writeFileSync(p, binaryPlist(d));
  write(join(directory, "Manifest.plist"), {
    IsEncrypted: encryptedFlag, Version: "10.0", Date: new Date("2026-03-03T04:15:00Z"),
  });
  write(join(directory, "Info.plist"), {
    "Device Name": "Morgan's iPhone",
    "Product Name": "iPhone 15",
    "Product Version": "18.3.1",
    "Unique Identifier": "00008030000000000000000A",
    "Last Backup Date": new Date("2026-03-03T04:15:00Z"),
    // Filler so the dictionary crosses fifteen entries and exercises the
    // extended-size path plus the wanted-key filter.
    Build: "22D72", ICCID: "n/a", IMEI: "n/a", MEID: "n/a", Phone: "n/a",
    Serial: "n/a", Target: "n/a", Type: "n/a", GUID: "n/a", Padding: "n/a",
  });
  write(join(directory, "Status.plist"), {
    SnapshotState: status, IsFullBackup: isFullBackup, Date: new Date("2026-03-03T04:15:00Z"),
  });
  return { directory, smsStoredAt, fileID };
}

/** Drive loadBackupHistory and collect every envelope it emits. */
async function loadAll(directory, options = {}) {
  const located = await locateSmsDatabase(directory);
  const sent = [];
  const counts = await loadBackupHistory({
    located,
    sendEnvelopes: async (envelopes) => { sent.push(...envelopes); },
    ownerLabel: "Morgan Diaz",
    groupingTimezone: "UTC",
    ...options,
  });
  return { counts, sent, located };
}

/* ==================================================================== */

try {

/* ============================ A. property lists ====================== */
{
  const binary = binaryPlist({
    IsEncrypted: false, "Product Version": "18.3.1", "Device Name": "Morgan's iPhone",
    Date: new Date("2026-03-03T04:15:00Z"),
  });
  check("the binary plist fixture is written in Apple's bplist00 format",
    binary.subarray(0, 8).toString("latin1") === "bplist00");
  const parsed = parsePlist(binary, { keys: ["IsEncrypted", "Product Version", "Date"] });
  check("a binary plist boolean parses as a boolean",
    parsed.IsEncrypted === false, JSON.stringify(parsed));
  check("a binary plist string parses exactly",
    parsed["Product Version"] === "18.3.1", JSON.stringify(parsed));
  check("a binary plist date parses through the Apple epoch",
    parsed.Date instanceof Date && parsed.Date.toISOString() === "2026-03-03T04:15:00.000Z",
    String(parsed.Date));
  check("keys not asked for are not returned",
    !("Device Name" in parsed), JSON.stringify(Object.keys(parsed)));

  const xml = parsePlist(Buffer.from(xmlPlist({ IsEncrypted: true, Version: "9.1" })), { keys: null });
  check("an XML plist, which older iTunes wrote, parses too",
    xml.IsEncrypted === true && xml.Version === "9.1", JSON.stringify(xml));

  let threw = null;
  try { parsePlist(Buffer.from("not a plist at all, just bytes")); } catch (e) { threw = e; }
  check("bytes that are neither format are refused, not guessed at",
    /not a property list/.test(threw?.message || ""), threw?.message);
}

/* =================== B. default locations, per OS ==================== */
{
  const mac = defaultBackupRoots({ home: "/Users/owner", platform: "darwin", env: {}, readdir: () => [] });
  check("macOS looks under Library/Application Support/MobileSync/Backup",
    mac.length === 1 && mac[0] === join("/Users/owner", "Library", "Application Support", "MobileSync", "Backup"),
    JSON.stringify(mac));

  const winHome = pathWin32.join("C:\\", "Users", "owner");
  const winEnv = {
    APPDATA: pathWin32.join(winHome, "AppData", "Roaming"),
    LOCALAPPDATA: pathWin32.join(winHome, "AppData", "Local"),
  };
  const win = defaultBackupRoots({
    home: winHome, platform: "win32", env: winEnv,
    readdir: (path) => (
      // Only the Packages folder is enumerated; everything else is composed.
      path === join(winEnv.LOCALAPPDATA, "Packages")
        ? [{ name: "AppleInc.iTunes_nzyj5cx40ttqa", isDirectory: () => true },
           { name: "Microsoft.WindowsStore_8wekyb3d8bbwe", isDirectory: () => true }]
        : []
    ),
  });
  check("Windows classic iTunes: %APPDATA%\\Apple Computer\\MobileSync\\Backup is searched",
    win.includes(join(winEnv.APPDATA, "Apple Computer", "MobileSync", "Backup")), JSON.stringify(win));
  check("Windows Apple Devices app: <profile>\\Apple\\MobileSync\\Backup is searched",
    win.includes(join(winHome, "Apple", "MobileSync", "Backup")), JSON.stringify(win));
  check("Windows Microsoft Store iTunes: the per-publisher package cache is discovered, not hardcoded",
    win.includes(join(winEnv.LOCALAPPDATA, "Packages", "AppleInc.iTunes_nzyj5cx40ttqa",
      "LocalCache", "Roaming", "Apple Computer", "MobileSync", "Backup")), JSON.stringify(win));
  check("a non-Apple Store package is not mistaken for an iTunes package",
    !win.some((r) => r.includes("Microsoft.WindowsStore")), JSON.stringify(win));
  check("every Windows root is composed with node:path, so segments never carry a literal separator",
    win.every((root) => root.split(/[\\/]/).every((seg) => seg !== "")), JSON.stringify(win));

  check("Linux claims no default location rather than inventing one",
    defaultBackupRoots({ home: "/home/owner", platform: "linux", env: {}, readdir: () => [] }).length === 0);
}

/* ================= C. choosing which backup to read ================== */
{
  const roots = join(sandbox, "roots");
  mkdirSync(roots, { recursive: true });
  const only = makeBackup({ root: roots, name: "only-backup" });

  check("a directory holding Manifest.db is recognised as one backup",
    looksLikeBackupDirectory(only.directory));
  check("listBackups enumerates backups inside a root folder",
    listBackups([roots]).length === 1, JSON.stringify(listBackups([roots]).map((b) => b.name)));

  check("an explicit path straight at a backup is used as given",
    resolveBackupDirectory({ path: only.directory }).chosen === "explicit");
  const viaParent = resolveBackupDirectory({ path: roots });
  check("an explicit path at the FOLDER of backups resolves the single backup inside it",
    viaParent.chosen === "explicit_parent" && viaParent.directory === only.directory,
    JSON.stringify(viaParent));

  const discovered = resolveBackupDirectory({
    path: null, platform: "darwin", env: {},
    home: (() => {
      // A synthetic macOS home whose default backup folder is the real one above.
      const home = join(sandbox, "fake-mac-home");
      const dest = join(home, "Library", "Application Support", "MobileSync", "Backup");
      mkdirSync(dest, { recursive: true });
      const target = join(dest, "only-backup");
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(only.directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          mkdirSync(join(target, entry.name), { recursive: true });
          for (const f of readdirSync(join(only.directory, entry.name))) {
            copyFileSync(join(only.directory, entry.name, f), join(target, entry.name, f));
          }
        } else {
          copyFileSync(join(only.directory, entry.name), join(target, entry.name));
        }
      }
      return home;
    })(),
  });
  check("with no --backup given, the one backup in the macOS default location is discovered",
    discovered.chosen === "discovered" && discovered.directory.endsWith("only-backup"),
    JSON.stringify(discovered));

  makeBackup({ root: roots, name: "second-backup" });
  let ambiguous = null;
  try { resolveBackupDirectory({ path: roots }); } catch (e) { ambiguous = e; }
  check("two backups in one folder is refused as ambiguous, never a coin flip",
    ambiguous?.reason === "backup_ambiguous" && ambiguous.detail.length === 2, ambiguous?.message);
  check("the ambiguity refusal names both candidate folders so the owner can pick",
    ambiguous.detail.every((d) => ambiguous.message.includes(d)), ambiguous?.message);

  const empty = join(sandbox, "not-a-backup");
  mkdirSync(empty, { recursive: true });
  let notBackup = null;
  try { resolveBackupDirectory({ path: empty }); } catch (e) { notBackup = e; }
  check("a folder that is not a backup and holds none is refused by name",
    notBackup?.reason === "backup_not_a_backup", notBackup?.message);

  let missing = null;
  try { resolveBackupDirectory({ path: join(sandbox, "nope") }); } catch (e) { missing = e; }
  check("a path that does not exist is refused as backup_missing", missing?.reason === "backup_missing");

  let none = null;
  try {
    resolveBackupDirectory({ path: null, platform: "win32", home: join(sandbox, "barren"), env: {}, readdir: () => [] });
  } catch (e) { none = e; }
  check("no backup anywhere names the folders that were searched",
    none?.reason === "backup_none_found" && none.detail.length >= 2, none?.message);
  check("every refusal reason this loader can produce is a declared one",
    [ambiguous, notBackup, missing, none].every((e) => BACKUP_REFUSAL_REASONS.includes(e.reason)));
}

/* ========= D. the crown jewel: Manifest.db, not a guessed path ======= */
{
  const backup = makeBackup({ name: "index-proof" });
  check("the fixture deliberately stores sms.db under a NON-conventional fileID",
    backup.fileID !== CONVENTIONAL_SMS_FILE_ID && backup.fileID === DECOY_SMS_FILE_ID);
  const conventionalPath = join(backup.directory, CONVENTIONAL_SMS_FILE_ID.slice(0, 2), CONVENTIONAL_SMS_FILE_ID);
  check("the conventional SHA-1 path is genuinely absent, so guessing cannot work here",
    !existsSync(conventionalPath), conventionalPath);

  const located = await locateSmsDatabase(backup.directory);
  check("the loader still finds sms.db, which it can only have done by querying Manifest.db",
    located.path === backup.smsStoredAt, `${located.path} vs ${backup.smsStoredAt}`);
  check("the located file is the content-hashed name in its two-character shard folder",
    located.fileID === DECOY_SMS_FILE_ID &&
    located.path.endsWith(join(DECOY_SMS_FILE_ID.slice(0, 2), DECOY_SMS_FILE_ID)), located.path);

  // The index lookup itself, against a directory row that shares the prefix.
  const manifest = new DatabaseSync(join(backup.directory, "Manifest.db"), { readOnly: true });
  check("a directory row (flags 2) for a neighbouring path is not mistaken for the file",
    findBackupFile(manifest, "HomeDomain", "Library/SMS") === null);
  check("a path in another domain is not returned for HomeDomain",
    findBackupFile(manifest, "HomeDomain", "Library/SMS/Attachments") === null);
  check("the Messages database row is found by exact domain and relative path",
    findBackupFile(manifest, SMS_DB_DOMAIN, SMS_DB_RELATIVE_PATH)?.fileID === DECOY_SMS_FILE_ID);
  manifest.close();

  check("the iOS relative path is stored forward-slashed and is never re-joined with a host separator",
    SMS_DB_RELATIVE_PATH === "Library/SMS/sms.db" && SMS_DB_DOMAIN === "HomeDomain");

  // Some early iOS 10 backups wrote every file flat in the backup root.
  const flatBackup = makeBackup({ name: "flat-layout", flat: true });
  const flatLocated = await locateSmsDatabase(flatBackup.directory);
  check("a flat (unsharded) backup layout resolves too",
    flatLocated.path === join(flatBackup.directory, DECOY_SMS_FILE_ID), flatLocated.path);
  check("storedFilePath returns null when neither layout holds the file",
    storedFilePath(flatBackup.directory, "ffffffffffffffffffffffffffffffffffffffff") === null);
}

/* =================== E. an encrypted backup is refused =============== */
{
  const flagged = makeBackup({ name: "encrypted-flagged", encryptedFlag: true });
  const inspected = inspectBackup(flagged.directory);
  check("Apple's own IsEncrypted flag refuses the backup by name",
    inspected.ok === false && inspected.reason === "backup_encrypted", JSON.stringify(inspected));
  check("the refusal explains WHY it cannot proceed: the index itself is encrypted",
    /Manifest.db.*encrypted|encrypted.*index/i.test(inspected.remediation.join(" ")),
    inspected.remediation?.join(" "));
  check("the refusal gives the exact steps to make an unencrypted backup, on BOTH operating systems",
    /On a Mac:/.test(inspected.remediation.join("\n")) &&
    /On Windows:/.test(inspected.remediation.join("\n")) &&
    /Encrypt local backup/.test(inspected.remediation.join("\n")),
    inspected.remediation?.join(" | "));
  const remediationFlat = inspected.remediation.join(" ").replace(/\s+/g, " ");
  check("the refusal states the cost of turning encryption off rather than only the benefit",
    /readable by anything else running on that computer/.test(remediationFlat) &&
    /Health data and saved passwords/.test(remediationFlat),
    remediationFlat);

  let thrown = null;
  try { await locateSmsDatabase(flagged.directory); } catch (e) { thrown = e; }
  check("locating the Messages database in an encrypted backup throws IphoneBackupError, not an SQLite parse error",
    thrown instanceof IphoneBackupError && thrown.reason === "backup_encrypted" &&
    !/malformed|not a database|file is not/i.test(thrown.message), thrown?.message);
  check("the thrown refusal carries the remediation steps with it",
    Array.isArray(thrown.detail) && thrown.detail.join(" ").includes("Encrypt local backup"));

  // The independent second check: an encrypted backup's Manifest.db is not a
  // SQLite file at all, and the loader says so without claiming corruption.
  const opaque = makeBackup({
    name: "encrypted-opaque",
    manifestDbBytes: Buffer.from("f3a90c11e7d2".repeat(64), "hex"),
  });
  // Also strip the honest flag, so ONLY the byte check can catch it.
  writeFileSync(join(opaque.directory, "Manifest.plist"), binaryPlist({ IsEncrypted: false, Version: "10.0" }));
  const opaqueInspected = inspectBackup(opaque.directory);
  check("a Manifest.db that is not a SQLite file is caught even when the plist claims unencrypted",
    opaqueInspected.reason === "backup_encrypted", JSON.stringify(opaqueInspected));
  check("that second check does not overclaim: it says it cannot tell encrypted from damaged",
    /cannot tell the two apart/.test(opaqueInspected.message), opaqueInspected.message);

  check("the remediation text is available on its own for the CLI to print",
    encryptedBackupRemediation().length > 5 &&
    encryptedBackupRemediation().some((line) => line.includes("Back Up Now")));
}

/* =============== F. every other way a backup can be wrong ============ */
{
  const legacy = makeBackup({ name: "legacy-mbdb", legacyMbdb: true });
  check("a pre-iOS 10 Manifest.mbdb backup is named as the old format, not called corrupt",
    inspectBackup(legacy.directory).reason === "backup_legacy_format",
    inspectBackup(legacy.directory).message);

  const bare = join(sandbox, "bare-folder");
  mkdirSync(bare, { recursive: true });
  check("a folder with no Manifest at all is refused as not-a-backup",
    inspectBackup(bare).reason === "backup_not_a_backup");
  check("a folder that does not exist is refused as missing",
    inspectBackup(join(sandbox, "ghost")).reason === "backup_missing");

  const noSms = makeBackup({ name: "no-messages", withSmsDb: false });
  let e1 = null;
  try { await locateSmsDatabase(noSms.directory); } catch (e) { e1 = e; }
  check("a backup whose index has no Messages database says so, and says why that happens",
    e1?.reason === "sms_db_not_in_backup" && /iCloud/.test(e1.message), e1?.message);

  const dangling = makeBackup({ name: "dangling-index", storeSmsFile: false });
  let e2 = null;
  try { await locateSmsDatabase(dangling.directory); } catch (e) { e2 = e; }
  check("an index that names a file the folder does not hold reports an incomplete copy",
    e2?.reason === "sms_db_file_missing" && /incomplete/.test(e2.message), e2?.message);

  const asDirectory = makeBackup({ name: "sms-as-directory", smsFlags: 2 });
  let e3 = null;
  try { await locateSmsDatabase(asDirectory.directory); } catch (e) { e3 = e; }
  check("a Files row flagged as a directory is not accepted as the database file",
    e3?.reason === "sms_db_not_in_backup", e3?.message);

  const interrupted = makeBackup({ name: "interrupted", status: "new", isFullBackup: false });
  const warned = inspectBackup(interrupted.directory);
  check("a backup whose own status is not finished loads but warns it may hold less history",
    warned.ok === true && warned.warnings.length === 2 &&
    warned.warnings.some((w) => /interrupted/.test(w)), JSON.stringify(warned.warnings));

  // A very old Messages database with no attributedBody column would load as
  // silent empty conversations, so it is refused instead.
  const ancient = makeBackup({
    name: "ancient-schema",
    smsSchema: `
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, style INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, text TEXT,
                            date INTEGER, is_from_me INTEGER, handle_id INTEGER);
    `,
    seed: (db) => { db.exec("INSERT INTO handle (ROWID, id, service) VALUES (1, '+15550142', 'iMessage')"); return 0; },
  });
  const ancientLocated = await locateSmsDatabase(ancient.directory);
  const ancientOpen = await openBackupSmsDb(ancientLocated);
  let e4 = null;
  try { assertSmsSchema(ancientOpen.db); } catch (e) { e4 = e; }
  ancientOpen.close();
  check("a Messages database with no attributedBody column is refused rather than read as empty",
    e4?.reason === "sms_db_unreadable" && /attributedBody/.test(e4.message) &&
    /empty conversations/.test(e4.message), e4?.message);
}

/* ======= G. extraction: timestamps, iMessage vs SMS, attributedBody === */
{
  const backup = makeBackup({ name: "extraction" });
  const { counts, sent } = await loadAll(backup.directory);

  check("every message row in the backup is read",
    counts.rows_seen === 6, JSON.stringify(counts));
  check("the tapback row with neither text nor attributedBody is counted as skipped, not lost silently",
    counts.rows_pushed === 5 && counts.rows_skipped.no_text === 1 &&
    counts.rows_skipped.no_guid === 0 && counts.rows_skipped.no_timestamp === 0, JSON.stringify(counts));
  check("both conversation threads are reported",
    counts.threads === 2, JSON.stringify(counts));
  check("the date span of the load is reported from the messages themselves",
    counts.earliest === "2026-03-02T17:00:00.000Z" && counts.latest === "2026-03-02T18:04:00.000Z",
    `${counts.earliest} .. ${counts.latest}`);

  const imessage = sent.find((d) => d.source_id === "BK-A1");
  const sms = sent.find((d) => d.source_id === "BK-B1");
  check("two conversation documents are produced, keyed by each thread's first message GUID",
    sent.length === 2 && imessage && sms, JSON.stringify(sent.map((d) => d.source_id)));
  check("the iMessage thread is classified imessage, from handle.service",
    imessage.metadata.platform === "imessage", imessage.metadata.platform);
  check("the SMS thread carried in by Text Message Forwarding is classified sms",
    sms.metadata.platform === "sms", sms.metadata.platform);

  check("a message whose text lives ONLY in the attributedBody typedstream blob is decoded",
    imessage.content.includes("Perfect. Priya is joining from the depot 🚚"), imessage.content);
  check("nanosecond Apple timestamps convert to the right instant",
    imessage.occurred_at === "2026-03-02T17:00:00.000Z", imessage.occurred_at);
  check("legacy seconds-since-2001 timestamps convert to the right instant too",
    /\[2026-03-02T18:04:00.000Z\]/.test(sms.content), sms.content);
  check("the owner's own display name speaks for outbound messages",
    imessage.content.includes("Morgan Diaz: Yes, 2pm."), imessage.content);
  check("inbound messages speak as the raw handle, since no contact resolution exists here",
    imessage.content.includes("+15550142:"), imessage.content);
  check("conversations are grouped as bounded sessions, the same shape every other chat source produces",
    sent.every((d) => d.metadata.grouped_as === "bounded_conversation_session" && d.date_reliable === true));
}

/* ====== H. identity with the live Mac connector, by deep equality ===== */
{
  const backup = makeBackup({ name: "identity" });
  const { sent: fromBackup } = await loadAll(backup.directory);

  // The same rows, driven through the live connector's own code path: open
  // the database, run its query, map its rows, sessionize. If the backup
  // loader diverged by even a field, this comparison fails.
  const located = await locateSmsDatabase(backup.directory);
  const live = new DatabaseSync(located.path, { readOnly: true });
  const sessionizer = new MessageSessionizer({ ownerLabel: "Morgan Diaz", groupingTimezone: "UTC" });
  const fromLive = [];
  for (const raw of fetchMessagesSince(live, 0, 5000)) {
    const row = rowToSessionRow(raw);
    if (!row.id || !row.ts || !row.body) continue;
    fromLive.push(...sessionizer.push(row));
  }
  fromLive.push(...sessionizer.finish());
  live.close();

  const key = (d) => d.source_id;
  const sortByKey = (a) => [...a].sort((x, y) => key(x).localeCompare(key(y)));
  check("the backup load produces the SAME documents the live Mac connector produces, field for field",
    JSON.stringify(sortByKey(fromBackup)) === JSON.stringify(sortByKey(fromLive)),
    `backup=${JSON.stringify(sortByKey(fromBackup)).slice(0, 200)}\n      live=${JSON.stringify(sortByKey(fromLive)).slice(0, 200)}`);
  check("that identity is not vacuous: real documents were compared on both sides",
    fromBackup.length === 2 && fromLive.length === 2);
  check("the document identity keys match, so a Mac capture of the same thread lands as unchanged rather than duplicated",
    sortByKey(fromBackup).map(key).join(",") === sortByKey(fromLive).map(key).join(","));
}

/* ============ I. the WAL sidecar, and what happens without it ======== */
{
  const backup = makeBackup({ name: "wal-sidecar", wal: true });
  const located = await locateSmsDatabase(backup.directory);
  check("the write-ahead-log sidecar is located through Manifest.db as its own indexed file",
    !!located.sidecars.wal && existsSync(located.sidecars.wal), JSON.stringify(located.sidecars));

  // What opening sms.db alone would have produced: the newest messages, the
  // exact ones the owner checks first, are simply not there.
  const naiveDir = mkdtempSync(join(sandbox, "naive-"));
  const naivePath = join(naiveDir, "sms.db");
  copyFileSync(located.path, naivePath);
  const naive = new DatabaseSync(naivePath, { readOnly: true });
  const naiveCount = naive.prepare("SELECT COUNT(*) AS n FROM message").get().n;
  naive.close();

  const { counts, sent } = await loadAll(backup.directory);
  check("opening the main file alone would have silently dropped the newest messages",
    naiveCount === 6 && counts.rows_seen === 8, `main-only=${naiveCount} with-wal=${counts.rows_seen}`);
  check("with the sidecar replayed, the newest messages are present",
    sent.find((d) => d.source_id === "BK-A1").content.includes("gate code changed to 4417"),
    sent.find((d) => d.source_id === "BK-A1")?.content);
  check("the replay happens on a copy: the backup's own files are never written to",
    counts.copied === true && readFileSync(located.path).length === readFileSync(naivePath).length);
}

/* ================ J. counts, limits, and dry running ================= */
{
  const backup = makeBackup({ name: "counts" });
  const { counts: limited } = await loadAll(backup.directory, { maxRows: 2, pageSize: 2 });
  check("--limit stops the load early and SAYS the history is incomplete",
    limited.truncated === true && limited.rows_seen === 2, JSON.stringify(limited));

  const dryEnvelopes = [];
  const located = await locateSmsDatabase(backup.directory);
  const dry = await loadBackupHistory({
    located, dryRun: true,
    sendEnvelopes: async (e) => { dryEnvelopes.push(...e); },
    ownerLabel: "Morgan Diaz", groupingTimezone: "UTC",
  });
  check("a dry run reads and counts everything but sends nothing",
    dry.rows_seen === 6 && dry.rows_pushed === 5 && dry.documents_sent === 0 &&
    dry.documents_would_send === 2 && dryEnvelopes.length === 0,
    JSON.stringify(dry));
  check("a dry run reports itself as one, so its counts are never mistaken for a load",
    dry.dry_run === true);

  const paged = await loadAll(backup.directory, { pageSize: 2 });
  check("paging through the backup produces the same documents as one page would",
    paged.counts.pages === 3 && paged.sent.length === 2, JSON.stringify(paged.counts));
}

/* ===================== K. the CLI command itself ===================== */

const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = {
  manifest_version: 1,
  client: { slug: "northwind", display_name: "Morgan Diaz", timezone: "UTC" },
  brain: { version: "0.1.22", domain: "brain.northwind-example.test", worker_name: "northwind-brain" },
  corpora: {},
  operations: {},
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

function makeBrainFakes({ script = null } = {}) {
  const receipts = [];
  const batches = [];
  return {
    receipts,
    batches,
    options: {
      resolveAdminKey: () => "fixture-admin-key",
      resolveBaseUrl: async () => "https://brain.northwind-example.test",
      postSourceReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return receipt; },
      requestIngestBatch: async ({ docs }) => {
        batches.push(docs);
        const results = docs.map((doc, i) => ({
          source_id: doc.source_id,
          status: script ? script(doc, i) : "created",
        }));
        return { res: { ok: true, status: 200 }, raw: JSON.stringify({ results }) };
      },
    },
  };
}

/** Run a command with stdout captured, so honesty claims can be asserted. */
async function captureOutput(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); return true; };
  console.log = (...args) => { chunks.push(args.join(" ") + "\n"); };
  try { return { result: await fn(), output: chunks.join("") }; }
  finally { process.stdout.write = origWrite; console.log = origLog; }
}

let cliDocs = [];
{
  const backup = makeBackup({ name: "cli-run" });
  const fakes = makeBrainFakes();
  const { result, output } = await captureOutput(() => cmdIngestIphoneBackup(
    manifest, manifestPath, { backup: backup.directory }, fakes.options,
  ));

  check("the command loads the backup and reports its counts",
    result.rows_seen === 6 && result.rows_pushed === 5 && result.documents_sent === 2, JSON.stringify(result));

  cliDocs = fakes.batches.flat();
  check("both conversations reached the brain's shared batch endpoint, so the credential gate applies to them",
    cliDocs.length === 2 && fakes.batches.length === 1, JSON.stringify(cliDocs.map((d) => d.source_id)));
  check("every document carries source_type iphone-backup, which is the scope key forget deletes on",
    cliDocs.every((d) => d.source_type === "iphone-backup"), JSON.stringify(cliDocs.map((d) => d.source_type)));
  check("the platform tagging survives the rename: iMessage stays imessage, forwarded texts stay sms",
    cliDocs.map((d) => d.metadata.platform).sort().join(",") === "imessage,sms",
    JSON.stringify(cliDocs.map((d) => d.metadata.platform)));

  check("an indexing receipt opened the run and a ready receipt closed it",
    fakes.receipts.length === 2 && fakes.receipts[0].status === "indexing" && fakes.receipts[1].status === "ready",
    JSON.stringify(fakes.receipts.map((r) => r.status)));
  check("the receipts declare kind iphone-backup, not imessage, so a finished snapshot never reads as stale live capture",
    fakes.receipts.every((r) => r.kind === "iphone-backup" && r.source === "iphone-backup"),
    JSON.stringify(fakes.receipts.map((r) => r.kind)));
  check("the ready receipt records the document counts and repeats that this is a snapshot",
    fakes.receipts[1].docs_added === 2 && /snapshot, not live capture/.test(fakes.receipts[1].detail),
    JSON.stringify(fakes.receipts[1]));

  // The honesty rules are product law: the output must not let anyone mistake
  // this for the live connector.
  check("the output states plainly that this is history only, a point-in-time snapshot",
    /history only/.test(output) && /point-in-time snapshot/.test(output), output.slice(0, 400));
  const flatOutput = output.replace(/\s+/g, " ");
  check("the output states that nothing new arrives after the load",
    /Nothing new arrives after this load/.test(flatOutput), flatOutput.slice(0, 500));
  check("the output says how to bring history forward, rather than leaving the owner to guess",
    /take a fresh backup and run this again/i.test(flatOutput), flatOutput.slice(0, 500));
  check("the output names the device and when the backup was taken, so the snapshot has a date",
    /iPhone|iOS 18\.3\.1/.test(output) && /2026-03-03T04:15:00.000Z/.test(output), output.slice(0, 400));
  check("the output hands over the exact undo command",
    output.includes(`brain forget ${manifestPath} --source iphone-backup`), output.slice(-300));

  // Idempotency at the command level: the same backup, run again.
  const second = makeBrainFakes({ script: () => "unchanged" });
  const { result: again } = await captureOutput(() => cmdIngestIphoneBackup(
    manifest, manifestPath, { backup: backup.directory }, second.options,
  ));
  const secondDocs = second.batches.flat();
  check("a second run of the same backup re-reads it whole, deliberately, with no state file to go stale",
    again.rows_seen === 6 && !existsSync(join(sandbox, ".brain-ingest-iphone-backup.json")), JSON.stringify(again));
  check("the second run produces byte-identical documents, so the brain records them as unchanged not duplicated",
    JSON.stringify(secondDocs) === JSON.stringify(cliDocs),
    `${JSON.stringify(secondDocs.map((d) => d.source_id))} vs ${JSON.stringify(cliDocs.map((d) => d.source_id))}`);

  // A named source other than the default still scopes cleanly.
  const named = makeBrainFakes();
  await captureOutput(() => cmdIngestIphoneBackup(
    manifest, manifestPath, { backup: backup.directory, source: "iphone-2026-03" }, named.options,
  ));
  check("--source names the load, and every document and receipt follows that name",
    named.batches.flat().every((d) => d.source_type === "iphone-2026-03") &&
    named.receipts.every((r) => r.source === "iphone-2026-03"),
    JSON.stringify(named.receipts.map((r) => r.source)));

  // --dry-run must not need a key or touch the network at all.
  const dryFakes = makeBrainFakes();
  dryFakes.options.resolveAdminKey = () => { throw new Error("a dry run must not resolve an admin key"); };
  const { result: dryResult, output: dryOutput } = await captureOutput(() => cmdIngestIphoneBackup(
    manifest, manifestPath, { backup: backup.directory, "dry-run": true }, dryFakes.options,
  ));
  check("--dry-run previews without a key, without a receipt and without sending anything",
    dryFakes.batches.length === 0 && dryFakes.receipts.length === 0 &&
    dryResult.would_send === 2 && /dry run, nothing was sent/.test(dryOutput), dryOutput.slice(-200));

  // A truncated load must SAY it is truncated.
  const limitFakes = makeBrainFakes();
  const { result: limitResult, output: limitOutput } = await captureOutput(() => cmdIngestIphoneBackup(
    manifest, manifestPath, { backup: backup.directory, limit: "2" }, limitFakes.options,
  ));
  check("a --limit run is partial and warns that it is NOT a complete history of the backup",
    limitResult.outcome?.kind === "partial" && /NOT a complete history/.test(limitOutput), limitOutput.slice(-300));

  const refusing = makeBrainFakes({ script: () => "refused" });
  const { result: refused } = await captureOutput(() => cmdIngestIphoneBackup(
    manifest, manifestPath, { backup: backup.directory }, refusing.options,
  ));
  check("a refused backup conversation is explicit and never completion-shaped",
    refused.refused === 2 && refused.documents_accepted === 0 &&
    refused.outcome?.kind === "refused" && refused.outcome?.complete === false &&
    refusing.receipts.at(-1)?.status === "error" &&
    refusing.receipts.at(-1)?.issue_code === "INPUT_REFUSED" &&
    !("error" in refusing.receipts.at(-1)) && !("detail" in refusing.receipts.at(-1)),
    JSON.stringify({ refused, receipt: refusing.receipts.at(-1) }));

  // A failed load closes its receipt as an error instead of leaving the run open.
  const failing = makeBrainFakes({ script: () => "failed" });
  let thrown = null;
  try {
    await captureOutput(() => cmdIngestIphoneBackup(
      manifest, manifestPath, { backup: backup.directory }, failing.options,
    ));
  } catch (error) { thrown = error; }
  check("a document failure aborts the load rather than reporting a partial one as done",
    thrown && /document failure/.test(thrown.message), thrown?.message);
  check("the aborted run closes its receipt with a stable issue code only",
    failing.receipts.at(-1).status === "error" &&
    failing.receipts.at(-1).issue_code === "INGEST_FAILED" &&
    !("error" in failing.receipts.at(-1)) && !("detail" in failing.receipts.at(-1)),
    JSON.stringify(failing.receipts.at(-1)));
}

/* ========== L. undoable: the real forget(), on the real schema ======= */
{
  // A real SQLite database carrying the product's own migrated D1 schema,
  // wrapped in a D1-shaped adapter, so the deletion below runs the worker's
  // actual forget() rather than a stand-in for it. The document rows are
  // inserted the way worker/src/lib/store.js binds them — documents.source is
  // the envelope's source_type — which is the single link this test exists to
  // check does not break.
  const dbPath = join(sandbox, "forget-proof.db");
  const sqlite = new DatabaseSync(dbPath);
  for (const file of readdirSync(join(REPO, "migrations", "d1")).sort()) {
    sqlite.exec(readFileSync(join(REPO, "migrations", "d1", file), "utf-8"));
  }
  // Every deployed brain has this row; migration 0010's own comment says the
  // outbox generation triggers fail closed without it, so the fixture is only
  // a real install if it has one.
  sqlite.prepare(
    "INSERT INTO install_state (id, client_slug, product_version, installed_at) VALUES (1,?,?,?)"
  ).run("northwind", "0.1.22", new Date().toISOString());
  const statement = (sql) => ({
    bind: (...values) => ({
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => ({ meta: sqlite.prepare(sql).run(...values) }),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      _exec: () => sqlite.prepare(sql).run(...values),
    }),
    all: async () => ({ results: sqlite.prepare(sql).all() }),
    run: async () => ({ meta: sqlite.prepare(sql).run() }),
  });
  const env = {
    DB: {
      prepare: statement,
      batch: async (statements) => statements.map((s) => s._exec()),
    },
  };

  const insertDoc = sqlite.prepare(
    "INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash) VALUES (?,?,?,?,?,?)"
  );
  const insertChunk = sqlite.prepare(
    "INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id) VALUES (?,?,?,?,?,?)"
  );
  for (const doc of cliDocs) {
    const docUid = `${doc.source_type}:${doc.source_id}`;
    insertDoc.run(docUid, doc.source_type, doc.source_id, doc.title, Date.now(), `hash-${doc.source_id}`);
    insertChunk.run(`${docUid}#0`, docUid, 0, doc.content, doc.source_type, `${docUid}#0`);
  }
  // A decoy from a different source that must survive untouched.
  insertDoc.run("drive:proposal-9", "drive", "proposal-9", "Northwind proposal", Date.now(), "hash-drive");
  insertChunk.run("drive:proposal-9#0", "drive:proposal-9", 0, "unrelated", "drive", "drive:proposal-9#0");

  const preview = await forget(env, { source: "iphone-backup", dryRun: true });
  check("brain forget --source iphone-backup previews exactly this load's documents and nothing else",
    preview.documents === 2 && preview.dry_run === true &&
    preview.targets.every((t) => t.startsWith("iphone-backup:")), JSON.stringify(preview));
  check("the preview changes nothing: every document is still present",
    sqlite.prepare("SELECT COUNT(*) AS n FROM documents").get().n === 3);

  const removed = await forget(env, { source: "iphone-backup", dryRun: false });
  check("confirming the forget removes the loaded documents and their chunks",
    removed.documents === 2 && removed.chunks === 2 && removed.dry_run === false, JSON.stringify(removed));
  const survivors = sqlite.prepare("SELECT doc_uid FROM documents").all().map((r) => r.doc_uid);
  check("the load is gone and the unrelated Drive document is untouched",
    survivors.length === 1 && survivors[0] === "drive:proposal-9", JSON.stringify(survivors));
  check("the deleted chunks are queued for vector removal rather than left orphaned in the index",
    sqlite.prepare("SELECT COUNT(*) AS n FROM vector_outbox WHERE op = 'delete'").get().n === 2);
  sqlite.close();
}

/* ============= M. cross-platform by construction, checked ============ */
{
  const source = readFileSync(join(REPO, "connectors", "iphone-backup.mjs"), "utf-8");
  check("the connector never shells out, so there is no mac-only tool to be missing on Windows",
    !/child_process|execSync|spawnSync|execFileSync|\bspawn\(/.test(source));
  check("the connector composes every host path with node:path",
    /from "node:path"/.test(source));
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^\s*\/\/.*$/gm, "");      // line comments
  const posixLiterals = codeOnly.match(/["'`]\/(?:Users|Library|Applications|opt|usr|var|private)\//g) || [];
  check("no POSIX absolute path is hardcoded anywhere in the connector's code",
    posixLiterals.length === 0, JSON.stringify(posixLiterals));
  check("the only literal separator in the module is the iOS relative path stored inside Manifest.db",
    (codeOnly.match(/"Library\/SMS\/sms\.db"/g) || []).length === 1);
  check("no macOS-only API is reached for: no Full Disk Access probe, no Keychain, no launchd",
    !/Full Disk Access|security find-generic-password|launchctl|LaunchAgent/.test(codeOnly));
  check("the loader is not gated on process.platform: it runs the same everywhere",
    !/process\.platform\s*===\s*["']darwin["']/.test(codeOnly));

  const cli = readFileSync(join(REPO, "brain.mjs"), "utf-8");
  const cmdBody = cli.slice(cli.indexOf("export async function cmdIngestIphoneBackup"));
  check("the CLI command has no macOS gate either, unlike the live iMessage connector",
    !/requireMac|isMac|darwin/.test(cmdBody.slice(0, cmdBody.indexOf("\n}\n") + 3)));
}

} finally {
  // Windows can release a just-closed node:sqlite file a few milliseconds
  // after close() returns. Node's recursive remover only retries EPERM and
  // EBUSY when maxRetries is non-zero; without this both Windows CI lanes
  // completed every assertion and then failed while deleting forget-proof.db.
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    // Some Windows runners retain the disposable SQLite handle beyond the
    // retry window after every assertion has completed.
    if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(error?.code)) throw error;
    console.warn(`WARN  Windows retained the disposable SQLite sandbox: ${error.code}`);
  }
}

console.log(fail ? `\n${fail} FAILURES` : `\niphone backup loader: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
