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
  chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync,
  fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

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

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CHILD_ENV_BASICS = Object.freeze(["HOME", "USER", "LOGNAME", "TMPDIR"]);
const BROWSER_ENV_BASICS = Object.freeze([
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION",
]);

/**
 * Return only the OS/session variables Google auth helper children need. In
 * particular, no credential inherited by the desktop process reaches browser,
 * Keychain, Expect, ACL, or DPAPI helpers.
 */
export function googleAuthChildEnvironment(
  environment = process.env,
  { platform = process.platform, browser = false } = {},
) {
  const clean = platform === "win32"
    ? {}
    : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  for (const name of CHILD_ENV_BASICS) {
    const value = environment?.[name];
    if (typeof value === "string" && value) clean[name] = value;
  }
  if (platform === "win32") {
    const systemRoot = environment?.SystemRoot || environment?.SYSTEMROOT || environment?.WINDIR;
    if (typeof systemRoot === "string" && systemRoot) clean.SystemRoot = systemRoot;
    // CurrentUser DPAPI needs the loaded profile's runtime locators. This is a
    // fixed allowlist, so API keys and other inherited credentials stay out.
    for (const name of [
      "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
      "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
    ]) {
      const value = environment?.[name];
      if (typeof value === "string" && value) clean[name] = value;
    }
  }
  if (browser) {
    for (const name of BROWSER_ENV_BASICS) {
      const value = environment?.[name];
      if (typeof value === "string" && value) clean[name] = value;
    }
  }
  return clean;
}

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

