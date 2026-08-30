import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAID_PROFILE, bankFeedProfile } from "../src/lib/bank-feed-profiles.js";
import { bankFeedConfig, bankFeedEnabled, connectPageHtml } from "../src/lib/bank-feed.js";
import {
  PlaidProtocolError,
  buildPlaidLinkTokenRequest,
  plaidExchangeDecision,
  plaidLinkCompletion,
  plaidLinkTokenDecision,
  plaidRevocationTransition,
  plaidWebhookDisposition,
  stagePlaidSyncWindow,
  verifyPlaidWebhook,
} from "../src/lib/plaid-protocol.js";
import { runPlaidLiveSandbox, runPlaidSandboxRehearsal } from "../../operations/plaid-sandbox-runner.mjs";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(name);
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL  ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push(name);
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL  ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

check("Plaid profile pins public sandbox and production endpoints", () => {
  assert.deepEqual(PLAID_PROFILE.apiBases, {
    sandbox: "https://sandbox.plaid.com",
    production: "https://production.plaid.com",
  });
});

check("Plaid profile supplies no credential", () => {
  const profile = bankFeedProfile({ BANK_FEED_PROVIDER: "plaid" }, "sandbox");
  assert.equal(profile.provider, "plaid");
  assert.equal(profile.apiBase, "https://sandbox.plaid.com");
  assert.equal(JSON.stringify(profile).includes("secret"), false);
});

check("named Plaid profile reaches the bank-feed runtime only with credentials", () => {
  const uncredentialed = { BANK_FEED_PROVIDER: "plaid", BANK_FEED_ENV: "sandbox" };
  assert.equal(bankFeedEnabled(uncredentialed), false);
  const configured = {
    ...uncredentialed,
    BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  };
  assert.equal(bankFeedEnabled(configured), true);
  const runtime = bankFeedConfig(configured);
  assert.equal(runtime.provider, "plaid");
  assert.equal(runtime.apiBase, "https://sandbox.plaid.com");
  assert.equal(runtime.linkGlobal, "Plaid");
});

