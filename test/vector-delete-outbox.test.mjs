// Vector deletions use the same retryable outbox as upserts.
//
// This runs against real SQLite because the important property is the state
// transition across INSERT...SELECT, ON CONFLICT, chunk deletion and retry.
// Hand-written SQL mocks cannot prove that those statements compose.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireDrainLease,
  DRAIN_D1_QUERY_BUDGET,
  drainBatchQueryUpperBound,
  releaseDrainLease,
  renewDrainLease,
  replaceDocumentChunks,
  upsertChunks,
  drainOutbox,
  forget,
  forgetFamilies,
  vectorReadiness,
} from "../worker/src/lib/store-d1.js";
import { storeFor } from "../worker/src/lib/store.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

function makeEnv({
  autoProcessVectorMutations = true,
  deleteThrows = false,
  enforceD1PatternLimit = false,
} = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();

  const deleted = [];
  const upserted = [];
  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  const pendingVectorMutations = [];
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    if (autoProcessVectorMutations) {
      apply();
      processedUpToMutation = mutationId;
    } else {
      pendingVectorMutations.push({ mutationId, apply });
    }
    return { mutationId };
  };
  const d1Queries = { submitted: 0 };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => {
        d1Queries.submitted++;
        if (enforceD1PatternLimit && /\b(?:LIKE|GLOB)\b/i.test(sql) &&
            params.some((value) => new TextEncoder().encode(String(value)).length > 50)) {
          throw new Error("LIKE or GLOB pattern too complex");
        }
        return { results: db.prepare(sql).all(...params) };
      },
      first: async () => {
        d1Queries.submitted++;
        return db.prepare(sql).get(...params) ?? null;
      },
      run: async () => {
        d1Queries.submitted++;
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      },
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    _db: db,
    _acceptVectorMutation: accept,
    _visibleVectors: visible,
    _processNextVectorMutation: () => {
      const mutation = pendingVectorMutations.shift();
      if (!mutation) return null;
      mutation.apply();
      processedUpToMutation = mutation.mutationId;
      return mutation.mutationId;
    },
    _pendingVectorMutations: pendingVectorMutations,
    DB: {
      prepare,
      batch: async (statements) => {
        d1Queries.submitted += statements.length;
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => {
            const result = db.prepare(statement._sql).run(...statement._params);
            return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
          });
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => {
        upserted.push(...vectors);
        for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
      }),
      deleteByIds: async (ids) => {
        if (deleteThrows) throw new Error("Vectorize temporarily unavailable");
        return accept(() => {
          deleted.push(...ids);
          for (const id of ids) visible.delete(id);
        });
      },
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({
        vectorCount: visible.size,
        processedUpToMutation,
      }),
    },
  };
  return { env, db, deleted, upserted, visible, d1Queries };
}

const insertDocument = (db, uid, source = "drive") => db.prepare(
  `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(uid, source, uid, uid, Date.now(), `hash:${uid}`);

const insertChunk = (db, uid, doc, ix, vectorId = uid) => db.prepare(
  `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
   VALUES (?, ?, ?, ?, 'drive', ?)`
).run(uid, doc, ix, `old text ${ix}`, vectorId);

async function drainFully(env, options = {}, maxRounds = 20) {
  const total = { drained: 0, deleted: 0, upserted: 0, submitted: 0, failed: 0, remaining: null };
  for (let round = 0; round < maxRounds; round++) {
    const part = await drainOutbox(env, { maxBatches: 10, ...options });
    for (const field of ["drained", "deleted", "upserted", "submitted", "failed"]) {
      total[field] += Number(part[field] || 0);
    }
    total.remaining = part.remaining;
    if (part.remaining === 0) return total;
  }
  throw new Error(`fixture drain did not settle: ${JSON.stringify(total)}`);
}

/* Vectorize accepts writes asynchronously. An accepted receipt is not proof
   that a query can see the vector, so the row stays durable through a second
   confirmation phase. */
{
  const { env, db } = makeEnv({ autoProcessVectorMutations: false });
  insertDocument(db, "drive:async-upsert");
  insertChunk(db, "drive:async-upsert#0", "drive:async-upsert", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:async-upsert#0', 'drive:async-upsert#0', 'upsert', 100)`
  ).run();

  const accepted = await drainOutbox(env, { embed: async () => [0.1] });
  const acceptedRow = db.prepare(
    `SELECT submitted_mutation_id receipt, submitted_at
       FROM vector_outbox WHERE chunk_uid = 'drive:async-upsert#0'`
  ).get();
  const processing = await vectorReadiness(env);
  check("an accepted async upsert is not reported as drained before visibility",
    accepted.submitted === 1 && accepted.drained === 0 && accepted.waiting === 1 &&
      accepted.remaining === 1 && typeof acceptedRow?.receipt === "string",
    JSON.stringify({ accepted, acceptedRow }));
  check("readiness fails closed while the accepted upsert is not query-visible",
    processing.ready === false && processing.reason === "accepted_mutation_processing" &&
      processing.expected_vectors === 1 && processing.actual_vectors === 0 &&
      /brain drain/.test(processing.action || ""),
    JSON.stringify(processing));

  env._processNextVectorMutation();
  const visibleButUnconfirmed = await vectorReadiness(env);
  check("provider visibility alone remains pending until exact-generation confirmation",
    visibleButUnconfirmed.ready === false &&
      visibleButUnconfirmed.reason === "accepted_mutation_needs_confirmation" &&
      visibleButUnconfirmed.actual_vectors === 1,
    JSON.stringify(visibleButUnconfirmed));
  const confirmed = await drainOutbox(env, { embed: async () => [9] });
  const ready = await vectorReadiness(env);
  check("eventual exact-generation visibility clears the receipt without re-embedding",
    confirmed.drained === 1 && confirmed.upserted === 1 && confirmed.submitted === 0 &&
      confirmed.remaining === 0 && env._pendingVectorMutations.length === 0 && ready.ready === true,
    JSON.stringify({ confirmed, ready }));
}

