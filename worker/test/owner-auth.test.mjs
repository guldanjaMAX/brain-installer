/**
 * owner-auth end-to-end: invite -> enroll -> sign in -> use -> manage, driven
 * through the worker's real fetch handler against a stateful in-memory D1.
 * The passkey material is really generated and really signed (fixtures), so
 * every gate in the chain is exercised by the genuine article.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { mintSessionCookie } from "../src/lib/sessions.js";
import {
  assignZone, consumeChallenge, consumeEnrollmentCode, recordPasskeyUse, revokePasskey, sha256Hex,
} from "../src/lib/auth-store.js";
import { makeCredential, signAssertion, clientData, attestationObject } from "./webauthn-fixtures.mjs";
import { createProductFixture } from "./product-contract-fixture.mjs";

const ORIGIN = "https://brain.example.com";
const RP = "brain.example.com";

/** A tiny stateful D1 speaking exactly the SQL auth-store uses. */
function authDb() {
  const tables = {
    challenges: new Map(), codes: new Map(), passkeys: new Map(), activity: [],
    security: [],
    state: { session_generation: 1 },
  };
  let batchTail = Promise.resolve();
  return {
    tables,
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() {
          if (/UPDATE enrollment_codes SET used_at/.test(sql)) {
            const row = tables.codes.get(bound[1]);
            if (!row || row.used_at || Number(row.expires_at) <= Number(bound[2])) return null;
            row.used_at = bound[0];
            return { grant_id: row.grant_id ?? null, document_grant_id: row.document_grant_id ?? null };
          }
          if (/FROM auth_challenges/.test(sql)) {
            const row = tables.challenges.get(bound[0]);
            return row && row.purpose === bound[1] && Number(row.expires_at) > Number(bound[2])
              ? { valid: 1 } : null;
          }
          if (/FROM enrollment_codes/.test(sql)) return tables.codes.get(bound[0]) || null;
          if (/FROM owner_passkeys WHERE credential_id/.test(sql)) return tables.passkeys.get(bound[0]) || null;
          if (/count\(\*\) AS n FROM owner_passkeys/.test(sql)) return { n: tables.passkeys.size };
          if (/session_generation FROM install_state/.test(sql)) return { session_generation: tables.state.session_generation };
          return null;
        },
        async all() {
          if (/FROM owner_passkeys ORDER BY/.test(sql)) return { results: [...tables.passkeys.values()] };
          return { results: [] };
        },
        async run() {
          let changes = 0;
          if (/INSERT INTO auth_challenges/.test(sql)) {
            tables.challenges.set(bound[0], { purpose: bound[1], expires_at: bound[2] });
            changes = 1;
          } else if (/DELETE FROM auth_challenges/.test(sql)) {
            const row = tables.challenges.get(bound[0]);
            const literalRegister = /purpose = 'register'/.test(sql);
            const purpose = literalRegister ? "register" : bound[1];
            const expiresAt = literalRegister ? bound[1] : bound[2];
            if (row && row.purpose === purpose && Number(row.expires_at) > Number(expiresAt)) {
              tables.challenges.delete(bound[0]);
              changes = 1;
            }
          }
          else if (/INSERT INTO enrollment_codes/.test(sql)) tables.codes.set(bound[0], {
            expires_at: bound[1], used_at: null,
            grant_id: bound[2] ?? null, document_grant_id: bound[3] ?? null,
          });
          else if (/UPDATE enrollment_codes SET used_at/.test(sql)) {
            const row = tables.codes.get(bound[1]);
            const challenge = tables.challenges.get(bound[5]);
            if (row && !row.used_at && Number(row.expires_at) > Number(bound[2]) &&
                row.grant_id == bound[3] && row.document_grant_id == bound[4] &&
                challenge && challenge.purpose === "register" &&
                Number(challenge.expires_at) > Number(bound[6])) {
              row.used_at = bound[0]; changes = 1;
            }
          } else if (/INSERT INTO owner_passkeys/.test(sql)) {
            tables.passkeys.set(bound[0], {
              credential_id: bound[0], public_key_jwk: bound[1], alg: bound[2],
              sign_count: bound[3], nickname: bound[4], created_at: bound[5], last_used_at: null,
              grant_id: bound[6] ?? null, document_grant_id: bound[7] ?? null,
            });
            changes = 1;
          } else if (/UPDATE owner_passkeys SET sign_count/.test(sql)) {
            const row = tables.passkeys.get(bound[2]);
            if (row && Number(row.sign_count) === Number(bound[3])) {
              row.sign_count = bound[0]; row.last_used_at = bound[1]; changes = 1;
            }
          } else if (/UPDATE owner_passkeys SET nickname/.test(sql)) {
            const row = tables.passkeys.get(bound[1]);
            if (row) { row.nickname = bound[0]; changes = 1; }
          } else if (/DELETE FROM owner_passkeys/.test(sql)) {
            const row = tables.passkeys.get(bound[0]);
            const anotherOwner = [...tables.passkeys.values()].some((candidate) =>
              candidate.credential_id !== bound[0] && candidate.grant_id == null && candidate.document_grant_id == null);
            if (row && (row.grant_id != null || row.document_grant_id != null || anotherOwner)) {
              tables.passkeys.delete(bound[0]); changes = 1;
            }
          }
          else if (/UPDATE install_state SET session_generation/.test(sql)) tables.state.session_generation += 1;
          else if (/INSERT INTO passkey_security_events/.test(sql)) {
            const row = tables.passkeys.get(bound[10]);
            if (row && Number(row.sign_count) === Number(bound[11])) {
              tables.security.push({ event_id: bound[0], outcome: bound[5] });
              changes = 1;
            }
          }
          else if (/INSERT OR IGNORE INTO owner_activity_events/.test(sql)) {
            const conditionalRevoke = /FROM owner_passkeys p/.test(sql);
            const conditionalRegistration = /WHERE EXISTS \(\s*SELECT 1 FROM auth_challenges/.test(sql);
            const row = conditionalRevoke ? tables.passkeys.get(bound[3]) : null;
            const anotherOwner = conditionalRevoke && [...tables.passkeys.values()].some((candidate) =>
              candidate.credential_id !== bound[3] && candidate.grant_id == null && candidate.document_grant_id == null);
            const safe = !conditionalRevoke || (row &&
              (row.grant_id != null || row.document_grant_id != null || anotherOwner));
            if (safe && !tables.activity.some((event) => event.event_id === bound[0])) {
              tables.activity.push({
                event_id: bound[0],
                event_type: conditionalRevoke ? "passkey_revoked" :
                  (conditionalRegistration ? "passkey_added" : bound[3]),
                subject_id: conditionalRevoke ? bound[1] :
                  (conditionalRegistration ? bound[2] : bound[6]),
                display_label: conditionalRevoke ? (row.nickname || "Passkey device") :
                  (conditionalRegistration ? bound[3] : bound[7]),
              });
              changes = 1;
            }
          }
          return { meta: { changes } };
        },
      };
      return statement;
    },
    async batch(statements) {
      const execute = async () => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      };
      const result = batchTail.then(execute);
      batchTail = result.catch(() => {});
      return result;
    },
  };
}

