import { run, checkNode, checkClaudeCode, checkCodex, checkAnthropicKey, checkGoogleConnection,
         checkWranglerLogin, checkVectorize, summarize, runAll, OK, WARN, FAIL } from "../doctor.mjs";
let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 220))); if (!c) fail++; };

/* ---- every non-ok check MUST carry a fix. A failure without one is half a job. ---- */
{
  const all = await runAll({ accountId: "0000" });
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
  check("a missing Anthropic key is a warning, not a blocker", checkAnthropicKey().status !== FAIL);
  check("a missing Google connection is a warning", checkGoogleConnection().status !== FAIL);
}
{
  const k = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const a = checkAnthropicKey();
  check("without a key it warns and says what breaks", a.status === WARN && /NO written answer/.test(a.fix), a.fix);
  process.env.ANTHROPIC_API_KEY = "x";
  check("with a key it passes", checkAnthropicKey().status === OK);
  if (k) process.env.ANTHROPIC_API_KEY = k; else delete process.env.ANTHROPIC_API_KEY;
}

/* ---- the two messages that must not send someone in the wrong direction ---- */
{
  // No API token can reach Vectorize, so a login failure must say the login is
  // REQUIRED rather than reading as an optional convenience.
  const l = checkWranglerLogin("0000");
  if (l.status !== OK) {
    check("the login fix explains why it is required", /no Cloudflare API token/i.test(l.fix), l.fix);
  } else {
    check("wrangler login reports signed in cleanly", !/\\.$/.test(l.detail.trim()), l.detail);
  }
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
  const probe = run("node", ["-e", "console.log(process.env.CLOUDFLARE_ACCOUNT_ID || '(absent)')"], { env: { CLOUDFLARE_API_TOKEN: undefined } });
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
