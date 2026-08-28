# WP-14: the financial ledger schema, and the contract it settles

Branch `feat/wp14-financial-ledger`, worktree `/private/tmp/brain-wp14-ledger`,
off `wave0/connector-gaps`.

This work package adds the structured financial layer to the client's own D1,
and it is written to close a joint issue rather than a defect: the installer
creates a document corpus and the client-facing UI reads a structured financial
one, and until now those two things had no shared contract at all. A second
household could complete a successful install and open an empty product. Nothing
errored. Every screen rendered. There was simply nothing in it.

The schema below was not designed and then compared against the UI. It was
**derived from the UI**, screen by screen and field by field, and the mapping is
the second half of this document so the other side of the contract can check the
work rather than take it on faith.

## Files

| File | What it is |
|---|---|
| `migrations/d1/0015_financial_ledger.sql` | 13 tables, 34 indexes, all statements idempotent |
| `worker/src/lib/fin-d1.js` | the read path: 11 exported query functions plus one snapshot composer |
| `worker/test/fin-d1.test.mjs` | 132 checks against a real SQLite database, registered in the `npm test` chain |
| `operations/cloudflare-recovery-adapter.mjs` | the reviewed durable-table list, extended (see "What else had to change") |
| `test/package-privacy.test.mjs` | the npm publication allowlist, extended by the two shipped files |
| `package.json` | one entry appended to the test chain |

Nothing in `worker/src/index.js` is touched. The routes that will serve these
functions are named at the end of this document and are deliberately left for
whoever owns that file, since it is being edited in a sibling worktree this wave.

## The five properties the schema is built to guarantee

Each of these is enforced by a CHECK constraint, not by a convention, and each
has a test that deliberately breaks it and proves the database refuses.

1. **A tenant column on every table, from the first migration.** The recommended
   deployment is one brain per client and does not need it. Every read filters on
   it anyway. It is free now and it is a migration on a live financial ledger
   later, which is the whole argument. Today every row carries `primary`.
2. **Provenance on every fact.** Four origins, `owner_stated | extracted | feed |
   derived`, and two of them are constrained by the database: an `extracted` row
   cannot exist without the document it was read from, and a `feed` row cannot
   exist without naming the feed. The feed name doubles as the scope key, so one
   equality match removes everything a connector wrote — the same property
   `sources.name` already gives the corpus.
3. **An explicit unparsed state.** `basis_state = 'unparsed'` means the extractor
   could not read it, and the constraints make that state incompatible with
   carrying a figure. **You cannot store a number you could not read.** The
   inverse is also enforced: a row that is not unparsed must carry its amount, so
   "no figure" cannot be smuggled in as an ordinary row.
4. **Integer minor units, with the currency.** Every amount column ends in
   `_minor`, every ratio is basis points, and every table holding an amount names
   its currency. No float touches money anywhere in the schema or the read path,
   and the test asserts that over the serialized wire payload.
5. **Reconciliation as a state, not a winner.** `fin_reconciliations` plus
   `fin_reconciliation_claims`: the same account and period from two sources is
   two claim rows and one comparison, the comparison rests at `mismatched`, and
   an owner's ruling is recorded beside both figures rather than instead of
   either. `ruling_consumed` ships at `0` because recording a decision and acting
   on it are two different things.

Two further properties fell out of building it and are worth naming because they
are the ones a reviewer is most likely to want to argue with:

6. **Supersession, never update.** An owner-stated fact from the pre-install
   interview is useful and it is not evidence. When the document arrives it does
   not overwrite that row, it supersedes it. `superseded_by_id IS NULL` is the
   live predicate, enforced by a partial unique index on each table's stable key,
   so a correction keeps its why and the scope key is still unique among live
   rows.
7. **A cash position is a point in time.** This one was found by a failing test
   rather than by design, and it is the most important thing in the read path.
   See "What the tests caught" below.

## Screen-by-screen mapping

The left column is what the UI renders today. The right column is what serves it.
Where a row says **not built**, the reason is in the refusals section.

### Home

