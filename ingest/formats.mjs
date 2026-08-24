/**
 * PDF, Word, Excel and PowerPoint.
 *
 * Kept out of extract.mjs so the zero-dependency core stays honest: importing
 * THIS module is what pulls in unpdf, fflate and the spreadsheet reader.
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT
 *
 * A scanned PDF has no text layer. Every extractor "succeeds" on one and returns
 * an empty string. Indexed as-is, the brain then holds a document it can say
 * nothing about, and reports a corpus count that includes it. The client asks
 * about their contract, gets nothing, and concludes the brain is broken — when
 * in fact it was never given the contract at all.
 *
 * Measured on a random sample of 70 PDFs from a real 4,458-file corpus:
 *   79%  usable text layer
 *    7%  under 100 chars per page (scans with stray OCR or form labels)
 *   14%  zero text (pure scans)
 * Text-bearing PDFs averaged 1,600 to 2,000 characters per page, so the gap
 * between the two populations is an order of magnitude, not a judgement call.
 */

import { extractText } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";
import * as XLSX from "@e965/xlsx";
import PostalMime from "postal-mime";
import { register, renderTable } from "./extract.mjs";
import { stripMarkup } from "./quality.mjs";

/**
 * Below this many characters per page, a PDF is a scan rather than a document.
 * Set an order of magnitude under the observed text-PDF floor so a genuinely
 * sparse document (a signature page, a cover sheet) is not misjudged.
 */
export const MIN_CHARS_PER_PAGE = 100;

/**
 * Extract once. Separated so the caller can retry a suspicious result.
 */
export async function pdfPass(buf, { extractTextImpl = extractText } = {}) {
  try {
    // Give unpdf the bytes, not a caller-owned PDFDocumentProxy. Its byte-input
    // path owns the complete PDF.js loading task and destroys it in `finally`.
    // Keeping a proxy alive after text extraction let a malformed XRef reject
    // from PDF.js later as an unhandled background task, aborting an otherwise
    // resumable Drive sweep instead of becoming this file's reasoned skip.
    const { text, totalPages } = await extractTextImpl(new Uint8Array(buf), { mergePages: true });
    const body = (text || "").trim();
    const perPage = totalPages ? body.length / totalPages : 0;
    return { body, totalPages, perPage };
  } catch (e) {
    const name = e?.name || "";
    if (/Password/i.test(name)) return { text: null, error: "the PDF is password protected" };
    return { text: null, error: `the PDF could not be opened (${name || "unreadable"})` };
  }
}

/**
 * PDF, with one retry on an empty result.
 *
 * WHY THE RETRY IS NOT PARANOIA
 *
 * Measured on this machine, 2026-08-17: a Google Drive folder streams files on
 * demand. A file not yet materialized locally took 1,183ms on first read and
 * 1ms on the second. During a bulk walk, PDFs in that state parsed as
 * structurally valid — correct page count, no error — and yielded ZERO text.
 * Read again moments later, byte-for-byte identical, the same file yielded
 * 4,372 characters.
 *
 * That is indistinguishable from a scanned document, and it is the difference
 * between "this needs OCR" and "your cloud drive had not downloaded it yet".
 * Getting it wrong at corpus scale means thousands of real documents recorded as
 * unreadable scans. One retry costs milliseconds on a file that is genuinely
 * empty and rescues one that was merely cold.
 */
register(".pdf", async (buf, { reread } = {}) => {
  let r;
  try {
    r = await pdfPass(buf);
  } catch (e) {
    const name = e?.name || "";
    if (/Password/i.test(name)) return { text: null, error: "the PDF is password protected" };
    return { text: null, error: `the PDF could not be opened (${name || "unreadable"})` };
  }
  if (r.text === null && r.error) return r;

  if (!r.body.length && typeof reread === "function") {
    const fresh = await reread();
    if (fresh) {
      try {
        const again = await pdfPass(fresh);
        if (again.body && again.body.length) r = again;
      } catch {
        // Keep the first result; a retry that throws proves nothing new.
      }
    }
  }

  if (!r.body.length) {
    return {
      text: null,
      error: `no text layer: this is a scanned PDF (${r.totalPages} page${r.totalPages === 1 ? "" : "s"} of images). It needs OCR before it can be indexed.`,
    };
  }
  if (r.perPage < MIN_CHARS_PER_PAGE) {
    // Returned rather than refused. There IS text; there is just not much, and
    // saying so beats either silently indexing it or silently dropping it.
    return {
      text: r.body,
      note: `only ${Math.round(r.perPage)} characters per page, so this PDF is probably a scan and most of its content is not searchable`,
    };
  }
  return { text: r.body };
}, "pdf", { binary: true });

