// test/imessage-scheduler.test.mjs
//
// The iMessage capture LaunchAgent, proven with the exact technique
// test/drive-scheduler.test.mjs uses for Drive: a synthetic manifest in a
// sandbox home, a scripted launchctl closure, and fixed node/brain/scheduler
// paths — no real launchd interaction, no real chat.db, no network. It also
// proves the generalization itself: the Drive scheduler built from the same
// manifest keeps its exact pre-generalization identity, and the two agents
// coexist with fully distinct labels, plists, logs and locks.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  IMESSAGE_CAPTURE_DEFAULT_CRON,
  IMESSAGE_SCHEDULER_SPEC,
  buildImessageSchedulerPlan,
  installImessageScheduler,
  removeImessageScheduler,
  runImessageCapture,
  statusImessageScheduler,
} from "../operations/imessage-scheduler.mjs";
import {
  CLOUDFLARE_CREDENTIAL_ENV,
  buildDriveSchedulerPlan,
  renderLaunchAgentPlist,
} from "../operations/drive-scheduler.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

const directory = mkdtempSync(join(tmpdir(), "brain-imessage-scheduler-"));
const home = join(directory, "home & logs");
const manifestPath = join(directory, "client & manifest", "brain.manifest.json");
const baseManifest = {
  manifest_version: 1,
  client: { slug: "acme-brain", display_name: "Acme", timezone: "America/Phoenix" },
  brain: { version: "0.1.0", domain: "brain.acme.test" },
  infrastructure: { cloudflare: { account_id: "account-123" } },
  corpora: { google_drive: { enabled: true }, imessage: { enabled: true } },
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
    localTimeZone: "America/Phoenix",
    ...extra,
  };
}

