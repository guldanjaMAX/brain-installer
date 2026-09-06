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

import { createHash } from "node:crypto";
import { extract } from "../ingest/extract.mjs";
import "../ingest/formats.mjs";
import { textQuality } from "../ingest/quality.mjs";
import { api as driveApi, DriveError } from "./google-drive.mjs";

export const API = "https://gmail.googleapis.com/gmail/v1";
export const SOURCE_TYPE = "email";
export const GMAIL_MAX_PAGES = 2_000;
export const GMAIL_EXTRACTION_POLICY_VERSION = 1;
const GMAIL_PAGE_TOKEN_MAX_LENGTH = 8_192;

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
  "-category:promotions -category:social -category:forums";

export const DEFAULT_EXCLUDED_LABEL_IDS = new Set([
  "CHAT", "DRAFT", "SPAM", "TRASH",
  "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS",
]);

/** Stable identity for every choice that can change Gmail corpus membership. */
export function gmailPolicyFingerprint({ credentialScannerFingerprint = "" } = {}) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    query: DEFAULT_QUERY,
    excludedLabelIds: [...DEFAULT_EXCLUDED_LABEL_IDS].sort(),
    extractionPolicyVersion: GMAIL_EXTRACTION_POLICY_VERSION,
    credentialScannerFingerprint: String(credentialScannerFingerprint || ""),
  })).digest("hex");
}

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
      cursor_blocking: true,
      reason: "Gmail returned no label classification, so this message was not indexed",
    };
  }
  const excluded = labelIds.find((label) => DEFAULT_EXCLUDED_LABEL_IDS.has(String(label).toUpperCase()));
  if (excluded) {
    return {
      allowed: false,
      policy: true,
      cursor_blocking: false,
      reason: `Gmail policy excludes messages carrying ${String(excluded).toLowerCase()}`,
    };
  }
  return { allowed: true, policy: false, cursor_blocking: false, reason: null };
}

export async function api(getAccessToken, path, opts = {}) {
  return driveApi(getAccessToken, API + path, opts);
}

function nextPageToken(value, lane) {
  if (value == null) return null;
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || token.length > GMAIL_PAGE_TOKEN_MAX_LENGTH) {
    throw new DriveError(`Gmail returned an invalid ${lane} page token`, 200, "invalidPageToken");
  }
  return token;
}

function requireMessageId(value, lane) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new DriveError(`Gmail returned an empty message id while reading ${lane}`, 200, "invalidMessageId");
  return id;
}

/** Message ids matching a query, newest first. */
export async function* listMessages(getAccessToken, {
  query = DEFAULT_QUERY,
  pageSize = 500,
  max = Infinity,
  maxPages = GMAIL_MAX_PAGES,
  opts = {},
} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("Gmail maxPages must be a positive integer");
  let pageToken;
  let seen = 0;
  let pages = 0;
  const requestedPageTokens = new Set();
  do {
    if (++pages > maxPages) {
      throw new DriveError(`Gmail message listing exceeded ${maxPages} pages`, 200, "pageLimit");
    }
    if (pageToken) {
      if (requestedPageTokens.has(pageToken)) {
        throw new DriveError("Gmail repeated a message-list page token", 200, "repeatedPageToken");
      }
      requestedPageTokens.add(pageToken);
    }
    const page = await api(getAccessToken, "/users/me/messages", {
      search: { q: query, maxResults: Math.min(pageSize, 500), pageToken },
      ...opts,
    });
    if (page.messages != null && !Array.isArray(page.messages)) {
      throw new DriveError("Gmail returned an invalid message list", 200, "invalidMessageList");
    }
    const followingPageToken = nextPageToken(page.nextPageToken, "message-list");
    if (followingPageToken && requestedPageTokens.has(followingPageToken)) {
      throw new DriveError("Gmail repeated a message-list page token", 200, "repeatedPageToken");
    }
    for (const m of page.messages || []) {
      if (seen++ >= max) return;
      yield requireMessageId(m?.id, "the message list");
    }
    pageToken = followingPageToken;
  } while (pageToken);
}

