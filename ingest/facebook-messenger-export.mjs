/**
 * Facebook Messenger export parser.
 *
 * This is an export lane, not a Facebook API connector. The account owner uses
 * Meta's Download Your Information flow, selects Messages and JSON, and drops
 * the exported `message_*.json` files into an approved ingest folder. No Meta
 * developer app, cookie, password, scraping, or live account session enters the
 * Brain.
 *
 * Current exports are one thread per JSON file and carry epoch-millisecond
 * timestamps. That gives us exact time without WhatsApp's locale-date guess.
 * The arrays are normally newest-first, so the parser always sorts before the
 * shared message sessionizer sees them.
 */

import { createHash } from "node:crypto";

const clean = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

/**
 * Some Meta JSON exports historically represented UTF-8 bytes as Latin-1 code
 * points. Repair only the recognizable mojibake case and refuse a repair that
 * introduces replacement characters. Ordinary Unicode must remain untouched.
 */
export function decodeMetaText(value) {
  const text = String(value ?? "");
  if (!/[ÃÂð]/.test(text) || [...text].some((char) => char.codePointAt(0) > 255)) return text;
  const repaired = Buffer.from(text, "latin1").toString("utf8");
  return repaired.includes("\uFFFD") ? text : repaired;
}

const normalized = (value) => clean(decodeMetaText(value));
const safeJson = (text) => {
  try { return JSON.parse(String(text)); } catch { return null; }
};

export function detectFacebookMessengerExport(text) {
  const raw = String(text ?? "");
  if (!/"messages"\s*:/.test(raw) || !/"participants"\s*:/.test(raw) ||
      !/"timestamp_ms"\s*:/.test(raw) || !/"sender_name"\s*:/.test(raw)) return false;
  const parsed = safeJson(raw);
  return !!parsed && Array.isArray(parsed.messages) && Array.isArray(parsed.participants) &&
    parsed.messages.some((message) => Number.isFinite(Number(message?.timestamp_ms)) &&
      typeof message?.sender_name === "string");
}

function attachmentCount(message) {
  const arrays = ["photos", "videos", "audio_files", "files", "gifs"];
  return arrays.reduce((sum, key) => sum + (Array.isArray(message?.[key]) ? message[key].length : 0), 0) +
    (message?.sticker ? 1 : 0) + (message?.share ? 1 : 0);
}

const identityHash = (parts) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);

/**
 * Parse one `message_*.json` thread file to the row contract shared by
 * iMessage, SMS, WhatsApp and message migrations.
 */
export function parseFacebookMessengerExport(text, {
  sourceLabel = "facebook-messenger",
  fallbackThreadId = "thread",
  ownerName = null,
} = {}) {
  const data = safeJson(text);
  if (!data || !Array.isArray(data.messages) || !Array.isArray(data.participants)) {
    return {
      rows: [], messageCount: 0, skippedEmpty: 0, skippedMedia: 0,
      skippedUnavailable: 0, skippedMalformed: 0, error: "not a Facebook Messenger JSON export",
    };
  }

  const participantNames = data.participants
    .map((participant) => normalized(participant?.name))
    .filter(Boolean);
  const title = normalized(data.title) || participantNames.join(", ") || "Facebook Messenger conversation";
  const threadPath = normalized(data.thread_path);
  const threadId = `${sourceLabel}:${threadPath || fallbackThreadId}`;
  const owner = normalized(ownerName).toLocaleLowerCase();
  const candidates = [];
  let skippedEmpty = 0;
  let skippedMedia = 0;
  let skippedUnavailable = 0;
  let skippedMalformed = 0;

  for (const message of data.messages) {
    const timestamp = Number(message?.timestamp_ms);
    const sender = normalized(message?.sender_name);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !sender) {
      skippedMalformed++;
      continue;
    }
    if (message?.is_unsent === true || message?.is_geoblocked_for_viewer === true) {
      skippedUnavailable++;
      continue;
    }
    const body = normalized(message?.content);
    const media = attachmentCount(message);
    if (!body) {
      if (media) skippedMedia++;
      else skippedEmpty++;
      continue;
    }
    const occurredAt = new Date(timestamp);
    if (!Number.isFinite(occurredAt.getTime())) {
      skippedMalformed++;
      continue;
    }
    const fingerprint = identityHash([
      threadId, String(timestamp), sender, body,
      normalized(message?.type), String(media),
    ]);
    candidates.push({
      fingerprint,
      timestamp,
      sender,
      body,
      media,
      type: normalized(message?.type),
    });
  }

  candidates.sort((a, b) => a.timestamp - b.timestamp || a.fingerprint.localeCompare(b.fingerprint));
  const occurrences = new Map();
  const rows = candidates.map((message) => {
    const occurrence = (occurrences.get(message.fingerprint) || 0) + 1;
    occurrences.set(message.fingerprint, occurrence);
    return {
      id: `${threadId}:${message.fingerprint}:${occurrence}`,
      platform: "fb_messenger",
      thread_id: threadId,
      thread_title: title,
      category: "message",
      ts: new Date(message.timestamp).toISOString(),
      sender_name: message.sender,
      direction: owner ? (message.sender.toLocaleLowerCase() === owner ? "out" : "in") : null,
      body: message.body,
    };
  });

  const sourceTimestamps = data.messages
    .map((message) => Number(message?.timestamp_ms))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  return {
    rows,
    messageCount: rows.length,
    skippedEmpty,
    skippedMedia,
    skippedUnavailable,
    skippedMalformed,
    title,
    threadId,
    participantNames,
    sourceOrder: sourceTimestamps.length > 1 && sourceTimestamps[0] > sourceTimestamps.at(-1)
      ? "newest_first"
      : "oldest_first_or_mixed",
    error: null,
  };
}

export function isFacebookMessengerExportFilename(name) {
  return /^message_\d+\.json$/i.test(String(name || ""));
}
