#!/usr/bin/env node
/**
 * Windows process supervision — the first one in this product, and the one
 * every later Windows connector inherits.
 *
 * WHAT THIS IS FOR. `operations/whatsapp-daemon.mjs` keeps the capture daemon
 * alive with a macOS LaunchAgent and says, in its own header, that Windows has
 * nothing. That was true and it was the whole problem: on Windows the daemon
 * died at logout or reboot and nothing brought it back, while the install
 * record still said the corpus was enabled. A client would have believed
 * capture was running when it was not, which is the exact silent-failure class
 * this product keeps getting bitten by.
 *
 * TWO SHAPES, ONE PRIMITIVE. WhatsApp capture is genuinely two processes with
 * opposite lifecycles, and Windows wants a different answer for each:
 *
 *   - the RESIDENT daemon holds a websocket and must never be killed by a
 *     timeout, so its task gets no execution time limit and a repetition
 *     trigger that re-fires the (ignored-if-already-running) action every few
 *     minutes. That repetition IS the supervision: it restarts a daemon that
 *     died for any reason, including a clean exit, which `RestartOnFailure`
 *     alone would never do.
 *   - the DRAIN is run-to-completion. Task Scheduler was built for exactly
 *     that, so it needs no supervisor at all: a repeating trigger runs it, an
 *     execution time limit bounds a hung pass, and MultipleInstancesPolicy is
 *     the single-instance guarantee that `lockf` provides on the Mac.
 *
 * THE MECHANISM IS DETECTED, NOT ASSUMED. Whether a standard, non-administrator
 * user can register the task shape we want could not be settled from here (see
 * the open question in the build spec). So install PROBES: it registers a
 * throwaway task of the preferred shape, reads what Windows actually said, and
 * deletes it again. Whatever comes back decides which rung of the ladder gets
 * installed, and the rung is reported rather than hidden:
 *
 *   task-s4u        best. Runs whether the client is signed in or not, in a
 *                   non-interactive session, so no console window ever
 *                   appears. Needs the "log on as a batch job" right, which a
 *                   standard user often does not hold.
 *   task-logon      the expected default for a non-administrator. Self-heals
 *                   within the repetition interval. Capture runs while the
 *                   client is signed in and STOPS at logout, and because the
 *                   action runs in the interactive session the console-
 *                   subsystem daemon shows a window. Both costs are named, not
 *                   papered over.
 *   startup-folder  last resort, for a machine where task registration is
 *                   refused outright. Starts the daemon at logon and NEVER
 *                   restarts it. This rung is NOT supervision and does not
 *                   claim to be: `supervised` is false, no freshness
 *                   expectation is posted, and the source reports itself as
 *                   having no refresh scheduled.
 *   none            nothing available. Nothing is installed and nothing is
 *                   claimed.
 *
 * WHAT IS DELIBERATELY NOT HERE. A Windows Service is disqualified: it needs an
 * administrator to install and it runs under the wrong profile, while the
 * linked-device session database lives in the client's own profile. A Registry
 * Run key is disqualified twice over — it cannot restart a dead process, and it
 * is the single most antivirus-flagged persistence key there is. The GUI-
 * subsystem supervisor that would remove the console window on the task-logon
 * rung is a separate piece of Go work and is not built; until it is, that cost
 * is stated at install time instead of being silently accepted.
 *
 * WHAT CANNOT BE PROVEN FROM A MAC. Every assertion in the test suite is about
 * the generated definition, the install/uninstall control flow, the detection
 * branch and the honesty path. None of it proves Task Scheduler accepts this
 * XML, that a standard user can register it, that a repetition trigger revives
 * a killed daemon, or that an S4U task at boot can read a profile-scoped SQLite
 * file. Those need a Windows machine and are listed as unproven in the
 * evidence file rather than implied by a passing suite.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DRIVE_LOG_HISTORY_FILES, DRIVE_LOG_MAX_BYTES } from "./drive-scheduler.mjs";
import { WHATSAPP_DRAIN_SCHEDULER_SPEC } from "./whatsapp-drain-scheduler.mjs";
import {
  daemonEnvironment,
  defaultDataDir,
  outboxPathFor,
  resolveDaemonBinary,
  sessionDbPathFor,
} from "../connectors/whatsapp.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_BRAIN_PATH = resolve(dirname(SELF_PATH), "..", "brain.mjs");

/**
 * The only environment a Windows child is given. Same allowlist the DPAPI
 * bridge and the admin-key file already use, for the same reason: a background
 * process gets the locators Windows needs to function and nothing else. The
 * POSIX-only allowlist that used to be applied here handed a Windows daemon an
 * environment with no SystemRoot, which Go needs for DLL loading and DNS.
 */
export const WINDOWS_RUNTIME_ENV = Object.freeze([
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
  "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
]);

/* ====================================================================== */
/*  The ladder                                                            */
/* ====================================================================== */

/**
 * Every mechanism this module can install, with the four properties that decide
 * what may honestly be claimed about it. `supervised` is the one the rest of
 * the product reads: it means "something on this machine will bring the process
 * back if it dies". Only a supervised mechanism may carry a freshness
 * expectation, because an expectation is a promise that the source refreshes.
 */
export const WINDOWS_MECHANISMS = Object.freeze({
  "task-s4u": Object.freeze({
    name: "task-s4u",
    rank: 3,
    supervised: true,
    selfHeals: true,
    survivesLogout: true,
    visibleConsole: false,
    summary:
      "a Scheduled Task that runs whether you are signed in or not, restarted automatically if it stops",
  }),
  "task-logon": Object.freeze({
    name: "task-logon",
    rank: 2,
    supervised: true,
    selfHeals: true,
    survivesLogout: false,
    visibleConsole: true,
    summary:
      "a Scheduled Task that starts when you sign in, restarted automatically if it stops, and stopped when you sign out",
  }),
  "startup-folder": Object.freeze({
    name: "startup-folder",
    rank: 1,
    supervised: false,
    selfHeals: false,
    survivesLogout: false,
    visibleConsole: true,
    summary:
      "a Startup-folder launcher that starts capture when you sign in and does NOT restart it if it stops",
  }),
  none: Object.freeze({
    name: "none",
    rank: 0,
    supervised: false,
    selfHeals: false,
    survivesLogout: false,
    visibleConsole: false,
    summary: "nothing on this machine can keep a background process alive",
  }),
});