/* Legacy/bootstrap rows can carry a chunk_uid too long for Vectorize as their
   stale outbox.vector_id. The accepted hash is the visibility identity, while
   the stale delete identity remains untouched for delete semantics. */
{
  const { env, db, visible } = makeEnv({ autoProcessVectorMutations: false });
  const docUid = `drive:${"legacy-long-segment/".repeat(6)}document`;
  const chunkUid = `${docUid}#0`;
  insertDocument(db, docUid);
  insertChunk(db, chunkUid, docUid, 0, null);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES (?, ?, 'upsert', 101)`,
  ).run(chunkUid, chunkUid);

  const accepted = await drainOutbox(env, { embed: async () => [0.11] });
  const staged = db.prepare(
    `SELECT c.vector_id AS chunk_vector_id, o.vector_id AS outbox_vector_id,
            o.submitted_mutation_id AS mutation_id
       FROM chunks c JOIN vector_outbox o ON o.chunk_uid=c.chunk_uid
      WHERE c.chunk_uid=?`,
  ).get(chunkUid);
  env._processNextVectorMutation();
  const confirmed = await drainOutbox(env, { embed: async () => [9] });
  const providerIds = [...visible.keys()];
  check("a long legacy upsert confirms against its actual hashed provider id",
    accepted.submitted === 1 && staged.chunk_vector_id?.startsWith("h:") &&
      staged.outbox_vector_id === chunkUid && typeof staged.mutation_id === "string" &&
      confirmed.drained === 1 && confirmed.upserted === 1 && confirmed.remaining === 0 &&
      providerIds.length === 1 && providerIds[0] === staged.chunk_vector_id &&
      db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0,
    JSON.stringify({ accepted, staged, confirmed, providerIds }));
}

{
  const { env, db } = makeEnv({ autoProcessVectorMutations: false });
  const chunkUid = "drive:legacy-short-null#0";
  insertDocument(db, "drive:legacy-short-null");
  insertChunk(db, chunkUid, "drive:legacy-short-null", 0, null);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES (?, ?, 'upsert', 101)`,
  ).run(chunkUid, chunkUid);
  const accepted = await drainOutbox(env, { embed: async () => [0.111] });
  const mapped = db.prepare("SELECT vector_id FROM chunks WHERE chunk_uid=?").get(chunkUid)?.vector_id;
  env._processNextVectorMutation();
  const confirmed = await drainOutbox(env, { embed: async () => [9] });
  check("a legacy short upsert durably fills a null hydration id before receipt",
    accepted.submitted === 1 && mapped === chunkUid &&
      confirmed.drained === 1 && confirmed.remaining === 0,
    JSON.stringify({ accepted, mapped, confirmed }));
}

{
  const { env, db } = makeEnv();
  const docUid = `drive:${"remap-failure-segment/".repeat(6)}document`;
  const chunkUid = `${docUid}#0`;
  insertDocument(db, docUid);
  insertChunk(db, chunkUid, docUid, 0, chunkUid);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES (?, ?, 'upsert', 102)`,
  ).run(chunkUid, chunkUid);
  const batch = env.DB.batch.bind(env.DB);
  let failRemap = true;
  env.DB.batch = async (statements) => {
    if (failRemap && statements.some((statement) =>
      /UPDATE chunks SET vector_id/.test(statement._sql || ""))) {
      failRemap = false;
      throw new Error("synthetic durable remap failure");
    }
    return batch(statements);
  };
  let firstError = null;
  try {
    await drainOutbox(env, { embed: async () => [0.12] });
  } catch (error) { firstError = error; }
  const retryable = db.prepare(
    `SELECT o.submitted_mutation_id mutation_id, o.attempts, c.vector_id
       FROM vector_outbox o JOIN chunks c ON c.chunk_uid=o.chunk_uid
      WHERE o.chunk_uid=?`,
  ).get(chunkUid);
  const recovered = await drainFully(env, { embed: async () => [0.13] });
  check("a failed hashed-id remap stays queued and can never false-green",
    /durable remap failure/.test(firstError?.message || "") &&
      retryable.mutation_id === null && retryable.attempts === 1 &&
      retryable.vector_id === chunkUid && recovered.remaining === 0 &&
      db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0 &&
      db.prepare("SELECT vector_id FROM chunks WHERE chunk_uid=?").get(chunkUid).vector_id.startsWith("h:"),
    JSON.stringify({ message: firstError?.message, retryable, recovered }));
}

/* A processed receipt with an old same-id generation is not success. This is
   the deterministic reproduction of the false-green class: vectorCount can
   look right while semantic search still holds stale bytes. */
{
  const { env, db, visible } = makeEnv();
  insertDocument(db, "drive:wrong-generation");
  insertChunk(db, "drive:wrong-generation#0", "drive:wrong-generation", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:wrong-generation#0', 'drive:wrong-generation#0', 'upsert', 200)`
  ).run();
  const generation = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'drive:wrong-generation#0'"
  ).get().generation;
  env.VECTORIZE.upsert = async (vectors) => env._acceptVectorMutation(() => {
    for (const vector of vectors) {
      visible.set(vector.id, {
        ...structuredClone(vector),
        metadata: { ...vector.metadata, outbox_generation: String(generation - 1) },
      });
    }
  });

  const accepted = await drainOutbox(env, { embed: async () => [0.2] });
  const rejected = await drainOutbox(env, { embed: async () => [0.3] });
  const retained = db.prepare(
    `SELECT attempts, last_error, submitted_mutation_id
       FROM vector_outbox WHERE chunk_uid = 'drive:wrong-generation#0'`
  ).get();
  const readiness = await vectorReadiness(env);
  check("a processed old generation cannot acknowledge the current outbox row",
    accepted.submitted === 1 && rejected.drained === 0 && rejected.failed === 1 &&
      retained.attempts === 1 && retained.submitted_mutation_id === null &&
      /exact vector state was not query-visible/.test(retained.last_error || ""),
    JSON.stringify({ accepted, rejected, retained }));
  check("a permanently wrong vector fails with a useful repair action",
    readiness.ready === false && readiness.pending === 1 &&
      readiness.reason === "vector_work_queued" && /brain drain/.test(readiness.action || ""),
    JSON.stringify(readiness));
}

