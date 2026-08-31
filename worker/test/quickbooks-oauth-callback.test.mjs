import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { splitStatements } from "../../brain.mjs";
import {
  createQuickBooksCallbackHandoff,
  openQuickBooksCallbackHandoff,
} from "../../operations/quickbooks-callback-client.mjs";
import worker from "../src/index.js";
import {
  cleanupQuickBooksOAuthIntents,
  handleQuickBooksOAuthRoute,
  QUICKBOOKS_OAUTH_INTENT_TTL_MS,
  QUICKBOOKS_OAUTH_PATHS,
} from "../src/lib/quickbooks-oauth-callback.js";
import { sha256Hex } from "../src/lib/quickbooks-callback-crypto.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const MIGRATIONS = join(ROOT, "migrations", "d1");
const ADMIN_KEY = "synthetic-admin-key";
const START_NOW = Date.parse("2026-08-31T12:00:00Z");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) {
      db.exec(statement);
    }
  }
  db.prepare(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
     VALUES (1,'fixture','0.0.0-test',32,0,'2026-08-31T00:00:00Z','test')`,
  ).run();
  return db;
}

function d1(db, { fail = false, failQuickBooksInsert = false } = {}) {
  const prepared = (sql, params = []) => ({
    __sql: sql,
    __params: params,
    bind: (...next) => prepared(sql, next),
    all: async () => {
      if (fail) throw new Error("synthetic database detail must stay private");
      return { results: db.prepare(sql).all(...params) };
    },
    first: async () => {
      if (fail) throw new Error("synthetic database detail must stay private");
      return db.prepare(sql).get(...params) ?? null;
    },
    run: async () => {
      if (fail) throw new Error("synthetic database detail must stay private");
      if (failQuickBooksInsert && /^\s*INSERT INTO quickbooks_oauth_intents/i.test(sql)) {
        throw new Error("synthetic insert detail must stay private");
      }
      return { meta: { changes: Number(db.prepare(sql).run(...params).changes || 0) } };
    },
  });
  return {
    prepare: (sql) => prepared(sql),
    exec: async (sql) => {
      if (fail) throw new Error("synthetic database detail must stay private");
      db.exec(sql);
      return { count: 1 };
    },
    batch: async (statements) => {
      if (fail) throw new Error("synthetic database detail must stay private");
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          const query = db.prepare(statement.__sql);
          if (query.columns().length) {
            results.push({ results: query.all(...statement.__params), meta: { changes: 0 } });
          } else {
            results.push({ meta: { changes: Number(query.run(...statement.__params).changes || 0) } });
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function environment(db, options = {}) {
  return {
    STORAGE: "d1",
    DB: d1(db, options),
    ADMIN_KEY,
    SESSION_SIGNING_KEY: "synthetic-session-signing-key-0123456789",
    QUICKBOOKS_OAUTH_CALLBACK_MODE: "field-reviewed",
    QUICKBOOKS_OAUTH_OBSERVABILITY_REVIEWED: "1",
    VECTORIZE: {
      describe: async () => ({ vectorsCount: 0 }),
      upsert: async () => ({ mutationId: "synthetic" }),
      deleteByIds: async () => ({ mutationId: "synthetic" }),
      getByIds: async () => [],
    },
  };
}

function jsonRequest(path, body, { admin = true } = {}) {
  return new Request(`https://brain.invalid${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { "X-Admin-Key": ADMIN_KEY } : {}),
      "CF-Connecting-IP": "192.0.2.42",
    },
    body: JSON.stringify(body),
  });
}

async function post(env, path, body, options) {
  return worker.fetch(jsonRequest(path, body, options), env, {
    waitUntil() {}, passThroughOnException() {},
  });
}

async function responseJson(response) {
  return { response, body: await response.json() };
}

