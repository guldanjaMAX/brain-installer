import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupAdminKeyFileResidue,
  readAdminKeyFile,
  validateAdminKeyValue,
  validateAdminKeyFileDestination,
  writeAdminKeyFile,
} from "../operations/admin-key-file.mjs";

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-admin-key-file-")));
const secretA = "a".repeat(48);
const secretB = "b-$&()[]{}-HEADER key-0123456789abcdef";
const cipherA = Buffer.from("simulated-dpapi-ciphertext-a", "utf8");
const cipherB = Buffer.from("simulated-dpapi-ciphertext-b", "utf8");
const entropy = (byte) => () => Buffer.alloc(8, byte);
const dpapiEnvelope = (cipher) => Buffer.from(
  `BRAIN-ADMIN-KEY-DPAPI-V1\n${Buffer.from(cipher).toString("base64")}\n`,
  "ascii",
);

function fakeDpapi(pairs) {
  const calls = [];
  return {
    calls,
    runPowerShell(command, args, options) {
      const input = Buffer.from(options.input);
      const script = String(args.at(-1) || "");
      const protect = script.includes("]::Protect(");
      const unprotect = script.includes("]::Unprotect(");
      const framed = script.includes(`[int]$expectedLength = ${input.length}`) &&
        !script.includes("__BRAIN_INPUT_LENGTH__");
      calls.push({
        args: [...args],
        command,
        env: { ...options.env },
        input,
        protect,
        unprotect,
      });
      if (protect === unprotect || !framed) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const pair = protect
        ? pairs.find((candidate) => input.equals(Buffer.from(candidate.secret, "utf8")))
        : pairs.find((candidate) => input.equals(candidate.cipher));
      if (!pair) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      return {
        status: 0,
        stdout: protect ? Buffer.from(pair.cipher) : Buffer.from(pair.secret, "utf8"),
        stderr: Buffer.alloc(0),
      };
    },
  };
}

