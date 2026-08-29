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

import { listConnections, revokeConnection } from "./connections.js";
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
  issueRecoveryCodes, recoveryCodeStatus, peekRecoveryCode, consumeRecoveryCode,
  normalizeRecoveryCode, recoveryThrottle, recordRecoveryFailure, clearRecoveryFailures,
  RECOVERY_FAIL_LIMIT, RECOVERY_UNAVAILABLE,
  randomToken, createGrant, addGrantCredential, listGrants, revokeGrant,
  assignZone, listZones, findGrantById,
} from "./auth-store.js";
import {
  CAPABILITIES, OWNER_CAPABILITIES, parseCapabilities, parseScope, grantIsLive, hashToken,
} from "./grants.js";
import { appPageHtml, brandOgSvg } from "./app-page.js";
import { recoveryPageHtml } from "./recovery-page.js";
import { APP_JS, APP_CSS } from "./app-assets.js";

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

/**
 * The principal behind a passkey session, not merely "is there one".
 *
 * The cookie has carried its subject since schema 15, and the gate was reading
 * it through a boolean, so a person signed in with a SCOPED passkey was served
 * as the unscoped owner. Reads were correctly scoped for the same person using
 * a token and unscoped for them using their face, which is the worst possible
 * combination: the guarantee looked true wherever it was tested.
 *
 * Returns null when there is no valid session. A session naming no grant is
 * the owner, and that is safe here for a reason that will stop being true if
 * anyone changes it: v1 cookies predate anybody but the owner being able to
 * sign in at all.
 */
