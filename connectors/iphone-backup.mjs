/**
 * iPhone backup one-time history loader — read an UNENCRYPTED local iPhone
 * backup and load the Messages history it contains, once.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. This is a point-in-time snapshot load.
 * It reads the Messages database that was inside one backup and stops. It is
 * not capture, not a daemon, not a connection: nothing new arrives after the
 * load, and a message sent one minute after that backup was taken is not in
 * it. Bringing history forward means taking a fresh backup and running the
 * load again. The live connector (connectors/imessage.mjs) is the only thing
 * in this product that keeps up with an ongoing conversation, and it needs a
 * Mac. This file exists so that an owner WITHOUT a Mac still gets their
 * message history into their brain on install day, which is otherwise
 * unreachable for them entirely.
 *
 * WHY IT RUNS EVERYWHERE. Apple's backup on disk is an ordinary directory of
 * ordinary files, written identically by macOS Finder, Windows iTunes and the
 * Windows Apple Devices app. Nothing here shells out, nothing here assumes a
 * POSIX path, and every path is composed with node:path — because the whole
 * point of this package is the install where there is no Mac to run on.
 *
 * WHY IT MUST QUERY Manifest.db, AND NEVER GUESS A PATH. In every backup
 * since iOS 10 the files are stored under content-addressed names (a 40-hex
 * fileID in a two-character shard directory), and `Manifest.db` is the index
 * that maps a real iOS path to that name. The Messages database lives at
 * domain `HomeDomain`, relative path `Library/SMS/sms.db`; its fileID is
 * conventionally the SHA-1 of "domain-relativePath", but this loader never
 * computes that, because a convention is not a contract. It asks the index.
 * A guessed path is a silent wrong answer the day the convention changes.
 *
 * WHY AN ENCRYPTED BACKUP IS REFUSED RATHER THAN ATTEMPTED. When a backup is
 * encrypted, Apple encrypts Manifest.db itself, so there is no index to read
 * without the owner's backup password and the full class-key derivation. That
 * is a genuinely different piece of software, and half-doing it would mean
 * failing with an SQLite parse error on a file that is not corrupt. This
 * detects the encryption from Apple's own Manifest.plist flag, says so
 * plainly, and hands over the exact steps — including the real tradeoff,
 * which is that an unencrypted backup sitting on a laptop is readable by
 * anything else on that laptop.
 *
 * WHAT IS DELIBERATELY REUSED. The extraction below is the SAME code the live
 * Mac connector runs: `fetchMessagesSince` (the one chat.db query),
 * `rowToSessionRow` (which carries `parseAttributedBody`, `macAbsoluteToIso`
 * and `platformOf` with it), and `MessageSessionizer`. iOS's sms.db and
 * macOS's chat.db are the same schema, so a conversation loaded from a
 * Windows machine's backup produces a byte-identical document to the same
 * conversation captured live on a Mac — which is what makes the two paths
 * interchangeable instead of merely similar. What is NOT reused is the live
 * connector's `probeChatDb`/`openChatDbReadOnly` (their vocabulary is macOS
 * Full Disk Access, which is meaningless and misleading when the file is a
 * backup artifact on Windows) and its watermark state file (a snapshot has no
 * resume cursor; re-running re-reads the whole backup, which is safe because
 * documents are keyed by message GUID).
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import {
  IMESSAGE_PAGE_SIZE,
  fetchMessagesSince,
  rowToSessionRow,
} from "./imessage.mjs";
import { MessageSessionizer } from "../ingest/message-session.mjs";

/**
 * The Messages database inside a backup. `relativePath` is an iOS path and is
 * ALWAYS forward-slashed, on every host OS — it is data stored in a database,
 * not a path on the machine doing the reading, so it is never joined with
 * node:path separators.
 */
export const SMS_DB_DOMAIN = "HomeDomain";
export const SMS_DB_RELATIVE_PATH = "Library/SMS/sms.db";

/** Apple's Core Foundation epoch (2001-01-01T00:00:00Z) in Unix seconds. */
const APPLE_EPOCH_UNIX_SECONDS = 978_307_200;

