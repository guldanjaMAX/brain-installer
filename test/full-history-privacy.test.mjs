import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  baselineFromReport,
  compareBaseline,
  evaluateStrictRelease,
  scanRepository,
} from "../scripts/scan-git-history-privacy.mjs";
import {
  buildIdentityIndex,
  compileIdentityRule,
  scanIdentityText,
} from "../scripts/privacy-identity.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-history-privacy-"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitAt(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function git(args) {
  return gitAt(sandbox, args);
}

test.before(() => {
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "History Test"]);
  git(["config", "user.email", "history-test@example.test"]);

  writeFileSync(join(sandbox, "README.md"), "synthetic history scanner repository\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Create synthetic repository"]);

  const directory = join(sandbox, "records");
  mkdirSync(directory);
  const credentialShape = ["github", "pat", "A".repeat(52)].join("_");
  writeFileSync(
    join(directory, "ZzqHistoryCanary.txt"),
    `ZzqHistoryCanary\n${credentialShape}\n`,
  );
  writeFileSync(join(directory, `${credentialShape}.txt`), "credential-shaped path canary\n");
  git(["add", "records/ZzqHistoryCanary.txt"]);
  git(["commit", "-m", "Add synthetic historical incident"]);

  rmSync(join(directory, "ZzqHistoryCanary.txt"));
  rmSync(join(directory, `${credentialShape}.txt`));
  writeFileSync(join(sandbox, "README.md"), "current tree is clean but history is not\n");
  git(["add", "-A"]);
  git(["commit", "-m", "Remove synthetic historical incident from the tip"]);
  git(["tag", "v1-test"]);
});

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("scans reachable historical blobs after the current tree is clean", () => {
  const identityIndex = buildIdentityIndex([
    compileIdentityRule("synthetic identity", "word", false, "ZzqHistoryCanary"),
  ]);
  const report = scanRepository({
    repo: sandbox,
    refPrefixes: ["refs/heads", "refs/tags"],
    identityIndex,
  });

  assert.equal(report.inventory.public_ref_count, 2);
  assert.equal(report.inventory.commit_count, 3);
  assert(report.categories.some((entry) =>
    entry.kind === "privacy" && entry.category === "synthetic identity"));
  assert(report.categories.some((entry) =>
    entry.kind === "credential_candidate" && entry.category === "github_fine_grained"));
  assert(report.finding_objects.some((entry) =>
    entry.classifications.some((classification) =>
      classification.kind === "credential_candidate" && classification.category === "github_fine_grained") &&
    entry.locations.includes("path")));
  assert(report.finding_objects.every((entry) => entry.reachable_from.length > 0));

  const serialized = JSON.stringify(report);
  assert(!serialized.includes("ZzqHistoryCanary"));
  assert(!serialized.includes(["github", "pat", "A".repeat(52)].join("_")));
  assert(!serialized.includes("records/"));
});

test("baseline comparison is exact and stores no matched values", () => {
  const identityIndex = buildIdentityIndex([
    compileIdentityRule("synthetic identity", "word", false, "ZzqHistoryCanary"),
  ]);
  const report = scanRepository({
    repo: sandbox,
    refPrefixes: ["refs/heads", "refs/tags"],
    identityIndex,
  });
  const baseline = baselineFromReport(report);
  assert.equal(compareBaseline(report, baseline).matches, true);
  assert(!JSON.stringify(baseline).includes("ZzqHistoryCanary"));

  const changed = structuredClone(baseline);
  changed.finding_objects.pop();
  assert.equal(compareBaseline(report, changed).matches, false);
});

