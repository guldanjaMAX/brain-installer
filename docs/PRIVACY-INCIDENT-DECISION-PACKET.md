# Privacy incident decision packet

> Historical predecessor-repository decision record. The clean lineage does
> not adopt this incident baseline or its public-ref manifest. Its active local
> and CI policy requires exactly zero finding objects.

Prepared for privacy counsel and repository-owner review. This packet records
technical facts and decision points. It is not a legal conclusion and contains
no matched personal data, credential, or raw affected path.

## Executive decision

The public repository's current tip and npm package are not the full exposure
boundary. The sanitized scan in `PRIVACY-INCIDENT-EVIDENCE.md` found 364
privacy or credential-shaped Git objects reachable from every one of the 21
server-visible public heads and tags.

No new release should be cut while `npm run privacy:history:strict` fails.
Tip-only cleanup is useful containment but cannot remove an older reachable
object.

Counsel and the repository owner need to choose one of these outcomes:

1. **Contain and disclose as required.** Keep history stable, retain the
   baseline gate, privately validate credential candidates, and make any
   required notices. This preserves immutable release URLs but leaves the
   historical objects public.
2. **Purge public Git history.** Approve a coordinated rewrite of every
   affected head and tag, retire immutable releases that lock affected tags,
   ask GitHub Support to purge cached pull-request references, and require all
   collaborators to replace or clean old clones. This disrupts commit IDs,
   signatures, pull-request diffs, release URLs, and downstream clones.
3. **Change visibility as temporary containment.** This may reduce casual
   discovery but does not retract existing clones, forks, caches, or previously
   published release assets. It is not a substitute for either decision above.

## Facts established

- Public head/tag enumeration was compared read-only with the server. One local
  backup tag was excluded because it is not public.
- All 21 public heads and tags retain finding objects.
- Four object revisions match the hashed known-revoked credential rule.
- Fourteen other categories are credential-shape candidates. They are not
  evidence that a value was active.
- Seventeen categories are ordinary privacy or instance data, including names,
  domains, and infrastructure identifiers.
- No history rewrite, ref deletion, visibility change, GitHub contact, token
  action, provider action, or remote setting change occurred in this work.

Confidence is high for object reachability and medium for credential status.
Only a private provider-side review can establish whether a candidate was
active, expired, synthetic, rotated, or revoked.

## Counsel questions

1. Which affected people and data categories are in scope, and which
   jurisdictions or contracts govern notice?
2. Does the current evidence require individual, customer, insurer, regulator,
   or contractual notice?
3. May maintainers inspect matched values privately to validate scope, or must
   that inspection be performed by counsel or a designated incident responder?
4. Which credential candidates require provider-side status checks or rotation,
   and who is authorized to perform them?
5. Must existing public release assets and tags be preserved for legal hold or
   customer continuity before any purge?
6. Should intended public Git author/committer metadata be treated separately?
   The scanner excludes those headers while scanning commit and tag messages.
7. Are forks, cached pull-request views, third-party mirrors, or search caches
   material enough to require separate requests or notices?
8. What exact privacy, terms, security, and analytics-consent language should
   appear on public and pre-authentication surfaces? The implementation must be
   checked against observed network behavior after counsel supplies the copy.

## Immediate containment already safe to merge

- One canonical hashed identity policy now drives current-tree and history
  scanning.
- Package output, all tracked text, paths, and full reachable history have
  separate gates.
- CI pins every workflow action to a reviewed commit and uses read-only token
  permissions.
- `SECURITY.md`, `CODEOWNERS`, and Dependabot configuration establish a review
  and intake boundary.
- The strict history-clean release command exists and remains red by design.

These controls prevent silent regression. They do not purge current history.

## Staged remote-remediation sequence

There is no fully reversible sequence once an immutable GitHub release is
deleted. GitHub documents that an immutable release locks its tag; after the
release is deleted, the tag can be deleted but the same tag name cannot be
reused. The sequence below therefore has a reversible preparation phase and an
explicit irreversible cutover.

### Phase A: reversible preparation