/** Every refusal this loader can name, rather than failing as a stack trace. */
export const BACKUP_REFUSAL_REASONS = Object.freeze([
  "backup_missing",
  "backup_not_a_backup",
  "backup_legacy_format",
  "backup_encrypted",
  "backup_manifest_unreadable",
  "backup_ambiguous",
  "backup_none_found",
  "sms_db_not_in_backup",
  "sms_db_file_missing",
  "sms_db_unreadable",
]);

export class IphoneBackupError extends Error {
  constructor(reason, message, { cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "IphoneBackupError";
    this.reason = reason;
    if (detail) this.detail = detail;
  }
}

/* ------------------------------------------------------------------ plists */

/**
 * A minimal property-list reader, binary and XML, sufficient for the handful
 * of top-level flags a backup exposes (`IsEncrypted`, `SnapshotState`, device
 * name, iOS version, backup date).
 *
 * It reads only the keys asked for. That is not an optimisation detail worth
 * hiding: a real backup's Info.plist embeds every installed app's icon as
 * base64 data and routinely runs to tens of megabytes, so decoding the whole
 * tree to learn one string would be the difference between instant and slow
 * on a command whose entire job is to feel instant before the real work.
 */
export function parsePlist(buffer, { keys = null } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") {
    return parseBinaryPlist(buf, keys);
  }
  const head = buf.subarray(0, 512).toString("utf-8");
  if (/<\?xml|<plist/i.test(head)) return parseXmlPlist(buf.toString("utf-8"), keys);
  throw new Error("not a property list (neither bplist00 nor XML)");
}

