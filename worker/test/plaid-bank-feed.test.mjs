import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedCounterparty, seedOwnedEntity } from "./product-contract-fixture.mjs";
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
    this.exchangeDelayMs = 0;
    this.healthAvailable = true;
    this.historySequence = null;
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
      if (this.exchangeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.exchangeDelayMs));
      }
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
      if (Array.isArray(this.historySequence) && this.historySequence.length > 0) {
        const state = this.historySequence.shift();
        return jsonResponse({
          added: [],
          modified: [],
          removed: [],
          next_cursor: `history-${this.count("/transactions/sync")}`,
          has_more: false,
          transactions_update_status: state,
        });
      }
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
        transactions_update_status: "INITIAL_UPDATE_COMPLETE",
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
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
      if (body.cursor === "complete-1") return jsonResponse({
        added: [], modified: [], removed: [], next_cursor: "complete-2", has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
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

class MultiEntityPlaidFake extends PlaidSandboxFake {
  async fetch(url, init) {
    const path = new URL(url).pathname;
    if (path !== "/accounts/get" && path !== "/transactions/sync") {
      return super.fetch(url, init);
    }
    this.calls.set(path, this.count(path) + 1);
    if (path === "/accounts/get") {
      return jsonResponse({ accounts: [
        {
          account_id: "household-account-internal",
          name: "Household checking",
          mask: "1111",
          type: "depository",
          subtype: "checking",
          balances: { current: "1000.00", available: "900.00", iso_currency_code: "USD" },
        },
        {
          account_id: "business-account-internal",
          name: "Business card",
          mask: "2222",
          type: "credit",
          subtype: "credit card",
          balances: { current: "200.00", available: "800.00", iso_currency_code: "USD" },
        },
      ] });
    }
    return jsonResponse({
      added: [
        {
          transaction_id: "household-transaction-internal",
          account_id: "household-account-internal",
          amount: "20.00",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Household fixture",
        },
        {
          transaction_id: "business-transaction-internal",
          account_id: "business-account-internal",
          amount: "30.00",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Business fixture",
        },
      ],
      modified: [],
      removed: [],
      next_cursor: "multi-entity-complete",
      has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    });
  }
}

test("bank connect navigation accepts the owner cookie while every API still requires the app header", async () => {
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
  try {
    const ownerHeaders = await fixture.ownerHeaders();
    const navigationHeaders = { Cookie: ownerHeaders.Cookie };
    const pageUrl = new URL("https://brain.invalid/app/connect/bank");
    const page = await handleBankFeed(fixture.env, new Request(pageUrl, {
      headers: navigationHeaders,
    }), pageUrl, pageUrl.pathname, {});
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control"), /private, no-store/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /X-Brain-App/);
    assert.match(html, /Choose where each account belongs/);

    const accountsUrl = new URL("https://brain.invalid/api/bank-feed/accounts");
    const cookieOnlyApi = await handleBankFeed(fixture.env, new Request(accountsUrl, {
      headers: navigationHeaders,
    }), accountsUrl, accountsUrl.pathname, {});
    assert.equal(cookieOnlyApi.status, 401);
    assert.equal((await cookieOnlyApi.json()).code, "session_required");

    const authenticatedApi = await handleBankFeed(fixture.env, new Request(accountsUrl, {
      headers: ownerHeaders,
    }), accountsUrl, accountsUrl.pathname, {});
    assert.equal(authenticatedApi.status, 200);
    assert.deepEqual((await authenticatedApi.json()).accounts, []);

    const scopedHeaders = await fixture.ownerHeaders({ grantId: "grant-fixture" });
    const scopedPage = await handleBankFeed(fixture.env, new Request(pageUrl, {
      headers: { Cookie: scopedHeaders.Cookie },
    }), pageUrl, pageUrl.pathname, {});
    assert.equal(scopedPage.status, 403);
    assert.match(await scopedPage.text(), /Only the owner/);
  } finally {
    fixture.close();
  }
});

test("the final owner account assignment immediately resumes the staged Plaid import", async () => {
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
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    seedOwnedEntity(fixture, "fixture-company", "Fixture Company");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "assignment-resume-link-0001",
      fetchImpl,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-once",
      fetchImpl,
      now: stamp,
    });
    const staged = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(staged.items[0].status, "assignment_required");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-sandbox-1'",
    ).account_ref;
    const ownerHeaders = await fixture.ownerHeaders();
    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assignmentBody = {
      request_id: "assignment-resume-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    };
    const background = [];
    const response = await handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(assignmentBody),
    }), assignUrl, assignUrl.pathname, {
      bankFeedFetchImpl: fetchImpl,
      waitUntil(promise) { background.push(Promise.resolve(promise)); },
    });
    assert.equal(response.status, 201);
    assert.equal(background.length, 1);
    const replayBackground = [];
    const replay = await handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(assignmentBody),
    }), assignUrl, assignUrl.pathname, {
      bankFeedFetchImpl: fetchImpl,
      waitUntil(promise) { replayBackground.push(Promise.resolve(promise)); },
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    assert.equal(replayBackground.length, 0);
    await Promise.all(background);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-1");
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 2);
    assert.equal(fixture.first(
      "SELECT entity_slug FROM fin_accounts WHERE external_ref='account-1'",
    ).entity_slug, "fixture-company");
  } finally {
    fixture.close();
  }
});

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
    seedOwnedEntity(fixture, "fixture-company", "Fixture Company");
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

    const unassigned = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(unassigned.ok, false);
    assert.equal(unassigned.status, "assignment_required");
    assert.equal(unassigned.cursor_advanced, false);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);

    assert.equal(fixture.first("SELECT state FROM plaid_sync_windows WHERE item_ref='item-sandbox-1'").state, "ready");
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-sandbox-1'",
    ).account_ref;

    const statusUrl = new URL("https://brain.invalid/api/bank-feed/accounts");
    const statusResponse = await handleBankFeed(fixture.env, new Request(statusUrl, {
      headers: ownerHeaders,
    }), statusUrl, statusUrl.pathname, {});
    assert.equal(statusResponse.status, 200);
    const ownerStatus = await statusResponse.json();
    assert.equal(ownerStatus.state, "assignment_required");
    assert.equal(ownerStatus.accounts[0].account_ref, accountRef);
    assert.equal(ownerStatus.accounts[0].assignment.state, "assignment_required");
    assert.match(ownerStatus.accounts[0].masked_identifier, /ending 1234/);
    assert.equal(JSON.stringify(ownerStatus).includes("item-sandbox-1"), false);
    assert.equal(JSON.stringify(ownerStatus).includes("account-1"), false);

    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assign = (body, headers = ownerHeaders) => handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }), assignUrl, assignUrl.pathname, {});
    const noAdminFallback = await assign({
      request_id: "assign-account-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    }, { "X-Admin-Key": fixture.env.ADMIN_KEY });
    assert.equal(noAdminFallback.status, 401);
    const assignment = await assign({
      request_id: "assign-account-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    });
    assert.equal(assignment.status, 201);
    assert.equal((await assignment.json()).changed, true);
    const assignmentReplay = await assign({
      request_id: "assign-account-request-0001",
      account_ref: accountRef,
      entity_slug: "fixture-company",
    });
    assert.equal(assignmentReplay.status, 200);
    assert.equal((await assignmentReplay.json()).replayed, true);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_activity_events WHERE event_type='bank_account_entity_assigned'",
    ).n, 1);

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
    assert.equal(fixture.first(
      "SELECT entity_slug FROM fin_accounts WHERE external_ref='account-1'",
    ).entity_slug, "fixture-company");

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
    signed.publicJwk.expired_at = issuedAt + 60;
    provider.publicJwk = signed.publicJwk;
    const request = () => new Request("https://brain.invalid/api/webhooks/plaid", {
      method: "POST",
      headers: { "Plaid-Verification": signed.jwt, "Content-Type": "application/json" },
      body: rawBody,
    });
    fixture.raw("DELETE FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'");
    fixture.control.failNextBatch = true;
    await assert.rejects(handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp }));
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_webhook_events").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_reconciliation").n, 0);

    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_webhook_events").n, 1);
    assert.equal(fixture.first("SELECT state FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'").state, "pending");
    assert.equal(fixture.first(
      "SELECT expires_at FROM plaid_webhook_keys WHERE key_id='fixture-plaid-key'",
    ).expires_at, new Date((issuedAt + 60) * 1000).toISOString());
    assert.equal(provider.count("/webhook_verification_key/get"), 1);

    fixture.raw("DELETE FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'");
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(fixture.first(
      "SELECT reason FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'",
    ).reason, "webhook_replay_repair");
    assert.equal(provider.count("/webhook_verification_key/get"), 1);

    fixture.raw(
      "UPDATE plaid_webhook_keys SET expires_at='2026-08-30T12:59:59.000Z' WHERE key_id='fixture-plaid-key'",
    );
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 200);
    assert.equal(provider.count("/webhook_verification_key/get"), 2);

    fixture.raw("DELETE FROM plaid_webhook_keys WHERE key_id='fixture-plaid-key'");
    provider.publicJwk.expired_at = issuedAt - 1;
    assert.equal((await handlePlaidWebhook(fixture.env, request(), { fetchImpl, now: stamp })).status, 401);
    assert.equal(provider.count("/webhook_verification_key/get"), 3);
    provider.publicJwk.expired_at = issuedAt + 60;

    const scheduled = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(scheduled.ran, 1);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items WHERE item_ref='item-sandbox-1'").cursor, "complete-2");

    const firstDisconnect = await disconnectPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(firstDisconnect.revocation_state, "unknown");
    assert.equal(firstDisconnect.outcome_unknown, true);
    assert.equal(firstDisconnect.retry_safe, false);
    assert.equal(provider.count("/item/remove"), 1);
    assert.equal(fixture.first(
      "SELECT outcome_state FROM plaid_revocation_outbox WHERE item_ref='item-sandbox-1'",
    ).outcome_state, "unknown");
    assert.notEqual(fixture.first("SELECT access_ciphertext FROM bank_feed_items WHERE item_ref='item-sandbox-1'").access_ciphertext,
      "REMOVED0000000000000000");
    provider.healthAvailable = false;
    fixture.raw("UPDATE plaid_revocation_outbox SET next_attempt_at=? WHERE item_ref='item-sandbox-1'", stamp);
    const unresolved = await drainPlaidRevocations(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(unresolved.items[0].outcome_unknown, true);
    assert.equal(provider.count("/item/remove"), 1);
    provider.healthAvailable = true;
    provider.removeAvailable = true;
    fixture.raw("UPDATE plaid_revocation_outbox SET next_attempt_at=? WHERE item_ref='item-sandbox-1'", stamp);
    const drained = await drainPlaidRevocations(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(drained.items[0].confirmed, true);
    assert.equal(drained.items[0].outcome_state, "confirmed");
    assert.equal(provider.count("/item/remove"), 2);
    assert.equal(provider.count("/item/get"), 4);
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

test("concurrent exchange retries atomically claim one single-use public token", async () => {
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
  provider.exchangeDelayMs = 25;
  const fetchImpl = provider.fetch.bind(provider);
  const ownerHeaders = await fixture.ownerHeaders();
  const route = (path, body) => {
    const url = new URL(`https://brain.invalid${path}`);
    return handleBankFeed(fixture.env, new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify(body),
    }), url, path, { bankFeedFetchImpl: fetchImpl });
  };
  try {
    const link = await (await route("/api/bank-feed/link-token", {
      request_id: "concurrent-exchange-0001",
      mode: "connect",
    })).json();
    const exchangeBody = {
      session_ref: link.session_ref,
      public_token: "public-sandbox-once",
    };
    const responses = await Promise.all([
      route("/api/bank-feed/exchange", exchangeBody),
      route("/api/bank-feed/exchange", exchangeBody),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 503]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const unknown = bodies.find((body) => body.outcome_unknown === true);
    assert.equal(unknown.code, "PLAID_EXCHANGE_OUTCOME_UNKNOWN");
    assert.equal(unknown.retry_safe, false);
    assert.equal(provider.count("/item/public_token/exchange"), 1);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM bank_feed_items").n, 1);

    const durableReplay = await route("/api/bank-feed/exchange", exchangeBody);
    assert.equal(durableReplay.status, 200);
    assert.equal((await durableReplay.json()).item_ref, "item-sandbox-1");
    assert.equal(provider.count("/item/public_token/exchange"), 1);
  } finally {
    fixture.close();
  }
});

test("empty Transactions Sync stays partial through NOT_READY and INITIAL provider states", async () => {
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
  provider.historySequence = [
    "NOT_READY",
    "INITIAL_UPDATE_COMPLETE",
    "HISTORICAL_UPDATE_COMPLETE",
  ];
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    seedOwnedEntity(fixture, "fixture-company", "Fixture Company");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "empty-history-link-0001",
      fetchImpl,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-once",
      fetchImpl,
      now: stamp,
    });
    fixture.raw(
      `INSERT INTO bank_feed_backfill
         (tenant_id,item_ref,requested_days,state,queued_at,started_at,provider_history_state)
       VALUES ('primary','item-sandbox-2',730,'running',?,?,?)`,
      stamp, stamp, "NOT_READY",
    );

    const firstSlice = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(firstSlice.ran, 1);
    assert.equal(firstSlice.items[0].status, "assignment_required");
    assert.equal(firstSlice.items[0].cursor_advanced, false);
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-sandbox-1'",
    ).account_ref;
    const ownerHeaders = await fixture.ownerHeaders();
    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assigned = await handleBankFeed(fixture.env, new Request(assignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        request_id: "empty-history-assignment-0001",
        account_ref: accountRef,
        entity_slug: "fixture-company",
      }),
    }), assignUrl, assignUrl.pathname, {});
    assert.equal(assigned.status, 201);

    const notReady = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(notReady.ok, false);
    assert.equal(notReady.partial, true);
    assert.equal(notReady.history_state, "running");
    assert.equal(notReady.provider_history_state, "NOT_READY");
    const notReadyBackfill = fixture.first(
      "SELECT state,provider_history_state,finished_at FROM bank_feed_backfill WHERE item_ref='item-sandbox-1'",
    );
    assert.equal(notReadyBackfill.state, "running");
    assert.equal(notReadyBackfill.provider_history_state, "NOT_READY");
    assert.equal(notReadyBackfill.finished_at, null);
    assert.equal(fixture.first(
      "SELECT reason FROM plaid_reconciliation WHERE item_ref='item-sandbox-1'",
    ).reason, "history_pending");
    const partialStatus = await plaidFeedStatus(fixture.env);
    assert.equal(partialStatus.connections[0].history.state, "running");
    assert.equal(partialStatus.connections[0].history.provider_history_state, "NOT_READY");
    assert.equal(partialStatus.connections[0].history.partial, true);

    const initial = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(initial.ok, false);
    assert.equal(initial.partial, true);
    assert.equal(initial.history_state, "running");
    assert.equal(initial.provider_history_state, "INITIAL_UPDATE_COMPLETE");
    assert.equal(fixture.first(
      "SELECT provider_history_state FROM bank_feed_backfill WHERE item_ref='item-sandbox-1'",
    ).provider_history_state, "INITIAL_UPDATE_COMPLETE");

    const historical = await syncPlaidItem(fixture.env, "item-sandbox-1", { fetchImpl, now: stamp });
    assert.equal(historical.ok, true);
    assert.equal(historical.partial, false);
    assert.equal(historical.history_state, "complete");
    assert.equal(historical.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
    const completeBackfill = fixture.first(
      "SELECT state,provider_history_state,finished_at FROM bank_feed_backfill WHERE item_ref='item-sandbox-1'",
    );
    assert.equal(completeBackfill.state, "complete");
    assert.equal(completeBackfill.provider_history_state, "HISTORICAL_UPDATE_COMPLETE");
    assert.equal(completeBackfill.finished_at, stamp);
    const untouchedItem = fixture.first(
      "SELECT state,provider_history_state,finished_at FROM bank_feed_backfill WHERE item_ref='item-sandbox-2'",
    );
    assert.equal(untouchedItem.state, "running");
    assert.equal(untouchedItem.provider_history_state, "NOT_READY");
    assert.equal(untouchedItem.finished_at, null);
  } finally {
    fixture.close();
  }
});

