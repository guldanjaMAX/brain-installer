# Client-facing paperwork, and how it is bound to a release

**Applies to release 0.1.22.**

Nothing in this directory is legal text, legal advice, or a claim that anything
is legally sufficient. This is a tracking mechanism. A founder writes the
documents and a lawyer reads them; what this repository can do is make sure the
documents exist, that each one says which release it describes, and that the
tool says so out loud when they do not.

## What is here today

`register.json`, and no artifact files. Every entry is in state `missing`. That
is the honest current state and the pre-install report prints it rather than
staying quiet about it.

## The problem this solves, which is narrower than it sounds

The paperwork problem is a founder's, not an engineer's. The part that IS an
engineering problem is this: a statement written against one release can be made
false by the next release. Adding one connector adds a company that receives the
client's material. A subprocessor list held in a folder, with no version on it,
gives a client no way to know whether it describes the code that is about to
read their archive.

So each artifact carries the same visible stamp the maintainer documents use:

```
**Applies to release 0.1.22.**
```

`operations/legal-register.mjs` measures the file rather than trusting the
register, and reports one of five states:

| State | Meaning |
|---|---|
| `missing` | the file the register names is not in the package |
| `unstamped` | the file exists and binds itself to no release |
| `stale` | stamped, but to a release other than the one running |
| `unapproved` | present and current, but no human approval is recorded |
| `ready` | present, stamped to this release, approved |

An approval is approval of a text describing one version. When the version
moves, the approval goes stale with it. That is deliberate, and it is why an
artifact recorded as `approved` whose stamp names an older release comes back
`stale` rather than `ready`.

## Where it surfaces

`brain preinstall`, the command that runs on the client's own machine days
before anything is provisioned. That is the last moment where "there is no
privacy notice" is a scheduling problem rather than something discovered after
a household's archive has already been read.

## What it deliberately does not do

**It does not decide whether an install may proceed.** The severity comes from
`blocks_install` in the register. Every entry is `false` today, each with the
reason written beside it, so the check is a warning and the pre-install exit
code is unchanged. Whether missing paperwork should stop an install is a
founder's call, and it is one boolean away from being enforced.

**It cannot see anything outside the installed package.** If signed paperwork
lives in a drive folder, an e-signature account or somebody's inbox, this
mechanism has no way to know. Every message it produces says "not in this
install" rather than "the client has no paperwork", and that distinction is not
a nicety: reporting an absence you cannot establish is the same defect as
reporting a health you did not verify.

## Adding an artifact

1. Write the document and put it at the path the register names.
2. Put `**Applies to release <version>.**` near the top, as its own line,
   matching the version in `package.json`.
3. Record the approval in `register.json` — only after a human has actually
   approved it. The register is where an approval is asserted, because no file
   can assert its own.
4. Add the file to `package.json` `files` and to the reviewed allowlist in
   `test/package-privacy.test.mjs`, so it is a deliberate addition to what a
   client receives rather than an accident of a directory entry.
5. Run `npm test`. `test/legal-register.test.mjs` will hold you to steps 2 and 3.
