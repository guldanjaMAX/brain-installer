# Release governance

This is the exact repository-control plan for the next public release. The
checked-in files implement the local and CI portions. Repository settings,
rulesets, release publication, and attestations remain unapplied until the
repository owner approves those remote actions.

## Current hard stop

This clean lineage has one policy: exactly zero finding objects.
`npm run privacy:history` scans the checked-out candidate and supports local
bootstrap before a remote exists. `npm run privacy:history:strict` scans every
server-visible head and tag plus that exact checkout. A finding, baseline,
disposition, missing server object, or shallow checkout blocks release.

The predecessor repository's sanitized baseline, public-ref manifest, and
incident packet remain in this tree as historical evidence only. No active
history gate uses them to decide acceptance. The unit suite validates that the
preserved evidence stays sanitized; it must not be refreshed or repurposed as
an exception path for this lineage.

## Required local and CI gates

Every pull request that can reach a release line must pass:

1. `public git history zero findings`;
2. `windows-latest / node 22`;
3. `windows-latest / node 24`;
4. `macos-latest / node 22`;
5. `macos-latest / node 24`;
6. `ubuntu-latest / node 22`; and
7. `ubuntu-latest / node 24`.

Before tagging, run the strict server-ref scan, `npm ci --ignore-scripts`, the
complete `npm test`, `npm audit --offline`, the npm pack dry run, a real tarball
install in a clean user-owned prefix, and the named field gates. Fixture and CI
success do not satisfy a provider, physical passkey, browser, or customer-data
field gate.

Both Windows matrix jobs must also pass
`node scripts/windows-dpapi-release-gate.mjs`. This is the shipped production
compile, protect, unprotect, exact-readback, and cleanup path for 25 fresh
rounds. Its output is limited to stable stage codes and counts. A CI pass does
not replace the supervised 25-round clean-client field gate, and a named stage
is diagnostic evidence rather than proof that the underlying failure is fixed.

## Proposed branch ruleset

Create one active repository ruleset named `main-and-release` with these exact
targets:

- include `main`;
- include `codex/release-*`;
- exclude no matching branch.

Normal enforcement:

- require a pull request before merge;
- require one approving review;
- require review from CODEOWNERS;
- dismiss stale approvals when new commits are pushed;
- require all seven status checks named above;
- require conversation resolution;
- require linear history;
- block force pushes;
- block deletions; and
- do not allow a standing bypass for ordinary development.

Do not configure a privacy-history rewrite bypass on the clean repository. If a
finding is pushed, stop release work and follow a separately approved incident
response rather than normalizing the object into a baseline.

Create a second tag ruleset named `version-tags` targeting `v*`:

- restrict creation to the repository owner;
- restrict updates;
- restrict deletions;
- block force pushes; and
- require a signed annotated tag after every release gate passes.

Immutable release behavior can override tag operations. Do not weaken the tag
ruleset as a workaround.

## CODEOWNERS and security intake

`.github/CODEOWNERS` assigns the repository and its security, privacy,
dependency, migration, package, and release boundaries to the current public
repository owner. If maintenance moves to an organization, replace that actor
with a dedicated visible security/release team before enabling required
CODEOWNERS review.

`SECURITY.md` prefers GitHub's private reporting flow when the repository offers
it and gives a no-detail fallback while that remote setting is disabled. Enable
private vulnerability reporting only with owner approval and record the
readback. Do not route a live secret, private data, exploit detail, or customer
identifier through a public issue.

## Dependabot plan

`.github/dependabot.yml` proposes two weekly update streams:

- npm dependencies at 14:00 America/Phoenix on Monday; and
- GitHub Actions at 14:30 America/Phoenix on Monday.

Each stream is limited to five open pull requests. Dependabot does not bypass
CODEOWNERS, privacy, package, cross-platform, or full-history gates.

After this configuration reaches the default branch, separately review the
repository Security settings and enable Dependabot alerts and security updates
only with owner approval. Record that external change. Do not grant Dependabot
a ruleset bypass beyond creating its pull requests.

## Workflow action pinning

Every current workflow action is pinned to a reviewed commit, not a mutable
major tag. Workflows default to `contents: read`, checkout does not persist its
credential, dependency caches are off where unnecessary, and jobs have bounded
timeouts.

Dependabot may propose newer action commits. Review the upstream release and
source diff, update the explanatory version comment, and require all gates. Do
not accept a mutable tag in place of a commit SHA.

## Public-surface acceptance queue

A prior live audit reported the following gaps. They were not revalidated or
changed by this local governance work. Recheck the exact deployed hostname and
response before implementation because live state can drift:

1. `/privacy`, `/terms`, and `/security` returned 404. Require reviewed,
   accurate pages before public acceptance. Legal wording requires counsel.
2. Plain HTTP returned content instead of redirecting to HTTPS. Require a
   permanent redirect and verify the final HTTPS response.
3. Unauthenticated `/health` exposed configured Brain identity, version, and
   state. Reduce the public response to the minimum liveness signal needed for
   operations, with detailed state behind authentication.
4. The pre-auth `/app` shell exposed configured client identity. Make the shell
   generic and `noindex`; disclose client context only after authentication.
5. Analytics transmission and consent copy were reported to disagree. Observe
   the real pre-consent and post-consent network behavior, then make behavior,
   controls, and copy agree. Do not infer compliance from banner text.
6. Release verification was not bound to the deployed artifact. Record the
   release tag, commit, artifact digest, attestation, deployed Worker version,
   and post-deploy readback as one acceptance record.

These are live field gates, not fixture claims. Do not deploy a fix, alter
analytics, or publish legal copy without the named owner and counsel approvals.

## Release artifact and provenance design

After the history is clean, add one tag-triggered release workflow with these
properties:

1. Trigger only from a `v*` tag already covered by the tag ruleset.
2. Set `contents: read`, `id-token: write`, and `attestations: write`; grant no
   package, issue, pull-request, or deployment permission.
3. Pin checkout, Node setup, artifact upload, and `actions/attest` to reviewed
   commit SHAs.
4. Install with `npm ci --ignore-scripts` and run the strict server-ref history
   gate, complete suite, offline audit, packlist inspection, real tarball build,
   and installed CLI smoke test.
5. Compute the tarball SHA-256 inside the job and generate a GitHub artifact
   attestation with that exact tarball as `subject-path`.
6. Upload only the tarball, digest file, sanitized test summary, and attestation
   reference. Do not upload manifests, receipts from owner installs, support
   exports, private evaluations, source corpora, or matched privacy evidence.
7. Create a draft release first. A human verifies tag, commit, six matrix jobs,
   strict history, tarball digest, installed CLI, attestation, and field-proof
   boundaries before publication.
8. After publication, independently download the public asset, compare its
   digest, verify the attestation with `gh attestation verify`, install it in a
   clean prefix, and only then update the public install and update pages.

The attestation proves where the tarball was built and which workflow/commit
produced it. It does not prove the application is vulnerability-free, a
provider integration works, a passkey ceremony succeeded, or a customer install
is accepted.

## Reversible remote-change checklist

For each ruleset, security setting, Dependabot setting, or release workflow
change:

1. export or screenshot the exact prior setting;
2. name the owner, reason, timestamp, and rollback action;
3. apply one change;
4. read it back through GitHub;
5. run or observe the smallest relevant check; and
6. roll back immediately if readback differs from the reviewed plan.

No remote setting in this document was changed as part of the local governance
work.