async function startFixture(env, overrides = {}, { directNow = null } = {}) {
  const keys = await createQuickBooksCallbackHandoff();
  const realmId = overrides.realmId || "synthetic-realm-42";
  const body = {
    intent_id: "i".repeat(43),
    state: "s".repeat(43),
    claim_secret: "c".repeat(43),
    source: "quickbooks",
    environment: "production",
    client_id_fingerprint: await sha256Hex("synthetic-client"),
    expected_company_fingerprint: await sha256Hex(`quickbooks-company-v1:${realmId}`),
    recipient_public_jwk: keys.publicJwk,
    ...overrides,
  };
  delete body.realmId;
  const request = jsonRequest(QUICKBOOKS_OAUTH_PATHS.start, body);
  const response = directNow === null
    ? await worker.fetch(request, env, { waitUntil() {} })
    : await handleQuickBooksOAuthRoute(
      env,
      request,
      new URL(request.url),
      QUICKBOOKS_OAUTH_PATHS.start,
      { adminAuthorized: true, now: directNow },
    );
  return { keys, realmId, startBody: body, start: await responseJson(response) };
}

function expectedBinding(fixture) {
  return {
    intent_fingerprint: fixture.start.body.intent_fingerprint,
    source: fixture.startBody.source,
    environment: fixture.startBody.environment,
    client_id_fingerprint: fixture.startBody.client_id_fingerprint,
    expected_company_fingerprint: fixture.startBody.expected_company_fingerprint ?? null,
    created_at: fixture.start.body.created_at,
    expires_at: fixture.start.body.expires_at,
  };
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control") || "", /private/);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(response.headers.get("pragma"), "no-cache");
}

test("callback core is disabled unless field enablement and logging review are explicit", async () => {
  const db = freshDb();
  try {
    const env = environment(db);
    delete env.QUICKBOOKS_OAUTH_CALLBACK_MODE;
    const start = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, {}));
    assert.equal(start.response.status, 503);
    assert.equal(start.body.code, "quickbooks_oauth_callback_unavailable");
    assertPrivate(start.response);

    const noLoggingReview = environment(db);
    delete noLoggingReview.QUICKBOOKS_OAUTH_OBSERVABILITY_REVIEWED;
    const heldForLogging = await responseJson(await post(
      noLoggingReview, QUICKBOOKS_OAUTH_PATHS.start, {},
    ));
    assert.equal(heldForLogging.response.status, 503);
    assert.equal(heldForLogging.body.code, "quickbooks_oauth_callback_unavailable");

    const noStore = environment(db);
    delete noStore.DB;
    const heldForStore = await responseJson(await post(noStore, QUICKBOOKS_OAUTH_PATHS.start, {}));
    assert.equal(heldForStore.response.status, 503);
    assert.equal(heldForStore.body.code, "quickbooks_oauth_callback_unavailable");

    const callback = await worker.fetch(new Request(
      `https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?code=not-consumed&state=not-consumed&realmId=not-consumed`,
    ), env, { waitUntil() {} });
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /return to Financial Brain/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM quickbooks_oauth_intents").get().n, 0);
  } finally {
    db.close();
  }
});

