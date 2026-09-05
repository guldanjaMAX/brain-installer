import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRelease } from "./verify-release-assets.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const ci = readText(join(root, ".github/workflows/ci.yml"));
const release = readText(join(root, ".github/workflows/release.yml"));
const workflowsDir = join(root, ".github/workflows");
const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, readText(join(workflowsDir, name))]);

// Branch and pull-request CI remains independent. Tags have one route, through
// release.yml, so two racing CI runs cannot disagree about which one released.
assert.match(ci, /^  push:\n    branches:\n      - "\*\*"$/m);
assert.match(ci, /^  pull_request:$/m);
assert.match(ci, /^  workflow_dispatch:$/m);
assert.match(ci, /^  workflow_call:$/m);
assert.match(ci, /os: \[windows-latest, macos-latest, ubuntu-latest\]/);
assert.match(ci, /node: \['22', '24'\]/);
assert.match(ci, /^  preflight-traps:$/m);
assert.match(release, /^  push:\n    tags:\n      - "v\*\.\*\.\*"$/m);

const gateIndex = release.indexOf("  gate:");
const publishIndex = release.indexOf("  publish:");
assert.ok(gateIndex > 0 && publishIndex > gateIndex, "publish must follow the reusable CI gate");
const gate = release.slice(gateIndex, publishIndex);
const publish = release.slice(publishIndex);
assert.match(gate, /uses: \.\/\.github\/workflows\/ci\.yml/);
assert.match(publish, /^    needs: gate$/m);
assert.match(publish, /^    permissions:\n      contents: write$/m);

const createCommands = [...release.matchAll(/^\s+gh release create /gm)];
assert.equal(createCommands.length, 1, "release assets must have one creation operation");
assert.doesNotMatch(release, /^\s+gh release upload /m);
const deleteCommands = [...release.matchAll(/^\s+gh api --method DELETE /gm)];
assert.equal(deleteCommands.length, 2,
  "only pre-create draft replacement and failed-run draft cleanup may delete a release");
assert.doesNotMatch(release, /gh release delete|--cleanup-tag/,
  "release cleanup must delete an owned numeric release id and preserve the git tag");
assert.doesNotMatch(release, /git tag -d|refs\/tags\/.*(?:DELETE|delete)/,
  "the workflow must never delete or move the release tag");
const createIndex = release.indexOf("gh release create");
const draftVerifyIndex = release.indexOf("verify-release-assets.mjs draft");
const publishStepIndex = release.indexOf("- name: publish the verified draft");
const prepublishVerifyIndex = release.indexOf("verify-release-assets.mjs draft", draftVerifyIndex + 1);
const publishCommandIndex = release.indexOf("gh api --method PATCH");
const publishedVerifyIndex = release.indexOf("verify-release-assets.mjs published");
const replaceDraftIndex = release.indexOf('gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/$existing_id"');
const cleanupStepIndex = release.indexOf("- name: remove a failed draft without deleting its tag");
const cleanupDeleteIndex = release.indexOf('gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/$cleanup_id"');
assert.ok(createIndex < draftVerifyIndex && draftVerifyIndex < publishStepIndex &&
  publishStepIndex < prepublishVerifyIndex && prepublishVerifyIndex < publishCommandIndex &&
  publishCommandIndex < publishedVerifyIndex);
assert.ok(replaceDraftIndex > 0 && replaceDraftIndex < createIndex,
  "an exact-tag draft must be removed before recreating the release");
assert.ok(cleanupStepIndex > publishedVerifyIndex && cleanupDeleteIndex > cleanupStepIndex,
  "failed-run cleanup must run after every publish step and contain the second draft deletion");
