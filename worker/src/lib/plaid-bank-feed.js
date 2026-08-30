import { providerJson, ProviderSyncError } from "./provider-sync.js";
import {
  accountKindFor,
  bankFeedConfig,
  decryptAccessReference,
  directionFor,
  encryptAccessReference,
  feedScopeKey,
  redirectUriFor,
  safeFeedError,
  tenantReference,
} from "./bank-feed.js";
import { balanceRoleFor } from "./fin-import.js";
import {
  PLAID_WEBHOOK_PATH,
  buildPlaidLinkTokenRequest,
  normalisePlaidAccount,
  plaidExchangeDecision,
  plaidLinkCompletion,
  plaidLinkTokenDecision,
  plaidRevocationTransition,
  plaidWebhookDisposition,
  stagePlaidSyncWindow,
  verifyPlaidWebhook,
} from "./plaid-protocol.js";

const PROVIDER = "plaid";
const BACKFILL_DAYS = 730;
const DEFAULT_RECONCILE_MINUTES = 360;

function nowIso(now = null) {
  return now || new Date().toISOString();
}

function textBytes(value) {
  return new TextEncoder().encode(String(value));
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textBytes(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedCode(error) {
  return String(error?.code || error?.error_code || error?.details?.error_code || "provider_error")
    .replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
}

function decimalMinor(value, currency = "USD") {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const exponent = ["JPY", "KRW"].includes(String(currency).toUpperCase()) ? 0 : 2;
  const scaled = Number(`${whole}${fraction.slice(0, exponent).padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(scaled)) return null;
  return negative ? -scaled : scaled;
}

function accountSlug(itemRef, accountRef) {
  return `plaid-${itemRef}-${accountRef}`.toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-").slice(0, 64);
}

const PLAID_NO_AUTOMATIC_RETRY_PATHS = new Set([
  "/item/public_token/exchange",
  "/item/remove",
]);

function providerOptions(fetchImpl, body, path) {
  return {
    method: "POST",
    body,
    fetchImpl,
    ...(PLAID_NO_AUTOMATIC_RETRY_PATHS.has(path) ? { maxAttempts: 1 } : {}),
    maxResponseBytes: 2 * 1024 * 1024,
  };
}

export async function callPlaid(env, path, body, { fetchImpl = fetch } = {}) {
  const config = bankFeedConfig(env);
  if (config.provider !== PROVIDER) throw new Error("the Plaid runtime requires the named Plaid profile");
  const { data } = await providerJson(PROVIDER, `${config.apiBase}${path}`, providerOptions(fetchImpl, {
    client_id: config.clientId,
    secret: config.secret,
    ...body,
  }, path));
  return data || {};
}

function providerOutcomeUnknown(error) {
  if (!(error instanceof ProviderSyncError)) return false;
  return Number(error.status || 0) >= 500 ||
    ["transport_error", "timeout", "deadline_exceeded", "aborted"].includes(String(error.code || ""));
}

function unknownOutcomeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  error.outcome_unknown = true;
  error.retry_safe = false;
  return error;
}

async function itemRow(env, tenantId, itemRef) {
  return env.DB.prepare(
    `SELECT item_ref,institution_ref,institution_label,access_ciphertext,access_iv,key_version,
            environment,cursor,status,status_detail,last_synced_at,removed_at
       FROM bank_feed_items WHERE tenant_id=? AND item_ref=? AND removed_at IS NULL`,
  ).bind(tenantId, itemRef).first();
}

async function linkRow(env, tenantId, sessionRef) {
  return env.DB.prepare(
    `SELECT session_ref,request_fingerprint,mode,item_ref,state,link_ciphertext,link_iv,
            link_key_version,link_expires_at,public_token_fingerprint,receipt_json
       FROM plaid_link_operations WHERE tenant_id=? AND session_ref=?`,
  ).bind(tenantId, sessionRef).first();
}

function linkDecisionRow(row) {
  return {
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    receipt: row.link_ciphertext ? {
      expiresAt: row.link_expires_at,
      ciphertext: row.link_ciphertext,
      iv: row.link_iv,
      keyVersion: row.link_key_version,
    } : (row.receipt_json ? JSON.parse(row.receipt_json) : null),
  };
}

export async function createPlaidLinkToken(env, {
  url,
  mode = "connect",
  itemRef = null,
  sessionRef = null,
  fetchImpl = fetch,
  now = null,
} = {}) {
  const config = bankFeedConfig(env);
  const { tenantId, endUserRef } = tenantReference(env);
  const stamp = nowIso(now);
  const ref = sessionRef || crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ref)) {
    const error = new Error("Plaid Link needs a stable retry identity");
    error.code = "plaid_link_request_id_required";
    throw error;
  }
  const normalizedMode = mode === "reauthorise" ? "reauthorise" : "connect";
  const requestFingerprint = await sha256Hex(JSON.stringify({
    tenantId, normalizedMode, itemRef: itemRef || null, origin: new URL(url).origin,
  }));
  await env.DB.prepare(
    `INSERT INTO plaid_link_operations
       (tenant_id,session_ref,request_fingerprint,mode,item_ref,state,created_at,updated_at)
     VALUES (?,?,?,?,?,'new',?,?) ON CONFLICT(tenant_id,session_ref) DO NOTHING`,
  ).bind(tenantId, ref, requestFingerprint, normalizedMode, itemRef, stamp, stamp).run();
  let row = await linkRow(env, tenantId, ref);
  const decision = plaidLinkTokenDecision(linkDecisionRow(row), requestFingerprint, {
    now: Date.parse(stamp),
  });
  if (decision.action === "return_link_receipt") {
    const linkToken = await decryptAccessReference(env, decision.receipt);
    return {
      link_token: linkToken,
      expiration: decision.receipt.expiresAt,
      session_ref: ref,
      mode: normalizedMode,
      redirect_uri: redirectUriFor(url),
      environment: config.environment,
      replayed: true,
    };
  }

  let accessToken = null;
  if (normalizedMode === "reauthorise") {
    const item = await itemRow(env, tenantId, itemRef);
    if (!item) throw new Error("that connection is not on this brain");
    accessToken = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext,
      iv: item.access_iv,
      keyVersion: item.key_version,
    });
  }
  await env.DB.prepare(
    `UPDATE plaid_link_operations SET state='link_create_started',updated_at=?
      WHERE tenant_id=? AND session_ref=?`,
  ).bind(stamp, tenantId, ref).run();
  const request = buildPlaidLinkTokenRequest({
    mode: normalizedMode,
    clientName: config.displayName,
    endUserRef,
    redirectUri: redirectUriFor(url),
    webhookUri: `${new URL(url).origin}${PLAID_WEBHOOK_PATH}`,
    accessToken,
    countryCodes: config.countryCodes,
    daysRequested: BACKFILL_DAYS,
  });
  const created = await callPlaid(env, "/link/token/create", request, { fetchImpl });
  const sealed = await encryptAccessReference(env, created.link_token);
  const expiresAt = created.expiration || new Date(Date.parse(stamp) + 30 * 60_000).toISOString();
  const readyStatements = [env.DB.prepare(
    `UPDATE plaid_link_operations
        SET state='link_ready',link_ciphertext=?,link_iv=?,link_key_version=?,
            link_expires_at=?,updated_at=?
      WHERE tenant_id=? AND session_ref=?`,
  ).bind(sealed.ciphertext, sealed.iv, sealed.keyVersion, expiresAt, stamp, tenantId, ref)];
  if (normalizedMode === "reauthorise") {
    readyStatements.push(env.DB.prepare(
      `UPDATE bank_feed_items SET status='reauth_required',
          status_detail='Bank sign-in is in progress, and provider health still needs confirmation.'
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(tenantId, itemRef));
  }
  await env.DB.batch(readyStatements);
  return {
    link_token: created.link_token,
    expiration: expiresAt,
    session_ref: ref,
    mode: normalizedMode,
    redirect_uri: redirectUriFor(url),
    environment: config.environment,
    replayed: false,
  };
}

export async function completePlaidLink(env, {
  sessionRef,
  publicToken = null,
  institutionRef = null,
  institutionLabel = null,
  fetchImpl = fetch,
  now = null,
} = {}) {
  const config = bankFeedConfig(env);
  const { tenantId } = tenantReference(env);
  const stamp = nowIso(now);
  const row = await linkRow(env, tenantId, sessionRef);
  if (!row) throw new Error("that Plaid Link session is not on this brain");
  if (row.mode === "reauthorise") {
    if (row.state === "completed" && row.receipt_json) {
      return { ...JSON.parse(row.receipt_json), replayed: true };
    }
    if (!["link_ready", "link_completed"].includes(row.state)) {
      throw new Error("Plaid update Link has not completed its reviewed session");
    }
    plaidLinkCompletion({ mode: row.mode });
    await env.DB.prepare(
      `UPDATE plaid_link_operations SET state='link_completed',updated_at=?
        WHERE tenant_id=? AND session_ref=?`,
    ).bind(stamp, tenantId, sessionRef).run();
    const item = await itemRow(env, tenantId, row.item_ref);
    if (!item) throw new Error("that connection is not on this brain");
    const accessToken = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext,
      iv: item.access_iv,
      keyVersion: item.key_version,
    });
    let health;
    try {
      health = await callPlaid(env, "/item/get", { access_token: accessToken }, { fetchImpl });
    } catch (error) {
      await env.DB.prepare(
        `UPDATE bank_feed_items SET status='reauth_required',
            status_detail='Bank sign-in returned, but provider health could not be confirmed.',last_error_at=?
          WHERE tenant_id=? AND item_ref=?`,
      ).bind(stamp, tenantId, row.item_ref).run();
      error.code ||= "PLAID_UPDATE_HEALTH_UNAVAILABLE";
      throw error;
    }
    if (!health?.item || health.item.item_id !== row.item_ref || health.item.error) {
      await env.DB.prepare(
        `UPDATE bank_feed_items SET status='reauth_required',
            status_detail='Bank sign-in returned, but the provider still reports that this connection needs attention.',last_error_at=?
          WHERE tenant_id=? AND item_ref=?`,
      ).bind(stamp, tenantId, row.item_ref).run();
      const error = new Error("Plaid update completed without a healthy matching Item");
      error.code = "PLAID_UPDATE_HEALTH_NOT_CONFIRMED";
      throw error;
    }
    const receipt = {
      item_ref: row.item_ref,
      updated: true,
      exchanged: false,
      health_verified: true,
      replayed: false,
    };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE plaid_link_operations SET state='completed',receipt_json=?,completed_at=?,updated_at=?
          WHERE tenant_id=? AND session_ref=?`,
      ).bind(JSON.stringify(receipt), stamp, stamp, tenantId, sessionRef),
      env.DB.prepare(
        `UPDATE bank_feed_items SET status='connected',status_detail=NULL,last_error_at=NULL
          WHERE tenant_id=? AND item_ref=?`,
      ).bind(tenantId, row.item_ref),
    ]);
    return receipt;
  }

  const token = plaidLinkCompletion({ mode: row.mode, publicToken }).publicToken;
  const requestFingerprint = await sha256Hex(token);
  if (row.public_token_fingerprint && row.public_token_fingerprint !== requestFingerprint) {
    throw new Error("Plaid Link completion does not match this session");
  }
  if (row.state === "completed" && row.receipt_json) return JSON.parse(row.receipt_json);
  if (!["link_ready", "link_completed", "exchange_started"].includes(row.state)) {
    throw new Error("Plaid Link has not completed its reviewed session");
  }
  if (row.state === "exchange_started") {
    const decision = plaidExchangeDecision({
      requestFingerprint,
      state: row.state,
      receipt: null,
    }, requestFingerprint);
    throw unknownOutcomeError(decision.code, decision.reason);
  }
  const claim = await env.DB.prepare(
    `UPDATE plaid_link_operations
        SET state='exchange_started',public_token_fingerprint=?,updated_at=?
      WHERE tenant_id=? AND session_ref=? AND state IN ('link_ready','link_completed')
        AND (public_token_fingerprint IS NULL OR public_token_fingerprint=?)`,
  ).bind(requestFingerprint, stamp, tenantId, sessionRef, requestFingerprint).run();
  if (Number(claim?.meta?.changes ?? claim?.changes ?? 0) !== 1) {
    const current = await linkRow(env, tenantId, sessionRef);
    if (current?.public_token_fingerprint && current.public_token_fingerprint !== requestFingerprint) {
      throw new Error("Plaid Link completion does not match this session");
    }
    throw unknownOutcomeError(
      "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
      "Another request claimed this one-time Plaid handoff. Retry this same connection session to recover its durable receipt.",
    );
  }
  let exchanged;
  try {
    exchanged = await callPlaid(env, "/item/public_token/exchange", {
      public_token: token,
    }, { fetchImpl });
  } catch (error) {
    if (providerOutcomeUnknown(error)) {
      throw unknownOutcomeError(
        "PLAID_EXCHANGE_OUTCOME_UNKNOWN",
        "Plaid may have accepted the one-time connection handoff, but its response did not return safely.",
        error,
      );
    }
    throw error;
  }
  if (!exchanged.item_id || !exchanged.access_token) throw new Error("Plaid returned no usable Item");
  const sealed = await encryptAccessReference(env, exchanged.access_token);
  const receipt = {
    item_ref: exchanged.item_id,
    institution_label: institutionLabel,
    environment: config.environment,
    history: { state: "queued", requested_days: BACKFILL_DAYS },
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bank_feed_items
         (tenant_id,item_ref,institution_ref,institution_label,access_ciphertext,access_iv,
          key_version,environment,status,connected_at)
       VALUES (?,?,?,?,?,?,?,?,'connected',?)
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET
         institution_ref=COALESCE(excluded.institution_ref,bank_feed_items.institution_ref),
         institution_label=COALESCE(excluded.institution_label,bank_feed_items.institution_label),
         access_ciphertext=excluded.access_ciphertext,access_iv=excluded.access_iv,
         key_version=excluded.key_version,status='connected',status_detail=NULL,removed_at=NULL`,
    ).bind(tenantId, exchanged.item_id, institutionRef, institutionLabel, sealed.ciphertext,
      sealed.iv, sealed.keyVersion, config.environment, stamp),
    env.DB.prepare(
      `INSERT INTO bank_feed_backfill (tenant_id,item_ref,requested_days,state,queued_at)
       VALUES (?,?,?,'queued',?)
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET state='queued',last_error=NULL`,
    ).bind(tenantId, exchanged.item_id, BACKFILL_DAYS, stamp),
    env.DB.prepare(
      `INSERT INTO plaid_reconciliation
         (tenant_id,item_ref,reason,state,due_at,attempts,updated_at)
       VALUES (?,?,'initial','pending',?,0,?)
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET reason='initial',state='pending',due_at=excluded.due_at,updated_at=excluded.updated_at`,
    ).bind(tenantId, exchanged.item_id, stamp, stamp),
    env.DB.prepare(
      `UPDATE plaid_link_operations
          SET state='completed',item_ref=?,receipt_json=?,link_ciphertext=NULL,link_iv=NULL,
              link_key_version=NULL,completed_at=?,updated_at=?
        WHERE tenant_id=? AND session_ref=?`,
    ).bind(exchanged.item_id, JSON.stringify(receipt), stamp, stamp, tenantId, sessionRef),
  ]);
  return receipt;
}

