/** Readable build source for bounded owner-upload extraction. */

import { strFromU8 } from "fflate";
import * as XLSX from "@e965/xlsx";
import PostalMime from "postal-mime";
import { extractZipEntries, ArchiveSafetyError } from "../../../ingest/archive.mjs";
import { isPptxSemanticEntry, renderPptxEntries } from "../../../ingest/pptx.mjs";
import { handleOcr, MAX_IMAGE_BASE64_BYTES } from "./ocr.js";

export const OWNER_BINARY_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const OWNER_IMAGE_UPLOAD_MAX_BYTES = Math.floor(MAX_IMAGE_BASE64_BYTES / 4) * 3;
export const OWNER_EXTRACTED_TEXT_MAX_BYTES = 1_000_000;
export const OWNER_BINARY_MEDIA = Object.freeze({
  "application/pdf": Object.freeze([".pdf"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze([".docx"]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": Object.freeze([".pptx"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": Object.freeze([".xlsx"]),
  "application/vnd.ms-excel": Object.freeze([".xls"]),
  "message/rfc822": Object.freeze([".eml"]),
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
});

const OFFICE_ARCHIVE_LIMITS = Object.freeze({
  maxCompressedBytes: OWNER_BINARY_UPLOAD_MAX_BYTES,
  maxExpandedBytes: 48 * 1024 * 1024,
  maxEntryBytes: 12 * 1024 * 1024,
  maxFiles: 1_024,
  maxNesting: 1,
  maxPathDepth: 16,
  maxCompressionRatio: 100,
});

const clean = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

function extractionError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function assertMediaSignature(mediaType, bytes) {
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
  const valid = mediaType === "application/pdf"
    ? startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
    : mediaType.includes("openxmlformats-officedocument")
      ? zip
      : mediaType === "application/vnd.ms-excel"
        ? startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
        : mediaType === "image/png"
          ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          : mediaType === "image/jpeg"
            ? startsWith(bytes, [0xff, 0xd8, 0xff])
            : true;
  if (!valid) throw extractionError("the file signature does not match its declared media type", "upload_media_mismatch");
}

export function decodeUploadBase64(value, { maxBytes = OWNER_BINARY_UPLOAD_MAX_BYTES } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const estimated = (text.length / 4) * 3 - padding;
  if (estimated > maxBytes) {
    throw extractionError("binary upload is over the size limit", "upload_too_large", { too_large: true });
  }
  if (!text || text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw extractionError("content_base64 is not canonical base64", "invalid_upload_base64");
  }
  let binary;
  try { binary = atob(text); }
  catch { throw extractionError("content_base64 is not canonical base64", "invalid_upload_base64"); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.byteLength > maxBytes || bytesToBase64(bytes) !== text) {
    if (bytes.byteLength > maxBytes) {
      throw extractionError("binary upload is over the size limit", "upload_too_large", { too_large: true });
    }
    throw extractionError("content_base64 is not canonical base64", "invalid_upload_base64");
  }
  return bytes;
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function xmlText(value) {
  return clean(decodeXmlEntities(String(value)
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<(?:\/w:p|\/a:p|w:br\s*\/)\s*>/g, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n"));
}

function officeEntries(bytes, select, label) {
  try {
    return extractZipEntries(bytes, { select, limits: OFFICE_ARCHIVE_LIMITS, label }).entries;
  } catch (error) {
    if (error instanceof ArchiveSafetyError) {
      throw extractionError("the Office file failed bounded archive validation", "unsafe_upload_archive", {
        archive_code: error.code,
      });
    }
    throw extractionError("the Office file is not a readable ZIP container", "unreadable_upload");
  }
}

function docx(bytes) {
  const entries = officeEntries(
    bytes,
    (name) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name),
    "Word upload",
  );
  return clean([...entries.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => xmlText(strFromU8(value))).filter(Boolean).join("\n\n"));
}

function pptx(bytes) {
  const entries = officeEntries(
    bytes,
    isPptxSemanticEntry,
    "PowerPoint upload",
  );
  return clean(renderPptxEntries(entries, xmlText).text);
}

function workbook(bytes, mediaType) {
  if (mediaType.includes("spreadsheetml")) {
    officeEntries(bytes, () => false, "Excel upload");
  }
  let book;
  try {
    book = XLSX.read(bytes, {
      type: "array", cellDates: true, cellFormula: false, cellHTML: false,
      dense: true, sheetRows: 5_002,
    });
  } catch {
    throw extractionError("the spreadsheet could not be opened", "unreadable_upload");
  }
  const output = [];
  let truncated = false;
  for (const name of book.SheetNames.slice(0, 100)) {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[name], {
      header: 1, raw: false, defval: "", blankrows: false,
    });
    if (!rows.length) continue;
    const limited = rows.slice(0, 5_001);
    const headers = limited[0].slice(0, 256).map((value, index) => clean(value) || `Column ${index + 1}`);
    const rendered = limited.slice(1).map((row) => headers.map((header, index) => {
      const value = clean(row[index]);
      return value ? `${header}: ${value}` : null;
    }).filter(Boolean).join("\n")).filter(Boolean);
    if (rendered.length) output.push([`Sheet: ${name}`, ...rendered].join("\n\n"));
    if (rows.length > limited.length) truncated = true;
  }
  if (book.SheetNames.length > 100) truncated = true;
  return { text: clean(output.join("\n\n---\n\n")), truncated };
}

async function email(bytes) {
  let mail;
  try { mail = await new PostalMime().parse(bytes); }
  catch { throw extractionError("the email file could not be opened", "unreadable_upload"); }
  const headers = [
    mail.from ? `From: ${mail.from.name || ""} <${mail.from.address || ""}>`.trim() : null,
    mail.to?.length ? `To: ${mail.to.map((item) => item.address).join(", ")}` : null,
    mail.date ? `Date: ${mail.date}` : null,
    mail.subject ? `Subject: ${mail.subject}` : null,
  ].filter(Boolean);
  const body = clean(mail.text || String(mail.html || "").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const attachments = (mail.attachments || []).map((item) => item.filename).filter(Boolean);
  if (attachments.length) headers.push(`Attachments named: ${attachments.slice(0, 100).join(", ")}`);
  return { text: clean([...headers, "", body].join("\n")), title: mail.subject || null, occurredAt: mail.date || null };
}

async function imageOcr(env, bytes, mediaType) {
  if (bytes.byteLength > OWNER_IMAGE_UPLOAD_MAX_BYTES) {
    throw extractionError("the image is over the private OCR request limit", "upload_too_large", { too_large: true });
  }
  const request = new Request("https://brain.invalid/api/admin/brain/ocr", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": env.ADMIN_KEY || "" },
    body: JSON.stringify({
      image_base64: bytesToBase64(bytes),
      image_media_type: mediaType,
      prompt: "Transcribe every readable word exactly. Preserve headings, line order, table labels, values, and dates. Do not summarize or infer missing text.",
    }),
  });
  const response = await handleOcr(env, request);
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    throw extractionError("private image OCR did not complete", result?.ocr_enabled === false
      ? "owner_upload_ocr_disabled"
      : result?.llm_cap_exceeded ? "owner_upload_ocr_spend_cap" : "owner_upload_ocr_unavailable", {
      status: response.status,
    });
  }
  return { text: clean(result.text), model: result.model || null };
}

function ensureTextLimit(text) {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > OWNER_EXTRACTED_TEXT_MAX_BYTES) {
    throw extractionError("the extracted text is over the owner upload limit", "extracted_text_too_large", {
      too_large: true,
    });
  }
  return bytes;
}

export async function extractOwnerUpload(env, { mediaType, bytes, fileName = null } = {}) {
  assertMediaSignature(mediaType, bytes);
  let text = "";
  let title = null;
  let occurredAt = null;
  let extractionMethod = "native";
  let note = null;
  if (mediaType === "application/pdf") {
    const { extractText } = await import("unpdf");
    let result;
    try { result = await extractText(bytes.slice(), { mergePages: true }); }
    catch { throw extractionError("the PDF could not be opened", "unreadable_upload"); }
    text = clean(result?.text);
    if (!text) {
      throw extractionError(
        "the PDF has no readable text layer; scanned PDF page OCR is not yet available in owner upload",
        "owner_upload_pdf_needs_ocr",
      );
    }
  } else if (mediaType.includes("wordprocessingml")) {
    text = docx(bytes);
  } else if (mediaType.includes("presentationml")) {
    text = pptx(bytes);
  } else if (mediaType.includes("spreadsheetml") || mediaType === "application/vnd.ms-excel") {
    const result = workbook(bytes, mediaType);
    text = result.text;
    note = result.truncated ? "Spreadsheet extraction stopped at the declared row or sheet limit; additional entries were not indexed" : null;
  } else if (mediaType === "message/rfc822") {
    const result = await email(bytes);
    text = result.text;
    title = result.title;
    occurredAt = result.occurredAt;
  } else if (mediaType === "image/png" || mediaType === "image/jpeg") {
    const result = await imageOcr(env, bytes, mediaType);
    text = result.text;
    extractionMethod = "ocr";
    note = result.model ? `Transcribed by ${result.model}` : "Transcribed by the configured OCR model";
  } else {
    throw extractionError("this binary media type is not supported", "unsupported_media");
  }
  if (!text) throw extractionError("the file contains no readable text", "unreadable_upload");
  const extractedBytes = ensureTextLimit(text);
  return {
    content: text,
    title: title || (fileName ? fileName.replace(/\.[^.]+$/, "") : null),
    occurredAt,
    textSource: extractionMethod === "ocr" ? "ocr" : "native",
    textReliable: extractionMethod !== "ocr",
    metadata: {
      extracted_as: mediaType,
      extraction_method: extractionMethod,
      original_bytes: bytes.byteLength,
      extracted_text_bytes: extractedBytes,
      ...(note ? { extraction_note: note } : {}),
    },
  };
}
