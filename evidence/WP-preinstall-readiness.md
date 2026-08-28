# WP: pre-install readiness on a bare client machine

`brain preinstall` — a doctor mode that runs on the client's own computer, days
before install day, with no manifest and no install on it.

## Why this was opened

Installs run on the client's machine now. That is the machine whose problems are
most expensive, because they surface with the client sitting next to you, and it
is also the machine every existing check was written on the far side of.

doctor.mjs's own header says the job is to find "in advance the problems that
otherwise appear live, in front of a client, in the first ten minutes of a
session". On a bare machine it did not do that. This is what it did instead.

## What was established first, with evidence

Three findings. The first was reported by a prior analysis and is confirmed
here; the second and third were found while confirming it, and the third is the
one that mattered.

### 1. CONFIRMED, and worse than reported: the account id is not merely absent, the check is structurally dead

`cmdDoctor` in brain.mjs sourced the Cloudflare account id from one place only:

```js
let accountId;
if (manifestPath && existsSync(manifestPath)) {
  try {
    accountId = loadManifest(manifestPath).m?.infrastructure?.cloudflare?.account_id;
  } catch { /* doctor must work without a valid manifest */ }
}
```

On a machine with no manifest, `accountId` is `undefined` every time, so
`checkVectorizeApi` took this branch and returned a warning:

```js
if (!accountId) {
  return check("Vectorize", WARN, "not checked: Cloudflare account id is not known yet",
    "Run `brain doctor <manifest>` after setup has written the account id. ...");
}
```

The prior finding said "structurally dead rather than merely skipped", and that
wording is exactly right, for a reason the code makes plain. `checkVectorize`'s
own remedy text tells the operator what to do about it:

```
    export CLOUDFLARE_ACCOUNT_ID='<the account id>'
```

Nothing read that variable back. `runAll` took `accountId` only as a parameter
and `cmdDoctor` only ever filled it from a manifest, so an operator who followed
doctor's own printed instruction still got "not checked". There was no sequence
of operator actions on a pre-install machine that could make the token-scope
probe run. Not skipped. Unreachable.

### 2. Six of eight checks never reached the operator's screen

`runAll` streamed results through a `push` helper so a slow check would not hold
the report hostage — but only for the first two. The remaining six called
`out.push` directly and bypassed the renderer entirely:

```js
push(checkNode());
push(await checkNetwork());
out.push(checkCfToken(cloudflareToken));      // never rendered
out.push(await checkVectorizeApi(...));       // never rendered
out.push(checkAnthropicKey());                // never rendered
out.push(checkClaudeCode());                  // never rendered
out.push(checkCodex());                       // never rendered
out.push(checkGoogleConnection(...));         // never rendered
```

Measured:

```
checks produced : Node, Network, Cloudflare token, Vectorize, Answer model, Claude Code, Codex, Google connection
onResult fired for: Node, Network
SILENT           : Cloudflare token, Vectorize, Answer model, Claude Code, Codex, Google connection
```

### 3. The defect that mattered: a green report on a machine that will fail

`checkCfToken` tested for a non-empty string and reported success:

```
garbage token verdict: {"name":"Cloudflare token","status":"ok","detail":"available for this command"}
```

Put the three together. A machine holding a token Cloudflare would reject, with
an account id exported exactly as doctor instructed, printed this:

```text
=== BEFORE: bare machine, no manifest, no token ===

  brain doctor

·     checking your machine. The Cloudflare checks download a tool on first run,
·     so the first time can take a couple of minutes. Each line appears as it finishes.

  ok    Node                v24.13.1
  ok    Network             reached api.cloudflare.com (HTTP 400)

  What to do

  Cloudflare token
    Create one in the CLIENT's account: dash.cloudflare.com > My Profile > API Tokens.
      Scopes: Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.
      Set 'Expires on' to tomorrow. Nothing here needs to outlive the install.
      Then run `brain setup` or `brain update` in an interactive terminal; it asks for the token without echo.
      Low-level automation must inject it through an approved secret manager, never a pasted shell command.
      Recreate the account-scoped token with Vectorize: Edit. That is the standard
      path and has been verified for index and metadata-index creation.
      Temporary fallback: run `npx wrangler@4 login` in the account owner's browser.
      Provision can use that session for Vectorize while the API token drives the
      remaining steps.
      Workers Paid (5 USD monthly minimum) is the supported production baseline.
      Free can create Vectorize, but its vector, daily-write, and CPU limits are
      prototype-scale and can hard-stop a real corpus.

  Vectorize
    Run `brain setup` or `brain update` in an interactive terminal for hidden token entry. Low-level automation must inject it through an approved secret manager, never a pasted shell command.

fail  1 blocking problem(s). Fix those and re-run `brain doctor`.
exit=1

=== BEFORE: garbage token + exported account id ===

  brain doctor

·     checking your machine. The Cloudflare checks download a tool on first run,
·     so the first time can take a couple of minutes. Each line appears as it finishes.

  ok    Node                v24.13.1
  ok    Network             reached api.cloudflare.com (HTTP 400)

  What to do

  Vectorize
    Run `brain doctor <manifest>` after setup has written the account id. `brain verify` also probes it before provisioning.

ok    ready to install (1 optional item(s) not set up)
exit=0
```