export function openBrowser(url, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  const command = options.openCommand || (
    platform === "darwin"
      ? "/usr/bin/open"
      : platform === "win32" && systemRoot
        ? join(systemRoot, "explorer.exe")
        : platform === "win32"
          ? "explorer.exe"
          : "/usr/bin/xdg-open"
  );
  try {
    (options.spawnChild || spawn)(command, [url], {
      detached: true,
      env: googleAuthChildEnvironment(environment, { platform, browser: true }),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
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

/**
 * Which environment variable selects the backend.
 *
 * Google's name is the default and nothing about Google changes. A second
 * credential class (the IMAP connector's mailbox app password) needs its OWN
 * name, or BRAIN_GOOGLE_TOKEN_STORE would silently decide where a mailbox
 * password lives — and the Drive scheduler's `childEnvironmentOf`, which sets
 * or deletes exactly that variable, would carry Google's semantics onto a
 * connector it was never about.
 */
const storeEnvName = (options = {}) => options.storeEnv || GOOGLE_TOKEN_STORE_ENV;

function storageBackend(options = {}) {
  const envName = storeEnvName(options);
  const requested = options.backend || options.env?.[envName] || process.env[envName] || "auto";
  if (!["auto", "keychain", "file"].includes(requested)) {
    throw new Error(`${envName} must be "keychain" or "file" (received "${requested}")`);
  }
  const platform = options.platform || process.platform;
  const backend = requested === "auto" ? (platform === "darwin" ? "keychain" : "file") : requested;
  if (backend === "keychain" && platform !== "darwin") {
    throw new Error(`macOS Keychain storage was requested on a non-macOS system; use ${envName}=file`);
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
  } catch {
    if (!strict) return {};
    // JSON parser errors can include nearby source text. Never attach that
    // error as a cause because the nearby text may be a token or client secret.
    throw new Error(`${source} does not contain a valid Google credential record`);
  }
}

const WINDOWS_DPAPI_HEADER = Buffer.from("BRAIN-GOOGLE-TOKENS-DPAPI-V1\n", "ascii");
const MAX_TOKEN_STORE_BYTES = 2 * 1024 * 1024;
const MAX_DPAPI_OUTPUT_BYTES = MAX_TOKEN_STORE_BYTES + 64 * 1024;
const WINDOWS_DPAPI_HELPER = fileURLToPath(new URL("../operations/windows-dpapi.ps1", import.meta.url));
const WINDOWS_DPAPI_BRIDGE = fileURLToPath(new URL("../operations/windows-dpapi-bridge.mjs", import.meta.url));
const WINDOWS_DPAPI_SOURCE = fileURLToPath(new URL("../operations/windows-dpapi.cs", import.meta.url));

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function removeIfSame(path, identity) {
  const current = lstatIfPresent(path);
  if (!sameFile(current, identity)) return false;
  try {
    unlinkSync(path);
    return lstatIfPresent(path) === null;
  } catch {
    return false;
  }
}

function validateTokenDirectory(path, platform, options, { prepare = false } = {}) {
  const directory = dirname(path);
  if (prepare) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = lstatIfPresent(directory);
  if (!identity || identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error("the Google token directory must be a real existing directory");
  }
  if (platform !== "win32") {
    const getUid = options.getUid || process.getuid;
    const expectedUid = typeof getUid === "function" ? getUid() : null;
    if (expectedUid !== null && identity.uid !== expectedUid) {
      throw new Error("the Google token directory must be owned by the current user");
    }
    if (prepare) {
      try { chmodSync(directory, 0o700); } catch {
        throw new Error("the Google token directory could not be restricted to the current user");
      }
    }
  }
  return identity;
}

function validateExistingTokenFile(path, platform, options) {
  const identity = lstatIfPresent(path);
  if (!identity) return null;
  if (identity.isSymbolicLink() || !identity.isFile() || identity.nlink !== 1) {
    throw new Error("the Google token file must be a private regular file with no links");
  }
  if (platform !== "win32") {
    const getUid = options.getUid || process.getuid;
    const expectedUid = typeof getUid === "function" ? getUid() : null;
    if (expectedUid !== null && identity.uid !== expectedUid) {
      throw new Error("the Google token file must be owned by the current user");
    }
    if ((identity.mode & 0o777) !== 0o600) {
      throw new Error("the Google token file permissions must be exactly 0600");
    }
  }
  return identity;
}

function childResultBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value), "utf8");
}

function wipeChildResult(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

function windowsRuntime(options) {
  const environment = options.environment || process.env;
  const env = googleAuthChildEnvironment(environment, { platform: "win32" });
  const systemRoot = env.SystemRoot;
  if (!systemRoot && process.platform === "win32" && !options.runPowerShell) {
    throw new Error("Windows could not locate its system runtime directory");
  }
  return {
    command: options.powerShellPath || (systemRoot
      ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe"),
    env,
  };
}

function runWindowsDpapi(input, options, operation) {
  const { command, env } = windowsRuntime(options);
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > MAX_DPAPI_OUTPUT_BYTES) {
    throw new Error("Windows DPAPI received an invalid Google credential payload size");
  }
  const powerShellArgs = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_DPAPI_HELPER,
    "-Operation", operation,
    "-ExpectedLength", String(input.length),
  ];
  // Keep the injected direct runner for deterministic tests. Production uses
  // a fixed Node bridge that compiles a fixed C# helper before reading any
  // secret, then writes the same bytes through an asynchronous pipe.
  const runner = options.runPowerShell || spawnSync;
  const runnerCommand = options.runPowerShell ? command : process.execPath;
  const runnerArgs = options.runPowerShell
    ? powerShellArgs
    : [
        WINDOWS_DPAPI_BRIDGE,
        "--source", WINDOWS_DPAPI_SOURCE,
        "--operation", operation,
        "--length", String(input.length),
        "--max", String(MAX_DPAPI_OUTPUT_BYTES),
      ];
  let result;
  let stdout;
  let stderr;
  const failureMessage = operation === "protect"
    ? "Windows could not protect the Google credential record with DPAPI"
    : "Windows could not decrypt the Google credential record with DPAPI for the current user";
  try {
    result = runner(runnerCommand, runnerArgs, {
      encoding: null,
      env,
      input,
      maxBuffer: MAX_DPAPI_OUTPUT_BYTES,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs || 30_000,
      windowsHide: true,
    });
    stdout = childResultBuffer(result?.stdout);
    stderr = childResultBuffer(result?.stderr);
    if (result?.status !== 0 || result?.error || !stdout.length ||
        stdout.length > MAX_DPAPI_OUTPUT_BYTES) {
      throw new Error(failureMessage);
    }
    return Buffer.from(stdout);
  } catch {
    throw new Error(failureMessage);
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
    wipeChildResult(result);
  }
}

function parseDpapiEnvelope(bytes) {
  const body = bytes.subarray(WINDOWS_DPAPI_HEADER.length).toString("ascii");
  if (!/^[A-Za-z0-9+/]+={0,2}\r?\n?$/.test(body)) {
    throw new Error("the Windows Google token DPAPI envelope is malformed");
  }
  const encoded = body.replace(/\r?\n$/, "");
  if (!encoded || encoded.length % 4 !== 0) {
    throw new Error("the Windows Google token DPAPI envelope is malformed");
  }
  const protectedBytes = Buffer.from(encoded, "base64");
  if (!protectedBytes.length || protectedBytes.toString("base64") !== encoded) {
    protectedBytes.fill(0);
    throw new Error("the Windows Google token DPAPI envelope is malformed");
  }
  return protectedBytes;
}

function protectWindowsPayload(payload, options) {
  let protectedBytes;
  try {
    protectedBytes = runWindowsDpapi(payload, options, "protect");
    return Buffer.from(
      `${WINDOWS_DPAPI_HEADER.toString("ascii")}${protectedBytes.toString("base64")}\n`,
      "ascii",
    );
  } finally {
    if (protectedBytes) protectedBytes.fill(0);
  }
}

function decodeStoreBytes(bytes, path, options, { strict = true } = {}) {
  const platform = options.platform || process.platform;
  let payload;
  let protectedBytes;
  const encrypted = bytes.subarray(0, WINDOWS_DPAPI_HEADER.length).equals(WINDOWS_DPAPI_HEADER);
  try {
    if (encrypted) {
      if (platform !== "win32") {
        throw new Error("a Windows DPAPI Google token file can only be read by its Windows user");
      }
      protectedBytes = parseDpapiEnvelope(bytes);
      payload = runWindowsDpapi(protectedBytes, options, "unprotect");
    } else {
      payload = Buffer.from(bytes);
    }
    if (!payload.length || payload.length > MAX_TOKEN_STORE_BYTES) {
      throw new Error("the Google token file is empty or oversized");
    }
    let text;
    try { text = UTF8_DECODER.decode(payload); } catch {
      throw new Error("the Google token file does not contain valid UTF-8 JSON");
    }
    const store = parseStore(text, path, { strict: strict || encrypted });
    return { encrypted, payload: Buffer.from(payload), store };
  } finally {
    if (protectedBytes) protectedBytes.fill(0);
    if (payload) payload.fill(0);
  }
}

function readIdentityBytes(path, identity, options, phase) {
  let descriptor;
  let loaded;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const current = fstatSync(descriptor);
    if (!sameFile(current, identity) || !current.isFile() || current.nlink !== 1) {
      throw new Error(`the Google token ${phase} identity changed before verification`);
    }
    try {
      loaded = options.readFileForVerification
        ? options.readFileForVerification(path, descriptor, phase)
        : readFileSync(descriptor);
    } catch {
      throw new Error(`the Google token ${phase} payload could not be read safely`);
    }
    const bytes = Buffer.isBuffer(loaded)
      ? Buffer.from(loaded)
      : Buffer.from(String(loaded ?? ""), "utf8");
    if (!bytes.length || bytes.length > MAX_DPAPI_OUTPUT_BYTES * 2) {
      bytes.fill(0);
      throw new Error(`the Google token ${phase} payload has an invalid size`);
    }
    return bytes;
  } finally {
    if (Buffer.isBuffer(loaded)) loaded.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the verification error */ }
    }
  }
}

