import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCuratedCoverageLedger,
  loadCuratedSyncPlan,
  prepareCuratedCorpus,
  runCuratedDualSync,
  validateCuratedSyncPlan,
  writeCuratedCoverageLedger,
} from "../operations/curated-dual-sync.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-curated-dual-sync-"));
const corpus = join(sandbox, "corpus");
const stateFile = join(sandbox, ".brain-ingest-drive.json");
const ledgerFile = join(sandbox, ".brain-curated-sync-ledger.json");

const docs = Object.freeze([
  {
    relative_path: "alpha.md",
    role: "authoritative",
    legacy_source_type: "custom",
    legacy_source_id: "fixture-alpha-id",
    metadata: {
      synthetic_path: "Fixture/{{relative_path}}",
      content_hash: "{{content_sha256_16}}",
      primary: true,
    },
  },
  {
    relative_path: "nested/beta.md",
    role: "superseded",
    legacy_source_type: "curated",
    legacy_source_id: "fixture-beta-id",
    superseded_reason: "replaced by the fixture master",
    metadata: {
      synthetic_path: "Fixture/{{relative_path}}",
      content_hash: "{{content_sha256_16}}",
      superseded: true,
    },
  },
  {
    relative_path: "nested/gamma.markdown",
    role: "plain",
    legacy_source_type: "custom",
    legacy_source_id: "fixture-gamma-id",
    metadata: {
      synthetic_path: "Fixture/{{relative_path}}",
      content_hash: "{{content_sha256_16}}",
    },
  },
]);

