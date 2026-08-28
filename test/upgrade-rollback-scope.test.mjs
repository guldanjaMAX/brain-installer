/**
 * Code rollback and data restore are different operations. See
 * docs/decisions/003-upgrade-rollback-scope.md.
 *
 * WHAT THESE TESTS ARE DEFENDING
 *
 * An external release requirement said upgrades must roll back automatically.
 * `brain.mjs` said rollback is deliberately not automatic. Both were true
 * statements about different operations, and because nothing distinguished
 * them, every upgrade failure printed the same paragraph: a D1 bookmark and a
 * warning not to restore it. A run that stopped before the migration had
 * altered nothing at all, and still told the operator their data was in a state
 * requiring a destructive decision.
 *
 * That matters beyond tidiness. The destructive-restore warning is the one an
 * operator has to take seriously, and a warning that fires on failures it does
 * not apply to is a warning people learn to click past.
 *
 * Each test below drives the real `cmdUpgrade` to failure with injected
 * provider fakes and reads what came out. Nothing here greps a source file.
 *
 * Every fixture name here is invented. This repository is public.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPGRADE_PRE_SCHEMA_STAGES,
  cmdRollback,
  cmdRollbackInteractive,
  cmdUpgrade,
  upgradeFailureGuidance,
  upgradeFailureScope,
} from "../brain.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 500)));
  if (!c) fail++;
};

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

const bootstrapCompletion = () => ({
  epoch: 1, total: 0, confirmed: 0, remaining: 0, rounds: 1, complete: true, vector_ready: true,
});

/**
 * Fail the real upgrade at one named stage and report what it left behind.
 *
 * `history` captures the row the runner writes to upgrade_runs, because the
 * scope has to survive the process: whoever picks the install up afterwards
 * reads `brain status`, not this terminal.
 */
const runFailure = async (failAt) => {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), `brain-scope-${failAt}-`)));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
  const history = [];
  let error = null;
  try {
    await cmdUpgrade(manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql, params) => {
        if (/sqlite_master/i.test(sql)) return { results: [{ name: "install_state" }] };
        if (/SELECT \* FROM install_state/i.test(sql)) {
          return { results: [{ client_slug: "fixture", product_version: "0.1.9" }] };
        }
        if (/INSERT INTO upgrade_runs/i.test(sql)) history.push({ status: params?.[4], detail: params?.[6] });
        if (/SELECT product_version/i.test(sql)) return { results: [{ product_version: "0.1.9" }] };
        return { results: [] };
      },
      cf: async () => ({ bookmark: "fixture-recovery-bookmark" }),
      cmdDeploy: async (_path, options) => {
        const mode = options.pauseVectorDrainForUpgrade ? "paused" : "active";
        if (failAt === "paused-deploy" && mode === "paused") throw new Error("synthetic paused upload failure");
        if (failAt === "active-deploy" && mode === "active") throw new Error("synthetic active upload failure");
      },
      cmdHealth: async (_path, options) => {
        const paused = options.expectDrainMode === "paused-for-upgrade";
        if (failAt === "paused-health" && paused) throw new Error("synthetic paused mode never served");
      },
      waitForVectorDrainQuiescence: async () => {
        if (failAt === "quiescence") throw new Error("synthetic quiescence failure");
      },
      cmdMigrate: async () => { if (failAt === "migration") throw new Error("synthetic migration failure"); },
      cmdBootstrap: async () => {
        if (failAt === "bootstrap") throw new Error("synthetic bootstrap failure");
        return bootstrapCompletion();
      },
      reconcileWorkerProviderSecrets: async () => {},
      cmdDrain: async () => { if (failAt === "convergence") throw new Error("synthetic convergence failure"); },
      cmdTest: async () => { if (failAt === "acceptance") throw new Error("synthetic acceptance failure"); },
      commitManifestVersion: () => {},
    });
  } catch (caught) { error = caught; }
  const manifestVersion = JSON.parse(readFileSync(manifestPath, "utf8")).brain.version;
  rmSync(sandbox, { recursive: true, force: true });
  return { error, message: String(error?.message || ""), history, manifestVersion };
};

const DESTRUCTIVE = /Do not restore (?:it )?as the first response/;
const NOTHING_MOVED = /did not change/;

/* ================================================================ */
/* 1. A failure before the migration says nothing moved, and does    */
/*    not hand the operator a destructive instruction.               */
/* ================================================================ */
for (const stage of ["paused-deploy", "paused-health", "quiescence"]) {
  const run = await runFailure(stage);
  check(`${stage}: the run fails`, run.error !== null, run.message);
  check(`${stage}: it is recorded as code-only`,
    run.history.some((row) => row.status === "failed" && /scope:code-only/.test(row.detail || "")),
    JSON.stringify(run.history));
  check(`${stage}: the operator is told their material did not change`,
    NOTHING_MOVED.test(run.message), run.message);
  check(`${stage}: and is NOT told not to restore, because restoring is not the question`,
    !DESTRUCTIVE.test(run.message), run.message);
  check(`${stage}: the bookmark is still present, marked as a record rather than a step`,
    /fixture-recovery-bookmark/.test(run.message) && /rather than as an instruction/.test(run.message),
    run.message);
  check(`${stage}: nothing advanced the manifest version`, run.manifestVersion === "0.1.9", run.manifestVersion);
}

