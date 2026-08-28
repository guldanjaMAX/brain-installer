/*
 * REGRESSION FIXTURE. See test/family-reconciliation.test.mjs for what it
 * proves.
 *
 * Node loads this with --import before brain.mjs, so the CLI's real local
 * folder ingest runs end to end against a scripted brain that never leaves
 * this process. Unlike test/fixtures/ingest-exit-fetch.mjs, whose
 * /api/admin/brain/forget stub answers 200 unconditionally, this one runs the
 * REAL worker code: worker/src/lib/store-d1.js forgetFamilies against a real
 * SQLite database built from the real migrations, wrapped in the same
 * try/catch-to-HTTP-400 the real route uses (worker/src/index.js).
 *
 * That single difference is why a permissive stub never caught the family
 * reconciliation bug.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

import { forgetFamilies } from "../../worker/src/lib/store-d1.js";

const userRoot = String(process.env.BRAIN_FAMILY_REPRO_USER_ROOT || "");
const evidencePath = String(process.env.BRAIN_FAMILY_REPRO_EVIDENCE || "");
// A file path here makes the scripted brain OUTLIVE one CLI process, which is
// what lets a test re-load the same export into the same brain and prove that
// the second load neither duplicates nor deletes anything.
const dbPath = String(process.env.BRAIN_FAMILY_REPRO_DB || ":memory:");
if (!userRoot) throw new Error("BRAIN_FAMILY_REPRO_USER_ROOT is required");
if (!evidencePath) throw new Error("BRAIN_FAMILY_REPRO_EVIDENCE is required");

// Keep token storage and support notes inside the disposable test directory.
os.homedir = () => userRoot;
syncBuiltinESMExports();

// Which envelope source_ids the scripted brain should answer "failed" for.
// Empty (the default) means every part is accepted, which is the SUCCESS path.
const failSourceIds = new Set(
  String(process.env.BRAIN_FAMILY_REPRO_FAIL_SOURCE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
const failEveryPart = process.env.BRAIN_FAMILY_REPRO_FAIL_ALL === "1";

/* --------------------------------------------- a real D1-shaped SQLite env */

const db = new DatabaseSync(dbPath);
{
  // A file-backed brain is reused across CLI runs, so the schema is applied
  // once and then left alone. Re-running the migrations over a populated
  // database is what a second `brain ingest` would never do either.
  const alreadyInstalled = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
    .get();
  const dir = fileURLToPath(new URL("../../migrations/d1/", import.meta.url));
  if (!alreadyInstalled) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(dir, file), "utf-8"));
    }
  }
  db.prepare(
    `INSERT OR IGNORE INTO install_state
       (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'fixture', '0.0.0', 12, 0, '2026-01-01T00:00:00Z', 'test')`
  ).run();
}

const prepare = (sql) => {
  const shape = (params = []) => ({
    bind: (...next) => shape(next),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
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

const workerEnv = {
  STORAGE: "d1",
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
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  },
};

// meta is stored because the real store stores it (worker/src/lib/store.js
// writes envelope.metadata into documents.meta). A family a document DECLARES
// rather than spells out in its name lives there, so a fixture that dropped it
// could not see the family at all.
const storeDocument = (docUid, source, sourceId, title, metadata) => db.prepare(
  `INSERT OR REPLACE INTO documents (doc_uid, source, source_id, title, ingested_at, content_hash, meta)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run(
  docUid, source, sourceId, title || docUid, Date.now(), `hash:${docUid}`,
  JSON.stringify(metadata || {}),
);

/* --------------------------------------------------------------- evidence */

const initialEvidence = () => ({
  ingestBatches: 0,
  storedDocUids: [],
  forgetRequests: [],
  forgetResults: [],
  forgetRejections: [],
  receipts: [],
});

function readEvidence() {
  try {
    return { ...initialEvidence(), ...JSON.parse(readFileSync(evidencePath, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return initialEvidence();
    throw error;
  }
}
let evidence = readEvidence();
const save = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
save();

/* ------------------------------------------------------- the scripted brain */

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const requestUrl = (input) => new URL(
  typeof input === "string" || input instanceof URL ? String(input) : input.url
);
const parseBody = (options) => JSON.parse(String(options.body || "{}"));

globalThis.fetch = async (input, options = {}) => {
  const url = requestUrl(input);
  if (url.hostname !== "fixture.invalid") {
    throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
  }

  if (url.pathname === "/api/admin/brain/source-receipt") {
    const receipt = parseBody(options);
    evidence.receipts.push({ status: receipt.status, error: receipt.error || null });
    save();
    return json({ source: receipt.source, status: receipt.status, run_id: receipt.run_id });
  }

  if (url.pathname === "/api/admin/brain/documents") {
    return json({ vector_backlog: { pending: 0 } });
  }

  if (url.pathname === "/api/admin/brain/ingest/batch") {
    const docs = parseBody(options).docs || [];
    evidence.ingestBatches++;
    const results = docs.map((doc) => {
      const failed = failEveryPart || failSourceIds.has(String(doc.source_id));
      if (failed) return { source_id: doc.source_id, status: "failed", error: "synthetic store failure" };
      const docUid = `${doc.source_type}:${doc.source_id}`;
      storeDocument(docUid, doc.source_type, doc.source_id, doc.title, doc.metadata);
      evidence.storedDocUids.push(docUid);
      return { source_id: doc.source_id, status: "created" };
    });
    save();
    return json({
      created: results.filter((r) => r.status === "created").length,
      updated: 0,
      unchanged: 0,
      refused: 0,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  }

  if (url.pathname === "/api/admin/brain/forget") {
    const body = parseBody(options);
    const families = Array.isArray(body.families) ? body.families : [];
    evidence.forgetRequests.push(families);
    // Exactly what worker/src/index.js does with the real store function.
    try {
      const out = await forgetFamilies(workerEnv, { families, dryRun: body.confirm !== true });
      evidence.forgetResults.push({ documents: Number(out.documents || 0), dry_run: out.dry_run === true });
      save();
      return json(out);
    } catch (error) {
      evidence.forgetRejections.push({ message: String(error.message), families });
      save();
      return json({ error: error.message }, 400);
    }
  }

  throw new Error(`unexpected fixture request: ${options.method || "GET"} ${url.origin}${url.pathname}`);
};
