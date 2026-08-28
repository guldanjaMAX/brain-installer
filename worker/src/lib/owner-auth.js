/**
 * owner-auth — the passkey routes and the session privilege class.
 *
 * Everything here serves the OWNER surface (/app): enrollment gated by a
 * single-use invite code or an existing session, sign-in by passkey
 * assertion, and a small device-management API. These routes sit in front of
 * the key gate because their auth IS the ceremony (or the session cookie a
 * ceremony earned) — but nothing here can reach past the read-only privilege
 * class: ingest, purge, reindex, drain and every /api/admin route still
 * demand the admin key.
 *
 * CSRF: session-authenticated requests must carry `X-Brain-App: 1` on top of
 * the SameSite=Strict cookie. Both are set only by the app page itself.
 */

import { jsonResponse } from "./core.js";
import { verifyRegistration, verifyAssertion, b64uDecode } from "./webauthn.js";
import {
  mintSessionCookie, validateSessionCookie, clearSessionCookie,
} from "./sessions.js";
import {
  issueChallenge, consumeChallenge,
  issueEnrollmentCode, peekEnrollmentCode, consumeEnrollmentCode,
  storePasskey, findPasskey, recordPasskeyUse,
  listPasskeys, renamePasskey, revokePasskey,
  sessionGeneration, bumpSessionGeneration,
} from "./auth-store.js";
import { appPageHtml, brandOgSvg } from "./app-page.js";
import { APP_JS, APP_CSS } from "./app-assets.js";

const APP_HEADER = "X-Brain-App";

