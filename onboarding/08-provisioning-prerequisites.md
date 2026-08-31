# Provisioning prerequisites

Everything that must be true **before** an install session starts. Verified
against live Cloudflare and current Cloudflare limits on 2026-08-24.

Supersedes the Supabase account steps in `02-client-effort-and-timeline.md`.
The brain no longer needs Supabase: it runs on the client's own Cloudflare
account alone.

---

## What the client needs

| # | Thing | Time | Why |
|---|---|---|---|
| 1 | Claude Code plus a current paid Anthropic plan that includes Claude Code | 5 min | Anthropic controls current eligibility, availability, and pricing; Financial Brain does not include that subscription |
| 2 | Node.js 22 or newer | 5 min | Runs the Brain CLI and the pinned Wrangler 4 command |
| 3 | A Cloudflare account, created during setup if needed | 5 min | Everything lives here. Theirs, not ours |
| 4 | **Workers Paid plan on it** | 2 min | 5 USD/month minimum. The Free plan is prototype-scale, not a supported production home for a real corpus |
| 5 | A current browser and the computer's OS keyring | already present on most computers | Wrangler keeps this Brain's Cloudflare approval protected locally |

No Supabase, database password, or separate answer-model API key is required.
The Claude account is for the owner's Claude Code client, not for Worker answers.
Confirm current plan eligibility and cost on Anthropic's official site before the
session. Do not quote a frozen price or imply that Financial Brain includes the
third-party subscription.

## Local tools before Cloudflare

Install Claude Code only from Anthropic's official installer. The owner signs in
in their own browser. Do not use `sudo`, a permission-bypass mode, or a copied
Claude credential. Then run:

```bash
brain tools
```

The automated part proves the Claude version, `claude auth status`, and
`npx wrangler@4.127.1 --version` in a credential-scrubbed child environment. In a real
terminal it also opens `claude doctor`, which owns an interactive terminal UI
and therefore cannot be truthfully replaced by a headless fixture.

Wrangler is fetched on demand at the profile-capable pinned release. It is not installed
globally and it does not receive ambient Brain, Google, Zoom, bank, or mail
credentials just to print its version.

## First Cloudflare account, or one you already have

For most owners, **Create my first Cloudflare account** is the clearest path.
The installer opens Cloudflare's official sign-up page and waits while the owner
creates the account, verifies the email address, and completes any sign-in
protection Cloudflare requests. Billing and 2FA stay entirely in Cloudflare's
pages.

If the owner already has Cloudflare, choose **Use a Cloudflare account I already
have**. Sign in normally. If that login can reach more than one account, the
installer lists them and asks the owner to confirm the exact account by name and
ID before it creates anything. An existing account is an alternate starting
point, not a special migration path.

One Cloudflare account can hold several separate Brains. Each Brain receives its
own Worker, D1 database, Vectorize index, secrets, hostname, and saved resource
IDs. Create another Cloudflare account only when separate billing or separate
administrators would be useful.

---

## Item 2 is the one that bites

Vectorize now has a Free allowance, but that does not make the Free plan a safe
production baseline for this product. At 768 dimensions, its 5 million stored
vector dimensions hold only about 6,500 chunks. The Free plan also hard-stops at
100,000 D1 row writes per day and 10 ms of Worker CPU per request. A normal
personal or company corpus can cross those limits during its first load.

**Confirm it before the session, not during it.** Cloudflare dashboard, Workers
and Pages, Plans. It should say Paid. Upgrading takes about two minutes and a
card. `brain doctor` proves Vectorize access, but Cloudflare does not expose the
account's paid-plan status through the install approval. The dashboard remains
the plan proof.

Current limits:

- Vectorize pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/

---

## Cloudflare sign-in

The normal setup opens Cloudflare in the owner's browser. Wrangler creates a
separate named profile for this Brain and keeps the approval in macOS Keychain
or the Windows credential store. The profile label is derived from a stable,
non-secret install identity. It does not contain the owner's name or account
ID, and the installer never falls back to an unrelated default Wrangler
profile.

After browser approval, the installer performs read-only checks against the
exact selected account for the account itself, Workers, D1, Vectorize, and
Workers AI. A missing permission pauses setup before any resource change. The
short-lived access value is held only in memory while that exact-account action
runs and is then cleared. The owner never needs to copy it into Claude, Codex,
a chat, a command, or a configuration file.

### API-token fallback

An expiring, account-scoped API token remains available for reviewed legacy,
automation, or recovery work. It is not the normal first-install path. When a
technician has confirmed that it is genuinely needed, use only the permissions
required by that operation:

    Account > Workers Scripts        Edit
    Account > D1                     Edit
    Account > Vectorize              Edit
    Account > Workers AI             Read
    Account > Workers R2 Storage     Edit    (only if the manifest sets r2_bucket)

The owner enters the value in the Brain CLI's hidden prompt, or automation uses
an approved no-history secret-manager launcher. It should not appear in chat,
argv, an environment file, a screenshot, a support note, or a shared terminal.
The earlier token path created a Vectorize index and all six metadata indexes in
a live test account on 2026-08-23. That is useful fallback evidence, not proof
of the new browser OAuth path.

---

## Verify before you start

Run `node brain.mjs setup <manifest>` for a new install or
`node brain.mjs update <manifest>` for an existing install. Choose create or
existing account, then complete Cloudflare's browser approval when it opens.

The preflight should show five green lines: account resolved, R2, D1, Workers,
Vectorize. A
warning on R2 is survivable and the brain runs without it. **A warning on
Vectorize is not** — it means the install would come up keyword-only, which
looks healthy and answers badly, and that is far worse than failing loudly.

The account-choice, exact-selection, keyring-only, permission, and in-memory
cleanup contracts have deterministic local tests. They do not prove a real
browser callback on the final Mac or Windows computer. The exact Wrangler OAuth
permission set's access to live Vectorize also remains a field gate. Keep the
release held until those Apple and Windows ceremonies and the live Vectorize
preflight are recorded on the exact candidate.

---

## What "keyword-only" actually costs

Worth being able to say out loud, because a client will ask why Paid is our
supported production baseline.

Without Vectorize, the brain can only find documents that **repeat the words in
the question**. Ask "how do we stop overwhelming a new customer with decades of
paperwork" and it finds nothing, because the document that answers it says
"without ordering up twenty years of homework" and shares not one word with the
question.

With Vectorize, that query returns the right document as the top hit. Verified
on 2026-08-17. That gap is the entire difference between a search box and a
brain, and it costs five dollars a month.
