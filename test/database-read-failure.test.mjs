/**
 * A preflight read that fails must say WHY. Three migrate/update reads used to
 * discard the provider's message, so a Cloudflare account hitting D1's daily
 * row-read limit produced "migration could not verify whether this brain is
 * already live" and nothing else; grepping the logs for the cause found
 * nothing because the CLI had thrown it away (2026-09-03, install bench).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { databaseReadFailureDetail } from "../brain.mjs";

const quota = databaseReadFailureDetail(new Error(
  "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
));
assert.match(quota, /The database said: D1_ERROR/, "the provider's own words survive");
assert.match(quota, /daily D1 allowance, not a fault in the brain and not anything you did/, "names the cause without blaming the owner");
assert.match(quota, /resets at midnight UTC, and the Workers Paid plan removes the daily cap/, "gives both ways out");
assert.match(quota, /Nothing was changed/, "says the brain is untouched");

const ordinary = databaseReadFailureDetail(new Error("fetch failed"));
assert.match(ordinary, /The database said: fetch failed/, "an ordinary failure is still quoted");
assert.doesNotMatch(ordinary, /daily D1 allowance/, "only a quota refusal gets the quota explanation");

assert.match(databaseReadFailureDetail(undefined), /did not say why/, "a causeless failure says so plainly");
assert.ok(
  databaseReadFailureDetail(new Error("x".repeat(4000))).length < 500,
  "a runaway provider message is capped rather than dumped",
);

// Every one of the three preflight reads must pass its cause on.
const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
assert.equal(
  (source.match(/^\s+databaseReadFailureDetail\(error\)\);$/gm) || []).length, 5,
  "every preflight read and install-state parse reports the cause",
);
const swallowed = source.match(/\} catch \{\n\s+die\("(?:migration could not|update stopped because D1 install state)[^"]*/g) || [];
assert.deepEqual(swallowed, [], `a preflight read still swallows its cause: ${swallowed.join(" | ").slice(0, 200)}`);

console.log("database read failure: a failed preflight read says why, and a quota refusal says whose limit it is");
