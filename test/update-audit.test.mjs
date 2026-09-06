import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateIncidents, releaseBlockers, runRegressions } from "../scripts/audit-updates.mjs";

const cases = JSON.parse(readFileSync(new URL("../docs/update-incidents.json", import.meta.url), "utf8"));
validateIncidents(cases);
assert.ok(cases.some((c) => c.id === "UPDATE-002"), "the frozen-fence incident must not disappear from the registry");
const findings = new Set(cases.flatMap((c) => c.findings));
for (const id of [...Array.from({ length: 16 }, (_, i) => `F${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `N${i + 1}`)]) {
  assert.ok(findings.has(id), `original audit finding ${id} must retain an adjudication`);
}
const fixture = { id: "UPDATE-999", title: "fixture", acceptance: "fixture proof", scopes: ["upgrade"], status: "open", tests: ["test/fixture.mjs"] };
assert.throws(() => validateIncidents([], () => true), /empty/);
assert.throws(() => validateIncidents([fixture, fixture], () => true), /duplicate/);
assert.throws(() => validateIncidents([{ ...fixture, status: "verified" }], () => true), /evidence/);
assert.throws(() => validateIncidents([{ ...fixture, tests: ["test/../../private.mjs"] }], () => true), /unsafe/);
assert.throws(() => validateIncidents([fixture], () => false), /missing/);
assert.equal(releaseBlockers([{ ...fixture, status: "local-only" }]).length, 1);
assert.equal(releaseBlockers([{ ...fixture, status: "verified", evidence: ["docs/fixture.md"] }]).length, 0);
const calls = [];
const results = runRegressions([{ tests: ["test/first.mjs", "test/second.mjs", "test/first.mjs"] }], (path) => {
  calls.push(path);
  return { status: path.includes("first") ? 1 : 0 };
});
assert.equal(calls.length, 2, "failure must not skip the next independent test; shared tests run once");
assert.deepEqual(results.map((r) => r.passed), [false, true]);
assert.equal(runRegressions([{ tests: ["test/fixture.mjs"] }], () => ({ status: null, signal: "SIGTERM" }))[0].passed, false);
assert.equal(runRegressions([{ tests: ["test/fixture.mjs"], testPlatform: "win32" }], () => { throw new Error("must not run on this host"); }, "darwin")[0].skipped, true);

const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.ok(release.indexOf("node scripts/audit-updates.mjs --release") < release.indexOf("- name: require immutable releases"));
assert.match(release, /run: node scripts\/audit-updates\.mjs --release/);
console.log("update audit: incomplete evidence blocks release, all regression commands retain their own exit status");
