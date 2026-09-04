/**
 * Ask a corpus where it disagrees with itself.
 *
 * For each fact that should have exactly ONE current value, gather every
 * candidate value the records offer and group them. More than one group is a
 * contradiction, a supersession, or a records gap, and the owner is the only
 * one who can say which.
 *
 * Diagnosis only. Nothing here decides anything, and deliberately so: the
 * majority answer is the one most likely to be stale, so a sweep that picked a
 * winner would pick wrong exactly when it mattered. See operations/provenance.mjs.
 *
 * Retrieval is injected, so the whole thing is testable without a brain.
 */

import { agreementVerdict, bestTier, tierOf } from "./provenance.mjs";

/** Fold whitespace and case so "12 Example Rd" and "12 example rd" are one value. */
export const defaultNormalise = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Group candidate values, strongest evidence first WITHIN each group.
 *
 * `candidates` are `{ value, doc }`, where doc carries source/title/uri and an
 * optional ISO `date` used only for reporting, never for winning.
 */
export function groupCandidates(candidates = [], { normalise = defaultNormalise } = {}) {
  const groups = new Map();
  for (const c of candidates) {
    if (c?.value == null || String(c.value).trim() === "") continue;
    const key = normalise(c.value);
    if (!groups.has(key)) groups.set(key, { value: String(c.value).trim(), docs: [] });
    groups.get(key).docs.push(c.doc || {});
  }
  return [...groups.values()]
    .map((g) => ({ ...g, best: bestTier(g.docs), count: g.docs.length }))
    .sort((a, b) => a.best.rank - b.best.rank || b.count - a.count);
}

/**
 * How dangerous is this disagreement?
 *
 * Highest is not "most values". It is the shape that produces a CONFIDENT
 * WRONG answer: a big pile of soft records saying one thing, with something
 * stronger, or something lonelier, saying another. A conflict where the
 * strongest evidence is already primary is far less dangerous, because the
 * brain will land on it anyway.
 */
export function severityOf(groups = []) {
  if (groups.length < 2) return 0;
  const biggest = groups.slice().sort((a, b) => b.count - a.count)[0];
  const total = groups.reduce((n, g) => n + g.count, 0);

  let score = groups.length;                                   // more competing values, more confusion
  if (biggest.best.rank >= 3) score += biggest.count * 2;      // a soft majority is what wins wrongly
  if (groups.some((g) => g !== biggest && g.best.rank < biggest.best.rank)) score += 5;  // better evidence outvoted
  if (biggest.count >= 3 && biggest.count >= total - 1) score += 3;  // one lonely dissenter against a pile

  // Recency is a reason to LOOK, never a reason to decide. When the newest
  // record disagrees with the biggest pile, that is the exact shape of the
  // real 2026-09-03 failure: four old records agreed on a former address and
  // the one recent record had the current one. Counting made the old value
  // win. This does not resolve it; it puts it at the top of the page.
  const dated = groups.flatMap((g) => g.docs.map((d) => ({ g, date: d.date })).filter((x) => x.date));
  if (dated.length) {
    const newest = dated.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (newest.g !== biggest) score += 5;
  }
  return Math.max(score, 1);
}

/**
 * One probe's result, ready to show a person.
 *
 * `changes` says whether this is a current-state fact. It drives the caution
 * language: agreement about a birthplace is fine, agreement about an address
 * is a warning.
 */
export function assessProbe({ name, changes = true, candidates = [] }, options = {}) {
  const groups = groupCandidates(candidates, options);
  // A conflict is never confidence, whatever the tiers say. Two primary
  // records that disagree are not two confirmations, they are a supersession:
  // both were true once and only one is true now. Only the owner knows which,
  // so the verdict describes the disagreement instead of resolving it. Found
  // by a test that expected a lease to outrank four soft records and got a
  // confident answer built on two competing authorities.
  const verdict = groups.length > 1
    ? {
        confident: false,
        caution: true,
        line: `your records give ${groups.length} different values for this, across ${groups.reduce((n, g) => n + g.count, 0)} record(s). `
          + (groups[0].best.rank <= 2
            ? "More than one of them is authoritative, which means one has been superseded rather than that one is wrong."
            : "None of them is authoritative."),
      }
    : agreementVerdict(groups.flatMap((g) => g.docs), { changes });
  return {
    name,
    changes,
    groups,
    conflict: groups.length > 1,
    missing: groups.length === 0,
    severity: severityOf(groups),
    verdict,
  };
}

/** Every probe, worst first, so the first thing a person reads is the thing most likely to be wrong. */
export function sweep(probeResults = [], options = {}) {
  return probeResults
    .map((p) => assessProbe(p, options))
    .sort((a, b) => b.severity - a.severity || Number(b.conflict) - Number(a.conflict));
}

/** The report a person reads. Evidence next to every verdict, never a verdict alone. */
export function renderSweep(assessed = []) {
  const out = [];
  const conflicts = assessed.filter((a) => a.conflict);
  const missing = assessed.filter((a) => a.missing);
  out.push(conflicts.length
    ? `${conflicts.length} of ${assessed.length} checked facts disagree with themselves. Worst first.`
    : `None of the ${assessed.length} checked facts disagree with themselves.`);
  for (const a of conflicts) {
    out.push("", `## ${a.name}`, `  ${a.verdict.line}`);
    for (const g of a.groups) {
      out.push(`  • ${g.value}`);
      out.push(`      ${g.count} record(s), strongest is ${g.best.name} — ${g.best.reason}`);
      for (const d of g.docs.slice(0, 3)) {
        const t = tierOf(d);
        out.push(`      - [${t.tier}] ${d.title || d.uri || d.source || "untitled"}${d.date ? `  (${d.date})` : ""}`);
      }
      if (g.docs.length > 3) out.push(`      - and ${g.docs.length - 3} more`);
    }
    out.push("  Which is current? Nothing is written until you say.");
  }
  if (missing.length) {
    out.push("", `Nothing in your records mentions: ${missing.map((m) => m.name).join(", ")}.`,
      "That is a records gap, not a contradiction. If it matters, it needs to come from you.");
  }
  return out.join("\n");
}
