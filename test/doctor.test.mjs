import { run, localToolEnvironment, cloudflareCliEnvironment,
         checkNode, checkClaudeCode, checkCodex, checkAnthropicKey, checkGoogleConnection,
         checkWindowsCredentialProtection, persistWindowsClaudePath, windowsClaudePathState,
         checkWrangler,
         checkWranglerLogin, checkVectorize, checkVectorizeApi, checkCfToken, CF_TOKEN_SCOPES,
         resolveWranglerProfile, wranglerProfileArgs, wranglerProfileName,
         WRANGLER_AUTH_PROFILE_PATTERN, WRANGLER_PACKAGE,
         summarize, runAll, OK, WARN, FAIL } from "../doctor.mjs";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ---- every non-ok check MUST carry a fix. A failure without one is half a job. ---- */
{
  const all = await runAll({
    accountId: "0000",
    googleStorageStatus: { exists: false, description: "fixture secure storage" },
  });
  check("doctor runs every check without throwing", all.length >= 8, String(all.length));
  const bad = all.filter((x) => x.status !== OK && !x.fix);
  check("every non-ok check carries remediation text", bad.length === 0, JSON.stringify(bad.map((b) => b.name)));
  check("each check names itself and reports a status", all.every((x) => x.name && [OK, WARN, FAIL].includes(x.status)));
  check("each check says what it saw", all.every((x) => typeof x.detail === "string" && x.detail.length));
}

