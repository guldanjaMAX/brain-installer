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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import * as XLSX from "@e965/xlsx";
import PostalMime from "postal-mime";
import { register, renderTable } from "./extract.mjs";
import { splitMbox } from "./mbox.mjs";
import { stripMarkup } from "./quality.mjs";

/**
 * Below this many characters per page, a PDF is a scan rather than a document.
 * Set an order of magnitude under the observed text-PDF floor so a genuinely
 * sparse document (a signature page, a cover sheet) is not misjudged.
 */
export const MIN_CHARS_PER_PAGE = 100;
export const PDF_PROCESS_TIMEOUT_MS = 120_000;
export const PDF_PROCESS_MAX_OUTPUT_BYTES = 96 * 1024 * 1024;

const PDF_CHILD_PATH = fileURLToPath(new URL("./pdf-child.mjs", import.meta.url));
const PDF_HANDSHAKE_MAX_BYTES = 4_096;

function pdfFailure(name = "unreadable") {
  const safeName = typeof name === "string" && name ? name.slice(0, 80) : "unreadable";
  if (/Password/i.test(safeName)) return { text: null, error: "the PDF is password protected" };
  return { text: null, error: `the PDF could not be opened (${safeName})` };
}

function pdfResult(text, totalPages) {
  const body = text.trim();
  const perPage = totalPages ? body.length / totalPages : 0;
  return { body, totalPages, perPage };
}

function pdfSystemFailure(reason) {
  const error = new Error(`PDF parser is unavailable (${reason})`);
  error.name = "ExtractorSystemError";
  error.fatal = true;
  return error;
}

function pdfChildEnvironment(source = process.env) {
  const allowed = new Set([
    "path", "systemroot", "windir", "comspec", "pathext",
    "temp", "tmp", "tmpdir", "lang", "lc_all", "lc_ctype", "tz",
  ]);
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (value != null && allowed.has(key.toLowerCase())) clean[key] = value;
  }
  return clean;
}

/**
 * Parse one PDF outside the ingest process.
 *
 * A process is created per document on purpose. Reuse would let leaked PDF.js
 * tasks accumulate again, and one malformed file could poison a later file.
 * Bytes travel over stdin, parser output is bounded, and the child receives a
 * small environment allowlist with no brain, Google, or Cloudflare credential.
 */
