// From Jay's second field report, 2026-08-19.
//
// `brain upgrade` probed /health, got a 200 from the worker it was REPLACING,
// printed that worker's version, and declared the new one verified:
//
//     ok deployed "bhakta-brain"
//     ok /health 200 {"ok":true,"version":"0.1.1", ...}
//     ok upgrade verified, now at 0.1.2
//
// Sixteen seconds later /health returned 0.1.2, so nothing was harmed that time.
// But the check would pass green on a deploy that genuinely failed, which makes
// it worse than no check: it converts an unknown into a false assurance.

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCELERATED_BOOTSTRAP_MAX_MS,
  ACCELERATED_BOOTSTRAP_MAX_ROUNDS,
  cloudflareTokenAvailable,
  cmdAcceleratedBootstrap,
  cmdRollback,
  cmdRollbackInteractive,
  cmdUpdate,
  cmdUpgrade as cmdUpgradeWithRealQuiescence,
  commitManifestVersion,
  compareSemver,
  healthProbeVerdict,
  runAcceleratedBootstrap,
  validateAcceleratedBootstrapBusyReceipt,
  validateAcceleratedBootstrapCompletion,
  validateAcceleratedBootstrapProgress,
  validateAcceleratedBootstrapReceipt,
  VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS,
  waitForVectorDrainCutover,
} from "../brain.mjs";
import { DRAIN_LEASE_TTL_MS } from "../worker/src/lib/store-d1.js";
import { Acceptance, credentialGateRefusalVerdict } from "../acceptance.mjs";
import {
  installedManifestPointerPath,
  readInstalledManifest,
  rememberInstalledManifest,
} from "../operations/installed-manifest.mjs";

// Every fixture below that says "the running package version" means exactly
// that, so it is read from package.json rather than hardcoded. A literal here
// broke the suite on every release bump (found 0.1.16 -> 0.1.17) while
// asserting nothing extra: the version-alignment invariants live in
// current-version.test.mjs.
const RUNNING_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

// Production waits the full cutover grace. Unit tests inject a zero-time
// waiter while still asserting the exact duration requested by cmdUpgrade.
const cmdUpgrade = (manifestPath, options = {}) => cmdUpgradeWithRealQuiescence(
  manifestPath,
  {
    waitForVectorDrainQuiescence: async () => {},
    cmdBootstrap: async () => bootstrapCompletion(),
    cmdDrain: async () => {},
    ...options,
  },
);

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const V = (o) => healthProbeVerdict(o);
const body = (v) => JSON.stringify({ ok: true, brain: "x", version: v });
const cutoverBody = (v, mode, protocol = "lease-v1") => JSON.stringify({
  ok: true,
  brain: "x",
  version: v,
  vector_writer_protocol: protocol,
  vector_drain_mode: mode,
});

/* ---- the mandatory writer grace cannot look like a hung installer ---- */
{
  const output = [];
  const priorLog = console.log;
  let waited = null;
  try {
    console.log = (...values) => output.push(values.map(String).join(" "));
    await waitForVectorDrainCutover(async (milliseconds) => { waited = milliseconds; });
  } finally {
    console.log = priorLog;
  }
  const rendered = output.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  check(
    "the writer safety pause names its full duration and tells the owner to keep the window open",
    waited === VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS &&
      /waiting 20 minutes/i.test(rendered) && /keep this window open/i.test(rendered) &&
      /migration has not started yet/i.test(rendered) && /pause complete; starting database migration/i.test(rendered),
    rendered,
  );
}
const manifestFixture = (version = "0.1.9") => ({
  client: { slug: "fixture" },
  brain: { worker_name: "fixture-brain", version },
  infrastructure: {
    cloudflare: {
      account_id: "fixture-account",
      d1_database_id: "fixture-database",
      storage: "d1",
    },
  },
  retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", rerank: false },
});

const bootstrapReceipt = (overrides = {}) => ({
  protocol: "bootstrap-v2",
  phase: "building",
  epoch: 1,
  total: 3_000,
  confirmed: 1_000,
  queued: 1_000,
  submitted: 1_000,
  remaining: 2_000,
  in_flight_batches: 2,
  failed: 0,
  complete: false,
  vector_ready: false,
  expected_vectors: 3_000,
  actual_vectors: 1_000,
  ...overrides,
});

const bootstrapResponse = (receipt, status = 200) => new Response(JSON.stringify(receipt), {
  status,
  headers: { "content-type": "application/json" },
});

const bootstrapCompletion = () => ({
  epoch: 1,
  total: 3_000,
  confirmed: 3_000,
  remaining: 0,
  rounds: 3,
  complete: true,
  vector_ready: true,
});

/* ---- the exact failure Jay saw ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("a 200 from the OLD worker is not accepted as the new one", v !== "accept", `got ${v}`);
  check("it retries instead, because propagation is normal", v === "retry", `got ${v}`);
}

{
  check("paused cutover health requires the expected mode and leased writer protocol",
    V({
      ok: true,
      body: cutoverBody(RUNNING_VERSION, "paused-for-upgrade"),
      expectVersion: RUNNING_VERSION,
      expectDrainMode: "paused-for-upgrade",
      attempt: 1,
      attempts: 6,
    }) === "accept");
  check("version-only old health cannot masquerade as a paused compatibility worker",
    V({
      ok: true,
      body: body(RUNNING_VERSION),
      expectVersion: RUNNING_VERSION,
      expectDrainMode: "paused-for-upgrade",
      attempt: 6,
      attempts: 6,
    }) === "fail");
  check("a paused compatibility Worker is retried while active mode propagates",
    V({
      ok: true,
      body: cutoverBody(RUNNING_VERSION, "paused-for-upgrade"),
      expectVersion: RUNNING_VERSION,
      expectDrainMode: "active",
      attempt: 1,
      attempts: 6,
    }) === "retry");
  check("a compatibility Worker still paused after the retry budget fails closed",
    V({
      ok: true,
      body: cutoverBody(RUNNING_VERSION, "paused-for-upgrade"),
      expectVersion: RUNNING_VERSION,
      expectDrainMode: "active",
      attempt: 6,
      attempts: 6,
    }) === "fail");
  check("active mode is accepted only with the leased writer protocol",
    V({
      ok: true,
      body: cutoverBody(RUNNING_VERSION, "active"),
      expectVersion: RUNNING_VERSION,
      expectDrainMode: "active",
      attempt: 2,
      attempts: 6,
    }) === "accept");
  check("the rolling-upgrade grace is never shorter than one supported writer lease",
    VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS >= DRAIN_LEASE_TTL_MS,
    `${VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS} < ${DRAIN_LEASE_TTL_MS}`);
}

/* ---- schema-13 bootstrap receipts are aggregate-only and exact ---- */
{
  const complete = bootstrapReceipt({
    phase: "complete",
    confirmed: 3_000,
    queued: 0,
    submitted: 0,
    remaining: 0,
    in_flight_batches: 0,
    complete: true,
    vector_ready: true,
    expected_vectors: 3_000,
    actual_vectors: 3_000,
  });
  const validated = validateAcceleratedBootstrapReceipt(complete);
  check("a complete bulk-bootstrap receipt proves exact query-visible equality",
    validated.complete === true && validated.confirmed === 3_000 && validated.remaining === 0);
  check("the bootstrap runner has a generous but finite production boundary",
    ACCELERATED_BOOTSTRAP_MAX_MS === 6 * 60 * 60 * 1_000 &&
      ACCELERATED_BOOTSTRAP_MAX_ROUNDS === 20_000);
  check("the active-deploy gate accepts only the runner's exact completion proof",
    validateAcceleratedBootstrapCompletion(bootstrapCompletion()).complete === true);

  let completionShapeError = null;
  try {
    validateAcceleratedBootstrapCompletion({ ...bootstrapCompletion(), failed: 0 });
  } catch (error) { completionShapeError = error; }
  check("the active-deploy gate rejects every extra completion field",
    /aggregate-only response contract/.test(completionShapeError?.message || ""),
    completionShapeError?.message);

  let malformedError = null;
  try {
    validateAcceleratedBootstrapReceipt({
      ...complete,
      source_id: "private-fixture-that-must-not-be-printed",
    });
  } catch (error) { malformedError = error; }
  check("an unexpected identifier field is rejected without echoing it",
    /aggregate-only response contract/.test(malformedError?.message || "") &&
      !/private-fixture/.test(malformedError?.message || ""),
    malformedError?.message);

  let countError = null;
  try {
    validateAcceleratedBootstrapReceipt(bootstrapReceipt({ remaining: 1_999 }));
  } catch (error) { countError = error; }
  check("bootstrap counts must reconcile exactly",
    /counts did not reconcile/.test(countError?.message || ""), countError?.message);

  const busy = validateAcceleratedBootstrapBusyReceipt({
    protocol: "bootstrap-v2",
    busy: true,
    remaining: 2_000,
    retry_after_seconds: 3,
  });
  check("the bounded busy receipt carries only aggregate retry state",
    busy.remaining === 2_000 && busy.retryAfterSeconds === 3);
}

