/**
 * Private corpus-contract preflight and aggregate-only reconciliation.
 *
 * The contract may contain paths, connector identities, and content hashes.
 * Those values are needed locally to decide whether each logical source family
 * reached D1, but they are never copied into a run result. The only public
 * result shape below is counts, declared slice labels, hashes, and typed codes.
 */

import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const CONTRACT_MAX_BYTES = 16 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CONNECTOR = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const TOP_LEVEL_FIELDS = new Set([
  "schema_version", "contract_id", "contract_version", "installation_ref",
  "captured_at", "inventory_complete", "inventory_hash",
  "connector_snapshots", "sources",
]);
const SNAPSHOT_FIELDS = new Set([
  "connector", "observed_at", "complete", "cursor_hash", "policy_hash",
]);
const SOURCE_FIELDS = new Set([
  "source_id", "connector", "locator_kind", "canonical_locator",
  "index_source_id", "domains", "owner_scope", "sensitivity",
  "expected_status", "status_reason_code", "mime_type", "extraction_mode",
  "page_count", "content_hash", "source_version", "modified_at",
  "effective_from", "effective_to", "priority", "required_fields",
  "expected_case_ids",
]);

const LOCATOR_KINDS = new Set([
  "local_path", "drive_file_id", "gmail_message_id", "source_native_id",
  "synthetic_fixture",
]);
const SENSITIVITIES = new Set([
  "public", "internal", "restricted", "highly_restricted",
]);
const EXPECTED_STATUSES = new Set([
  "eligible", "excluded", "quarantined", "tombstoned",
]);
const EXTRACTION_MODES = new Set([
  "native_text", "structured", "ocr", "image_unsupported",
  "binary_unsupported", "none",
]);
const PRIORITIES = new Set(["critical", "high", "normal"]);

export const CORPUS_FAILURE_STAGES = Object.freeze({
  contract: "corpus_contract",
  connector: "connector_snapshot",
  inventory: "source_inventory",
  policy: "policy_state",
});

function fail(message, code = "CORPUS_CONTRACT_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
}

function assertExactFields(value, allowed, label) {
  const extras = Object.keys(value).filter((field) => !allowed.has(field));
  if (extras.length > 0) fail(`${label} has unknown fields`);
}

