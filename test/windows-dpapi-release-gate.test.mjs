import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const gate = readFileSync(new URL("../scripts/windows-dpapi-release-gate.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("the Windows release gate uses the production probe for exactly 25 fresh rounds", () => {
  assert.match(gate, /import \{ probeWindowsDpapi \} from "\.\.\/operations\/admin-key-file\.mjs"/);
  assert.match(gate, /const REQUIRED_ROUNDS = 25/);
  assert.match(gate, /probeWindowsDpapi\(\{ rounds: REQUIRED_ROUNDS \}\)/);
  assert.doesNotMatch(gate, /randomBytes:|runPowerShell:|dpapiProbe:/);
  assert.match(gate, /result\.checked === true/);
  assert.match(gate, /result\.passed === true/);
  assert.match(gate, /result\.rounds === REQUIRED_ROUNDS/);
});

test("CI invokes the release gate only on a real Windows runner", () => {
  assert.match(workflow, /name: Windows DPAPI 25-round release gate/);
  assert.match(workflow, /if: runner\.os == 'Windows'/);
  assert.match(workflow, /run: node scripts\/windows-dpapi-release-gate\.mjs/);
});

test("the gate output is restricted to stable diagnostic fields", () => {
  assert.match(gate, /issue_code=/);
  assert.match(gate, /rounds_completed=/);
  assert.doesNotMatch(gate, /JSON\.stringify|stdout|stderr|ciphertext|plaintext/);
});
