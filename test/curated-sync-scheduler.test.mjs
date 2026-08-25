import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertInheritedCuratedSchedulerLock,
  buildCuratedSchedulerPlan,
  executeScheduledCuratedSync,
  parseCuratedSchedulerCliArguments,
  recordCuratedSchedulerFailure,
  recordCuratedSchedulerResult,
  renderCuratedLaunchAgentPlist,
  runScheduledCuratedSync,
  safeCuratedSchedulerEnvironment,
  statusScheduledCuratedSync,
} from "../operations/curated-sync-scheduler.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-curated-scheduler-"));
const home = join(sandbox, "home");
const planPath = join(sandbox, ".brain-curated-sync-plan.json");

function fixturePlan(cron = "10 7 * * *") {
  return {
    schema_version: 1,
    root: "corpus",
    expected_documents: 1,
    expected_roles: { authoritative: 1, superseded: 0, plain: 0 },
    ledger_namespace: "fixture-scheduler-private-namespace",
    documents: [{
      relative_path: "fixture.md",
      role: "authoritative",
      legacy_source_type: "curated",
      legacy_source_id: "fixture-source-id",
      metadata: { category: "fixture" },
    }],
    transforms: {
      authoritative: { content_prefix: "[CURRENT]\n", title_prefix: "[CURRENT] " },
      superseded: { content_prefix: "", title_prefix: "" },
      plain: { content_prefix: "", title_prefix: "" },
    },
    common_metadata: {},
    legacy_target: { manifest: "legacy.manifest.json", backend: "legacy_notes_supabase" },
    cloudflare_target: { manifest: "cloudflare.manifest.json", backend: "cloudflare_d1" },
    ledger_file: ".brain-curated-sync-ledger.json",
    scheduler: { slug: "fixture-medical", cron, timezone: "America/Phoenix" },
  };
}

