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
  issueRecoveryCodes, recoveryCodeStatus, peekRecoveryCode, consumeRecoveryCode,
  normalizeRecoveryCode, recoveryThrottle, recordRecoveryFailure, clearRecoveryFailures,
  RECOVERY_FAIL_LIMIT, RECOVERY_UNAVAILABLE,
} from "./auth-store.js";
import { appPageHtml } from "./app-page.js";

const APP_HEADER = "X-Brain-App";

/**
 * The honest end of the road, stated once and reused everywhere it is true.
 *
 * It names the limit rather than implying total safety, because a person
 * reading it is deciding what to do next and a comforting sentence would send
 * them looking for a door that does not exist. It also declines to pretend the
 * installer can help: after handoff they hold no credential to this account,
 * by design and by the client's own rotation of the admin key.
 *
 * It DOES disclose that no unused codes remain, which a stranger could learn
 * by trying. That trade is deliberate: the disclosure buys an attacker nothing
 * (there is no code to guess at, and the passkeys are unaffected) and buys the
 * owner the one thing that matters — knowing to stop hunting for a card and go
 * to their Cloudflare account instead.
 */
export const NO_WAY_BACK =
  "No recovery code matched, and this brain has no unused recovery codes left. " +
  "If every enrolled device and every recovery code is gone, nobody can open this page for you " +
  "— not whoever installed it, and not us. Nothing is lost: your material is still in your own " +
  "Cloudflare account. Sign in there and follow \"If every device and every code is gone\" in " +
  "your handoff notes.";

const RECOVERY_CODE_MISMATCH =
  "That recovery code did not match. Check it for a typo, or try another code from your card.";

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
 * POST /api/admin/auth/recovery-codes — print a fresh card. Admin key.
 *
 * This adds no power to the admin key: that key can already mint an invite
 * that enrolls a device, so it could already reach /app. What it adds is a
 * way for the operator to hand the codes over IN THE ROOM at install, and a
 * way for an owner who still has their device to replace a card they think
 * was photographed.
 */