function stagedAccount(itemRef, account) {
  const normalized = normalisePlaidAccount(account);
  const currency = String(normalized.isoCurrencyCode || normalized.unofficialCurrencyCode || "USD").toUpperCase();
  const kind = accountKindFor(normalized.type, normalized.subtype);
  return {
    ...normalized,
    accountSlug: accountSlug(itemRef, normalized.providerAccountId),
    accountKind: kind,
    balanceRole: balanceRoleFor(kind),
    currency,
    currentBalanceMinor: decimalMinor(normalized.currentBalance, currency),
    availableBalanceMinor: decimalMinor(normalized.availableBalance, currency),
  };
}

function transactionStageRows(itemRef, page) {
  const map = (operation, values) => values.map((transaction) => {
    const currency = String(transaction.isoCurrencyCode || transaction.unofficialCurrencyCode || "USD").toUpperCase();
    const rawMinor = decimalMinor(transaction.amount, currency);
    return {
      operation,
      pageIndex: page.pageIndex,
      providerTransactionId: transaction.providerTransactionId,
      pendingTransactionId: transaction.pendingTransactionId,
      providerAccountId: transaction.providerAccountId,
      accountSlug: accountSlug(itemRef, transaction.providerAccountId),
      amountDecimal: transaction.amount,
      amountMinor: rawMinor === null ? null : Math.abs(rawMinor),
      direction: rawMinor === null ? null : directionFor(rawMinor),
      isoCurrencyCode: transaction.isoCurrencyCode,
      unofficialCurrencyCode: transaction.unofficialCurrencyCode,
      date: transaction.date,
      authorizedDate: transaction.authorizedDate,
      pending: transaction.pending ? 1 : 0,
      name: transaction.name,
      merchantName: transaction.merchantName,
      categoryPrimary: transaction.categoryPrimary,
      categoryDetailed: transaction.categoryDetailed,
      provenance: transaction.provenance,
    };
  });
  return [
    ...map("added", page.added),
    ...map("modified", page.modified),
    ...page.removed.map((removed) => ({
      operation: "removed",
      pageIndex: page.pageIndex,
      providerTransactionId: removed.providerTransactionId,
    })),
  ];
}

