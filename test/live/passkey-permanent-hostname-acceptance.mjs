/**
 * Offline protocol for a later supervised permanent-host passkey field gate.
 *
 * This file never opens a browser, contacts a Worker, reads credentials, or
 * performs a ceremony. Subject names and raw hostnames stay outside its
 * privacy-safe receipt. An operator maps the two subject aliases separately.
 *
 *   node test/live/passkey-permanent-hostname-acceptance.mjs --plan
 *   node test/live/passkey-permanent-hostname-acceptance.mjs --template receipt.json
 *   node test/live/passkey-permanent-hostname-acceptance.mjs --verify receipt.json
 *   node test/live/passkey-permanent-hostname-acceptance.mjs --self-test
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const PROTOCOL = "passkey-permanent-host-v1";
const SUBJECTS = ["owner_a", "owner_b"];
const AUTHENTICATORS = {
  owner_a: [
    { alias: "owner_a_platform", kind: "phone_platform" },
    { alias: "owner_a_independent", kind: "independent_security_device" },
  ],
  owner_b: [
    { alias: "owner_b_platform", kind: "phone_platform" },
    { alias: "owner_b_independent", kind: "independent_security_device" },
  ],
};

const exactKeys = (value, keys, label) => assert.deepEqual(
  Object.keys(value || {}).sort(), [...keys].sort(), `${label} has unexpected or missing fields`,
);
const trueField = (value, label) => assert.equal(value, true, `${label} must be true`);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function authenticatorTemplate(authenticator) {
  return {
    alias: authenticator.alias,
    kind: authenticator.kind,
    enrolled: false,
    logout_login_completed: false,
    present_in_credential_listing: false,
  };
}

function subjectTemplate(alias) {
  return {
    alias,
    distinct_human_confirmed: false,
    authenticators: AUTHENTICATORS[alias].map(authenticatorTemplate),
    second_device_enrollment_completed: false,
    credential_listing_count: 0,
    revocation: {
      target_alias: `${alias}_platform`,
      revoke_confirmed: false,
      bound_session_denied_immediately: false,
      alternate_authenticator_login_completed: false,
    },
    lost_device: {
      target_alias: `${alias}_platform`,
      lost_credential_unusable: false,
      lost_session_denied: false,
      alternate_authenticator_login_completed: false,
    },
    recovery: {
      minimal_reproduction_completed: false,
      recovery_enrollment_completed: false,
      restored_authenticator_count: 0,
    },
  };
}

function template() {
  return {
    protocol: PROTOCOL,
    status: "blocked",
    proof_level: "blocked_pending_live_authorization",
    live_authorization: {
      explicit: false,
      environment_sha256: "",
    },
    target: {
      hostname_sha256: "",
      frozen_before_first_enrollment: false,
    },
    reproduction: {
      prior_claims_used_as_evidence: false,
      minimal_reproduction_completed: false,
    },
    subjects: SUBJECTS.map(subjectTemplate),
    custody_recovery: {
      last_owner_credential_refusal_confirmed: false,
      surviving_credential_login_completed: false,
      final_credential_listing_count: 0,
      all_expected_authenticators_restored: false,
    },
  };
}

function assertPrivacyShape(receipt) {
  const forbidden = new Set([
    "name", "owner_name", "hostname", "domain", "url", "credential_id",
    "cookie", "challenge", "assertion", "signature", "public_key", "ip_address",
    "user_agent", "notes", "free_text",
  ]);
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `privacy-forbidden receipt field: ${key}`);
      walk(nested);
    }
  };
  walk(receipt);
}

function validate(receipt) {
  assertPrivacyShape(receipt);
  exactKeys(receipt, [
    "protocol", "status", "proof_level", "live_authorization", "target",
    "reproduction", "subjects", "custody_recovery",
  ], "receipt");
  assert.equal(receipt.protocol, PROTOCOL);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.proof_level, "physical_permanent_host");

  exactKeys(receipt.live_authorization, ["explicit", "environment_sha256"], "live_authorization");
  trueField(receipt.live_authorization.explicit, "explicit live authorization");
  assert.match(receipt.live_authorization.environment_sha256, /^[a-f0-9]{64}$/);
  exactKeys(receipt.target, ["hostname_sha256", "frozen_before_first_enrollment"], "target");
  assert.match(receipt.target.hostname_sha256, /^[a-f0-9]{64}$/);
  trueField(receipt.target.frozen_before_first_enrollment, "hostname freeze before enrollment");
  assert.notEqual(receipt.target.hostname_sha256, receipt.live_authorization.environment_sha256,
    "target and authorization hashes must represent separate reviewed facts");

  exactKeys(receipt.reproduction,
    ["prior_claims_used_as_evidence", "minimal_reproduction_completed"], "reproduction");
  assert.equal(receipt.reproduction.prior_claims_used_as_evidence, false,
    "prior product claims are leads, not field evidence");
  trueField(receipt.reproduction.minimal_reproduction_completed, "minimal reproduction");

  assert.equal(receipt.subjects?.length, 2, "exactly two distinct subjects are required");
  for (let index = 0; index < SUBJECTS.length; index++) {
    const expectedAlias = SUBJECTS[index];
    const subject = receipt.subjects[index];
    exactKeys(subject, [
      "alias", "distinct_human_confirmed", "authenticators",
      "second_device_enrollment_completed", "credential_listing_count",
      "revocation", "lost_device", "recovery",
    ], expectedAlias);
    assert.equal(subject.alias, expectedAlias);
    trueField(subject.distinct_human_confirmed, `${expectedAlias} distinct human`);
    assert.equal(subject.authenticators?.length, 2);
    for (let authIndex = 0; authIndex < 2; authIndex++) {
      const expected = AUTHENTICATORS[expectedAlias][authIndex];
      const authenticator = subject.authenticators[authIndex];
      exactKeys(authenticator,
        ["alias", "kind", "enrolled", "logout_login_completed", "present_in_credential_listing"],
        expected.alias);
      assert.equal(authenticator.alias, expected.alias);
      assert.equal(authenticator.kind, expected.kind);
      trueField(authenticator.enrolled, `${expected.alias} enrollment`);
      trueField(authenticator.logout_login_completed, `${expected.alias} logout/login`);
      trueField(authenticator.present_in_credential_listing, `${expected.alias} listing`);
    }
    trueField(subject.second_device_enrollment_completed, `${expectedAlias} second device`);
    assert.equal(subject.credential_listing_count, 2);

    exactKeys(subject.revocation, [
      "target_alias", "revoke_confirmed", "bound_session_denied_immediately",
      "alternate_authenticator_login_completed",
    ], `${expectedAlias}.revocation`);
    assert.equal(subject.revocation.target_alias, `${expectedAlias}_platform`);
    trueField(subject.revocation.revoke_confirmed, `${expectedAlias} revoke`);
    trueField(subject.revocation.bound_session_denied_immediately,
      `${expectedAlias} immediate session invalidation`);
    trueField(subject.revocation.alternate_authenticator_login_completed,
      `${expectedAlias} alternate login after revoke`);

    exactKeys(subject.lost_device, [
      "target_alias", "lost_credential_unusable", "lost_session_denied",
      "alternate_authenticator_login_completed",
    ], `${expectedAlias}.lost_device`);
    assert.equal(subject.lost_device.target_alias, `${expectedAlias}_platform`);
    trueField(subject.lost_device.lost_credential_unusable, `${expectedAlias} lost credential`);
    trueField(subject.lost_device.lost_session_denied, `${expectedAlias} lost session denial`);
    trueField(subject.lost_device.alternate_authenticator_login_completed,
      `${expectedAlias} lost-device alternate login`);

    exactKeys(subject.recovery, [
      "minimal_reproduction_completed", "recovery_enrollment_completed",
      "restored_authenticator_count",
    ], `${expectedAlias}.recovery`);
    trueField(subject.recovery.minimal_reproduction_completed, `${expectedAlias} recovery reproduction`);
    trueField(subject.recovery.recovery_enrollment_completed, `${expectedAlias} recovery enrollment`);
    assert.equal(subject.recovery.restored_authenticator_count, 2);
  }

  exactKeys(receipt.custody_recovery, [
    "last_owner_credential_refusal_confirmed", "surviving_credential_login_completed",
    "final_credential_listing_count", "all_expected_authenticators_restored",
  ], "custody_recovery");
  trueField(receipt.custody_recovery.last_owner_credential_refusal_confirmed,
    "last owner credential refusal");
  trueField(receipt.custody_recovery.surviving_credential_login_completed,
    "surviving credential recovery login");
  assert.equal(receipt.custody_recovery.final_credential_listing_count, 4);
  trueField(receipt.custody_recovery.all_expected_authenticators_restored,
    "post-test authenticator restoration");
  return receipt;
}

function completedSyntheticFixture() {
  const receipt = template();
  receipt.status = "passed";
  receipt.proof_level = "physical_permanent_host";
  receipt.live_authorization = { explicit: true, environment_sha256: "a".repeat(64) };
  receipt.target = { hostname_sha256: "b".repeat(64), frozen_before_first_enrollment: true };
  receipt.reproduction.minimal_reproduction_completed = true;
  for (const subject of receipt.subjects) {
    subject.distinct_human_confirmed = true;
    subject.second_device_enrollment_completed = true;
    subject.credential_listing_count = 2;
    for (const authenticator of subject.authenticators) {
      authenticator.enrolled = true;
      authenticator.logout_login_completed = true;
      authenticator.present_in_credential_listing = true;
    }
    subject.revocation.revoke_confirmed = true;
    subject.revocation.bound_session_denied_immediately = true;
    subject.revocation.alternate_authenticator_login_completed = true;
    subject.lost_device.lost_credential_unusable = true;
    subject.lost_device.lost_session_denied = true;
    subject.lost_device.alternate_authenticator_login_completed = true;
    subject.recovery.minimal_reproduction_completed = true;
    subject.recovery.recovery_enrollment_completed = true;
    subject.recovery.restored_authenticator_count = 2;
  }
  receipt.custody_recovery = {
    last_owner_credential_refusal_confirmed: true,
    surviving_credential_login_completed: true,
    final_credential_listing_count: 4,
    all_expected_authenticators_restored: true,
  };
  return receipt;
}

const [mode, file] = process.argv.slice(2);
if (mode === "--plan") {
  console.log(JSON.stringify({
    protocol: PROTOCOL,
    status: "blocked_pending_explicit_live_authorization",
    identity_mapping: "kept outside the receipt",
    subjects: 2,
    authenticators: 4,
    per_subject: [
      "phone/platform enrollment and logout/login",
      "independent security-device enrollment and logout/login",
      "second-device enrollment and exact two-device listing",
      "revoke and immediate bound-session denial",
      "lost-device alternate login and recovery enrollment",
    ],
    shared_custody: [
      "hostname frozen before first enrollment",
      "last-owner-credential revocation refused",
      "four expected authenticators restored and listed",
    ],
  }, null, 2));
} else if (mode === "--template") {
  if (!file) throw new Error("--template requires a receipt path");
  writeFileSync(file, JSON.stringify(template(), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "template_written", mode: "0600" }));
} else if (mode === "--verify") {
  if (!file) throw new Error("--verify requires a receipt path");
  assert.equal(statSync(file).mode & 0o077, 0, "receipt must not be group/world accessible");
  const raw = readFileSync(file, "utf8");
  const receipt = validate(JSON.parse(raw));
  console.log(JSON.stringify({
    status: "passed",
    protocol: receipt.protocol,
    proof_level: receipt.proof_level,
    subjects: 2,
    authenticators: 4,
    receipt_sha256: hash(raw),
  }, null, 2));
} else if (mode === "--self-test") {
  assert.throws(() => validate(template()));
  validate(completedSyntheticFixture());
  const leaky = completedSyntheticFixture();
  leaky.subjects[0].credential_id = "forbidden";
  assert.throws(() => validate(leaky), /privacy-forbidden/);
  console.log(JSON.stringify({ status: "passed", protocol: PROTOCOL, network_calls: 0 }));
} else {
  throw new Error("use --plan, --template <path>, --verify <path>, or --self-test");
}
