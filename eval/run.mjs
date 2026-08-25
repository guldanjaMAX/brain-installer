#!/usr/bin/env node
/**
 * brain retrieval eval — does the right document come back, and did that change.
 *
 *   node eval/run.mjs                                  score the configured install
 *   node eval/run.mjs --save baselines/2026-08-16.json record this run as the baseline
 *   node eval/run.mjs --baseline baselines/x.json      score and diff against it
 *   node eval/run.mjs --rerank --graph-boost           measure a retrieval variant
 *
 * Exit code is 1 for a regression, a transport error, or a case/suite hard-gate
 * failure in any repeat. That is the point of the whole thing: it makes
 * retrieval safety a gate a script can enforce rather than a sentence in a plan.
 *
 * Works against ANY install. Nothing about an owner's brain is compiled in: the
 * base URL, the admin key source and the golden set all come from a config file
 * or from flags, and the golden set is per install by construction, since the
 * questions have to name that client's own documents.
 *
 * READ ONLY. Retrieval uses private POST bodies; no write route is called. See
 * brain-client.mjs.
 */

import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { basename, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { BrainClient } from "./brain-client.mjs";
import { evaluateProfileCoverage, formatProfileFailures } from "./profile.mjs";
import { localToolEnvironment } from "../doctor.mjs";
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
  retrievalQuality,
  aggregateQuality,
  diagnoseRetrieval,
} from "./scorer.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashLabel = (value) => `sha256:${sha256(value)}`;
const opaqueCaseId = (id) => `case-${sha256(`case:${id}`).slice(0, 24)}`;
const executionNumber = (entry) => Number(entry?.repeat || 1);
const executionToken = (id, repeat = 1) => `${id}\u0000repeat:${repeat}`;
const opaqueExecutionId = (id, repeat = 1) => opaqueCaseId(executionToken(id, repeat));

