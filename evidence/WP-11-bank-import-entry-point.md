# The bank export gets a way in, and the OFX sign convention gets checked

Branch `feat/bank-file-production-path`, worktree `/private/tmp/brain-bank-path`,
off `wave0/connector-gaps`.

WP-10 built a bank-export reader with 79 tests and a ledger writer with 132, and
shipped nothing that joined them. This closes that, and closes the one place in
the reader where a figure was believed rather than checked.

## What was actually wrong

Independent verification established both, and both held up under a read of the
code:

1. **The `.ofx` / `.qfx` hook in `ingest/extract.mjs` returned `{ text, note }`
   and discarded every structured figure.** A client dropping a bank export into
   their folder got a paragraph of prose in their document corpus and not one
   row in `fin_transactions`. The parse succeeded; the figures went nowhere.
2. **`.csv` was not registered as a bank export at all**, and `parseBankCsv` had
   no caller outside its own test file.
3. **There was no upload route and no CLI command.** The only route WP-10 added
   to `worker/src/index.js` was the hosted feed's.
4. **OFX and QFX direction was trusted from the format spec and never checked.**
   The CSV balance-verified shape proved its reading against every balance step;
   the OFX path took the specification's word for it. A card export that inverts
   its amounts — rare, but real — would have landed every purchase as money
   arriving, with a citation under every figure and nothing looking wrong.

## Part A — the entry point

```
brain import bank <manifest> --file <statement.ofx|.qfx|.csv> [--dry-run]
```

**Why a command of its own rather than a file extension.** `.ofx` and `.qfx`
stay registered as document formats, because reading a statement as prose is a
legitimate thing for a corpus to do; it is simply not an import. `.csv` is
deliberately **not** registered as a bank export and must not be — most CSVs are
not bank exports, and a registry that guessed would start pulling price lists
into a financial ledger. The operator declares it by naming this command, and
every other `.csv` in the folder keeps the ordinary spreadsheet path untouched
(asserted).

**Why it parses on the operator's machine and writes through the brain.** The
reader is a zero-dependency Node module pinned by its own 79 tests, and — more
to the point — it is where the refusals are written *for the person holding the
file*. Shipping a copy of it into the worker would put the sign conventions in
two places, which is exactly what the one-boundary design exists to prevent. So
the CLI reads the file and POSTs a normalised envelope to one new operator-only
route, `POST /api/admin/fin/import-bank-export`, which hands it to
`importBankExport` — the same and only ledger writer the hosted feed uses. No
second writer was added. The full account number never leaves the machine; the
reader has already thrown it away.

**The route does not take the envelope on trust.** An envelope arriving over
HTTP is a claim, not a reading, so everything checkable from the envelope alone
is rechecked in `worker/src/lib/fin-upload.js`: the named sign convention has to
be one this codebase defines, `amount_minor` has to be the magnitude of the
signed source figure, direction has to agree with that sign under every
convention where the sign carries direction, a row with no figure has to carry a
reason, and `balance_role` is **recomputed** from the account kind rather than
believed, so a card cannot be imported as money held. What cannot be rechecked
without the file is not pretended to be.

**The refusal path.** A file whose direction of money cannot be established is
declined by name before anything is sent, and the CLI exits 1:

```
$ node brain.mjs import bank <manifest> --file test/fixtures/bank/ambiguous-amount.csv
fail  this file was not imported, because the "Value" column is the only amount in this file and
      nothing in the file says which sign means money leaving the account. There is no debit/credit
      column pair, no transaction-type column, and no running balance to check a reading against.
      Re-export including a running balance, a transaction type, or separate debit and credit
      columns, or supply the file as OFX/QFX

      Nothing was sent and nothing in the ledger changed.
exit: 1
```

**The dry run.** Real output, real fixture, no network and no admin key
required — the safest command must not be the hardest to reach:

```
$ node brain.mjs import bank <manifest> --file test/fixtures/bank/checking-july.ofx --dry-run
·     read checking-july.ofx: OFX bank export
·     sign convention: ofx_trnamt_negative_is_outflow
      bank-a3ae5f54abb08f45  (checking, ending 4821, USD)
        period 2026-07-01 to 2026-07-31
        4 line(s) would land: 2 in 5,450.00 USD, 2 out 1,917.90 USD
        1 line(s) could not be read and would land as unread, each with its reason
        statement balance 8,421.10 USD as of 2026-07-31
        direction: taken ON TRUST from the OFX specification, not verified
                   this statement carries no opening balance to check its transactions against, so
                   the direction of every amount is taken on trust from the OFX specification
                   rather than verified

ok    dry run, nothing was sent
```

