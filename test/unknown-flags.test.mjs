// A flag the command does not know must exit nonzero.
//
// The bug this exists to prevent already happened, in the field, on the only
// live install. `brain doctor <manifest> --repair-checksum` was run against
// v0.1.19, which does not contain that flag. parseFlags turned it into a key
// nobody read, doctor ran its ordinary preflight, and the process exited 0.
// The operator's reasonable conclusion was that the repair had run and found
// nothing wrong. Nothing had run. The install stayed stranded for another day.
//
// A silently ignored flag and a flag that worked and had nothing to do are
// indistinguishable from the outside. On a recovery command that difference is
// the whole message, so `brain doctor` now validates its own options.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { assertKnownFlags } from "../brain.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "brain.mjs");

function runDoctor(...args) {
  return spawnSync(process.execPath, [CLI, "doctor", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("the exact field failure: an unknown doctor flag exits nonzero", () => {
  const result = runDoctor("--repair-checksums");
  assert.notEqual(result.status, 0, "an unrecognised flag must not exit 0");
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /unknown option --repair-checksums/, "must name the offending flag");
});

test("a near-miss gets a suggestion rather than a shrug", () => {
  const output = (() => {
    const r = runDoctor("--repair-checksums");
    return `${r.stdout}${r.stderr}`;
  })();
  assert.match(output, /Did you mean --repair-checksum\?/);
});

test("the error lists what the command does accept", () => {
  const r = runDoctor("--totally-made-up");
  const output = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0);
  for (const flag of ["--repair", "--rollback", "--repair-checksum", "--yes"]) {
    assert.ok(output.includes(flag), `error must list ${flag}`);
  }
});

test("assertKnownFlags accepts every flag doctor really reads", () => {
  const known = ["repair", "rollback", "repair-checksum", "yes"];
  assert.doesNotThrow(() => {
    assertKnownFlags({ repair: true, yes: true }, known, "brain doctor");
  });
  assert.doesNotThrow(() => {
    assertKnownFlags({ "repair-checksum": true, yes: true }, known, "brain doctor");
  });
  assert.doesNotThrow(() => assertKnownFlags({}, known, "brain doctor"));
});

test("assertKnownFlags reports every unknown flag, not only the first", () => {
  assert.throws(
    () => assertKnownFlags({ alpha: true, beta: true }, ["repair"], "brain doctor"),
    (error) => {
      assert.match(error.message, /--alpha/, "must name the first unknown flag");
      assert.match(error.message, /--beta/, "must name the second unknown flag too");
      return true;
    },
    "an unknown flag must abort rather than return",
  );
});
