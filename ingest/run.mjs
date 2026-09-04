/**
 * Walk a folder, extract text, and load it into the client's brain.
 *
 * DESIGN NOTES THAT MATTER
 *
 * RESUMABLE BY DEFAULT. A first import is tens of thousands of files and will be
 * interrupted: a laptop sleeps, a token expires, someone closes the lid. State
 * is written after every batch, keyed by content hash, so a re-run skips what
 * already landed and costs one read per file rather than a re-embed. Re-running
 * is the normal way to finish, not a recovery procedure.
 *
 * EVERY SKIP IS RECORDED WITH ITS REASON. A file that silently does not make it
 * in produces a brain that is confidently ignorant of it. The run ends with a
 * breakdown by reason, and the state file keeps it, so "why isn't my contract in
 * there" has an answer.
 *
 * PRIVATE PREFIXES ARE ENFORCED HERE. The manifest has advertised
 * safety.private_path_prefixes since the beginning and nothing honoured it. This
 * is where it becomes true.
 */

import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, writeFileSync, existsSync, mkdirSync, renameSync,
  chmodSync, rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { extract, canExtract, extensionOf, isBinaryFormat } from "./extract.mjs";
import {
  MAX_DOC_CHARS, batches, envelopeBytes, estimatedStatements, splitOversized,
} from "./envelope-batching.mjs";
// Side-effect import: registers pdf/docx/xlsx/pptx/eml and pulls in their
// dependencies. Importing it here rather than in extract.mjs keeps the core
// registry honestly dependency-free.
import "./formats.mjs";
import { textQuality, isLikelyBinary, utf16Encoding } from "./quality.mjs";
import { documentDate } from "./doc-date.mjs";
import { detectWhatsAppExport, parseWhatsAppExport, deriveThreadTitle } from "./whatsapp-export.mjs";
import {
  detectSmsBackupXml, parseSmsBackupXml,
  detectGoogleVoiceTakeout, parseGoogleVoiceTakeout, deriveVoiceThreadTitle,
} from "./sms-backup.mjs";
import {
  detectFacebookMessengerExport, isFacebookMessengerExportFilename,
  parseFacebookMessengerExport,
} from "./facebook-messenger-export.mjs";
import { parseLinkedInArchive } from "./linkedin-export.mjs";
import { MessageSessionizer } from "./message-session.mjs";
import { MboxStreamSplitter, mboxMessageKey } from "./mbox.mjs";
// The one mail reader. Imported by name rather than reached through the
// registry because an archive's messages need their own subjects and dates,
// and a second parser beside the first is how the two start disagreeing.
import { parseEmailMessage } from "./formats.mjs";

// Preserve the original ingest/run.mjs API while letting migration-only code
// import the dependency-free boundary directly.
export { MAX_DOC_CHARS, batches, envelopeBytes, estimatedStatements, splitOversized };

/** Never worth walking into. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv",
  ".next", ".cache", "dist", "build", ".Trash", "$RECYCLE.BIN",
  // Where `brain connect` stores the client's Google refresh token. The dot
  // prefix already excludes it and the worker's credential gate would refuse it
  // anyway, but a brain indexing its own credentials is worth two guards.
  ".brain",
  "System Volume Information", ".DS_Store",
]);

/** Filesystem bookkeeping, never content. */
const JUNK_FILES = new Set(["thumbs.db", "desktop.ini", "icon\r", ".ds_store", "$recycle.bin"]);

/** A single file larger than this is a database or a media asset, not a document. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The same in-memory/scan ceiling for a file that is not one document.
 *
 * A mail archive is a folder of hundreds of messages, and a real one is
 * routinely larger than this. Local mbox ingest streams the complete file for
 * a stable content hash and parses only complete messages inside this window;
 * crossing it is reported as incomplete. Buffered archives such as ZIP still
 * use it as a hard file ceiling.
 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** One malformed or attachment-heavy email cannot own the whole process. */
export const MAX_MBOX_MESSAGE_BYTES = MAX_FILE_BYTES;

/** Buffered multi-document containers that still get the hard archive ceiling. */
const BUFFERED_ARCHIVE_EXTENSIONS = new Set([".zip"]);

export const fileSizeLimitFor = (name, maxBytes, archiveBytes) =>
  extensionOf(name) === ".mbox"
    ? Number.MAX_SAFE_INTEGER
    : (BUFFERED_ARCHIVE_EXTENSIONS.has(extensionOf(name)) || isFacebookMessengerExportFilename(name)
      ? archiveBytes
      : maxBytes);

class LocalFileSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalFileSafetyError";
    this.code = code;
  }
}

const localFileFail = (code, message) => {
  throw new LocalFileSafetyError(code, message);
};

const nativeRealpath = realpathSync.native || realpathSync;

