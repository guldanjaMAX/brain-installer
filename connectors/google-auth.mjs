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
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const SCOPES = {
  drive: "https://www.googleapis.com/auth/drive.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.events.readonly",
};

/** Fixed so the client can paste ONE redirect URI into the Google console. */
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
            ? `port ${port} is already in use, so the sign-in cannot complete. Close whatever is using it, or pass --port with a different value AND add that redirect URI in the Google console.`
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
 * Tokens live on the CLIENT's machine, mode 0600, and never transit us.
 *
 * The file also holds the client id and secret, because re-running any sync
 * needs them to refresh. That is why the directory is added to the ingest
 * walker's skip list: a brain should never index its own credentials. The
 * credential gate on the worker catches Google tokens as a second line, but the
 * first line is not sending them.
 */
export function saveTokens(store, path = tokenPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode. The file still sits in the user profile.
  }
}

export function loadTokens(path = tokenPath()) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) || {};
  } catch {
    return {};
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