test("scheduled promotion keeps two Plaid accounts in their exact owner-confirmed entities", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      // This legacy Item-level value is intentionally wrong. Promotion must
      // never consult it or fall back to primary.
      BANK_FEED_ENTITY: "wrong-default",
      BRAIN_NAME: "Sandbox Brain",
    },
  });
  const provider = new MultiEntityPlaidFake();
  const fetchImpl = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  try {
    seedOwnedEntity(fixture, "household", "Household");
    seedOwnedEntity(fixture, "operating-company", "Operating Company");
    seedOwnedEntity(fixture, "closed-company", "Closed Company");
    seedCounterparty(fixture, "outside-buyer");
    fixture.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='closed-company'");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "multi-entity-link-0001",
      fetchImpl,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-once",
      institutionLabel: "Two-Scope Bank",
      fetchImpl,
      now: stamp,
    });

    const staged = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(staged.items[0].status, "assignment_required");
    assert.equal(staged.items[0].assignments_remaining, 2);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_accounts").n, 0);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);

    // Schema 30 can arrive after an older Worker has staged a ready window.
    // Rebuild only the opaque owner refs from D1, without another provider read,
    // and keep the cursor blocked for assignment.
    const accountReadsBeforeResume = provider.count("/accounts/get");
    fixture.raw("DELETE FROM plaid_account_entity_assignments");
    const resumedInventory = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(resumedInventory.items[0].status, "assignment_required");
    assert.equal(resumedInventory.items[0].assignments_remaining, 2);
    assert.equal(provider.count("/accounts/get"), accountReadsBeforeResume);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM plaid_account_entity_assignments").n, 2);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);

    const refs = fixture.rows(
      "SELECT provider_account_id,account_ref FROM plaid_account_entity_assignments ORDER BY provider_account_id",
    );
    const byProvider = Object.fromEntries(refs.map((row) => [row.provider_account_id, row.account_ref]));
    const ownerHeaders = await fixture.ownerHeaders();
    const assignUrl = new URL("https://brain.invalid/api/bank-feed/accounts/assign");
    const assign = (requestId, accountRef, entitySlug) => handleBankFeed(
      fixture.env,
      new Request(assignUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ownerHeaders },
        body: JSON.stringify({ request_id: requestId, account_ref: accountRef, entity_slug: entitySlug }),
      }),
      assignUrl,
      assignUrl.pathname,
      {},
    );

    const closed = await assign(
      "multi-entity-closed-0001",
      byProvider["business-account-internal"],
      "closed-company",
    );
    assert.equal(closed.status, 404);
    const counterparty = await assign(
      "multi-entity-counterparty-0001",
      byProvider["business-account-internal"],
      "outside-buyer",
    );
    assert.equal(counterparty.status, 403);
    assert.equal((await counterparty.json()).code, "entity_not_owned");

    const household = await assign(
      "multi-entity-household-0001",
      byProvider["household-account-internal"],
      "household",
    );
    assert.equal(household.status, 201);
    const requestConflict = await assign(
      "multi-entity-household-0001",
      byProvider["household-account-internal"],
      "operating-company",
    );
    assert.equal(requestConflict.status, 409);
    assert.equal((await requestConflict.json()).code, "request_id_conflict");
    const unchanged = await assign(
      "multi-entity-household-unchanged-0001",
      byProvider["household-account-internal"],
      "household",
    );
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), {
      assigned: true,
      request_id: "multi-entity-household-unchanged-0001",
      account_ref: byProvider["household-account-internal"],
      masked_identifier: "Household checking ending 1111",
      entity_scope: { entity_slug: "household" },
      entity_label: "Household",
      changed: false,
      activity_event_id: null,
      replayed: false,
    });

    // Model a commit failure before any assignment/event/receipt can land,
    // followed by an unchanged retry carrying the same identity.
    fixture.control.failNextBatch = true;
    const lost = await assign(
      "multi-entity-business-0001",
      byProvider["business-account-internal"],
      "operating-company",
    );
    assert.equal(lost.status, 503);
    assert.equal(fixture.first(
      "SELECT entity_slug FROM plaid_account_entity_assignments WHERE provider_account_id='business-account-internal'",
    ).entity_slug, null);
    const business = await assign(
      "multi-entity-business-0001",
      byProvider["business-account-internal"],
      "operating-company",
    );
    assert.equal(business.status, 201);
    const businessBody = await business.json();
    assert.equal(businessBody.account_ref, byProvider["business-account-internal"]);
    assert.equal(JSON.stringify(businessBody).includes("business-account-internal"), false);

    // A scope that becomes non-live after assignment blocks the already-ready
    // window. Restoring that reviewed entity lets the same scheduled debt
    // promote without asking Plaid for another page.
    fixture.raw("UPDATE fin_entities SET status='closed' WHERE entity_slug='operating-company'");
    const invalidScope = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(invalidScope.items[0].status, "assignment_required");
    assert.equal(invalidScope.items[0].invalid_assignments, 1);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    fixture.raw("UPDATE fin_entities SET status='active' WHERE entity_slug='operating-company'");

    const promoted = await runPlaidFeedSlice(fixture.env, { maxItems: 1, fetchImpl, now: stamp });
    assert.equal(promoted.items[0].ok, true);
    assert.equal(fixture.first("SELECT cursor FROM bank_feed_items").cursor, "multi-entity-complete");
    const assignments = fixture.rows(
      `SELECT f.external_ref,f.entity_slug,t.external_id
         FROM fin_accounts f JOIN fin_transactions t
           ON t.tenant_id=f.tenant_id AND t.account_slug=f.account_slug
        ORDER BY f.external_ref`,
    ).map((row) => ({ ...row }));
    assert.deepEqual(assignments, [
      {
        external_ref: "business-account-internal",
        entity_slug: "operating-company",
        external_id: "business-transaction-internal",
      },
      {
        external_ref: "household-account-internal",
        entity_slug: "household",
        external_id: "household-transaction-internal",
      },
    ]);
    assert.equal(assignments.some((row) => row.entity_slug === "wrong-default" || row.entity_slug === "primary"), false);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_activity_events WHERE event_type='bank_account_entity_assigned'",
    ).n, 2);

    // A ledger row lands after preflight but before the assignment batch. The
    // in-batch guard refuses historical reclassification. A retry gives the
    // same stable code and neither attempt creates a receipt or human event.
    fixture.raw("DELETE FROM fin_transactions WHERE external_id='business-transaction-internal'");
    const originalDb = fixture.env.DB;
    let injectedHistory = false;
    fixture.env.DB = {
      ...originalDb,
      async batch(statements) {
        if (!injectedHistory) {
          injectedHistory = true;
          const businessAccountSlug = fixture.first(
            "SELECT account_slug FROM fin_accounts WHERE external_ref='business-account-internal'",
          ).account_slug;
          fixture.raw(
            `INSERT INTO fin_transactions
               (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,currency,
                description,provenance,source_feed,basis_state,recorded_at)
             VALUES ('primary','plaid:assignment-race',?,'2026-08-30',100,'outflow','USD',
                     'Synthetic assignment race','feed','bank-feed:item-sandbox-1','confirmed',?)`,
            businessAccountSlug,
            stamp,
          );
        }
        return originalDb.batch(statements);
      },
    };
    let raced;
    try {
      raced = await assign(
        "multi-entity-race-0001",
        byProvider["business-account-internal"],
        "household",
      );
    } finally {
      fixture.env.DB = originalDb;
    }
    assert.equal(raced.status, 409);
    assert.equal((await raced.json()).code, "bank_account_reassignment_requires_review");
    const racedRetry = await assign(
      "multi-entity-race-0001",
      byProvider["business-account-internal"],
      "household",
    );
    assert.equal(racedRetry.status, 409);
    assert.equal((await racedRetry.json()).code, "bank_account_reassignment_requires_review");
    assert.equal(fixture.first(
      "SELECT entity_slug FROM plaid_account_entity_assignments WHERE provider_account_id='business-account-internal'",
    ).entity_slug, "operating-company");
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_action_requests WHERE request_id='multi-entity-race-0001'",
    ).n, 0);
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM owner_activity_events WHERE request_id='multi-entity-race-0001'",
    ).n, 0);
  } finally {
    fixture.close();
  }
});

