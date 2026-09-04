# Port stage 2: the shared files

Stage 1 (commit b62c26b) put the field line's 118 backend files, their tests
and migrations 0023 to 0032 onto the 0.3.6 tip, wired every ported test into
the chain, and privacy-reviewed and allowlisted every file. It deliberately
merged none of the SHARED files, so the new subsystems are present and not yet
reachable.

**The worklist is not a guess. It is the 23 ported tests that fail**, and each
one names what it cannot find. Run it any time:

```bash
for t in $(git diff --name-only e782830 HEAD | grep -E "test/.*\.test\.mjs$"); do
  node --no-warnings "$t" >/dev/null 2>&1 || echo "FAIL $t"
done
```

## What the 23 failures actually ask for

Six missing exports across five shared files. That is the whole reachability
gap; everything else already imports cleanly.

| File | Exports the ported tests need |
|---|---|
| `brain.mjs` | `cmdConnectBank`, `cmdReconcileQuickBooks`, `cmdReconcileTaxQuickBooks` |
| `worker/src/lib/store-d1.js` | `vectorRetrySummary` |
| `worker/src/lib/zoom.js` | `ZOOM_RECORDING_EVENT` |
| `worker/src/lib/bank-feed.js` | `BANK_ACCESS_WRAPPING_KEY_SECRET` |
| `worker/src/lib/fin-import.js` | `prepareBankExportImport` |

Plus the integration surface, which no test names because it is wiring:

- CLI commands absent from the release dispatcher: `connectors`, `reconcile`
- Worker routes absent: `/api/admin/brain/reliability-alerts`,
  `/api/admin/brain/vector-retry`, `/api/support/`, `/api/webhooks/plaid`

## One test that should NOT be made to pass

`test/cloudflare-oauth-session.test.mjs` wants
`cloudflareOAuthInstallIdentity` from `brain.mjs`. That is the field line's
account-first Cloudflare OAuth installer, and the decision on this port is to
keep the release's browser sign-in instead: it is the ceremony a client was
asked to perform and the one the owner asked to be rid of.

So this test fails for a reason, not from an omission. Drop the test with that
reason recorded, do not port the feature to satisfy it, and do not delete it
quietly. Every other failing test is a real gap.

## Order of work

1. The four worker libs first. They are small and additive, and each one has a
   ported test that goes green the moment its export exists.
2. `store-d1.js` next: 352 added lines against 124 removed, and the removals
   are where the 0.3.x bootstrap and drain work lives. Merge, do not overwrite.
3. `brain.mjs` last and slowest: 4,026 added against 623 removed. Everything
   the release line gained since 0.2.3 lives in those 623.
4. Then the wiring: two commands, four routes.
5. Then the schema-32 rehearsal leg, which is the acceptance for the whole
   port and is already built and waiting.

## The rule this port is held to

A file copy can silently drop any change that lives inside a shared file and
has no test. That is why the field's own tests came across: they are the only
thing that refuses to let it happen quietly. **A ported test that cannot pass
gets a written reason, not a deletion.**
