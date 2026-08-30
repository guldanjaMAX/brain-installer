/**
 * One-document PDF extraction process.
 *
 * PDF.js can reject a background promise after its public extraction promise
 * settles, and unpdf cannot destroy the loading task when document opening
 * itself rejects. This disposable process keeps those failures out of the
 * ingest process. It receives bytes on stdin and returns one JSON result on
 * stdout. No path or credential is needed here.
 */

import { extractText, getResolvedPDFJS } from "unpdf";
import { renderPdfPageImages } from "./page-image.mjs";

/**
 * `--images=<n>` asks this child to ALSO return page images, and only when the
 * document turned out to have no text layer. Rendering is not free and the
 * overwhelming majority of PDFs never need it, so the parent asks for it
 * explicitly and the answer is computed in the process that already has the
 * document open. Reopening it in the ingest process is what this file exists
 * to avoid: PDF.js can reject a background promise after the public promise
 * settles, and that failure belongs out here where it can only kill a
 * disposable child.
 */
const imagesArg = process.argv.find((a) => a.startsWith("--images"));
const wantImages = Boolean(imagesArg);
const maxImagePages = imagesArg?.includes("=") ? Number(imagesArg.split("=")[1]) || 0 : 0;

await getResolvedPDFJS();
await new Promise((resolve) => {
  process.stdout.write(`${JSON.stringify({ type: "ready", version: 1 })}\n`, resolve);
});

let backgroundFailure = null;

function errorName(error) {
  return String(error?.name || "unreadable").slice(0, 80);
}

function recordBackgroundFailure(error) {
  backgroundFailure ||= errorName(error);
  process.exitCode = 1;
}

process.on("unhandledRejection", recordBackgroundFailure);
process.on("uncaughtException", recordBackgroundFailure);

const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const bytes = new Uint8Array(Buffer.concat(input));

// A SECOND copy, kept only when page images were asked for.
//
// PDF.js DETACHES the ArrayBuffer it is handed when it opens a document, so
// the bytes are gone by the time the text result comes back and a second open
// fails with DataCloneError. That failure surfaced as "its pages could not be
// rendered", which reads as a fact about the client's document and is not one.
// Only a test that drove the real child process could catch it; a stubbed
// parser never detaches anything.
const bytesForImages = wantImages ? bytes.slice() : null;

let message;
let imageError = null;
try {
  const { text, totalPages } = await extractText(bytes, { mergePages: true });

  // Let Node report end-of-turn promise failures before staging success. The
  // parent also waits for a clean process exit, so a still-later failure wins.
  await new Promise((resolve) => setImmediate(resolve));

  let pageImages = null;
  if (!backgroundFailure && wantImages && !String(text || "").trim()) {
    try {
      const rendered = await renderPdfPageImages(bytesForImages, { maxPages: maxImagePages });
      pageImages = rendered.pages;
    } catch (error) {
      // A page that cannot be rendered is not a broken document. The text
      // result still stands, and the parent refuses for the ORIGINAL reason
      // rather than inventing a rendering failure as the document's fault.
      pageImages = null;
      imageError = errorName(error);
    }
  }

  message = backgroundFailure
    ? { ok: false, error_name: backgroundFailure }
    : {
      ok: true,
      text: text || "",
      totalPages: totalPages || 0,
      ...(pageImages ? { pageImages } : {}),
      ...(imageError ? { imageError } : {}),
    };
} catch (error) {
  message = { ok: false, error_name: backgroundFailure || errorName(error) };
}

process.stdout.write(JSON.stringify(message));
