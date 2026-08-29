/**
 * A small coordinator for the install-day account ceremonies.
 *
 * It deliberately does not become another credential store. Dashboard values
 * are read with the installer's existing hidden-input primitive, passed to one
 * short-lived child command through an allowlisted environment, then the input
 * buffers are zeroed. Nothing secret is placed in argv, a receipt, or JSON.
 *
 * The default command is read-only and machine-readable. This lets a human
 * technician, Codex, or another local assistant guide the same reviewed steps
 * without teaching an agent how to hold credentials.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const TECHNICIAN_STEPS = Object.freeze([
  Object.freeze({
    id: "tools",
    title: "Install and verify Claude Code, the Brain CLI, and Wrangler",
    dashboard_url: "https://financialbrain.ai/install",
    human_boundary: "The owner signs in to Claude in their browser. The technician runs Anthropic's interactive doctor and never enables permission bypass.",
    automated_proof: "The installer verifies the Claude CLI version and sign-in, runs claude doctor in a real terminal, and runs the pinned Wrangler 4 CLI with a credential-scrubbed environment.",
  }),
  Object.freeze({
    id: "cloudflare",
    title: "Install the private Brain",
    dashboard_url: "https://dash.cloudflare.com/profile/api-tokens",
    human_boundary: "The owner signs in, completes 2FA, and creates the least-privilege token. The token is pasted only into the hidden terminal prompt.",
    automated_proof: "The installer verifies the token, provisions the exact account, deploys, migrates, and runs health checks.",
  }),
  Object.freeze({
    id: "google",
    title: "Connect Google Drive, Gmail, and Calendar",
    dashboard_url: "https://console.cloud.google.com/apis/credentials",
    human_boundary: "The owner chooses or creates the Google project and approves the OAuth consent screen in their browser.",
    automated_proof: "The connector stores the refresh grant locally and dry-runs each requested Google source.",
  }),
  Object.freeze({
    id: "zoom",
    title: "Connect Zoom cloud transcripts",
    dashboard_url: "https://marketplace.zoom.us/develop/create",
    human_boundary: "A Zoom admin creates a Server-to-Server OAuth app, grants the recording scope, and later saves the verified webhook subscription.",
    automated_proof: "The connector probes the account and plan, writes Worker secrets, proves the live webhook challenge, and only then prints the URL to save.",
  }),
  Object.freeze({
    id: "imap",
    title: "Connect an IMAP mailbox",
    dashboard_url: null,
    human_boundary: "The mailbox owner creates an app password in their provider and enters it only into the hidden terminal prompt.",
    automated_proof: "The connector performs a real read before storing the app password locally.",
  }),
  Object.freeze({
    id: "passkey",
    title: "Enroll the owner passkey",
    dashboard_url: null,
    human_boundary: "The owner opens the 15-minute link on their device and completes Face ID, fingerprint, or device PIN on the final Brain hostname.",
    automated_proof: "The live Brain records privacy-safe ceremony outcome and timing. A local rehearsal cannot prove the physical-device ceremony.",
  }),
  Object.freeze({
    id: "verify",
    title: "Run the handoff checks",
    dashboard_url: null,
    human_boundary: "The technician reads every warning and records real connector and passkey results without converting an unavailable state into a pass.",
    automated_proof: "Doctor, health, source freshness, and enrolled-device checks run in order and stop on the first failure.",
  }),
]);

export const TECHNICIAN_RUN_STEPS = Object.freeze(TECHNICIAN_STEPS.map((step) => step.id));

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
    return { path: absolute, exists: false, final_hostname: null, enabled_connectors: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(read(absolute, "utf8"));
  } catch (error) {
    throw new Error(`could not read the technician manifest: ${error.message}`);
  }
  const enabled = ["google_drive", "gmail", "calendar", "zoom", "imap"]
    .filter((name) => manifest?.corpora?.[name]?.enabled === true);
  return {
    path: absolute,
    exists: true,
    final_hostname: typeof manifest?.brain?.domain === "string" && manifest.brain.domain.trim()
      ? manifest.brain.domain.trim().toLowerCase()
      : null,
    enabled_connectors: enabled,
  };
}

export function technicianPlan(manifestPath, deps = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    throw new Error("usage: brain technician <manifest> [--json] [--run <step>]");
  }
  const manifest = readManifestSummary(manifestPath, deps);
  return {
    schema_version: 2,
    mode: "read_only_plan",
    proof_level: "workflow_only",
    manifest,
    warning: "No account, OAuth grant, webhook, mailbox, or physical passkey is proven by this plan.",
    rules: [
      "Run one step at a time and rerun the same step after an interruption.",
      "Never paste a token, client secret, app password, invite code, or authentication code into an agent chat.",
      "The owner handles login, 2FA, consent, billing, and physical-device prompts.",
      "Enroll the first passkey only after the final Brain hostname is fixed.",
    ],
    steps: TECHNICIAN_STEPS.map((step, index) => {
      let state = "not_checked";
      if (step.id === "tools") state = "ready_to_start";
      if (step.id === "cloudflare" && !manifest.exists) state = "ready_after_local_tools";
      if (["google", "zoom", "imap", "passkey", "verify"].includes(step.id) && !manifest.exists) {
        state = "blocked_until_install_record_exists";
      }
      if (step.id === "zoom" && manifest.exists && !manifest.enabled_connectors.includes("zoom")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "google" && manifest.exists &&
          !["google_drive", "gmail", "calendar"].every((name) => manifest.enabled_connectors.includes(name))) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "imap" && manifest.exists && !manifest.enabled_connectors.includes("imap")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "passkey" && manifest.exists && !manifest.final_hostname) {
        state = "blocked_until_final_hostname";
      }
      return {
        order: index + 1,
        ...step,
        command: technicianDisplayCommand(step.id, manifest.path),
        state,
      };
    }),
  };
}

export function technicianDisplayCommand(step, manifestPath) {
  const quoted = JSON.stringify(resolve(manifestPath));
  if (step === "google") return `brain technician ${quoted} --run google`;
  if (step === "imap") return `brain technician ${quoted} --run imap --host <imap-host> --user <email-address>`;
  if (step === "passkey") return `brain technician ${quoted} --run passkey --confirm-host <final-hostname>`;
  return `brain technician ${quoted} --run ${step}`;
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
    "This screen is a plan, not proof that anything is connected.",
    "The owner handles login, 2FA, consent, billing, and physical passkey prompts.",
    "Secrets go only into hidden terminal prompts, never into agent chat.",
    "",
  ];
  for (const step of plan.steps) {
    lines.push(`${step.order}. ${step.title}`);
    if (step.state !== "not_checked") lines.push(`   State: ${step.state.replaceAll("_", " ")}`);
    lines.push(`   ${step.human_boundary}`);
    lines.push(`   Run: ${step.command}`);
    if (step.dashboard_url) lines.push(`   Dashboard: ${step.dashboard_url}`);
    lines.push("");
  }
  return lines.join("\n");
}

function childCommands(step, manifestPath, flags, scriptPath) {
  const path = resolve(manifestPath);
  const command = (...args) => [scriptPath, ...args];
  switch (step) {
    case "tools": return [command("tools")];
    case "cloudflare": return [command("setup", path)];
    case "google": return [command("connect", "google", "--scopes", String(flags.scopes || "drive,gmail,calendar"))];
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
    case "passkey": return [command("invite", path)];
    case "verify": return [
      command("doctor", path),
      command("health", path),
      command("sources", path),
      command("devices", path),
    ];
    default: throw new Error(`--run must be one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
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

function runOne(spawn, nodePath, args, env) {
  const result = spawn(nodePath, args, { stdio: "inherit", env });
  if (result?.error) throw new Error(`the technician child could not start: ${result.error.message}`);
  if (result?.status !== 0) {
    throw new Error("the technician step did not complete. Nothing was marked done. Fix the message above and rerun the same command.");
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
} = {}) {
  if (!TECHNICIAN_RUN_STEPS.includes(step)) {
    throw new Error(`--run must be one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
  }
  if (!manifestPath || !scriptPath) throw new Error("the technician step needs a manifest and installer path");
  const summary = readManifestSummary(manifestPath, manifestDeps);
  if (!["tools", "cloudflare"].includes(step) && !summary.exists) {
    throw new Error("the install manifest does not exist yet. Run the cloudflare step first.");
  }
  if (step === "google") {
    const mapping = { drive: "google_drive", gmail: "gmail", calendar: "calendar" };
    const requested = String(flags.scopes || "drive,gmail,calendar").split(",").map((value) => value.trim()).filter(Boolean);
    const missing = requested.map((name) => mapping[name]).filter((name) => !name || !summary.enabled_connectors.includes(name));
    if (missing.length) {
      throw new Error(`the manifest must enable every requested Google source before connection: ${requested.join(", ")}`);
    }
  }
  if (step === "passkey") {
    if (!summary.final_hostname) {
      throw new Error("the manifest has no final brain.domain. Settle the final hostname before enrolling a passkey.");
    }
    const confirmed = String(flags["confirm-host"] || "").trim().toLowerCase();
    if (confirmed !== summary.final_hostname) {
      throw new Error(`passkey enrollment is blocked until --confirm-host exactly matches ${summary.final_hostname}`);
    }
  }

  const secretBuffers = [];
  const explicitEnv = {};
  let childEnv = null;
  try {
    if (step === "google") {
      if (typeof readHidden !== "function") throw new Error("the Google step needs a secure interactive terminal");
      const clientId = await hiddenValue(readHidden, "  Google OAuth client ID (hidden): ", "Google OAuth client ID");
      const clientSecret = await hiddenValue(readHidden, "  Google OAuth client secret, if issued (hidden; Enter for none): ", "Google OAuth client secret", { optional: true });
      secretBuffers.push(clientId, clientSecret);
      explicitEnv.GOOGLE_CLIENT_ID = bufferText(clientId);
      if (clientSecret.length) explicitEnv.GOOGLE_CLIENT_SECRET = bufferText(clientSecret);
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
    return { step, completed: true, commands_run: commands.length };
  } finally {
    for (const buffer of secretBuffers) buffer.fill(0);
    for (const key of Object.keys(explicitEnv)) {
      explicitEnv[key] = "";
      if (childEnv) childEnv[key] = "";
    }
  }
}
