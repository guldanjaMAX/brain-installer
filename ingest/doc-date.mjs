/**
 * The date a document is FROM, which is not the date its file was touched.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT
 *
 * A previous corpus stored file mtime as the document date. Google Drive sync,
 * a bulk permission change and a backup restore all rewrite mtime, so 80% of
 * that corpus appeared to have been written in the current year. Nothing
 * errored. What broke was the staleness gap: the brain could no longer tell
 * anyone "the newest thing I have on this is from May", because by its own
 * records everything was recent. A confidently wrong recency signal is worse
 * than none, so this module REFUSES to accept mtime as an input at all rather
 * than merely discouraging it.
 *
 * Returning null is a legitimate, useful answer. The gap engine reports undated
 * material honestly; it cannot report a date that is quietly wrong.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Wide enough to cover real business documents, narrow enough that a random
// 4-digit number (an invoice id, a dollar amount, a street number) is rejected.
const MIN_YEAR = 1970;
const MAX_YEAR = new Date().getUTCFullYear() + 1;

function build(y, m, d) {
  if (!(y >= MIN_YEAR && y <= MAX_YEAR)) return null;
  if (!(m >= 1 && m <= 12)) return null;
  if (!(d >= 1 && d <= 31)) return null;
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  // Rejects 2024-02-31 and friends, which JS would otherwise roll forward into
  // March and report as a valid date.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

/**
 * Find a date in a string.
 *
 * `reliable` is false when the reading required a guess. An ambiguous numeric
 * date like 03/04/2024 is one of these: US order is assumed because the corpora
 * are US business documents, but the assumption is flagged so a caller can
 * choose not to trust it rather than inheriting it silently.
 */
export function parseDateFrom(text) {
  if (!text) return null;
  const s = String(text);

  // ISO-ish: 2024-03-04, 2024_03_04, 2024.03.04, 20240304
  let m = s.match(/(?<![0-9])(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?![0-9])/);
  if (m) {
    const ms = build(+m[1], +m[2], +m[3]);
    if (ms !== null) return { value: ms, reliable: true, matched: m[0] };
  }

  // Named month: "March 4, 2024", "4 Mar 2024", "Mar 2024"
  m = s.match(/(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?![0-9])/i);
  if (m) {
    const ms = build(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    if (ms !== null) return { value: ms, reliable: true, matched: m[0] };
  }
  m = s.match(/(?<![0-9])(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})(?![0-9])/i);
  if (m) {
    const ms = build(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    if (ms !== null) return { value: ms, reliable: true, matched: m[0] };
  }

  // Slashed: 03/04/2024. Genuinely ambiguous; see `reliable`.
  m = s.match(/(?<![0-9])(\d{1,2})[/](\d{1,2})[/](\d{4})(?![0-9])/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    // When one component cannot be a month, the order is not a guess.
    const unambiguous = a > 12 || b > 12;
    const ms = a > 12 ? build(y, b, a) : build(y, a, b);
    if (ms !== null) return { value: ms, reliable: unambiguous, matched: m[0], note: unambiguous ? undefined : "ambiguous D/M order, US order assumed" };
  }

  // A bare month, e.g. "March 2024" or "2024-03". Anchored to the 1st, and
  // flagged, because day precision was never there to begin with.
  m = s.match(/(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})(?![0-9])/i);
  if (m) {
    const ms = build(+m[2], MONTHS[m[1].toLowerCase()], 1);
    if (ms !== null) return { value: ms, reliable: false, matched: m[0], note: "month precision only" };
  }
  m = s.match(/(?<![0-9])(\d{4})-(\d{2})(?![-0-9])/);
  if (m) {
    const ms = build(+m[1], +m[2], 1);
    if (ms !== null) return { value: ms, reliable: false, matched: m[0], note: "month precision only" };
  }

  return null;
}

/**
 * Derive a document date, most trustworthy source first.
 *
 * NOTE THE SIGNATURE. There is no mtime parameter, deliberately. A caller
 * holding an mtime cannot pass it in by accident, and one that tries gets a
 * TypeError rather than a plausible wrong answer.
 */
export function documentDate({ filename = "", relPath = "", contentHead = "" } = {}, opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, "mtime") || Object.prototype.hasOwnProperty.call(opts, "modified_time")) {
    throw new TypeError(
      "documentDate() does not accept a file mtime. A sync, a permission change or a " +
        "restore all rewrite mtime, and storing it as the document date silently disables " +
        "staleness reporting. Return null instead and let the gap engine say so."
    );
  }

  const fromName = parseDateFrom(filename);
  if (fromName) return { value: fromName.value, source: "filename", reliable: fromName.reliable, note: fromName.note };

  // Directories like "2024/Q1" or "Statements 2023-11" carry real intent.
  const fromPath = parseDateFrom(String(relPath).replace(/[\\/]/g, " "));
  if (fromPath) return { value: fromPath.value, source: "path", reliable: fromPath.reliable, note: fromPath.note };

  // Only the head. A date deep inside a long document is as likely to be a
  // deadline, a birth date or a cited contract as it is the document's own date.
  const fromContent = parseDateFrom(String(contentHead).slice(0, 1200));
  if (fromContent) return { value: fromContent.value, source: "content", reliable: false, note: fromContent.note || "read from the document body" };

  return { value: null, source: "none", reliable: false };
}
