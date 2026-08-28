# Issue 16: no version-bound legal and privacy artifacts before another household's archive is processed

## What the report said, and what I actually found

The report is right, and I could not soften it anywhere. There are no client
terms, no privacy notice, no data-processing terms, no named subprocessor list
and no retention or deletion policy in this repository. Not stale ones. None.

```
$ grep -rniE "privacy notice|subprocessor|data processing terms|client terms|retention and deletion policy" \
    --include=*.md onboarding/ docs/ README.md
```

The only hits anywhere in the tree are engineering uses of the word "privacy"
(package privacy tests, privacy-safe support journal), one paragraph in
`onboarding/05-handoff-and-revocation.md` about platform retention after a
delete, and one line in the source matrix. Nothing a client signs. Nothing a
client is shown.

What a client is currently shown before their archive is read, established by
reading the onboarding sequence end to end: an intake questionnaire, an effort
and timeline one-pager, a kickoff script, a "what it can and cannot answer"
page, and a handoff and revocation runbook. `onboarding/01-intake-RUNBOOK.md`
lists five things to send after the intake call and none of them is paperwork.
So the honest answer to "what would a client have to sign or be shown before
their archive is read" is: nothing, today.

**Is any artifact bound to a version?** No, because there is no artifact. And
the mechanism did not exist either: before this change nothing in the tree could
express "this document describes release X", so even a perfect document dropped
in tomorrow would have been unbound.

**About the founder-held draft.** A data protection and subprocessor statement
was drafted recently and lives outside this repository, in a founder's working
folder. I read it in full. It is serious work: it was written by reading the
shipped code rather than by asking what the product intends, it carries its own
version binding in prose, and it names its own gaps rather than resolving them
in the flattering direction. It is also explicitly marked unsigned, explicitly
not for a client, and its own closing checklist has twenty-two items that must
happen before it is client-ready — including item 19, "decide where the signed
version lives, and version bind it to the release it describes", with the
recommendation being "in the repository, with the version in the title".

I did not copy it in. It names real people and a real client, this repository is
public, and a draft nobody has signed is not the artifact a mechanism should be
built to serve. What I built is the place item 19 asks for, and the enforcement
that makes the binding real rather than a filename convention.

## What I built, and what it deliberately does not do

**It does not write legal text and it makes no claim of legal sufficiency.**
Both statements are in the code, in the register, in the shipped README, and in
the text the operator reads on screen. A founder writes these documents and a
lawyer reads them.

The engineering problem is narrower than the legal one and it is real: a
statement written against one release can be made false by the next release. One
connector added is one more company that receives the client's material. A
subprocessor list sitting in a folder with no version on it gives a client no
way to know whether it describes the code about to read their archive.

| File | What it does |
|---|---|
| `legal/register.json` | Names the five required artifacts, who supplies each, what a human must actually write, and whether each blocks an install with a written reason when it does not. |
| `legal/README.md` | The mechanism, the five states, and how to add an artifact. Stamped, so it goes stale with the release like everything else. |
| `operations/legal-register.mjs` | Measures each artifact from the file rather than trusting the register: `missing`, `unstamped`, `stale`, `unapproved`, `ready`. |
| `doctor.mjs` | `checkClientPaperwork`, wired into `runPreinstall`. |
| `test/legal-register.test.mjs` | 31 checks, executed against real files in real temporary directories. |

The binding reuses the stamp introduced for the maintainer docs, the visible
line `**Applies to release 0.1.22.**`. Visible rather than an HTML comment on
purpose: a binding a reader cannot see is not a binding.

**An approval goes stale with the version it approved.** An artifact recorded
`approved` whose stamp names an older release comes back `stale`, not `ready`.
That is the whole point. Somebody approved a text describing one version of the
code; the code moved.

**Where it surfaces: `brain preinstall`.** That command already runs on the
client's own machine, days before anything is provisioned, and already has the
four-state model this needs — including `CANNOT CHECK` for things genuinely
unknown from there. It is the last moment where "there is no privacy notice" is
a scheduling problem rather than something discovered after a household's
archive has been read. Live output:

```
  WARN          Client paperwork          5 of 5 not ready for 0.1.22, 5 absent
```

and in the warnings section, per artifact, what it is, who supplies it, and what
they must write.

**Two things it refuses to do, both deliberate.**

*It does not decide whether an install may proceed.* Severity comes from
`blocks_install` in the register. All five are `false` today, each with a written
reason, so this is a warning and the pre-install exit code is unchanged.
Whether missing paperwork should stop an install is a founder's decision about
their own business and I did not make it for them. It is one boolean away, and
the test proves the boolean works: flipping one to `true` turns the same finding
into a `FAIL` and makes `preinstallExitCode` return 1.

