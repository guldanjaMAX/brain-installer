#!/usr/bin/env node
/**
 * brain retrieval eval — does the right document come back, and did that change.
 *
 *   node eval/run.mjs                                  score the configured install
 *   node eval/run.mjs --save baselines/2026-08-16.json record this run as the baseline
 *   node eval/run.mjs --baseline baselines/x.json      score and diff against it
 *   node eval/run.mjs --rerank --graph-boost           measure a retrieval variant
 *
 * Exit code is 1 when a question that used to pass now fails. That is the point
 * of the whole thing: it makes "retrieval eval no worse than the previous
 * release" a gate a script can enforce rather than a sentence in a plan.
 *
 * Works against ANY install. Nothing about James's brain is compiled in: the
 * base URL, the admin key source and the golden set all come from a config file
 * or from flags, and the golden set is per install by construction, since the
 * questions have to name that client's own documents.
 *
 * READ ONLY. Every call is a GET. See brain-client.mjs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { BrainClient } from "./brain-client.mjs";
import {
  scoreQuestion,
  scoreRefusal,
  aggregate,
  dedupeByDocument,
  findRegressions,
  findImprovements,
  documentKeyOf,
  jsonReplacer,
  rankOf,
} from "./scorer.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ config */

const VALUE_FLAGS = new Set(["config", "golden", "base", "limit", "k", "baseline", "save", "repeat"]);
const BOOL_FLAGS = new Set(["rerank", "graph-boost", "no-think", "json", "help"]);

/**
 * Effects this harness cannot resolve.
 *
 * Two runs 29 seconds apart with identical effective configuration differed by
 * 3.8 points of recall@1 AND recall@5, and flipped 8 of 30 questions. Retrieval
 * here is approximate-nearest-neighbour, so it is not deterministic, and until
 * 2026-08-18 nobody had measured the spread. Anything smaller than the measured
 * floor is noise wearing the costume of a result.
 *
 * Run with --repeat N to measure the floor for YOUR install before believing a
 * small win. The default is the value observed on james-ring0.
 */
// There is deliberately no assumed noise floor.
//
// A previous version hardcoded 3.8 points, taken from comparing two runs that
// turned out to be different CONFIGURATIONS rather than repeats. A later
// "measured" 0.0 was read through a 120-second edge cache. Both were artifacts.
//
// The floor is a per-install property and it depends on the configuration: with
// the reranker off this brain is deterministic, and with it on 3 of 4 identical
// requests returned a different ranking. So it is measured with --repeat, per
// install, per config, or it is not claimed at all.
const ASSUMED_NOISE_FLOOR_PTS = null;

/**
 * Unknown flags are a hard error rather than a shrug.
 *
 * A misspelled `--reranker` that silently falls back to the default config
 * produces a real number under a wrong label, and the whole reason this tool
 * exists is to stop retrieval claims resting on that kind of mistake.
 */
function parseArgs(argv) {
  const out = { flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`--${name} needs a value`);
      out.flags[name] = next;
      i++;
    } else if (BOOL_FLAGS.has(name)) {
      out.bools.add(name);
    } else {
      throw new Error(
        `unknown flag --${name}. Run with --help. ` +
          `(A shell that does not word split, such as zsh with an unquoted variable, ` +
          `can also produce this by passing two flags as one argument.)`
      );
    }
  }
  return out;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function abs(p, relativeTo) {
  return isAbsolute(p) ? p : resolve(relativeTo, p);
}

/**
 * Resolve the admin key without ever putting it in a config file, in argv where
 * `ps` can read it, or in the run output.
 *
 * `admin_key_command` is an ARRAY and is executed directly, never through a
 * shell, so a config file cannot smuggle in a command substitution.
 */
const DEFAULT_KEY_ENV = "BRAIN_ADMIN_KEY";

async function resolveAdminKey(cfg) {
  // The environment wins over the key command so a CI run, or an install with no
  // macOS keychain, needs no config edit at all.
  const envName = cfg.admin_key_env || DEFAULT_KEY_ENV;
  if (process.env[envName]) return process.env[envName].trim();
  if (Array.isArray(cfg.admin_key_command) && cfg.admin_key_command.length > 0) {
    const [cmd, ...args] = cfg.admin_key_command;
    const { stdout } = await execFileAsync(cmd, args, { encoding: "utf8" });
    return stdout.trim();
  }
  throw new Error(
    `no admin key available. Set ${envName} in the environment, ` +
      `or give the config an admin_key_command array.`
  );
}

