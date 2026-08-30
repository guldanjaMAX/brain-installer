# ADR 003: Use native, read-only temporary support sessions

- Status: Accepted
- Date: 2026-08-30
- Owners: Product and engineering
- Confidence: High for the authorization boundary; medium until a real-domain support enrollment is field-tested
- Supersedes: None

## Problem

An owner may need help when their Brain is unhealthy, but its admin key can
read and mutate private data, and an owner passkey exposes the owner's whole
workspace. Screen sharing also reveals more than a technician needs and gives
the owner no durable record of what access was granted. Support therefore
needs a time-bounded identity whose permissions are materially smaller than
either operator or owner access.

## Options considered

1. Share the admin key or an owner session. This is operationally simple but
   exposes documents and powerful mutations and cannot meet least privilege.
2. Put each complete Brain behind Cloudflare Access. This can verify staff
   identity, but it adds per-install configuration and can interfere with
   public, API, OAuth callback, and webhook routes.
3. Add a native D1-backed support principal for a dedicated support path. This
   keeps each install owner-controlled and allows immediate local revocation,
   but requires a separate enrollment, cookie, projection, and audit contract.

## Decision

Each Brain may issue a one-time invitation for a distinct `support` principal.
The invitation expires after ten minutes. The owner chooses 15, 30, 60, or 120
minutes of access, with 30 minutes as the default and two hours as the hard
maximum. The duration begins only after successful passkey enrollment, never
extends on use or reissue, and every request rechecks the D1 support-session
row. Revocation or expiry therefore takes effect immediately.

The first release is read-only. Its sole data capability is a dedicated
privacy projection of aggregate system health and stable diagnostic codes.
It cannot access documents, filenames, questions, answers, finances, source
accounts, credentials, OAuth, owner settings, admin routes, raw logs, or any
mutation. A label entered by the owner identifies the invited person for the
owner's convenience; it is not verified staff identity.

Support invitations, passkeys, and active sessions live in dedicated tables,
not as nullable identities in the owner authentication tables. Verified
recovery retains bounded support history but restores those active credential
tables as empty. A D1 Time Travel rollback first makes the support plane
unavailable, then deletes and verifies every restored support session,
passkey, invitation, challenge, and request receipt before it may report
success.

## Consequences

- Owners can end access immediately without rotating their admin key or
  signing themselves out.
- A stolen link is single-use, short-lived, and still requires enrollment of a
  passkey on the exact Brain domain.
- The support page must never proxy raw diagnose, freshness, or log output.
- Expensive diagnostics are atomically limited per session; repeated reads and
  authentication challenges have bounded write and storage behavior.
- D1 unavailability fails closed and cannot fall back to owner, grant, or admin
  authorization.
- Repair recipes and staff identity verification remain separate future
  decisions. This release reports `can_fix: false` and does not contain a
  generic support mutation endpoint.
- Local-machine and provider-consent problems still require an owner-present
  workflow.

## Verification

- Migration restart and existing-install upgrade tests.
- Negative route tests covering document, Ask, financial, OAuth, admin, and
  owner-workspace denial for a live support principal.
- Enrollment replay, invite expiry, absolute expiry, immediate revoke, and D1
  unavailable tests.
- Privacy contract tests proving the support response excludes content and raw
  identifiers even when underlying diagnostics contain them.
- Desktop and mobile Settings and support-shell browser rehearsals using only
  synthetic data.
- A later real-domain passkey enrollment is required before calling technician
  access field-proven.

## Revisit when

- A central staff identity service can attest the technician without placing
  an owner's whole Brain behind it.
- A closed, auditable repair recipe has an exact plan fingerprint, a fresh
  owner approval, a single-use five-minute execution grant, and a tested
  rollback.
- Field evidence shows the two-hour maximum or ten-minute invitation is not
  usable.
