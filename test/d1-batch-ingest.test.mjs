import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../brain.mjs";
import worker from "../worker/src/index.js";
import { storeFor } from "../worker/src/lib/store.js";
import { replaceDocumentChunks, upsertChunks } from "../worker/src/lib/store-d1.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "..", "migrations", "d1");
const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
  for (const sql of splitStatements(readFileSync(join(migrationDir, file), "utf8"))) sqlite.exec(sql);
}
sqlite.prepare(
  `INSERT INTO install_state
     (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
   VALUES (1, 'fixture', '0.0.0', 11, 0, '2026-01-01T00:00:00Z', 'test')`
).run();

const metrics = {
  remote_calls: 0,
  submitted_statements: 0,
  stats_scans: 0,
  max_batch_statements: 0,
  max_statement_binds: 0,
};
const control = {
  fail_chunk_doc_uid: null,
  fail_finalize_cas_doc_uid: null,
  before_finalize_batch: null,
};

function execute(sql, params, mode) {
  metrics.submitted_statements++;
  if (/INSERT INTO corpus_stats/.test(sql)) metrics.stats_scans++;
  const statement = sqlite.prepare(sql);
  if (mode === "all") return { results: statement.all(...params) };
  if (mode === "first") return statement.get(...params) ?? null;
  return statement.run(...params);
}

function prepared(sql, params = []) {
  return {
    sql,
    params,
    bind: (...next) => prepared(sql, next),
    all: async () => { metrics.remote_calls++; return execute(sql, params, "all"); },
    first: async () => { metrics.remote_calls++; return execute(sql, params, "first"); },
    run: async () => {
      metrics.remote_calls++;
      const result = execute(sql, params, "run");
      return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
    },
  };
}

const DB = {
  prepare: (sql) => prepared(sql),
  async batch(statements) {
    metrics.remote_calls++;
    metrics.max_batch_statements = Math.max(metrics.max_batch_statements, statements.length);
    metrics.max_statement_binds = Math.max(
      metrics.max_statement_binds,
      ...statements.map((statement) => statement.params.length)
    );
    if (control.fail_chunk_doc_uid && statements.some((statement) =>
      /INSERT INTO chunks/.test(statement.sql) && statement.params[1] === control.fail_chunk_doc_uid
    )) throw new Error("synthetic chunk write failure");
    if (control.before_finalize_batch && statements.some((statement) =>
      /UPDATE documents SET content_hash/.test(statement.sql)
    )) {
      const hook = control.before_finalize_batch;
      control.before_finalize_batch = null;
      hook(statements);
    }

    sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        if (control.fail_finalize_cas_doc_uid &&
            /UPDATE documents SET content_hash/.test(statement.sql) &&
            statement.params[0] === control.fail_finalize_cas_doc_uid) {
          throw new Error("synthetic final CAS failure");
        }
        const readOnly = /^\s*(SELECT|PRAGMA)\b/i.test(statement.sql) ||
          (/^\s*WITH\b/i.test(statement.sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(statement.sql));
        if (readOnly) {
          return { success: true, results: execute(statement.sql, statement.params, "all").results };
        }
        const result = execute(statement.sql, statement.params, "run");
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      });
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};

const env = {
  STORAGE: "d1",
  ADMIN_KEY: "synthetic-admin-key",
  DB,
  VECTORIZE: {},
};

const post = async (docs) => {
  const response = await worker.fetch(new Request("https://brain.invalid/api/admin/brain/ingest/batch", {
    method: "POST",
    headers: { "X-Admin-Key": env.ADMIN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ docs }),
  }), env, {});
  assert.equal(response.status, 200);
  return response.json();
};

const envelope = (sourceId, content = "Synthetic ordinary correspondence with no credential material.", sourceType = "message") => ({
  source_type: sourceType,
  source_id: sourceId,
  title: `Synthetic ${sourceId}`,
  content,
  metadata: { platform: "synthetic" },
});

