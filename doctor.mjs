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
 * EVERY CHECK IS INDEPENDENT AND NON-DESTRUCTIVE. Doctor never creates anything
 * in the client's install. The single exception is the credential-store round
 * trip, which writes a fixed non-secret value into a private temporary directory
 * it creates and removes, because a store nobody has ever read back is a store
 * nobody has tested.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { tokenStorageStatus } from "./connectors/google-auth.mjs";
import {
  credentialStoreDescription,
  probeCredentialStore,
} from "./operations/credential-store-probe.mjs";

export const OK = "ok";
export const WARN = "warn";
export const FAIL = "fail";

/**
 * The ONE description of how Vectorize is reached, so the CLI, the doctor, the
 * README and the template manifest cannot drift apart again. They already had:
 * doctor omitted the Vectorize scope while brain.mjs told clients to add it.
 *
 * What is actually established, measured 2026-08-18:
 *   - An API token CAN reach the Vectorize API. A full-access account-owned
 *     token listed indexes successfully. So the earlier blanket claim that "no
 *     API token can reach Vectorize" was wrong, and is retracted here.
 *   - The tokens that failed simply lacked the permission. Every one of them
 *     returned `Authentication error 10000`, which is indistinguishable from an
 *     invalid token and is why this was misdiagnosed as a platform limit.
 *   - On 2026-08-23 a user-owned token scoped to one account with Vectorize Edit
 *     created a 768-dimensional index and all six metadata indexes through the
 *     API. Wrangler login is therefore a fallback, not a prerequisite.
 */
export const VECTORIZE_REMEDY =
  "  Recreate the account-scoped token with Vectorize: Edit. That is the standard\n" +
  "  path and has been verified for index and metadata-index creation.\n" +
  "  Temporary fallback: run `npx wrangler@4 login` in the account owner's browser.\n" +
  "  Provision can use that session for Vectorize while the API token drives the\n" +
  "  remaining steps.\n" +
  "  Workers Paid (5 USD monthly minimum) is the supported production baseline.\n" +
  "  Free can create Vectorize, but its vector, daily-write, and CPU limits are\n" +
  "  prototype-scale and can hard-stop a real corpus.";

/** The token scopes, in one place, for the same reason. */
export const CF_TOKEN_SCOPES = ["Workers Scripts: Edit", "D1: Edit", "Vectorize: Edit", "Workers AI: Read"];

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

// Child CLIs do not need the desktop process's credentials. In particular,
// doctor and wrangler used to inherit ADMIN_KEY plus every provider token just
// to print a version or inspect Cloudflare login state. Keep only process/path
// essentials and explicitly non-secret configuration needed cross-platform.
const LOCAL_TOOL_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "USER", "USERNAME", "LOGNAME",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "SHELL", "TERM",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NPM_CONFIG_CACHE", "npm_config_cache", "NPM_CONFIG_PREFIX", "npm_config_prefix",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLOUDFLARE_ACCOUNT_ID",
]);

/** Build a credential-scrubbed environment for a local CLI child. */
export function localToolEnvironment(environment = process.env, overrides = {}) {
  const clean = {};
  for (const name of LOCAL_TOOL_ENV_ALLOWLIST) {
    const value = environment?.[name];
    if (typeof value === "string" && value) clean[name] = value;
  }
  for (const [name, value] of Object.entries(environment || {})) {
    if (name.startsWith("LC_") && typeof value === "string" && value) clean[name] = value;
  }
  for (const [name, value] of Object.entries(overrides || {})) {
    if (value === undefined) delete clean[name];
    else clean[name] = String(value);
  }
  return clean;
}

/** Preserve a chosen/exported account id, but never an ambient API credential. */
export function cloudflareCliEnvironment(accountId, environment = process.env) {
  return localToolEnvironment(environment, accountId
    ? { CLOUDFLARE_ACCOUNT_ID: accountId }
    : {});
}

function quoteWin(a) {
  return /[\s"^&|<>()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a;
}

export function run(cmd, args = [], {
  timeout = 20_000,
  env,
  inheritEnv = true,
  input,
  maxBuffer,
} = {}) {
  // Build the environment EXPLICITLY. spawnSync drops any key whose value is
  // undefined, so spreading `{CLOUDFLARE_ACCOUNT_ID: undefined}` over process.env
  // deletes a value the user deliberately exported. That is intended for the API
  // token and wrong for everything else, and the previous version could not tell
  // the two apart.
  const finalEnv = inheritEnv ? { ...process.env } : {};
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
      input,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      windowsHide: true,
    });
    const stdout = String(r.stdout || "");
    const stderr = String(r.stderr || "");
    return {
      ok: r.status === 0,
      out: `${stdout}${stderr}`,
      stdout,
      stderr,
      missing: r.error?.code === "ENOENT",
    };
  } catch (e) {
    return {
      ok: false,
      out: String(e.message),
      stdout: "",
      stderr: String(e.message),
      missing: e.code === "ENOENT",
    };
  }
}

const check = (name, status, detail, fix) => ({ name, status, detail, fix });

/* ------------------------------------------------------------------ checks */

/**
 * The runtime floor, in one place, matching `engines.node` in package.json.
 * Two copies of this number is how a client ends up passing doctor and then
 * failing `npm i -g` with a message about an unsupported engine.
 */
export const REQUIRED_NODE_MAJOR = 22;

export function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= REQUIRED_NODE_MAJOR) return check("Node", OK, `v${process.versions.node}`);
  return check(
    "Node",
    FAIL,
    `v${process.versions.node}, but ${REQUIRED_NODE_MAJOR} or newer is required`,
    IS_WIN
      ? "Install Node 22 LTS: winget install OpenJS.NodeJS.LTS\n  Then close this window and open a NEW terminal, or npm will not be on PATH yet."
      : "Install Node 22 LTS from nodejs.org, or: brew install node"
  );
}

/**
 * Round-trip the credential store, rather than confirming one exists.
 *
 * A store that accepts a write and cannot return it is the worst shape this
 * failure takes: setup reports success, the install looks finished, and the
 * client discovers it when they next need their brain. On Windows the value is
 * sealed with DPAPI CurrentUser through a compiled helper, so write and read
 * are genuinely separate things that can fail separately, and the failure that
 * was reported from the field was the read.
 *
 * This writes a published non-secret value into a private temporary directory
 * through the SAME functions a real admin key uses, reads it back, compares it
 * exactly, and removes it. It says which platform's store it exercised, because
 * a green line on macOS proves nothing at all about Windows.
 */
