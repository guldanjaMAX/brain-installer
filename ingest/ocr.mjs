/**
 * OCR policy: what counts as a read, what counts as garbage, and what a page
 * read by a machine is allowed to look like once it is inside the corpus.
 *
 * No network and no model live in this file. It decides, and the decision is
 * deterministic, so the same pages produce the same verdict and the same
 * confidence number every time.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 * `ingest/formats.mjs` refuses a scanned PDF rather than indexing it empty,
 * because a brain that holds a document it can say nothing about is worse than
 * one that admits the document never arrived. OCR removes that refusal, and in
 * doing so introduces a WORSE failure than an empty document: a wrong one.
 *
 * A vision model asked to look at a page defaults to DESCRIBING it. "This
 * appears to be a bank statement showing several transactions" is fluent
 * English, passes every text-quality check in this repo, and is a complete
 * fabrication of a document nobody transcribed. Indexed, it would be cited,
 * with a page number, as though someone had read it.
 *
 * So OCR output is guarded twice. Once here, before anything is indexed, by
 * rules that look for the specific ways a transcription fails. And once in the
 * corpus, where every OCR'd document is MARKED as OCR and carries a confidence
 * that travels all the way into the citation. A blurry read must never look
 * identical to a clean one.
 */

import { MIN_CHARS_PER_PAGE } from "./formats.mjs";

/**
 * The sentinels the model is told to emit. They are matched exactly, so a
 * model that invents its own wording is caught by the guards below rather than
 * quietly accepted.
 */
export const BLANK_SENTINEL = "[[BLANK]]";
export const UNREADABLE_SENTINEL = "[[UNREADABLE]]";

/** How OCR'd text announces itself inside the document body. */
export const OCR_BANNER =
  "[OCR] The text below was read from a scanned image by a machine, not from a " +
  "text layer in the file. It can be wrong, and figures especially can be wrong.";

export const pageMarker = (n) => `[[page ${n} | OCR]]`;
export const unreadablePageMarker = (n, why) => `[[page ${n}: could not be read — ${why}]]`;

/**
 * The prompt. Defensive on purpose.
 *
 * Every clause is here because of a specific way this goes wrong: describing
 * instead of transcribing, tidying a figure it could not quite see, inventing
 * a plausible line to fill a gap, or apologising in prose that then gets
 * indexed as document content.
 */
export const OCR_SYSTEM_PROMPT = [
  "You transcribe scanned documents. You do not describe them, summarise them, or explain them.",
  "Output ONLY the text visible on the page, verbatim, in reading order. Preserve numbers, dates and amounts exactly as printed, digit for digit.",
  "Never correct, complete, round or reformat a figure. Never infer a value you cannot see.",
  `If a word, number or region is illegible, write ${UNREADABLE_SENTINEL} in its place. Do not guess.`,
  `If the page has no text on it at all, output exactly ${BLANK_SENTINEL} and nothing else.`,
  "Do not add a preamble, a heading, a commentary, or a closing remark. No sentence about the image itself.",
].join(" ");

/* ------------------------------------------------------- garbage, defined */

/**
 * Openings that mean the model described the page instead of reading it.
 *
 * Matched only against the LEADING text of a page, because a transcription can
 * legitimately contain any of these phrases inside a quoted letter or memo.
 * The failure is a model narrating; a narration starts at the top.
 */
const NARRATION_OPENERS = [
  "the image", "this image", "the document", "this document", "the page", "this page",
  "this appears", "it appears", "the photo", "this photo", "the scan", "this scan",
  "i can see", "i see", "i am unable", "i'm unable", "i cannot", "i can't",
  "sorry", "unfortunately", "as an ai", "here is", "here's", "certainly",
  "the provided", "this is a", "the screenshot",
];

/** How much of the start of a page is checked for narration. */
const NARRATION_WINDOW = 160;

/**
 * The smallest run of text that counts as a page having said something.
 *
 * Not a refusal trigger on its own: a genuinely near-empty page (the back of a
 * form, a separator sheet, a signature line) is ordinary inside a scanned
 * bundle. It classifies the page as blank so it can be reported rather than
 * counted as a successful read.
 */
