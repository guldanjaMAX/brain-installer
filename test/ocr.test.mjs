/**
 * OCR for scanned PDFs.
 *
 * The four questions this file has to answer, because each one is a way the
 * feature can look finished and not be:
 *
 *   1. Does a scan that reads cleanly actually get indexed?
 *   2. Does a scan that reads BADLY get refused, in the product's own voice,
 *      rather than indexed as a plausible guess?
 *   3. Is a PDF that already has a text layer kept away from the model
 *      entirely? Needless spend on someone else's account is its own defect.
 *   4. Does the OCR mark survive all the way into a stored document and out
 *      into a citation? A flag that dies in transit is not a flag.
 *
 * Every model call here is a stub. Nothing in this file reaches the network,
 * and no real person, client or document appears in it.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractPdf, MIN_CHARS_PER_PAGE } from "../ingest/formats.mjs";
import { extract } from "../ingest/extract.mjs";
import {
  assembleOcr, judgePage, ocrConfidence, estimateOcrCost, describeOcrCost,
  OCR_BANNER, BLANK_SENTINEL, UNREADABLE_SENTINEL, MAX_UNREADABLE_SHARE,
} from "../ingest/ocr.mjs";
import { renderPdfPageImages } from "../ingest/page-image.mjs";
import { scanPdf, textPdf, blankPdf } from "./fixtures/scan-pdf.mjs";
import { splitStatements, drivePolicyFingerprint, ocrPolicy, makeOcrCallback } from "../brain.mjs";
import { storeFor } from "../worker/src/lib/store.js";
import { computeAnswerConfidence } from "../worker/src/lib/confidence.js";
import { callLLM, visionMessages, workersAiRate } from "../worker/src/lib/core.js";
import { handleOcr } from "../worker/src/lib/ocr.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const HERE = dirname(fileURLToPath(import.meta.url));

/* ================================================================ pixels */
/* The day-zero question: can a page become an image with no native module? */

{
  const clean = await renderPdfPageImages(new Uint8Array(scanPdf()));
  check("a scanned page becomes a real PNG with no native module",
    clean.pages[0]?.png_base64?.length > 0, JSON.stringify(clean.pages[0]));
  const png = Buffer.from(clean.pages[0].png_base64, "base64");
  check("and it is a structurally valid PNG",
    png.subarray(1, 4).toString() === "PNG" && png.subarray(12, 16).toString() === "IHDR",
    png.subarray(0, 16).toString("hex"));

  // unpdf's own extractImages silently drops this shape, and it is exactly the
  // fax and photocopier population the feature exists for.
  const fax = await renderPdfPageImages(new Uint8Array(scanPdf({ depth: 1 })));
  check("a ONE-BIT fax scan is rendered, not dropped",
    fax.pages[0]?.png_base64?.length > 0, JSON.stringify(fax.pages[0]));

  const none = await renderPdfPageImages(new Uint8Array(blankPdf()));
  check("a page with no image object renders as null, never as a blank image",
    none.pages[0] === null, JSON.stringify(none.pages[0]));

  const many = await renderPdfPageImages(new Uint8Array(scanPdf({ pages: 3 })), {});
  check("every page of a multi-page scan is rendered", many.pages.filter(Boolean).length === 3);

  const capped = await renderPdfPageImages(new Uint8Array(scanPdf({ pages: 3 })), { maxPages: 2 });
  check("the per-document page ceiling is respected, so one huge scan cannot run away",
    capped.pages.length === 2 && capped.totalPages === 3, JSON.stringify(capped.pages.length));
}

/* ============================================================ page verdict */

