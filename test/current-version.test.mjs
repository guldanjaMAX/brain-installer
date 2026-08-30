import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log(`current version alignment: package, lockfile, template, changelog, and ${releaseLinks.length} install links all use ${version}`);
