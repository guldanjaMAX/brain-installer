# WP-15 — a way back in when every device is gone (issue #11)

Branch `fix/issue11-passkey-recovery`. Migration 0019. Worker routes
`/auth/recover/options`, `/auth/recover/verify`, `/api/app/recovery-codes`,
`/api/admin/auth/recovery-codes`. CLI `brain recovery-codes <manifest>`.

---

## 1. What happened BEFORE this change, established by reading the code

The claim in the issue is that enrolment has no recovery path and is
owner-only. The first half is close but not exact, and the exact shape is what
the fix had to answer. Traced through the shipped source:

| Route | Gate, before this change |
|---|---|
| `/auth/login/verify` | needs an assertion from a row in `owner_passkeys` (`owner-auth.js`, `findPasskey` → 403 `unknown passkey`) |
| `/auth/register/options` and `/verify` | needs a live session, **or** a single-use enrollment code |
| enrollment codes | mintable only at `POST /api/admin/auth/invite`, which is inside `validateAdminKey` |

So with the only enrolled device lost, destroyed or wiped: the session died
with it, there is no credential left to assert, and the one remaining door is
an enrollment code that only the **admin key** can mint.

**Is the client locked out of their own data?** Not permanently, and the
distinction matters. Their material is in their own D1 in their own Cloudflare
account and is untouched by any of this. But the `/app` surface — the only
non-technical way any of them reach it — is shut, and every route back is a
terminal.

**Can the operator help?** No, and by design. `onboarding/05-handoff-and-revocation.md`
states that at handoff the client rotates the admin key "to a value I have never
seen" and the operator's Cloudflare token is deleted live on the call. That is
the custody promise working exactly as intended, and it is also why an
operator-assisted recovery is not available to be built on.

`brain.mjs` `cmdInvite` already anticipates the post-handoff case:

```js
// Cloudflare is OPTIONAL here, deliberately: inviting a new device must
// keep working after our account token is revoked at handoff.
```

so the escape hatch DID exist. It required the client to hold the admin key, own
a machine with Node 22 and the installer checkout, know that `brain invite`
exists, and run it from a terminal.

**Was it documented anywhere they would find it?** No. Verified:

```
$ grep -rl "passkey" --include="*.md" . | grep -v node_modules
CHANGELOG.md
evidence/WP-10-bank-data-import.md
```

Zero mentions across all nine `onboarding/` documents, including
`06-runbook-top-ten-failures.md`, which is the file the handoff letter tells
them to open when something breaks. So the honest summary of the prior state:
**a technical escape hatch existed, gated behind the most powerful credential
in the install, and written down nowhere the person needing it would look.**

One protection was already right and is worth naming, because it shaped the
design: `revokePasskey` refuses to remove the last enrolled passkey —
*"refusing to remove the last passkey; enroll another device or mint a new
invite first"*. The product already declined to create this lockout on purpose.
It just had no answer for the world creating it.

---

## 2. The options, and why recovery codes

| Option | Why not, or why partly |
|---|---|
| **Require a second device at enrolment** | Passkeys SYNC. The `/app` page says so itself: *"Your passkey syncs to your own devices automatically."* A second Apple or Google device is usually the same credential store, so "two devices" is frequently one failure domain — lose the platform account and both are gone. It also fails an owner who has one phone in the room on install day. Kept as advice, rejected as the mechanism. |
| **Operator-assisted recovery** | Requires the operator to hold a standing credential to the client's account after handoff. That is the one thing the product promises it does not do. Rejected outright. |
| **Email or SMS magic link** | Makes the owner's mailbox a second door into their complete financial and personal record, and mailboxes are the most-phished asset there is. Strictly weaker than a passkey, and it adds an outbound dependency this product does not have. Rejected. |
| **Cloudflare account as the recovery route** | It is already the true floor and it cannot be removed, because everything lives in that account. But it is not one sentence for a non-technical person. Kept and DOCUMENTED as the last resort, not promoted to the primary. |
| **A recovery card: five one-time codes** | **Chosen.** Works after handoff with no operator, no second device, no cloud console and no terminal. Its failure domain is independent of the platform keychain. Explainable in a sentence: *keep this like the spare key to your house.* |

Five, not ten: enough to put one in a safe, one in a password manager and one
with an attorney without becoming a list nobody reads.

## 3. Why it is not a weaker second door

Six reasons, in descending order of how much weight they carry.

1. **It is strictly weaker than the credential it replaces in this role.**
   Before today, the only way back in was the admin key, which can also ingest,
   purge, reindex and drain. A recovery code can do exactly one thing: authorise
   one WebAuthn registration. Asking an owner to keep a code that can only add a
   phone, instead of a key that can empty their brain, makes the drawer they
   keep it in *less* dangerous, not more.
