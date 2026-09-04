# The release gate

`/update` gets run often, by people we are not on a call with, at times we do
not choose. So the question a release has to answer is not "do the tests pass"
but "does an update finish on a brain shaped like the ones that exist".

Nothing is tagged until every line below is true, and the receipt is pasted
into the release PR.

## 1. The suite

Full `npm test`, `EXIT=0`, on the exact commit being tagged. The log goes in
`~/brain-work/doctor/logs/`, never `/tmp`, which is wiped and took a day of
receipts with it on 2026-09-03.

## 2. The update rehearsal, on a real brain

A throwaway brain provisioned at an old version, loaded, its outbox poisoned
into the not-yet-visible shape, then updated with the candidate. Required legs:

| Leg | From | Why |
|---|---|---|
| Floor | the oldest version any CLIENT brain runs | the worst case that actually exists |
| n-1 | the previous release | the common case, a client one release behind |

The floor is a fact about the field, not a preference. It moves up only when
the last client on that version has updated. As of 2026-09-03 it is **0.2.0**
(Lindsay). Brains built from a working branch are excluded by definition: no
published release can update them, and the schema guard refuses them.

A third leg from the oldest published tarball is worth running occasionally,
not every release.

## 3. The bytes under test are the bytes published

Hash the candidate tarball, hash the asset downloaded from the finished GitHub
release, and compare. Both machines did this independently on 2026-09-03 and it
is the property that makes the whole receipt mean anything: without it the
receipt describes a build nobody will ever install.

## 4. The receipt says what it did NOT cover

A receipt that lists only what passed is the same defect as a check that
reports its conclusion without its evidence. On 2026-09-03 the queued delete
row silently failed to be created, so the serial delete path was not exercised;
the receipt said so, and the release notes did not claim delete coverage.

## Harness rules, learned the hard way

- **Never edit a rehearsal script while it is running.** macOS bash reads a
  running script by byte offset. Editing one mid-run cost an hour on
  2026-09-02. Write a new file and fold it in afterwards.
- **Build injected SQL in a real language, not in shell quoting.** On
  2026-09-03 a `${VAR:+...}` expansion inside a double-quoted region emitted
  `'''upsert'''`, which SQLite read as an 8-character string including its
  quotes. The UPDATE matched nothing, succeeded, and reported success. A
  broken injection and a working one were indistinguishable in the output,
  which is the worst possible failure for a test harness.
- **Check the provision log before trusting anything after it.** A brain whose
  provision failed on a quota error still gets "updated" by the CLI, against an
  empty database, and every check after that describes nothing.
- **Treat a provider quota refusal as bench noise, not a code signal**, and say
  which it was in the receipt.
