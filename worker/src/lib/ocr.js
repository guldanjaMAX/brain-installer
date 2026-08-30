// ocr.js — read one page of a scanned document, inside the client's own account.
//
// WHY THIS IS A WORKER ROUTE AND NOT A CALL FROM THE INSTALLER
//
// The installer could reach Cloudflare's REST API directly with an account
// token and get the same model. It must not, for three reasons that all point
// the same way.
//
// The estimated-spend budget lives here. `callLLM` atomically reserves before
// every provider call and fails closed when the ledger is unavailable. A CLI-side REST call
// would walk straight past all of it, on the client's own payment method, one
// page at a time. OCR is the first bulk, automatic, per-document inference cost
// this product has ever had; it is exactly the thing the budget was built for.
//
// The credential is already right. The installer holds the brain admin key. A
// direct REST path would mean a standing Cloudflare control-plane token present
// during routine ingest, which this product deliberately moved away from:
// ingest is a data-plane operation.
//
// And the binding is already there. Every install declares `[ai] binding =
// "AI"`, so the model runs in the client's account with no new resource, no new
// account, and nothing to revoke at handoff.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not use `env.AI.toMarkdown()`. That helper accepts PDFs and looks
// like the obvious answer, and it is the trap. Cloudflare's own description of
// its PDF path is metadata plus structure plus "extract the text of the page
// as-is" — no rasterisation and no vision model, which is precisely nothing on
// a page that has no text. Its IMAGE path is worse for this purpose: it runs a
// captioning prompt and returns a DESCRIPTION of the picture. A statement page
// through that comes back as prose about a document rather than the document,
// and indexing that as content is the fabrication this whole product exists to
// refuse.

import { jsonResponse, validateAdminKey, callLLM } from "./core.js";

export const OCR_PATH = "/api/admin/brain/ocr";

/** Default model. Overridable per install by the OCR_MODEL var. */
export const DEFAULT_OCR_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/**
 * One page image, base64. Larger than the ingest body limit on purpose: this
 * route carries a picture, and the ingest ceiling was sized for text. A 1600px
 * greyscale page PNG is comfortably inside this; a page that is not is a sign
 * the caller did not downscale.
 */
export const MAX_IMAGE_BASE64_BYTES = 4_000_000;

/** Ceiling on transcription length. A page of dense print is far under this. */
const MAX_OUTPUT_TOKENS = 2000;

export function ocrModelFor(env) {
  const configured = String(env.OCR_MODEL || "").trim();
  return configured || DEFAULT_OCR_MODEL;
}

/**
 * Is OCR switched on for this install?
 *
 * Off unless the manifest says otherwise, because turning it on changes ingest
 * from a free local operation into a metered one that bills the owner. An
 * upgrade must never quietly start spending.
 */
export function ocrEnabled(env) {
  const raw = env.OCR_ENABLED;
  return raw === true || raw === "1" || raw === "true";
}

/**
 * POST /api/admin/brain/ocr
 *
 * Body: { image_base64, page?, prompt }
 * Returns: { text, model, image_format, usage } or a refusal with the cause.
 *
 * One page per request, deliberately. A 40-page statement is 40 calls, which
 * keeps every page inside the cap check, inside the log, and inside a request
 * size that cannot be argued about.
 */
export async function handleOcr(env, request) {
  if (!validateAdminKey(request, env)) return jsonResponse({ error: "unauthorized" }, 401);

  if (!ocrEnabled(env)) {
    return jsonResponse({
      error: "OCR is not enabled on this brain",
      detail: "Set safety.ocr.enabled in the manifest and re-run `brain update`. It is off by default because it spends money on your own Cloudflare account, once per scanned page.",
      ocr_enabled: false,
    }, 409);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const image = typeof body?.image_base64 === "string" ? body.image_base64 : "";
  if (!image) return jsonResponse({ error: "image_base64 is required" }, 400);
  if (image.length > MAX_IMAGE_BASE64_BYTES) {
    return jsonResponse({
      error: `the page image is ${image.length} base64 bytes, over the ${MAX_IMAGE_BASE64_BYTES} limit`,
      detail: "Downscale the page before sending it. The installer renders at 1600px on the longest side, which is well inside this.",
    }, 413);
  }
  const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
  if (!prompt) return jsonResponse({ error: "prompt is required" }, 400);

  const model = ocrModelFor(env);
  const imageFormat = env.OCR_IMAGE_FORMAT === "image_field" ? "image_field" : "content_array";

  try {
    const data = await callLLM(env, {
      model,
      system: prompt,
      messages: [{ role: "user", content: "Transcribe this page." }],
      image,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Its own label so OCR spend is separable from answering in llm_call_log.
      label: "ocr",
    });
    const text = data?.content?.[0]?.text ?? "";
    return jsonResponse({
      text,
      model: data?.model || model,
      image_format: imageFormat,
      page: Number.isFinite(body?.page) ? body.page : null,
      usage: data?.usage || {},
    });
  } catch (error) {
    // A budget refusal, provider mismatch and outage are all statements about the
    // SYSTEM, never about the page. Returning any of them as "this page is
    // unreadable" would write a permanently wrong reason into the corpus, so
    // each keeps its own status and its own flag and the caller must not treat
    // them as evidence about the document.
    if (error?.llm_cap_exceeded) {
      return jsonResponse({
        error: "OCR stopped because the daily estimated-spend budget could not reserve this page",
        detail: String(error.message || error).slice(0, 300),
        llm_cap_exceeded: true,
        spend_guard_degraded: error.spend_guard_degraded === true || undefined,
      }, 429);
    }
    if (error?.spend_guard_unavailable) {
      return jsonResponse({
        error: "OCR paused because the spend reservation ledger is unavailable",
        detail: String(error.message || error).slice(0, 300),
        spend_guard_unavailable: true,
      }, 503);
    }
    if (error?.provider_mismatch) {
      return jsonResponse({
        error: "OCR refused rather than sending a scanned page to another provider",
        detail: String(error.message || error).slice(0, 300),
        provider_mismatch: true,
      }, 409);
    }
    return jsonResponse({
      error: "the OCR model call failed",
      // Verbatim, because if the image shape is wrong this sentence is the
      // whole diagnosis and paraphrasing it would cost an afternoon.
      detail: String(error?.message || error).slice(0, 400),
      model,
      image_format: imageFormat,
    }, 502);
  }
}