/* Equal provider count cannot bless a legacy same-id vector that never crossed
   the schema-12 generation protocol. The bounded bootstrap must replace it and
   only then move the durable projection state to verified. */
{
  const { env, db, visible } = makeEnv();
  insertDocument(db, "drive:legacy-stale");
  insertChunk(db, "drive:legacy-stale#0", "drive:legacy-stale", 0);
  visible.set("drive:legacy-stale#0", {
    id: "drive:legacy-stale#0",
    values: [9.9],
    metadata: { outbox_generation: "legacy" },
  });
  db.prepare(
    `UPDATE install_state
        SET vector_projection_status='bootstrap_required',
            vector_projection_bootstrap_epoch=1,
            vector_projection_bootstrap_cursor=NULL,
            vector_projection_bootstrap_high_water='drive:legacy-stale#0'
      WHERE id=1`,
  ).run();
  const before = await vectorReadiness(env);
  const drained = await drainOutbox(env, {
    embed: async () => [0.7],
    maxBatches: 10,
  });
  const after = await vectorReadiness(env);
  const state = db.prepare(
    `SELECT vector_projection_status status,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get();
  check("equal-count legacy same-id vectors stay red until bounded exact readback",
    before.ready === false && before.reason === "projection_bootstrap_required" &&
      before.expected_vectors === 1 && before.actual_vectors === 1 &&
      drained.submitted === 1 && drained.drained === 1 && drained.remaining === 0 &&
      after.ready === true && state.status === "verified" && state.cursor === state.high_water,
    JSON.stringify({ before, drained, after, state }));
}

/* Deletes are asynchronous too. Count parity cannot go green until the
   processed fence and physical absence are both observed. */
{
  const { env, db, visible } = makeEnv({ autoProcessVectorMutations: false });
  insertDocument(db, "drive:async-delete");
  insertChunk(db, "drive:async-delete#0", "drive:async-delete", 0, "async-delete-vector");
  visible.set("async-delete-vector", {
    id: "async-delete-vector", values: [0.4], metadata: { outbox_generation: "0" },
  });
  await replaceDocumentChunks(env, "drive:async-delete");
  const accepted = await drainOutbox(env, { embed: async () => [0.4] });
  const processing = await vectorReadiness(env);
  check("an accepted async delete remains queued while the old vector is visible",
    accepted.submitted === 1 && accepted.deleted === 0 && accepted.remaining === 1 &&
      processing.ready === false && processing.expected_vectors === 0 &&
      processing.actual_vectors === 1,
    JSON.stringify({ accepted, processing }));
  env._processNextVectorMutation();
  const confirmed = await drainOutbox(env, { embed: async () => [9] });
  const ready = await vectorReadiness(env);
  check("a processed delete clears only after exact absence is observable",
    confirmed.deleted === 1 && confirmed.remaining === 0 && ready.ready === true &&
      ready.expected_vectors === 0 && ready.actual_vectors === 0,
    JSON.stringify({ confirmed, ready }));
}

/* The public ingest facade carries filter metadata and shortens safely. */
{
  const { env, db, deleted } = makeEnv();
  env.STORAGE = "d1";
  const store = storeFor(env);
  const base = {
    source_type: "drive",
    source_id: "public-ingest",
    title: "Provider record",
    occurred_at: "2025-08-20T12:00:00Z",
    metadata: {
      client_name: "James", category: "medical",
      top_folder: "Provider Records", platform: "drive", migrated_from: "legacy-drive",
    },
  };

  const first = await store.ingest(env, { ...base, content: "first ".repeat(500) });
  check("public ingest creates a multi-chunk document", first.action === "created" && first.chunks > 1, JSON.stringify(first));
  const docRow = db.prepare("SELECT client, category, top_folder, platform FROM documents").get();
  const chunkRow = db.prepare("SELECT client, category, top_folder, platform FROM chunks LIMIT 1").get();
  check("document metadata carries the complete filter contract",
    docRow.client === "James" && docRow.category === "medical" &&
      docRow.top_folder === "Provider Records" && docRow.platform === "drive", JSON.stringify(docRow));
  check("chunk metadata is denormalized for exact hydration",
    chunkRow.client === "James" && chunkRow.category === "medical" &&
      chunkRow.top_folder === "Provider Records" && chunkRow.platform === "drive", JSON.stringify(chunkRow));

  await drainFully(env, { embed: async () => [0.1] });
  const second = await store.ingest(env, { ...base, content: "short replacement" });
  check("a shorter public re-ingest is reported as updated", second.action === "updated" && second.chunks === 1, JSON.stringify(second));
  const queuedDeletes = db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='delete'").get().n;
  check("the removed tail is queued for Vectorize deletion", queuedDeletes === first.chunks - 1, `queued=${queuedDeletes} first=${first.chunks}`);
  await drainFully(env, { embed: async () => [0.2] });
  check("drain physically removes every old tail vector", deleted.length === first.chunks - 1, JSON.stringify(deleted));

  const moved = await store.ingest(env, {
    ...base,
    content: "short replacement",
    metadata: { top_folder: "Current Records", platform: "drive" },
  });
  check("a folder-only change is an update rather than a content no-op", moved.action === "updated", JSON.stringify(moved));
  const movedDoc = db.prepare("SELECT client, category, top_folder, platform, meta FROM documents").get();
  const movedChunk = db.prepare("SELECT client, category, top_folder, platform FROM chunks LIMIT 1").get();
  check("partial connector metadata preserves richer migrated filters",
    movedDoc.client === "James" && movedDoc.category === "medical" && movedDoc.top_folder === "Current Records",
    JSON.stringify(movedDoc));
  check("the merged filters reach replacement chunks and vectors",
    movedChunk.client === "James" && movedChunk.category === "medical" && movedChunk.top_folder === "Current Records",
    JSON.stringify(movedChunk));
  check("unrelated migration provenance survives the metadata merge", JSON.parse(movedDoc.meta).migrated_from === "legacy-drive", movedDoc.meta);

  const rootMove = await store.ingest(env, {
    ...base,
    content: "short replacement",
    metadata: { top_folder: null, platform: "drive" },
  });
  check("moving a file to Drive root clears its stale folder filter",
    rootMove.action === "updated" && db.prepare("SELECT top_folder FROM documents").get().top_folder === null,
    JSON.stringify(rootMove));
}

/* Split-document reconciliation keeps the new shape and removes every old one. */
{
  const { env, db } = makeEnv();
  for (const uid of [
    "drive:file", "drive:file#part1of3", "drive:file#part2of3", "drive:file#part3of3",
    "drive:file#part1of2", "drive:file#part2of2", "drive:other",
  ]) {
    insertDocument(db, uid);
    insertChunk(db, `${uid}#0`, uid, 0);
  }
  const cleaned = await forgetFamilies(env, {
    families: [{
      base_doc_uid: "drive:file",
      keep_doc_uids: ["drive:file#part1of2", "drive:file#part2of2"],
    }],
    dryRun: false,
  });
  const left = db.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all().map((row) => row.doc_uid);
  check("split-family cleanup removes the prior base and obsolete part count", cleaned.documents === 4, JSON.stringify(cleaned));
  check("split-family cleanup keeps every new part and unrelated document",
    left.join(",") === "drive:file#part1of2,drive:file#part2of2,drive:other", JSON.stringify(left));

  const deleted = await forgetFamilies(env, {
    families: [{ base_doc_uid: "drive:file", keep_doc_uids: [] }], dryRun: false,
  });
  check("a source deletion removes the whole split family", deleted.documents === 2 && db.prepare("SELECT count(*) n FROM documents WHERE doc_uid LIKE 'drive:file%'").get().n === 0, JSON.stringify(deleted));
}

