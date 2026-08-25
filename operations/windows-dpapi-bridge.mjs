/**
 * Synchronous caller bridge for a compiled Windows DPAPI helper.
 *
 * The installer is synchronous while it rotates credentials, but PowerShell's
 * standard-input path can remain unread under spawnSync on Windows. This fixed
 * Node child compiles a fixed C# helper before reading any payload, then sends
 * the exact bytes through an ordinary asynchronous pipe. No payload enters
 * argv, environment, logs, compiler input, or disk.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const WINDOWS_RUNTIME_ENV = Object.freeze([
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
]);

function parseArgs(argv) {
  const allowed = new Set(["source", "operation", "length", "max"]);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid bridge arguments");
    const name = key.slice(2);
    if (!allowed.has(name) || Object.hasOwn(out, name)) throw new Error("invalid bridge arguments");
    out[name] = value;
  }
  if (Object.keys(out).length !== allowed.size) throw new Error("invalid bridge arguments");
  return out;
}

function wipeChildResult(result) {
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
}

function windowsRuntime() {
  const environment = process.env;
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  const temporaryRoot = environment.TEMP || environment.TMP;
  const username = environment.USERNAME;
  if (!isAbsolute(systemRoot || "") || !isAbsolute(temporaryRoot || "") ||
      typeof username !== "string" || !username.trim()) {
    throw new Error("Windows DPAPI runtime is unavailable");
  }

  const compilerCandidates = [
    join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = compilerCandidates.find((candidate) => {
    try {
      const identity = lstatSync(candidate);
      return identity.isFile() && !identity.isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!compiler) throw new Error("Windows C# compiler is unavailable");

  const env = { SystemRoot: systemRoot };
  for (const name of WINDOWS_RUNTIME_ENV) {
    if (typeof environment[name] === "string" && environment[name]) env[name] = environment[name];
  }
  const identity = environment.USERDOMAIN
    ? `${environment.USERDOMAIN}\\${username}`
    : username;
  return {
    compiler,
    env,
    icacls: join(systemRoot, "System32", "icacls.exe"),
    identity,
    temporaryRoot: realpathSync.native(temporaryRoot),
  };
}

function assertFixedSource(source) {
  if (!isAbsolute(source || "") || basename(source).toLowerCase() !== "windows-dpapi.cs") {
    throw new Error("invalid DPAPI source path");
  }
  const identity = lstatSync(source);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size < 1 || identity.size > 64 * 1024 ||
      resolve(realpathSync.native(source)).toLowerCase() !== resolve(source).toLowerCase()) {
    throw new Error("invalid DPAPI source file");
  }
}

function createPrivateBuildDirectory(runtime) {
  const directory = mkdtempSync(join(runtime.temporaryRoot, "brain-dpapi-"));
  const result = spawnSync(runtime.icacls, [
    directory,
    "/inheritance:r",
    "/grant:r", `${runtime.identity}:(OI)(CI)F`,
  ], {
    encoding: null,
    env: runtime.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  const passed = result?.status === 0 && !result?.error;
  wipeChildResult(result);
  if (!passed) {
    try { rmdirSync(directory); } catch {}
    throw new Error("Windows could not restrict the DPAPI build directory");
  }
  return directory;
}

function compileHelper(runtime, source, directory) {
  const helper = join(directory, "windows-dpapi-helper.exe");
  const result = spawnSync(runtime.compiler, [
    "/nologo",
    "/target:exe",
    "/optimize+",
    `/out:${helper}`,
    "/reference:System.Security.dll",
    source,
  ], {
    encoding: null,
    env: runtime.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
  const passed = result?.status === 0 && !result?.error;
  wipeChildResult(result);
  if (!passed) throw new Error("Windows could not compile the DPAPI helper");

  const identity = lstatSync(helper);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size < 1) {
    throw new Error("Windows produced an invalid DPAPI helper");
  }
  return helper;
}

async function cleanBuildDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // csc emits only regular files here. Refuse to recurse through an
      // unexpected object even though the directory has a private-user ACL.
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const identity = lstatSync(path);
        if (!identity.isFile() || identity.isSymbolicLink()) {
          throw new Error("unexpected DPAPI build artifact");
        }
        unlinkSync(path);
      }
      rmdirSync(directory);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        // Antivirus may briefly retain an executable after process close.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function readExact(length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, bytes, offset, length - offset, null);
    if (count <= 0) {
      bytes.fill(0);
      throw new Error("short bridge input");
    }
    offset += count;
  }
  return bytes;
}

async function invoke({ helper, operation, expectedLength, maxOutput, env }, input) {
  const child = spawn(helper, [operation, String(expectedLength)], {
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const chunks = [];
  let total = 0;
  let failed = false;
  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
    total += bytes.length;
    if (total > maxOutput) {
      bytes.fill(0);
      failed = true;
      child.kill();
      return;
    }
    chunks.push(bytes);
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  });

  const completed = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, failed: true }));
    child.once("close", (code) => resolve({ code, failed }));
  });
  const timer = setTimeout(() => {
    failed = true;
    child.kill();
  }, 20_000);

  child.stdin.on("error", () => { failed = true; });
  child.stdin.end(input);
  const result = await completed;
  clearTimeout(timer);

  if (result.failed || result.code !== 0 || total < 1 || total > maxOutput) {
    for (const chunk of chunks) chunk.fill(0);
    throw new Error("DPAPI child failed");
  }
  const output = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  return output;
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error("short bridge output");
    offset += count;
  }
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  const expectedLength = Number(raw.length);
  const maxOutput = Number(raw.max);
  const operation = raw.operation;
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > 3 * 1024 * 1024 ||
      !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 3 * 1024 * 1024 ||
      !new Set(["protect", "unprotect"]).has(operation) ||
      !isAbsolute(raw.source || "") || basename(raw.source).toLowerCase() !== "windows-dpapi.cs") {
    throw new Error("invalid bridge contract");
  }

  assertFixedSource(raw.source);
  const runtime = windowsRuntime();
  let directory;
  let input;
  let output;
  let operationError;
  try {
    // Compiler and ACL failures happen before this process reads a credential.
    directory = createPrivateBuildDirectory(runtime);
    const helper = compileHelper(runtime, raw.source, directory);
    input = readExact(expectedLength);
    output = await invoke({ helper, operation, expectedLength, maxOutput, env: runtime.env }, input);
  } catch (error) {
    operationError = error;
  } finally {
    if (input) input.fill(0);
  }
  let cleanupError;
  try {
    if (directory) await cleanBuildDirectory(directory);
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
    writeAll(1, output);
  } finally {
    if (output) output.fill(0);
  }
}

main().catch(() => process.exit(1));
