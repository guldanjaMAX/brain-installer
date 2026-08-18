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
| 3 | A scoped API token **and** `wrangler login`, both | 5 min | See "Credentials: you need BOTH" below |
| 4 | An Anthropic API key | 5 min | The answers run on their key, so cost and data both stay theirs |

Nothing else. No Supabase, no second vendor, no database password.

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

## Credentials: you need BOTH

An earlier version of this document offered these as alternatives. That was
wrong, and following it stalls the install at step three. The API token drives
verify, provisioning, migrations, deploy and secrets; the wrangler login exists
because no API token can reach Vectorize. `brain doctor` checks for both.

### Part 1: a scoped API token

The client issues a token at dash.cloudflare.com, My Profile, API Tokens,
Create Token, Custom token, with exactly these permissions:

    Account > Workers Scripts        Edit
    Account > D1                     Edit
    Account > Workers AI             Read
    Account > Workers R2 Storage     Edit    (only if the manifest sets r2_bucket)

Set an expiry. Nothing here needs to outlive the engagement.

**Do not bother adding a Vectorize scope to the token.** A token carrying it
still returns a flat `Authentication error 10000` while verifying as *valid and
active* (measured 2026-08-17 on every available token). Vectorize goes through
the wrangler login below; the token covers everything else.

`brain verify <manifest>` probes all five and names whichever is missing, so run
it the moment the token arrives rather than at the start of the session.

### Part 2: the client's own browser session

On the install call, at the client's keyboard:

```bash
npx wrangler@4 login
```

They approve in their own browser. That is all: **leave the API token exported.**
The installer strips the token from wrangler's own child processes itself, so
the two never conflict. (Unsetting it by hand, as an older version of this page
said to, breaks every API step.)

The session is theirs and expires on its own. Since the client also creates the
token in their own account and it never leaves their machine, the custody story
holds either way: nothing long-lived to their business ever exists on mine. The
login is, as of 2026-08-17, the only path verified working for Vectorize.

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