export const MIN_PAGE_CHARS = 12;

/**
 * The share of pages that may fail before the whole document is refused.
 *
 * Set at half, deliberately in the empty middle of the distribution rather
 * than near either end. The two real populations are far from it: a working
 * OCR run fails on the odd page (a photograph, a stamp), well under a tenth,
 * while the dangerous failure — a model that narrates instead of transcribing,
 * or one pointed at unreadable input — does it on essentially EVERY page, at
 * or near one. Nothing realistic sits at 0.5, which is exactly what a
 * threshold should be able to say for itself.
 *
 * Above the line the document is refused whole rather than indexed half-read,
 * because a document that is half machine-read and half missing, cited as one
 * document, misrepresents what was actually read. Below the line every failed
 * page is named inline by `unreadablePageMarker`, so nothing is silently lost
 * and a reader can see which page was not read.
 */
export const MAX_UNREADABLE_SHARE = 0.5;

/**
 * A decoder stuck in a loop repeats itself immediately and exactly.
 *
 * Deliberately NOT the unique-word ratio used by `ingest/quality.mjs`: a real
 * bank statement page is legitimately repetitive ("Debit", "Debit", "Debit",
 * a column of dates) and would be thrown away by a ratio test. Consecutive
 * identical lines cannot happen on a real page in this quantity, so the rule
 * catches the loop without touching the document type that matters most.
 */
const LOOP_RUN = 8;

function hasRepeatLoop(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4);
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run >= LOOP_RUN) return true;
  }
  return false;
}

const digitRatio = (text) => {
  const letters = text.replace(/\s/g, "");
  if (!letters.length) return 0;
  return +((letters.match(/\d/g) || []).length / letters.length).toFixed(3);
};

/**
 * Judge one page of model output.
 *
 * Returns `{ status, text, reason, metrics }` where status is one of
 * `read`, `blank` or `unreadable`. Nothing here ever rewrites the text to make
 * it pass; a page either survives as it came back or it is reported.
 */
export function judgePage(raw) {
  const text = String(raw ?? "").trim();
  const metrics = { chars: text.length };

  if (!text) return { status: "unreadable", text: "", reason: "the model returned nothing for this page", metrics };
  if (text === BLANK_SENTINEL) return { status: "blank", text: "", reason: null, metrics };

  const head = text.slice(0, NARRATION_WINDOW).toLowerCase().replace(/^[^a-z]+/, "");
  const narrating = NARRATION_OPENERS.find((opener) => head.startsWith(opener));
  if (narrating) {
    // The single most dangerous outcome, because it reads as fluent English
    // and passes every other check in the repo.
    return {
      status: "unreadable",
      text: "",
      reason: `the model described the page instead of transcribing it (it began "${text.slice(0, 60).replace(/\s+/g, " ")}")`,
      metrics,
    };
  }

  const replacement = (text.match(/�/g) || []).length;
  metrics.replacement_ratio = +(replacement / text.length).toFixed(3);
  if (metrics.replacement_ratio > 0.05) {
    return { status: "unreadable", text: "", reason: "the page came back as mostly unreadable characters", metrics };
  }

  if (hasRepeatLoop(text)) {
    return { status: "unreadable", text: "", reason: "the model repeated one line over and over, which means it lost the page rather than read it", metrics };
  }

  const unreadableMarks = (text.match(/\[\[UNREADABLE\]\]/g) || []).length;
  metrics.unreadable_marks = unreadableMarks;
  // A page that is nothing but "I could not read this" is not a read page.
  const withoutMarks = text.replaceAll(UNREADABLE_SENTINEL, "").trim();
  metrics.legible_chars = withoutMarks.length;
  if (withoutMarks.length < MIN_PAGE_CHARS) {
    return unreadableMarks
      ? { status: "unreadable", text: "", reason: "the model could not read any of this page", metrics }
      : { status: "blank", text: "", reason: null, metrics };
  }

  // Recorded, never a refusal on its own. A page with no digits may simply be
  // a cover letter; refusing it for that would discard real prose. It lowers
  // confidence instead, which is what the reader actually needs to know when
  // the page was supposed to be a statement.
  metrics.digit_ratio = digitRatio(withoutMarks);

  return { status: "read", text, reason: null, metrics };
}

