import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdDeploy,
  cmdSecrets,
  cmdTest,
  reportAcceptanceFailure,
  workersDevRouteDisposition,
} from "../brain.mjs";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-report-deploy-exit-")));

function manifest(overrides = {}) {
  const value = {
    client: { slug: "fixture", display_name: "Fixture" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        d1_database_id: "fixture-database",
        storage: "d1",
        vectorize_index: "fixture-index",
        drain_cron: "*/5 * * * *",
      },
    },
    retrieval: { chunk_size: 1500, chunk_overlap: 300 },
    safety: { daily_llm_spend_cap_usd: 1, credential_scanner: { enabled: true } },
    testing: { probe_questions: [] },
  };
  if (overrides.brain) Object.assign(value.brain, overrides.brain);
  if (overrides.cloudflare) Object.assign(value.infrastructure.cloudflare, overrides.cloudflare);
  return value;
}

function writeManifest(name, value) {
  const path = join(sandbox, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function apiResponse(result, { success = true, status = 200, message = "fixture denial" } = {}) {
  return new Response(JSON.stringify({
    success,
    result: success ? result : null,
    errors: success ? [] : [{ code: 1000, message }],
  }), { status, headers: { "content-type": "application/json" } });
}

async function isolatedRuntime({ fetchImpl, env = {}, argv = null }, fn) {
  const priorFetch = globalThis.fetch;
  const priorArgv = process.argv;
  const keys = [
    "CLOUDFLARE_API_TOKEN",
    "ADMIN_KEY",
    "ANTHROPIC_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const priorEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    globalThis.fetch = fetchImpl;
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    if (argv) process.argv = argv;
    return await fn();
  } finally {
    globalThis.fetch = priorFetch;
    process.argv = priorArgv;
    for (const key of keys) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  }
}

function cloudflareHarness({ routePost = "ok", routeEnabled = true, schedule = "ok" } = {}) {
  const calls = [];
  const workerMetadata = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const method = options.method || "GET";
    // Record which secret each PUT carries. A bare count cannot tell "ADMIN_KEY
    // and the derived read-only key" apart from "the same secret written twice"
    // or "the wrong secret written once".
    let secretName;
    if (method === "PUT" && path.endsWith("/secrets") && typeof options.body === "string") {
      try { secretName = JSON.parse(options.body)?.name; } catch { secretName = "<unparseable>"; }
    }
    calls.push({ path, method, ...(secretName ? { secretName } : {}) });
    if (path === "/client/v4/accounts" && method === "GET") {
      return apiResponse([{ id: "fixture-account", name: "Fixture account" }]);
    }
    if (path.endsWith("/workers/scripts/fixture-brain") && method === "PUT") {
      const rawMetadata = await options.body?.get?.("metadata")?.text?.();
      workerMetadata.push(JSON.parse(rawMetadata));
      return apiResponse({});
    }
    if (path.endsWith("/workers/scripts/fixture-brain/subdomain") && method === "POST") {
      return routePost === "ok"
        ? apiResponse({ enabled: true })
        : apiResponse(null, { success: false, status: 403 });
    }
    if (path.endsWith("/workers/scripts/fixture-brain/subdomain") && method === "GET") {
      return apiResponse({ enabled: routeEnabled });
    }
    if (path === "/client/v4/accounts/fixture-account/workers/subdomain" && method === "GET") {
      return apiResponse({ subdomain: "fixture-account" });
    }
    if (path.endsWith("/workers/scripts/fixture-brain/schedules") && method === "PUT") {
      return schedule === "ok"
        ? apiResponse([])
        : apiResponse(null, { success: false, status: 403 });
    }
    if (path.endsWith("/workers/scripts/fixture-brain/secrets") && method === "GET") {
      return apiResponse([]);
    }
    if (path.endsWith("/workers/scripts/fixture-brain/secrets") && method === "PUT") {
      return apiResponse({});
    }
    throw new Error(`offline fixture has no response for ${method} ${path}`);
  };
  return { fetchImpl, calls, workerMetadata };
}

try {
  /* ---------------- report artifact remains useful, but exit stays truthful */
  assert.equal(reportAcceptanceFailure({ acceptance: { counts: { fail: 0 } } }), null);
  assert.deepEqual(
    reportAcceptanceFailure({ acceptance: { counts: { fail: 2 } } }),
    { kind: "failed", failed: 2 },
  );
  assert.deepEqual(
    reportAcceptanceFailure({ acceptanceError: "fixture stopped", acceptance: { counts: { fail: 0 } } }),
    { kind: "error", failed: 0 },
  );

  const reportManifest = writeManifest(
    "report.manifest.json",
    manifest({ brain: { domain: "fixture.invalid" } }),
  );
  const failedReport = join(sandbox, "failed-report.html");
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: async () => { throw new Error("offline acceptance failure"); },
      env: { ADMIN_KEY: "fixture-admin-value" },
      argv: [process.execPath, "brain.mjs", "test", reportManifest, "--report", failedReport],
    }, () => cmdTest(reportManifest)),
    /report was written, but acceptance FAILED/i,
  );
  assert.equal(existsSync(failedReport), true);
  assert.match(readFileSync(failedReport, "utf8"), /^<!doctype html>/i);

  let reportCall = 0;
  const interruptedReport = join(sandbox, "interrupted-report.html");
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: async () => {
        reportCall++;
        if (reportCall === 1) {
          return new Response(JSON.stringify({ version: "0.1.9" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("offline acceptance interruption");
      },
      env: { ADMIN_KEY: "fixture-admin-value" },
      argv: [process.execPath, "brain.mjs", "test", reportManifest, "--report", interruptedReport],
    }, () => cmdTest(reportManifest)),
    /report was written, but the acceptance checks did not complete/i,
  );
  assert.equal(existsSync(interruptedReport), true);

  /* ---------------- workers.dev is required only without another route */
  assert.equal(workersDevRouteDisposition({ workersDevEnabled: true }), "ready");
  assert.equal(workersDevRouteDisposition({ customDomain: "fixture.invalid" }), "optional");
  assert.equal(workersDevRouteDisposition({}), "required");

  const noRouteManifest = writeManifest("no-route.manifest.json", manifest());
  const noRouteHarness = cloudflareHarness({ routePost: "fail", routeEnabled: false });
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: noRouteHarness.fetchImpl,
      env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value" },
    }, () => cmdDeploy(noRouteManifest)),
    /no usable URL/i,
  );
  assert.equal(noRouteHarness.calls.some((call) => call.path.endsWith("/schedules")), false);

  const existingRouteHarness = cloudflareHarness({ routePost: "fail", routeEnabled: true });
  await isolatedRuntime({
    fetchImpl: existingRouteHarness.fetchImpl,
    env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value" },
  }, () => cmdDeploy(noRouteManifest));
  assert.equal(existingRouteHarness.calls.some((call) => call.path.endsWith("/schedules")), true);

  const customRouteManifest = writeManifest(
    "custom-route.manifest.json",
    manifest({ brain: { domain: "fixture.invalid" } }),
  );
  const customRouteHarness = cloudflareHarness({ routePost: "fail", routeEnabled: false });
  await isolatedRuntime({
    fetchImpl: customRouteHarness.fetchImpl,
    env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value" },
  }, () => cmdDeploy(customRouteManifest));
  assert.equal(customRouteHarness.calls.some((call) => call.path.endsWith("/schedules")), true);

  const cutoverDeployHarness = cloudflareHarness();
  await isolatedRuntime({
    fetchImpl: cutoverDeployHarness.fetchImpl,
    env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value" },
  }, async () => {
    await cmdDeploy(customRouteManifest, { pauseVectorDrainForUpgrade: true });
    await cmdDeploy(customRouteManifest, { pauseVectorDrainForUpgrade: false });
  });
  const pauseBindings = cutoverDeployHarness.workerMetadata[0].bindings;
  const activeBindings = cutoverDeployHarness.workerMetadata[1].bindings;
  assert.deepEqual(
    pauseBindings.filter((binding) => binding.name === "VECTOR_DRAIN_MODE"),
    [{ type: "plain_text", name: "VECTOR_DRAIN_MODE", text: "paused-for-upgrade" }],
  );
  assert.equal(
    activeBindings.some((binding) => binding.name === "VECTOR_DRAIN_MODE"),
    false,
    "the active deploy removes the temporary compatibility binding",
  );

  /* ---------------- D1 semantic drain scheduling is a required deploy step */
  const drainFailureHarness = cloudflareHarness({ schedule: "fail" });
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: drainFailureHarness.fetchImpl,
      env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value" },
    }, () => cmdDeploy(noRouteManifest)),
    /required schedule/i,
  );
  assert.equal(drainFailureHarness.calls.some((call) => call.path.endsWith("/schedules")), true);

  const nonD1Manifest = writeManifest(
    "non-d1.manifest.json",
    manifest({ cloudflare: { storage: "supabase", vectorize_index: null } }),
  );
  const nonD1Harness = cloudflareHarness({ schedule: "fail" });
  await isolatedRuntime({
    fetchImpl: nonD1Harness.fetchImpl,
    env: { CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value" },
  }, () => cmdDeploy(nonD1Manifest));
  assert.equal(nonD1Harness.calls.some((call) => call.path.endsWith("/schedules")), false);

  /* ---------------- optional secret writes cannot hide a missing ADMIN_KEY */
  const secretHarness = cloudflareHarness();
  await assert.rejects(
    isolatedRuntime({
      fetchImpl: secretHarness.fetchImpl,
      env: {
        CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value",
        SUPABASE_URL: "fixture-postgres-location",
      },
    }, () => cmdSecrets(nonD1Manifest)),
    /ADMIN_KEY remains absent/i,
  );
  const secretWrites = secretHarness.calls.filter((call) =>
    call.method === "PUT" && call.path.endsWith("/secrets"));
  assert.deepEqual(
    secretWrites.map((call) => call.secretName),
    ["SUPABASE_URL"],
    "with no admin key there is nothing to derive from, so only the optional secret is written",
  );

  const adminHarness = cloudflareHarness();
  await isolatedRuntime({
    fetchImpl: adminHarness.fetchImpl,
    env: {
      CLOUDFLARE_API_TOKEN: "fixture-cloudflare-value",
      ADMIN_KEY: "fixture-admin-value".padEnd(48, "x"),
    },
  }, () => cmdSecrets(noRouteManifest, { assertKeyDirSafe: () => {} }));
  assert.deepEqual(
    adminHarness.calls
      .filter((call) => call.method === "PUT" && call.path.endsWith("/secrets"))
      .map((call) => call.secretName),
    ["ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY"],
    "a keyed install writes the admin key and both keys derived from it, in that order",
  );

  console.log("report/deploy exit contracts: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
