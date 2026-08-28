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
  readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync,
  renameSync, chmodSync, rmSync,
} from "node:fs";
import { join, relative, sep, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { extract, canExtract, extensionOf, isBinaryFormat } from "./extract.mjs";
import {
  MAX_DOC_CHARS, batches, envelopeBytes, splitOversized,
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
import { MessageSessionizer } from "./message-session.mjs";

// Preserve the original ingest/run.mjs API while letting migration-only code
// import the dependency-free boundary directly.
export { MAX_DOC_CHARS, batches, envelopeBytes, splitOversized };

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

export function walk(root, { privatePrefixes = [], maxBytes = MAX_FILE_BYTES } = {}) {
  const files = [];
  const skipped = [];
  let complete = true;
  const prefixes = privatePrefixes.map((p) => p.toLowerCase());

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
      let st;
      try { st = statSync(full); } catch (error) {
        skipped.push({ path: rel, reason: `file metadata could not be read: ${error.code || error.message}` });
        complete = false;
        continue;
      }
      if (st.size === 0) { skipped.push({ path: rel, reason: "file is empty" }); continue; }
      if (st.size > maxBytes) {
        skipped.push({ path: rel, reason: `file is ${(st.size / 1048576).toFixed(1)}MB, over the ${(maxBytes / 1048576).toFixed(0)}MB limit` });
        continue;
      }
      files.push({ full, rel, name: e.name, size: st.size });
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

  return { hash, envelopes };
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
  const parsed = parseSmsBackupXml(text, { sourceLabel: sourceName });

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
  return { hash, envelopes };
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
  return { hash, envelopes };
}

/**
 * Read one file and turn it into an ingest envelope, or into a reasoned skip.
 */
export async function prepare(file, { sourceName }) {
  let buf;
  try {
    buf = readFileSync(file.full);
  } catch (e) {
    return { skip: { path: file.rel, reason: `could not read the file: ${e.code || e.message}` } };
  }
  const hash = sha(buf);
  const ext = extensionOf(file.name);

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
      try { return readFileSync(file.full); } catch { return null; }
    },
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
      metadata: { category: sourceName, extracted_as: got.how, bytes: file.size, ...(note ? { extraction_note: note } : {}) },
    },
    note,
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
export async function* batchStream(files, prepareOne, { maxDocs = 50, maxBytes = 900_000, onSkip, onProgress } = {}) {
  let cur = [];
  let bytes = 0;
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
      if (cur.length && (cur.length >= maxDocs || bytes + n > maxBytes)) {
        yield cur;
        cur = [];
        bytes = 0;
      }
      // Preserve connector bookkeeping such as stateKey, deferState and the
      // family plan. The previous fixed three-field wrapper silently discarded
      // those fields, which made the streaming helper unsafe for remote resume.
      cur.push({ ...context, envelope });
      bytes += n;
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
