# Supabase corpus migration

This directory is temporary migration tooling. It is not a second product
backend. The source database is read-only and every target write uses the same
document ingest endpoint as Drive, Gmail, and folder connectors.

Required runtime variables:

```bash
export SUPABASE_ACCESS_TOKEN='...'
export SUPABASE_PROJECT_REF='...'
export BRAIN_URL='https://isolated-target.example.com'
export ADMIN_KEY='...'
```

Dry-run one source page without touching Cloudflare:

```bash
node migration/supabase-import.mjs --lane curated --dry-run --max-pages 1
```

For Drive, copy `drive-policy.example.json` to a local ignored file and list
only exact file ids whose extracted text has been reviewed and rejected. Setting
`dedupe_exact_content` keeps one canonical Drive path for byte-identical
extractions. It does not merge similar documents or remove the source files.

```bash
node migration/supabase-import.mjs --lane drive --dry-run --max-pages 1 \
  --drive-policy .brain-migration-drive-policy.json
```

Run or resume a lane:

```bash
node migration/supabase-import.mjs --lane curated --state .brain-migration-curated.json
node migration/supabase-import.mjs --lane messages --state .brain-migration-messages.json
node migration/supabase-import.mjs --lane drive --page-size 10 \
  --drive-policy .brain-migration-drive-policy.json \
  --state .brain-migration-drive.json
```

For the normalized messaging schema, pin the human-readable owner label and
the IANA timezone used to decide conversation day boundaries. They are saved
in the checkpoint fingerprint and cannot change during a resume:

```bash
node migration/supabase-message-sessions.mjs \
  --owner-label "Brain owner" \
  --timezone "America/Denver" \
  --state .brain-migration-message-sessions.json
```

New message migrations require both values. A version-one checkpoint keeps its
historical owner label and UTC grouping behavior. Changing either value after
the lane starts requires a deliberate reset and reconciliation.

The state file is written after every accepted batch. It records the fixed
source high-water mark, cursor, receipts, counts, refusals, failures, and the
resolved Drive policy. Message migration freezes the eligible row count with
the high-water mark, classifies every row, and must balance its final source
and target accounting before it can post a completion receipt. Exact duplicate
ids are resolved once and reused on resume, so a changing source cannot
silently change the rules mid-run. It never stores either credential. A failed
page does not advance, so rerunning retries idempotently.

Checkpoint files and their `.previous.json` recovery copies are owner-only.
The migration refuses symbolic links, hard links, broadly writable parent
directories, broad file modes, corrupt current JSON, and oversized state. Each
replacement is synced and read back exactly before progress is acknowledged.
Source and target HTTP calls refuse redirects, cap response sizes, and require
target receipts to echo the exact source identity for every slot.

Message data can finish in D1 before its derived vectors finish draining. The
migration records its source-ready receipt only after a read-only target
inventory proves that accepted documents are visible and the Vectorize outbox
is empty. If vector work remains, run `brain drain <manifest>` and rerun the
migration command. The checkpoint is already complete, so the rerun performs
readback and receipt work without importing the source rows again.

Do not use `--continue-on-error` for a cutover candidate unless the failure list
has been reviewed and accepted as the explicit data-agreement exception log.