1. Obtain written approval naming the repository, affected ref set, incident
   scope, credential reviewer, communication owner, rollback owner, and exact
   cutover window.
2. Freeze merges, tags, releases, and automated dependency updates. Record the
   current ruleset, branch protection, release, and public-ref state without
   changing it.
3. Preserve the existing repository and worktrees. Do not garbage-collect them.
   After approval, create local-only rollback refs in the existing object
   database for every entry in `privacy/public-refs.json`. Do not push those
   rollback refs.
4. If counsel authorizes matched-value handling, create a mode-0600 replacement
   map outside every repository and synced folder. The map contains the exact
   sensitive values and synthetic replacements. Never put it in a command,
   commit, issue, log, or chat.
5. Privately adjudicate credential-shape candidates. Record only reviewed
   synthetic fixture, scanner-source, or public-documentation object IDs and
   categories in `privacy/credential-dispositions.json`. Rotate or revoke any
   candidate that provider-side evidence shows was active. Do not record the
   value.
6. In a new private remediation clone, run the current `git-filter-repo`
   sensitive-data workflow against all heads and tags. Use the private map by
   file path, not by value on the command line. Preserve the tool's sanitized
   changed-commit map for the GitHub Support request.
7. In the rewritten clone, run:

   ```sh
   node scripts/scan-git-history-privacy.mjs \
     --ref-prefix refs/heads --ref-prefix refs/tags --require-clean
   npm ci --ignore-scripts
   npm test
   npm audit --offline
   npm pack --dry-run --json --ignore-scripts
   ```

8. Require an independent reviewer to compare the old and rewritten public ref
   inventory, confirm every intended branch remains, inspect the exact package,
   and verify that only approved privacy replacements changed product behavior.
9. Prepare collaborator instructions: stop pushes, archive uncommitted work,
   replace the clone after cutover, and rebase clean work. Never merge an old
   branch into rewritten history because that can restore the incident.

Every step above can be abandoned without changing GitHub.

### Phase B: controlled remote cutover

1. Put the main and release ruleset into its temporary incident-remediation
   mode. Allow only the named repository owner to bypass force-push protection.
   Keep all other actors blocked and keep an export of the prior ruleset.
2. Force-update each affected branch individually with an exact expected old
   tip using `--force-with-lease=<full-ref>:<old-tip>`. Never use an unqualified
   `--force`, `--mirror`, or wildcard push.
3. Delete affected non-immutable tags individually only after the rewritten
   branches are visible and the strict server-ref scan passes for heads.
4. At the irreversible checkpoint, decide the immutable release outcome. If
   purge is required, delete the affected immutable release through the
   approved GitHub owner session, then delete its tag. Accept in writing that
   the old tag name and immutable asset URL cannot be restored or reused.
5. Do not recreate historical version tags on rewritten commits. Publish a new
   replacement version after clean-history CI and provenance attestation pass.
6. Contact GitHub Support with the repository, sanitized changed-commit map,
   affected pull-request references, and confirmation that affected refs were
   rewritten. Request cached-view removal and server garbage collection. GitHub
   notes that force pushing alone does not remove cached pull-request views or
   copies in forks and clones.
7. Require every collaborator to replace or clean old clones before push access
   returns. Verify no old commit becomes reachable from a new public ref.
8. Restore the exact normal ruleset, remove the temporary bypass, re-enable
   Dependabot, and run the authoritative strict scan again.
9. Cut the replacement release only from the exact clean commit and record its
   artifact digest, attestation, six-job CI result, and field-proof limits.

### Rollback boundary

Before GitHub garbage collection and before immutable-release deletion, branch
tips can be restored from the local rollback refs with the same per-ref
force-with-lease discipline. This restores repository reachability and must be
treated as deliberate re-exposure.

After immutable-release deletion, full rollback is impossible because the old
tag name and asset URL cannot be reused. After GitHub cache purge or clone
replacement, external copies may also differ permanently. Approval for Phase B
must acknowledge those points explicitly.

## Authoritative guidance

- [GitHub: Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [GitHub: Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub: About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [GitHub: Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
