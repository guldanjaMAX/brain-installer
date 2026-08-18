/**
 * scorer — turn a list of retrieved results into recall@k and MRR.
 *
 * Pure functions only. Nothing here touches the network, the filesystem or the
 * clock, which is what makes the numbers reproducible and the unit tests worth
 * running. Everything that talks to a brain lives in brain-client.mjs.
 *
 * THE MEASUREMENT, stated plainly so nobody has to reverse engineer it from a
 * number on a report:
 *
 *   A question is SATISFIED at rank r when every document the question needs has
 *   appeared somewhere in the first r results. For a single document question
 *   that is just the rank of that document. For a two document question it is
 *   the rank of the second one to show up, because an answer assembled from one
 *   half of the evidence is not an answer.
 *
 *   recall@k is the share of questions satisfied at rank k or better.
 *   MRR is the mean of 1/r, counting an unsatisfied question as 0.
 *
 * Duplicates are the reason two sets of numbers come out of one run. This corpus
 * returns several chunks of the same file in one page of results, so a top 5 can
 * really be a top 2 in terms of distinct documents. RAW counts what the caller
 * actually received, which is the honest measure of a fixed result budget. BY
 * DOCUMENT collapses repeats first, which is what a reader perceives. Reporting
 * only the second one flatters the system; reporting only the first hides a real
 * regression when a change starts wasting slots on repeats. So both are printed.
 */

/**
 * Every identity string a single result can legitimately answer to.
 *
 * A Drive result's `ref_key` is the id of a CHUNK row and is reassigned on every
 * re-index, so it is deliberately not an identity. Matching Drive on
 * drive_file_id (stable) or on path (human readable) is what keeps a golden set
 * usable a month after it was written.
 */
export function identitiesOf(result) {
  if (!result || typeof result !== "object") return [];
  const source = result.source || "unknown";
  const ids = [];

  if (source === "drive") {
    if (result.drive_file_id) ids.push(`drive:${result.drive_file_id}`);
    if (result.title) ids.push(`drive_path:${result.title}`);
  } else if (result.ref_key) {
    ids.push(`${source}:${result.ref_key}`);
  }

  // Last resort so an unrecognised shape still gets a stable handle rather than
  // silently matching nothing and reading as a retrieval failure.
  if (ids.length === 0) {
    const fallback = result.ref_key || result.drive_file_id || result.title;
    if (fallback) ids.push(`${source}:${fallback}`);
  }
  return ids;
}

/** The one identity used for dedupe and for display. */
export function documentKeyOf(result) {
  return identitiesOf(result)[0] || null;
}