/** Best first. Detection walks this order and stops at the first that works. */
export const WINDOWS_MECHANISM_ORDER = Object.freeze(["task-s4u", "task-logon", "startup-folder"]);

export function mechanismInfo(name) {
  return WINDOWS_MECHANISMS[name] || WINDOWS_MECHANISMS.none;
}

/**
 * The sentence an owner is owed about a mechanism, including what it costs.
 * Kept next to the ladder so a new rung cannot be added without one.
 */
export function mechanismDisclosure(name) {
  const info = mechanismInfo(name);
  const lines = [`Supervision on this PC: ${info.summary}.`];
  if (!info.supervised) {
    lines.push(
      "This is NOT supervision. If the capture process stops — a crash, a Windows update, " +
        "an antivirus quarantine — nothing will start it again, and the only signal will be " +
        "that new messages stop arriving. Nothing here will report capture as live."
    );
  }
  if (info.supervised && !info.survivesLogout) {
    lines.push(
      "Capture runs while you are signed in to this PC. Signing out stops it; signing back " +
        "in starts it again. Locking the screen is fine, signing out is not."
    );
  }
  if (info.visibleConsole) {
    lines.push(
      "A console window belongs to each background process because Windows Task Scheduler " +
        "cannot start one without a session. Minimise it; closing it stops capture until the " +
        "next restart."
    );
  }
  return lines;
}

/* ====================================================================== */
/*  Lane specs — what is connector-specific about each supervised process  */
/* ====================================================================== */

/**
 * The resident capture daemon. No execution time limit (Task Scheduler's
 * default is three days and would kill it), and a repetition interval that is
 * the actual restart mechanism.
 */
export const WINDOWS_WHATSAPP_DAEMON_LANE = Object.freeze({
  kind: "whatsapp-daemon",
  noun: "WhatsApp capture daemon",
  resident: true,
  repetitionMinutes: 5,
  // PT0S means "no limit" in the Task Scheduler schema, which is the only
  // correct value for a process whose steady state is running.
  executionTimeLimit: "PT0S",
  // A resident process has no refresh cadence of its own; the drain owns the
  // freshness expectation for this corpus.
  expectedRefreshSeconds: null,
  description:
    "Keeps the WhatsApp capture daemon running. It writes a local outbox on this PC and sends nothing anywhere.",
});

/**
 * The drain tick. Run-to-completion, so it gets a real time limit: without one
 * a wedged pass would hold the single-instance slot forever and IgnoreNew would
 * silently block every later tick — the failure mode the limit exists to stop.
 */
export const WINDOWS_WHATSAPP_DRAIN_LANE = Object.freeze({
  kind: "whatsapp-drain",
  noun: "WhatsApp drain",
  resident: false,
  repetitionMinutes: 1,
  executionTimeLimit: "PT10M",
  expectedRefreshSeconds: 60,
  description:
    "Loads what the WhatsApp capture daemon wrote on this PC into this install's own brain.",
});

const LANES = Object.freeze({
  "whatsapp-daemon": WINDOWS_WHATSAPP_DAEMON_LANE,
  "whatsapp-drain": WINDOWS_WHATSAPP_DRAIN_LANE,
});

export function windowsLane(kind) {
  const lane = LANES[kind];
  if (!lane) throw new Error(`unknown Windows supervision lane: ${kind}`);
  return lane;
}

/* ====================================================================== */
/*  Identity and paths                                                    */
/* ====================================================================== */

function readManifest(manifestPath, read = readFileSync) {
  const path = resolve(manifestPath || "");
  try {
    return { path, manifest: JSON.parse(read(path, "utf-8")) };
  } catch (error) {
    throw new Error(`could not read manifest at ${path}: ${error.message}`);
  }
}

function clientSlugOf(manifest) {
  const slug = String(manifest?.client?.slug || "");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    throw new Error("the manifest needs a valid client.slug before Windows supervision can be installed");
  }
  return slug;
}

/**
 * The Windows account the task runs as. A task with no principal runs as
 * whoever registered it, which is right, but the XML has to name somebody or
 * Task Scheduler substitutes its own default — so this refuses rather than
 * guessing.
 */
export function windowsIdentityOf(environment = process.env) {
  const user = String(environment?.USERNAME || "").trim();
  if (!user) {
    throw new Error(
      "Windows did not report a user name (USERNAME), so a Scheduled Task cannot be registered for anyone in particular"
    );
  }
  const domain = String(environment?.USERDOMAIN || "").trim();
  return domain ? `${domain}\\${user}` : user;
}

function systemRootOf(environment = process.env) {
  const root = environment?.SystemRoot || environment?.SYSTEMROOT || environment?.WINDIR;
  if (!root) throw new Error("Windows could not locate its system runtime directory (SystemRoot)");
  return String(root);
}

function assertWindows(platform = process.platform) {
  if (platform !== "win32") {
    throw new Error(
      `Windows supervision installs a Windows Scheduled Task; this machine reports ${platform}. ` +
        "On macOS the LaunchAgent path in operations/whatsapp-daemon.mjs is the supervisor."
    );
  }
}

/**
 * Identity and paths, resolvable with no requirement that the corpus is enabled
 * or that a binary exists. Removal has to stay reachable after either becomes
 * untrue, which is the same reasoning the Mac module states.
 *
 * The label convention is deliberately identical to the Mac one so a support
 * conversation names the same thing on both platforms, and the data directory
 * is resolved by the SAME helper the drain uses, because a daemon writing one
 * directory while the drain reads another is the quietest way this connector
 * could fail.
 */