| UI element | Served by |
|---|---|
| Scope bar, per-business narrowing | `fin_entities.entity_slug`, `display_label`, `kind`, `fixed_scope`; every query takes an `entitySlug` filter |
| A scope that is a counterparty rather than one of yours | `fin_entities.relationship = 'counterparty'`, returned and flagged, never filtered away |
| "At a glance → This year": N of M accounts current, and the clause naming what is not | `fin_accounts` joined to `fin_account_coverage.coverage_status` — the six values are the ones the UI's own translation layer already consumes: `complete / indirect / partial / missing / not_applicable / closed` |
| "…never connected" as distinct from "…being read" | `fin_accounts.status = 'never_connected'` and `fin_account_coverage.covered_to IS NULL`; the read path returns both rather than a merged word |
| "At a glance → Documents": stored, being matched, needs a retake | `fin_documents.availability`, `filed_at`, `reconciled_through`, `readable` |
| "What the Brain cannot see", per source | `fin_account_coverage.basis_note` plus `coverage_status`, per account, derived rather than typed |
| "…the Brain cannot yet show a typed figure apart from one a document proves" | `provenance = 'owner_stated'` versus `'extracted'`, on every row, which is exactly that distinction made structural |
| The five actions, ranked by consequence | **composed, not stored** — from `fin_deadlines`, `fin_exceptions` and accounts whose coverage is `partial`/`missing` |
| Backlog counts ("6 other things, 3 waiting on other people") | derived from `fin_deadlines.owner_party` / `waiting_on` and `fin_exceptions.waiting_on` |
| "What changed" digest | **not built** (see refusals) |
| Critical banner, backup, "What the Brain checked" | not financial; already served by `/health` and `diagnose` |

### This year

| UI element | Served by |
|---|---|
| Hero: next hard deadline, with owner | `fin_deadlines` ordered by `urgency` then `due_date`; undated rows kept and sorted last |
| "Nothing is dated" empty state | `fin_deadlines.due_date IS NULL` is a legal state, not missing data |
| Coming up table: what, whose business, when, whose it is | `item`, `entity_slug`, `due_date`, `owner_party` |
| "Rests on: …" and "The Brain proposed this date; nobody has confirmed it" | `basis_note` and `basis_state ∈ confirmed / proposed`. A `confirmed` deadline is required by CHECK to say what it rests on, which is the requirement's own acceptance test made structural |
| "Waiting on: …" | `waiting_on`, storing either `Party: what is wanted` or a bare disposition, the convention the UI's own party parser already assumes |
| Needs a decision: the exception inbox | `fin_exceptions` — `issue`, `amount_minor`, `entity_slug`, `first_seen`, `waiting_on` |
| "The Brain's reading, a proposal and not a fact" | `fin_exceptions.proposal` + `proposal_confidence_bp`. A proposal recorded as confirmed is **refused by the database** |
| Resolving an exception never overwrites a source record | resolution is written to `resolved_at` / `resolution` / `resolved_by_party` on the exception. `fin_transactions` is not touched, and the exception table has no supersession chain because an exception is resolved, not replaced |
| Source-of-record conflict: two figures, both kept, both dated, owner rules | `fin_reconciliations` + `fin_reconciliation_claims`. Each claim carries `label`, `amount_minor`, and a NOT NULL `as_of` |
| "Answers use neither until you rule" | `state = 'mismatched'` with `ruled_claim_uid IS NULL`. The read path returns the state and both claims and never resolves it |
| "Your ruling is recorded… nothing uses it yet" | `ruled_claim_uid`, `ruled_at`, `ruled_by_party`, and `ruling_consumed = 0` |
| Close checklist: "July statements received from every connected account" | `fin_statements.parse_state = 'received'` for each account whose coverage says it is connected |
| The step that must NOT tick on arrival | `parse_state` (`received / parsing / parsed / unparsed`) is deliberately separate from reconciliation state. Received is not read; read is not matched |
| "July activity matched against the books" | `fin_reconciliations` for that account and period, `state = 'matched'` |
| "Transfers explained" / "Card spending sorted" | `fin_exceptions` of kind `unmatched_transfer`, and `fin_transactions.category IS NULL` |
| "You accept the close" | **not built** (see refusals) |
| For your tax professional: the question, its citations, and what is not included | `fin_open_items` — `question`, `routed_role`, `routed_name`, `status`, `citations`, `not_included` |
| "$4,180 total · 3 transfers · as of …" | `fin_exceptions.amount_minor` and the transactions it points at |
| Where your records stand fold: label, through date, note | `fin_accounts.label` + `fin_account_coverage.covered_to` + `basis_note` |
| Against your targets | **not built** (see refusals). The numerator and denominator it renders are served |

### Documents