// A maximum-size changed batch proves the real schema, FTS triggers, outbox,
// pending marker, source statistic, and D1 batch result shapes together.
const fifty = Array.from({ length: 50 }, (_, index) => envelope(`m-${index}`));
const first = await post(fifty);
assert.equal(first.created, 50);
assert.equal(first.failed, 0);
assert.equal(first.results.length, 50);
assert.equal(metrics.remote_calls, 53);
assert.equal(metrics.submitted_statements, 352);
assert.equal(metrics.stats_scans, 1);
assert.equal(metrics.max_batch_statements, 51);
assert.ok(metrics.max_statement_binds <= 100);
assert.deepEqual({ ...sqlite.prepare(
  `SELECT
     (SELECT COUNT(*) FROM documents) AS documents,
     (SELECT COUNT(*) FROM chunks) AS chunks,
     (SELECT COUNT(*) FROM vector_outbox) AS queued,
     (SELECT COUNT(*) FROM documents WHERE content_hash LIKE 'pending:%') AS pending`
).get() }, { documents: 50, chunks: 50, queued: 50, pending: 0 });
assert.deepEqual({ ...sqlite.prepare(
  "SELECT documents, chunks FROM corpus_stats WHERE source = 'message'"
).get() }, { documents: 50, chunks: 50 });

// A shorter atomic revision must convert retained chunk ids back to upserts
// while leaving every removed tail vector queued for deletion.
const longAtomic = envelope("atomic-shorter", "x".repeat(3_500));
const longAtomicReceipt = await post([longAtomic]);
assert.equal(longAtomicReceipt.created, 1);
assert.equal(longAtomicReceipt.results[0].chunks, 3);
const shortAtomicReceipt = await post([
  envelope("atomic-shorter", "Synthetic shorter replacement."),
]);
assert.equal(shortAtomicReceipt.updated, 1);
assert.equal(shortAtomicReceipt.results[0].chunks, 1);
assert.deepEqual(sqlite.prepare(
  `SELECT chunk_uid, op FROM vector_outbox
   WHERE chunk_uid LIKE 'message:atomic-shorter#%'
   ORDER BY chunk_uid`
).all().map((row) => ({ ...row })), [
  { chunk_uid: "message:atomic-shorter#0", op: "upsert" },
  { chunk_uid: "message:atomic-shorter#1", op: "delete" },
  { chunk_uid: "message:atomic-shorter#2", op: "delete" },
]);
assert.equal(sqlite.prepare(
  "SELECT COUNT(*) AS n FROM chunks WHERE doc_uid = 'message:atomic-shorter'"
).get().n, 1);

// The scale-critical rescan is one read-only D1 batch and no writes.
const beforeRetry = { ...metrics };
const retry = await post(fifty);
assert.equal(retry.unchanged, 50);
assert.equal(retry.failed, 0);
assert.equal(metrics.remote_calls - beforeRetry.remote_calls, 1);
assert.equal(metrics.stats_scans, beforeRetry.stats_scans);

// One preflight may classify all three actions, while changed documents still
// go through pending-hash finalization and exact readback.
const scansBeforeMix = metrics.stats_scans;
const mixed = await post([
  fifty[0],
  envelope("m-1", "Synthetic changed correspondence that remains safe to index."),
  envelope("m-50"),
]);
assert.deepEqual(mixed.results.map((row) => row.status), ["unchanged", "updated", "created"]);
assert.equal(metrics.stats_scans - scansBeforeMix, 1);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM documents WHERE content_hash LIKE 'pending:%'").get().n, 0);