test("strict release review never allowlists privacy or revoked credentials", () => {
  const identityIndex = buildIdentityIndex([
    compileIdentityRule("synthetic identity", "word", false, "ZzqHistoryCanary"),
  ]);
  const report = scanRepository({
    repo: sandbox,
    refPrefixes: ["refs/heads", "refs/tags"],
    identityIndex,
  });
  assert.equal(evaluateStrictRelease(report, {
    schema_version: 1,
    approved_candidates: [],
  }).passes, false);

  const candidateOnly = structuredClone(report);
  candidateOnly.finding_objects = candidateOnly.finding_objects
    .map((finding) => ({
      ...finding,
      classifications: finding.classifications.filter((entry) =>
        entry.kind === "credential_candidate"),
    }))
    .filter((finding) => finding.classifications.length);
  const approved = candidateOnly.finding_objects.flatMap((finding) =>
    finding.classifications.map((entry) => ({
      object_id: finding.object_id,
      category: entry.category,
      disposition: "synthetic_fixture",
    })));
  assert.equal(evaluateStrictRelease(candidateOnly, {
    schema_version: 1,
    approved_candidates: approved,
  }).passes, true);

  approved.push({
    object_id: "0".repeat(40),
    category: "stale-example",
    disposition: "synthetic_fixture",
  });
  assert.equal(evaluateStrictRelease(candidateOnly, {
    schema_version: 1,
    approved_candidates: approved,
  }).passes, false);
});

