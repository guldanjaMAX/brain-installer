/** Owner workspace contracts against the real 0019 SQLite schema. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "../../brain.mjs";
import worker from "../src/index.js";
import { handleOwnerActions, recordOwnerActivity } from "../src/lib/owner-actions.js";
import { mintSessionCookie } from "../src/lib/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();

let failed = 0;
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  ${String(detail).slice(0, 500)}`}`);
  if (!condition) failed++;
};

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
  }
  db.exec(`
    INSERT INTO install_state (id,client_slug,product_version,installed_at)
    VALUES (1,'fixture','0.0.0-test','2026-01-01T00:00:00.000Z');
    INSERT INTO fin_entities
      (tenant_id,entity_slug,legal_name,display_label,kind,status,relationship,
       provenance,basis_state,recorded_at)
    VALUES
      ('primary','acme','Acme Fixture LLC','Acme','business','active','owned',
       'owner_stated','confirmed','2026-01-01T00:00:00.000Z'),
      ('primary','buyer','Buyer Fixture LLC','Buyer','business','active','counterparty',
       'owner_stated','confirmed','2026-01-01T00:00:00.000Z');
  `);
  return db;
}

function d1Environment(db) {
  const statement = (sql, params = []) => {
    const shaped = {
      __sql: sql,
      __params: params,
      bind: (...next) => statement(sql, next),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes || 0) } };
      },
    };
    return shaped;
  };
  return {
    STORAGE: "d1",
    ADMIN_KEY: "fixture-admin-key",
    SESSION_SIGNING_KEY: "fixture-session-signing-key-0123456789",
    CREDENTIAL_SCANNER: "on",
    DB: {
      prepare: (sql) => statement(sql),
      batch: async (statements) => {
        const results = [];
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const item of statements) {
            const prepared = db.prepare(item.__sql);
            if (prepared.columns().length > 0) {
              results.push({ results: prepared.all(...item.__params), meta: { changes: 0 } });
            } else {
              const result = prepared.run(...item.__params);
              results.push({ meta: { changes: Number(result.changes || 0) } });
            }
          }
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    // Presence identifies the D1 backend. Ingest only queues vectors; it does
    // not call the provider.
    VECTORIZE: {},
  };
}

const post = (path, body, headers = {}) => new Request(`https://brain.invalid${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body ?? {}),
});

async function ownerHeaders(env) {
  const cookie = await mintSessionCookie(env, 1);
  return { Cookie: cookie.split(";")[0], "X-Brain-App": "1" };
}

const bodyOf = (response) => response.json();
const keysAre = (value, expected) =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

const db = freshDb();
const env = d1Environment(db);
const headers = await ownerHeaders(env);
const commonIngest = (envelope) => worker.fetch(post(
  "/api/admin/brain/ingest", envelope, { "X-Admin-Key": env.ADMIN_KEY },
), env, { waitUntil() {} });
const call = (path, body, options = {}) => handleOwnerActions(
  env, post(path, body, headers), path, { ingestEnvelope: commonIngest, ...options },
);

/* ------------------------------------------------ auth and declared upload limits */
{
  const unauthorised = await handleOwnerActions(
    env, post("/api/owner/uploads/capabilities", {}),
    "/api/owner/uploads/capabilities", { ingestEnvelope: commonIngest },
  );
  check("owner routes require a passkey session and app header", unauthorised.status === 401);

  const capabilities = await bodyOf(await call("/api/owner/uploads/capabilities", {}));
  check("capabilities declare exact text-only MIME types",
    JSON.stringify(capabilities.supported_media_types) === JSON.stringify(["text/plain", "text/markdown"]));
  check("capabilities declare the exact UTF-8 content cap", capabilities.max_content_bytes === 1_000_000);

  const binary = await call("/api/owner/uploads", {
    request_id: "binary_1", document_id: "statement_1", entity_slug: "acme",
    media_type: "application/pdf", file_name: "statement.pdf", envelope: { content: "%PDF" },
  });
  const binaryBody = await bodyOf(binary);
  check("PDF is an explicit unsupported-media outcome", binary.status === 415 && binaryBody.unsupported_media === true);

  const clientIdentity = await call("/api/owner/uploads", {
    request_id: "identity_1", document_id: "note_1", entity_slug: "acme",
    media_type: "text/plain", file_name: "note.txt",
    envelope: { source_type: "upload", source_id: "identity_1", content: "fixture" },
  });
  check("client-supplied corpus identity is refused", clientIdentity.status === 400 &&
    (await bodyOf(clientIdentity)).code === "server_owned_document_identity");
}

