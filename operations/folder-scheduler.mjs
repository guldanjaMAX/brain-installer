#!/usr/bin/env node
/**
 * The watched folder — a local directory that reloads itself on a schedule,
 * the third consumer of the generalized connector scheduler in
 * operations/drive-scheduler.mjs.
 *
 * WHY THIS EXISTS. The documentation repeatedly tells a client to "drop it in
 * a folder you already ingest": a WhatsApp export, an SMS backup, a Google
 * Voice takeout, a saved meeting transcript, a mail archive. That sentence was
 * only true if the folder happened to live inside Google Drive, because Drive
 * was the only source that refreshed itself. Everywhere else "already ingest"
 * meant "remember to re-run a command by hand, forever", and the moment the
 * client stops doing that their brain quietly stops matching their world while
 * continuing to answer confidently from what it has.
 *
 * SHAPE: short scheduled ticks, not a resident daemon — the same launchd
 * pattern the iMessage lane proved. Each tick takes the native lockf
 * single-instance lock, runs ONE `brain ingest <manifest> --path <folder>`
 * pass, and exits. A tick that finds a large backlog holds the lock while it
 * pages through it; the next ticks exit immediately with the lock-busy code.
 *
 * NOTHING NEW IS INVENTED ABOUT WHAT HAS ALREADY BEEN LOADED. The tick runs
 * the ordinary local ingest, so it reuses that command's content-hash resume
 * state exactly: a file added since the last tick is new, a file whose bytes
 * changed is re-sent, an unchanged file costs one read, and a file that is
 * gone is reconciled through the same removal plan and the same aggregate
 * safety limits every other source uses.
 *
 * The plist contains no credentials and the child environment is scrubbed the
 * same way Drive's and iMessage's are.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSchedulerPlan,
  installScheduler,
  recordDriveSchedulerFailure,
  recordDriveSchedulerResult,
  removeScheduler,
  runScheduledIngest,
  safeIngestEnvironment,
  statusScheduler,
} from "./drive-scheduler.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Hourly. A watched folder is where a person drops an export they just made,
 * not a live message feed, so a minute-by-minute walk of a large tree would
 * spend far more of the client's machine than the freshness is worth.
 */
export const FOLDER_INGEST_DEFAULT_CRON = "0 * * * *";

/** The source name a watched folder loads under when the manifest is silent. */
export const FOLDER_DEFAULT_SOURCE = "documents";

const FOLDER_SOURCE_RE = /^[a-z0-9][a-z0-9_-]*$/;

const FOLDER_CRON_LABELS = Object.freeze({
  key: "operations.folder_ingest_cron",
  noun: "watched folder ingest cron",
});

const folderConfigOf = (manifest) => manifest?.corpora?.local_folder || {};

export const FOLDER_SCHEDULER_SPEC = Object.freeze({
  kind: "folder-ingest",
  schedulerNoun: "watched folder scheduler",
  activityNoun: "watched folder ingest",
  cronLabels: FOLDER_CRON_LABELS,
  cronOf: (manifest) => manifest?.operations?.folder_ingest_cron || FOLDER_INGEST_DEFAULT_CRON,
  cronMissingError:
    "the manifest needs operations.folder_ingest_cron (or the built-in hourly default) before the watched folder scheduler can be installed",
  requireEnabled(manifest) {
    if (folderConfigOf(manifest).enabled !== true) {
      throw new Error("corpora.local_folder.enabled must be true before its scheduler can be installed");
    }
  },
  domainMissingError:
    "brain.domain is required for unattended folder ingest because the scheduled child intentionally receives no Cloudflare deployment token",
  platformError: (platform) =>
    `unattended folder scheduling is currently implemented with macOS LaunchAgents; this machine reports ${platform}`,
  defaultSchedulerPath: () => SELF_PATH,
  referenceExtrasOf: (manifest) => ({
    folderPath: String(folderConfigOf(manifest).path || ""),
    folderSource: String(folderConfigOf(manifest).source || FOLDER_DEFAULT_SOURCE),
  }),
  validateExtras(reference) {
    const path = reference.folderPath;
    if (!path) {
      throw new Error("corpora.local_folder.path must name the folder to watch");
    }
    // Relative to WHAT? A LaunchAgent's working directory is not the client's
    // shell, so a relative path would resolve somewhere neither of us
    // intended, and the lane would silently watch the wrong tree.
    if (!isAbsolute(path)) {
      throw new Error(`corpora.local_folder.path must be an absolute path; "${path}" is relative`);
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(
        `corpora.local_folder.path does not exist as a folder on this machine: ${path}\n` +
          "      A schedule pointing at a folder that is not there loads nothing and reports success forever."
      );
    }
    if (!FOLDER_SOURCE_RE.test(reference.folderSource) || reference.folderSource.length > 64) {
      throw new Error(
        "corpora.local_folder.source must be lowercase letters, digits, hyphen or underscore, starting with a letter or digit"
      );
    }
  },
  // NEVER change this payload's keys or shapes: the hash is baked into every
  // installed plist's argv, and a computation change strands them all on
  // "configuration changed; reinstall".
  configHashPayloadOf: (reference) => ({
    version: 1,
    kind: "folder-ingest",
    slug: reference.slug,
    manifest_path: reference.path,
    brain_path: reference.brainPath,
    domain: reference.manifest.brain.domain,
    ingest_cron: reference.cron,
    admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
    folder_path: reference.folderPath,
    folder_source: reference.folderSource,
  }),
  // The folder and the source name are bound into the config hash above, so a
  // tick cannot be pointed at a different tree by editing the manifest after
  // the agent was installed.
  childArgumentsOf: (plan) => [
    "ingest", plan.path, "--path", plan.folderPath, "--source", plan.folderSource,
  ],
  childEnvironmentOf: (plan, environment) => safeIngestEnvironment(environment),
  configChangedError:
    "the manifest's watched folder configuration changed after this LaunchAgent was installed; reinstall the scheduler before it may read credentials",
  busyReason: "watched folder ingest is already running",
});

