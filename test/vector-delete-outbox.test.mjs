// Vector deletions use the same retryable outbox as upserts.
//
// This runs against real SQLite because the important property is the state
// transition across INSERT...SELECT, ON CONFLICT, chunk deletion and retry.
// Hand-written SQL mocks cannot prove that those statements compose.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDocumentChunks, upsertChunks, drainOutbox, forget, forgetFamilies } from "../worker/src/lib/store-d1.js";
import { storeFor } from "../worker/src/lib/store.js";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

function makeEnv({ deleteThrows = false, enforceD1PatternLimit = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }

  const deleted = [];
  const upserted = [];
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => {
        if (enforceD1PatternLimit && /\b(?:LIKE|GLOB)\b/i.test(sql) &&
            params.some((value) => new TextEncoder().encode(String(value)).length > 50)) {
          throw new Error("LIKE or GLOB pattern too complex");
        }
        return { results: db.prepare(sql).all(...params) };
      },
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
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
    DB: {
      prepare,
      batch: async (statements) => {
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
      upsert: async (vectors) => { upserted.push(...vectors); },
      deleteByIds: async (ids) => {
        if (deleteThrows) throw new Error("Vectorize temporarily unavailable");
        deleted.push(...ids);
      },
    },
  };
  return { env, db, deleted, upserted };
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

  await drainOutbox(env, { embed: async () => [0.1] });
  const second = await store.ingest(env, { ...base, content: "short replacement" });
  check("a shorter public re-ingest is reported as updated", second.action === "updated" && second.chunks === 1, JSON.stringify(second));
  const queuedDeletes = db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='delete'").get().n;
  check("the removed tail is queued for Vectorize deletion", queuedDeletes === first.chunks - 1, `queued=${queuedDeletes} first=${first.chunks}`);
  await drainOutbox(env, { embed: async () => [0.2] });
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

const insertDocument = (db, uid, source = "drive") => db.prepare(
  `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(uid, source, uid, uid, Date.now(), `hash:${uid}`);

const insertChunk = (db, uid, doc, ix, vectorId = uid) => db.prepare(
  `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
   VALUES (?, ?, ?, ?, 'drive', ?)`
).run(uid, doc, ix, `old text ${ix}`, vectorId);

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

  const result = await drainOutbox(env, { embed: async () => [0.1] });
  check("the removed tail is deleted by its stored Vectorize id", deleted.length === 1 && deleted[0] === "hashed-tail", JSON.stringify(deleted));
  check("the current chunks are re-upserted", upserted.length === 2, String(upserted.length));
  check("both operation types are counted", result.deleted === 1 && result.upserted === 2 && result.drained === 3, JSON.stringify(result));
  check("the outbox is empty only after both stores acknowledge", db.prepare("SELECT count(*) n FROM vector_outbox").get().n === 0);
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

/* Forget makes content unreachable first but retains failed physical cleanup. */
{
  const { env, db } = makeEnv({ deleteThrows: true });
  insertDocument(db, "drive:forget");
  insertChunk(db, "drive:forget#0", "drive:forget", 0, "forget-vector");
  const result = await forget(env, { docUids: ["drive:forget"], dryRun: false });
  check("forget removes the document and chunk from D1", db.prepare("SELECT count(*) n FROM documents").get().n === 0 && db.prepare("SELECT count(*) n FROM chunks").get().n === 0);
  check("forget reports cleanup still queued", result.vector_cleanup_queued === 1 && !!result.vector_error, JSON.stringify(result));
  check("and preserves the delete operation for the next drain", db.prepare("SELECT count(*) n FROM vector_outbox WHERE op='delete'").get().n === 1);
}

console.log(`\nvector delete outbox: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
