/**
 * webauthn — passkey ceremony verification with zero dependencies.
 *
 * The owner's everyday credential is a passkey: created with Face ID or a
 * fingerprint on their own device, private half in their platform keychain,
 * public half in their own D1. This module verifies the two WebAuthn
 * ceremonies (registration, assertion) using only WebCrypto, which the
 * Worker runtime and Node 22 both provide.
 *
 * Trust model, stated plainly:
 *
 *   Enrollment trust comes from the ONE-TIME CODE that gated it (minted by
 *   the admin key, 15-minute TTL, single use) or from an already-signed-in
 *   session adding a device. Attestation statements are therefore parsed
 *   past but NOT verified: certifying which vendor made the authenticator
 *   adds nothing here, and the chains change more often than this worker
 *   ships. `fmt` is recorded for the audit trail only.
 *
 *   Assertion trust is the full checklist, none skippable: origin match,
 *   rpIdHash match, single-use challenge match, user-present AND
 *   user-verified flags, signature over authenticatorData || SHA-256(client
 *   data) with the stored public key, and a sign-count regression check
 *   (synced passkeys legitimately report 0; a nonzero count that fails to
 *   advance means a cloned credential and the caller must revoke).
 *
 * The CBOR decoder is deliberately a SUBSET: definite lengths, major types
 * 0-5. That is the entire grammar WebAuthn attestation objects and COSE keys
 * use; anything outside it is refused rather than guessed at.
 */

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

/* --------------------------------------------------------------- base64url */

export function b64uEncode(bytes) {
  let ascii = "";
  for (const byte of bytes) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text) {
  const value = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const ascii = atob(padded);
  const bytes = new Uint8Array(ascii.length);
  for (let i = 0; i < ascii.length; i++) bytes[i] = ascii.charCodeAt(i);
  return bytes;
}

/* -------------------------------------------------------------------- cbor */

/** Decode one CBOR item at offset. Returns { value, next }. */
function cborItem(bytes, offset) {
  if (offset >= bytes.length) throw new Error("CBOR truncated");
  const initial = bytes[offset];
  const major = initial >> 5;
  let info = initial & 0x1f;
  let cursor = offset + 1;
  let length;
  if (info < 24) {
    length = info;
  } else if (info === 24 || info === 25 || info === 26) {
    const size = info === 24 ? 1 : info === 25 ? 2 : 4;
    if (cursor + size > bytes.length) throw new Error("CBOR truncated");
    length = 0;
    for (let i = 0; i < size; i++) length = length * 256 + bytes[cursor + i];
    cursor += size;
  } else {
    // 27 (64-bit) and indefinite lengths never appear in WebAuthn payloads.
    throw new Error("unsupported CBOR length encoding");
  }
  switch (major) {
    case 0: return { value: length, next: cursor };
    case 1: return { value: -1 - length, next: cursor };
    case 2: {
      if (cursor + length > bytes.length) throw new Error("CBOR truncated");
      return { value: bytes.slice(cursor, cursor + length), next: cursor + length };
    }
    case 3: {
      if (cursor + length > bytes.length) throw new Error("CBOR truncated");
      return { value: td.decode(bytes.slice(cursor, cursor + length)), next: cursor + length };
    }
    case 4: {
      const array = [];
      for (let i = 0; i < length; i++) {
        const item = cborItem(bytes, cursor);
        array.push(item.value);
        cursor = item.next;
      }
      return { value: array, next: cursor };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < length; i++) {
        const key = cborItem(bytes, cursor);
        const val = cborItem(bytes, key.next);
        map.set(key.value, val.value);
        cursor = val.next;
      }
      return { value: map, next: cursor };
    }
    default:
      throw new Error("unsupported CBOR major type");
  }
}

export function cborDecodeFirst(bytes) {
  return cborItem(bytes, 0);
}

/* ------------------------------------------------------- authenticatorData */

export function parseAuthenticatorData(bytes) {
  if (bytes.length < 37) throw new Error("authenticator data too short");
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = (bytes[33] << 24 | bytes[34] << 16 | bytes[35] << 8 | bytes[36]) >>> 0;
  const parsed = {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    attestedCredential: (flags & 0x40) !== 0,
    signCount,
  };
  if (parsed.attestedCredential) {
    if (bytes.length < 55) throw new Error("attested credential data truncated");
    const idLength = (bytes[53] << 8) | bytes[54];
    const idEnd = 55 + idLength;
    if (bytes.length < idEnd) throw new Error("credential id truncated");
    parsed.credentialId = bytes.slice(55, idEnd);
    parsed.cosePublicKey = cborItem(bytes, idEnd).value;
  }
  return parsed;
}

/* -------------------------------------------------------------- COSE keys */

const ES256 = -7;
const RS256 = -257;

/** COSE key map -> { jwk, alg }. ES256 everywhere; RS256 for Windows Hello. */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new Error("COSE key is not a map");
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === ES256) {
    if (cose.get(-1) !== 1) throw new Error("unsupported EC curve");
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
      throw new Error("malformed EC2 coordinates");
    }
    return { alg: ES256, jwk: { kty: "EC", crv: "P-256", x: b64uEncode(x), y: b64uEncode(y) } };
  }
  if (kty === 3 && alg === RS256) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error("malformed RSA key");
    return { alg: RS256, jwk: { kty: "RSA", n: b64uEncode(n), e: b64uEncode(e) } };
  }
  throw new Error("unsupported credential algorithm; only ES256 and RS256 are accepted");
}

