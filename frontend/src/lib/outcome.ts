/** The five words this product is allowed to say about a thing's state.
 *
 *  Adopted from the reference prototype. The value is not the words themselves, it is
 *  that the set is CLOSED and each member carries a glyph:
 *
 *   - Closed, so a screen cannot invent a sixth state that means almost the
 *     same as one that exists. Five words an owner learns once beat twenty
 *     they have to keep re-reading.
 *   - Glyphed, so status survives grayscale, colour blindness, a bad screen,
 *     and print. Colour carries NO information here; it only reinforces what
 *     the glyph and the word already say.
 *
 *  Filed and Current are both finished, and they are not the same finished:
 *  Filed means the thing is done and put away, Current means it is up to date
 *  as of now. Collapsing them loses the distinction an owner actually asks
 *  about. */
export type OutcomeKey = "WORKING" | "NEEDS" | "FILED" | "CURRENT" | "PROBLEM";

export const OUTCOME: Record<OutcomeKey, { label: string; glyph: string; tone: Tone }> = {
  WORKING: { label: "Working on it", glyph: "○", tone: "wait" },
  NEEDS:   { label: "Needs you",     glyph: "△", tone: "act" },
  FILED:   { label: "Filed",         glyph: "■", tone: "done" },
  CURRENT: { label: "Current",       glyph: "●", tone: "good" },
  PROBLEM: { label: "Problem",       glyph: "✕", tone: "bad" },
};

export type Tone = "wait" | "act" | "done" | "good" | "bad";

/** Server states that arrived with no word for them.
 *
 *  A state this vocabulary has never been mapped against is a real event, not
 *  a theoretical one. Rather than crash or quietly borrow a word that means
 *  something else, an unknown key renders as Problem and is RECORDED, so the
 *  gap is countable instead of invisible. Same discipline as `unmappedWords`
 *  in words.ts. */
export const UNTRANSLATED_STATES = new Set<string>();

/** A source's cadence is not its health. Manual and unscheduled sources carry
 *  useful context, but neither is a problem or proof that the source is
 *  current. The UI therefore shows no health chip for those two states. */
export function sourceOutcome(state: string): OutcomeKey | null {
  if (state === "manual" || state === "unscheduled") return null;
  if (state === "ok") return "CURRENT";
  if (state === "indexing") return "WORKING";
  if (state === "review") return "NEEDS";
  if (state === "broken" || state === "stale" || state === "never_synced") return "PROBLEM";
  if (state) UNTRANSLATED_STATES.add(`source:${state}`);
  return "PROBLEM";
}

export function outcomeFor(key: string | null | undefined) {
  const found = key && OUTCOME[key as OutcomeKey];
  if (found) return found;
  if (key) UNTRANSLATED_STATES.add(String(key));
  // The honest thing, in the product's own words.
  return { label: "Problem", glyph: "✕", tone: "bad" as Tone };
}

/** Whose move is this? An owner should be able to tell at a glance what is
 *  waiting on THEM versus what someone else owes them. The reference design tracks this per row
 *  and then counts it in a summary sentence; the counting is what makes the
 *  distinction usable rather than decorative. */
export type MoveOwner = "yours" | "installer" | "waiting";

export const MOVE_LABEL: Record<MoveOwner, string> = {
  yours: "Your move",
  installer: "Your installer's move",
  waiting: "Waiting on someone else",
};
