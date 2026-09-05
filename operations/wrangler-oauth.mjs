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
  out.push(joinFor(home, ".config", rel));
  out.push(joinFor(home, rel));
  return out;
}

/** The config file wrangler is actually using, or null. */
export function findWranglerConfig(options = {}) {
  const exists = options.existsSync ?? existsSync;
  for (const path of wranglerConfigCandidates(options.env, options.platform)) {
    if (exists(path)) return path;
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
  const result = run("npx", ["wrangler@4", "whoami"], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    env,
    shell: (options.platform ?? process.platform) === "win32",
  });
  return result?.status === 0;
}

/**
 * The client's wrangler token, refreshed if it is close to expiry.
 *
 * Returns null for every "not available" case rather than throwing, because
 * this is one credential source among several and a missing wrangler session
 * is an ordinary state, not an error.
 */
export function readWranglerOAuthToken(options = {}) {
  const path = findWranglerConfig(options);
  if (!path) return null;
  const read = options.readFileSync ?? readFileSync;
  let session;
  try {
    session = parseWranglerSession(read(path, "utf8"));
  } catch {
    return null;
  }
  if (!session.token) return null;

  // Wrangler's access tokens last about an hour. Refresh with a margin rather
  // than at the boundary: an install step that starts valid and expires
  // mid-provision is far worse than one that refreshes first.
  const now = options.now ?? Date.now();
  const marginMs = options.marginMs ?? 5 * 60_000;
  const stale = session.expiresAt === null || session.expiresAt - now < marginMs;
  if (!stale) return session.token;

  if (!(options.refresh ?? refreshWranglerSession)(options)) return null;
  try {
    const after = parseWranglerSession(read(path, "utf8"));
    if (!after.token) return null;
    const goodNow = after.expiresAt === null || after.expiresAt - (options.now ?? Date.now()) > 0;
    return goodNow ? after.token : null;
  } catch {
    return null;
  }
}
