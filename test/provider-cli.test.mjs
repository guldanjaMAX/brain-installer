import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdConnectors,
  cmdConnectProvider,
  cmdDisconnectProvider,
} from "../brain.mjs";

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
  let authorizeOptions;
  const connected = await cmdConnectProvider("quickbooks", manifestPath, {}, {
    environment: { QUICKBOOKS_CLIENT_ID: "fixture-client", QUICKBOOKS_CLIENT_SECRET: "fixture-secret" },
    oauth: {
      PROVIDER_DEFAULT_PORT: 47812,
      providerOAuthConfig: () => ({ provider: "quickbooks", label: "QuickBooks Online", clientSecretRequired: true }),
      providerRedirectUri: (port) => `http://127.0.0.1:${port}`,
      loadProviderCredentials: () => null,
      authorizeProvider: async (_provider, options) => {
        authorizeOptions = options;
        return { provider_metadata: { realm_id: "fixture-company" } };
      },
      providerCredentialDescription: () => "the fixture store",
    },
  });
  check("provider connect passes credentials in memory and returns no credential value",
    authorizeOptions.clientId === "fixture-client" && authorizeOptions.clientSecret === "fixture-secret" &&
    connected.connected === true && JSON.stringify(connected).includes("fixture-secret") === false);
  check("provider connect uses the fixed loopback callback port by default", authorizeOptions.port === 47812);

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
    order.join(",") === "scheduler,oauth" && disconnected.remote_revoked === true);

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