/* Family matching does not depend on D1's 50-byte LIKE/GLOB pattern limit. */
{
  const { env, db } = makeEnv({ enforceD1PatternLimit: true });
  const longBase = `drive:${"folder_%_\\\\quoted'segment/".repeat(3)}document`;
  const keep = `${longBase}#part1of2`;
  const stale = `${longBase}#part2of3`;
  const prefixCollision = `${longBase}-copy#part1of1`;
  const siblingCollision = `${longBase}2#part1of1`;
  check("family regression uses a base id longer than D1's pattern limit",
    new TextEncoder().encode(longBase).length > 50, String(new TextEncoder().encode(longBase).length));

  for (const uid of [longBase, keep, stale, prefixCollision, siblingCollision, "drive:unrelated"]) {
    insertDocument(db, uid);
    insertChunk(db, `${uid}#0`, uid, 0);
  }

  const cleaned = await forgetFamilies(env, {
    families: [{ base_doc_uid: longBase, keep_doc_uids: [keep] }],
    dryRun: false,
  });
  const left = db.prepare("SELECT doc_uid FROM documents ORDER BY doc_uid").all().map((row) => row.doc_uid);
  check("long special-character family ids clean without LIKE or GLOB",
    cleaned.documents === 2 && !left.includes(longBase) && !left.includes(stale), JSON.stringify(cleaned));
  check("family matching keeps the requested #part child", left.includes(keep), JSON.stringify(left));
  check("family matching cannot delete similarly prefixed ids",
    left.includes(prefixCollision) && left.includes(siblingCollision) && left.includes("drive:unrelated"), JSON.stringify(left));
}

