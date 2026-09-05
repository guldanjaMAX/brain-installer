import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mintSessionCookie, validateSessionCookie, readSessionCookie, clearSessionCookie,
  credentialSessionRef, SESSION_COOKIE, SESSION_TTL_MS,
} from "../src/lib/sessions.js";

const env = { SESSION_SIGNING_KEY: "f".repeat(64) };
const requestWith = (cookie) => new Request("https://brain.example.com/api/app/me", {
  headers: cookie ? { Cookie: cookie } : {},
});

function cookieValue(setCookie) {
  return setCookie.split(";")[0];
}

async function legacySignature(payload) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return Buffer.from(bytes).toString("base64url");
}

test("a minted session validates for its generation and only its generation", async () => {
  const credentialId = "fixture-owner-passkey";
  const setCookie = await mintSessionCookie(env, 1, { grantId: null, credentialId });
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.equal(await validateSessionCookie(requestWith(cookieValue(setCookie)), env, 1), true);
  assert.deepEqual(await readSessionCookie(requestWith(cookieValue(setCookie)), env, 1), {
    grantId: null,
    credentialRef: await credentialSessionRef(env, credentialId),
  });
  assert.equal(await validateSessionCookie(requestWith(cookieValue(setCookie)), env, 2), false,
    "bumping the generation is sign-out-everywhere");
});

test("v1 and v2 cookies are deliberately invalidated by the credential-bound upgrade", async () => {
  const expires = Date.now() + 60_000;
  const v1Payload = `${expires}.1`;
  const v2Payload = `${expires}.1.-`;
  const v1 = `${SESSION_COOKIE}=v1.${v1Payload}.${await legacySignature(v1Payload)}`;
  const v2 = `${SESSION_COOKIE}=v2.${v2Payload}.${await legacySignature(v2Payload)}`;
  assert.equal(await readSessionCookie(requestWith(v1), env, 1), null);
  assert.equal(await readSessionCookie(requestWith(v2), env, 1), null);
});

test("session expiry is exactly the documented 30-day boundary", async () => {
  const now = 1_788_102_400_000;
  const cookie = cookieValue(await mintSessionCookie(env, 1, {
    grantId: null, credentialId: "fixture-owner-passkey", now,
  }));
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(await validateSessionCookie(requestWith(cookie), env, 1, now + SESSION_TTL_MS - 1), true);
  assert.equal(await validateSessionCookie(requestWith(cookie), env, 1, now + SESSION_TTL_MS), false);
});

test("expiry, tampering, and a missing secret all fail closed", async () => {
  const past = Date.now() - 1000;
  const expired = await mintSessionCookie(env, 1, {
    grantId: null, credentialId: "fixture-owner-passkey",
    now: past - 31 * 24 * 60 * 60 * 1000,
  });
  assert.equal(await validateSessionCookie(requestWith(cookieValue(expired)), env, 1), false);

  const setCookie = cookieValue(await mintSessionCookie(env, 1, {
    grantId: null, credentialId: "fixture-owner-passkey",
  }));
  const tampered = setCookie.replace(/\.(\d+)\./, (m, gen) => `.${Number(gen) + 1}.`);
  assert.equal(await validateSessionCookie(requestWith(tampered), env, 2), false,
    "editing the generation without re-signing must fail");

  assert.equal(await validateSessionCookie(requestWith(setCookie), {}, 1), false,
    "no signing secret means no sessions, never open access");
  assert.equal(await validateSessionCookie(requestWith(null), env, 1), false);
});

test("a session cannot be minted without an exact passkey binding", async () => {
  await assert.rejects(() => mintSessionCookie(env, 1, { grantId: null }), /credential id/);
});

test("the clearing cookie expires the session immediately", () => {
  const cleared = clearSessionCookie();
  assert.match(cleared, new RegExp(`^${SESSION_COOKIE}=;`));
  assert.match(cleared, /Max-Age=0/);
});
