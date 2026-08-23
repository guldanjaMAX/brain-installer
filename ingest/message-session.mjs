/**
 * Turn a chronological message stream into retrieval-safe documents.
 *
 * Email is already a coherent document and keeps its individual identity.
 * Short-form chat is grouped by thread into bounded sessions. The sessionizer
 * is serializable so a long migration or connector sync can stop and resume
 * without dropping the conversation that straddled a page boundary.
 */

const HOUR_MS = 60 * 60 * 1000;
const CHAT_PLATFORMS = new Set(["imessage", "sms", "whatsapp", "fb_messenger"]);

const clean = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
const iso = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const dayOf = (value) => iso(value)?.slice(0, 10) || null;
const platformLabel = (value) => ({
  imessage: "iMessage",
  sms: "SMS",
  whatsapp: "WhatsApp",
  fb_messenger: "Facebook Messenger",
  email: "Email",
})[String(value || "").toLowerCase()] || String(value || "Message");

const rowId = (row) => String(row.id || row.message_id || row.cursor_id || "").trim();
const rowBody = (row) => clean(row.body ?? row.content);
const rowTime = (row) => iso(row.ts);
const threadKey = (row) => `${String(row.platform || "message").toLowerCase()}:${String(row.thread_id || "unknown")}`;
const isMediaMarkerOnly = (body) => /^\[(?:audio|image|video)\]\s*$/i.test(body);

const speakerOf = (row, ownerLabel) => {
  if (String(row.direction || "").toLowerCase() === "out") return ownerLabel;
  return clean(row.sender_name) || clean(row.thread_title) || "Incoming contact";
};

const sessionTitle = (session) => {
  const subject = clean(session.thread_title);
  const participants = [...new Set(session.participants || [])].filter(Boolean);
  const who = subject || participants.slice(0, 3).join(", ") || "Conversation";
  return `${who} · ${session.day}`;
};

const renderSession = (session) => {
  const participants = [...new Set(session.participants || [])].filter(Boolean);
  const header = [
    `Conversation: ${clean(session.thread_title) || participants.join(", ") || "untitled"}`,
    `Platform: ${platformLabel(session.platform)}`,
    `Date: ${session.day}`,
    participants.length ? `Participants: ${participants.join(", ")}` : null,
    `Messages: ${session.message_count}`,
  ].filter(Boolean).join("\n");
  return `${header}\n\n${session.lines.join("\n\n")}`.trim();
};

export function emailEnvelope(row, { ownerLabel = "Owner" } = {}) {
  const id = rowId(row);
  const body = rowBody(row);
  const occurredAt = rowTime(row);
  if (!id || !body || !occurredAt || isMediaMarkerOnly(body)) return null;
  const speaker = speakerOf(row, ownerLabel);
  const direction = String(row.direction || "").toLowerCase() === "out" ? "outgoing" : "incoming";
  const title = clean(row.thread_title) || `Email ${occurredAt.slice(0, 10)}`;
  const content = [
    `Email thread: ${title}`,
    `Date: ${occurredAt}`,
    `Direction: ${direction}`,
    `From: ${speaker}`,
    "",
    body,
  ].join("\n");
  return {
    source_type: "message",
    source_id: id,
    title,
    content,
    occurred_at: occurredAt,
    date_source: "migration:message_timestamp",
    date_reliable: true,
    uri: row.thread_id ? `message-thread:${row.thread_id}#message:${id}` : `message:${id}`,
    metadata: {
      category: clean(row.category) || "message",
      platform: "email",
      thread_id: row.thread_id || null,
      message_id: id,
      direction,
      sender: speaker,
      migrated_from: "messaging.messages",
    },
  };
}

