#!/usr/bin/env node
/**
 * Supervision for the WhatsApp capture daemon — a RESIDENT process, which is a
 * different animal from everything else this installer schedules.
 *
 * WHY THIS IS A SIBLING MODULE AND NOT A FLAG ON THE TICK SCHEDULER.
 * `operations/drive-scheduler.mjs` is a hardened generator for run-to-completion
 * jobs: launchd fires a short child on a calendar interval, the child takes a
 * lockf single-instance lock, does one pass, and exits. `brain connect
 * imessage` reuses it verbatim. Three of the behaviours that make it safe are
 * actively WRONG for a process whose steady state is "running":
 *
 *   1. Install refuses to replace a scheduler while its job is running,
 *      because for a tick that means a pass is mid-flight. For a daemon,
 *      running is the normal condition and refusing would make reinstall
 *      unreachable — the operator would have to stop capture to fix capture.
 *   2. Log rotation truncates the log in place. That is correct once the
 *      writer has exited; against a resident process holding the file open at
 *      its own offset it produces a sparse file that is larger, not smaller.
 *   3. The lockf wrapper enforces one instance at a time. Under KeepAlive that
 *      is launchd's own job, and a lock the daemon never releases would fight
 *      the very restarts KeepAlive exists to perform.
 *
 * Threading a "shape" flag through each of those would turn three invariants
 * into three conditionals in the code path that keeps unattended Drive and
 * iMessage ingest safe. So the tick model is left exactly as it is, and this
 * module owns the persistent shape: RunAtLoad plus unconditional KeepAlive, no
 * calendar intervals, no lock, and log capping only at the two moments the
 * process is provably stopped (install, before bootstrap; remove, after
 * bootout). What IS shared is reused rather than re-typed: the label and path
 * conventions (`schedulerIdentity`), the log rotation itself
 * (`rotateDriveSchedulerLogs`), and the launchctl environment scrub.
 *
 * BETWEEN INSTALL AND REMOVAL THE DAEMON'S LOG IS NOT ROTATED, and this file
 * would rather say so than pretend otherwise. See point 2 above for why the
 * usual mechanism cannot honestly be applied to an open file.
 *
 * NO CREDENTIALS REACH THIS PROCESS. The daemon writes two local SQLite files
 * and talks to WhatsApp. It holds no admin key, no Cloudflare token, and no
 * brain domain; the Node-side drain, running as an ordinary scheduled tick, is
 * what talks to the client's worker. The plist carries WA_DATA_DIR and the OS
 * basics, and a test asserts nothing else appears in it.
 *
 * macOS ONLY, STATED RATHER THAN IMPLIED. Windows service or Startup-task
 * supervision is NOT built. No Windows process-supervision pattern exists
 * anywhere in this repo to follow, and inventing one deserves its own design
 * pass rather than a guess bolted onto this package.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  launchctlChildEnvironment,
  printSchedulerFailureReceipt,
  recordDriveSchedulerFailure,
  rotateDriveSchedulerLogs,
  schedulerIdentity,
} from "./drive-scheduler.mjs";
import {
  daemonEnvironment,
  defaultDataDir,
  outboxPathFor,
  resolveDaemonBinary,
  sessionDbPathFor,
} from "../connectors/whatsapp.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Only `kind` is read by the shared identity helper; the rest is here so error
 * messages and status output can name this thing the way an owner would.
 */
export const WHATSAPP_DAEMON_SPEC = Object.freeze({
  kind: "whatsapp-daemon",
  schedulerNoun: "WhatsApp capture daemon",
  activityNoun: "WhatsApp capture",
});

/**
 * launchd's restart backoff. A daemon that cannot start (missing binary, a
 * revoked session) would otherwise spin; thirty seconds keeps a broken install
 * from burning a laptop battery while still recovering quickly from a genuine
 * crash or a network drop.
 */
export const WHATSAPP_DAEMON_THROTTLE_SECONDS = 30;

function assertMac(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error(
      `the WhatsApp capture daemon is supervised with a macOS LaunchAgent; this machine reports ${platform}. ` +
        "Windows service supervision is not built."
    );
  }
}

