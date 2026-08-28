#!/usr/bin/env node
/**
 * The Node half of WhatsApp capture, on a schedule — the third consumer of the
 * generalized connector scheduler in operations/drive-scheduler.mjs.
 *
 * SHAPE: short scheduled ticks, exactly like iMessage capture. launchd fires a
 * short-lived process every minute, it takes the native lockf single-instance
 * lock, drains whatever the capture daemon has written into its local outbox
 * since the last cursor, and exits. Nothing here is a daemon; the resident
 * process is the Go binary, supervised separately by
 * operations/whatsapp-daemon.mjs, which is a genuinely different shape and
 * says so in its own header.
 *
 * The split is what lets this file be four screens long instead of four
 * hundred: every piece of hardening the Drive scheduler proved — atomic plist
 * staging with rollback, bounded symlink-refusing log rotation, the
 * config-hash guard against a stale agent reading credentials for an edited
 * manifest, the credential-scrubbed child environment — applies unchanged,
 * because a drain tick IS a run-to-completion ingest.
 *
 * The plist contains no credentials. A tick that finds no outbox fails loudly
 * in its own log with the named outbox_missing error rather than silently
 * reporting success, which is the difference between "capture is not running"
 * and "capture found nothing".
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

/**
 * Every minute. Capture into the outbox is instant (the daemon holds a live
 * websocket); this tick is what moves it into the brain, so it sets the honest
 * ceiling on "how long until a new message is answerable".
 */
export const WHATSAPP_DRAIN_DEFAULT_CRON = "* * * * *";

const WHATSAPP_CRON_LABELS = Object.freeze({
  key: "operations.whatsapp_drain_cron",
  noun: "WhatsApp drain cron",
});

export const WHATSAPP_DRAIN_SCHEDULER_SPEC = Object.freeze({
  kind: "whatsapp-drain",
  schedulerNoun: "WhatsApp drain scheduler",
  activityNoun: "WhatsApp drain",
  cronLabels: WHATSAPP_CRON_LABELS,
  cronOf: (manifest) => manifest?.operations?.whatsapp_drain_cron || WHATSAPP_DRAIN_DEFAULT_CRON,
  cronMissingError:
    "the manifest needs operations.whatsapp_drain_cron (or the built-in every-minute default) before the WhatsApp drain scheduler can be installed",
  requireEnabled(manifest) {
    if (manifest?.corpora?.whatsapp?.enabled !== true) {
      throw new Error("corpora.whatsapp.enabled must be true before its scheduler can be installed");
    }
  },
  domainMissingError:
    "brain.domain is required for the unattended WhatsApp drain because the scheduled child intentionally receives no Cloudflare deployment token",
  platformError: (platform) =>
    `unattended WhatsApp draining is scheduled with a macOS LaunchAgent; this machine reports ${platform}. ` +
    "Windows service supervision is not built, so there is no unattended path there yet.",
  defaultSchedulerPath: () => SELF_PATH,
  // No connector-specific reference fields: the drain child needs no token
  // store, only the manifest-declared admin key it resolves itself.
  referenceExtrasOf: null,
  validateExtras: null,
  configHashPayloadOf: (reference) => ({
    version: 1,
    kind: "whatsapp-drain",
    slug: reference.slug,
    manifest_path: reference.path,
    brain_path: reference.brainPath,
    domain: reference.manifest.brain.domain,
    drain_cron: reference.cron,
    admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
  }),
  childArgumentsOf: (plan) => ["ingest", plan.path, "--from", "whatsapp"],
  childEnvironmentOf: (plan, environment) => safeIngestEnvironment(environment),
  configChangedError:
    "the manifest's scheduled WhatsApp configuration changed after this LaunchAgent was installed; reinstall the scheduler before it may read credentials",
  busyReason: "a WhatsApp drain is already running",
});

const withSpec = (options = {}) => ({ ...options, spec: WHATSAPP_DRAIN_SCHEDULER_SPEC });

export function buildWhatsappDrainSchedulerPlan(manifestPath, options = {}) {
  return buildSchedulerPlan(manifestPath, withSpec(options));
}

export function installWhatsappDrainScheduler(manifestPath, options = {}) {
  return installScheduler(manifestPath, withSpec(options));
}

export function statusWhatsappDrainScheduler(manifestPath, options = {}) {
  return statusScheduler(manifestPath, withSpec(options));
}

export function removeWhatsappDrainScheduler(manifestPath, options = {}) {
  return removeScheduler(manifestPath, withSpec(options));
}

export function runWhatsappDrain(manifestPath, options = {}) {
  return runScheduledIngest(manifestPath, withSpec(options));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function recordWhatsappSchedulerFailure(error, { action = "run" } = {}) {
  return recordDriveSchedulerFailure(error, {
    action,
    productRelativeLocation: "operations/whatsapp-drain-scheduler.mjs#main",
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
    console.log("usage: node operations/whatsapp-drain-scheduler.mjs <install|status|remove|run> <manifest> [--brain <brain.mjs>]");
    return 1;
  }
  const brainPath = optionValue(argv, "--brain") || undefined;
  const expectedConfigHash = optionValue(argv, "--config-hash") || undefined;
  const options = { brainPath, expectedConfigHash };
  if (command === "run") {
    const result = runWhatsappDrain(manifestPath, options);
    const message = result.reason || `WhatsApp drain ${result.status}`;
    console.log(`[${new Date().toISOString()}] ${message}`);
    printSupportReceipt(recordDriveSchedulerResult(result, {
      productRelativeLocation: "operations/whatsapp-drain-scheduler.mjs#main",
    }));
    return result.code;
  }
  const result = command === "install"
    ? installWhatsappDrainScheduler(manifestPath, options)
    : command === "status"
      ? statusWhatsappDrainScheduler(manifestPath, options)
      : removeWhatsappDrainScheduler(manifestPath, options);
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
    console.error(`WhatsApp drain scheduler failed: ${error.message}`);
    printSupportReceipt(recordWhatsappSchedulerFailure(error, { action: process.argv[2] }));
    process.exitCode = 1;
  });
}