/* ---- the severity split is the whole point: fatal blocks, optional does not ---- */
{
  const node = checkNode();
  check("Node on this machine passes", node.status === OK, JSON.stringify(node));
  const missingTool = () => ({ ok: false, out: "not found", missing: true });
  const healthyTool = (_command, args) => ({
    ok: true,
    out: args.includes(WRANGLER_PACKAGE) ? "wrangler 4.127.1" :
      args.includes("status") ? "" : "2.1.63 (Claude Code)",
  });
  check("Claude Code is a blocking owner-install requirement",
    checkClaudeCode({ runCommand: missingTool }).status === FAIL);
  check("the explicit technician-machine exception can keep Claude advisory",
    checkClaudeCode({ runCommand: missingTool, required: false }).status === WARN);
  check("a present Claude Code CLI passes",
    checkClaudeCode({ runCommand: healthyTool }).status === OK);
  const signedOutTool = (_command, args) => args.includes("status")
    ? { ok: false, out: "signed out" }
    : { ok: true, out: "2.1.63 (Claude Code)" };
  check("an installed but signed-out Claude Code is not a false green",
    checkClaudeCode({ runCommand: signedOutTool }).status === FAIL);
  const windowsEnvironment = {
    USERPROFILE: "C:\\Users\\Fixture",
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32;C:\\Existing Tools",
  };
  const windowsClaude = "C:\\Users\\Fixture\\.local\\bin\\claude.exe";
  const existsWindowsClaude = (path) => path.toLowerCase() === windowsClaude.toLowerCase();
  const pathState = windowsClaudePathState({
    environment: windowsEnvironment,
    existsImpl: existsWindowsClaude,
  });
  check("Windows doctor detects the official Claude binary outside PATH",
    pathState.installed && !pathState.onPath && pathState.executable === windowsClaude,
    JSON.stringify(pathState));
  const cmdOnly = windowsClaudePathState({
    environment: windowsEnvironment,
    existsImpl: (path) => /claude\.cmd$/i.test(String(path)),
  });
  check("a claude.cmd shim is not accepted as the native shell-free handoff executable",
    cmdOnly.installed === false && cmdOnly.executable === null,
    JSON.stringify(cmdOnly));
  const offPath = checkClaudeCode({
    runCommand: healthyTool,
    platformName: "win32",
    environment: windowsEnvironment,
    existsImpl: existsWindowsClaude,
  });
  check("an official Windows install outside PATH gets the exact recovery instead of an install loop",
    offPath.status === FAIL && /official per-user location.*missing from PATH/i.test(offPath.detail),
    JSON.stringify(offPath));
  check("the Windows PATH recovery uses the non-truncating user API and never setx",
    /SetEnvironmentVariable\('Path'.*'User'\)/i.test(offPath.fix) && !/\bsetx\b/i.test(offPath.fix),
    offPath.fix);
  let pathRepairCall;
  const repaired = persistWindowsClaudePath({
    platformName: "win32",
    environment: windowsEnvironment,
    existsImpl: existsWindowsClaude,
    runPowerShell: (command, args, options) => {
      pathRepairCall = { command, args, options };
      return { status: 0, stdout: "BRAIN_CLAUDE_PATH_OK", stderr: "" };
    },
  });
  check("brain tools can persist the missing Windows Claude directory without discarding PATH",
    repaired.status === "updated" && windowsEnvironment.PATH.startsWith("C:\\Users\\Fixture\\.local\\bin;") &&
      windowsEnvironment.PATH.includes("C:\\Existing Tools"), JSON.stringify(repaired));
  const falseGreenRepair = persistWindowsClaudePath({
    platformName: "win32",
    environment: {
      USERPROFILE: "C:\\Users\\Fixture",
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
    },
    existsImpl: existsWindowsClaude,
    runPowerShell: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  check("an exit-zero PATH write without the durable readback marker fails closed",
    falseGreenRepair.status === "failed" && falseGreenRepair.issue_code === "CLAUDE_PATH_UPDATE_FAILED",
    JSON.stringify(falseGreenRepair));
  check("the PATH repair child is credential-scrubbed and shell-free",
    pathRepairCall.options.shell === false && pathRepairCall.options.env.CLOUDFLARE_API_TOKEN === undefined &&
      /SetEnvironmentVariable/.test(pathRepairCall.args.at(-1)) && !/\bsetx\b/i.test(pathRepairCall.args.at(-1)),
    JSON.stringify(pathRepairCall?.args));
  check("the same Windows Claude install passes after current-process PATH recovery",
    checkClaudeCode({
      runCommand: healthyTool,
      platformName: "win32",
      environment: windowsEnvironment,
      existsImpl: existsWindowsClaude,
    }).status === OK);
  const dpapiPassed = checkWindowsCredentialProtection({
    platformName: "win32",
    probe: ({ rounds }) => ({ passed: true, rounds, stage: null }),
  });
  check("Windows doctor requires 25 DPAPI round trips without claiming a rate",
    dpapiPassed.status === OK && /25 in-memory DPAPI/i.test(dpapiPassed.detail) && !/\d+\s*\/\s*\d+/.test(dpapiPassed.detail),
    JSON.stringify(dpapiPassed));
  const dpapiFailed = checkWindowsCredentialProtection({
    platformName: "win32",
    probe: () => ({ passed: false, rounds: 1, stage: "compile", issue_code: "WINDOWS_DPAPI_COMPILE" }),
  });
  check("Windows doctor identifies the failed DPAPI stage with a stable code",
    dpapiFailed.status === FAIL && /compile stage/i.test(dpapiFailed.detail) && /WINDOWS_DPAPI_COMPILE/.test(dpapiFailed.fix),
    JSON.stringify(dpapiFailed));
  const dpapiCleanupDeferred = checkWindowsCredentialProtection({
    platformName: "win32",
    probe: () => ({
      passed: false,
      rounds: 25,
      stage: "cleanup_deferred",
      issue_code: "WINDOWS_DPAPI_CLEANUP_DEFERRED",
    }),
  });
  check("Windows doctor separates cleanup hygiene from a DPAPI crypto failure",
    dpapiCleanupDeferred.status === FAIL && /25 DPAPI round trips passed/i.test(dpapiCleanupDeferred.detail) &&
      /No credential write was classified as a crypto failure/i.test(dpapiCleanupDeferred.fix) &&
      /WINDOWS_DPAPI_CLEANUP_DEFERRED/.test(dpapiCleanupDeferred.fix),
    JSON.stringify(dpapiCleanupDeferred));
  check("the profile-capable Wrangler release is a blocking requirement and is pinned through npx",
    checkWrangler(healthyTool).status === OK);
  check("Codex is never fatal", checkCodex().status !== FAIL);
  check("a missing Anthropic key is not a blocker", checkAnthropicKey().status !== FAIL);
  check("a missing Google connection is a warning",
    checkGoogleConnection({ exists: false, description: "fixture secure storage" }).status !== FAIL);
  const migration = checkGoogleConnection({
    exists: true,
    backend: "legacy-file",
    description: "fixture token file (legacy Windows plaintext file; DPAPI migration pending)",
    encrypted: false,
    migrationPending: true,
  });
  check("legacy Windows plaintext Google storage is not a false green",
    migration.status === WARN && /plaintext/i.test(migration.detail), JSON.stringify(migration));
  check("the warning explains automatic DPAPI migration on next connector use",
    /next Drive, Gmail, or Calendar use migrates a still-valid token to a DPAPI-encrypted file/i.test(migration.fix) &&
      /If Google rejects the old token, reconnect/i.test(migration.fix), migration.fix);
  const macMigration = checkGoogleConnection({
    exists: true,
    backend: "legacy-file",
    description: "fixture token file (will migrate to macOS Keychain on next use)",
  });
  check("legacy macOS plaintext Google storage is also not a false green",
    macMigration.status === WARN && /login Keychain/i.test(macMigration.fix), JSON.stringify(macMigration));

  // A file being present is not a credential being readable. On Windows the
  // DPAPI envelope header is 29 plaintext bytes, so a blob belonging to a
  // different user still passes a header check. Doctor used to call that OK
  // and let the first real ingest discover otherwise, on install day.
  const stored = {
    exists: true,
    backend: "file",
    description: "fixture token file (DPAPI CurrentUser encrypted file)",
    encrypted: true,
    migrationPending: false,
  };

  const unreadable = checkGoogleConnection(stored, () => ({
    checked: true,
    readable: false,
    reason: "Windows could not decrypt the Google credential record with DPAPI for the current user",
  }));
  check("a stored credential that cannot be opened is a failure, not a green tick",
    unreadable.status === FAIL, JSON.stringify(unreadable));
  check("the failure says it is stored but unopenable, rather than absent",
    /stored in .*but cannot be opened/i.test(unreadable.detail), unreadable.detail);
  check("the failure gives the exact command that fixes it",
    /brain connect google/i.test(unreadable.fix), unreadable.fix);
  check("the failure states plainly that no credential value was read",
    /No credential value was read or printed/i.test(unreadable.fix), unreadable.fix);

  const readable = checkGoogleConnection(stored, () => ({ checked: true, readable: true }));
  check("a credential that does open stays green",
    readable.status === OK && /token stored in/i.test(readable.detail), JSON.stringify(readable));

  // Not every backend can be opened cheaply on every platform. An unperformed
  // check must not invent a failure.
  const unchecked = checkGoogleConnection(stored, () => ({ checked: false, readable: false, reason: "n/a" }));
  check("a check that did not run does not manufacture a failure",
    unchecked.status === OK, JSON.stringify(unchecked));

  // The verifier's own words reach the operator, so they must never carry a
  // secret. Prove the rendered output is clean even when the reason is hostile.
  const leaky = checkGoogleConnection(stored, () => ({
    checked: true,
    readable: false,
    reason: "decrypt failed",
  }));
  const rendered = `${leaky.detail}\n${leaky.fix}`;
  check("nothing resembling a token or secret reaches the rendered output",
    !/ya29\.|refresh_token|client_secret|[A-Za-z0-9_-]{40,}/.test(rendered), rendered);
}
{
  const k = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const a = checkAnthropicKey();
  check("without a key Workers AI remains the standard", a.status === OK && /Workers AI/.test(a.detail), a.detail);
  process.env.ANTHROPIC_API_KEY = "x";
  check("with a key it passes", checkAnthropicKey().status === OK);
  if (k) process.env.ANTHROPIC_API_KEY = k; else delete process.env.ANTHROPIC_API_KEY;
}

/* ---- the standard token owns Vectorize; browser login is only a fallback ---- */
{
  const accountId = "a".repeat(32);
  const seen = [];
  const signedIn = (_command, args, options) => {
    seen.push({ args, options });
    return { ok: true, out: JSON.stringify({ indexes: [] }) };
  };
  const l = checkWranglerLogin(accountId, signedIn);
  check("wrangler login requires an explicit confirmation of the manifest account",
    l.status === OK && /declared account/i.test(l.detail), JSON.stringify(l));
  check("the confirmation read is pinned to the declared account and a named profile",
    seen[0]?.args.includes("vectorize") && seen[0]?.args.includes("list") &&
      seen[0]?.args.includes("--json") && seen[0]?.args.includes("--profile") &&
      seen[0]?.args.includes(wranglerProfileName(accountId)) &&
      seen[0]?.options?.env?.CLOUDFLARE_ACCOUNT_ID === accountId,
    JSON.stringify(seen[0]));
  const otherAccount = "b".repeat(32);
  const mismatch = checkWranglerLogin(accountId, () => ({
    ok: false,
    out: "authorization failed for the selected account",
  }));
  check("a named profile that cannot read the declared account fails closed",
    mismatch.status === FAIL && /could not confirm read access/i.test(mismatch.detail), JSON.stringify(mismatch));
  check("per-account profile labels are stable, distinct, and do not expose account ids",
    wranglerProfileName(accountId) === wranglerProfileName(accountId) &&
      wranglerProfileName(accountId) !== wranglerProfileName(otherAccount) &&
      !wranglerProfileName(accountId).includes(accountId), wranglerProfileName(accountId));
  const originalArgs = [WRANGLER_PACKAGE, "vectorize", "list"];
  const profiledArgs = wranglerProfileArgs(originalArgs, accountId);
  check("profile argument construction is non-mutating",
    originalArgs.length === 3 && profiledArgs.length === 6 &&
      profiledArgs.at(-3) === "--profile" && profiledArgs.at(-1) === "--env-file=/dev/null");
  check("the scoped token includes Vectorize Edit", CF_TOKEN_SCOPES.includes("Vectorize: Edit"), JSON.stringify(CF_TOKEN_SCOPES));
}

/* ---- current manifests bind doctor to their exact saved OAuth profile ---- */
{
  const accountId = "d".repeat(32);
  const exactProfile = `financial-brain-${"1a".repeat(12)}`;
  const legacyProfile = wranglerProfileName(accountId);
  const ambientMarker = "ambient-value-that-must-not-cross";
  const seen = [];
  const result = checkWranglerLogin(accountId, (_command, args, options) => {
    seen.push({ args, options });
    return { ok: true, out: JSON.stringify({ indexes: [] }) };
  }, {
    authProfile: exactProfile,
    platformName: "darwin",
    environment: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CLOUDFLARE_API_TOKEN: ambientMarker,
      CLOUDFLARE_API_KEY: ambientMarker,
      CLOUDFLARE_EMAIL: "owner@example.test",
      CF_API_TOKEN: ambientMarker,
      WRANGLER_PROFILE: "default",
      NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
    },
  });
  const call = seen[0];
  const profileIndex = call?.args.indexOf("--profile") ?? -1;
  check("a current manifest uses its exact 24-hex saved profile",
    result.status === OK && WRANGLER_AUTH_PROFILE_PATTERN.test(exactProfile) &&
      call?.args[profileIndex + 1] === exactProfile && !call?.args.includes(legacyProfile),
    JSON.stringify({ result, args: call?.args }));
  check("the saved-profile probe forces the OS keyring and exact manifest account",
    call?.options?.inheritEnv === false &&
      call?.options?.env?.CLOUDFLARE_AUTH_USE_KEYRING === "true" &&
      call?.options?.env?.CLOUDFLARE_ACCOUNT_ID === accountId,
    JSON.stringify(call?.options?.env));
  check("the saved-profile probe suppresses dotenv and never starts browser authorization",
    call?.args.at(-1) === "--env-file=/dev/null" &&
      !call?.args.includes("--browser") && !call?.args.includes("create") &&
      call?.args.includes("vectorize") && call?.args.includes("list"),
    JSON.stringify(call?.args));
  check("the saved-profile probe scrubs ambient Cloudflare credentials and default-profile selection",
    !["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN",
      "WRANGLER_PROFILE", "NODE_OPTIONS"].some((name) => Object.hasOwn(call?.options?.env || {}, name)) &&
      !JSON.stringify(call).includes(ambientMarker) && !call?.args.includes("default"),
    JSON.stringify(call));

  let invalidSpawned = false;
  const invalid = checkWranglerLogin(accountId, () => {
    invalidSpawned = true;
    return { ok: true, out: "" };
  }, { authProfile: legacyProfile });
  check("an invalid saved profile fails closed without deriving a legacy or default profile",
    invalid.status === FAIL && !invalidSpawned && /no other profile was tried/i.test(invalid.detail),
    JSON.stringify(invalid));
  let invalidThrew = false;
  try { resolveWranglerProfile(accountId, "financial-brain-not-valid"); } catch { invalidThrew = true; }
  check("the shared profile resolver also refuses an invalid saved value",
    invalidThrew && resolveWranglerProfile(accountId, undefined) === legacyProfile);

  const windowsCalls = [];
  const windows = checkWranglerLogin(accountId, (_command, args, options) => {
    windowsCalls.push({ args, options });
    return { ok: true, out: "[]" };
  }, {
    authProfile: exactProfile,
    platformName: "win32",
    environment: { Path: "C:\\fixture\\bin", USERPROFILE: "C:\\Users\\fixture" },
  });
  check("the Windows saved-profile probe uses NUL while remaining browser-free",
    windows.status === OK && windowsCalls[0]?.args.at(-1) === "--env-file=NUL" &&
      !windowsCalls[0]?.args.includes("--browser") &&
      windowsCalls[0]?.options?.env?.CLOUDFLARE_AUTH_USE_KEYRING === "true" &&
      windowsCalls[0]?.options?.env?.Path === "C:\\fixture\\bin",
    JSON.stringify(windowsCalls[0]));
}

/* ---- runAll distinguishes normal OAuth from legacy token recovery ---- */
{
  const accountId = "e".repeat(32);
  const exactProfile = `financial-brain-${"2b".repeat(12)}`;
  const calls = [];
  const healthyTool = (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes("vectorize")) return { ok: true, out: "[]" };
    if (args.includes(WRANGLER_PACKAGE)) return { ok: true, out: "wrangler 4.127.1" };
    if (args.includes("status")) return { ok: true, out: "signed in" };
    return { ok: true, out: "2.1.63 (Claude Code)" };
  };
  const networkCheck = async () => ({ name: "Network", status: OK, detail: "fixture reachable" });
  const oauthChecks = await runAll({
    accountId,
    cloudflareAuthProfile: exactProfile,
    cloudflareToken: undefined,
    googleStorageStatus: { exists: false, description: "fixture secure storage" },
    localRun: healthyTool,
    networkCheck,
  });
  check("runAll treats a saved OAuth profile as the normal credential without a missing-token failure",
    !oauthChecks.some((item) => item.name === "Cloudflare token") &&
      oauthChecks.some((item) => item.name === "wrangler login" && item.status === OK) &&
      !oauthChecks.some((item) => item.name === "Vectorize"),
    JSON.stringify(oauthChecks));
  const vectorCall = calls.find((call) => call.args.includes("vectorize"));
  check("runAll passes the saved profile exactly into its browser-free diagnostic",
    vectorCall?.args[vectorCall.args.indexOf("--profile") + 1] === exactProfile &&
      !vectorCall?.args.includes("--browser") && vectorCall?.args.at(-1) === "--env-file=/dev/null",
    JSON.stringify(vectorCall));

  calls.length = 0;
  const localOnly = await runAll({
    accountId,
    cloudflareAuthProfile: exactProfile,
    cloudflareToken: "fixture-unused-token",
    googleStorageStatus: { exists: false, description: "fixture secure storage" },
    localRun: healthyTool,
    networkCheck,
    skipCloudflare: true,
  });
  check("skipCloudflare runs local readiness while omitting every credential and Vectorize probe",
    localOnly.some((item) => item.name === "Node") &&
      localOnly.some((item) => item.name === "wrangler") &&
      localOnly.some((item) => item.name === "Network") &&
      localOnly.some((item) => item.name === "Claude Code") &&
      !localOnly.some((item) => ["Cloudflare token", "Vectorize", "wrangler login"].includes(item.name)) &&
      !calls.some((call) => call.args.includes("vectorize")),
    JSON.stringify(localOnly));
}
{
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const v = await checkVectorizeApi("0000");
  check("a missing token skips the API probe with a useful warning", v.status === WARN && /token is missing/.test(v.detail), JSON.stringify(v));
  check("the missing-token remedy uses hidden entry rather than shell history",
    /brain setup.*brain update.*hidden token entry/is.test(v.fix) &&
      !/export\s+CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_TOKEN\s*=\s*['\"]/i.test(v.fix), v.fix);
  const tokenCheck = await checkCfToken();
  check("doctor's required-token fix never prints a pasteable token command",
    tokenCheck.status === FAIL && /without echo|secret manager/i.test(tokenCheck.fix) &&
      !/export\s+CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_TOKEN\s*=\s*['\"]/i.test(tokenCheck.fix), tokenCheck.fix);
  // A token that has no token to recreate should never be told to recreate one.
  check("the no-token remedy does not tell you to RECREATE a token you do not have",
    !/Recreate the account-scoped token/i.test(tokenCheck.fix), tokenCheck.fix);
  check("and it does not call it the CLIENT's account, which the owner may be reading",
    !/CLIENT's account/.test(tokenCheck.fix), tokenCheck.fix);
  const accountId = "c".repeat(32);
  const active = { success: true, result: { status: "active" } };
  const rejected = { success: false, errors: [{ code: 9109, message: "Invalid access token" }] };
  const fixtureResponse = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

  const userCalls = [];
  const userOwned = await checkCfToken("fixture-user-owned-token", {
    accountId,
    fetchImpl: async (url) => {
      userCalls.push(url);
      return fixtureResponse(200, active);
    },
  });
  check("a valid user-owned token passes through the user-scoped verification path",
    userOwned.status === OK && /user-owned/.test(userOwned.detail) &&
      userCalls.length === 5 && /\/user\/tokens\/verify$/.test(userCalls[0]) &&
      userCalls.slice(1).every((url) => url.includes(`/accounts/${accountId}/`)),
    JSON.stringify({ userOwned, userCalls }));

  const accountCalls = [];
  const accountOwned = await checkCfToken("fixture-account-owned-token", {
    accountId,
    fetchImpl: async (url) => {
      accountCalls.push(url);
      return /\/user\/tokens\/verify$/.test(url)
        ? fixtureResponse(403, rejected)
        : fixtureResponse(200, active);
    },
  });
  check("a valid account-owned token survives the user-endpoint rejection and passes account-scoped verification",
    accountOwned.status === OK && /account-owned/.test(accountOwned.detail) &&
      accountCalls[1] === `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify` &&
      accountCalls.length === 6,
    JSON.stringify({ accountOwned, accountCalls }));

  const capabilityCalls = [];
  const validAccountToken = await checkCfToken("fixture-valid-account-token", {
    accountId,
    fetchImpl: async (url) => {
      capabilityCalls.push(url);
      if (/\/tokens\/verify$/.test(url)) return fixtureResponse(403, rejected);
      return fixtureResponse(200, { success: true, result: [] });
    },
  });
  check("an account token is not falsely rejected when both token-verification endpoints reject it",
    validAccountToken.status === OK && /four required account surfaces/i.test(validAccountToken.detail) &&
      capabilityCalls.length === 6,
    JSON.stringify({ validAccountToken, capabilityCalls }));

  const invalidCalls = [];
  const invalid = await checkCfToken("fixture-invalid-token", {
    accountId,
    fetchImpl: async (url) => {
      invalidCalls.push(url);
      return fixtureResponse(403, rejected);
    },
  });
  check("an unproven token fails closed only after read-only account capability probes",
    invalid.status === FAIL && invalidCalls.length === 6 && /required account capabilities are unavailable/i.test(invalid.detail),
    JSON.stringify({ invalid, invalidCalls }));
  check("a verification rejection alone is never rendered as an invalid-token verdict",
    /not declared invalid/i.test(invalid.fix) && !/this token.*invalid/i.test(invalid.detail), invalid.fix);

  const ownershipUnknown = await checkCfToken("fixture-account-owned-token", {
    fetchImpl: async () => fixtureResponse(403, rejected),
  });
  check("without an account id a user-endpoint rejection is indeterminate, not a false invalid-token failure",
    ownershipUnknown.status === WARN && /account-owned token/i.test(ownershipUnknown.detail),
    JSON.stringify(ownershipUnknown));
  if (saved) process.env.CLOUDFLARE_API_TOKEN = saved;
}
{
  const vectorAccount = "0".repeat(32);
  const v = checkVectorize(vectorAccount, () => ({ ok: true, out: JSON.stringify({ indexes: [] }) }));
  // Three legitimate outcomes, and the middle one is the point: a login that can
  // see several accounts is NOT a billing problem, and saying so would send
  // someone to buy a plan they may already have.
  if (v.status === WARN) {
    check("a multi-account login is a warning, not a plan failure", /several Cloudflare accounts/.test(v.detail), v.detail);
    check("and it says how to choose one", /CLOUDFLARE_ACCOUNT_ID/.test(v.fix), v.fix);
  } else if (v.status === FAIL) {
    // The failure looks like a billing problem and is usually a plan problem;
    // the text has to name the plan or people go hunting in the wrong place.
    check("the Vectorize fix names the Workers Paid plan", /Workers Paid/i.test(v.fix), v.fix);
    check("and says what is lost without it", /repeat the words/i.test(v.fix), v.fix);
  } else {
    check("Vectorize reachable on this machine", v.status === OK);
  }
}

/* ---- summary ---- */
{
  const s = summarize([{ status: OK }, { status: WARN }, { status: WARN }, { status: FAIL }]);
  check("summary counts each severity", s.ok === 1 && s.warnings === 2 && s.fatal === 1, JSON.stringify(s));
}

/* ---- environment handling. Each of these was a real defect. ---- */
{
  const ambient = {
    PATH: process.env.PATH || "/usr/bin",
    HOME: "/Users/fixture",
    CLOUDFLARE_ACCOUNT_ID: "ambient-account",
    ADMIN_KEY: "admin-secret",
    BRAIN_KEY: "legacy-secret",
    CLOUDFLARE_API_TOKEN: "cloudflare-secret",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NODE_OPTIONS: "--require=/tmp/untrusted.js",
  };
  const clean = localToolEnvironment(ambient);
  check("local CLI children keep PATH and HOME", clean.PATH === ambient.PATH && clean.HOME === ambient.HOME);
  check("local CLI children keep a non-secret exported Cloudflare account id",
    clean.CLOUDFLARE_ACCOUNT_ID === "ambient-account");
  check("local CLI children drop ambient admin and provider credentials",
    !["ADMIN_KEY", "BRAIN_KEY", "CLOUDFLARE_API_TOKEN", "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY"].some((name) => Object.hasOwn(clean, name)),
    JSON.stringify(Object.keys(clean)));
  check("local CLI children drop ambient Node code-injection options",
    !Object.hasOwn(clean, "NODE_OPTIONS"), JSON.stringify(Object.keys(clean)));

  const cloudflare = cloudflareCliEnvironment("chosen-account", ambient);
  check("Cloudflare CLI children receive the explicitly chosen account",
    cloudflare.CLOUDFLARE_ACCOUNT_ID === "chosen-account");
  check("Cloudflare CLI children never receive the ambient API token",
    !Object.hasOwn(cloudflare, "CLOUDFLARE_API_TOKEN"));

  const probe = run(process.execPath, ["-e", [
    "console.log(JSON.stringify({",
    "  path: !!process.env.PATH,",
    "  admin: !!process.env.ADMIN_KEY,",
    "  cf: !!process.env.CLOUDFLARE_API_TOKEN",
    "}))",
  ].join("\n")], { inheritEnv: false, env: clean });
  const seen = JSON.parse(probe.out.trim());
  check("the scrubbed environment is the environment the child actually sees",
    seen.path === true && seen.admin === false && seen.cf === false, probe.out);

  const stdinProbe = run(process.execPath, ["-e", [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => console.log(JSON.stringify({",
    "  marker: process.env.BRAIN_ADMIN_KEY_STDIN,",
    "  envKey: !!process.env.BRAIN_ADMIN_KEY,",
    "  input: input.trim() === 'fixture-admin-key'",
    "})));",
  ].join("\n")], {
    inheritEnv: false,
    env: localToolEnvironment(ambient, { BRAIN_ADMIN_KEY_STDIN: "1" }),
    input: Buffer.from("fixture-admin-key\n", "utf8"),
  });
  const stdinSeen = JSON.parse(stdinProbe.out.trim());
  check("run can pipe a required secret without putting it in the child environment",
    stdinSeen.marker === "1" && stdinSeen.envKey === false && stdinSeen.input === true, stdinProbe.out);
}
{
  const show = (v, e) => run("node", ["-e", `console.log(process.env.${v} || "(absent)")`], { env: e }).out.trim();

  process.env.ZZ_USER_SET = "USERSET";
  // Passing a key as undefined means DELETE. That is intended for the API token,
  // because wrangler prefers it when set and would authenticate as the wrong
  // identity. It is wrong for anything the user deliberately exported, and the
  // first version could not tell the two apart.
  check("an explicit undefined deletes the key", show("ZZ_USER_SET", { ZZ_USER_SET: undefined }) === "(absent)");
  check("a key simply not mentioned is preserved", show("ZZ_USER_SET", { OTHER: "1" }) === "USERSET");
  check("an explicit value is passed through", show("ZZ_X", { ZZ_X: "set" }) === "set");
  check("a non-string value is stringified, not dropped", show("ZZ_N", { ZZ_N: 42 }) === "42");
  delete process.env.ZZ_USER_SET;
}
{
  // The regression: `brain doctor` with no manifest passed accountId=undefined
  // straight through, deleting the client's own exported account id and leaving
  // wrangler unable to choose between their accounts.
  process.env.CLOUDFLARE_ACCOUNT_ID = "USERSET";
  const l = checkWranglerLogin(undefined, () => { throw new Error("should not spawn without an account id"); });
  check("checking login without a manifest does not clobber the user's account id",
    process.env.CLOUDFLARE_ACCOUNT_ID === "USERSET" && !!l.status);
  const probe = run("node", ["-e", "console.log(process.env.CLOUDFLARE_ACCOUNT_ID || '(absent)')"], {
    inheritEnv: false,
    env: cloudflareCliEnvironment(undefined),
  });
  check("and a child process still sees it", probe.out.trim() === "USERSET", probe.out.trim());
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
}
{
  // Not runnable off Windows, but the shape is assertable: a path with a space
  // must survive as ONE argument.
  const r = run("node", ["-e", "console.log(process.argv[1])", "/tmp/a path/with space.mjs"]);
  check("an argument containing spaces stays one argument", r.out.trim() === "/tmp/a path/with space.mjs", r.out.trim());
}

console.log(fail ? `\n${fail} FAILURES` : `\ndoctor: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