/**
 * Identity and paths, with no requirement that the corpus is enabled or that a
 * binary exists — removal has to stay reachable after either becomes untrue.
 */
export function whatsappDaemonReference(manifestPath, options = {}) {
  assertMac(options.platform);
  const identity = schedulerIdentity(manifestPath, { ...options, spec: WHATSAPP_DAEMON_SPEC });
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isInteger(uid) || uid < 0) throw new Error("could not determine the macOS user id for launchd");
  // One resolution order, shared with the drain in brain.mjs: an explicit
  // option, then the manifest knob, then the per-install default. The daemon
  // writing one directory while the drain reads another is the single most
  // silent way this connector could fail, so both halves read the same knob.
  const configured = identity.manifest?.operations?.whatsapp_data_dir;
  const dataDir = options.dataDir
    ? resolve(options.dataDir)
    : configured
      ? resolve(String(configured))
      : defaultDataDir(identity.slug, identity.home);
  return {
    ...identity,
    uid,
    domain: `gui/${uid}`,
    service: `gui/${uid}/${identity.label}`,
    dataDir,
    outboxPath: outboxPathFor(dataDir),
    sessionDbPath: sessionDbPathFor(dataDir),
  };
}

/**
 * The installable plan: the corpus must be declared and the binary must exist,
 * because a LaunchAgent pointed at a missing executable is a job that fails
 * every thirty seconds forever while reporting itself installed.
 */
export function buildWhatsappDaemonPlan(manifestPath, options = {}) {
  const reference = whatsappDaemonReference(manifestPath, options);
  if (reference.manifest?.corpora?.whatsapp?.enabled !== true) {
    throw new Error("corpora.whatsapp.enabled must be true before the WhatsApp capture daemon can be installed");
  }
  const binary = options.binaryPath
    ? { path: resolve(options.binaryPath), source: "supplied" }
    : resolveDaemonBinary({
      env: options.env,
      manifest: reference.manifest,
      platform: options.platform || process.platform,
      arch: options.arch,
    });
  return {
    ...reference,
    binaryPath: binary.path,
    binarySource: binary.source,
    programArguments: [binary.path],
    environment: daemonEnvironment(options.daemonEnv || { HOME: reference.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, reference.dataDir),
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderDaemonPlist(plan) {
  const args = plan.programArguments.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  const environment = Object.entries(plan.environment)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `      <key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(plan.dataDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${WHATSAPP_DAEMON_THROTTLE_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(plan.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(plan.stderrPath)}</string>
</dict>
</plist>
`;
}

function stageAtomicWrite(path, text) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* the original error wins */ }
    throw error;
  }
  let pending = true;
  return {
    commit() {
      if (!pending) return;
      renameSync(temp, path);
      pending = false;
    },
    discard() {
      if (!pending) return;
      pending = false;
      try { unlinkSync(temp); } catch { /* nothing to clean */ }
    },
  };
}

function defaultLaunchctl(args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf-8", env: launchctlChildEnvironment() });
}

function launchctlError(action, result) {
  const detail = String(result?.stderr || result?.stdout || "unknown launchctl failure").trim();
  return new Error(`${action} failed: ${detail}`);
}

export function parseDaemonStatus(output) {
  const text = String(output || "");
  const state = text.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() || null;
  const pidText = text.match(/\bpid\s*=\s*(\d+)/)?.[1];
  const runsText = text.match(/\bruns\s*=\s*(\d+)/)?.[1];
  const exitText = text.match(/\blast exit code\s*=\s*(-?\d+)/i)?.[1];
  const lastExitCode = exitText === undefined ? null : Number(exitText);
  return {
    state,
    pid: pidText ? Number(pidText) : null,
    running: state === "running",
    runs: runsText ? Number(runsText) : null,
    lastExitCode,
  };
}

function assertPrivateDataDirectory(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dataDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`the WhatsApp data path is not a private directory: ${dataDir}`);
  }
  chmodSync(dataDir, 0o700);
}

