import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOLDEN_20_PLAN, GOLDEN_20_TARGET, remainingPlan, runGolden20Session, writeGoldenPrivate,
} from "./golden-20.mjs";
import { validateGolden } from "./golden-validation.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-golden20-"));

/** Scripted terminal: each askFn call consumes one answer, in order. */
function scriptedAsk(answers) {
  const queue = [...answers];
  const fn = async (question, fallback = "") => {
    if (!queue.length) throw new Error(`ask ran past the script at: ${question}`);
    const next = queue.shift();
    return next === "" ? fallback : next;
  };
  fn.remaining = () => queue.length;
  return fn;
}

function fakeClient({ results = [], answer = "The documents do not contain that." } = {}) {
  const calls = { retrieve: [], think: [] };
  return {
    calls,
    async retrieve(question) {
      calls.retrieve.push(question);
      return results;
    },
    async think(question) {
      calls.think.push(question);
      return { answer, citations: [], gaps: [] };
    },
  };
}

const CURATED_RESULT = { source: "curated", ref_key: "meetings/2026-01-05_client_abc.md", title: "Kickoff decisions" };
const DRIVE_RESULT = { source: "drive", drive_file_id: "1AbC", title: "Contracts/Retainer.pdf" };
const MANIFEST = { client: { slug: "acme", display_name: "Acme Consulting" } };
const NOW = () => new Date("2026-08-26T12:00:00Z");

/** One scripted answer set that fills every slot of the default plan. */
function fullSessionScript() {
  const answers = [];
  for (const slot of GOLDEN_20_PLAN) {
    for (let i = 0; i < slot.count; i++) {
      answers.push(`${slot.kind} question ${i + 1}?`);
      if (slot.kind !== "unanswerable") answers.push(slot.kind === "multi" ? "1,2" : "1");
    }
  }
  return answers;
}

test("a full session writes a valid, complete Golden 20 with 0600 and scorer identities", async () => {
  const goldenPath = join(sandbox, "full.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT, DRIVE_RESULT] });
  const summary = await runGolden20Session({
    goldenPath, client, askFn: scriptedAsk(fullSessionScript()), manifest: MANIFEST, now: NOW,
  });

  assert.equal(summary.added, GOLDEN_20_TARGET);
  assert.equal(summary.complete, true);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.equal(golden.install, "acme");
  assert.equal(golden.created, "2026-08-26");
  assert.equal(golden.questions.length, GOLDEN_20_TARGET);
  validateGolden(golden, goldenPath);

  if (process.platform !== "win32") {
    assert.equal(statSync(goldenPath).mode & 0o777, 0o600);
  }

  // Retrieval ran only AFTER each answerable question was committed, and
  // never for unanswerable slots: the wording cannot borrow from a document.
  const answerable = GOLDEN_20_PLAN.filter((s) => s.kind !== "unanswerable")
    .reduce((n, s) => n + s.count, 0);
  assert.equal(client.calls.retrieve.length, answerable);

  // A single-kind pick stores scorer identities; drive evidence must use the
  // stable drive_file_id identity, never a chunk ref.
  const single = golden.questions.find((q) => q.kind === "single");
  assert.deepEqual(single.expect[0].any_of, ["curated:meetings/2026-01-05_client_abc.md"]);
  const multi = golden.questions.find((q) => q.kind === "multi");
  assert.equal(multi.expect.length, 2);
  assert.deepEqual(multi.expect[1].any_of, ["drive:1AbC", "drive_path:Contracts/Retainer.pdf"]);

  const unanswerable = golden.questions.filter((q) => q.kind === "unanswerable");
  assert.equal(unanswerable.length, 5);
  assert.ok(unanswerable.every((q) => q.expect === undefined));
});

test("blank questions skip their slot and a resumed session finishes the set", async () => {
  const goldenPath = join(sandbox, "resume.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });

  // First sitting: answer the first single question, skip everything else.
  const skipAll = ["s1?", "1", ...Array(GOLDEN_20_TARGET - 1).fill("")];
  const first = await runGolden20Session({
    goldenPath, client, askFn: scriptedAsk(skipAll), manifest: MANIFEST, now: NOW,
  });
  assert.equal(first.added, 1);
  assert.equal(first.complete, false);
  assert.equal(first.skipped, GOLDEN_20_TARGET - 1);

  // The remaining plan owes exactly the untouched slots.
  const partial = JSON.parse(readFileSync(goldenPath, "utf8"));
  const owed = remainingPlan(partial);
  assert.equal(owed.reduce((n, s) => n + s.count, 0), GOLDEN_20_TARGET - 1);
  assert.equal(owed.find((s) => s.kind === "single").count, GOLDEN_20_PLAN[0].count - 1);

  // Second sitting completes it; ids continue without colliding.
  const rest = [];
  for (const slot of owed) {
    for (let i = 0; i < slot.count; i++) {
      rest.push(`${slot.kind} later ${i + 1}?`);
      if (slot.kind !== "unanswerable") rest.push("1");
    }
  }
  const second = await runGolden20Session({
    goldenPath, client, askFn: scriptedAsk(rest), manifest: MANIFEST, now: NOW,
  });
  assert.equal(second.complete, true);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.equal(golden.questions.length, GOLDEN_20_TARGET);
  assert.equal(new Set(golden.questions.map((q) => q.id)).size, GOLDEN_20_TARGET);
  validateGolden(golden, goldenPath);

  // A complete file is left alone.
  const third = await runGolden20Session({
    goldenPath, client, askFn: scriptedAsk([]), manifest: MANIFEST, now: NOW,
  });
  assert.equal(third.added, 0);
  assert.equal(third.complete, true);
});

test("when no result is right the owner can reclassify, type a title, or skip", async () => {
  const goldenPath = join(sandbox, "fallback.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const script = [
    // Slot 1: none right -> becomes unanswerable.
    "was there a fee waiver?", "n", "u",
    // Slot 2: none right -> owner types the document title, default source.
    "what does the retainer cost?", "n", "t", "Contracts/Retainer.pdf", "",
    // Slot 3: none right -> skip.
    "who signed the NDA?", "n", "s",
    // Remaining slots skipped with blank questions.
    ...Array(GOLDEN_20_TARGET - 3).fill(""),
  ];
  const summary = await runGolden20Session({
    goldenPath, client, askFn: scriptedAsk(script), manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 2);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  validateGolden(golden, goldenPath);
  assert.equal(golden.questions[0].kind, "unanswerable");
  assert.equal(golden.questions[0].expect, undefined);
  assert.deepEqual(golden.questions[1].expect, [{ doc: "Contracts/Retainer.pdf", source: "drive" }]);
});

test("a live refusal check failure never aborts the session", async () => {
  const goldenPath = join(sandbox, "think-down.golden.json");
  const client = {
    async retrieve() { return [CURATED_RESULT]; },
    async think() { throw new Error("spend cap"); },
  };
  const script = [];
  for (const slot of GOLDEN_20_PLAN) {
    for (let i = 0; i < slot.count; i++) {
      script.push(`${slot.kind} q${i}?`);
      if (slot.kind !== "unanswerable") script.push("1");
    }
  }
  const summary = await runGolden20Session({
    goldenPath, client, askFn: scriptedAsk(script), manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.complete, true);
});

test("writeGoldenPrivate refuses a symlinked destination", () => {
  const target = join(sandbox, "real.json");
  writeFileSync(target, "{}\n");
  const link = join(sandbox, "link.golden.json");
  symlinkSync(target, link);
  assert.throws(
    () => writeGoldenPrivate(link, { questions: [] }),
    /private regular file/,
  );
});
