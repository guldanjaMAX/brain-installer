# ADR 002: Accelerate exact legacy projection bootstrap only behind the paused barrier

- Status: Accepted
- Date: 2026-08-25
- Owners: Product and engineering
- Confidence: High in crash safety and exact readback; medium in field throughput until a large live corpus completes
- Supersedes: None

## Problem

Schema 12 made asynchronous Vectorize acceptance honest by re-embedding,
upserting, and reading back every legacy vector generation. Its active-safe
bootstrap serialized 99-row mutations. A large field run measured only about
120 to 180 confirmed vectors per minute, so the exact upgrade would take days.

Comparing D1 and Vectorize identifiers is faster but not equivalent. A stable
identifier can still point to stale values or stale filter metadata. Count or
identifier parity therefore cannot become a projection receipt.

## Decision

Keep the conservative active drain and reindex protocol unchanged. During a
verified lifecycle update only, retain the complete corpus-write barrier after
migration and use durable 1,000-row bootstrap batches. A bounded number of
disjoint batches may be submitted before earlier batches become visible.

Every batch stores its epoch, range, row count, provider mutation receipt, and
confirmation state in D1. Each vector carries the selected D1 generation.
`getByIds` must read back that exact generation for every row before a
compare-and-swap can clear the batch and outbox receipts. Active mode cannot be
deployed until the high-water is complete, every batch is confirmed, the outbox
is empty, and exact provider count and fence checks pass.

## Consequences

- Large upgrades can use Vectorize and Workers AI capacity without weakening
  the exact-generation contract.
- Interruption is resumable from D1 and cannot depend on a local progress file.
- The faster path is unavailable to ordinary cron, manual drain, ingest,
  forget, or active reindex, where overlapping identities and deletes require
  the stricter serialized writer protocol.
- The lifecycle update may remain paused for hours on a very large corpus.
  Retrieval stays available, but source and corpus writes are intentionally
  refused until verification completes.
- Re-embedding a legacy corpus consumes Workers AI usage. The updater reports
  progress and retains a bounded safety limit rather than running forever.

## Verification

- Deterministic migration, store, route, lease, malformed-receipt, crash-resume,
  and update-order tests.
- Full offline suite, package privacy inspection, and six-job CI matrix.
- Disposable real-account recovery drill on the exact release candidate.
- Large-corpus field run showing monotonic durable progress, exact final
  generation readback, zero pending batches or outbox rows, and passing health,
  acceptance, and private release evaluation.

## Revisit when

Revisit if Cloudflare publishes a stronger bulk mutation transaction or
content-addressed projection receipt that can prove current values and metadata
without re-embedding unchanged rows.
