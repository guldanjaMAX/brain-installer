/** Notion page and recursive block reader for the current public API version. */

import {
  createPaginationGuard, providerEnvelope, providerJson, providerSyncResult,
} from "./provider-sync.mjs";

const API = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2026-03-11";
const notionHeaders = Object.freeze({ "Notion-Version": NOTION_API_VERSION });
const richText = (parts = []) => parts.map((part) => part?.plain_text || part?.text?.content || "").join("");

function blockText(block) {
  const value = block?.[block?.type];
  if (!value) return "";
  const text = richText(value.rich_text || value.caption || []);
  if (block.type === "child_page" || block.type === "child_database") return value.title || "";
  if (block.type === "to_do") return `${value.checked ? "[x]" : "[ ]"} ${text}`;
  if (block.type === "code") return [text, value.language ? `Language: ${value.language}` : null].filter(Boolean).join("\n");
  if (block.type === "equation") return value.expression || "";
  if (block.type === "table_row") return (value.cells || []).map((cell) => richText(cell)).join(" | ");
  if (["bookmark", "link_preview", "embed"].includes(block.type)) return [text, value.url].filter(Boolean).join("\n");
  if (["file", "image", "video", "audio", "pdf"].includes(block.type)) {
    return [text, value.name, value.external?.url].filter(Boolean).join("\n");
  }
  return text;
}

async function childBlocks(blockId, auth, state, depth = 0) {
  if (depth > state.maxDepth) {
    state.warnings.push(`Notion block ${blockId} exceeded the recursion limit.`);
    return [];
  }
  const out = [];
  const guard = createPaginationGuard("notion");
  let cursor = "__first__";
  while (cursor) {
    guard.visit(`${blockId}:${cursor}`);
    const url = new URL(`${API}/blocks/${encodeURIComponent(blockId)}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor !== "__first__") url.searchParams.set("start_cursor", cursor);
    const { data } = await providerJson("notion", url, { ...auth, headers: notionHeaders });
    for (const block of data.results || []) {
      state.blocks++;
      if (state.blocks > state.maxBlocks) {
        state.warnings.push(`Notion page ${state.pageId} exceeded the bounded block limit.`);
        return out;
      }
      const line = blockText(block);
      if (line) out.push(line);
      else if (block?.type === "unsupported") state.warnings.push(`Notion page includes unsupported block ${block.id}.`);
      if (block?.has_children) out.push(...await childBlocks(block.id, auth, state, depth + 1));
    }
    cursor = data.has_more ? data.next_cursor : "";
  }
  return out;
}

function propertyText(property) {
  if (!property || !property.type) return "";
  const value = property[property.type];
  if (property.type === "title" || property.type === "rich_text") return richText(value);
  if (property.type === "number") return value === null ? "" : String(value);
  if (property.type === "checkbox") return value ? "Yes" : "No";
  if (property.type === "select" || property.type === "status") return value?.name || "";
  if (property.type === "multi_select") return (value || []).map((item) => item.name).join(", ");
  if (property.type === "date") return [value?.start, value?.end].filter(Boolean).join(" to ");
  if (property.type === "people") return (value || []).map((person) => person.name || person.id).join(", ");
  if (["email", "phone_number", "url", "created_time", "last_edited_time"].includes(property.type)) return String(value || "");
  if (property.type === "relation") return (value || []).map((relation) => relation.id).join(", ");
  if (property.type === "formula") return String(value?.[value?.type] ?? "");
  if (property.type === "unique_id") return `${value?.prefix || ""}${value?.number ?? ""}`;
  return "";
}

function notionTitle(page) {
  for (const property of Object.values(page?.properties || {})) {
    if (property?.type === "title") return richText(property.title) || "Untitled Notion page";
  }
  return "Untitled Notion page";
}

export async function syncNotion({
  accessToken,
  fetchImpl = fetch,
  maxDepth = 20,
  maxBlocksPerPage = 100_000,
} = {}) {
  if (!accessToken) throw new TypeError("Notion accessToken is required");
  const auth = { accessToken, fetchImpl };
  const pages = [];
  const searchGuard = createPaginationGuard("notion");
  let cursor = "__first__";
  while (cursor) {
    searchGuard.visit(`search:${cursor}`);
    const { data } = await providerJson("notion", `${API}/search`, {
      ...auth,
      method: "POST",
      headers: notionHeaders,
      body: {
        filter: { property: "object", value: "page" },
        page_size: 100,
        ...(cursor === "__first__" ? {} : { start_cursor: cursor }),
      },
    });
    pages.push(...(data.results || []).filter((page) => page?.id));
    cursor = data.has_more ? data.next_cursor : "";
  }

  const warnings = [];
  const documents = [];
  const deletions = [];
  for (const page of pages) {
    if (page.archived || page.in_trash) {
      deletions.push({ source_type: "notion", source_id: `page:${page.id}` });
      continue;
    }
    const state = {
      pageId: page.id,
      blocks: 0,
      maxDepth: Math.max(1, Number(maxDepth) || 20),
      maxBlocks: Math.max(1, Number(maxBlocksPerPage) || 100_000),
      warnings,
    };
    const lines = await childBlocks(page.id, auth, state);
    const title = notionTitle(page);
    const properties = Object.entries(page.properties || {}).map(([name, property]) => {
      const value = propertyText(property);
      return value ? `${name}: ${value}` : null;
    }).filter(Boolean);
    documents.push(providerEnvelope("notion", `page:${page.id}`, {
      title,
      content: [`Notion page: ${title}`, ...properties, "", ...lines].join("\n").trim(),
      occurredAt: page.last_edited_time || page.created_time || null,
      uri: page.url || `notion://page/${page.id}`,
      metadata: {
        page_id: page.id,
        last_edited_time: page.last_edited_time || null,
        block_count: state.blocks,
      },
    }));
  }
  warnings.unshift(
    "Notion search can surface archived pages but does not provide an authoritative tombstone stream for every page removed from the integration's access.",
  );
  return providerSyncResult({
    provider: "notion", documents, deletions, warnings,
    deletionAuthority: "unavailable", proposedCursor: null,
  });
}
