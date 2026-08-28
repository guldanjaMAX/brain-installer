/**
 * A PDF page, as an image, with NO native module.
 *
 * THE DAY-ZERO QUESTION THIS FILE ANSWERS
 *
 * A vision model needs an encoded image. The obvious route, unpdf's
 * `renderPageAsImage`, is closed: it requires `@napi-rs/canvas`, a native
 * module, and refuses without one. Measured in this repo on 2026-08-28, Node
 * v24.13.1, unpdf 1.8.1, the exact refusal is:
 *
 *   Parameter "canvasImport" is required in Node.js environment.
 *
 * Taking that route would mean shipping per-platform native binaries inside a
 * `bundleDependencies` tarball, and `ingest/extract.mjs` opens by explaining
 * why that is not acceptable: this runs on the client's own machine during a
 * live install, and every package is one more thing that can fail on their
 * Windows box while someone watches.
 *
 * So the pixels come from the image objects the page already contains. A
 * scanned page IS one big image; there is nothing to rasterise, only something
 * to fetch. That is what PDF.js hands back, and encoding it is deflate plus
 * four chunks, which `fflate` already does and is already bundled.
 *
 * WHY THIS DOES NOT JUST CALL unpdf's `extractImages`
 *
 * Measured here on 2026-08-28 against three synthetic image-only PDFs:
 *
 *   8-bit DeviceRGB   -> PDF.js kind 2, data/(w*h) = 3.0   -> extractImages KEEPS it
 *   8-bit DeviceGray  -> PDF.js kind 2, data/(w*h) = 3.0   -> extractImages KEEPS it
 *   1-bit  (fax/CCITT)-> PDF.js kind 1, data/(w*h) = 0.125 -> extractImages DROPS it
 *
 * `extractImages` filters on `data.length / (width * height)` being exactly 1,
 * 3 or 4 (unpdf 1.8.1, dist/index.mjs:237-242). A 1-bit image is packed eight
 * pixels to the byte, so the ratio is 0.125 and the image is silently skipped.
 * 1-bit is precisely the fax and photocopier population this feature exists
 * for: older bank statements, county records, anything that went through a fax
 * machine. Dropping them would mean the highest-value scans stayed unreadable
 * while the feature reported success on the easy ones.
 *
 * So this goes one level down to the same PDF.js surface unpdf uses, and
 * expands packed 1-bit rows itself. Still zero new dependencies: everything
 * imported here is already in `bundleDependencies`.
 */

import { zlibSync } from "fflate";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

/**
 * Longest side of the image handed to the model.
 *
 * Dense small print needs resolution; a 300 DPI letter page is 2550x3300 and
 * would be ~8MB of PNG before base64. 1600px keeps 10pt text legible at the
 * ~150 DPI equivalent while landing a typical page well under the worker's
 * request ceiling.
 */
export const MAX_PAGE_DIMENSION = 1600;

/** PDF.js ImageKind. Named because the integers alone read as nothing. */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/* ------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 8-bit greyscale PNG.
 *
 * Greyscale on purpose. Colour carries no information a transcription needs,
 * and it triples both the payload the client pays to upload and the image
 * tokens they pay the model to read.
 */
export function encodeGrayPng(gray, width, height) {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter type 0 (None)
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0: greyscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

/* ---------------------------------------------------------------- pixels */

/** PDF.js image object -> one greyscale plane, whatever it arrived as. */
function toGray(image) {
  const { width, height, data, kind } = image;
  const pixels = width * height;
  const gray = new Uint8Array(pixels);

  const ratio = data.length / pixels;
  if (kind === GRAYSCALE_1BPP || ratio < 0.5) {
    // Packed one bit per pixel, MSB first, rows padded to a byte boundary.
    // In PDF.js's 1bpp output a SET bit is white and a clear bit is black.
    const rowBytes = Math.ceil(width / 8);
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x++) {
        gray[y * width + x] = data[row + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
    return gray;
  }

  if (kind === RGBA_32BPP || ratio === 4) {
    for (let i = 0, p = 0; p < pixels; i += 4, p++) {
      // Composite onto white: a transparent scan background must not read as
      // black ink.
      const a = data[i + 3] / 255;
      const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      gray[p] = Math.round(lum * a + 255 * (1 - a));
    }
    return gray;
  }

  if (kind === RGB_24BPP || ratio === 3) {
    for (let i = 0, p = 0; p < pixels; i += 3, p++) {
      gray[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }
    return gray;
  }

  if (ratio === 1) {
    gray.set(data.subarray(0, pixels));
    return gray;
  }

  return null;
}

/** Box-average downscale. Averaging, not sampling: dropping rows drops strokes. */
function downscale(gray, width, height, maxDim) {
  const longest = Math.max(width, height);
  if (longest <= maxDim) return { gray, width, height, scale: 1 };
  const scale = maxDim / longest;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) { sum += gray[yy * width + xx]; n++; }
      }
      out[y * w + x] = n ? Math.round(sum / n) : 255;
    }
  }
  return { gray: out, width: w, height: h, scale };
}

