import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { splitStatements } from "../../brain.mjs";
import { mintSessionCookie } from "../src/lib/sessions.js";
import {
  createDocumentGrant, revokeDocumentGrant, DocumentAccessUnavailableError,
} from "../src/lib/document-access.js";
import { consumeEnrollmentCode } from "../src/lib/auth-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const ORIGIN = "https://brain.example.com";
const ENTITY = "fixture-family";

function d1(db) {
  return {
    raw: db,
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() { return db.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: db.prepare(sql).all(...bound) }; },
        async run() {
          const result = db.prepare(sql).run(...bound);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function realDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) db.exec(statement);
  }
  // Backend migration 0019 owns this column and its evidence-backed backfill.
  // Until that integration commit lands, this fixture supplies the same final
  // schema without pretending legacy client labels are entity slugs.
  const documentColumns = new Set(db.prepare("PRAGMA table_info(documents)").all().map((row) => row.name));
  if (!documentColumns.has("entity_slug")) db.exec("ALTER TABLE documents ADD COLUMN entity_slug TEXT");
  db.prepare(
    `INSERT INTO install_state
     (id, client_slug, product_version, schema_version, gate_version, installed_at, ring, session_generation)
     VALUES (1, 'fixture', '0.0.0', 20, 0, '2026-08-29T00:00:00Z', 'test', 1)`,
  ).run();
  return db;
}

function insertDocument(db, id, entitySlug, text, index = 0) {
  db.prepare(
    `INSERT INTO documents
     (doc_uid, source, source_id, title, document_date, date_source, date_reliable,
      client, category, ingested_at, content_hash, meta, top_folder, platform,
      text_source, text_reliable, entity_slug)
     VALUES (?, 'drive', ?, ?, ?, 'fixture', 1, 'Acme', 'meeting', ?, ?, '{}',
             'Clients', 'imessage', 'native', 1, ?)`,
  ).run(id, id, id, Date.parse("2026-08-20T00:00:00Z") + index, Date.now(), `hash-${id}`, entitySlug);
  db.prepare(
    `INSERT INTO chunks
     (chunk_uid, doc_uid, chunk_ix, text, source, title, document_date, client,
      category, top_folder, platform)
     VALUES (?, ?, 0, ?, 'drive', ?, ?, 'Acme', 'meeting', 'Clients', 'imessage')`,
  ).run(`${id}#0`, id, text, id, Date.parse("2026-08-20T00:00:00Z") + index);
}

const envFor = (db, vectorCalls = { count: 0 }) => ({
  STORAGE: "d1",
  DB: d1(db),
  SESSION_SIGNING_KEY: "s".repeat(64),
  ADMIN_KEY: "admin-key-fixture-value-000",
  BRAIN_NAME: "fixture",
  BRAIN_OWNER: "Fixture Owner",
  VECTORIZE: {
    async query() { vectorCalls.count++; return { matches: [] }; },
  },
});

const post = (path, payload, cookie) => new Request(ORIGIN + path, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(cookie ? { Cookie: cookie, "X-Brain-App": "1" } : {}),
  },
  body: JSON.stringify(payload || {}),
});