/* ---- the bootstrap loop is sequential, pinned, monotonic, and resumable ---- */
{
  const responses = [
    bootstrapReceipt({
      phase: "legacy_drain",
      confirmed: 0,
      queued: 0,
      submitted: 0,
      remaining: 3_000,
      in_flight_batches: 0,
      actual_vectors: 3_000,
    }),
    bootstrapReceipt(),
    bootstrapReceipt({
      phase: "waiting",
      queued: 0,
      submitted: 2_000,
      in_flight_batches: 2,
      actual_vectors: 2_000,
    }),
    bootstrapReceipt({
      phase: "complete",
      confirmed: 3_000,
      queued: 0,
      submitted: 0,
      remaining: 0,
      in_flight_batches: 0,
      complete: true,
      vector_ready: true,
      expected_vectors: 3_000,
      actual_vectors: 3_000,
    }),
  ];
  const events = [];
  let clock = 0;
  const result = await runAcceleratedBootstrap({
    request: async ({ round, attempt, timeoutMs }) => {
      events.push(`request:${round}.${attempt}`);
      check("each accelerated request receives a bounded timeout",
        timeoutMs >= 1_000 && timeoutMs <= 180_000, String(timeoutMs));
      return bootstrapResponse(responses.shift());
    },
    beforeRequest: async ({ round, attempt }) => events.push(`pin-before:${round}.${attempt}`),
    afterRequest: async ({ round, attempt }) => events.push(`pin-after:${round}.${attempt}`),
    now: () => clock,
    sleep: async (milliseconds) => { events.push(`sleep:${milliseconds}`); clock += milliseconds; },
  });
  check("the accelerated loop finishes only on the exact complete receipt",
    result.complete === true && result.confirmed === 3_000 && result.rounds === 4,
    JSON.stringify(result));
  check("every remote bootstrap attempt is bracketed by manifest pin checks",
    events.filter((event) => event.startsWith("pin-before:")).length === 4 &&
      events.filter((event) => event.startsWith("pin-after:")).length === 4 &&
      events.every((event, index) => !event.startsWith("request:") || (
        events[index - 1] === event.replace("request:", "pin-before:") &&
        events[index + 1] === event.replace("request:", "pin-after:")
      )),
    events.join(","));
  check("legacy cleanup and provider waiting poll instead of hot-looping",
    events.filter((event) => event === "sleep:3000").length === 2, events.join(","));

  let noProgressError = null;
  try {
    const same = validateAcceleratedBootstrapReceipt(bootstrapReceipt());
    validateAcceleratedBootstrapProgress(same, same);
  } catch (error) { noProgressError = error; }
  check("a building response cannot claim progress while every aggregate is unchanged",
    /without aggregate progress/.test(noProgressError?.message || ""), noProgressError?.message);
}

/* ---- receipt transport, busy ownership, and legacy stalls are bounded ---- */
{
  const complete = bootstrapReceipt({
    phase: "complete",
    confirmed: 3_000,
    queued: 0,
    submitted: 0,
    remaining: 0,
    in_flight_batches: 0,
    complete: true,
    vector_ready: true,
    actual_vectors: 3_000,
  });
  let attempts = 0;
  let postChecks = 0;
  const retrySleeps = [];
  const retried = await runAcceleratedBootstrap({
    request: async () => {
      attempts++;
      if (attempts === 1) {
        return {
          status: 200,
          ok: true,
          text: async () => { throw new Error("synthetic private stream detail"); },
        };
      }
      return bootstrapResponse(complete);
    },
    afterRequest: async () => { postChecks++; },
    sleep: async (milliseconds) => { retrySleeps.push(milliseconds); },
  });
  check("an interrupted durable receipt is retried inside the pinned attempt boundary",
    retried.complete === true && attempts === 2 && postChecks === 2 && retrySleeps[0] === 2_000,
    JSON.stringify({ attempts, postChecks, retrySleeps }));

  let clock = 0;
  const busySleeps = [];
  const busyResponses = [
    bootstrapResponse({
      protocol: "bootstrap-v2",
      busy: true,
      remaining: 3_000,
      retry_after_seconds: 180,
    }, 409),
    bootstrapResponse(complete),
  ];
  const afterBusy = await runAcceleratedBootstrap({
    request: async () => busyResponses.shift(),
    now: () => clock,
    sleep: async (milliseconds) => { busySleeps.push(milliseconds); clock += milliseconds; },
  });
  check("a busy bootstrap honors the Worker's requested ownership delay",
    afterBusy.complete === true && busySleeps[0] === 180_000,
    JSON.stringify(busySleeps));

  clock = 0;
  let legacyRequests = 0;
  const legacySleeps = [];
  const legacy = bootstrapReceipt({
    phase: "legacy_drain",
    confirmed: 0,
    queued: 0,
    submitted: 0,
    remaining: 3_000,
    in_flight_batches: 0,
    actual_vectors: 3_000,
  });
  const afterLegacy = await runAcceleratedBootstrap({
    request: async () => {
      legacyRequests++;
      return bootstrapResponse(legacyRequests < 3 ? legacy : complete);
    },
    now: () => clock,
    sleep: async (milliseconds) => { legacySleeps.push(milliseconds); clock += milliseconds; },
  });
  check("an unchanged legacy drain polls with bounded backoff instead of issuing a hot loop",
    afterLegacy.complete === true && legacyRequests === 3 &&
      legacySleeps.join(",") === "3000,3000",
    JSON.stringify({ legacyRequests, legacySleeps }));
}

/* ---- interruption preserves durable progress and a rerun resumes it ---- */
{
  let firstError = null;
  try {
    await runAcceleratedBootstrap({
      request: async () => bootstrapResponse(bootstrapReceipt()),
      maxRounds: 1,
    });
  } catch (error) { firstError = error; }
  check("a bounded interruption gives the exact safe rerun action",
    /1-round safety limit/.test(firstError?.message || "") &&
      /Completed batches are durable.*brain update.*resume/is.test(firstError?.message || ""),
    firstError?.message);

  const resumed = [
    bootstrapReceipt({
      confirmed: 2_000,
      queued: 0,
      submitted: 1_000,
      remaining: 1_000,
      in_flight_batches: 1,
      actual_vectors: 2_000,
    }),
    bootstrapReceipt({
      phase: "complete",
      confirmed: 3_000,
      queued: 0,
      submitted: 0,
      remaining: 0,
      in_flight_batches: 0,
      complete: true,
      vector_ready: true,
      actual_vectors: 3_000,
    }),
  ];
  const result = await runAcceleratedBootstrap({
    request: async () => bootstrapResponse(resumed.shift()),
  });
  check("a later runner accepts the same epoch's advanced durable counters",
    result.complete === true && result.confirmed === 3_000 && result.rounds === 2,
    JSON.stringify(result));
}

/* ---- a provider stall reaches the wall-clock gate without a green exit ---- */
{
  let clock = 0;
  let timedOut = null;
  try {
    await runAcceleratedBootstrap({
      request: async () => bootstrapResponse(bootstrapReceipt({
        phase: "waiting",
        confirmed: 0,
        queued: 0,
        submitted: 3_000,
        remaining: 3_000,
        in_flight_batches: 3,
        actual_vectors: 0,
      })),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      maxDurationMs: 1_000,
    });
  } catch (error) { timedOut = error; }
  check("the bootstrap wall-clock limit fails closed with a resumable action",
    /wall-clock safety limit/.test(timedOut?.message || "") &&
      /3000 aggregate row\(s\) remaining/.test(timedOut?.message || "") &&
      /Worker remains paused/.test(timedOut?.message || ""),
    timedOut?.message);
}

