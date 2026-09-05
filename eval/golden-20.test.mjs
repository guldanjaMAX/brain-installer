import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOLDEN_20_PLAN, GOLDEN_20_TARGET, remainingPlan, runGolden20Session,
  suggestSourceName, writeGoldenPrivate,
} from "./golden-20.mjs";
import { validateGolden } from "./golden-validation.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-golden20-"));

/** Scripted terminal: each askFn call consumes one answer, in order. */
function scriptedAsk(answers) {
  const queue = [...answers];
  const fn = async (question, fallback = "") => {
    fn.asked.push({ question: String(question), fallback: String(fallback) });
    if (!queue.length) throw new Error(`ask ran past the script at: ${question}`);
    const next = queue.shift();
    return next === "" ? fallback : next;
  };
  fn.asked = [];
  fn.remaining = () => queue.length;
  return fn;
}

/**
 * A terminal whose reader has gone away: the scripted answers run out and then
 * every prompt resolves to its default, which is exactly what brain.mjs's ask()
 * does when stdin ends. The session must complete on defaults, never hang.
 */
function deadStdinAsk(answers) {
  const queue = [...answers];
  const fn = async (question, fallback = "") => {
    fn.asked.push({ question: String(question), fallback: String(fallback) });
    if (!queue.length) return fallback;
    const next = queue.shift();
    return next === "" ? fallback : next;
  };
  fn.asked = [];
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
    // Slot 3: none right -> skip, which now takes one explicit confirm.
    "who signed the NDA?", "n", "s", "y",
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

/* ------------------------------------------------------------------------- *
 * Keystroke guards. Each question in this session is a slot of the owner's
 * memory, written live on install day. Three prompts used to be able to
 * destroy or corrupt that work on a single keystroke: the fallback menu's
 * silent default skip, a blank title doing the same, and a free-text source
 * that the validator later rejects, after the file is already written.
 * ------------------------------------------------------------------------- */

test("a bare Enter at the fallback menu cannot discard the question silently", async () => {
  const goldenPath = join(sandbox, "guard-bare-enter.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const ask = scriptedAsk([
    "was there a fee waiver?", "n",
    "",   // fallback menu, bare Enter: the old default discarded here
    "",   // discard confirm: bare Enter must default to KEEP, not discard
    "u",  // back at the menu, the owner reclassifies instead
    ...Array(GOLDEN_20_TARGET - 1).fill(""),
  ]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 1, "the question must survive an accidental Enter");
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.equal(golden.questions[0].kind, "unanswerable");
  assert.equal(golden.questions[0].question, "was there a fee waiver?");
  assert.ok(ask.asked.some((a) => /discard this question/i.test(a.question)),
    "losing the question must go through an explicit confirm");
});

test("an explicit skip still works, gated by one confirm", async () => {
  const goldenPath = join(sandbox, "guard-explicit-skip.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const ask = scriptedAsk([
    "who signed the NDA?", "n", "s", "y",
    ...Array(GOLDEN_20_TARGET - 1).fill(""),
  ]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 0);
  assert.equal(summary.skipped, GOLDEN_20_TARGET);
  const confirms = ask.asked.filter((a) => /discard this question/i.test(a.question));
  assert.equal(confirms.length, 1, "an explicit skip is confirmed exactly once");
  assert.equal(confirms[0].fallback, "n", "the confirm must default to keeping the question");
});