test("start is admin-only, hash-only, restart-safe, and conflict-bound", async () => {
  const db = freshDb();
  try {
    const env = environment(db);
    const keys = await createQuickBooksCallbackHandoff();
    const body = {
      intent_id: "a".repeat(43),
      state: "b".repeat(43),
      claim_secret: "d".repeat(43),
      source: "quickbooks",
      environment: "production",
      client_id_fingerprint: await sha256Hex("client-a"),
      expected_company_fingerprint: null,
      recipient_public_jwk: keys.publicJwk,
    };
    const denied = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, body, { admin: false }));
    assert.equal(denied.response.status, 401);
    assert.equal(denied.body.code, "admin_key_required");

    const first = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, body));
    assert.equal(first.response.status, 201);
    assert.equal(first.body.status, "pending");
    assert.equal(first.body.replayed, false);
    assert.equal(first.body.pkce, "not_supported");
    assert.equal(keys.privateKey.extractable, false, "the local handoff key cannot be exported");
    assertPrivate(first.response);
    const firstText = JSON.stringify(first.body);
    for (const raw of [body.intent_id, body.state, body.claim_secret]) {
      assert.equal(firstText.includes(raw), false);
    }

    const row = db.prepare("SELECT * FROM quickbooks_oauth_intents").get();
    assert.equal(row.intent_hash, await sha256Hex(body.intent_id));
    assert.equal(row.state_hash, await sha256Hex(body.state));
    assert.equal(row.claim_hash, await sha256Hex(body.claim_secret));
    assert.equal(row.pkce_challenge_hash, null);
    const stored = JSON.stringify(row);
    for (const raw of [body.intent_id, body.state, body.claim_secret]) {
      assert.equal(stored.includes(raw), false, "raw callback capabilities must not enter D1");
    }

    const replay = await responseJson(await post(environment(db), QUICKBOOKS_OAUTH_PATHS.start, body));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.created_at, first.body.created_at);
    assert.equal(db.prepare("SELECT count(*) AS n FROM quickbooks_oauth_intents").get().n, 1);

    const conflict = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, {
      ...body, source: "quickbooks_second",
    }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "quickbooks_oauth_intent_conflict");

    const pkce = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, {
      ...body, intent_id: "p".repeat(43), pkce_challenge: "future-provider-value",
    }));
    assert.equal(pkce.response.status, 409);
    assert.equal(pkce.body.code, "quickbooks_oauth_pkce_not_supported");

    const concurrentBody = {
      ...body,
      intent_id: "u".repeat(43),
      state: "v".repeat(43),
      claim_secret: "w".repeat(43),
    };
    const concurrent = await Promise.all([
      post(environment(db), QUICKBOOKS_OAUTH_PATHS.start, concurrentBody),
      post(environment(db), QUICKBOOKS_OAUTH_PATHS.start, concurrentBody),
    ]);
    const concurrentResults = await Promise.all(concurrent.map(responseJson));
    assert.deepEqual(concurrentResults.map(({ response }) => response.status).sort(), [200, 201]);
    assert.deepEqual(concurrentResults.map(({ body: result }) => result.replayed).sort(), [false, true]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM quickbooks_oauth_intents").get().n, 2);

    const stateCollision = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, {
      ...body,
      intent_id: "x".repeat(43),
      claim_secret: "y".repeat(43),
    }));
    assert.equal(stateCollision.response.status, 409);
    assert.equal(stateCollision.body.code, "quickbooks_oauth_capability_conflict");

    const invalidKey = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, {
      ...body,
      intent_id: "z".repeat(43),
      state: "1".repeat(43),
      claim_secret: "2".repeat(43),
      recipient_public_jwk: { ...keys.publicJwk, x: "A".repeat(43) },
    }));
    assert.equal(invalidKey.response.status, 400);
    assert.equal(invalidKey.body.code, "quickbooks_oauth_recipient_key_invalid");
  } finally {
    db.close();
  }
});

