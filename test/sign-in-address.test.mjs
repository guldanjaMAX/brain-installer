/**
 * One brain, two front doors.
 *
 * WHAT THIS IS DEFENDING, measured on a live install on 2026-08-28
 *
 * `brain deploy` enables the workers.dev route so that a deploy has a URL to be
 * verified against. Adding a custom domain later does not remove it, so the
 * worker answers on BOTH hostnames with the identical route set: /api/admin/*,
 * /app and /auth/* all reply on each.
 *
 * A passkey does not work that way. worker/src/lib/owner-auth.js sets
 * `const rpId = url.hostname`, so a credential belongs to the hostname it was
 * enrolled on, and the browser treats the other address as an unrelated site:
 * no key offered, no explanation given. The CLI compounds it, because
 * `m.brain.domain` is the base for every link it prints, `brain invite`
 * included. An owner whose manifest still names workers.dev enrols there and
 * then signs in nowhere on the custom domain they actually use.
 *
 * So these tests pin four things, in this order of importance:
 *   1. the two-hostname state is detected, and the wording names BOTH addresses
 *      and says which is which, because "you have two" is useless without them;
 *   2. a one-hostname install is NOT warned about, because a check that fires on
 *      every healthy brain is one an operator learns to scroll past, and that is
 *      its own failure;
 *   3. an install where the hostnames cannot be listed says so rather than
 *      passing, per the four-outcome rule this file's module is built on;
 *   4. the remedy names the moment to act: BEFORE devices are enrolled.
 *
 * Every name and domain here is invented. This repository is public.
 */
import { writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSignInAddress, normalizeHostname, checkInstallStateChecks,
  OK, WARN, FAIL, CANNOT_CHECK,
} from "../doctor.mjs";
import { probeBrainHostnames } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const CUSTOM = "brain.example.test";
const WORKERS_DEV = "rivera-brain.example-account.workers.dev";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-sign-in-address-")));
const manifestAt = (name, domain) => {
  const path = join(sandbox, name);
  writeFileSync(path, JSON.stringify({
    client: { slug: "rivera", name: "Rivera Fixture Co" },
    brain: { worker_name: "rivera-brain", domain },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-database", storage: "d1" } },
  }));
  return path;
};

/* ================================================================== */
/* 1. Two hostnames answer. This is the live defect.                   */
/* ================================================================== */
{
  const found = checkSignInAddress({
    checked: true,
    manifestHost: WORKERS_DEV,
    hosts: [
      { host: CUSTOM, kind: "custom domain" },
      { host: WORKERS_DEV, kind: "workers.dev, enabled by deploy" },
    ],
  });
  check("two live hostnames are detected", found.status === WARN, JSON.stringify(found));
  check("and it is not silently a pass", found.status !== OK, found.status);
  check("and it is not a blocker, because nothing is broken yet", found.status !== FAIL, found.status);

  // "You have two addresses" is useless without saying which two.
  // `remedy` rather than found.fix directly: a check disabled at the wrong place
  // returns no remedy at all, and a crash here would hide WHICH assertion broke.
  const remedy = String(found.fix || "");
  check("the wording names the custom domain", remedy.includes(CUSTOM), remedy);
  check("the wording names the workers.dev address", remedy.includes(WORKERS_DEV), remedy);
  check("and labels which is which",
    /custom domain/.test(remedy) && /workers\.dev/.test(remedy), remedy);
  check("and says which one the manifest names, since that is where invite links go",
    /the manifest names this one/.test(remedy), remedy);

  // The whole reason this is worth a check at all.
  check("it states plainly that a passkey works on only one of them",
    /passkey is bound to the hostname it was created on/i.test(remedy) &&
      /cannot sign in at the other/i.test(remedy), remedy);
  check("and that the browser explains nothing", /offers no key/i.test(remedy), remedy);
  check("the summary line already carries the point without opening the remedy",
    /passkey works on only one of them/i.test(found.detail), found.detail);

  // The timing is the actionable part: re-enrolling later is the expensive bit.
  check("it says to settle on one address BEFORE anyone enrols a device",
    /Settle on ONE address BEFORE anyone enrols a device/.test(remedy), remedy);
  check("and says why later is worse",
    /every device has to enrol again/i.test(remedy), remedy);
  check("keeping the manifest address is spelled out", remedy.includes(`To keep ${WORKERS_DEV}`), remedy);
  check("and so is switching to the other one", remedy.includes(`To keep ${CUSTOM} instead`), remedy);
}

