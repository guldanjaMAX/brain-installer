// The acceptance verdict must not read green when retrieval was never tested.
//
// The defect this file keeps dead: with testing.probe_questions empty, the
// retrieval tier records one SKIP and the run still ended in an unqualified
// "acceptance suite passed". Reach, data, safety and operations were proven;
// nobody had asked the brain a single question. That sentence is the one a
// client reads on install day, and it is the instrument the money-back
// guarantee is judged against — so "passed" with the central capability
// untested is a false green, delivered at the worst possible moment.
//
// Three surfaces carry the verdict and all three are pinned here:
//   1. Acceptance.summary() must SAY the retrieval tier went untested.
//   2. acceptanceVerdict() must turn that into a qualified headline and loud
//      warnings for the terminal run (brain test / the upgrade stage).
//   3. The HTML report's computeVerdict must land "attention", not "ready".
// And brain setup must warn while there is still time to fix it, via
// emptyProbeQuestionsWarning.

import { Acceptance, acceptanceVerdict } from "../acceptance.mjs";
import { computeVerdict } from "../report-html.mjs";
import { emptyProbeQuestionsWarning } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

/* ------------------------------------------------ 1. summary honesty */

{
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  await suite.tierRetrieval([]);
  const out = suite.summary();
  check("an empty probe list is recorded as a tier-3 skip",
    out.results.some((r) => r.tier === 3 && r.status === "skip" && /probe/i.test(r.name)),
    JSON.stringify(out.results));
  check("the summary names retrieval as untested",
    Array.isArray(out.untested) && out.untested.includes("retrieval"),
    JSON.stringify(out.untested));
  check("an untested tier is not a failed tier: the suite still passes",
    out.passed === true, JSON.stringify(out));
}

{
  const suite = new Acceptance({ base: "https://brain.example", adminKey: "k", manifest: {} });
  suite.record(3, "probe: what did we agree", "pass", "3 result(s)");
  const out = suite.summary();
  check("a tested retrieval tier leaves untested empty",
    Array.isArray(out.untested) && out.untested.length === 0,
    JSON.stringify(out.untested));
}

/* ------------------------------------------- 2. the terminal verdict */

{
  const tested = acceptanceVerdict({ passed: true, untested: [], counts: { pass: 5, fail: 0, warn: 0, skip: 0 } });
  check("a fully tested pass keeps the plain headline",
    tested.headline === "acceptance suite passed", JSON.stringify(tested));
  check("a fully tested pass carries no warnings",
    Array.isArray(tested.warnings) && tested.warnings.length === 0, JSON.stringify(tested));
}

{
  const hollow = acceptanceVerdict({ passed: true, untested: ["retrieval"], counts: { pass: 5, fail: 0, warn: 0, skip: 1 } });
  check("an untested retrieval tier changes the headline itself",
    hollow.headline !== "acceptance suite passed" && /NOT tested|untested/i.test(hollow.headline),
    JSON.stringify(hollow.headline));
  check("the warnings say what is missing and where it goes",
    hollow.warnings.some((l) => /probe_questions/.test(l)),
    JSON.stringify(hollow.warnings));
  check("the warnings say what was actually proven and what was not",
    hollow.warnings.some((l) => /retrieval/i.test(l) && /not/i.test(l)),
    JSON.stringify(hollow.warnings));
}

{
  const failed = acceptanceVerdict({ passed: false, untested: ["retrieval"], counts: { pass: 3, fail: 2, warn: 0, skip: 1 } });
  check("a failed suite stays FAILED whatever else is untested",
    failed.headline === "acceptance suite FAILED", JSON.stringify(failed));
}

{
  const legacy = acceptanceVerdict({ passed: true, counts: { pass: 5, fail: 0, warn: 0, skip: 0 } });
  check("a summary without the untested field still gets a verdict",
    legacy.headline === "acceptance suite passed", JSON.stringify(legacy));
}

/* --------------------------------------------- 3. the HTML report */

const reportAcceptance = (untested) => ({
  counts: { pass: 12, fail: 0, warn: 0, skip: untested.length ? 1 : 0 },
  passed: true,
  stoppedAtTier: null,
  untested,
  results: [
    { tier: 1, name: "health responds", status: "pass", detail: "version 0.2.0" },
    ...(untested.length
      ? [{ tier: 3, name: "retrieval probes", status: "skip", detail: "no probe questions in the manifest (testing.probe_questions)" }]
      : [{ tier: 3, name: "probe coverage", status: "pass", detail: "2/2 probes returned sources" }]),
  ],
});

{
  const verdict = computeVerdict({ acceptance: reportAcceptance(["retrieval"]), acceptanceError: null, seeds: [] });
  check("the report verdict refuses 'ready' when retrieval went untested",
    verdict.state === "attention", JSON.stringify(verdict));
  check("the report verdict line says retrieval was not tested, in plain words",
    /retrieval|question/i.test(verdict.line) && /not|never/i.test(verdict.line),
    JSON.stringify(verdict.line));
}

{
  const verdict = computeVerdict({ acceptance: reportAcceptance([]), acceptanceError: null, seeds: [] });
  check("a tested install with no seed section still reads ready",
    verdict.state === "ready", JSON.stringify(verdict));
}

/* ------------------------------------------------- 4. setup warning */

{
  const quiet = emptyProbeQuestionsWarning(
    { testing: { probe_questions: ["why did we stop using those guys"] } },
    "brain.manifest.json",
  );
  check("a populated probe list warns about nothing", quiet === null, JSON.stringify(quiet));
}

for (const [label, manifest] of [
  ["an empty probe list", { testing: { probe_questions: [] } }],
  ["a missing testing block", {}],
  ["whitespace-only probes", { testing: { probe_questions: ["   "] } }],
]) {
  const lines = emptyProbeQuestionsWarning(manifest, "clients/brain.manifest.json");
  check(`${label} warns loudly`, Array.isArray(lines) && lines.length > 0, JSON.stringify(lines));
  check(`${label} names the manifest field`,
    (lines || []).some((l) => /testing\.probe_questions/.test(l)), JSON.stringify(lines));
  check(`${label} says what stays untested without it`,
    (lines || []).some((l) => /retrieval|acceptance/i.test(l)), JSON.stringify(lines));
}

console.log(`\nacceptance verdict: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
