/**
 * One process-scoped compiled helper for Windows DPAPI operations.
 *
 * Compilation happens before a bridge receives credential bytes. The helper
 * lives only in one random current-user ACL directory and is identified by its
 * exact file identity plus SHA-256. Cleanup touches only captured identities.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_DPAPI_SOURCE = fileURLToPath(new URL("./windows-dpapi.cs", import.meta.url));
const WINDOWS_RUNTIME_ENV = Object.freeze([
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
]);

let activeSession = null;
let exitHookInstalled = false;
let exitCleanupAttempted = false;
let sessionMetrics = { compile_count: 0, helper_invocations: 0 };

function staged(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  error.code = `WINDOWS_DPAPI_${stage.toUpperCase()}`;
  return error;
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function wipeResult(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

function runtime(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  const temporaryRoot = environment.TEMP || environment.TMP;
  const username = environment.USERNAME;
  if (!isAbsolute(systemRoot || "") || !isAbsolute(temporaryRoot || "") ||
      typeof username !== "string" || !username.trim()) {
    throw staged("runtime_discovery", "Windows DPAPI runtime is unavailable");
  }
  const compilerCandidates = [
    join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = compilerCandidates.find((candidate) => {
    try {
      const identity = lstatSync(candidate);
      // Windows services .NET Framework binaries through the component store,
      // so the fixed SystemRoot compiler may legitimately have multiple hard
      // links. Hard-link refusal still applies to our packaged source and every
      // generated helper artifact below. For this OS-owned input, require the
      // exact constructed path, a regular non-link file, and a bounded size.
      return identity.isFile() && !identity.isSymbolicLink() &&
        identity.size >= 1 && identity.size <= 16 * 1024 * 1024 &&
        resolve(realpathSync.native(candidate)).toLowerCase() === resolve(candidate).toLowerCase();
    } catch {
      return false;
    }
  });
  if (!compiler) throw staged("runtime_discovery", "Windows C# compiler is unavailable");

  const env = { SystemRoot: systemRoot };
  for (const name of WINDOWS_RUNTIME_ENV) {
    if (typeof environment[name] === "string" && environment[name]) env[name] = environment[name];
  }
  return Object.freeze({
    compiler,
    env: Object.freeze(env),
    icacls: join(systemRoot, "System32", "icacls.exe"),
    identity: environment.USERDOMAIN ? `${environment.USERDOMAIN}\\${username}` : username,
    temporaryRoot: realpathSync.native(temporaryRoot),
  });
}

function assertFixedSource(path = WINDOWS_DPAPI_SOURCE) {
  if (!isAbsolute(path) || basename(path).toLowerCase() !== "windows-dpapi.cs") {
    throw staged("source_validation", "invalid DPAPI source path");
  }
  const identity = lstatSync(path);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
      identity.size < 1 || identity.size > 64 * 1024 ||
      // The JavaScript resolver retains a legitimate Windows 8.3 spelling but
      // still resolves a linked ancestor. The native resolver expands 8.3
      // names and would falsely reject a package installed through one.
      resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) {
    throw staged("source_validation", "invalid DPAPI source file");
  }
}

function privateDirectory(details, run) {
  const directory = mkdtempSync(join(details.temporaryRoot, "brain-dpapi-"));
  const result = run(details.icacls, [
    directory,
    "/inheritance:r",
    "/grant:r", `${details.identity}:(OI)(CI)F`,
  ], {
    encoding: null,
    env: details.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  const passed = result?.status === 0 && !result?.error;
  wipeResult(result);
  if (!passed) {
    try { rmdirSync(directory); } catch {}
    throw staged("build_acl", "Windows could not restrict the DPAPI build directory");
  }
  return directory;
}

function compile(details, directory, source, run) {
  const helper = join(directory, "windows-dpapi-helper.exe");
  const result = run(details.compiler, [
    "/nologo", "/target:exe", "/optimize+", `/out:${helper}`,
    "/reference:System.Security.dll", source,
  ], {
    encoding: null,
    env: details.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
  const passed = result?.status === 0 && !result?.error;
  wipeResult(result);
  if (!passed) throw staged("compile", "Windows could not compile the DPAPI helper");
  const identity = lstatSync(helper);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
      identity.size < 1 || identity.size > 4 * 1024 * 1024) {
    throw staged("compile", "Windows produced an invalid DPAPI helper");
  }
  const bytes = readFileSync(helper);
  try {
    return Object.freeze({
      path: helper,
      identity,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    bytes.fill(0);
  }
}

function capturedArtifacts(directory) {
  return Object.freeze(readdirSync(directory).map((name) => {
    const path = join(directory, name);
    const identity = lstatSync(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
      throw staged("compile", "Windows produced an unexpected DPAPI build artifact");
    }
    return Object.freeze({ path, identity });
  }));
}

function cleanupOnce(session, options = {}) {
  const removeFile = options.unlink ?? unlinkSync;
  const removeDirectory = options.rmdir ?? rmdirSync;
  for (const artifact of session.artifacts) {
    let current;
    try { current = lstatSync(artifact.path); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!sameFile(current, artifact.identity) || !current.isFile() ||
        current.isSymbolicLink() || current.nlink !== 1) {
      throw staged("cleanup_identity", "DPAPI cleanup identity changed");
    }
    removeFile(artifact.path);
  }
  const directoryIdentity = lstatSync(session.directory);
  if (!sameFile(directoryIdentity, session.directoryIdentity) ||
      !directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() ||
      readdirSync(session.directory).length !== 0) {
    throw staged("cleanup_identity", "DPAPI build directory identity changed");
  }
  removeDirectory(session.directory);
}

function synchronousPause(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch { /* process exit may not permit waiting */ }
}