export function sessionEnvelope(session) {
  if (!session?.first_id || !session?.message_count || !session.lines?.length) return null;
  const participants = [...new Set(session.participants || [])].filter(Boolean);
  return {
    source_type: "message",
    // The first message is stable for the lifetime of a session and keeps the
    // public citation compatible with the original message namespace.
    source_id: session.first_id,
    title: sessionTitle(session),
    content: renderSession(session),
    occurred_at: session.first_ts,
    date_source: "migration:conversation_session_start",
    date_reliable: true,
    uri: `message-thread:${session.thread_id}#session:${session.first_id}`,
    metadata: {
      category: clean(session.category) || "message",
      platform: session.platform,
      thread_id: session.thread_id,
      first_message_id: session.first_id,
      last_message_id: session.last_id,
      message_count: session.message_count,
      participants,
      migrated_from: "messaging.messages",
      grouped_as: "bounded_conversation_session",
    },
  };
}

const newSession = (row, ownerLabel) => {
  const id = rowId(row);
  const body = rowBody(row);
  const ts = rowTime(row);
  const speaker = speakerOf(row, ownerLabel);
  return {
    platform: String(row.platform || "message").toLowerCase(),
    thread_id: String(row.thread_id || "unknown"),
    thread_title: clean(row.thread_title),
    category: clean(row.category) || "message",
    day: dayOf(ts),
    first_id: id,
    last_id: id,
    first_ts: ts,
    last_ts: ts,
    message_count: 1,
    content_chars: body.length,
    participants: speaker ? [speaker] : [],
    lines: [`[${ts}] ${speaker}: ${body}`],
  };
};

const appendSession = (session, row, ownerLabel) => {
  const body = rowBody(row);
  const ts = rowTime(row);
  const speaker = speakerOf(row, ownerLabel);
  session.last_id = rowId(row);
  session.last_ts = ts;
  session.message_count++;
  session.content_chars += body.length;
  if (speaker && !session.participants.includes(speaker)) session.participants.push(speaker);
  session.lines.push(`[${ts}] ${speaker}: ${body}`);
};

const validChatRow = (row) => {
  const platform = String(row.platform || "").toLowerCase();
  return CHAT_PLATFORMS.has(platform) && !!rowId(row) && !!rowTime(row) && !!rowBody(row) && !isMediaMarkerOnly(rowBody(row));
};

export class MessageSessionizer {
  constructor({
    ownerLabel = "Owner",
    maxGapMs = 6 * HOUR_MS,
    maxChars = 18_000,
    maxMessages = 50,
    active = [],
  } = {}) {
    this.ownerLabel = ownerLabel;
    this.maxGapMs = maxGapMs;
    this.maxChars = maxChars;
    this.maxMessages = maxMessages;
    this.active = new Map((active || []).map((session) => [`${session.platform}:${session.thread_id}`, session]));
  }

  /** Add one globally chronological row and return any documents it closes. */
  push(row) {
    const out = [];
    const ts = rowTime(row);
    if (!ts || !rowId(row) || !rowBody(row) || isMediaMarkerOnly(rowBody(row))) return out;

    const now = Date.parse(ts);
    const day = dayOf(ts);
    for (const [key, session] of this.active) {
      const expired = day !== session.day || now - Date.parse(session.last_ts) > this.maxGapMs;
      if (expired) {
        const envelope = sessionEnvelope(session);
        if (envelope) out.push(envelope);
        this.active.delete(key);
      }
    }

    if (String(row.platform || "").toLowerCase() === "email") {
      const envelope = emailEnvelope(row, { ownerLabel: this.ownerLabel });
      if (envelope) out.push(envelope);
      return out;
    }
    if (!validChatRow(row)) return out;

    const key = threadKey(row);
    let session = this.active.get(key);
    const body = rowBody(row);
    if (session && (session.message_count >= this.maxMessages || session.content_chars + body.length > this.maxChars)) {
      const envelope = sessionEnvelope(session);
      if (envelope) out.push(envelope);
      this.active.delete(key);
      session = null;
    }
    if (!session) {
      this.active.set(key, newSession(row, this.ownerLabel));
    } else {
      appendSession(session, row, this.ownerLabel);
    }
    return out;
  }

  finish() {
    const out = [...this.active.values()].map(sessionEnvelope).filter(Boolean);
    this.active.clear();
    return out;
  }

  snapshot() {
    return [...this.active.values()];
  }
}