/** Collapse repeat chunks of the same document, keeping the best ranked one. */
export function dedupeByDocument(results) {
  const seen = new Set();
  const out = [];
  for (const r of results || []) {
    const key = documentKeyOf(r);
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Rank (1 based) of the first result matching any acceptable reference for a
 * slot, or Infinity when the slot never appears.
 */
function slotRank(slot, results) {
  const accept = new Set(slot.any_of || []);
  for (let i = 0; i < results.length; i++) {
    for (const id of identitiesOf(results[i])) {
      if (accept.has(id)) return i + 1;
    }
  }
  return Infinity;
}

/**
 * Score one question against one ordered result list.
 *
 * Returns the rank at which the question became fully answerable plus the
 * per slot detail, because "recall@5 dropped" is not actionable and "the second
 * document for q14 fell out of the window" is.
 */
export function scoreQuestion(question, results) {
  const slots = (question.expect || []).map((slot) => ({
    doc: slot.doc,
    rank: slotRank(slot, results),
  }));

  // A question with no expected document cannot be scored on rank. Unanswerable
  // entries take that branch and are handled by scoreRefusal instead.
  if (slots.length === 0) return { slots, satisfiedAt: null, scorable: false };

  const satisfiedAt = slots.reduce((worst, s) => Math.max(worst, s.rank), 0);
  return { slots, satisfiedAt, scorable: true };
}

/**
 * Does this answer admit it does not know?
 *
 * Kept generous on purpose. The failure this catches is a confident fabrication,
 * and any phrasing that concedes the corpus is silent counts as the right
 * behavior regardless of how it is worded. A brain that produced no answer at
 * all (no LLM key, spend cap reached) is NOT counted as an honest refusal,
 * because that says nothing about whether it would have made something up.
 */
const REFUSAL_RE =
  /\b(do(es)?\s+not\s+(contain|answer|address|include|cover|mention|specify|provide)|no\s+(information|record|records|mention|reference|documents?|evidence|data)\b|nothing\s+(recorded|found|in\s+the)|not\s+(found|present|available|documented)\s+in\b|unable\s+to\s+(find|locate)|there\s+is\s+no\b|i\s+(don'?t|do\s+not)\s+have\b|cannot\s+(find|answer|determine)|silent\s+on\b)/i;

export function looksLikeRefusal(answer) {
  return typeof answer === "string" && REFUSAL_RE.test(answer);
}

/**
 * Score an unanswerable question from a /think response.
 *
 * Pass means the brain said it did not know. Gaps alone are not enough: the
 * gap list is advisory and can sit next to a confidently wrong sentence, and it
 * is the sentence a client reads.
 */
export function scoreRefusal(thinkResponse) {
  const answer = thinkResponse?.answer ?? null;
  const gaps = Array.isArray(thinkResponse?.gaps) ? thinkResponse.gaps.length : 0;

  if (answer === null) {
    return {
      pass: false,
      inconclusive: true,
      gaps,
      detail: thinkResponse?.answer_error || "no answer produced",
    };
  }
  const refused = looksLikeRefusal(answer);
  return {
    pass: refused,
    inconclusive: false,
    gaps,
    detail: refused
      ? "stated that the corpus does not answer this"
      : "answered as though the corpus contains this",
  };
}

/** recall@k, MRR and the pass list over already scored questions. */
export function aggregate(scored, ks = [1, 5]) {
  const scorable = scored.filter((s) => s.scorable);
  const n = scorable.length;
  const recall = {};
  for (const k of ks) {
    recall[k] = n === 0 ? 0 : scorable.filter((s) => rankOf(s) <= k).length / n;
  }
  const mrr =
    n === 0
      ? 0
      : scorable.reduce((sum, s) => {
          const r = rankOf(s);
          return sum + (Number.isFinite(r) ? 1 / r : 0);
        }, 0) / n;
  return { n, recall, mrr };
}

/**
 * A miss is Infinity in memory, and JSON.stringify writes Infinity as null.
 *
 * Read back naively, that null compares as 0 in JavaScript, so every question
 * that missed in the baseline reads as having passed at rank zero and every
 * miss in the new run reads as a fresh regression. The gate then fails on a
 * run that changed nothing. Rank comparisons go through here.
 */
export function rankOf(entry) {
  const r = entry?.satisfiedAt;
  if (typeof r === "number" && Number.isFinite(r)) return r;
  if (r === "Infinity" || r === null || r === undefined) return Infinity;
  return Infinity;
}

/** Replacer and reviver so a saved run survives the round trip through JSON. */
export function jsonReplacer(_key, value) {
  return value === Infinity ? "Infinity" : value;
}

/** Questions that passed before and fail now. This is the release gate. */
export function findRegressions(current, baseline, k = 5) {
  if (!baseline) return [];
  const before = new Map((baseline.questions || []).map((q) => [q.id, q]));
  const out = [];
  for (const q of current.questions || []) {
    const was = before.get(q.id);
    if (!was) continue;

    if (q.kind === "unanswerable") {
      if (was.refusal?.pass && q.refusal && !q.refusal.pass) {
        out.push({ id: q.id, question: q.question, from: "refused", to: "answered anyway" });
      }
      continue;
    }
    if (!was.scorable || !q.scorable) continue;
    const wasRank = rankOf(was);
    const nowRank = rankOf(q);
    if (wasRank <= k && nowRank > k) {
      out.push({
        id: q.id,
        question: q.question,
        from: `rank ${wasRank}`,
        to: Number.isFinite(nowRank) ? `rank ${nowRank}` : "not in results",
      });
    }
  }
  return out;
}

/** Improvements, so a good change gets credit rather than a silent pass. */
export function findImprovements(current, baseline, k = 5) {
  if (!baseline) return [];
  const before = new Map((baseline.questions || []).map((q) => [q.id, q]));
  const out = [];
  for (const q of current.questions || []) {
    const was = before.get(q.id);
    if (!was) continue;
    if (q.kind === "unanswerable") {
      if (was.refusal && !was.refusal.pass && q.refusal?.pass) {
        out.push({ id: q.id, question: q.question, from: "answered anyway", to: "refused" });
      }
      continue;
    }
    if (!was.scorable || !q.scorable) continue;
    const wasRank = rankOf(was);
    const nowRank = rankOf(q);
    if (wasRank > k && nowRank <= k) {
      out.push({
        id: q.id,
        question: q.question,
        from: Number.isFinite(wasRank) ? `rank ${wasRank}` : "not in results",
        to: `rank ${nowRank}`,
      });
    }
  }
  return out;
}
