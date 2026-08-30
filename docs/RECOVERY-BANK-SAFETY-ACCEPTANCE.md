# Recovery and bank-custody acceptance

This checklist is the offline release gate for recovery, secret reconciliation,
session invalidation, bank-token custody, and encrypted artifacts. It does not
authorize a Cloudflare call, credential read, deployment, production mutation,
or live recovery drill.

## Frozen contracts

- The released base is exactly v0.2.0 commit
  `074f31bae42a57918c9fbd93613b5329d953c16c`.
- New bank access references use secret `BANK_FEED_WRAPPING_KEY_V2`, envelope
  `key_version = 2`, a 12-byte random AES-GCM IV, and base64 ciphertext.
- The wrapping value is `v2.` plus one independently random 32-byte base64url
  value. It is never derived from `ADMIN_KEY`, `SESSION_SIGNING_KEY`, a provider
  secret, or the recovery artifact key.
- Released `key_version = 1` rows remain readable only through the released
  session/admin derivation. Recovery compare-and-swap rewraps them to version 2
  or records explicit `reauth_required` state.
- A routine `brain secrets` run may remove disabled provider identifiers. It
  never deletes the wrapping key. An enabled feed requires the two provider
  secrets plus a valid version-2 wrapping key before any Worker secret write.
- Durable recovery artifacts use an independent `v1.` 32-byte key from
  `operations.recovery_artifact_key_secret`. The durable file is authenticated
  ciphertext. Plaintext exists only inside the owner-only artifact directory
  while a verifier or import callback owns it.

## Secret reconciliation before target mutation

The source and target must both contain `ADMIN_KEY`, `RAG_PROXY_KEY`, and
`SESSION_SIGNING_KEY`. Optional provider names must be reviewed and exact. The
target must additionally contain `BANK_FEED_WRAPPING_KEY_V2` when upgrading a
released source that does not have it yet. If the source already has that
secret, authenticated source and target endpoints must return the same SHA-256
fingerprint before import. A fingerprint mismatch stops before a target write.

Secret names are control-plane evidence. The wrapping-key fingerprint is the
data-custody equality proof. Neither proves a provider login or live bank
connection.

## Schema-22 recovery

Recovery preserves owner passkeys, exact-document grants, grant membership,
durable document-access request receipts, document-access audit events, and
privacy-safe passkey telemetry. It excludes authentication challenges and
one-time enrollment codes. Schema-23 support audit history is preserved, while
support sessions, access requests, invitations, challenges, and support
passkeys restore empty. Schema-24 destructive agent-action receipts never enter
the artifact. Their table must read exactly zero rows before and after bank
reconciliation. A D1 Time Travel rollback purges the same live authority and
must prove a zero-row readback before the paused barrier can succeed.

The recovered `install_state.session_generation` is exactly the source value
plus one. Invalid, negative, or overflow input stops artifact creation. Old
owner and scoped cookies therefore fail, while preserved passkeys can create a
new session.

## Mutation and resume matrix

| Boundary | First interrupted result | Required resume proof |
| --- | --- | --- |
| encrypted D1 export | ciphertext final absent or exact | stale plaintext/encryption residue stops; exact final is reused |
| isolated D1 restore | empty or byte-exact restored target | same stage verifies exact schema, aggregates, and durable-data hash |
| security reconciliation | version-1 row unchanged, version-2 row committed, or explicit reauthorization committed | compare-and-swap converges with zero connected legacy or unsupported rows |
| destructive agent authority | schema recreated with zero receipt rows | zero-row readback succeeds before and after bank reconciliation; Time Travel rollback purges and verifies separately |
| Vectorize rebuild and active promotion | durable batch progress or exact reviewed active version | same epoch/cursor resumes; exact counts, outbox, code, bindings, and mode converge |
| durable stage checkpoint | stage evidence already in the completed prefix | rerun starts at the next stage and never repeats the mutation |

The bank row drill covers `before_rewrap_write`, `after_rewrap_write`,
`before_reauthorization_required_write`, and
`after_reauthorization_required_write`. Reports contain aggregate counts only.
They never contain an item identifier, ciphertext, or access reference.

## Disposable offline command

Run from the repository root:

```bash
npm run test:recovery-bank
```

The lab rebuilds the child environment from an allowlist, uses a temporary
HOME, inherits no credentials, and runs only synthetic SQLite, Worker, and
Cloudflare fixtures. A pass proves deterministic interruption handling,
authenticated local artifact custody, versioned key separation, secret-name
policy, and exact rewrap/reauthorization convergence.

## Manual ceremony, not executed by this checklist

1. Generate the bank wrapping value with a reviewed launcher that calls
   `generateBankAccessWrappingKey`. Store it directly in the approved secret
   manager and Worker secret path. Do not print it or paste it into a command.
2. Generate the independent artifact value with
   `generateRecoveryArtifactKey`. Store it in the exact Keychain item named by
   `operations.recovery_artifact_key_secret`. Put only the non-secret locator in
   the manifest.
3. Confirm the artifact directory is owner-only and has no
   `.brain-recovery-plaintext.tmp-*` or
   `.brain-recovery-encrypted.tmp-*` residue.
4. Preview and approve a disposable recovery field gate separately. No result
   in this offline checklist is a live recovery or bank-provider claim.
