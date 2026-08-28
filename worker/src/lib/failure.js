/**
 * failure — the one shape a caller branches on to know whether a response is
 * the whole answer.
 *
 * WHY THIS EXISTS. A field probe of a live install pointed four read routes at
 * a half-migrated brain. All four returned HTTP 200 and three of them were
 * lying: `/api/admin/brain/documents` came back 200 carrying two D1 "no such
 * column" errors buried in `vector_backlog.error` and `vector_readiness.error`,
 * and every caller that trusted `response.ok` read that as a healthy brain with
 * an empty queue. One of them, the installer's own backlog reader, literally
 * returned 0 for "could not be determined".
 *
 * So `response.ok` is not a success signal on this worker, and it never will be
 * on every route: `/api/rag/think` MUST keep answering 200 when retrieval could
 * not run, because the disclosure explaining that IS the payload, and a non-2xx
 * would make every ok-checking client throw the explanation away and print a
 * bare status code instead. See the note on `/think` in index.js.
 *
 * The fix is therefore two rules, not one:
 *
 *   1. When a route could not do the job it was asked to do, the STATUS says so.
 *      `/documents` cannot answer "how far does the vector index trail the text"
 *      when the query that answers it failed, so it is a 503 with the partial
 *      body attached rather than a 200 that reads as healthy.
 *
 *   2. Every 2xx body that carries a failure inside it declares `complete:
 *      false` and lists what failed in `failures`. One field, one meaning, every
 *      route. A consumer branches on that instead of learning a different error
 *      shape per endpoint.
 *
 * VERSION SKEW. A worker deployed before this module never sets `complete`, so
 * absence cannot mean "incomplete" without calling every older install broken.
 * `responseIncomplete` therefore also recognises the legacy shapes directly:
 * the nested `error` keys on `/documents`, `answer_error` on `/think`, and
 * per-document `failed` receipts in a batch. That is the same defence
 * `retrievalUnavailable` already uses in retrieval-status.js, and it is what
 * lets a newer client machine defend itself against an older deployed worker.
 */

/** Top-level field every route sets. `false` means the body is not the whole answer. */
export const COMPLETE = "complete";

/** Top-level list of what could not be produced, present only when incomplete. */
export const FAILURES = "failures";

/**
 * One subsystem that could not be read, in the shape that goes inside a body.
 *
 * The message is truncated and never carries the caller's content. D1 errors
 * name columns and tables, which is exactly what makes them useful here and
 * exactly why they must not grow unbounded.
 */
export function subsystemFailure(subsystem, error) {
  const detail = String(error?.message ?? error ?? "unavailable").slice(0, 300);
  return { subsystem: String(subsystem).slice(0, 64), error: detail, unavailable: true };
}

/**
 * Attach the envelope to a body.
 *
 * Always sets `complete`, including when nothing failed: a caller that can see
 * `complete: true` knows the worker implements this contract, and can treat a
 * missing field as "an older worker that cannot tell me either way".
 */
export function withCompleteness(body, failures = []) {
  const list = (Array.isArray(failures) ? failures : []).filter(Boolean);
  if (!list.length) return { ...body, [COMPLETE]: true };
  return { ...body, [COMPLETE]: false, [FAILURES]: list };
}

/** Collect the subsystem failures already embedded in a legacy-shaped body. */
function legacyFailures(body) {
  const found = [];
  for (const key of ["vector_backlog", "vector_readiness"]) {
    const value = body?.[key];
    if (value && typeof value === "object" && !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, "error")) {
      found.push(subsystemFailure(key, value.error));
    }
  }
  if (typeof body?.answer_error === "string" && body.answer_error) {
    found.push(subsystemFailure("answer", body.answer_error));
  }
  if (Array.isArray(body?.results)) {
    const failed = body.results.filter(
      (row) => row && typeof row === "object" && (row.status === "failed" || row.status === "refused"),
    );
    if (failed.length) {
      found.push(subsystemFailure("documents", `${failed.length} document(s) were not stored`));
    }
  }
  return found;
}

/**
 * Did this response fail to produce part of what was asked for?
 *
 * The single predicate every consumer uses, on every route. It is deliberately
 * tolerant of a worker older than this contract, and deliberately intolerant of
 * a 200 that hides an error: a caller that asks this question gets the truth
 * from either generation of worker.
 */
export function responseIncomplete(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body[COMPLETE] === false) return true;
  return legacyFailures(body).length > 0;
}

/**
 * What went wrong, for a message a human reads.
 *
 * Prefers the declared list, falls back to reconstructing it from the legacy
 * shapes so an older worker still produces a usable sentence rather than an
 * unexplained refusal.
 */
export function responseFailures(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const declared = Array.isArray(body[FAILURES]) ? body[FAILURES] : [];
  return declared.length ? declared : legacyFailures(body);
}

/** One line naming every failed subsystem. Empty string when the body is whole. */
export function describeFailures(body) {
  return responseFailures(body)
    .map((f) => `${f.subsystem}: ${f.error}`)
    .join("; ");
}
