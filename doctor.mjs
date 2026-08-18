/**
 * Preflight for an install.
 *
 * WHY THIS EXISTS
 *
 * A clean-room rehearsal on 2026-08-17 found three defects that only appear when
 * you run the whole sequence from nothing: provisioning could not reach Vectorize
 * with any API token, secrets failed because the worker did not exist yet, and a
 * false drift warning fired on every healthy install. Every one of those would
 * have surfaced live, in front of a client, in the first ten minutes.
 *
 * Doctor's job is to find all of that BEFORE the session starts, and to say what
 * to do about each in words the person reading can act on. A check that reports
 * "failed" without a fix has done half a job.
 *
 * EVERY CHECK IS INDEPENDENT AND NON-DESTRUCTIVE. Doctor never creates anything.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export const OK = "ok";
export const WARN = "warn";
export const FAIL = "fail";

const IS_WIN = platform() === "win32";

/**
 * Run a command, cross-platform.
 *
 * TWO WINDOWS TRAPS, both of which produce an unbounded retry loop on a live
 * call rather than an error anyone can read.
 *
 * 1. npm-installed CLIs are `.cmd` shims on Windows, and since CVE-2024-27980
 *    Node REFUSES to spawn a .cmd or .bat without `shell: true` (EINVAL, on
 *    every Node 22 and 24). A bare spawn also does no PATHEXT resolution, so
 *    `npx` alone is ENOENT. Both failures look identical to "not installed", so
 *    doctor would tell a client to install wrangler forever while they already
 *    have it.
 * 2. With `shell: true` on Windows the arguments are re-parsed by cmd.exe, so a
 *    path containing a space silently becomes two arguments. Anything risky is
 *    quoted before it gets there.
 *
 * NOT YET RUN ON WINDOWS. Written from the platform behaviour and the CVE, and
 * flagged so nobody reads a green macOS run as proof.
 */
const NEEDS_SHELL = new Set(["npx", "npm", "claude", "codex", "wrangler"]);

function quoteWin(a) {
  return /[\s"^&|<>()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a;
}

export function run(cmd, args = [], { timeout = 20_000, env } = {}) {
  // Build the environment EXPLICITLY. spawnSync drops any key whose value is
  // undefined, so spreading `{CLOUDFLARE_ACCOUNT_ID: undefined}` over process.env
  // deletes a value the user deliberately exported. That is intended for the API
  // token and wrong for everything else, and the previous version could not tell
  // the two apart.
  const finalEnv = { ...process.env };
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) delete finalEnv[k];
    else finalEnv[k] = String(v);
  }

  const useShell = IS_WIN && NEEDS_SHELL.has(cmd);
  const argv = useShell ? args.map(quoteWin) : args;

  try {
    const r = spawnSync(cmd, argv, {
      encoding: "utf-8",
      timeout,
      shell: useShell,
      env: finalEnv,
      windowsHide: true,
    });
    return {
      ok: r.status === 0,
      out: `${r.stdout || ""}${r.stderr || ""}`,
      missing: r.error?.code === "ENOENT",
    };
  } catch (e) {
    return { ok: false, out: String(e.message), missing: e.code === "ENOENT" };
  }
}

const check = (name, status, detail, fix) => ({ name, status, detail, fix });

/* ------------------------------------------------------------------ checks */

export function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) return check("Node", OK, `v${process.versions.node}`);
  return check(
    "Node",
    FAIL,
    `v${process.versions.node}, but 22 or newer is required`,
    IS_WIN
      ? "Install Node 22 LTS: winget install OpenJS.NodeJS.LTS\n  Then close this window and open a NEW terminal, or npm will not be on PATH yet."
      : "Install Node 22 LTS from nodejs.org, or: brew install node"
  );
}

export function checkWrangler() {
  const r = run("npx", ["wrangler@4", "--version"], { timeout: 120_000 });
  if (r.ok && /\d+\.\d+/.test(r.out)) {
    return check("wrangler", OK, (r.out.match(/\d+\.\d+\.\d+/) || ["present"])[0]);
  }
  return check(
    "wrangler",
    FAIL,
    "could not be run",
    "wrangler is fetched on demand by npx, so this usually means no network or a blocked npm registry.\n  Test with: npx wrangler@4 --version"
  );
}

