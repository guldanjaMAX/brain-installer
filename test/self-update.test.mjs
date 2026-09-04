// The decisions `brain update` makes about its OWN version, tested without a
// network, a registry or a release. Every case here is one a client hit or
// could hit: a stranded install re-running itself, a working-branch build that
// must never be pulled back to a release, a Windows prefix outside npm's
// default, and GitHub simply being unreachable.
import assert from "node:assert/strict";
import { sep } from "node:path";
import {
  compareRelease, installPrefixOf, installedEntry, selfUpdateDecision,
  releaseTarballUrl, fetchLatestRelease,
} from "../operations/self-update.mjs";

let pass = 0;
const ok = (name) => { pass++; console.log(`PASS  ${name}`); };

// --- compare ---
assert.equal(compareRelease("0.3.4", "0.3.5"), -1);
assert.equal(compareRelease("0.3.5", "0.3.5"), 0);
assert.equal(compareRelease("0.4.0", "0.3.9"), 1);
assert.equal(compareRelease("v0.3.5", "0.3.5"), 0);
assert.throws(() => compareRelease("0.3", "0.3.5"));
assert.throws(() => compareRelease("main", "0.3.5"));
ok("release versions compare, and anything that is not x.y.z is refused");

// --- prefix resolution ---
assert.equal(
  installPrefixOf(`${sep}Users${sep}x${sep}.npm-global${sep}lib${sep}node_modules${sep}brain-installer${sep}brain.mjs`),
  `${sep}Users${sep}x${sep}.npm-global`);
assert.equal(
  installPrefixOf(`C:${sep}Users${sep}m${sep}AppData${sep}Local${sep}FinancialBrain${sep}node_modules${sep}brain-installer${sep}brain.mjs`),
  `C:${sep}Users${sep}m${sep}AppData${sep}Local${sep}FinancialBrain`);
assert.equal(installPrefixOf(`${sep}somewhere${sep}checkout${sep}brain.mjs`), null);
ok("the prefix comes from where this CLI actually runs, not npm's default");

// A repo checkout is not an install: it must not try to npm-install over itself.
assert.deepEqual(
  selfUpdateDecision({ running: "0.3.4", latest: "0.3.5", prefix: null }),
  { action: "warn", reason: "this CLI is not in a resolvable npm prefix" });
ok("a working checkout is warned about, never overwritten");

// --- the decisions ---
assert.equal(selfUpdateDecision({ running: "0.3.4", latest: "0.3.5", prefix: "/p" }).action, "install");
assert.equal(selfUpdateDecision({ running: "0.3.5", latest: "0.3.5", prefix: "/p" }).action, "current");
ok("behind installs, current does nothing");

// The case that must never regress: a working-branch build reports a LOWER
// product version while running a HIGHER schema. Pulling it back to the
// release replaces 32 migrations with 22 and there is no clean way back.
assert.equal(selfUpdateDecision({ running: "0.4.1", latest: "0.3.5", prefix: "/p" }).action, "current");
ok("a version newer than the published release is never pulled backwards");

assert.equal(selfUpdateDecision({ running: "0.3.4", latest: null, prefix: "/p" }).action, "warn");
ok("GitHub being unreachable warns, and never silently proceeds as if current");

assert.equal(selfUpdateDecision({ running: "0.3.4", latest: "0.3.5", prefix: "/p", optedOut: true }).action, "skip");
assert.equal(selfUpdateDecision({ running: "0.3.4", latest: "0.3.5", prefix: "/p", alreadyReexeced: true }).action, "skip");
ok("--no-self-update opts out, and a re-executed run never re-executes again");

// --- url ---
assert.equal(releaseTarballUrl("0.3.5"),
  "https://github.com/guldanjaMAX/brain-installer/releases/download/v0.3.5/brain-installer-0.3.5.tgz");
assert.equal(releaseTarballUrl("v0.3.5"), releaseTarballUrl("0.3.5"));
ok("the tarball url is the one the guide hands out");

// --- entry discovery ---
const winPrefix = `C:${sep}fb`;
assert.equal(
  installedEntry(winPrefix, { platform: "win32", exists: (p) => p.includes(`${sep}node_modules${sep}`) && !p.includes(`${sep}lib${sep}`) }),
  `${winPrefix}${sep}node_modules${sep}brain-installer${sep}brain.mjs`);
assert.equal(installedEntry("/p", { platform: "darwin", exists: () => false }), null);
ok("the re-exec target is found on both layouts, and null when it is not there");

// --- fetch never throws ---
const offline = await fetchLatestRelease({ fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
assert.equal(offline, null);
const rateLimited = await fetchLatestRelease({ fetchImpl: async () => ({ ok: false, status: 403 }) });
assert.equal(rateLimited, null);
const garbage = await fetchLatestRelease({ fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "nightly" }) }) });
assert.equal(garbage, null);
const good = await fetchLatestRelease({ fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v0.3.5" }) }) });
assert.equal(good, "0.3.5");
ok("the release lookup returns null rather than throwing, on every failure shape");

console.log(`\n${pass} passed`);

// --- the runner, wired into brain.mjs, with every side effect injected ---
const { selfUpdateBeforeUpdate } = await import("../brain.mjs");

let installedWith = null, reexecedWith = null;
const spawnSync = (cmd, args) => {
  if (cmd === "npm") { installedWith = args; return { status: 0 }; }
  reexecedWith = { cmd, args }; return { status: 0 };
};

const acted = await selfUpdateBeforeUpdate({
  running: "0.3.4", latest: "0.3.5", prefix: "/p",
  spawnSync, installedEntry: () => "/p/lib/node_modules/brain-installer/brain.mjs",
});
assert.equal(acted.action, "reexeced");
assert.ok(installedWith.join(" ").includes("--prefix /p"), "installs into the running prefix");
assert.ok(installedWith.join(" ").includes("brain-installer-0.3.5.tgz"), "installs the published tarball");
assert.equal(reexecedWith.args[0], "/p/lib/node_modules/brain-installer/brain.mjs");
ok("behind: installs the release into its own prefix, then re-executes it");

installedWith = null; reexecedWith = null;
const current = await selfUpdateBeforeUpdate({ running: "0.3.5", latest: "0.3.5", prefix: "/p", spawnSync });
assert.equal(current.action, "current");
assert.equal(installedWith, null, "nothing installed when already current");
assert.equal(reexecedWith, null, "nothing re-executed when already current");
ok("current: touches nothing, spawns nothing");

installedWith = null;
const offlineRun = await selfUpdateBeforeUpdate({ running: "0.3.4", latest: null, prefix: "/p", spawnSync });
assert.equal(offlineRun.action, "warn");
assert.equal(installedWith, null);
ok("unreachable release: warns and continues, rather than blocking a stranded client");

// The refusal that matters most: never pull a schema-ahead build backwards.
const ahead = await selfUpdateBeforeUpdate({ running: "0.9.0", latest: "0.3.5", prefix: "/p", spawnSync });
assert.equal(ahead.action, "current");
ok("a build newer than the release is left alone, schema intact");

console.log(`\n${pass} passed (module + wiring)`);
