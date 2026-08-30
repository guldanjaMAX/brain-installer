import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture } from "./product-contract-fixture.mjs";
import { handleBankFeed } from "../src/lib/bank-feed.js";
import {
  completePlaidLink,
  createPlaidLinkToken,
  disconnectPlaidItem,
  drainPlaidRevocations,
  handlePlaidWebhook,
  plaidFeedStatus,
  runPlaidFeedSlice,
  syncPlaidItem,
} from "../src/lib/plaid-bank-feed.js";

const encoder = new TextEncoder();

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedWebhook(rawBody, issuedAt) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "fixture-plaid-key";
  const header = base64UrlJson({ alg: "ES256", kid: publicJwk.kid, typ: "JWT" });
  const claims = base64UrlJson({ iat: issuedAt, request_body_sha256: await sha256Hex(rawBody) });
  const input = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    encoder.encode(input),
  ));
  return { jwt: `${input}.${base64Url(signature)}`, publicJwk };
}

class PlaidSandboxFake {
  constructor() {
    this.calls = new Map();
    this.mutationRaised = false;
    this.exchangeAvailable = true;
    this.healthAvailable = true;
    this.removeAvailable = false;
    this.publicJwk = null;
  }

  count(path) {
    return this.calls.get(path) || 0;
  }

