# Public Git privacy incident evidence

> Historical predecessor-repository evidence. The clean lineage preserves this
> sanitized record but does not use its baseline or ref manifest as an active
> gate. Current package scripts and CI require exactly zero finding objects.

Sanitized local evidence recorded 2026-08-30 from the public `origin` heads and
tags. No matched value, raw affected path, personal identifier, credential, or
source content is present in this report.

## Result

| Measure | Observed |
|---|---:|
| Server-visible public refs | 21 |
| Public heads | 8 |
| Public tags | 13 |
| Reachable commits | 362 |
| Reachable Git objects | 4,126 |
| Reachable blobs | 2,129 |
| Finding objects | 364 |
| Finding categories | 32 |
| Public refs retaining at least one finding object | 21 |

The current tree and npm package can pass the existing package privacy gate
while older Git objects remain reachable. Every public head and tag in the
server inventory retains at least one finding object. A local-only backup tag
was excluded after a read-only server comparison proved that it is not public.

The exact sanitized object/category/location set is
`privacy/history-baseline.json`. The exact server-ref snapshot is
`privacy/public-refs.json`. Both files omit matched bytes and raw affected
paths.

## Finding classes

- `privacy`: names, personal domains, infrastructure identifiers, and other
  instance material covered by the hashed repository rules.
- `known_revoked_credential`: four historical object revisions match the
  hashed rule for a credential already documented as revoked.
- `credential_candidate`: historical text matches a credential shape used by
  the ingest secret scanner. This is a rotation-review queue, not proof that a
  value was live. Source code, test fixtures, and documentation can contain
  deliberately synthetic strings of the same shape.

There are 14 credential-candidate categories, one known-revoked credential
category, and 17 ordinary privacy categories. A private provider-side review is
required to decide whether any credential candidate was ever active and whether
rotation, revocation, or no action is appropriate. That review must not place a
secret or matched value in this repository.

Reviewed intentional scanner source, synthetic fixtures, and public
documentation examples may be recorded only by object ID and category in
`privacy/credential-dispositions.json`. The file is currently empty. It cannot
allowlist ordinary privacy or a known-revoked credential.

## Reachability by public ref

Credential counts combine candidates and the known-revoked category. One
object can carry both credential and privacy categories, so the two right-hand
columns do not sum to the total.

| Public ref | Finding objects | Credential objects | Privacy objects |
|---|---:|---:|---:|
| `refs/heads/codex/client-update-status` | 335 | 23 | 320 |
| `refs/heads/codex/cloudflare-brain-phase2` | 319 | 22 | 305 |
| `refs/heads/codex/cloudflare-brain-v0.1.12` | 191 | 12 | 186 |
| `refs/heads/codex/release-v0.2.0` | 335 | 23 | 320 |
| `refs/heads/codex/technician-setup` | 319 | 22 | 305 |
| `refs/heads/feat/golden20-backlog-guard` | 280 | 17 | 271 |
| `refs/heads/main` | 335 | 23 | 320 |
| `refs/heads/wave0/connector-gaps` | 359 | 24 | 343 |
| `refs/tags/v0.1.10` | 178 | 12 | 173 |
| `refs/tags/v0.1.11` | 181 | 12 | 176 |
| `refs/tags/v0.1.12` | 191 | 12 | 186 |
| `refs/tags/v0.1.15` | 246 | 16 | 238 |
| `refs/tags/v0.1.16` | 249 | 16 | 241 |
| `refs/tags/v0.1.17` | 252 | 16 | 244 |
| `refs/tags/v0.1.18` | 254 | 16 | 246 |
| `refs/tags/v0.1.19` | 260 | 17 | 251 |
| `refs/tags/v0.1.20` | 270 | 17 | 261 |
| `refs/tags/v0.1.21` | 277 | 17 | 268 |
| `refs/tags/v0.1.22` | 277 | 17 | 268 |
| `refs/tags/v0.1.23` | 280 | 17 | 271 |
| `refs/tags/v0.2.0` | 335 | 23 | 320 |

## Reproduction

The containment gate is deterministic and offline after the public-ref snapshot
has been reviewed:

```sh
npm run privacy:history
```

The authoritative read-only server comparison and strict release gate is:

```sh
npm run privacy:history:strict
```

The strict command currently fails by design. It must remain a release blocker
until approved remote remediation makes every public head and tag clean.

## Limits

- The scanner inventories all reachable objects but does not inspect binary
  blob bodies.
- It scans commit and tag messages but excludes author, committer, and tagger
  headers. Intended public contribution metadata needs a separate decision.
- GitHub pull-request refs, cached views, forks, clones, and search-engine
  caches are outside ordinary public head/tag enumeration.
- A shape match cannot establish whether a credential was active.
- A later clean commit cannot make an older object unreachable while any
  public ref still retains it.

Confidence is high for the public head/tag reachability and the deterministic
hashed privacy rules. Confidence is medium for credential status because only
provider-side custody records can distinguish synthetic examples from values
that were active.