function assertOwnedNode(stats, label) {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

async function assertRealDirectory(path, label) {
  const stats = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
    throw error;
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a link: ${path}`);
  }
  assertOwnedNode(stats, label);
  return stats;
}

async function createPrivateDirectory(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  await assertRealDirectory(parent, "artifact parent");
  await mkdir(absolute, { mode: 0o700, recursive: false }).catch((error) => {
    if (error.code === "EEXIST") {
      throw new Error(`artifact directory already exists; refusing to overwrite it: ${absolute}`);
    }
    throw error;
  });
  const stats = await assertRealDirectory(absolute, "artifact directory");
  if (process.platform !== "win32") await chmod(absolute, 0o700);
  const canonical = await realpath(absolute);
  const canonicalParent = await realpath(parent);
  if (canonical !== resolve(canonicalParent, basename(absolute))) {
    throw new Error(`artifact directory did not resolve beneath its requested parent: ${absolute}`);
  }
  assertOwnedNode(stats, "artifact directory");
  return absolute;
}

async function writePrivateNewFile(path, content) {
  const absolute = resolve(path);
  await assertRealDirectory(dirname(absolute), "output parent");
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  const handle = await open(absolute, flags, 0o600).catch((error) => {
    if (error.code === "EEXIST" || error.code === "ELOOP") {
      throw new Error(`output already exists or is a link; refusing to overwrite it: ${absolute}`);
    }
    throw error;
  });
  try {
    await handle.writeFile(content);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ config */

const VALUE_FLAGS = new Set(["config", "golden", "base", "profile", "limit", "k", "baseline", "save", "repeat", "artifacts"]);
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
 * small win. The default is one pass and therefore makes no noise-floor claim.
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
const ADMIN_KEY_STDIN_ENV = "BRAIN_ADMIN_KEY_STDIN";
const MAX_ADMIN_KEY_STDIN_BYTES = 4096;

async function readAdminKeyFromStdin(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk)
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk), "utf8");
      total += bytes.length;
      if (total > MAX_ADMIN_KEY_STDIN_BYTES) {
        bytes.fill(0);
        throw new Error("admin key on stdin is unexpectedly large");
      }
      chunks.push(bytes);
    }
    const combined = Buffer.concat(chunks, total);
    try {
      const key = combined.toString("utf8").trim();
      if (!key) throw new Error("admin key on stdin was empty");
      if (/[\0\r\n]/.test(key)) throw new Error("admin key on stdin must be one line");
      return key;
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function resolveAdminKey(cfg) {
  // `brain eval` uses a one-shot stdin pipe so its key is not exposed in argv or
  // process metadata. The environment and command paths remain for people who
  // run this harness directly or from CI.
  if (process.env[ADMIN_KEY_STDIN_ENV] === "1") {
    return readAdminKeyFromStdin();
  }
  const envName = cfg.admin_key_env || DEFAULT_KEY_ENV;
  if (process.env[envName]) return process.env[envName].trim();
  if (Array.isArray(cfg.admin_key_command) && cfg.admin_key_command.length > 0) {
    const [cmd, ...args] = cfg.admin_key_command;
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      env: localToolEnvironment(),
      windowsHide: true,
    });
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
  const started = performance.now();
  if (q.kind === "unanswerable") {
    if (opts.skipThink) {
      return { ...baseFields(q), refusal: null, skipped: "think probe disabled" };
    }
    try {
      const body = await client.think(q.question, { limit: opts.limit });
      return { ...baseFields(q), refusal: scoreRefusal(body), latency_ms: Math.round(performance.now() - started) };
    } catch (e) {
      return { ...baseFields(q), refusal: null, error: e.message, latency_ms: Math.round(performance.now() - started) };
    }
  }

  try {
    const results = await client.retrieve(q.question, opts);
    const raw = scoreQuestion(q, results);
    const byDoc = scoreQuestion(q, dedupeByDocument(results));
    const quality = retrievalQuality(q, results, [1, opts.k, 10]);
    return {
      ...baseFields(q),
      ...raw,
      byDocument: { slots: byDoc.slots, satisfiedAt: byDoc.satisfiedAt },
      quality,
      diagnosis: diagnoseRetrieval(q, raw, opts.k),
      latency_ms: Math.round(performance.now() - started),
      returned: results.length,
      distinct: dedupeByDocument(results).length,
      top: results.slice(0, 3).map(documentKeyOf),
    };
  } catch (e) {
    const failed = scoreQuestion(q, []);
    return {
      ...baseFields(q),
      ...failed,
      quality: retrievalQuality(q, [], [1, opts.k, 10]),
      diagnosis: {
        primary: "TRANSPORT_ERROR",
        confidence: "observed",
        inspect: "brain health, authentication, network path, and retrieval endpoint",
      },
      error: e.message,
      latency_ms: Math.round(performance.now() - started),
    };
  }
}

function baseFields(q) {
  return {
    id: q.id,
    kind: q.kind,
    // `kind` selects the executable evaluation path, so report and slice the
    // same value. A second label must never make an answerable retrieval case
    // look like an exercised refusal case.
    query_kind: q.kind,
    risk: q.risk || "normal",
    domains: Array.isArray(q.domains) ? q.domains : q.domain ? [q.domain] : [],
    formats: Array.isArray(q.formats) ? q.formats : q.format ? [q.format] : [],
    question: q.question,
  };
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function performanceSummary(scored) {
  const values = scored.map((row) => Number(row.latency_ms)).filter(Number.isFinite);
  return { n: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
}

function sliceSummary(scored, k) {
  const dimensions = {
    risk: (row) => [row.risk || "normal"],
    domain: (row) => row.domains?.length ? row.domains : ["unclassified"],
    format: (row) => row.formats?.length ? row.formats : ["unclassified"],
    query_kind: (row) => [row.query_kind || row.kind || "unclassified"],
  };
  return Object.fromEntries(Object.entries(dimensions).map(([dimension, valuesOf]) => {
    const groups = new Map();
    for (const row of scored) {
      if (!row.scorable) continue;
      for (const value of valuesOf(row)) {
        const rows = groups.get(value) || [];
        rows.push(row);
        groups.set(value, rows);
      }
    }
    return [dimension, Object.fromEntries(
      [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([value, rows]) => [value, aggregateQuality(rows, k)]),
    )];
  }));
}

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const xmlEscape = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

function sanitizedCase(entry, k) {
  return {
    case_id: opaqueExecutionId(entry.id, executionNumber(entry)),
    repeat: executionNumber(entry),
    kind: entry.kind,
    risk: entry.risk,
    domains: entry.domains,
    formats: entry.formats,
    query_kind: entry.query_kind,
    status: entry.error
      ? "error"
      : entry.kind === "unanswerable"
        ? entry.refusal?.pass === true ? "pass" : entry.refusal?.inconclusive ? "inconclusive" : "fail"
        : rankOf(entry) <= k ? "pass" : "fail",
    satisfied_at: Number.isFinite(entry.satisfiedAt) ? entry.satisfiedAt : null,
    first_relevant_at: Number.isFinite(entry.firstRelevantAt) ? entry.firstRelevantAt : null,
    latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null,
    returned: Number.isFinite(entry.returned) ? entry.returned : null,
    distinct: Number.isFinite(entry.distinct) ? entry.distinct : null,
    quality: entry.quality?.[k] || null,
    refusal: entry.kind === "unanswerable" && entry.refusal
      ? { pass: entry.refusal.pass, inconclusive: entry.refusal.inconclusive, gaps: entry.refusal.gaps }
      : null,
    diagnosis_code: entry.diagnosis?.primary || null,
  };
}

function sanitizedRunArtifact(run, k) {
  const gateFailures = (run.hard_gate_failures || []).map((failure) => ({
    case_id: opaqueExecutionId(failure.id, failure.pass || 1),
    scope: failure.scope || "case",
    pass: failure.pass,
    reason: failure.reason,
  }));
  return {
    schema_version: 1,
    artifact_kind: "brain-retrieval-eval",
    started_at: run.ran_at,
    completed_at: run.completed_at,
    status: gateFailures.length || run.regression_count ? "fail" : "pass",
    suite: {
      hash: run.provenance.suite_hash,
      cases: run.suite_question_count,
      executions: run.questions.length,
      profile: run.profile,
      profile_coverage: run.profile_coverage,
    },
    target: { hash: run.provenance.target_hash },
    code: {
      git_sha: run.provenance.git?.commit || null,
      dirty: run.provenance.git?.dirty ?? null,
      evaluator_version: 1,
      worker_version: run.provenance.worker?.status === "observed"
        ? run.provenance.worker.version
        : null,
    },
    corpus: run.provenance.corpus,
    configuration: { ...run.variant, k: run.k, repeat: run.repeat },
    metrics: {
      question_pass_at_k: run.agg.recall[k],
      mrr_first_relevant: run.agg.mrr,
      evidence_at_k: run.quality,
      evidence_at_10: run.quality_at_10,
      refusal: run.refusals,
      latency: run.performance,
    },
    slices: run.slices,
    hard_gates: { passed: gateFailures.length === 0, failures: gateFailures },
    regressions: (run.regressions || []).map((entry) =>
      opaqueExecutionId(entry.id, entry.repeat || 1)),
    cases: run.questions.map((entry) => sanitizedCase(entry, k)),
  };
}

async function writeArtifacts(directory, run, k) {
  const privateDirectory = await createPrivateDirectory(directory);
  const artifact = sanitizedRunArtifact(run, k);
  await writePrivateNewFile(
    resolve(privateDirectory, "run.json"),
    JSON.stringify(artifact, jsonReplacer, 2),
  );

  const failuresById = new Map(
    artifact.cases.filter((entry) => entry.status !== "pass").map((entry) => [entry.case_id, entry]),
  );
  for (const failure of artifact.hard_gates.failures) {
    const existing = failuresById.get(failure.case_id) || artifact.cases.find(
      (entry) => entry.case_id === failure.case_id,
    ) || { case_id: failure.case_id, kind: "unknown", risk: "unknown", domains: [], formats: [] };
    failuresById.set(failure.case_id, { ...existing, hard_gate_reason: failure.reason });
  }
  const failures = [...failuresById.values()];
  const failureLines = failures.map((entry) => JSON.stringify({
    case_id: entry.case_id,
    kind: entry.kind,
    risk: entry.risk,
    domains: entry.domains,
    formats: entry.formats,
    diagnosis_code: entry.hard_gate_reason || entry.diagnosis_code || (entry.kind === "unanswerable"
      ? "FALSE_ANSWER"
      : "EVALUATION_FAILURE"),
  }, jsonReplacer));
  await writePrivateNewFile(
    resolve(privateDirectory, "failures.jsonl"),
    failureLines.length ? `${failureLines.join("\n")}\n` : "",
  );

  const coverage = [[
    "dimension", "value", "cases", `slot_recall_at_${k}`, `complete_evidence_at_${k}`,
    `precision_at_${k}`, `ndcg_at_${k}`, `duplicate_waste_at_${k}`,
  ]];
  for (const [dimension, values] of Object.entries(run.slices || {})) {
    for (const [value, metrics] of Object.entries(values || {})) {
      coverage.push([
        dimension, value, metrics.n, metrics.slot_recall, metrics.complete_evidence,
        metrics.precision, metrics.ndcg, metrics.duplicate_waste,
      ]);
    }
  }
  await writePrivateNewFile(
    resolve(privateDirectory, "coverage.csv"),
    `${coverage.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
  );

  const releaseFailureIds = new Set([
    ...artifact.hard_gates.failures.map((entry) => entry.case_id),
    ...artifact.regressions,
  ]);
  const testCases = artifact.cases.map((entry) => {
    const failureCode = failuresById.get(entry.case_id)?.hard_gate_reason ||
      (artifact.regressions.includes(entry.case_id) ? "REGRESSION" : entry.diagnosis_code) ||
      (entry.kind === "unanswerable" ? "FALSE_ANSWER" : "EVALUATION_FAILURE");
    const failure = releaseFailureIds.has(entry.case_id)
      ? `<failure message="${xmlEscape(failureCode)}"/>`
      : "";
    return `  <testcase classname="brain.eval" name="${xmlEscape(entry.case_id)}" time="${(Number(entry.latency_ms || 0) / 1000).toFixed(3)}">${failure}</testcase>`;
  });
  const caseIds = new Set(artifact.cases.map((entry) => entry.case_id));
  const syntheticGateCases = artifact.hard_gates.failures
    .filter((entry) => !caseIds.has(entry.case_id))
    .map((entry) =>
      `  <testcase classname="brain.eval.gate" name="${xmlEscape(entry.case_id)}" time="0.000"><failure message="${xmlEscape(entry.reason)}"/></testcase>`,
    );
  const junit = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="brain.eval" tests="${artifact.cases.length + syntheticGateCases.length}" failures="${releaseFailureIds.size}">`,
    ...testCases,
    ...syntheticGateCases,
    `</testsuite>`,
    "",
  ].join("\n");
  await writePrivateNewFile(resolve(privateDirectory, "junit.xml"), junit);
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
  L.push(`  profile    ${run.profile}${run.profile === "release" ? " (v1 retrieval-suite coverage floor passed)" : " (diagnostic; not certification)"}`);
  L.push(`  variant    limit=${variant.limit} rerank=${variant.rerank} graph_boost=${variant.graphBoost}`);
  L.push("");
  L.push(`  QUESTION PASS@${k}   ${pct(agg.recall[k])}   <- all required evidence found`);
  if (run.noise) {
    const n = run.noise;
    L.push("");
    L.push(`  NOISE FLOOR  measured over ${n.passes} identical passes`);
    L.push(`    question pass@1 varied ${n.recall_1.spread_pts.toFixed(1)} pts, pass@${k} varied ${n.recall_k.spread_pts.toFixed(1)} pts`);
    L.push(`    ${n.questions_flipped} of ${n.questions_total} questions landed on a different rank between passes`);
    L.push(`    -> treat any change smaller than ${n.floor_pts.toFixed(1)} points as UNPROVEN.`);
  }
  L.push("");
  L.push(`  question pass@1   ${pct(agg.recall[1])}       pass@${k} after dedupe  ${pct(aggByDoc.recall[k])}`);
  L.push(`  MRR first relevant ${agg.mrr.toFixed(3)}       pass@1 after dedupe  ${pct(aggByDoc.recall[1])}`);
  L.push(`  slot recall@${k}       ${pct(run.quality.slot_recall)}`);
  L.push(`  complete evidence@${k} ${pct(run.quality.complete_evidence)}`);
  L.push(`  precision@${k}         ${pct(run.quality.precision)}       nDCG@10  ${run.quality_at_10.ndcg.toFixed(3)}`);
  L.push(`  duplicate waste@${k}   ${pct(run.quality.duplicate_waste)}`);
  if (run.performance.p50_ms !== null) {
    L.push(`  latency               p50 ${run.performance.p50_ms}ms   p95 ${run.performance.p95_ms}ms`);
  }
  if (refusals.total > 0) {
    L.push(
      `  honest refusal  ${refusals.conclusive === 0 ? "n/a" : pct(refusals.passed / refusals.conclusive)}` +
        `  (${refusals.passed}/${refusals.conclusive} unanswerable questions declined)`
    );
  }
  L.push("");

  const domainSlices = run.slices?.domain || {};
  if (domainSlices.unclassified?.n === run.quality.n) {
    L.push("  COVERAGE LABELS  none: this suite cannot certify medical, legal, tax, credit, OCR, or other slices yet");
    L.push("");
  }

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
    const repeatLabel = run.repeat > 1 ? `  pass ${executionNumber(s)}` : "";
    if (s.kind === "unanswerable") {
      const mark = s.refusal ? (s.refusal.pass ? "PASS" : "FAIL") : "SKIP";
      const note = s.refusal ? s.refusal.detail : s.error || s.skipped || "not run";
      L.push(`    ${mark}  ${s.id}${repeatLabel}  ${trunc(s.question, 58)}`);
      L.push(`          ${note}`);
      continue;
    }
    const hit = s.satisfiedAt <= k;
    L.push(
      `    ${hit ? "PASS" : "FAIL"}  ${s.id}${repeatLabel}  ${trunc(s.question, 58)}` +
        `  ${rank(s.satisfiedAt)}${s.byDocument && s.byDocument.satisfiedAt !== s.satisfiedAt ? ` (${rank(s.byDocument.satisfiedAt)} by doc)` : ""}`
    );
    if (s.error) L.push(`          error: ${s.error}`);
    else if (!hit) {
      for (const slot of s.slots) {
        L.push(`          ${rank(slot.rank).padEnd(5)} needs: ${trunc(slot.doc, 76)}`);
      }
      if (s.top?.length) L.push(`          got instead: ${s.top.map((t) => trunc(t, 44)).join(", ")}`);
      if (s.diagnosis) L.push(`          inspect: ${s.diagnosis.inspect}`);
    }
  }
  L.push("");

  if (improvements.length) {
    L.push(`  IMPROVED since baseline (${improvements.length})`);
    for (const r of improvements) {
      const repeatLabel = run.repeat > 1 ? ` pass ${r.repeat || 1}` : "";
      L.push(`    ${r.id}${repeatLabel}  ${r.from} -> ${r.to}  ${trunc(r.question, 54)}`);
    }
    L.push("");
  }
  if (regressions.length) {
    L.push(`  REGRESSIONS since baseline (${regressions.length})`);
    for (const r of regressions) {
      const repeatLabel = run.repeat > 1 ? ` pass ${r.repeat || 1}` : "";
      L.push(`    ${r.id}${repeatLabel}  ${r.from} -> ${r.to}  ${trunc(r.question, 54)}`);
    }
    L.push("");
  } else if (run.baselineLabel) {
    L.push(`  no regressions against ${run.baselineLabel}`);
    L.push("");
  }

  if (run.hard_gate_failures?.length) {
    L.push(`  HARD GATE FAILURES (${run.hard_gate_failures.length})`);
    for (const failure of run.hard_gate_failures) {
      L.push(`    pass ${failure.pass}  ${failure.id}  ${failure.reason}`);
    }
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
function nonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a timestamp`);
  return new Date(milliseconds).toISOString();
}

