import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
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

test("the packed CLI scaffolds a nonexistent manifest before any manifest-account lookup", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-packed-fresh-"));
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
    assert.match(noCredentialOutput, /cannot prompt securely|interactive terminal for hidden entry/i);
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
    } else {
      const npx = join(fakeBin, "npx");
      writeFileSync(npx, "#!/bin/sh\nprintf '%s\\n' 'wrangler 4.127.1'\n", "utf8");
      chmodSync(npx, 0o755);
    }
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
        PATH: [fakeBin, dirname(process.execPath), "/usr/bin", "/bin"].join(IS_WIN ? ";" : ":"),
        CLOUDFLARE_API_TOKEN: "fixture-token-for-packed-wrapper",
        ADMIN_KEY: "fixture-admin-key-for-packed-wrapper-0001",
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
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
