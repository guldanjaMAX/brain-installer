/**
 * Dependency-free envelope splitting and request batching.
 *
 * Migration tools use the same wire limits as ordinary ingest, but they do not
 * extract files. Keeping this module free of the format registry prevents a
 * migration-only process from loading PDF, spreadsheet, archive, or email
 * packages it will never call.
 */

import { estimateD1IngestStatements } from "../worker/src/lib/chunking.js";

/** Maximum content characters allowed in one document envelope. */
export const MAX_DOC_CHARS = 400_000;

/**
 * One document part must always fit a batch by itself, or it can never be sent.
 * Ten percent under the worker's own 900-statement budget, same headroom the
 * batcher uses.
 */
export const PART_STATEMENT_CEILING = 810;

/** A floor on part size, so pathological density cannot shred a document. */
export const MIN_PART_CHARS = 20_000;

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
  let effective = ratio > 1.05 ? Math.max(20_000, Math.floor(maxChars / ratio)) : maxChars;

  // Bytes are not the only ceiling any more. Chunk windows are bounded by the
  // EMBEDDING window as well as by characters, so a part of dense text — a
  // ledger, a log, anything not in a Latin script — produces several times the
  // chunks its length suggests and can exceed the worker's statement budget on
  // its own. Measure the real text rather than assume a density: a part that
  // does not fit a batch alone is a 413 nothing downstream can recover from.
  for (let attempt = 0; attempt < 8 && effective > MIN_PART_CHARS; attempt++) {
    const probe = { ...envelope, content: text.slice(0, effective) };
    if (estimatedStatements(probe) <= PART_STATEMENT_CEILING) break;
    effective = Math.max(MIN_PART_CHARS, Math.floor(effective / 2));
  }

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

/**
 * The worker's D1 statement estimate for one envelope: 9 fixed statements plus
 * 2 per chunk.
 *
 * This used to be a hand-copied closed form over the character length, on the
 * grounds that this module stays dependency-free. That held only while every
 * chunk window was the same width. Windows are now bounded by the EMBEDDING
 * WINDOW as well, so a page of dense text produces several times as many chunks
 * as its character count suggests, and a copy that guessed low would size a
 * batch the worker then refuses with a 413 — after the caller has committed to
 * sending it. `worker/src/lib/chunking.js` imports nothing at all, so sharing
 * it keeps this module's real constraint (no extractor packages, no format
 * registry) while making drift impossible rather than merely tested for.
 */
export function estimatedStatements(envelope) {
  return estimateD1IngestStatements({}, [envelope]);
}

/**
 * Group wrapped envelopes below every Worker request ceiling.
 *
 * maxStatements packs to ten percent under the worker's own 900-statement
 * budget, so estimator drift fails SMALL (a slightly shorter batch) instead
 * of large (a refused 413 wall). Found live: a two-day Drive catch-up packed
 * fifty chunky documents — 1,666 estimated statements — into one call the
 * worker rightly refused. Document count and bytes alone cannot see chunk
 * weight. splitOversized caps any single document at ~677 statements, so one
 * item always fits a batch alone.
 */
export function batches(items, { maxDocs = 50, maxBytes = 900_000, maxStatements = 810 } = {}) {
  const out = [];
  let cur = [];
  let bytes = 0;
  let statements = 0;
  for (const it of items) {
    const n = envelopeBytes(it.envelope);
    const s = estimatedStatements(it.envelope);
    if (cur.length && (cur.length >= maxDocs || bytes + n > maxBytes || statements + s > maxStatements)) {
      out.push(cur);
      cur = [];
      bytes = 0;
      statements = 0;
    }
    cur.push(it);
    bytes += n;
    statements += s;
  }
  if (cur.length) out.push(cur);
  return out;
}
