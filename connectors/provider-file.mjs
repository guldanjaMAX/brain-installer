/** Shared bounded body download and extraction for document providers. */

import "../ingest/formats.mjs";
import { canExtract, extract } from "../ingest/extract.mjs";
import { providerBytes } from "./provider-sync.mjs";

export const PROVIDER_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const PROVIDER_EXTRACTED_TEXT_MAX_BYTES = 8 * 1024 * 1024;

const safeName = (value) => {
  const last = String(value || "document").replace(/\\/g, "/").split("/").at(-1) || "document";
  return last.replace(/[\0\r\n]/g, " ").slice(0, 240);
};

export async function extractProviderFile(bytes, name, { provider } = {}) {
  const fileName = safeName(name);
  if (!canExtract(fileName)) {
    return { ok: false, permanent: true, code: "unsupported_file_type", reason: `${fileName} has no installed extractor` };
  }
  const got = await extract(Buffer.from(bytes), fileName);
  if (!got?.text?.trim()) {
    return {
      ok: false, permanent: true,
      code: got?.unsupported ? "unsupported_file_type" : "unreadable_file",
      reason: String(got?.error || `${fileName} contains no readable text`).slice(0, 240),
    };
  }
  const extractedBytes = Buffer.byteLength(got.text, "utf8");
  if (extractedBytes > PROVIDER_EXTRACTED_TEXT_MAX_BYTES) {
    return {
      ok: false, permanent: true, code: "extracted_text_too_large",
      reason: `${fileName} expands beyond the ${PROVIDER_EXTRACTED_TEXT_MAX_BYTES} byte extracted-text limit`,
    };
  }
  return {
    ok: true,
    content: got.text.trim(),
    provenance: {
      extraction_method: got.how || "native",
      text_source: got.provenance?.text_source || "native",
      text_reliable: got.provenance?.text_reliable !== false,
      original_bytes: bytes.byteLength,
      extracted_text_bytes: extractedBytes,
      ...(got.note ? { extraction_note: String(got.note).slice(0, 500) } : {}),
      provider,
    },
  };
}

export async function downloadProviderFile({
  provider,
  url,
  accessToken,
  fetchImpl = fetch,
  name,
  method = "GET",
  headers = {},
  body = undefined,
} = {}) {
  const { data, response } = await providerBytes(provider, url, {
    accessToken, fetchImpl, method, headers, body,
    maxResponseBytes: PROVIDER_FILE_MAX_BYTES,
  });
  return {
    ...await extractProviderFile(data, name, { provider }),
    response_media_type: response.headers?.get?.("content-type") || null,
  };
}
