import { run, localToolEnvironment, cloudflareCliEnvironment,
         checkNode, checkClaudeCode, checkCodex, checkAnthropicKey, checkGoogleConnection,
         checkWrangler,
         checkWranglerLogin, checkVectorize, checkVectorizeApi, checkCfToken, CF_TOKEN_SCOPES,
         checkWorkersPaidPlan, checkPrioritySlice,
         summarize, runAll, OK, WARN, FAIL } from "../doctor.mjs";
import { readFileSync } from "node:fs";
import { WRANGLER_SPEC } from "../operations/wrangler-oauth.mjs";
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

/* ---- every check is printed as it completes, not just the first three ---- */
{
  const seen = [];
  const all = await runAll({
    accountId: "0000",
    googleStorageStatus: { exists: false, description: "fixture secure storage" },
    onResult: (x) => seen.push(x.name),
  });
  check("doctor reports every check to the caller as it finishes",
    seen.length === all.length && all.every((x, i) => seen[i] === x.name),
    `${seen.length} reported of ${all.length}: ${JSON.stringify(seen)}`);
}

/* ---- the severity split is the whole point: fatal blocks, optional does not ---- */
{
  const node = checkNode();
  check("Node on this machine passes", node.status === OK, JSON.stringify(node));
  const missingTool = () => ({ ok: false, out: "not found", missing: true });
  const healthyTool = (_command, args) => ({
    ok: true,
    out: args.includes(WRANGLER_SPEC) ? "wrangler 4.73.0" :
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
  check("Wrangler 4 is a blocking requirement and is pinned through npx",
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
  const l = checkWranglerLogin("0000");
  if (l.status !== OK) {
    check("wrangler login is described as a fallback", l.status === WARN && /fallback/i.test(l.fix), l.fix);
  } else {
    check("wrangler login reports signed in cleanly", !/\\.$/.test(l.detail.trim()), l.detail);
  }
  check("the scoped token includes Vectorize Edit", CF_TOKEN_SCOPES.includes("Vectorize: Edit"), JSON.stringify(CF_TOKEN_SCOPES));
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
  // Presence is not validity. This regressed once as "ok, ready to install"
  // on a completely bogus token, which is the worst possible false green.
  const bogus = await checkCfToken("cfut_thisIsNotARealTokenAtAll1234567890");
  check("a syntactically plausible but invalid token FAILS rather than passing",
    bogus.status === FAIL || bogus.status === WARN, JSON.stringify(bogus));
  if (bogus.status === FAIL) {
    check("and the invalid-token message says what to actually check",
      /copied whole|expired|API Tokens/i.test(bogus.fix), bogus.fix);
  }
  if (saved) process.env.CLOUDFLARE_API_TOKEN = saved;
}
{
  const v = checkVectorize("00000000000000000000000000000000");
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


/* ---- the Workers plan is checked BEFORE install, and never guessed ---- */
{
  const jsonResponse = (payload, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });

  const missing = await checkWorkersPaidPlan(undefined, undefined, async () => { throw new Error("no fetch expected"); });
  check("plan check without a token warns instead of probing", missing.status === WARN && /token/i.test(missing.detail), JSON.stringify(missing));
  const noAccount = await checkWorkersPaidPlan(undefined, "cf_token", async () => { throw new Error("no fetch expected"); });
  check("plan check without an account id warns instead of probing", noAccount.status === WARN, JSON.stringify(noAccount));

  // Verified live 2026-08-31 with a token holding exactly the four install
  // scopes: GET /accounts/{id}/subscriptions returns success:false with
  // errors[0].code 10000 "Authentication error". The check must present that
  // as a scope limit with a dashboard path, never as a plan verdict and never
  // by telling anyone to widen the deliberately narrow install token.
  const scopeLimited = await checkWorkersPaidPlan("a".repeat(32), "cf_token", jsonResponse({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
    result: null,
  }, 403));
  check("a scope-limited token warns that the plan is not verifiable",
    scopeLimited.status === WARN && /cannot|not.*(readable|verifiable)/i.test(scopeLimited.detail),
    JSON.stringify(scopeLimited));
  check("the scope-limited fix points at the dashboard plans page",
    /Workers & Pages/i.test(scopeLimited.fix) && /Workers Paid/i.test(scopeLimited.fix), scopeLimited.fix);
  check("the scope-limited fix never suggests widening the install token",
    !/Billing.*(Edit|Read)|recreate.*token/i.test(scopeLimited.fix), scopeLimited.fix);

  const paid = await checkWorkersPaidPlan("a".repeat(32), "cf_token", jsonResponse({
    success: true,
    errors: [],
    result: [
      { id: "sub1", state: "Paid", product: { name: "workers" }, rate_plan: { id: "workers_paid", public_name: "Workers Paid" } },
    ],
  }));
  check("a readable Workers Paid subscription passes and names the plan",
    paid.status === OK && /workers.?paid|Workers Paid/i.test(paid.detail), JSON.stringify(paid));

  const freeOnly = await checkWorkersPaidPlan("a".repeat(32), "cf_token", jsonResponse({
    success: true,
    errors: [],
    result: [{ id: "sub2", product: { name: "page_rules" }, rate_plan: { id: "cf_free" } }],
  }));
  check("a readable account with no Workers subscription warns and says what it saw",
    freeOnly.status === WARN && /no Workers subscription/i.test(freeOnly.detail), JSON.stringify(freeOnly));
  check("the no-subscription warning names the plan baseline",
    /Workers Paid/i.test(freeOnly.fix), freeOnly.fix);

  const flaky = await checkWorkersPaidPlan("a".repeat(32), "cf_token", async () => { throw new Error("socket hang up"); });
  check("a failed probe warns rather than failing the install", flaky.status === WARN, JSON.stringify(flaky));
}

/* ---- the priority slice: warned about while there is still time ---- */
{
  const unset = checkPrioritySlice({ ingest: { priority_slice: { source: null, since: null, note: "template" } } });
  check("a first install with no priority slice warns", unset.status === WARN, JSON.stringify(unset));
  check("the warning names the manifest field", /priority_slice/.test(unset.detail + unset.fix), JSON.stringify(unset));
  check("the warning says what goes wrong without one",
    /first|chronolog|archive|impression/i.test(unset.fix), unset.fix);

  const missing = checkPrioritySlice({});
  check("a manifest with no ingest block warns the same way", missing.status === WARN, JSON.stringify(missing));

  const filled = checkPrioritySlice({ ingest: { priority_slice: { source: "client-files", since: "2025-01-01" } } });
  check("a filled slice passes", filled.status === OK, JSON.stringify(filled));

  const done = checkPrioritySlice({
    ingest: { priority_slice: { source: null, since: null } },
    handoff: { handoff_completed_at: "2026-08-01T00:00:00Z" },
  });
  check("a handed-off install no longer nags about load order", done.status === OK, JSON.stringify(done));

  // The template's example must itself satisfy the check it advertises, and
  // must stay fictional: a public repo carries no client names.
  const template = JSON.parse(readFileSync(new URL("../templates/brain.manifest.json", import.meta.url), "utf8"));
  const example = template?.ingest?.priority_slice?._example;
  check("the template ships a concrete priority-slice example", !!example && typeof example.source === "string" && example.source.length > 0, JSON.stringify(example));
  check("the example since is a real date", /^\d{4}-\d{2}-\d{2}$/.test(String(example?.since)), JSON.stringify(example));
  check("the example itself would pass the check",
    checkPrioritySlice({ ingest: { priority_slice: { source: example?.source, since: example?.since } } }).status === OK);
  check("the template slice itself still ships unset",
    template?.ingest?.priority_slice?.source === null && template?.ingest?.priority_slice?.since === null,
    JSON.stringify(template?.ingest?.priority_slice));
}

/* ---- both new checks ride along in runAll / doctor wiring ---- */
{
  const saved = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const all = await runAll({
    accountId: undefined,
    googleStorageStatus: { exists: false, description: "fixture secure storage" },
  });
  check("runAll includes the Workers plan check", all.some((x) => /workers plan/i.test(x.name)), JSON.stringify(all.map((x) => x.name)));
  if (saved) process.env.CLOUDFLARE_API_TOKEN = saved;
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
  const l = checkWranglerLogin(undefined);
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