*It never asserts an absence it cannot establish.* It reads files inside the
installed package. Paperwork in a drive folder or an e-signature account is
invisible to it. Every message says "not in this install", never "the client has
no paperwork", and the on-screen text says so explicitly. Reporting an absence
you cannot verify is the same defect as reporting a health you did not verify.

## A real defect the tests caught while being written

`checkClientPaperwork` originally wrapped only the register LOAD in its
try/catch, and called `evaluateLegalRegister` outside it. `evaluateLegalRegister`
re-validates, so an injected or malformed register threw past the handler and
took the entire `brain preinstall` run down with an unhandled error, instead of
producing the single `CANNOT CHECK` finding it was written to produce. Fixed by
moving the evaluation inside the try. The test that found it
("a register that does not validate is also CANNOT CHECK") is in the suite.

## Discrimination

**1. Ignore the release binding — treat any present, approved file as current.**

```
$ # evaluateArtifact: drop the unstamped and stale branches, return "ready"
$ node test/legal-register.test.mjs
FAIL  a file with no stamp is unstamped, not ready
FAIL  a file stamped to another release is stale even when the register says approved  {"id":"SUBPROCESSOR-LIST","state":"ready","stamped":"0.1.16",...}
FAIL  and the next release makes every one of them stale again  {"version":"0.1.23",...,"state":"ready","stamped":"0.1.22",...}
28/31 legal-register checks passed
```

Restored: `31/31`, exit 0.

**2. Report the paperwork check as passing regardless of what exists.**

```
$ # checkClientPaperwork: return OK before the satisfied test
$ node test/legal-register.test.mjs
FAIL  the pre-install check runs and does not report OK while nothing exists  "5 client document(s) present and stamped to 0.1.22"
FAIL  it says what is not ready and for which release
FAIL  it says the absence is about this install, not about the engagement
FAIL  it disclaims legal sufficiency rather than implying it
FAIL  flipping blocks_install turns the same finding into a blocker
FAIL  and a blocker makes the pre-install exit code non-zero
FAIL  and it is not reported as passing  {"name":"Client paperwork","status":"ok",...}
24/31 legal-register checks passed
```

Restored: `31/31`, exit 0.

Worth noting what the second break also showed: `test/preinstall.test.mjs`
stayed green through it. A check that silently reports OK is invisible to a
suite that only counts checks, which is why the assertions here are about the
status and the words, driven through the real `runPreinstall`.

## WHAT A HUMAN MUST STILL SUPPLY

Nothing below is engineering work and none of it is unblocked by this change.

1. **The five documents themselves.** Client terms, privacy notice, data
   processing terms, named subprocessor list, retention and deletion policy.
   `legal/register.json` carries, per artifact, what each has to cover. Written
   by the founders; the data processing terms are the one most likely to need a
   lawyer rather than a careful founder.
2. **Counsel's review, before any of them reaches a client.** Nothing in this
   repository establishes legal sufficiency and nothing in it should be read as
   trying to.
3. **A decision on whether missing paperwork stops an install.** One boolean per
   artifact in the register. It is `false` today with the reason recorded, and
   changing it is a founder's call, not a code change.
4. **An owner for re-running the subprocessor audit at each release, and a
   written trigger for it.** A new outbound host is the obvious one. The stamp
   makes a stale list visible; it does not make anyone re-read the code.
5. **Answers to the questions the code cannot answer.** The founder-held draft
   lists these and they remain open regardless of this mechanism. The largest is
   the platform's own retention and training posture for material sent to its
   models on every default install: that is a contract question with the
   platform, and nothing in the code speaks to it.
6. **A decision about whether the signed documents live in this public
   repository at all.** The register points at paths inside the package, which
   is what makes the binding checkable on a client's machine, but a signed
   agreement carrying an entity name and an address may belong somewhere else
   with only a stamped, non-identifying summary shipped. That is a founder's
   call and the register can point wherever they decide.

## In my own words

This is the one of the three where I had to be most careful not to look
productive. It would have been easy to write five confident documents, stamp
them, mark them approved and leave a green line on the report. That would have
been worse than the current state, because a client would then be shown
paperwork nobody qualified had read, carrying this product's own version binding
as if that were an assurance.

So the deal I made with myself is that the mechanism can be as strict as I like
and the content stays empty until a human fills it. The result is a tool that
says, on the client's own machine, days before install: five of the five
documents you owe this person do not exist for this version. That is not a fix.
It is the absence made impossible to walk past, which is the most an engineer
should be doing to somebody else's legal obligations.

The part that will actually bite is the staleness rule, and I want it on the
record that I chose it knowing that. Once these documents exist, every release
un-readies all five and the pre-install report goes yellow again until somebody
re-reads the code and re-stamps them. That is annoying by design. A subprocessor
list is exactly the kind of document that is true when written and false two
releases later, and the annoyance is the only thing standing between a client
and a signed statement that quietly stopped being accurate.
