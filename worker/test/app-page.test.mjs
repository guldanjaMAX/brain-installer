/**
 * The invite link is the first thing a client ever sees of their brain, and it
 * usually arrives as a text message. These assert the two surfaces that shapes:
 * the link preview a messaging app renders, and the page itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { appPageHtml, brandOgSvg } from "../src/lib/app-page.js";
import { APP_JS } from "../src/lib/app-assets.js";

const ORIGIN = "https://brain.example.com";
const env = { BRAIN_NAME: "acme-brain", BRAIN_OWNER: "Dana Okonkwo" };
const meta = (html, prop) =>
  (html.match(new RegExp(`(?:property|name)="${prop}" content="([^"]*)"`)) || [])[1];

test("the public preview is useful but generic until authentication", () => {
  const html = appPageHtml(env, ORIGIN);
  assert.equal(html.match(/<title>(.*?)<\/title>/)[1], "Private Financial Brain");
  assert.equal(meta(html, "og:title"), "Private Financial Brain");
  assert.equal(meta(html, "twitter:card"), "summary_large_image");
  // A description that only names the product tells a client nothing. It has
  // to say what it holds and what it does.
  for (const phrase of ["written, decided and been told", "answers with its sources", "face or fingerprint"]) {
    assert.ok(meta(html, "og:description").includes(phrase), phrase);
  }
  assert.equal(meta(html, "description"), meta(html, "og:description"));
});

test("preview URLs are absolute, because a scraper resolves them against nothing", () => {
  const html = appPageHtml(env, ORIGIN);
  assert.equal(meta(html, "og:image"), `${ORIGIN}/brand/og.svg`);
  assert.equal(meta(html, "og:url"), `${ORIGIN}/app`);
  assert.equal(meta(html, "twitter:image"), `${ORIGIN}/brand/og.svg`);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<link rel="apple-touch-icon"/);
});

test("configured identity is absent from every public shell and preview byte", () => {
  const hostile = {
    BRAIN_NAME: 'private-client-brain"><script>brainName()</script>',
    BRAIN_OWNER: 'Dana Okonkwo"><script>ownerName()</script>',
  };
  const html = appPageHtml(hostile, ORIGIN);
  const svg = brandOgSvg(hostile);
  for (const privateValue of [
    "private-client-brain", "Dana Okonkwo", "brainName", "ownerName",
    "data-owner", "data-brain",
  ]) {
    assert.ok(!html.includes(privateValue), `${privateValue} reached the public app shell`);
    assert.ok(!svg.includes(privateValue), `${privateValue} reached the public preview image`);
  }
});

test("the preview image is public: a scraper holds no credential", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/brand/og.svg`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") || "", /image\/svg\+xml/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const body = await response.text();
  assert.ok(body.includes("Private Financial Brain"));
  assert.ok(!body.includes(env.BRAIN_OWNER));
  assert.ok(!body.includes(env.BRAIN_NAME));
  assert.match(body, /viewBox="0 0 1200 630"/);
});

test("every public owner-surface path reaches its handler, not the key gate", async () => {
  // This exact bug has now been shipped twice in one day: a new public path is
  // added inside the owner-surface handler, but the router still matches "/app"
  // exactly, so the request falls through to the key gate and 401s. The page
  // renders and the assets do not, which looks like a broken app rather than a
  // routing mistake. Assert the whole public set, so the next path added is
  // caught here instead of by a client.
  for (const path of ["/app", "/brand/og.svg", "/app/assets/app.js", "/app/assets/app.css"]) {
    const response = await worker.fetch(new Request(ORIGIN + path), env);
    assert.notEqual(response.status, 401, `${path} must not be behind the key gate`);
    assert.equal(response.status, 200, `${path} should serve`);
  }
});

test("the app bundle is served with the right types and is cacheable", async () => {
  const js = await worker.fetch(new Request(`${ORIGIN}/app/assets/app.js`), env);
  assert.match(js.headers.get("Content-Type") || "", /text\/javascript/);
  assert.match(js.headers.get("Cache-Control") || "", /immutable/);
  assert.equal(js.headers.get("X-Content-Type-Options"), "nosniff");
  const css = await worker.fetch(new Request(`${ORIGIN}/app/assets/app.css`), env);
  assert.match(css.headers.get("Content-Type") || "", /text\/css/);
  // The shell must point at what is actually served, cache-busted per build.
  const html = appPageHtml(env, ORIGIN);
  assert.match(html, /\/app\/assets\/app\.js\?v=[0-9a-f]{12}/);
  assert.match(html, /\/app\/assets\/app\.css\?v=[0-9a-f]{12}/);
});

test("the generated owner bundle carries the approved navigation and Manage experience", () => {
  for (const phrase of [
    "Your financial life, in one clear view",
    "Customized Tasks",
    "Review Priorities",
    "Business entities",
    "Set up your data",
    "Scan documents or receipts",
    "Attach document",
    "Priority",
  ]) {
    assert.ok(APP_JS.includes(phrase), `missing generated UI phrase: ${phrase}`);
  }
  assert.ok(!APP_JS.includes("Needs you"), "the retired status label reached the owner bundle");
  assert.ok(!APP_JS.includes("Add & Review"), "the retired primary destination reached the owner bundle");
  assert.ok(APP_JS.includes("This Financial Brain uses owner-only access"));
  assert.ok(APP_JS.includes("legacy document-access"));
});

test("the shell is never cached, so an upgrade actually reaches the client", async () => {
  // Caught in a real browser: without this the shell cached heuristically and
  // kept serving a previous build's owner name and bundle id.
  const response = await worker.fetch(new Request(`${ORIGIN}/app`), env);
  assert.match(response.headers.get("Cache-Control") || "", /no-store/);
  const html = await response.text();
  assert.ok(!html.includes(env.BRAIN_OWNER));
  assert.ok(!html.includes(env.BRAIN_NAME));
  assert.doesNotMatch(html, /data-(?:owner|brain)=/);
});

test("nothing is inline any more, so the policy forbids inline", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/app`), env);
  const csp = response.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("unsafe-inline"), "the bundle removed the need for unsafe-inline");
  assert.match(csp, /frame-ancestors 'none'/);
});

test("fetching the page never consumes an enrollment code", async () => {
  // Link scanners auto-fetch. If GET burned the code, the preview generated by
  // the client's own messaging app would destroy the invite before they tapped.
  let wrote = false;
  const dbEnv = {
    ...env,
    STORAGE: "d1",
    DB: { prepare: () => ({ bind: () => ({ first: async () => { wrote = true; return null; }, all: async () => ({ results: [] }), run: async () => { wrote = true; return {}; } }) }) },
  };
  const response = await worker.fetch(new Request(`${ORIGIN}/app#enroll=whatever`), dbEnv);
  assert.equal(response.status, 200);
  assert.equal(wrote, false, "GET /app must not touch enrollment state");
});
