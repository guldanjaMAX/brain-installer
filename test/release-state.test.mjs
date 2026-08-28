/**
 * A release may claim only the label its evidence supports.
 *
 * WHAT THESE TESTS ARE DEFENDING
 *
 * Measured on 2026-08-28: v0.1.16, v0.1.17, v0.1.18 and v0.1.19 were published
 * as ordinary immutable GitHub releases — not drafts, not pre-releases, one
 * asset each — while `docs/release-evidence/` held nothing newer than v0.1.15
 * and the maintainer guide in the same repository still listed the gates those
 * releases had never completed. Both statements were readable, neither pointed
 * at the other, and an operator reading either one alone got a different answer
 * to "can I put a client on this".
 *
 * So these tests are not about coverage. Each one names a way the claim could
 * grow larger than the proof:
 *   - a recorded label larger than the evidence files that exist
 *   - a gate quietly marked non-blocking with no reason beside it
 *   - a release published as production while its own record says otherwise
 *   - a document describing a release it no longer matches
 *
 * They execute the evaluator against the real manifest and the real evidence
 * directory. Nothing here greps a source file for a sentence.
 *
 * Every fixture name here is invented. This repository is public.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_LABELS,
  evaluateReleaseState,
  evidenceFilename,
  gatesWithEvidence,
  labelFromEvidence,
  readReleaseStamp,
  recordedReleaseState,
  releaseStampLine,
  releaseStateBanner,
  validateGateManifest,
} from "../operations/release-state.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};
const throws = (fn) => { try { fn(); return null; } catch (error) { return String(error.message || error); } };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "docs/release-gates.json"), "utf8"));
const evidenceFiles = readdirSync(resolve(ROOT, "docs/release-evidence"));
const packageVersion = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;

/* ================================================================ */
/* 1. The real manifest is well formed, and every gate that does not */
/*    block says why not.                                            */
/* ================================================================ */
{
  check("the shipped gate manifest validates", throws(() => validateGateManifest(manifest)) === null,
    throws(() => validateGateManifest(manifest)));
  const nonBlocking = manifest.gates.filter((gate) => gate.blocking === false);
  check("at least one gate is deliberately non-blocking, so the rule is exercised", nonBlocking.length >= 1);
  check("and every non-blocking gate carries a written reason",
    nonBlocking.every((gate) => String(gate.why_not_blocking || "").trim().length > 40),
    JSON.stringify(nonBlocking.map((g) => g.id)));

  const missingReason = structuredClone(manifest);
  missingReason.gates.find((gate) => gate.blocking === false).why_not_blocking = "";
  check("a non-blocking gate with no reason is refused",
    /non-blocking and does not say why/.test(throws(() => validateGateManifest(missingReason)) || ""),
    throws(() => validateGateManifest(missingReason)));
}

/* ================================================================ */
/* 2. THE GATE ITSELF: every recorded label matches the evidence     */
/*    files that actually exist.                                     */
/* ================================================================ */
{
  const disagreed = [];
  for (const version of Object.keys(manifest.releases)) {
    const state = evaluateReleaseState({ version, manifest, evidenceFilenames: evidenceFiles });
    if (!state.agrees) disagreed.push(`${version}: recorded ${state.recorded}, evidence supports ${state.supported}`);
  }
  check("no recorded release claims more than its evidence supports", disagreed.length === 0, disagreed.join(" | "));

  check("the package version is recorded in the manifest",
    Object.prototype.hasOwnProperty.call(manifest.releases, packageVersion),
    `${packageVersion} not in ${Object.keys(manifest.releases).join(", ")}`);

  const current = evaluateReleaseState({ version: packageVersion, manifest, evidenceFilenames: evidenceFiles });
  check("and the current candidate is not recorded as production while its gates are open",
    current.recorded !== "production" || current.blocking_unmet.length === 0,
    JSON.stringify(current));
}