test("one callback wins, claim replays one envelope, and the local helper authenticates it", async () => {
  const db = freshDb();
  const captured = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values) => captured.push(values.join(" "));
  console.warn = (...values) => captured.push(values.join(" "));
  console.error = (...values) => captured.push(values.join(" "));
  try {
    const env = environment(db);
    const fixture = await startFixture(env);
    assert.equal(fixture.start.response.status, 201);
    const authorizationCodes = ["provider-code-first", "provider-code-racing"];
    const callbackResponses = await Promise.all(authorizationCodes.map((code) => worker.fetch(
      new Request(`https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?code=${code}&state=${fixture.startBody.state}&realmId=${fixture.realmId}`),
      env,
      { waitUntil() {} },
    )));
    const callbackBodies = await Promise.all(callbackResponses.map((response) => response.text()));
    assert.equal(new Set(callbackBodies).size, 1, "every callback result uses the same neutral page");
    assert.ok(callbackResponses.every((response) => response.status === 200));
    assert.ok(callbackResponses.every((response) => response.headers.get("referrer-policy") === "no-referrer"));

    const row = db.prepare("SELECT * FROM quickbooks_oauth_intents").get();
    assert.equal(row.status, "received");
    assert.equal(row.received_at !== null, true);
    assert.equal(row.callback_fingerprint.length, 64);
    assert.ok(row.callback_envelope);
    for (const raw of [...authorizationCodes, fixture.realmId, fixture.startBody.state]) {
      assert.equal(JSON.stringify(row).includes(raw), false, "provider callback values must stay encrypted");
    }
    const acceptedEnvelope = row.callback_envelope;
    const replayCallback = await worker.fetch(new Request(
      `https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?code=provider-code-too-late&state=${fixture.startBody.state}&realmId=${fixture.realmId}`,
    ), env, { waitUntil() {} });
    assert.equal(await replayCallback.text(), callbackBodies[0]);
    assert.equal(
      db.prepare("SELECT callback_envelope FROM quickbooks_oauth_intents").get().callback_envelope,
      acceptedEnvelope,
      "a later provider callback cannot replace the winning envelope",
    );

    const wrong = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: "w".repeat(43),
    }, { admin: false }));
    assert.equal(wrong.response.status, 404);
    assert.equal(wrong.body.code, "quickbooks_oauth_intent_not_found");

    const claimBody = {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    };
    const firstClaim = await responseJson(await post(
      env, QUICKBOOKS_OAUTH_PATHS.claim, claimBody, { admin: false },
    ));
    assert.equal(firstClaim.response.status, 200);
    assert.equal(firstClaim.body.replayed, false);
    assertPrivate(firstClaim.response);
    const opened = await openQuickBooksCallbackHandoff({
      privateKey: fixture.keys.privateKey,
      envelope: firstClaim.body.envelope,
      expectedBinding: expectedBinding(fixture),
    });
    assert.ok(authorizationCodes.includes(opened.authorizationCode));
    assert.equal(opened.realmId, fixture.realmId);
    assert.equal(opened.binding.source, fixture.startBody.source);
    assert.equal(opened.binding.environment, fixture.startBody.environment);

    const secondClaim = await responseJson(await post(
      env, QUICKBOOKS_OAUTH_PATHS.claim, claimBody, { admin: false },
    ));
    assert.equal(secondClaim.body.replayed, true);
    assert.deepEqual(secondClaim.body.envelope, firstClaim.body.envelope);
    assert.equal(secondClaim.body.callback_fingerprint, firstClaim.body.callback_fingerprint);
    const tampered = structuredClone(firstClaim.body.envelope);
    tampered.ciphertext_b64u = `${tampered.ciphertext_b64u.slice(0, -1)}${
      tampered.ciphertext_b64u.endsWith("A") ? "B" : "A"
    }`;
    await assert.rejects(
      openQuickBooksCallbackHandoff({
        privateKey: fixture.keys.privateKey,
        envelope: tampered,
        expectedBinding: expectedBinding(fixture),
      }),
      (error) => error.code === "quickbooks_callback_decryption_failed",
    );
    assert.equal(captured.join("\n"), "", "callback handling must not emit application logs");
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    db.close();
  }
});

test("the local helper refuses a reconnect company mismatch before token exchange", async () => {
  const db = freshDb();
  try {
    const env = environment(db);
    const fixture = await startFixture(env, {
      intent_id: "3".repeat(43),
      state: "4".repeat(43),
      claim_secret: "5".repeat(43),
      realmId: "expected-company",
    });
    await worker.fetch(new Request(
      `https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?code=wrong-company-code&state=${fixture.startBody.state}&realmId=another-company`,
    ), env, { waitUntil() {} });
    const claim = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }, { admin: false }));
    await assert.rejects(
      openQuickBooksCallbackHandoff({
        privateKey: fixture.keys.privateKey,
        envelope: claim.body.envelope,
        expectedBinding: expectedBinding(fixture),
      }),
      (error) => error.code === "quickbooks_company_binding_mismatch" &&
        !String(error.message).includes("another-company"),
    );
  } finally {
    db.close();
  }
});

