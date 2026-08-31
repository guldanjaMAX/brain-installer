/**
 * bank-feed — a hosted, read-only bank connection, running inside the CLIENT's
 * own worker and writing into the client's own ledger.
 *
 * WHAT THIS IS, IN THE OWNER'S WORDS
 *
 * The account holder connects their own bank, themselves, in their own browser.
 * The bank login happens on the bank's own site or on the aggregator's hosted
 * screen. No password, no one-time code, no security question and no bank
 * credential of any kind is ever seen, requested, handled or stored by the
 * operator, by this code, or by anyone but the account holder and their bank.
 * What comes back is a read-only reference for FETCHING transaction history. It
 * cannot move money, and it lives encrypted in the client's own database inside
 * the client's own cloud account.
 *
 * The read-only guarantee is not enforced by this code being careful. It is
 * enforced at authorisation time by never requesting a product that can move
 * money — see `REQUESTED_PRODUCTS` and `FORBIDDEN_PRODUCTS`, which a test
 * asserts against literally so a future "just add one more scope" cannot land
 * unreviewed.
 *
 * WHY EVERY IDENTIFIER COMES FROM `env`
 *
 * The two service identifiers are read from the environment, never from a
 * module constant, and the aggregator's own hostname with them. That is what
 * keeps the deployment model reversible: per-client credentials (recommended:
 * one client's blast radius is one client) and a shared operator account differ
 * only in what values are set, not in what code runs. The tenant reference is
 * confined to `tenantReference()` for the same reason — under per-client it is
 * cosmetic, under shared it is load-bearing, and there is exactly one place to
 * change it.
 *
 * THE SIGN CONVENTION — read this before touching an amount.
 *
 * This provider reports a POSITIVE number when money LEAVES the account, and a
 * negative one when money arrives. That is the opposite of a downloaded OFX
 * file, where a negative amount is money leaving. Both are normalised at the
 * one write boundary (`fin-import.js`) into an unsigned amount plus an explicit
 * direction, and the signed source figure travels with it. Getting this
 * backwards turns income into spending and a profit into a loss while every
 * citation still resolves, which is the most expensive mistake available here.
 */

import { jsonResponse, privateNoStore, validateAdminKey } from "./core.js";
import { ownerSessionPrincipal } from "./owner-auth.js";
import { importBankExport, balanceRoleFor } from "./fin-import.js";
import { bankFeedProfile } from "./bank-feed-profiles.js";
import {
  assignPlaidAccountEntity,
  PlaidAccountEntityError,
  plaidOwnerAccountStatus,
} from "./plaid-account-entities.js";

/**
 * THE HOSTED FEED'S SIGN CONVENTION, WRITTEN DOWN ONCE.
 *
 *     amount is POSITIVE  ->  money LEAVES the account  ->  outflow
 *     amount is NEGATIVE  ->  money ARRIVES             ->  inflow
 *
 * Pinned by `worker/test/bank-feed.test.mjs`. Inverting the two lines in
 * `directionFor()` below makes that test fail by name.
 */
export const BANK_FEED_SIGN_CONVENTION = "feed_positive_amount_is_outflow";

/** THE CONVENTION, APPLIED. The only place a feed amount becomes a direction. */
export function directionFor(amount) {
  return amount > 0 ? "outflow" : "inflow";
}

/**
 * The only products this brain ever asks for. `transactions` is read-only: it
 * has no capability to move money, and none of the products that do is here.
 */
export const REQUESTED_PRODUCTS = Object.freeze(["transactions"]);

/**
 * Never request these. The first three can initiate money movement. The fourth
 * returns full account and routing numbers: still read-only, but it converts
 * this database into a store of directly actionable payment details and changes
 * the consequence of a breach entirely. If a stated requirement ever needs one,
 * it needs a decision record, not a diff.
 */
export const FORBIDDEN_PRODUCTS = Object.freeze([
  "transfer", "payment_initiation", "standing_orders", "auth",
]);

/** Two years, the same depth the reference implementation requested. */
export const BACKFILL_DAYS = 730;

/** Pages per invocation. Bounded so a long load resumes instead of restarting. */
export const MAX_PAGES_PER_SLICE = 4;
const PAGE_SIZE = 250;
const CALL_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------ configuration */

class FeedConfigError extends Error {}

/**
 * Everything this connector needs, read from the environment.
 *
 * There is no default host and no default credential anywhere in this file on
 * purpose: a missing configuration must fail loudly at the operator, not
 * silently reach somebody else's endpoint.
 */
export function bankFeedConfig(env) {
  const clientId = env.BANK_FEED_CLIENT_ID;
  const secret = env.BANK_FEED_SECRET;
  const environment = env.BANK_FEED_ENV === "production" ? "production" : "sandbox";
  const profile = bankFeedProfile(env, environment);
  const apiBase = profile.apiBase;
  const missing = [
    !clientId && "BANK_FEED_CLIENT_ID",
    !secret && "BANK_FEED_SECRET",
    !apiBase && "BANK_FEED_API_BASE",
    !bankAccessWrappingKeyConfigured(env) && BANK_ACCESS_WRAPPING_KEY_SECRET,
  ].filter(Boolean);
  if (missing.length) {
    throw new FeedConfigError(
      `the bank feed is not configured on this brain (${missing.join(", ")} not set). ` +
      "Run `brain deploy` and then `brain secrets`, in that order.",
    );
  }
  let base;
  try { base = new URL(apiBase); } catch {
    throw new FeedConfigError("BANK_FEED_API_BASE is not a valid URL");
  }
  if (base.protocol !== "https:") {
    throw new FeedConfigError("BANK_FEED_API_BASE must be https");
  }
  return {
    clientId, secret, environment,
    provider: profile.provider,
    apiBase: base.origin,
    linkSdkUrl: profile.linkSdkUrl,
    // The browser global the provider's SDK installs. Configured, never
    // hard-coded, for the same reason the host is: a change of aggregator
    // should be a manifest edit and not a code change in every install.
    linkGlobal: profile.linkGlobal,
    displayName: env.BANK_FEED_DISPLAY_NAME || env.BRAIN_NAME || "this brain",
    countryCodes: String(env.BANK_FEED_COUNTRIES || "US").split(",").map((c) => c.trim()).filter(Boolean),
  };
}

export function bankFeedEnabled(env) {
  const environment = env.BANK_FEED_ENV === "production" ? "production" : "sandbox";
  const profile = bankFeedProfile(env, environment);
  return Boolean(
    env.BANK_FEED_CLIENT_ID &&
    env.BANK_FEED_SECRET &&
    profile.apiBase &&
    bankAccessWrappingKeyConfigured(env)
  );
}