{
  check("a plain transcription is a read page", judgePage("Invoice total 1,204.55 due 30 June").status === "read");

  // The single most dangerous outcome: fluent English that no one transcribed.
  for (const narration of [
    "The image shows a bank statement with several transactions listed.",
    "This appears to be a deposit slip from a local branch.",
    "I can see a handwritten ledger page with numbers on it.",
    "Sorry, I cannot read this document clearly.",
    "Here is the transcription of the page you provided:",
  ]) {
    const verdict = judgePage(narration);
    check(`narration is refused, not indexed: "${narration.slice(0, 34)}..."`,
      verdict.status === "unreadable" && /described the page/.test(verdict.reason || ""),
      JSON.stringify(verdict));
  }

  check("a quoted narration phrase INSIDE a real transcription is not refused",
    judgePage("MEMORANDUM\nTo: all staff\nThe image shows our new logo on page two.").status === "read");

  check("the blank sentinel is a blank page, not a failure",
    judgePage(BLANK_SENTINEL).status === "blank");
  check("a page that is only unreadable markers is unreadable",
    judgePage(`${UNREADABLE_SENTINEL} ${UNREADABLE_SENTINEL}`).status === "unreadable");
  check("an empty response is unreadable, never silently accepted",
    judgePage("").status === "unreadable");

  const loop = judgePage(Array(12).fill("Balance forward").join("\n"));
  check("a model stuck repeating one line is caught",
    loop.status === "unreadable" && /repeated one line/.test(loop.reason || ""), JSON.stringify(loop));

  // The guard that must NOT fire: a real statement page is legitimately
  // repetitive, and a unique-word ratio would throw it away.
  const statement = [
    "01 Mar  Debit card purchase   42.10   1,204.55",
    "02 Mar  Debit card purchase   18.99   1,185.56",
    "03 Mar  Debit card purchase  105.00   1,080.56",
    "04 Mar  Debit card purchase   12.45   1,068.11",
    "05 Mar  Debit card purchase   77.80     990.31",
  ].join("\n");
  check("a repetitive but REAL statement page survives", judgePage(statement).status === "read",
    JSON.stringify(judgePage(statement)));
  check("and its digit density is recorded for the reader",
    judgePage(statement).metrics.digit_ratio > 0.3, JSON.stringify(judgePage(statement).metrics));
}

/* ========================================================= document verdict */

const longPage = (n) =>
  `Statement page ${n}. ` + Array(12).fill("Debit card purchase 42.10 balance 1,204.55.").join(" ");