export async function handleAdminRecoveryCodes(env) {
  if (!(await recoveryCodeStatus(env)).available) {
    return jsonResponse({ error: RECOVERY_UNAVAILABLE }, 503);
  }
  const codes = await issueRecoveryCodes(env);
  return jsonResponse({
    recovery_codes: codes,
    note: "shown once. Every previously unused code is now dead. Store these where a house key would live, not in the same place as the device.",
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
    const firstEver = (await listPasskeys(env)).length === 0;
    await storePasskey(env, { ...verified, nickname: String(payload.nickname || "").slice(0, 60) });
    // The card is minted on the enrolment that creates the FIRST passkey,
    // which is the install ceremony — the one moment the owner is paying
    // attention to setup and someone is there to say "keep these". Minting it
    // later, on the day it is needed, is not a thing that can work.
    const recoveryCodes = firstEver && (await recoveryCodeStatus(env)).available
      ? await issueRecoveryCodes(env)
      : null;
    const cookie = await mintSessionCookie(env, await sessionGeneration(env));
    return withCookie(jsonResponse({
      enrolled: true,
      credential_id: verified.credentialId,
      ...(recoveryCodes ? { recovery_codes: recoveryCodes } : {}),
    }), cookie);
  }

  /* ------------------------------------------------------------- recovery */

  /**
   * Every enrolled device is gone. A recovery code buys exactly one thing: the
   * right to run a REGISTRATION, right now, with user verification, on a device
   * the person is physically holding. It does not sign anyone in by itself and
   * it never becomes a session on its own — the session at the end is earned by
   * the new passkey, and is the same read-only privilege class as any other.
   *
   * So this is not a second, weaker door. It is the same door, opened with a
   * one-time key that can only be used to cut a new key.
   */
  if (path === "/auth/recover/options" || path === "/auth/recover/verify") {
    const payload = await body(request);
    const code = normalizeRecoveryCode(payload?.code);
    // An install whose Worker is newer than its migrations has no card. Say
    // that, with the command that fixes it, rather than throwing SQL at
    // somebody who has just lost their phone.
    if (!(await recoveryCodeStatus(env)).available) {
      return jsonResponse({ error: RECOVERY_UNAVAILABLE, unrecoverable: false }, 503);
    }
    const brake = await recoveryThrottle(env);
    if (brake.locked) {
      return jsonResponse({
        error: `Too many failed recovery attempts (${brake.failures} in the last hour). ` +
          "Wait an hour and try again, or use your admin key from the handoff notes to mint a fresh enrollment link.",
        retry_after_ms: brake.retry_after_ms,
      }, 429);
    }

    if (path === "/auth/recover/options") {
      if (!code || !(await peekRecoveryCode(env, code))) {
        await recordRecoveryFailure(env);
        const { unused } = await recoveryCodeStatus(env);
        return jsonResponse({
          error: unused > 0 ? RECOVERY_CODE_MISMATCH : NO_WAY_BACK,
          unrecoverable: unused === 0,
          attempts_remaining: Math.max(0, RECOVERY_FAIL_LIMIT - (brake.failures + 1)),
        }, 403);
      }
      // Knowing a live code is proof enough to clear the brake, so an owner
      // who mistyped four times is not locked out of their own recovery.
      await clearRecoveryFailures(env);
      const challenge = await issueChallenge(env, "register");
      return jsonResponse({
        challenge,
        rp: { id: rpId, name: env.BRAIN_NAME || "brain" },
        user_name: env.BRAIN_OWNER || "owner",
      });
    }

    if (!payload) return jsonResponse({ error: "invalid body" }, 400);
    const challenge = challengeFromClientData(payload.clientDataJSON);
    if (!challenge || !(await consumeChallenge(env, challenge, "register"))) {
      return jsonResponse({ error: "unknown or expired challenge" }, 403);
    }
    // ORDER MATTERS, and it is this way round on purpose. The ceremony is
    // verified FIRST, and only a ceremony that passed every check spends a
    // code. An authenticator that refuses user verification, or a browser that
    // hands back something malformed, otherwise burns one code per attempt and
    // an owner can lose their whole card to five taps that never worked.
    // Single use is not weakened by the order: `consumeRecoveryCode` is the
    // atomic gate immediately before the passkey is stored, so two tabs racing
    // one code still produce exactly one new passkey.
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
    if (!(await consumeRecoveryCode(env, code, "device recovery"))) {
      await recordRecoveryFailure(env);
      const { unused } = await recoveryCodeStatus(env);
      return jsonResponse({
        error: unused > 0 ? RECOVERY_CODE_MISMATCH : NO_WAY_BACK,
        unrecoverable: unused === 0,
      }, 403);
    }
    // A recovered device is labelled as one, so the new row is legible in
    // Settings rather than blending in with devices the owner enrolled.
    const label = `recovered ${new Date().toISOString().slice(0, 10)}`;
    await storePasskey(env, {
      ...verified,
      nickname: `${String(payload.nickname || "device").slice(0, 40)} · ${label}`,
    });
    // Recovery is the moment to assume the lost device was not merely lost.
    // Bumping the generation kills every session cookie minted before now,
    // including one live on a phone somebody else is holding.
    const generation = await bumpSessionGeneration(env);
    const cookie = await mintSessionCookie(env, generation);
    const { unused } = await recoveryCodeStatus(env);
    return withCookie(jsonResponse({
      recovered: true,
      credential_id: verified.credentialId,
      codes_remaining: unused,
    }), cookie);
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
    // The card's state travels with every page load, because an install that
    // predates migration 0019 has no codes at all and its owner must be told
    // that in the place they already look, not in a document they were sent.
    return jsonResponse({
      signed_in: true,
      brain: env.BRAIN_NAME || "brain",
      owner: env.BRAIN_OWNER || "owner",
      devices: await listPasskeys(env),
      recovery: await recoveryCodeStatus(env),
    });
  }
  if (path === "/api/app/recovery-codes") {
    // Requires a live session, which requires a passkey. Codes can only be
    // printed by someone who is already in — never as a step toward getting in.
    if (!(await recoveryCodeStatus(env)).available) {
      return jsonResponse({ error: RECOVERY_UNAVAILABLE }, 503);
    }
    const codes = await issueRecoveryCodes(env);
    return jsonResponse({ recovery_codes: codes });
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
