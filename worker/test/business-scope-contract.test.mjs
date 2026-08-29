/** Entity-scoped Explore/Ask acceptance against real D1 retrieval. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createProductFixture,
  json,
  seedCounterparty,
  seedOwnedEntity,
} from "./product-contract-fixture.mjs";

const ENTITY = "mesa-coffee";
const OTHER_ENTITY = "desert-books";

function seedCorpusDocument(fixture, {
  docUid, entitySlug, client = null, text, title = "Synthetic mapped document",
}) {
  fixture.raw(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,ingested_at,content_hash,meta,entity_slug,client)
     VALUES (?,'upload',?,?,?,?,'{}',?,?)`,
    docUid, docUid.slice("upload:".length), title, Date.now(), "a".repeat(64), entitySlug, client,
  );
  fixture.raw(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,client)
     VALUES (?, ?, 0, ?, 'upload', ?, ?)`,
    `${docUid}#0`, docUid, text, title, client,
  );
}

function seedLedgerMapping(fixture, docUid, entitySlug) {
  fixture.raw(
    `INSERT INTO fin_documents
       (tenant_id,fin_doc_uid,entity_slug,doc_kind,title,custody_class,availability,
        filed_at,corpus_doc_uid,readable,restricted,provenance,basis_state,recorded_at)
     VALUES ('primary',?,?,?,?, 'reference','have_it','2026-08-29',?,1,0,
             'owner_stated','confirmed','2026-08-29')`,
    `fin:${docUid}`, entitySlug, "other", "Mapped ledger document", docUid,
  );
}

async function scopedPost(fixture, path, body) {
  return fixture.post(path, body, await fixture.ownerHeaders());
}

test("entity scope uses the ledger-backed document authority, never legacy client alone", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    seedOwnedEntity(fixture, OTHER_ENTITY, "Desert Books");

    const mappedNullClient = "upload:mapped-null-client";
    seedCorpusDocument(fixture, {
      docUid: mappedNullClient,
      entitySlug: ENTITY,
      client: null,
      text: "rareanchor confirms the invented Mesa fixture fact.",
    });
    seedLedgerMapping(fixture, mappedNullClient, ENTITY);

    const mappedDifferentClient = "upload:mapped-different-client";
    seedCorpusDocument(fixture, {
      docUid: mappedDifferentClient,
      entitySlug: ENTITY,
      client: OTHER_ENTITY,
      text: "rareanchor is also present in this differently tagged fixture.",
    });
    seedLedgerMapping(fixture, mappedDifferentClient, ENTITY);

    seedCorpusDocument(fixture, {
      docUid: "upload:other-entity",
      entitySlug: OTHER_ENTITY,
      client: ENTITY,
      text: "rareanchor must not cross the authoritative entity boundary.",
    });

    fixture.seen.sql.length = 0;
    fixture.seen.binds.length = 0;
    const scoped = await json(await scopedPost(fixture, "/api/rag/unified", {
      q: "rareanchor", entity_slug: ENTITY, limit: 10, rerank: false,
    }));
    assert.equal(scoped.response.status, 200);
    assert.deepEqual(scoped.body.entity_scope, {
      entity_slug: ENTITY, applied: true,
    });
    assert.equal(scoped.body.degraded, "vector");
    assert.equal(scoped.body.degraded_reason, "entity-vector-authority-unindexed");
    assert.equal((scoped.body.ignored_filters || []).includes("entity_slug"), false);

    const ids = (scoped.body.results || []).map((row) => row.doc_uid || row.ref);
    const explicitGap = Boolean(scoped.body.degraded || scoped.body.status === "unavailable");
    assert.ok(
      ids.includes(mappedNullClient) || explicitGap,
      "null client metadata must return the authoritative entity-mapped document or an explicit gap",
    );
    assert.ok(
      ids.includes(mappedDifferentClient) || explicitGap,
      "conflicting client metadata must return the authoritative entity-mapped document or an explicit gap",
    );
    assert.equal(ids.includes("upload:other-entity"), false);

    const keywordSql = fixture.seen.sql.find((sql) => /FROM chunks_fts/.test(sql)) || "";
    assert.match(keywordSql, /entity_slug/);
    assert.doesNotMatch(
      keywordSql,
      /\bc\.client\s*=\s*\?/,
      "authoritative entity scope must not be intersected with stale/null legacy client metadata",
    );
  } finally {
    fixture.close();
  }
});

test("invalid, missing, counterparty, and unavailable entity scopes never reach search", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    seedCounterparty(fixture, "fixture-buyer");

    const cases = [
      [{ q: "fixture", entity_slug: "INVALID!" }, 400, "invalid_entity_slug"],
      [{ q: "fixture", entity_slug: "not-recorded" }, 404, "entity_not_found"],
      [{ q: "fixture", entity_slug: "fixture-buyer" }, 403, "entity_not_owned"],
      [{ q: "fixture", entity_slug: ENTITY, client: OTHER_ENTITY }, 409, "conflicting_business_scope"],
    ];
    for (const [body, status, code] of cases) {
      fixture.seen.sql.length = 0;
      fixture.seen.vectorQueries.length = 0;
      const refused = await json(await scopedPost(fixture, "/api/rag/unified", body));
      assert.equal(refused.response.status, status);
      assert.equal(refused.body.code, code);
      assert.equal(fixture.seen.sql.some((sql) => /FROM chunks_fts/.test(sql)), false);
      assert.equal(fixture.seen.vectorQueries.length, 0);
    }

    fixture.seen.sql.length = 0;
    fixture.control.failOn = /FROM fin_entities/;
    const unavailable = await json(await scopedPost(fixture, "/api/rag/unified", {
      q: "fixture", entity_slug: ENTITY,
    }));
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.code, "entity_scope_unavailable");
    assert.equal(fixture.seen.sql.some((sql) => /FROM chunks_fts/.test(sql)), false);
  } finally {
    fixture.close();
  }
});
