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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { win32 as pathWin32 } from "node:path";
import { tokenStorageStatus, verifyTokenStorageReadable } from "./connectors/google-auth.mjs";
import { probeWindowsDpapi } from "./operations/admin-key-file.mjs";

export const OK = "ok";
export const WARN = "warn";
export const FAIL = "fail";
export const WRANGLER_PACKAGE = "wrangler@4.127.1";

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
  "  Temporary fallback: run `brain doctor <manifest>` and follow its exact named\n" +
  "  Wrangler-profile sign-in step. Provision confirms the manifest account before\n" +
  "  that isolated session can be used for Vectorize.\n" +
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

const WINDOWS_CLAUDE_PATH_REPAIR_SCRIPT = [
  "$claudeBin = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.local\\bin'))",
  "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
  "$parts = @($userPath -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })",
  "$present = @($parts | Where-Object { [string]::Equals($_, $claudeBin, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0",
  "if (-not $present) { [Environment]::SetEnvironmentVariable('Path', (($parts + $claudeBin) -join ';'), 'User') }",
  "$env:Path = $claudeBin + ';' + $env:Path",
].join("; ");

function normalizedWindowsPath(value) {
  return pathWin32.normalize(String(value || "").trim()).replace(/[\\/]+$/, "").toLowerCase();
}

/** Identify the official native Windows install without trusting PATH. */
export function windowsClaudePathState({
  environment = process.env,
  existsImpl = existsSync,
} = {}) {
  const profile = String(environment?.USERPROFILE || "").trim();
  if (!pathWin32.isAbsolute(profile)) {
    return Object.freeze({ installed: false, onPath: false, bin: null, executable: null });
  }
  const bin = pathWin32.join(profile, ".local", "bin");
  const candidates = [pathWin32.join(bin, "claude.exe"), pathWin32.join(bin, "claude.cmd")];
  const executable = candidates.find((candidate) => {
    try { return existsImpl(candidate); } catch { return false; }
  }) || null;
  const pathValue = String(environment?.PATH || environment?.Path || "");
  const target = normalizedWindowsPath(bin);
  const onPath = pathValue.split(";").some((entry) => normalizedWindowsPath(entry) === target);
  return Object.freeze({ installed: executable !== null, onPath, bin, executable });
}

/**
 * Persist only the missing Claude directory in the current user's PATH.
 * PowerShell's .NET API preserves the full value; setx is deliberately absent
 * because it can truncate an existing PATH. The current process is updated too.
 */
export function persistWindowsClaudePath({
  platformName = process.platform,
  environment = process.env,
  existsImpl = existsSync,
  runPowerShell = spawnSync,
} = {}) {
  if (platformName !== "win32") return Object.freeze({ status: "not_applicable" });
  const state = windowsClaudePathState({ environment, existsImpl });
  if (!state.installed) return Object.freeze({ ...state, status: "not_installed" });
  if (state.onPath) return Object.freeze({ ...state, status: "verified" });
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!pathWin32.isAbsolute(String(systemRoot || ""))) {
    return Object.freeze({ ...state, status: "failed", issue_code: "CLAUDE_PATH_RUNTIME_UNAVAILABLE" });
  }
  const command = pathWin32.join(
    systemRoot,
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const result = runPowerShell(command, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", WINDOWS_CLAUDE_PATH_REPAIR_SCRIPT,
  ], {
    encoding: "utf8",
    env: localToolEnvironment(environment),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0) {
    return Object.freeze({ ...state, status: "failed", issue_code: "CLAUDE_PATH_UPDATE_FAILED" });
  }
  const currentPath = String(environment.PATH || environment.Path || "");
  environment.PATH = [state.bin, currentPath].filter(Boolean).join(";");
  return Object.freeze({ ...state, onPath: true, status: "updated" });
}

function windowsClaudePathRepairText() {
  return "In PowerShell run this non-truncating user PATH repair, then rerun `brain tools`:\n" +
    `  ${WINDOWS_CLAUDE_PATH_REPAIR_SCRIPT}`;
}

/** Preserve a chosen/exported account id, but never an ambient API credential. */
export function cloudflareCliEnvironment(accountId, environment = process.env) {
  return localToolEnvironment(environment, accountId
    ? { CLOUDFLARE_ACCOUNT_ID: accountId }
    : {});
}

/**
 * Give each account-owned install a stable, non-identifying Wrangler auth
 * profile. The account id never appears in the profile label, and two accounts
 * cannot accidentally share the default OAuth session.
 */
export function wranglerProfileName(accountId) {
  const normalized = String(accountId || "").trim();
  if (!normalized) return null;
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `financial-brain-${digest}`;
}

