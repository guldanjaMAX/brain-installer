#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  buildPlaidLinkTokenRequest,
  plaidExchangeDecision,
  plaidLinkCompletion,
  plaidLinkTokenDecision,
  plaidRevocationTransition,
  plaidWebhookDisposition,
  stagePlaidSyncWindow,
  verifyPlaidWebhook,
} from "../worker/src/lib/plaid-protocol.js";
import { providerJson } from "../worker/src/lib/provider-sync.js";

const encoder = new TextEncoder();

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

export class CredentialFreePlaidFake {
  constructor() {
    this.exchangeCalls = 0;
    this.mutationRaised = false;
    this.removeCalls = 0;
  }

  async exchange(publicToken) {
    this.exchangeCalls += 1;
    if (publicToken !== "public-sandbox-once") throw new Error("unexpected fake public token");
    if (this.exchangeCalls > 1) {
      const error = new Error("public token was already used");
      error.error_code = "INVALID_PUBLIC_TOKEN";
      throw error;
    }
    return { itemId: "item-sandbox-1", accessToken: "access-sandbox-secret" };
  }

  async sync({ cursor }) {
    if (cursor == null) {
      return {
        added: [{
          transaction_id: "pending-1",
          account_id: "account-1",
          amount: "12.34",
          iso_currency_code: "USD",
          unofficial_currency_code: null,
          date: "2026-08-28",
          pending: true,
          name: "Sandbox pending purchase",
        }],
        modified: [],
        removed: [],
        next_cursor: "page-2",
        has_more: true,
      };
    }
    if (cursor === "page-2" && !this.mutationRaised) {
      this.mutationRaised = true;
      const error = new Error("sandbox mutation during pagination");
      error.error_code = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
      throw error;
    }
    if (cursor === "page-2") {
      return {
        added: [{
          transaction_id: "posted-1",
          pending_transaction_id: "pending-1",
          account_id: "account-1",
          amount: "12.34",
          iso_currency_code: null,
          unofficial_currency_code: "XBT",
          date: "2026-08-29",
          authorized_date: "2026-08-28",
          pending: false,
          name: "Sandbox posted purchase",
          merchant_name: "Sandbox Merchant",
        }],
        modified: [],
        removed: [{ transaction_id: "removed-1" }],
        next_cursor: "complete-1",
        has_more: false,
      };
    }
    throw new Error(`unexpected fake cursor: ${cursor}`);
  }

  async remove() {
    this.removeCalls += 1;
    if (this.removeCalls === 1) return { removed: false, errorCode: "FAKE_NETWORK_LOSS" };
    return { removed: true };
  }
}

async function signedWebhook(rawBody, issuedAt) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = "sandbox-key-1";
  const header = base64UrlJson({ alg: "ES256", kid: publicJwk.kid, typ: "JWT" });
  const claims = base64UrlJson({ iat: issuedAt, request_body_sha256: await sha256Hex(rawBody) });
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    encoder.encode(signingInput),
  ));
  return { jwt: `${signingInput}.${base64Url(signature)}`, publicJwk };
}

