// Cross-source conformance gate for the common ingestion contract.
//
// This is intentionally not a connector acceptance test. Every provider and
// filesystem boundary here is local or scripted. It proves that once a source
// reports what happened, the orchestration layer cannot shape incomplete work
// like success, advance a failed cursor, reconcile an incomplete family, or
// form a deletion plan from identifiers absent from authenticated storage.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  declaredFamilyUid,
  describeLoadResult,
  localWalkSnapshotFingerprint,
  messageIngestionResult,
  planLoad,
  positiveWholeIngestLimit,
  remoteFamilyOutcomes,
  remoteFamilySettlement,
  sourceCursorCanAdvance,
} from "../brain.mjs";
import {
  INGESTION_OUTCOME_KINDS,
  assertIngestionOutcome,
  ingestionOutcome,
} from "../ingest/outcome.mjs";
import { prepare, walk } from "../ingest/run.mjs";
import { buildDriveRemovalPlan } from "../operations/drive-removal-plan.mjs";
import { sourceFamilyCounts } from "../worker/src/lib/store-d1.js";

let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

/* A malformed customer-entered bound must stop before any producer can run. */
assert.equal(positiveWholeIngestLimit(undefined), Infinity);
assert.equal(positiveWholeIngestLimit("1"), 1);
assert.equal(positiveWholeIngestLimit(25), 25);
for (const invalid of [true, "nope", "-1", "0", "1.5", "1 item", "9007199254740992"]) {
  assert.throws(() => positiveWholeIngestLimit(invalid), /--limit/);
}
check("--limit accepts only a positive safe whole number", true);