const comparablePath = (value) => {
  const normalized = resolve(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

function pathIsWithin(root, candidate) {
  const rel = relative(comparablePath(root), comparablePath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function regularFileSnapshot(st) {
  return {
    dev: String(st.dev),
    ino: String(st.ino),
    size: String(st.size),
    mtimeNs: String(st.mtimeNs ?? BigInt(Math.trunc(Number(st.mtimeMs) * 1e6))),
    ctimeNs: String(st.ctimeNs ?? BigInt(Math.trunc(Number(st.ctimeMs) * 1e6))),
  };
}

const sameFileIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

const sameFileVersion = (left, right) =>
  sameFileIdentity(left, right) && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

function inspectRegularPath(path) {
  let st;
  try {
    st = lstatSync(path, { bigint: true });
  } catch (error) {
    localFileFail("LOCAL_FILE_METADATA_UNAVAILABLE", `file metadata could not be read: ${error.code || "unavailable"}`);
  }
  if (st.isSymbolicLink()) {
    localFileFail("LOCAL_FILE_LINK_REFUSED", "symbolic links and junctions are not ingested");
  }
  if (!st.isFile()) localFileFail("LOCAL_FILE_NOT_REGULAR", "the path is not a regular file");
  return regularFileSnapshot(st);
}

function approveLocalRoot(root) {
  const rootPath = resolve(String(root));
  let st;
  try {
    st = lstatSync(rootPath, { bigint: true });
  } catch (error) {
    localFileFail("LOCAL_ROOT_METADATA_UNAVAILABLE", `folder metadata could not be read: ${error.code || "unavailable"}`);
  }
  if (st.isSymbolicLink()) {
    localFileFail("LOCAL_ROOT_LINK_REFUSED", "the ingest root is a symbolic link or junction");
  }
  if (!st.isDirectory()) localFileFail("LOCAL_ROOT_NOT_DIRECTORY", "the ingest root is not a directory");
  let rootReal;
  try {
    rootReal = nativeRealpath(rootPath);
  } catch (error) {
    localFileFail("LOCAL_ROOT_REALPATH_UNAVAILABLE", `folder identity could not be resolved: ${error.code || "unavailable"}`);
  }
  return { rootPath, rootReal };
}

function approveWalkedFile(full, rootApproval) {
  const fullPath = resolve(String(full));
  const identity = inspectRegularPath(fullPath);
  let fileReal;
  try {
    fileReal = nativeRealpath(fullPath);
  } catch (error) {
    localFileFail("LOCAL_FILE_REALPATH_UNAVAILABLE", `file identity could not be resolved: ${error.code || "unavailable"}`);
  }
  if (!pathIsWithin(rootApproval.rootReal, fileReal)) {
    localFileFail("LOCAL_FILE_OUTSIDE_ROOT", "the file resolves outside the approved ingest root");
  }
  return { rootPath: rootApproval.rootPath, rootReal: rootApproval.rootReal, identity };
}

function localReadApproval(file) {
  if (file?._localApproval?.rootReal && file?._localApproval?.identity) return file._localApproval;

  // A few format fixtures call prepare() directly. Give those calls the same
  // link-refusing descriptor read, with the containing directory as the narrow
  // root. Production folder ingest always supplies walk()'s earlier identity.
  const fullPath = resolve(String(file?.full || ""));
  const rootPath = resolve(fullPath, "..");
  let rootReal;
  try {
    rootReal = nativeRealpath(rootPath);
  } catch (error) {
    localFileFail("LOCAL_ROOT_REALPATH_UNAVAILABLE", `folder identity could not be resolved: ${error.code || "unavailable"}`);
  }
  return { rootPath, rootReal, identity: inspectRegularPath(fullPath) };
}

function openLocalNoFollow(path) {
  // POSIX exposes O_NOFOLLOW. Windows does not expose the equivalent reparse
  // flag through Node, so descriptor identity is checked before any byte read.
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW || 0);
  try {
    return openSync(path, constants.O_RDONLY | noFollow | (constants.O_CLOEXEC || 0));
  } catch (error) {
    if (error?.code === "ELOOP") {
      localFileFail("LOCAL_FILE_LINK_REFUSED", "symbolic links and junctions are not ingested");
    }
    localFileFail("LOCAL_FILE_OPEN_REFUSED", `the approved file could not be opened: ${error.code || "unavailable"}`);
  }
}

function readBoundedLocalFile(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    let count;
    try {
      count = readSync(fd, chunk, 0, chunk.length, total);
    } catch (error) {
      localFileFail("LOCAL_FILE_READ_FAILED", `the approved file could not be read: ${error.code || "unavailable"}`);
    }
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > maxBytes) {
    localFileFail("LOCAL_FILE_TOO_LARGE", `the file changed and is now over the ${(maxBytes / 1048576).toFixed(0)}MB limit`);
  }
  return Buffer.concat(chunks, total);
}

/** Read only the regular file identity approved by walk(), within its root. */
function readApprovedLocalFile(file, { maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    localFileFail("LOCAL_FILE_LIMIT_INVALID", "the local file size limit is invalid");
  }
  const fullPath = resolve(String(file?.full || ""));
  const approval = localReadApproval(file);
  const pathBefore = inspectRegularPath(fullPath);
  if (!sameFileIdentity(pathBefore, approval.identity)) {
    localFileFail("LOCAL_FILE_IDENTITY_CHANGED", "the file changed after the folder was scanned; retry the ingest");
  }
  let realBefore;
  try {
    realBefore = nativeRealpath(fullPath);
  } catch (error) {
    localFileFail("LOCAL_FILE_REALPATH_UNAVAILABLE", `file identity could not be resolved: ${error.code || "unavailable"}`);
  }
  if (!pathIsWithin(approval.rootReal, realBefore)) {
    localFileFail("LOCAL_FILE_OUTSIDE_ROOT", "the file resolves outside the approved ingest root");
  }

  const fd = openLocalNoFollow(fullPath);
  try {
    let before;
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) localFileFail("LOCAL_FILE_NOT_REGULAR", "the opened path is not a regular file");
      before = regularFileSnapshot(st);
    } catch (error) {
      if (error instanceof LocalFileSafetyError) throw error;
      localFileFail("LOCAL_FILE_METADATA_UNAVAILABLE", `opened-file metadata could not be read: ${error.code || "unavailable"}`);
    }
    if (!sameFileIdentity(before, approval.identity) || !sameFileIdentity(before, pathBefore)) {
      localFileFail("LOCAL_FILE_IDENTITY_CHANGED", "the file changed while it was being opened; retry the ingest");
    }
    if (BigInt(before.size) > BigInt(maxBytes)) {
      localFileFail("LOCAL_FILE_TOO_LARGE", `the file changed and is now over the ${(maxBytes / 1048576).toFixed(0)}MB limit`);
    }

    const bytes = readBoundedLocalFile(fd, maxBytes);
    let after;
    try {
      after = regularFileSnapshot(fstatSync(fd, { bigint: true }));
    } catch (error) {
      localFileFail("LOCAL_FILE_METADATA_UNAVAILABLE", `opened-file metadata could not be rechecked: ${error.code || "unavailable"}`);
    }
    if (!sameFileVersion(before, after) || BigInt(after.size) !== BigInt(bytes.length)) {
      localFileFail("LOCAL_FILE_CHANGED_DURING_READ", "the file changed while it was being read; retry the ingest");
    }

    const pathAfter = inspectRegularPath(fullPath);
    let realAfter;
    try {
      realAfter = nativeRealpath(fullPath);
    } catch (error) {
      localFileFail("LOCAL_FILE_REALPATH_UNAVAILABLE", `file identity could not be rechecked: ${error.code || "unavailable"}`);
    }
    if (!sameFileIdentity(pathAfter, after) || !pathIsWithin(approval.rootReal, realAfter)) {
      localFileFail("LOCAL_FILE_IDENTITY_CHANGED", "the file path changed while it was being read; retry the ingest");
    }
    return bytes;
  } finally {
    try { closeSync(fd); } catch { /* the safety result above is authoritative */ }
  }
}

