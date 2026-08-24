import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { previewSupportJournal } from "../support-journal.mjs";
import {
  buildDriveSchedulerPlan,
  CLOUDFLARE_CREDENTIAL_ENV,
  cronToCalendarIntervals,
  DRIVE_LOG_HISTORY_FILES,
  DRIVE_LOG_MAX_BYTES,
  expectedRefreshSecondsForCron,
  installDriveScheduler,
  parseAdminKeySecretReference,
  recordDriveSchedulerFailure,
  recordDriveSchedulerResult,
  removeDriveScheduler,
  renderLaunchAgentPlist,
  resolveScheduledAdminKey,
  rotateDriveSchedulerLogs,
  runDriveIngest,
  safeIngestEnvironment,
  statusDriveScheduler,
} from "../operations/drive-scheduler.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

const directory = mkdtempSync(join(tmpdir(), "brain-drive-scheduler-"));
const home = join(directory, "home & logs");
const manifestPath = join(directory, "client & manifest", "brain.manifest.json");
const baseManifest = {
  manifest_version: 1,
  client: { slug: "acme-brain", display_name: "Acme", timezone: "America/Phoenix" },
  brain: { version: "0.1.0", domain: "brain.acme.test" },
  infrastructure: { cloudflare: { account_id: "account-123" } },
  corpora: { google_drive: { enabled: true } },
  operations: {
    ingest_cron: "0 9 * * *",
    admin_key_secret: "keychain://acme-brain-admin/owner",
    google_token_store: "auto",
  },
};

function writeManifest(manifest = baseManifest, path = manifestPath) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function opts(extra = {}) {
  return {
    platform: "darwin",
    home,
    uid: 501,
    nodePath: "/opt/node/bin/node",
    brainPath: "/opt/brain installer/brain.mjs",
    schedulerPath: "/opt/brain installer/operations/drive-scheduler.mjs",
    localTimeZone: "America/Phoenix",
    ...extra,
  };
}

