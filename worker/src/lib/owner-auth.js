/**
 * owner-auth — the passkey routes and the session privilege class.
 *
 * Everything here serves the OWNER surface (/app): enrollment gated by a
 * single-use invite code or an existing session, sign-in by passkey
 * assertion, and a small device-management API. These routes sit in front of
 * the key gate because their auth IS the ceremony or the session cookie a
 * ceremony earned. That owner principal also reaches guarded owner writes such
 * as document upload elsewhere in the router. It never bypasses /api/admin
 * routes, and destructive corpus execution requires a fresh passkey ceremony.
 *
 * CSRF: session-authenticated requests must carry `X-Brain-App: 1` on top of
 * the SameSite=Strict cookie. Both are set only by the app page itself.
 */

import { listConnections, revokeConnection } from "./connections.js";
import { ownerSystemStatus } from "./system-status.js";
import { diagnose, freshnessReport, vectorReadiness } from "./store-d1.js";
import { jsonResponse, validateAdminKey } from "./core.js";
import { verifyRegistration, verifyAssertion, b64uDecode } from "./webauthn.js";
import {
  mintSessionCookie, readSessionCookie, clearSessionCookie, credentialMatchesSessionRef,
} from "./sessions.js";
import {
  issueChallenge, peekChallenge, consumeChallenge,
  issueEnrollmentCode, peekEnrollmentCode, consumeEnrollmentCode,
  storePasskey, findPasskey, recordPasskeyUse,
  listPasskeys, renamePasskey, revokePasskey,
  sessionGeneration, bumpSessionGeneration,
  recordPasskeySecurityEvent, passkeySecurityStatus,
  randomToken, createGrant, addGrantCredential, listGrants, revokeGrant,
  assignZone, listZones, findGrantById,
} from "./auth-store.js";
import {
  CAPABILITIES, OWNER_CAPABILITIES, parseCapabilities, parseScope, grantIsLive, hashToken,
} from "./grants.js";
import {
  createDocumentGrant, revokeDocumentGrant, reissueDocumentGrantInvite,
  listDocumentGrants, listGrantedDocuments, documentGrantPrincipal,
  DocumentAccessError, DocumentAccessUnavailableError,
} from "./document-access.js";
import { appPageHtml, brandOgSvg } from "./app-page.js";
import { APP_JS, APP_CSS } from "./app-assets.js";
import {
  createSupportSession, listSupportSessions, reissueSupportInvite,
  revokeSupportSession, SupportAccessError,
} from "./support-access.js";
import { readUpdateStatus } from "./update-status.js";

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
  const principal = await ownerSessionPrincipal(request, env);
  return principal !== null && principal.denied !== true;
}

async function resolveOwnerSessionPrincipal(request, env, { requireAppHeader = true } = {}) {
  if (requireAppHeader && !appRequest(request)) return null;
  const session = await readSessionCookie(request, env, await sessionGeneration(env));
  if (!session) return null;
  const devices = await listPasskeys(env);
  let sessionDevice = null;
  for (const device of devices) {
    if (await credentialMatchesSessionRef(env, device.credential_id, session.credentialRef)) {
      sessionDevice = device;
      break;
    }
  }
  if (!sessionDevice) return null;
  const deviceGrantId = sessionDevice.document_grant_id ?? sessionDevice.grant_id ?? null;
  if (deviceGrantId !== session.grantId) return null;
  if (session.grantId === null) {
    return {
      kind: "owner",
      grantId: null,
      capabilities: new Set(OWNER_CAPABILITIES),
      scope: { all: true },
    };
  }
  return grantSubjectPrincipal(env, session.grantId);
}

/**
 * Resolve who is behind the passkey session instead of flattening identity to
 * a boolean. Owner-write routes must use this function and require kind=owner
 * plus grantId=null. That positive check remains fail-closed when scoped
 * passkeys are added later.
 */
export async function ownerSessionPrincipal(request, env) {
  return resolveOwnerSessionPrincipal(request, env, { requireAppHeader: true });
}

/**
 * Resolve a passkey session for a read-only top-level page navigation.
 *
 * Browsers cannot attach X-Brain-App to an address-bar navigation. This seam
 * is therefore limited to GET page handlers. Every API read and write must
 * continue to use ownerSessionPrincipal so the companion CSRF header remains
 * mandatory.
 */
