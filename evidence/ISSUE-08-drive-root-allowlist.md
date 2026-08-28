# Issue #8 evidence — a Drive scope Google enforces, and a claim the docs no longer make

Date: 2026-08-28. Branch `fix/security-batch`, worktree off `wave0/connector-gaps`.
Files: `connectors/drive-scope.mjs` (new), `connectors/google-drive.mjs`,
`brain.mjs`, `manifest.schema.json`, three onboarding documents,
`test/drive-scope.test.mjs` (new), and two one-line registrations.

## The report was accurate

`exclusionReason` in `connectors/google-drive.mjs` is applied to files the
whole-Drive walk has already returned. `listFiles` asks Google for
`q: "trashed = false"` across `corpora: allDrives`, so the name, folder path,
size and id of every excluded file is fetched, travels through the installer,
and is written into the run's skip list. There was no include-allowlist
anywhere: `corpora.google_drive` accepted four kinds of exclusion and no
inclusion. Connecting Drive meant the whole Drive.

The contrast with Gmail is real. `connectors/gmail.mjs` puts its exclusions in
`DEFAULT_QUERY`, so excluded mail is never returned at all. "Excluded at the
source" was true there and overstated for Drive.

## What Google will and will not enforce

The Drive API has no "descendant of" operator, so a subtree cannot be expressed
as one `q`. It does have `'<id>' in parents`, so a subtree CAN be enforced at the
source as a bounded breadth-first descent: ask only about allowlisted folders,
then only about the folders those return. That is what `listFilesUnderRoots`
does. It costs one listing request per folder rather than one per thousand
files, which is the price of the guarantee.

The changes feed is the genuine limit. `/changes` is account-wide and takes no
folder filter of any kind, so an allowlisted install still RECEIVES changes for
files outside its scope. Those are refused on arrival in `brain.mjs`, after
their listing metadata has been seen and before anything is fetched or stored.
There is no API that would let it happen earlier. That asymmetry is now stated
in the code, in the schema, and in the client-facing documentation rather than
being covered by one word.

## What changed

**`corpora.google_drive.include_root_ids`.** Present: the full walk descends
from those folder ids and nowhere else. Absent: the whole Drive, unchanged,
because an empty allowlist that meant "index nothing" would silently break every
existing install. The scope is printed on EVERY Drive run, including the run
with no allowlist — `Drive scope: NO Drive root allowlist is configured, so this
run may read every file this Google account can see` — because an operator
should have to read that rather than infer it from silence.

**Ids are validated, not escaped.** A root id is interpolated into a `q`
expression. Anything outside `^[A-Za-z0-9_-]{6,256}$` stops the run. Dropping a
malformed entry quietly would change the scope of what gets read, in the
direction the operator cannot see, on the one setting whose whole job is to
bound what gets read.

**The allowlist is part of the policy fingerprint,** for the same reason OCR is:
widening it must force one full comparison, or newly permitted folders stay
invisible until something inside them happens to change.

**Unresolvable ancestry is OUTSIDE.** In the incremental gate, a file whose
parents cannot be resolved from the folder index is refused. Guessing in favour
of ingest is the wrong way to be wrong about a scope boundary.

**The rule lives in its own dependency-free module.** `connectors/google-drive.mjs`
pulls the PDF and Office readers at import time, which is why `brain.mjs` loads
it lazily; the installer needs the same rule at config time. One copy, two
importers.

## The documentation, corrected

- `07-ingest-source-matrix.md` no longer says "Excluded at the source. It is
  never read, not read and filtered". It now carries a paragraph naming, per
  source, where the refusal actually happens: Gmail in the query, Drive in the
  query when a root allowlist is set, Drive after listing when it is not, and
  Drive's incremental feed after delivery because Google offers nothing earlier.
- `01-intake-questionnaire.md` no longer tells the client "anything you name
  here is excluded at the source". It distinguishes the strong answer (name the
  folders it MAY read) from the ordinary one (name folders it may not), and says
  which to ask for if a filename must never leave their Google account.
- `06-runbook-top-ten-failures.md` entry 8d no longer says an excluded file "was
  never read"; it says content was never read and nothing was stored, and points
  at the matrix.

## Discrimination

Break the source-side scoping — replace the per-folder `q` in
`listFilesUnderRoots` with the unscoped `"trashed = false"`, i.e. exactly the
client-side-filtering behaviour the issue reports:

```
FAIL  a file outside the allowlist is never REQUESTED from Google (Expected values to be strictly deep-equal:
+ actual - expected

  [
    'doc-a1',
+   'doc-a1',
    'doc-a2',
+   'doc-a2',
+   'doc-secret',
+   'doc-secret',
    'folder-sub',
+   'folder-sub'
  ]
)
```

Restored: `all drive scope tests passed`.

Break the incremental gate's unknown-ancestry rule (`if (!folder) return true`):

```
FAIL  unresolvable ancestry is OUTSIDE, never given the benefit of the doubt (Expected values to be strictly equal:
1 failure(s)
```

Restored: `all drive scope tests passed`.

## What is NOT closed

The issue's second paragraph — which content classes get quarantined rather than
ingested — is a founder decision and no code here touches it. And the honest
limit of the allowlist is worth repeating: it bounds what is REQUESTED on the
full walk. On the incremental lane it bounds what is fetched and stored, not
what Google hands over.

## Owner's note

The word that was wrong was "source". We told clients that anything they named at
intake was excluded at the source, and for Gmail that was true and for Drive it
was not: we were pulling back every filename in their Drive and then deciding not
to keep some of them. Nobody's content leaked and nothing was stored that should
not have been, but a client who told me a folder must never be touched had been
given a stronger promise than the code was keeping, and they had no way to know
that. So now there is a setting that makes the promise real — name the folders
and nothing else is ever asked for — and the documentation says exactly where
each kind of exclusion bites, including the one place Google gives me no way to
enforce it and I have to catch it on arrival instead. If a name must never leave
their Google account, there is now one right answer and I can point at it.
