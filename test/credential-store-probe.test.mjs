/**
 * The credential store is round-tripped, not merely present.
 *
 * Issue 7 reported a Windows store that writes and then fails to read back, and
 * a `brain doctor` that never exercises it. These tests hold the second half:
 * the probe writes through the real store, reads back through the real store,
 * and compares. A store that silently returns something else must FAIL here,
 * because that is the shape of the failure that reaches a client.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CREDENTIAL_STORE_PROBE_VALUE,
  credentialStoreDescription,
  credentialStoreIsEncrypted,
  probeCredentialStore,
} from "../operations/credential-store-probe.mjs";
import { readAdminKeyFile, writeAdminKeyFile } from "../operations/admin-key-file.mjs";
import { checkCredentialStore, runAll, FAIL, OK, WARN } from "../doctor.mjs";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name} (${error?.message || error})`);
  }
};

/**
 * A reversible stand-in for DPAPI, framed exactly like the real PowerShell
 * helper. It must genuinely round-trip, so an envelope or framing mistake in
 * the store shows up here as a failed read rather than as a passing test.
 */
function simulatedDpapi({ corruptOnRead = false, failOnRead = false } = {}) {
  const seal = (bytes) => Buffer.from(bytes.map((b) => b ^ 0x5a));
  return (command, args, options) => {
    const operationAt = args.indexOf("-Operation");
    const lengthAt = args.indexOf("-ExpectedLength");
    const fileAt = args.indexOf("-File");
    const operation = operationAt >= 0 ? args[operationAt + 1] : null;
    const input = Buffer.from(options.input);
    const framed = lengthAt >= 0 && args[lengthAt + 1] === String(input.length) &&
      fileAt >= 0 && String(args[fileAt + 1] || "").endsWith("windows-dpapi.ps1");
    if (!framed || (operation !== "protect" && operation !== "unprotect")) {
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (operation === "unprotect" && failOnRead) {
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    let out = seal(input);
    if (operation === "unprotect" && corruptOnRead) {
      out = Buffer.from(`${CREDENTIAL_STORE_PROBE_VALUE.slice(0, -1)}X`, "utf8");
    }
    return { status: 0, stdout: out, stderr: Buffer.alloc(0) };
  };
}

const windowsStoreOptions = (dpapi) => ({
  platform: "win32",
  username: "probe-user",
  storeOptions: {
    runPowerShell: dpapi,
    runAcl: () => ({ status: 0 }),
  },
});

/* ------------------------------------------------------- the probe itself */

check("the probe value is visibly not a credential", () => {
  assert.match(CREDENTIAL_STORE_PROBE_VALUE, /^brain-doctor-store-probe/);
  assert.ok(CREDENTIAL_STORE_PROBE_VALUE.length >= 24, "must satisfy the admin key value contract");
});

check("this host's real store writes a value and reads back the same bytes", () => {
  const result = probeCredentialStore();
  assert.equal(result.ok, true, `stage ${result.stage}: ${result.error}`);
  assert.equal(result.stage, "compare");
  assert.equal(result.platform, process.platform);
});

check("the probe leaves nothing behind", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-probe-root-")));
  const result = probeCredentialStore({ temporaryRoot: root });
  assert.equal(result.ok, true, `stage ${result.stage}: ${result.error}`);
  assert.deepEqual(readdirSync(root), [], "the private probe directory must be removed");
});

check("the probe never touches a real install's key file", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-probe-install-")));
  const written = [];
  const result = probeCredentialStore({
    temporaryRoot: root,
    writeAdminKey: (path, secret, options) => { written.push(path); return writeAdminKeyFile(path, secret, options); },
  });
  assert.equal(result.ok, true, `stage ${result.stage}: ${result.error}`);
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith(root), `wrote outside the probe directory: ${written[0]}`);
});

/* --------------------------------------- the Windows store, end to end */

check("the Windows store round-trips a DPAPI envelope through write and read", () => {
  const dpapi = simulatedDpapi();
  let envelope = null;
  const result = probeCredentialStore({
    ...windowsStoreOptions(dpapi),
    readAdminKey: (path, options) => {
      envelope = readFileSync(path);
      return readAdminKeyFile(path, options);
    },
  });
  assert.equal(result.ok, true, `stage ${result.stage}: ${result.error}`);
  assert.equal(result.encrypted, true);
  assert.match(envelope.toString("ascii"), /^BRAIN-ADMIN-KEY-DPAPI-V1\n/,
    "the value on disk must be a sealed envelope, never the plain probe value");
  assert.equal(envelope.toString("ascii").includes(CREDENTIAL_STORE_PROBE_VALUE), false);
});

