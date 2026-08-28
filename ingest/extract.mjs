/**
 * Turn a file into text worth embedding.
 *
 * TIERED ON PURPOSE. Everything here needs ZERO dependencies, because this runs
 * on the client's own machine during a live install and every package is one
 * more thing that can fail on their Windows box while someone watches. Heavier
 * formats (PDF, .docx, .xlsx) register themselves through `register()` when the
 * optional extras are installed, so the core path never depends on them.
 *
 * An unsupported format is REPORTED, never silently skipped. A client whose
 * 12,000 PDFs were quietly ignored has a brain that confidently knows nothing
 * about them, which is the failure this whole product exists to avoid.
 */

import { stripMarkup, utf16Encoding } from "./quality.mjs";
// The one transcript reader in this product. It lives beside the client
// worker because the Zoom connector runs inside that worker and uses the same
// function; a second copy here would drift from it silently.
import { vttToPlainTranscript, srtToPlainTranscript, hasTimedCues } from "../worker/src/lib/vtt.js";

const registry = new Map();

/** Add support for an extension. Used by the optional format packs. */
export function register(ext, fn, label, { binary = false } = {}) {
  registry.set(ext.toLowerCase(), { fn, label: label || ext, binary });
}

/**
 * Is this format a binary container?
 *
 * PDF, the OOXML formats and legacy .xls are all binary by design, so the
 * caller's "does this look like binary junk" guard must NOT be applied to them.
 * Running it anyway rejects every PDF and Word document in a corpus with the
 * reason "the file is binary, not text", which is both true and useless.
 */
export function isBinaryFormat(name) {
  return !!registry.get(extensionOf(name))?.binary;
}

export function supported() {
  return [...registry.keys()].sort();
}

/**
 * Decode with the file's ACTUAL encoding, not an assumed one.
 *
 * Detecting UTF-16 as text and then decoding it as UTF-8 trades one silent
 * failure for a worse one: instead of being skipped with a wrong reason, the
 * file is indexed as unreadable mojibake that pollutes retrieval and looks like
 * a successful ingest.
 */