test("a dead stdin completes the session on defaults instead of hanging", async () => {
  const goldenPath = join(sandbox, "guard-dead-stdin.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  // The owner wrote one question, then the pipe ended: every later prompt
  // resolves to its default, exactly like brain.mjs ask() after stdin EOF.
  const ask = deadStdinAsk(["who signed the NDA?", "n"]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 0);
  assert.equal(summary.skipped, GOLDEN_20_TARGET);
  const confirms = ask.asked.filter((a) => /discard this question/i.test(a.question));
  assert.ok(confirms.length >= 1, "even an unattended skip passes the confirm");
  assert.equal(confirms[confirms.length - 1].fallback, "y",
    "after one refused confirm the default must flip so a default-only run terminates");
});

test("a blank document title explains and re-prompts instead of discarding", async () => {
  const goldenPath = join(sandbox, "guard-blank-title.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const lines = [];
  const ask = scriptedAsk([
    "what does the retainer cost?", "n", "t",
    "",                        // blank title: must explain, then ask again
    "Contracts/Retainer.pdf",  // second try lands
    "",                        // source: default
    ...Array(GOLDEN_20_TARGET - 1).fill(""),
  ]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, log: (l) => lines.push(String(l)),
    manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 1, "one empty Enter at the title prompt must not cost the question");
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.deepEqual(golden.questions[0].expect, [{ doc: "Contracts/Retainer.pdf", source: "drive" }]);
  assert.ok(lines.some((l) => /blank title/i.test(l)),
    "the re-prompt must say why a blank title cannot stand");
});

test("two blank titles reach the discard confirm; declining returns to the menu", async () => {
  const goldenPath = join(sandbox, "guard-two-blank-titles.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const ask = scriptedAsk([
    "what does the retainer cost?", "n", "t",
    "", "",                    // two blank titles in a row
    "",                        // discard confirm: default keeps the question
    "t", "Contracts/Retainer.pdf", "",  // menu again; this time it lands
    ...Array(GOLDEN_20_TARGET - 1).fill(""),
  ]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 1);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.deepEqual(golden.questions[0].expect, [{ doc: "Contracts/Retainer.pdf", source: "drive" }]);
  validateGolden(golden, goldenPath);
});

test("an invalid source is refused, the nearest valid name suggested, and the file stays scorable", async () => {
  const goldenPath = join(sandbox, "guard-bad-source.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const lines = [];
  const ask = scriptedAsk([
    "what does the retainer cost?", "n", "t", "Contracts/Retainer.pdf",
    "Google Drive",   // not a name the validator or the scorer can ever match
    "",               // the re-prompt offers the suggestion as its default
    ...Array(GOLDEN_20_TARGET - 1).fill(""),
  ]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, log: (l) => lines.push(String(l)),
    manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 1);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.deepEqual(golden.questions[0].expect, [{ doc: "Contracts/Retainer.pdf", source: "drive" }]);
  validateGolden(golden, goldenPath);
  const reprompt = ask.asked.filter((a) => /its source/i.test(a.question));
  assert.equal(reprompt.length, 2);
  assert.equal(reprompt[1].fallback, "drive", "the suggestion becomes the re-prompt default");
  assert.ok(lines.some((l) => /Google Drive/.test(l)),
    "the refusal must name the value it is refusing");
});

test("a custom source that satisfies the evidence contract is accepted verbatim", async () => {
  const goldenPath = join(sandbox, "guard-custom-source.golden.json");
  const client = fakeClient({ results: [CURATED_RESULT] });
  const ask = scriptedAsk([
    "what did the vendor quote?", "n", "t", "Vendor quote 2026-01", "vendor-mail",
    ...Array(GOLDEN_20_TARGET - 1).fill(""),
  ]);
  const summary = await runGolden20Session({
    goldenPath, client, askFn: ask, manifest: MANIFEST, now: NOW,
  });
  assert.equal(summary.added, 1);
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  assert.deepEqual(golden.questions[0].expect, [{ doc: "Vendor quote 2026-01", source: "vendor-mail" }]);
  validateGolden(golden, goldenPath);
});

test("suggestSourceName maps stray spellings onto names the scorer can match", () => {
  assert.equal(suggestSourceName("Google Drive"), "drive");
  assert.equal(suggestSourceName("iMessage"), "message");
  assert.equal(suggestSourceName("curted"), "curated", "one-typo distance still finds the real name");
  assert.equal(suggestSourceName("Meeting Notes"), "meeting-notes",
    "an unfamiliar but salvageable name is normalised, not replaced");
  assert.equal(suggestSourceName("???"), null, "nothing salvageable suggests nothing");
  assert.equal(suggestSourceName(""), null);
});
