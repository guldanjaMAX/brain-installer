/**
 * WhatsApp's built-in per-chat "Export chat" (.txt) as a message source.
 *
 * v0, not the live bridge. No pairing, no daemon, no ToS exposure: the client
 * exports a chat from their own phone, drops the .txt file in a folder, and
 * `brain ingest` loads it like any other document, except that one export
 * file becomes MANY sessionized conversation documents (via
 * ingest/message-session.mjs) instead of one text blob. Live capture is a
 * separate, later package (WP-07 in the connector plan); this is what covers
 * "all my partnerships are on WhatsApp" on install day.
 *
 * THE CLASSIC EXPORT CORRUPTION, HANDLED RATHER THAN GUESSED AT
 *
 * WhatsApp writes the timestamp in whatever date order the EXPORTING PHONE's
 * locale uses, with no format marker anywhere in the file. "3/4/26" is March
 * 4th on a US phone and April 3rd on very nearly every other phone in the
 * world, and guessing wrong does not raise an error: it silently shifts an
 * entire chat's timestamps by weeks or months, and nothing downstream would
 * ever notice.
 *
 * A chat is inherently chronological (WhatsApp writes it out in the order the
 * messages happened), and that fact is enough to resolve most real exports
 * without guessing: try reading every date as D/M, try reading every date as
 * M/D, and keep whichever reading produces a non-decreasing timestamp
 * sequence across the WHOLE file. When a reading is invalid outright (a
 * "month" over 12), it fails immediately and the other one wins on its own.
 * When a chat is short enough, or every date in it happens to fall in the
 * first 12 days of the month, BOTH readings can look internally consistent —
 * there is no way to tell from the data alone which one is real, so this
 * refuses to assign absolute dates at all rather than pick one, and reports
 * `date_format_ambiguous` so a human resolves it (usually: what does the
 * exporting phone's regional format setting actually say).
 *
 * WHAT THIS DOES NOT HANDLE (v0 scope, stated plainly rather than silently)
 *
 * - .zip exports (chat plus media) are not unpacked. Export "without media"
 *   for now; a zip is out of scope for this pass and refused by the normal
 *   extension gate, not silently misread.
 * - Reaction-only export lines (a newer WhatsApp feature on some versions)
 *   are not specifically recognised; if a phone's export format ever prints
 *   one as its own line with no attached text, it is scanned like an
 *   ordinary short message rather than being suppressed. Media placeholders,
 *   deletions, and system/group notices ARE recognised and skipped.
 */

import { createHash } from "node:crypto";

const LRM_RLM = /[\u200E\u200F]/g;

// Bracketed (iOS): "[3/4/26, 10:15:32 AM] John Doe: text" or 24h, no seconds.
const BRACKETED_RE =
  /^\[(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AaPp][Mm])\.?)?\]\s?(.*)$/;

// Unbracketed (Android): "3/4/26, 10:15 - John Doe: text", comma optional.
const UNBRACKETED_RE =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AaPp][Mm])\.?)?\s+-\s+(.*)$/;

// A real message line, once the header is stripped, reads "Name: body". A
// system/group notice ("X added Y", "Messages are encrypted...") has no such
// colon-separated name and is treated as a non-message timestamp sample.
const NAME_BODY_RE = /^([^\n:]{1,80}?):[ \u00A0]?(.*)$/su;

const MEDIA_PLACEHOLDER_RE = new RegExp(
  "^(?:" +
    [
      "<Media omitted>",
      "image omitted", "video omitted", "audio omitted",
      "GIF omitted", "sticker omitted", "document omitted",
      "Contact card omitted",
      "This message was deleted", "You deleted this message",
    ].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
  ")$",
  "i",
);

function stripInvisible(text) {
  return String(text).replace(LRM_RLM, "");
}

/** One export line into its raw, not-yet-disambiguated header fields. */
function matchHeader(line) {
  const m = BRACKETED_RE.exec(line) || UNBRACKETED_RE.exec(line);
  if (!m) return null;
  const [, rawA, rawB, rawYear, hour, minute, second, ampm, rest] = m;
  const nameBody = NAME_BODY_RE.exec(rest);
  return {
    rawA: Number(rawA),
    rawB: Number(rawB),
    rawYear: Number(rawYear),
    hour: Number(hour),
    minute: Number(minute),
    second: second ? Number(second) : 0,
    ampm: ampm ? ampm.toUpperCase() : null,
    isMessage: !!nameBody,
    sender: nameBody ? nameBody[1].trim() : null,
    body: nameBody ? nameBody[2] : rest,
  };
}

/**
 * Split raw export text into header records, folding continuation lines
 * (anything that does not itself start a new dated line) into the message or
 * notice that precedes them, exactly the way a multi-line WhatsApp message
 * appears in the file.
 */
function splitRecords(text) {
  const lines = stripInvisible(text).replace(/\r\n/g, "\n").split("\n");
  const records = [];
  let current = null;
  for (const line of lines) {
    const header = matchHeader(line);
    if (header) {
      if (current) records.push(current);
      current = header;
      continue;
    }
    if (current) current.body = current.body ? `${current.body}\n${line}` : line;
  }
  if (current) records.push(current);
  return records;
}

