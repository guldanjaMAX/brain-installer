# Legacy Supabase exit gate

This runbook applies only to an existing Brain being migrated from Supabase.
New Financial Brain installs do not require Supabase.

Downgrading early can remove the only complete copy of a source, hide a failed
import, or eliminate the rollback path before retrieval quality is measured.
Cost reduction starts after parity, not before it.

## Required gates

1. **Frozen source scope**
   - Record the source high-water mark and eligible row or file count.
   - Account for every item as represented, intentionally skipped, refused, or
     failed. Unknown and silently omitted items block the exit.
2. **Cloudflare storage parity**
   - Confirm expected document families and canonical content hashes in D1.
   - Require zero orphan documents, zero missing chunks, zero critical diagnose
     findings, and zero unreviewed failures.
3. **Search convergence**
   - Drain the Vectorize outbox to zero and verify D1 chunk, FTS, and vector
     counts agree under the install's contract.
4. **Protected-domain evaluation**
   - Pass reviewed medical, legal, divorce, tax, credit, OCR, message,
     multi-document, temporal, entity, and unanswerable slices.
   - Infrastructure health alone does not satisfy this gate.
5. **Verified recovery**
   - Export D1, restore into a clean isolated target, rebuild Vectorize from D1,
     and pass the same health and evaluation gates there.
6. **Rollback observation**
   - Keep the legacy target read-only or dual-confirmed for an agreed observation
     period. Investigate every discrepancy before removing data.

## Cost-reduction sequence

After every gate passes and the owner explicitly approves the exact database
objects:

1. Capture provider-native and logical backups, checksums, retention date, and
   a restore test receipt.
2. Inventory non-Brain applications that still use the Supabase project. A
   project cannot be cancelled merely because the Brain migrated.
3. Remove only the approved legacy Brain schemas or tables. Never infer scope
   from a naming pattern.
4. Reclaim database disk according to Supabase's current process, then verify
   the reported disk size after maintenance. Deleting rows alone may not reduce
   billed disk immediately.
5. Right-size compute and disk one step at a time. Monitor storage, connections,
   CPU, memory, backups, and the remaining applications before another change.
6. Cancel the project only when no other application depends on it and the
   protected backup has passed a clean restore.

Supabase references:
[billing](https://supabase.com/docs/guides/platform/billing-on-supabase),
[database size](https://supabase.com/docs/guides/platform/database-size),
[disk usage and sizing](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size),
and [why disk may not shrink after deletion](https://supabase.com/docs/guides/troubleshooting/disk-size-not-shrinking-after-deleting-data-135390).

## Exit receipt

The final private receipt should contain only aggregate counts, hashes,
versions, timestamps, gate outcomes, backup locators, and explicit owner
approval. It must not copy document titles, paths, source IDs, query text,
answers, credentials, or raw provider responses.
