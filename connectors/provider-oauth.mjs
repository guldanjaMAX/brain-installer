/**
 * OAuth custody for non-Google provider connectors.
 *
 * Tokens stay on the owner's machine in the same hardened storage boundary as
 * Google, but each provider gets its own Keychain account, file, and backend
 * selector. Token endpoints are deliberately not retried: an authorization
 * code or rotating refresh token may have been consumed even when its response
 * was lost, so a blind retry can turn an uncertain exchange into a false
 * success claim.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  googleAuthChildEnvironment,
  loadTokens,
  openBrowser,
  pkce,
  saveTokens,
  tokenStorageDescription,
  tokenStorageStatus,
  verifyTokenStorageReadable,
} from "./google-auth.mjs";
import { providerJson, providerRequest } from "./provider-sync.mjs";
import {
  normalizeQuickBooksRealmId,
  quickBooksCompanyFingerprint,
} from "./quickbooks-online.mjs";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const clean = (value) => String(value ?? "").trim();
const safeDetail = (value, fallback = "the provider refused the request") => {
  const text = clean(value || fallback)
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9._~+/=-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ");
  return text.slice(0, 240) || fallback;
};

export const PROVIDER_OAUTH = Object.freeze({
  quickbooks: Object.freeze({
    label: "QuickBooks Online",
    authorizationUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scopes: Object.freeze(["com.intuit.quickbooks.accounting"]),
    clientAuth: "basic",
    clientSecretRequired: true,
    tokenBody: "form",
    // Intuit's current discovery metadata returns no supported challenge
    // method, and its official confidential-client samples use state plus Basic
    // client authentication. Do not claim an unenforced PKCE control.
    pkce: false,
    loopbackRedirectHost: "localhost",
    callbackMetadataRequired: Object.freeze(["realm_id"]),
  }),
  slack: Object.freeze({
    label: "Slack",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: Object.freeze([
      "channels:history", "channels:read", "groups:history", "groups:read",
      "im:history", "im:read", "mpim:history", "mpim:read", "users:read",
    ]),
    clientAuth: "body",
    clientSecretRequired: false,
    omitClientSecret: true,
    tokenBody: "form",
    pkce: true,
    userScopes: true,
  }),
  notion: Object.freeze({
    label: "Notion",
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: Object.freeze([]),
    clientAuth: "basic",
    clientSecretRequired: true,
    tokenBody: "json",
    pkce: false,
    authorizationParams: Object.freeze({ owner: "user" }),
  }),
  microsoft: Object.freeze({
    label: "Microsoft 365",
    authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: Object.freeze([
      "openid", "profile", "offline_access", "User.Read", "Mail.Read",
      "Files.Read", "Sites.Read.All",
    ]),
    clientAuth: "body",
    clientSecretRequired: false,
    omitClientSecret: true,
    tokenBody: "form",
    pkce: true,
  }),
  dropbox: Object.freeze({
    label: "Dropbox",
    authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: Object.freeze([]),
    clientAuth: "body",
    clientSecretRequired: false,
    omitClientSecret: true,
    tokenBody: "form",
    pkce: true,
    authorizationParams: Object.freeze({ token_access_type: "offline" }),
  }),
  hubspot: Object.freeze({
    label: "HubSpot",
    authorizationUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/2026-03/token",
    scopes: Object.freeze([
      "oauth", "crm.objects.contacts.read", "crm.objects.companies.read",
      "crm.objects.deals.read",
    ]),
    clientAuth: "body",
    clientSecretRequired: true,
    tokenBody: "form",
    pkce: false,
  }),
});

export const PROVIDER_DEFAULT_PORT = 47812;
export const PROVIDER_LOOPBACK_BIND_ADDRESS = "127.0.0.1";
const QUICKBOOKS_SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const QUICKBOOKS_ENVIRONMENTS = new Set(["sandbox", "production"]);
const QUICKBOOKS_SOURCE_REGISTRY_KEY = "quickbooks_source_bindings";

export class ProviderOAuthError extends Error {
  constructor(provider, phase, message, { status = null, code = null, uncertain = false } = {}) {
    super(`${PROVIDER_OAUTH[provider]?.label || provider}: ${message}`);
    this.name = "ProviderOAuthError";
    this.provider = provider;
    this.phase = phase;
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function providerOAuthConfig(provider) {
  const key = clean(provider).toLowerCase();
  const config = PROVIDER_OAUTH[key];
  if (!config) throw new TypeError(`unsupported OAuth provider ${key || "(empty)"}`);
  return { provider: key, ...config };
}

// This is an established callback contract for every existing non-QuickBooks
// provider. Keep it byte-compatible, including the lack of a trailing slash.
export const providerRedirectUri = (port = PROVIDER_DEFAULT_PORT) =>
  `http://127.0.0.1:${port}`;

/** Intuit's documented sandbox callback, while the server still binds IPv4 loopback. */
export function quickBooksSandboxRedirectUri(port = PROVIDER_DEFAULT_PORT, host = "localhost") {
  const callbackHost = clean(host).toLowerCase();
  if (!new Set(["localhost", "127.0.0.1"]).has(callbackHost)) {
    throw new TypeError("QuickBooks callback host must be localhost or 127.0.0.1");
  }
  const callbackPort = Number(port);
  if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
    throw new TypeError("provider callback port must be an integer from 1024 through 65535");
  }
  return `http://${callbackHost}:${callbackPort}/`;
}

function normalizedQuickBooksSources(value) {
  const sources = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const normalized = {};
  for (const [source, raw] of Object.entries(sources)) {
    const sourceName = clean(source).toLowerCase();
    const fingerprint = clean(raw?.qbo_company_fingerprint || raw?.realm_fingerprint).toLowerCase();
    const environment = clean(raw?.environment).toLowerCase();
    if (!QUICKBOOKS_SOURCE.test(sourceName) || !/^[a-f0-9]{64}$/.test(fingerprint) ||
        !QUICKBOOKS_ENVIRONMENTS.has(environment)) {
      throw new ProviderOAuthError("quickbooks", "binding", "the stored source-to-company registry is invalid", {
        code: "source_binding_corrupt",
      });
    }
    normalized[sourceName] = {
      qbo_company_fingerprint: fingerprint,
      environment,
    };
  }
  return normalized;
}

function quickBooksBindingSources(connection) {
  return normalizedQuickBooksSources(connection?.quickbooks_binding?.sources);
}

function mergeQuickBooksSources(left, right) {
  const merged = normalizedQuickBooksSources(left);
  for (const [source, binding] of Object.entries(normalizedQuickBooksSources(right))) {
    const prior = merged[source];
    if (prior && (prior.qbo_company_fingerprint !== binding.qbo_company_fingerprint ||
        prior.environment !== binding.environment)) {
      throw new ProviderOAuthError("quickbooks", "binding", "the protected source registries disagree", {
        code: "source_binding_corrupt",
      });
    }
    merged[source] = binding;
  }
  return merged;
}

function quickBooksConnectionFingerprint(connection) {
  const stored = clean(
    connection?.provider_metadata?.qbo_company_fingerprint ||
    connection?.provider_metadata?.realm_fingerprint,
  );
  const raw = clean(connection?.provider_metadata?.realm_id);
  if (stored && !/^[a-f0-9]{64}$/.test(stored)) {
    throw new ProviderOAuthError("quickbooks", "binding", "the stored company binding is invalid", {
      code: "source_binding_corrupt",
    });
  }
  let derived = null;
  try {
    derived = raw ? quickBooksCompanyFingerprint(normalizeQuickBooksRealmId(raw)) : null;
  } catch {
    throw new ProviderOAuthError("quickbooks", "binding", "the protected company identity is invalid", {
      code: "source_binding_corrupt",
    });
  }
  if (stored && derived && stored !== derived) {
    throw new ProviderOAuthError("quickbooks", "binding", "the stored company binding does not match its protected company identity", {
      code: "source_binding_corrupt",
    });
  }
  return derived || stored || null;
}

const sourceCompanyFingerprint = (binding) => clean(
  binding?.qbo_company_fingerprint || binding?.realm_fingerprint,
);

