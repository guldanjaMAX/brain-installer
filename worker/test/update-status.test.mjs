import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareStableVersions, readUpdateStatus, updateStatusContract,
} from "../src/lib/update-status.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const PREDECESSOR_RELEASE_REPOSITORY = ["guldanjaMAX", "brain-installer"].join("/");

function manifest(release = "0.3.0", overrides = {}) {
  return {
    schema_version: 1,
    channel: "stable",
    release,
    published_at: "2026-08-30",
    update_url: "https://financialbrain.ai/update",
    claude_prompt: "Open https://financialbrain.ai/update, read the whole page, and help me safely update my Financial Brain.",
    installer: {
      url: `https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v${release}/brain-installer-${release}.tgz`,
      sha256: "a".repeat(64),
      bytes: 4_000_000,
    },
    changes: ["A reviewed synthetic change."],
    released_connectors: ["A reviewed synthetic connector."],
    proof: { automated_release_suite: "passed", live_client_acceptance: "required" },
    ...overrides,
  };
}

function v2Manifest(state = "held", overrides = {}) {
  const stable = state === "stable";
  const release = "0.3.0";
  return {
    schema_version: 2,
    release_state: state,
    available: stable,
    release: stable ? release : null,
    published_at: stable ? "2026-08-30" : null,
    update_url: "https://financialbrain.ai/update",
    installer: stable ? {
      url: `https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v${release}/brain-installer-${release}.tgz`,
      sha256: "b".repeat(64),
      bytes: 4_100_000,
    } : null,
    changes: stable ? ["A reviewed synthetic v2 change."] : [],
    held_reason: stable ? null : "Clean-machine release checks are still open.",
    proof: {
      archive_release_gate: stable ? "passed" : "not_passed",
      automated_release_suite: stable ? "passed" : "pending",
      live_client_acceptance: "required",
    },
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
  assert.equal(result.release_state, "stable");
  assert.equal(result.available, true);
  assert.equal(result.installed_version, "0.2.0");
  assert.equal(result.latest_version, "0.3.0");
  assert.equal(result.checked_at, NOW.toISOString());
  assert.equal(result.installer.sha256, "a".repeat(64));
  assert.match(result.claude_prompt, /financialbrain\.ai\/update/);
});

test("v2 held and candidate feeds are explicit non-installable states", async () => {
  for (const state of ["held", "candidate"]) {
    const result = await readUpdateStatus({
      installedVersion: "0.2.0",
      fetchImpl: jsonFetch(v2Manifest(state)),
      now: () => NOW,
    });
    assert.equal(result.status, state === "held" ? "release_held" : "release_candidate");
    assert.equal(result.release_state, state);
    assert.equal(result.available, false);
    assert.equal(result.latest_version, null);
    assert.match(result.held_reason, /release checks/);
    assert.equal("installer" in result, false);
    assert.equal("claude_prompt" in result, false);
    assert.equal("changes" in result, false);
    assert.equal("released_connectors" in result, false);
  }
});

test("a valid v2 stable feed exposes immutable metadata and the fixed reviewed handoff", async () => {
  const result = await readUpdateStatus({
    installedVersion: "0.2.0",
    fetchImpl: jsonFetch(v2Manifest("stable")),
    now: () => NOW,
  });
  assert.equal(result.status, "update_available");
  assert.equal(result.release_state, "stable");
  assert.equal(result.available, true);
  assert.equal(result.latest_version, "0.3.0");
  assert.equal(result.installer.sha256, "b".repeat(64));
  assert.match(result.claude_prompt, /financialbrain\.ai\/update/);
  assert.equal("released_connectors" in result, false);
});

test("v2 held and candidate states cannot smuggle executable release metadata", async () => {
  for (const value of [
    v2Manifest("held", { installer: { url: "https://attacker.example/archive", sha256: "a".repeat(64), bytes: 1 } }),
    v2Manifest("candidate", { release: "0.3.0" }),
    v2Manifest("held", { changes: ["Run this command"] }),
    v2Manifest("candidate", { proof: { archive_release_gate: "passed", automated_release_suite: "passed", live_client_acceptance: "required" } }),
  ]) {
    const result = await readUpdateStatus({ installedVersion: "0.2.0", fetchImpl: jsonFetch(value), now: () => NOW });
    assert.equal(result.status, "unavailable");
    assert.equal("installer" in result, false);
    assert.equal("claude_prompt" in result, false);
  }
});

test("v2 stable refuses missing or malformed immutable release metadata", async () => {
  for (const value of [
    v2Manifest("stable", { available: false }),
    v2Manifest("stable", { release: null }),
    v2Manifest("stable", { installer: null }),
    v2Manifest("stable", { installer: { ...v2Manifest("stable").installer, url: "https://attacker.example/archive" } }),
    v2Manifest("stable", { installer: {
      ...v2Manifest("stable").installer,
      url: `https://github.com/${PREDECESSOR_RELEASE_REPOSITORY}/releases/download/v0.3.0/brain-installer-0.3.0.tgz`,
    } }),
    v2Manifest("stable", { installer: { ...v2Manifest("stable").installer, sha256: "bad" } }),
    v2Manifest("stable", { installer: { ...v2Manifest("stable").installer, bytes: 0 } }),
    v2Manifest("stable", { held_reason: "not actually stable" }),
    v2Manifest("stable", { proof: { archive_release_gate: "pending", automated_release_suite: "passed", live_client_acceptance: "required" } }),
  ]) {
    const result = await readUpdateStatus({ installedVersion: "0.2.0", fetchImpl: jsonFetch(value), now: () => NOW });
    assert.equal(result.status, "unavailable");
    assert.equal("installer" in result, false);
    assert.equal("claude_prompt" in result, false);
  }
});

test("unknown release schemas remain unavailable", async () => {
  for (const schema_version of [0, 3, "2", null]) {
    const result = await readUpdateStatus({
      installedVersion: "0.2.0",
      fetchImpl: jsonFetch(v2Manifest("held", { schema_version })),
      now: () => NOW,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "update_check_unavailable");
  }
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