test("owner account status reports D1 failure as unavailable instead of empty", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
    },
  });
  try {
    const ownerHeaders = await fixture.ownerHeaders();
    fixture.control.failOn = /FROM bank_feed_items i\s+WHERE i\.tenant_id=\?/;
    const response = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/bank-feed/accounts",
      { headers: ownerHeaders },
    ), fixture.env, { waitUntil() {} });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "unavailable");
    assert.equal(body.code, "bank_account_status_unavailable");
    assert.equal(body.unavailable, true);
    assert.equal(Object.hasOwn(body, "accounts"), false);
  } finally {
    fixture.close();
  }
});

test("owner account status refuses a partial inventory that could hide another Item", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
    },
  });
  try {
    for (const [itemRef, label] of [
      ["item-with-inventory", "Visible fixture bank"],
      ["item-without-inventory", "Missing fixture bank"],
    ]) {
      fixture.raw(
        `INSERT INTO bank_feed_items
           (tenant_id,item_ref,institution_label,access_ciphertext,access_iv,key_version,
            environment,status,connected_at)
         VALUES ('primary',?,?,'AAAAAAAAAAAAAAAA','BBBBBBBB',2,
                 'sandbox','connected','2026-08-30T00:00:00Z')`,
        itemRef,
        label,
      );
    }
    fixture.raw(
      `INSERT INTO plaid_account_entity_assignments
         (tenant_id,item_ref,provider_account_id,account_ref,entity_slug,
          discovered_at,last_seen_at,assigned_at,updated_at)
       VALUES ('primary','item-with-inventory','provider-account-private',
               'acct_0123456789abcdef0123456789abcdef',NULL,
               '2026-08-30T00:00:00Z','2026-08-30T00:00:00Z',NULL,
               '2026-08-30T00:00:00Z')`,
    );
    const ownerHeaders = await fixture.ownerHeaders();
    const response = await fixture.worker.fetch(new Request(
      "https://brain.invalid/api/bank-feed/accounts",
      { headers: ownerHeaders },
    ), fixture.env, { waitUntil() {} });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "unavailable");
    assert.equal(body.code, "plaid_account_inventory_unavailable");
    assert.equal(body.unavailable, true);
    assert.equal(Object.hasOwn(body, "accounts"), false);
    assert.equal(JSON.stringify(body).includes("item-without-inventory"), false);
  } finally {
    fixture.close();
  }
});