function canonicalInventory(docs) {
  if (!Array.isArray(docs?.rows)) throw new Error("inventory response has no rows array");
  const rows = docs.rows.map((row, index) => {
    const sourceType = row?.source_type ?? row?.source ?? row?.kind;
    if (typeof sourceType !== "string" || !sourceType.trim()) {
      throw new Error(`row ${index} has no source label`);
    }
    const normalized = {
      source_type: sourceType.trim(),
      documents: nonNegativeInteger(row?.documents ?? row?.logical_documents, `row ${index} documents`),
      chunks: nonNegativeInteger(row?.chunks ?? row?.total, `row ${index} chunks`),
      embedded: nonNegativeInteger(row?.embedded, `row ${index} embedded`),
      last_ingested: canonicalTimestamp(
        row?.last_ingested ?? row?.last_ingest_at,
        `row ${index} last_ingested`,
      ),
    };
    if (normalized.embedded > normalized.chunks) {
      throw new Error(`row ${index} embeds more chunks than it contains`);
    }
    if (normalized.documents > 0 && normalized.last_ingested === null) {
      throw new Error(`row ${index} has documents but no content-version timestamp`);
    }
    return normalized;
  }).sort((a, b) => a.source_type.localeCompare(b.source_type));
  if (new Set(rows.map((row) => row.source_type)).size !== rows.length) {
    throw new Error("inventory contains duplicate source labels");
  }
  const pending = nonNegativeInteger(docs?.vector_backlog?.pending, "vector backlog pending");
  return { rows, pending };
}

