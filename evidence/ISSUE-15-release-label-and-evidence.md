# Issue 15: releases labelled production while their own documents list unfinished gates

## What the report said, and what I actually found

The report said three releases since v0.1.16 shipped as production with no
evidence manifest, and that the developer and maintainer guides still identified
as 0.1.16 while package, changelog and install links named the current release.

Both halves are true. The count is four, not three.

Published releases, read from the repository's own release list on 2026-08-28:

```
$ gh release list --repo <this repo> --limit 15
Brain Installer 0.1.19	Latest	v0.1.19	2026-08-27T17:28:14Z
Brain Installer 0.1.18		v0.1.18	2026-08-27T13:44:09Z
Brain Installer 0.1.17		v0.1.17	2026-08-27T03:01:51Z
Brain Installer 0.1.16		v0.1.16	2026-08-26T03:20:57Z
Brain Installer 0.1.15		v0.1.15	2026-08-26T01:19:57Z
v0.1.12				v0.1.12	2026-08-25T08:13:09Z
Brain Installer 0.1.11		v0.1.11	2026-08-25T05:57:08Z
Brain Installer 0.1.10		v0.1.10	2026-08-25T04:59:40Z
```

What each of the four claims, in the only field an operator can read:

```
v0.1.16 draft=false prerelease=false immutable=true assets=1
v0.1.17 draft=false prerelease=false immutable=true assets=1
v0.1.18 draft=false prerelease=false immutable=true assets=1
v0.1.19 draft=false prerelease=false immutable=true assets=1
```

There is no `preview` or `internal` marker anywhere on any of them. GitHub has
exactly one such marker, `prerelease`, and it is false on all four. So the claim
is not implicit: each of these presents to an operator as a finished release.

What the evidence directory holds, in full:

```
$ git log --oneline --name-only -- docs/release-evidence
2789efa Record v0.1.15 release evidence
docs/release-evidence/v0.1.15-cloudflare-recovery-gate.json
docs/release-evidence/v0.1.15-<elided>-shared-preview-gate.json
73c913c Record verified Cloudflare recovery field gate
docs/release-evidence/v0.1.13-cloudflare-recovery-gate.json
ab47a97 Bind recovery evaluation suite across resumes
docs/release-evidence/v0.1.13-cloudflare-field-gate.json
d97cb1f Record reproducible Cloudflare release field gate
docs/release-evidence/v0.1.12-cloudflare-field-gate.json
```

One filename is elided above: a tracked evidence file from 0.1.15 carries a real
collaborator's given name in its own filename and in its body. That is a
pre-existing exposure in a public repository, it is outside this issue, and
`test/package-privacy.test.mjs` documents in its own header why the identity
scan has not yet been widened to `docs/release-evidence/`. I did not bundle that
decision into this change. No gate in the new manifest references that file, so
0.1.15 records only the recovery drill.

Nothing after 0.1.15. So 0.1.16, 0.1.17, 0.1.18 and 0.1.19 each published as an
ordinary immutable release with no evidence artifact of any kind.

And the contradiction sat in the same tree. Before this change,
`docs/MAINTAINER.md` said:

> Do not describe 0.1.16 as live or recovery-verified merely because these files
> or deterministic tests exist. The exact candidate still requires its disposable
> provider field gate, recovery drill evidence, six-job CI matrix, immutable
> release artifact verification, and each install's private release evaluation.

Five named gates, unmet, in a guide that also still identified itself as the
0.1.16 line — three releases after 0.1.16 had shipped.

The version drift the report named, measured before the change:

```
$ grep -rnE "0\.1\.1[3-6]" docs/MAINTAINER.md docs/README-developer.md
docs/README-developer.md:8:**Status: 0.1.16.** Provisioning, retrieval, ...
docs/MAINTAINER.md:4:It describes the 0.1.16 product line, ...
docs/MAINTAINER.md:43:## The 0.1.16 architecture
docs/MAINTAINER.md:78:The 0.1.16 candidate keeps the 0.1.14 ...
docs/MAINTAINER.md:155:Do not describe 0.1.16 as live or recovery-verified ...
docs/MAINTAINER.md:160:The code line is not a release merely because `package.json` says `0.1.16`.
```

`test/current-version.test.mjs` already pinned package, lockfile, manifest
template, changelog heading and both README install links to one version. It did
not look at `docs/` at all, which is precisely why this drift survived six
releases without anything going red.

## Which way I resolved it, and why

The label changed, not the gates. The gates in the maintainer guide are the
right gates; nothing about them is unreasonable or unsatisfiable. What was wrong
was a release presenting itself as finished while they were open.

Retroactive correction is not available and I did not pretend otherwise. A
published GitHub release is immutable; 0.1.16 through 0.1.19 cannot be
relabelled. So the record now states plainly that they were published as
production on internal-grade evidence, and the mechanism makes the same thing
impossible to do quietly again.

