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

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, sep, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { extract, canExtract, extensionOf, isBinaryFormat } from "./extract.mjs";
// Side-effect import: registers pdf/docx/xlsx/pptx/eml and pulls in their
// dependencies. Importing it here rather than in extract.mjs keeps the core
// registry honestly dependency-free.
import "./formats.mjs";
import { textQuality, isLikelyBinary } from "./quality.mjs";
import { documentDate } from "./doc-date.mjs";

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
      try { st = statSync(full); } catch { continue; }
      if (st.size === 0) { skipped.push({ path: rel, reason: "file is empty" }); continue; }
      if (st.size > maxBytes) {
        skipped.push({ path: rel, reason: `file is ${(st.size / 1048576).toFixed(1)}MB, over the ${(maxBytes / 1048576).toFixed(0)}MB limit` });
        continue;
      }
      files.push({ full, rel, name: e.name, size: st.size });
    }
  };

  visit(root);
  return { files, skipped };
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

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
 * A document larger than one request must be split, not sent whole.
 *
 * The Worker caps a batch at 1MB, and it caps it for a real reason: chunking and
 * hashing a huge payload exceeds the CPU budget and the request is killed
 * mid-flight. Sending an oversized document anyway produced a 413 and lost the
 * document with a confusing error, which is the worst of both outcomes.
 *
 * Parts keep the original identity in their ids ("path#part2of3") so a citation
 * still points at the real file, and each part is chunked and retrievable
 * normally. The cost is that a passage spanning a part boundary is only found
 * from one side, which is a far smaller loss than the whole document.
 */
export const MAX_DOC_CHARS = 400_000;

export function splitOversized(envelope, maxChars = MAX_DOC_CHARS) {
  const text = envelope.content || "";
  // Characters are the slicing unit but BYTES are the constraint, so a corpus
  // where one character costs three bytes has to split proportionally harder.
  // Without this a single CJK document can clear the character budget and still
  // exceed the Worker's byte cap on its own, which no amount of batching fixes.
  const bytes = Buffer.byteLength(text, "utf8");
  const ratio = text.length ? bytes / text.length : 1;
  const effective = ratio > 1.05 ? Math.max(20_000, Math.floor(maxChars / ratio)) : maxChars;
  if (bytes <= effective * ratio && text.length <= effective) return [envelope];

  const parts = [];
  for (let i = 0; i < text.length; i += effective) parts.push(text.slice(i, i + effective));

  return parts.map((content, i) => ({
    ...envelope,
    source_id: `${envelope.source_id}#part${i + 1}of${parts.length}`,
    title: `${envelope.title || envelope.source_id} (part ${i + 1} of ${parts.length})`,
    content,
    metadata: {
      ...(envelope.metadata || {}),
      part: i + 1,
      part_count: parts.length,
      part_of: envelope.source_id,
    },
  }));
}

/**
 * The Worker caps a request in BYTES. Budgeting in characters is not the same
 * measurement, and the gap is not academic: three Japanese documents totalling
 * 810,000 characters serialise to 2.32 MB and are refused 413 by a 1 MB cap.
 *
 * Worse than the failure is what follows it. The client is told "fix the cause
 * and re-run", and the re-run deterministically rebuilds the identical
 * oversized batch and dies in the same place, forever, with nothing they can
 * actually fix. Any accented European text, CJK, emoji, or simply a lot of
 * escaped newlines and quotes gets there.
 */
export function envelopeBytes(envelope) {
  // Measure the JSON that actually goes on the wire, not just the content:
  // escaping, titles and metadata are all real bytes.
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

/** Group envelopes so no request exceeds what the Worker will accept. */
export function batches(items, { maxDocs = 50, maxBytes = 900_000 } = {}) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    const n = envelopeBytes(it.envelope);
    if (cur.length && (cur.length >= maxDocs || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
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

  for (const f of files) {
    scanned++;
    const r = await prepareOne(f);
    if (onProgress) onProgress(scanned, f);
    if (!r) continue;
    if (r.skip) {
      if (onSkip) onSkip(r.skip);
      continue;
    }
    if (r.unchanged) continue;

    for (const envelope of splitOversized(r.envelope)) {
      const n = envelopeBytes(envelope);
      if (cur.length && (cur.length >= maxDocs || bytes + n > maxBytes)) {
        yield cur;
        cur = [];
        bytes = 0;
      }
      cur.push({ hash: r.hash, envelope, rel: r.rel });
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
  writeFileSync(path, JSON.stringify(state, null, 2));
}