/* -------------------------------------------------------- ooxml (zip based) */

function unzipText(buf, pick) {
  const files = unzipSync(new Uint8Array(buf));
  const out = [];
  for (const name of Object.keys(files).sort()) {
    if (!pick(name)) continue;
    out.push(strFromU8(files[name]));
  }
  return out;
}

/** OOXML is XML; the text lives in runs. Paragraph ends become newlines. */
function ooxmlToText(xml) {
  return stripMarkup(
    String(xml)
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
  );
}

register(".docx", (buf) => {
  // Headers, footers, footnotes and endnotes are included deliberately: a
  // contract's effective date and its parties are very often in a header.
  const parts = unzipText(buf, (n) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n)
  );
  if (!parts.length) return { text: null, error: "no document body found inside the .docx" };
  return { text: parts.map(ooxmlToText).join("\n\n").replace(/\n{3,}/g, "\n\n").trim() };
}, "word", { binary: true });

register(".pptx", (buf) => {
  const slides = unzipText(buf, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
  if (!slides.length) return { text: null, error: "no slides found inside the .pptx" };
  return { text: slides.map(ooxmlToText).join("\n\n").trim() };
}, "powerpoint", { binary: true });

/* ------------------------------------------------------------- spreadsheets */

/**
 * A spreadsheet is many tables, and a grid of bare numbers is unretrievable.
 * Each sheet is named and each row rendered as "Header: value", the same shape
 * the CSV path uses, so "what was the checking balance in March" can actually
 * match a row.
 */
function sheetsToText(buf, name) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, cellFormula: false, cellHTML: false });
  const out = [];
  let truncated = 0;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: false });
    if (!rows.length) continue;
    const before = rows.length;
    const rendered = renderTable(rows, { label: `Sheet: ${sheetName}${name ? ` (${name})` : ""}` });
    if (rendered) out.push(rendered);
    if (before > 5000) truncated += before - 5000;
  }
  if (!out.length) return { text: null, error: "the workbook has no readable rows" };
  return {
    text: out.join("\n\n"),
    note: truncated ? `${truncated} row(s) beyond the per-sheet limit were not indexed` : undefined,
  };
}

for (const ext of [".xlsx", ".xlsm", ".xls"]) register(ext, (buf, { name } = {}) => sheetsToText(buf, name), "spreadsheet", { binary: true });

/* -------------------------------------------------------------------- email */

/**
 * Replaces the hand-rolled .eml reader. Correspondence is where intent lives,
 * and the hand-rolled version could not decode RFC 2047 encoded subjects, which
 * is exactly where names and clients appear.
 */
register(".eml", async (buf) => {
  const mail = await new PostalMime().parse(buf);
  const head = [
    mail.from ? `From: ${mail.from.name || ""} <${mail.from.address || ""}>`.trim() : null,
    mail.to?.length ? `To: ${mail.to.map((a) => a.address).join(", ")}` : null,
    mail.cc?.length ? `Cc: ${mail.cc.map((a) => a.address).join(", ")}` : null,
    mail.date ? `Date: ${mail.date}` : null,
    mail.subject ? `Subject: ${mail.subject}` : null,
  ].filter(Boolean);
  const body = (mail.text || (mail.html ? stripMarkup(mail.html) : "") || "").trim();
  if (!head.length && !body) return { text: null, error: "the message had no readable headers or body" };
  const names = (mail.attachments || []).map((a) => a.filename).filter(Boolean);
  if (names.length) head.push(`Attachments: ${names.join(", ")}`);
  return { text: [...head, "", body].join("\n") };
}, "email");
