import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../brain.mjs";
import worker from "../worker/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "..", "migrations", "d1");
const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
  for (const sql of splitStatements(readFileSync(join(migrationDir, file), "utf8"))) sqlite.exec(sql);
}

const metrics = { remote_calls: 0, stats_scans: 0 };
const control = { fail_chunk_doc_uid: null };

function execute(sql, params, mode) {
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
    run: async () => { metrics.remote_calls++; return execute(sql, params, "run"); },
  };
}

const DB = {
  prepare: (sql) => prepared(sql),
  async batch(statements) {
    metrics.remote_calls++;
    if (control.fail_chunk_doc_uid && statements.some((statement) =>
      /INSERT INTO chunks/.test(statement.sql) && statement.params[1] === control.fail_chunk_doc_uid
    )) throw new Error("synthetic chunk write failure");

    sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement.sql)) {
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
assert.equal(metrics.remote_calls, 203);
assert.equal(metrics.stats_scans, 1);
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

// A chunk-stage failure leaves that revision pending, yet does not stop its
// successful same-source neighbor from committing. The next retry repairs it.
control.fail_chunk_doc_uid = "message:interrupted";
const interrupted = await post([envelope("neighbor"), envelope("interrupted")]);
assert.equal(interrupted.created, 1);
assert.equal(interrupted.failed, 1);
assert.match(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get("message:interrupted").content_hash, /^pending:/);
assert.match(sqlite.prepare("SELECT content_hash FROM documents WHERE doc_uid = ?").get("message:neighbor").content_hash, /^[a-f0-9]{64}$/);
control.fail_chunk_doc_uid = null;
const repaired = await post([envelope("neighbor"), envelope("interrupted")]);
assert.equal(repaired.unchanged, 1);
assert.equal(repaired.updated, 1);
assert.equal(repaired.failed, 0);

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

console.log("d1-batch-ingest: real SQLite integration and performance structure passed");