/* A shorter document turns only its removed tail into a vector delete. */
{
  const { env, db, deleted, upserted } = makeEnv();
  insertDocument(db, "drive:doc");
  insertChunk(db, "drive:doc#0", "drive:doc", 0);
  insertChunk(db, "drive:doc#1", "drive:doc", 1);
  insertChunk(db, "drive:doc#2", "drive:doc", 2, "hashed-tail");

  await replaceDocumentChunks(env, "drive:doc");
  check("replacement removes the previous D1 chunks", db.prepare("SELECT count(*) n FROM chunks").get().n === 0);
  check("and queues all previous vector ids before losing them",
    db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='delete'").get().n === 3);

  await upsertChunks(env, [0, 1].map((i) => ({
    chunk_uid: `drive:doc#${i}`, doc_uid: "drive:doc", chunk_ix: i,
    text: `new text ${i}`, source: "drive",
  })));
  check("retained chunk ids become upserts", db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='upsert'").get().n === 2);
  check("only the removed tail remains a delete", db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='delete'").get().n === 1);

  const result = await drainFully(env, { embed: async () => [0.1] });
  check("the removed tail is deleted by its stored Vectorize id", deleted.length === 1 && deleted[0] === "hashed-tail", JSON.stringify(deleted));
  check("the current chunks are re-upserted", upserted.length === 2, String(upserted.length));
  check("both operation types are counted", result.deleted === 1 && result.upserted === 2 && result.drained === 3, JSON.stringify(result));
  check("the outbox is empty only after both stores acknowledge", db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0);
}

/* The durable lease has one winner, can be released only by that winner, and
   remains recoverable when an invocation disappears without a release. */
{
  const { env, db } = makeEnv();
  const now = 10_000;
  const [left, right] = await Promise.all([
    acquireDrainLease(env, { ownerToken: "simultaneous-left", now, ttlMs: 5_000 }),
    acquireDrainLease(env, { ownerToken: "simultaneous-right", now, ttlMs: 5_000 }),
  ]);
  const winners = [left, right].filter((result) => result.acquired);
  check("simultaneous drain lease acquisition has exactly one winner",
    winners.length === 1, JSON.stringify([left, right]));

  const winner = winners[0].ownerToken;
  const loser = winner === "simultaneous-left" ? "simultaneous-right" : "simultaneous-left";
  const wrongRelease = await releaseDrainLease(env, loser);
  const stillHeld = db.prepare(
    "SELECT vector_drain_lease_owner owner FROM install_state WHERE id = 1"
  ).get();
  check("a non-owner cannot release another drain's lease",
    wrongRelease === false && stillHeld.owner === winner);
  check("the matching owner releases with compare-and-swap",
    await releaseDrainLease(env, winner) === true &&
      db.prepare("SELECT vector_drain_lease_owner owner FROM install_state WHERE id = 1").get().owner === null);
}

{
  const { env, db } = makeEnv();
  const first = await acquireDrainLease(env, {
    ownerToken: "crashed-owner", now: 20_000, ttlMs: 5_000,
  });
  const beforeExpiry = await acquireDrainLease(env, {
    ownerToken: "replacement-owner", now: 24_999, ttlMs: 5_000,
  });
  // Simulate a terminated isolate by deliberately omitting the first release.
  const afterExpiry = await acquireDrainLease(env, {
    ownerToken: "replacement-owner", now: 25_000, ttlMs: 5_000,
  });
  check("a crashed owner remains exclusive until its bounded expiry",
    first.acquired && !beforeExpiry.acquired, JSON.stringify({ first, beforeExpiry }));
  check("a stale owner is atomically replaced at expiry",
    afterExpiry.acquired &&
      db.prepare("SELECT vector_drain_lease_owner owner FROM install_state WHERE id = 1").get().owner === "replacement-owner",
    JSON.stringify(afterExpiry));
  check("the expired owner cannot clear its replacement",
    await releaseDrainLease(env, "crashed-owner") === false &&
      await releaseDrainLease(env, "replacement-owner") === true);
}

{
  const { env, db } = makeEnv();
  const acquired = await acquireDrainLease(env, {
    ownerToken: "renewal-owner", now: 30_000, ttlMs: 5_000,
  });
  const renewed = await renewDrainLease(env, "renewal-owner", {
    now: 31_000, ttlMs: 5_000,
  });
  const afterRenewal = db.prepare(
    `SELECT vector_drain_lease_owner owner, vector_drain_lease_expires_at expires
       FROM install_state WHERE id=1`,
  ).get();
  db.prepare(
    `UPDATE install_state
        SET vector_drain_lease_owner='renewal-replacement',
            vector_drain_lease_expires_at=50_000
      WHERE id=1`,
  ).run();
  let staleRenewal = null;
  try {
    await renewDrainLease(env, "renewal-owner", { now: 32_000, ttlMs: 5_000 });
  } catch (error) { staleRenewal = error; }
  const afterReplacement = db.prepare(
    `SELECT vector_drain_lease_owner owner, vector_drain_lease_expires_at expires
       FROM install_state WHERE id=1`,
  ).get();
  check("lease renewal extends only the still-live matching owner",
    acquired.acquired && renewed.expiresAt === 36_000 &&
      afterRenewal.owner === "renewal-owner" && afterRenewal.expires === 36_000,
    JSON.stringify({ acquired, renewed, afterRenewal }));
  check("a stale renewal cannot overwrite its replacement owner or expiry",
    /ownership or expiry was lost/.test(staleRenewal?.message || "") &&
      afterReplacement.owner === "renewal-replacement" && afterReplacement.expires === 50_000,
    JSON.stringify({ message: staleRenewal?.message, afterReplacement }));
  await releaseDrainLease(env, "renewal-replacement");
}

/* Ownership can change after expensive embedding but before the provider
   mutation. The final renewal/CAS must stop the write and preserve the queue. */
{
  const { env, db } = makeEnv();
  insertDocument(db, "drive:renew-before-write");
  insertChunk(db, "drive:renew-before-write#0", "drive:renew-before-write", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:renew-before-write#0', 'drive:renew-before-write#0', 'upsert', 1)`,
  ).run();
  let providerWrites = 0;
  env.VECTORIZE.upsert = async () => {
    providerWrites++;
    return { mutationId: "must-not-be-accepted" };
  };
  let renewalRaceError = null;
  try {
    await drainOutbox(env, {
      now: () => 1_000,
      embed: async () => {
        db.prepare(
          `UPDATE install_state
              SET vector_drain_lease_owner='renew-before-write-replacement',
                  vector_drain_lease_expires_at=50_000
            WHERE id=1`,
        ).run();
        return [0.1];
      },
    });
  } catch (error) { renewalRaceError = error; }
  const queued = db.prepare(
    `SELECT attempts, last_error FROM vector_outbox
      WHERE chunk_uid='drive:renew-before-write#0'`,
  ).get();
  const owner = db.prepare(
    `SELECT vector_drain_lease_owner owner FROM install_state WHERE id=1`,
  ).get()?.owner;
  check("lost ownership immediately before upsert performs no provider write",
    /ownership or expiry was lost/.test(renewalRaceError?.message || "") &&
      providerWrites === 0 && queued?.attempts === 1 && owner === "renew-before-write-replacement",
    JSON.stringify({ message: renewalRaceError?.message, providerWrites, queued, owner }));
  await releaseDrainLease(env, "renew-before-write-replacement");
}

{
  const { env, db } = makeEnv();
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:renew-delete#0', 'drive:renew-delete#0', 'delete', 1)`,
  ).run();
  const prepare = env.DB.prepare.bind(env.DB);
  let swapped = false;
  env.DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!/SET vector_drain_lease_expires_at = \?3/.test(sql)) return statement;
    const wrap = (current) => ({
      bind: (...params) => wrap(current.bind(...params)),
      run: async () => {
        if (!swapped) {
          swapped = true;
          db.prepare(
            `UPDATE install_state
                SET vector_drain_lease_owner='renew-delete-replacement',
                    vector_drain_lease_expires_at=50_000
              WHERE id=1`,
          ).run();
        }
        return current.run();
      },
    });
    return wrap(statement);
  };
  let deleteWrites = 0;
  env.VECTORIZE.deleteByIds = async () => {
    deleteWrites++;
    return { mutationId: "must-not-delete" };
  };
  let deleteRenewalError = null;
  try {
    await drainOutbox(env, { now: () => 1_000, embed: async () => [0.1] });
  } catch (error) { deleteRenewalError = error; }
  const queued = db.prepare(
    `SELECT attempts FROM vector_outbox WHERE chunk_uid='drive:renew-delete#0'`,
  ).get();
  check("lost ownership immediately before delete performs no provider write",
    swapped && /ownership or expiry was lost/.test(deleteRenewalError?.message || "") &&
      deleteWrites === 0 && queued?.attempts === 1,
    JSON.stringify({ message: deleteRenewalError?.message, deleteWrites, queued }));
  env.DB.prepare = prepare;
  await releaseDrainLease(env, "renew-delete-replacement");
}