  async fetch(url, init) {
    const path = new URL(url).pathname;
    this.calls.set(path, this.count(path) + 1);
    const body = JSON.parse(init.body || "{}");
    if (path === "/link/token/create") {
      if (body.access_token) {
        assert.equal(body.access_token, "access-sandbox-secret");
        assert.equal(Object.hasOwn(body, "products"), false);
        assert.equal(Object.hasOwn(body, "transactions"), false);
        assert.equal(Object.hasOwn(body, "webhook"), false);
      } else {
        assert.deepEqual(body.products, ["transactions"]);
        assert.equal(body.webhook, "https://brain.invalid/api/webhooks/plaid");
      }
      return jsonResponse({
        link_token: "link-sandbox-short-lived",
        expiration: "2099-08-30T13:30:00.000Z",
      });
    }
    if (path === "/item/public_token/exchange") {
      assert.equal(body.public_token, "public-sandbox-once");
      return this.exchangeAvailable
        ? jsonResponse({ item_id: "item-sandbox-1", access_token: "access-sandbox-secret" })
        : jsonResponse({ error_code: "INTERNAL_SERVER_ERROR" }, 500);
    }
    if (path === "/item/get") {
      assert.equal(body.access_token, "access-sandbox-secret");
      return this.healthAvailable
        ? jsonResponse({ item: { item_id: "item-sandbox-1", error: null } })
        : jsonResponse({ error_code: "ITEM_LOGIN_REQUIRED" }, 401);
    }
    if (path === "/accounts/get") {
      return jsonResponse({ accounts: [{
        account_id: "account-1",
        name: "Sandbox checking",
        official_name: "Sandbox Checking",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        balances: { current: "100.00", available: "88.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      if (!body.cursor) return jsonResponse({
        added: [{
          transaction_id: "pending-1",
          account_id: "account-1",
          amount: "12.34",
          iso_currency_code: "USD",
          date: "2026-08-28",
          pending: true,
          name: "Pending purchase",
        }],
        modified: [],
        removed: [],
        next_cursor: "page-2",
        has_more: true,
      });
      if (body.cursor === "page-2" && !this.mutationRaised) {
        this.mutationRaised = true;
        return jsonResponse({
          error_type: "TRANSACTIONS_ERROR",
          error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          error_message: "mutation",
        }, 400);
      }
      if (body.cursor === "page-2") return jsonResponse({
        added: [{
          transaction_id: "posted-1",
          pending_transaction_id: "pending-1",
          account_id: "account-1",
          amount: "12.34",
          unofficial_currency_code: "XBT",
          date: "2026-08-29",
          authorized_date: "2026-08-28",
          pending: false,
          name: "Posted purchase",
          merchant_name: "Sandbox Merchant",
        }],
        modified: [],
        removed: [{ transaction_id: "withdrawn-1" }],
        next_cursor: "complete-1",
        has_more: false,
      });
      if (body.cursor === "complete-1") return jsonResponse({
        added: [], modified: [], removed: [], next_cursor: "complete-2", has_more: false,
      });
      throw new Error(`unexpected sync cursor ${body.cursor}`);
    }
    if (path === "/webhook_verification_key/get") {
      return jsonResponse({ key: this.publicJwk });
    }
    if (path === "/item/remove") {
      return this.removeAvailable
        ? jsonResponse({ request_id: "removed" })
        : jsonResponse({ error_code: "INTERNAL_SERVER_ERROR" }, 500);
    }
    throw new Error(`unexpected Plaid path ${path}`);
  }
}

test("Plaid durable runtime closes response-loss, sync, webhook, fallback, and revocation boundaries", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BANK_FEED_ENTITY: "primary",
      BANK_FEED_RECONCILE_MINUTES: "360",
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    const ownerHeaders = await fixture.ownerHeaders();
    const linkUrl = new URL("https://brain.invalid/api/bank-feed/link-token");
    const linkRoute = (body) => handleBankFeed(fixture.env, new Request(linkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(body),
    }), linkUrl, linkUrl.pathname, { bankFeedFetchImpl: fetchImpl });
    const missingIdentity = await linkRoute({ mode: "connect" });
    assert.equal(missingIdentity.status, 400);
    assert.equal((await missingIdentity.json()).code, "plaid_link_request_id_required");
    assert.equal(provider.count("/link/token/create"), 0);

    // Ignore the first HTTP body to model the provider and D1 commit succeeding
    // while the browser loses the response. The same client identity must replay
    // the exact Link token without a second provider creation.
    const firstLinkResponse = await linkRoute({ request_id: "link-route-retry-0001", mode: "connect" });
    assert.equal(firstLinkResponse.status, 200);
    const firstLink = await firstLinkResponse.json();
    const replayedLinkResponse = await linkRoute({ request_id: "link-route-retry-0001", mode: "connect" });
    assert.equal(replayedLinkResponse.status, 200);
    const replayedLink = await replayedLinkResponse.json();
    assert.equal(firstLink.link_token, replayedLink.link_token);
    assert.equal(replayedLink.replayed, true);
    assert.equal(provider.count("/link/token/create"), 1);
    assert.equal(fixture.first("SELECT link_ciphertext LIKE '%link-sandbox%' AS leaked FROM plaid_link_operations").leaked, 0);

    const exchange = await completePlaidLink(fixture.env, {
      sessionRef: firstLink.session_ref,
      publicToken: "public-sandbox-once",
      institutionRef: "ins_fixture",
      institutionLabel: "Sandbox Bank",
      fetchImpl,
      now: stamp,
    });
    const replayedExchange = await completePlaidLink(fixture.env, {
      sessionRef: firstLink.session_ref,
      publicToken: "public-sandbox-once",
      fetchImpl,
      now: stamp,
    });
    assert.equal(exchange.item_ref, "item-sandbox-1");
    assert.deepEqual(replayedExchange, exchange);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first("SELECT access_ciphertext LIKE '%access-sandbox%' AS leaked FROM bank_feed_items").leaked, 0);

    const ciphertextBeforeUpdate = fixture.first(
      "SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'",
    ).access_ciphertext;
    await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      mode: "reauthorise",
      itemRef: "item-sandbox-1",
      sessionRef: "session-update-request-1",
      fetchImpl,
      now: stamp,
    });
    provider.healthAvailable = false;
    await assert.rejects(completePlaidLink(fixture.env, {
      sessionRef: "session-update-request-1",
      publicToken: "ignored-update-public-token",
      fetchImpl,
      now: stamp,
    }));
    assert.equal(fixture.first(
      "SELECT status FROM bank_feed_items WHERE item_ref='item-sandbox-1'",
    ).status, "reauth_required");
    assert.equal(fixture.first(
      "SELECT state FROM plaid_link_operations WHERE session_ref='session-update-request-1'",
    ).state, "link_completed");
    provider.healthAvailable = true;
    const updateReceipt = await completePlaidLink(fixture.env, {
      sessionRef: "session-update-request-1",
      publicToken: "ignored-update-public-token",
      fetchImpl,
      now: stamp,
    });
    assert.equal(updateReceipt.exchanged, false);
    assert.equal(updateReceipt.health_verified, true);
    assert.equal(provider.count("/item/get"), 2);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first(
      "SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'",
    ).access_ciphertext, ciphertextBeforeUpdate);

    fixture.control.failOn = /UPDATE bank_feed_items SET cursor=/;
    const interrupted = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(interrupted.ok, false);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    assert.equal(fixture.first("SELECT state FROM plaid_sync_windows WHERE item_ref='item-sandbox-1'").state, "ready");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions").n, 3);
    fixture.control.failOn = null;
    const synced = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(synced.ok, true);
    assert.equal(synced.mutationRestarts, 1);
    assert.equal(synced.resumed_promotion, true);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-1");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_windows").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_sync_stage_transactions").n, 0);
    const pending = fixture.first("SELECT pending,removed_at FROM fin_transactions WHERE external_id='pending-1'");
    const posted = fixture.first(
      `SELECT pending_transaction_id,source_iso_currency_code,source_unofficial_currency_code,
              source_provider,source_window_ref,source_page_index
         FROM fin_transactions WHERE external_id='posted-1'`,
    );
    assert.equal(pending.pending, 1);
    assert.ok(pending.removed_at);
    assert.equal(posted.pending_transaction_id, "pending-1");
    assert.equal(posted.source_unofficial_currency_code, "XBT");
    assert.equal(posted.source_provider, "plaid");
    assert.ok(posted.source_window_ref);
    assert.equal(posted.source_page_index, 1);

    const rawBody = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-sandbox-1",
    });
    const issuedAt = Math.floor(Date.parse(stamp) / 1000);
    const publicRouteRefusal = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/webhooks/plaid",
      { method: "POST", body: rawBody },
    ), fixture.env, { waitUntil() {} });
    assert.equal(publicRouteRefusal.status, 401);
    const signed = await signedWebhook(rawBody, issuedAt);
    provider.publicJwk = signed.publicJwk;
    const request = () => new Request("https://brain.invalid/api/webhooks/plaid", {
      method: "POST",
      headers: { "Plaid-Verification": signed.jwt, "Content-Type": "application/json" },
      body: rawBody,
    });
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_webhook_events").n, 1);
    assert.equal(fixture.first("SELECT state FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'").state, "pending");

    const scheduled = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(scheduled.ran, 1);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-2");

    const firstDisconnect = await disconnectPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(firstDisconnect.revocation_state, "retryable");
    assert.notEqual(fixture.first("SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'").access_ciphertext,
      "REMOVED0000000000000000");
    provider.removeAvailable = true;
    fixture.raw("UPDATE plaid_revocation_outbox SET next_attempt_at=? WHERE item_ref='item-sandbox-1'", stamp);
    const drained = await drainPlaidRevocations(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(drained.items[0].confirmed, true);
    assert.equal(fixture.first("SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'").access_ciphertext,
      "REMOVED0000000000000000");
    const status = await plaidFeedStatus(fixture.env);
    assert.equal(status.provider, "plaid");
    assert.equal(status.environment, "sandbox");
  } finally {
    fixture.close();
  }
});