function writePlan(value) {
  writeFileSync(planPath, JSON.stringify(value), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(planPath, 0o600);
}

const report = {
  ok: true,
  corpusFingerprint: "a".repeat(64),
  count: 1,
  targetCoverage: {
    cloudflare_confirmed: { total: 1 },
    legacy_confirmed: { total: 1 },
  },
  rawDriveHistoricalChecksumMatches: { total: 1 },
  rawDriveHistoricalPresenceUnverified: { total: 0 },
  rawDriveHistoricalChecksumMismatches: { total: 0 },
};

const common = {
  platform: "darwin",
  uid: typeof process.getuid === "function" ? process.getuid() : 501,
  home,
  localTimeZone: "America/Phoenix",
  nodePath: process.execPath,
  schedulerPath: join(sandbox, "curated-sync-scheduler.mjs"),
};

try {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(sandbox, "legacy.manifest.json"), JSON.stringify({
    brain: { domain: "legacy.fixture.invalid" },
    operations: { admin_key_secret: "keychain://fixture-legacy/admin" },
  }), { mode: 0o600 });
  writeFileSync(join(sandbox, "cloudflare.manifest.json"), JSON.stringify({
    brain: { domain: "cloudflare.fixture.invalid" },
    infrastructure: { cloudflare: { storage: "d1" } },
    operations: { admin_key_secret: "keychain://fixture-cloudflare/admin" },
  }), { mode: 0o600 });
  writePlan(fixturePlan());

  const plan = buildCuratedSchedulerPlan(planPath, common);
  assert.equal(plan.label, "com.brain-installer.fixture-medical.curated-sync");
  assert.equal(plan.cron, "10 7 * * *");
  assert.equal(plan.intervals.length, 1);
  assert.equal(plan.intervals[0].Hour, 7);
  assert.equal(plan.intervals[0].Minute, 10);
  assert.match(plan.configHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.programArguments.slice(-2), ["--config-hash", plan.configHash]);

  assert.deepEqual(
    parseCuratedSchedulerCliArguments(["status", planPath]),
    { command: "status", planPath, expectedConfigHash: undefined },
  );
  assert.deepEqual(
    parseCuratedSchedulerCliArguments(["run", planPath, "--config-hash", plan.configHash]),
    { command: "run", planPath, expectedConfigHash: plan.configHash },
  );
  assert.deepEqual(
    parseCuratedSchedulerCliArguments(["__execute-held-lock", planPath, "--config-hash", plan.configHash]),
    { command: "execute", planPath, expectedConfigHash: plan.configHash },
  );
  for (const invalid of [
    [],
    ["status", planPath, "--unknown"],
    ["run", planPath],
    ["run", planPath, "--config-hash"],
    ["run", planPath, "--config-hash", ""],
    ["run", planPath, "--config-hash", plan.configHash, "--config-hash", plan.configHash],
    ["run", planPath, "--unknown", plan.configHash],
    ["execute", planPath, "--config-hash", plan.configHash],
    ["__execute-held-lock", "--unknown", "--config-hash", plan.configHash],
  ]) {
    assert.throws(
      () => parseCuratedSchedulerCliArguments(invalid),
      /curated scheduler .*arguments|require one exact configuration hash/,
    );
  }

  writePlan({
    ...fixturePlan(),
    scheduler: { slug: "fixture-medical", cron: "10 7 * * *", timezone: "Mars/Olympus" },
  });
  assert.throws(
    () => buildCuratedSchedulerPlan(planPath, common),
    /valid IANA time-zone identifier/,
  );
  writePlan(fixturePlan());

  const plist = renderCuratedLaunchAgentPlist(plan);
  assert.match(plist, /com\.brain-installer\.fixture-medical\.curated-sync/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  for (const forbidden of [
    "fixture-source-id", "[CURRENT]", "X-Admin-Key", "ADMIN_KEY",
    "CLOUDFLARE_API_TOKEN", "SUPABASE",
  ]) {
    assert.equal(plist.includes(forbidden), false, `plist omitted ${forbidden}`);
  }

  const clean = safeCuratedSchedulerEnvironment({
    HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    LC_ADMIN_KEY: "fixture-locale-prefixed-secret",
    ADMIN_KEY: "fixture-admin-secret",
    CLOUDFLARE_API_TOKEN: "fixture-cloudflare-secret",
    BRAIN_DEBUG: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    RANDOM_DESKTOP_SECRET: "fixture-random-secret",
  });
  assert.deepEqual(clean, {
    HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
  });

  let busySpawn;
  let busyRotations = 0;
  const busy = runScheduledCuratedSync(planPath, {
    ...common,
    expectedConfigHash: plan.configHash,
    env: { ...process.env, ADMIN_KEY: "fixture-admin-secret", CLOUDFLARE_API_TOKEN: "fixture-token" },
    spawn(command, args, options) {
      busySpawn = { command, args, options };
      assert.equal(fstatSync(options.stdio[3]).isFile(), true);
      return { status: 75, signal: null };
    },
    rotateLogs: () => { busyRotations++; },
  });
  assert.equal(busy.status, "skipped");
  assert.equal(busy.code, 0);
  assert.equal(busyRotations, 0);
  assert.equal(busySpawn.command, "/usr/bin/lockf");
  assert.deepEqual(busySpawn.args.slice(0, 4), ["-k", "-s", "-t", "0"]);
  assert.equal(busySpawn.args[4], "/dev/fd/3");
  assert.equal(busySpawn.args[12], "__execute-held-lock");
  assert.equal(busySpawn.args.includes("fixture-admin-secret"), false);
  assert.equal(Object.hasOwn(busySpawn.options.env, "ADMIN_KEY"), false);
  assert.equal(Object.hasOwn(busySpawn.options.env, "CLOUDFLARE_API_TOKEN"), false);
  assert.equal(busySpawn.options.stdio[0], "ignore");
  assert.equal(Number.isInteger(busySpawn.options.stdio[3]), true);
  assert.equal(statSync(plan.lockPath).mode & 0o777, 0o600);

  if (process.platform === "darwin") {
    const holderReady = join(sandbox, "lock-holder-ready");
    const holderDescriptor = openSync(plan.lockPath, fsConstants.O_RDWR);
    const holder = spawn(
      "/usr/bin/lockf",
      [
        "-k", "-s", "-t", "0", "/dev/fd/3",
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000)',
        holderReady,
      ],
      { stdio: ["ignore", "ignore", "ignore", holderDescriptor] },
    );
    closeSync(holderDescriptor);
    try {
      const deadline = Date.now() + 3_000;
      while (!existsSync(holderReady) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      assert.equal(existsSync(holderReady), true);
      const contested = runScheduledCuratedSync(planPath, {
        ...common,
        expectedConfigHash: plan.configHash,
        rotateLogs: () => { throw new Error("a lock-contention skip must not rotate logs"); },
      });
      assert.equal(contested.status, "skipped");
      assert.equal(contested.code, 0);
    } finally {
      holder.kill("SIGTERM");
      if (holder.exitCode === null && holder.signalCode === null) {
        await new Promise((resolveExit) => holder.once("exit", resolveExit));
      }
    }
  }

  let missingHashSpawned = 0;
  assert.throws(
    () => runScheduledCuratedSync(planPath, {
      ...common,
      spawn: () => { missingHashSpawned++; return { status: 0 }; },
      rotateLogs: () => {},
    }),
    /requires its exact prepared configuration hash/,
  );
  assert.equal(missingHashSpawned, 0);

  let bypassRunnerCalls = 0;
  const directDescriptor = openSync(plan.lockPath, fsConstants.O_RDWR);
  try {
    await assert.rejects(
      executeScheduledCuratedSync(planPath, {
        ...common,
        expectedConfigHash: plan.configHash,
        lockDescriptor: directDescriptor,
        inspectLockParent: () => "/not-lockf",
        runSync: async () => { bypassRunnerCalls++; return report; },
      }),
      /not running below the required lockf parent/,
    );
  } finally {
    closeSync(directDescriptor);
  }
  assert.equal(bypassRunnerCalls, 0);

  const unlockedDescriptor = openSync(plan.lockPath, fsConstants.O_RDWR);
  try {
    await assert.rejects(
      executeScheduledCuratedSync(planPath, {
        ...common,
        expectedConfigHash: plan.configHash,
        lockDescriptor: unlockedDescriptor,
        inspectLockParent: () => "/usr/bin/lockf",
        probeLockContention: () => ({ status: 0, signal: null }),
        runSync: async () => { bypassRunnerCalls++; return report; },
      }),
      /does not hold the expected active lock/,
    );
  } finally {
    closeSync(unlockedDescriptor);
  }
  assert.equal(bypassRunnerCalls, 0);

  const forgedDescriptor = openSync(plan.lockPath, fsConstants.O_RDWR);
  try {
    await assert.rejects(
      executeScheduledCuratedSync(planPath, {
        ...common,
        expectedConfigHash: "b".repeat(64),
        lockDescriptor: forgedDescriptor,
        inspectLockParent: () => "/usr/bin/lockf",
        probeLockContention: () => ({ status: 75, signal: null }),
        runSync: async () => { bypassRunnerCalls++; return report; },
      }),
      /changed after this LaunchAgent was prepared/,
    );
  } finally {
    closeSync(forgedDescriptor);
  }
  assert.equal(bypassRunnerCalls, 0);

  if (process.platform === "darwin") {
    const schedulerModuleUrl = new URL("../operations/curated-sync-scheduler.mjs", import.meta.url).href;
    const proofScript = [
      `import { buildCuratedSchedulerPlan, assertInheritedCuratedSchedulerLock } from ${JSON.stringify(schedulerModuleUrl)};`,
      `const plan = buildCuratedSchedulerPlan(${JSON.stringify(planPath)}, ${JSON.stringify(common)});`,
      "assertInheritedCuratedSchedulerLock(plan);",
    ].join("\n");
    const proofDescriptor = openSync(plan.lockPath, fsConstants.O_RDWR);
    let nativeProof;
    try {
      nativeProof = spawnSync(
        "/usr/bin/lockf",
        [
          "-k", "-s", "-t", "0", "/dev/fd/3",
          "/bin/sh", "-c", 'exec 3<"$1" || exit 66; shift; exec "$@"', "brain-curated-lock-bootstrap",
          plan.lockPath,
          process.execPath, "--input-type=module", "-e", proofScript,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", proofDescriptor] },
      );
    } finally {
      closeSync(proofDescriptor);
    }
    assert.equal(nativeProof.status, 0, nativeProof.stderr);

    const nativeChildHome = join(sandbox, "native-child-home");
    mkdirSync(nativeChildHome, { recursive: true, mode: 0o700 });
    const nativeCommon = {
      ...common,
      home: nativeChildHome,
      schedulerPath: fileURLToPath(schedulerModuleUrl),
    };
    const nativePlan = buildCuratedSchedulerPlan(planPath, nativeCommon);
    const nativeHandled = runScheduledCuratedSync(planPath, {
      ...nativeCommon,
      expectedConfigHash: nativePlan.configHash,
      env: { HOME: nativeChildHome, PATH: "/usr/bin:/bin", LANG: "C" },
      spawn(command, args, options) {
        return spawnSync(command, args, {
          ...options,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe", options.stdio[3]],
        });
      },
      rotateLogs: () => {},
    });
    assert.equal(nativeHandled.code, 65);
    assert.equal(nativeHandled.childJournaled, true);
    const nativeEvents = join(nativeChildHome, ".brain", "support", "events");
    assert.equal(readdirSync(nativeEvents).length, 1);
    assert.equal(recordCuratedSchedulerResult(nativeHandled, {
      journalOptions: { root: nativeChildHome },
    }), null);
    assert.equal(readdirSync(nativeEvents).length, 1);
  }

  let rotations = 0;
  const complete = runScheduledCuratedSync(planPath, {
    ...common,
    expectedConfigHash: plan.configHash,
    spawn: () => ({ status: 0, signal: null }),
    rotateLogs: () => { rotations++; },
  });
  assert.equal(complete.status, "complete");
  assert.equal(rotations, 1);

  let capturedRunOptions;
  const completedAt = new Date("2026-08-25T14:10:00.000Z");
  const verifiedUnitDescriptor = openSync(plan.lockPath, fsConstants.O_RDWR);
  let executed;
  try {
    executed = await executeScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      now: completedAt,
      lockDescriptor: verifiedUnitDescriptor,
      inspectLockParent: () => "/usr/bin/lockf",
      probeLockContention: () => ({ status: 75, signal: null }),
      runSync: async (_curatedPlan, options) => {
        capturedRunOptions = options;
        return report;
      },
      randomBytes: () => Buffer.alloc(8, 7),
    });
  } finally {
    closeSync(verifiedUnitDescriptor);
  }
  assert.equal(executed.status, "complete");
  assert.equal(capturedRunOptions.mode, "sync");
  assert.equal(capturedRunOptions.planPath, planPath);
  assert.deepEqual(capturedRunOptions.expectedTargetFingerprints, plan.targetManifestFingerprints);
  assert.equal(executed.receipt.target_coverage.cloudflare, 1);
  assert.equal(executed.receipt.target_coverage.legacy, 1);
  assert.equal(executed.receipt.historical_raw_drive.deletion_eligible, false);
  assert.equal(statSync(plan.freshnessPath).mode & 0o777, 0o600);
  const receiptText = readFileSync(plan.freshnessPath, "utf8");
  for (const forbidden of ["fixture.md", "fixture-source-id", "legacy.manifest", "cloudflare.manifest"]) {
    assert.equal(receiptText.includes(forbidden), false, `freshness omitted ${forbidden}`);
  }

  const fresh = statusScheduledCuratedSync(planPath, {
    ...common,
    now: new Date(completedAt.getTime() + 60_000),
  });
  assert.equal(fresh.freshness.status, "observed");
  assert.equal(fresh.freshness.stale, false);
  const stale = statusScheduledCuratedSync(planPath, {
    ...common,
    now: new Date(completedAt.getTime() + fresh.freshness.staleAfterSeconds * 1000 + 1_000),
  });
  assert.equal(stale.freshness.stale, true);

  writeFileSync(plan.freshnessPath, `${JSON.stringify({
    ...executed.receipt,
    completed_at: new Date(completedAt.getTime() + 10 * 60_000).toISOString(),
  })}\n`, { mode: 0o600 });
  const future = statusScheduledCuratedSync(planPath, { ...common, now: completedAt });
  assert.deepEqual(
    { status: future.freshness.status, stale: future.freshness.stale, reason: future.freshness.reason },
    { status: "invalid", stale: true, reason: "future_timestamp" },
  );

  writeFileSync(plan.freshnessPath, `${JSON.stringify({
    ...executed.receipt,
    target_coverage: { cloudflare: 1, legacy: 0 },
  })}\n`, { mode: 0o600 });
  const malformedCoverage = statusScheduledCuratedSync(planPath, {
    ...common,
    now: new Date(completedAt.getTime() + 60_000),
  });
  assert.equal(malformedCoverage.freshness.status, "invalid");
  assert.equal(malformedCoverage.freshness.reason, "invalid_coverage");

  writeFileSync(plan.freshnessPath, `${JSON.stringify({
    ...executed.receipt,
    private_path: "/private/fixture.md",
  })}\n`, { mode: 0o600 });
  const extraField = statusScheduledCuratedSync(planPath, {
    ...common,
    now: new Date(completedAt.getTime() + 60_000),
  });
  assert.equal(extraField.freshness.status, "invalid");
  assert.equal(JSON.stringify(extraField.freshness).includes("/private/fixture.md"), false);
  writeFileSync(plan.freshnessPath, `${JSON.stringify(executed.receipt)}\n`, { mode: 0o600 });

  const abnormal = runScheduledCuratedSync(planPath, {
    ...common,
    expectedConfigHash: plan.configHash,
    spawn: () => ({ status: 70, signal: null }),
    rotateLogs: () => {},
  });
  assert.equal(abnormal.status, "failed");
  assert.equal(abnormal.signal, null);
  assert.equal(abnormal.childAbnormallyTerminated, true);
  const signalJournalRoot = join(sandbox, "signal-journal");
  mkdirSync(signalJournalRoot, { recursive: true, mode: 0o700 });
  const abnormalEventId = recordCuratedSchedulerResult(abnormal, {
    journalOptions: {
      root: signalJournalRoot,
      now: new Date("2026-08-25T14:10:30.000Z"),
      randomBytes: () => Buffer.alloc(16, 8),
    },
  });
  assert.match(abnormalEventId, /^evt_[0-9a-f]{32}$/);
  assert.equal(
    readdirSync(join(signalJournalRoot, ".brain", "support", "events")).length,
    1,
  );

  if (process.platform === "darwin") {
    const nativeSignal = runScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      spawn(command, args, options) {
        return spawnSync(
          command,
          [
            ...args.slice(0, 5),
            process.execPath,
            "-e",
            'process.kill(process.pid, "SIGTERM")',
          ],
          options,
        );
      },
      rotateLogs: () => {},
    });
    assert.equal(nativeSignal.code, 70);
    assert.equal(nativeSignal.signal, null);
    assert.equal(nativeSignal.childAbnormallyTerminated, true);
  }

  const handledChild = runScheduledCuratedSync(planPath, {
    ...common,
    expectedConfigHash: plan.configHash,
    spawn: () => ({ status: 65, signal: null }),
    rotateLogs: () => {},
  });
  assert.equal(handledChild.status, "failed");
  assert.equal(handledChild.childJournaled, true);
  const handledJournalRoot = join(sandbox, "handled-child-journal");
  mkdirSync(handledJournalRoot, { recursive: true, mode: 0o700 });
  const handledChildEvent = recordCuratedSchedulerFailure({
    journalOptions: {
      root: handledJournalRoot,
      now: new Date("2026-08-25T14:10:40.000Z"),
      randomBytes: () => Buffer.alloc(16, 10),
    },
  });
  assert.match(handledChildEvent, /^evt_[0-9a-f]{32}$/);
  assert.equal(recordCuratedSchedulerResult(handledChild, {
    journalOptions: {
      root: handledJournalRoot,
      now: new Date("2026-08-25T14:10:41.000Z"),
      randomBytes: () => Buffer.alloc(16, 11),
    },
  }), null);
  assert.equal(
    readdirSync(join(handledJournalRoot, ".brain", "support", "events")).length,
    1,
  );

  const missingNodeCommon = { ...common, nodePath: join(sandbox, "missing-node") };
  const missingNodePlan = buildCuratedSchedulerPlan(planPath, missingNodeCommon);
  const missingCommandSpawn = process.platform === "darwin"
    ? (command, args, options) => spawnSync(command, args, {
      ...options,
      stdio: ["ignore", "ignore", "pipe", options.stdio[3]],
    })
    : () => ({ status: 1, signal: null });
  const missingCommand = runScheduledCuratedSync(planPath, {
    ...missingNodeCommon,
    expectedConfigHash: missingNodePlan.configHash,
    spawn: missingCommandSpawn,
    rotateLogs: () => {},
  });
  assert.equal(missingCommand.status, "failed");
  assert.notEqual(missingCommand.code, 0);
  assert.notEqual(missingCommand.code, 65);
  assert.equal(missingCommand.childJournaled, false);
  const preJournalRoot = join(sandbox, "pre-journal-failure");
  mkdirSync(preJournalRoot, { recursive: true, mode: 0o700 });
  const preJournalEvent = recordCuratedSchedulerResult(missingCommand, {
    journalOptions: {
      root: preJournalRoot,
      now: new Date("2026-08-25T14:10:50.000Z"),
      randomBytes: () => Buffer.alloc(16, 12),
    },
  });
  assert.match(preJournalEvent, /^evt_[0-9a-f]{32}$/);
  assert.equal(
    readdirSync(join(preJournalRoot, ".brain", "support", "events")).length,
    1,
  );

  // A target domain or Keychain locator is part of the loaded service
  // definition even though it lives in a target manifest rather than the plan.
  writeFileSync(join(sandbox, "cloudflare.manifest.json"), JSON.stringify({
    brain: { domain: "cloudflare.fixture.invalid" },
    infrastructure: { cloudflare: { storage: "d1" } },
    operations: { admin_key_secret: "keychain://fixture-cloudflare/replacement" },
  }), { mode: 0o600 });
  let manifestDriftSpawned = 0;
  assert.throws(
    () => runScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      spawn: () => { manifestDriftSpawned++; return { status: 0 }; },
      rotateLogs: () => {},
    }),
    /changed after this LaunchAgent was prepared/,
  );
  assert.equal(manifestDriftSpawned, 0);
  writeFileSync(join(sandbox, "cloudflare.manifest.json"), JSON.stringify({
    brain: { domain: "cloudflare.fixture.invalid" },
    infrastructure: { cloudflare: { storage: "d1" } },
    operations: { admin_key_secret: "keychain://fixture-cloudflare/admin" },
  }), { mode: 0o600 });

  let driftSpawned = 0;
  writePlan(fixturePlan("11 7 * * *"));
  assert.throws(
    () => runScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      spawn: () => { driftSpawned++; return { status: 0 }; },
      rotateLogs: () => {},
    }),
    /changed after this LaunchAgent was prepared/,
  );
  assert.equal(driftSpawned, 0);
  const changed = statusScheduledCuratedSync(planPath, {
    ...common,
    now: new Date(completedAt.getTime() + 60_000),
  });
  assert.equal(changed.freshness.status, "configuration_changed");
  assert.equal(changed.freshness.stale, true);

  writePlan(fixturePlan());
  const lockTarget = join(sandbox, "must-not-be-changed.txt");
  writeFileSync(lockTarget, "safe\n", { mode: 0o600 });
  unlinkSync(plan.lockPath);
  symlinkSync(lockTarget, plan.lockPath);
  let unsafeSpawned = 0;
  assert.throws(
    () => runScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      spawn: () => { unsafeSpawned++; return { status: 0 }; },
      rotateLogs: () => {},
    }),
    /lock is not a private regular file/,
  );
  assert.equal(unsafeSpawned, 0);
  assert.equal(readFileSync(lockTarget, "utf8"), "safe\n");

  unlinkSync(plan.lockPath);
  linkSync(lockTarget, plan.lockPath);
  let hardLinkSpawned = 0;
  assert.throws(
    () => runScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      spawn: () => { hardLinkSpawned++; return { status: 0 }; },
      rotateLogs: () => {},
    }),
    /lock is not a private regular file/,
  );
  assert.equal(hardLinkSpawned, 0);
  assert.equal(readFileSync(lockTarget, "utf8"), "safe\n");
  unlinkSync(plan.lockPath);

  if (process.platform === "darwin") {
    // Replace the checked path after opening but before lockf. The native lock
    // must stay on the inherited descriptor and never follow this new link.
    let originalLockInode;
    const fdBound = runScheduledCuratedSync(planPath, {
      ...common,
      expectedConfigHash: plan.configHash,
      spawn(command, args, options) {
        originalLockInode = fstatSync(options.stdio[3]).ino;
        unlinkSync(plan.lockPath);
        symlinkSync(lockTarget, plan.lockPath);
        return spawnSync(command, [...args.slice(0, 5), "/usr/bin/true"], options);
      },
      rotateLogs: () => {},
    });
    assert.equal(fdBound.status, "complete");
    assert.notEqual(originalLockInode, lstatSync(plan.lockPath).ino);
    assert.equal(readFileSync(lockTarget, "utf8"), "safe\n");
    unlinkSync(plan.lockPath);
  }

  const eventId = recordCuratedSchedulerFailure({
    journalOptions: {
      root: home,
      now: new Date("2026-08-25T14:11:00.000Z"),
      randomBytes: () => Buffer.alloc(16, 9),
    },
  });
  assert.match(eventId, /^evt_[0-9a-f]{32}$/);
  const eventsDir = join(home, ".brain", "support", "events");
  const eventFiles = readdirSync(eventsDir);
  assert.equal(eventFiles.length, 1);
  const event = JSON.parse(readFileSync(join(eventsDir, eventFiles[0]), "utf8"));
  assert.deepEqual(
    { command: event.command, source: event.source, error_code: event.error_code },
    { command: "schedule", source: "scheduler", error_code: "SCHEDULE_RUN_FAILED" },
  );
  const eventText = JSON.stringify(event);
  for (const forbidden of [planPath, "fixture-source-id", "fixture-admin-secret", "fixture-token"]) {
    assert.equal(eventText.includes(forbidden), false, `support event omitted ${forbidden}`);
  }

  console.log("PASS  curated scheduler locks, strips credentials, tracks freshness, and records private issues");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