2. **It never becomes a session on its own.** The code buys a registration
   ceremony, and the session at the end is earned by the new passkey — the same
   read-only privilege class as any sign-in. Tested: a recovered session is 401
   on `/api/admin/brain/ingest` and still requires the `X-Brain-App` CSRF header.
3. **It does not skip one check.** `/auth/recover/verify` runs the identical
   `verifyRegistration` as normal enrolment — origin match, rpIdHash match,
   single-use challenge, user-present AND user-verified. The app page shares one
   `createPasskey()` between setup, add-a-device and recovery so the three
   cannot drift. Tested: a valid code plus an attestation bound to
   `attacker.example.com` is refused, and stores nothing.
4. **~99 bits, and the entropy is the actual protection.** 20 characters over a
   31-symbol alphabet. The alphabet excludes I, L, O, 0 and 1 so a code read off
   paper cannot be mistranscribed *into a different valid code*, and generation
   uses rejection sampling because `byte % 31` alone would make the first nine
   symbols measurably likelier. Only SHA-256 hashes are stored; a fast hash is
   correct here precisely because there is no dictionary that reaches 99 bits.
5. **Single use, atomically, and visible when used.** The guard is in the
   `UPDATE ... WHERE used_at IS NULL` and the verdict is the row count the
   engine reports; a runtime that does not report one is refused rather than
   assumed successful. A recovered device is stored with a `· recovered
   YYYY-MM-DD` label, so it is legible in Settings rather than blending in.
6. **Recovery signs out everywhere.** It bumps the session generation before
   minting the new cookie, on the assumption that a device you cannot find may
   be a device somebody else has. A live cookie on the lost phone dies at that
   moment.

A brake on guessing exists too — ten failures an hour, counted in the owner's
own database so it holds across Worker isolates — but it is stated honestly in
the code as defence in depth. The entropy is what stops a guess; the brake is
what makes a grind slow and *countable*.

## 4. What remains unrecoverable, and where that is written

Stated in three places, in the same words, because the failure is real:

- **`onboarding/06-runbook-top-ten-failures.md`**, its own top-level section
  ("You lost the device you sign in with"), placed above "The ten" so a
  panicking reader meets it first. Three routes written out: the card, then
  `brain invite` with the admin key, then setting a new `ADMIN_KEY` from their
  own Cloudflare dashboard.
- **`onboarding/05-handoff-and-revocation.md`**, the letter they keep — a row in
  "What you own now", a "If you lose the device you sign in with" section, and
  an explicit line under "What I still hold" that the installer holds no code.
- **The `/app` page itself**, as the API's own error text, so it is on screen at
  the moment of need rather than in a document that was emailed once.

The limit, verbatim from `NO_WAY_BACK` in `owner-auth.js`:

> No recovery code matched, and this brain has no unused recovery codes left.
> If every enrolled device and every recovery code is gone, nobody can open this
> page for you — not whoever installed it, and not us. Nothing is lost: your
> material is still in your own Cloudflare account. Sign in there and follow
> "If every device and every code is gone" in your handoff notes.

And the deepest limit, in the runbook in these words: **if the Cloudflare login
is also gone, this product cannot help and neither can the installer.**
Everything lives inside that account; recovering it is between the owner and
Cloudflare. That is the real single point of failure and it is better named now
than discovered later.

One more honest note, in the code and not hidden: the exhausted-card message
discloses that no unused codes remain, which a stranger could learn by trying.
That trade is deliberate. The disclosure buys an attacker nothing — there is no
code left to guess at and the passkeys are untouched — and buys the owner the
one thing that matters, which is knowing to stop hunting for a card.

An install running a Worker newer than its migrations has no card at all. It is
answered with a 503 naming migration 0019 and the command that applies it, not a
500 and not a 403 that would read as "wrong code".

## 5. Tests

`worker/test/recovery-codes.test.mjs`, ten tests, driven through the worker's
real `fetch` handler against **real SQLite with the real migrations applied**
rather than a regex-matching mock, with really-generated and really-signed
passkey material.

From the full-suite log:

```
✔ a recovery code is high-entropy, transcribable, and normalises the way paper is typed (2.688167ms)
✔ every device is gone: one code from the card puts the owner back in (19.879959ms)
✔ recovery cannot be used by someone who should not have it (21.274042ms)
✔ guessing is braked, and the brake clears for whoever holds a real code (11.789666ms)
✔ with every device AND every code gone, the page says so instead of implying safety (12.296458ms)
✔ an install whose worker is newer than its migrations says which command fixes it (7.878792ms)
✔ the last enrolled passkey still cannot be revoked, card or no card (9.764333ms)
✔ printing a new card kills the old one, and only someone already inside can print (9.946916ms)
✔ the operator can print a card at install, and only with the admin key (9.960791ms)
✔ the page carries the escape hatch and the honest limits, and its script parses (8.444583ms)
```

