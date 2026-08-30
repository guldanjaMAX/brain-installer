/**
 * Local, machine-readable handoff between the deterministic installer and the
 * Financial Brain technician skill. The file contains tool/version/status
 * facts and absolute locators only. It never contains a credential, provider
 * response, account id, hostname, source name, or customer content.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const BOOTSTRAP_STATUS_SCHEMA_VERSION = 1;
export const BOOTSTRAP_STATUS_BASENAME = ".financial-brain-bootstrap-status.json";

function cleanVersion(value) {
  const text = String(value || "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
}

export function bootstrapManifestObservation(manifestPath, options = {}) {
  const path = resolve(String(manifestPath || "brain.manifest.json"));
  const exists = options.existsImpl ?? existsSync;
  if (!exists(path)) {
    return Object.freeze({ path, state: "not_created", recorded_version: null });
  }
  try {
    const identity = (options.lstatImpl ?? lstatSync)(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.size > 1024 * 1024) {
      return Object.freeze({ path, state: "unsafe", recorded_version: null });
    }
    const manifest = JSON.parse((options.readFileImpl ?? readFileSync)(path, "utf8"));
    const version = cleanVersion(manifest?.brain?.version);
    const hasLocalInstallShape = Boolean(
      manifest?.client?.slug &&
      manifest?.brain?.worker_name &&
      manifest?.infrastructure?.cloudflare?.account_id,
    );
    return Object.freeze({
      path,
      state: hasLocalInstallShape ? "present" : "partial",
      recorded_version: version,
    });
  } catch {
    return Object.freeze({ path, state: "corrupt", recorded_version: null });
  }
}

function outcomeFor({ productVersion, manifest, checks, skill, deepDpapi, observations }) {
  if (["unsafe", "corrupt"].includes(manifest.state)) {
    return {
      status: "action_required",
      issue_code: manifest.state === "unsafe" ? "MANIFEST_UNSAFE" : "MANIFEST_CORRUPT",
      retry_safe: true,
      requires_human: true,
      next_action: "Review or restore the intended manifest file before any setup, update, or provider command.",
      recovery: "No Cloudflare, provider, or source action was started.",
    };
  }
  if (checks.node?.status === "fail") {
    return {
      status: "action_required",
      issue_code: "RUNTIME_UNAVAILABLE",
      retry_safe: true,
      requires_human: true,
      next_action: "Install the supported Node.js runtime from its official source, then rerun the same bootstrap command.",
      recovery: "No provisioning action was started.",
    };
  }
  if (checks.claude_path?.status === "failed") {
    return {
      status: "action_required",
      issue_code: checks.claude_path.issue_code || "CLAUDE_PATH_UPDATE_FAILED",
      retry_safe: true,
      requires_human: false,
      next_action: "Run the printed non-truncating user PATH recovery, then rerun the same bootstrap command.",
      recovery: "The existing user PATH and Claude installation were left in place.",
    };
  }
  if (checks.claude?.status === "fail") {
    const signedOut = /installed but not signed in/i.test(checks.claude.detail || "");
    return {
      status: "action_required",
      issue_code: signedOut ? "CLAUDE_SIGN_IN_REQUIRED" : "CLAUDE_UNAVAILABLE",
      retry_safe: true,
      requires_human: true,
      next_action: signedOut
        ? "The owner completes Claude browser sign-in, then reruns the same bootstrap command."
        : "Install Claude Code from Anthropic's official installer, then rerun the same bootstrap command.",
      recovery: "No provisioning action was started.",
    };
  }
  if (checks.wrangler?.status === "fail") {
    return {
      status: "action_required",
      issue_code: "WRANGLER_UNAVAILABLE",
      retry_safe: true,
      requires_human: false,
      next_action: "Restore npm registry access or the supported runtime, then rerun the same bootstrap command.",
      recovery: "The pinned Wrangler check made no Cloudflare change.",
    };
  }
  if (checks.dpapi?.status === "fail") {
    return {
      status: "action_required",
      issue_code: checks.dpapi.issue_code || "WINDOWS_DPAPI_UNKNOWN",
      retry_safe: true,
      requires_human: true,
      next_action: deepDpapi
        ? "Keep the Windows live gate open and review the named DPAPI stage before another 25-cold-round diagnostic."
        : "Run the 25-cold-round Windows DPAPI diagnostic before a release or client credential write.",
      recovery: "No credential was persisted and any prior credential remains authoritative.",
    };
  }
  if (observations.cloudflare_token === "wrong_account") {
    return {
      status: "action_required",
      issue_code: "CLOUDFLARE_ACCOUNT_MISMATCH",
      retry_safe: false,
      requires_human: true,
      next_action: "The owner selects the intended Cloudflare account and creates or supplies a token scoped to that account.",
      recovery: "No account switch or provisioning action is allowed automatically.",
    };
  }
  if (observations.cloudflare_token === "missing_permission") {
    return {
      status: "action_required",
      issue_code: "CLOUDFLARE_PERMISSION_MISSING",
      retry_safe: true,
      requires_human: true,
      next_action: "The owner reviews the token summary for the four named required capabilities, then retries the same check.",
      recovery: "A token-verification rejection alone is not an invalid-token verdict.",
    };
  }
  if (["download", "deploy", "migration"].includes(observations.network_loss_stage)) {
    return {
      status: "action_required",
      issue_code: `NETWORK_${observations.network_loss_stage.toUpperCase()}_UNAVAILABLE`,
      retry_safe: true,
      requires_human: false,
      next_action: `Restore network access, then rerun the same ${observations.network_loss_stage} step.`,
      recovery: "Do not switch accounts, skip integrity checks, or invent a second workflow.",
    };
  }
  if (observations.migration === "incompatible") {
    return {
      status: "hard_stop",
      issue_code: "MIGRATION_INCOMPATIBLE",
      retry_safe: false,
      requires_human: true,
      next_action: "Keep the Worker paused and review the migration history plus recovery bookmark before any further action.",
      recovery: "Do not mark the migration applied, rewrite history, or continue provisioning automatically.",
    };
  }
  if (observations.local_credential === "missing") {
    return {
      status: "action_required",
      issue_code: "LOCAL_CREDENTIAL_MISSING",
      retry_safe: true,
      requires_human: true,
      next_action: "Use the reviewed hidden credential ceremony or reconnect the exact provider account.",
      recovery: "Never place the missing value in chat, argv, a status file, or a support preview.",
    };
  }
  if (!skill || !["installed", "verified"].includes(skill.status)) {
    return {
      status: "action_required",
      issue_code: "TECHNICIAN_SKILL_UNAVAILABLE",
      retry_safe: true,
      requires_human: false,
      next_action: "Resolve the personal Claude skill path conflict, then rerun the same bootstrap command.",
      recovery: "An unrelated existing skill was preserved.",
    };
  }
  if (manifest.state === "not_created") {
    return {
      status: "ready_for_setup",
      issue_code: "BOOTSTRAP_READY_NO_MANIFEST",
      retry_safe: true,
      requires_human: true,
      next_action: "Review the read-only technician plan, then let the owner start the manifest-creating setup command and use its hidden Cloudflare prompt.",
      recovery: "Rerun the same setup command after a named retry-safe interruption. Do not invent a manifest or credential in chat.",
    };
  }
  if (manifest.state === "partial") {
    return {
      status: "action_required",
      issue_code: "INSTALL_RECORD_PARTIAL",
      retry_safe: true,
      requires_human: true,
      next_action: "Inspect the local technician plan and support preview before resuming the same setup command.",
      recovery: "Do not switch accounts, replace the manifest, or start a separate provisioning path.",
    };
  }
  if (manifest.recorded_version && manifest.recorded_version !== productVersion) {
    return {
      status: "ready_for_update_review",
      issue_code: "INSTALLED_VERSION_DIFFERS",
      retry_safe: true,
      requires_human: true,
      next_action: "Review the package-local release contract and preview the existing install before approving the update.",
      recovery: "A same-version rerun is idempotent; an interrupted migration still uses its saved recovery bookmark.",
    };
  }
  return {
    status: "ready",
    issue_code: null,
    retry_safe: true,
    requires_human: false,
    next_action: "Open the Financial Brain technician skill with this status file and begin with its read-only plan.",
    recovery: null,
  };
}

export function buildBootstrapStatus({
  productVersion,
  manifest,
  cli,
  checks,
  skill,
  claudeDoctor,
  deepDpapi = false,
  statusFile = null,
  observations = {},
} = {}) {
  const version = cleanVersion(productVersion);
  if (!version || !manifest?.path || !cli?.command || !Array.isArray(cli?.args)) {
    throw new TypeError("bootstrap status needs a package version and explicit local locators");
  }
  const safeObservations = Object.freeze({
    install_state: ["clean", "partial_v0.2.0", "existing", "same_version_update"].includes(observations.install_state)
      ? observations.install_state
      : "not_checked",
    cloudflare_token: ["account_capabilities_reachable", "wrong_account", "missing_permission"].includes(observations.cloudflare_token)
      ? observations.cloudflare_token
      : "not_checked",
    network_loss_stage: ["download", "deploy", "migration"].includes(observations.network_loss_stage)
      ? observations.network_loss_stage
      : null,
    migration: ["compatible", "incompatible", "same_version"].includes(observations.migration)
      ? observations.migration
      : "not_checked",
    local_credential: ["present", "missing"].includes(observations.local_credential)
      ? observations.local_credential
      : "not_checked",
    support_preview: observations.support_preview === "private" ? "private" : "not_checked",
  });
  const outcome = outcomeFor({
    productVersion: version,
    manifest,
    checks,
    skill,
    deepDpapi,
    observations: safeObservations,
  });
  return Object.freeze({
    schema_version: BOOTSTRAP_STATUS_SCHEMA_VERSION,
    command: "bootstrap",
    ...outcome,
    release: Object.freeze({
      version,
      source: "package-local package.json inside the pinned Brain CLI artifact",
      external_test_kit_required: false,
    }),
    manifest: Object.freeze({ ...manifest }),
    cli: Object.freeze({ command: resolve(cli.command), args: cli.args.map((value) => resolve(String(value))) }),
    status_file: statusFile ? resolve(statusFile) : null,
    checks: Object.freeze({
      node: checks.node?.status || "unknown",
      claude: checks.claude?.status || "unknown",
      claude_path: checks.claude_path?.status || "not_applicable",
      wrangler: checks.wrangler?.status || "unknown",
      dpapi: checks.dpapi?.status || "not_applicable",
      dpapi_rounds: Number(checks.dpapi?.rounds || 0),
      technician_skill: skill?.status || "not_checked",
      claude_doctor: claudeDoctor || "not_checked",
    }),
    observations: safeObservations,
    boundaries: Object.freeze({
      credentials: "hidden_prompt_or_provider_page_only",
      diagnostics_and_previews: "agent_safe",
      idempotent_retries: "agent_safe_after_issue_review",
      deploy_or_data_change: "explicit_owner_confirmation_required",
      unsupported_outage_or_identity_mismatch: "requires_human",
    }),
  });
}

export function bootstrapStatusFilePath(manifestPath) {
  return join(dirname(resolve(String(manifestPath || "brain.manifest.json"))), BOOTSTRAP_STATUS_BASENAME);
}

export function writeBootstrapStatusFile(manifestPath, status, options = {}) {
  const target = resolve(options.path || bootstrapStatusFilePath(manifestPath));
  const directory = dirname(target);
  (options.mkdirImpl ?? mkdirSync)(directory, { recursive: true, mode: 0o700 });
  const canonical = resolve((options.realpathImpl ?? realpathSync.native)(directory));
  const expected = resolve(directory);
  const sameDirectory = (options.platform ?? process.platform) === "win32"
    ? canonical.toLowerCase() === expected.toLowerCase()
    : canonical === expected;
  if (!sameDirectory) throw new Error("the bootstrap status directory must not pass through a linked path");
  if ((options.existsImpl ?? existsSync)(target)) {
    const identity = (options.lstatImpl ?? lstatSync)(target);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
      throw new Error("the bootstrap status destination is not a safe regular file");
    }
  }
  const payload = `${JSON.stringify({ ...status, status_file: target }, null, 2)}\n`;
  const temporary = `${target}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = (options.openImpl ?? openSync)(temporary, "wx", 0o600);
    (options.writeFileImpl ?? writeFileSync)(descriptor, payload, "utf8");
    (options.fsyncImpl ?? fsyncSync)(descriptor);
    (options.closeImpl ?? closeSync)(descriptor);
    descriptor = undefined;
    (options.renameImpl ?? renameSync)(temporary, target);
    (options.chmodImpl ?? chmodSync)(target, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { (options.closeImpl ?? closeSync)(descriptor); } catch {}
    }
    try { (options.unlinkImpl ?? unlinkSync)(temporary); } catch {}
    throw error;
  }
  if ((options.readFileImpl ?? readFileSync)(target, "utf8") !== payload) {
    throw new Error("the bootstrap status file did not read back exactly");
  }
  return Object.freeze({ path: target, status: Object.freeze({ ...status, status_file: target }) });
}
