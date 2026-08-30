/**
 * Synchronous-caller bridge for one process-scoped compiled DPAPI helper.
 *
 * The parent compiles once in a private random directory. This bridge verifies
 * the exact regular-file identity and in-memory SHA-256 before reading stdin,
 * then asynchronously pipes credential bytes to the fixed helper.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readSync, realpathSync, writeSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const STAGE_PREFIX = "BRAIN_DPAPI_STAGE:";
const WINDOWS_RUNTIME_ENV = Object.freeze([
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "ComSpec",
]);

function staged(stage, operation) {
  try { return operation(); } catch {
    const error = new Error(`Windows DPAPI stage failed: ${stage}`);
    error.stage = stage;
    throw error;
  }
}

async function stagedAsync(stage, operation) {
  try { return await operation(); } catch {
    const error = new Error(`Windows DPAPI stage failed: ${stage}`);
    error.stage = stage;
    throw error;
  }
}

function parseArgs(argv) {
  const allowed = new Set(["helper", "sha256", "operation", "length", "max"]);
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid bridge arguments");
    const name = key.slice(2);
    if (!allowed.has(name) || Object.hasOwn(out, name)) throw new Error("invalid bridge arguments");
    out[name] = value;
  }
  if (Object.keys(out).length !== allowed.size) throw new Error("invalid bridge arguments");
  return out;
}

function runtimeEnvironment() {
  const environment = process.env;
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  const username = environment.USERNAME;
  if (!isAbsolute(systemRoot || "") || typeof username !== "string" || !username.trim()) {
    throw new Error("Windows DPAPI runtime is unavailable");
  }
  const env = { SystemRoot: systemRoot };
  for (const name of WINDOWS_RUNTIME_ENV) {
    if (typeof environment[name] === "string" && environment[name]) env[name] = environment[name];
  }
  return env;
}

function assertHelper(helper, expectedHash) {
  if (!isAbsolute(helper || "") || basename(helper).toLowerCase() !== "windows-dpapi-helper.exe" ||
      !/^[a-f0-9]{64}$/.test(expectedHash || "")) {
    throw new Error("invalid DPAPI helper contract");
  }
  const identity = lstatSync(helper);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
      identity.size < 1 || identity.size > 4 * 1024 * 1024 ||
      resolve(realpathSync.native(helper)).toLowerCase() !== resolve(helper).toLowerCase()) {
    throw new Error("invalid DPAPI helper file");
  }
  const bytes = readFileSync(helper);
  try {
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new Error("DPAPI helper integrity changed");
    }
  } finally {
    bytes.fill(0);
  }
  return identity;
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
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

async function invoke({ helper, helperIdentity, expectedHash, operation, expectedLength, maxOutput, env }, input) {
  const revalidated = assertHelper(helper, expectedHash);
  if (!sameFile(revalidated, helperIdentity)) throw new Error("DPAPI helper identity changed");
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
  child.stderr.on("data", (chunk) => { if (Buffer.isBuffer(chunk)) chunk.fill(0); });
  const completed = new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise({ code: null, failed: true }));
    child.once("close", (code) => resolvePromise({ code, failed }));
  });
  const timer = setTimeout(() => { failed = true; child.kill(); }, 20_000);
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
  const raw = staged("contract", () => parseArgs(process.argv.slice(2)));
  const expectedLength = Number(raw.length);
  const maxOutput = Number(raw.max);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > 3 * 1024 * 1024 ||
      !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 3 * 1024 * 1024 ||
      !new Set(["protect", "unprotect"]).has(raw.operation)) {
    const error = new Error("invalid bridge contract");
    error.stage = "contract";
    throw error;
  }
  const helperIdentity = staged("helper_validation", () => assertHelper(raw.helper, raw.sha256));
  const env = staged("runtime_discovery", () => runtimeEnvironment());
  let input;
  let output;
  try {
    input = staged("input", () => readExact(expectedLength));
    output = await stagedAsync(raw.operation === "protect" ? "protect" : "unprotect", () => invoke({
      helper: raw.helper,
      helperIdentity,
      expectedHash: raw.sha256,
      operation: raw.operation,
      expectedLength,
      maxOutput,
      env,
    }, input));
    staged("output", () => writeAll(1, output));
  } finally {
    if (input) input.fill(0);
    if (output) output.fill(0);
  }
}

main().catch((error) => {
  const stage = /^[a-z_]+$/.test(String(error?.stage || "")) ? error.stage : "unknown";
  try { writeAll(2, Buffer.from(`${STAGE_PREFIX}${stage}\n`, "ascii")); } catch {}
  process.exit(1);
});