/**
 * THE TENANT REFERENCE, IN ONE FUNCTION.
 *
 * `tenantId` scopes every ledger row. `endUserRef` is what the aggregator files
 * this authorisation under. Under the recommended per-client deployment both
 * are effectively cosmetic, because isolation comes from separate accounts and
 * separate databases. Under a shared operator account `endUserRef` becomes the
 * key that keeps two clients' bank data apart, and this is the one function
 * that would change. Keeping it here is what makes that decision reversible
 * instead of a rewrite.
 *
 * It is derived from the install's own slug and never from a person's name.
 */
export function tenantReference(env) {
  const tenantId = String(env.BANK_FEED_TENANT || "primary");
  const slug = String(env.BRAIN_NAME || "brain").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);
  return { tenantId, endUserRef: `install:${slug || "brain"}` };
}

/**
 * The scope key for everything this connection writes into the ledger.
 * One equality match removes it all, the same property `sources.name` gives the
 * document corpus.
 */
export function feedScopeKey(itemRef) {
  return `bank-feed:${itemRef}`;
}

/**
 * The address the bank returns the browser to.
 *
 * This must be REGISTERED WITH THE PROVIDER, per host, before it will work, and
 * every brain has its own hostname. That is why `brain doctor` checks it: the
 * alternative is finding out while a client is sitting there mid-login.
 */
export function redirectUriFor(url) {
  return `${new URL(url).origin}/app/connect/bank`;
}

/* ------------------------------------------------------------ the transport */

class FeedError extends Error {
  constructor(message, code = null, status = null) {
    super(message);
    this.name = "FeedError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Anything that could carry a secret, removed before a message is stored,
 * logged, or shown.
 *
 * The provider attaches its full request context to some errors, and the
 * reference implementation put `String(e.message)` straight into an API
 * response. That is how an access reference ends up in a support ticket. This
 * strips UUID-shaped values and long opaque tokens, and it is applied on EVERY
 * path out of this module, not only the ones that look risky.
 */
export function redactFeedText(text) {
  return String(text || "")
    .replace(/access-(?:production|sandbox|development)-[0-9a-f-]{8,}/gi, "[redacted access reference]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[redacted identifier]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 300);
}

/** A message safe to show a person, derived from any thrown thing. */
export function safeFeedError(error) {
  if (error instanceof FeedConfigError) return error.message;
  const code = error?.code ? ` (${String(error.code).slice(0, 60)})` : "";
  return `the bank feed could not be reached${code}: ${redactFeedText(error?.message)}`;
}

/**
 * One call to the provider.
 *
 * Timed out, because a hung fetch inside a scheduled invocation costs the whole
 * slice. The credentials are attached here and only here; no caller ever holds
 * them, and no error raised here carries the request body.
 */
async function callFeed(env, path, body, { fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const config = bankFeedConfig(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    });
  } catch (error) {
    throw new FeedError(
      error?.name === "AbortError" ? "the request timed out" : redactFeedText(error?.message),
      "TRANSPORT",
    );
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    // Deliberately NOT the provider's whole error object. The code is what a
    // person or a state machine can act on; the rest is a leak surface.
    throw new FeedError(
      redactFeedText(payload?.error_message || `request failed with status ${response.status}`),
      payload?.error_code || null,
      response.status,
    );
  }
  return payload || {};
}

/* -------------------------------------------------- access reference custody */

/**
 * Version 1 is the released legacy contract. It derived the encryption key
 * from SESSION_SIGNING_KEY (or ADMIN_KEY), so restoring or rotating either
 * secret could strand an otherwise valid bank connection.
 *
 * Version 2 is intentionally a different Worker secret with a version in its
 * name and value. It must be copied or rewrapped deliberately during recovery;
 * session and admin signing material are never accepted as a substitute.
 */
export const LEGACY_BANK_ACCESS_KEY_VERSION = 1;
export const BANK_ACCESS_WRAPPING_KEY_VERSION = 2;
export const BANK_ACCESS_WRAPPING_KEY_SECRET = (["BANK_FEE","D_WRAPPI","NG_KEY_V","2"].join(""));

const BANK_ACCESS_REAUTH_DETAIL =
  "This bank connection's protected access reference cannot be opened with the current wrapping key. " +
  "The account holder must connect it again before new activity can be read.";

class BankAccessKeyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BankAccessKeyError";
    this.code = code;
  }
}

function bytes(text) { return new TextEncoder().encode(String(text)); }

function toBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fromBase64Url(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

/**
 * The encryption key, derived rather than stored.
 *
 * Derived from a worker secret the database does not contain, so a copy of the
 * database is not a copy of the bank connections. Fails closed: no key material
 * means no storage, never plaintext storage.
 */
async function legacyAccessKey(env) {
  const material = env.SESSION_SIGNING_KEY || env.ADMIN_KEY;
  if (!material) {
    throw new BankAccessKeyError(
      "the legacy bank access-reference key is unavailable",
      "BANK_ACCESS_LEGACY_KEY_UNAVAILABLE",
    );
  }
  const base = await crypto.subtle.importKey("raw", bytes(material), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes("brain.bank-feed.v1"), info: bytes("access-reference") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function wrappingKeyBytes(env) {
  const value = env?.[BANK_ACCESS_WRAPPING_KEY_SECRET];
  if (typeof value !== "string" || !/^v2\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new BankAccessKeyError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} is missing or invalid; run the reviewed bank-key ceremony before storing a connection`,
      "BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE",
    );
  }
  const decoded = fromBase64Url(value.slice(3));
  if (decoded.length !== 32) {
    throw new BankAccessKeyError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} is invalid`,
      "BANK_ACCESS_WRAPPING_KEY_INVALID",
    );
  }
  return decoded;
}

async function dedicatedAccessKey(env) {
  const base = await crypto.subtle.importKey(
    "raw", wrappingKeyBytes(env), "HKDF", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes("brain.bank-feed.wrapping.v2"),
      info: bytes("access-reference-aes-gcm-v2"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function accessKey(env, keyVersion) {
  if (Number(keyVersion) === LEGACY_BANK_ACCESS_KEY_VERSION) return legacyAccessKey(env);
  if (Number(keyVersion) === BANK_ACCESS_WRAPPING_KEY_VERSION) return dedicatedAccessKey(env);
  throw new BankAccessKeyError(
    "the bank access reference uses an unsupported wrapping-key version",
    "BANK_ACCESS_WRAPPING_KEY_VERSION_UNSUPPORTED",
  );
}

export function bankAccessWrappingKeyConfigured(env) {
  try {
    wrappingKeyBytes(env);
    return true;
  } catch {
    return false;
  }
}

function hex(bytesValue) {
  return Array.from(new Uint8Array(bytesValue), (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Return a non-secret equality proof for recovery. The wrapping key is a full
 * random 256-bit value, so its SHA-256 fingerprint lets a disposable target
 * prove exact custody without returning the key or accepting it in a request.
 */
export async function bankAccessWrappingKeyProof(env) {
  if (!bankAccessWrappingKeyConfigured(env)) {
    return {
      configured: false,
      key_version: BANK_ACCESS_WRAPPING_KEY_VERSION,
      key_fingerprint: null,
    };
  }
  const material = wrappingKeyBytes(env);
  try {
    return {
      configured: true,
      key_version: BANK_ACCESS_WRAPPING_KEY_VERSION,
      key_fingerprint: hex(await crypto.subtle.digest("SHA-256", material)),
    };
  } finally {
    material.fill(0);
  }
}

export async function encryptAccessReference(
  env,
  reference,
  { keyVersion = BANK_ACCESS_WRAPPING_KEY_VERSION } = {},
) {
  const key = await accessKey(env, keyVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes(reference));
  return { ciphertext: toBase64(sealed), iv: toBase64(iv), keyVersion };
}

export async function decryptAccessReference(env, { ciphertext, iv, keyVersion = null }) {
  const version = keyVersion ?? LEGACY_BANK_ACCESS_KEY_VERSION;
  const key = await accessKey(env, version);
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext),
    );
    return new TextDecoder().decode(opened);
  } catch (error) {
    if (error instanceof BankAccessKeyError) throw error;
    throw new BankAccessKeyError(
      "the bank access reference cannot be opened with its declared wrapping key",
      "BANK_ACCESS_REFERENCE_UNREADABLE",
    );
  }
}

/* ------------------------------------------------------------ normalisation */

const KIND_BY_TYPE = new Map([
  ["depository:checking", "checking"],
  ["depository:savings", "savings"],
  ["depository:money market", "savings"],
  ["credit:credit card", "card"],
  ["loan:auto", "loan"],
  ["loan:mortgage", "loan"],
  ["loan:student", "loan"],
  ["loan:line of credit", "line_of_credit"],
  ["investment:brokerage", "investment"],
  ["investment:ira", "retirement"],
  ["investment:401k", "retirement"],
]);

/**
 * The provider's account type onto the ledger's account kind.
 *
 * The default is `other`, which the ledger records with a balance role of
 * `neither`. That is the point: an account whose kind is unrecognised must not
 * be counted as cash on the strength of a guess. A loan or a card counted as an
 * asset would inflate a net position by the size of the owner's debts, which is
 * the failure this mapping exists to prevent.
 */
export function accountKindFor(type, subtype) {
  const key = `${String(type || "").toLowerCase()}:${String(subtype || "").toLowerCase()}`;
  if (KIND_BY_TYPE.has(key)) return KIND_BY_TYPE.get(key);
  const base = String(type || "").toLowerCase();
  if (base === "credit") return "card";
  if (base === "loan") return "loan";
  if (base === "depository") return "checking";
  return "other";
}

function minorUnits(amount, currency) {
  if (amount === null || amount === undefined) return null;
  const exponent = currency === "JPY" || currency === "KRW" ? 0 : 2;
  // The provider sends a JSON number. It is converted through its own decimal
  // string, never by multiplying a float, so 12.34 cannot become 1233.
  const text = typeof amount === "number" ? amount.toFixed(exponent) : String(amount);
  const negative = text.trim().startsWith("-");
  const digits = text.replace(/[^0-9.]/g, "");
  const [whole = "0", fraction = ""] = digits.split(".");
  const scaled = Number(`${whole}${fraction.slice(0, exponent).padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(scaled)) return null;
  return negative ? -scaled : scaled;
}

/**
 * One page of feed data, into the SAME envelope a downloaded file produces.
 *
 * That sameness is deliberate: the ledger write path has one implementation and
 * one place where a sign becomes a direction. A second normaliser here would be
 * a second convention waiting to drift.
 */
export function normaliseFeedPage({ itemRef, accounts = [], added = [], modified = [], now }) {
  const byId = new Map();
  for (const account of accounts) {
    const currency = String(account.balances?.iso_currency_code || "USD").toUpperCase();
    const kind = accountKindFor(account.type, account.subtype);
    byId.set(account.account_id, {
      accountKey: `feed-${itemRef}-${account.account_id}`.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 64),
      institution: null,
      label: account.name || null,
      mask: account.mask ? String(account.mask).replace(/\D/g, "").slice(-4) : null,
      accountKind: kind,
      balanceRole: balanceRoleFor(kind),
      currency,
      externalRef: account.account_id,
      periodStart: null,
      periodEnd: null,
      ledgerBalanceMinor: minorUnits(account.balances?.current, currency),
      availableBalanceMinor: minorUnits(account.balances?.available, currency),
      balanceAsOf: now ? String(now).slice(0, 10) : null,
      transactions: [],
    });
  }

  for (const raw of [...added, ...modified]) {
    const account = byId.get(raw.account_id);
    if (!account) continue;
    const rawMinor = minorUnits(raw.amount, account.currency);
    const postedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : null;
    if (rawMinor === null || postedOn === null) {
      account.transactions.push({
        locator: `feed/${raw.transaction_id || "unknown"}`,
        externalId: raw.transaction_id || null,
        postedOn,
        description: raw.name || null,
        payee: raw.merchant_name || null,
        rawAmountMinor: null,
        amountMinor: null,
        direction: null,
        pending: Boolean(raw.pending),
        unparsedReason: rawMinor === null
          ? "the amount the feed reported could not be read as an exact figure"
          : "the feed reported no usable posting date",
      });
      continue;
    }
    account.transactions.push({
      locator: `feed/${raw.transaction_id || "unknown"}`,
      externalId: raw.transaction_id || null,
      postedOn,
      description: raw.name || null,
      payee: raw.merchant_name || null,
      rawAmountMinor: rawMinor,
      amountMinor: Math.abs(rawMinor),
      direction: directionFor(rawMinor),
      pending: Boolean(raw.pending),
      unparsedReason: null,
    });
  }

  const populated = [...byId.values()];
  for (const account of populated) {
    const dated = account.transactions.map((t) => t.postedOn).filter(Boolean).sort();
    account.periodStart = dated[0] || null;
    account.periodEnd = dated[dated.length - 1] || null;
  }
  return {
    ok: true,
    format: "feed",
    signConvention: BANK_FEED_SIGN_CONVENTION,
    establishedBy: "the provider documents a positive amount as money leaving the account",
    sourceDocUid: null,
    sourceLabel: feedScopeKey(itemRef),
    accounts: populated,
  };
}

/* ------------------------------------------------------------------ storage */

async function loadItem(env, tenantId, itemRef) {
  return env.DB.prepare(
    `SELECT item_ref, institution_label, access_ciphertext, access_iv, key_version, environment,
            cursor, status, status_detail, last_synced_at
       FROM bank_feed_items
      WHERE tenant_id = ? AND item_ref = ? AND removed_at IS NULL`,
  ).bind(tenantId, itemRef).first();
}

function accessReferenceState(row, env) {
  if (row?.status === "reauth_required") return "reauthorization_required";
  if (Number(row?.key_version) === LEGACY_BANK_ACCESS_KEY_VERSION) return "legacy_rewrap_required";
  if (Number(row?.key_version) !== BANK_ACCESS_WRAPPING_KEY_VERSION) return "unsupported_key_version";
  return bankAccessWrappingKeyConfigured(env) ? "protected" : "wrapping_key_unavailable";
}

async function recordBankAccessReauthorizationRequired(env, row, now) {
  const result = await env.DB.prepare(
    `UPDATE bank_feed_items
        SET status = 'reauth_required', status_detail = ?, last_error_at = ?
      WHERE tenant_id = ? AND item_ref = ? AND key_version = ?
        AND access_ciphertext = ? AND access_iv = ? AND removed_at IS NULL`,
  ).bind(
    BANK_ACCESS_REAUTH_DETAIL,
    now,
    row.tenant_id,
    row.item_ref,
    row.key_version,
    row.access_ciphertext,
    row.access_iv,
  ).run();
  return Number(result?.meta?.changes || 0) === 1;
}

/**
 * Move released version-1 rows to the dedicated version-2 secret.
 *
 * Each row is compare-and-swap updated and then decrypted from the exact
 * readback. A stop before the write changes nothing; a stop after it resumes
 * by observing key_version=2. If the released derivation is no longer
 * available, the row becomes explicitly reauthorization-required instead of
 * staying "connected" while every scheduled read fails.
 *
 * `mutationBoundary` is a deterministic drill seam. It receives only a fixed
 * stage name and aggregate ordinal, never an item id, ciphertext, or token.
 */
export async function rewrapBankAccessReferences(env, {
  limit = 100,
  now = null,
  mutationBoundary = null,
} = {}) {
  if (!bankAccessWrappingKeyConfigured(env)) {
    throw new BankAccessKeyError(
      `${BANK_ACCESS_WRAPPING_KEY_SECRET} is required before legacy bank access references can be rewrapped`,
      "BANK_ACCESS_WRAPPING_KEY_UNAVAILABLE",
    );
  }
  const bounded = Math.max(1, Math.min(Number(limit) || 100, 100));
  const rows = (await env.DB.prepare(
    `SELECT tenant_id, item_ref, access_ciphertext, access_iv, key_version, status
       FROM bank_feed_items
      WHERE removed_at IS NULL AND key_version = ? AND status <> 'reauth_required'
      ORDER BY id
      LIMIT ?`,
  ).bind(LEGACY_BANK_ACCESS_KEY_VERSION, bounded).all())?.results || [];
  const report = { scanned: rows.length, rewrapped: 0, reauthorization_required: 0, raced: 0 };
  const boundary = async (stage, ordinal) => {
    if (typeof mutationBoundary === "function") await mutationBoundary({ stage, ordinal });
  };
  const stamp = now || new Date().toISOString();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const ordinal = index + 1;
    let reference;
    try {
      reference = await decryptAccessReference(env, {
        ciphertext: row.access_ciphertext,
        iv: row.access_iv,
        keyVersion: row.key_version,
      });
    } catch {
      await boundary("before_reauthorization_required_write", ordinal);
      const changed = await recordBankAccessReauthorizationRequired(env, row, stamp);
      await boundary("after_reauthorization_required_write", ordinal);
      if (changed) report.reauthorization_required++;
      else report.raced++;
      continue;
    }

    const sealed = await encryptAccessReference(env, reference);
    await boundary("before_rewrap_write", ordinal);
    const write = await env.DB.prepare(
      `UPDATE bank_feed_items
          SET access_ciphertext = ?, access_iv = ?, key_version = ?
        WHERE tenant_id = ? AND item_ref = ? AND key_version = ?
          AND access_ciphertext = ? AND access_iv = ? AND removed_at IS NULL`,
    ).bind(
      sealed.ciphertext,
      sealed.iv,
      sealed.keyVersion,
      row.tenant_id,
      row.item_ref,
      row.key_version,
      row.access_ciphertext,
      row.access_iv,
    ).run();
    await boundary("after_rewrap_write", ordinal);

    if (Number(write?.meta?.changes || 0) !== 1) {
      report.raced++;
      continue;
    }
    const verified = await env.DB.prepare(
      `SELECT access_ciphertext, access_iv, key_version
         FROM bank_feed_items
        WHERE tenant_id = ? AND item_ref = ? AND removed_at IS NULL`,
    ).bind(row.tenant_id, row.item_ref).first();
    if (!verified || Number(verified.key_version) !== BANK_ACCESS_WRAPPING_KEY_VERSION ||
        await decryptAccessReference(env, {
          ciphertext: verified.access_ciphertext,
          iv: verified.access_iv,
          keyVersion: verified.key_version,
        }) !== reference) {
      throw new BankAccessKeyError(
        "a bank access-reference rewrap did not read back exactly",
        "BANK_ACCESS_REWRAP_READBACK_FAILED",
      );
    }
    report.rewrapped++;
  }
  const inventory = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN key_version = ? AND status <> 'reauth_required' THEN 1 ELSE 0 END),0)
         AS legacy_rewrap_required,
       COALESCE(SUM(CASE WHEN key_version = ? AND status <> 'reauth_required' THEN 1 ELSE 0 END),0)
         AS protected,
       COALESCE(SUM(CASE WHEN status = 'reauth_required' THEN 1 ELSE 0 END),0)
         AS reauthorization_required_total,
       COALESCE(SUM(CASE WHEN key_version NOT IN (?,?) THEN 1 ELSE 0 END),0)
         AS unsupported_key_versions
       FROM bank_feed_items WHERE removed_at IS NULL`,
  ).bind(
    LEGACY_BANK_ACCESS_KEY_VERSION,
    BANK_ACCESS_WRAPPING_KEY_VERSION,
    LEGACY_BANK_ACCESS_KEY_VERSION,
    BANK_ACCESS_WRAPPING_KEY_VERSION,
  ).first();
  return {
    ...report,
    legacy_rewrap_required: Number(inventory?.legacy_rewrap_required || 0),
    protected: Number(inventory?.protected || 0),
    reauthorization_required_total: Number(inventory?.reauthorization_required_total || 0),
    unsupported_key_versions: Number(inventory?.unsupported_key_versions || 0),
  };
}

/* ----------------------------------------------------------- authorisation */

/**
 * Start an authorisation the OWNER completes.
 *
 * Returns only the short-lived handoff value the browser needs and the address
 * the bank returns to. Nothing here is a credential, and nothing here is
 * written to the database.
 */
export async function createLinkToken(env, {
  url,
  mode = "connect",
  itemRef = null,
  requestId = null,
  fetchImpl = fetch,
} = {}) {
  const config = bankFeedConfig(env);
  if (config.provider === "plaid") {
    const { createPlaidLinkToken } = await import("./plaid-bank-feed.js");
    return createPlaidLinkToken(env, { url, mode, itemRef, sessionRef: requestId, fetchImpl });
  }
  const { tenantId, endUserRef } = tenantReference(env);
  const redirectUri = redirectUriFor(url);
  const body = {
    user: { client_user_id: endUserRef },
    client_name: config.displayName,
    country_codes: config.countryCodes,
    language: "en",
    redirect_uri: redirectUri,
  };
  if (mode === "reauthorise") {
    if (!itemRef) throw new FeedError("a re-authorisation must name the connection it is repairing", "NO_ITEM");
    const item = await loadItem(env, tenantId, itemRef);
    if (!item) throw new FeedError("that connection is not on this brain", "NO_ITEM");
    // Re-authorisation reuses the SAME connection. Exchanging a new reference
    // here would leave the old one orphaned and the history split in two.
    body.access_token = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext, iv: item.access_iv, keyVersion: item.key_version,
    });
  } else {
    body.products = [...REQUESTED_PRODUCTS];
    body.transactions = { days_requested: BACKFILL_DAYS };
  }
  const created = await callFeed(env, "/link/token/create", body, { fetchImpl });
  const now = new Date().toISOString();
  const sessionRef = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bank_feed_link_sessions
       (tenant_id, session_ref, mode, item_ref, redirect_uri, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    tenantId, sessionRef, mode === "reauthorise" ? "reauthorise" : "connect", itemRef,
    redirectUri, now, created.expiration || new Date(Date.now() + 30 * 60_000).toISOString(),
  ).run();
  return {
    link_token: created.link_token,
    expiration: created.expiration || null,
    session_ref: sessionRef,
    redirect_uri: redirectUri,
    environment: config.environment,
  };
}

/**
 * Turn the owner's completed authorisation into a stored, encrypted reference,
 * and QUEUE the history load. The two-year backfill is deliberately not run
 * here: it cannot finish inside one request, and a request that dies halfway
 * through would leave the owner staring at a spinner with nothing to resume.
 */
export async function exchangePublicToken(env, {
  sessionRef = null, publicToken, institutionRef = null, institutionLabel = null, fetchImpl = fetch,
} = {}) {
  const config = bankFeedConfig(env);
  if (config.provider === "plaid") {
    const { completePlaidLink } = await import("./plaid-bank-feed.js");
    return completePlaidLink(env, {
      sessionRef, publicToken, institutionRef, institutionLabel, fetchImpl,
    });
  }
  const { tenantId } = tenantReference(env);
  if (!publicToken || typeof publicToken !== "string") {
    throw new FeedError("no authorisation handoff value was supplied", "NO_PUBLIC_TOKEN");
  }
  const exchanged = await callFeed(env, "/item/public_token/exchange", { public_token: publicToken }, { fetchImpl });
  const itemRef = exchanged.item_id;
  if (!itemRef || !exchanged.access_token) {
    throw new FeedError("the provider returned no usable connection reference", "NO_ITEM");
  }
  const sealed = await encryptAccessReference(env, exchanged.access_token);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO bank_feed_items
       (tenant_id, item_ref, institution_ref, institution_label, access_ciphertext, access_iv,
        key_version, environment, status, connected_at)
     VALUES (?,?,?,?,?,?,?,?,'connected',?)
     ON CONFLICT (tenant_id, item_ref) DO UPDATE SET
       access_ciphertext = excluded.access_ciphertext,
       access_iv = excluded.access_iv,
       key_version = excluded.key_version,
       institution_ref = COALESCE(excluded.institution_ref, bank_feed_items.institution_ref),
       institution_label = COALESCE(excluded.institution_label, bank_feed_items.institution_label),
       status = 'connected',
       status_detail = NULL,
       removed_at = NULL`,
  ).bind(
    tenantId, itemRef, institutionRef, institutionLabel,
    sealed.ciphertext, sealed.iv, sealed.keyVersion, config.environment, now,
  ).run();

  await env.DB.prepare(
    `INSERT INTO bank_feed_backfill (tenant_id, item_ref, requested_days, state, queued_at)
     VALUES (?,?,?,'queued',?)
     ON CONFLICT (tenant_id, item_ref) DO UPDATE SET
       state = CASE WHEN bank_feed_backfill.state = 'complete' THEN 'complete' ELSE 'queued' END,
       last_error = NULL`,
  ).bind(tenantId, itemRef, BACKFILL_DAYS, now).run();

  return {
    item_ref: itemRef,
    institution_label: institutionLabel,
    environment: config.environment,
    history: {
      state: "queued",
      requested_days: BACKFILL_DAYS,
      note: "Two years of history is being loaded in the background. Progress is on the connection status.",
    },
  };
}

/* ------------------------------------------------------------------- syncing */

/**
 * One bounded slice of work for one connection.
 *
 * The cursor is committed AFTER EVERY PAGE, together with that page's rows, and
 * the slice stops after `maxPages`. Committing only at the end means a first
 * load that cannot finish inside one invocation never finishes at all: it is
 * killed by the clock, the cursor never moves, and the next run repeats the
 * same doomed work forever.
 */
export async function syncItemSlice(env, itemRef, {
  maxPages = MAX_PAGES_PER_SLICE, fetchImpl = fetch, now = null,
} = {}) {
  if (bankFeedConfig(env).provider === "plaid") {
    const { syncPlaidItem } = await import("./plaid-bank-feed.js");
    return syncPlaidItem(env, itemRef, { fetchImpl, now });
  }
  const { tenantId } = tenantReference(env);
  const item = await loadItem(env, tenantId, itemRef);
  if (!item) return { item_ref: itemRef, ok: false, reason: "that connection is not on this brain" };
  const stamp = now || new Date().toISOString();
  let cursor = item.cursor || undefined;
  let pages = 0;
  let transactions = 0;
  let unread = 0;
  let hasMore = true;
  let accounts = [];

  try {
    const accessReference = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext, iv: item.access_iv, keyVersion: item.key_version,
    });
    // Structure comes from the cached endpoint. The live balance endpoint pulls
    // from the institution in real time and is rate limited far more tightly;
    // spending that budget on every routine sync is how a feed starts failing
    // at exactly the moment somebody is watching it.
    const structure = await callFeed(env, "/accounts/get", { access_token: accessReference }, { fetchImpl });
    accounts = structure.accounts || [];

    while (hasMore && pages < maxPages) {
      const page = await callFeed(env, "/transactions/sync", {
        access_token: accessReference, cursor, count: PAGE_SIZE,
      }, { fetchImpl });
      const envelope = normaliseFeedPage({
        itemRef,
        accounts,
        added: page.added || [],
        modified: page.modified || [],
        now: stamp,
      });
      const receipt = await importBankExport(env, envelope, {
        tenantId,
        entitySlug: String(env.BANK_FEED_ENTITY || "primary"),
        now: stamp,
        origin: { provenance: "feed", sourceFeed: feedScopeKey(itemRef) },
      });
      transactions += receipt.transactions;
      unread += receipt.unread_lines;

      // A removed line is TOMBSTONED, never deleted. Deleting makes "why did
      // last month's total change" unanswerable and is unrecoverable; the
      // corpus already takes this position for documents and a ledger has less
      // excuse than a corpus.
      for (const removed of page.removed || []) {
        if (!removed?.transaction_id) continue;
        await env.DB.prepare(
          `UPDATE fin_transactions
              SET removed_at = ?, removal_reason = 'the feed withdrew this line'
            WHERE tenant_id = ? AND external_id = ? AND removed_at IS NULL`,
        ).bind(stamp, tenantId, removed.transaction_id).run();
      }

      cursor = page.next_cursor || cursor;
      hasMore = Boolean(page.has_more);
      pages++;
      // Committed with the page, not at the end of the run.
      await env.DB.prepare(
        `UPDATE bank_feed_items
            SET cursor = ?, cursor_updated_at = ?, last_synced_at = ?, status = 'connected', status_detail = NULL
          WHERE tenant_id = ? AND item_ref = ?`,
      ).bind(cursor || null, stamp, stamp, tenantId, itemRef).run();
    }
  } catch (error) {
    const status = error instanceof BankAccessKeyError
      ? { state: "reauth_required", detail: BANK_ACCESS_REAUTH_DETAIL }
      : classifyItemError(error?.code);
    await env.DB.prepare(
      `UPDATE bank_feed_items SET status = ?, status_detail = ?, last_error_at = ?
        WHERE tenant_id = ? AND item_ref = ?`,
    ).bind(status.state, status.detail, stamp, tenantId, itemRef).run();
    return {
      item_ref: itemRef, ok: false, pages, transactions, unread_lines: unread,
      status: status.state, reason: safeFeedError(error),
    };
  }

  return { item_ref: itemRef, ok: true, pages, transactions, unread_lines: unread, has_more: hasMore };
}

/**
 * A failing connection is not a failed sync. It is a brain that has quietly
 * stopped seeing money move, and it gets a state of its own so health and the
 * answer path can say so instead of reporting a smaller month.
 */
export function classifyItemError(code) {
  switch (code) {
    case "ITEM_LOGIN_REQUIRED":
    case "PENDING_EXPIRATION":
      return { state: "reauth_required", detail: "This bank connection needs the account holder to sign in again before any new activity can be read." };
    case "USER_PERMISSION_REVOKED":
    case "ITEM_NOT_FOUND":
      return { state: "permission_revoked", detail: "This bank connection was revoked, so nothing further can be read from it." };
    default:
      return { state: "error", detail: "This bank connection could not be read on the last attempt." };
  }
}

/**
 * Drain queued history loads and refresh connected items, bounded.
 * Returns a progress report rather than a checkmark, because the operator has
 * to be able to tell the client where the load has got to.
 */
export async function runFeedSlice(env, { maxItems = 3, maxPages = MAX_PAGES_PER_SLICE, fetchImpl = fetch, now = null } = {}) {
  if (bankFeedConfig(env).provider === "plaid") {
    const { runPlaidFeedSlice } = await import("./plaid-bank-feed.js");
    return runPlaidFeedSlice(env, { maxItems, fetchImpl, now });
  }
  const { tenantId } = tenantReference(env);
  const stamp = now || new Date().toISOString();
  const pending = (await env.DB.prepare(
    `SELECT i.item_ref, COALESCE(b.state, 'complete') AS backfill_state
       FROM bank_feed_items i
       LEFT JOIN bank_feed_backfill b ON b.tenant_id = i.tenant_id AND b.item_ref = i.item_ref
      WHERE i.tenant_id = ? AND i.removed_at IS NULL AND i.status IN ('connected', 'error')
      ORDER BY CASE COALESCE(b.state, 'complete') WHEN 'queued' THEN 0 WHEN 'running' THEN 0 ELSE 1 END,
               COALESCE(i.last_synced_at, '')
      LIMIT ?`,
  ).bind(tenantId, maxItems).all())?.results || [];

  const report = [];
  for (const row of pending) {
    const backfilling = row.backfill_state === "queued" || row.backfill_state === "running";
    if (backfilling) {
      await env.DB.prepare(
        `UPDATE bank_feed_backfill SET state = 'running', started_at = COALESCE(started_at, ?),
                attempts = attempts + 1
          WHERE tenant_id = ? AND item_ref = ?`,
      ).bind(stamp, tenantId, row.item_ref).run();
    }
    const result = await syncItemSlice(env, row.item_ref, { maxPages, fetchImpl, now: stamp });
    if (backfilling) {
      const finished = result.ok && !result.has_more;
      await env.DB.prepare(
        `UPDATE bank_feed_backfill
            SET pages_done = pages_done + ?, transactions_seen = transactions_seen + ?,
                unread_lines = unread_lines + ?,
                state = ?, finished_at = ?, last_error = ?
          WHERE tenant_id = ? AND item_ref = ?`,
      ).bind(
        result.pages || 0, result.transactions || 0, result.unread_lines || 0,
        finished ? "complete" : (result.ok ? "running" : "failed"),
        finished ? stamp : null,
        result.ok ? null : (result.reason || "the history load could not continue"),
        tenantId, row.item_ref,
      ).run();
    }
    report.push({ ...result, backfilling });
  }
  return { ran: report.length, items: report };
}

/**
 * What the operator and the owner both need to see: which banks are connected,
 * which need attention, and how far the history load has got. No reference, no
 * ciphertext, no provider payload.
 */
export async function feedStatus(env) {
  if (env.BANK_FEED_PROVIDER === "plaid") {
    const { plaidFeedStatus } = await import("./plaid-bank-feed.js");
    return plaidFeedStatus(env);
  }
  const { tenantId } = tenantReference(env);
  const items = (await env.DB.prepare(
    `SELECT i.item_ref, i.institution_label, i.environment, i.status, i.status_detail, i.key_version,
            i.connected_at, i.last_synced_at,
            b.state AS history_state, b.pages_done, b.transactions_seen, b.unread_lines, b.last_error
       FROM bank_feed_items i
       LEFT JOIN bank_feed_backfill b ON b.tenant_id = i.tenant_id AND b.item_ref = i.item_ref
      WHERE i.tenant_id = ? AND i.removed_at IS NULL
      ORDER BY i.connected_at`,
  ).bind(tenantId).all())?.results || [];
  let environment = null;
  try { environment = bankFeedConfig(env).environment; } catch { environment = null; }
  return {
    configured: bankFeedEnabled(env),
    environment,
    connections: items.map((row) => ({
      item_ref: row.item_ref,
      institution_label: row.institution_label,
      environment: row.environment,
      status: row.status,
      status_detail: row.status_detail,
      access_reference_state: accessReferenceState(row, env),
      connected_at: row.connected_at,
      last_synced_at: row.last_synced_at,
      history: {
        state: row.history_state || "none",
        pages_done: row.pages_done ?? 0,
        transactions_seen: row.transactions_seen ?? 0,
        unread_lines: row.unread_lines ?? 0,
        last_error: row.last_error || null,
      },
    })),
    // A connection in this list means every financial answer is now missing
    // whatever has happened at that bank since it broke. Surfacing it here is
    // the difference between a stale answer and a stale answer that says so.
    needs_attention: items
      .filter((row) => row.status !== "connected")
      .map((row) => ({ item_ref: row.item_ref, status: row.status, detail: row.status_detail })),
  };
}

/**
 * Disconnect a bank. The connection is revoked at the provider and the encrypted
 * reference is destroyed. The ledger rows STAY: deleting a client's financial
 * history because they unplugged a feed is unrecoverable and nobody asked for it.
 */
export async function disconnectItem(env, itemRef, { fetchImpl = fetch, now = null } = {}) {
  if (bankFeedConfig(env).provider === "plaid") {
    const { disconnectPlaidItem } = await import("./plaid-bank-feed.js");
    return disconnectPlaidItem(env, itemRef, { fetchImpl, now });
  }
  const { tenantId } = tenantReference(env);
  const item = await loadItem(env, tenantId, itemRef);
  if (!item) return { ok: false, reason: "that connection is not on this brain" };
  const stamp = now || new Date().toISOString();
  let revoked = true;
  let detail = "The account holder disconnected this bank.";
  try {
    const reference = await decryptAccessReference(env, {
      ciphertext: item.access_ciphertext, iv: item.access_iv, keyVersion: item.key_version,
    });
    await callFeed(env, "/item/remove", { access_token: reference }, { fetchImpl });
  } catch (error) {
    revoked = false;
    detail = `The account holder disconnected this bank. The provider was not reached to revoke it: ${safeFeedError(error)}`;
  }
  await env.DB.prepare(
    `UPDATE bank_feed_items
        SET status = 'removed', status_detail = ?, removed_at = ?,
            access_ciphertext = 'REMOVED0000000000000000', access_iv = 'REMOVED000000000'
      WHERE tenant_id = ? AND item_ref = ?`,
  ).bind(detail, stamp, tenantId, itemRef).run();
  return { ok: true, revoked_at_provider: revoked, history_kept: true, detail };
}

/* -------------------------------------------------------------------- routes */

/**
 * The owner's connect page.
 *
 * The default owner-page policy is `default-src 'none'` with no external
 * script, which would block the provider's browser SDK — silently, as a console
 * violation nobody sees. So this ONE route gets a policy widened to exactly the
 * SDK's own origin, derived from the configured URL rather than hard-coded, and
 * the widening never touches any other page.
 *
 * The page carries no admin key and never asks for one. Its authorisation is
 * the owner's passkey session, which is the same thing `/app` uses.
 */
export function connectPageHtml(config) {
  const sdk = config.linkSdkUrl;
  const sdkOrigin = sdk ? new URL(sdk).origin : null;
  const apiOrigin = config.apiBase ? new URL(config.apiBase).origin : null;
  const connectOrigins = [...new Set([apiOrigin, sdkOrigin].filter(Boolean))];
  // The SDK's global is configuration, not a constant. An unconfigured page
  // says so plainly rather than failing at a name that is not there.
  const global = String(config.linkGlobal || "").replace(/[^A-Za-z0-9_$]/g, "").slice(0, 40);
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${sdkOrigin ? ` ${sdkOrigin}` : ""}`,
    "style-src 'unsafe-inline'",
    `connect-src 'self'${connectOrigins.length ? ` ${connectOrigins.join(" ")}` : ""}`,
    `frame-src${sdkOrigin ? ` ${sdkOrigin}` : " 'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect a bank</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1.25rem}
h1{font-size:1.35rem}p{color:#444}button{font:inherit;padding:.7rem 1.1rem;border:0;border-radius:.5rem;background:#1f2937;color:#fff;cursor:pointer}
.note{font-size:.9rem;color:#666}.err{color:#b00020;white-space:pre-wrap}</style></head><body>
<h1>Connect a bank account</h1>
<p>You sign in to your bank yourself, on your bank's own screen. This page never sees your bank
password or your security codes, and nobody else does either. What comes back is read-only: it can
look at your transactions and it cannot move money.</p>
<p class="note">Environment: ${config.environment}. You can disconnect at any time, and your history stays.</p>
<button id="start">Connect a bank</button>
<div id="status" role="status"></div>
${sdk ? `<script src="${sdk}"></script>` : ""}
<script>
const el = (id) => document.getElementById(id);
const say = (text, bad) => { el("status").innerHTML = bad ? '<p class="err">' + text + '</p>' : '<p>' + text + '</p>'; };
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "that did not work");
  return d;
}
function linkRequestId() {
  let value = null;
  try { value = sessionStorage.getItem("bank_link_request_id"); } catch (e) {}
  if (!value) {
    value = crypto.randomUUID();
    try { sessionStorage.setItem("bank_link_request_id", value); } catch (e) {}
  }
  return value;
}
async function start(existing) {
  say("Preparing a secure connection…");
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get("mode") === "reauthorise" ? "reauthorise" : "connect";
  const begun = existing || await post("/api/bank-feed/link-token", {
    request_id: linkRequestId(),
    mode: requestedMode,
    item_ref: requestedMode === "reauthorise" ? params.get("item_ref") : null,
  });
  const token = begun.link_token;
  try { sessionStorage.setItem("bank_link_session", JSON.stringify(begun)); } catch (e) {}
  const config = {
    token,
    onSuccess: async (publicToken, meta) => {
      say("Finishing up…");
      try {
        const done = await post("/api/bank-feed/exchange", {
          session_ref: begun.session_ref,
          public_token: publicToken,
          institution_ref: meta && meta.institution && meta.institution.institution_id,
          institution_label: meta && meta.institution && meta.institution.name,
        });
        try {
          sessionStorage.removeItem("bank_link_session");
          sessionStorage.removeItem("bank_link_request_id");
        } catch (e) {}
        say("Connected. Your history is loading in the background. This can take a while, and you can close this page.");
      } catch (e) { say(e.message, true); }
    },
    onExit: (err) => { if (err) say("The connection was not completed.", true); },
  };
  // Many banks bounce the browser out to their own site and back. Both halves
  // of that return leg are required: without them every bank that uses its own
  // login page fails silently at the last step.
  if (window.location.search.indexOf("oauth_state_id") >= 0) config.receivedRedirectUri = window.location.href;
  const sdk = window[${JSON.stringify(global)}];
  if (!sdk || typeof sdk.create !== "function") { say("The bank connection library is not available on this page.", true); return; }
  sdk.create(config).open();
}
el("start").onclick = () => start().catch((e) => say(e.message, true));
if (window.location.search.indexOf("oauth_state_id") >= 0) {
  let saved = null; try { saved = JSON.parse(sessionStorage.getItem("bank_link_session")); } catch (e) {}
  if (saved) start(saved).catch((e) => say(e.message, true));
}
</script></body></html>`;
  return { html, csp };
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

/**
 * The connector's routes.
 *
 * Owner routes are authorised by the passkey session and NEVER by an admin key
 * typed into a page: the admin key can ingest, purge, reindex and drain, and a
 * client-facing form that asks for it trains people to paste it anywhere.
 * Operator routes take the admin key and no session.
 */
export async function handleBankFeed(env, request, url, path, ctx) {
  let ownerPrincipalLoaded = false;
  let ownerPrincipal = null;
  const ownerAccess = async () => {
    if (!ownerPrincipalLoaded) {
      ownerPrincipal = await ownerSessionPrincipal(request, env);
      ownerPrincipalLoaded = true;
    }
    return {
      authorised: ownerPrincipal?.kind === "owner" && ownerPrincipal.grantId === null,
      scoped: Boolean(ownerPrincipal),
    };
  };
  const ownerRefusal = (access) => access.scoped
    ? jsonResponse({ error: "forbidden", code: "owner_required" }, 403)
    : jsonResponse({ error: "unauthorized", code: "session_required" }, 401);
  const operatorAuthorised = () => validateAdminKey(request, env);
  const ownerJson = (body, status = 200) => privateNoStore(jsonResponse(body, status));

  try {
    if (path === "/app/connect/bank") {
      if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
      const access = await ownerAccess();
      if (!access.authorised) {
        if (access.scoped) return new Response("Only the owner can connect a bank.", { status: 403 });
        return new Response("Sign in first at /app, then open this page again.", {
          status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const { html, csp } = connectPageHtml(bankFeedConfig(env));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      });
    }

    if (path === "/api/bank-feed/link-token" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return ownerRefusal(access);
      const body = await readJson(request);
      const runtime = bankFeedConfig(env);
      if (runtime.provider === "plaid" &&
          (typeof body.request_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.request_id))) {
        return jsonResponse({
          error: "invalid request",
          code: "plaid_link_request_id_required",
        }, 400);
      }
      return jsonResponse(await createLinkToken(env, {
        url: url.href,
        mode: body.mode === "reauthorise" ? "reauthorise" : "connect",
        itemRef: body.item_ref || null,
        requestId: body.request_id || null,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
      }));
    }

    if (path === "/api/bank-feed/exchange" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return ownerRefusal(access);
      const body = await readJson(request);
      const result = await exchangePublicToken(env, {
        sessionRef: body.session_ref || null,
        publicToken: body.public_token,
        institutionRef: body.institution_ref || null,
        institutionLabel: body.institution_label || null,
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
      });
      // The history load runs OUTSIDE this request. The owner gets an answer
      // now and the two years arrive behind them.
      if (ctx?.waitUntil) ctx.waitUntil(runFeedSlice(env).catch(() => {}));
      return jsonResponse(result);
    }

    if (path === "/api/bank-feed/status" && request.method === "GET") {
      const access = await ownerAccess();
      if (!access.authorised && !operatorAuthorised()) return ownerRefusal(access);
      return jsonResponse(await feedStatus(env));
    }

    if (path === "/api/bank-feed/accounts" && request.method === "GET") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      const runtime = bankFeedConfig(env);
      if (runtime.provider !== "plaid") {
        return ownerJson({
          error: "unavailable",
          code: "plaid_account_assignment_unavailable",
          unavailable: true,
          sections_unavailable: ["accounts"],
        }, 503);
      }
      const status = await plaidOwnerAccountStatus(env);
      return ownerJson(status, status.unavailable ? 503 : 200);
    }

    if (path === "/api/bank-feed/accounts/assign" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised) return privateNoStore(ownerRefusal(access));
      const runtime = bankFeedConfig(env);
      if (runtime.provider !== "plaid") {
        return ownerJson({
          error: "unavailable",
          code: "plaid_account_assignment_unavailable",
          unavailable: true,
        }, 503);
      }
      const body = await readJson(request);
      const assigned = await assignPlaidAccountEntity(env, body);
      return ownerJson(assigned.body, assigned.status);
    }

    if (path === "/api/bank-feed/sync" && request.method === "POST") {
      if (!operatorAuthorised()) return jsonResponse({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      return jsonResponse(await runFeedSlice(env, {
        maxItems: Math.min(Number(body.max_items) || 3, 10),
        maxPages: Math.min(Number(body.max_pages) || MAX_PAGES_PER_SLICE, 20),
      }));
    }

    if (path === "/api/bank-feed/recovery-key-proof" && request.method === "POST") {
      if (!operatorAuthorised()) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(await bankAccessWrappingKeyProof(env));
    }

    if (path === "/api/bank-feed/reconcile-recovery" && request.method === "POST") {
      if (!operatorAuthorised()) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(await rewrapBankAccessReferences(env, { limit: 100 }));
    }

    if (path === "/api/bank-feed/disconnect" && request.method === "POST") {
      const access = await ownerAccess();
      if (!access.authorised && !operatorAuthorised()) return ownerRefusal(access);
      const body = await readJson(request);
      if (!body.item_ref) return jsonResponse({ error: "name the connection to disconnect" }, 400);
      return jsonResponse(await disconnectItem(env, String(body.item_ref), {
        fetchImpl: ctx?.bankFeedFetchImpl || fetch,
      }));
    }

    return jsonResponse({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof PlaidAccountEntityError) {
      const errorName = error.status === 503
        ? "unavailable"
        : error.status === 409
          ? "conflict"
          : error.status === 404
            ? "not_found"
            : error.status === 403
              ? "forbidden"
              : "invalid_request";
      return privateNoStore(jsonResponse({
        error: errorName,
        code: error.code,
        ...(error.status === 503 ? { unavailable: true } : {}),
      }, error.status));
    }
    // One exit for every failure, so no path out of this module can carry a
    // provider payload or a credential into a response.
    const outcomeUnknown = error?.outcome_unknown === true;
    const body = {
      error: safeFeedError(error),
      ...(error?.code ? { code: String(error.code).slice(0, 80) } : {}),
      ...(outcomeUnknown ? {
        outcome_unknown: true,
        retry_safe: false,
        recovery: "The provider may have accepted the one-time handoff. Keep this page open and ask the technician to review this connection before starting another one.",
      } : {}),
    };
    return jsonResponse(body, error instanceof FeedConfigError || outcomeUnknown ? 503 : 502);
  }
}
