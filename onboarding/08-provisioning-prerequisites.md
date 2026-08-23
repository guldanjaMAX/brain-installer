# Provisioning prerequisites

Everything that must be true **before** an install session starts. Verified
against live Cloudflare on 2026-08-17.

Supersedes the Supabase account steps in `02-client-effort-and-timeline.md`.
The brain no longer needs Supabase: it runs on the client's own Cloudflare
account alone.

---

## What the client needs

| # | Thing | Time | Why |
|---|---|---|---|
| 1 | A Cloudflare account | 5 min | Everything lives here. Theirs, not ours |
| 2 | **Workers Paid plan on it** | 2 min | 5 USD/month. **Vectorize cannot create an index on the free tier at all** |
| 3 | An account-scoped, expiring API token | 5 min | One token drives every Cloudflare step |

Nothing else. No Supabase, no second AI vendor, no database password.

---

## Item 2 is the one that bites

Vectorize is a paid-plan feature. There is no free allowance and no trial. If
the account is on the free plan, `brain provision` fails at the Vectorize step
and the install stops there.

**Confirm it before the session, not during it.** Cloudflare dashboard, Workers
and Pages, Plans. It should say Paid. Upgrading takes about two minutes and a
card, but discovering it live burns the first ten minutes of a session in front
of a client, which is the worst possible ten minutes to burn.

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

Vectorize Edit was verified end to end on 2026-08-23: the account-scoped token
created the 768-dimensional index and all six metadata indexes through the API.

`brain verify <manifest>` probes all five and names whichever is missing, so run
it the moment the token arrives rather than at the start of the session.

### Compatibility fallback

If an older token cannot reach Vectorize, the account owner can temporarily run:

```bash
npx wrangler@4 login
```

They approve in their own browser and leave the API token exported. Provision
uses this session only for Vectorize. New installs should fix the token scope
instead so every client follows the same token-only path.

---

## Verify before you start

```bash
node brain.mjs verify <manifest>
```

Expect five green lines: account resolved, R2, D1, Workers, Vectorize. A
warning on R2 is survivable and the brain runs without it. **A warning on
Vectorize is not** — it means the install would come up keyword-only, which
looks healthy and answers badly, and that is far worse than failing loudly.

---

## What "keyword-only" actually costs

Worth being able to say out loud, because a client will ask why the paid plan is
non-negotiable.

Without Vectorize, the brain can only find documents that **repeat the words in
the question**. Ask "how do we stop overwhelming a new customer with decades of
paperwork" and it finds nothing, because the document that answers it says
"without ordering up twenty years of homework" and shares not one word with the
question.

With Vectorize, that query returns the right document as the top hit. Verified
on 2026-08-17. That gap is the entire difference between a search box and a
brain, and it costs five dollars a month.