{
  const good = assembleOcr([1, 2, 3].map((page) => ({ page, text: longPage(page) })), { totalPages: 3, model: "@cf/test" });
  check("three clean pages assemble into an indexable document", good.ok === true, JSON.stringify(good.refusal));
  check("the text announces itself as OCR", good.text.startsWith(OCR_BANNER), good.text.slice(0, 60));
  check("every page carries its own marker",
    /\[\[page 1 \| OCR\]\]/.test(good.text) && /\[\[page 3 \| OCR\]\]/.test(good.text));
  check("provenance says ocr, not ocr_partial", good.provenance.text_source === "ocr", good.provenance.text_source);
  check("and the text is explicitly NOT reliable", good.provenance.text_reliable === false);
  check("confidence is 1 when every attempted page read", good.provenance.confidence === 1, String(good.provenance.confidence));

  const partial = assembleOcr([
    { page: 1, text: longPage(1) },
    { page: 2, text: longPage(2) },
    { page: 3, text: "The image shows a page of a document." },
  ], { totalPages: 3 });
  check("one bad page in three is indexed as PARTIAL, not as whole",
    partial.ok === true && partial.provenance.text_source === "ocr_partial", JSON.stringify(partial.refusal));
  check("the failed page is NAMED in the text rather than dropped",
    /\[\[page 3: could not be read/.test(partial.text), partial.text.slice(-160));
  check("and confidence falls below 1", partial.provenance.confidence < 1, String(partial.provenance.confidence));
  check("the owner-facing note says which pages were lost",
    /1 of 3 pages could not be read/.test(partial.note), partial.note);

  /* --- the refusals --- */
  const narrated = assembleOcr([1, 2].map((page) => ({ page, text: "This appears to be a scanned document." })), { totalPages: 2 });
  check("a document the model DESCRIBED is refused whole",
    narrated.ok === false && /produced nothing readable/.test(narrated.refusal), JSON.stringify(narrated));

  const mostlyBad = assembleOcr([
    { page: 1, text: longPage(1) },
    { page: 2, text: "The image shows a page." },
    { page: 3, text: "I cannot read this." },
  ], { totalPages: 3 });
  check(`over ${MAX_UNREADABLE_SHARE * 100}% unreadable refuses the whole document`,
    mostlyBad.ok === false && /came back unreadable/.test(mostlyBad.refusal), JSON.stringify(mostlyBad.refusal));

  const thin = assembleOcr([1, 2, 3].map((page) => ({ page, text: `page ${page} total 42` })), { totalPages: 3 });
  check("OCR text must clear the SAME per-page floor a text layer clears",
    thin.ok === false && new RegExp(String(MIN_CHARS_PER_PAGE)).test(thin.refusal), JSON.stringify(thin.refusal));

  const blanks = assembleOcr([
    { page: 1, text: longPage(1) },
    { page: 2, text: BLANK_SENTINEL },
    { page: 3, text: BLANK_SENTINEL },
  ], { totalPages: 3 });
  check("genuinely blank pages are not counted as failures",
    blanks.ok === true && blanks.provenance.pages_blank === 2 && blanks.provenance.confidence === 1,
    JSON.stringify(blanks.provenance));

  check("a page that never reached the model is counted, never dropped",
    assembleOcr([{ page: 1, error: "no image on this page" }], { totalPages: 1 }).ok === false);

  check("confidence is a coverage number anyone can recompute",
    ocrConfidence({ read: 3, unreadable: 1, judged: [] }) === 0.75,
    String(ocrConfidence({ read: 3, unreadable: 1, judged: [] })));
}

/* ================================================== the extractor decision */
/* Where the refusal used to live, and what happens there now. */

const pageText = "Deposit slip. Cash 400.00. Cheques 1,204.55. Total 1,604.55. Teller 14. Branch 002. Reference 88213.";

function stubOcr({ reply = () => pageText, model = "@cf/google/gemma-4-26b-a4b-it", maxPages = 40 } = {}) {
  const calls = [];
  const fn = async (image, meta) => {
    calls.push({ page: meta.page, bytes: image?.png_base64?.length || 0 });
    return { text: reply(meta.page) };
  };
  fn.model = model;
  fn.maxPages = maxPages;
  fn.calls = calls;
  return fn;
}

{
  /* ---- 3. a PDF WITH a text layer must never reach the model ---- */
  const ocr = stubOcr();
  let renderRequested = false;
  const got = await extractPdf(textPdf(), { ocr }, {
    pdfPassImpl: async (buf, opts) => {
      if (opts?.withPageImages) renderRequested = true;
      const { extractText } = await import("unpdf");
      const r = await extractText(new Uint8Array(buf), { mergePages: true });
      return { body: r.text.trim(), totalPages: r.totalPages, perPage: r.text.trim().length, pageImages: null };
    },
  });
  check("a PDF with a text layer is extracted normally", /must never be sent to OCR/.test(got.text || ""), JSON.stringify(got).slice(0, 200));
  check("and NOT ONE page of it is sent to the model", ocr.calls.length === 0, JSON.stringify(ocr.calls));
  check("and it carries no OCR provenance", got.provenance === undefined, JSON.stringify(got.provenance));

  // Requesting a render is itself a cost, so it is asked for only when there is
  // somewhere to send the pixels — but it is asked for BEFORE the text result
  // is known, so this asserts the flag reaches the child, not that it is free.
  check("with no OCR callback the child is never asked to render at all",
    await (async () => {
      let asked = false;
      await extractPdf(textPdf(), {}, {
        pdfPassImpl: async (buf, opts) => {
          asked = Boolean(opts?.withPageImages);
          return { body: "real text layer here", totalPages: 1, perPage: 900 };
        },
      });
      return asked === false;
    })());
}

{
  /* ---- 1. a clean scan is read and marked ---- */
  const ocr = stubOcr();
  const got = await extractPdf(scanPdf({ pages: 2 }), { ocr }, { pdfPassImpl: scannedPass });
  check("a scanned PDF is now READ instead of refused outright", typeof got.text === "string" && !got.error,
    JSON.stringify(got.error));
  check("every page was sent to the model", ocr.calls.length === 2, JSON.stringify(ocr.calls));
  check("the model received real PNG bytes, not an empty prompt", ocr.calls.every((c) => c.bytes > 50),
    JSON.stringify(ocr.calls));
  check("the stored text is marked as OCR in the body itself", got.text.includes(OCR_BANNER));
  check("provenance travels out of the extractor", got.provenance?.text_source === "ocr", JSON.stringify(got.provenance));
  check("the note tells the owner it was read from a picture", /read by OCR from a scanned image/.test(got.note || ""), got.note);

  /* ---- and it survives extract(), the funnel every ingest path uses ---- */
  const viaExtract = await extract(scanPdf(), "statement.pdf", { ocr: stubOcr() });
  check("extract() forwards the provenance instead of dropping it",
    viaExtract.provenance?.text_source === "ocr" && viaExtract.provenance.text_reliable === false,
    JSON.stringify(viaExtract.provenance));
}

{
  /* ---- 2. a poor scan is refused, in the product's own voice ---- */
  const ocr = stubOcr({ reply: () => "The image shows a document with some writing on it." });
  const got = await extractPdf(scanPdf(), { ocr }, { pdfPassImpl: scannedPass });
  check("a scan the model only DESCRIBED is refused", got.text === null, JSON.stringify(got).slice(0, 200));
  check("the refusal keeps the product's original opening phrase byte for byte",
    got.error.startsWith("no text layer: this is a scanned PDF"), got.error);
  check("and it says OCR was tried, rather than pretending it was not",
    /OCR was attempted/.test(got.error), got.error);

  const empty = await extractPdf(blankPdf(), { ocr: stubOcr() }, {
    pdfPassImpl: async () => ({ body: "", totalPages: 1, perPage: 0, pageImages: [null] }),
  });
  check("a scan with no image to read refuses honestly about WHY",
    empty.text === null && /nothing to send to OCR/.test(empty.error), empty.error);
}

{
  /* ---- the spend guard binds, and a cap hit is never blamed on the document ---- */
  const capped = Object.assign(async () => {
    const e = new Error("daily LLM spend cap of $10 reached");
    e.fatal = true;
    e.llm_cap_exceeded = true;
    throw e;
  }, { model: "@cf/x", maxPages: 40 });

  let thrown = null;
  try {
    await extractPdf(scanPdf(), { ocr: capped }, { pdfPassImpl: scannedPass });
  } catch (e) { thrown = e; }
  check("a spend-cap hit ESCAPES as fatal so the source cursor stays retryable",
    thrown?.fatal === true && thrown?.llm_cap_exceeded === true, String(thrown?.message));
  check("and the document is never recorded as unreadable because of it", thrown !== null);

  // A per-page model error is different: it IS about that page.
  const flaky = Object.assign(async ({ }, meta) => (meta.page === 1 ? { error: "model 500" } : { text: longPage(meta.page) }),
    { model: "@cf/x", maxPages: 40 });
  const mixed = await extractPdf(scanPdf({ pages: 4 }), { ocr: flaky }, { pdfPassImpl: scannedPass });
  check("a single failing page is reported inline, not thrown",
    mixed.text?.includes("[[page 1: could not be read"), JSON.stringify(mixed).slice(0, 200));
}

/* ============================================ the model call, and custody */

{
  const db = (reserve = true) => {
    let id = 0;
    return {
      exec: async () => {},
      prepare: (sql) => ({ bind: () => ({
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => /RETURNING id/.test(sql) ? (reserve ? { id: ++id } : null) : {},
      }) }),
    };
  };
  const origFetch = globalThis.fetch;
  let anthropicCalls = 0;
  globalThis.fetch = async () => { anthropicCalls++; return { ok: true, status: 200, json: async () => ({ content: [], usage: {} }), text: async () => "" }; };
  try {
    await (async () => {
      let rejected = null;
      try {
        await callLLM({ DB: db(), AI: { run: async () => ({ response: "x" }) }, ANTHROPIC_API_KEY: "k" },
          { model: "claude-sonnet-4-5", system: "s", messages: [], image: "AAAA", label: "ocr" });
      } catch (e) { rejected = e; }
      check("a page image can NEVER be sent to a non-Cloudflare model",
        rejected?.provider_mismatch === true, String(rejected?.message));
      check("and the refusal happens before any request leaves", anthropicCalls === 0, String(anthropicCalls));
    })();

    let rejected = null;
    try {
      await callLLM({ DB: db(), ANTHROPIC_API_KEY: "k" },
        { model: "@cf/google/gemma-4-26b-a4b-it", system: "s", messages: [], image: "AAAA", label: "ocr" });
    } catch (e) { rejected = e; }
    check("with no AI binding OCR refuses rather than finding another provider",
      rejected?.provider_mismatch === true, String(rejected?.message));
    check("still nothing reached Anthropic", anthropicCalls === 0, String(anthropicCalls));

    let sent = null;
    await callLLM({ DB: db(), AI: { run: async (m, body) => { sent = { m, body }; return { response: "TOTAL 42", usage: {} }; } } },
      { model: "@cf/google/gemma-4-26b-a4b-it", system: "transcribe", messages: [{ role: "user", content: "go" }], image: "AAAA", label: "ocr" });
    check("the image reaches Workers AI attached to the message",
      JSON.stringify(sent.body.messages).includes("data:image/png;base64,AAAA"), JSON.stringify(sent.body).slice(0, 200));
    check("temperature is zero, because a transcription must not be creative", sent.body.temperature === 0);
  } finally { globalThis.fetch = origFetch; }

  check("the alternate image shape is a named switch, not a rewrite",
    JSON.stringify(visionMessages("s", [], "AAAA", { OCR_IMAGE_FORMAT: "image_field" })).includes('"image":"data:image/png'),
    JSON.stringify(visionMessages("s", [], "AAAA", { OCR_IMAGE_FORMAT: "image_field" })));

  check("OCR is priced at the OCR model's rate, not the answer model's",
    workersAiRate("@cf/google/gemma-4-26b-a4b-it").in === 0.1 &&
    workersAiRate("@cf/meta/llama-3.3-70b-instruct-fp8-fast").out === 2.25,
    JSON.stringify(workersAiRate("@cf/google/gemma-4-26b-a4b-it")));
  check("an unknown model is priced at the DEARER rate, so the cap cannot fail quiet",
    workersAiRate("@cf/some/new-model").out === 2.25);
}

/* ------------------------------------------------------- the worker route */

{
  const key = "k".repeat(40);
  const req = (body) => new Request("https://brain.example/api/admin/brain/ocr", {
    method: "POST", headers: { "X-Admin-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const reservationDb = (reserve = true) => {
    let id = 0;
    return {
      exec: async () => {},
      prepare: (sql) => ({ bind: () => ({
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => /RETURNING id/.test(sql) ? (reserve ? { id: ++id } : null) : {},
      }) }),
    };
  };
  const db = reservationDb();

  const unauth = await handleOcr({ ADMIN_KEY: key, OCR_ENABLED: "1", DB: db }, new Request("https://b/x", { method: "POST" }));
  check("the OCR route is admin-gated", unauth.status === 401, String(unauth.status));

  const off = await handleOcr({ ADMIN_KEY: key, DB: db }, req({ image_base64: "AA", prompt: "p" }));
  check("OCR is OFF by default, so an upgrade never starts spending on its own",
    off.status === 409 && (await off.clone().json()).ocr_enabled === false, String(off.status));

  const ok = await handleOcr(
    { ADMIN_KEY: key, OCR_ENABLED: "1", DB: db, AI: { run: async () => ({ response: "TOTAL 1,204.55", usage: {} }) } },
    req({ image_base64: "AA", page: 1, prompt: "transcribe" }),
  );
  const okBody = await ok.json();
  check("an enabled brain transcribes and says which model did it",
    ok.status === 200 && okBody.text === "TOTAL 1,204.55" && okBody.model === "@cf/google/gemma-4-26b-a4b-it",
    JSON.stringify(okBody));
  check("and it reports the image shape it used, so a wrong guess is one call to find",
    okBody.image_format === "content_array", JSON.stringify(okBody));

  const capped = await handleOcr(
    {
      ADMIN_KEY: key, OCR_ENABLED: "1", DAILY_LLM_CAP_USD: "0",
      DB: reservationDb(false),
      AI: { run: async () => ({ response: "x" }) },
    },
    req({ image_base64: "AA", prompt: "p" }),
  );
  check("the daily spend cap binds on the OCR route too",
    capped.status === 429 && (await capped.clone().json()).llm_cap_exceeded === true, String(capped.status));

  const huge = await handleOcr({ ADMIN_KEY: key, OCR_ENABLED: "1", DB: db }, req({ image_base64: "A".repeat(4_000_001), prompt: "p" }));
  check("an oversized page image is refused with the size stated", huge.status === 413, String(huge.status));
}

/* ------------------------------------------------- the CLI callback contract */

{
  const seen = [];
  const call = makeOcrCallback({
    base: "https://brain.example", adminKey: "k", model: "@cf/m", maxPages: 7,
    httpImpl: async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ text: "TOTAL 42" }) };
    },
  });
  const out = await call({ png_base64: "AAAA" }, { page: 2, totalPages: 5 });
  check("the CLI sends pages to the brain's OWN worker, never to a vendor API",
    seen[0].url === "https://brain.example/api/admin/brain/ocr", seen[0].url);
  check("the page image and the defensive prompt both travel with it",
    seen[0].body.image_base64 === "AAAA" && /do not describe them/i.test(seen[0].body.prompt),
    JSON.stringify(seen[0].body).slice(0, 160));
  check("and the transcription comes back", out.text === "TOTAL 42");
  check("the page ceiling rides on the callback", call.maxPages === 7);

  const cap = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({ ok: false, status: 429, json: async () => ({ llm_cap_exceeded: true, detail: "cap" }) }),
  });
  let capErr = null;
  try { await cap({ png_base64: "A" }, { page: 1 }); } catch (e) { capErr = e; }
  check("a cap response becomes a FATAL error, so no document is blamed for it",
    capErr?.fatal === true && capErr?.llm_cap_exceeded === true, String(capErr?.message));

  const mismatch = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({ ok: false, status: 409, json: async () => ({ provider_mismatch: true, detail: "no AI binding" }) }),
  });
  let misErr = null;
  try { await mismatch({ png_base64: "A" }, { page: 1 }); } catch (e) { misErr = e; }
  check("a custody refusal is fatal too", misErr?.fatal === true, String(misErr?.message));

  const flaky = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({ ok: false, status: 502, json: async () => ({ detail: "upstream blew up" }) }),
  });
  const pageErr = await flaky({ png_base64: "A" }, { page: 3 });
  check("a per-page model failure is a page error, not a run failure",
    /page 3/.test(pageErr.error || ""), JSON.stringify(pageErr));
}