function restorePrevious(plan, priorPlist, wasLoaded, launchctl) {
  const failures = [];
  try {
    const current = launchctl(["print", plan.service]);
    if (current?.status === 0) {
      const stopped = launchctl(["bootout", plan.service]);
      if (stopped?.status !== 0) failures.push(launchctlError("unloading the failed replacement", stopped).message);
    }
  } catch (error) {
    failures.push(`checking the failed replacement failed: ${error.message}`);
  }
  try {
    if (priorPlist === null) {
      if (existsSync(plan.plistPath)) unlinkSync(plan.plistPath);
    } else {
      const staged = stageAtomicWrite(plan.plistPath, priorPlist);
      try { staged.commit(); } finally { staged.discard(); }
    }
  } catch (error) {
    failures.push(`restoring the previous definition failed: ${error.message}`);
  }
  if (wasLoaded && priorPlist !== null && failures.length === 0) {
    const restored = launchctl(["bootstrap", plan.domain, plan.plistPath]);
    if (restored?.status !== 0) failures.push(launchctlError("reloading the previous capture daemon", restored).message);
  }
  return failures;
}

function failedReplacement(action, result, plan, priorPlist, wasLoaded, launchctl) {
  const primary = launchctlError(action, result);
  const rollbackFailures = restorePrevious(plan, priorPlist, wasLoaded, launchctl);
  if (rollbackFailures.length) {
    throw new Error(`${primary.message}; rollback also failed: ${rollbackFailures.join("; ")}`);
  }
  throw primary;
}

/**
 * Install (or replace) the capture daemon's LaunchAgent.
 *
 * Unlike the tick scheduler, a RUNNING job is stopped and replaced rather than
 * refused: a resident daemon is always running when healthy, so refusing would
 * make every reinstall unreachable. The definition is staged and permission-
 * capped before anything is unloaded, so a disk or permissions failure cannot
 * leave the owner with capture stopped and no plist to start again.
 */
