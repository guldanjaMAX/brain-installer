# Install Test SOP: Mac, Windows, and browsers

Written 2026-08-27. Companion to the private narrated human rehearsal plan.
This document is the standing operating
procedure: what gets tested, on what machines, how often, and with zero
client data. Anyone with this repo and an explicitly approved disposable test
credential can run it.

**When it runs:** on every release tag, and in full before every client
install day. The rule this SOP exists to enforce: nothing weird gets
discovered on the day of an install.

---

## The test account

One Cloudflare test account, never a client's and never a production account
(see the we-store-nothing rule). Its scoped API token carries exactly the four
install permissions (Workers Scripts Edit, D1 Edit, Vectorize Edit, Workers AI
Read) and is scoped to that one account.

This repo is public, so the account id, the login it belongs to, and the names
of the live resources that share it are deliberately NOT written here. They
live in the operator's private bench note, outside this repo. What matters publicly is the shape:

- The token lives in the operator's OS keychain, never in a file, an argument,
  or a shell history line. The scripts read it from there.
- CI reads it from the repository secret `BRAIN_TEST_CF_TOKEN`.
- Proven 2026-08-27 and again 2026-08-28 on two separate accounts: those four
  permissions are sufficient for everything an install does, INCLUDING creating
  the Vectorize index. No `wrangler login` is required anywhere in the flow.

⚠️ **The test account is not empty.** It also hosts a live preview brain. Every
teardown and cleanup MUST target test resources by exact name (allowlist), and
must never sweep the account. `scripts/teardown-test-brain.mjs` enforces this:
it refuses any name that does not look like a test resource, refuses any name
matching `BRAIN_TEARDOWN_PROTECTED`, and dry-runs unless `--commit` is passed.

Start on the Free plan with a small rehearsal corpus (about 50 documents).
Free-tier limits are themselves a scheduled break-test; if the corpus
outgrows Free, the Workers Paid upgrade is a deliberate decision with a named
card, not a default.

The rehearsal corpus is synthetic or the operator's own material. Client data
never touches a test install.

## Teardown

The installer has no uninstall command, but every resource it creates can be
deleted with the same token (Worker script, D1 database, Vectorize index).
`scripts/teardown-test-brain.mjs` does this in one run. Run it after every
cold-install test so the account stays clean. The installer also adopts
existing resources by name, so an interrupted run can always be re-run
safely before teardown.

---

## Tier 0: repo tests (exists today)

`npm test`: the full assertion suite. Necessary, and proven insufficient on
its own: none of these assertions can see a screen.

## Tier 1: fresh-machine install matrix (CI)

GitHub Actions workflow `install-matrix.yml`. Every runner is a genuinely
fresh machine. Each job executes the install commands **verbatim from the
public install page** (not from repo internals; the point is testing what a
client actually types), then `brain whatsnew`, `brain doctor`, `brain setup`,
a minimal `brain drain`, health verify, one `brain ask`, then teardown.

| Runner | What it proves |
|---|---|
| macos-latest (Apple Silicon) | The Mac path most clients are on |
| macos-13 (Intel) | Older Macs |
| windows-latest | The PowerShell / npm.cmd path, which has never been human-tested |
| ubuntu-latest | The Linux path and the cheapest canary |

Artifacts per job: the full terminal transcript and timing. A failed job
blocks the release. Trigger: release tag plus manual dispatch.

## Tier 2: browser matrix against the /app surface (CI + local)

The worker and `/app` page live in Cloudflare, so browser testing needs no
VM at all. A Playwright suite targets the deployed **test** brain:

| Browser under test | How |
|---|---|
| Chrome / Edge (engine) | Playwright Chromium, plus real Edge channel on the Windows runner |
| Safari (engine) | Playwright WebKit; real Safari via safaridriver on the macOS runner |
| Firefox | Playwright Firefox |

Checks: sign-in page renders, passkey enrolment and sign-in using
Playwright's virtual WebAuthn authenticator (Chromium), ask a question that
is in the corpus (citations render), ask one that is not (refusal text
verbatim, per the refusal contract), Settings device list and revoke.
Artifacts: screenshot and video per browser.

Known limit: the virtual authenticator covers protocol correctness, not the
real Face ID ceremony. See the manual checklist below.