try {
  writeManifest();

  /* ================= plan, schedule, and identity ================= */
  {
    const plan = buildImessageSchedulerPlan(manifestPath, opts());
    check("the label is standard, client-scoped, and distinct from Drive's",
      plan.label === "com.brain-installer.acme-brain.imessage-capture", plan.label);
    check("the default schedule is every minute, expressed as one empty calendar entry",
      plan.cron === IMESSAGE_CAPTURE_DEFAULT_CRON && JSON.stringify(plan.intervals) === JSON.stringify([{}]),
      JSON.stringify({ cron: plan.cron, intervals: plan.intervals }));
    check("an every-minute schedule derives a one-minute freshness expectation",
      plan.expectedRefreshSeconds === 60, String(plan.expectedRefreshSeconds));
    check("the LaunchAgent invokes the iMessage scheduler runner with a configuration binding",
      plan.programArguments[1].endsWith("operations/imessage-scheduler.mjs") &&
      JSON.stringify(plan.programArguments.slice(2, 7)) === JSON.stringify([
        "run", manifestPath, "--brain", resolve("/opt/brain installer/brain.mjs"), "--config-hash",
      ]) && plan.programArguments[7] === plan.configHash && /^[a-f0-9]{64}$/.test(plan.configHash),
      JSON.stringify(plan.programArguments));
    check("logs and the single-instance lock are iMessage-named under .brain",
      plan.stdoutPath.endsWith("acme-brain-imessage-capture.out.log") &&
      plan.lockPath.endsWith("acme-brain-imessage-capture.lock"));
    const plist = renderLaunchAgentPlist(plan);
    check("the plist contains no credential material and no Drive arguments",
      !plist.includes("keychain://") && !plist.includes("CLOUDFLARE") && !plist.includes("--from drive") &&
      plist.includes("imessage-scheduler.mjs"));
    check("the manifest cron knob overrides the built-in default",
      buildImessageSchedulerPlan(
        writeManifest({ ...baseManifest, operations: { ...baseManifest.operations, imessage_capture_cron: "*/2 * * * *" } },
          join(directory, "cron-override", "brain.manifest.json")),
        opts()
      ).expectedRefreshSeconds === 120);
  }
  {
    const drive = buildDriveSchedulerPlan(manifestPath, opts({
      schedulerPath: "/opt/brain installer/operations/drive-scheduler.mjs",
    }));
    const imessage = buildImessageSchedulerPlan(manifestPath, opts());
    check("the generalization leaves Drive's identity exactly as before",
      drive.label === "com.brain-installer.acme-brain.drive-ingest" &&
      drive.stdoutPath.endsWith("acme-brain-drive-ingest.out.log") &&
      drive.programArguments.includes("drive-scheduler.mjs") === false &&
      drive.programArguments[1] === resolve("/opt/brain installer/operations/drive-scheduler.mjs"),
      JSON.stringify(drive.programArguments));
    check("the two connectors coexist with fully distinct plists, logs and locks",
      drive.plistPath !== imessage.plistPath && drive.stdoutPath !== imessage.stdoutPath &&
      drive.lockPath !== imessage.lockPath && drive.configHash !== imessage.configHash);
  }

  /* ================= validation ================= */
  {
    let error = null;
    try { buildImessageSchedulerPlan(manifestPath, opts({ platform: "win32" })); } catch (caught) { error = caught; }
    check("non-macOS scheduling fails with the honest Mac-only statement",
      /Messages database, which exists only on macOS/.test(error?.message), error?.message);
  }
  {
    const disabledPath = join(directory, "disabled", "brain.manifest.json");
    writeManifest({ ...baseManifest, corpora: { google_drive: { enabled: true } } }, disabledPath);
    let error = null;
    try { buildImessageSchedulerPlan(disabledPath, opts()); } catch (caught) { error = caught; }
    check("corpora.imessage.enabled must be declared before install",
      /corpora\.imessage\.enabled must be true/.test(error?.message), error?.message);
  }
  {
    const noDomainPath = join(directory, "no-domain", "brain.manifest.json");
    writeManifest({ ...baseManifest, brain: { version: "0.1.0" } }, noDomainPath);
    let error = null;
    try { buildImessageSchedulerPlan(noDomainPath, opts()); } catch (caught) { error = caught; }
    check("token-free capture requires a manifest domain at install time",
      /brain\.domain is required for unattended iMessage capture/.test(error?.message), error?.message);
  }
  {
    const badCronPath = join(directory, "bad-cron", "brain.manifest.json");
    writeManifest({
      ...baseManifest,
      operations: { ...baseManifest.operations, imessage_capture_cron: "61 * * * *" },
    }, badCronPath);
    let error = null;
    try { buildImessageSchedulerPlan(badCronPath, opts()); } catch (caught) { error = caught; }
    check("a bad capture cron is rejected naming the iMessage knob, not Drive's",
      /minute.*0-59.*iMessage capture cron/i.test(error?.message), error?.message);
  }

  /* ================= lifecycle: install, status, remove ================= */
  {
    const calls = [];
    const launchctl = (args) => {
      calls.push(args);
      return args[0] === "print" ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: "", stderr: "" };
    };
    const installed = installImessageScheduler(manifestPath, opts({ launchctl }));
    check("install atomically writes a private LaunchAgent plist",
      existsSync(installed.plistPath) &&
      (process.platform === "win32" || (statSync(installed.plistPath).mode & 0o777) === 0o600));
    check("install enables and bootstraps the user service",
      calls.some((x) => x[0] === "enable" && x[1] === installed.service) &&
      calls.some((x) => x[0] === "bootstrap" && x[1] === installed.domain && x[2] === installed.plistPath),
      JSON.stringify(calls));
    if (process.platform === "darwin") {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", installed.plistPath], { encoding: "utf-8" });
      check("the generated definition passes macOS's native plist parser", lint.status === 0, lint.stderr || lint.stdout);
    }

    const status = statusImessageScheduler(manifestPath, opts({
      launchctl: () => ({ status: 0, stdout: "state = running\npid = 4321\nruns = 12\nlast exit code = 0\n", stderr: "" }),
    }));
    check("status reports installed, loaded, running, and run history",
      status.installed && status.loaded && status.running && status.pid === 4321 &&
      status.runs === 12 && status.lastRunSucceeded === true, JSON.stringify(status));
    check("status proves the loaded definition matches the current manifest",
      status.definitionMatches && !status.definitionDrift);

    const removed = removeImessageScheduler(manifestPath, opts({
      launchctl: (args) => args[0] === "print"
        ? { status: 0, stdout: "state = waiting\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
    }));
    check("remove unloads and removes only the plist",
      removed.removed && !existsSync(installed.plistPath));
  }
  {
    // The removeDriveScheduler reasoning, carried over verbatim: removal must
    // stay reachable when the corpus flag is already off, or a disabled
    // manifest strands the loaded LaunchAgent forever.
    const strandedPath = join(directory, "stranded", "brain.manifest.json");
    writeManifest({ ...baseManifest, corpora: { imessage: { enabled: false } }, operations: {} }, strandedPath);
    const strandedHome = join(directory, "stranded-home");
    const expectedPlist = join(strandedHome, "Library", "LaunchAgents", "com.brain-installer.acme-brain.imessage-capture.plist");
    mkdirSync(dirname(expectedPlist), { recursive: true });
    writeFileSync(expectedPlist, "old imessage scheduler\n");
    const launchctl = () => ({ status: 1, stdout: "", stderr: "not loaded" });
    const status = statusImessageScheduler(strandedPath, opts({ home: strandedHome, launchctl }));
    check("status remains reachable after the iMessage corpus is disabled",
      status.installed && /corpora\.imessage\.enabled/.test(status.scheduleError), status.scheduleError);
    const removed = removeImessageScheduler(strandedPath, opts({ home: strandedHome, launchctl }));
    check("remove remains reachable after the iMessage corpus is disabled",
      removed.removed && !existsSync(expectedPlist));
  }

  /* ================= the scheduled tick ================= */
  {
    let child = null;
    const result = runImessageCapture(manifestPath, opts({
      env: {
        HOME: home,
        CLOUDFLARE_API_TOKEN: "deployment-secret",
        ADMIN_KEY: "ambient-key",
        BRAIN_GOOGLE_TOKEN_STORE: "file",
      },
      spawn: (command, args, options) => { child = { command, args, options }; return { status: 0 }; },
    }));
    check("a tick invokes lockf around brain ingest --from imessage",
      child.command === "/usr/bin/lockf" && JSON.stringify(child.args) === JSON.stringify([
        "-k", "-s", "-t", "0", result.lockPath,
        resolve("/opt/node/bin/node"), resolve("/opt/brain installer/brain.mjs"),
        "ingest", manifestPath, "--from", "imessage",
      ]), JSON.stringify(child?.args));
    check("the tick's child environment is scrubbed of every credential",
      CLOUDFLARE_CREDENTIAL_ENV.every((name) => child.options.env[name] === undefined) &&
      child.options.env.ADMIN_KEY === undefined && child.options.env.HOME === home &&
      Array.isArray(child.options.stdio) && child.options.stdio[0] === "ignore",
      JSON.stringify(child.options.env));
    check("a successful tick reports complete", result.status === "complete" && result.code === 0);
  }
  {
    const busy = runImessageCapture(manifestPath, opts({
      env: { HOME: home },
      spawn: () => ({ status: 75 }),
    }));
    check("lock contention skips a tick with the iMessage busy reason",
      busy.status === "skipped" && busy.code === 0 && /iMessage capture is already running/.test(busy.reason),
      JSON.stringify(busy));
  }
  {
    const boundPath = join(directory, "bound-config", "brain.manifest.json");
    writeManifest(baseManifest, boundPath);
    const original = buildImessageSchedulerPlan(boundPath, opts());
    writeManifest({
      ...baseManifest,
      brain: { ...baseManifest.brain, domain: "attacker.invalid" },
    }, boundPath);
    let error = null, spawned = false;
    try {
      runImessageCapture(boundPath, opts({
        expectedConfigHash: original.configHash,
        spawn: () => { spawned = true; return { status: 0 }; },
      }));
    } catch (caught) { error = caught; }
    check("a post-install manifest change stops the tick before any child runs",
      /iMessage configuration changed.*reinstall/i.test(error?.message) && !spawned, error?.message);
  }
  {
    check("the spec's Mac-only truth is stated in the platform error itself",
      /macOS/.test(IMESSAGE_SCHEDULER_SPEC.platformError("linux")));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nimessage scheduler: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
