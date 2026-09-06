import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  accessZoneReadiness, assignZone, createGrant, listGrants, listZones, sourcesInScope,
  ZONE_PROJECTION_REPAIR_BATCH_SIZE,
} from "../src/lib/auth-store.js";
import { handleAdminGrants, handleZones } from "../src/lib/owner-auth.js";
import { searchKeyword } from "../src/lib/store-d1.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/d1/", import.meta.url));

function d1Facade(db) {
  const statement = (sql, params = []) => ({
    bind: (...next) => statement(sql, next),
    async first() {
      return db.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
    async run() {
      const result = db.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes || 0) } };
    },
    runInBatch() {
      if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql)) {
        return { results: db.prepare(sql).all(...params), meta: { changes: 0 } };
      }
      const result = db.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes || 0) } };
    },
  });

  return {
    prepare: statement,
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((item) => item.runInBatch());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return { db, env: { DB: d1Facade(db) } };
}

function addSource(db, name, zone = null) {
  db.prepare(
    "INSERT INTO sources (name, kind, status, created_at, zone) VALUES (?, 'upload', 'ready', ?, ?)",
  ).run(name, new Date(0).toISOString(), zone);
}

function addDocument(db, source, id) {
  db.prepare(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, ingested_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`${source}:${id}`, source, id, `Document ${id}`, 1, `hash-${source}-${id}`);
}

function addChunk(db, source, id) {
  db.prepare(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title)
     VALUES (?, ?, 0, 'synthetic text', ?, 'Synthetic document')`,
  ).run(`${source}:${id}#0`, `${source}:${id}`, source);
}

