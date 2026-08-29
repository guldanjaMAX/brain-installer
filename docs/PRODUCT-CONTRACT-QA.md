# Product contract QA

This report defines the independent acceptance gate for the owner workspace and
exact-document security work. It starts from accepted baseline
`11e436368f698b673880586143bcc471e01b26fc` and contains tests and test support
only. It does not contain product implementation.

## Proof boundary

The new tests use the real Worker modules, all target D1 migrations, and an
in-memory SQLite database behind a D1-shaped adapter. This proves SQL behavior,
route contracts, transaction boundaries, restart behavior, and fail-closed
states locally. It does not prove Cloudflare D1, Vectorize, a real passkey,
customer data, or a deployed domain. No credential, live account, customer
record, deployment, or external resource is used.

The accepted baseline is expected to be red for these tests. A red baseline is
the acceptance signal that the product work has not been integrated, not a
reason to weaken the tests.

## Acceptance coverage

| Contract | Automated evidence | Required result |
| --- | --- | --- |
| Restart-safe 0019 and 0020 | `product-migration-contract.test.mjs` | The production `runRestartSafeMigrationStatements` runner resumes after every statement, skips only a compatible existing column, refuses an incompatible column, and all non-ALTER statements replay safely. |
| Append-only human evidence | `product-migration-contract.test.mjs` | SQLite triggers refuse UPDATE and DELETE for owner activity and approvals. |
| Owner authentication | `owner-actions-contract.test.mjs` | Positive owner session plus `X-Brain-App: 1` is required. Admin key fallback and missing companion header are refused. Private responses are no-store. |
| Owner upload | `owner-actions-contract.test.mjs` | Only the frozen text formats are accepted. `document_id` is stable document identity; source identity is server-owned. Size, media, scope, and credential refusals mutate nothing. |
| Common ingestion | `owner-actions-contract.test.mjs` | Successful upload uses the real common ingest path, persists authoritative `documents.entity_slug`, keeps provenance/client metadata, creates chunks, and leaves a retryable vector outbox entry. |
| Lost-response retry | `owner-actions-contract.test.mjs` | A synthetic crash after common ingest returns 503, then the same `request_id` returns HTTP 200 with `replayed:true`, one document mutation, and one human activity event. Approval and period-close writes have the same one-mutation/one-event replay gate. |
| Partial ingest | `owner-actions-contract.test.mjs` | A failed document write creates no document, chunk, or activity event. The durable request intent resumes safely with the same id. |
| Deletion safety | `owner-actions-contract.test.mjs` | Existing operator-only source inventory and forget routes preview first, require explicit confirmation, remove D1 visibility first, and retain vector cleanup in the durable outbox when Vectorize is unavailable. This slice adds no owner deletion route. |
| Approval safety | `owner-actions-contract.test.mjs` | Both reconciliation claims survive, `ruling_consumed` remains false, approvals append, exception resolution does not rewrite the source transaction, and entity mismatch is refused. |
| Period close | `owner-actions-contract.test.mjs` | Healthy empty, incomplete, owner-acknowledged incomplete, reopen, unavailable evidence, and replay are distinct. Unavailable evidence writes nothing. |
| Activity, targets, preferences | `owner-actions-contract.test.mjs` | Healthy empty differs from unavailable. Targets preserve archived rows and safe-integer money. Preferences enforce typed scope. Exact replays do not duplicate activity. |
| Entity-scoped Explore | `business-scope-contract.test.mjs` | Invalid, missing, counterparty, unavailable, and conflicting scopes do not reach search. Exact D1 scope is `documents.entity_slug`. |
| Legacy client mismatch | `business-scope-contract.test.mjs` | `fin_documents.corpus_doc_uid` mapped to entity A remains retrievable when legacy `documents.client` is null or different. D1 must not intersect the authoritative scope with `c.client`; semantic scope remains explicitly vector-degraded until reprojected. |
| Exact-document grants | `security-contract.test.mjs` | New documents are owner-only by default. A grant contains at most 100 exact document ids, rejects cross-entity documents, and persists one idempotent grant/event/request. |
| Top-K crowd-out | `security-contract.test.mjs` | Higher-ranked unauthorized results cannot crowd out a lower-ranked authorized document. Scoped retrieval uses authoritative D1 prefiltering, skips unscoped Vectorize, and reports `scoped-vector` degradation. |
| Revocation and unavailable D1 | `security-contract.test.mjs` | Revocation is idempotent and auditable; the old scoped session fails closed. Unavailable grant authority returns 503 rather than empty results. |
| Passkey observability | `security-contract.test.mjs` | Status groups `rp_id`, ceremony, stage, outcome, reason, count, and `timing_ms` min/average/max while excluding ceremony and credential secrets. Unavailable telemetry is explicit. |
| Stale sources and failed drain | Existing `test/freshness.test.mjs` and `test/vector-delete-outbox.test.mjs`, plus upload/deletion assertions above | Stale, manual, never-synced, pending, failed, and confirmed states remain distinct. A failed vector operation stays retryable and never becomes a healthy complete state. |

## Expected baseline failures

Against exact `11e4363`:

- `product-migration-contract.test.mjs`: 0 passed, 1 failed, 1 skipped because
  migrations 0019 and 0020 are absent.
- `owner-actions-contract.test.mjs`: 0 passed, 7 failed because the owner
  routes, migration tables, durable upload finalizer, and stable error codes are
  absent.
- `business-scope-contract.test.mjs`: 0 passed, 2 failed because
  `documents.entity_slug` and authoritative request scope are absent.
- `security-contract.test.mjs`: 0 passed, 4 failed because authoritative
  `documents.entity_slug`, document grants, scoped sessions, and passkey timing
  tables/routes are absent.

These are acceptance failures. Syntax checks and the independent fixture helper
must still pass.

## Focused evidence before integration

- Backend worktree: owner actions 7/7 passed; entity scope 2/2 passed; 0019
  restart/append-only 2/2 passed.
- Security commit `b80ab337c1b0e321540941f9fd95f420b7595e6c`:
  repository document-access tests 4/4 passed; 0020 restart test passed after
  every statement boundary.
- QA branch: syntax checks passed; the package test-chain guard includes all
  100 tracked test files; freshness 25/25 and vector delete outbox 90/90 passed.
- Baseline common-ingestion tests: `ingestion-contract` 30/30,
  `d1-batch-ingest` passed, and `drive-removal-guard` passed.

This is focused local evidence only. It is not combined proof.

## Required integrated rerun

Set the target to the worktree containing both product commits, then run:

```sh
PRODUCT_CONTRACT_ROOT=/absolute/path/to/integrated-candidate \
node --no-warnings --test \
  worker/test/product-migration-contract.test.mjs \
  worker/test/owner-actions-contract.test.mjs \
  worker/test/business-scope-contract.test.mjs \
  worker/test/security-contract.test.mjs
```

After that focused command is green, integrate the QA commit into the candidate
and run the repository's complete local release runner. The full runner is the
gate that proves the hardcoded test chain includes every new `.test.mjs` file.

## Still outside proof

- Real Cloudflare D1 and Vectorize behavior
- Real passkey ceremony on the intended domain and device
- Customer or partner accounts and data
- Deployed UI behavior
- A future owner-facing corpus deletion workflow, which has no frozen contract
  in this slice
