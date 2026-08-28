/**
 * chunking — cut documents so the WHOLE of each piece reaches the embedder.
 *
 * WHY THIS FILE EXISTS
 *
 * The embedding model (`@cf/baai/bge-base-en-v1.5`) is a BERT-base encoder with
 * 512 positions. Text past that ceiling is not rejected and not reported: the
 * model reads the head and drops the tail, and the vector it returns describes
 * only what it read. The dropped text is still stored in D1, so keyword search
 * finds it and meaning-based search never can. Nothing anywhere says so.
 *
 * The ceiling is counted in TOKENS. Every measurement in this product used to
 * be counted in CHARACTERS, which is a proxy that fails exactly where it
 * matters: 1,500 characters of ordinary prose is roughly 330 tokens and fits
 * comfortably, while 1,500 characters of transaction rows, JSON, or Japanese is
 * 800 to 1,500 tokens and is cut by half or more. A character cap therefore
 * reads clean on precisely the documents that are being truncated.
 *
 * So this module measures tokens, and the chunker's window is whatever number
 * of characters keeps the text that will actually be embedded — HEADER INCLUDED
 * — inside the budget.
 *
 * WHAT IS EXACT AND WHAT IS ESTIMATED, stated rather than glossed
 *
 *  - `basicTokenFloor()` is a PROVEN LOWER BOUND. It reproduces BERT's
 *    BasicTokenizer (whitespace split, every punctuation and CJK character
 *    isolated). WordPiece then turns each of those into one OR MORE subword
 *    tokens, so the true count can never be lower. When this floor alone
 *    exceeds the window, truncation is a fact and not an opinion.
 *  - `estimateEmbedTokens()` is an ESTIMATE. Running the real WordPiece
 *    tokenizer would mean shipping a 30k-entry vocabulary into a Worker, and no
 *    useful upper bound exists without it. The estimate is deliberately biased
 *    to over-count (about 1.2 to 1.4x on English prose), it is never below the
 *    provable floor, and `EMBED_TOKEN_BUDGET` leaves a further 110-token margin
 *    under the model's real ceiling. Anywhere this number reaches an owner it
 *    is labelled an estimate.
 *
 * This module has NO imports on purpose. The Worker, the installer's ingest
 * batcher, and the migration tools all need the same geometry, and a copy that
 * drifts is how a batch gets sized against arithmetic the Worker no longer
 * uses.
 */

/** Positions in the encoder. Two of them are always [CLS] and [SEP]. */
export const EMBED_TOKEN_LIMIT = 512;

/** Content tokens the model can actually read, once [CLS] and [SEP] are spent. */
export const EMBED_CONTENT_LIMIT = EMBED_TOKEN_LIMIT - 2;

/**
 * What one chunk, header included, is allowed to spend.
 *
 * The 110-token gap under EMBED_CONTENT_LIMIT is the margin for estimator
 * error. It is not decoration: the estimate is an estimate, and a budget with
 * no headroom would convert every estimator miss into silent truncation, which
 * is the exact failure this file exists to end.
 */
export const EMBED_TOKEN_BUDGET = 400;

/**
 * Character geometry. `size` is still a real cap — it bounds a D1 row and keeps
 * one chunk from becoming a whole document on sparse text — but on dense text
 * the token budget binds first and the window shrinks below it.
 */
export const CHUNK_SIZE = 1500;
export const CHUNK_OVERLAP = 300;

/**
 * Cloudflare's paid Workers limit counts every statement submitted through a
 * D1 batch, not merely one service-binding round trip. Leave ten percent of the
 * 1,000-query invocation limit for platform/runtime evolution rather than
 * discovering the cap after half a request has durable pending revisions.
 */
export const D1_INGEST_STATEMENT_BUDGET = 900;

const SPACE = 0;
const LATIN = 1;
const DIGIT = 2;
const OTHER = 3;

/**
 * Three classes, and the boundary between them is drawn to over-count.
 *
 * "Latin" is only the alphabets bert-base-uncased actually has subword pieces
 * for. Everything else — CJK, kana, Cyrillic, Greek, Arabic, Devanagari,
 * emoji, punctuation, symbols — is charged one token per character, which is
 * what the tokenizer does to CJK by rule and close to what it does to the
 * others in practice.
 */
