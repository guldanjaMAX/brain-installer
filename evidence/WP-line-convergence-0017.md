# The two lines are one, and 17 stayed where the field had already put it

Branch `integrate/line-convergence`, worktree branched from
`wave0/connector-gaps` at `2760f49`. Merged commit: `cb62fa1` on
`codex/cloudflare-brain-phase2`.

## What was merged, exactly

The task named `04a886a` as the other line's head. It was not, by the time this
ran: that branch had eleven commits past it and was still moving — `978579c`
landed twenty-five seconds after I read the tip. I merged **`cb62fa1`**, which
contains `04a886a` and ten commits after it, and pinned there rather than chase
a branch that a sibling was writing to. `978579c` ("Settings becomes a page that
answers who can reach this brain") and anything after it are **not** in this
merge. That is a boundary, not an omission, and the next merge from that branch
picks them up normally.

## The collision

Three branches each shipped a `0017`. Only one of them was ever applied to a
real brain, and that decides the argument: the owner's install records version
17 with the checksum of `0017_mcp_connector_oauth.sql`. `cmdMigrate` refuses to
run when a version it has already applied carries a checksum different from the
file now sitting at that number:

```
migration 0017_chunk_token_fit was already applied but its content has changed.
      applied checksum ccdcf3134e1d590b, file checksum 79c33a1d98dfdcf5
      Never edit an applied migration. Add a new one instead.
```

That refusal is correct and is the outage. A number is cheap to move in a repo
and expensive to move in a deployed database, so the repo moved.

**`0017_chunk_token_fit` became `0021_chunk_token_fit`.** 21 was established by
asking every branch, not one:

```
$ git log --all --diff-filter=A --name-only --format="" -- "migrations/d1/*.sql" | sort -u
migrations/d1/0015_financial_ledger.sql
migrations/d1/0015_mcp_connector_oauth.sql
migrations/d1/0016_bank_feed.sql
migrations/d1/0017_chunk_token_fit.sql
migrations/d1/0017_extraction_provenance.sql
migrations/d1/0017_mcp_connector_oauth.sql
migrations/d1/0019_recovery_codes.sql
migrations/d1/0020_zoom_delivery_ledger.sql
```

Every number 1 through 20 has been claimed by some branch at some point,
including 18 (`0018_extraction_provenance`, itself already renamed off 17) and
including the connector-OAuth migration's own earlier life at 15. 21 is the
first number no branch has ever used. The merged set is 1..21, contiguous, one
file per number, which `validateMigrationContract` requires (`version ===
index + 1`).

## The recovery adapter, which is why the last attempt was reverted

The number is load-bearing in `operations/cloudflare-recovery-adapter.mjs`. Every
site:

| Site | Was | Now |
|---|---|---|
| `RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION` | `20` (ours) / `17` (theirs) | `21` |
| `expectedInstallStateColumns`, refit gate | `latest >= 17` | `latest >= 21` |
| `SCHEMA_17_TABLES` | theirs only | declared, beside 15/16 |
| `SCHEMA_19_TABLES`, `SCHEMA_20_TABLES` | ours only | kept |
| `AGGREGATE_FIELDS` literal-zero set | 15+16+19+20 / 15+16+17 | 15+16+17+19+20 |
| `expectedRecoveryTables` gates | 19, 20 / 17 | 17, 19 and 20 |
| `RECOVERY_DURABLE_TABLES` | oauth OR recovery+zoom | all three groups |
| `RECOVERY_EXPORT_TABLES` exclusions | ours OR theirs | both |

The refit gate is the one that matters and the one that was missed before. It is
**not** a conflicted hunk — git merged that region cleanly and left `latest >= 17`
pointing at a file that had moved to 21. Nothing in the suite objected, because
the recovery drill runs at the newest schema where `latest >= 17` and
`latest >= 21` are both true and therefore indistinguishable. They differ only
for a database sitting between the two numbers, which is every install that
upgrades in stages. I proved the drill was blind to it by reverting the gate to
17 and watching `test/cloudflare-recovery-adapter.test.mjs` pass anyway, then
added the check that sees it.

## Proof, on the case that actually broke

`test/migration-field-collision.test.mjs` builds a brain that is genuinely at 17
— migrations 1..17 executed for real against SQLite — and receipts version 17
with the checksum of the connector-OAuth file **located by name, never by the
slot it occupies**. That distinction is the test. My first version receipted
"whatever file is at 17", which made it agree with any arrangement it was
handed; the discrimination run caught it passing under the restored collision,
and it was rewritten. A test that agrees with the bug is worse than no test.

```
PASS  no two migration files share a number
PASS  migration numbers are contiguous from 1
PASS  both colliding migrations are present after the merge
PASS  version 17 is the connector-OAuth migration the field already applied
PASS  chunk token-fit moved off 17 to a number no branch had claimed
PASS  the moved migration's header matches its new number
PASS  the fixture really is an install sitting at 17
PASS  an install already holding 17 with the connector-OAuth checksum migrates forward
PASS  and it lands on every remaining migration, 18 through 21
PASS  the SQL of the forward migrations actually ran (18 columns, 21 columns, 17 tables intact)
PASS  an install whose 17 was a DIFFERENT file is refused, not silently diverged
PASS  and the refusal happens before anything is applied
PASS  a database at schema 20 exports without expecting the refit columns
PASS  and once it is at 21 the refit columns are required again
PASS  the adapter's pinned schema version is the newest migration

migration field collision: all 15 checks passed
```

## The tests discriminate

Each thing built was broken, and the matching check failed:

**Renumber reverted** (token-fit back onto 17), verbatim:

```
FAIL  an install already holding 17 with the connector-OAuth checksum migrates forward  migration 0017_chunk_token_fit was already applied but its content has changed.
      applied checksum ccdcf3134e1d590b, file checksum 79c33a1d98dfdcf5
      Never edit an applied migration. Add a new one instead.
8 FAILURES
```

**Refit gate reverted** to `latest >= 17`, verbatim:

```
FAIL  a database at schema 20 exports without expecting the refit columns  RECOVERY_INSTALL_STATE_INVALID
1 FAILURES
```

**Escape-hatch route removed**, verbatim:

```
✖ the page carries the escape hatch and the honest limits, and its script parses
    actual: 401,
    expected: 200,
```

All three restored; the suite is green after restoration.

## The conflict I could not keep both halves of

`worker/src/lib/app-page.js` genuinely conflicts. One line extended the inline
owner page with the recovery-code ceremony; the other replaced that page
entirely with a React shell. Both cannot be the body of `/app`, and the shell
side is forced anyway: `owner-auth.js` and `oauth.js` now import `brandOgSvg`
and `FAVICON`, which only the React version exports.

Taking the shell alone would have deleted the only way back into a brain whose
devices are all gone. Recovery codes are this line's feature; the other line
replaced the page without knowing the feature existed, and its React `Gate.tsx`
has `enroll` and `signIn` and nothing else. The suite caught it — that is what
`recovery-codes.test.mjs` failing on `/Lost the device you sign in with\?/` was.

So `/app` is the React app, and the previous page is served **verbatim** at
`/app/recover` from `worker/src/lib/recovery-page.js`. Not a byte of the
ceremony was rewritten, which is why the recovery assertions could move route
without being weakened. Its CSP is the one that page was reviewed under
(`script-src 'unsafe-inline'` — it is one inline script), deliberately not the
stricter `/app` policy, which assumes an external bundle this page does not
have. It exposes nothing new: the same bytes were already served unauthenticated
at `/app` before the merge.

**Stated plainly, because it is a real limitation:** the React sign-in screen
does not link to `/app/recover`, so a locked-out owner reaches it by URL. Fixing
that properly means folding the ceremony into React and regenerating
`app-assets.js`, a 214KB build artifact — that is a frontend change, not a merge
resolution, and I did not fake it. The capability exists and is proven; its
discoverability is owed.

## Two defects inherited from the incoming line

Neither is a merge casualty. Both were already true on `cb62fa1` and this merge
is only where they became visible.

- `worker/src/lib/connections.js` was added without an entry in the package
  privacy allowlist, so `test/package-privacy.test.mjs` fails on that branch:
  `unreviewed package files would ship: worker/src/lib/connections.js`. Added.
- `worker/test/connections.test.mjs`, 19 checks, was never registered in
  `scripts.test`. It had never run. Registered; it passes.

Both came from `cb62fa1`, the same commit that added the files.

## package.json

The test chain was merged rather than chosen: ours carried 16 files theirs did
not, theirs carried 2 ours did not (`connector.test.mjs`, `app-page.test.mjs`),
and all 18 are in the chain now, plus the two this branch adds. The `files`
array was taken from ours, which is a strict superset of theirs — 45 entries
against 42, the extra three being `docs/release-gates.json`,
`docs/decisions/003-upgrade-rollback-scope.md` and `legal/`. Those are precisely
the entries a resolver dropped silently once before, so they were compared by
set difference rather than by eye.

## Everything the other line brings, and where it is proven

| Feature | Lands in | Proven by |
|---|---|---|
| Remote connector OAuth (RFC 7591, PKCE) | `worker/src/lib/oauth.js`, `migrations/d1/0017` | `worker/test/connector.test.mjs` |
| MCP endpoint: ask, search, fetch, remember, forget | `worker/src/lib/mcp-endpoint.js` | `worker/test/connector.test.mjs` |
| Write access with a correction contract | `worker/src/lib/remember-contract.js` | `worker/test/connector.test.mjs` |
| Connected-apps list and revoke | `worker/src/lib/connections.js`, `owner-auth.js` | `worker/test/connections.test.mjs` (newly registered) |
| React + Tailwind owner app | `frontend/`, `app-assets.js`, `app-page.js` | `worker/test/app-page.test.mjs` |
| Invite link preview: OG cards, favicon, brand SVG | `app-page.js` `brandOgSvg`, `FAVICON` | `worker/test/app-page.test.mjs` |
| Degraded search is never reported as absence | `retrieval-status.js`, `mcp-endpoint.js` | `worker/test/degraded-absence.test.mjs` |
| Stalled drain distinguished from merely behind | `brain.mjs` | `test/diagnose.test.mjs` |
| Streaming batcher gets the D1 statement ceiling | `ingest/run.mjs` | `test/ingest-run.test.mjs` |
| Pre-install interview | `onboarding/00-pre-install-interview.md` | `test/package-privacy.test.mjs` |

`components/brain-mcp.mjs` needed no resolution: the other line never touched it.
The local MCP server's eight tools and the connector endpoint's five are separate
surfaces and both are intact.

## Full suite

```
$ npm test > /tmp/converge-final.log 2>&1; echo $? > /tmp/converge-final-exit.txt
$ cat /tmp/converge-final-exit.txt
0
```

4,180 passing assertions.