test("zero-finding policy rejects even a reviewable synthetic candidate", () => {
  const scanner = join(root, "scripts/scan-git-history-privacy.mjs");
  const blocked = spawnSync(process.execPath, [
    scanner,
    "--repo", sandbox,
    "--ref", "main",
    "--require-zero-findings",
  ], { encoding: "utf8" });
  assert.equal(blocked.status, 1, blocked.stdout || blocked.stderr);
  assert.match(blocked.stderr, /zero-finding history gate found [1-9][0-9]* finding object/);

  const clean = spawnSync(process.execPath, [
    scanner,
    "--repo", sandbox,
    "--ref", "main~2",
    "--require-zero-findings",
  ], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.match(clean.stdout, /exactly 0 finding objects/);
});

test("predecessor incident metadata stays sanitized but is not an active gate", () => {
  const baseline = JSON.parse(readFileSync(join(root, "privacy/history-baseline.json"), "utf8"));
  assert.equal(baseline.schema_version, 1);
  assert(baseline.finding_objects.length > 0);
  for (const finding of baseline.finding_objects) {
    assert.deepEqual(Object.keys(finding).sort(), [
      "classifications",
      "locations",
      "object_id",
      "object_type",
    ]);
    assert.match(finding.object_id, /^[0-9a-f]{40,64}$/);
    assert(finding.classifications.every((entry) =>
      ["privacy", "credential_candidate", "known_revoked_credential"].includes(entry.kind)));
    assert(finding.locations.every((location) => ["content", "message", "path"].includes(location)));
  }

  const refs = JSON.parse(readFileSync(join(root, "privacy/public-refs.json"), "utf8"));
  assert.equal(refs.schema_version, 1);
  assert(refs.refs.length > 0);
  assert(refs.refs.every((entry) =>
    scanIdentityText(entry.public_ref).length === 0 &&
    scanIdentityText(entry.local_ref).length === 0));

  const dispositions = JSON.parse(readFileSync(join(root, "privacy/credential-dispositions.json"), "utf8"));
  assert.deepEqual(dispositions, { schema_version: 1, approved_candidates: [] });

  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  for (const name of ["privacy:history", "privacy:history:remote", "privacy:history:strict"]) {
    assert.match(scripts[name], /--require-zero-findings/);
    assert.doesNotMatch(scripts[name], /history-baseline|public-refs|credential-dispositions/);
  }
  assert.match(scripts["privacy:history"], /--ref HEAD/);
  assert.match(scripts["privacy:history:remote"], /--remote origin/);
  assert.match(scripts["privacy:history:remote"], /--ref HEAD/);
});

test("remote scan bootstraps from an exact checked-out object without a tracking ref", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-bootstrap-"));
  const repository = join(container, "work");
  const remote = join(container, "origin.git");
  const publisher = join(container, "publisher");
  try {
    mkdirSync(repository);
    gitAt(container, ["init", "--bare", remote]);
    gitAt(repository, ["init", "--initial-branch=main"]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(repository, "README.md"), "clean bootstrap history\n");
    gitAt(repository, ["add", "README.md"]);
    gitAt(repository, ["commit", "-m", "Create clean bootstrap"]);
    gitAt(repository, ["remote", "add", "origin", remote]);
    gitAt(repository, ["push", "origin", "main"]);
    gitAt(repository, ["update-ref", "-d", "refs/remotes/origin/main"]);

    assert.doesNotThrow(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      refs: ["HEAD"],
      remote: "origin",
      identityIndex: buildIdentityIndex([]),
    }));
    const cli = spawnSync(process.execPath, [
      join(root, "scripts/scan-git-history-privacy.mjs"),
      "--repo", repository,
      "--remote", "origin",
      "--ref", "HEAD",
      "--require-zero-findings",
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /exactly 0 finding objects/);
    const reverseOrder = spawnSync(process.execPath, [
      join(root, "scripts/scan-git-history-privacy.mjs"),
      "--repo", repository,
      "--ref", "HEAD",
      "--remote", "origin",
      "--require-zero-findings",
    ], { encoding: "utf8" });
    assert.equal(reverseOrder.status, 0, reverseOrder.stderr || reverseOrder.stdout);

    gitAt(container, ["clone", "--branch", "main", remote, publisher]);
    gitAt(publisher, ["config", "user.name", "History Test"]);
    gitAt(publisher, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(publisher, "SECOND.md"), "server object absent from first checkout\n");
    gitAt(publisher, ["add", "SECOND.md"]);
    gitAt(publisher, ["commit", "-m", "Add unfetched server object"]);
    gitAt(publisher, ["push", "origin", "HEAD:refs/heads/unfetched"]);

    assert.throws(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      refs: ["HEAD"],
      remote: "origin",
      identityIndex: buildIdentityIndex([]),
    }), /missing a server-visible object/);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("remote baseline refuses a rewritten reviewed branch", () => {
  const container = mkdtempSync(join(tmpdir(), "brain-history-remote-"));
  const repository = join(container, "work");
  const remote = join(container, "origin.git");
  const manifestPath = join(container, "public-refs.json");
  try {
    mkdirSync(repository);
    gitAt(container, ["init", "--bare", remote]);
    gitAt(repository, ["init", "--initial-branch=main"]);
    gitAt(repository, ["config", "user.name", "History Test"]);
    gitAt(repository, ["config", "user.email", "history-test@example.test"]);
    writeFileSync(join(repository, "README.md"), "reviewed history\n");
    gitAt(repository, ["add", "README.md"]);
    gitAt(repository, ["commit", "-m", "Create reviewed history"]);
    gitAt(repository, ["remote", "add", "origin", remote]);
    gitAt(repository, ["push", "-u", "origin", "main"]);

    const reviewedTip = gitAt(repository, ["rev-parse", "main"]);
    writeFileSync(manifestPath, `${JSON.stringify({
      schema_version: 1,
      refs: [{
        public_ref: "refs/heads/main",
        local_ref: "refs/remotes/origin/main",
        tip_object: reviewedTip,
      }],
    }, null, 2)}\n`);
    const emptyIdentityIndex = buildIdentityIndex([]);
    assert.doesNotThrow(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      remote: "origin",
      refManifest: manifestPath,
      identityIndex: emptyIdentityIndex,
    }));

    writeFileSync(join(repository, "README.md"), "legitimate descendant\n");
    gitAt(repository, ["commit", "-am", "Advance reviewed history"]);
    gitAt(repository, ["push", "origin", "main"]);
    assert.doesNotThrow(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      remote: "origin",
      refManifest: manifestPath,
      identityIndex: emptyIdentityIndex,
    }));

    gitAt(repository, ["switch", "--orphan", "replacement"]);
    writeFileSync(join(repository, "README.md"), "unrelated replacement\n");
    gitAt(repository, ["add", "README.md"]);
    gitAt(repository, ["commit", "-m", "Replace reviewed history"]);
    gitAt(repository, ["push", "--force", "origin", "replacement:main"]);
    assert.throws(() => scanRepository({
      repo: repository,
      refPrefixes: [],
      remote: "origin",
      refManifest: manifestPath,
      identityIndex: emptyIdentityIndex,
    }), /no longer descends/);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});