test("100 exact documents plus every public filter stay authoritative and skip unscoped Vectorize", async () => {
  const db = realDb();
  const authorized = [];
  for (let index = 0; index < 100; index++) {
    const id = `drive:allowed-${String(index).padStart(3, "0")}`;
    authorized.push(id);
    insertDocument(db, id, ENTITY, index === 99 ? "needle appears once in the permitted record" : "ordinary permitted text", index);
  }
  // These would crowd an unscoped semantic/keyword top-K, but the exact D1
  // grant predicate excludes them before ranking.
  for (let index = 0; index < 12; index++) {
    insertDocument(
      db,
      `drive:forbidden-${index}`,
      "other-entity",
      "needle needle needle needle needle unauthorized high score",
      200 + index,
    );
  }

  const vectorCalls = { count: 0 };
  const env = envFor(db, vectorCalls);
  const ownerCookie = (await mintSessionCookie(env, 1, { grantId: null })).split(";")[0];
  const created = await worker.fetch(post("/api/app/document-access/create", {
    request_id: "grant-max-boundary-0001",
    subject_label: "Contract reviewer",
    entity_slug: ENTITY,
    document_ids: authorized,
  }, ownerCookie), env, {});
  const createdText = await created.text();
  assert.equal(created.status, 200, createdText);
  const receipt = JSON.parse(createdText);
  assert.equal(receipt.document_ids.length, 100);
  assert.equal(receipt.invite_state, "active");
  const tooLarge = await worker.fetch(post("/api/app/document-access/create", {
    request_id: "grant-max-boundary-0002",
    subject_label: "Contract reviewer",
    entity_slug: ENTITY,
    document_ids: [...authorized, "drive:one-too-many"],
  }, ownerCookie), env, {});
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), {
    error: "too_large",
    code: "document_grant_too_large",
    detail: "at most 100 document_ids may be granted at once",
  });

  const scopedCookie = (await mintSessionCookie(env, 1, { grantId: receipt.grant_id })).split(";")[0];
  const request = {
    q: "needle",
    limit: 10,
    source: "drive",
    client: "Acme",
    category: "meeting",
    top_folder: "Clients",
    platform: "imessage",
    from: "2026-08-01",
    to: "2026-08-31",
  };
  const unified = await worker.fetch(post("/api/rag/unified", request, scopedCookie), env, {});
  const unifiedText = await unified.text();
  assert.equal(unified.status, 200, unifiedText);
  const search = JSON.parse(unifiedText);
  assert.equal(search.results.length, 1, JSON.stringify(search));
  assert.equal(search.results[0].doc_uid, authorized[99]);
  assert.ok(search.results.every((row) => !row.doc_uid.includes("forbidden")));
  assert.equal(search.retrieval_scope, "exact_document_ids");
  assert.equal(search.degraded, "scoped-vector");
  assert.equal(search.degraded_reason, "document-scope-keyword-only");
  assert.equal(vectorCalls.count, 0, "scoped retrieval must not query unscoped Vectorize");

  const ask = await worker.fetch(post("/api/rag/think", request, scopedCookie), env, {});
  const answer = await ask.json();
  assert.equal(answer.retrieval_scope, "exact_document_ids");
  assert.equal(answer.degraded, "scoped-vector");
  assert.ok(answer.gaps.some((gap) => gap.type === "scoped_vector_unavailable"), JSON.stringify(answer));
  assert.ok(answer.results.every((row) => !row.doc_uid?.includes("forbidden")), JSON.stringify(answer));
  assert.equal(vectorCalls.count, 0);
});

test("grant create rejects cross-entity documents and unavailable entity authority", async () => {
  const db = realDb();
  insertDocument(db, "drive:a", ENTITY, "allowed");
  insertDocument(db, "drive:b", "other-entity", "not allowed");
  const env = envFor(db);
  await assert.rejects(
    createDocumentGrant(env, {
      request_id: "cross-entity-denial-0001",
      subject_label: "Reviewer",
      entity_slug: ENTITY,
      document_ids: ["drive:a", "drive:b"],
    }),
    (error) => error.code === "cross_entity_document_forbidden" && error.status === 403,
  );

  const unavailableEnv = { ...env, DB: { prepare() { throw new Error("D1 unavailable"); } } };
  await assert.rejects(
    createDocumentGrant(unavailableEnv, {
      request_id: "unavailable-denial-0001",
      subject_label: "Reviewer",
      entity_slug: ENTITY,
      document_ids: ["drive:a"],
    }),
    DocumentAccessUnavailableError,
  );
});

test("idempotent create replay reports active, consumed and expired invite state honestly", async () => {
  const db = realDb();
  insertDocument(db, "drive:a", ENTITY, "allowed");
  const env = envFor(db);
  const input = {
    request_id: "invite-replay-state-0001",
    subject_label: "Reviewer",
    entity_slug: ENTITY,
    document_ids: ["drive:a"],
  };
  const first = await createDocumentGrant(env, input);
  const active = await createDocumentGrant(env, input);
  assert.equal(active.invite_state, "active");
  assert.equal(active.enrollment_code, first.enrollment_code);

  assert.ok(await consumeEnrollmentCode(env, first.enrollment_code));
  const consumed = await createDocumentGrant(env, input);
  assert.equal(consumed.invite_state, "consumed");
  assert.equal(consumed.enrollment_code, null);

  const secondInput = { ...input, request_id: "invite-replay-state-0002" };
  const second = await createDocumentGrant(env, secondInput);
  db.prepare("UPDATE enrollment_codes SET expires_at = ? WHERE code_hash = (SELECT code_hash FROM enrollment_codes WHERE document_grant_id = ? ORDER BY expires_at DESC LIMIT 1)")
    .run(Date.now() - 1, second.grant_id);
  const expired = await createDocumentGrant(env, secondInput);
  assert.equal(expired.invite_state, "expired");
  assert.equal(expired.enrollment_code, null);
});

