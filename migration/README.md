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

The state file is written after every accepted batch. It records the fixed
source high-water mark, cursor, receipts, counts, refusals, failures, and the
resolved Drive policy. Exact duplicate ids are resolved once and reused on
resume, so a changing source cannot silently change the rules mid-run. It
never stores either credential. A failed page does not advance, so rerunning
retries only the failed documents while skipping accepted receipts.

Do not use `--continue-on-error` for a cutover candidate unless the failure list
has been reviewed and accepted as the explicit data-agreement exception log.