check("Plaid Link CSP permits only the selected environment API origin", () => {
  const base = {
    BANK_FEED_PROVIDER: "plaid",
    BANK_FEED_CLIENT_ID: "fixture-client-id",
    BANK_FEED_SECRET: "fixture-secret",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`,
  };
  const sandbox = connectPageHtml(bankFeedConfig({ ...base, BANK_FEED_ENV: "sandbox" })).csp;
  const production = connectPageHtml(bankFeedConfig({ ...base, BANK_FEED_ENV: "production" })).csp;
  assert.match(sandbox, /connect-src 'self' https:\/\/sandbox\.plaid\.com https:\/\/cdn\.plaid\.com/);
  assert.doesNotMatch(sandbox, /production\.plaid\.com/);
  assert.match(production, /connect-src 'self' https:\/\/production\.plaid\.com https:\/\/cdn\.plaid\.com/);
  assert.doesNotMatch(production, /sandbox\.plaid\.com/);
});

check("an explicit custom endpoint remains explicit", () => {
  const profile = bankFeedProfile({
    BANK_FEED_PROVIDER: "custom",
    BANK_FEED_API_BASE: "https://provider.example",
    BANK_FEED_LINK_SDK_URL: "https://provider.example/link.js",
    BANK_FEED_LINK_GLOBAL: "ProviderLink",
  }, "sandbox");
  assert.equal(profile.provider, "custom");
  assert.equal(profile.apiBase, "https://provider.example");
});

check("manifest schema names Plaid without accepting Plaid endpoint overrides", () => {
  const schema = JSON.parse(readFileSync(new URL("../../manifest.schema.json", import.meta.url), "utf8"));
  const feed = schema.properties.corpora.properties.bank_feed;
  assert.deepEqual(feed.properties.provider.enum, ["plaid", "custom"]);
  assert.equal(feed.properties.provider.default, "plaid");
  assert.equal(JSON.stringify(feed.allOf).includes("api_base"), true);
});

check("public manifest template keeps Plaid disabled and contains no credential", () => {
  const template = JSON.parse(readFileSync(new URL("../../templates/brain.manifest.json", import.meta.url), "utf8"));
  const feed = template.corpora.bank_feed;
  assert.equal(feed.enabled, false);
  assert.equal(feed.provider, "plaid");
  assert.equal(feed.environment, "sandbox");
  assert.equal(/client_id|secret/i.test(JSON.stringify(feed)), false);
});

check("connect mode asks only for read-only Transactions", () => {
  const request = buildPlaidLinkTokenRequest({
    mode: "connect",
    clientName: "Fixture Brain",
    endUserRef: "install:fixture",
    redirectUri: "https://fixture.example/app/connect/bank",
    webhookUri: "https://fixture.example/api/webhooks/plaid",
  });
  assert.deepEqual(request.products, ["transactions"]);
  assert.equal(request.transactions.days_requested, 730);
});

check("update mode supplies access_token and omits product parameters", () => {
  const request = buildPlaidLinkTokenRequest({
    mode: "reauthorise",
    clientName: "Fixture Brain",
    endUserRef: "install:fixture",
    redirectUri: "https://fixture.example/app/connect/bank",
    accessToken: "access-fixture",
  });
  assert.equal(request.access_token, "access-fixture");
  assert.equal(Object.hasOwn(request, "products"), false);
  assert.equal(Object.hasOwn(request, "transactions"), false);
  assert.equal(Object.hasOwn(request, "webhook"), false);
});

check("update completion never exchanges a public token", () => {
  assert.deepEqual(plaidLinkCompletion({ mode: "reauthorise" }), {
    action: "keep_existing_access_token",
    exchangeRequired: false,
  });
});

check("completed Link-token creation replays the same unexpired durable receipt", () => {
  const receipt = { linkToken: "link-fixture", expiresAt: "2026-08-30T20:00:00.000Z" };
  assert.deepEqual(
    plaidLinkTokenDecision(
      { state: "link_ready", requestFingerprint: "fp", receipt },
      "fp",
      { now: Date.parse("2026-08-30T19:00:00.000Z") },
    ),
    { action: "return_link_receipt", receipt },
  );
});

check("ambiguous Link-token creation is replaceable before Item authorization", () => {
  assert.deepEqual(
    plaidLinkTokenDecision({ state: "link_create_started", requestFingerprint: "fp" }, "fp"),
    { action: "create_replacement", reason: "provider_outcome_unknown" },
  );
});

check("completed Link exchange replays its durable receipt", () => {
  const receipt = { itemRef: "fixture-item", status: "queued" };
  assert.deepEqual(
    plaidExchangeDecision({ state: "completed", requestFingerprint: "fp", receipt }, "fp"),
    { action: "return_receipt", receipt },
  );
});

check("ambiguous provider exchange fails closed instead of reusing a one-time token", () => {
  const decision = plaidExchangeDecision({ state: "exchange_started", requestFingerprint: "fp" }, "fp");
  assert.equal(decision.action, "manual_recovery");
  assert.equal(decision.code, "PLAID_EXCHANGE_OUTCOME_UNKNOWN");
});

check("link completion refuses a mismatched session fingerprint", () => {
  assert.throws(
    () => plaidExchangeDecision({ state: "link_completed", requestFingerprint: "a" }, "b"),
    (error) => error instanceof PlaidProtocolError && error.code === "LINK_SESSION_MISMATCH",
  );
});

check("revocation never erases a token before provider confirmation", () => {
  assert.equal(plaidRevocationTransition({ state: "pending", providerResult: { removed: false } }).eraseAccessToken, false);
  assert.equal(plaidRevocationTransition({ state: "pending", providerResult: { removed: true } }).eraseAccessToken, true);
});

check("replay and out-of-order webhook states are explicit", () => {
  assert.equal(plaidWebhookDisposition({ deliverySeen: true }).state, "replay");
  assert.deepEqual(
    plaidWebhookDisposition({
      issuedAt: 10,
      lastIssuedAt: 20,
      payload: { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" },
    }).state,
    "out_of_order",
  );
});

await checkAsync("sync refuses to run without durable staging callbacks", async () => {
  await assert.rejects(
    () => stagePlaidSyncWindow({}),
    (error) => error instanceof PlaidProtocolError && error.code === "INVALID_SYNC_CALLBACKS",
  );
});

await checkAsync("sync resumes a durably staged window without committing an intermediate cursor", async () => {
  const staged = new Map([[0, { pageIndex: 0, nextCursor: "resume-page-2" }]]);
  let committedCursor = null;
  const receipt = await stagePlaidSyncWindow({
    originalCursor: null,
    resumeCursor: "resume-page-2",
    resumePageIndex: 1,
    resumeCounts: { added: 1, modified: 0, removed: 0 },
    requestPage: async ({ cursor }) => {
      assert.equal(cursor, "resume-page-2");
      return {
        added: [{
          transaction_id: "resumed-posted",
          pending_transaction_id: "resumed-pending",
          account_id: "resume-account",
          amount: "1.23",
          iso_currency_code: "USD",
          date: "2026-08-30",
          pending: false,
          name: "Resumed fixture",
        }],
        modified: [],
        removed: [],
        next_cursor: "resume-complete",
        has_more: false,
      };
    },
    resetWindow: async () => assert.fail("a valid durable resume must not reset its staged first page"),
    stagePage: async (page) => staged.set(page.pageIndex, page),
    promoteWindow: async (promotion) => {
      assert.equal(committedCursor, null);
      committedCursor = promotion.finalCursor;
      return promotion;
    },
  });
  assert.equal(staged.size, 2);
  assert.equal(committedCursor, "resume-complete");
  assert.deepEqual(receipt.counts, { added: 2, modified: 0, removed: 0 });
});

await checkAsync("webhook verification refuses malformed JWTs", async () => {
  await assert.rejects(
    () => verifyPlaidWebhook({ rawBody: "{}", verificationJwt: "not-a-jwt", getJwk: async () => ({}) }),
    (error) => error instanceof PlaidProtocolError && error.code === "INVALID_WEBHOOK_JWT",
  );
});

try {
  const receipt = await runPlaidSandboxRehearsal();
  check("credential-free Plaid rehearsal covers the complete protocol", () => {
    assert.equal(receipt.fieldProof, false);
    assert.equal(receipt.checkCount, 20);
    assert.equal(receipt.providerCalls.exchange, 1);
    assert.equal(receipt.providerCalls.remove, 2);
  });
} catch (error) {
  process.stderr.write(`FAIL  credential-free Plaid rehearsal covers the complete protocol\n${error.stack}\n`);
  process.exitCode = 1;
}

await checkAsync("live Sandbox runner is bounded, sanitized, and removes its disposable Item", async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const payloads = {
      "/sandbox/public_token/create": { public_token: "public-live-fixture" },
      "/item/public_token/exchange": { item_id: "item-live-fixture", access_token: "access-live-fixture" },
      "/transactions/sync": { added: [], modified: [], removed: [], next_cursor: "cursor-live-1", has_more: false },
      "/sandbox/transactions/refresh": { request_id: "refresh" },
      "/sandbox/item/reset_login": { reset_login: true },
      "/link/token/create": { link_token: "link-live-fixture" },
      "/sandbox/item/fire_webhook": { request_id: "webhook" },
      "/item/remove": { request_id: "remove" },
    };
    return new Response(JSON.stringify(payloads[path]), {
      status: payloads[path] ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  const receipt = await runPlaidLiveSandbox({
    clientId: "fixture-client",
    secret: "fixture-secret",
    redirectUri: "https://fixture.example/app/connect/bank",
    webhookUri: "https://fixture.example/api/webhooks/plaid",
    fetchImpl,
  });
  assert.equal(receipt.liveSandboxProof, true);
  assert.equal(receipt.providerRemovalConfirmed, true);
  assert.equal(receipt.webhookRequested, true);
  assert.equal(receipt.webhookDeliveryProven, false);
  assert.equal(JSON.stringify(receipt).includes("live-fixture"), false);
  assert.equal(paths.at(-1), "/item/remove");
});

if (!process.exitCode) process.stdout.write(`\nplaid-protocol: ${checks.length}/${checks.length} checks passed\n`);
