# Two front doors, and a pause that came back

Two defects, both found on a live install on 2026-08-28, both about what an
owner is *shown* rather than about what the software does. Neither fix changes
provisioning, upgrading, or authentication. They change what `brain doctor`
says.

---

## Trap one: a brain answers on two hostnames, and a passkey works on one

### What is actually true

`brain deploy` enables the workers.dev route unconditionally, because a deploy
with no URL cannot be verified:

```
brain.mjs, cmdDeploy
  // A deploy that is not verified is a belief. Enable the workers.dev route so
  // there is always a URL to prove it against, even before a custom domain.
  const workersDevPath = `/accounts/${acct.id}/workers/scripts/${scriptName}/subdomain`;
```

Attaching a custom domain later does not remove that route. The worker then
answers on both hostnames with the identical route set: `/api/admin/*`, `/app`
and `/auth/*` all reply on each one.

That is harmless for reading and fatal for signing in:

```
worker/src/lib/owner-auth.js:148
  const rpId = url.hostname;
```

WebAuthn binds a credential to the Relying Party ID, so the hostname a passkey
was enrolled on *is* that passkey's identity. A browser holding a key for one
address treats the other as an unrelated website. It does not offer the key and
it does not say why. There is no error to read and nothing to click.

The CLI turns that from a curiosity into a trap, because `m.brain.domain` is the
base for every link this tool prints, `brain invite` included. An owner whose
manifest still names the workers.dev address sends an enrolment link on *that*
hostname, enrols there, then opens the custom domain they actually use and is
shown a sign-in button their key cannot satisfy. That was the exact state of one
real install: manifest on workers.dev, human on the custom domain.

### Where the check went, and why

**Detection is in `brain doctor <manifest>`.** It has to be: the second hostname
cannot be derived from the first. Given a custom domain there is no way to
compute the workers.dev name without the account's subdomain, and given the
workers.dev name there is no way to compute a custom domain at all. Only the
Cloudflare account knows, so the check asks it. `brain preinstall` runs on a
machine with no install, no manifest and no worker, so there is nothing there to
compare.

**The decision is named in `brain preinstall`,** as a fourth entry in
`INSTALL_STATE_CHECKS` — the list that exists precisely so a check which cannot
run yet is *named as pending* rather than left off the page. That matters here
more than for the other three, because the expensive half of this problem is
timing. Choosing one address costs a dashboard click before anyone enrols;
changing it afterwards costs a re-enrolment on every device, one at a time, with
a person on each end. Preinstall is where that conversation with the client fits.

So: doctor detects it, preinstall makes sure the decision is made before there is
anything to detect.

### The exact wording an owner sees

Two hostnames answer, manifest naming the workers.dev one (the live defect).
Rendered through the same line and remedy format `cmdDoctor` uses; only the
Cloudflare listing is injected, the wording and status are the shipped ones:

```
  warn  sign-in address     2 hostnames answer for this brain; a passkey works on only one of them

  sign-in address
    Cloudflare routes all of these to the same brain, and a browser treats them as
      unrelated websites:

          https://rivera-brain.example-account.workers.dev   workers.dev, enabled by deploy  <- the manifest names this one
          https://brain.example.test                         custom domain

      A passkey is bound to the hostname it was created on. A key enrolled at one of
      these addresses cannot sign in at the other, and the browser gives no explanation:
      it simply offers no key.

      Settle on ONE address BEFORE anyone enrols a device. That is the cheap moment, and
      it costs a dashboard click. Afterwards every device has to enrol again on the
      surviving address, one at a time, with a person on each end.

      To keep rivera-brain.example-account.workers.dev, which is what every link this CLI prints already uses:
          Remove the other hostname from the worker in the client's own account
          (Workers & Pages > the brain worker > Settings > Domains & Routes).
          Disabling the workers.dev route there is the usual answer.
      To keep brain.example.test instead:
          Set brain.domain to "brain.example.test" in the manifest, run `brain deploy <manifest>`,
          and remove the other hostname. Then every invite link points where people actually go.
```

One hostname (workers.dev route off). One line, no paragraph, nothing to scroll
past:

```
  ok    sign-in address     only brain.example.test answers for this brain, and the manifest names it
```

No Cloudflare token on this machine. Real `brain doctor` output, run against a
fixture manifest with the token unset:

```
  ok    Node                v24.13.1
  ok    Credential store    wrote a test value through an owner-only file (mode 0600) and read back the same bytes
  ok    Network             reached api.cloudflare.com (HTTP 400)
  FAIL  Cloudflare token    CLOUDFLARE_API_TOKEN is not set
  warn  Vectorize           not checked: Cloudflare token is missing
  ok    Answer model        Cloudflare Workers AI is the standard; no external model key is required
  warn  upgrade state       not checked: could not reach https://rivera-brain.example-account.workers.dev/health: rivera-brain.example-account.workers.dev could not be resolved (ENOTFOUND). Check the network connection or a DNS/VPN setting.
  warn  migration checksums  not checked: could not resolve this install's Cloudflare account: CLOUDFLARE_API_TOKEN is not set.
  n/a   sign-in address     not checked: no Cloudflare access from here: CLOUDFLARE_API_TOKEN is not set.
  ok    Bank feed           not in use on this brain

  What to do
  ...
  sign-in address (nobody can check this from here)
    A brain can answer on two hostnames at once: a custom domain, and the workers.dev
      address `brain deploy` enables so a deploy can be verified. Adding the first does
      not remove the second.
      A passkey is bound to the hostname it was created on. A key enrolled at one of
      these addresses cannot sign in at the other, and the browser gives no explanation:
      it simply offers no key.
      Look once, in the CLIENT'S OWN account, before anybody enrols a device:
          dash.cloudflare.com > Workers & Pages > the brain worker > Settings > Domains & Routes
      If more than one hostname is listed there, decide which one the brain lives on and
      remove the other BEFORE enrolling. Re-enrolling afterwards means every device again,
      one at a time, with a person on each end.
```

`brain preinstall`, days early, on a machine with no install:

```
  brain preinstall — what this machine can and cannot do on install day
  host: macOS (node v24.13.1)

  PASS = checked and good.   FAIL = checked and broken.
  WARN = works, with a consequence.   CANNOT CHECK = unknown from here, do it by hand.

  CANNOT CHECK  Sign-in address  needs a deployed brain with its routes in place; there is no install on this machine yet

  CANNOT CHECK — nobody knows yet. Do these by hand before install day

  Sign-in address
    A brain can end up answering on TWO hostnames: its custom domain, and the workers.dev
    address `brain deploy` enables so a deploy can be verified. Both serve the identical
    route set, and a passkey works on only one of them, because it is bound to the exact
    hostname it was enrolled on.
    Decide WITH THE CLIENT, now, which single address their brain lives at, and put that
    in brain.domain before anybody enrols a device. Deciding now is a dashboard click.
    Deciding later means re-enrolling every device, one at a time, with a person on each end.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  NO BLOCKERS FOUND — but 1 item(s) could NOT be checked from this machine
  0 passed, 0 failed, 0 warning(s), 1 not checkable from here.
  This is not a green light. Do each manual step listed under CANNOT CHECK before
  install day; any one of them can still stop the install in front of the client.
```

### How it avoids crying wolf on a healthy install

Three separate ways, each with a test:

1. **One hostname is silent.** The warning fires only when the account routes a
   hostname that is not the one the manifest names. A workers.dev-only install
   and a custom-domain-only install both return `ok`, and neither mentions
   passkeys at all.
2. **Spelling is not a second hostname.** `normalizeHostname` strips scheme,
   case, port, path and trailing dot before comparing, so `https://Brain.Example.Test:443/`
   and `brain.example.test.` are one address, not three.
3. **It is a warning, never a blocker.** Nothing is broken at the moment of
   detection: both addresses work, the brain is healthy, and the entire cost is
   in the future. That is what WARN means in this codebase, and it keeps
   `brain doctor`'s exit code unchanged.

And where it genuinely cannot know, it says so rather than passing. A missing
token, a Cloudflare outage, or a *partial* listing (custom domains read, the
workers.dev route not) all return CANNOT CHECK with the dashboard page to open.
A partial listing is deliberately not treated as "one hostname", because that is
the one failure mode that would turn this check into a false green.

What it cannot see, stated in the check's own comment rather than left implied:
a zone-level Worker route is a third way to reach the same worker, and
enumerating those needs per-zone access an install token has no reason to carry.
A clean result means "no second address among the ones this check can list",
never "there is definitely only one".

---

## Trap two: the same pause, twice, with a healthy report in between

### What happened