/**
 * Is this file's content shaped like a WhatsApp export at all?
 *
 * Deliberately cheap and deliberately strict: the first non-blank line must
 * itself look like an export header (every real export starts with either a
 * message or the "messages are encrypted" notice), and at least a few more
 * header lines must show up in the first sample. Three matching lines in a
 * specific bracket-or-dash date-time shape is not something an unrelated
 * text file produces by accident.
 */
export function detectWhatsAppExport(text, { sampleLines = 60, minHeaders = 3 } = {}) {
  const lines = stripInvisible(text).replace(/\r\n/g, "\n").split("\n");
  const firstNonBlank = lines.find((l) => l.trim().length > 0);
  if (firstNonBlank === undefined || !matchHeader(firstNonBlank)) return false;
  let headers = 0;
  for (const line of lines.slice(0, sampleLines)) {
    if (matchHeader(line)) headers++;
    if (headers >= minHeaders) return true;
  }
  return headers >= minHeaders;
}

function normalizedYear(rawYear) {
  return rawYear < 100 ? 2000 + rawYear : rawYear;
}

function hour24(hour, ampm) {
  if (!ampm) return hour;
  const h = hour % 12;
  return ampm === "PM" ? h + 12 : h;
}

/**
 * Does reading every record's (rawA, rawB) as (day, month) or (month, day)
 * produce a valid, non-decreasing calendar across the whole file? Returns the
 * resolved epoch-ms array on success, or null the moment the reading is
 * impossible or goes backward.
 */
function tryReading(records, order) {
  const out = [];
  let prevMs = -Infinity;
  for (const r of records) {
    const day = order === "DM" ? r.rawA : r.rawB;
    const month = order === "DM" ? r.rawB : r.rawA;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = normalizedYear(r.rawYear);
    const h = hour24(r.hour, r.ampm);
    if (h > 23 || r.minute > 59 || r.second > 59) return null;
    const ms = Date.UTC(year, month - 1, day, h, r.minute, r.second);
    // Date.UTC silently rolls an out-of-range day into the next month (day 31
    // of a 30-day month becomes day 1 of the next), which would make an
    // impossible calendar date look valid. Read the constructed date's own
    // fields back and refuse the reading if they do not match what was asked.
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) return null;
    if (ms < prevMs) return null;
    prevMs = ms;
    out.push(ms);
  }
  return out;
}

/**
 * Resolve D/M vs M/D across the whole file, or report the ambiguity.
 * @returns {{format: "DM"|"MD"|null, timestamps: number[]|null, ambiguous: boolean}}
 */
export function resolveDateFormat(records) {
  if (!records.length) return { format: null, timestamps: null, ambiguous: true };
  const dm = tryReading(records, "DM");
  const md = tryReading(records, "MD");
  if (dm && !md) return { format: "DM", timestamps: dm, ambiguous: false };
  if (md && !dm) return { format: "MD", timestamps: md, ambiguous: false };
  // Both readings work (a short or regular chat has nothing to disambiguate
  // with) or neither does (something else is wrong). Either way, guessing is
  // worse than refusing.
  return { format: null, timestamps: null, ambiguous: true };
}

function stableRowId(threadId, iso, sender, body) {
  return createHash("sha256")
    .update(`${threadId}|${iso}|${sender}|${body}`)
    .digest("hex")
    .slice(0, 32);
}

/** "WhatsApp Chat with John Doe.txt" -> "John Doe". Falls back to the bare filename. */
export function deriveThreadTitle(filename) {
  const base = String(filename).replace(/\.[^.]+$/, "");
  const m = /^WhatsApp Chat with (.+)$/i.exec(base.trim());
  return (m ? m[1] : base).trim() || base;
}

/**
 * Parse one exported .txt file into sessionizer-ready rows.
 *
 * @returns {{
 *   rows: object[],            // message-session.mjs row shape, chronological
 *   ambiguous: boolean,
 *   dateFormat: "DM"|"MD"|null,
 *   messageCount: number,
 *   skippedMedia: number,
 *   skippedSystem: number,
 * }}
 */
export async function parseWhatsAppExport(text, { threadId, threadTitle } = {}) {
  const records = splitRecords(text);
  const { format, timestamps, ambiguous } = resolveDateFormat(records);

  if (ambiguous) {
    return {
      rows: [], ambiguous: true, dateFormat: null, messageCount: 0,
      skippedMedia: 0, skippedSystem: 0,
    };
  }

  const rows = [];
  let skippedMedia = 0;
  let skippedSystem = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r.isMessage) { skippedSystem++; continue; }
    const body = String(r.body || "").trim();
    if (!body || MEDIA_PLACEHOLDER_RE.test(stripInvisible(body).trim())) {
      skippedMedia++;
      continue;
    }
    const iso = new Date(timestamps[i]).toISOString();
    const id = stableRowId(threadId, iso, r.sender, body);
    rows.push({
      id,
      platform: "whatsapp",
      thread_id: threadId,
      thread_title: threadTitle,
      category: "message",
      ts: iso,
      sender_name: r.sender,
      body,
    });
  }

  return {
    rows, ambiguous: false, dateFormat: format,
    messageCount: rows.length, skippedMedia, skippedSystem,
  };
}
