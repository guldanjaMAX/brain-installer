/**
 * `brain check`: run every probe, group what comes back, and hand the owner
 * one decision per conflict.
 *
 * Every side effect is injected. The whole run is testable without a brain,
 * a network, or a person, which matters because the one thing this must never
 * do is decide something on the owner's behalf, and that is a property you
 * prove by test rather than by reading.
 */

import { PROBES, candidatesFrom } from "./check-probes.mjs";
import { renderSweep, sweep } from "./contradiction-sweep.mjs";
import { OWNER_CONFIRMED_SOURCE } from "./provenance.mjs";

/** Ask the brain for each probe's records. A probe that errors is reported, never silently dropped. */
export async function gather(search, { probes = PROBES, limit = 25 } = {}) {
  const results = [];
  for (const probe of probes) {
    let rows = [];
    let error = null;
    try {
      const body = await search({ q: probe.query, limit });
      rows = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
    } catch (e) {
      error = String(e?.message || e);
    }
    results.push({
      name: probe.name, changes: probe.changes, freeform: Boolean(probe.freeform),
      error, rows,
      candidates: error ? [] : candidatesFrom(probe, rows),
    });
  }
  return results;
}

/**
 * A freeform probe has no extracted values, so it cannot be grouped and must
 * not pretend to be. It is reported as reading for the owner rather than as a
 * conflict, because inventing a value here is exactly the confident-and-wrong
 * behaviour the whole pass exists to remove.
 */
export function partition(gathered = []) {
  return {
    structured: gathered.filter((g) => !g.freeform && !g.error),
    freeform: gathered.filter((g) => g.freeform && !g.error),
    failed: gathered.filter((g) => g.error),
  };
}

export function renderReport(gathered = []) {
  const { structured, freeform, failed } = partition(gathered);
  const assessed = sweep(structured.map((s) => ({ name: s.name, changes: s.changes, candidates: s.candidates })));
  const out = [renderSweep(assessed)];

  if (freeform.length) {
    out.push("", "## Worth your own eyes",
      "These change, and they have no dependable shape for a machine to read, so",
      "nothing here is grouped or guessed. Skim the records and tell me what is current.");
    for (const f of freeform) {
      const withRecords = f.rows.length;
      out.push(`  • ${f.name}: ${withRecords} record(s)${withRecords ? "" : " — nothing found"}`);
    }
  }
  if (failed.length) {
    out.push("", "## Could not check");
    for (const f of failed) out.push(`  • ${f.name}: ${f.error}`);
    out.push("These were NOT checked. Do not read the rest as a clean bill for them.");
  }
  out.push("", "Nothing has been written. Run the same command with --set to record your answers.");
  return { text: out.join("\n"), assessed, freeform, failed };
}

/**
 * The document a confirmation becomes.
 *
 * `Operative value`, `As of` and `Supersedes` are the load-bearing parts: they
 * are what lets a later answer say "you confirmed this in September" instead
 * of "four documents agree". Written as one dated file per pass, never
 * overwriting the last one, so the brain can show its work.
 */
export function renderConfirmations(answers = [], { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!answers.length) return null;
  const lines = [
    `# Confirmed by the owner, ${today}`,
    "",
    "Each entry below was stated by the owner on the date shown, after being",
    "shown every record that disagreed. These supersede the documents named.",
    "",
  ];
  for (const a of answers) {
    lines.push(`## ${a.name}`, `Operative value: ${a.value}`, `As of: ${today}, confirmed by the owner`);
    if (a.supersedes?.length) lines.push(`Supersedes: ${a.supersedes.join("; ")}`);
    if (a.note) lines.push(`Note: ${a.note}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The ingest envelope for a confirmation document. Its source is what makes it primary. */
export function confirmationEnvelope(markdown, { today = new Date().toISOString().slice(0, 10) } = {}) {
  return {
    source_type: "curated",
    source: OWNER_CONFIRMED_SOURCE,
    source_id: `owner-confirmed/${today}`,
    title: `Confirmed by the owner, ${today}`,
    occurred_at: `${today}T12:00:00.000Z`,
    content: markdown,
    metadata: { category: "owner-confirmed", authority: "T1" },
  };
}

/**
 * Ask one question per conflict and collect the answers.
 *
 * `ask` returns the owner's typed reply. An empty reply means "I do not know",
 * which is recorded as unresolved rather than resolved by silence.
 */
export async function collectAnswers(assessed = [], ask) {
  const answers = [];
  const unresolved = [];
  for (const a of assessed.filter((x) => x.conflict)) {
    const options = a.groups.map((g, i) => `  ${i + 1}. ${g.value}  (${g.count} record(s), strongest ${g.best.name})`);
    const reply = String(await ask(
      `${a.name}\n${a.verdict.line}\n${options.join("\n")}\n` +
      `Which is current? Type the number, or the correct value if none of these is right, or press enter if you are not sure.`,
    ) ?? "").trim();
    if (!reply) { unresolved.push(a.name); continue; }
    const picked = /^\d+$/.test(reply) ? a.groups[Number(reply) - 1] : null;
    if (/^\d+$/.test(reply) && !picked) { unresolved.push(a.name); continue; }
    answers.push({
      name: a.name,
      value: picked ? picked.value : reply,
      supersedes: a.groups.filter((g) => g !== picked).map((g) => g.value),
      note: picked ? null : "value supplied by the owner; none of the records had it",
    });
  }
  return { answers, unresolved };
}