/* -------------------------------------------------------------- the runner */

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function runOne(client, q, opts) {
  if (q.kind === "unanswerable") {
    if (opts.skipThink) {
      return { ...baseFields(q), refusal: null, skipped: "think probe disabled" };
    }
    try {
      const body = await client.think(q.question, { limit: opts.limit });
      return { ...baseFields(q), refusal: scoreRefusal(body) };
    } catch (e) {
      return { ...baseFields(q), refusal: null, error: e.message };
    }
  }

  try {
    const results = await client.retrieve(q.question, opts);
    const raw = scoreQuestion(q, results);
    const byDoc = scoreQuestion(q, dedupeByDocument(results));
    return {
      ...baseFields(q),
      ...raw,
      byDocument: { slots: byDoc.slots, satisfiedAt: byDoc.satisfiedAt },
      returned: results.length,
      distinct: dedupeByDocument(results).length,
      top: results.slice(0, 3).map(documentKeyOf),
    };
  } catch (e) {
    return { ...baseFields(q), scorable: true, satisfiedAt: Infinity, slots: [], error: e.message };
  }
}

function baseFields(q) {
  return { id: q.id, kind: q.kind, question: q.question };
}

/* ------------------------------------------------------------------ report */

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const rank = (r) => (Number.isFinite(r) ? `#${r}` : "miss");

function report(run, regressions, improvements, k) {
  const L = [];
  const { scored, agg, aggByDoc, refusals, variant } = run;

  L.push("");
  L.push(`  brain      ${run.base}`);
  L.push(`  golden     ${run.goldenLabel}  (${agg.n} scored, ${refusals.total} unanswerable)`);
  L.push(`  variant    limit=${variant.limit} rerank=${variant.rerank} graph_boost=${variant.graphBoost}`);
  L.push("");
  L.push(`  RECALL@${k}   ${pct(agg.recall[k])}   <- headline`);
  if (run.noise) {
    const n = run.noise;
    L.push("");
    L.push(`  NOISE FLOOR  measured over ${n.passes} identical passes`);
    L.push(`    recall@1 varied ${n.recall_1.spread_pts.toFixed(1)} pts, recall@${k} varied ${n.recall_k.spread_pts.toFixed(1)} pts`);
    L.push(`    ${n.questions_flipped} of ${n.questions_total} questions landed on a different rank between passes`);
    L.push(`    -> treat any change smaller than ${n.floor_pts.toFixed(1)} points as UNPROVEN.`);
  }
  L.push("");
  L.push(`  recall@1   ${pct(agg.recall[1])}       recall@${k} by document  ${pct(aggByDoc.recall[k])}`);
  L.push(`  MRR        ${agg.mrr.toFixed(3)}       recall@1 by document  ${pct(aggByDoc.recall[1])}`);
  if (refusals.total > 0) {
    L.push(
      `  honest refusal  ${refusals.conclusive === 0 ? "n/a" : pct(refusals.passed / refusals.conclusive)}` +
        `  (${refusals.passed}/${refusals.conclusive} unanswerable questions declined)`
    );
  }
  L.push("");

  const byKind = new Map();
  for (const s of scored) {
    if (!s.scorable) continue;
    const g = byKind.get(s.kind) || { hit: 0, n: 0 };
    g.n++;
    if (s.satisfiedAt <= k) g.hit++;
    byKind.set(s.kind, g);
  }
  L.push("  by question kind");
  for (const [kind, g] of byKind) {
    L.push(`    ${kind.padEnd(10)} ${String(g.hit).padStart(2)}/${g.n}   ${pct(g.hit / g.n)}`);
  }
  L.push("");

  L.push("  per question");
  for (const s of scored) {
    if (s.kind === "unanswerable") {
      const mark = s.refusal ? (s.refusal.pass ? "PASS" : "FAIL") : "SKIP";
      const note = s.refusal ? s.refusal.detail : s.error || s.skipped || "not run";
      L.push(`    ${mark}  ${s.id}  ${trunc(s.question, 58)}`);
      L.push(`          ${note}`);
      continue;
    }
    const hit = s.satisfiedAt <= k;
    L.push(
      `    ${hit ? "PASS" : "FAIL"}  ${s.id}  ${trunc(s.question, 58)}` +
        `  ${rank(s.satisfiedAt)}${s.byDocument && s.byDocument.satisfiedAt !== s.satisfiedAt ? ` (${rank(s.byDocument.satisfiedAt)} by doc)` : ""}`
    );
    if (s.error) L.push(`          error: ${s.error}`);
    else if (!hit) {
      for (const slot of s.slots) {
        L.push(`          ${rank(slot.rank).padEnd(5)} needs: ${trunc(slot.doc, 76)}`);
      }
      if (s.top?.length) L.push(`          got instead: ${s.top.map((t) => trunc(t, 44)).join(", ")}`);
    }
  }
  L.push("");

  if (improvements.length) {
    L.push(`  IMPROVED since baseline (${improvements.length})`);
    for (const r of improvements) L.push(`    ${r.id}  ${r.from} -> ${r.to}  ${trunc(r.question, 54)}`);
    L.push("");
  }
  if (regressions.length) {
    L.push(`  REGRESSIONS since baseline (${regressions.length})`);
    for (const r of regressions) L.push(`    ${r.id}  ${r.from} -> ${r.to}  ${trunc(r.question, 54)}`);
    L.push("");
  } else if (run.baselineLabel) {
    L.push(`  no regressions against ${run.baselineLabel}`);
    L.push("");
  }

  return L.join("\n");
}

