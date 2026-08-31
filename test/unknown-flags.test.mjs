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

function runSetup(...args) {
  return spawnSync(process.execPath, [CLI, "setup", ...args], {
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

test("an inline Cloudflare token is rejected without reproducing its value", () => {
  const fixture = "fixture-inline-secret-that-must-not-appear";
  const result = runSetup(`--cloudflare-token=${fixture}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /recovery-only hidden prompt/);
  assert.doesNotMatch(output, /fixture-inline-secret/);
  assert.doesNotMatch(output, /cloudflare-token=/);
});

test("mixed-case inline Cloudflare token flags are also rejected without disclosure", () => {
  const fixture = "fixture-mixed-case-secret-that-must-not-appear";
  const result = runSetup(`--ClOuDfLaRe-ToKeN=${fixture}`);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /recovery-only hidden prompt/);
  assert.doesNotMatch(output, /fixture-mixed-case-secret/);
  assert.doesNotMatch(output, /ClOuDfLaRe-ToKeN=/);
});

test("a mistyped inline recovery flag never repeats its value", () => {
  const fixture = "fixture-typo-secret-that-must-not-appear";
  const result = runSetup(`--cloudflare-toke=${fixture}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /unknown option --cloudflare-toke/i);
  assert.match(output, /Did you mean --cloudflare-token/i);
  assert.doesNotMatch(output, /fixture-typo-secret/i);
  assert.doesNotMatch(output, /cloudflare-toke=/i);
});

test("an extra dash on an inline recovery flag never repeats its value", () => {
  const fixture = "fixture-extra-dash-secret-that-must-not-appear";
  const result = runSetup(`---cloudflare-token=${fixture}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /unknown option ---cloudflare-token/i);
  assert.doesNotMatch(output, /fixture-extra-dash-secret/i);
  assert.doesNotMatch(output, /cloudflare-token=/i);
});
