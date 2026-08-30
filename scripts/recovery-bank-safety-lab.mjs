#!/usr/bin/env node
/**
 * Disposable, offline acceptance lab for recovery and bank-token custody.
 *
 * The child environment is rebuilt from a small allowlist and uses a temporary
 * HOME, so Cloudflare, provider, admin, session, and bank credentials cannot be
 * inherited. Every provider and data-plane interaction is a local fixture.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryHome = mkdtempSync(join(tmpdir(), "brain-recovery-bank-lab-"));
const childEnvironment = Object.freeze({
  PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: temporaryHome,
  TMPDIR: process.env.TMPDIR || tmpdir(),
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  NODE_NO_WARNINGS: "1",
  BRAIN_RECOVERY_DISPOSABLE_LAB: "1",
});

const commands = Object.freeze([
  ["--test",
    "test/bank-access-wrapping-key.test.mjs",
    "test/recovery-artifact-crypto.test.mjs",
    "test/recovery-mutation-boundaries.test.mjs"],
  ["test/verified-recovery.test.mjs"],
  ["test/cloudflare-recovery-adapter.test.mjs"],
  ["test/bank-feed-secrets.test.mjs"],
  ["worker/test/bank-feed.test.mjs"],
]);

try {
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env: childEnvironment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) process.exitCode = result.status || 1;
    if (process.exitCode) break;
  }
  if (!process.exitCode) {
    console.log("PASS  recovery-bank safety lab completed with synthetic fixtures and no inherited credentials");
  }
} finally {
  rmSync(temporaryHome, { recursive: true, force: true });
}
