#!/usr/bin/env node
/**
 * Explicit wrapper for the disposable Cloudflare synthetic v0.3.7 field gate.
 *
 * This file never provisions or removes infrastructure. Provisioning and
 * cleanup remain supervised operator actions. The executable lane validates
 * that the supplied manifest is unmistakably disposable and synthetic, binds
 * both the manifest and reviewed checkout to v0.3.7, then runs the existing
 * real-Cloudflare gate without printing credentials or infrastructure IDs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const RELEASE_VERSION = "0.3.7";
const CONFIRMATION = "disposable-synthetic-v037";
const GATE = "disposable_cloudflare_synthetic_v037";
const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.log(`Usage:
  node test/live/disposable-cloudflare-v037-field-gate.mjs --plan
  node test/live/disposable-cloudflare-v037-field-gate.mjs --execute \\
    --confirm ${CONFIRMATION} \\
    --manifest /private/path/brain.manifest.json \\
    --installer-root /path/to/reviewed/v0.3.7/checkout \\
    --candidate-commit <40-character-git-commit> \\
    --artifact /private/path/brain-installer-0.3.7.tgz \\
    --artifact-sha256 <64-character-sha256-from-ci> \\
    --receipt /private/path/disposable-v037-field-gate-receipt.json

The execute mode performs billable reads and writes against an already
provisioned disposable Cloudflare Brain running v0.3.7. It does not provision
or clean up the Worker, D1 database, Vectorize index, workers.dev endpoint, or
temporary Keychain item.`);
  process.exit(args.includes("--help") ? 0 : 2);
}

if (args.includes("--plan")) {
  console.log(JSON.stringify({
    gate: GATE,
    candidate_version: RELEASE_VERSION,
    mutates_live_resources: true,
    provisions_resources: false,
    removes_resources: false,
    allowed_data: "fictional synthetic records only",
    prerequisites: [
      "reviewed v0.3.7 candidate checkout",
      "exact 40-character candidate commit matching checkout HEAD",
      "regular non-linked candidate tarball matching the SHA-256 recorded by CI",
      "new disposable field-gate manifest pinned to v0.3.7",
      "matching disposable Worker, D1, and Vectorize names",
      "workers.dev hostname matching the disposable Worker name",
      "no R2 bucket, custom domain, or enabled external provider",
      "Keychain-backed admin credential",
      "explicit operator approval for this run",
    ],
    completion: [
      "aggregate JSON test receipt saved mode 0600",
      "separate cleanup confirms Worker, D1, Vectorize, workers.dev endpoint, temporary Keychain item, and private local files are gone",
    ],
  }, null, 2));
  process.exit(0);
}

const valueOf = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) throw new Error(`missing ${flag}`);
  return args[index + 1];
};

assert.equal(args.includes("--execute"), true, "refusing live execution without --execute");
assert.equal(valueOf("--confirm"), CONFIRMATION,
  "refusing live execution without the exact disposable v0.3.7 confirmation");

const manifestPath = resolve(valueOf("--manifest"));
const installerRoot = resolve(valueOf("--installer-root"));
const candidateCommit = valueOf("--candidate-commit").toLowerCase();
const artifactPath = resolve(valueOf("--artifact"));
const expectedArtifactSha256 = valueOf("--artifact-sha256").toLowerCase();
const receiptPath = resolve(valueOf("--receipt"));
const manifestStat = lstatSync(manifestPath);
assert.equal(manifestStat.isFile(), true, "manifest must be a regular file");
assert.equal(manifestStat.isSymbolicLink(), false, "manifest symlinks are refused");
assert.equal(manifestStat.nlink, 1, "hard-linked manifests are refused");

assert.match(candidateCommit, /^[a-f0-9]{40}$/, "candidate commit must be a full 40-character Git commit");
const gitHead = spawnSync("git", ["-C", installerRoot, "rev-parse", "--verify", "HEAD^{commit}"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH || "/usr/bin:/bin" },
});
assert.equal(gitHead.status, 0, "could not resolve Git HEAD for the installer checkout");
const resolvedHead = String(gitHead.stdout || "").trim().toLowerCase();
assert.match(resolvedHead, /^[a-f0-9]{40}$/, "installer checkout returned an invalid Git HEAD");
assert.equal(resolvedHead, candidateCommit, "candidate commit does not match installer checkout HEAD");
const gitStatus = spawnSync("git", ["-C", installerRoot, "status", "--porcelain", "--untracked-files=normal"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH || "/usr/bin:/bin" },
});
assert.equal(gitStatus.status, 0, "could not inspect installer checkout status");
if (String(gitStatus.stdout || "").trim()) {
  throw new Error("installer checkout must be clean so the candidate commit identifies all executed code");
}

const artifactStat = lstatSync(artifactPath);
assert.match(artifactPath, /\.tgz$/i, "candidate artifact must be a .tgz file");
assert.equal(artifactStat.isFile(), true, "candidate artifact must be a regular file");
assert.equal(artifactStat.isSymbolicLink(), false, "candidate artifact symlinks are refused");
assert.equal(artifactStat.nlink, 1, "hard-linked candidate artifacts are refused");
const artifactSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
assert.match(expectedArtifactSha256, /^[a-f0-9]{64}$/,
  "candidate artifact SHA-256 must be the full digest recorded by CI");
assert.equal(artifactSha256, expectedArtifactSha256,
  "candidate artifact does not match the exact SHA-256 recorded by CI");

// A correct filename and checksum-shaped value are not proof that this is an
// installer package. Read only package.json from the archive and bind its
// identity and version before any live request is made.
const packedMetadata = spawnSync("tar", ["-xOf", artifactPath, "package/package.json"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH || "/usr/bin:/bin" },
});
assert.equal(packedMetadata.status, 0, "could not read package.json from the candidate artifact");
let packedPackage;
try {
  packedPackage = JSON.parse(String(packedMetadata.stdout || ""));
} catch {
  throw new Error("candidate artifact contains an invalid package.json");
}
assert.equal(packedPackage.name, "brain-installer", "candidate artifact is not brain-installer");
assert.equal(packedPackage.version, RELEASE_VERSION, "candidate artifact is not v0.3.7");

const receiptParentStat = lstatSync(dirname(receiptPath));
assert.equal(receiptParentStat.isDirectory(), true, "receipt parent must be a regular directory");
assert.equal(receiptParentStat.isSymbolicLink(), false, "receipt parent symlinks are refused");
assert.equal(existsSync(receiptPath), false, "receipt path already exists");

const candidatePackage = JSON.parse(readFileSync(resolve(installerRoot, "package.json"), "utf8"));
assert.equal(candidatePackage.name, "brain-installer", "installer root is not a brain-installer checkout");
assert.equal(candidatePackage.version, RELEASE_VERSION, "installer checkout is not the reviewed v0.3.7 candidate");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const slug = String(manifest.client?.slug || "");
const displayName = String(manifest.client?.display_name || "");
const workerName = String(manifest.brain?.worker_name || "");
const domain = String(manifest.brain?.domain || "");
const cloudflare = manifest.infrastructure?.cloudflare || {};

assert.equal(String(manifest.brain?.version || ""), RELEASE_VERSION,
  "manifest is not pinned to v0.3.7");
assert.ok(/^(brain-test|test)[a-z0-9-]*$/i.test(slug),
  "client slug must begin with an anchored disposable test prefix");
assert.ok(/field/i.test(slug), "client slug must identify this as a field gate");
assert.ok(/synthetic field gate/i.test(displayName), "display name must identify a synthetic field gate");
assert.ok(workerName === `${slug}-brain`, "Worker name must be derived from the disposable slug");
assert.ok(cloudflare.d1_database_name === workerName,
  "D1 database must use the same disposable resource name");
assert.ok(cloudflare.vectorize_index === workerName,
  "Vectorize index must use the same disposable resource name");
assert.equal(cloudflare.r2_bucket == null || cloudflare.r2_bucket === "", true,
  "R2 is outside this disposable field gate and must be absent");
assert.ok(/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(domain),
  "domain must be a workers.dev hostname");
assert.ok(domain.split(".")[0] === workerName,
  "workers.dev hostname must belong to the disposable Worker");

for (const [name, corpus] of Object.entries(manifest.corpora || {})) {
  if (name === "upload" || name === "local_folder") continue;
  assert.notEqual(corpus?.enabled, true,
    `external corpus ${name} must be disabled for the synthetic field gate`);
}

const child = spawnSync(process.execPath, [
  resolve(installerRoot, "test/live/d1-release-field-gate.mjs"),
  manifestPath,
  installerRoot,
], {
  cwd: installerRoot,
  encoding: "utf8",
  env: { PATH: process.env.PATH || "/usr/bin:/bin" },
  timeout: 20 * 60 * 1000,
});

if (child.status !== 0) {
  throw new Error("the disposable Cloudflare v0.3.7 field gate failed; no receipt was written and cleanup is still required");
}

let proof;
try {
  proof = JSON.parse(String(child.stdout || "").trim());
} catch {
  throw new Error("the disposable gate did not return its aggregate JSON receipt");
}
assert.equal(proof.status, "passed");
assert.equal(proof.worker_version, RELEASE_VERSION,
  "live Worker did not report the exact v0.3.7 candidate version");

const receipt = {
  schema_version: 1,
  gate: GATE,
  candidate_version: RELEASE_VERSION,
  candidate_commit: candidateCommit,
  artifact_sha256: artifactSha256,
  status: "passed_cleanup_required",
  executed_at: new Date().toISOString(),
  data_class: "fictional_synthetic_only",
  proof,
  cleanup: {
    required: true,
    verified: false,
    resources: [
      "worker",
      "d1",
      "vectorize",
      "workers_dev_endpoint",
      "temporary_keychain_item",
      "private_manifest_and_local_test_files",
    ],
  },
  proof_boundary: "This proves the named synthetic v0.3.7 gate only. It is not proof of a permanent hostname, owner data, provider consent, physical passkeys, upgrade recovery, or cleanup.",
};

const descriptor = openSync(receiptPath, "wx", 0o600);
try {
  writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
} finally {
  closeSync(descriptor);
}
console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, cleanup_required: true }, null, 2));