const dec = (buf) => {
  const enc = utf16Encoding(buf) || "utf-8";
  const text = new TextDecoder(enc, { fatal: false }).decode(buf);
  // Strip a byte order mark; it is invisible in a terminal and breaks a leading
  // keyword match.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

/* ------------------------------------------------------------------ plain */

for (const ext of [".txt", ".md", ".markdown", ".text", ".log", ".rst", ".adoc"]) {
  register(ext, (buf) => dec(buf), "plain text");
}

for (const ext of [".html", ".htm", ".xhtml"]) {
  register(ext, (buf) => stripMarkup(dec(buf)), "html");
}

register(".xml", (buf) => stripMarkup(dec(buf)), "xml");

/* -------------------------------------------------------------- delimited */

/**
 * A spreadsheet exported as CSV is the format most often ruined by naive
 * ingestion. A raw grid of numbers embeds terribly: "15234.11" carries no
 * meaning without its column, so a question like "what was the checking balance
 * in March" matches nothing.
 *
 * So each row is rendered as "Header: value" pairs. It is more verbose, and it
 * is the difference between a retrievable row and a line of digits.
 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(cell); cell = ""; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (c === "\r") continue;
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Ceiling on rows rendered. A 200,000-row export is a database, not a document,
// and rendering all of it would produce a chunk count nobody wants to pay to
// embed. The cap is stated in the output so the truncation is visible.
const MAX_ROWS = 5000;

export function renderTable(rows, { label = "" } = {}) {
  if (!rows.length) return "";
  const header = rows[0].map((h) => String(h).trim());
  const looksLikeHeader = header.some((h) => h && !/^-?[\d.,$%()]+$/.test(h));
  const body = looksLikeHeader ? rows.slice(1) : rows;
  const out = [];
  if (label) out.push(label);

  const shown = body.slice(0, MAX_ROWS);
  for (const r of shown) {
    if (!r.some((c) => String(c).trim())) continue;
    const pairs = r
      .map((c, i) => {
        const v = String(c).trim();
        if (!v) return null;
        const h = looksLikeHeader ? header[i] : null;
        return h ? `${h}: ${v}` : v;
      })
      .filter(Boolean);
    if (pairs.length) out.push(pairs.join(" | "));
  }
  if (body.length > shown.length) {
    out.push(`[${body.length - shown.length} further rows were not indexed; this file exceeds the ${MAX_ROWS} row limit]`);
  }
  return out.join("\n");
}

register(".csv", (buf, { name } = {}) => renderTable(parseDelimited(dec(buf), ","), { label: name ? `Table: ${name}` : "" }), "csv");
register(".tsv", (buf, { name } = {}) => renderTable(parseDelimited(dec(buf), "\t"), { label: name ? `Table: ${name}` : "" }), "tsv");

/* ------------------------------------------------------------------- json */

/**
 * JSON is flattened to "path: value" lines rather than pretty-printed, because
 * braces and brackets embed as noise while the leaf paths carry the meaning.
 */
register(".json", (buf) => {
  const raw = dec(buf);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  const lines = [];
  const walk = (v, path) => {
    if (lines.length > 20000) return;
    if (v === null || typeof v !== "object") { lines.push(`${path}: ${String(v)}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(parsed, "");
  return lines.join("\n");
}, "json");

/* ------------------------------------------------------------ transcripts */

/**
 * Meeting transcripts and subtitles.
 *
 * The onboarding documentation has been telling clients that the way to bring
 * an old call in is to save its `.vtt` transcript into a folder that is
 * already ingested. Until this registration existed that was false: the file
 * was skipped for having no extractor, and the client's Zoom backfill silently
 * never happened. Registering it here, in the dependency-free core, is what
 * makes the sentence true — and makes it true for the Drive door too, which
 * decides what to fetch from this same registry.
 *
 * The conversion is `worker/src/lib/vtt.js`, the SAME function the Zoom
 * connector uses on the transcripts Zoom delivers, so a call saved by hand and
 * a call delivered by webhook read identically.
 */
for (const [ext, toText, label] of [
  [".vtt", vttToPlainTranscript, "transcript"],
  [".srt", srtToPlainTranscript, "subtitles"],
]) {
  register(ext, (buf) => {
    const raw = dec(buf);
    if (!hasTimedCues(raw)) {
      return {
        text: null,
        error: `this ${ext} file contains no timed captions, so it is not a transcript this can read`,
      };
    }
    const text = toText(raw);
    if (!text.trim()) {
      return { text: null, error: `the ${ext} file has caption timings but no caption text` };
    }
    return { text };
  }, label);
}

/* -------------------------------------------------------------- calendars */

/**
 * A calendar export, rendered by the calendar connector's own renderer.
 *
 * Imported lazily so a folder with no .ics in it never loads the connector.
 */
register(".ics", async (buf, { name } = {}) => {
  const raw = dec(buf);
  const { parseIcs, MAX_EVENTS } = await import("./ics.mjs");
  const { isCalendar, events, malformed, calendarName } = parseIcs(raw);
  if (!isCalendar) return { text: null, error: "this .ics file is not an iCalendar document (no BEGIN:VCALENDAR)" };
  if (!events.length) {
    return {
      text: null,
      error: malformed
        ? `no readable events: ${malformed} calendar entr${malformed === 1 ? "y is" : "ies are"} missing a start time or truncated`
        : "this calendar has no events in it (it may hold only tasks, free/busy blocks or timezone definitions)",
    };
  }
  const { renderEvent } = await import("../connectors/google-calendar.mjs");
  const label = calendarName || name || "calendar";
  const shown = events.slice(0, MAX_EVENTS);
  const rendered = shown.map(({ event }) => renderEvent(event, { calendar: { id: label, key: label, label } }));
  const notes = [];
  if (events.length > shown.length) notes.push(`${events.length - shown.length} further event(s) were not indexed; this export exceeds the ${MAX_EVENTS} event limit`);
  if (malformed) notes.push(`${malformed} calendar entr${malformed === 1 ? "y" : "ies"} could not be read and ${malformed === 1 ? "was" : "were"} left out`);
  return {
    text: `Calendar export: ${label}\n\n${rendered.join("\n\n")}`,
    note: notes.length ? notes.join("; ") : undefined,
  };
}, "calendar");

/* ------------------------------------------------------------------- rtf */

register(".rtf", async (buf) => {
  const { rtfToText } = await import("./rtf.mjs");
  const text = rtfToText(dec(buf));
  if (text === null) return { text: null, error: "this .rtf file does not begin with an RTF header, so it is not rich text" };
  if (!text.trim()) return { text: null, error: "the .rtf file held no text outside its font, style and image tables" };
  return { text };
}, "rich text");

/* ----------------------------------------------------------- bank exports */

/**
 * OFX and QFX: the export every bank on earth already offers its own customer.
 *
 * The TEXT registered here is deliberately coarse — a period, a balance, and a
 * line per transaction — because a bank export read as prose answers almost
 * nothing. The FIGURES land in the structured ledger through
 * `worker/src/lib/fin-import.js`, where they can be added up and traced back to
 * this file. Registering the extension is what stops the file being skipped for
 * having no extractor, which is the silent failure this registry exists to end.
 *
 * Imported lazily so a folder with no bank export in it never loads the reader.
 */
for (const ext of [".ofx", ".qfx"]) {
  register(ext, async (buf, { name } = {}) => {
    const { readBankExport, renderBankExportText } = await import("./bank-export.mjs");
    const envelope = readBankExport(buf, { name });
    if (!envelope.ok) return { text: null, error: envelope.refusal };
    const text = renderBankExportText(envelope);
    if (!text.trim()) return { text: null, error: `this ${ext} file holds no readable transactions` };
    const unreadable = envelope.accounts
      .reduce((total, account) => total + account.transactions.filter((t) => t.unparsedReason).length, 0);
    // The prose is all this path produces, and saying so is the difference
    // between an operator who knows the figures are not in the ledger and one
    // who assumes they are because the file loaded without complaint.
    const notes = [
      "the FIGURES in this export are not in the ledger; `brain import bank <manifest> --file <this file>` loads them",
    ];
    if (unreadable) {
      notes.unshift(`${unreadable} line(s) in this export could not be read and are recorded as unread rather than dropped`);
    }
    return { text, note: notes.join("; ") };
  }, "bank export");
}


/* -------------------------------------------------------------------- eml */

/**
 * Enough of RFC 822 to get the headers that matter and the plain-text body.
 * Correspondence is where intent lives, so the From/To/Date/Subject block is
 * kept as text: it is what someone actually searches for.
 */
register(".eml", (buf) => {
  const raw = dec(buf);
  const split = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  if (split < 0) return raw;
  const head = raw.slice(0, split);
  let body = raw.slice(split).trim();

  const keep = ["from", "to", "cc", "date", "subject"];
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m && keep.includes(m[1].toLowerCase())) headers.push(`${m[1]}: ${m[2]}`);
  }
  // Multipart: take the first text/plain part rather than indexing the MIME
  // scaffolding and the base64 attachments with it.
  const boundary = head.match(/boundary="?([^";\r\n]+)"?/i);
  if (boundary) {
    const parts = body.split(new RegExp(`--${boundary[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
    const chosen = plain || html;
    if (chosen) {
      const s = chosen.indexOf("\r\n\r\n") >= 0 ? chosen.indexOf("\r\n\r\n") : chosen.indexOf("\n\n");
      body = s >= 0 ? chosen.slice(s).trim() : chosen;
      if (!plain && html) body = stripMarkup(body);
    }
  }
  return [...headers, "", body].join("\n");
}, "email");

/* ------------------------------------------------------------------ entry */

export function extensionOf(name) {
  const i = String(name).lastIndexOf(".");
  return i < 0 ? "" : String(name).slice(i).toLowerCase();
}

export function canExtract(name) {
  return registry.has(extensionOf(name));
}

/**
 * ASYNC because PDF extraction is. Everything else stays synchronous internally;
 * awaiting a plain string costs nothing and keeps one call site for all formats.
 *
 * An extractor may also return { text, note } to report something true but
 * degraded — a scanned PDF, a truncated sheet — which the caller surfaces rather
 * than swallowing.
 *
 * @returns {Promise<{ text: string|null, how: string|null, unsupported?: true, error?: string, note?: string }>}
 */
export async function extract(buf, name, opts = {}) {
  const ext = extensionOf(name);
  const entry = registry.get(ext);
  if (!entry) return { text: null, how: null, unsupported: true, error: `no extractor for "${ext || "(no extension)"}"` };
  try {
    const out = await entry.fn(buf, { name, ...opts });
    if (out && typeof out === "object" && !Array.isArray(out)) {
      return { text: out.text ?? null, how: entry.label, note: out.note, error: out.error };
    }
    return { text: out, how: entry.label };
  } catch (e) {
    // A missing or broken format helper is systemic, not evidence that this one
    // document is bad. Let the source run fail so its cursor stays retryable;
    // otherwise every file of that format could be silently omitted at once.
    if (e?.fatal === true) throw e;
    return { text: null, how: entry.label, error: String(e.message || e).slice(0, 200) };
  }
}
