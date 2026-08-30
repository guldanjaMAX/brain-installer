import assert from "node:assert/strict";
import { ingestionOutcome } from "../ingest/outcome.mjs";
import {
  ProviderDeliveryError,
  providerSnapshotRemovalFingerprint,
  runProviderConnector,
} from "../connectors/provider-runtime.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const document = (id = "one") => ({
  source_type: "fixture-provider", source_id: id, title: id, content: `Fixture content ${id}`,
  occurred_at: null, date_source: "none", date_reliable: false, uri: null, metadata: {},
});
const completeResult = () => ({
  provider: "fixture-provider",
  documents: [document()],
  deletions: [{ source_type: "fixture-provider", source_id: "gone" }],
  warnings: [],
  deletion_authority: "authoritative",
  proposed_cursor: { page: "opaque-next" },
  cursor_can_advance: true,
  outcome: ingestionOutcome("completed"),
});

function harness(overrides = {}) {
  const receipts = [];
  const states = [];
  const calls = { syncCursor: undefined, deletions: [] };
  let tick = 0;
  let familyRead = 0;
  return {
    receipts, states, calls,
    options: {
      provider: "fixture-provider",
      source: "fixture",
      kind: "upload",
      configurationFingerprint: "config-v1",
      base: "https://brain.invalid",
      adminKey: "admin-fixture",
      runId: "sync_fixture",
      now: () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++)),
      resolveAccess: async () => ({ accessToken: "access", connection: {} }),
      loadState: async () => ({ cursor: { page: "opaque-old" }, configuration_fingerprint: "config-v1" }),
      saveState: async (state) => { states.push(state); },
      sync: async ({ cursor }) => { calls.syncCursor = cursor; return completeResult(); },
      sendBatch: async ({ docs }) => ({
        res: { ok: true },
        raw: JSON.stringify({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "unchanged" })) }),
      }),
      removeDocuments: async ({ uids }) => { calls.deletions.push(...uids); return { applied: uids.length, pending: 0 }; },
      listStoredFamilies: async () => ++familyRead === 1 ? new Set(["fixture:gone"]) : new Set(),
      postReceipt: async (_base, _key, receipt) => { receipts.push(receipt); return receipt; },
      approvedSnapshotFingerprint: providerSnapshotRemovalFingerprint("fixture", ["fixture:gone"]),
      ...overrides,
    },
  };
}

{
  let batchesSent = 0;
  const h = harness({
    approvedSnapshotFingerprint: null,
    listStoredFamilies: async () => new Set(["fixture:gone"]),
    sendBatch: async () => { batchesSent++; throw new Error("review gate must run before document delivery"); },
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a provider tombstone set crossing the aggregate ratio gate needs exact approval before any document write",
    error?.code === "provider_removal_review_required" && /--approve-removals [0-9a-f]{64}/.test(error.message) &&
    batchesSent === 0 && h.receipts.map((receipt) => receipt.status).join(",") === "indexing,error");
}

{
  const snapshot = completeResult();
  snapshot.authoritative_snapshot = true;
  snapshot.snapshot_source_ids = ["one"];
  snapshot.deletions = [];
  let familyRead = 0;
  const h = harness({
    sync: async () => snapshot,
    listStoredFamilies: async () => ++familyRead === 1
      ? new Set(["fixture:one", "fixture:stale"])
      : new Set(["fixture:one"]),
    approvedSnapshotFingerprint: providerSnapshotRemovalFingerprint("fixture", ["fixture:stale"]),
  });
  const result = await runProviderConnector(h.options);
  check("an authoritative baseline reconciles stored families absent from the complete inventory",
    result.snapshot_reconciled === true && h.calls.deletions.join(",") === "fixture:stale");
}

{
  const h = harness({ listStoredFamilies: async () => new Set(["fixture:gone"]) });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a success-shaped delete receipt cannot advance a cursor when exact family readback still finds the document",
    error?.code === "provider_deletion_not_confirmed" && h.states.length === 0 && h.receipts.at(-1).status === "error");
}

{
  const h = harness({ reset: true });
  await runProviderConnector(h.options);
  check("an explicit reset ignores a saved opaque cursor", h.calls.syncCursor === null);
}

{
  const h = harness();
  const result = await runProviderConnector(h.options);
  check("provider delivery reuses the saved opaque cursor", h.calls.syncCursor.page === "opaque-old");
  check("stable unchanged documents count as accepted idempotent retries",
    result.tally.unchanged === 1 && result.tally.failed === 0);
  check("exact provider tombstones are scoped to the selected source",
    h.calls.deletions.join(",") === "fixture:gone");
  check("the terminal cursor commits only after document and deletion receipts",
    h.states.length === 1 && h.states[0].cursor.page === "opaque-next" && result.cursor_advanced === true);
  check("common source receipts close indexing as ready with proof fields",
    h.receipts.map((receipt) => receipt.status).join(",") === "indexing,ready" &&
    h.receipts[1].outcome_kind === "completed" && h.receipts[1].deletion_authority === "authoritative");
}

{
  const partial = completeResult();
  partial.deletion_authority = "unavailable";
  partial.warnings = ["hard deletion is not exposed"];
  partial.outcome = ingestionOutcome("partial", { reason: partial.warnings[0] });
  const h = harness({ sync: async () => partial });
  const result = await runProviderConnector(h.options);
  check("a partial provider window preserves accepted documents but never posts healthy source state",
    result.outcome.kind === "partial" && result.tally.unchanged === 1 &&
    h.receipts.at(-1).status === "error" && h.receipts.at(-1).walk_complete === false &&
    h.receipts.at(-1).outcome_kind === "partial");
  check("an explicit partial outcome overrides an inconsistent adapter cursor flag",
    partial.cursor_can_advance === true && partial.proposed_cursor.page === "opaque-next" &&
    h.states.length === 0 && result.cursor_advanced === false);
}

{
  const h = harness({
    loadState: async () => ({ cursor: { page: "stale" }, configuration_fingerprint: "config-v0" }),
  });
  await runProviderConnector(h.options);
  check("a provider selection change discards its stale cursor before reading", h.calls.syncCursor === null);
}

{
  const h = harness({
    sendBatch: async ({ docs }) => ({
      res: { ok: true },
      raw: JSON.stringify({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "failed" })) }),
    }),
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a failed document makes the run fail and withholds the cursor",
    error instanceof ProviderDeliveryError && h.states.length === 0);
  check("a delivery failure closes the source as error, never ready",
    h.receipts.map((receipt) => receipt.status).join(",") === "indexing,error");
}

{
  const h = harness({
    removeDocuments: async () => ({ applied: 0, pending: 1 }),
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("an unconfirmed provider deletion fails the run and withholds the cursor",
    error?.code === "provider_delivery_incomplete" && h.states.length === 0 && h.receipts.at(-1).status === "error");
}

{
  const h = harness({
    sendBatch: async ({ docs }) => ({
      res: { ok: true },
      raw: JSON.stringify({ results: docs.slice(1).map((doc) => ({ source_id: doc.source_id, status: "created" })) }),
    }),
  });
  let error;
  try { await runProviderConnector(h.options); } catch (caught) { error = caught; }
  check("a truncated success-shaped receipt is refused",
    error?.code === "invalid_ingest_receipt" && h.receipts.at(-1).status === "error");
}

console.log(`\nprovider runtime: all ${ran} checks passed`);