test("a lost public-token exchange response is single-shot and explicitly recoverable", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new PlaidSandboxFake();
  provider.exchangeAvailable = false;
  const fetchImpl = provider.fetch.bind(provider);
  const ownerHeaders = await fixture.ownerHeaders();
  const route = async (path, body) => {
    const url = new URL(`https://brain.invalid${path}`);
    return handleBankFeed(fixture.env, new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(body),
    }), url, path, { bankFeedFetchImpl: fetchImpl });
  };
  try {
    const link = await (await route("/api/bank-feed/link-token", {
      request_id: "lost-exchange-route-0001",
      mode: "connect",
    })).json();
    const exchangeBody = {
      session_ref: link.session_ref,
      public_token: "public-sandbox-once",
    };
    const first = await route("/api/bank-feed/exchange", exchangeBody);
    assert.equal(first.status, 503);
    const firstBody = await first.json();
    assert.equal(firstBody.code, "PLAID_EXCHANGE_OUTCOME_UNKNOWN");
    assert.equal(firstBody.outcome_unknown, true);
    assert.equal(firstBody.retry_safe, false);
    assert.match(firstBody.recovery, /review this connection/);
    assert.equal(provider.count("/item/public_token/exchange"), 1);

    const replay = await route("/api/bank-feed/exchange", exchangeBody);
    assert.equal(replay.status, 503);
    assert.equal((await replay.json()).outcome_unknown, true);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first(
      "SELECT state FROM plaid_link_operations WHERE session_ref='lost-exchange-route-0001'",
    ).state, "exchange_started");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM bank_feed_items").n, 0);
  } finally {
    fixture.close();
  }
});
