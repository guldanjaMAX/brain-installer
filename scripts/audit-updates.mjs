import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function validateIncidents(cases, exists = (p) => existsSync(resolve(root, p))) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("incident registry is missing or empty");
  const ids = new Set();
  for (const item of cases) {
    if (!/^UPDATE-\d{3}$/.test(item.id) || ids.has(item.id)) throw new Error("invalid or duplicate incident ID");
    ids.add(item.id);
    if (!["open", "local-only", "verified"].includes(item.status)) throw new Error(`${item.id}: invalid status`);
    if (!item.title || !item.acceptance || !Array.isArray(item.scopes) || !item.scopes.length ||
        item.scopes.some((s) => !["fresh", "upgrade", "recovery"].includes(s))) throw new Error(`${item.id}: missing scope or acceptance`);
    if (!Array.isArray(item.tests) || !item.tests.length) throw new Error(`${item.id}: no regression command`);
    if (item.testPlatform && !["win32", "darwin", "linux"].includes(item.testPlatform)) throw new Error(`${item.id}: invalid test platform`);
    for (const path of [...item.tests, ...(item.reproductions ?? []), ...(item.evidence ?? [])]) {
      if (!/^(test|worker\/test|scripts|docs)\/[\w/.-]+$/.test(path) || path.split("/").includes("..") || !exists(path)) {
        throw new Error(`${item.id}: missing or unsafe evidence/test path`);
      }
    }
    if (item.status === "verified" && !item.evidence?.length) throw new Error(`${item.id}: verified requires reviewed evidence`);
  }
  return cases;
}

export function releaseBlockers(cases) {
  return cases.filter((item) => item.status !== "verified");
}

// Run independently: a failed auth test must not prevent the recovery tests
// from running. No shell, no output pipes, no inherited success from a later
// command. A signal, timeout, or spawn error is a failure too.
export function runRegressions(cases, run = (path) => spawnSync(process.execPath,
  ["--no-warnings", path], { cwd: root, stdio: "inherit", timeout: 300_000 }), platform = process.platform) {
  const results = [];
  for (const path of new Set(cases.flatMap((item) => item.tests))) {
    const runnable = cases.some((item) => item.tests.includes(path) && (!item.testPlatform || item.testPlatform === platform));
    if (!runnable) {
      results.push({ path, passed: null, skipped: true });
      console.log(`SKIP audit regression: ${path} requires another host platform`);
      continue;
    }
    const result = run(path);
    results.push({ path, passed: result.status === 0 && !result.error && !result.signal });
    console.log(`${results.at(-1).passed ? "PASS" : "FAIL"} audit regression: ${path}`);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? "--release";
    if (!["--release", "--regressions", "--check"].includes(mode) || process.argv.length > 3) throw new Error("usage: audit-updates.mjs [--release|--regressions|--check]");
    const cases = validateIncidents(JSON.parse(readFileSync(resolve(root, "docs/update-incidents.json"), "utf8")));
    const results = mode === "--regressions" ? runRegressions(cases) : [];
    const blockers = releaseBlockers(cases);
    for (const item of blockers) console.log(`HELD ${item.id} [${item.scopes.join(",")}]: ${item.title} (${item.status})`);
    console.log(`Incident audit: ${cases.length} tracked; ${blockers.length} awaiting closure. Local tests are not field recovery proof.`);
    process.exitCode = results.some((r) => r.passed === false) || (mode === "--release" && blockers.length) ? 1 : 0;
  } catch (error) {
    console.error(`Incident audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
