/**
 * Google OAuth for a CLI running on the CLIENT's own machine.
 *
 * WHY THE CLIENT REGISTERS THEIR OWN OAUTH CLIENT
 *
 * Every scope this product needs from Drive and Gmail is RESTRICTED, not merely
 * sensitive: drive.readonly, gmail.readonly and friends. A single vendor-owned
 * OAuth client used by many customers would require Google OAuth verification
 * PLUS an annual CASA Tier 2 security assessment through a paid assessor, with a
 * multi-week review before first launch and a renewal every twelve months.
 *
 * So each client creates their own Google Cloud project and their own Desktop
 * OAuth client. We never hold a client id, a client secret, or a refresh token.
 * That is not a workaround for the verification cost; it is the same custody
 * model already sold for Cloudflare, applied to Google.
 *
 * TWO THINGS THAT WILL BITE
 *
 * 1. An External consent screen left in "Testing" is issued refresh tokens that
 *    EXPIRE AFTER SEVEN DAYS. The client must click PUBLISH so the status reads
 *    "In production", and then click through an unverified-app warning once.
 *    A Workspace account should use "Internal" instead and avoids both.
 * 2. Google removed the out-of-band flow, and its limited-input device flow does
 *    not support any Gmail or Drive scope. A loopback redirect is the only
 *    option left for an installed app, which is why this opens a local server.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync,
  unlinkSync, openSync, closeSync, fsyncSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const SCOPES = {
  drive: "https://www.googleapis.com/auth/drive.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.events.readonly",
};

/**
 * A predictable local callback for the installed-app flow. Google Desktop OAuth
 * clients allow loopback redirects automatically; there is no redirect-URI
 * field to add manually in the Cloud console.
 */
export const DEFAULT_PORT = 47811;
export const redirectUri = (port = DEFAULT_PORT) => `http://127.0.0.1:${port}`;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE. Required for installed apps, and it costs nothing to do properly. */
export function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl({ clientId, scopes, challenge, state, port = DEFAULT_PORT }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri(port));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(" "));
  // offline + consent is what actually produces a refresh token. Without
  // prompt=consent, a re-authorisation returns an access token and NO refresh
  // token, and the next unattended run fails with nothing to refresh from.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

const PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#1a1a1a">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

/**
 * Run the consent flow. Returns { refresh_token, access_token, expires_at, scope }.
 *
 * Blocks until the browser redirects back, the user cancels, or it times out.
 */
export async function authorize({ clientId, clientSecret, scopes, port = DEFAULT_PORT, timeoutMs = 300_000, open = true } = {}) {
  if (!clientId) throw new Error("clientId is required");
  if (!scopes?.length) throw new Error("at least one scope is required");

  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const url = buildAuthUrl({ clientId, scopes, challenge, state, port });

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const got = new URL(req.url, redirectUri(port));
      if (got.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const err = got.searchParams.get("error");
      const returnedState = got.searchParams.get("state");
      const finish = (status, page) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page);
        server.close();
      };
      if (err) {
        finish(400, PAGE("Not connected", `Google returned: <code>${err}</code>. You can close this tab and try again.`));
        reject(new Error(`Google returned "${err}"`));
        return;
      }
      // A mismatched state means this redirect did not come from the request we
      // made. Refusing it is the entire point of sending one.
      if (returnedState !== state) {
        finish(400, PAGE("Not connected", "The response did not match the request. Nothing was connected."));
        reject(new Error("state mismatch: the redirect did not come from this authorisation request"));
        return;
      }
      const c = got.searchParams.get("code");
      if (!c) {
        finish(400, PAGE("Not connected", "No authorisation code was returned."));
        reject(new Error("no authorisation code in the redirect"));
        return;
      }
      finish(200, PAGE("Connected", "You can close this tab and return to the terminal."));
      resolve(c);
    });

    server.on("error", (e) =>
      reject(
        new Error(
          e.code === "EADDRINUSE"
            ? `port ${port} is already in use, so the sign-in cannot complete. Close whatever is using it, or pass --port with a different value.`
            : e.message
        )
      )
    );

    // Bound to loopback only. Nothing on the network can reach it.
    server.listen(port, "127.0.0.1", () => {
      if (open && !openBrowser(url)) {
        console.log(`\n  Could not open a browser. Open this URL yourself:\n\n  ${url}\n`);
      } else if (open) {
        console.log(`\n  A browser window should have opened. If not, use:\n\n  ${url}\n`);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the browser to complete sign-in"));
    }, timeoutMs).unref();
  });

  return exchangeCode({ clientId, clientSecret, code, verifier, port });
}

