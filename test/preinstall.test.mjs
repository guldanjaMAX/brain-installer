/**
 * `brain preinstall` — the pre-install readiness report.
 *
 * WHAT THESE TESTS ARE DEFENDING
 *
 * Measured on a bare machine on 2026-08-28, before this mode existed:
 * `brain doctor` with a garbage token and an exported account id printed
 * "ready to install" and exited 0. It did that because the account id only ever
 * arrived from a manifest, so the token-scope probe could not run at all, and
 * because the token check tested for a non-empty string rather than for a token
 * Cloudflare would accept.
 *
 * So the tests below are not about coverage. Each one names a specific way the
 * report could lie to an operator standing in a client's office:
 *   - it refuses to run at all without an install
 *   - a missing permission is silently skipped instead of reported
 *   - a platform's permanent limits go unmentioned until install day
 *   - something unknown is rendered as something confirmed
 *
 * Every fixture name here is invented. This repository is public.
 */
import { readFileSync } from "node:fs";
import {
  runPreinstall, formatPreinstallReport, summarizePreinstall, preinstallExitCode,
  preinstallVerdict, assertHonest, statusTag,
  checkOperatingSystem, platformReadiness, checkCloudflareIdentity, checkCloudflareScopes,
  resolveCloudflareAccount, checkEditPermissions, checkWorkersPaidPlan, checkInstallStateChecks,
  checkCfToken, runAll,
  CF_SCOPE_PROBES, CF_TOKEN_SCOPES, PLATFORM_CAPABILITIES, REQUIRED_NODE_MAJOR,
  OK, WARN, FAIL, CANNOT_CHECK,
} from "../doctor.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const API = "https://api.cloudflare.com/client/v4";
const ACCOUNTS = [{ id: "ac000000000000000000000000000001", name: "Rivera Consulting" }];

/**
 * A Cloudflare that behaves like the real one.
 *
 * The response shapes are the ones measured against the live API on 2026-08-28:
 * a well-formed invalid token gets 403 code 9109 at /accounts, and a resource a
 * token cannot reach returns 401 code 10000 "Authentication error" — the same
 * body a bad token gets, which is exactly why the token has to be settled at
 * /accounts before any scope verdict is possible.
 */
function fakeCloudflare({ accounts = ACCOUNTS, tokenValid = true, denied = [], offline = [] } = {}) {
  const surface = (path) => {
    if (path === "/accounts") return "accounts";
    if (path.includes("/d1/")) return "D1";
    if (path.includes("/workers/scripts")) return "Workers Scripts";
    if (path.includes("/vectorize/")) return "Vectorize";
    if (path.includes("/ai/")) return "Workers AI";
    if (path.includes("/r2/")) return "R2";
    return "unknown";
  };
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  return async (url) => {
    const path = String(url).replace(API, "");
    const which = surface(path);
    if (offline.includes(which)) throw new Error("fetch failed");
    if (!tokenValid) {
      return which === "accounts"
        ? json(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }] })
        : json(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    }
    if (which === "accounts") return json(200, { success: true, result: accounts });
    if (denied.includes(which)) {
      return json(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    }
    return json(200, { success: true, result: [] });
  };
}

const hermetic = (extra = {}) => ({
  environment: {},
  includeWrangler: false,
  networkCheck: async () => ({ name: "Network", status: OK, detail: "fixture: reached api.cloudflare.com" }),
  toolChecks: [],
  googleStorageStatus: { exists: true, description: "fixture secure storage" },
  ...extra,
});

const byName = (checks, name) => checks.find((x) => x.name === name);