export function checkCredentialStore(options = {}) {
  const probe = (options.probe ?? probeCredentialStore)(options);
  const description = probe.description || credentialStoreDescription(options.platform);
  if (probe.ok) {
    return check(
      "Credential store",
      OK,
      `wrote a test value through ${description} and read back the same bytes`
    );
  }
  if (probe.stage === "setup") {
    return check(
      "Credential store",
      WARN,
      `the round trip could not be attempted: ${probe.error}`,
      "Nothing is known to be broken and nothing is known to be working. This needs a\n" +
        "  writable temporary directory; TMPDIR, TEMP or TMP is unset, full, or not writable.\n" +
        "  Fix that and re-run `brain doctor`, because the next thing to write here is the\n" +
        "  admin key and it will not get a second chance."
    );
  }
  const stageWords = {
    write: "could not store a test value",
    read: "stored a test value and then could not read it back",
    compare: "read back a different value than it stored",
  };
  const encrypted = probe.encrypted === true;
  return check(
    "Credential store",
    FAIL,
    `${stageWords[probe.stage] || "failed"} in ${description}: ${probe.error}`,
    (encrypted
      ? "This machine seals the admin key with Windows DPAPI for the current user, and that\n" +
        "  round trip just failed. Do NOT install on top of it: setup would report success and\n" +
        "  leave a key that cannot be read back.\n" +
        "  The usual causes, in the order worth checking:\n" +
        "    1. The helper is compiled into the temp directory and run from there. Software\n" +
        "       restriction, AppLocker or endpoint protection that blocks executables in TEMP\n" +
        "       stops this and nothing else on the machine.\n" +
        "    2. TEMP points through a redirected or roaming path. DPAPI CurrentUser needs the\n" +
        "       real loaded profile of the account running the command.\n" +
        "    3. The command is being run as a different account, or elevated, from the one that\n" +
        "       wrote the value. A DPAPI CurrentUser value belongs to one account only.\n" +
        "  Confirm the stage in isolation, with four fixed bytes and no credential:\n" +
        "      node test/fixtures/windows-dpapi-probe.mjs"
      : "The store could not return what it stored. Check that the temporary directory is\n" +
        "  writable, that this account owns it, and that no sync client or backup agent is\n" +
        "  rewriting files underneath it. Re-run `brain doctor` once it is fixed.")
  );
}

export function checkWrangler() {
  const r = run("npx", ["wrangler@4", "--version"], {
    timeout: 120_000,
    inheritEnv: false,
    env: localToolEnvironment(),
  });
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
 * Optional fallback for an older token that lacks Vectorize Edit.
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
  return cloudflareCliEnvironment(accountId);
}

export function checkWranglerLogin(accountId) {
  const env = cfEnv(accountId);
  const r = run("npx", ["wrangler@4", "whoami"], {
    timeout: 120_000,
    inheritEnv: false,
    env,
  });
  if (r.ok && /You are logged in|Account Name/i.test(r.out)) {
    const email = (r.out.match(/associated with the email ([^\s]+@[^\s]+?)[.\s]*$/im) || r.out.match(/([\w.+-]+@[\w-]+\.[\w.]+[\w])/) || [])[1];
    const accounts = (r.out.match(/│/g) || []).length;
    return check("wrangler login", OK, email ? `signed in as ${email}` : "signed in", accounts > 8 ? "this login can see several accounts, so account_id in the manifest is required" : undefined);
  }
  return check(
    "wrangler login",
    WARN,
    "not signed in",
    "Run: npx wrangler@4 login\n" +
      "  This opens the browser and the session belongs to whoever signs in.\n" +
      "  This is only a fallback when the scoped API token cannot reach Vectorize."
  );
}

export async function checkVectorizeApi(accountId, cloudflareToken = process.env.CLOUDFLARE_API_TOKEN) {
  const token = cloudflareToken;
  if (!token) {
    return check(
      "Vectorize",
      WARN,
      "not checked: Cloudflare token is missing",
      "Run `brain setup` or `brain update` in an interactive terminal for hidden token entry. " +
        "Low-level automation must inject it through an approved secret manager, never a pasted shell command.",
    );
  }
  if (!accountId) {
    return check(
      "Vectorize",
      WARN,
      "not checked: Cloudflare account id is not known yet",
      "Run `brain doctor <manifest>` after setup has written the account id. `brain verify` also probes it before provisioning."
    );
  }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* status below is enough */ }
    if (res.ok && payload?.success !== false) return check("Vectorize", OK, "reachable with the scoped API token");
    const detail = (payload?.errors || []).map((x) => x.message).filter(Boolean).join("; ") || `HTTP ${res.status}`;
    const paid = /workers paid|not entitled|upgrade|subscription|billing/i.test(detail);
    return check(
      "Vectorize",
      FAIL,
      paid ? "the account is not on the Workers Paid plan" : `token cannot reach it: ${detail.slice(0, 120)}`,
      VECTORIZE_REMEDY
    );
  } catch (e) {
    return check("Vectorize", FAIL, `probe failed: ${String(e.message).slice(0, 100)}`, VECTORIZE_REMEDY);
  }
}

export function checkVectorize(accountId) {
  const env = cfEnv(accountId);
  const r = run("npx", ["wrangler@4", "vectorize", "list"], {
    timeout: 120_000,
    inheritEnv: false,
    env,
  });
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
    "Recreate the scoped token with Vectorize: Edit, then re-run. Workers Paid\n" +
      "  (5 USD monthly minimum) is the supported production baseline because Free\n" +
      "  has prototype-scale vector, daily-write, and Worker CPU limits.\n" +
      "  Confirm the plan separately in Cloudflare dashboard > Workers & Pages > Plans.\n" +
      "  Without it the brain can only match documents that repeat the words in the question."
  );
}

export function checkClaudeCode() {
  const r = run("claude", ["--version"], {
    timeout: 30_000,
    inheritEnv: false,
    env: localToolEnvironment(),
  });
  if (r.ok) return check("Claude Code", OK, (r.out.trim().split("\n")[0] || "present").slice(0, 40));
  return check(
    "Claude Code",
    WARN,
    "not found on PATH",
    "Optional, but it is how most people will actually use the brain.\n  Install from claude.com/claude-code, then re-run `brain doctor`."
  );
}

export function checkCodex() {
  const r = run("codex", ["--version"], {
    timeout: 30_000,
    inheritEnv: false,
    env: localToolEnvironment(),
  });
  if (r.ok) return check("Codex", OK, (r.out.trim().split("\n")[0] || "present").slice(0, 40));
  return check("Codex", WARN, "not found on PATH", "Optional. Install it if the client uses Codex; setup wires up whichever is present.");
}

export function checkAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return check("Anthropic key", OK, "present in the environment");
  return check(
    "Answer model",
    OK,
    "Cloudflare Workers AI is the standard; no external model key is required"
  );
}

