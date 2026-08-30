import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  corpusCompletenessHardGates,
  corpusContractReadiness,
  corpusReconciliationUnavailable,
  createCorpusReconciliationCollector,
  loadCorpusContract,
  validateCorpusContract,
} from "./corpus-contract.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function fixtureContract() {
  return {
    schema_version: 1,
    contract_id: "fixture-corpus",
    contract_version: "2026-08-25",
    installation_ref: "fixture-install",
    captured_at: "2026-08-25T00:00:00.000Z",
    inventory_complete: true,
    inventory_hash: HASH_A,
    connector_snapshots: [{
      connector: "drive",
      observed_at: "2026-08-25T00:00:00.000Z",
      complete: true,
      cursor_hash: HASH_B,
      policy_hash: HASH_C,
    }],
    sources: [
      {
        source_id: "private-source-a",
        connector: "drive",
        locator_kind: "drive_file_id",
        canonical_locator: "Private/Medical Record.pdf",
        index_source_id: "document-a",
        domains: ["health"],
        owner_scope: ["owner"],
        sensitivity: "highly_restricted",
        expected_status: "eligible",
        mime_type: "application/pdf",
        extraction_mode: "ocr",
        page_count: 4,
        content_hash: HASH_D,
        source_version: "private-revision-a",
        priority: "critical",
        required_fields: ["effective-date"],
        expected_case_ids: ["health-001"],
      },
      {
        source_id: "private-source-b",
        connector: "drive",
        locator_kind: "drive_file_id",
        canonical_locator: "Private/Excluded Record.pdf",
        index_source_id: "document-b",
        domains: ["health"],
        owner_scope: ["owner"],
        sensitivity: "restricted",
        expected_status: "excluded",
        status_reason_code: "owner-policy",
        mime_type: "application/pdf",
        extraction_mode: "none",
        page_count: 1,
        content_hash: HASH_C,
        priority: "high",
        required_fields: [],
      },
    ],
  };
}