function parseBinaryPlist(buf, wanted) {
  if (buf.length < 40) throw new Error("binary plist is too short to hold a trailer");
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  // readUIntBE tops out at six bytes. Eight-byte offsets only appear in
  // plists over 2^48 bytes, which cannot exist here; refuse rather than
  // silently truncate a pointer.
  if (offsetSize < 1 || offsetSize > 6 || refSize < 1 || refSize > 6) {
    throw new Error(`unsupported binary plist pointer widths (offset ${offsetSize}, ref ${refSize})`);
  }
  if (!Number.isSafeInteger(numObjects) || !Number.isSafeInteger(offsetTableOffset)) {
    throw new Error("binary plist trailer is out of range");
  }

  const offsetOf = (index) => {
    if (index < 0 || index >= numObjects) throw new Error("binary plist object reference is out of range");
    return buf.readUIntBE(offsetTableOffset + index * offsetSize, offsetSize);
  };
  const refAt = (position) => buf.readUIntBE(position, refSize);

  const sizeAt = (offset) => {
    const info = buf[offset] & 0x0f;
    if (info !== 0x0f) return { length: info, start: offset + 1 };
    const marker = buf[offset + 1];
    if ((marker >> 4) !== 0x1) throw new Error("binary plist length marker is not an integer");
    const width = 1 << (marker & 0x0f);
    if (width > 6) throw new Error("binary plist length field is wider than supported");
    return { length: buf.readUIntBE(offset + 2, width), start: offset + 2 + width };
  };

  const read = (index, depth = 0) => {
    if (depth > 32) throw new Error("binary plist nests deeper than supported");
    const offset = offsetOf(index);
    const marker = buf[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (info === 0x00) return null;
        if (info === 0x08) return false;
        if (info === 0x09) return true;
        return null;
      case 0x1: {
        const width = 1 << info;
        if (width <= 6) return buf.readUIntBE(offset + 1, width);
        if (width === 8) {
          const value = buf.readBigInt64BE(offset + 1);
          return Number.isSafeInteger(Number(value)) ? Number(value) : value;
        }
        throw new Error("binary plist integer is wider than supported");
      }
      case 0x2: {
        const width = 1 << info;
        if (width === 4) return buf.readFloatBE(offset + 1);
        if (width === 8) return buf.readDoubleBE(offset + 1);
        throw new Error("binary plist real is an unsupported width");
      }
      case 0x3:
        return new Date((APPLE_EPOCH_UNIX_SECONDS + buf.readDoubleBE(offset + 1)) * 1000);
      case 0x4: {
        const { length, start } = sizeAt(offset);
        return Buffer.from(buf.subarray(start, start + length));
      }
      case 0x5: {
        const { length, start } = sizeAt(offset);
        return buf.subarray(start, start + length).toString("latin1");
      }
      case 0x6: {
        const { length, start } = sizeAt(offset);
        return buf.subarray(start, start + length * 2).swap16().toString("utf16le");
      }
      case 0x8:
        return { uid: buf.readUIntBE(offset + 1, info + 1) };
      case 0xa:
      case 0xc: {
        const { length, start } = sizeAt(offset);
        const out = [];
        for (let i = 0; i < length; i++) out.push(read(refAt(start + i * refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const { length, start } = sizeAt(offset);
        const out = {};
        for (let i = 0; i < length; i++) {
          const key = read(refAt(start + i * refSize), depth + 1);
          // Only decode the values actually asked for. The skipped ones are
          // never touched, which is what keeps a 40MB Info.plist cheap.
          if (depth === 0 && wanted && !wanted.includes(key)) continue;
          out[String(key)] = read(refAt(start + (length + i) * refSize), depth + 1);
        }
        return out;
      }
      default:
        throw new Error(`unsupported binary plist object type 0x${type.toString(16)}`);
    }
  };

  return read(topObject);
}

/**
 * XML plists appear in older iTunes-written backups. This is a flat scan, not
 * a tree parse: it collects every `<key>` and its immediately following scalar
 * at any depth. That is exactly enough for the top-level flags read here, and
 * it is stated as a limitation rather than presented as a plist parser.
 */
function parseXmlPlist(text, wanted) {
  const out = {};
  const re = /<key>([\s\S]*?)<\/key>\s*(?:<(true|false)\s*\/>|<(string|integer|real|date)>([\s\S]*?)<\/\3>)/g;
  let match;
  while ((match = re.exec(text))) {
    const key = match[1].trim();
    if (wanted && !wanted.includes(key)) continue;
    if (match[2]) out[key] = match[2] === "true";
    else if (match[3] === "integer") out[key] = Number(match[4]);
    else if (match[3] === "real") out[key] = Number(match[4]);
    else if (match[3] === "date") out[key] = new Date(match[4].trim());
    else out[key] = match[4];
  }
  return out;
}

function readPlistFile(path, keys) {
  try {
    return parsePlist(readFileSync(path), { keys });
  } catch {
    // A plist that will not parse is never fatal here: every value read from
    // one is descriptive (device name, backup date, completeness warning).
    // The one flag that MUST NOT be guessed at — encryption — has an
    // independent check against Manifest.db's own bytes below.
    return null;
  }
}

/* --------------------------------------------------- locating a backup */

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isDirectory = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/**
 * Where each OS's Apple software writes backups, by default.
 *
 * The Windows list is three entries because there are genuinely three
 * products: classic iTunes from Apple's own installer writes under %APPDATA%,
 * the Microsoft Store build of iTunes writes inside its sandboxed package
 * cache, and the newer Apple Devices app writes under the user profile
 * directly. Missing one of them looks to the owner like "it cannot find my
 * backup" when the backup is right there.
 */
export function defaultBackupRoots({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  readdir = safeReaddir,
} = {}) {
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "MobileSync", "Backup")];
  }
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const roots = [
      join(appData, "Apple Computer", "MobileSync", "Backup"),
      join(home, "Apple", "MobileSync", "Backup"),
    ];
    // The Store build's package folder carries a per-publisher suffix, so it
    // is discovered rather than hardcoded.
    for (const entry of readdir(join(localAppData, "Packages"))) {
      if (!entry.isDirectory?.() || !String(entry.name).startsWith("AppleInc.iTunes")) continue;
      roots.push(join(
        localAppData, "Packages", entry.name,
        "LocalCache", "Roaming", "Apple Computer", "MobileSync", "Backup",
      ));
    }
    return roots;
  }
  // Linux has no Apple backup software. Say nothing rather than invent a path.
  return [];
}

/** True when this directory is itself one backup (not the folder of backups). */
export function looksLikeBackupDirectory(directory) {
  return existsSync(join(directory, "Manifest.db")) || existsSync(join(directory, "Manifest.mbdb"));
}