export function checkGoogleConnection(storageStatus) {
  const stored = storageStatus ?? tokenStorageStatus();
  if (stored.exists && (stored.migrationPending || stored.backend === "legacy-file")) {
    const windowsLegacy = stored.migrationPending === true || /Windows|DPAPI/i.test(stored.description || "");
    return check(
      "Google connection",
      WARN,
      `token still uses legacy plaintext storage in ${stored.description}`,
      windowsLegacy
        ? "The next Drive, Gmail, or Calendar use migrates a still-valid token to a DPAPI-encrypted file for this Windows user. If Google rejects the old token, reconnect with `brain connect google`."
        : "The next Drive, Gmail, or Calendar use migrates a still-valid token to this Mac's login Keychain. If Google rejects the old token, reconnect with `brain connect google`."
    );
  }
  if (stored.exists) return check("Google connection", OK, `token stored in ${stored.description}`);
  if (stored.error) {
    return check(
      "Google connection",
      WARN,
      "credential storage could not be checked",
      `${stored.error}\n  No credential value was read or printed.`
    );
  }
  return check(
    "Google connection",
    WARN,
    "not connected",
    "Only needed to ingest from Drive or Gmail. A local folder works without it.\n  Connect with: brain connect google --scopes drive,gmail"
  );
}

/**
 * The scoped API token drives every Cloudflare step. Wrangler login is only a
 * fallback for an older or incorrectly scoped token.
 */
export function checkCfToken(cloudflareToken = process.env.CLOUDFLARE_API_TOKEN) {
  // Presence, and only presence. This says nothing about whether Cloudflare
  // accepts the token or whether it carries the scopes the install needs, so it
  // must not be worded as if it did. `brain preinstall` proves both.
  if (cloudflareToken) return check("Cloudflare token", OK,
    "present in this environment (not yet proven against Cloudflare; run `brain preinstall`)");
  return check(
    "Cloudflare token",
    FAIL,
    "CLOUDFLARE_API_TOKEN is not set",
    "Create one in the CLIENT's account: dash.cloudflare.com > My Profile > API Tokens.\n" +
      `  Scopes: ${CF_TOKEN_SCOPES.join(", ")}.
` +
      "  Set \'Expires on\' to tomorrow. Nothing here needs to outlive the install.\n" +
      "  Then run `brain setup` or `brain update` in an interactive terminal; it asks for the token without echo.\n" +
      "  Low-level automation must inject it through an approved secret manager, never a pasted shell command.\n" +
      VECTORIZE_REMEDY
  );
}

/**
 * Where a bank returns the account holder's browser after they authorise.
 *
 * Must equal `redirectUriFor()` in `worker/src/lib/bank-feed.js`. The two live
 * in different runtimes — this one runs on the operator's laptop, that one runs
 * in the client's worker — so they are two constants, and
 * `test/bank-feed-secrets.test.mjs` fails if they ever drift apart.
 */
export const BANK_FEED_REDIRECT_PATH = "/app/connect/bank";

