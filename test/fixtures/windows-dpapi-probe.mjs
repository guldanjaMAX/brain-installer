/**
 * CI-only stage probe for the native Windows DPAPI helper.
 *
 * It uses four fixed bytes, never a credential, and prints only whitelisted
 * stage markers. Raw stdout and stderr are wiped without being logged.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.platform !== "win32") process.exit(0);

const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
if (!systemRoot) {
  console.log("dpapi-probe stage=runtime result=missing-system-root");
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
const fixed = Buffer.from([1, 2, 3, 4]);

function stage(name, script, expectedMarker = null) {
  const result = spawnSync(command, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], {
    encoding: null,
    env: environment,
    input: fixed,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  const marker = expectedMarker ? stdout.includes(Buffer.from(expectedMarker, "ascii")) : stdout.length > 0;
  const timedOut = result.error?.code === "ETIMEDOUT";
  const passed = result.status === 0 && !result.error && marker;
  console.log(`dpapi-probe stage=${name} result=${passed ? "pass" : "fail"} timeout=${timedOut ? "yes" : "no"} marker=${marker ? "yes" : "no"}`);
  stdout.fill(0);
  stderr.fill(0);
  return passed;
}

const shell = stage("shell", "[Console]::Out.Write('__SHELL_OK__')", "__SHELL_OK__");
const stdin = stage("stdin", String.raw`
[byte[]]$b = New-Object byte[] 4
$s = [Console]::OpenStandardInput()
$o = 0
while ($o -lt 4) { $n = $s.Read($b, $o, 4 - $o); if ($n -le 0) { throw 'short' }; $o += $n }
[Console]::Out.Write('__STDIN_OK__')
`, "__STDIN_OK__");
const fixedDpapi = stage("fixed-dpapi", String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[byte[]]$b = 1,2,3,4
$c = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
if ($c.Length -lt 1) { throw 'empty' }
[Console]::Out.Write('__FIXED_DPAPI_OK__')
`, "__FIXED_DPAPI_OK__");
const combined = stage("stdin-dpapi", String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[byte[]]$b = New-Object byte[] 4
$s = [Console]::OpenStandardInput()
$o = 0
while ($o -lt 4) { $n = $s.Read($b, $o, 4 - $o); if ($n -le 0) { throw 'short' }; $o += $n }
$c = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
if ($c.Length -lt 1) { throw 'empty' }
[Console]::Out.Write('__STDIN_DPAPI_OK__')
`, "__STDIN_DPAPI_OK__");

fixed.fill(0);
process.exit(shell && stdin && fixedDpapi && combined ? 0 : 1);