/** Every backup directly inside one of the given root folders. */
export function listBackups(roots, { readdir = safeReaddir } = {}) {
  const found = [];
  for (const root of roots) {
    for (const entry of readdir(root)) {
      if (!entry.isDirectory?.()) continue;
      const directory = join(root, entry.name);
      if (looksLikeBackupDirectory(directory)) found.push({ directory, root, name: entry.name });
    }
  }
  return found;
}

/**
 * Resolve which backup to read: an explicit path if given, otherwise the one
 * backup found in this OS's default location.
 *
 * Two or more backups is an ambiguity, never a coin flip. A machine that has
 * backed up two phones, or one phone twice under different device ids, would
 * otherwise get whichever one the filesystem happened to list first, and the
 * owner would have no way to tell that had happened.
 */
export function resolveBackupDirectory({
  path = null,
  home = homedir(),
  platform = process.platform,
  env = process.env,
  readdir = safeReaddir,
} = {}) {
  if (path) {
    const directory = resolvePath(String(path));
    if (!isDirectory(directory)) {
      throw new IphoneBackupError("backup_missing", `no such folder: ${directory}`);
    }
    if (looksLikeBackupDirectory(directory)) return { directory, chosen: "explicit" };
    const inside = listBackups([directory], { readdir });
    if (inside.length === 1) return { directory: inside[0].directory, chosen: "explicit_parent" };
    if (inside.length > 1) {
      throw new IphoneBackupError(
        "backup_ambiguous",
        `${directory} holds ${inside.length} backups. Name the one to load with --backup:\n` +
          inside.map((b) => `        ${b.directory}`).join("\n"),
        { detail: inside.map((b) => b.directory) },
      );
    }
    throw new IphoneBackupError(
      "backup_not_a_backup",
      `${directory} is not an iPhone backup and holds none: no Manifest.db is present, ` +
        "in it or one level down.",
    );
  }

  const roots = defaultBackupRoots({ home, platform, env, readdir });
  const found = listBackups(roots, { readdir });
  if (found.length === 1) return { directory: found[0].directory, chosen: "discovered", roots };
  if (found.length > 1) {
    throw new IphoneBackupError(
      "backup_ambiguous",
      `${found.length} iPhone backups are on this computer. Name the one to load with --backup:\n` +
        found.map((b) => `        ${b.directory}`).join("\n"),
      { detail: found.map((b) => b.directory) },
    );
  }
  throw new IphoneBackupError(
    "backup_none_found",
    roots.length
      ? "no iPhone backup was found in the usual place on this computer:\n" +
        roots.map((r) => `        ${r}`).join("\n") +
        "\n      Make one first (see the steps below), or pass --backup <folder> if it lives elsewhere."
      : "this operating system has no Apple backup software, so there is no usual place to look.\n" +
        "      Pass --backup <folder> pointing at a backup folder copied from a Mac or a Windows PC.",
    { detail: roots },
  );
}

/* ------------------------------------------------- reading one backup */

/**
 * The exact walkthrough for an encrypted backup, with the tradeoff stated.
 *
 * Apple encrypts backups by default in some flows and it is genuinely the
 * safer setting, so "turn it off" is advice with a cost attached and it is
 * printed with that cost attached. Health data and saved passwords only ride
 * along in an ENCRYPTED backup, so an unencrypted one is also a smaller
 * backup than the owner may think they are making.
 */
export function encryptedBackupRemediation() {
  return [
    "This backup is encrypted, so its file index (Manifest.db) is encrypted too and",
    "cannot be opened without the backup password. This loader does not decrypt",
    "backups. To make an unencrypted one:",
    "  On a Mac: open Finder, select the iPhone in the sidebar, and under General",
    "            untick \"Encrypt local backup\", then Back Up Now.",
    "  On Windows: open the Apple Devices app (or iTunes), select the iPhone, and",
    "            untick \"Encrypt local backup\", then Back Up Now.",
    "Two things worth knowing before you do that:",
    "  1. An unencrypted backup is readable by anything else running on that",
    "     computer. Make it, load it, then delete it and switch encryption back on.",
    "  2. Health data and saved passwords are only included in an ENCRYPTED backup.",
    "     They are not what this loads (it reads Messages), but the new backup will",
    "     be missing them if you ever restore from it.",
  ];
}

