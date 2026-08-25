import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCuratedCoverageLedger,
  inspectCuratedTargetContracts,
  loadCuratedSyncPlan,
  prepareCuratedCorpus,
  readStableRegularSource,
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
    legacy_target: { manifest: "legacy.manifest.json", backend: "legacy_notes_supabase" },
    cloudflare_target: { manifest: "cloudflare.manifest.json", backend: "cloudflare_d1" },
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

function completeFamilies(source) {
  return source === "curated"
    ? [
        "curated:brain:custom:fixture-alpha-id",
        "curated:brain:curated:fixture-beta-id",
        "curated:brain:custom:fixture-gamma-id",
      ]
    : ["drive:fixture-alpha", "drive:fixture-beta", "drive:fixture-gamma"];
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

  const md5 = (path) => createHash("md5").update(readFileSync(path)).digest("hex");
  const alphaRawMd5 = md5(join(corpus, "alpha.md"));
  const betaWrongMd5 = "0".repeat(32);
  const gammaSizeOnly = String(statSync(join(corpus, "nested", "gamma.markdown")).size);

  writeFileSync(stateFile, JSON.stringify({
    version: 6,
    done: {
      "drive:fixture-alpha": JSON.stringify(["revision", alphaRawMd5, "alpha.md", "text/markdown", "Fixture"]),
      "drive:fixture-beta": JSON.stringify(["revision", betaWrongMd5, "beta.md", "text/markdown", "Fixture/nested"]),
      "drive:fixture-gamma": JSON.stringify(["revision", gammaSizeOnly, "gamma.markdown", "text/markdown", "Fixture/nested"]),
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
  assert.equal(alpha.rawMd5, alphaRawMd5);
  assert.equal(
    alpha.legacyEnvelope.metadata.content_hash,
    createHash("sha256").update(alpha.legacyEnvelope.content).digest("hex").slice(0, 16),
  );

  // The source bytes come from a no-follow descriptor and must remain the same
  // inode, size and timestamps through the read and final path verification.
  let openedFlags = 0;
  const stableRead = readStableRegularSource(join(corpus, "alpha.md"), {
    openSource(path, flags) {
      openedFlags = flags;
      return openSync(path, flags);
    },
  });
  assert.equal(stableRead.rawMd5, alphaRawMd5);
  if (fsConstants.O_NOFOLLOW) {
    assert.equal((openedFlags & fsConstants.O_NOFOLLOW) === fsConstants.O_NOFOLLOW, true);
  }

  let fstatCalls = 0;
  let changedError;
  try {
    readStableRegularSource(join(corpus, "alpha.md"), {
      fstatSource(descriptor, options) {
        const info = fstatSync(descriptor, options);
        fstatCalls++;
        if (fstatCalls === 1) return info;
        return {
          ...info,
          isFile: () => true,
          mtimeNs: info.mtimeNs + 1n,
        };
      },
    });
  } catch (error) { changedError = error; }
  assert.match(changedError?.message || "", /changed while being read/);
  assert.equal(changedError.message.includes("alpha.md"), false);

  let replacedError;
  try {
    readStableRegularSource(join(corpus, "alpha.md"), {
      lstatSource(path, options) {
        const info = lstatSync(path, options);
        return { ...info, isFile: () => true, isSymbolicLink: () => false, ino: info.ino + 1n };
      },
    });
  } catch (error) { replacedError = error; }
  assert.match(replacedError?.message || "", /changed while being read/);
  assert.equal(replacedError.message.includes("alpha.md"), false);

  const racedPath = join(corpus, "late-arrival.md");
  let injectedArrival = false;
  let inventoryRaceError;
  try {
    prepareCuratedCorpus(checked, {
      planDirectory: sandbox,
      readStableSource(path, options) {
        const snapshot = readStableRegularSource(path, options);
        if (!injectedArrival) {
          injectedArrival = true;
          writeFileSync(racedPath, "# Late fixture\n", { mode: 0o600 });
        }
        return snapshot;
      },
    });
  } catch (error) { inventoryRaceError = error; }
  assert.match(inventoryRaceError?.message || "", /inventory changed while the snapshot was being built/);
  assert.equal(inventoryRaceError.message.includes("late-arrival"), false);
  unlinkSync(racedPath);

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

  // A complete transformed-envelope scan covers content, derived/explicit
  // title and nested metadata as one fail-closed corpus before target/key use.
  const credentialCorpus = join(sandbox, "credential-corpus");
  mkdirSync(join(credentialCorpus, "nested"), { recursive: true, mode: 0o700 });
  const syntheticCredential = ["sk", "ant", "api03", "A".repeat(40)].join("-");
  writeFileSync(join(credentialCorpus, "alpha.md"), `# Safe heading\n${syntheticCredential}\n`, { mode: 0o600 });
  writeFileSync(join(credentialCorpus, "nested", "beta.md"), "# Safe body\n", { mode: 0o600 });
  writeFileSync(join(credentialCorpus, "nested", "gamma.markdown"), "# Safe body\n", { mode: 0o600 });
  const credentialPlan = plan({ root: "credential-corpus" });
  credentialPlan.documents[1].title = syntheticCredential;
  credentialPlan.documents[2].metadata.nested = { human_note: syntheticCredential };
  let credentialResolvers = 0;
  let credentialRequests = 0;
  let credentialWrites = 0;
  let credentialError;
  try {
    await runCuratedDualSync(credentialPlan, {
      mode: "sync",
      planDirectory: sandbox,
      resolveTarget: async () => { credentialResolvers++; return {}; },
      fetch: async () => { credentialRequests++; return response(500, {}); },
      writeLedger: () => { credentialWrites++; },
    });
  } catch (error) { credentialError = error; }
  assert.match(credentialError?.message || "", /refused 3 of 3 transformed documents/);
  assert.equal(credentialError.message.includes(syntheticCredential), false);
  assert.equal(credentialResolvers, 0);
  assert.equal(credentialRequests, 0);
  assert.equal(credentialWrites, 0);

  // The final pass re-opens every source. A byte-hash change after transform
  // and scan stops before target resolution or ledger replacement.
  let snapshotReads = 0;
  let finalResolvers = 0;
  let finalWrites = 0;
  await assert.rejects(
    () => runCuratedDualSync(plan(), {
      mode: "sync",
      planDirectory: sandbox,
      readStableSource(path, options) {
        snapshotReads++;
        const snapshot = readStableRegularSource(path, options);
        if (snapshotReads === 4) return { ...snapshot, rawSha256: "f".repeat(64) };
        return snapshot;
      },
      resolveTarget: async () => { finalResolvers++; return {}; },
      writeLedger: () => { finalWrites++; },
    }),
    /final snapshot verification failed for 1 changed documents/,
  );
  assert.equal(snapshotReads, 6);
  assert.equal(finalResolvers, 0);
  assert.equal(finalWrites, 0);

  // Target identity can be resolved and validated without reading an admin
  // credential. This exercises the production manifest parser and D1 contract.
  writeFileSync(join(sandbox, "legacy.manifest.json"), JSON.stringify({
    brain: { domain: "legacy-contract.invalid" },
  }), { mode: 0o600 });
  writeFileSync(join(sandbox, "cloudflare.manifest.json"), JSON.stringify({
    brain: { domain: "cloudflare-contract.invalid" },
    infrastructure: { cloudflare: { storage: "d1" } },
  }), { mode: 0o600 });
  const contracts = inspectCuratedTargetContracts(plan(), { planDirectory: sandbox });
  assert.equal(contracts.legacy.origin, "https://legacy-contract.invalid");
  assert.equal(contracts.cloudflare.origin, "https://cloudflare-contract.invalid");
  assert.notEqual(contracts.legacy.backend, contracts.cloudflare.backend);
  assert.match(contracts.legacy.manifestFingerprint, /^[0-9a-f]{64}$/);
  assert.match(contracts.cloudflare.manifestFingerprint, /^[0-9a-f]{64}$/);

  // A scheduler-bound manifest mismatch stops before Keychain, network, and
  // ledger access. The expected value is a hash, never a copied locator.
  let manifestKeyReads = 0;
  let manifestNetwork = 0;
  let manifestLedgerWrites = 0;
  await assert.rejects(
    () => runCuratedDualSync(plan(), {
      mode: "audit",
      planDirectory: sandbox,
      expectedTargetFingerprints: {
        legacy: contracts.legacy.manifestFingerprint,
        cloudflare: "f".repeat(64),
      },
      runChild: () => {
        manifestKeyReads++;
        return { status: 0, stdout: Buffer.from("fixture-key\n"), stderr: Buffer.alloc(0) };
      },
      fetch: async () => { manifestNetwork++; return response(500, {}); },
      writeLedger: () => { manifestLedgerWrites++; },
    }),
    /target manifest changed after the curated scheduler was prepared/,
  );
  assert.equal(manifestKeyReads, 0);
  assert.equal(manifestNetwork, 0);
  assert.equal(manifestLedgerWrites, 0);

  // The ledger may never alias any input or credential sidecar, even through
  // an absolute path. Every collision is refused before a writer is invoked.
  const collisionPlanPath = join(sandbox, ".collision-plan.json");
  writeFileSync(collisionPlanPath, JSON.stringify(plan()), { mode: 0o600 });
  const protectedCollisions = [
    collisionPlanPath,
    join(corpus, "alpha.md"),
    join(sandbox, "legacy.manifest.json"),
    join(sandbox, ".brain-admin-key"),
    stateFile,
  ];
  for (const destination of protectedCollisions) {
    let writes = 0;
    await assert.rejects(
      () => runCuratedDualSync(plan({ ledger_file: destination }), {
        mode: "dry-run",
        planDirectory: sandbox,
        planPath: collisionPlanPath,
        writeLedger: () => { writes++; },
      }),
      /collides with protected sync input/,
    );
    assert.equal(writes, 0);
  }

  const invalidLedger = join(sandbox, ".invalid-ledger.json");
  writeFileSync(invalidLedger, "{}\n", { mode: 0o600 });
  const invalidBefore = readFileSync(invalidLedger);
  await assert.rejects(
    () => runCuratedDualSync(plan({ ledger_file: invalidLedger }), {
      mode: "dry-run",
      planDirectory: sandbox,
    }),
    /unsupported schema/,
  );
  assert.deepEqual(readFileSync(invalidLedger), invalidBefore);

  // The target-neutral envelope hash catches title or metadata drift even
  // when transformed content bytes are unchanged, and feeds corpus identity.
  const titlePlan = plan();
  titlePlan.documents[0].title = "Changed synthetic title";
  const metadataPlan = plan({ common_metadata: { category: "changed-fixture" } });
  const preparedTitle = prepareCuratedCorpus(titlePlan, { planDirectory: sandbox });
  const preparedMetadata = prepareCuratedCorpus(metadataPlan, { planDirectory: sandbox });
  const baseAlpha = prepared.documents.find((document) => document.relativePath === "alpha.md");
  const titleAlpha = preparedTitle.documents.find((document) => document.relativePath === "alpha.md");
  const metadataAlpha = preparedMetadata.documents.find((document) => document.relativePath === "alpha.md");
  assert.equal(titleAlpha.contentHash, baseAlpha.contentHash);
  assert.equal(metadataAlpha.contentHash, baseAlpha.contentHash);
  assert.notEqual(titleAlpha.envelopeHash, baseAlpha.envelopeHash);
  assert.notEqual(metadataAlpha.envelopeHash, baseAlpha.envelopeHash);
  assert.notEqual(
    buildCuratedCoverageLedger(preparedTitle).corpus_fingerprint,
    buildCuratedCoverageLedger(prepared).corpus_fingerprint,
  );
  assert.notEqual(
    buildCuratedCoverageLedger(preparedMetadata).corpus_fingerprint,
    buildCuratedCoverageLedger(prepared).corpus_fingerprint,
  );

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
  assert.equal(dry.rawDriveHistoricalChecksumMatches.total, 0);
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
      assert.equal(options.redirect, "manual");
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
          families: ["drive:fixture-beta", "drive:fixture-gamma"],
        next_cursor: null,
      });
    },
    writeLedger: (_path, value) => { auditLedger = value; },
  });
  assert.equal(audit.ok, true);
  assert.equal(auditCalls.length, 2);
  assert.deepEqual(audit.rawDriveHistoricalChecksumMatches, {
    total: 1,
    authoritative: 1,
    superseded: 0,
    plain: 0,
  });
  assert.deepEqual(audit.rawDriveHistoricalChecksumMismatches, {
    total: 1,
    authoritative: 0,
    superseded: 1,
    plain: 0,
  });
  assert.deepEqual(audit.rawDriveHistoricalPresenceUnverified, {
    total: 1,
    authoritative: 0,
    superseded: 0,
    plain: 1,
  });
  const auditText = JSON.stringify(auditLedger);
  assert.equal(auditLedger.raw_drive_evidence.deletion_eligible, false);
  assert.equal(auditLedger.raw_drive_evidence.reason, "server_revision_unbound");
  assert.equal(auditText.includes("checksum_confirmed_duplicate"), false);
  assert.equal(auditText.includes("raw_drive_checksum_duplicates"), false);
  assert.equal(auditLedger.documents.some((document) =>
    document.raw_drive === "historical_checksum_match"), true);
  for (const privateFixture of [
    "alpha.md", "beta.md", "gamma.markdown",
    "fixture-alpha-id", "fixture-beta-id", "fixture-gamma-id",
    "drive:fixture-alpha", "Fixture/", "Authoritative body",
    "cloudflare.invalid", "fixture-cloudflare-key",
  ]) {
    assert.equal(auditText.includes(privateFixture), false, `ledger omitted ${privateFixture}`);
  }

  // Manual redirect handling prevents an authenticated request from following
  // a response onto another origin. Fetch sees one request and no credential
  // ever reaches the advertised redirect destination.
  let redirectCalls = 0;
  const redirected = await runCuratedDualSync(plan(), {
    mode: "audit",
    planDirectory: sandbox,
    resolveTarget: async () => ({
      baseUrl: "https://cloudflare.invalid",
      backend: "cloudflare_d1",
      adminKey: "fixture-cloudflare-key",
    }),
    fetch: async (_url, options) => {
      redirectCalls++;
      assert.equal(options.redirect, "manual");
      return response(302, { location: "https://redirect.invalid" });
    },
    writeLedger: () => {},
  });
  assert.equal(redirected.ok, false);
  assert.equal(redirectCalls, 1);

  let sameOriginNetwork = 0;
  await assert.rejects(
    () => runCuratedDualSync(plan(), {
      mode: "sync",
      planDirectory: sandbox,
      resolveTarget: async (_target, _directory, _options, name) => ({
        baseUrl: "https://same-origin.invalid",
        backend: name === "legacy" ? "legacy_notes_supabase" : "cloudflare_d1",
        adminKey: `fixture-${name}-key`,
      }),
      fetch: async () => { sameOriginNetwork++; return response(500, {}); },
      writeLedger: () => {},
    }),
    /distinct backends and origins/,
  );
  assert.equal(sameOriginNetwork, 0);

  // A legacy per-document failure cannot suppress Cloudflare. Every Cloudflare
  // identity is the exact migrated curated identity and receives the same bytes.
  const postCalls = { legacy: [], cloudflare: [] };
  const resolutionCalls = { legacy: 0, cloudflare: 0 };
  let partialLedger;
  const partial = await runCuratedDualSync(plan(), {
    mode: "sync",
    planDirectory: sandbox,
    resolveTarget: async (_target, _directory, _options, name) => {
      resolutionCalls[name]++;
      return {
        baseUrl: name === "legacy" ? "https://legacy.invalid" : "https://cloudflare.invalid",
        backend: name === "legacy" ? "legacy_notes_supabase" : "cloudflare_d1",
        adminKey: name === "legacy" ? "fixture-legacy-key" : "fixture-cloudflare-key",
      };
    },
    fetch: async (url, options) => {
      assert.equal(options.redirect, "manual");
      if (!options.method) {
        const source = new URL(url).searchParams.get("source");
        return response(200, {
          source,
          families: completeFamilies(source),
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
  assert.deepEqual(resolutionCalls, { legacy: 1, cloudflare: 1 });
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

  // A syntactically valid Cloudflare POST receipt is still downgraded unless
  // the exact curated source family can be read back from that same origin.
  const missingReadback = await runCuratedDualSync(plan(), {
    mode: "sync",
    planDirectory: sandbox,
    resolveTarget: async (_target, _directory, _options, name) => ({
      baseUrl: `https://${name}.invalid`,
      backend: name === "legacy" ? "legacy_notes_supabase" : "cloudflare_d1",
      adminKey: `fixture-${name}-key`,
    }),
    fetch: async (url, options) => {
      if (!options.method) {
        const source = new URL(url).searchParams.get("source");
        const families = completeFamilies(source);
        return response(200, {
          source,
          families: source === "curated" ? families.slice(0, 2) : families,
          next_cursor: null,
        });
      }
      const envelope = JSON.parse(options.body);
      return url.startsWith("https://legacy.invalid")
        ? response(200, { brain_doc_id: `legacy-${envelope.source_id}`, action: "unchanged" })
        : response(200, { doc_uid: `curated:${envelope.source_id}`, action: "unchanged" });
    },
    writeLedger: () => {},
  });
  assert.equal(missingReadback.targetCoverage.cloudflare_confirmed.total, 2);
  assert.equal(missingReadback.ok, false);

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
        const source = new URL(url).searchParams.get("source");
        return response(200, {
          source,
          families: source === "curated" ? completeFamilies(source) : [],
          next_cursor: null,
        });
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
          const source = new URL(url).searchParams.get("source");
          return response(200, {
            source,
            families: completeFamilies(source),
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
    rawDrive: allStatus(prepared, "historical_checksum_match"),
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