const fromB64Url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The current history id, saved so the NEXT run only fetches what arrived. */
export async function currentHistoryId(getAccessToken, opts = {}) {
  const p = await api(getAccessToken, "/users/me/profile", opts);
  const marker = String(p?.historyId || "").trim();
  if (!marker) throw new Error("Gmail profile returned no valid history marker");
  return marker;
}

/**
 * Final message actions since a saved history id.
 *
 * A 404 means the id is too old for Gmail to answer from, which happens after
 * roughly a week of inactivity. That is not an error: it means fall back to a
 * full list, and the caller is told so explicitly rather than left with nothing.
 */
export async function listHistory(getAccessToken, startHistoryId, opts = {}) {
  // Gmail returns history records in chronological order. Keep only the final
  // action for each message across the complete paginated window. A later
  // delete beats an earlier add; a later label change requires a fresh policy
  // read because it may move the message into or out of the filtered corpus.
  const actions = new Map();
  const mark = (items, action, field) => {
    if (items != null && !Array.isArray(items)) {
      throw new DriveError(`Gmail returned an invalid ${field} history list`, 200, "invalidHistoryList");
    }
    for (const item of items || []) {
      const id = requireMessageId(item?.message?.id, field);
      actions.set(id, action);
    }
  };
  let pageToken;
  let terminalHistoryId = null;
  let pages = 0;
  const maxPages = opts.maxPages ?? GMAIL_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("Gmail maxPages must be a positive integer");
  const apiOpts = { ...opts };
  delete apiOpts.maxPages;
  const requestedPageTokens = new Set();
  try {
    do {
      if (++pages > maxPages) {
        throw new DriveError(`Gmail history listing exceeded ${maxPages} pages`, 200, "pageLimit");
      }
      if (pageToken) {
        if (requestedPageTokens.has(pageToken)) {
          throw new DriveError("Gmail repeated a history page token", 200, "repeatedPageToken");
        }
        requestedPageTokens.add(pageToken);
      }
      const page = await api(getAccessToken, "/users/me/history", {
        // Omitting historyTypes is deliberate. Filtering to messageAdded would
        // hide later deletion, trash, category, and label changes.
        search: { startHistoryId, pageToken, maxResults: 500 },
        ...apiOpts,
      });
      if (page.history != null && !Array.isArray(page.history)) {
        throw new DriveError("Gmail returned an invalid history list", 200, "invalidHistoryList");
      }
      for (const h of page.history || []) {
        if (!h || typeof h !== "object" || Array.isArray(h)) {
          throw new DriveError("Gmail returned an invalid history record", 200, "invalidHistoryList");
        }
        mark(h.messagesAdded, "fetch", "messagesAdded");
        mark(h.labelsAdded, "fetch", "labelsAdded");
        mark(h.labelsRemoved, "fetch", "labelsRemoved");
        // Within one record an explicit deletion is the safest final state.
        // A later record may still restore the same id to fetch.
        mark(h.messagesDeleted, "delete", "messagesDeleted");
      }
      // Gmail also returns the current mailbox history marker at the page
      // level. An empty change window has no row id to fall back to, and saving
      // the old marker there would replay that same window until it expired.
      const pageHistoryId = page.historyId == null
        ? null
        : typeof page.historyId === "string" ? page.historyId.trim() : "";
      if (pageHistoryId === "") {
        throw new DriveError("Gmail history response returned an invalid terminal history marker", 200, "invalidHistoryId");
      }
      const followingPageToken = nextPageToken(page.nextPageToken, "history");
      if (followingPageToken && requestedPageTokens.has(followingPageToken)) {
        throw new DriveError("Gmail repeated a history page token", 200, "repeatedPageToken");
      }
      pageToken = followingPageToken;
      terminalHistoryId = pageToken ? null : pageHistoryId;
    } while (pageToken);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      return { ids: [], deletedIds: [], expired: true, historyId: null };
    }
    throw e;
  }
  if (!terminalHistoryId) {
    throw new DriveError("Gmail history response returned no valid terminal history marker", 200, "invalidHistoryId");
  }
  return {
    ids: [...actions].filter(([, action]) => action === "fetch").map(([id]) => id),
    deletedIds: [...actions].filter(([, action]) => action === "delete").map(([id]) => id),
    expired: false,
    historyId: terminalHistoryId,
  };
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