**Re-importing does not duplicate, and nothing new was invented to make that
true.** `fin-import.js` already derives every identifier from content: an OFX
`FITID` scoped to the account where the source gives one, and otherwise a digest
of the row's own content plus its ordinal among identical rows in the same file.
The account key is a digest of institution plus account number; for a CSV, which
names no account, it falls back to a digest of the file's own content, and
`sourceDocUid` defaults to the same content digest rather than a path. So the
same file twice produces the same identifiers, every insert is an
`ON CONFLICT ... DO UPDATE`, and the second import updates rows in place. The CLI
says so out loud, because an operator who is afraid to re-run a safe command
will find a worse way to do it.

One thing deliberately **not** done: the envelope is never split across multiple
requests. Ordinals that disambiguate identical rows are assigned per call, so
chunking would let two genuinely identical transactions in different chunks
collide on ordinal 0 and silently become one row. A file past
`MAX_TRANSACTIONS_PER_IMPORT` (20,000) is refused with a message telling the
operator to export a narrower range, which re-importing an overlap makes safe.

**One more honesty fix in passing.** The `.ofx` / `.qfx` document hook now
returns a note saying the figures are *not* in the ledger and naming the command
that loads them. Prose was all that path ever produced; the difference between
an operator who knows that and one who assumes otherwise was one sentence.

## Part B — the OFX direction, checked instead of trusted

OFX gives one closing balance and no required opening balance, so the check is
conditional by construction. What OFX does have is `<BALLIST>`, an optional list
of named balances, and where a statement states the balance the period **started**
at, `verifyOfxDirection()` now requires that opening plus the period's activity
equals the closing balance under the convention as written, and does **not**
equal it with every sign flipped.

**Only the file's own opening balance is accepted as an anchor.** It came off the
same statement as the transactions and the closing balance, so a disagreement
between the three is about the figures and nothing else. A prior month's imported
balance, or a figure the operator typed, can disagree for reasons that have
nothing to do with a sign convention — a gap between statements, a pending item,
a correction — and a check that refuses good files for the wrong reason teaches
the operator to switch it off.

Four outcomes, and `unverifiable` is a first-class answer rather than a quiet
success:

| Outcome | What happens |
|---|---|
| As written closes the statement, flipped does not | `verified`. Said in the receipt and in the ledger. |
| Flipped closes it, as written does not | **Refused**, with both totals. |
| Neither closes it | **Refused**: transactions are missing, or a balance belongs to another period. |
| No opening balance, or any unread line, or the activity nets to zero | `trusted`. The receipt and the ledger both say the direction was taken on trust and not verified. |

