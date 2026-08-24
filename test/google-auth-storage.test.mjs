import { mkdtempSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveTokens, loadTokens, tokenStorageDescription, tokenStorageStatus,
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

function fakeKeychain({ corruptAfterWrite = false } = {}) {
  const passwords = new Map();
  const calls = [];
  const controls = { failDeleteAccount: null, deleteFailed: false };
  const runSecurity = (args, options = {}) => {
    calls.push([...args]);
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
  return {
    runSecurity, calls, passwords,
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

  /* ================= Keychain default ================= */
  {
    const keychain = fakeKeychain();
    const options = { backend: "keychain", platform: "darwin", runSecurity: keychain.runSecurity, path: join(directory, "absent.json") };
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
  }

  /* ================= verified legacy migration ================= */
  {
    const path = join(directory, "migration", "google-tokens.json");
    saveTokens(record, { backend: "file", path });
    const keychain = fakeKeychain();
    const options = { backend: "keychain", platform: "darwin", runSecurity: keychain.runSecurity, path };
    const loaded = loadTokens(options);
    check("a legacy file is copied to Keychain and read back before removal",
      JSON.stringify(loaded) === JSON.stringify(record) && keychain.passwords.size > 1);
    check("the verified legacy credential file is removed", !existsSync(path));
  }
  {
    const path = join(directory, "failed-migration", "google-tokens.json");
    saveTokens(record, { backend: "file", path });
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
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURES` : `\ngoogle auth storage: all ${ran} tests passed`);
process.exit(fail ? 1 : 0);