`ready to install`, exit 0, on a machine where every Cloudflare step of the
install would have failed. That is the defect. A report that is green on a
machine that will fail is worse than no report, because it is believed.

### Which checks genuinely cannot run without an install

Separating the two mattered, because most of what looked un-runnable was not.

Genuinely needs an install, because it reads a deployed brain or a written
manifest: the bank-feed return address (`checkBankFeedRedirect` needs
`manifest.brain.domain`), migration/checksum state (reads D1), and live brain
health (reads the worker). These are now listed as CANNOT CHECK with the command
to run once the install exists, rather than left off the page — otherwise an
operator finishes the report believing the bank-feed return address was checked
when no such check has ever run on that machine.

Only appeared un-runnable because it was written assuming a manifest: everything
about the Cloudflare token. The token, the account resolution, and every scope
the install needs can all be probed read-only with nothing but the token itself.
That is the whole of what this work builds.

Also established, and it shapes the ordering advice: `cmdProvision` creates the
D1 database **first**, R2 second, and contacts Vectorize **last**. A token
missing Vectorize: Edit therefore fails after a database already exists in the
client's account. That is the worst possible ordering and it is now called out by
name in the Vectorize remedy.

### The API behaviour the scope check is built on

Measured against the live API on 2026-08-28, no account involved:

```
GET /accounts                     Bearer <malformed>   HTTP 400  6003 / 6111  Invalid format for Authorization header
GET /accounts                     Bearer <invalid>     HTTP 403  9109         Invalid access token
GET /accounts/<id>/d1/database    Bearer <invalid>     HTTP 401  10000        Authentication error
GET /accounts/<id>/vectorize/...  Bearer <invalid>     HTTP 400  9106         Authentication failed
```

Code 10000 at a resource is the same body a **valid** token gets when it lacks
that one scope. doctor.mjs's own header records that ambiguity being misread once
already, as a platform limitation that did not exist. Settling the token at
`/accounts` first is what turns a later 10000 from a shrug into a verdict: the
token is valid, so this is a permission problem, and it can be named as one.

## The command

```
brain preinstall              # no manifest, no install, no argument
brain doctor --preinstall     # same thing, for anyone who reaches for doctor
```

Creates nothing, changes nothing. Exits non-zero only when something is actually
known to be broken.

Four outcomes, not three, and the fourth is the point:

| Outcome | Meaning |
| --- | --- |
| `PASS` | Checked, and good. |
| `FAIL` | Checked, and broken. |
| `WARN` | Works, with a consequence the client needs to hear. |
| `CANNOT CHECK` | Unknown from here. Names the manual step instead. |

The tags are words, not colours. The operator pastes this report into a message
or a ticket, and a distinction carried only by an escape code does not survive
that trip.

## What it now catches

- **Runtime.** Node major against `REQUIRED_NODE_MAJOR`, which a test pins to
  `engines.node` in package.json so the two cannot drift.
- **Operating system, with consequences.** See below.
- **Network.** Whether api.cloudflare.com is reachable at all.
- **Token validity.** Whether Cloudflare accepts the token, with its own words
  quoted. A malformed token (truncated, wrapped, quoted by a shell) is
  distinguished from a rejected one, because the fixes differ.
- **Account resolution.** Which account this installs into. Several visible
  accounts and no choice made is CANNOT CHECK, not FAIL: nothing is broken, a
  decision is missing. Naming an account the token cannot see IS fatal, because
  installing into the wrong account creates real resources in it.