{
  const { env, db, deleted, upserted } = makeEnv();
  db.prepare("UPDATE install_state SET schema_version = 10 WHERE id = 1").run();
  insertDocument(db, "drive:partial-lease-migration");
  insertChunk(db, "drive:partial-lease-migration#0", "drive:partial-lease-migration", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:partial-lease-migration#0', 'drive:partial-lease-migration#0', 'upsert', 1)`
  ).run();
  let embeds = 0;
  let error = null;
  try {
    await drainOutbox(env, { embed: async () => { embeds++; return [0.1]; } });
  } catch (caught) { error = caught; }
  check("a half-migrated schema fails closed before acquiring the writer lease",
    /lease state is unavailable/.test(error?.message || "") && embeds === 0 &&
      deleted.length === 0 && upserted.length === 0 &&
      db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 1,
    JSON.stringify({ message: error?.message, embeds, deleted, upserted }));
}

/* maxBatches is only a latency preference. The internal statement budget is
   the hard stop, including legacy long-id remaps and the lease release. */
{
  const { env, db, d1Queries } = makeEnv();
  const count = 300;
  for (let i = 0; i < count; i++) {
    const deleteUid = `delete:${String(i).padStart(4, "0")}`;
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
       VALUES (?, ?, 'delete', ?)`
    ).run(deleteUid, deleteUid, i);

    const docUid = `drive:${"long-path-segment/".repeat(5)}${String(i).padStart(4, "0")}`;
    const chunkUid = `${docUid}#0`;
    insertDocument(db, docUid);
    insertChunk(db, chunkUid, docUid, 0);
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
       VALUES (?, ?, 'upsert', ?)`
    ).run(chunkUid, chunkUid, i);
  }
  const before = d1Queries.submitted;
  const drained = await drainOutbox(env, {
    embed: async () => [0.1],
    maxBatches: 10,
    batchSize: 100,
  });
  const submitted = d1Queries.submitted - before;
  const leaseState = db.prepare(
    `SELECT vector_drain_lease_owner owner, vector_drain_lease_expires_at expires
     FROM install_state WHERE id = 1`
  ).get();
  check("the documented worst-case batch statement bound includes hashed-id remaps",
    drainBatchQueryUpperBound(100) === 212);
  check("a ten-batch request stops before the internal D1 query budget",
    drained.drained === 200 && drained.remaining === 400 &&
      submitted === 421 && submitted < DRAIN_D1_QUERY_BUDGET,
    JSON.stringify({ drained, submitted, budget: DRAIN_D1_QUERY_BUDGET }));
  check("query-budget exhaustion never strands the exclusive drain lease",
    leaseState.owner === null && leaseState.expires === null,
    JSON.stringify(leaseState));
}

{
  const { env, db } = makeEnv();
  insertDocument(db, "drive:lease-exception");
  insertChunk(db, "drive:lease-exception#0", "drive:lease-exception", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:lease-exception#0', 'drive:lease-exception#0', 'upsert', 9000)`
  ).run();
  env.VECTORIZE.upsert = async () => { throw new Error("synthetic leased provider failure"); };
  let failure = null;
  try { await drainOutbox(env, { embed: async () => [0.1] }); } catch (error) { failure = error; }
  const state = db.prepare(
    `SELECT vector_drain_lease_owner owner, vector_drain_lease_expires_at expires
     FROM install_state WHERE id = 1`
  ).get();
  check("an exception releases its exact drain lease in finally",
    failure?.vectorUpsertFailed === true && state.owner === null && state.expires === null,
    JSON.stringify({ message: failure?.message, state }));
}