/**
 * Bind a newly authorized QuickBooks token pair to its company, environment,
 * and explicit manifest source before the protected credential is replaced.
 * A different company may use a new source name, but it can never silently
 * take over an already-bound source.
 */
export function bindQuickBooksConnection({
  prior = null,
  candidate,
  source = "quickbooks",
  environment = "sandbox",
  sourceRegistry = null,
} = {}) {
  const sourceName = clean(source).toLowerCase();
  const selectedEnvironment = clean(environment).toLowerCase();
  if (!QUICKBOOKS_SOURCE.test(sourceName)) {
    throw new ProviderOAuthError("quickbooks", "binding", "the configured QuickBooks source name is invalid", {
      code: "invalid_source",
    });
  }
  if (!QUICKBOOKS_ENVIRONMENTS.has(selectedEnvironment)) {
    throw new ProviderOAuthError("quickbooks", "binding", "the QuickBooks environment is not selected", {
      code: "environment_required",
    });
  }
  let realmId;
  try {
    realmId = normalizeQuickBooksRealmId(candidate?.provider_metadata?.realm_id);
  } catch {
    throw new ProviderOAuthError("quickbooks", "binding", "the provider did not return a valid company identity", {
      code: "missing_realm_id",
    });
  }
  const companyFingerprint = quickBooksCompanyFingerprint(realmId);
  const sources = mergeQuickBooksSources(
    sourceRegistry?.sources || sourceRegistry,
    quickBooksBindingSources(prior),
  );
  const priorCompanyFingerprint = prior ? quickBooksConnectionFingerprint(prior) : null;

  // A legacy credential predating source bindings cannot prove which manifest
  // alias selected it. Bind that prior company to the source being reconnected
  // so an alias cannot become a silent company-switch escape hatch.
  if (priorCompanyFingerprint && Object.keys(sources).length === 0) {
    sources[sourceName] = {
      qbo_company_fingerprint: priorCompanyFingerprint,
      environment: clean(prior?.quickbooks_binding?.environment || selectedEnvironment).toLowerCase(),
    };
  }
  const existing = sources[sourceName] || null;
  if (existing && sourceCompanyFingerprint(existing) !== companyFingerprint) {
    throw new ProviderOAuthError(
      "quickbooks",
      "binding",
      "the selected company does not match this QuickBooks source; keep the existing company or configure a different source name",
      { code: "unexpected_company" },
    );
  }
  if (existing && existing.environment !== selectedEnvironment) {
    throw new ProviderOAuthError(
      "quickbooks",
      "binding",
      "this QuickBooks source is already bound to a different environment; configure a different source name",
      { code: "unexpected_environment" },
    );
  }
  sources[sourceName] = {
    qbo_company_fingerprint: companyFingerprint,
    environment: selectedEnvironment,
  };
  return {
    ...candidate,
    sync_states: { ...(prior?.sync_states || {}), ...(candidate?.sync_states || {}) },
    provider_metadata: {
      ...(candidate?.provider_metadata || {}),
      realm_id: realmId,
      qbo_company_fingerprint: companyFingerprint,
    },
    quickbooks_binding: {
      schema_version: 1,
      active_source: sourceName,
      active_environment: selectedEnvironment,
      active_company_fingerprint: companyFingerprint,
      sources,
    },
  };
}

/** Refuse ingest when the active token cannot prove the configured source. */
export function assertQuickBooksSourceBinding(connection, {
  source = "quickbooks",
  environment = "sandbox",
} = {}) {
  const sourceName = clean(source).toLowerCase();
  const selectedEnvironment = clean(environment).toLowerCase();
  let realmId;
  try {
    realmId = normalizeQuickBooksRealmId(connection?.provider_metadata?.realm_id);
  } catch {
    throw new ProviderOAuthError(
      "quickbooks",
      "binding",
      "the local QuickBooks credential has no valid company identity; reconnect it before ingest",
      { code: "source_binding_missing" },
    );
  }
  const companyFingerprint = quickBooksCompanyFingerprint(realmId);
  const active = clean(
    connection?.quickbooks_binding?.active_company_fingerprint ||
    connection?.quickbooks_binding?.active_realm_fingerprint,
  );
  const sourceBinding = quickBooksBindingSources(connection)[sourceName];
  const activeSource = clean(connection?.quickbooks_binding?.active_source || sourceName).toLowerCase();
  const activeEnvironment = clean(
    connection?.quickbooks_binding?.active_environment || sourceBinding?.environment || selectedEnvironment,
  ).toLowerCase();
  if (active !== companyFingerprint || activeSource !== sourceName || !sourceBinding) {
    throw new ProviderOAuthError(
      "quickbooks",
      "binding",
      "this local QuickBooks connection is not bound to the configured source; reconnect it before ingest",
      { code: "source_binding_missing" },
    );
  }
  if (sourceCompanyFingerprint(sourceBinding) !== companyFingerprint) {
    throw new ProviderOAuthError(
      "quickbooks",
      "binding",
      "the active QuickBooks company does not match the configured source; reconnect the expected company",
      { code: "wrong_realm" },
    );
  }
  if (sourceBinding.environment !== selectedEnvironment || activeEnvironment !== selectedEnvironment) {
    throw new ProviderOAuthError(
      "quickbooks",
      "binding",
      "the active QuickBooks credential belongs to a different environment",
      { code: "wrong_environment" },
    );
  }
  return Object.freeze({
    source: sourceName,
    environment: selectedEnvironment,
    realm_id: realmId,
    qbo_company_fingerprint: companyFingerprint,
  });
}

export function providerCredentialOptions(provider, options = {}) {
  const { provider: key, label } = providerOAuthConfig(provider);
  const upper = key.replace(/-/g, "_").toUpperCase();
  return {
    keychainService: `brain-installer.${key}-oauth`,
    keychainAccount: `local-${key}-connection`,
    keychainComment: `${label} OAuth credentials for Brain Installer`,
    storeEnv: `BRAIN_${upper}_TOKEN_STORE`,
    path: join(options.home || homedir(), ".brain", `${key}-tokens.json`),
    ...options,
  };
}

function selectedProviderStorageBackend(options) {
  const requested = options.backend || options.env?.[options.storeEnv] ||
    process.env[options.storeEnv] || "auto";
  if (!["auto", "keychain", "file"].includes(requested)) {
    throw new Error(`${options.storeEnv} must be "keychain" or "file" (received "${requested}")`);
  }
  const platform = options.platform || process.platform;
  const backend = requested === "auto" ? (platform === "darwin" ? "keychain" : "file") : requested;
  if (backend === "keychain" && platform !== "darwin") {
    throw new Error(`macOS Keychain storage was requested on a non-macOS system; use ${options.storeEnv}=file`);
  }
  return { backend, platform };
}

