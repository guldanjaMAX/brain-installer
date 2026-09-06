/**
 * Use the client's own `wrangler login` session instead of a pasted API token.
 *
 * The token ceremony is the single most expensive step of an install. It sends
 * a non-technical owner to a page whose templates produce incompatible
 * credentials, omits D1 (the brain's whole database) from the one template we
 * tell them to pick, cannot be submitted at all on an account with no zones,
 * and ends in a 64-character paste into a hidden prompt that REFUSES to run
 * unless stdin is a real terminal. That last point is why an install cannot be
 * driven from an agent session, which is how every install is actually run.
 *
 * `wrangler login` replaces all of it with one browser click. Its OAuth access
 * token is a normal Bearer credential for api.cloudflare.com, verified against
 * the live API on 2026-09-02, so nothing downstream has to change: the same
 * cf() call works with it.
 *
 * The trade is scope. An OAuth session is account-wide user authority, where
 * the documented token is four permissions. It expires in about an hour, the
 * client holds it in their own account, and `wrangler logout` revokes it. The
 * scoped token stays supported for anyone who wants the narrower grant.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";

/**
 * The one wrangler the product spawns and the one it tells operators to run.
 *
 * Pinned because wrangler 4.129 (npm "latest" as of 2026-09-04) stores the
 * browser sign-in in an encrypted default.enc with the key in the OS keyring,
 * and this module reads default.toml. Unpinned, `npx wrangler@4` resolves to
 * 4.129 on every machine, so: the mid-run session renewal below re-reads a file
 * that was never rewritten and returns null; the CLI refuses to start in the
 * last five minutes of every session hour; and older `brain doctor` builds
 * reported "not signed in" against a valid session and printed a login command
 * that wrote the unreadable format. Two client installs lost time to this on
 * 2026-09-04.
 *
 * Lift the pin only when this module reads the encrypted store. The test
 * test/wrangler-spec-pinned.test.mjs fails on any bare "wrangler@4" in product
 * code so the pin cannot silently drift back out.
 */
export const WRANGLER_SPEC = "wrangler@4.73.0";

/** Discriminants returned by readWranglerOAuthSession(). */
export const WRANGLER_SESSION_AVAILABLE = "available";
export const WRANGLER_SESSION_ABSENT = "absent";
export const WRANGLER_SESSION_ENCRYPTED_UNSUPPORTED = "encrypted-unsupported";
export const WRANGLER_SESSION_UNREADABLE = "unreadable";

/** Every place wrangler is known to keep its config, newest layout first. */
export function wranglerConfigCandidates(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || homedir();
  // Join with the separator of the platform being ASKED ABOUT, not the one this
  // process happens to run on. Using the host's join made every POSIX answer
  // come back with backslashes when the caller ran on Windows, which is why the
  // Windows CI job for this module has been red while macOS was green.
  const joinFor = platform === "win32" ? win32Path.join : posixPath.join;
  const rel = joinFor(".wrangler", "config", "default.toml");
  const out = [];
  if (platform === "win32") {
    if (env.APPDATA) {
      out.push(joinFor(env.APPDATA, "xdg.config", rel));
      out.push(joinFor(env.APPDATA, rel));
    }
    if (env.LOCALAPPDATA) out.push(joinFor(env.LOCALAPPDATA, rel));
  }
  if (env.XDG_CONFIG_HOME) out.push(joinFor(env.XDG_CONFIG_HOME, rel));
  // Wrangler 4.73.0's xdg-app-paths uses this native default on macOS.
  // A developer's older ~/.config session masked its absence in our tests.
  if (platform === "darwin") out.push(joinFor(home, "Library", "Preferences", rel));
  out.push(joinFor(home, ".config", rel));
  out.push(joinFor(home, rel));
  return out;
}

/**
 * Wrangler session files in the same location precedence Wrangler uses.
 *
 * A readable TOML session wins when both formats exist in one location. The
 * encrypted file is only detected. Its key belongs to the OS keyring and this
 * installer must not guess at or reimplement Wrangler's decryption ceremony.
 */
export function wranglerSessionCandidates(env = process.env, platform = process.platform) {
  return wranglerConfigCandidates(env, platform).flatMap((path) => [
    Object.freeze({ path, format: "toml" }),
    Object.freeze({ path: path.replace(/default\.toml$/, "default.enc"), format: "encrypted" }),
  ]);
}

/** The first supported TOML config file, kept for existing callers and tests. */
export function findWranglerConfig(options = {}) {
  const exists = options.existsSync ?? existsSync;
  for (const path of wranglerConfigCandidates(options.env, options.platform)) {
    if (exists(path)) return path;
  }
  return null;
}

