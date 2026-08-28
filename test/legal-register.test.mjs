/**
 * A client is shown paperwork bound to the release that reads their archive,
 * or the tool says plainly that they are not.
 *
 * WHAT THESE TESTS ARE DEFENDING
 *
 * Measured on 2026-08-28: this repository contained no client terms, no privacy
 * notice, no data-processing terms, no named subprocessor list and no retention
 * or deletion policy. Not stale ones — none. The next install reads a
 * household's complete financial archive through storage and model providers,
 * and nothing in the product mentioned any of that to anyone.
 *
 * Writing those documents is a founder's job and a lawyer's, and nothing here
 * attempts it. The engineering half is the binding: a statement written against
 * one release can be made false by the next release adding a company, so a
 * document with no version on it gives a client no way to know whether it
 * describes the code about to read their material.
 *
 * Each test names a way this could quietly report better than the truth:
 *   - an artifact that does not exist reported as present
 *   - an artifact stamped to an older release reported as current
 *   - an approval recorded for a text that has since gone stale
 *   - an absence outside the package asserted as an absence in the engagement
 *   - a register that cannot be read rendering as a clean report
 *
 * Every fixture name here is invented. This repository is public.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_STATES,
  ARTIFACT_STATES,
  evaluateArtifact,
  evaluateLegalRegister,
  loadLegalRegister,
  outstandingWork,
  validateLegalRegister,
} from "../operations/legal-register.mjs";
import {
  CANNOT_CHECK, FAIL, OK, WARN,
  assertHonest, checkClientPaperwork, preinstallExitCode, runPreinstall,
} from "../doctor.mjs";
import { releaseStampLine } from "../operations/release-state.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 400)));
  if (!c) fail++;
};
const throws = (fn) => { try { fn(); return null; } catch (error) { return String(error.message || error); } };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const shipped = loadLegalRegister();

/** One artifact, one sandbox, so a file fixture is a real file on disk. */
const withArtifact = (contents, artifact, version = packageVersion) => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-legal-"));
  try {
    if (contents !== null) {
      mkdirSync(join(sandbox, "legal"), { recursive: true });
      writeFileSync(join(sandbox, artifact.file), contents);
    }
    return evaluateArtifact(artifact, version, { root: sandbox });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
};

/* ================================================================ */
/* 1. The shipped register is well formed and honest about today.   */
/* ================================================================ */
{
  check("the shipped register validates", throws(() => validateLegalRegister(shipped)) === null,
    throws(() => validateLegalRegister(shipped)));
  check("it names the five artifacts the report asked for",
    shipped.artifacts.length === 5, String(shipped.artifacts.length));
  check("every artifact says who must supply it and what they must write",
    shipped.artifacts.every((a) => a.supplied_by.trim() && a.what_a_human_must_supply.trim().length > 20));
  check("every non-blocking artifact says why it does not block",
    shipped.artifacts.filter((a) => a.blocks_install === false)
      .every((a) => String(a.why_not_blocking || "").trim().length > 40));

  const state = evaluateLegalRegister({ register: shipped, version: packageVersion });
  check("and today none of them is ready, which is the honest current state",
    state.satisfied === false && state.missing.length === 5 && state.ready.length === 0,
    JSON.stringify(state.missing));

  const missingReason = structuredClone(shipped);
  missingReason.artifacts[0].why_not_blocking = "";
  check("an artifact that does not block and does not say why is refused",
    /does not block an install and does not say why/.test(throws(() => validateLegalRegister(missingReason)) || ""),
    throws(() => validateLegalRegister(missingReason)));

  const silentNeed = structuredClone(shipped);
  silentNeed.artifacts[1].what_a_human_must_supply = "TBD";
  check("and one that does not say what a human must write is refused too",
    /does not say what a human must actually write/.test(throws(() => validateLegalRegister(silentNeed)) || ""),
    throws(() => validateLegalRegister(silentNeed)));
}

/* ================================================================ */
/* 2. The state of an artifact is MEASURED from the file.            */
/* ================================================================ */
{
  const artifact = { ...shipped.artifacts[3], approval: "approved" };

  check("an absent file is missing",
    withArtifact(null, artifact).state === "missing");
  check("a file with no stamp is unstamped, not ready",
    withArtifact("# terms\n\nno binding here\n", artifact).state === "unstamped");
  check("a file stamped to another release is stale even when the register says approved",
    withArtifact(`# terms\n\n${releaseStampLine("0.1.16")}\n`, artifact).state === "stale",
    JSON.stringify(withArtifact(`# terms\n\n${releaseStampLine("0.1.16")}\n`, artifact)));
  check("and the stale result reports which release it was actually bound to",
    withArtifact(`# terms\n\n${releaseStampLine("0.1.16")}\n`, artifact).stamped === "0.1.16");
  check("a correctly stamped file whose approval is only a draft is unapproved, not ready",
    withArtifact(`# terms\n\n${releaseStampLine(packageVersion)}\n`, { ...artifact, approval: "draft" }).state
      === "unapproved");
  check("only a present, correctly stamped, approved file is ready",
    withArtifact(`# terms\n\n${releaseStampLine(packageVersion)}\n`, artifact).state === "ready");
  check("every state the module can return is a declared state",
    ["missing", "unstamped", "stale", "unapproved", "ready"].every((s) => ARTIFACT_STATES.includes(s)) &&
      APPROVAL_STATES.length === 3);
}