function stageAccountsStatement(env, tenantId, windowRef, accounts) {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO plaid_sync_stage_accounts
       (tenant_id,window_ref,provider_account_id,account_slug,name,mask,account_type,account_subtype,
        current_balance_decimal,available_balance_decimal,current_balance_minor,available_balance_minor,
        account_kind,balance_role,currency,iso_currency_code,unofficial_currency_code,provenance_json)
     SELECT ?,?,
       json_extract(value,'$.providerAccountId'),json_extract(value,'$.accountSlug'),
       json_extract(value,'$.name'),json_extract(value,'$.mask'),json_extract(value,'$.type'),
       json_extract(value,'$.subtype'),json_extract(value,'$.currentBalance'),
       json_extract(value,'$.availableBalance'),json_extract(value,'$.currentBalanceMinor'),
       json_extract(value,'$.availableBalanceMinor'),json_extract(value,'$.accountKind'),
       json_extract(value,'$.balanceRole'),json_extract(value,'$.currency'),
       json_extract(value,'$.isoCurrencyCode'),json_extract(value,'$.unofficialCurrencyCode'),
       json(json_extract(value,'$.provenance'))
     FROM json_each(?)`,
  ).bind(tenantId, windowRef, JSON.stringify(accounts));
}

function stageTransactionsStatement(env, tenantId, windowRef, rows) {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO plaid_sync_stage_transactions
       (tenant_id,window_ref,page_index,operation,provider_transaction_id,pending_transaction_id,
        provider_account_id,account_slug,amount_decimal,amount_minor,direction,iso_currency_code,
        unofficial_currency_code,posted_on,authorized_on,pending,description,merchant_name,
        category_primary,category_detailed,provenance_json)
     SELECT ?,?,json_extract(value,'$.pageIndex'),json_extract(value,'$.operation'),
       json_extract(value,'$.providerTransactionId'),json_extract(value,'$.pendingTransactionId'),
       json_extract(value,'$.providerAccountId'),json_extract(value,'$.accountSlug'),
       json_extract(value,'$.amountDecimal'),json_extract(value,'$.amountMinor'),
       json_extract(value,'$.direction'),json_extract(value,'$.isoCurrencyCode'),
       json_extract(value,'$.unofficialCurrencyCode'),json_extract(value,'$.date'),
       json_extract(value,'$.authorizedDate'),json_extract(value,'$.pending'),
       json_extract(value,'$.name'),json_extract(value,'$.merchantName'),
       json_extract(value,'$.categoryPrimary'),json_extract(value,'$.categoryDetailed'),
       CASE WHEN json_extract(value,'$.provenance') IS NULL THEN NULL
            ELSE json(json_extract(value,'$.provenance')) END
     FROM json_each(?)`,
  ).bind(tenantId, windowRef, JSON.stringify(rows));
}

