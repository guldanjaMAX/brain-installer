import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evalChildArguments, writePrivateEvalTemplate } from "../brain.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-eval-init-"));
try {
  const destination = join(sandbox, "brain.golden.json");
  writePrivateEvalTemplate(destination);
  const identity = lstatSync(destination);
  assert.equal(identity.isFile(), true);
  assert.equal(identity.isSymbolicLink(), false);
  assert.equal(identity.nlink, 1);
  if (process.platform !== "win32") assert.equal(identity.mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(destination, "utf8")).schema_version, 1);

  assert.throws(
    () => writePrivateEvalTemplate(destination),
    /already exists/i,
  );
  assert.throws(
    () => writePrivateEvalTemplate(destination, { force: true }),
    /never|not supported|rename/i,
  );

  if (process.platform !== "win32") {
    const outside = join(sandbox, "outside");
    const linked = join(sandbox, "linked.golden.json");
    writeFileSync(outside, "must stay unchanged", { mode: 0o600 });
    symlinkSync(outside, linked);
    assert.throws(() => writePrivateEvalTemplate(linked), /already exists/i);
    assert.equal(readFileSync(outside, "utf8"), "must stay unchanged");
  }

  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^brain\.golden\.json$/m);

  const explicitDefaultArgs = evalChildArguments(
    "https://brain.fixture.invalid",
    destination,
    "smoke",
  );
  assert.deepEqual(
    explicitDefaultArgs.slice(-2),
    ["--profile", "smoke"],
    "the child must never inherit a different profile from its local config",
  );

  const cli = fileURLToPath(new URL("../brain.mjs", import.meta.url));
  const isolateSupport = fileURLToPath(new URL("./fixtures/isolate-support-root.mjs", import.meta.url));
  const isolatedUserRoot = join(sandbox, "isolated-user-root");
  mkdirSync(isolatedUserRoot, { mode: 0o700 });
  const runReleasePreflight = (manifestPath, goldenPath = destination, extraArgs = []) => {
    const environment = {
      ...process.env,
      BRAIN_TEST_USER_ROOT: isolatedUserRoot,
    };
    delete environment.ADMIN_KEY;
    delete environment.CLOUDFLARE_API_TOKEN;
    delete environment.BRAIN_DEBUG;
    return spawnSync(process.execPath, [
      // Node treats a bare Windows drive path as a URL scheme for --import.
      // A file URL keeps this isolation hook portable across every CI runner.
      "--import", pathToFileURL(isolateSupport).href,
      cli, "eval", manifestPath,
      "--golden", goldenPath,
      "--profile", "release",
      ...extraArgs,
    ], { encoding: "utf8", env: environment, timeout: 10_000 });
  };

  const noDomainManifest = join(sandbox, "no-domain.manifest.json");
  writeFileSync(noDomainManifest, JSON.stringify({
    client: { slug: "fixture" },
    brain: { worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "fixture-account" } },
    operations: { admin_key_secret: null },
  }));
  const beforeAccount = runReleasePreflight(noDomainManifest);
  const accountOutput = `${beforeAccount.stdout || ""}${beforeAccount.stderr || ""}`;
  assert.equal(beforeAccount.status, 1, accountOutput);
  assert.match(accountOutput, /release profile coverage gate failed before retrieval/);
  assert.doesNotMatch(accountOutput, /CLOUDFLARE_API_TOKEN|Cloudflare account|returned non-JSON/);

  const domainManifest = join(sandbox, "domain.manifest.json");
  writeFileSync(domainManifest, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "brain.fixture.invalid", worker_name: "fixture-brain" },
    operations: { admin_key_secret: null },
  }));
  const beforeAdminKey = runReleasePreflight(domainManifest);
  const keyOutput = `${beforeAdminKey.stdout || ""}${beforeAdminKey.stderr || ""}`;
  assert.equal(beforeAdminKey.status, 1, keyOutput);
  assert.match(keyOutput, /release profile coverage gate failed before retrieval/);
  assert.doesNotMatch(keyOutput, /no admin key found|set ADMIN_KEY|Keychain/);

  const fullReleasePath = join(sandbox, "full-release.golden.json");
  const fullReleaseQuestions = Array.from({ length: 60 }, (_, index) => ({
    id: `release-${index + 1}`,
    kind: index >= 55 ? "unanswerable" : "single",
    risk: index < 5 ? "critical" : "normal",
    domains: ["general"],
    formats: ["text"],
    question: `Synthetic release question ${index + 1}`,
    expect: index >= 55 ? [] : [{ any_of: ["curated:fixture"] }],
  }));
  writeFileSync(fullReleasePath, JSON.stringify({
    schema_version: 1,
    release_slices: {
      risk: ["critical", "normal"],
      domain: ["general"],
      format: ["text"],
      query_kind: ["single", "unanswerable"],
    },
    questions: fullReleaseQuestions,
  }));
  const skipBeforeAdminKey = runReleasePreflight(domainManifest, fullReleasePath, ["--no-think"]);
  const skipOutput = `${skipBeforeAdminKey.stdout || ""}${skipBeforeAdminKey.stderr || ""}`;
  assert.equal(skipBeforeAdminKey.status, 1, skipOutput);
  assert.match(skipOutput, /--no-think cannot be used with the release profile/);
  assert.doesNotMatch(skipOutput, /no admin key found|set ADMIN_KEY|Keychain/);

  console.log("eval init privacy: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