/**
 * Stream the same approved regular-file identity while retaining the complete
 * post-read stability proof used by the bounded reader above.
 *
 * The consumer must exhaust this iterator before using any derived result. If
 * the path, inode, size, mtime, or ctime changes while bytes are being read,
 * the final iteration throws and the caller discards everything it prepared.
 */
function* streamApprovedLocalFile(file) {
  const fullPath = resolve(String(file?.full || ""));
  const approval = localReadApproval(file);
  const pathBefore = inspectRegularPath(fullPath);
  if (!sameFileIdentity(pathBefore, approval.identity)) {
    localFileFail("LOCAL_FILE_IDENTITY_CHANGED", "the file changed after the folder was scanned; retry the ingest");
  }
  let realBefore;
  try {
    realBefore = nativeRealpath(fullPath);
  } catch (error) {
    localFileFail("LOCAL_FILE_REALPATH_UNAVAILABLE", `file identity could not be resolved: ${error.code || "unavailable"}`);
  }
  if (!pathIsWithin(approval.rootReal, realBefore)) {
    localFileFail("LOCAL_FILE_OUTSIDE_ROOT", "the file resolves outside the approved ingest root");
  }

  const fd = openLocalNoFollow(fullPath);
  try {
    let before;
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) localFileFail("LOCAL_FILE_NOT_REGULAR", "the opened path is not a regular file");
      before = regularFileSnapshot(st);
    } catch (error) {
      if (error instanceof LocalFileSafetyError) throw error;
      localFileFail("LOCAL_FILE_METADATA_UNAVAILABLE", `opened-file metadata could not be read: ${error.code || "unavailable"}`);
    }
    if (!sameFileIdentity(before, approval.identity) || !sameFileIdentity(before, pathBefore)) {
      localFileFail("LOCAL_FILE_IDENTITY_CHANGED", "the file changed while it was being opened; retry the ingest");
    }
    if (BigInt(before.size) > BigInt(Number.MAX_SAFE_INTEGER)) {
      localFileFail("LOCAL_FILE_TOO_LARGE", "the mail archive is too large for this runtime to address safely");
    }

    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let count;
      try {
        count = readSync(fd, chunk, 0, chunk.length, null);
      } catch (error) {
        localFileFail("LOCAL_FILE_READ_FAILED", `the approved file could not be read: ${error.code || "unavailable"}`);
      }
      if (count === 0) break;
      total += count;
      if (!Number.isSafeInteger(total)) {
        localFileFail("LOCAL_FILE_TOO_LARGE", "the mail archive is too large for this runtime to address safely");
      }
      yield chunk.subarray(0, count);
    }

    let after;
    try {
      after = regularFileSnapshot(fstatSync(fd, { bigint: true }));
    } catch (error) {
      localFileFail("LOCAL_FILE_METADATA_UNAVAILABLE", `opened-file metadata could not be rechecked: ${error.code || "unavailable"}`);
    }
    if (!sameFileVersion(before, after) || BigInt(after.size) !== BigInt(total)) {
      localFileFail("LOCAL_FILE_CHANGED_DURING_READ", "the file changed while it was being read; retry the ingest");
    }

    const pathAfter = inspectRegularPath(fullPath);
    let realAfter;
    try {
      realAfter = nativeRealpath(fullPath);
    } catch (error) {
      localFileFail("LOCAL_FILE_REALPATH_UNAVAILABLE", `file identity could not be rechecked: ${error.code || "unavailable"}`);
    }
    if (!sameFileIdentity(pathAfter, after) || !pathIsWithin(approval.rootReal, realAfter)) {
      localFileFail("LOCAL_FILE_IDENTITY_CHANGED", "the file path changed while it was being read; retry the ingest");
    }
  } finally {
    try { closeSync(fd); } catch { /* the safety result above is authoritative */ }
  }
}

const localFileSafetyReason = (error) => error instanceof LocalFileSafetyError
  ? error.message
  : `could not safely inspect the local file: ${error?.code || "unavailable"}`;