const withSpec = (options = {}) => ({ ...options, spec: FOLDER_SCHEDULER_SPEC });

export function buildFolderSchedulerPlan(manifestPath, options = {}) {
  return buildSchedulerPlan(manifestPath, withSpec(options));
}

export function installFolderScheduler(manifestPath, options = {}) {
  return installScheduler(manifestPath, withSpec(options));
}

export function statusFolderScheduler(manifestPath, options = {}) {
  return statusScheduler(manifestPath, withSpec(options));
}

export function removeFolderScheduler(manifestPath, options = {}) {
  return removeScheduler(manifestPath, withSpec(options));
}

export function runFolderIngest(manifestPath, options = {}) {
  return runScheduledIngest(manifestPath, withSpec(options));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function recordFolderSchedulerFailure(error, { action = "run" } = {}) {
  return recordDriveSchedulerFailure(error, {
    action,
    productRelativeLocation: "operations/folder-scheduler.mjs#main",
  });
}

function printSupportReceipt(eventId) {
  if (!eventId) return;
  console.error(`Private issue note ${eventId} was saved locally. The installer did not upload or send this issue note.`);
  console.error("Review the exact safe record with: brain support --preview");
}

async function main(argv = process.argv.slice(2)) {
  const [command, manifestPath] = argv;
  if (!command || !manifestPath || !["install", "status", "remove", "run"].includes(command)) {
    console.log("usage: node operations/folder-scheduler.mjs <install|status|remove|run> <manifest> [--brain <brain.mjs>]");
    return 1;
  }
  const brainPath = optionValue(argv, "--brain") || undefined;
  const expectedConfigHash = optionValue(argv, "--config-hash") || undefined;
  const options = { brainPath, expectedConfigHash };
  if (command === "run") {
    const result = runFolderIngest(manifestPath, options);
    const message = result.reason || `watched folder ingest ${result.status}`;
    console.log(`[${new Date().toISOString()}] ${message}`);
    printSupportReceipt(recordDriveSchedulerResult(result, {
      productRelativeLocation: "operations/folder-scheduler.mjs#main",
    }));
    return result.code;
  }
  const result = command === "install"
    ? installFolderScheduler(manifestPath, options)
    : command === "status"
      ? statusFolderScheduler(manifestPath, options)
      : removeFolderScheduler(manifestPath, options);
  console.log(JSON.stringify({
    label: result.label,
    manifest: result.path,
    folder: result.folderPath,
    source: result.folderSource,
    cron: result.cron,
    expected_refresh_seconds: result.expectedRefreshSeconds,
    installed: result.installed,
    loaded: result.loaded,
    running: result.running,
    plist: result.plistPath,
    stdout_log: result.stdoutPath,
    stderr_log: result.stderrPath,
    lock: result.lockPath,
  }, null, 2));
  for (const warning of result.warnings || []) console.log(`warning: ${warning}`);
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === SELF_PATH;
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`watched folder scheduler failed: ${error.message}`);
    printSupportReceipt(recordFolderSchedulerFailure(error, { action: process.argv[2] }));
    process.exitCode = 1;
  });
}