export function windowsSupervisionReference(manifestPath, options = {}) {
  assertWindows(options.platform);
  const lane = windowsLane(options.kind || "whatsapp-daemon");
  const { path, manifest } = readManifest(manifestPath, options.readFile);
  const slug = clientSlugOf(manifest);
  const home = resolve(options.home || homedir());
  const environment = options.env || process.env;
  const label = `com.brain-installer.${slug}.${lane.kind}`;
  const runtimeDir = join(home, ".brain");
  const configured = manifest?.operations?.whatsapp_data_dir;
  const dataDir = options.dataDir
    ? resolve(options.dataDir)
    : configured
      ? resolve(String(configured))
      : defaultDataDir(slug, home);
  return {
    lane,
    kind: lane.kind,
    path,
    manifest,
    slug,
    home,
    label,
    // Task Scheduler folders are created implicitly by /Create. One folder per
    // product keeps an uninstall auditable in the Task Scheduler UI.
    taskName: `\\brain-installer\\${slug}-${lane.kind}`,
    taskDir: join(runtimeDir, "tasks"),
    xmlPath: join(runtimeDir, "tasks", `${slug}-${lane.kind}.xml`),
    startupCommandPath: join(runtimeDir, "tasks", `${slug}-${lane.kind}.startup.cmd`),
    logsDir: join(runtimeDir, "logs"),
    logPath: join(runtimeDir, "logs", `${slug}-${lane.kind}.log`),
    dataDir,
    outboxPath: outboxPathFor(dataDir),
    sessionDbPath: sessionDbPathFor(dataDir),
    identity: windowsIdentityOf(environment),
    systemRoot: systemRootOf(environment),
  };
}

