import { api } from "./api";

// WebAuthn speaks ArrayBuffers; the wire speaks base64url. These two are the
// whole translation layer.
const toBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
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

export async function signIn(): Promise<void> {
  const options = await api<{ challenge: string; rp_id: string }>("/auth/login/options");
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: toBytes(options.challenge),
      rpId: options.rp_id,
      userVerification: "required",
      allowCredentials: [],
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("no passkey was offered");
  const response = assertion.response as AuthenticatorAssertionResponse;
  await api("/auth/login/verify", {
    credentialId: assertion.id,
    authenticatorData: toB64u(response.authenticatorData),
    clientDataJSON: toB64u(response.clientDataJSON),
    signature: toB64u(response.signature),
  });
}
