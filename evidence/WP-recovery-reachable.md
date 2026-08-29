# The way back in is now on the screen of the person who needs it

The recovery ceremony has worked for a while. Every enrolled device gone, one
code off a printed card, a fresh passkey on whatever machine you are holding:
that is proven against a real database with every passkey row deleted, in
`worker/test/recovery-codes.test.mjs`. What was not true is that anybody could
find it. The page lived at `/app/recover` and nothing anywhere linked to it, so
the only route in was typing a URL — which is precisely the thing a person
standing at a sign-in button their phone can no longer satisfy has no way to do.
A capability nobody can reach is not a capability, it is a test that passes. The
signed-out screen now says, quietly and below the button, that a way back exists
and where it is; and it says the two things about passkeys that mean most people
never need recovery at all, both of which were written down only in a CHANGELOG
entry that ships to operators and not to clients.

## What a locked-out person now sees

Under the Sign in button, separated by a rule, in small muted type. Closed by
default, and opened automatically the moment a sign-in attempt actually fails,
because the person reading that error is who it was written for.

> **Trouble signing in on this device?**
>
> Your passkey usually travels with you. Apple and Google copy it to your other
> phones and computers on their own, so the way you signed in before should
> still work here.
>
> On a computer you have never used, choose the option to use a phone when your
> browser asks, then scan the QR code it shows with the phone you already sign
> in with.
>
> If every device you had is gone, the printed recovery card you were given when
> this was set up is the way back in. [Use a recovery code](/app/recover)

Three deliberate choices in that copy:

- **The summary describes their situation, not a feature.** "Trouble signing in
  on this device?" is what the person thinks; "Account recovery" is what the
  product thinks.
- **The order is the order of likelihood.** Sync first, QR second, the card
  last. Recovery is the rarest of the three and it reads that way, so nobody
  reaches for a printed card when their other phone already has the passkey.
- **The link is labelled "Use a recovery code", never the route.** It names the
  object they were handed on paper.

It is withheld entirely from someone enrolling their first device: they have no
card yet, and offering them one is only frightening.

## The 401, and what it actually was

`/app/recover` answering 401 on a live install is real, and it is **not** an
auth gate on the recovery page. In this tree the route sits in front of the
admin-key gate and serves 200 to a caller with no session cookie, no admin key,
no invite code and not one passkey row left in the database. That is asserted
now, in the true locked-out state, by `recovery answers with no session, no key,
and not one passkey left`.

The 401 is version skew. `/app/recover` was created by the line-convergence
merge (`df70d67`) and has never appeared in any released CHANGELOG entry —
recovery codes as a feature have never been announced at all. Every build older
than that merge has a router that matches `/app` exactly, so `/app/recover` is
an unknown path, falls through to the admin-key gate, and the gate's answer for
"no key" is `401 {"error":"unauthorized"}`. Reproduced by extracting the
pre-merge tree and asking both:

```
$ git archive b176afb | tar -x -C .probe
$ node .probe/probe.mjs .../.probe/worker/src/index.js  "b176afb (pre-merge)"
$ node .probe/probe.mjs .../worker/src/index.js         "this branch       "

b176afb (pre-merge)  GET /app/recover -> 401  "{\"error\":\"unauthorized\"}"
this branch          GET /app/recover -> 200  "<!doctype html>\n<html lang=\"en\">\n<met"
```

So no install can receive this link without also receiving the route: they are
the same package. Nothing needed unlocking, and the fix is the link.

**One thing worth someone's judgement, left alone here.** The owner surface's
catch-all answers an unknown path with 401 `unauthorized` rather than 404. That
is what made a missing route look like a locked door, and it cost a
verification pass real time. Changing it is a security-surface decision about
what the edge is willing to tell an unauthenticated prober, not a drive-by, so
it is flagged rather than done.

## The bundle

`worker/src/lib/app-assets.js` is generated and committed; the app was rebuilt
with the documented command, `cd frontend && npm run build`.