try {
  writeManifest();

  /* ================= cron translation ================= */
  {
    const intervals = cronToCalendarIntervals("0 9 * * *");
    check("daily ingest cron becomes one native launchd calendar entry",
      JSON.stringify(intervals) === JSON.stringify([{ Minute: 0, Hour: 9 }]), JSON.stringify(intervals));
  }
  {
    const intervals = cronToCalendarIntervals("*/15 8-9 * * 1-5");
    check("cron steps, ranges and weekdays are expanded", intervals.length === 40, String(intervals.length));
    check("expanded calendar entries carry the requested fields",
      intervals.some((x) => x.Minute === 45 && x.Hour === 9 && x.Weekday === 5));
  }
  {
    const intervals = cronToCalendarIntervals("0 9 1 * 1");
    check("cron day-of-month plus weekday keeps cron's OR behavior",
      intervals.length === 2 && intervals.some((x) => x.Day === 1 && x.Weekday === undefined) &&
      intervals.some((x) => x.Weekday === 1 && x.Day === undefined), JSON.stringify(intervals));
  }
  {
    const everyDayByDom = cronToCalendarIntervals("0 9 1-31 * 1");
    const everyDayByDow = cronToCalendarIntervals("0 9 1 * 0-7");
    const starStep = cronToCalendarIntervals("0 9 */1 * 1");
    check("a fully enumerated day field stays syntactically restricted for cron OR semantics",
      everyDayByDom.some((x) => x.Day === undefined && x.Weekday === undefined) &&
      everyDayByDow.some((x) => x.Day === undefined && x.Weekday === undefined),
      `${JSON.stringify(everyDayByDom)} / ${JSON.stringify(everyDayByDow)}`);
    check("a star-step day field retains wildcard semantics",
      starStep.length === 1 && starStep[0].Weekday === 1 && starStep[0].Day === undefined, JSON.stringify(starStep));
  }
  {
    let error = null;
    try { cronToCalendarIntervals("60 9 * * *"); } catch (caught) { error = caught; }
    check("invalid cron values fail with the field and valid range", /minute.*0-59/i.test(error?.message), error?.message);
  }
  {
    check("daily cron derives a one-day freshness expectation",
      expectedRefreshSecondsForCron("0 9 * * *") === 86_400);
    check("hourly cron derives a one-hour freshness expectation",
      expectedRefreshSecondsForCron("0 * * * *") === 3_600);
    check("weekday cron includes the scheduled weekend gap",
      expectedRefreshSecondsForCron("0 9 * * 1-5") === 3 * 86_400);
    check("monthly cron accounts for 31-day months",
      expectedRefreshSecondsForCron("0 9 1 * *") === 31 * 86_400);
    check("day 31 cron accounts for consecutive months without a firing",
      expectedRefreshSecondsForCron("0 9 31 * *") === 61 * 86_400);
  }
  {
    let error = null;
    try { expectedRefreshSecondsForCron("0 9 31 2 *"); } catch (caught) { error = caught; }
    check("a calendar schedule that can never fire is rejected at install time",
      /no valid calendar firing/i.test(error?.message), error?.message);
  }

  /* ================= plan and plist ================= */
  {
    const plan = buildDriveSchedulerPlan(manifestPath, opts());
    check("the label is standard and client-scoped", plan.label === "com.brain-installer.acme-brain.drive-ingest", plan.label);
    check("the scheduler plan exposes the freshness interval derived from its cron",
      plan.expectedRefreshSeconds === 86_400, String(plan.expectedRefreshSeconds));
    check("the LaunchAgent invokes the reusable runner with absolute paths and a configuration binding",
      JSON.stringify(plan.programArguments.slice(0, 7)) === JSON.stringify([
        resolve("/opt/node/bin/node"),
        resolve("/opt/brain installer/operations/drive-scheduler.mjs"),
        "run",
        manifestPath,
        "--brain",
        resolve("/opt/brain installer/brain.mjs"),
        "--config-hash",
      ]) && plan.programArguments[7] === plan.configHash && /^[a-f0-9]{64}$/.test(plan.configHash),
      JSON.stringify(plan.programArguments));
    check("logs and the single-instance lock live under the user's .brain directory",
      plan.stdoutPath.startsWith(join(home, ".brain", "logs")) && plan.lockPath.startsWith(join(home, ".brain", "locks")));
    const plist = renderLaunchAgentPlist(plan);
    check("plist XML escapes paths instead of breaking on ampersands", plist.includes("home &amp; logs") && plist.includes("client &amp; manifest"));
    check("the plist contains no admin key or Cloudflare credential material",
      !plist.includes("admin-secret") && !plist.includes("CLOUDFLARE") && !plist.includes("keychain://"));
  }
  {
    const mismatched = buildDriveSchedulerPlan(manifestPath, opts({ localTimeZone: "America/New_York" }));
    check("a manifest-to-Mac timezone mismatch is reported explicitly",
      mismatched.warnings.length === 1 && /America\/Phoenix/.test(mismatched.warnings[0]), mismatched.warnings.join("; "));
  }
  {
    let error = null;
    try { buildDriveSchedulerPlan(manifestPath, opts({ platform: "linux" })); } catch (caught) { error = caught; }
    check("non-macOS scheduling fails clearly", /currently implemented with macOS LaunchAgents/.test(error?.message), error?.message);
  }
  {
    const noDomainPath = join(directory, "no-domain", "brain.manifest.json");
    writeManifest({ ...baseManifest, brain: { version: "0.1.0" } }, noDomainPath);
    let error = null;
    try { buildDriveSchedulerPlan(noDomainPath, opts()); } catch (caught) { error = caught; }
    check("token-free scheduling requires a manifest domain at install time",
      /brain\.domain.*no Cloudflare deployment token/i.test(error?.message), error?.message);
  }

  /* ================= private bounded log retention ================= */
  {
    const journalRoot = join(directory, "scheduler-journal-root");
    mkdirSync(journalRoot, { recursive: true });
    const eventId = recordDriveSchedulerFailure(
      new Error("malicious raw detail must never be stored"),
      { action: "run", journalOptions: { root: journalRoot } }
    );
    const journal = previewSupportJournal({ root: journalRoot });
    check("scheduler wrapper failures create one typed private issue note",
      /^evt_[0-9a-f]{32}$/.test(eventId || "") &&
      journal.includes('"command":"schedule"') &&
      journal.includes('"source":"scheduler"') &&
      journal.includes('"error_code":"SCHEDULE_RUN_FAILED"'));
    check("scheduler issue notes never copy raw errors", !journal.includes("malicious raw detail"), journal);
    const failedResultEvent = recordDriveSchedulerResult(
      { code: 1, signal: null }, { journalOptions: { root: journalRoot } }
    );
    const successfulResultEvent = recordDriveSchedulerResult(
      { code: 0, signal: null }, { journalOptions: { root: journalRoot } }
    );
    check("a nonzero scheduler child creates a wrapper note even if the child could not journal itself",
      /^evt_[0-9a-f]{32}$/.test(failedResultEvent || "") && successfulResultEvent === null);
  }
  {
    check("production scheduler log retention is capped at five MiB with two history files",
      DRIVE_LOG_MAX_BYTES === 5 * 1024 * 1024 && DRIVE_LOG_HISTORY_FILES === 2,
      `${DRIVE_LOG_MAX_BYTES} bytes, ${DRIVE_LOG_HISTORY_FILES} histories`);

    const retentionHome = join(directory, "retention-home");
    const plan = buildDriveSchedulerPlan(manifestPath, opts({ home: retentionHome }));
    mkdirSync(plan.logsDir, { recursive: true });
    const maxBytes = 128;
    const newest = Buffer.from("newest-log-data:" + "N".repeat(180));
    const expectedTail = newest.subarray(newest.length - maxBytes);
    writeFileSync(plan.stdoutPath, newest, { mode: 0o666 });
    writeFileSync(`${plan.stdoutPath}.1`, "previous-one", { mode: 0o666 });
    writeFileSync(`${plan.stdoutPath}.2`, "previous-two", { mode: 0o666 });
    const oversizedHistory = Buffer.from("old-stderr:" + "E".repeat(180));
    const expectedHistoryTail = oversizedHistory.subarray(oversizedHistory.length - maxBytes);
    writeFileSync(`${plan.stderrPath}.1`, oversizedHistory, { mode: 0o666 });
    const unrelated = join(plan.logsDir, "leave-this-file-alone.log");
    writeFileSync(unrelated, "unrelated audit data");
    if (process.platform !== "win32") {
      chmodSync(plan.stdoutPath, 0o666);
      chmodSync(`${plan.stdoutPath}.1`, 0o666);
      chmodSync(`${plan.stdoutPath}.2`, 0o666);
    }

    const retained = rotateDriveSchedulerLogs(plan, { logMaxBytes: maxBytes, logHistoryFiles: 2 });
    check("an oversized active log is truncated only after its newest bounded tail is retained",
      retained[0].rotated && statSync(plan.stdoutPath).size === 0 &&
      readFileSync(`${plan.stdoutPath}.1`).equals(expectedTail), JSON.stringify(retained[0]));
    check("rotation keeps only the exact bounded history and never touches an unrelated file",
      readFileSync(`${plan.stdoutPath}.2`, "utf-8") === "previous-one" &&
      !existsSync(`${plan.stdoutPath}.3`) && !existsSync(`${plan.stdoutPath}.rotate.tmp`) &&
      readFileSync(unrelated, "utf-8") === "unrelated audit data");
    check("the stderr active file is prepared privately even before it has output",
      existsSync(plan.stderrPath) && statSync(plan.stderrPath).size === 0 &&
      readFileSync(`${plan.stderrPath}.1`).equals(expectedHistoryTail));
    if (process.platform === "win32") {
      check("retained logs are owner-only on POSIX and remain regular files on Windows",
        [plan.stdoutPath, `${plan.stdoutPath}.1`, `${plan.stdoutPath}.2`, plan.stderrPath, `${plan.stderrPath}.1`]
          .every((path) => statSync(path).isFile()));
    } else {
      check("active and retained scheduler logs are all owner-only",
        [plan.stdoutPath, `${plan.stdoutPath}.1`, `${plan.stdoutPath}.2`, plan.stderrPath, `${plan.stderrPath}.1`]
          .every((path) => (statSync(path).mode & 0o777) === 0o600));
    }

    writeFileSync(plan.stdoutPath, Buffer.alloc(maxBytes + 31, 0x52));
    rotateDriveSchedulerLogs(plan, { logMaxBytes: maxBytes, logHistoryFiles: 2 });
    check("repeated rotation remains bounded instead of accumulating numbered files",
      statSync(`${plan.stdoutPath}.1`).size === maxBytes &&
      statSync(`${plan.stdoutPath}.2`).size === maxBytes &&
      !existsSync(`${plan.stdoutPath}.3`));
  }
  {
    if (process.platform === "win32") {
      check("scheduler log retention refuses symbolic links on supported hosts", true);
    } else {
      const linkHome = join(directory, "retention-link-home");
      const plan = buildDriveSchedulerPlan(manifestPath, opts({ home: linkHome }));
      mkdirSync(plan.logsDir, { recursive: true });
      const outside = join(directory, "outside-log-target");
      writeFileSync(outside, "must stay unchanged");
      symlinkSync(outside, plan.stdoutPath);
      let error = null;
      try {
        rotateDriveSchedulerLogs(plan, { logMaxBytes: 32, logHistoryFiles: 2 });
      } catch (caught) { error = caught; }
      check("scheduler log retention refuses a symlink without changing its target",
        /refusing to follow a symbolic link/i.test(error?.message) &&
        readFileSync(outside, "utf-8") === "must stay unchanged" &&
        lstatSync(plan.stdoutPath).isSymbolicLink(), error?.message);
    }
  }
  {
    if (process.platform === "win32") {
      check("scheduler log retention preserves hard-link targets on supported hosts", true);
    } else {
      const failures = [];
      for (const slot of ["active", "history", "staging"]) {
        const hardLinkHome = join(directory, `retention-hard-link-${slot}-home`);
        const plan = buildDriveSchedulerPlan(manifestPath, opts({ home: hardLinkHome }));
        mkdirSync(plan.logsDir, { recursive: true });
        const outside = join(directory, `outside-hard-link-${slot}`);
        const outsideBytes = Buffer.from(`${slot}-target:` + "T".repeat(80));
        const activeBytes = Buffer.from(`${slot}-active:` + "A".repeat(80));
        const linkedPath = slot === "active"
          ? plan.stdoutPath
          : slot === "history"
            ? `${plan.stdoutPath}.1`
            : `${plan.stdoutPath}.rotate.tmp`;
        writeFileSync(outside, outsideBytes);
        if (slot !== "active") writeFileSync(plan.stdoutPath, activeBytes);
        linkSync(outside, linkedPath);
        let error = null;
        try {
          rotateDriveSchedulerLogs(plan, { logMaxBytes: 32, logHistoryFiles: 2 });
        } catch (caught) { error = caught; }
        if (!/multiple hard links/i.test(error?.message) ||
            !readFileSync(outside).equals(outsideBytes) ||
            lstatSync(linkedPath).nlink !== 2 ||
            (slot !== "active" && !readFileSync(plan.stdoutPath).equals(activeBytes))) {
          failures.push(`${slot}: ${error?.message || "target changed"}`);
        }
      }
      check("active, history, and staging hard links are rejected without changing their targets",
        failures.length === 0, failures.join("; "));
    }
  }

  /* ================= secret boundary ================= */
  {
    const parsed = parseAdminKeySecretReference("keychain://Acme%20Brain/primary%20owner");
    check("Keychain references contain identifiers, not a credential value",
      parsed.service === "Acme Brain" && parsed.account === "primary owner", JSON.stringify(parsed));
  }
  {
    const calls = [];
    const key = resolveScheduledAdminKey(baseManifest, {
      platform: "darwin",
      runSecurity: (args) => { calls.push(args); return { status: 0, stdout: "admin-secret\n", stderr: "" }; },
    });
    check("the admin key is read from the exact manifest-declared Keychain item",
      key === "admin-secret" && calls[0].join(" ") === "find-generic-password -s acme-brain-admin -a owner -w",
      calls[0]?.join(" "));
  }
  {
    const clean = safeIngestEnvironment(Object.fromEntries([
      ...CLOUDFLARE_CREDENTIAL_ENV.map((name) => [name, `secret-${name}`]),
      ["ADMIN_KEY", "allowed-at-runtime"],
      ["HOME", home],
    ]));
    check("all Cloudflare credential variables are removed from scheduled ingest",
      CLOUDFLARE_CREDENTIAL_ENV.every((name) => clean[name] === undefined));
    check("the scrub keeps only allowlisted runtime basics, not even an admin key",
      clean.ADMIN_KEY === undefined && clean.HOME === home);
  }
  {
    const clean = safeIngestEnvironment({
      HOME: home,
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      UNRELATED_API_KEY: "do-not-inherit",
      DATABASE_PASSWORD: "do-not-inherit",
      AWS_SECRET_ACCESS_KEY: "do-not-inherit",
    });
    check("unrelated desktop credentials are not inherited by unattended ingest",
      clean.UNRELATED_API_KEY === undefined && clean.DATABASE_PASSWORD === undefined &&
      clean.AWS_SECRET_ACCESS_KEY === undefined && clean.HOME === home && clean.LANG === "en_US.UTF-8",
      JSON.stringify(Object.keys(clean)));
  }
  {
    let child = null;
    const result = runDriveIngest(manifestPath, opts({
      env: { HOME: home, CLOUDFLARE_API_TOKEN: "deployment-secret", ADMIN_KEY: "old-key" },
      runSecurity: () => ({ status: 0, stdout: "keychain-admin\n", stderr: "" }),
      spawn: (command, args, options) => { child = { command, args, options }; return { status: 0 }; },
    }));
    check("scheduled run invokes brain ingest manifest --from drive",
      child.command === "/usr/bin/lockf" && JSON.stringify(child.args) === JSON.stringify([
        "-k", "-s", "-t", "0", result.lockPath,
        resolve("/opt/node/bin/node"), resolve("/opt/brain installer/brain.mjs"), "ingest", manifestPath, "--from", "drive",
      ]), JSON.stringify(child));
    check("Keychain admin key exists only in the ingest child's environment",
      child.options.env.ADMIN_KEY === "keychain-admin" && process.env.ADMIN_KEY !== "keychain-admin");
    check("the deployment token is absent from that child", child.options.env.CLOUDFLARE_API_TOKEN === undefined);
    check("a successful child is reported complete through the native advisory lock", result.status === "complete");
  }
  {
    const noisyHome = join(directory, "noisy-run-home");
    const plan = buildDriveSchedulerPlan(manifestPath, opts({ home: noisyHome }));
    const maxBytes = 160;
    mkdirSync(plan.logsDir, { recursive: true });
    const result = runDriveIngest(manifestPath, opts({
      home: noisyHome,
      logMaxBytes: maxBytes,
      logHistoryFiles: 2,
      env: { LANG: "C" },
      runSecurity: () => ({ status: 0, stdout: "keychain-admin\n", stderr: "" }),
      spawn: () => {
        writeFileSync(plan.stdoutPath, Buffer.alloc(maxBytes + 400, 0x4e));
        writeFileSync(plan.stderrPath, Buffer.alloc(maxBytes + 1, 0x45));
        return { status: 0 };
      },
    }));
    check("a single noisy scheduled run is capped immediately after the child exits",
      result.status === "complete" && statSync(plan.stdoutPath).size === 0 &&
      statSync(plan.stderrPath).size === 0 && statSync(`${plan.stdoutPath}.1`).size === maxBytes &&
      statSync(`${plan.stderrPath}.1`).size === maxBytes);
  }
  {
    const fallbackPath = join(directory, "fallback", "brain.manifest.json");
    writeManifest({ ...baseManifest, operations: { ingest_cron: "0 9 * * *" } }, fallbackPath);
    let childEnv = null;
    runDriveIngest(fallbackPath, opts({
      env: { HOME: home },
      spawn: (_command, _args, options) => { childEnv = options.env; return { status: 0 }; },
    }));
    check("without a Keychain reference, adjacent .brain-admin-key fallback remains available",
      childEnv.ADMIN_KEY === undefined);
  }
  {
    const fileTokensPath = join(directory, "file-token-mode", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      operations: { ...baseManifest.operations, google_token_store: "file" },
    }, fileTokensPath);
    let childEnv = null;
    runDriveIngest(fileTokensPath, opts({
      env: { HOME: home },
      runSecurity: () => ({ status: 0, stdout: "keychain-admin\n", stderr: "" }),
      spawn: (_command, _args, options) => { childEnv = options.env; return { status: 0 }; },
    }));
    check("an explicit file token-store choice survives a sparse launchd environment",
      childEnv.BRAIN_GOOGLE_TOKEN_STORE === "file", JSON.stringify(childEnv));
  }
  {
    const boundPath = join(directory, "bound-config", "brain.manifest.json");
    writeManifest(baseManifest, boundPath);
    const original = buildDriveSchedulerPlan(boundPath, opts());
    writeManifest({
      ...baseManifest,
      brain: { ...baseManifest.brain, domain: "attacker.invalid" },
      operations: { ...baseManifest.operations, admin_key_secret: "keychain://unrelated/password" },
    }, boundPath);
    let securityCalled = false, error = null;
    try {
      runDriveIngest(boundPath, opts({
        expectedConfigHash: original.configHash,
        runSecurity: () => { securityCalled = true; return { status: 0, stdout: "must-not-read\n" }; },
        spawn: () => ({ status: 0 }),
      }));
    } catch (caught) { error = caught; }
    check("a post-install manifest change cannot redirect a Keychain value to another domain",
      /configuration changed.*reinstall/i.test(error?.message) && !securityCalled, error?.message);
  }
  {
    let error = null;
    try {
      resolveScheduledAdminKey(baseManifest, {
        platform: "darwin",
        runSecurity: () => ({ status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }),
      });
    } catch (caught) { error = caught; }
    check("a blocked Keychain read has a bounded, explicit timeout failure",
      /timed out after 15 seconds/i.test(error?.message), error?.message);
  }

  /* ================= single instance ================= */
  {
    const busy = runDriveIngest(manifestPath, opts({
      env: { HOME: home },
      runSecurity: () => ({ status: 0, stdout: "keychain-admin\n", stderr: "" }),
      spawn: () => ({ status: 75 }),
    }));
    check("native lockf contention skips a second run without creating a stale-lock state",
      busy.status === "skipped" && busy.code === 0 && /already running/.test(busy.reason), JSON.stringify(busy));
  }

  /* ================= LaunchAgent lifecycle ================= */
  {
    const rotateInstallPath = join(directory, "rotate-before-install", "brain.manifest.json");
    const rotateInstallHome = join(directory, "rotate-before-install-home");
    writeManifest(baseManifest, rotateInstallPath);
    const plan = buildDriveSchedulerPlan(rotateInstallPath, opts({ home: rotateInstallHome }));
    mkdirSync(plan.logsDir, { recursive: true });
    writeFileSync(plan.stdoutPath, Buffer.alloc(200, 0x42));
    let boundedAtBootstrap = false;
    installDriveScheduler(rotateInstallPath, opts({
      home: rotateInstallHome,
      logMaxBytes: 64,
      logHistoryFiles: 2,
      launchctl: (args) => {
        if (args[0] === "bootstrap") {
          boundedAtBootstrap = statSync(plan.stdoutPath).size === 0 &&
            statSync(`${plan.stdoutPath}.1`).size === 64;
        }
        return args[0] === "print" ? { status: 1 } : { status: 0 };
      },
    }));
    check("install bounds existing logs before launchd can start writing again", boundedAtBootstrap);
  }
  {
    let launchctlCalled = false, error = null;
    try {
      installDriveScheduler(manifestPath, opts({
        stagePlist: () => { throw new Error("simulated disk full"); },
        launchctl: () => { launchctlCalled = true; return { status: 0 }; },
      }));
    } catch (caught) { error = caught; }
    check("a plist write failure happens before any working scheduler is touched",
      /simulated disk full/.test(error?.message) && !launchctlCalled, error?.message);
  }
  {
    const calls = [];
    const launchctl = (args) => {
      calls.push(args);
      return args[0] === "print" ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: "", stderr: "" };
    };
    const installed = installDriveScheduler(manifestPath, opts({ launchctl }));
    const plistExists = existsSync(installed.plistPath);
    const plistMode = plistExists ? statSync(installed.plistPath).mode & 0o777 : null;
    if (process.platform === "win32") {
      check("install atomically writes the LaunchAgent plist on a Windows test host", plistExists);
    } else {
      check("install atomically writes a private LaunchAgent plist", plistExists && plistMode === 0o600, plistMode?.toString(8));
    }
    check("install enables and bootstraps the user service",
      calls.some((x) => x[0] === "enable" && x[1] === installed.service) &&
      calls.some((x) => x[0] === "bootstrap" && x[1] === installed.domain && x[2] === installed.plistPath), JSON.stringify(calls));
    if (process.platform === "darwin") {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", installed.plistPath], { encoding: "utf-8" });
      check("the generated definition passes macOS's native plist parser", lint.status === 0, lint.stderr || lint.stdout);
    }

    const status = statusDriveScheduler(manifestPath, opts({
      launchctl: () => ({ status: 0, stdout: "state = running\npid = 2468\nruns = 7\nlast exit code = 1\n", stderr: "" }),
    }));
    check("status reports installed, loaded and currently running separately",
      status.installed && status.loaded && status.running && status.pid === 2468, JSON.stringify(status));
    check("status surfaces the last scheduled failure instead of calling waiting healthy",
      status.runs === 7 && status.lastExitCode === 1 && status.lastRunSucceeded === false, JSON.stringify(status));
    check("status proves the loaded definition still matches the current manifest",
      status.definitionMatches && !status.definitionDrift, JSON.stringify(status));

    const beforeRunningReplace = readFileSync(installed.plistPath, "utf-8");
    const replacementCalls = [];
    let replacementError = null;
    try {
      installDriveScheduler(manifestPath, opts({
        launchctl: (args) => {
          replacementCalls.push(args);
          return { status: 0, stdout: "state = running\npid = 2468\n", stderr: "" };
        },
      }));
    } catch (caught) { replacementError = caught; }
    check("replacement refuses to interrupt an active Drive ingest",
      /currently running/.test(replacementError?.message) && replacementCalls.length === 1 &&
      readFileSync(installed.plistPath, "utf-8") === beforeRunningReplace,
      `${replacementError?.message} calls=${JSON.stringify(replacementCalls)}`);

    writeFileSync(installed.stdoutPath, Buffer.alloc(200, 0x41));
    const removed = removeDriveScheduler(manifestPath, opts({
      logMaxBytes: 64,
      logHistoryFiles: 2,
      launchctl: (args) => args[0] === "print"
        ? { status: 0, stdout: "state = waiting\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
    }));
    check("remove unloads and removes only the plist", removed.removed && !existsSync(installed.plistPath));
    check("remove preserves a bounded scheduler audit trail",
      existsSync(installed.stdoutPath) && statSync(installed.stdoutPath).size === 0 &&
      statSync(`${installed.stdoutPath}.1`).size === 64 &&
      removed.logsPreserved.includes(installed.stdoutPath) &&
      removed.logsPreserved.includes(`${installed.stdoutPath}.1`));
  }
  {
    const driftPath = join(directory, "definition-drift", "brain.manifest.json");
    writeManifest(baseManifest, driftPath);
    const driftHome = join(directory, "definition-drift-home");
    const launchctl = (args) => args[0] === "print"
      ? { status: 1, stdout: "", stderr: "not loaded" }
      : { status: 0, stdout: "", stderr: "" };
    installDriveScheduler(driftPath, opts({ home: driftHome, launchctl }));
    writeManifest({
      ...baseManifest,
      operations: { ...baseManifest.operations, ingest_cron: "15 9 * * *" },
    }, driftPath);
    const status = statusDriveScheduler(driftPath, opts({
      home: driftHome,
      launchctl: () => ({ status: 0, stdout: "state = waiting\nruns = 2\nlast exit code = 0\n" }),
    }));
    check("status catches a manifest schedule edit that has not been reinstalled",
      status.definitionDrift && !status.definitionMatches && status.cron === "15 9 * * *", JSON.stringify(status));
    removeDriveScheduler(driftPath, opts({ home: driftHome, launchctl: () => ({ status: 1 }) }));
  }
  {
    const disabledPath = join(directory, "disabled", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      corpora: { google_drive: { enabled: false } },
      operations: {},
    }, disabledPath);
    const identityHome = join(directory, "disabled-home");
    const expectedPlist = join(identityHome, "Library", "LaunchAgents", "com.brain-installer.acme-brain.drive-ingest.plist");
    mkdirSync(dirname(expectedPlist), { recursive: true });
    writeFileSync(expectedPlist, "old scheduler\n");
    const launchctl = () => ({ status: 1, stdout: "", stderr: "not loaded" });
    const status = statusDriveScheduler(disabledPath, opts({ home: identityHome, launchctl }));
    check("status remains reachable after Drive or its cron is disabled",
      status.installed && /google_drive.enabled/.test(status.scheduleError), status.scheduleError);
    const removed = removeDriveScheduler(disabledPath, opts({ home: identityHome, launchctl }));
    check("remove remains reachable after Drive or its cron is disabled",
      removed.removed && !existsSync(expectedPlist));
  }
  {
    const rollbackPath = join(directory, "rollback", "brain.manifest.json");
    writeManifest(baseManifest, rollbackPath);
    const first = installDriveScheduler(rollbackPath, opts({
      home: join(directory, "rollback-home"),
      launchctl: (args) => args[0] === "print" ? { status: 1 } : { status: 0 },
    }));
    writeFileSync(first.plistPath, "previous-good-plist\n", { mode: 0o600 });
    let bootstrapCalls = 0, error = null;
    try {
      installDriveScheduler(rollbackPath, opts({
        home: join(directory, "rollback-home"),
        launchctl: (args) => {
          if (args[0] === "print") return { status: 0, stdout: "state = waiting\n" };
          if (args[0] === "bootstrap") return { status: bootstrapCalls++ === 0 ? 5 : 0, stderr: "bad new plist" };
          return { status: 0 };
        },
      }));
    } catch (caught) { error = caught; }
    check("a failed replacement restores and reloads the previous plist",
      /loading the Drive scheduler failed/.test(error?.message) && readFileSync(first.plistPath, "utf-8") === "previous-good-plist\n" && bootstrapCalls === 2,
      `${error?.message} calls=${bootstrapCalls}`);
  }
  {
    const rollbackPath = join(directory, "rollback-failure", "brain.manifest.json");
    writeManifest(baseManifest, rollbackPath);
    const rollbackHome = join(directory, "rollback-failure-home");
    const first = installDriveScheduler(rollbackPath, opts({
      home: rollbackHome,
      launchctl: (args) => args[0] === "print" ? { status: 1 } : { status: 0 },
    }));
    writeFileSync(first.plistPath, "previous-good-plist\n", { mode: 0o600 });
    let bootstrapCalls = 0, error = null, printCalls = 0;
    try {
      installDriveScheduler(rollbackPath, opts({
        home: rollbackHome,
        launchctl: (args) => {
          if (args[0] === "print") return { status: printCalls++ === 0 ? 0 : 1, stdout: "state = waiting\n" };
          if (args[0] === "bootstrap") { bootstrapCalls++; return { status: 5, stderr: "load refused" }; }
          return { status: 0 };
        },
      }));
    } catch (caught) { error = caught; }
    check("a failed rollback is surfaced alongside the replacement failure",
      /rollback also failed.*reloading the previous Drive scheduler/i.test(error?.message) && bootstrapCalls === 2,
      `${error?.message} calls=${bootstrapCalls}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\ndrive scheduler: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
