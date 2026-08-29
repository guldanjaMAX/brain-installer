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
  mintSessionCookie, validateSessionCookie, readSessionCookie, clearSessionCookie,
} from "./sessions.js";
import {
  issueChallenge, consumeChallenge,
  issueEnrollmentCode, peekEnrollmentCode, consumeEnrollmentCode,
  storePasskey, findPasskey, recordPasskeyUse,
  listPasskeys, renamePasskey, revokePasskey,
  sessionGeneration, bumpSessionGeneration,
  randomToken, createGrant, addGrantCredential, listGrants, revokeGrant,
  assignZone, listZones,
} from "./auth-store.js";
import { CAPABILITIES, parseCapabilities, hashToken } from "./grants.js";
import { appPageHtml } from "./app-page.js";

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

/**
 * GET /api/admin/auth/grants, POST to create, POST .../revoke to end one.
 *
 * The token is generated here, returned exactly once in the create response,
 * and never stored: only its SHA-256 hash goes to the database. There is no
 * endpoint that can show it again, which is the point. If it is lost the
 * owner mints another and revokes the first.
 */
export async function handleAdminGrants(env, request, path) {
  if (path.endsWith("/revoke") && request.method === "POST") {
    const payload = await body(request);
    if (!payload?.grant_id) return jsonResponse({ error: "grant_id required" }, 400);
    const revoked = await revokeGrant(env, String(payload.grant_id));
    return jsonResponse({ revoked, grant_id: String(payload.grant_id) });
  }

  if (request.method === "POST") {
    const payload = await body(request);
    const displayName = String(payload?.display_name || "").trim();
    if (!displayName) return jsonResponse({ error: "display_name required" }, 400);

    const capabilities = parseCapabilities(payload?.capabilities);
    if (!capabilities) {
      return jsonResponse({
        error: `capabilities must be a non-empty subset of: ${CAPABILITIES.join(", ")}`,
      }, 400);
    }
    // Granting `administer` hands over the ability to create more grants, which
    // is the owner's own authority. Refuse it here rather than letting an
    // owner give it away without meaning to.
    if (capabilities.includes("administer")) {
      return jsonResponse({
        error: "administer cannot be granted: it would let this person create and revoke other people's access",
      }, 400);
    }

    const expiresAt = payload?.expires_at === undefined || payload?.expires_at === null
      ? null
      : Number(payload.expires_at);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return jsonResponse({ error: "expires_at must be a future unix ms timestamp, or null" }, 400);
    }

    // Scope. Omitting it means every zone, which is what a grant created
    // before zones existed already had, so the default cannot narrow anyone by
    // surprise. Naming zones narrows to exactly those.
    const zones = Array.isArray(payload?.zones)
      ? payload.zones.map((z) => String(z).trim()).filter(Boolean)
      : null;
    const exclude = Array.isArray(payload?.exclude_zones)
      ? payload.exclude_zones.map((z) => String(z).trim()).filter(Boolean)
      : [];
    if (zones && zones.length === 0) {
      return jsonResponse({ error: "zones was given but empty; omit it to mean every zone" }, 400);
    }
    const scopeInclude = zones ? JSON.stringify({ zones }) : '{"all":true}';
    const scopeExclude = JSON.stringify(exclude);

    const grantId = `g_${randomToken(8)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const token = randomToken(32);
    await createGrant(env, {
      grantId,
      displayName: displayName.slice(0, 120),
      relationship: payload?.relationship ? String(payload.relationship).slice(0, 120) : null,
      capabilities,
      expiresAt,
      createdBy: "owner",
      scopeInclude,
      scopeExclude,
    });
    await addGrantCredential(env, { tokenHash: await hashToken(token), grantId });

    return jsonResponse({
      grant_id: grantId,
      display_name: displayName,
      capabilities,
      expires_at: expiresAt,
      zones: zones || "all",
      token,
      note: "This token is shown once and is not recoverable. Give it to them over a channel you trust.",
    });
  }

  return jsonResponse({ grants: await listGrants(env) });
}

/**
 * GET /api/admin/brain/zones lists them; POST puts a source into one.
 *
 * Owner-only, by the default-deny rule rather than by anything written here:
 * deciding what counts as sensitive is the owner's judgement and nobody
 * else's.
 */
export async function handleZones(env, request) {
  if (request.method === "POST") {
    const payload = await body(request);
    const source = String(payload?.source || "").trim();
    const zone = String(payload?.zone || "").trim();
    if (!source || !zone) return jsonResponse({ error: "source and zone are both required" }, 400);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(zone)) {
      return jsonResponse({
        error: "a zone name is lowercase letters, digits, dash and underscore, up to 64 characters",
      }, 400);
    }
    return jsonResponse(await assignZone(env, { source, zone }));
  }
  return jsonResponse({ zones: await listZones(env) });
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
  if (path === "/app" && request.method === "GET") {
    return new Response(appPageHtml(env), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The page is self-contained by construction; the CSP makes that a
        // promise instead of a habit. Inline script is the page itself.
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
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
    const viaSession = Boolean(await readSessionCookie(request, env, await sessionGeneration(env)));
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
    // Who is authorizing this device, and therefore whose device it becomes.
    //
    // Enrollment is allowed either by an invite code or by an already
    // signed-in session ("add one more device from this one"). Both paths have
    // to answer the same question, because a device that ends up belonging to
    // nobody is read as the owner's, and then anyone holding a scoped passkey
    // could enroll a second device with no code and walk out with the whole
    // corpus in three requests.
    const session = await readSessionCookie(request, env, await sessionGeneration(env));
    const challenge = challengeFromClientData(payload.clientDataJSON);
    if (!challenge || !(await consumeChallenge(env, challenge, "register"))) {
      return jsonResponse({ error: "unknown or expired challenge" }, 403);
    }
    let grantId;
    if (session) {
      // A device added from a signed-in device inherits that session exactly.
      // It can never widen: an owner session yields an owner device, a scoped
      // session yields another device with the same grant.
      grantId = session.grantId;
    } else {
      const code = String(payload.code || "");
      const invite = await consumeEnrollmentCode(env, code);
      if (!invite) {
        return jsonResponse({ error: "the enrollment link is invalid, expired, or already used" }, 403);
      }
      grantId = invite.grant_id ?? null;
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
    await storePasskey(env, { ...verified, nickname: String(payload.nickname || "").slice(0, 60), grantId });
    const cookie = await mintSessionCookie(env, await sessionGeneration(env), { grantId });
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
    // The session is whoever this DEVICE belongs to. A device enrolled against
    // a grant must never mint an owner session.
    const cookie = await mintSessionCookie(env, await sessionGeneration(env), { grantId: credential.grant_id ?? null });
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