const CORPUS_PAGE_LIMIT = 1000;
const CORPUS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function authenticatedCorpusGet(client, path) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(client.timeoutMs || 30000));
    try {
      const response = await client.fetch(`${client.base}${path}`, {
        headers: { "X-Admin-Key": client.key, "User-Agent": CORPUS_USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = new Error(`corpus inventory endpoint returned HTTP ${response.status}`);
        if (response.status !== 429 && response.status < 500) throw lastError;
      } else {
        try {
          return await response.json();
        } catch {
          throw new Error("corpus inventory endpoint did not return JSON");
        }
      }
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("corpus inventory endpoint failed");
}

async function fingerprintSourceFamilies(client, row) {
  const source = row.source_type;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) {
    throw new Error("inventory source label cannot be paged safely");
  }
  const hasher = createHash("sha256");
  let cursor = "";
  let count = 0;
  let previousFamily = "";
  const seenCursors = new Set();

  while (true) {
    const query = new URLSearchParams({ source, limit: String(CORPUS_PAGE_LIMIT) });
    if (cursor) query.set("cursor", cursor);
    query.set("_cb", `${Date.now()}-${count}`);
    const body = await authenticatedCorpusGet(client, `/api/admin/brain/source-families?${query}`);
    if (body?.source !== source || !Array.isArray(body?.families)) {
      throw new Error("source-family inventory response is malformed");
    }
    if (body.families.length > CORPUS_PAGE_LIMIT) {
      throw new Error("source-family inventory page exceeded its requested limit");
    }
    for (const family of body.families) {
      if (typeof family !== "string" || !family.startsWith(`${source}:`)) {
        throw new Error("source-family inventory contains an invalid family identity");
      }
      if (previousFamily && family <= previousFamily) {
        throw new Error("source-family inventory is not strictly ordered and unique");
      }
      previousFamily = family;
      const bytes = Buffer.from(family, "utf8");
      hasher.update(String(bytes.length));
      hasher.update(":");
      hasher.update(bytes);
      hasher.update("\n");
      count++;
      if (count > row.documents) {
        throw new Error("source-family inventory exceeded the declared document count");
      }
    }
    const next = body.next_cursor;
    if (next === null || next === undefined || next === "") break;
    if (typeof next !== "string" || next !== body.families.at(-1) || seenCursors.has(next)) {
      throw new Error("source-family inventory cursor is malformed or repeated");
    }
    seenCursors.add(next);
    cursor = next;
  }
  if (count !== row.documents) {
    throw new Error("source-family inventory count does not match the corpus summary");
  }
  return { source_type: source, families: count, family_hash: `sha256:${hasher.digest("hex")}` };
}

async function collectCorpusSnapshot(client) {
  try {
    const inventory = canonicalInventory(await client.documents());
    const familyFingerprints = [];
    for (const row of inventory.rows) {
      familyFingerprints.push(await fingerprintSourceFamilies(client, row));
    }
    const sum = (field) => inventory.rows.reduce((total, row) => total + row[field], 0);
    const fingerprintMaterial = { inventory, family_fingerprints: familyFingerprints };
    return {
      status: "observed",
      documents: sum("documents"),
      chunks: sum("chunks"),
      embedded: sum("embedded"),
      vector_backlog: inventory.pending,
      sources: inventory.rows.length,
      snapshot_hash: hashLabel(JSON.stringify(fingerprintMaterial)),
      fingerprint_basis: "logical-family-identities-source-versions-and-index-state",
    };
  } catch {
    return { status: "not_observable", reason: "CONTENT_FINGERPRINT_UNAVAILABLE" };
  }
}

function closeCorpusBracket(before, after) {
  if (before.status === "observed" && after.status === "observed") {
    if (before.snapshot_hash !== after.snapshot_hash) {
      throw new Error(
        "the corpus changed while evaluation was running. No score or baseline is comparable; rerun after ingest and vector drain are stable.",
      );
    }
    return { ...before, bracketed: true };
  }
  if (before.status !== after.status || before.reason !== after.reason) {
    throw new Error("the corpus fingerprint became unavailable while evaluation was running");
  }
  return { ...before, bracketed: false };
}

function canonicalTarget(base) {
  const url = new URL(String(base));
  url.hash = "";
  url.search = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

async function collectProvenance(client, base, suiteBytes, corpus) {
  const p = {
    suite_hash: hashLabel(suiteBytes),
    target_hash: hashLabel(canonicalTarget(base)),
    corpus,
    worker: { status: "not_observable", reason: "WORKER_HEALTH_UNAVAILABLE" },
    git: null,
  };
  try {
    const health = await client.health();
    p.worker = health.ok && health.version
      ? { status: "observed", version: health.version }
      : { status: "not_observable", reason: "WORKER_VERSION_UNAVAILABLE" };
  } catch { /* provenance is best effort and must never fail a run */ }
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: resolve(HERE, ".."),
        encoding: "utf8",
        env: localToolEnvironment(),
        windowsHide: true,
      }),
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: resolve(HERE, ".."),
        encoding: "utf8",
        env: localToolEnvironment(),
        windowsHide: true,
      }),
    ]);
    p.git = { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch { /* not a repo */ }
  return p;
}

