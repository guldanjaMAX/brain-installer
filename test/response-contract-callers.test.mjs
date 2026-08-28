/**
 * The CALLER half of the response contract.
 *
 * worker/test/response-envelope.test.mjs proves the worker declares itself
 * honestly. That is only half a fix. The defect in the field was that consumers
 * checked `response.ok` and nothing else, so a 200 carrying a D1 error read as a
 * healthy brain with an empty queue. These tests pin the consumers.
 *
 * Every check here runs against the REAL worker module or the REAL Acceptance
 * class rather than a hand-written body, so a change to either side breaks here
 * instead of in front of a client.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../worker/src/index.js";
import { Acceptance } from "../acceptance.mjs";
import { cmdSetup } from "../brain.mjs";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
};

/* ------------------------------------------------------------------ */
/* 1. setup must not print an all-clear over a backlog it never read.  */
/* ------------------------------------------------------------------ */

const oneAccount = { id: "a".repeat(32), name: "Owner account" };

async function runSetupWithBacklog(backlogCount) {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-backlog-honesty-"));
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const target = join(sandbox, "Brain", "brain.manifest.json");
    const key = `fixture-${"k".repeat(40)}`;
    await cmdSetup(target, {
      setupWorkerScriptExists: async () => false,
      ask: async (question, fallback) => {
        if (/what is this brain for/i.test(question)) return "Test Brain";
        if (/short name/i.test(question)) return "test-brain";
        if (/folder to load/i.test(question)) return "";
        return fallback || "";
      },
      doctorRunAll: async () => [],
      listCloudflareAccounts: async () => [oneAccount],
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "generated", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => {},
      cmdProvision: async () => {},
      cmdMigrate: async () => {},
      cmdDeploy: async (path) => {
        const value = JSON.parse(readFileSync(path, "utf8"));
        value.brain.domain = "test-brain.owner-subdomain.workers.dev";
        writeFileSync(path, JSON.stringify(value));
      },
      cmdSecrets: async () => {},
      cmdDrain: async () => {},
      cmdHealth: async () => {},
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount,
      installedManifestOptions: {
        home: sandbox,
        stateDirectory: join(sandbox, "installed-state"),
      },
    });
    return lines.join("\n");
  } finally {
    console.log = realLog;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// null means the question could not be answered. Before this fix the same
// function returned 0 for that AND for a genuine empty queue, and setup closed
// with an unqualified "Your brain is live."
const unread = await runSetupWithBacklog(async () => null);
check("an unread backlog is reported as unverified, not as zero", () => {
  assert.match(unread, /was not verified/i);
  assert.match(unread, /unknown rather than confirmed/i);
});
check("an unread backlog still tells the owner how to check it", () => {
  assert.match(unread, /brain health/);
});

// The discriminator: a REAL zero must stay silent, or the warning is noise that
// fires on every healthy install and trains the owner to ignore it.
const genuineZero = await runSetupWithBacklog(async () => 0);
check("a genuine empty queue prints no warning at all", () => {
  assert.doesNotMatch(genuineZero, /was not verified/i);
  assert.doesNotMatch(genuineZero, /still embedding/i);
});

const pending = await runSetupWithBacklog(async () => 12);
check("a real backlog still names its size", () => {
  assert.match(pending, /12 chunk\(s\) are still embedding/);
  assert.doesNotMatch(pending, /was not verified/i);
});

/* ------------------------------------------------------------------ */
/* 2. the /health split must not blind the acceptance suite.           */
/* ------------------------------------------------------------------ */

const ENV = {
  BRAIN_NAME: "fixture-client",
  BRAIN_VERSION: "0.1.18",
  ADMIN_KEY: "fixture-admin-key",
};

/** Drive the real Acceptance class against the real worker over a fake wire. */
function workerFetch(env, { documents } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (documents && u.pathname === "/api/admin/brain/documents") {
      const key = new Headers(init.headers || {}).get("X-Admin-Key");
      if (key !== "fixture-admin-key") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      return new Response(JSON.stringify(documents.body), { status: documents.status });
    }
    return worker.fetch(new Request(u.toString(), init), env, {});
  };
}

const reachOnly = new Acceptance({
  base: "https://b.example",
  adminKey: "fixture-admin-key",
  manifest: {},
  fetchImpl: workerFetch(ENV),
  expectVersion: "0.1.18",
});
await reachOnly.tierReach();
const reachResult = reachOnly.results.find((r) => r.name === "health responds");