/* ------------------------------------------------------------ the policy */

{
  check("OCR is off unless the manifest turns it on", ocrPolicy({}).enabled === false);
  check("and on when it does", ocrPolicy({ safety: { ocr: { enabled: true } } }).enabled === true);
  check("a per-document page ceiling always exists", ocrPolicy({}).maxPages > 0);

  const off = drivePolicyFingerprint({}, true, false);
  const on = drivePolicyFingerprint({}, true, true);
  check("turning OCR on changes the Drive policy fingerprint, forcing one full sweep",
    off !== on, `${off.slice(0, 12)} vs ${on.slice(0, 12)}`);
  check("...which is what makes a scan refused last month get looked at again",
    drivePolicyFingerprint({}, true, true) === on);
}

/* ---------------------------------------------------------- the cost model */

{
  const hundred = estimateOcrCost(100);
  check("cost is given as a RANGE, because the image token count is not published",
    hundred.usd_low > 0 && hundred.usd_high > hundred.usd_low, JSON.stringify(hundred));
  check("and time is estimated too, because time is the cost people feel",
    hundred.minutes_high > hundred.minutes_low, JSON.stringify(hundred));
  const line = describeOcrCost(estimateOcrCost(2000));
  check("the one-line estimate names pages, money and minutes",
    /2000 scanned pages/.test(line) && /\$/.test(line) && /minutes/.test(line), line);
  check("it says the estimate is a range and why", /range because/.test(line), line);
  check("zero scanned pages costs nothing and says so", /cost nothing/.test(describeOcrCost(estimateOcrCost(0))));
}

