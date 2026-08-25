import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = mkdtempSync(join(tmpdir(), "brain-eval-run-"));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runFixture({
  questions, goldenFields = {}, args = [], route = null, artifacts = false, baseline = undefined, save = false,
}) {
  const root = mkdtempSync(join(tmpdir(), "brain-eval-case-"));
  const key = "fixture-private-key";
  const state = {};
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    let body = {};
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { body = {}; }
      if (url.pathname === "/api/rag/unified" || url.pathname === "/api/rag/think") {
        for (const [keyName, value] of Object.entries(body)) {
          if (value !== undefined && value !== null) url.searchParams.set(keyName, String(value));
        }
      }
    }
    state.lastRequest = { method: request.method, pathname: url.pathname, body };
    response.setHeader("content-type", "application/json");
    const custom = route?.({ url, request, state, body });
    if (custom) {
      response.statusCode = custom.status || 200;
      response.end(JSON.stringify(custom.body));
      return;
    }
    if (url.pathname === "/health") {
      response.end(JSON.stringify({ ok: true, brain: "fixture-private-name", version: "0.1.10" }));
      return;
    }
    if (request.headers["x-admin-key"] !== key) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/api/admin/brain/documents") {
      response.end(JSON.stringify({
        rows: [{
          source_type: "curated", documents: 1, chunks: 1, embedded: 1,
          last_ingested: "2026-08-24T00:00:00.000Z",
        }],
        vector_backlog: { pending: 0 },
      }));
      return;
    }
    if (url.pathname === "/api/admin/brain/source-families") {
      response.end(JSON.stringify({
        source: "curated", families: ["curated:doc-a"], next_cursor: null,
      }));
      return;
    }
    if (url.pathname === "/api/rag/unified") {
      response.end(JSON.stringify({ results: [{ source: "curated", ref_key: "doc-a", title: "Fixture A" }] }));
      return;
    }
    if (url.pathname === "/api/rag/think") {
      response.end(JSON.stringify({ answer: "The corpus does not contain that information.", gaps: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const golden = join(root, "private-owner-suite.golden.json");
    writeFileSync(golden, JSON.stringify({ install: "private-owner", ...goldenFields, questions }));
    const environment = { BRAIN_ADMIN_KEY: key };
    for (const name of [
      "PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    ]) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const artifactPath = join(root, "artifacts");
    const baselinePath = join(root, "baseline.json");
    const savedPath = join(root, "saved-run.json");
    if (baseline !== undefined) writeFileSync(baselinePath, JSON.stringify(baseline));
    const result = await run(process.execPath, [
      fileURLToPath(new URL("./run.mjs", import.meta.url)),
      "--base", `http://127.0.0.1:${address.port}`,
      "--golden", golden,
      ...args,
      ...(baseline !== undefined ? ["--baseline", baselinePath] : []),
      ...(save ? ["--save", savedPath] : []),
      ...(artifacts ? ["--artifacts", artifactPath] : []),
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return {
      ...result,
      runArtifact: existsSync(join(artifactPath, "run.json"))
        ? JSON.parse(readFileSync(join(artifactPath, "run.json"), "utf8"))
        : null,
      failuresArtifact: existsSync(join(artifactPath, "failures.jsonl"))
        ? readFileSync(join(artifactPath, "failures.jsonl"), "utf8")
        : null,
      junitArtifact: existsSync(join(artifactPath, "junit.xml"))
        ? readFileSync(join(artifactPath, "junit.xml"), "utf8")
        : null,
      savedRun: existsSync(savedPath) ? JSON.parse(readFileSync(savedPath, "utf8")) : null,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

function releaseProfileFixture() {
  const questions = Array.from({ length: 60 }, (_, index) => {
    const unanswerable = index >= 55;
    return {
      id: `release-${index + 1}`,
      kind: unanswerable ? "unanswerable" : "single",
      risk: index < 5 ? "critical" : "normal",
      domains: ["general"],
      formats: ["text"],
      question: `Synthetic release question ${index + 1}`,
      expect: unanswerable ? [] : [{ any_of: ["curated:doc-a"] }],
    };
  });
  return {
    questions,
    goldenFields: {
      release_slices: {
        risk: ["critical", "normal"],
        domain: ["general"],
        format: ["text"],
        query_kind: ["single", "unanswerable"],
      },
    },
  };
}

test("release profile rejects an undersized suite before credentials or network access", async () => {
  let requests = 0;
  const privateText = "PRIVATE question that must not be copied into release diagnostics";
  const result = await runFixture({
    questions: [{
      id: "private-case-id",
      kind: "single",
      risk: "critical",
      domains: ["general"],
      formats: ["text"],
      question: privateText,
      expect: [{ any_of: ["drive_path:Private/Owner/File.pdf"] }],
    }],
    args: ["--profile", "release"],
    route: () => { requests++; return null; },
  });

  assert.equal(result.code, 2);
  assert.equal(requests, 0, "release coverage must fail before contacting the brain");
  assert.match(result.stderr, /release profile coverage gate failed before retrieval/);
  assert.match(result.stderr, /suite has 1 cases; release requires at least 60/);
  assert.doesNotMatch(result.stderr, /PRIVATE question|private-case-id|Private\/Owner\/File\.pdf/);
});

test("release profile passes its exact aggregate coverage floor and records the profile", async () => {
  const result = await runFixture({
    ...releaseProfileFixture(),
    args: ["--profile", "release"],
    artifacts: true,
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /profile\s+release \(v1 retrieval-suite coverage floor passed\)/);
  assert.equal(result.runArtifact.suite.profile, "release");
  assert.equal(result.runArtifact.suite.profile_coverage.minimums.suite_cases, 60);
  assert.deepEqual(result.runArtifact.suite.profile_coverage.failures, []);
});

test("release refuses to skip its required normal-risk unanswerable cases", async () => {
  let requests = 0;
  const result = await runFixture({
    ...releaseProfileFixture(),
    args: ["--profile", "release", "--no-think"],
    route: () => { requests++; return null; },
  });

  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(requests, 0, "an impossible release must fail before contacting the brain");
  assert.match(result.stderr, /--no-think cannot be used with the release profile/);
});

test("a false answer in every required normal-risk unanswerable case blocks release", async () => {
  const result = await runFixture({
    ...releaseProfileFixture(),
    args: ["--profile", "release"],
    route: ({ url }) => url.pathname === "/api/rag/think"
      ? { body: { answer: "The unsupported fact is definitely true.", gaps: ["missing"] } }
      : null,
  });

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /HARD GATE FAILURES \(5\)/);
  assert.equal((result.stdout.match(/FALSE_ANSWER/g) || []).length >= 5, true);
});

test("the distributed runner records reproducible provenance and CI artifacts", async () => {
  const key = "fixture-eval-admin-key";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      response.end(JSON.stringify({ ok: true, brain: "fixture-brain", version: "0.1.10" }));
      return;
    }
    if (request.headers["x-admin-key"] !== key) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/api/admin/brain/documents") {
      response.end(JSON.stringify({
        rows: [{
          source_type: "curated", documents: 2, chunks: 4, embedded: 4,
          last_ingested: "2026-08-24T00:00:00.000Z",
        }],
        vector_backlog: { pending: 0 },
      }));
      return;
    }
    if (url.pathname === "/api/admin/brain/source-families") {
      response.end(JSON.stringify({
        source: "curated",
        families: ["curated:doc-a", "curated:doc-b"],
        next_cursor: null,
      }));
      return;
    }
    if (url.pathname === "/api/rag/unified") {
      response.end(JSON.stringify({
        results: [{ source: "curated", ref_key: "doc-a", title: "Fixture A" }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const address = await listen(server);
    const golden = join(sandbox, "fixture.golden.json");
    const artifacts = join(sandbox, "artifacts");
    writeFileSync(golden, JSON.stringify({
      install: "fixture",
      questions: [{
        id: "q1",
        kind: "single",
        query_kind: "single",
        risk: "critical",
        domains: ["general"],
        formats: ["text"],
        question: "Which fixture should be found?",
        expect: [{ doc: "Fixture A", any_of: ["curated:doc-a"] }],
      }],
    }));

    const environment = { BRAIN_ADMIN_KEY: key };
    for (const name of [
      "PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    ]) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const result = await run(process.execPath, [
      fileURLToPath(new URL("./run.mjs", import.meta.url)),
      "--base", `http://127.0.0.1:${address.port}`,
      "--golden", golden,
      "--no-think",
      "--artifacts", artifacts,
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    for (const file of ["run.json", "failures.jsonl", "coverage.csv", "junit.xml"]) {
      assert.equal(existsSync(join(artifacts, file)), true, `${file} was not written`);
    }
    const runArtifact = JSON.parse(readFileSync(join(artifacts, "run.json"), "utf8"));
    assert.equal(runArtifact.schema_version, 1);
    assert.equal(runArtifact.artifact_kind, "brain-retrieval-eval");
    assert.deepEqual(runArtifact.corpus, {
      status: "observed", documents: 2, chunks: 4, embedded: 4, vector_backlog: 0, sources: 1,
      snapshot_hash: runArtifact.corpus.snapshot_hash,
      fingerprint_basis: "logical-family-identities-source-versions-and-index-state",
      bracketed: true,
    });
    assert.match(runArtifact.corpus.snapshot_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(runArtifact.code.worker_version, "0.1.10");
    assert.equal(runArtifact.metrics.evidence_at_k.complete_evidence, 1);
    assert.equal(readFileSync(join(artifacts, "failures.jsonl"), "utf8"), "");
    assert.match(readFileSync(join(artifacts, "coverage.csv"), "utf8"), /domain,general,1/);
    assert.match(readFileSync(join(artifacts, "junit.xml"), "utf8"), /failures="0"/);
    const allArtifacts = ["run.json", "failures.jsonl", "coverage.csv", "junit.xml"]
      .map((file) => readFileSync(join(artifacts, file), "utf8")).join("\n");
    assert.doesNotMatch(allArtifacts, /Which fixture should be found\?|127\.0\.0\.1|fixture\.golden\.json|fixture-brain|Fixture A/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}${allArtifacts}`, new RegExp(key));
    if (process.platform !== "win32") {
      assert.equal(statSync(artifacts).mode & 0o777, 0o700);
      for (const file of ["run.json", "failures.jsonl", "coverage.csv", "junit.xml"]) {
        assert.equal(statSync(join(artifacts, file)).mode & 0o777, 0o600, file);
      }
    }

    const overwrite = await run(process.execPath, [
      fileURLToPath(new URL("./run.mjs", import.meta.url)),
      "--base", `http://127.0.0.1:${address.port}`,
      "--golden", golden,
      "--no-think",
      "--artifacts", artifacts,
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    assert.equal(overwrite.code, 2);
    assert.match(overwrite.stderr, /refusing to overwrite/);

    const templateResult = await run(process.execPath, [
      fileURLToPath(new URL("./run.mjs", import.meta.url)),
      "--base", `http://127.0.0.1:${address.port}`,
      "--golden", fileURLToPath(new URL("./golden/TEMPLATE.golden.json", import.meta.url)),
      "--no-think",
    ], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    assert.equal(templateResult.code, 1, `${templateResult.stdout}\n${templateResult.stderr}`);
    assert.match(templateResult.stdout, /QUESTION PASS@5/);
    assert.doesNotMatch(templateResult.stderr, /slot with no any_of references/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a critical unanswerable fabrication fails the process", async () => {
  const result = await runFixture({
    questions: [{
      id: "critical-unsupported", kind: "unanswerable", risk: "critical",
      question: "What unsupported fact is true?", expect: [],
    }],
    route: ({ url }) => url.pathname === "/api/rag/think"
      ? { body: { answer: "The unsupported fact is definitely true.", gaps: ["missing"] } }
      : null,
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /FALSE_ANSWER/);
});

test("skipping a critical unanswerable probe cannot produce a green run", async () => {
  const result = await runFixture({
    questions: [{
      id: "critical-unsupported", kind: "unanswerable", risk: "critical",
      question: "What unsupported fact is true?", expect: [],
    }],
    args: ["--no-think"],
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /UNANSWERABLE_PROBE_SKIPPED/);
});

test("a critical failure in the second repeat fails the whole run", async () => {
  const result = await runFixture({
    questions: [{
      id: "critical-repeat", kind: "single", risk: "critical",
      question: "critical repeat question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--repeat", "2", "--no-think"],
    artifacts: true,
    save: true,
    route: ({ url, state }) => {
      if (url.pathname !== "/api/rag/unified" || url.searchParams.get("q") !== "critical repeat question") return null;
      state.repeatCalls = (state.repeatCalls || 0) + 1;
      return { body: { results: state.repeatCalls === 1 ? [{ source: "curated", ref_key: "doc-a" }] : [] } };
    },
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 2\s+critical-repeat\s+INCOMPLETE_EVIDENCE_AT_5/);
  assert.equal(result.runArtifact.status, "fail");
  assert.equal(result.runArtifact.suite.cases, 1);
  assert.equal(result.runArtifact.suite.executions, 2);
  assert.equal(result.runArtifact.metrics.evidence_at_k.complete_evidence, 0.5);
  assert.deepEqual(result.runArtifact.cases.map((entry) => entry.repeat), [1, 2]);
  assert.equal(result.savedRun.baseline_format_version, 2);
  assert.deepEqual(result.savedRun.questions.map((entry) => entry.repeat), [1, 2]);
  assert.equal(result.savedRun.agg.recall[5], 0.5);
  assert.match(result.failuresArtifact, /INCOMPLETE_EVIDENCE_AT_5/);
  assert.match(result.junitArtifact, /failures="1"/);
});

test("a transport error in any repeat fails even a noncritical case", async () => {
  const result = await runFixture({
    questions: [{
      id: "normal-repeat", kind: "single", risk: "normal",
      question: "normal repeat question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--repeat", "2", "--no-think"],
    route: ({ url, state }) => {
      if (url.pathname !== "/api/rag/unified" || url.searchParams.get("q") !== "normal repeat question") return null;
      state.normalCalls = (state.normalCalls || 0) + 1;
      return state.normalCalls === 1
        ? { body: { results: [{ source: "curated", ref_key: "doc-a" }] } }
        : { status: 418, body: { error: "fixture transport failure" } };
    },
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TRANSPORT_ERROR/);
});

test("malformed inventory remains not observable instead of becoming zero", async () => {
  const result = await runFixture({
    questions: [{
      id: "q1", kind: "single", risk: "normal", question: "fixture question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--no-think"],
    artifacts: true,
    route: ({ url }) => url.pathname === "/api/admin/brain/documents" ? { body: {} } : null,
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(result.runArtifact.corpus, {
    status: "not_observable", reason: "CONTENT_FINGERPRINT_UNAVAILABLE", bracketed: false,
  });
});

test("sanitized artifacts and malformed JSON objects cannot masquerade as baselines", async () => {
  for (const baseline of [{}, { schema_version: 1, artifact_kind: "brain-retrieval-eval", cases: [] }]) {
    const result = await runFixture({
      questions: [{
        id: "q1", kind: "single", risk: "normal", question: "fixture question",
        expect: [{ any_of: ["curated:doc-a"] }],
      }],
      args: ["--no-think"],
      baseline,
    });
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /must be a private run saved with --save/);
  }
});

test("a repeated v2 baseline must contain every question execution", async () => {
  const result = await runFixture({
    questions: [{
      id: "q1", kind: "single", risk: "normal", question: "fixture question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--repeat", "2", "--no-think"],
    baseline: {
      baseline_format_version: 2,
      repeat: 2,
      questions: [{ id: "q1", repeat: 1, scorable: true, satisfiedAt: 1 }],
    },
  });
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /same complete set of repeated executions/);
});

test("a noncritical miss stays diagnostic when the suite has successful coverage", async () => {
  const result = await runFixture({
    questions: [
      {
        id: "normal-hit", kind: "single", risk: "normal", question: "present normal evidence",
        expect: [{ any_of: ["curated:doc-a"] }],
      },
      {
        id: "normal-miss", kind: "single", risk: "normal", question: "missing normal evidence",
        expect: [{ any_of: ["curated:absent"] }],
      },
    ],
    args: ["--no-think"],
    artifacts: true,
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.runArtifact.status, "pass");
  assert.match(result.failuresArtifact, /NOT_OBSERVABLE_AT_STAGE/);
  assert.match(result.junitArtifact, /failures="0"/);
});

test("a total noncritical failure cannot exit green", async () => {
  const result = await runFixture({
    questions: [
      {
        id: "normal-miss-a", kind: "single", risk: "normal", question: "missing normal evidence a",
        expect: [{ any_of: ["curated:absent-a"] }],
      },
      {
        id: "normal-miss-b", kind: "single", risk: "high", question: "missing normal evidence b",
        expect: [{ any_of: ["curated:absent-b"] }],
      },
    ],
    args: ["--no-think"],
    artifacts: true,
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /NO_ANSWERABLE_CASES_PASSED_AT_5/);
  assert.equal(result.runArtifact.status, "fail");
  assert.match(result.junitArtifact, /failures="1"/);
});

test("a correct refusal cannot hide zero answerable retrieval coverage", async () => {
  const result = await runFixture({
    questions: [
      {
        id: "normal-miss", kind: "single", risk: "normal", question: "missing normal evidence",
        expect: [{ any_of: ["curated:absent"] }],
      },
      {
        id: "normal-refusal", kind: "unanswerable", risk: "normal",
        question: "What absent policy applies?", expect: [],
      },
    ],
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /NO_ANSWERABLE_CASES_PASSED_AT_5/);
});

test("refusal wording with an added claim fails the unanswerable gate", async () => {
  const result = await runFixture({
    questions: [{
      id: "mixed-refusal", kind: "unanswerable", risk: "critical",
      question: "What unsupported policy is true?", expect: [],
    }],
    route: ({ url }) => url.pathname === "/api/rag/think"
      ? { body: { answer: "The corpus does not contain that policy, but it grants twelve weeks of leave.", gaps: [] } }
      : null,
  });
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /included an affirmative claim alongside refusal language/);
  assert.match(result.stdout, /FALSE_ANSWER/);
});

test("nDCG at ten refuses a retrieval limit below ten", async () => {
  const result = await runFixture({
    questions: [{
      id: "q1", kind: "single", risk: "normal", question: "fixture question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--limit", "5", "--no-think"],
  });
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /nDCG@10 would not retrieve ten ranked positions/);
});

test("a shared evidence group must be an explicit relationship between slots", async () => {
  const result = await runFixture({
    questions: [{
      id: "q1", kind: "single", risk: "normal", question: "fixture question",
      expect: [{ any_of: ["curated:doc-a"], shared_result_group: "orphan-group" }],
    }],
    args: ["--no-think"],
  });
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /must be used by at least two slots/);
});

test("nDCG at ten requests and scores ten ranked positions", async () => {
  const result = await runFixture({
    questions: [{
      id: "ndcg-depth", kind: "single", risk: "normal", question: "ndcg depth question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--no-think"],
    artifacts: true,
    route: ({ url }) => {
      if (url.pathname !== "/api/rag/unified" || url.searchParams.get("q") !== "ndcg depth question") return null;
      if (url.searchParams.get("limit") !== "10") {
        return { status: 400, body: { error: "fixture requires ten" } };
      }
      return {
        body: {
          results: [
            { source: "curated", ref_key: "doc-a" },
            ...Array.from({ length: 9 }, (_unused, index) => ({
              source: "curated", ref_key: `noise-${index + 1}`,
            })),
          ],
        },
      };
    },
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.runArtifact.cases[0].returned, 10);
  assert.equal(result.runArtifact.metrics.evidence_at_10.ndcg, 1);
});

test("a content change with unchanged corpus counts invalidates the bracketed run", async () => {
  const result = await runFixture({
    questions: [{
      id: "q1", kind: "single", risk: "normal", question: "fixture question",
      expect: [{ any_of: ["curated:doc-a"] }],
    }],
    args: ["--no-think"],
    route: ({ url, state }) => {
      if (url.pathname !== "/api/admin/brain/source-families") return null;
      state.inventoryCalls = (state.inventoryCalls || 0) + 1;
      return {
        body: {
          source: "curated",
          families: [state.inventoryCalls === 1 ? "curated:doc-a" : "curated:doc-b"],
          next_cursor: null,
        },
      };
    },
  });
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /corpus changed while evaluation was running/);
});

test.after(() => rmSync(sandbox, { recursive: true, force: true }));
