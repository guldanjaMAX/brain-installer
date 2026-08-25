# ADR 001: Standardize new Brain installs on Cloudflare

- Status: Accepted
- Date: 2026-08-25
- Owners: Product and engineering
- Confidence: High for the shared architecture; medium for a legacy install's full-corpus parity until evaluation completes
- Supersedes: None

## Problem

A legacy Brain can use a bespoke Supabase-backed path. Requiring each new
customer to operate that separate database would increase cost, installation
steps, credential surface, and support variance. A migrated owner should not
remain on a special product fork.

## Options considered

1. Keep Supabase as the required database for every install. This preserves
   PostgreSQL joins and row-level security but keeps the higher-cost and
   separate operational path.
2. Use Cloudflare D1, Vectorize, and a Worker as the standard owned install.
   This unifies provisioning and upgrades but requires explicit lifecycle,
   evaluation, recovery, and authorization work in the installer.
3. Use a managed RAG product as the canonical store. This reduces some search
   operations but weakens control of the data model and migration path.

## Decision

New installs use a client-owned Cloudflare Worker, D1 database, and Vectorize
index. D1 is the canonical document, chunk, lifecycle, and keyword-search store.
Vectorize is a rebuildable semantic-search projection. The same release package,
manifest, migrations, tests, install flow, and update flow serve every owner.

Legacy Supabase targets remain temporary rollback sources while imports,
source reconciliation, vector convergence, retrieval evaluation, and verified
recovery are completed. Dual writing during migration is an instance operation,
not a second product architecture.

The executable retirement sequence is defined in the
[legacy Supabase exit gate](../LEGACY-SUPABASE-EXIT.md).

## Consequences

- Every owner gets the same install and update path.
- Client data and operational credentials remain in the client's account.
- Vector loss is recoverable from canonical D1 chunks.
- PostgreSQL row-level security and relational joins are not implicitly
  reproduced. Shared-user installs require enforceable authorization before
  retrieval; separate owner installs remain the safe boundary until it ships.
- Supabase cannot be retired or materially downsized from a specific install
  until that install passes its own corpus, retrieval, answer, citation,
  lifecycle, and restore gates.

## Verification

- Immutable installer release, CI, real-account field rehearsal, and signed
  checksums.
- Exact-version health, D1/FTS/Vectorize agreement, zero outbox backlog, and
  negative authentication tests.
- Private source reconciliation and reviewed evaluation slices for every
  critical corpus domain and source format.
- Canonical D1 export, clean restore, Vectorize rebuild, and the same evaluation
  pass after recovery.

## Revisit when

Replace or extend this decision only when the same private, versioned benchmark
shows a material quality, authorization, recovery, latency, or cost improvement
without weakening client ownership or making installs diverge.
