import {
  consumeChallenge, consumeEnrollmentCode, revokePasskey, sha256Hex,
} from "../../../worker/src/lib/auth-store.js";
import { handleToken } from "../../../worker/src/lib/oauth.js";

const CHALLENGE = "synthetic-local-challenge";
const ENROLLMENT = "synthetic-local-enrollment";
const OAUTH_CODE = "synthetic-local-oauth-code";
const VERIFIER = "local-atomicity-verifier-0123456789-ABCDEFGHIJKLMN";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function pkceChallenge() {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(VERIFIER),
  ));
  let raw = "";
  for (const byte of digest) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function reset(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges"),
    env.DB.prepare("DELETE FROM enrollment_codes"),
    env.DB.prepare("DELETE FROM owner_passkeys"),
    env.DB.prepare("DELETE FROM oauth_codes"),
    env.DB.prepare("DELETE FROM oauth_tokens"),
    env.DB.prepare("DELETE FROM owner_activity_events WHERE event_type = 'passkey_revoked'"),
    env.DB.prepare(
      "INSERT INTO auth_challenges (challenge_hash, purpose, expires_at) VALUES (?, 'login', ?)",
    ).bind(await sha256Hex(CHALLENGE), now + 60_000),
    env.DB.prepare(
      "INSERT INTO enrollment_codes (code_hash, expires_at) VALUES (?, ?)",
    ).bind(await sha256Hex(ENROLLMENT), now + 60_000),
    env.DB.prepare(
      `INSERT INTO oauth_codes
         (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at)
       VALUES (?, 'synthetic-client', 'http://127.0.0.1/callback', ?, 'read', ?)`,
    ).bind(await sha256Hex(OAUTH_CODE), await pkceChallenge(), now + 60_000),
    env.DB.prepare(
      `INSERT INTO owner_passkeys
         (credential_id, public_key_jwk, alg, sign_count, nickname, created_at)
       VALUES ('owner-a', '{}', -7, 0, 'Owner A', ?)`
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO owner_passkeys
         (credential_id, public_key_jwk, alg, sign_count, nickname, created_at)
       VALUES ('owner-b', '{}', -7, 0, 'Owner B', ?)`
    ).bind(now + 1),
  ]);
  return json({ reset: true });
}

async function oauthExchange(env) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: OAUTH_CODE,
    client_id: "synthetic-client",
    redirect_uri: "http://127.0.0.1/callback",
    code_verifier: VERIFIER,
  });
  return handleToken(env, new Request("http://127.0.0.1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }));
}

async function state(env) {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM auth_challenges) AS challenges,
       (SELECT count(*) FROM enrollment_codes WHERE used_at IS NULL) AS unused_enrollments,
       (SELECT count(*) FROM oauth_codes) AS oauth_codes,
       (SELECT count(*) FROM oauth_tokens) AS oauth_tokens,
       (SELECT count(*) FROM owner_passkeys
          WHERE grant_id IS NULL AND document_grant_id IS NULL) AS owner_passkeys`,
  ).first();
  return json(counts);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/health") return json({ ok: true });
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (path === "/reset") return reset(env);
      if (path === "/consume/challenge") {
        return json({ consumed: await consumeChallenge(env, CHALLENGE, "login") });
      }
      if (path === "/consume/enrollment") {
        return json({ consumed: Boolean(await consumeEnrollmentCode(env, ENROLLMENT)) });
      }
      if (path === "/consume/oauth") return oauthExchange(env);
      if (path === "/revoke/owner-a") return json(await revokePasskey(env, "owner-a"));
      if (path === "/revoke/owner-b") return json(await revokePasskey(env, "owner-b"));
      if (path === "/state") return state(env);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: String(error?.message || error).slice(0, 200) }, 503);
    }
  },
};