test("strict corpus preflight validates topology and manifest binding", () => {
  const contract = fixtureContract();
  assert.equal(validateCorpusContract(contract, {
    installationRef: "fixture-install",
    now: Date.parse("2026-08-25T01:00:00.000Z"),
  }), contract);
  assert.deepEqual(corpusContractReadiness(contract), { status: "ready", failures: [] });

  assert.throws(
    () => validateCorpusContract({ ...contract, private_path: "/do/not/report" }, {
      installationRef: "fixture-install",
      now: Date.parse("2026-08-25T01:00:00.000Z"),
    }),
    /unknown fields/,
  );
  assert.throws(
    () => validateCorpusContract(contract, {
      installationRef: "another-install",
      now: Date.parse("2026-08-25T01:00:00.000Z"),
    }),
    (error) => error.code === "CORPUS_CONTRACT_INSTALLATION_MISMATCH" &&
      !error.message.includes("fixture-install") && !error.message.includes("another-install"),
  );

  const duplicate = fixtureContract();
  duplicate.sources[1].index_source_id = "document-a";
  assert.throws(
    () => validateCorpusContract(duplicate, {
      installationRef: "fixture-install",
      now: Date.parse("2026-08-25T01:00:00.000Z"),
    }),
    /maps two sources to one index family/,
  );

  const dottedConnector = fixtureContract();
  dottedConnector.connector_snapshots[0].connector = "drive.private";
  dottedConnector.sources.forEach((source) => { source.connector = "drive.private"; });
  assert.throws(
    () => validateCorpusContract(dottedConnector, {
      installationRef: "fixture-install",
      now: Date.parse("2026-08-25T01:00:00.000Z"),
    }),
    /connector is invalid/,
  );

  const longVersion = fixtureContract();
  longVersion.sources[0].source_version = "x".repeat(513);
  assert.throws(
    () => validateCorpusContract(longVersion, {
      installationRef: "fixture-install",
      now: Date.parse("2026-08-25T01:00:00.000Z"),
    }),
    /source_version is invalid/,
  );

  for (const capturedAt of ["2026-08-25", "2026-02-30T00:00:00Z"]) {
    const invalidTimestamp = fixtureContract();
    invalidTimestamp.captured_at = capturedAt;
    assert.throws(
      () => validateCorpusContract(invalidTimestamp, {
        installationRef: "fixture-install",
        now: Date.parse("2026-08-25T01:00:00.000Z"),
      }),
      /RFC 3339 timestamp/,
    );
  }

  const schema = JSON.parse(readFileSync(
    new URL("./schema/corpus-contract-v1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.$defs.connector.pattern, "^[a-z0-9][a-z0-9_-]{0,63}$");
  assert.equal(schema.$defs.source.properties.connector.$ref, "#/$defs/connector");
  assert.equal(schema.$defs.source.properties.source_version.maxLength, 512);
});

test("incomplete independent snapshots are not observable before credentials", () => {
  const contract = fixtureContract();
  contract.inventory_complete = false;
  contract.connector_snapshots[0].complete = false;
  const result = corpusContractReadiness(contract);
  assert.equal(result.status, "not_observable");
  assert.deepEqual(result.failures, [
    { stage: "corpus_contract", code: "CORPUS_INVENTORY_INCOMPLETE", count: 1 },
    { stage: "connector_snapshot", code: "CONNECTOR_SNAPSHOT_INCOMPLETE", count: 1 },
  ]);
});

test("private contract reads use owner-only stable regular files", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-corpus-contract-"));
  try {
    const path = join(root, "private-contract.json");
    writeFileSync(path, JSON.stringify(fixtureContract()), { mode: 0o600 });
    const loaded = await loadCorpusContract(path, {
      installationRef: "fixture-install",
      now: Date.parse("2026-08-25T01:00:00.000Z"),
    });
    assert.equal(loaded.contract.contract_id, "fixture-corpus");
    assert.match(loaded.contract_hash, /^sha256:[a-f0-9]{64}$/);

    const hardLink = join(root, "hard-link.json");
    linkSync(path, hardLink);
    await assert.rejects(
      loadCorpusContract(path, {
        installationRef: "fixture-install",
        now: Date.parse("2026-08-25T01:00:00.000Z"),
      }),
      /one private regular file/,
    );

    rmSync(hardLink);
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      await assert.rejects(
        loadCorpusContract(path, {
          installationRef: "fixture-install",
          now: Date.parse("2026-08-25T01:00:00.000Z"),
        }),
        /permissions must be 0600 or stricter/,
      );
      chmodSync(path, 0o600);

      const linked = join(root, "linked.json");
      symlinkSync(path, linked);
      await assert.rejects(
        loadCorpusContract(linked, {
          installationRef: "fixture-install",
          now: Date.parse("2026-08-25T01:00:00.000Z"),
        }),
        /symbolic link|readable private file/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation proves every declared slice without returning private identities", () => {
  const contract = fixtureContract();
  const bundle = { contract, contract_hash: HASH_B };
  const collector = createCorpusReconciliationCollector(bundle);
  collector.observe("drive", "drive:document-a");
  const result = collector.finish();

  assert.equal(result.status, "pass");
  assert.deepEqual(result.totals, {
    expected: 2,
    observed: 1,
    indexed_expected: 1,
    accounted: 2,
    missing: 0,
    policy_leaks: 0,
    unknown: 0,
  });
  assert.deepEqual(result.slices.domain.health, {
    expected: 2,
    indexed: 1,
    accounted: 2,
    missing: 0,
    policy_leaks: 0,
    pass: true,
  });
  assert.equal(result.content_version.reason, "CONTENT_HASH_OBSERVATION_UNAVAILABLE");
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "private-source-a", "private-source-b", "document-a", "document-b",
    "Medical Record", "Excluded Record", "private-revision-a",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue, "i"));
  }
});

test("missing, policy-leak, and unknown sources retain stage-specific aggregate codes", () => {
  const contract = fixtureContract();
  const bundle = { contract, contract_hash: HASH_B };
  const collector = createCorpusReconciliationCollector(bundle);
  collector.observe("drive", "drive:document-b");
  collector.observe("drive", "drive:unknown-private-document");
  const result = collector.finish();

  assert.equal(result.status, "fail");
  assert.deepEqual(result.failures, [
    { stage: "policy_state", code: "EXCLUDED_SOURCE_INDEXED", count: 1 },
    { stage: "source_inventory", code: "SOURCE_NOT_INDEXED", count: 1 },
    { stage: "source_inventory", code: "UNKNOWN_INDEX_SOURCE", count: 1 },
  ]);
  assert.deepEqual(
    corpusCompletenessHardGates(result).map((entry) => [entry.scope, entry.reason]),
    [
      ["corpus", "EXCLUDED_SOURCE_INDEXED"],
      ["corpus", "SOURCE_NOT_INDEXED"],
      ["corpus", "UNKNOWN_INDEX_SOURCE"],
    ],
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /unknown-private-document|document-b|Private\//);

  const unavailable = corpusReconciliationUnavailable(bundle);
  assert.equal(unavailable.status, "not_observable");
  assert.deepEqual(unavailable.failures, [{
    stage: "source_inventory",
    code: "SOURCE_INVENTORY_NOT_OBSERVABLE",
    count: 1,
  }]);
});

test("a denormalized inventory-summary mismatch is a blocking aggregate failure", () => {
  const contract = fixtureContract();
  const collector = createCorpusReconciliationCollector({ contract, contract_hash: HASH_B });
  collector.observe("drive", "drive:document-a");
  const result = collector.finish({ inventoryMismatchCount: 1 });
  assert.equal(result.status, "fail");
  assert.deepEqual(result.failures, [{
    stage: "source_inventory",
    code: "SOURCE_INVENTORY_SUMMARY_DRIFT",
    count: 1,
  }]);
  assert.equal(corpusCompletenessHardGates(result)[0].reason, "SOURCE_INVENTORY_SUMMARY_DRIFT");
});
