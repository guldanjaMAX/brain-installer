/**
 * webauthn-fixtures — a synthetic authenticator for tests.
 *
 * Builds real CBOR attestation objects and really-signed assertions from a
 * generated P-256 keypair, so the verifier is exercised by the genuine
 * article rather than by mocks of itself. Everything WebAuthn hands a server
 * is reproduced: attestation "none", packed authenticator data, DER-wrapped
 * ECDSA signatures (WebCrypto signs raw r||s; browsers deliver DER, so the
 * fixture converts the same direction the platform does).
 */

const te = new TextEncoder();

export const b64u = (bytes) => {
  let ascii = "";
  for (const byte of new Uint8Array(bytes)) ascii += String.fromCharCode(byte);
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* Minimal CBOR ENCODER (major types 0-5, definite lengths) for fixtures. */
function cborHead(major, length) {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  if (length < 65536) return [(major << 5) | 25, length >> 8, length & 0xff];
  throw new Error("fixture too large");
}

export function cborEncode(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Uint8Array.from(value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value));
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from([...cborHead(2, value.length), ...value]);
  }
  if (typeof value === "string") {
    const bytes = te.encode(value);
    return Uint8Array.from([...cborHead(3, bytes.length), ...bytes]);
  }
  if (Array.isArray(value)) {
    const parts = value.map(cborEncode);
    return concat([Uint8Array.from(cborHead(4, value.length)), ...parts]);
  }
  if (value instanceof Map) {
    const parts = [Uint8Array.from(cborHead(5, value.size))];
    for (const [k, v] of value) parts.push(cborEncode(k), cborEncode(v));
    return concat(parts);
  }
  throw new Error("unsupported fixture value");
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Raw r||s -> ASN.1 DER, the wrapping browsers apply to ES256 signatures. */
export function rawSignatureToDer(raw) {
  const int = (bytes) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = bytes.slice(start);
    if (body[0] & 0x80) body = Uint8Array.from([0, ...body]);
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

/** A fresh synthetic passkey bound to rpId, plus its signing half. */
export async function makeCredential({ rpId, counter = 0, uv = true } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const x = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - jwk.x.length % 4) % 4)), (c) => c.charCodeAt(0));
  const y = Uint8Array.from(atob(jwk.y.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - jwk.y.length % 4) % 4)), (c) => c.charCodeAt(0));
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));

  const rpIdHash = await sha256(te.encode(rpId));
  const flags = 0x40 | 0x01 | (uv ? 0x04 : 0); // AT | UP | UV
  const authData = concat([
    rpIdHash,
    Uint8Array.of(flags),
    Uint8Array.of(counter >>> 24, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff),
    new Uint8Array(16), // aaguid
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    cborEncode(cose),
  ]);
  return { pair, credentialId: b64u(credentialId), authData };
}

export function clientData(type, challenge, origin) {
  return b64u(te.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

/** The registration payload navigator.credentials.create would deliver. */
export function attestationObject(authData) {
  return b64u(cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
}

/** A really-signed assertion for a stored credential. */
export async function signAssertion({ pair, rpId, challenge, origin, counter = 0, uv = true }) {
  const rpIdHash = await sha256(te.encode(rpId));
  const flags = 0x01 | (uv ? 0x04 : 0);
  const authData = concat([
    rpIdHash,
    Uint8Array.of(flags),
    Uint8Array.of(counter >>> 24, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff),
  ]);
  const clientDataJSON = clientData("webauthn.get", challenge, origin);
  const clientDataBytes = Uint8Array.from(atob(clientDataJSON.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - clientDataJSON.length % 4) % 4)), (c) => c.charCodeAt(0));
  const signed = concat([authData, await sha256(clientDataBytes)]);
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed,
  ));
  return {
    authenticatorData: b64u(authData),
    clientDataJSON,
    signature: b64u(rawSignatureToDer(rawSignature)),
  };
}
