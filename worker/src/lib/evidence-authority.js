/**
 * Claim-specific evidence authority.
 *
 * A source tier describes what kind of record this is. It does not grant that
 * record authority over every claim it happens to mention. In particular, a
 * bank, invoice, or subscription feed can establish its own account state but
 * cannot establish whether a human or business relationship is current.
 *
 * This module is deliberately pure so the Worker answer path and `brain check`
 * use one vocabulary and one classifier. D1 remains the source of every input;
 * no tier is persisted or trusted as a separate fact.
 */

import { parseCanonicalEvidenceDate } from "./query-intent.js";

/** Highest authority first. T0 is absence, not a weak document. */
export const TIERS = Object.freeze({
  T1: Object.freeze({ rank: 1, name: "primary", says: "the authority itself" }),
  T2: Object.freeze({ rank: 2, name: "derived", says: "prepared from a primary record" }),
  T3: Object.freeze({ rank: 3, name: "correspondence", says: "written at the time, by a person" }),
  T4: Object.freeze({ rank: 4, name: "recollection", says: "somebody's memory, written down" }),
  T5: Object.freeze({ rank: 5, name: "verbal only", says: "said out loud, never written" }),
  T0: Object.freeze({ rank: 9, name: "absent", says: "nowhere in the corpus" }),
});

export const OWNER_CONFIRMED_SOURCE = "owner-confirmed";

export const CLAIM_KINDS = Object.freeze({
  GENERAL: "general",
  RELATIONSHIP_STATUS: "relationship_status",
  TRANSACTION_STATUS: "transaction_status",
});

const PRIMARY_TITLE = /\b(registrar|transcript of record|decree|judgment|judgement|docket|exhibit|affidavit|subpoena|deed|lease|contract|agreement|settlement|title|policy|passport|licen[cs]e|certificate|articles of (?:incorporation|organization)|k-?1|w-?2|1099|statement|payoff|lien|patent)\b/i;
const DERIVED_TITLE = /\b(invoice|receipt|summary|report|return|reconciliation|ledger|export|spreadsheet|balance sheet|p&l|profit and loss)\b/i;
const RECOLLECTION_TITLE = /\b(notes?|minutes|transcript|recording|call|meeting|interview|debrief|standup|1:1)\b/i;

const PRIMARY_FOLDER = /\b(court documents?|contracts?|credit reports?|tax returns?|legal records?|official records?)\b/i;
const PRIMARY_SOURCES = new Set([
  "bank", "bank-feed", "billing_system", "plaid", "qbo", "quickbooks",
  "stripe", "subscription_system", "xero",
]);
const RELATIONSHIP_SOURCES = new Set(["crm", "hubspot", "salesforce"]);
const TRANSACTIONAL_SOURCES = new Set([
  "bank", "bank-feed", "billing_system", "plaid", "qbo", "quickbooks",
  "stripe", "subscription_system", "xero",
]);
const CORRESPONDENCE_SOURCES = new Set([
  "email", "fb_messenger", "gmail", "imessage", "imap", "messages", "sms", "whatsapp",
]);
const RECOLLECTION_SOURCES = new Set(["fireflies", "granola", "meeting-notes", "otter", "zoom"]);

const RELATIONSHIP_STATUS_CLAIM = /\b(client|customer|member|patient|employee|tenant|vendor|partner)s?\b/i;
const PRESENT_RELATIONSHIP_CLAIM =
  /\b(?:is|are)\s+[a-z0-9][^?\n]{0,80}?\s+(?:still\s+)?(?:(?:an?|my|our)\s+)?(?:active\s+)?(?:clients?|customers?|members?|patients?|employees?|tenants?|vendors?|partners?)\s*\??(?:$|\n)|\bwho\s+(?:is|are)\s+(?:my|our)\s+(?:active\s+)?(?:clients?|customers?|members?|patients?|employees?|tenants?|vendors?|partners?)\b/i;
