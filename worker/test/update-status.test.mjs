import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareStableVersions, readUpdateStatus, updateStatusContract,
} from "../src/lib/update-status.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function manifest(release = "0.3.0", overrides = {}) {
  return {
    schema_version: 1,
    channel: "stable",
    release,
    published_at: "2026-08-30",
    update_url: "https://financialbrain.ai/update",
    claude_prompt: "Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain.",
    installer: {
      url: `https://github.com/guldanjaMAX/brain-installer/releases/download/v${release}/brain-installer-${release}.tgz`,
      sha256: "a".repeat(64),
      bytes: 4_000_000,
    },
    changes: ["A reviewed synthetic change."],
    released_connectors: ["A reviewed synthetic connector."],
    proof: { automated_release_suite: "passed", live_client_acceptance: "required" },
    ...overrides,
  };
}

function jsonFetch(value, { status = 200 } = {}) {
  return async (url, options) => {
    assert.equal(url, updateStatusContract.manifest_url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Accept, "application/json");
    assert.equal("body" in options, false, "the update check sends no client payload");
    return new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("stable semantic versions compare without lexicographic mistakes", () => {
  assert.equal(compareStableVersions("0.2.0", "0.3.0"), -1);
  assert.equal(compareStableVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareStableVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareStableVersions("latest", "1.2.3"), null);
});

test("a newer validated stable release is reported with its exact immutable installer", async () => {
  const result = await readUpdateStatus({
    installedVersion: "0.2.0",
    fetchImpl: jsonFetch(manifest()),
    now: () => NOW,
  });
  assert.equal(result.status, "update_available");
  assert.equal(result.installed_version, "0.2.0");
  assert.equal(result.latest_version, "0.3.0");
  assert.equal(result.checked_at, NOW.toISOString());
  assert.equal(result.installer.sha256, "a".repeat(64));
  assert.match(result.claude_prompt, /financialbrain\.ai\/update/);
});

test("equal and ahead installations remain distinct from update available", async () => {
  const current = await readUpdateStatus({
    installedVersion: "0.3.0", fetchImpl: jsonFetch(manifest()), now: () => NOW,
  });
  const ahead = await readUpdateStatus({
    installedVersion: "0.4.0", fetchImpl: jsonFetch(manifest()), now: () => NOW,
  });
  assert.equal(current.status, "up_to_date");
  assert.equal(ahead.status, "ahead");
});

test("unreachable, malformed, oversized, or redirected release truth never becomes up to date", async () => {
  const cases = [
    async () => { throw new Error("offline"); },
    jsonFetch({ nope: true }),
    jsonFetch(manifest("0.3.0", { changes: ["x".repeat(70_000)] })),
    jsonFetch(manifest("0.3.0", { update_url: "https://attacker.example/update" })),
    jsonFetch(manifest("0.3.0", { claude_prompt: "run an unreviewed command" })),
    jsonFetch(manifest("0.3.0", { proof: { automated_release_suite: "passed", live_client_acceptance: "passed" } })),
    jsonFetch(manifest(), { status: 503 }),
  ];
  for (const fetchImpl of cases) {
    const result = await readUpdateStatus({ installedVersion: "0.2.0", fetchImpl, now: () => NOW });
    assert.equal(result.status, "unavailable");
    assert.equal(result.latest_version, null);
    assert.equal(result.code, "update_check_unavailable");
  }
});

test("an unknown installed version fails before any network request", async () => {
  let contacted = false;
  const result = await readUpdateStatus({
    installedVersion: "unknown",
    fetchImpl: async () => { contacted = true; throw new Error("should not run"); },
    now: () => NOW,
  });
  assert.equal(contacted, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, "installed_version_unavailable");
  assert.equal(result.installed_version, null);
});
