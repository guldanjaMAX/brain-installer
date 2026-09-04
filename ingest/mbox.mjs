/**
 * mbox archives: one file, many messages.
 *
 * THE FAILURE THIS PREVENTS. An mbox is a mail folder, not a document. Indexed
 * whole it becomes one enormous "document" whose date is whatever the first
 * message happened to be, whose title is a filename, and whose chunks each
 * straddle the boundary between two unrelated conversations. Retrieval then
 * cites "Inbox.mbox" for a question about one message from one person, and the
 * citation is useless to the person reading it. So the archive is split first
 * and each message becomes its own document, exactly as a `.eml` of that same
 * message would have.
 *
 * NOTHING HERE PARSES A MESSAGE. Splitting is all this module does; every
 * message is then handed to the existing `.eml` path, which already decodes
 * MIME, RFC 2047 encoded subjects and multipart bodies. A second mail parser
 * living next to the first is how the two start disagreeing about what a
 * message says.
 */

/**
 * The delimiter. A message begins at a line starting with "From " that is
 * either the first line of the file or preceded by a blank line.
 *
 * Both halves matter. Without the "From " prefix requirement nothing splits;
 * without the blank-line requirement, a message whose body quotes an email
 * header block ("From Alex, on Tuesday...") splits into two half-messages,
 * and the second one loses its headers entirely.
 */
const FROM_LINE = /^From \S/;

const isMboxWhitespace = (byte) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a ||
  byte === 0x0b || byte === 0x0c || byte === 0x0d;

const isBufferBlank = (line) => {
  for (const byte of line) {
    if (!isMboxWhitespace(byte)) return false;
  }
  return true;
};

const isBufferFromLine = (line) =>
  line.length > 5 &&
  line[0] === 0x46 && line[1] === 0x72 && line[2] === 0x6f &&
  line[3] === 0x6d && line[4] === 0x20 &&
  !isMboxWhitespace(line[5]);

const unquoteFromBuffer = (line) => {
  let offset = 0;
  while (offset < line.length && line[offset] === 0x3e) offset++;
  return offset > 0 && isBufferFromLine(line.subarray(offset)) ? line.subarray(1) : line;
};

const LF = Buffer.from("\n");

/**
 * Incremental mbox delimiter reader.
 *
 * A Takeout archive is commonly much larger than one document. The local
 * ingest path therefore feeds this splitter fixed-size file chunks, rather
 * than turning the entire archive into one JavaScript string. Only complete
 * messages wholly inside `maxScanBytes` are returned. One pathological message
 * also cannot consume the whole process: it is represented by an `oversized`
 * result and scanning resumes at its next From_ delimiter.
 *
 * `push()` returns messages completed by the supplied chunk. `finish()` must be
 * called exactly once; it returns the final message only when the input ended
 * inside the scan budget. The public `stats` object makes both forms of loss
 * explicit to the caller.
 */
export class MboxStreamSplitter {
  constructor({ maxScanBytes, maxMessageBytes } = {}) {
    if (!Number.isSafeInteger(maxScanBytes) || maxScanBytes < 1) {
      throw new TypeError("maxScanBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
      throw new TypeError("maxMessageBytes must be a positive safe integer");
    }
    this.maxScanBytes = maxScanBytes;
    this.maxMessageBytes = maxMessageBytes;
    this.totalBytes = 0;
    this.scannedBytes = 0;
    this.separatorLines = 0;
    this.messageCount = 0;
    this.oversizedMessages = 0;
    this.truncated = false;
    this.droppedPartialMessage = false;
    this.previousBlank = true;
    this.current = false;
    this.currentOversized = false;
    this.currentChunks = [];
    this.currentPending = [];
    this.currentPendingBytes = 0;
    this.currentBytes = 0;
    this.tail = Buffer.alloc(0);
    this.discardingLongLine = false;
    this.finished = false;
  }

  get stats() {
    return {
      maxScanBytes: this.maxScanBytes,
      maxMessageBytes: this.maxMessageBytes,
      totalBytes: this.totalBytes,
      scannedBytes: this.scannedBytes,
      separatorLines: this.separatorLines,
      messageCount: this.messageCount,
      oversizedMessages: this.oversizedMessages,
      truncated: this.truncated,
      droppedPartialMessage: this.droppedPartialMessage,
    };
  }

  #markCurrentOversized() {
    if (!this.current || this.currentOversized) return;
    this.currentOversized = true;
    this.currentChunks = [];
    this.currentPending = [];
    this.currentPendingBytes = 0;
    this.currentBytes = 0;
  }

