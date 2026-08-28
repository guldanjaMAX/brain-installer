/**
 * SMS as a message source, from two exports, platform `sms`.
 *
 * v0, same posture as ingest/whatsapp-export.mjs: no daemon, no live capture,
 * client exports from their own phone/account, drops the file(s) in a
 * folder, `brain ingest` sessionizes it through ingest/message-session.mjs.
 *
 *  - SMS Backup & Restore (Android app): one .xml file, root <smses>,
 *    self-closing <sms> elements, one per message, usually covering EVERY
 *    conversation at once (not one file per contact the way a WhatsApp
 *    export is).
 *  - Google Voice Takeout: one .html file per conversation, Google's own
 *    "hChatLog" microformat template.
 *
 * NEITHER FORMAT HAS WHATSAPP'S DATE-AMBIGUITY PROBLEM. SMS Backup & Restore
 * writes `date` as a Unix epoch in milliseconds; Google Voice Takeout writes
 * a full ISO-8601 timestamp WITH a UTC offset in the `title` attribute of
 * every message. Both are already unambiguous machine timestamps, not a
 * locale-dependent human date string, so there is nothing here to
 * disambiguate — only to parse correctly.
 *
 * WHAT THIS DOES NOT HANDLE (v0 scope, stated plainly)
 *
 * - MMS messages inside an SMS Backup & Restore export (the same app can
 *   also write <mms> elements, a more complex multi-part structure) are not
 *   parsed. Only <sms> elements are read. A real export with MMS in it still
 *   ingests every plain SMS in the file; the MMS entries are simply not
 *   among the rows produced.
 *  -Call-log-only Google Voice Takeout pages (no message text, e.g. a bare
 *   voicemail or missed-call record) produce zero rows and are skipped with
 *   a reason, not mis-parsed as empty conversations.
 */

const ENTITY_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** XML/HTML entity decoding shared by both formats: named, decimal, and hex. */
function unescapeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const codePoint = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, entity) ? ENTITY_MAP[entity] : match;
  });
}

/* ------------------------------------------------------- SMS Backup & Restore */

export function detectSmsBackupXml(text) {
  const head = String(text).slice(0, 1000);
  return /<smses\b/.test(head) && /<sms\b/.test(text);
}

function parseAttrs(attrString) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString))) attrs[m[1]] = unescapeEntities(m[2]);
  return attrs;
}

/**
 * @returns {{ rows: object[], messageCount: number, skippedEmpty: number, skippedMms: number }}
 */
export function parseSmsBackupXml(text, { sourceLabel = "sms-backup" } = {}) {
  const rows = [];
  let skippedEmpty = 0;
  const mmsCount = (text.match(/<mms\b/g) || []).length;

  const tagRe = /<sms\b([^>]*)\/>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const a = parseAttrs(m[1]);
    const body = String(a.body || "").trim();
    const dateMs = Number(a.date);
    const address = String(a.address || "unknown").trim();
    if (!body || body === "null" || !Number.isFinite(dateMs) || dateMs <= 0) {
      skippedEmpty++;
      continue;
    }
    const threadId = `${sourceLabel}:${address}`;
    const threadTitle = (a.contact_name && a.contact_name !== "null") ? a.contact_name : address;
    // type: 1 = received, 2 = sent. Anything else (drafts, failed, queued)
    // is treated as received rather than silently dropped, since the text
    // itself is still real correspondence worth keeping.
    const direction = a.type === "2" ? "out" : "in";
    rows.push({
      id: `${threadId}:${a.date}:${rows.length}`,
      platform: "sms",
      thread_id: threadId,
      thread_title: threadTitle,
      category: "message",
      ts: new Date(dateMs).toISOString(),
      sender_name: direction === "out" ? null : threadTitle,
      direction,
      body,
    });
  }

  rows.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  return { rows, messageCount: rows.length, skippedEmpty, skippedMms: mmsCount };
}

/* --------------------------------------------------------- Google Voice Takeout */

export function detectGoogleVoiceTakeout(text) {
  return /class=["']hChatLog/i.test(text);
}

/**
 * One "message" block:
 *   <div class="message">
 *     <abbr class="published" title="2024-01-01T12:00:00.000-08:00">...</abbr>
 *     <cite class="sender vcard">...<span class="fn">Name</span>...</cite>
 *     <q>text</q>
 *   </div>
 * Blocks with no <q> (a call or voicemail record sharing the same template)
 * are simply not matched by MESSAGE_BLOCK_RE's mandatory <q> group.
 */
const MESSAGE_BLOCK_RE =
  /<div class="message">([\s\S]*?)<\/div>/g;
const PUBLISHED_RE = /<abbr class="published"[^>]*\btitle="([^"]*)"/;
const SENDER_FN_RE = /<cite class="sender[^"]*"[^>]*>[\s\S]*?<span class="fn">([^<]*)<\/span>/;
const SENDER_TEL_RE = /<cite class="sender[^"]*"[^>]*>[\s\S]*?href="tel:([^"]*)"/;
const QUOTE_RE = /<q>([\s\S]*?)<\/q>/;

function stripTags(html) {
  return unescapeEntities(String(html).replace(/<[^>]*>/g, "")).trim();
}

/**
 * @returns {{ rows: object[], messageCount: number, skippedNonMessage: number }}
 */
export function parseGoogleVoiceTakeout(text, { threadId, threadTitle } = {}) {
  const rows = [];
  let skippedNonMessage = 0;
  let m;
  const blockRe = new RegExp(MESSAGE_BLOCK_RE.source, "g");
  while ((m = blockRe.exec(text))) {
    const block = m[1];
    const q = QUOTE_RE.exec(block);
    if (!q) { skippedNonMessage++; continue; }
    const body = stripTags(q[1]);
    if (!body) { skippedNonMessage++; continue; }
    const published = PUBLISHED_RE.exec(block);
    const iso = published ? new Date(published[1]).toISOString() : null;
    if (!iso || Number.isNaN(Date.parse(iso))) { skippedNonMessage++; continue; }
    const fn = SENDER_FN_RE.exec(block);
    const tel = SENDER_TEL_RE.exec(block);
    const sender = fn && fn[1].trim() ? unescapeEntities(fn[1].trim()) : (tel ? tel[1].trim() : "Unknown");
    rows.push({
      id: `${threadId}:${iso}:${rows.length}`,
      platform: "sms",
      thread_id: threadId,
      thread_title: threadTitle,
      category: "message",
      ts: iso,
      sender_name: sender,
      body,
    });
  }
  rows.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  return { rows, messageCount: rows.length, skippedNonMessage };
}

/** "John Doe - Text - 2024-01-01T12_00_00Z.html" -> "John Doe". Falls back to the filename. */
export function deriveVoiceThreadTitle(filename) {
  const base = String(filename).replace(/\.[^.]+$/, "");
  const m = /^(.+?) - (?:Text|Group Conversation)/i.exec(base);
  return (m ? m[1] : base).trim() || base;
}
