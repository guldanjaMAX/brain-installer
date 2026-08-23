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

Run or resume a lane:

```bash
node migration/supabase-import.mjs --lane curated --state .brain-migration-curated.json
node migration/supabase-import.mjs --lane messages --state .brain-migration-messages.json
node migration/supabase-import.mjs --lane drive --page-size 10 --state .brain-migration-drive.json
```

The state file is written after every accepted batch. It records the fixed
source high-water mark, cursor, receipts, counts, refusals, and failures. It
never stores either credential. A failed page does not advance, so rerunning
retries only the failed documents while skipping accepted receipts.

Do not use `--continue-on-error` for a cutover candidate unless the failure list
has been reviewed and accepted as the explicit data-agreement exception log.
