import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
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
  providerAccessToken,
  providerCredentialOptions,
  providerRefreshLockPath,
  providerOAuthChildEnvironment,
  providerRedirectUri,
  quickBooksSandboxRedirectUri,
  refreshProviderCredentials,
  saveProviderCredentials,
  saveProviderSyncState,
} from "../connectors/provider-oauth.mjs";
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
  const callbackStorage = { backend: "file", platform: "linux", home: folder };
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
      prepareConnection: (candidate) => bindQuickBooksConnection({
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
  const disconnectStorage = { backend: "file", platform: "linux", home: folder };
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
const storage = { backend: "file", platform: "linux", home: folder };
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
  const qboStorage = { backend: "file", platform: "linux", home: folder };
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
    saveProviderCredentials("quickbooks", original, qboStorage);

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
        (error) => error instanceof ProviderOAuthError && error.code === "refresh_in_progress",
      );
    } finally {
      rmdirSync(heldRefreshLock);
    }
    check("a separate process refresh lock prevents reuse of Intuit's rotating token",
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

    const unknownExpiry = {
      ...durable,
      access_token: "unknown-expiry-access",
      refresh_token: "unknown-expiry-refresh",
      refresh_expires_at: null,
      refresh_hard_expires_at: null,
    };
    saveProviderCredentials("quickbooks", unknownExpiry, qboStorage);
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

    saveProviderCredentials("quickbooks", durable, qboStorage);

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

    const expired = {
      ...loadProviderCredentials("quickbooks", qboStorage),
      refresh_expires_at: 5_999,
    };
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

    await assert.rejects(
      disconnectProvider("quickbooks", {
        storage: qboStorage,
        fetchImpl: async () => json({ error: "invalid_token" }, 400),
      }),
    );
    check("failed QuickBooks remote revocation retains local custody for recovery",
      loadProviderCredentials("quickbooks", qboStorage)?.refresh_token === "rotated-refresh");

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
      JSON.parse(revokeRequest.body).token === "rotated-refresh" &&
      disconnected.remote_revoked === true &&
      loadProviderCredentials("quickbooks", qboStorage) === null);
    check("disconnect receipt states that imported documents remain pending a separate forget operation",
      disconnected.imported_documents_retained === true &&
      disconnected.forget_operation_required === true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

{
  let endpoint = "";
  let revokeBody = "";
  const folder = mkdtempSync(join(tmpdir(), "brain-provider-hubspot-disconnect-"));
  const hubspotStorage = { backend: "file", platform: "linux", home: folder };
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
