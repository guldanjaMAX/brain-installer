// From Jay's second field report, 2026-08-19.
//
// `brain upgrade` probed /health, got a 200 from the worker it was REPLACING,
// printed that worker's version, and declared the new one verified:
//
//     ok deployed "bhakta-brain"
//     ok /health 200 {"ok":true,"version":"0.1.1", ...}
//     ok upgrade verified, now at 0.1.2
//
// Sixteen seconds later /health returned 0.1.2, so nothing was harmed that time.
// But the check would pass green on a deploy that genuinely failed, which makes
// it worse than no check: it converts an unknown into a false assurance.

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudflareTokenAvailable,
  cmdRollback,
  cmdRollbackInteractive,
  cmdUpdate,
  cmdUpgrade,
  commitManifestVersion,
  compareSemver,
  healthProbeVerdict,
} from "../brain.mjs";
import { Acceptance, credentialGateRefusalVerdict } from "../acceptance.mjs";
import {
  installedManifestPointerPath,
  readInstalledManifest,
  rememberInstalledManifest,
} from "../operations/installed-manifest.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => { ran++; console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 200))); if (!c) fail++; };

const V = (o) => healthProbeVerdict(o);
const body = (v) => JSON.stringify({ ok: true, brain: "x", version: v });
const manifestFixture = (version = "0.1.9") => ({
  client: { slug: "fixture" },
  brain: { worker_name: "fixture-brain", version },
  infrastructure: {
    cloudflare: {
      account_id: "fixture-account",
      d1_database_id: "fixture-database",
      storage: "d1",
    },
  },
  retrieval: { answer_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", rerank: false },
});

/* ---- the exact failure Jay saw ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("a 200 from the OLD worker is not accepted as the new one", v !== "accept", `got ${v}`);
  check("it retries instead, because propagation is normal", v === "retry", `got ${v}`);
}

/* ---- full acceptance independently enforces the deployed version ---- */
{
  const suite = new Acceptance({
    base: "https://fixture.invalid",
    adminKey: "fixture-admin-key",
    manifest: {},
    expectVersion: "0.1.13",
    fetchImpl: async () => new Response(body("0.1.9"), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await suite.tierReach();
  check("the full acceptance suite rejects an old Worker version",
    suite.results[0]?.status === "fail" && /expected version 0\.1\.13/.test(suite.results[0]?.detail || ""),
    JSON.stringify(suite.results));
}

/* ---- it must eventually give up rather than pass ---- */
{
  const v = V({ ok: true, body: body("0.1.1"), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("if the old version is STILL serving on the last attempt, it FAILS", v === "fail", `got ${v}`);
}

/* ---- the happy path still works ---- */
{
  check("the expected version is accepted immediately",
    V({ ok: true, body: body("0.1.2"), expectVersion: "0.1.2", attempt: 1, attempts: 6 }) === "accept");
  check("a plain health check with no expectation still accepts any 200",
    V({ ok: true, body: body("0.1.1"), expectVersion: null, attempt: 1, attempts: 6 }) === "accept");
}

/* ---- a body that cannot be parsed must not be read as success ---- */
{
  const v = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 1, attempts: 6 });
  check("an unparseable body is not treated as the right version", v !== "accept", `got ${v}`);
  const last = V({ ok: true, body: "<html>gateway</html>", expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("and fails once the attempts are spent", last === "fail", `got ${last}`);
}

/* ---- a version-less body is not a pass either ---- */
{
  const v = V({ ok: true, body: JSON.stringify({ ok: true }), expectVersion: "0.1.2", attempt: 6, attempts: 6 });
  check("a 200 carrying no version at all fails rather than passing", v === "fail", `got ${v}`);
}

/* ---- non-200s keep the old retry behaviour ---- */
{
  check("a 404 retries while attempts remain", V({ ok: false, body: "", attempt: 1, attempts: 6 }) === "retry");
  check("and fails when they are spent", V({ ok: false, body: "", attempt: 6, attempts: 6 }) === "fail");
}

/* ---- a normal upgrade reconciles provider secrets before health passes ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-provider-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const events = [];
    let accountChecks = 0;
    const executionPaths = new Set();
    let d1Version = "0.1.9";
    await cmdUpgrade(manifestPath, {
      resolveAccount: async () => {
        accountChecks++;
        return { id: "fixture-account" };
      },
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
        if (/SELECT \* FROM install_state/i.test(sql)) {
          events.push("state");
          return { results: [{ client_slug: "fixture", product_version: d1Version }] };
        }
        if (/UPDATE install_state/i.test(sql)) {
          events.push("version");
          d1Version = "0.1.13";
        }
        if (/SELECT product_version FROM install_state/i.test(sql)) {
          events.push("readback");
          return { results: [{ product_version: d1Version }] };
        }
        if (/INSERT INTO upgrade_runs/i.test(sql)) events.push("log");
        return { results: [] };
      },
      cf: async () => {
        events.push("bookmark");
        return { bookmark: "fixture-bookmark" };
      },
      cmdMigrate: async (path) => { executionPaths.add(path); events.push("migrate"); },
      cmdDeploy: async (path, options) => {
        executionPaths.add(path);
        events.push("deploy");
        // Model cmdDeploy's legacy no-domain behavior. Without the explicit
        // update override this write changes the pinned execution artifact and
        // the next lifecycle revalidation fails after a live deployment.
        if (options?.persistDomain !== false) {
          const value = JSON.parse(readFileSync(path, "utf8"));
          value.brain.domain = "fixture-brain.owner.workers.dev";
          writeFileSync(path, JSON.stringify(value));
        }
        check("legacy update deploy cannot persist into the pinned manifest",
          options?.persistDomain === false, JSON.stringify(options));
      },
      reconcileWorkerProviderSecrets: async (_manifest, account, scriptName, allowed) => {
        events.push("reconcile");
        check("upgrade reconciliation uses the resolved account", account.id === "fixture-account");
        check("upgrade reconciliation targets only this worker", scriptName === "fixture-brain");
        check("standard D1 upgrade allows no provider secrets", Array.isArray(allowed) && allowed.length === 0);
      },
      cmdHealth: async (path, options) => {
        executionPaths.add(path);
        events.push("health");
        check("upgrade health requires the running package version", options.expectVersion === "0.1.13");
      },
      cmdTest: async (path, options) => {
        executionPaths.add(path);
        events.push("test");
        check("upgrade acceptance requires the running package version", options.expectVersion === "0.1.13");
      },
      commitManifestVersion: (path, version) => {
        events.push("manifest");
        check("manifest advances only to the running package version", version === "0.1.13");
        return commitManifestVersion(path, version);
      },
    });
    check(
      "upgrade reconciles provider secrets after deploy and before health",
      events.join(",") === "state,bookmark,migrate,deploy,reconcile,health,test,version,readback,manifest,log",
      events.join(","),
    );
    check("every remote lifecycle stage revalidates the token account", accountChecks >= 10, String(accountChecks));
    check(
      "mutating and acceptance stages use one pinned execution manifest",
      executionPaths.size === 1 && !executionPaths.has(manifestPath),
      JSON.stringify([...executionPaths]),
    );
    check(
      "the private execution manifest is removed after success",
      !readdirSync(sandbox).some((name) => name.includes(".brain-update-")),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- no restore bookmark means no mutation at all ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-bookmark-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const mutations = [];
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_a, _d, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/^SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          mutations.push(`d1:${sql.slice(0, 12)}`);
          return { results: [] };
        },
        cf: async () => ({}),
        cmdMigrate: async () => mutations.push("migrate"),
        cmdDeploy: async () => mutations.push("deploy"),
      });
    } catch (caught) { error = caught; }
    check("a missing bookmark aborts before every mutation",
      /required D1 restore bookmark/.test(error?.message || "") && mutations.length === 0,
      `${error?.message}; ${mutations.join(",")}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- acceptance failure cannot advance either version ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-acceptance-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let versionWrites = 0;
    let manifestWrites = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_a, _d, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/UPDATE install_state/i.test(sql)) versionWrites++;
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "fixture-required-bookmark" }),
        cmdMigrate: async () => {},
        cmdDeploy: async () => {},
        reconcileWorkerProviderSecrets: async () => {},
        cmdHealth: async () => {},
        cmdTest: async () => { throw new Error("acceptance fixture failed"); },
        commitManifestVersion: () => { manifestWrites++; },
      });
    } catch (caught) { error = caught; }
    check("failed acceptance leaves D1 and manifest versions unchanged",
      versionWrites === 0 && manifestWrites === 0 &&
        JSON.parse(readFileSync(manifestPath, "utf8")).brain.version === "0.1.9",
      `d1=${versionWrites} manifest=${manifestWrites}`);
    check("every post-snapshot failure preserves the recovery bookmark",
      /fixture-required-bookmark/.test(error?.message || "") && /full acceptance test/.test(error?.message || ""),
      error?.message);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- manifest version commit is atomic and verified ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-manifest-version-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture(), null, 2) + "\n");
    commitManifestVersion(manifestPath, "0.1.13");
    const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    check("the local manifest records the verified package version", committed.brain.version === "0.1.13");
    check("the manifest commit leaves no temporary file", !readdirSync(sandbox).some((name) => name.endsWith(".tmp")));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- the credential gate is proven by its exact structured contract ---- */
{
  const refusal = {
    error: "refused: content carries live credential(s)",
    labels: ["cloudflare_token_new", "env_assignment"],
    detail: "Rotate them, strip them from the source, then re-ingest. Nothing was written.",
  };
  check(
    "credential acceptance requires the production HTTP 422 structure",
    credentialGateRefusalVerdict({ status: 422, text: JSON.stringify(refusal) }).accepted,
  );
  check(
    "a bare 422 is not mistaken for the credential scanner",
    !credentialGateRefusalVerdict({ status: 422, text: "unprocessable" }).accepted,
  );
  check(
    "an unrelated structured 422 is not mistaken for the credential scanner",
    !credentialGateRefusalVerdict({ status: 422, text: JSON.stringify({ error: "refused" }) }).accepted,
  );
  check(
    "a refusal that does not name the Cloudflare canary is not accepted",
    !credentialGateRefusalVerdict({ status: 422, text: JSON.stringify({ ...refusal, labels: ["env_assignment"] }) }).accepted,
  );
  check(
    "the right body on the wrong HTTP status is not accepted",
    !credentialGateRefusalVerdict({ status: 400, text: JSON.stringify(refusal) }).accepted,
  );
}

/* ---- semantic-version ordering refuses a downgrade before mutation ---- */
{
  check("semantic versions compare numeric components", compareSemver("0.1.11", "0.1.10") > 0);
  check("a release sorts after its prerelease", compareSemver("1.0.0", "1.0.0-rc.1") > 0);

  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-downgrade-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.2.0")));
    let mutations = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => /sqlite_master/i.test(sql)
          ? { results: [{ name: "install_state" }] }
          : { results: [{ client_slug: "fixture", product_version: "0.2.0" }] },
        cf: async () => { mutations++; return { bookmark: "must-not-exist" }; },
        cmdMigrate: async () => { mutations++; },
        cmdDeploy: async () => { mutations++; },
      });
    } catch (caught) { error = caught; }
    check(
      "a newer installed version is never downgraded by an older CLI",
      /refused to downgrade/.test(error?.message || "") && mutations === 0,
      `${error?.message}; mutations=${mutations}`,
    );
    check(
      "downgrade refusal cleans its pinned execution manifest",
      !readdirSync(sandbox).some((name) => name.includes(".brain-update-")),
    );

    const localNewerPath = join(sandbox, "local-newer.manifest.json");
    writeFileSync(localNewerPath, JSON.stringify(manifestFixture("0.2.0")));
    let localNewerError = null;
    try {
      await cmdUpgrade(localNewerPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => /sqlite_master/i.test(sql)
          ? { results: [{ name: "install_state" }] }
          : { results: [{ client_slug: "fixture", product_version: "0.1.9" }] },
        cf: async () => { mutations++; return { bookmark: "must-not-exist" }; },
      });
    } catch (caught) { localNewerError = caught; }
    check(
      "a newer pinned manifest also prevents an older CLI from mutating D1",
      /refused to downgrade/.test(localNewerError?.message || "") && mutations === 0,
      `${localNewerError?.message}; mutations=${mutations}`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- absent legacy state is allowed; an unreadable state is not ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-state-")));
  try {
    const unreadablePath = join(sandbox, "unreadable.manifest.json");
    writeFileSync(unreadablePath, JSON.stringify(manifestFixture()));
    let remoteMutations = 0;
    let unreadableError = null;
    try {
      await cmdUpgrade(unreadablePath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async () => { throw new Error("synthetic D1 outage"); },
        cf: async () => { remoteMutations++; return { bookmark: "not-allowed" }; },
        cmdMigrate: async () => { remoteMutations++; },
      });
    } catch (caught) { unreadableError = caught; }
    check(
      "a D1 read failure stops before bookmark or migration",
      /install state could not be read/.test(unreadableError?.message || "") && remoteMutations === 0,
      unreadableError?.message,
    );

    const legacyPath = join(sandbox, "legacy.manifest.json");
    writeFileSync(legacyPath, JSON.stringify(manifestFixture()));
    let d1Version = null;
    await cmdUpgrade(legacyPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master/i.test(sql)) return { results: [] };
        if (/UPDATE install_state/i.test(sql)) d1Version = "0.1.13";
        if (/SELECT product_version FROM install_state/i.test(sql)) {
          return { results: [{ product_version: d1Version }] };
        }
        return { results: [] };
      },
      cf: async () => ({ bookmark: "legacy-bookmark" }),
      cmdMigrate: async () => {},
      cmdDeploy: async () => {},
      reconcileWorkerProviderSecrets: async () => {},
      cmdHealth: async () => {},
      cmdTest: async () => {},
    });
    check(
      "a successful empty install_state read follows the legacy migration path",
      JSON.parse(readFileSync(legacyPath, "utf8")).brain.version === "0.1.13",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- unsafe manifest paths stop before account or database access ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-path-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const symlinkPath = join(sandbox, "linked.manifest.json");
    symlinkSync(manifestPath, symlinkPath);
    let remoteReads = 0;
    let symlinkError = null;
    try {
      await cmdUpgrade(symlinkPath, {
        resolveAccount: async () => { remoteReads++; return { id: "fixture-account" }; },
      });
    } catch (caught) { symlinkError = caught; }
    check(
      "a symlink manifest is refused before any Cloudflare access",
      /regular file, not a link/.test(symlinkError?.message || "") && remoteReads === 0,
      symlinkError?.message,
    );

    const hardlinkPath = join(sandbox, "hardlinked.manifest.json");
    linkSync(manifestPath, hardlinkPath);
    let hardlinkError = null;
    try {
      await cmdUpgrade(hardlinkPath, {
        resolveAccount: async () => { remoteReads++; return { id: "fixture-account" }; },
      });
    } catch (caught) { hardlinkError = caught; }
    check(
      "a hard-linked manifest is refused before any Cloudflare access",
      /regular file, not a link/.test(hardlinkError?.message || "") && remoteReads === 0,
      hardlinkError?.message,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- manifest and account identity stay pinned between every stage ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-upgrade-drift-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let deployed = 0;
    let error = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "drift-bookmark" }),
        cmdMigrate: async () => {
          writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.1.8")));
        },
        cmdDeploy: async () => { deployed++; },
      });
    } catch (caught) { error = caught; }
    check(
      "a manifest fingerprint change stops before the next remote stage",
      /manifest changed during migration/.test(error?.message || "") && deployed === 0,
      error?.message,
    );
    check(
      "beginner failure guidance does not present incomplete rollback as one command",
      !/brain rollback/.test(error?.message || "") && /does not restore Vectorize/.test(error?.message || ""),
      error?.message,
    );
    check(
      "failed drift detection removes the pinned execution manifest",
      !readdirSync(sandbox).some((name) => name.includes(".brain-update-")),
    );

    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let resolvedAccount = "fixture-account";
    let secondDeploy = 0;
    let accountError = null;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: resolvedAccount }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/i.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "account-bookmark" }),
        cmdMigrate: async () => { resolvedAccount = "other-account"; },
        cmdDeploy: async () => { secondDeploy++; },
      });
    } catch (caught) { accountError = caught; }
    check(
      "a changed token account stops before the next remote stage",
      /account identity changed during deployment/.test(accountError?.message || "") && secondDeploy === 0,
      accountError?.message,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- rollback is a preview until explicit confirmation ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-rollback-confirmation-")));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    let accountReads = 0;
    let remoteMutations = 0;
    let historyWrites = 0;
    const output = [];
    const priorLog = console.log;
    let preview;
    try {
      console.log = (...values) => output.push(values.map(String).join(" "));
      preview = await cmdRollback(manifestPath, "fixture-bookmark", {
        resolveAccount: async () => { accountReads++; return { id: "fixture-account" }; },
        cf: async () => { remoteMutations++; },
        d1Query: async () => { historyWrites++; },
      });
    } finally {
      console.log = priorLog;
    }
    const rendered = output.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    check(
      "direct rollback without --yes is a D1-only destructive preview with a required reindex",
      preview?.confirmed === false && preview?.restored === false &&
        /nothing was changed/i.test(rendered) && /D1 restore is DESTRUCTIVE/i.test(rendered) &&
        /does not restore Vectorize/i.test(rendered) && /reindex/i.test(rendered) && /--yes/.test(rendered),
      rendered,
    );
    check(
      "direct rollback preview performs no account read, Cloudflare mutation, or history write",
      accountReads === 0 && remoteMutations === 0 && historyWrites === 0,
      JSON.stringify({ accountReads, remoteMutations, historyWrites }),
    );

    let invalidBookmarkError = null;
    let invalidBookmarkTokenPrompts = 0;
    try {
      await cmdRollbackInteractive(manifestPath, "not\na\nvalid\nbookmark", {
        readCloudflareToken: async () => {
          invalidBookmarkTokenPrompts++;
          return Buffer.from("x".repeat(24), "ascii");
        },
      });
    } catch (caught) { invalidBookmarkError = caught; }
    check(
      "an invalid rollback bookmark is refused before the token boundary",
      /bookmark is invalid/.test(invalidBookmarkError?.message || "") && invalidBookmarkTokenPrompts === 0,
      invalidBookmarkError?.message,
    );

    const actions = [];
    const restored = await cmdRollback(manifestPath, "fixture-bookmark", {
      confirmed: true,
      resolveAccount: async () => { actions.push("account"); return { id: "fixture-account" }; },
      cf: async (path, request) => {
        actions.push("restore");
        check(
          "confirmed rollback restores only the pinned database bookmark",
          request?.method === "POST" &&
            path === "/accounts/fixture-account/d1/database/fixture-database/time_travel/restore?bookmark=fixture-bookmark",
          `${request?.method} ${path}`,
        );
      },
      d1Query: async (_account, _database, sql) => {
        actions.push("history");
        check("confirmed rollback marks its history as rolled back", /status = 'rolled_back'/.test(sql), sql);
      },
    });
    check(
      "explicit confirmation is the only path that performs the restore",
      restored?.confirmed === true && restored?.restored === true &&
        actions.join(",") === "account,restore,history",
      actions.join(","),
    );

    let ownershipError = null;
    let wrongAccountMutation = 0;
    try {
      await cmdRollback(manifestPath, "fixture-bookmark", {
        confirmed: true,
        resolveAccount: async () => ({ id: "wrong-account" }),
        cf: async () => { wrongAccountMutation++; },
      });
    } catch (caught) { ownershipError = caught; }
    check(
      "confirmed rollback still refuses a token account outside the pinned manifest",
      /token account does not match/.test(ownershipError?.message || "") && wrongAccountMutation === 0,
      ownershipError?.message,
    );

    let manifestDriftError = null;
    let driftMutation = 0;
    try {
      await cmdRollback(manifestPath, "fixture-bookmark", {
        confirmed: true,
        resolveAccount: async () => {
          writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.1.8")));
          return { id: "fixture-account" };
        },
        cf: async () => { driftMutation++; },
      });
    } catch (caught) { manifestDriftError = caught; }
    check(
      "confirmed rollback revalidates the pinned manifest before restore",
      /manifest changed during rollback preflight/.test(manifestDriftError?.message || "") && driftMutation === 0,
      manifestDriftError?.message,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- direct beginner update and rollback wrappers own the token lifecycle ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-update-command-")));
  const priorDirectory = process.cwd();
  const priorToken = process.env.CLOUDFLARE_API_TOKEN;
  try {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
    const installedManifestOptions = {
      home: sandbox,
      stateDirectory: join(sandbox, "installed-state"),
    };
    process.chdir(sandbox);
    let failedVerifyError = null;
    let failedVerifyUpgrade = 0;
    try {
      await cmdUpdate(undefined, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("f".repeat(24), "ascii"),
        cmdVerify: async () => { throw new Error("fixture custody refusal"); },
        cmdUpgrade: async () => { failedVerifyUpgrade++; },
      });
    } catch (caught) { failedVerifyError = caught; }
    check(
      "a failed custody check does not remember the wrong manifest",
      /fixture custody refusal/.test(failedVerifyError?.message || "") &&
        !existsSync(installedManifestPointerPath(installedManifestOptions)) &&
        failedVerifyUpgrade === 0 && !cloudflareTokenAvailable(),
      failedVerifyError?.message,
    );

    const events = [];
    await cmdUpdate(undefined, {
      installedManifestOptions,
      readCloudflareToken: async () => Buffer.from("x".repeat(24), "ascii"),
      cmdVerify: async (path) => {
        events.push(`verify:${path}`);
        check("update verification runs inside the command-scoped token", cloudflareTokenAvailable());
      },
      cmdUpgrade: async (path) => {
        events.push(`upgrade:${path}`);
        check("update execution keeps the command-scoped token", cloudflareTokenAvailable());
      },
    });
    check(
      "brain update discovers the local manifest once and verifies before upgrade",
      events.join(",") === `verify:${manifestPath},upgrade:${manifestPath}`,
      events.join(","),
    );
    check(
      "the first update remembers the canonical manifest without storing credentials",
      readInstalledManifest(installedManifestOptions) === manifestPath &&
        Object.keys(JSON.parse(readFileSync(installedManifestPointerPath(installedManifestOptions), "utf8")))
          .sort().join(",") === "manifest_path,schema_version",
    );
    const durabilityStateDirectory = join(sandbox, "durability-order-state");
    let synchronizedAfterRename = false;
    const durabilityOptions = {
      home: sandbox,
      stateDirectory: durabilityStateDirectory,
      syncStateDirectory: (directory, phase) => {
        const pointerPath = installedManifestPointerPath({ stateDirectory: directory });
        synchronizedAfterRename = phase === "persisted" && existsSync(pointerPath) &&
          JSON.parse(readFileSync(pointerPath, "utf8")).manifest_path === manifestPath;
      },
    };
    rememberInstalledManifest(manifestPath, durabilityOptions);
    check(
      "the pointer durability barrier runs after the atomic rename",
      synchronizedAfterRename && readInstalledManifest(durabilityOptions) === manifestPath,
    );

    const failingDurabilityState = join(sandbox, "durability-failure-state");
    let durabilityError = null;
    try {
      rememberInstalledManifest(manifestPath, {
        home: sandbox,
        stateDirectory: failingDurabilityState,
        syncStateDirectory: () => {
          throw Object.assign(new Error("synthetic private filesystem detail"), { code: "EIO" });
        },
      });
    } catch (caught) { durabilityError = caught; }
    check(
      "an unexpected directory durability failure is never reported as success",
      durabilityError?.code === "INSTALLED_MANIFEST_STATE_DURABILITY" &&
        !String(durabilityError?.message || durabilityError).includes("synthetic private filesystem detail") &&
        !readdirSync(failingDurabilityState).some((name) => name.endsWith(".tmp")),
      durabilityError?.message,
    );
    const windowsFallbackOptions = {
      home: sandbox,
      platform: "win32",
      stateDirectory: join(sandbox, "windows-directory-sync-fallback"),
      syncStateDirectory: () => {
        throw Object.assign(new Error("synthetic unsupported directory handle"), { code: "EINVAL" });
      },
    };
    rememberInstalledManifest(manifestPath, windowsFallbackOptions);
    check(
      "Windows directory-fsync limitations fall back to a verified final-file flush",
      readInstalledManifest(windowsFallbackOptions) === manifestPath,
    );
    if (process.platform !== "win32") {
      check(
        "the remembered location is private",
        (lstatSync(installedManifestPointerPath(installedManifestOptions)).mode & 0o777) === 0o600 &&
          (lstatSync(installedManifestOptions.stateDirectory).mode & 0o777) === 0o700,
      );
    }
    check("the prompted Cloudflare token is gone after update", !cloudflareTokenAvailable());

    const unrelatedManifest = join(sandbox, "unrelated.manifest.json");
    writeFileSync(unrelatedManifest, "{}\n");
    let unrelatedError = null;
    let unrelatedVerify = 0;
    try {
      await cmdUpdate(unrelatedManifest, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("q".repeat(24), "ascii"),
        cmdVerify: async () => { unrelatedVerify++; },
      });
    } catch (caught) { unrelatedError = caught; }
    check(
      "an unrelated JSON object is not remembered when upgrade preflight rejects it",
      unrelatedVerify === 1 &&
        /no d1_database_id in the manifest/i.test(unrelatedError?.message || "") &&
        readInstalledManifest(installedManifestOptions) === manifestPath &&
        !cloudflareTokenAvailable(),
      unrelatedError?.message,
    );

    const freshDirectory = join(sandbox, "a completely different folder");
    mkdirSync(freshDirectory);
    process.chdir(freshDirectory);
    const reopenedEvents = [];
    await cmdUpdate(undefined, {
      installedManifestOptions,
      readCloudflareToken: async () => Buffer.from("r".repeat(24), "ascii"),
      cmdVerify: async (path) => reopenedEvents.push(`verify:${path}`),
      cmdUpgrade: async (path) => reopenedEvents.push(`upgrade:${path}`),
    });
    check(
      "after Terminal is reopened, brain update works from an unrelated folder",
      reopenedEvents.join(",") === `verify:${manifestPath},upgrade:${manifestPath}`,
      reopenedEvents.join(","),
    );
    check("the reopened update also clears its prompted token", !cloudflareTokenAvailable());
    process.chdir(sandbox);

    if (process.platform !== "win32") {
      const pointerPath = installedManifestPointerPath(installedManifestOptions);
      chmodSync(pointerPath, 0o644);
      let unsafeError = null;
      let unsafePrompts = 0;
      let unsafeVerify = 0;
      try {
        await cmdUpdate(undefined, {
          installedManifestOptions,
          readCloudflareToken: async () => {
            unsafePrompts++;
            return Buffer.from("u".repeat(24), "ascii");
          },
          cmdVerify: async () => { unsafeVerify++; },
        });
      } catch (caught) { unsafeError = caught; }
      check(
        "an unsafe saved location fails closed before token entry or Cloudflare work",
        /saved Brain location is not private/i.test(unsafeError?.message || "") &&
          unsafePrompts === 0 && unsafeVerify === 0 && !cloudflareTokenAvailable(),
        unsafeError?.message,
      );
      await cmdUpdate(manifestPath, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("m".repeat(24), "ascii"),
        cmdVerify: async () => {},
        cmdUpgrade: async () => {},
      });
      check(
        "one custody-verified explicit update repairs an unsafe pointer mode",
        readInstalledManifest(installedManifestOptions) === manifestPath &&
          (lstatSync(pointerPath).mode & 0o777) === 0o600,
      );

      const symlinkTarget = join(sandbox, "pointer-symlink-target");
      const symlinkTargetBytes = "do not change this target\n";
      writeFileSync(symlinkTarget, symlinkTargetBytes, { mode: 0o600 });
      rmSync(pointerPath);
      symlinkSync(symlinkTarget, pointerPath);
      await cmdUpdate(manifestPath, {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("s".repeat(24), "ascii"),
        cmdVerify: async () => {},
        cmdUpgrade: async () => {},
      });
      check(
        "explicit repair replaces a pointer symlink without touching its target",
        readFileSync(symlinkTarget, "utf8") === symlinkTargetBytes &&
          lstatSync(pointerPath).isFile() && !lstatSync(pointerPath).isSymbolicLink() &&
          readInstalledManifest(installedManifestOptions) === manifestPath,
      );
    }

    const staleManifest = join(sandbox, "old-brain.manifest.json");
    writeFileSync(staleManifest, JSON.stringify(manifestFixture()));
    rememberInstalledManifest(staleManifest, installedManifestOptions);
    rmSync(staleManifest);
    await cmdUpdate(manifestPath, {
      installedManifestOptions,
      readCloudflareToken: async () => Buffer.from("p".repeat(24), "ascii"),
      cmdVerify: async () => {},
      cmdUpgrade: async () => {},
    });
    check(
      "one explicit full-path update repairs a stale saved location",
      readInstalledManifest(installedManifestOptions) === manifestPath,
      readInstalledManifest(installedManifestOptions),
    );
    check("the repair update clears its prompted token", !cloudflareTokenAvailable());

    let rollbackCalled = 0;
    let rollbackTokenPrompts = 0;
    const rollbackPreview = await cmdRollbackInteractive(manifestPath, "fixture-bookmark", {
      readCloudflareToken: async () => {
        rollbackTokenPrompts++;
        return Buffer.from("y".repeat(24), "ascii");
      },
      cmdRollback: async () => { rollbackCalled++; },
    });
    check(
      "rollback preview does not prompt for a token or enter the destructive command",
      rollbackPreview?.restored === false && rollbackTokenPrompts === 0 && rollbackCalled === 0 &&
        !cloudflareTokenAvailable(),
      JSON.stringify({ rollbackPreview, rollbackTokenPrompts, rollbackCalled }),
    );

    await cmdRollbackInteractive(manifestPath, "fixture-bookmark", {
      confirmed: true,
      readCloudflareToken: async () => Buffer.from("y".repeat(24), "ascii"),
      cmdRollback: async (_path, bookmark, rollbackOptions) => {
        rollbackCalled++;
        check("rollback runs inside the same hidden-token boundary", cloudflareTokenAvailable());
        check("rollback receives the explicit bookmark", bookmark === "fixture-bookmark");
        check("rollback receives explicit confirmation", rollbackOptions.confirmed === true);
      },
    });
    check("the rollback wrapper calls the destructive command exactly once", rollbackCalled === 1);
    check("the prompted Cloudflare token is gone after rollback", !cloudflareTokenAvailable());

    let upgradeCalled = 0;
    let driftError = null;
    try {
      await cmdUpdate("./brain.manifest.json", {
        installedManifestOptions,
        readCloudflareToken: async () => Buffer.from("z".repeat(24), "ascii"),
        cmdVerify: async () => {
          writeFileSync(manifestPath, JSON.stringify(manifestFixture("0.1.8")));
        },
        cmdUpgrade: async () => { upgradeCalled++; },
      });
    } catch (caught) { driftError = caught; }
    check(
      "update revalidates its manifest after account verification",
      /manifest changed during update verification/.test(driftError?.message || "") && upgradeCalled === 0,
      driftError?.message,
    );
    check("the default manifest still exists after lifecycle tests", existsSync(manifestPath));
  } finally {
    process.chdir(priorDirectory);
    if (priorToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = priorToken;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/* ---- the packed user-prefix launcher rediscovers setup state in a fresh process ---- */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-installed-update-")));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const packDirectory = join(sandbox, "pack");
    const fakeHome = join(sandbox, "home");
    const fakeLocalAppData = join(sandbox, "local-app-data");
    const prefix = process.platform === "win32"
      ? join(fakeLocalAppData, "FinancialBrain")
      : join(fakeHome, ".financial-brain");
    const firstDirectory = join(sandbox, "first shell");
    const reopenedDirectory = join(sandbox, "reopened somewhere else");
    const reinstalledDirectory = join(sandbox, "reopened after reinstall");
    mkdirSync(packDirectory, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeLocalAppData, { recursive: true });
    mkdirSync(firstDirectory, { recursive: true });
    mkdirSync(reopenedDirectory, { recursive: true });
    mkdirSync(reinstalledDirectory, { recursive: true });

    const pack = spawnSync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory,
    ], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 60_000,
    });
    let archive = null;
    try { archive = JSON.parse(pack.stdout)?.[0]?.filename || null; } catch { /* fixed check below */ }
    check(
      "the rediscovery acceptance test can build the real release package",
      pack.status === 0 && Boolean(archive),
      pack.stderr || pack.stdout,
    );

    if (pack.status === 0 && archive) {
      const installPacked = (cwd) => spawnSync("npm", [
          "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
          "--prefix", prefix, join(packDirectory, archive),
        ], {
          cwd,
          encoding: "utf8",
          shell: process.platform === "win32",
          timeout: 60_000,
        });
      const install = installPacked(firstDirectory);
      check(
        "the real package installs into a user-owned prefix without sudo",
        install.status === 0,
        install.stderr || install.stdout,
      );

      if (install.status === 0) {
        const installedRoot = process.platform === "win32"
          ? join(prefix, "node_modules", "brain-installer")
          : join(prefix, "lib", "node_modules", "brain-installer");
        const installedModule = join(installedRoot, "operations", "installed-manifest.mjs");
        const installedLauncher = process.platform === "win32"
          ? join(prefix, "brain.cmd")
          : join(prefix, "bin", "brain");
        const manifestPath = join(sandbox, "Financial Brain", "brain.manifest.json");
        mkdirSync(join(sandbox, "Financial Brain"), { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
        const isolatedEnvironment = {
          PATH: process.env.PATH || "",
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          LOCALAPPDATA: fakeLocalAppData,
          NO_COLOR: "1",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        };
        const setupReceipt = spawnSync(process.execPath, [
          "--input-type=module",
          "--eval",
          "const {pathToFileURL}=await import('node:url');" +
            "const installed=await import(pathToFileURL(process.env.INSTALLED_MODULE).href);" +
            "installed.rememberInstalledManifest(process.env.INSTALLED_MANIFEST);",
        ], {
          cwd: firstDirectory,
          encoding: "utf8",
          env: {
            ...isolatedEnvironment,
            INSTALLED_MODULE: installedModule,
            INSTALLED_MANIFEST: manifestPath,
          },
          timeout: 30_000,
        });
        check(
          "a successful setup process can persist discovery state from the packed module",
          setupReceipt.status === 0,
          setupReceipt.stderr || setupReceipt.stdout,
        );

        const reopened = setupReceipt.status === 0
          ? spawnSync(installedLauncher, ["update"], {
              cwd: reopenedDirectory,
              encoding: "utf8",
              env: isolatedEnvironment,
              shell: process.platform === "win32",
              timeout: 30_000,
            })
          : { status: null, stdout: "", stderr: "setup receipt failed" };
        const reopenedOutput = `${reopened.stdout || ""}\n${reopened.stderr || ""}`;
        check(
          "the installed launcher rediscovers the manifest after Terminal reopens anywhere",
          reopened.status !== 0 &&
            /terminal cannot prompt securely/i.test(reopenedOutput) &&
            !/no installed Brain was found|no manifest found/i.test(reopenedOutput),
          reopenedOutput,
        );

        const reinstall = setupReceipt.status === 0
          ? installPacked(reopenedDirectory)
          : { status: null, stdout: "", stderr: "setup receipt failed" };
        check(
          "the same packed release reinstalls into the same user prefix",
          reinstall.status === 0,
          reinstall.stderr || reinstall.stdout,
        );

        const afterReinstall = reinstall.status === 0
          ? spawnSync(installedLauncher, ["update"], {
              cwd: reinstalledDirectory,
              encoding: "utf8",
              env: isolatedEnvironment,
              shell: process.platform === "win32",
              timeout: 30_000,
            })
          : { status: null, stdout: "", stderr: "second package install failed" };
        const afterReinstallOutput = `${afterReinstall.stdout || ""}\n${afterReinstall.stderr || ""}`;
        check(
          "the reinstalled launcher keeps the remembered manifest in a fresh process and folder",
          afterReinstall.status !== 0 &&
            /terminal cannot prompt securely/i.test(afterReinstallOutput) &&
            !/no installed Brain was found|no manifest found/i.test(afterReinstallOutput),
          afterReinstallOutput,
        );
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\nupgrade verification: ${ran - fail}/${ran} passed`);
if (fail) process.exit(1);