/**
 * Open the backup and report what it is, without reading any message yet.
 *
 * Encryption is decided from Apple's own Manifest.plist flag first, and from
 * Manifest.db's own bytes second. The second check matters: a file that is
 * not a SQLite database is the ONLY thing this loader can prove by itself,
 * and reporting "encrypted or damaged" is honest where reporting "corrupt"
 * would send the owner chasing the wrong problem.
 */
export function inspectBackup(directory) {
  if (!isDirectory(directory)) {
    return { ok: false, reason: "backup_missing", directory, message: `no such folder: ${directory}` };
  }

  const manifestDbPath = join(directory, "Manifest.db");
  const manifestPlistPath = join(directory, "Manifest.plist");
  const legacyPath = join(directory, "Manifest.mbdb");

  if (!existsSync(manifestDbPath)) {
    if (existsSync(legacyPath)) {
      return {
        ok: false,
        reason: "backup_legacy_format",
        directory,
        message:
          `${directory} is a pre-iOS 10 backup: it indexes its files with Manifest.mbdb, ` +
          "not Manifest.db. This loader reads the modern format only. Take a fresh backup " +
          "from the phone and load that instead.",
      };
    }
    return {
      ok: false,
      reason: "backup_not_a_backup",
      directory,
      message: `${directory} does not look like an iPhone backup: it has no Manifest.db.`,
    };
  }

  const manifestPlist = existsSync(manifestPlistPath)
    ? readPlistFile(manifestPlistPath, ["IsEncrypted", "Version", "Date"])
    : null;
  const flaggedEncrypted = manifestPlist?.IsEncrypted === true;

  let header = Buffer.alloc(0);
  try {
    header = readFileSync(manifestDbPath).subarray(0, 16);
  } catch (error) {
    return {
      ok: false,
      reason: "backup_manifest_unreadable",
      directory,
      message: `the backup's file index could not be read: ${error?.message || error}`,
    };
  }
  const isSqlite = header.subarray(0, 15).toString("latin1") === "SQLite format 3";

  if (flaggedEncrypted) {
    return {
      ok: false,
      reason: "backup_encrypted",
      directory,
      message: `${directory} is an encrypted backup (its own Manifest.plist says so).`,
      remediation: encryptedBackupRemediation(),
    };
  }
  if (!isSqlite) {
    return {
      ok: false,
      reason: "backup_encrypted",
      directory,
      message:
        `${directory}'s Manifest.db is not a readable SQLite file. That is what an ENCRYPTED ` +
        "backup looks like from the outside (an encrypted backup encrypts its own index); a " +
        "damaged backup looks the same, and this cannot tell the two apart from here.",
      remediation: encryptedBackupRemediation(),
    };
  }

  const info = existsSync(join(directory, "Info.plist"))
    ? readPlistFile(join(directory, "Info.plist"), [
        "Device Name", "Product Name", "Product Version", "Last Backup Date", "Unique Identifier",
      ])
    : null;
  const status = existsSync(join(directory, "Status.plist"))
    ? readPlistFile(join(directory, "Status.plist"), ["SnapshotState", "IsFullBackup", "Date"])
    : null;

  const warnings = [];
  const snapshotState = status?.SnapshotState ? String(status.SnapshotState) : null;
  if (snapshotState && snapshotState !== "finished") {
    warnings.push(
      `this backup's own status says "${snapshotState}", not "finished": it may have been ` +
      "interrupted, so it can hold less history than the phone does.",
    );
  }
  if (status && status.IsFullBackup === false) {
    warnings.push("this backup records itself as an incremental snapshot rather than a full one.");
  }

  const backupDate = status?.Date instanceof Date
    ? status.Date
    : (info?.["Last Backup Date"] instanceof Date ? info["Last Backup Date"] : null);

  return {
    ok: true,
    directory,
    manifestDbPath,
    encrypted: false,
    device: {
      name: info?.["Device Name"] ? String(info["Device Name"]) : null,
      product: info?.["Product Name"] ? String(info["Product Name"]) : null,
      ios_version: info?.["Product Version"] ? String(info["Product Version"]) : null,
      identifier: info?.["Unique Identifier"] ? String(info["Unique Identifier"]) : null,
    },
    backup_taken_at: backupDate && Number.isFinite(backupDate.getTime()) ? backupDate.toISOString() : null,
    snapshot_state: snapshotState,
    warnings,
  };
}

