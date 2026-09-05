// A first install has no manifest. Setup must reach its own first-install
// handling rather than refusing to read a file that does not exist yet.
//
// This is the packed CLI against a nonexistent path, with no terminal and no
// token, because that is exactly the case the unit tests never ran: they
// called cmdSetup directly and skipped the interactive wrapper that read the
// manifest first. Two real client laptops hit the refusal (CONFIG_INVALID,
// with a hint about git worktrees) before anything else could happen.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setupInvocation } from "../brain.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "brain.mjs");
const dir = mkdtempSync(join(tmpdir(), "brain-fresh-setup-"));
const missing = join(dir, "never-written", "brain.manifest.json");

const r = spawnSync(process.execPath, [CLI, "setup", missing], {
  input: "",
  encoding: "utf8",
  env: { ...process.env, CLOUDFLARE_API_TOKEN: "", BRAIN_NO_WRANGLER_LOGIN: "1" },
});
const out = `${r.stdout}\n${r.stderr}`;

assert.doesNotMatch(out, /could not read the install manifest/,
  "a missing manifest is setup's job to create, not a reason to refuse before setup runs");
assert.doesNotMatch(out, /git worktree/i,
  "a first-time client is never told about git worktrees");
assert.equal(existsSync(missing), false, "nothing was written by a run that could not continue");
assert.notEqual(r.status, 0, "with no terminal and no token the run still stops, but on its own terms");

const source = join(dir, "approved-source");
const explicit = join(dir, "explicit", "brain.manifest.json");
assert.deepEqual(
  setupInvocation("--no-connect", ["--no-connect"]),
  { manifestPath: null, flags: { "no-connect": true } },
  "a flag-first --no-connect setup must keep the default manifest rather than create a file named after the flag",
);
assert.deepEqual(
  setupInvocation("--path", ["--path", source]),
  { manifestPath: null, flags: { path: source } },
  "a flag-first first-folder setup must keep the default manifest and preserve the approved source path",
);
assert.deepEqual(
  setupInvocation("--manifest", ["--manifest", explicit, "--no-connect"]),
  { manifestPath: explicit, flags: { manifest: explicit, "no-connect": true } },
  "--manifest must supply the setup target when no positional manifest is present",
);
assert.deepEqual(
  setupInvocation(missing, [missing, "--path", source]),
  { manifestPath: missing, flags: { path: source } },
  "an explicit positional manifest must remain authoritative when setup also names its first folder",
);

console.log("fresh setup: missing and flag-first manifests reach setup's own first-install handling");
