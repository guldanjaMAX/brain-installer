import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_LOOPBACK_BIND_ADDRESS,
  ProviderOAuthError,
  authorizeProvider,
  assertQuickBooksSourceBinding,
  bindQuickBooksConnection,
  buildProviderAuthorizationUrl,
  clearProviderCredentials,
  disconnectProvider,
  exchangeProviderAuthorizationCode,
  loadProviderCredentials,
  loadProviderSyncState,
  loadQuickBooksCredentials,
  loadQuickBooksSourceRegistry,
  providerAccessToken,
  providerCredentialOptions,
  providerCredentialStatus,
  providerRefreshLockPath,
  providerOAuthChildEnvironment,
  providerRedirectUri,
  quickBooksSandboxRedirectUri,
  refreshProviderCredentials,
  saveProviderCredentials,
  saveProviderSyncState,
} from "../connectors/provider-oauth.mjs";
import { saveTokens } from "../connectors/google-auth.mjs";
import { quickBooksCompanyFingerprint } from "../connectors/quickbooks-online.mjs";

let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

function fakeKeychain({ failReads = false } = {}) {
  const passwords = new Map();
  const calls = [];
  const runSecurity = (args, options = {}) => {
    calls.push([...args]);
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "add-generic-password") {
      passwords.set(account, String(options.input || "").replace(/\n$/, ""));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (failReads) return { status: 1, stdout: "", stderr: "simulated unreadable Keychain" };
      if (!passwords.has(account)) {
        return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      }
      return args.includes("-w")
        ? { status: 0, stdout: passwords.get(account), stderr: "" }
        : { status: 0, stdout: "metadata only", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      if (!passwords.has(account)) {
        return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      }
      passwords.delete(account);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected test command" };
  };
  return { calls, passwords, runSecurity };
}

function fakeDpapi() {
  const calls = [];
  const plaintextByCiphertext = new Map();
  let serial = 0;
  const runPowerShell = (_command, args, options = {}) => {
    const input = Buffer.from(options.input || Buffer.alloc(0));
    const operation = args[args.indexOf("-Operation") + 1];
    calls.push(operation);
    if (operation === "protect") {
      const ciphertext = Buffer.from(`fixture-qbo-dpapi-${++serial}`, "ascii");
      plaintextByCiphertext.set(ciphertext.toString("base64"), Buffer.from(input));
      return { status: 0, stdout: ciphertext, stderr: Buffer.alloc(0) };
    }
    if (operation === "unprotect") {
      const plaintext = plaintextByCiphertext.get(input.toString("base64"));
      return plaintext
        ? { status: 0, stdout: Buffer.from(plaintext), stderr: Buffer.alloc(0) }
        : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { calls, runPowerShell };
}

function fakeWindowsAcl() {
  const calls = [];
  const runAcl = (_command, args) => {
    calls.push([...args]);
    return readFileSync(args[0]).length === 0
      ? { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { calls, runAcl };
}

// Exercise file-backed provider flows on every CI platform without pretending
// that Windows exposes POSIX mode bits. Windows fixtures still take the real
// production DPAPI and ACL branches; only the OS child processes are replaced
// with deterministic in-memory doubles. Dedicated tests below assert that both
// branches are invoked before ciphertext is committed.
function testFileStorage(home, overrides = {}) {
  if (process.platform !== "win32") {
    return { backend: "file", platform: "linux", home, ...overrides };
  }
  const dpapi = fakeDpapi();
  const acl = fakeWindowsAcl();
  return {
    backend: "file",
    platform: "win32",
    home,
    username: "fixture-user",
    environment: { SystemRoot: "C:\\Windows", USERNAME: "fixture-user" },
    runPowerShell: dpapi.runPowerShell,
    runAcl: acl.runAcl,
    ...overrides,
  };
}

// Tests seed historical or crash-recovery states beneath the production
// mutation API. Production callers cannot use this path: direct QuickBooks
// save/clear exports deliberately refuse outside the source-bound lock.
function saveQuickBooksFixture(connection, storage) {
  const record = {
    ...connection,
    provider: "quickbooks",
    schema_version: 1,
  };
  saveTokens({
    connection: record,
    quickbooks_source_bindings: {
      schema_version: 1,
      sources: { ...(record.quickbooks_binding?.sources || {}) },
    },
  }, providerCredentialOptions("quickbooks", storage));
  return loadProviderCredentials("quickbooks", storage);
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function loopbackGet({ port, host, path }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path,
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

{
  check("existing provider callback bytes remain unchanged",
    providerRedirectUri() === "http://127.0.0.1:47812" &&
    providerRedirectUri(49123) === "http://127.0.0.1:49123");
  check("QuickBooks sandbox defaults to Intuit's localhost callback while binding only IPv4 loopback",
    quickBooksSandboxRedirectUri() === "http://localhost:47812/" &&
    quickBooksSandboxRedirectUri(49123, "127.0.0.1") === "http://127.0.0.1:49123/" &&
    PROVIDER_LOOPBACK_BIND_ADDRESS === "127.0.0.1");
  assert.throws(() => quickBooksSandboxRedirectUri(49123, "0.0.0.0"), /localhost or 127\.0\.0\.1/);
  check("QuickBooks callback configuration cannot broaden the listener", true);
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-loopback-"));
  const callbackStorage = testFileStorage(folder);
  try {
    const port = await unusedLoopbackPort();
    let openedUrl = null;
    let tokenRequest = null;
    let callbackRequests = null;
    const connection = await authorizeProvider("quickbooks", {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      port,
      redirectHost: "localhost",
      redirectUri: quickBooksSandboxRedirectUri(port, "localhost"),
      timeoutMs: 5_000,
      storage: callbackStorage,
      openImpl: (url) => {
        openedUrl = new URL(url);
        const state = openedUrl.searchParams.get("state");
        callbackRequests = (async () => {
          const rejectedHost = await loopbackGet({
            port,
            host: `not-local.invalid:${port}`,
            path: `/?code=ignored&state=${encodeURIComponent(state)}`,
          });
          const acceptedHost = await loopbackGet({
            port,
            host: `localhost:${port}`,
            path: `/?code=fixture-code&state=${encodeURIComponent(state)}&realmId=company-one`,
          });
          return { rejectedHost, acceptedHost };
        })();
        return true;
      },
      log: () => {},
      fetchImpl: async (_url, options) => {
        tokenRequest = options;
        return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
      },
      prepareConnection: (candidate, custody) => bindQuickBooksConnection({
        prior: custody.prior,
        sourceRegistry: custody.sourceRegistry,
        candidate,
        source: "quickbooks",
        environment: "sandbox",
      }),
    });
    const callbackStatuses = await callbackRequests;
    check("QuickBooks localhost callback runs on IPv4 loopback and rejects an unexpected Host header",
      callbackStatuses.rejectedHost === 400 && callbackStatuses.acceptedHost === 200 &&
      openedUrl.searchParams.get("redirect_uri") === `http://localhost:${port}/`);
    check("the live local callback keeps single-use state and confidential-client exchange aligned with company binding",
      openedUrl.searchParams.has("state") && !openedUrl.searchParams.has("code_challenge") &&
      !String(tokenRequest.body).includes("code_verifier=") &&
      String(tokenRequest.body).includes(`redirect_uri=http%3A%2F%2Flocalhost%3A${port}%2F`) &&
      connection.provider_metadata.realm_id === "company-one" &&
      connection.provider_metadata.qbo_company_fingerprint === quickBooksCompanyFingerprint("company-one"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-authorize-race-"));
  const raceStorage = testFileStorage(folder);
  try {
    const port = await unusedLoopbackPort();
    let callbackDone = null;
    let prepareCalls = 0;
    await assert.rejects(
      authorizeProvider("quickbooks", {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        port,
        redirectUri: quickBooksSandboxRedirectUri(port),
        timeoutMs: 5_000,
        storage: raceStorage,
        openImpl: (url) => {
          const authorization = new URL(url);
          callbackDone = loopbackGet({
            port,
            host: `localhost:${port}`,
            path: `/?code=fixture-code&state=${encodeURIComponent(authorization.searchParams.get("state"))}&realmId=company-one`,
          });
          return true;
        },
        log: () => {},
        fetchImpl: async () => {
          const concurrent = bindQuickBooksConnection({
            candidate: {
              client_id: "fixture-client",
              client_secret: "fixture-secret",
              access_token: "concurrent-access",
              refresh_token: "concurrent-refresh",
              provider_metadata: { realm_id: "company-one" },
            },
            source: "quickbooks",
            environment: "sandbox",
          });
          saveQuickBooksFixture(concurrent, raceStorage);
          return json({ access_token: "candidate-access", refresh_token: "candidate-refresh" });
        },
        prepareConnection: (candidate, custody) => {
          prepareCalls++;
          return bindQuickBooksConnection({
            prior: custody.prior,
            sourceRegistry: custody.sourceRegistry,
            candidate,
            source: "quickbooks",
            environment: "sandbox",
          });
        },
      }),
      (error) => error instanceof ProviderOAuthError &&
        error.code === "credential_changed_during_authorization",
    );
    await callbackDone;
    check("QuickBooks authorization cannot overwrite a credential changed while the browser ceremony was open",
      prepareCalls === 0 &&
      loadProviderCredentials("quickbooks", raceStorage).refresh_token === "concurrent-refresh");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const url = new URL(buildProviderAuthorizationUrl("dropbox", {
    clientId: "public-client",
    redirectUri: "http://127.0.0.1:47812",
    state: "state-fixture",
    challenge: "challenge-fixture",
  }));
  check("Dropbox authorization asks for offline access and PKCE",
    url.searchParams.get("token_access_type") === "offline" &&
    url.searchParams.get("code_challenge_method") === "S256" &&
    url.searchParams.get("state") === "state-fixture");
}

if (process.platform !== "win32") {
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-lock-root-"));
  try {
    const permissiveHome = join(folder, "permissive");
    mkdirSync(join(permissiveHome, ".brain"), { recursive: true, mode: 0o700 });
    chmodSync(join(permissiveHome, ".brain"), 0o755);
    assert.throws(
      () => providerRefreshLockPath("quickbooks", {
        backend: "file", platform: process.platform, home: permissiveHome,
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_lock_unsafe",
    );

    const realHome = join(folder, "real");
    const linkedHome = join(folder, "linked");
    mkdirSync(join(realHome, ".brain"), { recursive: true, mode: 0o700 });
    mkdirSync(linkedHome, { mode: 0o700 });
    symlinkSync(join(realHome, ".brain"), join(linkedHome, ".brain"));
    assert.throws(
      () => providerRefreshLockPath("quickbooks", {
        backend: "file", platform: process.platform, home: linkedHome,
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_lock_unsafe",
    );

    const ownerHome = join(folder, "owner");
    mkdirSync(join(ownerHome, ".brain"), { recursive: true, mode: 0o700 });
    assert.throws(
      () => providerRefreshLockPath("quickbooks", {
        backend: "file",
        platform: process.platform,
        home: ownerHome,
        getUid: () => process.getuid() + 1,
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_lock_unsafe",
    );
    check("QuickBooks lock roots reject permissive mode, symlink, and wrong-owner boundaries", true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-provider-lock-compat-"));
  const untouchedHome = join(folder, "must-not-be-created");
  try {
    const storageOptions = { backend: "keychain", platform: "linux", home: untouchedHome };
    const options = providerCredentialOptions("slack", storageOptions);
    const identity = [
      "slack",
      options.backend || "auto",
      options.path,
      options.keychainService,
      options.keychainAccount,
    ].join("\0");
    const expected = join(
      join(untouchedHome, ".brain"),
      `.provider-refresh-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.lock`,
    );
    check("non-QuickBooks lock paths remain byte-compatible and perform no filesystem or platform validation",
      providerRefreshLockPath("slack", storageOptions) === expected && !existsSync(untouchedHome));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-custody-migration-"));
  const tokenPath = join(folder, ".brain", "quickbooks-tokens.json");
  const fileStorage = { backend: "file", platform: "linux", home: folder, path: tokenPath };
  const keychain = fakeKeychain();
  const keychainStorage = {
    backend: "keychain",
    platform: "darwin",
    home: folder,
    path: tokenPath,
    runSecurity: keychain.runSecurity,
  };
  try {
    const legacy = bindQuickBooksConnection({
      candidate: {
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        expires_at: Date.now() + 60_000,
        provider_metadata: { realm_id: "company-one" },
      },
      source: "quickbooks",
      environment: "sandbox",
    });
    saveTokens(
      { connection: legacy },
      providerCredentialOptions("quickbooks", fileStorage),
    );
    check("QuickBooks file and Keychain custody share one backend-independent mutation lock",
      providerRefreshLockPath("quickbooks", fileStorage) ===
      providerRefreshLockPath("quickbooks", keychainStorage));

    const legacyStatus = providerCredentialStatus("quickbooks", keychainStorage);
    check("QuickBooks readiness reports a valid legacy file as connected and migration-pending without mutating it",
      legacyStatus.connected === true && legacyStatus.readable === true &&
      legacyStatus.migration_pending === true && existsSync(tokenPath) &&
      !keychain.calls.some((args) => args[0] === "add-generic-password"));

    const inspected = loadProviderCredentials("quickbooks", keychainStorage);
    check("an unlocked QuickBooks inspection cannot migrate a legacy credential file",
      inspected === null && existsSync(tokenPath) &&
      !keychain.calls.some((args) => args[0] === "add-generic-password"));

    const lockPath = providerRefreshLockPath("quickbooks", fileStorage);
    const ownerToken = "1".repeat(32);
    const ownerPath = join(lockPath, `owner-${ownerToken}.json`);
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(ownerPath, JSON.stringify({
      schema_version: 1,
      token: ownerToken,
      pid: process.pid,
      created_at: new Date().toISOString(),
    }), { mode: 0o600 });
    const stale = new Date(Date.now() - 180_000);
    utimesSync(ownerPath, stale, stale);
    let lockedNetworkCalls = 0;
    await assert.rejects(
      providerAccessToken("quickbooks", {
        storage: keychainStorage,
        quickBooksBinding: { source: "quickbooks", environment: "sandbox" },
        refreshLockWaitMs: 0,
        fetchImpl: async () => {
          lockedNetworkCalls++;
          throw new Error("must not run");
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_update_in_progress",
    );
    check("a stale timestamp cannot evict a live QuickBooks lock owner or start migration/network work",
      lockedNetworkCalls === 0 && existsSync(ownerPath) && existsSync(tokenPath) &&
      !keychain.calls.some((args) => args[0] === "add-generic-password"));
    unlinkSync(ownerPath);
    rmdirSync(lockPath);

    const migrated = await loadQuickBooksCredentials(keychainStorage);
    check("legacy-file to Keychain migration runs under the shared custody lock and preserves the company binding",
      migrated?.refresh_token === "legacy-refresh" && !existsSync(tokenPath) &&
      keychain.calls.some((args) => args[0] === "add-generic-password") &&
      assertQuickBooksSourceBinding(migrated, {
        source: "quickbooks",
        environment: "sandbox",
      }).qbo_company_fingerprint === quickBooksCompanyFingerprint("company-one"));

    saveTokens(
      { connection: legacy },
      providerCredentialOptions("quickbooks", fileStorage),
    );
    await loadQuickBooksCredentials(keychainStorage);
    check("a crash-left exact legacy duplicate is removed only after its Keychain value verifies",
      !existsSync(tokenPath));

    saveTokens(
      { connection: { ...legacy, refresh_token: "divergent-refresh" } },
      providerCredentialOptions("quickbooks", fileStorage),
    );
    await assert.rejects(
      loadQuickBooksCredentials(keychainStorage),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_store_conflict",
    );
    check("divergent file and Keychain QuickBooks custody fails closed without deleting either copy",
      existsSync(tokenPath) &&
      loadProviderCredentials("quickbooks", keychainStorage)?.refresh_token === "legacy-refresh" &&
      loadProviderCredentials("quickbooks", fileStorage)?.refresh_token === "divergent-refresh");
    let reverseConflictNetworkCalls = 0;
    await assert.rejects(
      providerAccessToken("quickbooks", {
        storage: { ...fileStorage, platform: "darwin", runSecurity: keychain.runSecurity },
        now: Date.now() + 120_000,
        quickBooksBinding: { source: "quickbooks", environment: "sandbox" },
        fetchImpl: async () => {
          reverseConflictNetworkCalls++;
          return json({ access_token: "must-not-run", refresh_token: "must-not-run" });
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_store_conflict",
    );
    check("selected file custody also refuses a divergent Keychain before any provider request",
      reverseConflictNetworkCalls === 0 && existsSync(tokenPath) &&
      loadProviderCredentials("quickbooks", keychainStorage)?.refresh_token === "legacy-refresh");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-unreadable-keychain-"));
  const tokenPath = join(folder, ".brain", "quickbooks-tokens.json");
  const unreadableKeychain = fakeKeychain({ failReads: true });
  const storage = {
    backend: "keychain",
    platform: "darwin",
    home: folder,
    path: tokenPath,
    runSecurity: unreadableKeychain.runSecurity,
  };
  try {
    const legacy = bindQuickBooksConnection({
      candidate: {
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        expires_at: 1,
        provider_metadata: { realm_id: "company-one" },
      },
      source: "quickbooks",
      environment: "sandbox",
    });
    saveTokens(
      { connection: legacy },
      providerCredentialOptions("quickbooks", { ...storage, backend: "file", platform: "linux" }),
    );
    let networkCalls = 0;
    await assert.rejects(
      providerAccessToken("quickbooks", {
        storage,
        now: 5_000,
        quickBooksBinding: { source: "quickbooks", environment: "sandbox" },
        fetchImpl: async () => {
          networkCalls++;
          return json({ access_token: "must-not-run", refresh_token: "must-not-run" });
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "credential_store_unavailable",
    );
    check("an unreadable QuickBooks Keychain never restores a legacy token over unknown custody",
      networkCalls === 0 && existsSync(tokenPath) &&
      !unreadableKeychain.calls.some((args) => args[0] === "add-generic-password"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-windows-migration-"));
  const tokenPath = join(folder, ".brain", "quickbooks-tokens.json");
  const dpapi = fakeDpapi();
  const acl = fakeWindowsAcl();
  const storage = {
    backend: "file",
    platform: "win32",
    home: folder,
    path: tokenPath,
    username: "fixture-user",
    environment: { SystemRoot: "C:\\Windows", USERNAME: "fixture-user" },
    runPowerShell: dpapi.runPowerShell,
    runAcl: acl.runAcl,
  };
  try {
    const connection = bindQuickBooksConnection({
      candidate: {
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        provider_metadata: { realm_id: "company-one" },
      },
      source: "quickbooks",
      environment: "sandbox",
    });
    mkdirSync(join(folder, ".brain"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, JSON.stringify({ connection }), { mode: 0o600 });

    const status = providerCredentialStatus("quickbooks", storage);
    const inspected = loadProviderCredentials("quickbooks", storage);
    check("QuickBooks Windows status and ordinary inspection leave legacy plaintext migration to the shared lock",
      status.connected === true && status.migration_pending === true &&
      inspected?.refresh_token === "legacy-refresh" && dpapi.calls.length === 0 &&
      acl.calls.length === 0 && readFileSync(tokenPath, "utf8").startsWith("{"));

    const migrated = await loadQuickBooksCredentials(storage);
    check("the locked QuickBooks loader performs and verifies one Windows DPAPI migration",
      migrated?.refresh_token === "legacy-refresh" &&
      dpapi.calls.filter((operation) => operation === "protect").length >= 1 &&
      dpapi.calls.filter((operation) => operation === "unprotect").length >= 1 &&
      acl.calls.length >= 1 && !readFileSync(tokenPath, "utf8").startsWith("{"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  let authorization = null;
  let tokenBody = "";
  await exchangeProviderAuthorizationCode("dropbox", {
    clientId: "public-client", clientSecret: "secret-that-must-not-be-sent",
    code: "code", verifier: "verifier",
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization || null;
      tokenBody = String(options.body);
      return json({ access_token: "access", refresh_token: "refresh", expires_in: 14_400 });
    },
  });
  check("Dropbox public-client exchange uses client ID and PKCE without a secret",
    authorization === null && tokenBody.includes("client_id=public-client") &&
    tokenBody.includes("code_verifier=verifier") && !tokenBody.includes("secret-that-must-not-be-sent"));
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-provider-disconnect-"));
  const disconnectStorage = testFileStorage(folder);
  try {
    saveProviderCredentials("dropbox", {
      client_id: "client", access_token: "access", refresh_token: "refresh", expires_at: 10_000,
    }, disconnectStorage);
    let revokeAuthorization = "";
    const result = await disconnectProvider("dropbox", {
      storage: disconnectStorage,
      fetchImpl: async (_url, options) => {
        revokeAuthorization = options.headers.Authorization;
        return new Response(null, { status: 200 });
      },
    });
    check("Dropbox disconnect revokes remotely before verified local removal",
      revokeAuthorization === "Bearer access" && result.remote_revoked === true &&
      loadProviderCredentials("dropbox", disconnectStorage) === null);

    saveProviderCredentials("slack", {
      client_id: "client", access_token: "access", refresh_token: "refresh", expires_at: 10_000,
    }, disconnectStorage);
    const slack = await disconnectProvider("slack", {
      storage: disconnectStorage,
      fetchImpl: async () => json({ ok: true, revoked: true }),
    });
    check("Slack disconnect names the installation removal gap after revoking its local access token",
      slack.remote_revoked === false && slack.remote_revocation_required === true &&
      slack.remote_revocation_note.includes("app installation") &&
      loadProviderCredentials("slack", disconnectStorage) === null);

    saveProviderCredentials("microsoft", {
      client_id: "client", access_token: "access", refresh_token: "refresh", expires_at: 10_000,
    }, disconnectStorage);
    const manual = await disconnectProvider("microsoft", { storage: disconnectStorage });
    check("providers without a dependable revoke API name the owner-portal revocation gap",
      manual.remote_revoked === false && manual.remote_revocation_required === true &&
      loadProviderCredentials("microsoft", disconnectStorage) === null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const url = new URL(buildProviderAuthorizationUrl("slack", {
    clientId: "public-client",
    state: "state-fixture",
    challenge: "challenge-fixture",
  }));
  check("Slack requests user scopes through the public-client PKCE flow",
    url.searchParams.get("user_scope")?.includes("channels:history") &&
    !url.searchParams.has("scope") &&
    url.searchParams.get("code_challenge_method") === "S256");
}

{
  let seenAuthorization = "";
  let seenBody = "";
  let hardExpiryRequested = false;
  const token = await exchangeProviderAuthorizationCode("quickbooks", {
    clientId: "client", clientSecret: "secret", code: "code", verifier: "verifier",
    redirectUri: "http://localhost:47812/", now: 1_000,
    fetchImpl: async (_url, options) => {
      seenAuthorization = options.headers.Authorization;
      seenBody = String(options.body);
      hardExpiryRequested = options.headers["x-include-refresh-token-hard-expires-in"] === "true";
      return json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        x_refresh_token_expires_in: 7200,
        x_refresh_token_hard_expires_in: 10_800,
      });
    },
  });
  check("QuickBooks token exchange uses Basic auth without claiming unsupported PKCE",
    seenAuthorization.startsWith("Basic ") && !seenBody.includes("code_verifier") &&
    seenBody.includes("redirect_uri=http%3A%2F%2Flocalhost%3A47812%2F") && hardExpiryRequested);
  check("QuickBooks access and refresh expiries are normalized to absolute timestamps",
    token.expires_at === 3_601_000 && token.refresh_expires_at === 7_201_000 &&
    token.refresh_hard_expires_at === 10_801_000);
  const authorization = new URL(buildProviderAuthorizationUrl("quickbooks", {
    clientId: "client",
    redirectUri: "http://localhost:47812/",
    state: "state-fixture",
  }));
  check("QuickBooks consent names the broad Accounting scope and preserves state without a false PKCE signal",
    authorization.searchParams.get("scope") === "com.intuit.quickbooks.accounting" &&
    authorization.searchParams.get("state") === "state-fixture" &&
    !authorization.searchParams.has("code_challenge") &&
    !authorization.searchParams.has("code_challenge_method"));
}

{
  const first = bindQuickBooksConnection({
    candidate: {
      access_token: "access-one",
      refresh_token: "refresh-one",
      provider_metadata: { realm_id: "company-one" },
    },
    source: "quickbooks",
    environment: "sandbox",
  });
  const companyOne = quickBooksCompanyFingerprint("company-one");
  const binding = assertQuickBooksSourceBinding(first, { source: "quickbooks", environment: "sandbox" });
  check("QuickBooks credentials bind the active source, environment, and canonical company fingerprint",
    binding.qbo_company_fingerprint === companyOne &&
    first.provider_metadata.qbo_company_fingerprint === companyOne &&
    first.quickbooks_binding.active_source === "quickbooks" &&
    first.quickbooks_binding.sources.quickbooks.qbo_company_fingerprint === companyOne);

  const prior = { ...first, sync_states: { quickbooks: { cursor: { page: "opaque" } } } };
  const reconnected = bindQuickBooksConnection({
    prior,
    candidate: {
      access_token: "access-two",
      refresh_token: "refresh-two",
      provider_metadata: { realm_id: "company-one" },
    },
    source: "quickbooks",
    environment: "sandbox",
  });
  check("same-company reconnect rotates credentials without resetting protected sync state",
    reconnected.refresh_token === "refresh-two" &&
    reconnected.sync_states.quickbooks.cursor.page === "opaque");

  assert.throws(
    () => bindQuickBooksConnection({
      prior: {
        ...reconnected,
        provider_metadata: {
          ...reconnected.provider_metadata,
          qbo_company_fingerprint: quickBooksCompanyFingerprint("company-two"),
        },
      },
      candidate: { provider_metadata: { realm_id: "company-one" } },
      source: "quickbooks",
      environment: "sandbox",
    }),
    (error) => error instanceof ProviderOAuthError && error.code === "source_binding_corrupt",
  );
  check("a corrupted stored company fingerprint fails closed before reconnect", true);

  const legacyCustomSource = {
    access_token: "legacy-access",
    refresh_token: "legacy-refresh",
    provider_metadata: { realm_id: "company-one" },
    sync_states: { books_alias: { cursor: { page: "legacy" } } },
  };
  assert.throws(
    () => bindQuickBooksConnection({
      prior: legacyCustomSource,
      candidate: { provider_metadata: { realm_id: "company-two" } },
      source: "books_alias",
      environment: "sandbox",
    }),
    (error) => error instanceof ProviderOAuthError && error.code === "unexpected_company",
  );
  check("a legacy custom source cannot be used as a wrong-company switch escape hatch", true);

  assert.throws(
    () => bindQuickBooksConnection({
      prior: reconnected,
      candidate: { provider_metadata: { realm_id: "company-two" } },
      source: "quickbooks",
      environment: "sandbox",
    }),
    (error) => error instanceof ProviderOAuthError && error.code === "unexpected_company",
  );
  check("an unexpected company switch cannot replace an existing source", true);

  const separate = bindQuickBooksConnection({
    prior: reconnected,
    candidate: {
      access_token: "access-company-two",
      refresh_token: "refresh-company-two",
      provider_metadata: { realm_id: "company-two" },
    },
    source: "quickbooks_company_two",
    environment: "sandbox",
  });
  check("a different company requires an explicit separate source and becomes that credential's active source",
    separate.quickbooks_binding.active_source === "quickbooks_company_two" &&
    separate.quickbooks_binding.sources.quickbooks.qbo_company_fingerprint === companyOne &&
    separate.quickbooks_binding.sources.quickbooks_company_two.qbo_company_fingerprint ===
      quickBooksCompanyFingerprint("company-two"));
  assert.throws(
    () => assertQuickBooksSourceBinding(separate, { source: "quickbooks", environment: "sandbox" }),
    (error) => error instanceof ProviderOAuthError && error.code === "source_binding_missing",
  );
  check("an inactive company's source cannot ingest through the active company's token", true);
}

{
  let contentType = "";
  let body = null;
  const token = await exchangeProviderAuthorizationCode("notion", {
    clientId: "client", clientSecret: "secret", code: "code",
    fetchImpl: async (_url, options) => {
      contentType = options.headers["Content-Type"];
      body = JSON.parse(options.body);
      return json({ access_token: "access", refresh_token: "refresh", workspace_id: "workspace-1" });
    },
  });
  check("Notion token exchange uses its JSON body contract",
    contentType === "application/json" && body.grant_type === "authorization_code");
  check("Notion workspace provenance is retained without retaining owner content",
    token.provider_metadata.workspace_id === "workspace-1");
}

{
  const token = await exchangeProviderAuthorizationCode("slack", {
    clientId: "client", clientSecret: "secret-that-must-not-be-sent", code: "code", verifier: "verifier",
    fetchImpl: async (_url, options) => {
      const body = String(options.body);
      check("Slack code exchange omits the client secret and sends its PKCE verifier",
        !body.includes("secret-that-must-not-be-sent") && body.includes("code_verifier=verifier"));
      return json({
        ok: true,
        team: { id: "T1" },
        authed_user: {
          id: "U1", access_token: "user-access", refresh_token: "user-refresh",
          expires_in: 43_200, scope: "channels:history", token_type: "user",
        },
      });
    },
  });
  check("Slack user token rotation fields are selected from authed_user",
    token.access_token === "user-access" && token.refresh_token === "user-refresh" &&
    token.provider_metadata.team_id === "T1");
}

const folder = mkdtempSync(join(tmpdir(), "brain-provider-oauth-"));
const storage = testFileStorage(folder);
try {
  saveProviderCredentials("slack", {
    client_id: "client", client_secret: "secret", access_token: "old-access",
    refresh_token: "single-use-refresh", expires_at: 1_000,
  }, storage);
  let refreshBody = "";
  const refreshed = await refreshProviderCredentials("slack", loadProviderCredentials("slack", storage), {
    storage, now: 5_000,
    fetchImpl: async (_url, options) => {
      refreshBody = String(options.body);
      return json({
        ok: true, access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 43_200,
      });
    },
  });
  check("Slack refresh submits the prior single-use token and persists its replacement",
    refreshBody.includes("refresh_token=single-use-refresh") &&
    !refreshBody.includes("client_secret") &&
    refreshed.refresh_token === "rotated-refresh" &&
    loadProviderCredentials("slack", storage).refresh_token === "rotated-refresh" &&
    !Object.hasOwn(refreshed, "refresh_expires_at") &&
    !Object.hasOwn(refreshed, "refresh_hard_expires_at"));

  const access = await providerAccessToken("slack", {
    storage, now: 6_000,
    fetchImpl: async () => { throw new Error("fresh token should not be refreshed"); },
  });
  check("a fresh stored token is returned without a network call",
    access.accessToken === "new-access" && access.refreshed === false);

  saveProviderSyncState("slack", "slack", { cursor: { channels: "opaque" }, completed_at: "2026-08-30T00:00:00.000Z" }, storage);
  check("opaque provider cursors share the protected atomic credential boundary",
    loadProviderSyncState("slack", "slack", storage).cursor.channels === "opaque" &&
    loadProviderCredentials("slack", storage).refresh_token === "rotated-refresh");

  clearProviderCredentials("slack", storage);
  check("disconnect clears the provider record and verifies absence",
    loadProviderCredentials("slack", storage) === null);
} finally {
  rmSync(folder, { recursive: true, force: true });
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-oauth-hardening-"));
  // This block deliberately crashes a child process and resumes from the same
  // credential file. Function-backed crypto doubles cannot cross that process
  // boundary, so Windows exercises the real current-user DPAPI and ACL path.
  const qboStorage = process.platform === "win32"
    ? { backend: "file", platform: "win32", home: folder }
    : testFileStorage(folder);
  try {
    const original = bindQuickBooksConnection({
      candidate: {
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        access_token: "old-access",
        refresh_token: "rotating-refresh",
        expires_at: 1_000,
        refresh_expires_at: 20_000,
        refresh_hard_expires_at: 30_000,
        provider_metadata: { realm_id: "company-one" },
      },
      source: "quickbooks",
      environment: "sandbox",
    });
    original.sync_states = { quickbooks: { cursor: { page: "opaque" } } };
    saveQuickBooksFixture(original, qboStorage);
    let wrongBindingNetworkCalls = 0;
    await assert.rejects(
      providerAccessToken("quickbooks", {
        connection: original,
        storage: qboStorage,
        now: 5_000,
        quickBooksBinding: { source: "different-source", environment: "sandbox" },
        fetchImpl: async () => {
          wrongBindingNetworkCalls++;
          return json({ access_token: "must-not-run", refresh_token: "must-not-run" });
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "source_binding_missing",
    );
    await assert.rejects(
      providerAccessToken("quickbooks", {
        connection: original,
        storage: qboStorage,
        now: 5_000,
        quickBooksBinding: { source: "quickbooks", environment: "production" },
        fetchImpl: async () => {
          wrongBindingNetworkCalls++;
          return json({ access_token: "must-not-run", refresh_token: "must-not-run" });
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "wrong_environment",
    );
    check("wrong QuickBooks source or environment refuses before refresh can mutate custody",
      wrongBindingNetworkCalls === 0 &&
      loadProviderCredentials("quickbooks", qboStorage).refresh_token === "rotating-refresh");
    check("QuickBooks lock identity is byte-identical for explicit and environment-selected file custody",
      providerRefreshLockPath("quickbooks", qboStorage) ===
      providerRefreshLockPath("quickbooks", {
        platform: qboStorage.platform,
        home: folder,
        env: { BRAIN_QUICKBOOKS_TOKEN_STORE: "file" },
      }));

    const heldRefreshLock = providerRefreshLockPath("quickbooks", qboStorage);
    mkdirSync(heldRefreshLock, { mode: 0o700 });
    let lockedNetworkCalls = 0;
    try {
      await assert.rejects(
        refreshProviderCredentials("quickbooks", original, {
          storage: qboStorage,
          now: 5_000,
          refreshLockWaitMs: 0,
          fetchImpl: async () => {
            lockedNetworkCalls++;
            return json({ access_token: "must-not-run", refresh_token: "must-not-run" });
          },
        }),
        (error) => error instanceof ProviderOAuthError && error.code === "credential_update_in_progress",
      );
    } finally {
      rmdirSync(heldRefreshLock);
    }
    check("a separate process credential lock prevents reuse of Intuit's rotating token",
      lockedNetworkCalls === 0);

    let releaseResponse;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    let refreshCalls = 0;
    let refreshRequest = null;
    const fetchImpl = async (_url, options) => {
      refreshCalls++;
      refreshRequest = options;
      await responseGate;
      return json({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        x_refresh_token_expires_in: 7200,
        x_refresh_token_hard_expires_in: 10_800,
      });
    };
    const loaded = loadProviderCredentials("quickbooks", qboStorage);
    const firstRefresh = refreshProviderCredentials("quickbooks", loaded, {
      storage: qboStorage,
      now: 5_000,
      fetchImpl,
    });
    const concurrentRefresh = refreshProviderCredentials("quickbooks", loaded, {
      storage: qboStorage,
      now: 5_000,
      fetchImpl,
    });
    releaseResponse();
    const [first, concurrent] = await Promise.all([firstRefresh, concurrentRefresh]);
    const durable = loadProviderCredentials("quickbooks", qboStorage);
    check("QuickBooks refresh serializes rotation and atomically preserves company and cursor bindings",
      refreshCalls === 1 && first.refresh_token === "rotated-refresh" &&
      concurrent.refresh_token === "rotated-refresh" && durable.refresh_token === "rotated-refresh" &&
      durable.provider_metadata.qbo_company_fingerprint === quickBooksCompanyFingerprint("company-one") &&
      durable.quickbooks_binding.active_source === "quickbooks" &&
      durable.sync_states.quickbooks.cursor.page === "opaque");
    check("QuickBooks refresh requests provider expiry evidence without leaking client credentials into the body",
      refreshRequest.headers["x-include-refresh-token-hard-expires-in"] === "true" &&
      refreshRequest.headers.Authorization.startsWith("Basic ") &&
      String(refreshRequest.body).includes("refresh_token=rotating-refresh") &&
      !String(refreshRequest.body).includes("fixture-secret"));

    let raceRefreshStarted;
    const raceStarted = new Promise((resolve) => { raceRefreshStarted = resolve; });
    let releaseRaceRefresh;
    const raceGate = new Promise((resolve) => { releaseRaceRefresh = resolve; });
    const raceRefresh = refreshProviderCredentials("quickbooks", durable, {
      storage: qboStorage,
      now: 5_100,
      fetchImpl: async () => {
        raceRefreshStarted();
        await raceGate;
        return json({
          access_token: "race-access",
          refresh_token: "race-rotated-refresh",
          expires_in: 3600,
        });
      },
    });
    await raceStarted;
    assert.throws(
      () => saveProviderCredentials("quickbooks", durable, qboStorage),
      (error) => error instanceof ProviderOAuthError &&
        error.code === "credential_mutation_requires_custody",
    );
    assert.throws(
      () => clearProviderCredentials("quickbooks", qboStorage),
      (error) => error instanceof ProviderOAuthError &&
        error.code === "credential_mutation_requires_custody",
    );
    check("public QuickBooks mutation exports cannot erase a live rotation fence",
      loadProviderCredentials("quickbooks", qboStorage).quickbooks_refresh_fence?.state ===
        "outcome_unknown");
    const raceCursor = saveProviderSyncState(
      "quickbooks",
      "quickbooks",
      { cursor: { page: "after-rotation" } },
      qboStorage,
    );
    releaseRaceRefresh();
    await Promise.all([raceRefresh, raceCursor]);
    const afterCursorRace = loadProviderCredentials("quickbooks", qboStorage);
    check("QuickBooks cursor writes wait for token rotation and preserve both durable updates",
      afterCursorRace.refresh_token === "race-rotated-refresh" &&
      afterCursorRace.sync_states.quickbooks.cursor.page === "after-rotation");

    const unknownExpiry = {
      ...durable,
      access_token: "unknown-expiry-access",
      refresh_token: "unknown-expiry-refresh",
      refresh_expires_at: null,
      refresh_hard_expires_at: null,
    };
    saveQuickBooksFixture(unknownExpiry, qboStorage);
    const refreshedWithoutExpiryEvidence = await refreshProviderCredentials("quickbooks", unknownExpiry, {
      storage: qboStorage,
      now: 5_500,
      fetchImpl: async () => json({
        access_token: "unknown-expiry-new-access",
        refresh_token: "unknown-expiry-new-refresh",
        expires_in: 3600,
      }),
    });
    check("unknown optional QuickBooks refresh-expiry evidence does not become a false expired grant",
      refreshedWithoutExpiryEvidence.refresh_token === "unknown-expiry-new-refresh");

    saveQuickBooksFixture(durable, qboStorage);

    await assert.rejects(
      refreshProviderCredentials("quickbooks", durable, {
        storage: qboStorage,
        now: 6_000,
        fetchImpl: async () => json({
          access_token: "wrong-access",
          refresh_token: "wrong-refresh",
          expires_in: 3600,
          realmId: "company-two",
        }),
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "wrong_realm",
    );
    check("a refresh response cannot change the bound QuickBooks company",
      loadProviderCredentials("quickbooks", qboStorage).refresh_token === "rotated-refresh");

    // A wrong-realm response leaves the durable pre-request fence in place.
    // This explicit same-company reconnect fixture is the only safe way to
    // resume before testing the remaining independent boundaries.
    saveQuickBooksFixture(durable, qboStorage);

    const expired = {
      ...loadProviderCredentials("quickbooks", qboStorage),
      refresh_expires_at: 5_999,
    };
    saveQuickBooksFixture(expired, qboStorage);
    let expiredNetworkCalls = 0;
    await assert.rejects(
      refreshProviderCredentials("quickbooks", expired, {
        storage: qboStorage,
        now: 6_000,
        fetchImpl: async () => { expiredNetworkCalls++; throw new Error("must not run"); },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "refresh_expired",
    );
    check("an expired QuickBooks refresh grant refuses before a network call", expiredNetworkCalls === 0);
    saveQuickBooksFixture(durable, qboStorage);

    let uncertainNetworkCalls = 0;
    await assert.rejects(
      refreshProviderCredentials("quickbooks", durable, {
        storage: qboStorage,
        now: 6_100,
        fetchImpl: async () => {
          uncertainNetworkCalls++;
          throw new TypeError("fixture connection dropped after request write");
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.uncertain === true,
    );
    const fenced = loadProviderCredentials("quickbooks", qboStorage);
    const fencedStatus = providerCredentialStatus("quickbooks", qboStorage);
    await assert.rejects(
      refreshProviderCredentials("quickbooks", fenced, {
        storage: qboStorage,
        now: 6_200,
        fetchImpl: async () => { uncertainNetworkCalls++; throw new Error("must not replay"); },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "refresh_outcome_unknown",
    );
    await assert.rejects(
      providerAccessToken("quickbooks", { storage: qboStorage, now: 6_200 }),
      (error) => error instanceof ProviderOAuthError && error.code === "refresh_outcome_unknown",
    );
    await assert.rejects(
      providerAccessToken("quickbooks", {
        connection: durable,
        storage: qboStorage,
        now: 6_200,
        quickBooksBinding: { source: "quickbooks", environment: "sandbox" },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "refresh_outcome_unknown",
    );
    check("a lost QuickBooks refresh response leaves a durable no-retry fence",
      uncertainNetworkCalls === 1 && fenced.quickbooks_refresh_fence?.state === "outcome_unknown");
    check("a caller-retained pre-fence QuickBooks object cannot bypass the durable custody fence",
      loadProviderCredentials("quickbooks", qboStorage).quickbooks_refresh_fence?.state === "outcome_unknown");
    check("QuickBooks readiness never reports a refresh-fenced credential as usable",
      fencedStatus.connected === false && fencedStatus.readable === true &&
      fencedStatus.code === "refresh_outcome_unknown");

    const reconnectedAfterFence = bindQuickBooksConnection({
      prior: fenced,
      sourceRegistry: loadQuickBooksSourceRegistry(qboStorage),
      candidate: {
        ...durable,
        access_token: "reconnected-access",
        refresh_token: "reconnected-refresh",
        provider_metadata: { realm_id: "company-one" },
      },
      source: "quickbooks",
      environment: "sandbox",
    });
    saveQuickBooksFixture(reconnectedAfterFence, qboStorage);
    check("an explicit same-company reconnect clears the unknown-refresh fence without changing source custody",
      !loadProviderCredentials("quickbooks", qboStorage).quickbooks_refresh_fence &&
      assertQuickBooksSourceBinding(loadProviderCredentials("quickbooks", qboStorage), {
        source: "quickbooks", environment: "sandbox",
      }).qbo_company_fingerprint === quickBooksCompanyFingerprint("company-one"));

    let bodyReads = 0;
    await assert.rejects(
      refreshProviderCredentials("quickbooks", reconnectedAfterFence, {
        storage: qboStorage,
        now: 6_300,
        tokenRequestTimeoutMs: 1_000,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            bodyReads++;
            await new Promise(() => {});
          },
        }),
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "timeout" && error.uncertain === true,
    );
    check("the QuickBooks token deadline includes a stalled response body and preserves the durable fence",
      bodyReads === 1 && loadProviderCredentials("quickbooks", qboStorage).quickbooks_refresh_fence?.state === "outcome_unknown");

    saveQuickBooksFixture(reconnectedAfterFence, qboStorage);

    const moduleUrl = new URL("../connectors/provider-oauth.mjs", import.meta.url).href;
    const crashScript = `
      import { loadProviderCredentials, refreshProviderCredentials } from ${JSON.stringify(moduleUrl)};
      const storage = ${JSON.stringify(qboStorage)};
      const connection = loadProviderCredentials("quickbooks", storage);
      await refreshProviderCredentials("quickbooks", connection, {
        storage,
        now: 6350,
        fetchImpl: async () => process.exit(91),
      });
    `;
    const crashed = spawn(process.execPath, ["--input-type=module", "--eval", crashScript], {
      stdio: "ignore",
    });
    const crashExit = await new Promise((resolve, reject) => {
      crashed.once("error", reject);
      crashed.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const crashedLockPath = providerRefreshLockPath("quickbooks", qboStorage);
    const crashedOwners = readdirSync(crashedLockPath).filter((name) => name.startsWith("owner-"));
    const stale = new Date(Date.now() - 180_000);
    utimesSync(join(crashedLockPath, crashedOwners[0]), stale, stale);
    let postCrashNetworkCalls = 0;
    await assert.rejects(
      refreshProviderCredentials("quickbooks", loadProviderCredentials("quickbooks", qboStorage), {
        storage: qboStorage,
        now: 6_360,
        refreshLockWaitMs: 0,
        fetchImpl: async () => {
          postCrashNetworkCalls++;
          return json({ access_token: "must-not-run", refresh_token: "must-not-run" });
        },
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "refresh_outcome_unknown",
    );
    check("an abrupt subprocess exit leaves a recoverable owner lock and a durable fence that prevents token replay",
      crashExit.code === 91 && crashedOwners.length === 1 && postCrashNetworkCalls === 0 &&
      !readdirSync(join(folder, ".brain")).some((name) => name.endsWith(".lock")));

    saveQuickBooksFixture(reconnectedAfterFence, qboStorage);

    let disconnectRaceStarted;
    const disconnectRaceStart = new Promise((resolve) => { disconnectRaceStarted = resolve; });
    let releaseDisconnectRace;
    const disconnectRaceGate = new Promise((resolve) => { releaseDisconnectRace = resolve; });
    const refreshBeforeDisconnect = refreshProviderCredentials("quickbooks", reconnectedAfterFence, {
      storage: qboStorage,
      now: 6_400,
      fetchImpl: async () => {
        disconnectRaceStarted();
        await disconnectRaceGate;
        return json({
          access_token: "disconnect-race-access",
          refresh_token: "disconnect-race-refresh",
          expires_in: 3600,
        });
      },
    });
    await disconnectRaceStart;
    let disconnectedRotatedToken = null;
    const disconnectAfterRefresh = disconnectProvider("quickbooks", {
      storage: qboStorage,
      fetchImpl: async (_url, options) => {
        disconnectedRotatedToken = JSON.parse(options.body).token;
        return new Response(null, { status: 200 });
      },
    });
    releaseDisconnectRace();
    await refreshBeforeDisconnect;
    await disconnectAfterRefresh;
    check("QuickBooks disconnect waits for rotation, revokes the replacement, and cannot be resurrected",
      disconnectedRotatedToken === "disconnect-race-refresh" &&
      loadProviderCredentials("quickbooks", qboStorage) === null);

    saveQuickBooksFixture(reconnectedAfterFence, qboStorage);

    await assert.rejects(
      disconnectProvider("quickbooks", {
        storage: qboStorage,
        fetchImpl: async () => json({ error: "invalid_token" }, 400),
      }),
    );
    check("failed QuickBooks remote revocation retains local custody for recovery",
      loadProviderCredentials("quickbooks", qboStorage)?.refresh_token === "reconnected-refresh");

    let revokeRequest = null;
    let revokeEndpoint = "";
    const disconnected = await disconnectProvider("quickbooks", {
      storage: qboStorage,
      fetchImpl: async (url, options) => {
        revokeEndpoint = String(url);
        revokeRequest = options;
        return new Response(null, { status: 200 });
      },
    });
    check("QuickBooks disconnect follows Intuit's revoke contract before verified local removal",
      revokeEndpoint === "https://developer.api.intuit.com/v2/oauth2/tokens/revoke" &&
      revokeRequest.headers.Authorization.startsWith("Basic ") &&
      revokeRequest.headers["Content-Type"] === "application/json" &&
      JSON.parse(revokeRequest.body).token === "reconnected-refresh" &&
      disconnected.remote_revoked === true &&
      loadProviderCredentials("quickbooks", qboStorage) === null);
    check("disconnect receipt states that imported documents remain pending a separate forget operation",
      disconnected.imported_documents_retained === true &&
      disconnected.forget_operation_required === true &&
      disconnected.source_company_binding_retained === true);
    const retainedRegistry = loadQuickBooksSourceRegistry(qboStorage);
    assert.throws(
      () => bindQuickBooksConnection({
        prior: null,
        sourceRegistry: retainedRegistry,
        candidate: { provider_metadata: { realm_id: "company-two" } },
        source: "quickbooks",
        environment: "sandbox",
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "unexpected_company",
    );
    const sameCompanyAfterDisconnect = bindQuickBooksConnection({
      prior: null,
      sourceRegistry: retainedRegistry,
      candidate: { provider_metadata: { realm_id: "company-one" } },
      source: "quickbooks",
      environment: "sandbox",
    });
    check("disconnect retains a non-secret source reservation and permits only the same company to reconnect",
      retainedRegistry.sources.quickbooks.qbo_company_fingerprint === quickBooksCompanyFingerprint("company-one") &&
      sameCompanyAfterDisconnect.quickbooks_binding.active_source === "quickbooks" &&
      !JSON.stringify(retainedRegistry).includes("rotated-refresh") &&
      !JSON.stringify(retainedRegistry).includes("company-one"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  const folder = mkdtempSync(join(tmpdir(), "brain-qbo-legacy-disconnect-"));
  const legacyStorage = testFileStorage(folder);
  try {
    const legacyConnection = {
      provider: "quickbooks",
      schema_version: 1,
      client_id: "legacy-client",
      client_secret: "legacy-secret",
      access_token: "legacy-access",
      refresh_token: "legacy-refresh",
      provider_metadata: { realm_id: "legacy-company" },
    };
    saveTokens(
      { connection: legacyConnection },
      providerCredentialOptions("quickbooks", legacyStorage),
    );
    const unboundStatus = providerCredentialStatus("quickbooks", legacyStorage);
    check("QuickBooks readiness never reports an upgrade-era unbound credential as usable",
      unboundStatus.connected === false && unboundStatus.readable === true &&
      unboundStatus.code === "source_binding_missing");
    let revokedToken = null;
    const result = await disconnectProvider("quickbooks", {
      storage: legacyStorage,
      source: "quickbooks",
      environment: "sandbox",
      fetchImpl: async (_url, options) => {
        revokedToken = JSON.parse(options.body).token;
        return new Response(null, { status: 200 });
      },
    });
    const registry = loadQuickBooksSourceRegistry(legacyStorage);
    assert.throws(
      () => bindQuickBooksConnection({
        candidate: { provider_metadata: { realm_id: "different-company" } },
        sourceRegistry: registry,
        source: "quickbooks",
        environment: "sandbox",
      }),
      (error) => error instanceof ProviderOAuthError && error.code === "unexpected_company",
    );
    check("upgrade-era QuickBooks disconnect binds the manifest company before revocation and token removal",
      result.remote_revoked === true && revokedToken === "legacy-refresh" &&
      loadProviderCredentials("quickbooks", legacyStorage) === null &&
      registry.sources.quickbooks.qbo_company_fingerprint === quickBooksCompanyFingerprint("legacy-company") &&
      !JSON.stringify(registry).includes("legacy-company") &&
      !JSON.stringify(registry).includes("legacy-refresh"));

    const bindingOnly = bindQuickBooksConnection({
      candidate: {
        client_id: "binding-client",
        access_token: "binding-access",
        refresh_token: "binding-refresh",
        provider_metadata: { realm_id: "binding-company" },
      },
      source: "alternate-books",
      environment: "sandbox",
    });
    saveTokens(
      { connection: bindingOnly },
      providerCredentialOptions("quickbooks", legacyStorage),
    );
    await disconnectProvider("quickbooks", {
      storage: legacyStorage,
      source: "alternate-books",
      environment: "sandbox",
      revokeRemote: false,
    });
    const bindingOnlyRegistry = loadQuickBooksSourceRegistry(legacyStorage);
    check("clearing a legacy binding-only envelope preserves its non-secret source reservation",
      bindingOnlyRegistry.sources["alternate-books"].qbo_company_fingerprint ===
        quickBooksCompanyFingerprint("binding-company") &&
      !JSON.stringify(bindingOnlyRegistry).includes("binding-company") &&
      !JSON.stringify(bindingOnlyRegistry).includes("binding-refresh"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  let endpoint = "";
  let revokeBody = "";
  const folder = mkdtempSync(join(tmpdir(), "brain-provider-hubspot-disconnect-"));
  const hubspotStorage = testFileStorage(folder);
  try {
    saveProviderCredentials("hubspot", {
      client_id: "client", client_secret: "secret", access_token: "access", refresh_token: "refresh",
    }, hubspotStorage);
    const result = await disconnectProvider("hubspot", {
      storage: hubspotStorage,
      fetchImpl: async (url, options) => {
        endpoint = url;
        revokeBody = String(options.body);
        return new Response(null, { status: 204 });
      },
    });
    check("HubSpot disconnect uses the versioned refresh-token revoke contract",
      endpoint.endsWith("/oauth/2026-03/token/revoke") &&
      revokeBody.includes("token_type_hint=refresh_token") &&
      result.remote_revoked === true &&
      loadProviderCredentials("hubspot", hubspotStorage) === null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  let error;
  try {
    await exchangeProviderAuthorizationCode("hubspot", {
      clientId: "client", clientSecret: "secret", code: "code",
      fetchImpl: async () => { throw Object.assign(new Error("fixture token should never surface"), { name: "AbortError" }); },
    });
  } catch (caught) { error = caught; }
  check("a lost token response is classified as uncertain and does not expose transport text",
    error instanceof ProviderOAuthError && error.uncertain === true && error.code === "timeout" &&
    !error.message.includes("fixture token"));
}

{
  const clean = providerOAuthChildEnvironment({
    HOME: "/owner", USER: "owner", PATH: "/unsafe", HUBSPOT_CLIENT_SECRET: "secret",
  }, { platform: "darwin", browser: true });
  check("provider helper children receive no inherited provider secret",
    clean.HOME === "/owner" && clean.PATH === "/usr/bin:/bin" && !("HUBSPOT_CLIENT_SECRET" in clean));
}

{
  const options = providerCredentialOptions("microsoft", storage);
  check("each provider has an isolated credential service, file, and backend selector",
    options.keychainService.includes("microsoft") && options.path.endsWith("microsoft-tokens.json") &&
    options.storeEnv === "BRAIN_MICROSOFT_TOKEN_STORE");
}

console.log(`\nprovider oauth: all ${ran} checks passed`);
