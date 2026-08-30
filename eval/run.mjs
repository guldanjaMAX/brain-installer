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
import { validateGolden } from "./golden-validation.mjs";
import { evaluateProfileCoverage, formatProfileFailures } from "./profile.mjs";
import {
  corpusCompletenessHardGates,
  corpusContractReadiness,
  corpusReconciliationUnavailable,
  createCorpusReconciliationCollector,
  formatCorpusReadinessFailure,
  loadCorpusContract,
} from "./corpus-contract.mjs";
import { localToolEnvironment } from "../doctor.mjs";
import {
  scoreQuestion,
  scoreRefusal,
  scoreDeterministicAnswer,
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

const VALUE_FLAGS = new Set([
  "config", "golden", "base", "profile", "limit", "k", "baseline", "save",
  "repeat", "artifacts", "corpus-contract", "installation-ref",
]);
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

  const retrievalStarted = performance.now();
  let row;
  try {
    const results = await client.retrieve(q.question, opts);
    const raw = scoreQuestion(q, results);
    const byDoc = scoreQuestion(q, dedupeByDocument(results));
    const quality = retrievalQuality(q, results, [1, opts.k, 10]);
    row = {
      ...baseFields(q),
      ...raw,
      byDocument: { slots: byDoc.slots, satisfiedAt: byDoc.satisfiedAt },
      quality,
      diagnosis: diagnoseRetrieval(q, raw, opts.k),
      retrieval_latency_ms: Math.round(performance.now() - retrievalStarted),
      returned: results.length,
      distinct: dedupeByDocument(results).length,
      top: results.slice(0, 3).map(documentKeyOf),
    };
  } catch (e) {
    const failed = scoreQuestion(q, []);
    row = {
      ...baseFields(q),
      ...failed,
      quality: retrievalQuality(q, [], [1, opts.k, 10]),
      diagnosis: {
        primary: "TRANSPORT_ERROR",
        confidence: "observed",
        inspect: "brain health, authentication, network path, and retrieval endpoint",
      },
      error: e.message,
      retrieval_latency_ms: Math.round(performance.now() - retrievalStarted),
    };
  }

  // Old v1 suites remain retrieval-only. `/think` is called for an answerable
  // case only when that case opts into the deterministic answer contract, so
  // existing cost, latency, and baseline behavior do not change silently.
  if (!q.answer_expect) {
    return { ...row, latency_ms: Math.round(performance.now() - started) };
  }
  if (opts.skipThink) {
    return {
      ...row,
      answer: null,
      answer_required_claims: q.answer_expect.claims.length,
      answer_skipped: "think probe disabled",
      latency_ms: Math.round(performance.now() - started),
    };
  }

  const answerStarted = performance.now();
  try {
    const body = await client.think(q.question, { limit: opts.limit });
    return {
      ...row,
      answer: scoreDeterministicAnswer(q, body),
      answer_required_claims: q.answer_expect.claims.length,
      answer_latency_ms: Math.round(performance.now() - answerStarted),
      latency_ms: Math.round(performance.now() - started),
    };
  } catch (e) {
    return {
      ...row,
      answer: null,
      answer_required_claims: q.answer_expect.claims.length,
      answer_error: e.message,
      answer_latency_ms: Math.round(performance.now() - answerStarted),
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

function answerPerformanceSummary(scored) {
  const values = scored.map((row) => Number(row.answer_latency_ms)).filter(Number.isFinite);
  return { n: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
}

function deterministicAnswerSummary(scored) {
  const rows = scored.filter((row) => Object.hasOwn(row, "answer"));
  const conclusive = rows.filter((row) => row.answer && !row.answer.inconclusive);
  const sum = (field) => rows.reduce((total, row) => total + Number(
    field === "required_claims"
      ? row.answer?.required_claims ?? row.answer_required_claims ?? 0
      : row.answer?.[field] || 0,
  ), 0);
  return {
    total: rows.length,
    conclusive: conclusive.length,
    passed: rows.filter((row) => row.answer?.pass === true).length,
    required_claims: sum("required_claims"),
    matched_claims: sum("matched_claims"),
    cited_claims: sum("cited_claims"),
    resolved_claims: sum("resolved_claims"),
  };
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
  const hasAnswerCheck = Object.hasOwn(entry, "answer");
  return {
    case_id: opaqueExecutionId(entry.id, executionNumber(entry)),
    repeat: executionNumber(entry),
    kind: entry.kind,
    risk: entry.risk,
    domains: entry.domains,
    formats: entry.formats,
    query_kind: entry.query_kind,
    status: entry.error || entry.answer_error
      ? "error"
      : entry.kind === "unanswerable"
        ? entry.refusal?.pass === true ? "pass" : entry.refusal?.inconclusive ? "inconclusive" : "fail"
        : rankOf(entry) > k
          ? "fail"
          : hasAnswerCheck
            ? entry.answer?.pass === true ? "pass" : entry.answer?.inconclusive || entry.answer_skipped ? "inconclusive" : "fail"
            : "pass",
    satisfied_at: Number.isFinite(entry.satisfiedAt) ? entry.satisfiedAt : null,
    first_relevant_at: Number.isFinite(entry.firstRelevantAt) ? entry.firstRelevantAt : null,
    latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null,
    returned: Number.isFinite(entry.returned) ? entry.returned : null,
    distinct: Number.isFinite(entry.distinct) ? entry.distinct : null,
    quality: entry.quality?.[k] || null,
    refusal: entry.kind === "unanswerable" && entry.refusal
      ? { pass: entry.refusal.pass, inconclusive: entry.refusal.inconclusive, gaps: entry.refusal.gaps }
      : null,
    deterministic_answer: hasAnswerCheck
      ? entry.answer
        ? {
            pass: entry.answer.pass,
            inconclusive: entry.answer.inconclusive,
            claim_boundary: entry.answer.claim_boundary,
            required_claims: entry.answer.required_claims,
            matched_claims: entry.answer.matched_claims,
            cited_claims: entry.answer.cited_claims,
            resolved_claims: entry.answer.resolved_claims,
            failure_codes: entry.answer.failures,
          }
        : {
            pass: false,
            inconclusive: true,
            claim_boundary: "sentence",
            required_claims: entry.answer_required_claims,
            matched_claims: null,
            cited_claims: null,
            resolved_claims: null,
            failure_codes: [entry.answer_error ? "ANSWER_TRANSPORT_ERROR" : "ANSWER_PROBE_SKIPPED"],
          }
      : null,
    diagnosis_code: entry.diagnosis?.primary || null,
  };
}

function sanitizedCorpusCompleteness(result) {
  if (!result) return null;
  const numeric = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const slices = {};
  for (const [dimension, values] of Object.entries(result.slices || {})) {
    slices[dimension] = {};
    for (const [label, row] of Object.entries(values || {})) {
      slices[dimension][label] = {
        expected: numeric(row.expected),
        indexed: numeric(row.indexed),
        accounted: numeric(row.accounted),
        missing: numeric(row.missing),
        policy_leaks: numeric(row.policy_leaks),
        pass: row.pass === true,
      };
    }
  }
  return {
    schema_version: 1,
    status: ["pass", "fail", "not_observable"].includes(result.status)
      ? result.status
      : "not_observable",
    claim_boundary: "logical-source-family-presence-and-policy-absence",
    contract_hash: /^sha256:[a-f0-9]{64}$/.test(result.contract_hash || "")
      ? result.contract_hash
      : null,
    inventory_hash: /^sha256:[a-f0-9]{64}$/.test(result.inventory_hash || "")
      ? result.inventory_hash
      : null,
    totals: Object.fromEntries([
      "expected", "observed", "indexed_expected", "accounted", "missing",
      "policy_leaks", "unknown",
    ].map((field) => [field, numeric(result.totals?.[field])])),
    slices,
    failures: (result.failures || []).map((failure) => ({
      stage: String(failure.stage || "source_inventory"),
      code: String(failure.code || "SOURCE_INVENTORY_NOT_OBSERVABLE"),
      count: numeric(failure.count),
    })),
    content_version: {
      status: "not_observable",
      reason: "CONTENT_HASH_OBSERVATION_UNAVAILABLE",
    },
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
    ...(run.corpus_completeness
      ? { corpus_completeness: sanitizedCorpusCompleteness(run.corpus_completeness) }
      : {}),
    configuration: { ...run.variant, k: run.k, repeat: run.repeat },
    metrics: {
      question_pass_at_k: run.agg.recall[k],
      mrr_first_relevant: run.agg.mrr,
      evidence_at_k: run.quality,
      evidence_at_10: run.quality_at_10,
      refusal: run.refusals,
      deterministic_answer: run.deterministic_answers,
      latency: run.performance,
      answer_latency: run.answer_performance,
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
    diagnosis_code: entry.hard_gate_reason || entry.deterministic_answer?.failure_codes?.[0] ||
      entry.diagnosis_code || (entry.kind === "unanswerable"
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

  if (artifact.corpus_completeness) {
    const corpusCoverage = [[
      "dimension", "value", "expected", "indexed", "accounted", "missing",
      "policy_leaks", "pass",
    ]];
    for (const [dimension, values] of Object.entries(artifact.corpus_completeness.slices || {})) {
      for (const [value, metrics] of Object.entries(values || {})) {
        corpusCoverage.push([
          dimension, value, metrics.expected, metrics.indexed, metrics.accounted,
          metrics.missing, metrics.policy_leaks, metrics.pass,
        ]);
      }
    }
    await writePrivateNewFile(
      resolve(privateDirectory, "corpus-coverage.csv"),
      `${corpusCoverage.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
    );
  }

  const releaseFailureIds = new Set([
    ...artifact.hard_gates.failures.map((entry) => entry.case_id),
    ...artifact.regressions,
  ]);
  const testCases = artifact.cases.map((entry) => {
    const failureCode = failuresById.get(entry.case_id)?.hard_gate_reason ||
      (artifact.regressions.includes(entry.case_id) ? "REGRESSION" :
        entry.deterministic_answer?.failure_codes?.[0] || entry.diagnosis_code) ||
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
  const { scored, agg, aggByDoc, refusals, deterministic_answers: answers, variant } = run;

  L.push("");
  L.push(`  brain      ${run.base}`);
  L.push(`  golden     ${run.goldenLabel}  (${agg.n} scored, ${refusals.total} unanswerable)`);
  L.push(`  profile    ${run.profile}${run.profile === "release" ? " (v1 retrieval-suite coverage floor passed)" : " (diagnostic; not certification)"}`);
  L.push(`  variant    limit=${variant.limit} rerank=${variant.rerank} graph_boost=${variant.graphBoost}`);
  if (run.corpus_completeness) {
    const completeness = run.corpus_completeness;
    const totals = completeness.totals || {};
    L.push(
      `  corpus     ${String(completeness.status).toUpperCase()}  ` +
        `${totals.accounted ?? "?"}/${totals.expected ?? "?"} expected sources accounted; ` +
        `${totals.unknown ?? "?"} unknown indexed`,
    );
    for (const failure of completeness.failures || []) {
      L.push(`             ${failure.code} (${failure.count}) at ${failure.stage}`);
    }
    L.push("             proves logical-family presence and expected absence only; content-version matching is not yet observable");
  }
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
  if (answers.total > 0) {
    L.push(
      `  deterministic answers  ${answers.conclusive === 0 ? "n/a" : pct(answers.passed / answers.conclusive)}` +
        `  (${answers.passed}/${answers.conclusive} answer checks passed)`,
    );
    L.push(
      `    atomic claims ${answers.matched_claims}/${answers.required_claims} matched; ` +
        `${answers.cited_claims}/${answers.required_claims} cited; ` +
        `${answers.resolved_claims}/${answers.required_claims} citations resolved`,
    );
    L.push("    boundary: literal phrase or typed value within one sentence; no semantic judge or faithfulness claim");
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
    const answerLabel = !Object.hasOwn(s, "answer")
      ? ""
      : s.answer?.pass
        ? "  answer PASS"
        : s.answer_skipped
          ? "  answer SKIP"
          : s.answer?.inconclusive
            ? "  answer INCONCLUSIVE"
            : "  answer FAIL";
    L.push(
      `    ${hit ? "PASS" : "FAIL"}  ${s.id}${repeatLabel}  ${trunc(s.question, 58)}` +
        `  ${rank(s.satisfiedAt)}${s.byDocument && s.byDocument.satisfiedAt !== s.satisfiedAt ? ` (${rank(s.byDocument.satisfiedAt)} by doc)` : ""}` +
        answerLabel
    );
    if (s.error) L.push(`          error: ${s.error}`);
    if (s.answer_error) L.push("          deterministic answer request failed");
    else if (s.answer && !s.answer.pass) {
      L.push(`          answer check: ${s.answer.failures.join(", ")}`);
    }
    if (!s.error && !hit) {
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
async function fingerprintSourceFamilies(client, inventoryRows, observeFamily = null) {
  const sourceFingerprints = new Map();
  let cursor = "";
  let count = 0;
  let previousFamily = "";
  const seenCursors = new Set();

  while (true) {
    const body = await client.sourceFamilies({ cursor, limit: CORPUS_PAGE_LIMIT });
    if (body?.source !== null || !Array.isArray(body?.families)) {
      throw new Error("source-family inventory response is malformed");
    }
    if (body.families.length > CORPUS_PAGE_LIMIT) {
      throw new Error("source-family inventory page exceeded its requested limit");
    }
    for (const family of body.families) {
      const separator = typeof family === "string" ? family.indexOf(":") : -1;
      const source = separator > 0 ? family.slice(0, separator) : "";
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source) ||
          !family.startsWith(`${source}:`) || /[\u0000-\u001f\u007f]/.test(family)) {
        throw new Error("source-family inventory contains an invalid family identity");
      }
      if (previousFamily && family <= previousFamily) {
        throw new Error("source-family inventory is not strictly ordered and unique");
      }
      previousFamily = family;
      let fingerprint = sourceFingerprints.get(source);
      if (!fingerprint) {
        fingerprint = { source_type: source, families: 0, hasher: createHash("sha256") };
        sourceFingerprints.set(source, fingerprint);
      }
      const bytes = Buffer.from(family, "utf8");
      fingerprint.hasher.update(String(bytes.length));
      fingerprint.hasher.update(":");
      fingerprint.hasher.update(bytes);
      fingerprint.hasher.update("\n");
      fingerprint.families++;
      if (observeFamily) observeFamily(source, family);
      count++;
      if (!Number.isSafeInteger(count)) {
        throw new Error("source-family inventory count is too large");
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

  const summaries = new Map(inventoryRows.map((row) => [row.source_type, row.documents]));
  const allSources = new Set([...summaries.keys(), ...sourceFingerprints.keys()]);
  let inventoryMismatchCount = 0;
  for (const source of allSources) {
    if ((summaries.get(source) ?? 0) !== (sourceFingerprints.get(source)?.families ?? 0)) {
      inventoryMismatchCount++;
    }
  }
  return {
    total: count,
    live_sources: sourceFingerprints.size,
    inventory_mismatch_count: inventoryMismatchCount,
    fingerprints: [...sourceFingerprints.values()]
      .sort((a, b) => a.source_type.localeCompare(b.source_type))
      .map(({ source_type, families, hasher }) => ({
        source_type,
        families,
        family_hash: `sha256:${hasher.digest("hex")}`,
      })),
  };
}

async function collectCorpusSnapshot(client, contractBundle = null) {
  try {
    const inventory = canonicalInventory(await client.documents());
    const reconciliation = contractBundle
      ? createCorpusReconciliationCollector(contractBundle)
      : null;
    const familyInventory = await fingerprintSourceFamilies(
      client,
      inventory.rows,
      reconciliation ? (source, family) => reconciliation.observe(source, family) : null,
    );
    if (!reconciliation && familyInventory.inventory_mismatch_count > 0) {
      throw new Error("source-family inventory does not match the corpus summary");
    }
    const sum = (field) => inventory.rows.reduce((total, row) => total + row[field], 0);
    const fingerprintMaterial = { inventory, family_fingerprints: familyInventory.fingerprints };
    const snapshot = {
      status: "observed",
      documents: familyInventory.total,
      chunks: sum("chunks"),
      embedded: sum("embedded"),
      vector_backlog: inventory.pending,
      sources: familyInventory.live_sources,
      inventory_summary_mismatches: familyInventory.inventory_mismatch_count,
      snapshot_hash: hashLabel(JSON.stringify(fingerprintMaterial)),
      fingerprint_basis: "live-logical-family-identities-and-index-state",
    };
    if (reconciliation) {
      snapshot.completeness = reconciliation.finish({
        inventoryMismatchCount: familyInventory.inventory_mismatch_count,
      });
    }
    return snapshot;
  } catch (error) {
    const unavailable = { status: "not_observable", reason: "CONTENT_FINGERPRINT_UNAVAILABLE" };
    if (contractBundle) {
      unavailable.completeness = corpusReconciliationUnavailable(
        contractBundle,
        error?.code === "SOURCE_INVENTORY_INVALID"
          ? "SOURCE_INVENTORY_INVALID"
          : "SOURCE_INVENTORY_NOT_OBSERVABLE",
      );
    }
    return unavailable;
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
      const hasAnswerCheck = Object.hasOwn(entry, "answer");
      if (entry.answer_error) {
        // A declared answer check that never reached a response is no score,
        // regardless of risk. Treating provider or route failure as a normal
        // answer miss would produce a deceptively clean release result.
        failures.push({ id: entry.id, scope: "case", pass, reason: "ANSWER_TRANSPORT_ERROR" });
      } else if (hasAnswerCheck && (entry.risk === "critical" || profile === "release")) {
        if (entry.answer_skipped) {
          failures.push({ id: entry.id, scope: "case", pass, reason: "ANSWER_PROBE_SKIPPED" });
        } else if (!entry.answer || entry.answer.inconclusive) {
          failures.push({ id: entry.id, scope: "case", pass, reason: "ANSWER_RESULT_INCONCLUSIVE" });
        } else if (entry.answer.pass !== true) {
          failures.push({
            id: entry.id,
            scope: "case",
            pass,
            reason: entry.answer.failures?.[0] || "DETERMINISTIC_ANSWER_FAILED",
          });
        }
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
  const baselineContract = baseline.corpus_completeness?.contract_hash || null;
  const currentContract = run.corpus_completeness?.contract_hash || null;
  if (baselineContract !== currentContract && (baselineContract || currentContract)) {
    mismatches.push("corpus contract");
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
        "  --corpus-contract <path>  private source-inventory contract; enables completeness gates",
        "  --installation-ref <slug> manifest binding required with --corpus-contract",
        "  --profile <name>    smoke (default) or release suite-coverage gate",
        "  --limit <n>         results requested per question (default/minimum 10 for nDCG@10)",
        "  --k <n>             evidence cutoff for question pass and quality metrics (default 5)",
        "  --rerank            turn the reranker on for this run",
        "  --repeat <n>        run the SAME config n times and report the noise floor.",
        "                      Do this before believing a small win: retrieval is",
        "                      approximate, so identical runs differ.",
        "  --graph-boost       only if the target implements it; probed before use",
        "  --no-think          skip refusal and answer canaries in smoke only; critical skips still fail",
        "  --baseline <path>   compare against a saved run",
        "  --save <path>       write this run to disk",
        "  --artifacts <dir>   write aggregate JSON, JSONL, CSV and JUnit evidence",
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
      "--no-think cannot be used with the release profile because every refusal and declared answer canary must run",
    );
  }

  // Corpus contracts are private instance material. Validate their file,
  // schema, source-to-connector topology, and manifest binding before the admin
  // key is read. An incomplete connector snapshot cannot become a passing
  // percentage merely because the indexed subset looks healthy.
  const configuredContract = flags["corpus-contract"] || cfg.corpus_contract || null;
  let corpusContractBundle = null;
  if (configuredContract) {
    const installationRef = flags["installation-ref"] || cfg.installation_ref || null;
    if (!installationRef) {
      throw new Error(
        "--installation-ref (or config installation_ref) is required with a corpus contract so it cannot be applied to another install",
      );
    }
    const contractPath = flags["corpus-contract"]
      ? abs(configuredContract, process.cwd())
      : abs(configuredContract, dirname(configPath));
    corpusContractBundle = await loadCorpusContract(contractPath, { installationRef });
    const readiness = corpusContractReadiness(corpusContractBundle.contract);
    if (readiness.status !== "ready") throw new Error(formatCorpusReadinessFailure(readiness));
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
  const corpusBefore = await collectCorpusSnapshot(client, corpusContractBundle);
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
  const bracketedCorpus = closeCorpusBracket(
    corpusBefore,
    await collectCorpusSnapshot(client, corpusContractBundle),
  );
  const corpusCompleteness = bracketedCorpus.completeness || null;
  const { completeness: _privateCompleteness, ...corpus } = bracketedCorpus;
  if (flags.save && corpus.status !== "observed") {
    throw new Error("cannot save a baseline because a bracketed corpus content fingerprint is not observable");
  }
  // Repeats are test executions, not merely a source for a noise annotation.
  // Every execution contributes to metrics, saved baselines, artifacts and
  // regression comparison.
  const scored = passes.flat();

  // A transport failure partway through is not a retrieval result. Saying so is
  // the difference between a bad number and no number. Every repeat matters.
  const errored = scored.filter((s) => s.error || s.answer_error).length;
  if (errored > 0 && errored === scored.length) {
    throw new Error(`every scored case had a transport failure. First error: ${scored[0].error || scored[0].answer_error}`);
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
  const deterministicAnswers = deterministicAnswerSummary(scored);

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
    ...(corpusCompleteness ? { corpus_completeness: corpusCompleteness } : {}),
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
    answer_performance: answerPerformanceSummary(scored),
    refusals,
    deterministic_answers: deterministicAnswers,
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
  run.hard_gate_failures = [
    ...hardGateFailures(passes, k, profile),
    ...corpusCompletenessHardGates(corpusCompleteness),
  ];
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
