import { run, localToolEnvironment, cloudflareCliEnvironment,
         checkNode, checkClaudeCode, checkCodex, checkAnthropicKey, checkGoogleConnection,
         checkWranglerLogin, checkVectorize, checkVectorizeApi, CF_TOKEN_SCOPES,
         summarize, runAll, OK, WARN, FAIL } from "../doctor.mjs";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ---- every non-ok check MUST carry a fix. A failure without one is half a job. ---- */
{
  const all = await runAll({
    accountId: "0000",
    googleStorageStatus: { exists: false, description: "fixture secure storage" },
  });
  check("doctor runs every check without throwing", all.length >= 7, String(all.length));
  const bad = all.filter((x) => x.status !== OK && !x.fix);
  check("every non-ok check carries remediation text", bad.length === 0, JSON.stringify(bad.map((b) => b.name)));
  check("each check names itself and reports a status", all.every((x) => x.name && [OK, WARN, FAIL].includes(x.status)));
  check("each check says what it saw", all.every((x) => typeof x.detail === "string" && x.detail.length));
}

/* ---- the severity split is the whole point: fatal blocks, optional does not ---- */
{
  const node = checkNode();
  check("Node on this machine passes", node.status === OK, JSON.stringify(node));
  // Claude Code and Codex are how people USE the brain, but an install completes
  // without them, so they must never block one.
  check("Claude Code is never fatal", checkClaudeCode().status !== FAIL);
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
