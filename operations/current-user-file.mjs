import { spawnSync } from "node:child_process";
import { join } from "node:path";

const WINDOWS_ENV_NAMES = Object.freeze([
  "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USERNAME",
  "USERDOMAIN", "ComSpec",
]);

/**
 * The ACL child receives OS locators only. A desktop process may carry cloud
 * tokens and admin keys in its environment; restricting a local file never
 * needs them.
 */
export function windowsFileChildEnvironment(environment = process.env) {
  const clean = {};
  for (const name of WINDOWS_ENV_NAMES) {
    const value = environment?.[name];
    if (typeof value === "string" && value) clean[name] = value;
  }
  const root = clean.SystemRoot || clean.SYSTEMROOT || clean.WINDIR;
  if (root) clean.SystemRoot = root;
  return clean;
}

function wipeChildResult(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

/** Apply a Windows DACL that grants the current user full control only. */
export function restrictWindowsFileToCurrentUser(path, options = {}) {
  const environment = options.environment || process.env;
  const env = windowsFileChildEnvironment(environment);
  const username = options.username || environment.USERNAME || environment.USER;
  const label = options.label || "the private file";
  if (typeof username !== "string" || !username.trim() || /[\r\n\0]/.test(username) || username.length > 256) {
    throw new Error(`Windows could not identify the current user for ${label}`);
  }
  const command = options.icaclsPath || (env.SystemRoot
    ? join(env.SystemRoot, "System32", "icacls.exe")
    : "icacls.exe");
  const args = [path, "/inheritance:r", "/grant:r", `${username}:F`];
  let result;
  try {
    result = (options.runAcl || spawnSync)(command, args, {
      encoding: null,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs || 15_000,
      windowsHide: true,
    });
    if (result?.status !== 0 || result?.error) {
      throw new Error(`Windows could not restrict ${label} to the current user`);
    }
  } catch {
    throw new Error(`Windows could not restrict ${label} to the current user`);
  } finally {
    wipeChildResult(result);
  }
  return true;
}