const TRANSACTION_STATUS_CLAIM = /\b(account|balance|billing|invoice|payment|service|subscription)\b/i;
const EXPLICIT_RELATIONSHIP_CLAIM = /\b(client|customer|engagement|relationship|retained|working together|member|patient|employee|tenant|vendor|partner)\b/i;
const STATUS_LANGUAGE = /\b(active|inactive|current(?:ly)?|still|remains?|continues?|continuing|ongoing|stopped|ended|terminated|cancelled|canceled|ceased|churned|closed|left|no longer|renewed|retained|working together)\b|\b(?:is|are)\s+(?:still\s+)?(?:an?\s+)?(?:client|customer|member|patient|employee|tenant|vendor|partner)\b/i;

const trueValue = (value) => value === true || value === 1 || value === "1";
const reliableText = (row) => {
  const source = String(row?.text_source || "native").toLowerCase();
  const reliable = row?.text_reliable === undefined || row?.text_reliable === null
    ? source === "native"
    : trueValue(row.text_reliable);
  return source === "native" && reliable;
};
const evidenceTime = (row) => {
  const raw = row?.document_date ?? row?.ts;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && Number.isFinite(new Date(raw).getTime()) ? raw : null;
  }
  return parseCanonicalEvidenceDate(raw);
};
const reliableDate = (row) => trueValue(row?.date_reliable) && evidenceTime(row) !== null;

const jsonObject = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const dateOf = (row) => {
  const time = evidenceTime(row);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};

const normalizedIdentity = (value) => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

const subjectLineOf = (row) => {
  // Search operates on chunks. D1 supplies the first chunk separately so a
  // later matching section can still prove the Subject line written in the
  // document preamble. Direct/classifier callers can pass the whole document
  // as text or snippet.
  const hasProjectedHead = Object.hasOwn(row, "authority_document_head") ||
    Object.hasOwn(row, "_authority_document_head");
  const projectedHead = Object.hasOwn(row, "authority_document_head")
    ? row.authority_document_head
    : row._authority_document_head;
  const text = String(hasProjectedHead ? projectedHead ?? "" : row.text ?? row.snippet ?? "");
  const matches = [...text.matchAll(/^Subject:[ \t]*([^\r\n]+?)[ \t]*$/gmi)];
  return matches.length === 1 ? matches[0][1] : null;
};

/**
 * Only the complete Worker-written marker identifies an operative owner record.
 * A generic curated file with a suggestive title or metadata key is not enough.
 */
export function ownerConfirmedRecord(row = {}) {
  const source = String(row.source || "").toLowerCase().trim();
  const sourceId = String(row.source_id || row.ref_key || "").trim();
  const idMatch = /^owner-confirmed\/(\d{4}-\d{2}-\d{2})\/[A-Za-z0-9_-]{1,128}$/.exec(sourceId);
  const category = String(row.category || "").toLowerCase().trim();
  const titleMatch = /^Confirmed by the owner, (\d{4}-\d{2}-\d{2})$/.exec(String(row.title || "").trim());
  const metadata = jsonObject(row.authority_meta ?? row._authority_meta);
  const day = dateOf(row);
  const subject = normalizedIdentity(metadata?.subject);
  const subjectIdentityMatches = Boolean(subject) && [
    metadata?.client_name,
    row.client,
    subjectLineOf(row),
  ].every((value) => normalizedIdentity(value) === subject);
  const valid = Boolean(
    source === "curated" &&
    idMatch &&
    category === OWNER_CONFIRMED_SOURCE &&
    titleMatch && titleMatch[1] === idMatch?.[1] &&
    day === idMatch?.[1] &&
    row.date_source === "owner_confirmation" && reliableDate(row) &&
    reliableText(row) &&
    metadata?.authority === "T1" && metadata?.operative === true &&
    subjectIdentityMatches
  );
  return { valid, day: valid ? day : null };
}

const normalizedWords = (value) => String(value || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean);

