/**
 * Gmail as an ingest source.
 *
 * Correspondence is where intent lives. Documents record what was signed; email
 * records what was meant, what was promised and what was argued about, and for
 * an open matter that is usually the more important record.
 *
 * TWO DESIGN CHOICES WORTH KNOWING
 *
 * format=raw, not format=full. Raw returns the whole RFC 822 message, which the
 * local .eml extractor already parses correctly, including RFC 2047 encoded
 * subjects where names and clients actually appear. Using format=full would mean
 * reimplementing MIME traversal against a second shape for no gain.
 *
 * Marketing mail is excluded by default, and this is not tidiness. A real
 * mailbox is mostly newsletters, and in a previous corpus newsletter HTML took
 * the top six citations on a genuine client question. Volume alone lets bulk
 * mail dominate retrieval, so it is filtered at the query rather than after.
 */

import { extract } from "../ingest/extract.mjs";
import "../ingest/formats.mjs";
import { textQuality } from "../ingest/quality.mjs";
import { api as driveApi, DriveError } from "./google-drive.mjs";

export const API = "https://gmail.googleapis.com/gmail/v1";
export const SOURCE_TYPE = "email";

/**
 * The default query.
 *
 * Gmail's own category classifier is the cheapest reliable signal for bulk mail,
 * and it is better than a List-Unsubscribe check because plenty of legitimate
 * business senders set that header too. Chats and drafts are excluded because
 * neither is correspondence in the sense that matters.
 */
export const DEFAULT_QUERY =
  "-in:chats -in:drafts -in:spam -in:trash " +
  "-category:promotions -category:social -category:forums -category:updates";

export async function api(getAccessToken, path, opts = {}) {
  return driveApi(getAccessToken, API + path, opts);
}

/** Message ids matching a query, newest first. */
export async function* listMessages(getAccessToken, { query = DEFAULT_QUERY, pageSize = 500, max = Infinity, opts = {} } = {}) {
  let pageToken;
  let seen = 0;
  do {
    const page = await api(getAccessToken, "/users/me/messages", {
      search: { q: query, maxResults: Math.min(pageSize, 500), pageToken },
      ...opts,
    });
    for (const m of page.messages || []) {
      if (seen++ >= max) return;
      yield m.id;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
}

const fromB64Url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The current history id, saved so the NEXT run only fetches what arrived. */
export async function currentHistoryId(getAccessToken, opts = {}) {
  const p = await api(getAccessToken, "/users/me/profile", opts);
  return p.historyId;
}

/**
 * Message ids added since a saved history id.
 *
 * A 404 means the id is too old for Gmail to answer from, which happens after
 * roughly a week of inactivity. That is not an error: it means fall back to a
 * full list, and the caller is told so explicitly rather than left with nothing.
 */
export async function listHistory(getAccessToken, startHistoryId, opts = {}) {
  const added = new Set();
  let pageToken;
  let latest = startHistoryId;
  try {
    do {
      const page = await api(getAccessToken, "/users/me/history", {
        search: { startHistoryId, historyTypes: "messageAdded", pageToken, maxResults: 500 },
        ...opts,
      });
      for (const h of page.history || []) {
        if (h.id) latest = h.id;
        for (const m of h.messagesAdded || []) if (m.message?.id) added.add(m.message.id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      return { ids: [], expired: true, historyId: null };
    }
    throw e;
  }
  return { ids: [...added], expired: false, historyId: latest };
}

/** One message to one envelope, parsed by the same code that reads .eml files. */
export async function toEnvelope(getAccessToken, id, { sourceName = SOURCE_TYPE } = {}, opts = {}) {
  let msg;
  try {
    msg = await api(getAccessToken, `/users/me/messages/${id}`, { search: { format: "raw" }, ...opts });
  } catch (e) {
    return { skip: { path: id, id, reason: `could not be fetched: ${e.message.slice(0, 120)}` } };
  }
  if (!msg?.raw) return { skip: { path: id, id, reason: "the message had no content" } };

  const got = await extract(fromB64Url(msg.raw), "message.eml");
  if (got.error || got.text == null) {
    return { skip: { path: id, id, reason: got.error || "the message could not be parsed" } };
  }
  const q = textQuality(got.text);
  if (!q.ok) return { skip: { path: id, id, reason: q.reason, metrics: q.metrics } };

  const subject = (got.text.match(/^Subject:\s*(.+)$/m) || [])[1] || "(no subject)";
  // internalDate is the RECEIPT time and is the honest document date for a
  // message: unlike a file mtime, nothing rewrites it later.
  const ts = msg.internalDate ? Number(msg.internalDate) : null;

  return {
    envelope: {
      source_type: sourceName,
      source_id: `gmail:${id}`,
      title: subject.slice(0, 200),
      content: got.text,
      occurred_at: ts ? new Date(ts).toISOString() : null,
      date_source: ts ? "gmail_internal" : "none",
      date_reliable: !!ts,
      uri: `https://mail.google.com/mail/u/0/#all/${id}`,
      metadata: { category: sourceName, extracted_as: "gmail", thread_id: msg.threadId, labels: msg.labelIds },
    },
    version: String(msg.historyId || id),
  };
}
