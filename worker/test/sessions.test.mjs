import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mintSessionCookie, validateSessionCookie, readSessionCookie, clearSessionCookie, SESSION_COOKIE,
} from "../src/lib/sessions.js";

const env = { SESSION_SIGNING_KEY: "f".repeat(64) };
const requestWith = (cookie) => new Request("https://brain.example.com/api/app/me", {
  headers: cookie ? { Cookie: cookie } : {},
});

function cookieValue(setCookie) {
  return setCookie.split(";")[0];
}

test("a minted session validates for its generation and only its generation", async () => {
  const setCookie = await mintSessionCookie(env, 1);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(await validateSessionCookie(requestWith(cookieValue(setCookie)), env, 1), true);
  assert.deepEqual(await readSessionCookie(requestWith(cookieValue(setCookie)), env, 1), { grantId: null });
  assert.equal(await validateSessionCookie(requestWith(cookieValue(setCookie)), env, 2), false,
    "bumping the generation is sign-out-everywhere");
});

test("expiry, tampering, and a missing secret all fail closed", async () => {
  const past = Date.now() - 1000;
  const expired = await mintSessionCookie(env, 1, past - 31 * 24 * 60 * 60 * 1000);
  assert.equal(await validateSessionCookie(requestWith(cookieValue(expired)), env, 1), false);

  const setCookie = cookieValue(await mintSessionCookie(env, 1));
  const tampered = setCookie.replace(/\.(\d+)\./, (m, gen) => `.${Number(gen) + 1}.`);
  assert.equal(await validateSessionCookie(requestWith(tampered), env, 2), false,
    "editing the generation without re-signing must fail");

  assert.equal(await validateSessionCookie(requestWith(setCookie), {}, 1), false,
    "no signing secret means no sessions, never open access");
  assert.equal(await validateSessionCookie(requestWith(null), env, 1), false);
});

test("the clearing cookie expires the session immediately", () => {
  const cleared = clearSessionCookie();
  assert.match(cleared, new RegExp(`^${SESSION_COOKIE}=;`));
  assert.match(cleared, /Max-Age=0/);
});
