/**
 * The product spawns wrangler for its own session renewal and diagnostics, and
 * tells operators which wrangler to run. Both must be the pinned version, from
 * one constant, or the guides say 4.73.0 while the CLI quietly runs 4.129 and
 * cannot read its own sign-in. That exact split cost two installs on 2026-09-04.
 *
 * This fails on any bare `wrangler@4` in product code outside a comment, so a
 * future edit cannot reintroduce the drift without a red test saying why.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WRANGLER_SPEC } from "../operations/wrangler-oauth.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let ran = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ran++; if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + detail));
};

check("WRANGLER_SPEC is a fully pinned 4.x version",
  /^wrangler@4\.\d+\.\d+$/.test(WRANGLER_SPEC), WRANGLER_SPEC);

const files = ["brain.mjs", "doctor.mjs",
  ...readdirSync(join(root, "operations")).filter((f) => f.endsWith(".mjs")).map((f) => join("operations", f))];

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const offenders = [];
for (const rel of files) {
  const code = stripComments(readFileSync(join(root, rel), "utf8"));
  code.split("\n").forEach((line, i) => {
    if (/wrangler@4(?![.\d])/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
  });
}
check("no bare wrangler@4 spawn or advice string in product code", offenders.length === 0,
  "\n    " + offenders.join("\n    "));

check("the spawn sites and the advice strings all go through WRANGLER_SPEC",
  files.filter((rel) => /WRANGLER_SPEC/.test(readFileSync(join(root, rel), "utf8"))).length >= 3,
  "expected brain.mjs, doctor.mjs and wrangler-oauth.mjs to reference it");

console.log(`\nwrangler pin: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