function classOf(cp) {
  if (cp === 32 || (cp >= 9 && cp <= 13) || cp === 0x85 || cp === 0xa0 ||
      (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 ||
      cp === 0x202f || cp === 0x205f || cp === 0x3000) return SPACE;
  if (cp >= 48 && cp <= 57) return DIGIT;
  if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return LATIN;
  if (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) return LATIN;
  return OTHER;
}

/**
 * Tokens a run of `length` same-class characters costs.
 *
 * Latin: the first four characters are one piece and every further four add
 * one. Measured against bert-base-uncased this sits above the real count for
 * ordinary words (which are usually a single piece) and close to it for the
 * long compounds WordPiece really does split.
 *
 * Digits: two characters per piece. The vocabulary holds most one- to
 * three-digit sequences, so this over-counts long numbers, which is the safe
 * direction for ledgers and identifiers.
 */
function runTokens(kind, length) {
  if (length <= 0) return 0;
  if (kind === DIGIT) return length <= 2 ? 1 : Math.ceil(length / 2);
  if (kind === LATIN) return length <= 4 ? 1 : 1 + Math.ceil((length - 4) / 4);
  return length;
}

/**
 * Walk `text` from `from`, charging tokens, and stop at the first position that
 * would exceed `budget`.
 *
 * One forward pass, no slicing and no binary search, so the chunker and the
 * pre-write statement estimate can both use it on a 400,000-character document
 * without turning request sizing into a CPU cost.
 *
 * Returns the end offset reached, the tokens spent, and whether anything other
 * than whitespace was seen (an all-whitespace window produces no chunk).
 */
function scan(text, from, limit, budget) {
  let i = from;
  let tokens = 0;
  let runKind = SPACE;
  let runLength = 0;
  let content = false;
  while (i < limit) {
    const cp = text.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    const kind = classOf(cp);
    let cost;
    if (kind === SPACE) {
      runKind = SPACE;
      runLength = 0;
      cost = 0;
    } else if (kind === OTHER) {
      runKind = SPACE;
      runLength = 0;
      cost = 1;
    } else if (kind === runKind) {
      cost = runTokens(kind, runLength + 1) - runTokens(kind, runLength);
    } else {
      runKind = kind;
      runLength = 0;
      cost = 1;
    }
    if (budget !== null && tokens + cost > budget) break;
    if (kind === LATIN || kind === DIGIT) runLength += 1;
    if (kind !== SPACE) content = true;
    tokens += cost;
    i += width;
  }
  return { end: i, tokens, content };
}

/**
 * Estimated WordPiece tokens for `text`, EXCLUDING [CLS] and [SEP].
 *
 * Excluding them keeps the arithmetic additive: a header and a body can be
 * measured separately and added, which is what the chunker does.
 */
export function estimateEmbedTokens(text) {
  const body = String(text ?? "");
  return scan(body, 0, body.length, null).tokens;
}

/**
 * A PROVEN LOWER BOUND on the true token count, excluding [CLS] and [SEP].
 *
 * BERT's BasicTokenizer splits on whitespace and isolates every punctuation and
 * CJK character; WordPiece then expands each of those pieces into one or more
 * tokens. The count below therefore can never exceed the real one. It is what
 * lets an owner-facing surface say a chunk IS truncated rather than may be.
 */
export function basicTokenFloor(text) {
  const body = String(text ?? "");
  let n = 0;
  let inWord = false;
  for (let i = 0; i < body.length;) {
    const cp = body.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    const kind = classOf(cp);
    if (kind === SPACE) { inWord = false; continue; }
    if (kind === OTHER) {
      // Punctuation and CJK are isolated by BasicTokenizer; so is anything the
      // uncased vocabulary has no run pieces for.
      n += 1;
      inWord = false;
      continue;
    }
    if (!inWord) { n += 1; inWord = true; }
  }
  return n;
}

export function chunkGeometry(env = {}) {
  const rawSize = Number.parseInt(env.CHUNK_SIZE, 10);
  const rawOverlap = Number.parseInt(env.CHUNK_OVERLAP, 10);
  const size = Number.isFinite(rawSize) ? Math.min(Math.max(rawSize, 256), 1800) : CHUNK_SIZE;
  const overlap = Number.isFinite(rawOverlap) ? Math.min(Math.max(rawOverlap, 0), size - 1) : CHUNK_OVERLAP;
  return { size, overlap };
}

/** The `[Title]` line that rides on every chunk, and what it costs to embed. */
export function chunkHeader(title) {
  return title ? `[${title}]` : "";
}

function budgetFor(header, tokenBudget) {
  const prefix = header ? `${header}\n\n` : "";
  // The header is embedded with every chunk, so it spends the same budget the
  // body does. Adding it after the slice — which is what this code used to do —
  // is how a "1,500 character" chunk became a 1,521 character embed.
  return Math.max(1, tokenBudget - estimateEmbedTokens(prefix));
}

/**
 * The windows this document will be cut into, as [start, end) offsets.
 *
 * A window ends at whichever comes first: the character cap, the token budget,
 * or the end of the document. The step is a PROPORTION of the window rather
 * than a fixed character count, so a window that shrank to fit dense text does
 * not also collapse its step and emit ninety percent redundant chunks.
 */
function* chunkWindows(body, { size, overlap, budget }) {
  const n = body.length;
  const ratio = size > 0 ? Math.min(overlap / size, 0.999) : 0;
  let start = 0;
  while (start < n) {
    const hardEnd = Math.min(start + size, n);
    const { end, content } = scan(body, start, hardEnd, budget);
    // Never stand still. One character can cost at most one token and the
    // budget is at least one, so this only guards against a caller passing
    // geometry that would otherwise loop.
    const stop = Math.max(end, start + 1);
    yield { start, end: stop, content };
    if (stop >= n) return;
    const window = stop - start;
    start += Math.max(1, window - Math.floor(window * ratio));
  }
}

/**
 * Sliding window, same geometry as the Drive indexer so a document chunked by
 * either path lands the same way and a citation means the same thing.
 *
 * The document's identity is prepended to every chunk BEFORE embedding, so a
 * fragment that says only "we agreed to defer it" still carries what "it" was
 * about. Cheap, and it is the difference between a retrievable chunk and a
 * floating sentence.
 */
export function chunkText(text, {
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
  header = "",
  tokenBudget = EMBED_TOKEN_BUDGET,
  trim = true,
} = {}) {
  const body = String(text || "");
  if (!body.trim()) return [];
  const prefix = header ? `${header}\n\n` : "";
  const budget = budgetFor(header, tokenBudget);
  const out = [];
  for (const window of chunkWindows(body, { size, overlap, budget })) {
    if (!window.content) continue;
    const raw = body.slice(window.start, window.end);
    // `trim: false` exists for ONE caller: the refit, which re-splits chunks
    // already stored in D1. Overlapping ingest windows can afford to drop the
    // whitespace at a boundary because the neighbouring window still carries
    // it. A refit has no overlap and no source file, so trimming there would
    // quietly delete characters from the only copy of the text.
    const piece = trim ? raw.trim() : raw;
    if (piece.trim()) out.push(prefix ? prefix + piece : piece);
  }
  return out;
}

/**
 * How many chunks this content will produce. EXACT, not an approximation.
 *
 * It used to be a closed-form guess from the character length, which was safe
 * only while every window was the same width. Token-bounded windows are not,
 * and a guess that under-counts dense text is a batch the Worker refuses with a
 * 413 after the caller has already committed to sending it.
 */
export function chunkCount(content, geometry = {}, header = "") {
  const body = String(content || "");
  if (!body.trim()) return 0;
  const size = geometry.size ?? CHUNK_SIZE;
  const overlap = geometry.overlap ?? CHUNK_OVERLAP;
  const budget = budgetFor(header, geometry.tokenBudget ?? EMBED_TOKEN_BUDGET);
  let n = 0;
  for (const window of chunkWindows(body, { size, overlap, budget })) {
    if (window.content) n += 1;
  }
  return n;
}

/**
 * Bound one HTTP batch before its first D1 statement.
 *
 * This intentionally assumes every document changed, every unique-document
 * preflight failed after consuming its reads, every source needs its own stats
 * refresh/readback, and every document needs the larger resumable stage. The
 * estimate is therefore above the normal path (50 one-chunk messages submit
 * 352 statements but reserve 550) while still accepting that replay shape.
 */
export function estimateD1IngestStatements(env, envelopes) {
  const geometry = chunkGeometry(env);
  return (envelopes || []).reduce((total, envelope) => {
    const chunks = chunkCount(envelope?.content, geometry, chunkHeader(envelope?.title));
    return total + 9 + (chunks * 2);
  }, 0);
}

/**
 * Does this stored chunk fit the embedder, and how certain is that answer?
 *
 * `truncated` is only ever true when the PROVABLE floor is past the model's
 * ceiling. `over_budget` is the estimate-driven judgement the refit acts on.
 * Keeping them apart is the difference between "this text is being cut" and
 * "this text is close enough to the ceiling that we will not gamble on it".
 */
export function chunkFit(text) {
  const estimated = estimateEmbedTokens(text);
  const floor = basicTokenFloor(text);
  return {
    estimated_tokens: estimated,
    floor_tokens: floor,
    over_budget: estimated > EMBED_TOKEN_BUDGET,
    truncated: floor > EMBED_CONTENT_LIMIT,
  };
}