/* ---- the endpoint uses admin auth and an empty POST body ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-bootstrap-http-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const calls = [];
    await cmdAcceleratedBootstrap(manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      baseUrl: "https://fixture.invalid",
      adminKey: "fixture-admin-key",
      http: async (url, init, transport) => {
        calls.push({ url, init, transport });
        return bootstrapResponse(bootstrapReceipt({
          phase: "complete",
          confirmed: 3_000,
          queued: 0,
          submitted: 0,
          remaining: 0,
          in_flight_batches: 0,
          complete: true,
          vector_ready: true,
          actual_vectors: 3_000,
        }));
      },
    });
    check("the accelerated endpoint is an authenticated empty POST",
      calls.length === 1 &&
        calls[0].url === "https://fixture.invalid/api/admin/brain/bootstrap" &&
        calls[0].init.method === "POST" && calls[0].init.redirect === "error" &&
        calls[0].init.headers["X-Admin-Key"] === "fixture-admin-key" &&
        !Object.prototype.hasOwnProperty.call(calls[0].init, "body") &&
        calls[0].transport.timeoutMs <= 180_000,
      JSON.stringify(calls.map((call) => ({ url: call.url, method: call.init.method }))));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- full acceptance independently enforces the deployed version ---- */
{
  const suite = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest: {},
    expectVersion: RUNNING_VERSION,
    fetchImpl: async () => new Response(body("0.1.9"), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await suite.tierReach();
  check("the full acceptance suite rejects an old Worker version",
    suite.results[0]?.status === "fail" &&
      (suite.results[0]?.detail || "").includes(`expected version ${RUNNING_VERSION}`),
    JSON.stringify(suite.results));
}

/* ---- provider acceptance is not semantic visibility ---- */
{
  const inventory = (readiness) => ({
    backend: "d1",
    rows: [{ source_type: "message", total: 1, embedded: 1, last_ingested: new Date().toISOString() }],
    vector_backlog: { pending: readiness.pending, submitted: readiness.submitted },
    vector_readiness: readiness,
  });
  const lagged = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest: manifestFixture(RUNNING_VERSION),
    fetchImpl: async () => new Response(JSON.stringify(inventory({
      ready: false,
      reason: "accepted_mutation_processing",
      expected_vectors: 1,
      actual_vectors: 0,
      pending: 1,
      submitted: 1,
      action: "Run brain drain",
    })), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await lagged.tierData();
  const laggedGate = lagged.results.find((result) => result.name === "semantic index is query-ready");
  check("full acceptance fails while an accepted vector is not query-visible",
    laggedGate?.status === "fail" && /0\/1 vector/.test(laggedGate.detail || ""),
    JSON.stringify(lagged.results));

  const converged = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest: manifestFixture(RUNNING_VERSION),
    fetchImpl: async () => new Response(JSON.stringify(inventory({
      ready: true,
      reason: null,
      expected_vectors: 1,
      actual_vectors: 1,
      pending: 0,
      submitted: 0,
      action: null,
    })), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await converged.tierData();
  check("full acceptance passes exact vector visibility after convergence",
    converged.results.find((result) => result.name === "semantic index is query-ready")?.status === "pass",
    JSON.stringify(converged.results));

  const omittedStorage = manifestFixture(RUNNING_VERSION);
  delete omittedStorage.infrastructure.cloudflare.storage;
  const misbound = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest: omittedStorage,
    fetchImpl: async () => new Response(JSON.stringify({
      backend: "supabase",
      rows: inventory({
        ready: true,
        expected_vectors: 1,
        actual_vectors: 1,
        pending: 0,
        submitted: 0,
      }).rows,
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await misbound.tierData();
  check("omitted manifest storage still requires D1 and refuses a Supabase-bound Worker",
    misbound.results.some((result) =>
      result.name === "storage backend matches manifest" && result.status === "fail" &&
      /expected d1, received supabase/.test(result.detail || "")),
    JSON.stringify(misbound.results));
}

{
  const degraded = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest: manifestFixture(RUNNING_VERSION),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        results: [{ title: "keyword-only fixture" }],
        degraded: "vector",
        answer: "Keyword-only fixture [1]",
        gaps: [],
        q: body.q,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await degraded.tierRetrieval(["fixture query"]);
  check("full acceptance cannot pass keyword-only fallback as semantic retrieval",
    degraded.results.some((result) => result.name === "semantic retrieval is active" && result.status === "fail") &&
      degraded.results.some((result) => result.name === "think uses semantic retrieval" && result.status === "fail"),
    JSON.stringify(degraded.results));
}

/* ---- it must eventually give up rather than pass ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("if the old version is STILL serving on the last attempt, it FAILS", v === "fail", `got ${v}`);
}

/* ---- the happy path still works ---- */
{
  check("the expected version is accepted immediately",
    V({ ok: true, body: body("0.1.2"), expectVersion: "0.1.2", attempt: 1, attempts: 6 }) === "accept");
  check("a plain health check with no expectation still accepts any 200",
    V({ ok: true, body: body("0.1.1"), expectVersion: null, attempt: 1, attempts: 6 }) === "accept");
}

/* ---- a body that cannot be parsed must not be read as success ---- */
{
  const v = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("an unparseable body is not treated as the right version", v !== "accept", `got ${v}`);
  const last = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("and fails once the attempts are spent", last === "fail", `got ${last}`);
}

/* ---- a version-less body is not a pass either ---- */
{
  const v = V({ ok: true, body: JSON.stringify({ ok: true }), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("a 200 carrying no version at all fails rather than passing", v === "fail", `got ${v}`);
}

/* ---- non-200s keep the old retry behaviour ---- */
{
  check("a 404 retries while attempts remain", V({ ok: false, body: "", attempt: 1, attempts: 6 }) === "retry");
  check("and fails when they are spent", V({ ok: false, body: "", attempt: 6, attempts: 6 }) === "fail");
}

/* ---- a normal upgrade reconciles provider secrets before health passes ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-provider-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    const keychainManifest = manifestFixture();
    keychainManifest.operations = {
      admin_key_secret: "keychain://fixture-brain-admin/owner-fixture",
    };
    const syntheticKeychainValue = `fixture-${"private-value".repeat(4)}`;
    writeFileSync(manifestPath, JSON.stringify(keychainManifest));
    const events = [];
    let accountChecks = 0;
    const executionPaths = new Set();
    let privateExecutionPath = null;
    let privateExecutionDirectory = null;
    let d1Version = "0.1.9";
    await cmdUpgrade(manifestPath, {
      resolveAccount: async () => {
        accountChecks++;
        return { id: "fixture-account" };
      },
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
        if (/SELECT \* FROM install_state/i.test(sql)) {
          events.push("state");
          return { results: [{ client_slug: "fixture", product_version: d1Version }] };
        }
        if (/UPDATE install_state/i.test(sql)) {
          events.push("version");
          d1Version = RUNNING_VERSION;
        }
        if (/SELECT product_version FROM install_state/i.test(sql)) {
          events.push("readback");
          return { results: [{ product_version: d1Version }] };
        }
        if (/INSERT INTO upgrade_runs/i.test(sql)) events.push("log");
        return { results: [] };
      },
      cf: async () => {
        events.push("bookmark");
        return { bookmark: "fixture-bookmark" };
      },
      cmdMigrate: async (path, options) => {
        executionPaths.add(path);
        privateExecutionPath = path;
        privateExecutionDirectory = dirname(path);
        events.push("migrate");
        check("only the verified cutover authorizes live writer migrations",
          options?.vectorDrainQuiesced === true, JSON.stringify(options));
        check("a Keychain-backed execution copy is outside the synced manifest parent",
          dirname(path) !== sandbox && !path.startsWith(`${sandbox}/`), path);
        if (process.platform !== "win32") {
          check("the private execution directory is owner-only",
            (lstatSync(dirname(path)).mode & 0o777) === 0o700, String(lstatSync(dirname(path)).mode & 0o777));
          check("the private execution manifest is owner-only",
            (lstatSync(path).mode & 0o777) === 0o600, String(lstatSync(path).mode & 0o777));
        }
        const executionBytes = readFileSync(path, "utf8");
        check("the execution copy carries only the non-secret Keychain locator",
          executionBytes.includes("keychain://fixture-brain-admin/owner-fixture") &&
            !executionBytes.includes(syntheticKeychainValue), executionBytes);
        const originalDuringUpdate = JSON.parse(readFileSync(manifestPath, "utf8"));
        check("the original synced manifest remains separately pinned during remote stages",
          originalDuringUpdate.brain.version === "0.1.9" &&
            originalDuringUpdate.operations.admin_key_secret === keychainManifest.operations.admin_key_secret,
          JSON.stringify(originalDuringUpdate));
      },
      cmdBootstrap: async (path, options) => {
        executionPaths.add(path);
        events.push("bootstrap");
        check("the paused bootstrap receives per-request manifest pin guards",
          typeof options?.beforeRequest === "function" && typeof options?.afterRequest === "function");
        // A large corpus can need hundreds of requests. These guards must pin
        // local bytes without multiplying Cloudflare account-list calls.
        for (let round = 1; round <= 100; round++) {
          await options.beforeRequest({ round, attempt: 1 });
          await options.afterRequest({ round, attempt: 1 });
        }
        return bootstrapCompletion();
      },
      cmdDeploy: async (path, options) => {
        executionPaths.add(path);
        events.push(options?.pauseVectorDrainForUpgrade ? "deploy-paused" : "deploy-active");
        // Model cmdDeploy's legacy no-domain behavior. Without the explicit
        // update override this write changes the pinned execution artifact and
        // the next lifecycle revalidation fails after a live deployment.
        if (options?.persistDomain !== false) {
          const value = JSON.parse(readFileSync(path, "utf8"));
          value.brain.domain = "fixture-brain.owner.workers.dev";
          writeFileSync(path, JSON.stringify(value));
        }
        check("legacy update deploy cannot persist into the pinned manifest",
          options?.persistDomain === false, JSON.stringify(options));
      },
      waitForVectorDrainQuiescence: async (milliseconds) => {
        events.push("quiescence");
        check("upgrade waits one complete supported drain window",
          milliseconds === VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS, String(milliseconds));
      },
      reconcileWorkerProviderSecrets: async (_manifest, account, scriptName, allowed) => {
        events.push("reconcile");
        check("upgrade reconciliation uses the resolved account", account.id === "fixture-account");
        check("upgrade reconciliation targets only this worker", scriptName === "fixture-brain");
        check("standard D1 upgrade allows no provider secrets", Array.isArray(allowed) && allowed.length === 0);
      },
      cmdDrain: async (path) => {
        executionPaths.add(path);
        events.push("drain");
      },
      cmdHealth: async (path, options) => {
        executionPaths.add(path);
        events.push(options.expectDrainMode === "paused-for-upgrade"
          ? "health-paused"
          : options.reachOnly
            ? "health-active-cutover"
            : "health-active-final");
        check("upgrade health requires the running package version", options.expectVersion === RUNNING_VERSION);
        if (options.expectDrainMode === "paused-for-upgrade") {
          check("the compatibility health probe is paused-mode and reach-only",
            options.reachOnly === true, JSON.stringify(options));
        } else if (options.reachOnly) {
          check("the cutover health probe proves active mode before convergence",
            options.expectDrainMode === "active", JSON.stringify(options));
        } else {
          check("the final health probe proves vector draining is active",
            options.expectDrainMode === "active", JSON.stringify(options));
        }
      },
      cmdTest: async (path, options) => {
        executionPaths.add(path);
        events.push("test");
        check("upgrade acceptance requires the running package version", options.expectVersion === RUNNING_VERSION);
      },
      commitManifestVersion: (path, version) => {
        events.push("manifest");
        check("manifest advances only to the running package version", version === RUNNING_VERSION);
        return commitManifestVersion(path, version);
      },
    });
    check(
      "upgrade proves active propagation before secret reconciliation and vector convergence",
      events.join(",") === "state,bookmark,deploy-paused,health-paused,quiescence,migrate,bootstrap,deploy-active,health-active-cutover,reconcile,drain,health-active-final,test,version,readback,manifest,log",
      events.join(","),
    );
    check("remote account revalidation is lifecycle-bounded, not bootstrap-round-bounded",
      accountChecks >= 10 && accountChecks < 30, String(accountChecks));
    check(
      "mutating and acceptance stages use one pinned execution manifest",
      executionPaths.size === 1 && !executionPaths.has(manifestPath),
      JSON.stringify([...executionPaths]),
    );
    check(
      "the private execution manifest and its owner-only directory are removed after success",
      privateExecutionPath && privateExecutionDirectory &&
        !existsSync(privateExecutionPath) && !existsSync(privateExecutionDirectory) &&
        !readdirSync(sandbox).some((name) => name.includes(".brain-update-")),
    );
    const committedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    check("the original manifest commit preserves its Keychain locator without copying a credential",
      committedManifest.brain.version === RUNNING_VERSION &&
        committedManifest.operations.admin_key_secret === keychainManifest.operations.admin_key_secret &&
        !readFileSync(manifestPath, "utf8").includes(syntheticKeychainValue),
      JSON.stringify(committedManifest));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- a legacy non-D1 install has no D1 outbox writer to quiesce ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-non-d1-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    const value = manifestFixture();
    value.infrastructure.cloudflare.storage = "supabase";
    writeFileSync(manifestPath, JSON.stringify(value));
    const events = [];
    let d1Version = "0.1.9";
    await cmdUpgrade(manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
        if (/SELECT \* FROM install_state/i.test(sql)) {
          events.push("state");
          return { results: [{ client_slug: "fixture", product_version: d1Version }] };
        }
        if (/UPDATE install_state/i.test(sql)) {
          events.push("version");
          d1Version = RUNNING_VERSION;
        }
        if (/SELECT product_version/i.test(sql)) {
          events.push("readback");
          return { results: [{ product_version: d1Version }] };
        }
        if (/INSERT INTO upgrade_runs/i.test(sql)) events.push("log");
        return { results: [] };
      },
      cf: async () => { events.push("bookmark"); return { bookmark: "non-d1-bookmark" }; },
      cmdMigrate: async (path, options) => {
        events.push("migrate");
        check("a legacy adjacent-key manifest keeps its execution copy beside the manifest",
          dirname(path) === sandbox && path !== manifestPath, path);
        check("non-D1 migration does not claim a vector-writer cutover",
          options?.vectorDrainQuiesced !== true, JSON.stringify(options));
      },
      cmdDeploy: async (_path, options) => {
        events.push("deploy");
        check("non-D1 upgrade uses one ordinary deployment",
          options?.pauseVectorDrainForUpgrade === undefined, JSON.stringify(options));
      },
      waitForVectorDrainQuiescence: async () => { events.push("unexpected-wait"); },
      reconcileWorkerProviderSecrets: async () => { events.push("reconcile"); },
      cmdHealth: async (_path, options) => {
        events.push("health");
        check("non-D1 final health has no D1 drain-mode requirement",
          options.expectDrainMode === null, JSON.stringify(options));
      },
      cmdTest: async () => { events.push("test"); },
      commitManifestVersion: (path, version) => {
        events.push("manifest");
        return commitManifestVersion(path, version);
      },
    });
    check("non-D1 upgrade skips the compatibility pause and grace",
      events.join(",") === "state,bookmark,migrate,deploy,reconcile,health,test,version,readback,manifest,log",
      events.join(","));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- no restore bookmark means no mutation at all ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-bookmark-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const mutations = [];
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_a, _d, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/^SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          mutations.push(`d1:${sql.slice(0, 12)}`);
          return { results: [] };
        },
        cf: async () => ({}),
        cmdMigrate: async () => mutations.push("migrate"),
        cmdDeploy: async () => mutations.push("deploy"),
      });
    } catch (caught) { error = caught; }
    check("a missing bookmark aborts before every mutation",
      /required D1 restore bookmark/.test(error?.message || "") && mutations.length === 0,
      `${error?.message}; ${mutations.join(",")}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- acceptance failure cannot advance either version ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-acceptance-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let versionWrites = 0;
    let manifestWrites = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_a, _d, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/UPDATE install_state/i.test(sql)) versionWrites++;
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "fixture-required-bookmark" }),
        cmdMigrate: async () => {},
        cmdDeploy: async () => {},
        reconcileWorkerProviderSecrets: async () => {},
        cmdHealth: async () => {},
        cmdTest: async () => { throw new Error("acceptance fixture failed"); },
        commitManifestVersion: () => { manifestWrites++; },
      });
    } catch (caught) { error = caught; }
    check("failed acceptance leaves D1 and manifest versions unchanged",
      versionWrites === 0 && manifestWrites === 0 &&
        JSON.parse(readFileSync(manifestPath, "utf8")).brain.version === "0.1.9",
      `d1=${versionWrites} manifest=${manifestWrites}`);
    check("every post-snapshot failure preserves the recovery bookmark",
      /fixture-required-bookmark/.test(error?.message || "") && /full acceptance test/.test(error?.message || ""),
      error?.message);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- cutover failures stay fail-closed and never advance versions ---- */
{
  const runFailure = async (failureStage) => {
    const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), `brain-cutover-${failureStage}-`)));
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const events = [];
    let versionWrites = 0;
    let manifestWrites = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          if (/UPDATE install_state/i.test(sql)) versionWrites++;
          return { results: [] };
        },
        cf: async () => ({ bookmark: `${failureStage}-bookmark` }),
        cmdDeploy: async (_path, options) => {
          const mode = options.pauseVectorDrainForUpgrade ? "paused" : "active";
          events.push(`deploy-${mode}`);
          if (failureStage === "active-deploy" && mode === "active") {
            throw new Error("synthetic final upload ambiguity");
          }
        },
        cmdHealth: async (_path, options) => {
          const mode = options.expectDrainMode === "paused-for-upgrade" ? "paused" : "active";
          events.push(`health-${mode}${options.reachOnly ? "-reach" : "-full"}`);
          if (failureStage === "active-health" && mode === "active" && options.reachOnly) {
            throw new Error("synthetic paused deployment still serving");
          }
        },
        waitForVectorDrainQuiescence: async () => { events.push("wait"); },
        cmdMigrate: async (_path, options) => {
          events.push(`migrate-${options?.vectorDrainQuiesced === true}`);
          if (failureStage === "migration") throw new Error("synthetic migration failure");
        },
        cmdBootstrap: async (_path, options) => {
          events.push("bootstrap");
          if (failureStage === "bootstrap-pin-drift") {
            await options.beforeRequest({ round: 1, attempt: 1 });
            events.push("bootstrap-receipt");
            const changed = JSON.parse(readFileSync(manifestPath, "utf8"));
            changed.client.slug = "changed-after-receipt";
            writeFileSync(manifestPath, JSON.stringify(changed));
            await options.afterRequest({ round: 1, attempt: 1 });
          }
          if (failureStage === "bootstrap") {
            return { ...bootstrapCompletion(), complete: false, vector_ready: false, remaining: 1_000 };
          }
          return bootstrapCompletion();
        },
        reconcileWorkerProviderSecrets: async () => { events.push("reconcile"); },
        cmdDrain: async () => {
          events.push("converge");
          if (failureStage === "convergence") throw new Error("synthetic bootstrap deadline");
        },
        cmdTest: async () => { events.push("acceptance"); },
        commitManifestVersion: () => { manifestWrites++; },
      });
    } catch (caught) { error = caught; }
    const manifestVersion = JSON.parse(readFileSync(manifestPath, "utf8")).brain.version;
    rmSync(sandbox, { recursive: true, force: true });
    return { events, error, versionWrites, manifestWrites, manifestVersion };
  };

  const migrationFailure = await runFailure("migration");
  check("migration failure leaves the compatibility Worker paused and versions uncommitted",
    migrationFailure.events.join(",") === "deploy-paused,health-paused-reach,wait,migrate-true" &&
      migrationFailure.versionWrites === 0 && migrationFailure.manifestWrites === 0 &&
      migrationFailure.manifestVersion === "0.1.9" &&
      /migration-bookmark/.test(migrationFailure.error?.message || "") &&
      /run brain update again/i.test(migrationFailure.error?.message || ""),
    JSON.stringify({ ...migrationFailure, error: migrationFailure.error?.message }));

  // The pause itself is correct: a half-migrated schema must not meet live
  // writers. What was wrong is that the operator was never told, so one field
  // install sat unable to accept a document for eight days while /health
  // reported ok. A failure inside the paused window has to say so.
  const pausedWarning = /CANNOT ACCEPT DOCUMENTS/i;
  check("a failure inside the paused window tells the operator the brain is not accepting documents",
    pausedWarning.test(migrationFailure.error?.message || "") &&
      /do not clear VECTOR_DRAIN_MODE by hand/i.test(migrationFailure.error?.message || "") &&
      /brain health/i.test(migrationFailure.error?.message || ""),
    migrationFailure.error?.message);

  const deployFailure = await runFailure("active-deploy");
  check("an ambiguous final upload stops before health, acceptance, and version commits",
    deployFailure.events.join(",") === "deploy-paused,health-paused-reach,wait,migrate-true,bootstrap,deploy-active" &&
      deployFailure.versionWrites === 0 && deployFailure.manifestWrites === 0 &&
      deployFailure.manifestVersion === "0.1.9" &&
      /active-deploy-bookmark/.test(deployFailure.error?.message || "") &&
      /active vector-drain deployment/.test(deployFailure.error?.message || ""),
    JSON.stringify({ ...deployFailure, error: deployFailure.error?.message }));

  const bootstrapPinDrift = await runFailure("bootstrap-pin-drift");
  check("manifest drift after receipt bytes arrive prevents the active deployment",
    bootstrapPinDrift.events.join(",") ===
      "deploy-paused,health-paused-reach,wait,migrate-true,bootstrap,bootstrap-receipt" &&
      bootstrapPinDrift.versionWrites === 0 && bootstrapPinDrift.manifestWrites === 0 &&
      bootstrapPinDrift.manifestVersion === "0.1.9" &&
      /manifest changed during accelerated legacy vector bootstrap request 1\.1 receipt/.test(
        bootstrapPinDrift.error?.message || "") &&
      /bootstrap-pin-drift-bookmark/.test(bootstrapPinDrift.error?.message || ""),
    JSON.stringify({ ...bootstrapPinDrift, error: bootstrapPinDrift.error?.message }));

  const bootstrapFailure = await runFailure("bootstrap");
  check("an incomplete accelerated bootstrap cannot deploy active mode",
    bootstrapFailure.events.join(",") ===
      "deploy-paused,health-paused-reach,wait,migrate-true,bootstrap" &&
      bootstrapFailure.versionWrites === 0 && bootstrapFailure.manifestWrites === 0 &&
      bootstrapFailure.manifestVersion === "0.1.9" &&
      /accelerated legacy vector bootstrap/.test(bootstrapFailure.error?.message || "") &&
      /bootstrap-bookmark/.test(bootstrapFailure.error?.message || ""),
    JSON.stringify({ ...bootstrapFailure, error: bootstrapFailure.error?.message }));

  const activeHealthFailure = await runFailure("active-health");
  check("a still-paused deployment stops before reconciliation, convergence, and version commits",
    activeHealthFailure.events.join(",") ===
      "deploy-paused,health-paused-reach,wait,migrate-true,bootstrap,deploy-active,health-active-reach" &&
      activeHealthFailure.versionWrites === 0 && activeHealthFailure.manifestWrites === 0 &&
      activeHealthFailure.manifestVersion === "0.1.9" &&
      /active vector-drain health verification/.test(activeHealthFailure.error?.message || "") &&
      /active-health-bookmark/.test(activeHealthFailure.error?.message || ""),
    JSON.stringify({ ...activeHealthFailure, error: activeHealthFailure.error?.message }));

  const convergenceFailure = await runFailure("convergence");
  check("a failure after writes resume does NOT claim the brain is paused",
    !/CANNOT ACCEPT DOCUMENTS/i.test(convergenceFailure.error?.message || ""),
    convergenceFailure.error?.message);
  check("an incomplete projection bootstrap blocks health, acceptance, and every version commit",
    convergenceFailure.events.join(",") ===
      "deploy-paused,health-paused-reach,wait,migrate-true,bootstrap,deploy-active,health-active-reach,reconcile,converge" &&
      convergenceFailure.versionWrites === 0 && convergenceFailure.manifestWrites === 0 &&
      convergenceFailure.manifestVersion === "0.1.9" &&
      /vector projection convergence/.test(convergenceFailure.error?.message || "") &&
      /convergence-bookmark/.test(convergenceFailure.error?.message || ""),
    JSON.stringify({ ...convergenceFailure, error: convergenceFailure.error?.message }));
}

