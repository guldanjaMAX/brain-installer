/**
 * Rich Text Format to plain text, with no dependency.
 *
 * WHY NOT A LIBRARY. This package bundles four dependencies and every one of
 * them has to survive a live install on a client's own Windows machine while
 * someone watches. RTF is a 1987 control-word format with no compression, no
 * container and no XML: the text is already in the file, sitting between
 * backslash commands. Reading it needs a state machine, not a parser
 * generator, so there is nothing here worth adding a fifth package for.
 *
 * WHAT MAKES RTF DANGEROUS TO READ NAIVELY. A `.rtf` written by a word
 * processor is mostly NOT text. It opens with font tables, colour tables,
 * stylesheets and often an embedded copy of the same document as a picture, in
 * hex. Stripping backslashes and printing the remainder yields several
 * kilobytes of "Times New Roman;Arial;Calibri" followed by a megabyte of hex,
 * which then passes a length check and gets indexed as if it were a document.
 * So this walks the group structure and DISCARDS the destinations that hold
 * that material, rather than trying to filter it out of the output afterwards.
 */

/**
 * Groups whose entire contents are machine bookkeeping, never prose.
 *
 * `pict` and `object` are the important ones: they carry the embedded image
 * bytes as hex and are what turns a two-page letter into a two-megabyte file.
 */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
  "revtbl", "rsidtbl", "generator", "info", "pict", "object", "objdata",
  "themedata", "colorschememapping", "datastore", "latentstyles", "xmlnstbl",
  "fldinst", "filetbl", "pntext", "atrfstart", "atrfend", "mmathPr",
  "bkmkstart", "bkmkend", "template", "operator", "company", "protusertbl",
]);

/** Control words that are text, not formatting. */
const LITERALS = new Map([
  ["par", "\n"], ["line", "\n"], ["sect", "\n\n"], ["page", "\n\n"],
  ["tab", "\t"], ["cell", "\t"], ["row", "\n"], ["nestcell", "\t"], ["nestrow", "\n"],
  ["emdash", "—"], ["endash", "–"], ["emspace", " "], ["enspace", " "],
  ["qmspace", " "], ["~", " "], ["_", "‑"], ["-", ""],
  ["bullet", "•"], ["lquote", "‘"], ["rquote", "’"],
  ["ldblquote", "“"], ["rdblquote", "”"],
]);

/**
 * The 0x80-0x9F window of Windows-1252, which is where RTF's `\'hh` escapes
 * put curly quotes and dashes. Latin-1 leaves that window as control
 * characters, so decoding it as Latin-1 turns every smart quote in a client's
 * document into an invisible control byte, and the quality filter then reports
 * the file as mostly unreadable.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const byteToChar = (byte) =>
  byte >= 0x80 && byte <= 0x9f ? String.fromCharCode(CP1252_HIGH[byte - 0x80]) : String.fromCharCode(byte);

/** Is this actually an RTF file, or something that merely ends in .rtf? */
export function looksLikeRtf(text) {
  return /^\s*\{\s*\\rtf\d/.test(String(text || "").slice(0, 200));
}

/**
 * Read the text out of an RTF document.
 *
 * Returns the text, or null when the file is not RTF at all. An empty result
 * from a genuinely RTF file is returned as an empty string, so the caller can
 * tell "this was not RTF" apart from "this was RTF and had nothing in it" and
 * report the right reason for each.
 */
export function rtfToText(input) {
  const text = String(input || "");
  if (!looksLikeRtf(text)) return null;

  const out = [];
  // One frame per open brace. `skip` is inherited: a group nested inside a
  // discarded picture is also discarded.
  const stack = [];
  let skip = false;
  let unicodeSkip = 1;
  // How many characters of the current `\uN` fallback are still to be dropped.
  let pendingSkip = 0;
  let groupIsFresh = false;

  const emit = (value) => {
    if (skip || !value) return;
    if (pendingSkip > 0) {
      // The fallback after a \uN is plain text and must be dropped character
      // by character, or every non-ASCII character appears twice.
      const drop = Math.min(pendingSkip, value.length);
      pendingSkip -= drop;
      value = value.slice(drop);
      if (!value) return;
    }
    out.push(value);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === "{") {
      stack.push({ skip, unicodeSkip });
      groupIsFresh = true;
      continue;
    }
    if (c === "}") {
      const frame = stack.pop();
      if (frame) {
        skip = frame.skip;
        unicodeSkip = frame.unicodeSkip;
      }
      groupIsFresh = false;
      pendingSkip = 0;
      continue;
    }
    if (c === "\r" || c === "\n") continue;

    if (c !== "\\") {
      if (!groupIsFresh || c.trim()) groupIsFresh = false;
      emit(c);
      continue;
    }

    // From here on: a control word, a control symbol, or an escaped literal.
    const next = text[i + 1];
    if (next === "\\" || next === "{" || next === "}") {
      groupIsFresh = false;
      emit(next);
      i += 1;
      continue;
    }
    if (next === "'") {
      const hex = text.slice(i + 2, i + 4);
      i += 3;
      groupIsFresh = false;
      if (/^[0-9a-fA-F]{2}$/.test(hex)) emit(byteToChar(parseInt(hex, 16)));
      continue;
    }
    if (next === "*") {
      // `\*\destination` marks a destination a reader that does not understand
      // it MUST discard. The spec says so; obeying it is what keeps unknown
      // vendor extensions out of the text.
      const word = /^\\\*\\([a-zA-Z]+)/.exec(text.slice(i));
      if (word) {
        skip = true;
        i += word[0].length - 1;
        groupIsFresh = false;
        continue;
      }
    }

    const match = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(text.slice(i));
    if (!match) {
      // A control symbol such as `\~` or `\-`.
      const symbol = LITERALS.get(next);
      if (symbol !== undefined) emit(symbol);
      i += 1;
      groupIsFresh = false;
      continue;
    }

    const word = match[1];
    const param = match[2] === undefined ? null : parseInt(match[2], 10);
    i += match[0].length - 1;

    if (groupIsFresh && SKIP_DESTINATIONS.has(word)) {
      skip = true;
      groupIsFresh = false;
      continue;
    }
    groupIsFresh = false;

    if (word === "uc") {
      unicodeSkip = Number.isFinite(param) && param >= 0 ? param : 1;
      continue;
    }
    if (word === "u" && param !== null) {
      // RTF writes a negative number for anything above U+7FFF.
      const code = param < 0 ? param + 65536 : param;
      if (!skip && code >= 0 && code <= 0x10ffff) out.push(String.fromCodePoint(code));
      pendingSkip = unicodeSkip;
      continue;
    }
    const literal = LITERALS.get(word);
    if (literal !== undefined) {
      // A paragraph break ends any pending \u fallback; the fallback never
      // spans a paragraph.
      pendingSkip = 0;
      emit(literal);
    }
  }

  return out.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
