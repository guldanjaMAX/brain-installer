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

let message;
try {
  const { text, totalPages } = await extractText(bytes, { mergePages: true });

  // Let Node report end-of-turn promise failures before staging success. The
  // parent also waits for a clean process exit, so a still-later failure wins.
  await new Promise((resolve) => setImmediate(resolve));

  message = backgroundFailure
    ? { ok: false, error_name: backgroundFailure }
    : { ok: true, text: text || "", totalPages: totalPages || 0 };
} catch (error) {
  message = { ok: false, error_name: backgroundFailure || errorName(error) };
}

process.stdout.write(JSON.stringify(message));
