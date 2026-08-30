import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveTokens, loadTokens, tokenStorageDescription, tokenStorageStatus,
  verifyTokenStorageReadable,
  googleAuthChildEnvironment, openBrowser,
  GOOGLE_KEYCHAIN_SERVICE, GOOGLE_KEYCHAIN_ACCOUNT,
} from "../connectors/google-auth.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 220)));
  if (!condition) fail++;
};

const record = {
  google: {
    client_id: "client-id",
    client_secret: "client-secret",
    refresh_token: "refresh-secret",
    scopes: ["drive"],
  },
};

const replacement = {
  google: {
    ...record.google,
    client_secret: "replacement-client-secret",
    refresh_token: "replacement-refresh-secret",
    access_token: "replacement-access-secret",
    scopes: ["drive", "gmail"],
  },
};

const ambientCredentials = {
  HOME: "/fixture/home",
  USER: "fixture-user",
  USERNAME: "fixture-user",
  SystemRoot: "C:\\Windows",
  USERPROFILE: "C:\\Users\\fixture-user",
  APPDATA: "C:\\Users\\fixture-user\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\fixture-user\\AppData\\Local",
  TEMP: "C:\\Users\\fixture-user\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\fixture-user\\AppData\\Local\\Temp",
  DISPLAY: ":99",
  ADMIN_KEY: "ambient-admin-secret",
  CLOUDFLARE_API_TOKEN: "ambient-cloudflare-secret",
  AWS_SECRET_ACCESS_KEY: "ambient-aws-secret",
  OPENAI_API_KEY: "ambient-openai-secret",
  GOOGLE_CLIENT_SECRET: "ambient-google-secret",
};
const forbiddenEnvironmentNames = [
  "ADMIN_KEY", "CLOUDFLARE_API_TOKEN", "AWS_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET",
];

function childEnvironmentIsScrubbed(environment) {
  return forbiddenEnvironmentNames.every((name) => !Object.hasOwn(environment || {}, name));
}