/**
 * Wrangler's OAuth session.
 *
 * Load-bearing, not a nicety: no Cloudflare API token can create a Vectorize
 * index, so without this login the install cannot provision its storage.
 */
/**
 * Only set CLOUDFLARE_ACCOUNT_ID when we actually have one.
 *
 * Passing it as undefined means "delete this key", which would remove a value
 * the client deliberately exported and leave wrangler unable to choose between
 * their accounts. Clearing the API token IS intended: wrangler prefers it when
 * set and would authenticate as the wrong identity.
 */
function cfEnv(accountId) {
  const env = { CLOUDFLARE_API_TOKEN: undefined };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}

export function checkWranglerLogin(accountId) {
  const env = cfEnv(accountId);
  const r = run("npx", ["wrangler@4", "whoami"], { timeout: 120_000, env });
  if (r.ok && /You are logged in|Account Name/i.test(r.out)) {
    const email = (r.out.match(/associated with the email ([^\s]+@[^\s]+?)[.\s]*$/im) || r.out.match(/([\w.+-]+@[\w-]+\.[\w.]+[\w])/) || [])[1];
    const accounts = (r.out.match(/│/g) || []).length;
    return check("wrangler login", OK, email ? `signed in as ${email}` : "signed in", accounts > 8 ? "this login can see several accounts, so account_id in the manifest is required" : undefined);
  }
  return check(
    "wrangler login",
    FAIL,
    "not signed in",
    "Run: npx wrangler@4 login\n" +
      "  This opens the browser and the session belongs to whoever signs in.\n" +
      "  It is REQUIRED: no Cloudflare API token can create a Vectorize index,\n" +
      "  so provisioning cannot complete without it."
  );
}

export function checkVectorize(accountId) {
  const env = cfEnv(accountId);
  const r = run("npx", ["wrangler@4", "vectorize", "list"], { timeout: 120_000, env });
  if (r.ok) {
    return check("Vectorize", OK, /haven't created any indexes/i.test(r.out) ? "reachable, no indexes yet" : "reachable");
  }
  // A login that can see several accounts cannot act without being told which
  // one, and wrangler says so rather than failing for any Vectorize reason.
  // Reporting that as "not on the paid plan" sends someone to spend money on a
  // problem they do not have, which is worse than reporting nothing.
  // What wrangler ACTUALLY does with several accounts and no choice made: it
  // falls back to an all-zeros account id, gets an auth error from that, and
  // then prints the account table. So the zeros are the reliable tell, not any
  // phrase about accounts.
  if (/accounts\/0{32}\//.test(r.out) || /more than one account|unable to select one/i.test(r.out)) {
    return check(
      "Vectorize",
      WARN,
      "not checked: this login can see several Cloudflare accounts",
      "Nothing is wrong yet. Tell it which account to use and re-run:\n" +
        "    export CLOUDFLARE_ACCOUNT_ID='<the account id>'\n" +
        "  `brain setup` asks for this and then checks properly. If you already have a\n" +
        "  manifest, `brain doctor <manifest>` reads the id from it."
    );
  }

  const paid = /workers paid|not entitled|upgrade|subscription|billing/i.test(r.out);
  return check(
    "Vectorize",
    FAIL,
    paid ? "the account is not on the Workers Paid plan" : "unreachable",
    "Vectorize requires the Workers Paid plan, 5 USD a month. There is no free allowance,\n" +
      "  and an index cannot be created on the free tier at all.\n" +
      "  Cloudflare dashboard > Workers & Pages > Plans > upgrade, then re-run.\n" +
      "  Without it the brain can only match documents that repeat the words in the question."
  );
}

export function checkClaudeCode() {
  const r = run("claude", ["--version"], { timeout: 30_000 });
  if (r.ok) return check("Claude Code", OK, (r.out.trim().split("\n")[0] || "present").slice(0, 40));
  return check(
    "Claude Code",
    WARN,
    "not found on PATH",
    "Optional, but it is how most people will actually use the brain.\n  Install from claude.com/claude-code, then re-run `brain doctor`."
  );
}

export function checkCodex() {
  const r = run("codex", ["--version"], { timeout: 30_000 });
  if (r.ok) return check("Codex", OK, (r.out.trim().split("\n")[0] || "present").slice(0, 40));
  return check("Codex", WARN, "not found on PATH", "Optional. Install it if the client uses Codex; setup wires up whichever is present.");
}

export function checkAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return check("Anthropic key", OK, "present in the environment");
  return check(
    "Anthropic key",
    WARN,
    "not set",
    "Search still works without it, but /think returns sources and NO written answer.\n" +
      "  The client creates their own at console.anthropic.com so the cost and the data stay theirs:\n" +
      "    export ANTHROPIC_API_KEY='...'"
  );
}