**Why an inverted file is refused rather than adopted.** When only the flipped
reading closes the statement there are at least two explanations and the file
does not say which: the bank inverted its amounts, or one of the two balances is
wrong (a prior period's closing written into the opening slot is the common one).
Adopting the flipped reading picks the flattering explanation on the strength of
a single arithmetic identity, then writes a month of inverted figures into a
ledger that will be summed by code, and read by people, who never see the receipt
that shouted about it. Refusing costs one re-export. Adopting costs a P&L that is
exactly backwards with a real citation under every number. The reasoning is in
the code, above `directionRefusal()`, not only here.

```
$ node brain.mjs import bank <manifest> --file test/fixtures/bank/inverted-signs.ofx
fail  this file was not imported, because the amounts for the account ending 6612 are signed the
      OPPOSITE way round to the OFX specification. Read as the format defines them, 4,889.00 USD
      opening plus -3,532.10 USD of activity comes to 1,356.90 USD, and the statement says it
      closed at 8,421.10 USD; flip every sign and it closes exactly. Either the export inverted its
      amounts or one of its two balances is wrong, the file does not say which, so nothing was read
      from it. Re-download this statement from the bank, and if it comes out the same way, export it
      as CSV including a running balance column, which is checked row by row.

      Nothing was sent and nothing in the ledger changed.
exit: 1
```

**An unverified reading must not look like a verified one.** The direction basis
travels with the account into three places, not one: the CLI receipt, the corpus
text the file produces, and `fin_account_coverage.basis_note` — the column the
schema already reserves for a plain sentence to the client. A terminal receipt is
read once by one person; the ledger sentence is read by whoever asks the brain
about that account months later, which is the audience that matters. Verbatim
from the test database after importing a statement with no opening balance:

```
Read from a bank export covering 2026-07-01 to 2026-07-31. 1 line(s) in it could not be read and
are recorded as unread. The direction of every amount was taken on trust from the format's own
specification and was NOT verified against a balance.
```

CSV keeps its own three bases and none of them is `trusted`: the balance-verified
shape is `verified`, and the paired-column and type-column shapes are `stated`,
because the file names each row's direction outright. Flattening those into one
word would erase a distinction the receipt has to be able to draw.

## Files

| File | What changed |
|---|---|
| `brain.mjs` | `brain import bank`: `cmdImport` dispatch, `cmdImportBank`, help text, eight new value flags |
| `worker/src/lib/fin-upload.js` | **new** — the route, and the envelope validator that refuses to take a claim as a reading |
| `worker/src/index.js` | two lines to mount it inside the admin-key gate, plus the path added to the paused-upgrade refusal set |
| `ingest/bank-export.mjs` | `<BALLIST>` opening balance, `verifyOfxDirection()`, the refusal text, `directionBasis` on every account, and the basis said in the corpus text |
| `worker/src/lib/fin-import.js` | one sentence in the coverage note saying what the direction rests on |
| `ingest/extract.mjs` | the `.ofx` / `.qfx` note now says the figures are not in the ledger and names the command that loads them |
| `test/bank-import-path.test.mjs` | **new**, 48 checks, registered in `npm test` |
| `test/fixtures/bank/reconciled-july.ofx`, `inverted-signs.ofx` | **new**, invented |
| `test/package-privacy.test.mjs` | the new worker module added to the reviewed publish allowlist (351 → 352 files) |
| `worker/test/health-honesty.test.mjs` | comment only: seven paused paths became eight, and a real client's first name was removed from a public repo |

**No migration was added and no ledger column was touched.** Everything this
change records fits the thirteen tables as written, including the direction
basis, which goes in the plain-sentence column the schema already had.

## Tests

The decisive test is end to end, because the previous wave proved that passing
parser tests say nothing about whether anything reaches the ledger. Almost
nothing in `test/bank-import-path.test.mjs` is a unit test: a real fixture file
on disk, through the real CLI command an operator types, over the real worker
entry point **dispatched by the real router in `worker/src/index.js`** so a
handler that exists but is not mounted fails, into a real SQLite database built
from the real migration files, asserted by reading rows back out of it.

```
bank-import-path: 48/48 checks passed
```

Including, by name:

```
PASS  THE ENTRY POINT EXISTS AND RUNS: a downloaded OFX file imports without error
PASS  EVERY LINE IN THE FILE LANDED IN THE LEDGER, including the one that could not be read
PASS  A NEGATIVE OFX AMOUNT LANDED AS MONEY LEAVING, with the source figure and convention beside it
PASS  THE FULL ACCOUNT NUMBER IS NOWHERE IN THE DATABASE
PASS  A SECOND IMPORT OF THE SAME FILE DOES NOT DOUBLE THE LEDGER
PASS  AN OFX WHOSE SIGNS ARE INVERTED RELATIVE TO ITS OWN BALANCE IS REFUSED, NOT BELIEVED
PASS  A CSV WITH ONE UNSIGNED AMOUNT COLUMN IS REFUSED BY NAME, not guessed
PASS  A DRY RUN SENDS NOTHING AT ALL
PASS  THE ORDINARY .CSV DOCUMENT PATH IS UNTOUCHED: the same file still extracts as a table, not a bank export
PASS  THE IMPORT ROUTE IS BEHIND THE ADMIN KEY, like every other write
PASS  AN ENVELOPE WHOSE DIRECTION CONTRADICTS ITS OWN SOURCE FIGURE IS REFUSED BY THE BRAIN
PASS  MONEY OWED CANNOT BE IMPORTED AS MONEY HELD, whatever the envelope claims
PASS  AND THE LEDGER SAYS SO TOO, so the reader months later is not misled
```

## Discrimination: broken, confirmed failing, restored

**The entry point, broken the way it was broken before this change** — the route
still validates and still answers, but drops the parsed transactions on the way
to `importBankExport`:

```js
const DISCRIMINATION_BREAK = { ...checked.envelope,
  accounts: checked.envelope.accounts.map((a) => ({ ...a, transactions: [] })) };
```

```
FAIL  EVERY LINE IN THE FILE LANDED IN THE LEDGER, including the one that could not be read  0 rows: []
FAIL  the four readable lines landed as confirmed figures  []
FAIL  A NEGATIVE OFX AMOUNT LANDED AS MONEY LEAVING, with the source figure and convention beside it
FAIL  a positive OFX amount landed as money arriving
FAIL  the unreadable line landed as UNREAD carrying no figure and a stated reason
FAIL  the receipt counts what actually landed  {"imported":true,...,"transactions":0,"unread_lines":0,...}
FAIL  A SECOND IMPORT OF THE SAME FILE DOES NOT DOUBLE THE LEDGER  0 then 0:
FAIL  its four transactions land with the right total
FAIL  the unread line is still counted in the same note rather than replaced by it
FAIL  a figure in the debit column landed as money leaving
FAILURES: 38/48 checks passed
EXIT: 1
```

Worth reading the sixth line twice: the receipt still said `"imported": true`.
That is precisely the shape of the original failure — a success message over an
empty ledger — and it is what an end-to-end test catches and a parser test
cannot.

**The balance cross-check, removed** so an inverted OFX is trusted again:

```
FAIL  AN OFX WHOSE SIGNS ARE INVERTED RELATIVE TO ITS OWN BALANCE IS REFUSED, NOT BELIEVED
FAIL  the refusal shows the arithmetic that did not close, in figures the owner can check
FAIL  it says what to do about it instead of stopping at a diagnosis
FAIL  nothing was sent and the ledger is untouched  [{"url":"https://fixture.invalid/api/admin/fin/import-bank-export","method":"POST"}]
FAILURES: 44/48 checks passed
```

Both breaks reverted; `bank-import-path: 48/48 checks passed`.

## Verification

Full chain, exit code read from its own file:

```
$ npm test > /tmp/bankpath.log 2>&1; echo $? > /tmp/bankpath-exit.txt
$ cat /tmp/bankpath-exit.txt
0
$ grep -cE "^FAIL |FAILURES|^not ok|AssertionError" /tmp/bankpath.log
0
```

The suites this change could most plausibly have broken, from that run:

```
bank-export: 79/79 checks passed
bank-import-path: 48/48 checks passed
bank-feed: 90/90 checks passed
fin-d1: all 132 tests passed
routes: all 216 tests passed
migrations: all 76 checks passed
formats-extra: all 63 tests passed
PASS  published package contains 352 reviewed files and no client-private paths
```

## What is NOT proved here

- **No real bank file from a real institution was imported.** Every fixture is
  invented. The OFX/QFX tokenizer and the CSV shape detection meet real-world
  variety for the first time in the field, not here.
- **The balance cross-check only fires on statements that carry an opening
  balance**, and `<BALLIST>` is optional. Most exports will land as `trusted` —
  correctly labelled, and unverified all the same. The honest reading of this
  change is that the check catches an inverted export *when the file gives it
  something to catch it with*, and says so plainly when it does not.
- **Verifying a statement against the previous month's imported closing balance
  is not built**, deliberately. It is the obvious next anchor and the reason it
  is not here is above: it can disagree for reasons that are not sign errors, and
  a false refusal on financial data is expensive in a different way.
- **The hosted feed's direction is still unverified and, unlike the file path,
  does not say so.** A feed import writes no coverage row at all (it has no
  statement period), so there is nowhere the sentence would currently land. That
  is a real gap, it is one function away, and it belongs with whatever change
  gives feed imports a coverage record.
- **Nothing reconciles the ledger against the account balance after import.**
  `fin_reconciliations` is still empty and still waiting, as WP-10 noted.
- **The ledger has a write path and still no production read path.**
  `worker/src/lib/fin-d1.js` gained its first production consumer in this change,
  and it is only the "is the ledger installed" probe. Nothing in the brain's
  answers reads these figures yet. Landing rows nobody can ask about is progress,
  not completion.

## Owner-voice note

Your bank will hand you a file of your own transactions any day you ask. Until
this change, dropping that file into your brain got you a paragraph of text that
mentioned some numbers, and nothing you could add up. The figures were read
correctly and then thrown away, which is the kind of failure that looks like
success from every angle: the file loaded, nothing errored, and the ledger stayed
empty. Now there is one command that loads it properly, one place those figures
can be written, and a preview that shows you exactly what would land — down to
the lines it could not read — before anything is sent.

The second half is about a quieter thing. A bank file says whether money came in
or went out by putting a minus sign in front of the number, and the format's rule
book says a minus means money leaving. We were taking that on faith. If a bank
ever got it backwards, your spending would have been recorded as income and your
income as spending, every figure would have had a real document sitting behind
it, and nothing anywhere would have looked wrong. So now, when your statement
tells us what the account started at, we add up the month and check that it
arrives at what the statement says it ended at. If it only works with every sign
flipped, we do not quietly flip them and mention it in passing — we refuse the
file and tell you what did not add up, because a number that is confidently
backwards is worse than no number at all. And when the statement gives us nothing
to check against, which is common, we say that too, in the receipt and in your
own records: this was taken on trust, not verified. You should be able to tell
those two apart without asking.
