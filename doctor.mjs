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
import { platform } from "node:os";
import { tokenStorageStatus, verifyTokenStorageReadable } from "./connectors/google-auth.mjs";

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
/**
 * Plan and limits. Shared, because both the "no token yet" and the "token
 * cannot reach Vectorize" paths need it and only one of them should also be
 * told to RECREATE a token it does not have yet.
 */
export const CF_PLAN_NOTE =
  "  Workers Paid (5 USD monthly minimum) is the supported production baseline.\n" +
  "  Free can create Vectorize, but its vector, daily-write, and CPU limits are\n" +
  "  prototype-scale and can hard-stop a real corpus.";

export const VECTORIZE_REMEDY =
  "  Recreate the account-scoped token with Vectorize: Edit. That is the standard\n" +
  "  path and has been verified for index and metadata-index creation.\n" +
  "  Temporary fallback: run `npx wrangler@4 login` in the account owner's browser.\n" +
  "  Provision can use that session for Vectorize while the API token drives the\n" +
  "  remaining steps.\n" +
  CF_PLAN_NOTE;

/** The token scopes, in one place, for the same reason. */
export const CF_TOKEN_SCOPES = ["Workers Scripts: Edit", "D1: Edit", "Vectorize: Edit", "Workers AI: Read"];

/**
 * What to do when Cloudflare rejects the credential.
 *
 * One copy, because two commands used to disagree about whose fault it is.
 * `brain verify` routed a rejected token to the unexpected-error handler and
 * told the owner "This is a bug in the installer, not something you did wrong"
 * (bench, 2026-08-28), which is false and is the one sentence that stops a
 * person from fixing the most common install-day mistake there is.
 */
export const CF_TOKEN_REJECTED_REMEDY =
  "The value in CLOUDFLARE_API_TOKEN is not a token Cloudflare will accept.\n" +
  "  Check it was copied whole, with no leading or trailing spaces, and that it\n" +
  "  has not expired or been deleted: dash.cloudflare.com > My Profile > API Tokens.\n" +
  `  Scopes: ${CF_TOKEN_SCOPES.join(", ")}.\n` +
  "  Then run `brain setup` or `brain update` in an interactive terminal; it asks for the token without echo.";

/** Does this failure mean the credential was refused, rather than the tool misbehaving? */
export function isCredentialRejection(error) {
  const text = String(error?.message ?? error ?? "");
  if (/\b(9109|10000)\b/.test(text) && /\b40[13]\b/.test(text)) return true;
  return /invalid access token|authentication error|unauthori[sz]ed|token has expired/i.test(text);
}

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