function appRequest(request) {
  return request.headers.get(APP_HEADER) === "1";
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Extract the challenge string the client signed, to check it against ours. */
function challengeFromClientData(clientDataJSON) {
  try {
    return JSON.parse(new TextDecoder().decode(b64uDecode(clientDataJSON)))?.challenge || null;
  } catch {
    return null;
  }
}

/** Session check used by the read-route gate and every /api/app route. */
export async function validateOwnerSession(request, env) {
  if (!appRequest(request)) return false;
  return validateSessionCookie(request, env, await sessionGeneration(env));
}

/* ------------------------------------------------------------ admin plane */

/** POST /api/admin/auth/invite — mint a one-time enrollment link. Admin key. */
export async function handleAdminInvite(env, url) {
  const code = await issueEnrollmentCode(env);
  return jsonResponse({
    url: `${url.origin}/app#enroll=${code}`,
    expires_in_minutes: 15,
    rp_id: url.hostname,
    note: "single use. Passkeys bind to this exact domain; changing the brain's domain later requires re-enrollment.",
  });
}

/** GET /api/admin/auth/devices + POST .../revoke — the CLI's device view. */
export async function handleAdminDevices(env, request, path) {
  if (path.endsWith("/revoke") && request.method === "POST") {
    const payload = await body(request);
    if (!payload?.credential_id) return jsonResponse({ error: "credential_id required" }, 400);
    return jsonResponse(await revokePasskey(env, String(payload.credential_id)));
  }
  return jsonResponse({ devices: await listPasskeys(env) });
}

/* ------------------------------------------------------------ owner plane */

export async function handleOwnerAuth(env, request, url, path) {
  // The link-preview image. Public and cacheable by design: a scraper fetching
  // it must never need a credential, and it contains only the brain's own name.
  if (path === "/brand/og.svg" && request.method === "GET") {
    return new Response(brandOgSvg(env), {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (path === "/app/assets/app.js" || path === "/app/assets/app.css") {
    if (request.method !== "GET") return jsonResponse({ error: "not found" }, 404);
    const isJs = path.endsWith(".js");
    return new Response(isJs ? APP_JS : APP_CSS, {
      headers: {
        "Content-Type": isJs ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (path === "/app" && request.method === "GET") {
    // Absolute URLs: a link scraper resolves og:image against nothing.
    return new Response(appPageHtml(env, url.origin), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The shell must never be cached. It carries the per-install owner
        // name and the bundle id that cache-busts the app, so a stale copy
        // survives an upgrade and quietly serves the previous build's
        // identity. It is under a kilobyte; caching it saves nothing and
        // costs correctness. The bundle itself stays immutable.
        "Cache-Control": "no-store",
        // The page is self-contained by construction; the CSP makes that a
        // promise instead of a habit. Inline script is the page itself.
        // Stronger than the inline page it replaced: with the app served from
        // this origin, 'unsafe-inline' is gone from both script and style.
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
          "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const rpId = url.hostname;
  const origin = url.origin;

  if (path === "/auth/register/options") {
    const payload = await body(request);
    // Enrollment is authorized by an invite code, or by an existing session
    // (adding one more device from a signed-in one).
    const viaSession = await validateOwnerSession(request, env);
    if (!viaSession) {
      const code = String(payload?.code || "");
      if (!code || !(await peekEnrollmentCode(env, code))) {
        return jsonResponse({ error: "a valid enrollment link is required" }, 403);
      }
    }
    const challenge = await issueChallenge(env, "register");
    return jsonResponse({
      challenge,
      rp: { id: rpId, name: env.BRAIN_NAME || "brain" },
      user_name: env.BRAIN_OWNER || "owner",
    });
  }

  if (path === "/auth/register/verify") {
    const payload = await body(request);
    if (!payload) return jsonResponse({ error: "invalid body" }, 400);
    const viaSession = await validateOwnerSession(request, env);
    const challenge = challengeFromClientData(payload.clientDataJSON);
    if (!challenge || !(await consumeChallenge(env, challenge, "register"))) {
      return jsonResponse({ error: "unknown or expired challenge" }, 403);
    }
    if (!viaSession && !(await consumeEnrollmentCode(env, String(payload.code || "")))) {
      return jsonResponse({ error: "the enrollment link is invalid, expired, or already used" }, 403);
    }
    let verified;
    try {
      verified = await verifyRegistration({
        attestationObject: payload.attestationObject,
        clientDataJSON: payload.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        rpId,
      });
    } catch (error) {
      return jsonResponse({ error: String(error?.message || error) }, 400);
    }
    await storePasskey(env, { ...verified, nickname: String(payload.nickname || "").slice(0, 60) });
    const cookie = await mintSessionCookie(env, await sessionGeneration(env));
    return withCookie(jsonResponse({ enrolled: true, credential_id: verified.credentialId }), cookie);
  }

  if (path === "/auth/login/options") {
    const challenge = await issueChallenge(env, "login");
    return jsonResponse({ challenge, rp_id: rpId });
  }

  if (path === "/auth/login/verify") {
    const payload = await body(request);
    if (!payload) return jsonResponse({ error: "invalid body" }, 400);
    const challenge = challengeFromClientData(payload.clientDataJSON);
    if (!challenge || !(await consumeChallenge(env, challenge, "login"))) {
      return jsonResponse({ error: "unknown or expired challenge" }, 403);
    }
    const credential = await findPasskey(env, String(payload.credentialId || ""));
    if (!credential) return jsonResponse({ error: "unknown passkey" }, 403);
    let verdict;
    try {
      verdict = await verifyAssertion({
        authenticatorData: payload.authenticatorData,
        clientDataJSON: payload.clientDataJSON,
        signature: payload.signature,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        rpId,
        credential,
      });
    } catch (error) {
      return jsonResponse({ error: String(error?.message || error) }, 403);
    }
    if (verdict.cloneSuspected) {
      // A counter that failed to advance means two copies of a hardware-bound
      // credential exist. Refuse loudly; the owner revokes it from another
      // device or the operator does via the CLI.
      return jsonResponse({ error: "this passkey looks cloned (its counter went backwards); sign in from another device and revoke it" }, 403);
    }
    await recordPasskeyUse(env, credential.credential_id, verdict.signCount);
    const cookie = await mintSessionCookie(env, await sessionGeneration(env));
    return withCookie(jsonResponse({ signed_in: true }), cookie);
  }

  // Everything below requires a live session.
  if (!(await validateOwnerSession(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (path === "/api/app/me") {
    return jsonResponse({
      signed_in: true,
      brain: env.BRAIN_NAME || "brain",
      owner: env.BRAIN_OWNER || "owner",
      devices: await listPasskeys(env),
    });
  }
  if (path === "/api/app/devices/rename") {
    const payload = await body(request);
    if (!payload?.credential_id) return jsonResponse({ error: "credential_id required" }, 400);
    await renamePasskey(env, String(payload.credential_id), payload.nickname);
    return jsonResponse({ renamed: true });
  }
  if (path === "/api/app/devices/revoke") {
    const payload = await body(request);
    if (!payload?.credential_id) return jsonResponse({ error: "credential_id required" }, 400);
    return jsonResponse(await revokePasskey(env, String(payload.credential_id)));
  }
  if (path === "/api/app/signout") {
    return withCookie(jsonResponse({ signed_out: true }), clearSessionCookie());
  }
  if (path === "/api/app/signout-all") {
    await bumpSessionGeneration(env);
    return withCookie(jsonResponse({ signed_out_everywhere: true }), clearSessionCookie());
  }
  return jsonResponse({ error: "not found" }, 404);
}

function withCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}
