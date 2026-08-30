import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "@e965/xlsx";
import {
  OWNER_BINARY_UPLOAD_MAX_BYTES,
  decodeUploadBase64,
  extractOwnerUpload,
} from "../src/lib/upload-extract.js";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

check("strict base64 decoding preserves exact bytes",
  [...decodeUploadBase64("AQIDBA==")].join(",") === "1,2,3,4");
for (const invalidValue of ["not-base64", "AQIDBA", "AQIDBA===", "A===", "===="]) {
  let invalid;
  try { decodeUploadBase64(invalidValue); } catch (error) { invalid = error; }
  check(`malformed base64 is refused: ${invalidValue}`, invalid?.code === "invalid_upload_base64");
}
let oversized;
try { decodeUploadBase64("A".repeat(Math.ceil((OWNER_BINARY_UPLOAD_MAX_BYTES + 1) / 3) * 4)); }
catch (error) { oversized = error; }
check("oversized base64 is refused before allocating decoded bytes", oversized?.too_large === true);

{
  let error;
  try {
    await extractOwnerUpload({}, {
      mediaType: "image/png", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), fileName: "mismatch.png",
    });
  } catch (caught) { error = caught; }
  check("binary content must match the declared media type before extraction", error?.code === "upload_media_mismatch");
}

{
  const bytes = zipSync({
    "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>Agreement title</w:t></w:r></w:p><w:p><w:r><w:t>Payment terms</w:t></w:r></w:p></w:body></w:document>"),
    "word/header1.xml": strToU8("<w:hdr><w:p><w:r><w:t>Fixture Company</w:t></w:r></w:p></w:hdr>"),
  });
  const result = await extractOwnerUpload({}, {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes, fileName: "agreement.docx",
  });
  check("Word upload includes body and header text", result.content.includes("Agreement title") && result.content.includes("Fixture Company"));
  check("Word upload declares native extraction provenance",
    result.textSource === "native" && result.metadata.original_bytes === bytes.length && result.metadata.extracted_text_bytes > 0);
}

{
  const bytes = zipSync({
    "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p></p:sld>"),
    "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:p><a:r><a:t>Owner note</a:t></a:r></a:p></p:notes>"),
  });
  const result = await extractOwnerUpload({}, {
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes, fileName: "plan.pptx",
  });
  check("PowerPoint upload includes slide and speaker-note text", result.content.includes("Quarterly plan") && result.content.includes("Owner note"));
}

{
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["Account", "Balance"], ["Operating", 1250.5], ["Reserve", 800],
  ]), "Cash");
  const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
  const result = await extractOwnerUpload({}, {
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes, fileName: "cash.xlsx",
  });
  check("spreadsheet upload names sheets and renders header-value rows",
    result.content.includes("Sheet: Cash") && result.content.includes("Account: Operating") && result.content.includes("Balance: 1250.5"));
}

{
  const message = strToU8([
    "From: Alex Example <alex@example.invalid>",
    "To: Riley Fixture <riley@example.invalid>",
    "Date: Sat, 29 Aug 2026 12:00:00 +0000",
    "Subject: Fixture decision", "Content-Type: text/plain; charset=utf-8", "",
    "This is the fixture email body.",
  ].join("\r\n"));
  const result = await extractOwnerUpload({}, { mediaType: "message/rfc822", bytes: message, fileName: "decision.eml" });
  check("mail upload decodes headers, subject, date, and body",
    result.title === "Fixture decision" && result.content.includes("alex@example.invalid") && result.content.includes("fixture email body") && result.occurredAt);
}

for (const [label, bytes, expectedCode] of [
  ["archive path traversal", zipSync({ "../outside.xml": strToU8("unsafe") }), "unsafe_upload_archive"],
  ["archive compression bomb", zipSync({ "word/document.xml": strToU8("A".repeat(1_000_000)) }, { level: 9 }), "unsafe_upload_archive"],
]) {
  let error;
  try {
    await extractOwnerUpload({}, {
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes, fileName: "unsafe.docx",
    });
  } catch (caught) { error = caught; }
  check(`${label} is refused by the common archive boundary`, error?.code === expectedCode, error?.code);
}

{
  let error;
  try {
    await extractOwnerUpload({ ADMIN_KEY: "fixture", OCR_ENABLED: "0" }, {
      mediaType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), fileName: "scan.jpg",
    });
  } catch (caught) { error = caught; }
  check("image upload reports that private OCR is off instead of calling it unreadable",
    error?.code === "owner_upload_ocr_disabled" && error?.status === 409);
}

{
  let error;
  try {
    await extractOwnerUpload({}, { mediaType: "application/pdf", bytes: strToU8("%PDF-1.7 invalid"), fileName: "bad.pdf" });
  } catch (caught) { error = caught; }
  check("a malformed PDF is an explicit unreadable upload", error?.code === "unreadable_upload");
}

console.log(`\nupload extraction: all ${ran} checks passed`);
