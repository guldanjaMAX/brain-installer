import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = join(ROOT, "tools", "preflight.sh");

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function runPreflight({ nodeVersion = "v22.0.0", brainCopies = 0, wranglerSession = null } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "brain-preflight-"));
  try {
    const home = join(fixture, "home");
    const bin = join(fixture, "bin");
    mkdirSync(home);
    mkdirSync(bin);

    if (wranglerSession === "home-fallback") {
      // An existing but empty earlier directory must not hide a later file.
      mkdirSync(join(home, ".config", ".wrangler", "config"), { recursive: true });
      const fallback = join(home, ".wrangler", "config");
      mkdirSync(fallback, { recursive: true });
      writeFileSync(join(fallback, "default.toml"), "fixture session marker only\n");
    } else if (wranglerSession === "xdg") {
      const xdg = join(fixture, "xdg config");
      const config = join(xdg, ".wrangler", "config");
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, "default.toml"), "fixture session marker only\n");
    }

    executable(join(bin, "node"), `printf '%s\\n' '${nodeVersion}'`);
    executable(join(bin, "npm"), `
case "$1" in
  -v) printf '%s\\n' '10.0.0' ;;
  config) printf '%s\\n' '/fixture-prefix' ;;
  ls) exit 0 ;;
esac`);
    executable(join(bin, "curl"), `
case "$*" in
  *releases/latest*) printf '%s\\n' '{"tag_name":"v0.3.7"}' ;;
  *) printf '%s' '200' ;;
esac`);

    const brainDirs = [];
    for (let i = 0; i < brainCopies; i++) {
      const dir = join(fixture, `brain-${i + 1}`);
      mkdirSync(dir);
      executable(join(dir, "brain"), "exit 0");
      brainDirs.push(dir);
    }

    const env = {
      ...process.env,
      HOME: home,
      PATH: [...brainDirs, bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      ...(wranglerSession === "xdg" ? { XDG_CONFIG_HOME: join(fixture, "xdg config") } : {}),
    };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_API_KEY;

    return spawnSync("/bin/bash", [PREFLIGHT], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("POSIX preflight rejects Node 21 and accepts Node 22", { skip: process.platform === "win32" }, () => {
  const oldNode = runPreflight({ nodeVersion: "v21.9.0" });
  assert.equal(oldNode.status, 1);
  assert.match(oldNode.stdout, /node v21\.9\.0 is too old; the installer needs 22 or newer/);

  const supportedNode = runPreflight({ nodeVersion: "v22.0.0" });
  assert.equal(supportedNode.status, 0, supportedNode.stderr || supportedNode.stdout);
  assert.doesNotMatch(supportedNode.stdout, /node .* is too old/);
});

test("POSIX preflight finds every Brain CLI on PATH", { skip: process.platform === "win32" }, () => {
  const result = runPreflight({ brainCopies: 2 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /STOP\s+2 copies of 'brain' on PATH/);
  assert.match(result.stdout, /brain-1\/brain/);
  assert.match(result.stdout, /brain-2\/brain/);
});

test("POSIX preflight follows Wrangler session precedence without directory masking", { skip: process.platform === "win32" }, () => {
  for (const wranglerSession of ["home-fallback", "xdg"]) {
    const result = runPreflight({ wranglerSession });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok\s+wrangler session found/);
    assert.doesNotMatch(result.stdout, /no wrangler session yet/);
  }
});
