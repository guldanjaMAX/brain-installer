# Issue #7 evidence — the credential store is now round-tripped, and one report did not reproduce

Date: 2026-08-28. Branch `fix/security-batch`, built in an isolated worktree off
`wave0/connector-gaps`. Files touched for this issue:
`operations/credential-store-probe.mjs` (new), `operations/admin-key-file.mjs`,
`doctor.mjs`, `test/credential-store-probe.test.mjs` (new), and its one-line
registration in `package.json`.

## What the issue reported, and what was actually found

The issue makes three claims. They did not all hold.

**Claim 1: "The Windows credential path fails at unprotect."** NOT REPRODUCED on
a current Windows host. The shipped CI probe drives the production path — the
Node bridge, the compiled C# helper, the private build directory, the stdin
framing and DPAPI itself — with four fixed bytes and no credential. It passed on
`windows-latest` for both Node 22 and Node 24 in run 33204080505, today:

```
windows-latest / node 24  2026-08-28T19:29:45.8146085Z dpapi-probe result=pass stage=roundtrip timeout=no
windows-latest / node 22  2026-08-28T19:29:46.0793826Z dpapi-probe result=pass stage=roundtrip timeout=no
```

That is evidence about the bridge on a GitHub-hosted Windows runner. It is not
evidence about a client's laptop, where the contributing causes the issue names
— an executable compiled into and run from `TEMP`, a redirected profile — are
exactly the things a managed corporate machine does differently from a clean
runner. So the honest reading is: the mechanism works where we can see it, and
the field report remains unexplained rather than refuted.

**Claim 2: "`brain doctor` does not round-trip the store."** TRUE, and it was the
larger half. Nothing in `doctor.mjs` wrote a value and read it back. The unit
tests around the store all inject `runPowerShell`, which routes to the legacy
PowerShell helper and never reaches the production bridge, and the CI probe
exercises the bridge but not the store wrapped around it — the ACL, the
envelope, the staged verification. The store as a whole had never been
round-tripped anywhere.

**Claim 3: "`operations/cloudflare-token-store.mjs` is macOS only."** TRUE, and
UNCHANGED by this branch. `supported()` still requires `platform === "darwin"`,
so a Windows operator still types the Cloudflare token every run. A Windows
token store is a new credential surface with its own threat model and is not
something to add inside a three-issue batch; it is called out here so it is not
mistaken for closed.

## A real defect found while proving the above

Building the probe surfaced something small and genuinely diagnostic.
`verifySecretPayload` in `operations/admin-key-file.mjs` caught every decode
failure and reported one sentence:

```
the admin key staged payload could not be decoded and verified
```

A malformed envelope and "Windows refused to decrypt this for your account"
both produced that line. Those need different fixes from whoever is standing at
the machine, and the second one is precisely the failure this issue is about —
so the store's own message was hiding the reported symptom. DPAPI failures are
now tagged at the point they are raised (`taggedDpapiFailure`) and the
verification names the half that broke:

```
the admin key staged payload could not be decoded and verified: Windows DPAPI could not unprotect it for the current user
```

The tag travels, not the text. Nothing from the child process — no stderr, no
payload — is added; the messages remain the same fixed strings they already were.

## What was built

`operations/credential-store-probe.mjs` writes a fixed, published, non-secret
value through the real `writeAdminKeyFile`, reads it back through the real
`readAdminKeyFile`, and compares it exactly. Same private file creation, same
Windows ACL, same DPAPI protect and unprotect, same envelope encode and decode a
real admin key gets. It runs in a private temporary directory it creates and
removes, so it never approaches a manifest's `.brain-admin-key`, a Keychain item,
or the Cloudflare token store. It never throws: a diagnostic that takes the
machine down with it is not a diagnostic.

`checkCredentialStore` in `doctor.mjs` turns that into a line, wired into both
`runAll` (`brain doctor`) and `runPreinstall` (`brain preinstall`, the command
that runs on the client's bare machine days early). The line names which
platform's store it exercised, because a green line on macOS proves nothing
about Windows. A store that cannot round-trip is FAIL, not WARN — an install on
top of it would report success and leave a key nobody can read.

Two consequences worth stating. First, doctor's header used to say "Doctor never
creates anything", and that is no longer true; the comment now says what the one
exception is rather than being quietly falsified. Second, CI already runs `brain
doctor` on `windows-latest`, so from this commit forward every CI run
round-trips the real DPAPI store on a real Windows host, which is the thing that
had never happened.

## Discrimination

Break the comparison — `if (false && readBack !== CREDENTIAL_STORE_PROBE_VALUE)`
in `probeCredentialStore`, which is exactly the "check that a store exists"
behaviour the issue objects to:

```
FAIL  a store that returns a DIFFERENT value is caught by comparison (Expected values to be strictly equal:

true !== false
)
1 failure(s)
```

Restored: `all credential store probe tests passed`.

Break the DPAPI tag pass-through in `verifySecretPayload` (force the generic
branch):

```
FAIL  a Windows store that cannot unprotect is reported at the read stage (the message must name the half that broke, not just say it could not be decoded)
```

Restored: `all credential store probe tests passed`.

## Owner's note

I would rather ship a diagnostic that can fail than a claim that cannot. What
this branch buys is small and specific: on every machine an install touches,
before anything that matters is stored there, we write a throwaway value into the
store and read it back, and if it does not come back we say so and say which
half broke. The reported Windows failure did not reproduce on the hardware I can
see, and I am not going to write that up as fixed. What I can say is that if it
happens again it now happens in the diagnostic, with a sentence naming DPAPI and
the account, instead of three days later when the client asks why their brain
stopped answering. The Cloudflare token is still typed every run on Windows.
That is still open, and I would rather it stay open on the board than be closed
by a paragraph.