/** Where the Startup-folder launcher goes when no task can be registered. */
export function startupFolderOf(environment = process.env) {
  const appData = environment?.APPDATA;
  if (!appData) return null;
  return join(String(appData), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/* ====================================================================== */
/*  The plan                                                              */
/* ====================================================================== */

/**
 * The installable plan. The corpus must be declared and, for the daemon lane,
 * the binary must exist — a task pointed at a missing executable is a task that
 * fails every few minutes forever while reporting itself installed, which is
 * the same lie in a different font.
 */
export function buildWindowsSupervisionPlan(manifestPath, options = {}) {
  const reference = windowsSupervisionReference(manifestPath, options);
  if (reference.manifest?.corpora?.whatsapp?.enabled !== true) {
    throw new Error("corpora.whatsapp.enabled must be true before WhatsApp supervision can be installed on Windows");
  }
  if (reference.lane.resident) {
    const binary = options.binaryPath
      ? { path: resolve(options.binaryPath), source: "supplied" }
      : resolveDaemonBinary({
        env: options.env,
        manifest: reference.manifest,
        platform: "win32",
        arch: options.arch || "x64",
      });
    return {
      ...reference,
      binaryPath: binary.path,
      binarySource: binary.source,
      command: binary.path,
      // Task Scheduler has no way to set an environment variable, so every
      // knob the daemon would have read from its environment is passed on the
      // command line instead. The data directory in particular MUST come
      // through: silently falling back to the daemon's own default would put
      // the session store somewhere the drain never looks.
      commandArguments: ["--data-dir", reference.dataDir, "--log-file", reference.logPath],
      workingDirectory: reference.dataDir,
      // "win32" is passed rather than inferred: this plan is built for a
      // Windows machine even when it is being rendered or reviewed on another
      // one, and inferring would silently produce a POSIX environment here.
      childEnvironment: daemonEnvironment(options.env || process.env, reference.dataDir, "win32"),
      expectedRefreshSeconds: reference.lane.expectedRefreshSeconds,
    };
  }
  if (typeof reference.manifest?.brain?.domain !== "string" || !reference.manifest.brain.domain.trim()) {
    throw new Error(
      "brain.domain is required for the unattended WhatsApp drain because the scheduled child intentionally receives no Cloudflare deployment token"
    );
  }
  const nodePath = resolve(options.nodePath || process.execPath);
  const brainPath = resolve(options.brainPath || DEFAULT_BRAIN_PATH);
  const schedulerPath = resolve(options.schedulerPath || SELF_PATH);
  // The SAME payload the macOS drain hashes. A manifest edited after
  // installation must invalidate the scheduled child on both platforms
  // identically, or the two would disagree about the same install.
  const configHash = createHash("sha256")
    .update(JSON.stringify(WHATSAPP_DRAIN_SCHEDULER_SPEC.configHashPayloadOf({
      ...reference,
      brainPath,
      cron: WHATSAPP_DRAIN_SCHEDULER_SPEC.cronOf(reference.manifest),
    })))
    .digest("hex");
  return {
    ...reference,
    nodePath,
    brainPath,
    schedulerPath,
    configHash,
    command: nodePath,
    commandArguments: [schedulerPath, "run", reference.path, "--brain", brainPath, "--config-hash", configHash],
    workingDirectory: dirname(reference.path),
    expectedRefreshSeconds: reference.lane.expectedRefreshSeconds,
  };
}

/* ====================================================================== */
/*  The task definition                                                   */
/* ====================================================================== */

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Windows argument quoting for the single <Arguments> string the schema takes. */
function joinArguments(list) {
  return list
    .map((raw) => {
      const text = String(raw);
      return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
    })
    .join(" ");
}

/**
 * Render the Task Scheduler definition.
 *
 * EVERY SETTING BELOW THAT IS NOT A DEFAULT IS HERE BECAUSE ITS DEFAULT WOULD
 * QUIETLY BREAK A LAPTOP INSTALL:
 *
 *   DisallowStartIfOnBatteries and StopIfGoingOnBatteries both DEFAULT TO TRUE.
 *   Left alone, capture would refuse to start on a laptop running on battery
 *   and would stop the moment the charger came out — the single most likely
 *   way this would have failed in the field.
 *
 *   ExecutionTimeLimit defaults to three days, which would kill a resident
 *   daemon. PT0S is the schema's "no limit". The drain gets a real limit
 *   instead, because a wedged tick holding the IgnoreNew slot forever is worse
 *   than a killed one.
 *
 *   MultipleInstancesPolicy IgnoreNew is what turns the repetition trigger into
 *   a self-heal rather than a fork bomb, and it is the Windows replacement for
 *   the Mac single-instance lock.
 *
 *   StopOnIdleEnd defaults to true, which would stop capture when the client
 *   comes back to the keyboard.
 *
 *   A Repetition with no Duration means "indefinitely" in this schema. That is
 *   the actual restart mechanism: RestartOnFailure only fires on a non-zero
 *   exit, so a daemon that exits cleanly (or is killed) would never come back
 *   on that alone.
 *
 * The element order is the schema's own sequence, matching what Task Scheduler
 * emits when it exports a task. It is not alphabetical and it is not free: an
 * out-of-order element is rejected at registration.
 */
export function renderWindowsTaskXml(plan, mechanism = "task-logon") {
  const info = mechanismInfo(mechanism);
  const lane = plan.lane;
  const repetition =
    `      <Repetition>\n` +
    `        <Interval>PT${lane.repetitionMinutes}M</Interval>\n` +
    `        <StopAtDurationEnd>false</StopAtDurationEnd>\n` +
    `      </Repetition>\n`;
  // S4U runs without an interactive session, so it can also start at boot.
  // The logon trigger is kept alongside it so a machine that is already up when
  // the client signs in still starts capture without waiting for the next
  // repetition.
  const bootTrigger = info.survivesLogout
    ? `    <BootTrigger>\n      <Enabled>true</Enabled>\n${repetition}    </BootTrigger>\n`
    : "";
  const triggers =
    bootTrigger +
    `    <LogonTrigger>\n` +
    `      <Enabled>true</Enabled>\n` +
    `      <UserId>${xml(plan.identity)}</UserId>\n` +
    repetition +
    `    </LogonTrigger>\n`;
  const args = plan.commandArguments?.length
    ? `      <Arguments>${xml(joinArguments(plan.commandArguments))}</Arguments>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xml(plan.identity)}</Author>
    <Description>${xml(lane.description)}</Description>
    <URI>${xml(plan.taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
${triggers}  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(plan.identity)}</UserId>
      <LogonType>${info.survivesLogout ? "S4U" : "InteractiveToken"}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>${xml(lane.executionTimeLimit)}</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(plan.command)}</Command>
${args}      <WorkingDirectory>${xml(plan.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * The Startup-folder launcher, for the rung where no task can be registered.
 *
 * `start "" /b` detaches the process so the launcher itself exits immediately
 * rather than holding the logon script open. This is a launcher, not a
 * supervisor, and the comment at the top of the file it writes says so, because
 * the person who finds this file six months from now deserves to know it will
 * not restart anything.
 */
export function renderStartupCommand(plan) {
  const args = plan.commandArguments?.length ? ` ${joinArguments(plan.commandArguments)}` : "";
  return [
    "@echo off",
    "rem  Installed by the brain installer as a LAST-RESORT launcher.",
    "rem  It starts capture once, when you sign in. It does NOT restart it if it",
    "rem  stops. Windows Task Scheduler refused to register a task for this",
    "rem  account, which is the only reason this file exists.",
    `rem  Task that would have been used: ${plan.taskName}`,
    `cd /d "${plan.workingDirectory}"`,
    `start "" /b "${plan.command}"${args}`,
    "",
  ].join("\r\n");
}

/* ====================================================================== */
/*  Talking to Windows                                                    */
/* ====================================================================== */

function windowsChildEnvironment(environment = process.env) {
  const clean = { SystemRoot: systemRootOf(environment) };
  for (const name of WINDOWS_RUNTIME_ENV) {
    if (typeof environment?.[name] === "string" && environment[name]) clean[name] = environment[name];
  }
  return clean;
}

function defaultSchtasks(reference) {
  const command = join(reference.systemRoot, "System32", "schtasks.exe");
  const env = windowsChildEnvironment(process.env);
  return (args) =>
    spawnSync(command, args, {
      encoding: "utf-8",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    });
}

function schtasksDetail(result) {
  const text = String(result?.stderr || result?.stdout || "").trim();
  return text.split(/\r?\n/).filter(Boolean)[0] || `exit code ${result?.status ?? "unknown"}`;
}

/* ====================================================================== */
/*  Mechanism detection                                                   */
/* ====================================================================== */

/**
 * A definition that exercises exactly the privilege in question and does
 * nothing else if it ever ran: a disabled task whose action is the system's own
 * `cmd.exe /c exit`. It is deleted immediately either way.
 */
function probeXml(identity, logonType) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xml(identity)}</Author>
    <Description>Temporary capability probe written by the brain installer. Safe to delete.</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <UserId>${xml(identity)}</UserId>
      <LogonType>${logonType}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>false</AllowStartOnDemand>
    <Enabled>false</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c exit</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Find out what this account can actually register, by registering it.
 *
 * This is the open question the build spec flags, and it is answered by
 * observation rather than by a guess about what non-administrators are allowed
 * to do — because the answer varies with the machine's group policy, not with
 * the Windows version, and a wrong guess here would silently pick the wrong
 * supervision shape on a locked-down corporate laptop.
 *
 * Every probe is deleted, including on the failure path. A probe that could not
 * be deleted is reported rather than swallowed: a stray disabled task under the
 * product's own folder is harmless, but it is not something to leave unsaid.
 */
export function detectWindowsSupervisionMechanism(reference, options = {}) {
  const schtasks = options.schtasks || defaultSchtasks(reference);
  const writeStaged = options.writeStagedFile || stageProbeFile;
  const probes = [];
  const leftovers = [];

  for (const mechanism of options.consider || ["task-s4u", "task-logon"]) {
    const logonType = mechanismInfo(mechanism).survivesLogout ? "S4U" : "InteractiveToken";
    const name = `\\brain-installer\\probe-${randomBytes(8).toString("hex")}`;
    let staged = null;
    try {
      staged = writeStaged(reference, probeXml(reference.identity, logonType));
      const created = schtasks(["/Create", "/TN", name, "/XML", staged, "/F"]);
      if (created?.status === 0) {
        probes.push({ mechanism, available: true, detail: null });
        const deleted = schtasks(["/Delete", "/TN", name, "/F"]);
        if (deleted?.status !== 0) leftovers.push({ name, detail: schtasksDetail(deleted) });
        return {
          mechanism,
          info: mechanismInfo(mechanism),
          probes,
          leftovers,
          startupFolder: null,
        };
      }
      probes.push({ mechanism, available: false, detail: schtasksDetail(created) });
      // A create that failed can still have left a partial registration behind
      // on some Windows builds. Deleting is cheap and a failure to delete
      // something that was never created is expected, so it is not reported.
      schtasks(["/Delete", "/TN", name, "/F"]);
    } catch (error) {
      probes.push({ mechanism, available: false, detail: String(error?.message || error).slice(0, 200) });
    } finally {
      if (staged) { try { unlinkSync(staged); } catch { /* the probe result is what matters */ } }
    }
  }

  // No task could be registered. The Startup folder is the only rung left, and
  // it is a launcher rather than a supervisor — which is why the mechanism it
  // returns reports supervised:false rather than pretending otherwise.
  const startupFolder = options.startupFolder ?? startupFolderOf(options.env || process.env);
  if (startupFolder && existsSync(startupFolder)) {
    return {
      mechanism: "startup-folder",
      info: mechanismInfo("startup-folder"),
      probes,
      leftovers,
      startupFolder,
    };
  }
  return {
    mechanism: "none",
    info: mechanismInfo("none"),
    probes,
    leftovers,
    startupFolder: null,
  };
}

/* ====================================================================== */
/*  Private files                                                         */
/* ====================================================================== */

/**
 * Windows ignores the POSIX mode on mkdir, so the Mac module's chmod 0700 is
 * close to a no-op here. The WhatsApp session database in this directory holds
 * the linked-device identity and its encryption keys: possessing that file is
 * equivalent to reading the owner's WhatsApp. So the ACL is set explicitly,
 * inheritance is broken, and a failure to do it is fatal rather than a warning.
 */
export function assertPrivateWindowsDirectory(path, reference, options = {}) {
  mkdirSync(path, { recursive: true });
  const icacls = options.icacls || defaultIcacls(reference);
  const result = icacls([path, "/inheritance:r", "/grant:r", `${reference.identity}:(OI)(CI)F`]);
  if (result?.status !== 0 || result?.error) {
    throw new Error(
      `Windows would not restrict ${path} to this account (${schtasksDetail(result)}). ` +
        "The WhatsApp session database is credential-equivalent, so nothing was installed."
    );
  }
  return path;
}

function defaultIcacls(reference) {
  const command = join(reference.systemRoot, "System32", "icacls.exe");
  const env = windowsChildEnvironment(process.env);
  return (args) =>
    spawnSync(command, args, {
      encoding: "utf-8",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
}

function stageProbeFile(reference, text) {
  mkdirSync(reference.taskDir, { recursive: true });
  const path = join(reference.taskDir, `probe-${process.pid}-${randomBytes(6).toString("hex")}.xml`);
  // Task Scheduler reads /XML files as UTF-16LE when the declaration says so.
  writeFileSync(path, Buffer.from(`﻿${text}`, "utf16le"));
  return path;
}

/**
 * Stage-then-commit, the same shape the Mac module uses. The definition is
 * written and registered before anything existing is touched: `/Create /F`
 * replaces in place, so a disk or permission failure here leaves the previous
 * task running rather than leaving the owner with capture stopped and no
 * definition to start it again.
 */
function stageDefinition(reference, text) {
  mkdirSync(reference.taskDir, { recursive: true });
  const temp = `${reference.xmlPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, Buffer.from(`﻿${text}`, "utf16le"));
  let pending = true;
  return {
    path: temp,
    commit() {
      if (!pending) return;
      renameSync(temp, reference.xmlPath);
      pending = false;
    },
    discard() {
      if (!pending) return;
      pending = false;
      try { unlinkSync(temp); } catch { /* nothing to clean */ }
    },
  };
}

/**
 * Cap a log at the two moments the writer is provably stopped. Same policy
 * constants as the Mac scheduler; a different mechanism, because Windows has no
 * O_NOFOLLOW and truncating a file a resident process holds open produces a
 * sparse file that is larger, not smaller.
 */
export function capWindowsLog(path, { maxBytes = DRIVE_LOG_MAX_BYTES, historyFiles = DRIVE_LOG_HISTORY_FILES } = {}) {
  let size = 0;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { rotated: false, reason: "not a regular file" };
    size = st.size;
  } catch {
    return { rotated: false, reason: "no log yet" };
  }
  if (size <= maxBytes) return { rotated: false, size };
  for (let index = historyFiles; index >= 1; index--) {
    const older = `${path}.${index}`;
    if (index === historyFiles && existsSync(older)) { try { rmSync(older); } catch { /* replaced below */ } }
    const newer = index === 1 ? path : `${path}.${index - 1}`;
    if (existsSync(newer)) { try { renameSync(newer, older); } catch { /* best effort */ } }
  }
  return { rotated: true, size };
}

/* ====================================================================== */
/*  Install / status / remove                                             */
/* ====================================================================== */

function parseInstalledAction(definition) {
  const text = String(definition || "");
  const command = text.match(/<Command>([\s\S]*?)<\/Command>/)?.[1]?.trim() || null;
  const args = text.match(/<Arguments>([\s\S]*?)<\/Arguments>/)?.[1]?.trim() || "";
  return { command, args };
}

function unescapeXml(value) {
  return String(value)
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/** `schtasks /Query /FO LIST /V` in the words Windows actually prints. */
export function parseWindowsTaskStatus(output) {
  const text = String(output || "");
  const field = (name) => text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "mi"))?.[1] || null;
  const status = field("Status");
  const lastResultText = field("Last Result");
  const parsedResult = lastResultText === null ? null : Number(lastResultText);
  return {
    status,
    running: status === "Running",
    ready: status === "Ready",
    disabled: status === "Disabled",
    lastRunTime: field("Last Run Time"),
    nextRunTime: field("Next Run Time"),
    lastResult: Number.isFinite(parsedResult) ? parsedResult : null,
  };
}

