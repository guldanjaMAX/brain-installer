/**
 * retrieval-status — what an empty result set is allowed to mean.
 *
 * Retrieval can return nothing for two completely different reasons, and until
 * this module existed both produced the same sentence:
 *
 *   1. The corpus genuinely holds nothing on the question. Saying so plainly is
 *      the product working. That path is untouched here.
 *   2. Part of the search never ran. The vector index is still building right
 *      after an install, the embedding model did not answer, keyword search is
 *      down. Nothing is known about the corpus, because the corpus was not
 *      fully read.
 *
 * Case 2 wearing case 1's sentence is the worst error this product can make: a
 * confident absence claim about the owner's own records, produced by the exact
 * discipline the brain is built on, and indistinguishable to the reader from a
 * correct answer. It is at its most likely on install day, when the index is
 * still projecting and the owner is asking their first questions.
 *
 * So the two cases get different statuses, different gap types, and different
 * sentences, and every surface derives them from here rather than writing its
 * own. `degraded` is the signal that separates them; it has ridden the wire
 * since before this module, which is why the clients can defend themselves with
 * `retrievalUnavailable` even against a worker deployed before this change.
 */

/** Wire value for `status` when the search did not complete. */
export const SEARCH_UNAVAILABLE = "search_unavailable";

/** Wire value for `status` when the search completed and matched nothing. */
export const NO_RESULTS = "no_results";

/**
 * The genuine no-match gap, verbatim.
 *
 * Frozen and exported because several tests pin this string: it is the honest
 * refusal, and no change in this file is allowed to soften it.
 */
export const NO_RESULTS_GAP = Object.freeze({
  type: "no_results",
  detail: "The brain has nothing on this query. Say so plainly rather than inferring.",
});

/**
 * Cause and remedy per degradation, in the owner's language.
 *
 * `cause` completes the sentence "The search could not be completed: ...".
 */
const CAUSES = {
  vector: {
    cause: "part of the search index is still being prepared",
    remedy: "Try again later. If it does not recover, ask your installer to check search.",
  },
  "no-embedding": {
    cause: "meaning-based search did not answer, so only exact-word search ran",
    remedy: "Try again in a moment. If it keeps happening, ask your installer to check search.",
  },
  fts: {
    cause: "exact-word search did not answer, so only meaning-based search ran",
    remedy: "Try again. If it keeps happening, ask your installer to check search.",
  },
};

const UNKNOWN_REMEDY = "Try again. If it keeps happening, ask your installer to check search.";

/** Normalise whatever the store reported into a short, safe token. */
function degradedToken(degraded) {
  if (degraded === null || degraded === undefined || degraded === false) return null;
  const token = String(degraded).trim().slice(0, 40);
  return token ? token : null;
}

/**
 * Why a search was incomplete, as a clause, or null when it was complete.
 *
 * An unrecognised value still yields a cause. A future degradation mode that
 * this module has never heard of must not fall through to "the brain has
 * nothing", which is precisely the failure being fixed.
 */
export function degradedCause(degraded) {
  const token = degradedToken(degraded);
  if (!token) return null;
  return CAUSES[token]?.cause || "one part of search did not answer";
}

/** What the owner can do about it. */
export function degradedRemedy(degraded) {
  const token = degradedToken(degraded);
  if (!token) return null;
  return CAUSES[token]?.remedy || UNKNOWN_REMEDY;
}

/**
 * The sentence a human reads in place of an answer.
 *
 * Deliberately contains no clause that reads as "there is no record". The eval
 * refusal scorer is a regex over exactly that family of phrasings, and
 * `worker/test/degraded-absence.test.mjs` asserts this string does not match
 * it, because a sentence that scores as a refusal will be read as one.
 */
export function unavailableNotice(degraded) {
  return [
    "The search could not be completed, so this is not an answer about what your brain holds.",
    `Cause: ${degradedCause(degraded)}.`,
    "This does not mean your brain is empty on this question.",
    degradedRemedy(degraded),
  ].join(" ");
}

/**
 * The instruction a consuming model follows.
 *
 * The gap text is the part an LLM actually acts on, so the prohibition has to
 * be in the gap, not merely implied by a sibling field it may never read.
 */
export function unavailableGap(degraded) {
  const token = degradedToken(degraded);
  return {
    type: SEARCH_UNAVAILABLE,
    degraded: token,
    detail:
      `The search could not be completed: ${degradedCause(degraded)}. ` +
      "This is a system state, NOT a finding about the corpus. " +
      "Do NOT say or imply that the brain has nothing on this question, and do not answer from your own knowledge instead. " +
      "Say that the search could not be completed, name the cause, and offer to retry.",
  };
}

/**
 * The whole disclosure for a zero-result retrieval.
 *
 * One call decides status, gaps and sentence together so no surface can pick up
 * half of it.
 */
export function emptyRetrievalDisclosure(degraded) {
  const token = degradedToken(degraded);
  if (!token) {
    return {
      unavailable: false,
      status: NO_RESULTS,
      degraded: null,
      cause: null,
      notice: null,
      gaps: [NO_RESULTS_GAP],
    };
  }
  return {
    unavailable: true,
    status: SEARCH_UNAVAILABLE,
    degraded: token,
    cause: degradedCause(token),
    notice: unavailableNotice(token),
    gaps: [unavailableGap(token)],
  };
}

/**
 * Should a client treat this /think or /unified body as an unavailable search?
 *
 * Written to be safe against version skew. An MCP server or CLI on the client's
 * machine can be newer than the worker it is pointed at, and a worker deployed
 * before this change sends `degraded` but no `status`. The second clause is what
 * protects that client: an empty body carrying any degradation is unavailable,
 * whatever the worker called it.
 */
export function retrievalUnavailable(body) {
  if (!body || typeof body !== "object") return false;
  if (body.status === SEARCH_UNAVAILABLE) return true;
  if (!degradedToken(body.degraded)) return false;
  const answered = typeof body.answer === "string" && body.answer.trim().length > 0;
  const cited = Array.isArray(body.citations) && body.citations.length > 0;
  const found = Array.isArray(body.results) && body.results.length > 0;
  return !answered && !cited && !found;
}
