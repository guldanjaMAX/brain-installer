/**
 * Versioned QuickBooks callback envelope.
 *
 * The client creates an ephemeral P-256 key pair and keeps the private key on
 * its own machine. The Worker creates a second ephemeral key per callback,
 * derives an AES-256-GCM key with ECDH and HKDF-SHA-256, and binds the
 * ciphertext to the durable intent metadata as authenticated additional data.
 */

export const QUICKBOOKS_CALLBACK_ENVELOPE_VERSION = 1;
export const QUICKBOOKS_CALLBACK_ENVELOPE_ALGORITHM =
  "ECDH-P256-HKDF-SHA256-AES-256-GCM";
// With the maximum 512-character realm, maximum binding fields, and three
// UTF-8 bytes per accepted UTF-16 code unit, 1,024 code characters serialize
// to an envelope below D1's 8,192-character CHECK with more than 500 characters of
// margin. Intuit's value is opaque, so the boundary is deliberately generous
// without relying on it being ASCII.
export const QUICKBOOKS_CALLBACK_AUTHORIZATION_CODE_MAX_CHARS = 1024;
export const QUICKBOOKS_CALLBACK_REALM_ID_MAX_CHARS = 512;
export const QUICKBOOKS_CALLBACK_ENVELOPE_MAX_CHARS = 8192;

const DOMAIN = "financial-brain.quickbooks-callback-envelope.v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_64 = /^[0-9a-f]{64}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// In Unicode mode a valid surrogate pair is one astral code point and does not
// match this range; a lone surrogate does. Rejecting lone surrogates keeps the
// three-UTF-8-bytes-per-code-unit envelope proof true.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export class QuickBooksCallbackCryptoError extends Error {
  constructor(code = "quickbooks_callback_crypto_unavailable") {
    super("QuickBooks callback encryption could not be completed safely");
    this.name = "QuickBooksCallbackCryptoError";
    this.code = code;
  }
}

function fail(code) {
  throw new QuickBooksCallbackCryptoError(code);
}

function webCrypto() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    fail("quickbooks_callback_crypto_unavailable");
  }
  return globalThis.crypto;
}

function b64uEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(value, { min = 1, max = 8192 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || !B64U.test(value)) {
    fail("quickbooks_callback_envelope_invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    fail("quickbooks_callback_envelope_invalid");
  }
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  // Reject alternate spellings that differ only in unused base64 pad bits.
  // The envelope fingerprint is over the serialized form, so accepting two
  // strings for the same bytes would make string-level tamper checks ambiguous.
  if (b64uEncode(out) !== value) fail("quickbooks_callback_envelope_invalid");
  return out;
}

function normalizedPublicJwk(jwk, { allowPrivate = false } = {}) {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk) ||
      jwk.kty !== "EC" || jwk.crv !== "P-256" || (!allowPrivate && "d" in jwk) ||
      typeof jwk.x !== "string" || typeof jwk.y !== "string" ||
      jwk.x.length !== 43 || jwk.y.length !== 43 ||
      !B64U.test(jwk.x) || !B64U.test(jwk.y)) {
    fail("quickbooks_callback_public_key_invalid");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true };
}

function normalizedPrivateJwk(jwk) {
  const publicPart = normalizedPublicJwk(jwk, { allowPrivate: true });
  if (typeof jwk?.d !== "string" || jwk.d.length !== 43 || !B64U.test(jwk.d)) {
    fail("quickbooks_callback_private_key_invalid");
  }
  return { ...publicPart, d: jwk.d };
}

export function normalizeQuickBooksCallbackBinding(binding) {
  const normalized = {
    intent_fingerprint: binding?.intent_fingerprint,
    source: binding?.source,
    environment: binding?.environment,
    client_id_fingerprint: binding?.client_id_fingerprint,
    expected_company_fingerprint: binding?.expected_company_fingerprint ?? null,
    created_at: binding?.created_at,
    expires_at: binding?.expires_at,
  };
  if (!HEX_64.test(normalized.intent_fingerprint || "") ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized.source || "") ||
      !["sandbox", "production"].includes(normalized.environment) ||
      !HEX_64.test(normalized.client_id_fingerprint || "") ||
      (normalized.expected_company_fingerprint !== null &&
        !HEX_64.test(normalized.expected_company_fingerprint || "")) ||
      !Number.isSafeInteger(normalized.created_at) ||
      !Number.isSafeInteger(normalized.expires_at) ||
      normalized.expires_at <= normalized.created_at ||
      normalized.expires_at > normalized.created_at + 15 * 60 * 1000) {
    fail("quickbooks_callback_binding_invalid");
  }
  return normalized;
}

function aadBytes(binding) {
  return encoder.encode(JSON.stringify({ domain: DOMAIN, binding }));
}