/** Add the per-install profile to a Wrangler command without mutating argv. */
export function wranglerProfileArgs(args, accountId) {
  const profile = wranglerProfileName(accountId);
  return profile ? [...args, "--profile", profile] : [...args];
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
  const r = runCommand("npx", [WRANGLER_PACKAGE, "--version"], {
    timeout: 120_000,
    inheritEnv: false,
    env: localToolEnvironment(),
  });
  const version = r.out.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (r.ok && version && Number(version[1]) === 4 && Number(version[2]) >= 127) {
    return check("wrangler", OK, version[0]);
  }
  return check(
    "wrangler",
    FAIL,
    r.ok && version ? `returned ${version[0]}, but 4.127 or newer is required for isolated auth profiles` : "could not be run",
    `wrangler is fetched on demand by npx, so this usually means no network or a blocked npm registry.\n  Test with: npx ${WRANGLER_PACKAGE} --version`
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

export function checkWranglerLogin(accountId, runCommand = run) {
  if (!accountId) {
    return check(
      "wrangler login",
      WARN,
      "not checked: the Cloudflare account id is not known yet",
      "Run `brain doctor <manifest>` after setup has selected the account. The fallback uses a separate named Wrangler profile for that install.",
    );
  }
  const env = cfEnv(accountId);
  const r = runCommand("npx", wranglerProfileArgs([
    WRANGLER_PACKAGE, "vectorize", "list", "--json",
  ], accountId), {
    timeout: 120_000,
    inheritEnv: false,
    env,
  });
  if (r.ok) {
    return check(
      "wrangler login",
      OK,
      "isolated profile confirmed by a read-only Vectorize request to the declared account",
    );
  }
  if (!/profile.*(?:not found|could not be found)|not logged in|no credentials/i.test(r.out)) {
    return check(
      "wrangler login",
      FAIL,
      "the isolated profile could not confirm read access to Vectorize in the declared account",
      `Re-authenticate this install's profile with: npx ${WRANGLER_PACKAGE} auth create ${wranglerProfileName(accountId)}\n` +
        "  Then rerun `brain doctor <manifest>`. The fallback will not act on a logged-in profile that cannot read the exact manifest account.",
    );
  }
  return check(
    "wrangler login",
    WARN,
    "this install's isolated Wrangler profile is not signed in",
    `Run: npx ${WRANGLER_PACKAGE} auth create ${wranglerProfileName(accountId)}\n` +
      "  This opens the browser and stores a separate named profile for this install.\n" +
      "  Doctor then confirms the exact manifest account before the profile can be used.\n" +
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

export function checkVectorize(accountId, runCommand = run) {
  const identity = checkWranglerLogin(accountId, runCommand);
  return identity.status === OK
    ? check("Vectorize", OK, "reachable through the isolated profile in the declared account")
    : { ...identity, name: "Vectorize" };
}

export function checkClaudeCode({
  runCommand = run,
  required = true,
  platformName = process.platform,
  environment = process.env,
  existsImpl = existsSync,
} = {}) {
  const windowsState = platformName === "win32"
    ? windowsClaudePathState({ environment, existsImpl })
    : null;
  const command = windowsState?.installed && !windowsState.onPath
    ? windowsState.executable
    : "claude";
  const environmentForProbe = localToolEnvironment(environment, windowsState?.installed && !windowsState.onPath
    ? { PATH: [windowsState.bin, environment.PATH || environment.Path || ""].filter(Boolean).join(";") }
    : {});
  const r = runCommand(command, ["--version"], {
    timeout: 30_000,
    inheritEnv: false,
    env: environmentForProbe,
  });
  if (r.ok) {
    const version = (r.out.trim().split("\n")[0] || "present").slice(0, 40);
    if (windowsState?.installed && !windowsState.onPath) {
      return check(
        "Claude Code",
        required ? FAIL : WARN,
        `${version}; installed at the official per-user location but missing from PATH`,
        windowsClaudePathRepairText(),
      );
    }
    const auth = runCommand(command, ["auth", "status"], {
      timeout: 30_000,
      inheritEnv: false,
      env: environmentForProbe,
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
    ? "In PowerShell run Anthropic's official installer: irm https://claude.ai/install.ps1 | iex\n  Then rerun `brain tools`; it checks the official per-user binary and safely repairs the user PATH when needed.\n  Finally run `claude doctor` in that interactive terminal."
    : "Run: curl -fsSL https://claude.ai/install.sh | bash\n  Close and reopen Terminal, then run: claude --version\n  Finally run `claude doctor` in that interactive terminal.";
  return check(
    "Claude Code",
    required ? FAIL : WARN,
    required ? "required, but not found on PATH" : "not found on PATH",
    `${install}\n  Do not use sudo or a permission-bypass mode. Then re-run \`brain doctor\`.`
  );
}

export function checkWindowsCredentialProtection({
  platformName = process.platform,
  probe = probeWindowsDpapi,
  probeOptions = {},
} = {}) {
  if (platformName !== "win32") {
    return check("Windows credential protection", OK, "not applicable on this platform");
  }
  const result = probe({ platform: "win32", rounds: 3, ...probeOptions });
  if (result.passed) {
    return {
      ...check(
      "Windows credential protection",
      OK,
      `${result.rounds} in-memory DPAPI protect/decrypt round trips passed and temporary helper artifacts were cleaned`,
      ),
      rounds: result.rounds,
      issue_code: null,
    };
  }
  const stage = String(result.stage || "unknown").replaceAll("_", " ");
  return {
    ...check(
      "Windows credential protection",
      FAIL,
      `DPAPI failed at the ${stage} stage after ${result.rounds || 0} completed round trips`,
      `Issue code: ${result.issue_code || "WINDOWS_DPAPI_UNKNOWN"}. ` +
        "Keep the prior credential in place. Rerun `brain doctor` in the same Windows user profile after resolving that stage; do not copy the credential into chat or a command.",
    ),
    rounds: result.rounds || 0,
    issue_code: result.issue_code || "WINDOWS_DPAPI_UNKNOWN",
  };
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
export async function checkCfToken(cloudflareToken = process.env.CLOUDFLARE_API_TOKEN, {
  accountId,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  if (cloudflareToken) {
    // Presence is not validity. A typo'd, revoked, or expired token used to
    // report "ok  ready to install" and then fail deep inside provisioning,
    // which is the worst place to learn it. One cheap call settles it here.
    const endpoints = [
      { owner: "user-owned", url: "https://api.cloudflare.com/client/v4/user/tokens/verify" },
      ...(accountId ? [{
        owner: "account-owned",
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      }] : []),
    ];
    let activeOwner = null;
    const rejections = [];
    const networkErrors = [];
    for (const endpoint of endpoints) {
      try {
        const res = await fetchImpl(endpoint.url, {
          headers: { authorization: `Bearer ${cloudflareToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        let payload = null;
        try { payload = await res.json(); } catch { /* status below is enough */ }
        if (res.ok && payload?.success && payload?.result?.status === "active") {
          activeOwner = endpoint.owner;
          if (!accountId) {
            return check(
              "Cloudflare token",
              OK,
              `verified and active (${endpoint.owner}); account capabilities will be checked after the manifest selects an account`,
            );
          }
          break;
        }
        const detail = (payload?.errors || []).map((x) => x.message).filter(Boolean).join("; ")
          || `HTTP ${res.status}`;
        const status = String(payload?.result?.status || "");
        if (/expired|disabled/i.test(`${status} ${detail}`)) {
          return check(
            "Cloudflare token",
            FAIL,
            /expired/i.test(`${status} ${detail}`) ? "the token has expired" : "the token is disabled",
            `${CF_TOKEN_REJECTED_REMEDY}\n${CF_PLAN_NOTE}`,
          );
        }
        rejections.push(`${endpoint.owner}: ${detail.slice(0, 80)}`);
      } catch (error) {
        networkErrors.push(`${endpoint.owner}: ${String(error?.message || error).slice(0, 60)}`);
      }
    }
    if (!accountId && rejections.length) {
      return check(
        "Cloudflare token",
        WARN,
        "the user-owned token endpoint rejected it, but no account id is available to check whether it is an account-owned token",
        "Run `brain doctor <manifest>` once the manifest names the Cloudflare account. Doctor will then use read-only account capability probes instead of treating this verification response as an invalid-token verdict.",
      );
    }
    if (accountId) {
      const capabilityProbes = [
        { name: "Workers Scripts: Edit", path: `/accounts/${accountId}/workers/scripts` },
        { name: "D1: Edit", path: `/accounts/${accountId}/d1/database` },
        { name: "Vectorize: Edit", path: `/accounts/${accountId}/vectorize/v2/indexes` },
        { name: "Workers AI: Read", path: `/accounts/${accountId}/ai/models/search?per_page=1` },
      ];
      const confirmed = [];
      const unavailable = [];
      const probeNetworkErrors = [];
      for (const capability of capabilityProbes) {
        try {
          const res = await fetchImpl(`https://api.cloudflare.com/client/v4${capability.path}`, {
            headers: { authorization: `Bearer ${cloudflareToken}` },
            signal: AbortSignal.timeout(timeoutMs),
          });
          let payload = null;
          try { payload = await res.json(); } catch { /* status below is enough */ }
          if (res.ok && payload?.success !== false) {
            confirmed.push(capability.name);
          } else {
            const detail = (payload?.errors || []).map((x) => x.message).filter(Boolean).join("; ")
              || `HTTP ${res.status}`;
            unavailable.push(`${capability.name} (${detail.slice(0, 60)})`);
          }
        } catch (error) {
          probeNetworkErrors.push(`${capability.name} (${String(error?.message || error).slice(0, 50)})`);
        }
      }
      if (confirmed.length === capabilityProbes.length) {
        return check(
          "Cloudflare token",
          OK,
          `all four required account surfaces are reachable through read-only probes${activeOwner ? `; token is active (${activeOwner})` : "; token verification endpoints were not used as the verdict"}. Edit authority remains fail-closed until the provisioning operation that needs it`,
        );
      }
      if (unavailable.length) {
        return check(
          "Cloudflare token",
          FAIL,
          `required account capabilities are unavailable: ${unavailable.join("; ").slice(0, 180)}`,
          "The token was not declared invalid from a verification endpoint. Review the selected Cloudflare account and ensure the token summary includes exactly these required capabilities: " +
            `${CF_TOKEN_SCOPES.join(", ")}. Then rerun ` + "`brain doctor <manifest>`.",
        );
      }
      if (probeNetworkErrors.length) {
        networkErrors.push(...probeNetworkErrors);
      }
    }
    if (networkErrors.length) {
      // Offline or blocked. Do not claim the token is bad, and do not claim it is good.
      return check(
        "Cloudflare token",
        WARN,
        `set, but every applicable verification path could not be completed (${networkErrors.join("; ").slice(0, 120)})`,
        "The token is present but this machine could not complete verification with api.cloudflare.com.\n" +
          "  Re-run `brain doctor <manifest>` once the network is back. A VPN or corporate filter can\n" +
          "  also block it: Cloudflare WARP in particular breaks this call from inside a VM."
      );
    }
    return check(
      "Cloudflare token",
      WARN,
      `verification endpoints did not confirm this token, and required account capabilities could not be proven: ${rejections.join("; ").slice(0, 140)}`,
      "Do not treat this response alone as proof that the token is invalid. Rerun `brain doctor <manifest>` with the exact account id so its read-only Workers, D1, Vectorize, and Workers AI capability checks can decide readiness.",
    );
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
export const PLAID_WEBHOOK_PATH = "/api/webhooks/plaid";

export function bankFeedRedirectUri(domain) {
  const host = String(domain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}${BANK_FEED_REDIRECT_PATH}`;
}

export function plaidWebhookUri(domain) {
  const host = String(domain || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${host}${PLAID_WEBHOOK_PATH}`;
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
  const provider = feed.provider === "plaid" ? "plaid" : "custom";
  const declared = Array.isArray(feed.registered_redirect_uris) ? feed.registered_redirect_uris : [];
  const missingConfig = provider === "custom" ? [
      !feed.api_base && "corpora.bank_feed.api_base",
      !feed.link_sdk_url && "corpora.bank_feed.link_sdk_url",
      !feed.link_global && "corpora.bank_feed.link_global",
    ].filter(Boolean) : [];

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
  if (provider === "plaid" && (feed.api_base || feed.link_sdk_url || feed.link_global)) {
    return check(
      "Bank feed", FAIL,
      "the Plaid profile has a custom endpoint override",
      "  Remove corpora.bank_feed.api_base, link_sdk_url, and link_global. The named\n" +
      "  Plaid profile pins its reviewed public endpoints and browser SDK. Use\n" +
      "  provider: custom only for a separately reviewed compatible provider."
    );
  }
  const environment = feed.environment === "production" ? "production" : "sandbox";
  const webhook = provider === "plaid" ? plaidWebhookUri(domain) : null;
  return check(
    "Bank feed", OK,
    `${provider}; ${environment}; return address registered (${required})${webhook ? `; signed webhook ${webhook}` : ""}`,
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
  push(checkNode());
  push(checkWrangler(localRun));
  push(await checkNetwork());
  push(await checkCfToken(cloudflareToken, { accountId }));
  const vectorize = await checkVectorizeApi(accountId, cloudflareToken);
  push(vectorize);
  if (accountId && vectorize.status !== OK) {
    // Only surface the OAuth fallback when the standard scoped token path is
    // unavailable. This keeps a healthy install from being told to create an
    // unnecessary second credential while still printing the exact isolated
    // profile repair in the run that needs it.
    push(checkWranglerLogin(accountId, localRun));
  }
  push(checkAnthropicKey());
  push(checkClaudeCode({ runCommand: localRun, required: requireClaudeCode }));
  if (process.platform === "win32") push(checkWindowsCredentialProtection());
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