/**
 * Every image object painted on one page, greyscaled.
 *
 * Exported for testing without a child process.
 */
export async function pageImagePlanes(pdf, pageNumber) {
  const { OPS } = await getResolvedPDFJS();
  const page = await pdf.getPage(pageNumber);
  const operators = await page.getOperatorList();
  const planes = [];
  for (let i = 0; i < operators.fnArray.length; i++) {
    if (operators.fnArray[i] !== OPS.paintImageXObject) continue;
    const key = operators.argsArray[i][0];
    if (typeof key !== "string") continue;
    const store = key.startsWith("g_") ? page.commonObjs : page.objs;
    const image = await new Promise((resolve) => store.get(key, resolve));
    if (!image?.data || !image.width || !image.height) continue;
    const gray = toGray(image);
    if (!gray) continue;
    planes.push({ gray, width: image.width, height: image.height, key });
  }
  return planes;
}

/**
 * Combine the image objects on a page into one plane.
 *
 * A scanner that splits a page into horizontal strips is common, and every
 * strip shares the page width. Those are stacked in paint order. Anything else
 * is not guessed at: the largest image wins and the number left out is
 * REPORTED, so a half-read page is visible rather than silently partial.
 */
export function composePage(planes) {
  if (!planes.length) return null;
  if (planes.length === 1) return { ...planes[0], omitted: 0 };

  const width = planes[0].width;
  if (planes.every((p) => p.width === width)) {
    const height = planes.reduce((n, p) => n + p.height, 0);
    const gray = new Uint8Array(width * height);
    let at = 0;
    for (const p of planes) { gray.set(p.gray, at); at += p.gray.length; }
    return { gray, width, height, omitted: 0 };
  }

  let best = planes[0];
  for (const p of planes) if (p.width * p.height > best.width * best.height) best = p;
  return { ...best, omitted: planes.length - 1 };
}

/**
 * One page of a PDF as a base64 PNG, or null when the page holds no image.
 *
 * Null is a real answer and must not be smoothed into an empty image: a page
 * that is a vector drawing, or one whose only image object is in a colour
 * space this cannot read, has nothing for a model to transcribe, and saying so
 * is what stops a blank prompt coming back as an invented page.
 */
export async function renderPageImage(bytes, pageNumber, { maxDim = MAX_PAGE_DIMENSION } = {}) {
  const pdf = await getDocumentProxy(bytes);
  const composed = composePage(await pageImagePlanes(pdf, pageNumber));
  if (!composed) return null;
  const small = downscale(composed.gray, composed.width, composed.height, maxDim);
  const png = encodeGrayPng(small.gray, small.width, small.height);
  return {
    page: pageNumber,
    width: small.width,
    height: small.height,
    source_width: composed.width,
    source_height: composed.height,
    omitted_images: composed.omitted,
    png_base64: Buffer.from(png).toString("base64"),
  };
}

/** Every page of a PDF as a base64 PNG. Pages with no image come back null. */
export async function renderPdfPageImages(bytes, { maxPages = 0, maxDim = MAX_PAGE_DIMENSION } = {}) {
  const pdf = await getDocumentProxy(bytes);
  const total = pdf.numPages;
  const limit = maxPages > 0 ? Math.min(total, maxPages) : total;
  const pages = [];
  for (let n = 1; n <= limit; n++) {
    const composed = composePage(await pageImagePlanes(pdf, n));
    if (!composed) { pages.push(null); continue; }
    const small = downscale(composed.gray, composed.width, composed.height, maxDim);
    pages.push({
      page: n,
      width: small.width,
      height: small.height,
      source_width: composed.width,
      source_height: composed.height,
      omitted_images: composed.omitted,
      png_base64: Buffer.from(encodeGrayPng(small.gray, small.width, small.height)).toString("base64"),
    });
  }
  return { totalPages: total, rendered: limit, pages };
}
