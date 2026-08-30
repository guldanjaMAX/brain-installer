const UPDATE_MANIFEST_URL = "https://financialbrain.ai/update/manifest.json";
const UPDATE_GUIDE_URL = "https://financialbrain.ai/update";
const CLAUDE_UPDATE_PROMPT =
  "Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain.";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 20 * 1024 * 1024;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function stableParts(version) {
  if (!STABLE_VERSION.test(String(version || ""))) return null;
  return String(version).split(".").map(Number);
}

export function compareStableVersions(left, right) {
  const a = stableParts(left);
  const b = stableParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function unavailable(installedVersion, checkedAt, code = "update_check_unavailable") {
  return {
    status: "unavailable",
    error: "unavailable",
    code,
    installed_version: stableParts(installedVersion) ? installedVersion : null,
    latest_version: null,
    checked_at: checkedAt,
    update_url: UPDATE_GUIDE_URL,
  };
}

function boundedStrings(value, { maxItems, maxLength }) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return null;
  const strings = value.map((item) => typeof item === "string" ? item.trim() : "");
  return strings.every((item) => item.length > 0 && item.length <= maxLength) ? strings : null;
}

function validatedLegacyStableManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema_version !== 1 || value.channel !== "stable") return null;
  const release = String(value.release || "");
  const changes = boundedStrings(value.changes, { maxItems: 12, maxLength: 400 });
  const connectors = boundedStrings(value.released_connectors, { maxItems: 20, maxLength: 160 });
  const installer = value.installer;
  const expectedAsset = `https://github.com/guldanjaMAX/brain-installer/releases/download/v${release}/brain-installer-${release}.tgz`;
  if (!stableParts(release) || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.published_at || ""))) return null;
  if (value.update_url !== UPDATE_GUIDE_URL || value.claude_prompt !== CLAUDE_UPDATE_PROMPT) return null;
  if (!changes || !connectors || !installer || typeof installer !== "object") return null;
  if (installer.url !== expectedAsset || !SHA256.test(String(installer.sha256 || ""))) return null;
  if (!Number.isSafeInteger(installer.bytes) || installer.bytes < 1 || installer.bytes > MAX_INSTALLER_BYTES) return null;
  if (value.proof?.automated_release_suite !== "passed" || value.proof?.live_client_acceptance !== "required") return null;
  return {
    release_state: "stable",
    release,
    published_at: value.published_at,
    changes,
    released_connectors: connectors,
    installer: { url: installer.url, sha256: installer.sha256, bytes: installer.bytes },
  };
}

function validatedV2Manifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 2) return null;
  if (!new Set(["held", "candidate", "stable"]).has(value.release_state) ||
      value.update_url !== UPDATE_GUIDE_URL || !value.proof || typeof value.proof !== "object") {
    return null;
  }
  if (value.release_state !== "stable") {
    const reason = typeof value.held_reason === "string" ? value.held_reason.trim() : "";
    if (value.available !== false || value.release !== null || value.published_at !== null ||
        value.installer !== null || !Array.isArray(value.changes) || value.changes.length !== 0 ||
        reason.length < 1 || reason.length > 400 ||
        value.proof.archive_release_gate !== "not_passed" ||
        value.proof.automated_release_suite !== "pending" ||
        value.proof.live_client_acceptance !== "required") {
      return null;
    }
    return {
      release_state: value.release_state,
      held_reason: reason,
    };
  }

  const release = String(value.release || "");
  const changes = boundedStrings(value.changes, { maxItems: 12, maxLength: 400 });
  const installer = value.installer;
  const expectedAsset = `https://github.com/guldanjaMAX/brain-installer/releases/download/v${release}/brain-installer-${release}.tgz`;
  if (value.available !== true || !stableParts(release) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value.published_at || "")) ||
      value.held_reason !== null || !changes || !installer || typeof installer !== "object" ||
      installer.url !== expectedAsset || !SHA256.test(String(installer.sha256 || "")) ||
      !Number.isSafeInteger(installer.bytes) || installer.bytes < 1 || installer.bytes > MAX_INSTALLER_BYTES ||
      value.proof.archive_release_gate !== "passed" ||
      value.proof.automated_release_suite !== "passed" ||
      value.proof.live_client_acceptance !== "required") {
    return null;
  }
  return {
    release_state: "stable",
    release,
    published_at: value.published_at,
    changes,
    installer: { url: installer.url, sha256: installer.sha256, bytes: installer.bytes },
  };
}

function validatedManifest(value) {
  if (value?.schema_version === 1) return validatedLegacyStableManifest(value);
  if (value?.schema_version === 2) return validatedV2Manifest(value);
  return null;
}

/**
 * Read the public release channel without sending any client identity.
 *
 * The feed is treated as untrusted input despite its first-party hostname:
 * redirects are refused, bytes and fields are bounded, links are exact, and a
 * malformed response becomes an explicit unavailable state rather than a
 * false "up to date" result.
 */
export async function readUpdateStatus({ installedVersion, fetchImpl = fetch, now = () => new Date() } = {}) {
  const checkedAt = now().toISOString();
  if (!stableParts(installedVersion)) {
    return unavailable(installedVersion, checkedAt, "installed_version_unavailable");
  }
  try {
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(5_000)
      : undefined;
    const response = await fetchImpl(UPDATE_MANIFEST_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return unavailable(installedVersion, checkedAt);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_MANIFEST_BYTES) {
      return unavailable(installedVersion, checkedAt);
    }
    const manifest = validatedManifest(JSON.parse(raw));
    if (!manifest) return unavailable(installedVersion, checkedAt);
    if (manifest.release_state !== "stable") {
      return {
        status: manifest.release_state === "held" ? "release_held" : "release_candidate",
        release_state: manifest.release_state,
        available: false,
        installed_version: installedVersion,
        latest_version: null,
        checked_at: checkedAt,
        update_url: UPDATE_GUIDE_URL,
        held_reason: manifest.held_reason,
      };
    }
    const comparison = compareStableVersions(installedVersion, manifest.release);
    return {
      status: comparison < 0 ? "update_available" : comparison > 0 ? "ahead" : "up_to_date",
      release_state: "stable",
      available: true,
      installed_version: installedVersion,
      latest_version: manifest.release,
      checked_at: checkedAt,
      published_at: manifest.published_at,
      update_url: UPDATE_GUIDE_URL,
      claude_prompt: CLAUDE_UPDATE_PROMPT,
      changes: manifest.changes,
      ...(manifest.released_connectors ? { released_connectors: manifest.released_connectors } : {}),
      installer: manifest.installer,
    };
  } catch {
    return unavailable(installedVersion, checkedAt);
  }
}

export const updateStatusContract = Object.freeze({
  manifest_url: UPDATE_MANIFEST_URL,
  update_url: UPDATE_GUIDE_URL,
  claude_prompt: CLAUDE_UPDATE_PROMPT,
  max_manifest_bytes: MAX_MANIFEST_BYTES,
});
