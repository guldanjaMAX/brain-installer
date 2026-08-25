import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseSetupAccount,
  cmdSetup,
  persistWorkersDevDomain,
} from "../brain.mjs";

const oneAccount = { id: "a".repeat(32), name: "Owner account" };

assert.deepEqual(
  await chooseSetupAccount(async () => { throw new Error("one account needs no prompt"); }, {
    listAccounts: async () => [oneAccount],
  }),
  oneAccount,
);

const secondAccount = { id: "b".repeat(32), name: "Second account" };
assert.deepEqual(
  await chooseSetupAccount(async () => secondAccount.id, {
    listAccounts: async () => [oneAccount, secondAccount],
  }),
  secondAccount,
);
await assert.rejects(
  chooseSetupAccount(async () => "not-visible", {
    listAccounts: async () => [oneAccount, secondAccount],
  }),
  /not one this permission pass can see/i,
);

const sandbox = mkdtempSync(join(tmpdir(), "brain-clean-setup-"));
try {
  const domainManifest = join(sandbox, "domain.manifest.json");
  const domainValue = {
    client: { slug: "clean" },
    brain: { worker_name: "clean-brain" },
    infrastructure: { cloudflare: { account_id: oneAccount.id } },
  };
  writeFileSync(domainManifest, JSON.stringify(domainValue));
  const domain = await persistWorkersDevDomain(
    domainManifest,
    domainValue,
    oneAccount,
    "clean-brain",
    { readSubdomain: async () => ({ subdomain: "owner-subdomain" }) },
  );
  assert.equal(domain, "clean-brain.owner-subdomain.workers.dev");
  assert.equal(JSON.parse(readFileSync(domainManifest, "utf8")).brain.domain, domain);

  const target = join(sandbox, "Financial Brain", "brain.manifest.json");
  const events = [];
  const key = `fixture-${"k".repeat(40)}`;
  const prompt = async (question, fallback) => {
    if (/what is this brain for/i.test(question)) return "Clean Brain";
    if (/short name/i.test(question)) return "clean-brain";
    if (/folder to load/i.test(question)) return "";
    return fallback || "";
  };
  await cmdSetup(target, {
    ask: prompt,
    doctorRunAll: async () => [],
    listCloudflareAccounts: async () => [oneAccount],
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "generated", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { events.push("verify"); },
    cmdProvision: async (path) => {
      events.push("provision");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.infrastructure.cloudflare.d1_database_id = "fixture-d1";
      writeFileSync(path, JSON.stringify(value));
    },
    cmdMigrate: async () => { events.push("migrate"); },
    cmdDeploy: async (path) => {
      events.push("deploy");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.brain.domain = "clean-brain.owner-subdomain.workers.dev";
      writeFileSync(path, JSON.stringify(value));
    },
    cmdSecrets: async (_path, options) => {
      events.push("secrets");
      assert.equal(options.explicitAdminKey, key);
    },
    cmdHealth: async (_path, options) => {
      events.push("health");
      assert.equal(options.durableAdminKeyOnly, true);
    },
    wireAgents: async (manifest) => {
      events.push("wire");
      assert.equal(manifest.infrastructure.cloudflare.d1_database_id, "fixture-d1");
      assert.equal(manifest.brain.domain, "clean-brain.owner-subdomain.workers.dev");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
  });
  assert.deepEqual(events, ["verify", "provision", "migrate", "deploy", "secrets", "health", "wire"]);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.infrastructure.cloudflare.account_id, oneAccount.id);
  assert.equal(saved.brain.domain, "clean-brain.owner-subdomain.workers.dev");
  if (process.platform !== "win32") {
    const { mode } = (await import("node:fs")).lstatSync(target);
    assert.equal(mode & 0o777, 0o600);
  }
  console.log("clean setup path: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