/* ================================================================ */
/* 1. It runs at all on the machine that matters: no manifest, no install. */
/* ================================================================ */
{
  const checks = await runPreinstall(hermetic({
    cloudflareToken: "fixture-token-value-0000000000000000000",
    fetchImpl: fakeCloudflare({}),
    hasManifest: false,
    osPlatform: "darwin",
  }));
  check("preinstall produces a report with no manifest and no install", checks.length >= 12, String(checks.length));
  check("it never throws for want of a manifest", Array.isArray(checks));
  check("every check names itself and carries one of the four statuses",
    checks.every((x) => x.name && [OK, WARN, FAIL, CANNOT_CHECK].includes(x.status)),
    JSON.stringify(checks.filter((x) => ![OK, WARN, FAIL, CANNOT_CHECK].includes(x.status))));
  check("every check says what it saw", checks.every((x) => typeof x.detail === "string" && x.detail.length));

  // The whole point of running early: the checks that need an install are named
  // as pending rather than left off the page, so nobody finishes the report
  // believing the bank-feed return address was verified.
  const bank = byName(checks, "Bank feed return address");
  check("a check that needs a deployed brain is listed, not omitted", Boolean(bank), JSON.stringify(checks.map((x) => x.name)));
  check("and it is CANNOT CHECK, not PASS", bank?.status === CANNOT_CHECK, JSON.stringify(bank));
  check("and it names when to run it instead", /brain doctor <manifest>/.test(bank?.manual || ""), bank?.manual);
  check("and it says why it will matter",
    /authorises at their bank and lands on a dead page/i.test(bank?.manual || ""), bank?.manual);

  // Those same checks must disappear once an install exists, or the report would
  // nag forever about something already covered.
  check("install-state checks drop away once a manifest exists", checkInstallStateChecks(true).length === 0);
  check("and are present when it does not", checkInstallStateChecks(false).length >= 3);
}

/* ================================================================ */
/* 2. A missing token scope is REPORTED, not skipped.                */
/* ================================================================ */
{
  const checks = await runPreinstall(hermetic({
    cloudflareToken: "fixture-token-value-0000000000000000000",
    fetchImpl: fakeCloudflare({ denied: ["Vectorize"] }),
    osPlatform: "darwin",
  }));
  const v = byName(checks, "Vectorize");
  check("a token missing one scope FAILS that scope", v?.status === FAIL, JSON.stringify(v));
  check("it is not reported as unchecked or skipped", v?.status !== CANNOT_CHECK && v?.status !== OK, JSON.stringify(v));

  // The 401/10000 body is identical to a bad token's. Settling the token at
  // /accounts first is what lets this be stated as a permission problem.
  check("and it is named as a permission problem, not an auth mystery",
    /the token is valid but cannot reach it/i.test(v?.detail || "") && /Vectorize: Edit is missing/i.test(v?.detail || ""),
    v?.detail);
  check("the fix names the exact scope to add", /Vectorize: Edit/.test(v?.fix || ""), v?.fix);

  // The ordering point: provision creates D1 first, so this is the worst
  // possible scope to discover late.
  check("the Vectorize fix warns that provision creates D1 first",
    /creates the D1 database first/i.test(v?.fix || "") && /BEFORE running provision/i.test(v?.fix || ""), v?.fix);

  check("the scopes that DO work still pass", byName(checks, "D1")?.status === OK && byName(checks, "Workers Scripts")?.status === OK);
  check("one missing scope makes the whole run non-zero", preinstallExitCode(checks) === 1);
  check("and the verdict refuses the word ready",
    !/\bREADY\b/.test(preinstallVerdict(checks).headline.replace("NOT READY", "")), preinstallVerdict(checks).headline);

  // Every required Cloudflare surface the install touches has its own line.
  for (const probe of CF_SCOPE_PROBES) {
    check(`the report carries a line for ${probe.name}`, Boolean(byName(checks, probe.name)));
  }
  check("the probed scopes cover every scope the install token is told to carry",
    CF_TOKEN_SCOPES.every((scope) => CF_SCOPE_PROBES.some((p) => p.scope === scope)),
    JSON.stringify(CF_SCOPE_PROBES.map((p) => p.scope)));
}