function assertString(value, label, { min = 1, max = 4096, pattern = null } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max ||
      (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
  return value;
}

function assertPrivateIdentifier(value, label) {
  assertString(value, label);
  if (CONTROL.test(value)) fail(`${label} contains a control character`);
  return value;
}

function assertHash(value, label) {
  return assertString(value, label, { min: 71, max: 71, pattern: HASH });
}

function timestampMs(value, label) {
  assertString(value, label, { max: 64 });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a timestamp`);
  return parsed;
}

function assertNullableTimestamp(value, label) {
  if (value === undefined || value === null) return;
  timestampMs(value, label);
}

function assertUniqueStrings(value, label, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minItems ||
      value.some((entry) => typeof entry !== "string" || !SLUG.test(entry)) ||
      new Set(value).size !== value.length) {
    fail(`${label} must contain unique lowercase labels`);
  }
}

function contractFamily(source) {
  const privateIdentity = source.index_source_id ?? source.canonical_locator;
  return privateIdentity.startsWith(`${source.connector}:`)
    ? privateIdentity
    : `${source.connector}:${privateIdentity}`;
}

/**
 * Validate the executable subset of corpus-contract-v1 strictly.
 *
 * JSON Schema remains the public shape. This runtime guard also enforces the
 * cross-record invariants JSON Schema cannot express: connector uniqueness,
 * stable logical-family uniqueness, complete-snapshot proof fields, and the
 * manifest-to-contract installation binding.
 */
export function validateCorpusContract(contract, {
  installationRef = null,
  now = Date.now(),
} = {}) {
  assertRecord(contract, "corpus contract");
  assertExactFields(contract, TOP_LEVEL_FIELDS, "corpus contract");
  for (const field of [
    "schema_version", "contract_id", "contract_version", "installation_ref",
    "captured_at", "inventory_complete", "connector_snapshots", "sources",
  ]) {
    if (!Object.hasOwn(contract, field)) fail(`corpus contract is missing ${field}`);
  }
  if (contract.schema_version !== 1) {
    fail("corpus contract schema_version must be 1", "CORPUS_CONTRACT_VERSION_UNSUPPORTED");
  }
  assertString(contract.contract_id, "corpus contract contract_id", { max: 128, pattern: SLUG });
  assertString(contract.contract_version, "corpus contract contract_version", { max: 128 });
  assertString(contract.installation_ref, "corpus contract installation_ref", { max: 128, pattern: SLUG });
  if (installationRef !== null && contract.installation_ref !== installationRef) {
    fail(
      "corpus contract installation_ref does not match this manifest",
      "CORPUS_CONTRACT_INSTALLATION_MISMATCH",
    );
  }
  const capturedAt = timestampMs(contract.captured_at, "corpus contract captured_at");
  if (capturedAt > now + CLOCK_SKEW_MS) fail("corpus contract captured_at is in the future");
  if (typeof contract.inventory_complete !== "boolean") {
    fail("corpus contract inventory_complete must be boolean");
  }
  if (contract.inventory_hash !== undefined) {
    assertHash(contract.inventory_hash, "corpus contract inventory_hash");
  }
  if (contract.inventory_complete && !contract.inventory_hash) {
    fail("a complete corpus contract requires inventory_hash");
  }
  if (!Array.isArray(contract.connector_snapshots)) {
    fail("corpus contract connector_snapshots must be an array");
  }
  if (!Array.isArray(contract.sources)) fail("corpus contract sources must be an array");

  const snapshots = new Map();
  contract.connector_snapshots.forEach((snapshot, index) => {
    const label = `connector snapshot ${index + 1}`;
    assertRecord(snapshot, label);
    assertExactFields(snapshot, SNAPSHOT_FIELDS, label);
    for (const field of ["connector", "observed_at", "complete"]) {
      if (!Object.hasOwn(snapshot, field)) fail(`${label} is missing ${field}`);
    }
    assertString(snapshot.connector, `${label} connector`, { max: 64, pattern: CONNECTOR });
    if (snapshots.has(snapshot.connector)) fail("corpus contract has duplicate connector snapshots");
    const observedAt = timestampMs(snapshot.observed_at, `${label} observed_at`);
    if (observedAt > capturedAt + CLOCK_SKEW_MS || observedAt > now + CLOCK_SKEW_MS) {
      fail(`${label} observed_at is later than the contract capture`);
    }
    if (typeof snapshot.complete !== "boolean") fail(`${label} complete must be boolean`);
    if (snapshot.cursor_hash !== undefined) assertHash(snapshot.cursor_hash, `${label} cursor_hash`);
    if (snapshot.policy_hash !== undefined) assertHash(snapshot.policy_hash, `${label} policy_hash`);
    if (snapshot.complete && (!snapshot.cursor_hash || !snapshot.policy_hash)) {
      fail(`${label} needs cursor_hash and policy_hash when complete`);
    }
    snapshots.set(snapshot.connector, snapshot);
  });

  const sourceIds = new Set();
  const families = new Set();
  contract.sources.forEach((source, index) => {
    const label = `corpus source ${index + 1}`;
    assertRecord(source, label);
    assertExactFields(source, SOURCE_FIELDS, label);
    for (const field of [
      "source_id", "connector", "locator_kind", "canonical_locator", "domains",
      "owner_scope", "sensitivity", "expected_status", "mime_type",
      "extraction_mode", "content_hash", "priority", "required_fields",
    ]) {
      if (!Object.hasOwn(source, field)) fail(`${label} is missing ${field}`);
    }
    assertString(source.source_id, `${label} source_id`, { max: 128, pattern: SLUG });
    if (sourceIds.has(source.source_id)) fail("corpus contract has duplicate source_id values");
    sourceIds.add(source.source_id);
    assertString(source.connector, `${label} connector`, { max: 64, pattern: CONNECTOR });
    if (!snapshots.has(source.connector)) fail(`${label} has no connector snapshot`);
    if (!LOCATOR_KINDS.has(source.locator_kind)) fail(`${label} locator_kind is invalid`);
    assertPrivateIdentifier(source.canonical_locator, `${label} canonical_locator`);
    if (source.index_source_id !== undefined) {
      assertPrivateIdentifier(source.index_source_id, `${label} index_source_id`);
    }
    const family = contractFamily(source);
    if (families.has(family)) fail("corpus contract maps two sources to one index family");
    families.add(family);
    assertUniqueStrings(source.domains, `${label} domains`, { minItems: 1 });
    assertUniqueStrings(source.owner_scope, `${label} owner_scope`);
    if (!SENSITIVITIES.has(source.sensitivity)) fail(`${label} sensitivity is invalid`);
    if (!EXPECTED_STATUSES.has(source.expected_status)) fail(`${label} expected_status is invalid`);
    if (source.expected_status !== "eligible") {
      assertString(source.status_reason_code, `${label} status_reason_code`, { max: 128, pattern: SLUG });
    } else if (source.status_reason_code !== undefined) {
      assertString(source.status_reason_code, `${label} status_reason_code`, { max: 128, pattern: SLUG });
    }
    assertString(source.mime_type, `${label} mime_type`, { max: 255, pattern: MIME_TYPE });
    if (!EXTRACTION_MODES.has(source.extraction_mode)) fail(`${label} extraction_mode is invalid`);
    if (source.page_count !== undefined && source.page_count !== null &&
        (!Number.isSafeInteger(source.page_count) || source.page_count < 0)) {
      fail(`${label} page_count must be a non-negative integer or null`);
    }
    assertHash(source.content_hash, `${label} content_hash`);
    if (source.source_version !== undefined) {
      assertPrivateIdentifier(source.source_version, `${label} source_version`);
    }
    assertNullableTimestamp(source.modified_at, `${label} modified_at`);
    assertNullableTimestamp(source.effective_from, `${label} effective_from`);
    assertNullableTimestamp(source.effective_to, `${label} effective_to`);
    if (source.effective_from && source.effective_to &&
        Date.parse(source.effective_from) > Date.parse(source.effective_to)) {
      fail(`${label} effective_from is later than effective_to`);
    }
    if (!PRIORITIES.has(source.priority)) fail(`${label} priority is invalid`);
    assertUniqueStrings(source.required_fields, `${label} required_fields`);
    if (source.expected_case_ids !== undefined) {
      assertUniqueStrings(source.expected_case_ids, `${label} expected_case_ids`);
    }
  });

  return contract;
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs;
}

/** Read one private contract through a stable no-follow descriptor. */
export async function loadCorpusContract(path, options = {}) {
  const absolute = resolve(path);
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const handle = await open(absolute, fsConstants.O_RDONLY | noFollow).catch((error) => {
    if (error?.code === "ELOOP") fail("corpus contract must not be a symbolic link");
    fail("corpus contract is not a readable private file");
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      fail("corpus contract must be one private regular file");
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      fail("corpus contract must be owned by the current user");
    }
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      fail("corpus contract permissions must be 0600 or stricter");
    }
    if (before.size < 2 || before.size > CONTRACT_MAX_BYTES) {
      fail("corpus contract size is invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.length !== before.size) {
      fail("corpus contract changed while it was being read");
    }
    let contract;
    try {
      contract = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("corpus contract is not valid JSON");
    }
    validateCorpusContract(contract, options);
    return {
      contract,
      contract_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } finally {
    await handle.close();
  }
}

/**
 * A valid but incomplete contract cannot certify anything. Keep this separate
 * from schema validation so the caller can report not-observable with exact,
 * aggregate codes before it resolves a credential or opens a network path.
 */
export function corpusContractReadiness(contract) {
  const failures = [];
  if (contract.inventory_complete !== true) {
    failures.push({
      stage: CORPUS_FAILURE_STAGES.contract,
      code: "CORPUS_INVENTORY_INCOMPLETE",
      count: 1,
    });
  }
  const incomplete = contract.connector_snapshots.filter((snapshot) => snapshot.complete !== true).length;
  if (incomplete > 0) {
    failures.push({
      stage: CORPUS_FAILURE_STAGES.connector,
      code: "CONNECTOR_SNAPSHOT_INCOMPLETE",
      count: incomplete,
    });
  }
  return { status: failures.length ? "not_observable" : "ready", failures };
}

export function formatCorpusReadinessFailure(readiness) {
  const summary = (readiness?.failures || [])
    .map((failure) => `${failure.code} (${failure.count})`)
    .join(", ");
  return `corpus completeness is not observable before retrieval: ${summary || "CORPUS_CONTRACT_NOT_READY"}`;
}

function statusFailureCode(status) {
  if (status === "excluded") return "EXCLUDED_SOURCE_INDEXED";
  if (status === "quarantined") return "QUARANTINED_SOURCE_INDEXED";
  if (status === "tombstoned") return "TOMBSTONED_SOURCE_INDEXED";
  return null;
}

function addFailure(counts, stage, code, count = 1) {
  const key = `${stage}\u0000${code}`;
  const current = counts.get(key) || { stage, code, count: 0 };
  current.count += count;
  counts.set(key, current);
}

function sourceSliceLabels(source) {
  return {
    connector: [source.connector],
    domain: source.domains,
    priority: [source.priority],
    format: [source.mime_type],
    extraction_mode: [source.extraction_mode],
    sensitivity: [source.sensitivity],
    expected_status: [source.expected_status],
  };
}

function emptySlice() {
  return {
    expected: 0,
    indexed: 0,
    accounted: 0,
    missing: 0,
    policy_leaks: 0,
    pass: true,
  };
}

function sortedSlices(dimensions) {
  return Object.fromEntries([...dimensions].sort(([a], [b]) => a.localeCompare(b)).map(
    ([dimension, values]) => [dimension, Object.fromEntries(
      [...values].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => [label, value]),
    )],
  ));
}

/**
 * Match authenticated logical-family observations while retaining no observed
 * identity in the finished result. A collector is used instead of a giant
 * observed array so a large corpus has bounded extra memory beyond its private
 * contract.
 */
export function createCorpusReconciliationCollector(bundle) {
  const { contract, contract_hash: contractHash } = bundle;
  const expectedByFamily = new Map();
  for (const source of contract.sources) expectedByFamily.set(contractFamily(source), source);
  const present = new Set();
  const lastObservedByConnector = new Map();
  let observed = 0;
  let unknown = 0;

  return {
    observe(connector, family) {
      if (typeof connector !== "string" || !CONNECTOR.test(connector) ||
          typeof family !== "string" || !family.startsWith(`${connector}:`) ||
          CONTROL.test(family)) {
        fail("Brain source-family observation is invalid", "SOURCE_INVENTORY_INVALID");
      }
      const previous = lastObservedByConnector.get(connector);
      if (previous && family <= previous) {
        fail("Brain source-family observation is not ordered and unique", "SOURCE_INVENTORY_INVALID");
      }
      lastObservedByConnector.set(connector, family);
      observed++;
      const expected = expectedByFamily.get(family);
      if (expected) present.add(expected.source_id);
      else unknown++;
    },

    finish() {
      const failures = new Map();
      const dimensions = new Map();
      let indexed = 0;
      let accounted = 0;
      let missing = 0;
      let policyLeaks = 0;

      for (const source of contract.sources) {
        const isPresent = present.has(source.source_id);
        const shouldBePresent = source.expected_status === "eligible";
        const isAccounted = isPresent === shouldBePresent;
        const isMissing = shouldBePresent && !isPresent;
        const isPolicyLeak = !shouldBePresent && isPresent;
        if (isPresent) indexed++;
        if (isAccounted) accounted++;
        if (isMissing) {
          missing++;
          addFailure(failures, CORPUS_FAILURE_STAGES.inventory, "SOURCE_NOT_INDEXED");
        }
        if (isPolicyLeak) {
          policyLeaks++;
          addFailure(
            failures,
            CORPUS_FAILURE_STAGES.policy,
            statusFailureCode(source.expected_status),
          );
        }

        for (const [dimension, labels] of Object.entries(sourceSliceLabels(source))) {
          let values = dimensions.get(dimension);
          if (!values) {
            values = new Map();
            dimensions.set(dimension, values);
          }
          for (const label of labels) {
            const slice = values.get(label) || emptySlice();
            slice.expected++;
            if (isPresent) slice.indexed++;
            if (isAccounted) slice.accounted++;
            if (isMissing) slice.missing++;
            if (isPolicyLeak) slice.policy_leaks++;
            slice.pass = slice.missing === 0 && slice.policy_leaks === 0;
            values.set(label, slice);
          }
        }
      }

      if (unknown > 0) {
        addFailure(failures, CORPUS_FAILURE_STAGES.inventory, "UNKNOWN_INDEX_SOURCE", unknown);
      }
      const failureList = [...failures.values()].sort((a, b) =>
        a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code));
      return {
        schema_version: 1,
        status: failureList.length ? "fail" : "pass",
        claim_boundary: "logical-source-family-presence-and-policy-absence",
        contract_hash: contractHash,
        inventory_hash: contract.inventory_hash,
        totals: {
          expected: contract.sources.length,
          observed,
          indexed_expected: indexed,
          accounted,
          missing,
          policy_leaks: policyLeaks,
          unknown,
        },
        slices: sortedSlices(dimensions),
        failures: failureList,
        content_version: {
          status: "not_observable",
          reason: "CONTENT_HASH_OBSERVATION_UNAVAILABLE",
        },
      };
    },
  };
}

export function corpusReconciliationUnavailable(bundle, code = "SOURCE_INVENTORY_NOT_OBSERVABLE") {
  return {
    schema_version: 1,
    status: "not_observable",
    claim_boundary: "logical-source-family-presence-and-policy-absence",
    contract_hash: bundle.contract_hash,
    inventory_hash: bundle.contract.inventory_hash,
    totals: {
      expected: bundle.contract.sources.length,
      observed: null,
      indexed_expected: null,
      accounted: null,
      missing: null,
      policy_leaks: null,
      unknown: null,
    },
    slices: {},
    failures: [{
      stage: CORPUS_FAILURE_STAGES.inventory,
      code,
      count: 1,
    }],
    content_version: {
      status: "not_observable",
      reason: "CONTENT_HASH_OBSERVATION_UNAVAILABLE",
    },
  };
}

export function corpusCompletenessHardGates(result) {
  if (!result) return [];
  return (result.failures || []).map((failure) => ({
    id: `__corpus__:${failure.stage}:${failure.code}`,
    scope: "corpus",
    pass: 1,
    reason: failure.code,
  }));
}