/* ---------------- upload commits, response disappears, and retry recovers */
const uploadBody = {
  request_id: "upload_retry_1",
  document_id: "budget_note",
  entity_slug: "acme",
  media_type: "text/plain",
  file_name: "budget.txt",
  envelope: { title: "Budget note", content: "Fixture budget evidence for the scoped search." },
};
{
  const lost = await call("/api/owner/uploads", uploadBody, {
    afterIngest: async () => { throw new Error("drop response after ingest commit"); },
  });
  check("failure injection lands after common ingest", lost.status === 503 &&
    (await bodyOf(lost)).code === "owner_upload_finalize_unavailable");
  check("the common document committed before the simulated loss",
    db.prepare("SELECT count(*) n FROM documents WHERE doc_uid=?").get("upload:owner:acme:budget_note").n === 1);
  check("no human event was partially committed", db.prepare("SELECT count(*) n FROM owner_activity_events").get().n === 0);
  const pending = JSON.parse(db.prepare(
    "SELECT response_json FROM owner_action_requests WHERE request_id='upload_retry_1'"
  ).get().response_json);
  check("a bounded pending intent survives the lost response", pending.pending === true && pending.intended_action === "created");

  const recovered = await call("/api/owner/uploads", uploadBody);
  const recoveredBody = await bodyOf(recovered);
  check("retry recovers the original created action", recovered.status === 200 &&
    recoveredBody.document.action === "created" && recoveredBody.replayed === true);
  check("upload receipt has the exact frozen keys", keysAre(recoveredBody, [
    "uploaded", "request_id", "document_id", "entity_scope", "media_type", "file_name",
    "document", "changed", "activity_event_id", "replayed",
  ]), JSON.stringify(recoveredBody));
  check("recovered upload has exactly one human event",
    db.prepare("SELECT count(*) n FROM owner_activity_events WHERE event_type='upload_completed'").get().n === 1);

  const replay = await call("/api/owner/uploads", uploadBody);
  const replayBody = await bodyOf(replay);
  check("completed retry returns one replayable receipt", replay.status === 200 && replayBody.replayed === true &&
    replayBody.document.action === "created");
  check("completed retry never duplicates its event",
    db.prepare("SELECT count(*) n FROM owner_activity_events WHERE event_type='upload_completed'").get().n === 1);

  const conflict = await call("/api/owner/uploads", {
    ...uploadBody, envelope: { ...uploadBody.envelope, content: "different fixture content" },
  });
  check("request_id reuse with a different body conflicts", conflict.status === 409 &&
    (await bodyOf(conflict)).code === "request_id_conflict");

  const unchanged = await bodyOf(await call("/api/owner/uploads", {
    ...uploadBody, request_id: "upload_unchanged_2",
  }));
  check("new request for identical stable document is a true no-op",
    unchanged.document.action === "unchanged" && unchanged.changed === false && unchanged.activity_event_id === null);
  check("unchanged upload does not create a false event",
    db.prepare("SELECT count(*) n FROM owner_activity_events WHERE event_type='upload_completed'").get().n === 1);

  const rejectedRequestId = "upload_rejected_credential";
  const rejected = await call("/api/owner/uploads", {
    ...uploadBody,
    request_id: rejectedRequestId,
    document_id: "credential_fixture",
    envelope: { content: `Fixture credential sk-proj-${"A7".repeat(16)}` },
  });
  check("credential scanner rejection is preserved", rejected.status === 422);
  check("credential scanner rejection leaves no receipt or event",
    db.prepare("SELECT count(*) n FROM owner_action_requests WHERE request_id=?").get(rejectedRequestId).n === 0 &&
    db.prepare("SELECT count(*) n FROM owner_activity_events WHERE request_id=?").get(rejectedRequestId).n === 0);

  const document = db.prepare("SELECT entity_slug,client FROM documents WHERE doc_uid=?").get(
    "upload:owner:acme:budget_note",
  );
  check("owner upload binds authoritative document and vector candidate scope",
    document.entity_slug === "acme" && document.client === "acme", JSON.stringify(document));
}