| UI element | Served by |
|---|---|
| Title, whose it is, year | `fin_documents.title`, `entity_slug`, `tax_year` |
| Kind, from the interview taxonomy | `doc_kind`, a 33-value closed enum lifted from the two pre-install interviews (identity and structure, taxes, books, money movement, obligations, credit, rest of picture) |
| "Stored and findable. Nothing to do." | `custody_class = 'reference'` + `availability = 'have_it'` + `filed_at` |
| "Matched against the books through 30 June" | `custody_class = 'reconcilable'` + `reconciled_through` |
| "Too blurry to read. Take it again." | `readable = 0` + `unreadable_reason`. An unreadable document that does not say why is refused |
| "The new photo becomes the one in use, and this one is kept" | the supersession chain: `superseded_by_id` on the old row |
| "You uploaded it" / "Your accountant sent it" | `received_from` (a role or a channel, never a person's name in shipped fixtures), `received_at` |
| A document that is known to exist but is not in the brain | `availability = 'can_get_it'` with `available_from` and `available_within_days` — the interview's own three states: have it, can get it, do not have it |
| The record versus the file | `corpus_doc_uid` is nullable and the read path returns `in_corpus`, so a screen can say a document is recorded without implying it is searchable |
| The restricted flag | `restricted` is carried and **not enforced**; see the honest note in refusals |

### Add and review

| UI element | Served by |
|---|---|
| The account picker: entity, then account, with each account's state | `fin_accounts` grouped by `entity_slug`, with `coverage_status`, `covered_to` and `status` on every row so a never-connected account is marked rather than hidden |
| "Filed against Maple Street Cafe checking, and only that account, as your July 2026 statement" | `fin_statements (account_slug, period_start, period_end)` plus the `fin_documents` row |
| "Received. Matching against the books." | `parse_state = 'received'`, with the reconciliation for that period still `open` |
| The intake question ("Is this the cafe's checking account statement for July 2026?") | **composed, not stored.** Its inputs are `fin_accounts.mask`, the period, and the account label; the question object itself is a response shape |
| Held-back list / pre-upload quarantine | **not built, and must not be** (see refusals) |

### Explore (Ask)

| UI element | Served by |
|---|---|
| "One cash account has a confirmed figure: joint checking held $84,210 on 31 July" | `ledgerCashPosition` — deposit accounts only, each figure dated to its own source |
| "Your two cards are money you owe, not money you hold, and they are not in this figure and never will be" | `fin_accounts.balance_role`, NOT NULL, with a CHECK refusing a card or a loan as an asset. The excluded accounts are returned with the reason |
| "…the cafe's checking account is not included because its last confirmed figure is from 30 June" | the point-in-time rule (below): the account moves to `missing` with `last_confirmed_as_of` |
| "…the rental checking account has never been connected" | `missing` with `reason: never_connected` |
| Every answer's `sources`, `missing`, `conflicts` | `covered[].source_doc_uid` / `source_feed`; `missing[]`; `fin_reconciliations` in a non-matched state |
| "$8,940 of $26,300 July sales" | `fin_transactions` summed by direction and period, with the statement or feed behind each line |
| "$2,940 of card spending is not sorted yet" | `ledgerUnsortedSpending` — `category IS NULL`, excluding pending, tombstoned, superseded and unreadable lines, and returning the unreadable count separately |

### Access, Setting up, capability panel

Not financial. `fin_documents.restricted` is the only column that touches them and
it is a carried flag, not an enforcement.

## What the tests caught, that the design missed

**A cash total must not span two as-of dates.** The first version of
`ledgerCashPosition` took each deposit account's latest confirmed figure and
added them up. Against the synthetic ledger that produced a total mixing a 31
July balance with a 30 June one: a number true of no moment that ever existed,
carrying two real citations. The test that was written to assert the UI's own
sentence failed, and the fix is now a property of the function: a position has
one `as_of`, only figures dated to that day are summed, and an account whose most
recent confirmed figure is older moves to `missing` carrying **the date its
records reach and deliberately not its amount**, so there is no stale figure
sitting in the payload for a caller to add back in. A caller wanting a period-end
position passes that period's end.

This is the single most plausible way this read path could have shipped wrong,
and it would have looked sourced.

## What I rejected from the starting hypothesis, and what I added

The plan sketched `fin_accounts`, `fin_statements`, `fin_transactions`,
`fin_documents`. Nothing in that four was dropped, but the four cannot serve the
UI as it stands, and three of the additions come from finding that out:

- **`fin_accounts` alone cannot serve the source inventory.** Two of the six
  coverage values the UI's translation layer already consumes are declarations
  about what will never arrive (`indirect`: this account is covered through
  another's records; `not_applicable`: there is nothing to collect here). Neither
  is derivable by counting statements, so `fin_account_coverage` is a table.
- **`fin_documents` alone cannot express the product's finished states.** "Filed"
  has no upstream equivalent anywhere in the installer — a whole-word search
  returns nothing — and it decomposes into custody plus a judgement about whether
  reconciliation is owed. So the table carries the FACTS (`custody_class`,
  `availability`, `filed_at`, `reconciled_through`, `readable`) and no status
  word. That is the resolution of the standing objection to a
  `documents.status` column: the objection is to a connector writing the word,
  and it is correct. Nothing here writes a word.
- **`fin_statements` alone cannot express reconciliation.** Making it unique on
  (account, period) would resolve a two-source disagreement by accident of write
  order. It is deliberately not unique on that, and the comparison is its own
  pair of tables.
- **Added because the UI already reads them:** `fin_exceptions`, `fin_deadlines`,
  `fin_open_items`. All three are collections the UI's live adapter already maps
  field for field, and the four-table sketch had no home for any of them.
- **Added because the plan requires them:** `fin_entities` (per-entity is not
  optional; retrofitting it is a rewrite) and `fin_obligations` with
  `personal_guarantee` as a first-class column.
- **Added from the bank-feed brief:** `fin_balance_snapshots`, which has no
  statement equivalent for a fed account and is the second side of a
  reconciliation pair.

**The one I questioned hardest and kept:** `fin_obligations`. Its direct UI
evidence is thin — one insurance policy driving one deadline, and one exception
about a renewal quote — and it is the only table here built more on the plan than
on a rendered screen. It stays because the personal guarantee is the single
largest personal exposure most owners carry, it is buried inside loan and lease
documents rather than filed under its own name, and a column added after the
extraction pass has already run means re-reading every document.

## What the UI needs that I deliberately did not build

Each of these is a real thing on a real screen. None is an oversight.

1. **`fin_targets` (the "Against your targets" table).** A target is an owner-set
   goal, not a financial fact with an origin. Every row in this schema is
   required to carry provenance, and putting a preference in an evidence ledger
   would either force a fake provenance value or weaken the rule for every other
   row. The numerator and denominator the table renders (`$8,940 of $26,300`) ARE
   served, from transactions and statements, along with the basis sentence that
   says the sales figure is provisional. **What would close it:** a small
   preferences table outside the `fin_*` namespace, owned by whoever owns
   settings.
2. **A period-close record ("You accept the close").** Every step of the close
   checklist except the last is expressible today: statements received
   (`parse_state`), activity matched (`fin_reconciliations`), transfers explained
   and spending sorted (`fin_exceptions`, `category`). The last step is an owner
   acceptance, which is a WRITE, and this wave has no write path. Building a
   table with no writer would put an empty surface behind a checklist that
   promises proof. **What would close it:** `fin_period_closes (entity, period,
   accepted_at, accepted_by_party)` landing with the write path that populates it.
3. **The activity digest ("What changed").** It is a record of session mutations,
   and there are no session mutations in a read-only ledger. It also belongs to
   the whole product, not the financial slice.
4. **The held-back list / pre-upload quarantine.** This one is not a deferral,
   it is a refusal: those files are held on the client's own computer and have
   not been uploaded. Recording them in the client's D1 would move them, which
   is precisely the promise the feature exists to keep.
5. **Enforcement of `fin_documents.restricted`.** The column is carried so a
   screen can say a restriction exists. It is **not** an access control, because
   the brain ships one access tier and anyone holding the key sees everything.
   Rendering this flag as a boundary would be worse than not having it.
6. **The freshness axis ("read 3 days ago, expected about every day").** That is
   coverage recency and it already exists, computed over `sources` and
   `sync_runs` in the corpus. `fin_accounts.expected_cadence` records the
   expectation for an account; the lag itself is not re-derived here, and NULL
   remains a legal value meaning no staleness claim is made either way.
7. **The narrative response shapes** — the intake question object, the close
   checklist object, and Ask answer objects. These were already identified as
   server-owned response shapes rather than adapter-mapped collections. They are
   compositions over these tables and they belong beside the routes.
8. **Routes.** No route is wired, because `worker/src/index.js` is being edited
   in a sibling worktree this wave. The functions are shaped for one snapshot
   route plus per-collection reads; the natural names are
   `GET /api/admin/brain/ledger/snapshot`, `.../accounts`, `.../documents`,
   `.../deadlines`, `.../exceptions`, `.../reconciliations`, `.../cash`. Whoever
   wires them should note that `ledgerSnapshot` already returns
   `ledger_installed` and an aggregated `unavailable`, so the route needs no
   error vocabulary of its own.

## What else had to change, and why

`operations/cloudflare-recovery-adapter.mjs` pins a reviewed list of durable D1
tables and says in its own comment that a future migration adding a table must
update it or the adapter stops before exporting anything. It did exactly that:
the recovery drill failed closed the first time the full chain ran, which is the
contract working. All 13 ledger tables are now in `RECOVERY_DURABLE_TABLES` and
therefore in `RECOVERY_EXPORT_TABLES`, gated behind a `SCHEMA_15_TABLES` list so
older migration prefixes still validate, and the pinned schema version moved 14
to 15. A recovered brain that came back with its documents and without its ledger
would answer a question about money from prose alone, silently.

`test/package-privacy.test.mjs` gained the two shipped files in its reviewed
publication allowlist. That list is an allowlist by design and adding to it is
the intended way to ship a new file.

## Verification

Full chain, exit code read from its own file rather than from a pipeline:

```
$ npm test > /tmp/wp14-fullchain.log 2>&1; echo $? > /tmp/wp14-fullchain-exit.txt
$ cat /tmp/wp14-fullchain-exit.txt
0
$ grep -cE "^FAIL |FAILURES|^not ok|AssertionError" /tmp/wp14-fullchain.log
0
$ grep -c "^PASS" /tmp/wp14-fullchain.log
2667
```

The suites that matter most to this change, from that same run:

```
migrations: all 76 checks passed
fin-d1: all 132 tests passed
PASS  published package contains 341 reviewed files and no client-private paths
PASS  Cloudflare recovery adapter is disposable-only, credential-safe, redirect-safe, and resumable
```

A sample of the constraint tests, each of which drives a real SQLite database and
proves the schema refuses rather than that a mock was configured to:

```
PASS  an extracted row with no source document is refused
PASS  a feed row with no named feed is refused
PASS  a card recorded as an asset is refused
PASS  a loan recorded as an asset is refused
PASS  a full account number in the mask column is refused
PASS  an unparsed transaction carrying an amount is refused
PASS  an unparsed transaction with no amount is accepted
PASS  a readable transaction with no amount is refused
PASS  an unparsed statement carrying balances is refused
PASS  coverage claimed complete with no through date is refused
PASS  a personal guarantee asserted without the document it was found in is refused
PASS  a deadline confirmed without saying what confirms it is refused
PASS  a proposal recorded as a confirmed fact is refused
PASS  a reconciliation cannot be marked matched while the figures differ
PASS  a competing claim with no as-of date is refused
```

And the read-path properties that exist to stop a confident wrong number:

```
PASS  the position states the one day every summed figure is true of
PASS  an account whose confirmed figure is a month older is not summed in at its stale value
PASS  the excluded account's stale amount is not in the payload at all
PASS  two currencies produce no total rather than a meaningless one
PASS  a proposed figure is never summed into a cash total
PASS  the lines it could not read are counted separately, not dropped
PASS  obligations nobody has examined are counted apart from those checked and clear
PASS  an unreachable database returns unavailable, not a total of zero
PASS  no client-facing outcome word appears anywhere on the wire
PASS  all 15 amounts on the wire are integers in minor units
PASS  0015 resumes after every one of its 47 independently committed statements
```

Restart safety is proved the way the migration engine's own suite proves it: the
file is applied to a fault point, then re-applied from the beginning, once for
every statement in it. Every statement is a `CREATE ... IF NOT EXISTS`; there is
no `ALTER` and there are no triggers, whose bodies are the one shape the
statement splitter has historically shredded.

## Owner-voice note

The thing to know about this change is that it is the first place in the product
where a number can be wrong. Everything before it retrieved text, and text that
is missing looks missing. A figure that is missing looks like a smaller figure.
So the schema is built to refuse rather than to round: it cannot store an amount
it could not read, it cannot record the brain's reading of a pattern as a fact,
it cannot count a credit card as money you hold, and it cannot add a July balance
to a June one and call the result what you have. Where two of your sources
disagree, it keeps both, dates both, and says so, and your ruling about which one
you trust is written down next to them rather than on top of either. None of that
is visible when it works. It is the reason a figure this thing shows you is worth
the same as reading the statement yourself.

What it does not do yet: no routes are wired, nothing writes to these tables, and
the extraction pass that will fill them is the next package. Today a brain that
runs `brain migrate` gets the ledger and gets it empty, and the read path says
`ledger_installed: true` with nothing in it, which is a different sentence from a
quiet month and is deliberately distinguishable from one.
