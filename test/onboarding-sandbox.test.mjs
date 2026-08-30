import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  SANDBOX_SCENARIOS,
  injectRehearsalBanner,
  onboardingGuideHtml,
  sandboxScenarioFromReferer,
} from "../scripts/onboarding-sandbox.mjs";

test("the rehearsal starts with an unmistakable local-only safety screen", () => {
  const html = onboardingGuideHtml({ appOrigin: "http://127.0.0.1:4176" });
  for (const phrase of [
    "LOCAL REHEARSAL",
    "SYNTHETIC DATA",
    "Nothing is deployed",
    "does not prove Cloudflare",
    "Close this terminal",
  ]) assert.match(html, new RegExp(phrase, "i"));
  assert.equal((html.match(/class="card"/g) || []).length, SANDBOX_SCENARIOS.length);
  assert.match(html, /state=signin#enroll=local-rehearsal-only/);
  assert.doesNotMatch(html, /api[_-]?key|client[_-]?secret|app[_-]?password/i);
});

test("every actual workspace screen receives the persistent rehearsal banner", () => {
  const result = injectRehearsalBanner("<!doctype html><body><div id=\"root\"></div></body>");
  assert.match(result, /LOCAL REHEARSAL · SYNTHETIC DATA · NO ACCOUNTS CONNECTED/);
  assert.equal((result.match(/LOCAL REHEARSAL/g) || []).length, 1);
  assert.match(result, /<div id="root"><\/div>/);
});

test("the mock scenario follows the app page that initiated the API call", () => {
  const base = "http://127.0.0.1:4176";
  assert.equal(sandboxScenarioFromReferer(`${base}/app?state=degraded`, base), "degraded");
  assert.equal(sandboxScenarioFromReferer(`${base}/app?state=grant-unavailable`, base), "grant-unavailable");
  assert.equal(sandboxScenarioFromReferer("not a url", base), "populated");
});

test("the scenario menu covers happy, empty, unavailable, retry, conflict, and scoped-access states", () => {
  const ids = new Set(SANDBOX_SCENARIOS.map((scenario) => scenario.id));
  for (const id of ["populated", "empty", "partial", "degraded", "conflict", "idempotent", "grant", "grant-unavailable", "signin"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test("the real UI rehearsal includes available and unavailable update fixtures", () => {
  const fixture = readFileSync(resolve("frontend/test/visual-server.mjs"), "utf8");
  assert.match(fixture, /\/api\/app\/update-status/);
  assert.match(fixture, /status: "update_available"/);
  assert.match(fixture, /code: "update_check_unavailable"/);
  assert.match(fixture, /A synthetic reviewed update is available in this local rehearsal/);
});