export function bankFeedRedirectUri(domain) {
  const host = String(domain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}${BANK_FEED_REDIRECT_PATH}`;
}

/**
 * The check that has to happen BEFORE an operator is sitting with a client.
 *
 * A bank's own login page bounces the browser out and back, and the address it
 * comes back to must be REGISTERED WITH THE PROVIDER IN ADVANCE. Every brain
 * has its own hostname, so every install needs its own registration, and the
 * failure mode is the worst kind: the client authorises at their bank, the bank
 * returns them, and the last step dies. In front of them, mid-session, with
 * nothing to do about it for however long a dashboard edit takes to propagate.
 *
 * So this is a doctor check and not a runtime error. It is offline on purpose:
 * it needs no credential and no network, which means it runs in the quiet hour
 * before the session rather than during it.
 */
export function checkBankFeedRedirect(manifest) {
  const feed = manifest?.corpora?.bank_feed;
  if (!feed?.enabled) return check("Bank feed", OK, "not in use on this brain");

  const domain = manifest?.brain?.domain;
  if (!domain) {
    return check(
      "Bank feed", WARN,
      "this brain has no address yet, so its return address cannot be checked",
      "  Run `brain deploy <manifest>` first. It saves the live address, and this\n" +
      "  check can then tell you the exact return address to register."
    );
  }

  const required = bankFeedRedirectUri(domain);
  const declared = Array.isArray(feed.registered_redirect_uris) ? feed.registered_redirect_uris : [];
  const missingConfig = [
    !feed.api_base && "corpora.bank_feed.api_base",
    !feed.link_sdk_url && "corpora.bank_feed.link_sdk_url",
    !feed.link_global && "corpora.bank_feed.link_global",
  ].filter(Boolean);

  if (!declared.includes(required)) {
    return check(
      "Bank feed", FAIL,
      "the return address for this brain is not recorded as registered",
      "  Register this exact address with the bank-data provider, in the CLIENT'S OWN\n" +
      "  provider dashboard, before the session:\n\n" +
      `      ${required}\n\n` +
      "  Then record it in the manifest so this check can confirm it:\n" +
      `      corpora.bank_feed.registered_redirect_uris: ["${required}"]\n\n` +
      "  Skip this and the client will authorise successfully at their bank and then\n" +
      "  land on a dead return, with you sitting next to them."
    );
  }
  if (missingConfig.length) {
    return check(
      "Bank feed", WARN,
      `return address registered; ${missingConfig.length} setting(s) still undeclared`,
      `  Add to the manifest: ${missingConfig.join(", ")}.\n` +
      "  Without them the worker has no provider host and the connect page has no\n" +
      "  library to load, so the connect button does nothing."
    );
  }
  const environment = feed.environment === "production" ? "production" : "sandbox";
  return check(
    "Bank feed", OK,
    `${environment}; return address registered (${required})`,
    environment === "sandbox"
      ? "  Sandbox is right for a rehearsal, and it is what lets an install be practised\n" +
        "  the same day. Switch to production once the client's own provider approval\n" +
        "  lands, and register the same return address in that environment too."
      : undefined
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
export async function runAll({ accountId, onResult, googleStorageStatus, cloudflareToken } = {}) {
  // checkVectorize's own remedy says `export CLOUDFLARE_ACCOUNT_ID=...`, and until
  // now nothing read it back: `brain doctor` sourced the id from a manifest only,
  // so a pre-install machine had no way to make the Vectorize probe run at all.
  // Someone who followed the printed instruction still got "not checked".
  const account = accountId || process.env.CLOUDFLARE_ACCOUNT_ID || undefined;
  const out = [];
  // Each result is handed to the caller the moment it exists, so a slow check
  // shows the ones before it rather than holding the whole report hostage.
  const push = (x) => {
    out.push(x);
    if (onResult) onResult(x);
    return x;
  };
  // EVERY result goes through push(). Six of these eight used to call out.push()
  // directly, so the streaming renderer never saw them: a bare machine printed
  // Node and Network and nothing else, and the operator had no line at all for
  // the token, Vectorize, Claude Code, Codex or Google. Silence read as "did not
  // run" when the checks had in fact run and one of them had failed.
  push(checkNode());
  push(checkCredentialStore());
  push(await checkNetwork());
  push(checkCfToken(cloudflareToken));
  push(await checkVectorizeApi(account, cloudflareToken));
  push(checkAnthropicKey());
  push(checkClaudeCode());
  push(checkCodex());
  push(checkGoogleConnection(googleStorageStatus));
  return out;
}

export function summarize(checks) {
  return {
    fatal: checks.filter((c) => c.status === FAIL).length,
    warnings: checks.filter((c) => c.status === WARN).length,
    ok: checks.filter((c) => c.status === OK).length,
  };
}

/* ======================================================================== */
/* PRE-INSTALL MODE                                                          */
/* ======================================================================== */

/**
 * WHY THIS EXISTS, SEPARATELY FROM EVERYTHING ABOVE
 *
 * Installs run on the CLIENT's own computer now. That machine has no manifest,
 * no install, and nothing of ours on it, and it is the machine whose problems
 * cost the most, because they surface with the client sitting next to you.
 *
 * The checks above were written on the far side of that line. Three of them
 * measured, on a bare machine, on 2026-08-28:
 *
 *   - The Cloudflare account id reached `checkVectorizeApi` as undefined every
 *     time, because `cmdDoctor` sourced it from a manifest and there was no
 *     manifest. The token-scope probe was therefore not "skipped for now", it
 *     was structurally unreachable: no sequence of operator actions could make
 *     it run. Following doctor's own printed remedy and exporting
 *     CLOUDFLARE_ACCOUNT_ID did not help, because nothing read it back.
 *   - `checkCfToken` returned ok for any non-empty string. A token that was
 *     expired, revoked, mistyped, or scoped to the wrong account reported
 *     "available for this command".
 *   - Put together: a machine holding a garbage token and an exported account
 *     id printed "ready to install" and exited 0.
 *
 * That last line is the defect. A report that is green on a machine which will
 * fail the install is worse than no report, because it is believed.
 *
 * THE RULE THIS MODE IS BUILT ON
 *
 * Three outcomes are not two. PASSED means it was checked and it is good.
 * FAILED means it was checked and it is bad. CANNOT CHECK means the answer is
 * unknown from here, and it is a first-class outcome carrying a named manual
 * step, never quietly folded into either of the others. Anything that cannot be
 * verified automatically says so and says where to look instead.
 */

/** The fourth status. Not a warning, not a pass: an admission. */
export const CANNOT_CHECK = "cannot-check";

/** Every status this module can emit, for callers that render them. */
export const STATUSES = Object.freeze([OK, WARN, FAIL, CANNOT_CHECK]);

/**
 * A check that could not run carries the manual step in `manual`, and
 * `assertHonest` below refuses to let one exist without it.
 */
const cannotCheck = (name, detail, manual) => ({ name, status: CANNOT_CHECK, detail, manual });

/* --------------------------------------------------------- the platform */

/**
 * What each operating system actually gets.
 *
 * Two different things get called "macOS only" in this codebase and they must
 * not be reported the same way, because one of them can be fixed by us and the
 * other never can:
 *
 *   permanent  Apple exposes message history only through ~/Library/Messages/
 *              chat.db. No amount of engineering puts live iMessage capture on
 *              Windows. A client on Windows must be told this before they buy
 *              the expectation, not on install day.
 *   installer  The capability exists and the supervision does not. Unattended
 *              refresh is implemented with macOS LaunchAgents (assertMac in
 *              operations/drive-scheduler.mjs, folder-scheduler.mjs,
 *              imessage-scheduler.mjs, whatsapp-daemon.mjs and
 *              whatsapp-drain-scheduler.mjs all throw off darwin). The WhatsApp
 *              daemon itself cross-compiles for Windows.
 *
 * The consequence line is what the operator reads out loud. It says what the
 * client loses in their own terms, not in ours.
 */
export const PLATFORM_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "imessage_live",
    label: "Live iMessage capture",
    macOnly: true,
    kind: "permanent",
    consequence:
      "Message history cannot be captured live on this machine. Apple keeps it in " +
      "~/Library/Messages/chat.db, which exists on macOS and nowhere else.",
    fallback: {
      darwin: null,
      win32: "One-time load from an unencrypted local iPhone backup: brain ingest <manifest> --from iphone-backup. " +
        "iTunes, the Apple Devices app and the Microsoft Store build are all found automatically.",
      other: "One-time load from an unencrypted iPhone backup copied onto this machine, pointed at explicitly. " +
        "There is no Apple backup software for Linux, so no default location is searched.",
    },
  }),
  Object.freeze({
    id: "unattended_refresh",
    label: "Unattended refresh (Drive, watched folder, curated sync, message capture)",
    macOnly: true,
    kind: "installer",
    consequence:
      "Nothing refreshes on its own. The brain answers from whatever was last loaded " +
      "into it, and it will report itself healthy while going stale, because being " +
      "out of date is not an error state.",
    fallback: {
      darwin: null,
      win32: "Someone must run `brain load <manifest>` by hand on a schedule the client agrees to, " +
        "or drive it from Task Scheduler. Agree that cadence before install day and write it down.",
      other: "Someone must run `brain load <manifest>` by hand on a schedule the client agrees to, " +
        "or drive it from cron/systemd. Agree that cadence before install day and write it down.",
    },
  }),
  Object.freeze({
    id: "whatsapp_capture",
    label: "WhatsApp capture",
    macOnly: true,
    kind: "installer",
    consequence:
      "Cannot be installed from here. The capture daemon is kept alive by a per-user " +
      "LaunchAgent and no equivalent supervision is built for this platform yet.",
    fallback: {
      darwin: null,
      win32: "Use an exported WhatsApp chat archive instead: brain ingest <manifest> --from whatsapp " +
        "reads exports without the live daemon.",
      other: "Use an exported WhatsApp chat archive instead: brain ingest <manifest> --from whatsapp " +
        "reads exports without the live daemon.",
    },
  }),
  Object.freeze({
    id: "keychain_secrets",
    label: "Secrets in the operating system keystore",
    macOnly: true,
    kind: "installer",
    consequence:
      "The admin key cannot live in a keystore here, and the Cloudflare token is not " +
      "remembered between commands, so it is asked for every time.",
    fallback: {
      darwin: null,
      win32: "The admin key falls back to a permission-restricted file next to the manifest. " +
        "Decide with the client where that file lives and who can read it.",
      other: "The admin key falls back to a permission-restricted file next to the manifest. " +
        "Decide with the client where that file lives and who can read it.",
    },
  }),
]);

/**
 * Where the Google refresh token ends up at rest, per platform.
 *
 * Established in connectors/google-auth.mjs: storageBackend() picks the login
 * Keychain on darwin and a file everywhere else, and writeFileStore() encrypts
 * that file with DPAPI only when platform === "win32". So on Linux the token is
 * a plain file protected by permissions alone. That is a real property of the
 * install and the client is entitled to hear it before they authorise Google,
 * not after.
 */
export const GOOGLE_TOKEN_AT_REST = Object.freeze({
  darwin: "this Mac's login Keychain",
  win32: "a DPAPI-encrypted file readable only by this Windows user account",
  other: "a plain file on disk, protected by file permissions only (no OS encryption on this platform)",
});

const platformKey = (p) => (p === "darwin" || p === "win32" ? p : "other");

export function platformLabel(p = platform()) {
  return { darwin: "macOS", win32: "Windows", linux: "Linux" }[p] || p;
}

/** Everything this OS does and does not get, as data. */
export function platformReadiness(p = platform()) {
  const key = platformKey(p);
  const unavailable = PLATFORM_CAPABILITIES
    .filter((cap) => cap.macOnly && p !== "darwin")
    .map((cap) => ({ ...cap, fallback: cap.fallback[key] ?? cap.fallback.other }));
  return {
    platform: p,
    label: platformLabel(p),
    supported: true,
    unavailable,
    googleTokenAtRest: GOOGLE_TOKEN_AT_REST[key],
    // doctor.mjs's own run() carries Windows-specific handling that its author
    // marked NOT YET RUN ON WINDOWS. Reporting a green Windows run without that
    // caveat would be the same false confidence this whole mode exists to stop.
    untestedHost: p === "win32",
  };
}

export function checkOperatingSystem(p = platform()) {
  const r = platformReadiness(p);
  if (!r.unavailable.length) {
    return check("Operating system", OK, `${r.label}; every capability is available on this platform`);
  }
  const lines = r.unavailable.map((cap) =>
    `  ${cap.label}\n` +
    `    ${cap.kind === "permanent"
      ? "NOT POSSIBLE on this platform, ever."
      : "Not installable from here (the capability exists; the supervision for it does not)."}\n` +
    `    ${cap.consequence}\n` +
    `    Instead: ${cap.fallback}`);
  return check(
    "Operating system",
    WARN,
    `${r.label}; ${r.unavailable.length} capability area(s) unavailable on this platform`,
    "Tell the client all of this BEFORE install day, not during it:\n\n" +
      lines.join("\n\n") +
      `\n\n  Google credentials on this platform are stored in ${r.googleTokenAtRest}.` +
      (r.untestedHost
        ? "\n\n  Also: this installer's Windows command handling is written from the documented\n" +
          "  platform behaviour and has not been exercised on a real Windows host. Budget\n" +
          "  extra time and do a dry run on the client's own machine before the session."
        : "")
  );
}

/* ------------------------------------------------- Cloudflare, for real */

/**
 * Every Cloudflare surface the install touches, in the order provision touches
 * it, with the scope that grants it.
 *
 * ORDER IS THE POINT. cmdProvision creates the D1 database first (brain.mjs),
 * then R2, and only then contacts Vectorize. A token missing Vectorize: Edit
 * therefore fails AFTER a database exists in the client's account, which is the
 * worst possible ordering: half-built infrastructure, in front of the client,
 * with a permission fix that has to be made in a browser. Probing all of them
 * up front, in a quiet hour, is the entire remedy.
 */
export const CF_SCOPE_PROBES = Object.freeze([
  Object.freeze({
    name: "D1",
    scope: "D1: Edit",
    path: (id) => `/accounts/${id}/d1/database`,
    required: true,
    why: "The brain's documents, chunks and ledger live in D1. Nothing installs without it.",
  }),
  Object.freeze({
    name: "Workers Scripts",
    scope: "Workers Scripts: Edit",
    path: (id) => `/accounts/${id}/workers/scripts`,
    required: true,
    why: "The worker itself, its secrets, its workers.dev route and its drain cron are all written through this scope.",
  }),
  Object.freeze({
    name: "Vectorize",
    scope: "Vectorize: Edit",
    path: (id) => `/accounts/${id}/vectorize/v2/indexes`,
    required: true,
    why: "Meaning-based search. Provision reaches this AFTER creating D1, so a missing scope " +
      "strands a half-built install. Without Vectorize the brain can only find documents that " +
      "repeat the words of the question, and it degrades quietly rather than erroring.",
  }),
  Object.freeze({
    name: "Workers AI",
    scope: "Workers AI: Read",
    path: (id) => `/accounts/${id}/ai/models/search`,
    required: true,
    why: "The embedding and answering models. This is the standard answer path; no external model key is used.",
  }),
  Object.freeze({
    name: "R2",
    scope: "Workers R2 Storage: Edit",
    path: (id) => `/accounts/${id}/r2/buckets`,
    required: false,
    why: "Optional storage. R2 also needs separate activation in the dashboard, which asks for a " +
      "payment method even on the free tier, and that is a common mid-install surprise.",
  }),
]);

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfProbe(path, token, { fetchImpl = fetch, timeout = 20_000 } = {}) {
  try {
    const res = await fetchImpl(`${CF_API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* status is enough */ }
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    return {
      reached: true,
      ok: res.ok && payload?.success !== false,
      status: res.status,
      codes: errors.map((e) => e?.code).filter((x) => x !== undefined),
      message: errors.map((e) => e?.message).filter(Boolean).join("; ") || `HTTP ${res.status}`,
      payload,
    };
  } catch (e) {
    return { reached: false, ok: false, status: 0, codes: [], message: String(e?.message || e), payload: null };
  }
}

