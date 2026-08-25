/**
 * Synchronous caller bridge for the asynchronous PowerShell stdin path.
 *
 * The installer itself is synchronous while it rotates credentials. On
 * Windows, spawnSync -> powershell.exe can leave PowerShell's stdin unread.
 * This fixed Node child receives bytes from its parent, then uses an ordinary
 * asynchronous pipe to the fixed PowerShell helper. No payload enters argv,
 * environment, logs, or disk.
 */

import { spawn } from "node:child_process";
import { readSync, writeSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

function parseArgs(argv) {
  const allowed = new Set(["powershell", "helper", "operation", "length", "max"]);
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

async function invoke({ powerShell, helper, operation, expectedLength, maxOutput }, input) {
  const child = spawn(powerShell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", helper,
    "-Operation", operation,
    "-ExpectedLength", String(expectedLength),
  ], {
    env: process.env,
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
  const powerShell = raw.powershell;
  const helper = raw.helper;
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > 3 * 1024 * 1024 ||
      !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 3 * 1024 * 1024 ||
      !new Set(["protect", "unprotect"]).has(operation) ||
      !isAbsolute(powerShell || "") || basename(powerShell).toLowerCase() !== "powershell.exe" ||
      !isAbsolute(helper || "") || basename(helper).toLowerCase() !== "windows-dpapi.ps1") {
    throw new Error("invalid bridge contract");
  }

  const input = readExact(expectedLength);
  let output;
  try {
    output = await invoke({ powerShell, helper, operation, expectedLength, maxOutput }, input);
    writeAll(1, output);
  } finally {
    input.fill(0);
    if (output) output.fill(0);
  }
}

main().catch(() => process.exit(1));
