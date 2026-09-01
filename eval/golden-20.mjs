/**
 * golden-20 — a guided session that builds an install's first golden question
 * set live against the brain it will judge.
 *
 * The blank template asks the owner to author questions alone, and the field
 * result of that is an empty workbook: the eval machinery exists but no client
 * sits down with a JSON file and writes 20 questions unprompted. This session
 * is the handoff ritual instead — operator and owner fill twenty slots
 * together in one sitting, and the file it writes is immediately scorable by
 * eval/run.mjs.
 *
 * Two invariants carried over from the workbook, because they are what make
 * the score mean anything:
 *
 *   Questions are written FROM MEMORY, before any retrieval is shown. The
 *   session runs retrieval only AFTER the question text is committed, so the
 *   wording cannot borrow from the document that will answer it.
 *
 *   Unanswerable questions are first-class. Five of the twenty slots are
 *   things the brain must refuse, because a brain that confabulates an answer
 *   to a question about a deal that never happened is more dangerous than one
 *   that misses a real document.
 *
 * The retrieval-assisted step is the reason this takes twenty minutes instead
 * of an afternoon: the owner never hand-locates evidence references. The
 * session runs their question, shows the distinct documents that came back,
 * and the ones they confirm become the expect entry via the same identity
 * scheme the scorer matches on (identitiesOf), so Drive evidence stays stable
 * across re-indexes.
 *
 * Dependencies are injected (client, askFn, log, now) so the whole session is
 * testable with a scripted terminal and a fake brain. Only the private-file
 * write touches the filesystem directly, with the same O_EXCL 0600 discipline
 * as writePrivateEvalTemplate: the file holds real names and real figures the
 * moment the first question lands.
 */

import {
  closeSync, constants as fsConstants, chmodSync, fstatSync, fsyncSync,
  lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { dedupeByDocument, identitiesOf } from "./scorer.mjs";
import { validateGolden } from "./golden-validation.mjs";

/**
 * The Golden 20. Kind names are the executable query-kind vocabulary the
 * validator and release slices already use; the mix mirrors the categories
 * that found real defects in field probing (2026-08-26): stale current-state
 * answers surface under `temporal`, speaker misattribution under `person`,
 * confabulation under `unanswerable`.
 */
export const GOLDEN_20_PLAN = [
  {
    kind: "single", count: 6,
    coach: "A fact one document should answer: a price, a date, a decision, a clause.",
  },
  {
    kind: "multi", count: 3,
    coach: "An answer needing TWO OR MORE documents together. Confirm every required document; each becomes required evidence.",
  },
  {
    kind: "temporal", count: 3,
    coach: "Something that CHANGED: a current status, an address, a rate. The newest truth must beat the best-attested old one.",
  },
  {
    kind: "person", count: 3,
    coach: "Who said or did a thing, where mixing people up would matter.",
  },
  {
    kind: "unanswerable", count: 5,
    coach: "Something plausible the brain genuinely does NOT have: a deal that never happened, a policy never written. It must refuse.",
  },
];

export const GOLDEN_20_TARGET = GOLDEN_20_PLAN.reduce((n, s) => n + s.count, 0);

/** Sounds like a refusal, for the informational unanswerable live check only. */
const REFUSAL_HINT =
  /do(es)? not (contain|answer|mention|include)|no (information|mention|record)|nothing recorded|not (found|recorded|mentioned)|cannot answer|unable to answer/i;

/**
 * Create-or-rewrite a private golden file. Creation is O_EXCL 0600 so a
 * concurrent writer or a pre-placed symlink cannot capture the content; a
 * rewrite (the session saves after every slot, so a crash costs one question,
 * not twenty) first proves the path is still a regular single-link file.
 */
export function writeGoldenPrivate(destination, golden) {
  const path = resolve(destination);
  const payload = JSON.stringify(golden, null, 2) + "\n";
  if (existsSync(path)) {
    const identity = lstatSync(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
      throw new Error("the golden set destination is no longer a private regular file");
    }
    writeFileSync(path, payload, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return path;
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("the golden set directory must be a real directory, not a link");
  }
  let descriptor = null;
  let created = false;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    const identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1) {
      throw new Error("the golden set destination is not a private regular file");
    }
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* cleanup below still runs */ }
      descriptor = null;
    }
    if (created) {
      try { unlinkSync(path); } catch { /* never hide the original failure */ }
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return path;
}