/* ---- a token Cloudflare rejects outright is a FAIL, not a pass ---- */
{
  const checks = await runPreinstall(hermetic({
    cloudflareToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    accountId: "ac000000000000000000000000000001",
    fetchImpl: fakeCloudflare({ tokenValid: false }),
    osPlatform: "darwin",
  }));
  const token = byName(checks, "Cloudflare token");
  check("a token Cloudflare rejects is a blocker", token?.status === FAIL, JSON.stringify(token));
  check("and the rejection is quoted rather than paraphrased", /Invalid access token/.test(token?.detail || ""), token?.detail);

  // This is the exact machine state that used to print "ready to install".
  check("a rejected token never yields a ready verdict", preinstallVerdict(checks).ready === false);
  check("and it exits non-zero", preinstallExitCode(checks) === 1);
  check("the scopes below it are unknown, not passed",
    CF_SCOPE_PROBES.every((p) => byName(checks, p.name)?.status === CANNOT_CHECK),
    JSON.stringify(CF_SCOPE_PROBES.map((p) => [p.name, byName(checks, p.name)?.status])));

  // The old behaviour, kept honest at its source. checkCfToken now really asks
  // Cloudflare, so fetch is stubbed here: this assertion is about the wording it
  // returns, and a test must not depend on this machine having a network.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ success: false, errors: [{ message: "Invalid API Token" }] }),
    });
    let detail;
    try {
      detail = (await checkCfToken("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).detail;
    } finally {
      globalThis.fetch = realFetch;
    }
    check("the presence-only token check no longer claims the token works",
      !/available for this command/.test(detail), detail);
  }
}

/* ---- a token that can see several accounts blocks, but is not a failure ---- */
{
  const two = [
    { id: "ac000000000000000000000000000001", name: "Rivera Consulting" },
    { id: "ac000000000000000000000000000002", name: "Nair Studio" },
  ];
  const checks = await runPreinstall(hermetic({
    cloudflareToken: "fixture-token-value-0000000000000000000",
    fetchImpl: fakeCloudflare({ accounts: two }),
    osPlatform: "darwin",
  }));
  const account = byName(checks, "Cloudflare account");
  check("an unresolved account is CANNOT CHECK, not FAIL", account?.status === CANNOT_CHECK, JSON.stringify(account));
  check("and it lists the accounts the token can actually see",
    /Rivera Consulting/.test(account?.manual || "") && /Nair Studio/.test(account?.manual || ""), account?.manual);
  check("and it gives the exact command to settle it",
    /export CLOUDFLARE_ACCOUNT_ID=/.test(account?.manual || ""), account?.manual);
  check("with no account, the scope probes admit they did not run",
    byName(checks, "D1")?.status === CANNOT_CHECK, JSON.stringify(byName(checks, "D1")));

  // Naming an account the token cannot see is a different thing, and is fatal:
  // installing into the wrong account creates real resources in it.
  const wrong = resolveCloudflareAccount({ accountId: "ac0000000000000000000000000000ff", accounts: two });
  check("naming an account this token cannot see is a blocker", wrong.check.status === FAIL, JSON.stringify(wrong.check));
  check("and it warns that the wrong account gets real resources",
    /creates real resources/i.test(wrong.check.fix || ""), wrong.check.fix);

  // The exported id, which doctor's own remedy text tells operators to set.
  const viaEnv = resolveCloudflareAccount({
    accounts: two,
    environment: { CLOUDFLARE_ACCOUNT_ID: "ac000000000000000000000000000002" },
  });
  check("an exported CLOUDFLARE_ACCOUNT_ID is honoured", viaEnv.accountId === "ac000000000000000000000000000002", JSON.stringify(viaEnv.check));
}