function plan(overrides = {}) {
  return {
    schema_version: 1,
    root: "corpus",
    expected_documents: 3,
    expected_roles: { authoritative: 1, superseded: 1, plain: 1 },
    ledger_namespace: "fixture-private-namespace-v1",
    exclude_directories: ["ignored"],
    documents: docs.map((document) => structuredClone(document)),
    transforms: {
      authoritative: {
        content_prefix: "[CURRENT {{modified_date}}]\n",
        title_prefix: "[CURRENT] ",
      },
      superseded: {
        content_prefix: "[SUPERSEDED: {{superseded_reason}}]\n",
        title_prefix: "[SUPERSEDED] ",
      },
      plain: { content_prefix: "", title_prefix: "" },
    },
    common_metadata: { category: "fixture" },
    legacy_target: { manifest: "legacy.manifest.json" },
    cloudflare_target: { manifest: "cloudflare.manifest.json" },
    raw_drive: {
      state_file: ".brain-ingest-drive.json",
      path_prefix: "Fixture",
      match: "path",
      require_state_match: true,
    },
    ledger_file: ".brain-curated-sync-ledger.json",
    ...overrides,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function allStatus(prepared, value) {
  return new Map(prepared.documents.map((document) => [document.logicalFingerprint, value]));
}

try {
  mkdirSync(join(corpus, "nested"), { recursive: true, mode: 0o700 });
  mkdirSync(join(corpus, "ignored"), { mode: 0o700 });
  writeFileSync(join(corpus, "alpha.md"), "# Alpha fixture\nAuthoritative body.\n", { mode: 0o600 });
  writeFileSync(join(corpus, "nested", "beta.md"), "# Beta fixture\nOld body.\n", { mode: 0o600 });
  writeFileSync(join(corpus, "nested", "gamma.markdown"), "Plain body without a heading.\n", { mode: 0o600 });
  writeFileSync(join(corpus, "ignored", "not-in-plan.md"), "# Excluded fixture\n", { mode: 0o600 });
  const stableMtime = new Date(2026, 0, 2, 12, 0, 0);
  utimesSync(join(corpus, "alpha.md"), stableMtime, stableMtime);

  writeFileSync(stateFile, JSON.stringify({
    version: 6,
    done: {
      "drive:fixture-alpha": JSON.stringify(["revision", "hash", "alpha.md", "text/markdown", "Fixture"]),
      "drive:fixture-beta": JSON.stringify(["revision", "hash", "beta.md", "text/markdown", "Fixture/nested"]),
      "drive:fixture-gamma": JSON.stringify(["revision", "hash", "gamma.markdown", "text/markdown", "Fixture/nested"]),
    },
  }), { mode: 0o600 });

  const checked = validateCuratedSyncPlan(plan());
  const prepared = prepareCuratedCorpus(checked, { planDirectory: sandbox });
  assert.equal(prepared.documents.length, 3);
  const alpha = prepared.documents.find((document) => document.relativePath === "alpha.md");
  const beta = prepared.documents.find((document) => document.relativePath === "nested/beta.md");
  const gamma = prepared.documents.find((document) => document.relativePath === "nested/gamma.markdown");
  assert.equal(alpha.legacyEnvelope.content.startsWith("[CURRENT 2026-01-02]\n"), true);
  assert.equal(alpha.legacyEnvelope.title, "[CURRENT] Alpha fixture");
  assert.equal(beta.legacyEnvelope.content.startsWith("[SUPERSEDED: replaced by the fixture master]\n"), true);
  assert.equal(beta.legacyEnvelope.title, "[SUPERSEDED] Beta fixture");
  assert.equal(gamma.legacyEnvelope.title, "gamma");
  assert.equal(alpha.cloudflareEnvelope.source_type, "curated");
  assert.equal(alpha.cloudflareEnvelope.source_id, "brain:custom:fixture-alpha-id");
  assert.equal(
    alpha.legacyEnvelope.metadata.content_hash,
    createHash("sha256").update(alpha.legacyEnvelope.content).digest("hex").slice(0, 16),
  );

  // A scheduled mount that enumerates no files must fail before either target
  // resolver, the network, or the ledger writer can be reached.
  const empty = join(sandbox, "empty");
  mkdirSync(empty, { mode: 0o700 });
  let secretCalls = 0;
  let networkCalls = 0;
  let ledgerCalls = 0;
  await assert.rejects(
    () => runCuratedDualSync(plan({ root: "empty" }), {
      mode: "sync",
      planDirectory: sandbox,
      resolveTarget: async () => { secretCalls++; return { baseUrl: "https://fixture.invalid", adminKey: "fixture-key" }; },
      fetch: async () => { networkCalls++; return response(500, {}); },
      writeLedger: () => { ledgerCalls++; },
    }),
    /found zero Markdown documents; expected 3/,
  );
  assert.equal(secretCalls, 0);
  assert.equal(networkCalls, 0);
  assert.equal(ledgerCalls, 0);

  // An equal-size but different set is also a hard stop and reports aggregates,
  // never the private path names involved in the mismatch.
  const mismatch = join(sandbox, "mismatch");
  mkdirSync(join(mismatch, "nested"), { recursive: true, mode: 0o700 });
  writeFileSync(join(mismatch, "alpha.md"), "# A\n", { mode: 0o600 });
  writeFileSync(join(mismatch, "nested", "beta.md"), "# B\n", { mode: 0o600 });
  writeFileSync(join(mismatch, "nested", "delta.markdown"), "# D\n", { mode: 0o600 });
  let mismatchError;
  try {
    prepareCuratedCorpus(validateCuratedSyncPlan(plan({ root: "mismatch" })), { planDirectory: sandbox });
  } catch (error) { mismatchError = error; }
  assert.match(mismatchError?.message || "", /1 missing and 1 unexpected/);
  assert.equal(mismatchError.message.includes("gamma"), false);
  assert.equal(mismatchError.message.includes("delta"), false);

  // Dry-run still produces the desired-state hash ledger but cannot touch a
  // durable credential or the network.
  let dryLedger;
  const dry = await runCuratedDualSync(plan(), {
    mode: "dry-run",
    planDirectory: sandbox,
    resolveTarget: async () => { throw new Error("must not resolve in dry-run"); },
    fetch: async () => { throw new Error("must not fetch in dry-run"); },
    writeLedger: (_path, value) => { dryLedger = value; },
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.rawDriveDuplicates.total, 0);
  assert.equal(dryLedger.documents.every((document) => document.targets.legacy === "not_attempted"), true);

  // Read-only audit pages through the authenticated Cloudflare family list and
  // detects duplicates without posting either legacy or Cloudflare content.
  const auditCalls = [];
  let auditLedger;
  const audit = await runCuratedDualSync(plan(), {
    mode: "audit",
    planDirectory: sandbox,
    resolveTarget: async (_target, _directory, _options, name) => {
      assert.equal(name, "cloudflare");
      return { baseUrl: "https://cloudflare.invalid", adminKey: "fixture-cloudflare-key" };
    },
    fetch: async (url, options) => {
      auditCalls.push({ url, options });
      assert.equal(options.method, undefined);
      assert.equal(url.includes("fixture-cloudflare-key"), false);
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) {
        return response(200, {
          source: "drive",
          families: ["drive:fixture-alpha"],
          next_cursor: "drive:fixture-alpha",
        });
      }
      return response(200, {
        source: "drive",
        families: ["drive:fixture-beta"],
        next_cursor: null,
      });
    },
    writeLedger: (_path, value) => { auditLedger = value; },
  });
  assert.equal(audit.ok, true);
  assert.equal(auditCalls.length, 2);
  assert.deepEqual(audit.rawDriveDuplicates, {
    total: 2,
    authoritative: 1,
    superseded: 1,
    plain: 0,
  });
  const auditText = JSON.stringify(auditLedger);
  for (const privateFixture of [
    "alpha.md", "beta.md", "gamma.markdown",
    "fixture-alpha-id", "fixture-beta-id", "fixture-gamma-id",
    "drive:fixture-alpha", "Fixture/", "Authoritative body",
    "cloudflare.invalid", "fixture-cloudflare-key",
  ]) {
    assert.equal(auditText.includes(privateFixture), false, `ledger omitted ${privateFixture}`);
  }

  // A legacy per-document failure cannot suppress Cloudflare. Every Cloudflare
  // identity is the exact migrated curated identity and receives the same bytes.
  const postCalls = { legacy: [], cloudflare: [] };
  let partialLedger;
  const partial = await runCuratedDualSync(plan(), {
    mode: "sync",
    planDirectory: sandbox,
    resolveTarget: async (_target, _directory, _options, name) => ({
      baseUrl: name === "legacy" ? "https://legacy.invalid" : "https://cloudflare.invalid",
      adminKey: name === "legacy" ? "fixture-legacy-key" : "fixture-cloudflare-key",
    }),
    fetch: async (url, options) => {
      if (!options.method) {
        return response(200, {
          source: "drive",
          families: ["drive:fixture-alpha", "drive:fixture-beta", "drive:fixture-gamma"],
          next_cursor: null,
        });
      }
      const target = url.startsWith("https://legacy.invalid") ? "legacy" : "cloudflare";
      const envelope = JSON.parse(options.body);
      postCalls[target].push(envelope);
      assert.equal(url.includes(options.headers["X-Admin-Key"]), false);
      assert.equal(options.body.includes(options.headers["X-Admin-Key"]), false);
      if (target === "legacy" && envelope.source_id === "fixture-beta-id") {
        return response(503, { error: "synthetic unavailable" });
      }
      return target === "legacy"
        ? response(200, { brain_doc_id: `legacy-${envelope.source_id}`, action: "unchanged" })
        : response(200, { doc_uid: `curated:${envelope.source_id}`, action: "unchanged" });
    },
    writeLedger: (_path, value) => { partialLedger = value; },
  });
  assert.equal(partial.ok, false);
  assert.equal(postCalls.legacy.length, 3);
  assert.equal(postCalls.cloudflare.length, 3);
  assert.equal(partial.targetCoverage.legacy_confirmed.total, 2);
  assert.equal(partial.targetCoverage.cloudflare_confirmed.total, 3);
  for (const cloudEnvelope of postCalls.cloudflare) {
    assert.equal(cloudEnvelope.source_type, "curated");
    assert.equal(cloudEnvelope.source_id.startsWith("brain:"), true);
    const legacyEnvelope = postCalls.legacy.find((candidate) =>
      cloudEnvelope.source_id === `brain:${candidate.source_type}:${candidate.source_id}`);
    assert.ok(legacyEnvelope);
    assert.equal(cloudEnvelope.content, legacyEnvelope.content);
    assert.equal(cloudEnvelope.title, legacyEnvelope.title);
    assert.deepEqual(cloudEnvelope.metadata, legacyEnvelope.metadata);
  }
  assert.equal(partialLedger.target_coverage.cloudflare_confirmed.total, 3);

  // Even total credential-resolution failure at the rollback target leaves all
  // Cloudflare writes reachable and visible as confirmed.
  let cloudOnlyPosts = 0;
  const credentialFailure = await runCuratedDualSync(plan(), {
    mode: "sync",
    planDirectory: sandbox,
    resolveTarget: async (_target, _directory, _options, name) => {
      if (name === "legacy") throw new Error("synthetic legacy key unavailable");
      return { baseUrl: "https://cloudflare.invalid", adminKey: "fixture-cloudflare-key" };
    },
    fetch: async (url, options) => {
      if (!options.method) {
        return response(200, { source: "drive", families: [], next_cursor: null });
      }
      cloudOnlyPosts++;
      const envelope = JSON.parse(options.body);
      return response(200, { doc_uid: `curated:${envelope.source_id}`, action: "created" });
    },
    writeLedger: () => {},
  });
  assert.equal(credentialFailure.ok, false);
  assert.equal(cloudOnlyPosts, 3);
  assert.equal(credentialFailure.targetCoverage.legacy_confirmed.total, 0);
  assert.equal(credentialFailure.targetCoverage.cloudflare_confirmed.total, 3);

  // Receipt action is operational detail, not corpus identity. Created and
  // unchanged success produce byte-identical deterministic coverage ledgers.
  const successfulRun = async (action) => {
    let captured;
    const report = await runCuratedDualSync(plan(), {
      mode: "sync",
      planDirectory: sandbox,
      resolveTarget: async (_target, _directory, _options, name) => ({
        baseUrl: `https://${name}.invalid`,
        adminKey: `fixture-${name}-key`,
      }),
      fetch: async (url, options) => {
        if (!options.method) {
          return response(200, {
            source: "drive",
            families: ["drive:fixture-alpha", "drive:fixture-beta", "drive:fixture-gamma"],
            next_cursor: null,
          });
        }
        const envelope = JSON.parse(options.body);
        return url.startsWith("https://legacy.invalid")
          ? response(200, { brain_doc_id: `legacy-${envelope.source_id}`, action })
          : response(200, { doc_uid: `curated:${envelope.source_id}`, action });
      },
      writeLedger: (_path, value) => { captured = value; },
    });
    assert.equal(report.ok, true);
    return captured;
  };
  const createdLedger = await successfulRun("created");
  const unchangedLedger = await successfulRun("unchanged");
  assert.deepEqual(createdLedger, unchangedLedger);

  // The real writer atomically replaces one owner-only file and reads back the
  // exact canonical bytes. Repeating an equal ledger is byte deterministic.
  const observations = {
    legacy: allStatus(prepared, "confirmed"),
    cloudflare: allStatus(prepared, "confirmed"),
    rawDrive: allStatus(prepared, "duplicate_confirmed"),
  };
  const stableLedger = buildCuratedCoverageLedger(prepared, observations);
  const firstWrite = writeCuratedCoverageLedger(ledgerFile, stableLedger, {
    randomBytes: () => Buffer.alloc(8, 1),
  });
  const firstBytes = Buffer.from(firstWrite.bytes);
  const secondWrite = writeCuratedCoverageLedger(ledgerFile, stableLedger, {
    randomBytes: () => Buffer.alloc(8, 2),
  });
  assert.deepEqual(secondWrite.bytes, firstBytes);
  if (process.platform !== "win32") assert.equal(statSync(ledgerFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(ledgerFile).equals(firstBytes), true);

  // The private plan itself is refused when it can be read by another user.
  const planFile = join(sandbox, ".brain-curated-sync-plan.json");
  writeFileSync(planFile, JSON.stringify(plan()), { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(planFile, 0o644);
    assert.throws(() => loadCuratedSyncPlan(planFile), /owner-only mode 0600/);
    chmodSync(planFile, 0o600);
  }
  assert.equal(loadCuratedSyncPlan(planFile).plan.expectedDocuments, 3);

  console.log("PASS  curated dual sync fails closed, preserves both targets, and writes a private deterministic ledger");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