/* ================================================================ */
/* 3. The check discriminates: an overclaimed label is caught.       */
/* ================================================================ */
{
  const overclaimed = structuredClone(manifest);
  overclaimed.releases[packageVersion].evidence_label = "production";
  const state = evaluateReleaseState({ version: packageVersion, manifest: overclaimed, evidenceFilenames: evidenceFiles });
  check("claiming production with no evidence disagrees", state.agrees === false, JSON.stringify(state));
  check("and it names which blocking gates are still open", state.blocking_unmet.length > 0, JSON.stringify(state.blocking_unmet));

  // The other direction matters just as much: adding the evidence must be what
  // moves the label, or the gate is decorative.
  const everyBlocking = manifest.gates
    .filter((gate) => gate.blocking !== false)
    .map((gate) => evidenceFilename(gate, packageVersion));
  const promoted = structuredClone(overclaimed);
  promoted.releases[packageVersion].gates_met = manifest.gates
    .filter((gate) => gate.blocking !== false).map((gate) => gate.id);
  const withEvidence = evaluateReleaseState({
    version: packageVersion,
    manifest: promoted,
    evidenceFilenames: [...evidenceFiles, ...everyBlocking],
  });
  check("and the same claim agrees once every blocking gate has an evidence file",
    withEvidence.agrees === true && withEvidence.supported === "production", JSON.stringify(withEvidence));

  // The label alone is not enough. A release that records the right label and
  // the wrong met-gate list would let an installed CLI name gates as closed
  // that have no evidence, which is the same lie one level down.
  const wrongList = structuredClone(promoted);
  wrongList.releases[packageVersion].gates_met = ["CI-MATRIX"];
  const mismatched = evaluateReleaseState({
    version: packageVersion,
    manifest: wrongList,
    evidenceFilenames: [...evidenceFiles, ...everyBlocking],
  });
  check("a correct label with the wrong met-gate list still disagrees",
    mismatched.agrees === false && mismatched.met_matches === false, JSON.stringify(mismatched));
}

/* ================================================================ */
/* 3b. What the installed package can say with no evidence directory.*/
/* ================================================================ */
{
  const runtime = recordedReleaseState(manifest, packageVersion);
  check("the runtime reader repeats the recorded label", runtime.recorded === manifest.releases[packageVersion].evidence_label);
  check("and derives the open blocking gates from the recorded met list",
    runtime.blocking_unmet.length === manifest.gates.filter((g) => g.blocking !== false).length,
    JSON.stringify(runtime));
  check("and reports an unrecorded version as unrecorded rather than as internal",
    recordedReleaseState(manifest, "9.9.9").recorded_at_all === false);
}

/* ================================================================ */
/* 4. A release published as production with a smaller evidence      */
/*    label has to say so.                                           */
/* ================================================================ */
{
  const published = Object.entries(manifest.releases).filter(([, entry]) => entry.published_as === "production");
  check("the register records releases that were published as production", published.length >= 4, String(published.length));
  const overclaims = published.filter(([, entry]) => entry.evidence_label !== "production");
  check("and every one whose evidence was smaller carries a note saying so",
    overclaims.length > 0 && overclaims.every(([, entry]) => String(entry.overclaim_note || "").trim().length > 40),
    JSON.stringify(overclaims.map(([v]) => v)));

  const silent = structuredClone(manifest);
  silent.releases["0.1.16"].overclaim_note = "";
  check("a silent overclaim is refused",
    /published as production with internal evidence and does not say so/.test(throws(() => validateGateManifest(silent)) || ""),
    throws(() => validateGateManifest(silent)));
}

/* ================================================================ */
/* 5. Label arithmetic, at its boundaries.                          */
/* ================================================================ */
{
  const gates = [
    { id: "A", title: "a", blocking: true, evidence: "v<version>-a.json" },
    { id: "B", title: "b", blocking: true, evidence: "v<version>-b.json" },
    { id: "C", title: "c", blocking: false, why_not_blocking: "x".repeat(50), evidence: "v<version>-c.json" },
  ];
  check("no evidence at all is internal", labelFromEvidence(gates, []) === "internal");
  check("only a non-blocking gate is still preview, never production",
    labelFromEvidence(gates, ["C"]) === "preview", labelFromEvidence(gates, ["C"]));
  check("one blocking gate short is preview", labelFromEvidence(gates, ["A"]) === "preview");
  check("every blocking gate met is production", labelFromEvidence(gates, ["A", "B"]) === "production");
  check("every label the module can emit is a declared label",
    ["internal", "preview", "production"].every((label) => RELEASE_LABELS.includes(label)));

  const { met, unmet } = gatesWithEvidence(gates, "9.9.9", ["v9.9.9-b.json", "v0.0.1-a.json"]);
  check("evidence is matched to the EXACT version, not any version",
    met.join() === "B" && unmet.join() === "A,C", JSON.stringify({ met, unmet }));
}

