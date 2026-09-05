/**
 * Cloudflare control-plane OAuth custody for one Financial Brain install.
 *
 * Wrangler owns refresh-token persistence. This module never reads Wrangler's
 * credential files and never activates a directory or default profile. Every
 * credential-bearing operation names the profile derived from the install's
 * stable, non-secret identity, and Wrangler is forced to use its OS-keyring
 * backend. The short-lived access token is captured into a zeroable Buffer,
 * never printed or persisted by this module, and wiped after the action. Node's
 * HTTP client necessarily creates a transient header value while a request is
 * in flight, so this is bounded in-memory custody rather than a claim that no
 * runtime string can ever exist.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const CLOUDFLARE_OAUTH_WRANGLER_PACKAGE = "wrangler@4.127.1";
export const CLOUDFLARE_OAUTH_CALLBACK_HOST = "localhost";
export const CLOUDFLARE_OAUTH_CALLBACK_PORT = 8976;

// These are the narrow Wrangler 4.127.1 OAuth scope keys available for the
// current standard install: enumerate memberships, deploy/configure Workers,
// manage D1, and configure Workers AI. Wrangler exposes no separate Vectorize
// OAuth key, so the exact Vectorize read below is the fail-closed proof that
// this pinned scope set reaches it before any mutation.
export const CLOUDFLARE_OAUTH_SCOPES = Object.freeze([
  "account:read",
  "user:read",
  "workers:write",
  "d1:write",
  "ai:write",
]);

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const CLOUDFLARE_API_PREFIX = "/client/v4";
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const PROFILE_PATTERN = /^financial-brain-[a-f0-9]{24}$/;
const MAX_TOKEN_JSON_BYTES = 16 * 1024;
const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACCOUNT_PAGES = 100;
const ACCOUNTS_PER_PAGE = 50;
// Wrangler otherwise loads `.env` and `.env.local` from the caller's current
// directory before resolving auth. An explicit OS null-device env file
// suppresses that default without creating another local file. The equals form
// also survives Wrangler's Node launcher treating `--env-file` as a Node flag.
const emptyWranglerEnvFile = (platformName) => platformName === "win32" ? "NUL" : "/dev/null";

// This is an allowlist, not a filter. In particular it excludes every ambient
// Cloudflare/API/provider credential, CI (which disables browser login),
// NODE_OPTIONS, proxy URL, and npm-token variable inherited by the desktop.
const CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE",
  "USER", "USERNAME", "LOGNAME", "USERDOMAIN",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "SystemDrive",
  "ComSpec", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "TMPDIR",
  "LANG", "LANGUAGE", "SHELL", "TERM", "COLORTERM", "NO_COLOR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NPM_CONFIG_CACHE", "npm_config_cache", "NPM_CONFIG_PREFIX", "npm_config_prefix",
]);

const PREFLIGHT_PATHS = Object.freeze([
  Object.freeze({ name: "workers", suffix: "/workers/scripts" }),
  Object.freeze({ name: "d1", suffix: "/d1/database" }),
  Object.freeze({ name: "vectorize", suffix: "/vectorize/v2/indexes" }),
  Object.freeze({ name: "workers_ai", suffix: "/ai/models/search?per_page=1" }),
]);

export class CloudflareOAuthSessionError extends Error {
  constructor(code, phase, message) {
    super(message);
    this.name = "CloudflareOAuthSessionError";
    this.code = code;
    this.phase = phase;
  }
}

function oauthError(code, phase, message) {
  return new CloudflareOAuthSessionError(code, phase, message);
}

function cleanInstallIdentity(value) {
  if (typeof value !== "string" || value !== value.trim() ||
      value.length < 16 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw oauthError(
      "CLOUDFLARE_OAUTH_INSTALL_IDENTITY_INVALID",
      "profile",
      "the stable install identity is missing or invalid",
    );
  }
  return value;
}

function cleanProfileName(value) {
  const profile = String(value ?? "");
  if (!PROFILE_PATTERN.test(profile)) {
    throw oauthError(
      "CLOUDFLARE_OAUTH_PROFILE_INVALID",
      "profile",
      "the Financial Brain Cloudflare auth profile is invalid",
    );
  }
  return profile;
}

function requestedProfile({ profile = null, installIdentity = null } = {}) {
  if (profile) {
    const exact = cleanProfileName(profile);
    if (installIdentity && cloudflareOAuthProfileName(installIdentity) !== exact) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_PROFILE_MISMATCH",
        "profile",
        "the saved Cloudflare auth profile does not match this install identity",
      );
    }
    return exact;
  }
  return cloudflareOAuthProfileName(installIdentity);
}

function cleanAccountId(value, { required = true } = {}) {
  if ((value === undefined || value === null || value === "") && !required) return null;
  const accountId = String(value ?? "").trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_ID_INVALID",
      "account",
      "the Cloudflare account id is invalid",
    );
  }
  return accountId;
}

/** Stable, non-identifying, per-install Wrangler profile name. */
export function cloudflareOAuthProfileName(installIdentity) {
  const identity = cleanInstallIdentity(installIdentity);
  const digest = createHash("sha256")
    .update("financial-brain/cloudflare-oauth-profile/v1\0", "utf8")
    .update(identity, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `financial-brain-${digest}`;
}

/**
 * Build the only environment a Wrangler OAuth child may receive.
 * CLOUDFLARE_ACCOUNT_ID is included only after the owner selected it.
 */
export function cloudflareOAuthChildEnvironment({
  environment = process.env,
  accountId = null,
} = {}) {
  const clean = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = environment?.[name];
    if (typeof value === "string" && value) clean[name] = value;
  }
  for (const [name, value] of Object.entries(environment || {})) {
    if (name.startsWith("LC_") && typeof value === "string" && value) clean[name] = value;
  }
  clean.CLOUDFLARE_AUTH_USE_KEYRING = "true";
  const selectedAccount = cleanAccountId(accountId, { required: false });
  if (selectedAccount) clean.CLOUDFLARE_ACCOUNT_ID = selectedAccount;
  return clean;
}

