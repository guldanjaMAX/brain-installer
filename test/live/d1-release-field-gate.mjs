/**
 * Disposable real-Cloudflare release gate.
 *
 * This is intentionally outside `npm test`: it creates billable resources and
 * must be run only against a new synthetic field-gate manifest. The caller
 * provisions the isolated Brain, runs this file, preserves its aggregate JSON
 * receipt, and removes the Worker, D1, Vectorize index, and temporary Keychain
 * item. No private corpus, identifier, question, answer, or credential is
 * printed or accepted by the harness.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [manifestPath, installerRoot] = process.argv.slice(2);
if (!manifestPath || !installerRoot) {
  throw new Error("usage: node test/live/d1-release-field-gate.mjs <synthetic-manifest> <installer-root>");
}

const { resolveAdminKey } = await import(pathToFileURL(`${installerRoot}/brain.mjs`).href);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expectedVersion = String(manifest.brain?.version || "");
const workerName = String(manifest.brain?.worker_name || "");
const source = "release_field_gate";

assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
assert.match(String(manifest.client?.slug || ""), /field/i, "refusing a manifest not named as a field gate");
assert.match(String(manifest.client?.display_name || ""), /synthetic field gate/i);
assert.match(workerName, /field/i);
assert.match(String(manifest.brain?.domain || ""), /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/);
assert.notEqual(manifest.corpora?.google_drive?.enabled, true);
assert.notEqual(manifest.corpora?.gmail?.enabled, true);

const adminKey = resolveAdminKey(manifestPath, { ignoreEnvironment: true });
assert.match(String(adminKey || ""), /^[a-f0-9]{48}$/);
const base = `https://${manifest.brain.domain}`;

async function request(path, { method = "GET", body, allowError = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Admin-Key": adminKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok && !allowError) {
    throw new Error(`${path} returned HTTP ${response.status}: ${String(parsed?.error || "unknown").slice(0, 160)}`);
  }
  return { body: parsed, headers: response.headers, status: response.status };
}

const envelope = (sourceId, content, title = `Synthetic ${sourceId}`, category = "batch") => ({
  source_type: source,
  source_id: sourceId,
  title,
  content,
  metadata: { platform: "synthetic", category },
});

async function ingest(docs) {
  const started = performance.now();
  const response = await request("/api/admin/brain/ingest/batch", {
    method: "POST",
    body: { docs },
  });
  return { ...response.body, elapsed_ms: Math.round(performance.now() - started) };
}

// Vectorize V2 acknowledges a mutation before it becomes query-visible. Match
// the shipped `brain drain` cadence instead of spending a fixed number of
// immediate requests while every accepted row is still waiting on the same
// provider mutation.
async function drainUntilEmpty({ maxRounds = 120, delayMs = 3_000 } = {}) {
  let drained = 0;
  let submitted = 0;
  let remaining = null;
  let waitingObserved = false;
  for (let round = 1; round <= maxRounds; round++) {
    const receipt = await request("/api/admin/brain/drain", { method: "POST", body: {} });
    drained += Number(receipt.body.drained || 0);
    submitted += Number(receipt.body.submitted || 0);
    remaining = Number(receipt.body.remaining || 0);
    const waiting = Number(receipt.body.waiting || 0);
    waitingObserved ||= waiting > 0;
    if (remaining === 0) return { drained, submitted, remaining, rounds: round, waiting_observed: waitingObserved };
    if (round < maxRounds) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  assert.equal(remaining, 0, `vector drain still had ${remaining} operation(s) after ${maxRounds} bounded rounds`);
}

const health = await request("/health");
assert.equal(health.body.version, expectedVersion);

// Make the synthetic gate repeatable after a harness assertion or network
// interruption. The manifest checks above prevent this cleanup from running
// against an ordinary client Brain.
const prior = await request("/api/admin/brain/source-families", {
  method: "POST", body: { source, limit: 1000 },
});
if (prior.body.families.length) {
  await request("/api/admin/brain/forget", {
    method: "POST",
    body: { source, confirm: true },
  });
  await drainUntilEmpty();
}

// Exercise the deployed scanner through the single-document HTTP boundary.
// Keep the secret-shaped value synthetic and out of both output and receipts.
const syntheticAdminKey = `a${"3".repeat(63)}`;
assert.equal(syntheticAdminKey.length, 64);
const refusedSecret = await request("/api/admin/brain/ingest", {
  method: "POST",
  body: envelope("scanner-refusal", `admin_key: ${syntheticAdminKey}`, "Synthetic scanner refusal", "privacy"),
  allowError: true,
});
assert.equal(refusedSecret.status, 422);
assert.deepEqual(refusedSecret.body, {
  error: "refused: content carries sensitive credential(s) or private identifier(s)",
  labels: ["env_assignment"],
  detail: "Remove or redact them, rotate any live credentials, then re-ingest. Nothing was written.",
});
assert.equal(JSON.stringify(refusedSecret.body).includes(syntheticAdminKey), false);
const afterSecretRefusal = await request("/api/admin/brain/documents");
assert.equal(
  afterSecretRefusal.body.rows.some((entry) => entry.source_type === source && Number(entry.documents) > 0),
  false,
  "the rejected synthetic credential created a document",
);

const fifty = Array.from({ length: 50 }, (_, index) => envelope(
  `batch-${String(index).padStart(2, "0")}`,
  `Synthetic field record ${index}. Orchid harbor ledger ${index}. This record contains no credential material.`,
));

const first = await ingest(fifty);
assert.equal(first.created, 50);
assert.equal(first.failed, 0);
assert.equal(first.results.length, 50);

const unchanged = await ingest(fifty);
assert.equal(unchanged.unchanged, 50);
assert.equal(unchanged.failed, 0);

const mixed = await ingest([
  fifty[0],
  envelope("batch-01", "Synthetic changed field record. Orchid harbor ledger changed safely."),
  envelope("batch-50", "Synthetic new field record. Orchid harbor ledger fifty."),
]);
assert.deepEqual(mixed.results.map((row) => row.status), ["unchanged", "updated", "created"]);

const raceContent = "Synthetic concurrency evidence. Cobalt lantern ownership marker.";
const races = await Promise.all([
  ingest([envelope("race", raceContent, "Synthetic race alpha", "alpha")]),
  ingest([envelope("race", raceContent, "Synthetic race beta", "beta")]),
]);
assert.equal(races.every((receipt) => receipt.results?.length === 1), true);
assert.equal(races.some((receipt) => receipt.failed === 0), true);

const repaired = await ingest([
  envelope("race", raceContent, "Synthetic race gamma zephyr", "gamma"),
]);
assert.equal(repaired.failed, 0);
assert.match(repaired.results[0]?.status || "", /^(updated|unchanged)$/);

const paragraphs = Array.from({ length: 850 }, (_, index) =>
  `Synthetic long-form paragraph ${index}. Juniper observatory token ${index}. The field gate varies every paragraph to exercise bounded chunk writes.`,
).join("\n\n");
const large = await ingest([envelope("large", paragraphs, "Synthetic high chunk document", "scale")]);
assert.equal(large.failed, 0);
assert.ok(Number(large.results[0]?.chunks) >= 60);

const families = await request("/api/admin/brain/source-families", {
  method: "POST", body: { source, limit: 1000 },
});
assert.equal(families.body.families.length, 53);
assert.equal(families.body.next_cursor, null);

const inventory = await request("/api/admin/brain/documents");
const row = inventory.body.rows.find((entry) => entry.source_type === source);
assert.equal(row.documents, 53);
assert.ok(row.chunks >= 112);
assert.ok(Number(inventory.body.vector_backlog?.pending || 0) >= 1);

const vectorDrain = await drainUntilEmpty();

const search = await request("/api/rag/unified", {
  method: "POST",
  body: { q: "gamma zephyr", source, limit: 10, rerank: 0 },
});
assert.match(search.headers.get("cache-control") || "", /no-store/);
assert.equal(search.body.results.some((entry) => entry.title === "Synthetic race gamma zephyr"), true);

const diagnosis = await request("/api/admin/brain/diagnose");
const critical = (diagnosis.body.issues || []).filter((issue) => issue.severity === "crit");
assert.equal(critical.length, 0, JSON.stringify(critical.map((issue) => issue.id)));

const preview = await request("/api/admin/brain/forget", {
  method: "POST",
  body: { source },
});
assert.equal(preview.body.dry_run, true);
assert.equal(preview.body.documents, 53);

const removed = await request("/api/admin/brain/forget", {
  method: "POST",
  body: { source, confirm: true },
});
assert.equal(removed.body.documents, 53);

const deleteDrain = await drainUntilEmpty();

const after = await request("/api/admin/brain/source-families", {
  method: "POST", body: { source, limit: 1000 },
});
assert.deepEqual(after.body.families, []);

console.log(JSON.stringify({
  status: "passed",
  worker_version: health.body.version,
  changed_batch_ms: first.elapsed_ms,
  unchanged_batch_ms: unchanged.elapsed_ms,
  mixed_batch_ms: mixed.elapsed_ms,
  concurrent_receipts: races.map((receipt) => receipt.results[0]?.status || "failed"),
  large_document_chunks: large.results[0].chunks,
  embedded_operations: vectorDrain.drained,
  embedding_submissions: vectorDrain.submitted,
  embedding_drain_rounds: vectorDrain.rounds,
  asynchronous_wait_observed: vectorDrain.waiting_observed,
  secret_scanner_http_refusal: true,
  verified_documents: 53,
  cleanup_documents: removed.body.documents,
  deletion_drain_rounds: deleteDrain.rounds,
  final_vector_backlog: deleteDrain.remaining,
}, null, 2));
