import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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

import {
  buildCuratedSchedulerPlan,
  executeScheduledCuratedSync,
  recordCuratedSchedulerFailure,
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
    ADMIN_KEY: "fixture-admin-secret",
    CLOUDFLARE_API_TOKEN: "fixture-cloudflare-secret",
    BRAIN_DEBUG: "1",
    BRAIN_GOOGLE_TOKEN_STORE: "file",
    RANDOM_DESKTOP_SECRET: "fixture-random-secret",
  });
  assert.deepEqual(clean, { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });

  let busySpawn;
  let busyRotations = 0;
  const busy = runScheduledCuratedSync(planPath, {
    ...common,
    env: { ...process.env, ADMIN_KEY: "fixture-admin-secret", CLOUDFLARE_API_TOKEN: "fixture-token" },
    spawn(command, args, options) {
      busySpawn = { command, args, options };
      return { status: 75, signal: null };
    },
    rotateLogs: () => { busyRotations++; },
  });
  assert.equal(busy.status, "skipped");
  assert.equal(busy.code, 0);
  assert.equal(busyRotations, 0);
  assert.equal(busySpawn.command, "/usr/bin/lockf");
  assert.deepEqual(busySpawn.args.slice(0, 4), ["-k", "-s", "-t", "0"]);
  assert.equal(busySpawn.args.includes("fixture-admin-secret"), false);
  assert.equal(Object.hasOwn(busySpawn.options.env, "ADMIN_KEY"), false);
  assert.equal(Object.hasOwn(busySpawn.options.env, "CLOUDFLARE_API_TOKEN"), false);
  assert.equal(busySpawn.options.stdio[0], "ignore");
  assert.equal(statSync(plan.lockPath).mode & 0o777, 0o600);

  let rotations = 0;
  const complete = runScheduledCuratedSync(planPath, {
    ...common,
    spawn: () => ({ status: 0, signal: null }),
    rotateLogs: () => { rotations++; },
  });
  assert.equal(complete.status, "complete");
  assert.equal(rotations, 1);

  let capturedRunOptions;
  const completedAt = new Date("2026-08-25T14:10:00.000Z");
  const executed = await executeScheduledCuratedSync(planPath, {
    ...common,
    expectedConfigHash: plan.configHash,
    now: completedAt,
    runSync: async (_curatedPlan, options) => {
      capturedRunOptions = options;
      return report;
    },
    randomBytes: () => Buffer.alloc(8, 7),
  });
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
  const changed = statusScheduledCuratedSync(planPath, common);
  assert.equal(changed.freshness.status, "configuration_changed");

  writePlan(fixturePlan());
  const lockTarget = join(sandbox, "must-not-be-changed.txt");
  writeFileSync(lockTarget, "safe\n", { mode: 0o600 });
  unlinkSync(plan.lockPath);
  symlinkSync(lockTarget, plan.lockPath);
  let unsafeSpawned = 0;
  assert.throws(
    () => runScheduledCuratedSync(planPath, {
      ...common,
      spawn: () => { unsafeSpawned++; return { status: 0 }; },
      rotateLogs: () => {},
    }),
    /lock is not a private regular file/,
  );
  assert.equal(unsafeSpawned, 0);
  assert.equal(readFileSync(lockTarget, "utf8"), "safe\n");

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