export function checkWrangler(runCommand = run) {
  const r = runCommand("npx", ["wrangler@4", "--version"], {
    timeout: 120_000,
    inheritEnv: false,
    env: localToolEnvironment(),
  });
  const version = r.out.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (r.ok && version && Number(version[1]) === 4) {
    return check("wrangler", OK, version[0]);
  }
  return check(
    "wrangler",
    FAIL,
    r.ok && version ? `returned ${version[0]}, but major version 4 is required` : "could not be run",
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

/**
 * Whether the account is on Workers Paid, checked BEFORE install — without
 * guessing.
 *
 * What this can and cannot see was measured, not assumed (2026-08-31, live):
 * with a token holding exactly the four install scopes (CF_TOKEN_SCOPES),
 * GET /accounts/{id}/subscriptions answers success:false, errors[0].code
 * 10000 "Authentication error" — the standard subscription surface needs a
 * billing scope the install token deliberately does not carry. A much broader
 * Workers-operations token gave the same refusal, and
 * /workers/account-settings (which IS readable) reports the same
 * default_usage_model on Free and Paid accounts alike, so it carries no plan
 * signal either. There is therefore NO reliable plan read inside the install
 * scopes, and this check says so plainly rather than inventing a verdict:
 * unreadable is a WARN with the dashboard path, never a FAIL and never a
 * pretend OK. A token that CAN read subscriptions (a client's own broader
 * token) gets the definitive line automatically.
 */
export async function checkWorkersPaidPlan(
  accountId,
  cloudflareToken = process.env.CLOUDFLARE_API_TOKEN,
  fetchImpl = fetch,
) {
  const name = "Workers plan";
  if (!cloudflareToken) {
    return check(name, WARN, "not checked: Cloudflare token is missing",
      "Run `brain setup` or `brain update` in an interactive terminal for hidden token entry.\n" + CF_PLAN_NOTE);
  }
  if (!accountId) {
    return check(name, WARN, "not checked: Cloudflare account id is not known yet",
      "Run `brain doctor <manifest>` after setup has written the account id.\n" + CF_PLAN_NOTE);
  }
  let payload = null;
  let status = 0;
  try {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`, {
      headers: { authorization: `Bearer ${cloudflareToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    try { payload = await res.json(); } catch { /* judged below */ }
  } catch (e) {
    return check(name, WARN, `not checked: probe failed (${String(e.message).slice(0, 80)})`,
      "Transient network trouble is the usual cause; re-run doctor.\n" + CF_PLAN_NOTE);
  }

  const errorText = (payload?.errors || []).map((x) => `${x.code} ${x.message}`).join("; ");
  const scopeRefused =
    payload?.success === false &&
    (/\b(10000|9109)\b/.test(errorText) || /authentication|authori[sz]/i.test(errorText) || status === 401 || status === 403);
  if (scopeRefused) {
    return check(
      name,
      WARN,
      "cannot be read with this token's scopes, so it is not verified here",
      "This is expected with the standard install token: reading the plan needs a\n" +
        "  billing scope it deliberately does not carry, and it should not be widened\n" +
        "  for a check. Confirm the plan by eye instead:\n" +
        "    Cloudflare dashboard > Workers & Pages > Plans\n" + CF_PLAN_NOTE,
    );
  }
  if (payload?.success && Array.isArray(payload.result)) {
    const describe = (sub) =>
      String(sub?.rate_plan?.public_name || sub?.rate_plan?.id || sub?.product?.name || "unnamed plan");
    const workers = payload.result.filter((sub) =>
      /worker/i.test(JSON.stringify([sub?.product?.name, sub?.rate_plan?.id, sub?.rate_plan?.public_name])));
    const paid = workers.find((sub) => !/free/i.test(describe(sub)));
    if (paid) return check(name, OK, `Workers subscription is active: ${describe(paid).slice(0, 60)}`);
    const seen = payload.result.map(describe).filter(Boolean).slice(0, 4).join(", ") || "none";
    return check(
      name,
      WARN,
      `no Workers subscription is visible on this account (saw: ${seen.slice(0, 80)})`,
      "The account may be on the Free plan. Confirm before install:\n" +
        "    Cloudflare dashboard > Workers & Pages > Plans\n" + CF_PLAN_NOTE,
    );
  }
  return check(name, WARN, `not checked: unexpected response (HTTP ${status})`,
    "Re-run doctor; if it persists, confirm the plan in the dashboard:\n" +
      "    Cloudflare dashboard > Workers & Pages > Plans\n" + CF_PLAN_NOTE);
}

/**
 * The priority slice, checked while there is still time to choose one.
 *
 * ingest.priority_slice is the install-day ordering decision: the single
 * folder the owner already said would be worth it, loaded and proven FIRST,
 * with the long tail streaming in behind. Nothing enforces it mechanically —
 * it drives which `brain ingest --path` runs first — so an empty slice fails
 * silently: the first load happens in whatever order someone picks under
 * install-day pressure, usually chronological, and the first impression is
 * made by the archive instead of the working set. After handoff the ordering
 * decision is spent, so a completed install stops warning.
 */
export function checkPrioritySlice(manifest) {
  const name = "priority slice";
  if (manifest?.handoff?.handoff_completed_at) {
    return check(name, OK, "handoff is complete; first-load ordering no longer applies");
  }
  const slice = manifest?.ingest?.priority_slice;
  const source = typeof slice?.source === "string" ? slice.source.trim() : "";
  if (source) {
    return check(name, OK, `first load is pinned to "${source.slice(0, 48)}"${slice?.since ? ` since ${slice.since}` : ""}`);
  }
  return check(
    name,
    WARN,
    "ingest.priority_slice is not set, so the first load has no agreed order",
    "Before the first load, put the folder from intake 2.4 into ingest.priority_slice\n" +
      "  (templates/brain.manifest.json carries a filled _example to copy). Loading the\n" +
      "  priority slice first and proving it beats chronological order: a first\n" +
      "  impression made by the archive is how an install loses the room.",
  );
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

export function checkClaudeCode({
  runCommand = run,
  required = true,
  platformName = process.platform,
} = {}) {
  const r = runCommand("claude", ["--version"], {
    timeout: 30_000,
    inheritEnv: false,
    env: localToolEnvironment(),
  });
  if (r.ok) {
    const version = (r.out.trim().split("\n")[0] || "present").slice(0, 40);
    const auth = runCommand("claude", ["auth", "status"], {
      timeout: 30_000,
      inheritEnv: false,
      env: localToolEnvironment(),
    });
    if (auth.ok) return check("Claude Code", OK, `${version}; signed in`);
    return check(
      "Claude Code",
      required ? FAIL : WARN,
      `${version}; installed but not signed in`,
      "Run `claude auth login` in an interactive terminal and approve the browser sign-in.\n" +
        "  Then run `claude auth status`, `claude doctor`, and `brain doctor` again."
    );
  }
  const install = platformName === "win32"
    ? "In PowerShell run: irm https://claude.ai/install.ps1 | iex\n  Close and reopen PowerShell, then run: claude --version\n  Finally run `claude doctor` in that interactive terminal."
    : "Run: curl -fsSL https://claude.ai/install.sh | bash\n  Close and reopen Terminal, then run: claude --version\n  Finally run `claude doctor` in that interactive terminal.";
  return check(
    "Claude Code",
    required ? FAIL : WARN,
    required ? "required, but not found on PATH" : "not found on PATH",
    `${install}\n  Do not use sudo or a permission-bypass mode. Then re-run \`brain doctor\`.`
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

export function checkGoogleConnection(storageStatus, verify = verifyTokenStorageReadable) {
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
  if (stored.exists) {
    // A file being present is not the same as a credential being readable. On
    // Windows the DPAPI envelope header is 29 plaintext bytes, so a blob
    // written by another Windows user, or one whose master key no longer
    // resolves, looks perfect to a header check and fails on first real use.
    // Open it here, where it is cheap to fix, rather than mid-ingest on
    // install day. No credential value is read back or printed.
    const opened = verify ? verify() : { checked: false, readable: true };
    if (opened.checked && !opened.readable) {
      return check(
        "Google connection",
        FAIL,
        `a credential is stored in ${stored.description} but cannot be opened`,
        `${opened.reason}\n  No credential value was read or printed.\n` +
          "  This usually means the record belongs to a different user or machine than the one running now.\n" +
          "  Fix it with: brain connect google --scopes drive,gmail",
      );
    }
    return check("Google connection", OK, `token stored in ${stored.description}`);
  }
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
export async function checkCfToken(cloudflareToken = process.env.CLOUDFLARE_API_TOKEN) {
  if (cloudflareToken) {
    // Presence is not validity. A typo'd, revoked, or expired token used to
    // report "ok  ready to install" and then fail deep inside provisioning,
    // which is the worst place to learn it. One cheap call settles it here.
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { authorization: `Bearer ${cloudflareToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* status below is enough */ }
      if (res.ok && payload?.success && payload?.result?.status === "active") {
        return check("Cloudflare token", OK, "verified and active");
      }
      // `/user/tokens/verify` only recognises USER API tokens. A `wrangler login`
      // session and an account-owned token both work perfectly for accounts, D1,
      // Workers and Vectorize, and both are rejected here as "Invalid API Token".
      // Calling that a failure stops a working install at the preflight, so ask
      // the question that actually matters: can this credential see an account?
      try {
        const probe = await fetch("https://api.cloudflare.com/client/v4/accounts", {
          headers: { authorization: `Bearer ${cloudflareToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const accounts = probe.ok ? await probe.json().catch(() => null) : null;
        if (accounts?.success && Array.isArray(accounts.result) && accounts.result.length) {
          return check(
            "Cloudflare credential", OK,
            `browser or account-scoped sign-in, ${accounts.result.length} account(s) visible`,
          );
        }
      } catch { /* fall through to the token verdict below */ }

      const detail = (payload?.errors || []).map((x) => x.message).filter(Boolean).join("; ")
        || `HTTP ${res.status}`;
      const expired = /expired/i.test(detail) || payload?.result?.status === "expired";
      return check(
        "Cloudflare token",
        FAIL,
        expired ? "the token has expired" : `Cloudflare rejected this token: ${detail.slice(0, 120)}`,
        "The value in CLOUDFLARE_API_TOKEN is not a token Cloudflare will accept.\n" +
          "  Check it was copied whole, with no leading or trailing spaces, and that it\n" +
          "  has not expired or been deleted: dash.cloudflare.com > My Profile > API Tokens.\n" +
          `  Scopes: ${CF_TOKEN_SCOPES.join(", ")}.\n` +
          "  Then run `brain setup` or `brain update` in an interactive terminal; it asks for the token without echo.\n" +
          CF_PLAN_NOTE
      );
    } catch (e) {
      // Offline or blocked. Do not claim the token is bad, and do not claim it is good.
      return check(
        "Cloudflare token",
        WARN,
        `set, but could not be verified (${String(e.message).slice(0, 60)})`,
        "The token is present but this machine could not reach api.cloudflare.com to check it.\n" +
          "  Re-run `brain doctor` once the network is back. A VPN or corporate filter can\n" +
          "  also block it: Cloudflare WARP in particular breaks this call from inside a VM."
      );
    }
  }
  return check(
    "Cloudflare token",
    FAIL,
    "CLOUDFLARE_API_TOKEN is not set",
    "Create one in the Cloudflare account that will own this brain: dash.cloudflare.com > My Profile > API Tokens.\n" +
      `  Scopes: ${CF_TOKEN_SCOPES.join(", ")}.
` +
      "  Set \'Expires on\' to tomorrow. Nothing here needs to outlive the install.\n" +
      "  Then run `brain setup` or `brain update` in an interactive terminal; it asks for the token without echo.\n" +
      "  Low-level automation must inject it through an approved secret manager, never a pasted shell command.\n" +
      CF_PLAN_NOTE
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
export async function runAll({
  accountId,
  onResult,
  googleStorageStatus,
  cloudflareToken,
  requireClaudeCode = true,
  localRun = run,
} = {}) {
  const out = [];
  // Each result is handed to the caller the moment it exists, so a slow check
  // shows the ones before it rather than holding the whole report hostage.
  const push = (x) => {
    out.push(x);
    if (onResult) onResult(x);
    return x;
  };
  // Every check goes through push(), never out.push(): the first three used
  // push() and the rest bypassed it, so a healthy machine printed three lines
  // out of ten and looked truncated to anyone watching a screen share.
  push(checkNode());
  push(checkWrangler(localRun));
  push(await checkNetwork());
  push(await checkCfToken(cloudflareToken));
  push(await checkVectorizeApi(accountId, cloudflareToken));
  push(await checkWorkersPaidPlan(accountId, cloudflareToken));
  push(checkAnthropicKey());
  push(checkClaudeCode({ runCommand: localRun, required: requireClaudeCode }));
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