export function installWhatsappDaemon(manifestPath, options = {}) {
  const plan = buildWhatsappDaemonPlan(manifestPath, options);
  const launchctl = options.launchctl || defaultLaunchctl;
  mkdirSync(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
  assertPrivateDataDirectory(plan.dataDir);

  const priorPlist = existsSync(plan.plistPath) ? readFileSync(plan.plistPath, "utf-8") : null;
  const stagePlist = options.stagePlist || stageAtomicWrite;
  const staged = stagePlist(plan.plistPath, renderDaemonPlist(plan));

  let priorStatus;
  try {
    priorStatus = launchctl(["print", plan.service]);
  } catch (error) {
    staged.discard();
    throw error;
  }
  if (priorStatus?.error) {
    staged.discard();
    throw launchctlError("checking the existing WhatsApp capture daemon", priorStatus);
  }
  const wasLoaded = priorStatus?.status === 0;
  if (wasLoaded) {
    const stopped = launchctl(["bootout", plan.service]);
    if (stopped?.status !== 0) {
      staged.discard();
      throw launchctlError("stopping the previous WhatsApp capture daemon", stopped);
    }
  }
  // The daemon is provably stopped here (either it was never loaded, or the
  // bootout above succeeded), which is the only honest moment to cap its log.
  try {
    rotateDriveSchedulerLogs(plan, options);
  } catch (error) {
    staged.discard();
    const rollbackFailures = restorePrevious(plan, priorPlist, wasLoaded, launchctl);
    if (rollbackFailures.length) {
      throw new Error(`capping the daemon log failed: ${error.message}; rollback also failed: ${rollbackFailures.join("; ")}`);
    }
    throw error;
  }

  try {
    staged.commit();
  } catch (error) {
    staged.discard();
    const rollbackFailures = restorePrevious(plan, priorPlist, wasLoaded, launchctl);
    if (rollbackFailures.length) {
      throw new Error(`writing the staged daemon definition failed: ${error.message}; rollback also failed: ${rollbackFailures.join("; ")}`);
    }
    throw new Error(`writing the staged daemon definition failed: ${error.message}`);
  }
  const enabled = launchctl(["enable", plan.service]);
  if (enabled?.status !== 0) {
    failedReplacement("enabling the WhatsApp capture daemon", enabled, plan, priorPlist, wasLoaded, launchctl);
  }
  const started = launchctl(["bootstrap", plan.domain, plan.plistPath]);
  if (started?.status !== 0) {
    failedReplacement("loading the WhatsApp capture daemon", started, plan, priorPlist, wasLoaded, launchctl);
  }
  return { ...plan, installed: true, loaded: true, replaced: priorPlist !== null };
}

export function statusWhatsappDaemon(manifestPath, options = {}) {
  const reference = whatsappDaemonReference(manifestPath, options);
  const launchctl = options.launchctl || defaultLaunchctl;
  const result = launchctl(["print", reference.service]);
  const loaded = result?.status === 0;
  let planError = null;
  let plan = reference;
  try { plan = buildWhatsappDaemonPlan(manifestPath, options); } catch (error) { planError = error.message; }
  const installed = existsSync(plan.plistPath);
  let definitionMatches = false;
  if (installed && !planError) {
    try { definitionMatches = readFileSync(plan.plistPath, "utf-8") === renderDaemonPlist(plan); } catch { /* reported as drift */ }
  }
  return {
    ...plan,
    installed,
    loaded,
    planError,
    definitionMatches,
    definitionDrift: installed && !definitionMatches,
    outboxExists: existsSync(plan.outboxPath),
    pairedSessionExists: existsSync(plan.sessionDbPath),
    ...(loaded ? parseDaemonStatus(result.stdout) : { state: null, pid: null, running: false, runs: null, lastExitCode: null }),
  };
}

/**
 * Stop the daemon and remove its definition. Reachable when the corpus flag is
 * already off and when the binary is gone — the removeDriveScheduler reasoning:
 * requiring the operator to first re-declare what they are turning off would
 * strand an already-loaded LaunchAgent forever.
 *
 * The two SQLite files are deliberately left in place. Deleting the session
 * store un-pairs the account, and deleting the outbox throws away messages the
 * drain may not have loaded yet; neither belongs in a command whose job is to
 * stop a process.
 */
export function removeWhatsappDaemon(manifestPath, options = {}) {
  const plan = whatsappDaemonReference(manifestPath, options);
  const launchctl = options.launchctl || defaultLaunchctl;
  const probe = launchctl(["print", plan.service]);
  const wasLoaded = probe?.status === 0;
  if (wasLoaded) {
    const stopped = launchctl(["bootout", plan.service]);
    if (stopped?.status !== 0) throw launchctlError("stopping the WhatsApp capture daemon", stopped);
  }
  const retained = rotateDriveSchedulerLogs(plan, options);
  const removed = existsSync(plan.plistPath);
  if (removed) unlinkSync(plan.plistPath);
  return {
    ...plan,
    installed: false,
    loaded: false,
    removed,
    wasLoaded,
    logsPreserved: retained.flatMap((entry) => [entry.path, ...entry.history].filter((path) => existsSync(path))),
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath] = argv;
  if (!command || !manifestPath || !["install", "status", "remove"].includes(command)) {
    console.log("usage: node operations/whatsapp-daemon.mjs <install|status|remove> <manifest> [--daemon <binary>]");
    return 1;
  }
  const options = { binaryPath: optionValue(argv, "--daemon") || undefined };
  const result = command === "install"
    ? installWhatsappDaemon(manifestPath, options)
    : command === "status"
      ? statusWhatsappDaemon(manifestPath, options)
      : removeWhatsappDaemon(manifestPath, options);
  console.log(JSON.stringify({
    label: result.label,
    manifest: result.path,
    binary: result.binaryPath || null,
    data_dir: result.dataDir,
    installed: result.installed,
    loaded: result.loaded,
    running: result.running ?? null,
    plist: result.plistPath,
    stdout_log: result.stdoutPath,
    stderr_log: result.stderrPath,
  }, null, 2));
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === SELF_PATH;
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    const action = process.argv[2];
    const eventId = recordDriveSchedulerFailure(error, {
      action,
      productRelativeLocation: "operations/whatsapp-daemon.mjs#main",
    });
    printSchedulerFailureReceipt({
      schedulerNoun: "WhatsApp capture supervision",
      action,
      eventId,
    });
    process.exitCode = 1;
  });
}