/**
 * The token's own identity, which has to be settled before any scope verdict is
 * possible.
 *
 * Measured against the live API on 2026-08-28. A per-resource probe with a bad
 * token returns HTTP 401 `code 10000, "Authentication error"` — the exact
 * response a VALID token gets when it lacks that one scope. The two are
 * indistinguishable at the resource, and this codebase's own history records
 * that ambiguity being misread as a platform limitation.
 *
 * `GET /accounts` resolves it. A well-formed but invalid token gets HTTP 403
 * `code 9109, "Invalid access token"`; a malformed one gets HTTP 400
 * `code 6003 / 6111, "Invalid format for Authorization header"`. So once
 * /accounts answers 200, a 10000 anywhere else is a SCOPE verdict and can be
 * reported as one instead of as a shrug.
 */
export async function checkCloudflareIdentity(token, options = {}) {
  if (!token) {
    return {
      check: check(
        "Cloudflare token", FAIL,
        "no token is available on this machine",
        "Create one in the CLIENT's own account: dash.cloudflare.com > My Profile > API Tokens.\n" +
          `  Scopes: ${CF_TOKEN_SCOPES.join(", ")}.\n` +
          "  Set 'Expires on' to tomorrow; nothing here needs to outlive the install.\n" +
          "  Then run `brain setup` or `brain update` in an interactive terminal, which asks for it\n" +
          "  without echo. Automation must inject it from an approved secret manager, never a\n" +
          "  pasted shell command."
      ),
      accounts: null,
    };
  }
  const r = await cfProbe("/accounts", token, options);
  if (!r.reached) {
    return {
      check: cannotCheck(
        "Cloudflare token",
        `the token could not be tested: ${r.message.slice(0, 100)}`,
        "This machine could not reach api.cloudflare.com, so the token is neither proven good\n" +
          "  nor proven bad. Clear the network problem above and run `brain preinstall` again.\n" +
          "  Do NOT treat the token as working until this line says PASS."
      ),
      accounts: null,
    };
  }
  if (!r.ok) {
    const malformed = r.codes.includes(6003) || r.codes.includes(6111);
    return {
      check: check(
        "Cloudflare token", FAIL,
        malformed
          ? "Cloudflare rejected the token's format (it is truncated, wrapped, or has stray characters)"
          : `Cloudflare rejected the token: ${r.message.slice(0, 90)}`,
        malformed
          ? "The value reaching this process is not a whole token. Re-enter it through\n" +
            "  `brain setup` or `brain update`, which reads it without echo and without a\n" +
            "  shell mangling quotes or newlines."
          : "The token is expired, revoked, or was created in a different account than the one\n" +
            "  being installed into. Create a fresh one in the CLIENT's account:\n" +
            `  dash.cloudflare.com > My Profile > API Tokens, scopes: ${CF_TOKEN_SCOPES.join(", ")}.`
      ),
      accounts: null,
    };
  }
  const accounts = Array.isArray(r.payload?.result) ? r.payload.result : [];
  return {
    check: check(
      "Cloudflare token", OK,
      `accepted by Cloudflare; it can see ${accounts.length} account(s)`
    ),
    accounts,
  };
}