async function aesKey(sharedBits, salt, usage) {
  const crypto = webCrypto();
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(DOMAIN) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function sha256Hex(value) {
  const digest = await webCrypto().subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateQuickBooksCallbackPublicJwk(jwk) {
  try {
    const normalized = normalizedPublicJwk(jwk);
    await webCrypto().subtle.importKey(
      "jwk",
      normalized,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return normalized;
  } catch (error) {
    if (error instanceof QuickBooksCallbackCryptoError) throw error;
    fail("quickbooks_callback_public_key_invalid");
  }
}

/** Generate the local, memory-only recipient key pair used by the CLI. */
export async function generateQuickBooksCallbackKeyPair() {
  try {
    const crypto = webCrypto();
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const publicJwk = normalizedPublicJwk(await crypto.subtle.exportKey("jwk", keyPair.publicKey));
    return { privateKey: keyPair.privateKey, publicJwk };
  } catch (error) {
    if (error instanceof QuickBooksCallbackCryptoError) throw error;
    fail("quickbooks_callback_key_generation_unavailable");
  }
}

/** Encrypt the provider callback values to one client's ephemeral public key. */
export async function encryptQuickBooksCallback({
  recipientPublicJwk,
  binding,
  authorizationCode,
  realmId,
}) {
  try {
    if (typeof authorizationCode !== "string" || authorizationCode.length < 1 ||
        authorizationCode.length > QUICKBOOKS_CALLBACK_AUTHORIZATION_CODE_MAX_CHARS ||
        CONTROL.test(authorizationCode) || LONE_SURROGATE.test(authorizationCode) ||
        typeof realmId !== "string" || realmId.length < 1 ||
        realmId.length > QUICKBOOKS_CALLBACK_REALM_ID_MAX_CHARS ||
        CONTROL.test(realmId) || LONE_SURROGATE.test(realmId)) {
      fail("quickbooks_callback_provider_values_invalid");
    }
    const crypto = webCrypto();
    const normalizedBinding = normalizeQuickBooksCallbackBinding(binding);
    const recipient = await crypto.subtle.importKey(
      "jwk",
      normalizedPublicJwk(recipientPublicJwk),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipient },
      ephemeral.privateKey,
      256,
    );
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesKey(sharedBits, salt, "encrypt");
    const plaintext = encoder.encode(JSON.stringify({
      version: QUICKBOOKS_CALLBACK_ENVELOPE_VERSION,
      authorization_code: authorizationCode,
      realm_id: realmId,
      binding: normalizedBinding,
    }));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadBytes(normalizedBinding), tagLength: 128 },
      key,
      plaintext,
    );
    return {
      version: QUICKBOOKS_CALLBACK_ENVELOPE_VERSION,
      algorithm: QUICKBOOKS_CALLBACK_ENVELOPE_ALGORITHM,
      binding: normalizedBinding,
      ephemeral_public_jwk: normalizedPublicJwk(
        await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
      ),
      salt_b64u: b64uEncode(salt),
      iv_b64u: b64uEncode(iv),
      ciphertext_b64u: b64uEncode(new Uint8Array(ciphertext)),
    };
  } catch (error) {
    if (error instanceof QuickBooksCallbackCryptoError) throw error;
    fail("quickbooks_callback_crypto_unavailable");
  }
}

/** Decrypt and authenticate an envelope on the local Node process. */
export async function decryptQuickBooksCallback({ privateKey, privateJwk, envelope }) {
  try {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        envelope.version !== QUICKBOOKS_CALLBACK_ENVELOPE_VERSION ||
        envelope.algorithm !== QUICKBOOKS_CALLBACK_ENVELOPE_ALGORITHM) {
      fail("quickbooks_callback_envelope_invalid");
    }
    const crypto = webCrypto();
    const binding = normalizeQuickBooksCallbackBinding(envelope.binding);
    const sender = await crypto.subtle.importKey(
      "jwk",
      normalizedPublicJwk(envelope.ephemeral_public_jwk),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const recipientPrivate = privateKey || await crypto.subtle.importKey(
      "jwk",
      normalizedPrivateJwk(privateJwk),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: sender },
      recipientPrivate,
      256,
    );
    const salt = b64uDecode(envelope.salt_b64u, { min: 43, max: 43 });
    const iv = b64uDecode(envelope.iv_b64u, { min: 16, max: 16 });
    const ciphertext = b64uDecode(envelope.ciphertext_b64u, { min: 22, max: 8192 });
    if (salt.byteLength !== 32 || iv.byteLength !== 12 || ciphertext.byteLength < 17) {
      fail("quickbooks_callback_envelope_invalid");
    }
    const key = await aesKey(sharedBits, salt, "decrypt");
    const plaintextBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aadBytes(binding), tagLength: 128 },
      key,
      ciphertext,
    );
    const plaintext = JSON.parse(decoder.decode(plaintextBytes));
    if (plaintext?.version !== QUICKBOOKS_CALLBACK_ENVELOPE_VERSION ||
        typeof plaintext.authorization_code !== "string" || !plaintext.authorization_code ||
        plaintext.authorization_code.length > QUICKBOOKS_CALLBACK_AUTHORIZATION_CODE_MAX_CHARS ||
        CONTROL.test(plaintext.authorization_code) || LONE_SURROGATE.test(plaintext.authorization_code) ||
        typeof plaintext.realm_id !== "string" || !plaintext.realm_id ||
        plaintext.realm_id.length > QUICKBOOKS_CALLBACK_REALM_ID_MAX_CHARS ||
        CONTROL.test(plaintext.realm_id) || LONE_SURROGATE.test(plaintext.realm_id) ||
        JSON.stringify(normalizeQuickBooksCallbackBinding(plaintext.binding)) !== JSON.stringify(binding)) {
      fail("quickbooks_callback_envelope_invalid");
    }
    return {
      authorizationCode: plaintext.authorization_code,
      realmId: plaintext.realm_id,
      binding,
    };
  } catch (error) {
    if (error instanceof QuickBooksCallbackCryptoError) throw error;
    fail("quickbooks_callback_decryption_failed");
  }
}