test("revocation immediately closes reads and scoped sessions cannot reach owner-only actions", async () => {
  const db = realDb();
  insertDocument(db, "drive:a", ENTITY, "needle");
  const env = envFor(db);
  const grant = await createDocumentGrant(env, {
    request_id: "revoke-and-owner-only-0001",
    subject_label: "Reviewer",
    entity_slug: ENTITY,
    document_ids: ["drive:a"],
  });
  const scopedCookie = (await mintSessionCookie(env, 1, { grantId: grant.grant_id })).split(";")[0];

  const me = await worker.fetch(post("/api/app/me", {}, scopedCookie), env, {});
  const meBody = await me.json();
  assert.deepEqual(meBody.principal, {
    kind: "grant",
    grant_id: grant.grant_id,
    entity_slug: ENTITY,
    document_count: 1,
    capabilities: ["documents:read", "ask"],
  });
  assert.deepEqual(meBody.workspace, {
    home: false, documents: true, ask: true, add_review: false, access: false,
    bank: false, targets: false, preferences: false,
  });
  const documents = await worker.fetch(post("/api/app/document-access/documents", {}, scopedCookie), env, {});
  const documentsBody = await documents.json();
  assert.equal(documentsBody.documents.length, 1);
  assert.equal(documentsBody.documents[0].document_id, "drive:a");
  assert.ok(!("uri" in documentsBody.documents[0]));
  assert.ok(!("text" in documentsBody.documents[0]));

  const allowedRead = await worker.fetch(post("/api/rag/unified", { q: "needle" }, scopedCookie), env, {});
  assert.equal(allowedRead.status, 200);
  const ownerCookie = (await mintSessionCookie(env, 1, { grantId: null })).split(";")[0];
  const statusResponse = await worker.fetch(post("/api/app/passkeys/status", {}, ownerCookie), env, {});
  const status = await statusResponse.json();
  assert.equal(status.status, "ready");
  assert.equal(status.rp_id, "brain.example.com");
  assert.equal(status.proof.live_proven, false);
  assert.ok(status.ceremonies.some((event) =>
    event.ceremony === "session_use" && event.timing_ms && event.timing_ms.average !== null
  ), JSON.stringify(status));
  for (const event of status.ceremonies) {
    for (const forbiddenKey of ["credential_id", "challenge", "assertion", "public_key", "user_agent", "ip_address"]) {
      assert.ok(!(forbiddenKey in event), `${forbiddenKey} must not be exposed`);
    }
  }

  for (const [path, payload] of [
    ["/api/app/document-access/create", {}],
    ["/api/app/recovery-codes", {}],
    ["/api/app/connections/revoke", { client_id: "anything" }],
    ["/oauth/authorize/decision?client_id=x", {}],
    ["/api/fin/status", {}],
    ["/api/bank-feed/link-token", {}],
  ]) {
    const response = await worker.fetch(post(path, payload, scopedCookie), env, {});
    assert.equal(response.status, 403, `${path} returned ${response.status}`);
  }

  await revokeDocumentGrant(env, {
    request_id: "revoke-and-owner-only-0002",
    grant_id: grant.grant_id,
  });
  const denied = await worker.fetch(post("/api/rag/unified", { q: "needle" }, scopedCookie), env, {});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "document_grant_inactive");
  const inactiveMe = await worker.fetch(post("/api/app/me", {}, scopedCookie), env, {});
  assert.equal(inactiveMe.status, 403);
  const inactiveBody = await inactiveMe.json();
  assert.equal(inactiveBody.signed_in, false);
  assert.equal(inactiveBody.clear_session, true);
  assert.match(inactiveMe.headers.get("Set-Cookie") || "", /Max-Age=0/);
});