/**
 * Which account this install goes into.
 *
 * A token that can see several accounts and no id to choose between them is not
 * a failure and must not be reported as one: nothing is broken, a decision is
 * simply missing. But it does stop every scope probe below, so it cannot be
 * reported as a pass either.
 */
export function resolveCloudflareAccount({ accountId, accounts, environment = process.env } = {}) {
  const chosen = accountId || environment?.CLOUDFLARE_ACCOUNT_ID || null;
  const list = Array.isArray(accounts) ? accounts : [];
  if (chosen) {
    const named = list.find((a) => a?.id === chosen);
    if (list.length && !named) {
      return {
        accountId: null,
        check: check(
          "Cloudflare account", FAIL,
          `account ${chosen} was named, but this token cannot see it`,
          "Either the id is wrong or the token belongs to somebody else's account. This token sees:\n" +
            list.map((a) => `    ${a.id}  ${a.name}`).join("\n") +
            "\n  Installing into the wrong account creates real resources in it. Settle this first."
        ),
      };
    }
    return {
      accountId: chosen,
      check: check("Cloudflare account", OK, named ? `${chosen} (${named.name})` : chosen),
    };
  }
  if (list.length === 1) {
    return {
      accountId: list[0].id,
      check: check("Cloudflare account", OK, `${list[0].id} (${list[0].name}) — the only one this token can see`),
    };
  }
  if (list.length > 1) {
    return {
      accountId: null,
      check: cannotCheck(
        "Cloudflare account",
        `this token can see ${list.length} accounts and nothing says which one to install into`,
        "Nothing is wrong yet, but every permission check below is blocked until this is settled.\n" +
          "  Confirm with the client which account is theirs, then re-run:\n" +
          "      export CLOUDFLARE_ACCOUNT_ID='<the account id>'\n" +
          "      brain preinstall\n" +
          "  This token can see:\n" +
          list.map((a) => `    ${a.id}  ${a.name}`).join("\n"),
      ),
    };
  }
  return {
    accountId: null,
    check: cannotCheck(
      "Cloudflare account",
      "no account could be resolved, so the permission checks below cannot run",
      "Set the client's account id and re-run:\n" +
        "      export CLOUDFLARE_ACCOUNT_ID='<the account id>'\n" +
        "      brain preinstall",
    ),
  };
}

/**
 * One line per Cloudflare surface the install will touch.
 *
 * A read probe proves READ. It does not prove EDIT, and this function does not
 * pretend otherwise — see checkEditPermissions below, which states that limit
 * once, loudly, instead of burying a caveat in five passing lines.
 */
export async function checkCloudflareScopes(token, accountId, options = {}) {
  return Promise.all(CF_SCOPE_PROBES.map(async (probe) => {
    if (!token || !accountId) {
      return cannotCheck(
        probe.name,
        accountId ? "no token to test with" : "no Cloudflare account resolved yet",
        `${probe.why}\n  Settle the token and account lines above, then re-run \`brain preinstall\`.\n` +
          `  Until then nobody knows whether this install has ${probe.scope}.`,
      );
    }
    const r = await cfProbe(probe.path(accountId), token, options);
    if (!r.reached) {
      return cannotCheck(
        probe.name,
        `the probe did not complete: ${r.message.slice(0, 90)}`,
        `${probe.why}\n  Re-run when the network is stable. Confirm by hand meanwhile:\n` +
          `  dash.cloudflare.com > My Profile > API Tokens > the install token > Edit, and read\n` +
          `  its permission list for "${probe.scope}".`,
      );
    }
    if (r.ok) {
      // "read access confirmed" and not "the scope is present": a passing list
      // proves Read, and Edit is unprovable from here. checkEditPermissions
      // carries that caveat as its own line so it cannot be skimmed past.
      return check(probe.name, OK, "reachable with this token — read access confirmed, Edit not provable from here");
    }
    const plan = /workers paid|not entitled|upgrade|subscription|billing|payment/i.test(r.message);
    const notEnabled = probe.name === "R2" && /not enabled|disabled|activate/i.test(r.message);
    if (notEnabled || (probe.name === "R2" && plan)) {
      return check(
        probe.name, WARN,
        `not available: ${r.message.slice(0, 90)}`,
        "R2 is optional and the brain runs without it, so this does not block the install.\n" +
          "  If the client wants it, R2 must be activated in their dashboard first, and\n" +
          "  Cloudflare asks for a payment method even on the free tier. That is a browser\n" +
          "  step somebody has to do, so do it before install day, not during."
      );
    }
    // The token was already proven valid at /accounts, so a rejection here is
    // about permission, not identity. Saying so is the whole gain.
    const scopeVerdict = r.codes.includes(10000) || r.status === 401 || r.status === 403;
    return check(
      probe.name,
      probe.required ? FAIL : WARN,
      scopeVerdict
        ? `the token is valid but cannot reach it — ${probe.scope} is missing`
        : `unreachable: ${r.message.slice(0, 90)}`,
      `${probe.why}\n` +
        `  Add ${probe.scope} to the install token, or recreate it with the full set:\n` +
        `  ${CF_TOKEN_SCOPES.join(", ")}.\n` +
        "  dash.cloudflare.com > My Profile > API Tokens.\n" +
        (probe.name === "Vectorize"
          ? "  Fix this BEFORE running provision. Provision creates the D1 database first and\n" +
            "  only then contacts Vectorize, so discovering it later leaves a half-built\n" +
            "  install in the client's account.\n" + VECTORIZE_REMEDY
          : "")
    );
  }));
}

