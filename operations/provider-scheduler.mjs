#!/usr/bin/env node
/**
 * Unattended macOS scheduling for OAuth provider connectors.
 *
 * This is a thin spec layer over the hardened Drive scheduler. It reuses the
 * same atomic plist replacement, private logs, single-run lock, config hash,
 * sparse child environment, and durable admin-key resolution.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordSupportEvent } from "../support-journal.mjs";
import {
  buildSchedulerPlan,
  installScheduler,
  removeScheduler,
  runScheduledIngest,
  safeIngestEnvironment,
  statusScheduler,
} from "./drive-scheduler.mjs";
import { providerOAuthConfig } from "../connectors/provider-oauth.mjs";

export const SCHEDULED_PROVIDER_IDS = Object.freeze([
  "quickbooks", "slack", "notion", "microsoft", "dropbox", "hubspot",
]);

const TOKEN_STORES = new Set(["auto", "keychain", "file"]);
const DEFAULT_CRONS = Object.freeze({
  quickbooks: "0 2 * * *",
  slack: "15 2 * * *",
  notion: "30 2 * * *",
  microsoft: "0 * * * *",
  dropbox: "15 * * * *",
  hubspot: "45 2 * * *",
});
const sourceConfig = (manifest, provider) => manifest?.corpora?.[provider] || null;
const storeEnvironmentName = (provider) => `BRAIN_${provider.toUpperCase()}_TOKEN_STORE`;

export function createProviderSchedulerSpec(provider) {
  const config = providerOAuthConfig(provider);
  const key = config.provider;
  if (!SCHEDULED_PROVIDER_IDS.includes(key)) throw new TypeError(`unsupported scheduled provider ${key}`);
  const tokenEnv = storeEnvironmentName(key);
  return Object.freeze({
    kind: `${key}-ingest`,
    schedulerNoun: `${config.label} scheduler`,
    activityNoun: `${config.label} ingest`,
    cronLabels: Object.freeze({
      key: `operations.provider_crons.${key}`,
      noun: `${config.label} ingest cron`,
    }),
    cronOf: (manifest) => manifest?.operations?.provider_crons?.[key] || DEFAULT_CRONS[key],
    cronMissingError: `operations.provider_crons.${key} must be a five-field cron expression`,
    requireEnabled(manifest) {
      if (sourceConfig(manifest, key)?.enabled !== true) {
        throw new Error(`corpora.${key}.enabled must be true before its scheduler can be installed`);
      }
    },
    domainMissingError:
      `brain.domain is required for unattended ${config.label} ingest because the scheduled child receives no Cloudflare deployment token`,
    platformError: (platform) =>
      `unattended ${config.label} scheduling is currently implemented with macOS LaunchAgents; this machine reports ${platform}`,
    defaultSchedulerPath: () => fileURLToPath(import.meta.url),
    schedulerArgumentsOf: () => [key],
    referenceExtrasOf: (manifest) => ({
      provider: key,
      tokenStore: String(manifest?.operations?.provider_token_stores?.[key] || "auto").toLowerCase(),
      sourceConfiguration: sourceConfig(manifest, key),
    }),
    validateExtras(reference) {
      if (!TOKEN_STORES.has(reference.tokenStore)) {
        throw new Error(`operations.provider_token_stores.${key} must be auto, keychain or file`);
      }
    },
    configHashPayloadOf: (reference) => ({
      version: 1,
      provider: key,
      slug: reference.slug,
      manifest_path: reference.path,
      brain_path: reference.brainPath,
      domain: reference.manifest.brain.domain,
      ingest_cron: reference.cron,
      admin_key_secret: reference.manifest?.operations?.admin_key_secret || null,
      token_store: reference.tokenStore,
      source_configuration: reference.sourceConfiguration,
    }),
    childArgumentsOf: (plan) => ["ingest", plan.path, "--from", key],
    childEnvironmentOf: (plan, environment) => {
      const child = safeIngestEnvironment(environment);
      if (plan.tokenStore === "auto") delete child[tokenEnv];
      else child[tokenEnv] = plan.tokenStore;
      return child;
    },
    configChangedError:
      `the manifest's scheduled ${config.label} configuration changed after this LaunchAgent was installed; reinstall the scheduler before it may read credentials`,
    busyReason: `${config.label} ingest is already running`,
  });
}

const optionsFor = (provider, options = {}) => ({ ...options, spec: createProviderSchedulerSpec(provider) });

export const buildProviderSchedulerPlan = (provider, manifestPath, options = {}) =>
  buildSchedulerPlan(manifestPath, optionsFor(provider, options));
export const installProviderScheduler = (provider, manifestPath, options = {}) =>
  installScheduler(manifestPath, optionsFor(provider, options));
export const statusProviderScheduler = (provider, manifestPath, options = {}) =>
  statusScheduler(manifestPath, optionsFor(provider, options));
export const removeProviderScheduler = (provider, manifestPath, options = {}) =>
  removeScheduler(manifestPath, optionsFor(provider, options));
export const runProviderScheduledIngest = (provider, manifestPath, options = {}) =>
  runScheduledIngest(manifestPath, optionsFor(provider, options));

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function supportFailure(provider, action) {
  try {
    return recordSupportEvent({
      command: "schedule",
      source: provider,
      errorCode: action === "install" ? "SCHEDULE_INSTALL_FAILED" : "SCHEDULE_RUN_FAILED",
      productRelativeLocation: "operations/provider-scheduler.mjs#main",
    }).event_id;
  } catch {
    return null;
  }
}

async function main(argv = process.argv.slice(2)) {
  const [provider, command, manifestPath] = argv;
  if (!SCHEDULED_PROVIDER_IDS.includes(String(provider || "")) ||
      !["install", "status", "remove", "run"].includes(String(command || "")) || !manifestPath) {
    console.log(
      "usage: node operations/provider-scheduler.mjs <quickbooks|slack|notion|microsoft|dropbox|hubspot> " +
      "<install|status|remove|run> <manifest> [--brain <brain.mjs>]",
    );
    return 1;
  }
  const options = {
    brainPath: optionValue(argv, "--brain") || undefined,
    expectedConfigHash: optionValue(argv, "--config-hash") || undefined,
  };
  if (command === "run") {
    const result = runProviderScheduledIngest(provider, manifestPath, options);
    console.log(`[${new Date().toISOString()}] ${result.reason || `${provider} ingest ${result.status}`}`);
    return result.code;
  }
  const result = command === "install"
    ? installProviderScheduler(provider, manifestPath, options)
    : command === "status"
      ? statusProviderScheduler(provider, manifestPath, options)
      : removeProviderScheduler(provider, manifestPath, options);
  console.log(JSON.stringify({
    provider,
    label: result.label,
    installed: result.installed,
    loaded: result.loaded,
    running: result.running,
    cron: result.cron,
    expected_refresh_seconds: result.expectedRefreshSeconds,
    definition_matches_manifest: result.definitionMatches,
    plist: result.plistPath,
    stdout_log: result.stdoutPath,
    stderr_log: result.stderrPath,
  }, null, 2));
  for (const warning of result.warnings || []) console.log(`warning: ${warning}`);
  return 0;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    const provider = String(process.argv[2] || "provider");
    console.error(`${provider} scheduler failed: ${error.message}`);
    const eventId = supportFailure(provider, process.argv[3]);
    if (eventId) {
      console.error(`Private issue note ${eventId} was saved locally. The installer did not upload or send it.`);
    }
    process.exitCode = 1;
  });
}