const SECTION_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "by", "current", "currently", "for", "from", "in", "is",
  "me", "my", "number", "of", "on", "operative", "or", "our", "primary", "the", "to", "value", "what", "which",
]);
const SECTION_TERM_ALIASES = Object.freeze({
  cell: "phone",
  cellphone: "phone",
  mobile: "phone",
  telephone: "phone",
  postcode: "postal",
  zip: "postal",
});
const sectionTerms = (value) => normalizedWords(value)
  .map((word) => SECTION_TERM_ALIASES[word] || word)
  .filter((word) => word.length >= 2 && !SECTION_STOPWORDS.has(word));

/**
 * Parse the one owner-confirmed section relevant to this question.
 *
 * The old values remain useful history, but they must never become current
 * merely because they share a boosted document with the operative value. A
 * multi-section record receives no operative boost when the question cannot
 * be matched to one section unambiguously.
 */
export function operativeSectionForQuery(row = {}, query = "") {
  if (!ownerConfirmedRecord(row).valid) return null;
  const text = String(row.text || row.snippet || "");
  const sections = [];
  for (const match of text.matchAll(/(?:^|\n)##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/g)) {
    const name = match[1].trim().slice(0, 160);
    const body = match[2];
    const value = /^Operative value:\s*(.+)$/im.exec(body)?.[1]?.trim();
    const asOf = /^As of:\s*(\d{4}-\d{2}-\d{2})(?:\b|,)/im.exec(body)?.[1] || null;
    const supersedesLine = /^Supersedes:\s*(.+)$/im.exec(body)?.[1]?.trim();
    if (!name || !value || !asOf || !supersedesLine || asOf !== dateOf(row)) continue;
    const supersedes = supersedesLine.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
    if (!supersedes.length || supersedes.some((item) => item === value)) continue;
    const terms = sectionTerms(name);
    const queryWords = new Set(sectionTerms(query));
    const score = terms.reduce((sum, word) => sum + (queryWords.has(word) ? 1 : 0), 0);
    sections.push({ name, value: value.slice(0, 500), as_of: asOf, supersedes: supersedes.map((item) => item.slice(0, 500)), score });
  }
  if (sections.length === 1 && sections[0].score >= 1) {
    const { score: _score, ...section } = sections[0];
    return section;
  }
  const ranked = sections.slice().sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score < 1 || ranked[0].score === ranked[1]?.score) return null;
  const { score: _score, ...section } = ranked[0];
  return section;
}

/** Classify the claim being made, rather than granting one tier universally. */
export function claimKindFor(claimText = "", question = "") {
  const sentence = String(claimText || "");
  const prompt = String(question || "");
  const joined = `${sentence} ${prompt}`;
  if (EXPLICIT_RELATIONSHIP_CLAIM.test(sentence) ||
      (RELATIONSHIP_STATUS_CLAIM.test(prompt) &&
       (STATUS_LANGUAGE.test(joined) || PRESENT_RELATIONSHIP_CLAIM.test(prompt)))) {
    return CLAIM_KINDS.RELATIONSHIP_STATUS;
  }
  if (TRANSACTION_STATUS_CLAIM.test(joined) && STATUS_LANGUAGE.test(joined)) {
    return CLAIM_KINDS.TRANSACTION_STATUS;
  }
  return CLAIM_KINDS.GENERAL;
}