function quoteWindowsArgument(value) {
  const text = String(value);
  return /[\s"^&|<>()]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
}

function runWrangler(args, {
  processRunner,
  platformName = process.platform,
  environment = process.env,
  accountId = null,
  timeoutMs,
  stdio,
  maxBuffer,
} = {}) {
  const run = processRunner ?? ((command, argv, options) => spawnSync(command, argv, options));
  const useShell = platformName === "win32";
  const exactArgs = [...args, `--env-file=${emptyWranglerEnvFile(platformName)}`];
  const argv = useShell ? exactArgs.map(quoteWindowsArgument) : exactArgs;
  try {
    return run("npx", argv, {
      encoding: null,
      env: cloudflareOAuthChildEnvironment({ environment, accountId }),
      maxBuffer,
      shell: useShell,
      stdio,
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    return { status: null, error: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

function wipeProcessOutput(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

function processSucceeded(result) {
  return result?.status === 0 && !result?.error && !result?.signal;
}

/**
 * Require Wrangler's encrypted credential backend before a profile is created
 * or read. A missing macOS Keychain or Windows Credential Manager is a hard
 * stop; there is no plaintext credential-file fallback.
 */
export function enableCloudflareOAuthKeyring(options = {}) {
  const result = runWrangler([
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "keyring", "enable",
  ], {
    ...options,
    accountId: null,
    timeoutMs: options.keyringTimeoutMs ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_TOKEN_JSON_BYTES,
  });
  try {
    if (!processSucceeded(result)) {
      throw oauthError(
        "CLOUDFLARE_KEYRING_UNAVAILABLE",
        "keyring",
        "Wrangler could not enable encrypted OS-keyring credential storage",
      );
    }
  } finally {
    wipeProcessOutput(result);
  }
}

/** Run the owner-visible browser callback ceremony for the exact named profile. */
export function createCloudflareOAuthProfile({ installIdentity = null, profile = null, ...options } = {}) {
  const exactProfile = requestedProfile({ profile, installIdentity });
  enableCloudflareOAuthKeyring(options);
  const result = runWrangler([
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "create", exactProfile,
    "--scopes", ...CLOUDFLARE_OAUTH_SCOPES,
    "--browser",
    "--callback-host", CLOUDFLARE_OAUTH_CALLBACK_HOST,
    "--callback-port", String(CLOUDFLARE_OAUTH_CALLBACK_PORT),
  ], {
    ...options,
    accountId: null,
    timeoutMs: options.oauthTimeoutMs ?? 10 * 60_000,
    // The OAuth link and callback status belong in the owner's direct terminal.
    // `auth token` below is a separate captured invocation.
    stdio: "inherit",
  });
  if (!processSucceeded(result)) {
    wipeProcessOutput(result);
    throw oauthError(
      "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
      "authorize",
      "Cloudflare browser authorization did not complete for this install profile",
    );
  }
  wipeProcessOutput(result);
  return exactProfile;
}

function isJsonWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function tokenJsonFailure() {
  return oauthError(
    "CLOUDFLARE_OAUTH_TOKEN_RESPONSE_INVALID",
    "token",
    "Wrangler returned an invalid OAuth token response",
  );
}

function skipWhitespace(bytes, start) {
  let index = start;
  while (index < bytes.length && isJsonWhitespace(bytes[index])) index++;
  return index;
}

// Wrangler 4.127.1 emits these fields through JSON.stringify. Reject escaped
// or non-ASCII fields rather than using JSON.parse, which would create an
// immutable JavaScript string containing the access token.
function readSimpleJsonString(bytes, start) {
  if (bytes[start] !== 0x22) throw tokenJsonFailure();
  let index = start + 1;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === 0x22) return { start: start + 1, end: index, next: index + 1 };
    if (byte < 0x20 || byte > 0x7e || byte === 0x5c) throw tokenJsonFailure();
    index++;
  }
  throw tokenJsonFailure();
}

function segmentEquals(bytes, segment, ascii) {
  if (segment.end - segment.start !== ascii.length) return false;
  for (let index = 0; index < ascii.length; index++) {
    if (bytes[segment.start + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Strictly parse Wrangler 4.127.1 `{ "type": "oauth", "token": "..." }`
 * bytes without materializing the token as an immutable string.
 * The returned Buffer belongs to the caller and must be zeroed.
 */
export function parseWranglerOAuthTokenJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_TOKEN_JSON_BYTES) {
    throw tokenJsonFailure();
  }
  let token = null;
  let succeeded = false;
  try {
    let index = skipWhitespace(bytes, 0);
    if (bytes[index++] !== 0x7b) throw tokenJsonFailure();
    let sawType = false;
    let sawToken = false;
    let memberCount = 0;

    for (;;) {
      index = skipWhitespace(bytes, index);
      if (bytes[index] === 0x7d) {
        index++;
        break;
      }
      if (memberCount > 0) {
        if (bytes[index++] !== 0x2c) throw tokenJsonFailure();
        index = skipWhitespace(bytes, index);
      }
      const key = readSimpleJsonString(bytes, index);
      index = skipWhitespace(bytes, key.next);
      if (bytes[index++] !== 0x3a) throw tokenJsonFailure();
      index = skipWhitespace(bytes, index);
      const value = readSimpleJsonString(bytes, index);
      index = value.next;
      memberCount++;

      if (segmentEquals(bytes, key, "type")) {
        if (sawType || !segmentEquals(bytes, value, "oauth")) throw tokenJsonFailure();
        sawType = true;
      } else if (segmentEquals(bytes, key, "token")) {
        if (sawToken) throw tokenJsonFailure();
        const length = value.end - value.start;
        if (length < MIN_TOKEN_BYTES || length > MAX_TOKEN_BYTES) throw tokenJsonFailure();
        // Small Buffer.from copies may share Node's pooled ArrayBuffer with the
        // captured stdout. Use an unpooled allocation so wiping either buffer
        // cannot leave the other token bytes reachable through its `.buffer`.
        token = Buffer.allocUnsafeSlow(length);
        bytes.copy(token, 0, value.start, value.end);
        sawToken = true;
      } else {
        throw tokenJsonFailure();
      }
      if (memberCount > 2) throw tokenJsonFailure();
    }

    index = skipWhitespace(bytes, index);
    if (index !== bytes.length || !sawType || !sawToken || memberCount !== 2 || !token) {
      throw tokenJsonFailure();
    }
    succeeded = true;
    return token;
  } finally {
    if (!succeeded && token) token.fill(0);
  }
}

/** Capture only the exact profile's short-lived OAuth token JSON. */
export function captureCloudflareOAuthToken({ profile, accountId = null, ...options } = {}) {
  const exactProfile = cleanProfileName(profile);
  const selectedAccount = cleanAccountId(accountId, { required: false });
  const result = runWrangler([
    CLOUDFLARE_OAUTH_WRANGLER_PACKAGE,
    "auth", "token", "--json",
    "--profile", exactProfile,
  ], {
    ...options,
    accountId: selectedAccount,
    timeoutMs: options.tokenTimeoutMs ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_TOKEN_JSON_BYTES,
  });
  try {
    if (!processSucceeded(result) || !Buffer.isBuffer(result.stdout)) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
        "token",
        "this install's Cloudflare OAuth profile must be authorized again",
      );
    }
    return parseWranglerOAuthTokenJson(result.stdout);
  } finally {
    wipeProcessOutput(result);
  }
}

function assertTokenBuffer(token) {
  if (!Buffer.isBuffer(token) || token.length < MIN_TOKEN_BYTES || token.length > MAX_TOKEN_BYTES) {
    throw oauthError(
      "CLOUDFLARE_OAUTH_TOKEN_INVALID",
      "request",
      "the in-memory Cloudflare OAuth token is invalid",
    );
  }
}

async function readBoundedResponse(response) {
  if (!response || typeof response.status !== "number" ||
      typeof response.arrayBuffer !== "function") {
    throw oauthError(
      "CLOUDFLARE_OAUTH_RESPONSE_INVALID",
      "request",
      "Cloudflare returned an invalid response",
    );
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_API_RESPONSE_BYTES) {
    throw oauthError(
      "CLOUDFLARE_OAUTH_RESPONSE_INVALID",
      "request",
      "Cloudflare returned an oversized response",
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_API_RESPONSE_BYTES) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_RESPONSE_INVALID",
        "request",
        "Cloudflare returned an oversized response",
      );
    }
    let body;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw oauthError(
        "CLOUDFLARE_OAUTH_RESPONSE_INVALID",
        "request",
        "Cloudflare returned invalid JSON",
      );
    }
    if (response.status === 401) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_REAUTH_REQUIRED",
        "request",
        "this install's Cloudflare OAuth profile must be authorized again",
      );
    }
    if (response.status === 403) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_SCOPE_MISSING",
        "request",
        "the Cloudflare OAuth approval is missing a required install permission",
      );
    }
    if (response.status < 200 || response.status >= 300 ||
        body?.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0 ||
        !Object.hasOwn(body, "result")) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_REQUEST_FAILED",
        "request",
        "Cloudflare refused the read-only OAuth preflight request",
      );
    }
    return body;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