/* ================================================================ */
/* 3. A fully satisfied register is reachable, or the gate is        */
/*    decorative.                                                    */
/* ================================================================ */
{
  const sandbox = mkdtempSync(join(tmpdir(), "brain-legal-all-"));
  try {
    mkdirSync(join(sandbox, "legal"), { recursive: true });
    const register = structuredClone(shipped);
    for (const artifact of register.artifacts) {
      artifact.approval = "approved";
      writeFileSync(join(sandbox, artifact.file), `# ${artifact.title}\n\n${releaseStampLine(packageVersion)}\n`);
    }
    const state = evaluateLegalRegister({ register, version: packageVersion, root: sandbox });
    check("with every file present, stamped and approved the register is satisfied",
      state.satisfied === true && state.ready.length === 5, JSON.stringify(state.not_ready));

    // The whole point of the binding: bumping the release must un-satisfy it.
    const next = evaluateLegalRegister({ register, version: "0.1.23", root: sandbox });
    check("and the next release makes every one of them stale again",
      next.satisfied === false && next.stale.length === 5, JSON.stringify(next));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ================================================================ */
/* 4. What a human is told they still owe.                           */
/* ================================================================ */
{
  const state = evaluateLegalRegister({ register: shipped, version: packageVersion });
  const work = outstandingWork(shipped, state);
  check("outstanding work is listed for every artifact that is not ready", work.length === 5);
  check("and each item names who supplies it and what they must write",
    work.every((item) => item.supplied_by.trim() && item.needs.length > 20 && item.title.trim()),
    JSON.stringify(work.map((w) => w.id)));
}

/* ================================================================ */
/* 5. The pre-install surface, executed.                             */
/* ================================================================ */
{
  const asShipped = checkClientPaperwork();
  check("the pre-install check runs and does not report OK while nothing exists",
    asShipped.status === WARN && asShipped.name === "Client paperwork", JSON.stringify(asShipped.detail));
  check("it says what is not ready and for which release",
    /5 of 5 not ready for /.test(asShipped.detail), asShipped.detail);
  check("it says the absence is about this install, not about the engagement",
    /not in this install/.test(asShipped.fix) && /nothing here can see it/.test(asShipped.fix), asShipped.fix);
  check("it disclaims legal sufficiency rather than implying it",
    /None of this is legal advice/.test(asShipped.fix), asShipped.fix);

  // The severity really is the register's boolean, not a constant.
  const blocking = structuredClone(shipped);
  blocking.artifacts[0].blocks_install = true;
  delete blocking.artifacts[0].why_not_blocking;
  const blocked = checkClientPaperwork({ register: blocking, version: packageVersion });
  check("flipping blocks_install turns the same finding into a blocker",
    blocked.status === FAIL, JSON.stringify(blocked.detail));
  check("and a blocker makes the pre-install exit code non-zero",
    preinstallExitCode([{ name: "x", status: OK, detail: "" }, blocked]) === 1);

  // Satisfied case: it must be able to go green, or nobody will believe it.
  const sandbox = mkdtempSync(join(tmpdir(), "brain-legal-green-"));
  try {
    mkdirSync(join(sandbox, "legal"), { recursive: true });
    const register = structuredClone(shipped);
    for (const artifact of register.artifacts) {
      artifact.approval = "approved";
      writeFileSync(join(sandbox, artifact.file), `# ${artifact.title}\n\n${releaseStampLine(packageVersion)}\n`);
    }
    const green = checkClientPaperwork({ register, version: packageVersion, root: sandbox });
    check("a fully stamped and approved set passes", green.status === OK, JSON.stringify(green));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  const unreadable = checkClientPaperwork({ registerPath: join(tmpdir(), "no-such-register-file.json") });
  check("an unreadable register is CANNOT CHECK, never OK",
    unreadable.status === CANNOT_CHECK, JSON.stringify(unreadable));
  check("and it names the manual step, so assertHonest accepts it",
    throws(() => assertHonest([unreadable])) === null, throws(() => assertHonest([unreadable])));

  const invalid = checkClientPaperwork({ register: { schema_version: 1, artifacts: [] }, version: packageVersion });
  check("a register that does not validate is also CANNOT CHECK", invalid.status === CANNOT_CHECK,
    JSON.stringify(invalid));
}

/* ================================================================ */
/* 6. It is actually wired into the report an operator runs.         */
/* ================================================================ */
{
  const checks = await runPreinstall({
    environment: {},
    includeWrangler: false,
    networkCheck: async () => ({ name: "Network", status: OK, detail: "fixture: reached the API" }),
    toolChecks: [],
    googleStorageStatus: { exists: true, description: "fixture secure storage" },
    cloudflareToken: undefined,
    osPlatform: "darwin",
  });
  const paperwork = checks.find((x) => x.name === "Client paperwork");
  check("the pre-install report includes the paperwork line", Boolean(paperwork),
    JSON.stringify(checks.map((x) => x.name)));
  check("and it is not reported as passing", paperwork?.status !== OK, JSON.stringify(paperwork));
  check("the whole report still satisfies the honesty rule", throws(() => assertHonest(checks)) === null);
}

console.log(`\n${ran - fail}/${ran} legal-register checks passed`);
if (fail) process.exit(1);