/* ---------------------------------------------------------------- assemble */

/**
 * Turn per-page model output into one decision about the document.
 *
 * `pages` is `[{ page, text, error }]` in page order; `error` marks a page that
 * never reached the model at all (no image on it, a request that failed), and
 * is counted as unreadable rather than quietly dropped.
 *
 * Returns either `{ ok: false, refusal }` or
 * `{ ok: true, text, provenance, note }`.
 */
export function assembleOcr(pages, { totalPages, model } = {}) {
  const total = totalPages || pages.length;
  const judged = pages.map((p) => {
    if (p?.error) {
      return { page: p.page, status: "unreadable", text: "", reason: p.error, metrics: { chars: 0 } };
    }
    return { page: p.page, ...judgePage(p?.text) };
  });

  const read = judged.filter((p) => p.status === "read");
  const blank = judged.filter((p) => p.status === "blank");
  const unreadable = judged.filter((p) => p.status === "unreadable");

  // Blank pages are not failures, so they leave the denominator: a bundle with
  // ten scanned sheets and four genuinely empty backs is not half-failed.
  const attempted = read.length + unreadable.length;
  const unreadableShare = attempted ? unreadable.length / attempted : 1;

  const body = judged
    .map((p) => {
      if (p.status === "read") return `${pageMarker(p.page)}\n${p.text}`;
      if (p.status === "blank") return `${pageMarker(p.page)}\n${BLANK_SENTINEL}`;
      return unreadablePageMarker(p.page, p.reason || "unreadable");
    })
    .join("\n\n");

  const legible = read.reduce((n, p) => n + (p.metrics.legible_chars || 0), 0);
  const perPage = total ? legible / total : 0;

  if (!read.length) {
    return {
      ok: false,
      refusal: `OCR was attempted on all ${total} page${total === 1 ? "" : "s"} and produced nothing readable`,
      diagnostics: { pages: judged, per_page_chars: 0 },
    };
  }
  if (unreadableShare > MAX_UNREADABLE_SHARE) {
    return {
      ok: false,
      refusal:
        `OCR was attempted and ${unreadable.length} of ${attempted} page${attempted === 1 ? "" : "s"} came back unreadable ` +
        `(${unreadable[0].reason})`,
      diagnostics: { pages: judged, per_page_chars: Math.round(perPage) },
    };
  }
  // The SAME floor a native text layer has to clear. A scan does not get an
  // easier bar than a document that arrived with its text intact; that is what
  // makes "indexed" mean one thing rather than two.
  if (perPage < MIN_CHARS_PER_PAGE) {
    return {
      ok: false,
      refusal:
        `OCR was attempted and produced only ${Math.round(perPage)} characters per page, ` +
        `under the ${MIN_CHARS_PER_PAGE} a readable document clears`,
      diagnostics: { pages: judged, per_page_chars: Math.round(perPage) },
    };
  }

  const partial = unreadable.length > 0;
  const digits = read.map((p) => p.metrics.digit_ratio ?? 0);

  return {
    ok: true,
    text: `${OCR_BANNER}\n\n${body}`,
    ...(partial ? { incomplete: true } : {}),
    provenance: {
      text_source: partial ? "ocr_partial" : "ocr",
      text_reliable: false,
      confidence: ocrConfidence({ read: read.length, blank: blank.length, unreadable: unreadable.length, judged }),
      model: model || null,
      pages_total: total,
      pages_read: read.length,
      pages_blank: blank.length,
      pages_unreadable: unreadable.length,
      chars_per_page: Math.round(perPage),
      mean_digit_ratio: digits.length ? +(digits.reduce((a, b) => a + b, 0) / digits.length).toFixed(3) : 0,
      per_page: judged.map((p) => ({
        page: p.page,
        status: p.status,
        chars: p.metrics.legible_chars ?? p.metrics.chars ?? 0,
        unreadable_marks: p.metrics.unreadable_marks || 0,
        ...(p.reason ? { reason: p.reason.slice(0, 160) } : {}),
      })),
    },
    note: partial
      ? `read by OCR from a scanned image; ${unreadable.length} of ${total} page${total === 1 ? "" : "s"} could not be read and ${unreadable.length === 1 ? "is" : "are"} marked in the text`
      : `read by OCR from a scanned image, so the text is a machine's reading of a picture and can be wrong`,
  };
}