/* ================================================================ */
/* 2. A pre-schema failure that happened INSIDE the paused window     */
/*    still says the brain is refusing documents.                    */
/* ================================================================ */
{
  const paused = await runFailure("paused-health");
  check("a code-only failure inside the paused window still warns the corpus is refusing writes",
    /CANNOT ACCEPT DOCUMENTS/i.test(paused.message), paused.message);
  const beforeAnyDeploy = await runFailure("paused-deploy");
  check("and a failure before the paused deploy landed does not claim a pause that never happened",
    !/CANNOT ACCEPT DOCUMENTS/i.test(beforeAnyDeploy.message), beforeAnyDeploy.message);
}

/* ================================================================ */
/* 3. The migration itself is the one genuinely unknown state.       */
/* ================================================================ */
{
  const run = await runFailure("migration");
  check("migration failure is recorded as schema-partial",
    run.history.some((row) => /scope:schema-partial/.test(row.detail || "")), JSON.stringify(run.history));
  check("and names the repair command as the first response, not a restore",
    /brain doctor <manifest> --repair/.test(run.message) && /unknown state/.test(run.message), run.message);
  check("and still carries the destructive-restore warning, because here it applies",
    DESTRUCTIVE.test(run.message), run.message);
  check("and does not claim nothing changed", !NOTHING_MOVED.test(run.message), run.message);
}

/* ================================================================ */
/* 4. Everything after the migration is schema-advanced.             */
/* ================================================================ */
for (const stage of ["bootstrap", "active-deploy", "convergence", "acceptance"]) {
  const run = await runFailure(stage);
  check(`${stage}: recorded as schema-advanced`,
    run.history.some((row) => /scope:schema-advanced/.test(row.detail || "")), JSON.stringify(run.history));
  check(`${stage}: the bookmark is presented as mattering`,
    /fixture-recovery-bookmark/.test(run.message) && DESTRUCTIVE.test(run.message), run.message);
  check(`${stage}: and it does not claim nothing changed`, !NOTHING_MOVED.test(run.message), run.message);
}

/* ================================================================ */
/* 5. The classifier fails SAFE. An unknown stage is never code-only.*/
/* ================================================================ */
{
  check("every declared pre-schema stage classifies as code-only",
    UPGRADE_PRE_SCHEMA_STAGES.every((stage) => upgradeFailureScope(stage) === "code-only"),
    JSON.stringify(UPGRADE_PRE_SCHEMA_STAGES.map((s) => [s, upgradeFailureScope(s)])));
  check("the migration stage classifies as schema-partial",
    upgradeFailureScope("migration") === "schema-partial");
  check("a stage nobody listed classifies as schema-advanced, not code-only",
    upgradeFailureScope("a stage added next year") === "schema-advanced",
    upgradeFailureScope("a stage added next year"));
  check("and so does an empty or missing stage",
    upgradeFailureScope("") === "schema-advanced" && upgradeFailureScope(undefined) === "schema-advanced");
  check("the runner's own default stage is not code-only",
    upgradeFailureScope("migration") !== "code-only");
}

/* ================================================================ */
/* 6. UPD-02b: no path restores data without an explicit human yes.  */
/* ================================================================ */
{
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-scope-restore-")));
  const manifestPath = join(sandbox, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifestFixture()));
  const bookmark = "00000001-00000000-00004e20-0000000000000001";
  let restoreCalls = 0;
  const options = {
    resolveAccount: async () => { restoreCalls++; return { id: "fixture-account" }; },
    cf: async () => { restoreCalls++; return {}; },
    d1Query: async () => { restoreCalls++; return { results: [] }; },
    cmdDeploy: async () => { restoreCalls++; },
    cmdHealth: async () => { restoreCalls++; },
  };

  const preview = await cmdRollback(manifestPath, bookmark, options);
  check("brain rollback without --yes previews and performs nothing",
    preview.confirmed === false && preview.restored === false && restoreCalls === 0,
    JSON.stringify({ preview, restoreCalls }));

  restoreCalls = 0;
  const interactive = await cmdRollbackInteractive(manifestPath, bookmark, options);
  check("and the interactive wrapper does not reach a token prompt or a mutation either",
    interactive.confirmed === false && interactive.restored === false && restoreCalls === 0,
    JSON.stringify({ interactive, restoreCalls }));
  rmSync(sandbox, { recursive: true, force: true });
}

/* ================================================================ */
/* 7. The guidance builder itself, at each scope.                    */
/* ================================================================ */
{
  const build = (scope, corpusPaused = false) => upgradeFailureGuidance({
    stage: "a stage", scope, bookmark: "bm-1", message: "a cause", corpusPaused,
  });
  check("every scope names the stage and the cause",
    ["code-only", "schema-partial", "schema-advanced"]
      .every((scope) => /a stage/.test(build(scope)) && /a cause/.test(build(scope))));
  check("every scope carries the bookmark, so it is never lost",
    ["code-only", "schema-partial", "schema-advanced"].every((scope) => /bm-1/.test(build(scope))));
  check("the paused block appends to every scope when the corpus is paused",
    ["code-only", "schema-partial", "schema-advanced"]
      .every((scope) => /CANNOT ACCEPT DOCUMENTS/.test(build(scope, true))));
  check("and appears in none of them when it is not",
    ["code-only", "schema-partial", "schema-advanced"]
      .every((scope) => !/CANNOT ACCEPT DOCUMENTS/.test(build(scope, false))));
  check("only the code-only scope claims nothing changed",
    NOTHING_MOVED.test(build("code-only")) &&
      !NOTHING_MOVED.test(build("schema-partial")) && !NOTHING_MOVED.test(build("schema-advanced")));
}

console.log(`\n${ran - fail}/${ran} upgrade rollback-scope checks passed`);
if (fail) process.exit(1);