/* Hold an old generation inside Vectorize while a current-generation drain is
   attempted. The second invocation must stop at the lease, so the old write
   cannot land after a newer vector. Its generation-CAS then leaves the current
   row queued for the next exclusive owner. */
{
  const { env, db, upserted, visible } = makeEnv();
  insertDocument(db, "drive:generation-race");
  insertChunk(db, "drive:generation-race#0", "drive:generation-race", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:generation-race#0', 'drive:generation-race#0', 'upsert', 1234)`
  ).run();
  const firstGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'drive:generation-race#0'"
  ).get().generation;

  let signalOldUpsert;
  let releaseOldUpsert;
  const oldUpsertStarted = new Promise((resolve) => { signalOldUpsert = resolve; });
  const oldUpsertMayLand = new Promise((resolve) => { releaseOldUpsert = resolve; });
  let vectorCalls = 0;
  env.VECTORIZE.upsert = async (vectors) => {
    vectorCalls++;
    if (vectorCalls === 1) {
      signalOldUpsert();
      await oldUpsertMayLand;
    }
    return env._acceptVectorMutation(() => {
      upserted.push(...vectors);
      for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
    });
  };

  const firstDrainPromise = drainOutbox(env, {
    embed: async (text) => [text === "current replacement text" ? 2 : 1],
  });
  await oldUpsertStarted;
  const privateLeaseOwner = db.prepare(
    "SELECT vector_drain_lease_owner owner FROM install_state WHERE id = 1"
  ).get().owner;
  db.prepare(
    "UPDATE chunks SET text = 'current replacement text' WHERE chunk_uid = 'drive:generation-race#0'"
  ).run();
  // Deliberately reuse the exact same millisecond that the active drain read.
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:generation-race#0', 'drive:generation-race#0', 'upsert', 1234)
     ON CONFLICT(chunk_uid) DO UPDATE SET
       vector_id=excluded.vector_id, op=excluded.op, queued_at=excluded.queued_at,
       attempts=0, last_error=NULL`
  ).run();

  const overlappingDrain = await drainOutbox(env, {
    embed: async () => [2],
  });
  const busyReceipt = JSON.stringify(overlappingDrain);
  check("an overlapping newer drain fails closed before embedding or Vectorize",
    overlappingDrain.busy === true && overlappingDrain.remaining === 1 && vectorCalls === 1,
    busyReceipt);
  check("a busy receipt exposes no drain owner token",
    typeof privateLeaseOwner === "string" && !busyReceipt.includes(privateLeaseOwner) &&
      !busyReceipt.includes("vector_drain_lease_owner") &&
      !busyReceipt.includes("ownerToken") && !busyReceipt.includes("lease_owner"),
    busyReceipt);

  // The old write lands only after the newer invocation has been refused.
  releaseOldUpsert();
  const firstDrain = await firstDrainPromise;
  const requeued = db.prepare(
    "SELECT queued_at, generation FROM vector_outbox WHERE chunk_uid = 'drive:generation-race#0'"
  ).get();
  check("the old write cannot clear its same-millisecond replacement",
    firstDrain.remaining === 1 && requeued?.queued_at === 1234 && requeued.generation > firstGeneration,
    JSON.stringify({ firstDrain, firstGeneration, requeued }));

  const secondDrain = await drainFully(env, {
    embed: async (text) => [text === "current replacement text" ? 2 : 1],
  });
  check("the retained generation drains the current text on retry",
    secondDrain.remaining === 0 && upserted.map((vector) => vector.values[0]).join(",") === "1,2",
    JSON.stringify({ secondDrain, values: upserted.map((vector) => vector.values[0]) }));
}

/* Forget is enqueue-only even when an older leased upsert is already inside
   Vectorize. The stale write may land, but it cannot clear the newer delete;
   the next exclusive owner removes it deterministically. */
{
  const { env, db, deleted, upserted, visible } = makeEnv();
  insertDocument(db, "drive:forget-overlap");
  insertChunk(db, "drive:forget-overlap#0", "drive:forget-overlap", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:forget-overlap#0', 'drive:forget-overlap#0', 'upsert', 7777)`
  ).run();

  let signalStarted;
  let releaseOldWrite;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const mayLand = new Promise((resolve) => { releaseOldWrite = resolve; });
  env.VECTORIZE.upsert = async (vectors) => {
    signalStarted();
    await mayLand;
    return env._acceptVectorMutation(() => {
      upserted.push(...vectors);
      for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
    });
  };

  const oldDrainPromise = drainOutbox(env, { embed: async () => [1] });
  await started;
  const forgotten = await forget(env, {
    docUids: ["drive:forget-overlap"],
    dryRun: false,
  });
  const queuedDelete = db.prepare(
    `SELECT op, vector_id, generation FROM vector_outbox
     WHERE chunk_uid = 'drive:forget-overlap#0'`
  ).get();
  check("forget never bypasses the active Vectorize-writer lease",
    forgotten.vectors === 0 && forgotten.vector_cleanup_queued === 1 &&
      deleted.length === 0 && queuedDelete?.op === "delete",
    JSON.stringify({ forgotten, queuedDelete, deleted }));

  releaseOldWrite();
  const oldDrain = await oldDrainPromise;
  check("an old Vectorize write cannot acknowledge the newer forget generation",
    upserted.length === 1 && oldDrain.remaining === 1 &&
      db.prepare("SELECT op FROM vector_outbox WHERE chunk_uid = 'drive:forget-overlap#0'").get()?.op === "delete",
    JSON.stringify({ oldDrain, upserted: upserted.length }));

  const cleanup = await drainFully(env, { embed: async () => [2] });
  check("the next exclusive drain physically removes the stale landed vector",
    cleanup.remaining === 0 && cleanup.deleted === 1 &&
      deleted.join(",") === "drive:forget-overlap#0",
    JSON.stringify({ cleanup, deleted }));
}

/* Failure bookkeeping is generation-CAS guarded too. A stale provider error
   must not increment or poison the replacement row that appeared in flight. */
{
  const { env, db } = makeEnv();
  insertDocument(db, "drive:upsert-error-race");
  insertChunk(db, "drive:upsert-error-race#0", "drive:upsert-error-race", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:upsert-error-race#0', 'drive:upsert-error-race#0', 'upsert', 2222)`
  ).run();
  const oldGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'drive:upsert-error-race#0'"
  ).get().generation;
  env.VECTORIZE.upsert = async () => {
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
       VALUES ('drive:upsert-error-race#0', 'drive:upsert-error-race#0', 'upsert', 2222)
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op=excluded.op, queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).run();
    throw new Error("synthetic old-generation upsert failure");
  };
  let error = null;
  try { await drainOutbox(env, { embed: async () => [0.1] }); } catch (caught) { error = caught; }
  const current = db.prepare(
    `SELECT generation, attempts, last_error FROM vector_outbox
     WHERE chunk_uid = 'drive:upsert-error-race#0'`
  ).get();
  check("a stale upsert error cannot poison a replacement generation",
    error?.vectorUpsertFailed === true && current.generation > oldGeneration &&
      current.attempts === 0 && current.last_error === null,
    JSON.stringify({ message: error?.message, oldGeneration, current }));
}

