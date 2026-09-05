/** Slack message and thread snapshots with stable per-message identities. */

import {
  createPaginationGuard, ProviderSyncError, providerEnvelope, providerJson, providerSyncResult,
} from "./provider-sync.mjs";

const slackUrl = (method, params = {}) => {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
};

async function slackCall(method, params, options) {
  const { data } = await providerJson("slack", slackUrl(method, params), options);
  if (!data?.ok) {
    const code = String(data?.error || "unknown_error").slice(0, 80);
    const unavailable = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive", "missing_scope"]);
    throw new ProviderSyncError("slack", unavailable.has(code)
      ? "the connection is missing, expired, or lacks permission"
      : code === "ratelimited" ? "the provider rate limit was reached" : `the provider refused ${method}`, {
      kind: code === "ratelimited" ? "retryable" : unavailable.has(code) ? "unavailable" : "refused",
      code,
    });
  }
  return data;
}

async function channelList(auth, channelIds) {
  if (Array.isArray(channelIds) && channelIds.length) {
    return channelIds.map((id) => ({ id: String(id), name: String(id) }));
  }
  const channels = [];
  const guard = createPaginationGuard("slack");
  let cursor = "__first__";
  while (cursor) {
    guard.visit(`channels:${cursor}`);
    const page = await slackCall("conversations.list", {
      limit: 200,
      cursor: cursor === "__first__" ? "" : cursor,
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: false,
    }, auth);
    channels.push(...(page.channels || []).filter((channel) => channel?.id));
    cursor = page?.response_metadata?.next_cursor || "";
  }
  return channels;
}

const isoFromSlackTs = (value) => {
  const milliseconds = Number(value) * 1_000;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

function messageEnvelope(channel, message) {
  const ts = String(message?.ts || "").trim();
  const text = String(message?.text || "").trim();
  if (!ts || !text) return null;
  const channelLabel = channel.name || channel.user || channel.id;
  const author = message.user || message.bot_profile?.name || message.bot_id || "unknown";
  const details = [
    `Slack conversation: ${channelLabel}`,
    `Timestamp: ${ts}`,
    `Author: ${author}`,
    "",
    text,
  ];
  const fileNames = (message.files || []).map((file) => file?.name || file?.title).filter(Boolean);
  if (fileNames.length) details.push("", `Files named: ${fileNames.join(", ")}`);
  return providerEnvelope("slack", `message:${channel.id}:${ts}`, {
    title: `Slack ${channelLabel}: ${text.slice(0, 100)}`,
    content: details.join("\n"),
    occurredAt: isoFromSlackTs(ts),
    uri: `slack://channel/${channel.id}/message/${ts}`,
    metadata: {
      channel_id: channel.id,
      channel_name: channel.name || null,
      message_ts: ts,
      thread_ts: message.thread_ts || null,
      author_id: message.user || message.bot_id || null,
      subtype: message.subtype || null,
      file_count: fileNames.length,
    },
  });
}

export async function syncSlack({
  accessToken,
  fetchImpl = fetch,
  channelIds = null,
  maxThreadsPerChannel = 5_000,
} = {}) {
  if (!accessToken) throw new TypeError("Slack accessToken is required");
  const auth = { accessToken, fetchImpl };
  const channels = await channelList(auth, channelIds);
  const documents = [];
  const deletions = [];
  const warnings = [];

  for (const channel of channels) {
    const messages = new Map();
    const historyGuard = createPaginationGuard("slack");
    let cursor = "__first__";
    while (cursor) {
      historyGuard.visit(`history:${channel.id}:${cursor}`);
      const page = await slackCall("conversations.history", {
        channel: channel.id, limit: 100, cursor: cursor === "__first__" ? "" : cursor,
      }, auth);
      for (const message of page.messages || []) {
        if (message?.subtype === "message_deleted" && message.deleted_ts) {
          deletions.push({ source_type: "slack", source_id: `message:${channel.id}:${message.deleted_ts}` });
        } else if (message?.ts) {
          messages.set(String(message.ts), message);
        }
      }
      cursor = page?.response_metadata?.next_cursor || "";
    }

    let expandedThreads = 0;
    for (const parent of [...messages.values()].filter((message) => Number(message.reply_count || 0) > 0)) {
      if (expandedThreads >= maxThreadsPerChannel) {
        warnings.push(`Slack conversation ${channel.id} exceeded the bounded thread expansion limit.`);
        break;
      }
      expandedThreads++;
      const replyGuard = createPaginationGuard("slack");
      let replyCursor = "__first__";
      while (replyCursor) {
        replyGuard.visit(`replies:${channel.id}:${parent.ts}:${replyCursor}`);
        const page = await slackCall("conversations.replies", {
          channel: channel.id, ts: parent.ts, limit: 100,
          cursor: replyCursor === "__first__" ? "" : replyCursor,
        }, auth);
        for (const message of page.messages || []) if (message?.ts) messages.set(String(message.ts), message);
        replyCursor = page?.response_metadata?.next_cursor || "";
      }
    }
    for (const message of [...messages.values()].sort((a, b) => Number(a.ts) - Number(b.ts))) {
      const envelope = messageEnvelope(channel, message);
      if (envelope) documents.push(envelope);
    }
  }

  warnings.unshift(
    "Slack history is a repeatable snapshot, but the API does not provide authoritative tombstones for every removed message or inaccessible conversation.",
  );
  return providerSyncResult({
    provider: "slack", documents, deletions, warnings,
    deletionAuthority: "unavailable", proposedCursor: null,
  });
}