/* ================================================================ */
/* 3. An unsupported platform is named, with its real consequences.  */
/* ================================================================ */
{
  const windows = checkOperatingSystem("win32");
  check("Windows is named by name", /Windows/.test(windows.detail), windows.detail);
  check("Windows is not a silent pass", windows.status === WARN, JSON.stringify(windows));

  // Permanent platform fact, and it must read as permanent. A client who is told
  // "not yet" will wait for a release that cannot come.
  check("live iMessage capture is called impossible, not pending",
    /NOT POSSIBLE on this platform, ever/.test(windows.fix) && /Live iMessage capture/.test(windows.fix), windows.fix);
  check("and it says where Apple actually keeps the data",
    /chat\.db/.test(windows.fix) && /macOS and nowhere else/.test(windows.fix), windows.fix);
  check("and it names the fallback that does work on Windows",
    /--from iphone-backup/.test(windows.fix), windows.fix);

  // The consequence that costs a client the most, because it is invisible.
  check("Windows is told that nothing refreshes on its own",
    /Nothing refreshes on its own/.test(windows.fix), windows.fix);
  check("and that a stale brain still reports itself healthy",
    /report itself healthy while going stale/.test(windows.fix), windows.fix);
  check("and it names who has to do the refreshing instead",
    /brain load <manifest>/.test(windows.fix), windows.fix);

  check("an installer gap is distinguished from a platform limit",
    /the capability exists; the supervision for it does not/.test(windows.fix), windows.fix);
  check("Windows is warned the installer's own Windows path is untested there",
    /has not been exercised on a real Windows host/.test(windows.fix), windows.fix);

  const linux = checkOperatingSystem("linux");
  check("Linux is named by name", /Linux/.test(linux.detail), linux.detail);
  check("Linux is told its Google credentials are not encrypted at rest",
    /plain file on disk/.test(linux.fix) && /no OS encryption on this platform/.test(linux.fix), linux.fix);
  check("Linux is told there is no default iPhone-backup location to search",
    /no Apple backup software for Linux/i.test(linux.fix), linux.fix);

  const mac = checkOperatingSystem("darwin");
  check("macOS passes cleanly", mac.status === OK && /every capability is available/.test(mac.detail), JSON.stringify(mac));
  check("and macOS is given no consequences to read out", !mac.fix);

  const r = platformReadiness("win32");
  check("the platform table separates permanent facts from installer gaps",
    r.unavailable.some((x) => x.kind === "permanent") && r.unavailable.some((x) => x.kind === "installer"),
    JSON.stringify(r.unavailable.map((x) => [x.id, x.kind])));
  check("every unavailable capability names something to do instead",
    r.unavailable.every((x) => typeof x.fallback === "string" && x.fallback.length), JSON.stringify(r.unavailable));
  check("every mac-only capability in the table carries a consequence in plain words",
    PLATFORM_CAPABILITIES.every((x) => x.consequence && x.label && x.kind), JSON.stringify(PLATFORM_CAPABILITIES.map((x) => x.id)));

  // The report an operator on Windows actually reads.
  const checks = await runPreinstall(hermetic({
    cloudflareToken: "fixture-token-value-0000000000000000000",
    fetchImpl: fakeCloudflare({}),
    osPlatform: "win32",
  }));
  const text = formatPreinstallReport(checks, { platformName: "Windows" });
  check("the printed Windows report states the platform consequences",
    /Nothing refreshes on its own/.test(text) && /NOT POSSIBLE on this platform, ever/.test(text));
}