function hardGateFailures(passes, k, profile = "smoke") {
  const failures = [];
  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const failuresBeforePass = failures.length;
    let successfulCases = 0;
    let answerableCases = 0;
    let successfulAnswerableCases = 0;
    for (const entry of passes[passIndex]) {
      const pass = passIndex + 1;
      if (entry.kind !== "unanswerable") {
        answerableCases++;
        if (!entry.error && entry.quality?.[k]?.complete_evidence === true) {
          successfulAnswerableCases++;
          successfulCases++;
        }
      } else if (!entry.error && entry.refusal?.pass === true) {
        successfulCases++;
      }
      if (entry.error) {
        failures.push({ id: entry.id, scope: "case", pass, reason: "TRANSPORT_ERROR" });
        continue;
      }
      // The release profile requires an unanswerable slice. Every case in that
      // required slice must therefore exercise and pass the refusal path,
      // regardless of its risk label. Smoke preserves the existing behavior in
      // which only critical case failures block the process.
      if (entry.risk !== "critical" && !(profile === "release" && entry.kind === "unanswerable")) continue;
      if (entry.kind === "unanswerable") {
        if (entry.skipped) failures.push({ id: entry.id, scope: "case", pass, reason: "UNANSWERABLE_PROBE_SKIPPED" });
        else if (!entry.refusal || entry.refusal.inconclusive) {
          failures.push({ id: entry.id, scope: "case", pass, reason: "UNANSWERABLE_RESULT_INCONCLUSIVE" });
        } else if (entry.refusal.pass !== true) {
          failures.push({ id: entry.id, scope: "case", pass, reason: "FALSE_ANSWER" });
        }
      } else if (entry.quality?.[k]?.complete_evidence !== true) {
        failures.push({ id: entry.id, scope: "case", pass, reason: `INCOMPLETE_EVIDENCE_AT_${k}` });
      }
    }
    // Individual normal/high misses remain diagnostics. A pass with answerable
    // cases but zero retrieval success is not usable and can never be green.
    if (answerableCases > 0 && successfulAnswerableCases === 0 && failures.length === failuresBeforePass) {
      failures.push({
        id: "__suite__",
        scope: "suite",
        pass: passIndex + 1,
        reason: `NO_ANSWERABLE_CASES_PASSED_AT_${k}`,
      });
    } else if (successfulCases === 0 && failures.length === failuresBeforePass) {
      failures.push({
        id: "__suite__",
        scope: "suite",
        pass: passIndex + 1,
        reason: "NO_SUCCESSFUL_CASES",
      });
    }
  }
  return failures;
}

