/**
 * Whether the paperwork a client is entitled to see actually exists, and
 * whether it describes the code that is about to read their material.
 *
 * WHY THIS EXISTS
 *
 * The next install reads a household's complete financial archive — documents,
 * mail, bank records, message history — through a chain of storage and model
 * providers. Across the current release range this repository contained no
 * client terms, no privacy notice, no data-processing terms, no named
 * subprocessor list and no retention or deletion policy. Not stale ones: none.
 *
 * This module does not fix that. Nobody writes those in code and nothing here
 * is legal advice or a claim of legal sufficiency; a founder and a lawyer
 * supply the text. What this fixes is the part that IS an engineering problem:
 * a document sitting in somebody's folder is not bound to anything, and a
 * client who is shown one has no way to know whether it describes the version
 * that will read their archive. A statement written against one release can be
 * made false by the next release adding a single provider.
 *
 * So: the register below names what must exist, each artifact binds itself to a
 * release with the same visible stamp the maintainer docs use, and the
 * pre-install report says out loud which ones are missing, which are unstamped,
 * and which are stamped to a release that is no longer the one running.
 *
 * WHAT THIS CANNOT SEE. It reads files inside the installed package. If an
 * operator holds signed paperwork somewhere else entirely, this module has no
 * way to know, and it must never report that absence as an established fact
 * about the engagement. Every caller says "not in this install", not "you have
 * none".
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseStamp } from "./release-state.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_REGISTER_PATH = join(PACKAGE_ROOT, "legal", "register.json");

/** Every state one artifact can be in, worst first. */
export const ARTIFACT_STATES = Object.freeze([
  "missing",      // the file named by the register is not in the package
  "unstamped",    // the file exists and binds itself to no release
  "stale",        // stamped, but to a release other than the one running
  "unapproved",   // present and current, but nobody has recorded an approval
  "ready",        // present, stamped to this release, approved
]);

export const APPROVAL_STATES = Object.freeze(["missing", "draft", "approved"]);

/**
 * A required artifact that does NOT block an install must say why in writing.
 *
 * Same rule as the release gate manifest, for the same reason: an unexplained
 * exemption is indistinguishable from an oversight, and the next person to read
 * it cannot tell whether a decision was made or simply never taken.
 */
export function validateLegalRegister(register) {
  const problems = [];
  const artifacts = Array.isArray(register?.artifacts) ? register.artifacts : null;
  if (!artifacts || !artifacts.length) problems.push("the register names no artifacts");
  const seen = new Set();
  for (const artifact of artifacts || []) {
    const id = artifact?.id;
    if (typeof id !== "string" || !id.trim()) { problems.push("an artifact has no id"); continue; }
    if (seen.has(id)) problems.push(`artifact ${id} is declared twice`);
    seen.add(id);
    if (typeof artifact.title !== "string" || !artifact.title.trim()) problems.push(`artifact ${id} has no title`);
    if (typeof artifact.file !== "string" || !artifact.file.trim()) problems.push(`artifact ${id} names no file`);
    if (!APPROVAL_STATES.includes(artifact.approval)) problems.push(`artifact ${id} has no valid approval state`);
    if (typeof artifact.supplied_by !== "string" || !artifact.supplied_by.trim()) {
      problems.push(`artifact ${id} does not say who must supply it`);
    }
    if (typeof artifact.what_a_human_must_supply !== "string" || artifact.what_a_human_must_supply.trim().length < 20) {
      problems.push(`artifact ${id} does not say what a human must actually write`);
    }
    if (typeof artifact.blocks_install !== "boolean") problems.push(`artifact ${id} does not say whether it blocks an install`);
    if (artifact.blocks_install === false &&
        (typeof artifact.why_not_blocking !== "string" || !artifact.why_not_blocking.trim())) {
      problems.push(`artifact ${id} does not block an install and does not say why`);
    }
    // A file that is not on disk cannot have been approved. Allowing that
    // combination is how a register ends up asserting an approval nobody can
    // open.
    if (artifact.approval === "approved" && artifact.file_present_required === false) {
      problems.push(`artifact ${id} is recorded approved with no file requirement`);
    }
  }
  if (problems.length) throw new Error(`legal register is invalid: ${problems.join("; ")}`);
  return register;
}

export function loadLegalRegister(path = DEFAULT_REGISTER_PATH) {
  return validateLegalRegister(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * The state of one artifact, established by reading the file rather than by
 * trusting what the register says about it.
 *
 * The register records an approval, because no file can record its own; every
 * other field here is measured. In particular an artifact whose approval says
 * "approved" but whose stamp names an older release comes back `stale`, not
 * `ready` — an approval is approval of a text describing a version, and the
 * version moved.
 */
export function evaluateArtifact(artifact, version, options = {}) {
  const root = options.root ?? PACKAGE_ROOT;
  const readFile = options.readFile ?? ((path) => (existsSync(path) ? readFileSync(path, "utf8") : null));
  const text = readFile(join(root, artifact.file));
  if (text === null) {
    return { id: artifact.id, state: "missing", stamped: null, blocks: artifact.blocks_install === true };
  }
  const stamped = readReleaseStamp(text);
  const blocks = artifact.blocks_install === true;
  if (!stamped) return { id: artifact.id, state: "unstamped", stamped: null, blocks };
  if (stamped !== version) return { id: artifact.id, state: "stale", stamped, blocks };
  if (artifact.approval !== "approved") return { id: artifact.id, state: "unapproved", stamped, blocks };
  return { id: artifact.id, state: "ready", stamped, blocks };
}

/**
 * The whole register, evaluated.
 *
 * `ready` is deliberately the only state that counts as satisfied. There is no
 * partial credit here: a privacy notice that exists but describes a release
 * two versions back is not "mostly fine", it is a document that can be wrong
 * about which companies received the client's material.
 */
export function evaluateLegalRegister({ register, version, root, readFile } = {}) {
  validateLegalRegister(register);
  const artifacts = register.artifacts.map((artifact) =>
    evaluateArtifact(artifact, version, { root, readFile }));
  const notReady = artifacts.filter((a) => a.state !== "ready");
  return {
    version,
    artifacts,
    total: artifacts.length,
    ready: artifacts.filter((a) => a.state === "ready").map((a) => a.id),
    missing: artifacts.filter((a) => a.state === "missing").map((a) => a.id),
    stale: artifacts.filter((a) => a.state === "stale").map((a) => a.id),
    unstamped: artifacts.filter((a) => a.state === "unstamped").map((a) => a.id),
    unapproved: artifacts.filter((a) => a.state === "unapproved").map((a) => a.id),
    not_ready: notReady.map((a) => a.id),
    blocking_not_ready: notReady.filter((a) => a.blocks).map((a) => a.id),
    satisfied: notReady.length === 0,
  };
}

/**
 * What a human still has to supply, in the words the register carries.
 *
 * Rendered from the register rather than written here, because the person who
 * has to act on it is a founder or a lawyer and the wording of what they owe is
 * theirs, not this module's.
 */
export function outstandingWork(register, state) {
  const byId = new Map(register.artifacts.map((artifact) => [artifact.id, artifact]));
  return state.not_ready.map((id) => {
    const artifact = byId.get(id);
    const found = state.artifacts.find((a) => a.id === id);
    return {
      id,
      title: artifact.title,
      state: found.state,
      supplied_by: artifact.supplied_by,
      needs: artifact.what_a_human_must_supply,
      stamped: found.stamped,
      blocks_install: artifact.blocks_install === true,
    };
  });
}
