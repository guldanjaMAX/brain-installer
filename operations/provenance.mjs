/**
 * Not all documents are equal, and for facts that CHANGE, counting them is
 * backwards.
 *
 * A brain scores independent agreement as strength. That is right for a fact
 * that never changes and exactly wrong for one that does: a value that stopped
 * being true keeps accumulating agreeing copies for years, while the value
 * that is true today has one source, or none. So on anything current, the size
 * of the agreeing pile tracks staleness rather than truth.
 *
 * Measured on a real brain 2026-09-03: FOUR sources agreed on an old mailing
 * address (court exhibits, a medical intake, a social profile edit, group
 * texts) and scored a confidence bonus for agreeing. The true address had one
 * source. Three of the owner's own self-descriptions disagreed about his own
 * degree. Two clients read as current on the strength of real but lapsed
 * retainer history.
 *
 * The fix is to rank the KIND of record, not just count copies. There is no
 * authority column on a document, so the tier is derived from what a document
 * already carries: where it came from, and what it is called. That is a
 * heuristic and it says so; `reason` is returned with every verdict precisely
 * so a person can disagree with it.
 */

/** Highest authority first. T0 is the absence of evidence, not a weak kind. */
export const TIERS = Object.freeze({
  T1: { rank: 1, name: "primary", says: "the authority itself" },
  T2: { rank: 2, name: "derived", says: "prepared from a primary record" },
  T3: { rank: 3, name: "correspondence", says: "written at the time, by a person" },
  T4: { rank: 4, name: "recollection", says: "somebody's memory, written down" },
  T5: { rank: 5, name: "verbal only", says: "said out loud, never written" },
  T0: { rank: 9, name: "absent", says: "nowhere in the corpus" },
});

/**
 * An owner's own confirmation is T1. It is the only record in the corpus that
 * was made BY the person the fact is about, ABOUT the present, ON PURPOSE.
 * Everything else is a document that happens to mention them.
 */
export const OWNER_CONFIRMED_SOURCE = "owner-confirmed";

const PRIMARY_TITLE = /\b(registrar|transcript of record|decree|judgment|judgement|docket|exhibit|affidavit|subpoena|deed|lease|contract|agreement|settlement|title|policy|passport|licen[cs]e|certificate|articles of (incorporation|organization)|k-?1|w-?2|1099|statement|payoff|lien|patent)\b/i;
const DERIVED_TITLE = /\b(invoice|receipt|summary|report|return|reconciliation|ledger|export|spreadsheet|balance sheet|p&l|profit and loss)\b/i;
const RECOLLECTION_TITLE = /\b(notes?|minutes|transcript|recording|call|meeting|interview|debrief|standup|1:1)\b/i;

/** Machine feeds are primary: nobody remembered them, a system emitted them. */
const PRIMARY_SOURCES = new Set(["plaid", "quickbooks", "stripe", "bank", "bank-feed", "qbo"]);
const CORRESPONDENCE_SOURCES = new Set(["gmail", "imap", "email", "imessage", "whatsapp", "sms", "fb_messenger", "messages"]);
const RECOLLECTION_SOURCES = new Set(["zoom", "meeting-notes", "otter", "fireflies", "granola"]);

/**
 * Classify one document. Returns the tier, and the reason, always.
 *
 * The reason is not decoration. A tier shown without the rule that produced it
 * cannot be argued with, and the whole point of this pass is that the owner
 * overrules us when we are wrong.
 */
export function tierOf({ source = "", title = "", uri = "" } = {}) {
  const src = String(source || "").toLowerCase().trim();
  const text = `${title || ""} ${uri || ""}`;

  if (src === OWNER_CONFIRMED_SOURCE) {
    return { tier: "T1", ...TIERS.T1, reason: "you confirmed this yourself" };
  }
  if (PRIMARY_SOURCES.has(src)) {
    return { tier: "T1", ...TIERS.T1, reason: `a machine feed (${src}), not somebody's account of it` };
  }
  if (PRIMARY_TITLE.test(text)) {
    return { tier: "T1", ...TIERS.T1, reason: `named like an authoritative record (${PRIMARY_TITLE.exec(text)[0]})` };
  }
  if (DERIVED_TITLE.test(text)) {
    return { tier: "T2", ...TIERS.T2, reason: `prepared from a primary record (${DERIVED_TITLE.exec(text)[0]})` };
  }
  if (RECOLLECTION_SOURCES.has(src)) {
    return { tier: "T4", ...TIERS.T4, reason: `a ${src} record of what was said` };
  }
  if (CORRESPONDENCE_SOURCES.has(src)) {
    return { tier: "T3", ...TIERS.T3, reason: `${src}, written at the time` };
  }
  if (RECOLLECTION_TITLE.test(text)) {
    return { tier: "T4", ...TIERS.T4, reason: `named like a record of a conversation (${RECOLLECTION_TITLE.exec(text)[0]})` };
  }
  // A file in a folder. It could be anything, so claim nothing beyond "written down".
  return { tier: "T3", ...TIERS.T3, reason: "a document, with nothing to say it is authoritative" };
}

/** The best (lowest rank) tier in a set of documents. */
export function bestTier(docs = []) {
  if (!docs.length) return { tier: "T0", ...TIERS.T0, reason: "no document mentions this" };
  return docs.map((d) => tierOf(d)).sort((a, b) => a.rank - b.rank)[0];
}

/**
 * The sentence to say about a pile of agreeing documents.
 *
 * This is the inversion, stated out loud. Agreement among LOW tiers about a
 * fact that changes is a CAUTION, and saying "three sources agree" about three
 * meeting notes is how a brain sounds confident and is wrong.
 */
export function agreementVerdict(docs = [], { changes = true } = {}) {
  if (!docs.length) return { confident: false, caution: true, line: "nothing in your records mentions this." };
  const tiers = docs.map((d) => tierOf(d));
  const best = tiers.slice().sort((a, b) => a.rank - b.rank)[0];
  const n = docs.length;
  if (best.rank <= 2) {
    return {
      confident: true, caution: false,
      line: `${n} record(s), the strongest being ${best.name}: ${best.reason}.`,
    };
  }
  if (!changes) {
    return {
      confident: true, caution: false,
      line: `${n} record(s) agree, and this is not the kind of fact that changes.`,
    };
  }
  return {
    confident: false, caution: true,
    line: n === 1
      ? `one ${best.name} record, and nothing authoritative. This is the kind of fact that changes, so treat it as a lead rather than an answer.`
      : `${n} records agree, but none is authoritative: the strongest is ${best.name}. On a fact that changes, agreement among records like these tracks how long something has been written down, not whether it is still true.`,
  };
}