/**
 * A coverage number, and nothing more than that.
 *
 * It is NOT a model self-rating. Those are uncalibrated, and passing one off as
 * confidence would be the same dishonesty this whole path is guarding against.
 * It is the share of attempted pages that came back as readable text, docked
 * for the illegible regions the model flagged inside the pages that did. Every
 * input is countable and every input is reported in `per_page`, so a reader can
 * recompute it and disagree with the arithmetic rather than with an oracle.
 */
export function ocrConfidence({ read = 0, blank = 0, unreadable = 0, judged = [] } = {}) {
  const attempted = read + unreadable;
  if (!attempted) return 0;
  const coverage = read / attempted;
  const marks = judged.reduce((n, p) => n + (p.metrics?.unreadable_marks || 0), 0);
  // Each flagged illegible region costs a little, capped so a page dense with
  // them cannot drive the number below what coverage alone already says.
  const markPenalty = Math.min(0.25, marks * 0.01);
  return +Math.max(0, Math.min(1, coverage - markPenalty)).toFixed(2);
}

/* -------------------------------------------------------------- cost model */

/**
 * Published Workers AI price for the default OCR model, read from
 * developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it on 2026-08-28:
 * $0.10 per M input tokens, $0.30 per M output tokens.
 *
 * The token counts are BRACKETS, not measurements. Cloudflare does not publish
 * an image-token count for this model and this build could not measure one
 * without a live client account, so the estimate is deliberately a range and is
 * labelled as one everywhere it is shown. A single figure would look like
 * knowledge it is not.
 */
export const OCR_PRICE = {
  input_usd_per_m: 0.1,
  output_usd_per_m: 0.3,
  input_tokens_per_page: [2000, 4000],
  output_tokens_per_page: [400, 1200],
  seconds_per_page: [1, 3],
};

/**
 * What a scanned corpus will cost and how long it will take, as a range.
 *
 * Surfaced BEFORE a run, not after, because the cost is per page and lands on
 * the client's own Cloudflare account. An owner who has just pointed this at a
 * filing cabinet deserves to see the size of the bill and the size of the wait
 * while they can still say no.
 */
export function estimateOcrCost(pageCount, price = OCR_PRICE) {
  const pages = Math.max(0, Math.round(Number(pageCount) || 0));
  const at = (i) =>
    (pages * price.input_tokens_per_page[i] * price.input_usd_per_m +
      pages * price.output_tokens_per_page[i] * price.output_usd_per_m) / 1_000_000;
  return {
    pages,
    usd_low: +at(0).toFixed(4),
    usd_high: +at(1).toFixed(4),
    minutes_low: +((pages * price.seconds_per_page[0]) / 60).toFixed(1),
    minutes_high: +((pages * price.seconds_per_page[1]) / 60).toFixed(1),
  };
}

/** One line an operator can read before deciding to spend it. */
export function describeOcrCost(estimate) {
  if (!estimate.pages) return "no scanned pages found, so OCR would cost nothing";
  const money = estimate.usd_high < 0.01
    ? "under a cent"
    : `about $${estimate.usd_low.toFixed(2)} to $${estimate.usd_high.toFixed(2)}`;
  const time = estimate.minutes_high < 1
    ? "under a minute"
    : `roughly ${estimate.minutes_low} to ${estimate.minutes_high} minutes`;
  return `${estimate.pages} scanned page${estimate.pages === 1 ? "" : "s"}: ${money} on your own Cloudflare account, and ${time} of model time. The estimate is a range because Cloudflare does not publish an image token count for this model.`;
}
