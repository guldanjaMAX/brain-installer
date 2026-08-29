#!/usr/bin/env node
/**
 * Does the public install page hand clients the release we actually shipped?
 *
 * This repo already guards its own version alignment hard: package.json, the
 * lockfile, the manifest template, the changelog and both README install links
 * are pinned together by test/current-version.test.mjs. None of that reaches
 * the page a client actually follows, which lives in a different repo and
 * hardcodes its own version.
 *
 * On 2026-08-28 that page was pinned to v0.1.16 while v0.1.19 was the latest
 * release, so every client installed a brain with no passkey app and no Golden
 * 20 session. Nothing failed. Nothing warned. This script is the missing alarm.
 *
 * Deliberately NOT part of `npm test`: it needs the network, and the offline
 * suite must stay offline. Run it in the release checklist and on a schedule.
 *
 *   node scripts/check-install-page-version.mjs
 *
 * Exit 0 = page matches the latest release. Exit 1 = drift, or the page could
 * not be read (silence is not proof of health).
 */
const PAGE = "https://financialbrain.ai/install";
const RELEASES = "https://api.github.com/repos/guldanjaMAX/brain-installer/releases/latest";

const get = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers: { "user-agent": "brain-installer-release-check", ...headers },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
};

let latest;
try {
  latest = (await (await get(RELEASES, { accept: "application/vnd.github+json" })).json()).tag_name;
} catch (e) {
  console.error(`\n  Could not read the latest release: ${e.message}\n`);
  process.exit(1);
}

let pinned = null;
try {
  // Cache-bust: the page is a hashed-chunk SPA and a stale bundle reads like
  // a healthy one. The version lives in the chunk, not the HTML shell.
  const html = await (await get(`${PAGE}?cb=${Date.now()}`)).text();
  const chunks = [...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]);
  const ordered = [...chunks.filter((c) => /SetupGuide/i.test(c)), ...chunks];
  for (const path of [...new Set(ordered)]) {
    const js = await (await get(new URL(path, PAGE).href)).text();
    const hit = js.match(/releases\/download\/\$\{([A-Za-z_$][\w$]*)\}/);
    if (hit) {
      const assign = js.match(new RegExp(`\\b${hit[1].replace(/\$/g, "\\$")}\\s*=\\s*\`(v?\\d+\\.\\d+\\.\\d+)\``));
      if (assign) { pinned = assign[1]; break; }
    }
    const direct = js.match(/releases\/download\/(v\d+\.\d+\.\d+)\//);
    if (direct) { pinned = direct[1]; break; }
  }
} catch (e) {
  console.error(`\n  Could not read the install page: ${e.message}\n`);
  process.exit(1);
}

if (!pinned) {
  console.error("\n  Could not find a pinned version on the install page.\n" +
    "  The page may have been restructured. Check it by hand before shipping.\n");
  process.exit(1);
}

const norm = (v) => v.replace(/^v/, "");
if (norm(pinned) === norm(latest)) {
  console.log(`install page ships ${pinned}, which is the latest release. ok`);
  process.exit(0);
}

console.error(
  `\n  DRIFT: the install page ships ${pinned}, but the latest release is ${latest}.\n\n` +
  `  Every client who installs right now gets ${pinned}. Compare what they are\n` +
  `  missing with:  git log ${pinned}..${latest} --oneline\n\n` +
  "  Fix the version on the install page, then re-run this.\n"
);
process.exit(1);
