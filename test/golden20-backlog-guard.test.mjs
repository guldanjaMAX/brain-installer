// A still-loading index must not masquerade as an absent document.
//
// The golden-20 session asks the brain to find the document answering a
// question the owner just wrote, and the owner is watching. Mid-load that
// lookup fails for a reason that has nothing to do with the brain's knowledge:
// the document is in D1 and has not vectorised yet. Retrieval returns an empty
// list, identical to what a genuinely missing document returns.
//
// Before this guard the session said "The brain returned nothing for this
// question", which is true and reads as a finding. On install day, with the
// client present, it is the wrong conclusion delivered confidently.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGolden20Session } from "../eval/golden-20.mjs";

function harness({ backlog, healthThrows = false }) {
  const lines = [];
  const client = {
    async health() {
      if (healthThrows) throw new Error("health unavailable");
      return { vector_backlog: backlog };
    },
    async retrieve() { return []; },
    async think() { return { answer: null }; },
  };
  return {
    lines,
    client,
    log: (line) => lines.push(String(line)),
    // Blank answers skip every slot, so the session exercises setup and exits.
    askFn: async () => "",
  };
}

async function run(opts) {
  const dir = mkdtempSync(join(tmpdir(), "golden20-guard-"));
  const h = harness(opts);
  try {
    await runGolden20Session({
      goldenPath: join(dir, "brain.golden.json"),
      client: h.client,
      askFn: h.askFn,
      log: h.log,
      manifest: { client: { name: "Fixture" } },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return h.lines.join("\n");
}

test("a non-empty backlog is announced before the first question", async () => {
  const out = await run({ backlog: 90739 });
  assert.match(out, /90,739 chunks have not reached the search index/i);
  assert.match(out, /Writing the questions now is fine/i,
    "must tell them the useful half is still worth doing");
  assert.match(out, /re-run --golden-20 after the load settles/i,
    "must name the concrete next step");
});

test("a warm index says nothing about backlogs", async () => {
  const out = await run({ backlog: 0 });
  assert.doesNotMatch(out, /have not reached the search index/i,
    "a fully drained brain must not warn about a load");
});

test("an unreadable health endpoint never blocks a session with a person in it", async () => {
  const out = await run({ healthThrows: true });
  assert.doesNotMatch(out, /have not reached the search index/i);
  assert.match(out, /Golden \d+/, "the session must still start normally");
});

test("the guard reads the field the worker actually publishes", () => {
  const source = new URL("../eval/golden-20.mjs", import.meta.url);
  const text = readFileSync(source, "utf8");
  assert.match(text, /vector_backlog/,
    "must read /health's vector_backlog, which is the field the worker sets");
  assert.match(text, /catch\s*\{\s*return null/,
    "the backlog read must be fail-soft");
});
