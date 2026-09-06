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
  consumeChallenge, consumeEnrollmentCode, recordPasskeyUse, revokePasskey, sha256Hex,
} from "../src/lib/auth-store.js";
import { handleOwnerAuth } from "../src/lib/owner-auth.js";
import { makeCredential, signAssertion, clientData, attestationObject } from "./webauthn-fixtures.mjs";

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
    async exec() {},
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() {
          if (/INSERT INTO public_request_quotas/.test(sql)) return { request_count: 1 };
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
            if (row && row.purpose === bound[1] && Number(row.expires_at) > Number(bound[2])) {
              tables.challenges.delete(bound[0]);
              changes = 1;
            }
          }
          else if (/INSERT INTO enrollment_codes/.test(sql)) tables.codes.set(bound[0], {
            expires_at: bound[1], used_at: null,
            grant_id: bound[2] ?? null, document_grant_id: bound[3] ?? null,
          });
          else if (/INSERT INTO owner_passkeys/.test(sql)) {
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
            const row = conditionalRevoke ? tables.passkeys.get(bound[3]) : null;
            const anotherOwner = conditionalRevoke && [...tables.passkeys.values()].some((candidate) =>
              candidate.credential_id !== bound[3] && candidate.grant_id == null && candidate.document_grant_id == null);
            const safe = !conditionalRevoke || (row &&
              (row.grant_id != null || row.document_grant_id != null || anotherOwner));
            if (safe && !tables.activity.some((event) => event.event_id === bound[0])) {
              tables.activity.push({
                event_id: bound[0],
                event_type: conditionalRevoke ? "passkey_revoked" : bound[3],
                subject_id: conditionalRevoke ? bound[1] : bound[6],
                display_label: conditionalRevoke ? (row.nickname || "Passkey device") : bound[7],
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
    BRAIN_VERSION: "0.2.0",
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
  const optionResponse = await worker.fetch(post("/auth/register/options", { code }), testEnv);
  assert.match(optionResponse.headers.get("Cache-Control") || "", /no-store/);
  const options = await optionResponse.json();
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

  // The session opens owner retrieval but never substitutes for the admin key.
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

  const updateRequest = post("/api/app/update-status", {}, { Cookie: cookie, "X-Brain-App": "1" });
  const updateResponse = await handleOwnerAuth(
    testEnv, updateRequest, new URL(updateRequest.url), "/api/app/update-status", {
      fetchImpl: async () => new Response(JSON.stringify({
        schema_version: 1,
        channel: "stable",
        release: "0.3.0",
        published_at: "2026-08-30",
        update_url: "https://financialbrain.ai/update",
        claude_prompt: "Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain.",
        installer: {
          url: "https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v0.3.0/brain-installer-0.3.0.tgz",
          sha256: "a".repeat(64),
          bytes: 4_000_000,
        },
        changes: ["A reviewed synthetic change."],
        released_connectors: ["A reviewed synthetic connector."],
        proof: { automated_release_suite: "passed", live_client_acceptance: "required" },
      })),
    },
  );
  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json();
  assert.equal(updateBody.status, "update_available");
  assert.equal(updateBody.installed_version, "0.2.0");
  assert.equal(updateBody.latest_version, "0.3.0");
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
