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
const releaseChecker = read("scripts/check-install-page-version.mjs");
const version = packageJson.version;
const releaseRepository = "guldanjaMAX/financial-brain-installer";

assert.match(version, /^\d+\.\d+\.\d+$/, "package version must be a stable semantic version");
assert.equal(packageLock.version, version, "package-lock top-level version drifted");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock root package version drifted");
assert.equal(manifestTemplate.brain?.version, version, "manifest template version drifted");
assert.equal(manifestTemplate.corpora?.upload?.enabled, false,
  "the shipped manifest cannot enable a folder source before it names a folder");
assert.notEqual(manifestTemplate.corpora?.local_folder?.source, "documents",
  "the watched-folder default cannot collide with setup's first document source");
assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"), "changelog has no current-version heading");

const releaseLinks = [...readme.matchAll(
  /github\.com\/([^/]+\/[^/]+)\/releases\/download\/v(\d+\.\d+\.\d+)\/brain-installer-(\d+\.\d+\.\d+)\.tgz/g,
)];
assert.ok(releaseLinks.length >= 2, "README must show the pinned POSIX and Windows release commands");
for (const [, repository, tagVersion, assetVersion] of releaseLinks) {
  assert.equal(repository, releaseRepository, "README release repository drifted");
  assert.equal(tagVersion, version, "README release tag version drifted");
  assert.equal(assetVersion, version, "README release asset version drifted");
}
assert.equal(
  packageJson.repository?.url,
  `git+https://github.com/${releaseRepository}.git`,
  "package repository metadata drifted",
);
assert.match(
  releaseChecker,
  new RegExp(`https://api\\.github\\.com/repos/${releaseRepository.replace("/", "\\/")}/releases/latest`),
  "public install-page checker drifted from the release repository",
);
assert.doesNotMatch(readme, /guldanjaMAX\/brain-installer/, "README still names the predecessor repository");
assert.doesNotMatch(releaseChecker, /guldanjaMAX\/brain-installer/, "release checker still names the predecessor repository");

console.log(`current version alignment: package, lockfile, template, changelog, release repository, and ${releaseLinks.length} install links all use ${version}`);