/**
 * The limit of every probe above, said once and said plainly.
 *
 * Cloudflare exposes no API that reports an account-scoped token's own
 * permission list. `GET /user/tokens` needs a scope the install token will never
 * carry, and `GET /user/tokens/verify` returns status only — and 401s outright
 * for account-owned tokens. So a successful list proves Read and cannot prove
 * Edit, and the only place the Edit grant is legible is the dashboard.
 *
 * Reporting five green lines and staying silent about that would be precisely
 * the false green this mode exists to prevent.
 */
export function checkEditPermissions() {
  return cannotCheck(
    "Edit permissions",
    "read access can be proven from here; write access cannot",
    "Cloudflare has no API that reports a token's own permission list, so nothing on this\n" +
      "  machine can tell Read from Edit. A probe above passing means the token can LIST that\n" +
      "  resource, not that it can CREATE in it.\n" +
      "  Confirm by eye, once, before install day:\n" +
      "      dash.cloudflare.com > My Profile > API Tokens > the install token > Edit\n" +
      `  Every line must read Edit, not Read: ${CF_TOKEN_SCOPES.join(", ")}.\n` +
      "  A token with Read where Edit belongs passes every check on this page and then fails\n" +
      "  during provision, after resources already exist."
  );
}

/**
 * The paid tier, which genuinely cannot be read from here.
 *
 * Plan and subscription endpoints need Billing: Read, a scope the install token
 * has no business carrying and which nobody should add just to satisfy a check.
 * So this is an honest CANNOT CHECK with an exact place to look, rather than an
 * inference dressed up as a result.
 */
export function checkWorkersPaidPlan() {
  return cannotCheck(
    "Workers Paid plan",
    "the account's plan cannot be read with an install-scoped token",
    "Reading the plan needs Billing: Read, which this token should not have and which nobody\n" +
      "  should add just to make this line green.\n" +
      "  Look once, before install day, in the CLIENT's account:\n" +
      "      dash.cloudflare.com > Workers & Pages > Plans\n" +
      "  Workers Paid (5 USD per month minimum) is the supported production baseline. The Free\n" +
      "  plan can create a Vectorize index, so provision will appear to succeed on it; its\n" +
      "  vector, daily-write and Worker CPU limits are prototype-scale and hard-stop a real\n" +
      "  corpus later, once the client has already put their documents in."
  );
}

/* --------------------------------------- checks that need an install */

/**
 * The checks that genuinely cannot run yet, listed rather than omitted.
 *
 * Every one of these reads a DEPLOYED brain or a written manifest, so on a bare
 * machine there is nothing for them to read. That is a fact about the machine,
 * not a defect — but leaving them off the page entirely lets an operator finish
 * this report believing the bank-feed return address has been checked when no
 * such check has ever run on this machine.
 */
export const INSTALL_STATE_CHECKS = Object.freeze([
  Object.freeze({
    name: "Bank feed return address",
    needs: "a deployed brain with an address",
    afterwards: "brain doctor <manifest>",
    why: "The bank sends the client's browser back to an address that must be registered with the " +
      "provider in advance. Unregistered, the client authorises at their bank and lands on a dead " +
      "page, mid-session, with nothing to do about it.",
  }),
  Object.freeze({
    name: "Migration state",
    needs: "a provisioned D1 database",
    afterwards: "brain doctor <manifest>",
    why: "Detects a brain stuck part-way through an upgrade, and an applied migration whose file has since changed.",
  }),
  Object.freeze({
    name: "Live brain health",
    needs: "a deployed worker",
    afterwards: "brain health <manifest>",
    why: "Proves the deployed brain actually answers, rather than merely existing.",
  }),
]);

export function checkInstallStateChecks(hasManifest = false) {
  if (hasManifest) return [];
  return INSTALL_STATE_CHECKS.map((item) => cannotCheck(
    item.name,
    `needs ${item.needs}; there is no install on this machine yet`,
    `${item.why}\n  Not a problem now, and not something to skip later. Run this the moment the\n` +
      `  install exists, before the client session:\n      ${item.afterwards}`,
  ));
}

/* ----------------------------------------------------------- the runner */

/**
 * A check that admits it could not run MUST say what to do instead. This is the
 * rule the whole mode rests on, so it is enforced in code rather than trusted.
 */
export function assertHonest(checks) {
  const silent = checks.filter((x) => x.status === CANNOT_CHECK && !String(x.manual || "").trim());
  if (silent.length) {
    throw new Error(
      `a check reported CANNOT CHECK without naming a manual step: ${silent.map((x) => x.name).join(", ")}`
    );
  }
  return checks;
}

/**
 * The one command an operator runs on the client's laptop, days early.
 *
 * Deliberately needs no manifest, no install, and no argument. Everything that
 * touches the network is injectable so the tests can drive a missing scope, a
 * rejected token and an unreachable API without one of them being a live call.
 */
