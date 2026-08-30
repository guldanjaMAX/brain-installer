/**
 * Reject text that will waste an embedding and pollute retrieval.
 *
 * THE CASE THIS IS DESIGNED AGAINST
 *
 * One HTML file in a previous corpus, "Blueprint Image Picker.html", was 75 to
 * 87 percent base64 image data. It produced 18,259 chunks. Every one of them
 * embedded, every one competed for retrieval slots, and not one could answer a
 * question. A whole-corpus survey later found 51.5% of the index was markup or
 * encoded blobs and only 6% was prose.
 *
 * Nothing errored. Search simply got worse, slowly, in a way no health check
 * could see. So the filter runs BEFORE embedding, and every rejection is
 * recorded with its reason rather than silently dropped: a client asking "why
 * isn't my file in there" deserves an answer better than a shrug.
 *
 * The thresholds are deliberately loose. A false accept costs one bad chunk. A
 * false reject silently loses a real document, which is far worse, so anything
 * borderline is kept.
 */

/** Below this there is nothing to retrieve, and it is usually a failed extraction. */
export const MIN_CHARS = 24;

/** Long base64 runs are the signature of an embedded image or attachment. */
const B64_RUN = /[A-Za-z0-9+/=]{200,}/g;

/** A hex blob (data URIs, certificates, serialized binary). */
const HEX_RUN = /[0-9a-fA-F]{300,}/g;

/**
 * Does this look like a binary file rather than text?
 *
 * Checked on the RAW BYTES, before any decode, because decoding binary as UTF-8
 * produces replacement characters that then look like ordinary text.
 */
/**
 * UTF-16 detection, because on Windows it is not an edge case.
 *
 * PowerShell redirection and Notepad both write UTF-16LE by default, so a
 * client's own notes are full of NUL bytes by design. Treating any NUL as
 * binary rejected those files with the flatly untrue reason "the file is binary,
 * not text", and the client never learns their notes are missing.
 */
export function utf16Encoding(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  // No BOM: infer from the NUL pattern of ASCII-range text, where every other
  // byte is zero. Sample rather than scan the whole file.
  const n = Math.min(buf.length - (buf.length % 2), 512);
  if (n < 16) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenNul++;
    if (buf[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  if (oddNul / pairs > 0.6 && evenNul / pairs < 0.1) return "utf-16le";
  if (evenNul / pairs > 0.6 && oddNul / pairs < 0.1) return "utf-16be";
  return null;
}

export function isLikelyBinary(buf) {
  if (!buf || !buf.length) return false;
  // UTF-16 is text. Checking this first is what stops a Windows client's own
  // notes being discarded as binary.
  if (utf16Encoding(buf)) return false;
  const n = Math.min(buf.length, 8192);
  let nul = 0;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) nul++;
    // Control characters excluding tab, newline, carriage return, form feed.
    else if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  // A single NUL byte is the classic binary tell and almost never appears in
  // real text; a scattering of other control bytes can, so that gets a ratio.
  return nul > 0 || ctrl / n > 0.02;
}

/**
 * Judge extracted text.
 *
 * Returns { ok, reason, metrics }. `reason` is written to be shown to a client
 * verbatim, so it says what happened rather than naming a rule.
 */
export function textQuality(text) {
  const s = typeof text === "string" ? text : "";
  const len = s.length;
  const metrics = { chars: len };

  if (!s.trim()) {
    return { ok: false, reason: "no text could be extracted (the file produced an empty result)", metrics };
  }
  if (len < MIN_CHARS) {
    return { ok: false, reason: `only ${len} characters of text, too little to answer anything`, metrics };
  }

  // Encoded blobs. Measured as a share of total length, so a document that
  // merely MENTIONS a token is unaffected while one built from them is caught.
  let encoded = 0;
  for (const m of s.match(B64_RUN) || []) encoded += m.length;
  for (const m of s.match(HEX_RUN) || []) encoded += m.length;
  metrics.encoded_ratio = +(encoded / len).toFixed(3);
  if (metrics.encoded_ratio > 0.35) {
    return {
      ok: false,
      reason: `${Math.round(metrics.encoded_ratio * 100)}% of this file is encoded data (base64 or hex), not readable text`,
      metrics,
    };
  }

  // Replacement characters mean a decode went wrong. A few are survivable;
  // a document made of them is a mis-detected encoding.
  const repl = (s.match(/�/g) || []).length;
  metrics.replacement_ratio = +(repl / len).toFixed(3);
  if (metrics.replacement_ratio > 0.05) {
    return { ok: false, reason: "the text decoded into mostly unreadable characters (wrong or unsupported encoding)", metrics };
  }

  // Repetition. A 2MB file of one repeated row embeds as well as one copy of it
  // and crowds out everything else. Only applied to long text, because short
  // documents are legitimately repetitive.
  if (len > 4000) {
    const words = s.toLowerCase().match(/[a-z0-9']{2,}/g) || [];
    if (words.length >= 200) {
      metrics.unique_word_ratio = +(new Set(words).size / words.length).toFixed(3);
      if (metrics.unique_word_ratio < 0.02) {
        return { ok: false, reason: "the file is almost entirely repeated content, with too little distinct text to be worth indexing", metrics };
      }
    }
  }

  return { ok: true, reason: null, metrics };
}

/**
 * Strip markup to its text.
 *
 * Not a parser and not trying to be. Scripts, styles and comments go first
 * (their contents are never answers), then tags, then entities. Anything more
 * faithful needs a real dependency, and the retrieval quality difference does
 * not justify one.
 */
export function stripMarkup(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