### A hollow test caught in the act, and reported rather than quietly fixed

The first discrimination run FAILED to discriminate. Deleting the single-use
guard — `WHERE code_hash = ? AND used_at IS NULL` becomes `WHERE code_hash = ?`
— left all ten tests green:

```
======== BREAK: single-use guard deleted, FIRST attempt ========
✔ recovery cannot be used by someone who should not have it (19.409125ms)
ℹ pass 10
ℹ fail 0
```

The reason is worth keeping: the replay check went through
`/auth/recover/options`, which peeks at `used_at` before the guard is ever
reached. The test was asserting the *peek*, not the guard. The fix was a second
path that hits the guard and nothing else — go straight to `/auth/recover/verify`
with a spent code, carrying a challenge obtained under a different live one. Both
checks are kept, with a comment saying which one is real.

### Discrimination, verbatim

Each break applied to the shipped source, the suite run, the source restored.

```
======== BREAK: single-use guard deleted (after the test was repaired) ========
✖ recovery cannot be used by someone who should not have it (20.344834ms)
  AssertionError [ERR_ASSERTION]: a spent code must not be spendable again, even skipping the options step
    actual: 200,
    expected: 403,

======== BREAK: recovery accepts a ceremony it did not verify ========
✖ recovery cannot be used by someone who should not have it (19.395292ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: 200,
    expected: 400,

======== BREAK: recovery no longer signs out everywhere ========
✖ every device is gone: one code from the card puts the owner back in (18.542042ms)
  AssertionError [ERR_ASSERTION]: recovery signs out everywhere
    actual: 200,
    expected: 401,

======== BREAK: the honest limit replaced with a comforting promise ========
✖ with every device AND every code gone, the page says so instead of implying safety (11.022667ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /nobody can open this page for you/. Input:
    actual: 'No recovery code matched, and this brain has no unused recovery codes left. Please contact support and we will get you back into your account.',
    expected: /nobody can open this page for you/,

======== BREAK: the last enrolled passkey becomes revocable ========
✖ the last enrolled passkey still cannot be revoked, card or no card (9.201375ms)
  AssertionError [ERR_ASSERTION]: a recovery card is a break-glass, not a licence to leave zero devices
    actual: true,
    expected: false,

======== BREAK: the guessing brake is removed ========
✖ guessing is braked, and the brake clears for whoever holds a real code (10.84325ms)
  AssertionError [ERR_ASSERTION]: the brake holds even against a valid code
    actual: 200,
    expected: 429,

======== RESTORED ========
ℹ pass 10
ℹ fail 0
```

A seventh check runs on every suite pass rather than as a break: the `/app`
page's inline script is parsed with `new Function`. It caught a real defect
during this work — a `\n` that survived one level of template-literal escaping
and shipped as a raw newline inside a string literal, which would have taken the
entire owner surface down with no server-side signal at all.

### Full chain

```
$ npm test > /tmp/issue11-passkey-recovery.log 2>&1; echo $? > /tmp/issue11-passkey-recovery-exit.txt
$ cat /tmp/issue11-passkey-recovery-exit.txt
0
```

Exit code read back from the file, not from the terminal.

## 6. Not fixed here, and deliberately

Issue #11 raises a second, separate thing: the session carries no identity or
role, so every enrolled passkey gets the same whole-corpus read, and spouse /
CPA / attorney lanes cannot be built safely on it. **This change does not touch
that and does not pretend to.** It also does not make it worse: a recovered
passkey lands in the same single owner class as every other, and nothing here
describes owner passkeys as multi-user access. Scope stays owner-only.

---

## Owner's note

Somebody drops their phone in a lake on a Tuesday. Before today, the answer was
that they'd need the admin key — the one credential that can also delete their
whole brain — plus a laptop with Node on it, plus knowledge that a command
called `brain invite` exists, and none of that was written down anywhere they'd
look. I checked; the word "passkey" appeared in zero of the nine onboarding
documents. That is not a recovery plan, it is a lockout with a rumour attached.

So now the brain prints a card at setup: five codes, on paper, in their hand
while I'm still in the room. Any one of them puts them back in from a brand-new
device, and that is the entire instruction. A code can't read anything, can't
load anything, can't delete anything — it can only cut a new key for the same
door. It is a safer thing to keep in a drawer than the admin key ever was,
which is why I think this makes the product harder to abuse and not easier.

And I wrote down the part that has no fix. If every device and every code is
gone, their Cloudflare login is the last way in, and if that is gone too, nobody
can help — not me, not anyone. It sits in the runbook in those words. I would
rather they read that on a calm Tuesday than find it out on a bad one.
