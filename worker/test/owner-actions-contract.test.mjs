/**
 * Independent owner-workspace contract acceptance against the real Worker,
 * real migrations, and real SQLite constraints. All people, entities, files,
 * and financial values here are invented fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createProductFixture,
  json,
  loadOwnerActions,
  seedCounterparty,
  seedOwnedEntity,
} from "./product-contract-fixture.mjs";

const ENTITY = "mesa-coffee";
const OTHER_ENTITY = "desert-books";

async function ownerPost(fixture, path, body = {}, headers = undefined) {
  return fixture.post(path, body, headers || await fixture.ownerHeaders());
}

function uploadBody(requestId, overrides = {}) {
  return {
    request_id: requestId,
    document_id: "owner-note-2026-08-29",
    entity_slug: ENTITY,
    media_type: "text/plain",
    file_name: "owner-note.txt",
    envelope: {
      title: "Owner note",
      content: "Quarterly planning note for Mesa Coffee.",
      metadata: { channel: "owner_workspace" },
    },
    ...overrides,
  };
}

function assertPrivate(response) {
  const cache = response.headers.get("cache-control") || "";
  assert.match(cache, /private/);
  assert.match(cache, /no-store/);
}

function seedApprovalEvidence(fixture) {
  fixture.raw(
    `INSERT INTO fin_reconciliations
       (tenant_id,reconciliation_uid,entity_slug,account_slug,period_start,period_end,
        measure,state,delta_minor,tolerance_minor,currency,ruling_consumed,computed_at,recorded_at)
     VALUES ('primary','recon-fixture',?,'mesa-operating','2026-07-01','2026-07-31',
             'closing_balance','mismatched',500,0,'USD',0,'2026-08-29','2026-08-29')`,
    ENTITY,
  );
  for (const [uid, label, amount] of [
    ["claim-statement", "Statement", 100_000],
    ["claim-feed", "Bank feed", 100_500],
  ]) {
    fixture.raw(
      `INSERT INTO fin_reconciliation_claims
         (tenant_id,claim_uid,reconciliation_uid,label,amount_minor,currency,as_of,
          provenance,basis_state,recorded_at)
       VALUES ('primary',?,'recon-fixture',?,?,'USD','2026-07-31',
               'owner_stated','confirmed','2026-08-29')`,
      uid, label, amount,
    );
  }
  fixture.raw(
    `INSERT INTO fin_accounts
       (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,currency,
        feed_mode,status,provenance,basis_state,recorded_at)
     VALUES ('primary','mesa-operating',?,'Operating','checking','asset','USD',
             'manual','open','owner_stated','confirmed','2026-08-29')`,
    ENTITY,
  );
  fixture.raw(
    `INSERT INTO fin_transactions
       (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,
        description,pending,provenance,basis_state,recorded_at)
     VALUES ('primary','txn-fixture','mesa-operating','2026-07-15',2500,'outflow','USD',
             'Invented fixture expense',0,'owner_stated','confirmed','2026-08-29')`,
  );
  fixture.raw(
    `INSERT INTO fin_exceptions
       (tenant_id,exception_uid,entity_slug,kind,issue,amount_minor,currency,txn_uid,
        txn_date,txn_account_slug,first_seen,provenance,basis_state,recorded_at)
     VALUES ('primary','exception-fixture',?,'uncategorized','Needs a category',2500,'USD',
             'txn-fixture','2026-07-15','mesa-operating','2026-07-15',
             'owner_stated','confirmed','2026-08-29')`,
    ENTITY,
  );
}

test("owner routes require the positive session principal and publish exact upload capability", async () => {
  const fixture = await createProductFixture();
  try {
    const unauthenticated = await fixture.post("/api/owner/uploads/capabilities", {});
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: "unauthorized", code: "session_required" });
    assertPrivate(unauthenticated);

    const adminFallback = await fixture.post(
      "/api/owner/uploads/capabilities",
      {},
      { "X-Admin-Key": fixture.env.ADMIN_KEY },
    );
    assert.equal(adminFallback.status, 401, "the admin credential is not an owner session");

    const owner = await fixture.ownerHeaders();
    const noCsrfCompanion = await fixture.post(
      "/api/owner/uploads/capabilities",
      {},
      { Cookie: owner.Cookie },
    );
    assert.equal(noCsrfCompanion.status, 401);

    const capabilities = await ownerPost(fixture, "/api/owner/uploads/capabilities");
    assert.equal(capabilities.status, 200);
    assertPrivate(capabilities);
    assert.deepEqual(await capabilities.json(), {
      supported_media_types: [
        "text/plain", "text/markdown", "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel", "message/rfc822", "image/png", "image/jpeg",
      ],
      text_media_types: ["text/plain", "text/markdown"],
      binary_media_types: [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel", "message/rfc822", "image/png", "image/jpeg",
      ],
      supported_extensions: [
        ".txt", ".md", ".markdown", ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".eml", ".png", ".jpg", ".jpeg",
      ],
      media_type_extensions: {
        "text/plain": [".txt"],
        "text/markdown": [".md", ".markdown"],
        "application/pdf": [".pdf"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
        "application/vnd.ms-excel": [".xls"],
        "message/rfc822": [".eml"],
        "image/png": [".png"],
        "image/jpeg": [".jpg", ".jpeg"],
      },
      max_content_bytes: 1_000_000,
      max_binary_bytes: 8 * 1024 * 1024,
      max_ocr_image_bytes: 3_000_000,
      media_type_max_bytes: {
        "text/plain": 1_000_000,
        "text/markdown": 1_000_000,
        "application/pdf": 8 * 1024 * 1024,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": 8 * 1024 * 1024,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": 8 * 1024 * 1024,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 8 * 1024 * 1024,
        "application/vnd.ms-excel": 8 * 1024 * 1024,
        "message/rfc822": 8 * 1024 * 1024,
        "image/png": 3_000_000,
        "image/jpeg": 3_000_000,
      },
      content_encoding: "utf-8",
      empty_media_type_supported: false,
      normalization: "text is decoded as strict UTF-8; documents use bounded native extraction; PNG and JPEG use private OCR",
      scanned_pdf_ocr_supported: false,
    });

    fixture.env.VECTOR_DRAIN_MODE = "paused-for-upgrade";
    const paused = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("paused-write")));
    assert.equal(paused.response.status, 503);
    assert.deepEqual(paused.body, {
      error: "unavailable", code: "owner_writes_paused", paused: true,
    });
    const pausedRead = await ownerPost(fixture, "/api/owner/activity", {});
    assert.equal(pausedRead.status, 200, "upgrade pause leaves bounded reads available");
  } finally {
    fixture.close();
  }
});

test("owner upload refuses unsafe media, size, scope, and credentials before mutation", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    const before = () => ({
      documents: fixture.first("SELECT count(*) AS n FROM documents").n,
      receipts: fixture.first("SELECT count(*) AS n FROM owner_action_requests").n,
      activity: fixture.first("SELECT count(*) AS n FROM owner_activity_events").n,
    });
    assert.deepEqual(before(), { documents: 0, receipts: 0, activity: 0 });

    const unsupported = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("bad-media", {
      media_type: "application/zip", file_name: "statement.zip",
    })));
    assert.equal(unsupported.response.status, 415);
    assert.equal(unsupported.body.uploaded, false);
    assert.equal(unsupported.body.unsupported_media, true);

    const invalidBinaryTransport = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("bad-binary-transport", {
      media_type: "application/pdf", file_name: "statement.pdf", envelope: { content: "%PDF" },
    })));
    assert.equal(invalidBinaryTransport.response.status, 400);
    assert.equal(invalidBinaryTransport.body.code, "binary_content_must_be_base64");

    const mismatch = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("bad-extension", {
      media_type: "text/markdown", file_name: "note.txt",
    })));
    assert.equal(mismatch.response.status, 415);

    const clientOwnedIdentity = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("client-identity", {
      envelope: {
        ...uploadBody("x").envelope,
        source_type: "upload",
        source_id: "caller-chosen",
      },
    })));
    assert.equal(clientOwnedIdentity.response.status, 400);
    assert.equal(clientOwnedIdentity.body.code, "server_owned_document_identity");

    const oversized = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("too-large", {
      envelope: { ...uploadBody("x").envelope, content: "x".repeat(1_000_001) },
    })));
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.uploaded, false);

    const conflictingScope = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("scope-conflict", {
      envelope: {
        ...uploadBody("x").envelope,
        metadata: { client: OTHER_ENTITY },
      },
    })));
    assert.equal(conflictingScope.response.status, 409);
    assert.equal(conflictingScope.body.code, "conflicting_business_scope");

    const credential = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("credential-refusal", {
      envelope: {
        ...uploadBody("x").envelope,
        content: `The deploy key is AKIA${"Z".repeat(16)} and must not enter the brain.`,
      },
    })));
    assert.equal(credential.response.status, 422);
    assert.equal(credential.body.uploaded, false);
    assert.match(credential.body.error, /refused/);
    assert.deepEqual(before(), { documents: 0, receipts: 0, activity: 0 });
  } finally {
    fixture.close();
  }
});

test("upload resumes committed ingest after finalization response loss and remains safely forgettable", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    const body = uploadBody("upload-lost-response");

    const { handleOwnerActions } = await loadOwnerActions(fixture.productRoot);
    const owner = await fixture.ownerHeaders();
    const request = () => new Request("https://brain.invalid/api/owner/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...owner },
      body: JSON.stringify(body),
    });
    const ingestEnvelope = (envelope) => fixture.post(
      "/api/admin/brain/ingest",
      envelope,
      { "X-Admin-Key": fixture.env.ADMIN_KEY },
    );

    // Common ingest commits, then final audit/response handling disappears.
    // The pending intent is the only safe recovery boundary for this crash.
    const lost = await json(await handleOwnerActions(
      fixture.env,
      request(),
      "/api/owner/uploads",
      { ingestEnvelope, afterIngest: async () => { throw new Error("synthetic response loss"); } },
    ));
    assert.equal(lost.response.status, 503);
    assert.equal(lost.body.code, "owner_upload_finalize_unavailable");
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_action_requests WHERE request_id=?", body.request_id).n, 1);

    const replay = await json(await handleOwnerActions(
      fixture.env, request(), "/api/owner/uploads", { ingestEnvelope },
    ));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.document.action, "created");
    assert.equal(replay.body.changed, true);
    assert.equal(replay.body.document_id, body.document_id);
    assert.deepEqual(replay.body.entity_scope, { entity_slug: ENTITY });
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_action_requests WHERE request_id=?", body.request_id).n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events WHERE request_id=?", body.request_id).n, 1);

    const document = fixture.first(
      "SELECT doc_uid,source,source_id,client,meta,deleted_at FROM documents WHERE doc_uid=?",
      "upload:owner:mesa-coffee:owner-note-2026-08-29",
    );
    assert.equal(document.source, "upload");
    assert.equal(document.source_id, "owner:mesa-coffee:owner-note-2026-08-29");
    assert.equal(document.client, ENTITY);
    assert.equal(document.deleted_at, null);
    const metadata = JSON.parse(document.meta);
    assert.equal(metadata.entity_slug, ENTITY);
    assert.equal(metadata.client, ENTITY);
    assert.equal(metadata.client_name, ENTITY);
    assert.equal(metadata.channel, "owner_workspace");
    assert.ok(fixture.first("SELECT count(*) AS n FROM chunks WHERE doc_uid=? AND client=?", document.doc_uid, ENTITY).n > 0);
    assert.ok(fixture.first("SELECT count(*) AS n FROM vector_outbox WHERE op='upsert'").n > 0);

    const third = await json(await ownerPost(fixture, "/api/owner/uploads", body));
    assert.equal(third.response.status, 200);
    assert.equal(third.body.replayed, true);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events WHERE request_id=?", body.request_id).n, 1);

    const conflictingRetry = await json(await ownerPost(fixture, "/api/owner/uploads", {
      ...body,
      envelope: { ...body.envelope, content: `${body.envelope.content} changed` },
    }));
    assert.equal(conflictingRetry.response.status, 409);
    assert.equal(conflictingRetry.body.code, "request_id_conflict");

    const unchanged = await json(await ownerPost(fixture, "/api/owner/uploads", {
      ...body, request_id: "upload-unchanged",
    }));
    assert.equal(unchanged.response.status, 200);
    assert.equal(unchanged.body.document.action, "unchanged");
    assert.equal(unchanged.body.changed, false);
    assert.equal(unchanged.body.activity_event_id, null);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events").n, 1);

    const admin = { "X-Admin-Key": fixture.env.ADMIN_KEY };
    const inventory = await json(await fixture.post(
      "/api/admin/brain/source-families", { source: "upload", limit: 1000 }, admin,
    ));
    assert.equal(inventory.response.status, 200);
    assert.deepEqual(inventory.body.families, [document.doc_uid]);

    const preview = await json(await fixture.post(
      "/api/admin/brain/forget", { source: "upload" }, admin,
    ));
    assert.equal(preview.body.dry_run, true);
    assert.equal(preview.body.documents, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1);

    fixture.control.vectorDrainFails = true;
    const removed = await json(await fixture.post(
      "/api/admin/brain/forget", { source: "upload", confirm: true }, admin,
    ));
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.dry_run, false);
    assert.equal(removed.body.documents, 1);
    assert.ok(removed.body.vector_cleanup_queued > 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM chunks").n, 0);
    assert.ok(fixture.first("SELECT count(*) AS n FROM vector_outbox WHERE op='delete'").n > 0);

    const after = await json(await fixture.post(
      "/api/admin/brain/source-families", { source: "upload", limit: 1000 }, admin,
    ));
    assert.deepEqual(after.body.families, []);
  } finally {
    fixture.close();
  }
});

test("a failed common-ingest transaction emits no domain/activity change and exact retry resumes intent", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    fixture.control.failOn = /INSERT INTO documents/;
    const failed = await ownerPost(fixture, "/api/owner/uploads", uploadBody("failed-ingest"));
    assert.equal(failed.status, 503);
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM chunks").n, 0);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_action_requests").n, 1);
    assert.equal(JSON.parse(fixture.first("SELECT response_json FROM owner_action_requests").response_json).pending, true);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events").n, 0);

    fixture.control.failOn = null;
    const retry = await json(await ownerPost(fixture, "/api/owner/uploads", uploadBody("failed-ingest")));
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.replayed, true, "the retry resumes the durable request intent");
    assert.equal(fixture.first("SELECT count(*) AS n FROM documents").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events").n, 1);
  } finally {
    fixture.close();
  }
});

test("approval is append-only, entity-bound, and replay-safe after a lost response", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    seedOwnedEntity(fixture, OTHER_ENTITY, "Desert Books");
    seedApprovalEvidence(fixture);

    const ruling = {
      request_id: "ruling-one",
      entity_slug: ENTITY,
      approval_type: "reconciliation_ruling",
      subject_uid: "recon-fixture",
      selected_claim_uid: "claim-statement",
      note: "Use the dated statement for this close.",
    };
    const ruled = await json(await ownerPost(fixture, "/api/owner/approvals", ruling));
    assert.equal(ruled.response.status, 201);
    const reconciliation = fixture.first(
      "SELECT ruled_claim_uid,ruling_consumed FROM fin_reconciliations WHERE reconciliation_uid='recon-fixture'",
    );
    assert.deepEqual(
      { ...reconciliation },
      { ruled_claim_uid: "claim-statement", ruling_consumed: 0 },
    );
    assert.equal(fixture.first("SELECT count(*) AS n FROM fin_reconciliation_claims WHERE reconciliation_uid='recon-fixture'").n, 2);

    const wrongEntity = await json(await ownerPost(fixture, "/api/owner/approvals", {
      ...ruling, request_id: "wrong-entity", entity_slug: OTHER_ENTITY,
    }));
    assert.equal(wrongEntity.response.status, 404);
    assert.equal(wrongEntity.body.code, "subject_not_found");

    const exception = {
      request_id: "exception-lost-response",
      entity_slug: ENTITY,
      approval_type: "exception_resolution",
      subject_uid: "exception-fixture",
      resolution: "Owner categorized this fixture separately.",
    };
    const transactionBefore = fixture.first("SELECT * FROM fin_transactions WHERE txn_uid='txn-fixture'");
    const lost = await ownerPost(fixture, "/api/owner/approvals", exception);
    assert.equal(lost.status, 201);
    const replay = await json(await ownerPost(fixture, "/api/owner/approvals", exception));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_approvals WHERE request_id=?", exception.request_id).n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events WHERE request_id=?", exception.request_id).n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_action_requests WHERE request_id=?", exception.request_id).n, 1);
    assert.deepEqual(
      fixture.first("SELECT * FROM fin_transactions WHERE txn_uid='txn-fixture'"),
      transactionBefore,
      "resolving the exception must not rewrite its source transaction",
    );

    const laterConflict = await json(await ownerPost(fixture, "/api/owner/approvals", {
      ...exception, request_id: "exception-conflict", resolution: "A different resolution.",
    }));
    assert.equal(laterConflict.response.status, 409);
    assert.equal(laterConflict.body.code, "exception_already_resolved");
  } finally {
    fixture.close();
  }
});

test("period close makes incomplete and unavailable evidence explicit", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    const period = { entity_slug: ENTITY, period_start: "2026-07-01", period_end: "2026-07-31" };

    const healthyEmpty = await json(await ownerPost(fixture, "/api/owner/period-closes/read", period));
    assert.equal(healthyEmpty.response.status, 200);
    assert.deepEqual(healthyEmpty.body.period_closes, []);
    assert.equal(healthyEmpty.body.unavailable, false);

    const incomplete = await json(await ownerPost(fixture, "/api/owner/period-closes/accept", {
      ...period, request_id: "close-without-ack",
    }));
    assert.equal(incomplete.response.status, 409);
    assert.equal(incomplete.body.code, "incomplete_evidence");
    assert.equal(fixture.first("SELECT count(*) AS n FROM fin_period_closes").n, 0);

    const acceptedBody = {
      ...period, request_id: "close-lost-response", acknowledge_incomplete: true,
      note: "Owner accepts the documented gaps.",
    };
    const lost = await ownerPost(fixture, "/api/owner/period-closes/accept", acceptedBody);
    assert.equal(lost.status, 201);
    const replay = await json(await ownerPost(fixture, "/api/owner/period-closes/accept", acceptedBody));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.period_close.evidence_state, "owner_acknowledged_incomplete");
    assert.equal(replay.body.period_close.acknowledged_incomplete, true);
    assert.equal(fixture.first("SELECT count(*) AS n FROM fin_period_closes").n, 1);
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_activity_events WHERE request_id='close-lost-response'").n, 1);

    const reopened = await json(await ownerPost(fixture, "/api/owner/period-closes/reopen", {
      ...period, request_id: "reopen-close", note: "More records arrived.",
    }));
    assert.equal(reopened.response.status, 200);
    assert.equal(reopened.body.period_close.status, "reopened");
    assert.equal(reopened.body.period_close.evidence_state, "owner_acknowledged_incomplete");

    fixture.control.failOn = /FROM fin_accounts/;
    const unavailable = await json(await ownerPost(fixture, "/api/owner/period-closes/accept", {
      ...period, request_id: "unavailable-evidence", acknowledge_incomplete: true,
    }));
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.code, "period_evidence_unavailable");
    assert.equal(fixture.first("SELECT count(*) AS n FROM fin_period_closes").n, 1);
  } finally {
    fixture.close();
  }
});

test("activity, targets, and preferences distinguish healthy empty from unavailable", async () => {
  const fixture = await createProductFixture();
  try {
    seedOwnedEntity(fixture, ENTITY, "Mesa Coffee");
    seedCounterparty(fixture, "fixture-buyer");

    for (const [path, key] of [
      ["/api/owner/activity", "activity_events"],
      ["/api/owner/targets/read", "targets"],
      ["/api/owner/preferences/read", "preferences"],
    ]) {
      const body = path.includes("preferences") || path.includes("activity") ? {} : { entity_slug: ENTITY };
      const empty = await json(await ownerPost(fixture, path, body));
      assert.equal(empty.response.status, 200);
      assert.deepEqual(empty.body[key], []);
      assert.equal(empty.body.unavailable, false);
      assert.deepEqual(empty.body.sections_unavailable, []);
    }

    const targetBody = {
      request_id: "target-upsert", entity_slug: ENTITY, target_id: "reserve-2026",
      label: "Cash reserve", metric: "cash_reserve", target_minor: 250_000,
      currency: "USD", period_end: "2026-12-31",
    };
    const target = await json(await ownerPost(fixture, "/api/owner/targets/upsert", targetBody));
    assert.equal(target.response.status, 201);
    assert.equal(target.body.target.status, "active");
    const targetReplay = await json(await ownerPost(fixture, "/api/owner/targets/upsert", targetBody));
    assert.equal(targetReplay.body.replayed, true);
    const unsafeInteger = await json(await ownerPost(fixture, "/api/owner/targets/upsert", {
      ...targetBody, request_id: "unsafe-target", target_minor: Number.MAX_SAFE_INTEGER + 1,
    }));
    assert.equal(unsafeInteger.response.status, 400);
    assert.equal(unsafeInteger.body.code, "invalid_target_minor");
    const archived = await json(await ownerPost(fixture, "/api/owner/targets/archive", {
      request_id: "archive-target", entity_slug: ENTITY, target_id: "reserve-2026",
    }));
    assert.equal(archived.response.status, 200);
    assert.equal(archived.body.target.status, "archived");
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_targets WHERE target_id='reserve-2026'").n, 1);

    const preferenceCases = [
      { request_id: "pref-default", preference_key: "default_entity", value: ENTITY },
      { request_id: "pref-currency", preference_key: "display_currency", value: "usd" },
      { request_id: "pref-window", preference_key: "activity_window_days", value: 30 },
      { request_id: "pref-fiscal", entity_slug: ENTITY, preference_key: "fiscal_year_start_month", value: 7 },
    ];
    for (const body of preferenceCases) {
      const written = await json(await ownerPost(fixture, "/api/owner/preferences/set", body));
      assert.ok([200, 201].includes(written.response.status));
      const replayed = await json(await ownerPost(fixture, "/api/owner/preferences/set", body));
      assert.equal(replayed.body.replayed, true);
    }
    assert.equal(fixture.first("SELECT count(*) AS n FROM owner_preferences").n, 4);

    const forbiddenPreference = await json(await ownerPost(fixture, "/api/owner/preferences/set", {
      request_id: "pref-counterparty", preference_key: "default_entity", value: "fixture-buyer",
    }));
    assert.equal(forbiddenPreference.response.status, 403);
    assert.equal(forbiddenPreference.body.code, "entity_not_owned");

    fixture.control.failOn = /FROM owner_activity_events/;
    const unavailable = await json(await ownerPost(fixture, "/api/owner/activity", {}));
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.code, "activity_unavailable");
    assert.equal(unavailable.body.unavailable, true);
    assert.deepEqual(unavailable.body.sections_unavailable, ["activity_events"]);
    assert.equal("activity_events" in unavailable.body, false, "unavailable is not encoded as an empty list");
  } finally {
    fixture.close();
  }
});