One gate is deliberately non-blocking, and the manifest says why in writing:
`PRIVATE-EVAL`, an install's own release evaluation against its own corpus.
Nobody cutting a release can satisfy it, because it runs against private client
material that must never leave the client's account. Treating it as blocking
would make every release permanently ungated, which is the failure the report
predicted for any unsatisfiable gate. It is listed rather than dropped so that a
green release label is never mistaken for a statement about any install's
answers.

## What changed

| File | Change |
|---|---|
| `docs/release-gates.json` | New. The six gates, whether each blocks, the written reason for the one that does not, and the recorded label plus met-gate list for every release from 0.1.12 to 0.1.22. |
| `operations/release-state.mjs` | New. Validates the manifest, computes the label a version's evidence supports, compares it to the recorded claim, and renders the one line a person reads. |
| `test/release-state.test.mjs` | New. 37 checks. Recomputes every recorded label from the real evidence directory and fails when a claim is larger than its proof. |
| `test/current-version.test.mjs` | Now also requires the developer and maintainer guides to carry `**Applies to release <version>.**` matching the package version. |
| `docs/MAINTAINER.md` | Stamped. The 0.1.16 identity claims made version-neutral, the gate list replaced by a pointer to the manifest, and a new section on what a release may claim. |
| `docs/README-developer.md` | Stamped. `Status: 0.1.16` replaced by the stamp plus the computed label and how it is computed. |
| `brain.mjs` | `cmdWhatsnew` prints the recorded label before the changelog when it is not production, and says so out loud when the record cannot be read. |
| `package.json`, `test/package-privacy.test.mjs` | The gate manifest added to the package allowlist in both places. |

The label cannot be raised by editing prose. `evidence_label` and `gates_met`
are both recomputed from the filenames actually present in
`docs/release-evidence/`, so the only way to move a release from internal to
production is to add the evidence files.

The evidence directory is deliberately NOT in the package allowlist, so an
installed CLI cannot recompute anything. That is why the label is recorded as
well as computed, and why `recordedReleaseState` is a separate function from
`evaluateReleaseState`: handing the evaluator an empty file list on a client
machine would compute "internal" for every release and present it as a
measurement. The wording of the banner says "recorded", never "verified".

## Discrimination

Break the thing that was fixed, confirm the matching test fails.

**1. Claim production for the current release without adding any evidence.**

```
$ python3 -c "... d['releases']['0.1.22']['evidence_label']='production' ..."
$ node test/release-state.test.mjs
FAIL  no recorded release claims more than its evidence supports  0.1.22: recorded production, evidence supports internal
FAIL  and the current candidate is not recorded as production while its gates are open  {"version":"0.1.22","recorded":"production",...,"blocking_unmet":["CI-MATRIX","ARTIFACT-DIGEST","FIELD-DISPOSABLE","RECOVERY-DRILL","WINDOWS-INSTALL"],...,"agrees":false}
FAIL  a non-production release announces its label  null
FAIL  and says how many gates are open  null
FAIL  whatsnew prints the recorded label for a non-production release
32/37 release-state checks passed
```

Restored: `37/37`, exit 0.

**2. Return the maintainer guide to the version it actually carried.**

```
$ sed -i '' 's/^\*\*Applies to release 0\.1\.22\.\*\*$/**Applies to release 0.1.16.**/' docs/MAINTAINER.md
$ node test/current-version.test.mjs; echo $?
AssertionError [ERR_ASSERTION]: docs/MAINTAINER.md is stamped to a release other than the package version
'0.1.16' !== '0.1.22'
1
```

Restored: exit 0.

The suite also executes the wired command rather than grepping for its wording:
`cmdWhatsnew` is imported and run against a temporary gate manifest, and the
tests assert that a production record prints nothing, a non-production record
prints the label before the changelog, and an unreadable or invalid record says
so rather than rendering identically to a clean release.

## In my own words

The uncomfortable part of this one is that the code was fine. Four releases of
genuine work went out, and the only thing wrong with them was that they said
more about themselves than anyone had checked. That is a cheaper problem than a
broken release and a worse one to leave alone, because it teaches an operator
that the label is decoration. Once the label is decoration, the next real gate
failure reads exactly like the last four that were fine.

So the fix is not a better sentence in a guide. It is that the sentence is now
computed. Nobody has to remember to downgrade a label, and nobody can upgrade
one by feeling ready. The evidence file exists or it does not, and the suite
reads the directory.

What I did not do: I did not run any of the six gates, so 0.1.22 is recorded as
`internal` and every gate is open. That is not a defect in this change, it is
the honest current state, and it is now the state the tool reports to anyone who
runs `brain whatsnew`.