export async function runPreinstall({
  cloudflareToken = process.env.CLOUDFLARE_API_TOKEN,
  accountId,
  environment = process.env,
  osPlatform = platform(),
  hasManifest = false,
  googleStorageStatus,
  fetchImpl,
  onResult,
  includeWrangler = true,
  // Injected so the tests can drive a rejected token, a missing scope and an
  // unreachable API without any of them being a live call or a 120-second npx
  // fetch. Production passes none of these and gets the real thing.
  networkCheck = checkNetwork,
  storeCheck = checkCredentialStore,
  toolChecks = [checkClaudeCode, checkCodex],
} = {}) {
  const out = [];
  const push = (x) => { out.push(x); if (onResult) onResult(x); return x; };
  const probeOptions = fetchImpl ? { fetchImpl } : {};

  push(checkNode());
  push(checkOperatingSystem(osPlatform));
  push(storeCheck());
  push(await networkCheck());

  const identity = await checkCloudflareIdentity(cloudflareToken, probeOptions);
  push(identity.check);

  const account = resolveCloudflareAccount({
    accountId,
    accounts: identity.accounts,
    environment,
  });
  // Only meaningful once the token itself is settled; otherwise it repeats the
  // same bad news in different words.
  if (identity.accounts) push(account.check);

  for (const c of await checkCloudflareScopes(
    identity.accounts ? cloudflareToken : null,
    identity.accounts ? account.accountId : null,
    probeOptions,
  )) push(c);

  push(checkEditPermissions());
  push(checkWorkersPaidPlan());
  if (includeWrangler) push(checkWrangler());
  for (const tool of toolChecks) push(tool());
  push(checkGoogleConnection(googleStorageStatus));
  for (const c of checkInstallStateChecks(hasManifest)) push(c);

  return assertHonest(out);
}

export function summarizePreinstall(checks) {
  return {
    fatal: checks.filter((c) => c.status === FAIL).length,
    warnings: checks.filter((c) => c.status === WARN).length,
    unchecked: checks.filter((c) => c.status === CANNOT_CHECK).length,
    ok: checks.filter((c) => c.status === OK).length,
  };
}

/** Non-zero only for things actually known to be broken. */
export function preinstallExitCode(checks) {
  const s = summarizePreinstall(checks);
  // Three outcomes, not two, because the shell has to be able to tell the same
  // three apart that the screen does. The printed report already distinguishes
  // CANNOT CHECK from PASS, but `brain preinstall && <do the install>` reads
  // only this number, and returning 0 while items went unverified is exactly
  // the "a check that could not run looked like a check that passed" defect
  // this command exists to prevent, moved from the screen to the exit code.
  //   0  nothing failed and nothing went unchecked
  //   1  a real blocker: do not travel to this install
  //   2  no blocker found, but something could not be verified from here
  // Two is deliberately not zero: on a real pre-install machine the Edit
  // permission and the paid plan are never verifiable, so 2 is the BEST
  // obtainable result and a caller that wants to proceed on it must say so.
  if (s.fatal) return 1;
  if (s.unchecked) return 2;
  return 0;
}

/**
 * The verdict line.
 *
 * "Ready to install" is reserved for a run where nothing failed AND nothing went
 * unchecked. The instant one item could not be verified, the wording changes,
 * because the operator is going to quote this line to somebody.
 */
export function preinstallVerdict(checks) {
  const s = summarizePreinstall(checks);
  if (s.fatal) {
    return {
      ready: false,
      headline: `NOT READY — ${s.fatal} blocker(s) will fail this install`,
      note: "Fix every BLOCKER above, then run `brain preinstall` again.",
    };
  }
  if (s.unchecked) {
    return {
      ready: false,
      headline: `NO BLOCKERS FOUND — but ${s.unchecked} item(s) could NOT be checked from this machine`,
      note: "This is not a green light. Do each manual step listed under CANNOT CHECK before\n" +
        "install day; any one of them can still stop the install in front of the client.",
    };
  }
  return {
    ready: true,
    headline: "READY — everything this machine can check is in place",
    note: "Nothing here was skipped and nothing was assumed.",
  };
}

const STATUS_TAG = Object.freeze({
  [OK]: "PASS",
  [FAIL]: "FAIL",
  [WARN]: "WARN",
  [CANNOT_CHECK]: "CANNOT CHECK",
});

export function statusTag(status) {
  return STATUS_TAG[status] || String(status).toUpperCase();
}

/**
 * The report, as text.
 *
 * Plain words, not colour. The operator pastes this into a message to the
 * client or into a ticket, and a distinction carried only by an escape code
 * does not survive that trip. FAIL and CANNOT CHECK have to remain
 * distinguishable in a copy-paste, on a monochrome terminal, and to somebody
 * who cannot see colour.
 */
/** Remove the continuation indent shared by every line after the first. */
function dedentBody(text) {
  const lines = text.split("\n");
  const rest = lines.slice(1).filter((l) => l.trim());
  if (!rest.length) return lines;
  const common = Math.min(...rest.map((l) => l.match(/^ */)[0].length));
  return [lines[0], ...lines.slice(1).map((l) => (l.trim() ? l.slice(common) : l))];
}

export function formatPreinstallReport(checks, { platformName } = {}) {
  const lines = [];
  const s = summarizePreinstall(checks);
  const verdict = preinstallVerdict(checks);
  const width = Math.max(...checks.map((x) => x.name.length), 12);

  lines.push("");
  lines.push("  brain preinstall — what this machine can and cannot do on install day");
  if (platformName) lines.push(`  host: ${platformName}`);
  lines.push("");
  lines.push("  PASS = checked and good.   FAIL = checked and broken.");
  lines.push("  WARN = works, with a consequence.   CANNOT CHECK = unknown from here, do it by hand.");
  lines.push("");

  for (const x of checks) {
    lines.push(`  ${statusTag(x.status).padEnd(13)} ${x.name.padEnd(width)}  ${x.detail}`);
  }
  lines.push("");

  const section = (title, items, key) => {
    if (!items.length) return;
    lines.push(`  ${title}`);
    lines.push("");
    for (const x of items) {
      lines.push(`  ${x.name}`);
      // These strings were written for an older renderer that indented only the
      // first line, so most carry their own two-space continuation. Strip the
      // common prefix rather than leaving every remedy stepped one notch in,
      // and keep deeper indentation, which is always a command to be copied.
      for (const line of dedentBody(String(x[key] || ""))) lines.push(line.trim() ? `    ${line}` : "");
      lines.push("");
    }
  };

  section("BLOCKERS — this install will fail until these are fixed",
    checks.filter((x) => x.status === FAIL), "fix");
  section("CANNOT CHECK — nobody knows yet. Do these by hand before install day",
    checks.filter((x) => x.status === CANNOT_CHECK), "manual");
  section("WARNINGS — the install works; the client needs to hear these",
    checks.filter((x) => x.status === WARN && x.fix), "fix");

  lines.push(`  ${verdict.headline}`);
  lines.push(`  ${s.ok} passed, ${s.fatal} failed, ${s.warnings} warning(s), ${s.unchecked} not checkable from here.`);
  for (const line of verdict.note.split("\n")) lines.push(`  ${line}`);
  lines.push("");
  return lines.join("\n");
}