export function walk(root, { privatePrefixes = [], maxBytes = MAX_FILE_BYTES, archiveBytes = MAX_ARCHIVE_BYTES } = {}) {
  const files = [];
  const skipped = [];
  let complete = true;
  const prefixes = privatePrefixes.map((p) => p.toLowerCase());

  let rootApproval;
  try {
    rootApproval = approveLocalRoot(root);
  } catch (error) {
    return {
      files,
      skipped: [{ path: root, reason: localFileSafetyReason(error) }],
      complete: false,
    };
  }

  const isPrivate = (rel) =>
    rel.split(/[\\/]/).some((seg) => prefixes.some((p) => seg.toLowerCase().startsWith(p)));

  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // A directory that cannot be listed is reported, never swallowed: a
      // permission error that silently truncates the walk looks like success.
      skipped.push({ path: dir, reason: `directory could not be read: ${e.code || e.message}` });
      complete = false;
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symbolic links and junctions are not ingested" });
        // A link can stand in for one prior file or an entire prior subtree.
        // Treating the walk as complete could therefore turn a refused link
        // into deletion evidence for children that were never enumerated.
        complete = false;
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (isPrivate(rel)) {
          skipped.push({ path: rel, reason: "matched a private path prefix from the manifest" });
          continue;
        }
        visit(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.startsWith(".")) continue;
      // macOS AppleDouble stubs. A Drive- or USB-synced corpus is full of them:
      // "._contract.pdf" sits beside "contract.pdf", carries only resource-fork
      // metadata, and every extractor fails on it. Counting those as errors
      // would bury the real failures in noise.
      if (e.name.startsWith("._")) continue;
      if (JUNK_FILES.has(e.name.toLowerCase())) continue;
      if (isPrivate(rel)) {
        skipped.push({ path: rel, reason: "matched a private path prefix from the manifest" });
        continue;
      }
      let approval;
      try {
        approval = approveWalkedFile(full, rootApproval);
      } catch (error) {
        skipped.push({ path: rel, reason: localFileSafetyReason(error) });
        // Any identity or containment failure means the walk did not establish
        // a complete deletion boundary, so no ingest or removal may run.
        complete = false;
        continue;
      }
      const size = Number(approval.identity.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        skipped.push({ path: rel, reason: "file size could not be represented safely" });
        complete = false;
        continue;
      }
      if (size === 0) { skipped.push({ path: rel, reason: "file is empty" }); continue; }
      const sizeLimit = fileSizeLimitFor(e.name, maxBytes, archiveBytes);
      if (size > sizeLimit) {
        skipped.push({ path: rel, reason: `file is ${(size / 1048576).toFixed(1)}MB, over the ${(sizeLimit / 1048576).toFixed(0)}MB limit` });
        continue;
      }
      files.push({
        full, rel, name: e.name, size, sizeLimit, _localApproval: approval,
        // Unlike a ZIP, an mbox can be admitted without buffering its complete
        // file. Keep the caller's archive bound as its parsing window instead.
        ...(extensionOf(e.name) === ".mbox" ? { mboxScanBytes: archiveBytes } : {}),
      });
    }
  };

  visit(root);
  return { files, skipped, complete };
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Same decode the core plain-text extractor uses: real encoding, BOM stripped. */
function decodeText(buf) {
  const enc = utf16Encoding(buf) || "utf-8";
  const text = new TextDecoder(enc, { fatal: false }).decode(buf);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The document family that one multi-document source file produces.
 *
 * A message export is ONE file that becomes MANY documents, one per
 * conversation session, and each of those keeps its own message-namespace
 * identity (`message:<first message id>`) so a citation still points at the
 * conversation rather than at the container it arrived in. Nothing inside
 * those uids names the file, so the file cannot be reconciled or removed as a
 * unit unless every document it produced says out loud which file it came
 * from. `family_of` is that statement. It carries the FULLY QUALIFIED family
 * uid (`<source>:<path>`), so no prefixing rule has to be re-derived at read
 * time and no namespace can be guessed wrong.
 *
 * Deliberately NOT `part_of`. `part_of` means "this row is one slice of a
 * single logical document": storage counts a part_of family as ONE logical
 * document (worker store.js stats, worker index.js source receipts) and
 * collapses it into one inventory slot (store-d1.js listSourceFamilies). Two
 * conversation sessions out of one export are two logical documents with two
 * separate citations, so borrowing part_of for them would quietly mis-count
 * every message export. family_of adds the missing "same origin file" edge
 * without changing what a document is.
 */
export function sourceFileFamilyUid(file, sourceName) {
  return `${sourceName}:${String(file.rel).split(sep).join("/")}`;
}

/** Stamp every document a multi-document file produced with its family uid. */
function declareFamily(envelopes, familyUid) {
  return envelopes.map((envelope) => ({
    ...envelope,
    metadata: { ...(envelope.metadata || {}), family_of: familyUid },
  }));
}

/**
 * One export file, many documents. Sessionizes through the same
 * message-session.mjs every other chat platform uses, so a WhatsApp export
 * lands identically to iMessage/SMS/Messenger history once those connectors
 * exist. Returns `envelopes` (plural) rather than `envelope`; the caller in
 * cmdIngest keys the whole family on the file's own path since there is no
 * single document identity to key on.
 */
async function prepareWhatsAppExport(file, buf, hash, { sourceName }) {
  const text = decodeText(buf);
  const threadId = `${sourceName}:${file.rel.split(sep).join("/")}`;
  const threadTitle = deriveThreadTitle(file.name);
  const parsed = await parseWhatsAppExport(text, { threadId, threadTitle });

  if (parsed.ambiguous) {
    return {
      hash,
      skip: {
        path: file.rel,
        reason:
          "this WhatsApp export's dates could not be safely resolved (day/month order is " +
          "ambiguous and the chat is too short or too regular to tell from ordering alone). " +
          "Refusing to guess rather than risk silently mis-dating every message. Check what " +
          "regional date format the exporting phone uses, or export a longer history.",
      },
    };
  }
  if (!parsed.rows.length) {
    return {
      hash,
      skip: {
        path: file.rel,
        reason: `no addressable messages found (${parsed.skippedMedia} media placeholder(s), ` +
          `${parsed.skippedSystem} system notice(s) skipped)`,
      },
    };
  }

  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const envelopes = [];
  for (const row of parsed.rows) envelopes.push(...sessionizer.push(row));
  envelopes.push(...sessionizer.finish());

  return {
    hash,
    envelopes: declareFamily(envelopes, sourceFileFamilyUid(file, sourceName)),
    ...(parsed.skippedMedia
      ? {
          note: `${parsed.skippedMedia} media or deleted-message placeholder(s) were not represented`,
          incomplete: true,
        }
      : {}),
  };
}

/**
 * One SMS Backup & Restore .xml file, many documents. Unlike a WhatsApp
 * export, one file here usually holds EVERY conversation, not just one;
 * message-session.mjs's per-thread session tracking handles the interleaved
 * result correctly as long as rows arrive in overall chronological order,
 * which parseSmsBackupXml already guarantees by sorting.
 */
function prepareSmsBackupXml(file, buf, hash, { sourceName }) {
  const text = decodeText(buf);
  // A customer may load several overlapping phone-backup snapshots. Include
  // the export file identity in every thread id so two files cannot generate
  // the same document uid and silently overwrite each other's family.
  const parsed = parseSmsBackupXml(text, {
    sourceLabel: sourceFileFamilyUid(file, sourceName),
  });

  if (!parsed.rows.length) {
    return {
      hash,
      skip: {
        path: file.rel,
        reason: `no addressable SMS messages found (${parsed.skippedEmpty} empty/unreadable, ` +
          `${parsed.skippedMms} MMS entries not parsed by this version)`,
      },
    };
  }

  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const envelopes = [];
  for (const row of parsed.rows) envelopes.push(...sessionizer.push(row));
  envelopes.push(...sessionizer.finish());
  const omissions = parsed.skippedEmpty + parsed.skippedMms;
  const integrityNotes = [
    !parsed.rootClosed ? "the export ended before </smses>" : null,
    parsed.malformed ? `${parsed.malformed} malformed SMS entr${parsed.malformed === 1 ? "y was" : "ies were"} detected` : null,
    parsed.countMismatch
      ? `the export declared ${parsed.declaredCount} entries but ${parsed.entriesSeen} were present`
      : null,
  ].filter(Boolean);
  return {
    hash,
    envelopes: declareFamily(envelopes, sourceFileFamilyUid(file, sourceName)),
    ...(omissions || parsed.incomplete
      ? {
          note: `${parsed.skippedEmpty} empty or unreadable SMS entr${parsed.skippedEmpty === 1 ? "y" : "ies"} and ` +
            `${parsed.skippedMms} MMS entr${parsed.skippedMms === 1 ? "y was" : "ies were"} not represented` +
            (integrityNotes.length ? `; ${integrityNotes.join("; ")}` : ""),
          incomplete: true,
        }
      : {}),
  };
}

/** One Google Voice Takeout conversation page, many documents. */
function prepareGoogleVoiceTakeout(file, buf, hash, { sourceName }) {
  const text = decodeText(buf);
  const threadId = `${sourceName}:${file.rel.split(sep).join("/")}`;
  const threadTitle = deriveVoiceThreadTitle(file.name);
  const parsed = parseGoogleVoiceTakeout(text, { threadId, threadTitle });

  if (!parsed.rows.length) {
    return {
      hash,
      skip: {
        path: file.rel,
        reason: "no message text found in this Takeout page (likely a call or voicemail " +
          "record sharing the same export template, not a text conversation)",
      },
    };
  }

  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const envelopes = [];
  for (const row of parsed.rows) envelopes.push(...sessionizer.push(row));
  envelopes.push(...sessionizer.finish());
  return {
    hash,
    envelopes: declareFamily(envelopes, sourceFileFamilyUid(file, sourceName)),
    ...(parsed.skippedNonMessage
      ? {
          note: `${parsed.skippedNonMessage} call, voicemail, empty, or malformed entr${parsed.skippedNonMessage === 1 ? "y was" : "ies were"} not represented`,
          incomplete: true,
        }
      : {}),
  };
}

/** One Meta Download Your Information thread file, many bounded sessions. */
function prepareFacebookMessengerExport(file, buf, hash, { sourceName }) {
  const text = decodeText(buf);
  const fallbackThreadId = file.rel.split(sep).join("/");
  const parsed = parseFacebookMessengerExport(text, { sourceLabel: sourceName, fallbackThreadId });
  if (parsed.error || !parsed.rows.length) {
    return {
      hash,
      skip: {
        path: file.rel,
        reason: parsed.error ||
          `no addressable Messenger text found (${parsed.skippedMedia} attachment-only, ` +
          `${parsed.skippedUnavailable} unavailable/unsent, ${parsed.skippedMalformed} malformed)`,
      },
    };
  }
  const sessionizer = new MessageSessionizer({ groupingTimezone: "UTC" });
  const envelopes = [];
  for (const row of parsed.rows) envelopes.push(...sessionizer.push(row));
  envelopes.push(...sessionizer.finish());
  return {
    hash,
    envelopes: declareFamily(envelopes, sourceFileFamilyUid(file, sourceName)),
    note: [
      parsed.skippedMedia ? `${parsed.skippedMedia} attachment-only message(s) not represented` : null,
      parsed.skippedUnavailable ? `${parsed.skippedUnavailable} unavailable or unsent message(s) not represented` : null,
      parsed.skippedMalformed ? `${parsed.skippedMalformed} malformed message(s) not represented` : null,
    ].filter(Boolean).join("; ") || null,
    ...(parsed.skippedMedia || parsed.skippedUnavailable || parsed.skippedMalformed
      ? { incomplete: true }
      : {}),
  };
}

/** One LinkedIn account-owner export ZIP, one document per recognized CSV. */
function prepareLinkedInExport(file, buf, hash, { sourceName }) {
  const parsed = parseLinkedInArchive(buf, { sourceName, archivePath: file.rel });
  if (parsed.error || !parsed.envelopes.length) {
    return {
      hash,
      skip: { path: file.rel, reason: parsed.error || "the LinkedIn export contains no readable data rows" },
    };
  }
  const omittedRows = parsed.envelopes.reduce(
    (total, envelope) => total + Math.max(0, Number(envelope?.metadata?.omitted_row_count || 0)),
    0,
  );
  const notes = [
    parsed.skipped.length
      ? `${parsed.skipped.length} recognized LinkedIn CSV file(s) were empty or unreadable`
      : null,
    omittedRows ? `${omittedRows} LinkedIn row(s) beyond the per-file limit were not represented` : null,
  ].filter(Boolean);
  return {
    hash,
    envelopes: declareFamily(parsed.envelopes, sourceFileFamilyUid(file, sourceName)),
    note: notes.join("; ") || null,
    ...(parsed.skipped.length || omittedRows ? { incomplete: true } : {}),
  };
}

/**
 * One mail archive, many documents.
 *
 * An mbox indexed whole is one enormous document dated by whichever message
 * happened to come first, and every citation into it points at a filename
 * instead of a message. Splitting it is what makes "export to .mbox and load
 * the folder" a real answer rather than a shape of one.
 *
 * Every message goes through the SAME `.eml` reader the single-message path
 * uses, so nothing about MIME, encoded subjects or multipart bodies is decided
 * twice.
 */
async function prepareMboxArchive(file, { sourceName, scanBytes }) {
  const splitter = new MboxStreamSplitter({
    maxScanBytes: scanBytes,
    maxMessageBytes: MAX_MBOX_MESSAGE_BYTES,
  });
  const hasher = createHash("sha256");
  const relPath = file.rel.split(sep).join("/");
  const envelopes = [];
  let unreadable = 0;
  let oversized = 0;

  const accept = async (item) => {
    if (item.oversized) {
      oversized++;
      return;
    }
    let parsed;
    try {
      parsed = await parseEmailMessage(item.message);
    } catch {
      unreadable++;
      return;
    }
    const text = parsed.error ? "" : String(parsed.text || "").trim();
    // The same floor every other document clears. A message that is only
    // headers is not worth an embedding and would dilute the ones that are.
    if (!textQuality(text).ok) {
      unreadable++;
      return;
    }
    const key = mboxMessageKey(relPath, parsed.messageId, item.ordinal);
    envelopes.push({
      source_type: sourceName,
      source_id: key,
      title: parsed.subject || `Message ${item.ordinal} from ${basename(file.name)}`,
      content: text,
      // The message's own Date header, which is the one date about an email
      // that is neither a guess nor a filesystem artefact.
      occurred_at: parsed.occurredAt,
      date_source: parsed.occurredAt ? "mbox:date_header" : "none",
      date_reliable: !!parsed.occurredAt,
      uri: key,
      metadata: {
        category: sourceName,
        extracted_as: "email",
        archive: relPath,
        message_number: item.ordinal,
        ...(parsed.from ? { sender: parsed.from } : {}),
      },
    });
  };

  // Every byte contributes to the resume hash, including bytes beyond the
  // bounded parsing window. A same-size edit late in a large archive therefore
  // cannot reuse stale `done` state. The splitter itself retains at most one
  // bounded message plus the accepted envelopes, never the raw archive.
  for (const chunk of streamApprovedLocalFile(file)) {
    hasher.update(chunk);
    for (const item of splitter.push(chunk)) await accept(item);
  }
  for (const item of splitter.finish()) await accept(item);

  const hash = hasher.digest("hex");
  const stats = splitter.stats;
  const incomplete = unreadable > 0 || oversized > 0 || stats.truncated;

  if (!envelopes.length) {
    let reason;
    if (stats.truncated) {
      reason =
        `no complete readable message was found inside the first ${(scanBytes / 1048576).toFixed(0)}MB ` +
        "of this mail archive; later bytes were not indexed";
    } else if (!stats.separatorLines) {
      reason = "this .mbox file has no message separator line in it, so it is not a mail archive";
    } else {
      reason = `none of the ${stats.messageCount} message(s) in this mail archive could be read`;
    }
    return {
      hash,
      skip: {
        path: file.rel,
        reason,
      },
      ...(incomplete ? { incomplete: true } : {}),
    };
  }

  const note = [
    `${envelopes.length} message(s) loaded from this archive`,
    unreadable ? `${unreadable} complete message(s) could not be read` : null,
    oversized
      ? `${oversized} message(s) exceeded the ${(MAX_MBOX_MESSAGE_BYTES / 1048576).toFixed(0)}MB per-message limit`
      : null,
    stats.truncated
      ? `only complete messages ending inside the first ${(scanBytes / 1048576).toFixed(0)}MB were considered; later messages were not indexed`
      : null,
  ].filter(Boolean).join("; ");

  const prepared = incomplete
    ? envelopes.map((envelope) => ({
      ...envelope,
      metadata: { ...envelope.metadata, extraction_incomplete: true },
    }))
    : envelopes;
  return {
    hash,
    // Every OTHER multi-document producer stamps its family here, and this one
    // did not. That is not a cosmetic omission: cmdIngestLocal hard-throws when
    // a multi-envelope result carries no declaration, so a single .mbox
    // anywhere under an ingested folder aborted the WHOLE run, dry run
    // included, and took every unrelated file in that folder with it.
    envelopes: declareFamily(prepared, sourceFileFamilyUid(file, sourceName)),
    note,
    ...(incomplete ? { incomplete: true } : {}),
  };
}

/**
 * What this source loaded before and can no longer find.
 *
 * A scheduled folder lane has to answer for deletions or it is not a mirror of
 * the folder, it is an append-only pile that quietly disagrees with the client
 * about what exists. Kept as a pure function of two sets so the decision can
 * be tested without a network, and so the caller can put the result through
 * the same removal-plan guard every other source's deletions go through.
 *
 * `present` must include files the walk SKIPPED as well as the ones it
 * accepted. A file that is still on disk but was skipped this run for being
 * empty, oversized or private has not vanished, and removing its document
 * because a reason changed is a different decision with a different name.
 */
export function removedSinceLastRun(knownKeys, present) {
  const here = present instanceof Set ? present : new Set(present || []);
  return [...(knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []))]
    .filter((key) => !here.has(key))
    .sort();
}