/**
 * Install (or replace) supervision for one lane.
 *
 * Like the Mac daemon module and unlike the Mac tick scheduler, a RUNNING task
 * is replaced rather than refused: for a resident daemon, running is the normal
 * condition, and refusing would mean the operator has to stop capture in order
 * to fix capture.
 *
 * The mechanism is detected first and the result is part of the return value,
 * because everything downstream — whether a freshness expectation may be
 * posted, what the owner is told, what `brain sources` will say — depends on
 * which rung was actually installed rather than on which one was wanted.
 */
export function installWindowsSupervision(manifestPath, options = {}) {
  const plan = buildWindowsSupervisionPlan(manifestPath, options);
  const schtasks = options.schtasks || defaultSchtasks(plan);
  const detected = options.mechanism
    ? { mechanism: options.mechanism, info: mechanismInfo(options.mechanism), probes: [], leftovers: [], startupFolder: options.startupFolder ?? startupFolderOf(options.env || process.env) }
    : detectWindowsSupervisionMechanism(plan, { ...options, schtasks });

  mkdirSync(plan.logsDir, { recursive: true });
  mkdirSync(plan.taskDir, { recursive: true });
  assertPrivateWindowsDirectory(plan.dataDir, plan, options);
  capWindowsLog(plan.logPath, options.logLimits);

  if (detected.mechanism === "none") {
    return {
      ...plan,
      ...detected,
      installed: false,
      supervised: false,
      expectedRefreshSeconds: null,
      warnings: [
        "no Windows mechanism on this machine can keep a background process alive: Task Scheduler " +
          "refused a task for this account and there is no Startup folder to fall back to. Nothing " +
          "was installed, and nothing will claim capture is running.",
      ],
    };
  }

  if (detected.mechanism === "startup-folder") {
    // Not supervision. Install the launcher anyway, because a client who signs
    // in and gets capture is better off than one who gets a refusal — but
    // return supervised:false so no freshness expectation is ever posted for
    // it, and so the source reports itself as having no refresh scheduled.
    if (!plan.lane.resident) {
      return {
        ...plan,
        ...detected,
        installed: false,
        supervised: false,
        expectedRefreshSeconds: null,
        warnings: [
          "the WhatsApp drain cannot run from the Startup folder: it has to run every minute, and a " +
            "Startup-folder launcher runs once. Captured messages will collect in the local outbox on " +
            "this PC and reach the brain only when `brain ingest <manifest> --from whatsapp` is run.",
        ],
      };
    }
    if (!detected.startupFolder) {
      throw new Error(
        "the Startup-folder fallback was selected but Windows did not report an APPDATA location, " +
          "so there is nowhere to put the launcher. Nothing was installed."
      );
    }
    const startupPath = join(detected.startupFolder, `brain-${plan.slug}-${plan.kind}.cmd`);
    const text = renderStartupCommand(plan);
    const temp = `${startupPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, text, "utf-8");
    try {
      renameSync(temp, startupPath);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* the original error wins */ }
      throw new Error(`writing the Startup-folder launcher failed: ${error.message}`);
    }
    writeFileSync(plan.startupCommandPath, text, "utf-8");
    return {
      ...plan,
      ...detected,
      installed: true,
      supervised: false,
      startupPath,
      expectedRefreshSeconds: null,
      warnings: [
        "Windows would not register a Scheduled Task for this account, so capture was installed as a " +
          "Startup-folder launcher. It starts when you sign in and it will NOT restart if it stops. " +
          "No freshness expectation was set, so this source reports that nothing is scheduled to " +
          "refresh it rather than reporting itself as live.",
      ],
    };
  }

  const definition = renderWindowsTaskXml(plan, detected.mechanism);
  const priorQuery = schtasks(["/Query", "/TN", plan.taskName, "/XML", "ONE"]);
  const priorDefinition = priorQuery?.status === 0 ? String(priorQuery.stdout || "") : null;

  const staged = stageDefinition(plan, definition);
  let created;
  try {
    created = schtasks(["/Create", "/TN", plan.taskName, "/XML", staged.path, "/F"]);
  } catch (error) {
    staged.discard();
    throw error;
  }
  if (created?.status !== 0 || created?.error) {
    staged.discard();
    throw new Error(
      `registering the ${plan.lane.noun} Scheduled Task failed: ${schtasksDetail(created)}. ` +
        (priorDefinition ? "The previous task was left in place and is still running." : "Nothing was installed.")
    );
  }

  // Registration reporting success is not proof the definition took. Read it
  // back and compare the one thing that decides what actually runs.
  const verify = schtasks(["/Query", "/TN", plan.taskName, "/XML", "ONE"]);
  const readBack = verify?.status === 0 ? parseInstalledAction(verify.stdout) : null;
  const wanted = parseInstalledAction(definition);
  const verified = Boolean(readBack) &&
    unescapeXml(readBack.command || "") === unescapeXml(wanted.command || "") &&
    unescapeXml(readBack.args || "") === unescapeXml(wanted.args || "");
  if (!verified) {
    staged.discard();
    const restored = restorePriorTask(plan, priorDefinition, schtasks, options);
    throw new Error(
      `Windows accepted the ${plan.lane.noun} task but read it back with a different action, so it was not trusted` +
        (readBack ? "" : ` (${schtasksDetail(verify)})`) +
        `. ${restored}`
    );
  }
  staged.commit();

  // Start it now. A logon-triggered task would otherwise not run until the next
  // sign-in, which would leave capture off for the rest of the day.
  const started = schtasks(["/Run", "/TN", plan.taskName]);
  const warnings = [];
  if (started?.status !== 0) {
    warnings.push(
      `the ${plan.lane.noun} task is registered but Windows would not start it now (${schtasksDetail(started)}); ` +
        "it will start at the next sign-in."
    );
  }
  for (const stray of detected.leftovers || []) {
    warnings.push(`a capability probe task could not be deleted and is still registered: ${stray.name} (${stray.detail})`);
  }
  if (detected.info.visibleConsole) {
    warnings.push(
      "this rung runs in your signed-in session, so each background process shows a console window. " +
        "Minimise it; closing it stops that process until the next restart."
    );
  }
  if (!detected.info.survivesLogout) {
    warnings.push("capture runs while you are signed in to this PC and stops when you sign out.");
  }
  return {
    ...plan,
    ...detected,
    installed: true,
    supervised: true,
    replaced: priorDefinition !== null,
    started: started?.status === 0,
    expectedRefreshSeconds: plan.lane.expectedRefreshSeconds,
    warnings,
  };
}

function restorePriorTask(plan, priorDefinition, schtasks, options = {}) {
  if (priorDefinition === null) {
    const removed = schtasks(["/Delete", "/TN", plan.taskName, "/F"]);
    return removed?.status === 0
      ? "The task it registered was deleted, so nothing was left behind."
      : `The task it registered could NOT be deleted (${schtasksDetail(removed)}); remove ${plan.taskName} by hand.`;
  }
  let staged = null;
  try {
    staged = stageDefinition(plan, priorDefinition);
    const restored = schtasks(["/Create", "/TN", plan.taskName, "/XML", staged.path, "/F"]);
    staged.discard();
    return restored?.status === 0
      ? "The previous task was put back."
      : `The previous task could NOT be put back (${schtasksDetail(restored)}); capture is stopped until this is reinstalled.`;
  } catch (error) {
    if (staged) staged.discard();
    return `The previous task could NOT be put back (${String(error?.message || error).slice(0, 160)}).`;
  }
}

export function statusWindowsSupervision(manifestPath, options = {}) {
  const reference = windowsSupervisionReference(manifestPath, options);
  const schtasks = options.schtasks || defaultSchtasks(reference);
  const query = schtasks(["/Query", "/TN", reference.taskName, "/XML", "ONE"]);
  const installed = query?.status === 0;
  const definition = installed ? String(query.stdout || "") : null;

  let planError = null;
  let plan = reference;
  try { plan = buildWindowsSupervisionPlan(manifestPath, options); } catch (error) { planError = error.message; }

  // Which rung is installed is read from the definition itself, not from what
  // detection would choose today: a task registered as S4U months ago must not
  // be re-described as interactive because the probe now fails.
  const mechanism = definition
    ? (/<LogonType>S4U<\/LogonType>/.test(definition) ? "task-s4u" : "task-logon")
    : null;

  const startupPath = options.startupFolder ?? startupFolderOf(options.env || process.env);
  const startupLauncher = startupPath
    ? join(startupPath, `brain-${reference.slug}-${reference.kind}.cmd`)
    : null;
  const startupInstalled = Boolean(startupLauncher && existsSync(startupLauncher));

  let definitionMatches = false;
  if (installed && !planError && mechanism) {
    const wanted = parseInstalledAction(renderWindowsTaskXml(plan, mechanism));
    const found = parseInstalledAction(definition);
    definitionMatches =
      unescapeXml(found.command || "") === unescapeXml(wanted.command || "") &&
      unescapeXml(found.args || "") === unescapeXml(wanted.args || "");
  }

  const list = installed ? schtasks(["/Query", "/TN", reference.taskName, "/FO", "LIST", "/V"]) : null;
  const live = list?.status === 0 ? parseWindowsTaskStatus(list.stdout) : {
    status: null, running: false, ready: false, disabled: false,
    lastRunTime: null, nextRunTime: null, lastResult: null,
  };

  const info = mechanismInfo(mechanism || (startupInstalled ? "startup-folder" : "none"));
  return {
    ...plan,
    installed: installed || startupInstalled,
    taskInstalled: installed,
    startupInstalled,
    startupPath: startupLauncher,
    mechanism: mechanism || (startupInstalled ? "startup-folder" : "none"),
    info,
    // The whole honesty contract in one boolean: a task that exists but is
    // disabled is not supervision, and neither is a Startup-folder launcher.
    supervised: Boolean(installed && info.supervised && !live.disabled),
    planError,
    definitionMatches,
    definitionDrift: installed && !definitionMatches,
    outboxExists: existsSync(plan.outboxPath),
    pairedSessionExists: existsSync(plan.sessionDbPath),
    ...live,
  };
}

/**
 * Stop supervision and remove every artifact of it.
 *
 * Reachable when the corpus flag is already off, when the daemon binary has
 * been deleted, and when detection would now choose a different rung — the same
 * posture the Mac removals take, and for the same reason: requiring the
 * operator to re-declare the thing they are switching off would strand a task
 * that is still running.
 *
 * Removal is VERIFIED. `schtasks /Delete` reporting success and the task still
 * being there is exactly the shape of failure this product refuses to call
 * done, so the task is queried again afterwards and a survivor is an error.
 *
 * Both rungs are cleaned up regardless of which one is in use, so a machine
 * that was moved from a Startup-folder launcher to a task never ends up with
 * two things starting the daemon.
 */
export function removeWindowsSupervision(manifestPath, options = {}) {
  const reference = windowsSupervisionReference(manifestPath, options);
  const schtasks = options.schtasks || defaultSchtasks(reference);
  const probe = schtasks(["/Query", "/TN", reference.taskName, "/XML", "ONE"]);
  const wasInstalled = probe?.status === 0;
  const failures = [];

  if (wasInstalled) {
    // Best effort: /End fails when no instance is running, which is normal.
    schtasks(["/End", "/TN", reference.taskName]);
    const deleted = schtasks(["/Delete", "/TN", reference.taskName, "/F"]);
    if (deleted?.status !== 0) {
      throw new Error(`stopping the ${reference.lane.noun} Scheduled Task failed: ${schtasksDetail(deleted)}`);
    }
    const after = schtasks(["/Query", "/TN", reference.taskName, "/XML", "ONE"]);
    if (after?.status === 0) {
      throw new Error(
        `Windows reported the ${reference.lane.noun} task deleted, but it is still registered as ` +
          `${reference.taskName}. Capture may still be running; remove it in Task Scheduler.`
      );
    }
  }

  const startupPath = options.startupFolder ?? startupFolderOf(options.env || process.env);
  const startupLauncher = startupPath
    ? join(startupPath, `brain-${reference.slug}-${reference.kind}.cmd`)
    : null;
  let startupRemoved = false;
  if (startupLauncher && existsSync(startupLauncher)) {
    try {
      unlinkSync(startupLauncher);
      startupRemoved = !existsSync(startupLauncher);
      if (!startupRemoved) failures.push(`the Startup-folder launcher is still present at ${startupLauncher}`);
    } catch (error) {
      failures.push(`the Startup-folder launcher could not be deleted (${error.message}): ${startupLauncher}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));

  for (const path of [reference.xmlPath, reference.startupCommandPath]) {
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* a stale copy is not a failure */ } }
  }
  // The writer is provably stopped now, which is the only honest moment to cap
  // its log. The log itself is deliberately kept: it is what support reads
  // after a client says capture stopped.
  capWindowsLog(reference.logPath, options.logLimits);

  return {
    ...reference,
    installed: false,
    supervised: false,
    removed: wasInstalled || startupRemoved,
    wasInstalled,
    startupRemoved,
    logPreserved: existsSync(reference.logPath) ? reference.logPath : null,
  };
}