export async function pdfPassIsolated(buf, {
  childPath = PDF_CHILD_PATH,
  timeoutMs = PDF_PROCESS_TIMEOUT_MS,
  maxOutputBytes = PDF_PROCESS_MAX_OUTPUT_BYTES,
} = {}) {
  const bytes = Buffer.from(buf);
  const scriptPath = childPath instanceof URL ? fileURLToPath(childPath) : childPath;

  return await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    let ready = false;
    let handshake = Buffer.alloc(0);
    let outputBytes = 0;
    const output = [];

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const finish = (result) => settle(resolve, result);
    const failSystem = (reason) => {
      child?.kill("SIGKILL");
      settle(reject, pdfSystemFailure(reason));
    };

    const appendResult = (chunk) => {
      if (!chunk.length || settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish({ text: null, error: "the PDF parser produced more text than the safe output limit" });
        return;
      }
      output.push(chunk);
    };

    try {
      child = spawn(process.execPath, [scriptPath], {
        env: pdfChildEnvironment(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      failSystem(error?.name || "could not start");
      return;
    }

    child.once("error", (error) => {
      if (ready) finish(pdfFailure(error?.name || "parser process failed"));
      else failSystem(error?.name || "could not start");
    });
    child.stdin.on("error", () => {
      // A parser that exits early closes stdin. Its exit and JSON result carry
      // the useful classification; EPIPE must not become an installer crash.
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      if (ready) {
        appendResult(chunk);
        return;
      }

      handshake = Buffer.concat([handshake, chunk]);
      const newline = handshake.indexOf(0x0a);
      if (newline < 0) {
        if (handshake.length > PDF_HANDSHAKE_MAX_BYTES) failSystem("invalid startup handshake");
        return;
      }

      let hello;
      try {
        hello = JSON.parse(handshake.subarray(0, newline).toString("utf8"));
      } catch {
        failSystem("invalid startup handshake");
        return;
      }
      if (hello?.type !== "ready" || hello?.version !== 1) {
        failSystem("invalid startup handshake");
        return;
      }

      ready = true;
      const remainder = handshake.subarray(newline + 1);
      handshake = Buffer.alloc(0);
      appendResult(remainder);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (!ready) {
        failSystem("startup did not complete");
        return;
      }
      let message;
      try {
        message = JSON.parse(Buffer.concat(output).toString("utf8"));
      } catch {
        if (code === 0) failSystem("invalid result protocol");
        else finish(pdfFailure("parser process failed"));
        return;
      }
      if (code !== 0 || message?.ok === false) {
        finish(pdfFailure(message?.error_name || "parser process failed"));
      } else if (message?.ok === true) {
        if (typeof message.text !== "string" || !Number.isInteger(message.totalPages) || message.totalPages < 0) {
          failSystem("invalid result protocol");
        } else finish(pdfResult(message.text, message.totalPages));
      } else failSystem("invalid result protocol");
    });

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!ready) failSystem("startup timed out");
      else finish({
        text: null,
        error: `the PDF parser timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
      });
    }, timeoutMs);
    timer.unref?.();
    child.stdin.end(bytes);
  });
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
export async function extractPdf(buf, { reread } = {}, { pdfPassImpl = pdfPassIsolated } = {}) {
  let r;
  try {
    r = await pdfPassImpl(buf);
  } catch (e) {
    if (e?.fatal === true) throw e;
    const name = e?.name || "";
    if (/Password/i.test(name)) return { text: null, error: "the PDF is password protected" };
    return { text: null, error: `the PDF could not be opened (${name || "unreadable"})` };
  }
  if (r.text === null && r.error) return r;

  if (!r.body.length && typeof reread === "function") {
    const fresh = await reread();
    if (fresh) {
      try {
        const again = await pdfPassImpl(fresh);
        if (again.body && again.body.length) r = again;
      } catch (e) {
        if (e?.fatal === true) throw e;
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
}

register(".pdf", extractPdf, "pdf", { binary: true });

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
 * One RFC 822 message, read once, in one place.
 *
 * Replaces the hand-rolled .eml reader. Correspondence is where intent lives,
 * and the hand-rolled version could not decode RFC 2047 encoded subjects,
 * which is exactly where names and clients appear.
 *
 * Returns the rendered text AND the few headers a caller needs to give the
 * message an identity and a date of its own. The mbox path needs those, and a
 * second mail parser next to this one is how two parts of the product start
 * disagreeing about what a message says.
 */
export async function parseEmailMessage(buf) {
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
  const date = mail.date ? new Date(mail.date) : null;
  return {
    text: [...head, "", body].join("\n"),
    subject: mail.subject || null,
    from: mail.from?.name || mail.from?.address || null,
    messageId: mail.messageId || null,
    occurredAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

register(".eml", async (buf) => {
  const parsed = await parseEmailMessage(buf);
  return parsed.error ? { text: null, error: parsed.error } : { text: parsed.text };
}, "email");

/* ---------------------------------------------------------- mail archives */

/**
 * A mail archive, for a caller that can only hold one document per file.
 *
 * The local folder walk does NOT come through here: it splits the archive and
 * loads each message as its own document, which is the only way a citation
 * points at something a person can act on. This registration exists so that a
 * `.mbox` sitting in a synced Drive folder is READ rather than skipped for
 * having no extractor, and it renders every message through the same reader
 * the split path uses. Coarser, never different.
 */
register(".mbox", async (buf) => {
  const raw = Buffer.from(buf).toString("utf-8");
  const messages = splitMbox(raw);
  if (!messages.length) {
    return { text: null, error: "this .mbox file has no message separator line in it, so it is not a mail archive" };
  }
  const rendered = [];
  let unreadable = 0;
  for (const message of messages) {
    let parsed;
    try {
      parsed = await parseEmailMessage(Buffer.from(message, "utf-8"));
    } catch {
      unreadable++;
      continue;
    }
    if (parsed.error || !parsed.text?.trim()) unreadable++;
    else rendered.push(parsed.text.trim());
  }
  if (!rendered.length) {
    return { text: null, error: `none of the ${messages.length} message(s) in this archive could be read` };
  }
  return {
    text: rendered.join("\n\n----\n\n"),
    note: `${rendered.length} message(s) from one mail archive` +
      (unreadable ? `; ${unreadable} could not be read` : "") +
      "; loaded through a local folder they would each become their own document",
  };
}, "mail archive");