async function importVerifyKey(jwk, alg) {
  if (alg === ES256) {
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  }
  return crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/** WebAuthn ES256 signatures are ASN.1 DER; WebCrypto wants raw r||s. */
export function derSignatureToRaw(der) {
  if (der[0] !== 0x30) throw new Error("malformed DER signature");
  let cursor = der[1] === 0x81 ? 3 : 2;
  const readInt = () => {
    if (der[cursor] !== 0x02) throw new Error("malformed DER integer");
    let length = der[cursor + 1];
    cursor += 2;
    let start = cursor;
    cursor += length;
    // Strip the sign-padding zero, then left-pad back to exactly 32 bytes.
    while (length > 32 && der[start] === 0x00) { start++; length--; }
    if (length > 32) throw new Error("DER integer too large for P-256");
    const out = new Uint8Array(32);
    out.set(der.slice(start, start + length), 32 - length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/* ------------------------------------------------------------- clientData */

function checkClientData(clientDataBytes, { expectedType, expectedChallenge, expectedOrigin }) {
  let parsed;
  try {
    parsed = JSON.parse(td.decode(clientDataBytes));
  } catch {
    throw new Error("client data is not valid JSON");
  }
  if (parsed.type !== expectedType) throw new Error(`client data type must be ${expectedType}`);
  if (parsed.challenge !== expectedChallenge) throw new Error("challenge mismatch");
  if (parsed.origin !== expectedOrigin) throw new Error(`origin mismatch: ${parsed.origin}`);
  return parsed;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* -------------------------------------------------------------- ceremonies */

/**
 * Verify a registration (navigator.credentials.create result).
 * Returns { credentialId, jwk, alg, signCount, fmt } or throws.
 */
export async function verifyRegistration({
  attestationObject, // base64url
  clientDataJSON,    // base64url
  expectedChallenge, // base64url string exactly as issued
  expectedOrigin,
  rpId,
}) {
  const clientDataBytes = b64uDecode(clientDataJSON);
  checkClientData(clientDataBytes, {
    expectedType: "webauthn.create",
    expectedChallenge,
    expectedOrigin,
  });
  const attestation = cborDecodeFirst(b64uDecode(attestationObject)).value;
  if (!(attestation instanceof Map)) throw new Error("attestation object is not a CBOR map");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) throw new Error("attestation missing authData");
  const parsed = parseAuthenticatorData(authData);
  if (!timingSafeEqualBytes(parsed.rpIdHash, await sha256(te.encode(rpId)))) {
    throw new Error("rpIdHash does not match this brain's domain");
  }
  if (!parsed.userPresent) throw new Error("user presence was not asserted");
  if (!parsed.userVerified) throw new Error("user verification (Face ID / PIN / fingerprint) is required");
  if (!parsed.attestedCredential) throw new Error("no attested credential in registration");
  const { jwk, alg } = coseToJwk(parsed.cosePublicKey);
  return {
    credentialId: b64uEncode(parsed.credentialId),
    jwk,
    alg,
    signCount: parsed.signCount,
    fmt: String(attestation.get("fmt") || "none"),
  };
}

/**
 * Verify an assertion (navigator.credentials.get result) against a stored
 * credential. Returns { signCount, cloneSuspected } or throws.
 */
export async function verifyAssertion({
  authenticatorData, // base64url
  clientDataJSON,    // base64url
  signature,         // base64url
  expectedChallenge,
  expectedOrigin,
  rpId,
  credential,        // { jwk, alg, sign_count }
}) {
  const clientDataBytes = b64uDecode(clientDataJSON);
  checkClientData(clientDataBytes, {
    expectedType: "webauthn.get",
    expectedChallenge,
    expectedOrigin,
  });
  const authBytes = b64uDecode(authenticatorData);
  const parsed = parseAuthenticatorData(authBytes);
  if (!timingSafeEqualBytes(parsed.rpIdHash, await sha256(te.encode(rpId)))) {
    throw new Error("rpIdHash does not match this brain's domain");
  }
  if (!parsed.userPresent) throw new Error("user presence was not asserted");
  if (!parsed.userVerified) throw new Error("user verification (Face ID / PIN / fingerprint) is required");

  const signedData = new Uint8Array(authBytes.length + 32);
  signedData.set(authBytes, 0);
  signedData.set(await sha256(clientDataBytes), authBytes.length);

  const alg = Number(credential.alg);
  const key = await importVerifyKey(credential.jwk, alg);
  const signatureBytes = b64uDecode(signature);
  const rawSignature = alg === ES256 ? derSignatureToRaw(signatureBytes) : signatureBytes;
  const valid = await crypto.subtle.verify(
    alg === ES256 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
    key,
    rawSignature,
    signedData,
  );
  if (!valid) throw new Error("signature verification failed");

  // Synced passkeys report 0 forever; that is normal. A counter that is
  // nonzero but failed to advance is the cloned-authenticator signal.
  const stored = Number(credential.sign_count || 0);
  const cloneSuspected = parsed.signCount !== 0 && parsed.signCount <= stored && stored !== 0;
  return { signCount: parsed.signCount, cloneSuspected };
}