/* ---- manifest version commit is atomic and verified ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-manifest-version-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture(), null, 2) + "\n");
    commitManifestVersion(manifestPath, RUNNING_VERSION);
    const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    check("the local manifest records the verified package version", committed.brain.version === RUNNING_VERSION);
    check("the manifest commit leaves no temporary file", !readdirSync(sandbox).some((name) => name.endsWith(".tmp")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- the credential gate is proven by its exact structured contract ---- */
{
  const refusal = {
    error: "refused: content carries live credential(s)",
    labels: ["cloudflare_token_new", "env_assignment"],
    detail: "Rotate them, strip them from the source, then re-ingest. Nothing was written.",
  };
  check(
    "credential acceptance requires the production HTTP 422 structure",
    credentialGateRefusalVerdict({ status: 422, text: JSON.stringify(refusal) }).accepted,
  );
  check(
    "a bare 422 is not mistaken for the credential scanner",
    !credentialGateRefusalVerdict({ status: 422, text: "unprocessable" }).accepted,
  );
  check(
    "an unrelated structured 422 is not mistaken for the credential scanner",
    !credentialGateRefusalVerdict({ status: 422, text: JSON.stringify({ error: "refused" }) }).accepted,
  );
  check(
    "a refusal that does not name the Cloudflare canary is not accepted",
    !credentialGateRefusalVerdict({ status: 422, text: JSON.stringify({ ...refusal, labels: ["env_assignment"] }) }).accepted,
  );
  check(
    "the right body on the wrong HTTP status is not accepted",
    !credentialGateRefusalVerdict({ status: 400, text: JSON.stringify(refusal) }).accepted,
  );
}