export function checkGoogleConnection() {
  const p = join(homedir(), ".brain", "google-tokens.json");
  if (existsSync(p)) return check("Google connection", OK, `token stored at ${p}`);
  return check(
    "Google connection",
    WARN,
    "not connected",
    "Only needed to ingest from Drive or Gmail. A local folder works without it.\n  Connect with: brain connect google --scopes drive,gmail"
  );
}

/**
 * BOTH credentials are required today, and the docs used to say "pick one".
 *
 * The API token drives verify, D1 creation, migrations, deploy and secrets.
 * Wrangler's login exists ONLY because no API token can reach Vectorize. A
 * machine with just the login passes every other check and then dies at the
 * first API call, three steps into setup, which is exactly where a preflight
 * is supposed to have looked.
 */
export function checkCfToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return check("Cloudflare token", OK, "present in the environment");
  return check(
    "Cloudflare token",
    FAIL,
    "CLOUDFLARE_API_TOKEN is not set",
    "Create one in the CLIENT's account: dash.cloudflare.com > My Profile > API Tokens.\n" +
      "  Scopes: Workers Scripts Edit, D1 Edit, Workers AI Read.\n" +
      "  Then: export CLOUDFLARE_API_TOKEN='...'\n" +
      "  This is needed ALONGSIDE the wrangler login, not instead of it: the token\n" +
      "  drives the API steps, and the login exists because no token can reach Vectorize."
  );
}

export async function checkNetwork() {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      method: "GET",
      headers: { authorization: "Bearer probe" },
      signal: AbortSignal.timeout(15_000),
    });
    // A 400 or 401 is a perfectly good answer: it proves we reached Cloudflare.
    return check("Network", OK, `reached api.cloudflare.com (HTTP ${res.status})`);
  } catch (e) {
    return check(
      "Network",
      FAIL,
      `cannot reach api.cloudflare.com: ${String(e.message).slice(0, 80)}`,
      "Check the connection, a VPN, or a corporate proxy. Everything else here needs this."
    );
  }
}

/** Every check, in the order a person should fix them. */
export async function runAll({ accountId, onResult } = {}) {
  const out = [];
  // Each result is handed to the caller the moment it exists, so a slow check
  // shows the ones before it rather than holding the whole report hostage.
  const push = (x) => {
    out.push(x);
    if (onResult) onResult(x);
    return x;
  };
  push(checkNode());
  push(await checkNetwork());
  push(checkWrangler());
  // Skip the ones that cannot possibly pass, rather than emitting a cascade of
  // failures that all trace back to one cause.
  out.push(checkCfToken());
  if (out.find((c) => c.name === "wrangler")?.status === OK) {
    out.push(checkWranglerLogin(accountId));
    if (out.find((c) => c.name === "wrangler login")?.status === OK) out.push(checkVectorize(accountId));
    else
      out.push(
        check(
          "Vectorize",
          WARN,
          "not checked, because wrangler is not signed in",
          // Every non-ok check owes the reader a next step. This branch only
          // runs on a machine with no wrangler login, which is every client
          // machine and never the developer's, so CI on a clean runner is what
          // caught it.
          "Sign in first, then re-run this: npx wrangler@4 login\n" +
            "  Vectorize is where meaning-based search lives, and it can only be created\n" +
            "  through that session. It also requires the Workers Paid plan, 5 USD a month."
        )
      );
  }
  out.push(checkAnthropicKey());
  out.push(checkClaudeCode());
  out.push(checkCodex());
  out.push(checkGoogleConnection());
  return out;
}

export function summarize(checks) {
  return {
    fatal: checks.filter((c) => c.status === FAIL).length,
    warnings: checks.filter((c) => c.status === WARN).length,
    ok: checks.filter((c) => c.status === OK).length,
  };
}
