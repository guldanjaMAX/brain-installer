/**
 * `brain init` must work whether or not it has to ask.
 *
 * 0.2.2 shipped an init that worked with all three flags and threw
 * "prompt is not defined" the moment it had to ask anything, because the
 * function never resolved its own asker the way every other command does.
 * The flagged path hid it: `flags.name || await prompt(...)` short-circuits
 * before the bad call. So the only test that catches this is one that
 * actually answers the questions. Found by a real install, 2026-09-02.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "brain.mjs");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "brain-init-"));

const run = (args, input = "") =>
  spawnSync(process.execPath, [CLI, "init", ...args], { input, encoding: "utf8" });

// Fully interactive: no flags at all, every answer typed.
const interactive = run([join(dir, "a.json")], `Rowan Vale\nrowanvale\n${ACCOUNT}\n`);
assert.equal(interactive.status, 0, `interactive init failed: ${interactive.stderr}`);
assert.doesNotMatch(`${interactive.stdout}${interactive.stderr}`, /is not defined/,
  "init must resolve its own asker, like every other command");
const a = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
assert.equal(a.client.slug, "rowanvale");
assert.equal(a.client.display_name, "Rowan Vale");
assert.equal(a.brain.worker_name, "rowanvale-brain");

// Partly flagged: the mixed path, which is what an operator actually types.
const partial = run([join(dir, "b.json"), "--name", "Harbour Stone"], `harbourstone\n${ACCOUNT}\n`);
assert.equal(partial.status, 0, `partly-flagged init failed: ${partial.stderr}`);
assert.equal(JSON.parse(readFileSync(join(dir, "b.json"), "utf8")).client.slug, "harbourstone");

// Fully flagged: must not read stdin at all.
const flagged = run([join(dir, "c.json"), "--name", "Example Company", "--slug", "examplecompany", "--account", ACCOUNT]);
assert.equal(flagged.status, 0, `flagged init failed: ${flagged.stderr}`);
assert.equal(JSON.parse(readFileSync(join(dir, "c.json"), "utf8")).client.slug, "examplecompany");

// A typo must be refused rather than silently ignored, and write nothing.
const typo = run([join(dir, "d.json"), "--nmae", "x"]);
assert.notEqual(typo.status, 0, "an unknown flag must fail");
assert.equal(existsSync(join(dir, "d.json")), false, "a refused run must leave no manifest");

console.log("brain init: interactive, partly flagged, fully flagged, and unknown-flag paths all behave");