function loadOrStartGolden(goldenPath, manifest, now) {
  if (existsSync(goldenPath)) {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    if (!Array.isArray(golden.questions)) golden.questions = [];
    return golden;
  }
  return {
    install: manifest?.client?.slug || "install",
    brain_label: manifest?.client?.display_name || manifest?.client?.slug || "brain",
    created: now().toISOString().slice(0, 10),
    built_by: "the owner and the operator, in a guided Golden 20 session",
    _how_to_read_this: [
      "Built with `brain eval --golden-20`: each question was written from",
      "memory BEFORE retrieval ran, then the owner confirmed which returned",
      "documents are the right evidence. Unanswerable entries are questions",
      "the brain must refuse. Score with `brain eval <manifest>`.",
    ],
    questions: [],
  };
}

function nextQuestionId(golden) {
  const taken = new Set(golden.questions.map((q) => String(q.id)));
  for (let n = golden.questions.length + 1; ; n++) {
    const id = `g${String(n).padStart(2, "0")}`;
    if (!taken.has(id)) return id;
  }
}

/** Remaining slots per kind after whatever an earlier session already wrote. */
export function remainingPlan(golden, plan = GOLDEN_20_PLAN) {
  const have = {};
  for (const q of golden.questions) have[q.kind] = (have[q.kind] || 0) + 1;
  return plan
    .map((slot) => ({ ...slot, count: Math.max(0, slot.count - (have[slot.kind] || 0)) }))
    .filter((slot) => slot.count > 0);
}

function parsePicks(text, max) {
  const picks = [];
  for (const piece of String(text).split(/[\s,]+/)) {
    if (!piece) continue;
    if (!/^\d+$/.test(piece)) return null;
    const n = Number(piece);
    if (n < 1 || n > max || picks.includes(n)) return null;
    picks.push(n);
  }
  return picks.length ? picks : null;
}

/**
 * The shape a title-only evidence source must have. This mirrors
 * golden-validation.mjs and the corpus contract in run.mjs: a source is an
 * ingest family name, lowercase, `[a-z0-9][a-z0-9_-]{0,63}`. The scorer
 * matches title-only evidence only inside an exact source (scorer.mjs,
 * slotMatches), so a value like "Google Drive" can never match anything and
 * the validator refuses the file at the end of the session — after the
 * owner's twenty minutes are already written into it.
 */
const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The families every install starts with; custom --source names extend them. */
const CANONICAL_SOURCES = ["drive", "curated", "message"];

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n];
}

/**
 * The nearest valid source name for a value that failed the contract, or null
 * when nothing salvageable remains. Canonical names win: "Google Drive" is
 * someone describing drive, not naming a custom family. A normalised form that
 * matches no canonical name but satisfies the contract is offered as itself,
 * because custom --source families are legitimate.
 */
export function suggestSourceName(raw) {
  const cleaned = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return null;
  for (const canon of CANONICAL_SOURCES) {
    if (cleaned === canon || cleaned.includes(canon)) return canon;
  }
  let best = null;
  let bestDistance = 3; // more than two edits away is a different word, not a typo
  for (const canon of CANONICAL_SOURCES) {
    const distance = editDistance(cleaned, canon);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = canon;
    }
  }
  if (best) return best;
  return SOURCE_NAME.test(cleaned) ? cleaned : null;
}

/**
 * How many chunks are still waiting to reach the vector index.
 *
 * The evidence step below asks the brain to find the document that answers a
 * question the owner just wrote. Mid-load that question is unanswerable for a
 * reason that has nothing to do with the brain's knowledge: the document is in
 * D1 and has not been vectorised yet. Retrieval returns an empty list, exactly
 * as it would for a document that does not exist, and the owner is sitting
 * there watching their own lease fail to appear.
 *
 * Reading the backlog is what lets the session tell those two apart. It is
 * fail-soft on purpose: a health endpoint that is slow or missing must never
 * take down a session with a person in it, so an unreadable backlog reports
 * null and the session proceeds exactly as it did before.
 */