check("the version check survives a /health that withholds it from strangers", () => {
  assert.equal(
    reachResult.status, "pass",
    `expected the version to be read from the authenticated probe, got: ${reachResult.detail}`,
  );
  assert.match(reachResult.detail, /0\.1\.18/);
});

{
  // Guards the check above from passing for the wrong reason. If /health ever
  // starts handing the version to anonymous callers again, the authenticated
  // fallback would never be exercised and that check would still be green.
  const res = await worker.fetch(new Request("https://b.example/health"), ENV, {});
  const body = await res.json();
  check("the anonymous probe carries neither slug nor version", () => {
    assert.equal(body.version, undefined);
    assert.equal(body.brain, undefined);
    assert.equal(body.identified, false, "and it says so, so a caller can react");
  });
}

/* ------------------------------------------------------------------ */
/* 3. a 503 from /documents is a subsystem finding, not a bad key.     */
/* ------------------------------------------------------------------ */

const brokenDocuments = {
  status: 503,
  body: {
    backend: "d1",
    rows: [{ source_type: "drive", total: 10, embedded: 10 }],
    vector_backlog: { error: "D1_ERROR: no such column: submitted_mutation_id" },
    complete: false,
    failures: [{
      subsystem: "vector_backlog",
      error: "D1_ERROR: no such column: submitted_mutation_id",
      unavailable: true,
    }],
  },
};

const broken = new Acceptance({
  base: "https://b.example",
  adminKey: "fixture-admin-key",
  manifest: {},
  fetchImpl: workerFetch(ENV, { documents: brokenDocuments }),
});
await broken.tierReach();
await broken.tierData();

check("a subsystem failure is NOT reported as a rejected credential", () => {
  const auth = broken.results.find((r) => r.name === "correct key is accepted");
  assert.equal(
    auth.status, "pass",
    "the key WAS accepted; scoring this as an auth failure sends the reader at the wrong problem",
  );
});

check("the corpus summary fails and NAMES the subsystem that could not be read", () => {
  const corpus = broken.results.find((r) => r.name === "corpus summary");
  assert.equal(corpus.status, "fail");
  assert.match(corpus.detail, /vector_backlog/);
  assert.match(corpus.detail, /no such column: submitted_mutation_id/);
});

/* ------------------------------------------------------------------ */
/* 4. version skew: an OLDER worker reports the same failure as a 200. */
/* ------------------------------------------------------------------ */

const legacyDocuments = {
  status: 200,
  body: {
    backend: "d1",
    rows: [{ source_type: "drive", total: 10, embedded: 10 }],
    // No `complete`, no `failures`. This is exactly the body the field probe
    // saw, and `response.ok` is TRUE for it.
    vector_backlog: { error: "D1_ERROR: no such column: submitted_mutation_id" },
    vector_readiness: { ready: false, error: "D1_ERROR: no such table: vector_outbox" },
  },
};

const legacy = new Acceptance({
  base: "https://b.example",
  adminKey: "fixture-admin-key",
  manifest: {},
  fetchImpl: workerFetch(ENV, { documents: legacyDocuments }),
});
await legacy.tierData();

check("a pre-contract 200 hiding an error is still caught by a newer client", () => {
  const corpus = legacy.results.find((r) => r.name === "corpus summary");
  assert.equal(
    corpus.status, "fail",
    "response.ok was true here; only reading the body catches it, which is the whole defect",
  );
  assert.match(corpus.detail, /vector_backlog|vector_readiness/);
});

/* ------------------------------------------------------------------ */
/* 5. a healthy brain must still pass, or the fix is just noise.       */
/* ------------------------------------------------------------------ */

const healthyDocuments = {
  status: 200,
  body: {
    backend: "d1",
    rows: [{ source_type: "drive", total: 10, embedded: 10 }],
    vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
    vector_readiness: { ready: true, expected_vectors: 10, actual_vectors: 10 },
    complete: true,
  },
};

const healthy = new Acceptance({
  base: "https://b.example",
  adminKey: "fixture-admin-key",
  manifest: {},
  fetchImpl: workerFetch(ENV, { documents: healthyDocuments }),
});
await healthy.tierData();

check("a sound corpus summary still passes", () => {
  const corpus = healthy.results.find((r) => r.name === "corpus summary");
  assert.notEqual(corpus?.status, "fail");
});

if (failures) {
  console.error(`\nresponse contract callers: ${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nresponse contract callers: all caller-side checks passed");
