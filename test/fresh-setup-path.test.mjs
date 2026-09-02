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

console.log("fresh setup: a missing manifest reaches setup's own first-install handling");
