# Temporary support access contract

Temporary support access is a separate principal and a separate route family.
It is never an admin key, an owner session, a document grant, or a generic
capability grant. Every response is private and carries
`Cache-Control: no-store`.

Support invitations, passkeys, and active sessions use dedicated support
tables. They are not nullable subjects in the owner passkey tables. This keeps
an unreadable or missing support subject from ever falling back to owner.

## Owner flow

Owner routes require a positive owner passkey principal and
`X-Brain-App: 1`. They have no admin-key fallback.

- `POST /api/app/support-access/status`
- `POST /api/app/support-access/create`
- `POST /api/app/support-access/reissue`
- `POST /api/app/support-access/revoke`

Create accepts an owner-provided `technician_label`, a unique `request_id`, and
`duration_minutes` of 15, 30, 60, or 120. The default is 30 and the server hard
caps the value at 120. The immutable capability set is:

```json
["system_status:read", "diagnostics:redacted"]
```

The one-time enrollment link expires after ten minutes. Reissue replaces only
an unused or expired invitation. It never changes the support principal,
duration, or scope. Once the session is activated, reissue is unavailable and
its absolute expiry never changes. Retrying a write with the same request ID
and payload returns the stored receipt; reusing it with a different payload is
a conflict. A replay never presents a consumed or expired invite as active.

Owner status keeps the absolute session lifecycle separate from current
authentication. An otherwise active session reports `authenticated` while its
idle window is live and `reauthentication_required` after ten idle minutes.
Reauthentication uses the same support passkey and never extends absolute
expiry.

The label is owner-entered display text. The UI says `Invited technician`, not
`Verified Financial Brain technician`, and asks the owner to share the link
with the intended person through a trusted channel.

## Technician flow

Technician routes require `X-Brain-Support: 1` and a separate
`brain_support_session` cookie:

- `POST /api/support/me`
- `POST /api/support/system`
- `POST /api/support/signout`

The session is activated by successful passkey enrollment on the exact Brain
RP ID. Its selected duration starts at activation and never slides or extends.
Every request checks the D1 support row so expiry and owner revocation are
immediate. An expired or revoked session returns an explicit 403 and clears the
cookie. Missing or unavailable D1 returns 503 and never broadens access.

`/api/support/me` has an exact five-field response: `signed_in`, `principal`,
`workspace`, `can_fix`, and `repair_mode`. The principal contains only
`kind`, `support_session_id`, the owner-provided `technician_label`,
`technician_identity_verified: false`, absolute and idle expiry times, and
`read_only: true`. Every owner workspace capability is false; only the
dedicated `support` workspace marker is true. The repair fields are:

```json
{
  "can_fix": false,
  "repair_mode": "owner_approval_required_future"
}
```

`/api/support/system` is a dedicated privacy projection. It may return version
and schema state, aggregate document and chunk totals, aggregate vector counts
and completion, connector class/state/count/age, stable typed issue codes, and
the names of unavailable sections.

It must not return document content, titles, filenames, paths, URLs, source or
account identifiers, document or chunk identifiers, email addresses, samples,
snippets, raw errors, raw diagnostic detail, stack traces, credentials,
passkey identifiers, IP addresses, user agents, questions, or answers.

The system projection is reserved atomically before any diagnostic, freshness,
or Vectorize work and is limited to one read per support session every fifteen
seconds. A concurrent or early retry returns 429 without running those reads.
That response carries a bounded `Retry-After: 15`; the technician app retries
once and never creates an unbounded polling loop.
Ordinary last-use and security-audit writes are minute-bucketed, and active
authentication challenges have a fixed cap. A full challenge set refuses new
options rather than evicting a still-valid ceremony.

## Explicit denials

A support principal is denied from `/api/app/*`, `/api/owner/*`, `/api/rag/*`,
MCP, admin, bank, OAuth, document, Ask, search, ingest, forget, reindex, drain,
deploy, migrate, recovery, owner enrollment, and document-grant enrollment
routes. The one support invitation may enroll exactly one support passkey; it
cannot add another device. There is no support-to-owner or support-to-admin
fallback.

## Audit and future repairs

Low-level invite, activation, read, deny, expiry, and revoke decisions use a
bounded security event table with no raw data. The owner's human activity feed
records lifecycle changes only, not every technician read.

Verified recovery retains only bounded support history. It restores active
support invitations, passkeys, and session state as empty. D1 Time Travel
rollback also closes both owner and technician support routes before restore,
purges every live support-authority table in foreign-key-safe order, and
requires a zero-row readback. Any failure leaves the Worker paused and the
support plane unavailable, so recovery cannot resurrect technician access.

No support repair action exists in this release. A future repair must be one
closed server-side recipe with an exact plan fingerprint, fresh owner passkey
approval, a five-minute single-use execution grant, an idempotent receipt, and
a tested rollback. A generic command, SQL, URL fetch, or arbitrary mutation
surface is not an acceptable repair path.