async function syncWindowRow(env, tenantId, itemRef, stamp) {
  let row = await env.DB.prepare(
    `SELECT window_ref,original_cursor,resume_cursor,next_page_index,added_count,modified_count,
            removed_count,mutation_restarts,state
       FROM plaid_sync_windows WHERE tenant_id=? AND item_ref=?`,
  ).bind(tenantId, itemRef).first();
  if (!row || !["staging", "ready", "retryable"].includes(row.state)) {
    const item = await itemRow(env, tenantId, itemRef);
    const windowRef = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO plaid_sync_windows
         (tenant_id,item_ref,window_ref,original_cursor,resume_cursor,next_page_index,state,started_at,updated_at)
       VALUES (?,?,?,?,?,0,'staging',?,?)
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET
         window_ref=excluded.window_ref,original_cursor=excluded.original_cursor,
         resume_cursor=excluded.resume_cursor,next_page_index=0,added_count=0,modified_count=0,
         removed_count=0,mutation_restarts=0,state='staging',started_at=excluded.started_at,
         updated_at=excluded.updated_at,last_error_code=NULL,completed_at=NULL`,
    ).bind(tenantId, itemRef, windowRef, item?.cursor || null, item?.cursor || null, stamp, stamp).run();
    row = await env.DB.prepare(
      `SELECT window_ref,original_cursor,resume_cursor,next_page_index,added_count,modified_count,
              removed_count,mutation_restarts,state
         FROM plaid_sync_windows WHERE tenant_id=? AND item_ref=?`,
    ).bind(tenantId, itemRef).first();
  }
  return row;
}

function promotionStatements(env, { tenantId, itemRef, windowRef, finalCursor, stamp }) {
  const sourceFeed = feedScopeKey(itemRef);
  const entitySlug = String(env.BANK_FEED_ENTITY || "primary");
  const interval = Math.min(Math.max(Number(env.BANK_FEED_RECONCILE_MINUTES) || DEFAULT_RECONCILE_MINUTES, 15), 1440);
  const nextDue = new Date(Date.parse(stamp) + interval * 60_000).toISOString();
  return [
    env.DB.prepare(
      `INSERT INTO fin_accounts
         (tenant_id,account_slug,entity_slug,label,account_kind,balance_role,mask,currency,
          feed_mode,external_ref,provenance,source_feed,basis_state,recorded_at,
          source_iso_currency_code,source_unofficial_currency_code)
       SELECT tenant_id,account_slug,?,name,account_kind,balance_role,mask,currency,
              'live',provider_account_id,'feed',?,'confirmed',?,iso_currency_code,unofficial_currency_code
         FROM plaid_sync_stage_accounts WHERE tenant_id=? AND window_ref=?
       ON CONFLICT(tenant_id,account_slug) WHERE superseded_by_id IS NULL DO UPDATE SET
         label=excluded.label,account_kind=excluded.account_kind,balance_role=excluded.balance_role,
         mask=excluded.mask,currency=excluded.currency,feed_mode='live',external_ref=excluded.external_ref,
         source_iso_currency_code=excluded.source_iso_currency_code,
         source_unofficial_currency_code=excluded.source_unofficial_currency_code,
         provenance='feed',source_feed=excluded.source_feed,basis_state='confirmed',recorded_at=excluded.recorded_at`,
    ).bind(entitySlug, sourceFeed, stamp, tenantId, windowRef),
    env.DB.prepare(
      `INSERT INTO fin_transactions
         (tenant_id,txn_uid,account_slug,posted_on,amount_minor,direction,raw_amount_minor,
          raw_sign_convention,currency,description,payee,category,pending,external_id,
          provenance,source_locator,source_feed,basis_state,recorded_at,pending_transaction_id,
          source_iso_currency_code,source_unofficial_currency_code,source_amount_decimal,
          source_provider,source_window_ref,source_page_index)
       SELECT tenant_id,'plaid:'||provider_transaction_id,account_slug,posted_on,amount_minor,direction,
              CASE WHEN direction='inflow' THEN -amount_minor ELSE amount_minor END,
              'feed_positive_amount_is_outflow',COALESCE(iso_currency_code,unofficial_currency_code,'USD'),
              description,merchant_name,COALESCE(category_detailed,category_primary),COALESCE(pending,0),
              provider_transaction_id,'feed','plaid/transactions/'||provider_transaction_id,?,
              'confirmed',?,pending_transaction_id,iso_currency_code,unofficial_currency_code,
              amount_decimal,'plaid',window_ref,page_index
         FROM plaid_sync_stage_transactions
        WHERE tenant_id=? AND window_ref=? AND operation IN ('added','modified')
       ON CONFLICT(tenant_id,txn_uid) WHERE superseded_by_id IS NULL DO UPDATE SET
         account_slug=excluded.account_slug,posted_on=excluded.posted_on,amount_minor=excluded.amount_minor,
         direction=excluded.direction,raw_amount_minor=excluded.raw_amount_minor,currency=excluded.currency,
         description=excluded.description,payee=excluded.payee,pending=excluded.pending,
         pending_transaction_id=excluded.pending_transaction_id,
         source_iso_currency_code=excluded.source_iso_currency_code,
         source_unofficial_currency_code=excluded.source_unofficial_currency_code,
         source_amount_decimal=excluded.source_amount_decimal,source_window_ref=excluded.source_window_ref,
         source_page_index=excluded.source_page_index,removed_at=NULL,removal_reason=NULL,recorded_at=excluded.recorded_at`,
    ).bind(sourceFeed, stamp, tenantId, windowRef),
    env.DB.prepare(
      `UPDATE fin_transactions SET removed_at=?,removal_reason='replaced by its posted Plaid transaction'
        WHERE tenant_id=? AND removed_at IS NULL AND pending=1 AND external_id IN (
          SELECT pending_transaction_id FROM plaid_sync_stage_transactions
           WHERE tenant_id=? AND window_ref=? AND operation IN ('added','modified')
             AND pending_transaction_id IS NOT NULL
        )`,
    ).bind(stamp, tenantId, tenantId, windowRef),
    env.DB.prepare(
      `UPDATE fin_transactions SET removed_at=?,removal_reason='Plaid withdrew this transaction'
        WHERE tenant_id=? AND removed_at IS NULL AND external_id IN (
          SELECT provider_transaction_id FROM plaid_sync_stage_transactions
           WHERE tenant_id=? AND window_ref=? AND operation='removed'
        )`,
    ).bind(stamp, tenantId, tenantId, windowRef),
    env.DB.prepare(
      `UPDATE bank_feed_items SET cursor=?,cursor_updated_at=?,last_synced_at=?,
          status='connected',status_detail=NULL,last_error_at=NULL
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(finalCursor, stamp, stamp, tenantId, itemRef),
    env.DB.prepare(
      `UPDATE bank_feed_backfill SET state='complete',finished_at=?,last_error=NULL
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(stamp, tenantId, itemRef),
    env.DB.prepare("DELETE FROM plaid_sync_stage_transactions WHERE tenant_id=? AND window_ref=?")
      .bind(tenantId, windowRef),
    env.DB.prepare("DELETE FROM plaid_sync_stage_accounts WHERE tenant_id=? AND window_ref=?")
      .bind(tenantId, windowRef),
    env.DB.prepare("DELETE FROM plaid_sync_windows WHERE tenant_id=? AND item_ref=?")
      .bind(tenantId, itemRef),
    env.DB.prepare(
      `INSERT INTO plaid_reconciliation
         (tenant_id,item_ref,reason,state,due_at,attempts,last_error_code,updated_at)
       VALUES (?,?,'scheduled','pending',?,0,NULL,?)
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET reason='scheduled',state='pending',
         due_at=excluded.due_at,last_error_code=NULL,updated_at=excluded.updated_at`,
    ).bind(tenantId, itemRef, nextDue, stamp),
  ];
}

export async function syncPlaidItem(env, itemRef, { fetchImpl = fetch, now = null } = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = nowIso(now);
  const item = await itemRow(env, tenantId, itemRef);
  if (!item) return { item_ref: itemRef, ok: false, reason: "that connection is not on this brain" };
  const accessToken = await decryptAccessReference(env, {
    ciphertext: item.access_ciphertext,
    iv: item.access_iv,
    keyVersion: item.key_version,
  });
  const window = await syncWindowRow(env, tenantId, itemRef, stamp);
  try {
    if (window.state === "ready") {
      await env.DB.batch(promotionStatements(env, {
        tenantId,
        itemRef,
        windowRef: window.window_ref,
        finalCursor: window.resume_cursor,
        stamp,
      }));
      return {
        item_ref: itemRef,
        ok: true,
        finalCursor: window.resume_cursor,
        pageCount: Number(window.next_page_index || 0),
        mutationRestarts: Number(window.mutation_restarts || 0),
        counts: {
          added: Number(window.added_count || 0),
          modified: Number(window.modified_count || 0),
          removed: Number(window.removed_count || 0),
        },
        resumed_promotion: true,
        has_more: false,
      };
    }
    const accountPayload = await callPlaid(env, "/accounts/get", { access_token: accessToken }, { fetchImpl });
    const accounts = (Array.isArray(accountPayload.accounts) ? accountPayload.accounts : [])
      .map((account) => stagedAccount(itemRef, account));
    const result = await stagePlaidSyncWindow({
      originalCursor: window.original_cursor || null,
      resumeCursor: window.resume_cursor || window.original_cursor || null,
      resumePageIndex: Number(window.next_page_index || 0),
      resumeCounts: {
        added: Number(window.added_count || 0),
        modified: Number(window.modified_count || 0),
        removed: Number(window.removed_count || 0),
      },
      requestPage: ({ cursor, count }) => callPlaid(env, "/transactions/sync", {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count,
      }, { fetchImpl }),
      resetWindow: async ({ originalCursor, reason, mutationRestarts = 0 }) => {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM plaid_sync_stage_transactions WHERE tenant_id=? AND window_ref=?")
            .bind(tenantId, window.window_ref),
          env.DB.prepare("DELETE FROM plaid_sync_stage_accounts WHERE tenant_id=? AND window_ref=?")
            .bind(tenantId, window.window_ref),
          stageAccountsStatement(env, tenantId, window.window_ref, accounts),
          env.DB.prepare(
            `UPDATE plaid_sync_windows SET resume_cursor=?,next_page_index=0,added_count=0,
                modified_count=0,removed_count=0,mutation_restarts=?,state='staging',
                updated_at=?,last_error_code=?
              WHERE tenant_id=? AND item_ref=?`,
          ).bind(originalCursor, mutationRestarts, stamp, reason === "mutation" ? "pagination_mutation" : null,
            tenantId, itemRef),
        ]);
      },
      stagePage: async (page) => {
        const rows = transactionStageRows(itemRef, page);
        await env.DB.batch([
          stageTransactionsStatement(env, tenantId, window.window_ref, rows),
          env.DB.prepare(
            `UPDATE plaid_sync_windows SET resume_cursor=?,next_page_index=?,
                added_count=added_count+?,modified_count=modified_count+?,removed_count=removed_count+?,
                state=?,updated_at=? WHERE tenant_id=? AND item_ref=?`,
          ).bind(page.nextCursor, page.pageIndex + 1, page.added.length, page.modified.length,
            page.removed.length, page.hasMore ? "staging" : "ready", stamp, tenantId, itemRef),
        ]);
      },
      promoteWindow: async (receipt) => {
        await env.DB.batch(promotionStatements(env, {
          tenantId,
          itemRef,
          windowRef: window.window_ref,
          finalCursor: receipt.finalCursor,
          stamp,
        }));
        return receipt;
      },
    });
    return { item_ref: itemRef, ok: true, ...result, has_more: false };
  } catch (error) {
    const kind = error instanceof ProviderSyncError ? error.outcome?.kind : "retryable";
    const state = kind === "unavailable" ? "unavailable" : kind === "refused" ? "refused" : "retryable";
    const code = boundedCode(error);
    const itemStatus = ["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION"].includes(code)
      ? "reauth_required"
      : ["USER_PERMISSION_REVOKED", "ITEM_NOT_FOUND"].includes(code)
        ? "permission_revoked"
        : "error";
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE plaid_sync_windows SET state=CASE WHEN state='ready' THEN 'ready' ELSE ? END,
            last_error_code=?,updated_at=?
          WHERE tenant_id=? AND item_ref=?`,
      ).bind(state, code, stamp, tenantId, itemRef),
      env.DB.prepare(
        `UPDATE bank_feed_items SET status=?,status_detail=?,last_error_at=?
          WHERE tenant_id=? AND item_ref=?`,
      ).bind(itemStatus, safeFeedError(error), stamp,
        tenantId, itemRef),
      env.DB.prepare(
        `INSERT INTO plaid_reconciliation
           (tenant_id,item_ref,reason,state,due_at,attempts,last_error_code,updated_at)
         VALUES (?,?,'sync_failure','retryable',?,1,?,?)
         ON CONFLICT(tenant_id,item_ref) DO UPDATE SET state='retryable',due_at=excluded.due_at,
           attempts=plaid_reconciliation.attempts+1,last_error_code=excluded.last_error_code,
           updated_at=excluded.updated_at`,
      ).bind(tenantId, itemRef, stamp, code, stamp),
    ]);
    return { item_ref: itemRef, ok: false, status: state, reason: safeFeedError(error) };
  }
}

