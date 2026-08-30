import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const gate = readFileSync(new URL("../scripts/windows-dpapi-release-gate.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const bridgePath = new URL("../operations/windows-dpapi-bridge.mjs", import.meta.url);
const bridge = readFileSync(bridgePath, "utf8");
const session = readFileSync(new URL("../operations/windows-dpapi-session.mjs", import.meta.url), "utf8");

test("the Windows release gate uses the production probe for exactly 25 fresh rounds", () => {
  assert.match(gate, /import \{ probeWindowsDpapi \} from "\.\.\/operations\/admin-key-file\.mjs"/);
  assert.match(gate, /const REQUIRED_ROUNDS = 25/);
  assert.match(gate, /probeWindowsDpapi\(\{ rounds: REQUIRED_ROUNDS \}\)/);
  assert.doesNotMatch(gate, /randomBytes:|runPowerShell:|dpapiProbe:/);
  assert.match(gate, /result\.checked === true/);
  assert.match(gate, /result\.passed === true/);
  assert.match(gate, /result\.rounds === REQUIRED_ROUNDS/);
  assert.match(gate, /result\.cleanup_status === "clean"/);
  assert.match(session, /let activeSession = null/);
  assert.match(session, /if \(activeSession\?\.public\) return activeSession\.public/);
  assert.match(session, /process\.once\("exit", \(\) => \{ disposeWindowsDpapiSession\(\); \}\)/);
  assert.match(bridge, /--helper|"helper"/);
  assert.match(bridge, /sha256/);
  assert.doesNotMatch(bridge, /csc\.exe|mkdtempSync|--source/);
  assert.ok(
    bridge.indexOf('staged("helper_validation"') < bridge.indexOf('staged("input"'),
    "helper identity and hash validation must occur before stdin is read",
  );
});

test("the bridge refuses a changed, hard-linked, or symlinked helper before reading input", () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "brain-dpapi-bridge-contract-")));
  try {
    const run = (helper, sha256) => spawnSync(process.execPath, [
      bridgePath.pathname,
      "--helper", helper,
      "--sha256", sha256,
      "--operation", "protect",
      "--length", "4",
      "--max", "65536",
    ], {
      encoding: "utf8",
      input: Buffer.from([1, 2, 3, 4]),
      env: { SystemRoot: "/fixture/windows", USERNAME: "fixture-user" },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    const helper = join(sandbox, "windows-dpapi-helper.exe");
    writeFileSync(helper, "original helper bytes", "utf8");
    const originalHash = createHash("sha256").update(readFileSync(helper)).digest("hex");
    writeFileSync(helper, "swapped helper bytes", "utf8");
    const swapped = run(helper, originalHash);
    assert.notEqual(swapped.status, 0);
    assert.match(swapped.stderr, /BRAIN_DPAPI_STAGE:helper_validation/);

    const hardlink = join(sandbox, "helper-copy.exe");
    linkSync(helper, hardlink);
    const currentHash = createHash("sha256").update(readFileSync(helper)).digest("hex");
    const linked = run(helper, currentHash);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /BRAIN_DPAPI_STAGE:helper_validation/);

    rmSync(hardlink);
    const target = join(sandbox, "real-helper.exe");
    writeFileSync(target, "symlink target bytes", "utf8");
    rmSync(helper);
    symlinkSync(target, helper, "file");
    const symlinked = run(helper, createHash("sha256").update(readFileSync(target)).digest("hex"));
    assert.notEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /BRAIN_DPAPI_STAGE:helper_validation/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CI invokes the release gate only on a real Windows runner", () => {
  assert.match(workflow, /node: \['22', '24'\]/);
  assert.match(workflow, /name: Windows DPAPI 25-round release gate/);
  assert.match(workflow, /if: runner\.os == 'Windows'/);
  assert.match(workflow, /run: node scripts\/windows-dpapi-release-gate\.mjs/);
});

test("the gate output is restricted to stable diagnostic fields", () => {
  assert.match(gate, /issue_code=/);
  assert.match(gate, /rounds_completed=/);
  assert.doesNotMatch(gate, /JSON\.stringify|stdout|stderr|ciphertext|plaintext/);
});