/* ================================================================== */
/* 2. One hostname. It MUST stay quiet.                                */
/* ================================================================== */
{
  const custom = checkSignInAddress({
    checked: true,
    manifestHost: CUSTOM,
    hosts: [{ host: CUSTOM, kind: "custom domain" }],
  });
  check("a single custom domain passes", custom.status === OK, JSON.stringify(custom));
  check("and does not mention passkeys at all", !/passkey/i.test(JSON.stringify(custom)), JSON.stringify(custom));

  const dev = checkSignInAddress({
    checked: true,
    manifestHost: WORKERS_DEV,
    hosts: [{ host: WORKERS_DEV, kind: "workers.dev, enabled by deploy" }],
  });
  check("a workers.dev-only install passes too", dev.status === OK, JSON.stringify(dev));

  // Spelling differences are not a second hostname.
  const noisy = checkSignInAddress({
    checked: true,
    manifestHost: `HTTPS://${CUSTOM.toUpperCase()}/`,
    hosts: [{ host: `${CUSTOM}.`, kind: "custom domain" }, { host: `https://${CUSTOM}:443`, kind: "custom domain" }],
  });
  check("scheme, case, port, trailing slash and trailing dot are the same address",
    noisy.status === OK, JSON.stringify(noisy));
  check("normalizeHostname strips all of it",
    normalizeHostname("HTTPS://Brain.Example.Test:443/app?x=1") === CUSTOM,
    normalizeHostname("HTTPS://Brain.Example.Test:443/app?x=1"));
}

/* ================================================================== */
/* 3. Unknown is not the same as fine.                                 */
/* ================================================================== */
{
  const blind = checkSignInAddress({ checked: false, reason: "no Cloudflare access from here: token missing" });
  check("an unlistable install reports CANNOT CHECK, not PASS", blind.status === CANNOT_CHECK, JSON.stringify(blind));
  check("and carries a manual step, which assertHonest requires",
    typeof blind.manual === "string" && blind.manual.trim().length > 0, blind.manual);
  check("that names the exact dashboard page",
    /Workers & Pages > the brain worker > Settings > Domains & Routes/.test(blind.manual), blind.manual);
  check("and still explains the passkey consequence, so the manual step has a reason",
    /passkey is bound to the hostname it was created on/i.test(blind.manual), blind.manual);
  check("the detail says it was not checked", /^not checked:/.test(blind.detail), blind.detail);

  const noDomain = checkSignInAddress({ checked: true, manifestHost: "", hosts: [{ host: CUSTOM }] });
  check("a manifest with no address yet is CANNOT CHECK, not a pass",
    noDomain.status === CANNOT_CHECK, JSON.stringify(noDomain));
  check("and points at brain deploy", /brain deploy <manifest>/.test(noDomain.manual), noDomain.manual);

  const noRoutes = checkSignInAddress({ checked: true, manifestHost: CUSTOM, hosts: [] });
  check("no listable route at all is CANNOT CHECK, not a clean bill of health",
    noRoutes.status === CANNOT_CHECK, JSON.stringify(noRoutes));
}

/* ================================================================== */
/* 4. The worse shape: the manifest names an address nothing routes.   */
/* ================================================================== */
{
  const orphan = checkSignInAddress({
    checked: true,
    manifestHost: WORKERS_DEV,
    hosts: [{ host: CUSTOM, kind: "custom domain" }],
  });
  check("a manifest address that is not among the live routes is still flagged",
    orphan.status === WARN, JSON.stringify(orphan));
  const orphanFix = String(orphan.fix || "");
  check("and is named as the worse case, because invite links may lead nowhere",
    /NOT among the routes this/.test(orphanFix) && /may lead nowhere at all/.test(orphanFix), orphanFix);
  check("both addresses are still named", orphanFix.includes(CUSTOM) && orphanFix.includes(WORKERS_DEV), orphanFix);
}