export async function ownerNavigationPrincipal(request, env) {
  if (request.method !== "GET") return null;
  return resolveOwnerSessionPrincipal(request, env, { requireAppHeader: false });
}

async function grantSubjectPrincipal(env, grantId) {
  if (String(grantId).startsWith("dg_")) {
    const principal = await documentGrantPrincipal(env, grantId);
    return principal.denied
      ? { kind: "grant", grantType: "document", grantId, denied: true, code: principal.code }
      : { ...principal, grantType: "document" };
  }
  const row = await findGrantById(env, grantId);
  if (!grantIsLive(row)) {
    return { kind: "grant", grantType: "capability", grantId, denied: true, code: "grant_inactive" };
  }
  const capabilities = parseCapabilities(row.capabilities);
  if (!capabilities) {
    return { kind: "grant", grantType: "capability", grantId, denied: true, code: "grant_invalid" };
  }
  return {
    kind: "grant",
    grantType: "capability",
    grantId: row.grant_id,
    capabilities: new Set(capabilities),
    scope: parseScope(row),
  };
}

function grantStorage(grantId) {
  if (!grantId) return { grantId: null, documentGrantId: null };
  return String(grantId).startsWith("dg_")
    ? { grantId: null, documentGrantId: grantId }
    : { grantId, documentGrantId: null };
}

function ownerRequired(principal) {
  return principal?.kind === "owner" && principal.grantId === null;
}

function scopedForbidden() {
  return jsonResponse({ error: "forbidden", code: "owner_required" }, 403);
}

function unavailable(code) {
  return jsonResponse({ error: "unavailable", code }, 503);
}

function documentAccessErrorResponse(error) {
  const labels = {
    400: "invalid_request",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    413: "too_large",
    503: "unavailable",
  };
  return jsonResponse({
    error: labels[error.status] || "invalid_request",
    code: error.code,
    detail: error.message,
  }, error.status);
}

function supportAccessErrorResponse(error) {
  const status = error instanceof SupportAccessError ? error.status : 503;
  const code = error instanceof SupportAccessError ? error.code : "support_access_unavailable";
  const label = status === 400 ? "invalid_request"
    : status === 403 ? "forbidden"
      : status === 404 ? "not_found"
        : status === 409 ? "conflict"
          : "unavailable";
  return jsonResponse({ error: label, code }, status);
}

