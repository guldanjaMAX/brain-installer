/** Exact-document grants, scoped retrieval, and passkey observability acceptance. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createProductFixture,
  json,
  seedOwnedEntity,
} from "./product-contract-fixture.mjs";

const ENTITY = "mesa-coffee";
const OTHER_ENTITY = "desert-books";

function insertDocument(fixture, {
  docUid, entitySlug, text, title = "Synthetic access document", client = null,
}) {
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,entity_slug,client)
     VALUES (?,'upload',?,?,?,?,'{}',?,?)`,
    docUid, docUid.slice("upload:".length), title, Date.now(), "b".repeat(64), entitySlug, client,
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,client)
     VALUES (?, ?, 0, ?, 'upload', ?, ?)`,
    `${docUid}#0`, docUid, text, title, client,
  );
}

async function appPost(fixture, path, body, headers = undefined) {
  return fixture.post(path, body, headers || await fixture.ownerHeaders());
}

async function loadStore(fixture) {
  return import(pathToFileURL(join(fixture.productRoot, "worker/src/lib/store-d1.js")).href);
}

test("document grant creation is exact, bounded, default-deny, and idempotent", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    seedOwnedEntity(fixture, OTHER_ENTITY, "Desert Books");
    insertDocument(fixture, {
      docUid: "upload:allowed-document", entitySlug: ENTITY,
      text: "Allowed exact document for the invented grant fixture.",
    });
    insertDocument(fixture, {
      docUid: "upload:other-entity", entitySlug: OTHER_ENTITY,
      text: "Other entity document must never enter this grant.",
    });

    const oversized = await json(await appPost(fixture, "/api/app/document-access/create", {
      request_id: "grant-too-large-0001",
      subject_label: "Oversized fixture",
      entity_slug: ENTITY,
      document_ids: Array.from({ length: 101 }, (_, index) => `upload:oversized-${index}`),
    }));
    assert.equal(oversized.response.status, 413);
    assert.deepEqual(
      { error: oversized.body.error, code: oversized.body.code },
      { error: "too_large", code: "document_grant_too_large" },
    );
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_grants").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_requests").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_events").n, 0);

    const crossEntity = await json(await appPost(fixture, "/api/app/document-access/create", {
      request_id: "grant-cross-entity-0001",
      subject_label: "Cross entity fixture",
      entity_slug: ENTITY,
      document_ids: ["upload:other-entity"],
    }));
    assert.equal(crossEntity.response.status, 403);
    assert.equal(crossEntity.body.code, "cross_entity_document_forbidden");
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_grants").n, 0);

    const createBody = {
      request_id: "grant-create-lost-0001",
      subject_label: "Invented reviewer",
      entity_slug: ENTITY,
      document_ids: ["upload:allowed-document"],
    };
    const lost = await appPost(fixture, "/api/app/document-access/create", createBody);
    assert.equal(lost.status, 200);
    const replay = await json(await appPost(fixture, "/api/app/document-access/create", createBody));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.scope_rule, "exact_document_ids_only");
    assert.equal(replay.body.entity_slug, ENTITY);
    assert.deepEqual(replay.body.document_ids, ["upload:allowed-document"]);
    assert.match(replay.body.enrollment_url || "", /#enroll=/);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_grants").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_documents").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_requests WHERE action='create'").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_events WHERE event_type='grant_created'").n, 1);

    const conflict = await json(await appPost(fixture, "/api/app/document-access/create", {
      ...createBody, document_ids: ["upload:allowed-document", "upload:other-entity"],
    }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "idempotency_conflict");

    // A document arriving after the immutable grant remains owner-only.
    insertDocument(fixture, {
      docUid: "upload:arrived-later", entitySlug: ENTITY,
      text: "Later material must not silently widen an existing grant.",
    });
    assert.equal(fixture.first(
      "SELECT count(*) AS n FROM document_access_documents WHERE document_id='upload:arrived-later'",
    ).n, 0);
  } finally {
    fixture.close();
  }
});

test("scoped retrieval cannot be crowded out by higher-ranked unauthorized documents", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    const authorizedUid = "upload:authorized-low-rank";
    insertDocument(fixture, {
      docUid: authorizedUid,
      entitySlug: ENTITY,
      text: `raregrant ${"filler ".repeat(400)}`,
      title: "Long low-ranked authorized fixture",
    });
    for (let index = 0; index < 12; index++) {
      insertDocument(fixture, {
        docUid: `upload:unauthorized-high-${index}`,
        entitySlug: ENTITY,
        text: "raregrant raregrant raregrant",
        title: `raregrant high-ranked unauthorized ${index}`,
      });
    }

    const store = await loadStore(fixture);
    const ownerTop = await store.searchKeyword(fixture.env, "raregrant", { limit: 5 });
    assert.equal(ownerTop.some((row) => row.doc_uid === authorizedUid), false,
      "the authorized fixture must genuinely sit below the unscoped top-K cutoff");

    const created = await json(await appPost(fixture, "/api/app/document-access/create", {
      request_id: "grant-crowd-out-0001",
      subject_label: "Crowd-out reviewer",
      entity_slug: ENTITY,
      document_ids: [authorizedUid],
    }));
    const grantId = created.body.grant_id;
    assert.ok(grantId);
    const scopedHeaders = await fixture.ownerHeaders({ grantId });

    fixture.seen.vectorQueries.length = 0;
    const scoped = await json(await appPost(fixture, "/api/rag/unified", {
      q: "raregrant", limit: 5, rerank: false,
    }, scopedHeaders));
    assert.equal(scoped.response.status, 200);
    assert.equal(scoped.body.retrieval_scope, "exact_document_ids");
    assert.equal(scoped.body.degraded, "scoped-vector");
    assert.equal(scoped.body.degraded_reason, "document-scope-keyword-only");
    assert.equal(scoped.body.access.grant_id, grantId);
    assert.deepEqual((scoped.body.results || []).map((row) => row.doc_uid), [authorizedUid]);
    assert.equal(fixture.seen.vectorQueries.length, 0,
      "scoped retrieval uses authoritative D1 prefilter instead of unsafe post-top-K filtering");
    assert.equal((scoped.body.results || []).some((row) => row.doc_uid.includes("unauthorized-high")), false);

    const ownerOnlyRoute = await json(await appPost(
      fixture, "/api/app/document-access/status", {}, scopedHeaders,
    ));
    assert.equal(ownerOnlyRoute.response.status, 403);
    assert.equal(ownerOnlyRoute.body.code, "owner_required");

    const newMaterial = await json(await appPost(fixture, "/api/rag/unified", {
      q: "Later material", limit: 5,
    }, scopedHeaders));
    assert.deepEqual(newMaterial.body.results, []);
    assert.equal(newMaterial.body.degraded, "scoped-vector",
      "grant-empty retrieval is explicitly vector-degraded, never silently healthy empty");

    fixture.control.failOn = /FROM document_access_grants/;
    const unavailable = await json(await appPost(fixture, "/api/rag/unified", {
      q: "raregrant", limit: 5,
    }, scopedHeaders));
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.code, "document_access_unavailable");
  } finally {
    fixture.close();
  }
});

test("revoked grants fail closed without erasing their audit trail", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    insertDocument(fixture, {
      docUid: "upload:revocation-fixture", entitySlug: ENTITY,
      text: "Revocation fixture content.",
    });
    const create = await json(await appPost(fixture, "/api/app/document-access/create", {
      request_id: "grant-revoke-create-0001",
      subject_label: "Revocation reviewer",
      entity_slug: ENTITY,
      document_ids: ["upload:revocation-fixture"],
    }));
    const grantId = create.body.grant_id;
    const scopedHeaders = await fixture.ownerHeaders({ grantId });
    const revokeBody = { request_id: "grant-revoke-lost-0001", grant_id: grantId };

    const lost = await appPost(fixture, "/api/app/document-access/revoke", revokeBody);
    assert.equal(lost.status, 200);
    const replay = await json(await appPost(fixture, "/api/app/document-access/revoke", revokeBody));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_grants").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_documents").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_events WHERE event_type='grant_revoked'").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM document_access_requests WHERE action='revoke'").n, 1);

    const denied = await json(await appPost(fixture, "/api/rag/unified", {
      q: "Revocation fixture", limit: 5,
    }, scopedHeaders));
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, "document_grant_inactive");
  } finally {
    fixture.close();
  }
});

test("passkey status aggregates bounded timing and excludes ceremony secrets", async () => {
  const fixture = await createProductFixture();
  try {
    const events = [
      ["pse-one", "registration", "verify", "succeeded", "passkey_added", 12],
      ["pse-two", "registration", "verify", "succeeded", "passkey_added", 24],
      ["pse-three", "authentication", "verify", "forbidden", "challenge_invalid", 6],
    ];
    for (const [eventId, ceremony, stage, outcome, reasonCode, durationMs] of events) {
      fixture.raw(
        `INSERT INTO passkey_security_events
           (event_id,occurred_at,rp_id,ceremony,stage,outcome,reason_code,
            principal_kind,grant_id,duration_ms)
         VALUES (?,?,'brain.invalid',?,?,?,?, 'owner',NULL,?)`,
        eventId, Date.now(), ceremony, stage, outcome, reasonCode, durationMs,
      );
    }

    const status = await json(await appPost(fixture, "/api/app/passkeys/status", {}));
    assert.equal(status.response.status, 200);
    assert.equal(status.body.status, "ready");
    assert.equal(status.body.rp_id, "brain.invalid");
    const succeeded = status.body.ceremonies.find((row) =>
      row.ceremony === "registration" && row.stage === "verify" && row.outcome === "succeeded");
    assert.deepEqual(succeeded.timing_ms, { min: 12, average: 18, max: 24 });
    assert.equal(succeeded.count, 2);

    const { privacy, ...observable } = status.body;
    const serialized = JSON.stringify(observable).toLowerCase();
    for (const forbidden of [
      "credential_id", "challenge", "assertion", "public_key", "clientdatajson",
      "authenticatordata", "signature", "user-agent", "ip_address", "document content",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `status must not expose ${forbidden}`);
    }
    assert.match(privacy, /No credential ids/i);

    fixture.control.failOn = /FROM passkey_security_events/;
    const unavailable = await json(await appPost(fixture, "/api/app/passkeys/status", {}));
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.code, "passkey_observability_unavailable");
  } finally {
    fixture.close();
  }
});