export async function runPlaidFeedSlice(env, {
  maxItems = 3,
  fetchImpl = fetch,
  now = null,
} = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = nowIso(now);
  const rows = (await env.DB.prepare(
    `SELECT i.item_ref
       FROM bank_feed_items i
       LEFT JOIN plaid_reconciliation r ON r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref
      WHERE i.tenant_id=? AND i.removed_at IS NULL AND i.status IN ('connected','error')
        AND (r.item_ref IS NULL OR (r.state IN ('pending','retryable') AND r.due_at<=?))
      ORDER BY COALESCE(i.last_synced_at,'') LIMIT ?`,
  ).bind(tenantId, stamp, Math.min(Math.max(Number(maxItems) || 3, 1), 10)).all())?.results || [];
  const items = [];
  for (const row of rows) items.push(await syncPlaidItem(env, row.item_ref, { fetchImpl, now: stamp }));
  return { ran: items.length, items };
}

async function queueReconciliation(env, tenantId, itemRef, reason, stamp) {
  if (!itemRef) return;
  await env.DB.prepare(
    `INSERT INTO plaid_reconciliation
       (tenant_id,item_ref,reason,state,due_at,attempts,updated_at)
     VALUES (?,?,?,'pending',?,0,?)
     ON CONFLICT(tenant_id,item_ref) DO UPDATE SET reason=excluded.reason,state='pending',
       due_at=excluded.due_at,updated_at=excluded.updated_at`,
  ).bind(tenantId, itemRef, reason, stamp, stamp).run();
}