/* ------------------------------------------- exact entity-scoped retrieval */
{
  db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,client,ingested_at,content_hash,meta)
     VALUES ('upload:legacy','upload','legacy','Legacy budget','acme',1,?1,'{}')`
  ).run("a".repeat(64));
  db.prepare(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,client)
     VALUES ('upload:legacy#0','upload:legacy',0,'Fixture budget legacy text','upload','Legacy budget','acme')`
  ).run();
  db.prepare(
    `INSERT INTO documents
       (doc_uid,source,source_id,title,entity_slug,client,ingested_at,content_hash,meta)
     VALUES ('upload:mapped-legacy','upload','mapped-legacy','Mapped legacy','acme','old-label',1,?1,'{}')`
  ).run("b".repeat(64));
  db.prepare(
    `INSERT INTO chunks
       (chunk_uid,doc_uid,chunk_ix,text,source,title,client)
     VALUES ('upload:mapped-legacy#0','upload:mapped-legacy',0,
       'MappedLegacyToken authoritative evidence','upload','Mapped legacy','old-label')`
  ).run();
  const scoped = await worker.fetch(post("/api/rag/unified", {
    q: "Fixture budget", entity_slug: "acme", limit: 10,
  }, headers), env, { waitUntil() {} });
  const scopedBody = await bodyOf(scoped);
  check("scoped retrieval echoes an applied business scope", scoped.status === 200 &&
    scopedBody.entity_scope?.entity_slug === "acme" && scopedBody.entity_scope?.applied === true);
  check("legacy client labels cannot enter authoritative entity scope",
    scopedBody.results.length > 0 && scopedBody.results.every((row) => row.entity_slug === "acme"),
    JSON.stringify(scopedBody.results));
  const mapped = await worker.fetch(post("/api/rag/unified", {
    q: "MappedLegacyToken", entity_slug: "acme", limit: 10,
  }, headers), env, { waitUntil() {} });
  const mappedBody = await bodyOf(mapped);
  check("authoritative entity mapping does not require legacy client equality",
    mappedBody.results.some((row) => row.doc_uid === "upload:mapped-legacy") &&
    mappedBody.degraded === "vector" &&
    mappedBody.degraded_reason === "entity-vector-authority-unindexed",
    JSON.stringify(mappedBody));

  const counterparty = await worker.fetch(post("/api/rag/unified", {
    q: "Fixture", entity_slug: "buyer",
  }, headers), env, { waitUntil() {} });
  check("counterparty scope is refused before search", counterparty.status === 403 &&
    (await bodyOf(counterparty)).code === "entity_not_owned");
}