  #flushCurrentPending() {
    if (!this.currentPendingBytes) return;
    this.currentChunks.push(Buffer.concat(this.currentPending, this.currentPendingBytes));
    this.currentPending = [];
    this.currentPendingBytes = 0;
  }

  #appendLine(line) {
    if (!this.current || this.currentOversized) return;
    const value = unquoteFromBuffer(line);
    const added = value.length + 1;
    if (this.currentBytes + added > this.maxMessageBytes) {
      this.#markCurrentOversized();
      return;
    }
    if (value.length) {
      this.currentPending.push(Buffer.from(value));
      this.currentPendingBytes += value.length;
    }
    this.currentPending.push(LF);
    this.currentPendingBytes++;
    this.currentBytes += added;
    // Bound object overhead as well as bytes. A malicious message made of
    // millions of one-byte lines must not build millions of Buffer objects.
    if (this.currentPendingBytes >= 64 * 1024 || this.currentPending.length >= 1_024) {
      this.#flushCurrentPending();
    }
  }

  #completeCurrent(output) {
    if (!this.current) return;
    if (this.currentOversized) {
      this.messageCount++;
      this.oversizedMessages++;
      output.push({ ordinal: this.messageCount, oversized: true });
    } else if (this.currentBytes > 0) {
      this.#flushCurrentPending();
      const message = Buffer.concat(this.currentChunks, this.currentBytes);
      if (!isBufferBlank(message)) {
        this.messageCount++;
        output.push({ ordinal: this.messageCount, message });
      }
    }
    this.current = false;
    this.currentOversized = false;
    this.currentChunks = [];
    this.currentPending = [];
    this.currentPendingBytes = 0;
    this.currentBytes = 0;
  }

  #line(line, output) {
    if (this.previousBlank && isBufferFromLine(line)) {
      this.#completeCurrent(output);
      this.separatorLines++;
      this.current = true;
      this.previousBlank = false;
      return;
    }
    this.#appendLine(line);
    this.previousBlank = isBufferBlank(line);
  }

  #consume(input, output) {
    let source = input;
    if (this.discardingLongLine) {
      const newline = source.indexOf(0x0a);
      if (newline === -1) return;
      this.discardingLongLine = false;
      this.previousBlank = false;
      source = source.subarray(newline + 1);
    }

    const data = this.tail.length ? Buffer.concat([this.tail, source]) : source;
    this.tail = Buffer.alloc(0);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      if (newline === -1) break;
      let line = data.subarray(start, newline);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      this.#line(line, output);
      start = newline + 1;
    }

    if (start < data.length) {
      const remainder = data.subarray(start);
      if (remainder.length > this.maxMessageBytes) {
        this.#markCurrentOversized();
        this.discardingLongLine = true;
      } else {
        this.tail = Buffer.from(remainder);
      }
    }
  }

  push(chunk) {
    if (this.finished) throw new Error("cannot push to a finished mbox splitter");
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    this.totalBytes += input.length;
    const remaining = this.maxScanBytes - this.scannedBytes;
    if (remaining <= 0) {
      if (input.length) this.truncated = true;
      return [];
    }
    const accepted = input.length > remaining ? input.subarray(0, remaining) : input;
    this.scannedBytes += accepted.length;
    if (accepted.length < input.length) this.truncated = true;
    const output = [];
    if (accepted.length) this.#consume(accepted, output);
    return output;
  }

  finish() {
    if (this.finished) throw new Error("mbox splitter finish() may only be called once");
    this.finished = true;
    const output = [];
    if (this.truncated) {
      this.droppedPartialMessage = this.current || this.tail.length > 0 || this.discardingLongLine;
      this.current = false;
      this.currentChunks = [];
      this.currentPending = [];
      this.currentPendingBytes = 0;
      this.currentBytes = 0;
      this.tail = Buffer.alloc(0);
      return output;
    }
    if (this.discardingLongLine) {
      this.#markCurrentOversized();
      this.previousBlank = false;
    } else if (this.tail.length) {
      let line = this.tail;
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      this.#line(line, output);
    }
    this.tail = Buffer.alloc(0);
    this.#completeCurrent(output);
    return output;
  }
}

/**
 * Split an mbox archive into raw RFC 822 messages.
 *
 * Returns a flat array of strings, each one a complete message ready for the
 * `.eml` reader. An archive with no delimiter at all returns an empty array,
 * which the caller reports as "this is not an mbox" rather than indexing the
 * bytes as if they were prose.
 */
export function splitMbox(text) {
  const lines = String(text || "").split(/\r?\n/);
  const messages = [];
  let current = null;
  let previousBlank = true;

  for (const line of lines) {
    if (previousBlank && FROM_LINE.test(line)) {
      if (current) messages.push(current);
      // The "From " separator line itself is not part of the message. It
      // carries only the envelope sender and a non-standard date format that
      // the real Date header already states properly.
      current = [];
      previousBlank = false;
      continue;
    }
    if (current) current.push(unquoteFromLine(line));
    previousBlank = line.trim() === "";
  }
  if (current) messages.push(current);

  return messages
    .map((body) => body.join("\n").replace(/\s+$/, ""))
    .filter((body) => body.trim().length > 0);
}

/**
 * Undo the mbox quoting of a body line that looked like a delimiter.
 *
 * Writers escape a body line beginning with "From " by prefixing ">". The
 * mboxrd convention also escapes an already-escaped line (">From " becomes
 * ">>From "), which makes the transformation reversible: strip exactly one ">"
 * from any run of them that precedes "From ". mboxo, which escapes only the
 * bare form, is a lossy format by construction, and its ambiguous case — a
 * genuine quoted reply line reading "From " — is rarer than the escaped case
 * this repairs.
 */
export function unquoteFromLine(line) {
  return /^>+From /.test(line) ? line.slice(1) : line;
}

/**
 * A stable identity for one message inside one archive.
 *
 * The Message-ID is the message's own identity and survives the archive being
 * re-exported with more mail in it, which an ordinal position does not. It is
 * scoped to the archive's path anyway so that the same message appearing in
 * two exports cannot have two files fighting over one document.
 */
export function mboxMessageKey(relPath, messageId, ordinal) {
  const id = String(messageId || "").trim().replace(/^<|>$/g, "").replace(/[\s/]+/g, "_");
  return `${relPath}#${id ? id.slice(0, 200) : `message-${ordinal}`}`;
}
