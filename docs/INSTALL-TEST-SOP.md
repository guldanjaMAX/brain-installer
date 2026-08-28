# Install Test SOP: Mac, Windows, and browsers

Written 2026-08-27. Companion to `planning/03-jay-installer-ux-test-plan.md`
(the narrated human rehearsal method). This document is the standing operating
procedure: what gets tested, on what machines, how often, and with zero
client data. Anyone with this repo and the test token can run it.

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
  pattern, for watching the PowerShell path with human eyes.

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
| `scripts/check-install-page-version.mjs` | BUILT 2026-08-28. Compares the live install page's pinned version to the latest GitHub release; currently exits 1 on real drift (F-01). Not in `npm test` (needs network). |

---

## First bench run: 2026-08-28

The bench was built and run for the first time. Tart 2.32.1, a clone of
`ghcr.io/cirruslabs/macos-tahoe-base` (macOS 26.6.2), driven over SSH. Three
findings, in severity order.

### F-01 (CRITICAL, client-facing): the install page ships v0.1.16

`financialbrain.ai/install` hardcodes the release it hands clients:
`q = "v0.1.16"` in the SetupGuide chunk, used to build the
`releases/download/${q}/brain-installer-${q}.tgz` URL. The latest published
release is **v0.1.19**. Verified against the live chunk on 2026-08-28 with a
cache-busted fetch.

A client installing today therefore misses five shipped commits
(`git log v0.1.16..v0.1.19`):

- `e29f580` Passkeys: the owner's face is the key, on every device
- `179ef3a` Answer confidence: every answer says how much to trust it
- `b124814` Provision the read-only proxy key, and ship the Golden 20 guided session
- `d0831eb` Remember the Cloudflare token once per machine, per account
- `98e126a` Worker auth modules follow the .js convention the deployer collects

That means no `/app` passkey owner access and no `brain eval --golden-20`,
which is the acceptance mechanic a founding-client guarantee is scored on.

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

**Fixed** in `doctor.mjs`: the check now calls `/user/tokens/verify`. Active
token, `ok`. Rejected or expired token, `fail` with what to check. Network
unreachable, `warn` that says it could not verify rather than guessing either
way, and names WARP as a likely cause. Regression tests added in
`test/doctor.test.mjs`.

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
