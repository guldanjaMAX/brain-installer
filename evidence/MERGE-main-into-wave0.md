# Merging origin/main into wave0/connector-gaps, and the 0.2.0 bump

Two development lines ran in parallel on this repo and both reached a
`package.json` saying `0.1.22` while holding different trees. This is the
record of reconciling them.

## Why the histories diverged without the files conflicting

Both lines independently built WP-00 (checksum reconciliation), WP-02
(WhatsApp export) and WP-03 (SMS backup), as different commits with
byte-identical results:

```
$ git merge-base --is-ancestor origin/main HEAD   # before the merge
  -> NO (13 commits on main, 135 on this branch)
$ git diff origin/main HEAD -- ingest/sms-backup.mjs ingest/whatsapp-export.mjs
  -> IDENTICAL, both files
```

That is why this was a merge and not a rewrite.

## What main had that this line genuinely lacked

Five commits (#20-#24) found by installing on a clean VM, which is the one
class of bug a test tree cannot simulate. All are kept:

- `brain doctor` verifies the Cloudflare token against Cloudflare rather than
  reporting presence as readiness.
- `brain drain` gives a just-deployed worker a bounded warm-up before believing
  a 404 or 401, which was ending healthy clean installs with exit 1.
- `brain doctor` rejects unknown flags.
- `scripts/check-install-page-version.mjs`, `scripts/teardown-test-brain.mjs`,
  and the guard suites `unknown-flags`, `drain-exit`, `health-verify-exit`,
  `setup-clean-path`, `provision-guards`, `google-auth-storage`.

## The conflicts that were not mechanical

**`package.json`'s test chain** was rebuilt as a true union rather than a pick.
A previous resolver on this branch silently dropped `files` entries and would
have shipped a package missing `legal/`; that lesson is applied here. 111 steps
kept from this line, 1 added from main (`test/unknown-flags`), and every other
key (`files`, both dependency maps, any main-only top-level key) unioned
explicitly rather than by whole-file choice.

**`checkCfToken` became async**, so its caller in this tree awaits it. Its
assertion in `test/preinstall.test.mjs` now stubs `fetch`: the check is about
the wording the function returns, and a test must not depend on this machine
having a network, nor send even a bogus token to Cloudflare on every run.

**`DOCTOR_FLAGS` gained `"preinstall"`.** Main's new unknown-flag guard would
otherwise have rejected `brain doctor --preinstall`, which is a real command on
this line. The flag list was derived by reading every `flags.*` access inside
`dispatchDoctor`, not by guessing.

**The privacy scrub wins over main's wording** in `test/upgrade-repair.test.mjs`
and `test/checksum-reconciliation.test.mjs`. This line widened the privacy
scanner to cover `test/`, where the collaborator's first name is a flagged
identity, so main's phrasing would fail the suite. Confirmed there are no other
such references on main under `test/` or `worker/test/`.

**`ingest/run.mjs`** resolved to this line at all six hunks, but NOT via
`git checkout --ours`, which would have discarded main's auto-merged additions
elsewhere in the same file. Resolved hunk-by-hunk with a line-based parser and
then verified: the result keeps main's WhatsApp/SMS wiring (6 references) and
this line's mbox splitter and family reconciliation (7 references).

**`CHANGELOG.md`** keeps main's 0.1.20 through 0.1.22 entries verbatim. Those
are immutable published releases and their notes describe what actually shipped
under those numbers. This line's unreleased work moved to a new 0.2.0 section.

## Verification

Not only that the suite went green, but that main's fixes still behave:

```
$ node brain.mjs doctor <path> --nonsense-flag
  fail  unknown option --nonsense-flag for `brain doctor`.   (nonzero exit)
$ node brain.mjs doctor <path> --preinstall
  · checking this machine against everything install day needs.   (runs)
```

```
$ npm test > /tmp/mt5.log 2>&1; echo $?
0
$ grep -c '^PASS' /tmp/mt5.log   -> 4194
$ grep -c '^FAIL' /tmp/mt5.log   -> 0
$ grep -c '^not ok' /tmp/mt5.log -> 0
node:test pass=200 fail=0
```

Exit code captured to a file rather than read through a pipe, per this repo's
own lesson on that failure mode.

## The 0.2.0 bump, and a fixture it exposed

`0.1.22` is an immutable published GitHub release that means one specific
thing, and both trees claimed it. This line takes the next minor rather than a
patch: the merged tree adds live message capture, Zoom, IMAP, iPhone backup,
bank import with a ledger, OCR and recovery codes, and carries migrations
through 0022.

Recorded in `docs/release-gates.json` as `evidence_label: "internal"`,
`gates_met: []`, `published_as: null`. None of the six gates have been run
against this tree and nothing has been published. Whoever publishes must set
`published_as` and, if the gates still have not run, add an `overclaim_note`.

The bump exposed a real fixture bug. `test/upgrade-verify.test.mjs` hardcoded
`"0.2.0"` as the version that is newer than the running CLI, so the moment the
package became 0.2.0 the downgrade guard under test stopped firing, and two
checks failed for an unrelated-looking reason (a missing Cloudflare token).
That literal is now derived one minor above the running version, which is what
the file's own header comment already asked for after the same class of break
at 0.1.16.

Probed rather than assumed: forcing the derived value back to the running
version reproduces both failures (153/155); restoring it returns 155/155.

## Not done here

- Nothing was pushed. This rewrites what `wave0/connector-gaps` points at.
- Nothing was published to npm or GitHub releases, and `financialbrain-site`
  was not touched. Release sequencing belongs to whoever owns the publish.
- The six release gates have not been run against this tree.