function assertBaselineCompatible(run, baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("baseline is not a saved evaluation run");
  }
  if (baseline.artifact_kind || !Array.isArray(baseline.questions)) {
    throw new Error(
      "baseline must be a private run saved with --save; sanitized --artifacts output cannot be used as a baseline",
    );
  }
  const baselineExecutions = baseline.questions.map((entry) => ({
    id: entry?.id,
    repeat: Number(entry?.repeat || 1),
  }));
  if (baselineExecutions.some(({ id, repeat }) =>
    typeof id !== "string" || !id || !Number.isInteger(repeat) || repeat < 1)) {
    throw new Error("baseline question executions are malformed");
  }
  if (baseline.baseline_format_version >= 2 && baseline.questions.some((entry) => entry?.repeat === undefined)) {
    throw new Error("baseline v2 question executions must name their repeat");
  }
  if (baseline.baseline_format_version === 1 && Number(baseline.repeat || 1) > 1) {
    throw new Error("baseline v1 discarded repeated executions; save a new baseline before comparing repeats");
  }
  const executionKeys = baselineExecutions.map(({ id, repeat }) => executionToken(id, repeat));
  if (new Set(executionKeys).size !== executionKeys.length) {
    throw new Error("baseline contains duplicate question executions");
  }
  if (baseline.baseline_format_version >= 2) {
    const currentExecutionKeys = new Set(
      (run.questions || []).map((entry) => executionToken(entry.id, executionNumber(entry))),
    );
    if (executionKeys.length !== currentExecutionKeys.size ||
        executionKeys.some((key) => !currentExecutionKeys.has(key))) {
      throw new Error("baseline v2 does not contain the same complete set of repeated executions");
    }
  }
  const mismatches = [];
  if (baseline.variant && ["limit", "rerank", "graphBoost"].some(
    (field) => baseline.variant[field] !== run.variant[field],
  )) {
    mismatches.push("retrieval variant");
  }
  if (baseline.k !== undefined && Number(baseline.k) !== Number(run.k)) mismatches.push("k cutoff");
  if (baseline.repeat !== undefined && Number(baseline.repeat) !== Number(run.repeat)) mismatches.push("repeat count");
  if ((baseline.profile || "smoke") !== run.profile) mismatches.push("evaluation profile");
  const pairs = [
    ["suite", baseline.provenance?.suite_hash, run.provenance?.suite_hash],
    ["target", baseline.provenance?.target_hash, run.provenance?.target_hash],
    ["corpus snapshot", baseline.provenance?.corpus?.snapshot_hash, run.provenance?.corpus?.snapshot_hash],
    [
      "corpus fingerprint basis",
      baseline.provenance?.corpus?.fingerprint_basis,
      run.provenance?.corpus?.fingerprint_basis,
    ],
  ];
  for (const [label, before, after] of pairs) {
    if (before && after && before !== after) mismatches.push(label);
  }
  if (mismatches.length) {
    throw new Error(`baseline is not comparable: ${mismatches.join(", ")} changed`);
  }
  if (baseline.provenance?.corpus?.bracketed !== true || run.provenance?.corpus?.bracketed !== true) {
    throw new Error("baseline is not comparable because both corpus fingerprints must bracket their runs");
  }
  const missing = pairs.filter(([, before, after]) => !before || !after).map(([label]) => label);
  if (baseline.baseline_format_version >= 1 && missing.length) {
    throw new Error(`baseline is not comparable because ${missing.join(", ")} is not observable`);
  }
  if (missing.length) {
    console.error(`  warning: legacy baseline comparison cannot verify ${missing.join(", ")}`);
  }
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
        "  --profile <name>    smoke (default) or release suite-coverage gate",
        "  --limit <n>         results requested per question (default/minimum 10 for nDCG@10)",
        "  --k <n>             evidence cutoff for question pass and quality metrics (default 5)",
        "  --rerank            turn the reranker on for this run",
        "  --repeat <n>        run the SAME config n times and report the noise floor.",
        "                      Do this before believing a small win: retrieval is",
        "                      approximate, so identical runs differ.",
        "  --graph-boost       only if the target implements it; probed before use",
        "  --no-think          skip unanswerable probes in smoke only; release refuses this flag",
        "  --baseline <path>   compare against a saved run",
        "  --save <path>       write this run to disk",
        "  --artifacts <dir>   write run.json, failures.jsonl, coverage.csv and junit.xml",
        "  --json              print the raw run object instead of the report",
        "",
        "exit 1 on a regression, any transport error, or any case/suite hard-gate failure.",
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

  const goldenBytes = await readFile(goldenPath);
  const golden = JSON.parse(goldenBytes.toString("utf8"));
  validateGolden(golden, goldenPath);
  const profile = String(flags.profile || cfg.profile || "smoke").trim().toLowerCase();
  const profileCoverage = evaluateProfileCoverage(golden, profile);
  if (profileCoverage.failures.length > 0) {
    throw new Error(formatProfileFailures(profileCoverage));
  }
  if (profile === "release" && bools.has("no-think")) {
    throw new Error(
      "--no-think cannot be used with the release profile because every required unanswerable case must run",
    );
  }

  const k = Number(flags.k || cfg.k || 5);
  const opts = {
    limit: Number(flags.limit || cfg.limit || 10),
    rerank: bools.has("rerank") || cfg.rerank === true,
    graphBoost: bools.has("graph-boost") || cfg.graph_boost === true,
    skipThink: bools.has("no-think"),
    k,
  };
  if (!Number.isInteger(k) || k < 1) throw new Error("--k must be a positive integer");
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer");
  if (opts.limit < k) throw new Error(`--limit ${opts.limit} is below --k ${k}, evidence@${k} would be meaningless.`);
  if (opts.limit < 10) {
    throw new Error(`--limit ${opts.limit} is below 10, so nDCG@10 would not retrieve ten ranked positions.`);
  }

  const repeat = Number(flags.repeat || 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
    throw new Error("--repeat must be an integer from 1 through 100");
  }

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

  // The same document and index state must surround the measured calls. Counts
  // alone are insufficient: a file can be replaced without changing a count.
  const runStartedAt = new Date().toISOString();
  const corpusBefore = await collectCorpusSnapshot(client);
  const passes = [];
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) console.error(`  pass ${i + 1} of ${repeat}...`);
    const passRows = await mapWithConcurrency(
      golden.questions,
      Number(cfg.concurrency || 4),
      (q) => runOne(client, q, opts),
    );
    passes.push(passRows.map((entry) => ({ ...entry, repeat: i + 1 })));
  }
  const corpus = closeCorpusBracket(corpusBefore, await collectCorpusSnapshot(client));
  if (flags.save && corpus.status !== "observed") {
    throw new Error("cannot save a baseline because a bracketed corpus content fingerprint is not observable");
  }
  // Repeats are test executions, not merely a source for a noise annotation.
  // Every execution contributes to metrics, saved baselines, artifacts and
  // regression comparison.
  const scored = passes.flat();

  // A transport failure partway through is not a retrieval result. Saying so is
  // the difference between a bad number and no number. Every repeat matters.
  const errored = scored.filter((s) => s.error).length;
  if (errored > 0 && errored === scored.length) {
    throw new Error(`every request failed in transport. First error: ${scored[0].error}`);
  }
  if (errored > 0) {
    console.error(`  warning: ${errored} of ${scored.length} requests errored; the run cannot pass.`);
  }

  const retrieval = scored.filter((s) => s.kind !== "unanswerable");
  const agg = aggregate(retrieval, [1, k]);
  const quality = aggregateQuality(retrieval, k);
  const qualityAt10 = aggregateQuality(retrieval, 10);
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
    baseline_format_version: 2,
    ran_at: runStartedAt,
    completed_at: null,
    base,
    // Provenance. Without it a baseline is a number with no idea what produced
    // it, and six months later nobody can say whether two are comparable.
    provenance: await collectProvenance(client, base, goldenBytes, corpus),
    noise,
    goldenLabel: `${golden.install || "unnamed"} (${golden.questions.length} questions)`,
    suite_question_count: golden.questions.length,
    golden_path: goldenPath,
    profile,
    profile_coverage: profileCoverage,
    variant: { limit: opts.limit, rerank: opts.rerank, graphBoost: opts.graphBoost },
    k,
    repeat,
    agg,
    aggByDoc,
    quality,
    quality_at_10: qualityAt10,
    slices: sliceSummary(retrieval, k),
    performance: performanceSummary(scored),
    refusals,
    questions: scored,
    scored,
  };

  let baseline = null;
  if (flags.baseline) {
    baseline = await loadJson(abs(flags.baseline, process.cwd()));
    run.baselineLabel = flags.baseline;
    assertBaselineCompatible(run, baseline);
  }
  const regressions = findRegressions(run, baseline, k);
  const improvements = findImprovements(run, baseline, k);
  run.regression_count = regressions.length;
  run.regressions = regressions.map((entry) => ({ id: entry.id, repeat: entry.repeat || 1 }));
  run.hard_gate_failures = hardGateFailures(passes, k, profile);
  run.completed_at = new Date().toISOString();

  if (bools.has("json")) console.log(JSON.stringify(run, null, 2));
  else console.log(report(run, regressions, improvements, k));

  if (flags.save) {
    const savePath = abs(flags.save, process.cwd());
    // jsonReplacer keeps a miss a miss. Plain stringify writes Infinity as null,
    // which reads back as rank 0 and turns every unchanged miss into a phantom
    // regression on the next comparison.
    await writePrivateNewFile(savePath, JSON.stringify(run, jsonReplacer, 2));
    console.log(`  saved to ${savePath}\n`);
  }

  if (flags.artifacts) {
    const artifactPath = abs(flags.artifacts, process.cwd());
    await writeArtifacts(artifactPath, run, k);
    console.log(`  artifacts written to ${artifactPath}\n`);
  }

  return regressions.length > 0 || run.hard_gate_failures.length > 0 ? 1 : 0;
}

