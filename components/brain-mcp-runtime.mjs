/**
 * Secret-safe runtime credential resolution for brain-mcp.
 *
 * Standard installer registrations contain only the absolute manifest path.
 * The manifest selects the durable Keychain or protected-file backend, and the
 * shared admin-key modules perform the same validation used by `brain secrets`.
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  adminKeyPersistencePlan,
  readAdminKeyDurably,
} from "../operations/admin-key-persistence.mjs";
import { fetchBrainWithAdminKey } from "./brain-http.mjs";

const DURABLE_CREDENTIAL_ERROR =
  "the durable brain credential could not be read and verified. Run `brain secrets <manifest>` and restart the AI tool if this continues.";
const LEGACY_CREDENTIAL_ERROR =
  "no brain credential resolved. Reconnect this brain with `brain mcp-config <manifest>`.";

function durableCredential(manifestPath, options) {
  try {
    if (typeof manifestPath !== "string" || !manifestPath || !isAbsolute(manifestPath)) {
      throw new Error("invalid manifest locator");
    }
    const read = options.readFile ?? readFileSync;
    const manifest = JSON.parse(read(manifestPath, "utf8"));
    const platform = options.platform ?? process.platform;
    const durableOptions = {
      ...(options.durableOptions || {}),
      platform,
      environment: options.environment,
      username: options.durableOptions?.username ??
        options.environment?.USERNAME ?? options.environment?.USER,
    };
    const makePlan = options.adminKeyPersistencePlan ?? adminKeyPersistencePlan;
    const readDurable = options.readAdminKeyDurably ?? readAdminKeyDurably;
    const plan = makePlan(manifestPath, manifest, durableOptions);
    const value = readDurable(plan, durableOptions);
    if (!value) throw new Error("missing durable credential");
    return value;
  } catch {
    // Never relay parser, filesystem, PowerShell, Keychain, path, or secret
    // detail through MCP output. The installer has the actionable diagnostics.
    throw new Error(DURABLE_CREDENTIAL_ERROR);
  }
}

/**
 * Create one credential resolver for a long-lived MCP process.
 *
 * BRAIN_MANIFEST is authoritative whenever present. Legacy direct/config keys
 * are consulted only when no manifest locator exists, so a migrated config
 * cannot stay pinned to an old literal key.
 */
export function createBrainCredentialResolver(options = {}) {
  const environment = options.environment ?? process.env;
  const manifestPath = options.manifestPath ?? environment.BRAIN_MANIFEST ?? null;
  const legacyCredential = options.legacyCredential;
  const seen = new Set();
  let cached = null;

  const remember = (value) => {
    if (typeof value === "string" && value) seen.add(value);
    return value;
  };

  const get = ({ refresh = false } = {}) => {
    if (manifestPath) {
      if (refresh) cached = null;
      if (!cached) cached = remember(durableCredential(manifestPath, { ...options, environment }));
      return cached;
    }
    if (refresh) cached = null;
    if (cached) return cached;
    try {
      const value = legacyCredential?.();
      if (!value) throw new Error("missing legacy credential");
      cached = remember(value);
      return cached;
    } catch {
      throw new Error(LEGACY_CREDENTIAL_ERROR);
    }
  };

  return Object.freeze({
    durable: Boolean(manifestPath),
    get,
    clear() { cached = null; },
    redact(value) {
      let text = String(value ?? "");
      for (const secret of [...seen].sort((a, b) => b.length - a.length)) {
        text = text.replaceAll(secret, "<credential redacted>");
      }
      return text;
    },
  });
}

/** Send one authenticated request, refreshing durable desired state once. */
export async function fetchWithBrainCredential(fetchImpl, url, requestOptions, resolver) {
  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");
  if (!resolver?.get) throw new TypeError("a brain credential resolver is required");

  const attempt = () => {
    return fetchBrainWithAdminKey(fetchImpl, url, requestOptions, () => resolver.get());
  };

  let response = await attempt();
  if (resolver.durable && (response?.status === 401 || response?.status === 403)) {
    resolver.clear();
    response = await attempt();
  }
  return response;
}