/* ====================================================================== */
/*  The drain tick child                                                  */
/* ====================================================================== */

/**
 * What the drain task actually runs.
 *
 * Task Scheduler hands a child the full interactive environment and cannot
 * redirect its output, so this wrapper supplies both of the things the Mac
 * runner gets for free: a scrubbed child environment, and a log the run is
 * appended to and capped against. What it deliberately does NOT reimplement is
 * the single-instance lock — MultipleInstancesPolicy IgnoreNew is Windows's own
 * version of it, applied by the scheduler before this process ever starts.
 *
 * The config-hash guard is kept verbatim in spirit and in payload: a task
 * installed against one manifest state must refuse to read credentials for a
 * manifest that has since been edited.
 */
export function runWindowsDrain(manifestPath, options = {}) {
  const plan = buildWindowsSupervisionPlan(manifestPath, { ...options, kind: "whatsapp-drain" });
  if (options.expectedConfigHash && options.expectedConfigHash !== plan.configHash) {
    throw new Error(WHATSAPP_DRAIN_SCHEDULER_SPEC.configChangedError);
  }
  const spawn = options.spawn || spawnSync;
  const startedAt = new Date().toISOString();
  mkdirSync(plan.logsDir, { recursive: true });
  const result = spawn(
    plan.nodePath,
    [plan.brainPath, ...WHATSAPP_DRAIN_SCHEDULER_SPEC.childArgumentsOf(plan)],
    {
      cwd: plan.workingDirectory,
      env: windowsChildEnvironment(options.env || process.env),
      encoding: "utf-8",
      // Never accept a pipe as an unattended key source, and never hand the
      // admin key to this process: the brain child resolves its own
      // manifest-declared DPAPI or owner-only file.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: options.timeoutMs ?? 9 * 60_000,
    }
  );
  if (result?.error) throw result.error;
  const code = Number.isInteger(result?.status) ? result.status : 1;
  const transcript =
    `[${startedAt}] whatsapp drain start\n` +
    String(result?.stdout || "") +
    String(result?.stderr || "") +
    `[${new Date().toISOString()}] whatsapp drain exit ${code}\n`;
  try {
    writeFileSync(plan.logPath, transcript, { flag: "a" });
  } catch { /* a log that cannot be written must not fail the drain */ }
  // The child has exited, so nothing holds the log open.
  capWindowsLog(plan.logPath, options.logLimits);
  return {
    ...plan,
    status: code === 0 ? "complete" : "failed",
    code,
    signal: result?.signal || null,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/* ====================================================================== */
/*  CLI                                                                   */
/* ====================================================================== */

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath] = argv;
  if (!command || !manifestPath || !["install", "status", "remove", "run", "detect"].includes(command)) {
    console.log(
      "usage: node operations/windows-supervision.mjs <install|status|remove|detect> <manifest> [--kind whatsapp-daemon|whatsapp-drain] [--daemon <binary>]\n" +
      "       node operations/windows-supervision.mjs run <manifest> --brain <brain.mjs> --config-hash <hash>"
    );
    return 1;
  }
  const kind = optionValue(argv, "--kind") || "whatsapp-daemon";
  const options = {
    kind,
    binaryPath: optionValue(argv, "--daemon") || undefined,
    brainPath: optionValue(argv, "--brain") || undefined,
    expectedConfigHash: optionValue(argv, "--config-hash") || undefined,
  };
  if (command === "run") {
    const result = runWindowsDrain(manifestPath, options);
    console.log(`[${new Date().toISOString()}] WhatsApp drain ${result.status}`);
    return result.code;
  }
  if (command === "detect") {
    const detected = detectWindowsSupervisionMechanism(windowsSupervisionReference(manifestPath, options), options);
    console.log(JSON.stringify({
      mechanism: detected.mechanism,
      supervised: detected.info.supervised,
      probes: detected.probes,
      disclosure: mechanismDisclosure(detected.mechanism),
    }, null, 2));
    return 0;
  }
  const result = command === "install"
    ? installWindowsSupervision(manifestPath, options)
    : command === "status"
      ? statusWindowsSupervision(manifestPath, options)
      : removeWindowsSupervision(manifestPath, options);
  console.log(JSON.stringify({
    label: result.label,
    manifest: result.path,
    kind: result.kind,
    mechanism: result.mechanism ?? null,
    task: result.taskName,
    installed: result.installed,
    supervised: result.supervised ?? null,
    running: result.running ?? null,
    data_dir: result.dataDir,
    log: result.logPath,
  }, null, 2));
  for (const warning of result.warnings || []) console.log(`warning: ${warning}`);
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === SELF_PATH;
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Windows supervision failed: ${error.message}`);
    process.exitCode = 1;
  });
}