// A small-document chunk-stage failure rolls back that document's isolated D1
// transaction, yet does not stop its successful same-source neighbor. The next
// retry creates only the missing revision.
control.fail_chunk_doc_uid = "message:interrupted";
const interrupted = await post([envelope("neighbor"), envelope("interrupted")]);
assert.equal(interrupted.created, 1);
assert.equal(interrupted.failed, 1);
assert.equal(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get("message:interrupted"), undefined);
assert.match(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get("message:neighbor").content_hash, /^[a-f0-9]{64}$/);
control.fail_chunk_doc_uid = null;
const repaired = await post([envelope("neighbor"), envelope("interrupted")]);
assert.equal(repaired.unchanged, 1);
assert.equal(repaired.created, 1);
assert.equal(repaired.failed, 0);

// At 63 chunks, the full atomic stage would need 129 statements. The route
// therefore keeps the established resumable sequence and slices its derived
// writes into 100 and 26 statements. A failure leaves its unique pending
// marker, and retry commits that exact document.
const largeBody = "x".repeat(75_000);
control.fail_chunk_doc_uid = "message:large-interrupted";
const largeInterrupted = await post([envelope("large-interrupted", largeBody)]);
assert.equal(largeInterrupted.failed, 1);
assert.match(sqlite.prepare(
  "SELECT content_hash FROM documents WHERE doc_uid = ?"
).get("message:large-interrupted").content_hash, /^pending:/);
assert.ok(metrics.max_batch_statements <= 100);
control.fail_chunk_doc_uid = null;
const largeRepaired = await post([envelope("large-interrupted", largeBody)]);
assert.equal(largeRepaired.updated, 1);
assert.equal(largeRepaired.failed, 0);
assert.equal(sqlite.prepare(
  "SELECT COUNT(*) AS n FROM chunks WHERE doc_uid = ?"
).get("message:large-interrupted").n, 63);
assert.ok(metrics.max_batch_statements <= 100);