export async function exchangeCode({ clientId, clientSecret, code, verifier, port = DEFAULT_PORT, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(port),
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${json.error_description || json.error || "unknown"}`);
  if (!json.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Without one this connection stops working in an hour. " +
        "Revoke the app at myaccount.google.com/permissions and connect again."
    );
  }
  return {
    refresh_token: json.refresh_token,
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    scope: json.scope,
  };
}

/* ------------------------------------------------------------ token storage */

export const tokenPath = (home = homedir()) => join(home, ".brain", "google-tokens.json");

/**
 * One item per local OS user. The service and account are deliberately explicit
 * so a person can find, audit, or delete this exact credential in Keychain
 * Access without guessing which generic-password entry belongs to the brain.
 */
export const GOOGLE_KEYCHAIN_SERVICE = "brain-installer.google-oauth";
export const GOOGLE_KEYCHAIN_ACCOUNT = "local-google-connection";
export const GOOGLE_TOKEN_STORE_ENV = "BRAIN_GOOGLE_TOKEN_STORE";

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function storageOptions(value) {
  // The old public API accepted a path as the second argument. Preserve it as
  // an explicit request for file storage, which also keeps focused tests and
  // downstream callers backwards-compatible.
  if (typeof value === "string") return { backend: "file", path: value };
  return { ...(value || {}) };
}

function storageBackend(options = {}) {
  const requested = options.backend || options.env?.[GOOGLE_TOKEN_STORE_ENV] || process.env[GOOGLE_TOKEN_STORE_ENV] || "auto";
  if (!["auto", "keychain", "file"].includes(requested)) {
    throw new Error(`${GOOGLE_TOKEN_STORE_ENV} must be "keychain" or "file" (received "${requested}")`);
  }
  const platform = options.platform || process.platform;
  const backend = requested === "auto" ? (platform === "darwin" ? "keychain" : "file") : requested;
  if (backend === "keychain" && platform !== "darwin") {
    throw new Error("macOS Keychain storage was requested on a non-macOS system; use BRAIN_GOOGLE_TOKEN_STORE=file");
  }
  return backend;
}

function filePath(options = {}) {
  return options.path || tokenPath(options.home || homedir());
}

function parseStore(text, source, { strict = false } = {}) {
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error("the stored value is not an object");
    return value;
  } catch (error) {
    if (!strict) return {};
    throw new Error(`${source} does not contain a valid Google credential record`, { cause: error });
  }
}

function readFileStore(path, { strict = false } = {}) {
  if (!existsSync(path)) return null;
  return parseStore(readFileSync(path, "utf-8"), path, { strict });
}

/** Write completely, fsync, then rename over the destination. */
function writeFileStore(path, store) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX modes. The directory remains in the user's
    // profile and the write below still avoids partial credential files.
  }

  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(store, null, 2), "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // See the Windows note above.
    }
    renameSync(temporary, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // See the Windows note above.
    }
    try {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {
      // Directory fsync is not available on every supported filesystem.
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* preserve the original error */ }
    }
  }
}

function security(options, args, input) {
  const runSecurity = options.runSecurity || ((securityArgs, runOptions) =>
    spawnSync(options.securityPath || "/usr/bin/security", securityArgs, runOptions));
  return runSecurity(args, {
    encoding: "utf-8",
    input,
    timeout: options.timeoutMs || 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function securityPasswordWrite(options, args, payload) {
  // Injected runners keep the storage contract independently testable without
  // touching a developer's real Keychain.
  if (options.runSecurity) return security(options, args, `${payload}\n`);

  // `security ... -w` reads from /dev/tty, not a normal stdin pipe. Expect gives
  // it that terminal while the helper disables all transcript output. This
  // avoids the insecure alternative of putting the credential in `security`'s
  // argv, where another process could read it with `ps`.
  const helper = options.expectScriptPath || join(dirname(fileURLToPath(import.meta.url)), "keychain-write.exp");
  return spawnSync(options.expectPath || "/usr/bin/expect", [
    helper,
    options.securityPath || "/usr/bin/security",
    ...args,
  ], {
    encoding: "utf-8",
    input: `${payload}\n`,
    timeout: options.timeoutMs || 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

const keychainNotFound = (result) =>
  result?.status === 44 || /could not be found|item not found/i.test(String(result?.stderr || ""));

const KEYCHAIN_CHUNK_SIZE = 96;
const keychainService = (options) => options.keychainService || GOOGLE_KEYCHAIN_SERVICE;
const keychainAccount = (options) => options.keychainAccount || GOOGLE_KEYCHAIN_ACCOUNT;
const resultText = (result) => String(result?.stdout || "").replace(/\r?\n$/, "");

function readKeychainValue(options, account, { metadataOnly = false } = {}) {
  const args = [
    "find-generic-password",
    "-a", account,
    "-s", keychainService(options),
  ];
  if (!metadataOnly) args.push("-w");
  const result = security(options, args);
  if (result?.status === 0) return metadataOnly ? "present" : resultText(result);
  if (keychainNotFound(result)) return null;
  throw new Error(
    "macOS Keychain could not be read. Unlock the login keychain and try again, " +
      `or explicitly use the mode-0600 fallback with ${GOOGLE_TOKEN_STORE_ENV}=file.`
  );
}

function writeKeychainValue(options, account, value) {
  if (Buffer.byteLength(value, "utf-8") > 120) {
    throw new Error("the Keychain transport refused an oversized credential part");
  }
  const args = [
    "add-generic-password", "-U",
    "-a", account,
    "-s", keychainService(options),
    "-D", "application password",
    "-j", "Google OAuth credentials for Brain Installer",
    // Keeping -w last makes `security` prompt through the private terminal. The
    // value never appears in argv, shell history, process listings, or output.
    "-w",
  ];
  const result = securityPasswordWrite(options, args, value);
  if (result?.status !== 0) {
    throw new Error(
      "macOS Keychain could not store the Google connection. Unlock the login keychain and try again, " +
        `or explicitly use the mode-0600 fallback with ${GOOGLE_TOKEN_STORE_ENV}=file.`
    );
  }
  if (readKeychainValue(options, account) !== value) {
    throw new Error("macOS Keychain verification failed; the existing token file was left untouched");
  }
}

function deleteKeychainValue(options, account) {
  const result = security(options, [
    "delete-generic-password",
    "-a", account,
    "-s", keychainService(options),
  ]);
  if (result?.status !== 0 && !keychainNotFound(result)) {
    throw new Error("macOS Keychain could not remove an obsolete Google credential part");
  }
}

function descriptor(raw) {
  try {
    const value = JSON.parse(raw);
    if (
      value?.v === 1 && /^[a-f0-9]{16}$/.test(value.g) &&
      Number.isInteger(value.n) && value.n > 0 && value.n < 10_000 &&
      typeof value.h === "string"
    ) return value;
  } catch {
    // A pre-v1 item may contain the record itself. Its strict parse happens in
    // readKeychainStore so corruption still fails loudly.
  }
  return null;
}

function partAccount(options, generation, index) {
  return `${keychainAccount(options)}.${generation}.${String(index).padStart(4, "0")}`;
}

function readKeychainStore(options = {}, { metadataOnly = false } = {}) {
  const raw = readKeychainValue(options, keychainAccount(options), { metadataOnly });
  if (raw === null || metadataOnly) return raw === null ? null : {};

  const manifest = descriptor(raw);
  if (!manifest) return parseStore(raw, "the macOS Keychain item", { strict: true });

  let encoded = "";
  for (let index = 0; index < manifest.n; index++) {
    const part = readKeychainValue(options, partAccount(options, manifest.g, index));
    if (part === null) throw new Error("the macOS Keychain Google credential is incomplete; reconnect Google");
    encoded += part;
  }
  const payload = Buffer.from(encoded, "base64url").toString("utf-8");
  const digest = b64url(createHash("sha256").update(payload).digest());
  if (digest !== manifest.h) throw new Error("the macOS Keychain Google credential failed its integrity check; reconnect Google");
  return parseStore(payload, "the macOS Keychain item", { strict: true });
}

function cleanupGeneration(options, manifest) {
  if (!manifest) return;
  for (let index = 0; index < manifest.n; index++) {
    deleteKeychainValue(options, partAccount(options, manifest.g, index));
  }
}

function writeKeychainStore(options = {}, store) {
  const payload = JSON.stringify(store);
  const encoded = Buffer.from(payload, "utf-8").toString("base64url");
  const parts = encoded.match(new RegExp(`.{1,${KEYCHAIN_CHUNK_SIZE}}`, "g")) || [""];
  const next = {
    v: 1,
    g: randomBytes(8).toString("hex"),
    n: parts.length,
    h: b64url(createHash("sha256").update(payload).digest()),
  };
  const manifestValue = JSON.stringify(next);
  const account = keychainAccount(options);
  const previousRaw = readKeychainValue(options, account);
  const previous = previousRaw ? descriptor(previousRaw) : null;
  let switched = false;
  let verified;

  try {
    for (let index = 0; index < parts.length; index++) {
      writeKeychainValue(options, partAccount(options, next.g, index), parts[index]);
    }
    // The short manifest is the atomic switch. Until it verifies, the prior
    // generation remains the active complete record.
    writeKeychainValue(options, account, manifestValue);
    switched = true;

  // Do not remove a legacy file until the exact object can be read back. This
  // turns migration into a verified move rather than a hopeful copy-and-delete.
    verified = readKeychainStore(options);
    if (JSON.stringify(verified) !== payload) {
      throw new Error("macOS Keychain verification failed; the existing token file was left untouched");
    }
  } catch (error) {
    if (switched) {
      try {
        if (previousRaw !== null) writeKeychainValue(options, account, previousRaw);
        else deleteKeychainValue(options, account);
      } catch {
        // The legacy file is still intentionally retained, so recovery remains
        // possible even if restoring an earlier Keychain manifest fails.
      }
    }
    try { cleanupGeneration(options, next); } catch { /* orphaned data stays inside Keychain */ }
    throw error;
  }

  // The verified descriptor switch is the commit. Old-generation deletion is
  // garbage collection after that point, not part of the transaction. If it
  // fails halfway through, restoring the old descriptor would point at an
  // incomplete generation and deleting `next` would destroy the valid token.
  // Leaving obsolete Keychain parts is harmless and a later save can retry.
  try { cleanupGeneration(options, previous); } catch { /* keep the committed generation authoritative */ }
  return verified;
}

function removeMatchingLegacyFile(options, store) {
  const path = filePath(options);
  const legacy = readFileStore(path, { strict: true });
  if (legacy && JSON.stringify(legacy) === JSON.stringify(store)) unlinkSync(path);
}

/**
 * Tokens live on the CLIENT's machine and never transit us. macOS uses the
 * login Keychain by default. Other platforms, and macOS users who explicitly
 * set BRAIN_GOOGLE_TOKEN_STORE=file, use an atomic mode-0600 file.
 *
 * The record also holds the client id and secret because unattended syncs need
 * them to refresh. The file fallback directory remains on the ingest walker's
 * skip list, and the worker credential gate remains a second line of defence.
 */
export function saveTokens(store, value) {
  if (!isRecord(store)) throw new Error("Google token store must be an object");
  const options = storageOptions(value);
  if (storageBackend(options) === "file") {
    writeFileStore(filePath(options), store);
    return;
  }
  writeKeychainStore(options, store);
  removeMatchingLegacyFile(options, store);
}

export function loadTokens(value) {
  const options = storageOptions(value);
  if (storageBackend(options) === "file") return readFileStore(filePath(options)) || {};

  const path = filePath(options);
  let stored;
  try {
    stored = readKeychainStore(options);
  } catch (error) {
    // A valid legacy file is a safe recovery source for an interrupted or old
    // Keychain migration. Never discard it unless the replacement verifies.
    if (!existsSync(path) || options.migrateLegacy === false) throw error;
  }
  if (stored) return stored;
  if (!existsSync(path) || options.migrateLegacy === false) return {};
  const legacy = readFileStore(path, { strict: true });
  const verified = writeKeychainStore(options, legacy);
  removeMatchingLegacyFile(options, verified);
  return verified;
}

/** Human-readable storage location for CLI success and support messages. */
export function tokenStorageDescription(value) {
  const options = storageOptions(value);
  if (storageBackend(options) === "file") return `${filePath(options)} (atomic mode 0600 file)`;
  return `macOS Keychain (service "${options.keychainService || GOOGLE_KEYCHAIN_SERVICE}", account "${options.keychainAccount || GOOGLE_KEYCHAIN_ACCOUNT}")`;
}

/** Existence-only probe for doctor. It never asks Keychain to reveal a secret. */
export function tokenStorageStatus(value) {
  const options = storageOptions(value);
  const backend = storageBackend(options);
  if (backend === "file") {
    const path = filePath(options);
    return { exists: existsSync(path), backend, description: tokenStorageDescription(options) };
  }
  try {
    if (readKeychainStore(options, { metadataOnly: true })) {
      return { exists: true, backend, description: tokenStorageDescription(options) };
    }
    const path = filePath(options);
    if (existsSync(path)) {
      return { exists: true, backend: "legacy-file", description: `${path} (will migrate to macOS Keychain on next use)` };
    }
    return { exists: false, backend, description: tokenStorageDescription(options) };
  } catch (error) {
    return { exists: false, backend, description: tokenStorageDescription(options), error: error.message };
  }
}

/**
 * Access tokens from a stored refresh token, cached until shortly before expiry.
 *
 * A 400 invalid_grant here is not a transient error and must not be retried: it
 * means the refresh token is dead. The usual causes are the seven-day Testing
 * expiry, the user revoking access, six months of disuse, or a password change
 * while Gmail scopes are attached. The message says so, because "400" alone
 * sends people looking in the wrong place.
 */
export function createTokenProvider({ clientId, clientSecret, refreshToken, fetchImpl = fetch, skewMs = 60_000 }) {
  let cached = null;
  let expiresAt = 0;
  return async function getAccessToken({ force = false } = {}) {
    if (!force && cached && Date.now() < expiresAt - skewMs) return cached;
    const body = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: "refresh_token" });
    if (clientSecret) body.set("client_secret", clientSecret);
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (json.error === "invalid_grant") {
        const e = new Error(
          "the Google connection is no longer valid and cannot be refreshed. Reconnect with `brain connect google`.\n" +
            "  Common causes: the OAuth consent screen is still in Testing (those refresh tokens expire after 7 days,\n" +
            "  publish it instead), access was revoked at myaccount.google.com/permissions, six months of disuse,\n" +
            "  or a password change with Gmail scopes attached."
        );
        e.needsReauth = true;
        throw e;
      }
      throw new Error(`token refresh failed (${res.status}): ${json.error_description || json.error || "unknown"}`);
    }
    cached = json.access_token;
    expiresAt = Date.now() + (json.expires_in || 3600) * 1000;
    return cached;
  };
}
