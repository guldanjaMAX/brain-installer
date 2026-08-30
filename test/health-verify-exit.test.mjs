/**
 * Zero-network CLI exit tests for the two commands that establish whether the
 * required infrastructure is actually usable. This file doubles as its own
 * `--import` fixture so no second helper or real credential is needed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO = String(process.env.BRAIN_HEALTH_VERIFY_SCENARIO || "");
const FIXTURE_ADMIN = "fixture-admin-label";
const FIXTURE_TOKEN = "fixture-cloudflare-label";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input) {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

if (SCENARIO) {
  const userRoot = String(process.env.BRAIN_HEALTH_VERIFY_USER_ROOT || "");
  if (!userRoot) throw new Error("BRAIN_HEALTH_VERIFY_USER_ROOT is required");
  os.homedir = () => userRoot;
  syncBuiltinESMExports();

  globalThis.fetch = async (input, options = {}) => {
    const url = requestUrl(input);

    if (url.hostname === "fixture.invalid" && url.pathname === "/health") {
      return json({ ok: true, version: "0.1.9" });
    }
    if (url.hostname === "fixture.invalid" && url.pathname === "/api/admin/brain/documents") {
      if (new Headers(options.headers).get("X-Admin-Key") !== FIXTURE_ADMIN) {
        return json({ error: "fixture unauthorized" }, 401);
      }
      if (SCENARIO === "health-documents-unreachable") {
        return json({ error: "fixture documents unavailable" }, 503);
      }
      if (SCENARIO === "health-documents-invalid") {
        return new Response("<html>fixture gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (SCENARIO === "health-backlog-error") {
        return json({ backend: "d1", rows: [], vector_backlog: { error: "fixture D1 failure" } });
      }
      if (SCENARIO === "health-backlog-missing") {
        return json({ backend: "d1", rows: [] });
      }
      if (SCENARIO === "health-backlog-malformed") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: "0", upserts: 0, deletes: 0 },
        });
      }
      if (SCENARIO === "health-backlog-oldest-missing") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: 1, upserts: 1, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: false, reason: "vector_work_queued",
            expected_vectors: 1, actual_vectors: 0, pending: 1, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-backlog-stalled") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: {
            pending: 1,
            upserts: 1,
            deletes: 0,
            submitted: 0,
            oldest_queued_at: Date.now() - 31 * 60 * 1000,
          },
          vector_readiness: {
            ready: false, reason: "vector_work_queued",
            expected_vectors: 1, actual_vectors: 0, pending: 1, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-vector-processing") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: {
            pending: 1,
            upserts: 1,
            deletes: 0,
            submitted: 1,
            oldest_queued_at: Date.now() - 1_000,
          },
          vector_readiness: {
            ready: false, reason: "accepted_mutation_processing",
            expected_vectors: 1, actual_vectors: 0, pending: 1, submitted: 1,
          },
        });
      }
      if (SCENARIO === "health-vector-count-mismatch") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: false, reason: "vector_count_mismatch",
            expected_vectors: 10, actual_vectors: 0, pending: 0, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-vector-count-excess") {
        return json({
          backend: "d1",
          rows: [],
          vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
          vector_readiness: {
            ready: false, reason: "vector_count_mismatch",
            expected_vectors: 10, actual_vectors: 13, pending: 0, submitted: 0,
          },
        });
      }
      if (SCENARIO === "health-backend-mismatch") {
        return json({ backend: "supabase", rows: [] });
      }
      if (SCENARIO === "health-backend-case-bypass") {
        return json({ backend: "D1", rows: [] });
      }
      if (SCENARIO === "health-backend-unknown") {
        return json({ backend: "fixture-store", rows: [] });
      }
      if (SCENARIO === "health-default-backend-mismatch") {
        return json({ backend: "supabase", rows: [] });
      }
      return json({
        backend: "d1",
        rows: [],
        vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
        vector_readiness: {
          ready: true, reason: null,
          expected_vectors: 0, actual_vectors: 0, pending: 0, submitted: 0,
        },
      });
    }

    if (url.hostname === "api.cloudflare.com" && url.pathname === "/client/v4/accounts") {
      return json({ success: true, result: [{ id: "fixture-account", name: "Fixture account" }] });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/r2/buckets")) {
      // A manifest with no bucket must never reach this endpoint. Throwing here
      // names a reintroduced probe instead of letting it pass as one more warning.
      if (SCENARIO === "verify-no-r2") {
        throw new Error("verify probed R2 for a manifest that asks for no bucket");
      }
      if (SCENARIO === "verify-optional-warnings") {
        return json({ success: false, errors: [{ code: 9109, message: "fixture R2 unavailable" }] }, 403);
      }
      return json({ success: true, result: { buckets: [] } });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/d1/database")) {
      if (SCENARIO === "verify-d1-unreachable") {
        return json({ success: false, errors: [{ code: 9109, message: "fixture D1 unavailable" }] }, 403);
      }
      return json({ success: true, result: [] });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/workers/scripts")) {
      return json({ success: true, result: [] });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/vectorize/v2/indexes")) {
      if (SCENARIO === "verify-optional-warnings") {
        return json({ success: false, errors: [{ code: 9109, message: "fixture Vectorize unavailable" }] }, 403);
      }
      return json({ success: true, result: [] });
    }

    throw new Error(`unexpected fixture request: ${url.origin}${url.pathname}`);
  };
} else {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CLI = join(HERE, "..", "brain.mjs");
  const THIS_FILE = import.meta.url;
  let fail = 0;
  let ran = 0;
  const check = (name, condition, detail = "") => {
    ran++;
    console.log((condition ? "PASS  " : "FAIL  ") + name +
      (condition ? "" : "  " + String(detail).slice(0, 300)));
    if (!condition) fail++;
  };
  const strip = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

  function safeChildEnvironment() {
    const environment = {};
    for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

  function runScenario(scenario, command, { adminKey = false, cloudflareToken = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "brain-health-verify-exit-"));
    const userRoot = join(directory, "isolated-user-root");
    const manifestPath = join(directory, "fixture.manifest.json");
    mkdirSync(userRoot, { recursive: true });
    const cloudflare = { account_id: "fixture-account" };
    if (scenario !== "health-default-backend-mismatch") cloudflare.storage = "d1";
    // Verify only probes R2 for a manifest that asks for a bucket (F-09). The
    // optional-warnings scenario is about an install that WANTS R2 and cannot
    // reach it, so it has to name one; verify-no-r2 deliberately names none.
    if (scenario === "verify-optional-warnings") cloudflare.r2_bucket = "fixture-assets";
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture-brain" },
      brain: { domain: "fixture.invalid", worker_name: "fixture-brain" },
      infrastructure: { cloudflare },
    }));

    const environment = {
      ...safeChildEnvironment(),
      BRAIN_HEALTH_VERIFY_SCENARIO: scenario,
      BRAIN_HEALTH_VERIFY_USER_ROOT: userRoot,
    };
    if (adminKey) environment.ADMIN_KEY = FIXTURE_ADMIN;
    if (cloudflareToken) environment.CLOUDFLARE_API_TOKEN = FIXTURE_TOKEN;

    const result = spawnSync(process.execPath, ["--import", THIS_FILE, CLI, command, manifestPath], {
      encoding: "utf-8",
      env: environment,
      timeout: 30_000,
    });
    const output = strip(`${result.stdout || ""}${result.stderr || ""}`);
    rmSync(directory, { recursive: true, force: true });
    return { code: result.status, output, error: result.error };
  }

  const missingKey = runScenario("health-ok", "health");
  check("health exits nonzero when no admin key is available",
    missingKey.code === 1 && /no admin key.*authenticated documents endpoint/is.test(missingKey.output),
    missingKey.output);
  check("missing-key health never claims the documents endpoint passed",
    !/ok\s+documents endpoint/i.test(missingKey.output), missingKey.output);

  const documentsDown = runScenario("health-documents-unreachable", "health", { adminKey: true });
  check("health exits nonzero when authenticated documents cannot be reached",
    documentsDown.code === 1 && /documents endpoint 503.*authenticated access was not proven/is.test(documentsDown.output),
    documentsDown.output);
  check("an unavailable documents endpoint never prints green",
    !/ok\s+documents endpoint/i.test(documentsDown.output), documentsDown.output);

  const invalidDocuments = runScenario("health-documents-invalid", "health", { adminKey: true });
  check("health rejects a 200 that is not a real documents inventory",
    invalidDocuments.code === 1 && /did not return JSON.*authenticated access was not proven/is.test(invalidDocuments.output),
    invalidDocuments.output);

  const healthy = runScenario("health-ok", "health", { adminKey: true });
  check("health still succeeds after authenticated documents are proven",
    healthy.code === 0 && /documents endpoint 200/.test(healthy.output) &&
      /vector index is query-ready/.test(healthy.output), healthy.output);

  for (const scenario of ["health-backlog-error", "health-backlog-missing", "health-backlog-malformed"]) {
    const invalidBacklog = runScenario(scenario, "health", { adminKey: true });
    check(`${scenario} exits nonzero instead of claiming semantic indexing is healthy`,
      invalidBacklog.code === 1 && /could not prove a valid D1 vector backlog/is.test(invalidBacklog.output) &&
        !/vector index is query-ready/.test(invalidBacklog.output), invalidBacklog.output);
  }

  const missingOldest = runScenario("health-backlog-oldest-missing", "health", { adminKey: true });
  check("health rejects queued work whose age cannot be proven",
    missingOldest.code === 1 && /without a valid oldest timestamp/is.test(missingOldest.output),
    missingOldest.output);

  const stalled = runScenario("health-backlog-stalled", "health", { adminKey: true });
  check("health exits nonzero when the vector queue is older than the allowed drain window",
    stalled.code === 1 && /vector operation\(s\) are stalled.*oldest queued/is.test(stalled.output) &&
      !/vector index is caught up/.test(stalled.output), stalled.output);

  const processing = runScenario("health-vector-processing", "health", { adminKey: true });
  check("health cannot green an accepted mutation before query visibility",
    processing.code === 1 && /not query-visible yet.*accepted by Vectorize/is.test(processing.output) &&
      /brain drain/.test(processing.output) && !/vector index is query-ready/.test(processing.output),
    processing.output);

  const countMismatch = runScenario("health-vector-count-mismatch", "health", { adminKey: true });
  check("health rejects an empty queue when Vectorize is still missing vectors",
    countMismatch.code === 1 && /Vectorize holds 0 vector\(s\), but D1 requires 10/is.test(countMismatch.output) &&
      /brain diagnose/.test(countMismatch.output) && /brain reindex/.test(countMismatch.output),
    countMismatch.output);

  const countExcess = runScenario("health-vector-count-excess", "health", { adminKey: true });
  check("health does not claim reindex alone can remove provider-only excess vectors",
    countExcess.code === 1 && /Vectorize holds 13 vector\(s\), but D1 requires 10/is.test(countExcess.output) &&
      /provider-only excess vectors.*reindex cannot enumerate or remove/is.test(countExcess.output) &&
      /supervised recovery.*recreate\/rebind a clean/is.test(countExcess.output),
    countExcess.output);

  const mismatch = runScenario("health-backend-mismatch", "health", { adminKey: true });
  check("health rejects a valid endpoint serving a backend different from the manifest",
    mismatch.code === 1 && /different storage backend than this manifest/is.test(mismatch.output),
    mismatch.output);

  const caseBypass = runScenario("health-backend-case-bypass", "health", { adminKey: true });
  check("backend normalization cannot bypass the required D1 backlog proof",
    caseBypass.code === 1 && /could not prove a valid D1 vector backlog/is.test(caseBypass.output),
    caseBypass.output);

  const unknownBackend = runScenario("health-backend-unknown", "health", { adminKey: true });
  check("health rejects an unsupported backend instead of treating authentication as readiness",
    unknownBackend.code === 1 && /unsupported storage backend/is.test(unknownBackend.output),
    unknownBackend.output);

  const defaultMismatch = runScenario("health-default-backend-mismatch", "health", { adminKey: true });
  check("an omitted manifest storage field still expects the standard D1 backend",
    defaultMismatch.code === 1 && /different storage backend than this manifest/is.test(defaultMismatch.output),
    defaultMismatch.output);

  const d1Down = runScenario("verify-d1-unreachable", "verify", { cloudflareToken: true });
  check("verify exits nonzero when required D1 is unreachable",
    d1Down.code === 1 && /D1 is not reachable.*required database cannot be verified/is.test(d1Down.output),
    d1Down.output);
  check("unreachable D1 is never downgraded to a warning",
    !/warn\s+D1 not reachable/i.test(d1Down.output), d1Down.output);

  const noR2 = runScenario("verify-no-r2", "verify", { cloudflareToken: true });
  check("verify does not probe R2 for a manifest that has no bucket",
    noR2.code === 0 && !/R2 is not ready/.test(noR2.output) &&
      /does not use R2 file storage/.test(noR2.output),
    noR2.output);

  const optionalWarnings = runScenario("verify-optional-warnings", "verify", { cloudflareToken: true });
  check("optional R2 and Vectorize access remain warnings",
    optionalWarnings.code === 0 && /R2 is not ready/.test(optionalWarnings.output) &&
      /Provision can use a separately named Wrangler profile as a temporary fallback/.test(optionalWarnings.output) &&
      /D1 is reachable/.test(optionalWarnings.output) && /Workers is reachable/.test(optionalWarnings.output),
    optionalWarnings.output);

  const outputs = [missingKey, documentsDown, invalidDocuments, healthy, d1Down, optionalWarnings]
    .map((result) => result.output).join("\n");
  check("fixtures never expose even their inert credential labels",
    !outputs.includes(FIXTURE_ADMIN) && !outputs.includes(FIXTURE_TOKEN), outputs);

  console.log(fail ? `\n${fail} FAILURES` : `\nhealth/verify exits: all ${ran} tests passed`);
  if (fail) process.exit(1);
}
