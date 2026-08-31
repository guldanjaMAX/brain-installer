import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

function minimalEnvironment(overrides = {}) {
  const allowed = [
    "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
    "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "SHELL", "TERM",
  ];
  const environment = {};
  for (const name of allowed) {
    if (typeof process.env[name] === "string" && process.env[name]) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    shell: options.shell ?? (IS_WIN && /(?:^|[\\/])(?:npm|brain)\.cmd$/i.test(command)),
    timeout: options.timeout ?? 90_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

test("the packed CLI scaffolds a nonexistent manifest before any manifest-account lookup", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "brain-packed-fresh-")));
  try {
    const pack = run(IS_WIN ? "npm.cmd" : "npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", sandbox,
    ], { cwd: ROOT, env: minimalEnvironment() });
    assert.equal(pack.status, 0, `${pack.stdout}\n${pack.stderr}`);
    const filename = JSON.parse(pack.stdout)?.[0]?.filename;
    assert.equal(typeof filename, "string", "npm pack did not report the tarball filename");
    const archive = join(sandbox, filename);
    assert.ok(existsSync(archive), "npm did not create the reviewed tarball");

    const prefix = join(sandbox, "prefix");
    const install = run(IS_WIN ? "npm.cmd" : "npm", [
      "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
      "--prefix", prefix, archive,
    ], { cwd: sandbox, env: minimalEnvironment() });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const wrapper = IS_WIN ? join(prefix, "brain.cmd") : join(prefix, "bin", "brain");
    assert.ok(existsSync(wrapper), "the package did not install its public brain wrapper");

    const privateHome = join(sandbox, "home");
    mkdirSync(privateHome, { recursive: true });
    const baseEnvironment = minimalEnvironment({
      HOME: privateHome,
      USERPROFILE: privateHome,
      APPDATA: join(privateHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(privateHome, "AppData", "Local"),
      NO_COLOR: "1",
    });
    const manifestPath = join(sandbox, "new-brain", "brain.manifest.json");

    const noCredential = run(wrapper, ["setup", manifestPath, "--no-connect"], {
      cwd: sandbox,
      env: baseEnvironment,
      input: "",
    });
    const noCredentialOutput = `${noCredential.stdout}${noCredential.stderr}`;
    assert.notEqual(noCredential.status, 0);
    assert.match(noCredentialOutput, /owner-controlled terminal|open Terminal or PowerShell/i);
    assert.doesNotMatch(noCredentialOutput, /could not read the install manifest|CONFIG_INVALID/i);
    assert.ok(!existsSync(manifestPath), "credential refusal must not create partial local state");

    const barePath = run(wrapper, ["setup", manifestPath, "--path"], {
      cwd: sandbox,
      env: baseEnvironment,
      input: "",
    });
    const barePathOutput = `${barePath.stdout}${barePath.stderr}`;
    assert.notEqual(barePath.status, 0);
    assert.match(barePathOutput, /--path needs a value, for example: --path <value>/i);
    assert.doesNotMatch(barePathOutput, /no such folder: true/i);

    const fakeBin = join(sandbox, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    if (IS_WIN) {
      writeFileSync(join(fakeBin, "npx.cmd"), "@echo off\r\necho wrangler 4.127.1\r\n", "utf8");
      writeFileSync(join(fakeBin, "claude.cmd"), "@echo off\r\nif \"%1\"==\"--version\" echo 2.1.63 (Claude Code)& exit /b 0\r\nif \"%1 %2\"==\"auth status\" echo signed in& exit /b 0\r\nexit /b 1\r\n", "utf8");
    } else {
      const npx = join(fakeBin, "npx");
      writeFileSync(npx, "#!/bin/sh\nprintf '%s\\n' 'wrangler 4.127.1'\n", "utf8");
      chmodSync(npx, 0o755);
      const claude = join(fakeBin, "claude");
      writeFileSync(claude, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '%s\\n' '2.1.63 (Claude Code)'; exit 0; fi\nif [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then printf '%s\\n' 'signed in'; exit 0; fi\nexit 1\n", "utf8");
      chmodSync(claude, 0o755);
    }
    const toolEnvironment = {
      ...baseEnvironment,
      PATH: [fakeBin, dirname(process.execPath), "/usr/bin", "/bin"].join(IS_WIN ? ";" : ":"),
    };
    const bootstrap = run(wrapper, ["tools", manifestPath, "--json"], {
      cwd: sandbox,
      env: toolEnvironment,
      timeout: IS_WIN ? 300_000 : 90_000,
    });
    assert.equal(bootstrap.status, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);
    const bootstrapStatus = JSON.parse(bootstrap.stdout);
    assert.equal(bootstrapStatus.issue_code, "BOOTSTRAP_READY_NO_MANIFEST");
    assert.equal(bootstrapStatus.release.external_test_kit_required, false);
    assert.equal(bootstrapStatus.manifest.state, "not_created");
    assert.equal(bootstrapStatus.manifest.path, manifestPath);
    if (IS_WIN) assert.equal(bootstrapStatus.checks.dpapi_rounds, 25);
    assert.ok(existsSync(bootstrapStatus.status_file), "the packed wrapper did not write its bootstrap status");
    assert.ok(existsSync(bootstrapStatus.cli.command), "the status did not keep an exact Node locator");
    assert.ok(existsSync(bootstrapStatus.cli.args[0]), "the status did not keep an exact package-local CLI locator");
    assert.ok(
      existsSync(join(privateHome, ".claude", "skills", "financial-brain-technician", "SKILL.md")),
      "the packed bootstrap did not install its package-local technician skill",
    );
    assert.ok(!existsSync(manifestPath), "read-only bootstrap unexpectedly created the intended manifest");

    const normalClientEnvironment = minimalEnvironment({
      HOME: privateHome,
      USERPROFILE: privateHome,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(IS_WIN ? ";" : ":"),
      NO_COLOR: "1",
    });
    const technician = run(bootstrapStatus.cli.command, [
      ...bootstrapStatus.cli.args,
      "technician", manifestPath, "--json",
    ], { cwd: sandbox, env: normalClientEnvironment });
    assert.equal(technician.status, 0, `${technician.stdout}\n${technician.stderr}`);
    const plan = JSON.parse(technician.stdout);
    assert.equal(plan.mode, "read_only_plan");
    assert.equal(plan.manifest.exists, false);
    assert.deepEqual(plan.cli, bootstrapStatus.cli);
    assert.deepEqual(plan.refresh, {
      command: bootstrapStatus.cli.command,
      args: [...bootstrapStatus.cli.args, "technician", manifestPath, "--json"],
      mutates_external_state: false,
    });
    assert.ok(plan.steps.filter((step) => step.command).every((step) =>
      step.command.includes(bootstrapStatus.cli.command) &&
      step.command.includes(bootstrapStatus.cli.args[0])));
    assert.ok(plan.steps.filter((step) => ["plaid", "google", "quickbooks", "zoom", "imap"].includes(step.id))
      .every((step) => step.command === null));
    assert.equal(plan.steps.find((step) => step.id === "smoke").state, "waiting_for_install_record");
    assert.deepEqual(plan.steps.find((step) => step.id === "cloudflare").owner_only_command, {
      command: bootstrapStatus.cli.command,
      args: [...bootstrapStatus.cli.args, "technician", manifestPath, "--run", "cloudflare"],
      execution_boundary: "owner_direct_terminal",
      mutates_external_state: true,
      must_run_in_direct_owner_terminal: true,
      reveals_one_time_link: false,
    });
    assert.deepEqual(plan.steps.find((step) => step.id === "passkey").owner_only_command.args,
      [...bootstrapStatus.cli.args, "invite", manifestPath]);
    assert.doesNotMatch(JSON.stringify(plan.steps), /(^|[^\w/.-])brain technician\b/i);
    assert.match(JSON.stringify(plan.coverage), /watched-folder scheduling ceremony/i);
    const accountId = "a".repeat(32);
    const preload = join(sandbox, "offline-cloudflare.mjs");
    writeFileSync(preload, `
const accountId = ${JSON.stringify(accountId)};
const payload = (result, status = 200, success = true, errors = []) =>
  new Response(JSON.stringify({ success, result, errors }), {
    status,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const authorization = new Headers(options.headers || (typeof input === "string" ? undefined : input.headers)).get("authorization") || "";
  if (url.pathname === "/client/v4/user/tokens/verify") {
    if (authorization === "Bearer probe") return payload(null, 401, false, [{ code: 1000, message: "fixture probe" }]);
    return payload({ status: "active" });
  }
  if (url.pathname === "/client/v4/accounts") {
    return payload([{ id: accountId, name: "Packed fixture account" }]);
  }
  if (url.pathname === "/client/v4/accounts/" + accountId + "/d1/database") {
    return payload(null, 403, false, [{ code: 1001, message: "fixture read stop" }]);
  }
  return payload(null, 404, false, [{ code: 1002, message: "unexpected fixture route" }]);
};
`, "utf8");

    const scaffold = run(wrapper, ["setup", manifestPath, "--no-connect"], {
      cwd: sandbox,
      env: {
        ...baseEnvironment,
        PATH: toolEnvironment.PATH,
        CLOUDFLARE_API_TOKEN: "fixture-token-for-packed-wrapper",
        ADMIN_KEY: (["fixture-","admin-ke","y-for-pa","cked-wra","pper-000","1"].join("")),
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
      input: "Packed fixture brain\npacked-fixture\n",
    });
    const scaffoldOutput = `${scaffold.stdout}${scaffold.stderr}`;
    assert.notEqual(scaffold.status, 0, "the controlled D1 read stop should remain fail closed");
    assert.match(scaffoldOutput, /Cloudflare account "Packed fixture account"/);
    assert.match(scaffoldOutput, /D1 is not reachable/);
    assert.doesNotMatch(scaffoldOutput, /could not read the install manifest|no such folder: true/i);
    assert.ok(existsSync(manifestPath), "the installed wrapper did not scaffold the fresh manifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.infrastructure.cloudflare.account_id, accountId);
    assert.equal(manifest.client.slug, "packed-fixture");
    assert.ok(
      scaffoldOutput.indexOf(`Cloudflare account "Packed fixture account"`) < scaffoldOutput.indexOf("D1 is not reachable"),
      "the selected account must be shown before any account resource operation",
    );

    manifest.brain = { ...(manifest.brain || {}), domain: "brain.fixture.test" };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const packedModule = await import(pathToFileURL(bootstrapStatus.cli.args[0]).href);
    let smokeEnvelope = null;
    let smokeReceipt = null;
    const smokeProof = await packedModule.runPublicInstallSmoke(manifestPath, {
      resolveAdminKey: () => "fixture-packed-admin-key",
      request: async (_url, options) => {
        smokeEnvelope = JSON.parse(options.body).docs[0];
        return new Response(JSON.stringify({
          results: [{
            source_type: "install-smoke",
            source_id: "public-first-install-v1",
            doc_uid: "install-smoke:public-first-install-v1",
            status: "created",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      postReceipt: async (receipt) => { smokeReceipt = receipt; },
      drain: async () => ({ remaining: 0 }),
    });
    assert.equal(smokeEnvelope.source_type, "install-smoke");
    assert.equal(smokeEnvelope.metadata.contains_customer_data, false);
    assert.equal(smokeReceipt.source, "install-smoke");
    assert.equal(smokeReceipt.status, "ready");
    assert.equal(smokeProof.checked_via, "deployed_authenticated_ingest");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