{
  const directory = mkdtempSync(join(tmpdir(), "brain-moving-folder-"));
  try {
    writeFileSync(join(directory, "first.txt"), "first stable fixture document");
    const before = walk(directory);
    const stableAgain = walk(directory);
    check("an unchanged local folder keeps one generation fingerprint",
      localWalkSnapshotFingerprint(before) === localWalkSnapshotFingerprint(stableAgain));
    writeFileSync(join(directory, "arrived-during-load.txt"), "second fixture document");
    const after = walk(directory);
    check("a file arriving during local ingest changes the generation fingerprint",
      localWalkSnapshotFingerprint(before) !== localWalkSnapshotFingerprint(after));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const malformedMessageCapture = messageIngestionResult({
  documents_sent: 1,
  rows_skipped: { no_guid: 1, no_timestamp: 0, no_text: 4 },
}, { created: 1, updated: 0, unchanged: 0, refused: 0 });
check("an accepted message capture with an unusable identity row remains partial",
  malformedMessageCapture.outcome.kind === "partial" && malformedMessageCapture.coverage_gaps === 1);
const textOnlyPolicyCapture = messageIngestionResult({
  documents_sent: 1,
  rows_skipped: { media_only: 3, no_text: 2, no_identity: 0, no_timestamp: 0 },
}, { created: 1, updated: 0, unchanged: 0, refused: 0 });
check("explicit media-only and empty-text policy omissions do not fabricate a data-integrity failure",
  textOnlyPolicyCapture.outcome.kind === "completed" && textOnlyPolicyCapture.coverage_gaps === 0);

/* The five public states have one canonical, non-overlapping shape. */
const outcomes = Object.fromEntries(
  INGESTION_OUTCOME_KINDS.map((kind) => [kind, ingestionOutcome(kind, { reason: `${kind} fixture` })])
);
for (const value of Object.values(outcomes)) assertIngestionOutcome(value);
check("only completed work is success-shaped",
  outcomes.completed.ok && outcomes.completed.complete &&
  INGESTION_OUTCOME_KINDS.filter((kind) => kind !== "completed")
    .every((kind) => outcomes[kind].ok === false && outcomes[kind].complete === false));
check("partial means some work landed without claiming completion",
  outcomes.partial.accepted === true && outcomes.partial.complete === false);
check("unavailable is distinct from a retryable failed attempt",
  outcomes.unavailable.available === false && outcomes.unavailable.retryable === false &&
  outcomes.retryable.available === true && outcomes.retryable.retryable === true);
check("refused is explicit and carries no accepted-work flag",
  outcomes.refused.refused === true && outcomes.refused.accepted === false);
assert.throws(
  () => assertIngestionOutcome({ ...outcomes.completed, ok: false }),
  /invalid ok flag/,
);
check("a forged success-shaped outcome is rejected", true);

/* Real load-result adapters emit that same contract, not connector folklore. */
const folderComplete = describeLoadResult({ created: 2, updated: 0, unchanged: 1, refused: 0 });
const folderPartial = describeLoadResult({ created: 1, updated: 0, unchanged: 0, refused: 1 });
const folderSkipped = describeLoadResult({
  created: 1, updated: 0, unchanged: 0, refused: 0, skipped: 9,
});
const folderPolicySkipped = describeLoadResult({
  created: 1, updated: 0, unchanged: 0, refused: 0, skipped: 2, policy_skipped: 2,
});
const folderIncompleteExtraction = describeLoadResult({
  created: 1, updated: 0, unchanged: 0, refused: 0, skipped: 0, incomplete: 1,
});
const folderAllSkipped = describeLoadResult({
  created: 0, updated: 0, unchanged: 0, refused: 0, skipped: 4,
});
const folderActuallyEmpty = describeLoadResult({
  created: 0, updated: 0, unchanged: 0, refused: 0, skipped: 0, scanned: 0, source_inventory: 0,
});
const calendarPartial = describeLoadResult({
  sent: { created: 1, updated: 0, unchanged: 0, refused: [], errors: [{}] },
});
const calendarCleanupPartial = describeLoadResult({
  sent: { created: 1, updated: 0, unchanged: 0, refused: [], errors: [] },
  removalPending: 1,
});
const messagePartial = describeLoadResult({ documents_sent: 2, rows_seen: 5, truncated: true });
const messageBounded = describeLoadResult({ documents_sent: 2, rows_seen: 5, bounded: true });
const messageRefused = describeLoadResult({
  documents_sent: 2, documents_accepted: 1, rows_seen: 5, refused: 1,
  outcome: outcomes.partial,
});
const preview = describeLoadResult({ dry_run: true, would_send: 3, unchanged: 0 });
assert.throws(() => describeLoadResult(undefined), /no recognized completion receipt/);
check("an absent connector receipt cannot be promoted to completed", true);
const countFreeCompletion = describeLoadResult({ outcome: outcomes.completed });
check("a count-free completion must carry the explicit validated outcome",
  countFreeCompletion.outcome.kind === "completed" && countFreeCompletion.known === false);
check("folder completion uses the completed contract",
  folderComplete.outcome.kind === "completed" && folderComplete.partial === false);
check("folder refusal makes the source partial, never complete",
  folderPartial.outcome.kind === "partial" && folderPartial.outcome.ok === false);
check("ordinary skipped files make a partly loaded folder explicit",
  folderSkipped.outcome.kind === "partial" && folderSkipped.partial === true &&
  /9 skipped/.test(folderSkipped.text));
check("an explicit owner policy exclusion remains complete within that policy",
  folderPolicySkipped.outcome.kind === "completed" && folderPolicySkipped.partial === false);
check("known extraction truncation makes the source partial even when its document was accepted",
  folderIncompleteExtraction.outcome.kind === "partial" &&
  /1 incomplete/.test(folderIncompleteExtraction.text));
check("an all-skipped folder carries no accepted-work claim",
  folderAllSkipped.outcome.kind === "refused" && folderAllSkipped.acceptedWork === false);
check("an authoritatively empty folder is not promoted into the brain",
  folderActuallyEmpty.outcome.kind === "refused" && folderActuallyEmpty.acceptedWork === false &&
    /authoritative source inventory is empty/.test(folderActuallyEmpty.text));
check("Calendar send errors make the source partial",
  calendarPartial.outcome.kind === "partial" && calendarPartial.outcome.complete === false);
check("Calendar pending cancellation cleanup makes the source partial",
  calendarCleanupPartial.outcome.kind === "partial" && calendarCleanupPartial.outcome.complete === false);
check("a bounded message capture is partial",
  messagePartial.outcome.kind === "partial" && messagePartial.outcome.complete === false &&
  messageBounded.outcome.kind === "partial" && messageBounded.outcome.complete === false);
check("a refused message is partial and only accepted documents count as present",
  messageRefused.outcome.kind === "partial" && messageRefused.documents === 1 &&
  /1 refused, NOT indexed/.test(messageRefused.text));
check("a dry run is a preview with no ingestion outcome",
  preview.dryRun === true && preview.outcome === null);

/* Planning distinguishes absence from an intentionally skipped source. */
const planned = await planLoad({
  m: {
    corpora: {
      whatsapp: { enabled: true },
      unavailable_api: { enabled: true },
      gmail: { enabled: false },
    },
  },
  manifestPath: "/fixture/brain.manifest.json",
  probes: {
    whatsapp: async () => ({ connected: false, reason: "fixture outbox absent" }),
  },
});
const byKey = Object.fromEntries(planned.map((entry) => [entry.key, entry]));
check("a disconnected built connector is explicitly unavailable",
  byKey.whatsapp.status === "unavailable" && byKey.whatsapp.outcome.kind === "unavailable");
check("an enabled source with no loader is explicitly unavailable",
  byKey.unavailable_api.status === "unavailable" && byKey.unavailable_api.outcome.kind === "unavailable");
check("a source the manifest disables is skipped, not unavailable",
  byKey.gmail.status === "skipped" && byKey.gmail.outcome === null);

/* Cursor and family settlement are withheld until every accepted receipt. */
const familyPlan = {
  stateKey: "drive:agreement",
  base_doc_uid: "drive:agreement",
  keep_doc_uids: ["drive:agreement#part1of2", "drive:agreement#part2of2"],
  expectedParts: 2,
};
const completeFamily = remoteFamilyOutcomes(
  [familyPlan], new Map([[familyPlan.stateKey, 2]]), new Map([[familyPlan.stateKey, 2]])
);
const incompleteFamily = remoteFamilyOutcomes(
  [familyPlan], new Map([[familyPlan.stateKey, 2]]), new Map([[familyPlan.stateKey, 1]])
);
check("a fully accepted family may reconcile",
  remoteFamilySettlement(completeFamily).reconciliations.length === 1);
const retrySettlement = remoteFamilySettlement(
  incompleteFamily, new Map([[familyPlan.stateKey, ["failed"]]])
);
check("a failed family remains retryable and emits no deletion instruction",
  retrySettlement.reconciliations.length === 0 && retrySettlement.intentionalRemovalUids.length === 0);
const refusedSettlement = remoteFamilySettlement(
  incompleteFamily, new Map([[familyPlan.stateKey, ["refused"]]])
);
check("a refused family is a removal candidate but never an immediate reconciliation",
  refusedSettlement.reconciliations.length === 0 &&
  refusedSettlement.intentionalRemovalUids[0] === familyPlan.base_doc_uid);
check("a failed document withholds the source cursor",
  sourceCursorCanAdvance({ failed: 1 }) === false && sourceCursorCanAdvance({ failed: 0 }) === true);

/* Multi-document file producers declare one stable source-file family. */
const sandbox = mkdtempSync(join(tmpdir(), "brain-ingestion-contract-"));
try {
  for (const relativeFixture of [
    "whatsapp/ios-unambiguous.txt",
    "sms-backup/sms-backup-restore.xml",
  ]) {
    const sourcePath = new URL(`./fixtures/${relativeFixture}`, import.meta.url);
    const destination = join(sandbox, basename(relativeFixture));
    const bytes = readFileSync(sourcePath);
    writeFileSync(destination, bytes);
    const file = { full: destination, rel: basename(destination), name: basename(destination), size: bytes.length };
    const result = await prepare(file, { sourceName: "custodian_export" });
    check(`${relativeFixture} produces multiple source documents`, result.envelopes?.length > 0);
    const family = declaredFamilyUid(result.envelopes, { rel: file.rel });
    check(`${relativeFixture} stamps one fully qualified family_of`,
      family === `custodian_export:${file.rel}` &&
      result.envelopes.every((envelope) => envelope.metadata?.family_of === family));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

/* Source freshness counts the same declared families deletion inventory sees. */
{
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE documents (
    doc_uid TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
    meta TEXT, deleted_at INTEGER
  )`);
  const insert = db.prepare(
    "INSERT INTO documents (doc_uid,source,source_id,meta,deleted_at) VALUES (?,?,?,?,?)"
  );
  insert.run("message:a", "message", "a", JSON.stringify({ family_of: "upload:chat.txt" }), null);
  insert.run("message:b", "message", "b", JSON.stringify({ family_of: "upload:chat.txt" }), null);
  insert.run("upload:note.txt", "upload", "note.txt", "{}", null);
  insert.run("message:c", "message", "c", JSON.stringify({ family_of: "custodian:messages.xml" }), null);
  insert.run("upload:gone.txt", "upload", "gone.txt", "{}", Date.now());
  const environment = {
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          bind(...values) {
            return { first: async () => statement.get(...values) ?? null };
          },
        };
      },
    },
  };
  const counts = await sourceFamilyCounts(environment, { source: "upload" });
  check("source freshness counts physical rows through declared cross-namespace families",
    counts.stored_documents === 3, JSON.stringify(counts));
  check("source freshness counts one export family plus one ordinary document",
    counts.logical_documents === 2, JSON.stringify(counts));
  await assert.rejects(() => sourceFamilyCounts(environment, { source: "upload %" }), /normalized source name/);
  check("source-family counting refuses an unsafe namespace", true);
  db.close();
}

/* Deletion candidates are intersected with authenticated stored truth. */
const deletion = buildDriveRemovalPlan({
  storedFamilies: ["upload:present", "upload:retained"],
  activeFamilies: ["upload:retained"],
  policyCandidates: ["upload:not-stored"],
  vanishedCandidates: ["upload:present", "upload:not-stored"],
  intentionalCandidates: [],
});
check("a deletion plan cannot target a family absent from stored inventory",
  deletion.total === 1 && deletion.targets.source_deleted[0] === "upload:present");
check("the deletion approval fingerprint covers the exact stored denominator",
  deletion.stored === 2 && /^[0-9a-f]{64}$/.test(deletion.fingerprint));

console.log(`\ningestion contract: all ${ran} checks passed`);
