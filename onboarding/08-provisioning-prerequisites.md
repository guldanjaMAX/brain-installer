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
| 1 | Claude Code plus an eligible Claude account | 5 min | Claude Code is part of the owner handoff and is connected directly to the Brain |
| 2 | Node.js 22 or newer | 5 min | Runs the Brain CLI and the pinned Wrangler 4 command |
| 3 | A Cloudflare account | 5 min | Everything lives here. Theirs, not ours |
| 4 | **Workers Paid plan on it** | 2 min | 5 USD/month minimum. The Free plan is prototype-scale, not a supported production home for a real corpus |
| 5 | An account-scoped, expiring API token | 5 min | One token drives every Cloudflare step |

No Supabase, database password, or separate answer-model API key is required.
The Claude account is for the owner's Claude Code client, not for Worker answers.

## Local tools before Cloudflare

Install Claude Code only from Anthropic's official installer. The owner signs in
in their own browser. Do not use `sudo`, a permission-bypass mode, or a copied
Claude credential. Then run:

```bash
brain tools
```

The automated part proves the Claude version, `claude auth status`, and
`npx wrangler@4 --version` in a credential-scrubbed child environment. In a real
terminal it also opens `claude doctor`, which owns an interactive terminal UI
and therefore cannot be truthfully replaced by a headless fixture.

Wrangler is fetched on demand at pinned major version 4. It is not installed
globally and it does not receive ambient Brain, Google, Zoom, bank, or mail
credentials just to print its version.

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
plan check through the scoped install token, so the dashboard remains the plan
proof.

Current limits:

- Vectorize pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/

---

## Credential: one scoped API token

The client issues a token at dash.cloudflare.com, My Profile, API Tokens,
Create Token, Custom token, with exactly these permissions:

    Account > Workers Scripts        Edit
    Account > D1                     Edit
    Account > Vectorize              Edit
    Account > Workers AI             Read
    Account > Workers R2 Storage     Edit    (only if the manifest sets r2_bucket)

Set an expiry. Nothing here needs to outlive the engagement.

Keep the value in the account owner's password manager. Do not email it,
message it, or put it in a shared terminal. The account owner enters it only at
the hidden prompt in `brain setup` or `brain update`. Low-level automation must
use an approved no-history secret-manager launcher.

Vectorize Edit was verified end to end on 2026-08-23: the account-scoped token
created the 768-dimensional index and all six metadata indexes through the API.

The guided setup and update paths probe every required permission and name
whichever is missing before making account changes. Run the appropriate path as
soon as the account owner has created the token, not at the start of a support
session.

### Compatibility fallback

If an older token cannot reach Vectorize, create a correctly scoped replacement
and enter it at the hidden `brain setup` or `brain update` prompt. Do not leave
the old value in a shell environment.

For a temporary compatibility test of an older account, the account owner can
instead run:

```bash
npx wrangler@4 login
```

They approve in their own browser. Provision uses that local OAuth session only
for Vectorize. New installs should fix the scoped token and use hidden prompt
entry so every client follows the same supported path.

---

## Verify before you start

Run `node brain.mjs setup <manifest>` for a new install or
`node brain.mjs update <manifest>` for an existing install. Enter the scoped
token only when the hidden prompt asks for it.

The preflight should show five green lines: account resolved, R2, D1, Workers,
Vectorize. A
warning on R2 is survivable and the brain runs without it. **A warning on
Vectorize is not** — it means the install would come up keyword-only, which
looks healthy and answers badly, and that is far worse than failing loudly.

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