function loadProviderCredentialStore(provider, options = {}, {
  allowQuickBooksMigration = false,
} = {}) {
  const key = providerOAuthConfig(provider).provider;
  // Loading a legacy file into Keychain is a credential mutation. QuickBooks
  // performs that migration only while holding its backend-independent custody
  // lock; ordinary inspection remains side-effect free.
  const guardedOptions = key === "quickbooks" && !allowQuickBooksMigration
    ? { ...options, migrateLegacy: false }
    : options;
  const credentialOptions = providerCredentialOptions(key, guardedOptions);
  if (key !== "quickbooks" || !allowQuickBooksMigration) {
    return loadTokens(credentialOptions);
  }
  const { backend, platform } = selectedProviderStorageBackend(credentialOptions);
  if (backend === "keychain") {
    let store;
    try {
      // First prove Keychain is readable without allowing the generic helper to
      // restore a possibly stale file over an unreadable newer token pair.
      store = loadTokens({ ...credentialOptions, migrateLegacy: false });
    } catch {
      throw new ProviderOAuthError(
        "quickbooks",
        "mutation",
        "the QuickBooks Keychain store could not be inspected; preserve local custody and resolve Keychain access before retrying",
        { code: "credential_store_unavailable" },
      );
    }
    const legacyPath = resolve(credentialOptions.path);
    if (Object.keys(store).length === 0 && existsSync(legacyPath)) {
      // Keychain is confirmed empty, so the verified legacy migration cannot
      // overwrite an unseen current credential.
      store = loadTokens({ ...credentialOptions, migrateLegacy: true });
    }
    // A crash after the Keychain commit but before legacy-file cleanup can
    // leave two copies of one rotating token. Reconcile an exact duplicate
    // under the shared lock, and fail closed on divergent custody.
    if (existsSync(legacyPath)) {
      const legacy = loadTokens({ ...credentialOptions, backend: "file", migrateLegacy: false });
      if (JSON.stringify(legacy) !== JSON.stringify(store)) {
        throw new ProviderOAuthError(
          "quickbooks",
          "mutation",
          "the Keychain and legacy QuickBooks credential file disagree; preserve both and resolve custody before reconnecting",
          { code: "credential_store_conflict" },
        );
      }
      // Rewriting the verified current value invokes the storage helper's
      // identity-checked removal of only that exact legacy duplicate.
      saveTokens(store, credentialOptions);
    }
    return store;
  }
  const store = loadTokens(credentialOptions);
  if (platform === "darwin") {
    let keychainStore;
    try {
      keychainStore = loadTokens({ ...credentialOptions, backend: "keychain", migrateLegacy: false });
    } catch {
      throw new ProviderOAuthError(
        "quickbooks",
        "mutation",
        "the alternate QuickBooks Keychain store could not be inspected; keep the current storage setting until custody can be verified",
        { code: "credential_store_unavailable" },
      );
    }
    if (Object.keys(keychainStore).length > 0) {
      // Even an exact duplicate would let two independently selected
      // backends later rotate the same single-use token. Refuse the backend
      // switch and leave both copies untouched for explicit recovery.
      throw new ProviderOAuthError(
        "quickbooks",
        "mutation",
        "QuickBooks Keychain custody already exists; keep using Keychain or explicitly resolve it before selecting the file store",
        { code: "credential_store_conflict" },
      );
    }
  }
  return store;
}

function providerConnectionFromStore(store) {
  const connection = store?.connection;
  return connection && typeof connection === "object" && !Array.isArray(connection)
    ? { ...connection }
    : null;
}

/**
 * Non-secret, protected tombstone that keeps a source bound after disconnect.
 * Imported documents remain, so clearing OAuth tokens must not make that source
 * reusable for another company.
 */
export function loadQuickBooksSourceRegistry(options = {}) {
  const store = loadProviderCredentialStore("quickbooks", options);
  return Object.freeze({
    schema_version: 1,
    sources: normalizedQuickBooksSources(store?.[QUICKBOOKS_SOURCE_REGISTRY_KEY]?.sources),
  });
}

export function loadProviderCredentials(provider, options = {}) {
  return providerConnectionFromStore(loadProviderCredentialStore(provider, options));
}

/**
 * Load QuickBooks custody, including a legacy-file-to-Keychain migration, only
 * while holding the same lock used by refresh, reconnect, cursor, and revoke.
 */
export async function loadQuickBooksCredentials(storage = {}, options = {}) {
  return withQuickBooksCredentialLock(
    "quickbooks",
    storage,
    () => providerConnectionFromStore(loadProviderCredentialStore(
      "quickbooks",
      storage,
      { allowQuickBooksMigration: true },
    )),
    options,
  );
}

function saveProviderCredentialsUnlocked(provider, connection, options = {}) {
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
    throw new TypeError("provider connection must be an object");
  }
  const key = providerOAuthConfig(provider).provider;
  const record = {
    ...connection,
    provider: key,
    schema_version: 1,
  };
  const storage = providerCredentialOptions(key, options);
  let payload = { connection: record };
  if (key === "quickbooks") {
    const existing = loadQuickBooksSourceRegistry(options);
    const sources = mergeQuickBooksSources(existing.sources, quickBooksBindingSources(record));
    payload = {
      connection: record,
      [QUICKBOOKS_SOURCE_REGISTRY_KEY]: { schema_version: 1, sources },
    };
  }
  saveTokens(payload, storage);
  const verified = loadProviderCredentials(key, options);
  if (!verified || JSON.stringify(verified) !== JSON.stringify(record)) {
    throw new Error(`${PROVIDER_OAUTH[key].label} credential replacement did not read back exactly`);
  }
  return verified;
}

export function saveProviderCredentials(provider, connection, options = {}) {
  const key = providerOAuthConfig(provider).provider;
  if (key === "quickbooks") {
    throw new ProviderOAuthError(
      "quickbooks",
      "mutation",
      "direct QuickBooks credential replacement is not available; use the source-bound authorization or refresh flow",
      { code: "credential_mutation_requires_custody" },
    );
  }
  return saveProviderCredentialsUnlocked(key, connection, options);
}

function clearProviderCredentialsUnlocked(provider, options = {}) {
  const { provider: key } = providerOAuthConfig(provider);
  let retained = {};
  if (key === "quickbooks") {
    const store = loadProviderCredentialStore(key, options);
    const connection = store?.connection && typeof store.connection === "object" && !Array.isArray(store.connection)
      ? store.connection
      : null;
    const existing = normalizedQuickBooksSources(store?.[QUICKBOOKS_SOURCE_REGISTRY_KEY]?.sources);
    const bound = quickBooksBindingSources(connection);
    if (connection?.provider_metadata?.realm_id && Object.keys(bound).length === 0) {
      throw new ProviderOAuthError(
        "quickbooks",
        "disconnect",
        "the retained QuickBooks company must be bound to its manifest source before credentials can be removed",
        { code: "source_binding_required" },
      );
    }
    retained = {
      [QUICKBOOKS_SOURCE_REGISTRY_KEY]: {
        schema_version: 1,
        sources: mergeQuickBooksSources(existing, bound),
      },
    };
  }
  saveTokens(retained, providerCredentialOptions(key, options));
  if (loadProviderCredentials(key, options) !== null) {
    throw new Error(`${PROVIDER_OAUTH[key].label} credentials were not removed from the local store`);
  }
  return true;
}

export function clearProviderCredentials(provider, options = {}) {
  const key = providerOAuthConfig(provider).provider;
  if (key === "quickbooks") {
    throw new ProviderOAuthError(
      "quickbooks",
      "mutation",
      "direct QuickBooks credential removal is not available; use the source-bound disconnect flow",
      { code: "credential_mutation_requires_custody" },
    );
  }
  return clearProviderCredentialsUnlocked(key, options);
}

/**
 * Disconnect local custody and revoke remotely where the provider exposes a
 * dependable token revocation endpoint. Providers without one return an
 * explicit owner-portal requirement instead of claiming the grant is gone.
 */
