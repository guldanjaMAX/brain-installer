/**
 * The owner's view of their brain's condition.
 *
 * Two traps this file exists for.
 *
 * 1. `documents: 0` is the most dangerous number here. An empty corpus and an
 *    unreachable diagnose look identical the moment a failure is flattened to
 *    zero, and "your brain holds nothing" is a very different sentence from
 *    "we could not check". A failed read must name itself and omit its keys.
 *
 * 2. The operator remedy must not reach the owner as their to-do. Every
 *    diagnose `action` is a `brain` CLI command they cannot run.
 */
import { ownerSystemStatus } from "../src/lib/system-status.js";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200)));
  if (!c) fail++;
};

const okHealth = () => ({ status: "ok", accepting_documents: true, vector_drain_mode: "active" });
const okDiagnose = async () => ({
  totals: { documents: 70844, chunks: 876761, sources: 3 },
  summary: { crit: 2, warn: 1, info: 2, ok: 1 },
  findings: [
    { id: "empty_documents", area: "coverage", severity: "crit", count: 1,
      title: "1 document(s) hold no text", detail: "d",
      action: "Re-ingest with OCR, or remove them", samples: ["private-file.pdf"] },
    { id: "undated", area: "coverage", severity: "info", count: 931, title: "no date", action: "x" },
  ],
});
const okFresh = async () => ({ sources: [
  { name: "drive", kind: "drive", state: "broken", documents: 24104, days_since_ingest: 5,
    reason: "indexing has not completed for 21 hour(s)", automatable: true },
  { name: "wildcard_slug", kind: "upload", state: "manual", documents: 3, days_since_ingest: 1 },
] });
const okVectors = async () => ({ ready: false, expected_vectors: 1000, actual_vectors: 895, pending: 105 });
const deps = { health: okHealth, diagnose: okDiagnose, freshness: okFresh, vectorReadiness: okVectors };

/* --------------------------------------------------------------- happy path */
{
  const s = await ownerSystemStatus({}, deps);
  check("documents come through", s.documents === 70844, String(s.documents));
  check("percent visible is computed", s.vectors.percent_visible === 89, String(s.vectors.percent_visible));
  check("nothing is unavailable", s.unavailable.length === 0, JSON.stringify(s.unavailable));
  check("crit and warn are surfaced as problems", s.problems.length === 1, JSON.stringify(s.problems.map(p=>p.id)));
  check("info findings are not problems", !s.problems.some((p) => p.id === "undated"));
}

/* ---------------------------------------------- the operator remedy is withheld */
{
  const s = await ownerSystemStatus({}, deps);
  const text = JSON.stringify(s);
  check("the CLI remedy never reaches the owner", !/Re-ingest with OCR/.test(text));
  check("and the problem says whose fix it is", s.problems[0].fix_owner === "installer", s.problems[0].fix_owner);
  check("document samples are not dumped into a status summary", !/private-file\.pdf/.test(text));
}

/* ------------------------------------------------------- slugs are never shown */
{
  const s = await ownerSystemStatus({}, deps);
  const text = JSON.stringify(s.sources);
  check("a known slug becomes a label", s.sources[0].label === "Google Drive", s.sources[0].label);
  check("an unknown slug is NOT printed", !/wildcard_slug/.test(text), text);
  check("and falls back to something readable", s.sources[1].label === "Files you uploaded", s.sources[1].label);
}

/* ------------------------------------ a failed read is not a zero, and says so */
{
  const s = await ownerSystemStatus({}, { ...deps, diagnose: async () => { throw new Error("down"); } });
  check("a broken diagnose is NAMED", s.unavailable.includes("diagnose"), JSON.stringify(s.unavailable));
  check("documents is ABSENT, not 0", !("documents" in s), String(s.documents));
  check("problems is ABSENT, not []", !("problems" in s), JSON.stringify(s.problems));
  check("the working reads still come through", s.sources.length === 2 && !!s.vectors);
}
{
  const s = await ownerSystemStatus({}, { ...deps, freshness: async () => { throw new Error("down"); } });
  check("a broken freshness is NAMED", s.unavailable.includes("freshness"));
  check("sources is ABSENT, not []", !("sources" in s));
}
{
  const s = await ownerSystemStatus({}, {
    ...deps,
    freshness: async () => ({ sources: [], unavailable: true }),
  });
  check("a typed unavailable freshness result is NAMED", s.unavailable.includes("freshness"));
  check("typed unavailable freshness omits sources, not healthy empty", !("sources" in s));
}
{
  const s = await ownerSystemStatus({}, { ...deps, vectorReadiness: async () => { throw new Error("down"); } });
  check("broken vectors are NAMED", s.unavailable.includes("vectors"));
  check("vectors is ABSENT, so no false 0%", !("vectors" in s));
}

/* ------------------------------------- 'cannot tell' is a third answer, not yes */
{
  const s = await ownerSystemStatus({}, { ...deps, health: () => ({ status: "ok" }) });
  check("absent accepting_documents is null, NOT true", s.accepting_documents === null, String(s.accepting_documents));
}
{
  const s = await ownerSystemStatus({}, { ...deps, health: () => { throw new Error("down"); } });
  check("a broken health is named", s.unavailable.includes("health"));
  check("and does not claim the brain accepts documents", s.accepting_documents === null, String(s.accepting_documents));
}
{
  const paused = () => ({ status: "paused-for-upgrade", accepting_documents: false, vector_drain_mode: "paused-for-upgrade" });
  const s = await ownerSystemStatus({}, { ...deps, health: paused });
  check("a paused brain says so", s.accepting_documents === false && s.status === "paused-for-upgrade");
}

/* ------------------------------------------------ an empty brain is not a broken one */
{
  const empty = async () => ({ totals: { documents: 0, chunks: 0, sources: 0 }, summary: {}, findings: [] });
  const s = await ownerSystemStatus({}, { ...deps, diagnose: empty });
  check("an EMPTY brain reports 0 documents present", s.documents === 0 && !s.unavailable.includes("diagnose"));
  check("which is distinguishable from a broken read", "documents" in s);
}

console.log(`\n${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