/**
 * Read one file and turn it into an ingest envelope, or into a reasoned skip.
 */
export async function prepare(file, { sourceName, ocr = null }) {
  const ext = extensionOf(file.name);

  // Local mbox archives are admitted independently of their total size. The
  // stream reader hashes every byte for resume integrity while the parser keeps
  // only complete messages inside a bounded window. Do this before the generic
  // whole-file read, otherwise the old 64MB allocation/refusal path still wins.
  if (ext === ".mbox") {
    const scanBytes = Number.isSafeInteger(file?.mboxScanBytes) && file.mboxScanBytes > 0
      ? file.mboxScanBytes
      : MAX_ARCHIVE_BYTES;
    try {
      return await prepareMboxArchive(file, { sourceName, scanBytes });
    } catch (error) {
      return { skip: { path: file.rel, reason: localFileSafetyReason(error) } };
    }
  }

  let buf;
  const sizeLimit = Number.isSafeInteger(file?.sizeLimit)
    ? file.sizeLimit
    : fileSizeLimitFor(file?.name, MAX_FILE_BYTES, MAX_ARCHIVE_BYTES);
  try {
    buf = readApprovedLocalFile(file, { maxBytes: sizeLimit });
  } catch (e) {
    return { skip: { path: file.rel, reason: localFileSafetyReason(e) } };
  }
  let hash = sha(buf);
  let actualBytes = buf.length;

  // Content-sniffed, not extension-alone: most files with these extensions
  // are not a message export, and the ordinary extractor below is exactly
  // right for them. Only a file that actually looks like one of these three
  // shapes routes to its own sessionizing parser.
  if (ext === ".txt" && !isLikelyBinary(buf)) {
    const peek = decodeText(buf);
    if (detectWhatsAppExport(peek)) {
      return prepareWhatsAppExport(file, buf, hash, { sourceName });
    }
  }
  if (ext === ".xml" && !isLikelyBinary(buf)) {
    const peek = decodeText(buf);
    if (detectSmsBackupXml(peek)) {
      return prepareSmsBackupXml(file, buf, hash, { sourceName });
    }
  }
  if ((ext === ".html" || ext === ".htm") && !isLikelyBinary(buf)) {
    const peek = decodeText(buf);
    if (detectGoogleVoiceTakeout(peek)) {
      return prepareGoogleVoiceTakeout(file, buf, hash, { sourceName });
    }
  }
  if (ext === ".json" && !isLikelyBinary(buf)) {
    const peek = decodeText(buf);
    if (detectFacebookMessengerExport(peek)) {
      return prepareFacebookMessengerExport(file, buf, hash, { sourceName });
    }
  }

  // LinkedIn's supported path is the account owner's Download Your Data ZIP.
  // Every ZIP is safety-validated here; an unrelated ZIP receives an explicit
  // "no recognized LinkedIn CSV" outcome rather than a generic binary skip.
  if (ext === ".zip") {
    return prepareLinkedInExport(file, buf, hash, { sourceName });
  }

  if (!canExtract(file.name)) {
    return { hash, skip: { path: file.rel, reason: `no extractor for "${extensionOf(file.name) || "(no extension)"}" files` } };
  }
  // Checked on raw bytes, before any decode: decoding binary as UTF-8 yields
  // replacement characters that then read as ordinary text.
  //
  // Skipped for formats that are legitimately binary containers (PDF, the OOXML
  // family, .xls). Their extractors take bytes by design, and applying this
  // guard to them rejects every PDF and Word document in a corpus with a reason
  // that is technically true and completely unhelpful.
  if (!isBinaryFormat(file.name) && isLikelyBinary(buf)) {
    return { hash, skip: { path: file.rel, reason: "the file is binary, not text" } };
  }

  // The reread callback exists for cloud-synced folders: see the PDF extractor
  // for why an empty first pass is not proof of an empty document.
  const got = await extract(buf, file.name, {
    reread: () => {
      try {
        const reread = readApprovedLocalFile(file, { maxBytes: sizeLimit });
        hash = sha(reread);
        actualBytes = reread.length;
        return reread;
      } catch {
        return null;
      }
    },
    // Null on a dry run and whenever OCR is off, so the cheapest command stays
    // the cheapest command and nothing bills the owner without being asked.
    ocr,
  });
  if (got.error || got.text == null) {
    return { hash, skip: { path: file.rel, reason: got.error || "extraction produced nothing" } };
  }

  const q = textQuality(got.text);
  if (!q.ok) return { hash, skip: { path: file.rel, reason: q.reason, metrics: q.metrics } };

  // A format that extracted something but wants to flag it (a mostly-image PDF,
  // a truncated sheet) is reported alongside the document, not instead of it.
  const note = got.note || null;

  // NOT the file mtime. See ingest/doc-date.mjs for why that is refused outright.
  const dd = documentDate({ filename: file.name, relPath: dirname(file.rel), contentHead: got.text.slice(0, 1200) });

  return {
    hash,
    envelope: {
      source_type: sourceName,
      source_id: file.rel.split(sep).join("/"),
      title: basename(file.name, extensionOf(file.name)) || file.name,
      content: got.text,
      occurred_at: dd.value ? new Date(dd.value).toISOString() : null,
      date_source: dd.source,
      date_reliable: dd.reliable,
      uri: file.rel.split(sep).join("/"),
      // Promoted out of metadata on purpose: these two reach a citation, and a
      // flag that never reaches the reader is not a flag.
      ...(got.provenance
        ? { text_source: got.provenance.text_source, text_reliable: got.provenance.text_reliable }
        : {}),
      metadata: {
        category: sourceName, extracted_as: got.how, bytes: actualBytes,
        ...(note ? { extraction_note: note } : {}),
        ...(got.incomplete === true ? { extraction_incomplete: true } : {}),
        ...(got.provenance ? { ocr: got.provenance } : {}),
      },
    },
    note,
    ...(got.incomplete === true ? { incomplete: true } : {}),
  };
}