try {
  chmodSync(sandbox, 0o700);

  assert.equal(validateAdminKeyValue(secretB), secretB, "visible ASCII and an internal space are header-safe");
  for (const unsafe of [
    ` ${"a".repeat(47)}`,
    `${"a".repeat(47)} `,
    `${"a".repeat(24)}\t${"b".repeat(24)}`,
    `${"a".repeat(24)}\n${"b".repeat(24)}`,
    `${"a".repeat(24)}ü${"b".repeat(24)}`,
    `${"a".repeat(24)}\x7f${"b".repeat(24)}`,
  ]) {
    let error;
    try { validateAdminKeyValue(unsafe); } catch (caught) { error = caught; }
    assert.match(error?.message || "", /HTTP-header-safe ASCII/i);
    assert.equal(String(error?.message || error).includes(unsafe), false, "validation errors never echo the key");
  }

  if (process.platform !== "win32") {
    const unsafeReadRoot = join(sandbox, "unsafe-durable-values");
    mkdirSync(unsafeReadRoot, { mode: 0o700 });
    const unsafeReadPath = join(unsafeReadRoot, ".brain-admin-key");
    for (const unsafe of [
      ` ${secretA}\n`,
      `${secretA} \n`,
      `${secretA}\n\n`,
      `${secretA.slice(0, -1)}ü\n`,
    ]) {
      writeFileSync(unsafeReadPath, unsafe, { mode: 0o600 });
      let error;
      try { readAdminKeyFile(unsafeReadPath); } catch (caught) { error = caught; }
      assert.match(error?.message || "", /HTTP-header-safe ASCII/i);
      assert.equal(String(error?.message || error).includes(unsafe), false);
    }
    rmSync(unsafeReadRoot, { recursive: true });
  }

  if (process.platform !== "win32") {
    const path = join(sandbox, ".brain-admin-key");
    const first = writeAdminKeyFile(path, secretA, { randomBytes: entropy(1) });
    assert.equal(first.replaced, false);
    assert.equal(readFileSync(path, "utf8"), `${secretA}\n`);
    assert.equal(readAdminKeyFile(path), secretA);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(sandbox), [".brain-admin-key"]);

    const second = writeAdminKeyFile(path, secretB, { randomBytes: entropy(2) });
    assert.equal(second.replaced, true);
    assert.equal(readFileSync(path, "utf8"), `${secretB}\n`);
    assert.equal(readAdminKeyFile(path), secretB);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(sandbox), [".brain-admin-key"]);
  }

  if (process.platform !== "win32") {
    const stagedRoot = join(sandbox, "posix-staged-mismatch");
    mkdirSync(stagedRoot, { mode: 0o700 });
    const stagedPath = join(stagedRoot, ".brain-admin-key");
    writeFileSync(stagedPath, `${secretA}\n`, { mode: 0o600 });
    let stagedError;
    try {
      writeAdminKeyFile(stagedPath, secretB, {
        randomBytes: entropy(13),
        readFileForVerification: (_path, descriptor, phase) => {
          if (phase === "staged") return Buffer.from(`${secretA}\n`);
          return readFileSync(descriptor);
        },
      });
    } catch (error) { stagedError = error; }
    assert.match(stagedError?.message || "", /staged payload did not read back exactly/i);
    assert.equal(stagedError.message.includes(secretB), false);
    assert.equal(readAdminKeyFile(stagedPath), secretA);
    assert.deepEqual(readdirSync(stagedRoot), [".brain-admin-key"]);

    const postRoot = join(sandbox, "posix-post-replacement");
    mkdirSync(postRoot, { mode: 0o700 });
    const postPath = join(postRoot, ".brain-admin-key");
    writeFileSync(postPath, `${secretA}\n`, { mode: 0o600 });
    let postError;
    try {
      writeAdminKeyFile(postPath, secretB, {
        randomBytes: entropy(14),
        readFileForVerification: (_path, descriptor, phase) =>
          phase === "persisted" ? Buffer.from(`${secretA}\n`) : readFileSync(descriptor),
      });
    } catch (error) { postError = error; }
    assert.match(postError?.message || "", /prior admin key was restored and verified/i);
    assert.equal(postError.message.includes(secretA), false);
    assert.equal(postError.message.includes(secretB), false);
    assert.equal(readAdminKeyFile(postPath), secretA);
    assert.deepEqual(readdirSync(postRoot), [".brain-admin-key"]);

    const absentRoot = join(sandbox, "posix-absent-rollback");
    mkdirSync(absentRoot, { mode: 0o700 });
    const absentPath = join(absentRoot, ".brain-admin-key");
    let absentError;
    try {
      writeAdminKeyFile(absentPath, secretB, {
        randomBytes: entropy(15),
        readFileForVerification: (_path, descriptor, phase) =>
          phase === "persisted" ? Buffer.from(`${secretA}\n`) : readFileSync(descriptor),
      });
    } catch (error) { absentError = error; }
    assert.match(absentError?.message || "", /no admin key destination was left behind/i);
    assert.equal(existsSync(absentPath), false);
    assert.deepEqual(readdirSync(absentRoot), []);

    const secretErrorRoot = join(sandbox, "posix-secret-safe-error");
    mkdirSync(secretErrorRoot, { mode: 0o700 });
    const secretErrorPath = join(secretErrorRoot, ".brain-admin-key");
    let injectedError;
    try {
      writeAdminKeyFile(secretErrorPath, secretB, {
        randomBytes: entropy(16),
        readFileForVerification: () => { throw new Error(secretB); },
      });
    } catch (error) { injectedError = error; }
    assert.match(injectedError?.message || "", /payload could not be read safely/i);
    assert.equal(injectedError.message.includes(secretB), false);
    assert.equal(existsSync(secretErrorPath), false);

    const syncRoot = join(sandbox, "posix-directory-sync-failure");
    mkdirSync(syncRoot, { mode: 0o700 });
    const syncPath = join(syncRoot, ".brain-admin-key");
    writeFileSync(syncPath, `${secretA}\n`, { mode: 0o600 });
    let syncError;
    try {
      writeAdminKeyFile(syncPath, secretB, {
        randomBytes: entropy(21),
        syncParentDirectory: (_directory, phase) => {
          if (phase === "persisted") {
            throw Object.assign(new Error(secretB), { code: "EIO" });
          }
        },
      });
    } catch (error) { syncError = error; }
    assert.match(syncError?.message || "", /prior admin key was restored and verified/i);
    assert.equal(syncError.message.includes(secretB), false);
    assert.equal(readAdminKeyFile(syncPath), secretA);
    assert.deepEqual(readdirSync(syncRoot), [".brain-admin-key"]);
  }

  const windowsRoot = join(sandbox, "windows-simulated");
  mkdirSync(windowsRoot);
  const windowsPath = join(windowsRoot, ".brain-admin-key");
  const simulated = fakeDpapi([
    { secret: secretA, cipher: cipherA },
    { secret: secretB, cipher: cipherB },
  ]);

  // An install created before DPAPI support must remain usable. No decrypt
  // subprocess is needed for a file without the versioned envelope marker.
  writeFileSync(windowsPath, `${secretA}\n`);
  assert.equal(readAdminKeyFile(windowsPath, {
    platform: "win32",
    runPowerShell: simulated.runPowerShell,
  }), secretA);
  assert.equal(simulated.calls.length, 0);

  const aclCalls = [];
  const preAclHandles = [];
  writeAdminKeyFile(windowsPath, secretB, {
    platform: "win32",
    username: "fixture-user",
    randomBytes: entropy(3),
    runPowerShell: simulated.runPowerShell,
    runAcl: (args) => {
      aclCalls.push([...args]);
      preAclHandles.push({ path: args[0], descriptor: openSync(args[0], "r") });
      assert.equal(readFileSync(args[0]).length, 0, "the staging path is empty while its ACL is replaced");
      return { status: 0 };
    },
  });
  const rawWindows = readFileSync(windowsPath);
  const retainedHandleViews = preAclHandles.map(({ path, descriptor }) => {
    const bytes = readFileSync(descriptor);
    closeSync(descriptor);
    return { path, bytes };
  });
  const stagedHandleView = retainedHandleViews.find(({ path }) => path.endsWith(".tmp"))?.bytes;
  const backupHandleView = retainedHandleViews.find(({ path }) => path.endsWith(".bak"))?.bytes;
  assert.deepEqual(stagedHandleView, rawWindows, "a staging handle opened before the ACL sees only new ciphertext");
  assert.match(backupHandleView.toString("ascii"), /^BRAIN-ADMIN-KEY-DPAPI-V1\n/);
  assert.equal(backupHandleView.includes(Buffer.from(secretA)), false);
  assert.equal(backupHandleView.includes(Buffer.from(secretB)), false);
  assert.match(rawWindows.toString("ascii"), /^BRAIN-ADMIN-KEY-DPAPI-V1\n[A-Za-z0-9+/]+={0,2}\n$/);
  assert.equal(rawWindows.includes(Buffer.from(secretA)), false);
  assert.equal(rawWindows.includes(Buffer.from(secretB)), false);
  assert.equal(aclCalls.length, 2, "both the new ciphertext and rollback backup receive a private ACL");
  for (const aclArgs of aclCalls) {
    assert.deepEqual(aclArgs.slice(1), ["/inheritance:r", "/grant:r", "fixture-user:F"]);
    assert.equal(aclArgs.join(" ").includes(secretB), false);
  }
  assert.equal(readAdminKeyFile(windowsPath, {
    platform: "win32",
    runPowerShell: simulated.runPowerShell,
  }), secretB);
  assert.deepEqual(readdirSync(windowsRoot), [".brain-admin-key"]);

  const protectCall = simulated.calls.find((call) => call.protect && call.input.equals(Buffer.from(secretB)));
  const unprotectCall = simulated.calls.find((call) => call.unprotect && call.input.equals(cipherB));
  assert.ok(protectCall, "Windows protection receives the UTF-8 secret on stdin");
  assert.ok(unprotectCall, "Windows decryption receives ciphertext on stdin");
  for (const call of simulated.calls) {
    const metadata = JSON.stringify({ command: call.command, args: call.args, env: call.env });
    for (const secret of [secretA, secretB]) {
      assert.equal(metadata.includes(secret), false);
      assert.equal(metadata.includes(Buffer.from(secret).toString("base64")), false);
    }
    assert.equal(Object.hasOwn(call.env, "ADMIN_KEY"), false);
    assert.equal(Object.hasOwn(call.env, "BRAIN_ADMIN_KEY"), false);
    assert.equal(Object.hasOwn(call.env, "BRAIN_KEY"), false);
  }

  const windowsStagedRoot = join(sandbox, "windows-staged-mismatch");
  mkdirSync(windowsStagedRoot);
  const windowsStagedPath = join(windowsStagedRoot, ".brain-admin-key");
  writeFileSync(windowsStagedPath, `${secretA}\n`);
  let windowsStagedError;
  try {
    writeAdminKeyFile(windowsStagedPath, secretB, {
      platform: "win32",
      username: "fixture-user",
      randomBytes: entropy(17),
      runPowerShell: simulated.runPowerShell,
      runAcl: () => ({ status: 0 }),
      readFileForVerification: (_path, descriptor, phase) =>
        phase === "staged" ? dpapiEnvelope(cipherA) : readFileSync(descriptor),
    });
  } catch (error) { windowsStagedError = error; }
  assert.match(windowsStagedError?.message || "", /staged payload did not read back exactly/i);
  assert.equal(windowsStagedError.message.includes(secretB), false);
  assert.equal(readAdminKeyFile(windowsStagedPath, {
    platform: "win32", runPowerShell: simulated.runPowerShell,
  }), secretA);
  assert.deepEqual(readdirSync(windowsStagedRoot), [".brain-admin-key"]);

  const windowsPostRoot = join(sandbox, "windows-post-replacement");
  mkdirSync(windowsPostRoot);
  const windowsPostPath = join(windowsPostRoot, ".brain-admin-key");
  writeFileSync(windowsPostPath, `${secretA}\n`);
  let windowsPostError;
  try {
    writeAdminKeyFile(windowsPostPath, secretB, {
      platform: "win32",
      username: "fixture-user",
      randomBytes: entropy(18),
      runPowerShell: simulated.runPowerShell,
      runAcl: () => ({ status: 0 }),
      readFileForVerification: (_path, descriptor, phase) =>
        phase === "persisted" ? dpapiEnvelope(cipherA) : readFileSync(descriptor),
    });
  } catch (error) { windowsPostError = error; }
  assert.match(windowsPostError?.message || "", /prior admin key was restored and verified/i);
  assert.equal(windowsPostError.message.includes(secretA), false);
  assert.equal(windowsPostError.message.includes(secretB), false);
  assert.equal(readAdminKeyFile(windowsPostPath, {
    platform: "win32", runPowerShell: simulated.runPowerShell,
  }), secretA);
  const restoredWindowsBytes = readFileSync(windowsPostPath);
  assert.equal(restoredWindowsBytes.includes(Buffer.from(secretA)), false);
  assert.equal(restoredWindowsBytes.includes(Buffer.from(secretB)), false);
  assert.deepEqual(readdirSync(windowsPostRoot), [".brain-admin-key"]);

  const windowsAbsentRoot = join(sandbox, "windows-absent-rollback");
  mkdirSync(windowsAbsentRoot);
  const windowsAbsentPath = join(windowsAbsentRoot, ".brain-admin-key");
  let windowsAbsentError;
  try {
    writeAdminKeyFile(windowsAbsentPath, secretB, {
      platform: "win32",
      username: "fixture-user",
      randomBytes: entropy(19),
      runPowerShell: simulated.runPowerShell,
      runAcl: () => ({ status: 0 }),
      readFileForVerification: (_path, descriptor, phase) =>
        phase === "persisted" ? dpapiEnvelope(cipherA) : readFileSync(descriptor),
    });
  } catch (error) { windowsAbsentError = error; }
  assert.match(windowsAbsentError?.message || "", /no admin key destination was left behind/i);
  assert.equal(existsSync(windowsAbsentPath), false);
  assert.deepEqual(readdirSync(windowsAbsentRoot), []);

  const decryptFailure = assert.throws(() => readAdminKeyFile(windowsPath, {
    platform: "win32",
    runPowerShell: (_command, _args, options) => {
      assert.deepEqual(Buffer.from(options.input), cipherB);
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(secretB) };
    },
  }), /could not decrypt.*current user/);
  assert.equal(String(decryptFailure?.message || decryptFailure).includes(secretB), false);

  // ACL and DPAPI failures preserve the exact prior working file and remove
  // every private staging artifact. Child stderr is deliberately never echoed.
  const priorBytes = Buffer.from(`${secretA}\n`);
  writeFileSync(windowsPath, priorBytes);
  assert.throws(() => writeAdminKeyFile(windowsPath, secretB, {
    platform: "win32",
    username: "fixture-user",
    randomBytes: entropy(4),
    runPowerShell: simulated.runPowerShell,
    runAcl: () => ({ status: 1 }),
  }), /could not restrict.*staging/i);
  assert.deepEqual(readFileSync(windowsPath), priorBytes);
  assert.deepEqual(readdirSync(windowsRoot), [".brain-admin-key"]);

  let failedMetadata = "";
  const dpapiFailure = assert.throws(() => writeAdminKeyFile(windowsPath, secretB, {
    platform: "win32",
    username: "fixture-user",
    randomBytes: entropy(5),
    runPowerShell: (command, args, options) => {
      failedMetadata = JSON.stringify({ command, args, env: options.env });
      assert.deepEqual(Buffer.from(options.input), Buffer.from(secretB));
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(secretB) };
    },
    runAcl: () => { throw new Error("ACL must not run after DPAPI fails"); },
  }), /DPAPI.*prior key was left untouched/);
  assert.equal(String(dpapiFailure?.message || dpapiFailure).includes(secretB), false);
  assert.equal(failedMetadata.includes(secretB), false);
  assert.deepEqual(readFileSync(windowsPath), priorBytes);
  assert.deepEqual(readdirSync(windowsRoot), [".brain-admin-key"]);

  writeFileSync(windowsPath, "BRAIN-ADMIN-KEY-DPAPI-V1\nnot-base64!\n");
  const callsBeforeMalformedRead = simulated.calls.length;
  assert.throws(() => readAdminKeyFile(windowsPath, {
    platform: "win32",
    runPowerShell: simulated.runPowerShell,
  }), /envelope is malformed/);
  assert.equal(simulated.calls.length, callsBeforeMalformedRead, "a damaged envelope never falls back to plaintext");

  // Ordinary commands use the shared reader rather than treating a DPAPI
  // envelope as the key itself.
  writeFileSync(windowsPath, priorBytes);
  writeAdminKeyFile(windowsPath, secretB, {
    platform: "win32",
    username: "fixture-user",
    randomBytes: entropy(6),
    runPowerShell: simulated.runPowerShell,
    runAcl: () => ({ status: 0 }),
  });
  const manifestPath = join(windowsRoot, "brain.manifest.json");
  const { resolveAdminKey } = await import("../brain.mjs");
  const priorEnvironmentKey = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  try {
    assert.equal(resolveAdminKey(manifestPath, {
      platform: "win32",
      read: () => "{}",
      exists: () => true,
      runPowerShell: simulated.runPowerShell,
    }), secretB);
  } finally {
    if (priorEnvironmentKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = priorEnvironmentKey;
  }

  assert.throws(() => writeAdminKeyFile(join(sandbox, "wrong-name"), secretA), /absolute .brain-admin-key/);
  assert.throws(() => writeAdminKeyFile(join(sandbox, ".brain-admin-key"), "not-a-key"), /24 to 512/);

  const orphanRoot = join(sandbox, "orphan-rollback-backup");
  mkdirSync(orphanRoot, { mode: 0o700 });
  const orphanPath = join(orphanRoot, ".brain-admin-key");
  const orphanBackup = join(orphanRoot, "..brain-admin-key.404.4444444444444444.bak");
  writeFileSync(orphanBackup, "protected rollback state", { mode: 0o600 });
  for (const platformOptions of [
    {},
    { platform: "win32", username: "fixture-user" },
  ]) {
    assert.throws(
      () => validateAdminKeyFileDestination(orphanPath, platformOptions),
      /orphan admin key rollback backup exists.*recovery must be resolved/i,
    );
    assert.throws(
      () => readAdminKeyFile(orphanPath, platformOptions),
      /orphan admin key rollback backup exists.*recovery must be resolved/i,
    );
  }
  assert.equal(readFileSync(orphanBackup, "utf8"), "protected rollback state");
  rmSync(orphanBackup);
  const orphanTemp = join(orphanRoot, "..brain-admin-key.404.5555555555555555.tmp");
  writeFileSync(orphanTemp, "incomplete staged state", { mode: 0o600 });
  const nativeDestinationOptions = process.platform === "win32"
    ? { username: "fixture-user" }
    : {};
  assert.equal(validateAdminKeyFileDestination(orphanPath, nativeDestinationOptions).replaced, false);
  assert.throws(() => readAdminKeyFile(orphanPath, nativeDestinationOptions), /file does not exist/i);

  const windowsCaseRoot = join(sandbox, "windows-case-normalized-parent");
  mkdirSync(windowsCaseRoot, { mode: 0o700 });
  const windowsCasePath = join(windowsCaseRoot, ".brain-admin-key");
  assert.equal(validateAdminKeyFileDestination(windowsCasePath, {
    platform: "win32",
    username: "fixture-user",
    realpath: (path) => path.toUpperCase(),
  }).replaced, false, "Windows canonical path casing is compared case-insensitively");

  if (process.platform !== "win32") {
    const residueRoot = join(sandbox, "residue-cleanup");
    mkdirSync(residueRoot, { mode: 0o700 });
    const residuePath = join(residueRoot, ".brain-admin-key");
    writeFileSync(residuePath, `${secretA}\n`, { mode: 0o600 });
    const oldTmp = join(residueRoot, "..brain-admin-key.101.aaaaaaaaaaaaaaaa.tmp");
    const oldBak = join(residueRoot, "..brain-admin-key.101.bbbbbbbbbbbbbbbb.bak");
    const recentTmp = join(residueRoot, "..brain-admin-key.101.cccccccccccccccc.tmp");
    const looseTmp = join(residueRoot, "..brain-admin-key.101.dddddddddddddddd.tmp");
    const linkedTmp = join(residueRoot, "..brain-admin-key.101.eeeeeeeeeeeeeeee.tmp");
    const symlinkTmp = join(residueRoot, "..brain-admin-key.101.ffffffffffffffff.tmp");
    const outsideResidue = join(residueRoot, "outside-residue");
    for (const candidate of [oldTmp, oldBak, recentTmp, looseTmp, linkedTmp, outsideResidue]) {
      writeFileSync(candidate, "protected residue", { mode: 0o600 });
    }
    linkSync(linkedTmp, join(residueRoot, "linked-residue-copy"));
    symlinkSync(outsideResidue, symlinkTmp);
    chmodSync(looseTmp, 0o644);
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 10_000);
    for (const candidate of [oldTmp, oldBak, looseTmp, linkedTmp, symlinkTmp]) {
      utimesSync(candidate, oldDate, oldDate);
    }
    const removed = cleanupAdminKeyFileResidue(residuePath, {
      nowMs,
      residueMaxAgeMs: 1_000,
    });
    assert.deepEqual(
      removed.map((path) => path.split("/").at(-1)).sort(),
      ["..brain-admin-key.101.aaaaaaaaaaaaaaaa.tmp", "..brain-admin-key.101.bbbbbbbbbbbbbbbb.bak"],
    );
    assert.equal(existsSync(recentTmp), true, "recent residue is retained");
    assert.equal((lstatSync(looseTmp).mode & 0o777), 0o644, "loosely permissioned residue is not deleted");
    assert.equal(lstatSync(linkedTmp).nlink, 2, "hard-linked residue is not deleted");
    assert.equal(lstatSync(symlinkTmp).isSymbolicLink(), true, "symlink residue is not followed or deleted");
    assert.equal(readFileSync(outsideResidue, "utf8"), "protected residue");

    const invalidDurableRoot = join(sandbox, "invalid-durable-residue-cleanup");
    mkdirSync(invalidDurableRoot, { mode: 0o700 });
    const invalidDurablePath = join(invalidDurableRoot, ".brain-admin-key");
    const protectedBackup = join(
      invalidDurableRoot, "..brain-admin-key.303.3333333333333333.bak",
    );
    writeFileSync(invalidDurablePath, "damaged durable payload\n", { mode: 0o600 });
    writeFileSync(protectedBackup, "protected residue", { mode: 0o600 });
    utimesSync(protectedBackup, oldDate, oldDate);
    cleanupAdminKeyFileResidue(invalidDurablePath, { nowMs, residueMaxAgeMs: 1_000 });
    assert.equal(existsSync(protectedBackup), true, "a backup is retained unless the durable key verifies");

    const absentResidueRoot = join(sandbox, "absent-residue-cleanup");
    mkdirSync(absentResidueRoot, { mode: 0o700 });
    const absentResiduePath = join(absentResidueRoot, ".brain-admin-key");
    const absentTmp = join(absentResidueRoot, "..brain-admin-key.202.1111111111111111.tmp");
    const absentBak = join(absentResidueRoot, "..brain-admin-key.202.2222222222222222.bak");
    for (const candidate of [absentTmp, absentBak]) {
      writeFileSync(candidate, "protected residue", { mode: 0o600 });
      utimesSync(candidate, oldDate, oldDate);
    }
    cleanupAdminKeyFileResidue(absentResiduePath, { nowMs, residueMaxAgeMs: 1_000 });
    assert.equal(existsSync(absentTmp), false, "an old exact staging residue is removed");
    assert.equal(existsSync(absentBak), true, "a backup is retained while the durable destination is absent");
  }

  if (process.platform === "win32") {
    const nativeRoot = join(sandbox, "windows-native");
    mkdirSync(nativeRoot);
    const nativePath = join(nativeRoot, ".brain-admin-key");
    const username = process.env.USERNAME || process.env.USER;
    assert.ok(username, "the native Windows test needs the current username for icacls");
    const nativeSecretA = "native-$&()[]{}-0123456789abcdef";
    const nativeSecretB = "second-HEADER-<>|^-fedcba9876543210";
    const first = writeAdminKeyFile(nativePath, nativeSecretA, {
      username,
      randomBytes: entropy(7),
    });
    const firstCiphertext = readFileSync(nativePath);
    assert.equal(first.replaced, false);
    assert.match(firstCiphertext.toString("ascii"), /^BRAIN-ADMIN-KEY-DPAPI-V1\n/);
    assert.equal(firstCiphertext.includes(Buffer.from(nativeSecretA)), false);
    assert.equal(readAdminKeyFile(nativePath), nativeSecretA);

    const second = writeAdminKeyFile(nativePath, nativeSecretB, {
      username,
      randomBytes: entropy(8),
    });
    const secondCiphertext = readFileSync(nativePath);
    assert.equal(second.replaced, true);
    assert.notDeepEqual(secondCiphertext, firstCiphertext);
    assert.equal(secondCiphertext.includes(Buffer.from(nativeSecretB)), false);
    assert.equal(readAdminKeyFile(nativePath), nativeSecretB);
    const acl = spawnSync("icacls", [nativePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(acl.status, 0, "icacls can read the real restricted file ACL");
    assert.equal(String(acl.stdout).includes(nativeSecretB), false);
    assert.deepEqual(readdirSync(nativeRoot), [".brain-admin-key"]);
  } else {
    const outside = join(sandbox, "outside");
    writeFileSync(outside, "unchanged");
    const linkRoot = join(sandbox, "link-root");
    mkdirSync(linkRoot);
    const linkPath = join(linkRoot, ".brain-admin-key");
    symlinkSync(outside, linkPath);
    assert.throws(() => writeAdminKeyFile(linkPath, secretA, { randomBytes: entropy(9) }), /regular file/);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");

    const hardRoot = join(sandbox, "hard-root");
    mkdirSync(hardRoot);
    const hardPath = join(hardRoot, ".brain-admin-key");
    writeFileSync(hardPath, `${secretA}\n`, { mode: 0o600 });
    linkSync(hardPath, join(sandbox, "second-hard-link"));
    assert.throws(() => writeAdminKeyFile(hardPath, secretB, { randomBytes: entropy(10) }), /hard links/);
    assert.equal(readFileSync(hardPath, "utf8"), `${secretA}\n`);

    const looseFileRoot = join(sandbox, "loose-file-root");
    mkdirSync(looseFileRoot, { mode: 0o700 });
    const looseFilePath = join(looseFileRoot, ".brain-admin-key");
    writeFileSync(looseFilePath, `${secretA}\n`, { mode: 0o644 });
    assert.throws(
      () => writeAdminKeyFile(looseFilePath, secretB, { randomBytes: entropy(20) }),
      /readable only by the current user/,
    );
    assert.equal(readFileSync(looseFilePath, "utf8"), `${secretA}\n`);

    const looseRoot = join(sandbox, "loose-root");
    mkdirSync(looseRoot, { mode: 0o777 });
    chmodSync(looseRoot, 0o777);
    assert.throws(
      () => writeAdminKeyFile(join(looseRoot, ".brain-admin-key"), secretA, { randomBytes: entropy(11) }),
      /must not be writable by other users/,
    );

    const realRoot = join(sandbox, "real-root");
    mkdirSync(realRoot);
    const parentLink = join(sandbox, "parent-link");
    symlinkSync(realRoot, parentLink, "dir");
    assert.throws(
      () => writeAdminKeyFile(join(parentLink, ".brain-admin-key"), secretA, { randomBytes: entropy(12) }),
      /must not pass through a linked directory/,
    );

    const nestedRealRoot = join(sandbox, "nested-real-root");
    const nestedRealParent = join(nestedRealRoot, "leaf");
    mkdirSync(nestedRealParent, { recursive: true, mode: 0o700 });
    const nestedLinkedRoot = join(sandbox, "nested-linked-root");
    symlinkSync(nestedRealRoot, nestedLinkedRoot, "dir");
    assert.throws(
      () => writeAdminKeyFile(
        join(nestedLinkedRoot, "leaf", ".brain-admin-key"),
        secretA,
        { randomBytes: entropy(22) },
      ),
      /must not pass through a linked directory/,
    );
    assert.equal(existsSync(join(nestedRealParent, ".brain-admin-key")), false);
  }

  console.log("admin key file: all focused tests passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