| | fingerprint |
|---|---|
| before | `1d12dc53ba72` |
| rebuild of unchanged source, same command | `98e2e61e6a5a` |
| after this change | `baf859c18f60` |

The middle row is honest and slightly awkward: rebuilding the **unchanged**
source moved the fingerprint, so the committed artifact was produced by a
different resolution of the frontend devDependencies (vite resolves to 8.2.2
here) and the build is not byte-reproducible across dependency drift. Nothing in
the repo claims it is, and the served shell is pinned to whatever was actually
built, so this is a note rather than a defect. It does mean the diff on
`app-assets.js` is larger than this change alone.

The served shell references the new bundle, which is the assertion that stops a
stale pin surviving an upgrade:

```
GET /app -> 200
app.js?v=baf859c18f60
app.css?v=baf859c18f60
```

## Tests

`worker/test/recovery-reachable.test.mjs`, 9 checks, registered in the
`package.json` chain immediately after `recovery-codes.test.mjs`. It asserts
against the **shipped bundle** (`APP_JS` from the generated module), not against
`frontend/src`, because a rebuild that dropped the link while the source kept it
is exactly the failure that would otherwise ship silently.

- the signed-out screen carries a route to recovery, in words, not as a bare URL
- it also says the two things that mean recovery is not needed at all
- the shell points at the bundle that carries the link, not at a stale one
- the way out is secondary and never shown mid-enrolment
- every public owner-surface path reaches its handler, recovery included
- recovery answers with no session, no key, and not one passkey left
- the recovery ceremony's own door is open to the same unauthenticated caller
- the ordinary visitor's path is exactly what it was
- a link scanner opening the recovery page still burns nothing

The fifth is the router bug class the comment in `app-page.test.mjs` says has
"now been shipped twice in one day". `/app/recover` was the third, and the one
where the 401 lands on somebody already locked out, so it joins that loop.

### Discrimination

The `<details>` block was deleted from `Gate.tsx`, the bundle rebuilt with the
same command (`id 26e4a5b1627f`), and the file re-run:

```
✖ the signed-out screen carries a route to recovery, in words, not as a bare URL
✖ it also says the two things that mean recovery is not needed at all
✔ the shell points at the bundle that carries the link, not at a stale one
✖ the way out is secondary and never shown mid-enrolment
✔ every public owner-surface path reaches its handler, recovery included
✔ recovery answers with no session, no key, and not one passkey left
✔ the recovery ceremony's own door is open to the same unauthenticated caller
✔ the ordinary visitor's path is exactly what it was
✔ a link scanner opening the recovery page still burns nothing
ℹ tests 9
ℹ pass 6
ℹ fail 3

AssertionError [ERR_ASSERTION]: the shipped bundle has no link to /app/recover: a
locked-out owner can only reach the ceremony by typing a URL they were never given
```

The six that still pass are the six that should: the page was always reachable,
and the ordinary sign-in path was never what broke. Restoring `Gate.tsx` and
rebuilding returned `app-assets.js` byte-identical to the committed artifact
(`sha256 dadcc80e7f8138bf8f353bed5be8ccb4c95ca22cbb18e1cf7b89d35edc76f6a5`), so
the discrimination pass left nothing behind.

### Full chain

```
$ npm ci --ignore-scripts
$ npm test > /tmp/recoverylink.log 2>&1; echo $? > /tmp/recoverylink-exit.txt
$ cat /tmp/recoverylink-exit.txt
0
$ grep -cE "^(not ok|✖|FAIL )" /tmp/recoverylink.log
0
```

## Still owed

The ceremony itself is still the pre-merge HTML page at `/app/recover`, not
React. Folding it into the app and deleting `recovery-page.js` remains the right
end state. The link is what makes the capability reachable in the meantime, and
the stale "the React sign-in screen does not yet link here" comment at the top
of that file has been corrected rather than left to mislead the next reader.
