/**
 * Credential-free D1 acceptance for auth single-use and lockout invariants.
 *
 * This launches the production auth modules behind Wrangler's local D1
 * binding, applies the real migration chain to a disposable database, and
 * sends parallel HTTP requests. It never contacts Cloudflare, reads an account
 * credential, or uses customer data. Run manually from the repository root:
 *
 *   node test/live/auth-d1-atomicity.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const fixture = join(HERE, "fixtures", "auth-atomicity-worker.mjs");
const migrations = join(ROOT, "migrations", "d1");
const wranglerCli = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const expectedWranglerVersion = "4.127.1";
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
assert.equal(packageJson.devDependencies?.wrangler, expectedWranglerVersion,
  "Wrangler must remain an exact dev dependency");
assert.equal(packageLock.packages?.["node_modules/wrangler"]?.version, expectedWranglerVersion,
  "package-lock must pin the exact Wrangler used by this gate");
assert.equal(existsSync(wranglerCli), true,
  "run npm ci --ignore-scripts before the local D1 auth gate");
const installedWrangler = JSON.parse(readFileSync(join(ROOT, "node_modules", "wrangler", "package.json"), "utf8"));
assert.equal(installedWrangler.version, expectedWranglerVersion,
  "installed Wrangler does not match the reviewed package lock");
const temporary = mkdtempSync(join(tmpdir(), "brain-auth-d1-"));
const persistence = join(temporary, "state");
const config = join(temporary, "wrangler.jsonc");
const database = "auth-atomicity-local";

// Explicitly remove provider credentials from both Wrangler subprocesses. The
// harness is evidence only if it cannot silently cross the local boundary.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(CLOUDFLARE_|CF_|WRANGLER_)/i.test(name)));

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerCli, ...args], {
      cwd: ROOT, env: childEnv, stdio: options.stdio || ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve({ child, output })
      : reject(new Error(`wrangler exited ${code}: ${output.slice(-2_000)}`)));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function post(base, path) {
  const response = await fetch(base + path, {
    method: "POST", signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  return { status: response.status, body: await response.json() };
}

let dev = null;
try {
  writeFileSync(config, JSON.stringify({
    name: "auth-atomicity-local",
    main: fixture,
    compatibility_date: "2026-08-29",
    d1_databases: [{
      binding: "DB", database_name: database,
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: migrations,
    }],
  }, null, 2));

  await run([
    "d1", "migrations", "apply", database, "--local",
    "--persist-to", persistence, "--config", config,
  ]);

  const port = await freePort();
  dev = spawn(process.execPath, [wranglerCli,
    "dev", "--local", "--ip", "127.0.0.1",
    "--port", String(port), "--persist-to", persistence, "--config", config,
  ], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let devOutput = "";
  dev.stdout.on("data", (chunk) => { devOutput += chunk; });
  dev.stderr.on("data", (chunk) => { devOutput += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (dev.exitCode !== null) throw new Error(`wrangler dev stopped: ${devOutput.slice(-2_000)}`);
    try {
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `wrangler dev did not become ready: ${devOutput.slice(-2_000)}`);

  assert.equal((await post(base, "/reset")).status, 200);
  const challenges = await Promise.all(Array.from(
    { length: 24 }, () => post(base, "/consume/challenge"),
  ));
  assert.equal(challenges.filter((result) => result.body.consumed).length, 1);

  const enrollments = await Promise.all(Array.from(
    { length: 24 }, () => post(base, "/consume/enrollment"),
  ));
  assert.equal(enrollments.filter((result) => result.body.consumed).length, 1);

  const oauth = await Promise.all(Array.from(
    { length: 24 }, () => post(base, "/consume/oauth"),
  ));
  assert.equal(oauth.filter((result) => result.status === 200).length, 1);

  const counterRace = await post(base, "/consume/passkey-counter");
  assert.deepEqual(counterRace.body, { winners: 1 });

  const revocations = await Promise.all([
    post(base, "/revoke/owner-a"), post(base, "/revoke/owner-b"),
  ]);
  assert.equal(revocations.filter((result) => result.body.removed).length, 1);

  const final = await post(base, "/state");
  assert.deepEqual(final.body, {
    challenges: 0,
    unused_enrollments: 0,
    oauth_codes: 0,
    oauth_tokens: 1,
    succeeded_passkey_events: 1,
    owner_passkeys: 1,
  });
  console.log(JSON.stringify({
    status: "passed",
    boundary: "wrangler_local_d1",
    credentials_loaded: false,
    challenge_winners: 1,
    enrollment_winners: 1,
    oauth_winners: 1,
    passkey_counter_winners: 1,
    succeeded_passkey_events: 1,
    owner_credentials_remaining: 1,
  }, null, 2));
} finally {
  if (dev && dev.exitCode === null) {
    dev.kill("SIGTERM");
    await new Promise((resolve) => {
      dev.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
  }
  rmSync(temporary, { recursive: true, force: true });
}
