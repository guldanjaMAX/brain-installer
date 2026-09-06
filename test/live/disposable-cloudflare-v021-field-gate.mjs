#!/usr/bin/env node
/**
 * Explicit wrapper for the disposable Cloudflare synthetic field gate.
 *
 * This file never provisions or removes infrastructure. Provisioning and
 * cleanup remain supervised operator actions. The executable lane validates
 * that the supplied manifest is unmistakably disposable and synthetic, then
 * runs the existing real-Cloudflare gate without printing credentials or
 * infrastructure identifiers.
 */
import assert from "node:assert/strict";
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log(`Usage:
  node test/live/disposable-cloudflare-v021-field-gate.mjs --plan
  node test/live/disposable-cloudflare-v021-field-gate.mjs --execute \\
    --confirm disposable-synthetic-v021 \\
    --manifest /private/path/brain.manifest.json \\
    --installer-root /path/to/reviewed/checkout \\
    --receipt /private/path/disposable-field-gate-receipt.json

The execute mode performs billable reads and writes against an already
provisioned disposable Cloudflare Brain. It does not provision or clean up the
Worker, D1 database, Vectorize index, route, DNS, or Keychain item.`);
  process.exit(args.includes("--help") ? 0 : 2);
}

if (args.includes("--plan")) {
  console.log(JSON.stringify({
    gate: "disposable_cloudflare_synthetic_v021",
    mutates_live_resources: true,
    provisions_resources: false,
    removes_resources: false,
    allowed_data: "fictional synthetic records only",
    prerequisites: [
      "reviewed candidate checkout",
      "new disposable field-gate manifest",
      "workers.dev hostname with field-gate naming",
      "dedicated D1 and Vectorize resources",
      "Keychain-backed admin credential",
      "explicit operator approval for this run",
    ],
    completion: [
      "aggregate JSON test receipt saved mode 0600",
      "separate cleanup confirms Worker, D1, Vectorize, route, DNS, and temporary Keychain item are gone",
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
assert.equal(valueOf("--confirm"), "disposable-synthetic-v021",
  "refusing live execution without the exact disposable confirmation");

const manifestPath = resolve(valueOf("--manifest"));
const installerRoot = resolve(valueOf("--installer-root"));
const receiptPath = resolve(valueOf("--receipt"));
const manifestStat = lstatSync(manifestPath);
assert.equal(manifestStat.isFile(), true, "manifest must be a regular file");
assert.equal(manifestStat.isSymbolicLink(), false, "manifest symlinks are refused");
assert.equal(manifestStat.nlink, 1, "hard-linked manifests are refused");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.match(String(manifest.client?.slug || ""), /field/i);
assert.match(String(manifest.client?.display_name || ""), /synthetic field gate/i);
assert.match(String(manifest.brain?.worker_name || ""), /field/i);
assert.match(String(manifest.brain?.domain || ""), /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/);
assert.notEqual(manifest.corpora?.google_drive?.enabled, true);
assert.notEqual(manifest.corpora?.gmail?.enabled, true);

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
  throw new Error("the disposable Cloudflare field gate failed; no receipt was written and cleanup is still required");
}

let proof;
try {
  proof = JSON.parse(String(child.stdout || "").trim());
} catch {
  throw new Error("the disposable gate did not return its aggregate JSON receipt");
}
assert.equal(proof.status, "passed");
assert.match(String(proof.worker_version || ""), /^\d+\.\d+\.\d+$/);

const receipt = {
  schema_version: 1,
  gate: "disposable_cloudflare_synthetic_v021",
  status: "passed_cleanup_required",
  executed_at: new Date().toISOString(),
  data_class: "fictional_synthetic_only",
  proof,
  cleanup: {
    required: true,
    verified: false,
    resources: ["worker", "d1", "vectorize", "route_dns", "temporary_keychain_item"],
  },
  proof_boundary: "This proves the named synthetic gate only. It is not proof of a permanent hostname, owner data, provider consent, physical passkeys, or cleanup.",
};

assert.equal(lstatSync(dirname(receiptPath)).isDirectory(), true, "receipt parent must exist");
const descriptor = openSync(receiptPath, "wx", 0o600);
try {
  writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
} finally {
  closeSync(descriptor);
}
console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, cleanup_required: true }, null, 2));