async function readVectorBacklog(client) {
  try {
    const health = await client.health();
    const depth = Number(health?.vector_backlog);
    return Number.isFinite(depth) && depth >= 0 ? depth : null;
  } catch {
    return null;
  }
}

async function captureEvidence({ kind, question, client, askFn, log, backlog = null }) {
  let results = [];
  try {
    results = dedupeByDocument(await client.retrieve(question, { limit: 10 }));
  } catch (error) {
    log(`  retrieval failed (${error.message}); you can still name the document yourself.`);
  }
  const shown = results.slice(0, 8);
  if (shown.length) {
    log("  The brain returned these documents:");
    shown.forEach((r, i) => {
      const title = String(r.title || r.ref_key || "untitled").slice(0, 96);
      log(`    ${i + 1}. [${r.source || "unknown"}] ${title}`);
    });
  } else if (backlog) {
    // Do not let a still-loading index masquerade as an absent document.
    log(`  The brain returned nothing, and ${backlog.toLocaleString()} chunks are still`);
    log("  loading, so this is very likely too early rather than genuinely missing.");
    log("  Name the document yourself if you know it, or leave it and re-run");
    log("  --golden-20 once the load settles.");
  } else {
    log("  The brain returned nothing for this question.");
  }
  const picked = parsePicks(
    await askFn("Which are the RIGHT source documents? (numbers like 1 or 1,3 — n for none)", "n"),
    shown.length,
  );
  if (picked) {
    const chosen = picked.map((n) => shown[n - 1]);
    if (kind === "multi") {
      // Required together: an answer assembled from half the evidence is not
      // an answer, so each confirmed document is its own required slot.
      return chosen.map((r) => ({
        doc: String(r.title || r.ref_key || "untitled"),
        any_of: identitiesOf(r),
      }));
    }
    // Alternates for the same fact: any one of the confirmed documents
    // satisfies the question, so their identities share one slot.
    return [{
      doc: String(chosen[0].title || chosen[0].ref_key || "untitled"),
      any_of: chosen.flatMap((r) => identitiesOf(r)),
    }];
  }
  // The question above this menu is a slot of the owner's memory, written
  // live. Discarding it is the one irreversible outcome here, and it used to
  // be the DEFAULT: a bare Enter, or any unrecognised key, threw the question
  // away without a word. Every path that loses the question now passes one
  // explicit confirm. The confirm's default starts at "n" (keep), and flips
  // to "y" after a refusal so that a reader that answers only defaults — a
  // finished pipe, brain.mjs ask() after stdin EOF — still terminates instead
  // of cycling this menu forever.
  let discardDefault = "n";
  const confirmDiscard = async () => {
    const answer = (await askFn("Discard this question? y/n", discardDefault))
      .trim().toLowerCase();
    if (answer.startsWith("y")) return true;
    discardDefault = "y";
    return false;
  };
  while (true) {
    const fallback = (await askFn(
      "None were right. (u) it is actually unanswerable, (t) type the document title, (s) skip",
      "s",
    )).toLowerCase();
    if (fallback === "u") return "unanswerable";
    if (fallback === "t") {
      let doc = String(await askFn("Document title, as ingested")).trim();
      if (!doc) {
        // No default exists for a title, so a bare Enter here used to mean
        // "skip" without saying so. Explain once, ask once more.
        log("  A blank title cannot serve as evidence: the scorer matches the");
        log("  title exactly as it was ingested. Type it, or Enter again to stop.");
        doc = String(await askFn("Document title, as ingested")).trim();
      }
      if (!doc) {
        if (await confirmDiscard()) return "skip";
        continue; // back to the menu with the question intact
      }
      let source = String(await askFn("Its source (drive, curated, message, ...)", "drive")).trim();
      while (!SOURCE_NAME.test(source)) {
        // A source the contract cannot express would be written to disk now
        // and refused by the validator at the end of the session — a broken
        // file, discovered after the work. Refuse it here instead.
        const suggestion = suggestSourceName(source);
        log(`  "${source}" is not a source name the scorer can match: lowercase`);
        log(`  letters, digits, - and _ only${suggestion ? `. Did you mean "${suggestion}"?` : "."}`);
        source = String(await askFn("Its source (drive, curated, message, ...)", suggestion || "drive")).trim();
      }
      // Title-only evidence: honest about being weaker than a confirmed
      // reference, and the validator requires the source to be named.
      return [{ doc, source }];
    }
    // "s", a bare Enter, or any unrecognised key: the skip path.
    if (await confirmDiscard()) return "skip";
  }
}