/* Embedding can fail before a vector object exists. The selected generation
   still has to reach both ordinary poison bookkeeping and its stale-row CAS. */
{
  const { env, db } = makeEnv();
  insertDocument(db, "drive:embed-poison");
  insertChunk(db, "drive:embed-poison#0", "drive:embed-poison", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:embed-poison#0', 'drive:embed-poison#0', 'upsert', 3000)`
  ).run();
  const result = await drainOutbox(env, {
    embed: async () => { throw new Error("synthetic embedding poison"); },
  });
  const row = db.prepare(
    `SELECT attempts, last_error FROM vector_outbox
     WHERE chunk_uid = 'drive:embed-poison#0'`
  ).get();
  check("an embedding poison records its exact generation failure",
    result.failed === 1 && row.attempts === 1 && /embedding poison/.test(row.last_error),
    JSON.stringify({ result, row }));
}

{
  const { env, db } = makeEnv();
  insertDocument(db, "drive:embed-poison-race");
  insertChunk(db, "drive:embed-poison-race#0", "drive:embed-poison-race", 0);
  db.prepare(
    `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
     VALUES ('drive:embed-poison-race#0', 'drive:embed-poison-race#0', 'upsert', 4000)`
  ).run();
  const oldGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'drive:embed-poison-race#0'"
  ).get().generation;
  const result = await drainOutbox(env, {
    embed: async () => {
      db.prepare(
        `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
         VALUES ('drive:embed-poison-race#0', 'drive:embed-poison-race#0', 'upsert', 4000)
         ON CONFLICT(chunk_uid) DO UPDATE SET
           vector_id=excluded.vector_id, op=excluded.op, queued_at=excluded.queued_at,
           attempts=0, last_error=NULL`
      ).run();
      throw new Error("synthetic stale embedding poison");
    },
  });
  const current = db.prepare(
    `SELECT generation, attempts, last_error FROM vector_outbox
     WHERE chunk_uid = 'drive:embed-poison-race#0'`
  ).get();
  check("a stale embedding poison cannot mutate a replacement generation",
    result.failed === 1 && current.generation > oldGeneration &&
      current.attempts === 0 && current.last_error === null,
    JSON.stringify({ result, oldGeneration, current }));
}

{
  const { env, db } = makeEnv();
  insertDocument(db, "drive:delete-error-race");
  insertChunk(db, "drive:delete-error-race#0", "drive:delete-error-race", 0);
  await replaceDocumentChunks(env, "drive:delete-error-race");
  const oldGeneration = db.prepare(
    "SELECT generation FROM vector_outbox WHERE chunk_uid = 'drive:delete-error-race#0'"
  ).get().generation;
  env.VECTORIZE.deleteByIds = async () => {
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at)
       VALUES ('drive:delete-error-race#0', 'drive:delete-error-race#0', 'upsert', 3333)
       ON CONFLICT(chunk_uid) DO UPDATE SET
         vector_id=excluded.vector_id, op=excluded.op, queued_at=excluded.queued_at,
         attempts=0, last_error=NULL`
    ).run();
    throw new Error("synthetic old-generation delete failure");
  };
  let error = null;
  try { await drainOutbox(env, { embed: async () => [0.1] }); } catch (caught) { error = caught; }
  const current = db.prepare(
    `SELECT op, generation, attempts, last_error FROM vector_outbox
     WHERE chunk_uid = 'drive:delete-error-race#0'`
  ).get();
  check("a stale delete error cannot poison a replacement upsert generation",
    error?.vectorDeleteFailed === true && current.op === "upsert" &&
      current.generation > oldGeneration && current.attempts === 0 && current.last_error === null,
    JSON.stringify({ message: error?.message, oldGeneration, current }));
}

/* A transient delete failure is retained and visibly retryable. */
{
  const { env, db } = makeEnv({ deleteThrows: true });
  insertDocument(db, "drive:retry");
  insertChunk(db, "drive:retry#0", "drive:retry", 0, "retry-vector");
  await replaceDocumentChunks(env, "drive:retry");
  let error = null;
  try { await drainOutbox(env, { embed: async () => [0.1] }); } catch (e) { error = e; }
  const row = db.prepare("SELECT op, vector_id, attempts, last_error FROM vector_outbox").get();
  check("a failed delete is surfaced", error?.vectorDeleteFailed === true, error?.message);
  check("the exact vector id remains queued", row?.op === "delete" && row.vector_id === "retry-vector", JSON.stringify(row));
  check("the retry records its attempt and error", row?.attempts === 1 && /temporarily unavailable/.test(row.last_error), JSON.stringify(row));
}

/* Forget makes content unreachable first and always leaves physical cleanup to
   the one leased Vectorize writer. */
{
  const { env, db } = makeEnv({ deleteThrows: true });
  insertDocument(db, "drive:forget");
  insertChunk(db, "drive:forget#0", "drive:forget", 0, "forget-vector");
  const result = await forget(env, { docUids: ["drive:forget"], dryRun: false });
  check("forget removes the document and chunk from D1", db.prepare("SELECT count(*) n FROM documents").get().n === 0 && db.prepare("SELECT count(*) n FROM chunks").get().n === 0);
  check("forget reports enqueue-only cleanup without calling the provider",
    result.vectors === 0 && result.vector_cleanup_queued === 1 && result.vector_error === null,
    JSON.stringify(result));
  check("and preserves the delete operation for the next drain", db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='delete'").get().n === 1);
}

console.log(`\nvector delete outbox: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