test("finalize is company-bound, single-use, response-loss safe, and clears ciphertext", async () => {
  const db = freshDb();
  try {
    const env = environment(db);
    const fixture = await startFixture(env);
    await worker.fetch(new Request(
      `https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?code=finalize-code&state=${fixture.startBody.state}&realmId=${fixture.realmId}`,
    ), env, { waitUntil() {} });
    await post(env, QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }, { admin: false });

    const wrongCompany = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.finalize, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
      company_fingerprint: await sha256Hex("another-company"),
      credential_fingerprint: await sha256Hex("local-credential"),
    }));
    assert.equal(wrongCompany.response.status, 409);
    assert.equal(wrongCompany.body.code, "quickbooks_company_binding_mismatch");
    assert.ok(db.prepare("SELECT callback_envelope FROM quickbooks_oauth_intents").get().callback_envelope);

    const finalizeBody = {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
      company_fingerprint: fixture.startBody.expected_company_fingerprint,
      credential_fingerprint: await sha256Hex("local-credential"),
    };
    const first = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.finalize, finalizeBody));
    assert.equal(first.response.status, 200);
    assert.equal(first.body.status, "finalized");
    assert.equal(first.body.replayed, false);
    assertPrivate(first.response);
    assert.equal("envelope" in first.body, false);
    const row = db.prepare("SELECT * FROM quickbooks_oauth_intents").get();
    assert.equal(row.status, "finalized");
    assert.equal(row.callback_envelope, null);
    assert.equal(row.recipient_public_jwk, null);

    const replay = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.finalize, finalizeBody));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.finalized_at, first.body.finalized_at);

    const conflictingReplay = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.finalize, {
      ...finalizeBody,
      credential_fingerprint: await sha256Hex("different-local-credential"),
    }));
    assert.equal(conflictingReplay.response.status, 409);
    assert.equal(conflictingReplay.body.code, "quickbooks_oauth_finalize_conflict");

    const rejectedClaim = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }, { admin: false }));
    assert.equal(rejectedClaim.response.status, 409);
    assert.equal(rejectedClaim.body.code, "quickbooks_oauth_intent_finalized");

    const status = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.status, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }));
    assert.equal(status.response.status, 200);
    assert.equal(status.body.status, "finalized");
    const serialized = JSON.stringify(status.body);
    for (const value of ["finalize-code", fixture.realmId, fixture.startBody.state,
      fixture.startBody.claim_secret, first.body.callback_fingerprint]) {
      if (value === first.body.callback_fingerprint) continue;
      assert.equal(serialized.includes(value), false);
    }
    assert.equal("envelope" in status.body, false);
  } finally {
    db.close();
  }
});

test("provider errors become one stable canceled state without provider-detail leakage", async () => {
  const db = freshDb();
  try {
    const env = environment(db);
    const fixture = await startFixture(env, {
      intent_id: "e".repeat(43),
      state: "f".repeat(43),
      claim_secret: "g".repeat(43),
    });
    const providerDetail = "invented-provider-detail-that-must-not-survive";
    const callback = await worker.fetch(new Request(
      `https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?error=access_denied&error_description=${providerDetail}&state=${fixture.startBody.state}`,
    ), env, { waitUntil() {} });
    assert.equal(callback.status, 200);
    const row = db.prepare("SELECT * FROM quickbooks_oauth_intents").get();
    assert.equal(row.status, "canceled");
    assert.equal(row.terminal_reason, "provider_authorization_not_completed");
    assert.equal(row.recipient_public_jwk, null);
    assert.equal(row.callback_envelope, null);
    assert.equal(JSON.stringify(row).includes(providerDetail), false);
    assert.equal(JSON.stringify(row).includes("access_denied"), false);

    const claim = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }, { admin: false }));
    assert.equal(claim.response.status, 409);
    assert.equal(claim.body.code, "quickbooks_oauth_intent_canceled");
    assert.equal(JSON.stringify(claim.body).includes(providerDetail), false);
  } finally {
    db.close();
  }
});