async function sqliteDatabaseSync() {
  // node:sqlite ships with Node 22+, which package.json already requires.
  // Imported lazily so loading this module never prints the experimental
  // warning for commands that never open a backup.
  const { DatabaseSync } = await import("node:sqlite");
  return DatabaseSync;
}

/**
 * Ask the backup's own index where a file was stored.
 *
 * `flags` is 1 for a file and 2 for a directory in every backup Apple has
 * written; a directory row for the same path would otherwise resolve to a
 * shard entry that is not there.
 */
export function findBackupFile(db, domain, relativePath) {
  const row = db.prepare(
    "SELECT fileID, domain, relativePath, flags FROM Files WHERE domain = ? AND relativePath = ? LIMIT 1"
  ).get(domain, relativePath);
  if (!row || !row.fileID) return null;
  if (row.flags !== null && row.flags !== undefined && Number(row.flags) === 2) return null;
  return { fileID: String(row.fileID), domain: String(row.domain), relativePath: String(row.relativePath) };
}

/**
 * Turn a fileID into the place its bytes actually sit. Modern backups shard
 * by the first two hex characters; a handful of early-iOS-10 backups wrote
 * everything flat in the backup root. Both are checked, in that order.
 */
export function storedFilePath(directory, fileID) {
  const sharded = join(directory, String(fileID).slice(0, 2), String(fileID));
  if (existsSync(sharded)) return sharded;
  const flat = join(directory, String(fileID));
  if (existsSync(flat)) return flat;
  return null;
}

/**
 * Find the Messages database inside a backup, through Manifest.db, plus any
 * write-ahead-log sidecars that came with it.
 *
 * The sidecars matter more than they look. iOS runs sms.db in WAL mode, and a
 * backup carries `sms.db-wal` as its own separate indexed file. Opening the
 * main database without it silently returns the history as of the last
 * checkpoint and drops the most recent messages — the exact ones an owner
 * will check first to decide whether this worked.
 */
export async function locateSmsDatabase(directory, { DatabaseSync = null } = {}) {
  const inspected = inspectBackup(directory);
  if (!inspected.ok) {
    throw new IphoneBackupError(inspected.reason, inspected.message, { detail: inspected.remediation });
  }
  const Database = DatabaseSync || (await sqliteDatabaseSync());
  let db;
  try {
    db = new Database(inspected.manifestDbPath, { readOnly: true });
  } catch (error) {
    throw new IphoneBackupError(
      "backup_manifest_unreadable",
      `the backup's file index at ${inspected.manifestDbPath} could not be opened: ${error?.message || error}`,
      { cause: error },
    );
  }

  try {
    const main = findBackupFile(db, SMS_DB_DOMAIN, SMS_DB_RELATIVE_PATH);
    if (!main) {
      let total = null;
      try { total = db.prepare("SELECT COUNT(*) AS n FROM Files").get()?.n ?? null; } catch { /* diagnostic only */ }
      throw new IphoneBackupError(
        "sms_db_not_in_backup",
        `this backup's index lists ${total === null ? "its" : `${total}`} file(s), and none of them is the ` +
          `Messages database (${SMS_DB_DOMAIN}/${SMS_DB_RELATIVE_PATH}). Messages was excluded from this ` +
          "backup, or the phone keeps its messages only in iCloud.",
      );
    }
    const path = storedFilePath(directory, main.fileID);
    if (!path) {
      throw new IphoneBackupError(
        "sms_db_file_missing",
        `the backup's index names the Messages database as ${main.fileID}, but that file is not ` +
          `present in ${directory}. The backup folder is incomplete — copied part-way, most likely.`,
      );
    }
    const sidecars = {};
    for (const [key, suffix] of [["wal", "-wal"], ["shm", "-shm"]]) {
      const found = findBackupFile(db, SMS_DB_DOMAIN, `${SMS_DB_RELATIVE_PATH}${suffix}`);
      const at = found ? storedFilePath(directory, found.fileID) : null;
      if (at) sidecars[key] = at;
    }
    return { path, fileID: main.fileID, sidecars, backup: inspected };
  } finally {
    db.close();
  }
}