/* ================================================================ */
/* 4. A check that cannot run says so. It never passes by default.   */
/* ================================================================ */
{
  const edit = checkEditPermissions();
  check("Read-versus-Edit is admitted as unknowable from here", edit.status === CANNOT_CHECK, JSON.stringify(edit));
  check("and it says why no API can answer it",
    /no API that reports a token's own permission list/i.test(edit.manual), edit.manual);
  check("and it names the exact page to look at instead",
    /dash\.cloudflare\.com > My Profile > API Tokens/.test(edit.manual), edit.manual);
  check("and it warns that Read-where-Edit-belongs passes every check here",
    /passes every check on this page and then fails/i.test(edit.manual), edit.manual);

  const plan = checkWorkersPaidPlan();
  check("the paid tier is admitted as uncheckable", plan.status === CANNOT_CHECK, JSON.stringify(plan));
  check("and it refuses to widen the token just to answer itself",
    /Billing: Read/.test(plan.manual) && /should not have/.test(plan.manual), plan.manual);
  check("and it names the exact dashboard page",
    /Workers & Pages > Plans/.test(plan.manual), plan.manual);
  check("and it warns that Free looks like success until the corpus is real",
    /appear to succeed/.test(plan.manual) && /hard-stop a real/.test(plan.manual), plan.manual);

  // A probe that could not complete must not become a pass.
  const offline = await checkCloudflareScopes(
    "fixture-token-value-0000000000000000000",
    "ac000000000000000000000000000001",
    { fetchImpl: fakeCloudflare({ offline: ["D1"] }) },
  );
  const d1 = offline.find((x) => x.name === "D1");
  check("a probe that could not complete reports CANNOT CHECK", d1?.status === CANNOT_CHECK, JSON.stringify(d1));
  check("and it is not a pass", d1?.status !== OK);
  check("and it names the manual place to confirm the scope",
    /API Tokens/.test(d1?.manual || "") && /D1: Edit/.test(d1?.manual || ""), d1?.manual);

  // The network being down must not silently validate the token either.
  const noNet = await checkCloudflareIdentity("fixture-token-value-0000000000000000000", {
    fetchImpl: async () => { throw new Error("fetch failed"); },
  });
  check("an untestable token is CANNOT CHECK, never PASS", noNet.check.status === CANNOT_CHECK, JSON.stringify(noNet.check));
  check("and it says plainly not to assume the token works",
    /Do NOT treat the token as working/.test(noNet.check.manual), noNet.check.manual);

  /* ---- the invariant, enforced in code and not merely intended ---- */
  check("a CANNOT CHECK without a manual step is rejected by assertHonest", (() => {
    try { assertHonest([{ name: "Silent", status: CANNOT_CHECK, detail: "x" }]); return false; }
    catch (e) { return /without naming a manual step/.test(e.message); }
  })());
  const all = await runPreinstall(hermetic({
    cloudflareToken: "fixture-token-value-0000000000000000000",
    fetchImpl: fakeCloudflare({ denied: ["Vectorize", "R2"] }),
    osPlatform: "win32",
  }));
  check("every CANNOT CHECK in a real run carries a manual step",
    all.filter((x) => x.status === CANNOT_CHECK).every((x) => String(x.manual || "").trim().length > 20),
    JSON.stringify(all.filter((x) => x.status === CANNOT_CHECK && !x.manual).map((x) => x.name)));
  check("every FAIL in a real run carries a fix",
    all.filter((x) => x.status === FAIL).every((x) => String(x.fix || "").trim().length > 20),
    JSON.stringify(all.filter((x) => x.status === FAIL && !x.fix).map((x) => x.name)));
  check("optional R2 is a warning, not a blocker", byName(all, "R2")?.status === WARN, JSON.stringify(byName(all, "R2")));
}

/* ================================================================ */
/* 5. The verdict never goes green over an unchecked item.           */
/* ================================================================ */
{
  const unchecked = [
    { name: "A", status: OK, detail: "" },
    { name: "B", status: CANNOT_CHECK, detail: "", manual: "look here" },
  ];
  const v = preinstallVerdict(unchecked);
  check("one unchecked item is enough to withhold ready", v.ready === false, JSON.stringify(v));
  check("and the headline says so out loud",
    /could NOT be checked from this machine/.test(v.headline), v.headline);
  check("and it refuses to be read as a green light",
    /This is not a green light/.test(v.note), v.note);
  // The screen already distinguishes CANNOT CHECK from PASS. The exit code has
  // to as well, because `brain preinstall && <install>` reads only the number,
  // and a 0 there would move the exact defect this command prevents from the
  // screen to the shell.
  check("an unchecked item is not a blocker, so it is not exit 1",
    preinstallExitCode(unchecked) !== 1, String(preinstallExitCode(unchecked)));
  check("but it is not exit 0 either, because a script must not read it as a green light",
    preinstallExitCode(unchecked) === 2, String(preinstallExitCode(unchecked)));

  const clean = preinstallVerdict([{ name: "A", status: OK, detail: "" }]);
  check("ready is reserved for a run with nothing failed and nothing unchecked", clean.ready === true, JSON.stringify(clean));
  check("and it says nothing was skipped or assumed", /Nothing here was skipped/.test(clean.note), clean.note);
  check("a genuinely clean run is the only thing that exits 0",
    preinstallExitCode([{ name: "A", status: OK, detail: "" }]) === 0);

  const broken = [{ name: "A", status: FAIL, detail: "", fix: "f" }, { name: "B", status: CANNOT_CHECK, detail: "", manual: "m" }];
  check("a blocker outranks an unchecked item in the headline",
    /NOT READY/.test(preinstallVerdict(broken).headline), preinstallVerdict(broken).headline);
  check("and it exits non-zero", preinstallExitCode(broken) === 1);

  const s = summarizePreinstall([
    { status: OK }, { status: WARN }, { status: FAIL }, { status: CANNOT_CHECK }, { status: CANNOT_CHECK },
  ]);
  check("the summary counts unchecked items separately from every other status",
    s.ok === 1 && s.warnings === 1 && s.fatal === 1 && s.unchecked === 2, JSON.stringify(s));
}

/* ================================================================ */
/* 6. The report survives being copied out of a terminal.            */
/* ================================================================ */
{
  const checks = await runPreinstall(hermetic({
    cloudflareToken: "fixture-token-value-0000000000000000000",
    fetchImpl: fakeCloudflare({ denied: ["Vectorize"] }),
    osPlatform: "darwin",
  }));
  const text = formatPreinstallReport(checks, { platformName: "macOS" });
  check("the four outcomes are words, not colours",
    text.includes("PASS") && text.includes("FAIL") && text.includes("CANNOT CHECK") && text.includes("WARN"));
  check("no ANSI escape survives into the report text", !/\x1b\[/.test(text));
  check("CANNOT CHECK is tagged distinctly from PASS and FAIL",
    statusTag(CANNOT_CHECK) === "CANNOT CHECK" && statusTag(OK) === "PASS" && statusTag(FAIL) === "FAIL");
  check("the legend explains what each outcome means",
    /PASS = checked and good/.test(text) && /CANNOT CHECK = unknown from here, do it by hand/.test(text), text.slice(0, 400));
  check("blockers get their own section", /BLOCKERS — this install will fail until these are fixed/.test(text));
  check("unchecked items get their own section, with the manual steps",
    /CANNOT CHECK — nobody knows yet\. Do these by hand before install day/.test(text));
  check("the failing scope appears in the blockers section, not buried",
    text.indexOf("BLOCKERS") < text.lastIndexOf("Vectorize"));
  check("the tally states all four counts", /passed, .* failed, .* warning\(s\), .* not checkable from here/.test(text), text.slice(-300));
}

/* ================================================================ */
/* 7. The two upstream defects this mode was built on top of.        */
/* ================================================================ */
{
  // Six of doctor's eight checks used to bypass the streaming renderer, so a
  // bare machine printed two lines and went quiet.
  const seen = [];
  const all = await runAll({
    accountId: "ac000000000000000000000000000001",
    cloudflareToken: undefined,
    googleStorageStatus: { exists: true, description: "fixture secure storage" },
    onResult: (x) => seen.push(x.name),
  });
  check("every doctor check reaches the caller's renderer, not just the first two",
    seen.length === all.length, `${seen.length} of ${all.length}: ${all.map((x) => x.name).filter((n) => !seen.includes(n)).join(", ")}`);

  // The runtime floor must match what npm will actually enforce.
  const engines = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).engines?.node;
  check("the required Node major matches package.json engines",
    engines === `>=${REQUIRED_NODE_MAJOR}`, `engines.node=${engines}, REQUIRED_NODE_MAJOR=${REQUIRED_NODE_MAJOR}`);
}

const thisTestSource = readFileSync(new URL(import.meta.url), "utf-8");
check("the suite leaves native async handles to close before process exit",
  !thisTestSource.includes("process." + "exit("), "found an immediate process exit");

console.log(fail ? `\n${fail} FAILURES` : `\npreinstall: all ${ran} tests passed`);
process.exitCode = fail ? 1 : 0;
