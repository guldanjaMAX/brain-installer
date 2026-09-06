import test from "node:test";
import assert from "node:assert/strict";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import {
  completePlaidLink,
  createPlaidLinkToken,
} from "../src/lib/plaid-bank-feed.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

class ScheduledPlaidFake {
  constructor() {
    this.failSync = true;
    this.calls = [];
  }

  async fetch(input, init = {}) {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init.body || "{}"));
    this.calls.push(path);
    if (path === "/link/token/create") {
      return json({
        link_token: "link-sandbox-scheduled",
        expiration: "2099-08-30T13:30:00.000Z",
      });
    }
    if (path === "/item/public_token/exchange") {
      assert.equal(body.public_token, "public-sandbox-scheduled");
      return json({ item_id: "item-scheduled-1", access_token: "access-sandbox-scheduled" });
    }
    if (path === "/accounts/get") {
      if (this.failSync) return json({ error_code: "INTERNAL_SERVER_ERROR" }, 503);
      return json({ accounts: [{
        account_id: "account-scheduled-1",
        name: "Scheduled checking",
        mask: "9876",
        type: "depository",
        subtype: "checking",
        balances: { current: "123.45", available: "120.00", iso_currency_code: "USD" },
      }] });
    }
    if (path === "/transactions/sync") {
      return json({
        added: [{
          transaction_id: "scheduled-transaction-1",
          account_id: "account-scheduled-1",
          amount: "8.25",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Scheduled fixture purchase",
        }],
        modified: [],
        removed: [],
        next_cursor: "scheduled-cursor-1",
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      });
    }
    throw new Error(`unexpected provider call ${path}`);
  }
}

async function runScheduled(worker, env) {
  let work = null;
  await worker.scheduled({}, env, {
    waitUntil(promise) { work = promise; },
  });
  assert.ok(work, "the Worker must register its scheduled work with waitUntil");
  await work;
}

test("the actual Worker cron retries a failed Plaid refresh, waits for owner scope, and resumes once", async () => {
  const fixture = await createProductFixture({
    env: {
      BANK_FEED_PROVIDER: "plaid",
      BANK_FEED_ENV: "sandbox",
      BANK_FEED_CLIENT_ID: "fixture-client-id",
      BANK_FEED_SECRET: "fixture-secret",
      BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
      BANK_FEED_RECONCILE_MINUTES: "360",
      BRAIN_NAME: "Scheduled Fixture Brain",
    },
  });
  const provider = new ScheduledPlaidFake();
  const providerFetch = provider.fetch.bind(provider);
  const stamp = "2026-08-30T13:00:00.000Z";
  const previousFetch = globalThis.fetch;
  try {
    seedOwnedEntity(fixture, "scheduled-company", "Scheduled Company");
    const link = await createPlaidLinkToken(fixture.env, {
      url: "https://brain.invalid/app/connect/bank",
      sessionRef: "scheduled-link-request-0001",
      fetchImpl: providerFetch,
      now: stamp,
    });
    await completePlaidLink(fixture.env, {
      sessionRef: link.session_ref,
      publicToken: "public-sandbox-scheduled",
      institutionRef: "ins_scheduled",
      institutionLabel: "Scheduled Fixture Bank",
      fetchImpl: providerFetch,
      now: stamp,
    });
    fixture.raw(
      "UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z' WHERE item_ref='item-scheduled-1'",
    );

    globalThis.fetch = providerFetch;
    await runScheduled(fixture.worker, fixture.env);
    const failed = fixture.first(
      "SELECT state,attempts,last_error_code FROM plaid_reconciliation WHERE item_ref='item-scheduled-1'",
    );
    assert.equal(failed.state, "retryable");
    assert.equal(failed.attempts, 1);
    assert.equal(fixture.first(
      "SELECT cursor FROM bank_feed_items WHERE item_ref='item-scheduled-1'",
    ).cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);

    provider.failSync = false;
    fixture.raw(
      "UPDATE plaid_reconciliation SET due_at='2000-01-01T00:00:00.000Z' WHERE item_ref='item-scheduled-1'",
    );
    await runScheduled(fixture.worker, fixture.env);

    assert.equal(fixture.first(
      "SELECT cursor FROM bank_feed_items WHERE item_ref='item-scheduled-1'",
    ).cursor, null);
    assert.equal(fixture.first("SELECT COUNT(*) AS n FROM fin_transactions").n, 0);
    const accountRef = fixture.first(
      "SELECT account_ref FROM plaid_account_entity_assignments WHERE item_ref='item-scheduled-1'",
    ).account_ref;
    const ownerHeaders = await fixture.ownerHeaders();
    const assignment = await fixture.post("/api/bank-feed/accounts/assign", {
      request_id: "scheduled-assignment-request-0001",
      account_ref: accountRef,
      entity_slug: "scheduled-company",
    }, ownerHeaders);
    assert.equal(assignment.status, 201);
    assert.equal(fixture.waitUntil.length, 1);
    await Promise.all(fixture.waitUntil);

    assert.equal(fixture.first(
      "SELECT cursor FROM bank_feed_items WHERE item_ref='item-scheduled-1'",
    ).cursor, "scheduled-cursor-1");
    assert.equal(fixture.first(
      "SELECT COUNT(*) AS n FROM fin_transactions WHERE external_id='scheduled-transaction-1'",
    ).n, 1);
    assert.equal(fixture.first(
      "SELECT state FROM plaid_reconciliation WHERE item_ref='item-scheduled-1'",
    ).state, "pending");
    assert.equal(provider.calls.filter((path) => path === "/transactions/sync").length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.close();
  }
});