export async function ownerSessionPrincipal(request, env) {
  if (!appRequest(request)) return null;
  const session = await readSessionCookie(request, env, await sessionGeneration(env));
  if (!session) return null;
  if (session.grantId === null) {
    return { kind: "owner", grantId: null, capabilities: new Set(OWNER_CAPABILITIES), scope: { all: true } };
  }
  const row = await findGrantById(env, session.grantId);
  if (!grantIsLive(row)) return null;
  const capabilities = parseCapabilities(row.capabilities);
  if (!capabilities) return null;
  return {
    kind: "grant",
    grantId: row.grant_id,
    capabilities: new Set(capabilities),
    scope: parseScope(row),
  };
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
  // The escape hatch for an owner with no working device. It is a separate
  // route because the React app at /app has no recovery screen and cannot get
  // one without a frontend build; see worker/src/lib/recovery-page.js. Its CSP
  // is the one the page was reviewed under — a single inline script, no
  // network origin but this one — and NOT the stricter /app policy below,
  // which assumes an external bundle this page deliberately does not have.
  if (path === "/app/recover" && request.method === "GET") {
    return new Response(recoveryPageHtml(env), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
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
    const firstEver = (await listPasskeys(env)).length === 0;
    await storePasskey(env, { ...verified, nickname: String(payload.nickname || "").slice(0, 60), grantId });
    // The card is minted on the enrolment that creates the FIRST passkey,
    // which is the install ceremony — the one moment the owner is paying
    // attention to setup and someone is there to say "keep these". Minting it
    // later, on the day it is needed, is not a thing that can work.
    const recoveryCodes = firstEver && (await recoveryCodeStatus(env)).available
      ? await issueRecoveryCodes(env)
      : null;
    const cookie = await mintSessionCookie(env, await sessionGeneration(env), { grantId });
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
    const brakeResponse = () => jsonResponse({
      error: `Too many failed recovery attempts (${brake.failures} in the last hour). ` +
        "Wait an hour and try again, or use your admin key from the handoff notes to mint a fresh enrollment link.",
      retry_after_ms: brake.retry_after_ms,
    }, 429);

    if (path === "/auth/recover/options") {
      // The code is peeked BEFORE the brake is consulted, and the order is the
      // whole point. Checking the brake first meant ten garbage POSTs from
      // anyone on the internet shut the recovery lane for an hour, and
      // clearRecoveryFailures, which exists precisely so a live code reopens
      // it, sat unreachable behind the lock. The person that stranded is the
      // one holding a real card, at the moment they have already lost their
      // phone, and the card is supposed to BE the non-technical way back.
      //
      // Brute force is not helped by this. A wrong guess still records a
      // failure and still meets the lock below, so guessing is throttled
      // exactly as before; only a caller who already holds a live code walks
      // past, and that caller has, by definition, finished guessing.
      const live = code ? await peekRecoveryCode(env, code) : false;
      if (!live) {
        if (brake.locked) return brakeResponse();
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

    // The verify leg keeps the brake ahead of everything: reaching it requires
    // having already passed options with a live code, so a locked brake here
    // means repeated failures AFTER that, which is worth stopping.
    if (brake.locked) return brakeResponse();

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
      // Recovery restores the OWNER. A recovery code is the owner's own card,
      // so the passkey it authorises is the owner's passkey; null is the owner
      // sentinel here exactly as it is for the session minted just below.
      // Anything narrower would be a silent downgrade of their own access, on
      // the one day they have no other way in.
      grantId: null,
    });
    // Recovery is the moment to assume the lost device was not merely lost.
    // Bumping the generation kills every session cookie minted before now,
    // including one live on a phone somebody else is holding.
    const generation = await bumpSessionGeneration(env);
    const cookie = await mintSessionCookie(env, generation, { grantId: null });
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
    // The session is whoever this DEVICE belongs to. A device enrolled against
    // a grant must never mint an owner session.
    const cookie = await mintSessionCookie(env, await sessionGeneration(env), { grantId: credential.grant_id ?? null });
    return withCookie(jsonResponse({ signed_in: true }), cookie);
  }

  // Everything below requires a live session, and needs to know WHOSE.
  //
  // These routes used to act on any credential_id a caller named, and /me
  // listed every device on the brain. So anyone the owner had given a scoped
  // passkey could enumerate the owner's devices, rename them, revoke them, and
  // sign the owner out of their own brain. None of that reads a document,
  // which is why it survived the read-side review.
  const me = await ownerSessionPrincipal(request, env);
  if (!me) return jsonResponse({ error: "unauthorized" }, 401);
  const isOwner = me.kind === "owner";
  // A device belongs to the caller when it carries the same grant. The owner's
  // own devices carry no grant, so an unscoped session sees everything and a
  // scoped session sees only its own.
  const ownsDevice = async (credentialId) => {
    if (isOwner) return true;
    const device = await findPasskey(env, credentialId);
    return !!device && device.grant_id === me.grantId;
  };

  if (path === "/api/app/me") {
    // The card's state travels with every page load, because an install that
    // predates migration 0019 has no codes at all and its owner must be told
    // that in the place they already look, not in a document they were sent.
    return jsonResponse({
      signed_in: true,
      brain: env.BRAIN_NAME || "brain",
      owner: env.BRAIN_OWNER || "owner",
      // Scoped callers see only the devices carrying their own grant. Left
      // unfiltered this listed every device on the brain, which let anyone
      // holding a scoped passkey enumerate, rename and revoke the owner's
      // devices down to the last one.
      devices: isOwner
        ? await listPasskeys(env)
        : (await listPasskeys(env)).filter((d) => d.grant_id === me.grantId),
      // The same reasoning extends to these two, which carry no document text
      // and so survived the same review that missed `devices`. How many
      // recovery codes remain is the state of the OWNER's card, and the
      // connected apps are the apps the OWNER authorised; neither is a scoped
      // person's business, and the recovery count in particular tells them how
      // close the owner is to having no way back in.
      ...(isOwner
        ? {
            recovery: await recoveryCodeStatus(env),
            // Apps reaching the brain over the connector, so one call answers
            // the whole of "who has access" rather than two that can disagree.
            connections: await listConnections(env),
          }
        : {}),
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
    if (!(await ownsDevice(String(payload.credential_id)))) {
      return jsonResponse({ error: "that is not one of your devices" }, 403);
    }
    await renamePasskey(env, String(payload.credential_id), payload.nickname);
    return jsonResponse({ renamed: true });
  }
  if (path === "/api/app/devices/revoke") {
    const payload = await body(request);
    if (!payload?.credential_id) return jsonResponse({ error: "credential_id required" }, 400);
    if (!(await ownsDevice(String(payload.credential_id)))) {
      return jsonResponse({ error: "that is not one of your devices" }, 403);
    }
    return jsonResponse(await revokePasskey(env, String(payload.credential_id)));
  }
  if (path === "/api/app/connections/revoke") {
    const payload = await body(request);
    if (!payload?.client_id) return jsonResponse({ error: "client_id required" }, 400);
    const outcome = await revokeConnection(env, payload.client_id);
    return jsonResponse({ ...outcome, connections: await listConnections(env) });
  }
  if (path === "/api/app/signout") {
    return withCookie(jsonResponse({ signed_out: true }), clearSessionCookie());
  }
  if (path === "/api/app/signout-all") {
    // Signing out EVERYONE is the owner's lever. A scoped person signing out
    // their own device uses /signout, which needs no privilege at all.
    if (!isOwner) return jsonResponse({ error: "only the owner can sign every device out" }, 403);
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
