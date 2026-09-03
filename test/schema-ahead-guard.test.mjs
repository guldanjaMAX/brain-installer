/**
 * A brain whose schema is ahead of every migration in the release has run code
 * this release has never seen. The version guard cannot catch it: it compares
 * recorded product-version STRINGS, and a brain built from a working branch can
 * record a lower string while running a higher schema. James's own brain on
 * 2026-09-03 recorded product_version 0.1.16 with schema_version 32 while the
 * release shipped 22 migrations, so the update would have read it as an upgrade
 * and renumbered a schema with no clean repair.
 */
import assert from "node:assert/strict";
import { schemaAheadOfReleaseRefusal } from "../brain.mjs";

const release = Array.from({ length: 22 }, (_, i) => ({ version: i + 1 }));

// The real case, with both numbers in the message so it can be acted on.
{
  const refusal = schemaAheadOfReleaseRefusal(32, release, "0.3.5");
  assert.ok(refusal, "a schema ahead of the release must refuse");
  assert.match(refusal, /schema 32/, "names the brain's schema");
  assert.match(refusal, /0\.3\.5 only knows schema 22/, "names the release and what it knows");
  assert.match(refusal, /Nothing was changed/, "says the brain is untouched");
  assert.match(refusal, /working branch/, "explains how a brain gets ahead");
}

// Every ordinary update must still proceed.
for (const schema of [1, 13, 21, 22]) {
  assert.equal(
    schemaAheadOfReleaseRefusal(schema, release, "0.3.5"), null,
    `a brain at schema ${schema} is not ahead of a 22-migration release and must proceed`,
  );
}

// One past the highest is the boundary, and it refuses.
assert.ok(schemaAheadOfReleaseRefusal(23, release, "0.3.5"), "one past the highest refuses");

// Gaps do not matter: the HIGHEST migration is the release's knowledge, not the count.
assert.equal(
  schemaAheadOfReleaseRefusal(22, [{ version: 1 }, { version: 22 }], "0.3.5"), null,
  "a release with gaps still knows up to its highest migration",
);

// Unreadable or absent state proceeds. This guard catches one provable case; it
// must not become a new way for an ordinary update to stop.
for (const bad of [undefined, null, "", 0, -1, Number.NaN, "thirty-two", 1.5]) {
  assert.equal(schemaAheadOfReleaseRefusal(bad, release, "0.3.5"), null, `unreadable schema ${String(bad)} proceeds`);
}
assert.equal(schemaAheadOfReleaseRefusal(32, [], "0.3.5"), null, "no migrations to compare against proceeds");
assert.equal(schemaAheadOfReleaseRefusal(32, undefined, "0.3.5"), null, "absent migration list proceeds");
assert.equal(schemaAheadOfReleaseRefusal(32, [{ version: "x" }], "0.3.5"), null, "unparseable migrations proceed");

console.log("schema ahead guard: a brain ahead of the release refuses, every ordinary update proceeds");