function existingTier(row) {
  const value = row?.authority;
  if (!value || typeof value !== "object" || !TIERS[value.tier]) return null;
  if (value.name !== TIERS[value.tier].name || Number(value.rank) !== TIERS[value.tier].rank) return null;
  const reason = String(value.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return reason ? { tier: value.tier, ...TIERS[value.tier], reason } : null;
}

/** Classify one document's base record kind. Always returns a plain reason. */
export function tierOf(row = {}) {
  const carried = existingTier(row);
  if (carried) return carried;

  const source = String(row.source || "").toLowerCase().trim();
  const titleAndUri = `${row.title || ""} ${row.uri || ""}`;
  const folder = String(row.top_folder || "");
  if (ownerConfirmedRecord(row).valid) {
    return { tier: "T1", ...TIERS.T1, reason: "an operative value you confirmed yourself" };
  }
  if (RELATIONSHIP_SOURCES.has(source)) {
    return { tier: "T1", ...TIERS.T1, reason: `the ${source} relationship system` };
  }
  if (PRIMARY_SOURCES.has(source)) {
    return { tier: "T1", ...TIERS.T1, reason: `a machine feed (${source}), not somebody's account of it` };
  }
  const primaryMatch = PRIMARY_TITLE.exec(titleAndUri) || PRIMARY_FOLDER.exec(folder);
  if (primaryMatch) {
    return { tier: "T1", ...TIERS.T1, reason: `named like an authoritative record (${primaryMatch[0]})` };
  }
  const derivedMatch = DERIVED_TITLE.exec(titleAndUri);
  if (derivedMatch) {
    return { tier: "T2", ...TIERS.T2, reason: `prepared from a primary record (${derivedMatch[0]})` };
  }
  if (RECOLLECTION_SOURCES.has(source)) {
    return { tier: "T4", ...TIERS.T4, reason: `a ${source} record of what was said` };
  }
  if (CORRESPONDENCE_SOURCES.has(source)) {
    return { tier: "T3", ...TIERS.T3, reason: `${source}, written at the time` };
  }
  const recollectionMatch = RECOLLECTION_TITLE.exec(titleAndUri);
  if (recollectionMatch) {
    return { tier: "T4", ...TIERS.T4, reason: `named like a record of a conversation (${recollectionMatch[0]})` };
  }
  return { tier: "T3", ...TIERS.T3, reason: "a document, with nothing to show it is authoritative" };
}

const transactionalEvidence = (row) => {
  const source = String(row?.source || "").toLowerCase().trim();
  if (TRANSACTIONAL_SOURCES.has(source)) return true;
  const title = String(row?.title || "");
  return /\b(invoice|receipt|ledger|balance sheet|billing|payment|subscription|bank statement|account statement)\b/i.test(title);
};

/**
 * Return the effective authority of one document for one claim.
 *
 * `authoritative` is intentionally stricter than `tier`: reliable text is
 * required, and a current claim also requires a reliable date. This lets the
 * UI show that a scan is a primary artifact while refusing to treat its OCR as
 * unquestioned current evidence.
 */
export function authorityFor(row = {}, {
  query = "", claimText = "", current = false, claim = null,
} = {}) {
  const base = tierOf(row);
  const claimKind = claim || claimKindFor(claimText, query);
  const owner = ownerConfirmedRecord(row);
  const operativeSection = owner.valid ? operativeSectionForQuery(row, query) : null;
  const relationshipBlocked = claimKind === CLAIM_KINDS.RELATIONSHIP_STATUS && transactionalEvidence(row) && !owner.valid;
  const ownerSectionMismatch = owner.valid && !operativeSection;
  const textIsReliable = reliableText(row);
  const dateIsReliable = !current || reliableDate(row);
  const eligible = !relationshipBlocked && !ownerSectionMismatch;
  const authoritative = eligible && base.rank <= TIERS.T2.rank && textIsReliable && dateIsReliable;

  let reason = base.reason;
  if (relationshipBlocked) {
    reason = `${String(row.source || "this financial record")} can establish its account or transaction state, not a relationship`;
  } else if (ownerSectionMismatch) {
    reason = "an owner-confirmed record, but no operative section matches this claim";
  } else if (!textIsReliable) {
    reason = `${base.reason}; its text was not obtained from a reliable native text layer`;
  } else if (!dateIsReliable) {
    reason = `${base.reason}; it has no reliable as-of date for a current claim`;
  } else if (operativeSection) {
    reason = `owner-confirmed operative ${operativeSection.name} as of ${operativeSection.as_of}`;
  }

  return {
    tier: base.tier,
    rank: base.rank,
    name: base.name,
    reason,
    claim: claimKind,
    eligible,
    authoritative,
    current: Boolean(current),
    owner_confirmed: owner.valid,
    operative: Boolean(operativeSection),
    ...(operativeSection ? { operative_section: operativeSection } : {}),
  };
}

/** Strongest claim-eligible tier in a set, with T0 for an empty/blocked set. */
export function bestTier(docs = [], options = {}) {
  const classified = docs.map((doc) => authorityFor(doc, options)).filter((item) => item.eligible);
  if (!classified.length) return { tier: "T0", ...TIERS.T0, reason: "no eligible document supports this claim" };
  return classified.sort((a, b) =>
    Number(b.authoritative === true) - Number(a.authoritative === true) || a.rank - b.rank
  )[0];
}

/** Agreement language shared by the contradiction sweep and answer scorer. */
export function agreementVerdict(docs = [], { changes = true, current = changes, ...options } = {}) {
  if (!docs.length) return { confident: false, caution: true, line: "nothing in your records mentions this." };
  const best = bestTier(docs, { ...options, current });
  const n = docs.length;
  if (best.authoritative === true && best.rank <= TIERS.T2.rank) {
    return { confident: true, caution: false, line: `${n} record(s), the strongest being ${best.name}: ${best.reason}.` };
  }
  if (!changes) {
    return { confident: true, caution: false, line: `${n} record(s) agree, and this is not the kind of fact that changes.` };
  }
  return {
    confident: false,
    caution: true,
    line: n === 1
      ? `one ${best.name} record, and nothing authoritative. This fact can change, so treat it as a lead rather than an answer.`
      : `${n} records agree, but none is authoritative: the strongest is ${best.name}. For a fact that changes, agreement among records like these tracks how long something has been written down, not whether it is still true.`,
  };
}

/** Exact, bounded match used by the post-verifier operative-value guard. */
export function answerUsesSupersededValue(answer, section) {
  const text = String(answer || "");
  if (!section || !Array.isArray(section.supersedes)) return false;
  return section.supersedes.some((value) => {
    const tokens = normalizedWords(value);
    if (!tokens.length) return false;
    const phrase = tokens
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^a-z0-9]+");
    const matches = text.matchAll(new RegExp(`(?:^|[^a-z0-9])${phrase}(?=$|[^a-z0-9])`, "gi"));
    for (const match of matches) {
      const nearby = text.slice(Math.max(0, match.index - 80), match.index)
        .split(/[.!?;\n]/)
        .at(-1)
        .toLowerCase();
      if (!/\b(formerly|historically|previously|superseded|old|used to be)\b/.test(nearby)) return true;
    }
    return false;
  });
}

/** A formatting-tolerant check that the selected operative value survived. */
export function answerUsesOperativeValue(answer, section) {
  if (!section?.value) return false;
  const tokens = normalizedWords(section.value);
  if (!tokens.length) return false;
  const phrase = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^a-z0-9]+");
  return new RegExp(`(?:^|[^a-z0-9])${phrase}(?=$|[^a-z0-9])`, "i").test(String(answer || ""));
}

/** True when a retrieved record discusses the fact named by an operative section. */
export function documentMatchesOperativeClaim(row, section) {
  const claimTerms = sectionTerms(section?.name);
  if (!claimTerms.length) return false;
  const documentTerms = new Set(sectionTerms(`${row?.title || ""} ${row?.text || ""} ${row?.snippet || ""}`));
  return claimTerms.some((term) => documentTerms.has(term));
}

/** Apply the same bounded value matcher to a document rather than an answer. */
export function documentUsesOperativeValue(row, section) {
  return answerUsesOperativeValue(
    `${row?.title || ""} ${row?.text || ""} ${row?.snippet || ""}`,
    section,
  );
}
