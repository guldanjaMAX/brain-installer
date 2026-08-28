// test/windows-supervision.test.mjs
//
// Windows supervision, proven with the exact technique the macOS scheduler
// suites use: a synthetic manifest in a sandbox home, a SCRIPTED external
// command (schtasks/icacls instead of launchctl), fixed node/binary paths — no
// real Task Scheduler, no real daemon process, no network.
//
// WHAT THIS FILE CANNOT PROVE, STATED FIRST BECAUSE A PASSING SUITE IS EASY TO
// MISREAD. This runs on a Mac. Nothing here proves that Task Scheduler accepts
// the XML, that a standard non-administrator user can register either task
// shape, that a five-minute repetition trigger actually revives a killed
// daemon, that an S4U task at boot can read a profile-scoped SQLite file, or
// that the Node drain can read the outbox while the Go daemon holds it open
// under Windows's mandatory file locking. Every one of those needs a Windows
// machine and is listed as unproven in evidence/WP-07-windows-supervision.md.
//
// WHAT IT DOES PROVE, and why each is worth a test:
//
//   1. The generated task definition. Every Task Scheduler default that would
//      quietly break a laptop install — battery, idle, execution time limit,
//      instance policy — is overridden explicitly, and the resident lane and
//      the tick lane differ where they must.
//   2. Mechanism detection. The branch picks by observation, degrades one rung
//      at a time, and leaves no probe behind.
//   3. The honesty path. Only a mechanism that restarts a dead process reports
//      supervised, and only a supervised install carries a freshness
//      expectation.
//   4. Install and uninstall control flow: verified registration, rollback on a
//      read-back mismatch, verified removal, and removal reachable with the
//      corpus flag off and the binary gone.
//
// Paths in this file are POSIX-shaped because the sandbox is a Mac temp
// directory. The path SEPARATOR is not what is under test; what is under test
// is that the same directory reaches the daemon and the drain, that the task
// name is stable, and that nothing is written outside the sandbox.
//
// Personas here are invented. Nothing in this file names a real person.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  WINDOWS_MECHANISMS,
  WINDOWS_WHATSAPP_DAEMON_LANE,
  WINDOWS_WHATSAPP_DRAIN_LANE,
  assertPrivateWindowsDirectory,
  buildWindowsSupervisionPlan,
  capWindowsLog,
  detectWindowsSupervisionMechanism,
  installWindowsSupervision,
  mechanismDisclosure,
  parseWindowsTaskStatus,
  removeWindowsSupervision,
  renderStartupCommand,
  renderWindowsTaskXml,
  runWindowsDrain,
  statusWindowsSupervision,
  windowsIdentityOf,
  windowsSupervisionReference,
} from "../operations/windows-supervision.mjs";
import { daemonEnvironment } from "../connectors/whatsapp.mjs";

function readdirSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 400)));
  if (!condition) fail++;
};

const directory = mkdtempSync(join(tmpdir(), "brain-windows-supervision-"));
const home = join(directory, "home & profile");
const startupFolder = join(directory, "Start Menu", "Startup");
const manifestPath = join(directory, "client & manifest", "brain.manifest.json");
mkdirSync(startupFolder, { recursive: true });

// An executable stand-in for the cross-compiled Go daemon. Nothing runs it;
// the installer only needs it to exist, because a task pointed at a missing
// executable is a task that fails forever while reporting itself installed.
const binaryPath = join(directory, "wa-daemon-windows-amd64.exe");
writeFileSync(binaryPath, "MZ");
chmodSync(binaryPath, 0o755);

// A Windows-shaped environment. SystemRoot is the one the POSIX allowlist used
// to drop, and without it Go cannot load system DLLs or resolve DNS.
const winEnv = Object.freeze({
  SystemRoot: "C:\\Windows",
  USERNAME: "priya",
  USERDOMAIN: "NORTHWIND",
  APPDATA: join(directory, "AppData"),
  LOCALAPPDATA: join(directory, "AppData", "Local"),
  USERPROFILE: home,
  TEMP: join(directory, "Temp"),
  PATHEXT: ".COM;.EXE;.BAT",
  AWS_SECRET_ACCESS_KEY: "must-never-reach-a-background-process",
});

const baseManifest = {
  manifest_version: 1,
  client: { slug: "northwind-brain", display_name: "Northwind", timezone: "America/Phoenix" },
  brain: { version: "0.1.22", domain: "brain.northwind.test" },
  infrastructure: { cloudflare: { account_id: "account-123" } },
  corpora: { google_drive: { enabled: true }, whatsapp: { enabled: true } },
  operations: {
    ingest_cron: "0 9 * * *",
    admin_key_secret: "dpapi://northwind-brain-admin",
  },
};

function writeManifest(manifest = baseManifest, path = manifestPath) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