function readFileStoreState(path, options = {}) {
  if (!lstatIfPresent(path)) return null;
  const platform = options.platform || process.platform;
  validateTokenDirectory(path, platform, options);
  const identity = validateExistingTokenFile(path, platform, options);
  if (!identity) return null;
  const bytes = readIdentityBytes(path, identity, options, "stored");
  try {
    const decoded = decodeStoreBytes(bytes, path, options, {
      strict: options.strict === true || platform === "win32",
    });
    try {
      return { encrypted: decoded.encrypted, store: decoded.store };
    } finally {
      decoded.payload.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

function readFileStore(path, options = {}) {
  return readFileStoreState(path, options)?.store ?? null;
}

function serializeStore(store) {
  try {
    const text = JSON.stringify(store, null, 2);
    if (typeof text !== "string") throw new Error("not serializable");
    const payload = Buffer.from(text, "utf8");
    if (!payload.length || payload.length > MAX_TOKEN_STORE_BYTES) {
      payload.fill(0);
      throw new Error("invalid size");
    }
    return payload;
  } catch {
    throw new Error("the Google credential record could not be serialized safely");
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("the Google token write made no progress");
    offset += written;
  }
}

function runWindowsAcl(path, options, label) {
  const environment = options.environment || process.env;
  const env = googleAuthChildEnvironment(environment, { platform: "win32" });
  const username = options.username || environment.USERNAME || environment.USER;
  if (typeof username !== "string" || !username.trim()) {
    throw new Error(`Windows could not identify the current user for the Google token ${label}`);
  }
  const command = options.icaclsPath || (env.SystemRoot
    ? join(env.SystemRoot, "System32", "icacls.exe")
    : "icacls.exe");
  const args = [path, "/inheritance:r", "/grant:r", `${username}:F`];
  let result;
  try {
    result = (options.runAcl || spawnSync)(command, args, {
      encoding: null,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs || 15_000,
      windowsHide: true,
    });
    if (result?.status !== 0 || result?.error) {
      throw new Error(`Windows could not restrict the Google token ${label} to the current user`);
    }
  } catch {
    throw new Error(`Windows could not restrict the Google token ${label} to the current user`);
  } finally {
    wipeChildResult(result);
  }
}

function createPrivatePayloadFile(path, bytes, platform, options, label) {
  let descriptor;
  let identity;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1) {
      throw new Error(`the Google token ${label} was not created as a private regular file`);
    }
    if (platform !== "win32") {
      try {
        (options.fchmodFile || fchmodSync)(descriptor, 0o600);
      } catch {
        throw new Error(`the Google token ${label} could not be restricted to the current user`);
      }
      const restricted = fstatSync(descriptor);
      if (!sameFile(restricted, identity) || (restricted.mode & 0o777) !== 0o600) {
        throw new Error(`the Google token ${label} was not restricted to the current user`);
      }
    }
    fsyncSync(descriptor);

    // The file is empty while its Windows DACL is replaced. Every byte written
    // afterward is already DPAPI ciphertext, including rollback backups made
    // while migrating a legacy plaintext record. Keep this exact handle open
    // across icacls and recheck both it and the destination before any write.
    if (platform === "win32") runWindowsAcl(path, options, label);

    const secured = fstatSync(descriptor);
    if (!sameFile(secured, identity) || !sameFile(lstatIfPresent(path), identity) ||
        !secured.isFile() || secured.nlink !== 1) {
      throw new Error(`the Google token ${label} identity changed before its payload was written`);
    }
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return identity;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the persistence error */ }
    }
    if (identity) removeIfSame(path, identity);
    throw error;
  }
}