/* ================================================================ */
/* 6. The stamp, which is what binds a document to a release.        */
/* ================================================================ */
{
  check("a stamped document reports its release", readReleaseStamp(`# x\n\n${releaseStampLine("1.2.3")}\n`) === "1.2.3");
  check("an unstamped document reports nothing", readReleaseStamp("# x\n\nno stamp here\n") === null);
  check("a stamp buried mid-sentence does not count",
    readReleaseStamp("see **Applies to release 1.2.3.** above") === null);
  check("the maintainer guide is stamped to the package version",
    readReleaseStamp(readFileSync(resolve(ROOT, "docs/MAINTAINER.md"), "utf8")) === packageVersion);
  check("and so is the developer guide",
    readReleaseStamp(readFileSync(resolve(ROOT, "docs/README-developer.md"), "utf8")) === packageVersion);
}

/* ================================================================ */
/* 7. The banner a person reads.                                    */
/* ================================================================ */
{
  const internal = evaluateReleaseState({ version: packageVersion, manifest, evidenceFilenames: evidenceFiles });
  const banner = releaseStateBanner(internal);
  check("a non-production release announces its label", /labelled internal/.test(banner || ""), banner);
  check("and says how many gates are open", /release gate\(s\) have no recorded evidence/.test(banner || ""), banner);

  const production = { ...internal, recorded: "production", blocking_unmet: [] };
  check("a production release says nothing, so the line stays worth reading",
    releaseStateBanner(production) === null, String(releaseStateBanner(production)));

  const unrecorded = evaluateReleaseState({ version: "9.9.9", manifest, evidenceFilenames: evidenceFiles });
  check("an unrecorded version is reported as unrecorded, not as passing",
    /not recorded in the release gate manifest/.test(releaseStateBanner(unrecorded) || ""),
    releaseStateBanner(unrecorded));
}

/* ================================================================ */
/* 8. The wired command, executed. Not a grep for a sentence.        */
/* ================================================================ */
{
  const { cmdWhatsnew } = await import("../brain.mjs");
  const run = async (gates) => {
    const dir = mkdtempSync(join(tmpdir(), "brain-release-state-"));
    const gatesPath = join(dir, "release-gates.json");
    writeFileSync(gatesPath, gates);
    const lines = [];
    const real = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try { await cmdWhatsnew(undefined, { gatesPath }); }
    finally { console.log = real; rmSync(dir, { recursive: true, force: true }); }
    return lines.join("\n");
  };

  const asShipped = await run(JSON.stringify(manifest));
  check("whatsnew prints the recorded label for a non-production release",
    /labelled internal/.test(asShipped), asShipped.split("\n")[0]);
  check("and it prints it before the changelog, not after",
    asShipped.indexOf("labelled internal") < asShipped.indexOf("What's new"),
    `${asShipped.indexOf("labelled internal")} vs ${asShipped.indexOf("What's new")}`);

  const asProduction = structuredClone(manifest);
  asProduction.releases[packageVersion] = {
    evidence_label: "production",
    gates_met: manifest.gates.filter((g) => g.blocking !== false).map((g) => g.id),
    published_as: "production",
  };
  const quiet = await run(JSON.stringify(asProduction));
  // Scoped to the banner's own sentence: the changelog body legitimately
  // contains the word "labeled" in an unrelated entry.
  check("a production release prints no banner at all",
    !/is labelled |gate record shipped with/.test(quiet), quiet.split("\n").slice(0, 2).join(" | "));

  const broken = await run("{ not json");
  check("an unreadable gate record says so rather than rendering like production",
    /could not be read/.test(broken), broken.split("\n")[0]);

  const invalid = await run(JSON.stringify({ schema_version: 1, gates: [], releases: {} }));
  check("and so does a gate record that does not validate",
    /could not be read/.test(invalid), invalid.split("\n")[0]);
}

console.log(`\n${ran - fail}/${ran} release-state checks passed`);
if (fail) process.exit(1);