test("assignZone refuses an unknown source without creating an orphan zone", async () => {
  const { db, env } = makeEnv();
  addDocument(db, "missing", "orphan");
  addChunk(db, "missing", "orphan");

  await assert.rejects(
    assignZone(env, { source: "missing", zone: "books" }),
    (error) => error?.code === "ZONE_SOURCE_NOT_FOUND" && error.message === "source is not registered",
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM zones").get().n, 0);
  assert.equal(db.prepare("SELECT zone FROM documents WHERE source = 'missing'").get().zone, null);
  assert.equal(db.prepare("SELECT zone FROM chunks WHERE source = 'missing'").get().zone, null);
});

test("the zone route maps an unknown source to a clear private-safe 404", async () => {
  const { db, env } = makeEnv();
  const response = await handleZones(env, new Request("https://brain.invalid/api/admin/brain/zones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "missing", zone: "books" }),
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "source is not registered",
    code: "zone_source_not_found",
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM zones").get().n, 0);
});

test("assignZone commits registration and source authority atomically", async () => {
  const { db, env } = makeEnv();
  addSource(db, "archive");
  addDocument(db, "archive", "old");
  addChunk(db, "archive", "old");
  db.exec(`
    CREATE TRIGGER reject_blocked_zone
    BEFORE UPDATE OF zone ON sources
    WHEN NEW.zone = 'blocked'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic zone update failure');
    END;
  `);

  await assert.rejects(
    assignZone(env, { source: "archive", zone: "blocked" }),
    /synthetic zone update failure/,
  );
  assert.equal(db.prepare("SELECT zone FROM sources WHERE name = 'archive'").get().zone, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM zones WHERE zone = 'blocked'").get().n, 0);

  const assigned = await assignZone(env, { source: "archive", zone: "legal" });
  assert.deepEqual(assigned, {
    source: "archive", zone: "legal", documents: 1, chunks: 1,
    projection_repaired: { documents: 1, chunks: 1 },
    projection_pending: { documents: 0, chunks: 0 },
    projection_repair_required: false,
  });
  assert.equal(db.prepare("SELECT zone FROM sources WHERE name = 'archive'").get().zone, "legal");
  assert.deepEqual(await assignZone(env, { source: "archive", zone: "legal" }), {
    ...assigned,
    projection_repaired: { documents: 0, chunks: 0 },
  }, "repeating a completed assignment is safe and reports no duplicate repair");
});

test("migration 0033 makes new documents and chunks inherit their source zone", () => {
  const { db } = makeEnv();
  addSource(db, "books", "books");
  addDocument(db, "books", "new");
  addChunk(db, "books", "new");

  assert.equal(db.prepare("SELECT zone FROM documents WHERE doc_uid = 'books:new'").get().zone, "books");
  assert.equal(db.prepare("SELECT zone FROM chunks WHERE chunk_uid = 'books:new#0'").get().zone, "books");

  addSource(db, "medical", "medical");
  db.prepare("UPDATE documents SET source = 'medical' WHERE doc_uid = 'books:new'").run();
  db.prepare("UPDATE chunks SET source = 'medical' WHERE chunk_uid = 'books:new#0'").run();
  assert.equal(db.prepare("SELECT zone FROM documents WHERE doc_uid = 'books:new'").get().zone, "medical");
  assert.equal(db.prepare("SELECT zone FROM chunks WHERE chunk_uid = 'books:new#0'").get().zone, "medical");
});

test("migration 0033 heals an existing document projection on an accepted revision", () => {
  const { db } = makeEnv();
  addSource(db, "archive", "legal");
  addDocument(db, "archive", "old");
  db.prepare("UPDATE documents SET zone = NULL WHERE doc_uid = 'archive:old'").run();

  db.prepare("UPDATE documents SET content_hash = 'reingested' WHERE doc_uid = 'archive:old'").run();
  assert.equal(db.prepare("SELECT zone FROM documents WHERE doc_uid = 'archive:old'").get().zone, "legal");
});

test("repeated zone assignment repairs legacy projections in bounded pages", async () => {
  const { db, env } = makeEnv();
  addSource(db, "archive");
  const total = ZONE_PROJECTION_REPAIR_BATCH_SIZE + 2;
  db.exec("BEGIN");
  for (let index = 0; index < total; index++) {
    addDocument(db, "archive", `legacy-${String(index).padStart(4, "0")}`);
    addChunk(db, "archive", `legacy-${String(index).padStart(4, "0")}`);
  }
  db.exec("COMMIT");

  const first = await assignZone(env, { source: "archive", zone: "legal" });
  assert.deepEqual(first.projection_repaired, {
    documents: ZONE_PROJECTION_REPAIR_BATCH_SIZE,
    chunks: ZONE_PROJECTION_REPAIR_BATCH_SIZE,
  });
  assert.deepEqual(first.projection_pending, { documents: 2, chunks: 2 });
  assert.equal(first.projection_repair_required, true);

  const second = await assignZone(env, { source: "archive", zone: "legal" });
  assert.deepEqual(second.projection_repaired, { documents: 2, chunks: 2 });
  assert.deepEqual(second.projection_pending, { documents: 0, chunks: 0 });
  assert.equal(second.projection_repair_required, false);

  const stable = await assignZone(env, { source: "archive", zone: "legal" });
  assert.deepEqual(stable.projection_repaired, { documents: 0, chunks: 0 });
  assert.deepEqual(stable.projection_pending, { documents: 0, chunks: 0 });
});

test("listZones reports the authoritative source mapping when legacy row projections drift", async () => {
  const { db, env } = makeEnv();
  addSource(db, "archive", "legal");
  addSource(db, "inbox");
  addDocument(db, "archive", "one");
  addChunk(db, "archive", "one");
  addDocument(db, "inbox", "two");
  addChunk(db, "inbox", "two");
  db.prepare("UPDATE documents SET zone = 'wrong' WHERE source = 'archive'").run();
  db.prepare("UPDATE chunks SET zone = 'wrong' WHERE source = 'archive'").run();

  const zones = (await listZones(env)).map((row) => ({ ...row }));
  assert.deepEqual(zones, [
    { zone: "(unzoned)", sources: 1, documents: 1, chunks: 1 },
    { zone: "legal", sources: 1, documents: 1, chunks: 1 },
  ]);
});

test("access-zone readiness distinguishes empty, unconfigured and complete registries", async () => {
  const { db, env } = makeEnv();

  assert.deepEqual(await accessZoneReadiness(env), {
    state: "empty",
    ready: false,
    authorization_authority: "source_registry",
    counts: {
      sources: { registered: 0, zoned: 0, unzoned: 0 },
      documents: { total: 0, unregistered: 0, projection_drift: 0 },
      chunks: { total: 0, unregistered: 0, projection_drift: 0 },
    },
  });

  addSource(db, "archive");
  addDocument(db, "archive", "one");
  addChunk(db, "archive", "one");
  assert.equal((await accessZoneReadiness(env)).state, "not_configured");

  await assignZone(env, { source: "archive", zone: "legal" });
  assert.deepEqual(await accessZoneReadiness(env), {
    state: "ready",
    ready: true,
    authorization_authority: "source_registry",
    counts: {
      sources: { registered: 1, zoned: 1, unzoned: 0 },
      documents: { total: 1, unregistered: 0, projection_drift: 0 },
      chunks: { total: 1, unregistered: 0, projection_drift: 0 },
    },
  });
});

test("access-zone readiness requires every registered source to be zoned once configuration starts", async () => {
  const { db, env } = makeEnv();
  addSource(db, "archive", "legal");
  addSource(db, "inbox");

  const readiness = await accessZoneReadiness(env);
  assert.equal(readiness.state, "needs_review");
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.counts.sources, { registered: 2, zoned: 1, unzoned: 1 });
});

test("access-zone readiness detects corpus rows outside the source registry", async () => {
  const { db, env } = makeEnv();
  addDocument(db, "orphan", "unregistered");
  addChunk(db, "orphan", "unregistered");

  const readiness = await accessZoneReadiness(env);
  assert.equal(readiness.state, "needs_review");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.counts.documents.unregistered, 1);
  assert.equal(readiness.counts.chunks.unregistered, 1);
});

test("access-zone readiness counts stale document and chunk projections", async () => {
  const { db, env } = makeEnv();
  addSource(db, "archive", "legal");
  addDocument(db, "archive", "registered");
  addChunk(db, "archive", "registered");
  db.prepare("UPDATE documents SET zone = NULL WHERE source = 'archive'").run();
  db.prepare("UPDATE chunks SET zone = NULL WHERE source = 'archive'").run();

  assert.deepEqual(await accessZoneReadiness(env), {
    state: "needs_review",
    ready: false,
    authorization_authority: "source_registry",
    counts: {
      sources: { registered: 1, zoned: 1, unzoned: 0 },
      documents: { total: 1, unregistered: 0, projection_drift: 1 },
      chunks: { total: 1, unregistered: 0, projection_drift: 1 },
    },
  });
});

test("the GET zone route preserves zones and adds aggregate readiness proof", async () => {
  const { db, env } = makeEnv();
  addSource(db, "archive", "legal");

  const response = await handleZones(
    env,
    new Request("https://brain.invalid/api/admin/brain/zones"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    zones: [{ zone: "legal", sources: 1, documents: 0, chunks: 0 }],
    readiness: {
      state: "ready",
      ready: true,
      authorization_authority: "source_registry",
      counts: {
        sources: { registered: 1, zoned: 1, unzoned: 0 },
        documents: { total: 0, unregistered: 0, projection_drift: 0 },
        chunks: { total: 0, unregistered: 0, projection_drift: 0 },
      },
    },
  });
});

test("all-zone source scope applies exclusions and fails closed on unzoned sources", async () => {
  const { db, env } = makeEnv();
  addSource(db, "books", "books");
  addSource(db, "medical", "medical");
  addSource(db, "inbox");

  assert.deepEqual(
    (await sourcesInScope(env, { all: true, exclude: ["medical"] })).sort(),
    ["books"],
  );
  assert.deepEqual(
    (await sourcesInScope(env, { all: true, exclude: [] })).sort(),
    ["books", "inbox", "medical"],
  );
  assert.deepEqual(
    await sourcesInScope(env, { all: true, exclude: [null] }),
    [],
    "a malformed exclusion must not widen to every source",
  );
});

test("all-with-exclusions retrieval omits excluded, unzoned and unregistered sources", async () => {
  const { db, env } = makeEnv();
  addSource(db, "books", "books");
  addSource(db, "medical", "medical");
  addSource(db, "inbox");
  for (const source of ["books", "medical", "inbox", "unregistered"]) {
    addDocument(db, source, "one");
    addChunk(db, source, "one");
  }

  const results = await searchKeyword(env, "synthetic", {
    limit: 10,
    scope: { all: true, exclude: ["medical"] },
  });
  assert.deepEqual(results.map((row) => row.source), ["books"]);
});

test("grant creation and listing return an auditable normalized exclusion scope", async () => {
  const { db, env } = makeEnv();
  addSource(db, "medical-records", "medical");
  const created = await handleAdminGrants(env, new Request("https://brain.invalid/api/admin/auth/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: "Synthetic reviewer",
      capabilities: ["ask"],
      exclude_zones: ["medical"],
    }),
  }), "/api/admin/auth/grants");
  assert.equal(created.status, 200);
  const receipt = await created.json();
  assert.deepEqual(receipt.exclude_zones, ["medical"]);
  assert.deepEqual(receipt.scope, { all: true, exclude: ["medical"] });

  const listed = await listGrants(env);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].scope, { all: true, exclude: ["medical"] });
  assert.equal("scope_include" in listed[0], false);
  assert.equal("scope_exclude" in listed[0], false);

  await createGrant(env, {
    grantId: "g-unrestricted-fixture",
    displayName: "Unrestricted fixture",
    capabilities: ["ask"],
    createdBy: "owner",
  });
  const all = await listGrants(env);
  assert.deepEqual(
    all.find((grant) => grant.grant_id === "g-unrestricted-fixture")?.scope,
    { all: true, exclude: [] },
  );
});