## Tier 3: visual dress rehearsal (human or agent-driven, local VMs)

The full "watch it like a client" run from `planning/03`, on disposable VMs:

- **macOS:** [Tart](https://tart.run). Pull a stock macOS image once, keep it
  as the golden "fresh out of the box Mac", clone per run (seconds, APFS
  copy-on-write), run the install in the VM window, record with the host
  screen recorder plus asciinema inside, delete the clone. The same image
  pulls onto any Apple Silicon Mac, which is what makes the bench portable.
- **Windows:** UTM (free) with a Windows 11 ARM VM, same clone-and-delete
  pattern, for watching the PowerShell path with human eyes. A DPAPI
  CurrentUser encrypt/decrypt round trip passed on one matching Windows 11
  field machine on 2026-08-30. That is one-machine field proof only. It is not
  a universal Windows production claim and does not replace the clean Windows
  matrix, fresh-user, moved-profile, or recovery checks.

Disk budget: roughly 60GB for the macOS image and 30GB for Windows. Run
from an external SSD if the host drive is tight (set `TART_HOME`).

Narration protocol per `planning/03`: timestamped log of confusion, doubt,
boredom (actual seconds), dread, and unearned trust.

## Break-tests (INS-03)

From `planning/03`, run at least once per release cycle, cheapest first:
bad token, Free-plan limits mid-drain, network drop mid-step, Ctrl-C
mid-setup, wrong account selected. Judgement per failure message: could a
non-technical owner act on it without calling us. If not, the message is
the defect.

## Manual checklist before every client install day

The short list automation cannot cover:

1. Real passkey enrolment with Face ID on an actual iPhone against the test
   brain (domain settled first; passkeys bind to the exact host).
2. One real `brain eval --golden-20` guided session end to end.
3. Read the latest Tier 1 transcripts for anything a client would ask about.

## Evidence filing

Transcripts, recordings, and defect lists feed the release gates: UX-01
(watched-use evidence), INS-03 (failure messages), REC-02 (teardown /
offboarding). File defect write-ups with the gate id in the title.

---

## Build status

| Piece | Status |
|---|---|
| Tier 0 suite | BUILT (`npm test`) |
| Test account + keychain-held scoped token | BUILT 2026-08-27 (token verified; Vectorize create/delete probe passed). Identifiers in the private bench note. |
| `scripts/teardown-test-brain.mjs` | BUILT 2026-08-28. Allowlist-only, dry-run by default, refuses protected and non-test names; create/detect/delete verified live. |
| `install-matrix.yml` (Tier 1) | TODO |
| Playwright suite (Tier 2) | TODO |
| Tart bench (Tier 3, Mac) | BUILT 2026-08-28. Tart 2.32.1 + `macos-tahoe-base` (26.6.2); clone boots, SSH drivable, full install verified end to end in 8s. ⚠️ Requires WARP disconnected. |
| UTM bench (Tier 3, Windows) | TODO (disk now available: 35GB free after 2026-08-27 cleanup) |
| Golden-20 eval harness | BUILT (`brain eval <manifest> --golden-20`) |
| `scripts/check-install-page-version.mjs` | BUILT 2026-08-28. Compares the live install page's pinned version to the latest GitHub release. On 2026-08-29 it exits 1 because the page ships v0.1.19 while GitHub latest is v0.1.23. Not in `npm test` because it needs the network. |

---

## First bench run: 2026-08-28

The bench was built and run for the first time. Tart 2.32.1, a clone of
`ghcr.io/cirruslabs/macos-tahoe-base` (macOS 26.6.2), driven over SSH. Three
findings, in severity order.

### F-01 (CRITICAL, client-facing): the install page is behind the release

`financialbrain.ai/install` hardcodes the release it hands clients. The first
bench found v0.1.16 while GitHub latest was v0.1.19. A cache-busted recheck on
2026-08-29 found the page at **v0.1.19** while GitHub latest was **v0.1.23**.
The mechanism is still unfixed even though the pinned number changed.

A client using the page therefore installs an older line. For the 0.2.0
candidate, this remains a hard handoff blocker until the immutable release is
published, the page is pinned to that exact tag, and this check exits 0.

The original v0.1.16 observation missed these five shipped commits:

- `e29f580` Passkeys: the owner's face is the key, on every device
- `179ef3a` Answer confidence: every answer says how much to trust it
- `b124814` Provision the read-only proxy key, and ship the Golden 20 guided session
- `d0831eb` Remember the Cloudflare token once per machine, per account
- `98e126a` Worker auth modules follow the .js convention the deployer collects

At the time, that meant no `/app` passkey owner access and no
`brain eval --golden-20`. The current gap is broader: v0.1.19 does not contain
the integrated 0.2.0 owner workspace, entity scope, document grants, financial
actions, connector hardening, or their acceptance tests.

**Fix:** the version must not be hardcoded in the page. Resolve it from the
GitHub "latest release" API at build or run time, or make bumping it a
required step in the release checklist.

### F-02 RETRACTED: the README's v0.1.20 link is deliberate

First read as a defect: the README installs `v0.1.20`, which is unreleased and
404s. It is not a defect. `test/current-version.test.mjs` pins package.json,
the lockfile, the manifest template, the changelog and both README install
links to the same version, so the README is bumped with the version and is
already correct the moment the tag is published. The only exposure is the
window between bump and publish, and it is an accepted trade-off enforced by
a test. Changing it breaks that test, which is how this was caught. Left
alone.

### F-03 CORRECTED: Node is handled, and the long wait was our own VPN

A fresh macOS 26.6.2 install has no `node`, `npm`, or `brew`, so the README's
command dies with `zsh: command not found: npm`. The **install page** handles
this correctly as step 1 of its ready-card: "Node.js LTS", a `Get Node.js`
button to nodejs.org, "close and reopen Terminal", then a `node --version`
check expecting v22 or higher. Only the README's quick path assumes Node.

An earlier draft of this document recorded a 4m32s silent hang on install as
a UX defect. **That was Cloudflare WARP on the host, not the product.** With
WARP disconnected the same install completes in **8 seconds**. Retracted.

### F-04 (SERIOUS, fixed): doctor said "ready to install" on a garbage token

`brain doctor` with `CLOUDFLARE_API_TOKEN` set to
`cfut_thisIsNotARealTokenAtAll1234567890` printed
`ok  ready to install` and exited 0. `checkCfToken` only tested whether the
variable was *set*, never whether Cloudflare would accept it. A client who
pastes a truncated, revoked, or expired token was told everything was fine and
then failed deep inside provisioning, which is the worst place to learn it.
This is the same "unearned trust" class as the `ok: true` on a broken install.

**Fixed and corrected again** in `doctor.mjs`: user-owned tokens are checked at
`/user/tokens/verify`; account-owned tokens are checked at
`/accounts/{account_id}/tokens/verify`. A token fails closed only after every
applicable ownership path rejects it. Without an account id, a user-endpoint
rejection is indeterminate because the token may be account-owned. Active
token, `ok`. Expired or disabled token, `fail` with what to check. Network
unreachable, `warn` that says it could not verify rather than guessing either
way. Credential-free fixtures cover valid user-owned, valid account-owned, and
invalid tokens in `test/doctor.test.mjs`.

### F-04A (SERIOUS, fixed locally): account-owned token false-negative

The earlier F-04 fix sent every token through the user-owned endpoint. A valid
account-owned token was therefore reported as invalid even though Cloudflare
provides a separate account-scoped verification path. This was independently
reproduced from the Doctor code and fixed with the ownership-aware flow above.
No credential or live Cloudflare resource was used for reproduction or proof.

### F-05 (MODERATE, fixed): the no-token remedy contradicted itself

With no token at all, doctor said "Create one in the CLIENT's account", then
immediately "Recreate the account-scoped token with Vectorize: Edit". You
cannot recreate a token you have never had. The Vectorize remedy was being
appended verbatim to a case it was not written for. It also called it "the
CLIENT's account", which is operator jargon in text the owner may be reading.

**Fixed**: the plan-and-limits advice is now `CF_PLAN_NOTE`, shared by both
paths; only the genuine Vectorize failure gets the "Recreate" wording; and the
account is described as "the Cloudflare account that will own this brain".

## Bench gotcha: Cloudflare WARP breaks VM networking

With **Cloudflare WARP connected on the host**, the Tart VM can ping the
internet (ICMP to 8.8.8.8 fine, DNS fine, raw TCP connect fine) but **every
TLS handshake hangs**: the Client Hello goes out and no reply returns, so
curl and npm time out with `ETIMEDOUT` and misleading "you are behind a
proxy" advice. WARP already excludes `192.168.0.0/16`, so host-to-VM SSH
keeps working, which makes the VM look healthy while all outbound HTTPS is
dead. Lowering the VM MTU to 1400 does not fix it; a clean VM restart does
not fix it.

**Before any VM run, disconnect WARP** (or add a WARP split-tunnel exclusion
for the VM subnet). Both are changes to the operator's own machine settings,
so they are a human step, never an automated one. This affects the bench
only. A real client installs on their own host, where WARP works normally.

Add to the pre-run checklist: `warp-cli --accept-tos status` must not report
`Connected` when a VM install test is about to run.

---

## Second bench run: 2026-08-28, a real provision end to end

Ran `brain verify` → `provision` → `migrate` → `deploy` → `secrets` against a
live account, then a clean `brain setup` from nothing. Four findings.

### F-06 (SERIOUS, fixed): the index was named after the template placeholder

`provision` created a real Vectorize index literally called
`filled_in_by_provisioner`. The template ships that string for three fields;
two are ids it genuinely fills in, the third is the index NAME, and a truthy
placeholder sailed past the `|| <slug>-brain` default.

The name is not the danger. Provision **adopts** an index whose name matches,
so a second install into the same account would adopt the first one's index
and two clients would share a vector store. Fixed in `brain.mjs`; two
regression tests in `test/provision-guards.test.mjs`.

### F-07 (MODERATE, FIXED): the printed next-steps do not work

`provision` ends with "next: brain migrate, then deploy, then secrets, then
health". Following that exact sequence **fails at `secrets`**:

```
fail  no ADMIN_KEY was found in durable storage. Run `brain setup <manifest>`
```

Only `brain setup` generates the admin key, so the granular path the tool
recommends is a dead end. The failure text is good and names the fix; the
guidance that led there is the defect. Either the hint should say `brain setup`,
or `secrets` should generate the key.

### F-08 (SERIOUS, FIXED): a healthy clean install exits 1 with raw HTML

A clean `brain setup` provisioned, migrated, deployed and set all three secrets
correctly, then ended:

```
fail  drain failed (404): <!DOCTYPE html>
      <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
```

Exit code 1. The install was **fine**: `/health` returned
`{"ok":true,"status":"ok"}` moments later. The 404 is the workers.dev route not
being live yet when setup immediately called drain, and the handler prints the
raw Cloudflare error page into the client's terminal.

This is the mirror of the token bug. That one claimed success it had not
earned; this one claims failure that did not happen, on a working install, on
install day. Drain needs a short retry against a fresh deploy, and the error
path must never dump an HTML body to the terminal.

### F-09 (MINOR, FIXED): R2 warns even when the manifest disables it

With `r2_bucket: null`, `verify` still probes R2 and warns the client must
enable it "which requires a payment method". Confusing for an install that
does not use R2.

### Timing on a clean run

251 seconds from nothing to a deployed, migrated, secret-bearing brain. No
20-minute safety pause: the pause seen earlier was triggered by running the
granular steps out of order first, not by a clean install.

---

## Break-tests (INS-03), first real run: 2026-08-28

Five injections against a live account, judged on one question: **could a
non-technical owner act on this message without calling us?**

| # | Injection | Verdict |
|---|---|---|
| BT-1 | Invalid `CLOUDFLARE_API_TOKEN`, `brain verify` | **CALL US** — see F-10 |
| BT-2 | Invalid token, `brain doctor` on the released v0.1.19 | **CALL US** — fixed on main |
| BT-3 | Valid token, wrong `account_id` in the manifest | **ACT ON IT** — model message |
| BT-4 | SIGINT mid-provision, then plain re-run | **ACT ON IT** — recovers, 47s |
| BT-5 | Network loss mid-run | not run; needs a controlled network shim |

### BT-2, the released version, is the case the fix was written for

On v0.1.19 (what every client installs today) a completely invalid token
produces this, verbatim:

```
  ok    Node                v24.13.1
  ok    Network             reached api.cloudflare.com (HTTP 400)

  What to do
  Vectorize
      Recreate the account-scoped token with Vectorize: Edit. ...
fail  1 blocking problem(s).
```

The token is never mentioned. The owner is sent to fix Vectorize permissions
they do not have a problem with. On `main` the same input now says: *"The value
in CLOUDFLARE_API_TOKEN is not a token Cloudflare will accept."* Confirmed by
running both.

### BT-3 is what a good failure looks like

```
fail  the manifest declares account 0000...0000, but this token can only see:
        [account-id-redacted]  <account name>
      Refusing to provision into a different account than the manifest names.
```

States the mismatch, shows the real value, explains the refusal. Use this as
the house pattern.

### F-10 (SERIOUS, FIXED): `verify` blames itself for the client's typo

An invalid token in `brain verify` produces:

```
unexpected error  GET /accounts failed (403): 9109: Invalid access token
  This is a bug in the installer, not something you did wrong.
```

It is not a bug in the installer, and it *is* something the owner can fix. A
mistyped or expired token is the single most likely install-day mistake, and
this is the one message that tells them to stop trying. Still present on main:
the doctor fix hardened `checkCfToken`, not `verify`'s error path. A 403 with
Cloudflare code 9109 / 10000 must be classified as a credential problem and
routed to the token remedy, never to the unexpected-error handler.

### F-11 (MINOR, fixed): the success screen printed a path like `../../../../../../../private/tmp/...`

The final screen used to render the manifest path
relative to cwd, which for any manifest outside the working directory produces
a wall of `../`. It appears three times: the "manifest updated" line, `brain
ask <path>`, and `brain ingest <path>`. Print an absolute path, or the relative
one only when it is actually shorter. It now chooses the shortest legible form,
with a focused cross-platform regression test.

### F-12 (MODERATE, fixed): setup edited the operator's own global MCP config

`brain setup` detects local Claude Code / Codex installs and writes the new
brain into `~/.claude.json` and `~/.codex/config.toml`, then prints "It is
connected to: Claude Code, Codex." There is no opt-out flag and no uninstall.

For a client installing their own brain this is the right default. For whoever
runs installs *for* clients it is not: every install silently adds an MCP
server pointing at that client's brain to the operator's machine, and it stays
there after handoff, which sits badly beside the promise that we keep nothing
and revoke access at handoff. It also accumulates dead entries for every test
or trial install.

`brain setup --no-connect` now skips local Claude Code and Codex registration
and prints the later `brain mcp-config` command. The default remains the right
one for an owner installing on their own machine. Verified during earlier
testing that a test install left a live
`[mcp_servers.brain-test-bt]` block behind; it had to be removed by hand.


---

## Fix pass, 2026-08-28

F-07 through F-12 are fixed in the 0.2.0 candidate with focused regression
coverage. This does not close F-01, the missing Tier 1 fresh-machine setup
workflow, the missing browser matrix, the Windows human bench, or the physical
passkey and provider field gates.

## Candidate issue triage, 2026-08-30

- F-04 was stale as a blanket "fixed" claim and is corrected above. Its
  account-owned variant is locally fixed with deterministic fixtures.
- Issue #5's per-isolate degraded allowance is historical evidence, not the
  current candidate design. The candidate uses an atomic D1 reservation before
  provider invocation and retains a conservative reservation on failures.
- Fable audit statements are hypotheses until independently reproduced. They
  do not close or reopen an issue, and they do not count as release proof.
- Tracker entries are marked fixed only after the focused regression and full
  suite pass. Provider and fresh-machine entries remain open until their named
  live acceptance is performed.


## F-08, wider than first thought

The first observation was a 404 from the workers.dev route. Re-running against
fresh installs showed a second symptom with the same shape: `drain failed (401):
unauthorized`, immediately after setup wrote the three secrets. Retried by hand
two minutes later, the same drain succeeded with no changes. Both are a
brand-new install being asked a question before it can answer, and both ended a
completely healthy setup with exit 1. The warm-up covers both.

**Test-hygiene warning, learned the hard way.** Two runs in this pass appeared to
show route propagation taking over three minutes. They did not. Both manifests
were copied from a manifest that had already been through setup, and setup
writes the live address into `brain.domain`. Drain was correctly calling the
address it was told to call: a worker that had since been deleted. Always build
a test manifest from `templates/brain.manifest.json`, never by copying a used
one, or the tool will look broken while doing exactly the right thing.