// Duplicate identities stay sequential, so the second revision is the durable
// one and each receipt preserves the original created-then-updated contract.
const scansBeforeDuplicate = metrics.stats_scans;
const duplicate = await post([
  envelope("duplicate", "Synthetic first revision."),
  envelope("duplicate", "Synthetic second revision."),
]);
assert.deepEqual(duplicate.results.map((row) => row.status), ["created", "updated"]);
assert.equal(metrics.stats_scans - scansBeforeDuplicate, 2);
assert.match(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = 'message:duplicate'").get().content_hash, /^[a-f0-9]{64}$/);
assert.match(sqlite.prepare("SELECT text FROM chunks WHERE doc_uid = 'message:duplicate'").get().text, /second revision/);

// Two requests can have identical content hashes while changing title and
// filter metadata. Stage both from the same prior snapshot, then prove in both
// finalizer orders that only the revision owning the current unique marker can
// report success. The stale finalizer must fail even after it reads the same
// final content hash written by the winner.
const store = storeFor(env);

// Malformed internal revision receipts fail closed before any D1 call. In
// particular, validation must never invoke String methods on attacker-shaped
// numeric or object values.
{
  const hash = "a".repeat(64);
  const revision = {
    source: "message",
    hash,
    pending_marker: `pending:${hash}:${"b".repeat(32)}`,
    ingested_at: 1,
  };
  const callsBefore = metrics.remote_calls;
  const invalid = await store.finalizeIngestBatch(env, [
    { ...revision, doc_uid: 42 },
    { ...revision, doc_uid: { value: "message:object" } },
    { ...revision, doc_uid: "" },
    revision,
  ]);
  assert.deepEqual(invalid.map((outcome) => outcome.ok), [false, false, false, false]);
  assert.equal(metrics.remote_calls, callsBefore);
}

const plainRow = (row) => row ? { ...row } : null;
const statsFor = (source) => plainRow(sqlite.prepare(
  "SELECT source, documents, chunks, last_ingest_at FROM corpus_stats WHERE source = ?"
).get(source));
const actualCountsFor = (source) => plainRow(sqlite.prepare(
  `SELECT COUNT(DISTINCT doc_uid) AS documents, COUNT(*) AS chunks
   FROM chunks WHERE source = ?`
).get(source));
const outboxFor = (docUid) => sqlite.prepare(
  `SELECT chunk_uid, vector_id, op, queued_at, attempts, last_error
   FROM vector_outbox WHERE chunk_uid LIKE ? ORDER BY chunk_uid`
).all(`${docUid}#%`).map((row) => ({ ...row }));
const assertStatsMatchRows = (source, expectedFreshness) => {
  const stats = statsFor(source);
  const actual = actualCountsFor(source);
  assert.equal(stats.documents, actual.documents);
  assert.equal(stats.chunks, actual.chunks);
  assert.equal(stats.last_ingest_at, expectedFreshness);
};
const assertOneUpsert = (docUid) => {
  const rows = outboxFor(docUid);
  assert.equal(rows.length, 1);
  const { queued_at, ...stable } = rows[0];
  assert.ok(Number.isSafeInteger(queued_at) && queued_at > 0);
  assert.deepEqual(stable, {
    chunk_uid: `${docUid}#0`,
    vector_id: `${docUid}#0`,
    op: "upsert",
    attempts: 0,
    last_error: null,
  });
};

// A statement failure after the marker-bound statistics statement must roll
// the whole D1 batch back. The revision stays pending and the exact same marker
// remains safe to retry.
{
  const staged = await store.ingest(env, envelope("atomic-retry"), { deferFinalize: true });
  const revision = staged.deferred_revision;
  revision.ingested_at = 5_000;
  sqlite.prepare("UPDATE corpus_stats SET last_ingest_at = ? WHERE source = 'message'").run(4_000);
  const beforeStats = statsFor("message");
  const beforeOutbox = outboxFor(revision.doc_uid);
  control.fail_finalize_cas_doc_uid = revision.doc_uid;
  const failed = await store.finalizeIngestBatch(env, [revision]);
  control.fail_finalize_cas_doc_uid = null;
  assert.equal(failed[0].ok, false);
  assert.deepEqual(statsFor("message"), beforeStats);
  assert.equal(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get(revision.doc_uid).content_hash,
    revision.pending_marker);
  assert.deepEqual(outboxFor(revision.doc_uid), beforeOutbox);

  const retried = await store.finalizeIngestBatch(env, [revision]);
  assert.equal(retried[0].ok, true);
  assertStatsMatchRows("message", 5_000);
  assert.deepEqual(outboxFor(revision.doc_uid), beforeOutbox);
}

async function stageMetadataRace(sourceId) {
  const content = "Synthetic shared content whose metadata revisions differ.";
  const alpha = {
    ...envelope(sourceId, content),
    title: "Synthetic alpha title",
    metadata: { category: "alpha", platform: "synthetic" },
  };
  const beta = {
    ...envelope(sourceId, content),
    title: "Synthetic beta title",
    metadata: { category: "beta", platform: "synthetic" },
  };
  const [alphaPreflight] = await store.preflightIngestBatch(env, [alpha]);
  const [betaPreflight] = await store.preflightIngestBatch(env, [beta]);
  const alphaStaged = await store.ingest(env, alpha, { deferFinalize: true, prepared: alphaPreflight.prepared });
  const betaStaged = await store.ingest(env, beta, { deferFinalize: true, prepared: betaPreflight.prepared });
  assert.equal(alphaStaged.deferred_revision.hash, betaStaged.deferred_revision.hash);
  assert.notEqual(alphaStaged.deferred_revision.pending_marker, betaStaged.deferred_revision.pending_marker);

  // A stale request may still reach its delete/upsert steps after the newer
  // request has taken marker ownership. Those writes must be conditional too,
  // or the eventual CAS winner could commit someone else's chunks.
  const docUid = `message:${sourceId}`;
  await replaceDocumentChunks(env, docUid, {
    expectedContentHash: alphaStaged.deferred_revision.pending_marker,
  });
  await upsertChunks(env, [{
    chunk_uid: `${docUid}#0`,
    doc_uid: docUid,
    chunk_ix: 0,
    text: "[Synthetic alpha title]\n\nSynthetic stale write.",
    source: "message",
    title: "Synthetic alpha title",
    category: "alpha",
    platform: "synthetic",
  }], { expectedContentHash: alphaStaged.deferred_revision.pending_marker });
  const guarded = sqlite.prepare("SELECT title, category FROM chunks WHERE doc_uid = ?").get(docUid);
  assert.equal(guarded.title, "Synthetic beta title");
  assert.equal(guarded.category, "beta");
  assertOneUpsert(docUid);
  return {
    docUid,
    alpha: alphaStaged.deferred_revision,
    beta: betaStaged.deferred_revision,
  };
}

// All-stale finalization is a true no-op. In particular it cannot refresh the
// counts to include the staged document or advance freshness with its supplied
// timestamp. The later exact-marker winner atomically refreshes both.
{
  const race = await stageMetadataRace("race-stale-first");
  sqlite.prepare("UPDATE corpus_stats SET last_ingest_at = ? WHERE source = 'message'").run(10_000);
  race.alpha.ingested_at = 90_000;
  race.beta.ingested_at = 20_000;
  const beforeStaleStats = statsFor("message");
  const beforeStaleOutbox = outboxFor(race.docUid);
  const stale = await store.finalizeIngestBatch(env, [race.alpha]);
  assert.deepEqual(statsFor("message"), beforeStaleStats);
  assert.deepEqual(outboxFor(race.docUid), beforeStaleOutbox);
  const winner = await store.finalizeIngestBatch(env, [race.beta]);
  assert.equal(stale[0].ok, false);
  assert.equal(winner[0].ok, true);
  assertStatsMatchRows("message", 20_000);
  assert.deepEqual(outboxFor(race.docUid), beforeStaleOutbox);
}

// Winner-first/stale-second proves a matching final hash is not success and a
// stale later timestamp cannot advance already truthful source freshness.
{
  const race = await stageMetadataRace("race-winner-first");
  sqlite.prepare("UPDATE corpus_stats SET last_ingest_at = ? WHERE source = 'message'").run(30_000);
  race.alpha.ingested_at = 99_000;
  race.beta.ingested_at = 40_000;
  const expectedOutbox = outboxFor(race.docUid);
  const winner = await store.finalizeIngestBatch(env, [race.beta]);
  assertStatsMatchRows("message", 40_000);
  const afterWinnerStats = statsFor("message");
  const stale = await store.finalizeIngestBatch(env, [race.alpha]);
  assert.equal(winner[0].ok, true);
  assert.equal(stale[0].ok, false);
  assert.deepEqual(statsFor("message"), afterWinnerStats);
  assert.deepEqual(outboxFor(race.docUid), expectedOutbox);
}

// One source transaction may contain both a stale revision and its exact-marker
// winner. Only the winner contributes its timestamp, while each receipt keeps
// its own CAS result.
{
  const race = await stageMetadataRace("race-mixed");
  sqlite.prepare("UPDATE corpus_stats SET last_ingest_at = ? WHERE source = 'message'").run(50_000);
  race.alpha.ingested_at = 999_000;
  race.beta.ingested_at = 60_000;
  const expectedOutbox = outboxFor(race.docUid);
  const outcomes = await store.finalizeIngestBatch(env, [race.alpha, race.beta]);
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [false, true]);
  assertStatsMatchRows("message", 60_000);
  assert.deepEqual(outboxFor(race.docUid), expectedOutbox);
}