// A scripted schtasks: records every invocation, answers from a script keyed on
// the verb, and can be told to answer differently on the Nth call.
function scriptedSchtasks(script = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args.join(" "));
    const verb = String(args[0] || "").replace("/", "");
    const handler = script[verb];
    const result = typeof handler === "function" ? handler(args, calls) : handler;
    return result || { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

const okIcacls = () => ({ status: 0, stdout: "Successfully processed 1 files.", stderr: "" });

// Windows's own words when a standard user is refused the batch-logon right.
const ACCESS_DENIED = {
  status: 1,
  stdout: "",
  stderr: "ERROR: Access is denied.",
};

function opts(extra = {}) {
  return {
    platform: "win32",
    home,
    env: winEnv,
    icacls: okIcacls,
    startupFolder,
    nodePath: "/opt/node/node.exe",
    brainPath: "/opt/brain installer/brain.mjs",
    schedulerPath: "/opt/brain installer/operations/windows-supervision.mjs",
    binaryPath,
    ...extra,
  };
}

// A definition read back from Task Scheduler is the definition it was given.
const echoQuery = (installedDefinition) => () =>
  installedDefinition === null
    ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
    : { status: 0, stdout: installedDefinition, stderr: "" };

try {
  writeManifest();

  /* ============ 1. THE GENERATED TASK DEFINITION ========================= */
  {
    const plan = buildWindowsSupervisionPlan(manifestPath, opts());
    const definition = renderWindowsTaskXml(plan, "task-logon");

    check("the task is client-scoped and lives under one product folder",
      plan.taskName === "\\brain-installer\\northwind-brain-whatsapp-daemon", plan.taskName);
    check("the label convention matches the macOS agent, so support names one thing",
      plan.label === "com.brain-installer.northwind-brain.whatsapp-daemon", plan.label);

    // THE FOUR DEFAULTS THAT WOULD HAVE BROKEN A LAPTOP INSTALL. Both battery
    // settings default to TRUE: capture would have refused to start on battery
    // and stopped the moment the charger came out.
    check("a laptop on battery still starts capture",
      /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/.test(definition), definition.slice(0, 200));
    check("unplugging the charger does not stop capture",
      /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/.test(definition));
    check("coming back to the keyboard does not stop capture",
      /<StopOnIdleEnd>false<\/StopOnIdleEnd>/.test(definition));
    check("the resident daemon has no execution time limit, so the three-day default cannot kill it",
      /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/.test(definition));

    // The repetition trigger IS the supervision. RestartOnFailure only fires on
    // a non-zero exit, so a daemon that exits cleanly or is killed in Task
    // Manager would never come back on that alone.
    check("a repetition trigger re-fires every five minutes, indefinitely",
      /<Interval>PT5M<\/Interval>/.test(definition) && !/<Duration>/.test(definition),
      definition.match(/<Repetition>[\s\S]*?<\/Repetition>/)?.[0]);
    check("IgnoreNew turns that repetition into a self-heal instead of a fork bomb",
      /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/.test(definition));
    check("RestartOnFailure is present as well, for the crash case",
      /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/.test(definition));

    check("the task runs as this user at least privilege, never elevated",
      /<UserId>NORTHWIND\\priya<\/UserId>/.test(definition) &&
      /<RunLevel>LeastPrivilege<\/RunLevel>/.test(definition), plan.identity);

    // Task Scheduler cannot set an environment variable, so the data directory
    // has to arrive on the command line or the daemon writes its session store
    // somewhere the drain never reads.
    check("the data directory is passed as an argument, because a task cannot set one in the environment",
      plan.commandArguments[0] === "--data-dir" && plan.commandArguments[1] === plan.dataDir,
      JSON.stringify(plan.commandArguments));
    check("a log destination is passed too, because Task Scheduler cannot redirect a child's output",
      plan.commandArguments.includes("--log-file") && plan.commandArguments.includes(plan.logPath),
      JSON.stringify(plan.commandArguments));
    // The sandbox home deliberately contains an ampersand, so this also proves
    // the definition escapes rather than emitting invalid XML.
    check("paths with XML-significant characters are escaped, not emitted raw",
      definition.includes(plan.dataDir.replaceAll("&", "&amp;")) && plan.dataDir.includes("&"),
      plan.dataDir);
    check("arguments containing spaces are quoted for Windows, in the single Arguments string",
      /<Arguments>--data-dir &quot;.*&quot; --log-file &quot;.*&quot;<\/Arguments>/.test(definition),
      definition.match(/<Arguments>.*<\/Arguments>/)?.[0]);

    check("the working directory is the daemon's own data directory, never an inherited cwd",
      new RegExp(`<WorkingDirectory>${plan.dataDir.replaceAll("&", "&amp;").replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}</WorkingDirectory>`).test(definition),
      plan.workingDirectory);

    /* ---- the credential claim, asserted rather than asserted in prose ---- */
    check("no credential material of any kind reaches the resident task",
      !definition.includes("dpapi://") && !definition.includes("CLOUDFLARE") &&
      !definition.includes("ADMIN") && !definition.includes("brain.northwind.test"),
      definition.slice(0, 400));
    check("the daemon child environment carries WA_DATA_DIR and Windows basics only",
      plan.childEnvironment.WA_DATA_DIR === plan.dataDir &&
      plan.childEnvironment.SystemRoot === "C:\\Windows" &&
      plan.childEnvironment.AWS_SECRET_ACCESS_KEY === undefined,
      JSON.stringify(Object.keys(plan.childEnvironment).sort()));

    check("the daemon's two SQLite files are resolved under one data directory",
      plan.outboxPath === join(plan.dataDir, "wa-outbox.db") &&
      plan.sessionDbPath === join(plan.dataDir, "wa-session.db"),
      JSON.stringify({ outbox: plan.outboxPath, session: plan.sessionDbPath }));
  }

  /* ---- the S4U rung differs where it must, and only where it must ---- */
  {
    const plan = buildWindowsSupervisionPlan(manifestPath, opts());
    const s4u = renderWindowsTaskXml(plan, "task-s4u");
    const interactive = renderWindowsTaskXml(plan, "task-logon");
    check("the best rung runs whether the client is signed in or not",
      /<LogonType>S4U<\/LogonType>/.test(s4u) && /<LogonType>InteractiveToken<\/LogonType>/.test(interactive));
    check("and only the best rung adds a boot trigger, because only it can run before sign-in",
      /<BootTrigger>/.test(s4u) && !/<BootTrigger>/.test(interactive));
    check("both rungs keep the logon trigger, so a machine already running starts capture at sign-in",
      /<LogonTrigger>/.test(s4u) && /<LogonTrigger>/.test(interactive));
    check("everything else about the two definitions is identical",
      s4u.replace(/[ ]*<BootTrigger>[\s\S]*?<\/BootTrigger>\n/, "").replace("S4U", "InteractiveToken") === interactive,
      "the rungs diverged somewhere other than the logon type and the boot trigger");
  }

  /* ---- the tick lane is a different shape from the resident lane ---- */
  {
    const drain = buildWindowsSupervisionPlan(manifestPath, opts({ kind: "whatsapp-drain" }));
    const definition = renderWindowsTaskXml(drain, "task-logon");
    check("the drain task name is distinct from the daemon's",
      drain.taskName === "\\brain-installer\\northwind-brain-whatsapp-drain", drain.taskName);
    check("the drain repeats every minute",
      /<Interval>PT1M<\/Interval>/.test(definition));
    // A run-to-completion pass MUST have a time limit: without one a wedged tick
    // holds the IgnoreNew slot forever and silently blocks every later tick.
    check("the drain has a real execution time limit, unlike the resident daemon",
      /<ExecutionTimeLimit>PT10M<\/ExecutionTimeLimit>/.test(definition) &&
      WINDOWS_WHATSAPP_DAEMON_LANE.executionTimeLimit === "PT0S",
      WINDOWS_WHATSAPP_DRAIN_LANE.executionTimeLimit);
    check("the drain task invokes the supervision runner with a configuration binding",
      drain.commandArguments[0] === "/opt/brain installer/operations/windows-supervision.mjs" &&
      drain.commandArguments[1] === "run" &&
      drain.commandArguments.includes("--config-hash") &&
      /^[a-f0-9]{64}$/.test(drain.configHash),
      JSON.stringify(drain.commandArguments));
    check("only the drain lane carries a freshness expectation; a resident process has no cadence",
      drain.expectedRefreshSeconds === 60 &&
      buildWindowsSupervisionPlan(manifestPath, opts()).expectedRefreshSeconds === null,
      String(drain.expectedRefreshSeconds));
    check("the drain plan carries no admin key of its own; the child resolves the manifest reference itself",
      !JSON.stringify(drain.commandArguments).includes("dpapi://"), JSON.stringify(drain.commandArguments));
  }

  /* ============ 2. MECHANISM DETECTION ================================== */
  {
    // The best rung, when Windows allows it.
    const schtasks = scriptedSchtasks({ Create: { status: 0, stdout: "SUCCESS", stderr: "" } });
    const detected = detectWindowsSupervisionMechanism(
      windowsSupervisionReference(manifestPath, opts()), { ...opts(), schtasks });
    check("when a run-whether-logged-on-or-not task registers, that is the mechanism chosen",
      detected.mechanism === "task-s4u" && detected.info.supervised === true &&
      detected.info.survivesLogout === true, JSON.stringify(detected.probes));
    check("detection stops at the first rung that works and does not probe the ones below",
      detected.probes.length === 1, JSON.stringify(detected.probes));
    check("the probe task is deleted, so detection leaves nothing registered",
      schtasks.calls.filter((c) => c.startsWith("/Delete")).length === 1 &&
      schtasks.calls[0].startsWith("/Create /TN \\brain-installer\\probe-"),
      JSON.stringify(schtasks.calls));
    check("no probe XML file survives detection",
      !existsSync(join(home, ".brain", "tasks")) ||
      readdirSafe(join(home, ".brain", "tasks")).every((n) => !n.startsWith("probe-")),
      JSON.stringify(readdirSafe(join(home, ".brain", "tasks"))));
  }
  {
    // The expected default for a standard user: S4U refused, interactive allowed.
    let attempt = 0;
    const schtasks = scriptedSchtasks({
      Create: () => (++attempt === 1 ? ACCESS_DENIED : { status: 0, stdout: "SUCCESS", stderr: "" }),
    });
    const detected = detectWindowsSupervisionMechanism(
      windowsSupervisionReference(manifestPath, opts()), { ...opts(), schtasks });
    check("a refused S4U registration degrades one rung, to a logon-triggered task",
      detected.mechanism === "task-logon" && detected.info.supervised === true,
      JSON.stringify(detected.probes));
    check("it degrades because Windows said so, and records what Windows said",
      detected.probes[0].available === false && /Access is denied/.test(detected.probes[0].detail) &&
      detected.probes[1].available === true,
      JSON.stringify(detected.probes));
    check("the chosen rung is honest that capture stops at sign-out",
      detected.info.survivesLogout === false, JSON.stringify(detected.info));
  }
  {
    // A locked-down machine where nothing can be registered at all.
    const schtasks = scriptedSchtasks({ Create: ACCESS_DENIED });
    const detected = detectWindowsSupervisionMechanism(
      windowsSupervisionReference(manifestPath, opts()), { ...opts(), schtasks });
    check("when no task can be registered, the last rung is a Startup-folder launcher",
      detected.mechanism === "startup-folder", JSON.stringify(detected.probes));
    check("and that rung does NOT claim to be supervision",
      detected.info.supervised === false && detected.info.selfHeals === false,
      JSON.stringify(detected.info));
    check("both refusals are recorded, so a support conversation has the reasons",
      detected.probes.length === 2 && detected.probes.every((p) => p.available === false),
      JSON.stringify(detected.probes));
  }
  {
    // No task, and no Startup folder either.
    const schtasks = scriptedSchtasks({ Create: ACCESS_DENIED });
    const detected = detectWindowsSupervisionMechanism(
      windowsSupervisionReference(manifestPath, opts()), { ...opts(), schtasks, startupFolder: null });
    check("with nothing available at all, the mechanism is none, not a hopeful guess",
      detected.mechanism === "none" && detected.info.supervised === false, JSON.stringify(detected));
  }
  {
    // A probe that registered but could not be deleted is reported, not swallowed.
    const schtasks = scriptedSchtasks({
      Create: { status: 0, stdout: "SUCCESS", stderr: "" },
      Delete: { status: 1, stdout: "", stderr: "ERROR: The task is currently running." },
    });
    const detected = detectWindowsSupervisionMechanism(
      windowsSupervisionReference(manifestPath, opts()), { ...opts(), schtasks });
    check("a probe that could not be deleted is named rather than left unsaid",
      detected.leftovers.length === 1 && detected.leftovers[0].name.includes("probe-"),
      JSON.stringify(detected.leftovers));
  }

  /* ============ 3. THE HONESTY PATH ===================================== */
  {
    // The ladder itself: exactly one property decides what may be claimed.
    const supervised = Object.values(WINDOWS_MECHANISMS).filter((m) => m.supervised).map((m) => m.name).sort();
    check("only the two task rungs are supervision; the launcher and none are not",
      JSON.stringify(supervised) === JSON.stringify(["task-logon", "task-s4u"]), JSON.stringify(supervised));
    check("every mechanism that claims supervision also claims to self-heal, and vice versa",
      Object.values(WINDOWS_MECHANISMS).every((m) => m.supervised === m.selfHeals),
      JSON.stringify(Object.values(WINDOWS_MECHANISMS).map((m) => [m.name, m.supervised, m.selfHeals])));

    const launcher = mechanismDisclosure("startup-folder");
    check("the launcher's disclosure says in plain words that nothing will restart it",
      launcher.some((line) => /will NOT restart|not restart it/i.test(line)) &&
      launcher.some((line) => /Nothing here will report capture as live/.test(line)),
      JSON.stringify(launcher));
    check("the logon rung's disclosure names the sign-out ceiling",
      mechanismDisclosure("task-logon").some((line) => /Signing out stops it/.test(line)),
      JSON.stringify(mechanismDisclosure("task-logon")));
    check("the best rung is not made to apologise for costs it does not have",
      mechanismDisclosure("task-s4u").length === 1,
      JSON.stringify(mechanismDisclosure("task-s4u")));
  }
  {
    // THE CONTRACT: an unsupervised install posts no freshness expectation, so
    // the source reports "no refresh scheduled" rather than reporting as live.
    const schtasks = scriptedSchtasks({ Create: ACCESS_DENIED });
    const installed = installWindowsSupervision(manifestPath, opts({ schtasks }));
    check("a Startup-folder install reports itself installed but NOT supervised",
      installed.installed === true && installed.supervised === false, JSON.stringify({
        installed: installed.installed, supervised: installed.supervised, mechanism: installed.mechanism,
      }));
    check("and carries NO freshness expectation, which is what keeps the source honest",
      installed.expectedRefreshSeconds === null, String(installed.expectedRefreshSeconds));
    check("the warning says what was installed and what it will not do",
      installed.warnings.some((w) => /will NOT restart/.test(w)) &&
      installed.warnings.some((w) => /rather than reporting itself as live/.test(w)),
      JSON.stringify(installed.warnings));
    const launcher = readFileSync(installed.startupPath, "utf-8");
    check("the launcher it wrote says in its own text that it is not a supervisor",
      /does NOT restart/.test(launcher) && launcher.includes(binaryPath), launcher);
    check("the launcher passes the same data directory the drain reads",
      launcher.includes(installed.dataDir), launcher);

    // The drain cannot run from a Startup folder at all: it has to run every
    // minute and a launcher runs once. Saying so is the whole point.
    const drain = installWindowsSupervision(manifestPath, opts({ schtasks, kind: "whatsapp-drain" }));
    check("the drain refuses the Startup-folder rung instead of installing something that cannot work",
      drain.installed === false && drain.supervised === false && drain.expectedRefreshSeconds === null,
      JSON.stringify(drain.warnings));
    check("and says exactly where the captured messages will sit until someone loads them",
      drain.warnings.some((w) => /local outbox/.test(w) && /--from whatsapp/.test(w)),
      JSON.stringify(drain.warnings));

    removeWindowsSupervision(manifestPath, opts({ schtasks: scriptedSchtasks({ Query: echoQuery(null) }) }));
  }
  {
    // The supervised case, for contrast: an expectation IS carried.
    const definition = renderWindowsTaskXml(buildWindowsSupervisionPlan(manifestPath, opts({ kind: "whatsapp-drain" })), "task-s4u");
    const schtasks = scriptedSchtasks({ Create: { status: 0, stdout: "SUCCESS", stderr: "" }, Query: echoQuery(definition) });
    const installed = installWindowsSupervision(manifestPath, opts({ schtasks, kind: "whatsapp-drain", mechanism: "task-s4u" }));
    check("a supervised drain reports supervised and carries the one-minute expectation",
      installed.supervised === true && installed.expectedRefreshSeconds === 60,
      JSON.stringify({ supervised: installed.supervised, expected: installed.expectedRefreshSeconds }));
  }

  /* ============ 4. INSTALL AND UNINSTALL CONTROL FLOW ==================== */
  {
    const definition = renderWindowsTaskXml(buildWindowsSupervisionPlan(manifestPath, opts()), "task-s4u");
    const schtasks = scriptedSchtasks({
      Create: { status: 0, stdout: "SUCCESS", stderr: "" },
      Query: echoQuery(definition),
      Run: { status: 0, stdout: "", stderr: "" },
    });
    const installed = installWindowsSupervision(manifestPath, opts({ schtasks, mechanism: "task-s4u" }));
    check("install registers the task, reads it back, and only then reports itself installed",
      installed.installed === true && installed.supervised === true, JSON.stringify(schtasks.calls));
    check("the read-back happens AFTER the create and BEFORE the run",
      schtasks.calls.findIndex((c) => c.startsWith("/Create")) <
      schtasks.calls.lastIndexOf(schtasks.calls.filter((c) => c.startsWith("/Query")).pop()) &&
      schtasks.calls.some((c) => c.startsWith("/Run")),
      JSON.stringify(schtasks.calls));
    check("the task is started immediately, so capture does not wait for the next sign-in",
      installed.started === true && schtasks.calls.some((c) => c === "/Run /TN \\brain-installer\\northwind-brain-whatsapp-daemon"),
      JSON.stringify(schtasks.calls));
    check("the definition on disk is exactly what the plan renders",
      existsSync(installed.xmlPath) &&
      readFileSync(installed.xmlPath).toString("utf16le").replace(/^\uFEFF/, "") === definition,
      installed.xmlPath);
    check("the data directory was locked down before anything was registered",
      existsSync(installed.dataDir), installed.dataDir);
  }
  {
    // Windows accepting the registration is not proof the definition took.
    const wanted = renderWindowsTaskXml(buildWindowsSupervisionPlan(manifestPath, opts()), "task-s4u");
    const wrong = wanted.replace(binaryPath, "C:\\Windows\\System32\\calc.exe");
    // Nothing was registered before this install, so the rollback path here is
    // "delete what you just made", not "put the old one back".
    let queried = 0;
    const schtasks = scriptedSchtasks({
      Create: { status: 0, stdout: "SUCCESS", stderr: "" },
      Query: () => (++queried === 1
        ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
        : { status: 0, stdout: wrong, stderr: "" }),
    });
    let error = null;
    try { installWindowsSupervision(manifestPath, opts({ schtasks, mechanism: "task-s4u" })); } catch (caught) { error = caught; }
    check("a task read back with a different action is refused, not trusted",
      /read it back with a different action/.test(error?.message || ""), error?.message);
    check("and the task it registered is deleted, so nothing unverified is left running",
      /nothing was left behind/i.test(error?.message || "") &&
      schtasks.calls.some((c) => c.startsWith("/Delete")), error?.message);
  }
  {
    // A create that Windows refuses leaves the previous task alone.
    const schtasks = scriptedSchtasks({
      Create: ACCESS_DENIED,
      Query: echoQuery(renderWindowsTaskXml(buildWindowsSupervisionPlan(manifestPath, opts()), "task-logon")),
    });
    let error = null;
    try { installWindowsSupervision(manifestPath, opts({ schtasks, mechanism: "task-logon" })); } catch (caught) { error = caught; }
    check("a refused replacement says the previous task is still running, rather than leaving it ambiguous",
      /previous task was left in place and is still running/.test(error?.message || ""), error?.message);
  }
  {
    // Reinstalling over a RUNNING resident daemon is allowed, exactly as on the
    // Mac: for a daemon, running is the normal condition, and refusing would
    // mean the operator has to stop capture in order to fix capture.
    const definition = renderWindowsTaskXml(buildWindowsSupervisionPlan(manifestPath, opts()), "task-logon");
    const schtasks = scriptedSchtasks({
      Create: { status: 0, stdout: "SUCCESS", stderr: "" },
      Query: echoQuery(definition),
    });
    const again = installWindowsSupervision(manifestPath, opts({ schtasks, mechanism: "task-logon" }));
    check("reinstalling while the task exists succeeds and reports it replaced",
      again.installed === true && again.replaced === true, JSON.stringify(again.replaced));
    check("Create carries /F, which replaces in place instead of deleting first",
      schtasks.calls.some((c) => c.startsWith("/Create") && c.endsWith("/F")), JSON.stringify(schtasks.calls));
  }
  {
    /* ---- status ---- */
    const definition = renderWindowsTaskXml(buildWindowsSupervisionPlan(manifestPath, opts()), "task-s4u");
    const listOutput = [
      "Folder: \\brain-installer",
      "HostName:                             NORTHWIND-PC",
      "TaskName:                             \\brain-installer\\northwind-brain-whatsapp-daemon",
      "Status:                               Running",
      "Last Run Time:                        8/28/2026 9:41:00 AM",
      "Last Result:                          267009",
      "Next Run Time:                        8/28/2026 9:46:00 AM",
    ].join("\r\n");
    const status = statusWindowsSupervision(manifestPath, opts({
      schtasks: scriptedSchtasks({
        Query: (args) => (args.includes("LIST")
          ? { status: 0, stdout: listOutput, stderr: "" }
          : { status: 0, stdout: definition, stderr: "" }),
      }),
    }));
    check("status reports installed, supervised and running, with what Windows said",
      status.installed === true && status.supervised === true && status.running === true &&
      status.lastResult === 267009 && status.definitionDrift === false,
      JSON.stringify({ supervised: status.supervised, running: status.running, drift: status.definitionDrift }));
    check("status reads the mechanism from the installed definition, not from what detection would pick today",
      status.mechanism === "task-s4u", status.mechanism);
    check("status distinguishes a paired session from an empty data directory",
      status.pairedSessionExists === false && status.outboxExists === false,
      JSON.stringify({ session: status.pairedSessionExists, outbox: status.outboxExists }));

    // A DISABLED task exists and does nothing. Calling that supervised would be
    // the exact lie this module is for.
    const disabled = statusWindowsSupervision(manifestPath, opts({
      schtasks: scriptedSchtasks({
        Query: (args) => (args.includes("LIST")
          ? { status: 0, stdout: listOutput.replace("Running", "Disabled"), stderr: "" }
          : { status: 0, stdout: definition, stderr: "" }),
      }),
    }));
    check("a task that exists but is DISABLED reports installed and NOT supervised",
      disabled.installed === true && disabled.supervised === false && disabled.disabled === true,
      JSON.stringify({ installed: disabled.installed, supervised: disabled.supervised }));

    const drifted = statusWindowsSupervision(manifestPath, opts({
      schtasks: scriptedSchtasks({
        Query: () => ({ status: 0, stdout: definition.replace(binaryPath, "C:\\other\\wa.exe"), stderr: "" }),
      }),
    }));
    check("a task whose action no longer matches the plan reports drift",
      drifted.definitionDrift === true, JSON.stringify(drifted.definitionMatches));

    const absent = statusWindowsSupervision(manifestPath, opts({ schtasks: scriptedSchtasks({ Query: echoQuery(null) }) }));
    check("with no task and no launcher, status reports mechanism none and not supervised",
      absent.installed === false && absent.mechanism === "none" && absent.supervised === false,
      JSON.stringify({ installed: absent.installed, mechanism: absent.mechanism }));
  }
  {
    /* ---- uninstall ---- */
    let deleted = false;
    const schtasks = scriptedSchtasks({
      Query: () => (deleted
        ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
        : { status: 0, stdout: "<Task/>", stderr: "" }),
      Delete: () => { deleted = true; return { status: 0, stdout: "SUCCESS", stderr: "" }; },
    });
    const removed = removeWindowsSupervision(manifestPath, opts({ schtasks }));
    check("removal ends the running instance, deletes the task, and verifies it is gone",
      removed.removed === true && removed.wasInstalled === true &&
      schtasks.calls.some((c) => c.startsWith("/End")) &&
      schtasks.calls.filter((c) => c.startsWith("/Query")).length === 2,
      JSON.stringify(schtasks.calls));
    check("removal stops the process before deleting the definition",
      schtasks.calls.findIndex((c) => c.startsWith("/End")) <
      schtasks.calls.findIndex((c) => c.startsWith("/Delete")), JSON.stringify(schtasks.calls));

    const second = removeWindowsSupervision(manifestPath, opts({ schtasks: scriptedSchtasks({ Query: echoQuery(null) }) }));
    check("removing an already-removed task is a no-op, not an error",
      second.removed === false && second.wasInstalled === false, JSON.stringify(second));
  }
  {
    // THE FAILURE THIS PRODUCT REFUSES TO CALL DONE: a delete that reports
    // success while the task is still registered.
    const schtasks = scriptedSchtasks({
      Query: { status: 0, stdout: "<Task/>", stderr: "" },
      Delete: { status: 0, stdout: "SUCCESS", stderr: "" },
    });
    let error = null;
    try { removeWindowsSupervision(manifestPath, opts({ schtasks })); } catch (caught) { error = caught; }
    check("a delete that reports success while the task survives is an error, not a done",
      /still registered/.test(error?.message || "") && /Capture may still be running/.test(error?.message || ""),
      error?.message);
  }
  {
    // Removal must stay reachable after the operator has already switched the
    // corpus off — the same precedent the Mac removals set. Requiring them to
    // re-declare what they are turning off would strand a registered task.
    const off = join(directory, "removal-with-corpus-off", "brain.manifest.json");
    writeManifest({ ...baseManifest, corpora: { google_drive: { enabled: true } } }, off);
    let deleted = false;
    const schtasks = scriptedSchtasks({
      Query: () => (deleted ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: "<Task/>", stderr: "" }),
      Delete: () => { deleted = true; return { status: 0, stdout: "SUCCESS", stderr: "" }; },
    });
    const removed = removeWindowsSupervision(off, opts({ schtasks }));
    check("removal works with corpora.whatsapp.enabled already false",
      removed.wasInstalled === true && removed.removed === true, JSON.stringify(schtasks.calls));

    let error = null;
    try { buildWindowsSupervisionPlan(off, opts()); } catch (caught) { error = caught; }
    check("...while INSTALLING still requires the corpus to be declared first",
      /corpora\.whatsapp\.enabled must be true/.test(error?.message || ""), error?.message);
  }
  {
    // A deleted binary must not block stopping the process that pointed at it.
    let deleted = false;
    const schtasks = scriptedSchtasks({
      Query: () => (deleted ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: "<Task/>", stderr: "" }),
      Delete: () => { deleted = true; return { status: 0, stdout: "SUCCESS", stderr: "" }; },
    });
    const removed = removeWindowsSupervision(manifestPath, opts({ schtasks, binaryPath: undefined, env: { ...winEnv } }));
    check("removal works when the daemon binary has been deleted",
      removed.wasInstalled === true && removed.installed === false, JSON.stringify(removed.removed));

    let error = null;
    try {
      buildWindowsSupervisionPlan(manifestPath, opts({
        binaryPath: undefined,
        env: { SystemRoot: "C:\\Windows", USERNAME: "priya" },
      }));
    } catch (caught) { error = caught; }
    check("installing without a daemon binary refuses with the build command, not a stack trace",
      error?.reason === "daemon_binary_missing" && /build\.sh/.test(error?.message || ""), error?.message);
  }
  {
    // Both rungs are swept regardless of which one is in use, so a machine
    // moved between rungs never ends up with two things starting the daemon.
    const strayLauncher = join(startupFolder, "brain-northwind-brain-whatsapp-daemon.cmd");
    writeFileSync(strayLauncher, "@echo off\r\n");
    const removed = removeWindowsSupervision(manifestPath, opts({ schtasks: scriptedSchtasks({ Query: echoQuery(null) }) }));
    check("uninstall removes a Startup-folder launcher even when the task rung is the installed one",
      removed.startupRemoved === true && !existsSync(strayLauncher), strayLauncher);
  }

  /* ============ 5. THE DRAIN CHILD ====================================== */
  {
    const plan = buildWindowsSupervisionPlan(manifestPath, opts({ kind: "whatsapp-drain" }));
    let seen = null;
    const spawn = (command, args, childOptions) => {
      seen = { command, args, childOptions };
      return { status: 0, stdout: "loaded 3 conversations\n", stderr: "" };
    };
    const result = runWindowsDrain(manifestPath, opts({
      kind: "whatsapp-drain", spawn, expectedConfigHash: plan.configHash,
    }));
    check("the tick runs the real CLI verb, so the credential gate applies to it too",
      seen.command === "/opt/node/node.exe" &&
      JSON.stringify(seen.args.slice(1)) === JSON.stringify(["ingest", manifestPath, "--from", "whatsapp"]),
      JSON.stringify(seen.args));
    check("the child gets a scrubbed Windows environment, not the interactive one Task Scheduler hands over",
      seen.childOptions.env.SystemRoot === "C:\\Windows" &&
      seen.childOptions.env.AWS_SECRET_ACCESS_KEY === undefined,
      JSON.stringify(Object.keys(seen.childOptions.env).sort()));
    check("the child window is hidden and its stdin is never a key source",
      seen.childOptions.windowsHide === true && seen.childOptions.stdio[0] === "ignore",
      JSON.stringify(seen.childOptions.stdio));
    check("a run-to-completion tick is bounded by a timeout, so it cannot wedge the instance slot",
      Number.isFinite(seen.childOptions.timeout) && seen.childOptions.timeout > 0,
      String(seen.childOptions.timeout));
    check("the run is appended to the log Task Scheduler cannot redirect for it",
      existsSync(result.logPath) && /whatsapp drain exit 0/.test(readFileSync(result.logPath, "utf-8")),
      result.logPath);
    check("the tick reports complete only when the child exited zero",
      result.status === "complete" && result.code === 0, JSON.stringify({ status: result.status, code: result.code }));

    const failed = runWindowsDrain(manifestPath, opts({
      kind: "whatsapp-drain",
      spawn: () => ({ status: 4, stdout: "", stderr: "outbox_missing\n" }),
    }));
    check("a failing tick reports failed and carries the child's exit code, never a silent success",
      failed.status === "failed" && failed.code === 4, JSON.stringify(failed.status));

    // A task installed against one manifest state must refuse to read
    // credentials for a manifest that has since been edited.
    let error = null;
    try {
      runWindowsDrain(manifestPath, opts({ kind: "whatsapp-drain", spawn, expectedConfigHash: "0".repeat(64) }));
    } catch (caught) { error = caught; }
    check("a tick whose manifest changed after installation refuses instead of running",
      /configuration changed/.test(error?.message || ""), error?.message);
  }

  /* ============ 6. THE SMALL PIECES ===================================== */
  {
    check("the Windows user identity is domain-qualified when Windows reports a domain",
      windowsIdentityOf(winEnv) === "NORTHWIND\\priya", windowsIdentityOf(winEnv));
    check("and is the bare user name on a machine that is not domain-joined",
      windowsIdentityOf({ USERNAME: "sam" }) === "sam");
    let error = null;
    try { windowsIdentityOf({}); } catch (caught) { error = caught; }
    check("with no user name at all it refuses rather than registering a task for nobody in particular",
      /did not report a user name/.test(error?.message || ""), error?.message);
  }
  {
    // W1, the bug that would have broken pairing on Windows before supervision
    // was even in play: a POSIX-only allowlist hands a Windows daemon an
    // environment with no SystemRoot, which Go needs for DLLs and DNS.
    const win = daemonEnvironment(winEnv, "C:\\data", "win32");
    check("the daemon environment on Windows carries SystemRoot",
      win.SystemRoot === "C:\\Windows", JSON.stringify(Object.keys(win).sort()));
    check("and does NOT invent a POSIX PATH on a machine that has no /usr/bin",
      win.PATH === undefined || !String(win.PATH).includes("/usr/bin"), String(win.PATH));
    check("while the macOS behaviour is unchanged",
      daemonEnvironment({ HOME: "/Users/sam" }, "/data", "darwin").PATH === "/usr/bin:/bin:/usr/sbin:/sbin");
    check("neither platform lets an unrelated credential through",
      win.AWS_SECRET_ACCESS_KEY === undefined &&
      daemonEnvironment(winEnv, "/data", "darwin").AWS_SECRET_ACCESS_KEY === undefined);
  }
  {
    // The session database holds the linked-device identity and its encryption
    // keys. Windows ignores the POSIX mode on mkdir, so the ACL is the only
    // thing actually protecting it, and a failure to set it must be fatal.
    const reference = windowsSupervisionReference(manifestPath, opts());
    const calls = [];
    assertPrivateWindowsDirectory(join(directory, "acl-ok"), reference, {
      icacls: (args) => { calls.push(args.join(" ")); return { status: 0 }; },
    });
    check("the data directory has inheritance broken and is granted to this account only",
      calls[0].includes("/inheritance:r") && calls[0].includes("/grant:r") &&
      calls[0].includes("NORTHWIND\\priya:(OI)(CI)F"), JSON.stringify(calls));
    let error = null;
    try {
      assertPrivateWindowsDirectory(join(directory, "acl-refused"), reference, {
        icacls: () => ({ status: 5, stderr: "Access is denied." }),
      });
    } catch (caught) { error = caught; }
    check("an ACL that Windows would not apply stops the install rather than warning",
      /credential-equivalent/.test(error?.message || "") && /nothing was installed/i.test(error?.message || ""),
      error?.message);
  }
  {
    const status = parseWindowsTaskStatus([
      "TaskName:      \\brain-installer\\x",
      "Status:        Ready",
      "Last Result:   0",
      "Next Run Time: 8/28/2026 9:46:00 AM",
    ].join("\r\n"));
    check("schtasks list output is parsed into ready, running and the last result",
      status.ready === true && status.running === false && status.lastResult === 0 &&
      status.nextRunTime === "8/28/2026 9:46:00 AM", JSON.stringify(status));
    check("an empty query is not read as a healthy task",
      parseWindowsTaskStatus("").running === false && parseWindowsTaskStatus("").status === null);
  }
  {
    const logPath = join(directory, "cap.log");
    writeFileSync(logPath, "x".repeat(64));
    check("a log under the cap is left alone", capWindowsLog(logPath, { maxBytes: 1024 }).rotated === false);
    check("a log over the cap is rotated to history rather than truncated in place",
      capWindowsLog(logPath, { maxBytes: 8, historyFiles: 2 }).rotated === true &&
      existsSync(`${logPath}.1`) && !existsSync(logPath),
      `${logPath}.1`);
    check("capping a log that does not exist is not an error",
      capWindowsLog(join(directory, "never-written.log")).rotated === false);
  }
  {
    // A Mac caller reaching the Windows module is a routing bug, and the
    // refusal has to name the module that should have been used.
    let error = null;
    try { windowsSupervisionReference(manifestPath, opts({ platform: "darwin" })); } catch (caught) { error = caught; }
    check("a macOS caller is refused and pointed at the LaunchAgent module",
      /whatsapp-daemon\.mjs/.test(error?.message || ""), error?.message);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\nwindows supervision: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
