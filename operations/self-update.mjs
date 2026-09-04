/**
 * `brain update` fetches its own new version before it updates anything.
 *
 * Until now the command upgraded a brain to whatever installer happened to be
 * on the machine, and a whole step of the written guide existed to tell a
 * human to install the release first. On 2026-09-03 a client's update ran the
 * stranded version against itself because that step was missed, and the repair
 * cost two hours on a call. A step in a document that must never be skipped is
 * a step that belongs in the program.
 *
 * Everything here is pure except `fetchLatestRelease`, so the decisions can be
 * tested without a network, a registry, or a release.
 */

import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export const RELEASE_REPO = "guldanjaMAX/brain-installer";

/** Semver compare, -1 / 0 / 1. Throws on anything that is not x.y.z. */
export function compareRelease(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
    if (!m) throw new Error(`not a release version: ${JSON.stringify(v)}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The npm prefix the RUNNING cli was installed into, derived from its own
 * path rather than from npm's default. A client whose CLI lives outside the
 * default prefix — measured on a real Windows install 2026-09-03, where npm
 * defaulted to Roaming\npm and the CLI lived in Local\FinancialBrain — must
 * have the new version land on top of the one they are actually running, not
 * beside it. Installing to the default prefix there leaves two copies and the
 * old one still first on PATH.
 */
export function installPrefixOf(entryPath) {
  const marker = `${sep}lib${sep}node_modules${sep}brain-installer`;
  const at = String(entryPath || "").lastIndexOf(marker);
  if (at > 0) return entryPath.slice(0, at);
  // Windows global installs have no lib/ segment: <prefix>/node_modules/brain-installer
  const winMarker = `${sep}node_modules${sep}brain-installer`;
  const winAt = String(entryPath || "").lastIndexOf(winMarker);
  if (winAt > 0) return entryPath.slice(0, winAt);
  return null;
}

/** Where the re-exec should look for the freshly installed CLI. */
export function installedEntry(prefix, { platform = process.platform, exists = existsSync } = {}) {
  const candidates = platform === "win32"
    ? [join(prefix, "node_modules", "brain-installer", "brain.mjs"),
       join(prefix, "lib", "node_modules", "brain-installer", "brain.mjs")]
    : [join(prefix, "lib", "node_modules", "brain-installer", "brain.mjs")];
  return candidates.find((p) => exists(p)) || null;
}

/**
 * What to do, given what is running and what is published.
 *
 * Never downgrades: a brain built from a working branch reports a lower
 * version than the release while running a HIGHER schema, and pulling it back
 * to the release is the one move with no clean way out.
 */
export function selfUpdateDecision({ running, latest, optedOut = false, alreadyReexeced = false, prefix = null }) {
  if (optedOut) return { action: "skip", reason: "--no-self-update was passed" };
  if (alreadyReexeced) return { action: "skip", reason: "already re-executed once this run" };
  if (!latest) return { action: "warn", reason: "could not read the latest release" };
  if (!prefix) return { action: "warn", reason: "this CLI is not in a resolvable npm prefix" };
  let direction;
  try {
    direction = compareRelease(running, latest);
  } catch (error) {
    return { action: "warn", reason: String(error.message) };
  }
  if (direction === 0) return { action: "current", reason: `already on ${running}` };
  if (direction > 0) return { action: "current", reason: `running ${running}, newer than the published ${latest}` };
  return { action: "install", reason: `${running} -> ${latest}`, version: latest };
}

/** The tarball a decision points at. */
export function releaseTarballUrl(version) {
  const v = String(version).replace(/^v/, "");
  return `https://github.com/${RELEASE_REPO}/releases/download/v${v}/brain-installer-${v}.tgz`;
}

/**
 * Read the newest published release. Returns null on ANY failure: offline,
 * rate-limited, GitHub down. A client who cannot reach GitHub but can reach
 * Cloudflare must still be able to finish a stranded update, so this never
 * throws; the caller decides what a null means.
 */
export async function fetchLatestRelease({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "brain-installer" },
      signal: control.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const tag = String(body?.tag_name || "").replace(/^v/, "");
    return /^\d+\.\d+\.\d+$/.test(tag) ? tag : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