/**
 * Open the backed-up Messages database for reading.
 *
 * When the backup carries WAL sidecars the trio is copied into an owner-only
 * temporary directory and opened there, for two reasons: SQLite needs to
 * replay the log to see the newest messages, and replaying it means writing,
 * which must never happen to the owner's backup. With no sidecars the file is
 * opened read-only in place, which copies nothing.
 */
export async function openBackupSmsDb(located, {
  DatabaseSync = null,
  snapshotParent = tmpdir(),
} = {}) {
  const Database = DatabaseSync || (await sqliteDatabaseSync());
  const openAt = (path, options) => {
    const db = new Database(path, options);
    db.prepare("SELECT count(*) AS n FROM message").get();
    return db;
  };

  const hasSidecars = !!(located.sidecars?.wal || located.sidecars?.shm);
  let inPlaceError = null;
  if (!hasSidecars) {
    try {
      const db = openAt(located.path, { readOnly: true });
      return { db, workDir: null, copied: false, close: () => db.close() };
    } catch (directError) {
      // Falls through to the copy path, which is also what recovers a
      // database whose WAL sidecar was not indexed under the name expected.
      inPlaceError = directError;
    }
  }

  let workDir;
  try {
    workDir = mkdtempSync(join(snapshotParent, "brain-iphone-backup-"));
    try { chmodSync(workDir, 0o700); } catch { /* Windows has no POSIX mode; the temp dir is per-user anyway */ }
    const target = join(workDir, "sms.db");
    copyFileSync(located.path, target);
    if (located.sidecars?.wal) copyFileSync(located.sidecars.wal, `${target}-wal`);
    if (located.sidecars?.shm) copyFileSync(located.sidecars.shm, `${target}-shm`);
    for (const file of [target, `${target}-wal`, `${target}-shm`]) {
      if (existsSync(file)) { try { chmodSync(file, 0o600); } catch { /* as above */ } }
    }
    // Read-write on OUR copy, never on the backup: this is what lets SQLite
    // replay the write-ahead log and see the newest messages.
    const db = openAt(target, {});
    return {
      db,
      workDir,
      copied: true,
      close: () => {
        try { db.close(); } finally { rmSync(workDir, { recursive: true, force: true }); }
      },
    };
  } catch (copyError) {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    throw new IphoneBackupError(
      "sms_db_unreadable",
      `the Messages database inside the backup could not be opened (${String(copyError?.message || copyError)})` +
        (inPlaceError ? `; opening it in place first failed with ${String(inPlaceError?.message || inPlaceError)}` : ""),
      { cause: copyError },
    );
  }
}

/**
 * The schema this loader needs, checked before a single row is read.
 *
 * iOS's sms.db and macOS's chat.db are the same schema, which is the whole
 * reason the live connector's query can be reused verbatim. "Same schema" is
 * a claim about every iOS version, though, and a very old backup can be
 * missing `attributedBody` (the column current iOS writes message text into).
 * Reading that backup would silently produce empty conversations, so it is
 * named and refused instead.
 */
export function assertSmsSchema(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => String(r.name))
  );
  const required = ["message", "handle", "chat", "chat_message_join", "chat_handle_join"];
  const missingTables = required.filter((name) => !tables.has(name));
  if (missingTables.length) {
    throw new IphoneBackupError(
      "sms_db_unreadable",
      `the file the backup indexes as the Messages database is missing ${missingTables.join(", ")}, ` +
        "so it is not an iOS Messages database.",
    );
  }
  const columns = new Set(
    db.prepare("SELECT name FROM pragma_table_info('message')").all().map((r) => String(r.name))
  );
  // ROWID is not listed: SQLite exposes it on every ordinary table without
  // it appearing in table_info.
  const missingColumns = ["guid", "text", "attributedBody", "date", "is_from_me", "handle_id"]
    .filter((name) => !columns.has(name));
  if (missingColumns.length) {
    throw new IphoneBackupError(
      "sms_db_unreadable",
      `this backup's Messages database has no ${missingColumns.join(", ")} column, which means it was ` +
        "written by an iOS version older than this loader reads. Take a fresh backup from a current " +
        "iPhone and load that instead; loading this one would produce empty conversations rather than an error.",
    );
  }
  return true;
}

