import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

// Terminal schema facts come from the migrations directory, not a literal,
// so adding migration 00NN never breaks this suite (found at 13 -> 14).
const MIGRATION_FILES = readdirSync(new URL("../migrations/d1/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name));
const LATEST_SCHEMA = Math.max(...MIGRATION_FILES.map((name) => Number(name.slice(0, 4))));
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseSetupAccount,
  cmdMigrate,
  cmdSetup,
  persistWorkersDevDomain,
} from "../brain.mjs";
import {
  installedManifestPointerPath,
  readInstalledManifest,
} from "../operations/installed-manifest.mjs";

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
  const installedManifestOptions = {
    home: sandbox,
    stateDirectory: join(sandbox, "installed-state"),
  };
  const events = [];
  const key = `fixture-${"k".repeat(40)}`;
  const prompt = async (question, fallback) => {
    if (/what is this brain for/i.test(question)) return "Clean Brain";
    if (/short name/i.test(question)) return "clean-brain";
    if (/folder to load/i.test(question)) return "";
    return fallback || "";
  };
  await cmdSetup(target, {
    setupWorkerScriptExists: async () => false,
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
    cmdMigrate: async (_path, options) => {
      assert.notEqual(options?.vectorDrainQuiesced, true);
      events.push("migrate");
    },
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
    cmdDrain: async (path) => {
      assert.equal(path, target);
      events.push("drain");
    },
    cmdHealth: async (_path, options) => {
      events.push("health");
      assert.equal(options.durableAdminKeyOnly, true);
      assert.equal(options.expectDrainMode, "active");
    },
    wireAgents: async (manifest) => {
      events.push("wire");
      assert.equal(manifest.infrastructure.cloudflare.d1_database_id, "fixture-d1");
      assert.equal(manifest.brain.domain, "clean-brain.owner-subdomain.workers.dev");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  assert.deepEqual(events, ["verify", "provision", "migrate", "deploy", "secrets", "drain", "health", "wire"]);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(saved.infrastructure.cloudflare.account_id, oneAccount.id);
  assert.equal(saved.brain.domain, "clean-brain.owner-subdomain.workers.dev");
  assert.equal(readInstalledManifest(installedManifestOptions), realpathSync.native(target));

  const resumedEvents = [];
  let resumedPinnedPath = null;
  await cmdSetup(target, {
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async (path) => {
      resumedPinnedPath = path;
      assert.notEqual(path, target);
      return true;
    },
    captureSetupD1Bookmark: async (path) => {
      assert.equal(path, resumedPinnedPath);
      resumedEvents.push("bookmark");
      return "setup-bookmark";
    },
    waitForVectorDrainQuiescence: async (milliseconds) => {
      resumedEvents.push(`wait:${milliseconds}`);
    },
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { resumedEvents.push("verify"); },
    cmdProvision: async () => { resumedEvents.push("provision"); },
    cmdMigrate: async (path, options) => {
      assert.equal(path, resumedPinnedPath);
      resumedEvents.push(`migrate:${options?.vectorDrainQuiesced === true}`);
    },
    cmdDeploy: async (path, options = {}) => {
      assert.equal(path, resumedPinnedPath);
      assert.equal(options.persistDomain, false);
      resumedEvents.push(`deploy:${options.pauseVectorDrainForUpgrade === true}`);
    },
    cmdSecrets: async (path) => {
      assert.equal(path, target);
      resumedEvents.push("secrets");
    },
    cmdDrain: async (path) => {
      assert.equal(path, target);
      resumedEvents.push("drain");
    },
    cmdHealth: async (path, options) => {
      assert.equal(path, options.reachOnly ? resumedPinnedPath : target);
      resumedEvents.push(options.reachOnly ? `health:${options.expectDrainMode}` : "health:durable");
    },
    wireAgents: async () => {
      resumedEvents.push("wire");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  assert.deepEqual(resumedEvents, [
    "verify",
    "provision",
    "bookmark",
    "deploy:true",
    "health:paused-for-upgrade",
    "wait:1200000",
    "migrate:true",
    "deploy:false",
    "health:active",
    "secrets",
    "drain",
    "health:durable",
    "wire",
  ]);

  // An interrupted projection bootstrap is a durable partial success: setup
  // stops before full health/wiring, and a rerun invokes the same drain again
  // so its D1 cursor can resume before setup is allowed to turn green.
  const convergenceEvents = [];
  const convergenceOptions = {
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async () => true,
    captureSetupD1Bookmark: async () => "convergence-bookmark",
    waitForVectorDrainQuiescence: async () => {},
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => {},
    cmdProvision: async () => {},
    cmdMigrate: async () => {},
    cmdDeploy: async () => {},
    cmdSecrets: async () => { convergenceEvents.push("secrets"); },
    cmdHealth: async (_path, options) => {
      if (!options.reachOnly) convergenceEvents.push("full-health");
    },
    wireAgents: async () => {
      convergenceEvents.push("wire");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  };
  await assert.rejects(
    cmdSetup(target, {
      ...convergenceOptions,
      cmdDrain: async () => {
        convergenceEvents.push("drain:partial");
        throw new Error("synthetic durable bootstrap timeout; rerun to resume");
      },
    }),
    /durable bootstrap timeout.*resume/i,
  );
  assert.deepEqual(convergenceEvents, ["secrets", "drain:partial"]);
  await cmdSetup(target, {
    ...convergenceOptions,
    cmdDrain: async () => { convergenceEvents.push("drain:resumed"); },
  });
  assert.deepEqual(convergenceEvents, [
    "secrets",
    "drain:partial",
    "secrets",
    "drain:resumed",
    "full-health",
    "wire",
  ]);

  // A mutable user manifest cannot redirect migration after the bookmark or
  // during the old-invocation grace window. The pinned compatibility Worker
  // remains safe and no migration/active deployment runs.
  const stableManifest = readFileSync(target, "utf8");
  const driftEvents = [];
  await assert.rejects(
    cmdSetup(target, {
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => true,
      captureSetupD1Bookmark: async () => "drift-bookmark",
      waitForVectorDrainQuiescence: async () => {
        driftEvents.push("wait");
        const changed = JSON.parse(readFileSync(target, "utf8"));
        changed.infrastructure.cloudflare.d1_database_id = "different-database-after-bookmark";
        changed.brain.worker_name = "different-worker-after-bookmark";
        writeFileSync(target, JSON.stringify(changed));
      },
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => {},
      cmdProvision: async () => {},
      cmdMigrate: async () => { driftEvents.push("MIGRATED"); },
      cmdDeploy: async (_path, options = {}) => {
        driftEvents.push(options.pauseVectorDrainForUpgrade ? "paused" : "ACTIVE");
      },
      cmdHealth: async () => {},
      cmdSecrets: async () => { driftEvents.push("SECRETS"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /manifest changed.*no later stage|verified vector-writer cutover/i,
  );
  assert.deepEqual(driftEvents, ["paused", "wait"]);
  writeFileSync(target, stableManifest);

  const activeHealthEvents = [];
  await assert.rejects(
    cmdSetup(target, {
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => true,
      captureSetupD1Bookmark: async () => "active-health-bookmark",
      waitForVectorDrainQuiescence: async () => { activeHealthEvents.push("wait"); },
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => {},
      cmdProvision: async () => {},
      cmdMigrate: async () => { activeHealthEvents.push("migrate"); },
      cmdDeploy: async (_path, options = {}) => {
        activeHealthEvents.push(options.pauseVectorDrainForUpgrade ? "paused" : "active");
      },
      cmdHealth: async (_path, options) => {
        activeHealthEvents.push(`health:${options.expectDrainMode}`);
        if (options.expectDrainMode === "active") throw new Error("synthetic active mode not live");
      },
      cmdSecrets: async () => { activeHealthEvents.push("SECRETS"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /synthetic active mode not live/,
  );
  assert.deepEqual(activeHealthEvents, [
    "paused", "health:paused-for-upgrade", "wait", "migrate", "active", "health:active",
  ]);

  const renamedWorkerEvents = [];
  await assert.rejects(
    cmdSetup(target, {
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => false,
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => { renamedWorkerEvents.push("verify"); },
      cmdProvision: async () => { renamedWorkerEvents.push("provision"); },
      cmdMigrate: async (_path, options) => {
        renamedWorkerEvents.push("guard");
        assert.notEqual(options?.vectorDrainQuiesced, true);
        throw new Error("synthetic live-install migration guard");
      },
      cmdDeploy: async () => { renamedWorkerEvents.push("DEPLOYED"); },
      cmdHealth: async () => {},
      cmdSecrets: async () => {},
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /synthetic live-install migration guard/,
  );
  assert.deepEqual(renamedWorkerEvents, ["verify", "provision", "guard"]);

  // A first setup can be interrupted after D1 committed migration 0001 but
  // before the runner wrote its receipt or install-state singleton. Absence of
  // the exact manifest Worker is not proof that a renamed legacy Worker is not
  // still writing this D1, so setup must stop without another mutation and
  // point at the verified paused-writer cutover. Once that exact Worker exists
  // (including an update interrupted after its paused deploy), setup can prove
  // quiescence and resume the real migration prefix safely.
  const partialManifest = join(sandbox, "partial-migration.manifest.json");
  writeFileSync(partialManifest, stableManifest);
  const partialDb = new DatabaseSync(":memory:");
  partialDb.exec(readFileSync(
    new URL("../migrations/d1/0001_install_state.sql", import.meta.url),
    "utf8",
  ));
  let partialMutations = 0;
  const partialQuery = async (_account, _database, sql, params = []) => {
    const text = String(sql).trim();
    if (/^(?:SELECT|PRAGMA)\b/i.test(text)) {
      return { results: partialDb.prepare(sql).all(...params) };
    }
    let result = null;
    if (params.length) result = partialDb.prepare(sql).run(...params);
    else partialDb.exec(sql);
    partialMutations++;
    return { results: [], meta: { changes: Number(result?.changes || 0) } };
  };
  const runPartialMigration = (path, options = {}) => cmdMigrate(path, {
    ...options,
    silent: true,
    resolveAccount: async () => ({ id: oneAccount.id }),
    d1Query: partialQuery,
  });
  const partialEvents = [];
  await assert.rejects(
    cmdSetup(partialManifest, {
      ask: prompt,
      doctorRunAll: async () => [],
      setupWorkerScriptExists: async () => false,
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
      cmdVerify: async () => { partialEvents.push("verify"); },
      cmdProvision: async () => { partialEvents.push("provision"); },
      cmdMigrate: async (path, options) => {
        partialEvents.push("migrate-unquiesced");
        return runPartialMigration(path, options);
      },
      cmdDeploy: async () => { partialEvents.push("DEPLOYED"); },
      cmdHealth: async () => { partialEvents.push("HEALTH"); },
      cmdSecrets: async () => { partialEvents.push("SECRETS"); },
      cmdDrain: async () => { partialEvents.push("DRAIN"); },
      wireAgents: async () => ({ wired: [], failures: [], skipped: [] }),
      backlogCount: async () => 0,
      installedManifestOptions,
    }),
    /cannot be proven.*brain update .*brain setup/is,
  );
  assert.deepEqual(partialEvents, ["verify", "provision", "migrate-unquiesced"]);
  assert.equal(partialMutations, 0);
  assert.equal(partialDb.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 0);

  partialEvents.length = 0;
  await cmdSetup(partialManifest, {
    ask: prompt,
    doctorRunAll: async () => [],
    setupWorkerScriptExists: async () => true,
    captureSetupD1Bookmark: async () => {
      partialEvents.push("bookmark");
      return "partial-setup-bookmark";
    },
    waitForVectorDrainQuiescence: async (milliseconds) => {
      partialEvents.push(`wait:${milliseconds}`);
    },
    configureStandardAdminKeyStorage: () => ({ changed: false }),
    prepareSetupAdminKey: async () => ({ source: "durable", value: key, plan: { backend: "file" } }),
    cmdVerify: async () => { partialEvents.push("verify"); },
    cmdProvision: async () => { partialEvents.push("provision"); },
    cmdMigrate: async (path, options) => {
      partialEvents.push(`migrate:${options?.vectorDrainQuiesced === true}`);
      return runPartialMigration(path, options);
    },
    cmdDeploy: async (_path, options) => {
      partialEvents.push(options.pauseVectorDrainForUpgrade ? "deploy:paused" : "deploy:active");
    },
    cmdHealth: async (_path, options) => {
      partialEvents.push(options.reachOnly
        ? `health:${options.expectDrainMode}`
        : "health:durable");
    },
    cmdSecrets: async () => { partialEvents.push("secrets"); },
    cmdDrain: async () => { partialEvents.push("drain"); },
    wireAgents: async () => {
      partialEvents.push("wire");
      return { wired: [], failures: [], skipped: [] };
    },
    backlogCount: async () => 0,
    installedManifestOptions,
  });
  assert.deepEqual(partialEvents, [
    "verify",
    "provision",
    "bookmark",
    "deploy:paused",
    "health:paused-for-upgrade",
    `wait:${20 * 60 * 1000}`,
    "migrate:true",
    "deploy:active",
    "health:active",
    "secrets",
    "drain",
    "health:durable",
    "wire",
  ]);
  assert.ok(partialMutations > 0);
  const partialState = partialDb.prepare(
    "SELECT schema_version, vector_projection_status FROM install_state WHERE id=1",
  ).get();
  assert.equal(partialState.schema_version, LATEST_SCHEMA);
  assert.equal(partialState.vector_projection_status, "verified");
  assert.equal(partialDb.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, MIGRATION_FILES.length);
  partialDb.close();

  if (process.platform !== "win32") {
    const { mode } = lstatSync(target);
    assert.equal(mode & 0o777, 0o600);
    assert.equal(lstatSync(installedManifestPointerPath(installedManifestOptions)).mode & 0o777, 0o600);
    assert.equal(lstatSync(installedManifestOptions.stateDirectory).mode & 0o777, 0o700);
  }
  console.log("clean setup path: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