function env(db) {
  return {
    STORAGE: "d1", DB: db, ADMIN_KEY: "admin-key-fixture-value-000",
    SESSION_SIGNING_KEY: "a".repeat(64), BRAIN_NAME: "fixture", BRAIN_OWNER: "Fixture Owner",
  };
}

const post = (path, payload, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(payload || {}),
});

function sessionCookie(response) {
  const header = response.headers.get("Set-Cookie") || "";
  return header.split(";")[0];
}

test("invite -> enroll -> sign in -> settings, end to end", async () => {
  const db = authDb();
  const testEnv = env(db);

  // The app page is public and carries its CSP.
  const page = await worker.fetch(new Request(ORIGIN + "/app"), testEnv);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy") || "", /connect-src 'self'/);

  // No invite, no session: enrollment options are refused.
  const refused = await worker.fetch(post("/auth/register/options", {}), testEnv);
  assert.equal(refused.status, 403);

  // Admin mints the one-time invite.
  const invite = await worker.fetch(post("/api/admin/auth/invite", {}, { "X-Admin-Key": testEnv.ADMIN_KEY }), testEnv);
  assert.equal(invite.status, 200);
  const inviteBody = await invite.json();
  const code = inviteBody.url.split("#enroll=")[1];
  assert.ok(code);

  // Enroll with a really-generated credential.
  const options = await (await worker.fetch(post("/auth/register/options", { code }), testEnv)).json();
  const credential = await makeCredential({ rpId: RP });
  const verify = await worker.fetch(post("/auth/register/verify", {
    code,
    nickname: "Morgan's phone",
    credentialId: credential.credentialId,
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
  }), testEnv);
  assert.equal(verify.status, 200);
  const enrolledCookie = sessionCookie(verify);
  assert.match(enrolledCookie, /^brain_session=v3\./, "enrollment signs the owner straight in");

  // The code is single use.
  const reuse = await worker.fetch(post("/auth/register/options", { code }), testEnv);
  assert.equal(reuse.status, 403, "a used enrollment link is dead");

  // Fresh sign-in with a really-signed assertion.
  const loginOptions = await (await worker.fetch(post("/auth/login/options", {}), testEnv)).json();
  const assertion = await signAssertion({
    pair: credential.pair, rpId: RP, challenge: loginOptions.challenge, origin: ORIGIN,
  });
  const login = await worker.fetch(post("/auth/login/verify", {
    credentialId: credential.credentialId, ...assertion,
  }), testEnv);
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);

  // A replayed assertion fails: the challenge was consumed.
  const replay = await worker.fetch(post("/auth/login/verify", {
    credentialId: credential.credentialId, ...assertion,
  }), testEnv);
  assert.equal(replay.status, 403, "challenges are single use");

  // The session is exactly the read-only privilege class.
  const think = await worker.fetch(post("/api/rag/think", { q: "hello" }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv);
  assert.notEqual(think.status, 401, "a session opens the read routes");
  const thinkNoHeader = await worker.fetch(post("/api/rag/think", { q: "hello" }, { Cookie: cookie }), testEnv);
  assert.equal(thinkNoHeader.status, 401, "the CSRF companion header is required");
  const ingest = await worker.fetch(post("/api/admin/brain/ingest", { q: "x" }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv);
  assert.equal(ingest.status, 401, "a session must never reach an admin route");

  // Settings: devices are listed. A scoped credential does not count as a
  // backup owner credential, so the last unrestricted owner cannot be revoked.
  const me = await (await worker.fetch(post("/api/app/me", {}, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.equal(me.devices.length, 1);
  assert.equal(me.devices[0].nickname, "Morgan's phone");
  const rename = await (await worker.fetch(post("/api/app/devices/rename", {
    credential_id: credential.credentialId, nickname: "Morgan's primary phone",
  }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.deepEqual(rename, { renamed: true, changed: true });
  const renameReplay = await (await worker.fetch(post("/api/app/devices/rename", {
    credential_id: credential.credentialId, nickname: "Morgan's primary phone",
  }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.deepEqual(renameReplay, { renamed: true, changed: false });
  db.tables.passkeys.set("scoped-passkey", {
    credential_id: "scoped-passkey", public_key_jwk: "{}", alg: -7,
    sign_count: 0, nickname: "Shared document", created_at: Date.now(),
    last_used_at: null, grant_id: null, document_grant_id: "dg_fixture",
  });
  const lastRevoke = await (await worker.fetch(post("/api/app/devices/revoke", {
    credential_id: credential.credentialId,
  }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.equal(lastRevoke.removed, false, "a scoped passkey cannot disguise an owner lockout");

  // With a second passkey present, revocation succeeds and its owner-facing
  // activity uses only a digest-backed subject id, never the credential id.
  db.tables.passkeys.set("backup-passkey", {
    credential_id: "backup-passkey", public_key_jwk: "{}", alg: -7,
    sign_count: 0, nickname: "Backup device", created_at: Date.now(),
    last_used_at: null, grant_id: null, document_grant_id: null,
  });
  const backupCookie = (await mintSessionCookie(testEnv, 1, {
    grantId: null, credentialId: "backup-passkey",
  })).split(";")[0];
  const removed = await (await worker.fetch(post("/api/app/devices/revoke", {
    credential_id: credential.credentialId,
  }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.equal(removed.removed, true);
  const afterDeviceRevoke = await worker.fetch(post("/api/app/me", {}, {
    Cookie: cookie, "X-Brain-App": "1",
  }), testEnv);
  assert.equal(afterDeviceRevoke.status, 401, "revoking a passkey immediately kills its bound sessions");

  // Sign out everywhere invalidates every cookie ever minted.
  const signoutAll = await worker.fetch(post("/api/app/signout-all", {}, {
    Cookie: backupCookie, "X-Brain-App": "1",
  }), testEnv);
  assert.equal(signoutAll.status, 200);
  const afterBump = await worker.fetch(post("/api/app/me", {}, { Cookie: backupCookie, "X-Brain-App": "1" }), testEnv);
  assert.equal(afterBump.status, 401, "generation bump kills old sessions");
  assert.deepEqual(
    db.tables.activity.map((event) => event.event_type),
    ["passkey_added", "passkey_renamed", "passkey_revoked", "sessions_revoked"],
    "human-visible security changes are recorded once without low-level ceremony telemetry",
  );
  assert.equal(JSON.stringify(db.tables.activity).includes(credential.credentialId), false);
});

test("an expired or foreign enrollment code never enrolls", async () => {
  const db = authDb();
  const testEnv = env(db);
  const forged = await worker.fetch(post("/auth/register/options", { code: "made-up-code" }), testEnv);
  assert.equal(forged.status, 403);

  const invite = await (await worker.fetch(post("/api/admin/auth/invite", {}, { "X-Admin-Key": testEnv.ADMIN_KEY }), testEnv)).json();
  const code = invite.url.split("#enroll=")[1];
  for (const row of db.tables.codes.values()) row.expires_at = Date.now() - 1;
  const expired = await worker.fetch(post("/auth/register/options", { code }), testEnv);
  assert.equal(expired.status, 403, "an expired invite is dead");
});

test("failed registration crypto burns neither the challenge nor the invite", async () => {
  const db = authDb();
  const testEnv = env(db);
  const invite = await (await worker.fetch(post("/api/admin/auth/invite", {}, {
    "X-Admin-Key": testEnv.ADMIN_KEY,
  }), testEnv)).json();
  const code = invite.url.split("#enroll=")[1];
  const options = await (await worker.fetch(post("/auth/register/options", { code }), testEnv)).json();
  const credential = await makeCredential({ rpId: RP });
  const payload = {
    code,
    nickname: "Retry device",
    credentialId: credential.credentialId,
    clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
  };

  const failed = await worker.fetch(post("/auth/register/verify", {
    ...payload, attestationObject: "not-an-attestation",
  }), testEnv);
  assert.equal(failed.status, 400);

  const retry = await worker.fetch(post("/auth/register/verify", {
    ...payload, attestationObject: attestationObject(credential.authData),
  }), testEnv);
  assert.equal(retry.status, 200, "a valid retry can still consume both single-use values");
});

test("real SQLite rolls back challenge and invite when passkey storage fails", async (t) => {
  const fixture = await createProductFixture({
    env: { BRAIN_NAME: "fixture", BRAIN_OWNER: "Fixture Owner" },
  });
  t.after(() => fixture.close());
  const invite = await (await fixture.post("/api/admin/auth/invite", {}, {
    "X-Admin-Key": fixture.env.ADMIN_KEY,
  })).json();
  const code = invite.url.split("#enroll=")[1];
  const options = await (await fixture.post("/auth/register/options", { code })).json();
  const credential = await makeCredential({ rpId: "brain.invalid" });
  const payload = {
    code,
    nickname: "Atomic retry device",
    credentialId: credential.credentialId,
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", options.challenge, "https://brain.invalid"),
  };

  fixture.control.failOn = /INSERT INTO owner_passkeys/;
  const failed = await fixture.post("/auth/register/verify", payload);
  assert.equal(failed.status, 503);
  assert.equal(fixture.first(
    "SELECT used_at FROM enrollment_codes WHERE code_hash=?", await sha256Hex(code),
  ).used_at, null, "the invite rolls back with the failed passkey insert");
  assert.equal(fixture.first(
    "SELECT count(*) AS n FROM auth_challenges WHERE challenge_hash=?", await sha256Hex(options.challenge),
  ).n, 1, "the challenge rolls back with the failed passkey insert");
  assert.equal(fixture.first("SELECT count(*) AS n FROM owner_passkeys").n, 0);

  fixture.control.failOn = null;
  const retry = await fixture.post("/auth/register/verify", payload);
  assert.equal(retry.status, 200, "the exact verified ceremony remains retryable after rollback");
});

test("real SQLite grant creation rejects scope shapes that would widen on coercion", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const headers = { "X-Admin-Key": fixture.env.ADMIN_KEY };
  for (const scope of [
    { zones: "books" },
    { exclude_zones: "private" },
    { zones: ["Private"] },
    { exclude_zones: [1] },
  ]) {
    const response = await fixture.post("/api/admin/auth/grants", {
      display_name: "Malformed scope",
      capabilities: ["ask"],
      ...scope,
    }, headers);
    assert.equal(response.status, 400, JSON.stringify(scope));
  }
  assert.equal(fixture.first("SELECT count(*) AS n FROM grants").n, 0,
    "no malformed scope reaches durable grant storage");
});

test("real SQLite rolls back every denormalized zone copy when a later assignment fails", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  fixture.raw("INSERT INTO zones (zone, label, created_at) VALUES ('prior', 'Prior', 1)");
  fixture.raw(
    "INSERT INTO sources (name, kind, status, created_at, zone) VALUES ('drive-books', 'drive', 'ready', '2026-08-29T00:00:00Z', 'prior')",
  );
  fixture.raw(
    `INSERT INTO documents
       (doc_uid, source, source_id, title, ingested_at, content_hash, zone)
     VALUES ('drive-books:one', 'drive-books', 'one', 'Fixture document', 1, 'fixture-hash', 'prior')`,
  );
  fixture.raw(
    `INSERT INTO chunks (chunk_uid, doc_uid, chunk_ix, text, source, title, zone)
     VALUES ('drive-books:one:0', 'drive-books:one', 0, 'Fixture text',
             'drive-books', 'Fixture document', 'prior')`,
  );

  fixture.control.failOn = /UPDATE chunks SET zone/;
  await assert.rejects(
    assignZone(fixture.env, { source: "drive-books", zone: "replacement" }),
    /fixture database unavailable/,
  );

  assert.equal(fixture.first("SELECT zone FROM sources WHERE name='drive-books'").zone, "prior");
  assert.equal(fixture.first("SELECT zone FROM documents WHERE doc_uid='drive-books:one'").zone, "prior");
  assert.equal(fixture.first("SELECT zone FROM chunks WHERE chunk_uid='drive-books:one:0'").zone, "prior");
  assert.equal(fixture.first("SELECT count(*) AS n FROM zones WHERE zone='replacement'").n, 0,
    "the zone row rolls back with its denormalized copies");

  fixture.control.failOn = null;
  const assigned = await assignZone(fixture.env, { source: "drive-books", zone: "replacement" });
  assert.deepEqual(assigned, {
    source: "drive-books", zone: "replacement", documents: 1, chunks: 1,
  });
});

test("real SQLite inherits an assigned source zone across ingest and reingest", async (t) => {
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const admin = { "X-Admin-Key": fixture.env.ADMIN_KEY };
  fixture.raw(
    `INSERT INTO sources (name, kind, status, created_at) VALUES
       ('drive-books', 'drive', 'ready', '2026-09-05T00:00:00Z'),
       ('drive-medical', 'drive', 'ready', '2026-09-05T00:00:00Z')`,
  );
  await assignZone(fixture.env, { source: "drive-books", zone: "books" });
  await assignZone(fixture.env, { source: "drive-medical", zone: "medical" });

  const ingest = async (envelope) => {
    const response = await fixture.post("/api/admin/brain/ingest", envelope, admin);
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    return JSON.parse(responseText);
  };
  await ingest({
    source_type: "drive-books",
    source_id: "ledger",
    title: "Books ledger",
    content: "zoneanchor initial bookkeeping record",
  });
  await ingest({
    source_type: "drive-medical",
    source_id: "chart",
    title: "Medical chart",
    content: "zoneanchor revisionanchor confidential clinic record",
  });

  assert.deepEqual(
    fixture.rows("SELECT source, zone FROM documents ORDER BY source")
      .map((row) => ({ ...row })),
    [
      { source: "drive-books", zone: "books" },
      { source: "drive-medical", zone: "medical" },
    ],
  );
  assert.deepEqual(
    fixture.rows("SELECT source, zone FROM chunks ORDER BY source")
      .map((row) => ({ ...row })),
    [
      { source: "drive-books", zone: "books" },
      { source: "drive-medical", zone: "medical" },
    ],
  );

  const grantResponse = await fixture.post("/api/admin/auth/grants", {
    display_name: "Non-medical reviewer",
    capabilities: ["ask"],
    exclude_zones: ["medical"],
  }, admin);
  const grantText = await grantResponse.text();
  assert.equal(grantResponse.status, 200, grantText);
  const grant = JSON.parse(grantText);

  const scopedSearch = async (q) => {
    const response = await fixture.post("/api/rag/unified", {
      q, limit: 10, rerank: false,
    }, { "X-Admin-Key": grant.token });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    return JSON.parse(responseText);
  };
  const initial = await scopedSearch("zoneanchor");
  assert.deepEqual(initial.results.map((row) => row.source), ["drive-books"],
    "all-minus-exclude keeps a newly ingested allowed source visible");

  const reingestResponse = await fixture.post("/api/admin/brain/ingest/batch", {
    docs: [{
      source_type: "drive-books",
      source_id: "ledger",
      title: "Books ledger revised",
      content: "revisionanchor revised bookkeeping record",
    }],
  }, admin);
  const reingestText = await reingestResponse.text();
  assert.equal(reingestResponse.status, 200, reingestText);
  assert.equal(JSON.parse(reingestText).results[0].status, "updated");
  assert.equal(fixture.first(
    "SELECT zone FROM documents WHERE doc_uid='drive-books:ledger'",
  ).zone, "books");
  assert.deepEqual(fixture.rows(
    "SELECT DISTINCT zone FROM chunks WHERE doc_uid='drive-books:ledger'",
  ).map((row) => ({ ...row })), [{ zone: "books" }]);

  const revised = await scopedSearch("revisionanchor");
  assert.deepEqual(revised.results.map((row) => row.source), ["drive-books"],
    "all-minus-exclude keeps a reingested allowed source visible and excludes medical");
});

test("parallel auth consumers have exactly one winner", async () => {
  const db = authDb();
  const testEnv = env(db);

  const challenge = "parallel-challenge";
  db.tables.challenges.set(await sha256Hex(challenge), {
    purpose: "login", expires_at: Date.now() + 60_000,
  });
  const challengeResults = await Promise.all(Array.from(
    { length: 16 }, () => consumeChallenge(testEnv, challenge, "login"),
  ));
  assert.equal(challengeResults.filter(Boolean).length, 1, "one challenge consumer wins");

  const enrollment = "parallel-enrollment";
  db.tables.codes.set(await sha256Hex(enrollment), {
    expires_at: Date.now() + 60_000, used_at: null,
    grant_id: null, document_grant_id: null,
  });
  const enrollmentResults = await Promise.all(Array.from(
    { length: 16 }, () => consumeEnrollmentCode(testEnv, enrollment),
  ));
  assert.equal(enrollmentResults.filter(Boolean).length, 1, "one enrollment consumer wins");

  for (const credentialId of ["owner-a", "owner-b"]) {
    db.tables.passkeys.set(credentialId, {
      credential_id: credentialId, public_key_jwk: "{}", alg: -7,
      sign_count: 0, nickname: credentialId, created_at: Date.now(),
      last_used_at: null, grant_id: null, document_grant_id: null,
    });
  }
  const revocations = await Promise.all([
    revokePasskey(testEnv, "owner-a"), revokePasskey(testEnv, "owner-b"),
  ]);
  assert.equal(revocations.filter((result) => result.removed).length, 1,
    "two concurrent revocations leave one unrestricted owner credential");
  assert.equal(db.tables.passkeys.size, 1);
});

test("a losing passkey counter CAS cannot duplicate succeeded telemetry", async () => {
  const db = authDb();
  const testEnv = env(db);
  db.tables.passkeys.set("counter-passkey", {
    credential_id: "counter-passkey", public_key_jwk: "{}", alg: -7,
    sign_count: 7, nickname: "Counter device", created_at: Date.now(),
    last_used_at: null, grant_id: null, document_grant_id: null,
  });
  const event = {
    rpId: RP, ceremony: "authentication", stage: "verify", outcome: "succeeded",
    reasonCode: "passkey_used", principalKind: "owner", grantId: null,
  };
  const originalNow = Date.now;
  Date.now = () => 1_788_102_400_000;
  try {
    const results = await Promise.all([
      recordPasskeyUse(testEnv, "counter-passkey", 7, 8, event),
      recordPasskeyUse(testEnv, "counter-passkey", 7, 8, event),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(db.tables.security.length, 1,
      "the serialized CAS loser cannot copy the winner's same-millisecond state");
  } finally {
    Date.now = originalNow;
  }
});
