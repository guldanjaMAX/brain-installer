/**
 * Every tracked test file is actually in the npm test lifecycle.
 *
 * WHY THIS EXISTS. `npm test` is a hardcoded `&&` chain of ~116 commands, not a
 * discovery run. That is a deliberate choice (explicit ordering, explicit
 * per-file node flags), and it has one failure mode that is worse than anything
 * it buys: a test file that exists, is committed, and is NOT in the chain is
 * invisible. It can fail for weeks and every run stays green.
 *
 * That is not hypothetical. `test/report-html.test.mjs` was tracked, was
 * failing, and was missing from the chain. It was found only because an agent
 * happened to run it directly. Nothing in the suite could have surfaced it,
 * because the suite did not know it existed.
 *
 * So this file asserts the one property the chain cannot assert about itself:
 * that it is complete. A new test file now either joins the chain or turns this
 * red on the next run.
 *
 * If you are here because this failed: the fix is to add the named file to
 * `scripts.test` in package.json, in a position that matches what it depends
 * on. Do NOT add it to the ignore list below to make this pass — that is the
 * same defect this file exists to end, with an extra step.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Files that are deliberately not in the chain, each with the reason it is
 * exempt. An entry here is a claim that the file is not a test of this package.
 * There are none today; the list exists so a legitimate exemption has somewhere
 * to go WITH its justification, rather than being silently dropped.
 */
const EXEMPT = new Map([
  // ["test/example.test.mjs", "why this is not run by npm test"],
]);

let fail = 0;
let ran = 0;
const check = (name, ok, detail = "") => {
  ran++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + detail));
  if (!ok) fail++;
};

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts || {};
const chain = `${scripts.pretest || ""} ${scripts.test || ""}`;
check("package.json defines a test lifecycle", Boolean(scripts.test) && chain.length > 0);

// Tracked, not on disk: a file someone deleted but left in the chain is a
// different bug, and the chain itself will fail loudly on that, so it needs no
// check here.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => /(^|\/)(test|worker\/test)\/[^/]*\.test\.mjs$/.test(f));

check("git listed the tracked test files", tracked.length > 0, `found ${tracked.length}`);

// Matched on the full repo-relative path where the chain uses one, falling back
// to the basename, because the chain writes some entries as bare filenames and
// some with their directory. Basename alone would let `test/x.test.mjs` be
// satisfied by an unrelated `worker/test/x.test.mjs`.
const missing = tracked.filter((f) => {
  if (EXEMPT.has(f)) return false;
  const base = f.split("/").pop();
  return !chain.includes(f) && !chain.includes(base);
});

check(
  "every tracked test file is in the npm test chain",
  missing.length === 0,
  missing.length
    ? `${missing.length} orphaned and therefore never run: ${missing.join(", ")}`
    : "",
);

// The inverse, which catches the other way this drifts: an exemption for a file
// that no longer exists is stale bookkeeping and hides the next real one.
const staleExemptions = [...EXEMPT.keys()].filter((f) => !tracked.includes(f));
check(
  "no exemption names a file that is not tracked",
  staleExemptions.length === 0,
  staleExemptions.join(", "),
);

console.log(
  fail
    ? `\n${fail} FAILURE(S)`
    : `\ntest chain complete: all ${tracked.length} tracked test files are in the chain` +
      (EXEMPT.size ? ` (${EXEMPT.size} exempt)` : ""),
);
process.exit(fail ? 1 : 0);