export function disposeWindowsDpapiSession({ attempts = 5, pause = synchronousPause, unlink, rmdir } = {}) {
  const session = activeSession;
  if (!session) return Object.freeze({ status: "clean", attempts: 0 });
  let error = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      cleanupOnce(session, { unlink, rmdir });
      activeSession = null;
      return Object.freeze({ status: "clean", attempts: attempt });
    } catch (caught) {
      error = caught;
      if (attempt < attempts) pause(100 * attempt);
    }
  }
  return Object.freeze({
    status: "cleanup_deferred",
    attempts,
    issue_code: error?.code === "WINDOWS_DPAPI_CLEANUP_IDENTITY"
      ? error.code
      : "WINDOWS_DPAPI_CLEANUP_DEFERRED",
  });
}

export function finalizeWindowsDpapiSession({ report, ...disposeOptions } = {}) {
  const result = disposeWindowsDpapiSession(disposeOptions);
  if (result.status === "cleanup_deferred") {
    const line = `BRAIN_DPAPI_HYGIENE:cleanup_deferred issue_code=${result.issue_code}\n`;
    try {
      if (report) report(line);
      else writeSync(2, Buffer.from(line, "ascii"));
    } catch { /* reporting hygiene must not change crypto or credential-write success */ }
  }
  return result;
}

function cleanupAtProcessExit() {
  if (exitCleanupAttempted) return;
  exitCleanupAttempted = true;
  finalizeWindowsDpapiSession();
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("beforeExit", cleanupAtProcessExit);
  process.once("exit", cleanupAtProcessExit);
}

export function resetWindowsDpapiSessionMetrics() {
  if (activeSession) {
    throw staged("metrics", "Windows DPAPI metrics cannot reset while a helper session is active");
  }
  sessionMetrics = { compile_count: 0, helper_invocations: 0 };
}

export function recordWindowsDpapiHelperInvocation() {
  if (!activeSession?.public) {
    throw staged("metrics", "Windows DPAPI helper invocation has no active session");
  }
  sessionMetrics.helper_invocations += 1;
}

export function readWindowsDpapiSessionMetrics() {
  return Object.freeze({ ...sessionMetrics });
}

export function prepareWindowsDpapiSession(options = {}) {
  if (activeSession?.public) return activeSession.public;
  if (activeSession) {
    const cleanup = disposeWindowsDpapiSession();
    if (cleanup.status !== "clean") {
      throw staged("cleanup_deferred", "the prior DPAPI helper cleanup is still deferred");
    }
  }
  const run = options.spawnSync ?? spawnSync;
  const source = options.sourcePath ?? WINDOWS_DPAPI_SOURCE;
  assertFixedSource(source);
  const details = runtime(options.environment ?? process.env);
  let directory = null;
  try {
    directory = privateDirectory(details, run);
    const helper = compile(details, directory, source, run);
    const session = {
      directory,
      directoryIdentity: lstatSync(directory),
      artifacts: capturedArtifacts(directory),
      public: Object.freeze({
        helper: helper.path,
        sha256: helper.sha256,
        size: helper.identity.size,
        dev: String(helper.identity.dev),
        ino: String(helper.identity.ino),
      }),
    };
    activeSession = session;
    sessionMetrics.compile_count += 1;
    installExitHook();
    return session.public;
  } catch (error) {
    if (directory) {
      try {
        const artifacts = capturedArtifacts(directory);
        activeSession = {
          directory,
          directoryIdentity: lstatSync(directory),
          artifacts,
          public: null,
        };
        installExitHook();
        disposeWindowsDpapiSession();
      } catch { /* no safe captured identity was available to remove */ }
    }
    throw error;
  }
}
