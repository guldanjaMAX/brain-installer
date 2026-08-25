/**
 * Dependency-free envelope splitting and request batching.
 *
 * Migration tools use the same wire limits as ordinary ingest, but they do not
 * extract files. Keeping this module free of the format registry prevents a
 * migration-only process from loading PDF, spreadsheet, archive, or email
 * packages it will never call.
 */

/** Maximum content characters allowed in one document envelope. */
export const MAX_DOC_CHARS = 400_000;

/**
 * Split a document that cannot fit safely in one Worker request.
 *
 * Parts keep the original identity in their ids ("path#part2of3") so a
 * citation still points at the source document. Characters are the slicing
 * unit, but bytes are the request constraint, so multibyte text receives a
 * proportionally smaller character ceiling.
 */
export function splitOversized(envelope, maxChars = MAX_DOC_CHARS) {
  const text = envelope.content || "";
  const bytes = Buffer.byteLength(text, "utf8");
  const ratio = text.length ? bytes / text.length : 1;
  const effective = ratio > 1.05 ? Math.max(20_000, Math.floor(maxChars / ratio)) : maxChars;
  if (bytes <= effective * ratio && text.length <= effective) return [envelope];

  const parts = [];
  for (let i = 0; i < text.length; i += effective) parts.push(text.slice(i, i + effective));

  return parts.map((content, i) => ({
    ...envelope,
    source_id: `${envelope.source_id}#part${i + 1}of${parts.length}`,
    title: `${envelope.title || envelope.source_id} (part ${i + 1} of ${parts.length})`,
    content,
    metadata: {
      ...(envelope.metadata || {}),
      part: i + 1,
      part_count: parts.length,
      part_of: envelope.source_id,
    },
  }));
}

/** Measure the JSON bytes that actually travel over the wire. */
export function envelopeBytes(envelope) {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

/** Group wrapped envelopes below both Worker request ceilings. */
export function batches(items, { maxDocs = 50, maxBytes = 900_000 } = {}) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    const n = envelopeBytes(it.envelope);
    if (cur.length && (cur.length >= maxDocs || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
