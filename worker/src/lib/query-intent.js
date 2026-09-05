/**
 * Deterministic query intent used by both ranking and citation verification.
 *
 * Recency is not relevance. It becomes a ranking signal only when the question
 * explicitly asks about the present and a candidate is tied to a named entity
 * in that question. This deliberately avoids a global "newest wins" rule.
 */

const STRONG_CURRENT_INTENT =
  /\b(?:current(?:ly)?|latest|most recent|right now|today|now)\b|\bwhat(?:'s| is) going on\b/i;
const STILL_INTENT = /\bstill\b/i;
const HISTORICAL_ANCHOR =
  /\b(?:yesterday|last\s+(?:week|month|quarter|year)|at that time|then)\b|\b(?:back in|during|as (?:of|at)|in|on|before|through|by|until|prior to)\s+(?:the\s+(?:end|start|beginning)\s+of\s+)?(?:(?:q[1-4](?:\s+of)?\s+)?(?:19|20)\d{2}\b|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+(?:19|20)\d{2})?\b|(?:\d{1,2}[/-]){2}\d{2,4}\b)/i;

const ENTITY_WORDS_TO_IGNORE = new Set([
  "a", "about", "account", "am", "an", "and", "are", "as", "at", "be", "billing", "but",
  "can", "check", "client", "could", "current", "currently", "did", "do", "does", "find", "for", "give",
  "from", "going", "had", "has", "have", "how", "i", "in", "invoice", "is", "it", "latest",
  "me", "mine", "most", "my", "now", "of", "on", "or", "our", "ours", "owner", "payment",
  "look", "please", "pull", "recent", "regarding", "review", "right", "see", "should", "show", "status", "still", "summarize", "tell", "the", "their", "them", "they", "this", "to", "today",
  "update", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

const ENTITY_CONTEXT_WORDS = new Set(["about", "for", "of", "on", "regarding", "with"]);
const ENTITY_CONTEXT_LEADING_FILLER = new Set([
  "a", "an", "account", "client", "customer", "my", "our", "status", "the", "their",
]);
const OWNER_PRONOUN = /\b(?:i|me|mine|my|our|ours|us|we)\b/i;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const validCalendarDay = (year, month, day) => {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
};

/**
 * Parse only the two date shapes accepted by the evidence contract: an ISO
 * calendar day or an RFC 3339 instant. Date.parse alone accepts ambiguous
 * locale dates and silently rolls dates such as February 30 into March.
 */
export function parseCanonicalEvidenceDate(value) {
  if (typeof value !== "string") return null;
  let match = ISO_DAY.exec(value);
  if (match) {
    const [, year, month, day] = match.map(Number);
    if (!validCalendarDay(year, month, day)) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  match = RFC3339_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (!validCalendarDay(Number(year), Number(month), Number(day)) ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const normalizedTokens = (value) => String(value || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean);

/** True only for an explicit present/latest request, not an anchored past one. */
export function hasExplicitCurrentIntent(query) {
  const text = String(query || "");
  // A bounded past question such as "latest in May 2025" is historical even
  // though it contains a word that normally requests the present. Suppressing
  // the recency lane is the conservative choice when both signals appear.
  if (HISTORICAL_ANCHOR.test(text)) return false;
  return STRONG_CURRENT_INTENT.test(text) || STILL_INTENT.test(text);
}

/**
 * Pull named anchors from a question without guessing a client from topic words.
 * A caller-provided client filter is authoritative; otherwise only proper-name
 * shaped tokens qualify. If no anchor can be proven, recency stays off.
 */
export function queryEntityAnchors(query, filters = {}, { owner = null } = {}) {
  const anchors = [];
  const add = (tokens) => {
    const phrase = tokens
      .filter((token) => token.length >= 2 && !ENTITY_WORDS_TO_IGNORE.has(token))
      .join(" ");
    if (phrase) anchors.push(phrase);
  };
  if (filters.client) add(normalizedTokens(filters.client));

  const text = String(query || "");
  // Preserve consecutive title-cased words as one anchor. Treating "Acme
  // Health" as two OR alternatives lets any generic health document match.
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9'’.-]{1,}(?:\s+[A-Z][A-Za-z0-9'’.-]{1,})*\b/g)) {
    add(normalizedTokens(match[0]));
  }

  // Lowercase names are accepted only in entity-shaped grammar. This finds
  // "with casey" and "for acme health" without promoting every uncommon
  // topic word in a lowercase question to a person or company.
  const words = normalizedTokens(text);
  for (let index = 0; index < words.length; index++) {
    if (!ENTITY_CONTEXT_WORDS.has(words[index])) continue;
    const candidate = [];
    for (let cursor = index + 1; cursor < words.length && candidate.length < 3; cursor++) {
      const token = words[cursor];
      if (ENTITY_CONTEXT_WORDS.has(token)) break;
      if (ENTITY_WORDS_TO_IGNORE.has(token)) {
        // Natural questions often say "of the Taylor account". Skip only
        // harmless leading determiners/descriptors; once a name has started, an
        // ignored word closes it so later clauses cannot be swallowed.
        if (!candidate.length && ENTITY_CONTEXT_LEADING_FILLER.has(token)) continue;
        break;
      }
      candidate.push(token);
    }
    add(candidate);
  }

  // Possessives and the subject immediately before "still" are two other
  // conservative lowercase shapes: "casey's current status" and "is casey
  // still a client".
  for (const match of text.matchAll(/\b((?:[A-Za-z0-9][A-Za-z0-9.-]*\s+){0,2}[A-Za-z0-9][A-Za-z0-9.-]*)['’]s\b/g)) {
    add(normalizedTokens(match[1]));
  }
  for (let index = 1; index < words.length; index++) {
    if (words[index] !== "still") continue;
    const candidate = [];
    for (let cursor = index - 1; cursor >= 0 && candidate.length < 3; cursor--) {
      const token = words[cursor];
      if (ENTITY_WORDS_TO_IGNORE.has(token) || ENTITY_CONTEXT_WORDS.has(token)) break;
      candidate.unshift(token);
    }
    add(candidate);
  }

  // "my" and "our" are entity anchors only when the installation supplied a
  // real owner identity. The generic fallback "the owner" is intentionally not
  // enough to activate recency.
  // A pronoun is a fallback anchor, not an OR alternative to a person or
  // company explicitly named in the question. Otherwise a newer owner-only
  // record can outrank the requested counterparty merely because the question
  // said "my relationship with Taylor".
  if (owner && OWNER_PRONOUN.test(text) && anchors.length === 0) add(normalizedTokens(owner));

  return [...new Set(anchors)];
}

export function reliableDocumentTime(row) {
  const reliable = row?.date_reliable === true || row?.date_reliable === 1 || row?.date_reliable === "1";
  if (!reliable) return null;
  const raw = row?.document_date ?? row?.ts;
  const value = typeof raw === "number" ? raw : parseCanonicalEvidenceDate(raw);
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

/**
 * The citation day is the primary recency key. Calendar's exact start is a
 * secondary key only inside that day, because comparing the absolute instants
 * across different offsets can reverse two adjacent local calendar dates.
 */
function evidenceSortKey(row) {
  const storedTime = reliableDocumentTime(row);
  if (storedTime === null) return null;
  const day = Date.parse(new Date(storedTime).toISOString().slice(0, 10));
  const dateSource = row?.date_source;
  // A Calendar day without a verified instant has day precision only. Giving
  // an all-day event an invented UTC-midnight tie-breaker makes its order
  // against timed events depend on whether their offsets cross UTC midnight.
  let exact = dateSource === "calendar:event_start" || dateSource === "calendar:all_day_start"
    ? null
    : storedTime;
  const occurredAt = row?.occurred_at;
  if (dateSource === "calendar:event_start" && typeof occurredAt === "string" && occurredAt.includes("T")) {
    const exactTime = parseCanonicalEvidenceDate(occurredAt);
    if (exactTime !== null && occurredAt.slice(0, 10) === new Date(day).toISOString().slice(0, 10)) {
      exact = exactTime;
    }
  }
  return { day, exact };
}

const compareDocumentOrder = (a, b) => {
  if (a.day !== b.day) return b.day - a.day;
  if (a.exact === b.exact) return 0;
  if (a.exact === null) return 1;
  if (b.exact === null) return -1;
  return b.exact - a.exact;
};

const sameDocumentOrder = (a, b) => a?.day === b?.day && a?.exact === b?.exact;

export function matchesEntityAnchors(row, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return false;
  const fields = [row?.client, row?.title, row?.text, row?.snippet]
    .filter(Boolean)
    .map((value) => ` ${normalizedTokens(value).join(" ")} `);
  return anchors.some((anchor) => {
    const phrase = normalizedTokens(anchor).join(" ");
    return phrase && fields.some((field) => field.includes(` ${phrase} `));
  });
}

/** Reliable, entity-matched candidates newest first, preserving base order ties. */
export function currentEvidenceCandidates(query, rows, { filters = {}, owner = null } = {}) {
  if (!hasExplicitCurrentIntent(query)) return [];
  const anchors = queryEntityAnchors(query, filters, { owner });
  if (!anchors.length) return [];
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index, order: evidenceSortKey(row) }))
    .filter((entry) => entry.order !== null && matchesEntityAnchors(entry.row, anchors))
    .sort((a, b) => compareDocumentOrder(a.order, b.order) || a.index - b.index)
    .map((entry) => entry.row);
}

/** All equally-new direct candidates. More than one can share an event date. */
export function newestCurrentEvidence(query, rows, options = {}) {
  const candidates = currentEvidenceCandidates(query, rows, options);
  if (!candidates.length) return [];
  const newest = evidenceSortKey(candidates[0]);
  return candidates.filter((row) => sameDocumentOrder(evidenceSortKey(row), newest));
}
