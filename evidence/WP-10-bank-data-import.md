# Bank data import: a downloaded file, and a hosted feed, into one ledger

Branch `feat/bank-data-import`, worktree `/private/tmp/brain-bank-import`,
off `wave0/connector-gaps`.

WP-14 built the ledger and left it empty. This work package fills it, from the
two sources an owner actually has: the export file their bank already offers
them, and a hosted read-only connection they authorise themselves.

Both write through **one** function. That is the load-bearing decision in this
change and everything else follows from it.

## Files

| File | What it is |
|---|---|
| `ingest/bank-export.mjs` | the file reader: OFX, QFX, and CSV with column detection and refusal. Zero dependencies |
| `worker/src/lib/fin-import.js` | the ONE write boundary into `fin_*`, shared by both sources |
| `worker/src/lib/bank-feed.js` | the hosted feed: authorisation, custody, bounded sync, routes |
| `migrations/d1/0018_bank_feed.sql` | 3 connector-state tables. **No ledger column was added or changed** |
| `ingest/extract.mjs` | `.ofx` and `.qfx` registered through the existing format machinery |
| `brain.mjs` | the secrets trap, both halves, gated on a manifest flag |
| `doctor.mjs` | the return-address preflight |
| `manifest.schema.json` | `corpora.bank_feed` |
| `worker/src/index.js` | three lines: the owner surface mounted in front of the key gate |
| `operations/cloudflare-recovery-adapter.mjs` | schema 16 tables added to the reviewed durable list, pin moved 15 → 16 |
| `test/bank-export.test.mjs` (79) · `worker/test/bank-feed.test.mjs` (90) · `test/bank-feed-secrets.test.mjs` (22) | registered in the `npm test` chain |
| `test/fixtures/bank/` | 2 OFX-family and 5 CSV fixtures, all invented |

**The ledger schema was not touched.** Every fact these two readers produce fits
the thirteen tables as written, including the two that mattered most: an
unsigned `amount_minor` beside an explicit `direction` gave the sign convention
somewhere to be normalised to, and `raw_amount_minor` / `raw_sign_convention`
gave the source figure somewhere to survive so a disagreement stays diagnosable.
No column was added and none was needed.

## Part A — the bank export file reader

Every bank lets its own customer download OFX, QFX or CSV. No agreement, no
approval queue, no per-account fee, and it works for the small institutions no
hosted service supports. It is also the only path that needs nothing from anyone
but the owner.

**OFX and QFX** are parsed properly rather than regexed. OFX 1.x is SGML, where
a leaf element has an opening tag, a value, and usually no closing tag; OFX 2.x
is XML; QFX is OFX plus vendor tags. One tokenizer reads all three, closing an
unclosed leaf implicitly when the next tag opens — which is what the format
means, and getting it wrong nests every element inside the one before it. The
reader takes accounts, account type, the statement period, every transaction
with its date, amount, description and the bank's own unique id, and both the
ledger and available balances with their as-of date.

**CSV has no standard shape**, so the reader establishes the mapping and
declines when it cannot. There are exactly three ways a CSV can tell us which
way money moved, and only those three are accepted:

| Shape | What establishes the direction |
|---|---|
| A. paired `Debit` / `Credit` columns (or withdrawal/deposit, money out / money in, paid out / paid in) | the column names say it |
| B. a signed amount plus a transaction-type column | the type says it, and the signs are cross-checked against it; a file that contradicts itself is refused |
| C. a signed amount plus a running balance | derived and then **verified**: one reading must fit every checkable balance step and the other must not |

Anything else is refused. A single `Value` column with no pair, no type and no
balance is genuinely unknowable from the file, roughly half of real exports use
each convention, and being wrong inverts every figure downstream. The refusal
names the column, lists the three things that would have settled it, and tells
the owner what to re-export.

The same restraint runs down to individual values. `1,23` could be one and
twenty-three hundredths or one thousand two hundred and thirty, so it is
refused. `10.005` in a two-place currency is refused rather than rounded into a
figure nobody wrote. A date column readable either day-first or month-first is
refused unless some row in it settles the order for the whole column.