assert.match(release.slice(createIndex, draftVerifyIndex), /"\$VERSIONED_TARBALL" "\$CANONICAL_TARBALL"/);
assert.match(release.slice(createIndex, draftVerifyIndex), /--draft/);
assert.match(release.slice(createIndex, draftVerifyIndex), /--verify-tag/);
assert.match(release.slice(createIndex, draftVerifyIndex), /--latest/);
assert.match(release.slice(0, createIndex), /secrets\.RELEASE_ADMIN_READ_TOKEN/);
assert.match(release.slice(0, createIndex), /"repos\/\$GITHUB_REPOSITORY\/immutable-releases"/);
assert.match(release.slice(0, createIndex), /npm ci --ignore-scripts/);
assert.match(release.slice(publishCommandIndex), /isImmutable/);
assert.match(release.slice(publishCommandIndex), /installed_status=\$\?/);
assert.doesNotMatch(release.slice(publishCommandIndex), /bin\/brain"\s*\|/);

const replaceDraft = release.slice(release.lastIndexOf("existing_release=", createIndex), createIndex);
assert.match(replaceDraft, /releases\/tags\/\$RELEASE_TAG/);
assert.match(replaceDraft, /existing_state.*== "draft"/s);
assert.match(replaceDraft, /existing_owner.*!= "owned"/s);
assert.match(replaceDraft, /published release already exists/);
assert.match(replaceDraft, /gh api --method DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/\$existing_id"/);
assert.match(release.slice(0, draftVerifyIndex), /release_marker="brain-release-run:\$\{GITHUB_RUN_ID\}:\$\{GITHUB_RUN_ATTEMPT\}"/);
assert.match(release.slice(0, draftVerifyIndex), /--notes "<!-- \$release_marker -->"/);
const createdIdentity = release.slice(createIndex, draftVerifyIndex);
assert.match(createdIdentity, /releases\/tags\/\$RELEASE_TAG/);
assert.match(createdIdentity, /value\.draft !== true/);
assert.match(createdIdentity, /Number\.isSafeInteger\(value\.id\)/);
assert.match(createdIdentity, /created release does not carry this run marker/);
assert.match(createdIdentity, /RELEASE_DRAFT_ID=\$created_id/);

const publishStep = release.slice(publishStepIndex, publishedVerifyIndex);
assert.match(publishStep, /repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_DRAFT_ID/);
assert.match(publishStep, /value\.id !== expectedId/);
assert.match(publishStep, /value\.tag_name !== process\.argv\[3\]/);
assert.match(publishStep, /value\.draft !== true/);
assert.match(publishStep, /prepublish release is not owned by this run/);
assert.match(publishStep, /verify-release-assets\.mjs draft/);
assert.match(publishStep, /gh api --method PATCH/);
assert.match(publishStep, /-F draft=false/);
assert.doesNotMatch(release, /gh release edit/,
  "publication must target the captured numeric release id, never resolve the tag again");

const cleanup = release.slice(cleanupStepIndex);
assert.match(cleanup, /if: \$\{\{ failure\(\) \}\}/);
assert.match(cleanup, /RELEASE_DRAFT_MARKER/);
assert.match(cleanup, /cleanup_state.*== "draft"/s);
assert.match(cleanup, /cleanup_owner.*!= "owned"/s);
assert.match(cleanup, /different actor owns the draft/);
assert.match(cleanup, /is published; leaving it and its tag untouched/);
assert.match(cleanup, /gh api --method DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/\$cleanup_id"/);

for (const [name, text] of workflowFiles) {
  for (const match of text.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    assert.match(reference, /@[0-9a-f]{40}$/, `${name} has a mutable or abbreviated action reference: ${reference}`);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "brain-release-contract-"));
try {
  const versioned = join(sandbox, "brain-installer-9.8.7.tgz");
  const canonical = join(sandbox, "brain-installer.tgz");
  const bytes = Buffer.from("synthetic release bytes\n");
  writeFileSync(versioned, bytes);
  writeFileSync(canonical, bytes);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const assets = [versioned, canonical].map((path) => ({
    name: basename(path),
    size: bytes.length,
    digest,
    state: "uploaded",
  }));

  assert.doesNotThrow(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }));
  assert.doesNotThrow(() => verifyRelease({
    phase: "draft",
    release: { tag_name: "v9.8.7", draft: true, immutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }));
  assert.doesNotThrow(() => verifyRelease({
    phase: "published",
    release: { tagName: "v9.8.7", isDraft: false, isImmutable: true, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }));
  assert.throws(() => verifyRelease({
    phase: "published",
    release: { tagName: "v9.8.7", isDraft: false, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }), /not immutable/);
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets: assets.slice(0, 1) },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }), /1 assets, expected 2/);

  writeFileSync(canonical, Buffer.from("changed\n"));
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }), /does not match|not byte-identical/);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("release workflow contract: exact CI gate, tag-preserving draft recovery, two identical assets, immutable publication");
