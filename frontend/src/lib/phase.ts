import type { SystemStatus } from "./api";

/** What state this brain is actually in, derived in exactly one place.
 *
 *  Centralised because the derivation has a trap in it. An empty corpus
 *  computes a HEALTHY verdict — the verdict only counts crit and warn findings,
 *  and a brain that has read nothing has nothing to complain about. Rendering
 *  that literally puts "everything checked came back clean" over a brain that
 *  knows nothing. Emptiness must therefore be tested BEFORE any verdict is
 *  read, and if every screen derived its own phase, one of them would
 *  eventually get that order wrong. */
export type BrainPhase =
  | "unreachable"   // we could not check; say nothing about contents
  | "paused"        // reading works, adding does not
  | "unknown"       // it would not say whether it accepts documents
  | "empty"         // it holds nothing yet
  | "indexing"      // it holds things it cannot all search yet
  | "problems"      // it works, and something is wrong that the installer owns
  | "ready";

export function derivePhase(s: SystemStatus | null): BrainPhase {
  if (!s) return "unreachable";

  // Order matters from here down. Each test is only meaningful once the ones
  // above it have been ruled out.
  const lostTheContents = s.unavailable?.includes("diagnose") || !("documents" in s);
  if (lostTheContents) return "unreachable";

  if (s.status === "paused-for-upgrade" || s.accepting_documents === false) return "paused";
  // Not a default to yes. A brain that would not say has not said yes.
  if (s.accepting_documents === null) return "unknown";

  // BEFORE any verdict. See the note above.
  if ((s.documents ?? 0) === 0) return "empty";

  if (s.vectors && !s.vectors.ready) return "indexing";
  if ((s.problem_counts?.crit ?? 0) > 0 || (s.problem_counts?.warn ?? 0) > 0) return "problems";
  return "ready";
}

/** One sentence per phase, in the owner's terms, said identically everywhere. */
export function phraseFor(phase: BrainPhase, s: SystemStatus | null): string {
  const pct = s?.vectors?.percent_visible;
  switch (phase) {
    case "unreachable":
      return "Your brain could not be reached just now, so nothing on this page is a statement about what it holds.";
    case "paused":
      return "Your brain is not accepting new documents right now. An update paused it and did not finish. Nothing has been lost, and asking questions still works.";
    case "unknown":
      return "Your brain would not say whether it is accepting documents. Reading still works. This is worth reporting.";
    case "empty":
      return "Your brain has not read anything yet. Add your first documents and it will start being able to answer.";
    case "indexing":
      return pct === null || pct === undefined
        ? "Your brain is still working through what it has been given. Answers will be incomplete until it finishes."
        : `Your brain can search ${pct}% of what it holds. It is still working through the rest, so an answer may be missing things it already has.`;
    case "problems":
      return "Your brain is working, and there is something your installer should look at.";
    case "ready":
      return "Your brain has read everything it has been given and can search all of it.";
  }
}

/** Whether this phase means an answer could be missing things. The Ask screen
 *  needs this so a partial index never renders as a confident absence. */
export const answersMayBeIncomplete = (p: BrainPhase) =>
  p === "indexing" || p === "unreachable" || p === "empty";
