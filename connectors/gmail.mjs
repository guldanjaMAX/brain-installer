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

export const DEFAULT_EXCLUDED_LABEL_IDS = new Set([
  "CHAT", "DRAFT", "SPAM", "TRASH",
  "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "CATEGORY_UPDATES",
]);

/**
 * History.list cannot apply Gmail's search query. Recheck the labels returned
 * by messages.get so the incremental lane enforces the exact same policy as a
 * full list. Missing label evidence is a coverage gap, never permission to
 * ingest or to advance the history cursor.
 */
export function gmailLabelDecision(labelIds) {
  if (!Array.isArray(labelIds)) {
    return {
      allowed: false,
      policy: false,
      reason: "Gmail returned no label classification, so this message was not indexed",
    };
  }
  const excluded = labelIds.find((label) => DEFAULT_EXCLUDED_LABEL_IDS.has(String(label).toUpperCase()));
  if (excluded) {
    return {
      allowed: false,
      policy: true,
      reason: `Gmail policy excludes messages carrying ${String(excluded).toLowerCase()}`,
    };
  }
  return { allowed: true, policy: false, reason: null };
}

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

/**
 * A messages.get 404 is about one message: it was deleted after Gmail returned
 * its id, so retrying the same history window can never fetch it. Every other
 * failure belongs to the connector, not the message. In particular, treating a
 * broad 403 or an exhausted transient failure as a skip would let the caller
 * advance its history cursor past mail it never read.
 */
export function isPermanentMessageFailure(error) {
  return error instanceof DriveError && error.status === 404;
}

/** One message to one envelope, parsed by the same code that reads .eml files. */
export async function toEnvelope(getAccessToken, id, { sourceName = SOURCE_TYPE } = {}, opts = {}) {
  let msg;
  try {
    msg = await api(getAccessToken, `/users/me/messages/${id}`, { search: { format: "raw" }, ...opts });
  } catch (e) {
    // Only a message-specific permanent condition is safe to forget. Network,
    // token, auth, quota, server and connector-wide permission failures must
    // escape so the sync runner withholds the Gmail history cursor.
    if (!isPermanentMessageFailure(e)) throw e;
    return { skip: { path: id, id, reason: `could not be fetched: ${e.message.slice(0, 120)}` } };
  }
  const labelDecision = gmailLabelDecision(msg?.labelIds);
  if (!labelDecision.allowed) {
    return {
      skip: { path: id, id, reason: labelDecision.reason },
      policy_skip: labelDecision.policy,
      // An absent classification is an incomplete read, not deletion proof.
      // Keep a prior accepted revision while the run stays visibly non-green.
      retain_existing: !labelDecision.policy,
    };
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
      // Bare connector identity. The store adds source_type exactly once;
      // pre-prefixing here created gmail:gmail:<id> and made family deletion
      // target a different document than the one actually stored.
      source_id: id,
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