/* -------------------------------- approvals mutate the served ledger state */
{
  db.exec(`
    INSERT INTO fin_reconciliations
      (tenant_id,reconciliation_uid,entity_slug,period_start,period_end,measure,state,
       delta_minor,tolerance_minor,currency,computed_at,recorded_at)
    VALUES ('primary','recon_1','acme','2026-01-01','2026-01-31','closing_balance',
      'mismatched',100,0,'USD','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z');
    INSERT INTO fin_reconciliation_claims
      (tenant_id,claim_uid,reconciliation_uid,label,amount_minor,currency,as_of,
       provenance,basis_state,recorded_at)
    VALUES
      ('primary','claim_a','recon_1','Bank statement',1000,'USD','2026-01-31',
       'owner_stated','confirmed','2026-02-01T00:00:00.000Z'),
      ('primary','claim_b','recon_1','Book balance',1100,'USD','2026-01-31',
       'owner_stated','confirmed','2026-02-01T00:00:00.000Z');
    INSERT INTO fin_exceptions
      (tenant_id,exception_uid,entity_slug,kind,issue,first_seen,provenance,basis_state,recorded_at)
    VALUES ('primary','exception_1','acme','other','Fixture exception','2026-02-01',
      'owner_stated','confirmed','2026-02-01T00:00:00.000Z');
  `);
  const ruling = await bodyOf(await call("/api/owner/approvals", {
    request_id: "approval_recon_1", entity_slug: "acme",
    approval_type: "reconciliation_ruling", subject_uid: "recon_1",
    selected_claim_uid: "claim_a", note: "Use the statement",
  }));
  check("approval receipt uses the common write envelope", keysAre(ruling, [
    "request_id", "entity_scope", "approval", "changed", "activity_event_id", "replayed",
  ]), JSON.stringify(ruling));
  const servedReconciliation = db.prepare(
    "SELECT ruled_claim_uid,ruled_by_party,ruling_consumed FROM fin_reconciliations WHERE reconciliation_uid='recon_1'"
  ).get();
  check("reconciliation approval updates the state served to the UI",
    servedReconciliation.ruled_claim_uid === "claim_a" &&
    servedReconciliation.ruled_by_party === "owner" && servedReconciliation.ruling_consumed === 0);

  await call("/api/owner/approvals", {
    request_id: "approval_exception_1", entity_slug: "acme",
    approval_type: "exception_resolution", subject_uid: "exception_1",
    resolution: "Fixture resolved",
  });
  const servedException = db.prepare(
    "SELECT resolution,resolved_by_party FROM fin_exceptions WHERE exception_uid='exception_1'"
  ).get();
  check("exception approval updates the state served to the UI",
    servedException.resolution === "Fixture resolved" && servedException.resolved_by_party === "owner");
}

/* ------------------------------- period status and evidence are orthogonal */
{
  const incomplete = await bodyOf(await call("/api/owner/period-closes/accept", {
    request_id: "close_incomplete_1", entity_slug: "acme",
    period_start: "2026-03-01", period_end: "2026-03-31", acknowledge_incomplete: true,
  }));
  check("an acknowledged incomplete period is still accepted",
    incomplete.period_close.status === "accepted" &&
    incomplete.period_close.evidence_state === "owner_acknowledged_incomplete");
  check("period response uses period_close_id, not close_id",
    Boolean(incomplete.period_close.period_close_id) && !("close_id" in incomplete.period_close));

  await call("/api/owner/period-closes/reopen", {
    request_id: "close_reopen_1", entity_slug: "acme",
    period_start: "2026-03-01", period_end: "2026-03-31",
  });
  db.exec(`
    INSERT INTO fin_accounts
      (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,currency,
       feed_mode,status,provenance,basis_state,recorded_at)
    VALUES ('primary','checking_1','acme','Checking','checking','asset','USD','manual','open',
      'owner_stated','confirmed','2026-04-01T00:00:00.000Z');
    INSERT INTO fin_statements
      (tenant_id,statement_uid,account_slug,period_start,period_end,closing_balance_minor,
       currency,parse_state,provenance,basis_state,recorded_at)
    VALUES ('primary','statement_march','checking_1','2026-03-01','2026-03-31',1000,
      'USD','parsed','owner_stated','confirmed','2026-04-01T00:00:00.000Z');
    INSERT INTO fin_reconciliations
      (tenant_id,reconciliation_uid,entity_slug,account_slug,period_start,period_end,measure,
       state,delta_minor,tolerance_minor,currency,computed_at,recorded_at)
    VALUES ('primary','recon_march','acme','checking_1','2026-03-01','2026-03-31',
      'closing_balance','matched',0,0,'USD','2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z');
  `);
  const complete = await bodyOf(await call("/api/owner/period-closes/accept", {
    request_id: "close_complete_2", entity_slug: "acme",
    period_start: "2026-03-01", period_end: "2026-03-31",
  }));
  check("re-accept derives evidence state from current evidence",
    complete.period_close.status === "accepted" && complete.period_close.evidence_state === "complete",
    JSON.stringify(complete));
}