async function observePasskey(env, event) {
  try {
    await recordPasskeySecurityEvent(env, event);
    return null;
  } catch {
    return unavailable("passkey_observability_unavailable");
  }
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
    if (capabilities.includes("administer")) {
      return jsonResponse({
        error: "administer cannot be granted because it would let this person manage other people's access",
      }, 400);
    }
    const expiresAt = payload?.expires_at === undefined || payload?.expires_at === null
      ? null
      : Number(payload.expires_at);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return jsonResponse({ error: "expires_at must be a future unix ms timestamp, or null" }, 400);
    }
    const zones = Array.isArray(payload?.zones)
      ? payload.zones.map((zone) => String(zone).trim()).filter(Boolean)
      : null;
    const exclude = Array.isArray(payload?.exclude_zones)
      ? payload.exclude_zones.map((zone) => String(zone).trim()).filter(Boolean)
      : [];
    if (zones && zones.length === 0) {
      return jsonResponse({ error: "zones was given but empty; omit it to mean every zone" }, 400);
    }
    const grantId = `g_${randomToken(8)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const token = randomToken(32);
    await createGrant(env, {
      grantId,
      displayName: displayName.slice(0, 120),
      relationship: payload?.relationship ? String(payload.relationship).slice(0, 120) : null,
      capabilities,
      expiresAt,
      createdBy: "owner",
      scopeInclude: zones ? JSON.stringify({ zones }) : '{"all":true}',
      scopeExclude: JSON.stringify(exclude),
    });
    await addGrantCredential(env, { tokenHash: await hashToken(token), grantId });
    return jsonResponse({
      grant_id: grantId,
      display_name: displayName,
      capabilities,
      expires_at: expiresAt,
      zones: zones || "all",
      token,
      note: "This token is shown once and is not recoverable. Share it over a channel you trust.",
    });
  }
  return jsonResponse({ grants: await listGrants(env) });
}

export async function handleZones(env, request) {
  if (request.method === "POST") {
    const payload = await body(request);
    const source = String(payload?.source || "").trim();
    const zone = String(payload?.zone || "").trim();
    if (!source || !zone) return jsonResponse({ error: "source and zone are both required" }, 400);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(zone)) {
      return jsonResponse({
        error: "a zone name uses lowercase letters, digits, dashes or underscores, up to 64 characters",
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

export async function handleOwnerAuth(env, request, url, path, options = {}) {
  const requestStartedAt = Date.now();
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
    let viaSession;
    try {
      viaSession = await ownerSessionPrincipal(request, env);
    } catch {
      return unavailable("owner_auth_unavailable");
    }
    if (viaSession?.denied) return scopedForbidden();
    let invitation = null;
    if (!viaSession) {
      const code = String(payload?.code || "");
      try {
        invitation = code ? await peekEnrollmentCode(env, code) : null;
      } catch {
        return unavailable("passkey_auth_unavailable");
      }
      if (!invitation) {
        const telemetryError = await observePasskey(env, {
          rpId, ceremony: "registration", stage: "options", outcome: "forbidden",
          reasonCode: "enrollment_required", durationMs: Date.now() - requestStartedAt, principalKind: "unknown",
        });
        if (telemetryError) return telemetryError;
        return jsonResponse({ error: "a valid enrollment link is required" }, 403);
      }
    }
    const grantId = viaSession?.grantId ?? invitation?.documentGrantId ?? invitation?.grantId ?? null;
    const telemetryError = await observePasskey(env, {
      rpId, ceremony: "registration", stage: "options", outcome: "started",
      reasonCode: "challenge_issued", durationMs: Date.now() - requestStartedAt,
      principalKind: grantId ? "grant" : "owner", grantId,
    });
    if (telemetryError) return telemetryError;
    let challenge;
    try {
      challenge = await issueChallenge(env, "register");
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    return jsonResponse({
      challenge,
      rp: { id: rpId, name: env.BRAIN_NAME || "brain" },
      user_name: grantId ? "shared document access" : env.BRAIN_OWNER || "owner",
    });
  }

  if (path === "/auth/register/verify") {
    const payload = await body(request);
    if (!payload) return jsonResponse({ error: "invalid body" }, 400);
    let viaSession;
    try {
      viaSession = await ownerSessionPrincipal(request, env);
    } catch {
      return unavailable("owner_auth_unavailable");
    }
    if (viaSession?.denied) return scopedForbidden();
    const challenge = challengeFromClientData(payload.clientDataJSON);
    let challengeLive = false;
    try {
      challengeLive = challenge ? await peekChallenge(env, challenge, "register") : false;
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    if (!challengeLive) {
      const telemetryError = await observePasskey(env, {
        rpId, ceremony: "registration", stage: "verify", outcome: "forbidden",
        reasonCode: "challenge_invalid", durationMs: Date.now() - requestStartedAt,
        principalKind: viaSession?.kind || "unknown",
        grantId: viaSession?.grantId || null,
      });
      if (telemetryError) return telemetryError;
      return jsonResponse({ error: "unknown or expired challenge" }, 403);
    }
    let invitation = null;
    if (!viaSession) {
      try {
        invitation = await peekEnrollmentCode(env, String(payload.code || ""));
      } catch {
        return unavailable("passkey_auth_unavailable");
      }
      if (!invitation) {
        const telemetryError = await observePasskey(env, {
          rpId, ceremony: "registration", stage: "verify", outcome: "forbidden",
          reasonCode: "enrollment_invalid", durationMs: Date.now() - requestStartedAt, principalKind: "unknown",
        });
        if (telemetryError) return telemetryError;
        return jsonResponse({ error: "the enrollment link is invalid, expired, or already used" }, 403);
      }
    }
    const grantId = viaSession?.grantId ?? invitation?.documentGrantId ?? invitation?.grantId ?? null;
    let grantEntitySlug = null;
    if (grantId) {
      let scoped;
      try {
        scoped = await grantSubjectPrincipal(env, grantId);
      } catch {
        return unavailable("grant_access_unavailable");
      }
      if (scoped.denied) {
        const telemetryError = await observePasskey(env, {
          rpId, ceremony: "registration", stage: "verify", outcome: "forbidden",
          reasonCode: scoped.code, durationMs: Date.now() - requestStartedAt, principalKind: "grant", grantId,
        });
        if (telemetryError) return telemetryError;
        return scopedForbidden();
      }
      grantEntitySlug = scoped.grantType === "document" ? scoped.entitySlug || null : null;
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
      const telemetryError = await observePasskey(env, {
        rpId, ceremony: "registration", stage: "verify", outcome: "failed",
        reasonCode: "webauthn_verification_failed", durationMs: Date.now() - requestStartedAt,
        principalKind: grantId ? "grant" : "owner", grantId,
      });
      if (telemetryError) return telemetryError;
      return jsonResponse({ error: String(error?.message || error) }, 400);
    }
    // Neither the challenge nor invite is burned by a failed authenticator
    // gesture. After cryptographic verification, each conditional mutation is
    // the single-use decision. Concurrent valid ceremonies can reach here,
    // but exactly one can consume each row.
    try {
      if (!(await consumeChallenge(env, challenge, "register"))) {
        return jsonResponse({ error: "unknown, expired, or already used challenge" }, 403);
      }
      if (!viaSession) {
        const consumed = await consumeEnrollmentCode(env, String(payload.code || ""));
        if (!consumed) {
          const telemetryError = await observePasskey(env, {
            rpId, ceremony: "registration", stage: "verify", outcome: "forbidden",
            reasonCode: "enrollment_invalid", durationMs: Date.now() - requestStartedAt,
            principalKind: "unknown",
          });
          if (telemetryError) return telemetryError;
          return jsonResponse({ error: "the enrollment link is invalid, expired, or already used" }, 403);
        }
        if (consumed.grantId !== invitation.grantId ||
            consumed.documentGrantId !== invitation.documentGrantId) {
          return unavailable("passkey_auth_unavailable");
        }
      }
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    try {
      await storePasskey(env, {
        ...verified,
        nickname: String(payload.nickname || "").slice(0, 60),
        ...grantStorage(grantId),
        securityEvent: {
          rpId, ceremony: "registration", stage: "verify", outcome: "succeeded",
          reasonCode: "passkey_added", durationMs: Date.now() - requestStartedAt,
          principalKind: grantId ? "grant" : "owner", grantId,
        },
        ownerActivity: {
          entitySlug: grantEntitySlug,
          displayLabel: grantId ? "Shared access passkey" : "Passkey device",
        },
      });
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    const cookie = await mintSessionCookie(env, await sessionGeneration(env), {
      grantId, credentialId: verified.credentialId,
    });
    return withCookie(jsonResponse({ enrolled: true, credential_id: verified.credentialId }), cookie);
  }

  if (path === "/auth/login/options") {
    const telemetryError = await observePasskey(env, {
      rpId, ceremony: "authentication", stage: "options", outcome: "started",
      reasonCode: "challenge_issued", durationMs: Date.now() - requestStartedAt, principalKind: "unknown",
    });
    if (telemetryError) return telemetryError;
    let challenge;
    try {
      challenge = await issueChallenge(env, "login");
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    return jsonResponse({ challenge, rp_id: rpId });
  }

  if (path === "/auth/login/verify") {
    const payload = await body(request);
    if (!payload) return jsonResponse({ error: "invalid body" }, 400);
    const challenge = challengeFromClientData(payload.clientDataJSON);
    let challengeLive = false;
    try {
      challengeLive = challenge ? await peekChallenge(env, challenge, "login") : false;
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    if (!challengeLive) {
      const telemetryError = await observePasskey(env, {
        rpId, ceremony: "authentication", stage: "verify", outcome: "forbidden",
        reasonCode: "challenge_invalid", durationMs: Date.now() - requestStartedAt, principalKind: "unknown",
      });
      if (telemetryError) return telemetryError;
      return jsonResponse({ error: "unknown or expired challenge" }, 403);
    }
    const credential = await findPasskey(env, String(payload.credentialId || ""));
    if (!credential) {
      const telemetryError = await observePasskey(env, {
        rpId, ceremony: "authentication", stage: "verify", outcome: "forbidden",
        reasonCode: "passkey_unknown", durationMs: Date.now() - requestStartedAt, principalKind: "unknown",
      });
      if (telemetryError) return telemetryError;
      return jsonResponse({ error: "unknown passkey" }, 403);
    }
    const grantId = credential.document_grant_id ?? credential.grant_id ?? null;
    if (grantId) {
      let scoped;
      try {
        scoped = await grantSubjectPrincipal(env, grantId);
      } catch {
        return unavailable("grant_access_unavailable");
      }
      if (scoped.denied) {
        const telemetryError = await observePasskey(env, {
          rpId, ceremony: "authentication", stage: "verify", outcome: "forbidden",
          reasonCode: scoped.code, durationMs: Date.now() - requestStartedAt, principalKind: "grant", grantId,
        });
        if (telemetryError) return telemetryError;
        return scopedForbidden();
      }
    }
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
      const telemetryError = await observePasskey(env, {
        rpId, ceremony: "authentication", stage: "verify", outcome: "failed",
        reasonCode: "webauthn_verification_failed", durationMs: Date.now() - requestStartedAt,
        principalKind: grantId ? "grant" : "owner", grantId,
      });
      if (telemetryError) return telemetryError;
      return jsonResponse({ error: String(error?.message || error) }, 403);
    }
    if (verdict.cloneSuspected) {
      // A counter that failed to advance means two copies of a hardware-bound
      // credential exist. Refuse loudly; the owner revokes it from another
      // device or the operator does via the CLI.
      const telemetryError = await observePasskey(env, {
        rpId, ceremony: "authentication", stage: "verify", outcome: "forbidden",
        reasonCode: "counter_regressed", durationMs: Date.now() - requestStartedAt,
        principalKind: grantId ? "grant" : "owner", grantId,
      });
      if (telemetryError) return telemetryError;
      return jsonResponse({ error: "this passkey looks cloned (its counter went backwards); sign in from another device and revoke it" }, 403);
    }
    try {
      if (!(await consumeChallenge(env, challenge, "login"))) {
        return jsonResponse({ error: "unknown, expired, or already used challenge" }, 403);
      }
      const recorded = await recordPasskeyUse(
        env, credential.credential_id, Number(credential.sign_count || 0), verdict.signCount, {
        rpId, ceremony: "authentication", stage: "verify", outcome: "succeeded",
        reasonCode: "passkey_used", durationMs: Date.now() - requestStartedAt,
        principalKind: grantId ? "grant" : "owner", grantId,
        },
      );
      if (!recorded) {
        return jsonResponse({ error: "the passkey changed or was revoked; start sign-in again" }, 403);
      }
    } catch {
      return unavailable("passkey_auth_unavailable");
    }
    const cookie = await mintSessionCookie(env, await sessionGeneration(env), {
      grantId, credentialId: credential.credential_id,
    });
    return withCookie(jsonResponse({ signed_in: true }), cookie);
  }

  if (path === "/api/app/system") {
    // Owner session OR admin key. The admin key grants nothing extra here: it
    // can already read diagnose, freshness and vector readiness directly on
    // their own routes. Accepting it lets an operator answering "the client
    // says Home is broken" see exactly what the client sees, without asking
    // them to share a screen.
    let systemPrincipal = null;
    try {
      systemPrincipal = await ownerSessionPrincipal(request, env);
    } catch {
      return unavailable("owner_auth_unavailable");
    }
    if (!ownerRequired(systemPrincipal) && !validateAdminKey(request, env)) {
      if (systemPrincipal) return scopedForbidden();
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    // The owner's own view of their brain's condition, composed from reads
    // whose admin routes they deliberately cannot reach. See system-status.js
    // for what is withheld and why.
    return jsonResponse(await ownerSystemStatus(env, {
      health: (e) => {
        const paused = e.VECTOR_DRAIN_MODE === "paused-for-upgrade";
        return {
          status: paused ? "paused-for-upgrade" : "ok",
          accepting_documents: !paused,
          vector_drain_mode: paused ? "paused-for-upgrade" : "active",
        };
      },
      diagnose, freshness: freshnessReport, vectorReadiness,
    }));
  }

  // Everything below requires a live session.
  const supportAccessOwnerPath = path.startsWith("/api/app/support-access/");
  let principal;
  try {
    principal = await ownerSessionPrincipal(request, env);
  } catch {
    return unavailable("owner_auth_unavailable");
  }
  if (!principal) {
    return supportAccessOwnerPath
      ? jsonResponse({ error: "unauthorized", code: "session_required" }, 401)
      : jsonResponse({ error: "unauthorized" }, 401);
  }
  if (principal.denied) {
    return withCookie(jsonResponse({
      error: "forbidden",
      code: principal.code || "document_grant_inactive",
      signed_in: false,
      clear_session: true,
      recovery: "Ask the owner to create new document access and send a new enrollment link.",
    }, 403), clearSessionCookie());
  }

  // Device management is caller-scoped. A scoped passkey may see, rename, or
  // revoke only credentials issued to the same grant. Owner credentials carry
  // neither grant column, while the two supported grant systems deliberately
  // use separate columns so their identifiers cannot be confused.
  const isOwner = ownerRequired(principal);
  const deviceGrantId = (device) => device?.document_grant_id ?? device?.grant_id ?? null;
  const ownsDevice = async (credentialId) => {
    if (isOwner) return true;
    const device = await findPasskey(env, credentialId);
    return !!device && deviceGrantId(device) === principal.grantId;
  };

  if (path === "/api/app/me") {
    if (!ownerRequired(principal)) {
      if (principal.grantType === "capability") {
        return jsonResponse({
          signed_in: true,
          brain: env.BRAIN_NAME || "brain",
          principal: {
            kind: "grant",
            grant_id: principal.grantId,
            capabilities: [...principal.capabilities],
            scope: principal.scope,
          },
          workspace: {
            home: false,
            documents: false,
            ask: principal.capabilities.has("ask"),
            add_review: false,
            access: false,
            bank: false,
            targets: false,
            preferences: false,
          },
          devices: (await listPasskeys(env)).filter(
            (device) => deviceGrantId(device) === principal.grantId,
          ),
        });
      }
      return jsonResponse({
        signed_in: true,
        brain: env.BRAIN_NAME || "brain",
        principal: {
          kind: "grant",
          grant_id: principal.grantId,
          entity_slug: principal.entitySlug || null,
          document_count: principal.documentCount || 0,
          capabilities: ["documents:read", "ask"],
        },
        workspace: {
          home: false,
          documents: true,
          ask: true,
          add_review: false,
          access: false,
          bank: false,
          targets: false,
          preferences: false,
        },
        devices: (await listPasskeys(env)).filter(
          (device) => deviceGrantId(device) === principal.grantId,
        ),
      });
    }
    return jsonResponse({
      signed_in: true,
      brain: env.BRAIN_NAME || "brain",
      owner: env.BRAIN_OWNER || "owner",
      principal: { kind: "owner", grant_id: null },
      devices: await listPasskeys(env),
      // Apps reaching the brain over the connector, so one call answers the
      // whole of "who has access" rather than two that can disagree.
      connections: await listConnections(env),
    });
  }
  if (path === "/api/app/signout") {
    return withCookie(jsonResponse({ signed_out: true }), clearSessionCookie());
  }
  if (path === "/api/app/document-access/documents") {
    if (ownerRequired(principal) || principal.grantType !== "document") {
      return jsonResponse({
        error: "invalid_request",
        code: "scoped_principal_required",
        detail: "The owner document workspace uses the owner document route.",
      }, 400);
    }
    try {
      return jsonResponse(await listGrantedDocuments(env, principal));
    } catch (error) {
      if (error instanceof DocumentAccessError) return documentAccessErrorResponse(error);
      return unavailable("document_access_unavailable");
    }
  }
  if (path === "/api/app/devices/rename") {
    const payload = await body(request);
    if (!payload?.credential_id) return jsonResponse({ error: "credential_id required" }, 400);
    if (!(await ownsDevice(String(payload.credential_id)))) {
      return jsonResponse({ error: "that is not one of your devices" }, 403);
    }
    return jsonResponse(await renamePasskey(env, String(payload.credential_id), payload.nickname));
  }
  if (path === "/api/app/devices/revoke") {
    const payload = await body(request);
    if (!payload?.credential_id) return jsonResponse({ error: "credential_id required" }, 400);
    if (!(await ownsDevice(String(payload.credential_id)))) {
      return jsonResponse({ error: "that is not one of your devices" }, 403);
    }
    return jsonResponse(await revokePasskey(env, String(payload.credential_id)));
  }

  // Everything below changes owner state or exposes owner-wide diagnostics.
  // A scoped session may read only its exact granted documents and its own
  // minimal identity above. Unlisted future routes therefore fail owner-only.
  if (!ownerRequired(principal)) return scopedForbidden();

  // A rollback restores the database underneath the paused Worker. Support
  // authority is unavailable for that entire window, including owner reads,
  // so neither an old cookie nor a newly written invite can cross the restore.
  if (supportAccessOwnerPath && env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
    return unavailable("support_access_unavailable");
  }

  if (path === "/api/app/support-access/status") {
    try {
      return jsonResponse(await listSupportSessions(env));
    } catch (error) {
      return supportAccessErrorResponse(error);
    }
  }
  if (path === "/api/app/support-access/create") {
    const payload = await body(request);
    try {
      const { enrollment_url_code: code, ...receipt } = await createSupportSession(env, payload);
      return jsonResponse({
        ...receipt,
        enrollment_url: code ? `${url.origin}/app#support-enroll=${code}` : null,
      });
    } catch (error) {
      return supportAccessErrorResponse(error);
    }
  }
  if (path === "/api/app/support-access/reissue") {
    const payload = await body(request);
    try {
      const { enrollment_url_code: code, ...receipt } = await reissueSupportInvite(env, payload);
      return jsonResponse({
        ...receipt,
        enrollment_url: code ? `${url.origin}/app#support-enroll=${code}` : null,
      });
    } catch (error) {
      return supportAccessErrorResponse(error);
    }
  }
  if (path === "/api/app/support-access/revoke") {
    const payload = await body(request);
    try {
      return jsonResponse(await revokeSupportSession(env, payload));
    } catch (error) {
      return supportAccessErrorResponse(error);
    }
  }
  if (path === "/api/app/update-status") {
    const result = await readUpdateStatus({
      installedVersion: env.BRAIN_VERSION,
      fetchImpl: options.fetchImpl || fetch,
    });
    return jsonResponse(result, result.status === "unavailable" ? 503 : 200);
  }

  if (path === "/api/app/document-access/status") {
    try {
      return jsonResponse(await listDocumentGrants(env));
    } catch (error) {
      if (error instanceof DocumentAccessUnavailableError) return unavailable(error.code);
      throw error;
    }
  }
  if (path === "/api/app/document-access/create") {
    const payload = await body(request);
    try {
      const result = await createDocumentGrant(env, payload);
      const { enrollment_code: code, replayed, ...grant } = result;
      return jsonResponse({
        ...grant,
        replayed,
        enrollment_url: code ? `${url.origin}/app#enroll=${code}` : null,
        enrollment_expires_in_minutes: code ? 15 : null,
        scope_rule: "exact_document_ids_only",
      });
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return documentAccessErrorResponse(error);
      }
      return unavailable("document_access_unavailable");
    }
  }
  if (path === "/api/app/document-access/reissue") {
    const payload = await body(request);
    try {
      const result = await reissueDocumentGrantInvite(env, payload);
      const { enrollment_code: code, ...receipt } = result;
      return jsonResponse({
        ...receipt,
        enrollment_url: code ? `${url.origin}/app#enroll=${code}` : null,
      });
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return documentAccessErrorResponse(error);
      }
      return unavailable("document_access_unavailable");
    }
  }
  if (path === "/api/app/document-access/revoke") {
    const payload = await body(request);
    try {
      return jsonResponse(await revokeDocumentGrant(env, payload));
    } catch (error) {
      if (error instanceof DocumentAccessError) {
        return documentAccessErrorResponse(error);
      }
      return unavailable("document_access_unavailable");
    }
  }
  if (path === "/api/app/passkeys/status") {
    try {
      return jsonResponse(await passkeySecurityStatus(env, rpId));
    } catch {
      return unavailable("passkey_observability_unavailable");
    }
  }
  if (path === "/api/app/connections/revoke") {
    const payload = await body(request);
    if (!payload?.client_id) return jsonResponse({ error: "client_id required" }, 400);
    const outcome = await revokeConnection(env, payload.client_id);
    return jsonResponse({ ...outcome, connections: await listConnections(env) });
  }
  if (path === "/api/app/signout-all") {
    // Signing out EVERYONE is the owner's lever. A scoped person signing out
    // their own device uses /signout, which needs no privilege at all.
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
