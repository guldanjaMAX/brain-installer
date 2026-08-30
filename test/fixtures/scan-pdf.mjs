/**
 * Synthetic PDFs for the OCR path.
 *
 * Built byte by byte rather than checked in as binaries, because a fixture you
 * can read is a fixture you can trust: every one of these is provably a scan
 * (an image object and not one text operator) or provably not, and the
 * difference is visible in this file instead of hidden inside a blob.
 *
 * No real document is used. Nothing here names a person, a business or an
 * account. `scanPdf` paints synthetic ink; the words a test expects back are
 * whatever the stubbed model is told to return.
 */

import { deflateSync } from "node:zlib";

function assemble(objects) {
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((object, index) => {
    const n = index + 1;
    const body = typeof object === "string"
      ? Buffer.from(`${n} 0 obj\n${object}\nendobj\n`)
      : Buffer.concat([
        Buffer.from(`${n} 0 obj\n${object.dict}\nstream\n`),
        object.stream,
        Buffer.from("\nendstream\nendobj\n"),
      ]);
    offsets.push(pos);
    parts.push(body);
    pos += body.length;
  });
  const xrefAt = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

/**
 * A scanned page: one image object, zero text operators.
 *
 * `depth: 1` produces the packed one-bit-per-pixel image a fax machine or a
 * bilevel photocopier makes, which is the case unpdf's own `extractImages`
 * drops on the floor.
 */
export function scanPdf({ width = 160, height = 100, pages = 1, depth = 8, gray = true } = {}) {
  const channels = gray ? 1 : 3;
  let raw;
  if (depth === 1) {
    const rowBytes = Math.ceil(width / 8);
    raw = Buffer.alloc(rowBytes * height, 0xff);
    for (let y = 20; y < 40; y++) {
      for (let x = 12; x < width - 12; x++) raw[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  } else {
    raw = Buffer.alloc(width * height * channels, 0xff);
    for (let y = 20; y < 40; y++) {
      for (let x = 12; x < width - 12; x++) {
        const at = (y * width + x) * channels;
        for (let c = 0; c < channels; c++) raw[at + c] = 0x11;
      }
    }
  }
  const image = deflateSync(raw);
  const content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`);

  const kids = [];
  const objects = [null, null];
  for (let p = 0; p < pages; p++) kids.push(`${3 + p} 0 R`);
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  const contentObj = 3 + pages;
  const imageObj = 4 + pages;
  for (let p = 0; p < pages; p++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
  }
  objects.push({ dict: `<< /Length ${content.length} >>`, stream: content });
  objects.push({
    dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace ${gray ? "/DeviceGray" : "/DeviceRGB"} /BitsPerComponent ${depth} ` +
      `/Filter /FlateDecode /Length ${image.length} >>`,
    stream: image,
  });
  return assemble(objects);
}

/** A page with an ordinary text layer. The control: this must never reach OCR. */
export function textPdf(line = "This page has a real text layer and must never be sent to OCR.") {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${line}) Tj\nET\n`;
  return assemble([
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    { dict: `<< /Length ${Buffer.byteLength(stream)} >>`, stream: Buffer.from(stream) },
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ]);
}

/** A page with neither text nor an image: nothing for OCR to look at. */
export function blankPdf() {
  const content = Buffer.from("q Q");
  return assemble([
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>`,
    { dict: `<< /Length ${content.length} >>`, stream: content },
  ]);
}