- **Every Cloudflare scope the install needs, individually.** D1, Workers
  Scripts, Vectorize, Workers AI, R2 — one line each, probed read-only. A test
  pins the probe list against `CF_TOKEN_SCOPES`, so a scope added to the token
  advice without a probe fails the suite.
- **R2 activation**, which needs a payment method even on the free tier and is a
  common mid-install surprise. Optional, so a warning rather than a blocker.
- **The install-state checks**, listed as pending rather than omitted.
- wrangler reachable through npx (which also proves the npm registry is not
  blocked), Claude Code, Codex, and the Google connection.

## What it honestly cannot check, and what it says instead

Two things, both named in full, both with the exact page to open. Neither is
inferred, and neither is quietly dropped.

**Read versus Edit on the API token.** Cloudflare exposes no API that reports an
account-scoped token's own permission list. `GET /user/tokens` needs a scope the
install token will never carry, and `/user/tokens/verify` returns status only
(and 401s outright for account-owned tokens). So a passing probe proves the token
can LIST a resource, not that it can CREATE in it. The report says so on its own
line rather than burying a caveat in five passing ones, and sends the operator to
`dash.cloudflare.com > My Profile > API Tokens > the install token > Edit` with
the warning that a token holding Read where Edit belongs passes every check on
the page and then fails during provision, after resources exist.

**The Workers Paid plan.** Reading it needs `Billing: Read`, a scope the install
token should not have and which nobody should add just to make a line green. The
report sends the operator to `Workers & Pages > Plans` and states the trap: Free
CAN create a Vectorize index, so provision appears to succeed on it, and the
prototype-scale vector, daily-write and CPU limits hard-stop later, once the
client has already put their documents in.

A third, situational: any probe whose network call does not complete reports
CANNOT CHECK with the dashboard page to read instead. A token that could not be
tested says, in those words, "Do NOT treat the token as working until this line
says PASS."

This rule is enforced in code, not merely intended. `assertHonest` throws if any
check reports CANNOT CHECK without a manual step, and `runPreinstall` runs every
result through it before returning.

## Platform honesty

Four capability areas are macOS-only, and the report separates the two reasons,
because one can change and the other cannot.

**Permanent platform fact.** Live iMessage capture. Apple exposes message history
only through `~/Library/Messages/chat.db`. No engineering puts this on Windows or
Linux, so the report says "NOT POSSIBLE on this platform, ever" rather than
anything a client could hear as "not yet". Fallback named per platform: on
Windows an unencrypted iPhone backup is found automatically across iTunes, the
Apple Devices app and the Store build; on Linux there is no Apple backup software
at all, so the backup has to be copied over and pointed at directly.

**Installer gaps**, where the capability exists and the supervision does not.
Unattended refresh, WhatsApp capture, and keystore-backed secrets are all built
on macOS LaunchAgents (`assertMac` in `operations/drive-scheduler.mjs`,
`folder-scheduler.mjs`, `imessage-scheduler.mjs`, `whatsapp-daemon.mjs`,
`whatsapp-drain-scheduler.mjs`). The consequence line is the one that costs a
client the most, because it is invisible: nothing refreshes on its own, and a
brain going stale still reports itself healthy, because being out of date is not
an error state. The remedy is a `brain load` cadence agreed with the client
before install day.

Credential storage is stated per platform, because it is a real property of the
install: the login Keychain on macOS, a DPAPI-encrypted file on Windows, and a
permission-protected **plain file** on Linux (`storageBackend` picks a file off
darwin; `writeFileStore` encrypts only on win32).

Windows also gets told that this installer's own Windows command handling is
written from documented platform behaviour and has never been run on a real
Windows host — doctor.mjs says so in a comment, and a green Windows run that
hides that would be the same false confidence this mode exists to stop.

## Before and after, same machine, same inputs

Before is above. After, on a bare machine with no manifest and no token:

```text
·     checking this machine against everything install day needs.
·     nothing is created or changed. The Cloudflare checks need the network.


  brain preinstall — what this machine can and cannot do on install day
  host: macOS (node v24.13.1)

  PASS = checked and good.   FAIL = checked and broken.
  WARN = works, with a consequence.   CANNOT CHECK = unknown from here, do it by hand.

  PASS          Node                      v24.13.1
  PASS          Operating system          macOS; every capability is available on this platform
  PASS          Network                   reached api.cloudflare.com (HTTP 400)
  FAIL          Cloudflare token          no token is available on this machine
  CANNOT CHECK  D1                        no Cloudflare account resolved yet
  CANNOT CHECK  Workers Scripts           no Cloudflare account resolved yet
  CANNOT CHECK  Vectorize                 no Cloudflare account resolved yet
  CANNOT CHECK  Workers AI                no Cloudflare account resolved yet
  CANNOT CHECK  R2                        no Cloudflare account resolved yet
  CANNOT CHECK  Edit permissions          read access can be proven from here; write access cannot
  CANNOT CHECK  Workers Paid plan         the account's plan cannot be read with an install-scoped token
  PASS          wrangler                  4.73.0
  PASS          Claude Code               2.1.63 (Claude Code)
  PASS          Codex                     codex-cli 0.150.0-alpha.12.2
  PASS          Google connection         token stored in macOS Keychain (service "brain-installer.google-oauth", account "local-google-connection")
  CANNOT CHECK  Bank feed return address  needs a deployed brain with an address; there is no install on this machine yet
  CANNOT CHECK  Migration state           needs a provisioned D1 database; there is no install on this machine yet
  CANNOT CHECK  Live brain health         needs a deployed worker; there is no install on this machine yet

  BLOCKERS — this install will fail until these are fixed

  Cloudflare token
    Create one in the CLIENT's own account: dash.cloudflare.com > My Profile > API Tokens.
    Scopes: Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.
    Set 'Expires on' to tomorrow; nothing here needs to outlive the install.
    Then run `brain setup` or `brain update` in an interactive terminal, which asks for it
    without echo. Automation must inject it from an approved secret manager, never a
    pasted shell command.

  CANNOT CHECK — nobody knows yet. Do these by hand before install day

  D1
    The brain's documents, chunks and ledger live in D1. Nothing installs without it.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has D1: Edit.

  Workers Scripts
    The worker itself, its secrets, its workers.dev route and its drain cron are all written through this scope.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Workers Scripts: Edit.

  Vectorize
    Meaning-based search. Provision reaches this AFTER creating D1, so a missing scope strands a half-built install. Without Vectorize the brain can only find documents that repeat the words of the question, and it degrades quietly rather than erroring.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Vectorize: Edit.

  Workers AI
    The embedding and answering models. This is the standard answer path; no external model key is used.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Workers AI: Read.

  R2
    Optional storage. R2 also needs separate activation in the dashboard, which asks for a payment method even on the free tier, and that is a common mid-install surprise.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Workers R2 Storage: Edit.

  Edit permissions
    Cloudflare has no API that reports a token's own permission list, so nothing on this
    machine can tell Read from Edit. A probe above passing means the token can LIST that
    resource, not that it can CREATE in it.
    Confirm by eye, once, before install day:
        dash.cloudflare.com > My Profile > API Tokens > the install token > Edit
    Every line must read Edit, not Read: Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.
    A token with Read where Edit belongs passes every check on this page and then fails
    during provision, after resources already exist.

  Workers Paid plan
    Reading the plan needs Billing: Read, which this token should not have and which nobody
    should add just to make this line green.
    Look once, before install day, in the CLIENT's account:
        dash.cloudflare.com > Workers & Pages > Plans
    Workers Paid (5 USD per month minimum) is the supported production baseline. The Free
    plan can create a Vectorize index, so provision will appear to succeed on it; its
    vector, daily-write and Worker CPU limits are prototype-scale and hard-stop a real
    corpus later, once the client has already put their documents in.

  Bank feed return address
    The bank sends the client's browser back to an address that must be registered with the provider in advance. Unregistered, the client authorises at their bank and lands on a dead page, mid-session, with nothing to do about it.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  Migration state
    Detects a brain stuck part-way through an upgrade, and an applied migration whose file has since changed.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  Live brain health
    Proves the deployed brain actually answers, rather than merely existing.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain health <manifest>

  NOT READY — 1 blocker(s) will fail this install
  7 passed, 1 failed, 0 warning(s), 10 not checkable from here.
  Fix every BLOCKER above, then run `brain preinstall` again.
```

After, on the machine that used to print `ready to install` — a token Cloudflare
rejects, with an account id exported:

```text
·     checking this machine against everything install day needs.
·     nothing is created or changed. The Cloudflare checks need the network.


  brain preinstall — what this machine can and cannot do on install day
  host: macOS (node v24.13.1)

  PASS = checked and good.   FAIL = checked and broken.
  WARN = works, with a consequence.   CANNOT CHECK = unknown from here, do it by hand.

  PASS          Node                      v24.13.1
  PASS          Operating system          macOS; every capability is available on this platform
  PASS          Network                   reached api.cloudflare.com (HTTP 400)
  FAIL          Cloudflare token          Cloudflare rejected the token: Invalid access token
  CANNOT CHECK  D1                        no Cloudflare account resolved yet
  CANNOT CHECK  Workers Scripts           no Cloudflare account resolved yet
  CANNOT CHECK  Vectorize                 no Cloudflare account resolved yet
  CANNOT CHECK  Workers AI                no Cloudflare account resolved yet
  CANNOT CHECK  R2                        no Cloudflare account resolved yet
  CANNOT CHECK  Edit permissions          read access can be proven from here; write access cannot
  CANNOT CHECK  Workers Paid plan         the account's plan cannot be read with an install-scoped token
  PASS          wrangler                  4.73.0
  PASS          Claude Code               2.1.63 (Claude Code)
  PASS          Codex                     codex-cli 0.150.0-alpha.12.2
  PASS          Google connection         token stored in macOS Keychain (service "brain-installer.google-oauth", account "local-google-connection")
  CANNOT CHECK  Bank feed return address  needs a deployed brain with an address; there is no install on this machine yet
  CANNOT CHECK  Migration state           needs a provisioned D1 database; there is no install on this machine yet
  CANNOT CHECK  Live brain health         needs a deployed worker; there is no install on this machine yet

  BLOCKERS — this install will fail until these are fixed

  Cloudflare token
    The token is expired, revoked, or was created in a different account than the one
    being installed into. Create a fresh one in the CLIENT's account:
    dash.cloudflare.com > My Profile > API Tokens, scopes: Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.

  CANNOT CHECK — nobody knows yet. Do these by hand before install day

  D1
    The brain's documents, chunks and ledger live in D1. Nothing installs without it.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has D1: Edit.

  Workers Scripts
    The worker itself, its secrets, its workers.dev route and its drain cron are all written through this scope.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Workers Scripts: Edit.

  Vectorize
    Meaning-based search. Provision reaches this AFTER creating D1, so a missing scope strands a half-built install. Without Vectorize the brain can only find documents that repeat the words of the question, and it degrades quietly rather than erroring.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Vectorize: Edit.

  Workers AI
    The embedding and answering models. This is the standard answer path; no external model key is used.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Workers AI: Read.

  R2
    Optional storage. R2 also needs separate activation in the dashboard, which asks for a payment method even on the free tier, and that is a common mid-install surprise.
    Settle the token and account lines above, then re-run `brain preinstall`.
    Until then nobody knows whether this install has Workers R2 Storage: Edit.

  Edit permissions
    Cloudflare has no API that reports a token's own permission list, so nothing on this
    machine can tell Read from Edit. A probe above passing means the token can LIST that
    resource, not that it can CREATE in it.
    Confirm by eye, once, before install day:
        dash.cloudflare.com > My Profile > API Tokens > the install token > Edit
    Every line must read Edit, not Read: Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.
    A token with Read where Edit belongs passes every check on this page and then fails
    during provision, after resources already exist.

  Workers Paid plan
    Reading the plan needs Billing: Read, which this token should not have and which nobody
    should add just to make this line green.
    Look once, before install day, in the CLIENT's account:
        dash.cloudflare.com > Workers & Pages > Plans
    Workers Paid (5 USD per month minimum) is the supported production baseline. The Free
    plan can create a Vectorize index, so provision will appear to succeed on it; its
    vector, daily-write and Worker CPU limits are prototype-scale and hard-stop a real
    corpus later, once the client has already put their documents in.

  Bank feed return address
    The bank sends the client's browser back to an address that must be registered with the provider in advance. Unregistered, the client authorises at their bank and lands on a dead page, mid-session, with nothing to do about it.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  Migration state
    Detects a brain stuck part-way through an upgrade, and an applied migration whose file has since changed.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  Live brain health
    Proves the deployed brain actually answers, rather than merely existing.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain health <manifest>

  NOT READY — 1 blocker(s) will fail this install
  7 passed, 1 failed, 0 warning(s), 10 not checkable from here.
  Fix every BLOCKER above, then run `brain preinstall` again.
```