/**
 * Extract and emit batches as they fill, instead of building the whole corpus
 * in memory first.
 *
 * THE MEASUREMENT THAT FORCED THIS
 *
 * 250 extractable files held 18.3M characters and grew RSS by 584MB. The same
 * corpus has 3,646 extractable files, projecting ~540MB of live string data
 * before the first byte is sent. At the tens-of-thousands scale a real client
 * has, it is several gigabytes: past V8's default old space on a laptop, where
 * it dies with a raw heap-limit abort that no error handler can catch.
 *
 * The second failure was quieter and just as bad. Resume state is only written
 * after a batch is SENT, so an interrupt during the extraction phase threw away
 * every minute of work and restarted from zero, while the module header
 * promised that a re-run "skips what already landed".
 *
 * Streaming fixes both: peak memory is one batch, progress is continuous
 * instead of a long silence, and an interrupt costs at most one batch.
 */
export async function* batchStream(files, prepareOne, { maxDocs = 50, maxBytes = 900_000, maxStatements = 810, onSkip, onProgress } = {}) {
  let cur = [];
  let bytes = 0;
  let statements = 0;
  let scanned = 0;

  // `for await` also accepts ordinary arrays. Remote connectors can therefore
  // feed a paginated async iterator without first collecting every Drive file
  // or Gmail id, while the local walker keeps using the exact same path.
  for await (const f of files) {
    scanned++;
    const r = await prepareOne(f);
    if (onProgress) onProgress(scanned, f);
    if (!r) continue;
    if (r.skip) {
      if (onSkip) onSkip(r.skip);
      continue;
    }
    if (r.unchanged) continue;

    // A remote producer may need the split count before anything is sent so it
    // can reconcile an old document family safely. Let it supply the one-file
    // split rather than doing the same large string slicing twice.
    const envelopes = r.envelopes || splitOversized(r.envelope);
    const { envelope: _envelope, envelopes: _envelopes, unchanged: _unchanged, skip: _skip, ...context } = r;
    for (const envelope of envelopes) {
      const n = envelopeBytes(envelope);
      // Same statement ceiling as batches(): the worker refuses any batch
      // whose conservative D1 estimate exceeds its budget, and chunk weight
      // is invisible to document count and bytes. This loop is the one the
      // Drive and Gmail connectors stream through — the first fix landed
      // only in batches() and the very next Drive catch-up refused again.
      const stmts = estimatedStatements(envelope);
      if (cur.length && (cur.length >= maxDocs || bytes + n > maxBytes || statements + stmts > maxStatements)) {
        yield cur;
        cur = [];
        bytes = 0;
        statements = 0;
      }
      // Preserve connector bookkeeping such as stateKey, deferState and the
      // family plan. The previous fixed three-field wrapper silently discarded
      // those fields, which made the streaming helper unsafe for remote resume.
      cur.push({ ...context, envelope });
      bytes += n;
      statements += stmts;
    }
  }
  if (cur.length) yield cur;
}

export function loadState(path) {
  if (!existsSync(path)) return { version: 1, done: {}, skipped: {} };
  try {
    const s = JSON.parse(readFileSync(path, "utf-8"));
    return s && s.done ? s : { version: 1, done: {}, skipped: {} };
  } catch {
    // A corrupt state file must not abort a load. Starting over costs time;
    // refusing to run costs the whole import.
    return { version: 1, done: {}, skipped: {} };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  // The Drive state contains private file ids, names, folder paths and the
  // incremental cursor. Keep it owner-only, and replace it atomically so a
  // crash or laptop sleep cannot leave half-written JSON that silently forces
  // the next run back to a full walk.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    // rename preserves the temp file's mode. chmod also repairs an older state
    // file that may have been created by the pre-hardening implementation.
    chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* original error wins */ }
    throw error;
  }
}