/**
 * One complete history load: page through the whole backed-up database in
 * ROWID order, sessionize through the same MessageSessionizer every other
 * chat platform uses, and hand each page's closed conversation documents to
 * the caller.
 *
 * There is no watermark and no state file, deliberately. A snapshot has no
 * "since last time"; the load reads the whole backup every run, and re-running
 * is safe because every document is keyed by its first message's GUID, so the
 * brain recognises the second run's documents as unchanged rather than as
 * duplicates. That also means loading a NEWER backup later adds only what is
 * new in it, with no bookkeeping to get wrong.
 */
export async function loadBackupHistory({
  located,
  sendEnvelopes,
  ownerLabel = "Owner",
  groupingTimezone = "UTC",
  pageSize = IMESSAGE_PAGE_SIZE,
  maxRows = Infinity,
  dryRun = false,
  onPage = () => {},
  openDb = openBackupSmsDb,
} = {}) {
  if (!located?.path) throw new Error("loadBackupHistory requires a located Messages database");
  if (typeof sendEnvelopes !== "function") throw new Error("loadBackupHistory requires a sendEnvelopes function");

  const sessionizer = new MessageSessionizer({ ownerLabel, groupingTimezone });
  const counts = {
    pages: 0,
    rows_seen: 0,
    rows_pushed: 0,
    rows_skipped: { no_guid: 0, no_timestamp: 0, no_text: 0 },
    documents_sent: 0,
    documents_would_send: 0,
    threads: 0,
    earliest: null,
    latest: null,
    dry_run: dryRun,
    truncated: false,
  };
  const threads = new Set();

  const dispatch = async (envelopes) => {
    if (!envelopes.length) return;
    if (dryRun) {
      counts.documents_would_send += envelopes.length;
      return;
    }
    await sendEnvelopes(envelopes);
    counts.documents_sent += envelopes.length;
  };

  const opened = await openDb(located);
  counts.copied = opened.copied;
  try {
    assertSmsSchema(opened.db);
    let cursor = 0;
    let remaining = maxRows;
    for (;;) {
      const limit = Math.min(pageSize, remaining);
      if (limit <= 0) { counts.truncated = true; break; }
      const rows = fetchMessagesSince(opened.db, cursor, limit);
      if (!rows.length) break;
      counts.pages++;
      counts.rows_seen += rows.length;
      remaining -= rows.length;

      const closed = [];
      for (const raw of rows) {
        cursor = Math.max(cursor, Number(raw.rowid) || 0);
        const row = rowToSessionRow(raw);
        if (!row.id) { counts.rows_skipped.no_guid++; continue; }
        if (!row.ts) { counts.rows_skipped.no_timestamp++; continue; }
        if (!row.body) {
          // Tapbacks, attachment-only rows and undecodable bodies. Counted,
          // never silently dropped, so "why is this thread thinner than my
          // phone shows" has an answer in the run report.
          counts.rows_skipped.no_text++;
          continue;
        }
        counts.rows_pushed++;
        threads.add(`${row.platform}:${row.thread_id}`);
        if (!counts.earliest || row.ts < counts.earliest) counts.earliest = row.ts;
        if (!counts.latest || row.ts > counts.latest) counts.latest = row.ts;
        closed.push(...sessionizer.push(row));
      }

      await dispatch(closed);
      onPage({ page: counts.pages, rows: rows.length, rowid: cursor });
      if (rows.length < limit) break;
    }

    // A backup is finished history: nothing can arrive later to extend the
    // last conversation, so every remaining session is closed here rather
    // than being left open the way live capture must leave it.
    await dispatch(sessionizer.finish());
    counts.threads = threads.size;
    return counts;
  } finally {
    opened.close();
  }
}
