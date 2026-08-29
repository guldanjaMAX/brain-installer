// The drain cron default, pinned.
//
// The drain moves chunks from D1 into Vectorize, and it advances roughly one
// batch per Vectorize CONFIRMATION rather than per tick. So the tick rate is
// the ceiling on how fast a first load becomes searchable. At */5 a real
// install sustained about 20 vectors a minute, which is over four days for a
// 125k-chunk load, during which the brain answers keyword queries and silently
// misses semantic ones while every health probe passes.
//
// Raising the rate cannot raise the embedding bill: confirmSubmittedVectors
// checks the projection fence first and returns having embedded nothing when
// the previous changeset is unconfirmed. Extra ticks are no-ops.
//
// This test exists because the default lives in three files that can drift
// apart, and because a slower default would silently reintroduce four days of
// looking broken on every new install.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const EXPECTED = "* * * * *";

test("the schema, the template and the code fallback all agree", () => {
  const schemaDefault = json("manifest.schema.json")
    .properties.infrastructure.properties.cloudflare.properties.drain_cron.default;
  const templateValue = json("templates/brain.manifest.json")
    .infrastructure.cloudflare.drain_cron;
  const source = readFileSync(join(ROOT, "brain.mjs"), "utf8");
  const fallback = source.match(/cfg\.drain_cron \|\| "([^"]+)"/)?.[1];

  assert.equal(schemaDefault, EXPECTED, "manifest.schema.json default drifted");
  assert.equal(templateValue, EXPECTED, "templates/brain.manifest.json drifted");
  assert.equal(fallback, EXPECTED, "the brain.mjs fallback drifted");
});

test("the default never becomes slower than once a minute", () => {
  const value = json("templates/brain.manifest.json").infrastructure.cloudflare.drain_cron;
  const minuteField = value.trim().split(/\s+/)[0];
  assert.ok(
    minuteField === "*",
    `the minute field is "${minuteField}". A stepped or fixed minute field throttles the ` +
      "drain, and the drain is confirmation-bound, so that directly extends how long a new " +
      "install looks empty. Change this only with a measurement.",
  );
});

test("the template explains why, not just what", () => {
  const comment = json("templates/brain.manifest.json")
    .infrastructure.cloudflare._drain_cron_comment.join(" ");
  assert.match(comment, /confirmation/i, "must say the drain is confirmation-bound");
  assert.match(comment, /cannot raise the embedding bill/i, "must state the cost argument");
});