test("expiry refuses claim and bounded cleanup removes every remaining handoff value", async () => {
  const db = freshDb();
  try {
    const env = environment(db);
    const fixture = await startFixture(env, {
      intent_id: "h".repeat(43),
      state: "j".repeat(43),
      claim_secret: "k".repeat(43),
    }, { directNow: START_NOW });
    const expiredAt = START_NOW + QUICKBOOKS_OAUTH_INTENT_TTL_MS + 1;
    const request = jsonRequest(QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }, { admin: false });
    const expired = await responseJson(await handleQuickBooksOAuthRoute(
      env, request, new URL(request.url), QUICKBOOKS_OAUTH_PATHS.claim, { now: expiredAt },
    ));
    assert.equal(expired.response.status, 410);
    assert.equal(expired.body.code, "quickbooks_oauth_intent_expired");
    const cleaned = await cleanupQuickBooksOAuthIntents(env, { now: expiredAt, limit: 1 });
    assert.deepEqual(cleaned, { cleaned: 1 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM quickbooks_oauth_intents").get().n, 0);
  } finally {
    db.close();
  }
});

test("the Worker scheduler runs bounded expiry cleanup without a callback-specific log", async () => {
  const db = freshDb();
  const captured = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values) => captured.push(values.join(" "));
  console.warn = (...values) => captured.push(values.join(" "));
  console.error = (...values) => captured.push(values.join(" "));
  try {
    const env = environment(db);
    await startFixture(env, {
      intent_id: "u".repeat(43), state: "v".repeat(43), claim_secret: "x".repeat(43),
    }, { directNow: 1 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM quickbooks_oauth_intents").get().n, 1);
    let scheduled;
    await worker.scheduled({}, env, {
      waitUntil(promise) { scheduled = promise; },
    });
    await scheduled;
    assert.equal(db.prepare("SELECT count(*) AS n FROM quickbooks_oauth_intents").get().n, 0);
    assert.equal(captured.some((line) => /quickbooks oauth intents/i.test(line)), false);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    db.close();
  }
});

test("storage and cryptographic failures expose only stable codes", async () => {
  const db = freshDb();
  try {
    const env = environment(db, { fail: true });
    const keys = await createQuickBooksCallbackHandoff();
    const secretMarker = "m".repeat(43);
    const response = await responseJson(await post(env, QUICKBOOKS_OAUTH_PATHS.start, {
      intent_id: secretMarker,
      state: "n".repeat(43),
      claim_secret: "o".repeat(43),
      source: "quickbooks",
      environment: "production",
      client_id_fingerprint: await sha256Hex("client"),
      recipient_public_jwk: keys.publicJwk,
    }));
    assert.equal(response.response.status, 503);
    assert.deepEqual(response.body, {
      error: "unavailable",
      code: "quickbooks_oauth_store_unavailable",
    });
    assert.equal(JSON.stringify(response.body).includes(secretMarker), false);
    assert.equal(JSON.stringify(response.body).includes("synthetic database detail"), false);

    const insertFailureEnv = environment(db, { failQuickBooksInsert: true });
    const insertFailure = await responseJson(await post(
      insertFailureEnv,
      QUICKBOOKS_OAUTH_PATHS.start,
      {
        intent_id: "6".repeat(43),
        state: "7".repeat(43),
        claim_secret: "8".repeat(43),
        source: "quickbooks",
        environment: "production",
        client_id_fingerprint: await sha256Hex("insert-failure-client"),
        recipient_public_jwk: keys.publicJwk,
      },
    ));
    assert.equal(insertFailure.response.status, 503);
    assert.equal(insertFailure.body.code, "quickbooks_oauth_store_unavailable");
    assert.equal(JSON.stringify(insertFailure.body).includes("synthetic insert detail"), false);

    const good = await createQuickBooksCallbackHandoff();
    const wrong = await createQuickBooksCallbackHandoff();
    const fixtureEnv = environment(db);
    const fixture = await startFixture(fixtureEnv, {
      intent_id: "q".repeat(43), state: "r".repeat(43), claim_secret: "t".repeat(43),
      recipient_public_jwk: good.publicJwk,
    });
    await worker.fetch(new Request(
      `https://brain.invalid${QUICKBOOKS_OAUTH_PATHS.callback}?code=private-code&state=${fixture.startBody.state}&realmId=${fixture.realmId}`,
    ), fixtureEnv, { waitUntil() {} });
    const claim = await responseJson(await post(fixtureEnv, QUICKBOOKS_OAUTH_PATHS.claim, {
      intent_id: fixture.startBody.intent_id,
      claim_secret: fixture.startBody.claim_secret,
    }, { admin: false }));
    await assert.rejects(
      openQuickBooksCallbackHandoff({
        privateKey: wrong.privateKey,
        envelope: claim.body.envelope,
        expectedBinding: expectedBinding(fixture),
      }),
      (error) => error.code === "quickbooks_callback_decryption_failed" &&
        !String(error.message).includes("private-code"),
    );
  } finally {
    db.close();
  }
});
