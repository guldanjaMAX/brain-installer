/**
 * A small coordinator for the install-day account ceremonies.
 *
 * It deliberately does not become another credential store. Dashboard values
 * are read with the installer's existing hidden-input primitive. Most are
 * passed to one short-lived child command through an allowlisted environment.
 * Provider OAuth values stay in-process and go directly to the existing local
 * credential store. Input buffers are then zeroed. Nothing secret is placed in
 * argv, a receipt, or JSON.
 *
 * The default command is read-only and machine-readable. This lets a human
 * technician, Codex, or another local assistant guide the same reviewed steps
 * without teaching an agent how to hold credentials.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { renderCopyableCommand } from "./command-display.mjs";

export const TECHNICIAN_STATUS_SCHEMA_VERSION = 1;
export const TECHNICIAN_STATUS_BASENAME = ".financial-brain-technician-status.json";

export const TECHNICIAN_STEPS = Object.freeze([
  Object.freeze({
    id: "tools",
    title: "Install and verify Claude Code, the Brain CLI, and Wrangler",
    dashboard_url: "https://financialbrain.ai/install",
    human_boundary: "The owner signs in to Claude in their browser. The technician runs Anthropic's interactive doctor with Claude Code's normal approval prompts enabled.",
    automated_proof: "The installer verifies the Claude CLI version and sign-in, installs and reads back the personal /financial-brain-technician skill, runs claude doctor in a real terminal, and runs the pinned Wrangler 4 CLI with a credential-scrubbed environment.",
  }),
  Object.freeze({
    id: "cloudflare",
    title: "Install the private Brain",
    dashboard_url: "https://dash.cloudflare.com/profile/api-tokens",
    human_boundary: "The owner signs in, completes 2FA, and creates the least-privilege token. The hidden terminal prompt is ready when it is time to enter the token.",
    automated_proof: "The installer verifies the token, provisions the exact account, deploys, migrates, and runs health checks.",
  }),
  Object.freeze({
    id: "plaid",
    title: "Configure the Plaid bank feed",
    dashboard_url: "https://dashboard.plaid.com/",
    human_boundary: "The client owns the Plaid account, chooses Sandbox or Production, registers this Brain's return address, and enters the Plaid client ID, secret, and independently stored bank wrapping key only into hidden terminal prompts.",
    automated_proof: "Deferred from the public first-install path. Offline protocol tests do not prove secure live credential custody or Plaid Link acceptance.",
  }),
  Object.freeze({
    id: "google",
    title: "Connect Google Drive, Gmail, and Calendar",
    dashboard_url: "https://console.cloud.google.com/apis/credentials",
    human_boundary: "The owner chooses or creates the Google project and approves the OAuth consent screen in their browser.",
    automated_proof: "Deferred from the public first-install path. The current machine-global Google store and absent manifest-bound dry run do not satisfy multi-Brain custody proof.",
  }),
  Object.freeze({
    id: "quickbooks",
    title: "Connect the client's QuickBooks Online company",
    dashboard_url: "https://developer.intuit.com/app/developer/dashboard",
    human_boundary: "The client creates and owns the Intuit app, enters its values only at hidden prompts, and authorizes their sandbox company in the browser. Intuit grants its broad Accounting permission; Financial Brain uses read/query calls only, but the provider scope itself is not read-only.",
    automated_proof: "Deferred from the public first-install path. Offline source-binding tests passed, but a real Intuit Sandbox company ceremony and client-owned production callback remain open.",
  }),
  Object.freeze({
    id: "zoom",
    title: "Connect Zoom cloud transcripts",
    dashboard_url: "https://marketplace.zoom.us/develop/create",
    human_boundary: "A Zoom admin creates a Server-to-Server OAuth app, grants the recording scope, and later saves the verified webhook subscription.",
    automated_proof: "Deferred from the public first-install path until the credential handoff avoids child environments and a real Zoom account completes the field gate.",
  }),
  Object.freeze({
    id: "imap",
    title: "Connect an IMAP mailbox",
    dashboard_url: null,
    human_boundary: "The mailbox owner creates an app password in their provider and enters it only into the hidden terminal prompt.",
    automated_proof: "Deferred from the public first-install path pending the real mailbox field gate.",
  }),
  Object.freeze({
    id: "passkey",
    title: "Enroll the owner passkey",
    dashboard_url: null,
    human_boundary: "The owner opens the 15-minute link on their device and completes Face ID, fingerprint, or device PIN on the final Brain hostname.",
    automated_proof: "The technician wrapper never mints or prints the one-time link. The owner completes that action in a directly controlled terminal and display; final verification requires an enrolled device from the deployed Brain.",
  }),
  Object.freeze({
    id: "verify",
    title: "Run the handoff checks",
    dashboard_url: null,
    human_boundary: "The technician reviews each result and keeps unavailable connector or passkey checks clearly marked for follow-up.",
    automated_proof: "Doctor, health, source freshness, and enrolled-device checks run in order and stop on the first failure.",
  }),
]);

export const TECHNICIAN_RUN_STEPS = Object.freeze(TECHNICIAN_STEPS.map((step) => step.id));
export const DEFERRED_PUBLIC_CONNECTOR_STEPS = Object.freeze([
  "plaid", "google", "quickbooks", "zoom", "imap",
]);

function cliLocator(cli) {
  if (!cli?.command || !Array.isArray(cli.args)) return null;
  return Object.freeze({
    command: resolve(String(cli.command)),
    args: Object.freeze(cli.args.map((value) => resolve(String(value)))),
  });
}

function exactCommand(cli, args, platformName = process.platform) {
  if (!cli) return null;
  return renderCopyableCommand(cli.command, [...cli.args, ...args], { platformName });
}

export function technicianStatusFilePath(manifestPath) {
  return join(dirname(resolve(String(manifestPath || "brain.manifest.json"))), TECHNICIAN_STATUS_BASENAME);
}

function safeLastStepStatus(manifestPath, deps = {}) {
  const path = technicianStatusFilePath(manifestPath);
  const exists = deps.existsSync || existsSync;
  const lstat = deps.lstatSync || lstatSync;
  const read = deps.readFileSync || readFileSync;
  if (!exists(path)) return Object.freeze({ path, state: "not_recorded" });
  try {
    const identity = lstat(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.size > 64 * 1024) {
      return Object.freeze({ path, state: "invalid" });
    }
    const parsed = JSON.parse(read(path, "utf8"));
    if (parsed?.schema_version !== TECHNICIAN_STATUS_SCHEMA_VERSION ||
        parsed?.command !== "technician.step" ||
        !TECHNICIAN_RUN_STEPS.includes(parsed?.step) ||
        !["status_refresh_required", "action_required"].includes(parsed?.status) ||
        resolve(String(parsed?.manifest?.path || "")) !== resolve(manifestPath)) {
      return Object.freeze({ path, state: "invalid" });
    }
    return Object.freeze({
      path,
      state: "available",
      step: parsed.step,
      status: parsed.status,
      issue_code: /^[A-Z][A-Z0-9_]{2,79}$/.test(String(parsed.issue_code || ""))
        ? parsed.issue_code
        : null,
      retry_safe: parsed.retry_safe === true,
      requires_human: parsed.requires_human === true,
      proof_level: ["command_return_only", "live_data_plane_postconditions"].includes(parsed.proof_level)
        ? parsed.proof_level
        : "not_verified",
    });
  } catch {
    return Object.freeze({ path, state: "invalid" });
  }
}

function safeIssueCode(error) {
  const source = String(error?.code || "TECHNICIAN_STEP_FAILED").toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(source) ? source : "TECHNICIAN_STEP_FAILED";
}

export function buildTechnicianStepStatus({
  step,
  manifestPath,
  cli,
  succeeded,
  error = null,
  statusFile = null,
  proofLevel = "command_return_only",
  proof = null,
} = {}) {
  if (!TECHNICIAN_RUN_STEPS.includes(step) || !manifestPath) {
    throw new TypeError("technician status needs a reviewed step and manifest path");
  }
  const locator = cliLocator(cli);
  if (!locator) throw new TypeError("technician status needs the exact package-local CLI locator");
  const manifest = resolve(manifestPath);
  const refreshArgs = [...locator.args, "technician", manifest, "--json"];
  const uncertain = error?.uncertain === true || error?.code === "oauth_response_uncertain";
  const retryableCodes = new Set([
    "MANIFEST_NOT_FOUND",
    "QUICKBOOKS_NOT_ENABLED",
    "QUICKBOOKS_ENVIRONMENT_REQUIRED",
    "QUICKBOOKS_REDIRECT_HOST_INVALID",
    "OWNER_CANCELED",
  ]);
  const issueCode = succeeded ? "TECHNICIAN_STATUS_REFRESH_REQUIRED" : safeIssueCode(error);
  return Object.freeze({
    schema_version: TECHNICIAN_STATUS_SCHEMA_VERSION,
    command: "technician.step",
    step,
    status: succeeded ? "status_refresh_required" : "action_required",
    issue_code: issueCode,
    retry_safe: succeeded ? false : (!uncertain && retryableCodes.has(issueCode)),
    requires_human: succeeded ? false : true,
    next_action: "Run the credential-free read-only refresh using refresh.command with exactly refresh.args. Do not continue from this receipt alone or reconstruct a shell command from these fields.",
    manifest: Object.freeze({ path: manifest }),
    cli: locator,
    refresh: Object.freeze({
      command: locator.command,
      args: Object.freeze(refreshArgs),
      mutates_external_state: false,
    }),
    status_file: statusFile ? resolve(statusFile) : null,
    proof_level: succeeded && proofLevel === "live_data_plane_postconditions"
      ? "live_data_plane_postconditions"
      : "command_return_only",
    ...(succeeded && proofLevel === "live_data_plane_postconditions" && proof
      ? { proof }
      : {}),
    proof_warning: succeeded
      ? proofLevel === "live_data_plane_postconditions"
        ? "The deployed health, source freshness, and enrolled-device postconditions were checked live. This receipt stores aggregate state only."
        : "The selected command returned without an error, but live state was not inferred from its exit code or the manifest."
      : "The selected command did not complete. Review this issue and the refreshed plan before deciding whether the same step is safe to retry.",
    boundaries: Object.freeze({
      status_refresh: "agent_safe",
      credential_or_login: "requires_human",
      deploy_or_data_change: "explicit_owner_confirmation_required",
      uncertain_provider_response: "do_not_blindly_retry",
    }),
  });
}

// A child receives enough normal process context to launch a browser, find
// Node, and reach the user's OS credential store. Everything credential-like is
// excluded unless this coordinator adds that exact value for the selected step.
const SAFE_ENV_NAMES = Object.freeze([
  "PATH", "SHELL", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY", "XDG_CONFIG_HOME",
  "LOCALAPPDATA", "APPDATA", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT",
  "BRAIN_GOOGLE_TOKEN_STORE", "BRAIN_IMAP_CREDENTIAL_STORE",
]);

export function technicianChildEnvironment(base = {}, explicit = {}) {
  const result = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof base[name] === "string" && base[name] !== "") result[name] = base[name];
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (typeof value === "string" && value !== "") result[name] = value;
  }
  return result;
}

function readManifestSummary(manifestPath, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const read = deps.readFileSync || readFileSync;
  const absolute = resolve(manifestPath);
  if (!exists(absolute)) {
    return {
      path: absolute,
      exists: false,
      final_hostname: null,
      enabled_connectors: [],
      connector_environments: { quickbooks: null },
      connector_redirect_hosts: { quickbooks: null },
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(read(absolute, "utf8"));
  } catch (error) {
    throw new Error(`could not read the technician manifest: ${error.message}`);
  }
  const enabled = ["google_drive", "gmail", "calendar", "quickbooks", "zoom", "imap", "bank_feed"]
    .filter((name) => manifest?.corpora?.[name]?.enabled === true);
  const quickbooksEnvironment = typeof manifest?.corpora?.quickbooks?.environment === "string"
    ? manifest.corpora.quickbooks.environment.trim().toLowerCase()
    : null;
  const quickbooksRedirectHost = typeof manifest?.corpora?.quickbooks?.redirect_host === "string"
    ? manifest.corpora.quickbooks.redirect_host.trim().toLowerCase()
    : "localhost";
  return {
    path: absolute,
    exists: true,
    final_hostname: typeof manifest?.brain?.domain === "string" && manifest.brain.domain.trim()
      ? manifest.brain.domain.trim().toLowerCase()
      : null,
    enabled_connectors: enabled,
    connector_environments: { quickbooks: quickbooksEnvironment },
    connector_redirect_hosts: { quickbooks: quickbooksRedirectHost },
  };
}

export function technicianPlan(manifestPath, deps = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    throw new Error("usage: brain technician <manifest> [--json] [--run <step>]");
  }
  const manifest = readManifestSummary(manifestPath, deps);
  const cli = cliLocator(deps.cli);
  const refresh = cli
    ? Object.freeze({
        command: cli.command,
        args: Object.freeze([...cli.args, "technician", manifest.path, "--json"]),
        mutates_external_state: false,
      })
    : null;
  return {
    schema_version: 3,
    mode: "read_only_plan",
    status: "plan_refreshed",
    issue_code: null,
    retry_safe: true,
    requires_human: false,
    next_action: "Review the next incomplete step and obtain explicit owner approval before any command that logs in, requests a credential, deploys, or changes data.",
    proof_level: "workflow_only",
    manifest,
    cli,
    refresh,
    last_step: safeLastStepStatus(manifest.path, deps),
    warning: "This plan prepares the public first-install workflow. Live proof arrives only from the deployed health, source-freshness, and physical passkey checks.",
    coverage: {
      guided_steps: TECHNICIAN_RUN_STEPS.filter((step) => !DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step)),
      not_guided_in_this_release: [
        "Plaid connector ceremony",
        "Google connector ceremony",
        "QuickBooks connector ceremony",
        "Zoom connector ceremony",
        "IMAP connector ceremony",
        "Slack connector ceremony",
        "Notion connector ceremony",
        "Microsoft 365 connector ceremony",
        "Dropbox connector ceremony",
        "HubSpot connector ceremony",
        "watched-folder scheduling ceremony",
      ],
      note: "These sources may have separate connector commands or backlog work, but this technician plan does not claim to guide or prove them.",
    },
    rules: [
      "Run one step at a time and rerun the same step after an interruption.",
      "Keep tokens, client secrets, app passwords, invite codes, and authentication codes in provider pages or hidden terminal prompts.",
      "The owner handles login, 2FA, consent, billing, and physical-device prompts.",
      "Enroll the first passkey only after the final Brain hostname is fixed.",
    ],
    steps: TECHNICIAN_STEPS.map((step, index) => {
      let state = "not_checked";
      if (step.id === "tools") state = "ready_to_start";
      if (step.id === "cloudflare" && !manifest.exists) state = "ready_after_local_tools";
      if (["plaid", "google", "quickbooks", "zoom", "imap", "passkey", "verify"].includes(step.id) && !manifest.exists) {
        state = "waiting_for_install_record";
      }
      if (step.id === "plaid" && manifest.exists && !manifest.enabled_connectors.includes("bank_feed")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "zoom" && manifest.exists && !manifest.enabled_connectors.includes("zoom")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "google" && manifest.exists &&
          !["google_drive", "gmail", "calendar"].every((name) => manifest.enabled_connectors.includes(name))) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "quickbooks" && manifest.exists &&
          !manifest.enabled_connectors.includes("quickbooks")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "quickbooks" && manifest.exists &&
          manifest.enabled_connectors.includes("quickbooks") &&
          !["sandbox", "production"].includes(manifest.connector_environments.quickbooks)) {
        state = "requires_environment_selection";
      }
      if (step.id === "quickbooks" && manifest.exists &&
          manifest.enabled_connectors.includes("quickbooks") &&
          !["localhost", "127.0.0.1"].includes(manifest.connector_redirect_hosts.quickbooks)) {
        state = "requires_redirect_host_review";
      }
      if (step.id === "quickbooks" && manifest.exists &&
          manifest.connector_environments.quickbooks === "production") {
        state = "production_callback_unavailable";
      }
      if (step.id === "imap" && manifest.exists && !manifest.enabled_connectors.includes("imap")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "passkey" && manifest.exists && !manifest.final_hostname) {
        state = "waiting_for_final_hostname";
      }
      if (DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id)) {
        state = "deferred_from_public_first_install";
      }
      return {
        order: index + 1,
        ...step,
        command: DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id)
          ? null
          : technicianDisplayCommand(step.id, manifest.path, cli),
        state,
        ...(step.id === "quickbooks"
          ? {
              environment: manifest.connector_environments.quickbooks,
              redirect_host: manifest.connector_redirect_hosts.quickbooks,
            }
          : {}),
      };
    }),
  };
}

export function technicianDisplayCommand(step, manifestPath, cli = null, platformName = process.platform) {
  const path = resolve(manifestPath);
  if (!cli) {
    const placeholder = Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
    if (step === "google") return exactCommand(placeholder, ["technician", path, "--run", "google"], platformName);
    if (step === "imap") return exactCommand(placeholder, ["technician", path, "--run", "imap", "--host", "<imap-host>", "--user", "<email-address>"], platformName);
    if (step === "passkey") return exactCommand(placeholder, ["technician", path, "--run", "passkey", "--confirm-host", "<final-hostname>"], platformName);
    return exactCommand(placeholder, ["technician", path, "--run", step], platformName);
  }
  if (step === "google") return exactCommand(cli, ["technician", path, "--run", "google"], platformName);
  if (step === "imap") return exactCommand(cli, ["technician", path, "--run", "imap", "--host", "<imap-host>", "--user", "<email-address>"], platformName);
  if (step === "passkey") return exactCommand(cli, ["technician", path, "--run", "passkey", "--confirm-host", "<final-hostname>"], platformName);
  return exactCommand(cli, ["technician", path, "--run", step], platformName);
}

export function renderTechnicianPlan(plan) {
  const lines = [
    "",
    "Financial Brain technician setup",
    "================================",
    `Manifest: ${plan.manifest.path}`,
    `Install record: ${plan.manifest.exists ? "present, live state not checked" : "not created yet"}`,
    `Final hostname: ${plan.manifest.final_hostname || "not fixed yet"}`,
    "",
    "This screen prepares the visit. Each live check will add its own proof.",
    "The owner handles login, 2FA, consent, billing, and physical passkey prompts.",
    "Sensitive values stay in provider pages or hidden terminal prompts.",
    "Commands use <brain-cli>; resolve it from the package-local bootstrap status rather than PATH.",
    `Not guided here: ${plan.coverage.not_guided_in_this_release.join(", ")}.`,
    "",
  ];
  for (const step of plan.steps) {
    lines.push(`${step.order}. ${step.title}`);
    if (step.state !== "not_checked") lines.push(`   State: ${step.state.replaceAll("_", " ")}`);
    lines.push(`   ${step.human_boundary}`);
    if (step.command) lines.push(`   Run: ${step.command}`);
    else lines.push("   No public first-install command is available for this deferred connector ceremony.");
    if (step.dashboard_url) lines.push(`   Dashboard: ${step.dashboard_url}`);
    lines.push("");
  }
  return lines.join("\n");
}

function childCommands(step, manifestPath, flags, scriptPath) {
  const path = resolve(manifestPath);
  const command = (...args) => [scriptPath, ...args];
  switch (step) {
    case "tools": return [command("tools", path)];
    case "cloudflare": return [command("setup", path)];
    case "plaid": return [command("secrets", path)];
    case "google": return [command("connect", "google", "--scopes", String(flags.scopes || "drive,gmail,calendar"))];
    case "quickbooks": throw new Error("the QuickBooks technician step must use the in-process provider connection");
    case "zoom": return [command("connect", "zoom", path)];
    case "imap": {
      const host = String(flags.host || "").trim();
      const user = String(flags.user || "").trim();
      if (!host || !user) throw new Error("the IMAP step needs --host <imap-host> and --user <email-address>");
      const args = ["connect", "imap", path, "--host", host, "--user", user];
      if (flags.port) args.push("--port", String(flags.port));
      if (flags.source) args.push("--source", String(flags.source));
      return [command(...args)];
    }
    case "passkey": throw codedError(
      "Passkey invite creation is owner-only. Open a terminal you control directly, run the package-local `brain invite` command there, and keep the one-time link out of AI chat, captured sessions, logs, screenshots, and status files. Then rerun the final verification step to prove an enrolled device exists.",
      "passkey_human_terminal_required",
    );
    case "verify": return [];
    default: throw new Error(`--run accepts one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
  }
}

async function hiddenValue(readHidden, prompt, noun, { optional = false } = {}) {
  const entered = await readHidden({ prompt, noun, optional });
  const bytes = Buffer.isBuffer(entered) ? entered : Buffer.from(String(entered || ""), "utf8");
  if (!optional && bytes.length === 0) {
    bytes.fill(0);
    throw new Error(`${noun} cannot be empty`);
  }
  return bytes;
}

function bufferText(buffer) {
  return buffer.toString("utf8");
}

function codedError(message, code, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.uncertain === true) error.uncertain = true;
  return error;
}

function runOne(spawn, nodePath, args, env) {
  const result = spawn(nodePath, args, { stdio: "inherit", env });
  if (result?.error) throw new Error(`the technician child could not start: ${result.error.message}`);
  if (result?.status !== 0) {
    throw new Error("this technician step paused before completion. The step is ready to try again after the item above is resolved.");
  }
}

export async function runTechnicianStep({
  step,
  manifestPath,
  flags = {},
  scriptPath,
  readHidden,
  baseEnv = process.env,
  spawn = spawnSync,
  nodePath = process.execPath,
  manifestDeps = {},
  connectProvider = null,
  verifyInstallation = null,
} = {}) {
  if (!TECHNICIAN_RUN_STEPS.includes(step)) {
    throw new Error(`--run accepts one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
  }
  if (!manifestPath || !scriptPath) throw new Error("the technician step needs a manifest and installer path");
  const summary = readManifestSummary(manifestPath, manifestDeps);
  if (!["tools", "cloudflare"].includes(step) && !summary.exists) {
    throw codedError(
      "the install record is not ready yet. The Cloudflare step creates it, and then this step can continue.",
      "manifest_not_found",
    );
  }
  if (step === "google") {
    const mapping = { drive: "google_drive", gmail: "gmail", calendar: "calendar" };
    const requested = String(flags.scopes || "drive,gmail,calendar").split(",").map((value) => value.trim()).filter(Boolean);
    const missing = requested.map((name) => mapping[name]).filter((name) => !name || !summary.enabled_connectors.includes(name));
    if (missing.length) {
      throw new Error(`the install plan needs these Google sources enabled before connection: ${requested.join(", ")}`);
    }
  }
  if (step === "plaid" && !summary.enabled_connectors.includes("bank_feed")) {
    throw new Error("the install plan needs corpora.bank_feed.enabled before Plaid credential entry");
  }
  if (step === "quickbooks") {
    if (!summary.enabled_connectors.includes("quickbooks")) {
      throw codedError(
        "corpora.quickbooks.enabled is not true in this manifest. Enable it before connecting.",
        "quickbooks_not_enabled",
      );
    }
    if (!["sandbox", "production"].includes(summary.connector_environments.quickbooks)) {
      throw codedError(
        "corpora.quickbooks.environment must explicitly be sandbox or production before connecting.",
        "quickbooks_environment_required",
      );
    }
    if (summary.connector_environments.quickbooks === "production") {
      throw codedError(
        "QuickBooks production connection is not available in this release. The client-owned HTTPS callback and single-use local handoff must be implemented and field-tested first. No credential prompt or browser flow was opened.",
        "quickbooks_production_callback_unavailable",
      );
    }
    if (!["localhost", "127.0.0.1"].includes(summary.connector_redirect_hosts.quickbooks)) {
      throw codedError(
        "corpora.quickbooks.redirect_host must be localhost or 127.0.0.1. The callback listener remains local-only.",
        "quickbooks_redirect_host_invalid",
      );
    }
    if (typeof connectProvider !== "function") {
      throw new Error("the QuickBooks step needs the reviewed in-process provider connector");
    }
  }
  if (step === "passkey") {
    if (!summary.final_hostname) {
      throw new Error("the final Brain address is still open. Choose brain.domain first so the passkey is enrolled on its permanent address.");
    }
    const confirmed = String(flags["confirm-host"] || "").trim().toLowerCase();
    if (confirmed !== summary.final_hostname) {
      throw new Error(`passkey enrollment is ready after --confirm-host exactly matches ${summary.final_hostname}`);
    }
  }

  const secretBuffers = [];
  const explicitEnv = {};
  let childEnv = null;
  try {
    if (step === "plaid") {
      if (typeof readHidden !== "function") throw new Error("the Plaid step needs a secure interactive terminal");
      for (const [name, label] of [
        ["BANK_FEED_CLIENT_ID", "Plaid client ID"],
        ["BANK_FEED_SECRET", "Plaid secret"],
        ["BANK_FEED_WRAPPING_KEY_V2", "bank wrapping key v2"],
      ]) {
        const value = await hiddenValue(readHidden, `  ${label} (hidden): `, label);
        secretBuffers.push(value);
        explicitEnv[name] = bufferText(value);
      }
    }
    if (step === "google") {
      if (typeof readHidden !== "function") throw new Error("the Google step needs a secure interactive terminal");
      const clientId = await hiddenValue(readHidden, "  Google OAuth client ID (hidden): ", "Google OAuth client ID");
      const clientSecret = await hiddenValue(readHidden, "  Google OAuth client secret, if issued (hidden; Enter for none): ", "Google OAuth client secret", { optional: true });
      secretBuffers.push(clientId, clientSecret);
      explicitEnv.GOOGLE_CLIENT_ID = bufferText(clientId);
      if (clientSecret.length) explicitEnv.GOOGLE_CLIENT_SECRET = bufferText(clientSecret);
    }
    if (step === "quickbooks") {
      if (typeof readHidden !== "function") throw new Error("the QuickBooks step needs a secure interactive terminal");
      const clientId = await hiddenValue(readHidden, "  Intuit OAuth client ID (hidden): ", "Intuit OAuth client ID");
      const clientSecret = await hiddenValue(readHidden, "  Intuit OAuth client secret (hidden): ", "Intuit OAuth client secret");
      secretBuffers.push(clientId, clientSecret);
      try {
        await connectProvider({
          provider: "quickbooks",
          manifestPath,
          flags: flags.port ? { port: flags.port } : {},
          credentials: {
            clientId: bufferText(clientId),
            clientSecret: bufferText(clientSecret),
          },
        });
      } catch (error) {
        if (error?.uncertain === true) {
          throw codedError(
            "QuickBooks did not confirm the token response. No success was recorded. Rerun this same technician step instead of retrying the token exchange.",
            "oauth_response_uncertain",
            { uncertain: true },
          );
        }
        if (error?.code === "access_denied") {
          throw codedError(
            "The owner canceled QuickBooks consent. Nothing was marked connected. Rerun this same technician step when they are ready.",
            "owner_canceled",
          );
        }
        const safeMessage = String(error?.message || "QuickBooks connection failed")
          .replaceAll(bufferText(clientId), "[redacted]")
          .replaceAll(bufferText(clientSecret), "[redacted]");
        const safeError = codedError(safeMessage, error?.code || "quickbooks_connection_failed");
        safeError.name = error?.name || safeError.name;
        throw safeError;
      }
      const launcher = Object.freeze({
        command: resolve(nodePath),
        base_args: Object.freeze([resolve(scriptPath)]),
      });
      return {
        step,
        completed: true,
        commands_run: 1,
        environment: summary.connector_environments.quickbooks,
        custody: "client_local_provider_store",
        financial_authority: false,
        oauth_permission: "broad_accounting_scope_runtime_read_only",
        verification: Object.freeze([
          Object.freeze({
            purpose: "dry_run",
            command: launcher.command,
            args: Object.freeze([...launcher.base_args, "ingest", resolve(manifestPath), "--from", "quickbooks", "--dry-run"]),
            mutates_external_state: false,
          }),
          Object.freeze({
            purpose: "first_ingest_after_owner_review",
            command: launcher.command,
            args: Object.freeze([...launcher.base_args, "ingest", resolve(manifestPath), "--from", "quickbooks"]),
            mutates_external_state: true,
          }),
        ]),
      };
    }
    if (step === "zoom") {
      if (typeof readHidden !== "function") throw new Error("the Zoom step needs a secure interactive terminal");
      for (const [name, label] of [
        ["ZOOM_ACCOUNT_ID", "Zoom account ID"],
        ["ZOOM_CLIENT_ID", "Zoom client ID"],
        ["ZOOM_CLIENT_SECRET", "Zoom client secret"],
        ["ZOOM_WEBHOOK_SECRET_TOKEN", "Zoom webhook secret token"],
      ]) {
        const value = await hiddenValue(readHidden, `  ${label} (hidden): `, label);
        secretBuffers.push(value);
        explicitEnv[name] = bufferText(value);
      }
    }

    childEnv = technicianChildEnvironment(baseEnv, explicitEnv);
    const commands = childCommands(step, manifestPath, flags, resolve(scriptPath));
    for (const args of commands) runOne(spawn, nodePath, args, childEnv);
    if (step === "verify") {
      if (typeof verifyInstallation !== "function") {
        throw codedError(
          "the final handoff verifier is unavailable. No live source or passkey postcondition was inferred from child exit codes.",
          "handoff_verifier_unavailable",
        );
      }
      const proof = await verifyInstallation({ manifestPath });
      return {
        step,
        completed: true,
        commands_run: commands.length,
        proof_level: "live_data_plane_postconditions",
        proof,
      };
    }
    return { step, completed: true, commands_run: commands.length };
  } finally {
    for (const buffer of secretBuffers) buffer.fill(0);
    for (const key of Object.keys(explicitEnv)) {
      explicitEnv[key] = "";
      if (childEnv) childEnv[key] = "";
    }
  }
}