One brain stranded itself mid-upgrade twice in a single day. `/health` reported
each pause honestly, and `brain doctor` read it, so both events were seen. What
nobody saw is that they were the same event twice: between them the brain
reported healthy, so the second arrived looking like a first.

Those are different problems. A pause that happened once is a bad day. A pause
that recurs is a broken upgrade path, and the next one lands on a client who
paid. The difference is written down in `upgrade_runs` and nowhere else, which
means it is only ever found by someone who already suspects it.

**This changes only what is reported.** The underlying migration failure is
being fixed elsewhere; nothing here repairs an upgrade.

### Where it went, and why not `brain health`

Recurrence is folded into doctor's existing `upgrade state` check, and into the
diagnosis `brain doctor <manifest> --repair` prints.

`brain health` was the tempting surface, since it is the command an owner runs.
It is the wrong one. `cmdHealth` is deliberately built to work *without* a
Cloudflare token, so it keeps proving the brain after our token is revoked at
handoff — and `upgrade_runs` lives in D1, which needs exactly that token. A
recurrence line in `brain health` would therefore read "not checked" for the
precise owner it was aimed at. Doctor already holds the token, already reads
this table for the current pause, and is already the command whose whole job is
saying what is wrong with an install.

Two behaviours make it actually reach someone:

- **Healthy-now is no longer green when there is history.** Doctor prints remedy
  text only for checks that are not `ok`, so a brain with earlier pauses on
  record returns WARN rather than OK. That is the exact state the install sat in
  between its two strandings, and it is the one an operator has to see.
- **`diagnoseStuckUpgrade` reads 25 rows instead of 1.** Same single query, so
  `--repair` now says which number this pause is, without a second round trip.

### The exact wording an owner sees

Paused now, and not for the first time:

```
  FAIL  upgrade state       paused for an upgrade; this brain cannot accept documents (pause number 2)

  upgrade state
    Diagnose exactly where it stopped: brain doctor <manifest> --repair
      That resumes the same verified upgrade path once you confirm with --yes.
      To restore the pre-migration snapshot instead: brain doctor <manifest> --rollback

      This is pause number 2 on this brain. It is not the first.

      Every upgrade run on record that did not finish:
          2026-08-28T16:41:37Z  0.1.21 -> 0.1.22  started  stage:migrate
          2026-08-28T09:12:04Z  0.1.21 -> 0.1.22  failed  stage:migrate

      It reported itself healthy between these, which is why each one arrives looking
      like the first. A pause that recurs is a broken upgrade path rather than a bad
      day, and the next one lands on whoever is using this brain at the time.
      Full history, and nothing here deletes it:
          SELECT * FROM upgrade_runs ORDER BY started_at DESC;
```

Healthy right now, with two strandings behind it. This is the state nobody saw:

```
  warn  upgrade state       accepting documents, but this brain has paused mid-upgrade 2 time(s)

  upgrade state
    This brain is not paused now, but it has stranded mid-upgrade 2 time(s) before.

      Every upgrade run on record that did not finish:
          2026-08-28T16:41:37Z  0.1.21 -> 0.1.22  rolled_back  stage:migrate
          2026-08-28T09:12:04Z  0.1.21 -> 0.1.22  failed  stage:migrate

      It reported itself healthy between these, which is why each one arrives looking
      like the first. A pause that recurs is a broken upgrade path rather than a bad
      day, and the next one lands on whoever is using this brain at the time.
      Full history, and nothing here deletes it:
          SELECT * FROM upgrade_runs ORDER BY started_at DESC;
```

Never stranded. Quiet at zero, which is half the value:

```
  ok    upgrade state       accepting documents
    recurrence note: ""   (total=0, previous=0)
```

A first-ever pause happening right now also adds nothing: the current pause is
already reported in the line above it, and repeating it under a "this has
happened before" heading would be the check crying wolf about itself.

What counts as a pause: any upgrade run that did not reach `verified`.
`migrations/d1/0001_install_state.sql` defines the states as
`started | verified | failed | rolled_back`, and a run still marked `started`
days later did not finish, it stopped.

---

## Discrimination: each check disabled in turn

**One.** `checkSignInAddress` in `doctor.mjs`, with the second-hostname
comparison neutered (`const others = [];`), so the check can never see a second
address. `node test/sign-in-address.test.mjs`:

```
FAIL  two live hostnames are detected  {"name":"sign-in address","status":"ok","detail":"only rivera-brain.example-account.workers.dev answers for this brain, and the manifest names it"}
FAIL  and it is not silently a pass  ok
FAIL  the wording names the custom domain
FAIL  the wording names the workers.dev address
FAIL  and labels which is which
FAIL  and says which one the manifest names, since that is where invite links go
FAIL  it states plainly that a passkey works on only one of them
FAIL  and that the browser explains nothing
FAIL  the summary line already carries the point without opening the remedy  only rivera-brain.example-account.workers.dev answers for this brain, and the manifest names it
FAIL  it says to settle on one address BEFORE anyone enrols a device
FAIL  and says why later is worse
FAIL  keeping the manifest address is spelled out
FAIL  and so is switching to the other one
FAIL  a manifest address that is not among the live routes is still flagged  {"name":"sign-in address","status":"ok","detail":"only rivera-brain.example-account.workers.dev answers for this brain, and the manifest names it"}
FAIL  and is named as the worse case, because invite links may lead nowhere
FAIL  both addresses are still named
FAIL  end to end, a manifest on workers.dev beside a custom domain warns  {"name":"sign-in address","status":"ok","detail":"only rivera-brain.example-account.workers.dev answers for this brain, and the manifest names it"}
FAIL  and the warning names both hostnames
18 FAILURES
exit=1
```

The one-hostname assertions kept passing while it was disabled, which is the
point: they are the anti-false-positive half and a disabled check satisfies them
trivially. Only the detection assertions moved.

**Two.** `upgradePauseRecurrence` in `doctor.mjs`, returning an empty note
unconditionally, so every install looks like a first.
`node test/upgrade-pause-recurrence.test.mjs`:

```
FAIL  a first-ever pause, happening now, adds nothing  {"total":0,"previous":0,"note":""}
FAIL  two pauses are counted  {"total":0,"previous":0,"note":""}
FAIL  and one of them is prior, not just the current one  {"total":0,"previous":0,"note":""}
FAIL  the wording says which number this is
FAIL  and says it is not the first
FAIL  the earlier pause is dated
FAIL  and so is the current one, so the two can be told apart
FAIL  each run carries its status
FAIL  and the stage it died at
FAIL  and the versions it was moving between
FAIL  it names why recurrence matters rather than leaving it to be inferred
FAIL  and it names the reason each one looks like a first
FAIL  and it hands over the query for the rest
FAIL  a brain that is fine right now still reports its earlier pauses  {"total":0,"previous":0,"note":""}
FAIL  and both are counted as prior, because none is happening now  {"total":0,"previous":0,"note":""}
FAIL  the wording says it is not paused now
FAIL  and gives the count of earlier strandings
FAIL  both dates are present
FAIL  even ONE earlier pause is surfaced on a healthy brain, since that is how the second one starts  {"total":0,"previous":0,"note":""}
FAIL  an upgrade left in `started` counts as a pause  {"total":0,"previous":0,"note":""}
FAIL  a later successful upgrade does not erase the pauses behind it  {"total":0,"previous":0,"note":""}
FAIL  and it feeds the recurrence note
FAIL  so the repair path can say this is the second pause
23 FAILURES
exit=1
```

Both files restored afterwards, and both suites pass again:

```
sign-in address: all 48 tests passed
upgrade pause recurrence: all 38 tests passed
```

## Full suite

```
$ npm test > /tmp/domaincheck.log 2>&1; echo $? > /tmp/domaincheck-exit.txt
$ cat /tmp/domaincheck-exit.txt
0
$ grep -n "sign-in address: all\|upgrade pause recurrence: all" /tmp/domaincheck.log
2011:upgrade pause recurrence: all 38 tests passed
2861:sign-in address: all 48 tests passed
```

---

## For the release notes, in the owner's voice

Your brain can end up with two front doors. The address you gave it and the
workers.dev address it was born with both answer, and both look identical from
the outside. A passkey does not see it that way. It belongs to the exact
hostname you enrolled it on, and at the other address your browser will offer
you nothing and explain nothing. `brain doctor` now tells you when both doors
are open, names them side by side, says which one your invite links point at,
and asks you to pick one before anybody enrols a device. Picking now is a click.
Picking later is every device again, one at a time, with someone on the phone.
Doctor also stopped treating a stalled upgrade as news each time it happens. If
your brain has stranded mid-upgrade before, you will see that it has, how many
times, and on what dates, even on a day when everything looks fine, because a
pause that keeps coming back is a different problem from one that happened once.