## A full report, with a missing scope

Deterministic and offline: a simulated Cloudflare where the token is valid, the
Vectorize scope is missing and R2 is not activated, on a Windows host. Account
name invented.

```text

  brain preinstall — what this machine can and cannot do on install day
  host: Windows

  PASS = checked and good.   FAIL = checked and broken.
  WARN = works, with a consequence.   CANNOT CHECK = unknown from here, do it by hand.

  PASS          Node                      v24.13.1
  WARN          Operating system          Windows; 4 capability area(s) unavailable on this platform
  PASS          Network                   reached api.cloudflare.com (HTTP 400)
  PASS          Cloudflare token          accepted by Cloudflare; it can see 1 account(s)
  PASS          Cloudflare account        ac000000000000000000000000000001 (Rivera Consulting) — the only one this token can see
  PASS          D1                        reachable with this token — read access confirmed, Edit not provable from here
  PASS          Workers Scripts           reachable with this token — read access confirmed, Edit not provable from here
  FAIL          Vectorize                 the token is valid but cannot reach it — Vectorize: Edit is missing
  PASS          Workers AI                reachable with this token — read access confirmed, Edit not provable from here
  WARN          R2                        not available: R2 is not enabled for this account
  CANNOT CHECK  Edit permissions          read access can be proven from here; write access cannot
  CANNOT CHECK  Workers Paid plan         the account's plan cannot be read with an install-scoped token
  WARN          Google connection         not connected
  CANNOT CHECK  Bank feed return address  needs a deployed brain with an address; there is no install on this machine yet
  CANNOT CHECK  Migration state           needs a provisioned D1 database; there is no install on this machine yet
  CANNOT CHECK  Live brain health         needs a deployed worker; there is no install on this machine yet

  BLOCKERS — this install will fail until these are fixed

  Vectorize
    Meaning-based search. Provision reaches this AFTER creating D1, so a missing scope strands a half-built install. Without Vectorize the brain can only find documents that repeat the words of the question, and it degrades quietly rather than erroring.
    Add Vectorize: Edit to the install token, or recreate it with the full set:
    Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.
    dash.cloudflare.com > My Profile > API Tokens.
    Fix this BEFORE running provision. Provision creates the D1 database first and
    only then contacts Vectorize, so discovering it later leaves a half-built
    install in the client's account.
    Recreate the account-scoped token with Vectorize: Edit. That is the standard
    path and has been verified for index and metadata-index creation.
    Temporary fallback: run `npx wrangler@4 login` in the account owner's browser.
    Provision can use that session for Vectorize while the API token drives the
    remaining steps.
    Workers Paid (5 USD monthly minimum) is the supported production baseline.
    Free can create Vectorize, but its vector, daily-write, and CPU limits are
    prototype-scale and can hard-stop a real corpus.

  CANNOT CHECK — nobody knows yet. Do these by hand before install day

  Edit permissions
    Cloudflare has no API that reports a token's own permission list, so nothing on this
    machine can tell Read from Edit. A probe above passing means the token can LIST that
    resource, not that it can CREATE in it.
    Confirm by eye, once, before install day:
        dash.cloudflare.com > My Profile > API Tokens > the install token > Edit
    Every line must read Edit, not Read: Workers Scripts: Edit, D1: Edit, Vectorize: Edit, Workers AI: Read.
    A token with Read where Edit belongs passes every check on this page and then fails
    during provision, after resources already exist.

  Workers Paid plan
    Reading the plan needs Billing: Read, which this token should not have and which nobody
    should add just to make this line green.
    Look once, before install day, in the CLIENT's account:
        dash.cloudflare.com > Workers & Pages > Plans
    Workers Paid (5 USD per month minimum) is the supported production baseline. The Free
    plan can create a Vectorize index, so provision will appear to succeed on it; its
    vector, daily-write and Worker CPU limits are prototype-scale and hard-stop a real
    corpus later, once the client has already put their documents in.

  Bank feed return address
    The bank sends the client's browser back to an address that must be registered with the provider in advance. Unregistered, the client authorises at their bank and lands on a dead page, mid-session, with nothing to do about it.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  Migration state
    Detects a brain stuck part-way through an upgrade, and an applied migration whose file has since changed.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain doctor <manifest>

  Live brain health
    Proves the deployed brain actually answers, rather than merely existing.
    Not a problem now, and not something to skip later. Run this the moment the
    install exists, before the client session:
        brain health <manifest>

  WARNINGS — the install works; the client needs to hear these

  Operating system
    Tell the client all of this BEFORE install day, not during it:

    Live iMessage capture
      NOT POSSIBLE on this platform, ever.
      Message history cannot be captured live on this machine. Apple keeps it in ~/Library/Messages/chat.db, which exists on macOS and nowhere else.
      Instead: One-time load from an unencrypted local iPhone backup: brain ingest <manifest> --from iphone-backup. iTunes, the Apple Devices app and the Microsoft Store build are all found automatically.

    Unattended refresh (Drive, watched folder, curated sync, message capture)
      Not installable from here (the capability exists; the supervision for it does not).
      Nothing refreshes on its own. The brain answers from whatever was last loaded into it, and it will report itself healthy while going stale, because being out of date is not an error state.
      Instead: Someone must run `brain load <manifest>` by hand on a schedule the client agrees to, or drive it from Task Scheduler. Agree that cadence before install day and write it down.

    WhatsApp capture
      Not installable from here (the capability exists; the supervision for it does not).
      Cannot be installed from here. The capture daemon is kept alive by a per-user LaunchAgent and no equivalent supervision is built for this platform yet.
      Instead: Use an exported WhatsApp chat archive instead: brain ingest <manifest> --from whatsapp reads exports without the live daemon.

    Secrets in the operating system keystore
      Not installable from here (the capability exists; the supervision for it does not).
      The admin key cannot live in a keystore here, and the Cloudflare token is not remembered between commands, so it is asked for every time.
      Instead: The admin key falls back to a permission-restricted file next to the manifest. Decide with the client where that file lives and who can read it.

    Google credentials on this platform are stored in a DPAPI-encrypted file readable only by this Windows user account.

    Also: this installer's Windows command handling is written from the documented
    platform behaviour and has not been exercised on a real Windows host. Budget
    extra time and do a dry run on the client's own machine before the session.

  R2
    R2 is optional and the brain runs without it, so this does not block the install.
    If the client wants it, R2 must be activated in their dashboard first, and
    Cloudflare asks for a payment method even on the free tier. That is a browser
    step somebody has to do, so do it before install day, not during.

  Google connection
    Only needed to ingest from Drive or Gmail. A local folder works without it.
    Connect with: brain connect google --scopes drive,gmail

  NOT READY — 1 blocker(s) will fail this install
  7 passed, 1 failed, 3 warning(s), 5 not checkable from here.
  Fix every BLOCKER above, then run `brain preinstall` again.

  exit code: 1
```