test("grant creation rejects malformed exclusions instead of silently widening access", async () => {
  const { env } = makeEnv();
  for (const exclude_zones of ["medical", [null], ["Medical"]]) {
    const response = await handleAdminGrants(env, new Request("https://brain.invalid/api/admin/auth/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: "Malformed exclusion",
        capabilities: ["ask"],
        exclude_zones,
      }),
    }), "/api/admin/auth/grants");
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await listGrants(env), []);
});

test("grant creation rejects unknown included and excluded zones before any write", async () => {
  const { db, env } = makeEnv();
  addSource(db, "ledger", "books");
  addSource(db, "medical-records", "medical");

  const attempts = [
    { zones: ["book"], exclude_zones: [] },
    { zones: ["books"], exclude_zones: ["medcial"] },
    { exclude_zones: ["medical", "legel"] },
  ];
  for (const scope of attempts) {
    const response = await handleAdminGrants(env, new Request("https://brain.invalid/api/admin/auth/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: "Typo scope",
        capabilities: ["ask"],
        ...scope,
      }),
    }), "/api/admin/auth/grants");
    assert.equal(response.status, 400);
    const receipt = await response.json();
    assert.equal(receipt.code, "unknown_zone");
  }

  assert.equal(db.prepare("SELECT count(*) AS n FROM grants").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM grant_credentials").get().n, 0);
});
