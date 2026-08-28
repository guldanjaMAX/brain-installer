/**
 * What a release is allowed to CLAIM about itself.
 *
 * WHY THIS EXISTS
 *
 * Four releases were published as ordinary GitHub releases — not drafts, not
 * pre-releases — while the maintainer guide in the same repository still listed
 * the gates those releases had never completed. Nothing reconciled the two, so
 * both statements could be true at once and an operator reading either one
 * alone got a different answer to "can I put a client on this".
 *
 * The rule this module enforces is narrow and mechanical: a release may claim
 * only the label its recorded evidence supports. The gate manifest
 * (docs/release-gates.json) carries the claim; docs/release-evidence/ carries
 * the proof; the test suite compares them and fails the build when the claim is
 * larger than the proof. A label can therefore never be raised by editing a
 * sentence — only by adding an evidence file.
 *
 * THE EVIDENCE DIRECTORY DOES NOT SHIP. `docs/release-evidence/*.json` is not
 * in the package allowlist, so an installed CLI cannot recompute the label on a
 * client machine. That is why the manifest records the label as well as the
 * gates: the repository proves it, the package carries it. Anything that reads
 * this at runtime is reading a recorded claim that CI has already checked, and
 * must not present it as a fresh measurement.
 */

/**
 * The one binding between a document and the release it describes.
 *
 * Deliberately visible markdown rather than an HTML comment. The same stamp is
 * used by client-facing paperwork, where a binding a reader cannot see is not a
 * binding at all.
 */
export const RELEASE_STAMP_PATTERN = /^\*\*Applies to release (\d+\.\d+\.\d+)\.\*\*$/m;

/** The release this document binds itself to, or null when it binds to none. */
export function readReleaseStamp(text) {
  const found = RELEASE_STAMP_PATTERN.exec(String(text ?? ""));
  return found ? found[1] : null;
}

/** Render the stamp line, so writers and readers cannot drift on its shape. */
export function releaseStampLine(version) {
  return `**Applies to release ${version}.**`;
}

export const RELEASE_LABELS = Object.freeze(["internal", "preview", "production"]);

/**
 * A gate that is NOT blocking must say why in the manifest.
 *
 * The failure mode this prevents is the one the report named: a gate nobody can
 * satisfy gets quietly waived, and once one gate is waivable the whole manifest
 * reads as advisory. A non-blocking gate is fine — some genuinely cannot be
 * completed by the maintainer — but the reason has to be written down next to
 * it, where the next person reads it, rather than lost in whoever's head made
 * the call.
 */
export function validateGateManifest(manifest) {
  const problems = [];
  const gates = Array.isArray(manifest?.gates) ? manifest.gates : null;
  if (!gates || !gates.length) problems.push("the manifest declares no gates");
  const seen = new Set();
  for (const gate of gates || []) {
    const id = gate?.id;
    if (typeof id !== "string" || !id.trim()) { problems.push("a gate has no id"); continue; }
    if (seen.has(id)) problems.push(`gate ${id} is declared twice`);
    seen.add(id);
    if (typeof gate.title !== "string" || !gate.title.trim()) problems.push(`gate ${id} has no title`);
    if (typeof gate.blocking !== "boolean") problems.push(`gate ${id} does not say whether it blocks`);
    if (typeof gate.evidence !== "string" || !gate.evidence.includes("<version>")) {
      problems.push(`gate ${id} does not name the evidence file that satisfies it`);
    }
    if (gate.blocking === false && (typeof gate.why_not_blocking !== "string" || !gate.why_not_blocking.trim())) {
      problems.push(`gate ${id} is non-blocking and does not say why`);
    }
  }
  const releases = manifest?.releases;
  if (!releases || typeof releases !== "object" || Array.isArray(releases)) {
    problems.push("the manifest records no releases");
  }
  for (const [version, entry] of Object.entries(releases || {})) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`release key ${version} is not a semantic version`);
    if (!RELEASE_LABELS.includes(entry?.evidence_label)) {
      problems.push(`release ${version} records no valid evidence label`);
    }
    if (entry?.published_as !== null && !RELEASE_LABELS.includes(entry?.published_as)) {
      problems.push(`release ${version} records no valid published label`);
    }
    if (entry?.published_as && entry.published_as !== entry.evidence_label &&
        (typeof entry.overclaim_note !== "string" || !entry.overclaim_note.trim())) {
      problems.push(`release ${version} was published as ${entry.published_as} with ${entry.evidence_label} evidence and does not say so`);
    }
    // The met-gate list is recorded as well as the label, because the evidence
    // directory does not ship. Without it an installed CLI could say "preview"
    // and nothing else; with it, it can say which gates are still open. The
    // test recomputes both from the directory, so recording it costs nothing in
    // trust.
    if (!Array.isArray(entry?.gates_met)) {
      problems.push(`release ${version} does not record which gates it met`);
    } else {
      for (const id of entry.gates_met) {
        if (!seen.has(id)) problems.push(`release ${version} names unknown gate ${id}`);
      }
    }
  }
  if (problems.length) throw new Error(`release gate manifest is invalid: ${problems.join("; ")}`);
  return manifest;
}