export async function runPlaidSandboxRehearsal() {
  const fake = new CredentialFreePlaidFake();
  const checks = [];
  const check = (name, passed) => {
    if (!passed) throw new Error(`Plaid sandbox rehearsal failed: ${name}`);
    checks.push(name);
  };

  const connectRequest = buildPlaidLinkTokenRequest({
    mode: "connect",
    clientName: "Sandbox Brain",
    endUserRef: "install:sandbox-brain",
    redirectUri: "https://sandbox-brain.example/app/connect/bank",
    webhookUri: "https://sandbox-brain.example/api/webhooks/plaid",
  });
  check("connect requests only Transactions", JSON.stringify(connectRequest.products) === '["transactions"]');
  const linkSession = {
    state: "link_ready",
    requestFingerprint: "link-request-1",
    receipt: {
      linkToken: "link-sandbox-short-lived",
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    },
  };
  check("a lost browser response replays the durable Link receipt",
    plaidLinkTokenDecision(linkSession, "link-request-1").action === "return_link_receipt");
  check("an unknown Link creation outcome safely requests a replacement",
    plaidLinkTokenDecision({ state: "link_create_started", requestFingerprint: "link-request-2" }, "link-request-2").action ===
      "create_replacement");

  const updateRequest = buildPlaidLinkTokenRequest({
    mode: "reauthorise",
    clientName: "Sandbox Brain",
    endUserRef: "install:sandbox-brain",
    redirectUri: "https://sandbox-brain.example/app/connect/bank",
    accessToken: "access-sandbox-secret",
  });
  check("update mode omits products and product parameters",
    !Object.hasOwn(updateRequest, "products") && !Object.hasOwn(updateRequest, "transactions") &&
    !Object.hasOwn(updateRequest, "webhook"));
  check("update mode keeps the existing token",
    plaidLinkCompletion({ mode: "reauthorise" }).exchangeRequired === false);

  const session = { state: "link_completed", requestFingerprint: "request-1" };
  check("first Link completion exchanges once",
    plaidExchangeDecision(session, "request-1").action === "exchange_once");
  const providerExchange = await fake.exchange("public-sandbox-once");
  session.state = "completed";
  session.receipt = { itemRef: providerExchange.itemId, status: "queued" };
  check("a lost browser response replays the durable receipt",
    plaidExchangeDecision(session, "request-1").action === "return_receipt" && fake.exchangeCalls === 1);

  const staged = new Map();
  const resets = [];
  let committedCursor = null;
  const promotion = await stagePlaidSyncWindow({
    originalCursor: committedCursor,
    requestPage: (request) => fake.sync(request),
    resetWindow: async (event) => {
      staged.clear();
      resets.push(event);
    },
    stagePage: async (page) => staged.set(page.pageIndex, page),
    promoteWindow: async (receipt) => {
      check("cursor remains unchanged until the complete window is staged", committedCursor === null);
      committedCursor = receipt.finalCursor;
      return receipt;
    },
  });
  check("mutation restarts from the original cursor", promotion.mutationRestarts === 1 && resets.length === 2);
  check("the entire window promotes once", committedCursor === "complete-1" && staged.size === 2);
  check("pending to posted linkage survives", staged.get(1).added[0].pendingTransactionId === "pending-1");
  check("official and unofficial currencies survive",
    staged.get(0).added[0].isoCurrencyCode === "USD" && staged.get(1).added[0].unofficialCurrencyCode === "XBT");
  check("provider provenance survives",
    staged.get(1).added[0].provenance.endpoint === "/transactions/sync");

  const rawWebhook = JSON.stringify({
    webhook_type: "TRANSACTIONS",
    webhook_code: "SYNC_UPDATES_AVAILABLE",
    item_id: "item-sandbox-1",
  });
  const issuedAt = Math.floor(Date.now() / 1000);
  const signed = await signedWebhook(rawWebhook, issuedAt);
  const verified = await verifyPlaidWebhook({
    rawBody: rawWebhook,
    verificationJwt: signed.jwt,
    getJwk: async () => signed.publicJwk,
    now: issuedAt * 1000,
  });
  check("signed webhook verifies against its exact raw body", verified.kid === signed.publicJwk.kid);
  let alteredBodyRefused = false;
  try {
    await verifyPlaidWebhook({
      rawBody: `${rawWebhook}\n`,
      verificationJwt: signed.jwt,
      getJwk: async () => signed.publicJwk,
      now: issuedAt * 1000,
    });
  } catch (error) {
    alteredBodyRefused = error?.code === "WEBHOOK_BODY_MISMATCH";
  }
  check("signed webhook refuses altered raw bytes", alteredBodyRefused);
  check("valid transaction webhook schedules reconciliation",
    plaidWebhookDisposition({ issuedAt, payload: JSON.parse(rawWebhook) }).scheduleReconciliation === true);
  check("replayed delivery is ignored",
    plaidWebhookDisposition({ deliverySeen: true, issuedAt, payload: JSON.parse(rawWebhook) }).state === "replay");
  const outOfOrder = plaidWebhookDisposition({
    issuedAt: issuedAt - 60,
    lastIssuedAt: issuedAt,
    payload: JSON.parse(rawWebhook),
  });
  check("out of order delivery is recorded and reconciled", outOfOrder.state === "out_of_order" && outOfOrder.scheduleReconciliation);

  let tokenPresent = true;
  let transition = plaidRevocationTransition({ state: "pending", providerResult: await fake.remove() });
  if (transition.eraseAccessToken) tokenPresent = false;
  check("failed provider removal preserves the encrypted token", tokenPresent && transition.retry);
  transition = plaidRevocationTransition({ state: "pending", providerResult: await fake.remove() });
  if (transition.eraseAccessToken) tokenPresent = false;
  check("confirmed provider removal permits token erasure", !tokenPresent && transition.state === "confirmed");

  return {
    profile: "plaid",
    mode: "credential-free-fake",
    checks,
    checkCount: checks.length,
    providerCalls: {
      exchange: fake.exchangeCalls,
      remove: fake.removeCalls,
    },
    fieldProof: false,
  };
}

async function liveSandboxCall(path, body, { clientId, secret, fetchImpl = fetch } = {}) {
  const { data } = await providerJson("plaid-sandbox", `https://sandbox.plaid.com${path}`, {
    method: "POST",
    body: { client_id: clientId, secret, ...body },
    fetchImpl,
    maxResponseBytes: 2 * 1024 * 1024,
  });
  return data || {};
}

/**
 * Real Plaid Sandbox automation. This is intentionally opt-in and accepts
 * credentials only through function arguments or a reviewed environment
 * launcher. It never prints an Item id, public token, access token, or payload.
 * A disposable Sandbox Item is removed in finally whenever exchange succeeded.
 */