/* -------------------------------------- no-op writes are not false activity */
{
  const firstTarget = await bodyOf(await call("/api/owner/targets/upsert", {
    request_id: "target_set_1", entity_slug: "acme", target_id: "reserve",
    label: "Cash reserve", metric: "cash_reserve", target_minor: 500000, currency: "USD",
  }));
  const eventsAfterTarget = db.prepare("SELECT count(*) n FROM owner_activity_events").get().n;
  const sameTarget = await bodyOf(await call("/api/owner/targets/upsert", {
    request_id: "target_set_2", entity_slug: "acme", target_id: "reserve",
    label: "Cash reserve", metric: "cash_reserve", target_minor: 500000, currency: "USD",
  }));
  check("identical target upsert is unchanged with no activity", firstTarget.changed === true &&
    sameTarget.changed === false && sameTarget.activity_event_id === null &&
    db.prepare("SELECT count(*) n FROM owner_activity_events").get().n === eventsAfterTarget);

  const firstArchive = await bodyOf(await call("/api/owner/targets/archive", {
    request_id: "target_archive_1", entity_slug: "acme", target_id: "reserve",
  }));
  const eventsAfterArchive = db.prepare("SELECT count(*) n FROM owner_activity_events").get().n;
  const sameArchive = await bodyOf(await call("/api/owner/targets/archive", {
    request_id: "target_archive_2", entity_slug: "acme", target_id: "reserve",
  }));
  check("already archived target is unchanged with no activity", firstArchive.changed === true &&
    sameArchive.changed === false &&
    db.prepare("SELECT count(*) n FROM owner_activity_events").get().n === eventsAfterArchive);

  const firstPreference = await bodyOf(await call("/api/owner/preferences/set", {
    request_id: "preference_1", preference_key: "activity_window_days", value: 30,
  }));
  const eventsAfterPreference = db.prepare("SELECT count(*) n FROM owner_activity_events").get().n;
  const samePreference = await bodyOf(await call("/api/owner/preferences/set", {
    request_id: "preference_2", preference_key: "activity_window_days", value: 30,
  }));
  check("identical preference is unchanged with no activity", firstPreference.changed === true &&
    samePreference.changed === false &&
    db.prepare("SELECT count(*) n FROM owner_activity_events").get().n === eventsAfterPreference);

  await recordOwnerActivity(env, {
    eventId: "activity_security_invite_1",
    eventType: "document_grant_invite_reissued",
    entitySlug: "acme",
    subjectKind: "document_grant",
    subjectId: "grant_fixture",
    displayLabel: "Document access invite reissued",
    requestId: "security_invite_1",
    occurredAt: "2026-04-02T00:00:00.000Z",
  });
  check("shared security activity vocabulary accepts invite reissue",
    db.prepare("SELECT event_type FROM owner_activity_events WHERE event_id=?").get(
      "activity_security_invite_1",
    )?.event_type === "document_grant_invite_reissued");

  const activity = await bodyOf(await call("/api/owner/activity", { entity_slug: "acme", limit: 200 }));
  check("activity rows use event_type and never the stale type key",
    activity.activity_events.length > 0 && activity.activity_events.every((event) =>
      typeof event.event_type === "string" && !("type" in event)));
  check("activity read has exact availability and scope keys", keysAre(activity, [
    "entity_scope", "activity_events", "truncated", "next_cursor", "unavailable", "sections_unavailable",
  ]), JSON.stringify(activity));
}

/* ------------------------------------------------ append-only SQL authority */
{
  let activityUpdateRefused = false;
  let approvalDeleteRefused = false;
  try { db.exec("UPDATE owner_activity_events SET display_label='rewritten'"); }
  catch { activityUpdateRefused = true; }
  try { db.exec("DELETE FROM owner_approvals"); }
  catch { approvalDeleteRefused = true; }
  check("activity history refuses UPDATE", activityUpdateRefused);
  check("approval history refuses DELETE", approvalDeleteRefused);
}

console.log(`\nowner actions: ${ran - failed}/${ran} checks passed`);
process.exit(failed ? 1 : 0);
