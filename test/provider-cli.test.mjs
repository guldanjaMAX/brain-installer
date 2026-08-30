import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdConnectors,
  cmdConnectProvider,
  cmdDisconnectProvider,
  cmdIngestProvider,
  providerConfigurationFingerprint,
} from "../brain.mjs";
import { quickBooksCompanyFingerprint } from "../connectors/quickbooks-online.mjs";

let ran = 0;
const check = (name, value, detail = "") => {
  ran++;
  assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const folder = mkdtempSync(join(tmpdir(), "brain-provider-cli-"));
const manifestPath = join(folder, "brain.manifest.json");
writeFileSync(manifestPath, JSON.stringify({
  manifest_version: 1,
  client: { slug: "fixture", display_name: "Fixture", timezone: "America/Phoenix" },
  brain: { version: "0.2.0", domain: "fixture.invalid", worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
  corpora: { quickbooks: { enabled: true, environment: "sandbox" } },
}));

const realLog = console.log;
const realWarn = console.warn;
console.log = () => {};
console.warn = () => {};
try {
  const priorSlackFingerprint = "ddbe158e2e3f497532e698cdbc780afe4d518bf49045283d07cb64f1b5289f5e";
  check("non-QuickBooks configuration fingerprints remain byte-compatible with released v1 cursors",
    providerConfigurationFingerprint("slack", "slack", {
      enabled: true,
      channel_ids: ["C1"],
      include_thread_replies: true,
    }) === priorSlackFingerprint);
  check("QuickBooks configuration fingerprints include the canonical company identity only for QBO",
    providerConfigurationFingerprint("quickbooks", "quickbooks", { enabled: true, environment: "sandbox" }, {
      qbo_company_fingerprint: quickBooksCompanyFingerprint("company-one"),
    }) !== providerConfigurationFingerprint("quickbooks", "quickbooks", { enabled: true, environment: "sandbox" }, {
      qbo_company_fingerprint: quickBooksCompanyFingerprint("company-two"),
    }));

  const ingestOrder = [];
  let adapterOptions = null;
  const ingestCompanyFingerprint = quickBooksCompanyFingerprint("fixture-company");
  const ingestPreview = await cmdIngestProvider({
    corpora: {
      quickbooks: { enabled: true, environment: "sandbox", source: "quickbooks" },
    },
  }, manifestPath, { from: "quickbooks", "dry-run": true }, {
    oauth: {
      providerAccessToken: async () => {
        ingestOrder.push("credential");
        return {
          accessToken: "fixture-access",
          connection: {
            provider_metadata: {
              realm_id: "fixture-company",
              qbo_company_fingerprint: ingestCompanyFingerprint,
            },
          },
        };
      },
      assertQuickBooksSourceBinding: () => {
        ingestOrder.push("binding");
        return { qbo_company_fingerprint: ingestCompanyFingerprint };
      },
      loadProviderSyncState: () => {
        ingestOrder.push("state");
        return {};
      },
      saveProviderSyncState: () => { throw new Error("dry run must not save provider state"); },
    },
    sync: async (options) => {
      ingestOrder.push("adapter");
      adapterOptions = options;
      return { documents: [], deletions: [], warnings: [] };
    },
  });
  check("QuickBooks ingest proves company binding before reading cursor state or calling the adapter",
    ingestOrder.join(",") === "credential,binding,state,adapter" && ingestPreview.dry_run === true);
  check("QuickBooks adapter receives the same canonical company fingerprint as its configuration receipt",
    adapterOptions.expectedCompanyFingerprint === ingestCompanyFingerprint &&
    adapterOptions.realmId === "fixture-company");

  let authorizeOptions;
  const connected = await cmdConnectProvider("quickbooks", manifestPath, {}, {
    environment: { QUICKBOOKS_CLIENT_ID: "fixture-client", QUICKBOOKS_CLIENT_SECRET: "fixture-secret" },
    oauth: {
      PROVIDER_DEFAULT_PORT: 47812,
      providerOAuthConfig: () => ({
        provider: "quickbooks", label: "QuickBooks Online", clientSecretRequired: true,
        loopbackRedirectHost: "localhost",
      }),
      providerRedirectUri: (port) => `http://127.0.0.1:${port}`,
      quickBooksSandboxRedirectUri: (port, host) => `http://${host}:${port}/`,
      loadProviderCredentials: () => null,
      authorizeProvider: async (_provider, options) => {
        authorizeOptions = options;
        return options.prepareConnection({ provider_metadata: { realm_id: "fixture-company" } });
      },
      bindQuickBooksConnection: ({ candidate, source, environment }) => ({
        ...candidate,
        provider_metadata: {
          ...candidate.provider_metadata,
          qbo_company_fingerprint: quickBooksCompanyFingerprint(candidate.provider_metadata.realm_id),
        },
        quickbooks_binding: { active_source: source, active_environment: environment },
      }),
      assertQuickBooksSourceBinding: (connection, { source, environment }) => ({
        source,
        environment,
        qbo_company_fingerprint: connection.provider_metadata.qbo_company_fingerprint,
      }),
      providerCredentialDescription: () => "the fixture store",
    },
  });
  check("provider connect passes credentials in memory and returns no credential value",
    authorizeOptions.clientId === "fixture-client" && authorizeOptions.clientSecret === "fixture-secret" &&
    connected.connected === true && JSON.stringify(connected).includes("fixture-secret") === false);
  check("provider connect uses the fixed loopback callback port by default", authorizeOptions.port === 47812);
  check("QuickBooks connect uses the provider-specific documented localhost callback",
    authorizeOptions.redirectHost === "localhost" &&
    authorizeOptions.redirectUri === "http://localhost:47812/");

  const order = [];
  const disconnected = await cmdDisconnectProvider("quickbooks", manifestPath, {}, {
    scheduler: {
      removeProviderScheduler: () => {
        order.push("scheduler");
        return { removed: true, loaded: true, stdoutPath: "/tmp/out", stderrPath: "/tmp/err" };
      },
    },
    oauth: {
      disconnectProvider: async () => {
        order.push("oauth");
        return { disconnected: true, remote_revoked: true, remote_revocation_required: false };
      },
      providerOAuthConfig: () => ({ label: "QuickBooks Online" }),
    },
    resolveAdminKey: () => null,
  });
  check("disconnect stops unattended refresh before revoking and clearing OAuth custody",
    order.join(",") === "scheduler,oauth" && disconnected.remote_revoked === true &&
    disconnected.imported_documents_retained === true && disconnected.forget_operation_required === true);

  const productionManifest = join(folder, "production.manifest.json");
  writeFileSync(productionManifest, JSON.stringify({
    ...JSON.parse(JSON.stringify({
      manifest_version: 1,
      client: { slug: "fixture", display_name: "Fixture", timezone: "America/Phoenix" },
      brain: { version: "0.2.0", domain: "fixture.invalid", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    })),
    corpora: { quickbooks: { enabled: true, environment: "production" } },
  }));
  let productionCredentialOrBrowserCalls = 0;
  await assert.rejects(
    cmdConnectProvider("quickbooks", productionManifest, {}, {
      oauth: {
        providerOAuthConfig: () => ({ provider: "quickbooks", label: "QuickBooks Online" }),
        loadProviderCredentials: () => { productionCredentialOrBrowserCalls++; return null; },
        authorizeProvider: () => { productionCredentialOrBrowserCalls++; },
      },
    }),
    (error) => error.code === "quickbooks_production_callback_unavailable",
  );
  check("QuickBooks production refuses before reading credentials or starting OAuth",
    productionCredentialOrBrowserCalls === 0);

  const invalidRedirectManifest = join(folder, "invalid-redirect.manifest.json");
  writeFileSync(invalidRedirectManifest, JSON.stringify({
    manifest_version: 1,
    client: { slug: "fixture", display_name: "Fixture", timezone: "America/Phoenix" },
    brain: { version: "0.2.0", domain: "fixture.invalid", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    corpora: {
      quickbooks: { enabled: true, environment: "sandbox", redirect_host: "0.0.0.0" },
    },
  }));
  let invalidRedirectCredentialCalls = 0;
  await assert.rejects(
    cmdConnectProvider("quickbooks", invalidRedirectManifest, {}, {
      oauth: {
        PROVIDER_DEFAULT_PORT: 47812,
        providerOAuthConfig: () => ({
          provider: "quickbooks", label: "QuickBooks Online", clientSecretRequired: true,
          loopbackRedirectHost: "localhost",
        }),
        quickBooksSandboxRedirectUri: () => "must-not-be-used",
        loadProviderCredentials: () => { invalidRedirectCredentialCalls++; return null; },
      },
    }),
    (error) => error.code === "quickbooks_redirect_host_invalid",
  );
  check("an unsafe QuickBooks callback host refuses before local credential access",
    invalidRedirectCredentialCalls === 0);

  const catalog = {
    connectorCatalog: () => [{ id: "quickbooks" }],
    renderConnectorCatalog: () => "fixture catalog",
  };
  const rehearsal = {
    runProviderRehearsal: async () => ({
      proof_level: "offline_invented_data", network_used: false, credentials_read: false,
      customer_data_read: false, passed: true, results: [], field_gate_still_required: true,
    }),
    renderProviderRehearsal: () => "fixture rehearsal",
  };
  const proof = await cmdConnectors({ rehearse: true }, { catalog, rehearsal });
  check("connector rehearsal keeps its explicit offline proof level and field gate",
    proof.rehearsal.proof_level === "offline_invented_data" && proof.rehearsal.field_gate_still_required === true);

  let blocked;
  try {
    await cmdConnectors({ rehearse: true }, {
      catalog,
      rehearsal: {
        ...rehearsal,
        runProviderRehearsal: async () => {
          try { await fetch("https://example.invalid"); } catch { /* the command's trap is the proof */ }
          return { ...(await rehearsal.runProviderRehearsal()), passed: true };
        },
      },
    });
  } catch (error) { blocked = error; }
  check("offline rehearsal fails closed if adapter code reaches global fetch",
    /offline connector rehearsals failed/.test(blocked?.message || ""));
} finally {
  console.log = realLog;
  console.warn = realWarn;
  rmSync(folder, { recursive: true, force: true });
}

console.log(`provider CLI: all ${ran} checks passed`);
