import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderOAuthError,
  buildProviderAuthorizationUrl,
  clearProviderCredentials,
  disconnectProvider,
  exchangeProviderAuthorizationCode,
  loadProviderCredentials,
  loadProviderSyncState,
  providerAccessToken,
  providerCredentialOptions,
  providerOAuthChildEnvironment,
  refreshProviderCredentials,
  saveProviderCredentials,
  saveProviderSyncState,
} from "../connectors/provider-oauth.mjs";

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
  const token = await exchangeProviderAuthorizationCode("quickbooks", {
    clientId: "client", clientSecret: "secret", code: "code", verifier: "verifier",
    redirectUri: "http://127.0.0.1:47812", now: 1_000,
    fetchImpl: async (_url, options) => {
      seenAuthorization = options.headers.Authorization;
      seenBody = String(options.body);
      return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    },
  });
  check("QuickBooks token exchange uses Basic client auth and PKCE",
    seenAuthorization.startsWith("Basic ") && seenBody.includes("code_verifier=verifier"));
  check("token expiry is normalized to an absolute timestamp", token.expires_at === 3_601_000);
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
    loadProviderCredentials("slack", storage).refresh_token === "rotated-refresh");

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