function fakeDpapi() {
  const calls = [];
  const plaintextByCiphertext = new Map();
  let serial = 0;
  return {
    calls,
    runPowerShell(command, args, options) {
      const input = Buffer.from(options.input || Buffer.alloc(0));
      const operationAt = args.indexOf("-Operation");
      const lengthAt = args.indexOf("-ExpectedLength");
      const operation = operationAt >= 0 ? args[operationAt + 1] : null;
      const protect = operation === "protect";
      const unprotect = operation === "unprotect";
      const framed = lengthAt >= 0 && args[lengthAt + 1] === String(input.length) &&
        args.includes("-File") && String(args[args.indexOf("-File") + 1] || "").endsWith("windows-dpapi.ps1");
      calls.push({
        args: [...args], command, env: { ...options.env }, input,
        protect, unprotect,
      });
      if (protect === unprotect || !framed) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (protect) {
        const ciphertext = Buffer.from(`fixture-dpapi-ciphertext-${++serial}`, "ascii");
        plaintextByCiphertext.set(ciphertext.toString("base64"), Buffer.from(input));
        return { status: 0, stdout: ciphertext, stderr: Buffer.alloc(0) };
      }
      const plaintext = plaintextByCiphertext.get(input.toString("base64"));
      return plaintext
        ? { status: 0, stdout: Buffer.from(plaintext), stderr: Buffer.alloc(0) }
        : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

function fakeWindowsAcl({ retainHandles = process.platform !== "win32" } = {}) {
  const calls = [];
  const retainedHandles = [];
  return {
    calls,
    retainedHandles,
    runAcl(command, args, options) {
      calls.push({ command, args: [...args], env: { ...options.env } });
      // POSIX lets this test keep an old read handle while rename replaces a
      // path. Native Windows intentionally refuses that sharing violation, so
      // its normal replacement fixture closes ACL work before commit and a
      // dedicated test below verifies the locked-destination failure boundary.
      if (retainHandles) {
        retainedHandles.push({ path: args[0], descriptor: openSync(args[0], "r") });
      }
      if (readFileSync(args[0]).length !== 0) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

function fakeKeychain({ corruptAfterWrite = false } = {}) {
  const passwords = new Map();
  const calls = [];
  const invocations = [];
  const controls = { failDeleteAccount: null, deleteFailed: false };
  const runSecurity = (args, options = {}) => {
    calls.push([...args]);
    invocations.push({ kind: "security", args: [...args], env: { ...options.env } });
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "add-generic-password") {
      passwords.set(account, String(options.input || "").replace(/\n$/, ""));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!passwords.has(account)) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      if (!args.includes("-w")) return { status: 0, stdout: "metadata only", stderr: "" };
      const password = passwords.get(account);
      return {
        status: 0,
        stdout: corruptAfterWrite && account === GOOGLE_KEYCHAIN_ACCOUNT ? JSON.stringify({ wrong: true }) : password,
        stderr: "",
      };
    }
    if (args[0] === "delete-generic-password") {
      if (!passwords.has(account)) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      if (account === controls.failDeleteAccount && !controls.deleteFailed) {
        controls.deleteFailed = true;
        return { status: 1, stdout: "", stderr: "simulated Keychain deletion failure" };
      }
      passwords.delete(account);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected test command" };
  };
  const runExpect = (command, args, options = {}) => {
    invocations.push({ kind: "expect", command, args: [...args], env: { ...options.env } });
    return runSecurity(args.slice(2), options);
  };
  return {
    runSecurity, runExpect, calls, invocations, passwords,
    failNextDelete(account) {
      controls.failDeleteAccount = account;
      controls.deleteFailed = false;
    },
  };
}

const directory = mkdtempSync(join(tmpdir(), "brain-google-storage-"));
try {
  /* ================= atomic file fallback ================= */
  {
    const path = join(directory, "file", "google-tokens.json");
    saveTokens(record, { backend: "file", path });
    check("file fallback round-trips the complete credential record",
      JSON.stringify(loadTokens({ backend: "file", path })) === JSON.stringify(record));
    if (process.platform !== "win32") {
      check("file fallback is mode 0600", (statSync(path).mode & 0o777) === 0o600,
        (statSync(path).mode & 0o777).toString(8));
    }
    const changed = { google: { ...record.google, scopes: ["drive", "gmail"] } };
    saveTokens(changed, { backend: "file", path });
    check("an existing file is atomically replaced with the new record",
      loadTokens({ backend: "file", path }).google.scopes.length === 2);
    check("atomic writes leave no temporary credential copies",
      readdirSync(join(directory, "file")).join(",") === "google-tokens.json",
      readdirSync(join(directory, "file")).join(","));
  }

  if (process.platform !== "win32") {
    const path = join(directory, "permissive-file", "google-tokens.json");
    saveTokens(record, { backend: "file", path });
    const original = readFileSync(path);
    chmodSync(path, 0o644);
    let loadError;
    let saveError;
    try { loadTokens({ backend: "file", path }); } catch (error) { loadError = error; }
    try { saveTokens(replacement, { backend: "file", path }); } catch (error) { saveError = error; }
    const messages = `${loadError?.message || ""}\n${saveError?.message || ""}`;
    check("POSIX storage refuses an existing token file unless its mode is exactly 0600",
      /permissions must be exactly 0600/.test(loadError?.message || "") &&
      /permissions must be exactly 0600/.test(saveError?.message || "") &&
      readFileSync(path).equals(original) &&
      (statSync(path).mode & 0o777) === 0o644 &&
      !messages.includes(record.google.client_secret) &&
      !messages.includes(record.google.refresh_token));
    original.fill(0);
  }

  if (process.platform !== "win32") {
    const path = join(directory, "descriptor-permissions", "google-tokens.json");
    const permissionCalls = [];
    saveTokens(record, {
      backend: "file",
      path,
      fchmodFile(descriptor, mode) {
        permissionCalls.push({ descriptor, mode });
        fchmodSync(descriptor, mode);
      },
    });
    check("POSIX staging applies mode 0600 through an open file descriptor",
      permissionCalls.length === 1 &&
      Number.isInteger(permissionCalls[0].descriptor) &&
      permissionCalls[0].mode === 0o600 &&
      (statSync(path).mode & 0o777) === 0o600);
  }

  /* ================= Windows DPAPI file storage ================= */
  {
    const root = join(directory, "windows-simulated");
    const path = join(root, "google-tokens.json");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    const options = {
      backend: "file",
      platform: "win32",
      username: "fixture-user",
      path,
      environment: ambientCredentials,
      randomBytes: () => Buffer.alloc(8, 0x31),
      runAcl: acl.runAcl,
      runPowerShell: dpapi.runPowerShell,
    };
    saveTokens(record, options);
    const encrypted = readFileSync(path);
    check("Windows stores a versioned DPAPI envelope",
      encrypted.toString("ascii").startsWith("BRAIN-GOOGLE-TOKENS-DPAPI-V1\n"));
    check("Windows never writes OAuth plaintext to the durable file",
      !encrypted.includes(Buffer.from(record.google.client_secret)) &&
      !encrypted.includes(Buffer.from(record.google.refresh_token)));
    check("Windows DPAPI round-trips the complete credential record",
      JSON.stringify(loadTokens(options)) === JSON.stringify(record));
    check("the Windows storage description names DPAPI CurrentUser",
      /DPAPI CurrentUser encrypted file/i.test(tokenStorageDescription(options)));

    saveTokens(replacement, { ...options, randomBytes: () => Buffer.alloc(8, 0x32) });
    check("an existing Windows DPAPI record is atomically replaced",
      JSON.stringify(loadTokens(options)) === JSON.stringify(replacement));
    check("Windows transactions leave no plaintext or backup artifacts",
      readdirSync(root).join(",") === "google-tokens.json", readdirSync(root).join(","));

    const retainedViews = acl.retainedHandles.map(({ descriptor }) => {
      const bytes = readFileSync(descriptor);
      closeSync(descriptor);
      return bytes;
    });
    check("retained ACL test handles can observe only ciphertext",
      (process.platform === "win32" || retainedViews.length >= 3) && retainedViews.every((bytes) =>
        bytes.toString("ascii").startsWith("BRAIN-GOOGLE-TOKENS-DPAPI-V1\n") &&
        !bytes.includes(Buffer.from(record.google.refresh_token)) &&
        !bytes.includes(Buffer.from(replacement.google.refresh_token))));

    const allDpapiMetadataSafe = dpapi.calls.every((call) => {
      const metadata = JSON.stringify({ command: call.command, args: call.args, env: call.env });
      return childEnvironmentIsScrubbed(call.env) &&
        !metadata.includes(record.google.client_secret) &&
        !metadata.includes(record.google.refresh_token) &&
        !metadata.includes(replacement.google.client_secret) &&
        !metadata.includes(replacement.google.refresh_token);
    });
    check("DPAPI helpers receive secrets only on stdin and inherit no ambient credentials",
      allDpapiMetadataSafe && dpapi.calls.every((call) =>
        call.env.USERPROFILE === ambientCredentials.USERPROFILE &&
        call.env.LOCALAPPDATA === ambientCredentials.LOCALAPPDATA));
    check("Windows ACL helpers inherit no ambient credentials or OAuth values",
      acl.calls.every((call) => childEnvironmentIsScrubbed(call.env) &&
        !JSON.stringify(call).includes(record.google.refresh_token) &&
        !JSON.stringify(call).includes(replacement.google.refresh_token)));
  }

  if (process.platform === "win32") {
    const root = join(directory, "windows-locked-destination");
    const path = join(root, "google-tokens.json");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    const base = {
      backend: "file",
      platform: "win32",
      username: process.env.USERNAME || process.env.USER,
      path,
      environment: process.env,
      runAcl: acl.runAcl,
      runPowerShell: dpapi.runPowerShell,
    };
    saveTokens(record, { ...base, randomBytes: () => Buffer.alloc(8, 0x71) });
    const held = openSync(path, "r");
    let error;
    try {
      saveTokens(replacement, { ...base, randomBytes: () => Buffer.alloc(8, 0x72) });
    } catch (caught) {
      error = caught;
    } finally {
      closeSync(held);
    }
    check("a Windows sharing lock refuses replacement without corrupting the prior token",
      /replacement could not be committed/i.test(error?.message || "") &&
      JSON.stringify(loadTokens(base)) === JSON.stringify(record), error?.message);
    check("a refused Windows sharing lock leaves no transaction residue",
      readdirSync(root).join(",") === "google-tokens.json", readdirSync(root).join(","));
  }

  {
    const root = join(directory, "windows-legacy-migration");
    const path = join(root, "google-tokens.json");
    const legacy = Buffer.from(JSON.stringify(record, null, 2), "utf8");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path, legacy, { mode: 0o600 });
    const options = {
      backend: "file",
      platform: "win32",
      username: "fixture-user",
      path,
      environment: ambientCredentials,
      randomBytes: () => Buffer.alloc(8, 0x33),
      runAcl: acl.runAcl,
      runPowerShell: dpapi.runPowerShell,
    };
    const legacyStatus = tokenStorageStatus({
      ...options,
      runPowerShell: () => { throw new Error("status must not invoke DPAPI"); },
    });
    check("Windows status reports legacy plaintext and pending DPAPI migration truthfully",
      legacyStatus.exists && legacyStatus.backend === "legacy-file" &&
      legacyStatus.encrypted === false && legacyStatus.migrationPending === true &&
      /legacy Windows plaintext.*migration pending/i.test(legacyStatus.description));
    const loaded = loadTokens(options);
    const migrated = readFileSync(path);
    check("a legacy Windows plaintext file is read and migrated to DPAPI",
      JSON.stringify(loaded) === JSON.stringify(record) &&
      migrated.toString("ascii").startsWith("BRAIN-GOOGLE-TOKENS-DPAPI-V1\n"));
    check("verified Windows migration removes the durable plaintext",
      !migrated.includes(Buffer.from(record.google.client_secret)) &&
      !migrated.includes(Buffer.from(record.google.refresh_token)));
    const encryptedStatus = tokenStorageStatus({
      ...options,
      runPowerShell: () => { throw new Error("status must inspect only the envelope header"); },
    });
    check("Windows status recognizes a DPAPI envelope without decrypting it",
      encryptedStatus.exists && encryptedStatus.backend === "file" &&
      encryptedStatus.encrypted === true && encryptedStatus.migrationPending === false &&
      /DPAPI CurrentUser encrypted file/i.test(encryptedStatus.description));

    // Status stops at the header, by design and by the test above. That leaves
    // a real gap on Windows, because the header is 29 plaintext bytes: a blob
    // written by another Windows user carries a perfect one. The verifier is
    // the opt-in counterpart that actually opens the record.
    const callsBefore = dpapi.calls.length;
    const opened = verifyTokenStorageReadable(options);
    const unprotectAttempts = dpapi.calls.slice(callsBefore).filter((c) => c.unprotect);
    check("verifying readability actually decrypts, unlike status",
      opened.checked === true && opened.readable === true && unprotectAttempts.length === 1,
      JSON.stringify({ opened, unprotectAttempts: unprotectAttempts.length }));
    check("verifying readability returns no credential material, only a verdict",
      Object.keys(opened).every((k) => ["checked", "readable", "reason"].includes(k)) &&
      !JSON.stringify(opened).includes(record.google.refresh_token) &&
      !JSON.stringify(opened).includes(record.google.client_secret),
      JSON.stringify(opened));

    const undecryptable = verifyTokenStorageReadable({
      ...options,
      runPowerShell: (command, args) => (args.includes("unprotect")
        ? { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : dpapi.runPowerShell(command, args, { input: Buffer.alloc(0) })),
    });
    check("a credential that cannot be decrypted reports unreadable rather than present",
      undecryptable.checked === true && undecryptable.readable === false &&
      typeof undecryptable.reason === "string" && undecryptable.reason.length > 0,
      JSON.stringify(undecryptable));
    check("the unreadable reason quotes no credential value",
      !undecryptable.reason.includes(record.google.refresh_token) &&
      !undecryptable.reason.includes(record.google.client_secret),
      undecryptable.reason);

    const bytesAfter = readFileSync(path);
    check("verifying readability never rewrites the store it is diagnosing",
      bytesAfter.equals(migrated), "the verifier must be read-only");

    for (const { descriptor } of acl.retainedHandles) closeSync(descriptor);
  }

  {
    const root = join(directory, "windows-staged-mismatch");
    const path = join(root, "google-tokens.json");
    const legacy = Buffer.from(JSON.stringify(record, null, 2), "utf8");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path, legacy, { mode: 0o600 });
    let error;
    try {
      loadTokens({
        backend: "file",
        platform: "win32",
        username: "fixture-user",
        path,
        randomBytes: () => Buffer.alloc(8, 0x34),
        runAcl: acl.runAcl,
        runPowerShell: dpapi.runPowerShell,
        readFileForVerification: (_path, descriptor, phase) =>
          phase === "staged"
            ? Buffer.from(JSON.stringify(replacement, null, 2), "utf8")
            : readFileSync(descriptor),
      });
    } catch (caught) { error = caught; }
    check("a staged Windows migration mismatch fails before replacement",
      /staged payload did not read back exactly/i.test(error?.message || ""), error?.message);
    check("a failed pre-commit migration leaves the legacy plaintext record intact",
      readFileSync(path).equals(legacy));
    check("staged verification failure leaves no transaction residue",
      readdirSync(root).join(",") === "google-tokens.json", readdirSync(root).join(","));
    for (const { descriptor } of acl.retainedHandles) closeSync(descriptor);
  }

  {
    const root = join(directory, "windows-post-replacement-rollback");
    const path = join(root, "google-tokens.json");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    const base = {
      backend: "file",
      platform: "win32",
      username: "fixture-user",
      path,
      runAcl: acl.runAcl,
      runPowerShell: dpapi.runPowerShell,
    };
    saveTokens(record, { ...base, randomBytes: () => Buffer.alloc(8, 0x35) });
    const priorCiphertext = readFileSync(path);
    let error;
    try {
      saveTokens(replacement, {
        ...base,
        randomBytes: () => Buffer.alloc(8, 0x36),
        readFileForVerification: (_path, descriptor, phase) =>
          phase === "persisted"
            ? Buffer.from(JSON.stringify(record, null, 2), "utf8")
            : readFileSync(descriptor),
      });
    } catch (caught) { error = caught; }
    check("post-replacement verification failure reports verified rollback",
      /prior credential record was restored and verified/i.test(error?.message || ""), error?.message);
    check("post-replacement failure restores the exact prior encrypted record",
      readFileSync(path).equals(priorCiphertext) &&
      JSON.stringify(loadTokens(base)) === JSON.stringify(record));
    check("rollback errors never reveal either credential record",
      !String(error?.message || error).includes(record.google.refresh_token) &&
      !String(error?.message || error).includes(replacement.google.refresh_token));
    check("verified rollback leaves no transaction residue",
      readdirSync(root).join(",") === "google-tokens.json", readdirSync(root).join(","));
    for (const { descriptor } of acl.retainedHandles) closeSync(descriptor);
  }

  {
    const root = join(directory, "windows-absent-rollback");
    const path = join(root, "google-tokens.json");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    let error;
    try {
      saveTokens(record, {
        backend: "file",
        platform: "win32",
        username: "fixture-user",
        path,
        randomBytes: () => Buffer.alloc(8, 0x37),
        runAcl: acl.runAcl,
        runPowerShell: dpapi.runPowerShell,
        readFileForVerification: (_path, descriptor, phase) =>
          phase === "persisted"
            ? Buffer.from(JSON.stringify(replacement, null, 2), "utf8")
            : readFileSync(descriptor),
      });
    } catch (caught) { error = caught; }
    check("a failed first Windows write leaves no token destination",
      /no token destination was left behind/i.test(error?.message || "") && !existsSync(path), error?.message);
    check("a failed first Windows write leaves no ciphertext residue",
      existsSync(root) && readdirSync(root).length === 0, existsSync(root) ? readdirSync(root).join(",") : "missing");
    for (const { descriptor } of acl.retainedHandles) closeSync(descriptor);
  }

  {
    const root = join(directory, "windows-directory-sync-rollback");
    const path = join(root, "google-tokens.json");
    const dpapi = fakeDpapi();
    const acl = fakeWindowsAcl();
    const base = {
      backend: "file",
      platform: "win32",
      username: "fixture-user",
      path,
      runAcl: acl.runAcl,
      runPowerShell: dpapi.runPowerShell,
    };
    saveTokens(record, { ...base, randomBytes: () => Buffer.alloc(8, 0x38) });
    let error;
    try {
      saveTokens(replacement, {
        ...base,
        randomBytes: () => Buffer.alloc(8, 0x39),
        syncParentDirectory: (_directory, phase) => {
          if (phase === "persisted") {
            throw Object.assign(new Error(replacement.google.refresh_token), { code: "EIO" });
          }
        },
      });
    } catch (caught) { error = caught; }
    check("a real directory durability failure rolls back the Windows credential",
      /prior credential record was restored and verified/i.test(error?.message || "") &&
      JSON.stringify(loadTokens(base)) === JSON.stringify(record), error?.message);
    check("directory-sync failures do not reveal the rejected credential",
      !String(error?.message || error).includes(replacement.google.refresh_token));
    for (const { descriptor } of acl.retainedHandles) closeSync(descriptor);
  }

  {
    const root = join(directory, "windows-acl-migration-failure");
    const path = join(root, "google-tokens.json");
    const legacy = Buffer.from(JSON.stringify(record, null, 2), "utf8");
    const dpapi = fakeDpapi();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path, legacy, { mode: 0o600 });
    let error;
    try {
      loadTokens({
        backend: "file",
        platform: "win32",
        username: "fixture-user",
        path,
        runAcl: () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(record.google.refresh_token) }),
        runPowerShell: dpapi.runPowerShell,
      });
    } catch (caught) { error = caught; }
    check("a Windows ACL failure leaves a legacy credential untouched",
      /could not restrict.*staging/i.test(error?.message || "") && readFileSync(path).equals(legacy), error?.message);
    check("Windows ACL failure output is never copied into the error",
      !String(error?.message || error).includes(record.google.refresh_token));
  }

  {
    const root = join(directory, "windows-malformed-envelope");
    const path = join(root, "google-tokens.json");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path, "BRAIN-GOOGLE-TOKENS-DPAPI-V1\nnot-base64!\n", { mode: 0o600 });
    let error;
    try {
      loadTokens({
        backend: "file",
        platform: "win32",
        username: "fixture-user",
        path,
        runPowerShell: () => { throw new Error("malformed data must not reach DPAPI"); },
      });
    } catch (caught) { error = caught; }
    check("a malformed DPAPI envelope never falls back to plaintext",
      /DPAPI envelope is malformed/i.test(error?.message || ""), error?.message);
  }

  {
    const root = join(directory, "windows-secret-safe-failure");
    const path = join(root, "google-tokens.json");
    let error;
    try {
      saveTokens(record, {
        backend: "file",
        platform: "win32",
        username: "fixture-user",
        path,
        runPowerShell: () => { throw new Error(record.google.refresh_token); },
      });
    } catch (caught) { error = caught; }
    check("DPAPI process failures are secret-safe",
      /could not protect.*DPAPI/i.test(error?.message || "") &&
      !String(error?.message || error).includes(record.google.refresh_token), error?.message);
    check("a DPAPI failure writes no credential file", !existsSync(path));
  }

  /* ================= child environment boundaries ================= */
  {
    const clean = googleAuthChildEnvironment(ambientCredentials, {
      platform: "linux",
      browser: true,
    });
    check("the shared Google helper environment drops ambient credentials",
      childEnvironmentIsScrubbed(clean));
    check("the browser environment keeps only required desktop session state",
      clean.DISPLAY === ":99" && clean.HOME === "/fixture/home");

    let browserCall;
    const opened = openBrowser("https://accounts.google.test/authorize", {
      platform: "linux",
      environment: ambientCredentials,
      spawnChild(command, args, options) {
        browserCall = { command, args: [...args], env: { ...options.env } };
        return { unref() {} };
      },
    });
    check("browser launch inherits no ambient credentials",
      opened && childEnvironmentIsScrubbed(browserCall?.env), JSON.stringify(browserCall?.env));
    check("browser launch does not use a shell",
      browserCall?.command === "/usr/bin/xdg-open" && browserCall?.args.length === 1);
  }

  /* ================= Keychain default ================= */
  {
    const keychain = fakeKeychain();
    const options = {
      backend: "keychain",
      platform: "darwin",
      runSecurity: keychain.runSecurity,
      path: join(directory, "absent.json"),
      environment: ambientCredentials,
    };
    saveTokens(record, options);
    check("Keychain round-trips the complete credential record",
      JSON.stringify(loadTokens(options)) === JSON.stringify(record));
    const add = keychain.calls.find((args) => args[0] === "add-generic-password" && args.includes(GOOGLE_KEYCHAIN_ACCOUNT)) || [];
    check("the Keychain password is supplied over stdin, never argv",
      add.at(-1) === "-w" && !add.join(" ").includes("refresh-secret"), add.join(" "));
    check("the Keychain service and account are explicitly scoped",
      add.includes(GOOGLE_KEYCHAIN_SERVICE) && add.includes(GOOGLE_KEYCHAIN_ACCOUNT), add.join(" "));
    const status = tokenStorageStatus(options);
    check("the doctor probe checks Keychain existence without revealing the password",
      status.exists && keychain.calls.at(-1)[0] === "find-generic-password" && !keychain.calls.at(-1).includes("-w"));
    check("the storage description makes the exact Keychain item findable",
      tokenStorageDescription(options).includes(GOOGLE_KEYCHAIN_SERVICE) &&
      tokenStorageDescription(options).includes(GOOGLE_KEYCHAIN_ACCOUNT));
    check("Keychain security helpers inherit no ambient credentials",
      keychain.invocations.every((call) => childEnvironmentIsScrubbed(call.env)));
  }

  {
    const keychain = fakeKeychain();
    const options = {
      backend: "keychain",
      platform: "darwin",
      runExpect: keychain.runExpect,
      runSecurity: keychain.runSecurity,
      environment: ambientCredentials,
    };
    saveTokens(record, options);
    const expectCalls = keychain.invocations.filter((call) => call.kind === "expect");
    check("Expect helpers inherit no ambient credentials",
      expectCalls.length > 0 && expectCalls.every((call) => childEnvironmentIsScrubbed(call.env)));
    check("Expect argv contains no Google credential value",
      expectCalls.every((call) => {
        const metadata = JSON.stringify({ command: call.command, args: call.args, env: call.env });
        return !metadata.includes(record.google.client_secret) &&
          !metadata.includes(record.google.refresh_token);
      }));
    check("the scrubbed Expect path still round-trips through Keychain",
      JSON.stringify(loadTokens(options)) === JSON.stringify(record));
  }

  /* ================= verified legacy migration ================= */
  // These fixtures exercise migration from a real POSIX mode-0600 file into
  // macOS Keychain. NTFS cannot reproduce that inode/mode precondition, while
  // the native Windows block below separately covers plaintext-to-DPAPI
  // migration and rollback on Windows itself.
  if (process.platform !== "win32") {
    {
      const path = join(directory, "migration", "google-tokens.json");
      saveTokens(record, { backend: "file", platform: "linux", path });
      const keychain = fakeKeychain();
      const options = { backend: "keychain", platform: "darwin", runSecurity: keychain.runSecurity, path };
      const loaded = loadTokens(options);
      check("a legacy file is copied to Keychain and read back before removal",
        JSON.stringify(loaded) === JSON.stringify(record) && keychain.passwords.size > 1);
      check("the verified legacy credential file is removed", !existsSync(path));
    }
    {
      const path = join(directory, "failed-migration", "google-tokens.json");
      saveTokens(record, { backend: "file", platform: "linux", path });
      const keychain = fakeKeychain({ corruptAfterWrite: true });
      let error = null;
      try {
        loadTokens({ backend: "keychain", platform: "darwin", runSecurity: keychain.runSecurity, path });
      } catch (caught) {
        error = caught;
      }
      check("a failed Keychain verification raises a clear error", !!error && /verification failed/i.test(error.message), error?.message);
      check("a failed migration leaves the legacy credential file untouched", existsSync(path));
    }
  }
  {
    const keychain = fakeKeychain();
    const options = { backend: "keychain", platform: "darwin", runSecurity: keychain.runSecurity };
    saveTokens(record, options);
    const oldDescriptor = JSON.parse(keychain.passwords.get(GOOGLE_KEYCHAIN_ACCOUNT));
    const oldPartToFail = `${GOOGLE_KEYCHAIN_ACCOUNT}.${oldDescriptor.g}.${String(Math.min(1, oldDescriptor.n - 1)).padStart(4, "0")}`;
    keychain.failNextDelete(oldPartToFail);
    const replacement = { google: { ...record.google, scopes: ["drive", "gmail"], access_token: "replacement-access" } };
    saveTokens(replacement, options);
    check("old-generation cleanup failure cannot roll back a verified Keychain switch",
      JSON.stringify(loadTokens(options)) === JSON.stringify(replacement));
  }

  /* ================= platform and explicit selection ================= */
  // Simulated POSIX file selection still requires real POSIX mode semantics.
  // Linux and macOS matrix jobs cover these paths; Windows has the native
  // DPAPI selection and replacement checks immediately below.
  if (process.platform !== "win32") {
    {
      const path = join(directory, "linux-default", "google-tokens.json");
      saveTokens(record, { platform: "linux", path, env: {} });
      check("non-macOS defaults to the file fallback", existsSync(path));
    }
    {
      const path = join(directory, "mac-explicit-file", "google-tokens.json");
      saveTokens(record, { platform: "darwin", path, env: { BRAIN_GOOGLE_TOKEN_STORE: "file" } });
      check("macOS can explicitly select the file fallback", existsSync(path));
    }
  }

  if (process.platform === "win32") {
    const root = join(directory, "windows-native");
    const path = join(root, "google-tokens.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
    const options = {
      backend: "file",
      platform: "win32",
      username: process.env.USERNAME || process.env.USER,
      path,
    };
    const migrated = loadTokens(options);
    const migratedRaw = readFileSync(path);
    check("native Windows migrates legacy plaintext with CurrentUser DPAPI",
      JSON.stringify(migrated) === JSON.stringify(record) &&
      migratedRaw.toString("ascii").startsWith("BRAIN-GOOGLE-TOKENS-DPAPI-V1\n") &&
      !migratedRaw.includes(Buffer.from(record.google.refresh_token)));
    saveTokens(replacement, options);
    const replacementRaw = readFileSync(path);
    check("native Windows replaces and decrypts a DPAPI credential record",
      JSON.stringify(loadTokens(options)) === JSON.stringify(replacement) &&
      !replacementRaw.includes(Buffer.from(replacement.google.refresh_token)));
    const acl = spawnSync("icacls", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
    check("native Windows leaves the token file under a readable restricted ACL",
      acl.status === 0 && !String(acl.stdout).includes(replacement.google.refresh_token));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\ngoogle auth storage: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