/** The first supported or encrypted session file Wrangler would consider. */
export function findWranglerSessionConfig(options = {}) {
  const exists = options.existsSync ?? existsSync;
  for (const candidate of wranglerSessionCandidates(options.env, options.platform)) {
    if (exists(candidate.path)) return candidate;
  }
  return null;
}

/**
 * Read the session without judging it. Values are returned, never logged: a
 * token that reaches a terminal has reached a screen recording.
 */
export function parseWranglerSession(text) {
  const value = (key) => {
    const match = new RegExp(`${key}\\s*=\\s*"([^"]*)"`).exec(String(text || ""));
    return match ? match[1] : null;
  };
  const expires = value("expiration_time");
  return Object.freeze({
    token: value("oauth_token") || null,
    expiresAt: expires ? Date.parse(expires) : null,
  });
}

/**
 * Refresh through wrangler itself rather than reimplementing the OAuth
 * exchange. CLOUDFLARE_API_TOKEN must be cleared for the child: wrangler
 * prefers it when set and would authenticate as the wrong identity, which is
 * the exact failure that makes an operator's token silently provision into
 * their own account instead of the client's.
 */
export function refreshWranglerSession(options = {}) {
  const run = options.run ?? spawnSync;
  const env = { ...(options.env ?? process.env) };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_KEY;
  const result = run("npx", [WRANGLER_SPEC, "whoami"], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    env,
    shell: (options.platform ?? process.platform) === "win32",
  });
  return result?.status === 0;
}

/**
 * The client's Wrangler session state, with a token refreshed when possible.
 * The discriminant lets doctor distinguish an encrypted session from absence
 * without reading or attempting to decrypt the encrypted file.
 */
export function readWranglerOAuthSession(options = {}) {
  const candidate = findWranglerSessionConfig(options);
  if (!candidate) {
    return Object.freeze({ type: WRANGLER_SESSION_ABSENT, token: null });
  }
  if (candidate.format === "encrypted") {
    return Object.freeze({
      type: WRANGLER_SESSION_ENCRYPTED_UNSUPPORTED,
      token: null,
      path: candidate.path,
    });
  }

  const path = candidate.path;
  const read = options.readFileSync ?? readFileSync;
  let session;
  try {
    session = parseWranglerSession(read(path, "utf8"));
  } catch {
    return Object.freeze({
      type: WRANGLER_SESSION_UNREADABLE,
      token: null,
      path,
      reason: "read-failed",
    });
  }
  if (!session.token) {
    return Object.freeze({
      type: WRANGLER_SESSION_UNREADABLE,
      token: null,
      path,
      reason: "token-missing",
    });
  }

  // Wrangler's access tokens last about an hour. Refresh with a margin rather
  // than at the boundary: an install step that starts valid and expires
  // mid-provision is far worse than one that refreshes first.
  const now = options.now ?? Date.now();
  const marginMs = options.marginMs ?? 5 * 60_000;
  const stale = session.expiresAt === null || session.expiresAt - now < marginMs;
  if (!stale) {
    return Object.freeze({
      type: WRANGLER_SESSION_AVAILABLE,
      token: session.token,
      path,
    });
  }

  if (!(options.refresh ?? refreshWranglerSession)(options)) {
    return Object.freeze({
      type: WRANGLER_SESSION_UNREADABLE,
      token: null,
      path,
      reason: "refresh-failed",
    });
  }
  try {
    const after = parseWranglerSession(read(path, "utf8"));
    if (!after.token) {
      return Object.freeze({
        type: WRANGLER_SESSION_UNREADABLE,
        token: null,
        path,
        reason: "token-missing-after-refresh",
      });
    }
    const goodNow = after.expiresAt === null || after.expiresAt - (options.now ?? Date.now()) > 0;
    return goodNow
      ? Object.freeze({ type: WRANGLER_SESSION_AVAILABLE, token: after.token, path })
      : Object.freeze({
        type: WRANGLER_SESSION_UNREADABLE,
        token: null,
        path,
        reason: "expired-after-refresh",
      });
  } catch {
    return Object.freeze({
      type: WRANGLER_SESSION_UNREADABLE,
      token: null,
      path,
      reason: "read-failed-after-refresh",
    });
  }
}

/**
 * Compatibility surface for provisioning, where this remains one credential
 * source among several. Doctor uses the typed reader above so it can explain
 * an encrypted session without misreporting the owner as signed out.
 */
export function readWranglerOAuthToken(options = {}) {
  const session = readWranglerOAuthSession(options);
  return session.type === WRANGLER_SESSION_AVAILABLE ? session.token : null;
}
