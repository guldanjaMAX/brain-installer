/**
 * The final "deployed version matches the manifest" check must read the LIVE
 * Worker version against the update target. On 2026-09-03 a real 0.2.0 -> 0.3.4
 * update printed "install 0.2.0, manifest 0.2.0" as a PASS: both values were
 * captured before the update, while /health already said 0.3.4. A check that
 * never looks at the artifact certifies nothing.
 */
import assert from "node:assert/strict";
import { Acceptance } from "../acceptance.mjs";

function suiteWith({ liveVersion, manifestVersion, expectVersion }) {
  return new Acceptance({
    base: "https://example.invalid",
    adminKey: "k",
    manifest: { brain: { version: manifestVersion } },
    expectVersion,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      const body = path === "/health" ? { ok: true, version: liveVersion } : { ok: true, rows: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}
const find = (suite, name) => suite.results.find((r) => r.name === name);

// The exact failing shape: stale install state and stale manifest agree with
// each other, the live Worker is already on the target. Must PASS on the live
// value and WARN that the install state has not caught up.
{
  const suite = suiteWith({ liveVersion: "0.3.4", manifestVersion: "0.2.0", expectVersion: "0.3.4" });
  await suite.tierReach();
  await suite.tierOperations({ schema_version: 22, gate_version: 2, product_version: "0.2.0" });
  const v = find(suite, "deployed version matches the manifest");
  assert.ok(v, "version check recorded");
  assert.equal(v.status, "pass", `live 0.3.4 vs target 0.3.4 must pass, got ${v.status}: ${v.detail}`);
  assert.match(v.detail, /live 0\.3\.4, expected 0\.3\.4/, "detail names the live value and the target");
  const w = find(suite, "install state records the running version");
  assert.ok(w && w.status === "warn", "stale install state is surfaced as a warning, not hidden");
}

// A Worker that is NOT on the target must not pass, whatever the manifest says.
{
  const suite = suiteWith({ liveVersion: "0.2.0", manifestVersion: "0.3.4", expectVersion: "0.3.4" });
  await suite.tierReach();
  await suite.tierOperations({ schema_version: 22, gate_version: 2, product_version: "0.3.4" });
  const v = find(suite, "deployed version matches the manifest");
  assert.ok(v && v.status !== "pass", "a live 0.2.0 Worker cannot pass a 0.3.4 target");
}

// Without an explicit target, the manifest on disk is the target; a live match passes.
{
  const suite = suiteWith({ liveVersion: "0.3.4", manifestVersion: "0.3.4", expectVersion: null });
  await suite.tierReach();
  await suite.tierOperations({ schema_version: 22, gate_version: 2, product_version: "0.3.4" });
  const v = find(suite, "deployed version matches the manifest");
  assert.ok(v && v.status === "pass", `manifest-as-target must pass on a live match: ${v?.status} ${v?.detail}`);
  assert.equal(find(suite, "install state records the running version"), undefined, "no stale-state warning when it matches");
}

console.log("acceptance version: the live Worker version is what gets certified");
