/**
 * Named automation profiles. A profile is one exact bundle, never an additive
 * bag of OAuth scopes. That keeps a client asking for several roles from
 * accidentally combining them into a fifth, more powerful role.
 *
 * Deletion execution is intentionally absent. Break-glass may prepare a
 * bounded receipt, but only a fresh owner passkey ceremony may consume it.
 */

export const AGENT_PROFILES = Object.freeze({
  librarian: Object.freeze({
    label: "Librarian",
    capabilities: Object.freeze(["corpus:read"]),
  }),
  "structured-contributor": Object.freeze({
    label: "Structured contributor",
    capabilities: Object.freeze(["corpus:read", "curated:write"]),
  }),
  technician: Object.freeze({
    label: "Technician",
    capabilities: Object.freeze(["corpus:read", "diagnostics:read"]),
  }),
  "break-glass": Object.freeze({
    label: "Break-glass",
    capabilities: Object.freeze(["corpus:read", "diagnostics:read", "corpus:delete:preview"]),
  }),
});

export const AGENT_PROFILE_NAMES = Object.freeze(Object.keys(AGENT_PROFILES));
export const DEFAULT_AGENT_PROFILE = "librarian";

export function normalizeAgentProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.hasOwn(AGENT_PROFILES, normalized) ? normalized : DEFAULT_AGENT_PROFILE;
}

/**
 * OAuth stores one profile token in its existing scope column. Unknown,
 * legacy, empty, or combined values all collapse to the read-only librarian.
 */
export function profileFromScope(scope) {
  const asked = String(scope || "").split(/[\s+]+/).filter(Boolean);
  const profiles = [...new Set(asked.filter((name) => Object.hasOwn(AGENT_PROFILES, name)))];
  return profiles.length === 1 && asked.length === 1 ? profiles[0] : DEFAULT_AGENT_PROFILE;
}

export function profileHas(profile, capability) {
  return AGENT_PROFILES[normalizeAgentProfile(profile)].capabilities.includes(String(capability));
}

export function profileDescription(profile) {
  const normalized = normalizeAgentProfile(profile);
  return {
    name: normalized,
    label: AGENT_PROFILES[normalized].label,
    capabilities: [...AGENT_PROFILES[normalized].capabilities],
  };
}