/* ---- semantic-version ordering refuses a downgrade before mutation ---- */
{
  check("semantic versions compare numeric components", compareSemver("0.1.11", "0.1.10") > 0);
  check("a release sorts after its prerelease", compareSemver("1.0.0", "1.0.0-rc.1") > 0);

  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-downgrade-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.2.0")));
    let mutations = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => /sqlite_master/i.test(sql)
          ? { results: [{ name: "install_state" }] }
          : { results: [{ client_slug: "fixture", product_version: "0.2.0" }] },
        cf: async () => { mutations++; return { bookmark: "must-not-exist" }; },
        cmdMigrate: async () => { mutations++; },
        cmdDeploy: async () => { mutations++; },
      });
    } catch (caught) { error = caught; }
    check(
      "a newer installed version is never downgraded by an older CLI",
      /refused to downgrade/.test(error?.message || "") && mutations === 0,
      `${error?.message}; mutations=${mutations}`,
    );
    check(
      "downgrade refusal cleans its pinned execution manifest",
      !readdirSync(sandbox).some((name) => name.includes(".brain-update-")),
    );

    const localNewerPath = join(sandbox, "local-newer.manifest.json");
    writeFileSync(localNewerPath, JSON.stringify(manifestFixture("0.2.0")));
    let localNewerError = null;
    try {
      await cmdUpgrade(localNewerPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => /sqlite_master/i.test(sql)
          ? { results: [{ name: "install_state" }] }
          : { results: [{ client_slug: "fixture", product_version: "0.1.9" }] },
        cf: async () => { mutations++; return { bookmark: "must-not-exist" }; },
      });
    } catch (caught) { localNewerError = caught; }
    check(
      "a newer pinned manifest also prevents an older CLI from mutating D1",
      /refused to downgrade/.test(localNewerError?.message || "") && mutations === 0,
      `${localNewerError?.message}; mutations=${mutations}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- absent legacy state is allowed; an unreadable state is not ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-state-")));
  try {
    const unreadablePath = join(sandbox, "unreadable.manifest.json");
    writeFileSync(unreadablePath, JSON.stringify(manifestFixture()));
    let remoteMutations = 0;
    let unreadableError = null;
    try {
      await cmdUpgrade(unreadablePath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async () => { throw new Error("synthetic D1 outage"); },
        cf: async () => { remoteMutations++; return { bookmark: "not-allowed" }; },
        cmdMigrate: async () => { remoteMutations++; },
      });
    } catch (caught) { unreadableError = caught; }
    check(
      "a D1 read failure stops before bookmark or migration",
      /install state could not be read/.test(unreadableError?.message || "") && remoteMutations === 0,
      unreadableError?.message,
    );

    const legacyPath = join(sandbox, "legacy.manifest.json");
    writeFileSync(legacyPath, JSON.stringify(manifestFixture()));
    let d1Version = null;
    await cmdUpgrade(legacyPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [] };
        if (/UPDATE install_state/i.test(sql)) d1Version = RUNNING_VERSION;
        if (/SELECT product_version FROM install_state/i.test(sql)) {
          return { results: [{ product_version: d1Version }] };
        }
        return { results: [] };
      },
      cf: async () => ({ bookmark: "legacy-bookmark" }),
      cmdMigrate: async () => {},
      cmdDeploy: async () => {},
      reconcileWorkerProviderSecrets: async () => {},
      cmdHealth: async () => {},
      cmdTest: async () => {},
    });
    check(
      "a successful empty install_state read follows the legacy migration path",
      JSON.parse(readFileSync(legacyPath, "utf8")).brain.version === RUNNING_VERSION,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- unsafe manifest paths stop before account or database access ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-path-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const symlinkPath = join(sandbox, "linked.manifest.json");
    symlinkSync(manifestPath, symlinkPath);
    let remoteReads = 0;
    let symlinkError = null;
    try {
      await cmdUpgrade(symlinkPath, {
        resolveAccount: async () => { remoteReads++; return { id: "fixture-account" }; },
      });
    } catch (caught) { symlinkError = caught; }
    check(
      "a symlink manifest is refused before any Cloudflare access",
      /regular file, not a link/.test(symlinkError?.message || "") && remoteReads === 0,
      symlinkError?.message,
    );

    const hardlinkPath = join(sandbox, "hardlinked.manifest.json");
    linkSync(manifestPath, hardlinkPath);
    let hardlinkError = null;
    try {
      await cmdUpgrade(hardlinkPath, {
        resolveAccount: async () => { remoteReads++; return { id: "fixture-account" }; },
      });
    } catch (caught) { hardlinkError = caught; }
    check(
      "a hard-linked manifest is refused before any Cloudflare access",
      /regular file, not a link/.test(hardlinkError?.message || "") && remoteReads === 0,
      hardlinkError?.message,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- manifest and account identity stay pinned between every stage ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-drift-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let deployed = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "drift-bookmark" }),
        cmdMigrate: async () => {
          writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.1.8")));
        },
        cmdDeploy: async () => { deployed++; },
        cmdHealth: async () => {},
      });
    } catch (caught) { error = caught; }
    check(
      "a manifest fingerprint change stops before the next remote stage",
      /manifest changed during migration/.test(error?.message || "") && deployed === 1,
      error?.message,
    );
    check(
      "beginner failure guidance does not present incomplete rollback as one command",
      !/brain rollback/.test(error?.message || "") && /does not restore Vectorize/.test(error?.message || ""),
      error?.message,
    );
    check(
      "failed drift detection removes the pinned execution manifest",
      !readdirSync(sandbox).some((name) => name.includes(".brain-update-")),
    );

    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let resolvedAccount = "fixture-account";
    let secondDeploy = 0;
    let accountError = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: resolvedAccount }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "account-bookmark" }),
        cmdMigrate: async () => { resolvedAccount = "other-account"; },
        cmdDeploy: async () => { secondDeploy++; },
        cmdHealth: async () => {},
      });
    } catch (caught) { accountError = caught; }
    check(
      "a changed token account stops before the next remote stage",
      /account identity changed during accelerated legacy vector bootstrap/.test(accountError?.message || "") && secondDeploy === 1,
      accountError?.message,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- rollback is a preview until explicit confirmation ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-rollback-confirmation-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let accountReads = 0;
    let remoteMutations = 0;
    let historyWrites = 0;
    const output = [];
    const priorLog = console.log;
    let preview;
    try {
      console.log = (...values) => output.push(values.map(String).join(" "));
      preview = await cmdRollback(manifestPath, "fixture-bookmark", {
        resolveAccount: async () => { accountReads++; return { id: "fixture-account" }; },
        cf: async () => { remoteMutations++; },
        d1Query: async () => { historyWrites++; },
      });
    } finally {
      console.log = priorLog;
    }
    const rendered = output.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    check(
      "direct rollback preview requires supervised clean-index recovery before reindex",
      preview?.confirmed === false && preview?.restored === false &&
        /nothing was changed/i.test(rendered) && /D1 restore is DESTRUCTIVE/i.test(rendered) &&
        /does not restore Vectorize/i.test(rendered) && /supervised index recreation before reindex/i.test(rendered) &&
        /--yes/.test(rendered),
      rendered,
    );
    check(
      "direct rollback preview performs no account read, Cloudflare mutation, or history write",
      accountReads === 0 && remoteMutations === 0 && historyWrites === 0,
      JSON.stringify({ accountReads, remoteMutations, historyWrites }),
    );

    let invalidBookmarkError = null;
    let invalidBookmarkTokenPrompts = 0;
    try {
      await cmdRollbackInteractive(manifestPath, "not\na\nvalid\nbookmark", {
        readCloudflareToken: async () => {
          invalidBookmarkTokenPrompts++;
          return Buffer.from("x".repeat(24), "ascii");
        },
      });
    } catch (caught) { invalidBookmarkError = caught; }
    check(
      "an invalid rollback bookmark is refused before the token boundary",
      /bookmark is invalid/.test(invalidBookmarkError?.message || "") && invalidBookmarkTokenPrompts === 0,
      invalidBookmarkError?.message,
    );

    const actions = [];
    const restored = await cmdRollback(manifestPath, "fixture-bookmark", {
      confirmed: true,
      resolveAccount: async () => { actions.push("account"); return { id: "fixture-account" }; },
      cmdDeploy: async (_path, options) => {
        actions.push(options.pauseVectorDrainForUpgrade ? "deploy-paused" : "deploy-active");
        check("rollback deploys only explicit paused or active writer mode",
          options.persistDomain === false && typeof options.pauseVectorDrainForUpgrade === "boolean",
          JSON.stringify(options));
      },
      cmdHealth: async (_path, options) => {
        actions.push(options.expectDrainMode === "paused-for-upgrade" ? "health-paused" : "health-active");
        check("rollback proves exact paused writer mode before restore",
          options.expectVersion === RUNNING_VERSION && options.reachOnly === true &&
            options.expectDrainMode === "paused-for-upgrade",
          JSON.stringify(options));
      },
      waitForVectorDrainQuiescence: async (milliseconds) => {
        actions.push("quiesce");
        check("rollback waits one full old-writer window before D1 time travel",
          milliseconds === VECTOR_DRAIN_CUTOVER_QUIESCENCE_MS, String(milliseconds));
      },
      cf: async (path, request) => {
        actions.push("restore");
        check(
          "confirmed rollback restores only the pinned database bookmark",
          request?.method === "POST" &&
            path === "/accounts/fixture-account/d1/database/fixture-database/time_travel/restore?bookmark=fixture-bookmark",
          `${request?.method} ${path}`,
        );
      },
      d1Query: async (_account, _database, sql) => {
        if (/SELECT schema_version FROM install_state/.test(sql)) {
          actions.push("schema");
          return { results: [{ schema_version: 13 }] };
        }
        if (/UPDATE install_state/.test(sql)) {
          actions.push("invalidate");
          check("rollback clears restored lease ownership before supervised recovery",
            /vector_drain_lease_owner\s*=\s*NULL/.test(sql) &&
              /vector_drain_lease_expires_at\s*=\s*NULL/.test(sql) &&
              /vector_projection_bootstrap_protocol\s*=\s*NULL/.test(sql) &&
              /vector_projection_bootstrap_base_count\s*=\s*0/.test(sql), sql);
          return { results: [], meta: { changes: 1 } };
        }
        if (/DELETE FROM vector_bootstrap_batches/.test(sql)) {
          actions.push("reset-batches");
          return { results: [], meta: { changes: 2 } };
        }
        if (/UPDATE vector_outbox/.test(sql)) {
          actions.push("reset-receipts");
          check("rollback clears provider receipts and bulk batch tags together",
            /bootstrap_epoch\s*=\s*NULL/.test(sql) &&
              /bootstrap_batch\s*=\s*NULL/.test(sql), sql);
          return { results: [], meta: { changes: 1 } };
        }
        if (/SELECT vector_projection_status/.test(sql)) {
          actions.push("readback");
          return { results: [{
            status: "bootstrap_required",
            lease_owner: null,
            lease_expires_at: null,
            mutation_id: null,
            mutation_submitted_at: null,
            cursor: null,
            high_water: "fixture#9",
            chunk_high_water: "fixture#9",
            submitted_rows: 0,
            bootstrap_protocol: null,
            bootstrap_base_count: 0,
            bootstrap_batch_count: 0,
            tagged_rows: 0,
          }] };
        }
        actions.push("history");
        check("confirmed rollback marks its history as rolled back", /status = 'rolled_back'/.test(sql), sql);
        return { results: [] };
      },
    });
    check(
      "explicit confirmation is the only path that performs the restore",
      restored?.confirmed === true && restored?.restored === true &&
        restored?.requiresVectorizeRecreation === true &&
        actions.join(",") === "account,deploy-paused,health-paused,quiesce,restore,schema,invalidate,reset-batches,reset-receipts,readback,history",
      actions.join(","),
    );
    check("rollback never reactivates a Worker against an orphaned provider index",
      !actions.includes("deploy-active") && !actions.includes("health-active"), actions.join(","));

    const schema12Sql = [];
    const schema12Restore = await cmdRollback(manifestPath, "fixture-bookmark", {
      confirmed: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      cmdDeploy: async () => {},
      cmdHealth: async () => {},
      waitForVectorDrainQuiescence: async () => {},
      cf: async () => {},
      d1Query: async (_account, _database, sql) => {
        schema12Sql.push(sql);
        if (/SELECT schema_version FROM install_state/.test(sql)) {
          return { results: [{ schema_version: 12 }] };
        }
        if (/SELECT vector_projection_status/.test(sql)) {
          return { results: [{
            status: "bootstrap_required",
            lease_owner: null,
            lease_expires_at: null,
            mutation_id: null,
            mutation_submitted_at: null,
            cursor: null,
            high_water: "fixture#9",
            chunk_high_water: "fixture#9",
            submitted_rows: 0,
          }] };
        }
        return { results: [], meta: { changes: 1 } };
      },
    });
    check("a schema-12 restore uses its prefix-safe receipt reset without schema-13 names",
      schema12Restore?.restored === true &&
        schema12Sql.some((sql) => /UPDATE install_state/.test(sql)) &&
        schema12Sql.some((sql) => /UPDATE vector_outbox/.test(sql)) &&
        !schema12Sql.some((sql) =>
          /vector_bootstrap_batches|vector_projection_bootstrap_protocol|\bbootstrap_epoch\s*=\s*NULL|\bbootstrap_batch\s*=/.test(sql)),
      schema12Sql.join("\n"));

    const prefixActions = [];
    let prefixRollbackError = null;
    try {
      await cmdRollback(manifestPath, "fixture-bookmark", {
        confirmed: true,
        resolveAccount: async () => ({ id: "fixture-account" }),
        cmdDeploy: async (_path, options) => {
          prefixActions.push(options.pauseVectorDrainForUpgrade ? "deploy-paused" : "DEPLOY-ACTIVE");
        },
        cmdHealth: async (_path, options) => {
          prefixActions.push(`health:${options.expectDrainMode}`);
        },
        waitForVectorDrainQuiescence: async () => { prefixActions.push("quiesce"); },
        cf: async () => { prefixActions.push("restore-prefix"); },
        d1Query: async (_account, _database, sql) => {
          prefixActions.push("schema-prefix-read");
          if (/SELECT schema_version FROM install_state/.test(sql)) {
            return { results: [{ schema_version: 11 }] };
          }
          throw new Error("unexpected prefix mutation");
        },
      });
    } catch (caught) { prefixRollbackError = caught; }
    check(
      "a pre-schema12 bookmark fails closed after restore with the Worker still paused",
      /Worker remains paused.*brain update.*forward-migrate/is.test(prefixRollbackError?.message || "") &&
        prefixActions.join(",") ===
          "deploy-paused,health:paused-for-upgrade,quiesce,restore-prefix,schema-prefix-read" &&
        !prefixActions.includes("DEPLOY-ACTIVE"),
      `${prefixRollbackError?.message}; ${prefixActions.join(",")}`,
    );

    let ownershipError = null;
    let wrongAccountMutation = 0;
    try {
      await cmdRollback(manifestPath, "fixture-bookmark", {
        confirmed: true,
        resolveAccount: async () => ({ id: "wrong-account" }),
        cf: async () => { wrongAccountMutation++; },
      });
    } catch (caught) { ownershipError = caught; }
    check(
      "confirmed rollback still refuses a token account outside the pinned manifest",
      /token account does not match/.test(ownershipError?.message || "") && wrongAccountMutation === 0,
      ownershipError?.message,
    );

    let manifestDriftError = null;
    let driftMutation = 0;
    try {
      await cmdRollback(manifestPath, "fixture-bookmark", {
        confirmed: true,
        resolveAccount: async () => {
          writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.1.8")));
          return { id: "fixture-account" };
        },
        cf: async () => { driftMutation++; },
      });
    } catch (caught) { manifestDriftError = caught; }
    check(
      "confirmed rollback revalidates the pinned manifest before restore",
      /manifest changed during rollback preflight/.test(manifestDriftError?.message || "") && driftMutation === 0,
      manifestDriftError?.message,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- direct beginner update and rollback wrappers own the token lifecycle ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-update-command-")));
  const priorDirectory = process.cwd();
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const installedManifestOptions = {
      home: sandbox,
      stateDirectory: join(sandbox, "installed-state"),
    };
    process.chdir(sandbox);
    let failedVerifyError = null;
    let failedVerifyUpgrade = 0;
    try {
      await cmdUpdate(undefined, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("f".repeat(24), "ascii"),
        cmdVerify: async () => { throw new Error("fixture custody refusal"); },
        cmdUpgrade: async () => { failedVerifyUpgrade++; },
      });
    } catch (caught) { failedVerifyError = caught; }
    check(
      "a failed custody check does not remember the wrong manifest",
      /fixture custody refusal/.test(failedVerifyError?.message || "") &&
        !existsSync(installedManifestPointerPath(installedManifestOptions)) &&
        failedVerifyUpgrade === 0 && !cloudflareTokenAvailable(),
      failedVerifyError?.message,
    );

    const events = [];
    await cmdUpdate(undefined, {
      installedManifestOptions,
      readCloudflareToken: async () => Buffer.from("x".repeat(24), "ascii"),
      cmdVerify: async (path) => {
        events.push(`verify:${path}`);
        check("update verification runs inside the command-scoped token", cloudflareTokenAvailable());
      },
      cmdUpgrade: async (path) => {
        events.push(`upgrade:${path}`);
        check("update execution keeps the command-scoped token", cloudflareTokenAvailable());
      },
    });
    check(
      "brain update discovers the local manifest once and verifies before upgrade",
      events.join(",") === `verify:${manifestPath},upgrade:${manifestPath}`,
      events.join(","),
    );
    check(
      "the first update remembers the canonical manifest without storing credentials",
      readInstalledManifest(installedManifestOptions) === manifestPath &&
        Object.keys(JSON.parse(readFileSync(installedManifestPointerPath(installedManifestOptions), "utf8")))
          .sort().join(",") === "manifest_path,schema_version",
    );
    const durabilityStateDirectory = join(sandbox, "durability-order-state");
    let synchronizedAfterRename = false;
    const durabilityOptions = {
      home: sandbox,
      stateDirectory: durabilityStateDirectory,
      syncStateDirectory: (directory, phase) => {
        const pointerPath = installedManifestPointerPath({ stateDirectory: directory });
        synchronizedAfterRename = phase === "persisted" && existsSync(pointerPath) &&
          JSON.parse(readFileSync(pointerPath, "utf8")).manifest_path === manifestPath;
      },
    };
    rememberInstalledManifest(manifestPath, durabilityOptions);
    check(
      "the pointer durability barrier runs after the atomic rename",
      synchronizedAfterRename && readInstalledManifest(durabilityOptions) === manifestPath,
    );

    const failingDurabilityState = join(sandbox, "durability-failure-state");
    let durabilityError = null;
    try {
      rememberInstalledManifest(manifestPath, {
        home: sandbox,
        stateDirectory: failingDurabilityState,
        syncStateDirectory: () => {
          throw Object.assign(new Error("synthetic private filesystem detail"), { code: "EIO" });
        },
      });
    } catch (caught) { durabilityError = caught; }
    check(
      "an unexpected directory durability failure is never reported as success",
      durabilityError?.code === "INSTALLED_MANIFEST_STATE_DURABILITY" &&
        !String(durabilityError?.message || durabilityError).includes("synthetic private filesystem detail") &&
        !readdirSync(failingDurabilityState).some((name) => name.endsWith(".tmp")),
      durabilityError?.message,
    );
    const windowsFallbackOptions = {
      home: sandbox,
      platform: "win32",
      stateDirectory: join(sandbox, "windows-directory-sync-fallback"),
      syncStateDirectory: () => {
        throw Object.assign(new Error("synthetic unsupported directory handle"), { code: "EINVAL" });
      },
    };
    rememberInstalledManifest(manifestPath, windowsFallbackOptions);
    check(
      "Windows directory-fsync limitations fall back to a verified final-file flush",
      readInstalledManifest(windowsFallbackOptions) === manifestPath,
    );
    if (process.platform !== "win32") {
      check(
        "the remembered location is private",
        (lstatSync(installedManifestPointerPath(installedManifestOptions)).mode & 0o777) === 0o600 &&
          (lstatSync(installedManifestOptions.stateDirectory).mode & 0o777) === 0o700,
      );
    }
    check("the prompted Cloudflare token is gone after update", !cloudflareTokenAvailable());

    const unrelatedManifest = join(sandbox, "unrelated.manifest.json");
    writeFileSync(unrelatedManifest, "{}\n");
    let unrelatedError = null;
    let unrelatedVerify = 0;
    try {
      await cmdUpdate(unrelatedManifest, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("q".repeat(24), "ascii"),
        cmdVerify: async () => { unrelatedVerify++; },
      });
    } catch (caught) { unrelatedError = caught; }
    check(
      "an unrelated JSON object is not remembered when upgrade preflight rejects it",
      unrelatedVerify === 1 &&
        /no d1_database_id in the manifest/i.test(unrelatedError?.message || "") &&
        readInstalledManifest(installedManifestOptions) === manifestPath &&
        !cloudflareTokenAvailable(),
      unrelatedError?.message,
    );

    const freshDirectory = join(sandbox, "a completely different folder");
    mkdirSync(freshDirectory);
    process.chdir(freshDirectory);
    const reopenedEvents = [];
    await cmdUpdate(undefined, {
      installedManifestOptions,
      readCloudflareToken: async () => Buffer.from("r".repeat(24), "ascii"),
      cmdVerify: async (path) => reopenedEvents.push(`verify:${path}`),
      cmdUpgrade: async (path) => reopenedEvents.push(`upgrade:${path}`),
    });
    check(
      "after Terminal is reopened, brain update works from an unrelated folder",
      reopenedEvents.join(",") === `verify:${manifestPath},upgrade:${manifestPath}`,
      reopenedEvents.join(","),
    );
    check("the reopened update also clears its prompted token", !cloudflareTokenAvailable());
    process.chdir(sandbox);

    if (process.platform !== "win32") {
      const pointerPath = installedManifestPointerPath(installedManifestOptions);
      chmodSync(pointerPath, 0o644);
      let unsafeError = null;
      let unsafePrompts = 0;
      let unsafeVerify = 0;
      try {
        await cmdUpdate(undefined, {
          installedManifestOptions,
          readCloudflareToken: async () => {
            unsafePrompts++;
            return Buffer.from("u".repeat(24), "ascii");
          },
          cmdVerify: async () => { unsafeVerify++; },
        });
      } catch (caught) { unsafeError = caught; }
      check(
        "an unsafe saved location fails closed before token entry or Cloudflare work",
        /saved Brain location is not private/i.test(unsafeError?.message || "") &&
          unsafePrompts === 0 && unsafeVerify === 0 && !cloudflareTokenAvailable(),
        unsafeError?.message,
      );
      await cmdUpdate(manifestPath, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("m".repeat(24), "ascii"),
        cmdVerify: async () => {},
        cmdUpgrade: async () => {},
      });
      check(
        "one custody-verified explicit update repairs an unsafe pointer mode",
        readInstalledManifest(installedManifestOptions) === manifestPath &&
          (lstatSync(pointerPath).mode & 0o777) === 0o600,
      );

      const symlinkTarget = join(sandbox, "pointer-symlink-target");
      const symlinkTargetBytes = "do not change this target\n";
      writeFileSync(symlinkTarget, symlinkTargetBytes, { mode: 0o600 });
      rmSync(pointerPath);
      symlinkSync(symlinkTarget, pointerPath);
      await cmdUpdate(manifestPath, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("s".repeat(24), "ascii"),
        cmdVerify: async () => {},
        cmdUpgrade: async () => {},
      });
      check(
        "explicit repair replaces a pointer symlink without touching its target",
        readFileSync(symlinkTarget, "utf8") === symlinkTargetBytes &&
          lstatSync(pointerPath).isFile() && !lstatSync(pointerPath).isSymbolicLink() &&
          readInstalledManifest(installedManifestOptions) === manifestPath,
      );
    }

    const staleManifest = join(sandbox, "old-brain.manifest.json");
    writeFileSync(staleManifest, JSON.stringify(manifestFixture()));
    rememberInstalledManifest(staleManifest, installedManifestOptions);
    rmSync(staleManifest);
    await cmdUpdate(manifestPath, {
      installedManifestOptions,
      readCloudflareToken: async () => Buffer.from("p".repeat(24), "ascii"),
      cmdVerify: async () => {},
      cmdUpgrade: async () => {},
    });
    check(
      "one explicit full-path update repairs a stale saved location",
      readInstalledManifest(installedManifestOptions) === manifestPath,
      readInstalledManifest(installedManifestOptions),
    );
    check("the repair update clears its prompted token", !cloudflareTokenAvailable());

    let rollbackCalled = 0;
    let rollbackTokenPrompts = 0;
    const rollbackPreview = await cmdRollbackInteractive(manifestPath, "fixture-bookmark", {
      readCloudflareToken: async () => {
        rollbackTokenPrompts++;
        return Buffer.from("y".repeat(24), "ascii");
      },
      cmdRollback: async () => { rollbackCalled++; },
    });
    check(
      "rollback preview does not prompt for a token or enter the destructive command",
      rollbackPreview?.restored === false && rollbackTokenPrompts === 0 && rollbackCalled === 0 &&
        !cloudflareTokenAvailable(),
      JSON.stringify({ rollbackPreview, rollbackTokenPrompts, rollbackCalled }),
    );

    await cmdRollbackInteractive(manifestPath, "fixture-bookmark", {
      confirmed: true,
      readCloudflareToken: async () => Buffer.from("y".repeat(24), "ascii"),
      cmdRollback: async (_path, bookmark, rollbackOptions) => {
        rollbackCalled++;
        check("rollback runs inside the same hidden-token boundary", cloudflareTokenAvailable());
        check("rollback receives the explicit bookmark", bookmark === "fixture-bookmark");
        check("rollback receives explicit confirmation", rollbackOptions.confirmed === true);
      },
    });
    check("the rollback wrapper calls the destructive command exactly once", rollbackCalled === 1);
    check("the prompted Cloudflare token is gone after rollback", !cloudflareTokenAvailable());

    let upgradeCalled = 0;
    let driftError = null;
    try {
      await cmdUpdate("./brain.manifest.json", {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("z".repeat(24), "ascii"),
        cmdVerify: async () => {
          writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.1.8")));
        },
        cmdUpgrade: async () => { upgradeCalled++; },
      });
    } catch (caught) { driftError = caught; }
    check(
      "update revalidates its manifest after account verification",
      /manifest changed during update verification/.test(driftError?.message || "") && upgradeCalled === 0,
      driftError?.message,
    );
    check("the default manifest still exists after lifecycle tests", existsSync(manifestPath));
  } finally {
    process.chdir(priorDirectory);
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- the packed user-prefix launcher rediscovers setup state in a fresh process ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-installed-update-")));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const packDirectory = join(sandbox, "pack");
    const fakeHome = join(sandbox, "home");
    const fakeLocalAppData = join(sandbox, "local-app-data");
    const prefix = process.platform === "win32"
      ? join(fakeLocalAppData, "FinancialBrain")
      : join(fakeHome, ".financial-brain");
    const firstDirectory = join(sandbox, "first shell");
    const reopenedDirectory = join(sandbox, "reopened somewhere else");
    const reinstalledDirectory = join(sandbox, "reopened after reinstall");
    mkdirSync(packDirectory, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeLocalAppData, { recursive: true });
    mkdirSync(firstDirectory, { recursive: true });
    mkdirSync(reopenedDirectory, { recursive: true });
    mkdirSync(reinstalledDirectory, { recursive: true });

    const pack = spawnSync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory,
    ], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 60_000,
    });
    let archive = null;
    try { archive = JSON.parse(pack.stdout)?.[0]?.filename || null; } catch { /* fixed check below */ }
    check(
      "the rediscovery acceptance test can build the real release package",
      pack.status === 0 && Boolean(archive),
      pack.stderr || pack.stdout,
    );

    if (pack.status === 0 && archive) {
      const installPacked = (cwd) => spawnSync("npm", [
          "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
          "--prefix", prefix, join(packDirectory, archive),
        ], {
          cwd,
          encoding: "utf8",
          shell: process.platform === "win32",
          timeout: 60_000,
        });
      const install = installPacked(firstDirectory);
      check(
        "the real package installs into a user-owned prefix without sudo",
        install.status === 0,
        install.stderr || install.stdout,
      );

      if (install.status === 0) {
        const installedRoot = process.platform === "win32"
          ? join(prefix, "node_modules", "brain-installer")
          : join(prefix, "lib", "node_modules", "brain-installer");
        const installedModule = join(installedRoot, "operations", "installed-manifest.mjs");
        const installedLauncher = process.platform === "win32"
          ? join(prefix, "brain.cmd")
          : join(prefix, "bin", "brain");
        const manifestPath = join(sandbox, "Financial Brain", "brain.manifest.json");
        mkdirSync(join(sandbox, "Financial Brain"), { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
        const isolatedEnvironment = {
          PATH: process.env.PATH || "",
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          LOCALAPPDATA: fakeLocalAppData,
          NO_COLOR: "1",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        };
        const setupReceipt = spawnSync(process.execPath, [
          "--input-type=module",
          "--eval",
          "const {pathToFileURL}=await import('node:url');" +
            "const installed=await import(pathToFileURL(process.env.INSTALLED_MODULE).href);" +
            "installed.rememberInstalledManifest(process.env.INSTALLED_MANIFEST);",
        ], {
          cwd: firstDirectory,
          encoding: "utf8",
          env: {
            ...isolatedEnvironment,
            INSTALLED_MODULE: installedModule,
            INSTALLED_MANIFEST: manifestPath,
          },
          timeout: 30_000,
        });
        check(
          "a successful setup process can persist discovery state from the packed module",
          setupReceipt.status === 0,
          setupReceipt.stderr || setupReceipt.stdout,
        );

        const reopened = setupReceipt.status === 0
          ? spawnSync(installedLauncher, ["update"], {
              cwd: reopenedDirectory,
              encoding: "utf8",
              env: isolatedEnvironment,
              shell: process.platform === "win32",
              timeout: 30_000,
            })
          : { status: null, stdout: "", stderr: "setup receipt failed" };
        const reopenedOutput = `${reopened.stdout || ""}\n${reopened.stderr || ""}`;
        check(
          "the installed launcher rediscovers the manifest after Terminal reopens anywhere",
          reopened.status !== 0 &&
            /terminal cannot prompt securely/i.test(reopenedOutput) &&
            !/no installed Brain was found|no manifest found/i.test(reopenedOutput),
          reopenedOutput,
        );

        const reinstall = setupReceipt.status === 0
          ? installPacked(reopenedDirectory)
          : { status: null, stdout: "", stderr: "setup receipt failed" };
        check(
          "the same packed release reinstalls into the same user prefix",
          reinstall.status === 0,
          reinstall.stderr || reinstall.stdout,
        );

        const afterReinstall = reinstall.status === 0
          ? spawnSync(installedLauncher, ["update"], {
              cwd: reinstalledDirectory,
              encoding: "utf8",
              env: isolatedEnvironment,
              shell: process.platform === "win32",
              timeout: 30_000,
            })
          : { status: null, stdout: "", stderr: "second package install failed" };
        const afterReinstallOutput = `${afterReinstall.stdout || ""}\n${afterReinstall.stderr || ""}`;
        check(
          "the reinstalled launcher keeps the remembered manifest in a fresh process and folder",
          afterReinstall.status !== 0 &&
            /terminal cannot prompt securely/i.test(afterReinstallOutput) &&
            !/no installed Brain was found|no manifest found/i.test(afterReinstallOutput),
          afterReinstallOutput,
        );
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\nupgrade verification: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