for (const sourceId of ["race-stale-first", "race-winner-first", "race-mixed"]) {
  const docUid = `message:${sourceId}`;
  const document = sqlite.prepare(
    "SELECT title, category, content_hash FROM documents WHERE doc_uid = ?"
  ).get(docUid);
  const chunk = sqlite.prepare(
    "SELECT title, category, text FROM chunks WHERE doc_uid = ?"
  ).get(docUid);
  assert.equal(document.title, "Synthetic beta title");
  assert.equal(document.category, "beta");
  assert.match(document.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(chunk.title, "Synthetic beta title");
  assert.equal(chunk.category, "beta");
  assert.match(chunk.text, /^\[Synthetic beta title\]/);
  assertOneUpsert(docUid);
}

// The ordinary one-document path uses the same atomic marker-bound finalizer.
// Simulate a concurrent same-content metadata revision taking ownership just
// before the final D1 batch. The superseded request must throw without changing
// corpus_stats, and its stale CAS must not disturb the winner's outbox state.
{
  const source = "upload";
  const sourceId = "single-superseded";
  const docUid = `${source}:${sourceId}`;
  const content = "Synthetic shared single-ingest content.";
  const base = {
    ...envelope(sourceId, content, source),
    title: "Synthetic base title",
    metadata: { category: "base", platform: "synthetic" },
  };
  const callsBeforeBase = metrics.remote_calls;
  await store.ingest(env, base);
  assert.equal(metrics.remote_calls - callsBeforeBase, 6);
  sqlite.prepare("UPDATE corpus_stats SET last_ingest_at = ? WHERE source = ?").run(70_000, source);
  const beforeStats = statsFor(source);

  const alpha = {
    ...base,
    title: "Synthetic single alpha title",
    metadata: { category: "alpha", platform: "synthetic" },
  };
  const beta = {
    ...base,
    title: "Synthetic single beta title",
    metadata: { category: "beta", platform: "synthetic" },
  };
  let winnerMarker = null;
  control.before_finalize_batch = (statements) => {
    const cas = statements.find((statement) => /UPDATE documents SET content_hash/.test(statement.sql));
    assert.equal(cas.params[0], docUid);
    const winnerNonce = cas.params[2].endsWith("e".repeat(32)) ? "d".repeat(32) : "e".repeat(32);
    winnerMarker = `pending:${cas.params[1]}:${winnerNonce}`;
    sqlite.prepare(
      `UPDATE documents
       SET title = ?, category = ?, platform = ?, ingested_at = ?, content_hash = ?
       WHERE doc_uid = ?`
    ).run(beta.title, "beta", "synthetic", 80_000, winnerMarker, docUid);
    sqlite.prepare(
      `UPDATE chunks SET title = ?, category = ?, platform = ?, text = ?
       WHERE doc_uid = ?`
    ).run(beta.title, "beta", "synthetic", `[${beta.title}]\n\n${content}`, docUid);
    sqlite.prepare(
      `UPDATE vector_outbox
       SET op = 'upsert', queued_at = ?, attempts = 0, last_error = NULL
       WHERE chunk_uid = ?`
    ).run(80_000, `${docUid}#0`);
  };

  await assert.rejects(
    store.ingest(env, alpha),
    /superseded before commit/
  );
  assert.deepEqual(statsFor(source), beforeStats);
  assert.equal(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get(docUid).content_hash, winnerMarker);
  assert.deepEqual(plainRow(sqlite.prepare(
    "SELECT title, category, platform FROM chunks WHERE doc_uid = ?"
  ).get(docUid)), {
    title: beta.title,
    category: "beta",
    platform: "synthetic",
  });
  assert.deepEqual(outboxFor(docUid), [{
    chunk_uid: `${docUid}#0`,
    vector_id: `${docUid}#0`,
    op: "upsert",
    queued_at: 80_000,
    attempts: 0,
    last_error: null,
  }]);

  const repairedSingle = await store.ingest(env, beta);
  assert.equal(repairedSingle.action, "updated");
  const repairedStats = statsFor(source);
  assert.ok(repairedStats.last_ingest_at > 70_000);
  assertStatsMatchRows(source, repairedStats.last_ingest_at);
  assert.match(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get(docUid).content_hash, /^[a-f0-9]{64}$/);
  assertOneUpsert(docUid);
}

console.log("d1-batch-ingest: real SQLite integration and performance structure passed");