async function plaidJwk(env, keyId, fetchImpl, stamp) {
  const cached = await env.DB.prepare(
    "SELECT jwk_json FROM plaid_webhook_keys WHERE key_id=? AND expires_at>?",
  ).bind(keyId, stamp).first();
  if (cached?.jwk_json) return JSON.parse(cached.jwk_json);
  const response = await callPlaid(env, "/webhook_verification_key/get", { key_id: keyId }, { fetchImpl });
  const key = response.key;
  if (!key || key.kid !== keyId) throw new Error("Plaid returned no matching webhook verification key");
  const expiresAt = new Date(Date.parse(stamp) + 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO plaid_webhook_keys (key_id,jwk_json,fetched_at,expires_at) VALUES (?,?,?,?)
     ON CONFLICT(key_id) DO UPDATE SET jwk_json=excluded.jwk_json,fetched_at=excluded.fetched_at,
       expires_at=excluded.expires_at`,
  ).bind(keyId, JSON.stringify(key), stamp, expiresAt).run();
  return key;
}

export async function handlePlaidWebhook(env, request, { fetchImpl = fetch, now = null } = {}) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const stamp = nowIso(now);
  const rawBody = await request.text();
  if (textBytes(rawBody).byteLength > 256 * 1024) return new Response("payload too large", { status: 413 });
  const verificationJwt = request.headers.get("Plaid-Verification");
  let verified;
  try {
    verified = await verifyPlaidWebhook({
      rawBody,
      verificationJwt,
      getJwk: (keyId) => plaidJwk(env, keyId, fetchImpl, stamp),
      now: Date.parse(stamp),
    });
  } catch {
    return new Response("invalid webhook", { status: 401 });
  }
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return new Response("invalid webhook", { status: 400 }); }
  const { tenantId } = tenantReference(env);
  const seen = await env.DB.prepare(
    "SELECT delivery_id FROM plaid_webhook_events WHERE delivery_id=?",
  ).bind(verified.deliveryId).first();
  const latest = payload.item_id ? await env.DB.prepare(
    "SELECT MAX(issued_at) AS issued_at FROM plaid_webhook_events WHERE tenant_id=? AND item_ref=?",
  ).bind(tenantId, String(payload.item_id)).first() : null;
  const disposition = plaidWebhookDisposition({
    deliverySeen: Boolean(seen),
    issuedAt: verified.issuedAt,
    lastIssuedAt: Number.isInteger(latest?.issued_at) ? latest.issued_at : null,
    payload,
  });
  if (!seen) {
    await env.DB.prepare(
      `INSERT INTO plaid_webhook_events
         (delivery_id,tenant_id,item_ref,webhook_type,webhook_code,key_id,issued_at,
          body_sha256,state,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(verified.deliveryId, tenantId, payload.item_id || null, payload.webhook_type || null,
      payload.webhook_code || null, verified.kid, verified.issuedAt, verified.bodyHash,
      disposition.state, stamp).run();
  }
  if (disposition.scheduleReconciliation) {
    await queueReconciliation(env, tenantId, payload.item_id || null,
      disposition.state === "out_of_order" ? "out_of_order_webhook" : "webhook", stamp);
  }
  return new Response("accepted", { status: 200 });
}

export async function drainPlaidRevocations(env, {
  maxItems = 3,
  fetchImpl = fetch,
  now = null,
} = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = nowIso(now);
  const rows = (await env.DB.prepare(
    `SELECT o.item_ref,i.access_ciphertext,i.access_iv,i.key_version
       FROM plaid_revocation_outbox o
       JOIN bank_feed_items i ON i.tenant_id=o.tenant_id AND i.item_ref=o.item_ref
      WHERE o.tenant_id=? AND o.state IN ('pending','retryable') AND o.next_attempt_at<=?
      ORDER BY o.requested_at LIMIT ?`,
  ).bind(tenantId, stamp, Math.min(Math.max(Number(maxItems) || 3, 1), 10)).all())?.results || [];
  const results = [];
  for (const row of rows) {
    let providerResult;
    try {
      const accessToken = await decryptAccessReference(env, {
        ciphertext: row.access_ciphertext,
        iv: row.access_iv,
        keyVersion: row.key_version,
      });
      await callPlaid(env, "/item/remove", { access_token: accessToken }, { fetchImpl });
      providerResult = { removed: true };
    } catch (error) {
      providerResult = { removed: false, errorCode: boundedCode(error) };
    }
    const transition = plaidRevocationTransition({ state: "pending", providerResult });
    if (transition.eraseAccessToken) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE bank_feed_items SET status='removed',status_detail='The account holder disconnected this bank.',
              removed_at=?,access_ciphertext='REMOVED0000000000000000',access_iv='REMOVED000000000'
            WHERE tenant_id=? AND item_ref=?`,
        ).bind(stamp, tenantId, row.item_ref),
        env.DB.prepare(
          `UPDATE plaid_revocation_outbox SET state='confirmed',attempts=attempts+1,
              last_error_code=NULL,updated_at=?,confirmed_at=? WHERE tenant_id=? AND item_ref=?`,
        ).bind(stamp, stamp, tenantId, row.item_ref),
      ]);
    } else {
      const retryAt = new Date(Date.parse(stamp) + 5 * 60_000).toISOString();
      await env.DB.prepare(
        `UPDATE plaid_revocation_outbox SET state='retryable',attempts=attempts+1,
            next_attempt_at=?,last_error_code=?,updated_at=? WHERE tenant_id=? AND item_ref=?`,
      ).bind(retryAt, providerResult.errorCode, stamp, tenantId, row.item_ref).run();
    }
    results.push({ item_ref: row.item_ref, confirmed: transition.eraseAccessToken });
  }
  return { ran: results.length, items: results };
}

export async function disconnectPlaidItem(env, itemRef, {
  fetchImpl = fetch,
  now = null,
} = {}) {
  const { tenantId } = tenantReference(env);
  const stamp = nowIso(now);
  const item = await itemRow(env, tenantId, itemRef);
  if (!item) return { ok: false, reason: "that connection is not on this brain" };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO plaid_revocation_outbox
         (tenant_id,item_ref,state,attempts,next_attempt_at,requested_at,updated_at)
       VALUES (?,?,'pending',0,?,?,?)
       ON CONFLICT(tenant_id,item_ref) DO UPDATE SET
         state=CASE WHEN plaid_revocation_outbox.state='confirmed' THEN 'confirmed' ELSE 'pending' END,
         next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`,
    ).bind(tenantId, itemRef, stamp, stamp, stamp),
    env.DB.prepare(
      `UPDATE bank_feed_items SET status='permission_revoked',
          status_detail='Disconnect requested. Provider removal is pending.'
        WHERE tenant_id=? AND item_ref=?`,
    ).bind(tenantId, itemRef),
  ]);
  const drained = await drainPlaidRevocations(env, { maxItems: 1, fetchImpl, now: stamp });
  const confirmed = drained.items.some((entry) => entry.item_ref === itemRef && entry.confirmed);
  return {
    ok: true,
    revoked_at_provider: confirmed,
    revocation_state: confirmed ? "confirmed" : "retryable",
    history_kept: true,
    detail: confirmed
      ? "The provider confirmed removal. Financial history was kept."
      : "Removal is queued for retry. The encrypted access token is retained only for provider revocation.",
  };
}