/**
 * Run the guided session. Returns { added, skipped, total, complete, path }.
 * Throws on an unreadable existing file or an unwritable destination; a
 * retrieval or think failure never aborts a session someone is sitting in.
 */
export async function runGolden20Session({
  goldenPath,
  client,
  askFn,
  log = () => {},
  manifest = null,
  now = () => new Date(),
  plan = GOLDEN_20_PLAN,
}) {
  const golden = loadOrStartGolden(goldenPath, manifest, now);
  const slots = remainingPlan(golden, plan);
  const target = plan.reduce((n, s) => n + s.count, 0);
  if (!slots.length) {
    log(`  ${goldenPath} already holds a complete set of ${golden.questions.length}. Nothing to add.`);
    return { added: 0, skipped: 0, total: golden.questions.length, complete: true, path: goldenPath };
  }

  log("");
  log(`  Golden ${target} — ${golden.questions.length} written, ${slots.reduce((n, s) => n + s.count, 0)} to go.`);
  log("  Write each question FROM MEMORY. Do not open files: a question written");
  log("  while reading a document borrows its wording and flatters the score.");
  log("  A blank question skips the slot; re-run --golden-20 later to finish.");

  // Checked once, before the first question, because the honest thing to do
  // about a still-loading index is warn up front rather than let someone draw
  // twenty wrong conclusions one at a time.
  const backlog = await readVectorBacklog(client);
  if (backlog) {
    log("");
    log(`  NOTE: ${backlog.toLocaleString()} chunks have not reached the search index yet.`);
    log("  Writing the questions now is fine and is the best use of this time.");
    log("  Attaching the right documents to them is not: the brain will come up");
    log("  empty for things it already holds, which looks like a gap and is not.");
    log("  Finish the wording now and re-run --golden-20 after the load settles.");
  }

  let added = 0;
  let skipped = 0;
  for (const slot of slots) {
    for (let i = 0; i < slot.count; i++) {
      log("");
      log(`  [${slot.kind}] ${slot.coach}`);
      const question = await askFn("Question");
      if (!question) {
        skipped++;
        continue;
      }

      const entry = { id: nextQuestionId(golden), kind: slot.kind, question };
      if (slot.kind === "unanswerable") {
        // Informational only: show today's behaviour, store no expectation.
        // The scorer is the judge; this is the owner watching it refuse.
        try {
          const thought = await client.think(question, { limit: 6 });
          const refused = thought?.answer == null || REFUSAL_HINT.test(String(thought.answer));
          log(refused
            ? "  Good: the brain refuses this today."
            : "  Careful: the brain ANSWERED this today. The eval will fail here until that confabulation is fixed — which is the point.");
        } catch {
          log("  (could not run the live refusal check; the eval will still test it)");
        }
      } else {
        const evidence = await captureEvidence({ kind: slot.kind, question, client, askFn, log, backlog });
        if (evidence === "skip") {
          skipped++;
          continue;
        }
        if (evidence === "unanswerable") entry.kind = "unanswerable";
        else entry.expect = evidence;
      }

      golden.questions.push(entry);
      // Save after every accepted slot: a crash costs one question, not the
      // twenty minutes the owner just spent.
      writeGoldenPrivate(goldenPath, golden);
      added++;
    }
  }

  if (golden.questions.length) {
    validateGolden(golden, goldenPath);
    writeGoldenPrivate(goldenPath, golden);
  }
  const complete = remainingPlan(golden, plan).length === 0;
  log("");
  log(`  ${golden.questions.length}/${target} questions on file${complete ? " — the set is complete." : `; ${skipped} slot(s) skipped for later.`}`);
  return { added, skipped, total: golden.questions.length, complete, path: goldenPath };
}