/* ================================================== survival into storage */
/* The claim that matters: the mark reaches a stored row and a citation. */

{
  const DIR = join(HERE, "..", "migrations", "d1");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) sqlite.exec(statement);
  }

  // The outbox generation clock is owned by install_state, and the trigger that
  // stamps it needs a row to read. A real install always has one.
  sqlite.exec(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'ocr-fixture', '0.0.0', 17, 0, '2026-01-01T00:00:00Z', 'test')`,
  );

  const columns = new Set(sqlite.prepare("PRAGMA table_info(documents)").all().map((r) => r.name));
  check("documents.text_source exists as a real column, not a JSON key",
    columns.has("text_source") && columns.has("text_reliable"), [...columns].join(","));

  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      first: async () => sqlite.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes || 0) } }),
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    STORAGE: "d1",
    DB: {
      prepare,
      batch: async (statements) => {
        sqlite.exec("BEGIN");
        try {
          const out = statements.map((s) => ({ meta: { changes: Number(sqlite.prepare(s._sql).run(...s._params).changes || 0) } }));
          sqlite.exec("COMMIT");
          return out;
        } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
      },
    },
  };
  const store = storeFor(env);

  const ocrBody = `${OCR_BANNER}\n\n[[page 1 | OCR]]\n${longPage(1)}`;
  await store.ingest(env, {
    source_type: "upload", source_id: "scans/statement.pdf",
    title: "Statement", content: ocrBody,
    text_source: "ocr", text_reliable: false,
    metadata: { category: "upload", ocr: { pages_read: 1, confidence: 1 } },
  });
  await store.ingest(env, {
    source_type: "upload", source_id: "notes/plain.md",
    title: "Plain note", content: `A note that arrived with its own text layer. ${longPage(9)}`,
    metadata: { category: "upload" },
  });

  const rows = Object.fromEntries(
    sqlite.prepare("SELECT source_id, text_source, text_reliable FROM documents").all().map((r) => [r.source_id, r]),
  );
  check("the OCR mark SURVIVED into the stored document",
    rows["scans/statement.pdf"].text_source === "ocr" && rows["scans/statement.pdf"].text_reliable === 0,
    JSON.stringify(rows["scans/statement.pdf"]));
  check("a document with a real text layer is stored as native and reliable",
    rows["notes/plain.md"].text_source === "native" && rows["notes/plain.md"].text_reliable === 1,
    JSON.stringify(rows["notes/plain.md"]));
  check("the per-page OCR detail is kept in meta for diagnosis",
    /"pages_read":1/.test(sqlite.prepare("SELECT meta FROM documents WHERE source_id='scans/statement.pdf'").get().meta));

  /* --- and it comes back OUT of retrieval, which is the only place it counts --- */
  const found = await store.search(env, { query: "Debit card purchase balance", limit: 5 });
  const byRef = Object.fromEntries(found.results.map((r) => [r.ref_key, r]));
  check("retrieval returns the provenance beside every result",
    byRef["scans/statement.pdf"]?.text_source === "ocr" &&
    byRef["scans/statement.pdf"]?.text_reliable === false,
    JSON.stringify(found.results.map((r) => [r.ref_key, r.text_source])));
  check("a natively extracted result is plainly distinguishable from it",
    byRef["notes/plain.md"]?.text_source === "native" && byRef["notes/plain.md"]?.text_reliable === true,
    JSON.stringify(byRef["notes/plain.md"]));

  /* --- re-extraction with a real text layer must CLEAR the mark --- */
  await store.ingest(env, {
    source_type: "upload", source_id: "scans/statement.pdf",
    title: "Statement", content: `A rescanned copy that now carries a text layer. ${longPage(2)}`,
    metadata: { category: "upload" },
  });
  check("a document re-read from a real text layer stops being marked as a scan",
    sqlite.prepare("SELECT text_source FROM documents WHERE source_id='scans/statement.pdf'").get().text_source === "native");
}

/* --------------------------------------------- and into the confidence line */

{
  const clean = computeAnswerConfidence({
    approvedDocs: [{ ref: "a", ts: "2026-01-01", date_reliable: true, text_source: "native" }],
  });
  const scanned = computeAnswerConfidence({
    approvedDocs: [{ ref: "a", ts: "2026-01-01", date_reliable: true, text_source: "ocr" }],
  });
  const partial = computeAnswerConfidence({
    approvedDocs: [{ ref: "a", ts: "2026-01-01", date_reliable: true, text_source: "ocr_partial" }],
  });
  check("an answer resting on a scan scores LOWER than the same answer on real text",
    scanned.percent < clean.percent, `${scanned.percent} vs ${clean.percent}`);
  check("a half-read scan scores lower still", partial.percent < scanned.percent,
    `${partial.percent} vs ${scanned.percent}`);
  check("and the reason is stated in the basis, not buried in a number",
    scanned.basis.some((b) => /read by OCR from a scanned image/.test(b)), JSON.stringify(scanned.basis));
  check("a clean answer says nothing about OCR at all",
    !clean.basis.some((b) => /OCR/.test(b)), JSON.stringify(clean.basis));
}

/* ----------------------------------------------------------------- helper */

/** A pass that behaves like the real child on a document with no text layer. */
async function scannedPass(buf, opts) {
  if (!opts?.withPageImages) return { body: "", totalPages: 1, perPage: 0, pageImages: null };
  const rendered = await renderPdfPageImages(new Uint8Array(buf), { maxPages: opts.withPageImages });
  return { body: "", totalPages: rendered.totalPages, perPage: 0, pageImages: rendered.pages };
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
