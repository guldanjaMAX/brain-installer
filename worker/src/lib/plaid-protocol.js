import { PLAID_PROFILE } from "./bank-feed-profiles.js";

export const PLAID_WEBHOOK_PATH = "/api/webhooks/plaid";
export const PLAID_SYNC_COUNT = 500;
export const PLAID_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
export const PLAID_WEBHOOK_FUTURE_SKEW_SECONDS = 30;
export const PLAID_MUTATION_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class PlaidProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PlaidProtocolError";
    this.code = code;
    this.details = details;
  }
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new PlaidProtocolError("INVALID_INPUT", `${field} is required`);
  return text;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function asIsoDate(value) {
  const text = optionalText(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function decimalSource(value) {
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new PlaidProtocolError("INVALID_AMOUNT", "Plaid returned a non-decimal transaction amount");
}

function base64UrlBytes(value) {
  const input = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = input + "=".repeat((4 - (input.length % 4 || 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT is not valid base64url");
  }
}

function parseJwtPart(value, label) {
  try {
    return JSON.parse(textDecoder.decode(base64UrlBytes(value)));
  } catch (error) {
    if (error instanceof PlaidProtocolError) throw error;
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", `Plaid webhook JWT ${label} is not valid JSON`);
  }
}

function constantTimeEqual(left, right) {
  const a = textEncoder.encode(String(left));
  const b = textEncoder.encode(String(right));
  let different = a.length ^ b.length;
  // SHA-256 hex is always 64 bytes. Keep the comparison loop fixed even when
  // an attacker supplies a shorter or longer claim.
  for (let index = 0; index < 64; index += 1) {
    different |= (a[index] || 0) ^ (b[index] || 0);
  }
  return different === 0;
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Build the only two Link request shapes this connector permits. */
export function buildPlaidLinkTokenRequest({
  mode = "connect",
  clientName,
  endUserRef,
  redirectUri,
  webhookUri,
  accessToken = null,
  countryCodes = ["US"],
  language = "en",
  daysRequested = 730,
} = {}) {
  const common = {
    client_name: requiredText(clientName, "clientName"),
    country_codes: countryCodes.map((code) => requiredText(code, "countryCode")),
    language: requiredText(language, "language"),
    user: { client_user_id: requiredText(endUserRef, "endUserRef") },
    redirect_uri: requiredText(redirectUri, "redirectUri"),
  };

  if (mode === "reauthorise") {
    return { ...common, access_token: requiredText(accessToken, "accessToken") };
  }
  if (mode !== "connect") {
    throw new PlaidProtocolError("INVALID_LINK_MODE", `unsupported Plaid Link mode: ${mode}`);
  }
  return {
    ...common,
    products: ["transactions"],
    webhook: requiredText(webhookUri, "webhookUri"),
    transactions: { days_requested: daysRequested },
  };
}

/** Update mode keeps the existing access token and must never exchange a public token. */
export function plaidLinkCompletion({ mode, publicToken = null } = {}) {
  if (mode === "reauthorise") {
    return { action: "keep_existing_access_token", exchangeRequired: false };
  }
  if (mode === "connect") {
    return {
      action: "exchange_public_token",
      exchangeRequired: true,
      publicToken: requiredText(publicToken, "publicToken"),
    };
  }
  throw new PlaidProtocolError("INVALID_LINK_MODE", `unsupported Plaid Link mode: ${mode}`);
}

/**
 * Link tokens are short-lived session values, not Item access credentials. A
 * durable ready receipt is replayed after browser response loss. If provider
 * creation ended ambiguously before a token was stored, issuing a replacement
 * is safe because no Item has been authorized yet.
 */
export function plaidLinkTokenDecision(session, requestFingerprint, { now = Date.now() } = {}) {
  if (!session || session.requestFingerprint !== requestFingerprint) {
    throw new PlaidProtocolError("LINK_SESSION_MISMATCH", "Plaid Link session does not match this request");
  }
  if (session.state === "link_ready" && session.receipt) {
    const expiresAt = Date.parse(session.receipt.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      return { action: "return_link_receipt", receipt: session.receipt };
    }
    return { action: "create_replacement", reason: "expired" };
  }
  if (session.state === "link_create_started") {
    return { action: "create_replacement", reason: "provider_outcome_unknown" };
  }
  if (session.state === "new" || session.state === "link_create_failed") {
    return { action: "create_link_token" };
  }
  throw new PlaidProtocolError("LINK_SESSION_NOT_STARTABLE", "Plaid Link session cannot create another Link token");
}

/**
 * A completed exchange receipt is the idempotency boundary presented to Link.
 * Replaying the same session returns the receipt without calling Plaid again.
 */
export function plaidExchangeDecision(session, requestFingerprint) {
  if (!session || session.requestFingerprint !== requestFingerprint) {
    throw new PlaidProtocolError("LINK_SESSION_MISMATCH", "Plaid Link session does not match this completion");
  }
  if (session.state === "completed" && session.receipt) {
    return { action: "return_receipt", receipt: session.receipt };
  }
  if (session.state === "exchange_started") {
    return {
      action: "manual_recovery",
      code: "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
      reason: "Plaid public tokens are single-use, so an interrupted provider exchange cannot be replayed safely.",
    };
  }
  if (session.state !== "link_completed") {
    throw new PlaidProtocolError("LINK_SESSION_NOT_READY", "Plaid Link session is not ready for token exchange");
  }
  return { action: "exchange_once" };
}

export function normalisePlaidAccount(account) {
  return {
    providerAccountId: requiredText(account?.account_id, "account.account_id"),
    name: requiredText(account?.official_name || account?.name, "account.name"),
    mask: optionalText(account?.mask),
    type: optionalText(account?.type) || "unknown",
    subtype: optionalText(account?.subtype),
    currentBalance: account?.balances?.current == null ? null : decimalSource(account.balances.current),
    availableBalance: account?.balances?.available == null ? null : decimalSource(account.balances.available),
    isoCurrencyCode: optionalText(account?.balances?.iso_currency_code),
    unofficialCurrencyCode: optionalText(account?.balances?.unofficial_currency_code),
    provenance: {
      provider: PLAID_PROFILE.provider,
      endpoint: "/accounts/get",
      providerAccountId: requiredText(account?.account_id, "account.account_id"),
    },
  };
}

export function normalisePlaidTransaction(transaction) {
  const providerTransactionId = requiredText(transaction?.transaction_id, "transaction.transaction_id");
  return {
    providerTransactionId,
    pendingTransactionId: optionalText(transaction?.pending_transaction_id),
    providerAccountId: requiredText(transaction?.account_id, "transaction.account_id"),
    amount: decimalSource(transaction?.amount),
    isoCurrencyCode: optionalText(transaction?.iso_currency_code),
    unofficialCurrencyCode: optionalText(transaction?.unofficial_currency_code),
    date: asIsoDate(transaction?.date),
    authorizedDate: asIsoDate(transaction?.authorized_date),
    pending: transaction?.pending === true,
    name: requiredText(transaction?.merchant_name || transaction?.name, "transaction.name"),
    merchantName: optionalText(transaction?.merchant_name),
    categoryPrimary: optionalText(transaction?.personal_finance_category?.primary),
    categoryDetailed: optionalText(transaction?.personal_finance_category?.detailed),
    provenance: {
      provider: PLAID_PROFILE.provider,
      endpoint: "/transactions/sync",
      providerTransactionId,
      providerAccountId: requiredText(transaction?.account_id, "transaction.account_id"),
    },
  };
}

export function plaidErrorCode(error) {
  return optionalText(error?.code || error?.error_code || error?.body?.error_code || error?.details?.error_code);
}

/**
 * Fetch and stage one complete Transactions Sync update window. The committed
 * cursor is never advanced here. promoteWindow owns the single atomic flip.
 */
export async function stagePlaidSyncWindow({
  originalCursor = null,
  resumeCursor = null,
  resumePageIndex = 0,
  resumeCounts = null,
  requestPage,
  resetWindow,
  stagePage,
  promoteWindow,
  maxMutationRestarts = 3,
} = {}) {
  if (typeof requestPage !== "function" || typeof resetWindow !== "function" ||
      typeof stagePage !== "function" || typeof promoteWindow !== "function") {
    throw new PlaidProtocolError("INVALID_SYNC_CALLBACKS", "Plaid sync requires request, stage, reset, and promote callbacks");
  }

  let cursor = resumeCursor ?? originalCursor;
  let pageIndex = Number.isInteger(resumePageIndex) && resumePageIndex >= 0 ? resumePageIndex : 0;
  let mutationRestarts = 0;
  let added = Number.isInteger(resumeCounts?.added) && resumeCounts.added >= 0 ? resumeCounts.added : 0;
  let modified = Number.isInteger(resumeCounts?.modified) && resumeCounts.modified >= 0 ? resumeCounts.modified : 0;
  let removed = Number.isInteger(resumeCounts?.removed) && resumeCounts.removed >= 0 ? resumeCounts.removed : 0;

  if (pageIndex === 0) await resetWindow({ originalCursor, reason: "start" });

  for (;;) {
    let page;
    try {
      page = await requestPage({ cursor, count: PLAID_SYNC_COUNT, pageIndex, originalCursor });
    } catch (error) {
      if (plaidErrorCode(error) !== PLAID_MUTATION_CODE || mutationRestarts >= maxMutationRestarts) throw error;
      mutationRestarts += 1;
      cursor = originalCursor;
      pageIndex = 0;
      added = 0;
      modified = 0;
      removed = 0;
      await resetWindow({ originalCursor, reason: "mutation", mutationRestarts });
      continue;
    }

    const nextCursor = optionalText(page?.next_cursor);
    if (!nextCursor) throw new PlaidProtocolError("INVALID_SYNC_PAGE", "Plaid sync page did not include next_cursor");
    const stagedPage = {
      pageIndex,
      requestCursor: cursor,
      nextCursor,
      hasMore: page?.has_more === true,
      added: Array.isArray(page?.added) ? page.added.map(normalisePlaidTransaction) : [],
      modified: Array.isArray(page?.modified) ? page.modified.map(normalisePlaidTransaction) : [],
      removed: Array.isArray(page?.removed)
        ? page.removed.map((entry) => ({ providerTransactionId: requiredText(entry?.transaction_id, "removed.transaction_id") }))
        : [],
    };
    await stagePage(stagedPage);
    added += stagedPage.added.length;
    modified += stagedPage.modified.length;
    removed += stagedPage.removed.length;
    pageIndex += 1;
    cursor = nextCursor;

    if (!stagedPage.hasMore) {
      return promoteWindow({
        originalCursor,
        finalCursor: nextCursor,
        pageCount: pageIndex,
        mutationRestarts,
        counts: { added, modified, removed },
      });
    }
  }
}

/** Verify the Plaid-Verification JWT against the exact raw request body. */
export async function verifyPlaidWebhook({ rawBody, verificationJwt, getJwk, now = Date.now() } = {}) {
  if (typeof rawBody !== "string") {
    throw new PlaidProtocolError("INVALID_WEBHOOK_BODY", "Plaid webhook verification requires the exact raw body text");
  }
  if (String(verificationJwt || "").length > 4096) {
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT is too large");
  }
  const parts = String(verificationJwt || "").split(".");
  if (parts.length !== 3) throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT has the wrong shape");
  const header = parseJwtPart(parts[0], "header");
  const claims = parseJwtPart(parts[1], "claims");
  if (header.alg !== "ES256" || !optionalText(header.kid)) {
    throw new PlaidProtocolError("INVALID_WEBHOOK_JWT", "Plaid webhook JWT must use ES256 and include kid");
  }
  if (typeof getJwk !== "function") throw new PlaidProtocolError("INVALID_WEBHOOK_KEY_SOURCE", "Plaid webhook key lookup is required");
  const jwk = await getJwk(header.kid);
  if (!jwk || jwk.kid !== header.kid || jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new PlaidProtocolError("INVALID_WEBHOOK_KEY", "Plaid webhook verification key does not match the signed key id");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlBytes(parts[2]),
    textEncoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new PlaidProtocolError("INVALID_WEBHOOK_SIGNATURE", "Plaid webhook signature is invalid");

  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(claims.iat) || nowSeconds - claims.iat > PLAID_WEBHOOK_MAX_AGE_SECONDS ||
      claims.iat - nowSeconds > PLAID_WEBHOOK_FUTURE_SKEW_SECONDS) {
    throw new PlaidProtocolError("STALE_WEBHOOK", "Plaid webhook JWT is outside the accepted time window");
  }
  const bodyHash = await sha256Hex(rawBody);
  if (!constantTimeEqual(bodyHash, claims.request_body_sha256)) {
    throw new PlaidProtocolError("WEBHOOK_BODY_MISMATCH", "Plaid webhook body hash does not match its signature");
  }
  return {
    kid: header.kid,
    issuedAt: claims.iat,
    bodyHash,
    deliveryId: await sha256Hex(String(verificationJwt)),
  };
}

export function plaidWebhookDisposition({ deliverySeen, issuedAt, lastIssuedAt, payload } = {}) {
  if (deliverySeen) return { state: "replay", scheduleReconciliation: false };
  const outOfOrder = Number.isInteger(lastIssuedAt) && Number.isInteger(issuedAt) && issuedAt < lastIssuedAt;
  const type = optionalText(payload?.webhook_type);
  const code = optionalText(payload?.webhook_code);
  const relevant = type === "TRANSACTIONS" || type === "ITEM";
  return {
    state: outOfOrder ? "out_of_order" : "accepted",
    scheduleReconciliation: relevant,
    webhookType: type,
    webhookCode: code,
    itemId: optionalText(payload?.item_id),
  };
}

/** Token erasure is permitted only after the provider confirms Item removal. */
export function plaidRevocationTransition({ state, providerResult = null } = {}) {
  if (state === "confirmed") return { state: "confirmed", eraseAccessToken: true, retry: false };
  if (providerResult?.removed === true) return { state: "confirmed", eraseAccessToken: true, retry: false };
  return {
    state: "pending",
    eraseAccessToken: false,
    retry: true,
    errorCode: optionalText(providerResult?.errorCode) || "PLAID_REMOVE_NOT_CONFIRMED",
  };
}
