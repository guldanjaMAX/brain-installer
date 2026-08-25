/**
 * CI-only round-trip probe for the shipped Windows DPAPI helper.
 *
 * It uses four fixed bytes, never a credential, and prints only a whitelisted
 * result. Raw ciphertext, plaintext, and child diagnostics are wiped.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);

const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
if (!systemRoot) {
  console.log("dpapi-probe result=fail stage=runtime timeout=no");
  process.exit(1);
}

const environment = { SystemRoot: systemRoot };
for (const name of [
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
]) {
  if (process.env[name]) environment[name] = process.env[name];
}

const command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const helper = fileURLToPath(new URL("../../operations/windows-dpapi.ps1", import.meta.url));
const bridge = fileURLToPath(new URL("../../operations/windows-dpapi-bridge.mjs", import.meta.url));

function invoke(operation, input) {
  return spawnSync(process.execPath, [
    bridge,
    "--powershell", command,
    "--helper", helper,
    "--operation", operation,
    "--length", String(input.length),
    "--max", "65536",
  ], {
    encoding: null,
    env: environment,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
}

const fixed = Buffer.from([1, 2, 3, 4]);
const protectedResult = invoke("protect", fixed);
const ciphertext = Buffer.isBuffer(protectedResult.stdout)
  ? Buffer.from(protectedResult.stdout)
  : Buffer.alloc(0);
const protectPassed = protectedResult.status === 0 && !protectedResult.error && ciphertext.length > 0;
const protectTimedOut = protectedResult.error?.code === "ETIMEDOUT";
if (Buffer.isBuffer(protectedResult.stdout)) protectedResult.stdout.fill(0);
if (Buffer.isBuffer(protectedResult.stderr)) protectedResult.stderr.fill(0);

let unprotectPassed = false;
let unprotectTimedOut = false;
if (protectPassed) {
  const unprotectedResult = invoke("unprotect", ciphertext);
  const plaintext = Buffer.isBuffer(unprotectedResult.stdout)
    ? Buffer.from(unprotectedResult.stdout)
    : Buffer.alloc(0);
  unprotectPassed = unprotectedResult.status === 0 && !unprotectedResult.error && plaintext.equals(fixed);
  unprotectTimedOut = unprotectedResult.error?.code === "ETIMEDOUT";
  plaintext.fill(0);
  if (Buffer.isBuffer(unprotectedResult.stdout)) unprotectedResult.stdout.fill(0);
  if (Buffer.isBuffer(unprotectedResult.stderr)) unprotectedResult.stderr.fill(0);
}

fixed.fill(0);
ciphertext.fill(0);
const passed = protectPassed && unprotectPassed;
const stage = !protectPassed ? "protect" : !unprotectPassed ? "unprotect" : "roundtrip";
console.log(`dpapi-probe result=${passed ? "pass" : "fail"} stage=${stage} timeout=${protectTimedOut || unprotectTimedOut ? "yes" : "no"}`);
process.exit(passed ? 0 : 1);