Amounts never touch a float. They are parsed from their digits into integer
minor units, and the test asserts `0.10 + 0.20 === 0.30` in minor units, which
is the thing float arithmetic cannot do.

**The full account number never reaches the database.** An OFX file contains it;
the account is keyed by a non-reversible digest of institution plus number, only
the last four digits survive into the `mask` column the schema already limits to
four characters, and the test asserts the number appears nowhere in the output.

`.ofx` and `.qfx` are registered through the existing `register()` machinery,
lazily, in the zero-dependency core, exactly as `.ics` and `.rtf` were. The
corpus text they produce is deliberately coarse: a period, a balance, and a line
per transaction in words rather than signs. The figures live in the ledger,
where they can be added up.

## Part B — the hosted feed

Ported from a working single-operator implementation, rebuilt where the reference
assumed one trusted person who owned the data, the key and the bank.

**The account holder authorises it themselves.** The bank login happens on the
bank's own screen or the aggregator's hosted one. No password, no one-time code,
no security question and no bank credential of any kind is seen, requested,
handled or stored by the operator, by this codebase, or by anyone but the
account holder and their bank. What comes back is a read-only reference for
fetching history, and it lives encrypted in the client's own database inside the
client's own cloud account.

The read-only guarantee is not this code being careful. It is enforced at
authorisation time by never requesting a product that can move money.
`REQUESTED_PRODUCTS` is `["transactions"]` and `FORBIDDEN_PRODUCTS` names the
three that can initiate movement plus the one that returns full account and
routing numbers, with a test asserting the literal arrays so a future "just add
one more scope" cannot land unreviewed.

The reference implementation's connect page asked the client to paste the admin
key into a form and kept it in `localStorage`. That key can ingest, purge,
reindex and drain. The page here sits behind the owner's passkey session, in
front of the key gate, exactly like `/app`, and the test asserts the string
`X-Admin-Key` appears nowhere in it. Its Content-Security-Policy is widened to
exactly the configured SDK origin and nothing else — the default owner policy is
`default-src 'none'`, which blocks the SDK silently as a console violation
nobody sees. The redirect return leg both halves of it are kept, because many
banks bounce the browser out to their own site and dropping either half makes
every one of those banks fail at the last step.

