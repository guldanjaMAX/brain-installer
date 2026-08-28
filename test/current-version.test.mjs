import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseStamp } from "../operations/release-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const json = (path) => JSON.parse(read(path));

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const manifestTemplate = json("templates/brain.manifest.json");
const changelog = read("CHANGELOG.md");
const readme = read("README.md");
const version = packageJson.version;

assert.match(version, /^\d+\.\d+\.\d+$/, "package version must be a stable semantic version");
assert.equal(packageLock.version, version, "package-lock top-level version drifted");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock root package version drifted");
assert.equal(manifestTemplate.brain?.version, version, "manifest template version drifted");
assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"), "changelog has no current-version heading");

const releaseLinks = [...readme.matchAll(
  /releases\/download\/v(\d+\.\d+\.\d+)\/brain-installer-(\d+\.\d+\.\d+)\.tgz/g,
)];
assert.ok(releaseLinks.length >= 2, "README must show the pinned POSIX and Windows release commands");
for (const [, tagVersion, assetVersion] of releaseLinks) {
  assert.equal(tagVersion, version, "README release tag version drifted");
  assert.equal(assetVersion, version, "README release asset version drifted");
}

// The developer and maintainer guides sat at 0.1.16 through six releases while
// package, changelog and install links all named something newer, so the same
// repository answered "what version is this" two different ways depending on
// which file you opened. A doc that describes a release now binds itself to one
// with a visible stamp, and drift fails here rather than being noticed later by
// a reader who cannot tell which of the two numbers is the stale one.
//
// Historical references ("version 0.1.13 established ...") are untouched on
// purpose: an append-only guide has to be able to name old releases. Only the
// stamp is checked.
const STAMPED_DOCS = ["docs/README-developer.md", "docs/MAINTAINER.md"];
for (const path of STAMPED_DOCS) {
  const stamped = readReleaseStamp(read(path));
  assert.ok(stamped, `${path} carries no "Applies to release" stamp`);
  assert.equal(stamped, version, `${path} is stamped to a release other than the package version`);
}

console.log(`current version alignment: package, lockfile, template, changelog, ${releaseLinks.length} install links, and ${STAMPED_DOCS.length} stamped docs all use ${version}`);