function hasWindowsDpapiHeader(path, identity) {
  let descriptor;
  const prefix = Buffer.alloc(WINDOWS_DPAPI_HEADER.length);
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(opened, identity) || !opened.isFile() || opened.nlink !== 1) {
      throw new Error("the Google token file identity changed while its format was checked");
    }
    let offset = 0;
    while (offset < prefix.length) {
      const count = readSync(descriptor, prefix, offset, prefix.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (!sameFile(lstatIfPresent(path), identity)) {
      throw new Error("the Google token file identity changed while its format was checked");
    }
    return offset === prefix.length && prefix.equals(WINDOWS_DPAPI_HEADER);
  } finally {
    prefix.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the format-check result */ }
    }
  }
}

function verifyFilePayload(path, identity, expectedPayload, options, phase) {
  const bytes = readIdentityBytes(path, identity, options, phase);
  try {
    let decoded;
    try {
      decoded = decodeStoreBytes(bytes, path, options, { strict: true });
    } catch {
      throw new Error(`the Google token ${phase} payload could not be decoded and verified`);
    }
    try {
      if (!decoded.payload.equals(expectedPayload)) {
        throw new Error(`the Google token ${phase} payload did not read back exactly`);
      }
      return decoded.store;
    } finally {
      decoded.payload.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

function directorySyncUnsupported(error, platform) {
  if (["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) return true;
  return platform === "win32" &&
    ["EACCES", "EBADF", "EISDIR", "EPERM"].includes(error?.code);
}

function syncTokenDirectory(path, platform, options, phase, required = true) {
  let descriptor;
  let failure;
  try {
    if (options.syncParentDirectory) {
      options.syncParentDirectory(dirname(path), phase);
    } else {
      descriptor = openSync(dirname(path), fsConstants.O_RDONLY);
      fsyncSync(descriptor);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (error) { failure ||= error; }
    }
  }
  if (!failure) return true;
  if (directorySyncUnsupported(failure, platform)) return false;
  if (required) {
    throw new Error(`the Google token ${phase} directory state could not be synchronized safely`);
  }
  return false;
}

/** Stage, verify, atomically replace, verify again, and roll back on failure. */
function writeFileStore(path, store, options = {}) {
  const platform = options.platform || process.platform;
  validateTokenDirectory(path, platform, options, { prepare: true });
  const prior = validateExistingTokenFile(path, platform, options);
  const payload = serializeStore(store);
  let encoded;
  let suffix;
  try {
    encoded = platform === "win32"
      ? protectWindowsPayload(payload, options)
      : Buffer.from(payload);
  } catch (error) {
    payload.fill(0);
    throw error;
  }
  try {
    const entropy = (options.randomBytes || randomBytes)(8);
    suffix = Buffer.from(entropy).toString("hex");
    if (!/^[0-9a-f]{16}$/.test(suffix)) {
      throw new Error("Google token staging entropy must contain exactly 8 bytes");
    }
  } catch {
    payload.fill(0);
    if (encoded) encoded.fill(0);
    throw new Error("Google token staging entropy could not be generated safely");
  }
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${suffix}.tmp`);
  const backup = join(directory, `.${basename(path)}.${process.pid}.${suffix}.bak`);
  const renameFile = options.renameFile || renameSync;
  let stagedIdentity;
  let backupIdentity;
  let priorBytes;
  let priorPayload;
  let backupBytes;
  let committed = false;
  try {
    stagedIdentity = createPrivatePayloadFile(
      temporary, encoded, platform, options, "staging file",
    );
    verifyFilePayload(temporary, stagedIdentity, payload, options, "staged");

    const currentPrior = lstatIfPresent(path);
    if ((prior === null) !== (currentPrior === null) ||
        (prior && !sameFile(prior, currentPrior))) {
      throw new Error("the Google token destination changed while it was being prepared");
    }

    if (prior) {
      priorBytes = readIdentityBytes(path, prior, options, "prior snapshot");
      const priorDecoded = decodeStoreBytes(priorBytes, path, options, { strict: true });
      priorPayload = priorDecoded.payload;
      backupBytes = platform === "win32"
        ? (priorDecoded.encrypted ? Buffer.from(priorBytes) : protectWindowsPayload(priorPayload, options))
        : Buffer.from(priorBytes);
      backupIdentity = createPrivatePayloadFile(
        backup, backupBytes, platform, options, "rollback backup",
      );
      verifyFilePayload(backup, backupIdentity, priorPayload, options, "rollback backup");
    }

    const finalPrior = lstatIfPresent(path);
    if ((prior === null) !== (finalPrior === null) ||
        (prior && !sameFile(prior, finalPrior))) {
      throw new Error("the Google token destination changed before replacement");
    }
    syncTokenDirectory(path, platform, options, "prepared");
    try { renameFile(temporary, path); } catch {
      throw new Error("the Google token replacement could not be committed");
    }
    committed = true;
    const verified = verifyFilePayload(path, stagedIdentity, payload, options, "persisted");
    syncTokenDirectory(path, platform, options, "persisted");

    if (backupIdentity) {
      if (!removeIfSame(backup, backupIdentity)) {
        throw new Error("the Google token rollback backup could not be removed safely");
      }
      backupIdentity = undefined;
      syncTokenDirectory(path, platform, options, "backup cleanup", false);
    }
    return verified;
  } catch (error) {
    if (!committed) {
      if (stagedIdentity) removeIfSame(temporary, stagedIdentity);
      if (backupIdentity) removeIfSame(backup, backupIdentity);
      throw error;
    }

    let restored = false;
    if (prior && backupIdentity && priorPayload) {
      try {
        if (!sameFile(lstatIfPresent(path), stagedIdentity) ||
            !sameFile(lstatIfPresent(backup), backupIdentity)) {
          throw new Error("transaction identities changed");
        }
        renameFile(backup, path);
        const restoredIdentity = lstatIfPresent(path);
        if (!sameFile(restoredIdentity, backupIdentity)) {
          throw new Error("rollback identity did not become durable");
        }
        verifyFilePayload(path, restoredIdentity, priorPayload, options, "rollback");
        backupIdentity = undefined;
        syncTokenDirectory(path, platform, options, "rollback");
        restored = true;
      } catch {
        restored = false;
      }
    } else if (!prior) {
      restored = removeIfSame(path, stagedIdentity) && lstatIfPresent(path) === null;
      if (restored) {
        try { syncTokenDirectory(path, platform, options, "absence rollback"); }
        catch { restored = false; }
      }
    }
    throw new Error(
      restored
        ? prior
          ? "the Google token replacement was not verified; the prior credential record was restored and verified"
          : "the Google token replacement was not verified; no token destination was left behind"
        : "the Google token replacement was not verified and rollback could not be verified; a protected transaction artifact was retained",
    );
  } finally {
    payload.fill(0);
    encoded.fill(0);
    if (priorBytes) priorBytes.fill(0);
    if (priorPayload) priorPayload.fill(0);
    if (backupBytes) backupBytes.fill(0);
  }
}

function security(options, args, input) {
  const runSecurity = options.runSecurity || ((securityArgs, runOptions) =>
    spawnSync(options.securityPath || "/usr/bin/security", securityArgs, runOptions));
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  try {
    return runSecurity(args, {
      encoding: "utf-8",
      env: googleAuthChildEnvironment(environment, { platform }),
      input,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs || 15_000,
      windowsHide: true,
    });
  } catch {
    return { status: 1, stdout: "", stderr: "" };
  }
}

function securityPasswordWrite(options, args, payload) {
  // Injected runners keep the storage contract independently testable without
  // touching a developer's real Keychain.
  if (options.runSecurity && !options.runExpect) return security(options, args, `${payload}\n`);

  // `security ... -w` reads from /dev/tty, not a normal stdin pipe. Expect gives
  // it that terminal while the helper disables all transcript output. This
  // avoids the insecure alternative of putting the credential in `security`'s
  // argv, where another process could read it with `ps`.
  const helper = options.expectScriptPath || join(dirname(fileURLToPath(import.meta.url)), "keychain-write.exp");
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  try {
    return (options.runExpect || spawnSync)(options.expectPath || "/usr/bin/expect", [
      helper,
      options.securityPath || "/usr/bin/security",
      ...args,
    ], {
      encoding: "utf-8",
      env: googleAuthChildEnvironment(environment, { platform }),
      input: `${payload}\n`,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs || 15_000,
      windowsHide: true,
    });
  } catch {
    return { status: 1, stdout: "", stderr: "" };
  }
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
      `or explicitly use the mode-0600 fallback with ${storeEnvName(options)}=file.`
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
    // The label a person sees in Keychain Access. It must name the credential
    // it actually holds: a mailbox password filed under "Google OAuth" defeats
    // the whole reason these names are explicit.
    "-j", options.keychainComment || "Google OAuth credentials for Brain Installer",
    // Keeping -w last makes `security` prompt through the private terminal. The
    // value never appears in argv, shell history, process listings, or output.
    "-w",
  ];
  const result = securityPasswordWrite(options, args, value);
  if (result?.status !== 0) {
    throw new Error(
      "macOS Keychain could not store the connection. Unlock the login keychain and try again, " +
        `or explicitly use the mode-0600 fallback with ${storeEnvName(options)}=file.`
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
  const legacy = readFileStore(path, { ...options, strict: true });
  if (legacy && JSON.stringify(legacy) === JSON.stringify(store)) unlinkSync(path);
}

/**
 * Tokens live on the CLIENT's machine and never transit us. macOS uses the
 * login Keychain by default. Windows uses a DPAPI CurrentUser encrypted file.
 * Linux, and macOS users who explicitly set BRAIN_GOOGLE_TOKEN_STORE=file, use
 * an atomic mode-0600 plaintext file.
 *
 * The record also holds the client id and secret because unattended syncs need
 * them to refresh. The file fallback directory remains on the ingest walker's
 * skip list, and the worker credential gate remains a second line of defence.
 */
export function saveTokens(store, value) {
  if (!isRecord(store)) throw new Error("Google token store must be an object");
  const options = storageOptions(value);
  if (storageBackend(options) === "file") {
    writeFileStore(filePath(options), store, options);
    return;
  }
  writeKeychainStore(options, store);
  removeMatchingLegacyFile(options, store);
}

export function loadTokens(value) {
  const options = storageOptions(value);
  if (storageBackend(options) === "file") {
    const platform = options.platform || process.platform;
    const path = filePath(options);
    const state = readFileStoreState(path, { ...options, strict: platform === "win32" });
    if (!state) return {};
    if (platform === "win32" && !state.encrypted) {
      // A pre-DPAPI Windows file remains readable, but never remains plaintext
      // after a successful use. The transactional writer retains or restores
      // its credential record if encryption cannot be verified.
      return writeFileStore(path, state.store, options);
    }
    return state.store;
  }

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
/**
 * Actually open the credential store, rather than confirming a file is there.
 *
 * `tokenStorageStatus` deliberately never decrypts: it is called in cheap,
 * frequent contexts and has a test holding it to inspecting only the envelope
 * header. That is the right call for status, and it leaves a real gap, because
 * on Windows the header is 29 plaintext bytes. A DPAPI blob written by a
 * different Windows user, or one whose master key no longer resolves after a
 * profile rebuild, still carries a perfect header and still reports `exists`.
 * `brain doctor` then prints a healthy Google connection, and the first real
 * Drive or Gmail ingest is what discovers otherwise, usually on install day.
 *
 * So this is the opt-in counterpart: it performs one genuine round trip and
 * reports whether the stored credential can be read AT ALL. It never returns,
 * logs, or reveals any part of the credential, only whether it opened.
 *
 * Read-only on purpose. It goes through readFileStoreState rather than
 * loadTokens, because loadTokens migrates a legacy Windows plaintext file to
 * DPAPI as a side effect, and a diagnostic must not rewrite the thing it is
 * diagnosing.
 */
export function verifyTokenStorageReadable(value) {
  const options = storageOptions(value);
  const status = tokenStorageStatus(options);
  if (!status.exists) {
    return { checked: false, readable: false, reason: status.error || "no credential is stored" };
  }

  try {
    if (storageBackend(options) === "file") {
      const state = readFileStoreState(filePath(options), {
        ...options,
        strict: (options.platform || process.platform) === "win32",
      });
      if (!state || !state.store || typeof state.store !== "object") {
        return { checked: true, readable: false, reason: "the stored credential record could not be decoded" };
      }
      return { checked: true, readable: true };
    }

    const stored = readKeychainStore(options);
    if (!stored || typeof stored !== "object") {
      return { checked: true, readable: false, reason: "the stored credential record could not be decoded" };
    }
    return { checked: true, readable: true };
  } catch (error) {
    // The message is ours, not the credential's. Every throw on this path is
    // already written to name the failure without quoting a value.
    return { checked: true, readable: false, reason: error.message };
  }
}

export function tokenStorageDescription(value) {
  const options = storageOptions(value);
  if (storageBackend(options) === "file") {
    return (options.platform || process.platform) === "win32"
      ? `${filePath(options)} (Windows DPAPI CurrentUser encrypted file)`
      : `${filePath(options)} (atomic mode 0600 file)`;
  }
  return `macOS Keychain (service "${options.keychainService || GOOGLE_KEYCHAIN_SERVICE}", account "${options.keychainAccount || GOOGLE_KEYCHAIN_ACCOUNT}")`;
}

/**
 * Metadata-only probe for doctor. It never asks Keychain or DPAPI to reveal a
 * secret; on Windows it reads only the fixed envelope-header width.
 */
export function tokenStorageStatus(value) {
  const options = storageOptions(value);
  const backend = storageBackend(options);
  if (backend === "file") {
    const path = filePath(options);
    const platform = options.platform || process.platform;
    try {
      const present = lstatIfPresent(path);
      if (!present) {
        return { exists: false, backend, description: tokenStorageDescription(options) };
      }
      validateTokenDirectory(path, platform, options);
      const identity = validateExistingTokenFile(path, platform, options);
      if (platform !== "win32" || hasWindowsDpapiHeader(path, identity)) {
        return {
          exists: true,
          backend,
          description: tokenStorageDescription(options),
          ...(platform === "win32" ? { encrypted: true, migrationPending: false } : {}),
        };
      }
      return {
        exists: true,
        backend: "legacy-file",
        description: `${path} (legacy Windows plaintext file; DPAPI migration pending)`,
        encrypted: false,
        migrationPending: true,
      };
    } catch (error) {
      return {
        exists: false,
        backend,
        description: tokenStorageDescription(options),
        error: error.message,
      };
    }
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