/** The exact evidence filename a gate needs for one version. */
export function evidenceFilename(gate, version) {
  return String(gate.evidence).replaceAll("<version>", version);
}

/**
 * Which gates this version actually has evidence for.
 *
 * Takes the filename list rather than reading a directory so the caller decides
 * what it is looking at, and so this stays testable without a fixture tree.
 */
export function gatesWithEvidence(gates, version, filenames) {
  const present = new Set(filenames || []);
  const met = [];
  const unmet = [];
  for (const gate of gates) {
    (present.has(evidenceFilename(gate, version)) ? met : unmet).push(gate.id);
  }
  return { met, unmet };
}

/**
 * The label the evidence supports, which is never larger than the evidence.
 *
 *   production  every blocking gate has evidence for this exact version
 *   preview     some evidence exists, but a blocking gate is still open
 *   internal    no gate has evidence for this version at all
 *
 * Non-blocking gates cannot raise the label on their own. A release carrying
 * only non-blocking evidence is still `preview`, because nothing that gates
 * client exposure has been proven.
 */
export function labelFromEvidence(gates, met) {
  const metSet = new Set(met);
  const blocking = gates.filter((gate) => gate.blocking !== false);
  const blockingUnmet = blocking.filter((gate) => !metSet.has(gate.id));
  if (!met.length) return "internal";
  if (blockingUnmet.length) return "preview";
  return "production";
}

/**
 * Compare what a version CLAIMS against what its evidence supports.
 *
 * `agrees` false is the condition CI must fail on. It is deliberately not a
 * warning: the whole defect being fixed here is a claim and a proof that
 * disagreed inside one repository while both were readable.
 */
export function evaluateReleaseState({ version, manifest, evidenceFilenames = [] }) {
  validateGateManifest(manifest);
  const gates = manifest.gates;
  const { met, unmet } = gatesWithEvidence(gates, version, evidenceFilenames);
  const supported = labelFromEvidence(gates, met);
  const recorded = manifest.releases?.[version] || null;
  const blockingUnmet = gates
    .filter((gate) => gate.blocking !== false && !met.includes(gate.id))
    .map((gate) => gate.id);
  const recordedMet = recorded && Array.isArray(recorded.gates_met) ? [...recorded.gates_met].sort() : null;
  const metMatches = recordedMet !== null && recordedMet.join("\u0000") === [...met].sort().join("\u0000");
  return {
    version,
    recorded: recorded ? recorded.evidence_label : null,
    published_as: recorded ? recorded.published_as : null,
    supported,
    met,
    unmet,
    blocking_unmet: blockingUnmet,
    recorded_at_all: Boolean(recorded),
    met_matches: metMatches,
    agrees: Boolean(recorded) && recorded.evidence_label === supported && metMatches,
  };
}

/**
 * What the PACKAGE can say about itself, with no evidence directory to read.
 *
 * Deliberately separate from evaluateReleaseState. Handing that function an
 * empty file list on a client machine would compute "internal" for every
 * release and call it a measurement, which is exactly the shape of dishonesty
 * this module exists to remove. This one only ever repeats a recorded claim.
 */
export function recordedReleaseState(manifest, version) {
  validateGateManifest(manifest);
  const recorded = manifest.releases?.[version] || null;
  const met = new Set(recorded?.gates_met || []);
  return {
    version,
    recorded: recorded ? recorded.evidence_label : null,
    published_as: recorded ? recorded.published_as : null,
    recorded_at_all: Boolean(recorded),
    blocking_unmet: manifest.gates
      .filter((gate) => gate.blocking !== false && !met.has(gate.id))
      .map((gate) => gate.id),
  };
}

/**
 * The line a person reads.
 *
 * Returns null for a production release: a release that has met its gates does
 * not need to announce it, and a banner on every run is a banner nobody reads.
 * Anything less than production says so plainly, names the count, and does not
 * dress it up — the operator deciding whether to put a client on this build is
 * the reader.
 */
export function releaseStateBanner(state) {
  if (!state) return null;
  if (!state.recorded_at_all) {
    return `release ${state.version} is not recorded in the release gate manifest, so nothing here can say which gates it met.`;
  }
  if (state.recorded === "production") return null;
  const open = state.blocking_unmet.length;
  return `release ${state.version} is labelled ${state.recorded}: ` +
    `${open} release gate(s) have no recorded evidence for this exact version. ` +
    "Ask the operator before putting new client material on it.";
}