function trunc(s, n) {
  s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/* -------------------------------------------------------------------- main */

/**
 * Record WHAT was measured, not just the score.
 *
 * The saved baselines carried no corpus size, no worker version and no commit,
 * so two of them could differ because the code changed, because the corpus grew,
 * or because ANN retrieval simply landed differently, and nothing on disk could
 * tell you which.
 */
async function collectProvenance(client, base) {
  const p = { base, corpus: null, worker: null, git: null };
  try {
    const docs = await client.documents?.();
    if (docs) p.corpus = { documents: docs.documents ?? null, chunks: docs.chunks ?? null, embedded: docs.embedded ?? null,
                           vector_backlog: docs.vector_backlog?.pending ?? null };
  } catch { /* provenance is best effort and must never fail a run */ }
  try {
    const { execFileSync } = await import("node:child_process");
    p.git = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
  } catch { /* not a repo */ }
  return p;
}

async function main() {
  const { flags, bools } = parseArgs(process.argv.slice(2));


  if (bools.has("help")) {
    console.log(
      [
        "usage: node eval/run.mjs [options]",
        "",
        "  --config <path>     config file (default eval/eval.config.json)",
        "  --golden <path>     golden set JSON, overrides the config",
        "  --base <url>        brain base URL, overrides the config",
        "  --limit <n>         results requested per question (default 10)",
        "  --k <n>             the k in the headline recall@k (default 5)",
        "  --rerank            turn the reranker on for this run",
        "  --repeat <n>        run the SAME config n times and report the noise floor.",
        "                      Do this before believing a small win: retrieval is",
        "                      approximate, so identical runs differ.",
        "  --graph-boost       only if the target implements it; probed before use",
        "  --no-think          skip the unanswerable probes (they cost LLM calls)",
        "  --baseline <path>   compare against a saved run",
        "  --save <path>       write this run to disk",
        "  --json              print the raw run object instead of the report",
        "",
        "exit 1 when a question that passed in the baseline now fails.",
      ].join("\n")
    );
    return 0;
  }

  const configPath = abs(flags.config || "eval.config.json", HERE);
  let cfg = {};
  try {
    cfg = await loadJson(configPath);
  } catch (e) {
    if (!flags.base || !flags.golden) {
      throw new Error(
        `could not read ${configPath} (${e.code || e.message}). ` +
          `Pass --base and --golden, or create a config file.`
      );
    }
  }

  const base = flags.base || cfg.base;
  if (!base) throw new Error("no brain base URL. Pass --base or set `base` in the config.");
  if (!flags.golden && !cfg.golden) throw new Error("no golden set. Pass --golden or set `golden`.");

  // A path typed on the command line is relative to where the user is standing.
  // A path written in the config is relative to the config, so a config plus its
  // golden set can be copied to a client repo as one directory.
  const goldenPath = flags.golden
    ? abs(flags.golden, process.cwd())
    : abs(cfg.golden, dirname(configPath));

  const golden = await loadJson(goldenPath);
  validateGolden(golden, goldenPath);

  const k = Number(flags.k || cfg.k || 5);
  const opts = {
    limit: Number(flags.limit || cfg.limit || 10),
    rerank: bools.has("rerank") || cfg.rerank === true,
    graphBoost: bools.has("graph-boost") || cfg.graph_boost === true,
    skipThink: bools.has("no-think"),
  };
  if (opts.limit < k) throw new Error(`--limit ${opts.limit} is below --k ${k}, recall@${k} would be meaningless.`);


  const repeat = Math.max(1, Number(flags.repeat || 1));

  const adminKey = await resolveAdminKey(cfg);
  const client = new BrainClient({ base, adminKey, timeoutMs: Number(cfg.timeout_ms || 30000) });

  // graph_boost is implemented on SOME brains and not others, so whether this
  // flag means anything depends entirely on the target. It was previously
  // refused outright here, on the strength of one worker's source carrying no
  // handler. That was wrong: the worker those saved baselines were measured
  // against DOES implement it, so a real effect was written off as noise.
  //
  // Probe rather than assume. Two identical queries differing only in
  // graph_boost either change the ranking or they do not, and that is the
  // entire question.
  if (opts.graphBoost) {
    const [off, on] = await Promise.all([
      client.retrieve("what did we decide", { limit: 10, rerank: false, graphBoost: false }),
      client.retrieve("what did we decide", { limit: 10, rerank: false, graphBoost: true }),
    ]).catch(() => [null, null]);
    const key = (rs) => (rs || []).map((r) => r.ref_key || r.id).join("|");
    if (off && on && key(off) === key(on)) {
      throw new Error(
        "--graph-boost does nothing on this brain.\n" +
          "  Two identical queries differing only in graph_boost returned the same\n" +
          "  ranking, so this run would measure the DEFAULT configuration and save it\n" +
          "  under another name. Two baselines were created that way once already.\n" +
          "  Drop the flag, or point at a brain that implements it."
      );
    }
    console.error("  graph_boost verified active on this brain: the probe changed the ranking");
  }


  const health = await client.health().catch((e) => ({ status: 0, ok: false, error: e.message }));
  if (!health.ok) {
    // Fail here rather than reporting 0% recall, which would read as a
    // catastrophic retrieval regression instead of an unreachable brain.
    throw new Error(`brain is not reachable at ${base}/health (HTTP ${health.status}). Nothing was scored.`);
  }

  // /health is deliberately unauthenticated, so reaching it proves nothing about
  // the key. Without this probe a wrong key scores every question as a miss and
  // prints a clean, entirely false 0%.
  try {
    await client.retrieve("connectivity probe", { limit: 1 });
  } catch (e) {
    const why = /401/.test(e.message)
      ? "the admin key was rejected"
      : "the retrieval endpoint did not answer";
    throw new Error(
      `the brain is up but ${why} (${e.message}). Nothing was scored, because every ` +
        `question would have failed for the same reason and printed a clean, false 0% recall.`
    );
  }

  const passes = [];
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) console.error(`  pass ${i + 1} of ${repeat}...`);
    passes.push(
      await mapWithConcurrency(golden.questions, Number(cfg.concurrency || 4), (q) => runOne(client, q, opts))
    );
  }
  const scored = passes[0];

  // A transport failure partway through is not a retrieval result. Saying so is
  // the difference between a bad number and no number.
  const errored = scored.filter((s) => s.error).length;
  if (errored > 0 && errored === scored.length) {
    throw new Error(`every question failed in transport. First error: ${scored[0].error}`);
  }
  if (errored > 0) {
    console.error(`  warning: ${errored} of ${scored.length} questions errored and are counted as misses.`);
  }

  const retrieval = scored.filter((s) => s.kind !== "unanswerable");
  const agg = aggregate(retrieval, [1, k]);
  const aggByDoc = aggregate(
    retrieval.map((s) => ({ scorable: s.scorable, satisfiedAt: s.byDocument?.satisfiedAt ?? s.satisfiedAt })),
    [1, k]
  );
  const unanswerable = scored.filter((s) => s.kind === "unanswerable");
  const conclusive = unanswerable.filter((s) => s.refusal && !s.refusal.inconclusive);
  const refusals = {
    total: unanswerable.length,
    conclusive: conclusive.length,
    passed: conclusive.filter((s) => s.refusal.pass).length,
  };

  // What this harness can and cannot resolve, measured rather than assumed.
  let noise = null;
  if (repeat > 1) {
    const aggs = passes.map((p) => {
      const r = p.filter((s) => s.kind !== "unanswerable");
      return aggregate(r, [1, k]);
    });
    const spread = (f) => {
      const xs = aggs.map(f);
      return { min: Math.min(...xs), max: Math.max(...xs), spread_pts: (Math.max(...xs) - Math.min(...xs)) * 100 };
    };
    // How many questions land on a different rank between passes.
    const ranks = passes.map((p) => Object.fromEntries(p.map((q) => [q.id, q.satisfiedAt])));
    let flipped = 0;
    for (const id of Object.keys(ranks[0])) {
      if (ranks.some((r) => r[id] !== ranks[0][id])) flipped++;
    }
    noise = {
      passes: repeat,
      recall_1: spread((a) => a.recall[1]),
      recall_k: spread((a) => a.recall[k]),
      mrr: spread((a) => a.mrr),
      questions_flipped: flipped,
      questions_total: Object.keys(ranks[0]).length,
      floor_pts: Math.max(spread((a) => a.recall[1]).spread_pts, spread((a) => a.recall[k]).spread_pts),
    };
  }

  const run = {
    ran_at: new Date().toISOString(),
    base,
    // Provenance. Without it a baseline is a number with no idea what produced
    // it, and six months later nobody can say whether two are comparable.
    provenance: await collectProvenance(client, base),
    noise,
    goldenLabel: `${golden.install || "unnamed"} (${golden.questions.length} questions)`,
    golden_path: goldenPath,
    variant: { limit: opts.limit, rerank: opts.rerank, graphBoost: opts.graphBoost },
    k,
    agg,
    aggByDoc,
    refusals,
    questions: scored,
    scored,
  };

  let baseline = null;
  if (flags.baseline) {
    baseline = await loadJson(abs(flags.baseline, process.cwd()));
    run.baselineLabel = flags.baseline;
    if (baseline.variant && JSON.stringify(baseline.variant) !== JSON.stringify(run.variant)) {
      console.error(
        `  warning: baseline ran with ${JSON.stringify(baseline.variant)}, this run used ` +
          `${JSON.stringify(run.variant)}. The diff below mixes a config change with a code change.`
      );
    }
  }
  const regressions = findRegressions(run, baseline, k);
  const improvements = findImprovements(run, baseline, k);

  if (bools.has("json")) console.log(JSON.stringify(run, null, 2));
  else console.log(report(run, regressions, improvements, k));

  if (flags.save) {
    const savePath = abs(flags.save, process.cwd());
    await mkdir(dirname(savePath), { recursive: true });
    // jsonReplacer keeps a miss a miss. Plain stringify writes Infinity as null,
    // which reads back as rank 0 and turns every unchanged miss into a phantom
    // regression on the next comparison.
    await writeFile(savePath, JSON.stringify(run, jsonReplacer, 2));
    console.log(`  saved to ${savePath}\n`);
  }

  return regressions.length > 0 ? 1 : 0;
}

function validateGolden(golden, path) {
  if (!Array.isArray(golden.questions) || golden.questions.length === 0) {
    throw new Error(`${path} has no questions array`);
  }
  const ids = new Set();
  for (const q of golden.questions) {
    if (!q.id) throw new Error(`${path}: a question has no id`);
    if (ids.has(q.id)) throw new Error(`${path}: duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.question) throw new Error(`${path}: ${q.id} has no question text`);
    const expect = q.expect || [];
    if (q.kind === "unanswerable") {
      if (expect.length > 0) throw new Error(`${path}: ${q.id} is unanswerable but names expected documents`);
      continue;
    }
    if (expect.length === 0) throw new Error(`${path}: ${q.id} expects nothing and is not marked unanswerable`);
    for (const slot of expect) {
      if (!Array.isArray(slot.any_of) || slot.any_of.length === 0) {
        throw new Error(`${path}: ${q.id} has a slot with no any_of references`);
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n  eval failed: ${e.message}\n`);
    process.exit(2);
  });
