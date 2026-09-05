import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseCloudflareAccountPath,
  cloudflareAccountPlan,
  normalizeCloudflareAccountPath,
} from "../operations/cloudflare-account-bootstrap.mjs";

test("the first-account and existing-account paths converge without claiming an account action", () => {
  const created = cloudflareAccountPlan("create");
  const existing = cloudflareAccountPlan("existing");
  assert.match(created.start_url, /cloudflare\.com\/sign-up/);
  assert.match(existing.start_url, /cloudflare\.com\/login/);
  assert.equal(created.convergence, existing.convergence);
  assert.match(created.multi_brain, /many separate Brains/i);
  assert.match(existing.multi_brain, /own Worker, D1 database, Vectorize index/i);
  for (const plan of [created, existing]) {
    assert.equal(plan.boundaries.provisioning, "not_started_by_this_plan");
    assert.equal(plan.boundaries.credential_storage, "wrangler_os_keyring");
    assert.doesNotMatch(JSON.stringify(plan), /api[_-]?token|client_secret|CLOUDFLARE_API_TOKEN|email@/i);
  }
});

test("the account path is explicit, friendly to uppercase input, and validated before use", async () => {
  assert.equal(normalizeCloudflareAccountPath(" Existing "), "existing");
  assert.equal(normalizeCloudflareAccountPath(""), null);
  assert.throws(() => normalizeCloudflareAccountPath("somewhere-else", { required: true }), /create or existing/);
  assert.equal(await chooseCloudflareAccountPath(async () => "CREATE"), "create");
  let prompted = false;
  assert.equal(await chooseCloudflareAccountPath(async () => { prompted = true; }, "existing"), "existing");
  assert.equal(prompted, false);
});