## Discrimination

The tests were checked against a deliberate defect, twice.

**Sabotage 1 — a denied scope reports PASS.** In `checkCloudflareScopes`, the
status for a rejected probe was changed from `probe.required ? FAIL : WARN` to
`OK`, leaving the detail text untouched, so the check still *said* the scope was
missing while reporting success. Six tests caught it:

```text
FAIL  a token missing one scope FAILS that scope  {"name":"Vectorize","status":"ok","detail":"the token is valid but cannot reach it — Vectorize: Edit is missing","fix":"Meaning-based search. Provision reaches this AFTER creating D1, so a missing scope strands a half-built install. Without Vectorize the brain can only find documents that repeat the
FAIL  it is not reported as unchecked or skipped  {"name":"Vectorize","status":"ok","detail":"the token is valid but cannot reach it — Vectorize: Edit is missing","fix":"Meaning-based search. Provision reaches this AFTER creating D1, so a missing scope strands a half-built install. Without Vectorize the brain can only find documents that repeat the
FAIL  one missing scope makes the whole run non-zero  
FAIL  optional R2 is a warning, not a blocker  {"name":"R2","status":"ok","detail":"the token is valid but cannot reach it — Workers R2 Storage: Edit is missing","fix":"Optional storage. R2 also needs separate activation in the dashboard, which asks for a payment method even on the free tier, and that is a common mid-install surprise.\n  Add Wor
FAIL  blockers get their own section  
FAIL  the failing scope appears in the blockers section, not buried  
6 FAILURES
```

The first message, verbatim:

```text
FAIL  a token missing one scope FAILS that scope  {"name":"Vectorize","status":"ok","detail":"the token is valid but cannot reach it — Vectorize: Edit is missing","fix":"Meaning-based search. Provis
```

**Sabotage 2 — the honesty rule itself goes green.** The `cannotCheck` helper was
changed to emit `OK` instead of `CANNOT_CHECK`, which is the precise defect this
mode exists to prevent: something unknown rendered as something confirmed. Ten
tests caught it:

```text
FAIL  and it is CANNOT CHECK, not PASS  {"name":"Bank feed return address","status":"ok","detail":"needs a deployed brain with an address; there is no install on this machine yet","manual":"The bank sends the client's browser back to an address that must be registered with the provider in advance. Unregistered, the client authorises at th
FAIL  the scopes below it are unknown, not passed  [["D1","ok"],["Workers Scripts","ok"],["Vectorize","ok"],["Workers AI","ok"],["R2","ok"]]
FAIL  an unresolved account is CANNOT CHECK, not FAIL  {"name":"Cloudflare account","status":"ok","detail":"this token can see 2 accounts and nothing says which one to install into","manual":"Nothing is wrong yet, but every permission check below is blocked until this is settled.\n  Confirm with the client which account is theirs, then re-run:\n      ex
FAIL  with no account, the scope probes admit they did not run  {"name":"D1","status":"ok","detail":"no Cloudflare account resolved yet","manual":"The brain's documents, chunks and ledger live in D1. Nothing installs without it.\n  Settle the token and account lines above, then re-run `brain preinstall`.\n  Until then nobody knows whether this install has D1: Ed
FAIL  Read-versus-Edit is admitted as unknowable from here  {"name":"Edit permissions","status":"ok","detail":"read access can be proven from here; write access cannot","manual":"Cloudflare has no API that reports a token's own permission list, so nothing on this\n  machine can tell Read from Edit. A probe above passing means the token can LIST that\n  resou
FAIL  the paid tier is admitted as uncheckable  {"name":"Workers Paid plan","status":"ok","detail":"the account's plan cannot be read with an install-scoped token","manual":"Reading the plan needs Billing: Read, which this token should not have and which nobody\n  should add just to make this line green.\n  Look once, before install day, in the C
FAIL  a probe that could not complete reports CANNOT CHECK  {"name":"D1","status":"ok","detail":"the probe did not complete: fetch failed","manual":"The brain's documents, chunks and ledger live in D1. Nothing installs without it.\n  Re-run when the network is stable. Confirm by hand meanwhile:\n  dash.cloudflare.com > My Profile > API Tokens > the install t
FAIL  and it is not a pass  
FAIL  an untestable token is CANNOT CHECK, never PASS  {"name":"Cloudflare token","status":"ok","detail":"the token could not be tested: fetch failed","manual":"This machine could not reach api.cloudflare.com, so the token is neither proven good\n  nor proven bad. Clear the network problem above and run `brain preinstall` again.\n  Do NOT treat the toke
FAIL  unchecked items get their own section, with the manual steps  
10 FAILURES
```

Both were restored and the suite returns to all green.

## Owner's note

I would rather this command tell an operator "I do not know" eleven times than
tell them "ready" once while holding a token Cloudflare would refuse. The old
report was not lying on purpose; it was built when installs ran on our machine,
where a manifest always existed, and every one of its assumptions was reasonable
there. Moving installs onto the client's laptop invalidated the assumption
quietly, and nothing failed, which is exactly why it survived: the report kept
printing, kept looking healthy, and the one machine it could not assess was the
only one anybody was going to run it on.

The part I want kept if anything here is ever refactored is the fourth status.
Three outcomes force every unknown into a pass or a failure, and the pressure is
always toward the pass, because a report full of red is uncomfortable to hand
over. CANNOT CHECK gives the unknown somewhere honest to sit, and `assertHonest`
makes it cost something: you cannot add one without writing down where to look
instead. Read-versus-Edit and the Workers Paid plan will both still bite
somebody one day. When they do, the operator will at least have been told, days
early, in a quiet hour, that nobody had checked.

## Files

- `doctor.mjs` — pre-install mode, plus the three fixes above to the existing checks
- `test/preinstall.test.mjs` — 92 assertions, registered in the `npm test` chain
- `brain.mjs` — `cmdPreinstall`, the `preinstall` command, the `--preinstall` flag, one help line
- `README.md` — "Before install day"
