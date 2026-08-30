import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { splitStatements } from "../../brain.mjs";
import { mintSessionCookie } from "../src/lib/sessions.js";
import { supportSystemProjection } from "../src/lib/support-access.js";
import {
  makeCredential, signAssertion, clientData, attestationObject,
} from "./webauthn-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations", "d1");
const ORIGIN = "https://brain.example.com";
const RP_ID = "brain.example.com";

function d1(db) {
  let batchTail = Promise.resolve();
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
      const prior = batchTail;
      let release;
      batchTail = new Promise((resolve) => { release = resolve; });
      await prior;
      try {
        db.exec("BEGIN IMMEDIATE");
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        release();
      }
    },
  };
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).filter((entry) => /^\d{4}_.+\.sql$/.test(entry)).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, name), "utf8"))) db.exec(statement);
  }
  db.prepare(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,session_generation)
     VALUES (1,'fixture','0.2.0',23,0,'2026-08-30T00:00:00Z','test',1)`,
  ).run();
  const env = {
    STORAGE: "d1",
    DB: d1(db),
    SESSION_SIGNING_KEY: "s".repeat(64),
    ADMIN_KEY: "fixture-admin-key-not-a-secret",
    BRAIN_NAME: "Fixture Brain",
    BRAIN_VERSION: "0.2.0",
    VECTORIZE: {
      async describe() { return { vectorsCount: 0, processedUpToMutation: "0" }; },
      async query() { return { matches: [] }; },
    },
  };
  return { db, env };
}

const request = (path, body = {}, headers = {}) => new Request(ORIGIN + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const cookieOf = (response) => (response.headers.get("Set-Cookie") || "").split(";")[0];

async function ownerHeaders(env) {
  return {
    Cookie: (await mintSessionCookie(env, 1, { grantId: null })).split(";")[0],
    "X-Brain-App": "1",
  };
}

const supportHeaders = (cookie = "") => ({
  ...(cookie ? { Cookie: cookie } : {}),
  "X-Brain-Support": "1",
});

test("support access is separate, short-lived, read-only, auditable, and immediately revocable", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);

    const initialStatus = await worker.fetch(request(
      "/api/app/support-access/status", {}, owner,
    ), env, {});
    assert.equal(initialStatus.status, 200);
    assert.match(initialStatus.headers.get("Cache-Control") || "", /no-store/);
    assert.deepEqual(await initialStatus.json(), {
      status: "ready",
      policy: {
        access: "read_only_diagnostics",
        duration_choices_minutes: [15, 30, 60, 120],
        default_duration_minutes: 30,
        max_duration_minutes: 120,
        enrollment_link_max_minutes: 10,
        can_fix: false,
        repair_mode: "owner_approval_required_future",
      },
      sessions: [],
    });

    const tooLong = await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-too-long-0001",
      technician_label: "Invited technician",
      duration_minutes: 24 * 60,
    }, owner), env, {});
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).code, "invalid_duration_minutes");

    const createBody = {
      request_id: "support-create-lost-0001",
      technician_label: "Invited technician",
      duration_minutes: 15,
    };
    const createdResponse = await worker.fetch(request(
      "/api/app/support-access/create", createBody, owner,
    ), env, {});
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    assert.equal(created.status, "pending");
    assert.equal(created.request_id, createBody.request_id);
    assert.equal(created.changed, true);
    assert.equal(created.replayed, false);
    assert.equal(created.expires_at, null, "duration starts only after passkey activation");
    assert.equal(created.enrollment_expires_at - created.created_at, 10 * 60 * 1000);
    assert.match(created.enrollment_url, /#support-enroll=/);
    const firstCode = created.enrollment_url.split("#support-enroll=")[1];
    assert.ok(firstCode);

    const persisted = JSON.stringify({
      requests: db.prepare("SELECT * FROM support_access_requests").all(),
      invites: db.prepare("SELECT * FROM support_enrollment_codes").all(),
    });
    assert.equal(persisted.includes(firstCode), false, "invites are hash-only at rest");
    assert.equal(persisted.includes(created.enrollment_url), false);

    const replay = await (await worker.fetch(request(
      "/api/app/support-access/create", createBody, owner,
    ), env, {})).json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.enrollment_url, created.enrollment_url,
      "response-loss replay derives the same still-valid invite");

    const conflict = await worker.fetch(request("/api/app/support-access/create", {
      ...createBody, technician_label: "Different label",
    }, owner), env, {});
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "request_id_conflict");

    // Reissue may replace a still-active link, for example after the owner sent
    // it through the wrong channel. Only the replacement remains usable.
    const reissuedResponse = await worker.fetch(request("/api/app/support-access/reissue", {
      request_id: "support-reissue-lost-0001",
      support_session_id: created.support_session_id,
    }, owner), env, {});
    const reissued = await reissuedResponse.json();
    assert.equal(reissuedResponse.status, 200, JSON.stringify(reissued));
    assert.equal(reissued.status, "pending");
    assert.equal(reissued.changed, true);
    const replacementCode = reissued.enrollment_url.split("#support-enroll=")[1];
    assert.notEqual(replacementCode, firstCode);
    const oldOptions = await worker.fetch(request(
      "/api/support/auth/register/options", { code: firstCode }, supportHeaders(),
    ), env, {});
    assert.equal(oldOptions.status, 403, "reissue invalidates every prior unused link");

    const optionsResponse = await worker.fetch(request(
      "/api/support/auth/register/options", { code: replacementCode }, supportHeaders(),
    ), env, {});
    assert.equal(optionsResponse.status, 200);
    assert.match(optionsResponse.headers.get("Cache-Control") || "", /no-store/);
    const options = await optionsResponse.json();
    const credential = await makeCredential({ rpId: RP_ID });
    const verifyResponse = await worker.fetch(request(
      "/api/support/auth/register/verify",
      {
        code: replacementCode,
        credentialId: credential.credentialId,
        attestationObject: attestationObject(credential.authData),
        clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
      },
      supportHeaders(),
    ), env, {});
    assert.equal(verifyResponse.status, 200, await verifyResponse.clone().text());
    const supportCookie = cookieOf(verifyResponse);
    assert.match(supportCookie, /^brain_support_session=v1\./);
    assert.equal(db.prepare("SELECT count(*) n FROM support_passkeys").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM owner_passkeys").get().n, 0,
      "support credentials never enter owner device storage");

    const activated = db.prepare(
      "SELECT activated_at,expires_at,duration_minutes FROM support_sessions WHERE support_session_id=?",
    ).get(created.support_session_id);
    assert.equal(activated.expires_at - activated.activated_at, 15 * 60 * 1000);

    const consumedReplay = await (await worker.fetch(request(
      "/api/app/support-access/reissue", {
        request_id: "support-reissue-lost-0001",
        support_session_id: created.support_session_id,
      }, owner,
    ), env, {})).json();
    assert.equal(consumedReplay.replayed, true);
    assert.equal(consumedReplay.invite_state, "consumed");
    assert.equal(consumedReplay.enrollment_url, null);

    const secondCredential = await worker.fetch(request(
      "/api/support/auth/register/options", {}, supportHeaders(supportCookie),
    ), env, {});
    assert.equal(secondCredential.status, 403, "a support session cannot add a second device");
    const ownerEnrollment = await worker.fetch(request(
      "/auth/register/options", {}, {
        ...supportHeaders(supportCookie), "X-Brain-App": "1",
      },
    ), env, {});
    assert.equal(ownerEnrollment.status, 403, "support cannot enter owner enrollment");

    const meResponse = await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(supportCookie),
    ), env, {});
    const me = await meResponse.json();
    assert.equal(meResponse.status, 200, JSON.stringify(me));
    assert.deepEqual(Object.keys(me).sort(), [
      "can_fix", "principal", "repair_mode", "signed_in", "workspace",
    ]);
    assert.deepEqual(Object.keys(me.principal).sort(), [
      "expires_at", "idle_expires_at", "kind", "read_only", "support_session_id",
      "technician_identity_verified", "technician_label",
    ]);
    assert.equal(me.principal.kind, "support");
    assert.equal(me.can_fix, false);
    assert.equal(me.workspace.support, true);
    for (const key of ["home", "documents", "ask", "add_review", "access", "bank", "targets", "preferences", "connections"]) {
      assert.equal(me.workspace[key], false, key);
    }

    // Live authority is still checked on every call, while last-used and the
    // immutable read audit are coarsened to one write/row per minute.
    const fixedReadAt = Number(db.prepare(
      "SELECT last_used_at FROM support_sessions WHERE support_session_id=?",
    ).get(created.support_session_id).last_used_at);
    const originalNow = Date.now;
    try {
      Date.now = () => fixedReadAt;
      for (let index = 0; index < 5; index++) {
        const repeated = await worker.fetch(request(
          "/api/support/me", {}, supportHeaders(supportCookie),
        ), env, {});
        assert.equal(repeated.status, 200);
      }
    } finally {
      Date.now = originalNow;
    }
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_access_events WHERE event_id=?",
    ).get(
      `support:read:${created.support_session_id}:me:${Math.floor(fixedReadAt / 60_000)}`,
    ).n, 1, "repeat reads in one minute create one immutable audit row");
    assert.equal(db.prepare(
      "SELECT last_used_at FROM support_sessions WHERE support_session_id=?",
    ).get(created.support_session_id).last_used_at, fixedReadAt,
    "repeat reads in one minute do not amplify last-used writes");

    let systemResponse;
    try {
      Date.now = () => fixedReadAt;
      systemResponse = await worker.fetch(request(
        "/api/support/system", {}, supportHeaders(supportCookie),
      ), env, {});
    } finally {
      Date.now = originalNow;
    }
    const system = await systemResponse.json();
    assert.equal(systemResponse.status, 200, JSON.stringify(system));
    assert.ok(["ready", "partial"].includes(system.status));
    assert.deepEqual(Object.keys(system.access).sort(), [
      "can_fix", "expires_at", "kind", "read_only", "remaining_seconds", "technician_label",
    ]);
    assert.deepEqual(system.privacy, {
      mode: "aggregate_only",
      content_visible: false,
      search_available: false,
      raw_errors_visible: false,
      credentials_visible: false,
      account_identifiers_visible: false,
    });
    assert.equal(system.brain.product_version, "0.2.0");
    assert.equal(system.brain.schema_version, 23);
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_access_events WHERE event_id=?",
    ).get(
      `support:read:${created.support_session_id}:system:${Math.floor(fixedReadAt / 60_000)}`,
    ).n, 1, "me then system in one minute retains one route-specific audit row each");

    // A paused rollback Worker refuses every support surface before parsing a
    // body or writing state. Active cookies are cleared so restored authority
    // cannot become usable in the pause window.
    const pausedEnv = { ...env, VECTOR_DRAIN_MODE: "paused-for-upgrade" };
    const beforePauseCounts = {
      requests: db.prepare("SELECT count(*) n FROM support_access_requests").get().n,
      challenges: db.prepare("SELECT count(*) n FROM support_auth_challenges").get().n,
      events: db.prepare("SELECT count(*) n FROM support_access_events").get().n,
    };
    for (const [path, body] of [
      ["/api/app/support-access/status", {}],
      ["/api/app/support-access/create", createBody],
      ["/api/app/support-access/reissue", {
        request_id: "paused-reissue-0001", support_session_id: created.support_session_id,
      }],
      ["/api/app/support-access/revoke", {
        request_id: "paused-revoke-0001", support_session_id: created.support_session_id,
      }],
    ]) {
      const pausedOwner = await worker.fetch(request(path, body, owner), pausedEnv, {});
      assert.equal(pausedOwner.status, 503, path);
      assert.equal((await pausedOwner.json()).code, "support_access_unavailable");
    }
    for (const path of [
      "/api/support/auth/register/options", "/api/support/auth/register/verify",
      "/api/support/auth/login/options", "/api/support/auth/login/verify",
      "/api/support/me", "/api/support/system", "/api/support/signout",
    ]) {
      const pausedSupport = await worker.fetch(request(
        path, {}, supportHeaders(supportCookie),
      ), pausedEnv, {});
      assert.equal(pausedSupport.status, 503, path);
      assert.equal((await pausedSupport.clone().json()).code, "support_access_unavailable");
      assert.match(pausedSupport.headers.get("Set-Cookie") || "", /Max-Age=0/, path);
    }
    assert.deepEqual({
      requests: db.prepare("SELECT count(*) n FROM support_access_requests").get().n,
      challenges: db.prepare("SELECT count(*) n FROM support_auth_challenges").get().n,
      events: db.prepare("SELECT count(*) n FROM support_access_events").get().n,
    }, beforePauseCounts, "paused support routes perform no writes");

    // A support cookie remains meaningless on every owner, data, financial,
    // connector, OAuth, and operator surface even if an attacker adds both
    // companion headers.
    const hostileHeaders = {
      ...supportHeaders(supportCookie),
      "X-Brain-App": "1",
    };
    for (const [path, body] of [
      ["/api/app/system", {}],
      ["/api/app/support-access/status", {}],
      ["/api/app/connections/revoke", { client_id: "fixture" }],
      ["/api/rag/unified", { q: "private" }],
      ["/api/rag/think", { q: "private" }],
      ["/api/fin/status", {}],
      ["/api/bank-feed/link-token", {}],
      ["/api/owner/activity", {}],
      ["/api/admin/brain/diagnose", {}],
      ["/api/admin/brain/ingest", { documents: [] }],
      ["/oauth/authorize/decision", {}],
    ]) {
      const denied = await worker.fetch(request(path, body, hostileHeaders), env, {});
      assert.ok(denied.status === 401 || denied.status === 403,
        `${path} returned ${denied.status}: ${await denied.text()}`);
    }

    const reissueAfterActivation = await worker.fetch(request(
      "/api/app/support-access/reissue", {
        request_id: "support-reissue-after-active-0001",
        support_session_id: created.support_session_id,
      }, owner,
    ), env, {});
    assert.equal(reissueAfterActivation.status, 409);
    assert.equal((await reissueAfterActivation.json()).code, "support_session_already_activated");

    const revokeBody = {
      request_id: "support-revoke-lost-0001",
      support_session_id: created.support_session_id,
    };
    const revokeResponse = await worker.fetch(request(
      "/api/app/support-access/revoke", revokeBody, owner,
    ), env, {});
    const revoked = await revokeResponse.json();
    assert.equal(revokeResponse.status, 200, JSON.stringify(revoked));
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.changed, true);
    assert.equal(revoked.replayed, false);
    const revokeReplay = await (await worker.fetch(request(
      "/api/app/support-access/revoke", revokeBody, owner,
    ), env, {})).json();
    assert.equal(revokeReplay.replayed, true);

    const afterRevoke = await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(supportCookie),
    ), env, {});
    assert.equal(afterRevoke.status, 403);
    const afterRevokeBody = await afterRevoke.clone().json();
    assert.equal(afterRevokeBody.code, "support_session_revoked");
    assert.equal(afterRevokeBody.recovery,
      "This support access has ended. Ask the owner for a new invitation to continue.");
    assert.match(afterRevoke.headers.get("Set-Cookie") || "", /Max-Age=0/);

    assert.deepEqual(
      db.prepare("SELECT event_type FROM owner_activity_events ORDER BY occurred_at,event_id").all()
        .map((row) => row.event_type),
      ["support_access_created", "support_access_activated", "support_access_revoked"],
    );
    const securityHistory = JSON.stringify(db.prepare("SELECT * FROM support_access_events").all());
    assert.equal(securityHistory.includes(credential.credentialId), false,
      "support audit never records credential ids");
    assert.throws(
      () => db.prepare("UPDATE support_access_events SET occurred_at=0").run(),
      /append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM support_access_events").run(),
      /append-only/,
    );

    const listed = await (await worker.fetch(request(
      "/api/app/support-access/status", {}, owner,
    ), env, {})).json();
    assert.equal(listed.sessions[0].state, "revoked");
  } finally {
    db.close();
  }
});

test("interleaved reissues never return a replacement link another request already invalidated", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);
    const created = await (await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-reissue-race-create-0001",
      technician_label: "Reissue race fixture",
      duration_minutes: 30,
    }, owner), env, {})).json();
    const firstBody = {
      request_id: "support-reissue-race-first-0001",
      support_session_id: created.support_session_id,
    };
    const secondBody = {
      request_id: "support-reissue-race-second-0001",
      support_session_id: created.support_session_id,
    };
    const base = env.DB;
    let injected = false;
    let secondReceipt = null;
    const raceEnv = {
      ...env,
      DB: {
        raw: db,
        prepare(sql) {
          const delegate = base.prepare(sql);
          if (!/SELECT c\.code_hash FROM support_enrollment_codes c/.test(sql)) return delegate;
          const wrapper = {
            bind(...args) { delegate.bind(...args); return wrapper; },
            async first() {
              if (!injected) {
                injected = true;
                const secondResponse = await worker.fetch(request(
                  "/api/app/support-access/reissue", secondBody, owner,
                ), env, {});
                secondReceipt = await secondResponse.json();
                assert.equal(secondResponse.status, 200, JSON.stringify(secondReceipt));
              }
              return delegate.first();
            },
            all() { return delegate.all(); },
            run() { return delegate.run(); },
          };
          return wrapper;
        },
        batch(statements) { return base.batch(statements); },
      },
    };

    const firstResponse = await worker.fetch(request(
      "/api/app/support-access/reissue", firstBody, owner,
    ), raceEnv, {});
    const firstReceipt = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(firstReceipt));
    assert.equal(injected, true);
    assert.match(secondReceipt.enrollment_url, /#support-enroll=/);
    assert.equal(secondReceipt.invite_state, "active");
    assert.equal(firstReceipt.enrollment_url, null,
      "the superseded request cannot return a link that is already unusable");
    assert.equal(firstReceipt.invite_state, "consumed");
    assert.equal(firstReceipt.replayed, true);
    assert.equal(db.prepare(
      `SELECT count(*) n FROM support_enrollment_codes
        WHERE support_session_id=? AND used_at IS NULL`,
    ).get(created.support_session_id).n, 1, "exactly one replacement remains authoritative");
  } finally {
    db.close();
  }
});

test("concurrent registration ceremonies produce exactly one support credential and cookie", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);
    const created = await (await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-register-race-create-0001",
      technician_label: "Registration race fixture",
      duration_minutes: 15,
    }, owner), env, {})).json();
    const code = created.enrollment_url.split("#support-enroll=")[1];
    const [optionsA, optionsB] = await Promise.all([0, 1].map(async () => (
      await (await worker.fetch(request(
        "/api/support/auth/register/options", { code }, supportHeaders(),
      ), env, {})).json()
    )));
    const [credentialA, credentialB] = await Promise.all([
      makeCredential({ rpId: RP_ID }),
      makeCredential({ rpId: RP_ID }),
    ]);
    const payloads = [
      {
        code,
        credentialId: credentialA.credentialId,
        attestationObject: attestationObject(credentialA.authData),
        clientDataJSON: clientData("webauthn.create", optionsA.challenge, ORIGIN),
      },
      {
        code,
        credentialId: credentialB.credentialId,
        attestationObject: attestationObject(credentialB.authData),
        clientDataJSON: clientData("webauthn.create", optionsB.challenge, ORIGIN),
      },
    ];
    const fixedNow = Date.now();
    const originalNow = Date.now;
    let responses;
    try {
      Date.now = () => fixedNow;
      responses = await Promise.all(payloads.map((payload) => worker.fetch(request(
        "/api/support/auth/register/verify", payload, supportHeaders(),
      ), env, {})));
    } finally {
      Date.now = originalNow;
    }
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    assert.equal(statuses[0], 200);
    assert.ok(statuses[1] === 403 || statuses[1] === 409, statuses.join(","));
    assert.equal(responses.filter((response) =>
      /^brain_support_session=v1\./.test(cookieOf(response))).length, 1,
    "only the ceremony that stored its credential receives a support cookie");
    assert.equal(db.prepare("SELECT count(*) n FROM support_passkeys").get().n, 1);
    assert.equal(db.prepare(
      "SELECT count(*) n FROM owner_activity_events WHERE event_type='support_access_activated'",
    ).get().n, 1);
  } finally {
    db.close();
  }
});

test("concurrent revoke request ids agree on one winner and one immutable timestamp", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);
    const created = await (await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-revoke-race-create-0001",
      technician_label: "Revoke race fixture",
      duration_minutes: 15,
    }, owner), env, {})).json();
    const fixedNow = Date.now();
    const originalNow = Date.now;
    let responses;
    try {
      Date.now = () => fixedNow;
      responses = await Promise.all(["first", "second"].map((name) => worker.fetch(request(
        "/api/app/support-access/revoke", {
          request_id: `support-revoke-race-${name}-0001`,
          support_session_id: created.support_session_id,
        }, owner,
      ), env, {})));
    } finally {
      Date.now = originalNow;
    }
    const receipts = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.deepEqual(receipts.map((receipt) => receipt.changed).sort(), [false, true]);
    assert.equal(new Set(receipts.map((receipt) => receipt.revoked_at)).size, 1);
    assert.equal(receipts[0].revoked_at, fixedNow);
    assert.equal(db.prepare(
      "SELECT count(*) n FROM owner_activity_events WHERE event_type='support_access_revoked'",
    ).get().n, 1);
    for (let index = 0; index < receipts.length; index++) {
      const replay = await (await worker.fetch(request(
        "/api/app/support-access/revoke", {
          request_id: `support-revoke-race-${index === 0 ? "first" : "second"}-0001`,
          support_session_id: created.support_session_id,
        }, owner,
      ), env, {})).json();
      assert.equal(replay.changed, receipts[index].changed);
      assert.equal(replay.revoked_at, fixedNow);
      assert.equal(replay.replayed, true);
    }
  } finally {
    db.close();
  }
});

test("idle/absolute expiry and D1 loss fail closed, while passkey login can re-authenticate idle access", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);
    const created = await (await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-expiry-create-0001",
      technician_label: "Expiry fixture",
      duration_minutes: 30,
    }, owner), env, {})).json();
    const code = created.enrollment_url.split("#support-enroll=")[1];
    const options = await (await worker.fetch(request(
      "/api/support/auth/register/options", { code }, supportHeaders(),
    ), env, {})).json();
    const credential = await makeCredential({ rpId: RP_ID });
    const enrolled = await worker.fetch(request("/api/support/auth/register/verify", {
      code,
      credentialId: credential.credentialId,
      attestationObject: attestationObject(credential.authData),
      clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
    }, supportHeaders()), env, {});
    const cookie = cookieOf(enrolled);

    const firstRead = await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(cookie),
    ), env, {});
    assert.equal(firstRead.status, 200, "fixture establishes a non-null last_used_at before idle");

    db.prepare(
      `UPDATE support_sessions
          SET last_authenticated_at=?,last_used_at=?
        WHERE support_session_id=?`,
    ).run(
      Date.now() - 11 * 60 * 1000,
      Date.now() - 11 * 60 * 1000,
      created.support_session_id,
    );
    const idle = await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(cookie),
    ), env, {});
    assert.equal(idle.status, 403);
    const idleBody = await idle.json();
    assert.equal(idleBody.code, "support_session_idle_expired");
    assert.equal(idleBody.recovery,
      "Sign in again with the enrolled support passkey to continue.");

    const ownerIdleStatus = await (await worker.fetch(request(
      "/api/app/support-access/status", {}, owner,
    ), env, {})).json();
    assert.equal(ownerIdleStatus.sessions[0].state, "active",
      "idle authentication does not falsely end the owner-granted absolute session");
    assert.equal(ownerIdleStatus.sessions[0].authentication_state, "reauthentication_required",
      "owner status explicitly distinguishes an idle session that can use its passkey again");
    assert.ok(ownerIdleStatus.sessions[0].idle_expires_at <= Date.now());
    assert.ok(ownerIdleStatus.sessions[0].expires_at > Date.now());

    // Idle timeout asks the same hardware passkey to re-authenticate; it does
    // not extend the absolute owner-selected expiry.
    const beforeLoginExpiry = db.prepare(
      "SELECT expires_at FROM support_sessions WHERE support_session_id=?",
    ).get(created.support_session_id).expires_at;
    const loginOptions = await (await worker.fetch(request(
      "/api/support/auth/login/options", {}, supportHeaders(),
    ), env, {})).json();
    const assertion = await signAssertion({
      pair: credential.pair, rpId: RP_ID, challenge: loginOptions.challenge,
      origin: ORIGIN, counter: 1,
    });
    const login = await worker.fetch(request("/api/support/auth/login/verify", {
      credentialId: credential.credentialId, ...assertion,
    }, supportHeaders()), env, {});
    assert.equal(login.status, 200, await login.clone().text());
    const refreshedCookie = cookieOf(login);
    const afterLoginExpiry = db.prepare(
      "SELECT expires_at FROM support_sessions WHERE support_session_id=?",
    ).get(created.support_session_id).expires_at;
    assert.equal(afterLoginExpiry, beforeLoginExpiry, "login never slides absolute expiry");
    assert.equal((await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(refreshedCookie),
    ), env, {})).status, 200,
    "a new authentication timestamp wins over an older non-null last-used timestamp");
    const ownerRefreshedStatus = await (await worker.fetch(request(
      "/api/app/support-access/status", {}, owner,
    ), env, {})).json();
    assert.equal(ownerRefreshedStatus.sessions[0].state, "active");
    assert.equal(ownerRefreshedStatus.sessions[0].authentication_state, "authenticated");

    const concurrentOptions = await (await worker.fetch(request(
      "/api/support/auth/login/options", {}, supportHeaders(),
    ), env, {})).json();
    const concurrentAssertion = await signAssertion({
      pair: credential.pair, rpId: RP_ID, challenge: concurrentOptions.challenge,
      origin: ORIGIN, counter: 2,
    });
    const concurrentBody = { credentialId: credential.credentialId, ...concurrentAssertion };
    const concurrent = await Promise.all([
      worker.fetch(request("/api/support/auth/login/verify", concurrentBody, supportHeaders()), env, {}),
      worker.fetch(request("/api/support/auth/login/verify", concurrentBody, supportHeaders()), env, {}),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 403],
      "one atomic challenge can authorize exactly one concurrent verify");

    const nearAbsoluteExpiry = Date.now() + 2 * 60 * 1000;
    db.prepare("UPDATE support_sessions SET expires_at=? WHERE support_session_id=?")
      .run(nearAbsoluteExpiry, created.support_session_id);
    const clampedMe = await (await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(refreshedCookie),
    ), env, {})).json();
    assert.equal(clampedMe.principal.idle_expires_at, nearAbsoluteExpiry,
      "idle display never extends beyond the owner's absolute access expiry");

    const unavailableEnv = {
      ...env,
      DB: { prepare() { throw new Error("fixture D1 unavailable"); } },
    };
    const unavailable = await worker.fetch(request(
      "/api/support/me", {}, supportHeaders(refreshedCookie),
    ), unavailableEnv, {});
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, "support_access_unavailable");

    db.prepare("UPDATE support_sessions SET expires_at=? WHERE support_session_id=?")
      .run(Date.now() - 1, created.support_session_id);
    const expired = await worker.fetch(request(
      "/api/support/system", {}, supportHeaders(refreshedCookie),
    ), env, {});
    assert.equal(expired.status, 403);
    const expiredBody = await expired.json();
    assert.equal(expiredBody.code, "support_session_expired");
    assert.equal(expiredBody.recovery,
      "This support access has ended. Ask the owner for a new invitation to continue.");
    assert.match(expired.headers.get("Set-Cookie") || "", /Max-Age=0/);

    const signedCookieExpiry = Number(refreshedCookie.split(".")[1]);
    assert.ok(Number.isSafeInteger(signedCookieExpiry));
    db.prepare("UPDATE support_sessions SET expires_at=? WHERE support_session_id=?")
      .run(signedCookieExpiry + 60_000, created.support_session_id);
    const realNow = Date.now;
    Date.now = () => signedCookieExpiry + 1;
    try {
      const naturallyExpired = await worker.fetch(request(
        "/api/support/me", {}, supportHeaders(refreshedCookie),
      ), env, {});
      assert.equal(naturallyExpired.status, 403,
        "a naturally expired signed cookie is an explicit ended session, not a generic 401");
      const naturallyExpiredBody = await naturallyExpired.json();
      assert.equal(naturallyExpiredBody.code, "support_session_expired");
      assert.equal(naturallyExpiredBody.recovery,
        "This support access has ended. Ask the owner for a new invitation to continue.");
      assert.match(naturallyExpired.headers.get("Set-Cookie") || "", /Max-Age=0/);
    } finally {
      Date.now = realNow;
    }
  } finally {
    db.close();
  }
});

test("unauthenticated support challenges are capped without evicting valid ceremonies", async () => {
  const { db, env } = fixture();
  try {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const retainedHash = "a".repeat(64);
    const insert = db.prepare(
      "INSERT INTO support_auth_challenges (challenge_hash,purpose,expires_at) VALUES (?,'login',?)",
    );
    db.exec("BEGIN");
    insert.run(retainedHash, expiresAt);
    for (let index = 0; index < 499; index++) {
      insert.run(String(index).padStart(64, "0"), expiresAt);
    }
    db.exec("COMMIT");

    const saturated = await worker.fetch(request(
      "/api/support/auth/login/options", {}, supportHeaders(),
    ), env, {});
    assert.equal(saturated.status, 429);
    assert.equal((await saturated.json()).code, "support_challenge_capacity");
    assert.equal(db.prepare("SELECT count(*) n FROM support_auth_challenges").get().n, 500);
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_auth_challenges WHERE challenge_hash=?",
    ).get(retainedHash).n, 1, "capacity refusal never evicts a still-valid challenge");

    const expiredHash = String(0).padStart(64, "0");
    db.prepare("UPDATE support_auth_challenges SET expires_at=? WHERE challenge_hash=?")
      .run(Date.now() - 1, expiredHash);
    const afterExpiry = await worker.fetch(request(
      "/api/support/auth/login/options", {}, supportHeaders(),
    ), env, {});
    assert.equal(afterExpiry.status, 200, await afterExpiry.clone().text());
    assert.equal(db.prepare("SELECT count(*) n FROM support_auth_challenges").get().n, 500);
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_auth_challenges WHERE challenge_hash=?",
    ).get(expiredHash).n, 0, "expired challenges are pruned before admitting a replacement");
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_auth_challenges WHERE challenge_hash=?",
    ).get(retainedHash).n, 1);
  } finally {
    db.close();
  }
});

test("a revoke that lands during diagnostics is rechecked before any aggregate response", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);
    const created = await (await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-race-create-0001",
      technician_label: "Race fixture",
      duration_minutes: 15,
    }, owner), env, {})).json();
    const code = created.enrollment_url.split("#support-enroll=")[1];
    const options = await (await worker.fetch(request(
      "/api/support/auth/register/options", { code }, supportHeaders(),
    ), env, {})).json();
    const credential = await makeCredential({ rpId: RP_ID });
    const enrolled = await worker.fetch(request("/api/support/auth/register/verify", {
      code,
      credentialId: credential.credentialId,
      attestationObject: attestationObject(credential.authData),
      clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
    }, supportHeaders()), env, {});
    const cookie = cookieOf(enrolled);

    const base = env.DB;
    let revokedDuringRead = false;
    const raceEnv = {
      ...env,
      DB: {
        raw: db,
        prepare(sql) {
          if (!revokedDuringRead && /FROM\s+documents/i.test(sql)) {
            revokedDuringRead = true;
            db.prepare("UPDATE support_sessions SET revoked_at=? WHERE support_session_id=?")
              .run(Date.now(), created.support_session_id);
          }
          return base.prepare(sql);
        },
        batch(statements) { return base.batch(statements); },
      },
    };
    const response = await worker.fetch(request(
      "/api/support/system", {}, supportHeaders(cookie),
    ), raceEnv, {});
    assert.equal(revokedDuringRead, true, "fixture revoked during the aggregate read");
    assert.equal(response.status, 403);
    const denied = await response.json();
    assert.equal(denied.code, "support_session_revoked");
    assert.equal("corpus" in denied, false);
    assert.match(response.headers.get("Set-Cookie") || "", /Max-Age=0/);
  } finally {
    db.close();
  }
});

test("concurrent system polling reserves one heavy diagnostic read and rate-limits the rest", async () => {
  const { db, env } = fixture();
  try {
    const owner = await ownerHeaders(env);
    const created = await (await worker.fetch(request("/api/app/support-access/create", {
      request_id: "support-throttle-create-0001",
      technician_label: "Throttle fixture",
      duration_minutes: 15,
    }, owner), env, {})).json();
    const code = created.enrollment_url.split("#support-enroll=")[1];
    const options = await (await worker.fetch(request(
      "/api/support/auth/register/options", { code }, supportHeaders(),
    ), env, {})).json();
    const credential = await makeCredential({ rpId: RP_ID });
    const enrolled = await worker.fetch(request("/api/support/auth/register/verify", {
      code,
      credentialId: credential.credentialId,
      attestationObject: attestationObject(credential.authData),
      clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
    }, supportHeaders()), env, {});
    const cookie = cookieOf(enrolled);

    let describeCalls = 0;
    let releaseDescribe;
    let enteredDescribe;
    const entered = new Promise((resolve) => { enteredDescribe = resolve; });
    const release = new Promise((resolve) => { releaseDescribe = resolve; });
    const slowEnv = {
      ...env,
      VECTORIZE: {
        ...env.VECTORIZE,
        async describe() {
          describeCalls++;
          if (describeCalls === 2) enteredDescribe();
          await release;
          return { vectorsCount: 0, processedUpToMutation: "0" };
        },
      },
    };

    const firstPromise = worker.fetch(request(
      "/api/support/system", {}, supportHeaders(cookie),
    ), slowEnv, {});
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("fixture never reached Vectorize")), 1000,
      )),
    ]);
    const second = await worker.fetch(request(
      "/api/support/system", {}, supportHeaders(cookie),
    ), slowEnv, {});
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("Retry-After"), "15",
      "the client gets a bounded retry delay without exposing diagnostic state");
    assert.equal((await second.json()).code, "support_system_rate_limited");
    assert.equal(describeCalls, 2,
      "the concurrent request is refused while the reserved aggregate is still blocked");
    releaseDescribe();
    const first = await firstPromise;
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(describeCalls, 2,
      "one authorized aggregate performs its expected diagnose and readiness reads");
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_access_events WHERE event_type='read' AND route='system'",
    ).get().n, 1, "concurrent system polling keeps one minute-bucket read event");
    assert.equal(db.prepare(
      "SELECT count(*) n FROM support_access_events WHERE reason_code='support_system_rate_limited'",
    ).get().n, 1, "the bounded denial remains auditable");
  } finally {
    db.close();
  }
});

test("support diagnostic projection strips raw canaries and unknown identifiers", () => {
  const canary = "PRIVATE_CANARY_PATH_URL_ACCOUNT_ERROR_SAMPLE";
  const projected = supportSystemProjection({
    accepting_documents: true,
    status: "ok",
    drain_mode: "active",
    documents: 4,
    chunks: 8,
    problem_counts: { crit: 1, warn: 1, info: 1 },
    problems: [
      {
        id: canary, area: canary, severity: "crit", count: 1,
        title: canary, detail: canary, samples: [canary], action: canary,
        path: canary, url: canary,
      },
      { id: "backlog", area: "integrity", severity: "warn", count: 2 },
    ],
    sources: [{
      label: canary, kind: canary, state: canary, documents: 3,
      days_since_ingest: 1, reason: canary, name: canary, account_id: canary,
      automatable: true,
    }],
    vectors: { ready: false, expected: 8, visible: 4, pending: 4, percent_visible: 50 },
    unavailable: ["diagnose", canary],
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes(canary), false, serialized);
  assert.equal(projected.problems[0].code, "diagnostic_issue");
  assert.equal(projected.problems[0].area, "diagnostics");
  assert.equal(projected.problems[0].repairability, "guidance_only");
  assert.equal(projected.sources[0].label, "Another source");
  assert.equal(projected.sources[0].kind, "other");
  assert.equal(projected.sources[0].state, "unknown");
  assert.deepEqual(projected.unavailable, ["diagnose"]);
});