check("a Windows store that cannot unprotect is reported at the read stage", () => {
  const result = probeCredentialStore(windowsStoreOptions(simulatedDpapi({ failOnRead: true })));
  assert.equal(result.ok, false);
  assert.equal(result.stage, "write",
    "the write verifies its own read-back, so an unprotect failure stops the write");
  assert.match(result.error, /Windows DPAPI could not unprotect it for the current user/,
    "the message must name the half that broke, not just say it could not be decoded");
});

check("a store that returns a DIFFERENT value is caught by comparison", () => {
  // The write path verifies its own payload, so drive the corruption through a
  // read that succeeds and lies. Nothing throws here: only the comparison
  // separates a working store from a silently wrong one.
  const result = probeCredentialStore({
    readAdminKey: () => `${CREDENTIAL_STORE_PROBE_VALUE.slice(0, -1)}X`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "compare");
  assert.match(result.error, /different value/);
});

check("a probe that could not even start says so rather than passing", () => {
  const result = probeCredentialStore({ temporaryRoot: join(tmpdir(), "brain-probe-absent-root", "deeper") });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "setup");
});

check("the probe never throws, whatever the store does", () => {
  const result = probeCredentialStore({
    writeAdminKey: () => { throw new Error("the store exploded"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "write");
  assert.match(result.error, /the store exploded/);
});

/* -------------------------------------------------------- the doctor line */

check("doctor reports the round trip, naming the store it exercised", () => {
  const line = checkCredentialStore();
  assert.equal(line.name, "Credential store");
  assert.equal(line.status, OK);
  assert.match(line.detail, /read back the same bytes/);
  assert.ok(line.detail.includes(credentialStoreDescription(process.platform)));
});

check("doctor FAILS on a store that reads back something else", () => {
  const line = checkCredentialStore({
    probe: () => ({
      ok: false, stage: "compare", platform: "darwin", encrypted: false,
      description: credentialStoreDescription("darwin"),
      error: "the store returned a different value than the one written",
    }),
  });
  assert.equal(line.status, FAIL);
  assert.match(line.detail, /read back a different value/);
});

check("a Windows read failure names DPAPI and the stage-isolating probe", () => {
  const line = checkCredentialStore({
    probe: () => ({
      ok: false, stage: "read", platform: "win32", encrypted: true,
      description: credentialStoreDescription("win32"),
      error: "Windows could not decrypt the admin key with DPAPI for the current user",
    }),
  });
  assert.equal(line.status, FAIL);
  assert.match(line.detail, /could not read it back/);
  assert.match(line.fix, /DPAPI/);
  assert.match(line.fix, /windows-dpapi-probe\.mjs/);
  assert.match(line.fix, /Do NOT install on top of it/);
});

check("a probe that could not run is a WARN, never an ok", () => {
  const line = checkCredentialStore({
    probe: () => ({
      ok: false, stage: "setup", platform: "linux", encrypted: false,
      description: credentialStoreDescription("linux"), error: "no writable temporary directory",
    }),
  });
  assert.equal(line.status, WARN);
  assert.match(line.fix, /Nothing is known to be broken/);
});

check("the encryption claim tracks the platform rather than the wording", () => {
  assert.equal(credentialStoreIsEncrypted("win32"), true);
  assert.equal(credentialStoreIsEncrypted("darwin"), false);
  assert.equal(credentialStoreIsEncrypted("linux"), false);
  assert.match(credentialStoreDescription("win32"), /DPAPI/);
  assert.equal(/DPAPI/.test(credentialStoreDescription("darwin")), false);
});

const runAllChecks = await runAll({
  accountId: undefined,
  cloudflareToken: "",
});
check("runAll includes the credential store round trip", () => {
  const line = runAllChecks.find((x) => x.name === "Credential store");
  assert.ok(line, "brain doctor must exercise the store it will write the admin key into");
  assert.equal(line.status, OK, line.detail);
});

console.log(failures ? `\n${failures} failure(s)` : "\nall credential store probe tests passed");
// Let platform credential-store child-process handles finish closing. Forcing an
// immediate exit can race libuv's Windows async-handle teardown.
process.exitCode = failures ? 1 : 0;