async function disconnectProviderUnlocked(provider, {
  fetchImpl = fetch,
  storage = {},
  revokeRemote = true,
  source = null,
  environment = null,
} = {}, { assertOwned = null } = {}) {
  const config = providerOAuthConfig(provider);
  let connection = config.provider === "quickbooks"
    ? providerConnectionFromStore(loadProviderCredentialStore(
        config.provider,
        storage,
        { allowQuickBooksMigration: true },
      ))
    : loadProviderCredentials(config.provider, storage);
  if (!connection) {
    const result = {
      disconnected: true,
      already_disconnected: true,
      remote_revoked: false,
      remote_revocation_required: false,
    };
    return config.provider === "quickbooks"
      ? {
          ...result,
          imported_documents_retained: true,
          forget_operation_required: true,
          source_company_binding_retained: true,
        }
      : result;
  }
  if (config.provider === "quickbooks") {
    const activeSource = clean(source || connection.quickbooks_binding?.active_source).toLowerCase();
    const activeEnvironment = clean(environment || connection.quickbooks_binding?.active_environment).toLowerCase();
    if (!activeSource || !activeEnvironment) {
      throw new ProviderOAuthError(
        "quickbooks",
        "disconnect",
        "the manifest source and environment are required to preserve the company reservation before disconnect",
        { code: "source_binding_required" },
      );
    }
    if (Object.keys(quickBooksBindingSources(connection)).length > 0) {
      assertQuickBooksSourceBinding(connection, {
        source: activeSource,
        environment: activeEnvironment,
      });
    }
    connection = bindQuickBooksConnection({
      prior: connection,
      candidate: connection,
      source: activeSource,
      environment: activeEnvironment,
      sourceRegistry: (() => {
        const store = loadProviderCredentialStore(config.provider, storage, { allowQuickBooksMigration: true });
        return store?.[QUICKBOOKS_SOURCE_REGISTRY_KEY] || null;
      })(),
    });
    assertOwned?.();
    connection = saveProviderCredentialsUnlocked(config.provider, connection, storage);
  }
  let remoteRevoked = false;
  let remoteRevocationRequired = false;
  let remoteRevocationNote = null;
  if (revokeRemote) {
    if (config.provider === "dropbox") {
      await providerRequest("dropbox", "https://api.dropboxapi.com/2/auth/token/revoke", {
        accessToken: connection.access_token, fetchImpl, method: "POST", maxAttempts: 1,
      });
      remoteRevoked = true;
    } else if (config.provider === "quickbooks") {
      const credential = Buffer.from(`${connection.client_id}:${connection.client_secret || ""}`, "utf8").toString("base64");
      await providerRequest("quickbooks", "https://developer.api.intuit.com/v2/oauth2/tokens/revoke", {
        fetchImpl,
        method: "POST",
        headers: {
          Authorization: `Basic ${credential}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: connection.refresh_token || connection.access_token }),
        maxAttempts: 1,
      });
      remoteRevoked = true;
    } else if (config.provider === "slack") {
      const { data } = await providerJson("slack", "https://slack.com/api/auth.revoke", {
        accessToken: connection.access_token, fetchImpl, method: "POST", maxAttempts: 1,
      });
      if (!data?.ok || data?.revoked !== true) {
        throw new ProviderOAuthError("slack", "disconnect", "Slack did not confirm token revocation", {
          code: safeDetail(data?.error, "revoke_failed").slice(0, 80),
        });
      }
      // auth.revoke invalidates this access token but does not remove a
      // token-rotation installation. Name the remaining workspace action.
      remoteRevocationRequired = true;
      remoteRevocationNote = "the current access token was revoked, but Slack keeps the app installation; remove the app in Slack to revoke the installation";
    } else if (config.provider === "hubspot") {
      const body = new URLSearchParams({
        client_id: connection.client_id,
        client_secret: connection.client_secret,
        token: connection.refresh_token || connection.access_token,
        token_type_hint: connection.refresh_token ? "refresh_token" : "access_token",
      }).toString();
      await providerRequest("hubspot", "https://api.hubapi.com/oauth/2026-03/token/revoke", {
        fetchImpl,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        maxAttempts: 1,
      });
      remoteRevoked = true;
    } else {
      remoteRevocationRequired = true;
    }
  } else {
    remoteRevocationRequired = true;
  }
  assertOwned?.();
  clearProviderCredentialsUnlocked(config.provider, storage);
  const result = {
    disconnected: true,
    already_disconnected: false,
    remote_revoked: remoteRevoked,
    remote_revocation_required: remoteRevocationRequired,
    remote_revocation_note: remoteRevocationNote,
  };
  return config.provider === "quickbooks"
    ? {
        ...result,
        imported_documents_retained: true,
        forget_operation_required: true,
        source_company_binding_retained: true,
      }
    : result;
}

export async function disconnectProvider(provider, options = {}) {
  const config = providerOAuthConfig(provider);
  if (config.provider !== "quickbooks") {
    return disconnectProviderUnlocked(config.provider, options);
  }
  const storage = options.storage || {};
  return withQuickBooksCredentialLock(
    config.provider,
    storage,
    (lock) => disconnectProviderUnlocked(config.provider, options, lock),
    options,
  );
}

export function loadProviderSyncState(provider, source, options = {}) {
  const connection = loadProviderCredentials(provider, options);
  const state = connection?.sync_states?.[clean(source)];
  return state && typeof state === "object" && !Array.isArray(state) ? structuredClone(state) : {};
}

export function saveProviderSyncState(provider, source, state, options = {}) {
  const config = providerOAuthConfig(provider);
  const sourceName = clean(source);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceName)) throw new TypeError("provider state needs a safe source name");
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("provider sync state must be an object");
  const save = ({ assertOwned = null } = {}) => {
    const connection = config.provider === "quickbooks"
      ? providerConnectionFromStore(loadProviderCredentialStore(
          config.provider,
          options,
          { allowQuickBooksMigration: true },
        ))
      : loadProviderCredentials(config.provider, options);
    if (!connection) throw new ProviderOAuthError(config.provider, "state", "this provider is not connected", { code: "not_connected" });
    if (config.provider === "quickbooks" && connection.quickbooks_refresh_fence) {
      throw new ProviderOAuthError("quickbooks", "state", "the last token refresh outcome is unknown; reconnect before saving more source state", {
        code: "refresh_outcome_unknown",
      });
    }
    const next = {
      ...connection,
      sync_states: { ...(connection.sync_states || {}), [sourceName]: structuredClone(state) },
    };
    assertOwned?.();
    const saved = saveProviderCredentialsUnlocked(config.provider, next, options);
    const verified = saved.sync_states?.[sourceName];
    if (JSON.stringify(verified) !== JSON.stringify(state)) {
      throw new Error(`${config.label} cursor replacement did not read back exactly`);
    }
    return structuredClone(verified);
  };
  if (config.provider === "quickbooks") {
    return withQuickBooksCredentialLock(
      config.provider,
      options,
      ({ assertOwned }) => save({ assertOwned }),
      options,
    );
  }
  return save();
}

export function providerCredentialStatus(provider, options = {}) {
  const config = providerOAuthConfig(provider);
  const storage = providerCredentialOptions(config.provider, options);
  const envelope = tokenStorageStatus(storage);
  if (!envelope.exists) return { connected: false, readable: false, storage: envelope };
  if (config.provider === "quickbooks") {
    const { backend, platform } = selectedProviderStorageBackend(storage);
    const legacyPending = backend === "keychain" && envelope.backend === "legacy-file";
    const activeStorage = legacyPending
      ? { ...storage, backend: "file", migrateLegacy: false }
      : { ...storage, migrateLegacy: false };
    const readable = verifyTokenStorageReadable(activeStorage);
    if (!readable.readable) {
      return { connected: false, readable: false, storage: envelope, reason: readable.reason };
    }
    let activeStore;
    try {
      activeStore = loadTokens(activeStorage);
      if (backend === "keychain" && !legacyPending && existsSync(resolve(storage.path))) {
        const legacy = loadTokens({ ...storage, backend: "file", migrateLegacy: false });
        if (JSON.stringify(legacy) !== JSON.stringify(activeStore)) {
          return {
            connected: false,
            readable: true,
            storage: envelope,
            reason: "the QuickBooks Keychain and legacy credential file disagree; resolve custody before ingest",
          };
        }
      }
      if (backend === "file" && platform === "darwin") {
        const keychainStore = loadTokens({ ...storage, backend: "keychain", migrateLegacy: false });
        if (Object.keys(keychainStore).length > 0) {
          return {
            connected: false,
            readable: true,
            storage: envelope,
            reason: "QuickBooks Keychain custody already exists; keep the current backend until custody is resolved",
          };
        }
      }
    } catch {
      return {
        connected: false,
        readable: false,
        storage: envelope,
        reason: "the alternate QuickBooks credential store could not be inspected safely",
      };
    }
    const connection = providerConnectionFromStore(activeStore);
    if (connection?.quickbooks_refresh_fence) {
      return {
        connected: false,
        readable: true,
        storage: envelope,
        code: "refresh_outcome_unknown",
        reason: "the last QuickBooks refresh outcome is unknown; reconnect before using this connection",
      };
    }
    if (connection) {
      try {
        assertQuickBooksSourceBinding(connection, {
          source: connection.quickbooks_binding?.active_source,
          environment: connection.quickbooks_binding?.active_environment,
        });
      } catch (error) {
        return {
          connected: false,
          readable: true,
          storage: envelope,
          code: error?.code || "source_binding_missing",
          reason: "the stored QuickBooks connection needs a verified company and source binding; reconnect before ingest",
        };
      }
    }
    return {
      connected: Boolean(connection),
      readable: true,
      storage: envelope,
      migration_pending: Boolean(envelope.migrationPending) || legacyPending ||
        (backend === "keychain" && existsSync(resolve(storage.path))),
    };
  }
  const readable = verifyTokenStorageReadable(storage);
  if (!readable.readable) return { connected: false, readable: false, storage: envelope, reason: readable.reason };
  let connected = false;
  try { connected = Boolean(loadProviderCredentials(config.provider, options)); } catch { connected = false; }
  return { connected, readable: true, storage: envelope };
}

export const providerCredentialDescription = (provider, options = {}) =>
  tokenStorageDescription(providerCredentialOptions(provider, options));

export function buildProviderAuthorizationUrl(provider, {
  clientId,
  redirectUri = providerRedirectUri(),
  state,
  challenge = null,
  scopes = null,
} = {}) {
  const config = providerOAuthConfig(provider);
  if (!clean(clientId)) throw new TypeError("clientId is required");
  if (!clean(state)) throw new TypeError("state is required");
  if (config.pkce && !clean(challenge)) throw new TypeError(`${config.label} authorization requires a PKCE challenge`);
  const requested = Array.isArray(scopes) ? scopes : config.scopes;
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (requested.length) {
    url.searchParams.set(config.userScopes ? "user_scope" : "scope", requested.join(" "));
  }
  if (config.pkce) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [name, value] of Object.entries(config.authorizationParams || {})) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function basicAuth(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret || ""}`, "utf8").toString("base64")}`;
}

function tokenRequest(config, fields, { clientId, clientSecret }) {
  const values = { ...fields };
  const headers = { Accept: "application/json" };
  if (config.provider === "quickbooks") {
    headers["x-include-refresh-token-hard-expires-in"] = "true";
  }
  if (config.clientAuth === "basic") headers.Authorization = basicAuth(clientId, clientSecret);
  else {
    values.client_id = clientId;
    if (clientSecret && !config.omitClientSecret) values.client_secret = clientSecret;
  }
  if (config.tokenBody === "json") {
    headers["Content-Type"] = "application/json";
    return { headers, body: JSON.stringify(values) };
  }
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  return { headers, body: new URLSearchParams(values) };
}

function tokenPayload(config, data) {
  if (config.provider === "slack") {
    if (data?.ok === false) return { error: data.error || "oauth_failed" };
    const user = data?.authed_user || {};
    return {
      access_token: user.access_token || data.access_token,
      refresh_token: user.refresh_token || data.refresh_token,
      expires_in: user.expires_in || data.expires_in,
      scope: user.scope || data.scope,
      token_type: user.token_type || data.token_type,
      team_id: data?.team?.id || null,
      authed_user_id: user.id || null,
    };
  }
  return data || {};
}

async function exchangeToken(provider, fields, credentials, {
  fetchImpl = fetch,
  phase,
  now = Date.now(),
  tokenRequestTimeoutMs = 30_000,
} = {}) {
  const config = providerOAuthConfig(provider);
  const request = tokenRequest(config, fields, credentials);
  let response;
  let data = {};
  try {
    if (config.provider === "quickbooks") {
      const controller = new AbortController();
      const timeout = Math.max(1_000, Math.min(60_000, Number(tokenRequestTimeoutMs) || 30_000));
      let timer;
      const aborted = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error("QuickBooks token request timed out");
          error.name = "AbortError";
          reject(error);
        }, timeout);
        timer.unref?.();
      });
      try {
        ({ response, data } = await Promise.race([
          Promise.resolve(fetchImpl(config.tokenUrl, { method: "POST", ...request, signal: controller.signal }))
            .then(async (received) => {
              let parsed;
              try {
                parsed = await received.json();
              } catch (error) {
                throw Object.assign(new Error("QuickBooks token response could not be read"), {
                  name: "TokenResponseError",
                  cause: error,
                });
              }
              return { response: received, data: parsed };
            }),
          aborted,
        ]));
      } finally {
        clearTimeout(timer);
      }
    } else {
      // Preserve every released non-QBO request byte and timing behavior.
      response = await fetchImpl(config.tokenUrl, { method: "POST", ...request });
      try { data = await response.json(); } catch { /* classified below without response text */ }
    }
  } catch (error) {
    throw new ProviderOAuthError(config.provider, phase, "the token response was not received; reconnect before assuming access is valid", {
      code: error?.name === "AbortError"
        ? "timeout"
        : error?.name === "TokenResponseError" ? "invalid_response" : "transport_error",
      uncertain: true,
    });
  }
  const payload = tokenPayload(config, data);
  if (!response.ok || payload.error || !clean(payload.access_token)) {
    throw new ProviderOAuthError(config.provider, phase, safeDetail(
      payload.error_description || payload.error || data?.message,
      `token exchange failed with HTTP ${response.status}`,
    ), {
      status: response.status,
      code: clean(payload.error || data?.code || `http_${response.status}`).slice(0, 80),
    });
  }
  const seconds = Number(payload.expires_in);
  const refreshSeconds = Number(
    payload.x_refresh_token_expires_in ?? payload.refresh_token_expires_in,
  );
  const refreshHardSeconds = Number(
    payload.x_refresh_token_hard_expires_in ?? payload.refresh_token_hard_expires_in,
  );
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null,
    ...(config.provider === "quickbooks"
      ? {
          refresh_expires_at: Number.isFinite(refreshSeconds) && refreshSeconds > 0
            ? now + refreshSeconds * 1000
            : null,
          refresh_hard_expires_at: Number.isFinite(refreshHardSeconds) && refreshHardSeconds > 0
            ? now + refreshHardSeconds * 1000
            : null,
        }
      : {}),
    scope: clean(payload.scope) || null,
    token_type: clean(payload.token_type) || "Bearer",
    provider_metadata: Object.fromEntries(Object.entries({
      realm_id: data.realmId || data.realm_id || null,
      team_id: payload.team_id || null,
      authed_user_id: payload.authed_user_id || null,
      workspace_id: data.workspace_id || null,
      workspace_name: data.workspace_name || null,
      account_id: data.account_id || null,
      hub_id: data.hub_id || null,
    }).filter(([, value]) => value !== null && value !== undefined && value !== "")),
  };
}

export async function exchangeProviderAuthorizationCode(provider, {
  clientId,
  clientSecret = null,
  code,
  verifier = null,
  redirectUri = providerRedirectUri(),
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const config = providerOAuthConfig(provider);
  if (!clean(code)) throw new TypeError("authorization code is required");
  if (config.pkce && !clean(verifier)) throw new TypeError(`${config.label} token exchange requires a PKCE verifier`);
  const token = await exchangeToken(config.provider, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(config.pkce ? { code_verifier: verifier } : {}),
  }, { clientId, clientSecret }, { fetchImpl, phase: "authorization_code", now });
  if (!token.refresh_token) {
    throw new ProviderOAuthError(config.provider, "authorization_code",
      "no refresh token was returned, so unattended sync cannot be enabled", { code: "missing_refresh_token" });
  }
  return token;
}

export function providerRefreshLockPath(provider, storage = {}) {
  const options = providerCredentialOptions(provider, storage);
  const key = providerOAuthConfig(provider).provider;
  if (key !== "quickbooks") {
    // Preserve the released pure path calculation byte-for-byte for providers
    // that do not use the QBO custody lock.
    const identity = [
      provider,
      options.backend || "auto",
      options.path,
      options.keychainService,
      options.keychainAccount,
    ].join("\0");
    const fingerprint = createHash("sha256").update(identity).digest("hex").slice(0, 24);
    return join(dirname(options.path), `.provider-refresh-${fingerprint}.lock`);
  }
  const { backend, platform } = selectedProviderStorageBackend(options);
  let identity;
  let lockRoot;
  if (key === "quickbooks") {
    // A default macOS read may migrate the same legacy file into Keychain.
    // Both storage selections therefore share one lock rooted at that file's
    // canonical directory and keyed by both possible custody locators.
    const requestedPath = resolve(options.path);
    mkdirSync(dirname(requestedPath), { recursive: true, mode: 0o700 });
    assertPrivateQuickBooksDirectory(dirname(requestedPath), platform, options, "credential lock root");
    const canonicalPath = join(realpathSync(dirname(requestedPath)), basename(requestedPath));
    identity = [
      key,
      "file-or-keychain",
      canonicalPath,
      options.keychainService,
      options.keychainAccount,
    ].join("\0");
    lockRoot = dirname(canonicalPath);
  } else if (backend === "keychain") {
    identity = [provider, "keychain", options.keychainService, options.keychainAccount].join("\0");
    const requestedRoot = join(homedir(), ".brain");
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    assertPrivateQuickBooksDirectory(requestedRoot, platform, options, "credential lock root");
    lockRoot = realpathSync(requestedRoot);
  } else {
    const requestedPath = resolve(options.path);
    mkdirSync(dirname(requestedPath), { recursive: true, mode: 0o700 });
    assertPrivateQuickBooksDirectory(dirname(requestedPath), platform, options, "credential lock root");
    const canonicalPath = join(realpathSync(dirname(requestedPath)), basename(requestedPath));
    identity = [provider, "file", canonicalPath].join("\0");
    lockRoot = dirname(canonicalPath);
  }
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const fingerprint = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return join(lockRoot, `.provider-refresh-${fingerprint}.lock`);
}

const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const QUICKBOOKS_LOCK_OWNER = /^owner-([a-f0-9]{32})\.json$/;

const quickBooksLockOwnerName = (token) => `owner-${token}.json`;

function readQuickBooksLockOwner(lockPath) {
  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (entries.length === 0) return null;
  const owners = entries.filter((entry) => entry.name.match(QUICKBOOKS_LOCK_OWNER));
  if (entries.length !== 1 || owners.length !== 1 || !owners[0].isFile()) {
    throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock contains unexpected files", {
      code: "credential_lock_unsafe",
    });
  }
  const tokenFromName = owners[0].name.match(QUICKBOOKS_LOCK_OWNER)[1];
  const ownerPath = join(lockPath, owners[0].name);
  let state;
  try {
    state = lstatSync(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!state.isFile() || state.isSymbolicLink() || state.size > 1_024) {
    throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock owner is invalid", {
      code: "credential_lock_unsafe",
    });
  }
  if (state.nlink !== 1 || (process.platform !== "win32" &&
      ((typeof process.getuid === "function" && state.uid !== process.getuid()) ||
       (state.mode & 0o077) !== 0))) {
    throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock owner is not private", {
      code: "credential_lock_unsafe",
    });
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(ownerPath, "utf8")); } catch {
    throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock owner is unreadable", {
      code: "credential_lock_unsafe",
    });
  }
  if (parsed?.token !== tokenFromName ||
      !Number.isSafeInteger(parsed?.pid) || parsed.pid < 1) {
    throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock owner is malformed", {
      code: "credential_lock_unsafe",
    });
  }
  return { token: parsed.token, pid: parsed.pid, mtimeMs: state.mtimeMs, path: ownerPath };
}

function quickBooksLockOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM and unfamiliar platform responses cannot prove that the owner is
    // dead, so stale takeover fails closed.
    return true;
  }
}

function releaseQuickBooksLockOwner(lockPath, expectedToken) {
  const owner = readQuickBooksLockOwner(lockPath);
  if (!owner || owner.token !== expectedToken) return false;
  // The token is part of the filename. An old owner can therefore remove only
  // its own file, even if stale recovery has already created a successor lock.
  unlinkSync(join(lockPath, quickBooksLockOwnerName(expectedToken)));
  rmdirSync(lockPath);
  return true;
}

function removeStaleQuickBooksLockOwner(lockPath, expectedOwner) {
  if (!expectedOwner || quickBooksLockOwnerAlive(expectedOwner.pid)) return false;
  const current = readQuickBooksLockOwner(lockPath);
  if (!current ||
      current.token !== expectedOwner.token ||
      current.pid !== expectedOwner.pid ||
      current.mtimeMs !== expectedOwner.mtimeMs ||
      quickBooksLockOwnerAlive(current.pid)) {
    return false;
  }
  unlinkSync(current.path);
  rmdirSync(lockPath);
  return true;
}

function assertPrivateQuickBooksDirectory(path, platform, options = {}, label = "credential lock") {
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new ProviderOAuthError("quickbooks", "mutation", `the local ${label} must be a real directory`, {
      code: "credential_lock_unsafe",
    });
  }
  if (platform !== "win32" && process.platform !== "win32") {
    const getUid = options.getUid || process.getuid;
    const expectedUid = typeof getUid === "function" ? getUid() : null;
    if ((expectedUid !== null && state.uid !== expectedUid) || (state.mode & 0o077) !== 0) {
      throw new ProviderOAuthError("quickbooks", "mutation", `the local ${label} must be private to the current user`, {
        code: "credential_lock_unsafe",
      });
    }
  }
  return state;
}

/**
 * Every QBO credential mutation shares this owner-token lock. Refresh rotation,
 * cursor writes, reconnect finalization, and revoke-plus-clear therefore cannot
 * restore a consumed token or resurrect a disconnected credential. The owner
 * token prevents an older holder from deleting a successor's lock after stale
 * recovery, and task code verifies ownership immediately before durable writes.
 */
async function withQuickBooksCredentialLock(provider, storage, task, {
  refreshLockWaitMs = 45_000,
  refreshLockPollMs = 50,
  refreshLockStaleMs = 120_000,
} = {}) {
  const lockPath = providerRefreshLockPath(provider, storage);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(0, Number(refreshLockWaitMs) || 0);
  const staleAfter = Math.max(120_000, Number(refreshLockStaleMs) || 0);
  let ownerToken = null;
  while (!ownerToken) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      ownerToken = randomBytes(16).toString("hex");
      try {
        writeFileSync(join(lockPath, quickBooksLockOwnerName(ownerToken)), JSON.stringify({
          schema_version: 1,
          token: ownerToken,
          pid: process.pid,
          created_at: new Date().toISOString(),
        }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        try { rmdirSync(lockPath); } catch { /* preserve the original refusal */ }
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let state;
      try {
        state = lstatSync(lockPath);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock is not a safe directory", {
          code: "credential_lock_unsafe",
        });
      }
      assertPrivateQuickBooksDirectory(lockPath, storage.platform || process.platform, storage);
      const owner = readQuickBooksLockOwner(lockPath);
      const lastHeartbeat = owner?.mtimeMs ?? state.mtimeMs;
      if (Date.now() - lastHeartbeat > staleAfter) {
        try {
          if (owner) {
            if (!removeStaleQuickBooksLockOwner(lockPath, owner)) {
              // A live process may have paused across sleep or a long event-loop
              // stall. Its old timestamp is not permission to steal the lock.
            } else {
              continue;
            }
          }
          else rmdirSync(lockPath);
          if (!owner) continue;
        } catch (removeError) {
          if (removeError?.code === "ENOENT") continue;
          if (removeError?.code !== "ENOTEMPTY") throw removeError;
        }
      }
      if (Date.now() >= deadline) {
        throw new ProviderOAuthError("quickbooks", "mutation", "another local process is updating this connection; retry shortly", {
          code: "credential_update_in_progress",
        });
      }
      await waitFor(Math.max(10, Math.min(1_000, Number(refreshLockPollMs) || 50)));
    }
  }
  const assertOwned = () => {
    const owner = readQuickBooksLockOwner(lockPath);
    if (!owner || owner.token !== ownerToken) {
      throw new ProviderOAuthError("quickbooks", "mutation", "the local credential lock changed during the provider operation; reconnect before trusting the result", {
        code: "credential_lock_lost",
        uncertain: true,
      });
    }
    return true;
  };
  const heartbeat = setInterval(() => {
    try {
      assertOwned();
      const now = new Date();
      utimesSync(join(lockPath, quickBooksLockOwnerName(ownerToken)), now, now);
    } catch { /* the task's ownership check turns this into a stable refusal */ }
  }, Math.min(10_000, Math.max(1_000, Math.floor(staleAfter / 4))));
  heartbeat.unref?.();
  try {
    return await task({ assertOwned });
  } finally {
    clearInterval(heartbeat);
    try { releaseQuickBooksLockOwner(lockPath, ownerToken); } catch { /* a successor owns the path or recovery is explicit */ }
  }
}

async function refreshProviderCredentialsOnce(provider, connection, {
  fetchImpl = fetch,
  now = Date.now(),
  storage = {},
  tokenRequestTimeoutMs = 30_000,
  credentialLock = null,
  quickBooksBinding = null,
} = {}) {
  const config = providerOAuthConfig(provider);
  const quickbooks = config.provider === "quickbooks";
  if (!quickbooks && !clean(connection?.refresh_token)) {
    throw new ProviderOAuthError(config.provider, "refresh", "the local connection has no refresh token; reconnect it", {
      code: "missing_refresh_token",
    });
  }
  if (quickbooks) {
    const latestBefore = providerConnectionFromStore(loadProviderCredentialStore(
      config.provider,
      storage,
      { allowQuickBooksMigration: true },
    ));
    if (!latestBefore) {
      throw new ProviderOAuthError(config.provider, "refresh", "this provider was disconnected before refresh could start", {
        code: "not_connected",
      });
    }
    if (quickBooksBinding) assertQuickBooksSourceBinding(latestBefore, quickBooksBinding);
    if (latestBefore.quickbooks_refresh_fence) {
      throw new ProviderOAuthError(config.provider, "refresh", "the last refresh outcome is unknown; reconnect before trying again", {
        code: "refresh_outcome_unknown",
      });
    }
    if (latestBefore?.refresh_token && latestBefore.refresh_token !== connection.refresh_token) {
      return latestBefore;
    }
    connection = latestBefore;
    if (!clean(connection.refresh_token)) {
      throw new ProviderOAuthError(config.provider, "refresh", "the local connection has no refresh token; reconnect it", {
        code: "missing_refresh_token",
      });
    }
    const refreshExpiresAt = connection.refresh_expires_at == null
      ? null
      : Number(connection.refresh_expires_at);
    const refreshHardExpiresAt = connection.refresh_hard_expires_at == null
      ? null
      : Number(connection.refresh_hard_expires_at);
    if ((Number.isFinite(refreshExpiresAt) && refreshExpiresAt > 0 && refreshExpiresAt <= now) ||
        (Number.isFinite(refreshHardExpiresAt) && refreshHardExpiresAt > 0 && refreshHardExpiresAt <= now)) {
      throw new ProviderOAuthError(config.provider, "refresh", "the refresh grant has expired; reconnect it", {
        code: "refresh_expired",
      });
    }
    credentialLock?.assertOwned?.();
    const tokenFingerprint = createHash("sha256")
      .update(`quickbooks-refresh-v1:${connection.refresh_token}`)
      .digest("hex");
    connection = saveProviderCredentialsUnlocked(config.provider, {
      ...connection,
      // This fence is durable before Intuit can consume the rotating token.
      // A process crash, lost body, wrong-realm response, or failed final save
      // therefore requires reconnect instead of blindly replaying the request.
      quickbooks_refresh_fence: {
        state: "outcome_unknown",
        attempted_at: new Date(now).toISOString(),
        token_fingerprint: tokenFingerprint,
      },
    }, storage);
  }
  const token = await exchangeToken(config.provider, {
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
  }, { clientId: connection.client_id, clientSecret: connection.client_secret }, {
    fetchImpl, phase: "refresh", now, tokenRequestTimeoutMs,
  });
  const currentMetadata = connection.provider_metadata || {};
  const returnedMetadata = token.provider_metadata || {};
  if (config.provider === "quickbooks" && returnedMetadata.realm_id) {
    const before = quickBooksCompanyFingerprint(currentMetadata.realm_id);
    const after = quickBooksCompanyFingerprint(returnedMetadata.realm_id);
    if (before !== after) {
      throw new ProviderOAuthError("quickbooks", "refresh", "the refresh response changed the authorized company identity", {
        code: "wrong_realm",
      });
    }
  }
  const { quickbooks_refresh_fence: _priorRefreshFence, ...connectionWithoutFence } = connection;
  const replacement = quickbooks
    ? {
        ...connectionWithoutFence,
        ...token,
        refresh_token: token.refresh_token || connection.refresh_token,
        refresh_expires_at: token.refresh_expires_at || connection.refresh_expires_at || null,
        refresh_hard_expires_at: token.refresh_hard_expires_at || connection.refresh_hard_expires_at || null,
        provider_metadata: { ...currentMetadata, ...returnedMetadata },
        refreshed_at: new Date(now).toISOString(),
      }
    : {
        ...connection,
        ...token,
        refresh_token: token.refresh_token || connection.refresh_token,
        refreshed_at: new Date(now).toISOString(),
      };
  if (quickbooks) {
    if (!clean(token.refresh_token)) {
      throw new ProviderOAuthError("quickbooks", "refresh", "the refresh response did not contain a replacement refresh token; reconnect before trusting it", {
        code: "missing_rotated_refresh_token",
        uncertain: true,
      });
    }
    credentialLock?.assertOwned?.();
    const latestAfter = providerConnectionFromStore(loadProviderCredentialStore(
      config.provider,
      storage,
      { allowQuickBooksMigration: true },
    ));
    const expectedFence = connection.quickbooks_refresh_fence;
    if (!latestAfter || latestAfter.refresh_token !== connection.refresh_token ||
        latestAfter.quickbooks_refresh_fence?.state !== expectedFence?.state ||
        latestAfter.quickbooks_refresh_fence?.token_fingerprint !== expectedFence?.token_fingerprint) {
      throw new ProviderOAuthError("quickbooks", "refresh", "the local credential changed during token rotation; reconnect before trusting the result", {
        code: "credential_changed",
        uncertain: true,
      });
    }
  }
  return saveProviderCredentialsUnlocked(config.provider, replacement, storage);
}

/**
 * Serialize rotating refresh tokens inside one process and use a durable
 * compare-before-replace check to avoid overwriting a newer pair written by a
 * concurrent process.
 */
export async function refreshProviderCredentials(provider, connection, options = {}) {
  const config = providerOAuthConfig(provider);
  if (config.provider !== "quickbooks") {
    return refreshProviderCredentialsOnce(config.provider, connection, options);
  }
  const storage = options.storage || {};
  return withQuickBooksCredentialLock(
    config.provider,
    storage,
    ({ assertOwned }) => refreshProviderCredentialsOnce(config.provider, connection, {
      ...options,
      credentialLock: { assertOwned },
    }),
    options,
  );
}

export async function providerAccessToken(provider, {
  connection = null,
  fetchImpl = fetch,
  now = Date.now(),
  refreshSkewMs = 5 * 60 * 1000,
  storage = {},
  quickBooksBinding = null,
  tokenRequestTimeoutMs = 30_000,
  refreshLockWaitMs = 45_000,
  refreshLockPollMs = 50,
  refreshLockStaleMs = 120_000,
} = {}) {
  const config = providerOAuthConfig(provider);
  if (config.provider === "quickbooks") {
    return withQuickBooksCredentialLock(
      config.provider,
      storage,
      async ({ assertOwned }) => {
        // Never trust a caller-retained object for QBO. The durable record may
        // now carry a refresh fence, a replacement token, or a new binding.
        const current = providerConnectionFromStore(loadProviderCredentialStore(
          config.provider,
          storage,
          { allowQuickBooksMigration: true },
        ));
        if (!current) {
          throw new ProviderOAuthError(config.provider, "load", "this provider is not connected", {
            code: "not_connected",
          });
        }
        if (current.quickbooks_refresh_fence) {
          throw new ProviderOAuthError("quickbooks", "load", "the last refresh outcome is unknown; reconnect before using this connection", {
            code: "refresh_outcome_unknown",
          });
        }
        if (!quickBooksBinding || typeof quickBooksBinding !== "object") {
          throw new ProviderOAuthError("quickbooks", "binding", "the expected source and environment are required before using this connection", {
            code: "source_binding_required",
          });
        }
        assertQuickBooksSourceBinding(current, quickBooksBinding);
        const expiresAt = Number(current.expires_at);
        if (clean(current.access_token) && (!Number.isFinite(expiresAt) || expiresAt - now > refreshSkewMs)) {
          return { accessToken: current.access_token, connection: current, refreshed: false };
        }
        const refreshed = await refreshProviderCredentialsOnce(config.provider, current, {
          fetchImpl,
          now,
          storage,
          tokenRequestTimeoutMs,
          quickBooksBinding,
          credentialLock: { assertOwned },
        });
        assertQuickBooksSourceBinding(refreshed, quickBooksBinding);
        return { accessToken: refreshed.access_token, connection: refreshed, refreshed: true };
      },
      { refreshLockWaitMs, refreshLockPollMs, refreshLockStaleMs },
    );
  }
  const current = connection || loadProviderCredentials(config.provider, storage);
  if (!current) throw new ProviderOAuthError(provider, "load", "this provider is not connected", { code: "not_connected" });
  const expiresAt = Number(current.expires_at);
  if (clean(current.access_token) && (!Number.isFinite(expiresAt) || expiresAt - now > refreshSkewMs)) {
    return { accessToken: current.access_token, connection: current, refreshed: false };
  }
  const refreshed = await refreshProviderCredentials(config.provider, current, { fetchImpl, now, storage });
  return { accessToken: refreshed.access_token, connection: refreshed, refreshed: true };
}

const html = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#1a1a1a">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

function loopbackCode({ provider, url, state, port, redirectUri, timeoutMs, open, openImpl, log }) {
  const config = providerOAuthConfig(provider);
  const expectedHost = new URL(redirectUri).host;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      callback(value);
    };
    const server = createServer((request, response) => {
      if (String(request.headers.host || "").toLowerCase() !== expectedHost.toLowerCase()) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(html("Not connected", "The response did not match this local callback."));
        return;
      }
      const got = new URL(request.url, redirectUri);
      if (got.pathname !== "/") { response.writeHead(404).end(); return; }
      const error = got.searchParams.get("error");
      if (got.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(html("Not connected", "The response did not match this sign-in request."));
        finish(reject, new ProviderOAuthError(config.provider, "callback", "the authorization state did not match", { code: "state_mismatch" }));
        return;
      }
      if (error) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(html("Not connected", `${config.label} did not approve the connection.`));
        finish(reject, new ProviderOAuthError(config.provider, "callback", "the provider did not approve the connection", {
          code: safeDetail(error, "access_denied").slice(0, 80),
        }));
        return;
      }
      const code = got.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(html("Not connected", "No authorization code was returned."));
        finish(reject, new ProviderOAuthError(config.provider, "callback", "no authorization code was returned", { code: "missing_code" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(html("Connected", "You can close this tab and return to the terminal."));
      finish(resolve, {
        code,
        callback_metadata: Object.fromEntries(Object.entries({
          realm_id: got.searchParams.get("realmId") || null,
        }).filter(([, value]) => value)),
      });
    });
    server.on("error", (error) => finish(reject, new ProviderOAuthError(config.provider, "callback",
      error?.code === "EADDRINUSE" ? `local callback port ${port} is already in use` : "the local callback could not start",
      { code: error?.code || "callback_error" })));
    // The registered URL may use localhost, as Intuit documents for sandbox,
    // but the listener itself is always pinned to IPv4 loopback. No manifest
    // option can broaden it to a LAN or wildcard address.
    server.listen(port, PROVIDER_LOOPBACK_BIND_ADDRESS, () => {
      if (!open) return;
      const opened = openImpl(url);
      log(opened
        ? `A browser window should have opened. If it did not, open:\n\n  ${url}`
        : `Could not open a browser. Open this URL yourself:\n\n  ${url}`);
    });
    timer = setTimeout(() => finish(reject, new ProviderOAuthError(config.provider, "callback",
      "timed out waiting for sign-in", { code: "callback_timeout" })), timeoutMs);
    timer.unref?.();
  });
}

export async function authorizeProvider(provider, {
  clientId,
  clientSecret = null,
  scopes = null,
  port = PROVIDER_DEFAULT_PORT,
  redirectHost = null,
  redirectUri = null,
  timeoutMs = 300_000,
  open = true,
  fetchImpl = fetch,
  openImpl = (url) => openBrowser(url),
  log = console.log,
  now = Date.now(),
  storage = {},
  prepareConnection = null,
  refreshLockWaitMs = 45_000,
  refreshLockPollMs = 50,
  refreshLockStaleMs = 120_000,
} = {}) {
  const config = providerOAuthConfig(provider);
  if (config.provider === "quickbooks" && typeof prepareConnection !== "function") {
    throw new ProviderOAuthError("quickbooks", "binding", "QuickBooks authorization requires an explicit source and company binding", {
      code: "source_binding_required",
    });
  }
  const startingQuickBooksConnection = config.provider === "quickbooks"
    ? await loadQuickBooksCredentials(storage, {
        refreshLockWaitMs,
        refreshLockPollMs,
        refreshLockStaleMs,
      })
    : null;
  const startingQuickBooksGeneration = config.provider === "quickbooks"
    ? createHash("sha256").update(JSON.stringify(startingQuickBooksConnection)).digest("hex")
    : null;
  const state = b64url(randomBytes(16));
  const proof = config.pkce ? pkce() : { verifier: null, challenge: null };
  const callbackHost = redirectHost || config.loopbackRedirectHost || "127.0.0.1";
  const callbackUri = redirectUri || (config.provider === "quickbooks"
    ? quickBooksSandboxRedirectUri(port, callbackHost)
    : providerRedirectUri(port));
  const url = buildProviderAuthorizationUrl(config.provider, {
    clientId, redirectUri: callbackUri, state, challenge: proof.challenge, scopes,
  });
  const callback = await loopbackCode({
    provider: config.provider,
    url,
    state,
    port,
    redirectUri: callbackUri,
    timeoutMs,
    open,
    openImpl,
    log,
  });
  for (const field of config.callbackMetadataRequired || []) {
    if (!clean(callback.callback_metadata?.[field])) {
      throw new ProviderOAuthError(config.provider, "callback", `${field} was not returned, so the connection identity is incomplete`, {
        code: `missing_${field}`,
      });
    }
  }
  const token = await exchangeProviderAuthorizationCode(config.provider, {
    clientId, clientSecret, code: callback.code, verifier: proof.verifier, redirectUri: callbackUri, fetchImpl, now,
  });
  const candidate = {
    ...token,
    provider_metadata: { ...token.provider_metadata, ...callback.callback_metadata },
    client_id: clientId,
    client_secret: clientSecret || null,
    scopes: Array.isArray(scopes) ? scopes : config.scopes,
    connected_at: new Date(now).toISOString(),
  };
  if (config.provider !== "quickbooks") {
    const prepared = typeof prepareConnection === "function"
      ? await prepareConnection(candidate)
      : candidate;
    return saveProviderCredentialsUnlocked(config.provider, prepared, storage);
  }
  return withQuickBooksCredentialLock(
    config.provider,
    storage,
    async ({ assertOwned }) => {
      const prior = providerConnectionFromStore(loadProviderCredentialStore(
        config.provider,
        storage,
        { allowQuickBooksMigration: true },
      ));
      const currentGeneration = createHash("sha256")
        .update(JSON.stringify(prior))
        .digest("hex");
      if (currentGeneration !== startingQuickBooksGeneration) {
        throw new ProviderOAuthError(
          "quickbooks",
          "binding",
          "the local QuickBooks connection changed while authorization was open; keep the existing credential and start a fresh connection ceremony",
          { code: "credential_changed_during_authorization", uncertain: true },
        );
      }
      const prepared = await prepareConnection(candidate, {
        prior,
        sourceRegistry: (() => {
          const store = loadProviderCredentialStore(
            config.provider,
            storage,
            { allowQuickBooksMigration: true },
          );
          return {
            schema_version: 1,
            sources: normalizedQuickBooksSources(store?.[QUICKBOOKS_SOURCE_REGISTRY_KEY]?.sources),
          };
        })(),
      });
      assertOwned();
      return saveProviderCredentialsUnlocked(config.provider, prepared, storage);
    },
    { refreshLockWaitMs, refreshLockPollMs, refreshLockStaleMs },
  );
}

/** Environment allowlist for a future provider helper child. Exported for tests. */
export const providerOAuthChildEnvironment = (environment = process.env, options = {}) =>
  googleAuthChildEnvironment(environment, options);
