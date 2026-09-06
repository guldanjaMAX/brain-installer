import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../migrations/d1/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();

  const visible = new Map();
  let mutationSequence = 0;
  let processedUpToMutation = null;
  let processedUpToDatetime = null;
  const pending = [];
  const control = { processedAtMs: null };
  const stamp = () => {
    processedUpToDatetime = control.processedAtMs === null
      ? null : new Date(control.processedAtMs).toISOString();
  };
  const accept = (apply) => {
    const mutationId = `fixture-mutation-${++mutationSequence}`;
    pending.push({ mutationId, apply });
    return { mutationId };
  };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
      },
    });
    return shape();
  };
  const env = {
    _acceptVectorMutation: accept,
    _processNextVectorMutation: () => {
      const mutation = pending.shift();
      if (!mutation) return null;
      mutation.apply();
      processedUpToMutation = mutation.mutationId;
      stamp();
      return mutation.mutationId;
    },
    // Move the watermark WITHOUT applying, so an unprocessed delete can be
    // proven to stay unconfirmed even when the fence opens.
    _advanceWatermarkWithoutApplying: () => {
      const mutation = pending.shift();
      if (!mutation) return null;
      processedUpToMutation = mutation.mutationId;
      stamp();
      return mutation.mutationId;
    },
    DB: {
      exec: async (sql) => { db.exec(sql); return { count: 1 }; },
      prepare,
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      },
    },
    VECTORIZE: {
      upsert: async (vectors) => accept(() => {
        for (const vector of vectors) visible.set(vector.id, structuredClone(vector));
      }),
      deleteByIds: async (ids) => accept(() => { for (const id of ids) visible.delete(id); }),
      getByIds: async (ids) => ids.map((id) => visible.get(id)).filter(Boolean),
      describe: async () => ({
        vectorCount: visible.size,
        processedUpToMutation,
        ...(processedUpToDatetime === null ? {} : { processedUpToDatetime }),
      }),
    },
  };
  return { env, db, control, visible };
}

export const seed = (db, count) => {
  for (let i = 0; i < count; i++) {
    const doc = `drive:fence-${i}`, uid = `${doc}#0`;
    db.prepare(
      `INSERT INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash)
       VALUES (?, 'drive', ?, ?, ?, ?)`
    ).run(doc, doc, doc, Date.now(), `hash:${doc}`);
    db.prepare(
      `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, vector_id)
       VALUES (?, ?, 0, ?, 'drive', ?)`
    ).run(uid, doc, `text ${i}`, uid);
    db.prepare(
      `INSERT INTO vector_outbox (chunk_uid, vector_id, op, queued_at) VALUES (?, ?, 'upsert', ?)`
    ).run(uid, uid, i + 1);
  }
};
export const remaining = (db) => db.prepare("SELECT count(*) AS n FROM vector_outbox").get().n;
export const embed = async () => [0.1];
