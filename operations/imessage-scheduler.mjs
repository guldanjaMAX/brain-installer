#!/usr/bin/env node
/**
 * Unattended iMessage capture for macOS — the second consumer of the
 * generalized connector scheduler in operations/drive-scheduler.mjs.
 *
 * SHAPE: short scheduled ticks, not a resident daemon. launchd fires a
 * short-lived process every minute (StartCalendarInterval), which takes the
 * native lockf single-instance lock, runs ONE incremental capture pass
 * (`brain ingest <manifest> --from imessage`), and exits. A tick that finds
 * a long backlog simply holds the lock while it pages through it; the next
 * ticks exit immediately with the lock-busy code. This deliberately reuses
 * every piece of hardening the Drive scheduler already proved — atomic plist
 * staging with rollback, bounded symlink-refusing log rotation, the
 * config-hash guard against a stale agent reading credentials for an edited
 * manifest — instead of re-inventing a KeepAlive daemon's lockfiles and
 * restart semantics from zero.
 *
 * The plist contains no credentials and the child environment is scrubbed
 * exactly like Drive's. Full Disk Access is a TCC grant on the node binary
 * itself and is checked by `brain connect imessage` before this is ever
 * installed; a tick that loses the grant later fails loudly in its own log
 * with the named full_disk_access_denied error, not silently.
 */

import { resolve } from "node:path";
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

/** Every minute. A new message must appear within one short capture interval. */
export const IMESSAGE_CAPTURE_DEFAULT_CRON = "* * * * *";

const IMESSAGE_CRON_LABELS = Object.freeze({
  key: "operations.imessage_capture_cron",
  noun: "iMessage capture cron",
});

export const IMESSAGE_SCHEDULER_SPEC = Object.freeze({
  kind: "imessage-capture",
  schedulerNoun: "iMessage capture scheduler",
  activityNoun: "iMessage capture",
  cronLabels: IMESSAGE_CRON_LABELS,
  cronOf: (manifest) => manifest?.operations?.imessage_capture_cron || IMESSAGE_CAPTURE_DEFAULT_CRON,
  cronMissingError:
    "the manifest needs operations.imessage_capture_cron (or the built-in every-minute default) before the iMessage capture scheduler can be installed",
  requireEnabled(manifest) {
    if (manifest?.corpora?.imessage?.enabled !== true) {
      throw new Error("corpora.imessage.enabled must be true before its scheduler can be installed");
    }
  },
  domainMissingError:
    "brain.domain is required for unattended iMessage capture because the scheduled child intentionally receives no Cloudflare deployment token",
  platformError: (platform) =>
    `iMessage capture reads the Messages database, which exists only on macOS; this machine reports ${platform}`,
  defaultSchedulerPath: () => SELF_PATH,
  // No connector-specific reference fields: the capture child needs no Google
  // token store, only the manifest-declared admin key it resolves itself.
  referenceExtrasOf: null,
  validateExtras: null,
  configHashPayloadOf: (reference) => ({
    version: 1,
    kind: "imessage-capture",
    slug: reference.slug,
    manifest_path: reference.path,
    brain_path: reference.brainPath,
    domain: reference.manifest.brain.domain,
    capture_cron: reference.cron,
    admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
  }),
  childArgumentsOf: (plan) => ["ingest", plan.path, "--from", "imessage"],
  childEnvironmentOf: (plan, environment) => safeIngestEnvironment(environment),
  configChangedError:
    "the manifest's scheduled iMessage configuration changed after this LaunchAgent was installed; reinstall the scheduler before it may read credentials",
  busyReason: "iMessage capture is already running",
});

const withSpec = (options = {}) => ({ ...options, spec: IMESSAGE_SCHEDULER_SPEC });

export function buildImessageSchedulerPlan(manifestPath, options = {}) {
  return buildSchedulerPlan(manifestPath, withSpec(options));
}

export function installImessageScheduler(manifestPath, options = {}) {
  return installScheduler(manifestPath, withSpec(options));
}

export function statusImessageScheduler(manifestPath, options = {}) {
  return statusScheduler(manifestPath, withSpec(options));
}

export function removeImessageScheduler(manifestPath, options = {}) {
  return removeScheduler(manifestPath, withSpec(options));
}

export function runImessageCapture(manifestPath, options = {}) {
  return runScheduledIngest(manifestPath, withSpec(options));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function recordImessageSchedulerFailure(error, { action = "run" } = {}) {
  return recordDriveSchedulerFailure(error, {
    action,
    productRelativeLocation: "operations/imessage-scheduler.mjs#main",
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
    console.log("usage: node operations/imessage-scheduler.mjs <install|status|remove|run> <manifest> [--brain <brain.mjs>]");
    return 1;
  }
  const brainPath = optionValue(argv, "--brain") || undefined;
  const expectedConfigHash = optionValue(argv, "--config-hash") || undefined;
  const options = { brainPath, expectedConfigHash };
  if (command === "run") {
    const result = runImessageCapture(manifestPath, options);
    const message = result.reason || `iMessage capture ${result.status}`;
    console.log(`[${new Date().toISOString()}] ${message}`);
    printSupportReceipt(recordDriveSchedulerResult(result, {
      productRelativeLocation: "operations/imessage-scheduler.mjs#main",
    }));
    return result.code;
  }
  const result = command === "install"
    ? installImessageScheduler(manifestPath, options)
    : command === "status"
      ? statusImessageScheduler(manifestPath, options)
      : removeImessageScheduler(manifestPath, options);
  console.log(JSON.stringify({
    label: result.label,
    manifest: result.path,
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
    console.error(`iMessage capture scheduler failed: ${error.message}`);
    printSupportReceipt(recordImessageSchedulerFailure(error, { action: process.argv[2] }));
    process.exitCode = 1;
  });
}