export async function runPlaidLiveSandbox({
  clientId,
  secret,
  redirectUri,
  webhookUri = null,
  fetchImpl = fetch,
} = {}) {
  if (!clientId || !secret) throw new Error("Plaid Sandbox credentials are required through the approved hidden launcher");
  if (!redirectUri) throw new Error("the registered Sandbox redirect URI is required");
  let accessToken = null;
  const receipt = {
    profile: "plaid",
    mode: "live-sandbox",
    fieldProof: false,
    liveSandboxProof: false,
    disposableItemCreated: false,
    publicTokenExchanged: false,
    syncWindowCompleted: false,
    transactionRefreshRequested: false,
    loginReset: false,
    updateTokenCreated: false,
    webhookRequested: false,
    webhookDeliveryProven: false,
    providerRemovalConfirmed: false,
    pages: 0,
    transactionsSeen: 0,
  };
  try {
    const created = await liveSandboxCall("/sandbox/public_token/create", {
      institution_id: "ins_109508",
      initial_products: ["transactions"],
      options: {
        override_username: "user_transactions_dynamic",
        ...(webhookUri ? { webhook: webhookUri } : {}),
      },
    }, { clientId, secret, fetchImpl });
    receipt.disposableItemCreated = Boolean(created.public_token);
    const exchanged = await liveSandboxCall("/item/public_token/exchange", {
      public_token: created.public_token,
    }, { clientId, secret, fetchImpl });
    accessToken = exchanged.access_token;
    receipt.publicTokenExchanged = Boolean(accessToken && exchanged.item_id);

    let cursor = null;
    let hasMore = true;
    const seenCursors = new Set();
    while (hasMore && receipt.pages < 100) {
      const page = await liveSandboxCall("/transactions/sync", {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count: 500,
      }, { clientId, secret, fetchImpl });
      if (!page.next_cursor || seenCursors.has(page.next_cursor)) {
        throw new Error("Plaid Sandbox sync did not advance its opaque cursor");
      }
      seenCursors.add(page.next_cursor);
      cursor = page.next_cursor;
      receipt.pages += 1;
      receipt.transactionsSeen += (page.added || []).length + (page.modified || []).length;
      hasMore = page.has_more === true;
    }
    if (hasMore) throw new Error("Plaid Sandbox sync exceeded the bounded page allowance");
    receipt.syncWindowCompleted = true;

    await liveSandboxCall("/sandbox/transactions/refresh", {
      access_token: accessToken,
    }, { clientId, secret, fetchImpl });
    receipt.transactionRefreshRequested = true;
    await liveSandboxCall("/sandbox/item/reset_login", {
      access_token: accessToken,
    }, { clientId, secret, fetchImpl });
    receipt.loginReset = true;

    const updateRequest = buildPlaidLinkTokenRequest({
      mode: "reauthorise",
      clientName: "Financial Brain Sandbox Gate",
      endUserRef: "sandbox:disposable",
      redirectUri,
      accessToken,
    });
    const update = await liveSandboxCall("/link/token/create", updateRequest, {
      clientId, secret, fetchImpl,
    });
    receipt.updateTokenCreated = Boolean(update.link_token);

    if (webhookUri) {
      await liveSandboxCall("/sandbox/item/fire_webhook", {
        access_token: accessToken,
        webhook_code: "DEFAULT_UPDATE",
      }, { clientId, secret, fetchImpl });
      receipt.webhookRequested = true;
      // Provider acceptance is not delivery proof. The deployed Brain receipt
      // must be checked separately after the runner returns.
      receipt.webhookDeliveryProven = false;
    }
    receipt.liveSandboxProof = receipt.disposableItemCreated && receipt.publicTokenExchanged &&
      receipt.syncWindowCompleted && receipt.transactionRefreshRequested && receipt.loginReset &&
      receipt.updateTokenCreated;
    return receipt;
  } finally {
    if (accessToken) {
      try {
        await liveSandboxCall("/item/remove", { access_token: accessToken }, {
          clientId, secret, fetchImpl,
        });
        receipt.providerRemovalConfirmed = true;
      } catch {
        receipt.providerRemovalConfirmed = false;
      }
    }
    receipt.liveSandboxProof = receipt.liveSandboxProof && receipt.providerRemovalConfirmed;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const live = process.argv.includes("--live");
  const command = live
    ? runPlaidLiveSandbox({
      clientId: process.env.BANK_FEED_CLIENT_ID,
      secret: process.env.BANK_FEED_SECRET,
      redirectUri: process.env.BANK_FEED_SANDBOX_REDIRECT_URI,
      webhookUri: process.env.BANK_FEED_SANDBOX_WEBHOOK_URI || null,
    })
    : runPlaidSandboxRehearsal();
  command
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