export async function plaidFeedStatus(env) {
  const { tenantId } = tenantReference(env);
  let config;
  try { config = bankFeedConfig(env); } catch {
    return {
      configured: false,
      provider: PROVIDER,
      environment: env.BANK_FEED_ENV === "production" ? "production" : "sandbox",
      signed_webhook_path: PLAID_WEBHOOK_PATH,
      connections: [],
      needs_attention: [],
    };
  }
  const rows = (await env.DB.prepare(
    `SELECT i.item_ref,i.institution_label,i.environment,i.status,i.status_detail,i.connected_at,
            i.last_synced_at,b.state AS history_state,b.pages_done,b.transactions_seen,b.unread_lines,
            r.state AS reconciliation_state,r.due_at,o.state AS revocation_state,o.attempts AS revocation_attempts
       FROM bank_feed_items i
       LEFT JOIN bank_feed_backfill b ON b.tenant_id=i.tenant_id AND b.item_ref=i.item_ref
       LEFT JOIN plaid_reconciliation r ON r.tenant_id=i.tenant_id AND r.item_ref=i.item_ref
       LEFT JOIN plaid_revocation_outbox o ON o.tenant_id=i.tenant_id AND o.item_ref=i.item_ref
      WHERE i.tenant_id=? AND (i.removed_at IS NULL OR o.state<>'confirmed') ORDER BY i.connected_at`,
  ).bind(tenantId).all())?.results || [];
  return {
    configured: true,
    provider: PROVIDER,
    environment: config.environment,
    signed_webhook_path: PLAID_WEBHOOK_PATH,
    reconciliation_interval_minutes: Number(env.BANK_FEED_RECONCILE_MINUTES || DEFAULT_RECONCILE_MINUTES),
    connections: rows.map((row) => ({
      item_ref: row.item_ref,
      institution_label: row.institution_label,
      environment: row.environment,
      status: row.status,
      status_detail: row.status_detail,
      connected_at: row.connected_at,
      last_synced_at: row.last_synced_at,
      history: {
        state: row.history_state || "none",
        pages_done: row.pages_done || 0,
        transactions_seen: row.transactions_seen || 0,
        unread_lines: row.unread_lines || 0,
      },
      reconciliation: { state: row.reconciliation_state || "none", due_at: row.due_at || null },
      revocation: { state: row.revocation_state || "none", attempts: row.revocation_attempts || 0 },
    })),
    needs_attention: rows.filter((row) => row.status !== "connected" ||
      ["retryable", "unavailable", "refused"].includes(row.reconciliation_state) ||
      row.revocation_state === "retryable").map((row) => ({
      item_ref: row.item_ref,
      status: row.status,
      detail: row.status_detail,
      reconciliation_state: row.reconciliation_state || null,
      revocation_state: row.revocation_state || null,
    })),
  };
}

export async function runPlaidMaintenance(env, options = {}) {
  const revocations = await drainPlaidRevocations(env, options);
  const sync = await runPlaidFeedSlice(env, options);
  return { revocations, sync };
}