/* ================================================================== */
/* 5. The probe: it asks the account, and it never guesses.            */
/* ================================================================== */
{
  const manifestPath = manifestAt("workers-dev.manifest.json", WORKERS_DEV);
  const calls = [];
  const probe = await probeBrainHostnames(manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    cf: async (path) => {
      calls.push(path);
      if (/\/workers\/domains\?/.test(path)) return [{ hostname: CUSTOM, service: "rivera-brain" }];
      if (/\/workers\/scripts\/.*\/subdomain$/.test(path)) return { enabled: true };
      if (/\/workers\/subdomain$/.test(path)) return { subdomain: "example-account" };
      return null;
    },
  });
  check("the probe reads both the custom domains and the workers.dev route",
    probe.checked === true && probe.hosts.length === 2, JSON.stringify(probe));
  check("it asks about THIS worker's domains, not the whole account",
    calls.some((p) => /service=rivera-brain/.test(p)), JSON.stringify(calls));
  check("the workers.dev hostname is built from the account's own subdomain",
    probe.hosts.some((h) => h.host === WORKERS_DEV), JSON.stringify(probe.hosts));

  const live = checkSignInAddress(probe);
  check("end to end, a manifest on workers.dev beside a custom domain warns",
    live.status === WARN, JSON.stringify(live));
  check("and the warning names both hostnames",
    String(live.fix || "").includes(CUSTOM) && String(live.fix || "").includes(WORKERS_DEV), live.fix);
}
{
  // The route is off: one address, and the check must not invent a second.
  const manifestPath = manifestAt("custom-only.manifest.json", CUSTOM);
  const probe = await probeBrainHostnames(manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    cf: async (path) => {
      if (/\/workers\/domains\?/.test(path)) return [{ hostname: CUSTOM }];
      if (/\/workers\/scripts\/.*\/subdomain$/.test(path)) return { enabled: false };
      throw new Error("the account subdomain must not be read when the route is off");
    },
  });
  check("a disabled workers.dev route yields exactly one hostname",
    probe.checked === true && probe.hosts.length === 1, JSON.stringify(probe));
  check("and the check stays green", checkSignInAddress(probe).status === OK, JSON.stringify(checkSignInAddress(probe)));
}
{
  // Tolerance, the same rule probeUpgradePause follows: never the reason
  // `brain doctor` dies, and never a false green.
  const manifestPath = manifestAt("no-token.manifest.json", CUSTOM);
  const noToken = await probeBrainHostnames(manifestPath, {
    resolveAccount: async () => { throw new Error("CLOUDFLARE_API_TOKEN is not set"); },
  });
  check("no Cloudflare access degrades to not-checked rather than throwing",
    noToken.checked === false && /no Cloudflare access from here/.test(noToken.reason), JSON.stringify(noToken));

  const halfRead = await probeBrainHostnames(manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    cf: async (path) => {
      if (/\/workers\/domains\?/.test(path)) return [{ hostname: CUSTOM }];
      throw new Error("synthetic Cloudflare outage");
    },
  });
  check("a PARTIAL listing is not-checked, never a one-hostname pass",
    halfRead.checked === false && /workers\.dev route/.test(halfRead.reason), JSON.stringify(halfRead));
  check("and the resulting check admits it rather than passing",
    checkSignInAddress(halfRead).status === CANNOT_CHECK, JSON.stringify(checkSignInAddress(halfRead)));

  const missing = await probeBrainHostnames(join(sandbox, "does-not-exist.json"), {});
  check("a missing manifest is reported, never thrown",
    missing.checked === false && /manifest could not be read/.test(missing.reason), JSON.stringify(missing));
}

/* ================================================================== */
/* 6. Named early, so the decision is made before devices exist.       */
/* ================================================================== */
{
  const pending = checkInstallStateChecks(false).find((x) => x.name === "Sign-in address");
  check("preinstall lists the address decision as pending, not omitted", Boolean(pending),
    JSON.stringify(checkInstallStateChecks(false).map((x) => x.name)));
  check("and as CANNOT CHECK, because there is no install to look at yet",
    pending?.status === CANNOT_CHECK, JSON.stringify(pending));
  check("and it tells the operator to decide the single address with the client now",
    /which single address their brain lives at/.test(pending?.manual || ""), pending?.manual);
  check("and warns that deciding later means re-enrolling every device",
    /Deciding later means re-enrolling every device, one at a time/.test(pending?.manual || ""), pending?.manual);
  check("and says a passkey is bound to the hostname it was enrolled on",
    /bound to the exact\n  hostname it was enrolled on/.test(pending?.manual || ""), pending?.manual);
  check("and names when it can actually be checked", /brain doctor <manifest>/.test(pending?.manual || ""), pending?.manual);
  check("it disappears once an install exists",
    !checkInstallStateChecks(true).some((x) => x.name === "Sign-in address"));
}

console.log(fail ? `\n${fail} FAILURES` : `\nsign-in address: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
