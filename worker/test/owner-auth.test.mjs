/**
 * owner-auth end-to-end: invite -> enroll -> sign in -> use -> manage, driven
 * through the worker's real fetch handler against a stateful in-memory D1.
 * The passkey material is really generated and really signed (fixtures), so
 * every gate in the chain is exercised by the genuine article.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { makeCredential, signAssertion, clientData, attestationObject } from "./webauthn-fixtures.mjs";

const ORIGIN = "https://brain.example.com";
const RP = "brain.example.com";

/** A tiny stateful D1 speaking exactly the SQL auth-store uses. */
function authDb() {
  const tables = { challenges: new Map(), codes: new Map(), passkeys: new Map(), state: { session_generation: 1 } };
  return {
    tables,
    prepare(sql) {
      let bound = [];
      const statement = {
        bind(...args) { bound = args; return statement; },
        async first() {
          if (/FROM auth_challenges/.test(sql)) return tables.challenges.get(bound[0]) || null;
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
          if (/INSERT INTO auth_challenges/.test(sql)) tables.challenges.set(bound[0], { purpose: bound[1], expires_at: bound[2] });
          else if (/DELETE FROM auth_challenges/.test(sql)) tables.challenges.delete(bound[0]);
          else if (/INSERT INTO enrollment_codes/.test(sql)) tables.codes.set(bound[0], { expires_at: bound[1], used_at: null });
          else if (/UPDATE enrollment_codes SET used_at/.test(sql)) {
            const row = tables.codes.get(bound[1]);
            if (row && !row.used_at) row.used_at = bound[0];
          } else if (/INSERT INTO owner_passkeys/.test(sql)) {
            tables.passkeys.set(bound[0], {
              credential_id: bound[0], public_key_jwk: bound[1], alg: bound[2],
              sign_count: bound[3], nickname: bound[4], created_at: bound[5], last_used_at: null,
            });
          } else if (/UPDATE owner_passkeys SET sign_count/.test(sql)) {
            const row = tables.passkeys.get(bound[2]);
            if (row) { row.sign_count = bound[0]; row.last_used_at = bound[1]; }
          } else if (/UPDATE owner_passkeys SET nickname/.test(sql)) {
            const row = tables.passkeys.get(bound[1]);
            if (row) row.nickname = bound[0];
          } else if (/DELETE FROM owner_passkeys/.test(sql)) tables.passkeys.delete(bound[0]);
          else if (/UPDATE install_state SET session_generation/.test(sql)) tables.state.session_generation += 1;
          return {};
        },
      };
      return statement;
    },
    async batch() {},
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
  assert.match(enrolledCookie, /^brain_session=v1\./, "enrollment signs the owner straight in");

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

  // Settings: devices are listed; the last passkey cannot be revoked.
  const me = await (await worker.fetch(post("/api/app/me", {}, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.equal(me.devices.length, 1);
  assert.equal(me.devices[0].nickname, "Morgan's phone");
  const lastRevoke = await (await worker.fetch(post("/api/app/devices/revoke", {
    credential_id: credential.credentialId,
  }, { Cookie: cookie, "X-Brain-App": "1" }), testEnv)).json();
  assert.equal(lastRevoke.removed, false, "removing the last passkey would be a silent lockout");

  // Sign out everywhere invalidates every cookie ever minted.
  const signoutAll = await worker.fetch(post("/api/app/signout-all", {}, { Cookie: cookie, "X-Brain-App": "1" }), testEnv);
  assert.equal(signoutAll.status, 200);
  const afterBump = await worker.fetch(post("/api/app/me", {}, { Cookie: cookie, "X-Brain-App": "1" }), testEnv);
  assert.equal(afterBump.status, 401, "generation bump kills old sessions");
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
