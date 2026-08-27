import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyRegistration, verifyAssertion, b64uEncode, b64uDecode, derSignatureToRaw } from "../src/lib/webauthn.js";
import { makeCredential, signAssertion, clientData, attestationObject, rawSignatureToDer } from "./webauthn-fixtures.mjs";

const RP = "brain.example.com";
const ORIGIN = "https://brain.example.com";
const CHALLENGE = "dGVzdC1jaGFsbGVuZ2U";

test("base64url round-trips and DER signatures convert to raw r||s", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  assert.deepEqual(b64uDecode(b64uEncode(bytes)), bytes);
  // High-bit r/s get a DER sign-padding byte; conversion must strip and re-pad.
  const raw = new Uint8Array(64).fill(0x80);
  assert.deepEqual(derSignatureToRaw(rawSignatureToDer(raw)), raw);
});

test("a genuine registration verifies and yields the stored shape", async () => {
  const credential = await makeCredential({ rpId: RP });
  const verified = await verifyRegistration({
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", CHALLENGE, ORIGIN),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    rpId: RP,
  });
  assert.equal(verified.credentialId, credential.credentialId);
  assert.equal(verified.alg, -7);
  assert.equal(verified.jwk.kty, "EC");
  assert.equal(verified.fmt, "none");
});

test("registration rejects wrong origin, wrong domain, and missing user verification", async () => {
  const credential = await makeCredential({ rpId: RP });
  const good = {
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", CHALLENGE, ORIGIN),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    rpId: RP,
  };
  await assert.rejects(() => verifyRegistration({ ...good, expectedOrigin: "https://evil.example.com" }), /origin/);
  await assert.rejects(() => verifyRegistration({ ...good, rpId: "other.example.com" }), /rpIdHash/);
  await assert.rejects(() => verifyRegistration({ ...good, expectedChallenge: "different" }), /challenge/);
  const noUv = await makeCredential({ rpId: RP, uv: false });
  await assert.rejects(() => verifyRegistration({
    ...good, attestationObject: attestationObject(noUv.authData),
  }), /user verification/i);
});

test("a really-signed assertion verifies; a tampered one does not", async () => {
  const credential = await makeCredential({ rpId: RP });
  const registered = await verifyRegistration({
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", CHALLENGE, ORIGIN),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    rpId: RP,
  });
  const stored = { jwk: registered.jwk, alg: registered.alg, sign_count: 0 };

  const assertion = await signAssertion({ pair: credential.pair, rpId: RP, challenge: "bG9naW4", origin: ORIGIN });
  const verdict = await verifyAssertion({
    ...assertion, expectedChallenge: "bG9naW4", expectedOrigin: ORIGIN, rpId: RP, credential: stored,
  });
  assert.equal(verdict.cloneSuspected, false);

  const other = await makeCredential({ rpId: RP });
  const forged = await signAssertion({ pair: other.pair, rpId: RP, challenge: "bG9naW4", origin: ORIGIN });
  await assert.rejects(() => verifyAssertion({
    ...forged, expectedChallenge: "bG9naW4", expectedOrigin: ORIGIN, rpId: RP, credential: stored,
  }), /signature/);
});

test("a nonzero counter that fails to advance flags a clone; synced-passkey zero does not", async () => {
  const credential = await makeCredential({ rpId: RP });
  const registered = await verifyRegistration({
    attestationObject: attestationObject(credential.authData),
    clientDataJSON: clientData("webauthn.create", CHALLENGE, ORIGIN),
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    rpId: RP,
  });
  const stored = { jwk: registered.jwk, alg: registered.alg, sign_count: 5 };

  const stale = await signAssertion({ pair: credential.pair, rpId: RP, challenge: "eA", origin: ORIGIN, counter: 3 });
  const staleVerdict = await verifyAssertion({
    ...stale, expectedChallenge: "eA", expectedOrigin: ORIGIN, rpId: RP, credential: stored,
  });
  assert.equal(staleVerdict.cloneSuspected, true, "a counter going backwards is the cloned-credential signal");

  const synced = await signAssertion({ pair: credential.pair, rpId: RP, challenge: "eQ", origin: ORIGIN, counter: 0 });
  const syncedVerdict = await verifyAssertion({
    ...synced, expectedChallenge: "eQ", expectedOrigin: ORIGIN, rpId: RP, credential: stored,
  });
  assert.equal(syncedVerdict.cloneSuspected, false, "synced passkeys legitimately report zero forever");
});
