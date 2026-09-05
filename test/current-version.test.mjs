import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const json = (path) => JSON.parse(read(path));

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const manifestTemplate = json("templates/brain.manifest.json");
const manifestSchema = json("manifest.schema.json");
const changelog = read("CHANGELOG.md");
const readme = read("README.md");
const developerReadme = read("docs/README-developer.md");
const maintainerGuide = read("docs/MAINTAINER.md");
const version = packageJson.version;

assert.match(version, /^\d+\.\d+\.\d+$/, "package version must be a stable semantic version");
assert.equal(packageLock.version, version, "package-lock top-level version drifted");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock root package version drifted");
assert.equal(manifestTemplate.brain?.version, version, "manifest template version drifted");
const driveTemplate = manifestTemplate.corpora?.google_drive;
const driveSchema = manifestSchema.properties?.corpora?.properties?.google_drive;
assert.equal(driveTemplate?.enabled, false,
  "a fresh manifest must keep Drive disabled until an allowed root is chosen");
assert.deepEqual(driveTemplate?.root_folder_ids, [],
  "a disabled fresh Drive connector may carry an empty root placeholder");
assert.equal(driveSchema?.properties?.root_folder_ids?.minItems, undefined,
  "root_folder_ids must not be nonempty unconditionally while the template keeps Drive disabled");
assert.equal(driveSchema?.allOf?.[0]?.then?.properties?.root_folder_ids?.minItems, 1,
  "the schema must require a nonempty Drive root allowlist when Drive is enabled");
assert.match(changelog, new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"), "changelog has no current-version heading");
assert.match(developerReadme,
  new RegExp(`^\\*\\*Status: ${version.replaceAll(".", "\\.")} local release candidate\\.\\*\\*`, "m"),
  "developer README status drifted from the candidate version");
const [major, minor] = version.split(".");
assert.match(maintainerGuide, new RegExp(`current ${major}\\.${minor}\\.x product line`),
  "maintainer guide names the wrong current product line");

const releaseLinks = [...readme.matchAll(
  /releases\/download\/v(\d+\.\d+\.\d+)\/brain-installer-(\d+\.\d+\.\d+)\.tgz/g,
)];
assert.ok(releaseLinks.length >= 2, "README must show the pinned POSIX and Windows release commands");
for (const [, tagVersion, assetVersion] of releaseLinks) {
  assert.equal(tagVersion, version, "README release tag version drifted");
  assert.equal(assetVersion, version, "README release asset version drifted");
}

const versionRun = spawnSync(process.execPath, [resolve(ROOT, "brain.mjs"), "--version"], {
  encoding: "utf8",
});
assert.equal(versionRun.status, 0, `brain --version failed: ${versionRun.stderr || versionRun.stdout}`);
assert.equal(versionRun.stdout.trim(), version, "brain --version must print only the running package version");
assert.equal(versionRun.stderr, "", "brain --version must not emit diagnostics");

console.log(`current version alignment: package, lockfile, template, changelog, packaged guides, and ${releaseLinks.length} install links all use ${version}`);