function validateGolden(golden, path) {
  const schemaVersion = Number(golden.schema_version ?? 1);
  if (schemaVersion !== 1) {
    throw new Error(
      `${path} uses evaluation schema v${schemaVersion}. This runner currently executes the v1 ` +
      `question format; v2 contracts are documented in docs/EVALUATION.md but are not yet an execution claim.`,
    );
  }
  if (!Array.isArray(golden.questions) || golden.questions.length === 0) {
    throw new Error(`${path} has no questions array`);
  }
  const ids = new Set();
  for (const q of golden.questions) {
    if (!q.id) throw new Error(`${path}: a question has no id`);
    if (ids.has(q.id)) throw new Error(`${path}: duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.question) throw new Error(`${path}: ${q.id} has no question text`);
    if (q.risk !== undefined && !new Set(["critical", "high", "normal"]).has(q.risk)) {
      throw new Error(`${path}: ${q.id} risk must be critical, high, or normal`);
    }
    for (const field of ["domains", "formats"]) {
      if (q[field] === undefined) continue;
      if (!Array.isArray(q[field]) || q[field].length === 0 ||
          q[field].some((value) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value)))) {
        throw new Error(`${path}: ${q.id} ${field} must be non-empty lowercase labels`);
      }
    }
    const expect = q.expect || [];
    if (q.kind === "unanswerable") {
      if (expect.length > 0) throw new Error(`${path}: ${q.id} is unanswerable but names expected documents`);
      continue;
    }
    if (expect.length === 0) throw new Error(`${path}: ${q.id} expects nothing and is not marked unanswerable`);
    const sharedGroups = new Map();
    for (const slot of expect) {
      const hasReferences = Array.isArray(slot.any_of) && slot.any_of.length > 0;
      if (!hasReferences && !String(slot.doc || "").trim()) {
        throw new Error(`${path}: ${q.id} has a slot with neither a document title nor any_of references`);
      }
      if (hasReferences && slot.any_of.some((value) => !/^[a-z0-9][a-z0-9_-]{0,63}:.+/.test(String(value)))) {
        throw new Error(`${path}: ${q.id} any_of references must include their source prefix, such as drive: or curated:`);
      }
      if (!hasReferences && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(slot.source || ""))) {
        throw new Error(`${path}: ${q.id} title-only evidence must name its source`);
      }
      if (slot.shared_result_group !== undefined) {
        const group = String(slot.shared_result_group);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(group)) {
          throw new Error(`${path}: ${q.id} shared_result_group must be a lowercase label`);
        }
        sharedGroups.set(group, (sharedGroups.get(group) || 0) + 1);
      }
    }
    for (const [group, count] of sharedGroups) {
      if (count < 2) {
        throw new Error(`${path}: ${q.id} shared_result_group ${group} must be used by at least two slots`);
      }
    }
  }
}

main()
  // Let fetch/undici close its handles before Node returns the verdict. A
  // forced process.exit can race libuv handle cleanup on Windows and turn a
  // deliberate eval failure into the native UV_HANDLE_CLOSING crash code.
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`\n  eval failed: ${e.message}\n`);
    process.exitCode = 2;
  });