/**
 * Read only the labels needed to classify one incremental-history message.
 *
 * A history window cannot use Gmail's search query. The caller preflights the
 * complete window through this cheap shape before it sends any sibling, so one
 * response with missing label evidence can stop the window atomically without
 * retaining every raw message body in memory.
 */
export async function messagePolicy(getAccessToken, id, opts = {}) {
  let msg;
  try {
    msg = await api(getAccessToken, `/users/me/messages/${id}`, {
      search: { format: "minimal", fields: "id,labelIds" },
      ...opts,
    });
  } catch (e) {
    if (!isPermanentMessageFailure(e)) throw e;
    return {
      allowed: false,
      skip: { path: id, id, reason: `could not be fetched: ${e.message.slice(0, 120)}` },
      source_deleted: true,
      retain_existing: false,
      cursor_blocking: false,
    };
  }
  const decision = gmailLabelDecision(msg?.labelIds);
  if (decision.allowed) {
    return { allowed: true, labelIds: [...msg.labelIds], cursor_blocking: false };
  }
  return {
    allowed: false,
    skip: { path: id, id, reason: decision.reason },
    policy_skip: decision.policy,
    retain_existing: !decision.policy,
    cursor_blocking: decision.cursor_blocking,
  };
}

/** One message to one envelope, parsed by the same code that reads .eml files. */
export async function toEnvelope(
  getAccessToken,
  id,
  { sourceName = SOURCE_TYPE, trustedEligible = false } = {},
  opts = {},
) {
  let msg;
  try {
    msg = await api(getAccessToken, `/users/me/messages/${id}`, { search: { format: "raw" }, ...opts });
  } catch (e) {
    // Only a message-specific permanent condition is safe to forget. Network,
    // token, auth, quota, server and connector-wide permission failures must
    // escape so the sync runner withholds the Gmail history cursor.
    if (!isPermanentMessageFailure(e)) throw e;
    return {
      skip: { path: id, id, reason: `could not be fetched: ${e.message.slice(0, 120)}` },
      source_deleted: true,
      retain_existing: false,
      cursor_blocking: false,
    };
  }
  const observedDecision = gmailLabelDecision(msg?.labelIds);
  // A full-list id already matched DEFAULT_QUERY, while an incremental id was
  // preflighted above. Missing labels on the later raw response do not erase
  // that evidence. Present labels still win, so a message relabelled into an
  // excluded category between the two reads remains excluded.
  const labelDecision = observedDecision.cursor_blocking && trustedEligible
    ? { allowed: true, policy: false, cursor_blocking: false, reason: null }
    : observedDecision;
  if (!labelDecision.allowed) {
    return {
      skip: { path: id, id, reason: labelDecision.reason },
      policy_skip: labelDecision.policy,
      // An absent classification is an incomplete read, not deletion proof.
      // Keep a prior accepted revision while the run stays visibly non-green.
      retain_existing: !labelDecision.policy,
      cursor_blocking: labelDecision.cursor_blocking,
    };
  }
  if (!msg?.raw) {
    return {
      skip: { path: id, id, reason: "the message had no content" },
      retain_existing: true,
      cursor_blocking: false,
    };
  }

  const got = await extract(fromB64Url(msg.raw), "message.eml");
  if (got.error || got.text == null) {
    return {
      skip: { path: id, id, reason: got.error || "the message could not be parsed" },
      retain_existing: true,
      cursor_blocking: false,
    };
  }
  const q = textQuality(got.text);
  if (!q.ok) {
    return {
      skip: { path: id, id, reason: q.reason, metrics: q.metrics },
      retain_existing: true,
      cursor_blocking: false,
    };
  }

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
