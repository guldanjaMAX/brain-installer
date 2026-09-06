#!/usr/bin/env node
/**
 * Credential-free source release preparation.
 *
 * This orchestrator never accepts a manifest or credential, and every child
 * receives a temporary home plus an allowlisted environment. Live field gates
 * are printed as human work only. They are never executed here.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const WRANGLER_PACKAGE = "wrangler@4.127.1";
const FULL_PROFILE = Object.freeze([
  "full-suite",
  "frontend-test",
  "frontend-build",
  "hiccup-lab",
  "plaid-fake",
  "d1-auth-atomicity",
  "passkey-protocol",
  "package-privacy",
  "history-privacy",
  "dependency-audit",
  "package-build",
  "clean-prefix-smoke",
]);
const FAST_PROFILE = Object.freeze([
  "focused-suite",
  "frontend-test",
  "frontend-build",
  "hiccup-lab-fast",
  "plaid-fake",
  "d1-auth-atomicity",
  "passkey-protocol",
  "package-privacy-fast",
  "history-privacy",
  "dependency-audit",
  "package-build",
  "clean-prefix-smoke",
]);
const SELECTABLE = new Set([...FULL_PROFILE, ...FAST_PROFILE]);

const commandStep = (id, title, command, args, proof, timeoutMs = 30 * 60_000) =>
  Object.freeze({
    id, title, command, args: Object.freeze(args), proof, timeoutMs,
    npm: false,
    network_scope: id === "d1-auth-atomicity" ? "loopback_only" : "local_only",
  });
const npmStep = (id, title, args, proof, timeoutMs = 30 * 60_000) => Object.freeze({
  id, title, command: "<npm-cli>", args: Object.freeze(args), proof, timeoutMs,
  npm: true,
  network_scope: "local_only_offline_enforced",
});

const STEP_CATALOG = Object.freeze({
  "full-suite": npmStep(
    "full-suite", "Complete offline product suite", ["test"],
    "Complete repository test-chain proof on synthetic and fixture data.", 90 * 60_000,
  ),
  "focused-suite": commandStep(
    "focused-suite", "Field harness contract tests", process.execPath,
    ["test/field-prepare.test.mjs"], "Fast source-harness contract proof.",
  ),
  "frontend-test": npmStep(
    "frontend-test", "Owner app test suite", ["--prefix", "frontend", "test"],
    "The exact owner app source passes its Vitest interaction and state-contract suite.",
  ),
  "frontend-build": npmStep(
    "frontend-build", "Owner app production bundle parity", ["--prefix", "frontend", "run", "build"],
    "The exact owner app builds and reproduces the reviewed Worker asset bundle without changing the source tree.",
  ),
  "hiccup-lab": commandStep(
    "hiccup-lab", "Complete synthetic customer hiccup lab", process.execPath,
    ["scripts/customer-hiccup-lab.mjs", "--json"],
    "Synthetic interruption and recovery proof across every curated scenario.", 60 * 60_000,
  ),
  "hiccup-lab-fast": commandStep(
    "hiccup-lab-fast", "Focused synthetic customer hiccup lab", process.execPath,
    ["scripts/customer-hiccup-lab.mjs", "--only", "technician-recovery", "--json"],
    "Fast synthetic technician failure and recovery proof.",
  ),
  "plaid-fake": commandStep(
    "plaid-fake", "Credential-free Plaid rehearsal", process.execPath,
    ["operations/plaid-sandbox-runner.mjs"],
    "Invented-provider proof only. It does not contact Plaid Sandbox or Production.",
  ),
  "d1-auth-atomicity": commandStep(
    "d1-auth-atomicity", "Local D1 auth atomicity", process.execPath,
    ["test/live/auth-d1-atomicity.mjs"],
    "Production auth modules against a disposable local D1 binding only.", 20 * 60_000,
  ),
  "passkey-protocol": commandStep(
    "passkey-protocol", "Offline passkey protocol self-test", process.execPath,
    ["test/live/passkey-permanent-hostname-acceptance.mjs", "--self-test"],
    "Receipt-schema and privacy proof only. No authenticator ceremony occurs.",
  ),
  "package-privacy": commandStep(
    "package-privacy", "Tracked-source and package privacy", process.execPath,
    ["test/package-privacy.test.mjs"],
    "Full tracked-source, packlist, content, and extracted-package privacy proof.",
  ),
  "package-privacy-fast": commandStep(
    "package-privacy-fast", "Tracked-source privacy scan", process.execPath,
    ["test/package-privacy.test.mjs", "--scan-only"],
    "Fast tracked-source privacy scan. It does not replace the full packlist gate.",
  ),
  "history-privacy": npmStep(
    "history-privacy", "Local source-history privacy",
    ["run", "privacy:history"], "Exact local HEAD history has zero privacy findings.",
  ),
  "dependency-audit": npmStep(
    "dependency-audit", "Offline dependency audit",
    ["audit", "--offline"], "Installed dependency graph checked without registry access.",
  ),
});

export function parseFieldPrepareArgs(argv) {
  const options = {
    mode: "full",
    only: [],
    output: null,
    expectSha: null,
    plan: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--fast") options.mode = "fast";
    else if (value === "--plan") options.plan = true;
    else if (value === "--json") options.json = true;
    else if (["--only", "--output", "--expect-sha"].includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`);
      if (value === "--only") {
        const selected = next.split(",").filter(Boolean);
        if (!selected.length) throw new Error("--only needs at least one step name");
        options.only.push(...selected);
      }
      if (value === "--output") options.output = next;
      if (value === "--expect-sha") options.expectSha = next;
    } else if (value === "--help") options.help = true;
    else throw new Error(`unknown option: ${value}`);
  }
  if (options.mode === "fast" && options.only.length) {
    throw new Error("--fast and --only are separate modes; choose one");
  }
  if (options.expectSha && !/^[a-f0-9]{40}$/.test(options.expectSha)) {
    throw new Error("--expect-sha needs one lowercase 40-character Git SHA");
  }
  const unknown = options.only.filter((id) => !SELECTABLE.has(id));
  if (unknown.length) throw new Error(`unknown field preparation step: ${unknown.join(", ")}`);
  return Object.freeze({ ...options, only: Object.freeze([...new Set(options.only)]) });
}

export function assertNoLiveCommand(step) {
  const text = [step.command, ...step.args].join(" ").toLowerCase();
  const forbidden = [
    "--live", "--execute", "brain.mjs setup", "brain.mjs deploy",
    "brain.mjs provision", "d1-release-field-gate.mjs",
    "disposable-cloudflare-v021-field-gate.mjs", ".manifest.json",
  ];
  for (const value of forbidden) {
    if (text.includes(value)) throw new Error(`unsafe field preparation command contains ${value}`);
  }
  return true;
}

export function buildStepPlan(options) {
  let ids = options.only.length
    ? [...options.only]
    : options.mode === "fast" ? [...FAST_PROFILE] : [...FULL_PROFILE];
  if (ids.includes("clean-prefix-smoke")) {
    // Packaging is a strict dependency of the installed smoke regardless of
    // the order supplied to --only.
    ids = ids.filter((id) => id !== "package-build" && id !== "clean-prefix-smoke");
    ids.push("package-build", "clean-prefix-smoke");
  }
  const steps = ids.map((id) => {
    if (id === "package-build" || id === "clean-prefix-smoke") {
      return Object.freeze({
        id,
        title: id === "package-build" ? "Pack and hash the exact source" : "Clean-prefix installed CLI smoke",
        internal: true,
        network_scope: "local_only_offline_enforced",
        proof: id === "package-build"
          ? "Local package bytes, byte count, file count, and SHA-256."
          : "The packed command installs offline into a temporary user prefix and prints usage.",
      });
    }
    const step = STEP_CATALOG[id];
    assertNoLiveCommand(step);
    return step;
  });
  return Object.freeze([
    Object.freeze({
      id: "source-identity",
      title: "Exact clean source identity",
      internal: true,
      network_scope: "local_only",
      proof: "Clean non-shallow Git HEAD, tree, package version, lock version, and diff check.",
    }),
    ...steps,
    Object.freeze({
      id: "source-identity-final",
      title: "Final clean source identity",
      internal: true,
      network_scope: "local_only",
      proof: "HEAD, tree, package lock, and clean-tree state still match the opening identity.",
    }),
    Object.freeze({
      id: "private-home-cleanup",
      title: "Private temporary-home cleanup",
      internal: true,
      network_scope: "local_only",
      proof: "The isolated child home and its npm cache are removed before a pass is committed.",
    }),
  ]);
}

const ALLOWED_ENVIRONMENT = Object.freeze([
  "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC",
  "PATHEXT", "LANG", "LANGUAGE", "LC_ALL", "SHELL", "TERM",
]);

export function createSafeEnvironment(source, privateHome) {
  const environment = {};
  for (const name of ALLOWED_ENVIRONMENT) {
    if (typeof source[name] === "string" && source[name]) environment[name] = source[name];
  }
  Object.assign(environment, {
    HOME: privateHome,
    USERPROFILE: privateHome,
    APPDATA: join(privateHome, "appdata", "roaming"),
    LOCALAPPDATA: join(privateHome, "appdata", "local"),
    XDG_CONFIG_HOME: join(privateHome, "config"),
    XDG_CACHE_HOME: join(privateHome, "cache"),
    TMPDIR: join(privateHome, "tmp"),
    TMP: join(privateHome, "tmp"),
    TEMP: join(privateHome, "tmp"),
    NPM_CONFIG_CACHE: join(privateHome, "npm-cache"),
    NPM_CONFIG_USERCONFIG: join(privateHome, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(privateHome, "npm-globalrc"),
    NPM_CONFIG_OFFLINE: "true",
    GIT_CONFIG_GLOBAL: join(privateHome, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    WRANGLER_SEND_METRICS: "false",
    NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    CI: "1",
    BRAIN_FIELD_PREPARE: "1",
  });
  return environment;
}

export function createCredentialFreeProviderEnvironment(source) {
  return {
    ...Object.fromEntries(Object.entries(source).filter(([name]) =>
      !/^(CLOUDFLARE_|CF_|WRANGLER_)/i.test(name))),
    WRANGLER_SEND_METRICS: "false",
    DO_NOT_TRACK: "1",
  };
}

export function buildNpmInvocation(npmCli, args) {
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([npmCli, ...args]),
    shell: false,
  });
}

export function buildWindowsBatchInvocation(comspec, wrapper) {
  if (/["\r\n]/.test(wrapper)) throw new Error("windows_wrapper_path_refused");
  const escaped = wrapper.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/!/g, "^!");
  return Object.freeze({
    command: comspec,
    args: Object.freeze(["/d", "/s", "/c", `"${escaped}"`]),
    shell: false,
  });
}

function resolveNpmCli(environment = process.env) {
  const candidate = environment.npm_execpath;
  if (!candidate) throw new Error("npm_cli_unavailable_run_through_npm_script");
  const cli = realpathSync(candidate);
  const info = lstatSync(cli);
  if (!info.isFile() || info.isSymbolicLink() || basename(cli) !== "npm-cli.js") {
    throw new Error("npm_cli_locator_refused");
  }
  const npmPackage = JSON.parse(readFileSync(resolve(dirname(cli), "..", "package.json"), "utf8"));
  if (npmPackage.name !== "npm" || !/^\d+\.\d+\.\d+/.test(String(npmPackage.version || ""))) {
    throw new Error("npm_cli_package_refused");
  }
  return cli;
}

function run(command, args, { env, timeoutMs = 30 * 60_000, capture = false, cwd = ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal || null,
    errorCode: result.error?.code || null,
    stdout: capture ? String(result.stdout || "") : "",
    stderr: capture ? String(result.stderr || "") : "",
  };
}

function runNpm(args, options) {
  const invocation = buildNpmInvocation(resolveNpmCli(), args);
  return run(invocation.command, invocation.args, options);
}

export function assertNoProjectNpmConfig(root) {
  if (existsSync(join(root, ".npmrc"))) throw new Error("project_npm_config_refused");
  return true;
}

function git(args, env) {
  const result = run("git", args, { env, capture: true, timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`git_${args[0]}_failed`);
  return result.stdout.trim();
}

function readSourceIdentity(expectSha, env) {
  const top = realpathSync(git(["rev-parse", "--show-toplevel"], env));
  if (top !== realpathSync(ROOT)) throw new Error("source_root_mismatch");
  const headSha = git(["rev-parse", "HEAD"], env);
  if (expectSha && headSha !== expectSha) throw new Error("expected_source_sha_mismatch");
  if (git(["rev-parse", "--is-shallow-repository"], env) !== "false") {
    throw new Error("shallow_source_refused");
  }
  const working = git(["status", "--porcelain=v1", "--untracked-files=all"], env);
  if (working) throw new Error("working_tree_not_clean");
  assertNoProjectNpmConfig(ROOT);
  const diffCheck = run("git", ["diff", "--check", "HEAD"], { env, capture: true, timeoutMs: 60_000 });
  if (!diffCheck.ok || diffCheck.stdout || diffCheck.stderr) throw new Error("git_diff_check_failed");
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const lockVersion = packageLock.packages?.[""]?.version || packageLock.version;
  if (packageJson.version !== lockVersion) throw new Error("package_lock_version_mismatch");
  return Object.freeze({
    head_sha: headSha,
    tree_sha: git(["rev-parse", "HEAD^{tree}"], env),
    package_name: packageJson.name,
    package_version: packageJson.version,
    package_lock_sha256: createHash("sha256")
      .update(readFileSync(join(ROOT, "package-lock.json"))).digest("hex"),
    working_tree_clean: true,
    shallow_repository: false,
  });
}

function makeOutputDirectory(requested) {
  if (requested) {
    const output = resolve(requested);
    const relativeToRoot = relative(ROOT, output);
    const insideRoot = relativeToRoot === "" || (
      relativeToRoot !== ".." &&
      !relativeToRoot.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToRoot)
    );
    const insidePrivateRoot = relativeToRoot === ".field-prepare" ||
      relativeToRoot.startsWith(`.field-prepare${sep}`);
    if (insideRoot && !insidePrivateRoot) {
      throw new Error("custom_output_inside_source_checkout_refused");
    }
    if (existsSync(output)) throw new Error("output directory already exists");
    const parent = dirname(output);
    const parentInfo = lstatSync(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error("output parent must be a real directory");
    }
    mkdirSync(output, { mode: 0o700 });
    if (!IS_WINDOWS) chmodSync(output, 0o700);
    return output;
  }
  const base = join(ROOT, ".field-prepare");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const baseInfo = lstatSync(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error("private field preparation root is unsafe");
  }
  if (!IS_WINDOWS) chmodSync(base, 0o700);
  const output = mkdtempSync(join(base, "run-"));
  if (!IS_WINDOWS) chmodSync(output, 0o700);
  return output;
}

function replacePrivateFile(path, bytes) {
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  if (!IS_WINDOWS) chmodSync(path, 0o600);
}

export function persistReceiptArtifacts(receipt, { receiptPath, checklistPath }, {
  write = replacePrivateFile,
  final = false,
} = {}) {
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const checklistBytes = `${renderFieldChecklist(receipt)}\n`;
  if (final) {
    // The receipt is authoritative. Commit it only after the matching human
    // checklist is durable, so a checklist failure cannot leave a pass receipt.
    write(checklistPath, checklistBytes);
    write(receiptPath, receiptBytes);
  } else {
    write(receiptPath, receiptBytes);
    write(checklistPath, checklistBytes);
  }
}

function safeCode(error, fallback) {
  const value = String(error?.message || error || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return value.replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}

const FIELD_GATES = Object.freeze([
  Object.freeze({ id: "physical_windows_install", title: "Clean Windows owner profile", proof: "Install the exact tarball in a standard user profile, run the package-local command, complete the 25-round DPAPI gate, then interrupt and resume once." }),
  Object.freeze({ id: "disposable_cloudflare", title: "Disposable Cloudflare Brain", proof: "With separate approval, prove browser OAuth, exact account choice, D1 and Vectorize creation, schema 32, fixed public smoke, one interrupted migration, vector backlog and drain, then confirm cleanup." }),
  Object.freeze({ id: "physical_passkeys", title: "Permanent-host passkey ceremony", proof: "Two people use two authenticator types each. Prove enroll, logout and login, second device, revoke with immediate session denial, recovery, and last-owner refusal." }),
  Object.freeze({ id: "plaid_sandbox", title: "Plaid Sandbox through the deployed Brain", proof: "Complete owner Link, assign every masked account, sync history and pagination, change one transaction, prove webhook plus scheduled fallback, update mode, response-loss replay, and confirmed removal." }),
  Object.freeze({ id: "quickbooks_sandbox", title: "QuickBooks Online Sandbox", proof: "Complete Intuit consent, company identity and same-company reconnect, wrong-company refusal, refresh, pagination, changed record, outage retry, retrieval, disconnect retention, and a separate forget preview." }),
  Object.freeze({ id: "watched_folder", title: "Watched-folder lifecycle", proof: "On the target computer add, edit, and remove a low-sensitivity file, then rename or disconnect the approved test folder and prove the Brain reports the gap without mass deletion." }),
  Object.freeze({ id: "bank_exports", title: "Real bank-export normalization", proof: "With explicit approval, import reviewed low-sensitivity CSV and OFX or QFX exports from two institutions, compare counts and totals, then inspect provenance and every skipped row." }),
]);

export function renderFieldChecklist(receipt) {
  const source = receipt.source || {};
  const artifact = receipt.package || {};
  const stop = receipt.status === "source_preparation_passed"
    ? "The offline preparation passed. Continue only with the separately approved human gates below."
    : "Stop before live testing. Resolve the offline failure or complete the full default profile first.";
  const lines = [
    "# Financial Brain human field checklist",
    "",
    `Generated: ${receipt.generated_at}`,
    `Source preparation state: ${receipt.status}`,
    `Proof boundary: synthetic, local, loopback, and registry-offline only`,
    "",
    stop,
    "",
    "## Exact candidate",
    "",
    `- Git commit: ${source.head_sha || "not proven"}`,
    `- Git tree: ${source.tree_sha || "not proven"}`,
    `- Package: ${source.package_name || "not proven"}@${source.package_version || "not proven"}`,
    `- Tarball: ${artifact.filename || "not built"}`,
    `- Tarball bytes: ${artifact.bytes ?? "not built"}`,
    `- Tarball SHA-256: ${artifact.sha256 || "not built"}`,
    "",
    "## Before any live action",
    "",
    "- [ ] The exact commit, tree, tarball byte count, and SHA-256 above match the reviewed candidate.",
    "- [ ] field-prepare-receipt.json exists and its exact status is source_preparation_passed.",
    "- [ ] Every default credential-free step in that receipt is passed.",
    "- [ ] The owner is present for login, 2FA, consent, billing, and passkey gestures.",
    "- [ ] Credentials stay in owner-controlled hidden prompts. They are not pasted into chat, argv, logs, screenshots, receipts, or manifests.",
    "- [ ] The approved test uses disposable or low-sensitivity data and names its cleanup owner.",
    "",
    "## Human and provider gates",
    "",
  ];
  for (const gate of FIELD_GATES) {
    lines.push(`- [ ] **${gate.title}.** ${gate.proof}`);
  }
  lines.push(
    "",
    "## Safe planning commands",
    "",
    "These commands print local plans or templates. They do not perform the live action:",
    "",
    "```bash",
    "node test/live/disposable-cloudflare-v021-field-gate.mjs --plan",
    "node test/live/passkey-permanent-hostname-acceptance.mjs --plan",
    "node test/live/supervised-permanent-hostname-v021-field-gate.mjs --plan",
    "```",
    "",
    "This checklist is not approval by itself. A green source-preparation receipt does not prove Cloudflare, a physical passkey, Plaid Sandbox, QuickBooks Sandbox, a bank institution, or a customer corpus.",
    "",
  );
  return lines.join("\n");
}

function baseReceipt(options, plan) {
  return {
    schema_version: 1,
    run_id: randomUUID(),
    generated_at: new Date().toISOString(),
    completed_at: null,
    status: "running",
    profile: options.only.length ? "selected" : options.mode,
    scope: "source_preparation_only",
    proof_level: "offline_synthetic_only",
    ready_for_live_accounts: false,
    live_field_gates_run: false,
    customer_data_read: false,
    customer_manifests_read: false,
    credential_stores_read: false,
    live_accounts_contacted: false,
    external_network_allowed: false,
    tooling: {
      wrangler_package: WRANGLER_PACKAGE,
      wrangler_resolution: "locked_local_dev_dependency",
    },
    source: null,
    package: null,
    steps: plan.map((step) => ({
      id: step.id,
      title: step.title,
      status: "pending",
      proof: step.proof,
      duration_ms: null,
      exit_code: null,
      failure_code: null,
      network_scope: step.network_scope,
    })),
    human_field_gates: FIELD_GATES.map((gate) => ({ id: gate.id, status: "pending_human_proof" })),
  };
}

function receiptIsCompleteDefault(receipt, options) {
  return options.mode === "full" && options.only.length === 0 &&
    receipt.steps.every((step) => step.status === "passed");
}

function packageSource(output, env, source) {
  const result = runNpm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", output,
  ], { env, capture: true, timeoutMs: 5 * 60_000 });
  if (!result.ok) throw new Error("npm_pack_failed");
  let metadata;
  try { metadata = JSON.parse(result.stdout)?.[0]; }
  catch { throw new Error("npm_pack_invalid_json"); }
  if (!metadata?.filename || !Array.isArray(metadata.files)) throw new Error("npm_pack_incomplete_receipt");
  const expected = `${source.package_name}-${source.package_version}.tgz`;
  if (metadata.filename !== expected) throw new Error("npm_pack_filename_mismatch");
  const archive = join(output, metadata.filename);
  const info = statSync(archive);
  if (!info.isFile() || info.size < 1) throw new Error("npm_pack_archive_missing");
  if (!IS_WINDOWS) chmodSync(archive, 0o600);
  return {
    path: archive,
    receipt: {
      filename: metadata.filename,
      bytes: info.size,
      sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      file_count: metadata.files.length,
    },
  };
}

function cleanPrefixSmoke(archive, privateHome, env) {
  if (!archive || !existsSync(archive)) throw new Error("packed_archive_required");
  const prefix = join(privateHome, "installed");
  const install = runNpm([
    "install", "--global", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefix", prefix, archive,
  ], { env, capture: true, cwd: privateHome, timeoutMs: 5 * 60_000 });
  if (!install.ok) throw new Error("clean_prefix_install_failed");
  const wrapper = IS_WINDOWS ? join(prefix, "brain.cmd") : join(prefix, "bin", "brain");
  if (!existsSync(wrapper)) throw new Error("installed_brain_wrapper_missing");
  const invocation = IS_WINDOWS
    ? buildWindowsBatchInvocation(env.ComSpec || env.COMSPEC || "cmd.exe", wrapper)
    : { command: wrapper, args: [] };
  const smoke = run(invocation.command, invocation.args, {
    env, capture: true, cwd: privateHome, timeoutMs: 60_000,
  });
  if (!smoke.ok || !/brain setup/i.test(smoke.stdout)) throw new Error("installed_brain_usage_failed");
}

function help() {
  return `Usage: npm run field:prepare -- [options]

Default runs the complete offline profile. It does not run a provider or Cloudflare field gate.

  --fast                 shorter iteration profile; never release-ready
  --only <id[,id...]>    run selected checks; never release-ready
  --expect-sha <sha>     refuse any other exact source commit
  --output <new-dir>     write private artifacts to a new directory
  --plan [--json]        print the non-live plan without running it

Selectable ids: ${[...SELECTABLE].sort().join(", ")}`;
}

export async function runFieldPrepare(options, dependencies = {}) {
  const plan = buildStepPlan(options);
  if (options.plan) {
    return {
      schema_version: 1,
      mode: options.only.length ? "selected" : options.mode,
      live_actions: false,
      external_network_allowed: false,
      reads_customer_manifest: false,
      reads_credential_store: false,
      steps: plan.map(({ id, title, proof, network_scope }) => ({ id, title, proof, network_scope })),
    };
  }

  const output = makeOutputDirectory(options.output);
  const receiptPath = join(output, "field-prepare-receipt.json");
  const checklistPath = join(output, "HUMAN-FIELD-CHECKLIST.md");
  const privateHome = mkdtempSync(join(tmpdir(), "brain-field-prepare-home-"));
  const environment = createSafeEnvironment(process.env, privateHome);
  for (const directory of [environment.APPDATA, environment.LOCALAPPDATA, environment.XDG_CONFIG_HOME,
    environment.XDG_CACHE_HOME, environment.TMPDIR]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = baseReceipt(options, plan);
  let archive = null;
  let privateHomeRemoved = false;
  const identityReader = dependencies.readSourceIdentity || readSourceIdentity;
  const commandRunner = dependencies.runCommand || run;
  const removePrivateHome = dependencies.removePrivateHome || ((path) =>
    rmSync(path, { recursive: true, force: true }));
  const persist = (final = false) => persistReceiptArtifacts(receipt, {
    receiptPath, checklistPath,
  }, { write: dependencies.writePrivateFile || replacePrivateFile, final });
  persist();

  let blocked = false;
  try {
    for (const step of plan) {
      // The closing identity check always runs. It is read-only and catches a
      // failed child that modified source before the fail-fast boundary fired.
      if (blocked && !["source-identity-final", "private-home-cleanup"].includes(step.id)) {
        receipt.steps.find((item) => item.id === step.id).status = "not_run_after_failure";
        persist();
        continue;
      }
      const record = receipt.steps.find((item) => item.id === step.id);
      record.status = "running";
      persist();
      console.log(`\nFIELD PREPARE: ${step.title}`);
      const started = Date.now();
      try {
        if (step.id === "source-identity") {
          receipt.source = { ...identityReader(options.expectSha, environment), end_clean: null };
        }
        else if (step.id === "source-identity-final") {
          const finalIdentity = identityReader(options.expectSha || receipt.source?.head_sha, environment);
          if (receipt.source && (
            finalIdentity.head_sha !== receipt.source.head_sha ||
            finalIdentity.tree_sha !== receipt.source.tree_sha ||
            finalIdentity.package_lock_sha256 !== receipt.source.package_lock_sha256
          )) throw new Error("source_identity_changed_during_run");
          if (receipt.source) receipt.source = { ...receipt.source, end_clean: true };
        }
        else if (step.id === "package-build") {
          const packed = packageSource(output, environment, receipt.source);
          archive = packed.path;
          receipt.package = packed.receipt;
        } else if (step.id === "clean-prefix-smoke") {
          cleanPrefixSmoke(archive || (receipt.package && join(output, receipt.package.filename)), privateHome, environment);
        } else if (step.id === "private-home-cleanup") {
          removePrivateHome(privateHome);
          privateHomeRemoved = true;
        } else {
          const child = step.npm
            ? runNpm(step.args, { env: environment, timeoutMs: step.timeoutMs })
            : commandRunner(step.command, step.args, { env: environment, timeoutMs: step.timeoutMs });
          if (!child.ok) {
            const failure = new Error(`${step.id}_failed`);
            failure.exitCode = Number.isInteger(child.status) ? child.status : null;
            throw failure;
          }
        }
        record.status = "passed";
        console.log(`PASS: ${step.title}`);
      } catch (error) {
        record.status = "failed";
        record.exit_code = Number.isInteger(error?.exitCode) ? error.exitCode : null;
        record.failure_code = safeCode(error, `${step.id}_failed`);
        blocked = true;
        console.error(`BLOCKED: ${step.title} (${record.failure_code})`);
      }
      record.duration_ms = Date.now() - started;
      persist();
    }
    receipt.completed_at = new Date().toISOString();
    if (blocked) receipt.status = "blocked_source_preparation";
    else if (receiptIsCompleteDefault(receipt, options)) receipt.status = "source_preparation_passed";
    else receipt.status = "partial_source_preparation";
    persist(true);
    return { receipt, output, receiptPath, checklistPath };
  } finally {
    if (!privateHomeRemoved) {
      try { removePrivateHome(privateHome); }
      catch { /* A planned cleanup failure is already a blocking receipt step. */ }
    }
  }
}

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (IS_MAIN) {
  try {
    const options = parseFieldPrepareArgs(process.argv.slice(2));
    if (options.help) {
      console.log(help());
      process.exit(0);
    }
    const result = await runFieldPrepare(options);
    if (options.plan) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`\nField preparation: ${result.receipt.status}`);
      console.log(`Private receipt: ${result.receiptPath}`);
      console.log(`Human checklist: ${result.checklistPath}`);
      if (result.receipt.status !== "source_preparation_passed") {
        console.log("Live/provider testing remains blocked by this receipt.");
      } else {
        console.log("Source preparation passed. The human field checklist is still required.");
      }
      process.exitCode = result.receipt.status === "blocked_source_preparation" ? 1 : 0;
    }
  } catch (error) {
    console.error(`Field preparation refused: ${safeCode(error, "field_prepare_failed")}`);
    process.exitCode = 1;
  }
}
