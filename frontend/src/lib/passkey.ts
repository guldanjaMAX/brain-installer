import { api } from "./api";

// WebAuthn speaks ArrayBuffers; the wire speaks base64url. These two are the
// whole translation layer.
const toBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
const toB64u = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const passkeysSupported = (): boolean =>
  typeof window !== "undefined" && !!window.PublicKeyCredential;

type RegisterOptions = { challenge: string; rp: { id: string; name: string }; user_name: string };

/** Create a passkey. `code` is the one-time invite; omit it to add a device
 *  from an already signed-in session. */
export async function enroll(code?: string): Promise<void> {
  const options = await api<RegisterOptions>("/auth/register/options", code ? { code } : {});
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toBytes(options.challenge),
      rp: { id: options.rp.id, name: options.rp.name },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: options.user_name,
        displayName: options.user_name,
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      // residentKey so signing in later needs no username, and userVerification
      // so it is genuinely a face or a fingerprint rather than mere presence.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no passkey was created");
  const response = credential.response as AuthenticatorAttestationResponse;
  await api("/auth/register/verify", {
    code,
    nickname: navigator.platform || "this device",
    credentialId: credential.id,
    attestationObject: toB64u(response.attestationObject),
    clientDataJSON: toB64u(response.clientDataJSON),
  });
}

/** Turn a WebAuthn DOMException into something a person can act on.
 *
 *  The browser's own text for a failed sign-in is "The operation either timed
 *  out or was not allowed", followed by a link to the W3C spec. That is written
 *  for a browser vendor, not for someone locked out of their own brain, and it
 *  collapses three genuinely different failures into one sentence. Naming the
 *  exception matters too: which one it is decides where the bug lives, and
 *  without it every report is unfalsifiable. */
function explainCeremonyFailure(error: unknown, rpId: string): Error {
  const name = (error as { name?: string })?.name || "Error";
  const suffix = ` (${name})`;
  if (name === "NotAllowedError") {
    return new Error(
      `No passkey was offered for ${rpId}. Either this device has none saved ` +
      `for that exact address, or the prompt was dismissed before it finished. ` +
      `A passkey saved under a different address for this brain will not work here.` + suffix,
    );
  }
  if (name === "SecurityError") {
    return new Error(
      `This page's address does not match the one your passkey was saved under ` +
      `(${rpId}). Open the brain at its normal address and try again.` + suffix,
    );
  }
  if (name === "InvalidStateError") {
    return new Error(`This device already has a passkey for ${rpId}.` + suffix);
  }
  if (name === "NotSupportedError" || name === "AbortError") {
    return new Error(
      `This browser could not run the passkey prompt. Try opening the brain in ` +
      `Safari or Chrome directly rather than inside another app.` + suffix,
    );
  }
  return new Error(String((error as { message?: string })?.message || error) + suffix);
}

export async function signIn(): Promise<void> {
  const options = await api<{ challenge: string; rp_id: string }>("/auth/login/options");
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: toBytes(options.challenge),
        rpId: options.rp_id,
        userVerification: "required",
        allowCredentials: [],
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw explainCeremonyFailure(error, options.rp_id);
  }
  if (!assertion) throw new Error("no passkey was offered");
  const response = assertion.response as AuthenticatorAssertionResponse;
  await api("/auth/login/verify", {
    credentialId: assertion.id,
    authenticatorData: toB64u(response.authenticatorData),
    clientDataJSON: toB64u(response.clientDataJSON),
    signature: toB64u(response.signature),
  });
}