**Reversibility, as required.** The two service identifiers are read from `env`
and appear nowhere as a module constant; so does the provider host, so the
module contains not one literal URL and a change of aggregator is a manifest
edit rather than a code change in every install. The tenant reference is
confined to `tenantReference()` — one function, asserted by a test that counts
occurrences — so per-client (recommended: one leaked worker secret is one
client's exposure) and a shared operator account differ only in what values are
set. The tenant column is on every ledger row regardless, because it is free now
and a migration on a live financial ledger later.

**Custody.** The access reference is encrypted with AES-GCM under a key derived
from a worker secret the database does not contain, stored with a key version so
it can be rotated. It fails closed: with no key material available it refuses to
store rather than storing plaintext. `migrations/d1/0018` carries a CHECK that
makes that structural — ciphertext is base64 and base64 has no hyphen, so a
plaintext reference is refused by the database itself. Every path out of the
module runs through one redactor, because the reference implementation put the
provider's raw error string into an API response, which is how a live bank
credential ends up in a support ticket.

**Two years of history is queued, not run.** Authorisation returns immediately
with `history.state: "queued"`; a bounded slice drains it, four pages per
invocation, and **the cursor is committed after every page** rather than at the
end of the run. Committing at the end means a first load too big for one
invocation never finishes at all: the clock kills it, the cursor never moves,
and the next run repeats the same doomed work forever. Progress is readable
while it is still running, so an operator can tell a client where it has got to.

**Sandbox is the default**, so an install can be rehearsed the same day rather
than waiting on the client's production approval.

Two behaviours worth naming because the reference got them wrong: a withdrawn
line is **tombstoned, never deleted** (hard-deleting makes "why did last month's
total change" unanswerable and is unrecoverable), and a failing connection moves
to a state of its own — `reauth_required`, `permission_revoked` — that surfaces
in `needs_attention`, instead of being retried silently forever. Disconnecting
revokes at the provider and destroys the stored reference, and **keeps the
financial history**, because nobody asked to delete their own records.

## The sign convention, per format, and how each is pinned

This is the one that inverts a P&L while every citation still resolves.

| Source | Convention | Where it is written down | The test that pins it |
|---|---|---|---|
| OFX / QFX | `TRNAMT` is signed against the account's own balance: **negative is money leaving**, positive is money arriving. On a card the same rule holds: a purchase is negative, a payment to the card positive | `OFX_SIGN_CONVENTION` in `ingest/bank-export.mjs`, with the reasoning in the comment block above `readOfxStatement` | `OFX SIGN: a NEGATIVE TRNAMT is money LEAVING the account`, its positive twin, a whole-month arithmetic check, and the two `QFX SIGN` cases |
| CSV shape A | a figure in the **debit** column is money leaving; the column NAMES carry it | `CSV_SIGN_CONVENTIONS.pairedColumns` | `CSV SIGN (paired): a figure in the DEBIT column is money leaving`, plus its credit twin and a month total |
| CSV shape B | the **type** column states the direction; the amount's sign is cross-checked and a contradiction is refused | `CSV_SIGN_CONVENTIONS.typeColumn` | `CSV SIGN (typed): DEBIT is money leaving and CREDIT is money arriving, whatever the sign says` and the contradiction refusal |
| CSV shape C | derived from the **running balance** and verified: the accepted reading fits every balance step and the rejected one does not | `CSV_SIGN_CONVENTIONS.balanceVerified` | `CSV SIGN (verified)` pair, plus a case where the balance column fits neither reading and the file is declined |
| hosted feed | **positive is money leaving**, negative is money arriving. The exact opposite of a file | `BANK_FEED_SIGN_CONVENTION`, applied only in `directionFor()` | `FEED SIGN: a POSITIVE amount is money LEAVING the account`, its negative twin, and `FEED SIGN CONVENTION lands in the ledger the right way round` |

Two opposite conventions, one ledger. Both are normalised at the single write
boundary into an unsigned `amount_minor` plus a `direction`, the signed source
figure goes into `raw_amount_minor` and the convention's own name into
`raw_sign_convention`. One test asserts the crossover directly: a file saying
`-1875.40` and a feed saying `+1875.40` both land as an outflow of `187540`.

## The secrets trap

`reconcileWorkerProviderSecrets` DELETES any secret in
`WORKER_PROVIDER_SECRET_NAMES` that the manifest-derived allowlist does not
return. That is correct — it is how a brain switched off Supabase stops carrying
a Supabase credential — and it is also how a bank feed dies quietly. Add the two
new names to the managed list without teaching `optionalWorkerSecretNames` to
return them when the manifest enables the feed, and the next routine `brain
secrets` run deletes them: every bank the client authorised stops being read, no
error anywhere, on an install nobody touched.

**Both halves changed, gated on `corpora.bank_feed.enabled === true`**, and the
comment on each now points at the other and says they must never be edited
apart.

The proof is not that a constant contains a string. `test/bank-feed-secrets.test.mjs`
runs the real `cmdSecrets` against an offline Cloudflare fixture whose worker
already holds both secrets, and asserts:

```
PASS  A RECONCILIATION RUN ON A FEED-ENABLED BRAIN LEAVES THE BANK SECRETS INTACT
PASS  and it re-sets them from the environment rather than leaving them unmanaged
PASS  with the feed OFF the same run removes them, which is the behaviour that makes the list worth having
PASS  and it still never touches a secret name it does not manage
PASS  the half-done change is exactly what the second half prevents
```

**Deploy before secrets**, never the reverse: a secret is set *on* a script, and
the deploy carries `keep_bindings` so setting them afterwards sticks. A test
drives `cmdSecrets` against an account with no such worker and asserts the error
says `has not been deployed yet` and names `brain deploy`, and that it echoes
back neither the admin key nor a service secret.

## The return address, checked before anyone is sitting with a client

A bank's own login page returns the browser to an address that must be
**registered with the provider in advance**, and every brain has its own
hostname. Skip it and the client authorises successfully at their bank and lands
on a dead return, in front of you, mid-session, with nothing to do about it for
however long a dashboard edit takes to propagate.

So it is a `brain doctor` check, offline, needing no credential and no network,
which means it runs in the quiet hour before the session. It computes this
brain's own return address from `brain.domain`, fails when
`corpora.bank_feed.registered_redirect_uris` does not contain it, and prints the
exact address to register and where. The path constant exists in two runtimes —
the operator's laptop and the client's worker — so a test asserts the two agree
and cannot drift.

## Discrimination: inverted, confirmed failing, restored

Each convention was inverted in the shipped code, the suite re-run, and the
change reverted. Exact first lines, verbatim:

**Feed** — `directionFor` flipped to `amount > 0 ? "inflow" : "outflow"`:

```
FAIL  FEED SIGN: a POSITIVE amount is money LEAVING the account  inflow
FAIL  FEED SIGN: a NEGATIVE amount is money ARRIVING  outflow
FAIL  FEED SIGN in the envelope: a positive figure becomes an outflow of the same magnitude
FAIL  THE TWO SOURCES AGREE ABOUT THE SAME MONTH despite opposite conventions
FAIL  FEED SIGN CONVENTION lands in the ledger the right way round  [["p1","outflow"],["p2","inflow"],["p3","inflow"]]
FAILURES: 84/90 checks passed
```

**OFX/QFX** — the direction line flipped to `amount.minor < 0 ? "inflow" : "outflow"`:

```
FAIL  OFX SIGN: a NEGATIVE TRNAMT is money LEAVING the account
FAIL  OFX SIGN: a POSITIVE TRNAMT is money ARRIVING
FAIL  OFX SIGN: the month's arithmetic comes out the right way round
FAIL  QFX SIGN: a purchase on a card is a negative TRNAMT and reads as money leaving
FAIL  QFX SIGN: a payment to the card is positive and reads as money arriving
FAIL  the rendered text says which way money moved in words, not by sign
FAILURES: 73/79 checks passed
```

**CSV paired columns** — debit and credit handling swapped:

```
FAIL  CSV SIGN (paired): a figure in the DEBIT column is money leaving
FAIL  CSV SIGN (paired): a figure in the CREDIT column is money arriving
FAIL  CSV SIGN (paired): the month's arithmetic comes out the right way round
FAIL  the two CSV shapes describing the same month agree, line for line
FAILURES: 75/79 checks passed
```

After restoring all three: `bank-export: 79/79 checks passed` and
`bank-feed: 90/90 checks passed`.

Worth noting what the third run caught that a narrower test would not: `the two
CSV shapes describing the same month agree, line for line` failed too. Two
differently-shaped files describing the same month must produce identical rows,
and that cross-check catches an inversion in either one of them.

## What is NOT proved here, and cannot be

**No live bank connection was made, and none was attempted.** Everything in Part
B runs against a scripted provider. That means the following are asserted
against a fixture and are NOT field-verified:

- the provider's real response shapes for `/link/token/create`,
  `/item/public_token/exchange`, `/accounts/get`, `/transactions/sync` and
  `/item/remove`;
- that a real bank's OAuth return leg works end to end through this page;
- that a real return address registration is accepted by the provider's
  dashboard, or that the check's idea of the address matches what the provider
  wants character for character;
- the real error codes a broken connection emits, beyond the four this maps;
- rate limits, page sizes, and how long a real two-year load actually takes.

The first live rehearsal should be in **sandbox**, which is what sandbox support
is for, and the first thing to verify is the return address, because it is the
only one of these that cannot be fixed while a client is waiting.

Also not built, deliberately, and each is a real thing:

1. **Webhooks.** The reference has none, and this does not add them. Push
   notification of `ITEM_LOGIN_REQUIRED`, consent expiry, revocation and new
   activity is genuinely valuable, and it is unauthenticated POSTs that must be
   signature-verified against the provider's published key. An endpoint that
   mutates connection state without that verification is a free denial of
   service on a client's bank feed, and inventing a non-standard check would be
   worse than not having one. Until then, detection is the daily pull, which
   means up to a day of staleness — surfaced in `needs_attention`, not silent.
2. **Re-authorisation is written but not exercised.** `createLinkToken` supports
   update mode and correctly reuses the existing connection rather than
   exchanging a second one, which would orphan the first and split the history.
   No live path has confirmed it.
3. **The scheduled trigger.** The worker has one cron slot and the vector drain
   owns it. `runFeedSlice` is shaped for a scheduled caller and is currently
   reachable only through `POST /api/bank-feed/sync` and the queued slice that
   follows an authorisation. Wiring a second cron changes `brain deploy`'s
   schedule PUT, which is a fatal-on-failure path and deserves its own change.
4. **Reconciling the ledger against the account balance.** Opening balance plus
   net activity should equal the closing balance, and a nonzero delta is the
   only reliable detector of a bank double-posting the same fee under two
   different ids — a real artifact a primary key cannot catch. The ledger has
   `fin_reconciliations` waiting for it.
5. **CSV account identity.** A CSV does not say which account it is, so a
   CSV-imported account gets a per-file key and an account kind of `other`,
   which the ledger records as `neither` — so it is never counted as cash on the
   strength of a guess. Attaching a CSV to a known account needs the owner to
   say which one, and that is a write path this wave does not have.

## Verification

Full chain, exit code read from its own file:

```
$ npm test > /tmp/bank.log 2>&1; echo $? > /tmp/bank-exit.txt
$ cat /tmp/bank-exit.txt
0
$ grep -cE "^FAIL |FAILURES|^not ok|AssertionError" /tmp/bank.log
0
```

The three new suites from that run:

```
bank-export: 79/79 checks passed
bank-feed: 90/90 checks passed
bank-feed-secrets: 22/22 checks passed
```

And the suites this change could most plausibly have broken:

```
migrations: all 76 checks passed
fin-d1: all 132 tests passed
PASS  published package contains 351 reviewed files and no client-private paths
PASS  Cloudflare recovery adapter is disposable-only, credential-safe, redirect-safe, and resumable
```

The recovery adapter pins a reviewed list of durable tables and stops before
exporting anything if a migration adds one it does not know. Schema 16's three
tables are now in it, gated behind their own list so older migration prefixes
still validate, and the pinned version moved 15 → 16. `bank_feed_link_sessions`
is durable but deliberately **not** exported, for the same reason
`auth_challenges` is not: it is single-use, minutes-long handoff state.

## Owner-voice note

The thing to know about this change is that the product can now read your bank
records, and the whole design is about the one way that can go wrong quietly.

Two sources describe the same money in opposite languages. A file your bank
gives you writes a minus sign when money leaves. A live connection writes a plus
sign for exactly the same thing. Read either one backwards and your income
becomes your spending, your profit becomes a loss, and every figure still has a
real citation sitting under it pointing at a real document. Nothing looks wrong.
So there is one place in the code where a sign becomes a direction, both sources
go through it, the original signed number is kept next to the answer along with
the name of the rule that produced it, and a test proves the crossover: a file
saying minus and a feed saying plus land as the same outflow, of the same
amount, on the same day.

The other half is refusing. A spreadsheet from your bank might have a column
called "Value" and nothing anywhere in the file that says whether a number in it
means money coming or going. About half of real exports mean each. There is no
clever way to tell, so the importer declines the file, names the column it could
not read, and tells you the three things that would have settled it. A line
whose amount is smudged is stored as a line nobody could read rather than
skipped, because a skipped line makes your month look smaller instead of
incomplete. And it will not round a figure with a third decimal place into one
you never wrote.

On the bank connection: you sign in to your bank yourself, on your bank's own
screen. Nobody here ever sees your password or your codes, and the thing that
comes back can look at your transactions and cannot move a penny. It is
encrypted before it is written down, in your own database, in your own cloud
account, and if you disconnect, it is destroyed and your history stays.