async function cloudflareGet(path, token, {
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 30_000,
} = {}) {
  assertTokenBuffer(token);
  if (typeof fetchImpl !== "function") {
    throw oauthError(
      "CLOUDFLARE_OAUTH_FETCH_UNAVAILABLE",
      "request",
      "the Cloudflare request client is unavailable",
    );
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw oauthError(
      "CLOUDFLARE_OAUTH_REQUEST_INVALID",
      "request",
      "the Cloudflare API request path is invalid",
    );
  }
  const url = new URL(`${CLOUDFLARE_API_PREFIX}${path}`, CLOUDFLARE_API_ORIGIN);
  if (url.origin !== CLOUDFLARE_API_ORIGIN || !url.pathname.startsWith(`${CLOUDFLARE_API_PREFIX}/`)) {
    throw oauthError(
      "CLOUDFLARE_OAUTH_REQUEST_INVALID",
      "request",
      "the Cloudflare API request target is invalid",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.toString("utf8")}`,
      },
      signal: controller.signal,
    });
    return await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof CloudflareOAuthSessionError) throw error;
    if (controller.signal.aborted) {
      throw oauthError(
        "CLOUDFLARE_OAUTH_REQUEST_TIMEOUT",
        "request",
        "the read-only Cloudflare OAuth preflight timed out",
      );
    }
    throw oauthError(
      "CLOUDFLARE_OAUTH_REQUEST_FAILED",
      "request",
      "the read-only Cloudflare OAuth preflight could not reach Cloudflare",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_LIST_INVALID",
      "accounts",
      "Cloudflare returned an invalid account list",
    );
  }
  let id;
  try {
    id = cleanAccountId(value.id);
  } catch {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_LIST_INVALID",
      "accounts",
      "Cloudflare returned an invalid account list",
    );
  }
  if (typeof value.name !== "string" || value.name !== value.name.trim() ||
      value.name.length < 1 || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name)) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_LIST_INVALID",
      "accounts",
      "Cloudflare returned an invalid account list",
    );
  }
  return Object.freeze({ id, name: value.name });
}

function validateResultInfo(value, requestedPage, resultCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const integers = ["page", "count", "total_count", "total_pages"];
  if (integers.some((key) => !Number.isInteger(value[key]) || value[key] < 0)) throw new Error("invalid");
  if (value.page !== requestedPage || value.count !== resultCount ||
      value.total_pages > MAX_ACCOUNT_PAGES || value.total_count < resultCount ||
      (value.total_pages === 0 && (requestedPage !== 1 || resultCount !== 0 || value.total_count !== 0)) ||
      (value.total_pages > 0 && requestedPage > value.total_pages)) {
    throw new Error("invalid");
  }
  return { totalCount: value.total_count, totalPages: value.total_pages };
}

/** List every account visible to the exact OAuth profile, with strict paging. */
export async function listCloudflareOAuthAccounts(token, options = {}) {
  const accounts = [];
  const seen = new Set();
  let expectedTotal = null;
  let expectedPages = null;

  for (let page = 1; page <= (expectedPages ?? 1); page++) {
    const body = await cloudflareGet(
      `/accounts?page=${page}&per_page=${ACCOUNTS_PER_PAGE}`,
      token,
      options,
    );
    if (!Array.isArray(body.result)) {
      throw oauthError(
        "CLOUDFLARE_ACCOUNT_LIST_INVALID",
        "accounts",
        "Cloudflare returned an invalid account list",
      );
    }
    let pageInfo;
    try {
      pageInfo = validateResultInfo(body.result_info, page, body.result.length);
    } catch {
      throw oauthError(
        "CLOUDFLARE_ACCOUNT_LIST_INVALID",
        "accounts",
        "Cloudflare returned invalid account pagination",
      );
    }
    if (expectedTotal === null) {
      expectedTotal = pageInfo.totalCount;
      expectedPages = pageInfo.totalPages;
    } else if (pageInfo.totalCount !== expectedTotal || pageInfo.totalPages !== expectedPages) {
      throw oauthError(
        "CLOUDFLARE_ACCOUNT_LIST_INVALID",
        "accounts",
        "Cloudflare changed the account list during selection",
      );
    }
    for (const raw of body.result) {
      const account = normalizeAccount(raw);
      if (seen.has(account.id)) {
        throw oauthError(
          "CLOUDFLARE_ACCOUNT_LIST_INVALID",
          "accounts",
          "Cloudflare returned a duplicate account identity",
        );
      }
      seen.add(account.id);
      accounts.push(account);
    }
  }
  if (accounts.length !== expectedTotal) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_LIST_INVALID",
      "accounts",
      "Cloudflare returned an incomplete account list",
    );
  }
  return Object.freeze(accounts);
}

/**
 * Select by exact account id. Names are display-only because two memberships
 * may use the same name. A bound update never prompts for a different account.
 */
export async function selectCloudflareOAuthAccount(accounts, {
  expectedAccountId = null,
  prompt,
} = {}) {
  if (!Array.isArray(accounts)) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_LIST_INVALID",
      "accounts",
      "Cloudflare returned an invalid account list",
    );
  }
  const normalized = Object.freeze(accounts.map(normalizeAccount));
  const expected = cleanAccountId(expectedAccountId, { required: false });
  if (expected) {
    const match = normalized.find((account) => account.id === expected);
    if (!match) {
      throw oauthError(
        "CLOUDFLARE_ACCOUNT_BINDING_MISMATCH",
        "account_selection",
        "this OAuth profile cannot reach the Cloudflare account bound to this Brain",
      );
    }
    return match;
  }
  if (normalized.length === 0) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_NONE",
      "account_selection",
      "this Cloudflare login has no account available for installation",
    );
  }
  if (normalized.length === 1) return normalized[0];
  if (typeof prompt !== "function") {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED",
      "account_selection",
      "choose the exact Cloudflare account for this Brain before setup continues",
    );
  }
  const answer = await prompt(Object.freeze({
    kind: "cloudflare_account",
    answer: "account_id",
    accounts: normalized,
  }));
  const chosenId = typeof answer === "string" ? answer.trim().toLowerCase() : "";
  if (!chosenId) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_SELECTION_CANCELLED",
      "account_selection",
      "Cloudflare account selection was cancelled before any resource change",
    );
  }
  const chosen = ACCOUNT_ID_PATTERN.test(chosenId)
    ? normalized.find((account) => account.id === chosenId)
    : null;
  if (!chosen) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_SELECTION_INVALID",
      "account_selection",
      "the selected Cloudflare account is not visible to this OAuth profile",
    );
  }
  return chosen;
}

/** Read-only proof that every current control-plane service reaches one account. */
export async function preflightCloudflareOAuthAccount(token, account, options = {}) {
  const selected = normalizeAccount(account);
  const accountBody = await cloudflareGet(`/accounts/${selected.id}`, token, options);
  const reached = normalizeAccount(accountBody.result);
  if (reached.id !== selected.id) {
    throw oauthError(
      "CLOUDFLARE_ACCOUNT_BINDING_MISMATCH",
      "preflight",
      "Cloudflare did not confirm the exact selected account",
    );
  }
  const checks = ["account"];
  for (const check of PREFLIGHT_PATHS) {
    await cloudflareGet(`/accounts/${selected.id}${check.suffix}`, token, options);
    checks.push(check.name);
  }
  return Object.freeze({
    status: "ready",
    account: reached,
    checks: Object.freeze(checks),
  });
}

/**
 * Establish an exact-account session and zero the access token after `action`.
 * `reauthorize` is true for first setup/recovery and false for routine update;
 * both paths require the same named profile and OS keyring.
 */
export async function withCloudflareOAuthSession({
  installIdentity = null,
  profile: savedProfile = null,
  expectedAccountId = null,
  reauthorize = false,
  readOnlyExistingProfile = false,
  prompt,
  action,
  ...options
} = {}) {
  const profile = requestedProfile({ profile: savedProfile, installIdentity });
  const boundAccountId = cleanAccountId(expectedAccountId, { required: false });
  if (reauthorize) {
    createCloudflareOAuthProfile({ profile, ...options });
  } else if (!readOnlyExistingProfile) {
    enableCloudflareOAuthKeyring(options);
  }

  const token = captureCloudflareOAuthToken({
    profile,
    accountId: boundAccountId,
    ...options,
  });
  try {
    const accounts = await listCloudflareOAuthAccounts(token, options);
    const account = await selectCloudflareOAuthAccount(accounts, {
      expectedAccountId: boundAccountId,
      prompt,
    });
    const preflight = await preflightCloudflareOAuthAccount(token, account, options);
    const safeSession = Object.freeze({ profile, account: preflight.account, preflight });
    if (typeof action !== "function") return safeSession;
    return await action({ ...safeSession, token });
  } finally {
    token.fill(0);
  }
}
