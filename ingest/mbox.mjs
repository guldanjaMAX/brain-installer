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
